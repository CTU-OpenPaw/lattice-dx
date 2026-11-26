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
              { id: 12, code: 'COLD-CT-01', name: 'Kho lạnh Cần Thơ 01', kind: 'cold_room', status: 'active', locationId: 1, organizationId: 'org-a' },
              { id: 15, code: 'COLD-HN-02', name: 'Kho lạnh Hà Nội 02', kind: 'cold_room', status: 'active', locationId: 2, organizationId: 'org-a' },
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
  assert.ok(calls.some((c) => c.url === 'dxosBlocks:twinShadow' && c.skipNotify === true && c.data?.organizationId === 'org-a'));

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
  assert.ok(textOf(tree).includes('Đã đồng bộ'));
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

  // Block model hero default subtitle reflects NocoBase 2.2.50
  const blockModelsSrc = readFileSync(path.join(PLUGIN_ROOT, 'src/client/block-models.js'), 'utf8');
  assert.equal(blockModelsSrc.includes('Nền mở NocoBase 2.2.50 cho H–P–D–I'), true);
  assert.equal(blockModelsSrc.includes('2.2.38'), false);

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
    'src/client/blocks-helpers.js',
    'src/client/webgis-block.js',
    'src/client/kanban-schedule-block.js',
    'src/client/chatter-panel.js',
    'src/client/bi-chart-block.js',
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

test('UI background 400/403 fixes: webgis-block passes/skips organizationId on twinShadow and chatter-panel passes organizationId on dxosLedger:entries', async () => {
  const { createWebGisBlockView } = require(path.join(PLUGIN_ROOT, 'src/client/webgis-block.js'));
  const { createVoucherLifecycleBar } = require(path.join(PLUGIN_ROOT, 'src/client/chatter-panel.js'));

  // 1. webgis-block skips dxosBlocks:twinShadow when neither defaultOrganizationId nor asset.organizationId exists
  const skipHooks = createMiniHooks();
  const skipCalls = [];
  const skipApi = {
    async request(req) {
      skipCalls.push(req);
      if (req.url === 'latticeAssets:list') {
        return {
          data: {
            data: [
              { id: 101, code: 'NO-ORG', name: 'Asset Missing Org', kind: 'cold_room', status: 'active' },
              { id: 102, code: 'WITH-ORG', name: 'Asset With Org', kind: 'cold_room', status: 'active', organizationId: 'org-asset' },
            ],
          },
        };
      }
      if (req.url === 'dxosBlocks:twinShadow') {
        return { data: { data: { shadow: { assetId: req.data?.assetId, commandStatus: 'synced', desiredJson: {}, reportedJson: {} } } } };
      }
      return { data: { data: [] } };
    },
  };
  const WebGisView = createWebGisBlockView({ useAPIClient: () => skipApi }, skipHooks.React, {}, {});
  skipHooks.render(WebGisView, { model: { props: { showTwinOverlay: true } } });
  await new Promise((r) => setTimeout(r, 20));
  const twinCalls = skipCalls.filter((c) => c.url === 'dxosBlocks:twinShadow');
  assert.equal(twinCalls.length, 1, 'Must skip twinShadow for asset without organizationId');
  assert.equal(twinCalls[0].data.assetId, 102);
  assert.equal(twinCalls[0].data.organizationId, 'org-asset');
  skipHooks.unmount();

  // 2. chatter-panel VoucherLifecycleBar passes organizationId on dxosLedger:entries & dxosLedger:verify from props/record/context
  const pkiHooks = createMiniHooks();
  const pkiCalls = [];
  const pkiApi = {
    async request(req) {
      pkiCalls.push(req);
      if (req.url === 'latticeVoucher:lineage') {
        return { data: { data: { items: [{ id: 55, code: 'ORD-55', status: 'approved', organizationId: 'org-ctx' }] } } };
      }
      if (req.url === 'dxosLedger:entries') {
        return { data: { data: { total: 1, items: [{ seq: 9, keyId: 'ed25519-k9', entryHash: 'abcdef123456' }] } } };
      }
      if (req.url === 'dxosLedger:verify') {
        return { data: { data: { valid: true, checkedCount: 9 } } };
      }
      return { data: { data: {} } };
    },
  };
  const Bar = createVoucherLifecycleBar(
    { useAPIClient: () => pkiApi, useRecord: () => ({ id: 55, organizationId: 'org-ctx' }) },
    pkiHooks.React,
    {},
  );
  let barTree = pkiHooks.render(Bar, { targetCollection: 'latticeOrders', targetRecordId: 55 });
  await new Promise((r) => setTimeout(r, 20));
  barTree = pkiHooks.render(Bar, { targetCollection: 'latticeOrders', targetRecordId: 55 });
  const entriesCall = pkiCalls.find((c) => c.url === 'dxosLedger:entries');
  assert.ok(entriesCall);
  assert.equal(entriesCall.params.organizationId, 'org-ctx');
  assert.equal(entriesCall.params.targetCollection, 'latticeOrders');
  assert.equal(entriesCall.params.targetRecordId, '55');

  await findByTestId(barTree, 'dxos-workbench-pki-verify-btn').props.onClick();
  const verifyCall = pkiCalls.find((c) => c.url === 'dxosLedger:verify');
  assert.ok(verifyCall);
  assert.equal(verifyCall.params.organizationId, 'org-ctx');
  pkiHooks.unmount();
});

test('Task 13: webgis-block builds GeoJSON FeatureCollections (points + cold-chain corridors) and offline WGS84 vector style', () => {
  const {
    buildMarkersGeoJson,
    buildCorridorsGeoJson,
    buildOfflineWgs84VectorStyle,
    DEFAULT_VIETNAM_GEO_MARKERS,
  } = require(path.join(PLUGIN_ROOT, 'src/client/webgis-block.js'));

  assert.equal(typeof buildMarkersGeoJson, 'function');
  assert.equal(typeof buildCorridorsGeoJson, 'function');
  assert.equal(typeof buildOfflineWgs84VectorStyle, 'function');

  const markersGeo = buildMarkersGeoJson([
    ...DEFAULT_VIETNAM_GEO_MARKERS,
    { id: 'bad-1', code: 'BAD', name: 'Invalid', lat: 999, lng: 106 },
  ]);
  assert.equal(markersGeo.type, 'FeatureCollection');
  assert.equal(markersGeo.features.length, DEFAULT_VIETNAM_GEO_MARKERS.length);
  assert.equal(markersGeo.features[0].geometry.type, 'Point');
  assert.deepEqual(markersGeo.features[0].geometry.coordinates, [DEFAULT_VIETNAM_GEO_MARKERS[0].lng, DEFAULT_VIETNAM_GEO_MARKERS[0].lat]);
  assert.equal(markersGeo.features[0].properties.code, 'HUB-CT');

  const corridorsGeo = buildCorridorsGeoJson(DEFAULT_VIETNAM_GEO_MARKERS);
  assert.equal(corridorsGeo.type, 'FeatureCollection');
  assert.ok(corridorsGeo.features.length >= 1);
  assert.equal(corridorsGeo.features[0].geometry.type, 'LineString');
  assert.ok(corridorsGeo.features[0].geometry.coordinates.length >= 4);

  const offlineStyle = buildOfflineWgs84VectorStyle();
  assert.equal(offlineStyle.version, 8);
  assert.ok(offlineStyle.sources && offlineStyle.layers && offlineStyle.layers.length >= 2);
  const serializedStyle = JSON.stringify(offlineStyle);
  assert.equal(/https?:\/\//i.test(serializedStyle), false, 'Offline WGS84 vector style must contain zero external http(s) URLs');
});

test('Task 13: DxosWebGisBlockView loads >6 assets without 6-asset cap, wires MapLibre cluster:true + offline fallback, and Desktop Twin Drawer calls twinSetDesired with HITL feedback', async () => {
  const { createWebGisBlockView } = require(path.join(PLUGIN_ROOT, 'src/client/webgis-block.js'));
  const { React, render, unmount } = createMiniHooks();

  const tenAssets = Array.from({ length: 10 }, (_, idx) => ({
    id: 201 + idx,
    code: `COLD-${idx + 1}`,
    name: `Kho lạnh ${idx + 1}`,
    kind: 'cold_room',
    status: 'active',
    lat: 10.0 + idx * 0.8,
    lng: 105.7 + (idx % 3) * 0.5,
    temperatureC: -18.0,
    targetTempC: -18.0,
    organizationId: 'org-many',
  }));

  const calls = [];
  const api = {
    async request(req) {
      calls.push(req);
      if (req.url === 'latticeAssets:list') {
        return { data: { data: tenAssets } };
      }
      if (req.url === 'latticeLocations:list') {
        return { data: { data: [] } };
      }
      if (req.url === 'latticeIncidentCases:list') {
        return { data: { data: [] } };
      }
      if (req.url === 'dxosBlocks:twinShadow') {
        const assetId = Number(req.data?.assetId);
        return {
          data: {
            data: {
              shadow: {
                assetId,
                commandStatus: 'synced',
                desiredJson: { targetTempC: -18.0, defrostMode: 'auto', fanMode: 'auto', doorLock: 'locked' },
                reportedJson: { targetTempC: -18.0 },
              },
            },
          },
        };
      }
      if (req.url === 'dxosBlocks:twinSetDesired') {
        const target = Number(req.data?.desiredPatch?.targetTempC);
        const delta = Number((target - (-18.0)).toFixed(2));
        if (Math.abs(delta) > 2.0) {
          return {
            data: {
              data: {
                gatedByHitl: true,
                deltaTempC: delta,
                approvalId: 777,
                shadow: {
                  assetId: Number(req.data?.assetId),
                  commandStatus: 'pending_hitl',
                  desiredJson: { targetTempC: -18.0 },
                  reportedJson: { targetTempC: -18.0 },
                },
              },
            },
          };
        }
        return {
          data: {
            data: {
              gatedByHitl: false,
              commandId: 'cmd-twin-ok-1',
              downlinkDispatched: true,
              shadow: {
                assetId: Number(req.data?.assetId),
                commandStatus: 'dispatched',
                desiredJson: { ...req.data?.desiredPatch },
                reportedJson: { targetTempC: -18.0 },
              },
            },
          },
        };
      }
      return { data: { data: [] } };
    },
  };

  // Mock MapLibre GL JS instance to verify cluster: true, setData(), click selection, and tile error -> offline WGS84 fallback
  const mapSources = new Map();
  const mapLayers = [];
  const mapListeners = new Map();
  const setStyleCalls = [];
  const setDataCalls = [];
  const mockMapInstance = {
    addSource(id, spec) {
      const src = {
        ...spec,
        setData(nextData) {
          src.data = nextData;
          setDataCalls.push({ id, data: nextData });
        },
        getClusterExpansionZoom(_cid, cb) { cb(null, 8); },
      };
      mapSources.set(id, src);
    },
    getSource(id) { return mapSources.get(id) || null; },
    addLayer(layer) { mapLayers.push(layer); },
    getLayer(id) { return mapLayers.find((l) => l.id === id) || null; },
    setStyle(style) {
      setStyleCalls.push(style);
      mapSources.clear();
      mapLayers.length = 0;
      for (const fn of mapListeners.get('style.load') || []) fn({});
    },
    on(eventName, layerOrFn, maybeFn) {
      const key = typeof layerOrFn === 'string' ? `${eventName}:${layerOrFn}` : eventName;
      const handler = typeof layerOrFn === 'string' ? maybeFn : layerOrFn;
      if (!mapListeners.has(key)) mapListeners.set(key, []);
      mapListeners.get(key).push(handler);
    },
    getCanvas() { return { style: {} }; },
    easeTo() {},
    addControl() {},
    resize() {},
    remove() {},
  };
  let mapInitOptions = null;
  const mockMapLibre = {
    Map: class MockMap {
      constructor(opts) {
        mapInitOptions = opts;
        Object.assign(this, mockMapInstance);
      }
    },
    NavigationControl: class MockNavControl {},
    setWorkerUrl() {},
  };

  const View = createWebGisBlockView({ useAPIClient: () => api }, React, {}, {});
  let tree = render(View, {
    model: { props: { title: 'WebGIS > 6 Assets', showTwinOverlay: true } },
    liveConfig: { maplibreOverride: mockMapLibre },
  });
  await new Promise((r) => setTimeout(r, 30));
  tree = render(View, {
    model: { props: { title: 'WebGIS > 6 Assets', showTwinOverlay: true } },
    liveConfig: { maplibreOverride: mockMapLibre },
  });

  // 1. All 10 assets fetched twinShadow (no 6-asset cap!) and all 10 features rendered
  const twinShadowCalls = calls.filter((c) => c.url === 'dxosBlocks:twinShadow');
  assert.equal(twinShadowCalls.length, 10, 'Must fetch twinShadow for all 10 assets without 6-asset truncation');

  // Attach mock DOM container so MapLibre initializes
  const mapHolderNode = findByTestId(tree, 'dxos-webgis-maplibre-canvas');
  assert.ok(mapHolderNode, 'Must render MapLibre container when maplibreOverride is provided');
  if (typeof mapHolderNode.props.ref === 'function') {
    mapHolderNode.props.ref({ nodeType: 1 });
  }
  for (const fn of mapListeners.get('load') || []) fn({});
  tree = render(View, {
    model: { props: { title: 'WebGIS > 6 Assets', showTwinOverlay: true } },
    liveConfig: { maplibreOverride: mockMapLibre },
  });

  assert.ok(mapInitOptions);
  const assetsSource = mapSources.get('dxos-assets');
  assert.ok(assetsSource, 'MapLibre must register dxos-assets GeoJSON source');
  assert.equal(assetsSource.cluster, true, 'MapLibre dxos-assets source must enable native cluster: true');
  assert.equal(assetsSource.data.features.length, 10, 'GeoJSON FeatureCollection must contain all 10 asset features');
  assert.ok(mapSources.get('dxos-corridors'), 'MapLibre must register dxos-corridors LineString source');
  assert.ok(setDataCalls.length >= 1 || assetsSource.data.features.length === 10);

  // 2. Simulate MapLibre tile fetch error -> degrades cleanly to offline WGS84 vector style
  for (const fn of mapListeners.get('error') || []) {
    fn({ error: new Error('Failed to fetch tile'), sourceId: 'osm-raster' });
  }
  tree = render(View, {
    model: { props: { title: 'WebGIS > 6 Assets', showTwinOverlay: true } },
    liveConfig: { maplibreOverride: mockMapLibre },
  });
  assert.ok(setStyleCalls.length >= 1, 'MapLibre tile error must trigger offline WGS84 vector fallback style');
  assert.equal(/https?:\/\//i.test(JSON.stringify(setStyleCalls[0])), false);

  // 3. Simulate marker click on unclustered point -> opens Desktop Digital Twin Control Drawer
  const clickHandlers = mapListeners.get('click:dxos-unclustered-point') || [];
  assert.ok(clickHandlers.length >= 1);
  clickHandlers[0]({ features: [{ properties: { id: 'asset-201' } }] });
  tree = render(View, {
    model: { props: { title: 'WebGIS > 6 Assets', showTwinOverlay: true } },
    liveConfig: { maplibreOverride: mockMapLibre },
  });

  const drawer = findByTestId(tree, 'dxos-webgis-twin-drawer');
  assert.ok(drawer, 'Clicking marker must open Desktop Digital Twin Control Drawer');

  // 4. Small delta (-18 -> -19.0) calls dxosBlocks:twinSetDesired without HITL gate
  const tempInput = findByTestId(tree, 'dxos-twin-target-temp-input');
  tempInput.props.onChange({ target: { value: '-19' } });
  tree = render(View, {
    model: { props: { title: 'WebGIS > 6 Assets', showTwinOverlay: true } },
    liveConfig: { maplibreOverride: mockMapLibre },
  });
  await findByTestId(tree, 'dxos-twin-submit-btn').props.onClick();
  tree = render(View, {
    model: { props: { title: 'WebGIS > 6 Assets', showTwinOverlay: true } },
    liveConfig: { maplibreOverride: mockMapLibre },
  });
  const setDesiredSmall = calls.find((c) => c.url === 'dxosBlocks:twinSetDesired');
  assert.ok(setDesiredSmall);
  assert.equal(setDesiredSmall.data.assetId, 201);
  assert.equal(setDesiredSmall.data.organizationId, 'org-many');
  assert.equal(setDesiredSmall.data.desiredPatch.targetTempC, -19);
  assert.ok(textOf(findByTestId(tree, 'dxos-twin-feedback')).includes('dispatched') || textOf(findByTestId(tree, 'dxos-twin-feedback')).includes('cmd-twin-ok-1'));

  // 5. Large delta (-18 -> -12.0, |delta| > 2.0C) displays HITL warning & pending_hitl approval feedback
  findByTestId(tree, 'dxos-twin-target-temp-input').props.onChange({ target: { value: '-12' } });
  tree = render(View, {
    model: { props: { title: 'WebGIS > 6 Assets', showTwinOverlay: true } },
    liveConfig: { maplibreOverride: mockMapLibre },
  });
  assert.ok(findByTestId(tree, 'dxos-twin-hitl-warning'), 'Large setpoint delta (>2.0C) must show HITL warning');
  await findByTestId(tree, 'dxos-twin-submit-btn').props.onClick();
  tree = render(View, {
    model: { props: { title: 'WebGIS > 6 Assets', showTwinOverlay: true } },
    liveConfig: { maplibreOverride: mockMapLibre },
  });
  const fbText = textOf(findByTestId(tree, 'dxos-twin-feedback'));
  assert.ok(fbText.includes('HITL') && fbText.includes('777'), `Expected HITL approval feedback with ID 777, got: ${fbText}`);
  unmount();
});

test('Task 14b: chatter-panel isolates only sanitized voucher HTML for clean printing without allow-scripts or full-page pollution', async () => {
  const { createVoucherLifecycleBar } = require(path.join(PLUGIN_ROOT, 'src/client/chatter-panel.js'));
  const { React, render, unmount } = createMiniHooks();

  const api = {
    async request(req) {
      if (req.url === 'latticeVoucher:lineage') {
        return { data: { data: { items: [{ id: 12, code: 'ORD-12', status: 'approved', version: 1 }] } } };
      }
      if (req.url === 'dxosWms:printVoucher') {
        return {
          data: {
            data: {
              documentType: 'epod',
              html: '<!doctype html><html><head><style>.hdr{color:#0f172a}</style></head><body><div class="hdr">VOUCHER-ORD-12</div><svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg><script>window.__xss=1</script></body></html>',
              htmlSha256: 'hash12',
            },
          },
        };
      }
      return { data: { data: {} } };
    },
  };

  const Bar = createVoucherLifecycleBar({ useAPIClient: () => api }, React, {});
  let tree = render(Bar, { targetCollection: 'latticeOrders', targetRecordId: 12 });
  await findByTestId(tree, 'dxos-workbench-print-voucher-btn').props.onClick();
  tree = render(Bar, { targetCollection: 'latticeOrders', targetRecordId: 12 });

  const printBtn = findByTestId(tree, 'dxos-workbench-print-browser-btn');
  assert.ok(printBtn);

  const origDoc = global.document;
  const origWin = global.window;
  const origDomParser = global.DOMParser;
  const appended = [];
  const removed = [];
  const winEvents = new Map();
  let printCount = 0;

  try {
    const makeEl = (tag) => ({
      tagName: String(tag).toUpperCase(),
      id: '',
      attributes: [],
      style: {},
      children: [],
      textContent: '',
      setAttribute(k, v) {
        if (k === 'id') this.id = v;
        this.attributes.push({ name: k, value: v });
      },
      appendChild(child) { this.children.push(child); return child; },
      remove() { removed.push(this); },
    });

    global.DOMParser = class MockDomParser {
      parseFromString(htmlStr) {
        // Minimal safe DOM representation with style, div, svg, and script node to verify script stripping
        const scriptNode = { nodeType: 1, tagName: 'SCRIPT', attributes: [], childNodes: [], textContent: 'window.__xss=1' };
        const pathNode = { nodeType: 1, tagName: 'PATH', namespaceURI: 'http://www.w3.org/2000/svg', attributes: [{ name: 'd', value: 'M0 0h1v1z' }], childNodes: [] };
        const svgNode = { nodeType: 1, tagName: 'SVG', namespaceURI: 'http://www.w3.org/2000/svg', attributes: [{ name: 'xmlns', value: 'http://www.w3.org/2000/svg' }], childNodes: [pathNode] };
        const divNode = { nodeType: 1, tagName: 'DIV', attributes: [{ name: 'onclick', value: 'alert(1)' }, { name: 'class', value: 'hdr' }], childNodes: [{ nodeType: 3, textContent: 'VOUCHER-ORD-12' }] };
        const styleNode = { nodeType: 1, tagName: 'STYLE', attributes: [], childNodes: [{ nodeType: 3, textContent: '.hdr{color:#0f172a}' }] };
        return {
          head: { childNodes: [styleNode] },
          body: { childNodes: [divNode, svgNode, scriptNode] },
        };
      }
    };

    global.document = {
      head: { appendChild(el) { appended.push(el); } },
      body: {
        appendChild(el) { appended.push(el); },
        removeChild(el) { removed.push(el); },
      },
      getElementById(id) { return appended.find((n) => n.id === id) || null; },
      querySelector() { return null; },
      createElement: makeEl,
      createElementNS: (_ns, tag) => makeEl(tag),
      createTextNode: (t) => ({ nodeType: 3, textContent: t }),
    };
    global.window = {
      addEventListener(ev, fn) { winEvents.set(ev, fn); },
      removeEventListener(ev) { winEvents.delete(ev); },
      print() { printCount += 1; },
    };

    printBtn.props.onClick();
    assert.equal(printCount, 1);
    const printRoot = appended.find((n) => n.id === 'dxos-isolated-print-root');
    const printStyle = appended.find((n) => n.id === 'dxos-isolated-print-style');
    assert.ok(printRoot, 'Must mount isolated print root container');
    assert.ok(printStyle, 'Must inject @media print stylesheet hiding non-voucher UI');
    assert.ok(printStyle.textContent.includes('@media print'));
    const serializedRoot = JSON.stringify(printRoot);
    assert.ok(serializedRoot.includes('VOUCHER-ORD-12'));
    assert.equal(serializedRoot.includes('__xss'), false, 'Isolated print must strip <script> tags');
    assert.equal(serializedRoot.includes('onclick'), false, 'Isolated print must strip inline on* attributes');

    // Trigger afterprint cleanup
    winEvents.get('afterprint')?.();
    assert.ok(removed.includes(printRoot));
    assert.ok(removed.includes(printStyle));
  } finally {
    global.document = origDoc;
    global.window = origWin;
    if (origDomParser === undefined) delete global.DOMParser;
    else global.DOMParser = origDomParser;
    unmount();
  }
});

test('Task 15b: DxosWmsOpsBlockModel registers cleanly and executes FEFO, issueStock, holdLotByMkt, and 2-Phase Bulk Import Wizard', async () => {
  const { registerDxosBlockModels } = require(path.join(PLUGIN_ROOT, 'src/client/block-models.js'));
  const { createWmsOpsBlockView } = require(path.join(PLUGIN_ROOT, 'src/client/wms-ops-block.js'));
  const { React, render, unmount } = createMiniHooks();

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

  const calls = [];
  const api = {
    async request(req) {
      calls.push(req);
      if (req.url === 'dxosWms:lots') {
        return {
          data: {
            data: {
              organizationId: 'org-a',
              items: [
                { id: 1, lotCode: 'LOT-CT-01', sku: 'VAC-01', productName: 'Vaccine Cần Thơ', qtyOnHand: 40, qtyReserved: 5, qtyAvailable: 35, unit: 'VIAL', expiryDate: '2027-06-01T00:00:00Z', mktCelsius: 4.2, status: 'available' },
              ],
            },
          },
        };
      }
      if (req.url === 'dxosWms:allocateFefo') {
        return { data: { data: { allocatedTotal: 10, shortfall: 0, allocations: [{ lotCode: 'LOT-CT-01', qtyAllocated: 10 }] } } };
      }
      if (req.url === 'dxosWms:issueStock') {
        return { data: { data: { issuedQty: 5, lot: { lotCode: 'LOT-CT-01', qtyOnHand: 35, status: 'available' } } } };
      }
      if (req.url === 'dxosWms:holdLotByMkt') {
        return { data: { data: { held: true, lotCode: 'LOT-CT-01', mktCelsius: 12.4, thresholdCelsius: 8, lotStatus: 'hold_mkt' } } };
      }
      if (req.url === 'dxosBlocks:bulkImportDryRun') {
        return {
          data: {
            data: {
              collection: req.data.collection,
              totalRows: 2,
              validCount: 2,
              invalidCount: 0,
              payloadSha256: 'sha256_batch_ok',
              previewToken: 'ldx_imp_preview_tok_123',
              sampleValidRows: [{ lotCode: 'LOT-IMP-1', sku: 'VAC-02' }],
              invalidRows: [],
            },
          },
        };
      }
      if (req.url === 'dxosBlocks:bulkImportCommit') {
        return {
          data: {
            data: {
              committedCount: 2,
              skippedDuplicates: 0,
              collection: req.data.collection,
              payloadSha256: 'sha256_batch_ok',
            },
          },
        };
      }
      return { data: { data: {} } };
    },
  };

  const registered = {};
  const models = registerDxosBlockModels(
    { useAPIClient: () => api, useUIConfigurationPermissions: () => ({ allowAll: true }) },
    React,
    {},
    { BlockModel: MockBlockModel },
    { registerModels(m) { Object.assign(registered, m); } },
    {},
  );
  assert.ok(models.DxosWmsOpsBlockModel && registered.DxosWmsOpsBlockModel);

  const View = createWmsOpsBlockView({ useAPIClient: () => api }, React, {}, {});
  let tree = render(View, { model: { props: { title: 'Kho FEFO /p/logistics' } } });
  await new Promise((r) => setTimeout(r, 20));
  tree = render(View, { model: { props: { title: 'Kho FEFO /p/logistics' } } });

  assert.ok(findByTestId(tree, 'dxos-wms-ops-block'));
  assert.ok(textOf(tree).includes('LOT-CT-01'));

  // 1. FEFO allocation
  findByTestId(tree, 'dxos-wms-ops-fefo-sku').props.onChange({ target: { value: 'VAC-01' } });
  findByTestId(tree, 'dxos-wms-ops-fefo-qty').props.onChange({ target: { value: '10' } });
  findByTestId(tree, 'dxos-wms-ops-fefo-order').props.onChange({ target: { value: 'ORD-10' } });
  tree = render(View, { model: { props: { title: 'Kho FEFO /p/logistics' } } });
  await findByTestId(tree, 'dxos-wms-ops-fefo-form').props.onSubmit({ preventDefault() {} });
  tree = render(View, { model: { props: { title: 'Kho FEFO /p/logistics' } } });
  assert.ok(calls.some((c) => c.url === 'dxosWms:allocateFefo' && c.data.sku === 'VAC-01' && c.data.quantity === 10));
  assert.ok(textOf(findByTestId(tree, 'dxos-wms-ops-fefo-result')).includes('LOT-CT-01:10'));

  // 2. issueStock
  findByTestId(tree, 'dxos-wms-ops-issue-lot').props.onChange({ target: { value: 'LOT-CT-01' } });
  findByTestId(tree, 'dxos-wms-ops-issue-qty').props.onChange({ target: { value: '5' } });
  tree = render(View, { model: { props: { title: 'Kho FEFO /p/logistics' } } });
  await findByTestId(tree, 'dxos-wms-ops-issue-form').props.onSubmit({ preventDefault() {} });
  assert.ok(calls.some((c) => c.url === 'dxosWms:issueStock' && c.data.lotCode === 'LOT-CT-01' && c.data.quantity === 5));

  // 3. holdLotByMkt
  findByTestId(tree, 'dxos-wms-ops-mkt-lot').props.onChange({ target: { value: 'LOT-CT-01' } });
  findByTestId(tree, 'dxos-wms-ops-mkt-samples').props.onChange({ target: { value: '2.5, 14.0' } });
  tree = render(View, { model: { props: { title: 'Kho FEFO /p/logistics' } } });
  await findByTestId(tree, 'dxos-wms-ops-mkt-form').props.onSubmit({ preventDefault() {} });
  tree = render(View, { model: { props: { title: 'Kho FEFO /p/logistics' } } });
  assert.ok(calls.some((c) => c.url === 'dxosWms:holdLotByMkt' && c.data.lotCode === 'LOT-CT-01'));
  assert.ok(textOf(findByTestId(tree, 'dxos-wms-ops-mkt-result')).includes('Tạm giữ MKT'));

  // 4. 2-Phase Bulk Import Wizard: switch tab -> Dry-Run -> Commit (single-use token cleared after commit)
  findByTestId(tree, 'dxos-wms-ops-tab-import').props.onClick();
  tree = render(View, { model: { props: { title: 'Kho FEFO /p/logistics' } } });
  findByTestId(tree, 'dxos-wms-ops-import-content').props.onChange({
    target: { value: 'lotCode,sku,productName,qtyOnHand,expiryDate\nLOT-IMP-1,VAC-02,Vac,10,2027-12-01' },
  });
  tree = render(View, { model: { props: { title: 'Kho FEFO /p/logistics' } } });
  await findByTestId(tree, 'dxos-wms-ops-import-dryrun-btn').props.onClick();
  tree = render(View, { model: { props: { title: 'Kho FEFO /p/logistics' } } });
  assert.ok(calls.some((c) => c.url === 'dxosBlocks:bulkImportDryRun' && c.data.collection === 'latticeStockLots'));
  assert.ok(findByTestId(tree, 'dxos-wms-ops-import-preview'));

  await findByTestId(tree, 'dxos-wms-ops-import-commit-btn').props.onClick();
  tree = render(View, { model: { props: { title: 'Kho FEFO /p/logistics' } } });
  assert.ok(calls.some((c) => c.url === 'dxosBlocks:bulkImportCommit' && c.data.previewToken === 'ldx_imp_preview_tok_123'));
  assert.ok(textOf(findByTestId(tree, 'dxos-wms-ops-import-commit-result')).includes('2'));
  assert.equal(findByTestId(tree, 'dxos-wms-ops-import-commit-btn').props.disabled, true, 'Single-use previewToken must be cleared after commit');
  unmount();
});

test('Task 16: creative-studio-block displays real meta.count for count widgets while keeping evaluateQueryStats backward-compatible', async () => {
  const {
    evaluateQueryStats,
    resolveWidgetValue,
    createCreativeStudioView,
  } = require(path.join(PLUGIN_ROOT, 'src/client/creative-studio-block.js'));
  const { React, render, unmount } = createMiniHooks();

  // Direct unit compatibility on evaluateQueryStats & resolveWidgetValue
  assert.equal(evaluateQueryStats([{ id: 1 }, { id: 2 }], { metric: 'count' }), 2);
  assert.equal(resolveWidgetValue({ queryId: 'q1', metric: 'count' }, { q1: [{ id: 1 }, { id: 2 }] }), 2);
  assert.equal(resolveWidgetValue({ queryId: 'q1', metric: 'count' }, { q1: [{ id: 1 }, { id: 2 }] }, { q1: 145 }), 145);

  const api = {
    async request(req) {
      if (req.url === 'latticeOrders:list') {
        const rows = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, status: i % 2 === 0 ? 'draft' : 'submitted' }));
        return { data: { data: rows, meta: { count: 145 } } };
      }
      return { data: { data: [] } };
    },
  };

  const View = createCreativeStudioView({ useAPIClient: () => api }, React, {}, {});
  const blueprintJson = JSON.stringify({
    title: 'Báo cáo Tổng hợp',
    queries: [{ id: 'orders', collection: 'latticeOrders', limit: 20 }],
    widgets: [
      { type: 'gauge', title: 'Tổng đơn thực tế', queryId: 'orders', metric: 'count', max: 200, unit: 'đơn' },
      { type: 'rule-callout', title: 'Cảnh báo tồn đọng', queryId: 'orders', metric: 'count', operator: 'gt', threshold: 100 },
    ],
  });

  let tree = render(View, { model: { props: { blueprintJson } } });
  await new Promise((r) => setTimeout(r, 20));
  tree = render(View, { model: { props: { blueprintJson } } });

  const dump = textOf(tree);
  assert.ok(dump.includes('145 đơn'), `Expected real meta.count 145 in gauge widget, got: ${dump}`);
  assert.ok(dump.includes('Giá trị hiện tại: 145'), `Expected real meta.count 145 in rule-callout widget, got: ${dump}`);
  assert.equal(dump.includes('20 đơn'), false, 'Must not display capped rows.length (20) when meta.count is 145');
  unmount();
});

test('Task 16: DxosKanbanScheduleBlockView renders unscheduled bucket in schedule mode with stage, SLA, and click handler', async () => {
  const { createKanbanScheduleBlockView } = require(path.join(PLUGIN_ROOT, 'src/client/kanban-schedule-block.js'));
  const { React, render, unmount } = createMiniHooks();

  const todayIso = new Date().toISOString();
  let mode = 'with-unscheduled';
  const api = {
    async request(req) {
      if (req.url === 'latticeOrders:list') {
        if (mode === 'all-scheduled') {
          return {
            data: {
              data: [
                { id: 10, code: 'ORD-SCHED-10', name: 'Đơn đã có lịch', status: 'submitted', submittedAt: todayIso },
              ],
            },
          };
        }
        return {
          data: {
            data: [
              { id: 1, code: 'ORD-SCHED-1', name: 'Đơn đúng tuần', status: 'submitted', submittedAt: todayIso },
              { id: 2, code: 'ORD-UNSCHED-2', name: 'Đơn chưa có ngày hẹn', status: 'draft', slaStatus: 'breached' },
            ],
          },
        };
      }
      return { data: { data: [] } };
    },
  };

  const clicked = [];
  const View = createKanbanScheduleBlockView({ useAPIClient: () => api }, React, {}, {});
  let tree = render(View, {
    model: {
      props: {
        collection: 'latticeOrders',
        viewMode: 'schedule',
        onRecordClick: (rec, col) => clicked.push({ id: rec.id, col }),
      },
    },
  });
  await new Promise((r) => setTimeout(r, 20));
  tree = render(View, {
    model: {
      props: {
        collection: 'latticeOrders',
        viewMode: 'schedule',
        onRecordClick: (rec, col) => clicked.push({ id: rec.id, col }),
      },
    },
  });

  const unschedSection = findByTestId(tree, 'dxos-schedule-unscheduled');
  assert.ok(unschedSection, 'Schedule view must render dxos-schedule-unscheduled when unscheduled records exist');
  const unschedText = textOf(unschedSection);
  assert.ok(unschedText.includes('ORD-UNSCHED-2'));
  assert.ok(unschedText.includes('Đơn chưa có ngày hẹn'));
  assert.ok(unschedText.includes('Bản nháp'));
  assert.ok(unschedText.includes('SLA Quá hạn'));

  const unschedItem = findByTestId(tree, 'dxos-schedule-unscheduled-item-2');
  assert.ok(unschedItem);
  unschedItem.props.onClick();
  assert.deepEqual(clicked, [{ id: 2, col: 'latticeOrders' }]);

  // When all records have dates, unscheduled section is hidden
  mode = 'all-scheduled';
  const refreshHooks = createMiniHooks();
  const CleanView = createKanbanScheduleBlockView({ useAPIClient: () => api }, refreshHooks.React, {}, {});
  let cleanTree = refreshHooks.render(CleanView, { model: { props: { collection: 'latticeOrders', viewMode: 'schedule' } } });
  await new Promise((r) => setTimeout(r, 20));
  cleanTree = refreshHooks.render(CleanView, { model: { props: { collection: 'latticeOrders', viewMode: 'schedule' } } });
  assert.equal(findByTestId(cleanTree, 'dxos-schedule-unscheduled'), null);
  refreshHooks.unmount();
  unmount();
});

test('Task 5: dxosBlocks:collectionsMeta enforces auth, excludes internal/protected tables, filters by RBAC view permission, and extracts field enumValues', async () => {
  const Module = require('node:module');
  const { createDxosBlocksActions } = require(path.join(PLUGIN_ROOT, 'src/server/blocks-api.js'));
  const origLoad = Module._load;
  let DxosBlocksServerPlugin;
  Module._load = function (request, parent, isMain) {
    if (request === '@nocobase/server') return { Plugin: class Plugin {} };
    return origLoad.call(this, request, parent, isMain);
  };
  try {
    const srvPath = path.join(PLUGIN_ROOT, 'src/server/index.js');
    delete require.cache[require.resolve(srvPath)];
    DxosBlocksServerPlugin = require(srvPath);
  } finally {
    Module._load = origLoad;
  }

  assert.equal(typeof createDxosBlocksActions({}).collectionsMeta, 'function', 'collectionsMeta action must exist');

  // Verify src/server/index.js registers collectionsMeta in loggedIn ACL
  const aclAllowCalls = [];
  const fakePlugin = new DxosBlocksServerPlugin({
    app: {
      resourceManager: { use() {}, define() {} },
      acl: { allow: (res, actions, role) => aclAllowCalls.push({ res, actions, role }) },
    },
    db: {},
  });
  fakePlugin.app = {
    resourceManager: { use() {}, define() {} },
    acl: { allow: (res, actions, role) => aclAllowCalls.push({ res, actions, role }) },
  };
  fakePlugin.db = {};
  await fakePlugin.load();
  const loggedInAllow = aclAllowCalls.find((c) => c.res === 'dxosBlocks' && c.role === 'loggedIn');
  assert.ok(loggedInAllow && loggedInAllow.actions.includes('collectionsMeta'), 'dxosBlocks:collectionsMeta must be allowed for loggedIn');

  const collectionsMap = new Map([
    [
      'users',
      {
        name: 'users',
        options: { title: 'Users' },
        fields: new Map([
          ['id', { name: 'id', type: 'integer' }],
          ['password', { name: 'password', type: 'password' }],
        ]),
      },
    ],
    [
      'roles',
      {
        name: 'roles',
        options: { title: 'Roles' },
        fields: new Map([['name', { name: 'name', type: 'string' }]]),
      },
    ],
    [
      'latticeBuiltApps',
      {
        name: 'latticeBuiltApps',
        options: { title: 'Built Apps' },
        fields: new Map([['appKey', { name: 'appKey', type: 'string' }]]),
      },
    ],
    [
      'latticeAiProfiles',
      {
        name: 'latticeAiProfiles',
        options: { title: 'AI Profiles' },
        fields: new Map([['username', { name: 'username', type: 'string' }]]),
      },
    ],
    [
      'latticeAiAuditLogs',
      {
        name: 'latticeAiAuditLogs',
        options: { title: 'AI Audit Logs' },
        fields: new Map([['action', { name: 'action', type: 'string' }]]),
      },
    ],
    [
      'latticeApiKeys',
      {
        name: 'latticeApiKeys',
        options: { title: 'API Keys' },
        fields: new Map([['keyHash', { name: 'keyHash', type: 'string' }]]),
      },
    ],
    [
      'latticePkiKeys',
      {
        name: 'latticePkiKeys',
        options: { title: 'PKI Keys' },
        fields: new Map([['publicKey', { name: 'publicKey', type: 'text' }]]),
      },
    ],
    [
      'latticeConnectors',
      {
        name: 'latticeConnectors',
        options: { title: 'Connectors' },
        fields: new Map([['connectorKey', { name: 'connectorKey', type: 'string' }]]),
      },
    ],
    [
      'latticeWebhookSubscriptions',
      {
        name: 'latticeWebhookSubscriptions',
        options: { title: 'Webhook Subscriptions' },
        fields: new Map([['targetUrl', { name: 'targetUrl', type: 'string' }]]),
      },
    ],
    [
      'latticeCryptoLedger',
      {
        name: 'latticeCryptoLedger',
        options: { title: 'Crypto Ledger' },
        fields: new Map([['entryHash', { name: 'entryHash', type: 'string' }]]),
      },
    ],
    [
      'latticeOrganizations',
      {
        name: 'latticeOrganizations',
        options: { title: 'Organizations' },
        fields: new Map([['organizationId', { name: 'organizationId', type: 'string' }]]),
      },
    ],
    [
      'latticeCustomHiddenCheck',
      {
        name: 'latticeCustomHiddenCheck',
        options: { title: 'Initially Visible' },
        fields: new Map([['name', { name: 'name', type: 'string' }]]),
      },
    ],
    [
      'latticeOrders',
      {
        name: 'latticeOrders',
        options: { title: 'Đơn Logistics' },
        fields: new Map([
          ['code', { name: 'code', type: 'string', options: { interface: 'input', uiSchema: { title: 'Mã đơn' } } }],
          ['status', { name: 'status', type: 'string', options: { interface: 'select', uiSchema: { title: 'Trạng thái', enum: ['draft', 'submitted'] } } }],
        ]),
      },
    ],
    [
      'latticeCustomMaintenanceOrders',
      {
        name: 'latticeCustomMaintenanceOrders',
        options: { title: 'Lệnh Bảo trì' },
        fields: new Map([
          ['code', { name: 'code', type: 'string', options: { interface: 'input', uiSchema: { title: 'Mã lệnh' } } }],
          ['equipmentName', { name: 'equipmentName', type: 'string', options: { interface: 'input', uiSchema: { title: 'Thiết bị' } } }],
          [
            'status',
            {
              name: 'status',
              type: 'string',
              options: {
                interface: 'select',
                uiSchema: {
                  title: 'Trạng thái bảo trì',
                  enum: [
                    { value: 'reported', label: 'Mới báo' },
                    { value: 'assigned', label: 'Đã giao' },
                    { value: 'fixed', label: 'Đã sửa' },
                  ],
                },
              },
            },
          ],
          ['scheduledAt', { name: 'scheduledAt', type: 'datetime', options: { interface: 'datetime', uiSchema: { title: 'Lịch bảo trì' } } }],
          ['apiKeyHash', { name: 'apiKeyHash', type: 'string' }],
        ]),
      },
    ],
    [
      'latticeCustomSecretVault',
      {
        name: 'latticeCustomSecretVault',
        options: { title: 'Restricted Custom Table' },
        fields: new Map([['title', { name: 'title', type: 'string' }]]),
      },
    ],
  ]);

  const db = {
    collections: collectionsMap,
    getRepository(name) {
      if (name === 'latticeEmployees') {
        return {
          find: async ({ filter }) => (Number(filter?.userId) === 201
            ? [{ id: 10, userId: 201, organizationId: 'org-a', active: true }]
            : []),
        };
      }
      if (name === 'collections') {
        return {
          find: async () => [
            { get: (k) => (k === 'name' ? 'latticeCustomHiddenCheck' : k === 'options' ? { hidden: true } : undefined) },
          ],
        };
      }
      if (name === 'roles') {
        return { findOne: async () => null };
      }
      if (name === 'dataSourcesRolesResources') {
        return { findOne: async () => null };
      }
      return null;
    },
  };

  const actions = createDxosBlocksActions(db);

  // 1. Rejects unauthenticated 401 and POST 405
  await assert.rejects(
    () => actions.collectionsMeta({ method: 'GET', state: {} }, async () => {}),
    (err) => err.status === 401 && err.code === 'NATIVE_LOGIN_REQUIRED',
  );
  await assert.rejects(
    () => actions.collectionsMeta({ method: 'POST', state: { currentRole: 'root', currentUser: { id: 1 } } }, async () => {}),
    (err) => err.status === 405 && err.code === 'METHOD_NOT_ALLOWED',
  );

  // 2. Non-root user only sees permitted collections, NEVER internal/secret tables even if can() returns true for them
  const userCtx = {
    method: 'GET',
    state: { currentRole: 'ldx_operator', currentUser: { id: 201 } },
    can: ({ resource, action }) => action === 'view' && resource !== 'latticeCustomSecretVault',
  };
  await actions.collectionsMeta(userCtx, async () => {});
  const names = userCtx.body.collections.map((c) => c.name);
  assert.ok(names.includes('latticeCustomMaintenanceOrders'));
  assert.ok(names.includes('latticeOrders'));
  assert.equal(names.includes('latticeCustomSecretVault'), false, 'Unpermitted custom collection must be filtered out');
  for (const forbidden of ['users', 'roles', 'latticeBuiltApps', 'latticeAiProfiles', 'latticeAiAuditLogs']) {
    assert.equal(names.includes(forbidden), false, `Protected table ${forbidden} must be excluded`);
  }

  const maint = userCtx.body.collections.find((c) => c.name === 'latticeCustomMaintenanceOrders');
  assert.equal(maint.isCustom, true);
  assert.equal(maint.title, 'Lệnh Bảo trì');
  const statusField = maint.fields.find((f) => f.name === 'status');
  assert.ok(statusField);
  assert.deepEqual(statusField.enumValues, [
    { value: 'reported', label: 'Mới báo' },
    { value: 'assigned', label: 'Đã giao' },
    { value: 'fixed', label: 'Đã sửa' },
  ]);
  assert.equal(maint.fields.some((f) => f.name === 'apiKeyHash'), false, 'Sensitive field must be excluded');

  // 3. Root sees latticeCustomSecretVault too, while protected/secret tables stay excluded
  const rootCtx = {
    method: 'GET',
    state: { currentRole: 'root', currentUser: { id: 1 } },
  };
  await actions.collectionsMeta(rootCtx, async () => {});
  const rootNames = rootCtx.body.collections.map((c) => c.name);
  assert.ok(rootNames.includes('latticeCustomSecretVault'));
  for (const forbidden of [
    'users',
    'roles',
    'latticeBuiltApps',
    'latticeApiKeys',
    'latticePkiKeys',
    'latticeConnectors',
    'latticeWebhookSubscriptions',
    'latticeCryptoLedger',
    'latticeOrganizations',
    'latticeCustomHiddenCheck',
  ]) {
    assert.equal(rootNames.includes(forbidden), false, `Root must NEVER receive ${forbidden} from collectionsMeta`);
  }
});

test('Task 5: DxosKanbanScheduleBlockView renders dynamic latticeCustomMaintenanceOrders from metadata without falling back to latticeOrders and supports drag-drop & stage update', async () => {
  const {
    normalizeKanbanCollection,
    inferKanbanStages,
    createKanbanScheduleBlockView,
  } = require(path.join(PLUGIN_ROOT, 'src/client/kanban-schedule-block.js'));
  const { React, render, unmount } = createMiniHooks();

  assert.equal(typeof normalizeKanbanCollection, 'function');
  assert.equal(typeof inferKanbanStages, 'function');
  assert.equal(normalizeKanbanCollection('latticeCustomMaintenanceOrders'), 'latticeCustomMaintenanceOrders');
  assert.equal(normalizeKanbanCollection(''), 'latticeOrders');

  const customMeta = {
    name: 'latticeCustomMaintenanceOrders',
    title: 'Lệnh Bảo trì',
    isCustom: true,
    fields: [
      { name: 'code', type: 'string', interface: 'input', title: 'Mã lệnh', enumValues: [] },
      { name: 'equipmentName', type: 'string', interface: 'input', title: 'Thiết bị', enumValues: [] },
      {
        name: 'status',
        type: 'string',
        interface: 'select',
        title: 'Trạng thái',
        enumValues: [
          { value: 'reported', label: 'Mới báo' },
          { value: 'assigned', label: 'Đã giao' },
          { value: 'fixed', label: 'Đã sửa' },
        ],
      },
      { name: 'scheduledAt', type: 'datetime', interface: 'datetime', title: 'Lịch bảo trì', enumValues: [] },
    ],
  };

  assert.deepEqual(inferKanbanStages(customMeta, [], { stages: ['triage', 'done'] }), ['triage', 'done']);
  assert.deepEqual(inferKanbanStages(customMeta, [], {}), ['reported', 'assigned', 'fixed']);
  assert.deepEqual(inferKanbanStages(null, [{ id: 1, status: 'queued' }, { id: 2, status: 'running' }], {}), ['queued', 'running']);
  assert.deepEqual(inferKanbanStages(null, [], {}), ['draft', 'submitted', 'approved', 'in_progress', 'completed', 'cancelled']);

  const todayIso = new Date().toISOString();
  const requests = [];
  let denyUpdate = false;
  let recordsState = [
    { id: 101, code: 'MNT-101', equipmentName: 'Máy nén lạnh Chiller-01', status: 'reported', scheduledAt: todayIso },
    { id: 102, code: 'MNT-102', equipmentName: 'Cảm biến Kho B', status: 'assigned', scheduledAt: todayIso },
  ];

  const api = {
    async request(req) {
      requests.push(req);
      if (req.url === 'dxosBlocks:collectionsMeta') {
        return { data: { data: { collections: [customMeta] } } };
      }
      if (req.url === 'latticeCustomMaintenanceOrders:list') {
        return { data: { data: recordsState } };
      }
      if (req.url === 'latticeCustomMaintenanceOrders:update') {
        if (denyUpdate) {
          const err = new Error('Forbidden');
          err.response = { status: 403, data: { errors: [{ message: 'RLS/RBAC từ chối cập nhật' }] } };
          throw err;
        }
        const id = Number(req.params?.filterByTk);
        const patch = req.data || {};
        recordsState = recordsState.map((r) => (r.id === id ? { ...r, ...patch } : r));
        return { data: { data: recordsState.find((r) => r.id === id) } };
      }
      throw new Error(`Unexpected API call: ${req.url}`);
    },
  };

  const View = createKanbanScheduleBlockView({ useAPIClient: () => api }, React, {}, {});
  let tree = render(View, { model: { props: { collection: 'latticeCustomMaintenanceOrders', viewMode: 'kanban' } } });
  await new Promise((r) => setTimeout(r, 30));
  tree = render(View, { model: { props: { collection: 'latticeCustomMaintenanceOrders', viewMode: 'kanban' } } });

  // Zero calls to latticeOrders:list!
  assert.equal(requests.some((r) => r.url === 'latticeOrders:list'), false, 'Must NEVER fall back to latticeOrders:list');
  assert.ok(requests.some((r) => r.url === 'latticeCustomMaintenanceOrders:list'));

  // Custom stages rendered from collectionsMeta
  const cols = collectNodes(tree).filter((n) => n.props?.['data-testid'] === 'dxos-kanban-column');
  assert.deepEqual(cols.map((c) => c.props['data-stage']), ['reported', 'assigned', 'fixed']);
  const dump = textOf(tree);
  assert.ok(dump.includes('Mới báo') && dump.includes('Đã giao') && dump.includes('Đã sửa'));
  assert.ok(dump.includes('Máy nén lạnh Chiller-01'));

  // Drag card 101 to 'assigned' column -> calls latticeCustomMaintenanceOrders:update
  const card101 = findByTestId(tree, 'dxos-kanban-card-101');
  assert.ok(card101 && card101.props.draggable === true, 'Custom Kanban card must be draggable');
  let dragPayload = '';
  card101.props.onDragStart({ dataTransfer: { setData: (_k, v) => { dragPayload = v; } } });
  const assignedCol = cols.find((c) => c.props['data-stage'] === 'assigned');
  assignedCol.props.onDragOver({ preventDefault() {} });
  await assignedCol.props.onDrop({ preventDefault() {}, dataTransfer: { getData: () => dragPayload } });
  tree = render(View, { model: { props: { collection: 'latticeCustomMaintenanceOrders', viewMode: 'kanban' } } });
  assert.ok(
    requests.some((r) => r.url === 'latticeCustomMaintenanceOrders:update' && Number(r.params?.filterByTk) === 101 && r.data?.status === 'assigned'),
    'Drop must invoke latticeCustomMaintenanceOrders:update with filterByTk and new status',
  );

  // Move card 102 via select control to 'fixed'
  const moveSelect102 = findByTestId(tree, 'dxos-kanban-move-102');
  assert.ok(moveSelect102, 'Stage move select must render for dynamic collection record');
  await moveSelect102.props.onChange({ target: { value: 'fixed' } });
  tree = render(View, { model: { props: { collection: 'latticeCustomMaintenanceOrders', viewMode: 'kanban' } } });
  assert.ok(
    requests.some((r) => r.url === 'latticeCustomMaintenanceOrders:update' && Number(r.params?.filterByTk) === 102 && r.data?.status === 'fixed'),
    'Stage select must invoke latticeCustomMaintenanceOrders:update',
  );

  // Schedule mode uses scheduledAt so records appear on the calendar grid (not unscheduled)
  findByTestId(tree, 'dxos-view-mode-schedule').props.onClick();
  tree = render(View, { model: { props: { collection: 'latticeCustomMaintenanceOrders', viewMode: 'kanban' } } });
  const schedGrid = findByTestId(tree, 'dxos-schedule-grid');
  assert.ok(schedGrid);
  assert.ok(textOf(schedGrid).includes('MNT-101'));
  assert.equal(findByTestId(tree, 'dxos-schedule-unscheduled'), null);

  // RBAC/RLS 403 error surfaces cleanly without crashing
  findByTestId(tree, 'dxos-view-mode-kanban').props.onClick();
  tree = render(View, { model: { props: { collection: 'latticeCustomMaintenanceOrders', viewMode: 'kanban' } } });
  denyUpdate = true;
  await findByTestId(tree, 'dxos-kanban-move-101').props.onChange({ target: { value: 'fixed' } });
  tree = render(View, { model: { props: { collection: 'latticeCustomMaintenanceOrders', viewMode: 'kanban' } } });
  assert.ok(textOf(tree).includes('RLS/RBAC từ chối cập nhật'));

  unmount();
});

test('Task 5 Fix Round 1: prototype keys, time-field fallback, non-status statusField :update, and collectionMeta scoping', async () => {
  const {
    normalizeKanbanCollection,
    groupRecordsByKanbanStage,
    buildScheduleDaysGrid,
    createKanbanScheduleBlockView,
  } = require(path.join(PLUGIN_ROOT, 'src/client/kanban-schedule-block.js'));
  const { inferCollectionFieldsMeta } = require(path.join(PLUGIN_ROOT, 'src/client/blocks-helpers.js'));

  // 1. Prototype keys and leading-digit names fall back safely to latticeOrders
  assert.equal(normalizeKanbanCollection('__proto__'), 'latticeOrders');
  assert.equal(normalizeKanbanCollection('constructor'), 'latticeOrders');
  assert.equal(normalizeKanbanCollection('prototype'), 'latticeOrders');
  assert.equal(normalizeKanbanCollection('12345'), 'latticeOrders');

  const protoGrouped = groupRecordsByKanbanStage(
    [{ id: 1, status: '__proto__' }, { id: 2, status: 'open' }],
    'latticeCustomTickets',
    { statusField: 'status' },
  );
  assert.equal(Object.getPrototypeOf(protoGrouped.byStage), null);
  assert.equal(protoGrouped.stages.includes('__proto__'), false);

  // 2. time-only field excluded from dateFields, and parseRecordScheduleDate falls back past unparseable string
  const timeMeta = inferCollectionFieldsMeta({
    name: 'latticeCustomShifts',
    fields: [
      { name: 'shiftWindow', type: 'time', interface: 'time', title: 'Giờ trực' },
      { name: 'createdAt', type: 'datetime', interface: 'datetime', title: 'Ngày tạo' },
    ],
  });
  assert.equal(timeMeta.dateFields.includes('shiftWindow'), false, 'time field must not be treated as a calendar date');
  const grid = buildScheduleDaysGrid(
    [{ id: 1, code: 'SH-1', shiftWindow: '08:30:00', createdAt: '2026-11-25T10:00:00Z' }],
    '2026-11-25',
    { dateFields: ['shiftWindow', 'createdAt'] },
  );
  assert.equal(grid.unscheduled.length, 0, 'Unparseable time string must fall back to createdAt');
  assert.equal(grid.days[2].items.length, 1);

  // 3. Non-'status' statusField (ticketState) on latticeCustomSupportTickets + collection switch clears stale cfg.collectionMeta
  const { React, render, unmount } = createMiniHooks();
  const requests = [];
  const ticketsMeta = {
    name: 'latticeCustomSupportTickets',
    title: 'Phiếu hỗ trợ',
    isCustom: true,
    fields: [
      { name: 'subject', type: 'string', title: 'Tiêu đề' },
      {
        name: 'ticketState',
        type: 'string',
        interface: 'select',
        enumValues: [
          { value: 'new', label: 'Mới' },
          { value: 'resolved', label: 'Đã xong' },
        ],
      },
    ],
  };
  const customOrdersMeta = {
    name: 'latticeCustomMaintenanceOrders',
    title: 'Bảo trì',
    isCustom: true,
    fields: [
      {
        name: 'status',
        type: 'string',
        interface: 'select',
        enumValues: [{ value: 'reported', label: 'Báo hỏng' }],
      },
    ],
  };
  const api = {
    async request(req) {
      requests.push(req);
      if (req.url === 'dxosBlocks:collectionsMeta') {
        return { data: { data: { collections: [customOrdersMeta, ticketsMeta] } } };
      }
      if (req.url === 'latticeCustomMaintenanceOrders:list') {
        return { data: { data: [{ id: 1, code: 'M-1', status: 'reported' }] } };
      }
      if (req.url === 'latticeCustomSupportTickets:list') {
        return { data: { data: [{ id: 77, code: 'TK-77', subject: 'Lỗi tủ âm sâu', ticketState: 'new' }] } };
      }
      if (req.url === 'latticeCustomSupportTickets:update') {
        return { data: { data: { id: 77, ticketState: req.data?.ticketState } } };
      }
      return { data: { data: [] } };
    },
  };

  const View = createKanbanScheduleBlockView({ useAPIClient: () => api }, React, {}, {});
  let tree = render(View, {
    model: {
      props: {
        collection: 'latticeCustomMaintenanceOrders',
        collectionMeta: customOrdersMeta,
        viewMode: 'kanban',
      },
    },
  });
  await new Promise((r) => setTimeout(r, 20));
  tree = render(View, {
    model: {
      props: {
        collection: 'latticeCustomMaintenanceOrders',
        collectionMeta: customOrdersMeta,
        viewMode: 'kanban',
      },
    },
  });

  // Switch dropdown to latticeCustomSupportTickets -> must NOT keep customOrdersMeta!
  const colSelect = collectNodes(tree).find((n) => n.type === 'select' && n.props['aria-label'] === 'Chọn phân hệ Kanban');
  colSelect.props.onChange({ target: { value: 'latticeCustomSupportTickets' } });
  tree = render(View, {
    model: {
      props: {
        collection: 'latticeCustomMaintenanceOrders',
        collectionMeta: customOrdersMeta,
        viewMode: 'kanban',
      },
    },
  });
  await new Promise((r) => setTimeout(r, 20));
  tree = render(View, {
    model: {
      props: {
        collection: 'latticeCustomMaintenanceOrders',
        collectionMeta: customOrdersMeta,
        viewMode: 'kanban',
      },
    },
  });

  const cols = collectNodes(tree).filter((n) => n.props?.['data-testid'] === 'dxos-kanban-column');
  assert.deepEqual(cols.map((c) => c.props['data-stage']), ['new', 'resolved']);
  await findByTestId(tree, 'dxos-kanban-move-77').props.onChange({ target: { value: 'resolved' } });
  assert.ok(
    requests.some((r) => r.url === 'latticeCustomSupportTickets:update' && Number(r.params?.filterByTk) === 77 && r.data?.ticketState === 'resolved'),
    'Must update using non-status statusField (ticketState)',
  );
  unmount();
});

test('Task 6: DxosWebGisBlockModel uiSchema preserves existing 5 fields and adds optional collection, latField, lngField, labelField, statusField', () => {
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

  const models = registerDxosBlockModels(
    { useAPIClient: () => null, useUIConfigurationPermissions: () => ({ allowAll: true }) },
    React,
    {},
    { BlockModel: MockBlockModel },
    { registerModels() {} },
    {},
  );

  const cfgStep = models.DxosWebGisBlockModel.flows.find((f) => f.key === 'dxosBlockSettings').steps.config;
  for (const field of ['title', 'defaultOrganizationId', 'centerLat', 'centerLng', 'showTwinOverlay']) {
    assert.ok(cfgStep.uiSchema[field], `DxosWebGisBlockModel uiSchema missing ${field}`);
  }
  for (const optField of ['collection', 'latField', 'lngField', 'labelField', 'statusField']) {
    assert.ok(cfgStep.uiSchema[optField], `DxosWebGisBlockModel uiSchema missing optional ${optField}`);
    assert.equal(Object.hasOwn(cfgStep.defaultParams, optField), true, `defaultParams missing ${optField}`);
  }
});

test('Task 6: DxosWebGisBlockView renders dxos-webgis-unmapped-notice for latticeCustomFleet without lat/lng or empty records without falling back to DEFAULT_VIETNAM_GEO_MARKERS', async () => {
  const { createWebGisBlockView } = require(path.join(PLUGIN_ROOT, 'src/client/webgis-block.js'));

  // (a1) Custom collection with records lacking lat/lng (even with city keywords in text)
  const hooks1 = createMiniHooks();
  const calls1 = [];
  const api1 = {
    async request(req) {
      calls1.push(req);
      if (req.url === 'dxosBlocks:collectionsMeta') {
        return {
          data: {
            data: {
              collections: [
                {
                  name: 'latticeCustomFleet',
                  title: 'Đội xe lạnh',
                  isCustom: true,
                  fields: [
                    { name: 'plateNumber', type: 'string', title: 'Biển số' },
                    { name: 'driverName', type: 'string', title: 'Tài xế' },
                    { name: 'city', type: 'string', title: 'Thành phố' },
                  ],
                },
              ],
            },
          },
        };
      }
      if (req.url === 'latticeCustomFleet:list') {
        return {
          data: {
            data: [
              { id: 1, plateNumber: '51A12345', driverName: 'Xe Cần Thơ', city: 'Cần Thơ', status: 'active' },
              { id: 2, plateNumber: '29A99999', driverName: 'Xe Hà Nội', city: 'Hà Nội', status: 'active' },
            ],
          },
        };
      }
      throw new Error(`Unexpected API call in custom unmapped mode: ${req.url}`);
    },
  };

  const View1 = createWebGisBlockView({ useAPIClient: () => api1 }, hooks1.React, {}, {});
  let tree1 = hooks1.render(View1, {
    model: { props: { title: 'Bản đồ Đội xe', collection: 'latticeCustomFleet', defaultOrganizationId: 'org-a', showTwinOverlay: true } },
  });
  await new Promise((r) => setTimeout(r, 25));
  tree1 = hooks1.render(View1, {
    model: { props: { title: 'Bản đồ Đội xe', collection: 'latticeCustomFleet', defaultOrganizationId: 'org-a', showTwinOverlay: true } },
  });

  assert.equal(calls1.some((c) => c.url === 'latticeAssets:list'), false, 'Must NEVER query latticeAssets:list when cfg.collection is set');
  assert.equal(calls1.some((c) => c.url === 'latticeLocations:list'), false, 'Must NEVER query latticeLocations:list when cfg.collection is set');
  assert.equal(calls1.some((c) => c.url === 'dxosBlocks:twinShadow'), false, 'Must NEVER query twinShadow for custom collection');
  const fleetCall = calls1.find((c) => c.url === 'latticeCustomFleet:list');
  assert.ok(fleetCall, 'Must query latticeCustomFleet:list');
  assert.deepEqual(fleetCall.params?.filter, { organizationId: 'org-a' });

  const unmappedNotice1 = findByTestId(tree1, 'dxos-webgis-unmapped-notice');
  assert.ok(unmappedNotice1, 'Must render dxos-webgis-unmapped-notice when custom records lack finite lat/lng');
  const pins1 = collectNodes(tree1).filter((n) => n.props?.['data-testid'] === 'dxos-webgis-pin');
  assert.equal(pins1.length, 0, 'Must render zero pins instead of VIETNAM_CITY_COORDS or DEFAULT_VIETNAM_GEO_MARKERS');
  const text1 = textOf(tree1);
  for (const fallbackCode of ['HUB-CT', 'HUB-HCM', 'HUB-DN', 'HUB-HN']) {
    assert.equal(text1.includes(fallbackCode), false, `Must NEVER substitute fallback marker ${fallbackCode}`);
  }
  hooks1.unmount();

  // (a2) Custom collection with empty records []
  const hooks2 = createMiniHooks();
  const calls2 = [];
  const api2 = {
    async request(req) {
      calls2.push(req);
      if (req.url === 'dxosBlocks:collectionsMeta') return { data: { data: { collections: [] } } };
      if (req.url === 'latticeCustomFleet:list') return { data: { data: [] } };
      throw new Error(`Unexpected API call: ${req.url}`);
    },
  };
  const View2 = createWebGisBlockView({ useAPIClient: () => api2 }, hooks2.React, {}, {});
  let tree2 = hooks2.render(View2, { model: { props: { collection: 'latticeCustomFleet' } } });
  await new Promise((r) => setTimeout(r, 25));
  tree2 = hooks2.render(View2, { model: { props: { collection: 'latticeCustomFleet' } } });
  assert.ok(findByTestId(tree2, 'dxos-webgis-unmapped-notice'), 'Empty custom collection must render dxos-webgis-unmapped-notice');
  assert.equal(collectNodes(tree2).filter((n) => n.props?.['data-testid'] === 'dxos-webgis-pin').length, 0);
  hooks2.unmount();
});

test('Task 6: DxosWebGisBlockView renders dynamic latticeCustomSites with explicit & inferred fields, skips Twin controls without assetId, and retains Twin view when collection is unset', async () => {
  const { createWebGisBlockView } = require(path.join(PLUGIN_ROOT, 'src/client/webgis-block.js'));

  // (b1) Explicit latField/lngField/labelField/statusField
  const hooks1 = createMiniHooks();
  const calls1 = [];
  const api1 = {
    async request(req) {
      calls1.push(req);
      if (req.url === 'dxosBlocks:collectionsMeta') return { data: { data: { collections: [] } } };
      if (req.url === 'latticeCustomSites:list') {
        return {
          data: {
            data: [
              { id: 10, siteName: 'Trạm Đà Lạt', healthState: 'warning', geoLat: 11.9404, geoLng: 108.4583, organizationId: 'org-a' },
              { id: 11, siteName: 'Trạm Chưa Gắn Tọa Độ', healthState: 'normal', geoLat: null, geoLng: '' },
            ],
          },
        };
      }
      throw new Error(`Unexpected call: ${req.url}`);
    },
  };
  const View1 = createWebGisBlockView({ useAPIClient: () => api1 }, hooks1.React, {}, {});
  let tree1 = hooks1.render(View1, {
    model: {
      props: {
        title: 'Bản đồ Trạm',
        collection: 'latticeCustomSites',
        latField: 'geoLat',
        lngField: 'geoLng',
        labelField: 'siteName',
        statusField: 'healthState',
        showTwinOverlay: true,
      },
    },
  });
  await new Promise((r) => setTimeout(r, 25));
  tree1 = hooks1.render(View1, {
    model: {
      props: {
        title: 'Bản đồ Trạm',
        collection: 'latticeCustomSites',
        latField: 'geoLat',
        lngField: 'geoLng',
        labelField: 'siteName',
        statusField: 'healthState',
        showTwinOverlay: true,
      },
    },
  });

  assert.equal(findByTestId(tree1, 'dxos-webgis-unmapped-notice'), null);
  const pins1 = collectNodes(tree1).filter((n) => n.props?.['data-testid'] === 'dxos-webgis-pin');
  assert.equal(pins1.length, 1, 'Only finite-coord custom record should become a pin');
  assert.equal(pins1[0].props['data-severity'], 'warning');
  assert.ok(textOf(tree1).includes('Trạm Đà Lạt'));
  assert.equal(textOf(tree1).includes('Trạm Chưa Gắn Tọa Độ'), false);

  pins1[0].props.onClick();
  tree1 = hooks1.render(View1, {
    model: {
      props: {
        title: 'Bản đồ Trạm',
        collection: 'latticeCustomSites',
        latField: 'geoLat',
        lngField: 'geoLng',
        labelField: 'siteName',
        statusField: 'healthState',
        showTwinOverlay: true,
      },
    },
  });
  assert.equal(findByTestId(tree1, 'dxos-webgis-open-twin-drawer-btn'), null, 'Must skip Twin control button when marker lacks assetId');
  assert.equal(findByTestId(tree1, 'dxos-webgis-twin-drawer'), null, 'Must not open Twin drawer when marker lacks assetId');
  assert.equal(calls1.some((c) => c.url === 'dxosBlocks:twinSetDesired'), false);
  hooks1.unmount();

  // (b2) Inferred geo/label/status fields via dxosBlocks:collectionsMeta when latField/lngField omitted
  const hooks2 = createMiniHooks();
  const api2 = {
    async request(req) {
      if (req.url === 'dxosBlocks:collectionsMeta') {
        return {
          data: {
            data: {
              collections: [
                {
                  name: 'latticeCustomFleetTrips',
                  title: 'Chuyến xe lạnh',
                  isCustom: true,
                  fields: [
                    { name: 'tripName', type: 'string', title: 'Tên chuyến' },
                    { name: 'tripStage', type: 'string', interface: 'select', enumValues: [{ value: 'critical', label: 'Khẩn cấp' }] },
                    { name: 'geoLat', type: 'float' },
                    { name: 'geoLng', type: 'float' },
                  ],
                },
              ],
            },
          },
        };
      }
      if (req.url === 'latticeCustomFleetTrips:list') {
        return {
          data: {
            data: [
              { id: 33, tripName: 'Chuyến Mỹ Tho - Sài Gòn', tripStage: 'critical', geoLat: 10.36, geoLng: 106.36 },
            ],
          },
        };
      }
      return { data: { data: [] } };
    },
  };
  const View2 = createWebGisBlockView({ useAPIClient: () => api2 }, hooks2.React, {}, {});
  let tree2 = hooks2.render(View2, { model: { props: { collection: 'latticeCustomFleetTrips' } } });
  await new Promise((r) => setTimeout(r, 25));
  tree2 = hooks2.render(View2, { model: { props: { collection: 'latticeCustomFleetTrips' } } });
  const pins2 = collectNodes(tree2).filter((n) => n.props?.['data-testid'] === 'dxos-webgis-pin');
  assert.equal(pins2.length, 1);
  assert.equal(pins2[0].props['data-severity'], 'critical');
  assert.ok(textOf(tree2).includes('Chuyến Mỹ Tho - Sài Gòn'));
  hooks2.unmount();

  // (c) Unset collection='' retains default latticeLocations + latticeAssets Twin view
  const hooks3 = createMiniHooks();
  const calls3 = [];
  const api3 = {
    async request(req) {
      calls3.push(req);
      if (req.url === 'latticeAssets:list') {
        return { data: { data: [{ id: 88, code: 'COLD-88', name: 'Kho mặc định', kind: 'cold_room', status: 'active', organizationId: 'org-a' }] } };
      }
      if (req.url === 'latticeLocations:list') {
        return { data: { data: [{ id: 3, code: 'LOC-3', name: 'Cần Thơ', address: 'Cần Thơ' }] } };
      }
      if (req.url === 'latticeIncidentCases:list') return { data: { data: [] } };
      if (req.url === 'dxosBlocks:twinShadow') {
        return { data: { data: { shadow: { assetId: 88, commandStatus: 'synced', desiredJson: { targetTempC: -18 }, reportedJson: { targetTempC: -18 } } } } };
      }
      return { data: { data: [] } };
    },
  };
  const View3 = createWebGisBlockView({ useAPIClient: () => api3 }, hooks3.React, {}, {});
  let tree3 = hooks3.render(View3, { model: { props: { collection: '', showTwinOverlay: true } } });
  await new Promise((r) => setTimeout(r, 25));
  tree3 = hooks3.render(View3, { model: { props: { collection: '', showTwinOverlay: true } } });
  assert.ok(calls3.some((c) => c.url === 'latticeAssets:list'));
  assert.ok(calls3.some((c) => c.url === 'latticeLocations:list'));
  assert.ok(calls3.some((c) => c.url === 'dxosBlocks:twinShadow'));
  assert.ok(textOf(tree3).includes('COLD-88'));
  assert.ok(findByTestId(tree3, 'dxos-webgis-open-twin-drawer-btn'));
  hooks3.unmount();
});

test('Task 6: webgis-block rejects prototype keys (__proto__, constructor, prototype) in collection and field lookups', async () => {
  const {
    normalizeWebGisCollection,
    normalizeWebGisFieldName,
    createWebGisBlockView,
  } = require(path.join(PLUGIN_ROOT, 'src/client/webgis-block.js'));

  assert.equal(normalizeWebGisCollection('__proto__'), '');
  assert.equal(normalizeWebGisCollection('constructor'), '');
  assert.equal(normalizeWebGisCollection('prototype'), '');
  assert.equal(normalizeWebGisCollection('123bad'), '');
  assert.equal(normalizeWebGisCollection('latticeCustomSites'), 'latticeCustomSites');

  assert.equal(normalizeWebGisFieldName('__proto__'), '');
  assert.equal(normalizeWebGisFieldName('constructor'), '');
  assert.equal(normalizeWebGisFieldName('prototype'), '');
  assert.equal(normalizeWebGisFieldName('toString'), 'toString');
  assert.equal(normalizeWebGisFieldName('geoLat'), 'geoLat');

  const hooks = createMiniHooks();
  const calls = [];
  const api = {
    async request(req) {
      calls.push(req);
      return { data: { data: [] } };
    },
  };
  const View = createWebGisBlockView({ useAPIClient: () => api }, hooks.React, {}, {});
  hooks.render(View, {
    model: {
      props: {
        collection: '__proto__',
        latField: 'constructor',
        lngField: 'prototype',
        labelField: '__proto__',
        statusField: 'constructor',
      },
    },
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.some((c) => c.url.includes('__proto__')), false, 'Must NEVER query __proto__:list');
  assert.ok(calls.some((c) => c.url === 'latticeAssets:list'), 'Rejected prototype collection falls back to default Twin view');
  hooks.unmount();
});

test('Task 7: VoucherLifecycleBar renders PKI & Lineage badges for latticeCustom* records while gating voucher workflow actions', async () => {
  const { createVoucherLifecycleBar } = require(path.join(PLUGIN_ROOT, 'src/client/chatter-panel.js'));
  const { React, render, unmount } = createMiniHooks();

  const calls = [];
  const api = {
    async request(req) {
      calls.push(req);
      if (req.url === 'latticeCustomWorkOrders:get') {
        return { data: { data: { id: 17, code: 'WO-17', status: 'in_progress', organizationId: 'org-a' } } };
      }
      if (req.url === 'dxosLedger:entries') {
        return { data: { data: { total: 1, items: [{ seq: 91, keyId: 'ed25519-org-a', entryHash: 'abc123def4567890' }] } } };
      }
      if (req.url === 'dxosLedger:verify') {
        return { data: { data: { valid: true, checkedCount: 91 } } };
      }
      if (req.url === 'dxosDataGov:lineageTrace') {
        return {
          data: {
            data: {
              nodes: [{ key: 'latticeCustomWorkOrders:17', collection: 'latticeCustomWorkOrders', recordId: '17', depth: 0 }],
              edges: [{ edgeUid: 'lin-wo-1', sourceCollection: 'latticeIncidentCases', sourceRecordId: '5', targetCollection: 'latticeCustomWorkOrders', targetRecordId: '17', relationType: 'generated_work_order' }],
              truncated: false,
            },
          },
        };
      }
      return { data: { data: {} } };
    },
  };

  const Bar = createVoucherLifecycleBar({ useAPIClient: () => api }, React, {});
  assert.equal(Bar({ targetCollection: 'latticeCustomWorkOrders', targetRecordId: 0 }), null);
  assert.equal(Bar({ targetCollection: 'latticeCustomWorkOrders', targetRecordId: 17.5 }), null);
  assert.equal(Bar({ targetCollection: '__proto__', targetRecordId: 17 }), null);
  assert.equal(Bar({ targetCollection: 'constructor', targetRecordId: 17 }), null);
  assert.equal(Bar({ targetCollection: 'bad collection!', targetRecordId: 17 }), null);

  let tree = render(Bar, { targetCollection: 'latticeCustomWorkOrders', targetRecordId: 17 });
  await new Promise((r) => setTimeout(r, 25));
  tree = render(Bar, { targetCollection: 'latticeCustomWorkOrders', targetRecordId: 17 });

  assert.equal(calls.some((c) => c.url === 'latticeVoucher:lineage'), false, 'Non-voucher custom collection must not call latticeVoucher:lineage');
  assert.ok(calls.some((c) => c.url === 'latticeCustomWorkOrders:get'));
  assert.ok(calls.some((c) => c.url === 'dxosLedger:entries' && c.params?.targetCollection === 'latticeCustomWorkOrders' && c.params?.organizationId === 'org-a'));

  // PKI and Lineage render, while voucher actions (submit/cancel/amend/print) are gated out
  assert.ok(findByTestId(tree, 'dxos-voucher-lifecycle-bar'));
  assert.ok(findByTestId(tree, 'dxos-workbench-pki-badge'));
  assert.ok(textOf(findByTestId(tree, 'dxos-workbench-pki-badge')).includes('91'));
  assert.ok(findByTestId(tree, 'dxos-workbench-lineage-panel'));
  assert.equal(findByTestId(tree, 'dxos-voucher-submit-btn'), null);
  assert.equal(findByTestId(tree, 'dxos-voucher-cancel-btn'), null);
  assert.equal(findByTestId(tree, 'dxos-voucher-amend-btn'), null);
  assert.equal(findByTestId(tree, 'dxos-voucher-reason-input'), null);
  assert.equal(findByTestId(tree, 'dxos-workbench-print-voucher-btn'), null);

  await findByTestId(tree, 'dxos-workbench-pki-verify-btn').props.onClick();
  await findByTestId(tree, 'dxos-workbench-lineage-btn').props.onClick();
  tree = render(Bar, { targetCollection: 'latticeCustomWorkOrders', targetRecordId: 17 });
  assert.ok(textOf(findByTestId(tree, 'dxos-workbench-pki-badge')).includes('Hợp lệ (91 mục)'));
  assert.ok(textOf(findByTestId(tree, 'dxos-workbench-lineage-panel')).includes('generated_work_order'));
  unmount();
});

test('Task 7: DxosRecordWorkbenchView dynamically merges latticeCustom* from collectionsMeta and operates Chatter, Export, and PKI/Lineage on custom records', async () => {
  const { registerDxosBlockModels } = require(path.join(PLUGIN_ROOT, 'src/client/block-models.js'));
  const { React, render, unmount } = createMiniHooks();

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

  const calls = [];
  const api = {
    async request(req) {
      calls.push(req);
      if (req.url === 'dxosBlocks:collectionsMeta') {
        return {
          data: {
            data: {
              collections: [
                { name: 'latticeCustomMaintenanceOrders', title: 'Lệnh Bảo trì', isCustom: true, fields: [{ name: 'equipmentName', type: 'string' }] },
              ],
            },
          },
        };
      }
      if (req.url === 'latticeCustomMaintenanceOrders:list') {
        return { data: { data: [{ id: 8, code: 'MNT-8', equipmentName: 'Chiller 08', organizationId: 'org-a', status: 'open' }] } };
      }
      if (req.url === 'latticeCustomMaintenanceOrders:get') {
        return { data: { data: { id: 8, code: 'MNT-8', equipmentName: 'Chiller 08', organizationId: 'org-a', status: 'open' } } };
      }
      if (req.url === 'latticeChatter:list') {
        return { data: { data: { items: [{ id: 1, entryType: 'comment', body: 'Đã kiểm tra @EMP-A1', authorName: 'an' }] } } };
      }
      if (req.url === 'dxosLedger:entries') {
        return { data: { data: { total: 1, items: [{ seq: 55, keyId: 'ed25519-k1', entryHash: 'beef1234567890' }] } } };
      }
      if (req.url === 'dxosBlocks:exportReport') {
        return { data: { data: { filename: 'latticeCustomMaintenanceOrders-org-a.csv', rowCount: 1, sha256: 'deadbeef1234', contentBase64: '' } } };
      }
      return { data: { data: [] } };
    },
  };

  const models = registerDxosBlockModels(
    { useAPIClient: () => api, useUIConfigurationPermissions: () => ({ allowAll: true }) },
    React,
    {},
    { BlockModel: MockBlockModel },
    { registerModels() {} },
    {},
  );

  const Workbench = models.DxosRecordWorkbenchBlockModel;
  const inst = new Workbench({
    props: { collection: 'latticeCustomMaintenanceOrders', recordId: '8', showExport: true, showVoucherActions: true, showChatter: true },
  });
  const el = inst.renderComponent();
  let tree = render(el.type, el.props);
  await new Promise((r) => setTimeout(r, 30));
  tree = render(el.type, el.props);
  const resolved = resolveTree(tree);

  // Select dropdown includes dynamic custom collection option from collectionsMeta
  const colSelect = collectNodes(resolved).find((n) => n.type === 'select' && n.props['aria-label'] === 'Lọc phân hệ nghiệp vụ');
  assert.ok(colSelect);
  const optValues = collectNodes(colSelect).filter((n) => n.type === 'option').map((n) => n.props.value);
  assert.ok(optValues.includes('latticeCustomMaintenanceOrders'), 'Workbench dropdown must include dynamic latticeCustom* collection');
  assert.ok(textOf(colSelect).includes('Lệnh Bảo trì (latticeCustomMaintenanceOrders)'));

  // Recent custom records dropdown + PKI badge + Lineage panel + Chatter + Export bar all render cleanly
  assert.ok(calls.some((c) => c.url === 'latticeCustomMaintenanceOrders:list'));
  assert.ok(textOf(resolved).includes('MNT-8'));
  assert.ok(findByTestId(resolved, 'dxos-record-chatter'));
  assert.ok(findByTestId(resolved, 'dxos-workbench-pki-badge'));
  assert.ok(findByTestId(resolved, 'dxos-workbench-lineage-panel'));
  assert.equal(findByTestId(resolved, 'dxos-voucher-submit-btn'), null);

  const csvBtn = collectNodes(findByTestId(resolved, 'dxos-workbench-export-bar')).find((n) => n.type === 'button' && textOf(n).includes('CSV'));
  await csvBtn.props.onClick();
  assert.ok(calls.some((c) => c.url === 'dxosBlocks:exportReport' && c.data?.collection === 'latticeCustomMaintenanceOrders'));
  unmount();

  // Verify RecordChatterView directly on latticeCustomMaintenanceOrders (list + post)
  const { createRecordChatterView } = require(path.join(PLUGIN_ROOT, 'src/client/chatter-panel.js'));
  const chatterHooks = createMiniHooks();
  const ChatterView = createRecordChatterView({ useAPIClient: () => api }, chatterHooks.React, {});
  let cTree = chatterHooks.render(ChatterView, { targetCollection: 'latticeCustomMaintenanceOrders', targetRecordId: 8 });
  await new Promise((r) => setTimeout(r, 25));
  cTree = chatterHooks.render(ChatterView, { targetCollection: 'latticeCustomMaintenanceOrders', targetRecordId: 8 });
  assert.ok(calls.some((c) => c.url === 'latticeChatter:list' && c.params?.targetCollection === 'latticeCustomMaintenanceOrders' && Number(c.params?.targetRecordId) === 8));
  assert.ok(textOf(findByTestId(cTree, 'dxos-record-chatter')).includes('Đã kiểm tra'));
  chatterHooks.unmount();
});

test('WebGIS resets filterMode to all when switching dynamic customCollection', async () => {
  const { createWebGisBlockView } = require(path.join(PLUGIN_ROOT, 'src/client/webgis-block.js'));
  const hooks = createMiniHooks();
  const api = {
    async request(req) {
      if (req.url === 'dxosBlocks:collectionsMeta') {
        return { data: { data: { collections: [{ name: 'latticeCustomSites', isCustom: true, fields: [{ name: 'lat', type: 'double' }, { name: 'lng', type: 'double' }] }] } } };
      }
      if (req.url === 'latticeCustomSites:list') {
        return { data: { data: [{ id: 1, code: 'SITE-1', name: 'Site 1', lat: 10.03, lng: 105.78 }] } };
      }
      return { data: { data: [] } };
    },
  };
  const WebGisView = createWebGisBlockView({ useAPIClient: () => api }, hooks.React, {}, {});
  let tree = hooks.render(WebGisView, { model: { props: { showTwinOverlay: false } } });
  await new Promise((r) => setTimeout(r, 20));
  tree = hooks.render(WebGisView, { model: { props: { showTwinOverlay: false } } });
  const initAllBtn = collectNodes(resolveTree(tree)).find((n) => n.type === 'button' && n.props?.['data-testid'] === 'dxos-webgis-filter-all');
  const activeBg = initAllBtn.props.style?.background;
  const alarmsBtn = collectNodes(resolveTree(tree)).find((n) => n.type === 'button' && n.props?.['data-testid'] === 'dxos-webgis-filter-alarms');
  assert.ok(alarmsBtn);
  alarmsBtn.props.onClick();
  tree = hooks.render(WebGisView, { model: { props: { showTwinOverlay: false } } });
  const alarmsAfterClick = collectNodes(resolveTree(tree)).find((n) => n.type === 'button' && n.props?.['data-testid'] === 'dxos-webgis-filter-alarms');
  assert.equal(alarmsAfterClick.props.style?.background, activeBg);

  // Switch collection prop -> filterMode resets to 'all' so SITE-1 renders & 'all' button regains active style
  tree = hooks.render(WebGisView, { model: { props: { collection: 'latticeCustomSites', showTwinOverlay: false } } });
  await new Promise((r) => setTimeout(r, 20));
  tree = hooks.render(WebGisView, { model: { props: { collection: 'latticeCustomSites', showTwinOverlay: false } } });
  const resolvedSwitched = resolveTree(tree);
  const allAfterSwitch = collectNodes(resolvedSwitched).find((n) => n.type === 'button' && n.props?.['data-testid'] === 'dxos-webgis-filter-all');
  assert.equal(allAfterSwitch.props.style?.background, activeBg);
  assert.ok(textOf(resolvedSwitched).includes('SITE-1'), 'Resetting filterMode to all allows SITE-1 custom marker to render');
  hooks.unmount();
});

test('bi-chart-block pure helpers normalize payloads and compute SVG geometry for bar/line/pie', () => {
  const {
    buildAggregateQueryPayload,
    computeBarGeometry,
    computeLineGeometry,
    computePieSlices,
  } = require(path.join(PLUGIN_ROOT, 'src/client/bi-chart-block.js'));

  const flatPayload = buildAggregateQueryPayload({
    collection: 'latticeOrders',
    chartType: 'bar',
    groupBy: 'status',
    secondaryGroupBy: 'region',
    metricOp: 'sum',
    metricField: 'totalAmount',
    limit: 999,
    filterJson: '{"status":"approved"}',
  });
  assert.deepEqual(flatPayload, {
    collection: 'latticeOrders',
    chartType: 'bar',
    groupBy: 'status',
    metric: { op: 'sum', field: 'totalAmount' },
    filter: { status: 'approved' },
    limit: 500,
  });

  const nestedPayload = buildAggregateQueryPayload({
    collection: 'latticeCustom_join_items',
    chartType: 'pivot',
    groupBy: 'month',
    secondaryGroupBy: 'region',
    metric: { op: 'count', field: 'ignoredOnCount' },
    filter: { region: 'HCM' },
    limit: 25,
  });
  assert.deepEqual(nestedPayload, {
    collection: 'latticeCustom_join_items',
    chartType: 'pivot',
    groupBy: 'month',
    secondaryGroupBy: 'region',
    metric: { op: 'count' },
    filter: { region: 'HCM' },
    limit: 25,
  });

  const barGeo = computeBarGeometry([
    { key: 'approved', label: 'approved', value: 400 },
    { key: 'draft', label: 'draft', value: 100 },
  ]);
  assert.equal(barGeo.bars.length, 2);
  assert.ok(barGeo.bars[0].height > barGeo.bars[1].height);

  const lineGeo = computeLineGeometry([
    { key: '2026-01', label: '2026-01', value: 10 },
    { key: '2026-02', label: '2026-02', value: 30 },
  ]);
  assert.equal(lineGeo.points.length, 2);
  assert.ok(lineGeo.polylinePoints.includes(','));

  const pieGeo = computePieSlices([
    { key: 'A', label: 'A', value: 75 },
    { key: 'B', label: 'B', value: 25 },
  ]);
  assert.equal(pieGeo.total, 100);
  assert.equal(pieGeo.slices.length, 2);
  assert.ok(Math.abs(pieGeo.slices[0].pct - 0.75) < 0.001);

  const singlePie = computePieSlices([{ key: 'Only', label: 'Only', value: 42 }]);
  assert.equal(singlePie.slices[0].isFullCircle, true);
});

test('DxosBiChartView renders bar, line, pie, kpi, pivot views, error/empty states, and cancels stale responses', async () => {
  const { createBiChartBlockView } = require(path.join(PLUGIN_ROOT, 'src/client/bi-chart-block.js'));

  const calls = [];
  let mode = 'bar';
  let slowResolve = null;
  const api = {
    async request(req) {
      calls.push(req);
      if (req.url === 'dxosBlocks:collectionsMeta') {
        return { data: { data: { collections: [{ name: 'latticeOrders', title: 'Đơn Logistics', fields: [{ name: 'status', type: 'string' }, { name: 'totalAmount', type: 'decimal' }] }] } } };
      }
      if (req.url === 'dxosBlocks:aggregateQuery') {
        if (mode === 'slow') {
          return new Promise((resolve) => { slowResolve = resolve; });
        }
        if (mode === 'error') {
          const err = new Error('Forbidden');
          err.response = { status: 403, data: { errors: [{ message: 'Không có quyền xem collection' }] } };
          throw err;
        }
        if (mode === 'empty') {
          return { data: { data: { ok: true, collection: 'latticeOrders', chartType: req.data.chartType, series: [], summary: { count: 0, value: 0 }, pivotMatrix: null, totalRows: 0, meta: {} } } };
        }
        if (req.data.chartType === 'pivot') {
          return {
            data: {
              data: {
                ok: true,
                collection: 'latticeOrders',
                chartType: 'pivot',
                series: [{ key: 'approved', label: 'approved', value: 400 }],
                summary: { count: 2, sum: 400, value: 400, op: 'sum', field: 'totalAmount' },
                pivotMatrix: {
                  rowField: 'status',
                  colField: 'region',
                  rows: ['approved', '__proto__'],
                  columns: ['HCM', 'constructor'],
                  cells: {
                    approved: { HCM: 300, constructor: 100 },
                    __proto__: { HCM: 0, constructor: 25 },
                  },
                  rowTotals: { approved: 400 },
                  colTotals: { HCM: 300, constructor: 125 },
                  grandTotal: 425,
                },
                totalRows: 3,
                meta: {},
              },
            },
          };
        }
        return {
          data: {
            data: {
              ok: true,
              collection: 'latticeOrders',
              chartType: req.data.chartType,
              series: [
                { key: 'approved', label: 'Đã duyệt', value: 400, count: 2 },
                { key: 'draft', label: 'Nháp', value: 100, count: 1 },
              ],
              summary: { count: 3, sum: 500, avg: 166.67, min: 100, max: 300, value: 500, op: 'sum', field: 'totalAmount' },
              pivotMatrix: null,
              totalRows: 3,
              meta: {},
            },
          },
        };
      }
      return { data: { data: [] } };
    },
  };

  for (const [chartType, testId, itemTestId] of [
    ['bar', 'dxos-bi-chart-bar', 'dxos-bi-bar-item'],
    ['line', 'dxos-bi-chart-line', 'dxos-bi-line-point'],
    ['pie', 'dxos-bi-chart-pie', 'dxos-bi-pie-slice'],
    ['kpi', 'dxos-bi-chart-kpi', 'dxos-bi-kpi-value'],
    ['pivot', 'dxos-bi-chart-pivot', null],
  ]) {
    mode = chartType;
    const hooks = createMiniHooks();
    const View = createBiChartBlockView({ useAPIClient: () => api }, hooks.React, {}, {});
    const props = {
      model: {
        props: {
          title: `Test ${chartType}`,
          collection: 'latticeOrders',
          chartType,
          groupBy: 'status',
          secondaryGroupBy: chartType === 'pivot' ? 'region' : '',
          metricOp: 'sum',
          metricField: 'totalAmount',
        },
      },
    };
    let tree = hooks.render(View, props);
    await new Promise((r) => setTimeout(r, 20));
    tree = hooks.render(View, props);
    const resolved = resolveTree(tree);
    assert.ok(findByTestId(resolved, testId), `Expected ${testId} for chartType=${chartType}`);
    if (itemTestId) {
      assert.ok(findByTestId(resolved, itemTestId), `Expected ${itemTestId} for chartType=${chartType}`);
    }
    if (chartType === 'pivot') {
      assert.ok(textOf(findByTestId(resolved, 'dxos-bi-chart-pivot')).includes('425'));
    }
    hooks.unmount();
  }

  assert.ok(calls.some((c) => c.url === 'dxosBlocks:aggregateQuery' && c.method === 'post' && c.skipNotify === true));

  // Error state
  mode = 'error';
  const errHooks = createMiniHooks();
  const ErrView = createBiChartBlockView({ useAPIClient: () => api }, errHooks.React, {}, {});
  let errTree = errHooks.render(ErrView, { model: { props: { collection: 'latticeOrders', chartType: 'bar', groupBy: 'status' } } });
  await new Promise((r) => setTimeout(r, 20));
  errTree = errHooks.render(ErrView, { model: { props: { collection: 'latticeOrders', chartType: 'bar', groupBy: 'status' } } });
  const errEl = findByTestId(resolveTree(errTree), 'dxos-bi-chart-error');
  assert.ok(errEl);
  assert.equal(errEl.props.role, 'alert');
  errHooks.unmount();

  // Empty state
  mode = 'empty';
  const emptyHooks = createMiniHooks();
  const EmptyView = createBiChartBlockView({ useAPIClient: () => api }, emptyHooks.React, {}, {});
  let emptyTree = emptyHooks.render(EmptyView, { model: { props: { collection: 'latticeOrders', chartType: 'bar', groupBy: 'status' } } });
  await new Promise((r) => setTimeout(r, 20));
  emptyTree = emptyHooks.render(EmptyView, { model: { props: { collection: 'latticeOrders', chartType: 'bar', groupBy: 'status' } } });
  assert.ok(findByTestId(resolveTree(emptyTree), 'dxos-bi-chart-empty'));
  emptyHooks.unmount();

  // Stale slow response ignored when switching config
  mode = 'slow';
  const staleHooks = createMiniHooks();
  const StaleView = createBiChartBlockView({ useAPIClient: () => api }, staleHooks.React, {}, {});
  staleHooks.render(StaleView, { model: { props: { collection: 'latticeOrders', chartType: 'bar', groupBy: 'status' } } });
  mode = 'kpi';
  let freshTree = staleHooks.render(StaleView, { model: { props: { collection: 'latticeOrders', chartType: 'kpi', metricOp: 'count' } } });
  await new Promise((r) => setTimeout(r, 20));
  if (typeof slowResolve === 'function') {
    slowResolve({ data: { data: { ok: true, collection: 'latticeOrders', chartType: 'bar', series: [{ key: 'STALE', label: 'STALE', value: 99999 }], summary: { value: 99999 }, totalRows: 1, meta: {} } } });
  }
  await new Promise((r) => setTimeout(r, 20));
  freshTree = staleHooks.render(StaleView, { model: { props: { collection: 'latticeOrders', chartType: 'kpi', metricOp: 'count' } } });
  assert.equal(textOf(resolveTree(freshTree)).includes('STALE'), false, 'Stale slow response must be ignored');
  staleHooks.unmount();
});

test('M1.1 Iteration 2: parseBiFilterJson fails closed on dangerous operators, dot-paths, and prototype keys nested anywhere', async () => {
  const { parseBiFilterJson, buildAggregateQueryPayload } = require(path.join(PLUGIN_ROOT, 'src/client/bi-chart-block.js'));

  assert.equal(parseBiFilterJson('{"$and":[{"$where":"1=1"}]}'), undefined);
  assert.equal(parseBiFilterJson('{"status":"open","$and":[{"$sql":"SELECT 1"}]}'), undefined);
  assert.equal(parseBiFilterJson('{"$or":[{"user.password":"x"}]}'), undefined);
  assert.equal(parseBiFilterJson('{"status":"open","__proto__":{"polluted":true}}'), undefined);
  assert.equal(parseBiFilterJson('{"$and":[{"constructor":{"x":1}}]}'), undefined);
  assert.equal(parseBiFilterJson('{"status":{"$eval":"1"}}'), undefined);

  const payload = buildAggregateQueryPayload({
    collection: 'latticeOrders',
    chartType: 'bar',
    groupBy: 'status',
    filterJson: '{"$and":[{"$where":"1=1"}]}',
  });
  assert.equal(payload.filter, undefined);

  assert.deepEqual(
    parseBiFilterJson('{"$and":[{"status":{"$in":["open","closed"]}},{"totalAmount":{"$gte":100}}]}'),
    { $and: [{ status: { $in: ['open', 'closed'] } }, { totalAmount: { $gte: 100 } }] },
  );

  // DxosBiChartView fails closed with warning banner and skips aggregateQuery when filterJson is dangerous/invalid
  const { createBiChartBlockView } = require(path.join(PLUGIN_ROOT, 'src/client/bi-chart-block.js'));
  const hooks = createMiniHooks();
  const aggCalls = [];
  const api = {
    async request(req) {
      if (req.url === 'dxosBlocks:aggregateQuery') aggCalls.push(req);
      return { data: { data: { collections: [] } } };
    },
  };
  const View = createBiChartBlockView({ useAPIClient: () => api }, hooks.React, {}, {});
  let tree = hooks.render(View, {
    model: {
      props: {
        collection: 'latticeOrders',
        chartType: 'bar',
        groupBy: 'status',
        filterJson: '{"$and":[{"$where":"1=1"}]}',
      },
    },
  });
  await new Promise((r) => setTimeout(r, 20));
  tree = hooks.render(View, {
    model: {
      props: {
        collection: 'latticeOrders',
        chartType: 'bar',
        groupBy: 'status',
        filterJson: '{"$and":[{"$where":"1=1"}]}',
      },
    },
  });
  const warnEl = findByTestId(resolveTree(tree), 'dxos-bi-chart-filter-warning');
  assert.ok(warnEl, 'Expected dxos-bi-chart-filter-warning banner on dangerous filterJson');
  assert.equal(aggCalls.length, 0, 'Must not send unfiltered aggregateQuery when filterJson is invalid/dangerous');
  hooks.unmount();
});

test('M1.1 Iteration 3: parseBiFilterJson precedence, whitespace empty-brace handling, filter warning matrix, and Pivot avg/min/max rendering', async () => {
  const {
    parseBiFilterJson,
    buildAggregateQueryPayload,
    createBiChartBlockView,
  } = require(path.join(PLUGIN_ROOT, 'src/client/bi-chart-block.js'));

  // 1. Precedence & whitespace empty-brace cases
  assert.deepEqual(parseBiFilterJson('{"status":"open"}', {}), { status: 'open' });
  assert.deepEqual(
    buildAggregateQueryPayload({
      collection: 'latticeOrders',
      chartType: 'bar',
      filter: {},
      filterJson: '{"status":"open"}',
    }).filter,
    { status: 'open' },
  );
  assert.deepEqual(parseBiFilterJson('{"status":"open"}', { region: 'HCM' }), { region: 'HCM' });
  assert.equal(parseBiFilterJson('{"status":"open"}', { $where: '1=1' }), undefined);
  assert.equal(parseBiFilterJson('{ }'), undefined);
  assert.equal(parseBiFilterJson(' { \n\t } '), undefined);

  // 2. DxosBiChartView filter warning matrix (valid/empty -> 0 warnings + 1 API call; invalid/dangerous -> warning + 0 API calls)
  const renderWithProps = async (extraProps, mockAggResponse) => {
    const hooks = createMiniHooks();
    const aggCalls = [];
    const api = {
      async request(req) {
        if (req.url === 'dxosBlocks:aggregateQuery') {
          aggCalls.push(req);
          if (mockAggResponse) return mockAggResponse(req);
          return {
            data: {
              data: {
                ok: true,
                collection: 'latticeOrders',
                chartType: req.data.chartType,
                series: [{ key: 'open', label: 'open', value: 10, count: 10 }],
                summary: { count: 10, value: 10, op: 'count', field: null },
                pivotMatrix: null,
                totalRows: 10,
                meta: {},
              },
            },
          };
        }
        return { data: { data: { collections: [] } } };
      },
    };
    const View = createBiChartBlockView({ useAPIClient: () => api }, hooks.React, {}, {});
    const props = {
      model: {
        props: {
          collection: 'latticeOrders',
          chartType: 'bar',
          groupBy: 'status',
          ...extraProps,
        },
      },
    };
    hooks.render(View, props);
    await new Promise((r) => setTimeout(r, 20));
    const tree = hooks.render(View, props);
    const resolved = resolveTree(tree);
    hooks.unmount();
    return { resolved, aggCalls };
  };

  for (const emptyJson of ['', '  ', '{}', '{ }', ' { \n\t } ']) {
    for (const filterVal of [undefined, {}]) {
      const { resolved, aggCalls } = await renderWithProps({ filterJson: emptyJson, filter: filterVal });
      assert.equal(
        findByTestId(resolved, 'dxos-bi-chart-filter-warning'),
        null,
        `Unexpected warning for filterJson=${JSON.stringify(emptyJson)} filter=${JSON.stringify(filterVal)}`,
      );
      assert.equal(aggCalls.length, 1);
      assert.equal(aggCalls[0].data.filter, undefined);
      assert.ok(findByTestId(resolved, 'dxos-bi-chart-bar'));
    }
  }

  {
    const { resolved, aggCalls } = await renderWithProps({ filter: {}, filterJson: '{"status":"open"}' });
    assert.equal(findByTestId(resolved, 'dxos-bi-chart-filter-warning'), null);
    assert.equal(aggCalls.length, 1);
    assert.deepEqual(aggCalls[0].data.filter, { status: 'open' });
  }

  for (const badProps of [
    { filterJson: '{bad}' },
    { filterJson: '[{"status":"open"}]' },
    { filterJson: '{"$expr":{"$eq":[1,1]}}' },
    { filter: { $where: '1=1' }, filterJson: '{ }' },
    { filter: ['bad'] },
    { filterJson: { $where: '1' } },
  ]) {
    const { resolved, aggCalls } = await renderWithProps(badProps);
    assert.ok(
      findByTestId(resolved, 'dxos-bi-chart-filter-warning'),
      `Expected filter warning for ${JSON.stringify(badProps)}`,
    );
    assert.equal(aggCalls.length, 0);
  }

  // 3. Pivot UI rendering for avg, min (including grandTotal: 0 distinct from summary.value: 15), and max
  {
    const { resolved } = await renderWithProps(
      { chartType: 'pivot', groupBy: 'status', secondaryGroupBy: 'region', metricOp: 'avg', metricField: 'totalAmount' },
      () => ({
        data: {
          data: {
            ok: true,
            collection: 'latticeOrders',
            chartType: 'pivot',
            series: [{ key: 'r1', label: 'r1', value: 20 }],
            summary: { count: 5, avg: 32, value: 32, op: 'avg', field: 'totalAmount' },
            pivotMatrix: {
              rowField: 'status',
              colField: 'region',
              rows: ['r1', 'r2'],
              columns: ['c1', 'c2'],
              cells: { r1: { c1: 15, c2: 30 }, r2: { c1: 40, c2: 60 } },
              rowTotals: { r1: 20, r2: 50 },
              colTotals: { c1: 23.3333333333, c2: 45 },
              grandTotal: 32,
            },
            totalRows: 5,
            meta: {},
          },
        },
      }),
    );
    const pivotTxt = textOf(findByTestId(resolved, 'dxos-bi-chart-pivot'));
    assert.ok(pivotTxt.includes('23,33'));
    assert.ok(pivotTxt.includes('32'));
    assert.equal(pivotTxt.includes('70'), false);
  }

  {
    const { resolved } = await renderWithProps(
      { chartType: 'pivot', groupBy: 'status', secondaryGroupBy: 'region', metricOp: 'min', metricField: 'totalAmount' },
      () => ({
        data: {
          data: {
            ok: true,
            collection: 'latticeOrders',
            chartType: 'pivot',
            series: [{ key: 'r1', label: 'r1', value: 0 }],
            summary: { count: 4, min: 15, value: 15, op: 'min', field: 'totalAmount' },
            pivotMatrix: {
              rowField: 'status',
              colField: 'region',
              rows: ['r1', 'r2'],
              columns: ['c1', 'c2'],
              cells: { r1: { c1: 0, c2: 20 }, r2: { c1: 40, c2: 30 } },
              rowTotals: { r1: 0, r2: 40 },
              colTotals: { c1: 0, c2: 30 },
              grandTotal: 0,
            },
            totalRows: 4,
            meta: {},
          },
        },
      }),
    );
    const pivotEl = findByTestId(resolved, 'dxos-bi-chart-pivot');
    const tfoot = collectNodes(pivotEl).find((n) => n.type === 'tfoot');
    const footerCells = collectNodes(tfoot).filter((n) => n.type === 'td');
    assert.equal(textOf(footerCells[footerCells.length - 1]), '0');
  }

  {
    const { resolved } = await renderWithProps(
      { chartType: 'pivot', groupBy: 'status', secondaryGroupBy: 'region', metricOp: 'max', metricField: 'totalAmount' },
      () => ({
        data: {
          data: {
            ok: true,
            collection: 'latticeOrders',
            chartType: 'pivot',
            series: [{ key: 'r2', label: 'r2', value: 60 }],
            summary: { count: 4, max: 60, value: 60, op: 'max', field: 'totalAmount' },
            pivotMatrix: {
              rowField: 'status',
              colField: 'region',
              rows: ['r1', 'r2'],
              columns: ['c1', 'c2'],
              cells: { r1: { c1: 20, c2: 30 }, r2: { c1: 40, c2: 60 } },
              rowTotals: { r1: 30, r2: 60 },
              colTotals: { c1: 40, c2: 60 },
              grandTotal: 60,
            },
            totalRows: 4,
            meta: {},
          },
        },
      }),
    );
    const pivotTxt = textOf(findByTestId(resolved, 'dxos-bi-chart-pivot'));
    assert.ok(pivotTxt.includes('60'));
    assert.equal(pivotTxt.includes('90'), false);
  }
});

test('BI Pivot validation guard prevents 400 on missing/duplicate secondaryGroupBy, auto-selects distinct field when available, and supports interactive viewer controls', async () => {
  const { createBiChartBlockView, resolvePivotSecondaryField, buildAggregateQueryPayload } = require(path.join(PLUGIN_ROOT, 'src/client/bi-chart-block.js'));

  assert.equal(resolvePivotSecondaryField('status', '', [{ value: 'status' }, { value: 'region' }]), 'region');
  assert.equal(resolvePivotSecondaryField('status', 'status', [{ value: 'status' }, { value: 'priority' }]), 'priority');
  assert.equal(resolvePivotSecondaryField('status', '', [{ value: 'status' }]), '');
  assert.equal(buildAggregateQueryPayload({ collection: 'latticeOrders', maxGroups: 75 }).limit, 75);

  // 1. Missing secondaryGroupBy & only 1 field in collectionsMeta -> zero aggregateQuery calls + inline Vietnamese prompt
  const hooks1 = createMiniHooks();
  const aggCalls1 = [];
  const api1 = {
    async request(req) {
      if (req.url === 'dxosBlocks:collectionsMeta') {
        return { data: { data: { collections: [{ name: 'latticeOrders', title: 'Đơn Logistics', fields: [{ name: 'status', type: 'string' }] }] } } };
      }
      if (req.url === 'dxosBlocks:aggregateQuery') {
        aggCalls1.push(req.data);
        return {
          data: {
            data: {
              ok: true,
              collection: req.data.collection,
              chartType: req.data.chartType,
              series: [{ key: 'draft', label: 'draft', value: 3, count: 3 }],
              summary: { count: 3, value: 3, op: 'count', field: null },
              pivotMatrix: null,
              totalRows: 3,
              meta: {},
            },
          },
        };
      }
      return { data: { data: [] } };
    },
  };
  const View1 = createBiChartBlockView({ useAPIClient: () => api1 }, hooks1.React, {}, {});
  let tree1 = hooks1.render(View1, { model: { props: { title: 'BI [D]', collection: 'latticeOrders', chartType: 'bar', groupBy: 'status', secondaryGroupBy: '' } } });
  await new Promise((r) => setTimeout(r, 20));
  tree1 = hooks1.render(View1, { model: { props: { title: 'BI [D]', collection: 'latticeOrders', chartType: 'bar', groupBy: 'status', secondaryGroupBy: '' } } });
  assert.equal(aggCalls1.length, 1);
  assert.equal(textOf(resolveTree(tree1)).includes('[D]'), false, 'Dev bracket tag [D] must be stripped from rendered BI title');
  assert.equal(findByTestId(resolveTree(tree1), 'dxos-bi-chart-block').props.style.paddingBottom, 56);

  // Switch to pivot via header button -> must NOT fire a guaranteed 400 request; shows inline prompt instead
  findByTestId(resolveTree(tree1), 'dxos-bi-mode-pivot').props.onClick();
  tree1 = hooks1.render(View1, { model: { props: { title: 'BI [D]', collection: 'latticeOrders', chartType: 'bar', groupBy: 'status', secondaryGroupBy: '' } } });
  await new Promise((r) => setTimeout(r, 20));
  tree1 = hooks1.render(View1, { model: { props: { title: 'BI [D]', collection: 'latticeOrders', chartType: 'bar', groupBy: 'status', secondaryGroupBy: '' } } });
  assert.equal(aggCalls1.length, 1, 'Switching to pivot without a second distinct field must NOT fire aggregateQuery');
  const promptEl = findByTestId(resolveTree(tree1), 'dxos-bi-chart-pivot-prompt');
  assert.ok(promptEl);
  assert.ok(textOf(promptEl).includes('Vui lòng chọn trường nhóm phụ (Cột Pivot) để xem bảng chéo.'));
  hooks1.unmount();

  // 2. Collection with multiple fields -> switching to pivot auto-selects distinct secondaryGroupBy, and viewer controls update queries interactively
  const hooks2 = createMiniHooks();
  const aggCalls2 = [];
  const api2 = {
    async request(req) {
      if (req.url === 'dxosBlocks:collectionsMeta') {
        return {
          data: {
            data: {
              collections: [
                {
                  name: 'latticeOrders',
                  title: 'Đơn Logistics',
                  fields: [
                    { name: 'status', type: 'string', title: 'Trạng thái' },
                    { name: 'region', type: 'string', title: 'Khu vực' },
                    { name: 'totalAmount', type: 'decimal', title: 'Giá trị' },
                  ],
                },
                {
                  name: 'latticeRequests',
                  title: 'Yêu cầu mua sắm',
                  fields: [
                    { name: 'status', type: 'string', title: 'Trạng thái' },
                    { name: 'priority', type: 'string', title: 'Độ ưu tiên' },
                    { name: 'estimatedCost', type: 'float', title: 'Chi phí dự kiến' },
                  ],
                },
              ],
            },
          },
        };
      }
      if (req.url === 'dxosBlocks:aggregateQuery') {
        aggCalls2.push(req.data);
        if (req.data.chartType === 'pivot') {
          return {
            data: {
              data: {
                ok: true,
                collection: req.data.collection,
                chartType: 'pivot',
                series: [{ key: 'draft', label: 'draft', value: 100 }],
                summary: { count: 1, value: 100, op: req.data.metric?.op || 'count' },
                pivotMatrix: {
                  rowField: req.data.groupBy,
                  colField: req.data.secondaryGroupBy,
                  rows: ['draft'],
                  columns: ['HCM'],
                  cells: { draft: { HCM: 100 } },
                  rowTotals: { draft: 100 },
                  colTotals: { HCM: 100 },
                  grandTotal: 100,
                },
                totalRows: 1,
                meta: {},
              },
            },
          };
        }
        return {
          data: {
            data: {
              ok: true,
              collection: req.data.collection,
              chartType: req.data.chartType,
              series: [{ key: 'draft', label: 'draft', value: 10, count: 10 }],
              summary: { count: 10, value: 10, op: req.data.metric?.op || 'count' },
              pivotMatrix: null,
              totalRows: 10,
              meta: {},
            },
          },
        };
      }
      return { data: { data: [] } };
    },
  };

  const View2 = createBiChartBlockView({ useAPIClient: () => api2 }, hooks2.React, {}, {});
  let tree2 = hooks2.render(View2, { model: { props: { collection: 'latticeOrders', chartType: 'bar', groupBy: 'status', secondaryGroupBy: '' } } });
  await new Promise((r) => setTimeout(r, 20));
  tree2 = hooks2.render(View2, { model: { props: { collection: 'latticeOrders', chartType: 'bar', groupBy: 'status', secondaryGroupBy: '' } } });

  const resolved2 = resolveTree(tree2);
  assert.ok(findByTestId(resolved2, 'dxos-bi-viewer-controls'));
  assert.ok(findByTestId(resolved2, 'dxos-bi-viewer-collection'));
  assert.ok(findByTestId(resolved2, 'dxos-bi-viewer-groupby'));
  assert.ok(findByTestId(resolved2, 'dxos-bi-viewer-metric-op'));

  // Switch chartType to pivot -> auto-selects region (distinct from status) and fires valid pivot query
  findByTestId(resolved2, 'dxos-bi-mode-pivot').props.onClick();
  tree2 = hooks2.render(View2, { model: { props: { collection: 'latticeOrders', chartType: 'bar', groupBy: 'status', secondaryGroupBy: '' } } });
  await new Promise((r) => setTimeout(r, 20));
  tree2 = hooks2.render(View2, { model: { props: { collection: 'latticeOrders', chartType: 'bar', groupBy: 'status', secondaryGroupBy: '' } } });
  const pivotQuery = aggCalls2.find((q) => q.chartType === 'pivot');
  assert.ok(pivotQuery, 'Pivot query must fire automatically when a distinct secondaryGroupBy exists');
  assert.equal(pivotQuery.groupBy, 'status');
  assert.equal(pivotQuery.secondaryGroupBy, 'region');
  assert.ok(findByTestId(resolveTree(tree2), 'dxos-bi-viewer-secondary-groupby'));

  // Change viewer metricOp to sum -> auto-selects totalAmount numeric field & renders numeric selector
  findByTestId(resolveTree(tree2), 'dxos-bi-viewer-metric-op').props.onChange({ target: { value: 'sum' } });
  tree2 = hooks2.render(View2, { model: { props: { collection: 'latticeOrders', chartType: 'bar', groupBy: 'status', secondaryGroupBy: '' } } });
  await new Promise((r) => setTimeout(r, 20));
  tree2 = hooks2.render(View2, { model: { props: { collection: 'latticeOrders', chartType: 'bar', groupBy: 'status', secondaryGroupBy: '' } } });
  assert.ok(findByTestId(resolveTree(tree2), 'dxos-bi-viewer-metric-field'));
  assert.ok(aggCalls2.some((q) => q.metric?.op === 'sum' && q.metric?.field === 'totalAmount'));

  // Change viewer collection to latticeRequests -> resets fields cleanly for new collection
  findByTestId(resolveTree(tree2), 'dxos-bi-viewer-collection').props.onChange({ target: { value: 'latticeRequests' } });
  tree2 = hooks2.render(View2, { model: { props: { collection: 'latticeOrders', chartType: 'bar', groupBy: 'status', secondaryGroupBy: '' } } });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(aggCalls2.some((q) => q.collection === 'latticeRequests' && q.metric?.field === 'estimatedCost'));
  hooks2.unmount();
});

test('Settings modal scroll CSS & DxosBiChartBlockModel limit/maxGroups input prevent top clipping and expose 1-500 bounds', () => {
  const { registerDxosBlockModels, DXOS_MODAL_SCROLL_CSS, ensureSettingsModalScrollStyle } = require(path.join(PLUGIN_ROOT, 'src/client/block-models.js'));
  const { React } = createMiniHooks();

  assert.ok(DXOS_MODAL_SCROLL_CSS.includes('max-height: 78vh'));
  assert.ok(DXOS_MODAL_SCROLL_CSS.includes('overflow-y: auto'));
  assert.ok(DXOS_MODAL_SCROLL_CSS.includes('top: 24px'));

  const origDoc = global.document;
  const appended = [];
  try {
    global.document = {
      head: { appendChild: (el) => appended.push(el) },
      getElementById: (id) => appended.find((el) => el.id === id) || null,
      createElement: (tag) => ({ tagName: tag, id: '', textContent: '' }),
    };
    assert.equal(ensureSettingsModalScrollStyle(), true);
    assert.equal(appended.length, 1);
    assert.equal(appended[0].id, 'dxos-block-settings-modal-style');
    assert.ok(appended[0].textContent.includes('78vh'));

    class MockBlockModel {
      constructor(opts = {}) { this.props = opts.props || {}; this.stepParams = opts.stepParams || {}; }
      setProps(next) { this.props = { ...this.props, ...next }; }
      getStepParams(f, s) { return this.stepParams?.[f]?.[s]; }
      static define(meta) { this.meta = meta; }
      static registerFlow(flow) { this.flows = [...(this.flows || []), flow]; }
    }

    const models = registerDxosBlockModels(
      { useAPIClient: () => null, useUIConfigurationPermissions: () => ({ allowAll: true }) },
      React,
      {},
      { BlockModel: MockBlockModel },
      { registerModels() {} },
      {},
    );
    const biStep = models.DxosBiChartBlockModel.flows.find((f) => f.key === 'dxosBlockSettings').steps.config;
    assert.equal(biStep.uiMode?.type, 'dialog');
    assert.equal(biStep.uiMode?.props?.style?.top, 24);
    assert.equal(biStep.uiMode?.props?.styles?.body?.maxHeight, '78vh');
    assert.equal(biStep.uiMode?.props?.styles?.body?.overflowY, 'auto');
    assert.equal(biStep.uiSchema.limit.title, 'Số nhóm tối đa (1-500)');
    assert.deepEqual(biStep.uiSchema.limit['x-component-props'], { min: 1, max: 500, step: 1, precision: 0, style: { width: '100%' } });
  } finally {
    global.document = origDoc;
  }
});

test('Status/Digital Twin Vietnamese label mappings, WMS action labels, empty-filter Twin access, bottom padding, and bracket tag stripping', async () => {
  const { getStatusMeta, formatStatusLabel, stripDevBracketTags, formatCompactIdentifier } = require(path.join(PLUGIN_ROOT, 'src/client/blocks-helpers.js'));
  const { createWmsOpsBlockView } = require(path.join(PLUGIN_ROOT, 'src/client/wms-ops-block.js'));
  const { createWebGisBlockView, TWIN_DEFROST_OPTIONS, TWIN_FAN_OPTIONS, TWIN_DOOR_OPTIONS } = require(path.join(PLUGIN_ROOT, 'src/client/webgis-block.js'));
  const { createKanbanScheduleBlockView } = require(path.join(PLUGIN_ROOT, 'src/client/kanban-schedule-block.js'));

  const expectedStatusPairs = [
    ['draft', 'Bản nháp'],
    ['submitted', 'Đã gửi'],
    ['hold_mkt', 'Tạm giữ MKT'],
    ['proposed', 'Đề xuất AI'],
    ['manager_approval', 'Chờ quản lý duyệt'],
    ['synced', 'Đã đồng bộ'],
    ['open', 'Đang mở'],
    ['pending', 'Chờ xử lý'],
    ['critical', 'Nghiêm trọng'],
    ['high', 'Cao'],
    ['medium', 'Trung bình'],
    ['low', 'Thấp'],
    ['approved', 'Đã duyệt'],
    ['rejected', 'Từ chối'],
    ['completed', 'Hoàn tất'],
    ['issued', 'Đã xuất kho'],
  ];
  for (const [raw, vi] of expectedStatusPairs) {
    assert.equal(formatStatusLabel(raw), vi, `Status ${raw} must map to "${vi}"`);
    assert.ok(getStatusMeta(raw).bg && getStatusMeta(raw).color);
  }

  assert.equal(stripDevBracketTags('Phân tích & Biểu đồ BI [D]'), 'Phân tích & Biểu đồ BI');
  assert.equal(stripDevBracketTags('Hộp việc Quy trình Poka-yoke [P]'), 'Hộp việc Quy trình Poka-yoke');
  assert.equal(stripDevBracketTags('Vận hành Kho FEFO [W]'), 'Vận hành Kho FEFO');
  assert.equal(stripDevBracketTags('Kho tri thức P.A.R.A. [H]'), 'Kho tri thức P.A.R.A.');
  assert.equal(stripDevBracketTags('Đề xuất AI & Bằng chứng [I]'), 'Đề xuất AI & Bằng chứng');
  assert.equal(formatCompactIdentifier('urn:ngsi-ld:Asset:org-a:native:12'), 'Asset:org-a:#12');

  // Verify Digital Twin enum option labels map to Vietnamese while preserving canonical backend values
  assert.deepEqual(TWIN_DEFROST_OPTIONS, [
    { value: 'auto', label: 'Tự động' },
    { value: 'manual', label: 'Thủ công' },
    { value: 'off', label: 'Tắt' },
  ]);
  assert.deepEqual(TWIN_FAN_OPTIONS, [
    { value: 'auto', label: 'Tự động' },
    { value: 'high', label: 'Cao' },
    { value: 'low', label: 'Thấp' },
    { value: 'eco', label: 'Tiết kiệm (Eco)' },
  ]);
  assert.deepEqual(TWIN_DOOR_OPTIONS, [
    { value: 'locked', label: 'Đã khóa' },
    { value: 'unlocked', label: 'Mở khóa' },
  ]);

  // WMS Ops: no raw issueStock in label, Vietnamese lot status badge, safe bottom padding
  const wmsHooks = createMiniHooks();
  const wmsApi = {
    async request(req) {
      if (req.url === 'dxosWms:lots') {
        return { data: { data: { items: [{ id: 1, lotCode: 'LOT-01', sku: 'VAC-1', qtyAvailable: 10, status: 'hold_mkt' }] } } };
      }
      return { data: { data: {} } };
    },
  };
  const WmsView = createWmsOpsBlockView({ useAPIClient: () => wmsApi }, wmsHooks.React, {}, {});
  let wmsTree = wmsHooks.render(WmsView, { model: { props: { title: 'Vận hành Kho [W]' } } });
  await new Promise((r) => setTimeout(r, 15));
  wmsTree = wmsHooks.render(WmsView, { model: { props: { title: 'Vận hành Kho [W]' } } });
  const wmsResolved = resolveTree(wmsTree);
  const wmsDump = textOf(wmsResolved);
  assert.equal(wmsDump.includes('issueStock'), false, 'WMS block must not leak camelCase issueStock');
  assert.equal(wmsDump.includes('[W]'), false, 'WMS block must strip [W] dev tag');
  assert.ok(wmsDump.includes('2. Xuất kho thực tế (FEFO)'));
  assert.ok(wmsDump.includes('Tạm giữ MKT'));
  assert.equal(findByTestId(wmsResolved, 'dxos-wms-ops-block').props.style.paddingBottom, 56);
  wmsHooks.unmount();

  // Kanban bottom padding & stripped [H] tag
  const kbHooks = createMiniHooks();
  const KbView = createKanbanScheduleBlockView({ useAPIClient: () => null }, kbHooks.React, {}, {});
  const kbTree = resolveTree(kbHooks.render(KbView, { model: { props: { title: 'Bảng Kanban [H]' } } }));
  assert.equal(textOf(kbTree).includes('[H]'), false);
  assert.equal(findByTestId(kbTree, 'dxos-kanban-schedule-block').props.style.paddingBottom, 56);
  kbHooks.unmount();

  // WebGIS: Digital Twin control card remains accessible when alarms filter matches 0 points, and submits canonical enum values
  const gisHooks = createMiniHooks();
  const gisCalls = [];
  const gisApi = {
    async request(req) {
      gisCalls.push(req);
      if (req.url === 'latticeAssets:list') {
        return { data: { data: [{ id: 30, code: 'COLD-30', name: 'Kho Cần Thơ 30', kind: 'cold_room', status: 'active', temperatureC: -18, targetTempC: -18, organizationId: 'org-a' }] } };
      }
      if (req.url === 'latticeLocations:list' || req.url === 'latticeIncidentCases:list') {
        return { data: { data: [] } };
      }
      if (req.url === 'dxosBlocks:twinShadow') {
        return { data: { data: { shadow: { assetId: 30, commandStatus: 'synced', desiredJson: { targetTempC: -18, defrostMode: 'auto', fanMode: 'auto', doorLock: 'locked' }, reportedJson: { targetTempC: -18 } } } } };
      }
      if (req.url === 'dxosBlocks:twinSetDesired') {
        return { data: { data: { commandId: 'cmd-30', shadow: { assetId: 30, commandStatus: 'dispatched', desiredJson: req.data.desiredPatch, reportedJson: { targetTempC: -18 } } } } };
      }
      return { data: { data: [] } };
    },
  };
  const GisView = createWebGisBlockView({ useAPIClient: () => gisApi }, gisHooks.React, {}, {});
  let gisTree = gisHooks.render(GisView, { model: { props: { title: 'WebGIS [D]', showTwinOverlay: true } } });
  await new Promise((r) => setTimeout(r, 20));
  gisTree = gisHooks.render(GisView, { model: { props: { title: 'WebGIS [D]', showTwinOverlay: true } } });
  assert.equal(findByTestId(resolveTree(gisTree), 'dxos-webgis-block').props.style.paddingBottom, 56);
  assert.equal(textOf(resolveTree(gisTree)).includes('[D]'), false);
  assert.ok(textOf(findByTestId(resolveTree(gisTree), 'dxos-webgis-urn-badge')).includes('Asset:org-a:#30'));

  // Filter to Cảnh báo Chuỗi lạnh -> 0 matching map pins, yet Digital Twin card & button remain accessible!
  findByTestId(resolveTree(gisTree), 'dxos-webgis-filter-alarms').props.onClick();
  gisTree = gisHooks.render(GisView, { model: { props: { title: 'WebGIS [D]', showTwinOverlay: true } } });
  const emptyFiltered = resolveTree(gisTree);
  assert.equal(collectNodes(emptyFiltered).filter((n) => n.props?.['data-testid'] === 'dxos-webgis-pin').length, 0);
  assert.ok(findByTestId(emptyFiltered, 'dxos-webgis-filter-empty-notice'));
  assert.ok(findByTestId(emptyFiltered, 'dxos-webgis-twin-fallback-card'));
  assert.ok(findByTestId(emptyFiltered, 'dxos-webgis-open-twin-drawer-btn'));

  // Open Digital Twin drawer while filtered to 0 map pins, change selects, and submit canonical enum values
  findByTestId(emptyFiltered, 'dxos-webgis-open-twin-drawer-btn').props.onClick();
  gisTree = gisHooks.render(GisView, { model: { props: { title: 'WebGIS [D]', showTwinOverlay: true } } });
  const drawerTree = resolveTree(gisTree);
  assert.ok(findByTestId(drawerTree, 'dxos-webgis-twin-drawer'));
  assert.ok(textOf(findByTestId(drawerTree, 'dxos-twin-fan-select')).includes('Tiết kiệm (Eco)'));
  assert.ok(textOf(findByTestId(drawerTree, 'dxos-twin-door-select')).includes('Mở khóa'));

  findByTestId(drawerTree, 'dxos-twin-defrost-select').props.onChange({ target: { value: 'manual' } });
  findByTestId(drawerTree, 'dxos-twin-fan-select').props.onChange({ target: { value: 'eco' } });
  findByTestId(drawerTree, 'dxos-twin-door-select').props.onChange({ target: { value: 'unlocked' } });
  gisTree = gisHooks.render(GisView, { model: { props: { title: 'WebGIS [D]', showTwinOverlay: true } } });
  await findByTestId(resolveTree(gisTree), 'dxos-twin-submit-btn').props.onClick();
  const twinCall = gisCalls.find((c) => c.url === 'dxosBlocks:twinSetDesired');
  assert.ok(twinCall);
  assert.deepEqual(twinCall.data.desiredPatch, {
    targetTempC: -18,
    defrostMode: 'manual',
    fanMode: 'eco',
    doorLock: 'unlocked',
  });
  gisHooks.unmount();
});
