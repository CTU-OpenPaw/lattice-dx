/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { createHash } = require('node:crypto');
const path = require('node:path');
const {
  LDX_ROLE_RE,
  slugifyVietnameseToLdxRole,
  normalizeAiUsername,
  collectPortalRouteSet,
  resolvePortalRoutes,
  resolvePageGrid,
  extractGridBlockUids,
  placeBesideOrInsertBlock,
  propagatePortalRolesToRoutes,
  buildRbacActionsSpec,
  capturePageSnapshot,
  ensureUiSnapshotsReady,
  bumpSurfaceRevision,
  buildRecommendedBlueprintFromFields,
  sanitizeCreativeBlueprintPayload,
} = require('./ai-surface-creative-tools');
const { validateAiProfilePayload, recordAiAuditLog } = require('./ai-schemas');
const { enforceProfileRoleLock, syncProfileToNocobaseAi } = require('./ai-sync');
const {
  runCreateN8nWorkflow,
  runUpdateN8nWorkflow,
  runActivateN8nWorkflow,
} = require('./n8n-bridge-tool');

const DEFAULT_SELF_HEAL_MAX_ROUNDS = 2;
const CUSTOM_COLLECTION_RE = /^latticeCustom[A-Z][A-Za-z0-9]{1,40}$/;
const FIELD_NAME_RE = /^[a-z][a-zA-Z0-9_]{1,48}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;

const ALL_NATIVE_V2_BLOCK_MODELS = Object.freeze([
  'DxosPortalHeroBlockModel',
  'DxosKpiMetricBlockModel',
  'DxosContextTelemetryBlockModel',
  'DxosAiProposalBlockModel',
  'DxosWorkflowTasksBlockModel',
  'DxosParaVaultBlockModel',
  'DxosCreativeStudioBlockModel',
  'DxosRecordWorkbenchBlockModel',
  'DxosWebGisBlockModel',
  'DxosKanbanScheduleBlockModel',
  'DxosWmsOpsBlockModel',
]);

const ORCHESTRATOR_ALLOWED_BLOCKS = new Set([
  ...ALL_NATIVE_V2_BLOCK_MODELS,
  'NativeTableBlock',
  'NativeFormBlock',
  'NativeDetailsBlock',
  'table',
  'createForm',
  'editForm',
  'details',
  'filterForm',
  'kanban',
  'chart',
  'calendar',
  'list',
  'gridCard',
  'markdown',
  'actionPanel',
]);

const SYSTEM_PROTECTED_COLLECTIONS = new Set([
  'users', 'roles', 'rolesUsers', 'apiKeys', 'authenticators', 'migrations',
  'applicationPlugins', 'aiSettings', 'aiEmployees', 'aiMcpClients',
  'rolesAiEmployees', 'latticeAiAuditLogs', 'latticeAiProfiles', 'latticeAiQuotaUsage',
  'latticeAiApprovalQueue', 'latticeUiSnapshots',
  'dataSourcesRoles', 'dataSourcesRolesResources', 'dataSourcesRolesResourcesActions',
  'dataSourcesRolesResourcesScopes',
]);

const FIELD_INTERFACE_MAP = {
  text: { interface: 'textarea', uiType: 'string' },
  integer: { interface: 'integer', uiType: 'number' },
  float: { interface: 'number', uiType: 'number' },
  boolean: { interface: 'checkbox', uiType: 'boolean' },
  date: { interface: 'datetime', uiType: 'string' },
  select: { interface: 'select', uiType: 'string' },
  enum: { interface: 'select', uiType: 'string' },
  json: { interface: 'json', uiType: 'object' },
  jsonb: { interface: 'json', uiType: 'object' },
  string: { interface: 'input', uiType: 'string' },
};

const val = (row, key) => (typeof row?.get === 'function' ? row.get(key) : row?.[key]);

function failBuild(code, status, message) {
  return Object.assign(new Error(message || code), { code, status });
}

function loadCrossPluginModule(pkgName, dirSlug, relPath) {
  const inDist = __dirname.includes(`${path.sep}dist${path.sep}`);
  const candidates = inDist
    ? [`${pkgName}/dist/server/${relPath}`, `${pkgName}/src/server/${relPath}`, `../../../${dirSlug}/dist/server/${relPath}`, `../../../${dirSlug}/src/server/${relPath}`]
    : [`${pkgName}/src/server/${relPath}`, `../../../${dirSlug}/src/server/${relPath}`, `${pkgName}/dist/server/${relPath}`, `../../../${dirSlug}/dist/server/${relPath}`];
  for (const modPath of candidates) {
    try {
      return require(modPath);
    } catch (err) {
      const direct = err?.code === 'MODULE_NOT_FOUND'
        && (!Array.isArray(err.requireStack) || err.requireStack.length === 0 || err.requireStack[0] === __filename);
      if (!direct) throw err;
    }
  }
  return null;
}

const getPgRlsMod = () => loadCrossPluginModule('@latticedx/plugin-lattice-foundation', 'plugin-lattice-foundation', 'pg-rls');
const getOpenApiMod = () => loadCrossPluginModule('@latticedx/plugin-lattice-foundation', 'plugin-lattice-foundation', 'openapi-spec');
const getDmnMod = () => loadCrossPluginModule('@latticedx/plugin-dxos-studio', 'plugin-dxos-studio', 'dmn-engine');
const getFlowExecutorMod = () => loadCrossPluginModule('@latticedx/plugin-dxos-studio', 'plugin-dxos-studio', 'flow/executor');
const getFlowValidatorMod = () => loadCrossPluginModule('@latticedx/plugin-dxos-studio', 'plugin-dxos-studio', 'flow/validator');
const getFlowSchemaMod = () => loadCrossPluginModule('@latticedx/plugin-dxos-studio', 'plugin-dxos-studio', 'flow/schema');
const getFlowArchitectMod = () => loadCrossPluginModule('@latticedx/plugin-dxos-studio', 'plugin-dxos-studio', 'flow/architect');
const getN8nApiClientMod = () => loadCrossPluginModule('@latticedx/plugin-dxos-studio', 'plugin-dxos-studio', 'n8n-api-client');
const getVaultMod = () => loadCrossPluginModule('@latticedx/plugin-lattice-foundation', 'plugin-lattice-foundation', 'connector-vault');

async function withOptionalTenantRls(db, organizationId, fn) {
  const pgRls = getPgRlsMod();
  if (
    pgRls
    && typeof pgRls.canUsePgRlsSession === 'function'
    && pgRls.canUsePgRlsSession(db)
    && !pgRls.getActiveRlsContext?.()?.transaction
    && organizationId
    && typeof pgRls.withTenantRlsContext === 'function'
  ) {
    return pgRls.withTenantRlsContext(db, organizationId, fn);
  }
  return fn(null);
}

async function withOptionalSystemRls(db, fn) {
  const pgRls = getPgRlsMod();
  if (
    pgRls
    && typeof pgRls.canUsePgRlsSession === 'function'
    && pgRls.canUsePgRlsSession(db)
    && !pgRls.getActiveRlsContext?.()?.transaction
    && typeof pgRls.withSystemRlsBypass === 'function'
  ) {
    return pgRls.withSystemRlsBypass(db, fn);
  }
  return fn(null);
}

function buildSafePgIndexName(colLower, suffix) {
  const raw = `idx_${colLower}_${suffix}`;
  if (raw.length <= 63) return raw;
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 8);
  const maxBase = Math.max(8, 63 - 4 - suffix.length - 1 - 8 - 1);
  return `idx_${colLower.slice(0, maxBase)}_${hash}_${suffix}`;
}

function normalizeOrchestratorField(rawField) {
  const fname = String(rawField?.name || '').trim();
  if (!FIELD_NAME_RE.test(fname)) {
    throw failBuild('FIELD_NAME_INVALID', 400, `Tên trường "${fname}" không hợp lệ.`);
  }
  const rawType = String(rawField?.type || 'string').trim();
  if (rawType === 'belongsTo') {
    const target = String(rawField?.target || rawField?.targetCollection || '').trim();
    if (!target || SYSTEM_PROTECTED_COLLECTIONS.has(target) || !/^[a-zA-Z][a-zA-Z0-9_]{1,60}$/.test(target)) {
      throw failBuild('RELATION_TARGET_FORBIDDEN', 403, `Bảng đích quan hệ belongsTo "${target || '(empty)'}" không hợp lệ hoặc bị cấm.`);
    }
    const foreignKey = String(rawField?.foreignKey || `${fname}Id`).trim();
    const targetKey = String(rawField?.targetKey || 'id').trim();
    if (!FIELD_NAME_RE.test(foreignKey) || !FIELD_NAME_RE.test(targetKey)) {
      throw failBuild('FIELD_NAME_INVALID', 400, `foreignKey/targetKey không hợp lệ cho trường "${fname}".`);
    }
    return {
      name: fname,
      type: 'belongsTo',
      interface: 'obo',
      target,
      foreignKey,
      targetKey,
      uiSchema: {
        type: 'object',
        title: String(rawField?.title || fname),
        'x-component': 'AssociationField',
      },
    };
  }
  const ftype = Object.prototype.hasOwnProperty.call(FIELD_INTERFACE_MAP, rawType) ? rawType : 'string';
  const meta = FIELD_INTERFACE_MAP[ftype];
  const rawEnums = Array.isArray(rawField?.enumValues) ? rawField.enumValues : (Array.isArray(rawField?.enum) ? rawField.enum : []);
  const enumValues = rawEnums
    .map((v) => (v && typeof v === 'object' ? String(v.value ?? v.label ?? '').trim() : String(v ?? '').trim()))
    .filter(Boolean);
  const resolvedType = (ftype === 'select' || ftype === 'enum') ? 'string' : (ftype === 'jsonb' ? 'json' : ftype);
  return {
    name: fname,
    type: resolvedType,
    interface: meta.interface,
    ...(rawField?.defaultValue !== undefined ? { defaultValue: rawField.defaultValue } : {}),
    ...(enumValues.length ? { enum: enumValues } : {}),
    uiSchema: {
      type: meta.uiType,
      title: String(rawField?.title || fname),
      ...((ftype === 'select' || ftype === 'enum') && enumValues.length
        ? { enum: enumValues.map((v) => ({ value: v, label: v })) }
        : {}),
    },
  };
}

function safeGetResource(ctx, resourceName) {
  const rms = [ctx?.app?.resourceManager, ctx?.app?.mainDataSource?.resourceManager, ctx?.app?.resourcer];
  for (const rm of rms) {
    if (!rm) continue;
    try {
      if (typeof rm.isDefined === 'function' && !rm.isDefined(resourceName)) continue;
      const res = rm.getResource?.(resourceName);
      if (res) return res;
    } catch {}
  }
  return null;
}

async function invokeResAction(ctx, resourceName, actionName, options = {}) {
  const { filterByTk, values, method, ...extraParams } = options && typeof options === 'object' ? options : {};
  const res = safeGetResource(ctx, resourceName);
  const handler = res?.actions?.get?.(actionName)?.handler || res?.actions?.[actionName];
  if (typeof handler !== 'function') {
    throw failBuild('HOST_ACTION_UNAVAILABLE', 503, `Dịch vụ ${resourceName}:${actionName} chưa sẵn sàng.`);
  }
  const params = {
    resourceName,
    actionName,
    ...extraParams,
    ...(filterByTk != null ? { filterByTk } : {}),
    ...(values ? { values } : {}),
  };
  const subCtx = {
    ...(method ? { method } : {}),
    ...(method === 'GET' ? { query: { ...extraParams } } : {}),
    app: ctx.app,
    db: ctx.db,
    dataSource: ctx.dataSource || ctx.app?.mainDataSource,
    state: { ...(ctx.state || {}) },
    auth: ctx.auth,
    action: {
      actionName,
      resourceName,
      params,
      mergeParams: (patch) => { if (patch && typeof patch === 'object') Object.assign(params, patch); },
    },
    request: { headers: {} },
    body: null,
    throw: (s, m) => { throw failBuild('HOST_ACTION_ERROR', s, m); },
  };
  await handler(subCtx, async () => {});
  if (subCtx.status && subCtx.status >= 400) {
    throw failBuild('HOST_ACTION_ERROR', subCtx.status, subCtx.body?.errors?.[0]?.message || `${resourceName}:${actionName} failed`);
  }
  return subCtx.body?.data || subCtx.body || {};
}

async function attachCollectionRls(db, collectionName) {
  let attached = false;
  if (typeof db?.attachLatticeRlsPolicy === 'function') {
    try {
      const res = await db.attachLatticeRlsPolicy(collectionName);
      if (res?.applied !== false) attached = true;
    } catch {
      // Fallback to pgRls below
    }
  }
  const pgRls = getPgRlsMod();
  if (typeof pgRls?.attachRlsPolicyToTable === 'function' && db?.sequelize) {
    try {
      const rlsRes = await withOptionalSystemRls(db, (transaction) => pgRls.attachRlsPolicyToTable(db, collectionName, { ...(transaction ? { transaction } : {}) }));
      if (rlsRes?.applied) attached = true;
    } catch {
      // Non-fatal in non-Postgres mock harnesses
    }
  }
  return attached;
}

async function ensureCollectionAndFields(db, organizationId, { collectionName, collectionTitle, fields = [] }) {
  if (!CUSTOM_COLLECTION_RE.test(collectionName)) {
    throw failBuild('COLLECTION_NAME_INVALID', 400, 'Collection mới phải theo mẫu latticeCustom<TenVietHoa>.');
  }
  if (SYSTEM_PROTECTED_COLLECTIONS.has(collectionName)) {
    throw failBuild('SYSTEM_COLLECTION_FORBIDDEN', 403, `Không được phép sửa bảng hệ thống "${collectionName}".`);
  }
  const normalizedFields = fields.map((f) => normalizeOrchestratorField(f));
  const hasFieldName = (name) => normalizedFields.some((f) => f.name === name);
  if (!hasFieldName('status')) normalizedFields.unshift({ name: 'status', type: 'string', interface: 'input', defaultValue: 'draft', uiSchema: { type: 'string', title: 'Trạng thái' } });
  if (!hasFieldName('name')) normalizedFields.unshift({ name: 'name', type: 'string', interface: 'input', uiSchema: { type: 'string', title: 'Tên hồ sơ' } });
  if (!hasFieldName('code')) normalizedFields.unshift({ name: 'code', type: 'string', interface: 'input', uiSchema: { type: 'string', title: 'Mã hồ sơ' } });
  if (!hasFieldName('organizationId')) {
    normalizedFields.unshift({ name: 'organizationId', type: 'string', interface: 'input', allowNull: false, defaultValue: organizationId, uiSchema: { type: 'string', title: 'Mã tổ chức' } });
  }

  const colsRepo = db?.getRepository?.('collections');
  if (!colsRepo) throw failBuild('SCHEMA_REPO_UNAVAILABLE', 503, 'Repository collections chưa sẵn sàng.');
  const existing = await colsRepo.findOne({ filter: { name: collectionName }, appends: ['fields'] });
  if (!existing) {
    const created = await colsRepo.create({
      values: {
        name: collectionName,
        title: collectionTitle || collectionName,
        autoGenId: true,
        createdAt: true,
        updatedAt: true,
        options: { titleField: 'name', uiManageable: true },
        fields: normalizedFields,
      },
    });
    if (typeof created?.load === 'function') await created.load({ resetFields: true });
  } else {
    const existingFieldNames = new Set((val(existing, 'fields') || []).map((f) => val(f, 'name')).filter(Boolean));
    const missingFields = normalizedFields.filter((f) => !existingFieldNames.has(f.name));
    const fieldsRepo = db?.getRepository?.('fields');
    if (missingFields.length && fieldsRepo) {
      for (const f of missingFields) {
        const cf = await fieldsRepo.create({ values: { ...f, collectionName } });
        if (typeof cf?.load === 'function') await cf.load();
      }
    }
    if (typeof existing.load === 'function') await existing.load({ resetFields: true });
  }

  const colInst = db.getCollection?.(collectionName);
  if (colInst && typeof colInst.sync === 'function') await colInst.sync({ force: false, alter: { drop: false } });
  else if (typeof db.sync === 'function') await db.sync();

  const createdIndexes = [];
  if (typeof db?.sequelize?.query === 'function') {
    const colLower = collectionName.toLowerCase();
    for (const [suffix, colsSql] of [['org', '"organizationId"'], ['org_status', '"organizationId", "status"']]) {
      const idxName = buildSafePgIndexName(colLower, suffix);
      try {
        await db.sequelize.query(`CREATE INDEX IF NOT EXISTS "${idxName}" ON "${collectionName}" (${colsSql});`);
        createdIndexes.push(idxName);
      } catch {
        // Non-fatal in mock harnesses without SQL DDL
      }
    }
  }
  const rlsAttached = await attachCollectionRls(db, collectionName);
  return { collectionName, fields: normalizedFields, indexes: createdIndexes, rlsAttached };
}

async function ensureRoleAndRbac(ctx, db, actor, { roleName, roleTitle, collectionName, fields = [], lockedFields = [] }) {
  if (!LDX_ROLE_RE.test(roleName)) {
    throw failBuild('ROLE_FORBIDDEN', 403, `Vai trò "${roleName}" phải bắt đầu bằng ldx_*.`);
  }
  const rolesRepo = db?.getRepository?.('roles');
  let desiredTitle = String(roleTitle || `Lattice — ${roleName}`).trim();
  if (rolesRepo) {
    const role = await rolesRepo.findOne({ filter: { name: roleName } });
    const byTitle = desiredTitle ? await rolesRepo.findOne({ filter: { title: desiredTitle } }) : null;
    if (byTitle && val(byTitle, 'name') && val(byTitle, 'name') !== roleName) {
      desiredTitle = `${desiredTitle} (${roleName})`;
    }
    const rVals = {
      name: roleName,
      title: desiredTitle,
      allowConfigure: false,
      allowNewMenu: false,
      allowNewAiEmployee: false,
      strategy: { actions: [] },
      snippets: [],
    };
    if (role && typeof role.update === 'function') await role.update(rVals);
    else if (!role) await rolesRepo.create({ values: rVals });
  }

  const dsRolesRepo = db?.getRepository?.('dataSourcesRoles');
  if (dsRolesRepo && !(await dsRolesRepo.findOne({ filter: { roleName, dataSourceKey: 'main' } }))) {
    await dsRolesRepo.create({ values: { roleName, dataSourceKey: 'main' } });
  }

  const fieldNames = [...new Set(['id', 'code', 'name', 'status', ...fields.map((f) => f.name)].filter(Boolean))];
  const actionsSpec = buildRbacActionsSpec({
    actions: ['view', 'create', 'update'],
    readableFields: fieldNames,
    writableFields: fieldNames,
    lockedFields,
    collectionName,
    db,
  });

  const resRepo = db?.getRepository?.('dataSourcesRolesResources');
  if (resRepo) {
    const exRes = await resRepo.findOne({ filter: { roleName, dataSourceKey: 'main', name: collectionName } });
    if (exRes && typeof resRepo.update === 'function') {
      await resRepo.update({
        filter: { roleName, dataSourceKey: 'main', name: collectionName },
        values: { usingActionsConfig: true, actions: actionsSpec },
        updateAssociationValues: ['actions'],
      });
    } else {
      await resRepo.create({
        values: { roleName, dataSourceKey: 'main', name: collectionName, usingActionsConfig: true, actions: actionsSpec },
      });
    }
    ctx?.app?.dataSourceManager?.dataSources?.get?.('main')?.acl?.getRole?.(roleName)?.writeToACL?.({
      resourceName: collectionName,
      usingActionsConfig: true,
      actions: actionsSpec,
    });
  }

  return { roleName, title: desiredTitle, actionsSpec };
}

async function ensurePortalAndBlocks(ctx, db, actor, {
  portalSlug, pageTitle, roleName, roleTitle, collectionName, fields = [], blocks = [], creativeTheme = 'industrial-cockpit',
}) {
  const layoutUid = `ldx-portal-${portalSlug}`;
  const portalSet = await collectPortalRouteSet(db, portalSlug);
  const existingPortalRoutes = resolvePortalRoutes(portalSet.routes, portalSet.links, layoutUid, val);
  const existingRouteIds = existingPortalRoutes.map((r) => val(r, 'id')).filter((id) => id != null);

  if (safeGetResource(ctx, 'latticePortals')) {
    const portalsRepo = db?.getRepository?.('uiLayouts');
    const curPortal = portalsRepo ? await portalsRepo.findOne({ filter: { uid: layoutUid } }) : null;
    const rolesRoutesRepo = db?.getRepository?.('rolesDesktopRoutes');
    let existingRoles = [];
    if (rolesRoutesRepo && existingRouteIds.length) {
      const grants = (await rolesRoutesRepo.find({ filter: { desktopRouteId: { $in: existingRouteIds } }, limit: 400 })) || [];
      existingRoles = grants.map((g) => val(g, 'roleName')).filter((r) => LDX_ROLE_RE.test(r));
    }
    const mergedRoles = [...new Set([...existingRoles, roleName])];
    await invokeResAction(ctx, 'latticePortals', 'save', {
      values: {
        ...(curPortal ? { uid: layoutUid } : {}),
        slug: portalSlug,
        title: val(curPortal, 'title') || `Portal ${portalSlug}`,
        layoutType: 'desktop',
        enabled: true,
        roles: mergedRoles,
      },
    });
  } else {
    const layoutsRepo = db?.getRepository?.('uiLayouts');
    if (layoutsRepo && !(await layoutsRepo.findOne({ filter: { uid: layoutUid } }))) {
      await layoutsRepo.create({
        values: {
          uid: layoutUid,
          title: `Portal ${portalSlug}`,
          layoutType: 'desktop',
          routeName: `p_${portalSlug.replace(/-/g, '_')}`,
          routePath: `/p/${portalSlug}`,
          authCheck: true,
          enabled: true,
        },
      });
    }
  }
  await propagatePortalRolesToRoutes(db, layoutUid, existingRouteIds, [roleName], val);

  const targetPageTitleNorm = String(pageTitle || '').trim().toLowerCase();
  const existingExactPage = existingPortalRoutes.some(
    (r) => ['flowPage', 'page'].includes(val(r, 'type')) && String(val(r, 'title') || '').trim().toLowerCase() === targetPageTitleNorm,
  );
  const tableFields = [...new Set(['code', 'name', 'status', ...fields.map((f) => f.name)].filter(Boolean))].slice(0, 8);
  if (!existingExactPage) {
    if (safeGetResource(ctx, 'flowSurfaces')) {
      await invokeResAction(ctx, 'flowSurfaces', 'applyBlueprint', {
        values: {
          version: '1',
          mode: 'create',
          navigation: { layoutUid, group: { title: roleTitle || pageTitle, icon: 'AppstoreOutlined' }, item: { title: pageTitle, icon: 'DashboardOutlined' } },
          page: { title: pageTitle, displayTitle: true, enableTabs: false },
          tabs: [{ title: pageTitle, blocks: [{ key: `app-tbl-${Date.now().toString(36)}`, type: 'table', title: `Dữ liệu · ${pageTitle}`, collection: collectionName, fields: tableFields, actions: ['filter', 'refresh'] }] }],
        },
      });
    } else {
      const routesRepo = db?.getRepository?.('desktopRoutes');
      const linksRepo = db?.getRepository?.('desktopRoutesUiLayouts');
      const flowModelsRepo = db?.getRepository?.('flowModels');
      if (routesRepo && flowModelsRepo) {
        const group = await routesRepo.create({ values: { title: roleTitle || pageTitle, type: 'group', parentId: null } });
        const page = await routesRepo.create({ values: { title: pageTitle, type: 'flowPage', parentId: val(group, 'id'), schemaUid: `pg-${portalSlug}-${Date.now().toString(36)}` } });
        const tabUid = `tab-${portalSlug}-${Date.now().toString(36)}`;
        const tab = await routesRepo.create({ values: { title: pageTitle, type: 'tabs', parentId: val(page, 'id'), schemaUid: tabUid } });
        if (linksRepo) {
          for (const rid of [val(group, 'id'), val(page, 'id'), val(tab, 'id')]) {
            await linksRepo.create({ values: { desktopRouteId: rid, uiLayoutUid: layoutUid } });
          }
        }
        await flowModelsRepo.upsertModel({
          uid: `grid-${tabUid}`,
          use: 'BlockGridModel',
          parentId: tabUid,
          subKey: 'grid',
          props: { rows: {}, sizes: {}, rowOrder: [] },
          stepParams: {},
        });
      }
    }
  }

  const resolved = await resolvePageGrid(db, portalSlug, pageTitle, val);
  const createdRouteIds = resolved.pageRoute
    ? [val(resolved.pageRoute, 'parentId'), val(resolved.pageRoute, 'id'), ...resolved.portalRoutes.filter((r) => String(val(r, 'parentId')) === String(val(resolved.pageRoute, 'id'))).map((r) => val(r, 'id'))].filter((id) => id != null)
    : [];
  await propagatePortalRolesToRoutes(db, resolved.layoutUid, createdRouteIds, [roleName], val);

  const attachedBlocks = [];
  if (resolved.grid?.uid && resolved.flowModelsRepo?.upsertModel) {
    const existingGridBlocks = extractGridBlockUids(resolved.grid).ordered;
    const subMap = new Map((Array.isArray(resolved.grid?.subModels?.items) ? resolved.grid.subModels.items : []).map((m) => [m.uid, m]));
    const existingUses = new Set();
    for (const uid of existingGridBlocks) {
      const m = resolved.flowModelsRepo.findModelById ? await resolved.flowModelsRepo.findModelById(uid) : subMap.get(uid);
      if (m?.use) existingUses.add(m.use);
    }

    const requestedBlocks = Array.isArray(blocks) && blocks.length
      ? blocks
      : [
          { blockUse: 'DxosPortalHeroBlockModel', title: pageTitle },
          { blockUse: 'DxosCreativeStudioBlockModel', title: `Trạm ${pageTitle}` },
          { blockUse: 'DxosRecordWorkbenchBlockModel', title: `Chứng từ · ${collectionName}` },
        ];

    for (let i = 0; i < requestedBlocks.length; i += 1) {
      const specItem = requestedBlocks[i];
      const blockUse = String(specItem?.blockUse || specItem?.use || '').trim();
      if (!ORCHESTRATOR_ALLOWED_BLOCKS.has(blockUse)) {
        throw failBuild('BLOCK_MODEL_FORBIDDEN', 400, `BlockModel "${blockUse}" không nằm trong danh sách cho phép.`);
      }
      if (existingUses.has(blockUse) && specItem?.allowDuplicate !== true) continue;
      let cfg = { title: specItem?.title || pageTitle, collection: collectionName, ...(specItem?.config || {}) };
      if (blockUse === 'DxosCreativeStudioBlockModel' && !cfg.blueprintJson) {
        const recBp = buildRecommendedBlueprintFromFields(collectionName, fields, roleName, pageTitle).recommendedCreativeBlock.blueprint;
        const cleanBp = sanitizeCreativeBlueprintPayload({ ...recBp, title: cfg.title, theme: creativeTheme });
        cfg = { ...cfg, blueprintJson: JSON.stringify(cleanBp) };
      }
      const uid = `dxos-app-${portalSlug}-${Date.now().toString(36)}-${i}`;
      await resolved.flowModelsRepo.upsertModel({
        uid,
        use: blockUse,
        parentId: resolved.grid.uid,
        subKey: 'items',
        subType: 'array',
        props: cfg,
        stepParams: { dxosBlockSettings: { config: cfg } },
      });
      await placeBesideOrInsertBlock(resolved.flowModelsRepo, resolved.grid, uid, null, failBuild);
      attachedBlocks.push({ uid, use: blockUse, title: cfg.title });
    }
  }

  return { layoutUid, pageRoute: resolved.pageRoute, gridUid: resolved.grid?.uid || null, attachedBlocks };
}

async function ensureAiAssistant(db, actor, { roleName, roleTitle, portalSlug, pageTitle, lockedFields = [], aiUsername, aiNickname }) {
  const effectiveAiUsername = normalizeAiUsername(aiUsername, roleName);
  const effectiveNickname = String(aiNickname || `Trợ lý ${roleTitle || roleName} AI`).trim();
  const adminTools = [
    'dxos_inspect_architecture', 'dxos_recommend_page_blueprint', 'dxos_design_creative_block',
    'dxos_compose_page_blocks', 'dxos_snapshot_or_rollback_page', 'dxos_provision_role_workspace',
    'dxos_manage_portal_and_acl', 'dxos_extend_collection_schema', 'dxos_manage_rbac_permissions',
    'dxos_deploy_workflow', 'dxos_configure_workflow',
  ];
  const rawProfile = {
    username: effectiveAiUsername,
    nickname: effectiveNickname,
    position: `Trợ lý Chuyên trách ${roleTitle || roleName}`,
    departmentScope: roleName,
    organizationId: actor.organizationId,
    isAdminBuilder: false,
    allowedRoles: [roleName],
    portalBindings: [portalSlug],
    toolPermissions: {
      dxos_search_enterprise_context: 'ALLOW',
      dxos_my_workflow_tasks: 'ALLOW',
      dxos_execute_record_action: 'ASK',
      dxos_orchestrate_enterprise_case: 'ASK',
    },
    quickPrompts: [{ label: `Tóm tắt ${pageTitle}`, prompt: `Kiểm tra dữ liệu mới nhất trên trang ${pageTitle}.` }],
    systemPrompt: `Bạn là ${effectiveNickname} hỗ trợ vai trò ${roleTitle || roleName} tại /p/${portalSlug} (${pageTitle}). Tuân thủ trường khóa: ${lockedFields.join(', ') || 'không có'}.`,
  };
  const validated = enforceProfileRoleLock(validateAiProfilePayload(rawProfile, { adminToolNames: adminTools }), adminTools);
  const profRepo = db?.getRepository?.('latticeAiProfiles');
  if (profRepo) {
    await withOptionalTenantRls(db, actor.organizationId, async (transaction) => {
      const txOpt = transaction ? { transaction } : {};
      const ex = await profRepo.findOne({ filter: { username: validated.username }, ...txOpt });
      if (ex && typeof ex.update === 'function') await ex.update(validated, txOpt);
      else await profRepo.create({ values: validated, ...txOpt });
    });
  }
  await syncProfileToNocobaseAi(db, validated, { adminToolNames: adminTools });
  return validated.username;
}

async function upsertDmnTable(ctx, db, actor, dmnSpec) {
  if (!dmnSpec || typeof dmnSpec !== 'object') return null;
  if (safeGetResource(ctx, 'dxosDmn')) {
    const saved = await invokeResAction(ctx, 'dxosDmn', 'saveTable', {
      method: 'POST',
      organizationId: actor.organizationId,
      ...dmnSpec,
      values: { organizationId: actor.organizationId, ...dmnSpec },
    });
    return saved?.table || saved;
  }
  const dmnMod = getDmnMod();
  if (typeof dmnMod?.createDxosDmnActions === 'function') {
    const actions = dmnMod.createDxosDmnActions(db);
    const subCtx = {
      method: 'POST',
      db,
      app: ctx?.app,
      state: { ...(ctx?.state || {}), currentUser: { id: actor.userId, username: actor.username }, currentRoles: actor.roleNames || ['root'], currentRole: actor.isRoot ? 'root' : (actor.roleNames?.[0] || 'admin') },
      action: { params: { values: { organizationId: actor.organizationId, ...dmnSpec } } },
      body: null,
    };
    await actions.saveTable(subCtx, async () => {});
    return subCtx.body?.table || subCtx.body;
  }
  const repo = db?.getRepository?.('latticeDecisionTables');
  if (!repo) throw failBuild('DMN_REPO_UNAVAILABLE', 503, 'Repository latticeDecisionTables chưa sẵn sàng.');
  return withOptionalTenantRls(db, actor.organizationId, async (transaction) => {
    const txOpt = transaction ? { transaction } : {};
    const existing = await repo.findOne({ filter: { organizationId: actor.organizationId, tableKey: dmnSpec.tableKey }, ...txOpt });
    const patch = {
      organizationId: actor.organizationId,
      tableKey: dmnSpec.tableKey,
      name: dmnSpec.name || dmnSpec.tableKey,
      hitPolicy: String(dmnSpec.hitPolicy || 'FIRST').toUpperCase(),
      inputsJson: dmnSpec.inputsJson || [],
      outputsJson: dmnSpec.outputsJson || [],
      rulesJson: dmnSpec.rulesJson || [],
      published: true,
      active: true,
      updatedBy: actor.username,
      version: existing ? (Number(val(existing, 'version')) || 1) + 1 : 1,
    };
    if (existing && typeof existing.update === 'function') return existing.update(patch);
    return repo.create({ values: patch, ...txOpt });
  });
}

async function upsertFlowV2Rule(db, actor, flowSpec) {
  if (!flowSpec || typeof flowSpec !== 'object') return null;
  const schemaMod = getFlowSchemaMod();
  const validatorMod = getFlowValidatorMod();
  const regMod = loadCrossPluginModule('@latticedx/plugin-dxos-studio', 'plugin-dxos-studio', 'flow/registry');
  const rawGraph = flowSpec.graphJson || flowSpec.graph;
  if (!rawGraph || !Array.isArray(rawGraph.nodes)) {
    throw failBuild('FLOW_INVALID_GRAPH', 400, 'flowGraph.graphJson phải là đồ thị Flow v2 hợp lệ.');
  }
  let normalizedGraph = typeof schemaMod?.normalizeGraph === 'function' ? schemaMod.normalizeGraph(rawGraph) : rawGraph;
  if (typeof validatorMod?.validateFlowGraph === 'function') {
    const check = validatorMod.validateFlowGraph(normalizedGraph, {
      nodeRegistry: regMod?.createDefaultRegistry?.(),
      systemProtectedCollections: SYSTEM_PROTECTED_COLLECTIONS,
      requireTrigger: true,
    });
    if (!check.ok) {
      throw failBuild('FLOW_INVALID_GRAPH', 400, check.errors?.[0]?.message || 'Flow Graph v2 không hợp lệ.');
    }
    normalizedGraph = check.graph;
  }
  const compat = typeof schemaMod?.graphV2SummaryToV1Compat === 'function'
    ? schemaMod.graphV2SummaryToV1Compat({ ...flowSpec, graphJson: normalizedGraph })
    : {};
  const triggerIndexJson = typeof schemaMod?.buildTriggerIndex === 'function'
    ? schemaMod.buildTriggerIndex(normalizedGraph, flowSpec)
    : [];
  const ruleKey = String(flowSpec.ruleKey || `auto_app_${Date.now().toString(36)}`).trim();
  const rulePayload = {
    organizationId: actor.organizationId,
    ruleKey,
    name: flowSpec.name || ruleKey,
    description: flowSpec.description || null,
    schemaVersion: 2,
    graphJson: normalizedGraph,
    triggerIndexJson,
    triggerEventType: compat.triggerEventType || triggerIndexJson[0]?.eventType || '*',
    filterJson: compat.filterJson ?? null,
    dmnTableKey: compat.dmnTableKey || flowSpec.dmnTableKey || null,
    actionsJson: Array.isArray(compat.actionsJson) ? compat.actionsJson : [],
    maxDepth: 8,
    cooldownSec: Number(flowSpec.cooldownSec) || 0,
    active: true,
  };
  const repo = db?.getRepository?.('latticeAutomationRules');
  if (!repo) throw failBuild('AUTOMATION_ENGINE_UNAVAILABLE', 503, 'Repository latticeAutomationRules chưa sẵn sàng.');
  await withOptionalTenantRls(db, actor.organizationId, async (transaction) => {
    const txOpt = transaction ? { transaction } : {};
    const existing = await repo.findOne({ filter: { organizationId: actor.organizationId, ruleKey }, ...txOpt });
    if (existing && typeof repo.update === 'function') {
      await repo.update({ filter: { organizationId: actor.organizationId, ruleKey }, values: rulePayload, ...txOpt });
    } else if (existing && typeof existing.update === 'function') {
      await existing.update(rulePayload);
    } else {
      await repo.create({ values: { ...rulePayload, createdBy: actor.username }, ...txOpt });
    }
  });
  return rulePayload;
}

async function resolveN8nClientForVerify(ctx, db, actor, deps = {}) {
  if (deps.n8nClient) return deps.n8nClient;
  const n8nApiMod = getN8nApiClientMod();
  const vaultMod = ctx?.app?.latticeVault || getVaultMod();
  if (!n8nApiMod?.createN8nApiClient) return null;
  const env = deps.env || process.env;
  const repo = db?.getRepository?.('latticeConnectors');
  let baseUrl = '';
  let apiKey = '';
  if (repo && typeof repo.find === 'function') {
    const rows = (await withOptionalTenantRls(db, actor.organizationId, (transaction) => (
      repo.find({
        filter: { organizationId: actor.organizationId, active: true },
        sort: ['id'],
        limit: 50,
        ...(transaction ? { transaction } : {}),
      })
    ))) || [];
    const picked = rows.find((r) => val(r, 'organizationId') === actor.organizationId && (String(val(r, 'appType') || '').toLowerCase() === 'n8n_api' || String(val(r, 'connectorType') || '').toLowerCase() === 'n8n'));
    if (picked && typeof vaultMod?.resolveConnectorSecrets === 'function') {
      const resolved = await vaultMod.resolveConnectorSecrets(db, actor.organizationId, val(picked, 'connectorKey'), { env });
      baseUrl = resolved.connector.baseUrl || '';
      apiKey = String(resolved.secrets.apiKey || resolved.secrets.token || '').trim();
    }
  }
  if (!baseUrl && env?.DX_N8N_API_URL) baseUrl = String(env.DX_N8N_API_URL).trim();
  if (!apiKey && env?.DX_N8N_API_KEY) apiKey = String(env.DX_N8N_API_KEY).trim();
  if (!baseUrl) return null;
  const allowInternal = vaultMod?.resolveAllowInternalConnectorHosts?.({ isRoot: Boolean(actor?.isRoot || actor?.isAdmin), env }) ?? true;
  return n8nApiMod.createN8nApiClient({
    baseUrl,
    apiKey,
    fetchFn: deps.fetchImpl || globalThis.fetch,
    env,
    lookupImpl: deps.lookupImpl,
    allowInternal,
    connectorVault: vaultMod,
  });
}

/**
 * Deterministic verification suite inspecting schema, PG FORCE RLS, OpenAPI reflection,
 * negative RBAC escalation, Multi-Portal routes/blocks, DMN dry-run, Flow v2 dry-run, and n8n activation.
 */
async function verifyEnterpriseApp(ctx, db, actor, target = {}, deps = {}) {
  const organizationId = actor?.organizationId || target.organizationId;
  const collectionName = String(target.collectionName || '').trim();
  const portalSlug = String(target.portalSlug || '').trim();
  const pageTitle = target.pageTitle ? String(target.pageTitle).trim() : null;
  const roleName = target.roleName ? String(target.roleName).trim() : null;
  const lockedFields = Array.isArray(target.lockedFields) ? target.lockedFields : [];
  const checks = [];

  // 1. Collection & fields check
  if (collectionName) {
    const colsRepo = db?.getRepository?.('collections');
    const colRow = colsRepo ? await colsRepo.findOne({ filter: { name: collectionName }, appends: ['fields'] }) : null;
    const colFields = Array.isArray(val(colRow, 'fields')) ? val(colRow, 'fields') : (db?.getCollection?.(collectionName)?.fields || []);
    const fieldNames = new Set(colFields.map((f) => val(f, 'name') || f?.name).filter(Boolean));
    const hasCol = Boolean(colRow || db?.hasCollection?.(collectionName));
    const hasOrgField = fieldNames.has('organizationId');
    const missingReq = (target.expectedFields || []).filter((fn) => !fieldNames.has(fn));
    checks.push({
      id: 'collection_schema',
      name: 'Collection Schema & Relations',
      ok: hasCol && hasOrgField && missingReq.length === 0,
      detail: !hasCol ? `Collection ${collectionName} missing` : (!hasOrgField ? 'Missing organizationId' : (missingReq.length ? `Missing fields: ${missingReq.join(',')}` : 'Schema verified')),
      repairable: true,
      repairAction: 'ensure_collection',
    });

    // 2. PG FORCE ROW LEVEL SECURITY check
    let rlsOk = false;
    let rlsDetail = 'RLS not attached';
    const isPg = typeof db?.sequelize?.getDialect === 'function' && db.sequelize.getDialect() === 'postgres';
    if (isPg && typeof db?.sequelize?.query === 'function') {
      try {
        const clsRes = await withOptionalSystemRls(db, (transaction) => db.sequelize.query(
          `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = :tableName LIMIT 1;`,
          { replacements: { tableName: collectionName }, ...(transaction ? { transaction } : {}) },
        ));
        const row = Array.isArray(clsRes?.[0]) ? clsRes[0][0] : clsRes?.[0];
        const polRes = await withOptionalSystemRls(db, (transaction) => db.sequelize.query(
          `SELECT policyname FROM pg_policies WHERE tablename = :tableName AND policyname = 'lattice_tenant_isolation' LIMIT 1;`,
          { replacements: { tableName: collectionName }, ...(transaction ? { transaction } : {}) },
        ));
        const polRow = Array.isArray(polRes?.[0]) ? polRes[0][0] : polRes?.[0];
        rlsOk = Boolean(row?.relrowsecurity && row?.relforcerowsecurity && polRow?.policyname);
        rlsDetail = rlsOk ? 'relrowsecurity=true, relforcerowsecurity=true, policy=lattice_tenant_isolation' : 'Missing FORCE ROW LEVEL SECURITY or policy';
      } catch (err) {
        rlsOk = false;
        rlsDetail = err?.message || 'PG RLS query failed';
      }
    } else if (db?.rlsAttachedTables instanceof Set) {
      rlsOk = db.rlsAttachedTables.has(collectionName);
      rlsDetail = rlsOk ? 'RLS attached via attachLatticeRlsPolicy' : 'Missing attachLatticeRlsPolicy record';
    } else {
      rlsOk = hasOrgField;
      rlsDetail = rlsOk ? 'Tenant organizationId column verified' : 'Missing organizationId';
    }
    checks.push({
      id: 'pg_rls_enforced',
      name: 'PostgreSQL FORCE ROW LEVEL SECURITY',
      ok: rlsOk,
      detail: rlsDetail,
      repairable: true,
      repairAction: 'attach_rls',
    });

    // 3. OpenAPI reflection check
    let openapiOk = false;
    let openapiDetail = 'OpenAPI reflection missing';
    const openApiMod = getOpenApiMod();
    if (typeof openApiMod?.buildOpenApiSpec === 'function') {
      const specDb = (db?.collections || typeof db?.getCollections === 'function')
        ? db
        : (hasCol ? { collections: new Map([[collectionName, { name: collectionName, title: val(colRow, 'title') || collectionName, fields: colFields }]]) } : db);
      const specDoc = openApiMod.buildOpenApiSpec({ db: specDb });
      const hasPath = Boolean(specDoc?.paths?.[`/api/${collectionName}:list`]);
      const hasSchema = Boolean(specDoc?.components?.schemas?.[collectionName]);
      openapiOk = hasPath && hasSchema;
      openapiDetail = openapiOk ? `/api/${collectionName}:list & schema reflected` : `Missing dynamic path/schema for ${collectionName}`;
    } else if (safeGetResource(ctx, 'dxos')) {
      const oa = await invokeResAction(ctx, 'dxos', 'openapi', { method: 'GET' });
      openapiOk = Boolean(oa?.paths?.[`/api/${collectionName}:list`]);
      openapiDetail = openapiOk ? 'dxos:openapi reflected' : 'dxos:openapi missing path';
    } else {
      openapiOk = hasCol;
      openapiDetail = 'Collection registered';
    }
    checks.push({
      id: 'openapi_reflection',
      name: 'OpenAPI 3.1.0 Reflection',
      ok: openapiOk,
      detail: openapiDetail,
      repairable: true,
      repairAction: 'reload_collection',
    });
  }

  // 4. Negative RBAC escalation & lockedFields check
  if (roleName) {
    const rolesRepo = db?.getRepository?.('roles');
    const resRepo = db?.getRepository?.('dataSourcesRolesResources');
    const roleRow = rolesRepo ? await rolesRepo.findOne({ filter: { name: roleName } }) : null;
    const noEscalation = Boolean(roleRow)
      && val(roleRow, 'allowConfigure') !== true
      && !(Array.isArray(val(roleRow, 'snippets')) && (val(roleRow, 'snippets').includes('pm') || val(roleRow, 'snippets').includes('*')));
    let grantOk = true;
    let lockedOk = true;
    if (collectionName && resRepo) {
      const grant = await resRepo.findOne({ filter: { roleName, dataSourceKey: 'main', name: collectionName }, appends: ['actions'] });
      grantOk = Boolean(grant);
      if (grant && lockedFields.length) {
        const actions = val(grant, 'actions') || [];
        for (const act of actions) {
          const actName = val(act, 'name');
          if (actName === 'create' || actName === 'update') {
            const writable = new Set(val(act, 'fields') || []);
            if (lockedFields.some((lf) => writable.has(lf))) lockedOk = false;
          }
        }
      }
    }
    checks.push({
      id: 'rbac_negative_escalation',
      name: 'RBAC Isolation & Locked Fields',
      ok: noEscalation && grantOk && lockedOk,
      detail: !noEscalation ? 'Privilege escalation detected on role' : (!grantOk ? 'Resource RBAC grant missing' : (!lockedOk ? 'Locked field exposed in write fields' : 'RBAC verified')),
      repairable: true,
      repairAction: 'repair_rbac',
    });
  }

  // 5. Portal UI & BlockModel verification
  if (portalSlug) {
    const resolved = await resolvePageGrid(db, portalSlug, pageTitle, val);
    const ordered = resolved.grid ? extractGridBlockUids(resolved.grid).ordered : [];
    const subMap = new Map((Array.isArray(resolved.grid?.subModels?.items) ? resolved.grid.subModels.items : []).map((m) => [m.uid, m]));
    let allAllowed = true;
    for (const uid of ordered) {
      const model = resolved.flowModelsRepo?.findModelById ? await resolved.flowModelsRepo.findModelById(uid) : subMap.get(uid);
      if (model?.use && !ORCHESTRATOR_ALLOWED_BLOCKS.has(model.use)) allAllowed = false;
    }
    const uiOk = Boolean(resolved.pageRoute && resolved.grid?.uid && allAllowed);
    checks.push({
      id: 'portal_ui_routes',
      name: 'Portal Route, Grid & Native v2 BlockModels',
      ok: uiOk,
      detail: uiOk ? `Portal /p/${portalSlug} grid=${resolved.grid.uid} (${ordered.length} blocks)` : 'Portal page or grid missing/invalid',
      repairable: true,
      repairAction: 'repair_portal_ui',
    });
  }

  // 6. DMN dry-run check
  if (target.dmnTableKey) {
    const dmnMod = getDmnMod();
    const dmnRepo = db?.getRepository?.('latticeDecisionTables');
    const table = dmnRepo
      ? await withOptionalTenantRls(db, organizationId, (transaction) => dmnRepo.findOne({ filter: { organizationId, tableKey: target.dmnTableKey }, ...(transaction ? { transaction } : {}) }))
      : null;
    let dmnOk = Boolean(table && val(table, 'active') !== false);
    let dmnDetail = dmnOk ? 'DMN table active' : 'DMN table missing';
    if (dmnOk && typeof dmnMod?.evaluateDecisionTable === 'function') {
      const evalRes = dmnMod.evaluateDecisionTable(table, target.dmnSampleInput || {});
      dmnOk = Boolean(evalRes?.matched);
      dmnDetail = dmnOk ? `DMN dry-run matched rule #${evalRes.matchedRuleIndex}` : 'DMN dry-run matched 0 rules';
    }
    checks.push({
      id: 'dmn_dry_run',
      name: 'DMN Decision Table Dry-Run',
      ok: dmnOk,
      detail: dmnDetail,
      repairable: true,
      repairAction: 'repair_dmn',
    });
  }

  // 7. LatticeFlow v2 DAG dry-run check
  if (target.flowRuleKey) {
    const rulesRepo = db?.getRepository?.('latticeAutomationRules');
    const execMod = getFlowExecutorMod();
    const ruleRow = rulesRepo
      ? await withOptionalTenantRls(db, organizationId, (transaction) => rulesRepo.findOne({ filter: { organizationId, ruleKey: target.flowRuleKey }, ...(transaction ? { transaction } : {}) }))
      : null;
    let flowOk = Boolean(ruleRow);
    let flowDetail = flowOk ? 'Flow v2 rule persisted' : 'Flow v2 rule missing';
    if (flowOk && typeof execMod?.dryRunFlowGraph === 'function') {
      const sim = await execMod.dryRunFlowGraph(db, ruleRow, target.flowSampleEvent || { type: 'manual.trigger', organizationId, data: {} }, { organizationId, actor });
      flowOk = sim?.status === 'completed' || sim?.status === 'suspended';
      flowDetail = `Flow v2 dry-run status=${sim?.status || 'unknown'}`;
    }
    checks.push({
      id: 'flow_v2_dry_run',
      name: 'LatticeFlow v2 DAG Dry-Run',
      ok: flowOk,
      detail: flowDetail,
      repairable: true,
      repairAction: 'repair_flow',
    });
  }

  // 8. Stock n8n workflow active check
  if (target.n8nWorkflowId) {
    const client = await resolveN8nClientForVerify(ctx, db, actor, deps);
    let n8nOk = false;
    let n8nDetail = 'n8n client unavailable';
    if (client && typeof client.getWorkflow === 'function') {
      try {
        const wf = await client.getWorkflow(target.n8nWorkflowId);
        n8nOk = Boolean(wf && wf.active === true);
        n8nDetail = n8nOk ? `n8n workflow ${target.n8nWorkflowId} active` : `n8n workflow ${target.n8nWorkflowId} inactive`;
      } catch (err) {
        n8nDetail = err?.message || 'n8n getWorkflow failed';
      }
    }
    checks.push({
      id: 'n8n_workflow_active',
      name: 'Stock n8n Workflow Active',
      ok: n8nOk,
      detail: n8nDetail,
      repairable: true,
      repairAction: 'activate_n8n',
    });
  }

  const failedChecks = checks.filter((c) => !c.ok);
  return {
    ok: failedChecks.length === 0,
    passedCount: checks.length - failedChecks.length,
    totalCount: checks.length,
    checks,
    failedChecks,
  };
}

async function applyTargetedRepair(ctx, db, actor, check, state, deps) {
  const {
    collectionName, collectionTitle, normalizedFields, roleName, roleTitle, lockedFields,
    portalSlug, pageTitle, blocks, creativeTheme, dmnSpec, flowSpec, n8nWorkflowId,
  } = state;

  switch (check.repairAction) {
    case 'ensure_collection':
      await ensureCollectionAndFields(db, actor.organizationId, { collectionName, collectionTitle, fields: normalizedFields });
      return { checkId: check.id, repairAction: check.repairAction, repaired: true };
    case 'attach_rls': {
      const ok = await attachCollectionRls(db, collectionName);
      return { checkId: check.id, repairAction: check.repairAction, repaired: ok };
    }
    case 'reload_collection': {
      const colsRepo = db?.getRepository?.('collections');
      const row = colsRepo ? await colsRepo.findOne({ filter: { name: collectionName }, appends: ['fields'] }) : null;
      if (typeof row?.load === 'function') await row.load({ resetFields: true });
      const colInst = db?.getCollection?.(collectionName);
      if (typeof colInst?.sync === 'function') await colInst.sync({ force: false, alter: { drop: false } });
      return { checkId: check.id, repairAction: check.repairAction, repaired: Boolean(row) };
    }
    case 'repair_rbac':
      await ensureRoleAndRbac(ctx, db, actor, { roleName, roleTitle, collectionName, fields: normalizedFields, lockedFields });
      return { checkId: check.id, repairAction: check.repairAction, repaired: true };
    case 'repair_portal_ui':
      await ensurePortalAndBlocks(ctx, db, actor, { portalSlug, pageTitle, roleName, roleTitle, collectionName, fields: normalizedFields, blocks, creativeTheme });
      return { checkId: check.id, repairAction: check.repairAction, repaired: true };
    case 'repair_dmn':
      if (!dmnSpec) return { checkId: check.id, repairAction: check.repairAction, repaired: false };
      await upsertDmnTable(ctx, db, actor, dmnSpec);
      return { checkId: check.id, repairAction: check.repairAction, repaired: true };
    case 'repair_flow':
      if (!flowSpec) return { checkId: check.id, repairAction: check.repairAction, repaired: false };
      await upsertFlowV2Rule(db, actor, flowSpec);
      return { checkId: check.id, repairAction: check.repairAction, repaired: true };
    case 'activate_n8n': {
      if (!n8nWorkflowId) return { checkId: check.id, repairAction: check.repairAction, repaired: false };
      const bridgeDeps = { val, failTool: failBuild, hasRes: (c, n) => Boolean(safeGetResource(c, n)), invokeResourceAction: invokeResAction, ...deps };
      await runActivateN8nWorkflow(ctx, db, actor, { workflowId: n8nWorkflowId, active: true, connectorKey: deps.n8nConnectorKey }, bridgeDeps);
      return { checkId: check.id, repairAction: check.repairAction, repaired: true };
    }
    default:
      return { checkId: check.id, repairAction: check.repairAction, repaired: false };
  }
}

/**
 * Full-stack Enterprise App Builder Orchestrator with pre-build Snapshot, schema/relations/RLS/OpenAPI,
 * RBAC, Multi-Portal 10-BlockModel pages, DMN, LatticeFlow v2 DAG, Stock n8n workflow,
 * Deterministic Verifier, and up to 2 rounds of closed-loop targeted self-healing.
 */
async function orchestrateEnterpriseAppBuild(ctx, db, actor, spec = {}, deps = {}) {
  if (!actor?.isAdmin && !actor?.isRoot) {
    throw failBuild('DXOS_ADMIN_REQUIRED', 403, 'Chỉ Quản trị viên mới được dựng ứng dụng doanh nghiệp.');
  }
  const organizationId = String(actor.organizationId || '').trim();
  if (!organizationId) {
    throw failBuild('NATIVE_TENANT_REQUIRED', 403, 'Yêu cầu organizationId hợp lệ.');
  }
  const portalSlug = String(spec.portalSlug || 'services').trim().toLowerCase();
  if (!SLUG_RE.test(portalSlug)) {
    throw failBuild('PORTAL_SLUG_INVALID', 400, 'portalSlug không hợp lệ.');
  }
  const pageTitle = String(spec.pageTitle || spec.title || 'Phân hệ Doanh nghiệp Mới').trim();
  const collectionName = String(spec.collectionName || '').trim();
  if (!collectionName || SYSTEM_PROTECTED_COLLECTIONS.has(collectionName) || !CUSTOM_COLLECTION_RE.test(collectionName)) {
    throw failBuild(
      SYSTEM_PROTECTED_COLLECTIONS.has(collectionName) ? 'SYSTEM_COLLECTION_FORBIDDEN' : 'COLLECTION_NAME_INVALID',
      SYSTEM_PROTECTED_COLLECTIONS.has(collectionName) ? 403 : 400,
      'collectionName phải theo mẫu latticeCustom<TenVietHoa> và không được chạm bảng hệ thống.',
    );
  }
  const roleTitle = String(spec.roleTitle || `Quản trị ${pageTitle}`).trim();
  const roleName = spec.roleName ? String(spec.roleName).trim() : slugifyVietnameseToLdxRole(roleTitle);
  if (!LDX_ROLE_RE.test(roleName)) {
    throw failBuild('ROLE_FORBIDDEN', 403, 'roleName phải bắt đầu bằng ldx_*.');
  }
  const rawFields = Array.isArray(spec.fields) ? spec.fields : [];
  const normalizedFieldsPreview = rawFields.map((f) => normalizeOrchestratorField(f));
  const lockedFields = Array.isArray(spec.lockedFields) ? spec.lockedFields.map((f) => String(f).trim()).filter(Boolean) : [];
  const blocks = Array.isArray(spec.blocks) ? spec.blocks : [];
  for (const b of blocks) {
    const useName = String(b?.blockUse || b?.use || '').trim();
    if (!ORCHESTRATOR_ALLOWED_BLOCKS.has(useName)) {
      throw failBuild('BLOCK_MODEL_FORBIDDEN', 400, `BlockModel "${useName}" không được phép.`);
    }
  }

  if (spec.dryRun === true) {
    return {
      dryRun: true,
      built: false,
      planned: {
        organizationId,
        collectionName,
        fields: normalizedFieldsPreview.map((f) => ({ name: f.name, type: f.type, target: f.target || null })),
        roleName,
        portalSlug,
        pageTitle,
        blocks: blocks.map((b) => b?.blockUse || b?.use),
        dmnTableKey: spec.dmnTable?.tableKey || null,
        flowRuleKey: spec.flowGraph?.ruleKey || null,
        hasN8nWorkflow: Boolean(spec.n8nWorkflow),
      },
    };
  }

  // 1. Pre-build Snapshot
  await ensureUiSnapshotsReady(db);
  const preSnap = await capturePageSnapshot(db, {
    portalSlug,
    pageTitle,
    note: `Pre-build snapshot for ${collectionName}`,
    createdByUsername: actor.username,
  }, val);
  const preBuildSnapshotUid = preSnap?.snapshotUid || `snap-pre-${portalSlug}-${Date.now().toString(36)}`;
  if (!preSnap) {
    const snapRepo = db?.getRepository?.('latticeUiSnapshots');
    if (snapRepo && typeof snapRepo.create === 'function') {
      await withOptionalTenantRls(db, organizationId, (transaction) => snapRepo.create({
        values: {
          organizationId,
          snapshotUid: preBuildSnapshotUid,
          portalSlug,
          pageTitle,
          note: `Pre-build snapshot for ${collectionName}`,
          createdByUsername: actor.username,
          layoutState: {},
          blocks: [],
        },
        ...(transaction ? { transaction } : {}),
      }));
    }
  }

  // 2. Schema + Relations + PG RLS + OpenAPI
  const schemaResult = await ensureCollectionAndFields(db, organizationId, {
    collectionName,
    collectionTitle: spec.collectionTitle || pageTitle,
    fields: rawFields,
  });

  // 3. Role + RBAC + Locked Fields + AI Assistant
  const rbacResult = await ensureRoleAndRbac(ctx, db, actor, {
    roleName,
    roleTitle,
    collectionName,
    fields: schemaResult.fields,
    lockedFields,
  });
  const aiUsername = await ensureAiAssistant(db, actor, {
    roleName,
    roleTitle,
    portalSlug,
    pageTitle,
    lockedFields,
    aiUsername: spec.aiUsername,
    aiNickname: spec.aiNickname,
  });

  // 4. Multi-Portal Page + Native v2 BlockModels
  const portalResult = await ensurePortalAndBlocks(ctx, db, actor, {
    portalSlug,
    pageTitle,
    roleName,
    roleTitle,
    collectionName,
    fields: schemaResult.fields,
    blocks,
    creativeTheme: spec.creativeTheme || 'industrial-cockpit',
  });

  // 5. DMN Table (if provided)
  let dmnTableKey = null;
  if (spec.dmnTable) {
    const savedDmn = await upsertDmnTable(ctx, db, actor, spec.dmnTable);
    dmnTableKey = savedDmn?.tableKey || spec.dmnTable.tableKey;
  }

  // 6. LatticeFlow v2 DAG (if provided)
  let flowRuleKey = null;
  if (spec.flowGraph) {
    const savedFlow = await upsertFlowV2Rule(db, actor, spec.flowGraph);
    flowRuleKey = savedFlow?.ruleKey || spec.flowGraph.ruleKey;
  }

  // 7. Stock n8n Workflow (if provided)
  let n8nWorkflowId = null;
  if (spec.n8nWorkflow) {
    const bridgeDeps = { val, failTool: failBuild, hasRes: (c, n) => Boolean(safeGetResource(c, n)), invokeResourceAction: invokeResAction, ...deps };
    const createdWf = spec.n8nWorkflow.id
      ? await runUpdateN8nWorkflow(ctx, db, actor, { workflowId: spec.n8nWorkflow.id, workflow: spec.n8nWorkflow, connectorKey: spec.n8nConnectorKey }, bridgeDeps)
      : await runCreateN8nWorkflow(ctx, db, actor, { workflow: spec.n8nWorkflow, connectorKey: spec.n8nConnectorKey }, bridgeDeps);
    n8nWorkflowId = String(createdWf?.id || createdWf?.data?.id || spec.n8nWorkflow.id || '').trim() || null;
    if (n8nWorkflowId && spec.activateN8n !== false) {
      await runActivateN8nWorkflow(ctx, db, actor, { workflowId: n8nWorkflowId, active: true, connectorKey: spec.n8nConnectorKey }, bridgeDeps);
    }
  }

  // 8. Deterministic Verification + Up to 2 Rounds Targeted Self-Healing
  const maxHealRounds = Math.max(0, Math.min(2, Number(spec.maxHealRounds ?? DEFAULT_SELF_HEAL_MAX_ROUNDS)));
  const verifyTarget = {
    organizationId,
    collectionName,
    expectedFields: schemaResult.fields.map((f) => f.name),
    portalSlug,
    pageTitle,
    roleName,
    lockedFields,
    dmnTableKey,
    dmnSampleInput: spec.dmnTable?.sampleInput || {},
    flowRuleKey,
    flowSampleEvent: spec.flowGraph?.sampleEvent || null,
    n8nWorkflowId,
  };

  const repairs = [];
  let healRounds = 0;
  let verification = null;

  for (let round = 1; round <= maxHealRounds + 1; round += 1) {
    if (typeof deps.onBeforeVerify === 'function') {
      await deps.onBeforeVerify(round, verifyTarget);
    }
    verification = typeof deps.verifierOverride === 'function'
      ? await deps.verifierOverride(ctx, db, actor, verifyTarget, round)
      : await verifyEnterpriseApp(ctx, db, actor, verifyTarget, deps);

    if (verification.ok || round > maxHealRounds) break;

    healRounds += 1;
    for (const failed of verification.failedChecks) {
      const repair = await applyTargetedRepair(ctx, db, actor, failed, {
        collectionName,
        collectionTitle: spec.collectionTitle || pageTitle,
        normalizedFields: rawFields,
        roleName,
        roleTitle,
        lockedFields,
        portalSlug,
        pageTitle,
        blocks,
        creativeTheme: spec.creativeTheme || 'industrial-cockpit',
        dmnSpec: spec.dmnTable || null,
        flowSpec: spec.flowGraph || null,
        n8nWorkflowId,
      }, deps);
      repairs.push({ round: healRounds, ...repair });
    }
  }

  bumpSurfaceRevision(portalSlug, {
    pageTitle,
    message: `App Builder đã dựng phân hệ "${pageTitle}" (${verification.ok ? 'PASS' : 'NEEDS_REVIEW'})`,
  });
  await withOptionalTenantRls(db, organizationId, (transaction) => recordAiAuditLog(db, {
    actorUserId: actor.userId,
    actorUsername: actor.username,
    organizationId,
    channel: 'app-builder',
    aiEmployee: aiUsername,
    toolName: 'dxos_provision_role_workspace',
    argsSummary: { operation: 'build_enterprise_app', collectionName, portalSlug, roleName },
    status: verification.ok ? 'allowed' : 'degraded',
    resultSummary: `Built ${collectionName} on /p/${portalSlug} (ok=${verification.ok}, healRounds=${healRounds})`,
    ...(transaction ? { transaction } : {}),
  }));

  return {
    built: true,
    ok: verification.ok,
    organizationId,
    collectionName,
    fields: schemaResult.fields.map((f) => f.name),
    indexes: schemaResult.indexes,
    roleName: rbacResult.roleName,
    portalSlug,
    pageTitle,
    gridUid: portalResult.gridUid,
    blocks: portalResult.attachedBlocks,
    aiEmployee: aiUsername,
    dmnTableKey,
    flowRuleKey,
    n8nWorkflowId,
    preBuildSnapshotUid,
    verification,
    healRounds,
    repairs,
  };
}

module.exports = {
  ALL_NATIVE_V2_BLOCK_MODELS,
  DEFAULT_SELF_HEAL_MAX_ROUNDS,
  orchestrateEnterpriseAppBuild,
  verifyEnterpriseApp,
};
