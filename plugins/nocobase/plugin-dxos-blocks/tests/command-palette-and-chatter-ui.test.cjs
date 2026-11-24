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

test('triggerBase64Download decodes base64 safely in browser and degrades in Node tests', () => {
  const { triggerBase64Download } = require(path.join(PLUGIN_ROOT, 'src/client/blocks-helpers.js'));
  assert.equal(typeof triggerBase64Download, 'function');

  // Node environment without browser globals
  const nodeRes = triggerBase64Download(Buffer.from('hello').toString('base64'), 'text/csv', 'test.csv');
  assert.deepEqual(nodeRes, { downloaded: false, reason: 'browser_unavailable' });

  // Mocked browser globals
  const origDoc = global.document;
  const origBlob = global.Blob;
  const origUrl = global.URL;
  const origAtob = global.atob;
  const createdAnchors = [];
  const revokedUrls = [];
  let createdBlob = null;
  try {
    global.atob = (b64) => Buffer.from(b64, 'base64').toString('binary');
    global.Blob = class MockBlob {
      constructor(parts, opts) {
        this.parts = parts;
        this.type = opts?.type;
        createdBlob = this;
      }
    };
    global.URL = {
      createObjectURL: () => 'blob:mock-123',
      revokeObjectURL: (u) => { revokedUrls.push(u); },
    };
    global.document = {
      body: { appendChild: () => {}, removeChild: () => {} },
      createElement: (tag) => {
        assert.equal(tag, 'a');
        const el = { href: '', download: '', style: {}, clicked: false, click() { this.clicked = true; } };
        createdAnchors.push(el);
        return el;
      },
    };

    const rawBytes = Buffer.from('Xin chào LatticeDX', 'utf8');
    const res = triggerBase64Download(rawBytes.toString('base64'), 'text/csv; charset=utf-8', 'report.csv');
    assert.deepEqual(res, { downloaded: true, filename: 'report.csv' });
    assert.equal(createdAnchors.length, 1);
    assert.equal(createdAnchors[0].download, 'report.csv');
    assert.equal(createdAnchors[0].href, 'blob:mock-123');
    assert.equal(createdAnchors[0].clicked, true);
    assert.deepEqual(revokedUrls, ['blob:mock-123']);
    assert.equal(createdBlob.type, 'text/csv; charset=utf-8');
    assert.equal(Buffer.from(createdBlob.parts[0]).toString('utf8'), 'Xin chào LatticeDX');
  } finally {
    global.document = origDoc;
    global.Blob = origBlob;
    global.URL = origUrl;
    global.atob = origAtob;
  }
});

test('command-palette removes dead paths, loads permitted dynamic portals, merges globalSearch, and fixes 390px badge wrapping', async () => {
  const {
    DEFAULT_COMMAND_ITEMS,
    buildDynamicCommandItems,
    mergeSearchHits,
    createCommandPaletteProvider,
  } = require(path.join(PLUGIN_ROOT, 'src/client/command-palette.js'));

  assert.equal(DEFAULT_COMMAND_ITEMS.some((i) => i.path === '/p/work' || i.path === '/p/internal-service'), false);
  assert.equal(DEFAULT_COMMAND_ITEMS.some((i) => i.path === '/admin/lattice-workspace'), true);
  assert.equal(DEFAULT_COMMAND_ITEMS.some((i) => i.path === '/p/services'), true);

  assert.equal(typeof buildDynamicCommandItems, 'function');
  const empDynamic = buildDynamicCommandItems(
    [
      { uid: 'admin-layout-model', slug: 'admin', title: 'Admin', routePath: '/admin', firstPagePath: '/admin/x' },
      { uid: 'ldx-portal-cold-qa', slug: 'cold-qa', title: 'QA Kho lạnh', routePath: '/p/cold-qa', firstPagePath: '/p/cold-qa/overview' },
    ],
    { isAdmin: false },
  );
  assert.equal(empDynamic.some((i) => i.path.startsWith('/p/cold-qa')), true);
  assert.equal(empDynamic.some((i) => i.path === '/admin/x' || i.adminOnly), false);
  assert.equal(empDynamic.some((i) => i.path === '/admin/lattice-workspace'), true);

  assert.equal(typeof mergeSearchHits, 'function');
  const merged = mergeSearchHits(
    [{ id: 7, title: 'SOP Kho lạnh', code: 'SOP-07', paraSpace: 'resources' }],
    [
      { collection: 'latticeParaDocuments', id: 7, code: 'SOP-07', title: 'SOP Kho lạnh', category: 'Tài liệu P.A.R.A.', path: '/p/services?paraDocId=7' },
      { collection: 'latticeOrders', id: 12, code: 'ORD-12', title: 'Đơn giao lạnh', category: 'Đơn Logistics', path: '/p/logistics' },
    ],
  );
  assert.equal(merged.length, 2);
  assert.equal(merged[0].path, '/p/services?paraDocId=7');
  assert.equal(merged[1].path, '/p/logistics');

  // Verify badge style has whiteSpace: nowrap and flexShrink: 0, plus live effects trigger listAccessible + globalSearch
  const effects = [];
  const requested = [];
  let timerFn = null;
  const origSetTimeout = global.setTimeout;
  const origClearTimeout = global.clearTimeout;
  global.setTimeout = (fn) => { timerFn = fn; return 1; };
  global.clearTimeout = () => {};
  try {
    const mockReact = {
      Fragment: 'Fragment',
      createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
      useState: (init) => {
        const v = typeof init === 'function' ? init() : init;
        if (v === false) return [true, () => {}];
        if (v === '') return ['mua sam', () => {}];
        return [v, () => {}];
      },
      useEffect: (fn) => { effects.push(fn); },
      useMemo: (fn) => fn(),
      useCallback: (fn) => fn,
    };
    const api = {
      request: async (req) => {
        requested.push(req);
        if (req.url === 'latticePortals:listAccessible') return { data: { data: [{ uid: 'ldx-portal-cold-qa', slug: 'cold-qa', title: 'QA Kho lạnh', routePath: '/p/cold-qa' }] } };
        if (req.url === 'latticePara:hybridSearch') return { data: { data: { items: [{ id: 5, title: 'Hướng dẫn Kho lạnh', paraSpace: 'resources' }] } } };
        if (req.url === 'dxosBlocks:globalSearch') return { data: { data: { items: [{ collection: 'latticeAssets', id: 9, code: 'ASSET-9', title: 'Tủ lạnh A1', category: 'Tài sản', path: '/p/procurement' }] } } };
        return { data: {} };
      },
    };
    const OpenProvider = createCommandPaletteProvider({ useAPIClient: () => api }, mockReact, {}, {});
    const tree = OpenProvider({ children: 'BODY' });
    const dump = JSON.stringify(tree);
    assert.ok(dump.includes('"whiteSpace":"nowrap"'));
    assert.ok(dump.includes('"flexShrink":0'));

    for (const fx of effects) fx();
    if (typeof timerFn === 'function') await timerFn();
    await new Promise((r) => setImmediate(r));
    assert.ok(requested.some((r) => r.url === 'latticePortals:listAccessible'));
    assert.ok(requested.some((r) => r.url === 'dxosBlocks:globalSearch' && r.params?.limit === 6));
  } finally {
    global.setTimeout = origSetTimeout;
    global.clearTimeout = origClearTimeout;
  }
});

test('dxosBlocks:globalSearch enforces auth, org scoping, collection ACL, ownScope, and accent-insensitive matching', async () => {
  const { readFileSync } = require('node:fs');
  const serverIndexSrc = readFileSync(path.join(PLUGIN_ROOT, 'src/server/index.js'), 'utf8');
  assert.ok(serverIndexSrc.includes('globalSearch'), 'src/server/index.js must allow globalSearch for loggedIn');

  const { createDxosBlocksActions } = require(path.join(PLUGIN_ROOT, 'src/server/blocks-api.js'));
  const employees = [
    { id: 10, userId: 101, organizationId: 'org-a', active: true },
    { id: 20, userId: 201, organizationId: 'org-b', active: true },
  ];
  const data = {
    latticeRequests: [
      { id: 1, organizationId: 'org-a', requesterId: 10, code: 'REQ-01', name: 'Đặt mua cảm biến lạnh', status: 'submitted', description: 'Kho Vaccine' },
      { id: 2, organizationId: 'org-a', requesterId: 99, code: 'REQ-02', name: 'Đặt mua cảm biến đồng nghiệp', status: 'draft', description: 'Kho khác' },
      { id: 3, organizationId: 'org-b', requesterId: 20, code: 'REQ-B1', name: 'Cảm biến org B', status: 'draft' },
    ],
    latticeOrders: [
      { id: 5, organizationId: 'org-a', requesterId: 10, code: 'ORD-05', name: 'Vận chuyển lạnh', status: 'in_transit' },
    ],
    latticeAssets: [
      { id: 8, organizationId: 'org-a', code: 'AST-08', name: 'Cảm biến nhiệt độ PT100', status: 'active' },
    ],
    latticeIncidentCases: [
      { id: 11, organizationId: 'org-a', code: 'INC-11', name: 'Sự cố cảm biến', status: 'open' },
    ],
    latticeServiceTickets: [],
    latticeParaDocuments: [
      { id: 15, organizationId: 'org-a', code: 'DOC-15', title: 'Quy trình bảo trì cảm biến', status: 'active', summary: 'SOP' },
    ],
  };
  const db = {
    getRepository(name) {
      if (name === 'latticeEmployees') return { find: async ({ filter }) => employees.filter((e) => Number(e.userId) === Number(filter?.userId)) };
      if (data[name]) {
        return {
          find: async ({ filter = {} } = {}) => data[name].filter((r) => !filter.organizationId || r.organizationId === filter.organizationId),
        };
      }
      return null;
    },
  };

  const actions = createDxosBlocksActions(db, {});

  // Unauthenticated rejected 401
  await assert.rejects(
    () => actions.globalSearch({ method: 'GET', state: {}, action: { params: { query: 'cam bien' } } }, async () => {}),
    (err) => err.status === 401,
  );

  // Invalid query length rejected 400
  await assert.rejects(
    () => actions.globalSearch({ method: 'GET', state: { currentUser: { id: 101 }, currentRole: 'ldx_employee' }, can: () => true, action: { params: { query: '   ' } } }, async () => {}),
    (err) => err.status === 400,
  );

  // Employee with permission on requests & para only, denied incidents/assets/orders:
  // sees ONLY own REQ-01 + DOC-15, NOT peer REQ-02, NOT org-b REQ-B1, NOT forbidden INC-11/AST-08
  const empCtx = {
    method: 'GET',
    state: { currentUser: { id: 101 }, currentRole: 'ldx_employee' },
    can: ({ resource }) => ['latticeRequests', 'latticeParaDocuments'].includes(resource),
    action: { params: { query: 'cam bien', limit: 20 } },
  };
  await actions.globalSearch(empCtx, async () => {});
  assert.equal(empCtx.body.query, 'cam bien');
  assert.equal(empCtx.body.count, 2);
  assert.deepEqual(empCtx.body.items.map((i) => `${i.collection}:${i.id}`).sort(), ['latticeParaDocuments:15', 'latticeRequests:1']);
  assert.equal(empCtx.body.items.find((i) => i.collection === 'latticeRequests').path, '/p/procurement');
  assert.equal(empCtx.body.items.find((i) => i.collection === 'latticeParaDocuments').path, '/p/services?paraDocId=15');
});

test('VoucherLifecycleBar, creative-studio export/voucher-actions, and Chatter export download work cleanly', async () => {
  const { createVoucherLifecycleBar, createRecordChatterView } = require(path.join(PLUGIN_ROOT, 'src/client/chatter-panel.js'));
  const { parseCreativeBlueprint, createCreativeStudioView, VALID_WIDGET_TYPES } = require(path.join(PLUGIN_ROOT, 'src/client/creative-studio-block.js'));

  assert.equal(typeof createVoucherLifecycleBar, 'function');
  assert.ok(VALID_WIDGET_TYPES.has('voucher-actions'));

  const React = {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
  };

  const Bar = createVoucherLifecycleBar({ useAPIClient: () => ({ request: async () => ({ data: {} }) }) }, React, {});
  assert.equal(Bar({ targetCollection: 'latticeAssets', targetRecordId: 1 }), null);

  const barTree = Bar({
    targetCollection: 'latticeRequests',
    targetRecordId: 10,
    recordStatus: 'cancelled',
    amendmentNo: 1,
    amendedFromId: 4,
  });
  const barDump = JSON.stringify(barTree);
  assert.ok(barDump.includes('dxos-voucher-lifecycle-bar'));
  assert.ok(barDump.includes('cancelled'));
  assert.ok(barDump.includes('#4') || barDump.includes('4'));

  // Creative Studio supports voucher-actions widget
  const bp = parseCreativeBlueprint({
    widgets: [
      { type: 'voucher-actions', title: 'Chứng từ', collection: 'latticeOrders', recordId: 5 },
      { type: 'export-bar', title: 'Xuất', collection: 'latticeOrders', formats: ['csv', 'pdf'] },
    ],
  });
  assert.equal(bp.widgets.length, 2);
  assert.equal(bp.widgets[0].type, 'voucher-actions');

  const StudioView = createCreativeStudioView({ useAPIClient: () => null }, React, {}, {});
  const studioTree = StudioView({ model: { props: { blueprintJson: JSON.stringify(bp) } } });
  const resolveTree = (node) => {
    if (!node || typeof node !== 'object') return node;
    if (typeof node.type === 'function') return resolveTree(node.type(node.props));
    return {
      ...node,
      children: Array.isArray(node.children) ? node.children.flat(Infinity).map(resolveTree) : node.children,
    };
  };
  assert.ok(JSON.stringify(resolveTree(studioTree)).includes('dxos-voucher-lifecycle-bar'));

  // Verify VoucherLifecycleBar invokes latticeVoucher:lineage, submit, cancel (with reason), and amend
  const voucherCalls = [];
  const voucherReact = {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (init) => {
      const v = typeof init === 'function' ? init() : init;
      if (v === '') return ['Ly do huy hop le', () => {}];
      return [v, () => {}];
    },
    useEffect: (fn) => { fn(); },
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
  };
  const voucherApi = {
    request: async (req) => {
      voucherCalls.push(req);
      if (req.url === 'latticeVoucher:lineage') {
        return { data: { data: { items: [{ id: 10, code: 'REQ-10', status: 'submitted', version: 2, amendmentNo: 0 }] } } };
      }
      return { data: { data: { id: 10, code: 'REQ-10', status: 'cancelled', amendmentNo: 1 } } };
    },
  };
  const InteractiveBar = createVoucherLifecycleBar({ useAPIClient: () => voucherApi }, voucherReact, {});
  const interactiveTree = InteractiveBar({ targetCollection: 'latticeRequests', targetRecordId: 10 });
  const findByTestId = (n, id) => {
    if (!n || typeof n !== 'object') return null;
    if (n.props?.['data-testid'] === id) return n;
    for (const c of Array.isArray(n.children) ? n.children.flat(Infinity) : []) {
      const hit = findByTestId(c, id);
      if (hit) return hit;
    }
    return null;
  };
  await findByTestId(interactiveTree, 'dxos-voucher-submit-btn').props.onClick();
  await findByTestId(interactiveTree, 'dxos-voucher-cancel-btn').props.onClick();
  await findByTestId(interactiveTree, 'dxos-voucher-amend-btn').props.onClick();
  assert.ok(voucherCalls.some((c) => c.url === 'latticeVoucher:lineage' && c.params?.collection === 'latticeRequests'));
  assert.ok(voucherCalls.some((c) => c.url === 'latticeVoucher:submit' && c.data?.id === 10));
  assert.ok(voucherCalls.some((c) => c.url === 'latticeVoucher:cancel' && c.data?.cancelReason === 'Ly do huy hop le'));
  assert.ok(voucherCalls.some((c) => c.url === 'latticeVoucher:amend' && c.data?.id === 10));

  // Verify export triggers download in Chatter and Creative Studio when browser globals are mocked
  const origDoc = global.document;
  const origBlob = global.Blob;
  const origUrl = global.URL;
  const origAtob = global.atob;
  const downloaded = [];
  try {
    global.atob = (b64) => Buffer.from(b64, 'base64').toString('binary');
    global.Blob = class MockBlob { constructor(parts, opts) { this.parts = parts; this.type = opts?.type; } };
    global.URL = { createObjectURL: () => 'blob:dl', revokeObjectURL: () => {} };
    global.document = {
      body: { appendChild: () => {}, removeChild: () => {} },
      createElement: () => ({ href: '', download: '', style: {}, click() { downloaded.push(this.download); } }),
    };

    const mockApi = {
      request: async () => ({
        data: {
          data: {
            filename: 'orders.csv',
            mimeType: 'text/csv',
            rowCount: 1,
            sha256: 'abcdef123456',
            contentBase64: Buffer.from('a,b\n1,2').toString('base64'),
          },
        },
      }),
    };
    const Chatter = createRecordChatterView({ useAPIClient: () => mockApi }, React, {});
    const cTree = Chatter({ targetCollection: 'latticeOrders', targetRecordId: 5, showExport: true });
    const collect = (n, out = []) => {
      if (!n || typeof n !== 'object') return out;
      out.push(n);
      if (Array.isArray(n.children)) n.children.flat(Infinity).forEach((c) => collect(c, out));
      return out;
    };
    const csvBtn = collect(cTree).find((n) => n.type === 'button' && JSON.stringify(n.children).includes('CSV'));
    assert.ok(csvBtn);
    await csvBtn.props.onClick();

    const StudioWithApi = createCreativeStudioView({ useAPIClient: () => mockApi }, React, {}, {});
    const sTree = StudioWithApi({
      model: { props: { blueprintJson: JSON.stringify({ widgets: [{ type: 'export-bar', title: 'Export', collection: 'latticeOrders', formats: ['csv'] }] }) } },
    });
    const studioCsvBtn = collect(sTree).find((n) => n.type === 'button' && JSON.stringify(n.children).includes('Xuất CSV'));
    assert.ok(studioCsvBtn);
    await studioCsvBtn.props.onClick();

    assert.deepEqual(downloaded, ['orders.csv', 'orders.csv']);
  } finally {
    global.document = origDoc;
    global.Blob = origBlob;
    global.URL = origUrl;
    global.atob = origAtob;
  }
});

test('createVoucherLifecycleBar resets stale lineage/version/reason across record switches and ignores out-of-order responses', async () => {
  const { createVoucherLifecycleBar } = require(path.join(PLUGIN_ROOT, 'src/client/chatter-panel.js'));

  const depsChanged = (a, b) => !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]));
  const createMiniHooks = () => {
    const states = [];
    const effects = [];
    const callbacks = [];
    let si = 0;
    let ei = 0;
    let ci = 0;
    let dirty = false;
    const React = {
      Fragment: 'Fragment',
      createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
      useState(init) {
        const idx = si++;
        if (!(idx in states)) states[idx] = typeof init === 'function' ? init() : init;
        return [states[idx], (updater) => {
          states[idx] = typeof updater === 'function' ? updater(states[idx]) : updater;
          dirty = true;
        }];
      },
      useEffect(fn, deps) {
        const idx = ei++;
        const prev = effects[idx];
        if (!prev || depsChanged(prev.deps, deps)) {
          effects[idx] = { fn, deps, cleanup: prev?.cleanup, pending: true };
        }
      },
      useCallback(fn, deps) {
        const idx = ci++;
        const prev = callbacks[idx];
        if (!prev || depsChanged(prev.deps, deps)) {
          callbacks[idx] = { fn, deps };
        }
        return callbacks[idx].fn;
      },
    };
    const render = (Comp, props) => {
      let tree;
      for (let pass = 0; pass < 4; pass += 1) {
        si = 0;
        ei = 0;
        ci = 0;
        dirty = false;
        tree = Comp(props);
        for (const ef of effects) {
          if (ef && ef.pending) {
            ef.pending = false;
            if (typeof ef.cleanup === 'function') ef.cleanup();
            ef.cleanup = ef.fn();
          }
        }
        if (!dirty) break;
      }
      return tree;
    };
    return { React, render };
  };

  const findByTestId = (n, id) => {
    if (!n || typeof n !== 'object') return null;
    if (n.props?.['data-testid'] === id) return n;
    for (const c of Array.isArray(n.children) ? n.children.flat(Infinity) : []) {
      const hit = findByTestId(c, id);
      if (hit) return hit;
    }
    return null;
  };
  const textOf = (n) => {
    if (typeof n === 'string' || typeof n === 'number') return String(n);
    if (!n || typeof n !== 'object') return '';
    return (Array.isArray(n.children) ? n.children.flat(Infinity) : []).map(textOf).join('');
  };

  let resolveDelayedLineage;
  const submittedPayloads = [];
  const api = {
    request: async (req) => {
      if (req.url === 'latticeVoucher:lineage' && req.params?.id === 10) {
        return {
          data: {
            data: {
              items: [
                { id: 3, code: 'REQ-3', status: 'cancelled', version: 1, amendmentNo: 0 },
                { id: 10, code: 'REQ-10', status: 'submitted', version: 7, amendmentNo: 2, amendedFromId: 3 },
              ],
            },
          },
        };
      }
      if (req.url === 'latticeVoucher:lineage' && req.params?.id === 11) {
        // Delayed out-of-order response for id 11
        return new Promise((resolve) => { resolveDelayedLineage = resolve; });
      }
      if (req.url === 'latticeVoucher:lineage' && req.params?.id === 22) {
        throw Object.assign(new Error('Unsupported'), { response: { status: 400 } });
      }
      if (req.url === 'latticeServiceTickets:get') {
        return { data: { data: { id: 22, code: 'SRV-22', status: 'draft' } } };
      }
      if (req.url === 'latticeVoucher:submit') {
        submittedPayloads.push(req.data);
        return { data: { data: { id: req.data.id, status: 'submitted' } } };
      }
      return { data: {} };
    },
  };

  const { React, render } = createMiniHooks();
  const Bar = createVoucherLifecycleBar({ useAPIClient: () => api }, React, {});

  // 1. Render record 10 (latticeRequests), wait for lineage, and type reason
  let tree = render(Bar, { targetCollection: 'latticeRequests', targetRecordId: 10 });
  await new Promise((r) => setTimeout(r, 10));
  tree = render(Bar, { targetCollection: 'latticeRequests', targetRecordId: 10 });
  findByTestId(tree, 'dxos-voucher-reason-input').props.onChange({ target: { value: 'Old cancel reason' } });
  tree = render(Bar, { targetCollection: 'latticeRequests', targetRecordId: 10 });
  assert.ok(textOf(findByTestId(tree, 'dxos-voucher-lineage')).includes('#3'));
  assert.equal(findByTestId(tree, 'dxos-voucher-reason-input').props.value, 'Old cancel reason');

  // 2. Switch to #11 (stalls in-flight), then switch immediately to latticeServiceTickets #22
  //    (:lineage fails -> falls back to :get without version/amendedFromId)
  tree = render(Bar, { targetCollection: 'latticeRequests', targetRecordId: 11 });
  tree = render(Bar, { targetCollection: 'latticeServiceTickets', targetRecordId: 22 });
  // Immediately verify reset of stale reason & lineage
  assert.equal(findByTestId(tree, 'dxos-voucher-reason-input').props.value, '');
  assert.equal(textOf(findByTestId(tree, 'dxos-voucher-lineage')), 'Chứng từ gốc');

  await new Promise((r) => setTimeout(r, 10));
  tree = render(Bar, { targetCollection: 'latticeServiceTickets', targetRecordId: 22 });
  assert.equal(textOf(findByTestId(tree, 'dxos-voucher-lineage')), 'Chứng từ gốc');
  assert.ok(textOf(findByTestId(tree, 'dxos-voucher-status-badge')).includes('draft'));

  // 3. Clicking submit on #22 must NOT pass stale expectedVersion: 7 from #10
  await findByTestId(tree, 'dxos-voucher-submit-btn').props.onClick();
  assert.equal(submittedPayloads.length, 1);
  assert.equal(submittedPayloads[0].id, 22);
  assert.equal(submittedPayloads[0].expectedVersion, undefined);

  // 4. Even if the older in-flight response for #11 settles late, it must not overwrite #22
  assert.equal(typeof resolveDelayedLineage, 'function');
  resolveDelayedLineage({
    data: { data: { items: [{ id: 11, status: 'cancelled', version: 99, amendmentNo: 5, amendedFromId: 3 }] } },
  });
  await new Promise((r) => setTimeout(r, 10));
  tree = render(Bar, { targetCollection: 'latticeServiceTickets', targetRecordId: 22 });
  assert.equal(textOf(findByTestId(tree, 'dxos-voucher-lineage')), 'Chứng từ gốc');
});

test('dxosBlocks:globalSearch finds own older records past 200 colleague rows and fails closed when organizationId missing', async () => {
  const { createDxosBlocksActions } = require(path.join(PLUGIN_ROOT, 'src/server/blocks-api.js'));
  const employees = [{ id: 10, userId: 101, organizationId: 'org-a', active: true }];
  const requests = [];
  for (let i = 0; i < 240; i += 1) {
    requests.push({
      id: 1000 - i,
      organizationId: 'org-a',
      requesterId: 99,
      code: `REQ-COL-${i}`,
      name: `Đơn đồng nghiệp nhiệt kế ${i}`,
      status: 'submitted',
    });
  }
  requests.push({
    id: 5,
    organizationId: 'org-a',
    requesterId: 10,
    code: 'REQ-OWN-OLD',
    name: 'Nhiệt kế chuẩn của tôi',
    status: 'draft',
  });
  requests.push({
    id: 4,
    organizationId: undefined,
    requesterId: 10,
    code: 'REQ-NO-ORG',
    name: 'Nhiệt kế thiếu tổ chức',
    status: 'draft',
  });

  const seenFilters = [];
  const matchesFilter = (row, filter = {}) => Object.entries(filter).every(([k, v]) => {
    if (k === '$and' && Array.isArray(v)) return v.every((sub) => matchesFilter(row, sub));
    if (k === '$or' && Array.isArray(v)) return v.some((sub) => matchesFilter(row, sub));
    return row[k] === v;
  });
  const db = {
    getCollection: () => ({ fields: new Set(['id', 'code', 'name', 'organizationId', 'requesterId', 'assigneeId', 'status']) }),
    getRepository(name) {
      if (name === 'latticeEmployees') return { find: async ({ filter }) => employees.filter((e) => Number(e.userId) === Number(filter?.userId)) };
      if (name === 'latticeRequests') {
        return {
          find: async ({ filter = {}, limit = 200, offset = 0 }) => {
            seenFilters.push(filter);
            return requests.filter((r) => matchesFilter(r, filter)).slice(offset, offset + limit);
          },
        };
      }
      return null;
    },
  };

  const actions = createDxosBlocksActions(db, {});
  const ctx = {
    method: 'GET',
    state: { currentUser: { id: 101 }, currentRole: 'ldx_employee' },
    can: ({ resource }) => resource === 'latticeRequests',
    action: { params: { query: 'nhiet ke', limit: 10 } },
  };
  await actions.globalSearch(ctx, async () => {});

  // Must push owner $or inside $and with organizationId AND exclude record missing organizationId
  assert.ok(seenFilters.some((f) => Array.isArray(f?.$and) && f.$and.some((p) => Array.isArray(p?.$or))));
  assert.deepEqual(ctx.body.items.map((i) => i.code), ['REQ-OWN-OLD']);
  assert.equal(ctx.body.items.some((i) => i.code === 'REQ-NO-ORG'), false);

  // Manager (org-wide role) searches beyond row 200 across paginated batches
  requests.push({
    id: 2,
    organizationId: 'org-a',
    requesterId: 99,
    code: 'REQ-OLD-245',
    name: 'Tủ đông sâu đặc biệt',
    status: 'approved',
  });
  const mgrCtx = {
    method: 'GET',
    state: { currentUser: { id: 101 }, currentRole: 'ldx_manager' },
    can: ({ resource }) => resource === 'latticeRequests',
    action: { params: { query: 'tu dong sau', limit: 10 } },
  };
  await actions.globalSearch(mgrCtx, async () => {});
  assert.deepEqual(mgrCtx.body.items.map((i) => i.code), ['REQ-OLD-245']);
});

test('DxosRecordWorkbenchBlockModel, RecordChatterView, and VoucherLifecycleBar wrap cleanly on 390px mobile and use consistent Vietnamese labels', async () => {
  const { registerDxosBlockModels } = require(path.join(PLUGIN_ROOT, 'src/client/block-models.js'));
  const { createRecordChatterView, createVoucherLifecycleBar } = require(path.join(PLUGIN_ROOT, 'src/client/chatter-panel.js'));

  const React = {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
  };

  class MockBlockModel {
    constructor(opts = {}) {
      this.props = opts.props || {};
      this.stepParams = opts.stepParams || {};
    }
    setProps(next) { this.props = { ...this.props, ...next }; }
    getStepParams(flowKey, stepKey) { return this.stepParams?.[flowKey]?.[stepKey]; }
    static define(meta) { this.meta = meta; }
    static registerFlow(flow) { this.flows = [...(this.flows || []), flow]; }
  }

  const resolveTree = (node) => {
    if (!node || typeof node !== 'object') return node;
    if (typeof node.type === 'function') return resolveTree(node.type(node.props));
    return {
      ...node,
      children: Array.isArray(node.children) ? node.children.flat(Infinity).map(resolveTree) : node.children,
    };
  };

  const models = registerDxosBlockModels(
    { useAPIClient: () => null, useUIConfigurationPermissions: () => ({ allowAll: false }) },
    React,
    {},
    { BlockModel: MockBlockModel },
    { registerModels() {} },
    {},
  );
  const workbenchInst = new models.DxosRecordWorkbenchBlockModel({
    props: { collection: 'latticeRequests', recordId: '7', showExport: true, showVoucherActions: true, showChatter: true },
  });
  const workbenchEl = workbenchInst.renderComponent();
  const workbenchDump = JSON.stringify(resolveTree(workbenchEl.type(workbenchEl.props)));

  assert.ok(workbenchDump.includes('"flexWrap":"wrap"'));
  assert.ok(workbenchDump.includes('repeat(auto-fit, minmax(135px, 1fr))'));
  for (const label of ['Lọc', 'Làm mới', 'Trình duyệt', 'Hủy chứng từ', 'Lập bản điều chỉnh']) {
    assert.ok(workbenchDump.includes(label), `Missing Vietnamese label: ${label}`);
  }

  // Verify VoucherLifecycleBar shows 'Chuỗi phiên bản' when lineage > 1 and uses 'Lập bản điều chỉnh'
  const voucherReact = {
    ...React,
    useState: (init) => {
      const v = typeof init === 'function' ? init() : init;
      if (v && typeof v === 'object' && Array.isArray(v.lineage)) {
        return [{
          status: 'cancelled',
          version: 2,
          amendmentNo: 1,
          amendedFromId: 3,
          lineage: [
            { id: 3, code: 'REQ-3', status: 'cancelled' },
            { id: 7, code: 'REQ-7', status: 'draft' },
          ],
        }, () => {}];
      }
      return [v, () => {}];
    },
  };
  const Bar = createVoucherLifecycleBar({ useAPIClient: () => null }, voucherReact, {});
  const barDump = JSON.stringify(Bar({ targetCollection: 'latticeRequests', targetRecordId: 7 }));
  assert.ok(barDump.includes('Chuỗi phiên bản'));
  assert.ok(barDump.includes('Lập bản điều chỉnh'));
  assert.ok(barDump.includes('repeat(auto-fit, minmax(135px, 1fr))'));

  // Verify RecordChatterView filter ('Lọc') and refresh ('Làm mới') and mobile form flexWrap
  const chatterCalls = [];
  const chatterReact = {
    ...React,
    useState: (init) => {
      const v = typeof init === 'function' ? init() : init;
      if (Array.isArray(v)) {
        return [[
          { id: 1, entryType: 'comment', authorName: 'an', body: 'Bình luận test', createdAt: '2026-11-22T07:00:00Z' },
          { id: 2, entryType: 'field_diff', authorName: 'an', body: 'Đổi trường', diffJson: [{ field: 'status', before: 'draft', after: 'submitted' }], createdAt: '2026-11-22T07:05:00Z' },
        ], () => {}];
      }
      if (v === 'all') return ['field_diff', () => {}];
      return [v, () => {}];
    },
  };
  const Chatter = createRecordChatterView({
    useAPIClient: () => ({
      request: async (req) => {
        chatterCalls.push(req);
        return { data: { data: { items: [] } } };
      },
    }),
  }, chatterReact, {});
  const chatterTree = Chatter({ targetCollection: 'latticeRequests', targetRecordId: 7 });
  const chatterDump = JSON.stringify(chatterTree);
  assert.ok(chatterDump.includes('Lọc'));
  assert.ok(chatterDump.includes('Làm mới'));
  assert.equal(chatterDump.includes('Bình luận test'), false, 'entryType filter should filter out comments when set to field_diff');
  assert.ok(chatterDump.includes('Đổi trường'));
  const collect = (n, out = []) => {
    if (!n || typeof n !== 'object') return out;
    out.push(n);
    if (Array.isArray(n.children)) n.children.flat(Infinity).forEach((c) => collect(c, out));
    return out;
  };
  const refreshBtn = collect(chatterTree).find((n) => n.type === 'button' && JSON.stringify(n.children).includes('Làm mới'));
  assert.ok(refreshBtn);
  await refreshBtn.props.onClick();
  assert.ok(chatterCalls.some((c) => c.url === 'latticeChatter:list'));
});

test('Task 16: CommandPaletteProvider calls useCurrentUserContext unconditionally across role transitions (Rules of Hooks)', () => {
  const { createCommandPaletteProvider } = require(path.join(PLUGIN_ROOT, 'src/client/command-palette.js'));

  // Strict hook-order recorder simulating React's internal hook cursor enforcement
  const hookLog = [];
  let currentPass = [];
  let stateCursor = 0;
  const states = [];
  const strictReact = {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState(init) {
      currentPass.push('useState');
      const idx = stateCursor++;
      if (!(idx in states)) states[idx] = typeof init === 'function' ? init() : init;
      return [states[idx], (u) => { states[idx] = typeof u === 'function' ? u(states[idx]) : u; }];
    },
    useEffect() { currentPass.push('useEffect'); },
    useMemo(fn) { currentPass.push('useMemo'); return fn(); },
    useCallback(fn) { currentPass.push('useCallback'); return fn; },
  };

  let authRole = 'admin';
  let ctxRole = '';
  let userCtxCalls = 0;
  const mockClient = {
    useAPIClient() {
      currentPass.push('useAPIClient');
      return { auth: { role: authRole } };
    },
    useCurrentUserContext() {
      currentPass.push('useCurrentUserContext');
      userCtxCalls += 1;
      return { data: { currentRole: ctxRole } };
    },
  };
  const mockApp = { apiClient: { auth: { get role() { return authRole; } } } };

  const Provider = createCommandPaletteProvider(mockClient, strictReact, {}, mockApp);
  const renderPass = () => {
    currentPass = [];
    stateCursor = 0;
    const out = Provider({ children: 'OK' });
    hookLog.push(currentPass.slice());
    return out;
  };

  // Render 1: app.apiClient.auth.role === 'admin'
  renderPass();
  // Render 2: app.apiClient.auth.role === '' and ctxRole === 'ldx_admin'
  authRole = '';
  ctxRole = 'ldx_admin';
  renderPass();
  // Render 3: app.apiClient.auth.role === '' and ctxRole === 'ldx_employee'
  ctxRole = 'ldx_employee';
  renderPass();

  assert.equal(userCtxCalls, 3, 'useCurrentUserContext must be called on every render regardless of app.apiClient.auth.role');
  assert.deepEqual(hookLog[1], hookLog[0], 'Hook call order must be identical when role changes from admin to empty');
  assert.deepEqual(hookLog[2], hookLog[0], 'Hook call order must be identical across role transitions');
});

test('Task 16: DxosParaVaultView reads ?paraDocId=, handles popstate & detail drawer, and resolves orgs without hardcoded native-ui-lab', async () => {
  const { registerDxosBlockModels } = require(path.join(PLUGIN_ROOT, 'src/client/block-models.js'));

  const depsChanged = (a, b) => !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]));
  const states = [];
  const effects = [];
  const memos = [];
  const callbacks = [];
  let si = 0;
  let ei = 0;
  let mi = 0;
  let ci = 0;
  let dirty = false;
  const hooksReact = {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({
      type,
      props: props || {},
      children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
    }),
    useState(init) {
      const idx = si++;
      if (!(idx in states)) states[idx] = typeof init === 'function' ? init() : init;
      return [states[idx], (u) => { states[idx] = typeof u === 'function' ? u(states[idx]) : u; dirty = true; }];
    },
    useEffect(fn, deps) {
      const idx = ei++;
      const prev = effects[idx];
      if (!prev || depsChanged(prev.deps, deps)) {
        effects[idx] = { fn, deps, cleanup: prev?.cleanup, pending: true };
      }
    },
    useMemo(fn, deps) {
      const idx = mi++;
      const prev = memos[idx];
      if (!prev || depsChanged(prev.deps, deps)) memos[idx] = { value: fn(), deps };
      return memos[idx].value;
    },
    useCallback(fn, deps) {
      const idx = ci++;
      const prev = callbacks[idx];
      if (!prev || depsChanged(prev.deps, deps)) callbacks[idx] = { fn, deps };
      return callbacks[idx].fn;
    },
  };
  const renderTree = (el) => {
    let out;
    for (let p = 0; p < 5; p += 1) {
      si = 0; ei = 0; mi = 0; ci = 0; dirty = false;
      out = el.type(el.props);
      for (const ef of effects) {
        if (ef && ef.pending) {
          ef.pending = false;
          if (typeof ef.cleanup === 'function') ef.cleanup();
          ef.cleanup = ef.fn();
        }
      }
      if (!dirty) break;
    }
    return out;
  };
  const findByTestId = (n, id) => {
    if (!n || typeof n !== 'object') return null;
    if (n.props?.['data-testid'] === id) return n;
    for (const c of Array.isArray(n.children) ? n.children.flat(Infinity) : []) {
      const hit = findByTestId(c, id);
      if (hit) return hit;
    }
    return null;
  };

  class MockBlockModel {
    constructor(opts = {}) { this.props = opts.props || {}; }
    setProps(next) { this.props = { ...this.props, ...next }; }
    getStepParams() { return {}; }
    static define(meta) { this.meta = meta; }
    static registerFlow(flow) { this.flows = [...(this.flows || []), flow]; }
  }

  const origWin = global.window;
  const winListeners = new Map();
  const replacedUrls = [];
  const apiCalls = [];
  try {
    global.window = {
      location: {
        pathname: '/p/services',
        search: '?paraDocId=99',
        href: 'http://localhost/p/services?paraDocId=99',
      },
      history: {
        replaceState: (_s, _t, u) => {
          replacedUrls.push(u);
          global.window.location.search = u.includes('?') ? `?${u.split('?')[1]}` : '';
          global.window.location.href = `http://localhost${u}`;
        },
      },
      addEventListener: (ev, fn) => winListeners.set(ev, fn),
      removeEventListener: (ev) => winListeners.delete(ev),
    };

    const api = {
      async request(req) {
        apiCalls.push(req);
        if (req.url === 'latticeParaDocuments:list') {
          return {
            data: {
              data: [{ id: 5, code: 'SOP-05', title: 'Quy trình Kho lạnh', paraSpace: 'resources', summary: 'Tóm tắt 05' }],
            },
          };
        }
        if (req.url === 'latticeParaDocuments:get' && String(req.params?.filterByTk) === '99') {
          return {
            data: {
              data: { id: 99, code: 'SOP-99', title: 'Tài liệu chi tiết 99', paraSpace: 'projects', summary: 'Chi tiết qua filterByTk', content: 'Nội dung đầy đủ 99' },
            },
          };
        }
        if (req.url === 'latticePara:summary') {
          return { data: { data: { organizationId: null, organizations: [] } } };
        }
        if (req.url === 'latticeOrganizations:list') {
          return { data: { data: [{ id: 1, organizationId: 'acme-cold-chain', active: true }] } };
        }
        if (req.url === 'latticeParaDocuments:create') {
          return { data: { data: { id: 100, ...req.data } } };
        }
        return { data: { data: {} } };
      },
    };

    const models = registerDxosBlockModels(
      { useAPIClient: () => api, useUIConfigurationPermissions: () => ({ allowAll: true }) },
      hooksReact,
      {},
      { BlockModel: MockBlockModel },
      { registerModels() {} },
      {},
    );
    const paraInst = new models.DxosParaVaultBlockModel({ props: { title: 'Kho P.A.R.A.' } });
    let tree = renderTree(paraInst.renderComponent());
    await new Promise((r) => setTimeout(r, 25));
    tree = renderTree(paraInst.renderComponent());

    // 1. Loaded ?paraDocId=99 via filterByTk and rendered detail card
    assert.ok(apiCalls.some((c) => c.url === 'latticeParaDocuments:get' && String(c.params?.filterByTk) === '99'));
    const detail = findByTestId(tree, 'dxos-para-doc-detail');
    assert.ok(detail, 'Expected dxos-para-doc-detail to render for ?paraDocId=99');
    assert.ok(JSON.stringify(detail).includes('SOP-99'));
    assert.ok(JSON.stringify(detail).includes('Nội dung đầy đủ 99'));

    // 2. Dynamic org resolved from latticeOrganizations:list (no hardcoded native-ui-lab anywhere)
    const dump = JSON.stringify(tree);
    assert.ok(dump.includes('acme-cold-chain'));
    assert.equal(dump.includes('native-ui-lab'), false, 'DxosParaVaultView must never fall back to hardcoded native-ui-lab');

    // 3. Close button clears paraDocId from URL and hides detail card
    findByTestId(tree, 'dxos-para-doc-detail-close').props.onClick();
    tree = renderTree(paraInst.renderComponent());
    assert.equal(findByTestId(tree, 'dxos-para-doc-detail'), null);
    assert.deepEqual(replacedUrls, ['/p/services']);

    // 4. popstate to ?paraDocId=5 highlights & opens item #5 from loaded items
    global.window.location.search = '?paraDocId=5';
    global.window.location.href = 'http://localhost/p/services?paraDocId=5';
    winListeners.get('popstate')?.();
    tree = renderTree(paraInst.renderComponent());
    const detail5 = findByTestId(tree, 'dxos-para-doc-detail');
    assert.ok(detail5 && JSON.stringify(detail5).includes('SOP-05'));
    assert.ok(JSON.stringify(tree).includes('"data-selected":"true"'));
  } finally {
    global.window = origWin;
  }
});

test('Task 16: dxosBlocks:alarmIngest resolves root organizationId dynamically and fails 400 ORG_REQUIRED when unresolvable', async () => {
  const { createDxosBlocksActions } = require(path.join(PLUGIN_ROOT, 'src/server/blocks-api.js'));

  const createdIncidents = [];
  let orgRows = [];
  const db = {
    getRepository(name) {
      if (name === 'latticeOrganizations') {
        return {
          find: async () => orgRows,
        };
      }
      if (name === 'latticeIncidentCases') {
        return {
          find: async () => [],
          create: async ({ values }) => {
            const row = { id: createdIncidents.length + 1, ...values };
            createdIncidents.push(row);
            return row;
          },
        };
      }
      return null;
    },
  };

  const actions = createDxosBlocksActions(db, {});

  // 1. Root with no organizationId and no active latticeOrganizations -> 400 ORG_REQUIRED
  await assert.rejects(
    () => actions.alarmIngest({
      method: 'POST',
      state: { currentUser: { id: 1, username: 'root' }, currentRole: 'root' },
      action: { params: { values: { ruleCode: 'TEMP-HIGH', severity: 'high' } } },
    }, async () => {}),
    (err) => err.status === 400 && err.code === 'ORG_REQUIRED',
  );

  // 2. Root with active latticeOrganizations record resolves dynamically (never 'native-ui-lab')
  orgRows = [{ id: 10, organizationId: 'mekong-pharma', active: true }];
  const okCtx = {
    method: 'POST',
    state: { currentUser: { id: 1, username: 'root' }, currentRole: 'root' },
    action: { params: { values: { assetId: 12, ruleCode: 'TEMP-HIGH', severity: 'high', summary: 'Cảnh báo động' } } },
  };
  await actions.alarmIngest(okCtx, async () => {});
  assert.equal(createdIncidents.length, 1);
  assert.equal(createdIncidents[0].organizationId, 'mekong-pharma');
  assert.equal(createdIncidents[0].assetEntityId, 'urn:ngsi-ld:Asset:mekong-pharma:native:12');
});
