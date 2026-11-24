/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const PALETTE_GROUPS = Object.freeze([
  { key: 'trigger', label: 'Trigger', color: '#2563EB', bg: '#EFF6FF', symbol: '⚡', aliases: ['trigger'] },
  { key: 'control', label: 'Control Flow', color: '#D97706', bg: '#FFFBEB', symbol: '⑂', aliases: ['control', 'control flow', 'control_flow', 'control-flow'] },
  { key: 'data', label: 'Data', color: '#0891B2', bg: '#ECFEFF', symbol: '⛁', aliases: ['data'] },
  { key: 'logic', label: 'Logic', color: '#16A34A', bg: '#F0FDF4', symbol: 'ƒ', aliases: ['logic'] },
  { key: 'ai', label: 'AI', color: '#7C3AED', bg: '#F5F3FF', symbol: '✦', aliases: ['ai'] },
  { key: 'integration', label: 'Integrations', color: '#DB2777', bg: '#FDF2F8', symbol: '⇄', aliases: ['integration', 'integrations'] },
]);

const QUICK_INSERT_TYPES = ['control.if', 'logic.dmn', 'data.create', 'notify.send'];

function resolveGroupKey(rawCategory, rawType) {
  const cat = String(rawCategory || '').trim().toLowerCase();
  for (const g of PALETTE_GROUPS) {
    if (g.aliases.includes(cat)) return g.key;
  }
  const prefix = String(rawType || '').split('.')[0].toLowerCase();
  for (const g of PALETTE_GROUPS) {
    if (g.aliases.includes(prefix)) return g.key;
  }
  return 'integration';
}

function createNodePalette(React) {
  const h = React.createElement;

  return function NodePalette(props = {}) {
    const { nodeTypes, onAddNode, insertEdge = null, onInsertNode, onCancelInsert, appendSource = null, onAppendNode, onCancelAppend, open, onToggleOpen } = props;
    const [internalOpen, setInternalOpen] = React.useState(false);
    const [search, setSearch] = React.useState('');
    const [collapsed, setCollapsed] = React.useState({});
    const [searchEl, setSearchEl] = React.useState(null);

    const isControlled = typeof open === 'boolean';
    const isOpen = isControlled ? open : internalOpen;
    const targetingEdgeOrNode = Boolean(insertEdge || appendSource);
    const showPanel = isOpen || targetingEdgeOrNode;
    const setOpen = (next) => {
      if (!isControlled) setInternalOpen(next);
      onToggleOpen?.(next);
    };

    React.useEffect(() => {
      if (showPanel && searchEl && typeof searchEl.focus === 'function') searchEl.focus();
    }, [showPanel, searchEl]);

    const safeNodes = Array.isArray(nodeTypes) ? nodeTypes : [];
    const normalizedQuery = String(search || '').trim().toLowerCase();

    const grouped = React.useMemo(() => {
      const buckets = new Map(PALETTE_GROUPS.map((g) => [g.key, []]));
      for (const schema of safeNodes) {
        if (!schema || !schema.type) continue;
        if (targetingEdgeOrNode && String(schema.type).startsWith('trigger.')) continue;
        const gKey = resolveGroupKey(schema.category, schema.type);
        const target = buckets.get(gKey) || buckets.get('integration');
        if (!normalizedQuery) {
          target.push(schema);
          continue;
        }
        const hay = `${schema.label || ''} ${schema.type || ''} ${schema.description || ''} ${schema.category || ''}`.toLowerCase();
        if (hay.includes(normalizedQuery)) target.push(schema);
      }
      return PALETTE_GROUPS
        .filter((g) => !(targetingEdgeOrNode && g.key === 'trigger'))
        .map((g) => ({ ...g, items: buckets.get(g.key) || [] }));
    }, [safeNodes, normalizedQuery, targetingEdgeOrNode]);

    const quickNodes = React.useMemo(
      () => (targetingEdgeOrNode ? QUICK_INSERT_TYPES.map((t) => safeNodes.find((s) => s?.type === t)).filter(Boolean) : []),
      [safeNodes, targetingEdgeOrNode],
    );
    const totalVisible = grouped.reduce((sum, g) => sum + g.items.length, 0);

    function toggleGroup(groupKey) {
      setCollapsed((prev) => ({ ...prev, [groupKey]: !prev[groupKey] }));
    }

    function handleDragStart(evt, schema) {
      if (evt?.dataTransfer?.setData) {
        evt.dataTransfer.setData('application/dxos-node-type', schema.type);
        evt.dataTransfer.setData('text/plain', schema.type);
        evt.dataTransfer.effectAllowed = 'copy';
      }
    }

    function handlePickNode(schema) {
      if (insertEdge && typeof onInsertNode === 'function') onInsertNode(schema);
      else if (appendSource && typeof onAppendNode === 'function') onAppendNode(schema);
      else if (typeof onAddNode === 'function') onAddNode(schema);
    }

    if (!showPanel) {
      return h('div', { style: { position: 'absolute', top: 14, left: 14, zIndex: 20 } },
        h('button', {
          type: 'button',
          'data-testid': 'dxos-flow-toggle-palette-btn',
          onClick: () => setOpen(true),
          style: {
            padding: '7px 12px', borderRadius: 10, border: '1px solid #CBD5E1', background: '#FFFFFF',
            color: '#0F172A', fontSize: 12, fontWeight: 700, cursor: 'pointer',
            boxShadow: '0 6px 18px rgba(15, 23, 42, 0.12)', display: 'inline-flex', alignItems: 'center', gap: 6,
          },
        }, '+ Thêm Node'),
      );
    }

    return h('aside', {
      'data-testid': 'dxos-flow-palette',
      style: {
        position: 'absolute', top: 14, left: 14, zIndex: 20,
        width: 264, maxHeight: 'calc(100% - 88px)', overflowY: 'auto',
        borderRadius: 12, border: '1px solid #CBD5E1', background: '#FFFFFF',
        boxShadow: '0 12px 32px rgba(15, 23, 42, 0.14)',
        padding: 12, display: 'grid', gap: 10, alignContent: 'start', boxSizing: 'border-box',
      },
    },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 } },
        h('strong', { style: { fontSize: 13, color: '#0F172A' } },
          insertEdge ? `Chèn giữa nhánh ${insertEdge.source} → ${insertEdge.target}` : appendSource ? `Nối tiếp sau: ${appendSource.label || appendSource.nodeId}` : 'Thư viện Node'),
        h('div', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
          h('span', { style: { fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 999, background: '#F1F5F9', color: '#475569' } }, `${safeNodes.length}`),
          h('button', {
            type: 'button',
            'data-testid': 'dxos-flow-palette-close-btn',
            title: 'Đóng thư viện Node',
            onClick: () => { setOpen(false); onCancelInsert?.(); onCancelAppend?.(); },
            style: { width: 24, height: 24, borderRadius: 6, border: '1px solid #E2E8F0', background: '#F8FAFC', color: '#475569', fontSize: 14, fontWeight: 700, cursor: 'pointer', lineHeight: '20px', padding: 0 },
          }, '×'),
        ),
      ),
      targetingEdgeOrNode ? h('div', {
        'data-testid': insertEdge ? 'dxos-flow-insert-picker' : 'dxos-flow-append-picker',
        style: { padding: 8, borderRadius: 8, border: '1px solid #BFDBFE', background: '#EFF6FF', display: 'grid', gap: 6, fontSize: 11 },
      },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 } },
          h('span', { style: { fontWeight: 700, color: '#1E40AF' } }, insertEdge ? `${insertEdge.source} → ${insertEdge.target}` : `${appendSource.label || appendSource.nodeId} [${appendSource.sourceHandle || 'main'}] →`),
          h('button', {
            'data-testid': insertEdge ? 'dxos-flow-insert-cancel-btn' : 'dxos-flow-append-cancel-btn',
            type: 'button',
            onClick: () => { onCancelInsert?.(); onCancelAppend?.(); },
            style: { padding: '2px 7px', borderRadius: 6, border: '1px solid #FCA5A5', background: '#FFFFFF', color: '#B91C1C', fontSize: 11, fontWeight: 600, cursor: 'pointer' },
          }, 'Hủy'),
        ),
        quickNodes.length ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4 } },
          quickNodes.map((t) => h('button', {
            key: t.type,
            type: 'button',
            'data-testid': insertEdge ? `dxos-flow-insert-node-${t.type}` : `dxos-flow-append-node-${t.type}`,
            onClick: () => handlePickNode(t),
            style: { padding: '3px 7px', borderRadius: 6, border: '1px solid #93C5FD', background: '#FFFFFF', color: '#1D4ED8', fontSize: 11, fontWeight: 600, cursor: 'pointer' },
          }, `+ ${t.label || t.type}`)),
        ) : null,
      ) : null,
      h('input', {
        ref: setSearchEl,
        'data-testid': 'dxos-flow-palette-search',
        type: 'search',
        value: search,
        placeholder: 'Tìm node (vd: trigger, dmn, ai)…',
        onChange: (evt) => setSearch(evt?.target?.value ?? ''),
        style: { width: '100%', boxSizing: 'border-box', padding: '7px 10px', borderRadius: 8, border: '1px solid #CBD5E1', background: '#F8FAFC', fontSize: 12, color: '#0F172A' },
      }),
      normalizedQuery && totalVisible === 0
        ? h('div', { style: { padding: 12, borderRadius: 8, border: '1px dashed #CBD5E1', background: '#F8FAFC', fontSize: 12, color: '#64748B', textAlign: 'center' } }, 'Không tìm thấy node phù hợp.')
        : grouped.map((group) => {
          if (normalizedQuery && group.items.length === 0) return null;
          const isOpenCat = normalizedQuery ? true : !collapsed[group.key];
          return h('div', { key: group.key, 'data-testid': `dxos-palette-category-${group.key}`, style: { display: 'grid', gap: 6 } },
            h('button', {
              type: 'button',
              'data-testid': `dxos-palette-toggle-${group.key}`,
              'aria-expanded': isOpenCat,
              onClick: () => toggleGroup(group.key),
              style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 8px', borderRadius: 8, border: '1px solid #E2E8F0', background: '#F8FAFC', cursor: 'pointer', fontSize: 12, fontWeight: 700, color: '#0F172A' },
            },
              h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
                h('span', { style: { width: 8, height: 8, borderRadius: 999, background: group.color, display: 'inline-block' } }),
                group.label,
              ),
              h('span', { style: { fontSize: 11, color: '#64748B', fontWeight: 600 } }, `${group.items.length} ${isOpenCat ? '▾' : '▸'}`),
            ),
            isOpenCat ? h('div', { style: { display: 'grid', gap: 5 } },
              group.items.map((schema) => {
                const accent = schema.color || group.color;
                return h('button', {
                  key: schema.type,
                  type: 'button',
                  draggable: true,
                  'data-testid': `dxos-palette-node-${schema.type}`,
                  title: schema.description || schema.label || schema.type,
                  onDragStart: (evt) => handleDragStart(evt, schema),
                  onClick: () => handlePickNode(schema),
                  style: {
                    display: 'grid', gap: 2, padding: '7px 9px', borderRadius: 8, border: '1px solid #E2E8F0',
                    borderLeft: `3px solid ${accent}`, background: '#FFFFFF', textAlign: 'left', cursor: 'grab', width: '100%', boxSizing: 'border-box',
                  },
                },
                  h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 } },
                    h('span', { style: { fontSize: 12, fontWeight: 600, color: '#0F172A' } }, schema.label || schema.type),
                    h('span', { style: { fontSize: 11, fontWeight: 700, color: accent } }, '+'),
                  ),
                  h('code', { style: { fontSize: 10, color: '#64748B' } }, schema.type),
                );
              }),
            ) : null,
          );
        }),
    );
  };
}

module.exports = { PALETTE_GROUPS, createNodePalette, resolveGroupKey };
