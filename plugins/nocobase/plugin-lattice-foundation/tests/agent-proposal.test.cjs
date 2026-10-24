// SPDX-License-Identifier: Apache-2.0
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createBridge } = require('../../action-bridge/bridge.cjs');
const { createAgentRunComponent } = require('../src/applications/incident/agent-run');
const { createEvidenceProposalComponent } = require('../src/applications/incident/evidence-proposal');

const runId = '11111111-1111-4111-8111-111111111111';
const jobId = '22222222-2222-4222-8222-222222222222';
const proposalId = '33333333-3333-4333-8333-333333333333';
const assetId = '44444444-4444-4444-8444-444444444444';
const notificationId = 'notification-incident-001';
const proposal = {
  summary: 'Nhiệt độ vượt ngưỡng; đề xuất sửa bơm và kiểm tra van tuần hoàn.',
  suggestedStatus: 'repair',
  evidence: ['temperature=78.5 celsius', 'threshold=60 celsius']
};
const caseItem = (status = 'review_pending', data = {}) => ({
  id: runId,
  title: 'Bơm làm mát quá nhiệt',
  status,
  version: 4,
  assetEntityId: assetId,
  notificationId,
  data: { assetEntityId: assetId, notificationId, agentJobId: jobId, proposalId, ...data }
});
const completedJob = overrides => ({
  id: jobId,
  runId,
  assetId,
  notificationId,
  status: 'completed',
  version: 3,
  attempts: 1,
  proposalId,
  proposal,
  ...overrides
});

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
      effects.forEach(effect => effect());
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

const tick = () => new Promise(setImmediate);

async function bridgeFixture({ job = completedJob(), jobReadStatuses = [], agentWriteStatuses = [], workflowStatuses = [] } = {}) {
  const calls = [];
  const readStatuses = [...jobReadStatuses];
  const writeStatuses = [...agentWriteStatuses];
  const transitionStatuses = [...workflowStatuses];
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
      if (url.endsWith('/user')) return Response.json({ sub: 'alice', organization_id: 'org-1' });
      if (url === `http://gateway/v1/agent-jobs/${jobId}`) {
        const status = readStatuses.shift() || 200;
        return Response.json(status >= 400 ? { error: 'Agent read denied' } : job, { status });
      }
      if (url === `http://gateway/v1/agent-jobs/${jobId}/retry`) {
        const status = writeStatuses.shift() || 200;
        return Response.json(status >= 400 ? { error: 'Agent retry failed' } : { ...job, status: 'queued', version: job.version + 1 }, { status });
      }
      if (url === `http://gateway/v1/workflows/${runId}/transitions`) {
        const status = transitionStatuses.shift() || 200;
        return Response.json(status >= 400 ? { error: 'Workflow transition failed' } : { id: runId, version: 5 }, { status });
      }
      return Response.json({ items: [] });
    }
  });
  const start = bridge.connect('noco');
  await bridge.callback({ state: new URL(start.authorizationUrl).searchParams.get('state'), code: 'fixture' }, start.browserId);
  return {
    api: {
      agent: (operation, args = {}) => bridge.agent('noco', start.browserId, { operation, ...args }),
      workflow: (operation, args = {}) => bridge.workflow('noco', start.browserId, { operation, ...args })
    },
    calls,
    connection: { connected: true, identity: { subject: 'alice', organizationId: 'org-1', username: 'Alice' } },
    close: () => bridge.disconnect('noco', start.browserId)
  };
}

function renderEvidence(env, props) {
  const EvidenceProposal = createEvidenceProposalComponent(env.react);
  const render = () => env.render(() => EvidenceProposal(props));
  return { render };
}

async function openReview(render) {
  let tree = render();
  const review = find(tree, node => node.props?.['data-testid'] === 'lattice-tab-review-btn');
  assert.ok(review, 'Review tab must exist');
  review.props.onClick();
  await tick();
  tree = render();
  return tree;
}

test('EvidenceProposal loads the immutable proposal from the workflow-linked completed agent job', async () => {
  const fixture = await bridgeFixture();
  const env = hooks();
  const { render } = renderEvidence(env, { api: fixture.api, connection: fixture.connection, caseItem: caseItem() });

  render(); await tick();
  let tree = render();
  let content = JSON.stringify(tree);
  assert.ok(content.includes(proposal.summary));
  assert.ok(content.includes(proposalId));
  assert.equal(content.includes('94%'), false);
  assert.equal(content.includes('RULE-PUMP-OVERHEAT'), false);
  assert.ok(fixture.calls.some(call => call.url === `http://gateway/v1/agent-jobs/${jobId}`));

  find(tree, node => node.props?.['data-testid'] === 'lattice-tab-evidence-btn').props.onClick();
  tree = render();
  assert.ok(JSON.stringify(tree).includes('temperature=78.5 celsius'));

  tree = await openReview(render);
  const approve = find(tree, node => node.props?.['data-testid'] === 'lattice-proposal-approve-btn');
  assert.ok(approve);
  assert.equal(approve.props.disabled, false);
  await approve.props.onClick();
  const transition = fixture.calls.find(call => call.url === `http://gateway/v1/workflows/${runId}/transitions`);
  assert.ok(transition, 'Approval must go through the workflow transition endpoint');
  assert.deepEqual(JSON.parse(transition.options.body), {
    action: 'approve',
    expectedVersion: 4,
    input: { reviewNote: 'Người quản lý duyệt đề xuất xử lý của AI' }
  });
  assert.ok(transition.options.headers['idempotency-key']);
  fixture.close();
});

test('EvidenceProposal shows no result and disables approve or reject when the workflow has no linked job', async () => {
  const fixture = await bridgeFixture();
  const env = hooks();
  const linkedRun = caseItem('review_pending', { agentJobId: undefined, proposalId: undefined });
  const { render } = renderEvidence(env, { api: fixture.api, connection: fixture.connection, caseItem: linkedRun });

  render(); await tick();
  let tree = render();
  assert.equal(JSON.stringify(tree).includes(proposal.summary), false);
  assert.ok(JSON.stringify(tree).includes('Chưa có kết quả phân tích'));
  tree = await openReview(render);
  assert.equal(find(tree, node => node.props?.['data-testid'] === 'lattice-proposal-approve-btn').props.disabled, true);
  assert.equal(find(tree, node => node.props?.['data-testid'] === 'lattice-proposal-reject-btn').props.disabled, true);
  assert.equal(fixture.calls.some(call => call.url.includes('/v1/agent-jobs/')), false);
  fixture.close();
});

test('EvidenceProposal rejects an agent result linked to a different run, proposal, asset or notification', async () => {
  const mismatches = [
    ['run', { runId: '55555555-5555-4555-8555-555555555555' }],
    ['proposal', { proposalId: '66666666-6666-4666-8666-666666666666' }],
    ['asset', { assetId: '77777777-7777-4777-8777-777777777777' }],
    ['notification', { notificationId: 'notification-other' }]
  ];
  for (const [scope, overrides] of mismatches) {
    const fixture = await bridgeFixture({ job: completedJob(overrides) });
    const env = hooks();
    const { render } = renderEvidence(env, { api: fixture.api, connection: fixture.connection, caseItem: caseItem() });

    render(); await tick();
    let tree = render();
    assert.equal(JSON.stringify(tree).includes(proposal.summary), false, `${scope} mismatch must not show proposal`);
    assert.ok(JSON.stringify(tree).includes('không khớp với hồ sơ sự cố'), `${scope} mismatch must be explained`);
    tree = await openReview(render);
    assert.equal(find(tree, node => node.props?.['data-testid'] === 'lattice-proposal-approve-btn').props.disabled, true);
    assert.equal(find(tree, node => node.props?.['data-testid'] === 'lattice-proposal-reject-btn').props.disabled, true);
    fixture.close();
  }
});

test('EvidenceProposal keeps review disabled when the linked job has no completed proposal', async () => {
  const fixture = await bridgeFixture({ job: completedJob({ status: 'queued', proposal: null }) });
  const env = hooks();
  const { render } = renderEvidence(env, { api: fixture.api, connection: fixture.connection, caseItem: caseItem() });

  render(); await tick();
  let tree = render();
  assert.equal(JSON.stringify(tree).includes(proposal.summary), false);
  assert.ok(JSON.stringify(tree).includes('Chưa có kết quả phân tích hoàn tất'));
  tree = await openReview(render);
  assert.equal(find(tree, node => node.props?.['data-testid'] === 'lattice-proposal-approve-btn').props.disabled, true);
  assert.equal(find(tree, node => node.props?.['data-testid'] === 'lattice-proposal-reject-btn').props.disabled, true);
  fixture.close();
});

test('EvidenceProposal reports denied job detail and leaves review actions disabled', async () => {
  const fixture = await bridgeFixture({ jobReadStatuses: [403] });
  const env = hooks();
  const { render } = renderEvidence(env, { api: fixture.api, connection: fixture.connection, caseItem: caseItem() });

  render(); await tick();
  let tree = render();
  assert.equal(JSON.stringify(tree).includes(proposal.summary), false);
  assert.ok(find(tree, node => node.props?.['data-testid'] === 'lattice-proposal-error'));
  tree = await openReview(render);
  assert.equal(find(tree, node => node.props?.['data-testid'] === 'lattice-proposal-approve-btn').props.disabled, true);
  fixture.close();
});

test('EvidenceProposal hides a late job result after actor scope changes', async () => {
  const resolvers = [];
  const env = hooks();
  const connection = { connected: true, identity: { subject: 'alice', organizationId: 'org-1' } };
  const api = {
    agent: () => new Promise(resolve => { resolvers.push(resolve); }),
    workflow: async () => ({ id: runId })
  };
  const { render } = renderEvidence(env, { api, connection, caseItem: caseItem() });

  render(); await tick();
  connection.identity = { subject: 'bob', organizationId: 'org-2' };
  let tree = render();
  assert.equal(JSON.stringify(tree).includes(proposal.summary), false);
  assert.equal(resolvers.length, 2, 'New scope starts a fresh detail read');
  resolvers[0](completedJob());
  await tick();
  tree = render();
  assert.equal(JSON.stringify(tree).includes(proposal.summary), false);
});

test('AgentRun starts analysis with a real transition and no generated job receipt', async () => {
  const fixture = await bridgeFixture({ workflowStatuses: [200] });
  const env = hooks();
  const AgentRun = createAgentRunComponent(env.react);
  const run = caseItem('investigating', { agentJobId: undefined, proposalId: undefined });
  const render = () => env.render(() => AgentRun({ api: fixture.api, connection: fixture.connection, caseItem: run, runId: run.id }));

  render(); await tick();
  let tree = render();
  const start = find(tree, node => node.props?.['data-testid'] === 'lattice-agent-start-btn');
  assert.ok(start);
  await start.props.onClick();
  tree = render();

  const transition = fixture.calls.find(call => call.url === `http://gateway/v1/workflows/${runId}/transitions`);
  assert.ok(transition);
  assert.deepEqual(JSON.parse(transition.options.body), { action: 'request_analysis', expectedVersion: 4, input: {} });
  assert.equal(JSON.stringify(tree).includes('job-started-'), false);
  fixture.close();
});

test('AgentRun does not carry an uncertain command from one run into another run', async () => {
  const calls = [];
  const api = {
    agent: async () => { throw new Error('No job should be read for an unlinked run'); },
    workflow: async (operation, args) => {
      calls.push({ operation, args });
      if (calls.length === 1) throw { status: 503, message: 'Uncertain workflow response' };
      return { id: args.id, version: 5 };
    }
  };
  const connection = { connected: true, identity: { subject: 'alice', organizationId: 'org-1' } };
  const env = hooks();
  const AgentRun = createAgentRunComponent(env.react);
  const runA = caseItem('investigating', { agentJobId: undefined, proposalId: undefined });
  const runB = { ...caseItem('investigating', { agentJobId: undefined, proposalId: undefined }), id: '55555555-5555-4555-8555-555555555555' };
  let selectedRun = runA;
  const render = () => env.render(() => AgentRun({ api, connection, caseItem: selectedRun, runId: selectedRun.id }));

  render(); await tick();
  let tree = render();
  await find(tree, node => node.props?.['data-testid'] === 'lattice-agent-start-btn').props.onClick();
  tree = render();
  assert.ok(find(tree, node => node.props?.['data-testid'] === 'lattice-agent-retry-command-btn'));

  selectedRun = runB;
  render(); await tick();
  tree = render();
  const startB = find(tree, node => node.props?.['data-testid'] === 'lattice-agent-start-btn');
  assert.ok(startB, 'The second run must be able to start independently');
  await startB.props.onClick();

  assert.equal(calls.length, 2);
  assert.equal(calls[0].args.id, runA.id);
  assert.equal(calls[1].args.id, runB.id);
  assert.notEqual(calls[0].args.key, calls[1].args.key);
  assert.deepEqual(calls[0].args.body, calls[1].args.body);
});

test('AgentRun retries an uncertain agent command with the same key and body', async () => {
  const failed = completedJob({ status: 'failed', version: 2, proposalId: null, proposal: null, errorCode: 'model_unavailable' });
  const fixture = await bridgeFixture({ job: failed, agentWriteStatuses: [503, 200] });
  const env = hooks();
  const AgentRun = createAgentRunComponent(env.react);
  const run = caseItem('analysis_failed');
  const render = () => env.render(() => AgentRun({ api: fixture.api, connection: fixture.connection, caseItem: run, runId: run.id }));

  render(); await tick();
  let tree = render();
  const retry = find(tree, node => node.props?.['data-testid'] === 'lattice-agent-retry-btn');
  assert.ok(retry);
  await retry.props.onClick();
  tree = render();
  const retryPending = find(tree, node => node.props?.['data-testid'] === 'lattice-agent-retry-command-btn');
  assert.ok(retryPending, 'Uncertain retry must remain available');
  await retryPending.props.onClick();

  const writes = fixture.calls.filter(call => call.url === `http://gateway/v1/agent-jobs/${jobId}/retry`);
  assert.equal(writes.length, 2);
  assert.equal(writes[0].options.headers['idempotency-key'], writes[1].options.headers['idempotency-key']);
  assert.equal(writes[0].options.body, writes[1].options.body);
  assert.deepEqual(JSON.parse(writes[0].options.body), { expectedVersion: 2 });
  fixture.close();
});
