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

function makeInMemoryPaasDb({ dialect = 'postgres', withLedgerRepo = true } = {}) {
  const seqCounters = { apiKeys: 0, pkiKeys: 0, ledger: 0, orders: 10, chatter: 0 };
  const users = [
    { id: 1, username: 'root-admin', active: true },
    { id: 10, username: 'org-admin', active: true },
    { id: 20, username: 'emp-alice', active: true },
    { id: 30, username: 'emp-bob-orgb', active: true },
    { id: 40, username: 'disabled-user', active: false },
    { id: 50, username: 'emp-charlie', active: true },
  ];
  const roles = [
    { name: 'root', allowConfigure: true, snippets: ['pm', 'pm.*'] },
    { name: 'ldx_admin', allowConfigure: true, snippets: ['pm.*'] },
    { name: 'ldx_employee', allowConfigure: false, snippets: [] },
    { name: 'ldx_manager', allowConfigure: false, snippets: [] },
  ];
  const rolesUsers = [
    { userId: 1, roleName: 'root' },
    { userId: 10, roleName: 'ldx_admin' },
    { userId: 20, roleName: 'ldx_employee' },
    { userId: 30, roleName: 'ldx_employee' },
    { userId: 40, roleName: 'ldx_employee' },
    { userId: 50, roleName: 'ldx_employee' },
  ];
  const employees = [
    { id: 100, userId: 10, organizationId: 'org-a', departmentId: 1, active: true, code: 'ADM-A', name: 'Admin A' },
    { id: 200, userId: 20, organizationId: 'org-a', departmentId: 1, active: true, code: 'EMP-A', name: 'Alice A' },
    { id: 300, userId: 30, organizationId: 'org-b', departmentId: 2, active: true, code: 'EMP-B', name: 'Bob B' },
    { id: 400, userId: 40, organizationId: 'org-a', departmentId: 1, active: true, code: 'EMP-OFF', name: 'Disabled User' },
    { id: 500, userId: 50, organizationId: 'org-a', departmentId: 1, active: true, code: 'EMP-C', name: 'Charlie A' },
  ];
  const apiKeys = [];
  const pkiKeys = [];
  const ledgerEntries = [];
  const orders = [
    {
      id: 1,
      organizationId: 'org-a',
      code: 'ORD-A1',
      name: 'Cold Storage Vaccine Batch',
      requesterId: 200,
      assigneeId: 100,
      status: 'draft',
      version: 1,
      amendmentNo: 0,
      amendedFromId: null,
    },
    {
      id: 2,
      organizationId: 'org-b',
      code: 'ORD-B1',
      name: 'Org B Secret Order',
      requesterId: 300,
      status: 'draft',
      version: 1,
      amendmentNo: 0,
      amendedFromId: null,
    },
  ];
  const chatter = [];
  const listeners = new Map();

  const match = (row, filter = {}) => Object.entries(filter || {}).every(([k, cond]) => {
    if (k === '$and' && Array.isArray(cond)) return cond.every((sub) => match(row, sub));
    if (k === '$or' && Array.isArray(cond)) return cond.some((sub) => match(row, sub));
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      if (Array.isArray(cond.$in)) return cond.$in.includes(row[k]);
      if (Object.hasOwn(cond, '$eq')) return row[k] === cond.$eq;
      if (Object.hasOwn(cond, '$ne')) return row[k] !== cond.$ne;
    }
    return row[k] === cond;
  });

  const wrap = (row, collectionName) => (row ? {
    ...row,
    toJSON: () => ({ ...row }),
    get: (k) => row[k],
    update: async (patch) => {
      for (const fn of listeners.get(`${collectionName}.beforeUpdate`) || []) {
        await fn(row, { attributes: patch });
      }
      Object.assign(row, patch, { updatedAt: new Date().toISOString() });
      return wrap(row, collectionName);
    },
    destroy: async () => {
      for (const fn of listeners.get(`${collectionName}.beforeDestroy`) || []) {
        await fn(row, {});
      }
      return 1;
    },
  } : null);

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
      if (collectionName === 'latticePkiKeys' && list.some((k) => k.organizationId === values.organizationId)) {
        throw Object.assign(new Error('Unique violation on organizationId'), { name: 'SequelizeUniqueConstraintError' });
      }
      if (collectionName === 'latticeCryptoLedger' && list.some((e) => e.organizationId === values.organizationId && Number(e.seq) === Number(values.seq))) {
        throw Object.assign(new Error('Unique violation on (organizationId, seq)'), { name: 'SequelizeUniqueConstraintError' });
      }
      const row = {
        id: ++seqCounters[counterKey],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...values,
      };
      list.push(row);
      return wrap(row, collectionName);
    },
    update: async ({ filterByTk, filter, values } = {}) => {
      for (const fn of listeners.get(`${collectionName}.beforeBulkUpdate`) || []) {
        await fn({ where: filter, attributes: values });
      }
      const targets = list.filter((r) => (filterByTk != null ? Number(r.id) === Number(filterByTk) : true) && (!filter || match(r, filter)));
      for (const t of targets) {
        for (const fn of listeners.get(`${collectionName}.beforeUpdate`) || []) {
          await fn(t, { attributes: values });
        }
        Object.assign(t, values, { updatedAt: new Date().toISOString() });
      }
      return targets.map((t) => wrap(t, collectionName));
    },
    destroy: async ({ filter } = {}) => {
      for (const fn of listeners.get(`${collectionName}.beforeBulkDestroy`) || []) {
        await fn({ where: filter });
      }
      let removed = 0;
      for (let i = list.length - 1; i >= 0; i -= 1) {
        if (!filter || match(list[i], filter)) {
          for (const fn of listeners.get(`${collectionName}.beforeDestroy`) || []) {
            await fn(list[i], {});
          }
          list.splice(i, 1);
          removed += 1;
        }
      }
      return removed;
    },
  });

  const sqlQueries = [];
  const fakeTx = { id: 'tx-paas', LOCK: { UPDATE: 'UPDATE' } };
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
      query: async (sql, opts) => {
        sqlQueries.push({ sql, opts });
        return [[]];
      },
    },
    getModel(name) {
      if (name === 'latticeOrders' || name === 'latticeRequests') {
        return { findOne: async ({ where }) => orders.find((r) => match(r, where)) || null };
      }
      return null;
    },
    getRepository(name) {
      if (name === 'users') return makeRepo('users', users, 'apiKeys');
      if (name === 'roles') return makeRepo('roles', roles, 'apiKeys');
      if (name === 'rolesUsers') return makeRepo('rolesUsers', rolesUsers, 'apiKeys');
      if (name === 'latticeEmployees') return makeRepo('latticeEmployees', employees, 'apiKeys');
      if (name === 'latticeApiKeys') return makeRepo('latticeApiKeys', apiKeys, 'apiKeys');
      if (name === 'latticePkiKeys') return makeRepo('latticePkiKeys', pkiKeys, 'pkiKeys');
      if (name === 'latticeCryptoLedger') return withLedgerRepo ? makeRepo('latticeCryptoLedger', ledgerEntries, 'ledger') : null;
      if (name === 'latticeOrders' || name === 'latticeRequests') return makeRepo(name, orders, 'orders');
      if (name === 'latticeRecordChatter') return makeRepo('latticeRecordChatter', chatter, 'chatter');
      return null;
    },
  };

  return { db, users, roles, rolesUsers, employees, apiKeys, pkiKeys, ledgerEntries, orders, chatter, sqlQueries };
}

function makeHttpCtx({ method = 'GET', path = '', state = {}, headers = {}, params = {}, query = {}, body = undefined, preserveHeaderCase = false } = {}) {
  const resHeaders = {};
  const normalizedHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    normalizedHeaders[preserveHeaderCase ? k : String(k).toLowerCase()] = v;
  }
  return {
    method,
    path,
    headers: normalizedHeaders,
    request: { path, headers: { ...normalizedHeaders }, ...(body !== undefined ? { body } : {}) },
    response: { headers: resHeaders },
    query,
    state: { ...state },
    action: { resourceName: params.resourceName || '', actionName: params.actionName || '', params },
    get(k) {
      const target = String(k).toLowerCase();
      for (const [hk, hv] of Object.entries(this.headers)) {
        if (hk.toLowerCase() === target) return hv || '';
      }
      return '';
    },
    set(k, v) { this.response.headers[k] = v; },
    throw(status, message, props) { throw Object.assign(new Error(message || `HTTP ${status}`), { status }, props || {}); },
  };
}

test('collections, migration 20261124000100, and pg-rls define all 3 tables with strict RLS and reversible down()', async () => {
  await withMockedNocobase(async () => {
    const apiKeysCol = require('../src/server/collections/api-keys');
    const pkiKeysCol = require('../src/server/collections/pki-keys');
    const ledgerCol = require('../src/server/collections/crypto-ledger');

    assert.equal(apiKeysCol.name, 'latticeApiKeys');
    assert.deepEqual(apiKeysCol.migrationRules, ['schema-only']);
    assert.ok(apiKeysCol.fields.some((f) => f.name === 'keyHash' && f.unique !== true && f.allowNull === false));
    assert.ok(apiKeysCol.indexes.some((i) => i.name === 'uidx_lattice_api_keys_hash' && i.unique === true));
    assert.ok(apiKeysCol.fields.some((f) => f.name === 'scopesJson' && f.type === 'jsonb'));

    assert.equal(pkiKeysCol.name, 'latticePkiKeys');
    assert.deepEqual(pkiKeysCol.migrationRules, ['schema-only']);
    assert.ok(pkiKeysCol.fields.some((f) => f.name === 'organizationId' && f.unique !== true && f.allowNull === false));
    assert.ok(pkiKeysCol.indexes.some((i) => i.name === 'uidx_lattice_pki_keys_org' && i.unique === true));
    assert.ok(pkiKeysCol.fields.some((f) => f.name === 'encryptedPrivateKey' && f.type === 'text' && f.allowNull === false));

    assert.equal(ledgerCol.name, 'latticeCryptoLedger');
    assert.deepEqual(ledgerCol.migrationRules, ['schema-only']);
    assert.ok(ledgerCol.fields.some((f) => f.name === 'seq' && f.type === 'bigInt' && f.allowNull === false));
    assert.ok(ledgerCol.fields.some((f) => f.name === 'merkleRoot' && f.allowNull === false));
    assert.ok(ledgerCol.fields.some((f) => f.name === 'signatureBase64' && f.type === 'text' && f.allowNull === false));

    const pgRls = require('../src/server/pg-rls');
    assert.ok(pgRls.TENANT_RLS_TABLES.length >= 25);
    for (const tbl of ['latticeApiKeys', 'latticePkiKeys', 'latticeCryptoLedger']) {
      assert.ok(pgRls.TENANT_RLS_TABLES.includes(tbl), `Missing ${tbl} in TENANT_RLS_TABLES`);
    }

    const Migration = require('../src/server/migrations/20261124000100-paas-api-keys-and-pki-ledger');
    const sqlCalls = [];
    const rlsAttached = [];
    const fakeTx = { id: 'tx-20261124' };
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
    assert.match(upSql, /CREATE TABLE IF NOT EXISTS "latticeApiKeys"/);
    assert.match(upSql, /CREATE TABLE IF NOT EXISTS "latticePkiKeys"/);
    assert.match(upSql, /CREATE TABLE IF NOT EXISTS "latticeCryptoLedger"/);
    assert.match(upSql, /CREATE UNIQUE INDEX IF NOT EXISTS uidx_lattice_api_keys_hash ON "latticeApiKeys" \("keyHash"\)/);
    assert.match(upSql, /CREATE UNIQUE INDEX IF NOT EXISTS uidx_lattice_pki_keys_org ON "latticePkiKeys" \("organizationId"\)/);
    assert.match(upSql, /CREATE UNIQUE INDEX IF NOT EXISTS [^\n]+ ON "latticeCryptoLedger" \("organizationId", seq\)/);
    assert.equal(/"keyHash"\s+VARCHAR\(128\)\s+NOT\s+NULL\s+UNIQUE/i.test(upSql), false);
    assert.equal(/"organizationId"\s+VARCHAR\(255\)\s+NOT\s+NULL\s+UNIQUE/i.test(upSql), false);
    assert.deepEqual(rlsAttached.map((r) => r.tableName), ['latticeApiKeys', 'latticePkiKeys', 'latticeCryptoLedger']);
    assert.equal(rlsAttached.every((r) => r.opts?.transaction === fakeTx), true);

    sqlCalls.length = 0;
    await migration.down();
    const downSql = sqlCalls.map((x) => x.sql).join('\n');
    assert.match(downSql, /DROP TABLE IF EXISTS "latticeCryptoLedger"/);
    assert.match(downSql, /DROP TABLE IF EXISTS "latticePkiKeys"/);
    assert.match(downSql, /DROP TABLE IF EXISTS "latticeApiKeys"/);
  });
});

test('dxosApiKeys enforces token hashing, RBAC escalation lock, middleware auth, X-Role clamp, expiry, revocation, and private CRUD guard', async () => {
  const { registerPaasApiKeys, createPaasApiKeyAuthMiddleware } = require('../src/server/paas-api-keys');
  const { db, apiKeys, employees, rolesUsers } = makeInMemoryPaasDb();

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
  const actions = resources.get('dxosApiKeys');
  assert.ok(actions?.issue && actions?.list && actions?.revoke);
  assert.ok(aclAllows.some(([res, acts, role]) => res === 'dxosApiKeys' && acts.includes('issue') && acts.includes('list') && acts.includes('revoke') && role === 'loggedIn'));

  // 1. Non-admin employee CANNOT issue elevated roles (root/admin/ldx_admin) or key for another user or invalid scope
  await assert.rejects(
    () => actions.issue(makeHttpCtx({
      method: 'POST',
      state: { currentUser: { id: 20, username: 'emp-alice' }, currentRole: 'ldx_employee' },
      params: { values: { name: 'Escalate', roleName: 'ldx_admin', scopes: ['read'] } },
    }), async () => {}),
    (err) => err.status === 403,
  );
  await assert.rejects(
    () => actions.issue(makeHttpCtx({
      method: 'POST',
      state: { currentUser: { id: 20, username: 'emp-alice' }, currentRole: 'ldx_employee' },
      params: { values: { name: 'RootKey', roleName: 'root', scopes: ['read'] } },
    }), async () => {}),
    (err) => err.status === 403,
  );
  await assert.rejects(
    () => actions.issue(makeHttpCtx({
      method: 'POST',
      state: { currentUser: { id: 20, username: 'emp-alice' }, currentRole: 'ldx_employee' },
      params: { values: { name: 'OtherUser', userId: 10, roleName: 'ldx_employee', scopes: ['read'] } },
    }), async () => {}),
    (err) => err.status === 403,
  );
  await assert.rejects(
    () => actions.issue(makeHttpCtx({
      method: 'POST',
      state: { currentUser: { id: 20, username: 'emp-alice' }, currentRole: 'ldx_employee' },
      params: { values: { name: 'BadScope', roleName: 'ldx_employee', scopes: ['*'] } },
    }), async () => {}),
    (err) => err.status === 400,
  );

  // 2. Non-admin employee CAN issue own non-elevated key matching caller role; token returned once, keyHash never leaked
  const empIssueCtx = makeHttpCtx({
    method: 'POST',
    state: { currentUser: { id: 20, username: 'emp-alice' }, currentRole: 'ldx_employee' },
    params: { values: { name: 'Alice CI Read', roleName: 'ldx_employee', scopes: ['read', 'wms'], expiresInDays: 30 } },
  });
  await actions.issue(empIssueCtx, async () => {});
  assert.match(empIssueCtx.body.token, /^ldx_pat_[0-9a-f]{8}_[0-9a-f]{32}$/);
  assert.equal(empIssueCtx.body.keyHash, undefined);
  assert.equal(empIssueCtx.body.organizationId, 'org-a');
  assert.equal(empIssueCtx.body.roleName, 'ldx_employee');
  assert.equal(apiKeys[0].keyHash, crypto.createHash('sha256').update(empIssueCtx.body.token).digest('hex'));
  assert.notEqual(apiKeys[0].keyHash, empIssueCtx.body.token);

  // 3. Tenant admin (ldx_admin) CAN issue key for org-a user, CANNOT issue root or cross-org key
  const adminIssueCtx = makeHttpCtx({
    method: 'POST',
    state: { currentUser: { id: 10, username: 'org-admin' }, currentRole: 'ldx_admin' },
    params: { values: { name: 'Admin Key', roleName: 'ldx_admin', scopes: ['read', 'write', 'ai'], expiresInDays: 90 } },
  });
  await actions.issue(adminIssueCtx, async () => {});
  assert.match(adminIssueCtx.body.token, /^ldx_pat_[0-9a-f]{8}_[0-9a-f]{32}$/);

  await assert.rejects(
    () => actions.issue(makeHttpCtx({
      method: 'POST',
      state: { currentUser: { id: 10, username: 'org-admin' }, currentRole: 'ldx_admin' },
      params: { values: { name: 'CrossOrg', userId: 30, roleName: 'ldx_employee', scopes: ['read'] } },
    }), async () => {}),
    (err) => err.status === 403 || err.status === 404,
  );
  await assert.rejects(
    () => actions.issue(makeHttpCtx({
      method: 'POST',
      state: { currentUser: { id: 10, username: 'org-admin' }, currentRole: 'ldx_admin' },
      params: { values: { name: 'EscalateRoot', roleName: 'root', scopes: ['read', 'write'] } },
    }), async () => {}),
    (err) => err.status === 403,
  );

  // 4. List returns org keys for admin (without keyHash/token) and only own keys for employee
  const adminListCtx = makeHttpCtx({
    method: 'GET',
    state: { currentUser: { id: 10, username: 'org-admin' }, currentRole: 'ldx_admin' },
  });
  await actions.list(adminListCtx, async () => {});
  assert.equal(adminListCtx.body.items.length, 2);
  assert.equal(adminListCtx.body.items.every((k) => k.keyHash === undefined && k.token === undefined), true);

  const empListCtx = makeHttpCtx({
    method: 'GET',
    state: { currentUser: { id: 20, username: 'emp-alice' }, currentRole: 'ldx_employee' },
  });
  await actions.list(empListCtx, async () => {});
  assert.equal(empListCtx.body.items.length, 1);
  assert.equal(empListCtx.body.items[0].name, 'Alice CI Read');

  // 5. Auth middleware validates X-Lattice-API-Key & Bearer ldx_pat_, clamps X-Role, updates lastUsedAt throttled
  const authMw = createPaasApiKeyAuthMiddleware(db);
  const patCtx = makeHttpCtx({
    method: 'GET',
    headers: { 'x-lattice-api-key': empIssueCtx.body.token, 'x-role': 'root' },
  });
  let ranNext = false;
  await authMw(patCtx, async () => { ranNext = true; });
  assert.equal(ranNext, true);
  assert.equal(patCtx.state.currentUser.id, 20);
  assert.equal(patCtx.state.currentRole, 'ldx_employee');
  assert.equal(patCtx.headers['x-role'], 'ldx_employee');
  assert.equal(patCtx.skipAuthCheck, true);
  assert.deepEqual(patCtx.state.latticeApiKey.scopes, ['read', 'wms']);
  assert.ok(apiKeys[0].lastUsedAt);

  // Also works with Authorization: Bearer ldx_pat_... when currentUser is unset
  const bearerCtx = makeHttpCtx({
    method: 'GET',
    headers: { authorization: `Bearer ${adminIssueCtx.body.token}`, 'x-role': 'root' },
  });
  await authMw(bearerCtx, async () => {});
  assert.equal(bearerCtx.state.currentUser.id, 10);
  assert.equal(bearerCtx.state.currentRole, 'ldx_admin');
  assert.equal(bearerCtx.headers['x-role'], 'ldx_admin');
  assert.equal(bearerCtx.skipAuthCheck, true);

  // Non-PAT Bearer or anonymous request passes through without setting skipAuthCheck
  const jwtPassCtx = makeHttpCtx({
    method: 'GET',
    headers: { authorization: 'Bearer eyJ.fake.jwt' },
  });
  let jwtRanNext = false;
  await authMw(jwtPassCtx, async () => { jwtRanNext = true; });
  assert.equal(jwtRanNext, true);
  assert.equal(jwtPassCtx.skipAuthCheck, undefined);

  const anonPassCtx = makeHttpCtx({ method: 'GET', headers: {} });
  let anonRanNext = false;
  await authMw(anonPassCtx, async () => { anonRanNext = true; });
  assert.equal(anonRanNext, true);
  assert.equal(anonPassCtx.skipAuthCheck, undefined);

  // Invalid PAT rejected with 401 and must never set skipAuthCheck
  const badKeyCtx = makeHttpCtx({ headers: { 'x-lattice-api-key': 'ldx_pat_deadbeef_00000000000000000000000000000000' } });
  await assert.rejects(
    () => authMw(badKeyCtx, async () => {}),
    (err) => err.status === 401,
  );
  assert.equal(badKeyCtx.skipAuthCheck, undefined);
  const badBearerCtx = makeHttpCtx({ headers: { authorization: 'Bearer ldx_pat_bad_format' } });
  await assert.rejects(
    () => authMw(badBearerCtx, async () => {}),
    (err) => err.status === 401,
  );
  assert.equal(badBearerCtx.skipAuthCheck, undefined);

  // Expired PAT rejected with 401
  apiKeys[1].expiresAt = new Date(Date.now() - 60_000).toISOString();
  await assert.rejects(
    () => authMw(makeHttpCtx({ headers: { 'x-lattice-api-key': adminIssueCtx.body.token } }), async () => {}),
    (err) => err.status === 401,
  );
  apiKeys[1].expiresAt = new Date(Date.now() + 86400_000).toISOString();

  // Revoking Alice's key works for owner and rejects subsequent auth with 401
  const revokeCtx = makeHttpCtx({
    method: 'POST',
    state: { currentUser: { id: 20, username: 'emp-alice' }, currentRole: 'ldx_employee' },
    params: { values: { id: empIssueCtx.body.id } },
  });
  await actions.revoke(revokeCtx, async () => {});
  assert.equal(revokeCtx.body.active, false);
  assert.ok(revokeCtx.body.revokedAt);

  await assert.rejects(
    () => authMw(makeHttpCtx({ headers: { 'x-lattice-api-key': empIssueCtx.body.token } }), async () => {}),
    (err) => err.status === 401,
  );

  // Role revocation or deactivated employee fails closed with 401
  const origRoles = rolesUsers.splice(0, rolesUsers.length, ...rolesUsers.filter((ru) => !(ru.userId === 10 && ru.roleName === 'ldx_admin')));
  await assert.rejects(
    () => authMw(makeHttpCtx({ headers: { 'x-lattice-api-key': adminIssueCtx.body.token } }), async () => {}),
    (err) => err.status === 401,
  );
  rolesUsers.push({ userId: 10, roleName: 'ldx_admin' });
  employees[0].active = false;
  await assert.rejects(
    () => authMw(makeHttpCtx({ headers: { 'x-lattice-api-key': adminIssueCtx.body.token } }), async () => {}),
    (err) => err.status === 401,
  );
  employees[0].active = true;

  // 6. Direct REST / chart access to latticeApiKeys / latticePkiKeys / latticeCryptoLedger blocked for non-root
  const guardMw = middlewares.find((m) => m.opts?.tag === 'latticePaasPrivateCollectionGuard')?.fn;
  assert.ok(guardMw);
  for (const resName of ['latticeApiKeys', 'latticePkiKeys', 'latticeCryptoLedger']) {
    await assert.rejects(
      () => guardMw(makeHttpCtx({ state: { currentRole: 'ldx_admin' }, params: { resourceName: resName, actionName: 'list' } }), async () => {}),
      (err) => err.status === 403,
    );
    await assert.rejects(
      () => guardMw(makeHttpCtx({
        state: { currentRole: 'ldx_admin' },
        params: { resourceName: 'charts', actionName: 'queryData', values: { mode: 'builder', collection: resName } },
      }), async () => {}),
      (err) => err.status === 403,
    );
  }
  assert.ok(origRoles);
});

test('Ed25519 PKI encryption, canonicalJson, hash-chain, binary Merkle verification, tamper detection, and immutable hooks', async () => {
  const {
    canonicalJson,
    computeMerkleRoot,
    ensureOrgSigningKey,
    signCanonicalPayload,
    verifyPayloadSignature,
    appendLedgerEntry,
    verifyLedgerChain,
    registerPkiLedger,
  } = require('../src/server/pki-ledger');

  // Deterministic canonical JSON
  assert.equal(
    canonicalJson({ z: 1, a: { d: 4, c: [3, { y: 2, x: 1 }] } }),
    '{"a":{"c":[3,{"x":1,"y":2}],"d":4},"z":1}',
  );

  // Production fail-closed when ENCRYPTION_FIELD_KEY and APP_KEY are both missing
  const { db, pkiKeys, ledgerEntries } = makeInMemoryPaasDb();
  const prevNodeEnv = process.env.NODE_ENV;
  const prevEncKey = process.env.ENCRYPTION_FIELD_KEY;
  const prevAppKey = process.env.APP_KEY;
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.ENCRYPTION_FIELD_KEY;
    delete process.env.APP_KEY;
    await assert.rejects(
      () => ensureOrgSigningKey(db, 'org-prod-check'),
      (err) => err.code === 'PKI_MASTER_KEY_MISSING',
    );
  } finally {
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevNodeEnv;
    if (prevEncKey === undefined) delete process.env.ENCRYPTION_FIELD_KEY; else process.env.ENCRYPTION_FIELD_KEY = prevEncKey;
    if (prevAppKey === undefined) delete process.env.APP_KEY; else process.env.APP_KEY = prevAppKey;
  }

  // Lazy Ed25519 key generation & AES-256-GCM ciphertext iv:tag:cipher
  const keyRow = await ensureOrgSigningKey(db, 'org-a');
  assert.equal(keyRow.algorithm, 'Ed25519');
  assert.match(keyRow.publicKeyPem, /^-----BEGIN PUBLIC KEY-----/);
  assert.equal(keyRow.encryptedPrivateKey.split(':').length, 3);
  assert.equal(keyRow.encryptedPrivateKey.includes('PRIVATE KEY'), false);
  assert.equal(pkiKeys.length, 1);

  // Sign & verify canonical payload regardless of key ordering
  const signed = await signCanonicalPayload(db, 'org-a', { b: 2, a: 1 });
  const verified = await verifyPayloadSignature(db, 'org-a', { a: 1, b: 2 }, signed.signatureBase64, signed.keyId);
  assert.equal(verified.valid, true);

  const tamperedPayload = await verifyPayloadSignature(db, 'org-a', { a: 1, b: 999 }, signed.signatureBase64);
  assert.equal(tamperedPayload.valid, false);

  // Append 3 sequential ledger entries & verify hash chain + binary Merkle root
  const e1 = await appendLedgerEntry(db, {
    organizationId: 'org-a',
    eventType: 'voucher.submitted',
    targetCollection: 'latticeOrders',
    targetRecordId: '1',
    actor: { userId: '20', username: 'emp-alice' },
    payload: { id: 1, code: 'ORD-A1', status: 'submitted' },
  });
  const e2 = await appendLedgerEntry(db, {
    organizationId: 'org-a',
    eventType: 'chatter.comment',
    targetCollection: 'latticeOrders',
    targetRecordId: '1',
    actor: { userId: '20', username: 'emp-alice' },
    payload: { body: 'Checked temperature log' },
  });
  const e3 = await appendLedgerEntry(db, {
    organizationId: 'org-a',
    eventType: 'document.signed',
    targetCollection: 'latticeOrders',
    targetRecordId: '1',
    actor: { userId: '10', username: 'org-admin' },
    payload: { id: 1, code: 'ORD-A1', approved: true },
  });

  assert.equal(Number(e1.seq), 1);
  assert.equal(e1.prevHash, '0'.repeat(64));
  assert.equal(Number(e2.seq), 2);
  assert.equal(e2.prevHash, e1.entryHash);
  assert.equal(Number(e3.seq), 3);
  assert.equal(e3.prevHash, e2.entryHash);
  assert.equal(e3.merkleRoot, computeMerkleRoot([e1.entryHash, e2.entryHash, e3.entryHash]));

  const okVerify = await verifyLedgerChain(db, 'org-a');
  assert.equal(okVerify.valid, true);
  assert.equal(okVerify.checkedCount, 3);
  assert.equal(okVerify.brokenAtSeq, null);
  assert.equal(okVerify.merkleRoot, e3.merkleRoot);
  assert.equal(okVerify.headHash, e3.entryHash);

  // Tamper payloadHash on seq 2 -> deterministic break at seq 2
  const origPayloadHash = ledgerEntries[1].payloadHash;
  ledgerEntries[1].payloadHash = 'f'.repeat(64);
  const brokenHash = await verifyLedgerChain(db, 'org-a');
  assert.equal(brokenHash.valid, false);
  assert.equal(brokenHash.brokenAtSeq, 2);
  ledgerEntries[1].payloadHash = origPayloadHash;

  // Tamper signature on seq 3 -> deterministic break at seq 3
  const origSig = ledgerEntries[2].signatureBase64;
  ledgerEntries[2].signatureBase64 = Buffer.from('forged-sig').toString('base64');
  const brokenSig = await verifyLedgerChain(db, 'org-a');
  assert.equal(brokenSig.valid, false);
  assert.equal(brokenSig.brokenAtSeq, 3);
  ledgerEntries[2].signatureBase64 = origSig;

  // Tamper merkleRoot on seq 2 -> deterministic break at seq 2
  const origMerkle = ledgerEntries[1].merkleRoot;
  ledgerEntries[1].merkleRoot = 'a'.repeat(64);
  const brokenMerkle = await verifyLedgerChain(db, 'org-a');
  assert.equal(brokenMerkle.valid, false);
  assert.equal(brokenMerkle.brokenAtSeq, 2);
  ledgerEntries[1].merkleRoot = origMerkle;

  // Register resource & immutable hooks -> beforeUpdate/beforeDestroy/beforeBulkUpdate/beforeBulkDestroy throw 403 LEDGER_IMMUTABLE
  const resources = new Map();
  const aclAllows = [];
  registerPkiLedger({
    db,
    resourceManager: { define(def) { resources.set(def.name, def.actions); } },
    acl: { allow(...args) { aclAllows.push(args); } },
  });

  for (const hook of ['beforeUpdate', 'beforeDestroy', 'beforeBulkUpdate', 'beforeBulkDestroy']) {
    await assert.rejects(
      () => db.emit(`latticeCryptoLedger.${hook}`, ledgerEntries[0], {}),
      (err) => err.status === 403 && err.code === 'LEDGER_IMMUTABLE',
    );
  }

  // Test dxosLedger actions: publicKey, status, entries, verify, signDocument, verifySignature
  const ledgerActions = resources.get('dxosLedger');
  assert.ok(ledgerActions);
  assert.ok(aclAllows.some(([res, acts, role]) => res === 'dxosLedger' && acts.includes('verify') && acts.includes('signDocument') && role === 'loggedIn'));

  const pkCtx = makeHttpCtx({ method: 'GET', state: { currentUser: { id: 20 }, currentRole: 'ldx_employee' } });
  await ledgerActions.publicKey(pkCtx, async () => {});
  assert.equal(pkCtx.body.keyId, keyRow.keyId);
  assert.equal(pkCtx.body.encryptedPrivateKey, undefined);

  const statusCtx = makeHttpCtx({ method: 'GET', state: { currentUser: { id: 20 }, currentRole: 'ldx_employee' } });
  await ledgerActions.status(statusCtx, async () => {});
  assert.equal(statusCtx.body.entryCount, 3);
  assert.equal(statusCtx.body.latestSeq, 3);

  const verifyCtx = makeHttpCtx({ method: 'POST', state: { currentUser: { id: 20 }, currentRole: 'ldx_employee' } });
  await ledgerActions.verify(verifyCtx, async () => {});
  assert.equal(verifyCtx.body.valid, true);

  // Cross-org signDocument denied 404
  await assert.rejects(
    () => ledgerActions.signDocument(makeHttpCtx({
      method: 'POST',
      state: { currentUser: { id: 20 }, currentRole: 'ldx_employee' },
      params: { values: { targetCollection: 'latticeOrders', targetRecordId: 2 } },
    }), async () => {}),
    (err) => err.status === 404,
  );

  // Owner Alice signs own order -> appends seq 4 and verifies signature
  const signDocCtx = makeHttpCtx({
    method: 'POST',
    state: { currentUser: { id: 20, username: 'emp-alice' }, currentRole: 'ldx_employee' },
    params: { values: { targetCollection: 'latticeOrders', targetRecordId: 1, reason: 'QA signoff' } },
  });
  await ledgerActions.signDocument(signDocCtx, async () => {});
  assert.equal(signDocCtx.body.signed, true);
  assert.equal(Number(signDocCtx.body.entry.seq), 4);
  assert.equal(signDocCtx.body.entry.eventType, 'document.signed');

  const verSigCtx = makeHttpCtx({
    method: 'POST',
    state: { currentUser: { id: 20 }, currentRole: 'ldx_employee' },
    params: { values: { payload: { a: 1, b: 2 }, signatureBase64: signed.signatureBase64 } },
  });
  await ledgerActions.verifySignature(verSigCtx, async () => {});
  assert.equal(verSigCtx.body.valid, true);
});

test('voucher-lifecycle and record-chatter auto-append immutable entries to latticeCryptoLedger when repo exists', async () => {
  const { submitVoucher, cancelVoucher, amendVoucher } = require('../src/server/voucher-lifecycle');
  const { recordChatterEntry } = require('../src/server/record-chatter');
  const { verifyLedgerChain } = require('../src/server/pki-ledger');
  const { db, ledgerEntries } = makeInMemoryPaasDb({ withLedgerRepo: true });

  await submitVoucher(db, {
    collection: 'latticeOrders',
    id: 1,
    organizationId: 'org-a',
    actor: { userId: '20', employeeId: 200, username: 'emp-alice' },
    expectedVersion: 1,
  });
  await cancelVoucher(db, {
    collection: 'latticeOrders',
    id: 1,
    organizationId: 'org-a',
    actor: { userId: '10', employeeId: 100, username: 'org-admin' },
    cancelReason: 'Wrong batch temperature',
    expectedVersion: 2,
  });
  await amendVoucher(db, {
    collection: 'latticeOrders',
    id: 1,
    organizationId: 'org-a',
    actor: { userId: '20', employeeId: 200, username: 'emp-alice' },
  });
  await recordChatterEntry(db, {
    organizationId: 'org-a',
    targetCollection: 'latticeOrders',
    targetRecordId: 1,
    entryType: 'comment',
    body: 'Ledger check note',
    authorUserId: 20,
    authorEmployeeId: 200,
    authorName: 'emp-alice',
  });

  const eventTypes = ledgerEntries.map((e) => e.eventType);
  assert.ok(eventTypes.includes('voucher.submitted'));
  assert.ok(eventTypes.includes('voucher.cancelled'));
  assert.ok(eventTypes.includes('voucher.amended'));
  assert.ok(eventTypes.includes('chatter.comment'));
  const verification = await verifyLedgerChain(db, 'org-a');
  assert.equal(verification.valid, true);
  assert.equal(verification.checkedCount, ledgerEntries.length);
});

test('OpenAPI 3.1.0, AsyncAPI 3.0.0, observability dxos:openapi/asyncapi endpoints, and SPDX headers pass', async () => {
  const { buildOpenApiSpec, buildAsyncApiSpec } = require('../src/server/openapi-spec');
  const { registerObservability } = require('../src/server/observability');

  const openapi = buildOpenApiSpec({ serverUrl: 'https://dx.example.org' });
  assert.equal(openapi.openapi, '3.1.0');
  assert.equal(openapi.info.license.name, 'Apache-2.0');
  assert.equal(openapi.info.license.identifier, 'Apache-2.0');
  assert.equal(Object.hasOwn(openapi.info.license, 'url'), false);
  assert.equal(openapi.servers[0].url, 'https://dx.example.org');
  assert.ok(openapi.components.securitySchemes.bearerAuth);
  assert.ok(openapi.components.securitySchemes.latticeApiKey);
  assert.equal(openapi.components.securitySchemes.latticeApiKey.name, 'X-Lattice-API-Key');
  for (const requiredPath of [
    '/api/dxos:health',
    '/api/dxos:metrics',
    '/api/dxos:openapi',
    '/api/dxos:asyncapi',
    '/api/dxosApiKeys:issue',
    '/api/dxosApiKeys:list',
    '/api/dxosApiKeys:revoke',
    '/api/dxosLedger:publicKey',
    '/api/dxosLedger:verify',
    '/api/dxosLedger:signDocument',
    '/api/latticeVoucher:submit',
    '/api/latticeNotifications:listMine',
    '/api/latticeSla:summary',
    '/api/latticePara:summary',
    '/api/dxosWms:stockSummary',
    '/api/dxosDmn:evaluate',
    '/api/dxosDataGov:freezeSnapshot',
    '/api/dxosBlocks:telemetryIngest',
    '/api/dxosStudio:composePortals',
    '/api/dxosAi:portalCopilot',
    '/api/dxos-mcp',
  ]) {
    assert.ok(openapi.paths[requiredPath], `OpenAPI missing path ${requiredPath}`);
  }

  const asyncapi = buildAsyncApiSpec({ serverUrl: 'https://dx.example.org' });
  assert.equal(asyncapi.asyncapi, '3.0.0');
  const asyncJson = JSON.stringify(asyncapi);
  assert.ok(asyncJson.includes('latticedx/{org}/{entity}/telemetry'));
  assert.ok(asyncJson.includes('latticedx/{org}/{entity}/command'));
  assert.ok(asyncJson.includes('/api/dxosAi:surfaceEvents'));
  assert.ok(asyncJson.includes('latticedx:surface-updates'));
  assert.ok(asyncJson.includes('latticeContextOutbox'));

  const resources = new Map();
  const aclAllows = [];
  registerObservability({
    use() {},
    resourceManager: { define(def) { resources.set(def.name, def.actions); } },
    acl: { allow(...args) { aclAllows.push(args); } },
  });
  const dxos = resources.get('dxos');
  assert.ok(dxos?.openapi && dxos?.asyncapi);
  assert.ok(aclAllows.some(([res, acts, perm]) => res === 'dxos' && acts.includes('openapi') && acts.includes('asyncapi') && perm === 'public'));

  const oaCtx = makeHttpCtx({ method: 'GET', headers: { host: 'api.latticedx.local', 'x-forwarded-proto': 'https' } });
  await dxos.openapi(oaCtx, async () => {});
  assert.equal(oaCtx.withoutDataWrapping, true);
  assert.equal(oaCtx.response.headers['Cache-Control'], 'no-store');
  assert.equal(oaCtx.body.openapi, '3.1.0');
  assert.equal(oaCtx.body.servers[0].url, 'https://api.latticedx.local');

  const aaCtx = makeHttpCtx({ method: 'GET', headers: { host: 'api.latticedx.local', 'x-forwarded-proto': 'https' } });
  await dxos.asyncapi(aaCtx, async () => {});
  assert.equal(aaCtx.withoutDataWrapping, true);
  assert.equal(aaCtx.response.headers['Cache-Control'], 'no-store');
  assert.equal(aaCtx.body.asyncapi, '3.0.0');

  // Verify plugin index.js wires PaaS API keys middleware BEFORE auth + dxosLedger
  await withMockedNocobase(async () => {
    const indexPath = require.resolve('../src/server/index');
    delete require.cache[indexPath];
    const LatticeFoundationPlugin = require('../src/server/index');
    const rmUses = [];
    const pluginResources = new Map();
    const plugin = new LatticeFoundationPlugin({
      db: { on() {}, getRepository() { return null; }, sequelize: { query: async () => [[1]] } },
      use() {},
      resourceManager: {
        define(def) { pluginResources.set(def.name, def.actions); },
        use(fn, opts) { rmUses.push({ fn, opts }); },
      },
      acl: { allow() {}, registerSnippet() {} },
      cronJobManager: { addJob() {} },
    });
    await plugin.load();
    assert.ok(pluginResources.has('dxosApiKeys'));
    assert.ok(pluginResources.has('dxosLedger'));
    assert.ok(rmUses.some((m) => m.opts?.tag === 'latticePaasApiKeyAuth' && m.opts?.before === 'auth'));
  });

  // Verify SPDX Apache-2.0 headers on all Task 1.1 files
  const { addSourceHeader } = await import(pathToFileURL(join(REPO_ROOT, 'scripts/source-headers.mjs')).href);
  for (const rel of [
    'plugins/nocobase/plugin-lattice-foundation/src/server/collections/api-keys.js',
    'plugins/nocobase/plugin-lattice-foundation/src/server/collections/pki-keys.js',
    'plugins/nocobase/plugin-lattice-foundation/src/server/collections/crypto-ledger.js',
    'plugins/nocobase/plugin-lattice-foundation/src/server/migrations/20261124000100-paas-api-keys-and-pki-ledger.js',
    'plugins/nocobase/plugin-lattice-foundation/src/server/paas-api-keys.js',
    'plugins/nocobase/plugin-lattice-foundation/src/server/pki-ledger.js',
    'plugins/nocobase/plugin-lattice-foundation/src/server/openapi-spec.js',
    'plugins/nocobase/plugin-lattice-foundation/tests/paas-pki-ledger.test.cjs',
  ]) {
    const res = addSourceHeader(readFileSync(join(REPO_ROOT, rel), 'utf8'), rel);
    assert.equal(res.status, 'present', `${rel} missing valid SPDX header`);
  }
});

test('edge cases: read-only PAT scope clamp, Bearer precedence, expiresInDays bounds, entries paging, seq gap, and missing ledger repo safety', async () => {
  const { registerPaasApiKeys, createPaasApiKeyAuthMiddleware } = require('../src/server/paas-api-keys');
  const { appendLedgerEntry, verifyLedgerChain, registerPkiLedger } = require('../src/server/pki-ledger');
  const { submitVoucher } = require('../src/server/voucher-lifecycle');
  const { recordChatterEntry } = require('../src/server/record-chatter');

  const { db, ledgerEntries } = makeInMemoryPaasDb({ withLedgerRepo: true });
  const resources = new Map();
  const app = {
    db,
    resourceManager: { define(def) { resources.set(def.name, def.actions); }, use() {} },
    acl: { allow() {} },
  };
  registerPaasApiKeys(app);
  registerPkiLedger(app);

  const keyActions = resources.get('dxosApiKeys');
  const ledgerActions = resources.get('dxosLedger');
  const authMw = createPaasApiKeyAuthMiddleware(db);

  // expiresInDays validation bounds (0 and 366 rejected 400)
  for (const badDays of [0, 366, -1, 1.5]) {
    await assert.rejects(
      () => keyActions.issue(makeHttpCtx({
        method: 'POST',
        state: { currentUser: { id: 20 }, currentRole: 'ldx_employee' },
        params: { values: { name: 'BadExpiry', roleName: 'ldx_employee', scopes: ['read'], expiresInDays: badDays } },
      }), async () => {}),
      (err) => err.status === 400,
    );
  }

  // Issue a read-only PAT for Alice
  const roIssueCtx = makeHttpCtx({
    method: 'POST',
    state: { currentUser: { id: 20, username: 'emp-alice' }, currentRole: 'ldx_employee' },
    params: { values: { name: 'RO Key', roleName: 'ldx_employee', scopes: ['read'], expiresInDays: 7 } },
  });
  await keyActions.issue(roIssueCtx, async () => {});
  const roToken = roIssueCtx.body.token;

  // Read-only PAT fail-closed policy: permits explicit safe read-only POST actions and blocks mutating POST/PUT/PATCH/DELETE
  const roVerifyCtx = makeHttpCtx({
    method: 'POST',
    headers: { 'x-lattice-api-key': roToken },
    params: { resourceName: 'dxosLedger', actionName: 'verify' },
  });
  await authMw(roVerifyCtx, async () => ledgerActions.verify(roVerifyCtx, async () => {}));
  assert.equal(roVerifyCtx.body.valid, true);

  for (const [resourceName, actionName] of [
    ['dxosLedger', 'verifySignature'],
    ['latticePara', 'hybridSearch'],
    ['dxosDmn', 'evaluate'],
    ['dxosStudio', 'solutionBundleDiff'],
    ['charts', 'queryData'],
    ['latticeIntegrations', 'record'],
    ['latticeIntegrations', 'context'],
    ['latticeIntegrations', 'proposals'],
    ['latticeIntegrations', 'proposalReceipt'],
    ['latticeOrders', 'list'],
    ['latticeOrders', 'get'],
    ['latticeOrders', 'count'],
  ]) {
    let passed = false;
    await authMw(makeHttpCtx({
      method: 'POST',
      headers: { 'x-lattice-api-key': roToken },
      params: { resourceName, actionName },
    }), async () => { passed = true; });
    assert.equal(passed, true, `Expected read-only POST ${resourceName}:${actionName} to be allowed`);
  }

  for (const blockedCase of [
    { method: 'POST', resourceName: 'latticeOrders', actionName: 'create' },
    { method: 'POST', resourceName: 'latticeOrders.items', actionName: 'add' },
    { method: 'POST', resourceName: 'latticeOrders.items', actionName: 'remove' },
    { method: 'POST', resourceName: 'latticeOrders.items', actionName: 'set' },
    { method: 'POST', resourceName: 'latticeOrders.items', actionName: 'toggle' },
    { method: 'POST', resourceName: 'dxosWms', actionName: 'receiveStock' },
    { method: 'POST', resourceName: 'latticeIntegrations', actionName: 'propose' },
    { method: 'POST', resourceName: 'latticeIntegrations', actionName: 'receive' },
    { method: 'POST', path: '/api/dxos-mcp', resourceName: '', actionName: '' },
    { method: 'POST', path: '/api/dxos-mcp/it-ot', resourceName: 'dxosMcp', actionName: 'rpc' },
    { method: 'PUT', resourceName: 'latticeOrders', actionName: 'update' },
    { method: 'PATCH', resourceName: 'latticeOrders', actionName: 'update' },
    { method: 'DELETE', resourceName: 'latticeOrders', actionName: 'destroy' },
    { method: 'GET', resourceName: 'latticeOrders', actionName: 'destroy' },
  ]) {
    await assert.rejects(
      () => authMw(makeHttpCtx({
        method: blockedCase.method,
        path: blockedCase.path || '',
        headers: { 'x-lattice-api-key': roToken },
        params: { resourceName: blockedCase.resourceName, actionName: blockedCase.actionName },
      }), async () => {}),
      (err) => err.status === 403 && err.code === 'API_KEY_SCOPE_INSUFFICIENT',
      `Expected ${blockedCase.method} ${blockedCase.path || `${blockedCase.resourceName}:${blockedCase.actionName}`} to be blocked`,
    );
  }

  // clampHeaderRole strips mixed-case X-Role / X-ROLE keys before setting lowercase x-role
  const mixedCaseCtx = makeHttpCtx({
    method: 'GET',
    preserveHeaderCase: true,
    headers: { 'x-lattice-api-key': roToken, 'X-Role': 'root', 'X-ROLE': 'ldx_admin' },
  });
  await authMw(mixedCaseCtx, async () => {});
  assert.equal(mixedCaseCtx.headers['x-role'], 'ldx_employee');
  assert.equal(mixedCaseCtx.headers['X-Role'], undefined);
  assert.equal(mixedCaseCtx.headers['X-ROLE'], undefined);
  assert.equal(mixedCaseCtx.request.headers['x-role'], 'ldx_employee');
  assert.equal(mixedCaseCtx.request.headers['X-Role'], undefined);

  // root issuing a PAT with mismatched organizationId vs target employee org fails closed 403
  await assert.rejects(
    () => keyActions.issue(makeHttpCtx({
      method: 'POST',
      state: { currentUser: { id: 1, username: 'root-admin' }, currentRole: 'root' },
      params: { values: { name: 'RootMismatch', userId: 20, organizationId: 'org-b', roleName: 'ldx_employee', scopes: ['read'] } },
    }), async () => {}),
    (err) => err.status === 403 && err.code === 'NATIVE_ORGANIZATION_MISMATCH',
  );

  // root issuing a PAT without organizationId inherits employee organizationId cleanly
  const rootMatchCtx = makeHttpCtx({
    method: 'POST',
    state: { currentUser: { id: 1, username: 'root-admin' }, currentRole: 'root' },
    params: { values: { name: 'RootInheritedOrg', userId: 20, roleName: 'ldx_employee', scopes: ['read'] } },
  });
  await keyActions.issue(rootMatchCtx, async () => {});
  assert.equal(rootMatchCtx.body.organizationId, 'org-a');

  // Bearer ldx_pat_ does NOT override existing currentUser, while X-Lattice-API-Key DOES
  const preAuthBearer = makeHttpCtx({
    method: 'GET',
    state: { currentUser: { id: 10, username: 'org-admin' }, currentRole: 'ldx_admin' },
    headers: { authorization: `Bearer ${roToken}` },
  });
  await authMw(preAuthBearer, async () => {});
  assert.equal(preAuthBearer.state.currentUser.id, 10);
  assert.equal(preAuthBearer.state.latticeApiKey, undefined);

  const preAuthHeader = makeHttpCtx({
    method: 'GET',
    state: { currentUser: { id: 10, username: 'org-admin' }, currentRole: 'ldx_admin' },
    headers: { 'x-lattice-api-key': roToken },
  });
  await authMw(preAuthHeader, async () => {});
  assert.equal(preAuthHeader.state.currentUser.id, 20);
  assert.equal(preAuthHeader.state.currentRole, 'ldx_employee');

  // Authorization checks:
  // 1) Same-org non-owner (Charlie, userId 50, empId 500) denied 403 on dxosLedger:signDocument for order 1 (requester 200 / assignee 100)
  await assert.rejects(
    () => ledgerActions.signDocument(makeHttpCtx({
      method: 'POST',
      state: { currentUser: { id: 50, username: 'emp-charlie' }, currentRole: 'ldx_employee' },
      params: { values: { targetCollection: 'latticeOrders', targetRecordId: 1 } },
    }), async () => {}),
    (err) => err.status === 403 && err.code === 'LEDGER_SIGN_FORBIDDEN',
  );

  // 2) Same-org non-owner (Charlie) denied 403 on dxosApiKeys:revoke for Alice's key; cross-org (Bob) denied 404
  await assert.rejects(
    () => keyActions.revoke(makeHttpCtx({
      method: 'POST',
      state: { currentUser: { id: 50, username: 'emp-charlie' }, currentRole: 'ldx_employee' },
      params: { values: { id: roIssueCtx.body.id } },
    }), async () => {}),
    (err) => err.status === 403 && err.code === 'API_KEY_FORBIDDEN',
  );
  await assert.rejects(
    () => keyActions.revoke(makeHttpCtx({
      method: 'POST',
      state: { currentUser: { id: 30, username: 'emp-bob-orgb' }, currentRole: 'ldx_employee' },
      params: { values: { id: roIssueCtx.body.id } },
    }), async () => {}),
    (err) => err.status === 404 && err.code === 'API_KEY_NOT_FOUND',
  );

  // 3) Cross-org caller denied 403 NATIVE_ORGANIZATION_MISMATCH on dxosLedger read/verify actions
  for (const [actName, method, extra] of [
    ['publicKey', 'GET', {}],
    ['entries', 'GET', {}],
    ['status', 'GET', {}],
    ['verify', 'POST', {}],
    ['verifySignature', 'POST', { payload: { a: 1 }, signatureBase64: 'AAAA' }],
  ]) {
    await assert.rejects(
      () => ledgerActions[actName](makeHttpCtx({
        method,
        state: { currentUser: { id: 20, username: 'emp-alice' }, currentRole: 'ldx_employee' },
        params: { values: { organizationId: 'org-b', ...extra } },
      }), async () => {}),
      (err) => err.status === 403 && err.code === 'NATIVE_ORGANIZATION_MISMATCH',
      `Expected cross-org dxosLedger:${actName} to fail 403`,
    );
  }

  // 4) PAT scope enforcement on dxosLedger:signDocument (['read'] and ['wms'] denied 403; ['ledger'] succeeds)
  const wmsIssueCtx = makeHttpCtx({
    method: 'POST',
    state: { currentUser: { id: 20, username: 'emp-alice' }, currentRole: 'ldx_employee' },
    params: { values: { name: 'WMS Only Key', roleName: 'ldx_employee', scopes: ['wms'] } },
  });
  await keyActions.issue(wmsIssueCtx, async () => {});

  const ledgerIssueCtx = makeHttpCtx({
    method: 'POST',
    state: { currentUser: { id: 20, username: 'emp-alice' }, currentRole: 'ldx_employee' },
    params: { values: { name: 'Ledger Key', roleName: 'ldx_employee', scopes: ['ledger'] } },
  });
  await keyActions.issue(ledgerIssueCtx, async () => {});

  for (const deniedToken of [roToken, wmsIssueCtx.body.token]) {
    const deniedSignCtx = makeHttpCtx({
      method: 'POST',
      headers: { 'x-lattice-api-key': deniedToken },
      params: { resourceName: 'dxosLedger', actionName: 'signDocument', values: { targetCollection: 'latticeOrders', targetRecordId: 1 } },
    });
    await assert.rejects(
      () => authMw(deniedSignCtx, async () => ledgerActions.signDocument(deniedSignCtx, async () => {})),
      (err) => err.status === 403 && err.code === 'API_KEY_SCOPE_INSUFFICIENT',
    );
  }

  const allowedSignCtx = makeHttpCtx({
    method: 'POST',
    headers: { 'x-lattice-api-key': ledgerIssueCtx.body.token },
    params: { resourceName: 'dxosLedger', actionName: 'signDocument', values: { targetCollection: 'latticeOrders', targetRecordId: 1, reason: 'Ledger PAT sign' } },
  });
  await authMw(allowedSignCtx, async () => ledgerActions.signDocument(allowedSignCtx, async () => {}));
  assert.equal(allowedSignCtx.body.signed, true);

  await appendLedgerEntry(db, {
    organizationId: 'org-a',
    eventType: 'voucher.created',
    targetCollection: 'latticeOrders',
    targetRecordId: '99',
    actor: { userId: '10', username: 'org-admin' },
    payload: { id: 99 },
  });
  await appendLedgerEntry(db, {
    organizationId: 'org-a',
    eventType: 'voucher.submitted',
    targetCollection: 'latticeOrders',
    targetRecordId: '99',
    actor: { userId: '10', username: 'org-admin' },
    payload: { id: 99, status: 'submitted' },
  });

  const entriesCtx = makeHttpCtx({
    method: 'GET',
    state: { currentUser: { id: 20 }, currentRole: 'ldx_employee' },
    params: { page: 1, pageSize: 1, targetCollection: 'latticeOrders', targetRecordId: '99' },
  });
  await ledgerActions.entries(entriesCtx, async () => {});
  assert.equal(entriesCtx.body.total, 2);
  assert.equal(entriesCtx.body.items.length, 1);

  const verifyGetCtx = makeHttpCtx({
    method: 'GET',
    state: { currentUser: { id: 20 }, currentRole: 'ldx_employee' },
  });
  await ledgerActions.verify(verifyGetCtx, async () => {});
  assert.equal(verifyGetCtx.body.valid, true);

  // Seq continuity break detection (delete seq 1)
  const removed = ledgerEntries.shift();
  const seqGapReport = await verifyLedgerChain(db, 'org-a');
  assert.equal(seqGapReport.valid, false);
  assert.equal(seqGapReport.reason, 'SEQ_CONTINUITY_BROKEN');
  ledgerEntries.unshift(removed);

  // Missing latticeCryptoLedger repo is safe no-op for voucher-lifecycle and record-chatter
  const { db: noLedgerDb } = makeInMemoryPaasDb({ withLedgerRepo: false });
  const submitted = await submitVoucher(noLedgerDb, {
    collection: 'latticeOrders',
    id: 1,
    organizationId: 'org-a',
    actor: { userId: '20', employeeId: 200, username: 'emp-alice' },
    expectedVersion: 1,
  });
  assert.equal(submitted.status, 'submitted');
  const chatterRow = await recordChatterEntry(noLedgerDb, {
    organizationId: 'org-a',
    targetCollection: 'latticeOrders',
    targetRecordId: 1,
    body: 'Safe without ledger repo',
    authorName: 'emp-alice',
  });
  assert.ok(chatterRow);
});

test('runWithOrgMutex rejects failed appendLedgerEntry cleanly without UnhandledPromiseRejection or blocking later org appends', async () => {
  const { appendLedgerEntry, verifyLedgerChain } = require('../src/server/pki-ledger');
  const { db, ledgerEntries } = makeInMemoryPaasDb({ withLedgerRepo: true });

  const unhandled = [];
  const onUnhandled = (reason) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);

  const prevNodeEnv = process.env.NODE_ENV;
  const prevEncKey = process.env.ENCRYPTION_FIELD_KEY;
  const prevAppKey = process.env.APP_KEY;
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.ENCRYPTION_FIELD_KEY;
    delete process.env.APP_KEY;

    await assert.rejects(
      () => appendLedgerEntry(db, {
        organizationId: 'org-mutex-fail',
        eventType: 'voucher.submitted',
        targetCollection: 'latticeOrders',
        targetRecordId: '1',
        actor: { userId: '20', username: 'emp-alice' },
        payload: { id: 1 },
      }),
      (err) => err.code === 'PKI_MASTER_KEY_MISSING',
    );
  } finally {
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevNodeEnv;
    if (prevEncKey === undefined) delete process.env.ENCRYPTION_FIELD_KEY; else process.env.ENCRYPTION_FIELD_KEY = prevEncKey;
    if (prevAppKey === undefined) delete process.env.APP_KEY; else process.env.APP_KEY = prevAppKey;
  }

  // Wait a microtask/macrotask tick to confirm Node emits zero unhandledRejection events
  await new Promise((resolveTick) => setTimeout(resolveTick, 25));
  process.off('unhandledRejection', onUnhandled);
  assert.equal(unhandled.length, 0, `Unexpected unhandledRejection: ${unhandled.map((e) => e?.message || e).join('; ')}`);

  // Subsequent append for the exact same org must succeed cleanly without being wedged
  const recovered = await appendLedgerEntry(db, {
    organizationId: 'org-mutex-fail',
    eventType: 'voucher.submitted',
    targetCollection: 'latticeOrders',
    targetRecordId: '1',
    actor: { userId: '20', username: 'emp-alice' },
    payload: { id: 1, recovered: true },
  });
  assert.equal(Number(recovered.seq), 1);
  assert.equal(ledgerEntries.filter((e) => e.organizationId === 'org-mutex-fail').length, 1);
  const report = await verifyLedgerChain(db, 'org-mutex-fail');
  assert.equal(report.valid, true);
});

test('voucher-lifecycle and record-chatter skip minimal partial mocks, propagate security invariants, and isolate non-security PG failures in SAVEPOINT', async () => {
  const { submitVoucher } = require('../src/server/voucher-lifecycle');
  const { recordChatterEntry } = require('../src/server/record-chatter');
  const { ensureOrgSigningKey } = require('../src/server/pki-ledger');

  // 1. Minimal mock with latticeCryptoLedger but missing latticePkiKeys skips cleanly
  const baseNoPki = makeInMemoryPaasDb({ withLedgerRepo: true });
  const partialDb = {
    ...baseNoPki.db,
    getRepository(name) {
      if (name === 'latticePkiKeys') return null;
      return baseNoPki.db.getRepository(name);
    },
  };
  const subNoPki = await submitVoucher(partialDb, {
    collection: 'latticeOrders',
    id: 1,
    organizationId: 'org-a',
    actor: { userId: '20', employeeId: 200, username: 'emp-alice' },
    expectedVersion: 1,
  });
  assert.equal(subNoPki.status, 'submitted');
  assert.equal(baseNoPki.ledgerEntries.length, 0);

  // 2. Security invariants (PKI_MASTER_KEY_MISSING, PKI_KEY_INACTIVE, PKI_CIPHERTEXT_INVALID) propagate instead of being swallowed
  const invHarness = makeInMemoryPaasDb({ withLedgerRepo: true });
  const prevNodeEnv = process.env.NODE_ENV;
  const prevEncKey = process.env.ENCRYPTION_FIELD_KEY;
  const prevAppKey = process.env.APP_KEY;
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.ENCRYPTION_FIELD_KEY;
    delete process.env.APP_KEY;

    await assert.rejects(
      () => recordChatterEntry(invHarness.db, {
        organizationId: 'org-a',
        targetCollection: 'latticeOrders',
        targetRecordId: 1,
        body: 'Must propagate PKI_MASTER_KEY_MISSING',
        authorName: 'emp-alice',
      }),
      (err) => err.code === 'PKI_MASTER_KEY_MISSING',
    );
    await assert.rejects(
      () => submitVoucher(invHarness.db, {
        collection: 'latticeOrders',
        id: 1,
        organizationId: 'org-a',
        actor: { userId: '20', employeeId: 200, username: 'emp-alice' },
        expectedVersion: 1,
      }),
      (err) => err.code === 'PKI_MASTER_KEY_MISSING',
    );
  } finally {
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevNodeEnv;
    if (prevEncKey === undefined) delete process.env.ENCRYPTION_FIELD_KEY; else process.env.ENCRYPTION_FIELD_KEY = prevEncKey;
    if (prevAppKey === undefined) delete process.env.APP_KEY; else process.env.APP_KEY = prevAppKey;
  }

  // PKI_KEY_INACTIVE propagates from recordChatterEntry and submitVoucher
  const inactiveHarness = makeInMemoryPaasDb({ withLedgerRepo: true });
  await ensureOrgSigningKey(inactiveHarness.db, 'org-a');
  inactiveHarness.pkiKeys[0].active = false;
  await assert.rejects(
    () => recordChatterEntry(inactiveHarness.db, {
      organizationId: 'org-a',
      targetCollection: 'latticeOrders',
      targetRecordId: 1,
      body: 'Inactive key must propagate',
      authorName: 'emp-alice',
    }),
    (err) => err.code === 'PKI_KEY_INACTIVE',
  );
  inactiveHarness.pkiKeys[0].active = true;
  inactiveHarness.pkiKeys[0].encryptedPrivateKey = 'corrupted';
  await assert.rejects(
    () => recordChatterEntry(inactiveHarness.db, {
      organizationId: 'org-a',
      targetCollection: 'latticeOrders',
      targetRecordId: 1,
      body: 'Corrupt key must propagate',
      authorName: 'emp-alice',
    }),
    (err) => err.code === 'PKI_CIPHERTEXT_INVALID',
  );

  // 3. Non-security error inside recordChatterEntry with caller PG transaction uses SAVEPOINT + ROLLBACK TO SAVEPOINT + logger
  const pgHarness = makeInMemoryPaasDb({ dialect: 'postgres', withLedgerRepo: true });
  const loggedErrors = [];
  const origLedgerRepo = pgHarness.db.getRepository('latticeCryptoLedger');
  const pgFailDb = {
    ...pgHarness.db,
    logger: {
      error: (msg, err) => loggedErrors.push({ msg, err }),
    },
    getRepository(name) {
      if (name === 'latticeCryptoLedger') {
        return {
          ...origLedgerRepo,
          create: async () => {
            throw new Error('simulated transient PG ledger failure');
          },
        };
      }
      return pgHarness.db.getRepository(name);
    },
  };
  const callerTx = { id: 'tx-caller-pg' };
  const row = await recordChatterEntry(
    pgFailDb,
    {
      organizationId: 'org-a',
      targetCollection: 'latticeOrders',
      targetRecordId: 1,
      body: 'Savepoint protects outer PG tx',
      authorName: 'emp-alice',
    },
    { transaction: callerTx },
  );
  assert.ok(row);
  assert.equal(loggedErrors.length, 1);
  assert.match(loggedErrors[0].err.message, /simulated transient PG ledger failure/);
  const sqlList = pgHarness.sqlQueries.map((q) => q.sql);
  assert.ok(sqlList.some((s) => /^SAVEPOINT sp_dxos_ledger_\d+$/.test(s)));
  assert.ok(sqlList.some((s) => /^ROLLBACK TO SAVEPOINT sp_dxos_ledger_\d+$/.test(s)));
  assert.equal(pgHarness.sqlQueries.every((q) => q.opts?.transaction === callerTx), true);
});
