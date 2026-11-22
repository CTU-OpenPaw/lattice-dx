/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');

test('filterCommands filters by Vietnamese query without diacritics, blocks admin commands for employees, and rejects unsafe paths', () => {
  const { DEFAULT_COMMAND_ITEMS, filterCommands } = require(path.join(PLUGIN_ROOT, 'src/client/command-palette.js'));
  const empItems = filterCommands([...DEFAULT_COMMAND_ITEMS, { id: 'evil', label: 'XSS', path: 'javascript:alert(1)' }], 'mua sam', { isAdmin: false });
  assert.equal(empItems.some((c) => c.path === '/p/procurement'), true);
  assert.equal(empItems.some((c) => c.adminOnly), false);
  assert.equal(empItems.some((c) => c.id === 'evil'), false);

  const empAdminSearch = filterCommands(DEFAULT_COMMAND_ITEMS, 'studio', { isAdmin: false });
  assert.equal(empAdminSearch.length, 0);

  const adminSearch = filterCommands(DEFAULT_COMMAND_ITEMS, 'studio', { isAdmin: true });
  assert.equal(adminSearch.some((c) => c.path === '/admin/settings/dxos-studio'), true);
});

test('CommandPaletteProvider renders zero floating chrome when closed and accessible dialog when open', () => {
  const { createCommandPaletteProvider } = require(path.join(PLUGIN_ROOT, 'src/client/command-palette.js'));
  const makeReact = (openState) => ({
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (init) => {
      const v = typeof init === 'function' ? init() : init;
      if (v === false) return [openState, () => {}];
      return [v, () => {}];
    },
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
  });

  const ClosedProvider = createCommandPaletteProvider({ useAPIClient: () => null }, makeReact(false), {}, {});
  const closedTree = ClosedProvider({ children: 'PAGE-CONTENT' });
  const closedDump = JSON.stringify(closedTree);
  assert.ok(closedDump.includes('PAGE-CONTENT'));
  assert.equal(closedDump.includes('dxos-command-palette'), false);
  assert.equal(closedDump.includes('button'), false);

  const OpenProvider = createCommandPaletteProvider({ useAPIClient: () => null }, makeReact(true), {}, {});
  const openTree = OpenProvider({ children: 'PAGE-CONTENT' });
  const openDump = JSON.stringify(openTree);
  assert.ok(openDump.includes('dxos-command-palette'));
  assert.ok(openDump.includes('"role":"dialog"'));
  assert.ok(openDump.includes('"aria-modal":true'));
});

test('formatMentionSegments splits @mentions safely and createRecordChatterView renders diffs, mentions, and export buttons', () => {
  const { formatMentionSegments, createRecordChatterView } = require(path.join(PLUGIN_ROOT, 'src/client/chatter-panel.js'));
  const segs = formatMentionSegments('Nhờ @emp-a2 kiểm tra <script> trước nhé');
  assert.equal(segs.some((s) => s.type === 'mention' && s.handle === 'emp-a2'), true);

  const React = {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (init) => {
      const v = typeof init === 'function' ? init() : init;
      if (Array.isArray(v) && v.length === 0) {
        return [[
          {
            id: 1,
            entryType: 'comment',
            authorName: 'an',
            body: 'Ping @emp-a2 xem đơn <script>',
            createdAt: '2026-11-22T07:00:00Z',
          },
          {
            id: 2,
            entryType: 'field_diff',
            authorName: 'an',
            body: 'Cập nhật quantity',
            diffJson: [{ field: 'quantity', before: 50, after: 80 }],
            createdAt: '2026-11-22T07:05:00Z',
          },
        ], () => {}];
      }
      return [v, () => {}];
    },
    useEffect: () => {},
    useCallback: (fn) => fn,
  };
  const View = createRecordChatterView({ useAPIClient: () => ({ request: async () => ({ data: {} }) }) }, React);
  const tree = View({ targetCollection: 'latticeOrders', targetRecordId: 5, showExport: true });
  const dump = JSON.stringify(tree);
  assert.ok(dump.includes('dxos-record-chatter'));
  assert.ok(dump.includes('@emp-a2'));
  assert.ok(dump.includes('quantity: 50'));
  assert.ok(dump.includes('CSV') && dump.includes('XLSX') && dump.includes('PDF'));
});
