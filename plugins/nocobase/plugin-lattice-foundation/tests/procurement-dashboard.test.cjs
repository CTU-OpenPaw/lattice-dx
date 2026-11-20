/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createProcurementDashboardComponent} = require('../src/applications/procurement/dashboard');
const {validateManifest} = require('../src/shared/manifest');
const purchasingManifest = require('../src/shared/manifests/purchasing.json');

const runs = [
  { id: 'run-1', title: 'Mua laptop Dell XPS', state: 'draft', version: 1, data: {} },
  { id: 'run-2', title: 'Mua màn hình Dell 27"', state: 'submitted', version: 2, data: {} },
  { id: 'run-3', title: 'Mua máy chiếu phòng họp', state: 'approved', version: 3, data: {} },
  { id: 'run-4', title: 'Mua bàn ghế văn phòng', state: 'received', version: 4, data: {} },
  { id: 'run-5', title: 'Mua switch mạng Cisco', state: 'accepted', version: 5, data: {} },
  {
    id: 'run-6',
    title: 'Mua máy in Canon LBP2900',
    state: 'handed_over',
    version: 6,
    data: { assetId: 'urn:ngsi-ld:Asset:canon-2900' },
    entityContext: { entityId: 'asset-uuid-canon', schemaId: 'asset' }
  },
  { id: 'run-7', title: 'Mua đồ ăn trưa phòng ban', state: 'rejected', version: 2, data: {} }
];

const assetDetail = {
  id: 'asset-uuid-canon',
  title: 'Máy in văn phòng',
  schemaId: 'asset',
  version: 2,
  attributes: {
    assetCode: 'ASSET-CANON-01',
    location: 'Phòng Kỹ Thuật',
    status: 'Đang sử dụng'
  }
};

function hooks() {
  const slots = [];
  let index = 0, queue = [];
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    Fragment: ({children}) => children,
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
    useState(value) {
      const i = index++;
      if (!slots[i]) slots[i] = { value };
      return [slots[i].value, next => slots[i].value = typeof next === 'function' ? next(slots[i].value) : next];
    },
    useRef(value) {
      const i = index++;
      if (!slots[i]) slots[i] = { current: value };
      return slots[i];
    },
    useCallback(fn, deps) {
      const i = index++;
      if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { deps, fn };
      return slots[i].fn;
    },
    useMemo(fn, deps) {
      const i = index++;
      if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { deps, value: fn() };
      return slots[i].value;
    },
    useEffect(fn, deps) {
      const i = index++;
      if (!slots[i] || !same(slots[i].deps, deps)) queue.push(() => { slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; });
    }
  };
  return {
    react,
    render(fn) {
      index = 0;
      const tree = fn();
      const effects = queue;
      queue = [];
      effects.forEach(f => f());
      return tree;
    }
  };
}

function find(tree, predicate) {
  if (!tree || typeof tree !== 'object') return null;
  if (predicate(tree)) return tree;
  for (const child of tree.children || []) {
    const result = find(child, predicate);
    if (result) return result;
  }
  return null;
}

function findAll(tree, predicate) {
  const results = [];
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (predicate(node)) results.push(node);
    for (const child of node.children || []) walk(child);
  }
  walk(tree);
  return results;
}

const tick = () => new Promise(setImmediate);

test('purchasing manifest with dashboard panel validates cleanly', () => {
  const errors = validateManifest(purchasingManifest);
  assert.deepEqual(errors, []);
});

test('Procurement Dashboard calculates KPI state counts, filters by state and searches assets', async () => {
  const api = {
    workflow: async (op) => {
      if (op === 'list') return { items: runs };
      return { items: [] };
    },
    entity: async (op, { id }) => {
      if (id === 'asset-uuid-canon') return assetDetail;
      throw new Error('Not found');
    }
  };

  const env = hooks(), Component = createProcurementDashboardComponent(env.react);
  const render = (override = {}) => env.render(() => Component({ api, connection: { connected: true }, ...override }));

  // Initial render
  render(); await tick();
  let tree = render();

  // 1. Verify KPI summary cards
  const kpiCards = find(tree, n => n.props?.['data-testid'] === 'kpi-summary-cards');
  assert.ok(kpiCards, 'KPI summary cards section rendered');
  const cardText = JSON.stringify(kpiCards);
  assert.ok(cardText.includes('Tất cả'), 'includes all');
  assert.ok(cardText.includes('7'), 'total count 7');
  assert.ok(cardText.includes('Bản nháp'), 'draft');
  assert.ok(cardText.includes('Chờ duyệt'), 'submitted');
  assert.ok(cardText.includes('Đã bàn giao'), 'handed_over');

  // 2. Filter by state (click 'Đã bàn giao' card)
  const handedOverBtn = find(tree, n => n.props?.['data-state-filter'] === 'handed_over');
  assert.ok(handedOverBtn, 'Handed over filter card found');
  handedOverBtn.props.onClick();
  render(); await tick();
  tree = render();
  let table = find(tree, n => n.props?.['data-testid'] === 'dashboard-records-table');
  let tableText = JSON.stringify(table);
  assert.ok(tableText.includes('Mua máy in Canon LBP2900'));
  assert.equal(tableText.includes('Mua laptop Dell XPS'), false, 'draft should be filtered out');

  // Reset filter back to all
  const allBtn = find(tree, n => n.props?.['data-state-filter'] === 'all');
  allBtn.props.onClick();
  render(); await tick();
  tree = render();

  // 3. Search by asset query
  const searchInput = find(tree, n => n.props?.['data-testid'] === 'asset-search-input');
  assert.ok(searchInput, 'Search input found');
  searchInput.props.onChange({ target: { value: 'canon' } });
  render(); await tick();
  tree = render();
  table = find(tree, n => n.props?.['data-testid'] === 'dashboard-records-table');
  tableText = JSON.stringify(table);
  assert.ok(tableText.includes('Mua máy in Canon LBP2900'));
  assert.equal(tableText.includes('Mua laptop Dell XPS'), false);

  // 4. Click link from workflow record to Asset
  const assetLink = find(tree, n => n.props?.['data-testid'] === 'link-to-asset-run-6');
  assert.ok(assetLink, 'Link to Asset found on run-6');
  await assetLink.props.onClick();
  render(); await tick();
  tree = render();

  const assetCard = find(tree, n => n.props?.['data-testid'] === 'asset-detail-card');
  assert.ok(assetCard, 'Asset detail card displayed');
  const assetCardText = JSON.stringify(assetCard);
  assert.ok(assetCardText.includes('ASSET-CANON-01'), 'displays asset code');
  assert.ok(assetCardText.includes('Phòng Kỹ Thuật'), 'displays location');
  assert.ok(assetCardText.includes('Đang sử dụng'), 'displays status');

  // Close asset card
  const closeBtn = find(assetCard, n => n.type === 'button' && n.children?.includes?.('✕'));
  closeBtn.props.onClick();
  render(); await tick();
  tree = render();
  assert.equal(find(tree, n => n.props?.['data-testid'] === 'asset-detail-card'), null);
});

test('Procurement Dashboard handles disconnected state and asset read denial', async () => {
  const api = {
    workflow: async () => ({ items: runs }),
    entity: async () => { throw { status: 403, message: 'Forbidden' }; }
  };
  const env = hooks(), Component = createProcurementDashboardComponent(env.react);

  // Disconnected state
  const disconnectedTree = env.render(() => Component({ api, connection: { connected: false } }));
  assert.ok(JSON.stringify(disconnectedTree).includes('Kết nối tài khoản nghiệp vụ để xem số liệu tổng hợp.'));

  // Connected with asset error
  const connectedTree = env.render(() => Component({ api, connection: { connected: true } }));
  await tick();
  const tree = env.render(() => Component({ api, connection: { connected: true } }));
  const assetLink = find(tree, n => n.props?.['data-testid'] === 'link-to-asset-run-6');
  await assetLink.props.onClick();
  await tick();
  const treeAfterError = env.render(() => Component({ api, connection: { connected: true } }));
  const assetCard = find(treeAfterError, n => n.props?.['data-testid'] === 'asset-detail-card');
  assert.ok(assetCard);
  assert.ok(JSON.stringify(assetCard).includes('Forbidden') || JSON.stringify(assetCard).includes('Không có quyền'));
});
