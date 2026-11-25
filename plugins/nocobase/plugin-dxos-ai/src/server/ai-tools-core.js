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
const { recordAiAuditLog, redactAuditText, normalizeToolPermissionsMap, resolveDefaultOrganizationId } = require('./ai-schemas');
const { runWithTenantRls, runWithSystemRlsBypass } = require('./ai-rls');
const {
  redactPiiText,
  redactPiiDeep,
  estimateTokens,
  normalizeTokenUsage,
  estimateCostUsd,
  checkAndConsumeAiQuota,
  hydrateQuotaBucketFromDb,
  recordQuotaUsagePersistent,
} = require('./ai-governance');
const { createBuilderTools } = require('./ai-builder-tools');
const { createOperationalTools } = require('./ai-operational-tools');
const { createSurfaceAndCreativeTools } = require('./ai-surface-creative-tools');
const {
  orchestrateEnterpriseAppBuild,
  verifyEnterpriseApp,
  listBuiltApps,
  rebuildEnterpriseApp,
  exportAppBundle,
  teardownBuiltApp,
} = require('./app-builder-orchestrator');

const ORCHESTRATOR_OPS = new Set([
  'build_enterprise_app',
  'verify_app',
  'list_built_apps',
  'rebuild_enterprise_app',
  'export_app_bundle',
  'teardown_built_app',
]);

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
  'dxos_my_workflow_tasks',
  'dxos_orchestrate_enterprise_case',
  'dxos_graph_impact_analysis',
  'dxos_alarm_action',
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
  'applicationPlugins', 'applicationTokens', 'sessions',
  'aiSettings', 'aiEmployees', 'aiMcpClients', 'rolesAiEmployees',
  'latticeAiAuditLogs', 'latticeAiProfiles', 'latticeAiQuotaUsage', 'latticeUiSnapshots',
  'dataSourcesRoles', 'dataSourcesRolesResources', 'dataSourcesRolesResourcesActions',
  'dataSourcesRolesResourcesScopes',
  'llmServices', 'rolesDesktopRoutes', 'desktopRoutes', 'uiLayouts',
  'workflows', 'flow_nodes', 'collections', 'fields',
  'latticeNotifications', 'latticeSlaPolicies', 'latticeAiApprovalQueue', 'latticeParaChunks',
  'latticeBuiltApps',
]);
const SYSTEM_PROTECTED_COLLECTIONS_LOWER = new Set(
  [...SYSTEM_PROTECTED_COLLECTIONS].map((c) => c.toLowerCase()),
);

function isProtectedCollection(name) {
  const s = String(name || '').trim();
  return SYSTEM_PROTECTED_COLLECTIONS.has(s) || SYSTEM_PROTECTED_COLLECTIONS_LOWER.has(s.toLowerCase());
}

const CUSTOM_COLLECTION_RE = /^latticeCustom[A-Z][A-Za-z0-9]{1,40}$/;
const FIELD_NAME_RE = /^[a-z][a-zA-Z0-9_]{1,48}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const ALLOWED_BLOCK_MODELS = [
  'DxosPortalHeroBlockModel', 'DxosKpiMetricBlockModel', 'DxosContextTelemetryBlockModel',
  'DxosAiProposalBlockModel', 'DxosWorkflowTasksBlockModel', 'DxosParaVaultBlockModel',
  'DxosCreativeStudioBlockModel', 'DxosRecordWorkbenchBlockModel',
  'DxosWebGisBlockModel', 'DxosKanbanScheduleBlockModel', 'DxosWmsOpsBlockModel',
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
  const headerRole = String(ctx?.headers?.['x-role'] || ctx?.request?.headers?.['x-role'] || '').trim();
  const stateRole = String(ctx?.state?.currentRole || '').trim();
  const stateRoles = Array.isArray(ctx?.state?.currentRoles)
    ? [...new Set(ctx.state.currentRoles.map((r) => String(r || '').trim()).filter(Boolean))]
    : [];

  let dbRoles = [];
  if (userId) {
    const rolesUsersRepo = db?.getRepository?.('rolesUsers');
    if (rolesUsersRepo && typeof rolesUsersRepo.find === 'function') {
      const rows = (await rolesUsersRepo.find({ filter: { userId } })) || [];
      dbRoles = [...new Set(rows.map((r) => val(r, 'roleName')).filter(Boolean))];
    }
  }

  const knownRoles = stateRoles.length ? stateRoles : dbRoles;
  const activeRole = headerRole || stateRole;
  if (activeRole) {
    if (knownRoles.length) {
      if (knownRoles.includes(activeRole)) return [activeRole];
      return knownRoles;
    }
    if (!headerRole) return [activeRole];
  }
  if (knownRoles.length) return knownRoles;
  return stateRole ? [stateRole] : [];
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

async function resolveActorScope(ctx, db, { defaultFallback = 'native-ui-lab' } = {}) {
  const user = ctx?.state?.currentUser || ctx?.auth?.user;
  const userId = val(user, 'id');
  if (!userId) throw failTool('NATIVE_LOGIN_REQUIRED', 401, 'Yêu cầu đăng nhập để thực thi công cụ.');
  const targetDb = db || ctx.db;
  const roleNames = await resolveCallerRoleNames(ctx, targetDb, userId);
  const isAdmin = await isStudioAdmin(ctx, targetDb);
  const isRoot = roleNames.includes('root');
  const empRepo = targetDb?.getRepository?.('latticeEmployees');
  let employee = null;
  if (empRepo) {
    const rows = (await runWithSystemRlsBypass(targetDb, () => empRepo.find({ filter: { userId, active: true }, limit: 1 }))) || [];
    employee = rows[0] || null;
  }
  if (!isAdmin && (!employee || !val(employee, 'organizationId'))) {
    throw failTool('ORG_MEMBERSHIP_REQUIRED', 403, 'Tài khoản chưa gắn nhân sự đang hoạt động trong tổ chức.');
  }
  const targetOrgOverride = isRoot && ctx?.state?.dxosTargetOrganizationId
    ? String(ctx.state.dxosTargetOrganizationId).trim()
    : '';
  const empOrg = val(employee, 'organizationId') || '';
  const organizationId = targetOrgOverride
    || empOrg
    || (await resolveDefaultOrganizationId(targetDb, { ctx, fallback: defaultFallback }));
  const employeeId = (targetOrgOverride && empOrg && empOrg !== targetOrgOverride)
    ? null
    : (val(employee, 'id') || null);
  return {
    userId,
    username: val(user, 'username') || val(user, 'nickname') || `user-${userId}`,
    roleNames,
    isAdmin,
    isRoot,
    employeeId,
    organizationId,
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

async function invokeResourceAction(ctx, resourceName, actionName, options = {}) {
  const { filterByTk, values, method, ...extraParams } = options && typeof options === 'object' ? options : {};
  const resource = safeGetResource(ctx, resourceName);
  const handler = resource?.actions?.get?.(actionName)?.handler || resource?.actions?.[actionName];
  if (typeof handler !== 'function') {
    throw failTool('HOST_ACTION_UNAVAILABLE', 503, `Dịch vụ ${resourceName}:${actionName} chưa sẵn sàng.`);
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
      const promptTokens = estimateTokens(rawArgs);
      try {
        actor = await resolveActorScope(ctx, db);
        if (spec.adminOnly && !actor.isAdmin) {
          throw failTool('DXOS_ADMIN_REQUIRED', 403, `Công cụ "${spec.name}" chỉ dành cho Quản trị viên.`);
        }
        const isHitlApprovedReplay = Boolean(ctx?.state?.dxosApprovedQueueId);
        const aiEmployeeName = String(aiEmployee || '').trim().toLowerCase();
        if (aiEmployeeName && !isHitlApprovedReplay) {
          const profRepo = db?.getRepository?.('latticeAiProfiles');
          if (profRepo && typeof profRepo.findOne === 'function') {
            const profile = await runWithTenantRls(db, actor.organizationId, () => profRepo.findOne({ filter: { username: aiEmployeeName } }));
            const matchedUsername = String(val(profile, 'username') || '').trim().toLowerCase();
            if (profile && (!matchedUsername || matchedUsername === aiEmployeeName)) {
              if (val(profile, 'enabled') === false) {
                throw failTool('TOOL_PERMISSION_OFF', 403, `Hồ sơ AI "${aiEmployeeName}" đang bị vô hiệu hóa.`);
              }
              const rawPerms = val(profile, 'toolPermissions') ?? val(profile, 'toolPermissionsJson');
              if (rawPerms && (typeof rawPerms === 'object' || typeof rawPerms === 'string')) {
                const perms = normalizeToolPermissionsMap(rawPerms);
                if (Object.prototype.hasOwnProperty.call(perms, spec.name) && String(perms[spec.name] || '').trim().toUpperCase() === 'OFF') {
                  throw failTool('TOOL_PERMISSION_OFF', 403, `Công cụ ${spec.name} đang tắt trên hồ sơ AI này.`);
                }
              }
            }
          }
        }
        if (!isHitlApprovedReplay) {
          await hydrateQuotaBucketFromDb(db, actor.organizationId);
          checkAndConsumeAiQuota(actor, { estimatedPromptTokens: promptTokens, env: process.env });
        }
        let normalizedRawArgs = rawArgs;
        if (typeof normalizedRawArgs === 'string' && normalizedRawArgs.trim().startsWith('{')) {
          try {
            normalizedRawArgs = JSON.parse(normalizedRawArgs);
          } catch {
            // Preserve malformed JSON string so schemaHelper.validate reports the validation error
          }
        }
        const preparedArgs = typeof spec.prepareArgs === 'function' ? spec.prepareArgs(normalizedRawArgs) : normalizedRawArgs;
        const checked = schemaHelper.validate(preparedArgs);
        if (!checked.ok) throw failTool('TOOL_ARGS_INVALID', 400, checked.error);
        const skipOuterTx = spec.name === 'dxos_provision_role_workspace'
          && ORCHESTRATOR_OPS.has(checked.value?.operation);
        const result = skipOuterTx
          ? await spec.run(ctx, db, actor, checked.value)
          : await runWithTenantRls(db, actor.organizationId, () => spec.run(ctx, db, actor, checked.value));
        const estCompletion = estimateTokens(result);
        const providerUsage = result?.usage || result?._llmUsage || ctx?.state?.dxosLlmUsage || null;
        const usageInfo = normalizeTokenUsage(
          providerUsage
            ? { usage: providerUsage }
            : { promptTokens, completionTokens: estCompletion, tokenSource: 'estimated' },
          promptTokens,
          estCompletion,
        );
        const modelName = ctx?.state?.dxosModelName || ctx?.state?.modelName || '';
        const estimatedCostUsd = isHitlApprovedReplay
          ? 0
          : estimateCostUsd(usageInfo.promptTokens, usageInfo.completionTokens, modelName, process.env);
        const redactedArgs = redactPiiDeep(checked.value);
        const redactedRes = redactPiiText(redactAuditText(JSON.stringify(result).slice(0, 600)));
        const piiRedactedCount = redactedArgs.count + redactedRes.count;
        const usagePayload = {
          promptTokens: usageInfo.promptTokens,
          completionTokens: usageInfo.completionTokens,
          totalTokens: usageInfo.totalTokens,
        };
        if (!isHitlApprovedReplay) {
          await recordQuotaUsagePersistent(db, actor, {
            promptTokens: usageInfo.promptTokens,
            completionTokens: usageInfo.completionTokens,
            totalTokens: usageInfo.totalTokens,
            usage: providerUsage || usagePayload,
            tokenSource: usageInfo.tokenSource,
            costUsd: estimatedCostUsd,
            piiRedactedCount,
          });
        }
        await recordAiAuditLog(db, {
          actorUserId: actor.userId,
          actorUsername: actor.username,
          organizationId: actor.organizationId,
          channel,
          aiEmployee,
          toolName: spec.name,
          argsSummary: redactedArgs.value,
          status: result?.degraded ? 'degraded' : 'allowed',
          durationMs: Date.now() - started,
          promptTokens: usageInfo.promptTokens,
          completionTokens: usageInfo.completionTokens,
          totalTokens: usageInfo.totalTokens,
          usage: providerUsage || usagePayload,
          tokenSource: usageInfo.tokenSource,
          estimatedCostUsd,
          piiRedactedCount,
          resultSummary: redactedRes.text,
        });
        return result;
      } catch (err) {
        const redactedArgs = redactPiiDeep(rawArgs);
        const redactedErr = redactPiiText(redactAuditText(err?.message || 'Tool execution failed'));
        await recordAiAuditLog(db, {
          actorUserId: actor?.userId ?? ctx?.state?.currentUser?.id ?? null,
          actorUsername: actor?.username ?? ctx?.state?.currentUser?.username ?? null,
          organizationId: actor?.organizationId ?? null,
          channel,
          aiEmployee,
          toolName: spec.name,
          argsSummary: redactedArgs.value,
          status: err?.status === 403 || err?.status === 401 || err?.status === 429 ? 'denied' : 'error',
          durationMs: Date.now() - started,
          promptTokens,
          completionTokens: 0,
          totalTokens: promptTokens,
          tokenSource: 'estimated',
          estimatedCostUsd: estimateCostUsd(promptTokens, 0, '', process.env),
          piiRedactedCount: redactedArgs.count + redactedErr.count,
          errorCode: err?.code || 'TOOL_ERROR',
          resultSummary: redactedErr.text,
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
    resolveReadablePolicies,
    isRowVisibleToActor,
    safeGetResource,
    invokeResourceAction,
    createAuditedTool,
    redactPiiText,
    redactPiiDeep,
    ADMIN_BUILDER_TOOL_NAMES,
    WRITABLE_BUSINESS_COLLECTIONS,
    PROTECTED_SERVER_FIELDS,
    SYSTEM_PROTECTED_COLLECTIONS,
    isProtectedCollection,
    CUSTOM_COLLECTION_RE,
    FIELD_NAME_RE,
    SLUG_RE,
    ALLOWED_BLOCK_MODELS,
    SEARCHABLE_COLLECTIONS,
  };
  const surfaceTools = createSurfaceAndCreativeTools(shared).map((tool) => {
    if (tool?.definition?.name !== 'dxos_provision_role_workspace') return tool;
    const orchestratorTool = createAuditedTool({
      name: 'dxos_provision_role_workspace',
      adminOnly: true,
      defaultPermission: 'ASK',
      introduction: {
        title: 'Kiến trúc sư Ứng dụng Doanh nghiệp & Phân hệ Mới',
        about: 'Dựng trọn gói phân hệ (Snapshot + Schema/Relations/RLS/OpenAPI + RBAC + Portal 10 BlockModels + DMN + LatticeFlow v2 + Stock n8n + Verifier & 2-round Self-Healing) hoặc kiểm chứng ứng dụng.',
      },
      description: 'End-to-end Multi-Entity Enterprise App Builder & Workspace Architect: provision role/workspace/AI (default), build single/multi-entity enterprise app (build_enterprise_app), verify (verify_app), list_built_apps, rebuild_enterprise_app, export_app_bundle (v3), or teardown_built_app.',
      schema: {
        description: 'Role-to-Workspace & Full-Stack Multi-Entity Enterprise App Builder request.',
        properties: {
          operation: {
            type: 'string',
            default: 'provision_role_workspace',
            enum: [
              'provision_role_workspace',
              'build_enterprise_app',
              'verify_app',
              'list_built_apps',
              'rebuild_enterprise_app',
              'export_app_bundle',
              'teardown_built_app',
            ],
          },
          appKey: { type: 'string', maxLength: 120 },
          name: { type: 'string', maxLength: 160 },
          status: { type: 'string', maxLength: 32 },
          keepData: { type: 'boolean', default: true },
          specPatch: { type: 'object' },
          collections: { type: 'array', items: { type: 'object' } },
          roles: { type: 'array', items: { type: 'object' } },
          portals: { type: 'array', items: { type: 'object' } },
          dmnTables: { type: 'array', items: { type: 'object' } },
          flowGraphs: { type: 'array', items: { type: 'object' } },
          n8nWorkflows: { type: 'array', items: { type: 'object' } },
          roleName: { type: 'string', maxLength: 42 },
          roleTitle: { type: 'string', maxLength: 100 },
          portalSlug: { type: 'string', maxLength: 40 },
          pageTitle: { type: 'string', maxLength: 100 },
          collectionName: { type: 'string', maxLength: 64 },
          collectionTitle: { type: 'string', maxLength: 100 },
          fields: { type: 'array', items: { type: 'object' } },
          lockedFields: { type: 'array', items: { type: 'string' } },
          creativeTheme: { type: 'string', enum: ['industrial-cockpit', 'emerald-ops', 'amber-alert', 'royal-indigo', 'clean-light'], default: 'amber-alert' },
          blocks: { type: 'array', items: { type: 'object' } },
          dmnTable: { type: 'object' },
          dmnTableKey: { type: 'string', maxLength: 80 },
          flowGraph: { type: 'object' },
          flowRuleKey: { type: 'string', maxLength: 80 },
          n8nWorkflow: { type: 'object' },
          n8nWorkflowId: { type: 'string', maxLength: 80 },
          n8nConnectorKey: { type: 'string', maxLength: 64 },
          activateN8n: { type: 'boolean', default: true },
          maxHealRounds: { type: 'integer', default: 2 },
          target: { type: 'object' },
          aiUsername: { type: 'string', maxLength: 60 },
          aiNickname: { type: 'string', maxLength: 120 },
          dryRun: { type: 'boolean', default: false },
        },
      },
      async run(ctx, db, actor, args) {
        if (args.operation === 'verify_app') {
          const target = args.target && typeof args.target === 'object' ? { ...args.target } : {};
          return verifyEnterpriseApp(ctx, db, actor, {
            ...target,
            ...(args.collectionName ? { collectionName: args.collectionName } : {}),
            ...(args.portalSlug ? { portalSlug: args.portalSlug } : {}),
            ...(args.pageTitle ? { pageTitle: args.pageTitle } : {}),
            ...(args.roleName ? { roleName: args.roleName } : {}),
            ...(args.lockedFields ? { lockedFields: args.lockedFields } : {}),
            ...(args.dmnTableKey ? { dmnTableKey: args.dmnTableKey } : {}),
            ...(args.flowRuleKey ? { flowRuleKey: args.flowRuleKey } : {}),
            ...(args.n8nWorkflowId ? { n8nWorkflowId: args.n8nWorkflowId } : {}),
          });
        }
        if (args.operation === 'list_built_apps') {
          return listBuiltApps(db, actor, { status: args.status });
        }
        if (args.operation === 'rebuild_enterprise_app') {
          return rebuildEnterpriseApp(ctx, db, actor, {
            appKey: args.appKey,
            specPatch: args.specPatch,
            maxHealRounds: args.maxHealRounds,
          });
        }
        if (args.operation === 'export_app_bundle') {
          return exportAppBundle(db, actor, { appKey: args.appKey });
        }
        if (args.operation === 'teardown_built_app') {
          return teardownBuiltApp(ctx, db, actor, {
            appKey: args.appKey,
            keepData: args.keepData !== false,
          });
        }
        return orchestrateEnterpriseAppBuild(ctx, db, actor, args);
      },
    });
    return {
      ...orchestratorTool,
      async invoke(ctx, rawArgs = {}) {
        let op = rawArgs && typeof rawArgs === 'object' ? rawArgs.operation : undefined;
        if (!op && typeof rawArgs === 'string' && rawArgs.trim().startsWith('{')) {
          try { op = JSON.parse(rawArgs).operation; } catch {}
        }
        if (ORCHESTRATOR_OPS.has(op)) {
          return orchestratorTool.invoke(ctx, rawArgs);
        }
        return tool.invoke(ctx, rawArgs);
      },
    };
  });
  return [
    ...createBuilderTools(shared),
    ...surfaceTools,
    ...createOperationalTools(shared),
  ];
}

const OWN_SCOPED_COLLECTIONS = new Set(['latticeRequests', 'latticeOrders', 'latticeServiceTickets']);
const ORG_WIDE_READ_ROLES = new Set(['root', 'admin', 'ldx_admin', 'ldx_director', 'ldx_manager', 'ldx_dispatcher']);

async function resolveReadablePolicies(db, actor, collections) {
  const uniqueCols = [...new Set((collections || []).filter(Boolean))];
  if (actor?.isAdmin) return { allowedCollections: uniqueCols, ownOnlySet: new Set() };
  const resourcesRepo = db?.getRepository?.('dataSourcesRolesResources');
  if (!resourcesRepo || !uniqueCols.length) return { allowedCollections: [], ownOnlySet: new Set() };
  const rows = (await resourcesRepo.find({ filter: { name: { $in: uniqueCols }, dataSourceKey: 'main' }, appends: ['actions'], limit: 250 })) || [];
  const roleSet = new Set(actor?.roleNames || []);
  const hasOrgWideRole = (actor?.roleNames || []).some((r) => ORG_WIDE_READ_ROLES.has(r));
  const allowedCollections = [];
  const ownOnlySet = new Set();

  for (const col of uniqueCols) {
    const colRows = rows.filter((r) => val(r, 'name') === col && roleSet.has(val(r, 'roleName')));
    const viewActions = [];
    for (const r of colRows) {
      for (const act of val(r, 'actions') || []) {
        if (['view', 'list', 'get'].includes(val(act, 'name'))) viewActions.push(act);
      }
    }
    if (!viewActions.length) continue;
    allowedCollections.push(col);
    const allHaveScope = viewActions.every((a) => Boolean(val(a, 'scope') || val(a, 'scopeId') != null));
    if (allHaveScope || (OWN_SCOPED_COLLECTIONS.has(col) && !hasOrgWideRole)) {
      ownOnlySet.add(col);
    }
  }
  return { allowedCollections, ownOnlySet };
}

function isRowVisibleToActor(row, actor, isOwnOnly) {
  if (!isOwnOnly || actor?.isAdmin) return true;
  const empId = actor?.employeeId;
  const userId = actor?.userId;
  const checks = [
    [val(row, 'requesterId'), empId],
    [val(row, 'assigneeId'), empId],
    [val(row, 'driverId'), empId],
    [val(row, 'ownerId'), empId],
    [val(row, 'createdById'), userId],
  ];
  return checks.some(([rowVal, actorVal]) => rowVal != null && actorVal != null && Number(rowVal) === Number(actorVal));
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
  isProtectedCollection,
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
  resolveReadablePolicies,
  isRowVisibleToActor,
  safeGetResource,
  invokeResourceAction,
  normalizeToolPermissionsMap,
  createAuditedTool,
  createDxosTools,
  registerDxosToolsWithHost,
};
