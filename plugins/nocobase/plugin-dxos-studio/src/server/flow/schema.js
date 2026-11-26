/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { fail } = require('../wms-dmn-shared');
const { SYSTEM_PROTECTED_COLLECTIONS } = require('../solution-bundle');

const FLOW_SCHEMA_VERSION = 2;
const MAX_HARD_DEPTH = 8;
const MAX_FLOW_NODES = 50;
const MAX_LOOP_ITERATIONS = 100;
const BLOCKED_PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const RULE_KEY_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/;
const CUSTOM_COLLECTION_RE = /^latticeCustom[A-Z][A-Za-z0-9]{1,40}$/;

const ALLOWLISTED_BUSINESS_COLLECTIONS = new Set([
  'latticeRequests', 'latticeOrders', 'latticeOrderLines', 'latticeServiceTickets',
  'latticeParaDocuments', 'latticeIncidentCases', 'latticeLocations', 'latticeAssets', 'latticeAgentProposals',
]);
const FORBIDDEN_SYSTEM_COLLECTIONS = new Set([
  ...(SYSTEM_PROTECTED_COLLECTIONS || []),
  'latticePkiKeys', 'latticeCryptoLedger', 'latticeConnectors', 'latticeWebhookSubscriptions',
  'latticeWebhookDeliveries', 'latticeEventBus', 'latticeApiKeys', 'latticeDelegations',
  'latticeDecisionTables', 'latticeEpodRecords', 'latticeOrganizations', 'latticeAutomationRules', 'latticeAutomationRuns',
  'latticeAiMemory', 'latticeAiTraces', 'latticeAutomationRuleVersions', 'latticeA2aTasks',
  'latticeNotificationDeliveries', 'latticeApprovalPolicies', 'latticeApprovalRequests', 'latticePublicForms', 'latticePublicFormSubmissions',
]);
const STANDARD_PORTS = Object.freeze(['in', 'main', 'true', 'false', 'default', 'item', 'done', 'approved', 'rejected', 'error', 'case_0', 'case_1', 'case_2', 'case_3', 'case_4', 'case_5', 'case_6', 'case_7', 'case_8', 'case_9']);
const V1_TO_V2_TYPE = Object.freeze({
  create_record: 'data.create', update_record: 'data.update', notify_role: 'notify.send',
  call_connector: 'integration.http', twin_set_desired: 'iot.twin_command', trigger_ai_triage: 'ai.agent',
});
const V2_TO_V1_TYPE = Object.freeze(Object.fromEntries(Object.entries(V1_TO_V2_TYPE).map(([k, v]) => [v, k])));
const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);

function cloneSafe(v, seen = new WeakSet()) {
  if (v == null || typeof v !== 'object') return v;
  if (seen.has(v)) return undefined;
  seen.add(v);
  if (v instanceof Date) return new Date(v.getTime());
  if (Array.isArray(v)) return v.map((item) => cloneSafe(item, seen));
  const out = {};
  for (const key of Object.keys(v)) {
    if (BLOCKED_PROTO_KEYS.has(key)) continue;
    const next = cloneSafe(v[key], seen);
    if (next !== undefined) out[key] = next;
  }
  return out;
}
const sanitizePlainObject = cloneSafe;

const normalizeNode = (node, idx = 0) => {
  const r = isPlainObject(node) ? node : {};
  const id = String(r.id || '').trim() || `node_${idx + 1}`;
  const type = String(r.type || '').trim();
  const pos = isPlainObject(r.position) ? r.position : {};
  return {
    id, type, label: r.label != null && String(r.label).trim() !== '' ? String(r.label).trim() : type || id,
    position: { x: Number.isFinite(Number(pos.x)) ? Number(pos.x) : 80 + idx * 280, y: Number.isFinite(Number(pos.y)) ? Number(pos.y) : 160 },
    config: isPlainObject(r.config) ? cloneSafe(r.config) : {}, continueOnFail: Boolean(r.continueOnFail),
    ...(r.timeoutMs != null && Number.isFinite(Number(r.timeoutMs)) ? { timeoutMs: Number(r.timeoutMs) } : {}),
  };
};

const normalizeEdge = (edge, idx = 0) => {
  const r = isPlainObject(edge) ? edge : {};
  return {
    id: String(r.id || '').trim() || `edge_${idx + 1}`, source: String(r.source || '').trim(),
    sourceHandle: String(r.sourceHandle || r.sourcePort || 'main').trim() || 'main',
    target: String(r.target || '').trim(), targetHandle: String(r.targetHandle || r.targetPort || 'in').trim() || 'in',
    label: r.label != null && String(r.label) !== '' ? String(r.label) : null,
  };
};

function normalizeGraph(rawGraph) {
  const s = isPlainObject(rawGraph) ? rawGraph : {};
  const [vp, st] = [isPlainObject(s.viewport) ? s.viewport : {}, isPlainObject(s.settings) ? s.settings : {}];
  const [md, cd, tm] = [Number(st.maxDepth), Number(st.cooldownSec), Number(st.timeoutMs)];
  return {
    version: FLOW_SCHEMA_VERSION,
    nodes: (Array.isArray(s.nodes) ? s.nodes : []).map((n, i) => normalizeNode(n, i)),
    edges: (Array.isArray(s.edges) ? s.edges : []).map((e, i) => normalizeEdge(e, i)),
    viewport: { x: Number.isFinite(Number(vp.x)) ? Number(vp.x) : 0, y: Number.isFinite(Number(vp.y)) ? Number(vp.y) : 0, zoom: Number.isFinite(Number(vp.zoom)) ? Number(vp.zoom) : 1 },
    settings: {
      errorPolicy: st.errorPolicy === 'continue' ? 'continue' : 'stop',
      cooldownSec: Number.isFinite(cd) && cd >= 0 ? Math.floor(cd) : 0,
      maxDepth: Number.isInteger(md) && md >= 1 && md <= MAX_HARD_DEPTH ? md : MAX_HARD_DEPTH,
      timeoutMs: Number.isFinite(tm) && tm > 0 ? Math.floor(tm) : 30000,
    },
  };
}

function buildTriggerIndex(graph, legacyRule) {
  const triggers = (Array.isArray(graph?.nodes) ? graph.nodes : []).filter((n) => String(n?.type || '').startsWith('trigger.'));
  if (!triggers.length && legacyRule) {
    return [{ nodeId: 'trigger_1', triggerType: 'event', eventType: String(legacyRule.triggerEventType || '*').trim() || '*', collection: null, operation: null, cron: null, webhookPath: null }];
  }
  return triggers.map((n, i) => {
    const cfg = isPlainObject(n.config) ? n.config : {};
    const triggerType = String(n.type || '').slice(8) || 'event';
    const collection = cfg.collection ? String(cfg.collection).trim() : null;
    const operation = triggerType === 'record' ? String(cfg.operation || 'create').trim() : null;
    const defEvt = triggerType === 'record' && collection ? `record.${collection}.${operation}`
      : triggerType === 'schedule' ? 'schedule.cron' : triggerType === 'webhook' ? 'webhook.inbound' : triggerType === 'manual' ? 'manual.trigger' : '*';
    return {
      nodeId: String(n.id || `trigger_${i + 1}`), triggerType,
      eventType: cfg.eventType || cfg.pattern ? String(cfg.eventType || cfg.pattern).trim() : defEvt,
      collection, operation, cron: cfg.cron ? String(cfg.cron).trim() : null,
      webhookPath: cfg.webhookPath || cfg.path ? String(cfg.webhookPath || cfg.path).trim() : null,
    };
  });
}

const mapV1ActionConfig = (act, stepIndex) => {
  const type = String(act?.type || '').trim();
  const base = { stepIndex, ...(act?.branchLabel ? { branchLabel: String(act.branchLabel) } : {}), ...(typeof act?.stopOnError === 'boolean' ? { stopOnError: act.stopOnError } : {}) };
  if (type === 'create_record') return { ...base, collection: act.collection || act.targetCollection || '', values: cloneSafe(act.values || act.data || {}) };
  if (type === 'update_record') return { ...base, collection: act.collection || act.targetCollection || '', filter: cloneSafe(act.filter || null), recordId: act.recordId ?? null, values: cloneSafe(act.values || act.patch || {}), limit: act.limit ?? 20 };
  if (type === 'notify_role') return { ...base, roleNames: Array.isArray(act.roleNames) ? cloneSafe(act.roleNames) : Array.isArray(act.roles) ? cloneSafe(act.roles) : [String(act.role || 'ldx_operator')], category: act.category || 'automation', severity: act.severity || 'warning', title: act.title || '', body: act.body ?? act.message ?? '', targetCollection: act.targetCollection ?? null, targetRecordId: act.targetRecordId ?? null, targetPath: act.targetPath ?? null };
  if (type === 'call_connector') return { ...base, connectorKey: act.connectorKey || act.connector || '', method: act.method || 'POST', path: act.path || act.url || '', headers: isPlainObject(act.headers) ? cloneSafe(act.headers) : {}, body: cloneSafe(act.body ?? act.payload ?? {}), timeoutMs: act.timeoutMs };
  if (type === 'twin_set_desired') return { ...base, assetId: act.assetId ?? null, assetEntityId: act.assetEntityId ?? '', desiredPatch: cloneSafe(act.desiredPatch || act.desired || {}), downlinkUrl: act.downlinkUrl ?? null };
  if (type === 'trigger_ai_triage') return { ...base, targetCollection: act.targetCollection || 'latticeAssets', targetRecordId: act.targetRecordId ?? null, severity: act.severity || 'medium', recommendation: act.recommendation || act.summary || '', evidence: isPlainObject(act.evidence) ? cloneSafe(act.evidence) : null };
  return { ...base, ...cloneSafe(act || {}) };
};

function v1RuleToGraphV2(rule) {
  const r = isPlainObject(rule) ? rule : {};
  const nodes = [{ id: 'trigger_1', type: 'trigger.event', label: 'Event Trigger', position: { x: 80, y: 160 }, config: { eventType: String(r.triggerEventType || '*').trim() || '*' } }];
  const edges = [];
  let [spineX, edgeSeq, branchLane, tailId, tailPort, tailX] = [80, 1, 0, 'trigger_1', 'main', 80];
  const addEdge = (source, sourceHandle, target, targetHandle = 'in', label = null) => edges.push({ id: `edge_${edgeSeq++}`, source, sourceHandle, target, targetHandle, label });

  if (isPlainObject(r.filterJson) && Object.keys(r.filterJson).length > 0) {
    spineX += 280;
    nodes.push({ id: 'filter_1', type: 'control.if', label: 'Rule Filter', position: { x: spineX, y: 160 }, config: { condition: cloneSafe(r.filterJson), isRuleFilter: true } });
    addEdge(tailId, tailPort, 'filter_1');
    [tailId, tailPort, tailX] = ['filter_1', 'true', spineX];
  }
  if (r.dmnTableKey) {
    spineX += 280;
    nodes.push({ id: 'dmn_1', type: 'logic.dmn', label: `DMN: ${r.dmnTableKey}`, position: { x: spineX, y: 160 }, config: { tableKey: String(r.dmnTableKey).trim() } });
    addEdge(tailId, tailPort, 'dmn_1');
    [tailId, tailPort, tailX] = ['dmn_1', 'main', spineX];
  }
  for (let i = 0, actions = Array.isArray(r.actionsJson) ? r.actionsJson : []; i < actions.length; i += 1) {
    const act = isPlainObject(actions[i]) ? actions[i] : {};
    const v2Type = V1_TO_V2_TYPE[String(act.type || '').trim()] || String(act.type || '').trim();
    const hasWhen = isPlainObject(act.when) && Object.keys(act.when).length > 0;
    const stepId = `step_${i}`;
    let stepPos;
    if (hasWhen) {
      const by = 160 + (++branchLane) * 140;
      const ifId = `if_step_${i}`;
      nodes.push({ id: ifId, type: 'control.if', label: act.branchLabel || `Branch ${i + 1}`, position: { x: tailX + 280, y: by }, config: { condition: cloneSafe(act.when), branchLabel: act.branchLabel || null, stepIndex: i } });
      addEdge(tailId, tailPort, ifId);
      stepPos = { x: tailX + 560, y: by };
      addEdge(ifId, 'true', stepId, 'in', act.branchLabel || 'true');
    } else {
      spineX += 280;
      stepPos = { x: spineX, y: 160 };
      addEdge(tailId, tailPort, stepId);
      [tailId, tailPort, tailX] = [stepId, 'main', spineX];
    }
    nodes.push({ id: stepId, type: v2Type, label: act.label ? String(act.label) : v2Type, position: stepPos, config: mapV1ActionConfig(act, i), continueOnFail: act.stopOnError === false });
    if (isPlainObject(act.emitEvent) && act.emitEvent.type) {
      const emitId = `emit_step_${i}`;
      nodes.push({ id: emitId, type: 'event.emit', label: `Emit: ${act.emitEvent.type}`, position: { x: stepPos.x + 180, y: stepPos.y - 100 }, config: { eventType: String(act.emitEvent.type), subject: act.emitEvent.subject ? String(act.emitEvent.subject) : '', data: isPlainObject(act.emitEvent.data) ? cloneSafe(act.emitEvent.data) : {}, sourceStepId: stepId } });
      addEdge(stepId, 'main', emitId);
    }
  }
  return normalizeGraph({ version: FLOW_SCHEMA_VERSION, nodes, edges, settings: { errorPolicy: 'stop', cooldownSec: Number(r.cooldownSec ?? 0), maxDepth: Number(r.maxDepth ?? MAX_HARD_DEPTH), timeoutMs: 30000 } });
}

function mapV2NodeToV1Action(node, whenCond, emitEvent) {
  const cfg = isPlainObject(node.config) ? node.config : {};
  const v1Type = V2_TO_V1_TYPE[node.type];
  if (!v1Type) return null;
  const out = { type: v1Type, label: node.label, branchLabel: cfg.branchLabel ?? null, when: whenCond ? cloneSafe(whenCond) : null, ...(typeof cfg.stopOnError === 'boolean' ? { stopOnError: cfg.stopOnError } : {}), ...(emitEvent ? { emitEvent } : {}) };
  if (v1Type === 'create_record') return Object.assign(out, { collection: cfg.collection || '', values: cloneSafe(cfg.values || {}) });
  if (v1Type === 'update_record') return Object.assign(out, { collection: cfg.collection || '', filter: cloneSafe(cfg.filter || null), values: cloneSafe(cfg.values || {}) });
  if (v1Type === 'notify_role') return Object.assign(out, { role: Array.isArray(cfg.roleNames) ? cfg.roleNames[0] : (cfg.role || 'ldx_operator'), category: cfg.category || 'automation', severity: cfg.severity || 'warning', title: cfg.title || '', body: cfg.body || '', targetCollection: cfg.targetCollection ?? null, targetRecordId: cfg.targetRecordId ?? null, targetPath: cfg.targetPath ?? null });
  if (v1Type === 'call_connector') return Object.assign(out, { connectorKey: cfg.connectorKey || '', method: cfg.method || 'POST', path: cfg.path || '', body: cloneSafe(cfg.body || {}) });
  if (v1Type === 'twin_set_desired') return Object.assign(out, { assetId: cfg.assetId ?? null, assetEntityId: cfg.assetEntityId || '', desiredPatch: cloneSafe(cfg.desiredPatch || {}) });
  return Object.assign(out, { targetCollection: cfg.targetCollection || 'latticeAssets', targetRecordId: cfg.targetRecordId ?? null, severity: cfg.severity || 'medium', recommendation: cfg.recommendation || '' });
}

const parseCompatInt = (v, fb) => (v !== null && v !== undefined && typeof v !== 'boolean' && String(v).trim() !== '' && Number.isInteger(Number(v)) ? Number(v) : fb);
function graphV2SummaryToV1Compat(ruleOrGraph) {
  const src = isPlainObject(ruleOrGraph) ? ruleOrGraph : {};
  const rawGraph = isPlainObject(src.graphJson) ? src.graphJson : Array.isArray(src.nodes) ? src : null;
  const g = rawGraph ? normalizeGraph(rawGraph) : null;
  const nodesById = new Map((g?.nodes || []).map((n) => [n.id, n]));
  const filterNode = g?.nodes.find((n) => n.type === 'control.if' && (n.id === 'filter_1' || n.config?.isRuleFilter));
  const dmnNode = g?.nodes.find((n) => n.type === 'logic.dmn');
  const trigIdx = g ? buildTriggerIndex(g, src) : [];
  const actionsJson = [];
  if (g) {
    for (const node of g.nodes.filter((n) => Boolean(V2_TO_V1_TYPE[n.type])).sort((a, b) => Number(a.config?.stepIndex ?? 9999) - Number(b.config?.stepIndex ?? 9999))) {
      const inEdge = g.edges.find((e) => e.target === node.id && e.sourceHandle === 'true');
      const srcNode = inEdge ? nodesById.get(inEdge.source) : null;
      const whenCond = srcNode?.type === 'control.if' && !srcNode.config?.isRuleFilter ? srcNode.config?.condition : null;
      const emitNode = nodesById.get(g.edges.find((e) => e.source === node.id && nodesById.get(e.target)?.type === 'event.emit')?.target);
      const emitEvent = emitNode ? { type: emitNode.config?.eventType || '', ...(emitNode.config?.subject ? { subject: emitNode.config.subject } : {}), data: cloneSafe(emitNode.config?.data || {}) } : null;
      const mapped = mapV2NodeToV1Action(node, whenCond, emitEvent);
      if (mapped) actionsJson.push(mapped);
    }
  } else if (Array.isArray(src.actionsJson)) actionsJson.push(...cloneSafe(src.actionsJson));
  return {
    triggerEventType: String(src.triggerEventType || trigIdx[0]?.eventType || '*'),
    filterJson: src.filterJson !== undefined ? cloneSafe(src.filterJson) : filterNode ? cloneSafe(filterNode.config?.condition ?? null) : null,
    dmnTableKey: src.dmnTableKey ?? (dmnNode?.config?.tableKey || null),
    cooldownSec: parseCompatInt(src.cooldownSec, g?.settings?.cooldownSec ?? 0),
    maxDepth: parseCompatInt(src.maxDepth, g?.settings?.maxDepth ?? MAX_HARD_DEPTH),
    actionsJson,
  };
}

const YAML_UNSAFE_STR_RE = /^$|^\s|\s$|^(?:true|false|null|~)$|^-?\d+(?:\.\d+)?$|^[-?:]|[\r\n\t'"#{}[\]&*!|>%@`]|:\s|:$/i;
const formatYamlScalar = (v) => (v == null ? 'null' : typeof v !== 'string' ? String(v) : YAML_UNSAFE_STR_RE.test(v) ? JSON.stringify(v) : v);
const formatYamlKey = (k) => (/^[A-Za-z0-9_.-]+$/.test(k) ? k : JSON.stringify(k));

const toYamlLines = (val, indent = 0) => {
  const pad = ' '.repeat(indent);
  if (Array.isArray(val)) {
    return !val.length ? [`${pad}[]`] : val.flatMap((item) => ((Array.isArray(item) || isPlainObject(item))
      ? (() => { const sub = toYamlLines(item, indent + 2); return [`${pad}- ${sub[0].trimStart()}`, ...sub.slice(1)]; })()
      : [`${pad}- ${formatYamlScalar(item)}`]));
  }
  if (isPlainObject(val)) {
    const entries = Object.entries(val).filter(([k, v]) => !BLOCKED_PROTO_KEYS.has(k) && v !== undefined);
    return !entries.length ? [`${pad}{}`] : entries.flatMap(([k, v]) => {
      const fk = formatYamlKey(k);
      if (Array.isArray(v) && !v.length) return [`${pad}${fk}: []`];
      if (isPlainObject(v) && !Object.keys(v).length) return [`${pad}${fk}: {}`];
      return (Array.isArray(v) || isPlainObject(v)) ? [`${pad}${fk}:`, ...toYamlLines(v, indent + 2)] : [`${pad}${fk}: ${formatYamlScalar(v)}`];
    });
  }
  return [`${pad}${formatYamlScalar(val)}`];
};

const serializeFlowDsl = (ruleOrGraph, format = 'json') => {
  const clean = cloneSafe(ruleOrGraph);
  const fmt = String(format || 'json').trim().toLowerCase();
  if (fmt === 'json') return JSON.stringify(clean, null, 2);
  if (fmt === 'yaml' || fmt === 'yml') return `${toYamlLines(clean).join('\n')}\n`;
  throw fail('FLOW_DSL_FORMAT_UNSUPPORTED', 400, `Unsupported DSL format: ${format}`);
};

const scanUnquoted = (str, predicate) => {
  let quote = null;
  for (let i = 0; i < str.length; i += 1) {
    const ch = str[i];
    if (quote) { if (ch === '\\' && quote === '"') i += 1; else if (ch === quote) quote = null; }
    else if (ch === '"' || ch === "'") quote = ch;
    else if (predicate(ch, i)) return i;
  }
  return -1;
};

const parseYamlQuoted = (s) => { try { return JSON.parse(s); } catch (err) { throw fail('FLOW_DSL_PARSE_ERROR', 400, `Invalid YAML quoted string: ${err.message}`); } };

const parseYamlScalar = (raw) => {
  const s = raw.trim();
  if (s === '[]') return [];
  if (s === '{}') return {};
  if (s === 'null' || s === '~' || s === '') return null;
  if (s === 'true' || s === 'false') return s === 'true';
  if (s.startsWith('"') && s.endsWith('"')) return parseYamlQuoted(s);
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return /^-?\d+(?:\.\d+)?$/.test(s) ? Number(s) : s;
};

const splitYamlKeyVal = (text) => {
  const idx = scanUnquoted(text, (ch, i) => ch === ':' && (i + 1 === text.length || text[i + 1] === ' '));
  if (idx < 0) return null;
  const rk = text.slice(0, idx).trim();
  const key = rk.startsWith('"') ? parseYamlQuoted(rk) : rk.startsWith("'") ? rk.slice(1, -1).replace(/''/g, "'") : rk;
  if (BLOCKED_PROTO_KEYS.has(key)) throw fail('UNSAFE_TEMPLATE_EXPRESSION', 400, 'Forbidden prototype key in DSL');
  return { key, rest: text.slice(idx + 1).trim() };
};

function parseYamlLines(tokens, startIdx, minIndent) {
  if (startIdx >= tokens.length) return { value: null, nextIdx: startIdx };
  const isSeq = (t) => t.text === '-' || t.text.startsWith('- ');
  const readVal = (kv, idx, parentIndent) => (kv.rest !== '' ? { val: parseYamlScalar(kv.rest), nextIdx: idx + 1 }
    : (idx + 1 < tokens.length && tokens[idx + 1].indent > parentIndent)
      ? (() => { const s = parseYamlLines(tokens, idx + 1, tokens[idx + 1].indent); return { val: s.value, nextIdx: s.nextIdx }; })()
      : { val: null, nextIdx: idx + 1 });
  let i = startIdx;
  if (isSeq(tokens[i])) {
    const arr = [];
    while (i < tokens.length && tokens[i].indent === minIndent && isSeq(tokens[i])) {
      const after = tokens[i].text.slice(1).trim();
      const kv = after ? splitYamlKeyVal(after) : null;
      if (!after) { const s = parseYamlLines(tokens, i + 1, tokens[i + 1]?.indent ?? minIndent + 2); arr.push(s.value); i = s.nextIdx; }
      else if (kv) {
        const itemIndent = tokens[i].indent + 2;
        const r = readVal(kv, i, itemIndent);
        const obj = { [kv.key]: r.val };
        i = r.nextIdx;
        if (i < tokens.length && tokens[i].indent === itemIndent && !isSeq(tokens[i])) { const rest = parseYamlLines(tokens, i, itemIndent); Object.assign(obj, rest.value); i = rest.nextIdx; }
        arr.push(obj);
      } else { arr.push(parseYamlScalar(after)); i += 1; }
    }
    return { value: arr, nextIdx: i };
  }
  const obj = {};
  while (i < tokens.length && tokens[i].indent === minIndent && !isSeq(tokens[i])) {
    const kv = splitYamlKeyVal(tokens[i].text);
    if (!kv) throw fail('FLOW_DSL_PARSE_ERROR', 400, `Invalid YAML line: ${tokens[i].text}`);
    const r = readVal(kv, i, minIndent);
    obj[kv.key] = r.val;
    i = r.nextIdx;
  }
  return { value: obj, nextIdx: i };
}

function parseFlowDsl(text) {
  if (typeof text !== 'string' || !text.trim()) throw fail('FLOW_DSL_PARSE_ERROR', 400, 'Flow DSL text must be non-empty');
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { return cloneSafe(JSON.parse(trimmed, (k, v) => { if (BLOCKED_PROTO_KEYS.has(k)) throw fail('UNSAFE_TEMPLATE_EXPRESSION', 400, 'Forbidden prototype key in DSL'); return v; })); }
    catch (err) { if (err?.code === 'UNSAFE_TEMPLATE_EXPRESSION') throw err; throw fail('FLOW_DSL_PARSE_ERROR', 400, `Invalid JSON DSL: ${err.message}`); }
  }
  const tokens = text.split(/\r?\n/).reduce((acc, raw) => {
    const cIdx = scanUnquoted(raw, (ch, idx) => ch === '#' && (idx === 0 || raw[idx - 1] === ' '));
    const s = (cIdx >= 0 ? raw.slice(0, cIdx).trimEnd() : raw);
    const t = s.trim();
    if (t && t !== '---' && t !== '...') acc.push({ indent: s.length - s.trimStart().length, text: t });
    return acc;
  }, []);
  if (!tokens.length) throw fail('FLOW_DSL_PARSE_ERROR', 400, 'Empty YAML DSL document');
  const parsed = parseYamlLines(tokens, 0, tokens[0].indent);
  if (parsed.nextIdx < tokens.length) throw fail('FLOW_DSL_PARSE_ERROR', 400, `Unexpected YAML indentation near: ${tokens[parsed.nextIdx].text}`);
  return cloneSafe(parsed.value);
}

module.exports = {
  FLOW_SCHEMA_VERSION, MAX_HARD_DEPTH, MAX_FLOW_NODES, MAX_LOOP_ITERATIONS, BLOCKED_PROTO_KEYS, RULE_KEY_RE, CUSTOM_COLLECTION_RE,
  ALLOWLISTED_BUSINESS_COLLECTIONS, FORBIDDEN_SYSTEM_COLLECTIONS, STANDARD_PORTS, isPlainObject, cloneSafe, sanitizePlainObject,
  normalizeNode, normalizeEdge, normalizeGraph, buildTriggerIndex, v1RuleToGraphV2, graphV2SummaryToV1Compat, serializeFlowDsl, parseFlowDsl,
};
