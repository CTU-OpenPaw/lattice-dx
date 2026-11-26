/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { createHash, timingSafeEqual } = require('node:crypto');
const path = require('node:path');
const {
  runListConnectors,
  runTestConnector,
  runInvokeN8n,
  runListN8nWorkflows,
  runCreateN8nWorkflow,
  runUpdateN8nWorkflow,
  runActivateN8nWorkflow,
  runListN8nExecutions,
  runRetryN8nExecution,
  runSyncN8nCredential,
  runListConnectedApps,
} = require('./n8n-bridge-tool');
const {
  FORBIDDEN_AUTOMATION_KEYS,
  AUTOMATION_RULE_KEY_RE,
  SAFE_SAVE_RULE_KEY_RE,
  VALID_AUTOMATION_ACTION_TYPES,
  AUTOMATION_CORE_VOUCHERS,
  AUTOMATION_PROTECTED_VOUCHER_FIELDS,
  isPlainObject,
  stripDiacriticsSimple,
  sanitizeAutomationValue,
  publishFlowStudioUpdate,
  publishPatchAutomationUpdate,
  hasForbiddenProtoKeys,
  hasUnsafeAutomationTemplate,
  isAllowlistedAutomationCollection,
  validateFlowGraphInput,
  assertSafeAutomationInput,
  matchesFilterLocal,
  interpolateLocal,
} = require('./ai-builder-security');
const { hasProtectedCollectionMatch } = require('./ai-builder-schema');

const AI_ASSIST_TIMEOUT_MS = 45000;
const ALLOWED_WORKFLOW_NODE_TYPES = ['condition', 'manual', 'update', 'create', 'query', 'calculation', 'output', 'parallel', 'delay'];
const V1_SEMANTIC_TARGETS = new Set(['cooldown', 'guard', 'filter', 'dmn', 'actions', 'step:new']);

async function resolveOrgCrewBindings(db, organizationId, val) {
  const empRepo = db?.getRepository?.('latticeEmployees');
  if (!empRepo) return {};
  const rows = (await empRepo.find({ filter: { organizationId, active: true }, appends: ['user', 'user.roles'], limit: 100 })) || [];
  const byRole = {};
  for (const row of rows) {
    const id = val(row, 'id');
    const roles = Array.isArray(val(val(row, 'user'), 'roles')) ? val(val(row, 'user'), 'roles').map((r) => val(r, 'name')) : [];
    for (const r of roles) {
      if (!byRole[r]) byRole[r] = id;
    }
  }
  const fallback = val(rows[0], 'id');
  const mgr = byRole.ldx_manager || byRole.ldx_admin || fallback;
  const worker = byRole.ldx_warehouse || byRole.ldx_employee || fallback;
  return {
    ...(mgr ? { managerEmployeeId: mgr, reviewerEmployeeId: mgr } : {}),
    ...(worker ? { warehouseEmployeeId: worker, assigneeEmployeeId: worker, handlerEmployeeId: worker } : {}),
    ...(byRole.ldx_dispatcher || mgr ? { dispatcherEmployeeId: byRole.ldx_dispatcher || mgr } : {}),
    ...(byRole.ldx_driver || worker ? { driverEmployeeId: byRole.ldx_driver || worker } : {}),
  };
}

/**
 * Load a sibling @latticedx/plugin-dxos-studio server module cleanly, rethrowing transitive errors.
 */
function loadStudioModule(moduleName) {
  const inDist = __dirname.includes(`${path.sep}dist${path.sep}`);
  const candidates = inDist
    ? [
        `@latticedx/plugin-dxos-studio/dist/server/${moduleName}`,
        `@latticedx/plugin-dxos-studio/src/server/${moduleName}`,
        `../../../plugin-dxos-studio/dist/server/${moduleName}`,
        `../../../plugin-dxos-studio/src/server/${moduleName}`,
      ]
    : [
        `@latticedx/plugin-dxos-studio/src/server/${moduleName}`,
        `../../../plugin-dxos-studio/src/server/${moduleName}`,
        `../../../plugin-dxos-studio/dist/server/${moduleName}`,
      ];
  for (const modPath of candidates) {
    try {
      return require(modPath);
    } catch (err) {
      const isDirectMissing = err?.code === 'MODULE_NOT_FOUND'
        && (!Array.isArray(err.requireStack) || err.requireStack.length === 0 || err.requireStack[0] === __filename);
      if (!isDirectMissing) throw err;
    }
  }
  return null;
}

function loadStudioAutomationEngine() {
  return loadStudioModule('automation-engine');
}

function loadStudioFlowArchitect() {
  return loadStudioModule('flow/architect');
}

function loadStudioFlowSchema() {
  return loadStudioModule('flow/schema');
}

function loadStudioFlowExecutor() {
  return loadStudioModule('flow/executor');
}

function hasResourceAction(hasRes, ctx, resourceName, actionName) {
  const res = hasRes(ctx, resourceName);
  const handler = res?.actions?.get?.(actionName)?.handler || res?.actions?.[actionName];
  return typeof handler === 'function';
}

function isNativeMembershipRequiredError(err) {
  if (!err) return false;
  if (err.code === 'NATIVE_MEMBERSHIP_REQUIRED') return true;
  return err.code === 'HOST_ACTION_ERROR'
    && err.status === 403
    && /\bNATIVE_MEMBERSHIP_REQUIRED\b/.test(String(err.message || ''));
}

async function verifyStudioAdmin(ctx, db, actor, deps) {
  if (typeof deps?.isStudioAdmin === 'function') {
    return Boolean(await deps.isStudioAdmin(ctx, db));
  }
  return Boolean(actor?.isAdmin);
}

async function hasVerifiedRootRole(ctx, db, actor, deps) {
  const headerRole = String(ctx?.headers?.['x-role'] || ctx?.request?.headers?.['x-role'] || '').trim();
  if (headerRole && headerRole !== 'root') return false;

  const callerRoles = typeof deps?.resolveCallerRoleNames === 'function'
    ? await deps.resolveCallerRoleNames(ctx, db, actor?.userId)
    : [];
  const stateRoles = Array.isArray(ctx?.state?.currentRoles)
    ? ctx.state.currentRoles.map((r) => String(r || '').trim()).filter(Boolean)
    : [];

  const ruRepo = db?.getRepository?.('rolesUsers');
  if (ruRepo && typeof ruRepo.find === 'function' && actor?.userId != null) {
    const rows = (await ruRepo.find({ filter: { userId: actor.userId } })) || [];
    const dbRoles = rows.map((r) => String(deps.val(r, 'roleName') || '').trim()).filter(Boolean);
    if (!dbRoles.includes('root')) return false;
    if (stateRoles.length && !stateRoles.includes('root')) return false;
    return true;
  }

  return Boolean(
    actor?.isRoot
    || callerRoles.includes('root')
    || stateRoles.includes('root')
    || ctx?.state?.currentUser?.isRoot === true,
  );
}

async function buildAutomationDelegationCtx(ctx, db, actor, deps) {
  const isRootCaller = await hasVerifiedRootRole(ctx, db, actor, deps);
  if (!isRootCaller) return ctx;
  return {
    ...ctx,
    state: {
      ...(ctx?.state || {}),
      currentRole: 'root',
    },
  };
}

async function invokeDxosAutomationsAction(ctx, db, actor, actionName, options, deps) {
  const { invokeResourceAction } = deps;
  const delegationCtx = await buildAutomationDelegationCtx(ctx, db, actor, deps);
  try {
    const result = await invokeResourceAction(delegationCtx, 'dxosAutomations', actionName, options);
    return { ok: true, result };
  } catch (err) {
    const isAdminVerified = await verifyStudioAdmin(ctx, db, actor, deps);
    if (isAdminVerified && isNativeMembershipRequiredError(err)) {
      return { ok: false, fallbackReason: 'NATIVE_MEMBERSHIP_REQUIRED' };
    }
    throw err;
  }
}

async function summarizeAutomationRuns(db, organizationId, val) {
  const runsRepo = db?.getRepository?.('latticeAutomationRuns');
  if (!runsRepo || typeof runsRepo.find !== 'function') {
    return { totalRecentRuns: 0, byRuleKey: {} };
  }
  const rawRuns = (await runsRepo.find({ filter: { organizationId }, sort: ['-id'], limit: 200 })) || [];
  const scopedRuns = rawRuns.filter((run) => val(run, 'organizationId') === organizationId);
  const byRuleKey = {};
  for (const run of scopedRuns) {
    const rk = String(val(run, 'ruleKey') || (val(run, 'ruleId') != null ? `id:${val(run, 'ruleId')}` : '')).trim();
    if (!rk || FORBIDDEN_AUTOMATION_KEYS.has(rk)) continue;
    const status = String(val(run, 'status') || 'unknown').trim().toLowerCase();
    const runId = Number(val(run, 'id')) || 0;
    const ranAt = val(run, 'finishedAt') || val(run, 'startedAt') || val(run, 'createdAt') || null;
    const ranAtIso = ranAt instanceof Date ? ranAt.toISOString() : (ranAt ? String(ranAt) : null);
    if (!Object.hasOwn(byRuleKey, rk)) {
      byRuleKey[rk] = {
        totalRuns: 0,
        succeededRuns: 0,
        failedRuns: 0,
        skippedRuns: 0,
        latestRunId: runId || null,
        latestStatus: status,
        latestRunAt: ranAtIso,
      };
    }
    const bucket = byRuleKey[rk];
    bucket.totalRuns += 1;
    if (status === 'completed' || status === 'succeeded' || status === 'success') bucket.succeededRuns += 1;
    else if (status === 'failed' || status === 'error') bucket.failedRuns += 1;
    else if (status === 'skipped' || status === 'halted') bucket.skippedRuns += 1;
    if (runId > (bucket.latestRunId || 0)) {
      bucket.latestRunId = runId;
      bucket.latestStatus = status;
      bucket.latestRunAt = ranAtIso;
    }
  }
  return { totalRecentRuns: scopedRuns.length, byRuleKey };
}

async function runListAutomations(ctx, db, actor, args, deps) {
  const { val, failTool, hasRes } = deps;
  const triggerEventType = typeof args.triggerEventType === 'string' && args.triggerEventType.trim()
    ? args.triggerEventType.trim()
    : '';
  const limit = Math.max(1, Math.min(200, Number(args.limit) || 50));

  if (hasRes(ctx, 'dxosAutomations')) {
    const listParams = {
      organizationId: actor.organizationId,
      ...(triggerEventType ? { triggerEventType } : {}),
      limit,
    };
    const delegated = await invokeDxosAutomationsAction(ctx, db, actor, 'listRules', {
      ...listParams,
      values: listParams,
      method: 'GET',
    }, deps);
    if (delegated.ok) return delegated.result;
  }

  const rulesRepo = db?.getRepository?.('latticeAutomationRules');
  if (!rulesRepo || typeof rulesRepo.find !== 'function') {
    throw failTool('AUTOMATION_ENGINE_UNAVAILABLE', 503, 'Dịch vụ Automation (dxosAutomations / latticeAutomationRules) chưa sẵn sàng.');
  }

  const filter = {
    organizationId: actor.organizationId,
    ...(triggerEventType ? { triggerEventType } : {}),
  };
  const rawRules = (await rulesRepo.find({ filter, sort: ['id'], limit })) || [];
  const scopedRules = rawRules
    .filter((r) => {
      if (val(r, 'organizationId') !== actor.organizationId) return false;
      if (triggerEventType && String(val(r, 'triggerEventType') || '').trim() !== triggerEventType) return false;
      return true;
    })
    .slice(0, limit);

  const runSummary = await summarizeAutomationRuns(db, actor.organizationId, val);
  const items = scopedRules.map((r) => {
    const id = val(r, 'id') ?? null;
    const rk = val(r, 'ruleKey') || null;
    const stats = (rk && Object.hasOwn(runSummary.byRuleKey, rk) ? runSummary.byRuleKey[rk] : null)
      || (id != null && Object.hasOwn(runSummary.byRuleKey, `id:${id}`) ? runSummary.byRuleKey[`id:${id}`] : null);
    const rawActions = val(r, 'actionsJson') ?? val(r, 'actions');
    const actions = Array.isArray(rawActions) ? rawActions : [];
    const graphJson = val(r, 'graphJson');
    const schemaVersion = Number(val(r, 'schemaVersion')) || (isPlainObject(graphJson) && Array.isArray(graphJson.nodes) ? 2 : 1);
    return {
      id,
      ruleKey: rk,
      name: val(r, 'name') || null,
      description: val(r, 'description') || null,
      organizationId: val(r, 'organizationId'),
      triggerEventType: val(r, 'triggerEventType') || null,
      dmnTableKey: val(r, 'dmnTableKey') || null,
      active: val(r, 'active') !== undefined ? Boolean(val(r, 'active')) : (val(r, 'enabled') !== false),
      maxDepth: Number(val(r, 'maxDepth')) || 8,
      schemaVersion,
      actionCount: actions.length,
      nodeCount: Array.isArray(graphJson?.nodes) ? graphJson.nodes.length : actions.length,
      hasGraphV2: Boolean(Array.isArray(graphJson?.nodes) && graphJson.nodes.length),
      runSummary: stats || {
        totalRuns: 0,
        succeededRuns: 0,
        failedRuns: 0,
        skippedRuns: 0,
        latestRunId: null,
        latestStatus: null,
        latestRunAt: null,
      },
    };
  });

  return {
    operation: 'listAutomations',
    organizationId: actor.organizationId,
    count: items.length,
    items,
    totalRecentRuns: runSummary.totalRecentRuns,
  };
}

async function runAutomationExecution(ctx, db, actor, args, deps) {
  const { val, failTool, hasRes } = deps;
  let ruleKey = typeof args.ruleKey === 'string' ? args.ruleKey.trim() : '';
  const parsedWorkflowId = args.workflowId != null ? Number(args.workflowId) : null;
  const ruleId = parsedWorkflowId != null && Number.isInteger(parsedWorkflowId) && parsedWorkflowId > 0
    ? parsedWorkflowId
    : null;
  if (!ruleKey && ruleId == null) {
    throw failTool('AUTOMATION_RULE_KEY_REQUIRED', 400, 'Cần ruleKey hoặc workflowId để chạy automation.');
  }
  if (ruleKey && (FORBIDDEN_AUTOMATION_KEYS.has(ruleKey) || !AUTOMATION_RULE_KEY_RE.test(ruleKey))) {
    throw failTool('AUTOMATION_RULE_KEY_INVALID', 400, 'ruleKey không hợp lệ.');
  }

  if (hasForbiddenProtoKeys(args.sampleEvent) || hasForbiddenProtoKeys(args.config)) {
    throw failTool('AUTOMATION_AI_REFUSED', 400, 'Phát hiện khóa đối tượng bị cấm (__proto__, constructor, prototype).');
  }
  const rawSampleEvent = isPlainObject(args.sampleEvent)
    ? args.sampleEvent
    : (isPlainObject(args.config) ? args.config : {});
  const sampleEvent = sanitizeAutomationValue(rawSampleEvent);

  if (args.dryRun) {
    return {
      dryRun: true,
      operation: 'runAutomation',
      organizationId: actor.organizationId,
      ruleKey: ruleKey || null,
      ...(ruleId != null ? { workflowId: ruleId } : {}),
      sampleEvent,
    };
  }

  const isEnvelope = Boolean(sampleEvent.type || sampleEvent.eventType || isPlainObject(sampleEvent.data));

  if (hasRes(ctx, 'dxosAutomations')) {
    if (!ruleKey && ruleId != null) {
      const rulesRepo = db?.getRepository?.('latticeAutomationRules');
      const byId = rulesRepo?.findOne ? await rulesRepo.findOne({ filter: { organizationId: actor.organizationId, id: ruleId } }) : null;
      if (byId && val(byId, 'organizationId') === actor.organizationId && val(byId, 'ruleKey')) {
        ruleKey = String(val(byId, 'ruleKey')).trim();
      }
    }
    const runParams = {
      organizationId: actor.organizationId,
      ...(ruleKey ? { ruleKey } : {}),
      ...(ruleId != null ? { id: ruleId, ruleId } : {}),
      ...(isEnvelope
        ? {
            sampleEvent,
            event: { ...sampleEvent, organizationId: actor.organizationId },
          }
        : { data: sampleEvent }),
    };
    const delegated = await invokeDxosAutomationsAction(ctx, db, actor, 'runNow', {
      ...runParams,
      values: runParams,
      method: 'POST',
    }, deps);
    if (delegated.ok) {
      const res = delegated.result;
      publishFlowStudioUpdate(actor, {
        operation: 'runAutomation',
        ruleKey: res?.run?.ruleKey || res?.ruleKey || ruleKey || null,
        applied: true,
        run: res?.run || res,
        message: 'Đã thực thi workflow.',
      });
      return res;
    }
  }

  const engineMod = loadStudioAutomationEngine();
  const runFn = engineMod && (
    typeof engineMod.executeAutomationRuleNow === 'function'
      ? engineMod.executeAutomationRuleNow
      : (typeof engineMod.runAutomationNow === 'function' ? engineMod.runAutomationNow : null)
  );
  if (runFn) {
    const res = await runFn(db, {
      organizationId: actor.organizationId,
      ...(ruleKey ? { ruleKey } : {}),
      ...(ruleId != null ? { id: ruleId, ruleId } : {}),
      sampleEvent,
      actor,
      ctx,
    });
    publishFlowStudioUpdate(actor, {
      operation: 'runAutomation',
      ruleKey: res?.run?.ruleKey || res?.ruleKey || ruleKey || null,
      applied: true,
      run: res?.run || res,
      message: 'Đã thực thi workflow.',
    });
    return res;
  }

  if (engineMod && typeof engineMod.executeRuleAgainstEvent === 'function') {
    const rulesRepo = db?.getRepository?.('latticeAutomationRules');
    if (!rulesRepo || typeof rulesRepo.findOne !== 'function') {
      throw failTool('AUTOMATION_ENGINE_UNAVAILABLE', 503, 'Dịch vụ Automation Engine (latticeAutomationRules) chưa sẵn sàng.');
    }
    const filter = ruleKey
      ? { organizationId: actor.organizationId, ruleKey }
      : { organizationId: actor.organizationId, id: ruleId };
    const ruleRow = await rulesRepo.findOne({ filter });
    if (!ruleRow || val(ruleRow, 'organizationId') !== actor.organizationId) {
      throw failTool('AUTOMATION_RULE_NOT_FOUND', 404, `Không tìm thấy automation rule "${ruleKey || ruleId}" trong phạm vi tổ chức.`);
    }
    const eventPayload = isEnvelope
      ? { ...sampleEvent, organizationId: actor.organizationId }
      : {
          type: val(ruleRow, 'triggerEventType') || 'manual.trigger',
          source: 'dxos-ai:dxos_configure_workflow',
          depth: 0,
          organizationId: actor.organizationId,
          data: sampleEvent,
        };
    const run = await engineMod.executeRuleAgainstEvent(db, ruleRow, eventPayload, {
      app: ctx?.app || db?.app,
      actor: {
        id: actor.userId,
        userId: actor.userId,
        employeeId: actor.employeeId,
        username: actor.username,
        organizationId: actor.organizationId,
      },
      ignoreCooldown: true,
    });
    publishFlowStudioUpdate(actor, {
      operation: 'runAutomation',
      ruleKey: run?.ruleKey || ruleKey || val(ruleRow, 'ruleKey') || null,
      applied: true,
      run,
      message: 'Đã thực thi workflow.',
    });
    return { run };
  }

  const flowExecMod = loadStudioFlowExecutor();
  if (flowExecMod && typeof flowExecMod.executeFlowGraph === 'function') {
    const rulesRepo = db?.getRepository?.('latticeAutomationRules');
    if (rulesRepo && typeof rulesRepo.findOne === 'function') {
      const filter = ruleKey
        ? { organizationId: actor.organizationId, ruleKey }
        : { organizationId: actor.organizationId, id: ruleId };
      const ruleRow = await rulesRepo.findOne({ filter });
      if (ruleRow && val(ruleRow, 'organizationId') === actor.organizationId && (Number(val(ruleRow, 'schemaVersion')) === 2 || isPlainObject(val(ruleRow, 'graphJson')))) {
        const eventPayload = isEnvelope
          ? { ...sampleEvent, organizationId: actor.organizationId }
          : {
              type: val(ruleRow, 'triggerEventType') || 'manual.trigger',
              source: 'dxos-ai:dxos_configure_workflow',
              depth: 0,
              organizationId: actor.organizationId,
              data: sampleEvent,
            };
        const run = await flowExecMod.executeFlowGraph(db, ruleRow, eventPayload, {
          app: ctx?.app || db?.app,
          actor: {
            id: actor.userId,
            userId: actor.userId,
            employeeId: actor.employeeId,
            username: actor.username,
            organizationId: actor.organizationId,
          },
          ignoreCooldown: true,
        });
        publishFlowStudioUpdate(actor, {
          operation: 'runAutomation',
          ruleKey: run?.ruleKey || ruleKey || val(ruleRow, 'ruleKey') || null,
          applied: true,
          run,
          message: 'Đã thực thi workflow.',
        });
        return { run };
      }
    }
  }

  throw failTool('AUTOMATION_ENGINE_UNAVAILABLE', 503, 'Dịch vụ Automation Engine (dxosAutomations) chưa sẵn sàng.');
}

function clonePlain(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(sanitizeAutomationValue(value)));
}

function toPlainAutomationRule(row, val) {
  if (!row) return null;
  const base = typeof row.toJSON === 'function' ? row.toJSON() : row;
  const actionsRaw = val(row, 'actionsJson') ?? base.actionsJson ?? base.actions;
  const graphRaw = val(row, 'graphJson') ?? base.graphJson ?? null;
  const draftGraphRaw = val(row, 'draftGraphJson') ?? base.draftGraphJson ?? null;
  const triggerIndexRaw = val(row, 'triggerIndexJson') ?? base.triggerIndexJson ?? null;
  const rawSchemaVersion = val(row, 'schemaVersion') ?? base.schemaVersion;
  const schemaVersion = rawSchemaVersion != null ? Number(rawSchemaVersion) : (isPlainObject(graphRaw) ? 2 : 1);
  return sanitizeAutomationValue({
    id: val(row, 'id') ?? base.id ?? null,
    organizationId: val(row, 'organizationId') ?? base.organizationId ?? null,
    ruleKey: val(row, 'ruleKey') ?? base.ruleKey ?? null,
    name: val(row, 'name') ?? base.name ?? null,
    description: val(row, 'description') ?? base.description ?? null,
    triggerEventType: val(row, 'triggerEventType') ?? base.triggerEventType ?? '*',
    filterJson: val(row, 'filterJson') ?? base.filterJson ?? null,
    dmnTableKey: val(row, 'dmnTableKey') ?? base.dmnTableKey ?? null,
    actionsJson: Array.isArray(actionsRaw) ? clonePlain(actionsRaw) : [],
    maxDepth: Number(val(row, 'maxDepth') ?? base.maxDepth ?? 8) || 8,
    cooldownSec: Number(val(row, 'cooldownSec') ?? base.cooldownSec ?? 0) || 0,
    active: val(row, 'active') !== undefined ? Boolean(val(row, 'active')) : (base.active !== false),
    ...(schemaVersion === 2 || isPlainObject(graphRaw) || isPlainObject(draftGraphRaw) ? { schemaVersion } : {}),
    ...(isPlainObject(graphRaw) ? { graphJson: clonePlain(graphRaw) } : {}),
    ...(isPlainObject(draftGraphRaw) ? { draftGraphJson: clonePlain(draftGraphRaw) } : {}),
    ...(Array.isArray(triggerIndexRaw) ? { triggerIndexJson: clonePlain(triggerIndexRaw) } : {}),
  });
}

function buildFallbackTriggerIndex(graph) {
  const triggers = (Array.isArray(graph?.nodes) ? graph.nodes : []).filter((n) => String(n?.type || '').startsWith('trigger.'));
  return triggers.map((n, idx) => {
    const cfg = isPlainObject(n.config) ? n.config : {};
    const triggerType = String(n.type || '').slice(8) || 'event';
    const collection = cfg.collection ? String(cfg.collection).trim() : null;
    const operation = triggerType === 'record' ? String(cfg.operation || 'create').trim() : null;
    const eventType = cfg.eventType || cfg.pattern
      ? String(cfg.eventType || cfg.pattern).trim()
      : (triggerType === 'record' && collection ? `record.${collection}.${operation}`
        : triggerType === 'schedule' ? 'schedule.cron'
          : triggerType === 'webhook' ? 'webhook.inbound'
            : triggerType === 'manual' ? 'manual.trigger' : '*');
    return {
      nodeId: String(n.id || `trigger_${idx + 1}`),
      triggerType,
      eventType,
      collection,
      operation,
      cron: cfg.cron ? String(cfg.cron).trim() : null,
      webhookPath: cfg.webhookPath || cfg.path ? String(cfg.webhookPath || cfg.path).trim() : null,
    };
  });
}

function validateAndNormalizeRule(rawRule, failTool, protectedCollections) {
  if (!isPlainObject(rawRule)) {
    throw failTool('AUTOMATION_RULE_INVALID', 400, 'Cấu hình rule phải là đối tượng JSON hợp lệ.');
  }
  const clean = sanitizeAutomationValue(rawRule);
  const ruleKey = String(clean.ruleKey || clean.automationCode || '').trim();
  if (!SAFE_SAVE_RULE_KEY_RE.test(ruleKey) || FORBIDDEN_AUTOMATION_KEYS.has(ruleKey)) {
    throw failTool('AUTOMATION_RULE_KEY_INVALID', 400, 'ruleKey phải khớp ^[a-z0-9][a-z0-9_-]{1,62}$.');
  }
  const name = String(clean.name || clean.title || '').trim();
  if (!name) {
    throw failTool('AUTOMATION_RULE_NAME_REQUIRED', 400, 'Rule automation cần có tên (name).');
  }
  const schemaMod = loadStudioFlowSchema();
  const hasGraphJson = isPlainObject(clean.graphJson) && Array.isArray(clean.graphJson.nodes);
  const hasDraftGraphJson = isPlainObject(clean.draftGraphJson) && Array.isArray(clean.draftGraphJson.nodes);
  const isV2 = Number(clean.schemaVersion) === 2 || hasGraphJson || hasDraftGraphJson;

  let normalizedGraph = null;
  let normalizedDraftGraph = null;
  if (hasGraphJson) {
    normalizedGraph = validateFlowGraphInput(clean.graphJson, failTool, protectedCollections, { requireTrigger: true });
  }
  if (hasDraftGraphJson) {
    normalizedDraftGraph = validateFlowGraphInput(clean.draftGraphJson, failTool, protectedCollections, { requireTrigger: false });
  }

  const activeGraph = normalizedGraph || normalizedDraftGraph;
  const compat = activeGraph && typeof schemaMod?.graphV2SummaryToV1Compat === 'function'
    ? schemaMod.graphV2SummaryToV1Compat({ ...clean, graphJson: activeGraph })
    : null;

  const actionsJson = Array.isArray(clean.actionsJson) ? clean.actionsJson : [];
  for (let i = 0; i < actionsJson.length; i += 1) {
    const act = actionsJson[i];
    if (!isPlainObject(act) || !VALID_AUTOMATION_ACTION_TYPES.has(String(act.type || '').trim())) {
      throw failTool('AUTOMATION_ACTION_INVALID', 400, `actionsJson[${i}].type không hợp lệ.`);
    }
    if (hasUnsafeAutomationTemplate(act)) {
      throw failTool('AUTOMATION_AI_REFUSED', 400, `actionsJson[${i}] chứa template hoặc khóa bị cấm.`);
    }
    if (act.type === 'create_record' || act.type === 'update_record') {
      const targetCol = String(act.collection || act.targetCollection || '').trim();
      if (!targetCol || protectedCollections?.has(targetCol) || !isAllowlistedAutomationCollection(targetCol)) {
        throw failTool('AUTOMATION_AI_REFUSED', 400, `Bảng đích "${targetCol || '(empty)'}" không được phép thao tác.`);
      }
      for (const payloadKey of ['values', 'data', 'patch', 'payload']) {
        if (!isPlainObject(act[payloadKey])) continue;
        delete act[payloadKey].id;
        delete act[payloadKey].organizationId;
        if (AUTOMATION_CORE_VOUCHERS.has(targetCol)) {
          for (const f of AUTOMATION_PROTECTED_VOUCHER_FIELDS) {
            delete act[payloadKey][f];
          }
        }
      }
    }
  }
  const effectiveFilter = clean.filterJson !== undefined ? clean.filterJson : (compat?.filterJson ?? null);
  if (effectiveFilter !== undefined && effectiveFilter !== null && hasUnsafeAutomationTemplate(effectiveFilter)) {
    throw failTool('AUTOMATION_AI_REFUSED', 400, 'filterJson chứa template hoặc khóa bị cấm.');
  }
  const rawMaxDepth = clean.maxDepth === undefined || clean.maxDepth === null ? (compat?.maxDepth ?? 8) : Number(clean.maxDepth);
  if (!Number.isInteger(rawMaxDepth) || rawMaxDepth < 1 || rawMaxDepth > 8) {
    throw failTool('AUTOMATION_RULE_INVALID', 400, 'maxDepth phải là số nguyên từ 1 đến 8.');
  }
  const rawCooldown = clean.cooldownSec === undefined || clean.cooldownSec === null ? (compat?.cooldownSec ?? 0) : Number(clean.cooldownSec);
  if (!Number.isInteger(rawCooldown) || rawCooldown < 0) {
    throw failTool('AUTOMATION_RULE_INVALID', 400, 'cooldownSec phải là số nguyên >= 0.');
  }

  const finalActions = actionsJson.length > 0 ? clonePlain(actionsJson) : (Array.isArray(compat?.actionsJson) ? clonePlain(compat.actionsJson) : []);
  const triggerIndexJson = activeGraph
    ? (typeof schemaMod?.buildTriggerIndex === 'function' ? schemaMod.buildTriggerIndex(activeGraph, clean) : buildFallbackTriggerIndex(activeGraph))
    : undefined;
  const triggerEventType = clean.triggerEventType !== undefined
    ? (String(clean.triggerEventType || '*').trim() || '*')
    : (compat?.triggerEventType || triggerIndexJson?.[0]?.eventType || '*');

  return {
    ruleKey,
    name,
    description: clean.description ? String(clean.description) : null,
    triggerEventType,
    filterJson: effectiveFilter ? clonePlain(effectiveFilter) : null,
    dmnTableKey: clean.dmnTableKey !== undefined
      ? (clean.dmnTableKey ? String(clean.dmnTableKey).trim() : null)
      : (compat?.dmnTableKey || null),
    actionsJson: finalActions,
    maxDepth: rawMaxDepth,
    cooldownSec: rawCooldown,
    active: clean.active === undefined ? true : Boolean(clean.active),
    ...(isV2 ? { schemaVersion: 2 } : {}),
    ...(normalizedGraph ? { graphJson: clonePlain(normalizedGraph) } : {}),
    ...(normalizedDraftGraph ? { draftGraphJson: clonePlain(normalizedDraftGraph) } : {}),
    ...(triggerIndexJson ? { triggerIndexJson } : {}),
  };
}

async function loadTenantAutomationRule(db, organizationId, ruleKey, val, failTool) {
  const rk = String(ruleKey || '').trim();
  if (!rk) throw failTool('AUTOMATION_RULE_KEY_REQUIRED', 400, 'Cần ruleKey để thao tác với automation rule.');
  if (FORBIDDEN_AUTOMATION_KEYS.has(rk) || !AUTOMATION_RULE_KEY_RE.test(rk)) {
    throw failTool('AUTOMATION_RULE_KEY_INVALID', 400, 'ruleKey không hợp lệ.');
  }
  const rulesRepo = db?.getRepository?.('latticeAutomationRules');
  if (!rulesRepo || typeof rulesRepo.findOne !== 'function') {
    throw failTool('AUTOMATION_ENGINE_UNAVAILABLE', 503, 'Dịch vụ Automation (latticeAutomationRules) chưa sẵn sàng.');
  }
  const row = await rulesRepo.findOne({ filter: { organizationId, ruleKey: rk } });
  if (!row || val(row, 'organizationId') !== organizationId) {
    throw failTool('AUTOMATION_RULE_NOT_FOUND', 404, `Không tìm thấy automation rule "${rk}" trong phạm vi tổ chức.`);
  }
  return toPlainAutomationRule(row, val);
}

async function saveTenantAutomationRule(ctx, db, actor, ruleCandidate, deps) {
  const { val, failTool, hasRes, SYSTEM_PROTECTED_COLLECTIONS } = deps;
  const validated = validateAndNormalizeRule(ruleCandidate, failTool, SYSTEM_PROTECTED_COLLECTIONS);
  if (hasResourceAction(hasRes, ctx, 'dxosAutomations', 'saveRule')) {
    const delegated = await invokeDxosAutomationsAction(ctx, db, actor, 'saveRule', {
      organizationId: actor.organizationId,
      rule: validated,
      values: { organizationId: actor.organizationId, rule: validated },
      method: 'POST',
    }, deps);
    if (delegated.ok) return delegated.result?.rule || validated;
  }
  const rulesRepo = db?.getRepository?.('latticeAutomationRules');
  if (!rulesRepo || typeof rulesRepo.findOne !== 'function') {
    throw failTool('AUTOMATION_ENGINE_UNAVAILABLE', 503, 'Dịch vụ Automation (dxosAutomations / latticeAutomationRules) chưa sẵn sàng.');
  }
  const existing = await rulesRepo.findOne({ filter: { organizationId: actor.organizationId, ruleKey: validated.ruleKey } });
  if (existing && val(existing, 'organizationId') === actor.organizationId) {
    if (typeof rulesRepo.update === 'function') {
      await rulesRepo.update({
        filter: { organizationId: actor.organizationId, ruleKey: validated.ruleKey },
        values: validated,
      });
      const updated = await rulesRepo.findOne({ filter: { organizationId: actor.organizationId, ruleKey: validated.ruleKey } });
      return toPlainAutomationRule(updated, val) || { ...validated, organizationId: actor.organizationId };
    }
    if (typeof existing.update === 'function') {
      await existing.update(validated);
      return toPlainAutomationRule(existing, val);
    }
  }
  if (typeof rulesRepo.create === 'function') {
    const created = await rulesRepo.create({
      values: {
        ...validated,
        organizationId: actor.organizationId,
        createdBy: actor.username || null,
      },
    });
    return toPlainAutomationRule(created, val) || { ...validated, organizationId: actor.organizationId };
  }
  throw failTool('AUTOMATION_ENGINE_UNAVAILABLE', 503, 'Repository latticeAutomationRules không hỗ trợ ghi rule.');
}

function buildEventEnvelopeForSimulation(ruleObj, rawSampleEvent, organizationId) {
  const src = isPlainObject(rawSampleEvent) ? sanitizeAutomationValue(rawSampleEvent) : {};
  const isEnvelope = Boolean(src.type || src.eventType || isPlainObject(src.data));
  if (isEnvelope) {
    return {
      id: src.id ? String(src.id) : 'evt_sim_1',
      type: String(src.type || src.eventType || ruleObj?.triggerEventType || 'manual.trigger').split(',')[0].trim(),
      source: src.source ? String(src.source) : 'dxos-ai:simulation',
      subject: src.subject ? String(src.subject) : '',
      depth: Number(src.depth || 0),
      organizationId,
      data: isPlainObject(src.data) ? src.data : {},
    };
  }
  return {
    id: 'evt_sim_1',
    type: String(ruleObj?.triggerEventType || 'manual.trigger').split(',')[0].trim() || 'manual.trigger',
    source: 'dxos-ai:simulation',
    subject: '',
    depth: 0,
    organizationId,
    data: src,
  };
}

function simulateRuleLocally(ruleObj, eventEnvelope, organizationId) {
  const eventContext = {
    ...eventEnvelope,
    dmn: isPlainObject(eventEnvelope?.dmn) ? eventEnvelope.dmn : (isPlainObject(eventEnvelope?.data?.dmn) ? eventEnvelope.data.dmn : {}),
    steps: [],
  };
  const matched = matchesFilterLocal(ruleObj?.filterJson, eventContext);
  if (!matched) {
    return {
      organizationId,
      ruleKey: ruleObj?.ruleKey || null,
      triggerEventType: eventEnvelope.type,
      status: 'skipped',
      matched: false,
      dmnResultJson: null,
      stepTracesJson: [],
      errorMessage: 'FILTER_NOT_MATCHED',
    };
  }
  const actions = Array.isArray(ruleObj?.actionsJson) ? ruleObj.actionsJson : [];
  const stepTracesJson = [];
  for (let i = 0; i < actions.length; i += 1) {
    const act = actions[i];
    if (act.when && !matchesFilterLocal(act.when, eventContext)) {
      const skippedTrace = {
        stepIndex: i,
        type: String(act.type || ''),
        label: act.label || null,
        status: 'skipped',
        skipReason: 'BRANCH_CONDITION_NOT_MATCHED',
        output: null,
        error: null,
        durationMs: 0,
      };
      stepTracesJson.push(skippedTrace);
      eventContext.steps[i] = { status: 'skipped' };
      continue;
    }
    const output = interpolateLocal(act, eventContext);
    if (act.type === 'create_record' && isPlainObject(output) && output.id == null) {
      output.id = `sim_${i + 1}`;
    }
    eventContext.steps[i] = isPlainObject(output) ? output : { value: output };
    stepTracesJson.push({
      stepIndex: i,
      type: String(act.type || ''),
      label: act.label || null,
      status: 'simulated',
      output,
      error: null,
      durationMs: 0,
    });
  }
  return {
    organizationId,
    ruleKey: ruleObj?.ruleKey || null,
    triggerEventType: eventEnvelope.type,
    status: 'completed',
    matched: true,
    dmnResultJson: null,
    stepTracesJson,
    errorMessage: null,
  };
}

function summarizeSimulationSteps(simulation) {
  const stepTraces = Array.isArray(simulation?.stepTracesJson) ? simulation.stepTracesJson : [];
  const executedSteps = stepTraces.filter((s) => s && s.status !== 'skipped');
  const skippedSteps = stepTraces.filter((s) => s && s.status === 'skipped');
  return { stepTraces, executedSteps, skippedSteps };
}

async function simulateRuleDryRun(ctx, db, actor, ruleObj, sampleEvent, deps) {
  const { hasRes } = deps;
  const eventEnvelope = buildEventEnvelopeForSimulation(ruleObj, sampleEvent, actor.organizationId);
  let simulation = null;
  if (hasResourceAction(hasRes, ctx, 'dxosAutomations', 'testRule')) {
    const delegated = await invokeDxosAutomationsAction(ctx, db, actor, 'testRule', {
      organizationId: actor.organizationId,
      ...(ruleObj?.ruleKey ? { ruleKey: ruleObj.ruleKey } : {}),
      ...(isPlainObject(ruleObj) ? { rule: ruleObj } : {}),
      sampleEvent,
      event: eventEnvelope,
      data: eventEnvelope.data,
      values: {
        organizationId: actor.organizationId,
        ...(ruleObj?.ruleKey ? { ruleKey: ruleObj.ruleKey } : {}),
        ...(isPlainObject(ruleObj) ? { rule: ruleObj } : {}),
        sampleEvent,
        event: eventEnvelope,
        data: eventEnvelope.data,
      },
      method: 'POST',
    }, deps);
    if (delegated.ok) {
      simulation = delegated.result?.simulation || delegated.result;
    }
  }
  if (!simulation) {
    const isV2Rule = Number(ruleObj?.schemaVersion) === 2 || (isPlainObject(ruleObj?.graphJson) && Array.isArray(ruleObj.graphJson.nodes));
    const flowExecMod = isV2Rule ? loadStudioFlowExecutor() : null;
    if (flowExecMod && typeof flowExecMod.dryRunFlowGraph === 'function') {
      simulation = await flowExecMod.dryRunFlowGraph(
        db,
        { ...ruleObj, organizationId: actor.organizationId },
        eventEnvelope,
        {
          app: ctx?.app || db?.app,
          actor: {
            id: actor.userId,
            userId: actor.userId,
            employeeId: actor.employeeId,
            username: actor.username,
            organizationId: actor.organizationId,
          },
          ignoreCooldown: true,
        },
      );
    }
  }
  if (!simulation) {
    const engineMod = loadStudioAutomationEngine();
    if (engineMod && typeof engineMod.executeRuleAgainstEvent === 'function') {
      simulation = await engineMod.executeRuleAgainstEvent(
        db,
        { ...ruleObj, organizationId: actor.organizationId },
        eventEnvelope,
        {
          app: ctx?.app || db?.app,
          actor: {
            id: actor.userId,
            userId: actor.userId,
            employeeId: actor.employeeId,
            username: actor.username,
            organizationId: actor.organizationId,
          },
          dryRun: true,
          ignoreCooldown: true,
        },
      );
    } else {
      simulation = simulateRuleLocally(ruleObj, eventEnvelope, actor.organizationId);
    }
  }
  const { stepTraces, executedSteps, skippedSteps } = summarizeSimulationSteps(simulation);
  return { simulation, stepTraces, executedSteps, skippedSteps };
}

function extractNegativeNumericLiteral(goalText) {
  const rawLow = String(goalText || '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
  const explicitNeg = rawLow.match(/(?:(?<![\p{L}\p{N}_])(?:âm|trừ)\s+|(?<![a-z0-9])-\s*)(\d+(?:\.\d+)?)\s*(?:độ|°\s*c|°|c)?(?=\s|$|[,.;%)°]|độ)/iu);
  if (explicitNeg) return -Number(explicitNeg[1]);
  const masked = rawLow.replace(/(?<![\p{L}\p{N}_])độ\s+ẩm(?![\p{L}\p{N}_])/giu, 'do_am');
  const nForNeg = stripDiacriticsSimple(masked).toLowerCase().replace(/\s+/g, ' ').trim();
  const asciiNeg = nForNeg.match(/(?:(?<!(?<!\bnhiet\s)\bdo\s)\bam\s+|\btru\s+|(?<![a-z0-9])-\s*)(\d+(?:\.\d+)?)\s*(?:do|°c|°|c)?\b/);
  if (asciiNeg) return -Number(asciiNeg[1]);
  return null;
}

function isHumidityGoal(rawText, normText) {
  const rawLow = String(rawText || '').normalize('NFC').toLowerCase();
  if (/(?<![\p{L}\p{N}_])độ\s+ẩm(?![\p{L}\p{N}_])/iu.test(rawLow)) return true;
  if (/(?<![\p{L}\p{N}_])độ\s+âm(?![\p{L}\p{N}_])/iu.test(rawLow)) return false;
  return /(?<!\bnhiet\s)\bdo\s+am\b/.test(String(normText || ''));
}

function extractNumericThreshold(goalText) {
  const n = stripDiacriticsSimple(goalText).toLowerCase().replace(/\s+/g, ' ').trim();
  const negVal = extractNegativeNumericLiteral(goalText);
  if (negVal !== null) {
    const op = /(?:<|<=|thap hon|nho hon|duoi)\b/.test(n) ? 'lt' : 'gt';
    return { value: negVal, op };
  }
  const pos = n.match(/(?:>|>=|vuot|cao hon|lon hon|tren|duoi|thap hon|nho hon|nguong|thanh|len|xuong)\s*(\d+(?:\.\d+)?)\s*(?:do|°c|°|c|%|phut|h|gio)?\b/);
  if (pos) {
    const op = /(?:<|<=|thap hon|nho hon|duoi)\b/.test(n) ? 'lt' : 'gt';
    return { value: Number(pos[1]), op };
  }
  return null;
}

function extractCooldownSeconds(goalText) {
  const n = stripDiacriticsSimple(goalText).toLowerCase().replace(/\s+/g, ' ').trim();
  const m = n.match(/(?:cooldown|chong lap|gian cach|cho|moi)\s*(\d+)\s*(giay|s|sec|phut|min|m|gio|h)?\b/);
  if (!m) return null;
  const num = Number(m[1]);
  if (!Number.isFinite(num) || num < 0) return null;
  const unit = m[2] || 's';
  if (unit === 'phut' || unit === 'min' || unit === 'm') return Math.round(num * 60);
  if (unit === 'gio' || unit === 'h') return Math.round(num * 3600);
  return Math.round(num);
}

function inferRoleFromGoal(goalText) {
  const n = stripDiacriticsSimple(goalText).toLowerCase();
  const explicit = String(goalText || '').match(/\b(ldx_[a-z][a-z0-9_]{1,30})\b/);
  if (explicit && explicit[1]) return explicit[1];
  if (n.includes('giam doc') || n.includes('director')) return 'ldx_director';
  if (n.includes('dieu phoi') || n.includes('dispatcher')) return 'ldx_dispatcher';
  if (n.includes('kho') || n.includes('warehouse')) return 'ldx_warehouse';
  if (n.includes('ky thuat') || n.includes('van hanh') || n.includes('operator')) return 'ldx_operator';
  return 'ldx_manager';
}

function buildSlugRuleKey(goalText, fallbackPrefix = 'auto_custom') {
  const words = stripDiacriticsSimple(goalText)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length >= 2)
    .slice(0, 4);
  const suffix = words.length ? words.join('_') : 'rule';
  return `${fallbackPrefix}_${suffix}`.replace(/[^a-z0-9_-]/g, '_').slice(0, 60);
}

async function resolveAvailableDmnKey(db, organizationId, preferredKey, val) {
  if (!preferredKey) return null;
  const dmnRepo = db?.getRepository?.('latticeDecisionTables');
  if (!dmnRepo || typeof dmnRepo.findOne !== 'function') return null;
  const hit = await dmnRepo.findOne({ filter: { organizationId, tableKey: preferredKey } });
  if (hit && val(hit, 'organizationId') === organizationId && val(hit, 'active') !== false) {
    return preferredKey;
  }
  return null;
}

function buildDefaultSampleEventForRule(ruleObj) {
  const trigger = String(ruleObj?.triggerEventType || 'alarm.triggered').split(',')[0].trim() || 'alarm.triggered';
  const data = {
    assetCode: 'COLD-ROOM-A1',
    deviceKey: 'COLD-ROOM-A1',
    severity: 'critical',
    tempC: -8.5,
    message: 'Vượt ngưỡng nhiệt độ buồng lạnh A1',
  };
  const filter = ruleObj?.filterJson;
  if (isPlainObject(filter) && typeof filter.field === 'string' && typeof filter.value === 'number') {
    const key = filter.field.replace(/^data\./, '');
    data[key] = filter.op === 'lt' || filter.op === '$lt' ? filter.value - 2 : filter.value + 3;
  }
  return { type: trigger, data };
}

async function draftRuleFromGoal(db, actor, args, val) {
  const goalText = String(args.goal || args.prompt || '').trim();
  const n = stripDiacriticsSimple(goalText).toLowerCase().replace(/\s+/g, ' ').trim();
  let triggerEventType = typeof args.triggerEventType === 'string' && args.triggerEventType.trim()
    ? args.triggerEventType.trim()
    : 'alarm.triggered';
  if (!args.triggerEventType) {
    if (n.includes('mkt') || n.includes('cach ly') || n.includes('tam giu lo')) triggerEventType = 'lot.held_mkt';
    else if (n.includes('sla') || n.includes('tre han') || n.includes('qua han')) triggerEventType = 'sla.breached';
    else if (n.includes('epod') || n.includes('giao nhan')) triggerEventType = 'epod.captured';
    else if (n.includes('offline') || n.includes('mat ket noi')) triggerEventType = 'alarm.triggered,device.offline';
    else if (n.includes('don hang') || n.includes('order')) triggerEventType = 'order.status_changed';
    else if (n.includes('telemetry') && !n.includes('canh bao')) triggerEventType = 'telemetry.threshold_breached';
  }

  const threshold = extractNumericThreshold(goalText);
  let filterJson = null;
  if (threshold !== null) {
    const field = isHumidityGoal(goalText, n) ? 'humidity' : (n.includes('ap suat') ? 'pressure' : (n.includes('mkt') ? 'mktC' : (n.includes('sla') ? 'overdueMinutes' : 'tempC')));
    filterJson = { field, op: threshold.op, value: threshold.value };
  } else if (n.includes('nghiem trong') || n.includes('critical') || n.includes('khan cap')) {
    filterJson = { field: 'severity', op: 'in', value: ['critical', 'high'] };
  }

  const cooldownSec = extractCooldownSeconds(goalText) ?? 60;
  const preferredDmn = triggerEventType.includes('lot.held_mkt')
    ? 'cold_chain_approval_v1'
    : (n.includes('bao tri') || n.includes('cmms') || n.includes('kho lanh') || n.includes('nhiet do') ? 'cmms_priority_routing_v1' : null);
  const dmnTableKey = await resolveAvailableDmnKey(db, actor.organizationId, preferredDmn, val);
  const role = inferRoleFromGoal(goalText);

  const actionsJson = [];
  if (n.includes('phieu bao tri') || n.includes('cmms') || n.includes('sua chua') || n.includes('work order')) {
    actionsJson.push({
      type: 'create_record',
      label: 'Tạo phiếu bảo trì CMMS',
      collection: 'latticeCustomWorkOrders',
      values: {
        workOrderCode: 'WO-{{data.deviceKey}}',
        title: 'Ứng cứu tự động: {{data.deviceKey}}',
        deviceKey: '{{data.deviceKey}}',
        priority: dmnTableKey ? '{{dmn.workOrderPriority}}' : 'high',
        status: 'open',
        faultSummary: '{{data.message}}',
        assignedRole: role,
      },
    });
  } else if (n.includes('su co') || n.includes('incident')) {
    actionsJson.push({
      type: 'create_record',
      label: 'Mở hồ sơ sự cố',
      collection: 'latticeIncidentCases',
      values: {
        code: 'INC-{{data.deviceKey}}',
        name: 'Sự cố tự động: {{data.deviceKey}}',
        severity: 'high',
        description: '{{data.message}}',
      },
    });
  } else if (n.includes('phieu ho tro') || n.includes('dich vu') || n.includes('sla') || n.includes('ticket')) {
    actionsJson.push({
      type: 'create_record',
      label: 'Tạo phiếu hỗ trợ SLA',
      collection: 'latticeServiceTickets',
      values: {
        code: 'SRV-{{data.deviceKey}}',
        name: 'Xử lý SLA tự động: {{data.deviceKey}}',
        priority: 'high',
        description: '{{data.message}}',
      },
    });
  }

  if (n.includes('triage') || n.includes('ai phan tich') || n.includes('de xuat')) {
    actionsJson.push({
      type: 'trigger_ai_triage',
      label: 'AI Triage & Đề xuất xử lý',
      targetCollection: 'latticeAssets',
      recommendation: actionsJson.length ? 'Phân tích sự cố gắn với phiếu #{{steps.0.id}}' : 'Phân tích sự cố cho {{data.deviceKey}}',
    });
  }

  if (n.includes('ha nhiet') || n.includes('setpoint') || n.includes('twin') || n.includes('dieu chinh nhiet')) {
    actionsJson.push({
      type: 'twin_set_desired',
      label: 'Điều chỉnh setpoint Digital Twin',
      branchLabel: 'Khi nghiêm trọng',
      when: { field: 'data.severity', op: 'eq', value: 'critical' },
      assetEntityId: '{{data.assetEntityId}}',
      desiredPatch: { targetTempC: threshold && threshold.value < 0 ? threshold.value - 2 : -20 },
    });
  }

  if (n.includes('webhook') || n.includes('n8n') || n.includes('connector') || n.includes('doi tac')) {
    actionsJson.push({
      type: 'call_connector',
      label: 'Đồng bộ n8n Orchestrator',
      branchLabel: 'Khi khẩn cấp',
      when: { field: 'data.severity', op: 'in', value: ['critical', 'high'] },
      connectorKey: 'n8n-coldchain-orchestrator',
      method: 'POST',
    });
  }

  if (n.includes('thong bao') || n.includes('canh bao') || n.includes('bao cho') || n.includes('nhac') || !actionsJson.length) {
    actionsJson.push({
      type: 'notify_role',
      label: `Thông báo vai trò ${role}`,
      role,
      category: 'automation',
      severity: n.includes('khan cap') || n.includes('nghiem trong') || n.includes('do') ? 'critical' : 'warning',
      title: 'Cảnh báo tự động từ {{data.deviceKey}}',
      body: goalText.slice(0, 200) || 'Hệ thống kích hoạt automation cho {{data.deviceKey}}',
    });
  }

  const ruleKey = typeof args.ruleKey === 'string' && SAFE_SAVE_RULE_KEY_RE.test(args.ruleKey.trim())
    ? args.ruleKey.trim()
    : buildSlugRuleKey(goalText, 'auto');

  return {
    ruleKey,
    name: args.title || `Automation: ${goalText.slice(0, 72)}`,
    description: goalText,
    triggerEventType,
    filterJson,
    dmnTableKey,
    actionsJson,
    maxDepth: 8,
    cooldownSec,
    active: true,
  };
}

function inferPatchTargetFromConfig(explicitTrigger, cfgPatch) {
  if (explicitTrigger || cfgPatch?.triggerEventType !== undefined) return 'trigger';
  if (cfgPatch?.cooldownSec !== undefined || cfgPatch?.maxDepth !== undefined) return 'cooldown';
  if (cfgPatch && Object.prototype.hasOwnProperty.call(cfgPatch, 'dmnTableKey')) return 'dmn';
  if (cfgPatch && (cfgPatch.type || isPlainObject(cfgPatch.action))) return 'actions';
  return 'filter';
}

function inferPatchTargetNode(goalText, explicitTarget, { cfgPatch = null, explicitTrigger = null } = {}) {
  if (typeof explicitTarget === 'string' && explicitTarget.trim()) {
    return explicitTarget.trim();
  }
  const n = stripDiacriticsSimple(goalText).toLowerCase().replace(/\s+/g, ' ').trim();
  if (n) {
    const stepColon = n.match(/\bstep\s*:\s*(\d+)\b/);
    if (stepColon) return `step:${stepColon[1]}`;
    const buoc = n.match(/\b(?:buoc|hanh dong)(?:\s+thu)?\s*(\d+)\b/);
    if (buoc) {
      const idx = Number(buoc[1]);
      return `step:${idx >= 1 ? idx - 1 : 0}`;
    }
    if (n.includes('cooldown') || n.includes('chong lap') || n.includes('gian cach')) return 'cooldown';
    if (n.includes('dmn') || n.includes('bang quyet dinh')) return 'dmn';
    if (n.includes('trigger') || n.includes('su kien kich hoat')) return 'trigger';
    if (/(?:them|bo sung)\s+(?:[^\n]{0,16}\s)?buoc\b/.test(n)) return 'actions';
    if (n.includes('filter') || n.includes('bo loc') || n.includes('dieu kien') || n.includes('nguong') || n.includes('nhanh')) return 'filter';
  }
  if (explicitTrigger || cfgPatch) {
    return inferPatchTargetFromConfig(explicitTrigger, cfgPatch);
  }
  return 'filter';
}

function buildSuggestionsForRule(ruleObj, runStats) {
  const suggestions = [];
  const effectiveCooldown = Number(ruleObj.cooldownSec ?? ruleObj.graphJson?.settings?.cooldownSec ?? 0);
  if (!effectiveCooldown || effectiveCooldown === 0) {
    suggestions.push({
      id: 'add_cooldown',
      priority: 'high',
      targetNode: 'cooldown',
      title: 'Thêm thời gian chống lặp (cooldownSec = 120s)',
      description: 'Tránh tạo hàng loạt phiếu lặp lại khi cảm biến dao động quanh ngưỡng.',
      patch: { cooldownSec: 120 },
    });
  }
  const hasGraphGuard = Array.isArray(ruleObj.graphJson?.nodes)
    && ruleObj.graphJson.nodes.some((n) => n?.type === 'control.if' && (n.id === 'filter_1' || n.config?.isRuleFilter));
  if (!ruleObj.filterJson && !hasGraphGuard) {
    suggestions.push({
      id: 'add_guard_filter',
      priority: 'medium',
      targetNode: 'filter',
      title: 'Bổ sung bộ lọc đầu vào (filterJson)',
      description: 'Lọc trước các sự kiện nhiễu hoặc mức thấp trước khi chạy DMN và tạo phiếu.',
      patch: { filterJson: { field: 'severity', op: 'in', value: ['critical', 'high', 'warning'] } },
    });
  }
  const actions = Array.isArray(ruleObj.actionsJson) ? ruleObj.actionsJson : [];
  if (actions.length >= 2 && !actions.some((a) => Boolean(a?.when))) {
    suggestions.push({
      id: 'add_branch_when',
      priority: 'medium',
      targetNode: `step:${actions.length - 1}`,
      title: 'Thêm điều kiện rẽ nhánh (when) cho bước leo thang',
      description: 'Chỉ kích hoạt bước xử lý nâng cao khi mức độ là critical hoặc vượt ngưỡng.',
      patch: { when: { field: 'data.severity', op: 'eq', value: 'critical' }, branchLabel: 'Nhánh khẩn cấp' },
    });
  }
  if (!actions.some((a) => a?.type === 'trigger_ai_triage')) {
    suggestions.push({
      id: 'add_ai_triage',
      priority: 'low',
      targetNode: 'actions',
      title: 'Thêm bước AI Triage ghi nhận đề xuất xử lý',
      description: 'Gắn thêm bước trigger_ai_triage để lưu bằng chứng và đề xuất cho ca trực.',
      patch: { action: { type: 'trigger_ai_triage', label: 'AI Triage tự động', targetCollection: 'latticeAssets' } },
    });
  }
  if (runStats && runStats.failedRuns > 0) {
    suggestions.push({
      id: 'guard_failed_runs',
      priority: 'high',
      targetNode: 'actions',
      title: `Kiểm tra lỗi từ ${runStats.failedRuns} lần chạy thất bại gần đây`,
      description: 'Cân nhắc đặt stopOnError=true hoặc kiểm tra cấu hình connector/DMN.',
      patch: { note: 'review_failed_runs' },
    });
  }
  return suggestions;
}

function applyTopSuggestionsDraft(ruleObj, suggestions) {
  const draft = clonePlain(ruleObj);
  const hadFilterBefore = Boolean(ruleObj?.filterJson);
  for (const sug of suggestions) {
    if (sug.id === 'add_cooldown' && (!draft.cooldownSec || draft.cooldownSec === 0)) {
      draft.cooldownSec = sug.patch.cooldownSec;
    } else if (sug.id === 'add_guard_filter' && !draft.filterJson) {
      draft.filterJson = clonePlain(sug.patch.filterJson);
    } else if (sug.id === 'add_branch_when' && Array.isArray(draft.actionsJson) && draft.actionsJson.length >= 2) {
      const last = draft.actionsJson[draft.actionsJson.length - 1];
      if (!last.when) {
        last.when = clonePlain(sug.patch.when);
        if (!last.branchLabel) last.branchLabel = sug.patch.branchLabel;
      }
    }
  }
  const isV2Draft = Number(draft.schemaVersion) === 2 || (isPlainObject(draft.graphJson) && Array.isArray(draft.graphJson.nodes));
  if (isV2Draft) {
    const schemaMod = loadStudioFlowSchema();
    if (isPlainObject(draft.graphJson) && Array.isArray(draft.graphJson.nodes)) {
      const nextGraph = clonePlain(draft.graphJson);
      nextGraph.settings = {
        ...(isPlainObject(nextGraph.settings) ? nextGraph.settings : {}),
        cooldownSec: Number(draft.cooldownSec ?? nextGraph.settings?.cooldownSec ?? 0),
        maxDepth: Number(draft.maxDepth ?? nextGraph.settings?.maxDepth ?? 8),
      };
      if (!hadFilterBefore && isPlainObject(draft.filterJson) && !nextGraph.nodes.some((n) => n?.type === 'control.if' && (n.id === 'filter_1' || n.config?.isRuleFilter))) {
        const trigNode = nextGraph.nodes.find((n) => String(n?.type || '').startsWith('trigger.'));
        nextGraph.nodes.push({
          id: 'filter_1',
          type: 'control.if',
          label: 'Rule Filter',
          position: { x: (trigNode?.position?.x ?? 80) + 220, y: trigNode?.position?.y ?? 160 },
          config: { condition: clonePlain(draft.filterJson), isRuleFilter: true },
        });
        if (!Array.isArray(nextGraph.edges)) nextGraph.edges = [];
        if (trigNode) {
          for (const edge of nextGraph.edges) {
            if (edge && edge.source === trigNode.id && (edge.sourceHandle || 'main') === 'main') {
              edge.source = 'filter_1';
              edge.sourceHandle = 'true';
            }
          }
          nextGraph.edges.unshift({
            id: `edge_filter_${nextGraph.edges.length + 1}`,
            source: trigNode.id,
            sourceHandle: 'main',
            target: 'filter_1',
            targetHandle: 'in',
          });
        }
      }
      draft.graphJson = typeof schemaMod?.normalizeGraph === 'function' ? schemaMod.normalizeGraph(nextGraph) : nextGraph;
    } else if (typeof schemaMod?.v1RuleToGraphV2 === 'function') {
      draft.graphJson = schemaMod.v1RuleToGraphV2(draft);
    }
  }
  return draft;
}

function isLlmTimeoutError(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.code === 'LLM_TIMEOUT' || err.code === 'ABORT_ERR' || err.name === 'AbortError' || err.name === 'TimeoutError') {
    return true;
  }
  return err.status === 504 || /\bLLM_TIMEOUT\b|timed?\s*out|aborted due to timeout/i.test(String(err.message || ''));
}

function extractArchitectResult(res, failTool) {
  if (res && res.refused !== true && (res.code === 'LLM_TIMEOUT' || res.error === 'LLM_TIMEOUT')) {
    throw failTool('LLM_TIMEOUT', 504, res.reason || res.error || 'Yêu cầu LLM quá thời gian chờ (45s).');
  }
  if (res && (res.refused === true || res.ok === false)) {
    throw failTool('AUTOMATION_AI_REFUSED', 400, res.error || res.reason || 'Yêu cầu DX-OS Flow Architect bị từ chối.');
  }
  return res || {};
}

function isLegacyV1NodePatch(mode, payload) {
  if (mode !== 'node') return false;
  const hasGraph = isPlainObject(payload.graph) && Array.isArray(payload.graph.nodes)
    || isPlainObject(payload.rule?.graphJson) && Array.isArray(payload.rule.graphJson.nodes)
    || Number(payload.rule?.schemaVersion) === 2;
  if (hasGraph) return false;
  const target = String(payload.targetNode || payload.nodeId || '').trim().toLowerCase();
  return V1_SEMANTIC_TARGETS.has(target) || /^(?:step|action):\d+$/.test(target);
}

async function callFlowArchitectIfAvailable(ctx, db, actor, mode, payload, deps) {
  const { failTool, hasRes } = deps;
  const timeoutMs = Number(payload.timeoutMs) || AI_ASSIST_TIMEOUT_MS;
  const rawTarget = payload.nodeId || payload.targetNodeId || payload.targetNode;
  const architectTargetNode = rawTarget === 'cooldown' || rawTarget === 'guard'
    ? 'trigger'
    : (rawTarget === 'actions' || rawTarget === 'step:new'
      ? 'step:append'
      : rawTarget);
  const architectPayload = {
    ...payload,
    timeoutMs,
    ...(architectTargetNode ? { targetNode: architectTargetNode, target: architectTargetNode, targetNodeId: architectTargetNode } : {}),
  };
  const requiresGraphV2 = Boolean(
    payload.graph
    || payload.graphJson
    || payload.nodeId
    || Number(payload.rule?.schemaVersion) === 2
    || mode === 'fix_error',
  );

  if (hasResourceAction(hasRes, ctx, 'dxosAutomations', 'aiAssist')) {
    try {
      const delegated = await invokeDxosAutomationsAction(ctx, db, actor, 'aiAssist', {
        ...architectPayload,
        mode,
        timeoutMs,
        organizationId: actor.organizationId,
        values: { ...architectPayload, mode, timeoutMs, organizationId: actor.organizationId },
        method: 'POST',
      }, deps);
      if (delegated.ok) {
        const data = extractArchitectResult(delegated.result, failTool);
        const hasGraphV2Shape = Boolean(
          (isPlainObject(data?.draftGraph) && Array.isArray(data.draftGraph.nodes))
          || (isPlainObject(data?.draftRule?.graphJson) && Array.isArray(data.draftRule.graphJson.nodes))
          || (isPlainObject(data?.graph) && Array.isArray(data.graph.nodes))
          || (isPlainObject(data?.rule?.graphJson) && Array.isArray(data.rule.graphJson.nodes)),
        );
        if (!(requiresGraphV2 && mode !== 'suggest' && !hasGraphV2Shape && loadStudioFlowArchitect())) {
          return { source: 'resource', data };
        }
      }
    } catch (err) {
      if (isLlmTimeoutError(err)) {
        throw failTool('LLM_TIMEOUT', 504, err?.message || 'Yêu cầu LLM quá thời gian chờ (45s).');
      }
      const errMsg = String(err?.message || '');
      const isSecurityRefusal = err?.code === 'AUTOMATION_AI_REFUSED'
        || err?.code === 'AI_ASSIST_REFUSED'
        || err?.code === 'TARGET_COLLECTION_FORBIDDEN'
        || err?.code === 'CONNECTOR_URL_UNSAFE'
        || err?.code === 'UNSAFE_TEMPLATE_EXPRESSION'
        || (err?.status === 400 && /refus|unsafe|inject|system|forbidden|proto|ssrf|template/i.test(errMsg));
      if (err?.code === 'AUTOMATION_AI_REFUSED' || err?.code === 'AI_ASSIST_REFUSED' || isSecurityRefusal) {
        throw failTool('AUTOMATION_AI_REFUSED', 400, err.message);
      }
      if (
        loadStudioFlowArchitect()
        && (
          (mode === 'fix_error' && /Unsupported aiAssist mode/i.test(errMsg))
          || (requiresGraphV2 && /Unknown target node|Unsupported aiAssist mode|not found/i.test(errMsg))
        )
      ) {
        // Fall through to local flow/architect for Graph v2 / fix_error support
      } else {
        throw err;
      }
    }
  }

  if (isLegacyV1NodePatch(mode, payload)) {
    return null;
  }

  const archMod = loadStudioFlowArchitect();
  if (!archMod || typeof archMod.runFlowArchitect !== 'function') return null;

  try {
    const res = await archMod.runFlowArchitect({
      db,
      env: process.env,
      mode,
      timeoutMs,
      prompt: architectPayload.prompt || architectPayload.goal || '',
      rule: architectPayload.rule,
      graph: architectPayload.graph || architectPayload.graphJson,
      targetNodeId: payload.nodeId || payload.targetNodeId || architectTargetNode,
      targetNode: architectTargetNode,
      runTrace: architectPayload.runTrace,
      organizationId: actor.organizationId,
      sampleEvent: architectPayload.sampleEvent,
      dryRunRunner: mode === 'suggest' ? false : undefined,
      allowFallbackOnNetworkError: true,
    });
    return { source: 'module', data: extractArchitectResult(res, failTool) };
  } catch (err) {
    if (isLlmTimeoutError(err)) {
      throw failTool('LLM_TIMEOUT', 504, err?.message || 'Yêu cầu LLM quá thời gian chờ (45s).');
    }
    if (err?.code === 'AUTOMATION_AI_REFUSED') throw err;
    if (err?.status === 400 && /refus|unsafe|inject|system|forbidden|proto/i.test(String(err.message || ''))) {
      throw failTool('AUTOMATION_AI_REFUSED', 400, err.message);
    }
    throw err;
  }
}

async function runSuggestAutomation(ctx, db, actor, args, deps) {
  const { val, failTool, SYSTEM_PROTECTED_COLLECTIONS } = deps;
  const goalText = String(args.goal || args.prompt || '').trim();
  const ruleKey = typeof args.ruleKey === 'string' && args.ruleKey.trim() ? args.ruleKey.trim() : null;
  const shouldApply = Boolean(args.apply && !args.dryRun);
  assertSafeAutomationInput(goalText, args.rule, args, failTool, SYSTEM_PROTECTED_COLLECTIONS);

  const inputGraph = isPlainObject(args.graphJson) ? args.graphJson : (isPlainObject(args.graph) ? args.graph : null);
  let targetRule = isPlainObject(args.rule)
    ? validateAndNormalizeRule(args.rule, failTool, SYSTEM_PROTECTED_COLLECTIONS)
    : null;
  if (ruleKey) {
    const loadedRule = await loadTenantAutomationRule(db, actor.organizationId, ruleKey, val, failTool);
    if (!targetRule) targetRule = loadedRule;
  }

  const architectHit = await callFlowArchitectIfAvailable(ctx, db, actor, 'suggest', {
    prompt: goalText,
    goal: goalText,
    ...(ruleKey ? { ruleKey } : {}),
    ...(targetRule ? { rule: targetRule, currentRule: targetRule } : {}),
    ...(inputGraph ? { graph: inputGraph, graphJson: inputGraph } : {}),
    apply: shouldApply,
  }, deps);

  if (architectHit) {
    const data = architectHit.data;
    let draftRule = data.draftRule || data.previewRule || data.rule || null;
    if (draftRule && targetRule?.ruleKey && (ruleKey || (isPlainObject(args.rule) && (args.rule.ruleKey || args.rule.automationCode))) && !args.newRuleKey && !args.targetRuleKey) {
      draftRule = { ...draftRule, ruleKey: targetRule.ruleKey };
    }
    if (draftRule) {
      draftRule = validateAndNormalizeRule(draftRule, failTool, SYSTEM_PROTECTED_COLLECTIONS);
    }
    const draftGraph = data.draftGraph || draftRule?.graphJson || null;
    let applied = Boolean(data.applied || data.saved || data.savedRule);
    if (shouldApply && !applied && draftRule) {
      draftRule = await saveTenantAutomationRule(ctx, db, actor, draftRule, deps);
      applied = true;
    }
    return {
      operation: 'suggestAutomation',
      organizationId: actor.organizationId,
      ruleKey: draftRule?.ruleKey || targetRule?.ruleKey || ruleKey,
      applied,
      ...(args.dryRun ? { dryRun: true } : {}),
      ...(data.modeUsed ? { modeUsed: data.modeUsed } : {}),
      ...(data.repairAttempts !== undefined ? { repairAttempts: data.repairAttempts } : {}),
      suggestions: Array.isArray(data.suggestions) ? data.suggestions : [],
      summary: data.summary || 'Đã phân tích rule và đề xuất tối ưu.',
      ...(draftGraph ? { draftGraph } : {}),
      ...(data.graphDiff ? { graphDiff: data.graphDiff } : {}),
      ...(draftRule ? { draftRule } : {}),
      ...(data.savedRule ? { rule: data.savedRule } : {}),
    };
  }

  if (!targetRule && !inputGraph) {
    const rulesRepo = db?.getRepository?.('latticeAutomationRules');
    const rows = rulesRepo?.find
      ? ((await rulesRepo.find({ filter: { organizationId: actor.organizationId }, sort: ['id'], limit: 20 })) || [])
      : [];
    const scoped = rows.filter((r) => val(r, 'organizationId') === actor.organizationId);
    if (scoped.length) {
      targetRule = toPlainAutomationRule(scoped[0], val);
    }
  }

  if (!targetRule && inputGraph) {
    const validatedG = validateFlowGraphInput(inputGraph, failTool, SYSTEM_PROTECTED_COLLECTIONS, { requireTrigger: false });
    targetRule = {
      ruleKey: ruleKey || 'flow_draft',
      name: args.title || 'Graph v2 Flow',
      schemaVersion: 2,
      graphJson: validatedG,
      cooldownSec: validatedG.settings?.cooldownSec ?? 0,
      maxDepth: validatedG.settings?.maxDepth ?? 8,
      actionsJson: [],
    };
  }

  if (!targetRule) {
    return {
      operation: 'suggestAutomation',
      organizationId: actor.organizationId,
      ruleKey: null,
      applied: false,
      ...(args.dryRun ? { dryRun: true } : {}),
      suggestions: [
        {
          id: 'create_starter_rule',
          priority: 'medium',
          targetNode: 'trigger',
          title: 'Khởi tạo automation rule đầu tiên cho tổ chức',
          description: 'Dùng draftAutomation để dựng Graph v2 DAG có điều kiện, phê duyệt HITL và cooldown.',
        },
      ],
      summary: 'Chưa có automation rule nào trong tổ chức để phân tích.',
    };
  }

  const runSummary = await summarizeAutomationRuns(db, actor.organizationId, val);
  const stats = targetRule.ruleKey && Object.hasOwn(runSummary.byRuleKey, targetRule.ruleKey)
    ? runSummary.byRuleKey[targetRule.ruleKey]
    : null;
  const suggestions = buildSuggestionsForRule(targetRule, stats);
  let draftRule = applyTopSuggestionsDraft(targetRule, suggestions);
  let applied = false;
  if (shouldApply) {
    draftRule = await saveTenantAutomationRule(ctx, db, actor, draftRule, deps);
    applied = true;
  }

  return {
    operation: 'suggestAutomation',
    organizationId: actor.organizationId,
    ruleKey: draftRule?.ruleKey || targetRule.ruleKey || ruleKey,
    applied,
    ...(args.dryRun ? { dryRun: true } : {}),
    suggestions,
    summary: suggestions.length
      ? `Phát hiện ${suggestions.length} điểm có thể tối ưu cho rule "${targetRule.ruleKey || targetRule.name}".`
      : `Rule "${targetRule.ruleKey || targetRule.name}" đã đạt chuẩn guard, cooldown và phân nhánh.`,
    ...(draftRule?.graphJson ? { draftGraph: draftRule.graphJson } : {}),
    draftRule,
  };
}

async function runDraftAutomation(ctx, db, actor, args, deps) {
  const { val, failTool, SYSTEM_PROTECTED_COLLECTIONS } = deps;
  const goalText = String(args.goal || args.prompt || '').trim();
  const shouldApply = Boolean(args.apply && !args.dryRun);
  const inputGraph = isPlainObject(args.graphJson) ? args.graphJson : (isPlainObject(args.graph) ? args.graph : null);
  if (!goalText && !isPlainObject(args.rule) && !inputGraph) {
    throw failTool('AUTOMATION_GOAL_REQUIRED', 400, 'Cần mô tả mục tiêu (goal/prompt), rule hoặc graphJson để phác thảo automation.');
  }
  assertSafeAutomationInput(goalText, args.rule, args, failTool, SYSTEM_PROTECTED_COLLECTIONS);

  const requestedMode = args.mode === 'fix_error' ? 'fix_error' : 'full';
  const architectHit = goalText || requestedMode === 'fix_error'
    ? await callFlowArchitectIfAvailable(ctx, db, actor, requestedMode, {
        prompt: goalText,
        goal: goalText,
        ...(args.ruleKey ? { ruleKey: args.ruleKey } : {}),
        ...(isPlainObject(args.rule) ? { rule: sanitizeAutomationValue(args.rule) } : {}),
        ...(inputGraph ? { graph: sanitizeAutomationValue(inputGraph), graphJson: sanitizeAutomationValue(inputGraph) } : {}),
        ...(isPlainObject(args.runTrace) ? { runTrace: sanitizeAutomationValue(args.runTrace) } : {}),
        ...(isPlainObject(args.sampleEvent) ? { sampleEvent: sanitizeAutomationValue(args.sampleEvent) } : {}),
        apply: shouldApply,
      }, deps)
    : null;

  let draftRule = null;
  let draftGraph = null;
  let graphDiff = null;
  let modeUsed;
  let repairAttempts;
  let suggestions;
  let dryRunPreview = null;
  let simulation = null;
  let applied = false;
  let summary = null;

  let savedRule = null;
  if (architectHit) {
    const data = architectHit.data;
    draftRule = data.draftRule || data.previewRule || data.rule || null;
    draftGraph = data.draftGraph || draftRule?.graphJson || null;
    graphDiff = data.graphDiff || null;
    modeUsed = data.modeUsed;
    repairAttempts = data.repairAttempts;
    suggestions = Array.isArray(data.suggestions) ? data.suggestions : undefined;
    dryRunPreview = data.dryRunPreview || null;
    simulation = data.simulation || data.dryRunPreview || null;
    applied = Boolean(data.applied || data.saved || data.savedRule);
    savedRule = data.savedRule || null;
    summary = data.summary || null;
    if (isPlainObject(data.sampleEvent) && !isPlainObject(args.sampleEvent)) {
      args = { ...args, sampleEvent: data.sampleEvent };
    }
  }

  if (!draftRule) {
    if (isPlainObject(args.rule)) {
      draftRule = validateAndNormalizeRule(args.rule, failTool, SYSTEM_PROTECTED_COLLECTIONS);
    } else if (inputGraph) {
      const normalizedG = validateFlowGraphInput(inputGraph, failTool, SYSTEM_PROTECTED_COLLECTIONS, { requireTrigger: true });
      draftRule = validateAndNormalizeRule({
        ruleKey: args.ruleKey || buildSlugRuleKey(goalText || 'flow_v2', 'auto'),
        name: args.title || 'LatticeFlow v2 Draft',
        schemaVersion: 2,
        graphJson: normalizedG,
      }, failTool, SYSTEM_PROTECTED_COLLECTIONS);
    } else {
      draftRule = await draftRuleFromGoal(db, actor, args, val);
    }
  } else {
    draftRule = validateAndNormalizeRule(draftRule, failTool, SYSTEM_PROTECTED_COLLECTIONS);
  }
  if (!draftGraph && isPlainObject(draftRule.graphJson)) {
    draftGraph = draftRule.graphJson;
  }

  const sampleEvent = isPlainObject(args.sampleEvent)
    ? sanitizeAutomationValue(args.sampleEvent)
    : buildDefaultSampleEventForRule(draftRule);

  if (!simulation) {
    let simRule = draftRule;
    if (draftRule.dmnTableKey) {
      const hasDmn = await resolveAvailableDmnKey(db, actor.organizationId, draftRule.dmnTableKey, val);
      if (!hasDmn) {
        simRule = { ...draftRule, dmnTableKey: null };
      }
    }
    const simResult = await simulateRuleDryRun(ctx, db, actor, simRule, sampleEvent, deps);
    simulation = simResult.simulation;
  }

  if (shouldApply && !applied) {
    savedRule = await saveTenantAutomationRule(ctx, db, actor, draftRule, deps);
    applied = true;
  }

  const result = {
    operation: 'draftAutomation',
    organizationId: actor.organizationId,
    applied,
    ...(args.dryRun ? { dryRun: true } : {}),
    ...(modeUsed !== undefined ? { modeUsed } : {}),
    ...(repairAttempts !== undefined ? { repairAttempts } : {}),
    draftRule,
    ...(draftGraph ? { draftGraph } : {}),
    ...(graphDiff ? { graphDiff } : {}),
    ...(suggestions ? { suggestions } : {}),
    ...(savedRule ? { rule: savedRule } : {}),
    sampleEvent,
    simulation,
    ...(dryRunPreview ? { dryRunPreview } : {}),
    summary: summary || `Đã phác thảo rule "${draftRule.ruleKey}" (${draftGraph?.nodes?.length || draftRule.actionsJson.length} thành phần) và mô phỏng dry-run.`,
  };
  publishFlowStudioUpdate(actor, {
    operation: 'draftAutomation',
    ruleKey: draftRule.ruleKey,
    applied,
    draftRule: savedRule || draftRule,
    draftGraph,
    simulation,
    message: result.summary,
  });
  return result;
}

function applyLocalGraphFixError(baseGraph, runTrace, failTool, protectedCollections) {
  const cleanGraph = validateFlowGraphInput(baseGraph, failTool, protectedCollections, { requireTrigger: true });
  const states = isPlainObject(runTrace?.nodeStatesJson) ? runTrace.nodeStatesJson : {};
  const badEntry = Object.entries(states).find(([, st]) => ['failed', 'error'].includes(String(st?.status || '').toLowerCase()));
  const failedId = String(runTrace?.failedNodeId || badEntry?.[0] || '').trim();
  const target = cleanGraph.nodes.find((n) => n.id === failedId) || cleanGraph.nodes.find((n) => !String(n.type || '').startsWith('trigger.'));
  if (!target) {
    throw failTool('AUTOMATION_TARGET_NODE_NOT_FOUND', 404, 'Không tìm thấy node lỗi có thể tự sửa trong flow.');
  }
  target.continueOnFail = true;
  if (target.type === 'data.update' && !target.config?.recordId && !Object.keys(target.config?.filter || {}).length) {
    target.config = { ...(target.config || {}), recordId: '{{data.id}}', filter: { id: '{{data.id}}' } };
  }
  if (['integration.http', 'ai.llm'].includes(target.type)) {
    target.timeoutMs = target.timeoutMs || 10000;
  }
  if (!cleanGraph.edges.some((e) => e.source === target.id && e.sourceHandle === 'error')) {
    const errId = `err_notify_${target.id}`;
    cleanGraph.nodes.push({
      id: errId,
      type: 'notify.send',
      label: 'Error Recovery Alert',
      position: { x: (target.position?.x || 300) + 240, y: (target.position?.y || 160) + 140 },
      config: { roleNames: ['ldx_operator'], severity: 'critical', title: `Recovered failure on ${target.id}` },
      continueOnFail: false,
    });
    cleanGraph.edges.push({
      id: `e_err_${target.id}`,
      source: target.id,
      sourceHandle: 'error',
      target: errId,
      targetHandle: 'in',
      label: 'error',
    });
  }
  return { graph: cleanGraph, targetNodeId: target.id };
}

async function runPatchAutomation(ctx, db, actor, args, deps) {
  const { val, failTool, SYSTEM_PROTECTED_COLLECTIONS } = deps;
  const goalText = String(args.goal || args.prompt || '').trim();
  const ruleKey = typeof args.ruleKey === 'string' && args.ruleKey.trim() ? args.ruleKey.trim() : null;
  const shouldApply = Boolean(args.apply && !args.dryRun);
  assertSafeAutomationInput(goalText, args.rule, args, failTool, SYSTEM_PROTECTED_COLLECTIONS);

  const cfgPatch = isPlainObject(args.configPatch)
    ? sanitizeAutomationValue(args.configPatch)
    : (isPlainObject(args.config) ? sanitizeAutomationValue(args.config) : null);
  if (cfgPatch && hasUnsafeAutomationTemplate(cfgPatch)) {
    throw failTool('AUTOMATION_AI_REFUSED', 400, 'configPatch chứa biểu thức template không an toàn.');
  }
  const explicitTrigger = typeof args.triggerEventType === 'string' && args.triggerEventType.trim()
    ? args.triggerEventType.trim()
    : null;
  const inputGraph = isPlainObject(args.graphJson) ? args.graphJson : (isPlainObject(args.graph) ? args.graph : null);
  const isFixError = String(args.mode || '').trim().toLowerCase() === 'fix_error' || isPlainObject(args.runTrace);

  let hydratedRunTrace = isPlainObject(args.runTrace) ? sanitizeAutomationValue(args.runTrace) : null;
  let hydratedRuleKey = ruleKey;
  if (isFixError && hydratedRunTrace?.runUid && (!hydratedRunTrace.nodeStatesJson || (!hydratedRuleKey && !isPlainObject(args.rule) && !inputGraph))) {
    const runsRepo = db?.getRepository?.('latticeAutomationRuns');
    if (runsRepo && typeof runsRepo.findOne === 'function') {
      const runRow = await runsRepo.findOne({ filter: { organizationId: actor.organizationId, runUid: String(hydratedRunTrace.runUid).trim() } });
      if (runRow && val(runRow, 'organizationId') === actor.organizationId) {
        if (!hydratedRuleKey && val(runRow, 'ruleKey')) hydratedRuleKey = String(val(runRow, 'ruleKey')).trim();
        hydratedRunTrace = {
          runUid: val(runRow, 'runUid') || hydratedRunTrace.runUid,
          status: val(runRow, 'status') || hydratedRunTrace.status || 'failed',
          errorMessage: val(runRow, 'errorMessage') || hydratedRunTrace.errorMessage || '',
          nodeStatesJson: val(runRow, 'nodeStatesJson') || hydratedRunTrace.nodeStatesJson || {},
          stepTracesJson: val(runRow, 'stepTracesJson') || hydratedRunTrace.stepTracesJson || [],
          ...hydratedRunTrace,
        };
      }
    }
  }

  if (!isPlainObject(args.rule) && !hydratedRuleKey && !inputGraph) {
    throw failTool('AUTOMATION_RULE_KEY_REQUIRED', 400, 'Cần ruleKey, rule hoặc graphJson để vá (patch) automation.');
  }
  let baseRule = null;
  if (isPlainObject(args.rule)) {
    baseRule = validateAndNormalizeRule(args.rule, failTool, SYSTEM_PROTECTED_COLLECTIONS);
  } else if (hydratedRuleKey) {
    baseRule = await loadTenantAutomationRule(db, actor.organizationId, hydratedRuleKey, val, failTool);
  } else if (inputGraph) {
    const validatedG = validateFlowGraphInput(inputGraph, failTool, SYSTEM_PROTECTED_COLLECTIONS, { requireTrigger: true });
    baseRule = validateAndNormalizeRule({
      ruleKey: hydratedRuleKey || inputGraph.ruleKey || 'flow_v2_patch',
      name: args.title || 'LatticeFlow v2 Flow',
      schemaVersion: 2,
      graphJson: validatedG,
    }, failTool, SYSTEM_PROTECTED_COLLECTIONS);
  }

  const hasExplicitRuleKey = Boolean(
    hydratedRuleKey
    || (isPlainObject(args.rule) && (args.rule.ruleKey || args.rule.automationCode))
    || (isPlainObject(inputGraph) && inputGraph.ruleKey),
  );
  const pinnedRuleKey = !args.newRuleKey && !args.targetRuleKey && hasExplicitRuleKey && baseRule?.ruleKey
    ? baseRule.ruleKey
    : null;

  const effectiveGraph = inputGraph
    ? validateFlowGraphInput(inputGraph, failTool, SYSTEM_PROTECTED_COLLECTIONS, { requireTrigger: false })
    : (isPlainObject(baseRule?.graphJson) && Array.isArray(baseRule.graphJson.nodes) ? baseRule.graphJson : null);

  if (isFixError) {
    const fixHit = await callFlowArchitectIfAvailable(ctx, db, actor, 'fix_error', {
      prompt: goalText,
      goal: goalText,
      ruleKey: baseRule?.ruleKey || hydratedRuleKey,
      ...(baseRule ? { rule: baseRule, currentRule: baseRule } : {}),
      ...(effectiveGraph ? { graph: effectiveGraph, graphJson: effectiveGraph } : {}),
      runTrace: hydratedRunTrace || {},
      apply: shouldApply,
    }, deps);

    let draftRule;
    let draftGraph;
    let graphDiff = null;
    let modeUsed;
    let repairAttempts;
    let diffSummary;
    let applied = false;
    let savedRule = null;

    if (fixHit) {
      const data = fixHit.data;
      draftRule = data.draftRule || data.previewRule || data.rule || baseRule;
      if (draftRule && pinnedRuleKey) draftRule = { ...draftRule, ruleKey: pinnedRuleKey };
      if (draftRule) draftRule = validateAndNormalizeRule(draftRule, failTool, SYSTEM_PROTECTED_COLLECTIONS);
      draftGraph = data.draftGraph || draftRule?.graphJson || null;
      graphDiff = data.graphDiff || null;
      modeUsed = data.modeUsed;
      repairAttempts = data.repairAttempts;
      applied = Boolean(data.applied || data.saved || data.savedRule);
      savedRule = data.savedRule || null;
      diffSummary = data.summary || `Đã sửa lỗi flow "${draftRule?.ruleKey || hydratedRuleKey || 'graph'}".`;
    } else {
      const schemaMod = loadStudioFlowSchema();
      const targetGraph = effectiveGraph || (typeof schemaMod?.v1RuleToGraphV2 === 'function' ? schemaMod.v1RuleToGraphV2(baseRule) : null);
      if (!targetGraph) {
        throw failTool('AUTOMATION_RULE_INVALID', 400, 'Không có graphJson để sửa lỗi lần chạy.');
      }
      const repaired = applyLocalGraphFixError(targetGraph, hydratedRunTrace, failTool, SYSTEM_PROTECTED_COLLECTIONS);
      draftGraph = repaired.graph;
      draftRule = validateAndNormalizeRule({
        ...(baseRule || { ruleKey: 'flow_v2_repaired', name: 'Repaired Flow' }),
        schemaVersion: 2,
        graphJson: draftGraph,
      }, failTool, SYSTEM_PROTECTED_COLLECTIONS);
      diffSummary = `Đã sửa lỗi node "${repaired.targetNodeId}" và gắn nhánh error recovery.`;
    }

    if (shouldApply && !applied && draftRule) {
      savedRule = await saveTenantAutomationRule(ctx, db, actor, draftRule, deps);
      applied = true;
    }

    return publishPatchAutomationUpdate(actor, {
      operation: 'patchAutomation',
      mode: 'fix_error',
      organizationId: actor.organizationId,
      ruleKey: draftRule?.ruleKey || hydratedRuleKey,
      applied,
      ...(args.dryRun ? { dryRun: true } : {}),
      ...(modeUsed !== undefined ? { modeUsed } : {}),
      ...(repairAttempts !== undefined ? { repairAttempts } : {}),
      patch: { mode: 'fix_error', ...(hydratedRunTrace?.runUid ? { runUid: hydratedRunTrace.runUid } : {}) },
      diffSummary,
      ...(draftGraph ? { draftGraph } : {}),
      ...(graphDiff ? { graphDiff } : {}),
      ...(draftRule ? { draftRule } : {}),
      ...(savedRule ? { rule: savedRule } : {}),
    });
  }

  const explicitTarget = args.nodeId || args.targetNode;
  const resolvedTarget = inferPatchTargetNode(goalText, explicitTarget, { cfgPatch, explicitTrigger });
  const resolvedGraphNodeId = effectiveGraph && !args.nodeId
    ? (
      resolvedTarget === 'filter'
        ? (effectiveGraph.nodes.find((n) => n.type === 'control.if' && (n.id === 'filter_1' || n.config?.isRuleFilter))?.id
          || effectiveGraph.nodes.find((n) => n.type === 'control.if')?.id
          || null)
        : (resolvedTarget === 'dmn'
          ? (effectiveGraph.nodes.find((n) => n.type === 'logic.dmn')?.id || null)
          : null)
    )
    : null;
  const effectiveNodeId = args.nodeId ? String(args.nodeId).trim() : resolvedGraphNodeId;

  if (effectiveGraph && !args.nodeId && (resolvedTarget === 'actions' || resolvedTarget === 'step:new')) {
    const archMod = loadStudioFlowArchitect();
    const nGoalV2 = stripDiacriticsSimple(goalText).toLowerCase().replace(/\s+/g, ' ').trim();
    const explicitType = isPlainObject(cfgPatch) ? String(cfgPatch.type || cfgPatch.nodeType || '').trim() : '';
    let appendType;
    let appendLabel;
    let appendConfig;
    if (explicitType) {
      appendType = explicitType;
      appendLabel = cfgPatch.label ? String(cfgPatch.label) : explicitType;
      const { type: _t, nodeType: _nt, label: _lb, ...restCfg } = cfgPatch;
      appendConfig = isPlainObject(cfgPatch.config) ? clonePlain(cfgPatch.config) : clonePlain(restCfg);
    } else if (/\b(?:ai|llm|triage)\b|tom tat|summarize/.test(nGoalV2)) {
      appendType = 'ai.llm';
      appendLabel = 'AI Summary';
      appendConfig = {
        systemPrompt: 'Summarize event context cleanly in JSON.',
        userPrompt: '{{data}}',
        responseFormat: 'json',
        fallbackOutput: { summary: goalText.slice(0, 140) || 'AI Summary' },
        ...(cfgPatch || {}),
      };
    } else if (/\b(?:webhook|http|connector)\b|dong bo|sync/.test(nGoalV2)) {
      appendType = 'integration.http';
      appendLabel = 'HTTP Integration';
      appendConfig = {
        connectorKey: cfgPatch?.connectorKey || '',
        method: cfgPatch?.method || 'POST',
        path: cfgPatch?.path || '/sync',
        body: cfgPatch?.body || { eventType: '{{type}}', data: '{{data}}' },
        ...(cfgPatch || {}),
      };
    } else if (/\b(?:tao|create|ticket|work\s*order|phieu)\b/.test(nGoalV2)) {
      appendType = 'data.create';
      appendLabel = 'Create Record';
      appendConfig = {
        collection: cfgPatch?.collection || (nGoalV2.includes('ticket') ? 'latticeServiceTickets' : 'latticeCustomWorkOrders'),
        values: cfgPatch?.values || { title: '{{data.deviceKey}}' },
        ...(cfgPatch || {}),
      };
    } else {
      const roleMatch = goalText.match(/\b(ldx_[a-z0-9_]{2,40})\b/i);
      const roleName = roleMatch ? roleMatch[1] : (/manager|quan ly|giam doc/.test(nGoalV2) ? 'ldx_manager' : 'ldx_operator');
      appendType = 'notify.send';
      appendLabel = 'Notify';
      appendConfig = {
        roleNames: [roleName],
        severity: 'warning',
        title: goalText.slice(0, 120) || 'Automation Notice',
        ...(cfgPatch || {}),
      };
    }
    const existingIds = new Set(effectiveGraph.nodes.map((n) => n.id));
    const idBase = appendType.split('.')[1] || 'step';
    let seq = effectiveGraph.nodes.length + 1;
    let newNodeId = `${idBase}_${seq}`;
    while (existingIds.has(newNodeId)) {
      seq += 1;
      newNodeId = `${idBase}_${seq}`;
    }
    const concreteNode = { id: newNodeId, type: appendType, label: appendLabel, config: appendConfig };
    const edgesList = Array.isArray(effectiveGraph.edges) ? effectiveGraph.edges : [];
    const outgoingSources = new Set(edgesList.map((e) => e.source));
    const nonTriggerNodes = effectiveGraph.nodes.filter((n) => !String(n.type || '').startsWith('trigger.'));
    const leafNonTrigger = [...nonTriggerNodes].reverse().find((n) => !outgoingSources.has(n.id));
    const tailNode = leafNonTrigger
      || nonTriggerNodes[nonTriggerNodes.length - 1]
      || effectiveGraph.nodes.find((n) => String(n.type || '').startsWith('trigger.'))
      || effectiveGraph.nodes[effectiveGraph.nodes.length - 1]
      || null;
    const tailPort = tailNode?.type === 'control.if'
      ? 'true'
      : (tailNode?.type === 'control.approval' ? 'approved' : (tailNode?.type === 'control.loop' ? 'item' : 'main'));
    const ops = [{ op: 'add_node', node: concreteNode }];
    if (tailNode) {
      ops.push({ op: 'connect_edge', edge: { source: tailNode.id, sourceHandle: tailPort, target: concreteNode.id, targetHandle: 'in' } });
    }
    let nextGraph;
    let graphDiff = null;
    if (archMod && typeof archMod.applyGraphOperations === 'function') {
      const appliedOps = archMod.applyGraphOperations(effectiveGraph, ops);
      nextGraph = validateFlowGraphInput(appliedOps.graph, failTool, SYSTEM_PROTECTED_COLLECTIONS, { requireTrigger: true });
      graphDiff = appliedOps.graphDiff;
    } else {
      nextGraph = clonePlain(effectiveGraph);
      nextGraph.nodes.push(concreteNode);
      if (!Array.isArray(nextGraph.edges)) nextGraph.edges = [];
      if (tailNode) {
        nextGraph.edges.push({ id: `edge_${nextGraph.edges.length + 1}`, source: tailNode.id, sourceHandle: tailPort, target: concreteNode.id, targetHandle: 'in' });
      }
      nextGraph = validateFlowGraphInput(nextGraph, failTool, SYSTEM_PROTECTED_COLLECTIONS, { requireTrigger: true });
    }
    const validatedDraft = validateAndNormalizeRule({ ...baseRule, schemaVersion: 2, graphJson: nextGraph }, failTool, SYSTEM_PROTECTED_COLLECTIONS);
    let savedRule = null;
    let applied = false;
    if (shouldApply) {
      savedRule = await saveTenantAutomationRule(ctx, db, actor, validatedDraft, deps);
      applied = true;
    }
    return publishPatchAutomationUpdate(actor, {
      operation: 'patchAutomation',
      organizationId: actor.organizationId,
      ruleKey: validatedDraft.ruleKey,
      targetNode: concreteNode.id,
      nodeId: concreteNode.id,
      applied,
      ...(args.dryRun ? { dryRun: true } : {}),
      patch: { op: 'add_node', nodeId: concreteNode.id, nodeType: concreteNode.type, connectedFrom: tailNode?.id || null },
      diffSummary: `Đã gắn thêm node "${concreteNode.id}" (${concreteNode.type}) vào Graph v2.`,
      draftGraph: nextGraph,
      ...(graphDiff ? { graphDiff } : {}),
      draftRule: validatedDraft,
      ...(savedRule ? { rule: savedRule } : {}),
    });
  }

  if (effectiveGraph && !args.nodeId && (resolvedTarget === 'cooldown' || resolvedTarget === 'guard')) {
    const archMod = loadStudioFlowArchitect();
    const prevCooldown = Number(baseRule?.cooldownSec ?? effectiveGraph.settings?.cooldownSec ?? 0);
    const extracted = extractCooldownSeconds(goalText);
    const rawCooldown = cfgPatch?.cooldownSec !== undefined
      ? Number(cfgPatch.cooldownSec)
      : (extracted !== null ? extracted : (prevCooldown > 0 ? prevCooldown : 120));
    const finalCooldown = Math.max(0, Math.round(rawCooldown));
    const nextSettings = {
      cooldownSec: finalCooldown,
      ...(cfgPatch?.maxDepth !== undefined ? { maxDepth: Number(cfgPatch.maxDepth) } : {}),
    };
    let nextGraph;
    let graphDiff = null;
    if (archMod && typeof archMod.applyGraphOperations === 'function') {
      const appliedOps = archMod.applyGraphOperations(effectiveGraph, [{ op: 'update_settings', settings: nextSettings }]);
      nextGraph = validateFlowGraphInput(appliedOps.graph, failTool, SYSTEM_PROTECTED_COLLECTIONS, { requireTrigger: true });
      graphDiff = appliedOps.graphDiff;
    } else {
      nextGraph = clonePlain(effectiveGraph);
      nextGraph.settings = { ...(isPlainObject(nextGraph.settings) ? nextGraph.settings : {}), ...nextSettings };
      nextGraph = validateFlowGraphInput(nextGraph, failTool, SYSTEM_PROTECTED_COLLECTIONS, { requireTrigger: true });
    }
    const validatedDraft = validateAndNormalizeRule({
      ...baseRule,
      cooldownSec: finalCooldown,
      ...(cfgPatch?.maxDepth !== undefined ? { maxDepth: Number(cfgPatch.maxDepth) } : {}),
      ...(cfgPatch?.active !== undefined ? { active: Boolean(cfgPatch.active) } : {}),
      schemaVersion: 2,
      graphJson: nextGraph,
    }, failTool, SYSTEM_PROTECTED_COLLECTIONS);
    let savedRule = null;
    let applied = false;
    if (shouldApply) {
      savedRule = await saveTenantAutomationRule(ctx, db, actor, validatedDraft, deps);
      applied = true;
    }
    return publishPatchAutomationUpdate(actor, {
      operation: 'patchAutomation',
      organizationId: actor.organizationId,
      ruleKey: validatedDraft.ruleKey,
      targetNode: 'cooldown',
      applied,
      ...(args.dryRun ? { dryRun: true } : {}),
      patch: { cooldownSec: finalCooldown },
      diffSummary: `Cập nhật cooldownSec: ${prevCooldown}s -> ${finalCooldown}s trên Graph v2.`,
      draftGraph: nextGraph,
      ...(graphDiff ? { graphDiff } : {}),
      draftRule: validatedDraft,
      ...(savedRule ? { rule: savedRule } : {}),
    });
  }

  const isGraphNodePatch = Boolean(effectiveGraph && cfgPatch && effectiveNodeId && effectiveGraph.nodes.some((n) => n.id === effectiveNodeId));
  const shouldUseLocalPatcher = Boolean((cfgPatch && !isGraphNodePatch) || explicitTrigger);
  const architectTargetNode = effectiveNodeId
    || (resolvedTarget === 'actions' || resolvedTarget === 'step:new' ? 'step:append' : resolvedTarget);

  if (isGraphNodePatch) {
    const archMod = loadStudioFlowArchitect();
    const targetNodeId = effectiveNodeId;
    let nextGraph;
    let graphDiff = null;
    if (archMod && typeof archMod.applyGraphOperations === 'function') {
      const appliedOps = archMod.applyGraphOperations(effectiveGraph, [{ op: 'update_node', nodeId: targetNodeId, configPatch: cfgPatch }]);
      nextGraph = validateFlowGraphInput(appliedOps.graph, failTool, SYSTEM_PROTECTED_COLLECTIONS, { requireTrigger: true });
      graphDiff = appliedOps.graphDiff;
    } else {
      nextGraph = clonePlain(effectiveGraph);
      const tNode = nextGraph.nodes.find((n) => n.id === targetNodeId);
      if (tNode) tNode.config = { ...(tNode.config || {}), ...cfgPatch };
      nextGraph = validateFlowGraphInput(nextGraph, failTool, SYSTEM_PROTECTED_COLLECTIONS, { requireTrigger: true });
    }
    const validatedDraft = validateAndNormalizeRule({ ...baseRule, schemaVersion: 2, graphJson: nextGraph }, failTool, SYSTEM_PROTECTED_COLLECTIONS);
    let savedRule = null;
    let applied = false;
    if (shouldApply) {
      savedRule = await saveTenantAutomationRule(ctx, db, actor, validatedDraft, deps);
      applied = true;
    }
    return publishPatchAutomationUpdate(actor, {
      operation: 'patchAutomation',
      organizationId: actor.organizationId,
      ruleKey: validatedDraft.ruleKey,
      targetNode: targetNodeId,
      nodeId: targetNodeId,
      applied,
      ...(args.dryRun ? { dryRun: true } : {}),
      patch: { nodeId: targetNodeId, configPatch: cfgPatch },
      diffSummary: `Đã cập nhật cấu hình node "${targetNodeId}" trên Graph v2.`,
      draftGraph: nextGraph,
      ...(graphDiff ? { graphDiff } : {}),
      draftRule: validatedDraft,
      ...(savedRule ? { rule: savedRule } : {}),
    });
  }

  const architectHit = !shouldUseLocalPatcher
    ? await callFlowArchitectIfAvailable(ctx, db, actor, 'node', {
        prompt: goalText,
        goal: goalText,
        ruleKey: baseRule?.ruleKey || hydratedRuleKey,
        ...(effectiveNodeId ? { nodeId: effectiveNodeId } : {}),
        targetNode: architectTargetNode,
        target: architectTargetNode,
        ...(baseRule ? { rule: baseRule, currentRule: baseRule } : {}),
        ...(effectiveGraph ? { graph: effectiveGraph, graphJson: effectiveGraph } : {}),
        apply: shouldApply,
      }, deps)
    : null;

  if (architectHit) {
    const data = architectHit.data;
    let draftRule = data.draftRule || data.previewRule || data.rule || baseRule;
    if (draftRule && pinnedRuleKey) {
      draftRule = { ...draftRule, ruleKey: pinnedRuleKey };
    }
    if (draftRule) {
      draftRule = validateAndNormalizeRule(draftRule, failTool, SYSTEM_PROTECTED_COLLECTIONS);
    }
    const draftGraph = data.draftGraph || draftRule?.graphJson || null;
    let applied = Boolean(data.applied || data.saved || data.savedRule);
    let savedRule = data.savedRule || null;
    if (shouldApply && !applied && draftRule) {
      savedRule = await saveTenantAutomationRule(ctx, db, actor, draftRule, deps);
      applied = true;
    }
    const summaryText = Array.isArray(data.diffSummary)
      ? data.diffSummary.join('; ')
      : (data.diffSummary || data.summary || `Đã vá node ${resolvedTarget} của rule "${draftRule?.ruleKey || hydratedRuleKey}".`);
    return publishPatchAutomationUpdate(actor, {
      operation: 'patchAutomation',
      organizationId: actor.organizationId,
      ruleKey: draftRule?.ruleKey || hydratedRuleKey,
      targetNode: resolvedTarget === 'cooldown' ? 'cooldown' : (data.targetNode || resolvedTarget),
      applied,
      ...(args.dryRun ? { dryRun: true } : {}),
      ...(data.modeUsed !== undefined ? { modeUsed: data.modeUsed } : {}),
      ...(data.repairAttempts !== undefined ? { repairAttempts: data.repairAttempts } : {}),
      patch: data.patch || { targetNode: resolvedTarget },
      diffSummary: summaryText,
      ...(draftGraph ? { draftGraph } : {}),
      ...(data.graphDiff ? { graphDiff: data.graphDiff } : {}),
      ...(draftRule ? { draftRule } : {}),
      ...(savedRule ? { rule: savedRule } : {}),
    });
  }

  if (!baseRule) {
    baseRule = await loadTenantAutomationRule(db, actor.organizationId, hydratedRuleKey, val, failTool);
  }

  const nextRule = clonePlain(baseRule);
  const nGoal = stripDiacriticsSimple(goalText).toLowerCase().replace(/\s+/g, ' ').trim();
  let patch = {};
  let diffSummary = '';

  const stepMatch = resolvedTarget.match(/^(?:step|action):(\d+)$/);
  if (resolvedTarget === 'cooldown' || resolvedTarget === 'guard') {
    const prevCooldown = nextRule.cooldownSec;
    const extracted = extractCooldownSeconds(goalText);
    const nextCooldown = cfgPatch?.cooldownSec !== undefined
      ? Number(cfgPatch.cooldownSec)
      : (extracted !== null ? extracted : (prevCooldown > 0 ? prevCooldown : 120));
    nextRule.cooldownSec = Math.max(0, Math.round(nextCooldown));
    if (cfgPatch?.maxDepth !== undefined) nextRule.maxDepth = Number(cfgPatch.maxDepth);
    if (cfgPatch?.active !== undefined) nextRule.active = Boolean(cfgPatch.active);
    patch = { cooldownSec: nextRule.cooldownSec };
    diffSummary = `Cập nhật cooldownSec: ${prevCooldown}s -> ${nextRule.cooldownSec}s (giữ nguyên filter và ${nextRule.actionsJson.length} bước).`;
  } else if (resolvedTarget === 'trigger') {
    const prevTrigger = nextRule.triggerEventType;
    let nextTrigger = explicitTrigger || cfgPatch?.triggerEventType || null;
    if (!nextTrigger) {
      if (nGoal.includes('device.offline') || nGoal.includes('mat ket noi')) nextTrigger = 'device.offline';
      else if (nGoal.includes('lot.held_mkt') || nGoal.includes('mkt')) nextTrigger = 'lot.held_mkt';
      else if (nGoal.includes('sla.breached') || nGoal.includes('sla')) nextTrigger = 'sla.breached';
      else if (nGoal.includes('epod')) nextTrigger = 'epod.captured';
      else nextTrigger = 'alarm.triggered';
    }
    nextRule.triggerEventType = String(nextTrigger).trim();
    if (cfgPatch?.cooldownSec !== undefined) nextRule.cooldownSec = Math.max(0, Math.round(Number(cfgPatch.cooldownSec)));
    if (cfgPatch?.active !== undefined) nextRule.active = Boolean(cfgPatch.active);
    patch = { triggerEventType: nextRule.triggerEventType };
    diffSummary = `Đổi triggerEventType: "${prevTrigger}" -> "${nextRule.triggerEventType}".`;
  } else if (resolvedTarget === 'dmn') {
    const prevDmn = nextRule.dmnTableKey;
    const dmnMatch = goalText.match(/\b([a-z0-9]+(?:_[a-z0-9]+)+_v\d+|[a-z0-9]+(?:_[a-z0-9]+)+)\b/i);
    const hasExplicitDmn = cfgPatch && Object.prototype.hasOwnProperty.call(cfgPatch, 'dmnTableKey');
    const candidateDmn = hasExplicitDmn
      ? cfgPatch.dmnTableKey
      : ((dmnMatch && !dmnMatch[1].startsWith('auto_') ? dmnMatch[1] : null) || prevDmn);
    nextRule.dmnTableKey = candidateDmn ? String(candidateDmn).trim() : null;
    patch = { dmnTableKey: nextRule.dmnTableKey };
    diffSummary = `Cập nhật dmnTableKey: "${prevDmn || 'none'}" -> "${nextRule.dmnTableKey || 'none'}".`;
  } else if (resolvedTarget === 'filter') {
    const prevFilter = nextRule.filterJson;
    const metaOnlyKeys = new Set(['active', 'name', 'description', 'cooldownSec', 'maxDepth', 'triggerEventType', 'dmnTableKey']);
    const hasFilterKey = cfgPatch && Object.prototype.hasOwnProperty.call(cfgPatch, 'filterJson');
    const hasFilterShape = cfgPatch && (
      cfgPatch.field
      || cfgPatch.$and
      || cfgPatch.$or
      || cfgPatch.$not
      || Object.keys(cfgPatch).some((k) => !metaOnlyKeys.has(k))
    );
    if (hasFilterKey) {
      nextRule.filterJson = cfgPatch.filterJson ? clonePlain(cfgPatch.filterJson) : null;
    } else if (hasFilterShape) {
      nextRule.filterJson = clonePlain(cfgPatch);
    } else if (cfgPatch) {
      if (cfgPatch.active !== undefined) nextRule.active = Boolean(cfgPatch.active);
      if (cfgPatch.name !== undefined) nextRule.name = String(cfgPatch.name);
      if (cfgPatch.description !== undefined) nextRule.description = cfgPatch.description ? String(cfgPatch.description) : null;
      if (cfgPatch.cooldownSec !== undefined) nextRule.cooldownSec = Math.max(0, Math.round(Number(cfgPatch.cooldownSec)));
      if (cfgPatch.maxDepth !== undefined) nextRule.maxDepth = Number(cfgPatch.maxDepth);
    }
    if (!hasFilterKey && !hasFilterShape && goalText) {
      const thr = extractNumericThreshold(goalText);
      const clauses = [];
      if (thr !== null) {
        const field = isHumidityGoal(goalText, nGoal) ? 'humidity' : (nGoal.includes('ap suat') ? 'pressure' : 'tempC');
        clauses.push({ field, op: thr.op, value: thr.value });
      }
      if (nGoal.includes('critical') || nGoal.includes('nghiem trong')) {
        clauses.push({ field: 'severity', op: 'eq', value: 'critical' });
      } else if (nGoal.includes('warning') || nGoal.includes('canh bao')) {
        clauses.push({ field: 'severity', op: 'in', value: ['critical', 'high', 'warning'] });
      }
      if (clauses.length === 1) {
        nextRule.filterJson = (nGoal.includes('them') && isPlainObject(prevFilter))
          ? { $and: [prevFilter, clauses[0]] }
          : clauses[0];
      } else if (clauses.length > 1) {
        nextRule.filterJson = { $and: clauses };
      }
    }
    patch = cfgPatch && !hasFilterKey && !hasFilterShape
      ? clonePlain(cfgPatch)
      : { filterJson: nextRule.filterJson };
    diffSummary = `Cập nhật filterJson (giữ nguyên cooldownSec=${nextRule.cooldownSec} và ${nextRule.actionsJson.length} bước).`;
  } else if (resolvedTarget === 'actions' || resolvedTarget === 'step:new') {
    const role = inferRoleFromGoal(goalText);
    const newAction = isPlainObject(cfgPatch) && cfgPatch.type
      ? cfgPatch
      : (isPlainObject(cfgPatch?.action) && cfgPatch.action.type
        ? cfgPatch.action
        : (nGoal.includes('triage') || nGoal.includes('ai phan tich')
          ? { type: 'trigger_ai_triage', label: 'AI Triage bổ sung', targetCollection: 'latticeAssets' }
          : { type: 'notify_role', label: `Thông báo ${role}`, role, category: 'automation', severity: 'warning', title: 'Cảnh báo bổ sung: {{data.deviceKey}}' }));
    nextRule.actionsJson.push(newAction);
    patch = { addedStepIndex: nextRule.actionsJson.length - 1, action: newAction };
    diffSummary = `Thêm bước step:${nextRule.actionsJson.length - 1} (${newAction.type}).`;
  } else if (stepMatch) {
    const idx = Number(stepMatch[1]);
    if (idx < 0 || idx >= nextRule.actionsJson.length) {
      throw failTool('AUTOMATION_TARGET_NODE_NOT_FOUND', 404, `Không tìm thấy bước step:${idx} trong rule "${baseRule.ruleKey}".`);
    }
    if (/(?:^|\s)(?:xoa|bo|go)\s+(?:buoc|step)\b/.test(nGoal)) {
      const removed = nextRule.actionsJson.splice(idx, 1)[0];
      patch = { removedStepIndex: idx, removedType: removed?.type || null };
      diffSummary = `Đã xóa bước step:${idx} (${removed?.type || 'action'}).`;
    } else {
      const step = clonePlain(nextRule.actionsJson[idx]);
      if (cfgPatch) Object.assign(step, cfgPatch);
      const thr = extractNumericThreshold(goalText);
      if (thr !== null) {
        if (step.type === 'twin_set_desired') {
          step.desiredPatch = { ...(isPlainObject(step.desiredPatch) ? step.desiredPatch : {}), targetTempC: thr.value };
        } else if (isPlainObject(step.when) && typeof step.when.field === 'string') {
          step.when = { ...step.when, op: thr.op, value: thr.value };
        } else if (nGoal.includes('dieu kien') || nGoal.includes('neu') || nGoal.includes('khi') || nGoal.includes('nhanh')) {
          step.when = { field: 'data.tempC', op: thr.op, value: thr.value };
        } else if (isPlainObject(step.values) && Object.prototype.hasOwnProperty.call(step.values, 'targetTempC')) {
          step.values.targetTempC = thr.value;
        } else {
          step.when = { field: 'data.tempC', op: thr.op, value: thr.value };
        }
      }
      if (/(?:vai tro|thong bao cho|bao cho|gui cho|\bldx_[a-z0-9_]+\b)/.test(nGoal)) {
        const nextRole = inferRoleFromGoal(goalText);
        if (step.type === 'notify_role') step.role = nextRole;
        else if (isPlainObject(step.values)) step.values.assignedRole = nextRole;
      }
      if (/(?:nhanh|dieu kien|chi chay khi)/.test(nGoal) && !step.when) {
        step.when = nGoal.includes('critical') || nGoal.includes('nghiem trong')
          ? { field: 'data.severity', op: 'eq', value: 'critical' }
          : { field: 'data.severity', op: 'in', value: ['critical', 'high'] };
      }
      nextRule.actionsJson[idx] = step;
      patch = { stepIndex: idx, step };
      diffSummary = `Vá trực tiếp bước step:${idx} (${step.type}), giữ nguyên các bước khác và filter/cooldown.`;
    }
  } else {
    throw failTool('AUTOMATION_TARGET_NODE_INVALID', 400, `targetNode "${resolvedTarget}" không hợp lệ.`);
  }

  const validatedDraft = validateAndNormalizeRule(nextRule, failTool, SYSTEM_PROTECTED_COLLECTIONS);
  let savedRule = null;
  let applied = false;
  if (shouldApply) {
    savedRule = await saveTenantAutomationRule(ctx, db, actor, validatedDraft, deps);
    applied = true;
  }

  return publishPatchAutomationUpdate(actor, {
    operation: 'patchAutomation',
    organizationId: actor.organizationId,
    ruleKey: validatedDraft.ruleKey,
    targetNode: resolvedTarget,
    applied,
    ...(args.dryRun ? { dryRun: true } : {}),
    patch,
    diffSummary,
    draftRule: validatedDraft,
    ...(savedRule ? { rule: savedRule } : {}),
  });
}

async function runSaveAutomation(ctx, db, actor, args, deps) {
  const { failTool, SYSTEM_PROTECTED_COLLECTIONS } = deps;
  const rawCandidate = isPlainObject(args.rule) ? args.rule : (isPlainObject(args.config) ? args.config : null);
  assertSafeAutomationInput(String(args.goal || args.prompt || ''), rawCandidate, args, failTool, SYSTEM_PROTECTED_COLLECTIONS);
  const inputGraph = isPlainObject(args.graphJson) ? args.graphJson : (isPlainObject(args.graph) ? args.graph : null);
  const candidate = isPlainObject(args.rule)
    ? sanitizeAutomationValue(args.rule)
    : {
        ...(isPlainObject(args.config) ? sanitizeAutomationValue(args.config) : {}),
        ...(args.ruleKey ? { ruleKey: args.ruleKey } : {}),
        ...(args.title ? { name: args.title } : {}),
        ...(args.triggerEventType ? { triggerEventType: args.triggerEventType } : {}),
        ...(args.schemaVersion != null ? { schemaVersion: args.schemaVersion } : {}),
        ...(inputGraph ? { graphJson: sanitizeAutomationValue(inputGraph), schemaVersion: 2 } : {}),
        ...(args.enabled !== undefined ? { active: args.enabled } : {}),
      };
  const validated = validateAndNormalizeRule(candidate, failTool, SYSTEM_PROTECTED_COLLECTIONS);
  if (args.dryRun) {
    return {
      dryRun: true,
      applied: false,
      operation: 'saveAutomation',
      organizationId: actor.organizationId,
      valid: true,
      rule: validated,
    };
  }
  const saved = await saveTenantAutomationRule(ctx, db, actor, validated, deps);
  publishFlowStudioUpdate(actor, {
    operation: 'saveAutomation',
    ruleKey: saved?.ruleKey || validated.ruleKey,
    applied: true,
    draftRule: saved,
    draftGraph: saved?.graphJson || null,
    message: 'Đã lưu workflow.',
  });
  return {
    applied: true,
    saved: true,
    operation: 'saveAutomation',
    organizationId: actor.organizationId,
    rule: saved,
  };
}

async function runTestAutomation(ctx, db, actor, args, deps) {
  const { val, failTool, hasRes, SYSTEM_PROTECTED_COLLECTIONS } = deps;
  const ruleKey = typeof args.ruleKey === 'string' ? args.ruleKey.trim() : '';
  const goalText = String(args.goal || args.prompt || '').trim();
  const inputGraph = isPlainObject(args.graphJson) ? args.graphJson : (isPlainObject(args.graph) ? args.graph : null);
  assertSafeAutomationInput(goalText, args.rule, args, failTool, SYSTEM_PROTECTED_COLLECTIONS);

  const validatedInputGraph = inputGraph
    ? validateFlowGraphInput(inputGraph, failTool, SYSTEM_PROTECTED_COLLECTIONS, { requireTrigger: !args.nodeId })
    : null;

  let ruleObj = null;
  if (isPlainObject(args.rule)) {
    ruleObj = validateAndNormalizeRule(args.rule, failTool, SYSTEM_PROTECTED_COLLECTIONS);
    if (validatedInputGraph) {
      ruleObj = { ...ruleObj, schemaVersion: 2, graphJson: validatedInputGraph };
    }
  } else if (ruleKey) {
    ruleObj = await loadTenantAutomationRule(db, actor.organizationId, ruleKey, val, failTool);
    if (validatedInputGraph) {
      ruleObj = { ...ruleObj, schemaVersion: 2, graphJson: validatedInputGraph };
    }
  } else if (validatedInputGraph) {
    ruleObj = {
      ruleKey: inputGraph.ruleKey || 'inline_flow',
      name: args.title || 'Inline Graph v2',
      schemaVersion: 2,
      graphJson: validatedInputGraph,
      actionsJson: [],
    };
  } else if (args.workflowId != null && Number.isInteger(Number(args.workflowId)) && Number(args.workflowId) > 0) {
    const rulesRepo = db?.getRepository?.('latticeAutomationRules');
    if (!rulesRepo || typeof rulesRepo.findOne !== 'function') {
      throw failTool('AUTOMATION_ENGINE_UNAVAILABLE', 503, 'Dịch vụ Automation (latticeAutomationRules) chưa sẵn sàng.');
    }
    const row = await rulesRepo.findOne({ filter: { organizationId: actor.organizationId, id: Number(args.workflowId) } });
    if (!row || val(row, 'organizationId') !== actor.organizationId) {
      throw failTool('AUTOMATION_RULE_NOT_FOUND', 404, `Không tìm thấy automation rule #${args.workflowId} trong phạm vi tổ chức.`);
    }
    ruleObj = toPlainAutomationRule(row, val);
    if (validatedInputGraph) {
      ruleObj = { ...ruleObj, schemaVersion: 2, graphJson: validatedInputGraph };
    }
  } else {
    throw failTool('AUTOMATION_RULE_KEY_REQUIRED', 400, 'Cần ruleKey, workflowId, rule hoặc graphJson để chạy mô phỏng dry-run.');
  }

  const nodeId = typeof args.nodeId === 'string' && args.nodeId.trim() ? args.nodeId.trim() : null;
  if (nodeId) {
    const pinnedInputs = isPlainObject(args.pinnedInputs)
      ? sanitizeAutomationValue(args.pinnedInputs)
      : (isPlainObject(args.sampleEvent) ? sanitizeAutomationValue(args.sampleEvent) : {});
    let targetGraph = validatedInputGraph
      || (isPlainObject(ruleObj?.graphJson) && Array.isArray(ruleObj.graphJson.nodes) ? ruleObj.graphJson : null)
      || (isPlainObject(ruleObj?.graph) && Array.isArray(ruleObj.graph.nodes) ? ruleObj.graph : null);
    if (!targetGraph && ruleObj) {
      const schemaMod = loadStudioFlowSchema();
      if (typeof schemaMod?.v1RuleToGraphV2 === 'function') {
        targetGraph = schemaMod.v1RuleToGraphV2(ruleObj);
      }
    }
    if (hasResourceAction(hasRes, ctx, 'dxosAutomations', 'testNode')) {
      const testNodeParams = {
        organizationId: actor.organizationId,
        nodeId,
        ...(targetGraph ? { graph: targetGraph } : {}),
        ...(ruleObj ? { rule: ruleObj } : {}),
        ...(ruleObj?.ruleKey ? { ruleKey: ruleObj.ruleKey } : {}),
        pinnedInputs,
        dryRun: true,
      };
      const delegated = await invokeDxosAutomationsAction(ctx, db, actor, 'testNode', {
        ...testNodeParams,
        values: testNodeParams,
        method: 'POST',
      }, deps);
      if (delegated.ok) {
        const res = delegated.result?.result || delegated.result || {};
        publishFlowStudioUpdate(actor, {
          operation: 'testAutomation',
          ruleKey: ruleObj?.ruleKey || ruleKey || null,
          applied: false,
          simulation: res,
          message: 'Đã chạy mô phỏng workflow.',
        });
        return {
          dryRun: true,
          operation: 'testAutomation',
          organizationId: actor.organizationId,
          ruleKey: ruleObj?.ruleKey || null,
          ...res,
        };
      }
    }
    const execMod = loadStudioFlowExecutor();
    if (execMod && typeof execMod.testSingleFlowNode === 'function') {
      const res = await execMod.testSingleFlowNode(db, {
        graph: targetGraph,
        rule: ruleObj,
        nodeId,
        pinnedInputs,
        organizationId: actor.organizationId,
        actor: {
          id: actor.userId,
          userId: actor.userId,
          employeeId: actor.employeeId,
          username: actor.username,
          organizationId: actor.organizationId,
        },
        options: { app: ctx?.app || db?.app, dryRun: true },
      });
      publishFlowStudioUpdate(actor, {
        operation: 'testAutomation',
        ruleKey: ruleObj?.ruleKey || ruleKey || null,
        applied: false,
        simulation: res,
        message: 'Đã chạy mô phỏng workflow.',
      });
      return {
        dryRun: true,
        operation: 'testAutomation',
        organizationId: actor.organizationId,
        ruleKey: ruleObj?.ruleKey || null,
        ...res,
      };
    }
    throw failTool('AUTOMATION_ENGINE_UNAVAILABLE', 503, 'Dịch vụ kiểm thử từng node (dxosAutomations:testNode / flow/executor) chưa sẵn sàng.');
  }

  const sampleEvent = isPlainObject(args.sampleEvent)
    ? sanitizeAutomationValue(args.sampleEvent)
    : (isPlainObject(args.config) ? sanitizeAutomationValue(args.config) : buildDefaultSampleEventForRule(ruleObj));

  const simResult = await simulateRuleDryRun(ctx, db, actor, ruleObj, sampleEvent, deps);
  const { simulation, stepTraces, executedSteps, skippedSteps } = simResult;
  publishFlowStudioUpdate(actor, {
    operation: 'testAutomation',
    ruleKey: ruleObj?.ruleKey || ruleKey || null,
    applied: false,
    simulation: simResult?.simulation || simResult?.result || simResult,
    message: 'Đã chạy mô phỏng workflow.',
  });
  return {
    dryRun: true,
    operation: 'testAutomation',
    organizationId: actor.organizationId,
    ruleKey: ruleObj.ruleKey || null,
    matched: Boolean(simulation?.matched),
    status: simulation?.status || 'completed',
    ...(simulation?.graphVersion ? { graphVersion: simulation.graphVersion } : {}),
    ...(simulation?.nodeStatesJson ? { nodeStatesJson: simulation.nodeStatesJson } : {}),
    stepTraces,
    executedSteps,
    skippedSteps,
    simulation,
  };
}

async function runResumeAutomation(ctx, db, actor, args, deps) {
  const { val, failTool, hasRes } = deps;
  const runUid = typeof args.runUid === 'string' ? args.runUid.trim() : '';
  if (!runUid) {
    throw failTool('AUTOMATION_RUN_UID_REQUIRED', 400, 'Cần runUid để tiếp tục lượt chạy automation đang tạm dừng.');
  }
  const decision = String(args.decision || 'approved').trim().toLowerCase();
  if (!['approved', 'rejected'].includes(decision)) {
    throw failTool('AUTOMATION_DECISION_INVALID', 400, 'decision phải là "approved" hoặc "rejected".');
  }
  if (hasForbiddenProtoKeys(args.payload) || hasUnsafeAutomationTemplate(args.payload)) {
    throw failTool('AUTOMATION_AI_REFUSED', 400, 'payload chứa khóa hoặc biểu thức template không an toàn.');
  }
  const payload = isPlainObject(args.payload) ? sanitizeAutomationValue(args.payload) : {};
  const hasResumeTokenArg = args.resumeToken !== undefined && args.resumeToken !== null;
  const resumeToken = typeof args.resumeToken === 'string' && args.resumeToken.trim() ? args.resumeToken.trim() : undefined;
  if (hasResumeTokenArg && !resumeToken) {
    throw failTool('INVALID_RESUME_TOKEN', 403, 'Token tiếp tục (resumeToken) không hợp lệ hoặc bị trống.');
  }

  if (args.dryRun) {
    const runsRepo = db?.getRepository?.('latticeAutomationRuns');
    if (!runsRepo || typeof runsRepo.findOne !== 'function') {
      throw failTool('AUTOMATION_ENGINE_UNAVAILABLE', 503, 'Dịch vụ Automation (latticeAutomationRuns) chưa sẵn sàng.');
    }
    const ownRow = await runsRepo.findOne({ filter: { organizationId: actor.organizationId, runUid } });
    if (!ownRow) {
      const crossRow = await runsRepo.findOne({ filter: { runUid } });
      if (crossRow) {
        throw failTool('NATIVE_ORGANIZATION_MISMATCH', 403, 'Không được phép truy cập lượt chạy thuộc tổ chức khác.');
      }
      throw failTool('RUN_NOT_FOUND', 404, `Không tìm thấy automation run "${runUid}" trong phạm vi tổ chức.`);
    }
    if (val(ownRow, 'organizationId') !== actor.organizationId) {
      throw failTool('NATIVE_ORGANIZATION_MISMATCH', 403, 'Không được phép truy cập lượt chạy thuộc tổ chức khác.');
    }
    const currentStatus = val(ownRow, 'status') || null;
    if (currentStatus !== 'suspended') {
      throw failTool('RUN_ALREADY_RESUMED', 409, `Lượt chạy "${runUid}" đang ở trạng thái "${currentStatus || 'unknown'}", không thể resume.`);
    }
    if (hasResumeTokenArg) {
      const expectedHash = val(ownRow, 'resumeTokenHash') ? String(val(ownRow, 'resumeTokenHash')).trim() : '';
      const expectedPlain = val(ownRow, 'resumeToken') ? String(val(ownRow, 'resumeToken')).trim() : '';
      let tokenMatched = false;
      if (expectedHash && /^[0-9a-f]{64}$/i.test(expectedHash)) {
        const actualDigest = createHash('sha256').update(String(resumeToken)).digest();
        const expectedDigest = Buffer.from(expectedHash, 'hex');
        tokenMatched = actualDigest.length === expectedDigest.length && timingSafeEqual(actualDigest, expectedDigest);
      } else if (expectedPlain) {
        const actualDigest = createHash('sha256').update(String(resumeToken)).digest();
        const expectedDigest = createHash('sha256').update(expectedPlain).digest();
        tokenMatched = timingSafeEqual(actualDigest, expectedDigest);
      }
      if (!tokenMatched) {
        throw failTool('INVALID_RESUME_TOKEN', 403, 'Token tiếp tục (resumeToken) không khớp hoặc không hợp lệ.');
      }
    }
    const previewRun = {
      runUid: val(ownRow, 'runUid') || runUid,
      ruleKey: val(ownRow, 'ruleKey') || null,
      currentStatus,
      suspendedNodeId: val(ownRow, 'suspendedNodeId') || null,
    };
    return {
      dryRun: true,
      applied: false,
      operation: 'resumeAutomation',
      organizationId: actor.organizationId,
      runUid,
      decision,
      payload,
      previewRun,
    };
  }

  if (hasResourceAction(hasRes, ctx, 'dxosAutomations', 'resumeRun')) {
    const resumeParams = {
      organizationId: actor.organizationId,
      runUid,
      decision,
      payload,
      ...(resumeToken ? { resumeToken } : {}),
    };
    const delegated = await invokeDxosAutomationsAction(ctx, db, actor, 'resumeRun', {
      ...resumeParams,
      values: resumeParams,
      method: 'POST',
    }, deps);
    if (delegated.ok) {
      const run = delegated.result?.run || delegated.result;
      const resumed = {
        operation: 'resumeAutomation',
        applied: true,
        organizationId: actor.organizationId,
        runUid,
        decision,
        status: run?.status || 'completed',
        run,
      };
      publishFlowStudioUpdate(actor, {
        operation: 'resumeAutomation',
        ruleKey: resumed?.run?.ruleKey || null,
        applied: true,
        run: resumed?.run || resumed,
        message: 'Đã xử lý phê duyệt HITL.',
      });
      return resumed;
    }
  }

  const execMod = loadStudioFlowExecutor();
  if (execMod && typeof execMod.resumeFlowRun === 'function') {
    const run = await execMod.resumeFlowRun(db, {
      organizationId: actor.organizationId,
      runUid,
      decision,
      payload,
      resumeToken,
      actor: {
        id: actor.userId,
        userId: actor.userId,
        employeeId: actor.employeeId,
        username: actor.username,
        organizationId: actor.organizationId,
        roleNames: Array.isArray(actor.roleNames) ? actor.roleNames : [],
        roles: Array.isArray(actor.roleNames) ? actor.roleNames : [],
        isAdmin: Boolean(actor.isAdmin),
        isRoot: Boolean(actor.isRoot),
      },
      dryRun: false,
      options: { app: ctx?.app || db?.app },
    });
    const resumed = {
      operation: 'resumeAutomation',
      applied: true,
      organizationId: actor.organizationId,
      runUid,
      decision,
      status: run?.status || 'completed',
      run,
    };
    publishFlowStudioUpdate(actor, {
      operation: 'resumeAutomation',
      ruleKey: resumed?.run?.ruleKey || null,
      applied: true,
      run: resumed?.run || resumed,
      message: 'Đã xử lý phê duyệt HITL.',
    });
    return resumed;
  }

  throw failTool('AUTOMATION_ENGINE_UNAVAILABLE', 503, 'Dịch vụ tiếp tục HITL (dxosAutomations:resumeRun / flow/executor) chưa sẵn sàng.');
}

async function runDmnActionViaStudioOrResource(ctx, db, actor, actionName, method, payload, deps) {
  const { failTool, hasRes, invokeResourceAction } = deps;
  if (hasResourceAction(hasRes, ctx, 'dxosDmn', actionName)) {
    return invokeResourceAction(ctx, 'dxosDmn', actionName, {
      method,
      organizationId: actor.organizationId,
      ...payload,
      ...(method === 'POST' ? { values: { organizationId: actor.organizationId, ...payload } } : {}),
    });
  }
  const dmnMod = loadStudioModule('dmn-engine');
  if (dmnMod && typeof dmnMod.createDxosDmnActions === 'function') {
    const actions = dmnMod.createDxosDmnActions(db);
    const handler = actions?.[actionName];
    if (typeof handler === 'function') {
      const subCtx = {
        method,
        ...(method === 'GET' ? { query: { organizationId: actor.organizationId, ...payload } } : {}),
        app: ctx?.app,
        db,
        state: {
          ...(ctx?.state || {}),
          currentUser: { id: actor.userId, username: actor.username },
          currentRoles: Array.isArray(actor.roleNames) ? actor.roleNames : (actor.isRoot ? ['root'] : ['admin']),
          currentRole: actor.isRoot ? 'root' : (actor.roleNames?.[0] || 'admin'),
        },
        action: {
          params: {
            organizationId: actor.organizationId,
            ...payload,
            ...(method === 'POST' ? { values: { organizationId: actor.organizationId, ...payload } } : {}),
          },
        },
        body: null,
      };
      await handler(subCtx, async () => {});
      return subCtx.body || {};
    }
  }
  throw failTool('DMN_ENGINE_UNAVAILABLE', 503, 'Dịch vụ DMN (dxosDmn / dmn-engine) chưa sẵn sàng.');
}

async function runDmnListTables(ctx, db, actor, args, deps) {
  const res = await runDmnActionViaStudioOrResource(ctx, db, actor, 'listTables', 'GET', {
    ...(args.tableKey ? { tableKey: args.tableKey } : {}),
    ...(args.active !== undefined ? { activeOnly: Boolean(args.active) } : {}),
    ...(args.limit ? { limit: args.limit } : {}),
  }, deps);
  return { operation: 'dmn_list_tables', organizationId: actor.organizationId, ...(res || {}) };
}

async function runDmnSaveTable(ctx, db, actor, args, deps) {
  const { failTool } = deps;
  if (hasForbiddenProtoKeys(args.rulesJson) || hasForbiddenProtoKeys(args.inputsJson) || hasForbiddenProtoKeys(args.outputsJson)) {
    throw failTool('AUTOMATION_AI_REFUSED', 400, 'Dữ liệu DMN chứa khóa prototype bị cấm.');
  }
  const dmnPayload = {
    tableKey: args.tableKey,
    name: args.name || args.title || args.tableKey,
    description: args.description,
    hitPolicy: args.hitPolicy || 'FIRST',
    inputsJson: args.inputsJson,
    outputsJson: args.outputsJson,
    rulesJson: args.rulesJson,
    ...(args.active !== undefined ? { active: Boolean(args.active) } : {}),
  };
  if (args.dryRun === true) {
    return { operation: 'dmn_save_table', dryRun: true, organizationId: actor.organizationId, table: dmnPayload };
  }
  const res = await runDmnActionViaStudioOrResource(ctx, db, actor, 'saveTable', 'POST', dmnPayload, deps);
  return { operation: 'dmn_save_table', organizationId: actor.organizationId, ...(res || {}) };
}

async function runDmnEvaluate(ctx, db, actor, args, deps) {
  const { failTool } = deps;
  if (hasForbiddenProtoKeys(args.context) || hasForbiddenProtoKeys(args.sampleEvent)) {
    throw failTool('AUTOMATION_AI_REFUSED', 400, 'Ngữ cảnh đánh giá DMN chứa khóa prototype bị cấm.');
  }
  const evalCtx = isPlainObject(args.context) ? args.context : (isPlainObject(args.sampleEvent) ? args.sampleEvent : {});
  const res = await runDmnActionViaStudioOrResource(ctx, db, actor, 'evaluate', 'POST', {
    tableKey: args.tableKey,
    context: evalCtx,
  }, deps);
  return { operation: 'dmn_evaluate', organizationId: actor.organizationId, ...(res || {}) };
}

function createFlowBuilderTools(deps) {
  const {
    val, failTool, safeGetResource, invokeResourceAction, createAuditedTool,
    resolveCallerRoleNames, isStudioAdmin,
    SYSTEM_PROTECTED_COLLECTIONS, isProtectedCollection,
  } = deps;
  const isProtected = (name) => (typeof isProtectedCollection === 'function'
    ? isProtectedCollection(name)
    : hasProtectedCollectionMatch(SYSTEM_PROTECTED_COLLECTIONS, name));
  const hasRes = (ctx, name) => (typeof safeGetResource === 'function' ? safeGetResource(ctx, name) : null);

  return [
    createAuditedTool({
      name: 'dxos_deploy_workflow',
      adminOnly: true,
      defaultPermission: 'ASK',
      introduction: { title: 'Triển khai Quy trình Poka-yoke', about: 'Cài mẫu quy trình doanh nghiệp (tự ánh xạ nhân sự theo role) hoặc AI triage chạy nền.' },
      description: 'Deploy a validated DX-OS workflow template onto the target organization with automatic crew resolution (Admin only).',
      schema: {
        description: 'Workflow template deployment params.',
        properties: {
          templateKey: { type: 'string', required: true, enum: ['procurement', 'logistics-5step', 'incident-uc2', 'internal-service', 'ai-incident-triage'] },
          organizationId: { type: 'string', maxLength: 80 },
          enabled: { type: 'boolean', default: true },
          dryRun: { type: 'boolean', default: false },
        },
      },
      async run(ctx, db, actor, args) {
        const organizationId = args.organizationId || actor.organizationId;
        const crewBindings = await resolveOrgCrewBindings(db, organizationId, val);
        if (args.dryRun) return { dryRun: true, templateKey: args.templateKey, organizationId, crewBindings, enabled: Boolean(args.enabled) };
        const wfRepo = db.getRepository('workflows');
        if (!wfRepo) throw failTool('WORKFLOW_ENGINE_UNAVAILABLE', 503, 'Workflow repository unavailable.');
        const existing = await wfRepo.findOne({ filter: { 'options.dxosTemplateKey': args.templateKey, 'options.dxosOrganizationId': organizationId, current: true } });
        if (existing) return { alreadyExists: true, workflowId: val(existing, 'id'), title: val(existing, 'title') };
        if (args.templateKey === 'ai-incident-triage') {
          const created = await wfRepo.create({
            values: {
              title: `AI Triage Sự cố IoT — ${organizationId}`,
              type: 'collection',
              enabled: args.enabled !== false,
              current: true,
              config: { collection: 'latticeIncidentCases', mode: 1, appends: ['asset'] },
              options: { dxosTemplateKey: 'ai-incident-triage', dxosOrganizationId: organizationId },
            },
          });
          return { deployed: true, workflowId: val(created, 'id'), title: val(created, 'title'), templateKey: 'ai-incident-triage' };
        }
        const studioRes = hasRes(ctx, 'dxosStudio');
        if (studioRes) {
          return invokeResourceAction(ctx, 'dxosStudio', 'installWorkflow', {
            values: { templateKey: args.templateKey, organizationId, ...crewBindings, enabled: args.enabled !== false },
          });
        }
        return { deployed: false, message: 'Cần bật @latticedx/plugin-dxos-studio để cài 4 mẫu quy trình Poka-yoke.' };
      },
    }),

    createAuditedTool({
      name: 'dxos_configure_workflow',
      adminOnly: true,
      defaultPermission: 'ASK',
      introduction: { title: 'Kỹ sư Workflow & DX-OS Flow Architect', about: 'Đọc/chỉnh đồ thị workflow, liệt kê/chạy, thiết kế LatticeFlow v2 DAG đa nhánh, vá node hoặc sửa lỗi fix_error, gợi ý tối ưu, mô phỏng node/flow, lưu và phê duyệt resume HITL.' },
      description: 'Inspect workflow flow_nodes graphs, update node configs, add nodes, build custom collection workflows, toggle enabled state, manage DMN decision tables, manage Stock n8n REST API v1 workflows/executions/credentials, and list, run, suggest, draft, patch, save, test, or resume HITL LatticeFlow v2 automations (Admin only).',
      prepareArgs(raw) {
        if (!isPlainObject(raw)) return raw;
        const next = { ...raw };
        if (typeof next.nodeId === 'number' && Number.isInteger(next.nodeId)) {
          next.nodeId = String(next.nodeId);
        }
        if (typeof next.workflowId === 'number' && Number.isInteger(next.workflowId)) {
          next.workflowId = String(next.workflowId);
        }
        if (typeof next.executionId === 'number' && Number.isInteger(next.executionId)) {
          next.executionId = String(next.executionId);
        }
        return next;
      },
      schema: {
        description: 'Workflow graph engineering, DMN decision tables, Stock n8n REST API v1, and LatticeFlow v2 / Native Automation operation.',
        properties: {
          operation: {
            type: 'string',
            required: true,
            enum: [
              'inspectWorkflow',
              'updateNodeConfig',
              'addNode',
              'buildCustomWorkflow',
              'toggleWorkflow',
              'listAutomations',
              'runAutomation',
              'suggestAutomation',
              'draftAutomation',
              'patchAutomation',
              'saveAutomation',
              'testAutomation',
              'resumeAutomation',
              'listConnectors',
              'testConnector',
              'invokeN8n',
              'dmn_list_tables',
              'dmn_save_table',
              'dmn_evaluate',
              'list_n8n_workflows',
              'create_n8n_workflow',
              'update_n8n_workflow',
              'activate_n8n_workflow',
              'list_n8n_executions',
              'retry_n8n_execution',
              'sync_n8n_credential',
              'list_connected_apps',
            ],
          },
          connectorKey: { type: 'string', maxLength: 64, description: 'Vault connector key (e.g. n8n-enterprise-orchestrator).' },
          n8nConnectorKey: { type: 'string', maxLength: 64, description: 'Target n8n API connector key when syncing credentials.' },
          connectorType: { type: 'string', maxLength: 32, description: 'Optional connector type filter (n8n, webhook, mqtt, orion_ld, http_api).' },
          webhookPath: { type: 'string', maxLength: 200, description: 'Relative webhook path on the target n8n connector.' },
          workflowId: { type: 'string', maxLength: 80 },
          executionId: { type: 'string', maxLength: 80 },
          workflow: { type: 'object', description: 'Stock n8n workflow JSON object for create_n8n_workflow / update_n8n_workflow.' },
          active: { type: 'boolean' },
          tags: { type: 'array', items: { type: 'string' } },
          status: { type: 'string', maxLength: 40 },
          includeData: { type: 'boolean' },
          cursor: { type: 'string', maxLength: 120 },
          n8nCredentialType: { type: 'string', maxLength: 80 },
          credentialName: { type: 'string', maxLength: 120 },
          idempotencyKey: { type: 'string', maxLength: 120 },
          tableKey: { type: 'string', maxLength: 80, description: 'DMN decision table key.' },
          name: { type: 'string', maxLength: 160 },
          description: { type: 'string', maxLength: 500 },
          hitPolicy: { type: 'string', enum: ['FIRST', 'COLLECT'] },
          inputsJson: { type: 'array', items: { type: 'object' } },
          outputsJson: { type: 'array', items: { type: 'object' } },
          rulesJson: { type: 'array', items: { type: 'object' } },
          context: { type: 'object', description: 'DMN evaluation input context.' },
          titleQuery: { type: 'string', maxLength: 100 },
          title: { type: 'string', maxLength: 120 },
          collectionName: { type: 'string', maxLength: 60 },
          triggerMode: { type: 'integer', default: 1 },
          nodeId: { type: 'string', maxLength: 80, description: 'Graph v2 node ID (string) or legacy flow_nodes numeric ID.' },
          nodeKey: { type: 'string', maxLength: 60 },
          nodeType: { type: 'string', enum: ALLOWED_WORKFLOW_NODE_TYPES },
          upstreamNodeId: { type: 'integer' },
          assigneeEmployeeId: { type: 'integer' },
          conditionField: { type: 'string', maxLength: 50 },
          conditionGt: { type: 'number' },
          config: { type: 'object' },
          configPatch: { type: 'object' },
          enabled: { type: 'boolean' },
          ruleKey: { type: 'string', maxLength: 64 },
          sampleEvent: { type: 'object' },
          triggerEventType: { type: 'string', maxLength: 100 },
          limit: { type: 'integer' },
          goal: { type: 'string', maxLength: 1000 },
          prompt: { type: 'string', maxLength: 1000 },
          targetNode: { type: 'string', maxLength: 80 },
          rule: { type: 'object' },
          graphJson: { type: 'object', description: 'LatticeFlow v2 DAG graph object ({ version: 2, nodes, edges, settings }).' },
          graph: { type: 'object', description: 'Alias for graphJson in Flow Architect operations.' },
          schemaVersion: { type: 'integer', description: 'Automation schema version (1 for legacy actionsJson, 2 for Graph v2 DAG).' },
          pinnedInputs: { type: 'object', description: 'Pinned inputs ({ data, steps, nodes, dmn, loop }) for single-node testAutomation.' },
          runTrace: { type: 'object', description: 'Failed run trace for patchAutomation / draftAutomation fix_error mode.' },
          mode: { type: 'string', enum: ['full', 'node', 'suggest', 'fix_error'], description: 'Optional Flow Architect mode override.' },
          runUid: { type: 'string', maxLength: 80, description: 'Suspended automation run UID for resumeAutomation.' },
          decision: { type: 'string', enum: ['approved', 'rejected'], description: 'Human-in-the-loop (HITL) decision for resumeAutomation.' },
          payload: { type: 'object', description: 'Optional decision payload or note for resumeAutomation.' },
          resumeToken: { type: 'string', maxLength: 128, description: 'Optional resume token for resumeAutomation.' },
          apply: { type: 'boolean', default: false },
          dryRun: { type: 'boolean', default: false },
        },
      },
      async run(ctx, db, actor, args) {
        const automationDeps = {
          val,
          failTool,
          hasRes,
          invokeResourceAction,
          resolveCallerRoleNames,
          isStudioAdmin,
          SYSTEM_PROTECTED_COLLECTIONS,
        };
        const bridgeDeps = { ...automationDeps, hasForbiddenProtoKeys, sanitizeAutomationValue };
        if (args.operation === 'listAutomations') return runListAutomations(ctx, db, actor, args, automationDeps);
        if (args.operation === 'runAutomation') return runAutomationExecution(ctx, db, actor, args, automationDeps);
        if (args.operation === 'suggestAutomation') return runSuggestAutomation(ctx, db, actor, args, automationDeps);
        if (args.operation === 'draftAutomation') return runDraftAutomation(ctx, db, actor, args, automationDeps);
        if (args.operation === 'patchAutomation') return runPatchAutomation(ctx, db, actor, args, automationDeps);
        if (args.operation === 'saveAutomation') return runSaveAutomation(ctx, db, actor, args, automationDeps);
        if (args.operation === 'testAutomation') return runTestAutomation(ctx, db, actor, args, automationDeps);
        if (args.operation === 'resumeAutomation') return runResumeAutomation(ctx, db, actor, args, automationDeps);
        if (args.operation === 'listConnectors') return runListConnectors(ctx, db, actor, args, automationDeps);
        if (args.operation === 'testConnector') return runTestConnector(ctx, db, actor, args, automationDeps);
        if (args.operation === 'invokeN8n') return runInvokeN8n(ctx, db, actor, args, bridgeDeps);
        if (args.operation === 'dmn_list_tables') return runDmnListTables(ctx, db, actor, args, automationDeps);
        if (args.operation === 'dmn_save_table') return runDmnSaveTable(ctx, db, actor, args, automationDeps);
        if (args.operation === 'dmn_evaluate') return runDmnEvaluate(ctx, db, actor, args, automationDeps);
        if (args.operation === 'list_n8n_workflows') return runListN8nWorkflows(ctx, db, actor, args, bridgeDeps);
        if (args.operation === 'create_n8n_workflow') return runCreateN8nWorkflow(ctx, db, actor, args, bridgeDeps);
        if (args.operation === 'update_n8n_workflow') return runUpdateN8nWorkflow(ctx, db, actor, args, bridgeDeps);
        if (args.operation === 'activate_n8n_workflow') return runActivateN8nWorkflow(ctx, db, actor, args, bridgeDeps);
        if (args.operation === 'list_n8n_executions') return runListN8nExecutions(ctx, db, actor, args, bridgeDeps);
        if (args.operation === 'retry_n8n_execution') return runRetryN8nExecution(ctx, db, actor, args, bridgeDeps);
        if (args.operation === 'sync_n8n_credential') return runSyncN8nCredential(ctx, db, actor, args, bridgeDeps);
        if (args.operation === 'list_connected_apps') return runListConnectedApps(ctx, db, actor, args, bridgeDeps);

        const wfRepo = db.getRepository('workflows');
        const nodeRepo = db.getRepository('flow_nodes');
        if (!wfRepo || !nodeRepo) throw failTool('WORKFLOW_ENGINE_UNAVAILABLE', 503, 'Workflow/flow_nodes repository unavailable.');
        const numericWorkflowId = args.workflowId != null && /^\d+$/.test(String(args.workflowId).trim())
          ? Number(args.workflowId)
          : args.workflowId;

        if (args.operation === 'inspectWorkflow') {
          let wf = numericWorkflowId ? await wfRepo.findOne({ filterByTk: numericWorkflowId }) : null;
          if (!wf && args.titleQuery) {
            const all = (await wfRepo.find({ filter: { current: true }, limit: 100 })) || [];
            const q = args.titleQuery.toLowerCase();
            wf = all.find((w) => String(val(w, 'title') || '').toLowerCase().includes(q)) || null;
          }
          if (!wf) throw failTool('WORKFLOW_NOT_FOUND', 404, 'Không tìm thấy workflow theo yêu cầu.');
          const wid = val(wf, 'id');
          const nodes = (await nodeRepo.find({ filter: { workflowId: wid }, limit: 100 })) || [];
          return {
            workflowId: wid,
            title: val(wf, 'title'),
            type: val(wf, 'type'),
            enabled: Boolean(val(wf, 'enabled')),
            config: val(wf, 'config') || {},
            nodes: nodes.map((n) => ({
              id: val(n, 'id'),
              key: val(n, 'key'),
              title: val(n, 'title'),
              type: val(n, 'type'),
              upstreamId: val(n, 'upstreamId') ?? null,
              downstreamId: val(n, 'downstreamId') ?? null,
              config: val(n, 'config') || {},
            })),
          };
        }

        if (args.operation === 'updateNodeConfig') {
          if (hasForbiddenProtoKeys(args.configPatch || args.config) || hasUnsafeAutomationTemplate(args.configPatch || args.config)) {
            throw failTool('AUTOMATION_AI_REFUSED', 400, 'configPatch chứa khóa hoặc biểu thức template không an toàn.');
          }
          const numericNodeId = args.nodeId != null && /^\d+$/.test(String(args.nodeId).trim()) ? Number(args.nodeId) : args.nodeId;
          let node = numericNodeId ? await nodeRepo.findOne({ filterByTk: numericNodeId }) : null;
          if (!node && numericWorkflowId && args.nodeKey) {
            node = await nodeRepo.findOne({ filter: { workflowId: numericWorkflowId, key: args.nodeKey } });
          }
          if (!node) throw failTool('WORKFLOW_NODE_NOT_FOUND', 404, 'Không tìm thấy node workflow cần chỉnh sửa.');
          const prevCfg = val(node, 'config') || {};
          const nextCfg = { ...prevCfg, ...(args.configPatch || args.config || {}) };
          const nextTitle = args.title || val(node, 'title');
          if (args.dryRun) return { dryRun: true, nodeId: val(node, 'id'), beforeConfig: prevCfg, afterConfig: nextCfg, afterTitle: nextTitle };
          await node.update({ title: nextTitle, config: nextCfg });
          return { applied: true, updated: true, nodeId: val(node, 'id'), title: nextTitle, config: nextCfg };
        }

        if (args.operation === 'addNode') {
          if (!numericWorkflowId || !args.nodeType) throw failTool('WORKFLOW_NODE_ARGS_REQUIRED', 400, 'Cần workflowId và nodeType.');
          const key = args.nodeKey || `dxos_${args.nodeType}_${Date.now().toString(36)}`;
          if (args.dryRun) return { dryRun: true, workflowId: numericWorkflowId, nodeType: args.nodeType, key, upstreamNodeId: args.upstreamNodeId || null };
          const up = args.upstreamNodeId ? await nodeRepo.findOne({ filterByTk: args.upstreamNodeId }) : null;
          const prevDownstreamId = up ? val(up, 'downstreamId') ?? null : null;
          const created = await nodeRepo.create({
            values: {
              workflowId: numericWorkflowId,
              key,
              title: args.title || `Bước ${args.nodeType}`,
              type: args.nodeType,
              ...(args.upstreamNodeId ? { upstreamId: args.upstreamNodeId } : {}),
              ...(prevDownstreamId != null ? { downstreamId: prevDownstreamId } : {}),
              config: args.config || {},
            },
          });
          const createdId = val(created, 'id');
          if (up && typeof up.update === 'function') {
            await up.update({ downstreamId: createdId });
          }
          if (prevDownstreamId != null) {
            const down = await nodeRepo.findOne({ filterByTk: prevDownstreamId });
            if (down && typeof down.update === 'function') {
              await down.update({ upstreamId: createdId });
            }
          }
          return { applied: true, added: true, node: { id: createdId, key, title: val(created, 'title'), type: val(created, 'type') } };
        }

        if (args.operation === 'toggleWorkflow') {
          if (!numericWorkflowId) throw failTool('WORKFLOW_ID_REQUIRED', 400, 'Cần workflowId để bật/tắt workflow.');
          const enabled = args.enabled !== false;
          if (args.dryRun) return { dryRun: true, workflowId: numericWorkflowId, enabled };
          if (hasRes(ctx, 'workflows')) {
            await invokeResourceAction(ctx, 'workflows', 'update', { filterByTk: numericWorkflowId, values: { enabled } });
          } else {
            const wf = await wfRepo.findOne({ filterByTk: numericWorkflowId });
            if (!wf) throw failTool('WORKFLOW_NOT_FOUND', 404, 'Không tìm thấy workflow.');
            await wf.update({ enabled });
          }
          return { applied: true, workflowId: numericWorkflowId, enabled };
        }

        // buildCustomWorkflow
        if (!args.collectionName || isProtected(args.collectionName)) {
          throw failTool('COLLECTION_FORBIDDEN_FOR_WORKFLOW', 403, `Collection "${args.collectionName}" không hợp lệ hoặc bị bảo vệ.`);
        }
        const title = args.title || `Quy trình ${args.collectionName}`;
        const existingWf = await wfRepo.findOne({ filter: { title, current: true, 'options.dxosOrganizationId': actor.organizationId } });
        if (existingWf) {
          const wfId = val(existingWf, 'id');
          if (args.enabled !== undefined && Boolean(val(existingWf, 'enabled')) !== Boolean(args.enabled)) {
            await existingWf.update({ enabled: Boolean(args.enabled) });
          }
          return { applied: true, created: false, alreadyExists: true, workflowId: wfId, title, enabled: Boolean(args.enabled ?? val(existingWf, 'enabled')), designerUrl: `/admin/settings/workflow/workflows/${wfId}` };
        }
        const triggerMode = [1, 2, 3].includes(Number(args.triggerMode)) ? Number(args.triggerMode) : 1;
        const condField = args.conditionField || 'status';
        const condGt = args.conditionGt !== undefined ? args.conditionGt : -15;
        const crew = await resolveOrgCrewBindings(db, actor.organizationId, val);
        const assigneeEmpId = args.assigneeEmployeeId || crew.managerEmployeeId;
        let assigneeUserId = actor.userId;
        if (assigneeEmpId) {
          const emp = await db.getRepository('latticeEmployees')?.findOne({ filterByTk: assigneeEmpId });
          if (val(emp, 'userId')) assigneeUserId = val(emp, 'userId');
        }
        const enabled = args.enabled !== false;
        if (args.dryRun) {
          return { dryRun: true, operation: 'buildCustomWorkflow', title, collectionName: args.collectionName, triggerMode, enabled, nodeCount: 3 };
        }

        const wfValues = {
          key: `dxos_custom_${Date.now().toString(36)}`,
          title,
          type: 'collection',
          enabled,
          current: true,
          config: { collection: args.collectionName, mode: triggerMode, condition: { $and: [{ organizationId: actor.organizationId }] } },
          options: { dxosOrganizationId: actor.organizationId, dxosCustomCollection: args.collectionName },
        };
        const created = await db.sequelize.transaction(async (transaction) => {
          const wf = await wfRepo.create({ values: wfValues, transaction });
          const workflowId = val(wf, 'id');
          const condNode = await nodeRepo.create({
            values: {
              workflowId,
              key: 'checkThreshold',
              title: `Kiểm tra ngưỡng (${condField} > ${condGt})`,
              type: 'condition',
              config: { rejectOnFalse: false, engine: 'basic', calculation: { group: { type: 'and', calculations: [{ calculator: 'gt', operands: [{ value: `{{$context.data.${condField}}}` }, { value: condGt }] }] } } },
            },
            transaction,
          });
          const reviewNode = await nodeRepo.create({
            values: {
              workflowId,
              key: 'managerReview',
              title: 'Quản lý kiểm tra & phê duyệt',
              type: 'manual',
              upstreamId: val(condNode, 'id'),
              config: { assignees: [String(assigneeUserId)], mode: 1, forms: { review: { title: 'Kết quả thẩm định', type: 'custom' } } },
            },
            transaction,
          });
          await condNode.update({ downstreamId: val(reviewNode, 'id') }, { transaction });
          const markNode = await nodeRepo.create({
            values: {
              workflowId,
              key: 'markReviewed',
              title: 'Cập nhật trạng thái đã kiểm định',
              type: 'update',
              upstreamId: val(reviewNode, 'id'),
              config: { collection: args.collectionName, params: { filter: { id: '{{$context.data.id}}', organizationId: actor.organizationId }, values: { status: 'reviewed' } } },
            },
            transaction,
          });
          await reviewNode.update({ downstreamId: val(markNode, 'id') }, { transaction });
          return { workflowId, title: val(wf, 'title'), key: val(wf, 'key'), nodeCount: 3 };
        });

        let activationError = null;
        if (hasRes(ctx, 'workflows') && enabled) {
          try {
            await invokeResourceAction(ctx, 'workflows', 'update', { filterByTk: created.workflowId, values: { enabled: true } });
          } catch (err) {
            activationError = err?.message || 'Workflow activation failed';
            try {
              const wfRow = await wfRepo.findOne({ filterByTk: created.workflowId });
              if (wfRow && typeof wfRow.update === 'function') await wfRow.update({ enabled: false });
            } catch {}
          }
        }
        const finalEnabled = Boolean(enabled && !activationError);
        return {
          applied: true,
          created: true,
          ...created,
          enabled: finalEnabled,
          ...(activationError ? { activationWarning: `Workflow đã tạo ở trạng thái chưa kích hoạt (${activationError})` } : {}),
          designerUrl: `/admin/settings/workflow/workflows/${created.workflowId}`,
        };
      },
    }),
  ];
}

module.exports = {
  createFlowBuilderTools,
  resolveOrgCrewBindings,
  runListAutomations,
  runAutomationExecution,
  runSuggestAutomation,
  runDraftAutomation,
  runPatchAutomation,
  runSaveAutomation,
  runTestAutomation,
  runResumeAutomation,
  runDmnListTables,
  runDmnSaveTable,
  runDmnEvaluate,
};
