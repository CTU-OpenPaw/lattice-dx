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
