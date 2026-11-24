/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const CATEGORY_META = Object.freeze({
  trigger: { color: '#1677ff', bg: '#eff6ff', badge: 'Trigger', symbol: '⚡' },
  control: { color: '#fa8c16', bg: '#fff7ed', badge: 'Control', symbol: '⑂' },
  data: { color: '#13c2c2', bg: '#ecfeff', badge: 'Data', symbol: '⛁' },
  logic: { color: '#52c41a', bg: '#f0fdf4', badge: 'Logic', symbol: 'ƒ' },
  ai: { color: '#722ed1', bg: '#f5f3ff', badge: 'AI', symbol: '✦' },
  integration: { color: '#eb2f96', bg: '#fdf2f8', badge: 'Integration', symbol: '⇄' },
});

const TRACE_STYLES = Object.freeze({
  completed: { label: '✓ completed', color: '#166534', bg: '#f0fdf4', border: '#22c55e' },
  simulated: { label: '▶ simulated', color: '#0e7490', bg: '#ecfeff', border: '#06b6d4' },
  suspended: { label: '⏸ suspended', color: '#92400e', bg: '#fffbeb', border: '#f59e0b' },
  skipped: { label: '⊘ skipped', color: '#64748b', bg: '#f8fafc', border: '#94a3b8' },
  failed: { label: '✕ failed', color: '#991b1b', bg: '#fef2f2', border: '#ef4444' },
});

const inferCategory = (t) => {
  const p = String(t || '').split('.')[0].toLowerCase();
  return ['trigger', 'control', 'data', 'logic', 'ai'].includes(p) ? p : 'integration';
};

function inferPorts(nodeType) {
  const t = String(nodeType || '').trim();
  if (t.startsWith('trigger.')) return { inputs: [], outputs: ['main'] };
  if (t === 'control.if') return { inputs: ['in'], outputs: ['true', 'false', 'error'] };
  if (t === 'control.switch') return { inputs: ['in'], outputs: ['case_0', 'case_1', 'case_2', 'default', 'error'] };
  if (t === 'control.loop') return { inputs: ['in'], outputs: ['item', 'done', 'error'] };
  if (t === 'control.approval') return { inputs: ['in'], outputs: ['approved', 'rejected', 'error'] };
  return { inputs: ['in'], outputs: ['main', 'error'] };
}

function getEdgeColor(sourceHandle) {
  const port = String(sourceHandle || 'main').trim().toLowerCase();
  if (port === 'true' || port === 'approved') return '#16a34a';
  if (port === 'false' || port === 'rejected' || port === 'error') return '#dc2626';
  if (port.startsWith('case_')) return '#7c3aed';
  if (port === 'item') return '#0284c7';
  return '#64748b';
}

function isEdgeActive(edge, activeEdges) {
  if (!activeEdges || !edge) return false;
  const pairKey = `${edge.source}:${edge.sourceHandle || 'main'}->${edge.target}`;
  const simpleKey = `${edge.source}->${edge.target}`;
  if (activeEdges instanceof Set) return activeEdges.has(edge.id) || activeEdges.has(simpleKey) || activeEdges.has(pairKey);
  if (Array.isArray(activeEdges)) {
    return activeEdges.some((item) => (typeof item === 'string'
      ? (item === edge.id || item === simpleKey || item === pairKey)
      : Boolean(item && item.source === edge.source && item.target === edge.target && (!item.sourceHandle || item.sourceHandle === edge.sourceHandle))));
  }
  if (typeof activeEdges === 'object') return Boolean(activeEdges[edge.id] || activeEdges[simpleKey] || activeEdges[pairKey]);
  return false;
}

const renderInsertButton = (h, edgeObj, strokeColor, getHandler) => h('button', {
  type: 'button',
  'data-testid': `dxos-flow-edge-insert-${edgeObj.id}`,
  title: 'Chèn node vào giữa nhánh',
  onClick: (evt) => { evt?.stopPropagation?.(); getHandler()?.(edgeObj); },
  style: {
    width: 20, height: 20, borderRadius: 999, border: `1px solid ${strokeColor}`,
    background: '#ffffff', color: strokeColor, fontSize: 13, fontWeight: 700,
    lineHeight: '16px', padding: 0, cursor: 'pointer',
  },
}, '+');

function createFlowCanvas(React, vendor = {}) {
  const h = React.createElement;

  return function FlowCanvas(props = {}) {
    const {
      graph, nodeTypes, selectedNodeId, onSelectNode, onConnectNodes,
      onNodesChangeGraph, onInsertBetweenEdge, runOverlay, onAutoLayout,
      onDropNode, onAddNode, xyflowOverride,
    } = props;

    const [rfInstance, setRfInstance] = React.useState(null);
    const [handlersRef] = React.useState(() => ({}));
    handlersRef.onSelectNode = onSelectNode;
    handlersRef.onInsertBetweenEdge = onInsertBetweenEdge;

    React.useEffect(() => {
      if (typeof vendor?.injectFlowStudioCss === 'function') vendor.injectFlowStudioCss();
      else if (typeof vendor?.injectFlowCss === 'function') vendor.injectFlowCss();
    }, []);

    const safeGraph = graph && typeof graph === 'object' ? graph : { version: 2, nodes: [], edges: [] };
    const safeNodes = Array.isArray(safeGraph.nodes) ? safeGraph.nodes : [];
    const safeEdges = Array.isArray(safeGraph.edges) ? safeGraph.edges : [];

    const schemaByType = React.useMemo(() => {
      const map = new Map();
      if (Array.isArray(nodeTypes)) nodeTypes.forEach((s) => { if (s?.type) map.set(s.type, s); });
      return map;
    }, [nodeTypes]);

    const rawXy = typeof vendor?.getXyflow === 'function' ? vendor.getXyflow(xyflowOverride) : (xyflowOverride || null);
    const ReactFlowComp = typeof rawXy === 'function' ? rawXy : (rawXy?.ReactFlow || rawXy?.default || null);
    const { Background: BackgroundComp, Controls: ControlsComp, MiniMap: MiniMapComp, Handle: HandleComp, BaseEdge: BaseEdgeComp, EdgeLabelRenderer: EdgeLabelRendererComp, getBezierPath: getBezierPathFn } = rawXy || {};
    const PositionObj = rawXy?.Position || { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' };

    const nodeStates = runOverlay?.nodeStates && typeof runOverlay.nodeStates === 'object' ? runOverlay.nodeStates : {};
    const activeNodeId = runOverlay?.activeNodeId || null;

    const rfNodes = React.useMemo(() => safeNodes.map((n, idx) => {
      const schema = schemaByType.get(n.type);
      const category = schema?.category || inferCategory(n.type);
      const catMeta = CATEGORY_META[category] || CATEGORY_META.integration;
      const ports = inferPorts(n.type);
      const inputs = Array.isArray(schema?.inputs) ? schema.inputs : ports.inputs;
      const outputs = Array.isArray(schema?.outputs) && schema.outputs.length ? schema.outputs : ports.outputs;
      const isSelected = n.id === selectedNodeId;
      const pos = n.position && Number.isFinite(Number(n.position.x)) && Number.isFinite(Number(n.position.y))
        ? { x: Number(n.position.x), y: Number(n.position.y) }
        : { x: 80 + idx * 280, y: 180 };
      return {
        id: n.id, type: 'dxosNode', position: pos, selected: isSelected,
        data: {
          node: n, label: n.label || schema?.label || n.type || n.id, nodeType: n.type, category,
          color: schema?.color || catMeta.color, icon: schema?.icon || catMeta.symbol,
          trace: nodeStates[n.id] || null, selected: isSelected, isPlaybackCurrent: activeNodeId === n.id,
          inputs, outputs,
        },
      };
    }), [safeNodes, schemaByType, nodeStates, selectedNodeId, activeNodeId]);

    const rfEdges = React.useMemo(() => safeEdges.map((e, idx) => {
      const strokeColor = getEdgeColor(e.sourceHandle);
      const highlighted = isEdgeActive(e, runOverlay?.activeEdges);
      return {
        id: e.id || `edge_${idx + 1}`, source: e.source, sourceHandle: e.sourceHandle || 'main',
        target: e.target, targetHandle: e.targetHandle || 'in', type: 'dxosEdge',
        label: e.label || undefined, animated: highlighted,
        style: { stroke: strokeColor, strokeWidth: highlighted ? 3 : 2 },
        data: { edge: e, strokeColor, highlighted },
      };
    }), [safeEdges, runOverlay?.activeEdges]);

    const customNodeTypes = React.useMemo(() => ({
      dxosNode: function DxosNodeRenderer(nodeProps) {
        const d = nodeProps?.data || {};
        const nodeId = nodeProps?.id || d.node?.id || '';
        const traceStatus = String(d.trace?.status || '').toLowerCase();
        const tStyle = TRACE_STYLES[traceStatus] || null;
        const catMeta = CATEGORY_META[d.category] || CATEGORY_META.integration;
        const isSel = Boolean(d.selected || nodeProps?.selected);
        const activeBorder = (d.isPlaybackCurrent || isSel) ? '#1677ff' : (tStyle?.border || d.color || catMeta.color);
        const outputs = Array.isArray(d.outputs) && d.outputs.length ? d.outputs : ['main'];
        const inputs = Array.isArray(d.inputs) ? d.inputs : [];
        return h('div', {
          'data-testid': `dxos-flow-node-${nodeId}`,
          onClick: (evt) => { evt?.stopPropagation?.(); handlersRef.onSelectNode?.(nodeId); },
          style: {
            minWidth: 215, maxWidth: 260, padding: '10px 12px', borderRadius: 10,
            background: tStyle?.bg || '#ffffff',
            border: `2px ${traceStatus === 'skipped' && !isSel ? 'dashed' : 'solid'} ${activeBorder}`,
            boxShadow: (isSel || d.isPlaybackCurrent) ? '0 0 0 3px rgba(22,119,255,0.18), 0 4px 12px rgba(15,23,42,0.08)' : '0 2px 6px rgba(15,23,42,0.06)',
            cursor: 'pointer', position: 'relative', display: 'grid', gap: 6, fontSize: 12,
          },
        },
          HandleComp ? inputs.map((inp, i) => h(HandleComp, {
            key: `in-${inp}`, type: 'target', position: PositionObj.Left, id: inp,
            style: { top: `${((i + 1) / (inputs.length + 1)) * 100}%`, background: '#475569', width: 9, height: 9 },
          })) : null,
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 } },
            h('span', { style: { fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 999, background: catMeta.bg, color: d.color || catMeta.color } },
              `${catMeta.symbol} ${d.nodeType || catMeta.badge}`),
            tStyle ? h('span', { style: { fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 999, background: '#ffffff', border: `1px solid ${tStyle.border}`, color: tStyle.color } },
              `${tStyle.label}${d.trace?.durationMs != null ? ` · ${d.trace.durationMs}ms` : ''}`) : null,
          ),
          h('strong', { style: { fontSize: 13, color: '#0f172a', lineHeight: 1.3, wordBreak: 'break-word' } }, d.label),
          outputs.length > 1 ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4 } },
            outputs.map((port) => h('span', {
              key: port,
              style: { fontSize: 10, padding: '1px 5px', borderRadius: 4, background: '#f1f5f9', color: getEdgeColor(port), border: `1px solid ${getEdgeColor(port)}33`, fontWeight: 600 },
            }, port)),
          ) : null,
          HandleComp ? outputs.map((port, i) => h(HandleComp, {
            key: `out-${port}`, type: 'source', position: PositionObj.Right, id: port,
            style: { top: `${((i + 1) / (outputs.length + 1)) * 100}%`, background: getEdgeColor(port), width: 9, height: 9 },
          })) : null,
        );
      },
    }), [HandleComp, PositionObj]);

    const customEdgeTypes = React.useMemo(() => ({
      dxosEdge: function DxosEdgeRenderer(edgeProps) {
        const edgeObj = edgeProps?.data?.edge || {
          id: edgeProps?.id, source: edgeProps?.source, sourceHandle: edgeProps?.sourceHandle || 'main',
          target: edgeProps?.target, targetHandle: edgeProps?.targetHandle || 'in', label: edgeProps?.label,
        };
        const strokeColor = edgeProps?.data?.strokeColor || getEdgeColor(edgeObj.sourceHandle);
        const highlighted = Boolean(edgeProps?.data?.highlighted || edgeProps?.animated);
        const [edgePath, labelX, labelY] = typeof getBezierPathFn === 'function'
          ? getBezierPathFn({
            sourceX: edgeProps.sourceX, sourceY: edgeProps.sourceY, sourcePosition: edgeProps.sourcePosition,
            targetX: edgeProps.targetX, targetY: edgeProps.targetY, targetPosition: edgeProps.targetPosition,
          })
          : [
            `M ${edgeProps?.sourceX || 0},${edgeProps?.sourceY || 0} L ${edgeProps?.targetX || 120},${edgeProps?.targetY || 0}`,
            ((edgeProps?.sourceX || 0) + (edgeProps?.targetX || 120)) / 2,
            ((edgeProps?.sourceY || 0) + (edgeProps?.targetY || 0)) / 2,
          ];
        const labelNode = h('div', {
          className: 'nodrag nopan',
          style: { position: 'absolute', transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, pointerEvents: 'all', display: 'inline-flex', alignItems: 'center', gap: 4, zIndex: 5 },
        },
          (edgeObj.label || (edgeObj.sourceHandle && edgeObj.sourceHandle !== 'main'))
            ? h('span', { style: { fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 999, background: '#ffffff', color: strokeColor, border: `1px solid ${strokeColor}` } },
              edgeObj.label || edgeObj.sourceHandle)
            : null,
          renderInsertButton(h, edgeObj, strokeColor, () => handlersRef.onInsertBetweenEdge),
        );
        return h(React.Fragment, null,
          BaseEdgeComp
            ? h(BaseEdgeComp, { id: edgeObj.id, path: edgePath, markerEnd: edgeProps?.markerEnd, style: { stroke: strokeColor, strokeWidth: highlighted ? 3 : 2, ...(edgeProps?.style || {}) } })
            : h('path', { id: edgeObj.id, d: edgePath, fill: 'none', stroke: strokeColor, strokeWidth: highlighted ? 3 : 2 }),
          EdgeLabelRendererComp ? h(EdgeLabelRendererComp, null, labelNode) : labelNode,
        );
      },
    }), [BaseEdgeComp, EdgeLabelRendererComp, getBezierPathFn]);

    function handleRfNodesChange(changes) {
      if (!Array.isArray(changes) || !changes.length || typeof onNodesChangeGraph !== 'function') return;
      const relevant = changes.filter((c) => c && (c.type === 'position' || c.type === 'remove'));
      if (!relevant.length) return;
      const removedIds = new Set(relevant.filter((c) => c.type === 'remove').map((c) => c.id));
      const posMap = new Map(relevant.filter((c) => c.type === 'position' && c.position).map((c) => [c.id, c.position]));
      const nextNodes = safeNodes
        .filter((n) => !removedIds.has(n.id))
        .map((n) => (posMap.has(n.id) ? { ...n, position: { x: Number(posMap.get(n.id).x), y: Number(posMap.get(n.id).y) } } : n));
      const nextEdges = removedIds.size
        ? safeEdges.filter((e) => !removedIds.has(e.source) && !removedIds.has(e.target))
        : safeEdges;
      const skipUndo = changes.length > 0 && changes.every((c) => c && c.type === 'position' && c.dragging === true);
      onNodesChangeGraph({ ...safeGraph, nodes: nextNodes, edges: nextEdges }, { skipUndo });
    }

    function handleRfEdgesChange(changes) {
      if (!Array.isArray(changes) || !changes.length || typeof onNodesChangeGraph !== 'function') return;
      const removed = new Set(changes.filter((c) => c && c.type === 'remove').map((c) => c.id));
      if (!removed.size) return;
      const nextEdges = safeEdges.filter((e, idx) => !removed.has(e.id || `edge_${idx + 1}`));
      onNodesChangeGraph({ ...safeGraph, edges: nextEdges }, { skipUndo: false });
    }

    function handleDrop(evt) {
      evt?.preventDefault?.();
      const nodeType = String(evt?.dataTransfer?.getData?.('application/dxos-node-type') || evt?.dataTransfer?.getData?.('text/plain') || '').trim();
      if (!nodeType) return;
      const bounds = evt?.currentTarget?.getBoundingClientRect?.();
      let position = bounds && Number.isFinite(evt?.clientX) && Number.isFinite(evt?.clientY)
        ? { x: Math.round(evt.clientX - bounds.left), y: Math.round(evt.clientY - bounds.top) }
        : { x: 180 + safeNodes.length * 40, y: 180 };
      if (typeof rfInstance?.screenToFlowPosition === 'function' && Number.isFinite(evt?.clientX) && Number.isFinite(evt?.clientY)) {
        position = rfInstance.screenToFlowPosition({ x: evt.clientX, y: evt.clientY });
      }
      const schema = schemaByType.get(nodeType) || { type: nodeType, label: nodeType, defaultConfig: {} };
      if (typeof onDropNode === 'function') onDropNode(schema, position);
      else if (typeof onAddNode === 'function') onAddNode(schema, position);
    }

    return h('div', {
      'data-testid': 'dxos-flow-canvas',
      onDragOver: (evt) => { evt?.preventDefault?.(); if (evt?.dataTransfer) evt.dataTransfer.dropEffect = 'copy'; },
      onDrop: handleDrop,
      style: { flex: 1, height: '100%', minHeight: 540, position: 'relative', background: '#f8fafc', overflow: 'hidden' },
    },
      h('button', {
        type: 'button',
        'data-testid': 'dxos-flow-autolayout-btn',
        onClick: () => {
          const layouted = typeof vendor?.autoLayoutGraph === 'function' ? vendor.autoLayoutGraph(safeGraph) : null;
          if (typeof onAutoLayout === 'function') onAutoLayout(layouted || safeGraph);
          else if (layouted && typeof onNodesChangeGraph === 'function') onNodesChangeGraph(layouted);
        },
        style: {
          position: 'absolute', top: 12, right: 12, zIndex: 10, padding: '6px 12px', borderRadius: 8,
          border: '1px solid #cbd5e1', background: '#ffffff', color: '#0f172a', fontSize: 12, fontWeight: 600,
          cursor: 'pointer', boxShadow: '0 1px 4px rgba(15,23,42,0.08)',
        },
      }, 'Auto-Layout'),
      ReactFlowComp
        ? h(ReactFlowComp, {
          nodes: rfNodes, edges: rfEdges, nodeTypes: customNodeTypes, edgeTypes: customEdgeTypes,
          onNodeClick: (_evt, node) => onSelectNode?.(node?.id || null),
          onPaneClick: () => onSelectNode?.(null),
          onConnect: (params) => onConnectNodes?.(params),
          onNodesChange: handleRfNodesChange, onEdgesChange: handleRfEdgesChange, onInit: setRfInstance,
          fitView: true, proOptions: { hideAttribution: true },
        },
          BackgroundComp ? h(BackgroundComp, { gap: 16, size: 1, color: '#cbd5e1' }) : null,
          ControlsComp ? h(ControlsComp, { showInteractive: true }) : null,
          MiniMapComp ? h(MiniMapComp, { pannable: true, zoomable: true }) : null,
        )
        : h('div', { 'data-testid': 'dxos-flow-headless-canvas', style: { padding: '52px 16px 16px', display: 'grid', gap: 12, height: '100%', overflowY: 'auto', alignContent: 'start' } },
          !rfNodes.length
            ? h('div', { style: { padding: 24, border: '1px dashed #cbd5e1', borderRadius: 10, textAlign: 'center', color: '#64748b', background: '#ffffff' } },
              'Kéo hoặc bấm Node ở thanh bên trái để thêm vào DX-OS Flow Studio.')
            : h('div', { 'data-testid': 'dxos-flow-headless-nodes', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 } },
              rfNodes.map((n) => h(customNodeTypes.dxosNode, { key: n.id, id: n.id, data: n.data, selected: n.selected })),
            ),
          rfEdges.length ? h('div', { 'data-testid': 'dxos-flow-headless-edges', style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
            rfEdges.map((e) => {
              const strokeColor = e.data?.strokeColor || '#64748b';
              const edgeObj = e.data?.edge || e;
              return h('div', {
                key: e.id, 'data-testid': `dxos-flow-edge-${e.id}`,
                style: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 8px', borderRadius: 999, background: '#ffffff', border: `${e.animated ? 2 : 1}px solid ${strokeColor}`, fontSize: 11, color: '#334155' },
              },
                h('span', { style: { color: strokeColor, fontWeight: 700 } }, `${e.source} [${e.sourceHandle}] → ${e.target}`),
                renderInsertButton(h, edgeObj, strokeColor, () => handlersRef.onInsertBetweenEdge),
              );
            }),
          ) : null,
        ),
    );
  };
}

module.exports = { createFlowCanvas, getEdgeColor, isEdgeActive };
