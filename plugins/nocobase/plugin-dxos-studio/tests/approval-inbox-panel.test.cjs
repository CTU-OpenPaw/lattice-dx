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
const SOURCE_PATH = path.join(PLUGIN_ROOT, 'src/client/approval-inbox-panel.js');
const HEADER_SCRIPT = path.resolve(PLUGIN_ROOT, '../../../scripts/source-headers.mjs');

function collectNodes(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) collectNodes(item, pred, out);
    return out;
  }
  if (pred(node)) out.push(node);
  if (Array.isArray(node.children)) collectNodes(node.children, pred, out);
  return out;
}

function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && typeof node === 'object' && Array.isArray(node.children)) return textOf(node.children);
  return '';
}

function createReactHarness() {
  const statesByComponent = new WeakMap();
  const effectsByComponent = new WeakMap();
  const memosByComponent = new WeakMap();
  let currentComponent = null;
  let stateIdx = 0;
  let effectIdx = 0;
  let memoIdx = 0;
  const pendingEffects = [];

  function getBucket(map, comp) {
    let arr = map.get(comp);
    if (!arr) {
      arr = [];
      map.set(comp, arr);
    }
    return arr;
  }

  const React = {
    Fragment: 'Fragment',
    createElement(type, props, ...children) {
      const flat = [];
      for (const c of children) {
        if (Array.isArray(c)) flat.push(...c);
        else flat.push(c);
      }
      return { type, props: props || {}, children: flat };
    },
    useState(init) {
      const comp = currentComponent;
      const bucket = getBucket(statesByComponent, comp);
      const idx = stateIdx++;
      if (bucket.length <= idx) {
        bucket[idx] = typeof init === 'function' ? init() : init;
      }
      const setState = (next) => {
        bucket[idx] = typeof next === 'function' ? next(bucket[idx]) : next;
      };
      return [bucket[idx], setState];
    },
    useEffect(fn, deps) {
      const comp = currentComponent;
      const bucket = getBucket(effectsByComponent, comp);
      const idx = effectIdx++;
      const prev = bucket[idx];
      const changed = !prev || !Array.isArray(deps) || deps.length !== prev.deps?.length || deps.some((d, i) => !Object.is(d, prev.deps[i]));
      if (changed) {
        bucket[idx] = { deps: Array.isArray(deps) ? deps.slice() : null };
        pendingEffects.push(fn);
      }
    },
    useCallback(fn) {
      return fn;
    },
    useMemo(fn, deps) {
      const comp = currentComponent;
      const bucket = getBucket(memosByComponent, comp);
      const idx = memoIdx++;
      const prev = bucket[idx];
      const changed = !prev || !Array.isArray(deps) || deps.length !== prev.deps?.length || deps.some((d, i) => !Object.is(d, prev.deps[i]));
      if (changed) {
        bucket[idx] = { deps: Array.isArray(deps) ? deps.slice() : null, value: fn() };
      }
      return bucket[idx].value;
    },
  };

  function renderNode(node) {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(renderNode);
    if (typeof node.type === 'function') {
      const prevComp = currentComponent;
      const prevS = stateIdx;
      const prevE = effectIdx;
      const prevM = memoIdx;
      currentComponent = node.type;
      stateIdx = 0;
      effectIdx = 0;
      memoIdx = 0;
      let out;
      try {
        out = node.type(node.props || {});
      } finally {
        currentComponent = prevComp;
        stateIdx = prevS;
        effectIdx = prevE;
        memoIdx = prevM;
      }
      return renderNode(out);
    }
    if (Array.isArray(node.children)) {
      return { ...node, children: node.children.map(renderNode) };
    }
    return node;
  }

  async function mountAndFlush(ComponentFn, props = {}) {
    let tree = renderNode(React.createElement(ComponentFn, props));
    for (let pass = 0; pass < 5 && pendingEffects.length > 0; pass += 1) {
      const batch = pendingEffects.splice(0, pendingEffects.length);
      for (const eff of batch) {
        await eff();
      }
      await new Promise((resolve) => setImmediate(resolve));
      tree = renderNode(React.createElement(ComponentFn, props));
    }
    return tree;
  }

  return {
    React,
    render: (ComponentFn, props = {}) => renderNode(React.createElement(ComponentFn, props)),
    mountAndFlush,
  };
}

function createApiMock(handlers) {
  const requests = [];
  const client = {
    useAPIClient: () => ({
      async request(req) {
        requests.push({
          url: req.url,
          method: (req.method || 'get').toLowerCase(),
          params: req.params || null,
          data: req.data || null,
        });
        const key = `${(req.method || 'get').toLowerCase()} ${req.url}`;
        const fn = handlers[key] || handlers[req.url];
        if (!fn) return { data: { data: {} } };
        const payload = await fn(req);
        return { data: { data: payload } };
      },
    }),
  };
  return { client, requests };
}

test('approval-inbox-panel exports required symbols and obeys Studio security & SPDX header rules', async () => {
  const mod = require(SOURCE_PATH);
  assert.ok(Array.isArray(mod.APPROVAL_SOURCE_TABS));
  assert.deepEqual(mod.APPROVAL_SOURCE_TABS.map((t) => t.id), ['all', 'business', 'ai_hitl', 'flow', 'proposals']);
  assert.equal(typeof mod.createApprovalInboxPanel, 'function');
  assert.equal(typeof mod.ApprovalInboxPanel, 'function');

  const { addSourceHeader } = await import(pathToFileURL(HEADER_SCRIPT).href);
  for (const filePath of [SOURCE_PATH, __filename]) {
    const fileSrc = readFileSync(filePath, 'utf8');
    assert.equal(addSourceHeader(fileSrc, filePath).status, 'present', `SPDX header must be present in ${filePath}`);
  }
  const src = readFileSync(SOURCE_PATH, 'utf8');
  assert.doesNotMatch(src, /require\(['"](?:react|antd|@nocobase\/client)['"]\)/);
  assert.doesNotMatch(src, /\blocalStorage\b|\bsessionStorage\b/);
  assert.doesNotMatch(src, /dangerouslySetInnerHTML/);
});

test('renders mixed inbox (business M-of-N, ai_hitl diffPreview, flow), delegation banner & badge, and source/status/assigned filters', async () => {
  const { createApprovalInboxPanel } = require(SOURCE_PATH);
  const harness = createReactHarness();
  const inboxItems = [
    {
      itemKey: 'biz-REQ-100',
      source: 'business',
      requestUid: 'APR-100',
      title: 'Phê duyệt đơn hàng PO-100',
      targetCollection: 'latticeOrders',
      targetRecordId: '100',
      targetCode: 'PO-100',
      requesterUsername: 'alice',
      riskLevel: 'high',
      status: 'pending',
      dueAt: '2026-11-26T10:00:00.000Z',
      stagesStateJson: [
        {
          stageIndex: 0,
          name: 'Quản lý Vùng (M-of-N)',
          mode: 'parallel',
          requiredApprovals: 2,
          approverRoles: ['ldx_manager'],
          status: 'pending',
          decisions: [
            { userId: 11, username: 'bob', decision: 'approve', note: 'OK stage 1', decidedAt: '2026-11-25T09:00:00.000Z', delegationUid: 'DLG-9001' },
          ],
        },
        {
          stageIndex: 1,
          name: 'Giám đốc Tài chính',
          mode: 'sequential',
          requiredApprovals: 1,
          approverRoles: ['ldx_admin'],
          status: 'pending',
          decisions: [],
        },
      ],
    },
    {
      itemKey: 'ai-55',
      source: 'ai_hitl',
      id: 55,
      title: 'AI cập nhật tồn kho an toàn',
      aiEmployee: 'dxos-operator',
      toolName: 'dxos_update_record',
      targetCollection: 'latticeAssets',
      targetRecordId: '12',
      requesterUsername: 'ai_bot',
      riskLevel: 'medium',
      status: 'pending',
      diffPreview: {
        summary: 'Tăng ngưỡng bảo trì định kỳ',
        changes: [{ field: 'maintenanceDays', before: 30, after: 45 }],
      },
    },
    {
      itemKey: 'flow-run-9',
      source: 'flow',
      runUid: 'RUN-9',
      id: 77,
      title: 'Tạm dừng phê duyệt Flow bảo trì',
      targetCollection: 'latticeIncidentCases',
      targetRecordId: '9',
      requesterUsername: 'system',
      riskLevel: 'critical',
      status: 'suspended',
      diffPreview: { summary: 'Xác nhận đóng sự cố khẩn cấp' },
    },
  ];

  const { client, requests } = createApiMock({
    'get dxosDelegations:activeForUser': async () => ({
      organizationId: 'org-a',
      items: [
        {
          delegationUid: 'DLG-9001',
          delegatorUserId: 9,
          delegateUserId: 15,
          roleName: 'ldx_manager',
          scopeCollection: 'latticeOrders',
          endsAt: '2026-12-01T00:00:00.000Z',
          status: 'active',
        },
      ],
      roles: ['ldx_manager'],
    }),
    'get dxosApprovals:listInbox': async (req) => {
      const src = req.params?.source || 'all';
      const filtered = src === 'all' ? inboxItems : inboxItems.filter((i) => i.source === src);
      return {
        organizationId: 'org-a',
        items: filtered,
        total: filtered.length,
        counts: { all: 3, business: 1, ai_hitl: 1, flow: 1 },
      };
    },
  });

  const Panel = createApprovalInboxPanel(client, harness.React, {}, {});
  let tree = await harness.mountAndFlush(Panel, { selectedOrg: 'org-a', organizations: ['org-a'] });

  const banner = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-approvals-delegation-banner')[0];
  assert.ok(banner, 'Delegation banner must render');
  assert.ok(textOf(banner).includes('DLG-9001'));
  assert.ok(textOf(banner).includes('ldx_manager'));

  const bizCard = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-approval-card-biz-REQ-100')[0];
  assert.ok(bizCard);
  const stagesEl = collectNodes(bizCard, (n) => n.props?.['data-testid'] === 'dxos-approval-stages-biz-REQ-100')[0];
  assert.ok(stagesEl);
  assert.ok(textOf(stagesEl).includes('1/2'), 'M-of-N quorum progress 1/2 must be displayed');
  assert.ok(collectNodes(bizCard, (n) => n.props?.['data-testid'] === 'dxos-approval-delegation-biz-REQ-100').length >= 1);

  const aiDiff = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-approval-diff-ai-55')[0];
  assert.ok(aiDiff && textOf(aiDiff).includes('maintenanceDays'));

  // Filter source tab -> ai_hitl
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-approvals-source-ai_hitl')[0].props.onClick();
  tree = await harness.mountAndFlush(Panel, { selectedOrg: 'org-a', organizations: ['org-a'] });
  assert.ok(requests.some((r) => r.url === 'dxosApprovals:listInbox' && r.params?.source === 'ai_hitl'));
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-approval-card-biz-REQ-100').length, 0);

  // Status filter + assignedToMe toggle
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-approvals-status-filter')[0].props.onChange({ target: { value: 'all' } });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-approvals-assigned-toggle')[0].props.onChange({ target: { checked: true } });
  tree = await harness.mountAndFlush(Panel, { selectedOrg: 'org-a', organizations: ['org-a'] });
  assert.ok(requests.some((r) => r.url === 'dxosApprovals:listInbox' && r.params?.status === 'all' && r.params?.assignedToMe === true));
});

test('Approve calls dxosApprovals:decide and Reject requires >= 3 char note before calling API', async () => {
  const { ApprovalInboxPanel } = require(SOURCE_PATH);
  const harness = createReactHarness();
  const items = [
    {
      itemKey: 'ai-90',
      source: 'ai_hitl',
      id: 90,
      title: 'Phê duyệt đề xuất AI',
      targetCollection: 'latticeRequests',
      targetRecordId: '90',
      riskLevel: 'high',
      status: 'pending',
    },
  ];
  const { client, requests } = createApiMock({
    'get dxosStudio:listEmployees': async () => ({ items: [], organizations: ['org-auto'] }),
    'get dxosDelegations:activeForUser': async () => { throw new Error('404 unavailable'); },
    'get dxosApprovals:listInbox': async () => ({ organizationId: 'org-auto', items, total: 1 }),
    'post dxosApprovals:decide': async (req) => ({ ok: true, decision: req.data.decision }),
  });

  let tree = await harness.mountAndFlush(ApprovalInboxPanel, { React: harness.React, client });

  // Reject with short note (< 3 chars) must be blocked client-side
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-approval-note-ai-90')[0].props.onChange({ target: { value: 'no' } });
  tree = harness.render(ApprovalInboxPanel, { React: harness.React, client });
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-approval-reject-ai-90')[0].props.onClick();
  assert.equal(requests.some((r) => r.url === 'dxosApprovals:decide'), false);

  // Reject with valid note (>= 3 chars)
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-approval-note-ai-90')[0].props.onChange({ target: { value: 'Sai định mức' } });
  tree = harness.render(ApprovalInboxPanel, { React: harness.React, client });
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-approval-reject-ai-90')[0].props.onClick();
  assert.ok(requests.some((r) => r.url === 'dxosApprovals:decide' && r.data.decision === 'reject' && r.data.note === 'Sai định mức'));

  // Approve
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-approval-approve-ai-90')[0].props.onClick();
  assert.ok(requests.some((r) => r.url === 'dxosApprovals:decide' && r.data.decision === 'approve' && r.data.source === 'ai_hitl'));
});

test('resists [null] array elements across inbox items, stages, decisions, delegations, and diffPreview.changes', async () => {
  const { createApprovalInboxPanel } = require(SOURCE_PATH);
  const harness = createReactHarness();
  const { client } = createApiMock({
    'get dxosDelegations:activeForUser': async () => ({
      organizationId: 'org-a',
      items: [
        null,
        {
          delegationUid: 'DLG-NULLSAFE',
          roleName: 'ldx_manager',
          scopeCollection: 'latticeOrders',
          endsAt: '2026-12-01T00:00:00.000Z',
        },
      ],
    }),
    'get dxosApprovals:listInbox': async () => ({
      organizationId: 'org-a',
      items: [
        null,
        {
          itemKey: 'biz-NULLSAFE-1',
          source: 'business',
          title: 'Null-safe M-of-N Request',
          targetCollection: 'latticeOrders',
          targetRecordId: '101',
          requesterUsername: 'alice',
          riskLevel: 'medium',
          status: 'pending',
          stagesStateJson: [
            null,
            {
              stageIndex: 0,
              name: 'Manager Stage',
              mode: 'parallel',
              requiredApprovals: 2,
              approverRoles: ['ldx_manager'],
              status: 'pending',
              decisions: [null, { userId: 22, username: 'carol', decision: 'approve', delegationUid: 'DLG-NULLSAFE' }],
            },
          ],
          diffPreview: {
            summary: 'Null-safe diff',
            changes: [null, { field: 'amount', before: 100, after: 120 }],
          },
        },
      ],
      total: 1,
    }),
  });

  const Panel = createApprovalInboxPanel(client, harness.React, {}, {});
  const tree = await harness.mountAndFlush(Panel, { selectedOrg: 'org-a', organizations: ['org-a'] });

  const card = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-approval-card-biz-NULLSAFE-1')[0];
  assert.ok(card, 'Valid item alongside null entries must still render');
  assert.ok(textOf(card).includes('Manager Stage'));
  assert.ok(textOf(card).includes('carol: approve'));
  assert.ok(textOf(card).includes('amount: 100 -> 120'));
  const dlgBanner = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-approvals-delegation-banner')[0];
  assert.ok(dlgBanner && textOf(dlgBanner).includes('DLG-NULLSAFE'));
});

test('formatDiffPreview handles old/new, before/after objects, and ApprovalInboxPanel renders Vietnamese risk/status badges', async () => {
  const { createApprovalInboxPanel, formatDiffPreview, riskLabel, statusLabel } = require(SOURCE_PATH);

  assert.equal(riskLabel('high'), 'Cao');
  assert.equal(riskLabel('medium'), 'Trung bình');
  assert.equal(riskLabel('low'), 'Thấp');
  assert.equal(statusLabel('pending'), 'Chờ duyệt');
  assert.equal(statusLabel('approved'), 'Đã duyệt');
  assert.equal(statusLabel('rejected'), 'Từ chối');

  const fromOldNew = formatDiffPreview({
    summary: 'Cập nhật hạn mức',
    changes: [{ field: 'limit', old: 100, new: 250 }],
  });
  assert.deepEqual(fromOldNew, { summary: 'Cập nhật hạn mức', changes: [{ field: 'limit', before: 100, after: 250 }] });

  const fromObjectPair = formatDiffPreview({
    before: { status: 'draft', qty: 5 },
    after: { status: 'submitted', qty: 10 },
  });
  assert.equal(fromObjectPair.changes.length, 2);
  assert.deepEqual(fromObjectPair.changes[0], { field: 'status', before: 'draft', after: 'submitted' });

  const harness = createReactHarness();
  const { client } = createApiMock({
    'get dxosDelegations:activeForUser': async () => ({ items: [], roles: [] }),
    'get dxosApprovals:listInbox': async () => ({
      organizationId: 'org-a',
      items: [
        {
          itemKey: 'ai-diff-1',
          source: 'ai_hitl',
          id: 101,
          title: 'Đổi mức ưu tiên đơn hàng',
          targetCollection: 'latticeOrders',
          targetRecordId: '501',
          requesterUsername: 'ai_ops',
          riskLevel: 'high',
          status: 'pending',
          diffPreview: {
            before: { priority: 'medium', threshold: 8 },
            after: { priority: 'high', threshold: 4 },
          },
        },
      ],
      total: 1,
    }),
  });

  const Panel = createApprovalInboxPanel(client, harness.React, {}, {});
  const tree = await harness.mountAndFlush(Panel, { selectedOrg: 'org-a', organizations: ['org-a'] });
  const card = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-approval-card-ai-diff-1')[0];
  const cardText = textOf(card);
  assert.ok(cardText.includes('Rủi ro: Cao'));
  assert.ok(cardText.includes('Chờ duyệt'));
  assert.ok(cardText.includes('priority: "medium" -> "high"'));
  assert.ok(cardText.includes('threshold: 8 -> 4'));
});

test('proposals tab, evidence badges, reviewed status, and Asia/Ho_Chi_Minh (+07:00) SLA formatting', async () => {
  const { createApprovalInboxPanel, statusLabel } = require(SOURCE_PATH);
  assert.equal(statusLabel('reviewed'), 'Đã xem xét');

  const harness = createReactHarness();
  const proposalItem = {
    itemKey: 'prop:77',
    source: 'proposals',
    id: 77,
    title: 'Đề xuất AI: latticeIncidentCases #501',
    summary: 'Kiểm tra van lạnh ngay.',
    targetCollection: 'latticeIncidentCases',
    targetRecordId: 501,
    requesterUsername: 'ai_agent',
    riskLevel: 'medium',
    status: 'pending',
    proposalState: 'proposed',
    dueAt: '2026-11-26T10:00:00.000Z',
    diffPreview: { summary: 'Kiểm tra van lạnh ngay.', changes: [] },
    evidence: [
      { kind: 'native-record', collection: 'latticeIncidentCases', recordId: 501, fingerprint: 'fp-abc' },
      { kind: 'ngsi-ld', entityId: 'urn:ngsi-ld:Asset:org-a:native:9', fingerprint: 'ctx-xyz' },
    ],
    canAct: true,
  };

  const { client, requests } = createApiMock({
    'get dxosDelegations:activeForUser': async () => ({ items: [], roles: [] }),
    'get dxosApprovals:listInbox': async (req) => ({
      organizationId: 'org-a',
      items: req.params?.source === 'business' ? [] : [proposalItem],
      total: req.params?.source === 'business' ? 0 : 1,
      counts: { all: 1, business: 0, ai_hitl: 0, flow: 0, proposals: 1 },
    }),
    'post dxosApprovals:decide': async (req) => ({ ok: true, state: 'approved', decision: req.data.decision }),
  });

  const Panel = createApprovalInboxPanel(client, harness.React, {}, {});
  let tree = await harness.mountAndFlush(Panel, { selectedOrg: 'org-a', organizations: ['org-a'] });

  const tab = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-approvals-source-proposals')[0];
  assert.ok(tab, 'Proposals tab must render');
  assert.ok(textOf(tab).includes('Đề xuất AI (1)'));

  tab.props.onClick();
  tree = await harness.mountAndFlush(Panel, { selectedOrg: 'org-a', organizations: ['org-a'] });
  assert.ok(requests.some((r) => r.url === 'dxosApprovals:listInbox' && r.params?.source === 'proposals'));

  const card = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-approval-card-prop:77')[0];
  assert.ok(card);
  const txt = textOf(card);
  assert.ok(txt.includes('Đề xuất AI'), 'Source badge must display Đề xuất AI');
  assert.ok(txt.includes('17:00') && txt.includes('+07:00'), `Expected +07:00 SLA timestamp in ${txt}`);
  assert.ok(txt.includes('native-record'), 'Evidence badge must display native-record');
  assert.ok(txt.includes('ngsi-ld'), 'Evidence badge must display ngsi-ld');

  await collectNodes(card, (n) => n.props?.['data-testid'] === 'dxos-approval-approve-prop:77')[0].props.onClick();
  assert.ok(requests.some((r) => r.url === 'dxosApprovals:decide' && r.data.source === 'proposals' && r.data.decision === 'approve'));
});

test('P1-04: ApprovalInboxPanel supports proposal review CTA, bulk select/approve/reject, search, and Policy Management Drawer (no ldx_admin)', async () => {
  const { createApprovalInboxPanel } = require(SOURCE_PATH);
  const harness = createReactHarness();
  const inboxItems = [
    { itemKey: 'prop:81', id: 81, source: 'proposals', title: 'Proposal PO-81', status: 'pending', riskLevel: 'low' },
    { itemKey: 'biz:82', id: 82, source: 'business', title: 'Order PO-82', status: 'pending', riskLevel: 'high' },
  ];
  let policies = [
    { id: 1, policyKey: 'po-default', name: 'PO Default', targetCollection: 'latticeOrders', slaMinutes: 120, escalateToRole: 'ldx_manager' },
  ];

  const { client, requests } = createApiMock({
    'get dxosDelegations:activeForUser': async () => ({ items: [], roles: [] }),
    'get dxosApprovals:listInbox': async () => ({
      organizationId: 'org-a',
      items: inboxItems,
      total: 2,
      counts: { business: 1, proposals: 1, ai_hitl: 0, flow: 0, total: 2 },
    }),
    'post dxosApprovals:decide': async (req) => ({ ok: true, decision: req.data.decision }),
    'get dxosApprovals:listPolicies': async () => ({ items: policies }),
    'post dxosApprovals:savePolicy': async (req) => {
      policies = [...policies, req.data];
      return req.data;
    },
    'post dxosApprovals:deletePolicy': async (req) => {
      policies = policies.filter((p) => p.policyKey !== req.data.policyKey);
      return { deleted: true };
    },
    'post dxosApprovals:evaluateSlaNow': async () => ({ checkedCount: 2, escalatedCount: 1 }),
  });

  const Panel = createApprovalInboxPanel(client, harness.React, {}, {});
  let tree = await harness.mountAndFlush(Panel, { selectedOrg: 'org-a', organizations: ['org-a'] });

  // counts.total fallback on 'all' tab
  const allTab = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-approvals-source-all')[0];
  assert.ok(textOf(allTab).includes('Tất cả (2)'));

  // Search input triggers listInbox with search param
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-approvals-search-input')[0].props.onChange({ target: { value: 'PO-81' } });
  tree = await harness.mountAndFlush(Panel, { selectedOrg: 'org-a', organizations: ['org-a'] });
  assert.ok(requests.some((r) => r.url === 'dxosApprovals:listInbox' && r.params?.search === 'PO-81'));

  // Review CTA on proposal
  const reviewBtn = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-approval-review-prop:81')[0];
  assert.ok(reviewBtn, 'Proposal card must render Review CTA');
  await reviewBtn.props.onClick();
  assert.ok(requests.some((r) => r.url === 'dxosApprovals:decide' && r.data.itemKey === 'prop:81' && r.data.decision === 'review'));

  // Select all & bulk approve
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-approvals-select-all')[0].props.onChange({ target: { checked: true } });
  tree = harness.render(Panel, { selectedOrg: 'org-a', organizations: ['org-a'] });
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-approvals-bulk-approve')[0].props.onClick();
  const bulkApproveCalls = requests.filter((r) => r.url === 'dxosApprovals:decide' && r.data.decision === 'approve');
  assert.equal(bulkApproveCalls.length, 2);

  // Open Policy Management Drawer & verify ldx_admin is excluded from escalateToRole options
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-approvals-policies-btn')[0].props.onClick();
  tree = harness.render(Panel, { selectedOrg: 'org-a', organizations: ['org-a'] });
  const drawer = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-approvals-policies-drawer')[0];
  assert.ok(drawer);
  const escalateSelect = collectNodes(drawer, (n) => n.props?.['data-testid'] === 'dxos-policy-escalate-select')[0];
  const roleVals = collectNodes(escalateSelect, (n) => n.type === 'option').map((o) => o.props.value);
  assert.equal(roleVals.includes('ldx_admin'), false, 'Forbidden role ldx_admin must not appear in escalateToRole options');
  assert.ok(roleVals.includes('ldx_manager'));

  // Save policy + evaluate SLA now
  collectNodes(drawer, (n) => n.props?.['data-testid'] === 'dxos-policy-key-input')[0].props.onChange({ target: { value: 'po-urgent' } });
  collectNodes(drawer, (n) => n.props?.['data-testid'] === 'dxos-policy-name-input')[0].props.onChange({ target: { value: 'PO Urgent' } });
  tree = harness.render(Panel, { selectedOrg: 'org-a', organizations: ['org-a'] });
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-approvals-policy-form')[0].props.onSubmit({ preventDefault() {} });
  assert.ok(requests.some((r) => r.url === 'dxosApprovals:savePolicy' && r.data.policyKey === 'po-urgent'));

  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-approvals-eval-sla-btn')[0].props.onClick();
  assert.ok(requests.some((r) => r.url === 'dxosApprovals:evaluateSlaNow'));
});

test('ApprovalInboxPanel skips dxosDelegations:activeForUser when organizationId is empty', async () => {
  const { createApprovalInboxPanel } = require(SOURCE_PATH);
  const harness = createReactHarness();
  const { client, requests } = createApiMock({
    'get dxosStudio:listEmployees': async () => ({ items: [], organizations: [] }),
    'get dxosApprovals:listInbox': async () => ({ items: [], total: 0, counts: {} }),
    'get dxosDelegations:activeForUser': async (req) => {
      if (!req.params?.organizationId) {
        const err = new Error('DELEGATION_ORG_REQUIRED');
        err.response = { status: 400 };
        throw err;
      }
      return { items: [], roles: [] };
    },
  });

  const Panel = createApprovalInboxPanel(client, harness.React, {}, {});
  await harness.mountAndFlush(Panel, { selectedOrg: '', organizations: [] });
  assert.equal(requests.some((r) => r.url === 'dxosApprovals:listInbox'), true);
  assert.equal(requests.some((r) => r.url === 'dxosDelegations:activeForUser'), false);
});

test('T1-STUDIO-05: ApprovalInboxPanel exposes data-counts-ready=false before hydration, true after settle, and keeps counts across tab switches', async () => {
  const { createApprovalInboxPanel } = require(SOURCE_PATH);
  const harness = createReactHarness();
  const { client } = createApiMock({
    'get dxosDelegations:activeForUser': async () => ({ items: [], roles: [] }),
    'get dxosApprovals:listInbox': async (req) => ({
      organizationId: 'org-a',
      items: req.params?.source === 'business'
        ? [{ itemKey: 'biz-1', source: 'business', title: 'Biz 1', status: 'pending', riskLevel: 'low' }]
        : [],
      total: 4,
      counts: { all: 4, total: 4, business: 1, ai_hitl: 1, flow: 1, proposals: 1 },
    }),
  });

  const Panel = createApprovalInboxPanel(client, harness.React, {}, {});
  const preTree = harness.render(Panel, { selectedOrg: 'org-a', organizations: ['org-a'] });
  const preInbox = collectNodes(preTree, (n) => n.props?.['data-testid'] === 'dxos-approval-inbox')[0];
  assert.equal(preInbox.props['data-counts-ready'], 'false');

  let tree = await harness.mountAndFlush(Panel, { selectedOrg: 'org-a', organizations: ['org-a'] });
  const hydratedInbox = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-approval-inbox')[0];
  assert.equal(hydratedInbox.props['data-counts-ready'], 'true');

  const initialLabels = Object.fromEntries(
    ['all', 'business', 'ai_hitl', 'flow', 'proposals'].map((k) => [
      k,
      textOf(collectNodes(tree, (n) => n.props?.['data-testid'] === `dxos-approvals-source-${k}`)[0]),
    ]),
  );
  assert.equal(initialLabels.ai_hitl, 'AI HITL (1)');

  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-approvals-source-business')[0].props.onClick();
  tree = await harness.mountAndFlush(Panel, { selectedOrg: 'org-a', organizations: ['org-a'] });
  const afterInbox = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-approval-inbox')[0];
  assert.equal(afterInbox.props['data-counts-ready'], 'true');
  for (const k of ['all', 'business', 'ai_hitl', 'flow', 'proposals']) {
    const afterLabel = textOf(collectNodes(tree, (n) => n.props?.['data-testid'] === `dxos-approvals-source-${k}`)[0]);
    assert.equal(afterLabel, initialLabels[k], `Tab ${k} label must remain unchanged on business tab click`);
  }
});

test('T1-STUDIO-05: ApprovalInboxPanel marks data-counts-ready=true even if initial listInbox rejects', async () => {
  const { createApprovalInboxPanel } = require(SOURCE_PATH);
  const harness = createReactHarness();
  const { client } = createApiMock({
    'get dxosApprovals:listInbox': async () => {
      throw new Error('503 inbox unavailable');
    },
  });

  const Panel = createApprovalInboxPanel(client, harness.React, {}, {});
  const tree = await harness.mountAndFlush(Panel, { selectedOrg: 'org-a', organizations: ['org-a'] });
  const inbox = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-approval-inbox')[0];
  assert.equal(inbox.props['data-counts-ready'], 'true');
});
