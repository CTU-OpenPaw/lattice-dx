// SPDX-License-Identifier: Apache-2.0
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCaseResolutionComponent } = require('../src/applications/incident/resolution');
const { createCaseBoardComponent } = require('../src/applications/incident/case-board');

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
  let resolutionPayload = null;

  const caseItem = {
    id: 'case-approved-001',
    status: 'approved',
    version: 3,
    title: 'Bơm quá nhiệt',
    handlerId: 'bob'
  };

  const api = {
    workflow: async (op, arg) => {
      if (op === 'transition') {
        resolutionPayload = arg;
        return { version: 4 };
      }
      return {};
    },
    request: async () => ({ data: {} })
  };

  const render = () => env.render(() => CaseResolution({ api, connection: { connected: true }, caseItem, runId: caseItem.id }));
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

  assert.ok(resolutionPayload, 'Workflow transition record_resolution must be triggered');
  assert.equal(resolutionPayload.id, 'case-approved-001');
  assert.equal(resolutionPayload.body.action, 'record_resolution');
  assert.equal(resolutionPayload.body.input.resolutionNote, 'Đã thay thế phớt làm mát và bơm dung dịch mới');
});

test('CaseResolution renders close section with modal confirmation and submits close for resolved case', async () => {
  const env = hooks();
  const CaseResolution = createCaseResolutionComponent(env.react);
  let closePayload = null;

  const caseItem = {
    id: 'case-resolved-002',
    status: 'resolved',
    version: 4,
    title: 'Bơm quá nhiệt',
    resolutionNote: 'Đã thay linh kiện hoàn tất'
  };

  const api = {
    workflow: async (op, arg) => {
      if (op === 'transition') {
        closePayload = arg;
        return { version: 5 };
      }
      return {};
    },
    request: async () => ({ data: {} })
  };

  const render = () => env.render(() => CaseResolution({ api, connection: { connected: true }, caseItem, runId: caseItem.id }));
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

  assert.ok(closePayload, 'Workflow transition close must be triggered');
  assert.equal(closePayload.id, 'case-resolved-002');
  assert.equal(closePayload.body.action, 'close');
  assert.equal(closePayload.body.input.closeNote, 'Đã nghiệm thu thiết bị hoạt động ổn định. Đóng hồ sơ.');
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
  assert.equal(eviNode.props.proposal.suggestedStatus, 'repair');

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
