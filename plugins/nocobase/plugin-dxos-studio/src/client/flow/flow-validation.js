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

module.exports = { validateFlowClient };
