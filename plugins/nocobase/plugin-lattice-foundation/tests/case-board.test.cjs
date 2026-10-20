// SPDX-License-Identifier: Apache-2.0
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCaseBoardComponent } = require('../src/applications/incident/case-board');

const sampleCases = [
  {
    id: 'case-run-001',
    title: 'Quá nhiệt máy phát Cummins #1',
    state: 'open',
    version: 1,
    createdAt: '2026-10-16T08:00:00Z',
    data: {
      assetEntityId: 'asset-gen-01',
      severity: 'critical',
      handlerId: 'alice',
      notificationId: 'notif-001'
    },
    availableTransitions: [{ id: 'assign', title: 'Phân công' }]
  },
  {
    id: 'case-run-002',
    title: 'Độ ẩm phòng server tầng 2 tăng cao',
    state: 'assigned',
    version: 1,
    createdAt: '2026-10-16T08:15:00Z',
    data: {
      assetEntityId: 'asset-srv-02',
      severity: 'high',
      handlerId: 'bob',
      notificationId: 'notif-002'
    },
    availableTransitions: [{ id: 'accept', title: 'Nhận việc' }]
  },
  {
    id: 'case-run-003',
    title: 'Nhiệt độ bể làm mát đạt 62°C',
    state: 'investigating',
    version: 2,
    createdAt: '2026-10-16T07:30:00Z',
    data: {
      assetEntityId: 'asset-gen-01',
      severity: 'high',
      handlerId: 'alice',
      notificationId: 'notif-003'
    },
    availableTransitions: [{ id: 'request_analysis', title: 'Yêu cầu AI phân tích' }]
  },
  {
    id: 'case-run-004',
    title: 'Rò rỉ cảm biến pin lưu điện',
    state: 'resolved',
    version: 3,
    createdAt: '2026-10-15T10:00:00Z',
    data: {
      assetEntityId: 'asset-srv-02',
      severity: 'medium',
      handlerId: 'charlie',
      notificationId: 'notif-004'
    },
    availableTransitions: [{ id: 'close', title: 'Đóng sự cố' }]
  }
];

const sampleAssets = [
  { id: 'asset-gen-01', title: 'Máy phát điện Cummins P1', schemaId: 'incident-asset', attributes: { department: 'dept-it' } },
  { id: 'asset-srv-02', title: 'Tủ Server Trung tâm', schemaId: 'incident-asset', attributes: { department: 'dept-ops' } }
];

const sampleDepartments = [
  { id: 'dept-it', name: 'Phòng Công nghệ' },
  { id: 'dept-ops', name: 'Phòng Vận hành' }
];

function hooks() {
  const slots = [];
  let index = 0, queue = [];
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    Fragment: ({ children }) => children,
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
    useState(value) {
      const i = index++;
      if (!slots[i]) slots[i] = { value };
      return [slots[i].value, next => (slots[i].value = typeof next === 'function' ? next(slots[i].value) : next)];
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
      if (!slots[i] || !same(slots[i].deps, deps))
        queue.push(() => {
          slots[i]?.cleanup?.();
          slots[i] = { deps, cleanup: fn() };
        });
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
    const res = find(child, predicate);
    if (res) return res;
  }
  return null;
}

function findAll(tree, predicate) {
  const matches = [];
  function search(node) {
    if (!node || typeof node !== 'object') return;
    if (predicate(node)) matches.push(node);
    for (const child of node.children || []) search(child);
  }
  search(tree);
  return matches;
}

const tick = () => new Promise(setImmediate);

test('CaseBoard renders in Kanban board view with 4 process columns and case cards', async () => {
  const env = hooks();
  const CaseBoard = createCaseBoardComponent(env.react);
  const api = {
    workflow: async (op) => {
      if (op === 'list') return { items: sampleCases };
      return { items: [] };
    },
    entity: async (op) => {
      if (op === 'list') return { items: sampleAssets };
      return { items: [] };
    },
    request: async (opts) => {
      if (opts.url === 'latticeDepartments:list') return { data: { data: sampleDepartments } };
      return { data: { data: [] } };
    }
  };

  const render = () => env.render(() => CaseBoard({ api, connection: { connected: true } }));
  render(); await tick();
  const tree = render();

  const str = JSON.stringify(tree);
  assert.ok(str.includes('Điều phối & Xử lý sự cố (Case Board)'));
  assert.ok(str.includes('Tiếp nhận & Giao việc'));
  assert.ok(str.includes('Kiểm tra & Phân tích AI'));
  assert.ok(str.includes('Phê duyệt đề xuất'));
  assert.ok(str.includes('Khắc phục & Đã đóng'));

  // Cards rendered
  assert.ok(str.includes('Quá nhiệt máy phát Cummins #1'));
  assert.ok(str.includes('Độ ẩm phòng server tầng 2 tăng cao'));
  assert.ok(str.includes('Nhiệt độ bể làm mát đạt 62°C'));
  assert.ok(str.includes('Rò rỉ cảm biến pin lưu điện'));

  // Severity badges
  assert.ok(str.includes('Khẩn cấp'));
  assert.ok(str.includes('Cao'));
  assert.ok(str.includes('Trung bình'));
});

test('CaseBoard switches between Board view and List view', async () => {
  const env = hooks();
  const CaseBoard = createCaseBoardComponent(env.react);
  const api = {
    workflow: async (op) => {
      if (op === 'list') return { items: sampleCases };
      return { items: [] };
    },
    entity: async () => ({ items: sampleAssets }),
    request: async () => ({ data: { data: sampleDepartments } })
  };

  const render = () => env.render(() => CaseBoard({ api, connection: { connected: true } }));
  render(); await tick();
  let tree = render();

  assert.ok(find(tree, n => n.props?.['data-testid'] === 'lattice-case-board-view'));
  assert.equal(find(tree, n => n.props?.['data-testid'] === 'lattice-case-list-view'), null);

  // Switch to list view
  const listBtn = find(tree, n => n.props?.['data-testid'] === 'lattice-view-list-btn');
  assert.ok(listBtn, 'List view button should exist');
  listBtn.props.onClick();

  render(); await tick();
  tree = render();

  assert.ok(find(tree, n => n.props?.['data-testid'] === 'lattice-case-list-view'));
  assert.equal(find(tree, n => n.props?.['data-testid'] === 'lattice-case-board-view'), null);

  // Switch back to board view
  const boardBtn = find(tree, n => n.props?.['data-testid'] === 'lattice-view-board-btn');
  boardBtn.props.onClick();

  render(); await tick();
  tree = render();
  assert.ok(find(tree, n => n.props?.['data-testid'] === 'lattice-case-board-view'));
});

test('CaseBoard opens detail modal and triggers workflow transition', async () => {
  const env = hooks();
  const CaseBoard = createCaseBoardComponent(env.react);
  let transitionPayload = null;

  const api = {
    workflow: async (op, arg) => {
      if (op === 'list') return { items: sampleCases };
      if (op === 'transition') {
        transitionPayload = arg;
        return { version: 2 };
      }
      return { items: [] };
    },
    entity: async () => ({ items: sampleAssets }),
    request: async () => ({ data: { data: sampleDepartments } })
  };

  const render = () => env.render(() => CaseBoard({ api, connection: { connected: true } }));
  render(); await tick();
  let tree = render();

  // Click on case-run-002 (assigned)
  const card2 = find(tree, n => n.props?.['data-testid'] === 'lattice-case-card-case-run-002');
  assert.ok(card2, 'Card 2 must exist');
  card2.props.onClick();

  render(); await tick();
  tree = render();

  const modal = find(tree, n => n.props?.['data-testid'] === 'lattice-case-detail-modal');
  assert.ok(modal, 'Modal must appear when card is clicked');
  assert.ok(JSON.stringify(modal).includes('Độ ẩm phòng server tầng 2 tăng cao'));

  // Should have "Nhận việc kiểm tra" button for assigned status
  const acceptBtn = find(modal, n => n.props?.['data-testid'] === 'lattice-action-accept');
  assert.ok(acceptBtn, 'Accept button must exist for assigned state');

  // Input note
  const noteInput = find(modal, n => n.props?.['data-testid'] === 'lattice-case-action-note');
  noteInput.props.onChange({ target: { value: 'Kỹ thuật viên đã đến phòng server' } });
  render(); await tick();
  tree = render();

  const modalUpdated = find(tree, n => n.props?.['data-testid'] === 'lattice-case-detail-modal');
  const acceptBtnUpdated = find(modalUpdated, n => n.props?.['data-testid'] === 'lattice-action-accept');

  // Click accept
  await acceptBtnUpdated.props.onClick();
  render(); await tick();
  tree = render();

  assert.ok(transitionPayload, 'Transition API must be called');
  assert.equal(transitionPayload.id, 'case-run-002');
  assert.equal(transitionPayload.body.action, 'accept');
  assert.equal(transitionPayload.body.input.receiptNote, 'Kỹ thuật viên đã đến phòng server');
});

test('CaseBoard creates new incident and handles 403 permission error', async () => {
  const env = hooks();
  const CaseBoard = createCaseBoardComponent(env.react);
  let createPayload = null;

  const api = {
    workflow: async (op, arg) => {
      if (op === 'list') return { items: sampleCases };
      if (op === 'create') {
        createPayload = arg;
        return { id: 'case-new-999' };
      }
      if (op === 'transition') {
        throw { status: 403, message: 'Forbidden' };
      }
      return { items: [] };
    },
    entity: async () => ({ items: sampleAssets }),
    request: async () => ({ data: { data: sampleDepartments } })
  };

  const render = () => env.render(() => CaseBoard({ api, connection: { connected: true } }));
  render(); await tick();
  let tree = render();

  // Click create case button
  const createBtn = find(tree, n => n.props?.['data-testid'] === 'lattice-create-case-btn');
  createBtn.props.onClick();

  render(); await tick();
  tree = render();

  const modal = find(tree, n => n.props?.['data-testid'] === 'lattice-create-case-modal');
  assert.ok(modal, 'Create case modal must appear');

  // Fill in form
  const titleInput = find(modal, n => n.props?.['data-testid'] === 'lattice-create-case-title');
  const assetSelect = find(modal, n => n.props?.['data-testid'] === 'lattice-create-case-asset');
  const handlerSelect = find(modal, n => n.props?.['data-testid'] === 'lattice-create-case-handler');

  titleInput.props.onChange({ target: { value: 'Sự cố tụt áp máy nén khí' } });
  assetSelect.props.onChange({ target: { value: 'asset-gen-01' } });
  handlerSelect.props.onChange({ target: { value: 'alice' } });

  render(); await tick();
  tree = render();

  const modalUpdated = find(tree, n => n.props?.['data-testid'] === 'lattice-create-case-modal');
  const form = find(modalUpdated, n => n.type === 'form');
  await form.props.onSubmit({ preventDefault: () => {} });

  render(); await tick();
  tree = render();

  assert.ok(createPayload, 'Create workflow payload should be submitted');
  assert.equal(createPayload.body.title, 'Sự cố tụt áp máy nén khí');
  assert.equal(createPayload.body.input.assetEntityId, 'asset-gen-01');
  assert.equal(createPayload.body.input.handlerId, 'alice');
});

test('CaseBoard filters by severity, status, asset, department and keyword query', async () => {
  const env = hooks();
  const CaseBoard = createCaseBoardComponent(env.react);

  const api = {
    workflow: async (op) => {
      if (op === 'list') return { items: sampleCases };
      return { items: [] };
    },
    entity: async () => ({ items: sampleAssets }),
    request: async () => ({ data: { data: sampleDepartments } })
  };

  const render = () => env.render(() => CaseBoard({ api, connection: { connected: true } }));
  render(); await tick();
  let tree = render();

  // 1. Filter by severity: critical
  const sevSelect = find(tree, n => n.props?.['data-testid'] === 'lattice-filter-severity');
  sevSelect.props.onChange({ target: { value: 'critical' } });
  render(); await tick();
  tree = render();

  let str = JSON.stringify(tree);
  assert.ok(str.includes('Quá nhiệt máy phát Cummins #1'));
  assert.equal(str.includes('Độ ẩm phòng server tầng 2 tăng cao'), false);
  assert.equal(str.includes('Nhiệt độ bể làm mát đạt 62°C'), false);

  // Reset severity filter
  sevSelect.props.onChange({ target: { value: 'all' } });
  render(); await tick();
  tree = render();

  // 2. Filter by asset: asset-srv-02
  const assetSelect = find(tree, n => n.props?.['data-testid'] === 'lattice-filter-asset');
  assetSelect.props.onChange({ target: { value: 'asset-srv-02' } });
  render(); await tick();
  tree = render();

  str = JSON.stringify(tree);
  assert.equal(str.includes('Quá nhiệt máy phát Cummins #1'), false);
  assert.ok(str.includes('Độ ẩm phòng server tầng 2 tăng cao'));
  assert.ok(str.includes('Rò rỉ cảm biến pin lưu điện'));

  // Reset asset filter
  assetSelect.props.onChange({ target: { value: 'all' } });
  render(); await tick();
  tree = render();

  // 3. Filter by department: dept-ops
  const deptSelect = find(tree, n => n.props?.['data-testid'] === 'lattice-filter-department');
  deptSelect.props.onChange({ target: { value: 'dept-ops' } });
  render(); await tick();
  tree = render();

  str = JSON.stringify(tree);
  assert.equal(str.includes('Quá nhiệt máy phát Cummins #1'), false);
  assert.ok(str.includes('Độ ẩm phòng server tầng 2 tăng cao'));

  // Reset dept filter
  deptSelect.props.onChange({ target: { value: 'all' } });
  render(); await tick();
  tree = render();

  // 4. Search query
  const searchInput = find(tree, n => n.props?.['data-testid'] === 'lattice-case-search');
  searchInput.props.onChange({ target: { value: 'bể làm mát' } });
  render(); await tick();
  tree = render();

  str = JSON.stringify(tree);
  assert.ok(str.includes('Nhiệt độ bể làm mát đạt 62°C'));
  assert.equal(str.includes('Quá nhiệt máy phát Cummins #1'), false);
  assert.equal(str.includes('Độ ẩm phòng server'), false);
});

