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
const crypto = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const REPO_ROOT = resolve(__dirname, '../../../..');

function withMockedNocobase(fn) {
  const origLoad = Module._load;
  class MockMigration {
    constructor(context = {}) { this.context = context; }
  }
  class MockPlugin {
    constructor(app, options = {}) {
      this.app = app;
      this.db = app?.db;
      this.options = options;
    }
  }
  Module._load = function mockedLoad(request, parent, isMain) {
    if (request === '@nocobase/server') {
      return { Migration: MockMigration, Plugin: MockPlugin };
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

function makeInMemoryDataGovDb({ dialect = 'postgres', withPki = true } = {}) {
  const seqs = {
    snapshots: 0,
    lineage: 0,
    quarantine: 0,
    pkiKeys: 0,
    ledger: 0,
    orders: 100,
    telemetry: 100,
  };
  const users = [
    { id: 1, username: 'root-admin', active: true },
    { id: 10, username: 'org-a-admin', active: true },
    { id: 20, username: 'org-a-emp', active: true },
    { id: 21, username: 'org-a-ops', active: true },
    { id: 30, username: 'org-b-admin', active: true },
  ];
  const roles = [
    { name: 'root', allowAll: true, allowConfigure: true, snippets: ['pm', 'pm.*'] },
    { name: 'ldx_admin', allowConfigure: true, snippets: ['pm.*'] },
    { name: 'ldx_employee', allowConfigure: false, snippets: [], strategy: { actions: [] } },
    { name: 'ldx_operator', allowConfigure: false, snippets: [], strategy: { actions: [] } },
  ];
  const rolesUsers = [
    { userId: 1, roleName: 'root' },
    { userId: 10, roleName: 'ldx_admin' },
    { userId: 20, roleName: 'ldx_employee' },
    { userId: 21, roleName: 'ldx_operator' },
    { userId: 30, roleName: 'ldx_admin' },
  ];
  const roleResources = [
    {
      roleName: 'ldx_operator',
      name: 'latticeOrders',
      dataSourceKey: 'main',
      usingActionsConfig: true,
      actions: [{ name: 'view' }, { name: 'create' }],
    },
    {
      roleName: 'ldx_operator',
      name: 'latticeDataQuarantine',
      dataSourceKey: 'main',
      usingActionsConfig: true,
      actions: [{ name: 'view' }, { name: 'update' }],
    },
    {
      roleName: 'ldx_employee',
      name: 'latticeOrders',
      dataSourceKey: 'main',
      usingActionsConfig: true,
      actions: [{ name: 'view' }],
    },
  ];
  const employees = [
    { id: 100, userId: 10, organizationId: 'org-a', departmentId: 1, active: true, code: 'ADM-A', name: 'Admin A' },
    { id: 200, userId: 20, organizationId: 'org-a', departmentId: 1, active: true, code: 'EMP-A', name: 'Emp A' },
    { id: 210, userId: 21, organizationId: 'org-a', departmentId: 1, active: true, code: 'OPS-A', name: 'Ops A' },
    { id: 300, userId: 30, organizationId: 'org-b', departmentId: 2, active: true, code: 'ADM-B', name: 'Admin B' },
  ];

  const orders = [
    {
      id: 1,
      organizationId: 'org-a',
      code: 'ORD-A1',
      name: 'Cold Batch 1',
      status: 'draft',
      secretToken: 'leaked-if-not-stripped',
      passwordHash: 'sha256-sensitive',
      nested: { apiKeySecret: 'top-secret', safeVal: 42 },
    },
    {
      id: 2,
      organizationId: 'org-a',
      code: 'ORD-A2',
      name: 'Cold Batch 2',
      status: 'completed',
      privateKey: 'raw-key',
    },
    {
      id: 3,
      organizationId: 'org-b',
      code: 'ORD-B1',
      name: 'Org B Order',
      status: 'draft',
    },
  ];
  const tickets = [
    { id: 11, organizationId: 'org-a', code: 'TKT-A1', name: 'Open Ticket', status: 'open' },
    { id: 12, organizationId: 'org-a', code: 'TKT-A2', name: 'Closed Ticket', status: 'closed' },
    { id: 13, organizationId: 'org-b', code: 'TKT-B1', name: 'Org B Ticket', status: 'open' },
  ];
  const telemetryPoints = [
    {
      id: 1,
      organizationId: 'org-a',
      assetId: 12,
      assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12',
      metricName: 'temperature',
      numericValue: -20,
      unit: 'CEL',
      quality: 'good',
      observedAt: '2026-11-22T01:00:00.000Z',
    },
    {
      id: 2,
      organizationId: 'org-a',
      assetId: 12,
      assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12',
      metricName: 'temperature',
      numericValue: -20,
      unit: 'CEL',
      quality: 'good',
      observedAt: '2026-11-22T02:00:00.000Z',
    },
    {
      id: 3,
      organizationId: 'org-a',
      assetId: 12,
      assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12',
      metricName: 'temperature',
      numericValue: 0,
      unit: 'CEL',
      quality: 'good',
      observedAt: '2026-11-22T03:00:00.000Z',
    },
    {
      id: 4,
      organizationId: 'org-b',
      assetId: 99,
      assetEntityId: 'urn:ngsi-ld:Asset:org-b:native:99',
      metricName: 'temperature',
      numericValue: 90,
      unit: 'CEL',
      quality: 'good',
      observedAt: '2026-11-22T03:00:00.000Z',
    },
  ];
  const assets = [
    { id: 12, organizationId: 'org-a', code: 'COLD-12', name: 'Freezer 12', active: true },
    { id: 99, organizationId: 'org-b', code: 'COLD-99', name: 'Freezer 99', active: true },
  ];
  const snapshots = [];
  const lineageEdges = [];
  const quarantineRows = [];
  const apiKeys = [];
  const pkiKeys = [];
  const ledgerEntries = [];
  const listeners = new Map();

  const match = (row, filter = {}) => Object.entries(filter || {}).every(([k, cond]) => {
    if (k === '$and' && Array.isArray(cond)) return cond.every((sub) => match(row, sub));
    if (k === '$or' && Array.isArray(cond)) return cond.some((sub) => match(row, sub));
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      if (Array.isArray(cond.$in)) return cond.$in.includes(row[k]);
      if (Object.hasOwn(cond, '$eq')) return row[k] === cond.$eq;
      if (Object.hasOwn(cond, '$ne')) return row[k] !== cond.$ne;
      if (Object.hasOwn(cond, '$gte')) {
        const rv = row[k] instanceof Date ? row[k].getTime() : Date.parse(String(row[k]));
        const cv = cond.$gte instanceof Date ? cond.$gte.getTime() : Date.parse(String(cond.$gte));
        return Number.isFinite(rv) && Number.isFinite(cv) ? rv >= cv : row[k] >= cond.$gte;
      }
      if (Object.hasOwn(cond, '$lte')) {
        const rv = row[k] instanceof Date ? row[k].getTime() : Date.parse(String(row[k]));
        const cv = cond.$lte instanceof Date ? cond.$lte.getTime() : Date.parse(String(cond.$lte));
        return Number.isFinite(rv) && Number.isFinite(cv) ? rv <= cv : row[k] <= cond.$lte;
      }
    }
    return row[k] === cond;
  });

  const sortRows = (rows, sort) => {
    if (!Array.isArray(sort) || !sort.length) return rows;
    const copy = rows.slice();
    copy.sort((a, b) => {
      for (const s of sort) {
        const desc = String(s).startsWith('-');
        const key = desc ? String(s).slice(1) : String(s);
        if (a[key] === b[key]) continue;
        const cmp = a[key] < b[key] ? -1 : 1;
        return desc ? -cmp : cmp;
      }
      return 0;
    });
    return copy;
  };

  const wrap = (row, collectionName) => (row ? {
    ...row,
    toJSON: () => ({ ...row }),
    get: (k) => row[k],
    update: async (patch, opts = {}) => {
      for (const fn of listeners.get(`${collectionName}.beforeUpdate`) || []) {
        await fn(row, { ...opts, attributes: patch });
      }
      Object.assign(row, patch, { updatedAt: new Date().toISOString() });
      return wrap(row, collectionName);
    },
    destroy: async (opts = {}) => {
      for (const fn of listeners.get(`${collectionName}.beforeDestroy`) || []) {
        await fn(row, opts);
      }
      return 1;
    },
  } : null);

  const makeRepo = (collectionName, list, counterKey) => ({
    find: async ({ filter, sort, offset = 0, limit = 100 } = {}) => {
      const filtered = list.filter((r) => match(r, filter));
      return sortRows(filtered, sort).slice(offset, offset + limit).map((r) => wrap(r, collectionName));
    },
    findOne: async ({ filter, filterByTk, sort } = {}) => {
      if (filterByTk != null && !filter) {
        return wrap(list.find((r) => Number(r.id) === Number(filterByTk)), collectionName);
      }
      const filtered = sortRows(list.filter((r) => match(r, filter)), sort);
      return wrap(filtered[0] || null, collectionName);
    },
    count: async ({ filter } = {}) => list.filter((r) => match(r, filter)).length,
    create: async ({ values }) => {
      if (collectionName === 'latticeFrozenSnapshots' && list.some((s) => s.organizationId === values.organizationId && s.snapshotUid === values.snapshotUid)) {
        throw Object.assign(new Error('Unique violation on snapshotUid'), { name: 'SequelizeUniqueConstraintError' });
      }
      if (collectionName === 'latticeDataLineage' && list.some((e) => e.organizationId === values.organizationId && e.edgeUid === values.edgeUid)) {
        throw Object.assign(new Error('Unique violation on edgeUid'), { name: 'SequelizeUniqueConstraintError' });
      }
      if (collectionName === 'latticeDataQuarantine' && list.some((q) => q.organizationId === values.organizationId && q.quarantineUid === values.quarantineUid)) {
        throw Object.assign(new Error('Unique violation on quarantineUid'), { name: 'SequelizeUniqueConstraintError' });
      }
      if (collectionName === 'latticePkiKeys' && list.some((k) => k.organizationId === values.organizationId)) {
        throw Object.assign(new Error('Unique violation on organizationId'), { name: 'SequelizeUniqueConstraintError' });
      }
      if (collectionName === 'latticeCryptoLedger' && list.some((e) => e.organizationId === values.organizationId && Number(e.seq) === Number(values.seq))) {
        throw Object.assign(new Error('Unique violation on seq'), { name: 'SequelizeUniqueConstraintError' });
      }
      const row = {
        id: ++seqs[counterKey],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...values,
      };
      list.push(row);
      return wrap(row, collectionName);
    },
    update: async ({ filterByTk, filter, values, ...rest } = {}) => {
      for (const fn of listeners.get(`${collectionName}.beforeBulkUpdate`) || []) {
        await fn({ ...rest, where: filter, attributes: values });
      }
      const targets = list.filter((r) => (filterByTk != null ? Number(r.id) === Number(filterByTk) : true) && (!filter || match(r, filter)));
      for (const t of targets) {
        for (const fn of listeners.get(`${collectionName}.beforeUpdate`) || []) {
          await fn(t, { ...rest, attributes: values });
        }
        Object.assign(t, values, { updatedAt: new Date().toISOString() });
      }
      return targets.map((t) => wrap(t, collectionName));
    },
    destroy: async ({ filter, ...rest } = {}) => {
      for (const fn of listeners.get(`${collectionName}.beforeBulkDestroy`) || []) {
        await fn({ ...rest, where: filter });
      }
      let removed = 0;
      for (let i = list.length - 1; i >= 0; i -= 1) {
        if (!filter || match(list[i], filter)) {
          for (const fn of listeners.get(`${collectionName}.beforeDestroy`) || []) {
            await fn(list[i], rest);
          }
          list.splice(i, 1);
          removed += 1;
        }
      }
      return removed;
    },
  });

  const fakeTx = { id: 'tx-gov', LOCK: { UPDATE: 'UPDATE' } };
  const db = {
    on(eventName, fn) {
      if (!listeners.has(eventName)) listeners.set(eventName, []);
      listeners.get(eventName).push(fn);
    },
    emit: async (eventName, ...args) => {
      for (const fn of listeners.get(eventName) || []) {
        await fn(...args);
      }
    },
    sequelize: {
      getDialect: () => dialect,
      transaction: async (cb) => cb(fakeTx),
      query: async () => [[]],
    },
    getRepository(name) {
      if (name === 'users') return makeRepo('users', users, 'orders');
      if (name === 'roles') return makeRepo('roles', roles, 'orders');
      if (name === 'rolesUsers') return makeRepo('rolesUsers', rolesUsers, 'orders');
      if (name === 'dataSourcesRolesResources') return makeRepo('dataSourcesRolesResources', roleResources, 'orders');
      if (name === 'latticeEmployees') return makeRepo('latticeEmployees', employees, 'orders');
      if (name === 'latticeOrders') return makeRepo('latticeOrders', orders, 'orders');
      if (name === 'latticeServiceTickets') return makeRepo('latticeServiceTickets', tickets, 'orders');
      if (name === 'latticeAssets') return makeRepo('latticeAssets', assets, 'orders');
      if (name === 'latticeTelemetryPoints') return makeRepo('latticeTelemetryPoints', telemetryPoints, 'telemetry');
      if (name === 'latticeFrozenSnapshots') return makeRepo('latticeFrozenSnapshots', snapshots, 'snapshots');
      if (name === 'latticeDataLineage') return makeRepo('latticeDataLineage', lineageEdges, 'lineage');
      if (name === 'latticeDataQuarantine') return makeRepo('latticeDataQuarantine', quarantineRows, 'quarantine');
      if (name === 'latticeApiKeys') return makeRepo('latticeApiKeys', apiKeys, 'orders');
      if (name === 'latticePkiKeys') return withPki ? makeRepo('latticePkiKeys', pkiKeys, 'pkiKeys') : null;
      if (name === 'latticeCryptoLedger') return withPki ? makeRepo('latticeCryptoLedger', ledgerEntries, 'ledger') : null;
      return null;
    },
  };

  return { db, orders, tickets, telemetryPoints, snapshots, lineageEdges, quarantineRows, pkiKeys, ledgerEntries };
}

function makeHttpCtx({ method = 'GET', state = {}, headers = {}, params = {}, query = {}, body = undefined } = {}) {
  const resHeaders = {};
  return {
    method,
    headers: { ...headers },
    request: { headers: { ...headers }, ...(body !== undefined ? { body } : {}) },
    response: { headers: resHeaders },
    query,
    state: { ...state },
    action: { resourceName: params.resourceName || 'dxosDataGov', actionName: params.actionName || '', params },
    get(k) { return this.headers[String(k).toLowerCase()] || ''; },
    set(k, v) { this.response.headers[k] = v; },
    throw(status, message, props) { throw Object.assign(new Error(message || `HTTP ${status}`), { status }, props || {}); },
  };
}

test('Task 2.1 collections, migration 20261124000200, and 34-table pg-rls define clean schema, named indexes, and reversible RLS DDL', async () => {
  await withMockedNocobase(async () => {
    const frozenCol = require('../src/server/collections/frozen-snapshots');
    const lineageCol = require('../src/server/collections/data-lineage');
    const quarantineCol = require('../src/server/collections/data-quarantine');

    assert.equal(frozenCol.name, 'latticeFrozenSnapshots');
    assert.deepEqual(frozenCol.migrationRules, ['schema-only']);
    assert.ok(frozenCol.fields.some((f) => f.name === 'snapshotUid' && f.allowNull === false));
    assert.ok(frozenCol.fields.some((f) => f.name === 'payloadJson' && f.type === 'jsonb' && f.allowNull === false));
    assert.ok(frozenCol.indexes.some((i) => i.name === 'uidx_lattice_frozen_org_uid' && i.unique === true));
    assert.ok(frozenCol.indexes.some((i) => i.name === 'idx_lattice_frozen_org_col_tier'));

    assert.equal(lineageCol.name, 'latticeDataLineage');
    assert.deepEqual(lineageCol.migrationRules, ['schema-only']);
    assert.ok(lineageCol.fields.some((f) => f.name === 'edgeUid' && f.allowNull === false));
    assert.ok(lineageCol.indexes.some((i) => i.name === 'uidx_lattice_lineage_org_edge' && i.unique === true));
    assert.ok(lineageCol.indexes.some((i) => i.name === 'idx_lattice_lineage_org_source'));
    assert.ok(lineageCol.indexes.some((i) => i.name === 'idx_lattice_lineage_org_target'));

    assert.equal(quarantineCol.name, 'latticeDataQuarantine');
    assert.deepEqual(quarantineCol.migrationRules, ['schema-only']);
    assert.ok(quarantineCol.fields.some((f) => f.name === 'quarantineUid' && f.allowNull === false));
    assert.ok(quarantineCol.fields.some((f) => f.name === 'rawPayload' && f.type === 'jsonb' && f.allowNull === false));
    assert.ok(quarantineCol.indexes.some((i) => i.name === 'uidx_lattice_quarantine_org_uid' && i.unique === true));
    assert.ok(quarantineCol.indexes.some((i) => i.name === 'idx_lattice_quarantine_org_status'));

    const pgRls = require('../src/server/pg-rls');
    assert.equal(pgRls.TENANT_RLS_TABLES.length, 34);
    for (const tbl of [
      'latticeFrozenSnapshots', 'latticeDataLineage', 'latticeDataQuarantine',
      'latticeOrderLines', 'latticeStockLots', 'latticeEpodRecords',
      'latticeDecisionTables', 'latticeDelegations', 'latticeTwinShadows',
    ]) {
      assert.ok(pgRls.TENANT_RLS_TABLES.includes(tbl), `Missing Wave 2 RLS table ${tbl}`);
    }

    const Migration = require('../src/server/migrations/20261124000200-data-governance-lineage-quarantine');
    const sqlCalls = [];
    const rlsAttached = [];
    const fakeTx = { id: 'tx-20261124-02' };
    const fakeDb = {
      sequelize: {
        getDialect: () => 'postgres',
        transaction: async (cb) => cb(fakeTx),
        query: async (sql, opts) => {
          sqlCalls.push({ sql, opts });
          return [[]];
        },
      },
      attachLatticeRlsPolicy: async (tableName, opts) => {
        rlsAttached.push({ tableName, opts });
      },
    };

    const migration = new Migration({ db: fakeDb });
    assert.equal(migration.on, 'afterSync');
    await migration.up();

    const upSql = sqlCalls.map((x) => x.sql).join('\n');
    assert.match(upSql, /CREATE TABLE IF NOT EXISTS "latticeFrozenSnapshots"/);
    assert.match(upSql, /CREATE TABLE IF NOT EXISTS "latticeDataLineage"/);
    assert.match(upSql, /CREATE TABLE IF NOT EXISTS "latticeDataQuarantine"/);
    assert.match(upSql, /CREATE UNIQUE INDEX IF NOT EXISTS uidx_lattice_frozen_org_uid/);
    assert.match(upSql, /CREATE UNIQUE INDEX IF NOT EXISTS uidx_lattice_lineage_org_edge/);
    assert.match(upSql, /CREATE UNIQUE INDEX IF NOT EXISTS uidx_lattice_quarantine_org_uid/);
    assert.equal(/\bUNIQUE\b/i.test(upSql.replace(/CREATE UNIQUE INDEX/gi, '')), false, 'Must NOT emit inline UNIQUE column constraint alongside CREATE UNIQUE INDEX');
    assert.deepEqual(rlsAttached.map((r) => r.tableName), ['latticeFrozenSnapshots', 'latticeDataLineage', 'latticeDataQuarantine']);
    assert.equal(rlsAttached.every((r) => r.opts?.transaction === fakeTx), true);

    sqlCalls.length = 0;
    await migration.down();
    const downSql = sqlCalls.map((x) => x.sql).join('\n');
    assert.match(downSql, /DROP POLICY IF EXISTS lattice_tenant_isolation ON public\."latticeDataQuarantine"/);
    assert.match(downSql, /DROP TABLE IF EXISTS "latticeDataQuarantine"/);
    assert.match(downSql, /DROP TABLE IF EXISTS "latticeDataLineage"/);
    assert.match(downSql, /DROP TABLE IF EXISTS "latticeFrozenSnapshots"/);
  });
});

test('computeMeanKineticTemperature implements ICH/USP Arrhenius formula with log-sum-exp numerical stability and guards', () => {
  const { computeMeanKineticTemperature } = require('../src/server/data-governance');

  // 1. Constant series matches exact value without floating-point false threshold breach
  const constant = computeMeanKineticTemperature([8, 8, 8], { maxAllowedC: 8 });
  assert.equal(constant.mktCelsius, 8);
  assert.equal(constant.minTempCelsius, 8);
  assert.equal(constant.maxTempCelsius, 8);
  assert.equal(constant.avgTempCelsius, 8);
  assert.equal(constant.sampleCount, 3);
  assert.equal(constant.excursionCount, 0);
  assert.equal(constant.thresholdCelsius, 8);
  assert.equal(constant.breached, false);

  // 2. Cold chain spike weights exponentially higher than arithmetic mean
  const excursion = computeMeanKineticTemperature([-20, -20, 0], { maxAllowedC: -15 });
  assert.equal(excursion.avgTempCelsius, -13.333);
  assert.ok(excursion.mktCelsius > excursion.avgTempCelsius);
  assert.equal(excursion.excursionCount, 1);
  assert.equal(excursion.breached, true);
  // Hand-verified ICH/USP Arrhenius (a = 10000 K): -7.216 °C
  assert.equal(excursion.mktCelsius, -7.216);

  // 3. Cryogenic underflow stability check (-250 °C causes exp(-10000/23.15) == 0 without log-sum-exp shift!)
  const cryo = computeMeanKineticTemperature([-250, -250, -80], { maxAllowedC: -100 });
  assert.equal(Number.isFinite(cryo.mktCelsius), true);
  assert.ok(cryo.mktCelsius > -250 && cryo.mktCelsius < -80);

  // 4. Invalid inputs fail closed 400 MKT_INVALID_SAMPLE
  for (const bad of [[], null, 'not-array', [NaN], [Infinity], [-273.15], [-300], [true], [{}], ['']]) {
    assert.throws(
      () => computeMeanKineticTemperature(bad),
      (err) => err.status === 400 && err.code === 'MKT_INVALID_SAMPLE',
    );
  }
});

test('recordLineageEdge & captureQuarantineRecord handle idempotent lineage, quarantine creation, and security invariant propagation', async () => {
  const { recordLineageEdge, captureQuarantineRecord } = require('../src/server/data-governance');
  const { ensureOrgSigningKey } = require('../src/server/pki-ledger');
  const { db, lineageEdges, quarantineRows, ledgerEntries, pkiKeys } = makeInMemoryDataGovDb({ withPki: true });

  // 1. Missing lineage repo skips gracefully
  const skipped = await recordLineageEdge(
    { getRepository: () => null },
    {
      organizationId: 'org-a',
      sourceCollection: 'latticeStockLots',
      sourceRecordId: '1',
      targetCollection: 'latticeOrders',
      targetRecordId: '2',
      relationType: 'allocated_to',
    },
  );
  assert.equal(skipped, null);

  // 2. Deterministic edgeUid & idempotent upsert + prototype pollution stripping
  const pollutedMeta = JSON.parse('{"note":"batch","__proto__":{"polluted":true},"constructor":{"bad":1}}');
  const e1 = await recordLineageEdge(db, {
    organizationId: 'org-a',
    sourceCollection: 'latticeStockLots',
    sourceRecordId: 10,
    targetCollection: 'latticeOrders',
    targetRecordId: 1,
    relationType: 'allocated_to',
    actorName: 'ops-a',
    metadataJson: pollutedMeta,
  });
  const e2 = await recordLineageEdge(db, {
    organizationId: 'org-a',
    sourceCollection: 'latticeStockLots',
    sourceRecordId: '10',
    targetCollection: 'latticeOrders',
    targetRecordId: '1',
    relationType: 'allocated_to',
    actorName: 'ops-a',
  });
  assert.equal(e1.edgeUid, e2.edgeUid);
  assert.equal(lineageEdges.length, 1);
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.hasOwn(e1.metadataJson, '__proto__'), false);
  assert.equal(Object.hasOwn(e1.metadataJson, 'constructor'), false);

  // 3. captureQuarantineRecord creates row and appends data.quarantined ledger entry
  const q1 = await captureQuarantineRecord(db, {
    organizationId: 'org-a',
    sourceSystem: 'iiot',
    assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12',
    metricName: 'temperature',
    numericValue: 999,
    unit: 'CEL',
    reasonCode: 'SENSOR_OUT_OF_PHYSICAL_RANGE',
    severity: 'high',
    rawPayload: { numericValue: 999 },
  });
  assert.equal(quarantineRows.length, 1);
  assert.equal(q1.status, 'quarantined');
  assert.equal(ledgerEntries.length, 1);
  assert.equal(ledgerEntries[0].eventType, 'data.quarantined');

  // 4. Security invariant PKI_KEY_INACTIVE MUST propagate (not be swallowed by bare catch)
  await ensureOrgSigningKey(db, 'org-a');
  pkiKeys[0].active = false;
  await assert.rejects(
    () => captureQuarantineRecord(db, {
      organizationId: 'org-a',
      sourceSystem: 'iiot',
      reasonCode: 'BAD_TELEMETRY_QUALITY',
      rawPayload: { quality: 'bad' },
    }),
    (err) => err.code === 'PKI_KEY_INACTIVE',
  );
  pkiKeys[0].active = true;
});

test('dxosDataGov enforces RBAC, org isolation, snapshot freeze/verify/immutability, lineage BFS, quarantine resolve, and MKT queries', async () => {
  const { registerDataGovernance } = require('../src/server/data-governance');
  const { registerPaasApiKeys, createPaasApiKeyAuthMiddleware } = require('../src/server/paas-api-keys');
  const { db, orders, snapshots, quarantineRows, telemetryPoints, ledgerEntries, lineageEdges } = makeInMemoryDataGovDb({ withPki: true });

  const resources = new Map();
  const middlewares = [];
  const aclAllows = [];
  const app = {
    db,
    resourceManager: {
      define(def) { resources.set(def.name, def.actions); },
      use(fn, opts) { middlewares.push({ fn, opts }); },
    },
    acl: { allow(...args) { aclAllows.push(args); } },
  };
  registerPaasApiKeys(app);
  registerDataGovernance(app);

  const gov = resources.get('dxosDataGov');
  const keyActions = resources.get('dxosApiKeys');
  const authMw = createPaasApiKeyAuthMiddleware(db);
  assert.ok(gov?.tierSummary && gov?.freezeSnapshot && gov?.listSnapshots && gov?.getSnapshot);
  assert.ok(gov?.lineageTrace && gov?.quarantineList && gov?.quarantineResolve && gov?.computeMkt);
  assert.ok(aclAllows.some(([res, acts, role]) => res === 'dxosDataGov' && acts.includes('freezeSnapshot') && role === 'loggedIn'));

  // 1. Unauthenticated -> 401; root without organizationId -> 400; cross-org -> 403; X-Role: root spoof -> 403
  await assert.rejects(() => gov.tierSummary(makeHttpCtx({ method: 'GET' }), async () => {}), (err) => err.status === 401);
  await assert.rejects(
    () => gov.tierSummary(makeHttpCtx({ method: 'GET', state: { currentUser: { id: 1 }, currentRole: 'root' } }), async () => {}),
    (err) => err.status === 400,
  );
  await assert.rejects(
    () => gov.tierSummary(makeHttpCtx({
      method: 'GET',
      state: { currentUser: { id: 10 }, currentRole: 'ldx_admin' },
      params: { organizationId: 'org-b' },
    }), async () => {}),
    (err) => err.status === 403 && err.code === 'NATIVE_ORGANIZATION_MISMATCH',
  );
  await assert.rejects(
    () => gov.freezeSnapshot(makeHttpCtx({
      method: 'POST',
      state: { currentUser: { id: 20 }, currentRole: 'root' },
      params: { values: { organizationId: 'org-a', sourceCollection: 'latticeOrders' } },
    }), async () => {}),
    (err) => err.status === 403,
  );

  // 2. Plain employee (without admin or create ACL) denied freezeSnapshot 403; disallowed sourceCollection denied 403
  await assert.rejects(
    () => gov.freezeSnapshot(makeHttpCtx({
      method: 'POST',
      state: { currentUser: { id: 20, username: 'org-a-emp' }, currentRole: 'ldx_employee' },
      params: { values: { sourceCollection: 'latticeOrders' } },
    }), async () => {}),
    (err) => err.status === 403,
  );
  await assert.rejects(
    () => gov.freezeSnapshot(makeHttpCtx({
      method: 'POST',
      state: { currentUser: { id: 10, username: 'org-a-admin' }, currentRole: 'ldx_admin' },
      params: { values: { sourceCollection: 'users' } },
    }), async () => {}),
    (err) => err.status === 403,
  );

  // 3. Read-only PAT denied freezeSnapshot & quarantineResolve 403
  const roPatCtx = makeHttpCtx({
    method: 'POST',
    state: { currentUser: { id: 10, username: 'org-a-admin' }, currentRole: 'ldx_admin' },
    params: { values: { name: 'Gov RO', roleName: 'ldx_admin', scopes: ['read'] } },
  });
  await keyActions.issue(roPatCtx, async () => {});
  const roToken = roPatCtx.body.token;

  const roFreezeCtx = makeHttpCtx({
    method: 'POST',
    headers: { 'x-lattice-api-key': roToken },
    params: { resourceName: 'dxosDataGov', actionName: 'freezeSnapshot', values: { sourceCollection: 'latticeOrders' } },
  });
  await assert.rejects(
    () => authMw(roFreezeCtx, async () => gov.freezeSnapshot(roFreezeCtx, async () => {})),
    (err) => err.status === 403 && err.code === 'API_KEY_SCOPE_INSUFFICIENT',
  );

  // 4. Operator with explicit latticeOrders:create privilege CAN freeze snapshot; sensitive fields & __proto__ stripped!
  orders[0].__proto__ = Object.prototype;
  Object.defineProperty(orders[0], 'rawLeak', { value: { __proto__: { polluted: true }, secretField: 'nope' }, enumerable: true });
  const freezeCtx = makeHttpCtx({
    method: 'POST',
    state: { currentUser: { id: 21, username: 'org-a-ops' }, currentRole: 'ldx_operator' },
    params: { values: { sourceCollection: 'latticeOrders', filter: { status: 'completed' }, retentionDays: 3650 } },
  });
  await gov.freezeSnapshot(freezeCtx, async () => {});
  assert.equal(freezeCtx.body.tier, 'cold');
  assert.equal(freezeCtx.body.status, 'sealed');
  assert.equal(freezeCtx.body.recordCount, 1);
  assert.equal(freezeCtx.body.organizationId, 'org-a');
  assert.ok(freezeCtx.body.payloadHash);
  assert.ok(freezeCtx.body.signatureBase64);
  assert.ok(freezeCtx.body.keyId);
  assert.ok(Number(freezeCtx.body.ledgerEntrySeq) >= 1);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].payloadJson[0].privateKey, undefined);
  assert.equal(snapshots[0].payloadJson[0].code, 'ORD-A2');

  // Freeze all org-a orders to verify nested sensitive key stripping
  const freezeAllCtx = makeHttpCtx({
    method: 'POST',
    state: { currentUser: { id: 10, username: 'org-a-admin' }, currentRole: 'ldx_admin' },
    params: { values: { sourceCollection: 'latticeOrders' } },
  });
  await gov.freezeSnapshot(freezeAllCtx, async () => {});
  const dumpedAll = JSON.stringify(snapshots[1].payloadJson);
  assert.equal(dumpedAll.includes('leaked-if-not-stripped'), false);
  assert.equal(dumpedAll.includes('sha256-sensitive'), false);
  assert.equal(dumpedAll.includes('top-secret'), false);
  assert.equal(snapshots[1].payloadJson.length, 2); // never includes org-b ORD-B1!
  assert.equal(snapshots[1].payloadJson[0].nested.safeVal, 42);
  assert.equal(lineageEdges.some((e) => e.relationType === 'frozen_into' && e.targetRecordId === freezeAllCtx.body.snapshotUid), true);

  // 5. listSnapshots & getSnapshot verify hash integrity and reject cross-org access
  const listSnapCtx = makeHttpCtx({
    method: 'GET',
    state: { currentUser: { id: 10 }, currentRole: 'ldx_admin' },
  });
  await gov.listSnapshots(listSnapCtx, async () => {});
  assert.equal(listSnapCtx.body.items.length, 2);

  const getSnapCtx = makeHttpCtx({
    method: 'GET',
    state: { currentUser: { id: 10 }, currentRole: 'ldx_admin' },
    params: { snapshotUid: freezeCtx.body.snapshotUid },
  });
  await gov.getSnapshot(getSnapCtx, async () => {});
  assert.equal(getSnapCtx.body.hashVerified, true);
  assert.equal(getSnapCtx.body.signatureVerified, true);

  // Cross-org getSnapshot -> 404
  await assert.rejects(
    () => gov.getSnapshot(makeHttpCtx({
      method: 'GET',
      state: { currentUser: { id: 30 }, currentRole: 'ldx_admin' },
      params: { snapshotUid: freezeCtx.body.snapshotUid },
    }), async () => {}),
    (err) => err.status === 404,
  );

  // Tamper stored snapshot -> hashVerified becomes false
  const origCode = snapshots[0].payloadJson[0].code;
  snapshots[0].payloadJson[0].code = 'TAMPERED';
  await gov.getSnapshot(getSnapCtx, async () => {});
  assert.equal(getSnapCtx.body.hashVerified, false);
  snapshots[0].payloadJson[0].code = origCode;

  // 6. Immutability hooks & direct REST guard block tampering with 403 COLD_SNAPSHOT_IMMUTABLE
  for (const hook of ['beforeUpdate', 'beforeDestroy', 'beforeBulkUpdate', 'beforeBulkDestroy']) {
    await assert.rejects(
      () => db.emit(`latticeFrozenSnapshots.${hook}`, snapshots[0], {}),
      (err) => err.status === 403 && err.code === 'COLD_SNAPSHOT_IMMUTABLE',
    );
  }
  const directGuard = middlewares.find((m) => m.opts?.tag === 'latticeDataGovDirectGuard')?.fn;
  assert.ok(directGuard);
  await assert.rejects(
    () => directGuard(makeHttpCtx({
      method: 'POST',
      state: { currentRole: 'ldx_admin' },
      params: { resourceName: 'latticeFrozenSnapshots', actionName: 'update' },
    }), async () => {}),
    (err) => err.status === 403 && err.code === 'COLD_SNAPSHOT_IMMUTABLE',
  );

  // 7. lineageTrace traverses both outbound & inbound, respects maxDepth 1..5 & org isolation
  const { recordLineageEdge } = require('../src/server/data-governance');
  await recordLineageEdge(db, {
    organizationId: 'org-a',
    sourceCollection: 'latticeStockLots',
    sourceRecordId: 'LOT-1',
    targetCollection: 'latticeOrders',
    targetRecordId: '2',
    relationType: 'allocated_to',
  });
  await recordLineageEdge(db, {
    organizationId: 'org-b',
    sourceCollection: 'latticeOrders',
    sourceRecordId: '2',
    targetCollection: 'latticeFrozenSnapshots',
    targetRecordId: 'LEAK',
    relationType: 'frozen_into',
  });

  const traceCtx = makeHttpCtx({
    method: 'GET',
    state: { currentUser: { id: 10 }, currentRole: 'ldx_admin' },
    params: { collection: 'latticeOrders', recordId: '2', maxDepth: 2 },
  });
  await gov.lineageTrace(traceCtx, async () => {});
  assert.equal(traceCtx.body.nodes.some((n) => n.collection === 'latticeStockLots' && n.recordId === 'LOT-1'), true);
  assert.equal(traceCtx.body.nodes.some((n) => n.collection === 'latticeFrozenSnapshots' && n.recordId === freezeCtx.body.snapshotUid), true);
  assert.equal(traceCtx.body.nodes.some((n) => n.recordId === 'LEAK'), false);

  // 8. Quarantine list & resolve (employee denied, operator allowed, release to telemetry creates clean point & ledger entry)
  const { captureQuarantineRecord } = require('../src/server/data-governance');
  const qRec = await captureQuarantineRecord(db, {
    organizationId: 'org-a',
    sourceSystem: 'iiot',
    assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12',
    metricName: 'temperature',
    numericValue: 999,
    unit: 'CEL',
    reasonCode: 'SENSOR_OUT_OF_PHYSICAL_RANGE',
    severity: 'high',
    rawPayload: { numericValue: 999 },
  });
  const qRec2 = await captureQuarantineRecord(db, {
    organizationId: 'org-a',
    sourceSystem: 'iiot',
    assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12',
    metricName: 'temperature',
    numericValue: -18,
    unit: 'CEL',
    reasonCode: 'BAD_TELEMETRY_QUALITY',
    severity: 'medium',
    rawPayload: { numericValue: -18, quality: 'bad' },
  });

  await assert.rejects(
    () => gov.quarantineResolve(makeHttpCtx({
      method: 'POST',
      state: { currentUser: { id: 20 }, currentRole: 'ldx_employee' },
      params: { values: { quarantineUid: qRec.quarantineUid, status: 'rejected' } },
    }), async () => {}),
    (err) => err.status === 403,
  );

  // Trying to release 999 °C straight into telemetry fails 400 without mutating status!
  await assert.rejects(
    () => gov.quarantineResolve(makeHttpCtx({
      method: 'POST',
      state: { currentUser: { id: 21, username: 'org-a-ops' }, currentRole: 'ldx_operator' },
      params: { values: { quarantineUid: qRec.quarantineUid, status: 'approved_release', releaseToTelemetry: true } },
    }), async () => {}),
    (err) => err.status === 400 && err.code === 'QUARANTINE_RELEASE_VALUE_INVALID',
  );
  assert.equal(quarantineRows.find((q) => q.quarantineUid === qRec.quarantineUid).status, 'quarantined');

  const rejectCtx = makeHttpCtx({
    method: 'POST',
    state: { currentUser: { id: 21, username: 'org-a-ops' }, currentRole: 'ldx_operator' },
    params: { values: { quarantineUid: qRec.quarantineUid, status: 'rejected', resolutionNote: 'Disconnected probe' } },
  });
  await gov.quarantineResolve(rejectCtx, async () => {});
  assert.equal(rejectCtx.body.quarantine.status, 'rejected');
  assert.equal(rejectCtx.body.releasedPoint, null);

  // Double-resolve -> 409
  await assert.rejects(
    () => gov.quarantineResolve(rejectCtx, async () => {}),
    (err) => err.status === 409 && err.code === 'QUARANTINE_ALREADY_RESOLVED',
  );

  const approveCtx = makeHttpCtx({
    method: 'POST',
    state: { currentUser: { id: 21, username: 'org-a-ops' }, currentRole: 'ldx_operator' },
    params: { values: { quarantineUid: qRec2.quarantineUid, status: 'approved_release', releaseToTelemetry: true, resolutionNote: 'Calibrated OK' } },
  });
  const beforePts = telemetryPoints.length;
  await gov.quarantineResolve(approveCtx, async () => {});
  assert.equal(approveCtx.body.quarantine.status, 'approved_release');
  assert.equal(telemetryPoints.length, beforePts + 1);
  assert.equal(telemetryPoints.at(-1).numericValue, -18);
  assert.equal(telemetryPoints.at(-1).quality, 'good');
  assert.equal(ledgerEntries.some((e) => e.eventType === 'data.quarantine_resolved'), true);

  // 9. tierSummary & computeMkt via telemetry query
  const summaryCtx = makeHttpCtx({
    method: 'GET',
    state: { currentUser: { id: 10 }, currentRole: 'ldx_admin' },
  });
  await gov.tierSummary(summaryCtx, async () => {});
  assert.equal(summaryCtx.body.hotOrders, 1);
  assert.equal(summaryCtx.body.warmOrders, 1);
  assert.equal(summaryCtx.body.hotTickets, 1);
  assert.equal(summaryCtx.body.coldSnapshots, 2);
  assert.equal(summaryCtx.body.coldTotalRecords, 3);
  assert.equal(summaryCtx.body.quarantineOpen, 0);
  assert.equal(summaryCtx.body.quarantineResolved, 2);

  const mktCtx = makeHttpCtx({
    method: 'GET',
    state: { currentUser: { id: 10 }, currentRole: 'ldx_admin' },
    params: {
      assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12',
      metricName: 'temperature',
      maxAllowedC: -15,
    },
  });
  await gov.computeMkt(mktCtx, async () => {});
  assert.equal(mktCtx.body.sampleCount, 4);
  assert.equal(mktCtx.body.breached, true);

  // Cross-org URN on computeMkt -> 403
  await assert.rejects(
    () => gov.computeMkt(makeHttpCtx({
      method: 'GET',
      state: { currentUser: { id: 10 }, currentRole: 'ldx_admin' },
      params: { assetEntityId: 'urn:ngsi-ld:Asset:org-b:native:99' },
    }), async () => {}),
    (err) => err.status === 403,
  );

  // Read-only PAT allowed on GET actions & blocked on POST mutations; write PAT allowed on POST mutations
  const roSummaryCtx = makeHttpCtx({
    method: 'GET',
    headers: { 'x-lattice-api-key': roToken },
    params: { resourceName: 'dxosDataGov', actionName: 'tierSummary' },
  });
  await authMw(roSummaryCtx, async () => gov.tierSummary(roSummaryCtx, async () => {}));
  assert.equal(roSummaryCtx.body.organizationId, 'org-a');

  const writePatCtx = makeHttpCtx({
    method: 'POST',
    state: { currentUser: { id: 10, username: 'org-a-admin' }, currentRole: 'ldx_admin' },
    params: { values: { name: 'Gov RW', roleName: 'ldx_admin', scopes: ['read', 'write'] } },
  });
  await keyActions.issue(writePatCtx, async () => {});
  const rwFreezeCtx = makeHttpCtx({
    method: 'POST',
    headers: { 'x-lattice-api-key': writePatCtx.body.token },
    params: { resourceName: 'dxosDataGov', actionName: 'freezeSnapshot', values: { sourceCollection: 'latticeServiceTickets' } },
  });
  await authMw(rwFreezeCtx, async () => gov.freezeSnapshot(rwFreezeCtx, async () => {}));
  assert.equal(rwFreezeCtx.body.recordCount, 2);

  // Alias routes from OpenAPI spec (`lineage`, `listQuarantine`, `resolveQuarantine`) work identically
  const aliasListQ = makeHttpCtx({ method: 'GET', state: { currentUser: { id: 10 }, currentRole: 'ldx_admin' } });
  await gov.listQuarantine(aliasListQ, async () => {});
  assert.equal(aliasListQ.body.items.length, 2);
});

test('Task 2.1 Round 1 regression guards: bulk hooks, tx atomicity, CSV MKT, lineage truncation, filter/retention, PAT & ctx.can ACL', async () => {
  const { registerDataGovernance, captureQuarantineRecord, recordLineageEdge } = require('../src/server/data-governance');
  const { registerPaasApiKeys, createPaasApiKeyAuthMiddleware } = require('../src/server/paas-api-keys');
  const { db, snapshots, quarantineRows, telemetryPoints, ledgerEntries, pkiKeys } = makeInMemoryDataGovDb({ withPki: true });

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
  registerDataGovernance(app);
  const gov = resources.get('dxosDataGov');
  const keyActions = resources.get('dxosApiKeys');
  const authMw = createPaasApiKeyAuthMiddleware(db);

  // 1. Minor 1: guardImmutable handles both instance hooks (instance, options) and bulk hooks (options as 1st arg)
  const freezeSetupCtx = makeHttpCtx({
    method: 'POST',
    state: { currentUser: { id: 10, username: 'org-a-admin' }, currentRole: 'ldx_admin' },
    params: { values: { sourceCollection: 'latticeOrders' } },
  });
  await gov.freezeSnapshot(freezeSetupCtx, async () => {});
  assert.equal(snapshots.length, 1);

  for (const hook of ['beforeBulkUpdate', 'beforeBulkDestroy']) {
    await assert.rejects(
      () => db.emit(`latticeFrozenSnapshots.${hook}`, { where: { id: snapshots[0].id } }),
      (err) => err.status === 403 && err.code === 'COLD_SNAPSHOT_IMMUTABLE',
    );
    await db.emit(`latticeFrozenSnapshots.${hook}`, { allowSystemMigration: true });
    await db.emit(`latticeFrozenSnapshots.${hook}`, { context: { state: { currentRole: 'root' } } });
  }
  for (const hook of ['beforeUpdate', 'beforeDestroy']) {
    await assert.rejects(
      () => db.emit(`latticeFrozenSnapshots.${hook}`, snapshots[0], {}),
      (err) => err.status === 403 && err.code === 'COLD_SNAPSHOT_IMMUTABLE',
    );
    await db.emit(`latticeFrozenSnapshots.${hook}`, snapshots[0], { allowSystemMigration: true });
    await db.emit(`latticeFrozenSnapshots.${hook}`, snapshots[0], { context: { state: { currentRole: 'root' } } });
  }
  await assert.rejects(
    () => db.getRepository('latticeFrozenSnapshots').update({ filter: { id: snapshots[0].id }, values: { status: 'tampered' } }),
    (err) => err.status === 403 && err.code === 'COLD_SNAPSHOT_IMMUTABLE',
  );
  await db.getRepository('latticeFrozenSnapshots').update({
    filter: { id: snapshots[0].id },
    values: { coldStorageUri: 's3://bucket/migrated' },
    allowSystemMigration: true,
  });
  assert.equal(snapshots[0].coldStorageUri, 's3://bucket/migrated');

  // 2. Minor 2: freezeSnapshot & quarantineResolve wrap multi-step writes in db.sequelize.transaction
  let txCount = 0;
  const origTx = db.sequelize.transaction;
  db.sequelize.transaction = async (cb) => {
    txCount += 1;
    const snapBackup = snapshots.map((s) => ({ ...s }));
    const ledgerBackup = ledgerEntries.map((l) => ({ ...l }));
    const qBackup = quarantineRows.map((q) => ({ ...q }));
    const tsBackup = telemetryPoints.map((t) => ({ ...t }));
    try {
      return await origTx(cb);
    } catch (err) {
      snapshots.splice(0, snapshots.length, ...snapBackup);
      ledgerEntries.splice(0, ledgerEntries.length, ...ledgerBackup);
      quarantineRows.splice(0, quarantineRows.length, ...qBackup);
      telemetryPoints.splice(0, telemetryPoints.length, ...tsBackup);
      throw err;
    }
  };

  const qTxRec = await captureQuarantineRecord(db, {
    organizationId: 'org-a',
    sourceSystem: 'iiot',
    assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12',
    metricName: 'temperature',
    numericValue: -19,
    unit: 'CEL',
    reasonCode: 'BAD_TELEMETRY_QUALITY',
    severity: 'medium',
    rawPayload: { numericValue: -19, quality: 'bad' },
  });
  const beforeTx = txCount;
  const beforeLedgerLen = ledgerEntries.length;
  const beforePtsLen = telemetryPoints.length;
  pkiKeys[0].active = false;
  await assert.rejects(
    () => gov.quarantineResolve(makeHttpCtx({
      method: 'POST',
      state: { currentUser: { id: 21, username: 'org-a-ops' }, currentRole: 'ldx_operator' },
      params: { values: { quarantineUid: qTxRec.quarantineUid, status: 'approved_release', releaseToTelemetry: true } },
    }), async () => {}),
    (err) => err.code === 'PKI_KEY_INACTIVE',
  );
  assert.equal(txCount, beforeTx + 1);
  assert.equal(telemetryPoints.length, beforePtsLen);
  assert.equal(ledgerEntries.length, beforeLedgerLen);
  assert.equal(quarantineRows.find((q) => q.quarantineUid === qTxRec.quarantineUid).status, 'quarantined');
  pkiKeys[0].active = true;

  const origGetRepo = db.getRepository.bind(db);
  db.getRepository = (name) => {
    const repo = origGetRepo(name);
    if (name !== 'latticeFrozenSnapshots') return repo;
    return {
      ...repo,
      create: async () => { throw new Error('Simulated snapshot insert failure'); },
    };
  };
  await assert.rejects(
    () => gov.freezeSnapshot(makeHttpCtx({
      method: 'POST',
      state: { currentUser: { id: 10, username: 'org-a-admin' }, currentRole: 'ldx_admin' },
      params: { values: { sourceCollection: 'latticeOrders' } },
    }), async () => {}),
    /Simulated snapshot insert failure/,
  );
  assert.equal(txCount, beforeTx + 2);
  assert.equal(ledgerEntries.length, beforeLedgerLen);
  db.getRepository = origGetRepo;
  db.sequelize.transaction = origTx;

  // 3. Minor 3: computeMkt CSV parsing rejects empty segments (4,,8) & handles empty optional params consistently
  await assert.rejects(
    () => gov.computeMkt(makeHttpCtx({
      method: 'GET',
      state: { currentUser: { id: 10 }, currentRole: 'ldx_admin' },
      params: { samplesC: '4,,8' },
    }), async () => {}),
    (err) => err.status === 400 && err.code === 'MKT_INVALID_SAMPLE',
  );
  const csvValidCtx = makeHttpCtx({
    method: 'GET',
    state: { currentUser: { id: 10 }, currentRole: 'ldx_admin' },
    params: { samplesC: '4, 8', deltaH_kJ_mol: '', maxAllowedC: '' },
  });
  await gov.computeMkt(csvValidCtx, async () => {});
  assert.equal(csvValidCtx.body.sampleCount, 2);
  assert.equal(csvValidCtx.body.thresholdCelsius, null);
  assert.equal(csvValidCtx.body.breached, false);

  await assert.rejects(
    () => gov.computeMkt(makeHttpCtx({
      method: 'GET',
      state: { currentUser: { id: 10 }, currentRole: 'ldx_admin' },
      params: { samplesC: '4,8', deltaH_kJ_mol: 'invalid' },
    }), async () => {}),
    (err) => err.status === 400 && err.code === 'MKT_INVALID_PARAMS',
  );
  await assert.rejects(
    () => gov.computeMkt(makeHttpCtx({
      method: 'GET',
      state: { currentUser: { id: 10 }, currentRole: 'ldx_admin' },
      params: { samplesC: '4,8', maxAllowedC: [] },
    }), async () => {}),
    (err) => err.status === 400 && err.code === 'MKT_INVALID_THRESHOLD',
  );

  // 4. Minor 4: lineageTrace truncation at MAX_LINEAGE_NODES=100 emits zero dangling edges
  for (let i = 1; i <= 110; i += 1) {
    await recordLineageEdge(db, {
      organizationId: 'org-a',
      sourceCollection: 'latticeOrders',
      sourceRecordId: 'ROOT-FANOUT',
      targetCollection: 'latticeServiceTickets',
      targetRecordId: `FAN-${i}`,
      relationType: 'spawned',
    });
  }
  const truncTraceCtx = makeHttpCtx({
    method: 'GET',
    state: { currentUser: { id: 10 }, currentRole: 'ldx_admin' },
    params: { collection: 'latticeOrders', recordId: 'ROOT-FANOUT', maxDepth: 2, direction: 'outbound' },
  });
  await gov.lineageTrace(truncTraceCtx, async () => {});
  assert.equal(truncTraceCtx.body.truncated, true);
  assert.equal(truncTraceCtx.body.nodeCount, 100);
  assert.equal(truncTraceCtx.body.nodes.length, 100);
  const nodeKeys = new Set(truncTraceCtx.body.nodes.map((n) => n.key));
  assert.equal(truncTraceCtx.body.edges.length, 99);
  for (const edge of truncTraceCtx.body.edges) {
    assert.ok(nodeKeys.has(`${edge.sourceCollection}:${edge.sourceRecordId}`), 'Dangling edge source node');
    assert.ok(nodeKeys.has(`${edge.targetCollection}:${edge.targetRecordId}`), 'Dangling edge target node');
  }

  // 5. Minor 5: sanitizeSnapshotFilter rejects non-plain-object/array at depth=0; retentionDays rejects booleans/non-finite
  for (const badFilter of [[1, 2], '[1, 2]', 123, true, 'null']) {
    await assert.rejects(
      () => gov.freezeSnapshot(makeHttpCtx({
        method: 'POST',
        state: { currentUser: { id: 10, username: 'org-a-admin' }, currentRole: 'ldx_admin' },
        params: { values: { sourceCollection: 'latticeOrders', filter: badFilter } },
      }), async () => {}),
      (err) => err.status === 400 && err.code === 'DATA_GOV_FILTER_INVALID',
    );
  }
  for (const badRetention of [true, false, [5], NaN, Infinity, '', null, 0, -3]) {
    await assert.rejects(
      () => gov.freezeSnapshot(makeHttpCtx({
        method: 'POST',
        state: { currentUser: { id: 10, username: 'org-a-admin' }, currentRole: 'ldx_admin' },
        params: { values: { sourceCollection: 'latticeOrders', retentionDays: badRetention } },
      }), async () => {}),
      (err) => err.status === 400 && err.code === 'DATA_GOV_RETENTION_INVALID',
    );
  }

  // 6. Minor 6: read-only PAT rejection on quarantineResolve (GET & POST), read-only PAT allowance on POST computeMkt, and ctx.can ACL path
  const roPatCtx = makeHttpCtx({
    method: 'POST',
    state: { currentUser: { id: 10, username: 'org-a-admin' }, currentRole: 'ldx_admin' },
    params: { values: { name: 'Round1 RO', roleName: 'ldx_admin', scopes: ['read'] } },
  });
  await keyActions.issue(roPatCtx, async () => {});
  const roToken = roPatCtx.body.token;

  for (const method of ['GET', 'POST']) {
    const roResolveCtx = makeHttpCtx({
      method,
      headers: { 'x-lattice-api-key': roToken },
      params: {
        resourceName: 'dxosDataGov',
        actionName: 'quarantineResolve',
        values: { quarantineUid: qTxRec.quarantineUid, status: 'rejected' },
      },
    });
    await assert.rejects(
      () => authMw(roResolveCtx, async () => gov.quarantineResolve(roResolveCtx, async () => {})),
      (err) => err.status === 403 && err.code === 'API_KEY_SCOPE_INSUFFICIENT',
    );
  }

  const roPostMktCtx = makeHttpCtx({
    method: 'POST',
    headers: { 'x-lattice-api-key': roToken },
    params: { resourceName: 'dxosDataGov', actionName: 'computeMkt', values: { samplesC: [2, 8], maxAllowedC: 8 } },
  });
  await authMw(roPostMktCtx, async () => gov.computeMkt(roPostMktCtx, async () => {}));
  assert.equal(roPostMktCtx.body.sampleCount, 2);
  assert.equal(roPostMktCtx.body.breached, false);

  const deniedCanCtx = makeHttpCtx({
    method: 'GET',
    state: { currentUser: { id: 20 }, currentRole: 'ldx_employee' },
  });
  deniedCanCtx.can = () => false;
  await assert.rejects(
    () => gov.tierSummary(deniedCanCtx, async () => {}),
    (err) => err.status === 403 && err.code === 'DATA_GOV_FORBIDDEN',
  );

  const allowedCanCtx = makeHttpCtx({
    method: 'GET',
    state: { currentUser: { id: 20 }, currentRole: 'ldx_employee' },
  });
  allowedCanCtx.can = ({ resource, action }) => resource === 'latticeOrders' && action === 'view';
  await gov.tierSummary(allowedCanCtx, async () => {});
  assert.equal(allowedCanCtx.body.organizationId, 'org-a');
});

test('Task 2.1 files carry valid Apache-2.0 SPDX headers', async () => {
  const { addSourceHeader } = await import(pathToFileURL(join(REPO_ROOT, 'scripts/source-headers.mjs')).href);
  for (const rel of [
    'plugins/nocobase/plugin-lattice-foundation/src/server/collections/frozen-snapshots.js',
    'plugins/nocobase/plugin-lattice-foundation/src/server/collections/data-lineage.js',
    'plugins/nocobase/plugin-lattice-foundation/src/server/collections/data-quarantine.js',
    'plugins/nocobase/plugin-lattice-foundation/src/server/migrations/20261124000200-data-governance-lineage-quarantine.js',
    'plugins/nocobase/plugin-lattice-foundation/src/server/data-governance.js',
    'plugins/nocobase/plugin-lattice-foundation/src/server/pg-rls.js',
    'plugins/nocobase/plugin-lattice-foundation/src/server/index.js',
    'plugins/nocobase/plugin-lattice-foundation/tests/data-governance.test.cjs',
    'plugins/nocobase/plugin-dxos-blocks/src/server/alarm-engine.js',
    'plugins/nocobase/plugin-dxos-blocks/tests/telemetry-quarantine.test.cjs',
  ]) {
    const res = addSourceHeader(readFileSync(join(REPO_ROOT, rel), 'utf8'), rel);
    assert.equal(res.status, 'present', `${rel} missing valid SPDX header`);
  }
});
