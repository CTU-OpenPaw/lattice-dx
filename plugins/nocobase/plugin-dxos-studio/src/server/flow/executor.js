/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const crypto = require('node:crypto');
const { fail, loadFoundationModule, sha256Hex, timingSafeEqualHex, toPlain, val } = require('../wms-dmn-shared');
const { MAX_HARD_DEPTH, buildTriggerIndex, cloneSafe, isPlainObject, normalizeGraph, v1RuleToGraphV2 } = require('./schema');
const { validateFlowGraph } = require('./validator');
const { claimSuspendedRun, createRunRecord, generateResumeToken, hashResumeToken, suspendRun } = require('./durable-store');
const { getOrmTriggerDepth, resolveTrustedOrgId, runAutomationWithRls, runWithOrmDepth } = require('./security-helpers');
const registry = require('./registry');

const getEngine = () => require('../automation-engine');
const HELPER_KEYS = ['interpolateTemplate', 'matchesFilter', 'getSafePath', 'sanitizePlainObject', 'isAllowlistedTargetCollection', 'sanitizeAutomationWriteValues', 'buildConnectorUrl', 'buildHmacHeaders', 'buildFallbackAuthHeaders', 'scrubSecrets'];
const getHeader = (headers, name) => {
  const entry = Object.entries(headers || {}).find(([k]) => String(k).toLowerCase() === String(name || '').toLowerCase());
  return entry ? (Array.isArray(entry[1]) ? String(entry[1][0] ?? '') : String(entry[1] ?? '')) : '';
};
function buildNodeHelpers(db, app, options, execState) {
  const eng = getEngine();
  const out = { loadCrossPluginModules: (a, o) => eng.loadCrossPluginModules(a ?? app, o ?? options) };
  HELPER_KEYS.forEach((k) => { out[k] = eng[k]; });
  out.executeSubflow = async (ruleKey, payload, meta = {}) => {
    const orgId = resolveTrustedOrgId(options.organizationId || execState.organizationId, meta.organizationId, 'Subflow cannot cross organization boundary');
    const targetDb = meta.db || db;
    const ruleRow = await targetDb?.getRepository?.('latticeAutomationRules')?.findOne({ filter: { organizationId: orgId, ruleKey } });
    if (!ruleRow) throw fail('SUBFLOW_RULE_NOT_FOUND', 404, `Subflow rule "${ruleKey}" not found`);
    const subRun = await executeFlowGraph(targetDb, ruleRow, { type: 'subflow.call', organizationId: orgId, depth: Number(meta.depth || 1), data: isPlainObject(payload) ? payload : { payload } }, { ...(meta.options || options), organizationId: orgId, app: meta.app || app, dryRun: Boolean(meta.dryRun), ignoreCooldown: true });
    return { runUid: subRun.runUid, status: subRun.status, nodes: subRun.nodeStatesJson };
  };
  return out;
}
function recordNodeOutput(execState, node, output, status, error = null) {
  execState.nodes[node.id] = error ? { output, status, error } : { output, status };
  const stepObj = { ...(isPlainObject(output) ? output : { value: output }), output, status, ...(error ? { error } : {}) };
  execState.steps[node.id] = stepObj;
  if (Number.isInteger(node.config?.stepIndex)) execState.steps[node.config.stepIndex] = stepObj;
}
function collectSubgraph(startIds, edges, allowedSet) {
  const [visited, queue] = [new Set(), [...startIds]];
  for (let i = 0; i < queue.length; i += 1) if (!visited.has(queue[i]) && (!allowedSet || allowedSet.has(queue[i]))) { visited.add(queue[i]); edges.forEach((e) => { if (e.source === queue[i] && !visited.has(e.target)) queue.push(e.target); }); }
  return visited;
}
const RESERVED_CTX = new Set(['event', 'data', 'dmn', 'dmnResult', 'steps', 'nodes', 'loop', 'actor', 'organizationId']);
const resolveFlowContext = (node, nodeInput, execState) => { const k = node.type === 'control.loop' && isPlainObject(nodeInput) ? String(node.config?.itemsPath || 'items').trim().split('.')[0] : ''; return (k && !RESERVED_CTX.has(k) && execState[k] === undefined && execState.data?.[k] === undefined && nodeInput[k] !== undefined) ? { ...execState, [k]: nodeInput[k] } : execState; };
const computeRunStatus = (traces, halted) => !traces.some((t) => t.status === 'failed') ? (halted ? 'failed' : 'completed') : traces.some((t) => t.status === 'completed' && !String(t.type || '').startsWith('trigger.')) ? 'partial' : 'failed';
async function runSingleNode({ node, nodeInput, reg, execState, db, app, options, helpers, loopMeta }) {
  const [t0, def] = [Date.now(), reg.getNodeType(node.type)];
  if (!def) throw fail('FLOW_UNKNOWN_NODE_TYPE', 400, `Unknown node type "${node.type}"`);
  const nodeOpts = node.type === 'iot.twin_command' && !options?.digitalTwin ? { ...options, digitalTwin: helpers.loadCrossPluginModules(app, options).digitalTwinMod } : options;
  try {
    const res = await def.execute({ node, config: node.config, input: nodeInput, context: resolveFlowContext(node, nodeInput, execState), db, app, options: nodeOpts, helpers });
    const durationMs = Math.max(0, Date.now() - t0);
    if (res?.error) { recordNodeOutput(execState, node, res.output ?? null, 'failed', String(res.error)); return { ok: false, node, output: res.output ?? null, error: String(res.error), durationMs, loopMeta }; }
    if (res?.suspend && !options.dryRun) { recordNodeOutput(execState, node, res.output ?? null, 'suspended'); return { ok: true, suspend: res.suspend, node, output: res.output ?? null, durationMs, loopMeta }; }
    const ports = Array.isArray(res?.nextPorts) && res.nextPorts.length ? res.nextPorts : [res?.nextPort || 'main'];
    recordNodeOutput(execState, node, res?.output ?? null, 'completed');
    return { ok: true, node, output: res?.output ?? null, nextPort: ports[0], nextPorts: ports, durationMs, loopMeta };
  } catch (err) { recordNodeOutput(execState, node, null, 'failed', err?.message || String(err)); return { ok: false, node, output: null, error: err?.message || String(err), durationMs: Math.max(0, Date.now() - t0), loopMeta }; }
}
async function traverseDag({ graph, subTopo, nodeMap, edges, initialInputs, execState, nodeStatesJson, stepTracesJson, reg, db, app, options, helpers, loopMeta = null }) {
  const subSet = new Set(subTopo);
  const [inEdges, outEdges, activeInputs] = [new Map(subTopo.map((id) => [id, edges.filter((e) => e.target === id && subSet.has(e.source))])), new Map(subTopo.map((id) => [id, edges.filter((e) => e.source === id && subSet.has(e.target))])), new Map(subTopo.map((id) => [id, [...(initialInputs.get(id) || [])]]))];
  const [settled, loopOwned, localStatuses] = [new Set(), new Set(), new Map()];
  subTopo.filter((id) => nodeMap.get(id)?.type === 'control.loop').forEach((id) => collectSubgraph((outEdges.get(id) || []).filter((e) => e.sourceHandle === 'item').map((e) => e.target), edges, subSet).forEach((b) => loopOwned.add(b)));
  let [halted, haltError, suspended] = [false, null, null];
  const markSkipped = (id, reason) => { settled.add(id); localStatuses.set(id, 'skipped'); if (!loopMeta) nodeStatesJson[id] = { status: 'skipped', reason }; };
  while (settled.size < subTopo.length && !halted && !suspended) {
    const ready = subTopo.filter((id) => !settled.has(id) && !loopOwned.has(id) && (inEdges.get(id) || []).every((e) => settled.has(e.source)));
    if (!ready.length) break;
    const toRun = [];
    for (const id of ready) {
      const [node, actIn] = [nodeMap.get(id), activeInputs.get(id) || []];
      if (!actIn.length) { markSkipped(id, 'BRANCH_NOT_TAKEN'); continue; }
      if (node.type === 'control.merge') {
        const mode = node.config?.mode === 'first_completed' ? 'first_completed' : 'wait_all';
        const activeParents = (inEdges.get(id) || []).map((e) => e.source).filter((p) => localStatuses.get(p) !== 'skipped');
        if (mode === 'wait_all' && activeParents.some((p) => !actIn.some((a) => a.from === p))) { markSkipped(id, 'MERGE_WAIT_ALL_INCOMPLETE'); continue; }
        toRun.push({ node, nodeInput: { branches: Object.fromEntries(actIn.map((a) => [a.from, a.output])) } });
      } else toRun.push({ node, nodeInput: actIn[0].output });
    }
    if (!toRun.length) continue;
    for (const r of await Promise.all(toRun.map(({ node, nodeInput }) => runSingleNode({ node, nodeInput, reg, execState, db, app, options, helpers, loopMeta })))) {
      const n = r.node; settled.add(n.id);
      stepTracesJson.push({ nodeId: n.id, type: n.type, label: n.label, status: r.suspend ? 'suspended' : (r.ok ? 'completed' : 'failed'), output: r.output, error: r.error || null, durationMs: r.durationMs, ...(options.dryRun ? { simulated: true } : {}), ...(loopMeta ? { loopNodeId: loopMeta.nodeId, loopIteration: loopMeta.index } : {}) });
      if (r.suspend) { localStatuses.set(n.id, 'suspended'); nodeStatesJson[n.id] = { status: 'suspended', output: r.output, suspend: r.suspend, durationMs: r.durationMs }; suspended = { node: n, suspend: r.suspend, output: r.output }; }
      else if (!r.ok) {
        localStatuses.set(n.id, 'failed'); nodeStatesJson[n.id] = { status: 'failed', output: r.output, error: r.error, durationMs: r.durationMs };
        const errEdges = (outEdges.get(n.id) || []).filter((e) => e.sourceHandle === 'error');
        if (errEdges.length) errEdges.forEach((e) => activeInputs.get(e.target)?.push({ from: n.id, output: { error: r.error, output: r.output } }));
        else if (!n.continueOnFail && graph.settings?.errorPolicy !== 'continue') { halted = true; haltError = r.error; }
      } else if (n.type === 'control.loop') {
        const items = Array.isArray(r.output?.items) ? r.output.items : [];
        const bodySet = collectSubgraph((outEdges.get(n.id) || []).filter((e) => e.sourceHandle === 'item').map((e) => e.target), edges, subSet);
        const [localTopo, loopResults] = [subTopo.filter((id) => bodySet.has(id)), []];
        localTopo.forEach((id) => settled.add(id));
        if (items.length && localTopo.length) {
          for (let idx = 0; idx < items.length; idx += 1) {
            execState.loop = { item: items[idx], index: idx, count: items.length };
            const iterInit = new Map();
            (outEdges.get(n.id) || []).filter((e) => e.sourceHandle === 'item' && bodySet.has(e.target)).forEach((e) => iterInit.set(e.target, [...(iterInit.get(e.target) || []), { from: n.id, output: items[idx] }]));
            const traceStart = stepTracesJson.length;
            const iterRes = await traverseDag({ graph, subTopo: localTopo, nodeMap, edges, initialInputs: iterInit, execState, nodeStatesJson, stepTracesJson, reg, db, app, options, helpers, loopMeta: { nodeId: n.id, index: idx } });
            const iterDone = !iterRes.halted && !iterRes.suspended ? stepTracesJson.slice(traceStart).filter((t) => t.status === 'completed') : [];
            loopResults.push(iterDone.length ? (iterDone.at(-1).output ?? null) : null);
            if (iterRes.suspended) { suspended = iterRes.suspended; break; }
            if (iterRes.halted) { halted = true; haltError = iterRes.haltError; break; }
          }
          execState.loop = null;
          if (!halted && !suspended) localTopo.forEach((id) => { if (!nodeStatesJson[id]) nodeStatesJson[id] = { status: 'skipped', reason: 'BRANCH_NOT_TAKEN' }; });
        } else localTopo.forEach((id) => { nodeStatesJson[id] = { status: 'skipped', reason: 'BRANCH_NOT_TAKEN' }; });
        const finalOut = { ...(r.output || {}), results: loopResults };
        localStatuses.set(n.id, suspended ? 'suspended' : 'completed');
        recordNodeOutput(execState, n, finalOut, suspended ? 'suspended' : 'completed');
        nodeStatesJson[n.id] = suspended ? { status: 'suspended', output: finalOut, durationMs: r.durationMs } : { status: 'completed', output: finalOut, nextPort: 'done', nextPorts: ['done'], durationMs: r.durationMs };
        if (!halted && !suspended) (outEdges.get(n.id) || []).filter((e) => e.sourceHandle === 'done').forEach((e) => activeInputs.get(e.target)?.push({ from: n.id, output: finalOut }));
      } else {
        localStatuses.set(n.id, 'completed');
        nodeStatesJson[n.id] = { status: 'completed', output: r.output, nextPort: r.nextPort, nextPorts: r.nextPorts, durationMs: r.durationMs };
        const activePorts = new Set(r.nextPorts || [r.nextPort || 'main']);
        (outEdges.get(n.id) || []).filter((e) => activePorts.has(e.sourceHandle)).forEach((e) => activeInputs.get(e.target)?.push({ from: n.id, output: r.output }));
      }
    }
  }
  return { halted, haltError, suspended, traces: stepTracesJson };
}
const buildExecState = (event, options, extra = {}) => ({
  ...event, actor: options.actor || null, dmn: extra.dmn || {}, dmnResult: extra.dmnResult || null, steps: extra.steps || {}, nodes: extra.nodes || {},
  loop: null, record: extra.record ?? null, resumeDecision: extra.resumeDecision ?? null, resumePayload: extra.resumePayload ?? null,
  event: { id: event.id, type: event.type, source: event.source, subject: event.subject, time: event.time, organizationid: event.organizationid, organizationId: event.organizationId, correlationid: event.correlationid, causationid: event.causationid, depth: event.depth, data: event.data },
});
function resolveNormalizedRuleAndGraph(ruleOrGraph, options = {}) {
  const raw = toPlain(ruleOrGraph) || {};
  const rule = (Array.isArray(raw.nodes) && !raw.graphJson) ? { ruleKey: raw.ruleKey || 'inline_flow', organizationId: options.organizationId || raw.organizationId || '', schemaVersion: 2, graphJson: raw } : raw;
  const srcGraph = options.useDraft && rule.draftGraphJson?.nodes?.length ? rule.draftGraphJson
    : (rule.graphJson?.nodes?.length || (Number(rule.schemaVersion) === 2 && isPlainObject(rule.graphJson))) ? rule.graphJson : v1RuleToGraphV2(rule);
  return { rule, graph: normalizeGraph(srcGraph) };
}
async function finalizeDagRun(db, { organizationId, runUid, execRes, execState, nodeStatesJson, stepTracesJson, triggerPayloadJson, dryRun, fallbackRecord, startedMs }) {
  if (execRes.suspended) {
    const [{ token, tokenHash }, { node: sNode, suspend }] = [generateResumeToken(), execRes.suspended];
    const tpBase = triggerPayloadJson || (isPlainObject(fallbackRecord?.triggerPayloadJson) ? fallbackRecord.triggerPayloadJson : null);
    const saved = await suspendRun(db, { organizationId, runUid, nodeId: sNode.id, approvalId: suspend.approvalId ?? null, resumeAt: suspend.resumeAt ? new Date(suspend.resumeAt) : null, resumeTokenHash: tokenHash, nodeStatesJson, stepTracesJson, dmnResultJson: execState.dmnResult, ...(tpBase ? { triggerPayloadJson: { ...tpBase, dmn: execState.dmn, dmnResult: execState.dmnResult, actor: execState.actor } } : {}) });
    return { ...saved, status: 'suspended', suspendedNodeId: sNode.id, approvalId: suspend.approvalId ?? null, resumeToken: token };
  }
  const values = { status: computeRunStatus(stepTracesJson, execRes.halted), matched: true, graphVersion: 2, dmnResultJson: execState.dmnResult, nodeStatesJson, stepTracesJson, errorMessage: stepTracesJson.filter((t) => t.status === 'failed' && t.error).map((t) => t.error).join('; ') || execRes.haltError || null, suspendedNodeId: null, resumeTokenHash: null, resumeAt: null, finishedAt: new Date(), durationMs: Math.max(0, Date.now() - startedMs) };
  const runsRepo = db?.getRepository?.('latticeAutomationRuns');
  if (!dryRun && runsRepo?.update) {
    await runsRepo.update({ filter: { organizationId, runUid }, values });
    const updated = runsRepo.findOne ? await runsRepo.findOne({ filter: { organizationId, runUid } }) : null;
    if (updated) return toPlain(updated);
  }
  return { ...fallbackRecord, ...values };
}
async function executeFlowGraph(db, ruleRow, triggerContext = {}, options = {}) {
  const [startMs, eng] = [Date.now(), getEngine()];
  const { rule, graph } = resolveNormalizedRuleAndGraph(ruleRow, options);
  const authOrgId = resolveTrustedOrgId(options.organizationId, rule.organizationId, 'Rule belongs to another organization');
  const organizationId = authOrgId || String(triggerContext?.organizationId || triggerContext?.organizationid || triggerContext?.data?.organizationId || '').trim();
  const event = eng.normalizeIncomingEvent(triggerContext, organizationId);
  if (authOrgId) { event.organizationId = authOrgId; event.organizationid = authOrgId; }
  const scopedOpts = organizationId ? { ...options, organizationId } : options;
  const [runUid, app, reg] = [`run_${crypto.randomUUID()}`, scopedOpts.app || db?.app, scopedOpts.nodeRegistry || registry];
  return runAutomationWithRls(db, organizationId, async () => {
    const finishEarly = (status, errorMessage, stepTracesJson = []) => {
      const rec = { organizationId, ruleId: val(ruleRow, 'id') ?? rule.id ?? null, ruleKey: String(rule.ruleKey || 'inline_flow'), runUid, triggerEventId: event.id, triggerEventType: event.type, status, depth: Number(event.depth || 0), matched: false, dmnResultJson: null, stepTracesJson, errorMessage, startedAt: new Date(startMs), finishedAt: new Date(), durationMs: Math.max(0, Date.now() - startMs), graphVersion: 2, nodeStatesJson: {} };
      return scopedOpts.dryRun ? rec : createRunRecord(db, rec);
    };
    const validation = validateFlowGraph(graph, { nodeRegistry: reg, requireTrigger: false });
    if (!validation.ok) return finishEarly('failed', validation.errors.map((e) => e.message).join('; '));
    const maxDepth = Math.min(MAX_HARD_DEPTH, Math.max(1, Number(rule.maxDepth || graph.settings?.maxDepth || MAX_HARD_DEPTH)));
    if (Number(event.depth || 0) >= maxDepth) return finishEarly('skipped', `RECURSION_DEPTH_LIMIT_EXCEEDED (depth=${event.depth} >= maxDepth=${maxDepth})`, [{ stepIndex: 0, type: 'recursion_guard', status: 'skipped', output: { depth: event.depth, maxDepth }, error: 'RECURSION_DEPTH_LIMIT_EXCEEDED', durationMs: 0 }]);
    const cooldownSec = Math.max(0, Number(rule.cooldownSec ?? graph.settings?.cooldownSec ?? 0));
    if (!scopedOpts.dryRun && !scopedOpts.ignoreCooldown && cooldownSec > 0 && rule.lastTriggeredAt && Number.isFinite(new Date(rule.lastTriggeredAt).getTime()) && startMs - new Date(rule.lastTriggeredAt).getTime() < cooldownSec * 1000) return finishEarly('skipped', 'COOLDOWN_ACTIVE', [{ stepIndex: 0, type: 'cooldown_guard', status: 'skipped', output: { cooldownSec }, error: 'COOLDOWN_ACTIVE', durationMs: 0 }]);
    const execState = buildExecState(event, scopedOpts, { record: eng.sanitizePlainObject(triggerContext?.record ?? null) });
    if (!eng.matchesFilter(validation.triggerNode?.config?.filterJson, execState) || !eng.matchesFilter(rule.filterJson, execState)) return finishEarly('skipped', 'FILTER_NOT_MATCHED');
    const triggerPayloadJson = { event, data: event.data, record: execState.record };
    let baseRun = { organizationId, ruleId: val(ruleRow, 'id') ?? rule.id ?? null, ruleKey: String(rule.ruleKey || 'inline_flow'), runUid, triggerEventId: event.id, triggerEventType: event.type, status: 'running', depth: Number(event.depth || 0), matched: true, graphVersion: 2, triggerPayloadJson, startedAt: new Date(startMs) };
    if (!scopedOpts.dryRun) { baseRun = await createRunRecord(db, baseRun); execState.runId = val(baseRun, 'id') ?? baseRun.id ?? null; execState.runUid = runUid; }
    const [nodeMap, nodeStatesJson, stepTracesJson, initInputs] = [new Map(graph.nodes.map((n) => [n.id, n])), {}, [], new Map()];
    const rootIds = validation.triggerNode ? [validation.triggerNode.id] : validation.topoOrder.filter((id) => !graph.edges.some((e) => e.target === id));
    rootIds.forEach((id) => initInputs.set(id, [{ from: '__trigger__', output: { type: event.type, data: event.data, record: execState.record, webhook: triggerContext?.webhook ?? null, schedule: triggerContext?.schedule ?? null, timestamp: event.time } }]));
    const execRes = await runWithOrmDepth(Number(event.depth || 0) + 1, () => traverseDag({ graph, subTopo: validation.topoOrder, nodeMap, edges: graph.edges, initialInputs: initInputs, execState, nodeStatesJson, stepTracesJson, reg, db, app, options: scopedOpts, helpers: buildNodeHelpers(db, app, scopedOpts, execState) }));
    if (!scopedOpts.dryRun && rule.ruleKey) await db?.getRepository?.('latticeAutomationRules')?.update?.({ filter: { organizationId, ruleKey: rule.ruleKey }, values: { lastTriggeredAt: new Date() } }).catch(() => {});
    return finalizeDagRun(db, { organizationId, runUid, execRes, execState, nodeStatesJson, stepTracesJson, triggerPayloadJson, dryRun: Boolean(scopedOpts.dryRun), fallbackRecord: baseRun, startedMs: startMs });
  });
}
const dryRunFlowGraph = (db, ruleOrGraph, sampleEvent = {}, options = {}) => executeFlowGraph(db, ruleOrGraph, sampleEvent, { ...options, dryRun: true, ignoreCooldown: true });

async function testSingleFlowNode(db, { graph, rule, nodeId, pinnedInputs = {}, organizationId, actor, options = {} } = {}) {
  const [t0, eng, reg] = [Date.now(), getEngine(), options.nodeRegistry || registry];
  const target = resolveNormalizedRuleAndGraph(graph || rule, options).graph.nodes.find((n) => n.id === String(nodeId || '').trim());
  if (!target) throw fail('FLOW_NODE_NOT_FOUND', 404, `Node "${nodeId}" not found in graph`);
  const check = validateFlowGraph({ nodes: [target], edges: [] }, { nodeRegistry: reg, requireTrigger: false });
  if (!check.ok) throw fail(check.errors[0]?.code || 'FLOW_INVALID_NODE', check.errors[0]?.code === 'TARGET_COLLECTION_FORBIDDEN' ? 403 : 400, check.errors[0]?.message || 'Node failed validation');
  const pin = isPlainObject(pinnedInputs) ? eng.sanitizePlainObject(pinnedInputs) : {};
  const authOrg = resolveTrustedOrgId(organizationId || options?.organizationId, rule?.organizationId, 'Rule belongs to another organization');
  const orgId = authOrg || String(pin.organizationId || pin.event?.organizationId || '').trim();
  const event = eng.normalizeIncomingEvent({ ...(isPlainObject(pin.event) ? pin.event : {}), data: isPlainObject(pin.data) ? pin.data : pin }, orgId);
  if (authOrg) { event.organizationId = authOrg; event.organizationid = authOrg; }
  const [steps, nodes] = [isPlainObject(pin.steps) ? cloneSafe(pin.steps) : {}, isPlainObject(pin.nodes) ? cloneSafe(pin.nodes) : {}];
  Object.entries(steps).forEach(([k, v]) => { if (!nodes[k]) nodes[k] = { output: v, status: 'completed' }; });
  const execState = buildExecState(event, { ...options, organizationId: orgId, actor }, { dmn: pin.dmn || {}, steps, nodes });
  execState.loop = pin.loop || null;
  const [dryRun, nodeInput] = [options.live === true ? false : (options.dryRun !== false), pin.input ?? pin.data ?? execState.data];
  const scopedOpts = { ...options, dryRun, organizationId: orgId, actor, ...(target.type === 'iot.twin_command' && !options.digitalTwin ? { digitalTwin: eng.loadCrossPluginModules(options.app || db?.app, options).digitalTwinMod } : {}) };
  const helpers = buildNodeHelpers(db, options.app || db?.app, scopedOpts, execState);
  return runAutomationWithRls(db, orgId, async () => {
    try {
      const res = await reg.getNodeType(target.type).execute({ node: target, config: target.config, input: nodeInput, context: execState, db, app: options.app || db?.app, options: scopedOpts, helpers });
      return { ok: !res?.error, nodeId: target.id, status: res?.error ? 'failed' : 'completed', input: nodeInput, output: res?.output ?? null, nextPort: res?.nextPort || 'main', durationMs: Math.max(0, Date.now() - t0), error: res?.error || null };
    } catch (err) {
      if (err?.status && err.status < 500 && err?.code) throw err;
      return { ok: false, nodeId: target.id, status: 'failed', input: nodeInput, output: null, nextPort: 'error', durationMs: Math.max(0, Date.now() - t0), error: err?.message || String(err) };
    }
  });
}
async function claimOrPreviewSuspended(db, { organizationId, runUid, resumeToken, actor, dryRun }) {
  const [cleanUid, cleanOrg, hasToken] = [String(runUid || '').trim(), String(organizationId || '').trim(), resumeToken !== undefined && resumeToken !== null];
  if (hasToken && !String(resumeToken).trim()) throw fail('INVALID_RESUME_TOKEN', 403, 'Invalid or missing resume token');
  if (!dryRun) { const c = await claimSuspendedRun(db, { organizationId, runUid, resumeToken, actor, requireToken: hasToken }); if (!c.ok) throw fail(c.code, c.statusCode, c.error); return c.run; }
  if (!cleanUid || !cleanOrg) throw fail(!cleanUid ? 'MISSING_RUN_ID' : 'NATIVE_TENANT_REQUIRED', 400, 'organizationId and runUid are required');
  const repo = db?.getRepository?.('latticeAutomationRuns');
  const row = await repo?.findOne?.({ filter: { organizationId: cleanOrg, runUid: cleanUid } });
  if (!row) { const other = await repo?.findOne?.({ filter: { runUid: cleanUid } }); throw fail(other ? 'NATIVE_ORGANIZATION_MISMATCH' : 'RUN_NOT_FOUND', other ? 403 : 404, other ? 'Run belongs to another organization' : `Automation run ${cleanUid} not found`); }
  const run = toPlain(row);
  if (String(val(row, 'organizationId') || run.organizationId || '').trim() && String(val(row, 'organizationId') || run.organizationId || '').trim() !== cleanOrg) throw fail('NATIVE_ORGANIZATION_MISMATCH', 403, 'Run belongs to another organization');
  if (run.status !== 'suspended') throw fail('RUN_ALREADY_RESUMED', 409, `Run status is "${run.status}", expected "suspended"`);
  if (hasToken && (!run.resumeTokenHash || !timingSafeEqualHex(hashResumeToken(String(resumeToken)), String(run.resumeTokenHash)))) throw fail('INVALID_RESUME_TOKEN', 403, 'Invalid or missing resume token');
  return run;
}
async function resumeFlowRun(db, { organizationId, runUid, decision = 'approved', payload = {}, resumeToken, actor, dryRun = false, options = {} } = {}) {
  const run = await runAutomationWithRls(db, String(organizationId || '').trim(), () => claimOrPreviewSuspended(db, { organizationId, runUid, resumeToken, actor, dryRun }));
  const [eng, orgId] = [getEngine(), String(organizationId || run.organizationId || '').trim()];
  try {
    return await runAutomationWithRls(db, orgId, async () => {
      const ruleRow = options.rule || await db?.getRepository?.('latticeAutomationRules')?.findOne({ filter: { organizationId: orgId, ruleKey: run.ruleKey } });
      if (!ruleRow) throw fail('RULE_NOT_FOUND', 404, `Automation rule "${run.ruleKey}" not found`);
      const [{ graph }, reg] = [resolveNormalizedRuleAndGraph(ruleRow, options), options.nodeRegistry || registry];
      const validation = validateFlowGraph(graph, { nodeRegistry: reg, requireTrigger: false });
      if (!validation.ok) throw fail('FLOW_INVALID_GRAPH', 400, validation.errors[0]?.message || 'Invalid flow graph');
      const sNode = graph.nodes.find((n) => n.id === run.suspendedNodeId);
      if (!sNode) throw fail('FLOW_NODE_NOT_FOUND', 404, `Suspended node "${run.suspendedNodeId}" not found`);
      const resumedPort = sNode.type === 'control.approval' ? (String(decision || 'approved').toLowerCase() === 'rejected' ? 'rejected' : 'approved') : (sNode.type === 'control.delay' ? 'main' : String(decision || 'main'));
      if (sNode.type === 'control.approval' && run.approvalId != null && !dryRun) await db?.getRepository?.('latticeAiApprovalQueue')?.update?.({ filter: { organizationId: orgId, id: run.approvalId, status: 'pending' }, values: { status: resumedPort, decidedByUserId: actor?.userId ? Number(actor.userId) : null, decidedByUsername: actor?.username ? String(actor.username) : null, decisionNote: payload?.note || payload?.reason || null, decidedAt: new Date() } }).catch(() => {});
      const tp = isPlainObject(run.triggerPayloadJson) ? run.triggerPayloadJson : {};
      const event = eng.normalizeIncomingEvent(tp.event || { id: run.triggerEventId, type: run.triggerEventType, organizationId: orgId, depth: run.depth, data: tp.data || {} }, orgId);
      event.organizationId = orgId; event.organizationid = orgId;
      const [scopedOpts, nodeStatesJson, stepTracesJson] = [{ ...options, organizationId: orgId, dryRun }, isPlainObject(run.nodeStatesJson) ? eng.sanitizePlainObject(run.nodeStatesJson) : {}, Array.isArray(run.stepTracesJson) ? eng.sanitizePlainObject(run.stepTracesJson) : []];
      const restoredDmn = isPlainObject(tp.dmn) && Object.keys(tp.dmn).length ? tp.dmn : (isPlainObject(run.dmnResultJson?.outputs) ? run.dmnResultJson.outputs : {});
      const execState = buildExecState(event, { ...scopedOpts, actor: actor || tp.actor }, { dmn: restoredDmn, dmnResult: isPlainObject(run.dmnResultJson) ? run.dmnResultJson : (tp.dmnResult || null), record: tp.record ?? null, resumeDecision: resumedPort, resumePayload: eng.sanitizePlainObject(payload || {}) });
      execState.runUid = run.runUid;
      const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
      Object.entries(nodeStatesJson).forEach(([nid, st]) => { const n = nodeMap.get(nid); if (n) recordNodeOutput(execState, n, st.output ?? null, st.status || 'completed', st.error || null); });
      const resumedOut = { ...(isPlainObject(nodeStatesJson[sNode.id]?.output) ? nodeStatesJson[sNode.id].output : {}), status: resumedPort, decision: resumedPort, payload: execState.resumePayload, resumedAt: new Date().toISOString() };
      recordNodeOutput(execState, sNode, resumedOut, 'completed');
      nodeStatesJson[sNode.id] = { status: 'completed', output: resumedOut, nextPort: resumedPort, nextPorts: [resumedPort] };
      const sTrace = [...stepTracesJson].reverse().find((t) => t.nodeId === sNode.id);
      if (sTrace) Object.assign(sTrace, { status: 'completed', output: resumedOut });
      const downSet = collectSubgraph(graph.edges.filter((e) => e.source === sNode.id).map((e) => e.target), graph.edges);
      const subTopo = validation.topoOrder.filter((id) => downSet.has(id));
      const initInputs = new Map(subTopo.map((id) => [id, []]));
      graph.edges.filter((e) => downSet.has(e.target)).forEach((e) => {
        if (e.source === sNode.id && e.sourceHandle === resumedPort) initInputs.get(e.target)?.push({ from: sNode.id, output: resumedOut });
        else if (!downSet.has(e.source) && nodeStatesJson[e.source]?.status === 'completed' && (nodeStatesJson[e.source].nextPorts || [nodeStatesJson[e.source].nextPort || 'main']).includes(e.sourceHandle)) initInputs.get(e.target)?.push({ from: e.source, output: nodeStatesJson[e.source].output });
      });
      const execRes = await runWithOrmDepth(Number(event.depth || 0) + 1, () => traverseDag({ graph, subTopo, nodeMap, edges: graph.edges, initialInputs: initInputs, execState, nodeStatesJson, stepTracesJson, reg, db, app: scopedOpts.app || db?.app, options: scopedOpts, helpers: buildNodeHelpers(db, scopedOpts.app || db?.app, scopedOpts, execState) }));
      return finalizeDagRun(db, { organizationId: orgId, runUid: run.runUid, execRes, execState, nodeStatesJson, stepTracesJson, triggerPayloadJson: isPlainObject(run.triggerPayloadJson) ? tp : { event, data: event.data, record: tp.record ?? null }, dryRun, fallbackRecord: run, startedMs: run.startedAt ? new Date(run.startedAt).getTime() : Date.now() });
    });
  } catch (err) {
    if (!dryRun) await runAutomationWithRls(db, orgId, () => db?.getRepository?.('latticeAutomationRuns')?.update?.({ filter: { organizationId: orgId, runUid: run.runUid }, values: { status: 'failed', errorMessage: err?.message || String(err), finishedAt: new Date() } })).catch(() => {});
    throw err;
  }
}
async function dispatchRecordTriggerEvent(db, eventCtx = {}, options = {}) {
  const [eng, collection, op] = [getEngine(), String(eventCtx.collection || '').trim(), String(eventCtx.operation || 'create').trim().toLowerCase()];
  const [operation, orgId, depth] = [op === 'destroy' ? 'delete' : op, String(eventCtx.organizationId || eventCtx.record?.organizationId || eventCtx.data?.organizationId || '').trim(), getOrmTriggerDepth({ depth: eventCtx.depth })];
  if (!collection || !orgId || !eng.isAllowlistedTargetCollection(collection)) return [];
  return runAutomationWithRls(db, orgId, async () => {
    const runs = [];
    for (const row of (await db?.getRepository?.('latticeAutomationRules')?.find({ filter: { organizationId: orgId, active: true }, limit: 500 })) || []) {
      const p = toPlain(row);
      const idx = Array.isArray(p?.triggerIndexJson) && p.triggerIndexJson.length ? p.triggerIndexJson : (p?.graphJson ? buildTriggerIndex(p.graphJson, p) : []);
      if (!idx.some((t) => t?.triggerType === 'record' && t.collection === collection && String(t.operation || 'create').toLowerCase() === operation)) continue;
      try { runs.push(await executeFlowGraph(db, row, { id: eventCtx.id || `rec_${crypto.randomUUID()}`, type: `record.${collection}.${operation}`, source: 'dxos-studio:orm', subject: String(eventCtx.recordId || eventCtx.record?.id || ''), organizationId: orgId, depth, data: eng.sanitizePlainObject(eventCtx.data || eventCtx.record || {}), record: eng.sanitizePlainObject(eventCtx.record || eventCtx.data || {}) }, options)); }
      catch (err) { runs.push({ ruleKey: val(row, 'ruleKey'), status: 'failed', errorMessage: err?.message || String(err) }); }
    }
    return runs;
  });
}
async function resolveWebhookSecret(db, orgId, ruleKey, trigCfg, rule, options) {
  if (options?.webhookSecret) return String(options.webhookSecret);
  const vault = options?.connectorVault || loadFoundationModule('connector-vault');
  for (const key of typeof vault?.resolveConnectorSecrets === 'function' ? [trigCfg?.connectorKey, trigCfg?.secretConnectorKey, `webhook:${ruleKey}`, `webhook-${ruleKey}`, trigCfg?.webhookPath, ruleKey].filter(Boolean) : []) {
    try { const { connector, secrets } = await vault.resolveConnectorSecrets(db, orgId, String(key), { env: options?.env }); if (connector?.connectorType !== 'webhook') continue; const s = secrets?.webhookSecret || secrets?.secret || secrets?.signingSecret || secrets?.hmacSecret || secrets?.token || secrets?.bearerToken || secrets?.apiKey; if (s) return String(s); }
    catch (err) { if (err?.code !== 'CONNECTOR_NOT_FOUND') throw err; }
  }
  return String(rule?.webhookSecret || trigCfg?.secret || '');
}
async function dispatchWebhookIngress(db, { organizationId, ruleKey, headers = {}, rawBody, parsedBody, options = {} } = {}) {
  const [orgId, key] = [String(organizationId || '').trim(), String(ruleKey || '').trim()];
  if (!orgId || !key) throw fail('WEBHOOK_INVALID_TARGET', 400, 'organizationId and ruleKey are required');
  return runAutomationWithRls(db, orgId, async () => {
    const ruleRow = await db?.getRepository?.('latticeAutomationRules')?.findOne({ filter: { organizationId: orgId, ruleKey: key } });
    const rule = toPlain(ruleRow);
    if (!rule || rule.active === false) throw fail('RULE_NOT_FOUND', 404, `Active webhook rule "${key}" not found`);
    const trig = resolveNormalizedRuleAndGraph(rule, options).graph.nodes.find((n) => n.type === 'trigger.webhook');
    if (!trig) throw fail('WEBHOOK_TRIGGER_NOT_CONFIGURED', 400, 'Rule does not declare a trigger.webhook node');
    const secret = await resolveWebhookSecret(db, orgId, key, trig.config, rule, options);
    if (!secret) throw fail('WEBHOOK_SIGNATURE_INVALID', 401, 'Webhook secret is not configured');
    const [hasRawBody, authMode] = [typeof rawBody === 'string' || Buffer.isBuffer(rawBody), String(trig.config?.authMode || 'hmac').toLowerCase()];
    const payloadText = typeof rawBody === 'string' ? rawBody : (Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : JSON.stringify(parsedBody ?? {}));
    if (authMode === 'bearer') {
      const auth = getHeader(headers, 'authorization');
      if (!auth.startsWith('Bearer ') || !auth.slice(7).trim() || !timingSafeEqualHex(sha256Hex(auth.slice(7).trim()), sha256Hex(secret))) throw fail('WEBHOOK_SIGNATURE_INVALID', 401, 'Invalid or missing webhook bearer token');
    } else {
      const sigHeader = getHeader(headers, trig.config?.secretHeader || 'X-Lattice-Signature-256');
      const [providedHex, expectedHex] = [sigHeader.startsWith('sha256=') ? sigHeader.slice(7).trim() : sigHeader.trim(), crypto.createHmac('sha256', secret.startsWith('whsec_') ? Buffer.from(secret.slice(6), 'base64') : secret).update(payloadText, 'utf8').digest('hex')];
      const stdOk = !sigHeader && getHeader(headers, 'webhook-signature') && loadFoundationModule('event-bus')?.verifyStandardWebhookSignature?.({ webhookId: getHeader(headers, 'webhook-id'), timestamp: getHeader(headers, 'webhook-timestamp'), body: payloadText, signature: getHeader(headers, 'webhook-signature'), secret });
      if (!stdOk && !timingSafeEqualHex(providedHex, expectedHex)) throw fail('WEBHOOK_SIGNATURE_INVALID', 401, 'Invalid or missing webhook HMAC signature');
    }
    const bodyObj = hasRawBody ? (() => { try { const p = JSON.parse(payloadText || '{}'); return isPlainObject(p) ? p : {}; } catch { return {}; } })() : (isPlainObject(parsedBody) ? parsedBody : {});
    const run = await executeFlowGraph(db, ruleRow, { type: 'webhook.inbound', source: 'dxos-studio:webhook', subject: trig.config?.webhookPath || key, organizationId: orgId, data: isPlainObject(bodyObj.data) ? bodyObj.data : (isPlainObject(bodyObj) ? bodyObj : {}), webhook: { webhookPath: trig.config?.webhookPath || '', authMode } }, { ...options, organizationId: orgId, ignoreCooldown: options.ignoreCooldown ?? false });
    return { runUid: run.runUid, status: run.status };
  });
}
async function tickDueDelayedRuns(db, options = {}) {
  const runsRepo = db?.getRepository?.('latticeAutomationRuns');
  const [limit, nowMs, results] = [Math.min(50, Math.max(1, Number(options.batchSize) || 50)), options.now ? new Date(options.now).getTime() : Date.now(), []];
  if (!runsRepo?.find || !Number.isFinite(nowMs)) return { processedCount: 0, results };
  const rows = await runAutomationWithRls(db, options.organizationId, () => runsRepo.find({ filter: { status: 'suspended', ...(options.organizationId ? { organizationId: options.organizationId } : {}) }, limit }));
  for (const r of (rows || []).map(toPlain)) {
    const resumeMs = r?.resumeAt ? new Date(r.resumeAt).getTime() : NaN;
    if (!r || r.status !== 'suspended' || !Number.isFinite(resumeMs) || resumeMs > nowMs || r.approvalId != null || r.nodeStatesJson?.[r.suspendedNodeId]?.suspend?.kind === 'approval') continue;
    await runAutomationWithRls(db, r.organizationId, async () => {
      try { results.push({ runUid: r.runUid, status: (await resumeFlowRun(db, { organizationId: r.organizationId, runUid: r.runUid, decision: 'main', actor: { username: 'system:delay-ticker' }, options })).status }); }
      catch (err) { results.push({ runUid: r.runUid, status: 'skipped', error: err?.message || String(err) }); }
    });
  }
  return { processedCount: results.length, results };
}
module.exports = { executeFlowGraph, dryRunFlowGraph, testSingleFlowNode, resumeFlowRun, dispatchRecordTriggerEvent, dispatchWebhookIngress, tickDueDelayedRuns };
