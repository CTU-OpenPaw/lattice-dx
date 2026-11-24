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
  { key: 'trigger', label: 'Trigger', color: '#1677ff', bg: '#eff6ff', symbol: '⚡', aliases: ['trigger'] },
  { key: 'control', label: 'Control Flow', color: '#fa8c16', bg: '#fff7ed', symbol: '⑂', aliases: ['control', 'control flow', 'control_flow', 'control-flow'] },
  { key: 'data', label: 'Data', color: '#13c2c2', bg: '#ecfeff', symbol: '⛁', aliases: ['data'] },
  { key: 'logic', label: 'Logic', color: '#52c41a', bg: '#f0fdf4', symbol: 'ƒ', aliases: ['logic'] },
  { key: 'ai', label: 'AI', color: '#722ed1', bg: '#f5f3ff', symbol: '✦', aliases: ['ai'] },
  { key: 'integration', label: 'Integrations', color: '#eb2f96', bg: '#fdf2f8', symbol: '⇄', aliases: ['integration', 'integrations'] },
]);

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
    const { nodeTypes, onAddNode } = props;
    const [search, setSearch] = React.useState('');
    const [collapsed, setCollapsed] = React.useState({});

    const safeNodes = Array.isArray(nodeTypes) ? nodeTypes : [];
    const normalizedQuery = String(search || '').trim().toLowerCase();

    const grouped = React.useMemo(() => {
      const buckets = new Map(PALETTE_GROUPS.map((g) => [g.key, []]));
      for (const schema of safeNodes) {
        if (!schema || !schema.type) continue;
        const gKey = resolveGroupKey(schema.category, schema.type);
        const target = buckets.get(gKey) || buckets.get('integration');
        if (!normalizedQuery) {
          target.push(schema);
          continue;
        }
        const hay = `${schema.label || ''} ${schema.type || ''} ${schema.description || ''} ${schema.category || ''}`.toLowerCase();
        if (hay.includes(normalizedQuery)) target.push(schema);
      }
      return PALETTE_GROUPS.map((g) => ({
        ...g,
        items: buckets.get(g.key) || [],
      }));
    }, [safeNodes, normalizedQuery]);

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

    return h('aside', {
      'data-testid': 'dxos-flow-palette',
      style: {
        width: 248,
        minWidth: 248,
        height: '100%',
        overflowY: 'auto',
        borderRight: '1px solid #e2e8f0',
        background: '#f8fafc',
        padding: 12,
        display: 'grid',
        gap: 10,
        alignContent: 'start',
        boxSizing: 'border-box',
      },
    },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
        h('strong', { style: { fontSize: 13, color: '#0f172a' } }, 'Thư viện Node'),
        h('span', {
          style: {
            fontSize: 11,
            fontWeight: 600,
            padding: '2px 7px',
            borderRadius: 999,
            background: '#e2e8f0',
            color: '#334155',
          },
        }, `${safeNodes.length}`),
      ),
      h('input', {
        'data-testid': 'dxos-flow-palette-search',
        type: 'search',
        value: search,
        placeholder: 'Tìm node (vd: trigger, dmn, ai)…',
        onChange: (evt) => setSearch(evt?.target?.value ?? ''),
        style: {
          width: '100%',
          boxSizing: 'border-box',
          padding: '7px 10px',
          borderRadius: 8,
          border: '1px solid #cbd5e1',
          background: '#ffffff',
          fontSize: 12,
          color: '#0f172a',
        },
      }),
      normalizedQuery && totalVisible === 0
        ? h('div', {
          style: {
            padding: 12,
            borderRadius: 8,
            border: '1px dashed #cbd5e1',
            background: '#ffffff',
            fontSize: 12,
            color: '#64748b',
            textAlign: 'center',
          },
        }, 'Không tìm thấy node phù hợp.')
        : grouped.map((group) => {
          if (normalizedQuery && group.items.length === 0) return null;
          const isOpen = normalizedQuery ? true : !collapsed[group.key];
          return h('div', {
            key: group.key,
            'data-testid': `dxos-palette-category-${group.key}`,
            style: { display: 'grid', gap: 6 },
          },
            h('button', {
              type: 'button',
              'data-testid': `dxos-palette-toggle-${group.key}`,
              'aria-expanded': isOpen,
              onClick: () => toggleGroup(group.key),
              style: {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '6px 8px',
                borderRadius: 8,
                border: '1px solid #e2e8f0',
                background: '#ffffff',
                cursor: 'pointer',
                fontSize: 12,
                fontWeight: 700,
                color: '#0f172a',
              },
            },
              h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
                h('span', {
                  style: {
                    width: 8,
                    height: 8,
                    borderRadius: 999,
                    background: group.color,
                    display: 'inline-block',
                  },
                }),
                group.label,
              ),
              h('span', { style: { fontSize: 11, color: '#64748b', fontWeight: 600 } },
                `${group.items.length} ${isOpen ? '▾' : '▸'}`),
            ),
            isOpen ? h('div', { style: { display: 'grid', gap: 6 } },
              group.items.map((schema) => {
                const accent = schema.color || group.color;
                return h('button', {
                  key: schema.type,
                  type: 'button',
                  draggable: true,
                  'data-testid': `dxos-palette-node-${schema.type}`,
                  title: schema.description || schema.label || schema.type,
                  onDragStart: (evt) => handleDragStart(evt, schema),
                  onClick: () => {
                    if (typeof onAddNode === 'function') onAddNode(schema);
                  },
                  style: {
                    display: 'grid',
                    gap: 3,
                    padding: '8px 10px',
                    borderRadius: 8,
                    border: '1px solid #cbd5e1',
                    borderLeft: `3px solid ${accent}`,
                    background: '#ffffff',
                    textAlign: 'left',
                    cursor: 'grab',
                    width: '100%',
                    boxSizing: 'border-box',
                  },
                },
                  h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 } },
                    h('span', { style: { fontSize: 12, fontWeight: 600, color: '#0f172a' } }, schema.label || schema.type),
                    h('span', { style: { fontSize: 11, fontWeight: 700, color: accent } }, '+'),
                  ),
                  h('code', { style: { fontSize: 10, color: '#64748b' } }, schema.type),
                );
              }),
            ) : null,
          );
        }),
    );
  };
}

module.exports = {
  PALETTE_GROUPS,
  createNodePalette,
  resolveGroupKey,
};
