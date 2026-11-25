/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

function deriveErGraphFromSpec(spec = {}, refs = {}) {
  const rawColsSource = Array.isArray(spec?.collections) && spec.collections.length
    ? spec.collections
    : (spec?.collectionName
      ? [{ collectionName: spec.collectionName, collectionTitle: spec.collectionTitle || spec.pageTitle || spec.collectionName, fields: spec.fields || [] }]
      : (Array.isArray(refs?.collections) ? refs.collections.map((c) => (typeof c === 'string' ? { collectionName: c, fields: [] } : c)) : []));
  const rawCols = rawColsSource.filter((c) => c && typeof c === 'object');

  const nodeMap = new Map();
  const edges = [];

  for (const col of rawCols) {
    const colName = String(col?.collectionName || col?.name || '').trim();
    if (!colName) continue;
    const fields = Array.isArray(col?.fields)
      ? col.fields.filter((f) => f && typeof f === 'object' && String(f.name || '').trim())
      : [];
    nodeMap.set(colName, {
      id: colName,
      label: String(col?.collectionTitle || col?.title || colName).trim(),
      kind: 'entity',
      fields: fields.map((f) => ({
        name: f.name,
        type: f.interface === 'formula' ? 'formula' : (f.type || 'string'),
        title: f.title || f.label || f.name,
        required: Boolean(f.required || f.validation?.required),
        unique: Boolean(f.unique || f.validation?.unique),
        validation: f.validation || null,
        formulaExpression: f.formulaExpression || f.formula || null,
        formulaReturnType: f.formulaReturnType || null,
        target: f.target || f.targetCollection || null,
        through: f.through || null,
      })),
    });
  }

  for (const col of rawCols) {
    const colName = String(col?.collectionName || col?.name || '').trim();
    if (!colName) continue;
    for (const f of (Array.isArray(col?.fields) ? col.fields : [])) {
      if (!f || typeof f !== 'object' || !String(f.name || '').trim()) continue;
      const fType = String(f?.type || '').trim();
      const target = String(f?.target || f?.targetCollection || '').trim();
      if (!['belongsTo', 'hasOne', 'hasMany', 'belongsToMany'].includes(fType) || !target) continue;
      if (!nodeMap.has(target)) {
        nodeMap.set(target, { id: target, label: target, kind: 'external', fields: [{ name: 'id', type: 'bigInt' }, { name: 'organizationId', type: 'string' }] });
      }
      if (fType === 'belongsToMany' && f.through && !nodeMap.has(f.through)) {
        nodeMap.set(f.through, {
          id: f.through,
          label: f.through,
          kind: 'join',
          fields: [
            { name: 'organizationId', type: 'string', required: true },
            { name: f.foreignKey || 'sourceId', type: 'bigInt', required: true },
            { name: f.otherKey || 'targetId', type: 'bigInt', required: true },
          ],
        });
      }
      edges.push({
        id: `${colName}.${f.name}->${target}`,
        source: colName,
        target,
        type: fType,
        fieldName: f.name,
        through: f.through || null,
      });
    }
  }

  for (const jc of (Array.isArray(refs?.joinCollections) ? refs.joinCollections : [])) {
    if (typeof jc === 'string' && jc.trim() && !nodeMap.has(jc.trim())) {
      const cleanJc = jc.trim();
      nodeMap.set(cleanJc, { id: cleanJc, label: cleanJc, kind: 'join', fields: [{ name: 'organizationId', type: 'string', required: true }] });
    }
  }

  return { nodes: [...nodeMap.values()], edges };
}

function getFieldBadges(field) {
  if (!field || typeof field !== 'object') return [];
  const badges = [];
  if (field.required || field.validation?.required) badges.push('req');
  if (field.unique || field.validation?.unique) badges.push('uniq');
  if (field.validation?.min !== undefined || field.validation?.max !== undefined) badges.push('min/max');
  if (field.validation?.pattern) badges.push('regex');
  if ((Array.isArray(field.validation?.enum) && field.validation.enum.length) || (Array.isArray(field.enumValues) && field.enumValues.length)) badges.push('enum');
  if (field.type === 'formula' || field.formulaExpression) badges.push('fx');
  return badges;
}

function getEdgeLabel(type) {
  if (type === 'belongsTo') return 'N:1 belongsTo';
  if (type === 'hasOne') return '1:1 hasOne';
  if (type === 'hasMany') return '1:N hasMany';
  if (type === 'belongsToMany') return 'M:N belongsToMany';
  return type || 'rel';
}

function computeErGraphLayout(erGraph = {}) {
  const rawNodes = (Array.isArray(erGraph?.nodes) ? erGraph.nodes : []).filter((n) => n && typeof n === 'object' && String(n.id || '').trim());
  const rawEdges = (Array.isArray(erGraph?.edges) ? erGraph.edges : []).filter((e) => e && typeof e === 'object');
  const cardWidth = 240;
  const headerHeight = 32;
  const rowHeight = 20;
  const gapX = 64;
  const gapY = 42;
  const padX = 24;
  const padY = 24;
  const colsPerRow = rawNodes.length <= 2 ? Math.max(1, rawNodes.length) : 3;

  const positioned = [];
  const rowMaxY = [];
  rawNodes.forEach((node, idx) => {
    const colIdx = idx % colsPerRow;
    const rowIdx = Math.floor(idx / colsPerRow);
    const fields = Array.isArray(node.fields)
      ? node.fields.filter((f) => f && typeof f === 'object' && String(f.name || '').trim()).slice(0, 8)
      : [];
    const height = headerHeight + Math.max(1, fields.length) * rowHeight + 12;
    rowMaxY[rowIdx] = Math.max(rowMaxY[rowIdx] || 0, height);
    positioned.push({ ...node, colIdx, rowIdx, width: cardWidth, height, headerHeight, rowHeight, visibleFields: fields });
  });

  const rowOffsets = [];
  let accY = padY;
  for (let r = 0; r < rowMaxY.length; r += 1) {
    rowOffsets[r] = accY;
    accY += rowMaxY[r] + gapY;
  }

  const nodeBoxMap = new Map();
  const layoutNodes = positioned.map((n) => {
    const x = padX + n.colIdx * (cardWidth + gapX);
    const y = rowOffsets[n.rowIdx] || padY;
    const placed = { ...n, x, y };
    nodeBoxMap.set(n.id, placed);
    return placed;
  });

  const layoutEdges = rawEdges.map((edge, idx) => {
    const src = nodeBoxMap.get(edge.source);
    const tgt = nodeBoxMap.get(edge.target);
    if (!src || !tgt) {
      return { ...edge, path: '', labelX: 0, labelY: 0, label: getEdgeLabel(edge.type) };
    }
    const sx = src.x + src.width / 2;
    const sy = src.y + src.height / 2;
    const tx = tgt.x + tgt.width / 2;
    const ty = tgt.y + tgt.height / 2;
    const offset = (idx % 3) * 14 - 14;
    const mx = (sx + tx) / 2 + offset;
    const my = (sy + ty) / 2 - 22 + offset;
    return {
      ...edge,
      path: `M ${sx} ${sy} Q ${mx} ${my} ${tx} ${ty}`,
      labelX: mx,
      labelY: my,
      label: getEdgeLabel(edge.type),
    };
  });

  const totalWidth = Math.max(360, padX * 2 + colsPerRow * cardWidth + Math.max(0, colsPerRow - 1) * gapX);
  const totalHeight = Math.max(200, accY);

  return {
    width: totalWidth,
    height: totalHeight,
    nodes: layoutNodes,
    edges: layoutEdges,
  };
}

function renderErGraphPanel(React, {
  erGraph,
  selectedNode = null,
  onSelectNode = null,
  selectedEdge = null,
  onSelectEdge = null,
  testIdPrefix = 'dxos-er',
} = {}) {
  const h = React.createElement;
  const layout = computeErGraphLayout(erGraph || { nodes: [], edges: [] });

  if (!layout.nodes.length) {
    return h('div', {
      'data-testid': `${testIdPrefix}-empty`,
      style: { padding: 12, borderRadius: 8, border: '1px dashed #cbd5e1', color: '#64748b', fontSize: 12 },
    }, 'Chưa có thực thể nào để hiển thị sơ đồ ER.');
  }

  const kindPalette = (kind) => {
    if (kind === 'join') return { fill: '#fefce8', header: '#ca8a04', border: '#eab308', text: '#854d0e' };
    if (kind === 'external') return { fill: '#f1f5f9', header: '#475569', border: '#94a3b8', text: '#334155' };
    return { fill: '#f8fafc', header: '#0284c7', border: '#0ea5e9', text: '#0f172a' };
  };

  return h('div', {
    'data-testid': `${testIdPrefix}-panel`,
    style: { display: 'grid', gap: 8, padding: 10, borderRadius: 8, border: '1px solid #cbd5e1', background: '#ffffff' },
  },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, color: '#334155' } },
      h('strong', null, `Sơ đồ Thực thể — Quan hệ (ER Schema Graph: ${layout.nodes.length} bảng, ${layout.edges.length} quan hệ)`),
      h('span', { style: { fontSize: 11, color: '#64748b' } }, 'Nhấp vào bảng hoặc đường quan hệ để xem chi tiết'),
    ),
    h('div', { style: { overflowX: 'auto', borderRadius: 6, border: '1px solid #e2e8f0', background: '#f8fafc' } },
      h('svg', {
        'data-testid': 'dxos-er-graph-svg',
        viewBox: `0 0 ${layout.width} ${layout.height}`,
        width: layout.width,
        height: layout.height,
        style: { display: 'block', minWidth: layout.width },
      },
        h('defs', null,
          h('marker', {
            id: `${testIdPrefix}-arrow`,
            viewBox: '0 0 10 10',
            refX: 8,
            refY: 5,
            markerWidth: 6,
            markerHeight: 6,
            orient: 'auto-start-reverse',
          },
            h('path', { d: 'M 0 1 L 10 5 L 0 9 z', fill: '#0284c7' }),
          ),
        ),
        layout.edges.map((edge) => {
          const isSel = selectedEdge?.id === edge.id;
          const stroke = edge.type === 'belongsToMany' ? '#9333ea' : edge.type === 'hasOne' ? '#059669' : '#0284c7';
          return h('g', {
            key: edge.id,
            'data-testid': `${testIdPrefix}-edge-${edge.id}`,
            onClick: () => {
              onSelectEdge?.(edge);
              onSelectNode?.(null);
            },
            style: { cursor: 'pointer' },
          },
            h('path', {
              d: edge.path,
              fill: 'none',
              stroke,
              strokeWidth: isSel ? 3 : 1.8,
              strokeDasharray: edge.type === 'belongsToMany' ? '6 3' : undefined,
              markerEnd: `url(#${testIdPrefix}-arrow)`,
            }),
            h('rect', {
              x: edge.labelX - 48,
              y: edge.labelY - 10,
              width: 96,
              height: 18,
              rx: 4,
              fill: isSel ? '#fef3c7' : '#ffffff',
              stroke,
              strokeWidth: 1,
            }),
            h('text', {
              x: edge.labelX,
              y: edge.labelY + 3,
              textAnchor: 'middle',
              fontSize: 10,
              fontWeight: 600,
              fill: '#0f172a',
            }, edge.label),
          );
        }),
        layout.nodes.map((node) => {
          const pal = kindPalette(node.kind);
          const isSel = selectedNode?.id === node.id;
          return h('g', {
            key: node.id,
            'data-testid': `${testIdPrefix}-node-${node.id}`,
            onClick: () => {
              onSelectNode?.(node);
              onSelectEdge?.(null);
            },
            style: { cursor: 'pointer' },
          },
            h('rect', {
              x: node.x,
              y: node.y,
              width: node.width,
              height: node.height,
              rx: 8,
              fill: pal.fill,
              stroke: isSel ? '#f59e0b' : pal.border,
              strokeWidth: isSel ? 2.5 : 1.4,
            }),
            h('rect', {
              x: node.x,
              y: node.y,
              width: node.width,
              height: node.headerHeight,
              rx: 8,
              fill: pal.header,
            }),
            h('text', {
              x: node.x + 10,
              y: node.y + 20,
              fontSize: 12,
              fontWeight: 700,
              fill: '#ffffff',
            }, `${node.id}${node.kind === 'join' ? ' [join]' : node.kind === 'external' ? ' [ext]' : ''}`),
            node.visibleFields.map((fld, fIdx) => {
              const fy = node.y + node.headerHeight + 16 + fIdx * node.rowHeight;
              const badges = getFieldBadges(fld);
              const suffix = badges.length ? ` [${badges.join(',')}]` : '';
              return h('text', {
                key: `${node.id}.${fld.name}`,
                x: node.x + 10,
                y: fy,
                fontSize: 11,
                fill: pal.text,
              }, `${fld.name}: ${fld.type}${suffix}`);
            }),
          );
        }),
      ),
    ),
    (selectedNode || selectedEdge) ? (() => {
      const safeSelFields = Array.isArray(selectedNode?.fields)
        ? selectedNode.fields.filter((f) => f && typeof f === 'object' && String(f.name || '').trim())
        : [];
      return h('div', {
        'data-testid': `${testIdPrefix}-selection-detail`,
        style: { padding: '8px 10px', borderRadius: 6, border: '1px solid #bae6fd', background: '#f0f9ff', fontSize: 12, color: '#0c4a6e' },
      }, selectedNode
        ? `Bảng ${selectedNode.id} (${selectedNode.kind}) · ${safeSelFields.length} trường: ${safeSelFields.map((f) => `${f.name}:${f.type}`).join(', ')}`
        : `Quan hệ ${selectedEdge.source}.${selectedEdge.fieldName} -> ${selectedEdge.target} (${selectedEdge.type}${selectedEdge.through ? `, through=${selectedEdge.through}` : ''})`);
    })() : null,
  );
}

module.exports = {
  deriveErGraphFromSpec,
  computeErGraphLayout,
  renderErGraphPanel,
};
