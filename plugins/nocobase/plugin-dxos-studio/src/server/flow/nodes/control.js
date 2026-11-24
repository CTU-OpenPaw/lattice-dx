/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { fail, val } = require('../../wms-dmn-shared');
const { flowHelpers } = require('./triggers');

const { BLOCKED_PROTO_KEYS, isPlainObject, sanitizePlainObject, getSafePath, interpolateTemplate, buildEvalContext, resolveOrgId, pickHelper } = flowHelpers;
const MAX_SUBFLOW_DEPTH = 8;
const MAX_LOOP_CAP = 100;

function matchOperatorObject(actual, ops) {
  if (!isPlainObject(ops) || Object.getOwnPropertyNames(ops).some((k) => BLOCKED_PROTO_KEYS.has(k))) return false;
  const entries = Object.entries(ops);
  if (!entries.length) return false;
  for (const [op, exp] of entries) {
    if (BLOCKED_PROTO_KEYS.has(op)) return false;
    const key = op.startsWith('$') ? op.slice(1) : op;
    if (key === 'eq' || key === '==' || key === '===') { if (actual !== exp) return false; }
    else if (key === 'ne' || key === 'neq' || key === '!=') { if (actual === exp) return false; }
    else if (['gt', 'gte', 'lt', 'lte'].includes(key)) {
      if (actual === null || actual === undefined || actual === '') return false;
      const a = Number(actual); const b = Number(exp);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
      if ((key === 'gt' && !(a > b)) || (key === 'gte' && !(a >= b)) || (key === 'lt' && !(a < b)) || (key === 'lte' && !(a <= b))) return false;
    } else if (key === 'in') { if (!Array.isArray(exp) || !exp.includes(actual)) return false; }
    else if (key === 'nin') { if (!Array.isArray(exp) || exp.includes(actual)) return false; }
    else if (key === 'exists') { if (Boolean(exp) !== (actual !== undefined && actual !== null)) return false; }
    else if (key === 'contains') {
      if (typeof actual === 'string') { if (!actual.includes(String(exp))) return false; }
      else if (Array.isArray(actual)) { if (!actual.includes(exp)) return false; }
      else return false;
    } else return false;
  }
  return true;
}

function lookupFilterVal(ctx, key) {
  const s = String(key || '').trim();
  if (!s) return undefined;
  if (/^(?:data|dmn|event|envelope|steps|nodes|input)\./.test(s)) return getSafePath(ctx, s);
  const fromData = getSafePath(ctx?.data, s);
  if (fromData !== undefined) return fromData;
  const fromInput = getSafePath(ctx?.input, s);
  return fromInput !== undefined ? fromInput : getSafePath(ctx, s);
}

function matchesFilter(filterJson, ctx) {
  if (filterJson === null || filterJson === undefined) return true;
  if (Array.isArray(filterJson)) return filterJson.every((c) => matchesFilter(c, ctx));
  if (!isPlainObject(filterJson) || Object.getOwnPropertyNames(filterJson).some((k) => BLOCKED_PROTO_KEYS.has(k))) return false;
  const entries = Object.entries(filterJson);
  if (!entries.length) return true;
  if (typeof filterJson.field === 'string') {
    const opsKeys = entries.map(([k]) => k).filter((k) => k !== 'field');
    if (opsKeys.some((k) => ['op', 'value', '$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$exists', '$contains'].includes(k))) {
      if ('op' in filterJson && !String(filterJson.op || '').trim()) return false;
      const actual = lookupFilterVal(ctx, filterJson.field);
      if (filterJson.op) return matchOperatorObject(actual, { [String(filterJson.op).trim()]: filterJson.value });
      const opsObj = {};
      for (const k of opsKeys) {
        if (k === 'value' && !opsKeys.includes('op') && opsKeys.length === 1) opsObj.$eq = filterJson.value;
        else if (k !== 'op' && k !== 'value') opsObj[k] = filterJson[k];
      }
      return matchOperatorObject(actual, opsObj);
    }
  }
  for (const [key, exp] of entries) {
    if (key === '$and' || key === 'and' || key === 'all' || (key === 'rules' && Array.isArray(exp))) {
      if (!Array.isArray(exp) || !exp.every((item) => matchesFilter(item, ctx))) return false;
    } else if (key === '$or' || key === 'or' || key === 'any') {
      if (!Array.isArray(exp) || !exp.some((item) => matchesFilter(item, ctx))) return false;
    } else if (key === '$not') {
      if (matchesFilter(exp, ctx)) return false;
    } else {
      const actual = lookupFilterVal(ctx, key);
      if (isPlainObject(exp) && Object.keys(exp).length && Object.keys(exp).every((k) => k.startsWith('$'))) {
        if (!matchOperatorObject(actual, exp)) return false;
      } else if (Array.isArray(exp)) {
        if (!exp.includes(actual)) return false;
      } else if (actual !== exp) return false;
    }
  }
  return true;
}

const makeControlNode = ({ type, label, description, icon, outputs, defaultConfig, fields, execute }) => ({
  type, category: 'control', label, description, icon, color: '#fa8c16', inputs: ['in'], outputs,
  defaultConfig, inputSchema: { fields }, execute,
});

const controlNodes = [
  makeControlNode({
    type: 'control.if', label: 'Conditional Branch (IF)', icon: 'BranchesOutlined',
    description: 'Routes execution to true or false branch using structured filter rules.',
    outputs: ['true', 'false', 'error'],
    defaultConfig: { condition: { field: '', op: 'eq', value: '' } },
    fields: [{ name: 'condition', label: 'Condition (JSON)', type: 'json', required: true }],
    async execute({ node, config, input, context, helpers }) {
      const cfg = config || node?.config || {};
      const evalCtx = buildEvalContext(context, input);
      const condition = pickHelper(helpers, 'interpolateTemplate', interpolateTemplate)(cfg.condition ?? null, evalCtx);
      const matched = Boolean(pickHelper(helpers, 'matchesFilter', matchesFilter)(condition, evalCtx));
      return { output: { matched, condition }, nextPort: matched ? 'true' : 'false' };
    },
  }),
  makeControlNode({
    type: 'control.switch', label: 'Multi-Way Switch', icon: 'ForkOutlined',
    description: 'Evaluates ordered cases against an expression and routes to the matching port.',
    outputs: ['case_0', 'case_1', 'case_2', 'default', 'error'],
    defaultConfig: { expression: '', cases: [{ port: 'case_0', operator: 'eq', equals: '' }] },
    fields: [
      { name: 'expression', label: 'Expression or Path', type: 'string', required: true, placeholder: 'data.priority' },
      { name: 'cases', label: 'Ordered Cases (JSON)', type: 'json', required: true },
    ],
    async execute({ node, config, input, context, helpers }) {
      const cfg = config || node?.config || {};
      const evalCtx = buildEvalContext(context, input);
      const getPath = pickHelper(helpers, 'getSafePath', getSafePath);
      const interp = pickHelper(helpers, 'interpolateTemplate', interpolateTemplate);
      const match = pickHelper(helpers, 'matchesFilter', matchesFilter);
      const rawExpr = String(cfg.expression || '').trim();
      const actual = rawExpr.includes('{{') ? interp(rawExpr, evalCtx) : (getPath(evalCtx, rawExpr) ?? getPath(evalCtx.data, rawExpr));
      const cases = Array.isArray(cfg.cases) ? cfg.cases : [];
      for (let i = 0; i < cases.length; i += 1) {
        const c = cases[i] || {};
        const port = String(c.port || `case_${i}`).trim();
        const op = String(c.operator || c.op || 'eq').trim();
        const expected = 'equals' in c ? c.equals : c.value;
        if (c.condition ? match(c.condition, evalCtx) : matchOperatorObject(actual, { [op]: expected })) {
          return { output: { matched: true, port, value: actual }, nextPort: port };
        }
      }
      return { output: { matched: false, port: 'default', value: actual }, nextPort: 'default' };
    },
  }),
  makeControlNode({
    type: 'control.parallel', label: 'Parallel Fan-Out', icon: 'ApartmentOutlined',
    description: 'Broadcasts execution across all connected outgoing branches concurrently.',
    outputs: ['main', 'error'], defaultConfig: { mode: 'fan_out' },
    fields: [{ name: 'mode', label: 'Fan-Out Mode', type: 'select', options: ['fan_out'] }],
    async execute({ input }) { return { output: { fannedOut: true, input: input ?? null }, nextPort: 'main' }; },
  }),
  makeControlNode({
    type: 'control.merge', label: 'Merge Branches', icon: 'MergeCellsOutlined',
    description: 'Combines payloads from parallel branches using wait_all or first_completed.',
    outputs: ['main', 'error'], defaultConfig: { mode: 'wait_all' },
    fields: [{ name: 'mode', label: 'Merge Mode', type: 'select', required: true, options: ['wait_all', 'first_completed'] }],
    async execute({ node, config, input, context }) {
      const cfg = config || node?.config || {};
      const mode = cfg.mode === 'first_completed' ? 'first_completed' : 'wait_all';
      const branches = Array.isArray(input) ? input : (input?.branches ?? context?.branches ?? (isPlainObject(input) ? input : { value: input ?? null }));
      let merged = {};
      if (Array.isArray(branches)) {
        merged = mode === 'first_completed' ? (branches.find((b) => b !== undefined) ?? null) : Object.assign({}, ...branches.filter(isPlainObject));
      } else if (isPlainObject(branches)) {
        const vals = Object.values(branches);
        merged = mode === 'first_completed' ? (vals.find((b) => b !== undefined) ?? null) : Object.assign({}, ...vals.filter(isPlainObject));
        if (!Object.keys(merged).length && mode === 'wait_all') merged = { ...branches };
      }
      return { output: { mode, merged, branches }, nextPort: 'main' };
    },
  }),
  makeControlNode({
    type: 'control.loop', label: 'Bounded Loop (For Each)', icon: 'RetweetOutlined',
    description: 'Iterates an array up to 100 items safely and emits item and done branches.',
    outputs: ['item', 'done', 'error'],
    defaultConfig: { itemsPath: 'data.items', maxIterations: MAX_LOOP_CAP, strictLimit: false },
    fields: [
      { name: 'itemsPath', label: 'Items Array Path', type: 'string', required: true, placeholder: 'data.items' },
      { name: 'maxIterations', label: 'Max Iterations (1..100)', type: 'number', required: true },
      { name: 'strictLimit', label: 'Error If Array Exceeds Cap', type: 'boolean' },
    ],
    async execute({ node, config, input, context, helpers }) {
      const cfg = config || node?.config || {};
      const evalCtx = buildEvalContext(context, input);
      const getPath = pickHelper(helpers, 'getSafePath', getSafePath);
      const rawMax = cfg.maxIterations === undefined || cfg.maxIterations === null ? MAX_LOOP_CAP : Number(cfg.maxIterations);
      if (!Number.isInteger(rawMax) || rawMax < 1 || rawMax > MAX_LOOP_CAP) {
        throw fail('FLOW_LOOP_LIMIT_EXCEEDED', 400, `FLOW_LOOP_LIMIT_EXCEEDED: maxIterations must be 1..${MAX_LOOP_CAP}`);
      }
      const itemsPath = String(cfg.itemsPath || '').trim();
      const resolved = Array.isArray(cfg.items)
        ? cfg.items
        : (getPath(evalCtx, itemsPath || 'data.items')
          ?? getPath(evalCtx.input, itemsPath || 'items')
          ?? getPath(evalCtx.data, itemsPath || 'items'));
      const rawItems = Array.isArray(resolved) ? resolved : [];
      if (cfg.strictLimit === true && rawItems.length > rawMax) {
        throw fail('FLOW_LOOP_LIMIT_EXCEEDED', 400, `FLOW_LOOP_LIMIT_EXCEEDED: array length ${rawItems.length} exceeds cap ${rawMax}`);
      }
      const items = rawItems.slice(0, rawMax);
      return {
        output: { items, count: items.length, totalCount: rawItems.length, maxIterations: rawMax, truncated: rawItems.length > rawMax },
        nextPort: items.length > 0 ? 'item' : 'done',
        nextPorts: items.length > 0 ? ['item', 'done'] : ['done'],
      };
    },
  }),
  makeControlNode({
    type: 'control.delay', label: 'Durable Delay / Timer', icon: 'HourglassOutlined',
    description: 'Suspends execution until a relative delay or explicit ISO timestamp.',
    outputs: ['main', 'error'], defaultConfig: { durationSec: 60, untilIso: '' },
    fields: [
      { name: 'durationSec', label: 'Duration (seconds)', type: 'number', placeholder: '60' },
      { name: 'untilIso', label: 'Until Timestamp (ISO-8601)', type: 'string', placeholder: '2026-12-01T00:00:00Z' },
    ],
    async execute({ node, config, input, context, options, helpers }) {
      const cfg = config || node?.config || {};
      const evalCtx = buildEvalContext(context, input);
      const untilRaw = cfg.untilIso ? String(pickHelper(helpers, 'interpolateTemplate', interpolateTemplate)(cfg.untilIso, evalCtx)).trim() : '';
      const durationSec = Math.max(0, Number(cfg.durationSec) || 0);
      let resumeAt;
      if (untilRaw) {
        const dt = new Date(untilRaw);
        if (!Number.isFinite(dt.getTime())) throw fail('FLOW_INVALID_DELAY', 400, 'Invalid untilIso timestamp');
        resumeAt = dt.toISOString();
      } else {
        resumeAt = new Date(Date.now() + durationSec * 1000).toISOString();
      }
      if (options?.dryRun) return { output: { delayed: true, simulated: true, resumeAt, durationSec }, nextPort: 'main' };
      return { suspend: { kind: 'delay', resumeAt, reason: 'Scheduled delay wait' }, output: { resumeAt, durationSec }, nextPort: 'main' };
    },
  }),
  makeControlNode({
    type: 'control.approval', label: 'Human Approval (HITL)', icon: 'SafetyCertificateOutlined',
    description: 'Creates a pending approval item and suspends until approved or rejected.',
    outputs: ['approved', 'rejected', 'error'],
    defaultConfig: { approverRole: 'ldx_manager', title: 'Approval Required', summary: '', riskLevel: 'medium', ttlHours: 24 },
    fields: [
      { name: 'approverRole', label: 'Approver Role', type: 'string', required: true, placeholder: 'ldx_manager' },
      { name: 'title', label: 'Approval Title', type: 'string', required: true },
      { name: 'summary', label: 'Decision Summary', type: 'textarea' },
      { name: 'riskLevel', label: 'Risk Level', type: 'select', options: ['low', 'medium', 'high', 'critical'] },
      { name: 'ttlHours', label: 'Expiration (Hours)', type: 'number' },
    ],
    async execute({ node, config, input, context, db, options, helpers }) {
      const cfg = config || node?.config || {};
      const evalCtx = buildEvalContext(context, input);
      const interp = pickHelper(helpers, 'interpolateTemplate', interpolateTemplate);
      const orgId = resolveOrgId(context, input, options, cfg);
      if (!orgId) throw fail('APPROVAL_ORG_REQUIRED', 400, 'Valid organizationId is required for control.approval');
      const approverRole = String(interp(cfg.approverRole || 'ldx_manager', evalCtx)).trim();
      const title = String(interp(cfg.title || 'Flow Approval Required', evalCtx));
      const summary = String(interp(cfg.summary || '', evalCtx));
      const riskLevel = String(interp(cfg.riskLevel || 'medium', evalCtx));
      const ttlHours = Math.max(1, Math.min(720, Number(cfg.ttlHours) || 24));
      const resumeAt = new Date(Date.now() + ttlHours * 3600_000).toISOString();
      if (options?.dryRun) return { output: { status: 'simulated_approval', nextPort: 'approved', approverRole, title, summary, riskLevel }, nextPort: 'approved' };
      let approvalId = null;
      const queueRepo = db?.getRepository?.('latticeAiApprovalQueue');
      if (typeof queueRepo?.create === 'function') {
        const actor = context?.actor || options?.actor || {};
        const created = await queueRepo.create({
          values: {
            organizationId: orgId,
            requesterUserId: Number(actor?.userId || actor?.id || 0),
            requesterUsername: String(actor?.username || 'flow:approval').slice(0, 120),
            aiEmployee: String(cfg.aiEmployee || 'flow-orchestrator'),
            toolName: 'latticeflow.approval', targetCollection: 'latticeAutomationRuns',
            targetRecordId: Number(context?.runId || 0) || null, operation: 'approval',
            proposedArgs: sanitizePlainObject({ runUid: context?.runUid || null, nodeId: node?.id || null, approverRole, title }),
            diffPreview: { title, summary, approverRole, riskLevel }, riskLevel, status: 'pending', expiresAt: new Date(resumeAt),
          },
        });
        approvalId = val(created, 'id') ?? null;
      }
      return { suspend: { kind: 'approval', approvalId, approverRole, resumeAt }, output: { approvalId, status: 'pending', approverRole, title, summary, riskLevel, resumeAt } };
    },
  }),
  makeControlNode({
    type: 'control.subflow', label: 'Invoke Subflow', icon: 'SubnodeOutlined',
    description: 'Calls another published flow rule with bounded recursion depth.',
    outputs: ['main', 'error'], defaultConfig: { ruleKey: '', payloadMapping: {}, maxDepth: MAX_SUBFLOW_DEPTH },
    fields: [
      { name: 'ruleKey', label: 'Subflow Rule Key', type: 'string', required: true },
      { name: 'payloadMapping', label: 'Payload Mapping (JSON)', type: 'json' },
      { name: 'maxDepth', label: 'Max Recursion Depth (1..8)', type: 'number' },
    ],
    async execute({ node, config, input, context, db, app, options, helpers }) {
      const cfg = config || node?.config || {};
      const evalCtx = buildEvalContext(context, input);
      const interp = pickHelper(helpers, 'interpolateTemplate', interpolateTemplate);
      const ruleKey = String(interp(cfg.ruleKey || '', evalCtx)).trim();
      if (!ruleKey) throw fail('MISSING_RULE_KEY', 400, 'control.subflow requires ruleKey');
      const maxDepth = Math.min(MAX_SUBFLOW_DEPTH, Math.max(1, Number(cfg.maxDepth ?? context?.maxDepth ?? MAX_SUBFLOW_DEPTH) || MAX_SUBFLOW_DEPTH));
      const nextDepth = Number(context?.depth ?? context?.event?.depth ?? 0) + 1;
      if (nextDepth > maxDepth || nextDepth > MAX_SUBFLOW_DEPTH) {
        throw fail('RECURSION_DEPTH_LIMIT_EXCEEDED', 400, `RECURSION_DEPTH_LIMIT_EXCEEDED (depth=${nextDepth} > maxDepth=${maxDepth})`);
      }
      const mapped = interp(cfg.payloadMapping ?? cfg.payload ?? (isPlainObject(input) ? input : {}), evalCtx);
      if (typeof helpers?.executeSubflow === 'function') {
        const result = await helpers.executeSubflow(ruleKey, mapped, { depth: nextDepth, maxDepth, organizationId: resolveOrgId(context, input, options, cfg), dryRun: Boolean(options?.dryRun), db, app, options });
        return { output: { ruleKey, depth: nextDepth, result }, nextPort: 'main' };
      }
      if (options?.dryRun) return { output: { ruleKey, depth: nextDepth, simulated: true, input: mapped }, nextPort: 'main' };
      throw fail('SUBFLOW_EXECUTOR_UNAVAILABLE', 503, 'helpers.executeSubflow is unavailable');
    },
  }),
];

module.exports = { controlNodes, matchOperatorObject, matchesFilter };
