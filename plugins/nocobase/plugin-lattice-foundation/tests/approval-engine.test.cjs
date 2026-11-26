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
const { readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

const REPO_ROOT = resolve(__dirname, '../../../..');

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

function makeApprovalHarness(seed = {}) {
  const seqs = {};
  const nextId = (t) => {
    seqs[t] = (seqs[t] || 0) + 1;
    return seqs[t];
  };

  const tables = {
    latticeEmployees: (seed.employees || [
      { id: 10, userId: 101, organizationId: 'org-a', active: true, code: 'EMP-A1', name: 'Requester A', departmentId: 1 },
      { id: 11, userId: 102, organizationId: 'org-a', active: true, code: 'EMP-A2', name: 'Manager A1', departmentId: 1 },
      { id: 12, userId: 103, organizationId: 'org-a', active: true, code: 'EMP-A3', name: 'Manager A2', departmentId: 1 },
      { id: 13, userId: 104, organizationId: 'org-a', active: true, code: 'EMP-A4', name: 'Director A', departmentId: 1 },
      { id: 14, userId: 105, organizationId: 'org-a', active: true, code: 'EMP-A5', name: 'Delegate A', departmentId: 1 },
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
      { userId: 103, roleName: 'ldx_manager' },
      { userId: 104, roleName: 'ldx_director' },
      { userId: 105, roleName: 'ldx_employee' },
      { userId: 201, roleName: 'ldx_manager' },
      { userId: 1, roleName: 'root' },
    ]).map((r) => ({ ...r })),
    latticeApprovalPolicies: (seed.policies || []).map((r) => ({ ...r })),
    latticeApprovalRequests: (seed.requests || []).map((r) => ({ ...r })),
    latticeDelegations: (seed.delegations || []).map((r) => ({ ...r })),
    latticeNotifications: (seed.notifications || []).map((r) => ({ ...r })),
    latticeAiApprovalQueue: (seed.aiQueue || []).map((r) => ({ ...r })),
    latticeAutomationRuns: (seed.autoRuns || []).map((r) => ({ ...r })),
    latticeEventBus: (seed.events || []).map((r) => ({ ...r })),
    latticeWebhookSubscriptions: [],
    latticeWebhookDeliveries: [],
    latticeConnectors: (seed.connectors || []).map((r) => ({ ...r })),
    latticeNotificationDeliveries: (seed.deliveries || []).map((r) => ({ ...r })),
    latticePkiKeys: (seed.pkiKeys || []).map((r) => ({ ...r })),
    latticeCryptoLedger: (seed.ledger || []).map((r) => ({ ...r })),
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
        destroy: async ({ filter, filterByTk, transaction }) => {
          const kept = [];
          let removed = 0;
          for (const row of tables[name]) {
            const visible = assertRlsRowVisible(name, row, { transaction });
            const idMatch = filterByTk == null || Number(row.id) === Number(filterByTk);
            const filterMatch = !filter || match(row, filter);
            if (visible && idMatch && filterMatch) {
              removed += 1;
            } else {
              kept.push(row);
            }
          }
          tables[name] = kept;
          return removed;
        },
      };
    },
  };

  const resources = new Map();
  const middlewares = [];
  const aclAllows = [];
  const app = {
    db,
    acl: {
      allow: (resource, actions, role) => aclAllows.push({ resource, actions, role }),
    },
    resourceManager: {
      define: ({ name, actions }) => resources.set(name, actions),
      isDefined: (name) => resources.has(name),
      getResource: (name) => (resources.has(name) ? { actions: resources.get(name) } : null),
      use: (mw, meta) => middlewares.push({ mw, meta }),
    },
  };

  return { db, app, tables, resources, middlewares, aclAllows };
}

function makeCtx(app, { method = 'GET', user = { id: 101, username: 'emp_a1' }, role = 'ldx_employee', roles, params = {}, headers = {} } = {}) {
  return {
    method,
    app,
    db: app.db,
    headers: { ...headers },
    request: { headers: { ...headers }, body: params.values || params },
    state: {
      currentUser: user,
      currentRole: role,
      currentRoles: roles || (role ? [role] : []),
    },
    action: {
      params: { ...params },
    },
    throw(status, message) {
      throw Object.assign(new Error(message || `HTTP ${status}`), { status });
    },
    body: null,
  };
}

test('approval collections, migration 20261202000200, and SPDX headers follow LatticeDX RLS & index rules', async () => {
  const files = [
    'plugins/nocobase/plugin-lattice-foundation/src/server/collections/approval-policies.js',
    'plugins/nocobase/plugin-lattice-foundation/src/server/collections/approval-requests.js',
    'plugins/nocobase/plugin-lattice-foundation/src/server/migrations/20261202000200-multi-level-approval-engine.js',
    'plugins/nocobase/plugin-lattice-foundation/src/server/approval-engine.js',
    'plugins/nocobase/plugin-lattice-foundation/tests/approval-engine.test.cjs',
  ];
  for (const rel of files) {
    const src = readFileSync(join(REPO_ROOT, rel), 'utf8');
    assert.match(src, /@file LatticeDX/);
    assert.match(src, /@copyright \(C\) 2026 CTU-OpenPaw/);
    assert.match(src, /SPDX-License-Identifier: Apache-2\.0/);
    assert.equal(src.includes('\r\n'), false, `${rel} must use LF line endings`);
  }

  await withMockedNocobase(async () => {
    const policiesCol = require('../src/server/collections/approval-policies');
    const requestsCol = require('../src/server/collections/approval-requests');

    assert.equal(policiesCol.name, 'latticeApprovalPolicies');
    assert.deepEqual(policiesCol.migrationRules, ['schema-only']);
    assert.equal(policiesCol.fields.find((f) => f.name === 'organizationId')?.allowNull, false);
    assert.ok(policiesCol.indexes.some((i) => i.name === 'uidx_lattice_approval_policies_org_key' && i.unique === true));
    for (const idx of [...policiesCol.indexes, ...requestsCol.indexes]) {
      assert.match(idx.name, /^u?idx_lattice_[a-z0-9_]+$/);
      assert.ok(idx.name.length <= 55, `Index name too long: ${idx.name}`);
    }

    assert.equal(requestsCol.name, 'latticeApprovalRequests');
    assert.deepEqual(requestsCol.migrationRules, ['schema-only']);
    assert.equal(requestsCol.fields.find((f) => f.name === 'organizationId')?.allowNull, false);
    assert.ok(requestsCol.indexes.some((i) => i.name === 'uidx_lattice_approval_reqs_org_uid' && i.unique === true));

    const MigrationCls = require('../src/server/migrations/20261202000200-multi-level-approval-engine');
    const queries = [];
    const fakeTx = { id: 'tx-mig' };
    const mig = new MigrationCls({
      db: {
        sequelize: {
          getDialect: () => 'postgres',
          transaction: async (cb) => cb(fakeTx),
          query: async (sql) => {
            queries.push(String(sql));
            return [[]];
          },
        },
      },
    });
    assert.equal(mig.on, 'afterSync');
    await mig.up();
    const upSql = queries.join('\n');
    assert.match(upSql, /CREATE TABLE IF NOT EXISTS "latticeApprovalPolicies"/);
    assert.match(upSql, /CREATE TABLE IF NOT EXISTS "latticeApprovalRequests"/);
    assert.match(upSql, /CREATE UNIQUE INDEX IF NOT EXISTS uidx_lattice_approval_policies_org_key/);
    assert.match(upSql, /CREATE UNIQUE INDEX IF NOT EXISTS uidx_lattice_approval_reqs_org_uid/);
    assert.match(upSql, /ENABLE ROW LEVEL SECURITY/);
    assert.match(upSql, /FORCE ROW LEVEL SECURITY/);
    assert.doesNotMatch(upSql, /\bUNIQUE\s*\(/i, 'Must not put inline UNIQUE inside CREATE TABLE');

    queries.length = 0;
    await mig.down();
    const downSql = queries.join('\n');
    assert.match(downSql, /DISABLE ROW LEVEL SECURITY/);
    assert.match(downSql, /DROP TABLE IF EXISTS "latticeApprovalRequests"/);
    assert.match(downSql, /DROP TABLE IF EXISTS "latticeApprovalPolicies"/);
  });
});

test('sequential multi-stage approval advances stage 0 -> stage 1 -> approved, rejects self-approval & short rejection note', async () => {
  const { app, tables, resources } = makeApprovalHarness();
  const { registerApprovalEngine } = require('../src/server/approval-engine');
  registerApprovalEngine(app);
  const actions = resources.get('dxosApprovals');

  // Admin saves 2-stage sequential policy on latticeCustomColdAudits
  const saveCtx = makeCtx(app, {
    method: 'POST',
    user: { id: 1, username: 'root' },
    role: 'root',
    params: {
      values: {
        organizationId: 'org-a',
        policyKey: 'cold-audit-2level',
        name: 'Cold Audit Two-Level Approval',
        targetCollection: 'latticeCustomColdAudits',
        allowSelfApproval: false,
        stagesJson: [
          { stageIndex: 0, name: 'Manager Review', mode: 'sequential', requiredApprovals: 1, approverRoles: ['ldx_manager'], slaMinutes: 60 },
          { stageIndex: 1, name: 'Director Sign-off', mode: 'sequential', requiredApprovals: 1, approverRoles: ['ldx_director'], slaMinutes: 120 },
        ],
      },
    },
  });
  await actions.savePolicy(saveCtx, async () => {});
  assert.equal(saveCtx.body.policyKey, 'cold-audit-2level');
  assert.equal(saveCtx.body.stagesJson.length, 2);

  // Employee 101 submits request
  const reqCtx = makeCtx(app, {
    method: 'POST',
    user: { id: 101, username: 'emp_a1' },
    role: 'ldx_employee',
    params: {
      values: {
        policyKey: 'cold-audit-2level',
        targetCollection: 'latticeCustomColdAudits',
        targetRecordId: 55,
        targetCode: 'AUD-055',
        title: 'Release Quarantine Lot #55',
        riskLevel: 'high',
      },
    },
  });
  await actions.request(reqCtx, async () => {});
  const requestUid = reqCtx.body.requestUid;
  assert.ok(requestUid.startsWith('APR-'));
  assert.equal(reqCtx.body.status, 'pending');
  assert.equal(reqCtx.body.currentStageIndex, 0);
  assert.equal(reqCtx.body.totalStages, 2);

  // Self-approval blocked (even if requester claims spoofed role)
  await assert.rejects(
    () => actions.decide(makeCtx(app, {
      method: 'POST',
      user: { id: 101, username: 'emp_a1' },
      role: 'ldx_manager',
      params: { values: { source: 'business', requestUid, decision: 'approve' } },
    }), async () => {}),
    (err) => err.status === 403 && (err.code === 'SELF_APPROVAL_FORBIDDEN' || err.code === 'APPROVAL_FORBIDDEN'),
  );

  // Role spoofing test: user 105 only has ldx_employee in rolesUsers, spoofs ctx.state.currentRole = 'ldx_manager' -> 403
  await assert.rejects(
    () => actions.decide(makeCtx(app, {
      method: 'POST',
      user: { id: 105, username: 'emp_a5' },
      role: 'ldx_manager',
      params: { values: { source: 'business', requestUid, decision: 'approve' } },
    }), async () => {}),
    { code: 'APPROVAL_FORBIDDEN', status: 403 },
  );

  // Manager 102 approves stage 0 -> advances to stage 1
  const dec0Ctx = makeCtx(app, {
    method: 'POST',
    user: { id: 102, username: 'mgr_a1' },
    role: 'ldx_manager',
    params: { values: { source: 'business', requestUid, decision: 'approve', note: 'Stage 0 ok' } },
  });
  await actions.decide(dec0Ctx, async () => {});
  assert.equal(dec0Ctx.body.status, 'pending');
  assert.equal(dec0Ctx.body.currentStageIndex, 1);
  assert.equal(dec0Ctx.body.stagesStateJson[0].status, 'approved');

  // Manager 103 cannot approve stage 1 (requires ldx_director)
  await assert.rejects(
    () => actions.decide(makeCtx(app, {
      method: 'POST',
      user: { id: 103, username: 'mgr_a2' },
      role: 'ldx_manager',
      params: { values: { source: 'business', requestUid, decision: 'approve' } },
    }), async () => {}),
    { code: 'APPROVAL_FORBIDDEN', status: 403 },
  );

  // Director 104 tries reject with short note (< 3 chars) -> 400
  await assert.rejects(
    () => actions.decide(makeCtx(app, {
      method: 'POST',
      user: { id: 104, username: 'dir_a' },
      role: 'ldx_director',
      params: { values: { source: 'business', requestUid, decision: 'reject', note: 'no' } },
    }), async () => {}),
    { code: 'APPROVAL_REJECTION_NOTE_REQUIRED', status: 400 },
  );

  // Director 104 approves stage 1 -> final approved
  const dec1Ctx = makeCtx(app, {
    method: 'POST',
    user: { id: 104, username: 'dir_a' },
    role: 'ldx_director',
    params: { values: { source: 'business', requestUid, decision: 'approve', note: 'Final sign-off' } },
  });
  await actions.decide(dec1Ctx, async () => {});
  assert.equal(dec1Ctx.body.status, 'approved');
  assert.equal(dec1Ctx.body.finalDecisionByUserId, 104);
  assert.equal(tables.latticeNotifications.length >= 2, true);
});

test('parallel M-of-N quorum (2-of-3) tracks distinct votes and blocks duplicate vote (409 APPROVAL_ALREADY_VOTED)', async () => {
  const { app, resources } = makeApprovalHarness();
  const { registerApprovalEngine } = require('../src/server/approval-engine');
  registerApprovalEngine(app);
  const actions = resources.get('dxosApprovals');

  const reqCtx = makeCtx(app, {
    method: 'POST',
    user: { id: 101, username: 'emp_a1' },
    role: 'ldx_employee',
    params: {
      values: {
        targetCollection: 'latticeOrders',
        targetRecordId: 88,
        title: 'Parallel 2-of-3 Release',
        stages: [
          {
            stageIndex: 0,
            name: 'Committee 2-of-3',
            mode: 'parallel',
            requiredApprovals: 2,
            approverRoles: ['ldx_manager', 'ldx_director'],
            approverUserIds: [102, 103, 104],
          },
        ],
      },
    },
  });
  await actions.request(reqCtx, async () => {});
  const requestUid = reqCtx.body.requestUid;

  // Vote 1 by user 102
  const vote1 = makeCtx(app, {
    method: 'POST',
    user: { id: 102, username: 'mgr_a1' },
    role: 'ldx_manager',
    params: { values: { source: 'business', requestUid, decision: 'approve', note: 'Vote 1' } },
  });
  await actions.decide(vote1, async () => {});
  assert.equal(vote1.body.status, 'pending');
  assert.equal(vote1.body.stagesStateJson[0].decisions.length, 1);

  // Duplicate vote by user 102 -> 409 APPROVAL_ALREADY_VOTED
  await assert.rejects(
    () => actions.decide(makeCtx(app, {
      method: 'POST',
      user: { id: 102, username: 'mgr_a1' },
      role: 'ldx_manager',
      params: { values: { source: 'business', requestUid, decision: 'approve', note: 'Double vote' } },
    }), async () => {}),
    { code: 'APPROVAL_ALREADY_VOTED', status: 409 },
  );

  // Vote 2 by user 103 -> meets 2-of-3 quorum -> approved
  const vote2 = makeCtx(app, {
    method: 'POST',
    user: { id: 103, username: 'mgr_a2' },
    role: 'ldx_manager',
    params: { values: { source: 'business', requestUid, decision: 'approve', note: 'Vote 2' } },
  });
  await actions.decide(vote2, async () => {});
  assert.equal(vote2.body.status, 'approved');
  assert.equal(vote2.body.stagesStateJson[0].decisions.length, 2);
});

test('automatic delegation lookup grants approval authority, enforces expiry/revocation, and rejects elevated delegation roles', async () => {
  const nowMs = Date.now();
  const { app, tables, resources } = makeApprovalHarness({
    delegations: [
      {
        id: 1,
        organizationId: 'org-a',
        delegationUid: 'DLG-ACTIVE-1',
        delegatorUserId: 104,
        delegateUserId: 105,
        roleName: 'ldx_director',
        scopeCollection: 'latticeOrders',
        startsAt: new Date(nowMs - 3600_000).toISOString(),
        endsAt: new Date(nowMs + 3600_000).toISOString(),
        status: 'active',
        active: true,
      },
      {
        id: 2,
        organizationId: 'org-a',
        delegationUid: 'DLG-EXPIRED-1',
        delegatorUserId: 102,
        delegateUserId: 105,
        roleName: 'ldx_manager',
        scopeCollection: 'latticeRequests',
        startsAt: new Date(nowMs - 7200_000).toISOString(),
        endsAt: new Date(nowMs - 1000).toISOString(),
        status: 'active',
        active: true,
      },
      {
        id: 3,
        organizationId: 'org-a',
        delegationUid: 'DLG-ELEVATED-1',
        delegatorUserId: 1,
        delegateUserId: 105,
        roleName: 'ldx_admin',
        scopeCollection: null,
        startsAt: new Date(nowMs - 3600_000).toISOString(),
        endsAt: new Date(nowMs + 3600_000).toISOString(),
        status: 'active',
        active: true,
      },
    ],
  });
  const { registerApprovalEngine } = require('../src/server/approval-engine');
  registerApprovalEngine(app);
  const actions = resources.get('dxosApprovals');

  // Request on latticeOrders requiring ldx_director
  const reqOrder = makeCtx(app, {
    method: 'POST',
    user: { id: 101, username: 'emp_a1' },
    role: 'ldx_employee',
    params: {
      values: {
        targetCollection: 'latticeOrders',
        title: 'Delegated Order Approval',
        stages: [{ name: 'Director', mode: 'sequential', requiredApprovals: 1, approverRoles: ['ldx_director'] }],
      },
    },
  });
  await actions.request(reqOrder, async () => {});

  // Employee 105 approves via DLG-ACTIVE-1
  const decCtx = makeCtx(app, {
    method: 'POST',
    user: { id: 105, username: 'emp_a5' },
    role: 'ldx_employee',
    params: { values: { source: 'business', requestUid: reqOrder.body.requestUid, decision: 'approve', note: 'Acting as delegate' } },
  });
  await actions.decide(decCtx, async () => {});
  assert.equal(decCtx.body.status, 'approved');
  assert.equal(decCtx.body.stagesStateJson[0].decisions[0].delegationUid, 'DLG-ACTIVE-1');
  assert.equal(decCtx.body.stagesStateJson[0].decisions[0].delegatedFromUserId, 104);

  // Request on latticeRequests requiring ldx_manager -> DLG-EXPIRED-1 is expired and DLG-ELEVATED-1 (ldx_admin) is filtered out
  const reqReq = makeCtx(app, {
    method: 'POST',
    user: { id: 101, username: 'emp_a1' },
    role: 'ldx_employee',
    params: {
      values: {
        targetCollection: 'latticeRequests',
        title: 'Expired Delegation Check',
        stages: [{ name: 'Manager', mode: 'sequential', requiredApprovals: 1, approverRoles: ['ldx_manager'] }],
      },
    },
  });
  await actions.request(reqReq, async () => {});

  await assert.rejects(
    () => actions.decide(makeCtx(app, {
      method: 'POST',
      user: { id: 105, username: 'emp_a5' },
      role: 'ldx_employee',
      params: { values: { source: 'business', requestUid: reqReq.body.requestUid, decision: 'approve' } },
    }), async () => {}),
    { code: 'APPROVAL_FORBIDDEN', status: 403 },
  );

  // Revoking DLG-ACTIVE-1 removes delegation authority
  tables.latticeDelegations[0].status = 'revoked';
  tables.latticeDelegations[0].active = false;
  const reqOrder2 = makeCtx(app, {
    method: 'POST',
    user: { id: 101, username: 'emp_a1' },
    role: 'ldx_employee',
    params: {
      values: {
        targetCollection: 'latticeOrders',
        title: 'Revoked Delegation Check',
        stages: [{ name: 'Director', mode: 'sequential', requiredApprovals: 1, approverRoles: ['ldx_director'] }],
      },
    },
  });
  await actions.request(reqOrder2, async () => {});
  await assert.rejects(
    () => actions.decide(makeCtx(app, {
      method: 'POST',
      user: { id: 105, username: 'emp_a5' },
      role: 'ldx_employee',
      params: { values: { source: 'business', requestUid: reqOrder2.body.requestUid, decision: 'approve' } },
    }), async () => {}),
    { code: 'APPROVAL_FORBIDDEN', status: 403 },
  );
});

test('SLA escalation dispatches dedupKey notifications once and cross-org / PG RLS isolation holds', async () => {
  const prevRls = process.env.DX_PG_RLS_SESSION;
  process.env.DX_PG_RLS_SESSION = 'true';
  try {
    const pastIso = new Date(Date.now() - 3600_000).toISOString();
    const { app, tables, resources } = makeApprovalHarness({
      enforcePgRls: true,
      requests: [
        {
          id: 1,
          organizationId: 'org-a',
          requestUid: 'APR-SLA-1',
          targetCollection: 'latticeOrders',
          title: 'Overdue Order Approval',
          riskLevel: 'high',
          status: 'pending',
          currentStageIndex: 0,
          totalStages: 1,
          stagesStateJson: [
            {
              stageIndex: 0,
              name: 'Manager',
              mode: 'sequential',
              requiredApprovals: 1,
              approverRoles: ['ldx_manager'],
              approverUserIds: [],
              status: 'pending',
              decisions: [],
              dueAt: pastIso,
              escalateToRole: 'ldx_director',
              escalatedAt: null,
            },
          ],
          requesterUserId: 101,
          requesterUsername: 'emp_a1',
          dueAt: pastIso,
          escalatedAt: null,
          active: true,
        },
      ],
    });
    const { registerApprovalEngine, evaluateApprovalSlas } = require('../src/server/approval-engine');
    registerApprovalEngine(app);
    const actions = resources.get('dxosApprovals');

    // Cross-org manager 201 (org-b) cannot decide org-a request under PG RLS
    await assert.rejects(
      () => actions.decide(makeCtx(app, {
        method: 'POST',
        user: { id: 201, username: 'mgr_b' },
        role: 'ldx_manager',
        params: { values: { source: 'business', requestUid: 'APR-SLA-1', decision: 'approve' } },
      }), async () => {}),
      (err) => err.status === 404 || err.status === 403,
    );

    // Evaluate SLA breaches for org-a
    const sla1 = await evaluateApprovalSlas(app.db, { organizationId: 'org-a', now: new Date() });
    assert.equal(sla1.breachedCount, 1);
    assert.equal(sla1.escalatedCount, 1);
    assert.equal(tables.latticeNotifications.length, 1);
    assert.equal(tables.latticeNotifications[0].recipientUserId, 104); // ldx_director in org-a
    assert.equal(tables.latticeNotifications[0].dedupKey, 'approval-sla:org-a:APR-SLA-1:stage-0');

    // Re-running SLA scan does not double-escalate
    const sla2 = await evaluateApprovalSlas(app.db, { organizationId: 'org-a', now: new Date() });
    assert.equal(sla2.breachedCount, 1);
    assert.equal(sla2.escalatedCount, 0);
    assert.equal(tables.latticeNotifications.length, 1);
  } finally {
    if (prevRls === undefined) delete process.env.DX_PG_RLS_SESSION;
    else process.env.DX_PG_RLS_SESSION = prevRls;
  }
});

test('Unified Approval Inbox consolidates & deduplicates business, ai_hitl, and flow items and routes decide calls', async () => {
  const { app, resources } = makeApprovalHarness({
    requests: [
      {
        id: 1,
        organizationId: 'org-a',
        requestUid: 'APR-BIZ-1',
        targetCollection: 'latticeOrders',
        title: 'Approve PO-100',
        riskLevel: 'medium',
        status: 'pending',
        currentStageIndex: 0,
        totalStages: 1,
        stagesStateJson: [{ stageIndex: 0, name: 'Mgr', mode: 'sequential', requiredApprovals: 1, approverRoles: ['ldx_manager'], approverUserIds: [], status: 'pending', decisions: [] }],
        requesterUserId: 101,
        requesterUsername: 'emp_a1',
        createdAt: '2026-11-25T10:00:00.000Z',
        active: true,
      },
    ],
    aiQueue: [
      {
        id: 50,
        organizationId: 'org-a',
        requesterUserId: 101,
        requesterUsername: 'emp_a1',
        aiEmployee: 'dxos-operator',
        toolName: 'dxos_wms_hold_lot',
        targetCollection: 'latticeStockLots',
        targetRecordId: 7,
        operation: 'hold',
        diffPreview: { title: 'Hold Stock Lot #7', riskLevel: 'high' },
        riskLevel: 'high',
        status: 'pending',
        createdAt: '2026-11-25T11:00:00.000Z',
      },
      {
        id: 51,
        organizationId: 'org-a',
        requesterUserId: 101,
        requesterUsername: 'emp_a1',
        aiEmployee: 'flow-orchestrator',
        toolName: 'latticeflow.approval',
        targetCollection: 'latticeAutomationRuns',
        targetRecordId: 9,
        operation: 'approval',
        proposedArgs: { runUid: 'RUN-FLOW-9', approverRole: 'ldx_manager', title: 'Flow Gate' },
        diffPreview: { title: 'Flow Gate', approverRole: 'ldx_manager', riskLevel: 'medium' },
        riskLevel: 'medium',
        status: 'pending',
        createdAt: '2026-11-25T12:00:00.000Z',
      },
    ],
    autoRuns: [
      {
        id: 9,
        organizationId: 'org-a',
        ruleId: 3,
        ruleKey: 'cold-chain-gate',
        runUid: 'RUN-FLOW-9',
        status: 'suspended',
        suspendedNodeId: 'approval_1',
        approvalId: 51,
        resumeTokenHash: 'secret-sha256-hash-must-not-leak',
        resumeAt: '2026-11-26T12:00:00.000Z',
        triggerPayloadJson: { actor: { userId: 101, username: 'emp_a1' } },
        nodeStatesJson: {
          approval_1: {
            suspend: { kind: 'approval', approvalId: 51, approverRole: 'ldx_manager' },
            output: { title: 'Flow Gate', summary: 'Approve cold chain release', riskLevel: 'medium', approverRole: 'ldx_manager' },
          },
        },
        createdAt: '2026-11-25T12:00:00.000Z',
      },
    ],
  });

  const routedCalls = [];
  app.resourceManager.define({
    name: 'dxosAi',
    actions: {
      approveAction: async (ctx, next) => {
        routedCalls.push({ resource: 'dxosAi', action: 'approveAction', params: ctx.action.params });
        ctx.body = { id: ctx.action.params.approvalId, status: 'executed' };
        if (next) await next();
      },
      rejectAction: async (ctx, next) => {
        routedCalls.push({ resource: 'dxosAi', action: 'rejectAction', params: ctx.action.params });
        ctx.body = { id: ctx.action.params.approvalId, status: 'rejected' };
        if (next) await next();
      },
    },
  });
  app.resourceManager.define({
    name: 'dxosAutomations',
    actions: {
      resumeRun: async (ctx, next) => {
        routedCalls.push({ resource: 'dxosAutomations', action: 'resumeRun', params: ctx.action.params });
        ctx.body = { run: { runUid: ctx.action.params.runUid, status: 'completed', decision: ctx.action.params.decision } };
        if (next) await next();
      },
    },
  });

  const { registerApprovalEngine } = require('../src/server/approval-engine');
  registerApprovalEngine(app);
  const actions = resources.get('dxosApprovals');

  const inboxCtx = makeCtx(app, {
    method: 'GET',
    user: { id: 102, username: 'mgr_a1' },
    role: 'ldx_manager',
    params: { status: 'pending', source: 'all' },
  });
  await actions.listInbox(inboxCtx, async () => {});

  // Must have 3 items (1 business, 1 ai_hitl excluding latticeflow.approval, 1 flow)
  assert.equal(inboxCtx.body.total, 3);
  assert.deepEqual(inboxCtx.body.counts, {
    business: 1,
    proposals: 0,
    ai_hitl: 1,
    aiHitl: 1,
    flow: 1,
    all: 3,
    total: 3,
  });

  // Filtering by source='business' keeps all 4 source counts intact (P1-04)
  const bizOnlyCtx = makeCtx(app, {
    method: 'GET',
    user: { id: 102, username: 'mgr_a1' },
    role: 'ldx_manager',
    params: { status: 'pending', source: 'business' },
  });
  await actions.listInbox(bizOnlyCtx, async () => {});
  assert.equal(bizOnlyCtx.body.total, 1);
  assert.equal(bizOnlyCtx.body.items[0].source, 'business');
  assert.deepEqual(bizOnlyCtx.body.counts, {
    business: 1,
    proposals: 0,
    ai_hitl: 1,
    aiHitl: 1,
    flow: 1,
    all: 3,
    total: 3,
  });

  // Search filters unified inbox items across title/summary/ruleKey/collection (P1-04)
  const searchCtx = makeCtx(app, {
    method: 'GET',
    user: { id: 102, username: 'mgr_a1' },
    role: 'ldx_manager',
    params: { status: 'pending', source: 'all', search: 'RUN-FLOW-9' },
  });
  await actions.listInbox(searchCtx, async () => {});
  assert.equal(searchCtx.body.total, 1);
  assert.equal(searchCtx.body.items[0].itemKey, 'flow:RUN-FLOW-9');
  const sources = inboxCtx.body.items.map((i) => i.source);
  assert.deepEqual(sources, ['flow', 'ai_hitl', 'business']);
  const flowItem = inboxCtx.body.items[0];
  assert.equal(flowItem.itemKey, 'flow:RUN-FLOW-9');
  assert.equal(flowItem.resumeTokenHash, undefined);
  assert.equal(JSON.stringify(inboxCtx.body).includes('secret-sha256-hash-must-not-leak'), false);

  // Route AI HITL approve to dxosAi:approveAction
  const aiDecCtx = makeCtx(app, {
    method: 'POST',
    user: { id: 102, username: 'mgr_a1' },
    role: 'ldx_manager',
    params: { values: { source: 'ai_hitl', itemKey: 'ai:50', decision: 'approve', note: 'Proceed' } },
  });
  await actions.decide(aiDecCtx, async () => {});
  assert.equal(routedCalls[0].resource, 'dxosAi');
  assert.equal(routedCalls[0].action, 'approveAction');
  assert.equal(aiDecCtx.body.status, 'executed');

  // Self-approval blocked on flow item for requester 101
  await assert.rejects(
    () => actions.decide(makeCtx(app, {
      method: 'POST',
      user: { id: 101, username: 'emp_a1' },
      role: 'ldx_employee',
      params: { values: { source: 'flow', runUid: 'RUN-FLOW-9', decision: 'approve' } },
    }), async () => {}),
    { code: 'SELF_APPROVAL_FORBIDDEN', status: 403 },
  );

  // Route flow approve to dxosAutomations:resumeRun
  const flowDecCtx = makeCtx(app, {
    method: 'POST',
    user: { id: 102, username: 'mgr_a1' },
    role: 'ldx_manager',
    params: { values: { source: 'flow', itemKey: 'flow:RUN-FLOW-9', decision: 'approve', note: 'Ship it' } },
  });
  await actions.decide(flowDecCtx, async () => {});
  assert.equal(routedCalls[1].resource, 'dxosAutomations');
  assert.equal(routedCalls[1].action, 'resumeRun');
  assert.equal(routedCalls[1].params.decision, 'approved');
});

test('direct CRUD guard, target collection allowlist, and prototype pollution protection fail closed', async () => {
  const { app, resources, middlewares } = makeApprovalHarness();
  const { registerApprovalEngine } = require('../src/server/approval-engine');
  registerApprovalEngine(app);
  const actions = resources.get('dxosApprovals');
  const guard = middlewares.find((m) => m.meta?.tag === 'dxosApprovalsDirectGuard')?.mw;
  assert.equal(typeof guard, 'function');

  for (const blockedRes of ['latticeApprovalPolicies', 'latticeApprovalRequests', 'latticeApprovalRequests.stages']) {
    await assert.rejects(
      () => guard({
        state: { currentRole: 'ldx_admin', currentUser: { id: 10 } },
        action: { resourceName: blockedRes, actionName: 'list', params: {} },
      }, async () => {}),
      { code: 'APPROVAL_DIRECT_CRUD_FORBIDDEN', status: 403 },
    );
  }
  await assert.rejects(
    () => guard({
      state: { currentRole: 'root', currentUser: null },
      action: { resourceName: 'latticeApprovalRequests', actionName: 'list', params: {} },
    }, async () => {}),
    { code: 'APPROVAL_DIRECT_CRUD_FORBIDDEN', status: 403 },
  );
  await assert.rejects(
    () => guard({
      state: { currentRole: 'ldx_manager', currentUser: { id: 102 } },
      action: { resourceName: 'charts', actionName: 'queryData', params: { values: { collection: 'latticeApprovalRequests' } } },
    }, async () => {}),
    { code: 'APPROVAL_DIRECT_CRUD_FORBIDDEN', status: 403 },
  );

  // Protected targetCollection rejected
  for (const badCol of ['users', 'latticeApiKeys', 'latticeDelegations', 'latticeConnectors']) {
    await assert.rejects(
      () => actions.request(makeCtx(app, {
        method: 'POST',
        user: { id: 101, username: 'emp_a1' },
        role: 'ldx_employee',
        params: {
          values: {
            targetCollection: badCol,
            title: 'Bypass attempt',
            stages: [{ name: 'Mgr', mode: 'sequential', requiredApprovals: 1, approverRoles: ['ldx_manager'] }],
          },
        },
      }), async () => {}),
      { code: 'APPROVAL_COLLECTION_FORBIDDEN', status: 400 },
    );
  }

  // Prototype pollution keys rejected/stripped
  const dirtyPayload = JSON.parse('{"targetCollection":"latticeOrders","title":"Clean Check","stages":[{"name":"Mgr","mode":"sequential","requiredApprovals":1,"approverRoles":["ldx_manager"]}],"payload":{"__proto__":{"polluted":true},"amount":150}}');
  const cleanReqCtx = makeCtx(app, {
    method: 'POST',
    user: { id: 101, username: 'emp_a1' },
    role: 'ldx_employee',
    params: { values: dirtyPayload },
  });
  await actions.request(cleanReqCtx, async () => {});
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.hasOwn(cleanReqCtx.body.payloadJson, '__proto__'), false);
  assert.equal(cleanReqCtx.body.payloadJson.amount, 150);
});

test('conditional policy matching, cancel, listPolicies/deletePolicy, PAT scope guard, and concurrent decide race', async () => {
  const { app, resources, aclAllows } = makeApprovalHarness();
  const { registerApprovalEngine } = require('../src/server/approval-engine');
  registerApprovalEngine(app);
  const actions = resources.get('dxosApprovals');

  const aclEntry = aclAllows.find((a) => a.resource === 'dxosApprovals' && a.role === 'loggedIn');
  assert.ok(aclEntry);
  assert.equal(aclEntry.actions.includes('listInbox'), true);
  assert.equal(aclEntry.actions.includes('decide'), true);

  // Two policies for latticeOrders: high-value (>=1000) priority 10, default priority 50
  await actions.savePolicy(makeCtx(app, {
    method: 'POST',
    user: { id: 1, username: 'root' },
    role: 'root',
    params: {
      values: {
        organizationId: 'org-a',
        policyKey: 'orders-high-value',
        name: 'High Value Orders',
        targetCollection: 'latticeOrders',
        priority: 10,
        conditionJson: { amount: { $gte: 1000 } },
        stagesJson: [
          { name: 'Mgr', mode: 'sequential', requiredApprovals: 1, approverRoles: ['ldx_manager'] },
          { name: 'Dir', mode: 'sequential', requiredApprovals: 1, approverRoles: ['ldx_director'] },
        ],
      },
    },
  }), async () => {});

  await actions.savePolicy(makeCtx(app, {
    method: 'POST',
    user: { id: 1, username: 'root' },
    role: 'root',
    params: {
      values: {
        organizationId: 'org-a',
        policyKey: 'orders-standard',
        name: 'Standard Orders',
        targetCollection: 'latticeOrders',
        priority: 50,
        stagesJson: [{ name: 'Mgr', mode: 'sequential', requiredApprovals: 1, approverRoles: ['ldx_manager'] }],
      },
    },
  }), async () => {});

  const listPolCtx = makeCtx(app, { method: 'GET', user: { id: 101, username: 'emp_a1' }, role: 'ldx_employee' });
  await actions.listPolicies(listPolCtx, async () => {});
  assert.equal(listPolCtx.body.items.length, 2);

  // High-value payload matches orders-high-value (2 stages)
  const highReqCtx = makeCtx(app, {
    method: 'POST',
    user: { id: 101, username: 'emp_a1' },
    role: 'ldx_employee',
    params: { values: { targetCollection: 'latticeOrders', title: 'Big PO', payload: { amount: 2500 } } },
  });
  await actions.request(highReqCtx, async () => {});
  assert.equal(highReqCtx.body.policyKey, 'orders-high-value');
  assert.equal(highReqCtx.body.totalStages, 2);

  // Standard payload matches orders-standard (1 stage)
  const stdReqCtx = makeCtx(app, {
    method: 'POST',
    user: { id: 101, username: 'emp_a1' },
    role: 'ldx_employee',
    params: { values: { targetCollection: 'latticeOrders', title: 'Small PO', payload: { amount: 200 } } },
  });
  await actions.request(stdReqCtx, async () => {});
  assert.equal(stdReqCtx.body.policyKey, 'orders-standard');
  assert.equal(stdReqCtx.body.totalStages, 1);

  // Read-only PAT cannot mutate
  const roCtx = makeCtx(app, {
    method: 'POST',
    user: { id: 101, username: 'emp_a1' },
    role: 'ldx_employee',
    params: { values: { requestUid: stdReqCtx.body.requestUid, note: 'cancel' } },
  });
  roCtx.state.latticeApiKey = { scopes: ['read'] };
  await assert.rejects(
    () => actions.cancel(roCtx, async () => {}),
    { code: 'API_KEY_SCOPE_INSUFFICIENT', status: 403 },
  );

  // Another non-admin employee (105) cannot cancel 101's request
  await assert.rejects(
    () => actions.cancel(makeCtx(app, {
      method: 'POST',
      user: { id: 105, username: 'emp_a5' },
      role: 'ldx_employee',
      params: { values: { requestUid: stdReqCtx.body.requestUid, note: 'not mine' } },
    }), async () => {}),
    { code: 'APPROVAL_FORBIDDEN', status: 403 },
  );

  // Requester 101 cancels stdReqCtx
  const cancelCtx = makeCtx(app, {
    method: 'POST',
    user: { id: 101, username: 'emp_a1' },
    role: 'ldx_employee',
    params: { values: { requestUid: stdReqCtx.body.requestUid, note: 'No longer needed' } },
  });
  await actions.cancel(cancelCtx, async () => {});
  assert.equal(cancelCtx.body.status, 'cancelled');

  // Non-admin cannot deletePolicy
  await assert.rejects(
    () => actions.deletePolicy(makeCtx(app, {
      method: 'POST',
      user: { id: 102, username: 'mgr_a1' },
      role: 'ldx_manager',
      params: { values: { policyKey: 'orders-standard' } },
    }), async () => {}),
    { code: 'APPROVAL_ADMIN_REQUIRED', status: 403 },
  );

  // Root deletes orders-standard
  const delPolCtx = makeCtx(app, {
    method: 'POST',
    user: { id: 1, username: 'root' },
    role: 'root',
    params: { values: { organizationId: 'org-a', policyKey: 'orders-standard' } },
  });
  await actions.deletePolicy(delPolCtx, async () => {});
  assert.equal(delPolCtx.body.deleted, true);

  // Concurrent decide race on highReqCtx -> one succeeds, one fails 409
  const results = await Promise.allSettled([
    actions.decide(makeCtx(app, {
      method: 'POST',
      user: { id: 102, username: 'mgr_a1' },
      role: 'ldx_manager',
      params: { values: { source: 'business', requestUid: highReqCtx.body.requestUid, decision: 'approve' } },
    }), async () => {}),
    actions.decide(makeCtx(app, {
      method: 'POST',
      user: { id: 103, username: 'mgr_a2' },
      role: 'ldx_manager',
      params: { values: { source: 'business', requestUid: highReqCtx.body.requestUid, decision: 'approve' } },
    }), async () => {}),
  ]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.status, 409);
});

test('concurrent decide mixing requestUid and numeric id serializes cleanly on 2-of-2 stage (same user 409, two users approved)', async () => {
  const { app, tables, resources } = makeApprovalHarness();
  const { registerApprovalEngine, decideApprovalRequest } = require('../src/server/approval-engine');
  registerApprovalEngine(app);
  const actions = resources.get('dxosApprovals');

  // (a) Same user concurrently calls decideApprovalRequest with requestUid and String(row.id) on 2-of-2 stage
  const reqSameCtx = makeCtx(app, {
    method: 'POST',
    user: { id: 101, username: 'emp_a1' },
    role: 'ldx_employee',
    params: {
      values: {
        targetCollection: 'latticeOrders',
        title: 'Concurrent Mixed Key Same User',
        stages: [
          {
            stageIndex: 0,
            name: 'Committee 2-of-2',
            mode: 'parallel',
            requiredApprovals: 2,
            approverRoles: ['ldx_manager'],
          },
        ],
      },
    },
  });
  await actions.request(reqSameCtx, async () => {});
  const req1 = reqSameCtx.body;

  const sameUserResults = await Promise.allSettled([
    decideApprovalRequest(app.db, {
      organizationId: 'org-a',
      actor: { userId: 102, username: 'mgr_a1', organizationId: 'org-a', verifiedRoles: ['ldx_manager'], isRoot: false, isAdmin: false },
      requestIdOrUid: req1.requestUid,
      decision: 'approve',
      note: 'Vote via uid',
      app,
    }),
    decideApprovalRequest(app.db, {
      organizationId: 'org-a',
      actor: { userId: 102, username: 'mgr_a1', organizationId: 'org-a', verifiedRoles: ['ldx_manager'], isRoot: false, isAdmin: false },
      requestIdOrUid: String(req1.id),
      decision: 'approve',
      note: 'Vote via numeric id',
      app,
    }),
  ]);
  const sameFulfilled = sameUserResults.filter((r) => r.status === 'fulfilled');
  const sameRejected = sameUserResults.filter((r) => r.status === 'rejected');
  assert.equal(sameFulfilled.length, 1);
  assert.equal(sameRejected.length, 1);
  assert.equal(sameRejected[0].reason.status, 409);
  const stored1 = tables.latticeApprovalRequests.find((r) => r.id === req1.id);
  assert.equal(stored1.stagesStateJson[0].decisions.length, 1);
  assert.equal(stored1.status, 'pending');

  // (b) Two distinct users concurrently call decideApprovalRequest with requestUid and String(row.id) on 2-of-2 stage
  const reqTwoCtx = makeCtx(app, {
    method: 'POST',
    user: { id: 101, username: 'emp_a1' },
    role: 'ldx_employee',
    params: {
      values: {
        targetCollection: 'latticeOrders',
        title: 'Concurrent Mixed Key Two Users',
        stages: [
          {
            stageIndex: 0,
            name: 'Committee 2-of-2',
            mode: 'parallel',
            requiredApprovals: 2,
            approverRoles: ['ldx_manager'],
          },
        ],
      },
    },
  });
  await actions.request(reqTwoCtx, async () => {});
  const req2 = reqTwoCtx.body;

  const twoUserResults = await Promise.allSettled([
    decideApprovalRequest(app.db, {
      organizationId: 'org-a',
      actor: { userId: 102, username: 'mgr_a1', organizationId: 'org-a', verifiedRoles: ['ldx_manager'], isRoot: false, isAdmin: false },
      requestIdOrUid: req2.requestUid,
      decision: 'approve',
      note: 'Mgr1 via uid',
      app,
    }),
    decideApprovalRequest(app.db, {
      organizationId: 'org-a',
      actor: { userId: 103, username: 'mgr_a2', organizationId: 'org-a', verifiedRoles: ['ldx_manager'], isRoot: false, isAdmin: false },
      requestIdOrUid: String(req2.id),
      decision: 'approve',
      note: 'Mgr2 via numeric id',
      app,
    }),
  ]);
  const twoFulfilled = twoUserResults.filter((r) => r.status === 'fulfilled');
  const twoRejected = twoUserResults.filter((r) => r.status === 'rejected');
  assert.equal(twoFulfilled.length, 2, `Expected 2 fulfilled, got errors: ${twoRejected.map((r) => r.reason?.message).join('; ')}`);
  const stored2 = tables.latticeApprovalRequests.find((r) => r.id === req2.id);
  assert.equal(stored2.stagesStateJson[0].decisions.length, 2);
  assert.equal(stored2.status, 'approved');

  // (c) Verify reqRepo.model fallback is used for LOCK.UPDATE when db.getModel is absent
  const prevRlsEnv = process.env.DX_PG_RLS_SESSION;
  process.env.DX_PG_RLS_SESSION = 'true';
  try {
    const rlsHarness = makeApprovalHarness({ enforcePgRls: true });
    const lockCalls = [];
    const origGetRepo = rlsHarness.app.db.getRepository.bind(rlsHarness.app.db);
    rlsHarness.app.db.getRepository = (name) => {
      const repo = origGetRepo(name);
      if (name !== 'latticeApprovalRequests' || !repo) return repo;
      return {
        ...repo,
        model: {
          findOne: async ({ where, transaction, lock }) => {
            lockCalls.push({ where, hasTx: Boolean(transaction), lock });
            return repo.findOne({ filter: where, transaction });
          },
        },
      };
    };
    registerApprovalEngine(rlsHarness.app);
    const rlsActions = rlsHarness.resources.get('dxosApprovals');
    const reqModelCtx = makeCtx(rlsHarness.app, {
      method: 'POST',
      user: { id: 101, username: 'emp_a1' },
      role: 'ldx_employee',
      params: {
        values: {
          targetCollection: 'latticeOrders',
          title: 'Model Lock Fallback',
          stages: [{ stageIndex: 0, name: 'Committee', mode: 'parallel', requiredApprovals: 2, approverRoles: ['ldx_manager'] }],
        },
      },
    });
    await rlsActions.request(reqModelCtx, async () => {});
    const req3 = reqModelCtx.body;
    await Promise.all([
      decideApprovalRequest(rlsHarness.app.db, {
        organizationId: 'org-a',
        actor: { userId: 102, username: 'mgr_a1', organizationId: 'org-a', verifiedRoles: ['ldx_manager'], isRoot: false, isAdmin: false },
        requestIdOrUid: req3.requestUid,
        decision: 'approve',
        app: rlsHarness.app,
      }),
      decideApprovalRequest(rlsHarness.app.db, {
        organizationId: 'org-a',
        actor: { userId: 103, username: 'mgr_a2', organizationId: 'org-a', verifiedRoles: ['ldx_manager'], isRoot: false, isAdmin: false },
        requestIdOrUid: String(req3.id),
        decision: 'approve',
        app: rlsHarness.app,
      }),
    ]);
    assert.equal(lockCalls.length, 2);
    assert.equal(lockCalls[0].hasTx, true);
    assert.equal(lockCalls[0].lock, 'UPDATE');
    assert.equal(lockCalls[1].hasTx, true);
    assert.equal(lockCalls[1].lock, 'UPDATE');
    const stored3 = rlsHarness.tables.latticeApprovalRequests.find((r) => r.id === req3.id);
    assert.equal(stored3.stagesStateJson[0].decisions.length, 2);
    assert.equal(stored3.status, 'approved');
  } finally {
    if (prevRlsEnv === undefined) delete process.env.DX_PG_RLS_SESSION;
    else process.env.DX_PG_RLS_SESSION = prevRlsEnv;
  }
});

test('listUnifiedInbox({ assignedToMe: true }) includes pending business approvals matching scopeCollection delegation', async () => {
  const nowMs = Date.now();
  const { app, resources } = makeApprovalHarness({
    delegations: [
      {
        id: 10,
        organizationId: 'org-a',
        delegationUid: 'DLG-SCOPED-REQ',
        delegatorUserId: 104,
        delegateUserId: 105,
        roleName: 'ldx_director',
        scopeCollection: 'latticeRequests',
        startsAt: new Date(nowMs - 3600_000).toISOString(),
        endsAt: new Date(nowMs + 3600_000).toISOString(),
        status: 'active',
        active: true,
      },
    ],
    requests: [
      {
        id: 1,
        organizationId: 'org-a',
        requestUid: 'APR-SCOPED-REQ',
        targetCollection: 'latticeRequests',
        title: 'Scoped Request Approval',
        riskLevel: 'medium',
        status: 'pending',
        currentStageIndex: 0,
        totalStages: 1,
        stagesStateJson: [{ stageIndex: 0, name: 'Director', mode: 'sequential', requiredApprovals: 1, approverRoles: ['ldx_director'], approverUserIds: [], status: 'pending', decisions: [] }],
        requesterUserId: 101,
        requesterUsername: 'emp_a1',
        createdAt: '2026-11-25T10:00:00.000Z',
        active: true,
      },
      {
        id: 2,
        organizationId: 'org-a',
        requestUid: 'APR-OTHER-ORD',
        targetCollection: 'latticeOrders',
        title: 'Unmatched Order Approval',
        riskLevel: 'medium',
        status: 'pending',
        currentStageIndex: 0,
        totalStages: 1,
        stagesStateJson: [{ stageIndex: 0, name: 'Director', mode: 'sequential', requiredApprovals: 1, approverRoles: ['ldx_director'], approverUserIds: [], status: 'pending', decisions: [] }],
        requesterUserId: 101,
        requesterUsername: 'emp_a1',
        createdAt: '2026-11-25T11:00:00.000Z',
        active: true,
      },
    ],
  });
  const { registerApprovalEngine } = require('../src/server/approval-engine');
  registerApprovalEngine(app);
  const actions = resources.get('dxosApprovals');

  const inboxCtx = makeCtx(app, {
    method: 'GET',
    user: { id: 105, username: 'emp_a5' },
    role: 'ldx_employee',
    params: { source: 'business', status: 'pending', assignedToMe: true },
  });
  await actions.listInbox(inboxCtx, async () => {});

  assert.equal(inboxCtx.body.total, 1);
  assert.equal(inboxCtx.body.items[0].requestUid, 'APR-SCOPED-REQ');
  assert.equal(inboxCtx.body.items[0].targetCollection, 'latticeRequests');
  assert.equal(inboxCtx.body.items[0].canAct, true);
});

test('safeNotifyStageApprovers invokes omnichannel dispatchOmnichannel on approval request creation', async () => {
  const { encryptVaultSecrets } = require('../src/server/connector-vault');
  const { registerOmnichannelNotify } = require('../src/server/omnichannel-notify');
  const webhookCalls = [];
  const { app, tables, resources } = makeApprovalHarness({
    connectors: [
      {
        id: 1,
        organizationId: 'org-a',
        connectorKey: 'wh-approvals',
        name: 'Approval Webhook',
        connectorType: 'webhook',
        appType: 'partner_webhook',
        baseUrl: 'https://hooks.example.test/approvals',
        authType: 'none',
        encryptedSecretsJson: encryptVaultSecrets({ webhookUrl: 'https://hooks.example.test/approvals' }),
        active: true,
      },
    ],
  });

  registerOmnichannelNotify(app, {
    fetchImpl: async (url, init) => {
      webhookCalls.push({ url, body: JSON.parse(init.body) });
      return {
        ok: true,
        status: 200,
        text: async () => '{"ok":true}',
        body: { cancel: async () => {} },
      };
    },
    lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    enforceDnsInMock: true,
  });

  const { registerApprovalEngine } = require('../src/server/approval-engine');
  registerApprovalEngine(app);
  const actions = resources.get('dxosApprovals');

  await actions.savePolicy(makeCtx(app, {
    method: 'POST',
    user: { id: 1, username: 'root' },
    role: 'root',
    params: {
      values: {
        organizationId: 'org-a',
        policyKey: 'omni-webhook-policy',
        name: 'Omnichannel Policy',
        targetCollection: 'latticeOrders',
        notifyChannels: ['webhook'],
        stagesJson: [{ name: 'Mgr', mode: 'sequential', requiredApprovals: 1, approverRoles: ['ldx_manager'] }],
      },
    },
  }), async () => {});

  const reqCtx = makeCtx(app, {
    method: 'POST',
    user: { id: 101, username: 'emp_a1' },
    role: 'ldx_employee',
    params: {
      values: {
        policyKey: 'omni-webhook-policy',
        targetCollection: 'latticeOrders',
        targetRecordId: 77,
        title: 'Omnichannel Approval Alert',
      },
    },
  });
  await actions.request(reqCtx, async () => {});

  assert.equal(webhookCalls.length, 1);
  assert.equal(webhookCalls[0].url, 'https://hooks.example.test/approvals');
  assert.equal(tables.latticeNotificationDeliveries.length, 1);
  assert.equal(tables.latticeNotificationDeliveries[0].channel, 'webhook');
  assert.equal(tables.latticeNotificationDeliveries[0].status, 'sent');
  assert.equal(tables.latticeNotificationDeliveries[0].eventType, 'approval.stage_assigned');

  // Also verify direct omnichannel-notify fallback path when app.latticeOmnichannelNotify is unmounted
  delete app.latticeOmnichannelNotify;
  const omniMod = require('../src/server/omnichannel-notify');
  const origDispatch = omniMod.dispatchOmnichannel;
  const directCalls = [];
  omniMod.dispatchOmnichannel = async (dbArg, payloadArg, optsArg) => {
    directCalls.push({ dbArg, payloadArg, optsArg });
    return { organizationId: payloadArg.organizationId, channelsDispatched: ['webhook'], deliveries: [], okCount: 1, failedCount: 0, dryRunCount: 0 };
  };
  try {
    await actions.request(makeCtx(app, {
      method: 'POST',
      user: { id: 101, username: 'emp_a1' },
      role: 'ldx_employee',
      params: {
        values: {
          policyKey: 'omni-webhook-policy',
          targetCollection: 'latticeOrders',
          targetRecordId: 78,
          title: 'Direct Omni Fallback Alert',
        },
      },
    }), async () => {});
  } finally {
    omniMod.dispatchOmnichannel = origDispatch;
  }
  assert.equal(directCalls.length, 1);
  assert.equal(directCalls[0].payloadArg.eventType, 'approval.stage_assigned');
  assert.deepEqual(directCalls[0].payloadArg.channels, ['webhook']);
});

test('non-admin cannot bypass active org policy or set allowSelfApproval:true, and ai_hitl fallback fails closed (503) without executeApprovedWrite', async () => {
  const { app, tables, resources } = makeApprovalHarness({
    aiQueue: [
      {
        id: 50,
        organizationId: 'org-a',
        requesterUserId: 101,
        requesterUsername: 'emp_a1',
        aiEmployee: 'dxos-operator',
        toolName: 'dxos_wms_hold_lot',
        targetCollection: 'latticeStockLots',
        targetRecordId: 7,
        operation: 'hold',
        diffPreview: { title: 'Hold Stock Lot #7', riskLevel: 'high' },
        riskLevel: 'high',
        status: 'pending',
        createdAt: '2026-11-25T11:00:00.000Z',
      },
    ],
  });
  const { registerApprovalEngine, decideUnifiedInboxItem } = require('../src/server/approval-engine');
  registerApprovalEngine(app);
  const actions = resources.get('dxosApprovals');

  // Admin saves strict policy on latticeOrders (requires ldx_director, allowSelfApproval: false)
  await actions.savePolicy(makeCtx(app, {
    method: 'POST',
    user: { id: 1, username: 'root' },
    role: 'root',
    params: {
      values: {
        organizationId: 'org-a',
        policyKey: 'strict-orders',
        name: 'Strict Orders Policy',
        targetCollection: 'latticeOrders',
        allowSelfApproval: false,
        stagesJson: [{ name: 'Director Only', mode: 'sequential', requiredApprovals: 1, approverRoles: ['ldx_director'] }],
      },
    },
  }), async () => {});

  // Non-admin tries to bypass active policy with ad-hoc stages + allowSelfApproval: true
  const bypassCtx = makeCtx(app, {
    method: 'POST',
    user: { id: 101, username: 'emp_a1' },
    role: 'ldx_employee',
    params: {
      values: {
        targetCollection: 'latticeOrders',
        title: 'Bypass Policy Attempt',
        allowSelfApproval: true,
        stages: [{ name: 'Self', mode: 'sequential', requiredApprovals: 1, approverUserIds: [101] }],
      },
    },
  });
  await actions.request(bypassCtx, async () => {});
  assert.equal(bypassCtx.body.policyKey, 'strict-orders');
  assert.deepEqual(bypassCtx.body.stagesStateJson[0].approverRoles, ['ldx_director']);
  assert.equal(bypassCtx.body.payloadJson._approvalMeta.allowSelfApproval, false);

  // Even without an active policy on latticeCustomAdHoc, non-admin cannot enable allowSelfApproval: true
  const adhocCtx = makeCtx(app, {
    method: 'POST',
    user: { id: 101, username: 'emp_a1' },
    role: 'ldx_employee',
    params: {
      values: {
        targetCollection: 'latticeCustomAdHoc',
        title: 'Self Approval Attempt',
        allowSelfApproval: true,
        stages: [{ name: 'Self', mode: 'sequential', requiredApprovals: 1, approverUserIds: [101] }],
      },
    },
  });
  await actions.request(adhocCtx, async () => {});
  assert.equal(adhocCtx.body.payloadJson._approvalMeta.allowSelfApproval, false);
  await assert.rejects(
    () => actions.decide(makeCtx(app, {
      method: 'POST',
      user: { id: 101, username: 'emp_a1' },
      role: 'ldx_employee',
      params: { values: { source: 'business', requestUid: adhocCtx.body.requestUid, decision: 'approve' } },
    }), async () => {}),
    { code: 'SELF_APPROVAL_FORBIDDEN', status: 403 },
  );

  // ai_hitl fallback when dxosAi resource is unmounted fails closed (503) if no executeApprovedWrite supplied
  await assert.rejects(
    () => actions.decide(makeCtx(app, {
      method: 'POST',
      user: { id: 102, username: 'mgr_a1' },
      role: 'ldx_manager',
      params: { values: { source: 'ai_hitl', itemKey: 'ai:50', decision: 'approve', note: 'No executor' } },
    }), async () => {}),
    { code: 'HOST_ACTION_UNAVAILABLE', status: 503 },
  );
  assert.equal(tables.latticeAiApprovalQueue[0].status, 'pending');

  // When executeApprovedWrite IS supplied to decideUnifiedInboxItem, it executes the AI tool
  const origSeqQuery = app.db.sequelize.query.bind(app.db.sequelize);
  app.db.sequelize.query = async (sql, opts = {}) => {
    const s = String(sql || '');
    if (s.includes('UPDATE "latticeAiApprovalQueue"')) {
      const rep = opts.replacements || {};
      const row = tables.latticeAiApprovalQueue.find(
        (r) => Number(r.id) === Number(rep.id)
          && r.status === 'pending'
          && (!rep.organizationId || r.organizationId === rep.organizationId),
      );
      if (!row) return [[]];
      Object.assign(row, {
        status: rep.status,
        decidedByUserId: rep.decidedByUserId,
        decidedByUsername: rep.decidedByUsername,
        decisionNote: rep.decisionNote,
        decidedAt: rep.decidedAt,
      });
      return [[{ id: row.id }]];
    }
    return origSeqQuery(sql, opts);
  };

  let executedRowId = null;
  const aiDecided = await decideUnifiedInboxItem(
    app.db,
    makeCtx(app, {
      method: 'POST',
      user: { id: 102, username: 'mgr_a1' },
      role: 'ldx_manager',
    }),
    {
      source: 'ai_hitl',
      itemKey: 'ai:50',
      decision: 'approve',
      note: 'With executor',
      executeApprovedWrite: async (row) => {
        executedRowId = row.id;
        return { applied: true };
      },
    },
  );
  assert.equal(executedRowId, 50);
  assert.equal(aiDecided.status, 'executed');
  assert.equal(tables.latticeAiApprovalQueue[0].status, 'executed');

  // Verify PAT middleware allows ai-scoped PAT on dxosApprovals:decide for ai_hitl/flow, rejects read-only PAT & iot PAT
  const { createHash } = require('node:crypto');
  const { createPaasApiKeyAuthMiddleware } = require('../src/server/paas-api-keys');
  const hashTok = (t) => createHash('sha256').update(t, 'utf8').digest('hex');
  const roTok = 'ldx_pat_00000001_0123456789abcdef0123456789abcdef';
  const aiTok = 'ldx_pat_00000002_0123456789abcdef0123456789abcdef';
  const iotTok = 'ldx_pat_00000003_0123456789abcdef0123456789abcdef';
  const patDb = makeApprovalHarness().db;
  const origGetRepo = patDb.getRepository.bind(patDb);
  const patKeys = [
    { id: 1, organizationId: 'org-a', keyPrefix: 'ldx_pat_00000001', keyHash: hashTok(roTok), userId: 102, employeeId: 11, roleName: 'ldx_manager', scopesJson: ['read'], active: true, expiresAt: null },
    { id: 2, organizationId: 'org-a', keyPrefix: 'ldx_pat_00000002', keyHash: hashTok(aiTok), userId: 102, employeeId: 11, roleName: 'ldx_manager', scopesJson: ['ai'], active: true, expiresAt: null },
    { id: 3, organizationId: 'org-a', keyPrefix: 'ldx_pat_00000003', keyHash: hashTok(iotTok), userId: 102, employeeId: 11, roleName: 'ldx_manager', scopesJson: ['iot'], active: true, expiresAt: null },
  ];
  patDb.getRepository = (name) => {
    if (name === 'latticeApiKeys') {
      return {
        findOne: async ({ filter }) => patKeys.find((k) => k.keyHash === filter?.keyHash) || null,
        update: async () => [],
      };
    }
    if (name === 'users') {
      return {
        findOne: async ({ filter }) => (Number(filter?.id) === 102 ? { id: 102, username: 'mgr_a1', active: true } : null),
      };
    }
    return origGetRepo(name);
  };
  const patMw = createPaasApiKeyAuthMiddleware(patDb);
  const runPat = (token, method, actionName) => patMw({
    method,
    headers: { 'x-lattice-api-key': token },
    request: { headers: { 'x-lattice-api-key': token } },
    state: {},
    action: { resourceName: 'dxosApprovals', actionName, params: {} },
  }, async () => 'ok');

  await assert.rejects(() => runPat(roTok, 'POST', 'decide'), { code: 'API_KEY_SCOPE_INSUFFICIENT', status: 403 });
  await assert.rejects(() => runPat(roTok, 'GET', 'decide'), { code: 'API_KEY_SCOPE_INSUFFICIENT', status: 403 });
  await assert.rejects(() => runPat(roTok, 'GET', 'request'), { code: 'API_KEY_SCOPE_INSUFFICIENT', status: 403 });
  await assert.rejects(() => runPat(roTok, 'GET', 'evaluateSlaNow'), { code: 'API_KEY_SCOPE_INSUFFICIENT', status: 403 });
  await assert.rejects(() => runPat(iotTok, 'POST', 'decide'), { code: 'API_KEY_SCOPE_INSUFFICIENT', status: 403 });
  assert.equal(await runPat(aiTok, 'POST', 'decide'), 'ok');
});

test('approval-engine rejects __proto__, constructor, prototype, all, and ALL as organizationId with HTTP 400', async () => {
  await withMockedNocobase(async () => {
    const {
      saveApprovalPolicy,
      requestApproval,
      registerApprovalEngine,
    } = require('../src/server/approval-engine');
    const { db } = makeApprovalHarness();
    const resources = new Map();
    const app = {
      db,
      resourceManager: { define: (def) => resources.set(def.name, def.actions), use() {} },
      acl: { allow() {} },
    };
    registerApprovalEngine(app);
    const actions = resources.get('dxosApprovals');

    for (const badOrg of ['__proto__', 'constructor', 'prototype', 'all', 'ALL']) {
      await assert.rejects(
        () => saveApprovalPolicy(db, {
          organizationId: badOrg,
          actor: { userId: 1, isRoot: true, isAdmin: true },
          input: { policyKey: 'pol-1', name: 'Pol', targetCollection: 'latticeRequests', stages: [] },
        }),
        (err) => err && err.status === 400 && err.code === 'APPROVAL_ORG_REQUIRED',
      );
      await assert.rejects(
        () => requestApproval(db, {
          organizationId: badOrg,
          actor: { userId: 1 },
          policyKey: 'pol-1',
          targetCollection: 'latticeRequests',
          targetRecordId: 1,
        }),
        (err) => err && err.status === 400 && err.code === 'APPROVAL_ORG_REQUIRED',
      );
      const listCtx = {
        method: 'GET',
        state: { currentUser: { id: 1 }, currentRole: 'root', currentRoles: ['root'] },
        action: { params: { organizationId: badOrg } },
        request: { body: {} },
        throw(status, msg) { throw Object.assign(new Error(msg || `HTTP ${status}`), { status }); },
      };
      await assert.rejects(
        () => actions.listInbox(listCtx),
        (err) => err && err.status === 400 && err.code === 'APPROVAL_ORG_INVALID',
      );
    }
  });
});

test('listUnifiedInbox forwards diffPreview and proposedArgs on ai_hitl and business items', async () => {
  await withMockedNocobase(async () => {
    const { listUnifiedInbox } = require('../src/server/approval-engine');
    const { db, tables } = makeApprovalHarness();
    tables.latticeAiApprovalQueue.push({
      id: 701,
      organizationId: 'org-a',
      toolName: 'orders.escalate',
      aiEmployee: 'dispatch-ai',
      targetCollection: 'latticeOrders',
      targetRecordId: 88,
      operation: 'update',
      riskLevel: 'high',
      status: 'pending',
      requesterUserId: 101,
      requesterUsername: 'emp_a1',
      diffPreview: {
        title: 'Nâng ưu tiên đơn gấp #88',
        summary: 'Đơn cold-chain sắp quá hạn SLA',
        before: { priority: 'normal', assignedDriver: 'DRV-01' },
        after: { priority: 'urgent', assignedDriver: 'DRV-09' },
      },
      proposedArgs: { priority: 'urgent', assignedDriver: 'DRV-09' },
      createdAt: '2026-11-26T03:00:00.000Z',
    });

    const out = await listUnifiedInbox(db, {
      organizationId: 'org-a',
      actor: { userId: 1, isRoot: true, isAdmin: true, roles: ['root'] },
      source: 'ai_hitl',
      status: 'pending',
    });
    assert.equal(out.items.length, 1);
    assert.deepEqual(out.items[0].diffPreview, {
      title: 'Nâng ưu tiên đơn gấp #88',
      summary: 'Đơn cold-chain sắp quá hạn SLA',
      before: { priority: 'normal', assignedDriver: 'DRV-01' },
      after: { priority: 'urgent', assignedDriver: 'DRV-09' },
    });
    assert.deepEqual(out.items[0].proposedArgs, { priority: 'urgent', assignedDriver: 'DRV-09' });
  });
});


