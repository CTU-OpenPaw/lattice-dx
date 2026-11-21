/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { defineToolSchema } = require('./schema-helper');
const { recordAiAuditLog } = require('./ai-schemas');
const { createBuilderTools } = require('./ai-builder-tools');
const { createCopilotTools } = require('./ai-copilot-tools');
const { createSurfaceAndCreativeTools } = require('./ai-surface-creative-tools');

const ADMIN_BUILDER_TOOL_NAMES = [
  'dxos_inspect_architecture',
  'dxos_recommend_page_blueprint',
  'dxos_design_creative_block',
  'dxos_compose_page_blocks',
  'dxos_snapshot_or_rollback_page',
  'dxos_provision_role_workspace',
  'dxos_manage_portal_and_acl',
  'dxos_extend_collection_schema',
  'dxos_manage_rbac_permissions',
  'dxos_deploy_workflow',
  'dxos_configure_workflow',
];

const OPERATIONAL_TOOL_NAMES = [
  'dxos_search_enterprise_context',
  'dxos_execute_record_action',
  'dxos_my_tasks_copilot',
  'dxos_orchestrate_enterprise_case',
];

const WRITABLE_BUSINESS_COLLECTIONS = new Set([
  'latticeServiceTickets',
  'latticeOrders',
  'latticeRequests',
  'latticeParaDocuments',
]);

const PROTECTED_SERVER_FIELDS = new Set([
  'id', 'createdAt', 'updatedAt', 'organizationId', 'status', 'version',
  'requesterId', 'assigneeId', 'ownerId', 'decisionReason', 'resolutionNote', 'handlerId',
]);

const SYSTEM_PROTECTED_COLLECTIONS = new Set([
  'users', 'roles', 'rolesUsers', 'apiKeys', 'authenticators', 'migrations',
  'applicationPlugins', 'aiSettings', 'aiEmployees', 'aiMcpClients',
  'rolesAiEmployees', 'latticeAiAuditLogs', 'latticeAiProfiles', 'latticeUiSnapshots',
  'dataSourcesRoles', 'dataSourcesRolesResources', 'dataSourcesRolesResourcesActions',
  'dataSourcesRolesResourcesScopes',
]);

const CUSTOM_COLLECTION_RE = /^latticeCustom[A-Z][A-Za-z0-9]{1,40}$/;
const FIELD_NAME_RE = /^[a-z][a-zA-Z0-9_]{1,48}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const ALLOWED_BLOCK_MODELS = [
  'DxosPortalHeroBlockModel', 'DxosKpiMetricBlockModel', 'DxosContextTelemetryBlockModel',
  'DxosAiProposalBlockModel', 'DxosWorkflowTasksBlockModel', 'DxosParaVaultBlockModel',
  'DxosCreativeStudioBlockModel',
  'NativeTableBlock', 'NativeFormBlock', 'NativeDetailsBlock',
  'table', 'createForm', 'editForm', 'details', 'filterForm', 'kanban', 'chart', 'calendar', 'list', 'gridCard', 'markdown', 'actionPanel',
];
const SEARCHABLE_COLLECTIONS = [
  'latticeOrders', 'latticeRequests', 'latticeServiceTickets',
  'latticeIncidentCases', 'latticeAssets', 'latticeParaDocuments',
];

const val = (row, key) => (typeof row?.get === 'function' ? row.get(key) : row?.[key]);

function failTool(code, status, message) {
  return Object.assign(new Error(message || code), { code, status });
}

async function resolveCallerRoleNames(ctx, db, userId) {
  const raw = Array.isArray(ctx?.state?.currentRoles) && ctx.state.currentRoles.length
    ? ctx.state.currentRoles
    : ctx?.state?.currentRole ? [ctx.state.currentRole] : [];
  const direct = raw.map((r) => String(r || '').trim()).filter(Boolean);
  if (direct.length) return [...new Set(direct)];
  if (!userId) return [];
  const rolesUsersRepo = db?.getRepository?.('rolesUsers');
  if (!rolesUsersRepo || typeof rolesUsersRepo.find !== 'function') return [];
  const rows = (await rolesUsersRepo.find({ filter: { userId } })) || [];
  return [...new Set(rows.map((r) => val(r, 'roleName')).filter(Boolean))];
}

async function isStudioAdmin(ctx, db) {
  const user = ctx?.state?.currentUser || ctx?.auth?.user;
  const userId = val(user, 'id');
  if (!user) return false;
  const roleNames = await resolveCallerRoleNames(ctx, db, userId);
  if (roleNames.includes('root') || roleNames.includes('admin')) return true;
  const rolesRepo = db?.getRepository?.('roles');
  if (!rolesRepo || !roleNames.length) return false;
  const matched = (await rolesRepo.find({ filter: { name: { $in: roleNames } } })) || [];
  return matched.some((r) => {
    if (val(r, 'allowConfigure') === true) return true;
    const snippets = val(r, 'snippets');
    return Array.isArray(snippets) && (snippets.includes('pm') || snippets.includes('pm.*'));
  });
}

async function resolveActorScope(ctx, db) {
  const user = ctx?.state?.currentUser || ctx?.auth?.user;
  const userId = val(user, 'id');
  if (!userId) throw failTool('NATIVE_LOGIN_REQUIRED', 401, 'Yêu cầu đăng nhập để thực thi công cụ.');
  const targetDb = db || ctx.db;
  const roleNames = await resolveCallerRoleNames(ctx, targetDb, userId);
  const isAdmin = await isStudioAdmin(ctx, targetDb);
  const empRepo = targetDb?.getRepository?.('latticeEmployees');
  let employee = null;
  if (empRepo) {
    const rows = (await empRepo.find({ filter: { userId, active: true }, limit: 1 })) || [];
    employee = rows[0] || null;
  }
  if (!isAdmin && (!employee || !val(employee, 'organizationId'))) {
    throw failTool('ORG_MEMBERSHIP_REQUIRED', 403, 'Tài khoản chưa gắn nhân sự đang hoạt động trong tổ chức.');
  }
  return {
    userId,
    username: val(user, 'username') || val(user, 'nickname') || `user-${userId}`,
    roleNames,
    isAdmin,
    employeeId: val(employee, 'id') || null,
    organizationId: val(employee, 'organizationId') || String(ctx?.state?.defaultOrgId || 'native-ui-lab'),
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

async function invokeResourceAction(ctx, resourceName, actionName, { filterByTk, values } = {}) {
  const resource = safeGetResource(ctx, resourceName);
  const handler = resource?.actions?.get?.(actionName)?.handler || resource?.actions?.[actionName];
  if (typeof handler !== 'function') {
    throw failTool('HOST_ACTION_UNAVAILABLE', 503, `Dịch vụ ${resourceName}:${actionName} chưa sẵn sàng.`);
  }
  const params = { resourceName, actionName, ...(filterByTk != null ? { filterByTk } : {}), ...(values ? { values } : {}) };
  const subCtx = {
    app: ctx.app,
    db: ctx.db,
    dataSource: ctx.dataSource || ctx.app?.mainDataSource,
    state: { ...ctx.state },
    auth: ctx.auth,
    getCurrentLocale: ctx.getCurrentLocale?.bind(ctx),
    i18n: ctx.i18n,
    action: {
      actionName,
      resourceName,
      params,
      mergeParams: (patch) => {
        if (patch && typeof patch === 'object') Object.assign(params, patch);
      },
    },
    request: { headers: {} },
    body: null,
    throw: (s, m) => { throw failTool('HOST_ACTION_ERROR', s, m); },
  };
  await handler(subCtx, async () => {});
  if (subCtx.status && subCtx.status >= 400) {
    throw failTool('HOST_ACTION_ERROR', subCtx.status, subCtx.body?.errors?.[0]?.message || `${resourceName}:${actionName} failed`);
  }
  return subCtx.body?.data || subCtx.body || {};
}

function createAuditedTool(spec) {
  const schemaHelper = defineToolSchema(spec.schema);
  return {
    scope: 'CUSTOM',
    from: 'loader',
    execution: 'backend',
    defaultPermission: spec.defaultPermission || 'ASK',
    silence: false,
    introduction: spec.introduction,
    definition: {
      name: spec.name,
      description: spec.description,
      schema: schemaHelper.zodSchema || schemaHelper.jsonSchema,
    },
    jsonSchema: schemaHelper.jsonSchema,
    adminOnly: Boolean(spec.adminOnly),
    validateArgs: schemaHelper.validate,
    async invoke(ctx, rawArgs = {}) {
      const started = Date.now();
      const db = ctx?.db || ctx?.app?.db;
      const channel = ctx?.state?.dxosAuditChannel || 'ai-tool';
      const aiEmployee = ctx?.state?.dxosAiUsername || null;
      let actor = null;
      try {
        actor = await resolveActorScope(ctx, db);
        if (spec.adminOnly && !actor.isAdmin) {
          throw failTool('DXOS_ADMIN_REQUIRED', 403, `Công cụ "${spec.name}" chỉ dành cho Quản trị viên.`);
        }
        const checked = schemaHelper.validate(rawArgs);
        if (!checked.ok) throw failTool('TOOL_ARGS_INVALID', 400, checked.error);
        const result = await spec.run(ctx, db, actor, checked.value);
        await recordAiAuditLog(db, {
          actorUserId: actor.userId,
          actorUsername: actor.username,
          organizationId: actor.organizationId,
          channel,
          aiEmployee,
          toolName: spec.name,
          argsSummary: checked.value,
          status: result?.degraded ? 'degraded' : 'allowed',
          durationMs: Date.now() - started,
          resultSummary: JSON.stringify(result).slice(0, 600),
        });
        return result;
      } catch (err) {
        await recordAiAuditLog(db, {
          actorUserId: actor?.userId ?? ctx?.state?.currentUser?.id ?? null,
          actorUsername: actor?.username ?? ctx?.state?.currentUser?.username ?? null,
          organizationId: actor?.organizationId ?? null,
          channel,
          aiEmployee,
          toolName: spec.name,
          argsSummary: rawArgs,
          status: err?.status === 403 || err?.status === 401 ? 'denied' : 'error',
          durationMs: Date.now() - started,
          errorCode: err?.code || 'TOOL_ERROR',
          resultSummary: err?.message || 'Tool execution failed',
        });
        throw err;
      }
    },
  };
}

function createDxosTools() {
  const shared = {
    val,
    failTool,
    resolveCallerRoleNames,
    isStudioAdmin,
    resolveActorScope,
    safeGetResource,
    invokeResourceAction,
    createAuditedTool,
    ADMIN_BUILDER_TOOL_NAMES,
    WRITABLE_BUSINESS_COLLECTIONS,
    PROTECTED_SERVER_FIELDS,
    SYSTEM_PROTECTED_COLLECTIONS,
    CUSTOM_COLLECTION_RE,
    FIELD_NAME_RE,
    SLUG_RE,
    ALLOWED_BLOCK_MODELS,
    SEARCHABLE_COLLECTIONS,
  };
  return [
    ...createBuilderTools(shared),
    ...createSurfaceAndCreativeTools(shared),
    ...createCopilotTools(shared),
  ];
}

function registerDxosToolsWithHost(appOrPlugin) {
  const tools = createDxosTools();
  const candidates = [
    appOrPlugin?.ai?.toolsManager,
    appOrPlugin?.app?.aiManager?.toolsManager,
    appOrPlugin?.app?.pm?.get?.('ai')?.ai?.toolsManager,
    appOrPlugin?.toolsManager,
  ];
  const seen = new Set();
  let registered = false;
  for (const tm of candidates) {
    if (tm && !seen.has(tm) && typeof tm.registerTools === 'function') {
      seen.add(tm);
      tm.registerTools(tools);
      registered = true;
    }
  }
  return registered ? tools.map((t) => t.definition.name) : [];
}

module.exports = {
  ADMIN_BUILDER_TOOL_NAMES,
  OPERATIONAL_TOOL_NAMES,
  WRITABLE_BUSINESS_COLLECTIONS,
  PROTECTED_SERVER_FIELDS,
  SYSTEM_PROTECTED_COLLECTIONS,
  CUSTOM_COLLECTION_RE,
  FIELD_NAME_RE,
  SLUG_RE,
  ALLOWED_BLOCK_MODELS,
  SEARCHABLE_COLLECTIONS,
  val,
  failTool,
  resolveCallerRoleNames,
  isStudioAdmin,
  resolveActorScope,
  safeGetResource,
  invokeResourceAction,
  createAuditedTool,
  createDxosTools,
  registerDxosToolsWithHost,
};
