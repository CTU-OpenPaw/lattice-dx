/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const crypto = require('crypto');
const { SYSTEM_PROTECTED_COLLECTIONS } = require('./solution-bundle');
const {
  CUSTOM_COLLECTION_RE,
  RULE_KEY_RE,
  ALLOWLISTED_BUSINESS_COLLECTIONS,
} = require('./automation-engine');
const {
  ORG_ID_RE,
  assertPatScope,
  clampPageLimit,
  fail,
  isOrgAdmin,
  loadFoundationModule,
  loadFoundationSet,
  readParams,
  resolveTenantActor,
  resolveVerifiedRoles,
  toPlain,
  val,
} = require('./wms-dmn-shared');

const FIELD_NAME_RE = /^[a-z][a-zA-Z0-9_]{0,62}$/;
const ROLE_NAME_RE = /^ldx_[a-z0-9_]{2,40}$/;
const PORTAL_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,48}$/;
const BLOCKED_FIELD_NAMES = new Set(['__proto__', 'constructor', 'prototype', 'id', 'createdAt', 'updatedAt']);
const ALLOWED_FIELD_TYPES = new Set([
  'string',
  'text',
  'integer',
  'float',
  'boolean',
  'date',
  'datetime',
  'json',
  'belongsTo',
]);
const ADMIN_ROLES = new Set(['ldx_admin', 'root', 'admin']);
const DEFAULT_DOMAIN_ROLES = ['ldx_admin', 'ldx_manager', 'ldx_operator', 'ldx_employee'];
const DEFAULT_ROLE_ACTIONS = Object.freeze({
  ldx_admin: ['view', 'list', 'get', 'create', 'update', 'destroy'],
  ldx_manager: ['view', 'list', 'get', 'create', 'update'],
  ldx_operator: ['view', 'list', 'get', 'create', 'update'],
  ldx_employee: ['view', 'list', 'get', 'create'],
});

const BUSINESS_PACK_CATALOG = Object.freeze([
  {
    packKey: 'cmms-maintenance',
    name: 'CMMS Cold-Chain Maintenance',
    description: 'Equipment work orders, DMN priority routing, cold-chain alarm automation, and /p/cmms portal workspace.',
    version: '1.0.0',
    components: {
      collection: 'latticeCustomWorkOrders',
      dmnTableKey: 'cmms_priority_routing_v1',
      automationRuleKey: 'auto_cmms_on_coldchain_fault',
      portalSlug: 'cmms',
    },
  },
]);

function buildSafePgIndexName(collectionName, suffix = 'org') {
  const cleanCol = String(collectionName || '').replace(/[^A-Za-z0-9_]/g, '');
  const candidate = `idx_${cleanCol}_${suffix}`;
  if (candidate.length <= 63) return candidate;
  const hash = crypto.createHash('sha256').update(cleanCol).digest('hex').slice(0, 8);
  const maxPrefix = 63 - 5 - hash.length - suffix.length;
  return `idx_${cleanCol.slice(0, Math.max(8, maxPrefix))}_${hash}_${suffix}`;
}

function buildStableUid(prefix, seed) {
  const hash = crypto.createHash('sha256').update(String(seed)).digest('hex').slice(0, 12);
  return `${prefix}-${hash}`;
}

function mapFieldSpecToNocoBase(field) {
  const type = String(field.type || 'string');
  const name = String(field.name || '').trim();
  const title = String(field.title || name).trim();
  const required = Boolean(field.required);
  const allowNull = !required;

  const base = {
    name,
    type,
    allowNull,
    interface: 'input',
    uiSchema: {
      title,
      type: 'string',
      'x-component': 'Input',
    },
  };

  if (type === 'text') {
    base.interface = 'textarea';
    base.uiSchema['x-component'] = 'Input.TextArea';
  } else if (type === 'integer') {
    base.interface = 'integer';
    base.uiSchema.type = 'number';
    base.uiSchema['x-component'] = 'InputNumber';
  } else if (type === 'float') {
    base.interface = 'number';
    base.uiSchema.type = 'number';
    base.uiSchema['x-component'] = 'InputNumber';
  } else if (type === 'boolean') {
    base.interface = 'checkbox';
    base.uiSchema.type = 'boolean';
    base.uiSchema['x-component'] = 'Checkbox';
  } else if (type === 'date') {
    base.interface = 'date';
    base.uiSchema['x-component'] = 'DatePicker';
  } else if (type === 'datetime') {
    base.interface = 'datetime';
    base.uiSchema['x-component'] = 'DatePicker';
    base.uiSchema['x-component-props'] = { showTime: true };
  } else if (type === 'json') {
    base.type = 'jsonb';
    base.interface = 'json';
    base.uiSchema.type = 'object';
    base.uiSchema['x-component'] = 'Input.JSON';
  } else if (type === 'belongsTo') {
    base.interface = 'obo';
    base.target = String(field.target || '').trim();
    base.foreignKey = String(field.foreignKey || `${name}Id`).trim();
    base.uiSchema.type = 'object';
    base.uiSchema['x-component'] = 'AssociationField';
  } else if (Array.isArray(field.enumValues) && field.enumValues.length > 0) {
    base.interface = 'select';
    base.uiSchema.enum = field.enumValues.map((v) => ({ value: String(v), label: String(v) }));
    base.uiSchema['x-component'] = 'Select';
  }

  if (field.indexed) {
    base.index = true;
  }
  return base;
}

function sanitizeFields(rawFields) {
  if (!Array.isArray(rawFields) || rawFields.length === 0) {
    throw fail('INVALID_FIELDS', 400, 'fields must be a non-empty array');
  }
  const seen = new Set();
  const sanitized = [];
  for (let i = 0; i < rawFields.length; i += 1) {
    const f = rawFields[i];
    if (!f || typeof f !== 'object' || Array.isArray(f)) {
      throw fail('INVALID_FIELD', 400, `fields[${i}] must be an object`);
    }
    const name = String(f.name || '').trim();
    if (!FIELD_NAME_RE.test(name) || BLOCKED_FIELD_NAMES.has(name)) {
      throw fail('INVALID_FIELD_NAME', 400, `Invalid field name "${name || '(empty)'}" at fields[${i}]`);
    }
    if (name === 'organizationId') continue;
    if (seen.has(name)) {
      throw fail('DUPLICATE_FIELD_NAME', 400, `Duplicate field name "${name}"`);
    }
    seen.add(name);
    const type = String(f.type || 'string').trim();
    if (!ALLOWED_FIELD_TYPES.has(type)) {
      throw fail('INVALID_FIELD_TYPE', 400, `Unsupported field type "${type}" on field "${name}"`);
    }
    let target = null;
    let foreignKey = null;
    if (type === 'belongsTo') {
      target = String(f.target || '').trim();
      const targetAllowed = CUSTOM_COLLECTION_RE.test(target) || ALLOWLISTED_BUSINESS_COLLECTIONS.has(target);
      if (!target || SYSTEM_PROTECTED_COLLECTIONS.has(target) || !targetAllowed) {
        throw fail('INVALID_BELONGS_TO_TARGET', 400, `Disallowed belongsTo target "${target || '(empty)'}" on field "${name}"`);
      }
      if (f.foreignKey !== undefined && f.foreignKey !== null) {
        if (typeof f.foreignKey !== 'string') {
          throw fail('INVALID_FOREIGN_KEY', 400, `Invalid foreignKey on field "${name}"`);
        }
        foreignKey = f.foreignKey.trim();
      } else {
        foreignKey = `${name}Id`;
      }
      if (!FIELD_NAME_RE.test(foreignKey) || BLOCKED_FIELD_NAMES.has(foreignKey) || foreignKey === 'organizationId') {
        throw fail('INVALID_FOREIGN_KEY', 400, `Invalid foreignKey "${foreignKey || '(empty)'}" on field "${name}"`);
      }
    }
    const enumValues = Array.isArray(f.enumValues)
      ? f.enumValues.map((v) => String(v).trim()).filter(Boolean).slice(0, 50)
      : undefined;

    sanitized.push({
      name,
      type,
      title: f.title ? String(f.title).trim() : name,
      required: Boolean(f.required),
      indexed: Boolean(f.indexed),
      ...(enumValues && enumValues.length > 0 ? { enumValues } : {}),
      ...(target ? { target, foreignKey } : {}),
    });
  }
  return sanitized;
}

async function upsertRepoRow(repo, filter, values) {
  if (!repo) return null;
  const existing = typeof repo.findOne === 'function' ? await repo.findOne({ filter }) : null;
  if (existing) {
    if (typeof repo.update === 'function') {
      const existingId = val(existing, 'id');
      await repo.update({
        ...(existingId != null ? { filterByTk: existingId } : {}),
        filter,
        values,
      });
    }
    return (typeof repo.findOne === 'function' ? await repo.findOne({ filter }) : null) || existing;
  }
  if (typeof repo.create === 'function') {
    return repo.create({ values });
  }
  return null;
}

async function attachAndVerifyPgRls(db, collectionName, opts = {}) {
  let attached = false;
  if (typeof db?.attachLatticeRlsPolicy === 'function') {
    await db.attachLatticeRlsPolicy(collectionName);
    attached = true;
  } else {
    const pgRls = opts.pgRls !== undefined ? opts.pgRls : loadFoundationModule('pg-rls');
    if (pgRls && typeof pgRls.attachRlsPolicyToTable === 'function') {
      await pgRls.attachRlsPolicyToTable(db, collectionName);
      attached = true;
    } else if (db?.sequelize && typeof db.sequelize.query === 'function') {
      const dialect = typeof db.sequelize.getDialect === 'function' ? db.sequelize.getDialect() : 'postgres';
      if (dialect === 'postgres') {
        const safeTable = String(collectionName).replace(/[^A-Za-z0-9_]/g, '');
        if (!safeTable) {
          throw fail('INVALID_COLLECTION_NAME', 400, 'Invalid collectionName for RLS policy');
        }
        const predicate = [
          "current_setting('app.current_org', true) IS NULL",
          "current_setting('app.current_org', true) = ''",
          "current_setting('app.current_org', true) = '*'",
          '"organizationId" = current_setting(\'app.current_org\', true)',
        ].join(' OR ');
        await db.sequelize.query(`ALTER TABLE "${safeTable}" ENABLE ROW LEVEL SECURITY`);
        await db.sequelize.query(`DROP POLICY IF EXISTS "lattice_tenant_isolation" ON "${safeTable}"`);
        await db.sequelize.query(
          `CREATE POLICY "lattice_tenant_isolation" ON "${safeTable}" AS PERMISSIVE FOR ALL TO PUBLIC USING (${predicate}) WITH CHECK (${predicate})`,
        );
        attached = true;
      }
    }
  }

  let verified = attached;
  const dialect = typeof db?.sequelize?.getDialect === 'function' ? db.sequelize.getDialect() : null;
  if (dialect === 'postgres' && typeof db?.sequelize?.query === 'function') {
    const res = await db.sequelize.query(
      'SELECT c.relrowsecurity AS rls_enabled FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = current_schema() AND c.relname = :tableName LIMIT 1',
      { replacements: { tableName: collectionName } },
    );
    const rows = Array.isArray(res) && Array.isArray(res[0]) ? res[0] : Array.isArray(res) ? res : [];
    if (rows.length > 0) {
      const row = rows[0];
      if (row && row.rls_enabled === false) {
        throw fail('PG_RLS_VERIFICATION_FAILED', 500, `PostgreSQL RLS could not be verified on ${collectionName}`);
      }
      if (row && row.rls_enabled === true) {
        verified = true;
      }
    }
  }

  if (dialect === 'postgres' && !verified) {
    throw fail('PG_RLS_NOT_ATTACHED', 500, `Unable to attach tenant RLS policy on ${collectionName}`);
  }
  return { attached, verified };
}

function buildActionFieldsList(fields) {
  const baseCols = ['id', 'createdAt', 'updatedAt', 'organizationId'];
  const extraCols = (Array.isArray(fields) ? fields : [])
    .map((f) => (f?.type === 'belongsTo' ? String(f.foreignKey || `${f.name}Id`).trim() : String(f?.name || '').trim()))
    .filter(Boolean);
  return [...new Set([...baseCols, ...extraCols])];
}

function createBuilderApplyBlueprint(ctx) {
  const flowSurfaces = ctx?.app?.resourceManager?.getResource?.('flowSurfaces');
  const handler = flowSurfaces?.actions?.get?.('applyBlueprint')?.handler || flowSurfaces?.actions?.applyBlueprint;
  if (typeof handler !== 'function') return null;
  return async (doc) => {
    const subCtx = {
      app: ctx.app,
      db: ctx.db,
      state: {
        currentUser: ctx.state?.currentUser,
        currentRole: ctx.state?.currentRole,
        currentRoles: ctx.state?.currentRoles || [ctx.state?.currentRole || 'root'],
      },
      getCurrentLocale: ctx.getCurrentLocale?.bind(ctx),
      i18n: ctx.i18n,
      action: { actionName: 'applyBlueprint', params: { values: doc } },
      request: { headers: {} },
      body: null,
      throw: (s, m) => {
        throw fail('BLUEPRINT_ERROR', s, m);
      },
    };
    await handler(subCtx, async () => {});
    if ((subCtx.status && subCtx.status >= 400) || (Array.isArray(subCtx.body?.errors) && subCtx.body.errors.length)) {
      const msg = subCtx.body?.errors?.[0]?.message || `flowSurfaces:applyBlueprint failed (${subCtx.status || 400})`;
      throw fail('BLUEPRINT_ERROR', subCtx.status || 400, msg);
    }
    return subCtx.body?.data || subCtx.body || {};
  };
}

async function resolveExistingRolesSet(db) {
  const rolesRepo = db.getRepository?.('roles');
  if (!rolesRepo || typeof rolesRepo.count !== 'function' || typeof rolesRepo.find !== 'function') return null;
  const total = await rolesRepo.count({});
  if (!total) return null;
  const rows = (await rolesRepo.find({ limit: 500 })) || [];
  return new Set(rows.map((r) => String(val(r, 'name') || '').trim()).filter(Boolean));
}

async function grantDomainRbac(db, collectionName, roleNames, fields = [], ctx = null) {
  const requestedRoles = (Array.isArray(roleNames) && roleNames.length ? roleNames : DEFAULT_DOMAIN_ROLES)
    .map((r) => String(r || '').trim())
    .filter((r) => ROLE_NAME_RE.test(r));
  const existingRoles = await resolveExistingRolesSet(db);
  const rolesToGrant = existingRoles ? requestedRoles.filter((r) => existingRoles.has(r)) : requestedRoles;

  const dsRolesRepo = db.getRepository?.('dataSourcesRoles');
  const dsResourcesRepo = db.getRepository?.('dataSourcesRolesResources');
  const dsActionsRepo = db.getRepository?.('dataSourcesRolesResourcesActions');
  const legacyResRepo = db.getRepository?.('rolesResources');
  const viewFields = buildActionFieldsList(fields);
  const writeFields = viewFields.filter((f) => f !== 'id' && f !== 'createdAt' && f !== 'updatedAt');
  const grantedRoles = [];

  for (const roleName of rolesToGrant) {
    if (dsRolesRepo) {
      await upsertRepoRow(
        dsRolesRepo,
        { roleName, dataSourceKey: 'main' },
        { roleName, dataSourceKey: 'main' },
      );
    }
    let resRow = null;
    if (dsResourcesRepo) {
      resRow = await upsertRepoRow(
        dsResourcesRepo,
        { roleName, dataSourceKey: 'main', name: collectionName },
        {
          roleName,
          dataSourceKey: 'main',
          name: collectionName,
          usingActionsConfig: true,
        },
      );
    } else if (legacyResRepo) {
      resRow = await upsertRepoRow(
        legacyResRepo,
        { roleName, name: collectionName },
        { roleName, name: collectionName, usingActionsConfig: true },
      );
    }
    const rolesResourceId = val(resRow, 'id') ?? null;
    if (dsActionsRepo && rolesResourceId != null) {
      const actions = DEFAULT_ROLE_ACTIONS[roleName] || ['view', 'list', 'get'];
      for (const actionName of actions) {
        const actionFields = ['create', 'update'].includes(actionName) ? writeFields : viewFields;
        await upsertRepoRow(
          dsActionsRepo,
          { rolesResourceId, name: actionName },
          {
            rolesResourceId,
            name: actionName,
            ...(actionFields.length ? { fields: actionFields } : {}),
          },
        );
      }
    }
    grantedRoles.push(roleName);
  }
  if (typeof ctx?.app?.acl?.writeRolesToACL === 'function') {
    try {
      await ctx.app.acl.writeRolesToACL();
    } catch {
      // Non-fatal: DB ACL rows already persisted
    }
  }
  return grantedRoles;
}

async function upsertFlowModel(flowModelsRepo, spec) {
  if (!flowModelsRepo) return null;
  if (typeof flowModelsRepo.upsertModel === 'function') {
    await flowModelsRepo.upsertModel(spec);
    return typeof flowModelsRepo.findOne === 'function'
      ? (await flowModelsRepo.findOne({ filter: { uid: spec.uid } })) || spec
      : spec;
  }
  return upsertRepoRow(flowModelsRepo, { uid: spec.uid }, spec);
}

async function upsertPortalPageForDomain(db, { slug, title, collectionName, roleNames, fields = [], applyBlueprint = null }) {
  const cleanSlug = String(slug || '').trim().toLowerCase().replace(/^\/+p\//, '');
  if (!PORTAL_SLUG_RE.test(cleanSlug)) {
    throw fail('INVALID_PORTAL_SLUG', 400, `portalSlug must match ${PORTAL_SLUG_RE.source}`);
  }
  const routePath = `/p/${cleanSlug}`;
  const layoutUid = `ldx-portal-${cleanSlug}`;
  const routeName = `p_${cleanSlug.replace(/-/g, '_')}`;
  const portalTitle = title || cleanSlug;

  const uiLayoutsRepo = db.getRepository?.('uiLayouts');
  const desktopRoutesRepo = db.getRepository?.('desktopRoutes');
  const linksRepo = db.getRepository?.('desktopRoutesUiLayouts');
  const rolesRoutesRepo = db.getRepository?.('rolesDesktopRoutes');
  const flowModelsRepo = db.getRepository?.('flowModels');

  const schemaUid = buildStableUid('dxos-page', cleanSlug);
  const tabSchemaUid = buildStableUid('dxos-tab', cleanSlug);
  const gridUid = buildStableUid('dxos-grid', cleanSlug);
  const blockUid = buildStableUid('dxos-tbl', `${cleanSlug}-${collectionName}`);

  if (uiLayoutsRepo) {
    await upsertRepoRow(
      uiLayoutsRepo,
      { uid: layoutUid },
      {
        uid: layoutUid,
        title: portalTitle,
        layoutType: 'desktop',
        routeName,
        routePath,
        authCheck: true,
        enabled: true,
      },
    );
  }

  const requestedGrants = (Array.isArray(roleNames) && roleNames.length ? roleNames : DEFAULT_DOMAIN_ROLES).filter((r) =>
    ROLE_NAME_RE.test(String(r)),
  );
  const existingRoles = await resolveExistingRolesSet(db);
  const grants = existingRoles ? requestedGrants.filter((r) => existingRoles.has(r)) : requestedGrants;

  const linkAndGrantRoutes = async (routeIds) => {
    for (const rid of routeIds.filter((id) => id != null)) {
      if (linksRepo) {
        await upsertRepoRow(
          linksRepo,
          { uiLayoutUid: layoutUid, desktopRouteId: rid },
          { uiLayoutUid: layoutUid, desktopRouteId: rid },
        );
      }
      if (rolesRoutesRepo) {
        for (const roleName of grants) {
          await upsertRepoRow(
            rolesRoutesRepo,
            { roleName, desktopRouteId: rid },
            { roleName, desktopRouteId: rid },
          );
        }
      }
    }
  };

  if (typeof applyBlueprint === 'function') {
    const links = linksRepo && typeof linksRepo.find === 'function'
      ? (await linksRepo.find({ filter: { uiLayoutUid: layoutUid }, limit: 200 })) || []
      : [];
    const linkedRouteIds = new Set(links.map((l) => String(val(l, 'desktopRouteId'))).filter(Boolean));
    const allRoutes = desktopRoutesRepo && typeof desktopRoutesRepo.find === 'function'
      ? (await desktopRoutesRepo.find({ limit: 500 })) || []
      : [];
    const layoutRoutes = allRoutes.filter((r) => linkedRouteIds.has(String(val(r, 'id'))));
    let pageRoute = layoutRoutes.find(
      (r) => ['flowPage', 'page'].includes(val(r, 'type'))
        && (val(r, 'options')?.collectionName === collectionName || val(r, 'title') === portalTitle),
    ) || null;
    let tabSchemaOut = null;

    if (!pageRoute) {
      const visibleFields = (Array.isArray(fields) ? fields : [])
        .filter((f) => f && f.name && f.type !== 'json' && f.type !== 'belongsTo')
        .map((f) => f.name)
        .slice(0, 6);
      if (!visibleFields.length) visibleFields.push('organizationId');

      const bpRes = await applyBlueprint({
        version: '1',
        mode: 'create',
        navigation: { layoutUid, item: { title: portalTitle, icon: 'TableOutlined' } },
        page: { title: portalTitle, displayTitle: true, enableTabs: false },
        tabs: [{
          title: portalTitle,
          blocks: [{
            key: `${cleanSlug}-${collectionName}`,
            type: 'table',
            title: portalTitle,
            collection: collectionName,
            fields: visibleFields,
            settings: { pageSize: 10 },
            actions: ['filter', 'refresh'],
          }],
        }],
      });
      tabSchemaOut = bpRes?.target?.tabSchemaUid || null;

      const updatedRoutes = desktopRoutesRepo && typeof desktopRoutesRepo.find === 'function'
        ? (await desktopRoutesRepo.find({ limit: 500 })) || []
        : [];
      const updatedLinks = linksRepo && typeof linksRepo.find === 'function'
        ? (await linksRepo.find({ filter: { uiLayoutUid: layoutUid }, limit: 200 })) || []
        : [];
      const updatedLinkedIds = new Set(updatedLinks.map((l) => String(val(l, 'desktopRouteId'))).filter(Boolean));
      const targetRouteId = bpRes?.target?.routeId;
      pageRoute = (targetRouteId != null ? updatedRoutes.find((r) => String(val(r, 'id')) === String(targetRouteId)) : null)
        || updatedRoutes.find((r) => updatedLinkedIds.has(String(val(r, 'id'))) && ['flowPage', 'page'].includes(val(r, 'type')) && val(r, 'title') === portalTitle)
        || null;
    }

    const pageId = val(pageRoute, 'id') ?? null;
    let tabRoute = null;
    if (pageId != null && desktopRoutesRepo) {
      const existingOpts = val(pageRoute, 'options') && typeof val(pageRoute, 'options') === 'object' ? val(pageRoute, 'options') : {};
      if (existingOpts.collectionName !== collectionName || existingOpts.path !== routePath) {
        await desktopRoutesRepo.update?.({
          filterByTk: pageId,
          values: { options: { ...existingOpts, path: routePath, collectionName } },
        });
      }
      tabRoute = typeof desktopRoutesRepo.findOne === 'function'
        ? await desktopRoutesRepo.findOne({ filter: { parentId: pageId, type: 'tabs' } })
        : null;
      await linkAndGrantRoutes([pageId, val(tabRoute, 'id')]);
    }

    return {
      path: routePath,
      layoutUid,
      schemaUid: val(pageRoute, 'schemaUid') || schemaUid,
      tabSchemaUid: val(tabRoute, 'schemaUid') || tabSchemaOut || tabSchemaUid,
      gridUid: null,
      blockUid: null,
      routeId: pageId,
    };
  }

  let pageRoute = null;
  let tabRoute = null;
  if (desktopRoutesRepo) {
    pageRoute = await upsertRepoRow(
      desktopRoutesRepo,
      { schemaUid },
      {
        type: 'flowPage',
        title: portalTitle,
        schemaUid,
        enableTabs: false,
        hideInMenu: false,
        hidden: false,
        displayTitle: true,
        options: {
          path: routePath,
          collectionName,
        },
      },
    );
    const pageId = val(pageRoute, 'id') ?? null;
    if (pageId != null) {
      tabRoute = await upsertRepoRow(
        desktopRoutesRepo,
        { parentId: pageId, schemaUid: tabSchemaUid },
        {
          parentId: pageId,
          type: 'tabs',
          title: portalTitle,
          schemaUid: tabSchemaUid,
          hideInMenu: true,
        },
      );
      await linkAndGrantRoutes([pageId, val(tabRoute, 'id')]);
    }
  }

  if (flowModelsRepo) {
    await upsertFlowModel(flowModelsRepo, {
      uid: schemaUid,
      use: 'PageModel',
      props: { title: portalTitle },
      stepParams: {
        pageSettings: {
          general: { title: portalTitle },
        },
      },
    });
    await upsertFlowModel(flowModelsRepo, {
      uid: tabSchemaUid,
      use: 'PageTabModel',
      parentId: schemaUid,
      subKey: 'tabs',
      subType: 'array',
      props: { title: portalTitle, routePath },
      stepParams: {},
    });

    const existingGrid = typeof flowModelsRepo.findOne === 'function'
      ? await flowModelsRepo.findOne({ filter: { uid: gridUid } })
      : null;
    const baseRows = existingGrid?.props?.rows && typeof existingGrid.props.rows === 'object'
      ? { ...existingGrid.props.rows }
      : {};
    const baseSizes = existingGrid?.props?.sizes && typeof existingGrid.props.sizes === 'object'
      ? { ...existingGrid.props.sizes }
      : {};
    const baseOrder = Array.isArray(existingGrid?.props?.rowOrder)
      ? [...existingGrid.props.rowOrder]
      : Object.keys(baseRows);
    const alreadyPlaced = Object.values(baseRows).flat(2).includes(blockUid);
    if (!alreadyPlaced) {
      let rowKey = 'row_1';
      let idx = 1;
      while (Object.hasOwn(baseRows, rowKey)) {
        idx += 1;
        rowKey = `row_${idx}`;
      }
      baseRows[rowKey] = [[blockUid]];
      baseSizes[rowKey] = [24];
      if (!baseOrder.includes(rowKey)) baseOrder.push(rowKey);
    }
    const gridLayout = { rows: baseRows, sizes: baseSizes, rowOrder: baseOrder };

    await upsertFlowModel(flowModelsRepo, {
      uid: gridUid,
      use: 'GridModel',
      parentId: tabSchemaUid,
      subKey: 'grid',
      subType: 'object',
      props: { ...gridLayout },
      stepParams: {
        gridSettings: {
          grid: { ...gridLayout },
        },
      },
    });
    await upsertFlowModel(flowModelsRepo, {
      uid: blockUid,
      use: 'TableBlockModel',
      parentId: gridUid,
      subKey: 'items',
      subType: 'array',
      props: {
        collectionName,
        dataSourceKey: 'main',
      },
      stepParams: {
        resourceSettings: {
          init: {
            dataSourceKey: 'main',
            collectionName,
          },
        },
      },
    });
  }

  return {
    path: routePath,
    layoutUid,
    schemaUid,
    tabSchemaUid,
    gridUid,
    blockUid,
    routeId: val(pageRoute, 'id') ?? null,
  };
}

async function createOrUpdateDomainCollection(db, params, opts = {}) {
  const collectionName = String(params.collectionName || '').trim();
  if (!CUSTOM_COLLECTION_RE.test(collectionName)) {
    throw fail('INVALID_COLLECTION_NAME', 400, `collectionName must match ${CUSTOM_COLLECTION_RE.source}`);
  }
  if (SYSTEM_PROTECTED_COLLECTIONS.has(collectionName)) {
    throw fail('SYSTEM_COLLECTION_FORBIDDEN', 400, `${collectionName} is a protected system table`);
  }

  const sanitizedFields = sanitizeFields(params.fields);
  const title = String(params.title || collectionName).trim();
  const description = params.description ? String(params.description).trim() : null;
  const fullFieldsSpec = [
    { name: 'organizationId', type: 'string', allowNull: false, index: true },
    ...sanitizedFields.map(mapFieldSpecToNocoBase),
  ];

  const collectionsRepo = db.getRepository?.('collections');
  const fieldsRepo = db.getRepository?.('fields');

  if (collectionsRepo) {
    await upsertRepoRow(
      collectionsRepo,
      { name: collectionName },
      {
        name: collectionName,
        title,
        description,
        createdAt: true,
        updatedAt: true,
        autoGenId: true,
        logging: true,
      },
    );
  }

  if (fieldsRepo) {
    for (const fSpec of fullFieldsSpec) {
      await upsertRepoRow(
        fieldsRepo,
        { collectionName, name: fSpec.name },
        {
          collectionName,
          ...fSpec,
        },
      );
    }
  }

  const indexName = buildSafePgIndexName(collectionName, 'org');
  const isPgWithQuery = Boolean(
    db?.sequelize
    && typeof db.sequelize.query === 'function'
    && (typeof db.sequelize.getDialect !== 'function' || db.sequelize.getDialect() === 'postgres'),
  );
  const expectedColumns = [
    'organizationId',
    ...sanitizedFields.map((f) => (f.type === 'belongsTo' ? String(f.foreignKey || `${f.name}Id`).trim() : f.name)),
  ];

  let rlsDroppedForAlter = false;
  if (typeof db.collection === 'function') {
    const registered = db.collection({
      name: collectionName,
      timestamps: true,
      createdAt: true,
      updatedAt: true,
      fields: fullFieldsSpec,
      indexes: [{ name: indexName, fields: ['organizationId'] }],
    });
    if (registered && typeof registered.sync === 'function') {
      let existingCols = new Set();
      if (isPgWithQuery) {
        const colRes = await db.sequelize.query(
          'SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = :tableName',
          { replacements: { tableName: collectionName } },
        ).catch(() => [[], []]);
        const colRows = Array.isArray(colRes) && Array.isArray(colRes[0]) ? colRes[0] : Array.isArray(colRes) ? colRes : [];
        existingCols = new Set(colRows.map((row) => String(row?.column_name || '').trim()).filter(Boolean));
      }

      if (existingCols.size === 0) {
        await registered.sync({ alter: true });
      } else if (expectedColumns.every((col) => existingCols.has(col))) {
        await registered.sync();
      } else {
        // Keep RLS enabled (fail-closed) and temporarily drop only the policy referencing organizationId during column DDL.
        await db.sequelize.query(`DROP POLICY IF EXISTS "lattice_tenant_isolation" ON "${collectionName}"`);
        rlsDroppedForAlter = true;
        try {
          await registered.sync({ alter: true });
        } finally {
          await attachAndVerifyPgRls(db, collectionName);
          rlsDroppedForAlter = false;
        }
      }
    }
  }
  if (typeof db.sync === 'function' && !rlsDroppedForAlter) {
    await db.sync();
  }

  if (isPgWithQuery) {
    await db.sequelize.query(
      `CREATE INDEX IF NOT EXISTS "${indexName}" ON "${collectionName}" ("organizationId")`,
    ).catch(() => {});
  }

  const rls = await attachAndVerifyPgRls(db, collectionName);
  const grantedRoles = await grantDomainRbac(db, collectionName, params.roles, sanitizedFields, opts.ctx || null);

  let portalPage = null;
  if (params.portalSlug) {
    portalPage = await upsertPortalPageForDomain(db, {
      slug: params.portalSlug,
      title: params.portalTitle || title,
      collectionName,
      roleNames: grantedRoles,
      fields: sanitizedFields,
      applyBlueprint: opts.applyBlueprint || createBuilderApplyBlueprint(opts.ctx),
    });
  }

  return {
    collectionName,
    title,
    fields: sanitizedFields,
    indexName,
    rls,
    grantedRoles,
    portalPage,
  };
}

async function generateOrEnsureOrgPkiKey(db, organizationId, env) {
  const effectiveEnv = env && typeof env === 'object' && env.env && typeof env.env === 'object'
    ? env.env
    : env || process.env;
  const rawSecret = String(
    effectiveEnv?.DX_VAULT_MASTER_KEY
      || effectiveEnv?.ENCRYPTION_FIELD_KEY
      || effectiveEnv?.NOCOBASE_APP_KEY
      || effectiveEnv?.APP_KEY
      || '',
  ).trim();
  const isProduction = String(effectiveEnv?.NODE_ENV || '').trim().toLowerCase() === 'production';

  if (isProduction && !rawSecret) {
    throw fail(
      'PKI_MASTER_KEY_MISSING',
      500,
      'DX_VAULT_MASTER_KEY, ENCRYPTION_FIELD_KEY, NOCOBASE_APP_KEY, or APP_KEY must be set in production.',
    );
  }

  const ledgerEnv = rawSecret && !effectiveEnv?.ENCRYPTION_FIELD_KEY && !effectiveEnv?.APP_KEY
    ? { ...effectiveEnv, ENCRYPTION_FIELD_KEY: rawSecret }
    : effectiveEnv;

  const pkiLedger = loadFoundationModule('pki-ledger');
  if (pkiLedger && typeof pkiLedger.ensureOrgSigningKey === 'function') {
    try {
      const res = await pkiLedger.ensureOrgSigningKey(db, organizationId, { env: ledgerEnv });
      if (res) return toPlain(res);
    } catch (err) {
      if (
        err?.code === 'PKI_MASTER_KEY_MISSING'
        || err?.code === 'PKI_KEY_INACTIVE'
        || err?.code === 'PKI_CIPHERTEXT_INVALID'
      ) {
        throw err;
      }
      // Fallback below if isolated unit test repository has custom shape
    }
  }

  const pkiRepo = db.getRepository?.('latticePkiKeys');
  if (!pkiRepo) return null;
  const existing = await pkiRepo.findOne({ filter: { organizationId, active: true } });
  if (existing) return toPlain(existing);

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  const fingerprintSha256 = crypto.createHash('sha256').update(spkiDer).digest('hex');
  const keyMaterial = rawSecret || 'lattice-dev-fallback-key';
  const aesKey = crypto.createHash('sha256').update(keyMaterial).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const encrypted = Buffer.concat([cipher.update(privateKeyPem, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const encryptedPrivateKey = `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
  const keyId = `ed25519-${fingerprintSha256.slice(0, 16)}`;

  const created = await pkiRepo.create({
    values: {
      organizationId,
      keyId,
      algorithm: 'Ed25519',
      publicKeyPem,
      encryptedPrivateKey,
      fingerprintSha256,
      active: true,
    },
  });
  return toPlain(created);
}

function assertBuilderPatScope(ctx, requiredScopes, foundation) {
  if (ctx?.state?.latticeApiKey) {
    return assertPatScope(ctx, requiredScopes, foundation);
  }
  const rawPatScopes = ctx?.state?.patScopes || ctx?.state?.currentUser?.patScopes || ctx?.state?.apiKey?.scopes;
  const isLegacyPat = ctx?.state?.authType === 'pat' || Boolean(ctx?.state?.apiKey) || rawPatScopes !== undefined;
  if (!isLegacyPat) return true;
  const heldList = Array.isArray(rawPatScopes)
    ? rawPatScopes
    : typeof rawPatScopes === 'string'
      ? rawPatScopes.split(',')
      : [];
  const held = new Set(heldList.map((s) => String(s).trim().toLowerCase()).filter(Boolean));
  const needed = Array.isArray(requiredScopes) ? requiredScopes : [requiredScopes];
  if (needed.some((s) => held.has(String(s).toLowerCase()))) return true;
  throw fail('API_KEY_SCOPE_INSUFFICIENT', 403, `API key lacks required scope (${needed.join(' or ')}).`);
}

function createDxosBuilderActions(db, options = {}) {
  const foundation = options.foundation || loadFoundationSet();

  async function requireBuilderAdmin(ctx, params, { requireOrg = true, rootOnly = false, patScopes = null } = {}) {
    const userId = val(ctx?.state?.currentUser, 'id');
    if (userId == null || !/^[1-9]\d*$/.test(String(userId))) {
      throw fail('NATIVE_LOGIN_REQUIRED', 401, 'Yêu cầu đăng nhập.');
    }
    assertBuilderPatScope(ctx, patScopes || (rootOnly ? ['write'] : ['read', 'write']), foundation);

    const roles = await resolveVerifiedRoles(db, ctx);
    const ruRepo = db?.getRepository?.('rolesUsers');
    const hasRuRepo = Boolean(ruRepo && typeof ruRepo.find === 'function');
    const isRoot = roles.includes('root') || (!hasRuRepo && ctx?.state?.currentUser?.isRoot === true);

    if ((rootOnly || ctx?.state?.currentRole === 'root') && !isRoot) {
      throw fail('ROOT_ADMIN_REQUIRED', 403, 'Verified root role required for DX-OS Studio builder mutations');
    }

    const orgAdmin = await isOrgAdmin(db, ctx);
    const allowed = isRoot || roles.some((r) => ADMIN_ROLES.has(String(r))) || orgAdmin;
    if (!allowed) {
      throw fail('FORBIDDEN', 403, 'Verified root or ldx_admin role required for DX-OS Studio builder');
    }

    const rawReqOrg = params.organizationId ?? params.tenantId ?? null;
    const requestedOrgId = rawReqOrg != null ? String(rawReqOrg).trim() || null : null;
    const { organizationId, actor } = await resolveTenantActor(
      db,
      ctx,
      {
        requireOrg,
        requestedOrgId,
        aclCollections: [],
      },
      foundation,
    );
    return { organizationId, actor, roles, isRoot };
  }

  return {
    async listDomains(ctx, next) {
      const params = readParams(ctx);
      await requireBuilderAdmin(ctx, params, { requireOrg: false, rootOnly: false, patScopes: ['read', 'write'] });

      const collectionsRepo = db.getRepository?.('collections');
      const fieldsRepo = db.getRepository?.('fields');
      const routesRepo = db.getRepository?.('desktopRoutes');

      const colMap = new Map();
      if (collectionsRepo) {
        const rows = await collectionsRepo.find({ limit: 500 });
        for (const r of Array.isArray(rows) ? rows : []) {
          const plain = toPlain(r);
          if (CUSTOM_COLLECTION_RE.test(String(plain?.name || ''))) {
            colMap.set(plain.name, plain);
          }
        }
      }
      if (db.collections && typeof db.collections.entries === 'function') {
        for (const [name] of db.collections.entries()) {
          if (CUSTOM_COLLECTION_RE.test(String(name)) && !colMap.has(name)) {
            colMap.set(name, { name, title: name });
          }
        }
      }

      const routeRows = routesRepo ? await routesRepo.find({ limit: 500 }) : [];
      const routes = (Array.isArray(routeRows) ? routeRows : []).map(toPlain);

      const items = [];
      for (const [name, meta] of colMap.entries()) {
        let fields = [];
        if (fieldsRepo) {
          const fRows = await fieldsRepo.find({ filter: { collectionName: name }, limit: 200 });
          fields = (Array.isArray(fRows) ? fRows : []).map(toPlain);
        } else if (typeof db.getCollection === 'function') {
          const col = db.getCollection(name);
          if (col?.fields) {
            fields = Array.from(col.fields.values()).map((f) => ({
              name: f.name,
              type: f.type,
            }));
          }
        }
        const boundRoutes = routes
          .filter((r) => r?.options?.collectionName === name)
          .map((r) => ({ id: r.id, title: r.title, path: r.options?.path || null, schemaUid: r.schemaUid }));

        items.push({
          collectionName: name,
          title: meta.title || name,
          description: meta.description || null,
          rlsProtected: true,
          fields,
          portalPages: boundRoutes,
        });
      }
      ctx.body = { items };
      return next();
    },

    async createDomain(ctx, next) {
      const params = readParams(ctx);
      await requireBuilderAdmin(ctx, params, { requireOrg: false, rootOnly: true, patScopes: ['write'] });
      const domain = await createOrUpdateDomainCollection(db, params, {
        ctx,
        applyBlueprint: createBuilderApplyBlueprint(ctx),
      });
      ctx.body = { domain };
      return next();
    },

    async listBusinessPacks(ctx, next) {
      const params = readParams(ctx);
      const { organizationId } = await requireBuilderAdmin(ctx, params, { requireOrg: false, rootOnly: false, patScopes: ['read', 'write'] });

      const colsRepo = db.getRepository?.('collections');
      const dmnRepo = db.getRepository?.('latticeDecisionTables');
      const rulesRepo = db.getRepository?.('latticeAutomationRules');

      const items = [];
      for (const pack of BUSINESS_PACK_CATALOG) {
        const hasCollection =
          (colsRepo ? Boolean(await colsRepo.findOne({ filter: { name: pack.components.collection } })) : false) ||
          Boolean(db.getCollection?.(pack.components.collection));
        const hasDmn = dmnRepo
          ? Boolean(await dmnRepo.findOne({ filter: { organizationId, tableKey: pack.components.dmnTableKey } }))
          : false;
        const hasRule = rulesRepo
          ? Boolean(await rulesRepo.findOne({ filter: { organizationId, ruleKey: pack.components.automationRuleKey } }))
          : false;

        items.push({
          ...pack,
          installed: Boolean(hasCollection && hasDmn && hasRule),
        });
      }
      ctx.body = { items };
      return next();
    },

    async installBusinessPack(ctx, next) {
      const params = readParams(ctx);
      const { organizationId, actor } = await requireBuilderAdmin(ctx, params, { requireOrg: true, rootOnly: true, patScopes: ['write'] });
      const packKey = String(params.packKey || '').trim();
      if (packKey !== 'cmms-maintenance') {
        throw fail('UNKNOWN_BUSINESS_PACK', 400, `Unsupported business pack "${packKey || '(empty)'}"`);
      }

      const domain = await createOrUpdateDomainCollection(db, {
        collectionName: 'latticeCustomWorkOrders',
        title: 'CMMS Work Orders',
        description: 'Automated maintenance and cold-chain work orders.',
        fields: [
          { name: 'workOrderCode', type: 'string', title: 'Work Order Code', required: true, indexed: true },
          { name: 'title', type: 'string', title: 'Title', required: true },
          { name: 'assetId', type: 'integer', title: 'Asset ID' },
          { name: 'deviceKey', type: 'string', title: 'Device Key', indexed: true },
          {
            name: 'priority',
            type: 'string',
            title: 'Priority',
            required: true,
            enumValues: ['low', 'medium', 'high', 'critical'],
          },
          {
            name: 'status',
            type: 'string',
            title: 'Status',
            required: true,
            enumValues: ['open', 'in_progress', 'completed', 'cancelled'],
          },
          { name: 'faultSummary', type: 'text', title: 'Fault Summary' },
          { name: 'assignedRole', type: 'string', title: 'Assigned Role' },
          { name: 'dueAt', type: 'datetime', title: 'Due At' },
        ],
        roles: ['ldx_admin', 'ldx_manager', 'ldx_dispatcher', 'ldx_warehouse', 'ldx_operator', 'ldx_employee'],
        portalSlug: 'cmms',
        portalTitle: 'CMMS Maintenance',
      }, {
        ctx,
        applyBlueprint: createBuilderApplyBlueprint(ctx),
      });

      const dmnRepo = db.getRepository?.('latticeDecisionTables');
      const dmnValues = {
        organizationId,
        tableKey: 'cmms_priority_routing_v1',
        name: 'CMMS Cold-Chain Fault Priority Routing',
        description: 'Maps cold-chain alarm severity and eventType to CMMS priority, assignedRole, and SLA hours.',
        hitPolicy: 'FIRST',
        version: 1,
        active: true,
        inputsJson: [
          { name: 'severity', type: 'string' },
          { name: 'eventType', type: 'string' },
        ],
        outputsJson: [
          { name: 'workOrderPriority', type: 'string' },
          { name: 'assignedRole', type: 'string' },
          { name: 'slaHours', type: 'number' },
        ],
        rulesJson: [
          {
            id: 'r1',
            when: { severity: 'critical', eventType: 'alarm.triggered' },
            then: { workOrderPriority: 'critical', assignedRole: 'ldx_manager', slaHours: 2 },
          },
          {
            id: 'r2',
            when: { severity: 'high', eventType: 'alarm.triggered' },
            then: { workOrderPriority: 'high', assignedRole: 'ldx_operator', slaHours: 4 },
          },
          {
            id: 'r3',
            when: { eventType: 'lot.held_mkt' },
            then: { workOrderPriority: 'critical', assignedRole: 'ldx_manager', slaHours: 1 },
          },
          {
            id: 'r4',
            when: {},
            then: { workOrderPriority: 'medium', assignedRole: 'ldx_operator', slaHours: 24 },
          },
        ],
      };
      const dmnRow = dmnRepo
        ? await upsertRepoRow(dmnRepo, { organizationId, tableKey: 'cmms_priority_routing_v1' }, dmnValues)
        : dmnValues;

      const rulesRepo = db.getRepository?.('latticeAutomationRules');
      const ruleKey = 'auto_cmms_on_coldchain_fault';
      if (!RULE_KEY_RE.test(ruleKey)) throw fail('INVALID_PACK_RULE', 500, 'Invalid pack rule key');
      const ruleValues = {
        organizationId,
        ruleKey,
        name: 'Auto Create CMMS Work Order on Cold-Chain Alarm',
        description: 'Evaluates cmms_priority_routing_v1 DMN and creates a CMMS work order plus notifies the assigned role.',
        triggerEventType: 'alarm.triggered',
        filterJson: null,
        dmnTableKey: 'cmms_priority_routing_v1',
        actionsJson: [
          {
            type: 'create_record',
            collection: 'latticeCustomWorkOrders',
            values: {
              workOrderCode: 'WO-{{id}}',
              title: 'Cold-Chain Fault: {{data.deviceKey}}',
              assetId: '{{data.assetId}}',
              deviceKey: '{{data.deviceKey}}',
              priority: '{{dmn.workOrderPriority}}',
              status: 'open',
              faultSummary: '{{data.message}}',
              assignedRole: '{{dmn.assignedRole}}',
            },
          },
          {
            type: 'notify_role',
            role: '{{dmn.assignedRole}}',
            category: 'cmms',
            severity: 'warning',
            title: 'CMMS Work Order ({{dmn.workOrderPriority}})',
            body: 'Auto-created CMMS work order for {{data.deviceKey}}',
            targetCollection: 'latticeCustomWorkOrders',
            targetPath: '/p/cmms',
          },
        ],
        maxDepth: 8,
        cooldownSec: 0,
        active: true,
        createdBy: actor?.username ? String(actor.username) : null,
      };
      const ruleRow = rulesRepo
        ? await upsertRepoRow(rulesRepo, { organizationId, ruleKey }, ruleValues)
        : ruleValues;

      ctx.body = {
        installed: true,
        packKey,
        organizationId,
        domain,
        dmnTable: toPlain(dmnRow),
        automationRule: toPlain(ruleRow),
      };
      return next();
    },

    async listTenants(ctx, next) {
      const params = readParams(ctx);
      const { organizationId, isRoot } = await requireBuilderAdmin(ctx, params, {
        requireOrg: false,
        rootOnly: false,
        patScopes: ['read', 'write'],
      });

      const orgRepo = db.getRepository?.('latticeOrganizations');
      const deptRepo = db.getRepository?.('latticeDepartments');
      const empRepo = db.getRepository?.('latticeEmployees');
      const pkiRepo = db.getRepository?.('latticePkiKeys');
      const slaRepo = db.getRepository?.('latticeSlaPolicies');

      const { limit, offset } = clampPageLimit(params);
      let orgRows = orgRepo ? await orgRepo.find({ sort: ['organizationId'], limit, offset }) : [];
      if (!isRoot) {
        orgRows = (Array.isArray(orgRows) ? orgRows : []).filter(
          (o) => val(o, 'organizationId') === organizationId,
        );
      }

      const items = [];
      for (const row of Array.isArray(orgRows) ? orgRows : []) {
        const plain = toPlain(row);
        const orgId = plain.organizationId;
        const depts = deptRepo ? await deptRepo.find({ filter: { organizationId: orgId }, limit: 200 }) : [];
        const emps = empRepo ? await empRepo.find({ filter: { organizationId: orgId }, limit: 500 }) : [];
        const pki = pkiRepo ? await pkiRepo.findOne({ filter: { organizationId: orgId, active: true } }) : null;
        const slas = slaRepo ? await slaRepo.find({ filter: { organizationId: orgId }, limit: 200 }) : [];

        const pkiActive = pki ? val(pki, 'active') !== false && val(pki, 'status') !== 'inactive' : false;
        items.push({
          ...plain,
          departmentCount: Array.isArray(depts) ? depts.length : 0,
          employeeCount: Array.isArray(emps) ? emps.length : 0,
          activePkiKey: pki
            ? {
                keyId: val(pki, 'keyId'),
                algorithm: val(pki, 'algorithm'),
                active: pkiActive,
                status: val(pki, 'status') || (pkiActive ? 'active' : 'inactive'),
              }
            : null,
          slaCount: Array.isArray(slas) ? slas.length : 0,
        });
      }
      ctx.body = { items };
      return next();
    },

    async provisionTenant(ctx, next) {
      const params = readParams(ctx);
      const organizationId = String(params.organizationId || params.tenantId || '').trim();
      if (!ORG_ID_RE.test(organizationId) || organizationId.toLowerCase() === 'all') {
        throw fail('INVALID_ORGANIZATION_ID', 400, 'organizationId must match ^[a-zA-Z0-9][a-zA-Z0-9_-]{1,62}$');
      }
      await requireBuilderAdmin(ctx, params, { requireOrg: true, rootOnly: true, patScopes: ['write'] });
      const name = String(params.name || organizationId).trim();
      const region = String(params.region || 'VN').trim() || 'VN';

      const orgRepo = db.getRepository?.('latticeOrganizations');
      const deptRepo = db.getRepository?.('latticeDepartments');
      const locRepo = db.getRepository?.('latticeLocations');
      const slaRepo = db.getRepository?.('latticeSlaPolicies');

      const orgRow = orgRepo
        ? await upsertRepoRow(
            orgRepo,
            { organizationId },
            { organizationId, name, region, status: 'active', active: true },
          )
        : { organizationId, name, region, status: 'active', active: true };

      const departments = [];
      if (deptRepo) {
        const defaultDepts = [
          { code: 'ops', name: 'Operations', organizationId, active: true },
          { code: 'maint', name: 'Maintenance & Cold-Chain', organizationId, active: true },
        ];
        for (const dept of defaultDepts) {
          departments.push(toPlain(await upsertRepoRow(deptRepo, { organizationId, code: dept.code }, dept)));
        }
      }

      const locations = [];
      if (locRepo) {
        const primaryDeptId = departments[0]?.id ?? null;
        const defaultLocs = [
          {
            code: 'hq',
            name: `${name} HQ`,
            organizationId,
            kind: 'headquarters',
            departmentId: primaryDeptId,
            active: true,
          },
        ];
        for (const loc of defaultLocs) {
          locations.push(toPlain(await upsertRepoRow(locRepo, { organizationId, code: loc.code }, loc)));
        }
      }

      const pkiKey = await generateOrEnsureOrgPkiKey(db, organizationId, options.env);

      const slas = [];
      if (slaRepo) {
        const defaultSlas = [
          {
            organizationId,
            targetCollection: 'latticeServiceTickets',
            priority: 'urgent',
            warnAfterMinutes: 60,
            breachAfterMinutes: 240,
            escalateToRole: 'ldx_manager',
            notifyChannels: ['in_app'],
            active: true,
          },
          {
            organizationId,
            targetCollection: 'latticeServiceTickets',
            priority: 'high',
            warnAfterMinutes: 120,
            breachAfterMinutes: 480,
            escalateToRole: 'ldx_manager',
            notifyChannels: ['in_app'],
            active: true,
          },
          {
            organizationId,
            targetCollection: 'latticeServiceTickets',
            priority: 'normal',
            warnAfterMinutes: 480,
            breachAfterMinutes: 1440,
            escalateToRole: 'ldx_admin',
            notifyChannels: ['in_app'],
            active: true,
          },
          {
            organizationId,
            targetCollection: 'latticeIncidentCases',
            priority: 'critical',
            warnAfterMinutes: 15,
            breachAfterMinutes: 60,
            escalateToRole: 'ldx_admin',
            notifyChannels: ['in_app'],
            active: true,
          },
        ];
        for (const sla of defaultSlas) {
          slas.push(
            toPlain(
              await upsertRepoRow(
                slaRepo,
                {
                  organizationId: sla.organizationId,
                  targetCollection: sla.targetCollection,
                  priority: sla.priority,
                },
                sla,
              ),
            ),
          );
        }
      }

      let adminAccount = null;
      const adminUsername = params.adminUsername ? String(params.adminUsername).trim() : '';
      const adminEmail = params.adminEmail ? String(params.adminEmail).trim() : '';
      if (adminUsername || adminEmail) {
        const usersRepo = db.getRepository?.('users');
        const rolesUsersRepo = db.getRepository?.('rolesUsers');
        const empRepo = db.getRepository?.('latticeEmployees');
        const resolvedUsername = adminUsername || (adminEmail.includes('@') ? adminEmail.split('@')[0] : adminEmail);
        const resolvedEmail = adminEmail || `${resolvedUsername}@${organizationId}.local`;
        let userRow = null;
        let createdNewUser = false;
        let generatedTempPassword = null;

        if (usersRepo) {
          const byUsername = adminUsername ? await usersRepo.findOne({ filter: { username: adminUsername } }) : null;
          const byEmail = adminEmail ? await usersRepo.findOne({ filter: { email: adminEmail } }) : null;
          if (byUsername && byEmail && val(byUsername, 'id') !== val(byEmail, 'id')) {
            throw fail('USER_ORG_CONFLICT', 403, 'adminUsername and adminEmail resolve to different existing users');
          }
          userRow = byUsername || byEmail || null;
          if (!userRow && resolvedUsername && resolvedUsername !== adminUsername) {
            userRow = await usersRepo.findOne({ filter: { username: resolvedUsername } });
          }
          if (!userRow && resolvedEmail && resolvedEmail !== adminEmail) {
            userRow = await usersRepo.findOne({ filter: { email: resolvedEmail } });
          }

          if (userRow) {
            const existingUserId = val(userRow, 'id');
            const legacyUserOrg = val(userRow, 'organizationId');
            if (legacyUserOrg && legacyUserOrg !== organizationId) {
              throw fail('USER_ORG_CONFLICT', 403, `User "${val(userRow, 'username') || resolvedUsername}" belongs to another organization`);
            }
            if (rolesUsersRepo && existingUserId != null) {
              let roleBindings = [];
              if (typeof rolesUsersRepo.find === 'function') {
                roleBindings = (await rolesUsersRepo.find({ filter: { userId: existingUserId } })) || [];
              } else if (typeof rolesUsersRepo.findOne === 'function') {
                const rootRow = await rolesUsersRepo.findOne({ filter: { userId: existingUserId, roleName: 'root' } });
                const adminRow = await rolesUsersRepo.findOne({ filter: { userId: existingUserId, roleName: 'admin' } });
                roleBindings = [rootRow, adminRow].filter(Boolean);
              }
              const holdsPrivilegedRole = roleBindings.some((ru) => {
                const rUserId = val(ru, 'userId');
                if (rUserId != null && String(rUserId) !== String(existingUserId)) return false;
                const rName = String(val(ru, 'roleName') || '').trim().toLowerCase();
                return rName === 'root' || rName === 'admin';
              });
              if (holdsPrivilegedRole) {
                throw fail(
                  'USER_ORG_CONFLICT',
                  403,
                  `Privileged user "${val(userRow, 'username') || resolvedUsername}" cannot be attached to tenant "${organizationId}"`,
                );
              }
            }
            if (!empRepo || typeof empRepo.find !== 'function') {
              throw fail(
                'USER_ORG_CONFLICT',
                403,
                `Cannot verify organization membership for existing user "${val(userRow, 'username') || resolvedUsername}"`,
              );
            }
            const empRows = (await empRepo.find({ filter: { userId: existingUserId }, limit: 100 })) || [];
            const ownedRows = empRows.filter((e) => {
              const eUserId = val(e, 'userId');
              return eUserId == null || String(eUserId) === String(existingUserId);
            });
            if (ownedRows.length === 0 || ownedRows.some((e) => val(e, 'organizationId') !== organizationId)) {
              throw fail(
                'USER_ORG_CONFLICT',
                403,
                `User "${val(userRow, 'username') || resolvedUsername}" belongs to another organization or lacks membership in "${organizationId}"`,
              );
            }
          } else {
            const hasExplicitPassword =
              params.adminPassword !== undefined && params.adminPassword !== null && String(params.adminPassword) !== '';
            const rawPwd = hasExplicitPassword
              ? String(params.adminPassword)
              : crypto.randomBytes(18).toString('base64url');
            userRow = await usersRepo.create({
              values: {
                username: resolvedUsername,
                email: resolvedEmail,
                nickname: params.adminNickname || resolvedUsername || 'Tenant Admin',
                password: rawPwd,
                roles: ['ldx_admin'],
              },
            });
            createdNewUser = true;
            if (!hasExplicitPassword) {
              generatedTempPassword = rawPwd;
            }
          }
        }

        const userId = val(userRow, 'id') ?? null;
        if (rolesUsersRepo && userId != null) {
          await upsertRepoRow(
            rolesUsersRepo,
            { roleName: 'ldx_admin', userId },
            { roleName: 'ldx_admin', userId },
          );
        }
        let employeeRow = null;
        if (empRepo) {
          const empCode = `emp_admin_${organizationId}`;
          employeeRow = await upsertRepoRow(
            empRepo,
            { organizationId, code: empCode },
            {
              organizationId,
              code: empCode,
              name: params.adminNickname || resolvedUsername || 'Tenant Admin',
              email: resolvedEmail,
              userId,
              departmentId: departments[0]?.id ?? null,
              active: true,
            },
          );
        }
        adminAccount = {
          userId,
          username: val(userRow, 'username') || resolvedUsername,
          email: val(userRow, 'email') || resolvedEmail,
          role: 'ldx_admin',
          employeeId: val(employeeRow, 'id') ?? null,
          ...(createdNewUser && generatedTempPassword ? { tempPassword: generatedTempPassword } : {}),
        };
      }

      ctx.body = {
        provisioned: true,
        organization: toPlain(orgRow),
        departmentsCount: departments.length,
        locationsCount: locations.length,
        pkiKey: pkiKey
          ? {
              keyId: pkiKey.keyId,
              algorithm: pkiKey.algorithm,
              active: pkiKey.active !== false,
              status: pkiKey.status || (pkiKey.active === false ? 'inactive' : 'active'),
            }
          : null,
        slaCount: slas.length,
        adminAccount,
      };
      return next();
    },
  };
}

module.exports = {
  BUSINESS_PACK_CATALOG,
  attachAndVerifyPgRls,
  buildSafePgIndexName,
  createDxosBuilderActions,
  createOrUpdateDomainCollection,
  generateOrEnsureOrgPkiKey,
  sanitizeFields,
  upsertPortalPageForDomain,
};
