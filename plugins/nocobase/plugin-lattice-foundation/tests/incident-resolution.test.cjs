/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createBridge } = require('../../action-bridge/bridge.cjs');
const { createCaseResolutionComponent } = require('../src/applications/incident/resolution');
const { createCaseBoardComponent } = require('../src/applications/incident/case-board');

async function workflowFixture({ statuses = [] } = {}) {
  const calls = [];
  const pendingStatuses = [...statuses];
  const bridge = createBridge({
    gatewayUrl: 'http://gateway',
    tokenUrl: 'http://identity/token',
    userinfoUrl: 'http://identity/user',
    authorizationUrl: 'http://identity/auth',
    clientId: 'fixture',
    callbackUrl: 'http://localhost/callback'
  }, {
    schedule: () => ({ unref() {} }),
    cancelTimer: () => {},
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith('/token')) return Response.json({ access_token: 'fixture-token', expires_in: 300 });
      if (url.endsWith('/v1/actions')) return Response.json({ items: [] });
      if (url.endsWith('/user')) return Response.json({ sub: 'alice', organization_id: 'org-1' });
      if (url.startsWith('http://gateway/v1/workflows/') && url.endsWith('/transitions')) {
        const status = pendingStatuses.shift() || 200;
        return Response.json(status >= 400 ? { error: 'Workflow transition failed' } : { version: 5 }, { status });
      }
      return Response.json({});
    }
  });
  const start = bridge.connect('noco');
  await bridge.callback({ state: new URL(start.authorizationUrl).searchParams.get('state'), code: 'fixture' }, start.browserId);
  const requestCalls = [];
  const entityCalls = [];
  return {
    api: {
      workflow: (operation, args = {}) => bridge.workflow('noco', start.browserId, { operation, ...args }),
      request: async request => { requestCalls.push(request); return { data: {} }; },
      entity: async (operation, args) => { entityCalls.push({ operation, args }); return {}; }
    },
    calls,
    requestCalls,
    entityCalls,
    connection: { connected: true, identity: { subject: 'alice', organizationId: 'org-1' } },
    close: () => bridge.disconnect('noco', start.browserId)
  };
}

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

const tick = () => new Promise(setImmediate);

test('CaseResolution renders form and submits record_resolution for approved case', async () => {
  const env = hooks();
  const CaseResolution = createCaseResolutionComponent(env.react);
  const fixture = await workflowFixture();

  const caseItem = {
    id: '11111111-1111-4111-8111-111111111111',
    status: 'approved',
    version: 3,
    title: 'Bơm quá nhiệt',
    handlerId: 'bob'
  };

  const render = () => env.render(() => CaseResolution({ api: fixture.api, connection: fixture.connection, caseItem, runId: caseItem.id }));
  render(); await tick();
  let tree = render();

  const str = JSON.stringify(tree);
  assert.ok(str.includes('Biên bản khắc phục hiện trường'));
  assert.ok(str.includes('Kiểm tra cơ khí / đấu nối dây'));
  assert.ok(str.includes('Chạy thử không tải 15 phút'));

  // Fill in resolution note
  const textarea = find(tree, n => n.props?.['data-testid'] === 'lattice-resolution-note-input');
  assert.ok(textarea, 'Resolution note textarea must exist');
  textarea.props.onChange({ target: { value: 'Đã thay thế phớt làm mát và bơm dung dịch mới' } });

  render(); await tick();
  tree = render();

  const form = find(tree, n => n.type === 'form');
  await form.props.onSubmit({ preventDefault: () => {} });

  render(); await tick();
  tree = render();

  const transition = fixture.calls.find(call => call.url === `http://gateway/v1/workflows/${caseItem.id}/transitions`);
  assert.ok(transition, 'Workflow transition record_resolution must be triggered through the real bridge');
  assert.deepEqual(JSON.parse(transition.options.body), {
    action: 'record_resolution',
    expectedVersion: 3,
    input: { resolutionNote: 'Đã thay thế phớt làm mát và bơm dung dịch mới' }
  });
  assert.ok(transition.options.headers['idempotency-key']);
  assert.equal(fixture.requestCalls.length, 0, 'NocoBase is not a second case store');
  assert.equal(fixture.entityCalls.length, 0);
  fixture.close();
});

test('CaseResolution renders close section with modal confirmation and submits close for resolved case', async () => {
  const env = hooks();
  const CaseResolution = createCaseResolutionComponent(env.react);
  const fixture = await workflowFixture();

  const caseItem = {
    id: '22222222-2222-4222-8222-222222222222',
    status: 'resolved',
    version: 4,
    title: 'Bơm quá nhiệt',
    resolutionNote: 'Đã thay linh kiện hoàn tất',
    assetEntityId: '33333333-3333-4333-8333-333333333333'
  };
  const render = () => env.render(() => CaseResolution({ api: fixture.api, connection: fixture.connection, caseItem, runId: caseItem.id }));
  render(); await tick();
  let tree = render();

  const str = JSON.stringify(tree);
  assert.ok(str.includes('Nghiệm thu & Xác nhận đóng sự cố'));
  assert.ok(str.includes('Đã thay linh kiện hoàn tất'));

  // Enter close note
  const closeInput = find(tree, n => n.props?.['data-testid'] === 'lattice-close-note-input');
  assert.ok(closeInput, 'Close note input must exist');
  closeInput.props.onChange({ target: { value: 'Đã nghiệm thu thiết bị hoạt động ổn định. Đóng hồ sơ.' } });

  render(); await tick();
  tree = render();

  // Open confirmation modal
  const openModalBtn = find(tree, n => n.props?.['data-testid'] === 'lattice-open-close-modal-btn');
  assert.ok(openModalBtn, 'Open close modal button must exist');
  openModalBtn.props.onClick();

  render(); await tick();
  tree = render();

  // Confirm close in modal
  const confirmModal = find(tree, n => n.props?.['data-testid'] === 'lattice-confirm-close-modal');
  assert.ok(confirmModal, 'Confirm close modal must be visible');

  const confirmBtn = find(confirmModal, n => n.props?.['data-testid'] === 'lattice-confirm-close-btn');
  assert.ok(confirmBtn, 'Confirm button in modal must exist');
  await confirmBtn.props.onClick();

  render(); await tick();
  tree = render();

  const transition = fixture.calls.find(call => call.url === `http://gateway/v1/workflows/${caseItem.id}/transitions`);
  assert.ok(transition, 'Workflow transition close must be triggered through the real bridge');
  assert.deepEqual(JSON.parse(transition.options.body), {
    action: 'close',
    expectedVersion: 4,
    input: { closeNote: 'Đã nghiệm thu thiết bị hoạt động ổn định. Đóng hồ sơ.' }
  });
  assert.ok(transition.options.headers['idempotency-key']);
  assert.equal(fixture.requestCalls.length, 0, 'Workflow owns the case update');
  assert.equal(fixture.entityCalls.length, 0, 'Workflow applies asset status atomically');
  fixture.close();
});

test('CaseResolution retries an uncertain close with the same key and body', async () => {
  const env = hooks();
  const CaseResolution = createCaseResolutionComponent(env.react);
  const fixture = await workflowFixture({ statuses: [503, 200] });
  const caseItem = {
    id: '66666666-6666-4666-8666-666666666666',
    status: 'resolved',
    version: 9,
    title: 'Bơm quá nhiệt',
    resolutionNote: 'Đã sửa xong',
    assetEntityId: '33333333-3333-4333-8333-333333333333'
  };
  const render = () => env.render(() => CaseResolution({ api: fixture.api, connection: fixture.connection, caseItem, runId: caseItem.id }));

  render(); await tick();
  let tree = render();
  const closeInput = find(tree, node => node.props?.['data-testid'] === 'lattice-close-note-input');
  closeInput.props.onChange({ target: { value: 'Đã nghiệm thu, đóng hồ sơ.' } });
  render(); await tick();
  tree = render();
  find(tree, node => node.props?.['data-testid'] === 'lattice-open-close-modal-btn').props.onClick();
  render(); await tick();
  tree = render();
  await find(tree, node => node.props?.['data-testid'] === 'lattice-confirm-close-btn').props.onClick();

  tree = render();
  const retry = find(tree, node => node.props?.['data-testid'] === 'lattice-resolution-retry-command-btn');
  assert.ok(retry, 'An uncertain close must offer an explicit retry');
  await retry.props.onClick();

  const transitions = fixture.calls.filter(call => call.url === `http://gateway/v1/workflows/${caseItem.id}/transitions`);
  assert.equal(transitions.length, 2);
  assert.equal(transitions[0].options.headers['idempotency-key'], transitions[1].options.headers['idempotency-key']);
  assert.equal(transitions[0].options.body, transitions[1].options.body);
  assert.deepEqual(JSON.parse(transitions[0].options.body), {
    action: 'close',
    expectedVersion: 9,
    input: { closeNote: 'Đã nghiệm thu, đóng hồ sơ.' }
  });
  fixture.close();
});

test('CaseBoard detail modal renders and switches between reused blocks: Resolution, Evidence, Attachments, Timeline, Approval', async () => {
  const env = hooks();
  const CaseBoard = createCaseBoardComponent(env.react);

  const sampleCase = {
    id: '11111111-2222-3333-4444-555555555555',
    title: 'Sự cố quạt thông gió kho A',
    status: 'approved',
    version: 3,
    assetEntityId: 'urn:ngsi-ld:Asset:FAN-01',
    handlerId: 'tech-01',
    createdAt: '2026-10-18T10:00:00Z',
    proposal: {
      summary: 'Thay vòng bi và tra dầu',
      suggestedStatus: 'repair',
      evidence: ['Độ rung đo được: 4.8 mm/s']
    },
    data: {
      attachmentId: '22222222-3333-4444-5555-666666666666'
    }
  };

  const api = {
    workflow: async (op) => {
      if (op === 'list') return { items: [sampleCase] };
      if (op === 'detail') return sampleCase;
      if (op === 'history') return { items: [] };
      return {};
    },
    entity: async () => ({ items: [] }),
    request: async () => ({ data: { data: [] } }),
    file: async () => ({ id: '22222222-3333-4444-5555-666666666666', filename: 'report.txt', size: 100, scanStatus: 'clean' })
  };

  const render = () => env.render(() => CaseBoard({ api, connection: { connected: true } }));
  render(); await tick();
  let tree = render();

  // Click card to open modal
  const card = find(tree, n => n.props?.['data-testid'] === 'lattice-case-card-11111111-2222-3333-4444-555555555555');
  assert.ok(card, 'Card must exist');
  card.props.onClick();

  render(); await tick();
  tree = render();

  const modal = find(tree, n => n.props?.['data-testid'] === 'lattice-case-detail-modal');
  assert.ok(modal, 'Detail modal must appear');

  // Verify tab buttons exist
  assert.ok(find(modal, n => n.props?.['data-testid'] === 'lattice-modal-tab-overview'));
  assert.ok(find(modal, n => n.props?.['data-testid'] === 'lattice-modal-tab-resolution'));
  assert.ok(find(modal, n => n.props?.['data-testid'] === 'lattice-modal-tab-evidence'));
  assert.ok(find(modal, n => n.props?.['data-testid'] === 'lattice-modal-tab-attachments'));
  assert.ok(find(modal, n => n.props?.['data-testid'] === 'lattice-modal-tab-timeline'));
  assert.ok(find(modal, n => n.props?.['data-testid'] === 'lattice-modal-tab-approval'));

  // 1. Switch to Resolution tab
  const resTabBtn = find(modal, n => n.props?.['data-testid'] === 'lattice-modal-tab-resolution');
  resTabBtn.props.onClick();
  render(); await tick();
  tree = render();
  const resPanel = find(tree, n => n.props?.['data-testid'] === 'lattice-tab-panel-resolution');
  assert.ok(resPanel, 'Resolution tab panel must be rendered');
  const resNode = find(resPanel, n => typeof n.type === 'function' && n.type.name === 'CaseResolution');
  assert.ok(resNode, 'CaseResolution component must be instantiated inside resolution tab');
  assert.equal(resNode.props.caseItem.id, sampleCase.id);

  // 2. Switch to Evidence tab
  const eviTabBtn = find(tree, n => n.props?.['data-testid'] === 'lattice-modal-tab-evidence');
  eviTabBtn.props.onClick();
  render(); await tick();
  tree = render();
  const eviPanel = find(tree, n => n.props?.['data-testid'] === 'lattice-tab-panel-evidence');
  assert.ok(eviPanel, 'Evidence tab panel must be rendered');
  const eviNode = find(eviPanel, n => typeof n.type === 'function' && n.type.name === 'EvidenceProposal');
  assert.ok(eviNode, 'EvidenceProposal component must be instantiated inside evidence tab');
  assert.equal(eviNode.props.caseItem.proposal, undefined, 'EvidenceProposal must not receive a local proposal fallback');
  assert.equal(eviNode.props.caseItem.data.attachmentId, '22222222-3333-4444-5555-666666666666', 'Workflow run data remains intact');

  // 3. Switch to Attachments tab (reused AttachmentBlock)
  const attTabBtn = find(tree, n => n.props?.['data-testid'] === 'lattice-modal-tab-attachments');
  attTabBtn.props.onClick();
  render(); await tick();
  tree = render();
  const attPanel = find(tree, n => n.props?.['data-testid'] === 'lattice-tab-panel-attachments');
  assert.ok(attPanel, 'Attachments tab panel must be rendered');
  const attNode = find(attPanel, n => typeof n.type === 'function' && n.type.name === 'AttachmentBlock');
  assert.ok(attNode, 'Reused AttachmentBlock must be instantiated inside attachments tab');
  assert.equal(attNode.props.block.id, 'case-files');

  // 4. Switch to Timeline tab (reused ActivityTimelineBlock)
  const timeTabBtn = find(tree, n => n.props?.['data-testid'] === 'lattice-modal-tab-timeline');
  timeTabBtn.props.onClick();
  render(); await tick();
  tree = render();
  const timePanel = find(tree, n => n.props?.['data-testid'] === 'lattice-tab-panel-timeline');
  assert.ok(timePanel, 'Timeline tab panel must be rendered');
  const timeNode = find(timePanel, n => typeof n.type === 'function' && n.type.name === 'ActivityTimelineBlock');
  assert.ok(timeNode, 'Reused ActivityTimelineBlock must be instantiated inside timeline tab');
  assert.equal(timeNode.props.block.id, 'case-history');

  // 5. Switch to Approval tab (reused ApprovalBlock)
  const appTabBtn = find(tree, n => n.props?.['data-testid'] === 'lattice-modal-tab-approval');
  appTabBtn.props.onClick();
  render(); await tick();
  tree = render();
  const appPanel = find(tree, n => n.props?.['data-testid'] === 'lattice-tab-panel-approval');
  assert.ok(appPanel, 'Approval tab panel must be rendered');
  const appNode = find(appPanel, n => typeof n.type === 'function' && n.type.name === 'ApprovalBlock');
  assert.ok(appNode, 'Reused ApprovalBlock must be instantiated inside approval tab');
  assert.equal(appNode.props.block.id, 'case-approval');
});
