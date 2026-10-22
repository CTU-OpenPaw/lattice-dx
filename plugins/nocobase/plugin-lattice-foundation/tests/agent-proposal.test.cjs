// SPDX-License-Identifier: Apache-2.0
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAgentRunComponent } = require('../src/applications/incident/agent-run');
const { createEvidenceProposalComponent } = require('../src/applications/incident/evidence-proposal');

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

test('AgentRun renders with status badge, process stepper, and starts analysis', async () => {
  const env = hooks();
  const AgentRun = createAgentRunComponent(env.react);
  let workflowPayload = null;

  const caseItem = {
    id: 'case-run-001',
    status: 'investigating',
    version: 1,
    assetEntityId: 'urn:ngsi-ld:Asset:DEMO-ASSET-01'
  };

  const api = {
    agent: async (op) => {
      if (op === 'list') return { items: [] };
      return null;
    },
    workflow: async (op, arg) => {
      if (op === 'transition') {
        workflowPayload = arg;
        return { version: 2 };
      }
      return { items: [] };
    }
  };

  const render = () => env.render(() => AgentRun({ api, connection: { connected: true }, caseItem, runId: caseItem.id }));
  render(); await tick();
  let tree = render();

  const str = JSON.stringify(tree);
  assert.ok(str.includes('Tác vụ AI Agent'));
  assert.ok(str.includes('1. Đọc số đo cảm biến'));
  assert.ok(str.includes('2. Đối chiếu luật cảnh báo'));
  assert.ok(str.includes('3. Tổng hợp đề xuất'));

  const startBtn = find(tree, n => n.props?.['data-testid'] === 'lattice-agent-start-btn');
  assert.ok(startBtn, 'Start analysis button must exist in investigating status');

  await startBtn.props.onClick();
  render(); await tick();
  tree = render();

  assert.ok(workflowPayload, 'Transition API must be called');
  assert.equal(workflowPayload.id, 'case-run-001');
  assert.equal(workflowPayload.body.action, 'request_analysis');
});

test('AgentRun displays diagnostic error box on failure and supports retry', async () => {
  const env = hooks();
  const AgentRun = createAgentRunComponent(env.react);
  let retryPayload = null;

  const failedJob = {
    id: '11111111-2222-3333-4444-555555555555',
    runId: 'case-fail-002',
    status: 'failed',
    errorCode: 'model_unavailable',
    attempts: 2,
    version: 2
  };

  const caseItem = {
    id: 'case-fail-002',
    status: 'analysis_failed',
    version: 2
  };

  const api = {
    agent: async (op, arg) => {
      if (op === 'list') return { items: [failedJob] };
      if (op === 'retry') {
        retryPayload = arg;
        return { version: 3 };
      }
      return null;
    },
    workflow: async () => ({ items: [] })
  };

  const render = () => env.render(() => AgentRun({ api, connection: { connected: true }, caseItem, runId: caseItem.id }));
  render(); await tick();
  let tree = render();

  const str = JSON.stringify(tree);
  assert.ok(str.includes('Phân tích thất bại'));
  assert.ok(str.includes('Dịch vụ mô hình AI (Model Runtime) tạm thời không phản hồi'));

  const retryBtn = find(tree, n => n.props?.['data-testid'] === 'lattice-agent-retry-btn');
  assert.ok(retryBtn, 'Retry button must exist for failed analysis');

  await retryBtn.props.onClick();
  render(); await tick();
  tree = render();

  assert.ok(retryPayload, 'Agent retry API must be called');
  assert.equal(retryPayload.id, '11111111-2222-3333-4444-555555555555');
  assert.equal(retryPayload.body.expectedVersion, 2);
});

test('EvidenceProposal renders proposal, evidence citations, and supports manager approve/reject', async () => {
  const env = hooks();
  const EvidenceProposal = createEvidenceProposalComponent(env.react);
  let approvePayload = null;
  let rejectPayload = null;

  const sampleProposal = {
    proposalId: 'prop-test-100',
    summary: 'Phát hiện nhiệt độ 78.5°C vượt ngưỡng 60.0°C. Đề xuất sửa chữa bơm và thay dung dịch.',
    suggestedStatus: 'repair',
    confidence: '95%',
    evidence: [
      'Nhiệt độ đo được: 78.5°C tại PUMP-01',
      'Luật vi phạm: RULE-TEMP-01 (ngưỡng gt 60 celsius)',
      'Tài sản: urn:ngsi-ld:Asset:PUMP-01'
    ]
  };

  const caseItem = {
    id: 'case-prop-001',
    status: 'review_pending',
    version: 1,
    proposal: sampleProposal
  };

  const api = {
    workflow: async (op, arg) => {
      if (op === 'transition') {
        if (arg.body.action === 'approve') approvePayload = arg;
        if (arg.body.action === 'reject') rejectPayload = arg;
        return { version: 2 };
      }
      return {};
    }
  };

  const render = () => env.render(() => EvidenceProposal({ api, connection: { connected: true }, caseItem, proposal: sampleProposal }));
  render(); await tick();
  let tree = render();

  // Tab 1: Proposal Content
  let str = JSON.stringify(tree);
  assert.ok(str.includes('Yêu cầu sửa chữa (Repair)'));
  assert.ok(str.includes('Phát hiện nhiệt độ 78.5°C vượt ngưỡng 60.0°C'));

  // Switch to Tab 2: Evidence Ledger
  const evidenceTabBtn = find(tree, n => n.props?.['data-testid'] === 'lattice-tab-evidence-btn');
  assert.ok(evidenceTabBtn, 'Evidence tab button must exist');
  evidenceTabBtn.props.onClick();

  render(); await tick();
  tree = render();
  str = JSON.stringify(tree);
  assert.ok(str.includes('[E1]'));
  assert.ok(str.includes('Nhiệt độ đo được: 78.5°C'));
  assert.ok(str.includes('RULE-TEMP-01'));

  // Switch to Tab 3: Review Panel
  const reviewTabBtn = find(tree, n => n.props?.['data-testid'] === 'lattice-tab-review-btn');
  assert.ok(reviewTabBtn, 'Review tab button must exist');
  reviewTabBtn.props.onClick();

  render(); await tick();
  tree = render();

  const noteInput = find(tree, n => n.props?.['data-testid'] === 'lattice-review-note-input');
  assert.ok(noteInput, 'Note input must exist');
  noteInput.props.onChange({ target: { value: 'Quản lý duyệt: Cần dừng máy ngay để thay van' } });

  render(); await tick();
  tree = render();

  const approveBtn = find(tree, n => n.props?.['data-testid'] === 'lattice-proposal-approve-btn');
  assert.ok(approveBtn, 'Approve button must exist');
  await approveBtn.props.onClick();

  render(); await tick();
  tree = render();

  assert.ok(approvePayload, 'Approve transition payload must be sent');
  assert.equal(approvePayload.id, 'case-prop-001');
  assert.equal(approvePayload.body.action, 'approve');
  assert.equal(approvePayload.body.input.reviewNote, 'Quản lý duyệt: Cần dừng máy ngay để thay van');
});

test('EvidenceProposal supports rejection and rework workflow', async () => {
  const env = hooks();
  const EvidenceProposal = createEvidenceProposalComponent(env.react);
  let reworkPayload = null;

  const caseItemRejected = {
    id: 'case-prop-002',
    status: 'rejected',
    version: 2
  };

  const api = {
    workflow: async (op, arg) => {
      if (op === 'transition' && arg.body.action === 'rework') {
        reworkPayload = arg;
        return { version: 3 };
      }
      return {};
    }
  };

  const render = () => env.render(() => EvidenceProposal({ api, connection: { connected: true }, caseItem: caseItemRejected }));
  render(); await tick();
  let tree = render();

  // Switch to Review Tab
  const reviewTabBtn = find(tree, n => n.props?.['data-testid'] === 'lattice-tab-review-btn');
  reviewTabBtn.props.onClick();

  render(); await tick();
  tree = render();

  const noteInput = find(tree, n => n.props?.['data-testid'] === 'lattice-review-note-input');
  noteInput.props.onChange({ target: { value: 'Kỹ thuật viên yêu cầu đo lại rung động trước khi kết luận' } });

  render(); await tick();
  tree = render();

  const reworkBtn = find(tree, n => n.props?.['data-testid'] === 'lattice-proposal-rework-btn');
  assert.ok(reworkBtn, 'Rework button must exist in rejected status');
  await reworkBtn.props.onClick();

  assert.ok(reworkPayload, 'Rework transition payload must be sent');
  assert.equal(reworkPayload.id, 'case-prop-002');
  assert.equal(reworkPayload.body.action, 'rework');
  assert.equal(reworkPayload.body.input.reworkNote, 'Kỹ thuật viên yêu cầu đo lại rung động trước khi kết luận');
});
