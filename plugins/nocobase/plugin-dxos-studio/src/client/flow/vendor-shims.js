/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const DXOS_XYFLOW_STYLE_ID = 'dxos-xyflow-css';
const IS_BUNDLED = typeof __DXOS_BUNDLED__ !== 'undefined' && __DXOS_BUNDLED__ === true;
let bundledXyflow = null;
let bundledDagre = null;
let xyflowCssText = '';

if (IS_BUNDLED) {
  try { bundledXyflow = require('@xyflow/react'); } catch {}
  try { xyflowCssText = String(require('@xyflow/react/dist/style.css') || ''); } catch {}
}
try { bundledDagre = require('@dagrejs/dagre'); } catch {}

function injectFlowStudioCss(doc) {
  const targetDoc = doc === undefined ? (typeof document !== 'undefined' ? document : null) : doc;
  if (!targetDoc || !xyflowCssText) return false;
  if (typeof targetDoc.getElementById === 'function' && targetDoc.getElementById(DXOS_XYFLOW_STYLE_ID)) return true;
  const head = targetDoc.head || targetDoc.documentElement || targetDoc.body;
  if (!head || typeof targetDoc.createElement !== 'function' || typeof head.appendChild !== 'function') return false;
  const styleEl = targetDoc.createElement('style');
  styleEl.id = DXOS_XYFLOW_STYLE_ID;
  if (typeof styleEl.setAttribute === 'function') styleEl.setAttribute('data-dxos-vendor', '@xyflow/react');
  styleEl.textContent = xyflowCssText;
  head.appendChild(styleEl);
  return true;
}

function getXyflow(override) {
  if (override) return override;
  const resolved = bundledXyflow && (bundledXyflow.ReactFlow ? bundledXyflow : bundledXyflow.default);
  if (resolved && resolved.ReactFlow) return resolved;
  return typeof globalThis !== 'undefined' && globalThis.__DXOS_TEST_XYFLOW__ ? globalThis.__DXOS_TEST_XYFLOW__ : null;
}

function getDagre(override) {
  if (override === false) return null;
  if (override) return override;
  const resolved = bundledDagre && (bundledDagre.graphlib ? bundledDagre : bundledDagre.default);
  if (resolved && resolved.graphlib && typeof resolved.layout === 'function') return resolved;
  return typeof globalThis !== 'undefined' && globalThis.__DXOS_TEST_DAGRE__ ? globalThis.__DXOS_TEST_DAGRE__ : null;
}

function fallbackTopologicalLayout(nodes, edges, o) {
  const ids = new Set(nodes.map((n) => n.id));
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  const adj = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    if (!ids.has(e?.source) || !ids.has(e?.target) || e.source === e.target) continue;
    adj.get(e.source).push(e.target);
    indeg.set(e.target, (indeg.get(e.target) || 0) + 1);
  }
  const rank = new Map();
  const queue = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => (rank.set(n.id, 0), n.id));
  while (queue.length > 0) {
    const u = queue.shift();
    for (const v of adj.get(u) || []) {
      rank.set(v, Math.max(rank.get(v) || 0, (rank.get(u) || 0) + 1));
      indeg.set(v, indeg.get(v) - 1);
      if (indeg.get(v) === 0) queue.push(v);
    }
  }
  let extraRank = rank.size ? Math.max(...rank.values()) + 1 : 0;
  const byRank = new Map();
  for (const n of nodes) {
    const r = rank.has(n.id) ? rank.get(n.id) : extraRank++;
    (byRank.get(r) || byRank.set(r, []).get(r)).push(n.id);
  }
  const posMap = new Map();
  const [dx, dy] = o.direction === 'TB' ? [o.nodeWidth + o.nodesep, o.nodeHeight + o.ranksep] : [o.nodeWidth + o.ranksep, o.nodeHeight + o.nodesep];
  for (const [r, bucket] of byRank.entries()) {
    bucket.forEach((id, lane) => posMap.set(id, { x: 60 + (o.direction === 'TB' ? lane : r) * dx, y: 60 + (o.direction === 'TB' ? r : lane) * dy }));
  }
  return nodes.map((n) => ({ ...n, position: posMap.get(n.id) || n.position || { x: 60, y: 60 } }));
}

function autoLayoutGraph(graph, options = {}) {
  const gIn = graph && typeof graph === 'object' ? graph : {};
  const nodes = Array.isArray(gIn.nodes) ? gIn.nodes : [];
  const edges = Array.isArray(gIn.edges) ? gIn.edges : [];
  if (nodes.length === 0) return { ...gIn, nodes: [], edges };
  const numOpt = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  const o = { direction: options.direction === 'TB' ? 'TB' : 'LR', ranksep: numOpt(options.ranksep, 90), nodesep: numOpt(options.nodesep, 50), nodeWidth: numOpt(options.nodeWidth, 220), nodeHeight: numOpt(options.nodeHeight, 84) };
  const dagreLib = getDagre(options.dagreOverride !== undefined ? options.dagreOverride : options.dagre);
  if (dagreLib) {
    try {
      const dg = new dagreLib.graphlib.Graph({ multigraph: true });
      dg.setGraph({ rankdir: o.direction, ranksep: o.ranksep, nodesep: o.nodesep, marginx: 40, marginy: 40 });
      dg.setDefaultEdgeLabel(() => ({}));
      const idSet = new Set(nodes.map((n) => n?.id).filter(Boolean));
      for (const id of idSet) dg.setNode(id, { width: o.nodeWidth, height: o.nodeHeight });
      edges.forEach((e, idx) => { if (idSet.has(e?.source) && idSet.has(e?.target)) dg.setEdge(e.source, e.target, {}, e.id || String(idx)); });
      dagreLib.layout(dg);
      return { ...gIn, nodes: nodes.map((n) => { const p = n?.id ? dg.node(n.id) : null; return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { ...n, position: { x: Math.round(p.x - o.nodeWidth / 2), y: Math.round(p.y - o.nodeHeight / 2) } } : n; }), edges };
    } catch {}
  }
  return { ...gIn, nodes: fallbackTopologicalLayout(nodes, edges, o), edges };
}

module.exports = {
  DXOS_XYFLOW_STYLE_ID, XYFLOW_CSS_TEXT: xyflowCssText,
  injectFlowStudioCss, injectFlowCss: injectFlowStudioCss, ensureFlowStudioStyles: injectFlowStudioCss,
  getXyflow, getDagre, autoLayoutGraph,
  get ReactFlowLib() { return getXyflow(); },
  get dagre() { return getDagre(); },
};
