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
const { fail, val } = require('./wms-dmn-shared');

const ROLE_NAME_RE = /^[a-z][a-z0-9_]{1,40}$/;
const RESERVED_SYSTEM_ROLES = new Set(['root', 'admin', 'anonymous', 'member', 'ldx_sysadmin', 'ldx_connector']);

function isEnterpriseBusinessRole(roleName) {
  const clean = String(roleName || '').trim();
  if (!ROLE_NAME_RE.test(clean) && !/^ldx_[a-z0-9_]{2,40}$/.test(clean)) return false;
  if (clean.startsWith('r_')) return false;
  return !RESERVED_SYSTEM_ROLES.has(clean);
}

const PORTAL_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,48}$/;
const DEFAULT_DOMAIN_ROLES = ['ldx_admin', 'ldx_manager', 'ldx_operator', 'ldx_employee'];

function buildStableUid(prefix, seed) {
  const hash = crypto.createHash('sha256').update(String(seed)).digest('hex').slice(0, 12);
  return `${prefix}-${hash}`;
}

async function upsertRepoRow(repo, filter, values, transaction = null) {
  if (!repo) return null;
  const txOpt = transaction ? { transaction } : {};
  const existing = typeof repo.findOne === 'function' ? await repo.findOne({ filter, ...txOpt }) : null;
  if (existing) {
    if (typeof repo.update === 'function') {
      const existingId = val(existing, 'id');
      await repo.update({
        ...(existingId != null ? { filterByTk: existingId } : {}),
        filter,
        values,
        ...txOpt,
      });
    }
    return (typeof repo.findOne === 'function' ? await repo.findOne({ filter, ...txOpt }) : null) || existing;
  }
  if (typeof repo.create === 'function') {
    return repo.create({ values, ...txOpt });
  }
  return null;
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
    isEnterpriseBusinessRole(r),
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
        .filter((f) => f && f.name && !['json', 'belongsTo', 'hasOne', 'belongsToMany'].includes(f.type))
        .map((f) => f.name)
        .slice(0, 6);
      if (!visibleFields.length) visibleFields.push('organizationId');

      const allPopupFields = Array.from(
        new Set([
          ...visibleFields,
          ...(Array.isArray(fields)
            ? fields.filter((f) => f && f.name && !['belongsTo', 'hasOne', 'belongsToMany'].includes(f.type)).map((f) => f.name)
            : []),
          'organizationId',
        ]),
      );
      const fieldGroups = [];
      for (let i = 0; i < allPopupFields.length; i += 8) {
        fieldGroups.push({
          title: i === 0 ? 'Thông tin chính' : `Chi tiết ${Math.floor(i / 8) + 1}`,
          fields: allPopupFields.slice(i, i + 8),
        });
      }

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
        ...(allPopupFields.length > 8 ? { defaults: { collections: { [collectionName]: { fieldGroups } } } } : {}),
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

module.exports = {
  DEFAULT_DOMAIN_ROLES,
  PORTAL_SLUG_RE,
  RESERVED_SYSTEM_ROLES,
  ROLE_NAME_RE,
  buildStableUid,
  createBuilderApplyBlueprint,
  isEnterpriseBusinessRole,
  resolveExistingRolesSet,
  upsertFlowModel,
  upsertPortalPageForDomain,
  upsertRepoRow,
};
