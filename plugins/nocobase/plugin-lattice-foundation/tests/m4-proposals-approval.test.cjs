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
const Module = require('node:module');
const path = require('node:path');

function withMockedNocobase(fn) {
  const origLoad = Module._load;
  class MockMigration {
    constructor(context = {}) { this.context = context; }
  }
  Module._load = function mockedLoad(request, parent, isMain) {
    if (request === '@nocobase/server') {
      return { Migration: MockMigration };
    }
    if (request === '@nocobase/database') {
      return { defineCollection: (def) => def };
    }
    return origLoad.call(this, request, parent, isMain);
  };
  return Promise.resolve()
    .then(() => fn())
    .finally(() => {
      Module._load = origLoad;
    });
}

function makeProposalHarness(seed = {}) {
  const seqs = {};
  const nextId = (t) => {
    seqs[t] = (seqs[t] || 0) + 1;
    return seqs[t];
  };

  const tables = {
    latticeEmployees: (seed.employees || [
      { id: 10, userId: 101, organizationId: 'org-a', active: true, code: 'EMP-A1', name: 'Requester A', departmentId: 1 },
      { id: 11, userId: 102, organizationId: 'org-a', active: true, code: 'EMP-A2', name: 'Manager A1', departmentId: 1 },
      { id: 12, userId: 103, organizationId: 'org-a', active: true, code: 'EMP-A3', name: 'Director A', departmentId: 1 },
      { id: 13, userId: 105, organizationId: 'org-a', active: true, code: 'EMP-A5', name: 'Delegate A', departmentId: 1 },
      { id: 20, userId: 201, organizationId: 'org-b', active: true, code: 'EMP-B1', name: 'Manager B', departmentId: 2 },
    ]).map((r) => ({ ...r })),
    roles: (seed.roles || [
      { name: 'ldx_employee', title: 'Employee', allowConfigure: false, allowAll: false, snippets: [] },
      { name: 'ldx_manager', title: 'Manager', allowConfigure: false, allowAll: false, snippets: [] },
      { name: 'ldx_director', title: 'Director', allowConfigure: false, allowAll: false, snippets: [] },
      { name: 'ldx_admin', title: 'Admin', allowConfigure: true, allowAll: false, snippets: ['pm'] },
      { name: 'root', title: 'Root', allowConfigure: true, allowAll: true, snippets: ['*'] },
    ]).map((r) => ({ ...r })),
    rolesUsers: (seed.rolesUsers || [
      { userId: 101, roleName: 'ldx_employee' },
      { userId: 102, roleName: 'ldx_manager' },
      { userId: 103, roleName: 'ldx_director' },
      { userId: 105, roleName: 'ldx_employee' },
      { userId: 201, roleName: 'ldx_manager' },
      { userId: 1, roleName: 'root' },
    ]).map((r) => ({ ...r })),
    latticeApprovalPolicies: [],
    latticeApprovalRequests: [],
    latticeDelegations: (seed.delegations || []).map((r) => ({ ...r })),
    latticeNotifications: [],
    latticeAiApprovalQueue: [],
    latticeAutomationRuns: [],
    latticeAgentProposals: (seed.proposals || []).map((r) => ({ ...r })),
    latticeIncidentCases: (seed.incidents || []).map((r) => ({ ...r })),
    latticeOrders: (seed.orders || []).map((r) => ({ ...r })),
    latticeEventBus: [],
    latticeWebhookSubscriptions: [],
    latticeWebhookDeliveries: [],
    latticeConnectors: [],
    latticeNotificationDeliveries: [],
    latticePkiKeys: [],
    latticeCryptoLedger: [],
  };

  for (const [t, rows] of Object.entries(tables)) {
    seqs[t] = rows.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0);
  }

  const rlsTables = new Set([
    'latticeEmployees',
    'latticeApprovalPolicies',
    'latticeApprovalRequests',
    'latticeDelegations',
    'latticeNotifications',
    'latticeAiApprovalQueue',
    'latticeAutomationRuns',
    'latticeAgentProposals',
    'latticeEventBus',
    'latticePkiKeys',
    'latticeCryptoLedger',
  ]);
  const txStateMap = new Map();
  let txSeq = 0;

  const assertRlsRowVisible = (tableName, row, opts = {}) => {
    if (!seed.enforcePgRls || !rlsTables.has(tableName)) return true;
    const tx = opts.transaction;
    if (!tx || !txStateMap.has(tx)) {
      const err = new Error(`new row/query violates row-level security policy for table "${tableName}"`);
      err.code = '42501';
      throw err;
    }
    const st = txStateMap.get(tx);
    if (st.bypass) return true;
    if (!st.orgId) {
      const err = new Error(`RLS app.current_org missing for table "${tableName}"`);
      err.code = '42501';
      throw err;
    }
    return row.organizationId === st.orgId;
  };

  const match = (row, filter = {}) => Object.entries(filter || {}).every(([k, cond]) => {
    if (k === '$and' && Array.isArray(cond)) return cond.every((sub) => match(row, sub));
    if (k === '$or' && Array.isArray(cond)) return cond.some((sub) => match(row, sub));
    if (cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)) {
      if (Array.isArray(cond.$in)) return cond.$in.includes(row[k]);
      if (cond.$ne !== undefined) return row[k] !== cond.$ne;
      if (cond.$gt !== undefined) return new Date(row[k]).getTime() > new Date(cond.$gt).getTime();
      if (cond.$gte !== undefined) return new Date(row[k]).getTime() >= new Date(cond.$gte).getTime();
      if (cond.$lt !== undefined) return new Date(row[k]).getTime() < new Date(cond.$lt).getTime();
      if (cond.$lte !== undefined) return new Date(row[k]).getTime() <= new Date(cond.$lte).getTime();
    }
    if (k === 'id' || k === 'targetRecordId') return Number(row[k]) === Number(cond);
    return row[k] === cond;
  });

  const wrap = (tableName, row) => (row ? {
    ...row,
    get: (k) => row[k],
    toJSON: () => ({ ...row }),
    update: async (patch) => {
      Object.assign(row, patch, { updatedAt: new Date().toISOString() });
      return wrap(tableName, row);
    },
  } : null);

  const db = {
    sequelize: {
      getDialect: () => (seed.enforcePgRls ? 'postgres' : 'sqlite'),
      transaction: async (fn) => {
        const tx = { id: `tx-${++txSeq}`, LOCK: { UPDATE: 'UPDATE' } };
        txStateMap.set(tx, { orgId: null, bypass: false });
        try {
          return await fn(tx);
        } finally {
          txStateMap.delete(tx);
        }
      },
      query: async (sql, opts = {}) => {
        const s = String(sql || '');
        const tx = opts.transaction;
        if (s.includes("set_config('app.current_org'") && tx && txStateMap.has(tx)) {
          txStateMap.get(tx).orgId = opts.replacements?.orgId || null;
          return [[]];
        }
        if (s.includes("set_config('app.rls_bypass', 'on'") && tx && txStateMap.has(tx)) {
          txStateMap.get(tx).bypass = true;
          return [[]];
        }
        if (s.includes("current_setting('app.rls_bypass'")) {
          const prev = tx && txStateMap.get(tx)?.bypass ? 'on' : '';
          return [[{ prev }]];
        }
        if (s.includes("set_config('app.rls_bypass', :prev") && tx && txStateMap.has(tx)) {
          txStateMap.get(tx).bypass = opts.replacements?.prev === 'on';
          return [[]];
        }
        return [[]];
      },
    },
    getRepository(name) {
      if (!(name in tables)) return null;
      return {
        find: async ({ filter, sort, limit = 500, offset = 0, transaction } = {}) => {
          let out = tables[name].filter((r) => assertRlsRowVisible(name, r, { transaction }) && match(r, filter));
          if (Array.isArray(sort) && sort.length) {
            out = out.slice().sort((a, b) => {
              for (const s of sort) {
                const desc = String(s).startsWith('-');
                const field = desc ? String(s).slice(1) : String(s);
                const av = a[field] ?? 0;
                const bv = b[field] ?? 0;
                if (av !== bv) return desc ? (bv > av ? 1 : -1) : (av > bv ? 1 : -1);
              }
              return 0;
            });
          }
          return out.slice(offset, offset + limit).map((r) => wrap(name, r));
        },
        findOne: async ({ filter, filterByTk, transaction } = {}) => {
          const row = tables[name].find((r) => {
            if (!assertRlsRowVisible(name, r, { transaction })) return false;
            if (filterByTk != null && Number(r.id) !== Number(filterByTk)) return false;
            return filter ? match(r, filter) : true;
          });
          return wrap(name, row);
        },
        count: async ({ filter, transaction } = {}) => (
          tables[name].filter((r) => assertRlsRowVisible(name, r, { transaction }) && match(r, filter)).length
        ),
        create: async ({ values, transaction }) => {
          assertRlsRowVisible(name, values, { transaction });
          const id = nextId(name);
          const created = {
            id,
            createdAt: values.createdAt || new Date().toISOString(),
            updatedAt: values.updatedAt || new Date().toISOString(),
            ...values,
          };
          tables[name].push(created);
          return wrap(name, created);
        },
        update: async ({ filterByTk, filter, values, transaction }) => {
          const updated = [];
          for (const row of tables[name]) {
            if (!assertRlsRowVisible(name, row, { transaction })) continue;
            if (filterByTk != null && Number(row.id) !== Number(filterByTk)) continue;
            if (filter && !match(row, filter)) continue;
            Object.assign(row, values, { updatedAt: new Date().toISOString() });
            updated.push(wrap(name, row));
          }
          return updated;
        },
      };
    },
  };

  const resources = new Map();
  const middlewares = [];
  const app = {
    db,
    acl: { allow: () => {}, registerSnippet: () => {} },
    resourceManager: {
      define: ({ name, actions }) => resources.set(name, actions),
      isDefined: (name) => resources.has(name),
      getResource: (name) => (resources.has(name) ? { actions: resources.get(name) } : null),
      use: (mw, meta) => middlewares.push({ mw, meta }),
    },
  };

  return { db, app, tables, resources, middlewares };
}

function makeCtx(app, { method = 'GET', user = { id: 102, username: 'mgr_a1' }, role = 'ldx_manager', roles, params = {}, headers = {}, apiKey } = {}) {
  return {
    method,
    app,
    db: app.db,
    headers: { ...headers },
    get: (h) => headers[String(h).toLowerCase()] || headers[h] || '',
    request: { headers: { ...headers }, body: params.values || params },
    state: {
      currentUser: user,
      currentRole: role,
      currentRoles: roles || (role ? [role] : []),
      ...(apiKey ? { latticeApiKey: apiKey } : {}),
    },
    action: { params: { ...params } },
    throw(status, message) {
      throw Object.assign(new Error(message || `HTTP ${status}`), { status });
    },
    body: null,
  };
}

test('listUnifiedInbox aggregates latticeAgentProposals with role/own-user visibility, status mapping, and conditional counts', async () => {
  const prevRls = process.env.DX_PG_RLS_SESSION;
  process.env.DX_PG_RLS_SESSION = 'true';
  try {
  const { app, resources } = makeProposalHarness({
    enforcePgRls: true,
    proposals: [
      {
        id: 1,
        receiptKey: 'rec-1',
        contentHash: 'h1',
        eventId: 'evt-1',
        organizationId: 'org-a',
        sourceUserId: 101,
        sourceEmployeeId: 10,
        targetCollection: 'latticeIncidentCases',
        targetRecordId: 501,
        recordFingerprint: 'fp-1',
        recommendation: 'Chuyển sự cố sang đội bảo trì lạnh khẩn cấp.',
        evidence: [{ kind: 'native-record', collection: 'latticeIncidentCases', recordId: 501, fingerprint: 'fp-1' }],
        state: 'proposed',
        createdAt: '2026-11-26T01:00:00.000Z',
      },
      {
        id: 2,
        receiptKey: 'rec-2',
        contentHash: 'h2',
        eventId: 'evt-2',
        organizationId: 'org-a',
        sourceUserId: 102,
        sourceEmployeeId: 11,
        targetCollection: 'latticeOrders',
        targetRecordId: 601,
        recordFingerprint: 'fp-2',
        recommendation: 'Ưu tiên xuất FEFO lô gần hạn.',
        evidence: [{ kind: 'ngsi-ld', entityId: 'urn:ngsi-ld:Asset:org-a:native:1', fingerprint: 'ctx-1' }],
        state: 'reviewed',
        createdAt: '2026-11-26T02:00:00.000Z',
      },
      {
        id: 3,
        receiptKey: 'rec-3',
        contentHash: 'h3',
        eventId: 'evt-3',
        organizationId: 'org-b',
        sourceUserId: 201,
        sourceEmployeeId: 20,
        targetCollection: 'latticeIncidentCases',
        targetRecordId: 701,
        recordFingerprint: 'fp-3',
        recommendation: 'Cross-org proposal must stay hidden.',
        evidence: [],
        state: 'proposed',
        createdAt: '2026-11-26T03:00:00.000Z',
      },
    ],
  });

  const { registerApprovalEngine } = require('../src/server/approval-engine');
  registerApprovalEngine(app);
  const actions = resources.get('dxosApprovals');

  // Manager sees pending ('proposed') proposals in org-a only
  const mgrCtx = makeCtx(app, {
    method: 'GET',
    user: { id: 102, username: 'mgr_a1' },
    role: 'ldx_manager',
    params: { source: 'proposals', status: 'pending' },
  });
  await actions.listInbox(mgrCtx, async () => {});
  assert.equal(mgrCtx.body.total, 1);
  assert.equal(mgrCtx.body.counts.proposals, 1);
  const item = mgrCtx.body.items[0];
  assert.equal(item.source, 'proposals');
  assert.equal(item.itemKey, 'prop:1');
  assert.equal(item.proposalState, 'proposed');
  assert.equal(item.status, 'pending');
  assert.equal(item.canAct, true);
  assert.equal(item.diffPreview.summary, 'Chuyển sự cố sang đội bảo trì lạnh khẩn cấp.');
  assert.equal(item.evidence.length, 1);

  // Manager filtering status='reviewed' sees id:2 with canAct=false
  const revCtx = makeCtx(app, {
    method: 'GET',
    user: { id: 102, username: 'mgr_a1' },
    role: 'ldx_manager',
    params: { source: 'proposals', status: 'reviewed' },
  });
  await actions.listInbox(revCtx, async () => {});
  assert.equal(revCtx.body.total, 1);
  assert.equal(revCtx.body.items[0].id, 2);
  assert.equal(revCtx.body.items[0].status, 'reviewed');
  assert.equal(revCtx.body.items[0].canAct, false);

  // Non-approver employee (101) only sees own proposal with canAct=false
  const empCtx = makeCtx(app, {
    method: 'GET',
    user: { id: 101, username: 'emp_a1' },
    role: 'ldx_employee',
    params: { source: 'all', status: 'all' },
  });
  await actions.listInbox(empCtx, async () => {});
  assert.equal(empCtx.body.total, 1);
  assert.equal(empCtx.body.items[0].id, 1);
  assert.equal(empCtx.body.items[0].canAct, false);
  } finally {
    if (prevRls === undefined) delete process.env.DX_PG_RLS_SESSION;
    else process.env.DX_PG_RLS_SESSION = prevRls;
  }
});

test('decideUnifiedInboxItem transitions latticeAgentProposals (approve/reject/review), preserves evidence, blocks self/duplicate/forbidden, and logs ledger/event/notification', async () => {
  const prevRls = process.env.DX_PG_RLS_SESSION;
  process.env.DX_PG_RLS_SESSION = 'true';
  try {
  const { app, tables, resources } = makeProposalHarness({
    enforcePgRls: true,
    proposals: [
      {
        id: 10,
        receiptKey: 'rec-10',
        contentHash: 'h10',
        eventId: 'evt-10',
        organizationId: 'org-a',
        sourceUserId: 101,
        sourceEmployeeId: 10,
        targetCollection: 'latticeIncidentCases',
        targetRecordId: 510,
        recordFingerprint: 'fp-10',
        recommendation: 'Tạm dừng thiết bị lạnh số 2.',
        evidence: [{ kind: 'native-record', collection: 'latticeIncidentCases', recordId: 510, fingerprint: 'fp-10' }],
        state: 'proposed',
      },
      {
        id: 11,
        receiptKey: 'rec-11',
        contentHash: 'h11',
        eventId: 'evt-11',
        organizationId: 'org-a',
        sourceUserId: 101,
        sourceEmployeeId: 10,
        targetCollection: 'latticeOrders',
        targetRecordId: 511,
        recordFingerprint: 'fp-11',
        recommendation: 'Điều phối xe lạnh dự phòng.',
        evidence: [{ kind: 'ngsi-ld', entityId: 'urn:ngsi-ld:Asset:org-a:native:2', fingerprint: 'fp-11' }],
        state: 'proposed',
      },
      {
        id: 12,
        receiptKey: 'rec-12',
        contentHash: 'h12',
        eventId: 'evt-12',
        organizationId: 'org-a',
        sourceUserId: 101,
        sourceEmployeeId: 10,
        targetCollection: 'latticeAssets',
        targetRecordId: 512,
        recordFingerprint: 'fp-12',
        recommendation: 'Kiểm tra cảm biến kho C.',
        evidence: [{ kind: 'native-record', collection: 'latticeAssets', recordId: 512, fingerprint: 'fp-12' }],
        state: 'proposed',
      },
    ],
  });

  const { registerApprovalEngine } = require('../src/server/approval-engine');
  registerApprovalEngine(app);
  const actions = resources.get('dxosApprovals');

  // Read-only PAT blocked by assertApiKeyScope(['write', 'ai'])
  await assert.rejects(
    () => actions.decide(makeCtx(app, {
      method: 'POST',
      user: { id: 102, username: 'mgr_a1' },
      role: 'ldx_manager',
      apiKey: { id: 9, scopes: ['read'], organizationId: 'org-a' },
      params: { values: { itemKey: 'prop:10', decision: 'approve' } },
    }), async () => {}),
    { status: 403 },
  );

  // Self-approval blocked for requester (101)
  await assert.rejects(
    () => actions.decide(makeCtx(app, {
      method: 'POST',
      user: { id: 101, username: 'emp_a1' },
      role: 'ldx_employee',
      params: { values: { itemKey: 'prop:10', decision: 'approve' } },
    }), async () => {}),
    { code: 'APPROVAL_FORBIDDEN', status: 403 },
  );

  // Reject requires note >= 3 chars
  await assert.rejects(
    () => actions.decide(makeCtx(app, {
      method: 'POST',
      user: { id: 102, username: 'mgr_a1' },
      role: 'ldx_manager',
      params: { values: { itemKey: 'prop:11', decision: 'reject', note: 'no' } },
    }), async () => {}),
    { code: 'APPROVAL_REJECTION_NOTE_REQUIRED', status: 400 },
  );

  // Approve proposal 10 via prop:10 itemKey
  const approveCtx = makeCtx(app, {
    method: 'POST',
    user: { id: 102, username: 'mgr_a1' },
    role: 'ldx_manager',
    params: { values: { itemKey: 'prop:10', decision: 'approve', note: 'Đồng ý phương án' } },
  });
  await actions.decide(approveCtx, async () => {});
  assert.equal(approveCtx.body.state, 'approved');
  assert.equal(approveCtx.body.evidence.length, 1);
  assert.equal(tables.latticeAgentProposals[0].state, 'approved');
  assert.equal(tables.latticeAgentProposals[0].evidence.length, 1);
  assert.equal(tables.latticeCryptoLedger.length, 1);
  assert.equal(tables.latticeCryptoLedger[0].eventType, 'proposal.approved');
  assert.equal(tables.latticeEventBus.some((e) => e.eventType === 'proposal.approved'), true);
  assert.equal(tables.latticeNotifications.some((n) => Number(n.recipientUserId) === 101), true);

  // Re-deciding proposal 10 throws 409 PROPOSAL_ALREADY_DECIDED
  await assert.rejects(
    () => actions.decide(makeCtx(app, {
      method: 'POST',
      user: { id: 103, username: 'dir_a1' },
      role: 'ldx_director',
      params: { values: { itemKey: 'prop:10', decision: 'reject', note: 'Muộn rồi' } },
    }), async () => {}),
    { code: 'PROPOSAL_ALREADY_DECIDED', status: 409 },
  );

  // Reject proposal 11 with valid note
  const rejectCtx = makeCtx(app, {
    method: 'POST',
    user: { id: 102, username: 'mgr_a1' },
    role: 'ldx_manager',
    params: { values: { source: 'proposals', id: 11, decision: 'reject', note: 'Không đủ xe lạnh' } },
  });
  await actions.decide(rejectCtx, async () => {});
  assert.equal(tables.latticeAgentProposals[1].state, 'rejected');
  assert.equal(tables.latticeAgentProposals[1].evidence[0].kind, 'ngsi-ld');

  // Review proposal 12
  const reviewCtx = makeCtx(app, {
    method: 'POST',
    user: { id: 103, username: 'dir_a1' },
    role: 'ldx_director',
    params: { values: { source: 'proposal', id: 12, decision: 'review', note: 'Đã xem xét' } },
  });
  await actions.decide(reviewCtx, async () => {});
  assert.equal(tables.latticeAgentProposals[2].state, 'reviewed');
  assert.equal(tables.latticeAgentProposals[2].evidence.length, 1);

  // 'review' on non-proposal source still fails
  await assert.rejects(
    () => actions.decide(makeCtx(app, {
      method: 'POST',
      user: { id: 102, username: 'mgr_a1' },
      role: 'ldx_manager',
      params: { values: { source: 'business', id: 1, decision: 'review' } },
    }), async () => {}),
    { code: 'APPROVAL_INVALID_DECISION', status: 400 },
  );
  } finally {
    if (prevRls === undefined) delete process.env.DX_PG_RLS_SESSION;
    else process.env.DX_PG_RLS_SESSION = prevRls;
  }
});

test('dxosBlocks:proposals accepts approved/rejected states and decideProposal delegates to approval-engine', async () => {
  await withMockedNocobase(async () => {
    const { app, tables } = makeProposalHarness({
      proposals: [
        {
          id: 21,
          receiptKey: 'rec-21',
          contentHash: 'h21',
          eventId: 'evt-21',
          organizationId: 'org-a',
          sourceUserId: 101,
          sourceEmployeeId: 10,
          targetCollection: 'latticeIncidentCases',
          targetRecordId: 800,
          recordFingerprint: 'fp-21',
          recommendation: 'Kiểm tra kho 1',
          evidence: [{ kind: 'native-record', collection: 'latticeIncidentCases', recordId: 800, fingerprint: 'fp-21' }],
          state: 'proposed',
        },
        {
          id: 22,
          receiptKey: 'rec-22',
          contentHash: 'h22',
          eventId: 'evt-22',
          organizationId: 'org-a',
          sourceUserId: 101,
          sourceEmployeeId: 10,
          targetCollection: 'latticeIncidentCases',
          targetRecordId: 800,
          recordFingerprint: 'fp-22',
          recommendation: 'Đã duyệt trước đó',
          evidence: [],
          state: 'approved',
        },
      ],
      incidents: [{ id: 800, organizationId: 'org-a', code: 'INC-800' }],
    });

    // Grant view permission on latticeIncidentCases for ldx_manager
    const { createDxosBlocksActions } = require(path.resolve(__dirname, '../../plugin-dxos-blocks/src/server/blocks-api.js'));
    const actions = createDxosBlocksActions(app.db);

    const listApprovedCtx = makeCtx(app, {
      method: 'GET',
      user: { id: 102, username: 'mgr_a1' },
      role: 'ldx_manager',
      params: { targetCollection: 'latticeIncidentCases', state: 'approved' },
    });
    listApprovedCtx.can = () => true;
    await actions.proposals(listApprovedCtx, async () => {});
    assert.equal(listApprovedCtx.body.items.length, 1);
    assert.equal(listApprovedCtx.body.items[0].state, 'approved');

    assert.equal(typeof actions.decideProposal, 'function');
    const decideCtx = makeCtx(app, {
      method: 'POST',
      user: { id: 102, username: 'mgr_a1' },
      role: 'ldx_manager',
      params: { values: { proposalId: 21, decision: 'approve', note: 'OK via dxosBlocks' } },
    });
    await actions.decideProposal(decideCtx, async () => {});
    assert.equal(decideCtx.body.state, 'approved');
    assert.equal(tables.latticeAgentProposals[0].state, 'approved');

    // Read-only PAT blocked on dxosBlocks:decideProposal
    await assert.rejects(
      () => actions.decideProposal(makeCtx(app, {
        method: 'POST',
        user: { id: 102, username: 'mgr_a1' },
        role: 'ldx_manager',
        apiKey: { id: 9, scopes: ['read'], organizationId: 'org-a' },
        params: { values: { proposalId: 21, decision: 'approve' } },
      }), async () => {}),
      { code: 'API_KEY_SCOPE_INSUFFICIENT', status: 403 },
    );
  });
});

test('native-integrations proposals read-only endpoint serializes approved/rejected/reviewed states cleanly', async () => {
  const http = require('node:http');
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: { id: 901, organizationId: 'org-a', code: 'INC-901', name: 'Cold alarm' } }));
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const prevUrl = process.env.NOCOBASE_INTERNAL_URL;
  process.env.NOCOBASE_INTERNAL_URL = `http://127.0.0.1:${srv.address().port}`;
  try {
    const { app, tables, resources, middlewares } = makeProposalHarness({
      incidents: [{ id: 901, organizationId: 'org-a', code: 'INC-901', name: 'Cold alarm' }],
      proposals: [
        {
          id: 31,
          receiptKey: 'rec-31',
          contentHash: 'h31',
          eventId: 'evt-31',
          organizationId: 'org-a',
          sourceUserId: 101,
          sourceEmployeeId: 10,
          targetCollection: 'latticeIncidentCases',
          targetRecordId: 901,
          recordFingerprint: '',
          recommendation: 'Keep monitoring',
          evidence: [{ kind: 'native-record', collection: 'latticeIncidentCases', recordId: 901, fingerprint: 'x' }],
          state: 'approved',
        },
        {
          id: 32,
          receiptKey: 'rec-32',
          contentHash: 'h32',
          eventId: 'evt-32',
          organizationId: 'org-a',
          sourceUserId: 101,
          sourceEmployeeId: 10,
          targetCollection: 'latticeIncidentCases',
          targetRecordId: 901,
          recordFingerprint: '',
          recommendation: 'Reviewed note',
          evidence: [{ kind: 'native-record', collection: 'latticeIncidentCases', recordId: 901, fingerprint: 'x' }],
          state: 'reviewed',
        },
      ],
    });

    const { registerNativeIntegrations } = require('../src/server/native-integrations');
    registerNativeIntegrations(app);
    const actions = resources.get('latticeIntegrations');
    const { fingerprint } = require('../src/server/native-integration-policy');
    const recCtx = makeCtx(app, {
      method: 'POST',
      user: { id: 102, username: 'mgr_a1' },
      role: 'ldx_manager',
      params: { values: { collection: 'latticeIncidentCases', recordId: 901 } },
    });
    await actions.record(recCtx, async () => {});
    const fp = recCtx.body.fingerprint || fingerprint(recCtx.body.record);
    tables.latticeAgentProposals[0].recordFingerprint = fp;
    tables.latticeAgentProposals[1].recordFingerprint = fp;

    const listCtx = makeCtx(app, {
      method: 'POST',
      user: { id: 102, username: 'mgr_a1' },
      role: 'ldx_manager',
      params: { values: { collection: 'latticeIncidentCases', recordId: 901, page: 1, pageSize: 10 } },
    });
    await actions.proposals(listCtx, async () => {});
    assert.equal(listCtx.body.items.length, 2);
    assert.deepEqual(listCtx.body.items.map((i) => i.state).sort(), ['approved', 'reviewed']);

    // Journal direct guard still blocks non-root CRUD on latticeAgentProposals
    const guardMw = middlewares.find((m) => m.meta?.tag === 'latticePrivateIntegrationJournals')?.mw;
    assert.ok(guardMw);
    await assert.rejects(
      () => guardMw({
        action: { resourceName: 'latticeAgentProposals', actionName: 'update' },
        state: { currentRole: 'ldx_manager' },
      }, async () => {}),
      { code: 'INTEGRATION_JOURNAL_PRIVATE', status: 403 },
    );
  } finally {
    if (prevUrl === undefined) delete process.env.NOCOBASE_INTERNAL_URL;
    else process.env.NOCOBASE_INTERNAL_URL = prevUrl;
    await new Promise((resolve) => srv.close(resolve));
  }
});
