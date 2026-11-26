/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
const YAML_UNSAFE_RE = /^$|^\s|\s$|^(?:true|false|null|~)$|^-?\d+(?:\.\d+)?$|^[-?:]|[\r\n\t'"#{}[\]&*!|>%@`]|:\s|:$/i;
const V1_NODE_MAP = {
  create_record: 'data.create', update_record: 'data.update', notify_role: 'notify.send',
  call_connector: 'integration.http', twin_set_desired: 'iot.twin_command', trigger_ai_triage: 'ai.agent',
};

function sanitizeSafeValue(v, seen = new WeakSet()) {
  if (v == null || typeof v !== 'object') return v;
  if (seen.has(v)) return undefined;
  seen.add(v);
  if (Array.isArray(v)) return v.map((x) => sanitizeSafeValue(x, seen));
  const out = {};
  for (const k of Object.keys(v)) {
    if (BLOCKED_KEYS.has(k)) continue;
    const next = sanitizeSafeValue(v[k], seen);
    if (next !== undefined) out[k] = next;
  }
  return out;
}

function safeJsonParse(text) {
  try {
    const rev = (k, v) => { if (BLOCKED_KEYS.has(k)) throw new Error(`Forbidden key "${k}"`); return v; };
    return { ok: true, value: sanitizeSafeValue(JSON.parse(String(text || ''), rev)) };
  } catch (err) {
    return { ok: false, error: err?.message || 'Invalid JSON' };
  }
}

const fmtYv = (v) => (v == null ? 'null' : typeof v !== 'string' ? String(v) : (YAML_UNSAFE_RE.test(v) ? JSON.stringify(v) : v));

function toYaml(v, pad = 0) {
  const sp = ' '.repeat(pad);
  if (Array.isArray(v)) {
    return !v.length ? [`${sp}[]`] : v.flatMap((it) => {
      if (!isObj(it) && !Array.isArray(it)) return [`${sp}- ${fmtYv(it)}`];
      const sub = toYaml(it, pad + 2);
      return [`${sp}- ${sub[0].trimStart()}`, ...sub.slice(1)];
    });
  }
  if (!isObj(v)) return [`${sp}${fmtYv(v)}`];
  const ents = Object.entries(v).filter(([k, val]) => !BLOCKED_KEYS.has(k) && val !== undefined);
  return !ents.length ? [`${sp}{}`] : ents.flatMap(([k, val]) => {
    const fk = /^[A-Za-z0-9_.-]+$/.test(k) ? k : JSON.stringify(k);
    if ((Array.isArray(val) && !val.length) || (isObj(val) && !Object.keys(val).length)) {
      return [`${sp}${fk}: ${Array.isArray(val) ? '[]' : '{}'}`];
    }
    return (Array.isArray(val) || isObj(val)) ? [`${sp}${fk}:`, ...toYaml(val, pad + 2)] : [`${sp}${fk}: ${fmtYv(val)}`];
  });
}

const parseScalar = (raw, s = raw.trim()) => (
  s === '[]' ? [] : s === '{}' ? {} : (s === 'null' || s === '~' || s === '') ? null
    : (s === 'true' || s === 'false') ? s === 'true'
      : (s.startsWith('"') && s.endsWith('"')) ? JSON.parse(s)
        : (s.startsWith("'") && s.endsWith("'")) ? s.slice(1, -1).replace(/''/g, "'")
          : (/^-?\d+(?:\.\d+)?$/.test(s) ? Number(s) : s)
);

function splitYamlKv(txt) {
  for (let i = 0, q = null; i < txt.length; i += 1) {
    if (q) {
      if (txt[i] === '\\' && q === '"') i += 1;
      else if (txt[i] === q) q = null;
    } else if (txt[i] === '"' || txt[i] === "'") q = txt[i];
    else if (txt[i] === ':' && (i + 1 === txt.length || txt[i + 1] === ' ')) {
      const rk = txt.slice(0, i).trim();
      const k = rk.startsWith('"') ? JSON.parse(rk) : (rk.startsWith("'") ? rk.slice(1, -1).replace(/''/g, "'") : rk);
      if (BLOCKED_KEYS.has(k)) throw new Error(`Forbidden key "${k}"`);
      return { k, rest: txt.slice(i + 1).trim() };
    }
  }
  return null;
}

function parseYamlBlock(toks, start, minInd) {
  const isSeq = (t) => t.t === '-' || t.t.startsWith('- ');
  const readV = (kv, idx, ind) => (kv.rest !== ''
    ? { v: parseScalar(kv.rest), next: idx + 1 }
    : (idx + 1 < toks.length && toks[idx + 1].i > ind ? parseYamlBlock(toks, idx + 1, toks[idx + 1].i) : { v: null, next: idx + 1 }));
  let i = start;
  if (isSeq(toks[i])) {
    const arr = [];
    while (i < toks.length && toks[i].i === minInd && isSeq(toks[i])) {
      const after = toks[i].t.slice(1).trim();
      const kv = after ? splitYamlKv(after) : null;
      if (!after) { const s = parseYamlBlock(toks, i + 1, toks[i + 1]?.i ?? minInd + 2); arr.push(s.v); i = s.next; }
      else if (kv) {
        const itemInd = toks[i].i + 2;
        const r = readV(kv, i, itemInd);
        const obj = { [kv.k]: r.v };
        i = r.next;
        if (i < toks.length && toks[i].i === itemInd && !isSeq(toks[i])) { const rest = parseYamlBlock(toks, i, itemInd); Object.assign(obj, rest.v); i = rest.next; }
        arr.push(obj);
      } else { arr.push(parseScalar(after)); i += 1; }
    }
    return { v: arr, next: i };
  }
  const obj = {};
  while (i < toks.length && toks[i].i === minInd && !isSeq(toks[i])) {
    const kv = splitYamlKv(toks[i].t);
    if (!kv) throw new Error(`Invalid YAML: ${toks[i].t}`);
    const r = readV(kv, i, minInd);
    obj[kv.k] = r.v;
    i = r.next;
  }
  return { v: obj, next: i };
}

function parseDslText(text) {
  const tr = String(text || '').trim();
  if (!tr) return { ok: false, error: 'DSL text is empty' };
  if (tr.startsWith('{') || tr.startsWith('[')) return safeJsonParse(tr);
  try {
    const toks = String(text).split(/\r?\n/).map((r) => ({ i: r.length - r.trimStart().length, t: r.trim() })).filter((x) => x.t && !x.t.startsWith('#') && x.t !== '---' && x.t !== '...');
    if (!toks.length) return { ok: false, error: 'Empty YAML' };
    const res = parseYamlBlock(toks, 0, toks[0].i);
    return res.next < toks.length ? { ok: false, error: 'Invalid YAML indentation' } : { ok: true, value: sanitizeSafeValue(res.v) };
  } catch (err) {
    return { ok: false, error: err?.message || 'Invalid YAML' };
  }
}

const serializeFlowDsl = (obj, fmt) => (fmt === 'yaml' ? `${toYaml(sanitizeSafeValue(obj)).join('\n')}\n` : JSON.stringify(sanitizeSafeValue(obj), null, 2));

function nextCollisionFreeId(prefix, graph, startSeq = 1) {
  const pfx = String(prefix || 'node').replace(/[^A-Za-z0-9_-]/g, '_') || 'node';
  const used = new Set([
    ...(Array.isArray(graph?.nodes) ? graph.nodes : []).map((n) => n?.id).filter(Boolean).map(String),
    ...(Array.isArray(graph?.edges) ? graph.edges : []).map((e) => e?.id).filter(Boolean).map(String),
  ]);
  let seq = Math.max(1, Number.isFinite(Number(startSeq)) ? Math.floor(Number(startSeq)) : 1);
  while (used.has(`${pfx}_${seq}`)) seq += 1;
  return `${pfx}_${seq}`;
}

function ruleToGraph(r, opts) {
  const [a, b] = opts?.preferDraft ? [r?.draftGraphJson, r?.graphJson] : [r?.graphJson, r?.draftGraphJson];
  const g = isObj(a) && Array.isArray(a.nodes) ? a : (isObj(b) && Array.isArray(b.nodes) ? b : null);
  const baseSettings = { errorPolicy: 'stop', cooldownSec: Number(r?.cooldownSec || 0), maxDepth: Number(r?.maxDepth || 8), timeoutMs: 30000 };
  if (g) {
    const cleanG = sanitizeSafeValue(g), nodes = Array.isArray(cleanG.nodes) ? cleanG.nodes : [], rawEdges = Array.isArray(cleanG.edges) ? cleanG.edges : [];
    const usedIds = new Set([...nodes.map((n) => n?.id), ...rawEdges.map((e) => e?.id)].filter(Boolean).map((x) => String(x).trim()).filter(Boolean)), assigned = new Set();
    let edgeSeq = 1;
    const edges = rawEdges.map((raw) => {
      const e = isObj(raw) ? raw : {};
      let eid = e.id != null ? String(e.id).trim() : '';
      if (!eid || assigned.has(eid)) { while (usedIds.has(`edge_${edgeSeq}`)) edgeSeq += 1; eid = `edge_${edgeSeq++}`; usedIds.add(eid); }
      assigned.add(eid);
      return { ...e, id: eid };
    });
    return { version: 2, viewport: { x: 0, y: 0, zoom: 1 }, ...cleanG, nodes, edges, settings: { ...baseSettings, ...(isObj(cleanG.settings) ? cleanG.settings : {}) } };
  }
  const nodes = [{ id: 'trig_1', type: 'trigger.event', label: 'Event Trigger', position: { x: 80, y: 180 }, config: { eventType: r?.triggerEventType || '*' } }];
  const edges = [];
  (Array.isArray(r?.actionsJson) ? r.actionsJson : []).forEach((a, idx) => {
    const id = `step_${idx}`;
    nodes.push({ id, type: V1_NODE_MAP[a?.type] || a?.type || 'notify.send', label: a?.label || a?.type || id, position: { x: 80 + (idx + 1) * 260, y: 180 }, config: sanitizeSafeValue(a || {}) });
    edges.push({ id: nextCollisionFreeId('edge', { nodes, edges }), source: idx ? `step_${idx - 1}` : 'trig_1', sourceHandle: 'main', target: id, targetHandle: 'in' });
  });
  return { version: 2, nodes, edges, viewport: { x: 0, y: 0, zoom: 1 }, settings: baseSettings };
}

function makeBlankFlow(seed = 1) {
  const suffix = String(seed ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || '1';
  const settings = { errorPolicy: 'stop', cooldownSec: 0, maxDepth: 8, timeoutMs: 30000 };
  const trig = { id: 'trig_1', type: 'trigger.manual', label: 'Manual Trigger', position: { x: 80, y: 180 }, config: {} };
  return {
    rule: { ruleKey: `flow_rule_${suffix}`, name: 'New LatticeFlow', description: '', triggerEventType: 'manual.run', cooldownSec: 0, maxDepth: 8, active: true, sampleEvent: { type: 'manual.run', data: {} } },
    graph: { version: 2, nodes: [trig], edges: [], viewport: { x: 0, y: 0, zoom: 1 }, settings },
  };
}

function deriveTriggerEventType(graph, rule) {
  const trig = (Array.isArray(graph?.nodes) ? graph.nodes : []).find((n) => String(n?.type || '').startsWith('trigger.'));
  const tType = String(trig?.type || '');
  const cfg = isObj(trig?.config) ? trig.config : {};
  if (tType === 'trigger.record') return `record.${String(cfg.collection || '').trim() || '*'}.${String(cfg.operation || 'create').trim() || 'create'}`;
  if (tType === 'trigger.schedule') return 'schedule.cron';
  if (tType === 'trigger.webhook') return 'webhook.inbound';
  if (tType === 'trigger.manual') return 'manual.run';
  if (tType === 'trigger.event') return String(cfg.eventType || rule?.triggerEventType || '*').trim() || '*';
  return String(rule?.triggerEventType || '*').trim() || '*';
}

function applyOpsLocal(graph, ops) {
  const g = sanitizeSafeValue(graph || { version: 2, nodes: [], edges: [], settings: {} });
  for (const op of Array.isArray(ops) ? ops : []) {
    const k = op?.op || op?.type;
    if (k === 'update_settings' && isObj(op.settings)) g.settings = { ...(g.settings || {}), ...op.settings };
    else if (k === 'add_node' && isObj(op.node)) {
      const pos = op.node.position || { x: 200 + g.nodes.length * 180, y: 220 };
      g.nodes.push({ id: op.node.id || nextCollisionFreeId('n', g), type: op.node.type, label: op.node.label || op.node.type, position: pos, config: op.node.config || {} });
    } else if (k === 'update_node') {
      const tid = op.nodeId || op.id;
      g.nodes = g.nodes.map((n) => (n.id === tid ? { ...n, ...(op.label ? { label: op.label } : {}), config: isObj(op.config) ? op.config : { ...n.config, ...(op.configPatch || {}) } } : n));
    } else if (k === 'delete_node') {
      const id = op.nodeId || op.id;
      g.nodes = g.nodes.filter((n) => n.id !== id);
      g.edges = g.edges.filter((e) => e.source !== id && e.target !== id);
    } else if (k === 'connect_edge' && isObj(op.edge)) g.edges.push({ id: op.edge.id || nextCollisionFreeId('edge', g), sourceHandle: 'main', targetHandle: 'in', ...op.edge });
  }
  return g;
}

const getRunTraces = (run) => (Array.isArray(run?.stepTracesJson) ? run.stepTracesJson : (Array.isArray(run?.stepTraces) ? run.stepTraces : []));
const formatRunLabel = (run) => (!run || !(run.runUid || run.id) ? '' : `${run.runUid || run.id} · ${run.status || 'completed'} (${run.durationMs ?? 0}ms)`);

function buildRunOverlay(run, playbackIndex, graph) {
  if (!run) return { nodeStates: {}, activeNodeId: null, activeEdges: [] };
  const traces = getRunTraces(run);
  const limit = traces.length ? Math.max(0, Math.min(traces.length - 1, Number.isInteger(playbackIndex) ? playbackIndex : traces.length - 1)) : -1;
  const nodeStates = limit === traces.length - 1 && isObj(run.nodeStatesJson) ? sanitizeSafeValue(run.nodeStatesJson) : {};
  (limit >= 0 ? traces.slice(0, limit + 1) : []).forEach((t) => {
    if (t?.nodeId) nodeStates[t.nodeId] = { ...(nodeStates[t.nodeId] || {}), ...t, status: t.simulated && t.status === 'completed' ? 'simulated' : t.status };
  });
  const activeEdges = (Array.isArray(graph?.edges) ? graph.edges : []).filter((e) => {
    const [s, d] = [nodeStates[e.source], nodeStates[e.target]];
    if (!s || !d || s.status === 'skipped' || d.status === 'skipped') return false;
    const ports = Array.isArray(s.nextPorts) ? s.nextPorts : (s.nextPort ? [s.nextPort] : null);
    return !ports || ports.includes(e.sourceHandle || 'main');
  }).map((e) => e.id);
  return { nodeStates, activeNodeId: limit >= 0 ? (traces[limit]?.nodeId || null) : null, activeEdges };
}

module.exports = {
  BLOCKED_KEYS, isObj, sanitizeSafeValue, safeJsonParse, toYaml, parseYamlBlock,
  parseDslText, parseDsl: parseDslText, serializeFlowDsl, serializeDsl: serializeFlowDsl,
  nextCollisionFreeId, ruleToGraph, makeBlankFlow, deriveTriggerEventType,
  applyOpsLocal, getRunTraces, formatRunLabel, buildRunOverlay,
};
