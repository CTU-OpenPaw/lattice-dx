/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { timingSafeEqual } = require('node:crypto');
const {
  ingestTelemetryPoint,
  ingestOrDeduplicateAlarm,
  acknowledgeAlarm,
  clearAlarm,
  queryTelemetryTimeSeries,
} = require('./alarm-engine');
const { executeGovernedExport, assertSafeFilter, SENSITIVE_EXPORT_FIELDS } = require('./governed-export');
const {
  getTwinShadow,
  requestDesiredSetpoint,
  ackCommandFromEdge,
} = require('./digital-twin');
const {
  ALLOWED_IMPORT_COLLECTIONS,
  OPTIONAL_IMPORT_COLLECTIONS,
  runBulkImportDryRun,
  commitBulkImport,
} = require('./bulk-import');
const { runWithOptionalRls } = require('./blocks-rls');

const ALLOWED_PROPOSAL_COLLECTIONS = new Set([
  'latticeAssets',
  'latticeRequests',
  'latticeOrders',
  'latticeIncidentCases',
  'latticeServiceTickets',
]);
const PROPOSAL_STATES = new Set(['all', 'proposed', 'reviewed']);
const ORG_ID_RE = /^[a-zA-Z0-9_-]{1,80}$/;
const URN_RE = /^urn:ngsi-ld:Asset:([a-zA-Z0-9_-]{1,80}):native:([1-9]\d{0,18})$/;
const MIN_EDGE_TOKEN_LENGTH = 16;
const CUSTOM_COLLECTION_RE = /^latticeCustom[A-Z][A-Za-z0-9]{1,40}$/;
const SAFE_COLLECTION_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{1,63}$/;
const META_ALLOWED_BUSINESS_COLLECTIONS = new Set([
  'latticeOrders',
  'latticeOrderLines',
  'latticeRequests',
  'latticeServiceTickets',
  'latticeStockLots',
  'latticeAssets',
  'latticeLocations',
  'latticeDepartments',
  'latticeIncidentCases',
  'latticeParaDocuments',
  'latticeAgentProposals',
  'latticeEpodRecords',
]);
const META_EXCLUDED_COLLECTIONS = new Set([
  'users', 'roles', 'rolesUsers', 'apiKeys', 'authenticators', 'migrations',
  'applicationPlugins', 'applicationTokens', 'sessions', 'verification', 'auditLogs',
  'aiSettings', 'aiEmployees', 'aiMcpClients', 'rolesAiEmployees',
  'latticeAiAuditLogs', 'latticeAiProfiles', 'latticeAiQuotaUsage', 'latticeAiApprovalQueue',
  'latticeUiSnapshots', 'latticeBuiltApps',
  'latticeApiKeys', 'latticePkiKeys', 'latticeConnectors',
  'latticeWebhookSubscriptions', 'latticeWebhookDeliveries', 'latticeCryptoLedger',
  'latticeEventBus', 'latticeDataLineage', 'latticeFrozenSnapshots', 'latticeRecordChatter',
  'latticeDelegations', 'latticeAutomationRules', 'latticeAutomationRuns',
  'latticeDecisionTables', 'latticeOrganizations', 'latticeApps', 'latticePortals',
  'latticeEmployees', 'latticeIncidentRules',
  'dataSources', 'dataSourcesCollections', 'dataSourcesRoles', 'dataSourcesRolesResources',
  'dataSourcesRolesResourcesActions', 'dataSourcesRolesResourcesScopes',
  'llmServices', 'rolesDesktopRoutes', 'desktopRoutes', 'uiLayouts', 'uiSchemas', 'uiSchemaTemplates',
  'workflows', 'flow_nodes', 'flowModels', 'workflowManualTasks', 'executions', 'jobs', 'users_jobs',
  'collections', 'fields', 'collectionCategories', 'systemSettings', 'storages', 'attachments',
  'latticeNotifications', 'latticeSlaPolicies', 'latticeParaChunks',
  'latticeTelemetryPoints', 'latticeTwinShadows', 'latticeIotDevices', 'latticeBrokerSubscriptions',
  'latticeContextOutbox', 'latticeDataQuarantine',
]);
const META_EXCLUDED_LOWER = new Set([...META_EXCLUDED_COLLECTIONS].map((c) => c.toLowerCase()));
const META_SENSITIVE_FIELD_RE = /password|secret|token|apikey|api_key|privatekey|hash|salt|embedding|searchvector/i;
const META_BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isValidOrganizationId(raw) {
  if (typeof raw !== 'string') return false;
  const clean = raw.trim();
  if (!clean) return false;
  const lower = clean.toLowerCase();
  if (lower === 'all' || META_BLOCKED_KEYS.has(lower)) return false;
  return ORG_ID_RE.test(clean);
}

function parseOptionalRootOrgId(raw, code = 'DXOS_ORG_REQUIRED', message = 'organizationId không hợp lệ.') {
  if (raw === undefined || raw === null) return null;
  const clean = typeof raw === 'string' ? raw.trim() : String(raw).trim();
  if (!clean) return null;
  if (!isValidOrganizationId(clean)) {
    throw fail(code, 400, message);
  }
  return clean;
}

function fail(code, status = 403, message = code) {
  return Object.assign(new Error(message), { code, status });
}

const val = (row, key) => (typeof row?.get === 'function' ? row.get(key) : row?.[key]);

function readParams(ctx) {
  const p = ctx.action?.params || {};
  const v = p.values && typeof p.values === 'object' && !Array.isArray(p.values) ? p.values : {};
  return { ...p, ...v };
}

function parseOptionalNumber(raw, code, { min = 0 } = {}) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw === 'boolean' || typeof raw === 'object') throw fail(code, 400);
  if (typeof raw === 'string' && raw.trim() === '') throw fail(code, 400);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min) throw fail(code, 400);
  return parsed;
}

function readHeader(ctx, name) {
  if (typeof ctx?.get === 'function') {
    const v = ctx.get(name);
    if (typeof v === 'string' && v) return v;
  }
  const lower = String(name || '').toLowerCase();
  for (const hdrs of [ctx?.headers, ctx?.request?.headers]) {
    if (!hdrs || typeof hdrs !== 'object') continue;
    for (const [k, v] of Object.entries(hdrs)) {
      if (k.toLowerCase() === lower && typeof v === 'string' && v) return v;
    }
  }
  return '';
}

async function resolvePublicRouteJwtUser(db, ctx) {
  let user = null;
  if (typeof ctx?.auth?.check === 'function') {
    try {
      const checked = await ctx.auth.check();
      user = checked || ctx.auth?.user || ctx.state?.currentUser || null;
    } catch {
      throw fail('NATIVE_LOGIN_REQUIRED', 401);
    }
  } else if (typeof ctx?.app?.authManager?.get === 'function') {
    const authenticatorName =
      readHeader(ctx, 'X-Authenticator').trim() ||
      String(ctx.app.authManager.defaultAuthenticator || 'basic');
    try {
      const authenticator = await ctx.app.authManager.get(authenticatorName, ctx);
      if (authenticator && typeof authenticator.check === 'function') {
        user = (await authenticator.check(ctx)) || null;
      }
    } catch {
      throw fail('NATIVE_LOGIN_REQUIRED', 401);
    }
  }
  if (!val(user, 'id')) {
    throw fail('NATIVE_LOGIN_REQUIRED', 401);
  }
  ctx.auth = ctx.auth || {};
  ctx.auth.user = user;
  ctx.state = ctx.state || {};
  ctx.state.currentUser = user;

  const userId = val(user, 'id');
  const verifiedRoles = [];
  let defaultRole = '';
  const rolesUsersRepo = db?.getRepository?.('rolesUsers');
  if (rolesUsersRepo && typeof rolesUsersRepo.find === 'function') {
    const rows = (await rolesUsersRepo.find({ filter: { userId }, limit: 50 })) || [];
    for (const row of rows) {
      const roleName = String(val(row, 'roleName') || '').trim();
      if (!roleName) continue;
      if (!verifiedRoles.includes(roleName)) verifiedRoles.push(roleName);
      if (val(row, 'default') === true && !defaultRole) defaultRole = roleName;
    }
  } else if (typeof user?.getRoles === 'function') {
    const roles = (await user.getRoles()) || [];
    for (const row of roles) {
      const roleName = String(val(row, 'name') || val(row, 'roleName') || '').trim();
      if (!roleName) continue;
      if (!verifiedRoles.includes(roleName)) verifiedRoles.push(roleName);
      if (val(row, 'RolesUsers')?.default === true && !defaultRole) defaultRole = roleName;
    }
  }

  const requestedRole = readHeader(ctx, 'X-Role').trim();
  const resolvedRole =
    requestedRole && verifiedRoles.includes(requestedRole)
      ? requestedRole
      : defaultRole || verifiedRoles[0] || '';
  ctx.state.currentRole = resolvedRole;
  return resolvedRole;
}

async function resolveTelemetryIngestAuth(db, ctx, input = {}, { ingestToken } = {}) {
  const providedToken = readHeader(ctx, 'X-Lattice-Edge-Token').trim();
  const rawEnvToken = ingestToken !== undefined ? ingestToken : process.env.DX_IIOT_INGEST_TOKEN;
  const expectedToken = typeof rawEnvToken === 'string' ? rawEnvToken.trim() : '';
  const hadPreResolvedUser = Boolean(ctx.state?.currentUser?.id);

  if (!providedToken && !hadPreResolvedUser) {
    await resolvePublicRouteJwtUser(db, ctx);
  }

  let auth;
  if (providedToken) {
    if (expectedToken.length < MIN_EDGE_TOKEN_LENGTH) {
      throw fail('TELEMETRY_EDGE_AUTH_INVALID', 401, 'Token IIoT edge chưa được cấu hình hợp lệ.');
    }
    const expectedBuf = Buffer.from(expectedToken, 'utf8');
    const providedBuf = Buffer.from(providedToken, 'utf8');
    if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
      throw fail('TELEMETRY_EDGE_AUTH_INVALID', 401, 'Token IIoT edge không khớp.');
    }
    const orgId = typeof input.organizationId === 'string' ? input.organizationId.trim() : '';
    if (!isValidOrganizationId(orgId)) {
      throw fail('TELEMETRY_ORG_REQUIRED', 400, 'Cần organizationId hợp lệ cho điểm đo IIoT.');
    }
    auth = { mode: 'edge-token', organizationId: orgId, isRoot: false, actor: null };
  } else if (!ctx.state?.currentUser?.id && ctx.state?.currentRole !== 'root') {
    throw fail('NATIVE_LOGIN_REQUIRED', 401);
  } else if (ctx.state?.currentRole === 'root') {
    if (!ctx.state?.currentUser) throw fail('NATIVE_LOGIN_REQUIRED', 401);
    const orgId = typeof input.organizationId === 'string' ? input.organizationId.trim() : '';
    if (!isValidOrganizationId(orgId)) {
      throw fail('TELEMETRY_ORG_REQUIRED', 400, 'Cần organizationId hợp lệ cho điểm đo IIoT.');
    }
    auth = { mode: 'root', organizationId: orgId, isRoot: true, actor: null };
  } else {
    const actor = await resolveNativeEmployee(db, ctx.state.currentUser);
    const aclCtx = hadPreResolvedUser ? ctx : { ...ctx, can: undefined };
    const [canCreateIncident, canUpdateAsset] = await Promise.all([
      hasViewPermission(db, aclCtx, 'latticeIncidentCases', 'create'),
      hasViewPermission(db, aclCtx, 'latticeAssets', 'update'),
    ]);
    if (!canCreateIncident && !canUpdateAsset) {
      throw fail('DXOS_ACL_DENIED', 403);
    }
    if (input.organizationId !== undefined && input.organizationId !== null && String(input.organizationId).trim() !== '' && String(input.organizationId).trim() !== actor.organizationId) {
      throw fail('DXOS_CROSS_ORG_FORBIDDEN', 403);
    }
    auth = { mode: 'user', organizationId: actor.organizationId, isRoot: false, actor };
  }

  const entityUrn = typeof input.assetEntityId === 'string' ? URN_RE.exec(input.assetEntityId.trim()) : null;
  if (entityUrn && entityUrn[1] !== auth.organizationId) {
    throw fail('DXOS_CROSS_ORG_FORBIDDEN', 403);
  }
  return auth;
}

function normalizeBrokerOrigin(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

async function resolveNativeEmployee(db, user) {
  const id = val(user, 'id');
  if (id == null || !/^[1-9]\d*$/.test(String(id))) throw fail('NATIVE_LOGIN_REQUIRED', 401);
  const repo = db.getRepository('latticeEmployees');
  if (!repo) throw fail('NATIVE_MEMBERSHIP_REQUIRED', 403);
  const rows = await runWithOptionalRls(db, null, (transaction) =>
    repo.find({ filter: { userId: id }, limit: 2, ...(transaction ? { transaction } : {}) }),
  );
  if (rows.length > 1) throw fail('NATIVE_MEMBERSHIP_AMBIGUOUS', 403);
  const emp = rows[0];
  if (!emp || val(emp, 'active') !== true) throw fail('NATIVE_MEMBERSHIP_REQUIRED', 403);
  const organizationId = val(emp, 'organizationId');
  if (!isValidOrganizationId(organizationId)) {
    throw fail('NATIVE_MEMBERSHIP_INVALID', 403);
  }
  return { userId: String(id), employeeId: val(emp, 'id'), organizationId };
}

async function hasViewPermission(db, ctx, collection, action = 'view') {
  const candidates = action === 'view' ? ['view', 'list'] : [action];
  if (typeof ctx.can === 'function') {
    return candidates.some((act) => ctx.can({ resource: collection, action: act }));
  }
  const roleName = ctx.state?.currentRole;
  if (!roleName) return false;
  const role = await db.getRepository('roles')?.findOne({ filter: { name: roleName } });
  if (val(role, 'allowAll') === true) return true;
  const res = await db.getRepository('dataSourcesRolesResources')?.findOne({
    filter: { roleName, name: collection, dataSourceKey: 'main' },
  });
  if (res) {
    if (val(res, 'usingActionsConfig') === false) return true;
    const actions = val(res, 'actions') || [];
    return actions.some((a) => candidates.includes(a?.name || a));
  }
  const strategyActions = val(role, 'strategy')?.actions || [];
  return Array.isArray(strategyActions) && strategyActions.some((a) => candidates.includes(a) || a === '*:*');
}

async function resolveCallerContext(db, ctx, { collection, action = 'view' }) {
  if (!ctx.state?.currentUser?.id && ctx.state?.currentRole !== 'root') {
    throw fail('NATIVE_LOGIN_REQUIRED', 401);
  }
  if (ctx.state?.currentRole === 'root') {
    if (!ctx.state?.currentUser) throw fail('NATIVE_LOGIN_REQUIRED', 401);
    return { isRoot: true, actor: null };
  }
  const actor = await resolveNativeEmployee(db, ctx.state.currentUser);
  if (!(await hasViewPermission(db, ctx, collection, action))) {
    throw fail('DXOS_ACL_DENIED', 403);
  }
  return { isRoot: false, actor };
}

const OWN_SCOPED_COLLECTIONS = new Set(['latticeRequests', 'latticeOrders', 'latticeServiceTickets']);
const ORG_WIDE_PROPOSAL_ROLES = new Set(['root', 'admin', 'ldx_admin', 'ldx_director', 'ldx_manager', 'ldx_dispatcher']);

const GLOBAL_SEARCH_SPECS = [
  { collection: 'latticeRequests', category: 'Yêu cầu mua sắm', path: '/p/procurement' },
  { collection: 'latticeOrders', category: 'Đơn Logistics', path: '/p/logistics' },
  { collection: 'latticeAssets', category: 'Tài sản', path: '/p/procurement' },
  { collection: 'latticeIncidentCases', category: 'Sự cố IoT', path: '/p/incidents' },
  { collection: 'latticeServiceTickets', category: 'Dịch vụ nội bộ', path: '/p/services' },
  { collection: 'latticeParaDocuments', category: 'Tài liệu P.A.R.A.', path: '/p/services' },
];

function foldSearchVi(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .trim();
}

function isRecordOwnedByActor(row, actor) {
  const empId = actor?.employeeId;
  const userId = actor?.userId;
  return [
    [val(row, 'requesterId'), empId],
    [val(row, 'assigneeId'), empId],
    [val(row, 'driverId'), empId],
    [val(row, 'ownerId'), empId],
    [val(row, 'createdById'), userId],
  ].some(([a, b]) => a != null && b != null && Number(a) === Number(b));
}

function buildOwnerFilterClauses(db, collection, actor) {
  const empId = actor?.employeeId;
  const userId = actor?.userId;
  const candidates = [
    ['requesterId', empId],
    ['assigneeId', empId],
    ['driverId', empId],
    ['ownerId', empId],
    ['createdById', userId],
  ];
  const col = db?.getCollection?.(collection);
  const rawAttrs = db?.getModel?.(collection)?.rawAttributes;
  const hasField = (name) => {
    if (col?.fields && typeof col.fields.has === 'function') return col.fields.has(name);
    if (col && typeof col.getField === 'function') return Boolean(col.getField(name));
    if (rawAttrs && typeof rawAttrs === 'object') return Object.hasOwn(rawAttrs, name);
    return ['requesterId', 'assigneeId'].includes(name);
  };
  const clauses = [];
  for (const [field, valId] of candidates) {
    if (valId != null && String(valId).trim() !== '' && hasField(field)) {
      const numVal = Number(valId);
      clauses.push({ [field]: Number.isFinite(numVal) ? numVal : valId });
    }
  }
  return clauses;
}

function resolveScopedOrganizationId(isRoot, actor, input = {}) {
  if (!isRoot) {
    if (
      input.organizationId !== undefined
      && input.organizationId !== null
      && String(input.organizationId).trim() !== ''
      && String(input.organizationId).trim() !== actor.organizationId
    ) {
      throw fail('DXOS_CROSS_ORG_FORBIDDEN', 403);
    }
    return actor.organizationId;
  }
  if (isValidOrganizationId(input.organizationId)) {
    return input.organizationId.trim();
  }
  if (typeof input.assetEntityId === 'string') {
    const m = URN_RE.exec(input.assetEntityId.trim());
    if (m && isValidOrganizationId(m[1])) return m[1];
  }
  throw fail('DXOS_ORG_REQUIRED', 400, 'Cần organizationId hợp lệ.');
}

function createDxosBlocksActions(db, { brokerUrl = process.env.DX_NATIVE_CONTEXT_BROKER_URL, fetchImpl = fetch, ingestToken, downlinkUrl } = {}) {
  const brokerOrigin = normalizeBrokerOrigin(brokerUrl);

  return {
    proposals: async (ctx, next) => {
      if (!['GET', 'POST'].includes(ctx.method || 'GET')) ctx.throw?.(405) ?? (() => { throw fail('METHOD_NOT_ALLOWED', 405); })();
      const input = readParams(ctx);
      const targetCollection = String(input.targetCollection || 'latticeIncidentCases').trim();
      if (!ALLOWED_PROPOSAL_COLLECTIONS.has(targetCollection)) {
        throw fail('DXOS_COLLECTION_FORBIDDEN', 403);
      }

      const { isRoot, actor } = await resolveCallerContext(db, ctx, { collection: targetCollection, action: 'view' });
      const activeRole = String(ctx.state?.currentRole || '').trim();
      const enforceOwnScope = !isRoot && OWN_SCOPED_COLLECTIONS.has(targetCollection) && !ORG_WIDE_PROPOSAL_ROLES.has(activeRole);

      const state = String(input.state || 'all').trim();
      if (!PROPOSAL_STATES.has(state)) throw fail('DXOS_INVALID_PROPOSAL_STATE', 400);

      let targetRecordId;
      if (input.targetRecordId !== undefined && input.targetRecordId !== null && input.targetRecordId !== '') {
        if (!/^[1-9]\d{0,18}$/.test(String(input.targetRecordId))) throw fail('DXOS_INVALID_RECORD_ID', 400);
        targetRecordId = Number(input.targetRecordId);
      }

      const rawPageSize = Number(input.pageSize);
      const pageSize = Number.isFinite(rawPageSize) ? Math.max(1, Math.min(50, Math.floor(rawPageSize))) : 10;

      let organizationId = isRoot ? null : actor.organizationId;
      if (isRoot) {
        organizationId = parseOptionalRootOrgId(input.organizationId);
      }

      ctx.body = await runWithOptionalRls(db, organizationId || null, async () => {
        if (targetRecordId !== undefined && !isRoot) {
          const targetRow = await db.getRepository(targetCollection)?.findOne({
            filter: { id: targetRecordId, organizationId: actor.organizationId },
          });
          if (!targetRow) throw fail('DXOS_RECORD_NOT_FOUND', 404);
          if (enforceOwnScope && !isRecordOwnedByActor(targetRow, actor)) {
            throw fail('DXOS_ACL_DENIED', 403);
          }
        }

        const repo = db.getRepository('latticeAgentProposals');
        if (!repo) {
          return { items: [], total: 0, collection: targetCollection, preview: isRoot };
        }

        const filter = {
          targetCollection,
          ...(organizationId ? { organizationId } : {}),
          ...(targetRecordId !== undefined ? { targetRecordId } : {}),
          ...(state !== 'all' ? { state } : {}),
        };
        let rows = await repo.find({ filter, limit: enforceOwnScope ? 100 : pageSize, sort: ['-id'] });
        rows = Array.isArray(rows) ? rows : [];
        let total = typeof repo.count === 'function' && !enforceOwnScope ? await repo.count({ filter }) : rows.length;
        if (enforceOwnScope && rows.length) {
          const recordIds = [...new Set(rows.map((r) => val(r, 'targetRecordId')).filter((id) => id != null))];
          const targetRepo = db.getRepository(targetCollection);
          if (!targetRepo || !recordIds.length) {
            rows = [];
          } else {
            const ownedRows = (await targetRepo.find({
              filter: { id: { $in: recordIds }, organizationId: actor.organizationId },
              limit: recordIds.length,
            })) || [];
            const ownedIds = new Set(ownedRows.filter((r) => isRecordOwnedByActor(r, actor)).map((r) => String(val(r, 'id'))));
            rows = rows.filter((r) => ownedIds.has(String(val(r, 'targetRecordId'))));
          }
          total = rows.length;
          rows = rows.slice(0, pageSize);
        }
        return {
          items: (Array.isArray(rows) ? rows : []).map((row) => ({
            id: val(row, 'id'),
            targetCollection: val(row, 'targetCollection'),
            targetRecordId: val(row, 'targetRecordId'),
            organizationId: val(row, 'organizationId'),
            state: val(row, 'state'),
            recommendation: val(row, 'recommendation'),
            evidence: Array.isArray(val(row, 'evidence')) ? val(row, 'evidence') : [],
            createdAt: val(row, 'createdAt'),
          })),
          total,
          collection: targetCollection,
          preview: isRoot,
        };
      });
      return next();
    },

    contextTelemetry: async (ctx, next) => {
      if (!['GET', 'POST'].includes(ctx.method || 'GET')) ctx.throw?.(405) ?? (() => { throw fail('METHOD_NOT_ALLOWED', 405); })();
      const input = readParams(ctx);
      const { isRoot, actor } = await resolveCallerContext(db, ctx, { collection: 'latticeAssets', action: 'view' });

      let lookupId;
      let lookupCode;
      let requestedOrg = isRoot ? null : actor.organizationId;

      if (typeof input.assetEntityId === 'string' && input.assetEntityId.trim()) {
        const rawEntity = input.assetEntityId.trim();
        const urnMatch = URN_RE.exec(rawEntity);
        if (urnMatch) {
          const [, urnOrg, urnId] = urnMatch;
          if (!isValidOrganizationId(urnOrg)) {
            throw fail('DXOS_ORG_REQUIRED', 400, 'organizationId trong URN không hợp lệ.');
          }
          if (!isRoot && urnOrg !== actor.organizationId) {
            throw fail('DXOS_CROSS_ORG_FORBIDDEN', 403);
          }
          requestedOrg = urnOrg;
          lookupId = Number(urnId);
        } else {
          lookupCode = rawEntity;
        }
      } else if (input.assetId !== undefined && input.assetId !== null && input.assetId !== '') {
        if (!/^[1-9]\d{0,18}$/.test(String(input.assetId))) throw fail('DXOS_INVALID_ASSET_ID', 400);
        lookupId = Number(input.assetId);
      }

      if (isRoot && !requestedOrg) {
        requestedOrg = parseOptionalRootOrgId(input.organizationId);
      }

      const { asset, syncSummary } = await runWithOptionalRls(db, requestedOrg || null, async () => {
        const assetRepo = db.getRepository('latticeAssets');
        let assetRow = null;
        if (assetRepo) {
          if (lookupId !== undefined) {
            assetRow = await assetRepo.findOne({ filter: { id: lookupId, ...(requestedOrg ? { organizationId: requestedOrg } : {}) } });
            if (!assetRow) throw fail('DXOS_ASSET_NOT_FOUND', 404);
          } else if (lookupCode) {
            assetRow = await assetRepo.findOne({ filter: { code: lookupCode, ...(requestedOrg ? { organizationId: requestedOrg } : {}) } });
            if (!assetRow) throw fail('DXOS_ASSET_NOT_FOUND', 404);
          } else {
            const list = await assetRepo.find({ filter: requestedOrg ? { organizationId: requestedOrg } : {}, limit: 1, sort: ['-id'] });
            assetRow = Array.isArray(list) ? list[0] || null : null;
          }
        }

        const resolvedAsset = assetRow
          ? {
              id: val(assetRow, 'id'),
              code: val(assetRow, 'code'),
              name: val(assetRow, 'name'),
              status: val(assetRow, 'status'),
              organizationId: val(assetRow, 'organizationId'),
              entityId: `urn:ngsi-ld:Asset:${val(assetRow, 'organizationId')}:native:${val(assetRow, 'id')}`,
            }
          : null;

        const outboxRepo = db.getRepository('latticeContextOutbox');
        const summary = { pending: 0, retry: 0, delivered: 0, failed: 0, lastDeliveredAt: null };
        let lastDeliveredTs = -Infinity;
        const targetOrg = resolvedAsset?.organizationId || requestedOrg;
        if (outboxRepo && (targetOrg || isRoot)) {
          const outboxFilter = {
            ...(targetOrg ? { organizationId: targetOrg } : {}),
            ...(resolvedAsset ? { collectionName: 'latticeAssets', recordId: resolvedAsset.id } : {}),
          };
          const outboxRows = await outboxRepo.find({ filter: outboxFilter, limit: 100 });
          for (const row of Array.isArray(outboxRows) ? outboxRows : []) {
            const st = val(row, 'state');
            if (Object.hasOwn(summary, st)) summary[st] += 1;
            const del = val(row, 'deliveredAt');
            const ts = del ? Date.parse(String(del)) : NaN;
            if (del && ((Number.isFinite(ts) && ts > lastDeliveredTs) || (!Number.isFinite(lastDeliveredTs) && !summary.lastDeliveredAt))) {
              if (Number.isFinite(ts)) lastDeliveredTs = ts;
              summary.lastDeliveredAt = del;
            }
          }
        }

        return { asset: resolvedAsset, syncSummary: summary };
      });

      let brokerStatus = brokerOrigin ? 'unconfigured' : 'unconfigured';
      let telemetry = null;
      if (brokerOrigin && asset) {
        try {
          const res = await fetchImpl(`${brokerOrigin}/ngsi-ld/v1/entities/${encodeURIComponent(asset.entityId)}`, {
            method: 'GET',
            redirect: 'error',
            headers: { Accept: 'application/ld+json', 'NGSILD-Tenant': asset.organizationId },
            signal: AbortSignal.timeout(3000),
          });
          if (res.ok) {
            const raw = await res.json();
            brokerStatus = 'online';
            telemetry = {};
            for (const [k, v] of Object.entries(raw || {})) {
              if (!['id', 'type', '@context'].includes(k)) telemetry[k] = v;
            }
          } else {
            await res.body?.cancel?.();
            brokerStatus = res.status === 404 ? 'not_synced' : 'offline';
          }
        } catch {
          brokerStatus = 'offline';
        }
      } else if (brokerOrigin) {
        brokerStatus = 'ready';
      }

      ctx.body = { asset, brokerStatus, telemetry, syncSummary, preview: isRoot };
      return next();
    },

    telemetrySeries: async (ctx, next) => {
      if (!['GET', 'POST'].includes(ctx.method || 'GET')) throw fail('METHOD_NOT_ALLOWED', 405);
      const input = readParams(ctx);
      const { isRoot, actor } = await resolveCallerContext(db, ctx, { collection: 'latticeAssets', action: 'view' });

      let lookupId;
      let requestedOrg = isRoot ? null : actor.organizationId;
      let assetEntityId = typeof input.assetEntityId === 'string' ? input.assetEntityId.trim() : '';
      if (assetEntityId) {
        const m = URN_RE.exec(assetEntityId);
        if (m) {
          if (!isValidOrganizationId(m[1])) throw fail('DXOS_ORG_REQUIRED', 400, 'organizationId trong URN không hợp lệ.');
          if (!isRoot && m[1] !== actor.organizationId) throw fail('DXOS_CROSS_ORG_FORBIDDEN', 403);
          requestedOrg = m[1];
          lookupId = Number(m[2]);
        }
      } else if (input.assetId != null && input.assetId !== '') {
        if (!/^[1-9]\d{0,18}$/.test(String(input.assetId))) throw fail('DXOS_INVALID_ASSET_ID', 400);
        lookupId = Number(input.assetId);
      }

      if (isRoot && !requestedOrg) {
        requestedOrg = parseOptionalRootOrgId(input.organizationId);
      }

      const windowHours = parseOptionalNumber(input.windowHours, 'DXOS_INVALID_WINDOW_HOURS', { min: 0 });
      const bucketMinutes = parseOptionalNumber(input.bucketMinutes, 'DXOS_INVALID_BUCKET_MINUTES', { min: 0 });
      const limit = parseOptionalNumber(input.limit, 'DXOS_INVALID_LIMIT', { min: 1 });

      const series = await runWithOptionalRls(db, requestedOrg || null, async () => {
        let resolvedOrg = requestedOrg;
        let resolvedEntityId = assetEntityId;
        if (!resolvedEntityId && lookupId != null) {
          const asset = await db.getRepository('latticeAssets')?.findOne({
            filter: { id: lookupId, ...(resolvedOrg ? { organizationId: resolvedOrg } : {}) },
          });
          if (!asset) throw fail('DXOS_ASSET_NOT_FOUND', 404);
          resolvedOrg = val(asset, 'organizationId');
          resolvedEntityId = `urn:ngsi-ld:Asset:${resolvedOrg}:native:${val(asset, 'id')}`;
        }
        return queryTelemetryTimeSeries(db, {
          organizationId: resolvedOrg,
          assetEntityId: resolvedEntityId,
          attribute: typeof input.attribute === 'string' ? input.attribute.trim() : '',
          ...(windowHours !== undefined ? { windowHours } : {}),
          ...(bucketMinutes !== undefined ? { bucketMinutes } : {}),
          limit: limit ?? 100,
        });
      });
      ctx.body = { ...series, preview: isRoot };
      return next();
    },

    telemetryIngest: async (ctx, next) => {
      if ((ctx.method || 'POST') !== 'POST') throw fail('METHOD_NOT_ALLOWED', 405);
      const input = readParams(ctx);
      const auth = await resolveTelemetryIngestAuth(db, ctx, input, { ingestToken });

      let assetId = null;
      if (input.assetId !== undefined && input.assetId !== null && input.assetId !== '') {
        if (!/^[1-9]\d{0,18}$/.test(String(input.assetId))) throw fail('DXOS_INVALID_ASSET_ID', 400);
        assetId = Number(input.assetId);
      }
      let assetEntityId = typeof input.assetEntityId === 'string' ? input.assetEntityId.trim() : '';
      if (!assetEntityId && assetId != null) {
        assetEntityId = `urn:ngsi-ld:Asset:${auth.organizationId}:native:${assetId}`;
      }

      ctx.body = await runWithOptionalRls(db, auth.organizationId, () =>
        ingestTelemetryPoint(db, {
          organizationId: auth.organizationId,
          assetId,
          assetEntityId,
          metricName: input.metricName !== undefined ? input.metricName : input.attribute,
          numericValue: input.numericValue !== undefined ? input.numericValue : input.value,
          unit: input.unit,
          quality: input.quality,
          sourceProtocol: input.sourceProtocol,
          observedAt: input.observedAt,
          app: ctx?.app,
        }),
      );
      return next();
    },

    alarmIngest: async (ctx, next) => {
      if ((ctx.method || 'POST') !== 'POST') throw fail('METHOD_NOT_ALLOWED', 405);
      const input = readParams(ctx);
      const { isRoot, actor } = await resolveCallerContext(db, ctx, { collection: 'latticeIncidentCases', action: 'create' });
      let assetEntityId = typeof input.assetEntityId === 'string' ? input.assetEntityId.trim() : '';
      const assetId = input.assetId != null && /^[1-9]\d{0,18}$/.test(String(input.assetId)) ? Number(input.assetId) : null;

      let orgId = isRoot ? '' : actor.organizationId;
      if (isRoot) {
        const parsedRootOrg = parseOptionalRootOrgId(
          input.organizationId,
          'ORG_REQUIRED',
          'Cần organizationId hợp lệ để ghi nhận cảnh báo.',
        );
        if (parsedRootOrg) {
          orgId = parsedRootOrg;
        } else if (assetEntityId) {
          const urnMatch = URN_RE.exec(assetEntityId);
          if (urnMatch && isValidOrganizationId(urnMatch[1])) orgId = urnMatch[1];
        }
      }

      ctx.body = await runWithOptionalRls(db, orgId || null, async () => {
        if (isRoot && !orgId && assetId != null) {
          const assetRow = await db.getRepository?.('latticeAssets')?.findOne?.({ filter: { id: assetId } });
          const assetOrg = String(val(assetRow, 'organizationId') || '').trim();
          if (isValidOrganizationId(assetOrg)) orgId = assetOrg;
        }
        if (isRoot && !orgId) {
          const orgRepo = db.getRepository?.('latticeOrganizations');
          if (orgRepo) {
            let orgRow = null;
            if (typeof orgRepo.find === 'function') {
              const rows = (await orgRepo.find({ filter: { active: true }, limit: 1, sort: ['id'] })) || [];
              orgRow = rows[0] || null;
            } else if (typeof orgRepo.findOne === 'function') {
              orgRow = await orgRepo.findOne({ filter: { active: true }, sort: ['id'] });
            }
            const candidate = String(val(orgRow, 'organizationId') || '').trim();
            if (isValidOrganizationId(candidate)) orgId = candidate;
          }
        }
        if (!orgId) {
          throw fail('ORG_REQUIRED', 400, 'Cần organizationId hợp lệ để ghi nhận cảnh báo.');
        }

        if (!assetEntityId && assetId != null) {
          assetEntityId = `urn:ngsi-ld:Asset:${orgId}:native:${assetId}`;
        }
        return ingestOrDeduplicateAlarm(db, {
          organizationId: orgId,
          assetId,
          assetEntityId,
          ruleCode: String(input.ruleCode || 'IOT-RULE').trim(),
          attribute: String(input.attribute || 'temperature').trim(),
          severity: String(input.severity || 'medium').trim(),
          summary: String(input.summary || '').trim(),
          handlerId: actor?.employeeId ? String(actor.employeeId) : String(input.handlerId || 'root'),
          app: ctx?.app,
        });
      });
      return next();
    },

    alarmAck: async (ctx, next) => {
      if ((ctx.method || 'POST') !== 'POST') throw fail('METHOD_NOT_ALLOWED', 405);
      const input = readParams(ctx);
      const { isRoot, actor } = await resolveCallerContext(db, ctx, { collection: 'latticeIncidentCases', action: 'update' });
      const id = Number(input.id);
      if (!Number.isInteger(id) || id <= 0) throw fail('ALARM_ID_REQUIRED', 400, 'Cần mã id cảnh báo hợp lệ.');
      const actorName = val(ctx.state?.currentUser, 'username') || (actor ? `user-${actor.userId}` : 'root');
      const orgScope = isRoot ? null : actor.organizationId;
      ctx.body = await runWithOptionalRls(db, orgScope, () =>
        acknowledgeAlarm(db, {
          id,
          organizationId: orgScope,
          actorName,
          note: String(input.note || '').trim(),
        }),
      );
      return next();
    },

    alarmClear: async (ctx, next) => {
      if ((ctx.method || 'POST') !== 'POST') throw fail('METHOD_NOT_ALLOWED', 405);
      const input = readParams(ctx);
      const { isRoot, actor } = await resolveCallerContext(db, ctx, { collection: 'latticeIncidentCases', action: 'update' });
      const id = Number(input.id);
      if (!Number.isInteger(id) || id <= 0) throw fail('ALARM_ID_REQUIRED', 400, 'Cần mã id cảnh báo hợp lệ.');
      const actorName = val(ctx.state?.currentUser, 'username') || (actor ? `user-${actor.userId}` : 'root');
      const orgScope = isRoot ? null : actor.organizationId;
      ctx.body = await runWithOptionalRls(db, orgScope, () =>
        clearAlarm(db, {
          id,
          organizationId: orgScope,
          actorName,
          closeNote: String(input.closeNote || input.note || '').trim(),
        }),
      );
      return next();
    },

    exportReport: async (ctx, next) => {
      if (!['GET', 'POST'].includes(ctx.method || 'GET')) throw fail('METHOD_NOT_ALLOWED', 405);
      const input = readParams(ctx);
      const collection = String(input.collection || '').trim();
      const { isRoot, actor } = await resolveCallerContext(db, ctx, { collection, action: 'view' });
      const orgScope = isRoot
        ? parseOptionalRootOrgId(input.organizationId)
        : actor.organizationId;
      const result = await runWithOptionalRls(db, orgScope, () =>
        executeGovernedExport(db, ctx, input, { isRoot, actor, fetchImpl }),
      );
      const isDownload = input.download === true || input.download === '1' || input.download === 'true';
      if (typeof ctx.set === 'function') {
        ctx.set('X-Lattice-Export-Columns', result.columns.join(','));
        ctx.set('X-Lattice-Export-Omitted', result.omittedColumns.join(','));
        ctx.set('X-Lattice-Export-Sha256', result.sha256);
      }
      if (isDownload) {
        if (typeof ctx.set === 'function') {
          ctx.set('Content-Type', result.mimeType);
          ctx.set('Content-Disposition', `attachment; filename="${result.filename}"`);
        }
        ctx.body = result.buffer;
        return next();
      }
      const { buffer, ...meta } = result;
      ctx.body = { ...meta, contentBase64: buffer.toString('base64') };
      return next();
    },

    globalSearch: async (ctx, next) => {
      if (!['GET', 'POST'].includes(ctx.method || 'GET')) throw fail('METHOD_NOT_ALLOWED', 405);
      if (!ctx.state?.currentUser?.id && ctx.state?.currentRole !== 'root') {
        throw fail('NATIVE_LOGIN_REQUIRED', 401);
      }
      const isRoot = ctx.state?.currentRole === 'root';
      if (isRoot && !ctx.state?.currentUser) throw fail('NATIVE_LOGIN_REQUIRED', 401);
      const actor = isRoot ? null : await resolveNativeEmployee(db, ctx.state.currentUser);

      const input = readParams(ctx);
      const rawQuery = typeof input.query === 'string' ? input.query.trim() : '';
      if (rawQuery.length < 1 || rawQuery.length > 120) {
        throw fail('DXOS_SEARCH_QUERY_INVALID', 400, 'Từ khóa tìm kiếm phải từ 1 đến 120 ký tự.');
      }
      const needle = foldSearchVi(rawQuery);
      const tokens = needle.split(/\s+/).filter(Boolean);
      if (!tokens.length) {
        throw fail('DXOS_SEARCH_QUERY_INVALID', 400, 'Từ khóa tìm kiếm không hợp lệ.');
      }
      const limit = Math.max(1, Math.min(20, Math.floor(Number(input.limit) || 10)));

      let organizationId = isRoot ? null : actor.organizationId;
      if (isRoot) {
        organizationId = parseOptionalRootOrgId(input.organizationId);
      }
      const activeRole = String(ctx.state?.currentRole || '').trim();

      const BATCH_SIZE = 200;
      const MAX_SCAN = 2000;
      const buckets = await runWithOptionalRls(db, organizationId || null, async () => {
        const out = [];
        for (const spec of GLOBAL_SEARCH_SPECS) {
          if (!isRoot && !(await hasViewPermission(db, ctx, spec.collection, 'view'))) continue;
          const repo = db?.getRepository?.(spec.collection);
          if (!repo) continue;
          const enforceOwnScope = !isRoot && OWN_SCOPED_COLLECTIONS.has(spec.collection) && !ORG_WIDE_PROPOSAL_ROLES.has(activeRole);
          const ownerClauses = enforceOwnScope ? buildOwnerFilterClauses(db, spec.collection, actor) : [];
          let filter = organizationId ? { organizationId } : {};
          if (ownerClauses.length) {
            filter = organizationId
              ? { $and: [{ organizationId }, { $or: ownerClauses }] }
              : { $or: ownerClauses };
          }

          const matched = [];
          const seenIds = new Set();
          for (let offset = 0; offset < MAX_SCAN && matched.length < limit; offset += BATCH_SIZE) {
            const rows = (await repo.find({
              filter,
              limit: BATCH_SIZE,
              offset,
              sort: ['-id'],
            })) || [];
            if (!Array.isArray(rows) || !rows.length) break;

            let unseenCount = 0;
            for (const row of rows) {
              const id = val(row, 'id');
              const idKey = id != null ? String(id) : null;
              if (idKey !== null) {
                if (seenIds.has(idKey)) continue;
                seenIds.add(idKey);
              }
              unseenCount += 1;

              if (organizationId && val(row, 'organizationId') !== organizationId) continue;
              if (enforceOwnScope && !isRecordOwnedByActor(row, actor)) continue;
              const code = String(val(row, 'code') || '').trim();
              const title = String(val(row, 'title') || val(row, 'name') || code || '').trim();
              const desc = String(val(row, 'description') || val(row, 'summary') || '').trim();
              const hay = foldSearchVi(`${code} ${title} ${desc}`);
              if (!tokens.every((t) => hay.includes(t))) continue;
              matched.push({
                collection: spec.collection,
                id,
                code,
                title: title || `#${id}`,
                status: String(val(row, 'status') || ''),
                category: spec.category,
                path: spec.collection === 'latticeParaDocuments' && id != null
                  ? `/p/services?paraDocId=${encodeURIComponent(String(id))}`
                  : spec.path,
              });
              if (matched.length >= limit) break;
            }
            if (rows.length < BATCH_SIZE || unseenCount === 0) break;
          }
          if (matched.length) out.push(matched);
        }
        return out;
      });

      const items = [];
      let round = 0;
      while (items.length < limit) {
        let added = false;
        for (const bucket of buckets) {
          if (round < bucket.length) {
            items.push(bucket[round]);
            added = true;
            if (items.length >= limit) break;
          }
        }
        if (!added) break;
        round += 1;
      }

      ctx.body = { query: rawQuery, count: items.length, items };
      return next();
    },

    twinShadow: async (ctx, next) => {
      if (!['GET', 'POST'].includes(ctx.method || 'GET')) throw fail('METHOD_NOT_ALLOWED', 405);
      const input = readParams(ctx);
      const { isRoot, actor } = await resolveCallerContext(db, ctx, { collection: 'latticeAssets', action: 'view' });
      const organizationId = resolveScopedOrganizationId(isRoot, actor, input);
      ctx.body = await getTwinShadow(db, {
        organizationId,
        assetId: input.assetId,
        assetEntityId: input.assetEntityId,
      });
      return next();
    },

    twinSetDesired: async (ctx, next) => {
      if ((ctx.method || 'POST') !== 'POST') throw fail('METHOD_NOT_ALLOWED', 405);
      const input = readParams(ctx);
      const { isRoot, actor } = await resolveCallerContext(db, ctx, { collection: 'latticeAssets', action: 'update' });
      if (!isRoot && input.hitlApproved === true) {
        throw fail('TWIN_HITL_APPROVAL_REQUIRED', 403, 'Chỉ quy trình phê duyệt HITL hoặc root mới được xác nhận thay đổi vượt ngưỡng.');
      }
      const organizationId = resolveScopedOrganizationId(isRoot, actor, input);
      const actorName = val(ctx.state?.currentUser, 'username') || (actor ? `user-${actor.userId}` : 'root');
      ctx.body = await requestDesiredSetpoint(db, {
        organizationId,
        assetId: input.assetId,
        assetEntityId: input.assetEntityId,
        desiredPatch: input.desiredPatch ?? input.desired,
        hitlApproved: isRoot && input.hitlApproved === true,
        actor: actor
          ? { ...actor, username: actorName }
          : { userId: val(ctx.state?.currentUser, 'id'), username: actorName },
        currentUser: ctx.state?.currentUser,
        ...(downlinkUrl !== undefined ? { downlinkUrl } : {}),
        fetchImpl,
        ingestToken,
        app: ctx?.app,
      });
      return next();
    },

    twinAckCommand: async (ctx, next) => {
      if ((ctx.method || 'POST') !== 'POST') throw fail('METHOD_NOT_ALLOWED', 405);
      const input = readParams(ctx);
      const auth = await resolveTelemetryIngestAuth(db, ctx, input, { ingestToken });
      const actorName = auth.mode === 'edge-token'
        ? 'edge-gateway'
        : (val(ctx.state?.currentUser, 'username') || (auth.actor ? `user-${auth.actor.userId}` : 'root'));
      ctx.body = await ackCommandFromEdge(db, {
        organizationId: auth.organizationId,
        assetId: input.assetId,
        assetEntityId: input.assetEntityId,
        commandId: input.commandId,
        reportedPatch: input.reportedPatch ?? input.reported,
        ackStatus: input.ackStatus,
        actorName,
        app: ctx?.app,
      });
      return next();
    },

    bulkImportDryRun: async (ctx, next) => {
      if ((ctx.method || 'POST') !== 'POST') throw fail('METHOD_NOT_ALLOWED', 405);
      if (!ctx.state?.currentUser?.id && ctx.state?.currentRole !== 'root') {
        throw fail('NATIVE_LOGIN_REQUIRED', 401);
      }
      const input = readParams(ctx);
      const collection = String(input.collection || '').trim();
      if (!ALLOWED_IMPORT_COLLECTIONS.has(collection) && !(OPTIONAL_IMPORT_COLLECTIONS.has(collection) && db?.getRepository?.(collection))) {
        throw fail('BULK_IMPORT_COLLECTION_FORBIDDEN', 403, `Không được phép import vào collection "${collection}".`);
      }
      const { isRoot, actor } = await resolveCallerContext(db, ctx, { collection, action: 'create' });
      const organizationId = resolveScopedOrganizationId(isRoot, actor, input);
      ctx.body = await runWithOptionalRls(db, organizationId, () =>
        runBulkImportDryRun(db, {
          organizationId,
          collection,
          format: input.format,
          content: input.content,
          rows: input.rows,
        }),
      );
      return next();
    },

    bulkImportCommit: async (ctx, next) => {
      if ((ctx.method || 'POST') !== 'POST') throw fail('METHOD_NOT_ALLOWED', 405);
      if (!ctx.state?.currentUser?.id && ctx.state?.currentRole !== 'root') {
        throw fail('NATIVE_LOGIN_REQUIRED', 401);
      }
      const input = readParams(ctx);
      const collection = String(input.collection || '').trim();
      if (!ALLOWED_IMPORT_COLLECTIONS.has(collection) && !(OPTIONAL_IMPORT_COLLECTIONS.has(collection) && db?.getRepository?.(collection))) {
        throw fail('BULK_IMPORT_COLLECTION_FORBIDDEN', 403, `Không được phép import vào collection "${collection}".`);
      }
      const { isRoot, actor } = await resolveCallerContext(db, ctx, { collection, action: 'create' });
      const organizationId = resolveScopedOrganizationId(isRoot, actor, input);
      const actorName = val(ctx.state?.currentUser, 'username') || (actor ? `user-${actor.userId}` : 'root');
      ctx.body = await runWithOptionalRls(db, organizationId, () =>
        commitBulkImport(db, {
          organizationId,
          collection,
          format: input.format,
          content: input.content,
          rows: input.rows,
          previewToken: input.previewToken,
          actor: {
            userId: actor?.userId || val(ctx.state?.currentUser, 'id'),
            username: actorName,
          },
        }),
      );
      return next();
    },

    collectionsMeta: async (ctx, next) => {
      if ((ctx.method || 'GET') !== 'GET') throw fail('METHOD_NOT_ALLOWED', 405);
      if (!ctx.state?.currentUser?.id && ctx.state?.currentRole !== 'root') {
        throw fail('NATIVE_LOGIN_REQUIRED', 401);
      }
      const isRoot = ctx.state?.currentRole === 'root';
      if (isRoot && !ctx.state?.currentUser) {
        throw fail('NATIVE_LOGIN_REQUIRED', 401);
      }
      if (!isRoot) {
        await resolveNativeEmployee(db, ctx.state.currentUser);
      }

      const normalizeEnumValues = (rawField) => {
        const rawOptions = val(rawField, 'options');
        const options = rawOptions && typeof rawOptions === 'object' ? rawOptions : {};
        const uiSchema = val(rawField, 'uiSchema') || options.uiSchema;
        const candidates = [
          val(rawField, 'enumValues'),
          options.enumValues,
          uiSchema?.enum,
          options.enum,
          val(rawField, 'enum'),
        ];
        const out = [];
        const seen = new Set();
        for (const list of candidates) {
          if (!Array.isArray(list)) continue;
          for (const item of list) {
            let value = '';
            let label = '';
            if (item && typeof item === 'object') {
              value = String(item.value ?? item.label ?? '').trim();
              label = String(item.label ?? item.value ?? '').trim();
            } else if (item !== null && item !== undefined) {
              value = String(item).trim();
              label = value;
            }
            if (!value || seen.has(value)) continue;
            seen.add(value);
            out.push({ value, label: label || value });
          }
          if (out.length) break;
        }
        return out;
      };

      const mergeFields = (colObj, repoFieldRows) => {
        const fieldMap = new Map();
        const addField = (rawField) => {
          const rawOptions = val(rawField, 'options');
          const options = rawOptions && typeof rawOptions === 'object' ? rawOptions : {};
          const fname = String(val(rawField, 'name') || options.name || '').trim();
          if (!fname || META_BLOCKED_KEYS.has(fname) || fname.startsWith('__') || META_SENSITIVE_FIELD_RE.test(fname)) {
            return;
          }
          const uiSchema = val(rawField, 'uiSchema') || options.uiSchema || {};
          const ftype = String(val(rawField, 'type') || options.type || 'string').trim() || 'string';
          const iface = String(val(rawField, 'interface') || options.interface || '').trim();
          const dataType = String(val(rawField, 'dataType') || options.dataType || '').trim();
          const title = String(uiSchema?.title || val(rawField, 'title') || options.title || fname).trim() || fname;
          const enumValues = normalizeEnumValues(rawField);
          const prev = fieldMap.get(fname);
          const nextDataType = dataType || prev?.dataType || '';
          fieldMap.set(fname, {
            name: fname,
            type: ftype !== 'string' || !prev ? ftype : prev.type,
            interface: iface || prev?.interface || '',
            ...(nextDataType ? { dataType: nextDataType } : {}),
            title: title !== fname || !prev ? title : prev.title,
            enumValues: enumValues.length ? enumValues : (prev?.enumValues || []),
          });
        };

        const rawColFields = colObj?.fields;
        if (rawColFields instanceof Map) {
          for (const f of rawColFields.values()) addField(f);
        } else if (Array.isArray(rawColFields)) {
          for (const f of rawColFields) addField(f);
        } else if (rawColFields && typeof rawColFields === 'object') {
          for (const f of Object.values(rawColFields)) addField(f);
        }
        for (const f of Array.isArray(repoFieldRows) ? repoFieldRows : []) {
          addField(f);
        }
        return [...fieldMap.values()];
      };

      let repoCollections = [];
      let repoFields = [];
      try {
        const colRepo = db?.getRepository?.('collections');
        if (colRepo && typeof colRepo.find === 'function') {
          repoCollections = (await colRepo.find({ limit: 500 })) || [];
        }
      } catch {
        repoCollections = [];
      }
      try {
        const fieldRepo = db?.getRepository?.('fields');
        if (fieldRepo && typeof fieldRepo.find === 'function') {
          repoFields = (await fieldRepo.find({ limit: 2000 })) || [];
        }
      } catch {
        repoFields = [];
      }

      const fieldsByCol = new Map();
      for (const f of Array.isArray(repoFields) ? repoFields : []) {
        const colName = String(val(f, 'collectionName') || '').trim();
        if (!colName) continue;
        if (!fieldsByCol.has(colName)) fieldsByCol.set(colName, []);
        fieldsByCol.get(colName).push(f);
      }

      const rawMap = new Map();
      const registerCandidate = (rawName, obj) => {
        const rawOptions = val(obj, 'options');
        const options = rawOptions && typeof rawOptions === 'object' ? rawOptions : {};
        const name = String(rawName || val(obj, 'name') || options.name || '').trim();
        if (!name || !SAFE_COLLECTION_NAME_RE.test(name)) return;
        if (name.startsWith('r_') || name.startsWith('__') || name.startsWith('pg_') || name.startsWith('sqlite_')) return;
        if (META_EXCLUDED_LOWER.has(name.toLowerCase())) return;
        if (!META_ALLOWED_BUSINESS_COLLECTIONS.has(name) && !CUSTOM_COLLECTION_RE.test(name)) return;
        if (obj?.hidden === true || options.hidden === true || val(obj, 'hidden') === true) {
          rawMap.delete(name);
          return;
        }
        const prev = rawMap.get(name);
        const title = String(options.title || val(obj, 'title') || obj?.title || prev?.title || name).trim() || name;
        const mergedColObj = obj?.fields ? obj : (prev?.colObj || obj);
        rawMap.set(name, { name, title, colObj: mergedColObj });
      };

      if (db?.collections instanceof Map) {
        for (const [k, c] of db.collections.entries()) registerCandidate(c?.name || c?.options?.name || k, c);
      } else if (Array.isArray(db?.collections)) {
        for (const c of db.collections) registerCandidate(c?.name || c?.options?.name, c);
      } else if (db?.collections && typeof db.collections === 'object') {
        for (const [k, c] of Object.entries(db.collections)) registerCandidate(c?.name || c?.options?.name || k, c);
      } else if (typeof db?.getCollections === 'function') {
        const list = db.getCollections() || [];
        for (const c of Array.isArray(list) ? list : [...list]) registerCandidate(c?.name || c?.options?.name, c);
      }

      for (const row of Array.isArray(repoCollections) ? repoCollections : []) {
        registerCandidate(val(row, 'name'), row);
      }

      const collections = [];
      for (const entry of rawMap.values()) {
        if (!isRoot && !(await hasViewPermission(db, ctx, entry.name, 'view'))) {
          continue;
        }
        collections.push({
          name: entry.name,
          title: entry.title,
          isCustom: CUSTOM_COLLECTION_RE.test(entry.name),
          fields: mergeFields(entry.colObj, fieldsByCol.get(entry.name)),
        });
      }

      collections.sort((a, b) => (a.isCustom !== b.isCustom ? (a.isCustom ? -1 : 1) : a.name.localeCompare(b.name)));
      ctx.body = { collections };
      return next();
    },

    aggregateQuery: async (ctx, next) => {
      if (!['GET', 'POST'].includes(ctx.method || 'GET')) throw fail('METHOD_NOT_ALLOWED', 405);
      if (!ctx.state?.currentUser?.id && ctx.state?.currentRole !== 'root') {
        throw fail('NATIVE_LOGIN_REQUIRED', 401);
      }
      if (ctx.state?.currentRole === 'root' && !ctx.state?.currentUser) {
        throw fail('NATIVE_LOGIN_REQUIRED', 401);
      }

      const input = readParams(ctx);
      const collection = String(input.collection || '').trim();
      const isAllowedAggregateCollection = (
        META_ALLOWED_BUSINESS_COLLECTIONS.has(collection)
        || (SAFE_COLLECTION_NAME_RE.test(collection) && /^latticeCustom[A-Za-z0-9_]+$/.test(collection))
      ) && !META_EXCLUDED_LOWER.has(collection.toLowerCase()) && !META_BLOCKED_KEYS.has(collection);
      if (!isAllowedAggregateCollection) {
        throw fail('DXOS_COLLECTION_FORBIDDEN', 403, `Collection "${collection}" không nằm trong danh sách cho phép truy vấn BI.`);
      }

      const { isRoot, actor } = await resolveCallerContext(db, ctx, { collection, action: 'view' });

      let effectiveOrg = null;
      if (!isRoot) {
        if (
          input.organizationId !== undefined
          && input.organizationId !== null
          && String(input.organizationId).trim() !== ''
          && String(input.organizationId).trim() !== actor.organizationId
        ) {
          throw fail('DXOS_CROSS_ORG_FORBIDDEN', 403);
        }
        effectiveOrg = actor.organizationId;
      } else if (input.organizationId !== undefined && input.organizationId !== null && String(input.organizationId).trim() !== '') {
        const cleanOrg = String(input.organizationId).trim();
        if (!isValidOrganizationId(cleanOrg)) {
          throw fail('DXOS_ORG_REQUIRED', 400, 'organizationId không hợp lệ.');
        }
        effectiveOrg = cleanOrg;
      }

      const VALID_CHART_TYPES = new Set(['bar', 'line', 'pie', 'kpi', 'pivot']);
      const chartType = input.chartType === undefined ? 'bar' : String(input.chartType || '').trim().toLowerCase();
      if (!VALID_CHART_TYPES.has(chartType)) {
        throw fail('DXOS_INVALID_CHART_TYPE', 400, `Loại biểu đồ "${chartType}" không hợp lệ.`);
      }

      let rawMetric = input.metric;
      if (typeof rawMetric === 'string' && rawMetric.trim()) {
        try { rawMetric = JSON.parse(rawMetric); } catch { throw fail('DXOS_INVALID_METRIC_OP', 400, 'Cấu hình phép tính (metric) không hợp lệ.'); }
      }
      const metricObj = rawMetric && typeof rawMetric === 'object' && !Array.isArray(rawMetric)
        ? rawMetric
        : { op: input.metricOp ?? 'count', field: input.metricField };
      const VALID_METRIC_OPS = new Set(['count', 'sum', 'avg', 'min', 'max']);
      const op = String(metricObj.op ?? 'count').trim().toLowerCase();
      if (!VALID_METRIC_OPS.has(op)) {
        throw fail('DXOS_INVALID_METRIC_OP', 400, `Phép tính "${op}" không hợp lệ.`);
      }
      const metricField = metricObj.field !== undefined && metricObj.field !== null ? String(metricObj.field).trim() : '';

      let limit = 100;
      if (input.limit !== undefined && input.limit !== null && input.limit !== '') {
        if (typeof input.limit === 'boolean' || typeof input.limit === 'object') {
          throw fail('DXOS_INVALID_LIMIT', 400, 'Số nhóm tối đa (limit) phải là số nguyên trong khoảng 1..500.');
        }
        const parsedLimit = Number(input.limit);
        if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 500) {
          throw fail('DXOS_INVALID_LIMIT', 400, 'Số nhóm tối đa (limit) phải là số nguyên trong khoảng 1..500.');
        }
        limit = parsedLimit;
      }

      const repo = db?.getRepository?.(collection);
      if (!repo || typeof repo.find !== 'function') {
        throw fail('DXOS_COLLECTION_NOT_FOUND', 404, `Không tìm thấy repository cho "${collection}".`);
      }

      const VIRTUAL_OR_ASSOC_TYPES = new Set(['virtual', 'hasmany', 'belongstomany', 'hasone', 'belongsto', 'password', 'encryption']);
      const fieldMap = new Map();
      const registerField = (rawField, fallbackKey = '') => {
        const rawOpts = val(rawField, 'options');
        const opts = rawOpts && typeof rawOpts === 'object' ? rawOpts : {};
        const fname = String(val(rawField, 'name') || opts.name || fallbackKey || '').trim();
        if (!fname || META_BLOCKED_KEYS.has(fname) || fname.startsWith('__') || fname.startsWith('$') || fname.includes('.')) return;
        const ftype = String(val(rawField, 'type') || opts.type || 'string').trim().toLowerCase();
        if (VIRTUAL_OR_ASSOC_TYPES.has(ftype) || rawField?.virtual === true || opts.virtual === true || rawField?.isAssociation === true) {
          return;
        }
        const iface = String(val(rawField, 'interface') || opts.interface || '').trim().toLowerCase();
        const dataType = String(val(rawField, 'dataType') || opts.dataType || '').trim().toLowerCase();
        const prev = fieldMap.get(fname);
        fieldMap.set(fname, {
          name: fname,
          type: ftype !== 'string' || !prev ? ftype : prev.type,
          interface: iface || prev?.interface || '',
          dataType: dataType || prev?.dataType || '',
        });
      };

      const colObj = typeof db?.getCollection === 'function'
        ? db.getCollection(collection)
        : (db?.collections instanceof Map ? db.collections.get(collection) : db?.collections?.[collection]) || null;
      const rawColFields = colObj?.fields;
      if (rawColFields instanceof Map) {
        for (const [k, f] of rawColFields.entries()) registerField(f, k);
      } else if (Array.isArray(rawColFields)) {
        for (const f of rawColFields) registerField(f);
      } else if (rawColFields && typeof rawColFields === 'object') {
        for (const [k, f] of Object.entries(rawColFields)) registerField(f, k);
      }
      const rawAttrs = db?.getModel?.(collection)?.rawAttributes;
      if (rawAttrs && typeof rawAttrs === 'object') {
        for (const [k, attr] of Object.entries(rawAttrs)) {
          if (!fieldMap.has(k)) {
            const typeName = String(attr?.type?.key || attr?.type || 'string').toLowerCase();
            registerField({ name: k, type: typeName }, k);
          }
        }
      }
      if (!fieldMap.size) {
        try {
          const fieldRepo = db?.getRepository?.('fields');
          if (fieldRepo && typeof fieldRepo.find === 'function') {
            const rows = (await fieldRepo.find({ filter: { collectionName: collection }, limit: 500 })) || [];
            for (const r of rows) registerField(r);
          }
        } catch {
          // ignore
        }
      }
      if (!fieldMap.size) {
        throw fail('DXOS_COLLECTION_NOT_FOUND', 404, `Không tìm thấy metadata trường cho "${collection}".`);
      }

      let roleAllowedSet = null;
      if (!isRoot) {
        const roleName = ctx.state?.currentRole;
        if (roleName && db?.getRepository) {
          const role = await db.getRepository('roles')?.findOne({ filter: { name: roleName } });
          if (val(role, 'allowAll') !== true) {
            const res = await db.getRepository('dataSourcesRolesResources')?.findOne({
              filter: { roleName, name: collection, dataSourceKey: 'main' },
            });
            if (res && val(res, 'usingActionsConfig') !== false) {
              const actions = val(res, 'actions') || [];
              const viewAct = actions.find((a) => (a?.name || a) === 'view' && Array.isArray(a?.fields) && a.fields.length > 0)
                || actions.find((a) => (a?.name || a) === 'list' && Array.isArray(a?.fields) && a.fields.length > 0);
              const rawAllowed = Array.isArray(viewAct?.fields) ? viewAct.fields : [];
              if (rawAllowed.length) {
                roleAllowedSet = new Set(rawAllowed.map((f) => String(f?.name || f)));
              }
            }
          }
        }
      }

      const isSensitiveOrBlockedField = (name) => (
        !name
        || META_BLOCKED_KEYS.has(name)
        || name.startsWith('__')
        || name.startsWith('$')
        || name.includes('.')
        || META_SENSITIVE_FIELD_RE.test(name)
        || SENSITIVE_EXPORT_FIELDS.has(name)
      );

      const assertValidField = (rawName, { allowSystemFilterField = false } = {}) => {
        const fname = String(rawName || '').trim();
        if (isSensitiveOrBlockedField(fname)) {
          throw fail('DXOS_FIELD_FORBIDDEN', 403, `Trường "${fname}" không được phép truy vấn.`);
        }
        const meta = fieldMap.get(fname);
        if (!meta) {
          if (allowSystemFilterField && ['organizationId', 'id', 'createdAt', 'updatedAt'].includes(fname)) {
            return { name: fname, type: 'string' };
          }
          throw fail('DXOS_INVALID_FIELD', 400, `Trường "${fname}" không tồn tại hoặc không hỗ trợ trong "${collection}".`);
        }
        if (roleAllowedSet && !roleAllowedSet.has(fname)) {
          if (!(allowSystemFilterField && ['organizationId', 'id'].includes(fname))) {
            throw fail('DXOS_FIELD_FORBIDDEN', 403, `Vai trò hiện tại không có quyền truy cập trường "${fname}".`);
          }
        }
        return meta;
      };

      const groupBy = input.groupBy !== undefined && input.groupBy !== null ? String(input.groupBy).trim() : '';
      if (chartType !== 'kpi' && !groupBy) {
        throw fail('DXOS_GROUP_BY_REQUIRED', 400, `Biểu đồ "${chartType}" yêu cầu trường groupBy.`);
      }
      if (groupBy) {
        assertValidField(groupBy);
      }

      const secondaryGroupBy = input.secondaryGroupBy !== undefined && input.secondaryGroupBy !== null
        ? String(input.secondaryGroupBy).trim()
        : '';
      if (chartType === 'pivot') {
        if (!secondaryGroupBy) {
          throw fail('DXOS_SECONDARY_GROUP_BY_REQUIRED', 400, 'Biểu đồ bảng chéo (Pivot) yêu cầu chọn trường nhóm phụ (secondaryGroupBy).');
        }
        assertValidField(secondaryGroupBy);
        if (secondaryGroupBy === groupBy) {
          throw fail('DXOS_INVALID_FIELD', 400, 'Trường nhóm phụ (Cột Pivot) phải khác trường nhóm chính.');
        }
      }

      const NUMERIC_FIELD_TYPES = new Set(['integer', 'float', 'double', 'bigint', 'decimal', 'number']);
      const NUMERIC_FIELD_INTERFACES = new Set(['number', 'integer', 'float', 'percent']);
      const isNumericServerField = (meta) => {
        const ftype = String(meta?.type || '').trim().toLowerCase();
        if (NUMERIC_FIELD_TYPES.has(ftype)) return true;
        if (ftype === 'formula') {
          const dataType = String(meta?.dataType || '').trim().toLowerCase();
          const iface = String(meta?.interface || '').trim().toLowerCase();
          return NUMERIC_FIELD_TYPES.has(dataType) || NUMERIC_FIELD_INTERFACES.has(iface);
        }
        return false;
      };
      if (op !== 'count') {
        if (!metricField) {
          throw fail('DXOS_METRIC_FIELD_REQUIRED', 400, `Phép tính "${op}" yêu cầu trường số (metric.field).`);
        }
        const mFieldMeta = assertValidField(metricField);
        if (!isNumericServerField(mFieldMeta)) {
          throw fail('DXOS_NUMERIC_FIELD_REQUIRED', 400, `Trường "${metricField}" phải có kiểu số để tính "${op}".`);
        }
      } else if (metricField) {
        assertValidField(metricField);
      }

      const safeFilter = assertSafeFilter(input.filter);
      if (safeFilter !== null && (Array.isArray(safeFilter) || typeof safeFilter !== 'object')) {
        throw fail('DXOS_INVALID_FILTER', 400, 'Bộ lọc truy vấn phải là một đối tượng JSON hợp lệ.');
      }
      const validateFilterKeys = (node) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
          for (const item of node) validateFilterKeys(item);
          return;
        }
        for (const k of Object.getOwnPropertyNames(node)) {
          if (!k.startsWith('$')) {
            assertValidField(k, { allowSystemFilterField: true });
            if (node[k] && typeof node[k] === 'object') {
              validateFilterKeys(node[k]);
            }
          } else {
            if (k.toLowerCase() === '$col') {
              if (typeof node[k] !== 'string' || !node[k].trim()) {
                throw fail('DXOS_INVALID_FILTER', 400, 'Giá trị toán tử $col trong bộ lọc phải là tên trường hợp lệ.');
              }
              assertValidField(node[k], { allowSystemFilterField: true });
            } else {
              validateFilterKeys(node[k]);
            }
          }
        }
      };
      if (safeFilter && typeof safeFilter === 'object') {
        validateFilterKeys(safeFilter);
      }

      const activeRole = String(ctx.state?.currentRole || '').trim();
      const enforceOwnScope = !isRoot && OWN_SCOPED_COLLECTIONS.has(collection) && !ORG_WIDE_PROPOSAL_ROLES.has(activeRole);
      const BATCH_SIZE = 500;
      const MAX_SCAN = 5000;

      const queryResult = await runWithOptionalRls(db, effectiveOrg, async (transaction) => {
        const clauses = [];
        if (effectiveOrg) clauses.push({ organizationId: effectiveOrg });
        if (enforceOwnScope) {
          const ownerClauses = buildOwnerFilterClauses(db, collection, actor);
          if (ownerClauses.length) clauses.push({ $or: ownerClauses });
        }
        if (safeFilter && typeof safeFilter === 'object' && !Array.isArray(safeFilter) && Object.keys(safeFilter).length) {
          clauses.push(safeFilter);
        }
        const dbFilter = clauses.length === 0 ? {} : clauses.length === 1 ? clauses[0] : { $and: clauses };

        const collected = [];
        let offset = 0;
        let truncated = false;
        while (collected.length < MAX_SCAN) {
          const batch = (await repo.find({
            filter: dbFilter,
            limit: BATCH_SIZE,
            offset,
            sort: ['-id'],
            ...(transaction ? { transaction } : {}),
          })) || [];
          const scopedBatch = enforceOwnScope
            ? batch.filter((r) => isRecordOwnedByActor(r, actor))
            : batch;
          for (const row of scopedBatch) {
            collected.push(row);
            if (collected.length >= MAX_SCAN) break;
          }
          if (batch.length < BATCH_SIZE) break;
          offset += BATCH_SIZE;
          if (collected.length >= MAX_SCAN) {
            truncated = true;
            break;
          }
        }
        return { rows: collected, truncated };
      });

      const createAcc = () => ({ count: 0, nonNullCount: 0, numericCount: 0, sum: 0, min: null, max: null });
      const updateAcc = (acc, rawMetricVal) => {
        acc.count += 1;
        if (rawMetricVal !== undefined && rawMetricVal !== null && rawMetricVal !== '') {
          acc.nonNullCount += 1;
        }
        if (op !== 'count') {
          const isValidMetricInput = (
            (typeof rawMetricVal === 'number' && Number.isFinite(rawMetricVal))
            || (typeof rawMetricVal === 'string' && rawMetricVal.trim() !== '')
          );
          if (isValidMetricInput) {
            const num = Number(rawMetricVal);
            if (Number.isFinite(num)) {
              acc.numericCount += 1;
              acc.sum += num;
              acc.min = acc.min === null ? num : Math.min(acc.min, num);
              acc.max = acc.max === null ? num : Math.max(acc.max, num);
            }
          }
        }
      };
      const finalizeAcc = (acc) => {
        if (op === 'count') {
          const c = metricField ? acc.nonNullCount : acc.count;
          return { count: acc.count, sum: c, avg: c, min: c, max: c, value: c };
        }
        const avg = acc.numericCount > 0 ? acc.sum / acc.numericCount : 0;
        const min = acc.min ?? 0;
        const max = acc.max ?? 0;
        const value = op === 'sum' ? acc.sum : op === 'avg' ? avg : op === 'min' ? min : max;
        return { count: acc.count, sum: acc.sum, avg, min, max, value };
      };
      const mergeAcc = (target, source) => {
        if (!source) return target;
        target.count += source.count;
        target.nonNullCount += source.nonNullCount;
        target.numericCount += source.numericCount;
        target.sum += source.sum;
        if (source.min !== null) {
          target.min = target.min === null ? source.min : Math.min(target.min, source.min);
        }
        if (source.max !== null) {
          target.max = target.max === null ? source.max : Math.max(target.max, source.max);
        }
        return target;
      };
      const normGroupKey = (raw) => {
        if (raw === undefined || raw === null || raw === '') return '(Trống)';
        return String(raw);
      };

      const totalAcc = createAcc();
      const groupMap = new Map();
      const pivotRowColMap = new Map();
      const pivotColsSet = new Set();

      for (const row of queryResult.rows) {
        const rawMetricVal = metricField ? val(row, metricField) : undefined;
        updateAcc(totalAcc, rawMetricVal);

        if (groupBy) {
          const gKey = normGroupKey(val(row, groupBy));
          let gAcc = groupMap.get(gKey);
          if (!gAcc) {
            gAcc = createAcc();
            groupMap.set(gKey, gAcc);
          }
          updateAcc(gAcc, rawMetricVal);

          if (chartType === 'pivot' && secondaryGroupBy) {
            const cKey = normGroupKey(val(row, secondaryGroupBy));
            pivotColsSet.add(cKey);
            let colMap = pivotRowColMap.get(gKey);
            if (!colMap) {
              colMap = new Map();
              pivotRowColMap.set(gKey, colMap);
            }
            let cellAcc = colMap.get(cKey);
            if (!cellAcc) {
              cellAcc = createAcc();
              colMap.set(cKey, cellAcc);
            }
            updateAcc(cellAcc, rawMetricVal);
          }
        }
      }

      const rawSeries = [...groupMap.entries()].map(([key, acc]) => {
        const stats = finalizeAcc(acc);
        return {
          key,
          label: key,
          ...stats,
        };
      });
      rawSeries.sort((a, b) => (b.value - a.value) || a.key.localeCompare(b.key));
      const series = rawSeries.slice(0, limit);

      const summaryStats = finalizeAcc(totalAcc);
      const summary = {
        ...summaryStats,
        op,
        field: metricField || null,
        groupCount: groupMap.size,
      };

      let pivotMatrix = null;
      if (chartType === 'pivot') {
        const rowsList = series.map((s) => s.key);
        const colsList = [...pivotColsSet].slice(0, limit);
        const cells = Object.create(null);
        const rowTotals = Object.create(null);
        const colTotalsAcc = new Map();
        const grandAcc = createAcc();

        for (const rKey of rowsList) {
          const rowCells = Object.create(null);
          const colMap = pivotRowColMap.get(rKey) || new Map();
          const rowAcc = createAcc();
          for (const cKey of colsList) {
            const cAcc = colMap.get(cKey);
            const cellVal = cAcc ? finalizeAcc(cAcc).value : 0;
            Object.defineProperty(rowCells, cKey, { value: cellVal, enumerable: true, configurable: true, writable: true });
            if (cAcc) {
              mergeAcc(rowAcc, cAcc);

              let totC = colTotalsAcc.get(cKey);
              if (!totC) {
                totC = createAcc();
                colTotalsAcc.set(cKey, totC);
              }
              mergeAcc(totC, cAcc);
              mergeAcc(grandAcc, cAcc);
            }
          }
          Object.defineProperty(cells, rKey, { value: rowCells, enumerable: true, configurable: true, writable: true });
          Object.defineProperty(rowTotals, rKey, { value: finalizeAcc(rowAcc).value, enumerable: true, configurable: true, writable: true });
        }

        const colTotals = Object.create(null);
        for (const cKey of colsList) {
          const cAcc = colTotalsAcc.get(cKey);
          Object.defineProperty(colTotals, cKey, {
            value: cAcc ? finalizeAcc(cAcc).value : 0,
            enumerable: true,
            configurable: true,
            writable: true,
          });
        }

        const grandTotal = finalizeAcc(grandAcc).value;

        pivotMatrix = {
          rowField: groupBy,
          colField: secondaryGroupBy,
          rows: rowsList,
          columns: colsList,
          cells,
          rowTotals,
          colTotals,
          grandTotal,
        };
      }

      ctx.body = {
        ok: true,
        collection,
        chartType,
        series,
        summary,
        pivotMatrix,
        totalRows: queryResult.rows.length,
        meta: {
          organizationId: effectiveOrg,
          preview: Boolean(isRoot && !effectiveOrg),
          groupBy: groupBy || null,
          secondaryGroupBy: chartType === 'pivot' ? secondaryGroupBy : null,
          metric: { op, ...(metricField ? { field: metricField } : {}) },
          limit,
          truncated: queryResult.truncated,
        },
      };
      return next();
    },
  };
}

module.exports = {
  ALLOWED_PROPOSAL_COLLECTIONS,
  CUSTOM_COLLECTION_RE,
  META_EXCLUDED_COLLECTIONS,
  createDxosBlocksActions,
  resolveCallerContext,
  resolveTelemetryIngestAuth,
};
