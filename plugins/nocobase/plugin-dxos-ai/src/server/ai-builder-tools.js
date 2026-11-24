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
  NATIVE_SURFACE_ACTIONS,
  collectPortalRouteSet,
  resolvePortalRoutes,
  extractGridBlockUids,
  computeLayoutSignature,
  normalizeGridState,
  computeMultiColumnGrid,
  resolvePageGrid,
  hydrateFlowModel,
  readFlowModelMeta,
  updateGridLayout,
  placeBesideOrInsertBlock,
  propagatePortalRolesToRoutes,
  buildRbacActionsSpec,
  capturePageSnapshot,
  bumpSurfaceRevision,
} = require('./ai-surface-creative-tools');

const ALLOWED_WORKFLOW_NODE_TYPES = ['condition', 'manual', 'update', 'create', 'query', 'calculation', 'output', 'parallel', 'delay'];
const FIELD_INTERFACE_MAP = {
  text: { interface: 'textarea', uiType: 'string' },
  integer: { interface: 'integer', uiType: 'number' },
  float: { interface: 'number', uiType: 'number' },
  boolean: { interface: 'checkbox', uiType: 'boolean' },
  date: { interface: 'datetime', uiType: 'string' },
  select: { interface: 'select', uiType: 'string' },
  string: { interface: 'input', uiType: 'string' },
};

const NATIVE_BLOCK_ALIASES = {
  NativeTableBlock: 'table',
  NativeFormBlock: 'createForm',
  NativeDetailsBlock: 'details',
};

function buildSafePgIndexName(colLower, suffix) {
  const raw = `idx_${colLower}_${suffix}`;
  if (raw.length <= 63) return raw;
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 8);
  const maxBase = Math.max(8, 63 - 4 - suffix.length - 1 - 8 - 1);
  return `idx_${colLower.slice(0, maxBase)}_${hash}_${suffix}`;
}

function buildFieldDefinition(rawField, failTool, FIELD_NAME_RE) {
  const fname = String(rawField?.name || '').trim();
  if (!FIELD_NAME_RE.test(fname)) {
    throw failTool('FIELD_NAME_INVALID', 400, `Tên trường "${fname}" không hợp lệ.`);
  }
  const ftype = Object.prototype.hasOwnProperty.call(FIELD_INTERFACE_MAP, rawField?.type) ? rawField.type : 'string';
  const meta = FIELD_INTERFACE_MAP[ftype];
  const enumValues = Array.isArray(rawField?.enumValues) ? rawField.enumValues.map((v) => String(v).trim()).filter(Boolean) : [];
  return {
    name: fname,
    type: ftype === 'select' ? 'string' : ftype,
    interface: meta.interface,
    ...(rawField?.defaultValue !== undefined ? { defaultValue: rawField.defaultValue } : {}),
    uiSchema: {
      type: meta.uiType,
      title: String(rawField?.title || fname),
      ...(ftype === 'select' && enumValues.length ? { enum: enumValues.map((v) => ({ value: v, label: v })) } : {}),
    },
  };
}

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

const FORBIDDEN_AUTOMATION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const AUTOMATION_RULE_KEY_RE = /^[a-zA-Z0-9_.:-]{1,64}$/;
const SAFE_SAVE_RULE_KEY_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/;
const VALID_AUTOMATION_ACTION_TYPES = new Set([
  'create_record',
  'update_record',
  'notify_role',
  'call_connector',
  'twin_set_desired',
  'trigger_ai_triage',
]);
const ALLOWLISTED_AUTOMATION_COLLECTIONS = new Set([
  'latticeRequests',
  'latticeOrders',
  'latticeOrderLines',
  'latticeServiceTickets',
  'latticeParaDocuments',
  'latticeIncidentCases',
  'latticeLocations',
  'latticeAssets',
  'latticeAgentProposals',
]);
const SENSITIVE_AUTOMATION_COLLECTIONS = new Set([
  'latticePkiKeys',
  'latticeCryptoLedger',
  'latticeConnectors',
  'latticeWebhookSubscriptions',
  'latticeWebhookDeliveries',
  'latticeEventBus',
  'latticeApiKeys',
  'latticeDelegations',
  'latticeDecisionTables',
  'latticeEpodRecords',
  'latticeOrganizations',
  'latticeAutomationRules',
  'latticeAutomationRuns',
]);
const AUTOMATION_CUSTOM_COLLECTION_RE = /^latticeCustom[A-Z][A-Za-z0-9]{1,40}$/;
const AUTOMATION_CORE_VOUCHERS = new Set(['latticeRequests', 'latticeOrders', 'latticeServiceTickets']);
const AUTOMATION_PROTECTED_VOUCHER_FIELDS = new Set([
  'id', 'status', 'version', 'amendedFromId', 'amendmentNo',
  'submittedAt', 'submittedBy', 'cancelledAt', 'cancelledBy', 'cancelReason',
]);
const AUTOMATION_INJECTION_RE = /(?:__proto__|constructor\s*\.\s*prototype|\bprototype\b|process\.env|\.env\b|encryptedsecretsjson|ignore\s+(?:all\s+)?previous|bo\s+qua\s+(?:tat\s+ca|moi)?\s*(?:huong\s+dan|kiem\s+tra|quyen|rbac|acl|bao\s+mat)|system\s+prompt|jailbreak|bypass\s+(?:rbac|acl|auth|hitl|quyen|bao\s+mat)|drop\s+table|truncate\s+table|delete\s+from|union\s+select|api_?key|secret_?key|private_?key|mat\s+khau|in\s+ra\s+[^\n]{0,30}?(?:token|secret|password|key)|tiet\s+lo\s+[^\n]{0,30}?(?:token|secret|password|key))/i;
const AUTOMATION_SYSTEM_TABLE_RE = /(?:\b(?:users|rolesUsers|apiKeys|authenticators|migrations|applicationPlugins|aiSettings|aiEmployees|aiMcpClients|rolesAiEmployees|dataSourcesRoles|dataSourcesRolesResources|dataSourcesRolesResourcesActions|dataSourcesRolesResourcesScopes|latticeAiAuditLogs|latticeAiProfiles|latticeAiQuotaUsage|latticeAiApprovalQueue|latticeUiSnapshots|latticePkiKeys|latticeCryptoLedger|latticeConnectors|latticeWebhookSubscriptions|latticeWebhookDeliveries|latticeEventBus|latticeApiKeys|latticeDelegations|latticeEpodRecords|latticeOrganizations|latticeAutomationRules|latticeAutomationRuns)\b|(?:bang|table|collection|ghi\s+vao|sua|xoa|cap\s+nhat|drop|truncate)\s+roles\b)/i;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stripDiacriticsSimple(input) {
  return String(input || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

function sanitizeAutomationValue(value, seen = new WeakSet()) {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeAutomationValue(item, seen));
  if (value instanceof Date) return new Date(value.getTime());
  const out = {};
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_AUTOMATION_KEYS.has(key)) continue;
    out[key] = sanitizeAutomationValue(value[key], seen);
  }
  return out;
}

function hasForbiddenProtoKeys(value, seen = new WeakSet()) {
  if (value === null || value === undefined || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => hasForbiddenProtoKeys(item, seen));
  for (const key of Object.getOwnPropertyNames(value)) {
    if (FORBIDDEN_AUTOMATION_KEYS.has(key)) return true;
    if (hasForbiddenProtoKeys(value[key], seen)) return true;
  }
  return false;
}

function hasUnsafeAutomationTemplate(value, seen = new WeakSet()) {
  if (typeof value === 'string') {
    for (const match of value.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
      const expr = String(match[1] || '').trim();
      if (!expr || !/^[a-zA-Z0-9_.\-$]+$/.test(expr)) return true;
      const parts = expr.split('.').filter(Boolean);
      if (!parts.length || parts.some((p) => FORBIDDEN_AUTOMATION_KEYS.has(p) || p === 'process' || p === 'env' || p === 'global')) {
        return true;
      }
    }
    return false;
  }
  if (value === null || value === undefined || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => hasUnsafeAutomationTemplate(item, seen));
  return Object.entries(value).some(([k, v]) => FORBIDDEN_AUTOMATION_KEYS.has(k) || hasUnsafeAutomationTemplate(v, seen));
}

function isAllowlistedAutomationCollection(collectionName) {
  const name = String(collectionName || '').trim();
  if (!name) return false;
  if (SENSITIVE_AUTOMATION_COLLECTIONS.has(name)) return false;
  if (ALLOWLISTED_AUTOMATION_COLLECTIONS.has(name)) return true;
  return AUTOMATION_CUSTOM_COLLECTION_RE.test(name);
}

function assertSafeAutomationInput(goalText, ruleObj, args, failTool, protectedCollections) {
  const normGoal = stripDiacriticsSimple(goalText).toLowerCase().replace(/\s+/g, ' ').trim();
  if (normGoal) {
    if (AUTOMATION_INJECTION_RE.test(normGoal)) {
      throw failTool('AUTOMATION_AI_REFUSED', 400, 'Yêu cầu vi phạm chính sách bảo mật (injection, lộ bí mật hoặc prototype key).');
    }
    if (AUTOMATION_SYSTEM_TABLE_RE.test(normGoal)) {
      throw failTool('AUTOMATION_AI_REFUSED', 400, 'Không được phép tạo hoặc sửa automation nhắm vào bảng hệ thống hoặc bảng nhạy cảm.');
    }
  }
  if (args?.collectionName) {
    const col = String(args.collectionName).trim();
    if (protectedCollections?.has(col) || !isAllowlistedAutomationCollection(col)) {
      throw failTool('AUTOMATION_AI_REFUSED', 400, `Collection "${col}" không nằm trong danh sách cho phép của Automation.`);
    }
  }
  if (hasForbiddenProtoKeys(ruleObj) || hasForbiddenProtoKeys(args?.sampleEvent) || hasForbiddenProtoKeys(args?.config) || hasForbiddenProtoKeys(args?.configPatch)) {
    throw failTool('AUTOMATION_AI_REFUSED', 400, 'Phát hiện khóa đối tượng bị cấm (__proto__, constructor, prototype).');
  }
  if (isPlainObject(ruleObj)) {
    if (ruleObj.filterJson !== undefined && ruleObj.filterJson !== null && hasUnsafeAutomationTemplate(ruleObj.filterJson)) {
      throw failTool('AUTOMATION_AI_REFUSED', 400, 'filterJson chứa biểu thức template không an toàn.');
    }
    const actions = Array.isArray(ruleObj.actionsJson) ? ruleObj.actionsJson : [];
    for (let i = 0; i < actions.length; i += 1) {
      const act = actions[i];
      if (!isPlainObject(act)) {
        throw failTool('AUTOMATION_AI_REFUSED', 400, `actionsJson[${i}] không hợp lệ.`);
      }
      if (hasUnsafeAutomationTemplate(act)) {
        throw failTool('AUTOMATION_AI_REFUSED', 400, `actionsJson[${i}] chứa biểu thức template không an toàn.`);
      }
      const actType = String(act.type || '').trim();
      if (actType && !VALID_AUTOMATION_ACTION_TYPES.has(actType)) {
        throw failTool('AUTOMATION_AI_REFUSED', 400, `Loại hành động "${actType}" không được hỗ trợ.`);
      }
      if (actType === 'create_record' || actType === 'update_record') {
        const targetCol = String(act.collection || act.targetCollection || '').trim();
        if (!targetCol || protectedCollections?.has(targetCol) || !isAllowlistedAutomationCollection(targetCol)) {
          throw failTool('AUTOMATION_AI_REFUSED', 400, `Bảng đích "${targetCol || '(empty)'}" không được phép thao tác trong Automation.`);
        }
      }
    }
  }
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

/**
 * Load @latticedx/plugin-dxos-studio automation-engine cleanly, rethrowing transitive errors.
 */
function loadStudioAutomationEngine() {
  return loadStudioModule('automation-engine');
}

/**
 * Load @latticedx/plugin-dxos-studio automation-copilot cleanly, rethrowing transitive errors.
 */
function loadStudioAutomationCopilot() {
  return loadStudioModule('automation-copilot');
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

/**
 * Aggregate per-rule execution statistics from latticeAutomationRuns within a single tenant.
 */
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

/**
 * List tenant-scoped native automation rules via dxosAutomations resource or repository fallback.
 */
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
      actionCount: actions.length,
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

/**
 * Validate and trigger a native automation rule manually (dryRun, dxosAutomations, or engine module).
 */
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
    if (delegated.ok) return delegated.result;
  }

  const engineMod = loadStudioAutomationEngine();
  const runFn = engineMod && (
    typeof engineMod.executeAutomationRuleNow === 'function'
      ? engineMod.executeAutomationRuleNow
      : (typeof engineMod.runAutomationNow === 'function' ? engineMod.runAutomationNow : null)
  );
  if (runFn) {
    return runFn(db, {
      organizationId: actor.organizationId,
      ...(ruleKey ? { ruleKey } : {}),
      ...(ruleId != null ? { id: ruleId, ruleId } : {}),
      sampleEvent,
      actor,
      ctx,
    });
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
    return { run };
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
  });
}

function getSafePathLocal(root, rawPath) {
  if (root === null || root === undefined) return undefined;
  const pathStr = String(rawPath || '').trim();
  if (!pathStr || !/^[a-zA-Z0-9_.\-$]+$/.test(pathStr)) return undefined;
  const segments = pathStr.split('.').filter(Boolean);
  let cur = root;
  for (const seg of segments) {
    if (FORBIDDEN_AUTOMATION_KEYS.has(seg)) return undefined;
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return undefined;
      cur = cur[idx];
    } else {
      if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
      cur = cur[seg];
    }
  }
  return cur;
}

function lookupLocalFilterValue(eventContext, key) {
  const pathStr = String(key || '').trim();
  if (!pathStr) return undefined;
  if (/^(?:data|dmn|event|envelope|steps)\./.test(pathStr)) {
    return getSafePathLocal(eventContext, pathStr);
  }
  const fromData = getSafePathLocal(eventContext?.data, pathStr);
  if (fromData !== undefined) return fromData;
  return getSafePathLocal(eventContext, pathStr);
}

function matchLocalOperator(actual, ops) {
  for (const [op, expected] of Object.entries(ops)) {
    if (FORBIDDEN_AUTOMATION_KEYS.has(op)) return false;
    switch (op) {
      case '$eq':
      case 'eq':
        if (actual !== expected) return false;
        break;
      case '$ne':
      case 'ne':
        if (actual === expected) return false;
        break;
      case '$gt':
      case 'gt': {
        const a = Number(actual);
        const b = Number(expected);
        if (actual === null || actual === undefined || actual === '' || !Number.isFinite(a) || !Number.isFinite(b) || !(a > b)) return false;
        break;
      }
      case '$gte':
      case 'gte': {
        const a = Number(actual);
        const b = Number(expected);
        if (actual === null || actual === undefined || actual === '' || !Number.isFinite(a) || !Number.isFinite(b) || !(a >= b)) return false;
        break;
      }
      case '$lt':
      case 'lt': {
        const a = Number(actual);
        const b = Number(expected);
        if (actual === null || actual === undefined || actual === '' || !Number.isFinite(a) || !Number.isFinite(b) || !(a < b)) return false;
        break;
      }
      case '$lte':
      case 'lte': {
        const a = Number(actual);
        const b = Number(expected);
        if (actual === null || actual === undefined || actual === '' || !Number.isFinite(a) || !Number.isFinite(b) || !(a <= b)) return false;
        break;
      }
      case '$in':
      case 'in':
        if (!Array.isArray(expected) || !expected.includes(actual)) return false;
        break;
      case '$nin':
      case 'nin':
        if (!Array.isArray(expected) || expected.includes(actual)) return false;
        break;
      case '$exists':
      case 'exists':
        if (Boolean(expected) !== (actual !== undefined && actual !== null)) return false;
        break;
      case '$contains':
      case 'contains':
        if (typeof actual === 'string') {
          if (!actual.includes(String(expected))) return false;
        } else if (Array.isArray(actual)) {
          if (!actual.includes(expected)) return false;
        } else {
          return false;
        }
        break;
      default:
        return false;
    }
  }
  return true;
}

function matchesFilterLocal(filterJson, eventContext) {
  if (filterJson === null || filterJson === undefined) return true;
  if (Array.isArray(filterJson)) return filterJson.every((c) => matchesFilterLocal(c, eventContext));
  if (!isPlainObject(filterJson)) return false;
  const entries = Object.entries(filterJson).filter(([k]) => !FORBIDDEN_AUTOMATION_KEYS.has(k));
  if (!entries.length) return true;
  if (typeof filterJson.field === 'string') {
    const actual = lookupLocalFilterValue(eventContext, filterJson.field);
    if (filterJson.op) return matchLocalOperator(actual, { [String(filterJson.op)]: filterJson.value });
    const opsObj = {};
    for (const [k, v] of entries) {
      if (k === 'field') continue;
      if (k === 'value') opsObj.$eq = v;
      else if (k !== 'op') opsObj[k] = v;
    }
    return matchLocalOperator(actual, opsObj);
  }
  for (const [key, expected] of entries) {
    if (key === '$and' || key === 'and' || key === 'all') {
      if (!Array.isArray(expected) || !expected.every((c) => matchesFilterLocal(c, eventContext))) return false;
      continue;
    }
    if (key === '$or' || key === 'or' || key === 'any') {
      if (!Array.isArray(expected) || !expected.some((c) => matchesFilterLocal(c, eventContext))) return false;
      continue;
    }
    if (key === '$not') {
      if (matchesFilterLocal(expected, eventContext)) return false;
      continue;
    }
    const actual = lookupLocalFilterValue(eventContext, key);
    if (isPlainObject(expected) && Object.keys(expected).some((k) => k.startsWith('$'))) {
      if (!matchLocalOperator(actual, expected)) return false;
    } else if (Array.isArray(expected)) {
      if (!expected.includes(actual)) return false;
    } else if (actual !== expected) {
      return false;
    }
  }
  return true;
}

function interpolateLocal(value, context) {
  if (typeof value === 'string') {
    const exact = value.match(/^\{\{\s*([^{}]+?)\s*\}\}$/);
    if (exact) {
      const expr = exact[1].trim();
      let resolved = getSafePathLocal(context, expr);
      if (resolved === undefined && isPlainObject(context?.data)) resolved = getSafePathLocal(context.data, expr);
      return resolved === undefined ? '' : resolved;
    }
    return value.replace(/\{\{([\s\S]*?)\}\}/g, (_m, rawExpr) => {
      const expr = String(rawExpr || '').trim();
      let resolved = getSafePathLocal(context, expr);
      if (resolved === undefined && isPlainObject(context?.data)) resolved = getSafePathLocal(context.data, expr);
      if (resolved === undefined || resolved === null) return '';
      return typeof resolved === 'object' ? JSON.stringify(resolved) : String(resolved);
    });
  }
  if (Array.isArray(value)) return value.map((item) => interpolateLocal(item, context));
  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (!FORBIDDEN_AUTOMATION_KEYS.has(k)) out[k] = interpolateLocal(v, context);
    }
    return out;
  }
  return value;
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
  if (clean.filterJson !== undefined && clean.filterJson !== null && hasUnsafeAutomationTemplate(clean.filterJson)) {
    throw failTool('AUTOMATION_AI_REFUSED', 400, 'filterJson chứa template hoặc khóa bị cấm.');
  }
  const maxDepth = clean.maxDepth === undefined || clean.maxDepth === null ? 8 : Number(clean.maxDepth);
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 8) {
    throw failTool('AUTOMATION_RULE_INVALID', 400, 'maxDepth phải là số nguyên từ 1 đến 8.');
  }
  const cooldownSec = clean.cooldownSec === undefined || clean.cooldownSec === null ? 0 : Number(clean.cooldownSec);
  if (!Number.isInteger(cooldownSec) || cooldownSec < 0) {
    throw failTool('AUTOMATION_RULE_INVALID', 400, 'cooldownSec phải là số nguyên >= 0.');
  }
  return {
    ruleKey,
    name,
    description: clean.description ? String(clean.description) : null,
    triggerEventType: String(clean.triggerEventType || '*').trim() || '*',
    filterJson: clean.filterJson ? clonePlain(clean.filterJson) : null,
    dmnTableKey: clean.dmnTableKey ? String(clean.dmnTableKey).trim() : null,
    actionsJson: clonePlain(actionsJson),
    maxDepth,
    cooldownSec,
    active: clean.active === undefined ? true : Boolean(clean.active),
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
  if (!ruleObj.cooldownSec || ruleObj.cooldownSec === 0) {
    suggestions.push({
      id: 'add_cooldown',
      priority: 'high',
      targetNode: 'cooldown',
      title: 'Thêm thời gian chống lặp (cooldownSec = 120s)',
      description: 'Tránh tạo hàng loạt phiếu lặp lại khi cảm biến dao động quanh ngưỡng.',
      patch: { cooldownSec: 120 },
    });
  }
  if (!ruleObj.filterJson) {
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
  return draft;
}

function extractCopilotResult(res, failTool) {
  if (res && (res.refused === true || res.ok === false)) {
    throw failTool('AUTOMATION_AI_REFUSED', 400, res.error || res.reason || 'Yêu cầu Automation Copilot bị từ chối.');
  }
  return res || {};
}

async function callStudioCopilotIfAvailable(ctx, db, actor, mode, payload, deps) {
  const { failTool, hasRes } = deps;
  const copilotTargetNode = payload.targetNode === 'cooldown' || payload.targetNode === 'guard'
    ? 'trigger'
    : (payload.targetNode === 'actions' || payload.targetNode === 'step:new'
      ? 'step:append'
      : payload.targetNode);
  const copilotPayload = {
    ...payload,
    ...(copilotTargetNode ? { targetNode: copilotTargetNode, target: copilotTargetNode } : {}),
  };

  if (hasResourceAction(hasRes, ctx, 'dxosAutomations', 'aiAssist')) {
    try {
      const delegated = await invokeDxosAutomationsAction(ctx, db, actor, 'aiAssist', {
        ...copilotPayload,
        mode,
        organizationId: actor.organizationId,
        values: { ...copilotPayload, mode, organizationId: actor.organizationId },
        method: 'POST',
      }, deps);
      if (delegated.ok) {
        return { source: 'resource', data: extractCopilotResult(delegated.result, failTool) };
      }
    } catch (err) {
      if (err?.code === 'AUTOMATION_AI_REFUSED' || err?.code === 'AI_ASSIST_REFUSED') {
        throw failTool('AUTOMATION_AI_REFUSED', 400, err.message);
      }
      if (err?.status === 400 && /refus|unsafe|inject|system|forbidden|proto/i.test(String(err.message || ''))) {
        throw failTool('AUTOMATION_AI_REFUSED', 400, err.message);
      }
      throw err;
    }
  }

  const copilotMod = loadStudioAutomationCopilot();
  if (!copilotMod) return null;
  const fn = copilotMod.runAutomationAiAssist
    || copilotMod.assistAutomationRule
    || copilotMod.generateAutomationAssist
    || copilotMod.aiAssistAutomation
    || copilotMod.assistAutomation
    || copilotMod.aiAssist;
  if (typeof fn !== 'function') return null;

  try {
    let res;
    if (typeof copilotMod.buildAutomationBuilderCatalog === 'function' || fn.length <= 1) {
      const catalog = typeof copilotMod.buildAutomationBuilderCatalog === 'function'
        ? await copilotMod.buildAutomationBuilderCatalog(db, actor.organizationId)
        : undefined;
      res = await fn({
        mode,
        prompt: copilotPayload.prompt || copilotPayload.goal,
        rule: copilotPayload.rule,
        targetNode: copilotTargetNode,
        catalog,
      });
    } else {
      res = await fn(db, {
        ...copilotPayload,
        mode,
        organizationId: actor.organizationId,
        actor,
        ctx,
      });
    }
    return { source: 'module', data: extractCopilotResult(res, failTool) };
  } catch (err) {
    if (err?.code === 'AUTOMATION_AI_REFUSED') throw err;
    if (err?.status === 400 && /refus|unsafe|inject|system|forbidden|proto/i.test(String(err.message || ''))) {
      throw failTool('AUTOMATION_AI_REFUSED', 400, err.message);
    }
    throw err;
  }
}

/**
 * Analyze an automation rule (or tenant catalog) and return prioritized optimization suggestions.
 */
async function runSuggestAutomation(ctx, db, actor, args, deps) {
  const { val, failTool, SYSTEM_PROTECTED_COLLECTIONS } = deps;
  const goalText = String(args.goal || args.prompt || '').trim();
  const ruleKey = typeof args.ruleKey === 'string' && args.ruleKey.trim() ? args.ruleKey.trim() : null;
  const shouldApply = Boolean(args.apply && !args.dryRun);
  assertSafeAutomationInput(goalText, args.rule, args, failTool, SYSTEM_PROTECTED_COLLECTIONS);

  let targetRule = isPlainObject(args.rule)
    ? validateAndNormalizeRule(args.rule, failTool, SYSTEM_PROTECTED_COLLECTIONS)
    : null;
  if (ruleKey) {
    const loadedRule = await loadTenantAutomationRule(db, actor.organizationId, ruleKey, val, failTool);
    if (!targetRule) targetRule = loadedRule;
  }

  const copilotHit = await callStudioCopilotIfAvailable(ctx, db, actor, 'suggest', {
    prompt: goalText,
    goal: goalText,
    ...(ruleKey ? { ruleKey } : {}),
    ...(targetRule ? { rule: targetRule, currentRule: targetRule } : {}),
    apply: shouldApply,
  }, deps);

  if (copilotHit) {
    const data = copilotHit.data;
    let draftRule = data.draftRule || data.previewRule || data.rule || null;
    if (draftRule) {
      draftRule = validateAndNormalizeRule(draftRule, failTool, SYSTEM_PROTECTED_COLLECTIONS);
    }
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
      suggestions: Array.isArray(data.suggestions) ? data.suggestions : [],
      summary: data.summary || 'Đã phân tích rule và đề xuất tối ưu.',
      ...(draftRule ? { draftRule } : {}),
      ...(data.savedRule ? { rule: data.savedRule } : {}),
    };
  }

  if (!targetRule) {
    const rulesRepo = db?.getRepository?.('latticeAutomationRules');
    const rows = rulesRepo?.find
      ? ((await rulesRepo.find({ filter: { organizationId: actor.organizationId }, sort: ['id'], limit: 20 })) || [])
      : [];
    const scoped = rows.filter((r) => val(r, 'organizationId') === actor.organizationId);
    if (scoped.length) {
      targetRule = toPlainAutomationRule(scoped[0], val);
    }
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
          description: 'Dùng draftAutomation hoặc blueprint Chuỗi lạnh CMMS để tạo rule có DMN và cooldown.',
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
    ruleKey: targetRule.ruleKey || ruleKey,
    applied,
    ...(args.dryRun ? { dryRun: true } : {}),
    suggestions,
    summary: suggestions.length
      ? `Phát hiện ${suggestions.length} điểm có thể tối ưu cho rule "${targetRule.ruleKey || targetRule.name}".`
      : `Rule "${targetRule.ruleKey || targetRule.name}" đã đạt chuẩn guard, cooldown và phân nhánh.`,
    draftRule,
  };
}

/**
 * Draft a full branching automation rule from natural language and preview via dry-run simulation.
 */
async function runDraftAutomation(ctx, db, actor, args, deps) {
  const { val, failTool, SYSTEM_PROTECTED_COLLECTIONS } = deps;
  const goalText = String(args.goal || args.prompt || '').trim();
  const shouldApply = Boolean(args.apply && !args.dryRun);
  if (!goalText && !isPlainObject(args.rule)) {
    throw failTool('AUTOMATION_GOAL_REQUIRED', 400, 'Cần mô tả mục tiêu (goal/prompt) hoặc rule để phác thảo automation.');
  }
  assertSafeAutomationInput(goalText, args.rule, args, failTool, SYSTEM_PROTECTED_COLLECTIONS);

  const copilotHit = goalText
    ? await callStudioCopilotIfAvailable(ctx, db, actor, 'full', {
        prompt: goalText,
        goal: goalText,
        ...(args.ruleKey ? { ruleKey: args.ruleKey } : {}),
        ...(isPlainObject(args.rule) ? { rule: sanitizeAutomationValue(args.rule) } : {}),
        ...(isPlainObject(args.sampleEvent) ? { sampleEvent: sanitizeAutomationValue(args.sampleEvent) } : {}),
        apply: shouldApply,
      }, deps)
    : null;

  let draftRule = null;
  let simulation = null;
  let applied = false;
  let summary = null;

  let savedRule = null;
  if (copilotHit) {
    const data = copilotHit.data;
    draftRule = data.draftRule || data.previewRule || data.rule || null;
    simulation = data.simulation || null;
    applied = Boolean(data.applied || data.saved || data.savedRule);
    savedRule = data.savedRule || null;
    summary = data.summary || null;
    if (isPlainObject(data.sampleEvent) && !isPlainObject(args.sampleEvent)) {
      args = { ...args, sampleEvent: data.sampleEvent };
    }
  }

  if (!draftRule) {
    draftRule = isPlainObject(args.rule)
      ? validateAndNormalizeRule(args.rule, failTool, SYSTEM_PROTECTED_COLLECTIONS)
      : await draftRuleFromGoal(db, actor, args, val);
  } else {
    draftRule = validateAndNormalizeRule(draftRule, failTool, SYSTEM_PROTECTED_COLLECTIONS);
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

  return {
    operation: 'draftAutomation',
    organizationId: actor.organizationId,
    applied,
    ...(args.dryRun ? { dryRun: true } : {}),
    draftRule,
    ...(savedRule ? { rule: savedRule } : {}),
    sampleEvent,
    simulation,
    summary: summary || `Đã phác thảo rule "${draftRule.ruleKey}" (${draftRule.actionsJson.length} bước) và mô phỏng dry-run.`,
  };
}

/**
 * Surgically patch a specific part of an automation rule (trigger, filter, dmn, cooldown, or step:<idx>).
 */
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

  if (!isPlainObject(args.rule) && !ruleKey) {
    throw failTool('AUTOMATION_RULE_KEY_REQUIRED', 400, 'Cần ruleKey hoặc rule để vá (patch) automation.');
  }
  let baseRule = null;
  if (isPlainObject(args.rule)) {
    baseRule = validateAndNormalizeRule(args.rule, failTool, SYSTEM_PROTECTED_COLLECTIONS);
  } else {
    baseRule = await loadTenantAutomationRule(db, actor.organizationId, ruleKey, val, failTool);
  }

  const resolvedTarget = inferPatchTargetNode(goalText, args.targetNode, { cfgPatch, explicitTrigger });
  const shouldUseLocalPatcher = Boolean(cfgPatch || explicitTrigger);
  const copilotTargetNode = resolvedTarget === 'actions' || resolvedTarget === 'step:new'
    ? 'step:append'
    : resolvedTarget;

  const copilotHit = !shouldUseLocalPatcher
    ? await callStudioCopilotIfAvailable(ctx, db, actor, 'node', {
        prompt: goalText,
        goal: goalText,
        ruleKey: baseRule?.ruleKey || ruleKey,
        targetNode: copilotTargetNode,
        target: copilotTargetNode,
        ...(baseRule ? { rule: baseRule, currentRule: baseRule } : {}),
        apply: shouldApply,
      }, deps)
    : null;

  if (copilotHit) {
    const data = copilotHit.data;
    let draftRule = data.draftRule || data.previewRule || data.rule || baseRule;
    if (draftRule) {
      draftRule = validateAndNormalizeRule(draftRule, failTool, SYSTEM_PROTECTED_COLLECTIONS);
    }
    let applied = Boolean(data.applied || data.saved || data.savedRule);
    let savedRule = data.savedRule || null;
    if (shouldApply && !applied && draftRule) {
      savedRule = await saveTenantAutomationRule(ctx, db, actor, draftRule, deps);
      applied = true;
    }
    const summaryText = Array.isArray(data.diffSummary)
      ? data.diffSummary.join('; ')
      : (data.diffSummary || data.summary || `Đã vá node ${resolvedTarget} của rule "${draftRule?.ruleKey || ruleKey}".`);
    return {
      operation: 'patchAutomation',
      organizationId: actor.organizationId,
      ruleKey: draftRule?.ruleKey || ruleKey,
      targetNode: resolvedTarget === 'cooldown' ? 'cooldown' : (data.targetNode || resolvedTarget),
      applied,
      ...(args.dryRun ? { dryRun: true } : {}),
      patch: data.patch || { targetNode: resolvedTarget },
      diffSummary: summaryText,
      ...(draftRule ? { draftRule } : {}),
      ...(savedRule ? { rule: savedRule } : {}),
    };
  }

  if (!baseRule) {
    baseRule = await loadTenantAutomationRule(db, actor.organizationId, ruleKey, val, failTool);
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

  return {
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
  };
}

/**
 * Validate and upsert an automation rule scoped to actor.organizationId.
 */
async function runSaveAutomation(ctx, db, actor, args, deps) {
  const { failTool, SYSTEM_PROTECTED_COLLECTIONS } = deps;
  const rawCandidate = isPlainObject(args.rule) ? args.rule : (isPlainObject(args.config) ? args.config : null);
  assertSafeAutomationInput(String(args.goal || args.prompt || ''), rawCandidate, args, failTool, SYSTEM_PROTECTED_COLLECTIONS);
  const candidate = isPlainObject(args.rule)
    ? sanitizeAutomationValue(args.rule)
    : {
        ...(isPlainObject(args.config) ? sanitizeAutomationValue(args.config) : {}),
        ...(args.ruleKey ? { ruleKey: args.ruleKey } : {}),
        ...(args.title ? { name: args.title } : {}),
        ...(args.triggerEventType ? { triggerEventType: args.triggerEventType } : {}),
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
  return {
    applied: true,
    saved: true,
    operation: 'saveAutomation',
    organizationId: actor.organizationId,
    rule: saved,
  };
}

/**
 * Simulate an automation rule (including per-step `when` branches) against sampleEvent without mutating state.
 */
async function runTestAutomation(ctx, db, actor, args, deps) {
  const { val, failTool, SYSTEM_PROTECTED_COLLECTIONS } = deps;
  const ruleKey = typeof args.ruleKey === 'string' ? args.ruleKey.trim() : '';
  const goalText = String(args.goal || args.prompt || '').trim();
  assertSafeAutomationInput(goalText, args.rule, args, failTool, SYSTEM_PROTECTED_COLLECTIONS);

  let ruleObj = null;
  if (isPlainObject(args.rule)) {
    ruleObj = validateAndNormalizeRule(args.rule, failTool, SYSTEM_PROTECTED_COLLECTIONS);
  } else if (ruleKey) {
    ruleObj = await loadTenantAutomationRule(db, actor.organizationId, ruleKey, val, failTool);
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
  } else {
    throw failTool('AUTOMATION_RULE_KEY_REQUIRED', 400, 'Cần ruleKey, workflowId hoặc rule để chạy mô phỏng dry-run.');
  }

  const sampleEvent = isPlainObject(args.sampleEvent)
    ? sanitizeAutomationValue(args.sampleEvent)
    : (isPlainObject(args.config) ? sanitizeAutomationValue(args.config) : buildDefaultSampleEventForRule(ruleObj));

  const { simulation, stepTraces, executedSteps, skippedSteps } = await simulateRuleDryRun(ctx, db, actor, ruleObj, sampleEvent, deps);
  return {
    dryRun: true,
    operation: 'testAutomation',
    organizationId: actor.organizationId,
    ruleKey: ruleObj.ruleKey || null,
    matched: Boolean(simulation?.matched),
    status: simulation?.status || 'completed',
    stepTraces,
    executedSteps,
    skippedSteps,
    simulation,
  };
}

function createBuilderTools(deps) {
  const {
    val, failTool, safeGetResource, invokeResourceAction, createAuditedTool,
    resolveCallerRoleNames, isStudioAdmin,
    SYSTEM_PROTECTED_COLLECTIONS, CUSTOM_COLLECTION_RE, FIELD_NAME_RE, SLUG_RE, ALLOWED_BLOCK_MODELS,
  } = deps;
  const hasRes = (ctx, name) => (typeof safeGetResource === 'function' ? safeGetResource(ctx, name) : null);

  return [
    createAuditedTool({
      name: 'dxos_inspect_architecture',
      adminOnly: true,
      defaultPermission: 'ALLOW',
      introduction: { title: 'Inspect Kiến trúc LatticeDX', about: 'Đọc portals, pages, blocks, collections, workflows, roles và AI profiles đang chạy.' },
      description: 'Inspect live LatticeDX portals, desktop pages, collections, active workflows, roles, and customizable AI employee profiles (Admin only).',
      schema: {
        description: 'Optional portal filter for detailed layout inspection.',
        properties: { portalSlug: { type: 'string', description: 'Optional portal slug such as services or logistics.', maxLength: 40 } },
      },
      async run(_ctx, db, actor, args) {
        const safeFind = async (repoName, filter = {}, limit = 100) => {
          const repo = db?.getRepository?.(repoName);
          return repo ? (await repo.find({ filter, limit })) || [] : [];
        };
        const [layouts, routes, cols, wfs, roles, profiles] = await Promise.all([
          safeFind('uiLayouts', {}, 50),
          safeFind('desktopRoutes', {}, 250),
          safeFind('collections', {}, 150),
          safeFind('workflows', { current: true }, 80),
          safeFind('roles', {}, 50),
          safeFind('latticeAiProfiles', {}, 50),
        ]);
        const portals = layouts.filter((l) => String(val(l, 'uid') || '').startsWith('ldx-portal-')).map((l) => ({
          uid: val(l, 'uid'), title: val(l, 'title') || val(l, 'name'), routePath: val(l, 'routePath') || null,
        }));
        let focused = {};
        if (args.portalSlug && SLUG_RE.test(args.portalSlug)) {
          const resolved = await resolvePageGrid(db, args.portalSlug, null, val);
          const gridUids = resolved.grid ? extractGridBlockUids(resolved.grid).ordered : [];
          focused = {
            focusedPortal: args.portalSlug,
            targetPageTitle: val(resolved.pageRoute, 'title') || null,
            tabSchemaUid: resolved.tabSchemaUid,
            gridUid: resolved.grid?.uid || null,
            blockUids: gridUids,
          };
        }
        return {
          inspectedBy: actor.username,
          portalCount: portals.length,
          portals,
          pageCount: routes.filter((r) => ['page', 'flowPage'].includes(val(r, 'type'))).length,
          businessCollections: cols.map((c) => val(c, 'name')).filter((n) => String(n || '').startsWith('lattice')),
          activeWorkflows: wfs.map((w) => ({ id: val(w, 'id'), title: val(w, 'title'), type: val(w, 'type'), enabled: val(w, 'enabled') })),
          roleNames: roles.map((r) => val(r, 'name')),
          aiProfileCount: profiles.length,
          ...focused,
        };
      },
    }),

    createAuditedTool({
      name: 'dxos_compose_page_blocks',
      adminOnly: true,
      defaultPermission: 'ASK',
      introduction: { title: 'Dựng & Chỉnh Sâu Block DX-OS + Native', about: 'Inspect, dựng trang đa block, chèn block chuẩn/DX-OS vào trang đang mở, chia lưới nhiều cột, cấu hình cột/nút/luật liên kết và gỡ block.' },
      description: 'Inspect, build multi-block portal pages, add inline DX-OS or native flowSurfaces blocks onto existing page grids, set multi-column grid layouts, configure deep block fields/actions/rules, reorder, or remove blocks (Admin only; supports dryRun).',
      schema: {
        description: 'Full lifecycle page & block builder command (v3 with deep flowSurfaces + multi-column grid).',
        properties: {
          action: { type: 'string', default: 'addBlock', enum: ['addBlock', 'listBlocks', 'composePageBlueprint', 'updateBlock', 'reorderBlocks', 'setGridLayout', 'configureNativeBlock', 'removeBlock'] },
          portalSlug: { type: 'string', required: true, maxLength: 40, description: 'Target portal slug (e.g., services, cold-qa).' },
          pageTitle: { type: 'string', maxLength: 100, description: 'Optional page title filter when inspecting or editing blocks.' },
          groupTitle: { type: 'string', maxLength: 80, description: 'Menu group title for composePageBlueprint.' },
          blockUid: { type: 'string', maxLength: 80, description: 'Target block UID for updateBlock, configureNativeBlock, or removeBlock.' },
          blockUse: { type: 'string', enum: ALLOWED_BLOCK_MODELS, description: 'Block model class or formal flowSurfaces block key (table, kanban, chart, filterForm, etc.) for addBlock.' },
          title: { type: 'string', maxLength: 100, description: 'Block or page title.' },
          collection: { type: 'string', maxLength: 60, description: 'Collection name for native table/form/kanban/chart blocks.' },
          fields: { type: 'array', items: { type: 'string' }, description: 'Field names for inline addBlock.' },
          tableFields: { type: 'array', items: { type: 'string' }, description: 'Field names for NativeTableBlock in composePageBlueprint.' },
          includeCreateForm: { type: 'boolean', default: false, description: 'Include Native createForm block in composePageBlueprint.' },
          dxosBlocks: { type: 'array', items: { type: 'object' }, description: 'Array of { blockUse, title, config } DX-OS blocks to attach in composePageBlueprint.' },
          orderedBlockUids: { type: 'array', items: { type: 'string' }, description: 'Ordered array of block UIDs for reorderBlocks.' },
          placeBesideBlockUid: { type: 'string', maxLength: 80, description: 'Optional existing block UID to share a [12, 12] 2-column row on addBlock.' },
          rowsLayout: { type: 'array', items: { type: 'object' }, description: 'Multi-column row layout array for setGridLayout.' },
          surfaceAction: { type: 'string', enum: NATIVE_SURFACE_ACTIONS, description: 'Deep flowSurfaces action for configureNativeBlock.' },
          surfacePayload: { type: 'object', description: 'Payload for flowSurfaces action on configureNativeBlock.' },
          config: { type: 'object', description: 'Object overriding block config props.' },
          configJson: { type: 'string', maxLength: 4000, description: 'Optional JSON string overriding block config props.' },
          roleNames: { type: 'array', items: { type: 'string' }, description: 'Optional ldx_* roles to grant onto created page routes.' },
          dryRun: { type: 'boolean', default: false },
        },
      },
      async run(ctx, db, actor, args) {
        if (!SLUG_RE.test(args.portalSlug)) throw failTool('PORTAL_SLUG_INVALID', 400, 'Slug portal không hợp lệ.');
        const action = args.action || 'addBlock';
        let parsedConfig = args.config && typeof args.config === 'object' ? { ...args.config } : {};
        if (args.configJson) {
          try { parsedConfig = { ...parsedConfig, ...JSON.parse(args.configJson) }; }
          catch { throw failTool('CONFIG_JSON_INVALID', 400, 'configJson không phải JSON hợp lệ.'); }
        }

        if (action === 'listBlocks') {
          const { flowModelsRepo, pageRoute, tabSchemaUid, grid } = await resolvePageGrid(db, args.portalSlug, args.pageTitle, val);
          if (!grid) return { portalSlug: args.portalSlug, pageTitle: val(pageRoute, 'title') || null, blocks: [] };
          const { ordered, layout } = extractGridBlockUids(grid);
          const subMap = new Map((Array.isArray(grid?.subModels?.items) ? grid.subModels.items : []).map((m) => [m.uid, m]));
          const blocks = [];
          for (const uid of ordered) {
            const model = await hydrateFlowModel(flowModelsRepo, uid, subMap);
            blocks.push(readFlowModelMeta(model, uid));
          }
          return {
            portalSlug: args.portalSlug,
            pageTitle: val(pageRoute, 'title') || null,
            tabSchemaUid,
            gridUid: grid.uid,
            rows: layout.rows || {},
            sizes: layout.sizes || {},
            rowOrder: layout.rowOrder || [],
            blocks,
          };
        }

        if (action === 'updateBlock') {
          if (!args.blockUid) throw failTool('BLOCK_UID_REQUIRED', 400, 'Cần blockUid để cập nhật block.');
          const flowModelsRepo = db?.getRepository?.('flowModels');
          const model = await hydrateFlowModel(flowModelsRepo, args.blockUid, new Map());
          if (!model) throw failTool('BLOCK_NOT_FOUND', 404, `Không tìm thấy block "${args.blockUid}".`);
          const meta = readFlowModelMeta(model, args.blockUid);
          const nextConfig = { ...meta.props, ...(args.title ? { title: args.title } : {}), ...parsedConfig };
          if (args.dryRun) {
            return { dryRun: true, action, blockUid: args.blockUid, use: meta.use, beforeProps: meta.props, afterProps: nextConfig };
          }
          await capturePageSnapshot(db, { portalSlug: args.portalSlug, pageTitle: args.pageTitle, note: `Before updateBlock ${args.blockUid}`, createdByUsername: actor.username }, val);
          if (typeof flowModelsRepo.updateSingleNode === 'function') {
            await flowModelsRepo.updateSingleNode({
              uid: args.blockUid,
              props: nextConfig,
              stepParams: { ...meta.stepParams, dxosBlockSettings: { ...(meta.stepParams?.dxosBlockSettings || {}), config: nextConfig } },
            });
          } else if (typeof flowModelsRepo.upsertModel === 'function') {
            await flowModelsRepo.upsertModel({ ...model, props: nextConfig });
          }
          bumpSurfaceRevision(args.portalSlug, { pageTitle: args.pageTitle, lastMutatedUid: args.blockUid, message: `AI đã cập nhật block ${meta.title || args.blockUid}` });
          return { applied: true, updated: true, blockUid: args.blockUid, afterProps: nextConfig };
        }

        if (action === 'setGridLayout') {
          const { flowModelsRepo, pageRoute, grid } = await resolvePageGrid(db, args.portalSlug, args.pageTitle, val);
          if (!grid || !flowModelsRepo) throw failTool('PAGE_GRID_NOT_FOUND', 404, `Không tìm thấy grid trên portal "${args.portalSlug}".`);
          const nextLayout = computeMultiColumnGrid(args.rowsLayout, failTool);
          if (args.dryRun) return { dryRun: true, action, portalSlug: args.portalSlug, nextLayout };
          await capturePageSnapshot(db, { portalSlug: args.portalSlug, pageTitle: val(pageRoute, 'title') || args.pageTitle, note: 'Before setGridLayout', createdByUsername: actor.username }, val);
          if (hasRes(ctx, 'flowSurfaces')) {
            try {
              await invokeResourceAction(ctx, 'flowSurfaces', 'setLayout', { values: { target: { uid: grid.uid }, ...nextLayout } });
            } catch {
              await updateGridLayout(flowModelsRepo, grid, nextLayout);
            }
          } else {
            await updateGridLayout(flowModelsRepo, grid, nextLayout);
          }
          bumpSurfaceRevision(args.portalSlug, {
            pageTitle: val(pageRoute, 'title') || args.pageTitle,
            layoutSignature: computeLayoutSignature({ props: nextLayout }),
            message: 'AI đã sắp xếp lại bố cục đa cột trên trang',
          });
          return { applied: true, action, portalSlug: args.portalSlug, layout: nextLayout };
        }

        if (action === 'configureNativeBlock') {
          if (!args.blockUid) throw failTool('BLOCK_UID_REQUIRED', 400, 'Cần blockUid để cấu hình block.');
          if (!args.surfaceAction || !NATIVE_SURFACE_ACTIONS.includes(args.surfaceAction)) {
            throw failTool('SURFACE_ACTION_INVALID', 400, `Cần surfaceAction hợp lệ trong: ${NATIVE_SURFACE_ACTIONS.join(', ')}.`);
          }
          const payload = args.surfacePayload && typeof args.surfacePayload === 'object' ? args.surfacePayload : {};
          if (args.dryRun) return { dryRun: true, action, blockUid: args.blockUid, surfaceAction: args.surfaceAction, surfacePayload: payload };
          await capturePageSnapshot(db, { portalSlug: args.portalSlug, pageTitle: args.pageTitle, note: `Before ${args.surfaceAction} on ${args.blockUid}`, createdByUsername: actor.username }, val);
          const result = await invokeResourceAction(ctx, 'flowSurfaces', args.surfaceAction, {
            values: { target: { uid: args.blockUid }, ...payload },
          });
          bumpSurfaceRevision(args.portalSlug, { pageTitle: args.pageTitle, lastMutatedUid: args.blockUid, message: `AI đã cấu hình sâu block (${args.surfaceAction})` });
          return { applied: true, action, blockUid: args.blockUid, surfaceAction: args.surfaceAction, result };
        }

        if (action === 'reorderBlocks' || action === 'removeBlock') {
          const { flowModelsRepo, pageRoute, grid } = await resolvePageGrid(db, args.portalSlug, args.pageTitle, val);
          if (!grid || !flowModelsRepo) throw failTool('PAGE_GRID_NOT_FOUND', 404, `Không tìm thấy grid trên portal "${args.portalSlug}".`);
          const { ordered } = extractGridBlockUids(grid);
          let nextOrder;
          if (action === 'reorderBlocks') {
            const req = Array.isArray(args.orderedBlockUids) ? args.orderedBlockUids : [];
            nextOrder = [...req.filter((u) => ordered.includes(u)), ...ordered.filter((u) => !req.includes(u))];
          } else {
            if (!args.blockUid) throw failTool('BLOCK_UID_REQUIRED', 400, 'Cần blockUid để gỡ block.');
            nextOrder = ordered.filter((u) => u !== args.blockUid);
          }
          if (args.dryRun) return { dryRun: true, action, portalSlug: args.portalSlug, beforeOrder: ordered, afterOrder: nextOrder };
          await capturePageSnapshot(db, { portalSlug: args.portalSlug, pageTitle: val(pageRoute, 'title') || args.pageTitle, note: `Before ${action}`, createdByUsername: actor.username }, val);
          const nextLayout = normalizeGridState(grid, nextOrder);
          await updateGridLayout(flowModelsRepo, grid, nextLayout);
          if (action === 'removeBlock') {
            if (hasRes(ctx, 'flowSurfaces')) {
              try { await invokeResourceAction(ctx, 'flowSurfaces', 'removeNode', { values: { target: { uid: args.blockUid } } }); }
              catch {
                if (typeof flowModelsRepo.remove === 'function') await flowModelsRepo.remove(args.blockUid);
              }
            } else if (typeof flowModelsRepo.remove === 'function') {
              await flowModelsRepo.remove(args.blockUid);
            } else if (typeof flowModelsRepo.destroy === 'function') {
              await flowModelsRepo.destroy({ filter: { uid: args.blockUid } });
            }
          }
          bumpSurfaceRevision(args.portalSlug, { pageTitle: val(pageRoute, 'title') || args.pageTitle, blockCount: nextOrder.length, message: action === 'removeBlock' ? `AI đã gỡ block ${args.blockUid}` : 'AI đã sắp xếp lại thứ tự block' });
          return { applied: true, ...(action === 'reorderBlocks' ? { reordered: true } : { removed: true, blockUid: args.blockUid }), order: nextOrder };
        }

        if (action === 'composePageBlueprint') {
          const title = args.title || 'Trang Nghiệp vụ AI';
          const collection = args.collection || 'latticeServiceTickets';
          const fields = Array.isArray(args.tableFields) && args.tableFields.length ? args.tableFields : ['code', 'name', 'status'];
          const nativeBlocks = [{
            key: `ai-tbl-${args.portalSlug}-${Date.now().toString(36)}`,
            type: 'table',
            title,
            collection,
            fields,
            settings: { pageSize: 10 },
            actions: ['filter', 'refresh'],
          }];
          if (args.includeCreateForm) {
            nativeBlocks.push({
              key: `ai-frm-${args.portalSlug}-${Date.now().toString(36)}`,
              type: 'createForm',
              title: `Tạo mới — ${title}`,
              collection,
              fields: fields.filter((f) => f !== 'id' && f !== 'status'),
            });
          }
          const blueprint = {
            version: '1',
            mode: 'create',
            navigation: {
              layoutUid: `ldx-portal-${args.portalSlug}`,
              group: { title: args.groupTitle || title, icon: 'AppstoreAddOutlined' },
              item: { title, icon: 'DashboardOutlined' },
            },
            page: { title, displayTitle: true, enableTabs: false },
            tabs: [{ title, blocks: nativeBlocks }],
          };
          const dxosSpecs = Array.isArray(args.dxosBlocks) ? args.dxosBlocks : [];
          if (args.dryRun) {
            return { dryRun: true, action, portalSlug: args.portalSlug, previewBlueprint: blueprint, dxosBlocks: dxosSpecs };
          }
          const bpRes = await invokeResourceAction(ctx, 'flowSurfaces', 'applyBlueprint', { values: blueprint });
          const { flowModelsRepo, layoutUid, portalRoutes, pageRoute, tabSchemaUid, grid } = await resolvePageGrid(db, args.portalSlug, title, val);
          const createdRouteIds = [
            val(pageRoute, 'parentId'),
            val(pageRoute, 'id'),
            ...portalRoutes.filter((r) => String(val(r, 'parentId')) === String(val(pageRoute, 'id'))).map((r) => val(r, 'id')),
          ].filter((id) => id != null);
          await propagatePortalRolesToRoutes(db, layoutUid, createdRouteIds, args.roleNames, val);

          const attachedDxosBlocks = [];
          if (grid?.uid && flowModelsRepo?.upsertModel && dxosSpecs.length) {
            const prefix = `dxos-bp-${args.portalSlug}-${Date.now().toString(36)}`;
            const existingOrder = extractGridBlockUids(grid).ordered;
            const prepended = [];
            for (let i = 0; i < dxosSpecs.length; i++) {
              const spec = dxosSpecs[i];
              const useName = ALLOWED_BLOCK_MODELS.includes(spec?.blockUse) ? spec.blockUse : 'DxosKpiMetricBlockModel';
              const uid = `${prefix}-${i}`;
              const cfg = { title: spec?.title || title, ...(spec?.config || {}) };
              await flowModelsRepo.upsertModel({
                uid,
                use: useName,
                parentId: grid.uid,
                subKey: 'items',
                subType: 'array',
                props: cfg,
                stepParams: { dxosBlockSettings: { config: cfg } },
              });
              prepended.push(uid);
              attachedDxosBlocks.push({ uid, use: useName, title: cfg.title });
            }
            await updateGridLayout(flowModelsRepo, grid, normalizeGridState(grid, [...prepended, ...existingOrder]));
          }
          bumpSurfaceRevision(args.portalSlug, { pageTitle: title, message: `AI đã dựng trang đa block "${title}"` });
          return {
            applied: true,
            action,
            portalSlug: args.portalSlug,
            pageTitle: title,
            tabSchemaUid,
            attachedDxosBlocks,
            result: bpRes,
          };
        }

        // Default addBlock: inline onto EXISTING page grid for both DX-OS and NocoBase formal blocks
        if (!args.blockUse) throw failTool('BLOCK_USE_REQUIRED', 400, 'Cần blockUse để gắn block mới.');
        const title = args.title || args.blockUse;
        const collection = args.collection || 'latticeServiceTickets';
        const nativeType = NATIVE_BLOCK_ALIASES[args.blockUse] || args.blockUse;
        const resolved = await resolvePageGrid(db, args.portalSlug, args.pageTitle, val);
        const inlineFields = Array.isArray(args.fields) && args.fields.length ? args.fields : (Array.isArray(args.tableFields) && args.tableFields.length ? args.tableFields : ['code', 'name', 'status']);
        const blueprint = {
          version: '1',
          mode: 'create',
          navigation: { layoutUid: `ldx-portal-${args.portalSlug}`, group: { title: 'AI Mở rộng', icon: 'AppstoreAddOutlined' }, item: { title, icon: 'RobotOutlined' } },
          page: { title, displayTitle: true, enableTabs: false },
          tabs: [{ title, blocks: [{ key: `ai-${args.portalSlug}-${Date.now().toString(36)}`, type: nativeType.startsWith('Dxos') ? 'table' : nativeType, title, collection, fields: inlineFields }] }],
        };
        if (args.dryRun) {
          return { dryRun: true, portalSlug: args.portalSlug, blockUse: args.blockUse, nativeType, title, targetGridUid: resolved.grid?.uid || null, previewBlueprint: blueprint };
        }
        if (resolved.grid?.uid) {
          await capturePageSnapshot(db, { portalSlug: args.portalSlug, pageTitle: val(resolved.pageRoute, 'title') || args.pageTitle, note: `Before addBlock ${args.blockUse}`, createdByUsername: actor.username }, val);
          if (args.blockUse.startsWith('Dxos') && resolved.flowModelsRepo?.upsertModel) {
            const blockUid = `dxos-ai-${args.portalSlug}-${Date.now().toString(36)}`;
            const cfg = { title, ...parsedConfig };
            await resolved.flowModelsRepo.upsertModel({
              uid: blockUid,
              use: args.blockUse,
              parentId: resolved.grid.uid,
              subKey: 'items',
              subType: 'array',
              props: cfg,
              stepParams: { dxosBlockSettings: { config: cfg } },
            });
            const placed = await placeBesideOrInsertBlock(resolved.flowModelsRepo, resolved.grid, blockUid, args.placeBesideBlockUid, failTool);
            bumpSurfaceRevision(args.portalSlug, { pageTitle: val(resolved.pageRoute, 'title') || args.pageTitle, lastMutatedUid: blockUid, message: `AI đã gắn block "${title}"` });
            return { dryRun: false, applied: true, mode: 'flowModel', portalSlug: args.portalSlug, blockUid, blockUse: args.blockUse, sideBySideWith: placed.sideBySideWith };
          }
          if (hasRes(ctx, 'flowSurfaces')) {
            const needsResource = ['table', 'createForm', 'editForm', 'details', 'filterForm', 'kanban', 'chart', 'calendar', 'list', 'gridCard'].includes(nativeType);
            const fsPayload = {
              target: { uid: resolved.grid.uid },
              type: nativeType,
              title,
              ...(needsResource ? { resource: { binding: 'currentCollection', dataSourceKey: 'main', collectionName: collection }, fields: inlineFields } : {}),
              ...(Object.keys(parsedConfig).length ? { settings: parsedConfig } : {}),
            };
            const fsRes = await invokeResourceAction(ctx, 'flowSurfaces', 'addBlock', { values: fsPayload });
            const newUid = fsRes?.uid || fsRes?.data?.uid || null;
            if (newUid && args.placeBesideBlockUid) {
              const refreshed = await resolvePageGrid(db, args.portalSlug, args.pageTitle, val);
              if (refreshed.grid) await placeBesideOrInsertBlock(resolved.flowModelsRepo, refreshed.grid, newUid, args.placeBesideBlockUid, failTool);
            }
            bumpSurfaceRevision(args.portalSlug, { pageTitle: val(resolved.pageRoute, 'title') || args.pageTitle, lastMutatedUid: newUid, message: `AI đã gắn block chuẩn "${title}" (${nativeType})` });
            return { dryRun: false, applied: true, mode: 'flowSurfaces:addBlock', portalSlug: args.portalSlug, blockUid: newUid, blockUse: nativeType, result: fsRes };
          }
        }
        const bpResult = await invokeResourceAction(ctx, 'flowSurfaces', 'applyBlueprint', { values: blueprint });
        bumpSurfaceRevision(args.portalSlug, { pageTitle: title, message: `AI đã tạo trang block "${title}"` });
        return { dryRun: false, applied: true, mode: 'applyBlueprint', portalSlug: args.portalSlug, blockUse: args.blockUse, result: bpResult };
      },
    }),

    createAuditedTool({
      name: 'dxos_manage_portal_and_acl',
      adminOnly: true,
      defaultPermission: 'ASK',
      introduction: { title: 'Quản trị Portal & Phân quyền Menu', about: 'Tạo/cập nhật Portal /p/* và thêm hoặc thu hồi quyền menu cho các vai trò ldx_*.' },
      description: 'Create/update a LatticeDX multi-portal layout (/p/<slug>) and grant or revoke desktop route visibility for ldx_* roles (Admin only).',
      schema: {
        description: 'Portal metadata & role binding input.',
        properties: {
          operation: { type: 'string', default: 'grant', enum: ['grant', 'revoke'] },
          slug: { type: 'string', required: true, maxLength: 40 },
          title: { type: 'string', maxLength: 100 },
          roleNames: { type: 'array', items: { type: 'string' }, description: 'Target ldx_* role names.' },
          dryRun: { type: 'boolean', default: false },
        },
      },
      async run(ctx, db, _actor, args) {
        if (!SLUG_RE.test(args.slug)) throw failTool('PORTAL_SLUG_INVALID', 400, 'Slug portal không hợp lệ.');
        const operation = args.operation || 'grant';
        const layoutUid = `ldx-portal-${args.slug}`;
        const safeRoles = (args.roleNames || (operation === 'grant' ? ['ldx_employee', 'ldx_manager'] : [])).filter((r) => LDX_ROLE_RE.test(r));
        const title = args.title || `Portal ${args.slug}`;
        if (args.dryRun) {
          return { dryRun: true, operation, layoutUid, path: `/p/${args.slug}`, title, roleNames: safeRoles };
        }

        const layoutsRepo = db.getRepository('uiLayouts');
        const existed = layoutsRepo ? await layoutsRepo.findOne({ filter: { uid: layoutUid } }) : null;
        const { routes, links } = await collectPortalRouteSet(db, args.slug);
        const portalRoutes = resolvePortalRoutes(routes, links, layoutUid, val);
        const portalRouteIds = portalRoutes.map((r) => val(r, 'id')).filter((id) => id != null);

        const rolesRoutesRepo = db.getRepository('rolesDesktopRoutes');
        if (operation === 'revoke') {
          if (rolesRoutesRepo && portalRouteIds.length && safeRoles.length) {
            await rolesRoutesRepo.destroy({ filter: { desktopRouteId: { $in: portalRouteIds }, roleName: { $in: safeRoles } } });
          }
          return { applied: true, operation: 'revoke', layoutUid, path: `/p/${args.slug}`, revokedRoles: safeRoles, routeCount: portalRouteIds.length };
        }

        const latticePortalsRes = hasRes(ctx, 'latticePortals');
        if (latticePortalsRes) {
          let existingRoles = [];
          if (rolesRoutesRepo && portalRouteIds.length) {
            const grants = (await rolesRoutesRepo.find({ filter: { desktopRouteId: { $in: portalRouteIds } }, limit: 400 })) || [];
            existingRoles = grants.map((g) => val(g, 'roleName')).filter((r) => LDX_ROLE_RE.test(r));
          }
          const mergedRoles = [...new Set([...existingRoles, ...safeRoles])];
          const saved = await invokeResourceAction(ctx, 'latticePortals', 'save', {
            values: {
              ...(existed ? { uid: layoutUid } : {}),
              slug: args.slug,
              title,
              layoutType: 'desktop',
              enabled: true,
              roles: mergedRoles,
            },
          });
          await propagatePortalRolesToRoutes(db, layoutUid, portalRouteIds, mergedRoles, val);
          return { applied: true, operation: 'grant', layoutUid, path: `/p/${args.slug}`, assignedRoles: mergedRoles, portal: saved };
        }

        if (layoutsRepo) {
          if (existed && typeof existed.update === 'function') await existed.update({ title });
          else await layoutsRepo.create({ values: { uid: layoutUid, title, layoutType: 'desktop', routeName: `p_${args.slug.replace(/-/g, '_')}`, routePath: `/p/${args.slug}`, authCheck: true, enabled: true } });
        }
        const routesRepo = db.getRepository('desktopRoutes');
        const linksRepo = db.getRepository('desktopRoutesUiLayouts');
        if (routesRepo && !portalRouteIds.length) {
          const groupRoute = await routesRepo.create({ values: { title, type: 'group', hideInMenu: false } });
          const gid = val(groupRoute, 'id');
          if (gid != null) {
            portalRouteIds.push(gid);
            if (linksRepo) await linksRepo.create({ values: { desktopRouteId: gid, uiLayoutUid: layoutUid } });
          }
        }
        await propagatePortalRolesToRoutes(db, layoutUid, portalRouteIds, safeRoles, val);
        return { applied: true, operation: 'grant', layoutUid, path: `/p/${args.slug}`, assignedRoles: safeRoles };
      },
    }),

    createAuditedTool({
      name: 'dxos_extend_collection_schema',
      adminOnly: true,
      defaultPermission: 'ASK',
      introduction: { title: 'Mở rộng Bảng & Trường Dữ liệu', about: 'Inspect, tạo mới collection nghiệp vụ latticeCustom* hoặc thêm trường (string/number/select/boolean/date).' },
      description: 'Inspect or create custom collection (latticeCustom*) or add typed/select fields to business collections (Admin only; blocks system tables).',
      schema: {
        description: 'Schema extension definition.',
        properties: {
          operation: { type: 'string', enum: ['createCollection', 'addFields', 'inspectCollection'], required: true },
          collectionName: { type: 'string', required: true, maxLength: 60 },
          title: { type: 'string', maxLength: 100 },
          fields: { type: 'array', items: { type: 'object' }, description: 'Field definitions ({ name, type, title, enumValues }).' },
          dryRun: { type: 'boolean', default: false },
        },
      },
      async run(_ctx, db, actor, args) {
        if (SYSTEM_PROTECTED_COLLECTIONS.has(args.collectionName)) {
          throw failTool('SYSTEM_COLLECTION_FORBIDDEN', 403, `Không được phép sửa bảng hệ thống "${args.collectionName}".`);
        }
        const colsRepo = db.getRepository('collections');
        if (args.operation === 'inspectCollection') {
          const existing = colsRepo ? await colsRepo.findOne({ filter: { name: args.collectionName }, appends: ['fields'] }) : null;
          const liveCol = db.getCollection?.(args.collectionName);
          const dbFields = Array.isArray(val(existing, 'fields')) ? val(existing, 'fields').map((f) => ({ name: val(f, 'name'), type: val(f, 'type') })) : [];
          return {
            collectionName: args.collectionName,
            exists: Boolean(existing || liveCol),
            title: val(existing, 'title') || liveCol?.options?.title || args.collectionName,
            fields: dbFields,
          };
        }
        if (args.operation === 'createCollection' && !CUSTOM_COLLECTION_RE.test(args.collectionName)) {
          throw failTool('COLLECTION_NAME_INVALID', 400, 'Collection mới phải theo mẫu latticeCustom<TenVietHoa>.');
        }
        const rawFields = Array.isArray(args.fields) ? args.fields : [];
        if (!rawFields.length) throw failTool('FIELDS_REQUIRED', 400, 'Cần ít nhất 1 trường dữ liệu trong fields.');
        const normalizedFields = rawFields.map((f) => buildFieldDefinition(f, failTool, FIELD_NAME_RE));
        if (args.operation === 'createCollection') {
          const has = (n) => normalizedFields.some((f) => f.name === n);
          if (!has('status')) normalizedFields.unshift({ name: 'status', type: 'string', interface: 'input', defaultValue: 'draft', uiSchema: { type: 'string', title: 'Trạng thái' } });
          if (!has('name')) normalizedFields.unshift({ name: 'name', type: 'string', interface: 'input', uiSchema: { type: 'string', title: 'Tên hồ sơ' } });
          if (!has('code')) normalizedFields.unshift({ name: 'code', type: 'string', interface: 'input', uiSchema: { type: 'string', title: 'Mã hồ sơ' } });
          if (!has('organizationId')) {
            normalizedFields.unshift({ name: 'organizationId', type: 'string', interface: 'input', allowNull: false, defaultValue: actor.organizationId, uiSchema: { type: 'string', title: 'Mã tổ chức' } });
          }
        }
        if (args.dryRun) return { dryRun: true, operation: args.operation, collectionName: args.collectionName, fields: normalizedFields };
        if (!colsRepo) throw failTool('SCHEMA_REPO_UNAVAILABLE', 503, 'Repository collections chưa sẵn sàng.');

        if (args.operation === 'createCollection') {
          const existing = await colsRepo.findOne({ filter: { name: args.collectionName }, appends: ['fields'] });
          if (existing) {
            if (typeof existing.load === 'function') await existing.load({ resetFields: true });
            return { created: false, alreadyExists: true, collectionName: args.collectionName };
          }
          const created = await colsRepo.create({
            values: {
              name: args.collectionName,
              title: args.title || args.collectionName,
              autoGenId: true,
              createdAt: true,
              updatedAt: true,
              options: { titleField: 'name', uiManageable: true },
              fields: normalizedFields,
            },
          });
          if (typeof created?.load === 'function') await created.load({ resetFields: true });
          const colInst = db.getCollection?.(args.collectionName);
          if (colInst && typeof colInst.sync === 'function') await colInst.sync({ force: false, alter: { drop: false } });
          else if (typeof db.sync === 'function') await db.sync();
          const createdIndexes = [];
          if (typeof db?.sequelize?.query === 'function' && CUSTOM_COLLECTION_RE.test(args.collectionName)) {
            const colLower = args.collectionName.toLowerCase();
            const idxOrg = buildSafePgIndexName(colLower, 'org');
            const idxOrgStatus = buildSafePgIndexName(colLower, 'org_status');
            try {
              await db.sequelize.query(`CREATE INDEX IF NOT EXISTS "${idxOrg}" ON "${args.collectionName}" ("organizationId");`);
              createdIndexes.push(idxOrg);
              await db.sequelize.query(`CREATE INDEX IF NOT EXISTS "${idxOrgStatus}" ON "${args.collectionName}" ("organizationId", "status");`);
              createdIndexes.push(idxOrgStatus);
            } catch {
              // Non-fatal in mock test harnesses without physical SQL tables
            }
          }
          if (typeof db?.attachLatticeRlsPolicy === 'function' && CUSTOM_COLLECTION_RE.test(args.collectionName)) {
            try {
              await db.attachLatticeRlsPolicy(args.collectionName);
            } catch {
              // Non-fatal in mock test harnesses without physical SQL tables
            }
          }
          return { created: true, collectionName: args.collectionName, fieldCount: normalizedFields.length, fields: normalizedFields.map((f) => f.name), indexes: createdIndexes };
        }

        const fieldsRepo = db.getRepository('fields');
        if (!fieldsRepo) throw failTool('FIELDS_REPO_UNAVAILABLE', 503, 'Repository fields chưa sẵn sàng.');
        for (const f of normalizedFields) {
          const cf = await fieldsRepo.create({ values: { ...f, collectionName: args.collectionName } });
          if (typeof cf?.load === 'function') await cf.load();
        }
        const parentCol = await colsRepo.findOne({ filter: { name: args.collectionName }, appends: ['fields'] });
        if (typeof parentCol?.load === 'function') await parentCol.load({ resetFields: true });
        const colInst = db.getCollection?.(args.collectionName);
        if (colInst && typeof colInst.sync === 'function') await colInst.sync({ force: false, alter: { drop: false } });
        else if (typeof db.sync === 'function') await db.sync();
        if (
          typeof db?.attachLatticeRlsPolicy === 'function' &&
          CUSTOM_COLLECTION_RE.test(args.collectionName) &&
          normalizedFields.some((f) => f.name === 'organizationId')
        ) {
          try {
            await db.attachLatticeRlsPolicy(args.collectionName);
          } catch {
            // Non-fatal in mock test harnesses without physical SQL tables
          }
        }
        return { updated: true, collectionName: args.collectionName, addedFields: normalizedFields.map((f) => f.name) };
      },
    }),

    createAuditedTool({
      name: 'dxos_manage_rbac_permissions',
      adminOnly: true,
      defaultPermission: 'ASK',
      introduction: { title: 'Quản trị Ma trận Phân quyền RBAC', about: 'Thêm/sửa/thu hồi quyền bảng, hành động, scope dữ liệu và khóa từng trường cho vai trò ldx_*.' },
      description: 'Inspect/create ldx_* roles and grant, field-lock, or revoke granular collection/action/scope RBAC rules via dataSourcesRolesResources (Admin only; root/admin & system tables forbidden).',
      schema: {
        description: 'Granular RBAC permission operation.',
        properties: {
          operation: { type: 'string', required: true, enum: ['inspectRole', 'ensureCustomRole', 'grantResource', 'lockFields', 'revokeResource'] },
          roleName: { type: 'string', required: true, maxLength: 50, description: 'Must match ^ldx_[a-z][a-z0-9_]{1,40}$.' },
          title: { type: 'string', maxLength: 100, description: 'Display title for ensureCustomRole.' },
          cloneFromRole: { type: 'string', maxLength: 50, description: 'Optional source ldx_* role when cloning.' },
          collectionName: { type: 'string', maxLength: 60 },
          actions: { type: 'array', items: { type: 'string' }, description: 'Actions among view, create, update, destroy, export.' },
          readableFields: { type: 'array', items: { type: 'string' }, description: 'Fields allowed for view action.' },
          writableFields: { type: 'array', items: { type: 'string' }, description: 'Fields allowed for create/update before lockedFields filtering.' },
          lockedFields: { type: 'array', items: { type: 'string' }, description: 'Fields strictly stripped from create/update actions.' },
          hideLockedFromView: { type: 'boolean', default: false },
          scopeMode: { type: 'string', default: 'all_in_org', enum: ['all_in_org', 'own', 'own_draft'] },
          dryRun: { type: 'boolean', default: false },
        },
      },
      async run(ctx, db, _actor, args) {
        if (!LDX_ROLE_RE.test(args.roleName || '')) {
          throw failTool('ROLE_TARGET_FORBIDDEN', 403, `Chỉ được phép cấu hình vai trò theo mẫu ldx_*; từ chối "${args.roleName}".`);
        }
        if (args.collectionName && SYSTEM_PROTECTED_COLLECTIONS.has(args.collectionName)) {
          throw failTool('SYSTEM_COLLECTION_FORBIDDEN', 403, `Không được thay đổi phân quyền bảng hệ thống "${args.collectionName}".`);
        }

        const rolesRepo = db.getRepository('roles');
        const dsRolesRepo = db.getRepository('dataSourcesRoles');
        const resourcesRepo = db.getRepository('dataSourcesRolesResources');
        const rolesRoutesRepo = db.getRepository('rolesDesktopRoutes');

        if (args.operation === 'inspectRole') {
          const role = rolesRepo ? await rolesRepo.findOne({ filter: { name: args.roleName } }) : null;
          const resList = resourcesRepo ? ((await resourcesRepo.find({ filter: { roleName: args.roleName, dataSourceKey: 'main' }, appends: ['actions'], limit: 100 })) || []) : [];
          const routeCount = rolesRoutesRepo && typeof rolesRoutesRepo.count === 'function' ? await rolesRoutesRepo.count({ filter: { roleName: args.roleName } }) : 0;
          return {
            roleName: args.roleName,
            exists: Boolean(role),
            title: val(role, 'title') || null,
            routeCount,
            resources: resList.map((r) => ({
              collectionName: val(r, 'name'),
              usingActionsConfig: val(r, 'usingActionsConfig'),
              actions: (val(r, 'actions') || []).map((a) => ({ name: val(a, 'name'), fields: val(a, 'fields') || [], hasScope: Boolean(val(a, 'scope') || val(a, 'scopeId')) })),
            })),
          };
        }

        if (args.dryRun) {
          return { dryRun: true, operation: args.operation, roleName: args.roleName, collectionName: args.collectionName || null, actions: args.actions || null, lockedFields: args.lockedFields || [] };
        }

        if (args.operation === 'ensureCustomRole') {
          let role = rolesRepo ? await rolesRepo.findOne({ filter: { name: args.roleName } }) : null;
          const values = {
            name: args.roleName,
            title: args.title || `Lattice — ${args.roleName}`,
            allowConfigure: false,
            allowNewMenu: false,
            allowNewAiEmployee: false,
            strategy: { actions: [] },
            snippets: [],
          };
          if (rolesRepo) {
            if (role && typeof role.update === 'function') await role.update({ title: values.title });
            else role = await rolesRepo.create({ values });
          }
          if (args.cloneFromRole && LDX_ROLE_RE.test(args.cloneFromRole)) {
            if (resourcesRepo) {
              const srcRes = (await resourcesRepo.find({ filter: { roleName: args.cloneFromRole, dataSourceKey: 'main' }, appends: ['actions'], limit: 100 })) || [];
              if (dsRolesRepo && !(await dsRolesRepo.findOne({ filter: { roleName: args.roleName, dataSourceKey: 'main' } }))) {
                await dsRolesRepo.create({ values: { roleName: args.roleName, dataSourceKey: 'main' } });
              }
              for (const sr of srcRes) {
                const cname = val(sr, 'name');
                if (cname && !(await resourcesRepo.findOne({ filter: { roleName: args.roleName, dataSourceKey: 'main', name: cname } }))) {
                  const clonedActions = (val(sr, 'actions') || []).map((a) => ({
                    name: val(a, 'name'),
                    ...(val(a, 'fields') ? { fields: [...val(a, 'fields')] } : {}),
                    ...(val(a, 'scope') ? { scope: val(a, 'scope') } : {}),
                    ...(val(a, 'scopeId') != null ? { scopeId: val(a, 'scopeId') } : {}),
                  }));
                  await resourcesRepo.create({ values: { roleName: args.roleName, dataSourceKey: 'main', name: cname, usingActionsConfig: true, actions: clonedActions } });
                }
              }
            }
            if (rolesRoutesRepo) {
              const srcRoutes = (await rolesRoutesRepo.find({ filter: { roleName: args.cloneFromRole }, limit: 200 })) || [];
              for (const sr of srcRoutes) {
                const rid = val(sr, 'desktopRouteId');
                if (rid != null && !(await rolesRoutesRepo.findOne({ filter: { roleName: args.roleName, desktopRouteId: rid } }))) {
                  await rolesRoutesRepo.create({ values: { roleName: args.roleName, desktopRouteId: rid } });
                }
              }
            }
          }
          return { applied: true, ensured: true, roleName: args.roleName, title: values.title, clonedFrom: args.cloneFromRole || null };
        }

        if (!args.collectionName) throw failTool('COLLECTION_NAME_REQUIRED', 400, 'Cần collectionName để cấu hình quyền bảng.');
        if (!resourcesRepo) throw failTool('RBAC_REPO_UNAVAILABLE', 503, 'Repository dataSourcesRolesResources chưa sẵn sàng.');

        if (args.operation === 'revokeResource') {
          const existing = await resourcesRepo.findOne({ filter: { roleName: args.roleName, dataSourceKey: 'main', name: args.collectionName }, appends: ['actions'] });
          if (!existing) return { applied: true, revoked: false, reason: 'Không tồn tại bản ghi quyền để thu hồi.' };
          const toRevoke = Array.isArray(args.actions) && args.actions.length ? new Set(args.actions) : null;
          if (!toRevoke) {
            await resourcesRepo.destroy({ filter: { roleName: args.roleName, dataSourceKey: 'main', name: args.collectionName } });
            ctx?.app?.dataSourceManager?.dataSources?.get?.('main')?.acl?.getRole?.(args.roleName)?.revokeResource?.(args.collectionName);
            ctx?.app?.acl?.getRole?.(args.roleName)?.revokeResource?.(args.collectionName);
            return { applied: true, revoked: true, revokedAll: true, roleName: args.roleName, collectionName: args.collectionName };
          }
          const remainingActions = (val(existing, 'actions') || []).map((a) => ({
            name: val(a, 'name'),
            ...(val(a, 'fields') ? { fields: [...val(a, 'fields')] } : {}),
            ...(val(a, 'scope') ? { scope: val(a, 'scope') } : {}),
            ...(val(a, 'scopeId') != null ? { scopeId: val(a, 'scopeId') } : {}),
          })).filter((a) => !toRevoke.has(a.name));
          let savedModel = existing;
          if (typeof resourcesRepo.update === 'function') {
            const updated = await resourcesRepo.update({
              filter: { roleName: args.roleName, dataSourceKey: 'main', name: args.collectionName },
              values: { usingActionsConfig: true, actions: remainingActions },
              updateAssociationValues: ['actions'],
            });
            savedModel = (Array.isArray(updated) ? updated[0] : updated) || existing;
          } else {
            await existing.update({ actions: remainingActions });
          }
          if (typeof savedModel?.writeToACL === 'function') {
            const dsAcl = ctx?.app?.dataSourceManager?.dataSources?.get?.('main')?.acl || ctx?.app?.acl;
            if (dsAcl) await savedModel.writeToACL({ acl: dsAcl });
          }
          return { applied: true, revoked: true, revokedActions: [...toRevoke], remainingActions: remainingActions.map((a) => a.name) };
        }

        if (args.operation === 'lockFields') {
          const existing = await resourcesRepo.findOne({ filter: { roleName: args.roleName, dataSourceKey: 'main', name: args.collectionName }, appends: ['actions'] });
          if (!existing) throw failTool('RBAC_GRANT_NOT_FOUND', 404, `Vai trò ${args.roleName} chưa có quyền trên ${args.collectionName}.`);
          const locks = new Set(args.lockedFields || []);
          const nextActions = (val(existing, 'actions') || []).map((a) => {
            const actName = val(a, 'name');
            const origFields = Array.isArray(val(a, 'fields')) ? [...val(a, 'fields')] : null;
            const shouldFilter = ['create', 'update'].includes(actName) || (args.hideLockedFromView && actName === 'view');
            const filtered = origFields && shouldFilter ? origFields.filter((f) => !locks.has(f)) : origFields;
            const scope = val(a, 'scope');
            const scopeId = val(a, 'scopeId');
            return {
              name: actName,
              ...(filtered ? { fields: filtered } : {}),
              ...(scope ? { scope } : {}),
              ...(scopeId != null ? { scopeId } : {}),
            };
          });
          let savedModel = existing;
          if (typeof resourcesRepo.update === 'function') {
            const updated = await resourcesRepo.update({
              filter: { roleName: args.roleName, dataSourceKey: 'main', name: args.collectionName },
              values: { usingActionsConfig: true, actions: nextActions },
              updateAssociationValues: ['actions'],
            });
            savedModel = (Array.isArray(updated) ? updated[0] : updated) || existing;
          } else {
            await existing.update({ actions: nextActions });
          }
          if (typeof savedModel?.writeToACL === 'function') {
            const dsAcl = ctx?.app?.dataSourceManager?.dataSources?.get?.('main')?.acl || ctx?.app?.acl;
            if (dsAcl) await savedModel.writeToACL({ acl: dsAcl });
          }
          return { applied: true, locked: true, roleName: args.roleName, collectionName: args.collectionName, lockedFields: [...locks] };
        }

        // grantResource
        const actionsList = Array.isArray(args.actions) && args.actions.length ? args.actions : ['view'];
        const actionsSpec = buildRbacActionsSpec({
          actions: actionsList,
          readableFields: args.readableFields,
          writableFields: args.writableFields,
          lockedFields: args.lockedFields,
          scopeMode: args.scopeMode || 'all_in_org',
          collectionName: args.collectionName,
          db,
        });
        if (dsRolesRepo && !(await dsRolesRepo.findOne({ filter: { roleName: args.roleName, dataSourceKey: 'main' } }))) {
          await dsRolesRepo.create({ values: { roleName: args.roleName, dataSourceKey: 'main' } });
        }
        const existingGrant = await resourcesRepo.findOne({ filter: { roleName: args.roleName, dataSourceKey: 'main', name: args.collectionName } });
        let savedModel = null;
        if (existingGrant && typeof resourcesRepo.update === 'function') {
          const updated = await resourcesRepo.update({
            filter: { roleName: args.roleName, dataSourceKey: 'main', name: args.collectionName },
            values: { usingActionsConfig: true, actions: actionsSpec },
            updateAssociationValues: ['actions'],
          });
          savedModel = Array.isArray(updated) ? updated[0] : existingGrant;
        } else if (existingGrant) {
          savedModel = await existingGrant.update({ usingActionsConfig: true, actions: actionsSpec });
        } else {
          savedModel = await resourcesRepo.create({
            values: { roleName: args.roleName, dataSourceKey: 'main', name: args.collectionName, usingActionsConfig: true, actions: actionsSpec },
          });
        }
        if (typeof savedModel?.writeToACL === 'function') {
          const dsAcl = ctx?.app?.dataSourceManager?.dataSources?.get?.('main')?.acl || ctx?.app?.acl;
          if (dsAcl) await savedModel.writeToACL({ acl: dsAcl });
        }
        return {
          applied: true,
          roleName: args.roleName,
          collectionName: args.collectionName,
          actions: actionsSpec.map((a) => ({ name: a.name, fields: a.fields || [] })),
        };
      },
    }),

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
      introduction: { title: 'Kỹ sư Workflow & Automation Copilot', about: 'Đọc/chỉnh đồ thị workflow, liệt kê/chạy và gợi ý tối ưu, thiết kế trọn luồng, vá từng node, mô phỏng rẽ nhánh và lưu Native Automations.' },
      description: 'Inspect workflow flow_nodes graphs, update node configs, add nodes, build custom collection workflows, toggle enabled state, and list, run, suggest, draft, patch, save, or dry-run test native DMN automations (Admin only).',
      schema: {
        description: 'Workflow graph engineering and Native Automation operation.',
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
            ],
          },
          workflowId: { type: 'integer' },
          titleQuery: { type: 'string', maxLength: 100 },
          title: { type: 'string', maxLength: 120 },
          collectionName: { type: 'string', maxLength: 60 },
          triggerMode: { type: 'integer', default: 1 },
          nodeId: { type: 'integer' },
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
        if (args.operation === 'listAutomations') {
          return runListAutomations(ctx, db, actor, args, automationDeps);
        }
        if (args.operation === 'runAutomation') {
          return runAutomationExecution(ctx, db, actor, args, automationDeps);
        }
        if (args.operation === 'suggestAutomation') {
          return runSuggestAutomation(ctx, db, actor, args, automationDeps);
        }
        if (args.operation === 'draftAutomation') {
          return runDraftAutomation(ctx, db, actor, args, automationDeps);
        }
        if (args.operation === 'patchAutomation') {
          return runPatchAutomation(ctx, db, actor, args, automationDeps);
        }
        if (args.operation === 'saveAutomation') {
          return runSaveAutomation(ctx, db, actor, args, automationDeps);
        }
        if (args.operation === 'testAutomation') {
          return runTestAutomation(ctx, db, actor, args, automationDeps);
        }

        const wfRepo = db.getRepository('workflows');
        const nodeRepo = db.getRepository('flow_nodes');
        if (!wfRepo || !nodeRepo) throw failTool('WORKFLOW_ENGINE_UNAVAILABLE', 503, 'Workflow/flow_nodes repository unavailable.');

        if (args.operation === 'inspectWorkflow') {
          let wf = args.workflowId ? await wfRepo.findOne({ filterByTk: args.workflowId }) : null;
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
          let node = args.nodeId ? await nodeRepo.findOne({ filterByTk: args.nodeId }) : null;
          if (!node && args.workflowId && args.nodeKey) {
            node = await nodeRepo.findOne({ filter: { workflowId: args.workflowId, key: args.nodeKey } });
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
          if (!args.workflowId || !args.nodeType) throw failTool('WORKFLOW_NODE_ARGS_REQUIRED', 400, 'Cần workflowId và nodeType.');
          const key = args.nodeKey || `dxos_${args.nodeType}_${Date.now().toString(36)}`;
          if (args.dryRun) return { dryRun: true, workflowId: args.workflowId, nodeType: args.nodeType, key, upstreamNodeId: args.upstreamNodeId || null };
          const up = args.upstreamNodeId ? await nodeRepo.findOne({ filterByTk: args.upstreamNodeId }) : null;
          const prevDownstreamId = up ? val(up, 'downstreamId') ?? null : null;
          const created = await nodeRepo.create({
            values: {
              workflowId: args.workflowId,
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
          if (!args.workflowId) throw failTool('WORKFLOW_ID_REQUIRED', 400, 'Cần workflowId để bật/tắt workflow.');
          const enabled = args.enabled !== false;
          if (args.dryRun) return { dryRun: true, workflowId: args.workflowId, enabled };
          if (hasRes(ctx, 'workflows')) {
            await invokeResourceAction(ctx, 'workflows', 'update', { filterByTk: args.workflowId, values: { enabled } });
          } else {
            const wf = await wfRepo.findOne({ filterByTk: args.workflowId });
            if (!wf) throw failTool('WORKFLOW_NOT_FOUND', 404, 'Không tìm thấy workflow.');
            await wf.update({ enabled });
          }
          return { applied: true, workflowId: args.workflowId, enabled };
        }

        // buildCustomWorkflow
        if (!args.collectionName || SYSTEM_PROTECTED_COLLECTIONS.has(args.collectionName)) {
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

        if (hasRes(ctx, 'workflows') && enabled) {
          try {
            await invokeResourceAction(ctx, 'workflows', 'update', { filterByTk: created.workflowId, values: { enabled: true } });
          } catch {}
        }
        return {
          applied: true,
          created: true,
          ...created,
          enabled,
          designerUrl: `/admin/settings/workflow/workflows/${created.workflowId}`,
        };
      },
    }),
  ];
}

module.exports = { createBuilderTools };
