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
  trigger: { color: '#2563EB', bg: '#EFF6FF', badge: 'Trigger', symbol: '⚡' },
  control: { color: '#D97706', bg: '#FFFBEB', badge: 'Control', symbol: '⑂' },
  data: { color: '#0891B2', bg: '#ECFEFF', badge: 'Data', symbol: '⛁' },
  logic: { color: '#16A34A', bg: '#F0FDF4', badge: 'Logic', symbol: 'ƒ' },
  ai: { color: '#7C3AED', bg: '#F5F3FF', badge: 'AI', symbol: '✦' },
  integration: { color: '#DB2777', bg: '#FDF2F8', badge: 'Integration', symbol: '⇄' },
});

const TRACE_STYLES = Object.freeze({
  completed: { label: '✓ completed', color: '#166534', bg: '#F0FDF4', border: '#22C55E' },
  simulated: { label: '▶ simulated', color: '#0E7490', bg: '#ECFEFF', border: '#06B6D4' },
  suspended: { label: '⏸ suspended', color: '#92400E', bg: '#FFFBEB', border: '#F59E0B' },
  skipped: { label: '⊘ skipped', color: '#64748B', bg: '#F8FAFC', border: '#94A3B8' },
  failed: { label: '✕ failed', color: '#991B1B', bg: '#FEF2F2', border: '#EF4444' },
});

const inferCategory = (t) => {
  const p = String(t || '').split('.')[0].toLowerCase();
  return ['trigger', 'control', 'data', 'logic', 'ai'].includes(p) ? p : 'integration';
};

function summarizeNodeConfig(node) {
  const t = String(node?.type || '');
  const c = node?.config && typeof node.config === 'object' ? node.config : {};
  const map = {
    'trigger.record': [c.collection, c.operation || 'create'].filter(Boolean).join(' · '),
    'trigger.event': c.eventType ? `event: ${c.eventType}` : '',
    'trigger.schedule': c.cron ? `cron: ${c.cron}` : '',
    'trigger.webhook': c.webhookPath ? `/${String(c.webhookPath).replace(/^\/+/, '')}` : '',
    'trigger.manual': 'Manual trigger',
    'control.if': c.condition?.field ? `${c.condition.field} ${c.condition.op || 'eq'} ${c.condition.value ?? ''}`.trim() : '',
    'control.switch': c.expression ? `switch(${c.expression})` : '',
    'control.loop': c.itemsPath ? `each: ${c.itemsPath}` : '',
    'control.approval': c.approverRole ? `HITL · ${c.approverRole}` : '',
    'logic.dmn': c.tableKey || '',
    'logic.transform': Array.isArray(c.operations) ? `${c.operations.length} ops` : '',
    'integration.http': [c.method || 'POST', c.connectorKey || c.path].filter(Boolean).join(' · '),
    'notify.send': Array.isArray(c.roleNames) && c.roleNames.length ? c.roleNames.join(', ') : String(c.title || '').slice(0, 42),
    'ai.llm': String(c.userPrompt || c.model || '').slice(0, 42),
    'iot.twin_command': [c.assetEntityId || c.propertyName, c.desiredValue].filter(Boolean).join(' = '),
  };
  return map[t] || c.collection || c.targetCollection || c.ruleKey || '';
}

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
  if (port === 'true' || port === 'approved') return '#16A34A';
  if (port === 'false' || port === 'rejected' || port === 'error') return '#DC2626';
  if (port.startsWith('case_')) return '#7C3AED';
  if (port === 'item') return '#0284C7';
  return '#64748B';
}

function isEdgeActive(edge, activeEdges) {
  if (!activeEdges || !edge) return false;
  const [pairKey, simpleKey] = [`${edge.source}:${edge.sourceHandle || 'main'}->${edge.target}`, `${edge.source}->${edge.target}`];
  if (activeEdges instanceof Set) return activeEdges.has(edge.id) || activeEdges.has(simpleKey) || activeEdges.has(pairKey);
  if (Array.isArray(activeEdges)) {
    return activeEdges.some((item) => (typeof item === 'string'
      ? (item === edge.id || item === simpleKey || item === pairKey)
      : Boolean(item && item.source === edge.source && item.target === edge.target && (!item.sourceHandle || item.sourceHandle === edge.sourceHandle))));
  }
  return typeof activeEdges === 'object' ? Boolean(activeEdges[edge.id] || activeEdges[simpleKey] || activeEdges[pairKey]) : false;
}

const renderInsertButton = (h, edgeObj, strokeColor, getHandler) => h('button', {
  type: 'button', 'data-testid': `dxos-flow-edge-insert-${edgeObj.id}`, title: 'Chèn node vào giữa nhánh',
  onClick: (evt) => { evt?.stopPropagation?.(); getHandler()?.(edgeObj); },
  style: { width: 20, height: 20, borderRadius: 999, border: `1px solid ${strokeColor}`, background: '#FFFFFF', color: strokeColor, fontSize: 13, fontWeight: 700, lineHeight: '16px', padding: 0, cursor: 'pointer' },
}, '+');

const dockBtn = (disabled, active) => ({
  padding: '5px 9px', borderRadius: 7, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap',
  border: `1px solid ${active ? '#93C5FD' : 'transparent'}`, background: active ? '#EFF6FF' : 'transparent',
  color: disabled ? '#94A3B8' : active ? '#1D4ED8' : '#0F172A', cursor: disabled ? 'not-allowed' : 'pointer',
});

function createFlowCanvas(React, vendor = {}) {
  const h = React.createElement;

  return function FlowCanvas(props = {}) {
    const {
      graph, nodeTypes, selectedNodeId, onSelectNode, onConnectNodes, onNodesChangeGraph, onInsertBetweenEdge,
      runOverlay, onAutoLayout, onDropNode, onAddNode, onQuickTestNode, onDuplicateNode, onDeleteNode,
      canUndo = false, canRedo = false, onUndo, onRedo, xyflowOverride,
    } = props;

    const [rfInstance, setRfInstance] = React.useState(null);
    const [showMiniMap, setShowMiniMap] = React.useState(false);
    const [handlersRef] = React.useState(() => ({}));
    Object.assign(handlersRef, { onSelectNode, onInsertBetweenEdge, onQuickTestNode, onDuplicateNode, onDeleteNode });

    React.useEffect(() => {
      if (typeof vendor?.injectFlowStudioCss === 'function') vendor.injectFlowStudioCss();
      else if (typeof vendor?.injectFlowCss === 'function') vendor.injectFlowCss();
    }, []);

    const resetDrag = () => { handlersRef.dragPending = false; handlersRef.dragStartGraph = null; handlersRef.expectedDragGraph = null; };
    const applyPos = (nodes, posMap) => (posMap.size ? nodes.map((n) => (posMap.has(n.id) ? { ...n, position: { x: Number(posMap.get(n.id).x), y: Number(posMap.get(n.id).y) } } : n)) : nodes);
    const safeGraph = graph && typeof graph === 'object' ? graph : { version: 2, nodes: [], edges: [] };
    const safeNodes = Array.isArray(safeGraph.nodes) ? safeGraph.nodes : [];
    const safeEdges = Array.isArray(safeGraph.edges) ? safeGraph.edges : [];
    if (handlersRef.dragPending && safeGraph !== handlersRef.dragStartGraph && safeGraph !== handlersRef.expectedDragGraph) resetDrag();

    const schemaByType = React.useMemo(() => {
      const map = new Map();
      if (Array.isArray(nodeTypes)) nodeTypes.forEach((s) => { if (s?.type) map.set(s.type, s); });
      return map;
    }, [nodeTypes]);

    const rawXy = typeof vendor?.getXyflow === 'function' ? vendor.getXyflow(xyflowOverride) : (xyflowOverride || null);
    const ReactFlowComp = typeof rawXy === 'function' ? rawXy : (rawXy?.ReactFlow || rawXy?.default || null);
    const { Background: BackgroundComp, MiniMap: MiniMapComp, Handle: HandleComp, BaseEdge: BaseEdgeComp, EdgeLabelRenderer: EdgeLabelRendererComp, getBezierPath: getBezierPathFn } = rawXy || {};
    const PositionObj = rawXy?.Position || { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' };
    const nodeStates = runOverlay?.nodeStates && typeof runOverlay.nodeStates === 'object' ? runOverlay.nodeStates : {};
    const activeNodeId = runOverlay?.activeNodeId || null;

    const rfNodes = React.useMemo(() => safeNodes.map((n, idx) => {
      const schema = schemaByType.get(n.type);
      const category = schema?.category || inferCategory(n.type);
      const catMeta = CATEGORY_META[category] || CATEGORY_META.integration;
      const ports = inferPorts(n.type);
      const isSelected = n.id === selectedNodeId;
      const pos = n.position && Number.isFinite(Number(n.position.x)) && Number.isFinite(Number(n.position.y)) ? { x: Number(n.position.x), y: Number(n.position.y) } : { x: 80 + idx * 280, y: 180 };
      return {
        id: n.id, type: 'dxosNode', position: pos, selected: isSelected,
        data: {
          node: n, label: n.label || schema?.label || n.type || n.id, nodeType: n.type, category,
          color: schema?.color || catMeta.color, preview: summarizeNodeConfig(n),
          trace: nodeStates[n.id] || null, selected: isSelected, isPlaybackCurrent: activeNodeId === n.id,
          inputs: Array.isArray(schema?.inputs) ? schema.inputs : ports.inputs,
          outputs: Array.isArray(schema?.outputs) && schema.outputs.length ? schema.outputs : ports.outputs,
        },
      };
    }), [safeNodes, schemaByType, nodeStates, selectedNodeId, activeNodeId]);

    const rfEdges = React.useMemo(() => safeEdges.map((e, idx) => {
      const strokeColor = getEdgeColor(e.sourceHandle);
      const highlighted = isEdgeActive(e, runOverlay?.activeEdges);
      return { id: e.id || `edge_${idx + 1}`, source: e.source, sourceHandle: e.sourceHandle || 'main', target: e.target, targetHandle: e.targetHandle || 'in', type: 'dxosEdge', label: e.label || undefined, animated: highlighted, style: { stroke: strokeColor, strokeWidth: highlighted ? 3 : 2 }, data: { edge: e, strokeColor, highlighted } };
    }), [safeEdges, runOverlay?.activeEdges]);

    const customNodeTypes = React.useMemo(() => ({
      dxosNode: function DxosNodeRenderer(nodeProps) {
        const d = nodeProps?.data || {};
        const nodeId = nodeProps?.id || d.node?.id || '';
        const traceStatus = String(d.trace?.status || '').toLowerCase();
        const tStyle = TRACE_STYLES[traceStatus] || null;
        const catMeta = CATEGORY_META[d.category] || CATEGORY_META.integration;
        const isSel = Boolean(d.selected || nodeProps?.selected);
        const stripe = d.color || catMeta.color;
        const borderCol = (d.isPlaybackCurrent || isSel) ? '#2563EB' : (tStyle?.border || '#E2E8F0');
        const outputs = Array.isArray(d.outputs) && d.outputs.length ? d.outputs : ['main'];
        const inputs = Array.isArray(d.inputs) ? d.inputs : [];
        const miniBtn = (col) => ({ padding: '3px 7px', borderRadius: 6, border: 'none', background: 'transparent', color: col, fontSize: 11, fontWeight: 600, cursor: 'pointer' });
        return h('div', {
          'data-testid': `dxos-flow-node-${nodeId}`,
          onClick: (evt) => { evt?.stopPropagation?.(); handlersRef.onSelectNode?.(nodeId); },
          style: { minWidth: 224, maxWidth: 268, padding: '10px 12px', borderRadius: 12, background: tStyle?.bg || '#FFFFFF', border: `1.5px ${traceStatus === 'skipped' && !isSel ? 'dashed' : 'solid'} ${borderCol}`, borderLeft: `4px solid ${stripe}`, boxShadow: (isSel || d.isPlaybackCurrent) ? '0 0 0 3px rgba(37,99,235,0.16), 0 8px 20px rgba(15,23,42,0.08)' : '0 2px 6px rgba(15,23,42,0.05)', cursor: 'pointer', position: 'relative', display: 'grid', gap: 6, fontSize: 12 },
        },
          isSel ? h('div', { className: 'nodrag nopan', 'data-testid': `dxos-flow-node-mini-toolbar-${nodeId}`, style: { position: 'absolute', top: -36, left: '50%', transform: 'translateX(-50%)', zIndex: 25, display: 'inline-flex', alignItems: 'center', gap: 2, padding: '3px 6px', borderRadius: 8, border: '1px solid #CBD5E1', background: '#FFFFFF', boxShadow: '0 6px 16px rgba(15,23,42,0.12)', whiteSpace: 'nowrap' } },
            h('button', { type: 'button', 'data-testid': `dxos-flow-node-quick-test-${nodeId}`, onClick: (evt) => { evt?.stopPropagation?.(); handlersRef.onQuickTestNode?.(nodeId); }, style: miniBtn('#2563EB') }, '▶ Test'),
            h('button', { type: 'button', 'data-testid': `dxos-flow-node-quick-dup-${nodeId}`, onClick: (evt) => { evt?.stopPropagation?.(); handlersRef.onDuplicateNode?.(nodeId); }, style: miniBtn('#334155') }, '⎘ Nhân bản'),
            h('button', { type: 'button', 'data-testid': `dxos-flow-node-quick-del-${nodeId}`, onClick: (evt) => { evt?.stopPropagation?.(); handlersRef.onDeleteNode?.(nodeId); }, style: miniBtn('#DC2626') }, '✕'),
          ) : null,
          HandleComp ? inputs.map((inp, i) => h(HandleComp, { key: `in-${inp}`, type: 'target', position: PositionObj.Left, id: inp, style: { top: `${((i + 1) / (inputs.length + 1)) * 100}%`, background: '#475569', width: 9, height: 9 } })) : null,
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 } },
            h('span', { style: { fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 999, background: catMeta.bg, color: stripe } }, `${catMeta.symbol} ${d.nodeType || catMeta.badge}`),
            tStyle ? h('span', { style: { fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 999, background: '#FFFFFF', border: `1px solid ${tStyle.border}`, color: tStyle.color } }, `${tStyle.label}${d.trace?.durationMs != null ? ` · ${d.trace.durationMs}ms` : ''}`) : null,
          ),
          h('strong', { style: { fontSize: 13, color: '#0F172A', lineHeight: 1.3, wordBreak: 'break-word' } }, d.label),
          d.preview ? h('div', { 'data-testid': `dxos-flow-node-preview-${nodeId}`, style: { fontSize: 11, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', color: '#64748B', background: '#F8FAFC', padding: '3px 6px', borderRadius: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, d.preview) : null,
          outputs.length > 1 ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4 } }, outputs.map((port) => h('span', { key: port, style: { fontSize: 10, padding: '1px 5px', borderRadius: 4, background: '#F1F5F9', color: getEdgeColor(port), border: `1px solid ${getEdgeColor(port)}33`, fontWeight: 600 } }, port))) : null,
          HandleComp ? outputs.map((port, i) => h(HandleComp, { key: `out-${port}`, type: 'source', position: PositionObj.Right, id: port, style: { top: `${((i + 1) / (outputs.length + 1)) * 100}%`, background: getEdgeColor(port), width: 9, height: 9 } })) : null,
        );
      },
    }), [HandleComp, PositionObj]);

    const customEdgeTypes = React.useMemo(() => ({
      dxosEdge: function DxosEdgeRenderer(edgeProps) {
        const edgeObj = edgeProps?.data?.edge || { id: edgeProps?.id, source: edgeProps?.source, sourceHandle: edgeProps?.sourceHandle || 'main', target: edgeProps?.target, targetHandle: edgeProps?.targetHandle || 'in', label: edgeProps?.label };
        const strokeColor = edgeProps?.data?.strokeColor || getEdgeColor(edgeObj.sourceHandle);
        const highlighted = Boolean(edgeProps?.data?.highlighted || edgeProps?.animated);
        const [edgePath, labelX, labelY] = typeof getBezierPathFn === 'function'
          ? getBezierPathFn({ sourceX: edgeProps.sourceX, sourceY: edgeProps.sourceY, sourcePosition: edgeProps.sourcePosition, targetX: edgeProps.targetX, targetY: edgeProps.targetY, targetPosition: edgeProps.targetPosition })
          : [`M ${edgeProps?.sourceX || 0},${edgeProps?.sourceY || 0} L ${edgeProps?.targetX || 120},${edgeProps?.targetY || 0}`, ((edgeProps?.sourceX || 0) + (edgeProps?.targetX || 120)) / 2, ((edgeProps?.sourceY || 0) + (edgeProps?.targetY || 0)) / 2];
        const labelNode = h('div', { className: 'nodrag nopan', style: { position: 'absolute', transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, pointerEvents: 'all', display: 'inline-flex', alignItems: 'center', gap: 4, zIndex: 5 } },
          (edgeObj.label || (edgeObj.sourceHandle && edgeObj.sourceHandle !== 'main')) ? h('span', { style: { fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 999, background: '#FFFFFF', color: strokeColor, border: `1px solid ${strokeColor}` } }, edgeObj.label || edgeObj.sourceHandle) : null,
          renderInsertButton(h, edgeObj, strokeColor, () => handlersRef.onInsertBetweenEdge),
        );
        return h(React.Fragment, null,
          BaseEdgeComp ? h(BaseEdgeComp, { id: edgeObj.id, path: edgePath, markerEnd: edgeProps?.markerEnd, style: { stroke: strokeColor, strokeWidth: highlighted ? 3 : 2, ...(edgeProps?.style || {}) } }) : h('path', { id: edgeObj.id, d: edgePath, fill: 'none', stroke: strokeColor, strokeWidth: highlighted ? 3 : 2 }),
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
      const nextNodes = applyPos(removedIds.size ? safeNodes.filter((n) => !removedIds.has(n.id)) : safeNodes, posMap);
      const nextEdges = removedIds.size ? safeEdges.filter((e) => !removedIds.has(e.source) && !removedIds.has(e.target)) : safeEdges;
      const skipUndo = relevant.length > 0 && relevant.every((c) => c.type === 'position' && c.dragging === true);
      const nextG = { ...safeGraph, nodes: nextNodes, edges: nextEdges };
      if (skipUndo) { if (!handlersRef.dragPending) handlersRef.dragStartGraph = safeGraph; handlersRef.dragPending = true; handlersRef.expectedDragGraph = nextG; } else resetDrag();
      onNodesChangeGraph(nextG, { skipUndo });
    }
    function handleNodeDragStop(_evt, node, nodes) {
      if (!handlersRef.dragPending || typeof onNodesChangeGraph !== 'function') return;
      resetDrag();
      const moved = Array.isArray(nodes) && nodes.length ? nodes : (node ? [node] : []);
      const posMap = new Map(moved.filter((n) => n?.id && n?.position && Number.isFinite(Number(n.position.x)) && Number.isFinite(Number(n.position.y))).map((n) => [n.id, n.position]));
      onNodesChangeGraph({ ...safeGraph, nodes: applyPos(safeNodes, posMap) }, { skipUndo: false });
    }
    function handleRfEdgesChange(changes) {
      if (!Array.isArray(changes) || !changes.length || typeof onNodesChangeGraph !== 'function') return;
      const removed = new Set(changes.filter((c) => c && c.type === 'remove').map((c) => c.id));
      if (removed.size) onNodesChangeGraph({ ...safeGraph, edges: safeEdges.filter((e, idx) => !removed.has(e.id || `edge_${idx + 1}`)) }, { skipUndo: false });
    }
    function handleDrop(evt) {
      evt?.preventDefault?.();
      const nodeType = String(evt?.dataTransfer?.getData?.('application/dxos-node-type') || evt?.dataTransfer?.getData?.('text/plain') || '').trim();
      if (!nodeType) return;
      const bounds = evt?.currentTarget?.getBoundingClientRect?.();
      let position = bounds && Number.isFinite(evt?.clientX) && Number.isFinite(evt?.clientY) ? { x: Math.round(evt.clientX - bounds.left), y: Math.round(evt.clientY - bounds.top) } : { x: 180 + safeNodes.length * 40, y: 180 };
      if (typeof rfInstance?.screenToFlowPosition === 'function' && Number.isFinite(evt?.clientX) && Number.isFinite(evt?.clientY)) position = rfInstance.screenToFlowPosition({ x: evt.clientX, y: evt.clientY });
      const schema = schemaByType.get(nodeType) || { type: nodeType, label: nodeType, defaultConfig: {} };
      (onDropNode || onAddNode)?.(schema, position);
    }

    const sep = h('span', { style: { width: 1, height: 18, background: '#E2E8F0', margin: '0 2px' } });
    return h('div', {
      'data-testid': 'dxos-flow-canvas',
      onDragOver: (evt) => { evt?.preventDefault?.(); if (evt?.dataTransfer) evt.dataTransfer.dropEffect = 'copy'; },
      onDrop: handleDrop,
      style: { flex: 1, height: '100%', minHeight: 540, position: 'relative', background: '#F8FAFC', overflow: 'hidden' },
    },
      ReactFlowComp
        ? h(ReactFlowComp, {
          nodes: rfNodes, edges: rfEdges, nodeTypes: customNodeTypes, edgeTypes: customEdgeTypes,
          onNodeClick: (_evt, node) => onSelectNode?.(node?.id || null), onPaneClick: () => onSelectNode?.(null),
          onConnect: (params) => onConnectNodes?.(params), onNodesChange: handleRfNodesChange, onEdgesChange: handleRfEdgesChange,
          onNodeDragStop: handleNodeDragStop, onInit: setRfInstance, fitView: true, fitViewOptions: { padding: 0.24, maxZoom: 1 }, proOptions: { hideAttribution: true },
        },
          BackgroundComp ? h(BackgroundComp, { gap: 18, size: 1, color: '#CBD5E1' }) : null,
          showMiniMap && MiniMapComp ? h(MiniMapComp, { pannable: true, zoomable: true }) : null,
        )
        : h('div', { 'data-testid': 'dxos-flow-headless-canvas', style: { padding: '56px 16px 64px', display: 'grid', gap: 12, height: '100%', overflowY: 'auto', alignContent: 'start' } },
          !rfNodes.length
            ? h('div', { style: { padding: 24, border: '1px dashed #CBD5E1', borderRadius: 12, textAlign: 'center', color: '#64748B', background: '#FFFFFF' } }, 'Nhấn "+ Thêm Node" ở góc trên trái để bắt đầu dựng luồng.')
            : h('div', { 'data-testid': 'dxos-flow-headless-nodes', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 14, paddingTop: 28 } }, rfNodes.map((n) => h(customNodeTypes.dxosNode, { key: n.id, id: n.id, data: n.data, selected: n.selected }))),
          rfEdges.length ? h('div', { 'data-testid': 'dxos-flow-headless-edges', style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
            rfEdges.map((e) => {
              const strokeColor = e.data?.strokeColor || '#64748B';
              const edgeObj = e.data?.edge || e;
              return h('div', { key: e.id, 'data-testid': `dxos-flow-edge-${e.id}`, style: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 8px', borderRadius: 999, background: '#FFFFFF', border: `${e.animated ? 2 : 1}px solid ${strokeColor}`, fontSize: 11, color: '#334155' } },
                h('span', { style: { color: strokeColor, fontWeight: 700 } }, `${e.source} [${e.sourceHandle}] → ${e.target}`),
                renderInsertButton(h, edgeObj, strokeColor, () => handlersRef.onInsertBetweenEdge),
              );
            }),
          ) : null,
        ),
      h('div', { 'data-testid': 'dxos-flow-canvas-dock', style: { position: 'absolute', bottom: 14, left: '50%', transform: 'translateX(-50%)', zIndex: 18, display: 'inline-flex', alignItems: 'center', gap: 3, padding: '4px 8px', borderRadius: 10, border: '1px solid #CBD5E1', background: 'rgba(255, 255, 255, 0.96)', boxShadow: '0 8px 24px rgba(15, 23, 42, 0.12)', whiteSpace: 'nowrap' } },
        h('button', { type: 'button', 'data-testid': 'dxos-flow-zoom-out-btn', onClick: () => rfInstance?.zoomOut?.(), style: dockBtn(false, false) }, '−'),
        h('button', { type: 'button', 'data-testid': 'dxos-flow-zoom-in-btn', onClick: () => rfInstance?.zoomIn?.(), style: dockBtn(false, false) }, '+'),
        h('button', { type: 'button', 'data-testid': 'dxos-flow-fitview-btn', onClick: () => rfInstance?.fitView?.({ padding: 0.24, duration: 200 }), style: dockBtn(false, false) }, '⊡ Fit'),
        sep,
        h('button', { type: 'button', 'data-testid': 'dxos-flow-autolayout-btn', onClick: () => { const l = typeof vendor?.autoLayoutGraph === 'function' ? vendor.autoLayoutGraph(safeGraph) : null; (onAutoLayout || onNodesChangeGraph)?.(l || safeGraph); }, style: dockBtn(false, false) }, '⊞ Dàn đều'),
        h('button', { type: 'button', 'data-testid': 'dxos-flow-undo-btn', disabled: !canUndo, onClick: () => onUndo?.(), style: dockBtn(!canUndo, false) }, '↶'),
        h('button', { type: 'button', 'data-testid': 'dxos-flow-redo-btn', disabled: !canRedo, onClick: () => onRedo?.(), style: dockBtn(!canRedo, false) }, '↷'),
        sep,
        h('button', { type: 'button', 'data-testid': 'dxos-flow-toggle-minimap-btn', 'aria-pressed': showMiniMap, onClick: () => setShowMiniMap((v) => !v), style: dockBtn(false, showMiniMap) }, '🗺 Map'),
      ),
    );
  };
}

module.exports = { createFlowCanvas, getEdgeColor, isEdgeActive, summarizeNodeConfig };
