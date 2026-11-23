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
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(PLUGIN_ROOT, '../../..');

function createMiniHooks() {
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

  const React = {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({
      type,
      props: props || {},
      children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
    }),
    useState(init) {
      const idx = si++;
      if (!(idx in states)) states[idx] = typeof init === 'function' ? init() : init;
      return [
        states[idx],
        (updater) => {
          states[idx] = typeof updater === 'function' ? updater(states[idx]) : updater;
          dirty = true;
        },
      ];
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
      if (!prev || depsChanged(prev.deps, deps)) {
        memos[idx] = { value: fn(), deps };
      }
      return memos[idx].value;
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
    for (let pass = 0; pass < 6; pass += 1) {
      si = 0;
      ei = 0;
      mi = 0;
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

  const unmount = () => {
    for (const ef of effects) {
      if (ef && typeof ef.cleanup === 'function') {
        ef.cleanup();
        ef.cleanup = undefined;
      }
    }
  };

  return { React, render, unmount };
}

function resolveTree(node) {
  if (!node || typeof node !== 'object') return node;
  if (typeof node.type === 'function') return resolveTree(node.type(node.props));
  return {
    ...node,
    children: Array.isArray(node.children) ? node.children.flat(Infinity).map(resolveTree) : node.children,
  };
}

function collectNodes(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  out.push(node);
  if (Array.isArray(node.children)) {
    for (const c of node.children.flat(Infinity)) collectNodes(c, out);
  }
  return out;
}

function findByTestId(node, id) {
  return collectNodes(node).find((n) => n.props?.['data-testid'] === id) || null;
}

function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (!node || typeof node !== 'object') return '';
  return (Array.isArray(node.children) ? node.children.flat(Infinity) : []).map(textOf).join(' ');
}

test('webgis-block pure helpers project Vietnam geo points, reject invalid coords, and classify cold-chain markers', () => {
  const {
    projectGeoPoint,
    classifyColdChainMarker,
    DEFAULT_VIETNAM_GEO_MARKERS,
  } = require(path.join(PLUGIN_ROOT, 'src/client/webgis-block.js'));

  assert.ok(Array.isArray(DEFAULT_VIETNAM_GEO_MARKERS) && DEFAULT_VIETNAM_GEO_MARKERS.length >= 4);

  const canTho = projectGeoPoint(10.0452, 105.7469);
  const hanoi = projectGeoPoint(21.0278, 105.8342);
  const daNang = projectGeoPoint(16.0544, 108.2022);
  assert.ok(canTho && hanoi && daNang);
  assert.ok(canTho.x >= 0 && canTho.x <= 640 && canTho.y >= 0 && canTho.y <= 360);
  assert.ok(hanoi.y < canTho.y, 'Northern Hanoi must have smaller SVG y than southern Can Tho');
  assert.ok(daNang.x > canTho.x, 'Eastern Da Nang must have larger SVG x than Can Tho');

  // Finite out-of-Vietnam bounds clamp cleanly within viewport
  const clamped = projectGeoPoint(7.2, 111.5);
  assert.ok(clamped && clamped.clamped === true);
  assert.ok(clamped.x >= 0 && clamped.x <= 640 && clamped.y >= 0 && clamped.y <= 360);

  // Invalid / non-finite / out-of-earth coords safely return null
  for (const [badLat, badLng] of [
    [NaN, 106],
    [10.7, Infinity],
    [null, 106],
    ['', 106],
    [true, 106],
    [95, 106],
    [-91, 106],
    [10, 185],
    [10, -181],
  ]) {
    assert.equal(projectGeoPoint(badLat, badLng), null);
  }

  const crit = classifyColdChainMarker({ severity: 'critical', temperatureC: -8.4, targetTempC: -18, twinStatus: 'pending_hitl' });
  assert.equal(crit.color, '#dc2626');
  assert.equal(crit.level, 'critical');
  assert.equal(crit.twinStatus, 'pending_hitl');

  const warn = classifyColdChainMarker({ status: 'hold_mkt', mktCelsius: -14.2, targetTempC: -18, twinStatus: 'dispatched' });
  assert.equal(warn.color, '#d97706');
  assert.equal(warn.level, 'warning');
  assert.equal(warn.twinStatus, 'dispatched');

  const ok = classifyColdChainMarker({ status: 'active', temperatureC: -18.1, targetTempC: -18, twinStatus: 'synced' });
  assert.equal(ok.color, '#059669');
  assert.equal(ok.level, 'normal');
  assert.equal(ok.twinStatus, 'synced');
});

test('DxosWebGisBlockView loads assets/locations/incidents/twinShadow, degrades gracefully, and supports filter & pin selection', async () => {
  const { createWebGisBlockView } = require(path.join(PLUGIN_ROOT, 'src/client/webgis-block.js'));
  const { React, render } = createMiniHooks();

  const calls = [];
  const api = {
    async request(req) {
      calls.push(req);
      if (req.url === 'latticeAssets:list') {
        return {
          data: {
            data: [
              { id: 12, code: 'COLD-CT-01', name: 'Kho lạnh Cần Thơ 01', kind: 'cold_room', status: 'active', locationId: 1 },
              { id: 15, code: 'COLD-HN-02', name: 'Kho lạnh Hà Nội 02', kind: 'cold_room', status: 'active', locationId: 2 },
            ],
          },
        };
      }
      if (req.url === 'latticeLocations:list') {
        return {
          data: {
            data: [
              { id: 1, code: 'LOC-CT', name: 'Trung tâm Cần Thơ', kind: 'warehouse', address: 'Ninh Kiều, Cần Thơ' },
              { id: 2, code: 'LOC-HN', name: 'Kho Hà Nội', kind: 'warehouse', address: 'Nội Bài, Hà Nội' },
            ],
          },
        };
      }
      if (req.url === 'latticeIncidentCases:list') {
        return {
          data: {
            data: [
              { id: 88, code: 'INC-88', assetId: 12, severity: 'critical', status: 'open', name: 'Nhiệt độ vượt -12°C' },
            ],
          },
        };
      }
      if (req.url === 'dxosBlocks:twinShadow') {
        return {
          data: {
            data: {
              shadow: {
                assetId: Number(req.data?.assetId || req.params?.assetId),
                commandStatus: Number(req.data?.assetId) === 12 ? 'pending_hitl' : 'synced',
                desiredJson: { targetTempC: -18 },
                reportedJson: { targetTempC: Number(req.data?.assetId) === 12 ? -11.5 : -18.1 },
              },
            },
          },
        };
      }
      throw Object.assign(new Error('Not found'), { response: { status: 404 } });
    },
  };

  const View = createWebGisBlockView({ useAPIClient: () => api }, React, {}, {});
  let tree = render(View, { model: { props: { title: 'WebGIS Chuỗi lạnh', showTwinOverlay: true } } });
  await new Promise((r) => setTimeout(r, 20));
  tree = render(View, { model: { props: { title: 'WebGIS Chuỗi lạnh', showTwinOverlay: true } } });

  assert.ok(findByTestId(tree, 'dxos-webgis-block'));
  assert.ok(calls.some((c) => c.url === 'latticeAssets:list' && c.skipNotify === true));
  assert.ok(calls.some((c) => c.url === 'latticeLocations:list' && c.skipNotify === true));
  assert.ok(calls.some((c) => c.url === 'latticeIncidentCases:list' && c.skipNotify === true));
  assert.ok(calls.some((c) => c.url === 'dxosBlocks:twinShadow' && c.skipNotify === true));

  const pins = collectNodes(tree).filter((n) => n.props?.['data-testid'] === 'dxos-webgis-pin');
  assert.ok(pins.length >= 2);

  // Filter to Cold-Chain Alarms only -> pin 12 remains, non-alarm pins filtered out
  const alarmFilterBtn = findByTestId(tree, 'dxos-webgis-filter-alarms');
  assert.ok(alarmFilterBtn);
  alarmFilterBtn.props.onClick();
  tree = render(View, { model: { props: { title: 'WebGIS Chuỗi lạnh', showTwinOverlay: true } } });
  const alarmPins = collectNodes(tree).filter((n) => n.props?.['data-testid'] === 'dxos-webgis-pin');
  assert.equal(alarmPins.length, 1);
  assert.equal(alarmPins[0].props['data-severity'], 'critical');

  // Switch back to All and select second pin
  findByTestId(tree, 'dxos-webgis-filter-all').props.onClick();
  tree = render(View, { model: { props: { title: 'WebGIS Chuỗi lạnh', showTwinOverlay: true } } });
  const allPins = collectNodes(tree).filter((n) => n.props?.['data-testid'] === 'dxos-webgis-pin');
  allPins[1].props.onClick();
  tree = render(View, { model: { props: { title: 'WebGIS Chuỗi lạnh', showTwinOverlay: true } } });
  assert.ok(textOf(tree).includes('COLD-HN-02'));
  assert.ok(textOf(tree).includes('synced'));
});

test('kanban-schedule-block helpers group voucher & stock lot stages and build 7-day UTC schedule grid', () => {
  const {
    KANBAN_STAGE_ORDER,
    groupRecordsByKanbanStage,
    buildScheduleDaysGrid,
  } = require(path.join(PLUGIN_ROOT, 'src/client/kanban-schedule-block.js'));

  assert.deepEqual(KANBAN_STAGE_ORDER, ['draft', 'submitted', 'approved', 'in_progress', 'completed', 'cancelled']);

  const groupedOrders = groupRecordsByKanbanStage([
    { id: 1, code: 'ORD-1', name: 'Đơn 1', status: 'draft' },
    { id: 2, code: 'ORD-2', name: 'Đơn 2', status: 'submitted' },
    { id: 3, code: 'ORD-3', name: 'Đơn 3', status: 'weird_unknown' },
  ], 'latticeOrders');
  assert.equal(groupedOrders.columns.length, 6);
  assert.equal(groupedOrders.byStage.draft.length, 2);
  assert.equal(groupedOrders.byStage.submitted.length, 1);

  const groupedLots = groupRecordsByKanbanStage([
    { id: 10, lotCode: 'LOT-A', status: 'available', qtyOnHand: 50, qtyReserved: 0 },
    { id: 11, lotCode: 'LOT-B', status: 'available', qtyOnHand: 50, qtyReserved: 20 },
    { id: 12, lotCode: 'LOT-C', status: 'hold_mkt', qtyOnHand: 30, qtyReserved: 0 },
    { id: 13, lotCode: 'LOT-D', status: 'expired', qtyOnHand: 10, qtyReserved: 0 },
  ], 'latticeStockLots');
  assert.deepEqual(groupedLots.stages, ['available', 'reserved', 'hold_mkt', 'expired']);
  assert.equal(groupedLots.byStage.available.length, 1);
  assert.equal(groupedLots.byStage.reserved.length, 1);
  assert.equal(groupedLots.byStage.hold_mkt.length, 1);
  assert.equal(groupedLots.byStage.expired.length, 1);

  const grid = buildScheduleDaysGrid([
    { id: 1, code: 'ORD-MON', submittedAt: '2026-11-23T08:30:00Z' },
    { id: 2, code: 'ORD-WED', expiryDate: '2026-11-25T00:00:00Z' },
    { id: 3, code: 'ORD-NEXT', createdAt: '2026-12-02T09:00:00Z' },
  ], '2026-11-25');
  assert.equal(grid.days.length, 7);
  assert.equal(grid.days[0].dateKey, '2026-11-23');
  assert.equal(grid.days[6].dateKey, '2026-11-29');
  assert.equal(grid.days[0].items.length, 1);
  assert.equal(grid.days[2].items.length, 1);
  assert.equal(grid.days[2].items[0].code, 'ORD-WED');
});

test('DxosKanbanScheduleBlockView switches between kanban & schedule modes, filters by search, and submits draft vouchers', async () => {
  const { createKanbanScheduleBlockView } = require(path.join(PLUGIN_ROOT, 'src/client/kanban-schedule-block.js'));
  const { React, render } = createMiniHooks();

  const requests = [];
  const api = {
    async request(req) {
      requests.push(req);
      if (req.url === 'latticeOrders:list') {
        return {
          data: {
            data: [
              { id: 5, code: 'ORD-05', name: 'Giao Vaccine Cần Thơ', status: 'draft', version: 1, slaStatus: 'warning', createdAt: new Date().toISOString() },
              { id: 6, code: 'ORD-06', name: 'Giao Thiết bị Y tế', status: 'submitted', version: 2, slaStatus: 'breached', submittedAt: new Date().toISOString() },
            ],
          },
        };
      }
      if (req.url === 'latticeVoucher:submit') {
        return { data: { data: { id: 5, status: 'submitted' } } };
      }
      return { data: { data: [] } };
    },
  };

  const View = createKanbanScheduleBlockView({ useAPIClient: () => api }, React, {}, {});
  let tree = render(View, { model: { props: { collection: 'latticeOrders', viewMode: 'kanban' } } });
  await new Promise((r) => setTimeout(r, 20));
  tree = render(View, { model: { props: { collection: 'latticeOrders', viewMode: 'kanban' } } });

  assert.ok(findByTestId(tree, 'dxos-kanban-schedule-block'));
  const cols = collectNodes(tree).filter((n) => n.props?.['data-testid'] === 'dxos-kanban-column');
  assert.equal(cols.length, 6);
  const dump = textOf(tree);
  assert.ok(dump.includes('ORD-05') && dump.includes('ORD-06'));

  // Trigger submit action on draft ORD-05
  const submitBtn = findByTestId(tree, 'dxos-kanban-submit-5');
  assert.ok(submitBtn);
  await submitBtn.props.onClick();
  assert.ok(requests.some((r) => r.url === 'latticeVoucher:submit' && r.data?.id === 5 && r.data?.collection === 'latticeOrders'));

  // Search filter narrows cards
  const searchInput = findByTestId(tree, 'dxos-kanban-search-input');
  searchInput.props.onChange({ target: { value: 'Vaccine' } });
  tree = render(View, { model: { props: { collection: 'latticeOrders', viewMode: 'kanban' } } });
  assert.equal(textOf(tree).includes('ORD-06'), false);
  assert.ok(textOf(tree).includes('ORD-05'));

  // Toggle to Schedule mode and verify week navigation
  findByTestId(tree, 'dxos-view-mode-schedule').props.onClick();
  tree = render(View, { model: { props: { collection: 'latticeOrders', viewMode: 'kanban' } } });
  const schedGrid = findByTestId(tree, 'dxos-schedule-grid');
  assert.ok(schedGrid);
  const initialWeekText = textOf(schedGrid);
  findByTestId(tree, 'dxos-schedule-next-week').props.onClick();
  tree = render(View, { model: { props: { collection: 'latticeOrders', viewMode: 'kanban' } } });
  const nextWeekText = textOf(findByTestId(tree, 'dxos-schedule-grid'));
  assert.notEqual(nextWeekText, initialWeekText);

  // Stock lots fallback to dxosWms:lots when latticeStockLots:list rejects
  const lotHooks = createMiniHooks();
  const lotApi = {
    async request(req) {
      if (req.url === 'latticeStockLots:list') throw new Error('Forbidden');
      if (req.url === 'dxosWms:lots') {
        return { data: { data: { items: [{ id: 21, lotCode: 'LOT-21', productName: 'Vaccine Cold', status: 'hold_mkt', expiryDate: '2026-12-01T00:00:00Z' }] } } };
      }
      return { data: { data: [] } };
    },
  };
  const LotView = createKanbanScheduleBlockView({ useAPIClient: () => lotApi }, lotHooks.React, {}, {});
  let lotTree = lotHooks.render(LotView, { model: { props: { collection: 'latticeStockLots', viewMode: 'kanban' } } });
  await new Promise((r) => setTimeout(r, 20));
  lotTree = lotHooks.render(LotView, { model: { props: { collection: 'latticeStockLots', viewMode: 'kanban' } } });
  assert.equal(collectNodes(lotTree).filter((n) => n.props?.['data-testid'] === 'dxos-kanban-column').length, 4);
  assert.ok(textOf(lotTree).includes('LOT-21'));
});

test('createVoucherLifecycleBar renders Ed25519 PKI badge, Data Lineage drawer, and sandboxed Printable Voucher iframe', async () => {
  const { createVoucherLifecycleBar } = require(path.join(PLUGIN_ROOT, 'src/client/chatter-panel.js'));
  const { React, render } = createMiniHooks();

  const apiCalls = [];
  const api = {
    async request(req) {
      apiCalls.push(req);
      if (req.url === 'latticeVoucher:lineage') {
        return { data: { data: { items: [{ id: 12, code: 'ORD-12', status: 'approved', version: 3, amendmentNo: 0 }] } } };
      }
      if (req.url === 'dxosLedger:entries') {
        return {
          data: {
            data: {
              total: 1,
              items: [
                {
                  seq: 42,
                  keyId: 'ed25519-org-a-v1',
                  entryHash: 'a1b2c3d4e5f678901234567890abcdef',
                  merkleRoot: '99887766554433221100',
                  eventType: 'voucher.approved',
                },
              ],
            },
          },
        };
      }
      if (req.url === 'dxosLedger:verify') {
        return { data: { data: { valid: true, checkedCount: 42 } } };
      }
      if (req.url === 'dxosDataGov:lineageTrace') {
        return {
          data: {
            data: {
              root: { collection: 'latticeOrders', recordId: '12' },
              nodeCount: 2,
              edgeCount: 1,
              nodes: [
                { key: 'latticeRequests:4', collection: 'latticeRequests', recordId: '4', depth: 1 },
                { key: 'latticeOrders:12', collection: 'latticeOrders', recordId: '12', depth: 0 },
              ],
              edges: [
                {
                  edgeUid: 'lin-1',
                  sourceCollection: 'latticeRequests',
                  sourceRecordId: '4',
                  targetCollection: 'latticeOrders',
                  targetRecordId: '12',
                  relationType: 'fulfilled_by',
                },
              ],
            },
          },
        };
      }
      if (req.url === 'dxosWms:printVoucher') {
        return {
          data: {
            data: {
              documentType: 'order',
              html: '<!doctype html><html><body><h1>PHIẾU ĐƠN HÀNG ORD-12</h1></body></html>',
              htmlSha256: 'deadbeef0123456789abcdef',
              qrVerificationHash: 'qrhash999',
              ledgerSeq: 42,
              keyId: 'ed25519-org-a-v1',
            },
          },
        };
      }
      return { data: {} };
    },
  };

  const Bar = createVoucherLifecycleBar({ useAPIClient: () => api }, React, {});
  let tree = render(Bar, { targetCollection: 'latticeOrders', targetRecordId: 12 });
  await new Promise((r) => setTimeout(r, 20));
  tree = render(Bar, { targetCollection: 'latticeOrders', targetRecordId: 12 });

  // 1. PKI Badge & Verify button
  const pkiBadge = findByTestId(tree, 'dxos-workbench-pki-badge');
  assert.ok(pkiBadge);
  assert.ok(textOf(pkiBadge).includes('42'));
  assert.ok(textOf(pkiBadge).includes('ed25519-org-a-v1'));
  assert.ok(textOf(pkiBadge).includes('a1b2c3d4e5f6'));

  await findByTestId(tree, 'dxos-workbench-pki-verify-btn').props.onClick();
  tree = render(Bar, { targetCollection: 'latticeOrders', targetRecordId: 12 });
  assert.ok(apiCalls.some((c) => c.url === 'dxosLedger:verify'));
  assert.ok(textOf(findByTestId(tree, 'dxos-workbench-pki-badge')).includes('42'));

  // 2. Data Lineage drawer
  const lineagePanel = findByTestId(tree, 'dxos-workbench-lineage-panel');
  assert.ok(lineagePanel);
  await findByTestId(tree, 'dxos-workbench-lineage-btn').props.onClick();
  tree = render(Bar, { targetCollection: 'latticeOrders', targetRecordId: 12 });
  assert.ok(apiCalls.some((c) => c.url === 'dxosDataGov:lineageTrace' && c.params?.collection === 'latticeOrders' && String(c.params?.recordId) === '12'));
  assert.ok(textOf(findByTestId(tree, 'dxos-workbench-lineage-panel')).includes('fulfilled_by'));
  assert.ok(textOf(findByTestId(tree, 'dxos-workbench-lineage-panel')).includes('latticeRequests#4'));

  // 3. Printable Voucher button -> sandbox="" iframe (never allow-scripts!)
  const printBtn = findByTestId(tree, 'dxos-workbench-print-voucher-btn');
  assert.ok(printBtn);
  await printBtn.props.onClick();
  tree = render(Bar, { targetCollection: 'latticeOrders', targetRecordId: 12 });
  assert.ok(apiCalls.some((c) => c.url === 'dxosWms:printVoucher' && Number(c.params?.orderId) === 12));
  const iframe = collectNodes(tree).find((n) => n.type === 'iframe');
  assert.ok(iframe, 'Printable voucher preview must render an iframe');
  assert.equal(iframe.props.sandbox, '');
  assert.ok(String(iframe.props.srcDoc || '').includes('ORD-12'));
  assert.ok(textOf(tree).includes('deadbeef0123'));

  // 4. Fail-closed error note when printVoucher fails (e.g. 403 unauthorized)
  const denyApi = {
    async request(req) {
      if (req.url === 'dxosWms:printVoucher') {
        const err = new Error('Forbidden');
        err.response = { status: 403, data: { errors: [{ message: 'Không có quyền in chứng từ.' }] } };
        throw err;
      }
      return { data: { data: {} } };
    },
  };
  const hooks2 = createMiniHooks();
  const DenyBar = createVoucherLifecycleBar({ useAPIClient: () => denyApi }, hooks2.React, {});
  let denyTree = hooks2.render(DenyBar, { targetCollection: 'latticeOrders', targetRecordId: 12 });
  await findByTestId(denyTree, 'dxos-workbench-print-voucher-btn').props.onClick();
  denyTree = hooks2.render(DenyBar, { targetCollection: 'latticeOrders', targetRecordId: 12 });
  assert.equal(collectNodes(denyTree).some((n) => n.type === 'iframe'), false);
  assert.ok(textOf(denyTree).includes('Không có quyền in chứng từ.'));

  // 5. Switch targetRecordId resets print modal/lineage/PKI state and ignores late out-of-order print response
  let resolveSlowPrint;
  const raceApi = {
    async request(req) {
      if (req.url === 'dxosWms:printVoucher' && Number(req.params?.orderId) === 12) {
        return new Promise((resolve) => { resolveSlowPrint = resolve; });
      }
      if (req.url === 'dxosLedger:verify') {
        return { data: { data: { valid: false, checkedCount: 10, brokenAtSeq: 7 } } };
      }
      return { data: { data: {} } };
    },
  };
  const raceHooks = createMiniHooks();
  const RaceBar = createVoucherLifecycleBar({ useAPIClient: () => raceApi }, raceHooks.React, {});
  let rTree = raceHooks.render(RaceBar, { targetCollection: 'latticeOrders', targetRecordId: 12 });
  const slowPrintPromise = findByTestId(rTree, 'dxos-workbench-print-voucher-btn').props.onClick();
  rTree = raceHooks.render(RaceBar, { targetCollection: 'latticeOrders', targetRecordId: 99 });
  assert.equal(findByTestId(rTree, 'dxos-workbench-print-modal'), null);
  resolveSlowPrint({ data: { data: { html: '<p>STALE-12</p>', htmlSha256: 'stale12' } } });
  await slowPrintPromise;
  rTree = raceHooks.render(RaceBar, { targetCollection: 'latticeOrders', targetRecordId: 99 });
  assert.equal(findByTestId(rTree, 'dxos-workbench-print-modal'), null);

  await findByTestId(rTree, 'dxos-workbench-pki-verify-btn').props.onClick();
  rTree = raceHooks.render(RaceBar, { targetCollection: 'latticeOrders', targetRecordId: 99 });
  assert.ok(textOf(findByTestId(rTree, 'dxos-workbench-pki-badge')).includes('#7'));
});

test('registerDxosBlockModels registers DxosWebGisBlockModel & DxosKanbanScheduleBlockModel and forwards optional Workbench flags', () => {
  const { registerDxosBlockModels } = require(path.join(PLUGIN_ROOT, 'src/client/block-models.js'));
  const { React } = createMiniHooks();

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

  const registered = {};
  const models = registerDxosBlockModels(
    { useAPIClient: () => null, useUIConfigurationPermissions: () => ({ allowAll: false }) },
    React,
    {},
    { BlockModel: MockBlockModel },
    { registerModels(m) { Object.assign(registered, m); } },
    {},
  );

  assert.ok(models.DxosWebGisBlockModel && registered.DxosWebGisBlockModel);
  assert.equal(models.DxosWebGisBlockModel.meta.label, 'DX-OS Bản đồ Giám sát WebGIS [D]');
  const webgisUi = models.DxosWebGisBlockModel.flows.find((f) => f.key === 'dxosBlockSettings').steps.config.uiSchema;
  for (const field of ['title', 'defaultOrganizationId', 'centerLat', 'centerLng', 'showTwinOverlay']) {
    assert.ok(webgisUi[field], `DxosWebGisBlockModel uiSchema missing ${field}`);
  }

  assert.ok(models.DxosKanbanScheduleBlockModel && registered.DxosKanbanScheduleBlockModel);
  assert.equal(models.DxosKanbanScheduleBlockModel.meta.label, 'DX-OS Bảng Kanban & Lịch [H]');
  const kanbanUi = models.DxosKanbanScheduleBlockModel.flows.find((f) => f.key === 'dxosBlockSettings').steps.config.uiSchema;
  for (const field of ['title', 'collection', 'viewMode', 'pageSize']) {
    assert.ok(kanbanUi[field], `DxosKanbanScheduleBlockModel uiSchema missing ${field}`);
  }

  // Render both new BlockModels cleanly
  const webgisTree = resolveTree(new models.DxosWebGisBlockModel({ props: { title: 'Bản đồ Kho lạnh' } }).renderComponent());
  assert.ok(findByTestId(webgisTree, 'dxos-webgis-block'));

  const kanbanTree = resolveTree(new models.DxosKanbanScheduleBlockModel({ props: { collection: 'latticeOrders', viewMode: 'kanban' } }).renderComponent());
  assert.ok(findByTestId(kanbanTree, 'dxos-kanban-schedule-block'));

  // DxosRecordWorkbenchBlockModel forwards showPkiBadge / showLineage / showPrintVoucher defaulting true
  const wbDefault = resolveTree(new models.DxosRecordWorkbenchBlockModel({
    props: { collection: 'latticeOrders', recordId: '12' },
  }).renderComponent());
  assert.ok(findByTestId(wbDefault, 'dxos-workbench-pki-badge'));
  assert.ok(findByTestId(wbDefault, 'dxos-workbench-lineage-panel'));
  assert.ok(findByTestId(wbDefault, 'dxos-workbench-print-voucher-btn'));

  const wbHidden = resolveTree(new models.DxosRecordWorkbenchBlockModel({
    props: {
      collection: 'latticeOrders',
      recordId: '12',
      showPkiBadge: false,
      showLineage: false,
      showPrintVoucher: false,
    },
  }).renderComponent());
  assert.equal(findByTestId(wbHidden, 'dxos-workbench-pki-badge'), null);
  assert.equal(findByTestId(wbHidden, 'dxos-workbench-lineage-panel'), null);
  assert.equal(findByTestId(wbHidden, 'dxos-workbench-print-voucher-btn'), null);
});

test('Task 3.1 client submodules obey build.mjs bundler rule, XSS safety, and SPDX headers', async () => {
  const { addSourceHeader } = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/source-headers.mjs')).href);

  const clientModules = [
    'src/client/webgis-block.js',
    'src/client/kanban-schedule-block.js',
    'src/client/chatter-panel.js',
    'src/client/block-models.js',
  ];
  for (const rel of clientModules) {
    const abs = path.join(PLUGIN_ROOT, rel);
    const src = readFileSync(abs, 'utf8');
    const reqMatches = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)];
    for (const m of reqMatches) {
      assert.ok(m[1].startsWith('.'), `${rel} contains forbidden non-relative require: ${m[1]}`);
    }
    assert.equal(src.includes('dangerouslySetInnerHTML'), false, `${rel} must never use dangerouslySetInnerHTML`);
    assert.equal(src.includes('allow-scripts'), false, `${rel} must never enable allow-scripts in sandboxed iframe`);
    assert.equal(addSourceHeader(src, rel).status, 'present', `${rel} missing valid SPDX header`);
  }
  const testAbs = path.join(PLUGIN_ROOT, 'tests/ui-v100-blocks.test.cjs');
  assert.equal(addSourceHeader(readFileSync(testAbs, 'utf8'), 'tests/ui-v100-blocks.test.cjs').status, 'present');
});

test('DxosKanbanScheduleBlockView ignores slow stale collection/unmounted responses on rapid collection switches', async () => {
  const { createKanbanScheduleBlockView } = require(path.join(PLUGIN_ROOT, 'src/client/kanban-schedule-block.js'));
  const { React, render, unmount } = createMiniHooks();

  let resolveOrders;
  let rejectOrders;
  let ordersMode = 'resolve';
  const api = {
    async request(req) {
      if (req.url === 'latticeOrders:list') {
        return new Promise((resolve, reject) => {
          resolveOrders = resolve;
          rejectOrders = reject;
        });
      }
      if (req.url === 'latticeStockLots:list') {
        return {
          data: {
            data: [{ id: 301, lotCode: 'LOT-FAST-301', productName: 'Insulin Lạnh', status: 'available' }],
          },
        };
      }
      if (req.url === 'latticeRequests:list') {
        return {
          data: {
            data: [{ id: 401, code: 'REQ-401', name: 'Yêu cầu mới', status: 'draft' }],
          },
        };
      }
      return { data: { data: [] } };
    },
  };

  const View = createKanbanScheduleBlockView({ useAPIClient: () => api }, React, {}, {});
  let tree = render(View, { model: { props: { collection: 'latticeOrders', viewMode: 'kanban' } } });

  // Rapidly switch collection while latticeOrders:list is still pending
  const select = collectNodes(tree).find((n) => n.type === 'select');
  assert.ok(select);
  select.props.onChange({ target: { value: 'latticeStockLots' } });
  tree = render(View, { model: { props: { collection: 'latticeOrders', viewMode: 'kanban' } } });
  await new Promise((r) => setTimeout(r, 15));
  tree = render(View, { model: { props: { collection: 'latticeOrders', viewMode: 'kanban' } } });
  assert.ok(textOf(tree).includes('LOT-FAST-301'));

  // Now the slow stale latticeOrders response arrives -> must NOT clobber LOT-FAST-301
  assert.equal(typeof resolveOrders, 'function');
  if (ordersMode === 'resolve') {
    resolveOrders({
      data: {
        data: [{ id: 999, code: 'ORD-STALE-999', name: 'Stale order', status: 'draft' }],
      },
    });
  }
  await new Promise((r) => setTimeout(r, 15));
  tree = render(View, { model: { props: { collection: 'latticeOrders', viewMode: 'kanban' } } });
  assert.ok(textOf(tree).includes('LOT-FAST-301'));
  assert.equal(textOf(tree).includes('ORD-STALE-999'), false);

  // Switch back to latticeOrders (slow) then switch to latticeRequests, then reject stale latticeOrders
  collectNodes(tree).find((n) => n.type === 'select').props.onChange({ target: { value: 'latticeOrders' } });
  tree = render(View, { model: { props: { collection: 'latticeOrders', viewMode: 'kanban' } } });
  assert.equal(textOf(tree).includes('LOT-FAST-301'), false, 'Switching collections must clear previous collection cards immediately');

  collectNodes(tree).find((n) => n.type === 'select').props.onChange({ target: { value: 'latticeRequests' } });
  tree = render(View, { model: { props: { collection: 'latticeOrders', viewMode: 'kanban' } } });
  await new Promise((r) => setTimeout(r, 15));
  tree = render(View, { model: { props: { collection: 'latticeOrders', viewMode: 'kanban' } } });
  assert.ok(textOf(tree).includes('REQ-401'));

  rejectOrders(new Error('Late network error'));
  await new Promise((r) => setTimeout(r, 15));
  tree = render(View, { model: { props: { collection: 'latticeOrders', viewMode: 'kanban' } } });
  assert.ok(textOf(tree).includes('REQ-401'));
  assert.equal(textOf(tree).includes('Không tải được dữ liệu'), false);

  // Unmount cancels in-flight fetch
  const hooks2 = createMiniHooks();
  let resolveAfterUnmount;
  let stateUpdatesAfterUnmount = 0;
  const origUseState = hooks2.React.useState;
  let trackAfterUnmount = false;
  hooks2.React.useState = (init) => {
    const [val, setVal] = origUseState(init);
    return [val, (u) => {
      if (trackAfterUnmount) stateUpdatesAfterUnmount += 1;
      return setVal(u);
    }];
  };
  const UnmountView = createKanbanScheduleBlockView({
    useAPIClient: () => ({
      request: () => new Promise((resolve) => { resolveAfterUnmount = resolve; }),
    }),
  }, hooks2.React, {}, {});
  hooks2.render(UnmountView, { model: { props: { collection: 'latticeOrders' } } });
  trackAfterUnmount = true;
  hooks2.unmount();
  resolveAfterUnmount({ data: { data: [{ id: 1, code: 'ORD-GHOST', status: 'draft' }] } });
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(stateUpdatesAfterUnmount, 0, 'Unmounted kanban view must ignore late API resolutions');
  unmount();
});

test('DxosWebGisBlockView passes organizationId inside params.filter, guards stale/unmounted loads, and separates stacked city pins', async () => {
  const {
    createWebGisBlockView,
    inferCoordsForRecord,
    projectGeoPoint,
  } = require(path.join(PLUGIN_ROOT, 'src/client/webgis-block.js'));

  // Minor 3: indices 0..3 matching same city get distinct angular coordinates & projected SVG points
  const stackedCoords = [0, 1, 2, 3].map((idx) => inferCoordsForRecord({ code: `CT-${idx}`, name: 'Kho lạnh Cần Thơ' }, new Map(), idx));
  const latLngKeys = new Set(stackedCoords.map((c) => `${c.lat},${c.lng}`));
  assert.equal(latLngKeys.size, 4, 'Indices 0..3 at same city must have 4 distinct lat/lng coordinates');
  const svgKeys = new Set(stackedCoords.map((c) => {
    const pt = projectGeoPoint(c.lat, c.lng);
    return `${pt.x},${pt.y}`;
  }));
  assert.equal(svgKeys.size, 4, 'Indices 0..3 at same city must have 4 distinct SVG coordinates');

  // Minor 1 & Important 1: params.filter.organizationId on :list, organizationId on twinShadow, and stale org guard
  const { React, render, unmount } = createMiniHooks();
  const seenCalls = [];
  let resolveOrgOldAssets;
  const api = {
    async request(req) {
      seenCalls.push(req);
      if (req.url === 'latticeAssets:list') {
        if (req.params?.filter?.organizationId === 'org-old') {
          return new Promise((resolve) => { resolveOrgOldAssets = resolve; });
        }
        return {
          data: {
            data: [{ id: 50, code: 'AST-NEW-50', name: 'Kho Hà Nội New', kind: 'cold_room', status: 'active' }],
          },
        };
      }
      if (req.url === 'latticeLocations:list') {
        return { data: { data: [] } };
      }
      if (req.url === 'latticeIncidentCases:list') {
        return { data: { data: [] } };
      }
      if (req.url === 'dxosBlocks:twinShadow') {
        return {
          data: {
            data: {
              shadow: { assetId: 50, commandStatus: 'synced', desiredJson: { targetTempC: -18 }, reportedJson: { targetTempC: -18 } },
            },
          },
        };
      }
      return { data: { data: [] } };
    },
  };

  const View = createWebGisBlockView({ useAPIClient: () => api }, React, {}, {});
  render(View, { model: { props: { defaultOrganizationId: 'org-old', showTwinOverlay: true } } });

  // Verify org-old used params.filter.organizationId (and NOT top-level params.organizationId)
  const oldAssetCall = seenCalls.find((c) => c.url === 'latticeAssets:list');
  assert.equal(oldAssetCall.params.organizationId, undefined);
  assert.deepEqual(oldAssetCall.params.filter, { organizationId: 'org-old' });
  const oldIncidentCall = seenCalls.find((c) => c.url === 'latticeIncidentCases:list');
  assert.equal(oldIncidentCall.params.organizationId, undefined);
  assert.deepEqual(oldIncidentCall.params.filter, { organizationId: 'org-old', status: { $ne: 'closed' } });

  // Switch organization rapidly to org-new
  let tree = render(View, { model: { props: { defaultOrganizationId: 'org-new', showTwinOverlay: true } } });
  await new Promise((r) => setTimeout(r, 15));
  tree = render(View, { model: { props: { defaultOrganizationId: 'org-new', showTwinOverlay: true } } });
  assert.ok(textOf(tree).includes('AST-NEW-50'));
  const twinCall = seenCalls.find((c) => c.url === 'dxosBlocks:twinShadow');
  assert.equal(twinCall.data.organizationId, 'org-new');

  // Resolve slow org-old assets late -> must NOT overwrite AST-NEW-50
  resolveOrgOldAssets({
    data: { data: [{ id: 9, code: 'AST-OLD-STALE', name: 'Kho Cũ', kind: 'cold_room', status: 'active' }] },
  });
  await new Promise((r) => setTimeout(r, 15));
  tree = render(View, { model: { props: { defaultOrganizationId: 'org-new', showTwinOverlay: true } } });
  assert.ok(textOf(tree).includes('AST-NEW-50'));
  assert.equal(textOf(tree).includes('AST-OLD-STALE'), false);
  unmount();
});

test('createVoucherLifecycleBar enforces canPrintOrder strictly, protects PKI verify spinner against loadPkiEntries, and falls back on sandbox SecurityError', async () => {
  const { createVoucherLifecycleBar } = require(path.join(PLUGIN_ROOT, 'src/client/chatter-panel.js'));

  // 1. canPrintOrder strictly requires targetCollection === 'latticeOrders' even when printDocumentType === 'delivery_note'
  const hooksReq = createMiniHooks();
  const ReqBar = createVoucherLifecycleBar({ useAPIClient: () => null }, hooksReq.React, {});
  const reqTree = hooksReq.render(ReqBar, {
    targetCollection: 'latticeRequests',
    targetRecordId: 12,
    printDocumentType: 'delivery_note',
  });
  assert.equal(findByTestId(reqTree, 'dxos-workbench-print-voucher-btn'), null);

  const hooksOrd = createMiniHooks();
  const OrdBar = createVoucherLifecycleBar({ useAPIClient: () => null }, hooksOrd.React, {});
  const ordTree = hooksOrd.render(OrdBar, {
    targetCollection: 'latticeOrders',
    targetRecordId: 12,
    printDocumentType: 'delivery_note',
  });
  assert.ok(findByTestId(ordTree, 'dxos-workbench-print-voucher-btn'));

  // 2. loadPkiEntries settling while handleVerifyPki is in flight must NOT clear handleVerifyPki's spinner
  let resolveEntries;
  let resolveVerify;
  const pkiApi = {
    async request(req) {
      if (req.url === 'latticeVoucher:lineage') {
        return { data: { data: { items: [{ id: 12, code: 'ORD-12', status: 'approved', version: 1 }] } } };
      }
      if (req.url === 'dxosLedger:entries') {
        return new Promise((resolve) => { resolveEntries = resolve; });
      }
      if (req.url === 'dxosLedger:verify') {
        return new Promise((resolve) => { resolveVerify = resolve; });
      }
      if (req.url === 'dxosWms:printVoucher') {
        return {
          data: {
            data: {
              documentType: 'order',
              html: '<!doctype html><html><body>OK</body></html>',
              htmlSha256: 'abc123',
            },
          },
        };
      }
      return { data: { data: {} } };
    },
  };

  const pkiHooks = createMiniHooks();
  const PkiBar = createVoucherLifecycleBar({ useAPIClient: () => pkiApi }, pkiHooks.React, {});
  let pkiTree = pkiHooks.render(PkiBar, { targetCollection: 'latticeOrders', targetRecordId: 12 });

  // Start handleVerifyPki while dxosLedger:entries is still pending
  const verifyPromise = findByTestId(pkiTree, 'dxos-workbench-pki-verify-btn').props.onClick();
  pkiTree = pkiHooks.render(PkiBar, { targetCollection: 'latticeOrders', targetRecordId: 12 });
  assert.equal(findByTestId(pkiTree, 'dxos-workbench-pki-verify-btn').props.disabled, true);
  assert.ok(textOf(findByTestId(pkiTree, 'dxos-workbench-pki-verify-btn')).includes('Đang kiểm'));

  // Settle loadPkiEntries while dxosLedger:verify is STILL pending -> spinner must stay active!
  resolveEntries({
    data: {
      data: {
        total: 1,
        items: [{ seq: 88, keyId: 'ed25519-live', entryHash: 'facefeed12345678' }],
      },
    },
  });
  await new Promise((r) => setTimeout(r, 15));
  pkiTree = pkiHooks.render(PkiBar, { targetCollection: 'latticeOrders', targetRecordId: 12 });
  assert.equal(findByTestId(pkiTree, 'dxos-workbench-pki-verify-btn').props.disabled, true, 'loadPkiEntries must not clear verify spinner');
  assert.ok(textOf(findByTestId(pkiTree, 'dxos-workbench-pki-badge')).includes('88'));

  // Settle handleVerifyPki -> spinner clears and result appears
  resolveVerify({ data: { data: { valid: true, checkedCount: 88 } } });
  await verifyPromise;
  pkiTree = pkiHooks.render(PkiBar, { targetCollection: 'latticeOrders', targetRecordId: 12 });
  assert.equal(findByTestId(pkiTree, 'dxos-workbench-pki-verify-btn').props.disabled, false);
  assert.ok(textOf(findByTestId(pkiTree, 'dxos-workbench-pki-badge')).includes('Hợp lệ (88 mục)'));
  assert.ok(textOf(findByTestId(pkiTree, 'dxos-workbench-pki-badge')).includes('88'));

  // 3. triggerBrowserPrint falls back to window.print() when sandboxed iframe throws SecurityError
  await findByTestId(pkiTree, 'dxos-workbench-print-voucher-btn').props.onClick();
  pkiTree = pkiHooks.render(PkiBar, { targetCollection: 'latticeOrders', targetRecordId: 12 });
  const browserPrintBtn = findByTestId(pkiTree, 'dxos-workbench-print-browser-btn');
  assert.ok(browserPrintBtn);

  const origDoc = global.document;
  const origWin = global.window;
  let windowPrintCount = 0;
  try {
    global.document = {
      querySelector: () => ({
        contentWindow: {
          print() {
            throw Object.assign(new Error('Blocked a frame with origin "null"'), { name: 'SecurityError' });
          },
        },
      }),
    };
    global.window = {
      print() {
        windowPrintCount += 1;
      },
    };
    browserPrintBtn.props.onClick();
    assert.equal(windowPrintCount, 1, 'Sandboxed iframe SecurityError must fall back to window.print()');
  } finally {
    global.document = origDoc;
    global.window = origWin;
  }
  pkiHooks.unmount();
});
