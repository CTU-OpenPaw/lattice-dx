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

function makeReactHarness() {
  const h = (type, props, ...children) => ({
    type,
    props: props || {},
    children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
  });
  return {
    Fragment: 'Fragment',
    createElement: h,
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
  };
}

function collectNodes(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  out.push(node);
  if (Array.isArray(node.children)) {
    for (const c of node.children) collectNodes(c, out);
  }
  return out;
}

function nodeText(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (!node || typeof node !== 'object') return '';
  return (node.children || []).map(nodeText).join(' ');
}

test('parseCreativeBlueprint & evaluateQueryStats enforce bounds, sanitize unsafe URLs, and compute aggregations', () => {
  const {
    parseCreativeBlueprint,
    evaluateQueryStats,
    evaluateRuleCondition,
  } = require(path.join(PLUGIN_ROOT, 'src/client/creative-studio-block.js'));

  const bp = parseCreativeBlueprint({
    title: 'Buồng Giám sát AI Kho lạnh',
    subtitle: 'Thiết kế sáng tạo theo khuôn khổ',
    theme: 'invalid-theme-falls-back',
    columns: 9,
    queries: [
      { id: 'audits', collection: 'latticeCustomColdAudits', limit: 999 },
      { id: 'bad', collection: 'bad;drop table!' },
      { id: 'q2', collection: 'latticeOrders' },
      { id: 'q3', collection: 'latticeRequests' },
      { id: 'q4', collection: 'latticeServiceTickets' },
      { id: 'q5', collection: 'latticeIncidentCases' },
      { id: 'q6', collection: 'latticeAssets' },
      { id: 'q7_over_cap', collection: 'latticeParaDocuments' },
    ],
    widgets: [
      {
        type: 'thermometer',
        title: 'Nhiệt độ mới nhất',
        queryId: 'audits',
        metric: 'latest',
        field: 'temperatureC',
        min: -30,
        max: 10,
        warningThreshold: -15,
        criticalThreshold: -12,
        unit: '°C',
      },
      {
        type: 'quick-actions',
        title: 'Thao tác nhanh',
        buttons: [
          { label: 'Mở P.A.R.A.', kind: 'navigate', targetPath: '/p/services' },
          { label: 'XSS Link', kind: 'navigate', targetPath: 'javascript:alert(1)' },
          { label: 'External Link', kind: 'navigate', targetPath: 'https://evil.invalid/phish' },
        ],
      },
    ],
  });

  assert.equal(bp.theme, 'industrial-cockpit');
  assert.equal(bp.columns, 4);
  assert.equal(bp.queries.length, 6);
  assert.equal(bp.queries.some((q) => q.id === 'bad' || q.id === 'q7_over_cap'), false);
  assert.equal(bp.queries[0].limit, 50);

  const actionWidget = bp.widgets.find((w) => w.type === 'quick-actions');
  assert.equal(actionWidget.buttons.length, 1);
  assert.equal(actionWidget.buttons[0].targetPath, '/p/services');

  const rows = [
    { temperatureC: -11.4, status: 'draft', warehouseZone: 'Zone-A' },
    { temperatureC: -18.0, status: 'completed', warehouseZone: 'Zone-B' },
    { temperatureC: -16.6, status: 'draft', warehouseZone: 'Zone-A' },
  ];
  assert.equal(evaluateQueryStats(rows, { metric: 'count' }), 3);
  assert.equal(evaluateQueryStats(rows, { metric: 'latest', field: 'temperatureC' }), -11.4);
  assert.equal(evaluateQueryStats(rows, { metric: 'min', field: 'temperatureC' }), -18);
  assert.equal(evaluateQueryStats(rows, { metric: 'max', field: 'temperatureC' }), -11.4);
  assert.ok(Math.abs(evaluateQueryStats(rows, { metric: 'avg', field: 'temperatureC' }) - (-15.33)) < 0.05);
  assert.deepEqual(evaluateQueryStats(rows, { metric: 'groupBy', field: 'status' }), [
    { key: 'draft', count: 2 },
    { key: 'completed', count: 1 },
  ]);

  assert.equal(evaluateRuleCondition(-11.4, 'gt', -15), true);
  assert.equal(evaluateRuleCondition(-18.0, 'gt', -15), false);
  assert.equal(evaluateRuleCondition(-15, 'gte', -15), true);
});

test('createCreativeStudioView renders industrial-cockpit & amber-alert themes and executes safe navigate action', () => {
  const { createCreativeStudioView } = require(path.join(PLUGIN_ROOT, 'src/client/creative-studio-block.js'));
  const React = makeReactHarness();
  const navigated = [];
  const view = createCreativeStudioView(
    { useAPIClient: () => null },
    React,
    {},
    { router: { navigate: (p) => navigated.push(p) } },
  );

  const elCockpit = view({
    model: null,
    liveConfig: {
      title: 'Buồng Điều hành Chuỗi lạnh [AI]',
      blueprintJson: JSON.stringify({
        theme: 'industrial-cockpit',
        columns: 2,
        queries: [{ id: 'audits', collection: 'latticeCustomColdAudits' }],
        widgets: [
          { type: 'gauge', title: 'Độ ẩm chuẩn', staticValue: 78, max: 100, unit: '%' },
          { type: 'rule-callout', title: 'Cảnh báo SOP', staticValue: -11.4, operator: 'gt', threshold: -15, messageWhenTrue: 'Vượt ngưỡng -15°C!', messageWhenFalse: 'Đạt chuẩn' },
          { type: 'quick-actions', title: 'Điều hướng', buttons: [{ label: 'Xem P.A.R.A.', kind: 'navigate', targetPath: '/p/services', primary: true }] },
        ],
      }),
    },
  });

  const nodes = collectNodes(elCockpit);
  const root = nodes.find((n) => n.props?.['data-testid'] === 'dxos-creative-studio-block');
  assert.ok(root);
  assert.equal(root.props['data-theme'], 'industrial-cockpit');
  assert.ok(String(root.props.style?.background || '').includes('#0f172a'));
  assert.ok(nodeText(root).includes('Vượt ngưỡng -15°C!'));

  const navBtn = nodes.find((n) => n.type === 'button' && nodeText(n).includes('Xem P.A.R.A.'));
  assert.ok(navBtn);
  navBtn.props.onClick();
  assert.deepEqual(navigated, ['/p/services']);
});

test('canvas-architect-bridge restricts Admin bar to admins, formats target block prompt, and exposes state/rollback helpers', async () => {
  const {
    createAdminArchitectBarElement,
    formatTargetBlockPrompt,
    fetchPageSurfaceState,
    fetchInspectPageBlocks,
    requestPageRollback,
  } = require(path.join(PLUGIN_ROOT, 'src/client/canvas-architect-bridge.js'));
  const React = makeReactHarness();

  // Hidden for non-admin employees
  assert.equal(createAdminArchitectBarElement(React, { isAdmin: false }), null);

  let pickClicks = 0;
  let undoClicks = 0;
  const bar = createAdminArchitectBarElement(React, {
    isAdmin: true,
    picking: false,
    syncMessage: 'AI Architect vừa cập nhật giao diện',
    onTogglePicker: () => { pickClicks += 1; },
    onRollback: () => { undoClicks += 1; },
  });
  const nodes = collectNodes(bar);
  const root = nodes.find((n) => n.props?.['data-testid'] === 'dxos-admin-architect-bar');
  assert.ok(root);
  assert.ok(nodes.some((n) => n.props?.['data-testid'] === 'dxos-live-canvas-sync-banner'));

  const pickBtn = nodes.find((n) => n.type === 'button' && nodeText(n).includes('Chọn Block sửa với AI'));
  const undoBtn = nodes.find((n) => n.type === 'button' && nodeText(n).includes('Hoàn tác trang'));
  assert.ok(pickBtn && undoBtn);
  pickBtn.props.onClick();
  undoBtn.props.onClick();
  assert.equal(pickClicks, 1);
  assert.equal(undoClicks, 1);

  const promptText = formatTargetBlockPrompt(
    { uid: 'blk-1', use: 'DxosKpiMetricBlockModel', title: 'KPI Kho lạnh' },
    'cold-qa',
  );
  assert.ok(promptText.includes('/p/cold-qa'));
  assert.ok(promptText.includes('blk-1'));
  assert.ok(promptText.includes('DxosKpiMetricBlockModel'));

  const calls = [];
  const mockApi = {
    async request(req) {
      calls.push(req);
      if (req.url === 'dxosAi:pageSurfaceState') return { data: { data: { revision: 4, blockCount: 5, lastMutatedUid: 'blk-x' } } };
      if (req.url === 'dxosAi:inspectPageBlocks') return { data: { data: { blocks: [{ uid: 'blk-1', use: 'DxosKpiMetricBlockModel', props: { title: 'Updated' } }] } } };
      if (req.url === 'dxosAi:rollbackPageSnapshot') return { data: { data: { rolledBack: true, restoredCount: 4 } } };
      throw new Error(`Unexpected: ${req.url}`);
    },
  };
  assert.equal((await fetchPageSurfaceState(mockApi, { portalSlug: 'cold-qa' })).revision, 4);
  assert.equal((await fetchInspectPageBlocks(mockApi, { portalSlug: 'cold-qa' })).blocks.length, 1);
  assert.equal((await requestPageRollback(mockApi, { portalSlug: 'cold-qa' })).rolledBack, true);
  assert.equal(calls.length, 3);
});
