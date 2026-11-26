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

test('M2-1a: block-models configures uiMode dialog mounted on document.body without ignored modalProps', () => {
  const { registerDxosBlockModels } = require(path.join(PLUGIN_ROOT, 'src/client/block-models.js'));
  const { React } = createMiniHooks();

  const origDoc = global.document;
  const fakeBody = { nodeName: 'BODY' };
  const appended = [];
  try {
    global.document = {
      body: fakeBody,
      head: { appendChild: (el) => appended.push(el) },
      getElementById: (id) => appended.find((el) => el.id === id) || null,
      createElement: (tag) => ({ tagName: tag, id: '', textContent: '' }),
    };

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

    const modelList = Object.values(models);
    assert.equal(modelList.length, 12);
    for (const ModelClass of modelList) {
      const step = ModelClass.flows.find((f) => f.key === 'dxosBlockSettings').steps.config;
      assert.equal(step.modalProps, undefined, `${ModelClass.name} must not use ignored modalProps`);
      assert.equal(step.uiMode?.type, 'dialog', `${ModelClass.name} must use uiMode dialog`);
      assert.equal(step.uiMode?.props?.getContainer?.(), fakeBody, `${ModelClass.name} dialog must mount to document.body`);
      assert.equal(step.uiMode?.props?.style?.top, 24);
      assert.equal(step.uiMode?.props?.styles?.body?.maxHeight, '78vh');
      assert.equal(step.uiMode?.props?.styles?.body?.overflowY, 'auto');
    }
  } finally {
    global.document = origDoc;
  }
});

test('M2-1b: BiChartBlock formats numbers in vi-VN, wires inline limit selector, and supports click-to-drilldown including (Trống)', async () => {
  const { createBiChartBlockView, formatMetricNumber } = require(path.join(PLUGIN_ROOT, 'src/client/bi-chart-block.js'));
  assert.equal(typeof formatMetricNumber, 'function');
  assert.equal(formatMetricNumber(1234.5), (1234.5).toLocaleString('vi-VN', { maximumFractionDigits: 2 }));
  assert.equal(formatMetricNumber(12345), (12345).toLocaleString('vi-VN'));

  const hooks = createMiniHooks();
  const requests = [];
  const api = {
    async request(req) {
      requests.push(req);
      if (req.url === 'dxosBlocks:aggregateQuery') {
        if (req.data.chartType === 'pivot') {
          return {
            data: {
              data: {
                collection: 'latticeOrders',
                chartType: 'pivot',
                groupBy: 'status',
                secondaryGroupBy: 'region',
                metric: { op: 'count', field: '' },
                totalRows: 3,
                pivotMatrix: {
                  rowField: 'status',
                  colField: 'region',
                  rows: ['draft', '(Trống)'],
                  columns: ['can-tho'],
                  cells: { draft: { 'can-tho': 2 }, '(Trống)': { 'can-tho': 1 } },
                  rowTotals: { draft: 2, '(Trống)': 1 },
                  colTotals: { 'can-tho': 3 },
                  grandTotal: 3,
                },
              },
            },
          };
        }
        return {
          data: {
            data: {
              collection: 'latticeOrders',
              chartType: 'bar',
              groupBy: 'status',
              metric: { op: 'sum', field: 'totalAmount' },
              totalRows: 4,
              summary: { count: 4, value: 12345.67 },
              series: [
                { key: 'draft', label: 'draft', value: 10000, count: 2 },
                { key: '(Trống)', label: '(Trống)', value: 2345.67, count: 2 },
              ],
            },
          },
        };
      }
      if (req.url === 'latticeOrders:list') {
        return {
          data: {
            data: [
              { id: 41, code: 'ORD-041', name: 'Đơn drilldown 1', status: 'draft', createdAt: '2026-11-25T10:00:00Z' },
            ],
          },
        };
      }
      return { data: { data: [] } };
    },
  };

  const View = createBiChartBlockView({ useAPIClient: () => api }, hooks.React, {}, {});
  let tree = hooks.render(View, {
    model: { props: { collection: 'latticeOrders', chartType: 'bar', groupBy: 'status', metricOp: 'sum', metricField: 'totalAmount', limit: 20 } },
  });
  await new Promise((r) => setTimeout(r, 20));
  tree = hooks.render(View, {
    model: { props: { collection: 'latticeOrders', chartType: 'bar', groupBy: 'status', metricOp: 'sum', metricField: 'totalAmount', limit: 20 } },
  });

  const resolved = resolveTree(tree);
  const limitSelect = findByTestId(resolved, 'dxos-bi-viewer-limit');
  assert.ok(limitSelect, 'Inline limit selector must be rendered inside BI viewer controls');
  limitSelect.props.onChange({ target: { value: '50' } });
  tree = hooks.render(View, {
    model: { props: { collection: 'latticeOrders', chartType: 'bar', groupBy: 'status', metricOp: 'sum', metricField: 'totalAmount', limit: 20 } },
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(requests.some((r) => r.url === 'dxosBlocks:aggregateQuery' && r.data.limit === 50), 'Changing inline limit must requery with limit=50');

  // Click bar item for (Trống) -> triggers latticeOrders:list with $or null/empty filter and opens drilldown panel
  tree = hooks.render(View, {
    model: { props: { collection: 'latticeOrders', chartType: 'bar', groupBy: 'status', metricOp: 'sum', metricField: 'totalAmount', limit: 20 } },
  });
  const bars = collectNodes(resolveTree(tree)).filter((n) => n.props?.['data-testid'] === 'dxos-bi-bar-item');
  assert.equal(bars.length, 2);
  assert.equal(typeof bars[1].props.onClick, 'function', 'Bar items must have click-to-drilldown handler');
  await bars[1].props.onClick();
  tree = hooks.render(View, {
    model: { props: { collection: 'latticeOrders', chartType: 'bar', groupBy: 'status', metricOp: 'sum', metricField: 'totalAmount', limit: 20 } },
  });
  const drillCall = requests.find((r) => r.url === 'latticeOrders:list');
  assert.ok(drillCall, 'Bar click must query collection:list');
  assert.equal(typeof drillCall.params.filter, 'string');
  assert.deepEqual(JSON.parse(drillCall.params.filter), { $or: [{ status: null }, { status: '' }] });
  const drillPanel = findByTestId(resolveTree(tree), 'dxos-bi-drilldown-panel');
  assert.ok(drillPanel, 'Drilldown panel must appear after bar click');
  assert.ok(textOf(drillPanel).includes('ORD-041'));

  // Close drilldown panel
  findByTestId(resolveTree(tree), 'dxos-bi-drilldown-close').props.onClick();
  tree = hooks.render(View, {
    model: { props: { collection: 'latticeOrders', chartType: 'bar', groupBy: 'status', metricOp: 'sum', metricField: 'totalAmount', limit: 20 } },
  });
  assert.equal(findByTestId(resolveTree(tree), 'dxos-bi-drilldown-panel'), null);

  // Switch to pivot mode and click cell ('(Trống)', 'can-tho') -> combines both row & col filters
  findByTestId(resolveTree(tree), 'dxos-bi-mode-pivot').props.onClick();
  tree = hooks.render(View, {
    model: { props: { collection: 'latticeOrders', chartType: 'bar', groupBy: 'status', secondaryGroupBy: 'region', metricOp: 'count', limit: 20 } },
  });
  await new Promise((r) => setTimeout(r, 20));
  tree = hooks.render(View, {
    model: { props: { collection: 'latticeOrders', chartType: 'bar', groupBy: 'status', secondaryGroupBy: 'region', metricOp: 'count', limit: 20 } },
  });
  const pivotCells = collectNodes(resolveTree(tree)).filter((n) => n.props?.['data-testid'] === 'dxos-bi-pivot-cell');
  assert.equal(pivotCells.length, 2);
  await pivotCells[1].props.onClick();
  tree = hooks.render(View, {
    model: { props: { collection: 'latticeOrders', chartType: 'bar', groupBy: 'status', secondaryGroupBy: 'region', metricOp: 'count', limit: 20 } },
  });
  const listCalls = requests.filter((r) => r.url === 'latticeOrders:list');
  const pivotListCall = listCalls[listCalls.length - 1];
  assert.equal(typeof pivotListCall.params.filter, 'string');
  assert.deepEqual(JSON.parse(pivotListCall.params.filter), {
    $and: [
      { $or: [{ status: null }, { status: '' }] },
      { region: 'can-tho' },
    ],
  });
  hooks.unmount();
});

test('M2-2: WmsOpsBlock reads stepParams config, prevents invalid 400 calls, renders dryRun errors table, and provides lots datalists/quick-select', async () => {
  const { createWmsOpsBlockView } = require(path.join(PLUGIN_ROOT, 'src/client/wms-ops-block.js'));
  const hooks = createMiniHooks();
  const calls = [];
  const api = {
    async request(req) {
      calls.push(req);
      if (req.url === 'dxosWms:lots') {
        return {
          data: {
            data: {
              items: [
                { id: 1, lotCode: 'LOT-CT-01', sku: 'VAC-01', productName: 'Vaccine A', qtyAvailable: 50, status: 'available' },
              ],
            },
          },
        };
      }
      if (req.url === 'dxosBlocks:bulkImportDryRun') {
        return {
          data: {
            data: {
              previewToken: 'tok-1',
              payloadSha256: 'abc123',
              collection: 'latticeStockLots',
              totalRows: 2,
              validCount: 0,
              invalidCount: 2,
              errors: [
                { row: 2, code: 'REQUIRED_FIELD', message: 'Thiếu sku' },
                { row: 3, code: 'INVALID_QTY', message: 'qtyOnHand phải >= 0' },
              ],
            },
          },
        };
      }
      return { data: { data: {} } };
    },
  };

  const model = {
    props: {},
    stepParams: { dxosBlockSettings: { config: { defaultTab: 'fefo', defaultImportCollection: 'latticeOrders', showBulkImport: true } } },
    getStepParams(f, s) { return this.stepParams?.[f]?.[s]; },
  };
  const View = createWmsOpsBlockView({ useAPIClient: () => api }, hooks.React, {}, {});
  let tree = hooks.render(View, { model });
  await new Promise((r) => setTimeout(r, 20));
  tree = hooks.render(View, { model });
  const resolved = resolveTree(tree);

  // Datalists & quick-select populated from loaded lots
  const skuDatalist = findByTestId(resolved, 'dxos-wms-sku-datalist');
  const lotDatalist = findByTestId(resolved, 'dxos-wms-lot-datalist');
  const quickSelect = findByTestId(resolved, 'dxos-wms-lot-quickselect');
  assert.ok(skuDatalist && textOf(skuDatalist).includes('VAC-01') || JSON.stringify(skuDatalist).includes('VAC-01'));
  assert.ok(lotDatalist && JSON.stringify(lotDatalist).includes('LOT-CT-01'));
  assert.ok(quickSelect);
  quickSelect.props.onChange({ target: { value: 'LOT-CT-01' } });
  tree = hooks.render(View, { model });
  assert.equal(findByTestId(resolveTree(tree), 'dxos-wms-ops-fefo-sku').props.value, 'VAC-01');
  assert.equal(findByTestId(resolveTree(tree), 'dxos-wms-ops-issue-lot').props.value, 'LOT-CT-01');
  assert.equal(findByTestId(resolveTree(tree), 'dxos-wms-ops-mkt-lot').props.value, 'LOT-CT-01');
  findByTestId(resolveTree(tree), 'dxos-wms-ops-fefo-sku').props.onChange({ target: { value: '' } });
  findByTestId(resolveTree(tree), 'dxos-wms-ops-issue-lot').props.onChange({ target: { value: '' } });
  findByTestId(resolveTree(tree), 'dxos-wms-ops-mkt-lot').props.onChange({ target: { value: '' } });
  tree = hooks.render(View, { model });

  // Empty FEFO SKU / Issue Lot / MKT Lot must NOT fire API requests
  const beforeActionCount = calls.length;
  await findByTestId(resolved, 'dxos-wms-ops-fefo-form').props.onSubmit({ preventDefault() {} });
  tree = hooks.render(View, { model });
  assert.equal(calls.length, beforeActionCount, 'Empty FEFO SKU must not fire HTTP 400 request');
  assert.equal(findByTestId(resolveTree(tree), 'dxos-wms-ops-feedback').props.role, 'alert');

  await findByTestId(resolveTree(tree), 'dxos-wms-ops-issue-form').props.onSubmit({ preventDefault() {} });
  tree = hooks.render(View, { model });
  assert.equal(calls.length, beforeActionCount, 'Empty Issue Lot must not fire HTTP 400 request');

  await findByTestId(resolveTree(tree), 'dxos-wms-ops-mkt-form').props.onSubmit({ preventDefault() {} });
  tree = hooks.render(View, { model });
  assert.equal(calls.length, beforeActionCount, 'Empty MKT Lot must not fire HTTP 400 request');

  // Switch to import tab: verify defaultImportCollection synced from stepParams, empty dry-run blocked, row errors rendered
  findByTestId(resolveTree(tree), 'dxos-wms-ops-tab-import').props.onClick();
  tree = hooks.render(View, { model });
  assert.equal(findByTestId(resolveTree(tree), 'dxos-wms-ops-import-collection').props.value, 'latticeOrders');

  await findByTestId(resolveTree(tree), 'dxos-wms-ops-import-dryrun-btn').props.onClick();
  tree = hooks.render(View, { model });
  assert.equal(calls.filter((c) => c.url === 'dxosBlocks:bulkImportDryRun').length, 0, 'Empty bulk import must not fire dryRun 400');

  findByTestId(resolveTree(tree), 'dxos-wms-ops-import-content').props.onChange({ target: { value: 'lotCode,sku\nL1,' } });
  tree = hooks.render(View, { model });
  await findByTestId(resolveTree(tree), 'dxos-wms-ops-import-dryrun-btn').props.onClick();
  tree = hooks.render(View, { model });
  const errTable = findByTestId(resolveTree(tree), 'dxos-wms-ops-import-errors');
  assert.ok(errTable, 'dryRunResult.errors table must render when invalid rows exist');
  assert.ok(textOf(errTable).includes('REQUIRED_FIELD'));
  assert.ok(textOf(errTable).includes('Thiếu sku'));
  assert.equal(findByTestId(resolveTree(tree), 'dxos-wms-ops-import-commit-btn').props.disabled, true, 'Commit must remain disabled when validCount === 0');
  hooks.unmount();
});

test('M2-3a: KanbanScheduleBlock uses Asia/Ho_Chi_Minh dates, opens detail drawer on card click, and shows Approval CTA on gated voucher drop', async () => {
  const { buildScheduleDaysGrid, createKanbanScheduleBlockView } = require(path.join(PLUGIN_ROOT, 'src/client/kanban-schedule-block.js'));

  // 2026-11-25T18:30:00Z is 2026-11-26 01:30:00 in Asia/Ho_Chi_Minh (Thursday)
  const grid = buildScheduleDaysGrid([
    { id: 1, code: 'ORD-VN-NIGHT', submittedAt: '2026-11-25T18:30:00Z' },
  ], '2026-11-25');
  assert.equal(grid.days[3].dateKey, '2026-11-26');
  assert.equal(grid.days[3].items.length, 1);
  assert.equal(grid.days[3].items[0].code, 'ORD-VN-NIGHT');

  const hooks = createMiniHooks();
  const navigated = [];
  const clickedRecords = [];
  const api = {
    async request(req) {
      if (req.url === 'latticeOrders:list') {
        return {
          data: {
            data: [
              { id: 11, code: 'ORD-11', name: 'Đơn kiểm tra', status: 'submitted', version: 1, submittedAt: '2026-11-25T18:30:00Z' },
            ],
          },
        };
      }
      return { data: { data: [] } };
    },
  };

  const View = createKanbanScheduleBlockView(
    { useAPIClient: () => api },
    hooks.React,
    {},
    { router: { navigate: (p) => navigated.push(p) } },
  );
  let tree = hooks.render(View, {
    model: {
      props: {
        collection: 'latticeOrders',
        viewMode: 'kanban',
        onRecordClick: (rec, col) => clickedRecords.push({ id: rec.id, col }),
      },
    },
  });
  await new Promise((r) => setTimeout(r, 20));
  tree = hooks.render(View, {
    model: {
      props: {
        collection: 'latticeOrders',
        viewMode: 'kanban',
        onRecordClick: (rec, col) => clickedRecords.push({ id: rec.id, col }),
      },
    },
  });

  // Card click opens detail drawer + triggers cfg.onRecordClick
  const card = findByTestId(resolveTree(tree), 'dxos-kanban-card-11');
  assert.ok(card);
  assert.equal(typeof card.props.onClick, 'function');
  card.props.onClick();
  tree = hooks.render(View, {
    model: {
      props: {
        collection: 'latticeOrders',
        viewMode: 'kanban',
        onRecordClick: (rec, col) => clickedRecords.push({ id: rec.id, col }),
      },
    },
  });
  assert.equal(clickedRecords.length, 1);
  const drawer = findByTestId(resolveTree(tree), 'dxos-kanban-detail-drawer');
  assert.ok(drawer, 'Clicking Kanban card must open inline detail drawer');
  assert.ok(textOf(drawer).includes('ORD-11'));

  // Gated drop on approved column shows "Mở Hộp Phê duyệt" CTA navigating to /admin/lattice-workspace
  const approvedCol = collectNodes(resolveTree(tree)).find(
    (n) => n.props?.['data-testid'] === 'dxos-kanban-column' && n.props?.['data-stage'] === 'approved',
  );
  assert.ok(approvedCol);
  await approvedCol.props.onDrop({
    preventDefault() {},
    dataTransfer: { getData: () => '11' },
  });
  tree = hooks.render(View, {
    model: {
      props: {
        collection: 'latticeOrders',
        viewMode: 'kanban',
        onRecordClick: (rec, col) => clickedRecords.push({ id: rec.id, col }),
      },
    },
  });
  const cta = findByTestId(resolveTree(tree), 'dxos-kanban-approval-cta');
  assert.ok(cta, 'Gated voucher drop must display actionable Mở Hộp Phê duyệt CTA');
  cta.props.onClick();
  assert.deepEqual(navigated, ['/admin/lattice-workspace']);
  hooks.unmount();
});

test('M2-3b: ChatterPanel surfaces loadError with retry and formats vi-VN timestamps', async () => {
  const { createRecordChatterView } = require(path.join(PLUGIN_ROOT, 'src/client/chatter-panel.js'));
  const hooks = createMiniHooks();
  let attempt = 0;
  const api = {
    async request() {
      attempt += 1;
      if (attempt === 1) {
        const err = new Error('Forbidden');
        err.response = { data: { errors: [{ message: 'Không có quyền xem Chatter.' }] } };
        throw err;
      }
      return {
        data: {
          data: {
            items: [
              { id: 1, entryType: 'comment', authorName: 'minh', body: 'Đã kiểm tra', createdAt: '2026-11-25T18:30:00Z' },
            ],
          },
        },
      };
    },
  };

  const View = createRecordChatterView({ useAPIClient: () => api }, hooks.React, {});
  let tree = hooks.render(View, { targetCollection: 'latticeOrders', targetRecordId: 7 });
  await new Promise((r) => setTimeout(r, 20));
  tree = hooks.render(View, { targetCollection: 'latticeOrders', targetRecordId: 7 });

  const resolvedErr = resolveTree(tree);
  const errBox = findByTestId(resolvedErr, 'dxos-chatter-load-error');
  assert.ok(errBox, 'ChatterPanel must show dxos-chatter-load-error when initial load fails');
  assert.ok(textOf(errBox).includes('Không có quyền xem Chatter.'));
  assert.equal(textOf(resolvedErr).includes('Chưa có ghi nhận Chatter nào.'), false, 'Empty text must be suppressed on load error');

  await findByTestId(resolvedErr, 'dxos-chatter-retry-btn').props.onClick();
  tree = hooks.render(View, { targetCollection: 'latticeOrders', targetRecordId: 7 });
  const resolvedOk = resolveTree(tree);
  assert.equal(findByTestId(resolvedOk, 'dxos-chatter-load-error'), null);
  const dump = textOf(resolvedOk);
  assert.ok(dump.includes('26/11/2026') || dump.includes('26/11'), `Expected vi-VN Asia/Ho_Chi_Minh date for 2026-11-25T18:30:00Z, got: ${dump}`);
  hooks.unmount();
});

test('M2-3c: CreativeStudioBlock surfaces per-query errors with retry button instead of silent zero', async () => {
  const { createCreativeStudioView } = require(path.join(PLUGIN_ROOT, 'src/client/creative-studio-block.js'));
  const hooks = createMiniHooks();
  let failOnce = true;
  const api = {
    async request() {
      if (failOnce) {
        const err = new Error('Server 500');
        err.response = { data: { errors: [{ message: 'Lỗi tải dữ liệu đơn hàng' }] } };
        throw err;
      }
      return { data: { data: [{ id: 1, status: 'draft' }], meta: { count: 1 } } };
    },
  };

  const blueprintJson = JSON.stringify({
    title: 'Studio Test',
    queries: [{ id: 'orders', collection: 'latticeOrders', limit: 10 }],
    widgets: [{ type: 'gauge', title: 'Tổng đơn', queryId: 'orders', metric: 'count' }],
  });

  const View = createCreativeStudioView({ useAPIClient: () => api }, hooks.React, {}, {});
  let tree = hooks.render(View, { model: { props: { blueprintJson } } });
  await new Promise((r) => setTimeout(r, 20));
  tree = hooks.render(View, { model: { props: { blueprintJson } } });

  const resolvedErr = resolveTree(tree);
  const errBanner = findByTestId(resolvedErr, 'dxos-creative-query-error');
  assert.ok(errBanner, 'CreativeStudioBlock must render visible query error banner');
  assert.ok(textOf(errBanner).includes('orders'));

  failOnce = false;
  await findByTestId(resolvedErr, 'dxos-creative-retry-btn').props.onClick();
  tree = hooks.render(View, { model: { props: { blueprintJson } } });
  assert.equal(findByTestId(resolveTree(tree), 'dxos-creative-query-error'), null);
  hooks.unmount();
});

test('M2-3d: WebGisBlock Digital Twin button focuses/scrolls drawer and renders inline guidance when no IoT asset has assetId', async () => {
  const { createWebGisBlockView } = require(path.join(PLUGIN_ROOT, 'src/client/webgis-block.js'));
  const hooks = createMiniHooks();
  const api = {
    async request(req) {
      if (req.url === 'latticeAssets:list') {
        return { data: { data: [{ id: 30, code: 'COLD-30', name: 'Kho Cần Thơ', kind: 'cold_room', status: 'active', temperatureC: -18, targetTempC: -18 }] } };
      }
      return { data: { data: [] } };
    },
  };

  const View = createWebGisBlockView({ useAPIClient: () => api }, hooks.React, {}, {});
  let tree = hooks.render(View, { model: { props: { showTwinOverlay: true } } });
  await new Promise((r) => setTimeout(r, 20));
  tree = hooks.render(View, { model: { props: { showTwinOverlay: true } } });

  let scrolled = false;
  let focused = false;
  const openBtn = findByTestId(resolveTree(tree), 'dxos-webgis-open-twin-drawer-btn');
  assert.ok(openBtn);
  openBtn.props.onClick();
  tree = hooks.render(View, { model: { props: { showTwinOverlay: true } } });
  const drawer = findByTestId(resolveTree(tree), 'dxos-webgis-twin-drawer');
  assert.ok(drawer);
  assert.equal(typeof drawer.props.ref, 'function', 'Digital Twin drawer must attach a DOM ref for scrollIntoView/focus');
  drawer.props.ref({
    scrollIntoView: () => { scrolled = true; },
    focus: () => { focused = true; },
  });
  // Click button again while drawer is already open -> triggers scrollIntoView/focus on ref
  findByTestId(resolveTree(tree), 'dxos-webgis-open-twin-drawer-btn').props.onClick();
  tree = hooks.render(View, { model: { props: { showTwinOverlay: true } } });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(scrolled, true, 'Clicking Digital Twin control must scroll drawer into view');
  assert.equal(focused, true, 'Clicking Digital Twin control must focus drawer');
  hooks.unmount();

  // Custom collection with no assetId markers -> renders inline guidance
  const hooks2 = createMiniHooks();
  const api2 = {
    async request(req) {
      if (req.url === 'latticeCustomFleet:list') {
        return { data: { data: [{ id: 1, name: 'Xe 01', lat: 10.04, lng: 105.74, status: 'active' }] } };
      }
      return { data: { data: [] } };
    },
  };
  const View2 = createWebGisBlockView({ useAPIClient: () => api2 }, hooks2.React, {}, {});
  let tree2 = hooks2.render(View2, { model: { props: { collection: 'latticeCustomFleet', showTwinOverlay: true } } });
  await new Promise((r) => setTimeout(r, 20));
  tree2 = hooks2.render(View2, { model: { props: { collection: 'latticeCustomFleet', showTwinOverlay: true } } });
  assert.ok(findByTestId(resolveTree(tree2), 'dxos-webgis-twin-guidance'), 'Must render inline guidance when no IoT assetId is available');
  hooks2.unmount();
});

test('M2-R2: BiChartBlock buildDrilldownFilter uses null-only filter for non-string (Trống) columns while keeping string null-or-empty filter', async () => {
  const { buildDrilldownFilter, createBiChartBlockView } = require(path.join(PLUGIN_ROOT, 'src/client/bi-chart-block.js'));

  assert.deepEqual(
    buildDrilldownFilter(null, [{ field: 'status', value: '(Trống)' }]),
    { $or: [{ status: null }, { status: '' }] },
  );
  assert.deepEqual(
    buildDrilldownFilter(null, [{ field: 'totalAmount', value: '(Trống)' }], { totalAmount: 'decimal' }),
    { totalAmount: null },
  );
  assert.deepEqual(
    buildDrilldownFilter(null, [{ field: 'createdAt', value: '(Trống)' }]),
    { createdAt: null },
  );
  assert.deepEqual(
    buildDrilldownFilter(null, [{ field: 'departmentId', value: '(Trống)' }]),
    { departmentId: null },
  );

  const hooks = createMiniHooks();
  const requests = [];
  const api = {
    async request(req) {
      requests.push(req);
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
                    { name: 'totalAmount', type: 'decimal', title: 'Tổng tiền' },
                  ],
                },
              ],
            },
          },
        };
      }
      if (req.url === 'dxosBlocks:aggregateQuery') {
        return {
          data: {
            data: {
              collection: 'latticeOrders',
              chartType: 'bar',
              groupBy: 'totalAmount',
              metric: { op: 'count', field: '' },
              totalRows: 2,
              series: [
                { key: '(Trống)', label: '(Trống)', value: 2, count: 2 },
              ],
            },
          },
        };
      }
      if (req.url === 'latticeOrders:list') {
        return { data: { data: [] } };
      }
      return { data: { data: [] } };
    },
  };

  const View = createBiChartBlockView({ useAPIClient: () => api }, hooks.React, {}, {});
  let tree = hooks.render(View, {
    model: { props: { collection: 'latticeOrders', chartType: 'bar', groupBy: 'totalAmount', metricOp: 'count', limit: 20 } },
  });
  await new Promise((r) => setTimeout(r, 20));
  tree = hooks.render(View, {
    model: { props: { collection: 'latticeOrders', chartType: 'bar', groupBy: 'totalAmount', metricOp: 'count', limit: 20 } },
  });

  const bars = collectNodes(resolveTree(tree)).filter((n) => n.props?.['data-testid'] === 'dxos-bi-bar-item');
  assert.equal(bars.length, 1);
  await bars[0].props.onClick();
  const listCall = requests.find((r) => r.url === 'latticeOrders:list');
  assert.ok(listCall, 'Clicking (Trống) bar must call latticeOrders:list');
  assert.equal(typeof listCall.params.filter, 'string');
  assert.deepEqual(JSON.parse(listCall.params.filter), { totalAmount: null });
  hooks.unmount();
});
