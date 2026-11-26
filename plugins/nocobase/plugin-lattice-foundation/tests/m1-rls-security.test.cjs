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

const pgRls = require('../src/server/pg-rls');
const { submitVoucher, cancelVoucher, amendVoucher } = require('../src/server/voucher-lifecycle');
const { claimDueDeliveries, dispatchDueWebhookDeliveries, syncParentEventStatus } = require('../src/server/event-bus');
const { registerPaasApiKeys } = require('../src/server/paas-api-keys');

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

function makeStrictPgRlsTracker() {
  const txLog = [];
  const savepointEvents = [];
  let txSeq = 0;

  const assertRlsInTx = (tx, op) => {
    if (!tx) {
      throw Object.assign(new Error(`RLS violation (${op}): missing transaction`), { code: '42501', status: 403 });
    }
    if (!tx.currentOrg && !tx.rlsBypass) {
      throw Object.assign(new Error(`RLS violation (${op}): transaction ${tx.id} lacks app.current_org or app.rls_bypass`), {
        code: '42501',
        status: 403,
      });
    }
  };

  const sequelize = {
    getDialect: () => 'postgres',
    async transaction(fn) {
      const tx = {
        id: ++txSeq,
        currentOrg: null,
        rlsBypass: false,
        savepoints: [],
        LOCK: { UPDATE: 'UPDATE' },
      };
      txLog.push(tx);
      return fn(tx);
    },
    async query(sql, opts = {}) {
      const tx = opts.transaction;
      const clean = String(sql || '').trim();
      if (/set_config\('app\.current_org'/i.test(clean)) {
        assertRlsInTx({ ...tx, currentOrg: 'pending' }, 'set_config');
        tx.currentOrg = opts.replacements?.orgId || null;
        return [[{ set_config: tx.currentOrg }]];
      }
      if (/set_config\('app\.rls_bypass',\s*'on'/i.test(clean)) {
        tx.rlsBypass = true;
        return [[{ set_config: 'on' }]];
      }
      const spCreate = clean.match(/^SAVEPOINT\s+"([^"]+)"$/i);
      if (spCreate) {
        tx.savepoints.push(spCreate[1]);
        savepointEvents.push({ type: 'SAVEPOINT', name: spCreate[1], txId: tx.id });
        return [[]];
      }
      const spRelease = clean.match(/^RELEASE SAVEPOINT\s+"([^"]+)"$/i);
      if (spRelease) {
        savepointEvents.push({ type: 'RELEASE', name: spRelease[1], txId: tx.id });
        return [[]];
      }
      const spRollback = clean.match(/^ROLLBACK TO SAVEPOINT\s+"([^"]+)"$/i);
      if (spRollback) {
        savepointEvents.push({ type: 'ROLLBACK', name: spRollback[1], txId: tx.id });
        return [[]];
      }
      assertRlsInTx(tx, clean.slice(0, 60));
      return [[]];
    },
  };

  return { sequelize, txLog, savepointEvents, assertRlsInTx };
}

test('P0-08 & P1-17: pg-rls TENANT_RLS_TABLES includes latticeAiQuotaPolicies and latticeUiSnapshots (>= 56 tables)', async () => {
  assert.ok(
    pgRls.TENANT_RLS_TABLES.length >= 56,
    `Expected >= 56 TENANT_RLS_TABLES, got ${pgRls.TENANT_RLS_TABLES.length}`,
  );
  for (const tbl of ['latticeAiQuotaPolicies', 'latticeUiSnapshots']) {
    assert.ok(pgRls.TENANT_RLS_TABLES.includes(tbl), `Missing ${tbl} in TENANT_RLS_TABLES`);
    assert.equal(pgRls.resolveTenantOrgColumn(tbl), 'organizationId');
    const sql = pgRls.buildRlsPolicySql(tbl);
    assert.match(sql.enableSql, new RegExp(`ALTER TABLE public\\."${tbl}" ENABLE ROW LEVEL SECURITY`));
    assert.match(sql.enableSql, new RegExp(`ALTER TABLE public\\."${tbl}" FORCE ROW LEVEL SECURITY`));
    assert.match(sql.createSql, /"organizationId" = nullif\(current_setting\('app\.current_org', true\), ''\)/);
  }

  const fakeDb = {
    sequelize: {
      getDialect: () => 'postgres',
      query: async () => [[
        { table_name: 'latticeAiQuotaPolicies' },
        { table_name: 'latticeUiSnapshots' },
        { table_name: 'latticeOrders' },
      ]],
    },
  };
  const discovered = await pgRls.discoverTenantRlsTables(fakeDb);
  assert.ok(discovered.includes('latticeAiQuotaPolicies'));
  assert.ok(discovered.includes('latticeUiSnapshots'));
});

test('P1-17: voucher-lifecycle runVoucherTenantTx uses SAVEPOINT inside active RLS context and never opens bare sequelize.transaction', async () => {
  const tracker = makeStrictPgRlsTracker();
  const orders = [
    { id: 1, organizationId: 'org-a', code: 'ORD-001', requesterId: 3, status: 'draft', version: 1, amendmentNo: 0 },
    { id: 2, organizationId: 'org-b', code: 'ORD-002', requesterId: 8, status: 'draft', version: 1, amendmentNo: 0 },
  ];
  const employees = [
    { id: 3, userId: 30, organizationId: 'org-a', active: true },
    { id: 8, userId: 80, organizationId: 'org-b', active: true },
  ];

  const wrapRow = (row) => ({
    ...row,
    get: (k) => row[k],
    toJSON: () => ({ ...row }),
    async update(patch, opts) {
      tracker.assertRlsInTx(opts?.transaction, 'row.update');
      Object.assign(row, patch);
    },
  });

  const filterRows = (rows, filter = {}, tx) => {
    return rows.filter((r) => {
      if (tx && !tx.rlsBypass && tx.currentOrg && r.organizationId !== tx.currentOrg) return false;
      return Object.entries(filter).every(([k, v]) => r[k] === v);
    });
  };

  const db = {
    sequelize: tracker.sequelize,
    getModel(name) {
      if (name !== 'latticeOrders') return null;
      return {
        async findOne({ where, transaction }) {
          tracker.assertRlsInTx(transaction, 'orders.findOne');
          const hit = filterRows(orders, where, transaction)[0];
          return hit ? wrapRow(hit) : null;
        },
      };
    },
    getRepository(name) {
      if (name === 'latticeOrders') {
        return {
          async findOne({ filter, transaction }) {
            tracker.assertRlsInTx(transaction, 'ordersRepo.findOne');
            const hit = filterRows(orders, filter, transaction)[0];
            return hit ? wrapRow(hit) : null;
          },
          async update({ filterByTk, filter, values, transaction }) {
            tracker.assertRlsInTx(transaction, 'ordersRepo.update');
            const hit = filterRows(orders, { id: filterByTk, ...(filter || {}) }, transaction)[0];
            if (!hit) return [];
            Object.assign(hit, values);
            return [wrapRow(hit)];
          },
          async create({ values, transaction }) {
            tracker.assertRlsInTx(transaction, 'ordersRepo.create');
            const created = { id: orders.length + 10, ...values };
            orders.push(created);
            return wrapRow(created);
          },
        };
      }
      if (name === 'latticeEmployees') {
        return {
          async findOne({ filter, transaction }) {
            if (transaction) tracker.assertRlsInTx(transaction, 'empRepo.findOne');
            const hit = filterRows(employees, filter, transaction)[0];
            return hit ? wrapRow(hit) : null;
          },
        };
      }
      if (name === 'rolesUsers') {
        return { async find() { return []; } };
      }
      return null;
    },
  };

  const actorA = { userId: '30', employeeId: 3, username: 'emp-a', roleNames: ['ldx_employee'] };

  await withEnv({ DX_PG_RLS_SESSION: 'true' }, async () => {
    // 1. Nested inside active tenant RLS context -> reuses outer tx via SAVEPOINT (txCount stays 1)
    await pgRls.withTenantRlsContext(db, 'org-a', async () => {
      const submitted = await submitVoucher(db, {
        collection: 'latticeOrders',
        id: 1,
        organizationId: 'org-a',
        actor: actorA,
      });
      assert.equal(submitted.status, 'submitted');
      assert.equal(tracker.txLog.length, 1);

      // 2. Mismatched expectedVersion inside active RLS context rolls back savepoint without opening new tx
      await assert.rejects(
        () => submitVoucher(db, {
          collection: 'latticeOrders',
          id: 1,
          organizationId: 'org-a',
          actor: actorA,
          expectedVersion: 99,
        }),
        (err) => err.status === 409 || err.code === 'VOUCHER_SUBMIT_INVALID_STATE',
      );
      assert.equal(tracker.txLog.length, 1);

      // 3. Cross-org voucher inside org-a context fails 404
      await assert.rejects(
        () => submitVoucher(db, {
          collection: 'latticeOrders',
          id: 2,
          organizationId: 'org-b',
          actor: actorA,
        }),
        (err) => err.status === 404 && err.code === 'VOUCHER_NOT_FOUND',
      );

      // 4. cancelVoucher & amendVoucher also reuse outer RLS tx via SAVEPOINT
      const cancelled = await cancelVoucher(db, {
        collection: 'latticeOrders',
        id: 1,
        organizationId: 'org-a',
        actor: actorA,
        cancelReason: 'Khach hang doi lich giao',
      });
      assert.equal(cancelled.status, 'cancelled');
      assert.equal(tracker.txLog.length, 1);

      const amended = await amendVoucher(db, {
        collection: 'latticeOrders',
        id: 1,
        organizationId: 'org-a',
        actor: actorA,
        values: { name: 'Don lanh sua doi' },
      });
      assert.equal(amended.amendedFromId, 1);
      assert.equal(tracker.txLog.length, 1);
    });

    assert.ok(tracker.savepointEvents.some((e) => e.type === 'SAVEPOINT' && e.txId === 1));
    assert.ok(tracker.savepointEvents.some((e) => e.type === 'RELEASE' && e.txId === 1));

    // 5. Top-level call with missing organizationId fails closed instead of bare sequelize.transaction
    await assert.rejects(
      () => submitVoucher(db, {
        collection: 'latticeOrders',
        id: 1,
        organizationId: '',
        actor: actorA,
      }),
      { code: 'INVALID_RLS_ORGANIZATION' },
    );
  });
});

test('P1-17: event-bus claimDueDeliveries uses SAVEPOINT inside active RLS context and withTenantRlsContext/withSystemRlsBypass top-level', async () => {
  const tracker = makeStrictPgRlsTracker();
  const subscriptions = [
    { id: 11, organizationId: 'org-a', active: true, circuitState: 'closed' },
    { id: 12, organizationId: 'org-b', active: true, circuitState: 'closed' },
  ];
  const deliveries = [
    { id: 101, organizationId: 'org-a', subscriptionId: 11, status: 'pending', nextAttemptAt: null },
    { id: 102, organizationId: 'org-b', subscriptionId: 12, status: 'pending', nextAttemptAt: null },
  ];

  const origQuery = tracker.sequelize.query.bind(tracker.sequelize);
  tracker.sequelize.query = async (sql, opts = {}) => {
    const clean = String(sql || '').trim();
    if (/SELECT d\.id\s+FROM "latticeWebhookDeliveries"/i.test(clean)) {
      tracker.assertRlsInTx(opts.transaction, 'claimDueDeliveries.SELECT');
      const orgFilter = opts.replacements?.organizationId || (!opts.transaction.rlsBypass ? opts.transaction.currentOrg : null);
      const rows = deliveries
        .filter((d) => d.status === 'pending' && (!orgFilter || d.organizationId === orgFilter))
        .map((d) => ({ id: d.id }));
      return [rows];
    }
    if (/UPDATE "latticeWebhookDeliveries" SET status = 'retry_wait'/i.test(clean)) {
      tracker.assertRlsInTx(opts.transaction, 'claimDueDeliveries.reclaim');
      return [[]];
    }
    return origQuery(sql, opts);
  };

  const wrapDelivery = (row) => ({
    ...row,
    get: (k) => row[k],
    toJSON: () => ({ ...row }),
    async update(patch, opts) {
      tracker.assertRlsInTx(opts?.transaction, 'delivery.update');
      Object.assign(row, patch);
    },
  });

  const db = {
    sequelize: tracker.sequelize,
    getModel(name) {
      if (name !== 'latticeWebhookDeliveries') return null;
      return {
        async findByPk(id, { transaction }) {
          tracker.assertRlsInTx(transaction, 'delivery.findByPk');
          const hit = deliveries.find(
            (d) => d.id === id && (transaction.rlsBypass || d.organizationId === transaction.currentOrg),
          );
          return hit ? wrapDelivery(hit) : null;
        },
      };
    },
    getRepository(name) {
      if (name !== 'latticeWebhookDeliveries') return null;
      return {
        async findOne({ filter, transaction }) {
          tracker.assertRlsInTx(transaction, 'deliveryRepo.findOne');
          const hit = deliveries.find((d) => d.id === filter?.id);
          return hit ? wrapDelivery(hit) : null;
        },
        async update({ filterByTk, values, transaction }) {
          tracker.assertRlsInTx(transaction, 'deliveryRepo.update');
          const hit = deliveries.find((d) => d.id === filterByTk);
          if (!hit) return [];
          Object.assign(hit, values);
          return [wrapDelivery(hit)];
        },
      };
    },
  };

  await withEnv({ DX_PG_RLS_SESSION: 'true' }, async () => {
    // 1. Nested inside active tenant RLS context -> txCount stays 1, uses SAVEPOINT, only org-a claimed
    await pgRls.withTenantRlsContext(db, 'org-a', async () => {
      const claimed = await claimDueDeliveries(db, { organizationId: 'org-a' });
      assert.equal(claimed.length, 1);
      assert.equal(claimed[0].id, 101);
      assert.equal(tracker.txLog.length, 1);
      assert.ok(tracker.savepointEvents.some((e) => e.type === 'SAVEPOINT' && e.txId === 1));
    });

    // Reset delivery 101 for next checks
    deliveries[0].status = 'pending';

    // 2. Nested inside system RLS bypass -> txCount stays 2 (1 new outer tx), uses SAVEPOINT
    await pgRls.withSystemRlsBypass(db, async () => {
      const claimed = await claimDueDeliveries(db, { organizationId: null });
      assert.equal(claimed.length, 2);
      assert.equal(tracker.txLog.length, 2);
      assert.ok(tracker.savepointEvents.some((e) => e.type === 'SAVEPOINT' && e.txId === 2));
    });

    deliveries[0].status = 'pending';
    deliveries[1].status = 'pending';

    // 3. Top-level with organizationId -> opens withTenantRlsContext
    const orgAClaimed = await claimDueDeliveries(db, { organizationId: 'org-a' });
    assert.equal(orgAClaimed.length, 1);
    assert.equal(orgAClaimed[0].id, 101);
    assert.equal(tracker.txLog[tracker.txLog.length - 1].currentOrg, 'org-a');

    // 4. Top-level drainer (organizationId: null) -> opens withSystemRlsBypass
    const sysClaimed = await claimDueDeliveries(db, { organizationId: null });
    assert.equal(sysClaimed.length, 1);
    assert.equal(sysClaimed[0].id, 102);
    assert.equal(tracker.txLog[tracker.txLog.length - 1].rlsBypass, true);
  });
});

test('P2-01: dxosApiKeys:list enforces 403 NATIVE_ORGANIZATION_MISMATCH for non-root and 400 API_KEY_ORG_INVALID for root', async () => {
  const employees = [
    { id: 1, userId: 10, organizationId: 'org-a', active: true },
    { id: 2, userId: 20, organizationId: 'org-a', active: true },
    { id: 3, userId: 30, organizationId: 'org-b', active: true },
  ];
  const rolesUsers = [
    { userId: 10, roleName: 'ldx_admin' },
    { userId: 20, roleName: 'ldx_employee' },
    { userId: 30, roleName: 'ldx_admin' },
    { userId: 1, roleName: 'root' },
  ];
  const roles = [
    { name: 'ldx_admin', allowConfigure: true },
    { name: 'ldx_employee', allowConfigure: false },
  ];
  const apiKeys = [
    { id: 1, organizationId: 'org-a', userId: 10, name: 'Admin A Key', keyPrefix: 'ldx_pat_1111', keyHash: 'h1', roleName: 'ldx_admin', scopesJson: ['read'], active: true },
    { id: 2, organizationId: 'org-a', userId: 20, name: 'Emp A Key', keyPrefix: 'ldx_pat_2222', keyHash: 'h2', roleName: 'ldx_employee', scopesJson: ['read'], active: true },
    { id: 3, organizationId: 'org-b', userId: 30, name: 'Admin B Key', keyPrefix: 'ldx_pat_3333', keyHash: 'h3', roleName: 'ldx_admin', scopesJson: ['read'], active: true },
  ];

  const tables = {
    latticeEmployees: employees,
    rolesUsers,
    roles,
    latticeApiKeys: apiKeys,
  };

  const matchFilter = (row, filter = {}) => Object.entries(filter).every(([k, v]) => {
    if (v && typeof v === 'object' && Array.isArray(v.$in)) {
      return v.$in.includes(row[k]);
    }
    return row[k] === v;
  });
  const db = {
    sequelize: { getDialect: () => 'sqlite' },
    getRepository(name) {
      const rows = tables[name];
      if (!rows) return null;
      return {
        async find({ filter = {}, limit = 50 } = {}) {
          return rows.filter((r) => matchFilter(r, filter)).slice(0, limit);
        },
        async findOne({ filter = {} } = {}) {
          return rows.find((r) => matchFilter(r, filter)) || null;
        },
      };
    },
  };

  const resources = new Map();
  const app = {
    db,
    resourceManager: {
      define(def) { resources.set(def.name, def.actions); },
      use() {},
    },
    acl: { allow() {} },
  };
  registerPaasApiKeys(app);
  const actions = resources.get('dxosApiKeys');
  assert.ok(actions?.list);

  const makeCtx = ({ userId, currentRole, params = {} }) => ({
    method: 'GET',
    state: { currentUser: { id: userId, username: `u-${userId}` }, currentRole },
    action: { params },
    throw(status, msg) { throw Object.assign(new Error(msg || String(status)), { status }); },
  });

  // 1. Non-root admin/employee passing mismatched organizationId -> 403 NATIVE_ORGANIZATION_MISMATCH
  for (const caller of [
    { userId: 10, currentRole: 'ldx_admin' },
    { userId: 20, currentRole: 'ldx_employee' },
  ]) {
    await assert.rejects(
      () => actions.list(makeCtx({ ...caller, params: { organizationId: 'org-b' } }), async () => {}),
      (err) => err.status === 403 && err.code === 'NATIVE_ORGANIZATION_MISMATCH',
    );
  }

  // 2. Non-root passing matching org, empty string, or omitting -> succeeds scoped to org-a
  for (const params of [{ organizationId: 'org-a' }, { organizationId: '' }, {}]) {
    const ctx = makeCtx({ userId: 10, currentRole: 'ldx_admin', params });
    await actions.list(ctx, async () => {});
    assert.equal(ctx.body.organizationId, 'org-a');
    assert.equal(ctx.body.items.length, 2);
    assert.ok(ctx.body.items.every((k) => k.organizationId === 'org-a'));
  }

  // 3. Root passing invalid or reserved organizationId -> 400 API_KEY_ORG_INVALID
  for (const badOrg of ['bad;org', 'all', '__proto__', 'constructor', 'prototype', ['org-b']]) {
    await assert.rejects(
      () => actions.list(makeCtx({ userId: 1, currentRole: 'root', params: { organizationId: badOrg } }), async () => {}),
      (err) => err.status === 400 && err.code === 'API_KEY_ORG_INVALID',
    );
  }

  // 3b. Non-root passing non-string organizationId (e.g., array ['org-a']) -> 400 API_KEY_ORG_INVALID
  await assert.rejects(
    () => actions.list(makeCtx({ userId: 10, currentRole: 'ldx_admin', params: { organizationId: ['org-a'] } }), async () => {}),
    (err) => err.status === 400 && err.code === 'API_KEY_ORG_INVALID',
  );

  // 4. Root passing valid organizationId -> scoped to org-b
  const rootOrgB = makeCtx({ userId: 1, currentRole: 'root', params: { organizationId: 'org-b' } });
  await actions.list(rootOrgB, async () => {});
  assert.equal(rootOrgB.body.organizationId, 'org-b');
  assert.equal(rootOrgB.body.items.length, 1);
  assert.equal(rootOrgB.body.items[0].name, 'Admin B Key');
});

test('P1-17: event-bus claimDueDeliveries (staleLockMs), dispatchDueWebhookDeliveries, and syncParentEventStatus never leak db1 RLS tx into db2', async () => {
  const tracker1 = makeStrictPgRlsTracker();
  const tracker2 = makeStrictPgRlsTracker();
  const tagSeq = (tracker, owner) => {
    const origTx = tracker.sequelize.transaction.bind(tracker.sequelize);
    tracker.sequelize._owner = owner;
    tracker.sequelize.transaction = async (fn) => origTx(async (tx) => {
      tx._owner = owner;
      return fn(tx);
    });
  };
  tagSeq(tracker1, 'db1');
  tagSeq(tracker2, 'db2');

  const assertDb2Tx = (tx, op) => {
    if (tx && tx._owner !== 'db2') {
      throw new Error(`CROSS_SEQUELIZE_TX_LEAK in ${op}: got tx from ${tx._owner || 'unknown'}`);
    }
    tracker2.assertRlsInTx(tx, op);
  };

  const subscriptions = [
    { id: 21, organizationId: 'org-b', targetUrl: 'https://hooks.example.com/b', active: true, circuitState: 'closed', failureCount: 0 },
  ];
  const deliveries = [
    {
      id: 201,
      organizationId: 'org-b',
      eventId: 'ev-b-1',
      subscriptionId: 21,
      eventType: 'order.created',
      status: 'processing',
      attempt: 0,
      maxAttempts: 3,
      lockedAt: new Date(Date.now() - 300_000),
      lockedBy: 'dead-worker',
      nextAttemptAt: new Date(Date.now() - 300_000),
      payloadSnapshotJson: { ok: 1 },
    },
    {
      id: 202,
      organizationId: 'org-b',
      eventId: 'ev-b-2',
      subscriptionId: 21,
      eventType: 'order.created',
      status: 'pending',
      attempt: 0,
      maxAttempts: 3,
      lockedAt: null,
      lockedBy: null,
      nextAttemptAt: new Date(Date.now() - 1000),
      payloadSnapshotJson: { ok: 2 },
    },
  ];
  const events = [
    { id: 301, organizationId: 'org-b', eventId: 'ev-b-1', status: 'queued' },
    { id: 302, organizationId: 'org-b', eventId: 'ev-b-2', status: 'queued' },
  ];

  let reclaimCount = 0;
  const origQuery2 = tracker2.sequelize.query.bind(tracker2.sequelize);
  tracker2.sequelize.query = async (sql, opts = {}) => {
    const clean = String(sql || '').trim();
    if (/UPDATE "latticeWebhookDeliveries" SET status = 'retry_wait'/i.test(clean)) {
      assertDb2Tx(opts.transaction, 'db2.reclaim');
      reclaimCount += 1;
      for (const d of deliveries) {
        if (d.status === 'processing' && d.lockedAt && d.lockedAt < opts.replacements.cutoff) {
          d.status = 'retry_wait';
          d.lockedAt = null;
          d.lockedBy = null;
          d.nextAttemptAt = new Date();
        }
      }
      return [[]];
    }
    if (/SELECT d\.id\s+FROM "latticeWebhookDeliveries"/i.test(clean)) {
      assertDb2Tx(opts.transaction, 'db2.claimSelect');
      const orgFilter = opts.replacements?.organizationId || opts.transaction.currentOrg;
      const rows = deliveries
        .filter((d) => ['pending', 'retry_wait'].includes(d.status) && d.organizationId === orgFilter)
        .map((d) => ({ id: d.id }));
      return [rows];
    }
    return origQuery2(sql, opts);
  };

  const wrapRow = (row, opPrefix) => ({
    ...row,
    get: (k) => row[k],
    toJSON: () => ({ ...row }),
    async update(patch, opts) {
      assertDb2Tx(opts?.transaction, `${opPrefix}.row.update`);
      Object.assign(row, patch);
    },
  });

  const db1 = { sequelize: tracker1.sequelize, getRepository: () => null };
  const db2 = {
    sequelize: tracker2.sequelize,
    getModel(name) {
      if (name !== 'latticeWebhookDeliveries') return null;
      return {
        async findByPk(id, { transaction } = {}) {
          assertDb2Tx(transaction, 'db2.delModel.findByPk');
          const hit = deliveries.find((d) => d.id === id && d.organizationId === transaction.currentOrg);
          return hit ? wrapRow(hit, 'del') : null;
        },
      };
    },
    getRepository(name) {
      if (name === 'latticeWebhookDeliveries') {
        return {
          async find({ filter = {}, transaction } = {}) {
            assertDb2Tx(transaction, 'db2.delRepo.find');
            return deliveries
              .filter((d) => Object.entries(filter).every(([k, v]) => d[k] === v))
              .map((d) => wrapRow(d, 'del'));
          },
          async findOne({ filter = {}, transaction } = {}) {
            assertDb2Tx(transaction, 'db2.delRepo.findOne');
            const hit = deliveries.find((d) => Object.entries(filter).every(([k, v]) => d[k] === v));
            return hit ? wrapRow(hit, 'del') : null;
          },
          async update({ filterByTk, values, transaction } = {}) {
            assertDb2Tx(transaction, 'db2.delRepo.update');
            const hit = deliveries.find((d) => d.id === filterByTk);
            if (!hit) return [];
            Object.assign(hit, values);
            return [wrapRow(hit, 'del')];
          },
        };
      }
      if (name === 'latticeWebhookSubscriptions') {
        return {
          async findOne({ filter = {}, transaction } = {}) {
            assertDb2Tx(transaction, 'db2.subRepo.findOne');
            const hit = subscriptions.find((s) => Object.entries(filter).every(([k, v]) => s[k] === v));
            return hit ? wrapRow(hit, 'sub') : null;
          },
          async update({ filterByTk, values, transaction } = {}) {
            assertDb2Tx(transaction, 'db2.subRepo.update');
            const hit = subscriptions.find((s) => s.id === filterByTk);
            if (!hit) return [];
            Object.assign(hit, values);
            return [wrapRow(hit, 'sub')];
          },
        };
      }
      if (name === 'latticeEventBus') {
        return {
          async findOne({ filter = {}, transaction } = {}) {
            assertDb2Tx(transaction, 'db2.eventRepo.findOne');
            const hit = events.find((e) => Object.entries(filter).every(([k, v]) => e[k] === v));
            return hit ? wrapRow(hit, 'ev') : null;
          },
          async update({ filterByTk, values, transaction } = {}) {
            assertDb2Tx(transaction, 'db2.eventRepo.update');
            const hit = events.find((e) => e.id === filterByTk);
            if (!hit) return [];
            Object.assign(hit, values);
            return [wrapRow(hit, 'ev')];
          },
        };
      }
      return null;
    },
  };

  await withEnv({ DX_PG_RLS_SESSION: 'true' }, async () => {
    await pgRls.withTenantRlsContext(db1, 'org-a', async () => {
      // 1. claimDueDeliveries(db2) reclaims stale lock on db2 and claims both org-b deliveries without leaking db1 tx
      const claimed = await claimDueDeliveries(db2, { organizationId: 'org-b', staleLockMs: 120_000 });
      assert.equal(reclaimCount, 1);
      assert.deepEqual(claimed.map((d) => d.id), [201, 202]);

      // Reset for dispatchDueWebhookDeliveries(db2)
      deliveries[0].status = 'processing';
      deliveries[0].lockedAt = new Date(Date.now() - 300_000);
      deliveries[1].status = 'pending';
      deliveries[1].lockedAt = null;

      // 2. dispatchDueWebhookDeliveries(db2) runs reclaim, claim, dispatchOneDelivery, and syncParentEventStatus on db2
      const dispatchRes = await dispatchDueWebhookDeliveries(db2, {
        organizationId: 'org-b',
        staleLockMs: 120_000,
        fetchImpl: async () => ({ status: 200, body: { cancel: async () => {} } }),
      });
      assert.equal(reclaimCount, 2);
      assert.equal(dispatchRes.deliveredCount, 2);
      assert.equal(deliveries[0].status, 'delivered');
      assert.equal(deliveries[1].status, 'delivered');
      assert.equal(events[0].status, 'dispatched');
      assert.equal(events[1].status, 'dispatched');

      // 3. Direct syncParentEventStatus(db2) inside db1 context opens db2 RLS context instead of leaking db1 tx
      events[0].status = 'queued';
      await syncParentEventStatus(db2, 'org-b', 'ev-b-1');
      assert.equal(events[0].status, 'dispatched');
    });
  });
});
