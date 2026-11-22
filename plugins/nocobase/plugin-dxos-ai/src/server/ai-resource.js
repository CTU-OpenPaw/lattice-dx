/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const {
  STARTER_AI_BLUEPRINTS,
  validateAiProfilePayload,
  recordAiAuditLog,
} = require('./ai-schemas');
const {
  ALL_LDX_ROLES,
  DEFAULT_ADMIN_ROLES,
  val,
  enforceProfileRoleLock,
  syncProfileToNocobaseAi,
} = require('./ai-sync');
const {
  ADMIN_BUILDER_TOOL_NAMES,
  OPERATIONAL_TOOL_NAMES,
  failTool,
  resolveCallerRoleNames,
  isStudioAdmin,
  resolveActorScope,
  createDxosTools,
} = require('./ai-tools-core');
const {
  isRootActor,
  isHitlApprover,
  listApprovals,
  decideApproval,
} = require('./ai-hitl');
const { buildEnterpriseTopology } = require('./mcp-itot-tools');
const {
  resolvePageGrid,
  extractGridBlockUids,
  hydrateFlowModel,
  readFlowModelMeta,
  restorePageSnapshot,
  getSurfaceRevisionState,
} = require('./ai-surface-creative-tools');
const { createSurfaceEventsHandler } = require('./surface-events');
const { getQuotaSummaryPersistent } = require('./ai-governance');

function serializeProfile(row) {
  if (!row) return null;
  return {
    id: val(row, 'id') ?? null,
    username: val(row, 'username'),
    nickname: val(row, 'nickname'),
    position: val(row, 'position') || '',
    departmentScope: val(row, 'departmentScope') || 'general',
    organizationId: val(row, 'organizationId') || 'native-ui-lab',
    avatar: val(row, 'avatar') || 'nocobase-015-male',
    bio: val(row, 'bio') || '',
    greeting: val(row, 'greeting') || '',
    systemPrompt: val(row, 'systemPrompt') || '',
    llmService: val(row, 'llmService') || 'local-9router',
    modelName: val(row, 'modelName') || 'ag/gemini-3.8-flash',
    enabled: val(row, 'enabled') !== false,
    isAdminBuilder: Boolean(val(row, 'isAdminBuilder')),
    allowSubAgentDispatch: Boolean(val(row, 'allowSubAgentDispatch')),
    allowedRoles: Array.isArray(val(row, 'allowedRoles')) ? val(row, 'allowedRoles') : [],
    toolPermissions: val(row, 'toolPermissions') && typeof val(row, 'toolPermissions') === 'object' ? val(row, 'toolPermissions') : {},
    mcpServers: Array.isArray(val(row, 'mcpServers')) ? val(row, 'mcpServers') : [],
    portalBindings: Array.isArray(val(row, 'portalBindings')) ? val(row, 'portalBindings') : [],
    quickPrompts: Array.isArray(val(row, 'quickPrompts')) ? val(row, 'quickPrompts') : [],
    version: Number(val(row, 'version')) || 1,
    createdAt: val(row, 'createdAt') || null,
    updatedAt: val(row, 'updatedAt') || null,
  };
}

function serializeAuditLog(row) {
  return {
    id: val(row, 'id'),
    actorUserId: val(row, 'actorUserId'),
    actorUsername: val(row, 'actorUsername'),
    organizationId: val(row, 'organizationId'),
    channel: val(row, 'channel'),
    aiEmployee: val(row, 'aiEmployee'),
    toolName: val(row, 'toolName'),
    argsSummary: val(row, 'argsSummary') || {},
    status: val(row, 'status'),
    durationMs: Number(val(row, 'durationMs')) || 0,
    promptTokens: Number(val(row, 'promptTokens')) || 0,
    completionTokens: Number(val(row, 'completionTokens')) || 0,
    estimatedCostUsd: Number(val(row, 'estimatedCostUsd')) || 0,
    piiRedactedCount: Number(val(row, 'piiRedactedCount')) || 0,
    errorCode: val(row, 'errorCode') || null,
    resultSummary: val(row, 'resultSummary') || null,
    createdAt: val(row, 'createdAt') || null,
  };
}

function buildCatalogMeta() {
  return {
    starterCount: STARTER_AI_BLUEPRINTS.length,
    availableTools: [...ADMIN_BUILDER_TOOL_NAMES, ...OPERATIONAL_TOOL_NAMES],
    adminBuilderTools: [...ADMIN_BUILDER_TOOL_NAMES],
    operationalTools: [...OPERATIONAL_TOOL_NAMES],
    roleOptions: [...DEFAULT_ADMIN_ROLES, ...ALL_LDX_ROLES],
    defaultLlmService: 'local-9router',
    defaultModelName: 'ag/gemini-3.8-flash',
  };
}

function readActionPayload(ctx) {
  return ctx?.action?.params?.values || ctx?.request?.body?.values || ctx?.request?.body || ctx?.action?.params || {};
}

async function ensureLocalLlmServiceRecord(db, env = process.env) {
  const llmRepo = db?.getRepository?.('llmServices');
  if (!llmRepo) {
    return { configured: false, skipped: true, reason: 'llmServices repository unavailable' };
  }
  const apiKey = String(env?.AGENT_API_KEY || env?.NINE_ROUTER_API_KEY || '').trim();
  const baseURL = String(env?.AGENT_BASE_URL || 'http://host.docker.internal:20128/v1').trim();
  const existing = await llmRepo.findOne({ filter: { name: 'local-9router' } });
  if (!apiKey && !existing) {
    return {
      configured: false,
      skipped: true,
      reason: 'AGENT_API_KEY env var not set; configure API key via LLM Services or AGENT_API_KEY.',
    };
  }
  const values = {
    name: 'local-9router',
    title: 'Local 9router (OpenAI-compatible)',
    provider: 'openai-completions',
    enabledModels: {
      mode: 'custom',
      models: [
        { label: 'ag/gemini-3.8-flash (9router)', value: 'ag/gemini-3.8-flash' },
        { label: 'combo (9router auto-route)', value: 'combo' },
      ],
    },
    enabled: true,
    ...(apiKey ? { options: { baseURL, apiKey } } : {}),
  };
  if (existing && typeof existing.update === 'function') {
    await existing.update(values);
  } else {
    await llmRepo.create({ values });
  }
  return { configured: true, skipped: false, serviceName: 'local-9router', baseURL };
}

async function upsertAndSyncProfile(db, input, { actorUser, defaultOrigin, auditToolName = 'dxosAi:saveProfile' } = {}) {
  const validated = validateAiProfilePayload(input, { adminToolNames: ADMIN_BUILDER_TOOL_NAMES });
  const locked = enforceProfileRoleLock(validated, ADMIN_BUILDER_TOOL_NAMES);
  const profileRepo = db?.getRepository?.('latticeAiProfiles');
  let savedRow = locked;

  if (profileRepo) {
    const existing = await profileRepo.findOne({ filter: { username: locked.username } });
    const nextVersion = existing ? (Number(val(existing, 'version')) || 1) + 1 : locked.version;
    const recordValues = { ...locked, version: nextVersion };
    if (existing && typeof existing.update === 'function') {
      savedRow = await existing.update(recordValues);
    } else {
      savedRow = await profileRepo.create({ values: recordValues });
    }
  }

  const normalized = serializeProfile(savedRow) || locked;
  const sync = await syncProfileToNocobaseAi(db, normalized, {
    adminToolNames: ADMIN_BUILDER_TOOL_NAMES,
    defaultOrigin,
  });

  if (auditToolName) {
    await recordAiAuditLog(db, {
      actorUserId: val(actorUser, 'id') ?? null,
      actorUsername: val(actorUser, 'username') || null,
      organizationId: normalized.organizationId,
      channel: 'studio-sync',
      aiEmployee: normalized.username,
      toolName: auditToolName,
      argsSummary: {
        username: normalized.username,
        isAdminBuilder: normalized.isAdminBuilder,
        allowedRoles: normalized.allowedRoles,
        portalBindings: normalized.portalBindings,
      },
      status: 'allowed',
      resultSummary: `Synced AI profile ${normalized.username} (v${normalized.version})`,
    });
  }

  return { profile: normalized, sync };
}

async function computeAllTimeAuditTotals(targetDb, organizationId) {
  const empty = { records: 0, promptTokens: 0, completionTokens: 0, estimatedCostUsd: 0, piiRedactedCount: 0 };
  if (typeof targetDb?.sequelize?.query === 'function') {
    try {
      const [rows] = await targetDb.sequelize.query(
        `SELECT COUNT(*)::int AS records,
                COALESCE(SUM("promptTokens"), 0)::bigint AS "promptTokens",
                COALESCE(SUM("completionTokens"), 0)::bigint AS "completionTokens",
                COALESCE(SUM("estimatedCostUsd"), 0)::double precision AS "estimatedCostUsd",
                COALESCE(SUM("piiRedactedCount"), 0)::int AS "piiRedactedCount"
         FROM "latticeAiAuditLogs"
         WHERE "organizationId" = :organizationId;`,
        { replacements: { organizationId } },
      );
      if (Array.isArray(rows) && rows[0]) {
        const r = rows[0];
        return {
          records: Number(r.records) || 0,
          promptTokens: Number(r.promptTokens) || 0,
          completionTokens: Number(r.completionTokens) || 0,
          estimatedCostUsd: Number((Number(r.estimatedCostUsd) || 0).toFixed(6)),
          piiRedactedCount: Number(r.piiRedactedCount) || 0,
        };
      }
    } catch {
      // Fallback to repository scan in mock harnesses
    }
  }
  const repo = targetDb?.getRepository?.('latticeAiAuditLogs');
  if (!repo || typeof repo.find !== 'function') return empty;
  const rows = (await repo.find({ filter: { organizationId }, sort: ['-id'], limit: 5000 })) || [];
  const totals = { ...empty };
  for (const r of rows) {
    totals.records += 1;
    totals.promptTokens += Number(val(r, 'promptTokens')) || 0;
    totals.completionTokens += Number(val(r, 'completionTokens')) || 0;
    totals.estimatedCostUsd += Number(val(r, 'estimatedCostUsd')) || 0;
    totals.piiRedactedCount += Number(val(r, 'piiRedactedCount')) || 0;
  }
  totals.estimatedCostUsd = Number(totals.estimatedCostUsd.toFixed(6));
  return totals;
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

  async function runHitlDecision(ctx, decision, buildExecutor) {
    if (ctx.method && String(ctx.method).toUpperCase() !== 'POST') {
      throw failTool('METHOD_NOT_ALLOWED', 405, 'Cần phương thức POST.');
    }
    const targetDb = resolveDb(ctx);
    const actor = await resolveActorScope(ctx, targetDb);
    const payload = readActionPayload(ctx);
    const approvalId = payload.approvalId ?? payload.id ?? ctx?.action?.params?.approvalId ?? ctx?.action?.params?.filterByTk;
    const note = payload.note ?? payload.decisionNote ?? payload.reason ?? '';
    return decideApproval(targetDb, {
      actor,
      approvalId,
      decision,
      note,
      ...(typeof buildExecutor === 'function' ? { executeApprovedWrite: buildExecutor(targetDb, actor) } : {}),
    });
  }

  return {
    async listProfiles(ctx, next) {
      const targetDb = await requireAdmin(ctx);
      const repo = targetDb?.getRepository?.('latticeAiProfiles');
      const rows = repo ? (await repo.find({ sort: ['username'] })) || [] : [];
      ctx.body = {
        profiles: rows.map(serializeProfile),
        catalog: buildCatalogMeta(),
      };
      if (typeof next === 'function') await next();
    },

    async saveProfile(ctx, next) {
      const targetDb = await requireAdmin(ctx);
      const actorUser = ctx?.state?.currentUser || ctx?.auth?.user;
      const payload = readActionPayload(ctx);
      const defaultOrigin = env?.NOCOBASE_INTERNAL_URL;
      ctx.body = await upsertAndSyncProfile(targetDb, payload, { actorUser, defaultOrigin });
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
      const defaultOrigin = env?.NOCOBASE_INTERNAL_URL;

      const profiles = [];
      for (const bp of STARTER_AI_BLUEPRINTS) {
        const res = await upsertAndSyncProfile(targetDb, bp, {
          actorUser,
          defaultOrigin,
          auditToolName: null,
        });
        profiles.push(res.profile.username);
      }

      const llm = await ensureLocalLlmServiceRecord(targetDb, env);
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

    async portalCopilot(ctx, next) {
      const targetDb = resolveDb(ctx);
      const user = ctx?.state?.currentUser || ctx?.auth?.user;
      const userId = val(user, 'id');
      if (!userId) {
        throw failTool('NATIVE_LOGIN_REQUIRED', 401, 'Yêu cầu đăng nhập để xem danh sách AI hỗ trợ.');
      }

      const roleNames = await resolveCallerRoleNames(ctx, targetDb, userId);
      const callerIsAdmin = await isStudioAdmin(ctx, targetDb);
      const payload = readActionPayload(ctx);
      const portalSlug = String(ctx?.action?.params?.portalSlug || payload.portalSlug || '').trim().toLowerCase();

      const repo = targetDb?.getRepository?.('latticeAiProfiles');
      const rows = repo ? (await repo.find({ filter: { enabled: true }, sort: ['username'] })) || [] : [];
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
      const params = ctx?.action?.params || {};
      const filter = {};
      if (params.channel) filter.channel = String(params.channel).trim();
      if (params.status) filter.status = String(params.status).trim();
      if (params.toolName) filter.toolName = String(params.toolName).trim();
      const limit = Math.max(1, Math.min(200, Number(params.pageSize || params.limit) || 50));

      const repo = targetDb?.getRepository?.('latticeAiAuditLogs');
      const rows = repo ? (await repo.find({ filter, sort: ['-id'], limit })) || [] : [];
      ctx.body = { items: rows.map(serializeAuditLog) };
      if (typeof next === 'function') await next();
    },

    async quotaSummary(ctx, next) {
      const targetDb = await requireAdmin(ctx);
      const params = readActionPayload(ctx);
      const requestedOrg = String(ctx?.action?.params?.organizationId || params.organizationId || 'native-ui-lab').trim();
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
      ctx.body = await buildEnterpriseTopology(targetDb, env, fetchImpl, ctx?.app);
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

    async approveAction(ctx, next) {
      ctx.body = await runHitlDecision(ctx, 'approve', (targetDb, actor) => async (row) => {
        if (row.toolName !== 'dxos_execute_record_action') {
          throw failTool('HITL_UNSUPPORTED_TOOL', 400, `Công cụ "${row.toolName}" chưa hỗ trợ thực thi qua hàng chờ HITL.`);
        }
        if (!isRootActor(actor) && row.organizationId !== actor.organizationId) {
          throw failTool('DXOS_ORG_MISMATCH', 403, 'Không được phép thực thi yêu cầu HITL của tổ chức khác.');
        }
        const rawArgs = row.proposedArgs && typeof row.proposedArgs === 'object' && !Array.isArray(row.proposedArgs)
          ? row.proposedArgs
          : null;
        if (!rawArgs) {
          throw failTool('HITL_ARGS_MISMATCH', 409, 'Dữ liệu proposedArgs của yêu cầu phê duyệt không hợp lệ.');
        }
        const argsCol = String(rawArgs.collection || '').trim();
        const argsOp = String(rawArgs.operation || '').trim();
        const argsRecId = rawArgs.recordId != null && String(rawArgs.recordId).trim() !== '' ? Number(rawArgs.recordId) : null;
        const rowRecId = row.targetRecordId != null ? Number(row.targetRecordId) : null;
        if (
          argsCol !== String(row.targetCollection || '').trim()
          || argsOp !== String(row.operation || '').trim()
          || argsRecId !== rowRecId
        ) {
          throw failTool('HITL_ARGS_MISMATCH', 409, 'Dữ liệu proposedArgs không khớp với thông tin hàng chờ phê duyệt.');
        }
        const execTool = createDxosTools().find((t) => t.definition.name === 'dxos_execute_record_action');
        if (!execTool) {
          throw failTool('HITL_TOOL_UNAVAILABLE', 503, 'Công cụ dxos_execute_record_action chưa sẵn sàng.');
        }
        let requesterEmployeeId = null;
        if (row.requesterUserId != null && row.organizationId) {
          const empRepo = targetDb?.getRepository?.('latticeEmployees');
          if (empRepo && typeof empRepo.find === 'function') {
            const empRows = (await empRepo.find({
              filter: { userId: Number(row.requesterUserId), organizationId: row.organizationId, active: true },
              limit: 5,
            })) || [];
            const matchedEmp = empRows.find(
              (e) => Number(val(e, 'userId')) === Number(row.requesterUserId)
                && val(e, 'organizationId') === row.organizationId
                && val(e, 'active') !== false,
            );
            if (matchedEmp && val(matchedEmp, 'id') != null) {
              requesterEmployeeId = Number(val(matchedEmp, 'id'));
            }
          }
        }
        const execCtx = {
          app: ctx.app,
          db: targetDb,
          dataSource: ctx.dataSource || ctx.app?.mainDataSource,
          auth: ctx.auth,
          headers: ctx.headers,
          request: ctx.request,
          state: {
            ...(ctx.state || {}),
            dxosApprovedQueueId: row.id,
            dxosAuditChannel: 'hitl-approval',
            dxosAiUsername: row.aiEmployee || null,
            dxosRequesterEmployeeId: requesterEmployeeId,
            ...(isRootActor(actor) && row.organizationId ? { dxosTargetOrganizationId: row.organizationId, defaultOrgId: row.organizationId } : {}),
          },
        };
        return execTool.invoke(execCtx, { ...rawArgs, requireApproval: false });
      });
      if (typeof next === 'function') await next();
    },

    async rejectAction(ctx, next) {
      ctx.body = await runHitlDecision(ctx, 'reject');
      if (typeof next === 'function') await next();
    },
  };
}

module.exports = {
  serializeProfile,
  ensureLocalLlmServiceRecord,
  upsertAndSyncProfile,
  createDxosAiActions,
};
