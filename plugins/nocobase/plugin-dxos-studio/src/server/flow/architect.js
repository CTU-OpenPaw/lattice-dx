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
const { toPlain, val } = require('../wms-dmn-shared');
const {
  ALLOWLISTED_BUSINESS_COLLECTIONS, BLOCKED_PROTO_KEYS, CUSTOM_COLLECTION_RE, RULE_KEY_RE,
  buildTriggerIndex, cloneSafe, graphV2SummaryToV1Compat, isPlainObject,
  normalizeEdge, normalizeGraph, normalizeNode, v1RuleToGraphV2,
} = require('./schema');
const { hasUnsafeTemplateSyntax, isAllowlistedTargetCollection, validateFlowGraph, validatePromptSecurity } = require('./validator');
const { createDefaultRegistry, listNodeSchemas } = require('./registry');
const { callConfiguredLlm, redactPiiForLlm, resolveActiveLlmService } = require('./llm-client');
const { listFlowBlueprints } = require('./blueprints');

const LDX_ROLE_RE = /^ldx_[a-z0-9_]{2,40}$/;
const SENSITIVE_FIELD_RE = /password|secret|token|apikey|api_key|identitySubject|privateKey|hash|salt|signatureDataUrl|encrypted/i;
const VI_SECURITY_RE = /(?:bo qua (?:tat ca )?(?:huong dan|kiem tra|bao mat|quyen)|(?:bang|table|collection|vao|tren|trong|tao|ghi|sua|xoa|doc)\s+(?:the\s+)?(?:users|roles)\b)/i;
const DEFAULT_LDX_ROLES = Object.freeze(['ldx_admin', 'ldx_manager', 'ldx_operator', 'ldx_dispatcher', 'ldx_employee', 'ldx_viewer']);
const STANDARD_EVENT_CATALOG = Object.freeze([
  ['record.created', 'Record Created', 'record', 'dxos-studio:orm', { id: 1, code: 'REC-001', status: 'open', severity: 'medium' }],
  ['record.updated', 'Record Updated', 'record', 'dxos-studio:orm', { id: 1, code: 'REC-001', status: 'updated', severity: 'medium' }],
  ['alarm.triggered', 'Threshold Alarm', 'iot', 'dxos:alarm-engine', { assetId: 1, deviceKey: 'device-01', metricName: 'reading', numericValue: 95, severity: 'high' }],
  ['telemetry.threshold', 'Telemetry Threshold', 'iot', 'dxos:telemetry', { assetId: 1, deviceKey: 'sensor-01', metricName: 'value', numericValue: 88, threshold: 80, severity: 'high' }],
  ['voucher.submitted', 'Document Submitted', 'governance', 'dxos-studio:voucher', { collection: 'latticeOrders', recordId: 1, code: 'DOC-001', amount: 1500, severity: 'medium' }],
  ['sla.warning', 'SLA Warning', 'sla', 'dxos-sla', { targetCollection: 'latticeServiceTickets', recordId: 1, code: 'TKT-001', remainingMinutes: 15, priority: 'high' }],
  ['sla.breached', 'SLA Breached', 'sla', 'dxos-sla', { targetCollection: 'latticeServiceTickets', recordId: 1, code: 'TKT-001', overdueMinutes: 30, priority: 'urgent' }],
  ['schedule.cron', 'Scheduled Cron', 'schedule', 'dxos-studio:scheduler', { cron: '0 8 * * 1-5', timezone: 'UTC' }],
  ['webhook.inbound', 'Inbound Webhook', 'webhook', 'dxos-studio:webhook', { batchId: 'BATCH-01', items: [{ code: 'ITEM-1', qty: 10 }] }],
  ['manual.trigger', 'Manual / API Trigger', 'manual', 'dxos-studio:manual', { code: 'RUN-01', severity: 'medium', message: 'Manual flow run' }],
].map(([type, label, category, source, data]) => ({ type, label, category, sampleEvent: { type, source, subject: data.code || type, data } })));

const stripAccents = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();
const hasPos = (raw) => isPlainObject(raw?.position) && Number.isFinite(Number(raw.position.x)) && Number.isFinite(Number(raw.position.y));
const safeFind = async (db, repo, args) => { try { const r = await db?.getRepository?.(repo)?.find?.(args); return Array.isArray(r) ? r : []; } catch { return []; } };
const mergePatch = (base, patch) => {
  const out = isPlainObject(base) ? cloneSafe(base) : {};
  for (const [k, v] of Object.entries(isPlainObject(patch) ? cloneSafe(patch) : {})) out[k] = isPlainObject(v) && isPlainObject(out[k]) ? mergePatch(out[k], v) : v;
  return out;
};

function collectSafeFields(rawCol, fieldRows) {
  const map = new Map();
  const add = (f) => {
    const name = String(val(f, 'name') || '').trim();
    if (!name || BLOCKED_PROTO_KEYS.has(name) || SENSITIVE_FIELD_RE.test(name)) return;
    map.set(name, { name, type: String(val(f, 'type') || 'string'), title: String(val(f, 'title') || val(f, 'uiSchema')?.title || name) });
  };
  for (const row of Array.isArray(fieldRows) ? fieldRows : []) add(toPlain(row) || row);
  const cf = rawCol?.fields;
  if (cf instanceof Map) for (const f of cf.values()) add(f); else if (Array.isArray(cf)) for (const f of cf) add(f);
  return [...map.values()];
}

/** Builds tenant-scoped non-secret catalog for DX-OS Flow Studio & Flow Architect. */
async function buildFlowStudioCatalog(db, organizationId, options = {}) {
  const orgId = String(organizationId || '').trim();
  const [dmnRows, connRows, colRows, fieldRows, roleRows, llm] = await Promise.all([
    orgId ? safeFind(db, 'latticeDecisionTables', { filter: { organizationId: orgId }, limit: 200 }) : [],
    orgId ? safeFind(db, 'latticeConnectors', { filter: { organizationId: orgId }, limit: 200 }) : [],
    safeFind(db, 'collections', { limit: 500 }), safeFind(db, 'fields', { limit: 1000 }),
    safeFind(db, 'roles', { limit: 200 }), resolveActiveLlmService(db, options?.env ?? process.env),
  ]);
  const fieldsByCol = new Map();
  for (const row of fieldRows.map(toPlain)) if (row?.collectionName) fieldsByCol.set(String(row.collectionName).trim(), [...(fieldsByCol.get(String(row.collectionName).trim()) || []), row]);
  const colMap = new Map();
  const upsertCol = (name, obj) => {
    if (!isAllowlistedTargetCollection(name)) return;
    const prev = colMap.get(name);
    const fields = collectSafeFields(obj || db?.getCollection?.(name), fieldsByCol.get(name));
    colMap.set(name, { name, title: String(obj?.title || prev?.title || name), isCustom: CUSTOM_COLLECTION_RE.test(name), fields: fields.length ? fields : (prev?.fields || []) });
  };
  for (const name of ALLOWLISTED_BUSINESS_COLLECTIONS) upsertCol(name, null);
  for (const row of colRows.map(toPlain)) upsertCol(String(row?.name || '').trim(), row);
  if (db?.collections && typeof db.collections.entries === 'function') for (const [n, o] of db.collections.entries()) upsertCol(String(n || '').trim(), o);
  const foundRoles = [...new Set(roleRows.map((r) => String(val(r, 'name') || '').trim()).filter((n) => LDX_ROLE_RE.test(n)))];
  return {
    organizationId: orgId || null, llmConfigured: Boolean(llm?.configured),
    llmService: llm?.configured ? { source: llm.source, serviceName: llm.serviceName, provider: llm.provider, modelName: llm.modelName } : null,
    nodeTypes: listNodeSchemas(options?.nodeRegistry), eventTypes: cloneSafe(STANDARD_EVENT_CATALOG),
    dmnTables: dmnRows.map(toPlain).filter((r) => r && r.organizationId === orgId && r.active !== false).map((r) => ({ key: String(r.tableKey || ''), tableKey: String(r.tableKey || ''), name: String(r.name || r.tableKey || ''), description: r.description ? String(r.description) : null, hitPolicy: String(r.hitPolicy || 'FIRST'), version: Number(r.version) || 1, inputsJson: cloneSafe(r.inputsJson || []), outputsJson: cloneSafe(r.outputsJson || []) })),
    collections: [...colMap.values()].sort((a, b) => (a.isCustom !== b.isCustom ? (a.isCustom ? -1 : 1) : a.name.localeCompare(b.name))),
    connectors: connRows.map(toPlain).filter((r) => r && r.organizationId === orgId && r.active !== false).map((r) => ({ connectorKey: String(r.connectorKey || ''), name: String(r.name || r.connectorKey || ''), connectorType: String(r.connectorType || 'http_api'), baseUrl: r.baseUrl ? String(r.baseUrl) : null, authType: String(r.authType || 'none'), lastTestStatus: r.lastTestStatus ? String(r.lastTestStatus) : null })),
    roles: foundRoles.length ? foundRoles : [...DEFAULT_LDX_ROLES], blueprints: listFlowBlueprints(),
  };
}

/** Sequentially applies Graph v2 operations and computes structural graphDiff. */
function applyGraphOperations(baseGraph, ops = []) {
  const before = baseGraph ? normalizeGraph(cloneSafe(baseGraph)) : normalizeGraph({ version: 2, nodes: [], edges: [] });
  let work = cloneSafe(before);
  const explicitIds = new Set(before.nodes.map((n) => n.id));
  const uid = (base, list) => { let id = base; let i = 2; while (list.some((x) => x.id === id)) id = `${base}_${i++}`; return id; };
  const pushEdge = (raw) => {
    const e = normalizeEdge({ ...raw, id: raw.id || uid(`e_${raw.source}_${raw.sourceHandle || 'main'}_${raw.target}`, work.edges) }, work.edges.length);
    if (!work.edges.some((x) => x.source === e.source && x.sourceHandle === e.sourceHandle && x.target === e.target && x.targetHandle === e.targetHandle)) work.edges.push(e);
  };
  const addNode = (spec, pfx) => {
    const node = normalizeNode({ ...spec, id: spec.id ? String(spec.id).trim() : uid(`${pfx}_${work.nodes.length + 1}`, work.nodes) }, work.nodes.length);
    if (hasPos(spec)) explicitIds.add(node.id);
    work.nodes.push(node);
    return node;
  };
  for (const rawOp of Array.isArray(ops) ? ops : []) {
    const op = cloneSafe(rawOp);
    if (!isPlainObject(op)) continue;
    const kind = String(op.op || op.type || '').trim();
    if (kind === 'create_graph') {
      const s = isPlainObject(op.graph) ? op.graph : op;
      explicitIds.clear();
      for (const n of Array.isArray(s.nodes) ? s.nodes : []) if (hasPos(n) && n.id) explicitIds.add(String(n.id).trim());
      work = normalizeGraph({ version: 2, nodes: s.nodes || [], edges: s.edges || [], settings: s.settings || work.settings, viewport: s.viewport || work.viewport });
    } else if (kind === 'add_node') addNode(isPlainObject(op.node) ? op.node : { ...op, type: String(op.nodeType || (op.op && op.type !== kind ? op.type : '')).trim() }, 'node');
    else if (kind === 'update_node') {
      const t = work.nodes.find((n) => n.id === String(op.nodeId || op.id || '').trim());
      if (!t) continue;
      if (op.label != null && String(op.label).trim()) t.label = String(op.label).trim();
      const nextType = String(op.nodeType || (op.op && op.type !== kind ? op.type : '') || '').trim();
      if (nextType) t.type = nextType;
      if (isPlainObject(op.config)) t.config = cloneSafe(op.config);
      if (isPlainObject(op.configPatch)) t.config = mergePatch(t.config, op.configPatch);
      if (hasPos(op)) { t.position = { x: Number(op.position.x), y: Number(op.position.y) }; explicitIds.add(t.id); }
      if (typeof op.continueOnFail === 'boolean') t.continueOnFail = op.continueOnFail;
      if (op.timeoutMs != null && Number.isFinite(Number(op.timeoutMs))) t.timeoutMs = Number(op.timeoutMs);
    } else if (kind === 'update_settings' && isPlainObject(op.settings)) work.settings = { ...work.settings, ...op.settings };
    else if (kind === 'delete_node') {
      const nid = String(op.nodeId || op.id || '').trim();
      work.nodes = work.nodes.filter((n) => n.id !== nid);
      work.edges = work.edges.filter((e) => e.source !== nid && e.target !== nid);
    } else if (kind === 'connect_edge') pushEdge(isPlainObject(op.edge) ? op.edge : op);
    else if (kind === 'disconnect_edge') {
      const eid = String(op.edgeId || op.id || '').trim();
      work.edges = eid ? work.edges.filter((e) => e.id !== eid) : work.edges.filter((e) => !((!op.source || e.source === op.source) && (!op.target || e.target === op.target) && (!op.sourceHandle || e.sourceHandle === op.sourceHandle)));
    } else if (kind === 'insert_branch') {
      const [afterId, srcH] = [String(op.afterNodeId || '').trim(), String(op.sourceHandle || 'main').trim() || 'main'];
      const cNode = addNode({ type: 'control.if', ...(isPlainObject(op.conditionNode) ? op.conditionNode : { label: 'Condition' }) }, 'if');
      if (op.reconnectExisting !== false && !op.trueNode) for (const e of work.edges) if (e.source === afterId && e.sourceHandle === srcH) { e.source = cNode.id; e.sourceHandle = 'true'; }
      if (afterId && work.nodes.some((n) => n.id === afterId)) pushEdge({ source: afterId, sourceHandle: srcH, target: cNode.id, targetHandle: 'in' });
      for (const [spec, port] of [[op.trueNode, 'true'], [op.falseNode, 'false']]) if (isPlainObject(spec)) pushEdge({ source: cNode.id, sourceHandle: port, target: addNode(spec, port).id, targetHandle: 'in', label: port });
    }
  }
  const colOf = new Map(work.nodes.map((n) => [n.id, 0]));
  for (let p = 0, ch = true; p < work.nodes.length && ch; p += 1) {
    ch = false;
    for (const e of work.edges) if (colOf.has(e.source) && colOf.has(e.target) && e.source !== e.target && colOf.get(e.source) + 1 > colOf.get(e.target)) { colOf.set(e.target, Math.min(work.nodes.length, colOf.get(e.source) + 1)); ch = true; }
  }
  const lanes = new Map();
  for (const n of work.nodes) if (!explicitIds.has(n.id)) { const c = colOf.get(n.id) || 0; const r = lanes.get(c) || 0; lanes.set(c, r + 1); n.position = { x: 80 + c * 280, y: 120 + r * 150 }; }
  const graph = normalizeGraph(work);
  const [bN, aN, eKey] = [new Map(before.nodes.map((n) => [n.id, n])), new Map(graph.nodes.map((n) => [n.id, n])), (e) => `${e.source}|${e.sourceHandle}|${e.target}|${e.targetHandle}`];
  const [bE, aE] = [new Set(before.edges.map(eKey)), new Set(graph.edges.map(eKey))];
  const [bNode, bEdge] = [(n) => ({ id: n.id, type: n.type, label: n.label }), (e) => ({ id: e.id, source: e.source, sourceHandle: e.sourceHandle, target: e.target, targetHandle: e.targetHandle })];
  return { graph, graphDiff: { addedNodes: graph.nodes.filter((n) => !bN.has(n.id)).map(bNode), updatedNodes: graph.nodes.filter((n) => bN.has(n.id) && JSON.stringify(bN.get(n.id)) !== JSON.stringify(n)).map(bNode), removedNodes: before.nodes.filter((n) => !aN.has(n.id)).map(bNode), addedEdges: graph.edges.filter((e) => !bE.has(eKey(e))).map(bEdge), removedEdges: before.edges.filter((e) => !aE.has(eKey(e))).map(bEdge) } };
}

function scrubRunTrace(runTrace) {
  if (!isPlainObject(runTrace)) return null;
  const red = redactPiiForLlm(cloneSafe(runTrace)).redacted;
  const states = isPlainObject(red.nodeStatesJson) ? red.nodeStatesJson : {};
  const badSt = Object.entries(states).find(([, s]) => ['failed', 'error'].includes(String(s?.status || '').toLowerCase()));
  const badTr = (Array.isArray(red.stepTracesJson) ? red.stepTracesJson : []).find((t) => ['failed', 'error'].includes(String(t?.status || '').toLowerCase()) || t?.error);
  return { runUid: red.runUid || null, status: red.status || 'failed', failedNodeId: String(red.failedNodeId || red.nodeId || badSt?.[0] || badTr?.nodeId || '').trim() || null, error: String(red.errorMessage || badSt?.[1]?.error || badTr?.error || '').trim(), nodeStatesJson: states };
}

function buildSuggestionsForGraph(graph) {
  const g = normalizeGraph(graph || {});
  const out = [];
  const hasEdge = (id, h) => g.edges.some((e) => e.source === id && e.sourceHandle === h);
  if ((g.settings?.cooldownSec ?? 0) <= 0) out.push({ id: 'add_cooldown_guard', title: 'Enable 60s cooldown guard', reason: 'Prevents duplicate bursts.', severity: 'warning', targetNodeId: g.nodes[0]?.id || null, operations: [{ op: 'update_settings', settings: { cooldownSec: 60 } }] });
  const risky = g.nodes.find((n) => ['integration.http', 'ai.llm', 'data.create', 'data.update'].includes(n.type) && !hasEdge(n.id, 'error'));
  if (risky) out.push({ id: 'add_error_branch', title: `Add error branch on ${risky.label}`, reason: 'Notifies ldx_operator on failure.', severity: 'info', targetNodeId: risky.id, operations: [{ op: 'add_node', node: { id: `notify_err_${risky.id}`, type: 'notify.send', label: 'Error Alert', config: { roleNames: ['ldx_operator'], severity: 'critical', title: `Flow error on ${risky.id}` } } }, { op: 'connect_edge', edge: { source: risky.id, sourceHandle: 'error', target: `notify_err_${risky.id}`, targetHandle: 'in', label: 'error' } }] });
  const mut = g.nodes.find((n) => ['data.update', 'data.create', 'integration.http'].includes(n.type));
  if (mut && !g.nodes.some((n) => n.type === 'control.approval')) out.push({ id: 'add_hitl_approval', title: 'Add Human Approval (HITL) gate', reason: 'Requires manager sign-off.', severity: 'info', targetNodeId: mut.id, operations: [{ op: 'add_node', node: { id: 'approval_hitl', type: 'control.approval', label: 'Manager Approval', config: { approverRole: 'ldx_manager', title: 'Review flow execution', riskLevel: 'medium', ttlHours: 24 } } }] });
  const openIf = g.nodes.find((n) => n.type === 'control.if' && !hasEdge(n.id, 'false'));
  if (openIf) out.push({ id: 'add_else_branch', title: `Add false branch for ${openIf.label}`, reason: 'Handles non-matching cases.', severity: 'info', targetNodeId: openIf.id, operations: [{ op: 'add_node', node: { id: `notify_else_${openIf.id}`, type: 'notify.send', label: 'Fallback Notice', config: { roleNames: ['ldx_operator'], severity: 'info', title: 'Condition not matched' } } }, { op: 'connect_edge', edge: { source: openIf.id, sourceHandle: 'false', target: `notify_else_${openIf.id}`, targetHandle: 'in', label: 'false' } }] });
  return out;
}

function synthesizeOfflineFallback({ mode, prompt, baseGraph, targetNodeId, traceSummary, catalog }) {
  const pNorm = stripAccents(prompt);
  const pickCol = catalog.collections.find((c) => pNorm.includes(c.name.toLowerCase()))?.name || catalog.collections[0]?.name || 'latticeServiceTickets';
  const pickRole = catalog.roles.find((r) => pNorm.includes(r.toLowerCase())) || (/manager|giam doc|quan ly/.test(pNorm) ? 'ldx_manager' : 'ldx_operator');
  const pickConn = catalog.connectors.find((c) => pNorm.includes(c.connectorKey.toLowerCase()))?.connectorKey || catalog.connectors[0]?.connectorKey || '';
  const pickDmn = catalog.dmnTables.find((t) => pNorm.includes(t.tableKey.toLowerCase()))?.tableKey || null;
  const fbBase = baseGraph || normalizeGraph({ version: 2, nodes: [{ id: 'trig_1', type: 'trigger.manual', label: 'Manual Trigger', config: {} }], edges: [] });

  if (mode === 'suggest') { const suggestions = buildSuggestionsForGraph(fbBase); return { summary: `Generated ${suggestions.length} flow optimization suggestions.`, ops: [], base: fbBase, suggestions }; }
  if (mode === 'fix_error') {
    const target = fbBase.nodes.find((n) => n.id === traceSummary?.failedNodeId) || fbBase.nodes.find((n) => !n.type.startsWith('trigger.'));
    if (!target) return { error: 'No repairable node found in graph or runTrace.' };
    const patch = {};
    if (/collection|TARGET_COLLECTION_FORBIDDEN/i.test(traceSummary?.error || '')) patch[target.type === 'ai.agent' ? 'targetCollection' : 'collection'] = pickCol;
    if (target.type === 'data.update' && !target.config?.recordId && !Object.keys(target.config?.filter || {}).length) Object.assign(patch, { recordId: '{{data.id}}', filter: { id: '{{data.id}}' } });
    if (target.type === 'control.loop') patch.maxIterations = 50;
    if (target.type === 'trigger.schedule') patch.cron = '0 * * * *';
    const ops = [{ op: 'update_node', nodeId: target.id, continueOnFail: true, ...(['integration.http', 'ai.llm'].includes(target.type) ? { timeoutMs: 10000 } : {}), configPatch: patch }];
    if (!target.type.startsWith('trigger.') && !fbBase.edges.some((e) => e.source === target.id && e.sourceHandle === 'error')) {
      ops.push({ op: 'add_node', node: { id: `err_notify_${target.id}`, type: 'notify.send', label: 'Error Recovery Alert', config: { roleNames: ['ldx_operator'], severity: 'critical', title: `Recovered failure on ${target.id}` } } }, { op: 'connect_edge', edge: { source: target.id, sourceHandle: 'error', target: `err_notify_${target.id}`, targetHandle: 'in', label: 'error' } });
    }
    return { summary: `Repaired node "${target.id}" from error trace.`, ops, base: fbBase };
  }
  if (mode === 'node') {
    if (!baseGraph?.nodes?.length) return { error: 'Existing graph is required for node mode.' };
    const cleanTarget = String(targetNodeId || '').trim();
    const mapped = /^step:(\d+)$/i.test(cleanTarget) ? `step_${cleanTarget.slice(5)}` : null;
    const node = baseGraph.nodes.find((n) => n.id === cleanTarget || n.id === mapped || (cleanTarget === 'trigger' && n.type.startsWith('trigger.')));
    if (!node) return { error: `Target node "${cleanTarget || '(empty)'}" not found.` };
    const patch = {};
    const num = String(prompt || '').match(/(-?\d+(?:[.,]\d+)?)/);
    if (node.type === 'control.if' && num) patch.condition = { ...(node.config?.condition || { field: 'data.value', op: 'gt' }), value: Number(num[1].replace(',', '.')) };
    else if (node.type === 'control.approval' && LDX_ROLE_RE.test(pickRole)) patch.approverRole = pickRole;
    else if (node.type === 'notify.send') patch.roleNames = [pickRole];
    else if (node.type.startsWith('data.') && pNorm.includes(pickCol.toLowerCase())) patch.collection = pickCol;
    else patch.note = String(prompt || '').trim().slice(0, 140);
    return { summary: `Updated node "${node.id}" (${node.type}).`, ops: [{ op: 'update_node', nodeId: node.id, configPatch: patch }], base: baseGraph };
  }
  const cronMatch = String(prompt || '').match(/([0-9*/,-]+(?:\s+[0-9*/,-]+){4})/);
  const trig = cronMatch || /\bcron\b|\bschedule\b|lich chay|hang ngay|dinh ky/.test(pNorm) ? { id: 'trig_1', type: 'trigger.schedule', label: 'Schedule Trigger', config: { cron: cronMatch ? cronMatch[1] : '0 8 * * 1-5', timezone: 'UTC' } }
    : /khi tao|khi cap nhat|\brecord\b|ban ghi|\bcollection\b/.test(pNorm) || pNorm.includes(pickCol.toLowerCase()) ? { id: 'trig_1', type: 'trigger.record', label: `On ${pickCol}`, config: { collection: pickCol, operation: /cap nhat|\bupdate\b/.test(pNorm) ? 'update' : 'create', filterJson: null } }
      : /\bwebhook\b|\bcallback\b|\binbound\b/.test(pNorm) ? { id: 'trig_1', type: 'trigger.webhook', label: 'Inbound Webhook', config: { webhookPath: '/hooks/inbound', authMode: 'hmac', secretHeader: 'X-Lattice-Signature-256' } }
        : /\bmanual\b|thu cong|\bapi\b/.test(pNorm) ? { id: 'trig_1', type: 'trigger.manual', label: 'Manual Trigger', config: {} }
          : { id: 'trig_1', type: 'trigger.event', label: 'Event Trigger', config: { eventType: catalog.eventTypes.find((e) => pNorm.includes(e.type))?.type || '*' } };
  const [nodes, edges] = [[trig], []];
  let [tailId, tailPort] = [trig.id, 'main'];
  const chain = (node, nextPort = 'main') => { nodes.push(node); edges.push({ source: tailId, sourceHandle: tailPort, target: node.id, targetHandle: 'in' }); tailId = node.id; tailPort = nextPort; };
  if (pickDmn) chain({ id: 'dmn_1', type: 'logic.dmn', label: `DMN: ${pickDmn}`, config: { tableKey: pickDmn } });
  if (/\blap\b|moi dong|for each|batch/.test(pNorm)) chain({ id: 'loop_1', type: 'control.loop', label: 'Iterate Items', config: { itemsPath: 'data.items', maxIterations: 50 } }, 'item');
  const cmp = String(prompt || '').match(/([a-zA-Z_][a-zA-Z0-9_.]*)\s*(>=|<=|>|<|=)\s*(-?\d+(?:[.,]\d+)?)/) || String(prompt || '').match(/(>=|<=|>|<)\s*(-?\d+(?:[.,]\d+)?)/);
  if (cmp || /\bneu\b|\bif\b|vuot nguong/.test(pNorm)) {
    const opMap = { '>=': 'gte', '<=': 'lte', '>': 'gt', '<': 'lt', '=': 'eq' };
    const fld = cmp?.length === 4 ? (cmp[1].startsWith('data.') ? cmp[1] : `data.${cmp[1]}`) : 'data.value';
    const condition = cmp?.length === 4 ? { field: fld, op: opMap[cmp[2]], value: Number(cmp[3].replace(',', '.')) } : cmp?.length === 3 ? { field: fld, op: opMap[cmp[1]], value: Number(cmp[2].replace(',', '.')) } : { field: 'data.severity', op: 'eq', value: 'high' };
    chain({ id: 'if_1', type: 'control.if', label: 'Evaluate Condition', config: { condition } }, 'true');
  }
  if (/duyet|phe duyet|approval|hitl/.test(pNorm)) chain({ id: 'approval_1', type: 'control.approval', label: 'Manager Approval', config: { approverRole: pickRole, title: 'Approval Required: {{data.code}}', summary: 'Human review required', riskLevel: 'high', ttlHours: 24 } }, 'approved');
  if (/\bllm\b|tom tat|\bsummarize\b|\bai\b/.test(pNorm)) chain({ id: 'llm_1', type: 'ai.llm', label: 'AI Summary', config: { systemPrompt: 'Summarize input cleanly in JSON.', userPrompt: '{{data}}', responseFormat: 'json', fallbackOutput: { summary: 'Fallback summary' } } });
  if (pickConn && /connector|webhook|dong bo|sync|http/.test(pNorm)) chain({ id: 'http_1', type: 'integration.http', label: `Call ${pickConn}`, config: { connectorKey: pickConn, method: 'POST', path: '/sync', body: { eventType: '{{type}}', data: '{{data}}' } } });
  else if (/cap nhat|update/.test(pNorm)) chain({ id: 'upd_1', type: 'data.update', label: `Update ${pickCol}`, config: { collection: pickCol, recordId: '{{data.id}}', filter: { id: '{{data.id}}' }, values: { status: 'processed' } } });
  else if (/tao |create|ghi /.test(pNorm) && trig.type !== 'trigger.record') chain({ id: 'crt_1', type: 'data.create', label: `Create ${pickCol}`, config: { collection: pickCol, values: { code: 'FLOW-{{id}}', name: 'Generated {{type}}' } } });
  chain({ id: 'notify_1', type: 'notify.send', label: `Notify ${pickRole}`, config: { roleNames: [pickRole], severity: 'info', title: 'Flow Notification ({{type}})', body: 'Processed event {{subject}}' } });
  return { summary: `Synthesized ${nodes.length}-node DAG via offline architect.`, ops: [{ op: 'create_graph', nodes, edges }], base: null };
}

const refuse = (error, extra = {}) => ({ ok: false, refused: true, error, ...extra });

async function runLlmWithRepair({ db, env, mode, prompt, targetNodeId, baseGraph, catalog, traceSummary, reg, fetchImpl, lookupImpl, allowFallbackOnNetworkError }) {
  const sys = [
    'You are DX-OS Flow Architect. Output strict JSON: {"summary":string,"ruleKey"?:string,"name"?:string,"operations":Array,"sampleEvent"?:object,"suggestions"?:Array}.',
    `NodeTypes: ${catalog.nodeTypes.map((n) => `${n.type}(in:${n.inputs.join(',')};out:${n.outputs.join(',')})`).join(' | ')}`,
    `Collections: ${catalog.collections.map((c) => `${c.name}[${c.fields.map((f) => f.name).slice(0, 6).join(',')}]`).join('; ')}`,
    `DMN: ${catalog.dmnTables.map((t) => `${t.tableKey}(out:${(t.outputsJson || []).map((o) => o.name).join(',')})`).join(';') || 'none'} | Connectors: ${catalog.connectors.map((c) => c.connectorKey).join(',') || 'none'} | Roles: ${catalog.roles.join(',')}`,
    'Ops: create_graph, add_node, update_node, delete_node, connect_edge, disconnect_edge, insert_branch. Rules: 1 trigger.*, <=50 nodes, acyclic DAG, allowlisted/latticeCustom* collections only, safe {{path}} templates only.',
  ].join('\n');
  const messages = [{ role: 'system', content: sys }, { role: 'user', content: JSON.stringify({ mode, instruction: prompt || '', targetNodeId, currentGraph: baseGraph, errorTrace: traceSummary }) }];
  for (let attempt = 0; attempt <= 2; attempt += 1) {
    let llmRes;
    try { llmRes = await callConfiguredLlm({ db, env, messages, responseFormat: 'json', fetchImpl, lookupImpl }); }
    catch (err) { return { stop: refuse(err?.message || 'Unsafe LLM URL', { modeUsed: 'llm', repairAttempts: attempt, validationErrors: [{ code: err?.code || 'LLM_URL_UNSAFE', message: err?.message || 'Unsafe LLM URL' }] }) }; }
    if (!llmRes.ok) {
      if (llmRes.mode === 'unconfigured' || (allowFallbackOnNetworkError && !/UNSAFE|SSRF|FORBIDDEN/i.test(llmRes.code || ''))) return { fallback: true };
      if (/UNSAFE|SSRF|FORBIDDEN/i.test(llmRes.code || '')) return { stop: refuse(llmRes.reason, { modeUsed: 'llm', repairAttempts: attempt, validationErrors: [{ code: llmRes.code, message: llmRes.reason }] }) };
      return { stop: { ok: false, refused: false, modeUsed: 'llm', repairAttempts: attempt, code: llmRes.code, error: llmRes.reason || llmRes.code } };
    }
    const raw = llmRes.parsedJson;
    const errors = !isPlainObject(raw) ? [{ code: 'LLM_INVALID_JSON', message: 'Response must be a JSON object with operations.' }] : [];
    if (isPlainObject(raw)) {
      if (hasUnsafeTemplateSyntax(raw)) errors.push({ code: 'UNSAFE_TEMPLATE_EXPRESSION', message: 'Unsafe template or prototype key in LLM response.' });
      if (raw.ruleKey && !RULE_KEY_RE.test(String(raw.ruleKey).trim())) errors.push({ code: 'INVALID_RULE_KEY', message: 'Invalid ruleKey format.' });
      const ops = Array.isArray(raw.operations) ? raw.operations : isPlainObject(raw.graph) ? [{ op: 'create_graph', graph: raw.graph }] : (mode === 'suggest' ? [] : null);
      if (!ops) errors.push({ code: 'LLM_MISSING_OPERATIONS', message: 'operations array is required.' });
      else {
        const cand = applyGraphOperations(baseGraph, ops);
        const check = validateFlowGraph(cand.graph, { nodeRegistry: reg, requireTrigger: true });
        if (!check.ok) errors.push(...check.errors);
        if (!errors.length) return { ok: true, repairAttempts: attempt, applied: cand, llmParsed: cloneSafe(raw), summary: String(raw.summary || 'Flow Architect updated graph.').trim(), suggestions: Array.isArray(raw.suggestions) ? raw.suggestions : [] };
      }
    }
    if (attempt >= 2) return { stop: refuse('LLM output failed safety/DAG validation after self-repair', { modeUsed: 'llm', repairAttempts: attempt, validationErrors: errors }) };
    messages.push({ role: 'assistant', content: String(llmRes.content || '{}').slice(0, 3000) }, { role: 'user', content: `Validation failed with errors: ${JSON.stringify(errors)}. Fix all errors and return valid JSON.` });
  }
  return { fallback: true };
}

/** Runs DX-OS Flow Architect with fail-closed security, LLM 2-round repair loop, and offline fallback. */
async function runFlowArchitect({
  db, env = process.env, mode, prompt, rule, graph, targetNodeId, targetNode, runTrace,
  organizationId, fetchImpl, lookupImpl, nodeRegistry, dryRunRunner, sampleEvent, allowFallbackOnNetworkError = false,
} = {}) {
  const resolvedMode = String(mode || (runTrace && !prompt ? 'fix_error' : (targetNodeId || targetNode) ? 'node' : (graph || rule) && !prompt ? 'suggest' : 'full')).trim().toLowerCase();
  if (!['full', 'node', 'suggest', 'fix_error'].includes(resolvedMode)) return refuse(`Unsupported Flow Architect mode "${resolvedMode}".`);
  if ((resolvedMode === 'full' || resolvedMode === 'node') && !String(prompt || '').trim()) return refuse(`Prompt is required when mode is "${resolvedMode}".`);
  const cleanTarget = String(targetNodeId || targetNode || '').trim() || null;
  const sec = validatePromptSecurity({ prompt, targetNode: cleanTarget, rule, graph: resolvedMode === 'fix_error' ? null : graph });
  if (sec.refused || VI_SECURITY_RE.test(stripAccents(prompt)) || hasUnsafeTemplateSyntax(graph) || hasUnsafeTemplateSyntax(runTrace)) return refuse(sec.error || 'Security policy refused unsafe prompt, prototype key, or system target.');
  const reg = nodeRegistry || createDefaultRegistry();
  const catalog = await buildFlowStudioCatalog(db, organizationId, { env, nodeRegistry: reg });
  const rawG = isPlainObject(graph) && Array.isArray(graph.nodes) ? graph : isPlainObject(rule?.graphJson) && Array.isArray(rule.graphJson.nodes) ? rule.graphJson : isPlainObject(rule?.draftGraphJson) && Array.isArray(rule.draftGraphJson.nodes) ? rule.draftGraphJson : null;
  const baseGraph = rawG ? normalizeGraph(cloneSafe(rawG)) : isPlainObject(rule) ? v1RuleToGraphV2(rule) : null;
  const traceSummary = scrubRunTrace(runTrace);

  let [modeUsed, repairAttempts, summary, applied, llmParsed, suggestions] = ['offline-fallback', 0, '', null, null, []];
  if (catalog.llmConfigured) {
    const llmOut = await runLlmWithRepair({ db, env, mode: resolvedMode, prompt, targetNodeId: cleanTarget, baseGraph, catalog, traceSummary, reg, fetchImpl, lookupImpl, allowFallbackOnNetworkError });
    if (llmOut.stop) return llmOut.stop;
    if (llmOut.ok) ({ repairAttempts, applied, llmParsed, summary, suggestions } = llmOut, modeUsed = 'llm');
  }
  if (!applied) {
    const fb = synthesizeOfflineFallback({ mode: resolvedMode, prompt, baseGraph, targetNodeId: cleanTarget, traceSummary, catalog });
    if (fb.error) return refuse(fb.error, { modeUsed, repairAttempts: 0 });
    modeUsed = 'offline-fallback';
    applied = applyGraphOperations(fb.base, fb.ops);
    summary = fb.summary;
    suggestions = fb.suggestions || buildSuggestionsForGraph(applied.graph);
  }
  const finalCheck = validateFlowGraph(applied.graph, { nodeRegistry: reg, requireTrigger: true });
  if (!finalCheck.ok) return refuse(finalCheck.errors[0]?.message || 'Flow failed validation', { modeUsed, repairAttempts, validationErrors: finalCheck.errors });
  const trigIdx = buildTriggerIndex(applied.graph, rule);
  const compat = graphV2SummaryToV1Compat({ ...(isPlainObject(rule) ? rule : {}), graphJson: applied.graph });
  const hash = crypto.createHash('sha256').update(String(prompt || resolvedMode)).digest('hex').slice(0, 6);
  const slug = stripAccents(prompt || 'flow').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 28);
  const rawKey = String(rule?.ruleKey || llmParsed?.ruleKey || `flow_${slug || 'rule'}_${hash}`).trim();
  const draftRule = {
    schemaVersion: 2, ruleKey: RULE_KEY_RE.test(rawKey) ? rawKey : `flow_rule_${hash}`,
    name: String(rule?.name || llmParsed?.name || summary || 'Automated Flow').trim().slice(0, 120),
    description: String(rule?.description || (prompt ? `Generated by DX-OS Flow Architect: ${String(prompt).trim().slice(0, 160)}` : 'DX-OS Flow Architect draft')),
    triggerEventType: compat.triggerEventType || trigIdx[0]?.eventType || '*', triggerIndexJson: trigIdx, graphJson: applied.graph, ...compat, active: rule?.active !== undefined ? Boolean(rule.active) : true,
  };
  const resolvedSample = cloneSafe(
    [sampleEvent, llmParsed?.sampleEvent].find((s) => isPlainObject(s) && !hasUnsafeTemplateSyntax(s))
    || (catalog.eventTypes.find((e) => e.type === String(trigIdx[0]?.eventType || '').split(',')[0].trim()) || catalog.eventTypes[catalog.eventTypes.length - 1]).sampleEvent,
  );
  let dryRunPreview = null;
  if (typeof dryRunRunner === 'function') dryRunPreview = await dryRunRunner(db, draftRule, resolvedSample);
  else if (dryRunRunner !== false && dryRunRunner !== null && db) {
    try { const execMod = require('./executor'); if (typeof execMod?.dryRunFlowGraph === 'function') dryRunPreview = await execMod.dryRunFlowGraph(db, draftRule, resolvedSample, { organizationId, env, fetchImpl, lookupImpl, nodeRegistry: reg }); }
    catch (err) { if (/UNSAFE|SSRF|FORBIDDEN/i.test(err?.code || '')) throw err; }
  }
  return { ok: true, refused: false, mode: resolvedMode, modeUsed, repairAttempts, summary, graphDiff: applied.graphDiff, draftGraph: applied.graph, draftRule, sampleEvent: resolvedSample, suggestions, dryRunPreview };
}

module.exports = { STANDARD_EVENT_CATALOG, buildFlowStudioCatalog, applyGraphOperations, runFlowArchitect };
