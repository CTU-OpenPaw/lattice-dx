/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

function isMissingFieldValue(val) {
  if (val === undefined || val === null) return true;
  if (Array.isArray(val)) return val.length === 0;
  if (typeof val === 'string') return val.trim() === '';
  return false;
}

function detectGraphCycles(nodes, edges) {
  const state = new Map();
  const adj = new Map();
  for (const n of nodes) {
    state.set(n.id, 0);
    adj.set(n.id, []);
  }
  for (const e of edges) {
    if (e?.source && e?.target && adj.has(e.source) && state.has(e.target)) {
      adj.get(e.source).push(e.target);
    }
  }
  const cycleNodes = new Set();
  const dfs = (u) => {
    state.set(u, 1);
    for (const v of adj.get(u) || []) {
      const st = state.get(v);
      if (st === 1) cycleNodes.add(v);
      else if (st === 0) dfs(v);
    }
    state.set(u, 2);
  };
  for (const n of nodes) {
    if (state.get(n.id) === 0) dfs(n.id);
  }
  return [...cycleNodes];
}

function validateFlowClient(graph, nodeTypes = []) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const schemaMap = new Map((Array.isArray(nodeTypes) ? nodeTypes : []).filter((s) => s?.type).map((s) => [s.type, s]));
  const nodeIds = new Set(nodes.map((n) => n?.id).filter(Boolean));
  const errors = [];
  const warnings = [];
  const inDeg = new Map(nodes.map((n) => [n.id, 0]));

  const hasTrigger = nodes.some((n) => String(n?.type || '').startsWith('trigger.'));
  if (!hasTrigger) {
    errors.push({ nodeId: nodes[0]?.id || null, severity: 'error', message: 'Cần ít nhất 1 Trigger node ở đầu quy trình.' });
  }

  for (const n of nodes) {
    if (!n || !n.id) continue;
    const schema = schemaMap.get(n.type);
    const fields = Array.isArray(schema?.inputSchema?.fields) ? schema.inputSchema.fields : [];
    const cfg = n.config && typeof n.config === 'object' ? n.config : {};
    for (const f of fields) {
      if (f?.required && isMissingFieldValue(cfg[f.name])) {
        errors.push({ nodeId: n.id, severity: 'error', message: `${n.label || n.id}: thiếu trường "${f.label || f.name}".` });
      }
    }
  }

  for (const e of edges) {
    if (!e?.source || !e?.target || !nodeIds.has(e.source) || !nodeIds.has(e.target)) {
      const anchor = nodeIds.has(e?.source) ? e.source : (nodeIds.has(e?.target) ? e.target : null);
      errors.push({ nodeId: anchor, severity: 'error', message: `Nhánh nối "${e?.id || `${e?.source}->${e?.target}`}" trỏ tới node không tồn tại.` });
      continue;
    }
    inDeg.set(e.target, (inDeg.get(e.target) || 0) + 1);
  }

  for (const cycId of detectGraphCycles(nodes, edges)) {
    errors.push({ nodeId: cycId, severity: 'error', message: `Phát hiện vòng lặp (cycle) đi qua node "${cycId}".` });
  }

  if (nodes.length > 1) {
    for (const n of nodes) {
      if (!String(n?.type || '').startsWith('trigger.') && (inDeg.get(n.id) || 0) === 0) {
        warnings.push({ nodeId: n.id, severity: 'warning', message: `Node "${n.label || n.id}" chưa có kết nối đầu vào.` });
      }
    }
  }

  const byNodeId = {};
  for (const issue of [...errors, ...warnings]) {
    if (!issue.nodeId) continue;
    if (!byNodeId[issue.nodeId]) byNodeId[issue.nodeId] = [];
    byNodeId[issue.nodeId].push(issue);
  }
  return { errors, warnings, byNodeId, valid: errors.length === 0 };
}

const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function safeCloneVal(v, seen = new WeakSet()) {
  if (v === null || v === undefined || typeof v !== 'object') return v;
  if (seen.has(v)) return undefined;
  seen.add(v);
  if (Array.isArray(v)) return v.map((x) => safeCloneVal(x, seen));
  const out = {};
  for (const k of Object.keys(v)) {
    if (!BLOCKED_KEYS.has(k)) {
      const next = safeCloneVal(v[k], seen);
      if (next !== undefined) out[k] = next;
    }
  }
  return out;
}

function tryParseSafeJson(text) {
  try {
    const rev = (k, v) => { if (BLOCKED_KEYS.has(k)) throw new Error(`Blocked key "${k}"`); return v; };
    return { ok: true, value: JSON.parse(String(text || ''), rev) };
  } catch { return { ok: false, value: null }; }
}

function isInsideJsonString(src, pos) {
  let inStr = false;
  let esc = false;
  for (let i = 0; i < pos && i < src.length; i += 1) {
    const ch = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
  }
  return inStr;
}

function deriveVarKey(expr) {
  const seg = String(expr || '').replace(/^\{\{|\}\}$/g, '').trim().split('.').pop() || 'value';
  const clean = seg.replace(/[^A-Za-z0-9_]/g, '_') || 'value';
  return BLOCKED_KEYS.has(clean) ? 'value' : clean;
}

function insertVariableAtCursor(rawText, expr, selStart, selEnd, isJsonField = false) {
  const text = rawText === undefined || rawText === null ? '' : String(rawText);
  const token = String(expr || '');
  const hasSel = selStart !== null && selStart !== undefined && Number.isFinite(Number(selStart));
  const start = hasSel ? Math.max(0, Math.min(text.length, Math.floor(Number(selStart)))) : text.length;
  const end = hasSel && selEnd !== null && selEnd !== undefined && Number.isFinite(Number(selEnd))
    ? Math.max(start, Math.min(text.length, Math.floor(Number(selEnd)))) : start;
  if (!isJsonField) return `${text.slice(0, start)}${token}${text.slice(end)}`;
  if (!text.trim()) return JSON.stringify({ [deriveVarKey(token)]: token }, null, 2);
  if (hasSel && isInsideJsonString(text, start) && isInsideJsonString(text, end)) {
    const cand = `${text.slice(0, start)}${JSON.stringify(token).slice(1, -1)}${text.slice(end)}`;
    if (tryParseSafeJson(cand).ok) return cand;
  }
  const parsed = tryParseSafeJson(text);
  if (parsed.ok) {
    if (Array.isArray(parsed.value)) return JSON.stringify([...parsed.value, token], null, 2);
    if (parsed.value && typeof parsed.value === 'object') {
      const next = { ...parsed.value };
      const base = deriveVarKey(token);
      if (!Object.prototype.hasOwnProperty.call(next, base) || next[base] === '') next[base] = token;
      else {
        let idx = 2;
        while (Object.prototype.hasOwnProperty.call(next, `${base}_${idx}`)) idx += 1;
        next[`${base}_${idx}`] = token;
      }
      return JSON.stringify(next, null, 2);
    }
    return JSON.stringify(typeof parsed.value === 'string' ? `${parsed.value}${token}` : token);
  }
  const closeMatch = text.match(/([}\]])\s*$/);
  if (closeMatch) {
    const closeIdx = text.lastIndexOf(closeMatch[1]);
    const head = text.slice(0, closeIdx).trimEnd();
    const needsComma = head.length > 0 && !head.endsWith('{') && !head.endsWith('[') && !head.endsWith(',');
    const ins = closeMatch[1] === '}' ? `"${deriveVarKey(token)}": ${JSON.stringify(token)}` : JSON.stringify(token);
    return `${text.slice(0, closeIdx)}${needsComma ? ', ' : ''}${ins}${text.slice(closeIdx)}`;
  }
  return `${text.slice(0, start)}${JSON.stringify(token)}${text.slice(end)}`;
}

function buildUpstreamPinnedInputs(graph, nodeId, selectedRun, sampleEvent) {
  const rawEv = (sampleEvent && typeof sampleEvent === 'object' && !Array.isArray(sampleEvent))
    ? sampleEvent
    : (selectedRun?.triggerPayloadJson?.event && typeof selectedRun.triggerPayloadJson.event === 'object' ? selectedRun.triggerPayloadJson.event : { type: 'manual.trigger', data: {} });
  const ev = safeCloneVal(rawEv) || { type: 'manual.trigger', data: {} };
  const data = (ev.data && typeof ev.data === 'object' && !Array.isArray(ev.data)) ? ev.data : {};
  const dmn = {};
  const steps = {};
  if (!selectedRun || typeof selectedRun !== 'object') return { event: ev, data, dmn, steps };

  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const nodeById = new Map(nodes.filter((n) => n?.id).map((n) => [n.id, n]));
  const outById = new Map();
  const typeById = new Map();
  if (selectedRun.nodeStatesJson && typeof selectedRun.nodeStatesJson === 'object') {
    for (const [k, st] of Object.entries(selectedRun.nodeStatesJson)) {
      if (!BLOCKED_KEYS.has(k) && st && st.output !== undefined) outById.set(k, st.output);
    }
  }
  const traces = Array.isArray(selectedRun.stepTracesJson) ? selectedRun.stepTracesJson : (Array.isArray(selectedRun.stepTraces) ? selectedRun.stepTraces : []);
  for (const t of traces) {
    if (t?.nodeId && !BLOCKED_KEYS.has(t.nodeId)) {
      if (t.type) typeById.set(t.nodeId, t.type);
      if (t.output !== undefined) outById.set(t.nodeId, t.output);
    }
  }
  const ancestors = [];
  if (nodeId) {
    const seen = new Set([nodeId]);
    const queue = [nodeId];
    for (let i = 0; i < queue.length; i += 1) {
      for (const e of edges) {
        if (e?.target === queue[i] && e.source && !seen.has(e.source)) {
          seen.add(e.source);
          queue.push(e.source);
          ancestors.push(e.source);
        }
      }
    }
  } else {
    for (const k of outById.keys()) ancestors.push(k);
  }
  if (selectedRun.dmnResultJson?.outputs && typeof selectedRun.dmnResultJson.outputs === 'object' && !Array.isArray(selectedRun.dmnResultJson.outputs)) {
    Object.assign(dmn, safeCloneVal(selectedRun.dmnResultJson.outputs) || {});
  }
  for (const ancId of ancestors.reverse()) {
    if (!outById.has(ancId) || BLOCKED_KEYS.has(ancId)) continue;
    const out = safeCloneVal(outById.get(ancId));
    steps[ancId] = out;
    const nType = nodeById.get(ancId)?.type || typeById.get(ancId) || '';
    if (nType === 'logic.dmn' && out && typeof out === 'object' && !Array.isArray(out)) {
      const dmnOut = (out.outputs && typeof out.outputs === 'object' && !Array.isArray(out.outputs)) ? out.outputs : out;
      Object.assign(dmn, dmnOut);
    }
  }
  return { event: ev, data, dmn, steps };
}

function computeGraphDiffSummary(prevGraph, nextGraph) {
  const prevNodes = Array.isArray(prevGraph?.nodes) ? prevGraph.nodes : [];
  const nextNodes = Array.isArray(nextGraph?.nodes) ? nextGraph.nodes : [];
  const prevEdges = Array.isArray(prevGraph?.edges) ? prevGraph.edges : [];
  const nextEdges = Array.isArray(nextGraph?.edges) ? nextGraph.edges : [];
  const prevMap = new Map(prevNodes.filter((n) => n?.id).map((n) => [n.id, n]));
  const nextMap = new Map(nextNodes.filter((n) => n?.id).map((n) => [n.id, n]));
  const added = nextNodes.filter((n) => n?.id && !prevMap.has(n.id)).map((n) => n.id);
  const removed = prevNodes.filter((n) => n?.id && !nextMap.has(n.id)).map((n) => n.id);
  const changed = nextNodes.filter((n) => {
    if (!n?.id || !prevMap.has(n.id)) return false;
    const p = prevMap.get(n.id);
    return p.type !== n.type || p.label !== n.label
      || JSON.stringify(p.config || {}) !== JSON.stringify(n.config || {})
      || Boolean(p.continueOnFail) !== Boolean(n.continueOnFail) || (p.timeoutMs ?? null) !== (n.timeoutMs ?? null);
  }).map((n) => n.id);
  const parts = [];
  if (added.length) parts.push(`+${added.length} thêm`);
  if (changed.length) parts.push(`~${changed.length} sửa`);
  if (removed.length) parts.push(`-${removed.length} xóa`);
  if (!parts.length && JSON.stringify(prevEdges) !== JSON.stringify(nextEdges)) {
    parts.push(`cập nhật nhánh (${prevEdges.length} → ${nextEdges.length})`);
  }
  return { added, removed, changed, summaryText: parts.length ? parts.join(' · ') : 'Không thay đổi node' };
}

module.exports = { validateFlowClient, insertVariableAtCursor, buildUpstreamPinnedInputs, computeGraphDiffSummary };
