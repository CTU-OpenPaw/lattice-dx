/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { recordAiAuditLog, resolveDefaultOrganizationId } = require('./ai-schemas');
const { val } = require('./ai-sync');
const {
  ADMIN_BUILDER_TOOL_NAMES,
  failTool,
  resolveCallerRoleNames,
  isStudioAdmin,
  resolveActorScope,
} = require('./ai-tools-core');
const { isRootActor, isHitlApprover, listApprovals } = require('./ai-hitl');
const { buildEnterpriseTopology } = require('./mcp-itot-tools');
const {
  resolvePageGrid,
  extractGridBlockUids,
  hydrateFlowModel,
  readFlowModelMeta,
  restorePageSnapshot,
  getSurfaceRevisionState,
} = require('./ai-surface-creative-tools');
const { createSurfaceEventsHandler, publishSurfaceUpdate } = require('./surface-events');
const { getQuotaSummaryPersistent } = require('./ai-governance');
const { runProactiveIncidentTriage } = require('./proactive-triage');
const { runWithTenantRls, runWithSystemRlsBypass } = require('./ai-rls');
const {
  listBuiltApps: listBuiltAppsRegistry,
  orchestrateEnterpriseAppBuild,
  rebuildEnterpriseApp,
  exportAppBundle,
  teardownBuiltApp: teardownBuiltAppEngine,
  planEnterpriseApp,
  patchEnterpriseApp,
  rollbackEnterpriseApp,
  listBuiltAppVersions: listBuiltAppVersionsEngine,
} = require('./app-builder-orchestrator');
const { assertNoPrototypePollution, buildDraftSpecFromNaturalPrompt, cloneSafeDeep } = require('./app-builder-planner');
const {
  SUPPORTED_HITL_TOOLS,
  parseOptionalPositiveInt,
  createHitlDecisionHelpers,
} = require('./ai-hitl-executors');
const {
  QUICK_CONNECT_PROVIDER_PRESETS,
  ensureLocalLlmServiceRecord,
  validateQuickConnectBaseUrl,
  probeLlmHealth,
  runQuickConnectLlm,
} = require('./ai-llm-health');
const {
  serializeProfile,
  serializeAuditLog,
  buildCatalogMeta,
  upsertAndSyncProfile,
  computeAllTimeAuditTotals,
  ensureDefaultAiWorkforce,
} = require('./ai-profile-service');
const {
  normalizeScope,
  listMemories: listPersistentMemories,
  rememberFact: rememberPersistentFact,
  recallMemories: recallPersistentMemories,
  forgetMemory: forgetPersistentMemory,
} = require('./ai-memory');
const {
  listAgentTraces: listEvalAgentTraces,
  getAgentTraceDetail: getEvalAgentTraceDetail,
  listEvalSuites: listEvalLabSuites,
  runEvalBenchmark: runEvalLabBenchmark,
} = require('./ai-eval-lab');

const TRIAGE_SCAN_ROLES = new Set(['root', 'admin', 'ldx_admin', 'ldx_director', 'ldx_manager', 'ldx_dispatcher']);

function readActionPayload(ctx) {
  return ctx?.action?.params?.values || ctx?.request?.body?.values || ctx?.request?.body || ctx?.action?.params || {};
}

function createDxosAiActions(db, { env = process.env, fetchImpl } = {}) {
  const resolveDb = (ctx) => ctx?.db || db;

  async function requireAdmin(ctx) {
    const targetDb = resolveDb(ctx);
    const ok = await isStudioAdmin(ctx, targetDb);
    if (!ok) {
      throw failTool('DXOS_ADMIN_REQUIRED', 403, 'Chỉ Quản trị viên mới có quyền truy cập DX-OS AI Studio.');
    }
    return targetDb;
  }

  const { runHitlDecision, buildApproveExecutor } = createHitlDecisionHelpers({
    resolveDb,
    readActionPayload,
  });

  function resolveScopedMemoryParams(ctx, actor, payload, { isMutation = false, actionName = 'memory' } = {}) {
    const params = ctx?.action?.params || {};
    assertNoPrototypePollution(params, `${actionName}.params`);
    assertNoPrototypePollution(payload, actionName);
    const rawOrg = payload.organizationId ?? params.organizationId ?? null;
    const requestedOrg = rawOrg != null ? String(rawOrg).trim() : '';
    if (!isRootActor(actor) && requestedOrg && requestedOrg !== actor.organizationId) {
      throw failTool('DXOS_ORG_MISMATCH', 403, 'Không được phép truy cập bộ nhớ của tổ chức khác.');
    }
    const organizationId = (isRootActor(actor) && requestedOrg) ? requestedOrg : actor.organizationId;

    const rawScopes = payload.scopes ?? params.scopes;
    const rawScope = payload.scope ?? params.scope;
    const rawSingleScope = rawScope != null && String(rawScope).trim() !== ''
      ? String(rawScope).trim().toLowerCase()
      : '';
    if (rawSingleScope) {
      const checkedSingle = normalizeScope(rawSingleScope, 'org');
      if (isMutation && (checkedSingle === 'org' || checkedSingle === 'agent') && !actor.isAdmin) {
        throw failTool('DXOS_ADMIN_REQUIRED', 403, `Chỉ Quản trị viên mới được ghi/xóa bộ nhớ phạm vi "${checkedSingle}".`);
      }
      if (!isMutation && checkedSingle === 'agent' && !actor.isAdmin) {
        throw failTool('DXOS_ADMIN_REQUIRED', 403, 'Chỉ Quản trị viên mới được xem bộ nhớ nội bộ phạm vi agent.');
      }
    }
    let parsedScopes = rawScopes;
    if (typeof parsedScopes === 'string' && parsedScopes.trim().startsWith('[')) {
      try { parsedScopes = JSON.parse(parsedScopes); } catch {}
    }
    if (rawScopes !== undefined && rawScopes !== null && !Array.isArray(parsedScopes)) {
      if (typeof rawScopes !== 'string' || rawScopes.trim() !== '') {
        throw failTool('MEMORY_SCOPE_INVALID', 400, 'scopes must be an array of valid scopes (org, agent, user, session).');
      }
    }
    if (Array.isArray(parsedScopes) && parsedScopes.some((s) => typeof s !== 'string' || s.trim() === '')) {
      throw failTool('MEMORY_SCOPE_INVALID', 400, 'scopes must not contain empty or non-string entries.');
    }
    const normalizedScopesList = Array.isArray(parsedScopes)
      ? parsedScopes.map((s) => s.trim().toLowerCase())
      : [];
    const combinedScopes = [
      ...(rawSingleScope ? [rawSingleScope] : []),
      ...normalizedScopesList,
    ];
    const primaryScope = normalizeScope(rawSingleScope || normalizedScopesList[0], 'org');
    const scopeList = combinedScopes.length > 0
      ? [...new Set(combinedScopes.map((sc) => normalizeScope(sc, 'org')))]
      : [primaryScope];

    const callerUserId = String(actor.userId);
    const rawUserId = payload.userId ?? params.userId;
    const requestedUserId = rawUserId != null && String(rawUserId).trim() !== '' ? String(rawUserId).trim() : '';
    const rawCreatedById = payload.createdById ?? params.createdById;
    const requestedCreatedById = rawCreatedById != null && String(rawCreatedById).trim() !== '' ? String(rawCreatedById).trim() : '';
    if (((requestedUserId && requestedUserId !== callerUserId) || (requestedCreatedById && requestedCreatedById !== callerUserId)) && !actor.isAdmin) {
      throw failTool('MEMORY_USER_MISMATCH', 403, 'Không được phép truy cập bộ nhớ riêng của người dùng khác.');
    }

    for (const sc of scopeList) {
      if (isMutation && (sc === 'org' || sc === 'agent') && !actor.isAdmin) {
        throw failTool('DXOS_ADMIN_REQUIRED', 403, `Chỉ Quản trị viên mới được ghi/xóa bộ nhớ phạm vi "${sc}".`);
      }
      if (!isMutation && sc === 'agent' && !actor.isAdmin) {
        throw failTool('DXOS_ADMIN_REQUIRED', 403, 'Chỉ Quản trị viên mới được xem bộ nhớ nội bộ phạm vi agent.');
      }
    }

    const bindCallerUser = primaryScope === 'user'
      || scopeList.includes('user')
      || ((primaryScope === 'session' || scopeList.includes('session')) && !actor.isAdmin);
    const effectiveUserId = bindCallerUser
      ? (requestedUserId || callerUserId)
      : (requestedUserId || null);

    return {
      organizationId,
      scope: primaryScope,
      ...(!isMutation && normalizedScopesList.length > 0 ? { scopes: scopeList } : {}),
      userId: effectiveUserId,
      agentId: payload.agentId ?? params.agentId ?? null,
      sessionId: payload.sessionId ?? params.sessionId ?? null,
      enforceSessionOwner: !actor.isAdmin && (primaryScope === 'session' || scopeList.includes('session')),
    };
  }

  function resolveAdminOrgScope(ctx, actor, payload, actionName) {
    const params = ctx?.action?.params || {};
    assertNoPrototypePollution(params, `${actionName}.params`);
    assertNoPrototypePollution(payload, actionName);
    const requestedOrg = String(params.organizationId || payload.organizationId || '').trim();
    if (!isRootActor(actor) && requestedOrg && requestedOrg !== actor.organizationId) {
      throw failTool('DXOS_ORG_MISMATCH', 403, 'Không được phép truy cập dữ liệu của tổ chức khác.');
    }
    return (isRootActor(actor) && requestedOrg) ? requestedOrg : actor.organizationId;
  }

  return {
    async listProfiles(ctx, next) {
      const targetDb = await requireAdmin(ctx);
      const actorScope = await resolveActorScope(ctx, targetDb).catch(() => null);
      const defaultOrg = await resolveDefaultOrganizationId(targetDb, { actor: actorScope, ctx, env });
      const repo = targetDb?.getRepository?.('latticeAiProfiles');
      const runList = () => (repo ? repo.find({ sort: ['username'] }) : []);
      const rows = (actorScope?.isRoot || !actorScope?.organizationId
        ? await runWithSystemRlsBypass(targetDb, runList)
        : await runWithTenantRls(targetDb, actorScope.organizationId, runList)) || [];
      const orgRepo = targetDb?.getRepository?.('latticeOrganizations');
      let organizations = [];
      if (orgRepo && typeof orgRepo.find === 'function') {
        try {
          const orgRows = (await orgRepo.find({ limit: 100 })) || [];
          organizations = [...new Set(
            orgRows
              .filter((r) => val(r, 'active') !== false && !['inactive', 'disabled'].includes(String(val(r, 'status') || 'active').toLowerCase()))
              .map((r) => String(val(r, 'organizationId') || '').trim())
              .filter((id) => id && id.toLowerCase() !== 'all'),
          )];
        } catch {}
      }
      if (defaultOrg && !organizations.includes(defaultOrg)) organizations.unshift(defaultOrg);
      ctx.body = {
        profiles: rows.map((r) => serializeProfile(r, defaultOrg)),
        organizations,
        defaultOrganizationId: defaultOrg || null,
        catalog: {
          ...buildCatalogMeta(),
          organizations,
          defaultOrganizationId: defaultOrg || null,
        },
      };
      if (typeof next === 'function') await next();
    },

    async saveProfile(ctx, next) {
      const targetDb = await requireAdmin(ctx);
      const actorUser = ctx?.state?.currentUser || ctx?.auth?.user;
      const actorScope = await resolveActorScope(ctx, targetDb).catch(() => null);
      const defaultOrg = await resolveDefaultOrganizationId(targetDb, { actor: actorScope, ctx, env, fallback: 'default' });
      const payload = readActionPayload(ctx);
      const defaultOrigin = env?.NOCOBASE_INTERNAL_URL;
      ctx.body = await upsertAndSyncProfile(targetDb, payload, { actorUser, defaultOrigin, defaultOrganizationId: defaultOrg });
      if (typeof next === 'function') await next();
    },

    async deleteProfile(ctx, next) {
      const targetDb = await requireAdmin(ctx);
      const actorUser = ctx?.state?.currentUser || ctx?.auth?.user;
      const payload = readActionPayload(ctx);
      const rawUsername = payload.username || ctx?.action?.params?.username || ctx?.action?.params?.filterByTk || '';
      const username = String(rawUsername).trim().toLowerCase();
      if (!username) {
        throw failTool('AI_USERNAME_REQUIRED', 400, 'Cần username của AI Employee để xóa.');
      }

      await runWithSystemRlsBypass(targetDb, async () => {
        for (const [repoName, filter] of [
          ['latticeAiProfiles', { username }],
          ['aiEmployees', { username }],
          ['rolesAiEmployees', { aiEmployee: username }],
        ]) {
          const repo = targetDb?.getRepository?.(repoName);
          if (repo && typeof repo.destroy === 'function') {
            await repo.destroy({ filter });
          }
        }
      });

      await recordAiAuditLog(targetDb, {
        actorUserId: val(actorUser, 'id') ?? null,
        actorUsername: val(actorUser, 'username') || null,
        channel: 'studio-sync',
        aiEmployee: username,
        toolName: 'dxosAi:deleteProfile',
        argsSummary: { username },
        status: 'allowed',
        resultSummary: `Deleted AI profile ${username}`,
      });

      ctx.body = { deleted: true, username };
      if (typeof next === 'function') await next();
    },

    async bootstrapDefaults(ctx, next) {
      const targetDb = await requireAdmin(ctx);
      const actorUser = ctx?.state?.currentUser || ctx?.auth?.user;
      const actorScope = await resolveActorScope(ctx, targetDb).catch(() => null);
      const defaultOrg = await resolveDefaultOrganizationId(targetDb, { actor: actorScope, ctx, env, fallback: 'default' });
      const defaultOrigin = env?.NOCOBASE_INTERNAL_URL;

      const workforce = await ensureDefaultAiWorkforce(targetDb, {
        env,
        actorUser,
        defaultOrigin,
        defaultOrganizationId: defaultOrg,
        forceUpdate: true,
      });
      const profiles = workforce.seeded || [];
      const llm = workforce.llm || { configured: false, skipped: true };

      await recordAiAuditLog(targetDb, {
        actorUserId: val(actorUser, 'id') ?? null,
        actorUsername: val(actorUser, 'username') || null,
        channel: 'studio-sync',
        toolName: 'dxosAi:bootstrapDefaults',
        argsSummary: { count: profiles.length, llmConfigured: llm.configured },
        status: 'allowed',
        resultSummary: `Bootstrapped ${profiles.length} starter AI employees`,
      });

      ctx.body = {
        bootstrappedCount: profiles.length,
        profiles,
        llm,
      };
      if (typeof next === 'function') await next();
    },

    async portalAgents(ctx, next) {
      const targetDb = resolveDb(ctx);
      const user = ctx?.state?.currentUser || ctx?.auth?.user;
      const userId = val(user, 'id');
      if (!userId) {
        throw failTool('NATIVE_LOGIN_REQUIRED', 401, 'Yêu cầu đăng nhập để xem danh sách AI hỗ trợ.');
      }

      const roleNames = await resolveCallerRoleNames(ctx, targetDb, userId);
      const callerIsAdmin = await isStudioAdmin(ctx, targetDb);
      const actorScope = await resolveActorScope(ctx, targetDb).catch(() => null);
      const payload = readActionPayload(ctx);
      const portalSlug = String(ctx?.action?.params?.portalSlug || payload.portalSlug || '').trim().toLowerCase();

      const repo = targetDb?.getRepository?.('latticeAiProfiles');
      const runFind = () => (repo ? repo.find({ filter: { enabled: true }, sort: ['username'] }) : []);
      const rows = (actorScope && !actorScope.isRoot && actorScope.organizationId
        ? await runWithTenantRls(targetDb, actorScope.organizationId, runFind)
        : await runWithSystemRlsBypass(targetDb, runFind)) || [];
      const adminToolSet = new Set(ADMIN_BUILDER_TOOL_NAMES);

      const employees = rows
        .map(serializeProfile)
        .filter((p) => {
          if (!p || p.enabled === false) return false;
          const perms = p.toolPermissions || {};
          const grantsBuilder = p.isAdminBuilder || Object.entries(perms).some(([name, mode]) => adminToolSet.has(name) && mode !== 'OFF');
          if (grantsBuilder && !callerIsAdmin) return false;

          const allowed = Array.isArray(p.allowedRoles) ? p.allowedRoles : [];
          const hasRole = callerIsAdmin
            ? (grantsBuilder || allowed.some((r) => roleNames.includes(r)) || roleNames.includes('root') || roleNames.includes('admin'))
            : roleNames.some((r) => allowed.includes(r));
          if (!hasRole) return false;

          if (!portalSlug) return true;
          const bindings = Array.isArray(p.portalBindings) ? p.portalBindings.map((s) => String(s).toLowerCase()) : [];
          return bindings.includes(portalSlug) || bindings.includes('*');
        })
        .map((p) => ({
          username: p.username,
          nickname: p.nickname,
          position: p.position,
          departmentScope: p.departmentScope,
          avatar: p.avatar,
          greeting: p.greeting,
          isAdminBuilder: p.isAdminBuilder,
          portalBindings: p.portalBindings,
          quickPrompts: p.quickPrompts,
        }));

      ctx.body = {
        portalSlug,
        callerRoles: roleNames,
        isAdmin: callerIsAdmin,
        employees,
      };
      if (typeof next === 'function') await next();
    },

    async auditLogs(ctx, next) {
      const targetDb = await requireAdmin(ctx);
      const actorScope = await resolveActorScope(ctx, targetDb).catch(() => null);
      const params = ctx?.action?.params || {};
      const filter = {};
      if (params.channel) filter.channel = String(params.channel).trim();
      if (params.status) filter.status = String(params.status).trim();
      if (params.toolName) filter.toolName = String(params.toolName).trim();
      const limit = Math.max(1, Math.min(200, Number(params.pageSize || params.limit) || 50));

      const repo = targetDb?.getRepository?.('latticeAiAuditLogs');
      const runFind = () => (repo ? repo.find({ filter, sort: ['-id'], limit }) : []);
      const rows = (actorScope && !actorScope.isRoot && actorScope.organizationId
        ? await runWithTenantRls(targetDb, actorScope.organizationId, runFind)
        : await runWithSystemRlsBypass(targetDb, runFind)) || [];
      ctx.body = { items: rows.map(serializeAuditLog) };
      if (typeof next === 'function') await next();
    },

    async quotaSummary(ctx, next) {
      const targetDb = await requireAdmin(ctx);
      const params = readActionPayload(ctx);
      const explicitOrg = String(ctx?.action?.params?.organizationId || params.organizationId || '').trim();
      const actorScope = explicitOrg ? null : await resolveActorScope(ctx, targetDb, { defaultFallback: '' }).catch(() => null);
      const requestedOrg = explicitOrg || (await resolveDefaultOrganizationId(targetDb, { actor: actorScope, ctx, env }));
      if (!requestedOrg) {
        throw failTool('AI_ORG_REQUIRED', 400, 'Cần organizationId hoặc một tổ chức đang hoạt động trong latticeOrganizations.');
      }
      const summary = await getQuotaSummaryPersistent(targetDb, requestedOrg, env);
      const auditTotals = await computeAllTimeAuditTotals(targetDb, summary.organizationId);
      ctx.body = {
        ...summary,
        dayUsage: summary.usage,
        allTimeTotals: auditTotals,
        auditTotals,
      };
      if (typeof next === 'function') await next();
    },

    async enterpriseTopology(ctx, next) {
      const targetDb = await requireAdmin(ctx);
      ctx.body = await runWithSystemRlsBypass(targetDb, () => buildEnterpriseTopology(targetDb, env, fetchImpl, ctx?.app));
      if (typeof next === 'function') await next();
    },

    async pageSurfaceState(ctx, next) {
      const targetDb = resolveDb(ctx);
      const user = ctx?.state?.currentUser || ctx?.auth?.user;
      if (!val(user, 'id')) throw failTool('NATIVE_LOGIN_REQUIRED', 401, 'Yêu cầu đăng nhập.');
      const payload = readActionPayload(ctx);
      const portalSlug = String(ctx?.action?.params?.portalSlug || payload.portalSlug || '').trim().toLowerCase();
      const pageTitle = String(ctx?.action?.params?.pageTitle || payload.pageTitle || '').trim();
      ctx.body = portalSlug
        ? await getSurfaceRevisionState(targetDb, portalSlug, pageTitle, val)
        : { revision: 1, blockCount: 0, layoutSignature: '' };
      if (typeof next === 'function') await next();
    },

    surfaceEvents: createSurfaceEventsHandler({
      getInitialState: (ctx, portalSlug, pageTitle) => getSurfaceRevisionState(resolveDb(ctx), portalSlug, pageTitle, val),
    }),

    async inspectPageBlocks(ctx, next) {
      const targetDb = await requireAdmin(ctx);
      const payload = readActionPayload(ctx);
      const portalSlug = String(ctx?.action?.params?.portalSlug || payload.portalSlug || '').trim().toLowerCase();
      const pageTitle = String(ctx?.action?.params?.pageTitle || payload.pageTitle || '').trim();
      const resolved = portalSlug ? await resolvePageGrid(targetDb, portalSlug, pageTitle, val) : {};
      if (!resolved.grid) {
        ctx.body = { portalSlug, pageTitle: val(resolved.pageRoute, 'title') || null, blocks: [] };
        if (typeof next === 'function') await next();
        return;
      }
      const { ordered, layout } = extractGridBlockUids(resolved.grid);
      const subMap = new Map((Array.isArray(resolved.grid?.subModels?.items) ? resolved.grid.subModels.items : []).map((m) => [m.uid, m]));
      const blocks = [];
      for (const uid of ordered) {
        const model = await hydrateFlowModel(resolved.flowModelsRepo, uid, subMap);
        blocks.push(readFlowModelMeta(model, uid));
      }
      ctx.body = {
        portalSlug,
        pageTitle: val(resolved.pageRoute, 'title') || null,
        gridUid: resolved.grid.uid,
        gridRows: layout.rows || {},
        sizes: layout.sizes || {},
        blocks,
      };
      if (typeof next === 'function') await next();
    },

    async rollbackPageSnapshot(ctx, next) {
      const targetDb = await requireAdmin(ctx);
      const actorUser = ctx?.state?.currentUser || ctx?.auth?.user;
      const payload = readActionPayload(ctx);
      const portalSlug = String(payload.portalSlug || ctx?.action?.params?.portalSlug || '').trim().toLowerCase();
      const pageTitle = String(payload.pageTitle || ctx?.action?.params?.pageTitle || '').trim();
      const snapshotUid = String(payload.snapshotUid || '').trim();
      const res = await restorePageSnapshot(targetDb, { portalSlug, pageTitle, snapshotUid }, val);
      await recordAiAuditLog(targetDb, {
        actorUserId: val(actorUser, 'id') ?? null,
        actorUsername: val(actorUser, 'username') || null,
        channel: 'studio-sync',
        toolName: 'dxosAi:rollbackPageSnapshot',
        argsSummary: { portalSlug, pageTitle, snapshotUid: snapshotUid || 'latest' },
        status: res?.rolledBack ? 'allowed' : 'error',
        resultSummary: JSON.stringify(res).slice(0, 600),
      });
      ctx.body = res;
      if (typeof next === 'function') await next();
    },

    async listApprovals(ctx, next) {
      if (ctx.method && String(ctx.method).toUpperCase() !== 'GET') {
        throw failTool('METHOD_NOT_ALLOWED', 405, 'Cần phương thức GET.');
      }
      const targetDb = resolveDb(ctx);
      const actor = await resolveActorScope(ctx, targetDb);
      const payload = readActionPayload(ctx);
      const status = ctx?.action?.params?.status ?? payload.status ?? 'pending';
      const limit = ctx?.action?.params?.limit ?? payload.limit ?? 50;
      const organizationId = ctx?.action?.params?.organizationId ?? payload.organizationId ?? null;
      const items = await listApprovals(targetDb, { actor, status, limit, organizationId });
      ctx.body = {
        items,
        total: items.length,
        isApprover: isHitlApprover(actor),
        organizationId: actor.organizationId,
      };
      if (typeof next === 'function') await next();
    },

    async triageScan(ctx, next) {
      if (ctx.method && String(ctx.method).toUpperCase() !== 'POST') {
        throw failTool('METHOD_NOT_ALLOWED', 405, 'Cần phương thức POST.');
      }
      const targetDb = resolveDb(ctx);
      const actor = await resolveActorScope(ctx, targetDb);
      const allowed = actor.isAdmin || (actor.roleNames || []).some((r) => TRIAGE_SCAN_ROLES.has(r));
      if (!allowed) {
        throw failTool('DXOS_TRIAGE_FORBIDDEN', 403, 'Chỉ Quản trị viên, Giám đốc, Quản lý hoặc Điều phối viên mới được quét sự cố chủ động.');
      }
      const payload = readActionPayload(ctx);
      const rawOrg = payload.organizationId ?? ctx?.action?.params?.organizationId ?? null;
      const requestedOrg = rawOrg != null ? String(rawOrg).trim() : '';
      if (!isRootActor(actor) && requestedOrg && requestedOrg !== actor.organizationId) {
        throw failTool('DXOS_ORG_MISMATCH', 403, 'Không được phép quét sự cố của tổ chức khác.');
      }
      const targetOrg = isRootActor(actor) && requestedOrg ? requestedOrg : actor.organizationId;
      const maxAlarms = payload.maxAlarms ?? ctx?.action?.params?.maxAlarms ?? 10;
      const alarmIds = payload.alarmIds ?? ctx?.action?.params?.alarmIds ?? null;
      const dryRun = Boolean(payload.dryRun);
      const overwriteProposal = Boolean(payload.overwriteProposal);

      const res = await runProactiveIncidentTriage(targetDb, {
        organizationId: targetOrg,
        actor,
        maxAlarms,
        alarmIds,
        dryRun,
        overwriteProposal,
      });

      await recordAiAuditLog(targetDb, {
        actorUserId: actor.userId,
        actorUsername: actor.username,
        organizationId: targetOrg,
        channel: 'proactive-triage',
        aiEmployee: 'dxos-coordinator',
        toolName: 'dxosAi:triageScan',
        argsSummary: { organizationId: targetOrg, maxAlarms, dryRun },
        status: 'allowed',
        resultSummary: `Scanned ${res.scannedCount} alarms, created ${res.proposalsCreated} HITL proposals, skipped ${res.deduplicatedSkipped} duplicates`,
      });

      if (!dryRun) {
        const eventPayload = {
          type: 'hitl_triage_scan',
          organizationId: targetOrg,
          scannedCount: res.scannedCount,
          proposalsCreated: res.proposalsCreated,
          deduplicatedSkipped: res.deduplicatedSkipped,
          message: `Phân tích ${res.scannedCount} sự cố: tạo ${res.proposalsCreated} đề xuất HITL mới`,
        };
        publishSurfaceUpdate('incidents', eventPayload);
        publishSurfaceUpdate('admin-studio', eventPayload);
      }

      ctx.body = res;
      if (typeof next === 'function') await next();
    },

    async approveAction(ctx, next) {
      ctx.body = await runHitlDecision(ctx, 'approve', buildApproveExecutor(ctx));
      if (typeof next === 'function') await next();
    },

    async rejectAction(ctx, next) {
      ctx.body = await runHitlDecision(ctx, 'reject');
      if (typeof next === 'function') await next();
    },

    async checkLlmHealth(ctx, next) {
      if (ctx.method && String(ctx.method).toUpperCase() !== 'GET') {
        throw failTool('METHOD_NOT_ALLOWED', 405, 'Cần phương thức GET.');
      }
      const targetDb = resolveDb(ctx);
      const user = ctx?.state?.currentUser || ctx?.auth?.user;
      if (!val(user, 'id')) {
        throw failTool('NATIVE_LOGIN_REQUIRED', 401, 'Yêu cầu đăng nhập để kiểm tra sức khỏe LLM.');
      }
      const adminOk = await isStudioAdmin(ctx, targetDb);
      const payload = readActionPayload(ctx);
      const llmServiceName = String(ctx?.action?.params?.llmService || payload.llmService || '').trim();
      const rawVerify = ctx?.action?.params?.verifyCompletion ?? payload.verifyCompletion;
      const verifyCompletion = rawVerify === true || rawVerify === '1' || rawVerify === 'true';
      ctx.body = await probeLlmHealth(targetDb, {
        env,
        fetchImpl,
        isAdmin: adminOk,
        llmServiceName,
        verifyCompletion,
      });
      if (typeof next === 'function') await next();
    },

    async quickConnectLlm(ctx, next) {
      if (ctx.method && String(ctx.method).toUpperCase() !== 'POST') {
        throw failTool('METHOD_NOT_ALLOWED', 405, 'Cần phương thức POST.');
      }
      const targetDb = await requireAdmin(ctx);
      ctx.body = await runQuickConnectLlm(targetDb, ctx, { env, fetchImpl, readActionPayload });
      if (typeof next === 'function') await next();
    },

    async listBuiltApps(ctx, next) {
      if (ctx.method && String(ctx.method).toUpperCase() !== 'GET') {
        throw failTool('METHOD_NOT_ALLOWED', 405, 'Cần phương thức GET.');
      }
      const targetDb = await requireAdmin(ctx);
      const actor = await resolveActorScope(ctx, targetDb);
      const payload = readActionPayload(ctx);
      const requestedOrg = String(ctx?.action?.params?.organizationId || payload.organizationId || '').trim();
      if (!isRootActor(actor) && requestedOrg && requestedOrg !== actor.organizationId) {
        throw failTool('DXOS_ORG_MISMATCH', 403, 'Không được phép xem ứng dụng của tổ chức khác.');
      }
      const effectiveActor = isRootActor(actor) && requestedOrg ? { ...actor, organizationId: requestedOrg } : actor;
      const status = String(ctx?.action?.params?.status || payload.status || '').trim() || undefined;
      ctx.body = await listBuiltAppsRegistry(targetDb, effectiveActor, { status });
      if (typeof next === 'function') await next();
    },

    async rebuildBuiltApp(ctx, next) {
      if (ctx.method && String(ctx.method).toUpperCase() !== 'POST') {
        throw failTool('METHOD_NOT_ALLOWED', 405, 'Cần phương thức POST.');
      }
      const targetDb = await requireAdmin(ctx);
      const actor = await resolveActorScope(ctx, targetDb);
      const payload = readActionPayload(ctx);
      assertNoPrototypePollution(payload, 'rebuildBuiltApp');
      const requestedOrg = String(payload.organizationId || ctx?.action?.params?.organizationId || '').trim();
      if (!isRootActor(actor) && requestedOrg && requestedOrg !== actor.organizationId) {
        throw failTool('DXOS_ORG_MISMATCH', 403, 'Không được phép dựng lại ứng dụng của tổ chức khác.');
      }
      const effectiveActor = isRootActor(actor) && requestedOrg ? { ...actor, organizationId: requestedOrg } : actor;
      const appKey = String(payload.appKey || ctx?.action?.params?.appKey || ctx?.action?.params?.filterByTk || '').trim();
      if (!appKey) {
        throw failTool('APP_KEY_REQUIRED', 400, 'Cần appKey để dựng lại ứng dụng.');
      }
      ctx.body = await rebuildEnterpriseApp(ctx, targetDb, effectiveActor, {
        appKey,
        specPatch: payload.specPatch || null,
        maxHealRounds: payload.maxHealRounds,
      }, { env, fetchImpl });
      if (typeof next === 'function') await next();
    },

    async buildBuiltApp(ctx, next) {
      if (ctx.method && String(ctx.method).toUpperCase() !== 'POST') {
        throw failTool('METHOD_NOT_ALLOWED', 405, 'Cần phương thức POST.');
      }
      const targetDb = await requireAdmin(ctx);
      const actor = await resolveActorScope(ctx, targetDb);
      const payload = readActionPayload(ctx);
      assertNoPrototypePollution(payload, 'buildBuiltApp');
      const requestedOrg = String(payload.organizationId || ctx?.action?.params?.organizationId || '').trim();
      if (!isRootActor(actor) && requestedOrg && requestedOrg !== actor.organizationId) {
        throw failTool('DXOS_ORG_MISMATCH', 403, 'Không được phép dựng ứng dụng của tổ chức khác.');
      }
      const effectiveActor = isRootActor(actor) && requestedOrg ? { ...actor, organizationId: requestedOrg } : actor;
      let spec = payload.spec && typeof payload.spec === 'object' ? cloneSafeDeep(payload.spec) : null;
      if (!spec) {
        const promptText = String(payload.prompt || '').trim();
        if (payload.collections || payload.collectionName) {
          const { prompt: _p, organizationId: _o, spec: _s, ...rest } = payload;
          spec = cloneSafeDeep(rest);
        } else if (promptText) {
          spec = buildDraftSpecFromNaturalPrompt(promptText);
        } else {
          throw failTool('SPEC_OR_PROMPT_REQUIRED', 400, 'Cần cung cấp spec hoặc mô tả prompt để dựng ứng dụng.');
        }
      }
      ctx.body = await orchestrateEnterpriseAppBuild(ctx, targetDb, effectiveActor, spec, { env, fetchImpl });
      if (typeof next === 'function') await next();
    },

    async planBuiltApp(ctx, next) {
      if (ctx.method && String(ctx.method).toUpperCase() !== 'POST') {
        throw failTool('METHOD_NOT_ALLOWED', 405, 'Cần phương thức POST.');
      }
      const targetDb = await requireAdmin(ctx);
      const actor = await resolveActorScope(ctx, targetDb);
      const payload = readActionPayload(ctx);
      assertNoPrototypePollution(payload, 'planBuiltApp');
      const requestedOrg = String(payload.organizationId || ctx?.action?.params?.organizationId || '').trim();
      if (!isRootActor(actor) && requestedOrg && requestedOrg !== actor.organizationId) {
        throw failTool('DXOS_ORG_MISMATCH', 403, 'Không được phép lập kế hoạch ứng dụng của tổ chức khác.');
      }
      const effectiveActor = isRootActor(actor) && requestedOrg ? { ...actor, organizationId: requestedOrg } : actor;
      ctx.body = await planEnterpriseApp(ctx, targetDb, effectiveActor, {
        ...payload,
        ...(ctx?.action?.params?.appKey && !payload.appKey ? { appKey: ctx.action.params.appKey } : {}),
      });
      if (typeof next === 'function') await next();
    },

    async patchBuiltApp(ctx, next) {
      if (ctx.method && String(ctx.method).toUpperCase() !== 'POST') {
        throw failTool('METHOD_NOT_ALLOWED', 405, 'Cần phương thức POST.');
      }
      const targetDb = await requireAdmin(ctx);
      const actor = await resolveActorScope(ctx, targetDb);
      const payload = readActionPayload(ctx);
      assertNoPrototypePollution(payload, 'patchBuiltApp');
      const requestedOrg = String(payload.organizationId || ctx?.action?.params?.organizationId || '').trim();
      if (!isRootActor(actor) && requestedOrg && requestedOrg !== actor.organizationId) {
        throw failTool('DXOS_ORG_MISMATCH', 403, 'Không được phép cập nhật ứng dụng của tổ chức khác.');
      }
      const effectiveActor = isRootActor(actor) && requestedOrg ? { ...actor, organizationId: requestedOrg } : actor;
      const appKey = String(payload.appKey || ctx?.action?.params?.appKey || ctx?.action?.params?.filterByTk || '').trim();
      if (!appKey) {
        throw failTool('APP_KEY_REQUIRED', 400, 'Cần appKey để cập nhật ứng dụng.');
      }
      ctx.body = await patchEnterpriseApp(ctx, targetDb, effectiveActor, {
        appKey,
        patch: payload.patch || payload.specPatch || null,
        targetSpec: payload.targetSpec || null,
        prompt: payload.prompt || payload.editPrompt || '',
        summary: payload.summary || '',
        dryRun: payload.dryRun === true,
        maxHealRounds: payload.maxHealRounds,
      }, { env, fetchImpl });
      if (typeof next === 'function') await next();
    },

    async rollbackBuiltApp(ctx, next) {
      if (ctx.method && String(ctx.method).toUpperCase() !== 'POST') {
        throw failTool('METHOD_NOT_ALLOWED', 405, 'Cần phương thức POST.');
      }
      const targetDb = await requireAdmin(ctx);
      const actor = await resolveActorScope(ctx, targetDb);
      const payload = readActionPayload(ctx);
      assertNoPrototypePollution(payload, 'rollbackBuiltApp');
      const requestedOrg = String(payload.organizationId || ctx?.action?.params?.organizationId || '').trim();
      if (!isRootActor(actor) && requestedOrg && requestedOrg !== actor.organizationId) {
        throw failTool('DXOS_ORG_MISMATCH', 403, 'Không được phép hoàn tác ứng dụng của tổ chức khác.');
      }
      const effectiveActor = isRootActor(actor) && requestedOrg ? { ...actor, organizationId: requestedOrg } : actor;
      const appKey = String(payload.appKey || ctx?.action?.params?.appKey || ctx?.action?.params?.filterByTk || '').trim();
      if (!appKey) {
        throw failTool('APP_KEY_REQUIRED', 400, 'Cần appKey để hoàn tác ứng dụng.');
      }
      let targetVersion = null;
      if (payload.targetVersion !== undefined && payload.targetVersion !== null && payload.targetVersion !== '') {
        targetVersion = parseOptionalPositiveInt(payload.targetVersion, 'targetVersion');
      }
      ctx.body = await rollbackEnterpriseApp(ctx, targetDb, effectiveActor, {
        appKey,
        targetVersion,
      }, { env, fetchImpl });
      if (typeof next === 'function') await next();
    },

    async listBuiltAppVersions(ctx, next) {
      if (ctx.method && String(ctx.method).toUpperCase() !== 'GET') {
        throw failTool('METHOD_NOT_ALLOWED', 405, 'Cần phương thức GET.');
      }
      const targetDb = await requireAdmin(ctx);
      const actor = await resolveActorScope(ctx, targetDb);
      const payload = readActionPayload(ctx);
      assertNoPrototypePollution(payload, 'listBuiltAppVersions');
      const requestedOrg = String(ctx?.action?.params?.organizationId || payload.organizationId || '').trim();
      if (!isRootActor(actor) && requestedOrg && requestedOrg !== actor.organizationId) {
        throw failTool('DXOS_ORG_MISMATCH', 403, 'Không được phép xem phiên bản ứng dụng của tổ chức khác.');
      }
      const effectiveActor = isRootActor(actor) && requestedOrg ? { ...actor, organizationId: requestedOrg } : actor;
      const appKey = String(ctx?.action?.params?.appKey || payload.appKey || ctx?.action?.params?.filterByTk || '').trim();
      if (!appKey) {
        throw failTool('APP_KEY_REQUIRED', 400, 'Cần appKey để xem lịch sử phiên bản.');
      }
      ctx.body = await listBuiltAppVersionsEngine(targetDb, effectiveActor, { appKey });
      if (typeof next === 'function') await next();
    },

    async exportBuiltAppBundle(ctx, next) {
      if (ctx.method && !['GET', 'POST'].includes(String(ctx.method).toUpperCase())) {
        throw failTool('METHOD_NOT_ALLOWED', 405, 'Cần phương thức GET hoặc POST.');
      }
      const targetDb = await requireAdmin(ctx);
      const actor = await resolveActorScope(ctx, targetDb);
      const payload = readActionPayload(ctx);
      const requestedOrg = String(ctx?.action?.params?.organizationId || payload.organizationId || '').trim();
      if (!isRootActor(actor) && requestedOrg && requestedOrg !== actor.organizationId) {
        throw failTool('DXOS_ORG_MISMATCH', 403, 'Không được phép xuất gói giải pháp của tổ chức khác.');
      }
      const appKey = String(ctx?.action?.params?.appKey || payload.appKey || ctx?.action?.params?.filterByTk || '').trim() || null;
      ctx.body = await exportAppBundle(targetDb, actor, {
        appKey,
        organizationId: requestedOrg || actor.organizationId,
      });
      if (typeof next === 'function') await next();
    },

    async teardownBuiltApp(ctx, next) {
      if (ctx.method && String(ctx.method).toUpperCase() !== 'POST') {
        throw failTool('METHOD_NOT_ALLOWED', 405, 'Cần phương thức POST.');
      }
      const targetDb = await requireAdmin(ctx);
      const actor = await resolveActorScope(ctx, targetDb);
      const payload = readActionPayload(ctx);
      const requestedOrg = String(payload.organizationId || ctx?.action?.params?.organizationId || '').trim();
      if (!isRootActor(actor) && requestedOrg && requestedOrg !== actor.organizationId) {
        throw failTool('DXOS_ORG_MISMATCH', 403, 'Không được phép gỡ ứng dụng của tổ chức khác.');
      }
      const effectiveActor = isRootActor(actor) && requestedOrg ? { ...actor, organizationId: requestedOrg } : actor;
      const appKey = String(payload.appKey || ctx?.action?.params?.appKey || ctx?.action?.params?.filterByTk || '').trim();
      if (!appKey) {
        throw failTool('APP_KEY_REQUIRED', 400, 'Cần appKey để gỡ ứng dụng.');
      }
      const keepData = payload.keepData === false ? false : true;
      ctx.body = await teardownBuiltAppEngine(ctx, targetDb, effectiveActor, { appKey, keepData }, { env, fetchImpl });
      if (typeof next === 'function') await next();
    },

    async listMemories(ctx, next) {
      if (ctx.method && String(ctx.method).toUpperCase() !== 'GET') {
        throw failTool('METHOD_NOT_ALLOWED', 405, 'Cần phương thức GET.');
      }
      const targetDb = resolveDb(ctx);
      const actor = await resolveActorScope(ctx, targetDb);
      const payload = readActionPayload(ctx);
      const params = ctx?.action?.params || {};
      const partition = resolveScopedMemoryParams(ctx, actor, payload, { isMutation: false, actionName: 'listMemories' });
      ctx.body = await listPersistentMemories(targetDb, {
        ...partition,
        tags: payload.tags ?? params.tags,
        memoryKey: payload.memoryKey ?? params.memoryKey,
        includeExpired: payload.includeExpired === true || params.includeExpired === true || params.includeExpired === 'true',
        limit: payload.limit ?? params.limit,
        offset: payload.offset ?? params.offset,
      });
      if (typeof next === 'function') await next();
    },

    async rememberFact(ctx, next) {
      if (ctx.method && String(ctx.method).toUpperCase() !== 'POST') {
        throw failTool('METHOD_NOT_ALLOWED', 405, 'Cần phương thức POST.');
      }
      const targetDb = resolveDb(ctx);
      const actor = await resolveActorScope(ctx, targetDb);
      const payload = readActionPayload(ctx);
      const partition = resolveScopedMemoryParams(ctx, actor, payload, { isMutation: true, actionName: 'rememberFact' });
      const res = await rememberPersistentFact(targetDb, {
        memoryKey: payload.memoryKey,
        content: payload.content,
        tags: payload.tags ?? payload.tagsJson,
        metadata: payload.metadata ?? payload.metadataJson,
        importance: payload.importance,
        source: payload.source || 'rest',
        expiresAt: payload.expiresAt,
        ttlSeconds: payload.ttlSeconds,
        upsert: payload.upsert,
        ...partition,
        createdById: String(actor.userId),
      });
      await recordAiAuditLog(targetDb, {
        actorUserId: actor.userId,
        actorUsername: actor.username,
        organizationId: partition.organizationId,
        channel: 'ai-memory',
        toolName: 'dxosAi:rememberFact',
        argsSummary: { scope: partition.scope, memoryKey: payload.memoryKey },
        status: 'allowed',
        resultSummary: `Memory ${res.action}: ${payload.memoryKey}`,
      });
      ctx.body = res;
      if (typeof next === 'function') await next();
    },

    async recallMemories(ctx, next) {
      if (ctx.method && !['GET', 'POST'].includes(String(ctx.method).toUpperCase())) {
        throw failTool('METHOD_NOT_ALLOWED', 405, 'Cần phương thức GET hoặc POST.');
      }
      const targetDb = resolveDb(ctx);
      const actor = await resolveActorScope(ctx, targetDb);
      const payload = readActionPayload(ctx);
      const params = ctx?.action?.params || {};
      const partition = resolveScopedMemoryParams(ctx, actor, payload, { isMutation: false, actionName: 'recallMemories' });
      ctx.body = await recallPersistentMemories(targetDb, {
        ...partition,
        query: payload.query ?? params.query ?? '',
        tags: payload.tags ?? params.tags,
        requireAllTags: payload.requireAllTags === true || params.requireAllTags === true,
        limit: payload.limit ?? params.limit,
        minScore: payload.minScore ?? params.minScore,
        touchAccess: payload.touchAccess !== false && params.touchAccess !== false,
      });
      if (typeof next === 'function') await next();
    },

    async forgetMemory(ctx, next) {
      if (ctx.method && !['POST', 'DELETE'].includes(String(ctx.method).toUpperCase())) {
        throw failTool('METHOD_NOT_ALLOWED', 405, 'Cần phương thức POST hoặc DELETE.');
      }
      const targetDb = resolveDb(ctx);
      const actor = await resolveActorScope(ctx, targetDb);
      const payload = readActionPayload(ctx);
      const params = ctx?.action?.params || {};
      const partition = resolveScopedMemoryParams(ctx, actor, payload, { isMutation: true, actionName: 'forgetMemory' });
      const res = await forgetPersistentMemory(targetDb, {
        ...partition,
        id: payload.id ?? params.id ?? params.filterByTk,
        memoryKey: payload.memoryKey ?? params.memoryKey,
      });
      await recordAiAuditLog(targetDb, {
        actorUserId: actor.userId,
        actorUsername: actor.username,
        organizationId: partition.organizationId,
        channel: 'ai-memory',
        toolName: 'dxosAi:forgetMemory',
        argsSummary: { scope: partition.scope, memoryKey: payload.memoryKey || params.memoryKey || null, deletedCount: res.deletedCount },
        status: 'allowed',
        resultSummary: `Forgot ${res.deletedCount} memory records`,
      });
      ctx.body = res;
      if (typeof next === 'function') await next();
    },

    async listAgentTraces(ctx, next) {
      if (ctx.method && String(ctx.method).toUpperCase() !== 'GET') {
        throw failTool('METHOD_NOT_ALLOWED', 405, 'Cần phương thức GET.');
      }
      const targetDb = await requireAdmin(ctx);
      const actor = await resolveActorScope(ctx, targetDb);
      const payload = readActionPayload(ctx);
      const params = ctx?.action?.params || {};
      const organizationId = resolveAdminOrgScope(ctx, actor, payload, 'listAgentTraces');
      ctx.body = await listEvalAgentTraces(targetDb, {
        organizationId,
        agent: params.agent ?? payload.agent ?? params.aiEmployee ?? payload.aiEmployee,
        status: params.status ?? payload.status,
        traceId: params.traceId ?? payload.traceId,
        limit: params.limit ?? payload.limit,
        offset: params.offset ?? payload.offset,
      });
      if (typeof next === 'function') await next();
    },

    async getAgentTraceDetail(ctx, next) {
      if (ctx.method && String(ctx.method).toUpperCase() !== 'GET') {
        throw failTool('METHOD_NOT_ALLOWED', 405, 'Cần phương thức GET.');
      }
      const targetDb = await requireAdmin(ctx);
      const actor = await resolveActorScope(ctx, targetDb);
      const payload = readActionPayload(ctx);
      const params = ctx?.action?.params || {};
      const organizationId = resolveAdminOrgScope(ctx, actor, payload, 'getAgentTraceDetail');
      const traceId = String(params.traceId || payload.traceId || params.filterByTk || '').trim();
      const detail = await getEvalAgentTraceDetail(targetDb, { organizationId, traceId });
      if (!detail) {
        throw failTool('TRACE_NOT_FOUND', 404, `Không tìm thấy trace "${traceId}" trong phạm vi tổ chức.`);
      }
      ctx.body = detail;
      if (typeof next === 'function') await next();
    },

    async listEvalSuites(ctx, next) {
      if (ctx.method && String(ctx.method).toUpperCase() !== 'GET') {
        throw failTool('METHOD_NOT_ALLOWED', 405, 'Cần phương thức GET.');
      }
      await requireAdmin(ctx);
      ctx.body = { suites: listEvalLabSuites() };
      if (typeof next === 'function') await next();
    },

    async runEvalBenchmark(ctx, next) {
      if (ctx.method && String(ctx.method).toUpperCase() !== 'POST') {
        throw failTool('METHOD_NOT_ALLOWED', 405, 'Cần phương thức POST.');
      }
      const targetDb = await requireAdmin(ctx);
      const actor = await resolveActorScope(ctx, targetDb);
      const payload = readActionPayload(ctx);
      const organizationId = resolveAdminOrgScope(ctx, actor, payload, 'runEvalBenchmark');
      ctx.body = await runEvalLabBenchmark(targetDb, {
        organizationId,
        suiteId: payload.suiteId,
        customCases: payload.customCases,
        limit: payload.limit,
        mode: payload.mode,
        modelName: payload.modelName,
        actor,
      });
      if (typeof next === 'function') await next();
    },
  };
}

module.exports = {
  SUPPORTED_HITL_TOOLS,
  QUICK_CONNECT_PROVIDER_PRESETS,
  validateQuickConnectBaseUrl,
  serializeProfile,
  ensureLocalLlmServiceRecord,
  ensureDefaultAiWorkforce,
  probeLlmHealth,
  upsertAndSyncProfile,
  createDxosAiActions,
};
