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
const net = require('node:net');
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

function makeInMemoryVaultEventDb({ dialect = 'postgres', withEmployeesForRoot = false } = {}) {
  const seqs = {
    connectors: 0,
    events: 0,
    subs: 0,
    deliveries: 0,
    apiKeys: 0,
    orders: 10,
    chatter: 0,
    notifs: 0,
  };
  const users = [
    { id: 1, username: 'root-admin', active: true },
    { id: 10, username: 'org-a-admin', active: true },
    { id: 20, username: 'org-a-emp', active: true },
    { id: 30, username: 'org-b-admin', active: true },
  ];
  const roles = [
    { name: 'root', allowAll: true, allowConfigure: true, snippets: ['pm', 'pm.*'] },
    { name: 'ldx_admin', allowConfigure: true, snippets: ['pm.*'] },
    { name: 'ldx_employee', allowConfigure: false, snippets: [] },
  ];
  const rolesUsers = [
    { userId: 1, roleName: 'root' },
    { userId: 10, roleName: 'ldx_admin' },
    { userId: 20, roleName: 'ldx_employee' },
    { userId: 30, roleName: 'ldx_admin' },
  ];
  const employees = [
    ...(withEmployeesForRoot ? [{ id: 1, userId: 1, organizationId: 'org-a', departmentId: 1, active: true, code: 'ROOT', name: 'Root' }] : []),
    { id: 100, userId: 10, organizationId: 'org-a', departmentId: 1, active: true, code: 'ADM-A', name: 'Admin A' },
    { id: 200, userId: 20, organizationId: 'org-a', departmentId: 1, active: true, code: 'EMP-A', name: 'Emp A' },
    { id: 300, userId: 30, organizationId: 'org-b', departmentId: 2, active: true, code: 'ADM-B', name: 'Admin B' },
  ];
  const connectors = [];
  const events = [];
  const subscriptions = [];
  const deliveries = [];
  const apiKeys = [];
  const orders = [
    {
      id: 1,
      organizationId: 'org-a',
      code: 'ORD-V1',
      name: 'Cold Chain Voucher',
      requesterId: 200,
      status: 'draft',
      version: 1,
      amendmentNo: 0,
      amendedFromId: null,
    },
  ];
  const chatter = [];
  const notifications = [];
  const sqlCalls = [];

  const match = (row, filter = {}) => Object.entries(filter || {}).every(([k, cond]) => {
    if (k === '$and' && Array.isArray(cond)) return cond.every((sub) => match(row, sub));
    if (k === '$or' && Array.isArray(cond)) return cond.some((sub) => match(row, sub));
    if (cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)) {
      if (Array.isArray(cond.$in)) return cond.$in.includes(row[k]);
      if (Object.hasOwn(cond, '$eq')) return row[k] === cond.$eq;
      if (Object.hasOwn(cond, '$ne')) return row[k] !== cond.$ne;
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

  const wrap = (row) => (row ? {
    ...row,
    toJSON: () => ({ ...row }),
    get: (k) => row[k],
    update: async (patch) => {
      Object.assign(row, patch, { updatedAt: new Date().toISOString() });
      return wrap(row);
    },
    destroy: async () => 1,
  } : null);

  const makeRepo = (collectionName, list, counterKey) => ({
    find: async ({ filter, sort, offset = 0, limit = 100 } = {}) => {
      const filtered = list.filter((r) => match(r, filter));
      return sortRows(filtered, sort).slice(offset, offset + limit).map(wrap);
    },
    findOne: async ({ filter, filterByTk, sort } = {}) => {
      if (filterByTk != null && !filter) {
        return wrap(list.find((r) => Number(r.id) === Number(filterByTk)));
      }
      const filtered = sortRows(list.filter((r) => match(r, filter)), sort);
      return wrap(filtered[0] || null);
    },
    count: async ({ filter } = {}) => list.filter((r) => match(r, filter)).length,
    create: async ({ values }) => {
      if (collectionName === 'latticeConnectors' && list.some((c) => c.organizationId === values.organizationId && c.connectorKey === values.connectorKey)) {
        throw Object.assign(new Error('Unique violation on connectorKey'), { name: 'SequelizeUniqueConstraintError' });
      }
      if (collectionName === 'latticeWebhookSubscriptions' && list.some((s) => s.organizationId === values.organizationId && s.subscriptionKey === values.subscriptionKey)) {
        throw Object.assign(new Error('Unique violation on subscriptionKey'), { name: 'SequelizeUniqueConstraintError' });
      }
      if (collectionName === 'latticeEventBus' && list.some((e) => e.eventId === values.eventId)) {
        throw Object.assign(new Error('Unique violation on eventId'), { name: 'SequelizeUniqueConstraintError' });
      }
      const row = {
        id: ++seqs[counterKey],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...values,
      };
      list.push(row);
      return wrap(row);
    },
    update: async ({ filterByTk, filter, values } = {}) => {
      const targets = list.filter((r) => (filterByTk != null ? Number(r.id) === Number(filterByTk) : true) && (!filter || match(r, filter)));
      for (const t of targets) {
        Object.assign(t, values, { updatedAt: new Date().toISOString() });
      }
      return targets.map(wrap);
    },
    destroy: async ({ filter } = {}) => {
      let removed = 0;
      for (let i = list.length - 1; i >= 0; i -= 1) {
        if (!filter || match(list[i], filter)) {
          list.splice(i, 1);
          removed += 1;
        }
      }
      return removed;
    },
  });

  const fakeTx = { id: 'tx-vault-events', LOCK: { UPDATE: 'UPDATE' } };
  const db = {
    sequelize: {
      getDialect: () => dialect,
      transaction: async (cb) => cb(fakeTx),
      query: async (sql, opts) => {
        sqlCalls.push({ sql, opts });
        return [[]];
      },
    },
    getModel(name) {
      if (name === 'latticeOrders') {
        return { findOne: async ({ where }) => orders.find((r) => match(r, where)) || null };
      }
      return null;
    },
    getRepository(name) {
      if (name === 'users') return makeRepo('users', users, 'orders');
      if (name === 'roles') return makeRepo('roles', roles, 'orders');
      if (name === 'rolesUsers') return makeRepo('rolesUsers', rolesUsers, 'orders');
      if (name === 'latticeEmployees') return makeRepo('latticeEmployees', employees, 'orders');
      if (name === 'latticeConnectors') return makeRepo('latticeConnectors', connectors, 'connectors');
      if (name === 'latticeEventBus') return makeRepo('latticeEventBus', events, 'events');
      if (name === 'latticeWebhookSubscriptions') return makeRepo('latticeWebhookSubscriptions', subscriptions, 'subs');
      if (name === 'latticeWebhookDeliveries') return makeRepo('latticeWebhookDeliveries', deliveries, 'deliveries');
      if (name === 'latticeApiKeys') return makeRepo('latticeApiKeys', apiKeys, 'apiKeys');
      if (name === 'latticeOrders') return makeRepo('latticeOrders', orders, 'orders');
      if (name === 'latticeRecordChatter') return makeRepo('latticeRecordChatter', chatter, 'chatter');
      if (name === 'latticeNotifications') return makeRepo('latticeNotifications', notifications, 'notifs');
      return null;
    },
  };

  return { db, connectors, events, subscriptions, deliveries, apiKeys, orders, notifications, sqlCalls };
}

function makeHttpCtx({ method = 'GET', path = '', state = {}, headers = {}, params = {}, query = {}, body = undefined } = {}) {
  const resHeaders = {};
  return {
    method,
    path,
    headers: { ...headers },
    request: { path, headers: { ...headers }, ...(body !== undefined ? { body } : {}) },
    response: { headers: resHeaders },
    query,
    state: { ...state },
    action: { resourceName: params.resourceName || '', actionName: params.actionName || '', params },
    get(k) { return this.headers[String(k).toLowerCase()] || ''; },
    set(k, v) { this.response.headers[k] = v; },
    throw(status, message, props) { throw Object.assign(new Error(message || `HTTP ${status}`), { status }, props || {}); },
  };
}

test('Task A.2 collections, migration 20261125000100, and 42-table pg-rls define clean schema, named indexes, and reversible RLS DDL', async () => {
  await withMockedNocobase(async () => {
    const connCol = require('../src/server/collections/connectors');
    const eventCol = require('../src/server/collections/event-bus');
    const subCol = require('../src/server/collections/webhook-subscriptions');
    const delCol = require('../src/server/collections/webhook-deliveries');

    assert.equal(connCol.name, 'latticeConnectors');
    assert.deepEqual(connCol.migrationRules, ['schema-only']);
    assert.ok(connCol.indexes.some((i) => i.name === 'uidx_lattice_connectors_org_key' && i.unique === true));

    assert.equal(eventCol.name, 'latticeEventBus');
    assert.deepEqual(eventCol.migrationRules, ['schema-only']);
    assert.ok(eventCol.fields.some((f) => f.name === 'payloadJson' && f.type === 'jsonb'));
    assert.ok(eventCol.indexes.some((i) => i.name === 'uidx_lattice_events_event_id' && i.unique === true));
    assert.ok(eventCol.indexes.some((i) => i.name === 'idx_lattice_events_org_occurred'));

    assert.equal(subCol.name, 'latticeWebhookSubscriptions');
    assert.deepEqual(subCol.migrationRules, ['schema-only']);
    assert.ok(subCol.indexes.some((i) => i.name === 'uidx_lattice_wh_sub_org_key' && i.unique === true));

    assert.equal(delCol.name, 'latticeWebhookDeliveries');
    assert.deepEqual(delCol.migrationRules, ['schema-only']);
    assert.ok(delCol.indexes.some((i) => i.name === 'idx_lattice_wh_del_status_next'));
    assert.ok(delCol.indexes.some((i) => i.name === 'idx_lattice_wh_del_org_status'));

    const pgRls = require('../src/server/pg-rls');
    assert.ok(pgRls.TENANT_RLS_TABLES.length >= 54, `Expected >= 54 RLS tables, got ${pgRls.TENANT_RLS_TABLES.length}`);
    for (const tbl of [
      'latticeConnectors',
      'latticeEventBus',
      'latticeWebhookSubscriptions',
      'latticeWebhookDeliveries',
      'latticeIotDevices',
      'latticeBrokerSubscriptions',
      'latticeAutomationRules',
      'latticeAutomationRuns',
      'latticeBuiltApps',
    ]) {
      assert.ok(pgRls.TENANT_RLS_TABLES.includes(tbl), `Missing 43-table RLS entry ${tbl}`);
    }

    const Migration = require('../src/server/migrations/20261125000100-connectors-events-webhooks');
    const sqlCalls = [];
    const rlsAttached = [];
    const fakeTx = { id: 'tx-20261125' };
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
    assert.match(upSql, /CREATE TABLE IF NOT EXISTS "latticeConnectors"/);
    assert.match(upSql, /CREATE TABLE IF NOT EXISTS "latticeEventBus"/);
    assert.match(upSql, /CREATE TABLE IF NOT EXISTS "latticeWebhookSubscriptions"/);
    assert.match(upSql, /CREATE TABLE IF NOT EXISTS "latticeWebhookDeliveries"/);
    assert.match(upSql, /CREATE UNIQUE INDEX IF NOT EXISTS uidx_lattice_connectors_org_key/);
    assert.match(upSql, /CREATE UNIQUE INDEX IF NOT EXISTS uidx_lattice_events_event_id/);
    assert.match(upSql, /CREATE UNIQUE INDEX IF NOT EXISTS uidx_lattice_wh_sub_org_key/);
    assert.equal(/\bUNIQUE\b/i.test(upSql.replace(/CREATE UNIQUE INDEX/gi, '')), false);
    assert.deepEqual(rlsAttached.map((r) => r.tableName), [
      'latticeConnectors',
      'latticeEventBus',
      'latticeWebhookSubscriptions',
      'latticeWebhookDeliveries',
    ]);
    assert.equal(rlsAttached.every((r) => r.opts?.transaction === fakeTx), true);

    sqlCalls.length = 0;
    await migration.down();
    const downSql = sqlCalls.map((x) => x.sql).join('\n');
    assert.match(downSql, /DROP POLICY IF EXISTS lattice_tenant_isolation ON public\."latticeWebhookDeliveries"/);
    assert.match(downSql, /DROP TABLE IF EXISTS "latticeWebhookDeliveries"/);
    assert.match(downSql, /DROP TABLE IF EXISTS "latticeWebhookSubscriptions"/);
    assert.match(downSql, /DROP TABLE IF EXISTS "latticeEventBus"/);
    assert.match(downSql, /DROP TABLE IF EXISTS "latticeConnectors"/);
  });
});

test('connector-vault enforces AES-256-GCM encryption, production fail-closed key check, SSRF rules, secret masking, and dxosVault CRUD + testConnection', async () => {
  const {
    encryptVaultSecrets,
    decryptVaultSecrets,
    assertSafeConnectorUrl,
    resolveConnectorSecrets,
    registerConnectorVault,
    defaultTcpProbe,
  } = require('../src/server/connector-vault');

  // 1. AES-256-GCM encryption/decryption & fail-closed in production
  const prodEnv = { NODE_ENV: 'production' };
  assert.throws(
    () => encryptVaultSecrets({ apiKey: 'secret-1' }, prodEnv),
    (err) => err.code === 'VAULT_MASTER_KEY_MISSING' && err.status === 500,
  );

  const keyEnv = { NODE_ENV: 'production', DX_VAULT_MASTER_KEY: 'vault-master-secret-32' };
  const ciphertext = encryptVaultSecrets({ token: 'tok-xyz', headerName: 'X-Custom' }, keyEnv);
  assert.equal(ciphertext.includes('tok-xyz'), false);
  assert.equal(ciphertext.split(':').length, 3);
  assert.deepEqual(decryptVaultSecrets(ciphertext, keyEnv), { token: 'tok-xyz', headerName: 'X-Custom' });

  // Tampered ciphertext rejected
  const parts = ciphertext.split(':');
  const tampered = `${parts[0]}:${parts[1]}:${'ff'.repeat(Math.max(1, parts[2].length / 2))}`;
  assert.throws(
    () => decryptVaultSecrets(tampered, keyEnv),
    (err) => err.code === 'VAULT_CIPHERTEXT_INVALID',
  );

  // 2. SSRF protection + internal docker compose allowlist
  for (const unsafeUrl of [
    'file:///etc/passwd',
    'ftp://files.example.com/data',
    'gopher://127.0.0.1:6379/_INFO',
    'http://169.254.169.254/latest/meta-data/',
    'http://0.0.0.0:8080/hook',
    'http://[::1]:8080/hook',
    'http://10.0.0.12:5678/webhook',
    'http://172.16.0.5/hook',
    'http://192.168.1.50/hook',
    'http://redis:6379/',
    'https://user:pass@hooks.example.com/hook',
  ]) {
    assert.throws(
      () => assertSafeConnectorUrl(unsafeUrl),
      (err) => err.code === 'CONNECTOR_URL_UNSAFE' && err.status === 400,
      `Expected SSRF block for ${unsafeUrl}`,
    );
  }

  for (const safeUrl of [
    'http://n8n:5678/webhook/coldchain',
    'http://orion-ld:1026/ngsi-ld/v1/entities',
    'http://nodered:1880/health',
    'https://hooks.example.org/events',
  ]) {
    assert.ok(assertSafeConnectorUrl(safeUrl), `Expected allowlisted/safe URL ${safeUrl}`);
  }
  assert.ok(assertSafeConnectorUrl('mqtt://mosquitto:1883', { connectorType: 'mqtt' }));
  for (const loopbackUrl of [
    'http://localhost:5678/webhook-test',
    'http://127.0.0.1:8088/hook',
  ]) {
    assert.throws(
      () => assertSafeConnectorUrl(loopbackUrl),
      (err) => err.code === 'CONNECTOR_URL_UNSAFE' && err.status === 400,
      `Expected loopback SSRF block for ${loopbackUrl}`,
    );
  }

  // 3. Spin up real ephemeral local TCP server to verify genuine node:net MQTT probe
  const tcpServer = net.createServer((sock) => sock.end());
  await new Promise((resolveListen) => tcpServer.listen(0, '127.0.0.1', resolveListen));
  const tcpPort = tcpServer.address().port;

  try {
    const { db, connectors } = makeInMemoryVaultEventDb();
    const resources = new Map();
    const middlewares = [];
    const fetchCalls = [];
    const app = {
      db,
      resourceManager: {
        define(def) { resources.set(def.name, def.actions); },
        use(fn, opts) { middlewares.push({ fn, opts }); },
      },
      acl: { allow() {} },
    };

    registerConnectorVault(app, {
      env: { DX_VAULT_MASTER_KEY: 'test-vault-key-2026' },
      tcpProbeImpl: (host, port, timeoutMs) => defaultTcpProbe(host === 'mosquitto' ? '127.0.0.1' : host, port, timeoutMs),
      fetchImpl: async (url, init) => {
        fetchCalls.push({ url, method: init?.method, headers: init?.headers, redirect: init?.redirect, hasSignal: Boolean(init?.signal) });
        if (init?.method === 'HEAD') return { ok: false, status: 405, body: { cancel: async () => {} } };
        return { ok: true, status: 200, body: { cancel: async () => {} } };
      },
    });

    const vault = resources.get('dxosVault');
    assert.ok(vault?.list && vault?.save && vault?.rotateSecret && vault?.delete && vault?.testConnection);

    // Employee denied save/rotateSecret/delete/testConnection 403
    await assert.rejects(
      () => vault.save(makeHttpCtx({
        method: 'POST',
        state: { currentUser: { id: 20 }, currentRole: 'ldx_employee' },
        params: { values: { connectorKey: 'n8n-main', name: 'n8n', connectorType: 'n8n', baseUrl: 'http://n8n:5678' } },
      }), async () => {}),
      (err) => err.status === 403 && err.code === 'VAULT_ADMIN_REQUIRED',
    );

    // Admin saves n8n connector with bearer secret -> response masks secrets completely
    const saveCtx = makeHttpCtx({
      method: 'POST',
      state: { currentUser: { id: 10, username: 'org-a-admin' }, currentRole: 'ldx_admin' },
      params: {
        values: {
          connectorKey: 'n8n-prod',
          name: 'n8n Orchestrator',
          connectorType: 'n8n',
          baseUrl: 'http://n8n:5678',
          authType: 'bearer',
          secrets: { token: 'super-secret-n8n-token', workspace: 'coldchain' },
        },
      },
    });
    await vault.save(saveCtx, async () => {});
    assert.equal(saveCtx.body.connectorKey, 'n8n-prod');
    assert.equal(saveCtx.body.hasSecrets, true);
    assert.deepEqual(saveCtx.body.secretKeys, ['token', 'workspace']);
    assert.equal(saveCtx.body.secretVersion, 1);
    assert.equal(saveCtx.body.encryptedSecretsJson, undefined);
    assert.equal(saveCtx.body.secrets, undefined);
    assert.equal(connectors[0].encryptedSecretsJson.includes('super-secret-n8n-token'), false);

    // List denied for non-admin employee (403 VAULT_ADMIN_REQUIRED) and allowed with masked secrets for admin
    await assert.rejects(
      () => vault.list(makeHttpCtx({
        method: 'GET',
        state: { currentUser: { id: 20 }, currentRole: 'ldx_employee' },
      }), async () => {}),
      (err) => err.status === 403 && err.code === 'VAULT_ADMIN_REQUIRED',
    );
    const listCtx = makeHttpCtx({
      method: 'GET',
      state: { currentUser: { id: 10 }, currentRole: 'ldx_admin' },
    });
    await vault.list(listCtx, async () => {});
    assert.equal(listCtx.body.items.length, 1);
    assert.equal(listCtx.body.items[0].hasSecrets, true);
    assert.equal(listCtx.body.items[0].decryptionError, false);
    assert.equal(listCtx.body.items[0].encryptedSecretsJson, undefined);

    // Internal resolveConnectorSecrets decrypts for server consumers and blocks cross-org
    const resolved = await resolveConnectorSecrets(db, 'org-a', 'n8n-prod', { env: { DX_VAULT_MASTER_KEY: 'test-vault-key-2026' } });
    assert.equal(resolved.secrets.token, 'super-secret-n8n-token');
    await assert.rejects(
      () => resolveConnectorSecrets(db, 'org-b', 'n8n-prod', { env: { DX_VAULT_MASTER_KEY: 'test-vault-key-2026' } }),
      (err) => err.status === 404,
    );

    // Rotate secret increments secretVersion -> 2
    const rotCtx = makeHttpCtx({
      method: 'POST',
      state: { currentUser: { id: 10 }, currentRole: 'ldx_admin' },
      params: { values: { connectorKey: 'n8n-prod', secrets: { token: 'rotated-token-v2' } } },
    });
    await vault.rotateSecret(rotCtx, async () => {});
    assert.equal(rotCtx.body.secretVersion, 2);
    assert.deepEqual(rotCtx.body.secretKeys, ['token']);
    assert.equal(rotCtx.body.encryptedSecretsJson, undefined);

    // testConnection on HTTP connector sends auth header internally, masks response, updates lastTestedAt
    const testHttpCtx = makeHttpCtx({
      method: 'POST',
      state: { currentUser: { id: 10 }, currentRole: 'ldx_admin' },
      params: { values: { connectorKey: 'n8n-prod' } },
    });
    await vault.testConnection(testHttpCtx, async () => {});
    assert.equal(testHttpCtx.body.ok, true);
    assert.equal(testHttpCtx.body.statusCode, 200);
    assert.equal(testHttpCtx.body.lastTestStatus, 'ok');
    assert.equal(fetchCalls[0].url, 'http://n8n:5678/healthz');
    assert.equal(fetchCalls[0].headers.Authorization, 'Bearer rotated-token-v2');
    assert.equal(fetchCalls[0].redirect, 'error');
    assert.equal(JSON.stringify(testHttpCtx.body).includes('rotated-token-v2'), false);

    // Real TCP handshake test for mqtt connector
    await vault.save(makeHttpCtx({
      method: 'POST',
      state: { currentUser: { id: 10 }, currentRole: 'ldx_admin' },
      params: {
        values: {
          connectorKey: 'mqtt-local',
          name: 'Local Mosquitto',
          connectorType: 'mqtt',
          baseUrl: `mqtt://mosquitto:${tcpPort}`,
          authType: 'basic',
          secrets: { username: 'edge', password: 'pw' },
        },
      },
    }), async () => {});
    const testMqttCtx = makeHttpCtx({
      method: 'POST',
      state: { currentUser: { id: 10 }, currentRole: 'ldx_admin' },
      params: { values: { connectorKey: 'mqtt-local' } },
    });
    await vault.testConnection(testMqttCtx, async () => {});
    assert.equal(testMqttCtx.body.ok, true);
    assert.equal(testMqttCtx.body.lastTestStatus, 'ok');

    // Delete connector
    const delCtx = makeHttpCtx({
      method: 'POST',
      state: { currentUser: { id: 10 }, currentRole: 'ldx_admin' },
      params: { values: { connectorKey: 'mqtt-local' } },
    });
    await vault.delete(delCtx, async () => {});
    assert.equal(delCtx.body.deleted, true);
    assert.equal(connectors.length, 1);
  } finally {
    await new Promise((resolveClose) => tcpServer.close(resolveClose));
  }
});

test('event-bus emits CloudEvents 1.0, signs/verifies Standard Webhooks HMAC, handles backoff, Circuit Breaker, DLQ replay, and SKIP LOCKED', async () => {
  const {
    signStandardWebhookPayload,
    verifyStandardWebhookSignature,
    registerEventBusListener,
    matchesEventPattern,
    computeWebhookBackoffMs,
    publishDomainEvent,
    dispatchDueWebhookDeliveries,
    registerEventBus,
  } = require('../src/server/event-bus');

  // 1. Pattern matching & backoff calculation
  assert.equal(matchesEventPattern('*', 'alarm.raised'), true);
  assert.equal(matchesEventPattern('alarm.*', 'alarm.raised'), true);
  assert.equal(matchesEventPattern('alarm.*', 'alarmed.raised'), false);
  assert.equal(matchesEventPattern('voucher.submitted', 'voucher.submitted'), true);
  assert.equal(matchesEventPattern('voucher.submitted', 'voucher.cancelled'), false);

  const b1 = computeWebhookBackoffMs(1, { baseMs: 5000, jitterRatio: 0 });
  const b2 = computeWebhookBackoffMs(2, { baseMs: 5000, jitterRatio: 0 });
  const b20 = computeWebhookBackoffMs(20, { baseMs: 5000, jitterRatio: 0.25, randomFn: () => 0.9 });
  assert.equal(b1, 10_000);
  assert.equal(b2, 20_000);
  assert.equal(b20, 3_600_000);

  // 2. Standard Webhooks signing & verification with replay tolerance
  const nowSec = 1763900000;
  const sig = signStandardWebhookPayload({
    webhookId: 'msg_123',
    timestamp: String(nowSec),
    body: '{"ok":true}',
    secret: 'whsec_test_secret',
  });
  assert.match(sig, /^v1,[A-Za-z0-9+/=]+$/);
  assert.equal(verifyStandardWebhookSignature({
    webhookId: 'msg_123',
    timestamp: String(nowSec),
    body: '{"ok":true}',
    signature: `v1,invalidBase64== ${sig}`,
    secret: 'whsec_test_secret',
    toleranceSec: 300,
    nowMs: (nowSec + 120) * 1000,
  }), true);
  assert.equal(verifyStandardWebhookSignature({
    webhookId: 'msg_123',
    timestamp: String(nowSec),
    body: '{"ok":false}',
    signature: sig,
    secret: 'whsec_test_secret',
    toleranceSec: 300,
    nowMs: nowSec * 1000,
  }), false);
  assert.equal(verifyStandardWebhookSignature({
    webhookId: 'msg_123',
    timestamp: String(nowSec),
    body: '{"ok":true}',
    signature: sig,
    secret: 'whsec_test_secret',
    toleranceSec: 300,
    nowMs: (nowSec + 301) * 1000,
  }), false);

  // 3. Publish CloudEvent, fan out matching subscriptions, invoke listener & PubSub
  const { db, events, subscriptions, deliveries, sqlCalls } = makeInMemoryVaultEventDb({ dialect: 'postgres' });
  const resources = new Map();
  const pubSubMessages = [];
  const app = {
    db,
    resourceManager: { define(def) { resources.set(def.name, def.actions); }, use() {} },
    acl: { allow() {} },
    pubSubManager: { publish: async (channel, payload) => { pubSubMessages.push({ channel, payload }); } },
    logger: { error() {}, warn() {}, info() {} },
  };
  let nextHttpStatus = 200;
  const outboundCalls = [];
  const busApi = registerEventBus(app, {
    startDrainer: false,
    env: { DX_VAULT_MASTER_KEY: 'event-bus-key' },
    fetchImpl: async (url, init) => {
      outboundCalls.push({ url, init });
      return { ok: nextHttpStatus >= 200 && nextHttpStatus < 300, status: nextHttpStatus, body: { cancel: async () => {} } };
    },
  });

  const dxosEvents = resources.get('dxosEvents');
  assert.ok(dxosEvents?.publish && dxosEvents?.saveSubscription && dxosEvents?.dispatchNow && dxosEvents?.replayDlq && dxosEvents?.resetCircuit);

  // Create matching subscription (alarm.*) and non-matching subscription (device.*)
  const subSaveCtx = makeHttpCtx({
    method: 'POST',
    state: { currentUser: { id: 10 }, currentRole: 'ldx_admin' },
    params: {
      values: {
        subscriptionKey: 'n8n-alarms',
        name: 'n8n Alarm Hook',
        targetUrl: 'http://n8n:5678/webhook/alarms',
        eventPattern: 'alarm.*',
        signingSecret: 'my-hmac-key',
      },
    },
  });
  await dxosEvents.saveSubscription(subSaveCtx, async () => {});
  assert.equal(subSaveCtx.body.hasSigningSecret, true);
  assert.equal(subSaveCtx.body.encryptedSigningSecret, undefined);
  assert.equal(subSaveCtx.body.signingSecret, undefined);

  await dxosEvents.saveSubscription(makeHttpCtx({
    method: 'POST',
    state: { currentUser: { id: 10 }, currentRole: 'ldx_admin' },
    params: {
      values: {
        subscriptionKey: 'device-hook',
        name: 'Device Hook',
        targetUrl: 'https://hooks.example.com/devices',
        eventPattern: 'device.*',
      },
    },
  }), async () => {});

  const receivedByListener = [];
  const unsubOk = registerEventBusListener(async (ev) => { receivedByListener.push(ev); });
  const unsubErr = registerEventBusListener(async () => { throw new Error('listener boom'); });

  try {
    const pubRes = await publishDomainEvent(db, {
      organizationId: 'org-a',
      type: 'alarm.raised',
      source: 'latticedx/telemetry',
      subject: 'asset:12',
      correlationId: 'corr-1',
      causationId: 'cause-0',
      depth: 1,
      data: { temp: 12.5 },
      app,
    });
    assert.equal(pubRes.event.specversion, '1.0');
    assert.equal(pubRes.event.type, 'alarm.raised');
    assert.equal(pubRes.event.organizationid, 'org-a');
    assert.equal(pubRes.event.correlationid, 'corr-1');
    assert.equal(pubRes.event.causationid, 'cause-0');
    assert.equal(pubRes.event.depth, 1);
    assert.equal(pubRes.deliveriesQueued, 1);
    assert.equal(events.length, 1);
    assert.equal(deliveries.length, 1);
    assert.equal(receivedByListener.length, 1);
    assert.equal(pubSubMessages.length, 1);
    assert.equal(pubSubMessages[0].channel, 'latticedx:surface-updates');

    // Cross-plugin compatibility: app.latticeEvents.publishDomainEvent(event, opts) and publishDomainEvent(db, event, opts) with eventType alias
    const boundRes = await busApi.publishDomainEvent({ organizationId: 'org-a', eventType: 'alarm.bound_check', data: { x: 1 } }, {});
    assert.equal(boundRes.event.type, 'alarm.bound_check');
    const direct3ArgRes = await publishDomainEvent(db, { organizationId: 'org-a', eventType: 'alarm.direct3_check', data: { x: 2 } }, {});
    assert.equal(direct3ArgRes.event.type, 'alarm.direct3_check');
    // Remove extra rows before circuit/DLQ sequence check below
    events.splice(1);
    deliveries.splice(1);

    // Dispatch delivery -> verifies FOR UPDATE OF d SKIP LOCKED SQL + Standard Webhooks headers
    const t0Ms = Date.now() + 5000;
    const dispRes = await dispatchDueWebhookDeliveries(db, {
      organizationId: 'org-a',
      now: new Date(t0Ms),
      env: { DX_VAULT_MASTER_KEY: 'event-bus-key' },
      fetchImpl: async (url, init) => {
        outboundCalls.push({ url, init });
        return { ok: true, status: 202, body: { cancel: async () => {} } };
      },
    });
    assert.equal(dispRes.deliveredCount, 1);
    assert.ok(sqlCalls.some((q) => /FOR UPDATE OF d SKIP LOCKED/.test(q.sql)));
    assert.equal(deliveries[0].status, 'delivered');
    assert.equal(events[0].status, 'dispatched');

    const sentHeaders = outboundCalls[0].init.headers;
    assert.equal(outboundCalls[0].init.redirect, 'error');
    assert.ok(outboundCalls[0].init.signal);
    assert.equal(verifyStandardWebhookSignature({
      webhookId: sentHeaders['webhook-id'],
      timestamp: sentHeaders['webhook-timestamp'],
      body: outboundCalls[0].init.body,
      signature: sentHeaders['webhook-signature'],
      secret: 'my-hmac-key',
      nowMs: t0Ms,
    }), true);

    // 4. Circuit Breaker + DLQ + Replay
    const baseMs = t0Ms + 60_000;
    await publishDomainEvent(db, {
      organizationId: 'org-a',
      type: 'alarm.critical',
      data: { temp: 20 },
    });
    const failingDel = deliveries[1];
    nextHttpStatus = 503;

    // Fail 5 attempts to reach maxAttempts=5 (DLQ) and failureCount=5 (open circuit for 120s)
    for (let i = 0; i < 5; i += 1) {
      failingDel.nextAttemptAt = new Date(baseMs + i * 1000).toISOString();
      const stepRes = await busApi.dispatchDueWebhookDeliveries({
        organizationId: 'org-a',
        now: new Date(baseMs + i * 1000),
      });
      if (i < 4) {
        assert.equal(stepRes.retryWaitCount, 1);
        assert.equal(subscriptions[0].circuitState, 'closed');
      } else {
        assert.equal(stepRes.dlqCount, 1);
        assert.equal(failingDel.status, 'dlq');
        assert.equal(subscriptions[0].circuitState, 'open');
        assert.equal(subscriptions[0].failureCount, 5);
        assert.equal(events[1].status, 'partial_failed');
      }
    }

    // New event while circuit is open MUST be skipped without invoking fetchImpl
    const callsBeforeOpenSkip = outboundCalls.length;
    await publishDomainEvent(db, {
      organizationId: 'org-a',
      type: 'alarm.during_open',
      data: { temp: 22 },
    });
    const skippedRes = await busApi.dispatchDueWebhookDeliveries({
      organizationId: 'org-a',
      now: new Date(baseMs + 30_000),
    });
    assert.equal(skippedRes.skippedCircuitCount, 1);
    assert.equal(outboundCalls.length, callsBeforeOpenSkip);

    // After 120s cooldown, half_open probe succeeds (200) -> circuit closes & failureCount resets to 0
    nextHttpStatus = 200;
    deliveries[2].nextAttemptAt = new Date(baseMs + 130_000).toISOString();
    const recoverRes = await busApi.dispatchDueWebhookDeliveries({
      organizationId: 'org-a',
      now: new Date(baseMs + 130_000),
    });
    assert.equal(recoverRes.deliveredCount, 1);
    assert.equal(subscriptions[0].circuitState, 'closed');
    assert.equal(subscriptions[0].failureCount, 0);

    // Replay DLQ resets delivery to pending and dispatches cleanly
    const replayCtx = makeHttpCtx({
      method: 'POST',
      state: { currentUser: { id: 10 }, currentRole: 'ldx_admin' },
      params: { values: { subscriptionId: subscriptions[0].id } },
    });
    await dxosEvents.replayDlq(replayCtx, async () => {});
    assert.equal(replayCtx.body.replayedCount, 1);
    assert.equal(failingDel.status, 'pending');
    assert.equal(failingDel.attempt, 0);

    const dispAfterReplay = makeHttpCtx({
      method: 'POST',
      state: { currentUser: { id: 10 }, currentRole: 'ldx_admin' },
    });
    await dxosEvents.dispatchNow(dispAfterReplay, async () => {});
    assert.equal(dispAfterReplay.body.deliveredCount, 1);
    assert.equal(failingDel.status, 'delivered');

    // Manual resetCircuit
    subscriptions[0].circuitState = 'open';
    subscriptions[0].failureCount = 7;
    const resetCtx = makeHttpCtx({
      method: 'POST',
      state: { currentUser: { id: 10 }, currentRole: 'ldx_admin' },
      params: { values: { subscriptionKey: 'n8n-alarms' } },
    });
    await dxosEvents.resetCircuit(resetCtx, async () => {});
    assert.equal(resetCtx.body.circuitState, 'closed');
    assert.equal(resetCtx.body.failureCount, 0);
  } finally {
    unsubOk();
    unsubErr();
  }
});

test('voucher-lifecycle emits domain events, OpenAPI dynamically includes latticeCustom* + v0.4.0 endpoints, metrics expose event bus gauges, and security guards hold', async () => {
  const { submitVoucher, cancelVoucher, amendVoucher } = require('../src/server/voucher-lifecycle');
  const { buildOpenApiSpec } = require('../src/server/openapi-spec');
  const { registerObservability } = require('../src/server/observability');
  const { registerPaasApiKeys, createPaasApiKeyAuthMiddleware } = require('../src/server/paas-api-keys');
  const { registerNotificationCenter } = require('../src/server/notification-center');

  const { db, events } = makeInMemoryVaultEventDb({ withEmployeesForRoot: false });
  const resources = new Map();
  const middlewares = [];
  const app = {
    db,
    use() {},
    resourceManager: {
      define(def) { resources.set(def.name, def.actions); },
      use(fn, opts) { middlewares.push({ fn, opts }); },
    },
    acl: { allow() {} },
  };
  registerPaasApiKeys(app);
  registerObservability(app);
  registerNotificationCenter(app);

  // 1. Voucher lifecycle emits voucher.submitted, voucher.cancelled, voucher.amended
  await submitVoucher(db, {
    collection: 'latticeOrders',
    id: 1,
    organizationId: 'org-a',
    actor: { userId: '20', employeeId: 200, username: 'org-a-emp' },
    expectedVersion: 1,
  });
  await cancelVoucher(db, {
    collection: 'latticeOrders',
    id: 1,
    organizationId: 'org-a',
    actor: { userId: '10', employeeId: 100, username: 'org-a-admin' },
    cancelReason: 'Cancelled for QA',
    expectedVersion: 2,
  });
  await amendVoucher(db, {
    collection: 'latticeOrders',
    id: 1,
    organizationId: 'org-a',
    actor: { userId: '20', employeeId: 200, username: 'org-a-emp' },
  });
  assert.deepEqual(
    events.map((e) => e.eventType),
    ['voucher.submitted', 'voucher.cancelled', 'voucher.amended'],
  );

  // 2. Dynamic OpenAPI includes static v0.4.0 endpoints + dynamic latticeCustom* schemas via dxos:openapi
  const customDb = {
    ...db,
    collections: new Map([
      ['latticeOrders', { name: 'latticeOrders', fields: new Map() }],
      [
        'latticeCustomWorkOrders',
        {
          name: 'latticeCustomWorkOrders',
          options: { title: 'CMMS Work Orders' },
          fields: new Map([
            ['organizationId', { name: 'organizationId', type: 'string', options: { allowNull: false } }],
            ['code', { name: 'code', type: 'string', options: { allowNull: false } }],
            ['name', { name: 'name', type: 'string', options: { allowNull: false } }],
            ['priority', { name: 'priority', type: 'string', options: { uiSchema: { enum: ['low', 'high', 'critical'] } } }],
            ['estimatedHours', { name: 'estimatedHours', type: 'double' }],
          ]),
        },
      ],
    ]),
  };
  const spec = buildOpenApiSpec({ serverUrl: 'https://dx.example.org', db: customDb });
  for (const requiredOp of [
    '/api/dxosVault:list',
    '/api/dxosVault:save',
    '/api/dxosVault:rotateSecret',
    '/api/dxosVault:testConnection',
    '/api/dxosEvents:listEvents',
    '/api/dxosEvents:publish',
    '/api/dxosEvents:replayDlq',
    '/api/dxosEvents:resetCircuit',
    '/api/dxosBroker:provisionDevice',
    '/api/dxosBroker:orionNotify',
    '/api/dxosAutomations:saveRule',
    '/api/dxosAutomations:replayRun',
    '/api/dxosBuilder:createDomain',
    '/api/dxosBuilder:installBusinessPack',
    '/api/dxosBuilder:provisionTenant',
    '/api/latticeCustomWorkOrders:list',
    '/api/latticeCustomWorkOrders:get',
    '/api/latticeCustomWorkOrders:create',
    '/api/latticeCustomWorkOrders:update',
    '/api/latticeCustomWorkOrders:destroy',
  ]) {
    assert.ok(spec.paths[requiredOp], `Missing OpenAPI path ${requiredOp}`);
  }
  assert.equal(spec.components.schemas.latticeCustomWorkOrders.properties.estimatedHours.type, 'number');
  assert.deepEqual(spec.components.schemas.latticeCustomWorkOrders.properties.priority.enum, ['low', 'high', 'critical']);

  const dxos = resources.get('dxos');
  const oaCtx = makeHttpCtx({ method: 'GET', headers: { host: 'dx.example.org' } });
  oaCtx.db = customDb;
  await dxos.openapi(oaCtx, async () => {});
  assert.ok(oaCtx.body.paths['/api/latticeCustomWorkOrders:list']);

  // 3. Prometheus metrics include event bus, webhook deliveries, and circuit gauges
  const metricsCtx = makeHttpCtx({
    method: 'GET',
    state: { currentUser: { id: 1 }, currentRole: 'root' },
  });
  await dxos.metrics(metricsCtx, async () => {});
  assert.match(metricsCtx.body, /latticedx_event_bus_by_status\{status="dispatched"\} 3/);
  assert.match(metricsCtx.body, /latticedx_webhook_deliveries_by_status\{status="pending"\} 0/);
  assert.match(metricsCtx.body, /latticedx_webhook_circuits_by_state\{state="closed"\} 0/);

  // 4. paas-api-keys guard blocks direct latticeConnectors / latticeWebhookSubscriptions CRUD & read-only PAT blocks mutating actions
  const guardMw = middlewares.find((m) => m.opts?.tag === 'latticePaasPrivateCollectionGuard')?.fn;
  for (const privCol of ['latticeConnectors', 'latticeWebhookSubscriptions']) {
    await assert.rejects(
      () => guardMw(makeHttpCtx({ state: { currentRole: 'ldx_admin' }, params: { resourceName: privCol, actionName: 'list' } }), async () => {}),
      (err) => err.status === 403 && err.code === 'PAAS_PRIVATE_COLLECTION_FORBIDDEN',
    );
  }

  const keyActions = resources.get('dxosApiKeys');
  const roIssueCtx = makeHttpCtx({
    method: 'POST',
    state: { currentUser: { id: 10, username: 'org-a-admin' }, currentRole: 'ldx_admin' },
    params: { values: { name: 'RO Key', roleName: 'ldx_admin', scopes: ['read'] } },
  });
  await keyActions.issue(roIssueCtx, async () => {});
  const roToken = roIssueCtx.body.token;
  const authMw = createPaasApiKeyAuthMiddleware(db);

  for (const mutAction of [
    ['dxosVault', 'rotateSecret'],
    ['dxosVault', 'testConnection'],
    ['dxosEvents', 'publish'],
    ['dxosEvents', 'toggleSubscription'],
    ['dxosEvents', 'deleteSubscription'],
    ['dxosEvents', 'replayDlq'],
    ['dxosEvents', 'resetCircuit'],
    ['dxosEvents', 'dispatchNow'],
    ['dxosBroker', 'provisionDevice'],
    ['dxosBroker', 'revokeDevice'],
    ['dxosBroker', 'orionCreateSubscription'],
    ['dxosBroker', 'orionToggleSubscription'],
    ['dxosBroker', 'orionDeleteSubscription'],
    ['dxosAutomations', 'saveRule'],
    ['dxosAutomations', 'toggleRule'],
    ['dxosAutomations', 'deleteRule'],
    ['dxosAutomations', 'runNow'],
    ['dxosAutomations', 'replayRun'],
    ['dxosBuilder', 'createDomain'],
    ['dxosBuilder', 'installBusinessPack'],
    ['dxosBuilder', 'provisionTenant'],
  ]) {
    await assert.rejects(
      () => authMw(makeHttpCtx({
        method: 'POST',
        headers: { 'x-lattice-api-key': roToken },
        params: { resourceName: mutAction[0], actionName: mutAction[1] },
      }), async () => {}),
      (err) => err.status === 403 && err.code === 'API_KEY_SCOPE_INSUFFICIENT',
      `Expected read-only PAT block for ${mutAction.join(':')}`,
    );
  }

  // 5. Notification Center fix: root without latticeEmployees returns empty 200 instead of 403; spoofed root still fails 403
  const notif = resources.get('latticeNotifications');
  const rootListCtx = makeHttpCtx({
    method: 'GET',
    state: { currentUser: { id: 1, username: 'root-admin' }, currentRole: 'root' },
  });
  await notif.listMine(rootListCtx, async () => {});
  assert.deepEqual(rootListCtx.body, { organizationId: null, total: 0, unreadCount: 0, items: [] });

  const rootUnreadCtx = makeHttpCtx({
    method: 'GET',
    state: { currentUser: { id: 1, username: 'root-admin' }, currentRole: 'root' },
  });
  await notif.unreadCount(rootUnreadCtx, async () => {});
  assert.deepEqual(rootUnreadCtx.body, { organizationId: null, unreadCount: 0 });

  // Non-root user without latticeEmployees record (id 999) still fails 403 even if spoofing X-Role: root
  await assert.rejects(
    () => notif.unreadCount(makeHttpCtx({
      method: 'GET',
      state: { currentUser: { id: 999, username: 'no-emp' }, currentRole: 'root' },
    }), async () => {}),
    (err) => err.status === 403,
  );
});

test('LatticeFoundationPlugin wires dxosVault, dxosEvents, static exports, clean drainer teardown, and SPDX headers', async () => {
  await withMockedNocobase(async () => {
    const indexPath = require.resolve('../src/server/index');
    delete require.cache[indexPath];
    const LatticeFoundationPlugin = require('../src/server/index');

    assert.equal(typeof LatticeFoundationPlugin.publishDomainEvent, 'function');
    assert.equal(typeof LatticeFoundationPlugin.registerEventBusListener, 'function');
    assert.equal(typeof LatticeFoundationPlugin.verifyStandardWebhookSignature, 'function');
    assert.equal(typeof LatticeFoundationPlugin.resolveConnectorSecrets, 'function');

    const resources = new Map();
    const app = {
      db: { on() {}, getRepository() { return null; }, sequelize: { query: async () => [[1]] } },
      use() {},
      resourceManager: { define(def) { resources.set(def.name, def.actions); }, use() {} },
      acl: { allow() {}, registerSnippet() {} },
      cronJobManager: { addJob() {} },
    };
    const plugin = new LatticeFoundationPlugin(app);
    await plugin.load();
    assert.ok(resources.has('dxosVault'));
    assert.ok(resources.has('dxosEvents'));
    assert.ok(app.latticeVault?.resolveConnectorSecrets);
    assert.equal(typeof app.latticeVault?.assertSafeConnectorUrlAsync, 'function');
    assert.ok(app.latticeEvents?.publishDomainEvent);
    assert.equal(typeof app.latticeEvents?.decodeSigningSecret, 'function');
    assert.ok(app._latticeEventBusTimer);
    await plugin.unload();
    assert.equal(app._latticeEventBusTimer, null);
  });

  const { addSourceHeader } = await import(pathToFileURL(join(REPO_ROOT, 'scripts/source-headers.mjs')).href);
  for (const rel of [
    'plugins/nocobase/plugin-lattice-foundation/src/server/collections/connectors.js',
    'plugins/nocobase/plugin-lattice-foundation/src/server/collections/event-bus.js',
    'plugins/nocobase/plugin-lattice-foundation/src/server/collections/webhook-subscriptions.js',
    'plugins/nocobase/plugin-lattice-foundation/src/server/collections/webhook-deliveries.js',
    'plugins/nocobase/plugin-lattice-foundation/src/server/migrations/20261125000100-connectors-events-webhooks.js',
    'plugins/nocobase/plugin-lattice-foundation/src/server/connector-vault.js',
    'plugins/nocobase/plugin-lattice-foundation/src/server/event-bus.js',
    'plugins/nocobase/plugin-lattice-foundation/src/server/notification-center.js',
    'plugins/nocobase/plugin-lattice-foundation/tests/vault-and-event-bus.test.cjs',
    'plugins/nocobase/plugin-lattice-foundation/tests/notifications-and-sla.test.cjs',
  ]) {
    const res = addSourceHeader(readFileSync(join(REPO_ROOT, rel), 'utf8'), rel);
    assert.equal(res.status, 'present', `${rel} missing valid SPDX header`);
  }
});

test('Whole-Delta security regression: whsec_ base64, IPv6/numeric/single-label SSRF, DNS rebinding, decrypt degradation, and RBAC/PAT scopes', async () => {
  const {
    assertSafeConnectorUrl,
    assertSafeConnectorUrlAsync,
    encryptVaultSecrets,
    registerConnectorVault,
  } = require('../src/server/connector-vault');
  const {
    decodeSigningSecret,
    signStandardWebhookPayload,
    verifyStandardWebhookSignature,
    publishDomainEvent,
    dispatchDueWebhookDeliveries,
    registerEventBus,
  } = require('../src/server/event-bus');
  const {
    registerPaasApiKeys,
    createPaasApiKeyAuthMiddleware,
  } = require('../src/server/paas-api-keys');

  // 1. Standard Webhooks whsec_ base64 decoding matches Standard Webhooks & n8n spec
  const rawSecretBytes = crypto.randomBytes(32);
  const whsec = `whsec_${rawSecretBytes.toString('base64')}`;
  assert.equal(Buffer.compare(decodeSigningSecret(whsec), rawSecretBytes), 0);
  assert.equal(Buffer.compare(decodeSigningSecret('plain-utf8-key'), Buffer.from('plain-utf8-key', 'utf8')), 0);

  const tsSec = '1763900100';
  const rawBody = '{"event":"alarm.raised","temp":9.4}';
  const expectedMac = crypto.createHmac('sha256', rawSecretBytes)
    .update(`msg_spec_1.${tsSec}.${rawBody}`, 'utf8')
    .digest('base64');
  const signed = signStandardWebhookPayload({
    webhookId: 'msg_spec_1',
    timestamp: tsSec,
    body: rawBody,
    secret: whsec,
  });
  assert.equal(signed, `v1,${expectedMac}`);
  assert.equal(verifyStandardWebhookSignature({
    webhookId: 'msg_spec_1',
    timestamp: tsSec,
    body: rawBody,
    signature: signed,
    secret: whsec,
    nowMs: Number(tsSec) * 1000,
  }), true);
  assert.equal(verifyStandardWebhookSignature({
    webhookId: 'msg_spec_1',
    timestamp: tsSec,
    body: rawBody,
    signature: signed,
    secret: 'whsec_',
    nowMs: Number(tsSec) * 1000,
  }), false);

  // 2. SSRF blocking for ::ffff:, IPv4-compatible IPv6, numeric/octal/hex hosts, single-label hosts, and allowInternal gate
  for (const unsafeUrl of [
    'http://[::ffff:169.254.169.254]/latest/meta-data/',
    'http://[::ffff:127.0.0.1]:8080/hook',
    'http://[0:0:0:0:0:ffff:169.254.169.254]/hook',
    'http://[::169.254.169.254]/hook',
    'http://[::127.0.0.1]/hook',
    'http://2130706433/hook',
    'http://0x7f000001/hook',
    'http://017700000001/hook',
    'http://0177.0.0.1/hook',
    'http://0x7f.0.0.1/hook',
    'http://127.1/hook',
    'mqtt://2130706433:1883',
    'mqtt://0x7f000001:1883',
    'http://redis:6379/',
    'http://postgres:5432/',
    'http://keycloak:8080/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://metadata.azure.com/metadata/instance',
  ]) {
    assert.throws(
      () => assertSafeConnectorUrl(unsafeUrl, { allowInternal: true }),
      (err) => err.code === 'CONNECTOR_URL_UNSAFE' && err.status === 400,
      `Expected SSRF block even with allowInternal=true for ${unsafeUrl}`,
    );
  }

  // Metadata NEVER allowed even if misconfigured in DX_CONNECTOR_INTERNAL_ALLOWLIST
  assert.throws(
    () => assertSafeConnectorUrl('http://169.254.169.254/latest/meta-data/', {
      allowInternal: true,
      env: { DX_CONNECTOR_INTERNAL_ALLOWLIST: '169.254.169.254,metadata.google.internal' },
    }),
    (err) => err.code === 'CONNECTOR_URL_UNSAFE' && err.status === 400,
  );
  assert.throws(
    () => assertSafeConnectorUrl('http://metadata.google.internal/computeMetadata/v1/', {
      allowInternal: true,
      env: { DX_CONNECTOR_INTERNAL_ALLOWLIST: 'metadata.google.internal' },
    }),
    (err) => err.code === 'CONNECTOR_URL_UNSAFE' && err.status === 400,
  );

  // Internal compose allowlist blocked when allowInternal=false or NODE_ENV=production without opt-in
  for (const internalUrl of [
    'http://n8n:5678/webhook/test',
    'http://orion-ld:1026/ngsi-ld/v1/entities',
    'mqtt://mosquitto:1883',
    'http://nodered:1880/health',
  ]) {
    const connectorType = internalUrl.startsWith('mqtt:') ? 'mqtt' : 'http_api';
    assert.throws(
      () => assertSafeConnectorUrl(internalUrl, { connectorType, allowInternal: false }),
      (err) => err.code === 'CONNECTOR_URL_UNSAFE' && err.status === 400,
      `Expected allowInternal=false block for ${internalUrl}`,
    );
    assert.throws(
      () => assertSafeConnectorUrl(internalUrl, { connectorType, env: { NODE_ENV: 'production' } }),
      (err) => err.code === 'CONNECTOR_URL_UNSAFE' && err.status === 400,
      `Expected production default block for ${internalUrl}`,
    );
    assert.ok(
      assertSafeConnectorUrl(internalUrl, {
        connectorType,
        env: { NODE_ENV: 'production', DX_ALLOW_INTERNAL_CONNECTORS: 'true' },
      }),
    );
  }

  // 3. Async DNS rebinding checks on assertSafeConnectorUrlAsync
  for (const reboundIp of ['169.254.169.254', '127.0.0.1', '::ffff:127.0.0.1', '::ffff:169.254.169.254', '10.0.0.4', 'fe80::1', '::1', '0.0.0.0']) {
    await assert.rejects(
      () => assertSafeConnectorUrlAsync('https://rebind.example.org/hook', {
        lookupImpl: async () => [{ address: reboundIp, family: reboundIp.includes(':') ? 6 : 4 }],
      }),
      (err) => err.code === 'CONNECTOR_URL_UNSAFE' && err.status === 400,
      `Expected DNS rebinding block for ${reboundIp}`,
    );
  }
  await assert.rejects(
    () => assertSafeConnectorUrlAsync('https://dual-stack.example.org/hook', {
      lookupImpl: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '::ffff:127.0.0.1', family: 6 },
      ],
    }),
    (err) => err.code === 'CONNECTOR_URL_UNSAFE' && err.status === 400,
  );
  await assert.rejects(
    () => assertSafeConnectorUrlAsync('https://missing-host.example.invalid/hook', {
      lookupImpl: async () => {
        throw Object.assign(new Error('getaddrinfo ENOTFOUND missing-host.example.invalid'), { code: 'ENOTFOUND' });
      },
    }),
    (err) => err.code === 'CONNECTOR_URL_UNSAFE' && err.status === 400,
  );
  assert.equal(
    await assertSafeConnectorUrlAsync('https://public.example.org/hook', {
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    }),
    'https://public.example.org/hook',
  );

  // 4. Production non-root vs root internal connector rules, DNS-rebinding in testConnection/dispatchNow,
  //    decrypt-error resilience on dxosVault:list, employee 403s, and wrong-scope PAT 403s
  const { db, connectors } = makeInMemoryVaultEventDb({ withEmployeesForRoot: true });
  const resources = new Map();
  const app = {
    db,
    resourceManager: { define(def) { resources.set(def.name, def.actions); }, use() {} },
    acl: { allow() {} },
    logger: { error() {}, warn() {}, info() {} },
  };
  const prodVaultEnv = { NODE_ENV: 'production', DX_VAULT_MASTER_KEY: 'prod-vault-secret-2026' };
  const probeFetchCalls = [];
  const busFetchCalls = [];
  const dnsMap = new Map([
    ['rebind.attacker.example', [{ address: '169.254.169.254', family: 4 }]],
    ['webhook-rebind.example', [{ address: '::ffff:127.0.0.1', family: 6 }]],
    ['public.partner.example', [{ address: '93.184.216.34', family: 4 }]],
  ]);
  const testLookup = async (host) => dnsMap.get(host) || [{ address: '93.184.216.34', family: 4 }];

  registerPaasApiKeys(app);
  registerConnectorVault(app, {
    env: prodVaultEnv,
    lookupImpl: testLookup,
    fetchImpl: async (url, init) => {
      probeFetchCalls.push({ url, init });
      return { ok: true, status: 200, body: { cancel: async () => {} } };
    },
  });
  registerEventBus(app, {
    startDrainer: false,
    env: prodVaultEnv,
    lookupImpl: testLookup,
    fetchImpl: async (url, init) => {
      busFetchCalls.push({ url, init });
      return { ok: true, status: 200, body: { cancel: async () => {} } };
    },
  });

  const vault = resources.get('dxosVault');
  const dxosEvents = resources.get('dxosEvents');
  const keyActions = resources.get('dxosApiKeys');
  const authMw = createPaasApiKeyAuthMiddleware(db);

  // In production, ldx_admin cannot save/probe internal compose hosts; verified root CAN
  await assert.rejects(
    () => vault.save(makeHttpCtx({
      method: 'POST',
      state: { currentUser: { id: 10 }, currentRole: 'ldx_admin' },
      params: { values: { connectorKey: 'admin-n8n', name: 'Blocked Admin n8n', connectorType: 'n8n', baseUrl: 'http://n8n:5678' } },
    }), async () => {}),
    (err) => err.code === 'CONNECTOR_URL_UNSAFE' && err.status === 400,
  );
  await assert.rejects(
    () => vault.testConnection(makeHttpCtx({
      method: 'POST',
      state: { currentUser: { id: 10 }, currentRole: 'ldx_admin' },
      params: { values: { connectorType: 'http_api', baseUrl: 'http://127.0.0.1:8080/health' } },
    }), async () => {}),
    (err) => err.code === 'CONNECTOR_URL_UNSAFE' && err.status === 400,
  );
  await assert.rejects(
    () => dxosEvents.saveSubscription(makeHttpCtx({
      method: 'POST',
      state: { currentUser: { id: 10 }, currentRole: 'ldx_admin' },
      params: { values: { subscriptionKey: 'admin-internal', name: 'Blocked', targetUrl: 'http://n8n:5678/webhook/test' } },
    }), async () => {}),
    (err) => err.code === 'CONNECTOR_URL_UNSAFE' && err.status === 400,
  );

  // Verified root succeeds on internal compose host in production
  const rootSaveCtx = makeHttpCtx({
    method: 'POST',
    state: { currentUser: { id: 1 }, currentRole: 'root' },
    params: { values: { organizationId: 'org-a', connectorKey: 'root-n8n', name: 'Root n8n', connectorType: 'n8n', baseUrl: 'http://n8n:5678' } },
  });
  await vault.save(rootSaveCtx, async () => {});
  assert.equal(rootSaveCtx.body.connectorKey, 'root-n8n');

  // DNS rebinding blocks testConnection BEFORE fetchImpl runs
  await assert.rejects(
    () => vault.testConnection(makeHttpCtx({
      method: 'POST',
      state: { currentUser: { id: 10 }, currentRole: 'ldx_admin' },
      params: { values: { connectorType: 'http_api', baseUrl: 'https://rebind.attacker.example/hook' } },
    }), async () => {}),
    (err) => err.code === 'CONNECTOR_URL_UNSAFE' && err.status === 400,
  );
  assert.equal(probeFetchCalls.length, 0);

  // DNS rebinding in webhook delivery blocks fetchImpl and marks delivery retry_wait cleanly
  await dxosEvents.saveSubscription(makeHttpCtx({
    method: 'POST',
    state: { currentUser: { id: 10 }, currentRole: 'ldx_admin' },
    params: {
      values: {
        subscriptionKey: 'rebind-hook',
        name: 'Rebind Hook',
        targetUrl: 'https://webhook-rebind.example/events',
        eventPattern: 'rebind.*',
      },
    },
  }), async () => {});
  await publishDomainEvent(db, { organizationId: 'org-a', type: 'rebind.test', data: { ping: 1 } });
  const dispatchRebindRes = await dispatchDueWebhookDeliveries(db, {
    organizationId: 'org-a',
    env: prodVaultEnv,
    lookupImpl: testLookup,
    fetchImpl: async (url, init) => {
      busFetchCalls.push({ url, init });
      return { ok: true, status: 200, body: { cancel: async () => {} } };
    },
  });
  assert.equal(dispatchRebindRes.retryWaitCount, 1);
  assert.equal(busFetchCalls.length, 0);

  // Corrupted / rotated ciphertext in DB degrades gracefully on dxosVault:list instead of 500
  const goodEnc = encryptVaultSecrets({ apiKey: 'ok-1' }, prodVaultEnv);
  connectors.push({
    id: 901,
    organizationId: 'org-a',
    connectorKey: 'corrupt-conn',
    name: 'Corrupt Key Connector',
    connectorType: 'webhook',
    baseUrl: 'https://public.partner.example/hook',
    authType: 'api_key',
    encryptedSecretsJson: 'bad-iv:bad-tag:deadbeef',
    secretVersion: 1,
    active: true,
  });
  connectors.push({
    id: 902,
    organizationId: 'org-a',
    connectorKey: 'rotated-key-conn',
    name: 'Old Master Key Connector',
    connectorType: 'webhook',
    baseUrl: 'https://public.partner.example/hook2',
    authType: 'api_key',
    encryptedSecretsJson: encryptVaultSecrets({ apiKey: 'old' }, { NODE_ENV: 'production', DX_VAULT_MASTER_KEY: 'previous-rotated-key' }),
    secretVersion: 1,
    active: true,
  });
  connectors.push({
    id: 903,
    organizationId: 'org-a',
    connectorKey: 'healthy-conn',
    name: 'Healthy Connector',
    connectorType: 'webhook',
    baseUrl: 'https://public.partner.example/hook3',
    authType: 'api_key',
    encryptedSecretsJson: goodEnc,
    secretVersion: 1,
    active: true,
  });

  const adminListCtx = makeHttpCtx({
    method: 'GET',
    state: { currentUser: { id: 10 }, currentRole: 'ldx_admin' },
  });
  await vault.list(adminListCtx, async () => {});
  const corruptItem = adminListCtx.body.items.find((c) => c.connectorKey === 'corrupt-conn');
  const rotatedItem = adminListCtx.body.items.find((c) => c.connectorKey === 'rotated-key-conn');
  const healthyItem = adminListCtx.body.items.find((c) => c.connectorKey === 'healthy-conn');
  assert.equal(corruptItem.decryptionError, true);
  assert.deepEqual(corruptItem.secretKeys, []);
  assert.equal(corruptItem.hasSecrets, true);
  assert.equal(rotatedItem.decryptionError, true);
  assert.deepEqual(rotatedItem.secretKeys, []);
  assert.equal(rotatedItem.hasSecrets, true);
  assert.equal(healthyItem.decryptionError, false);
  assert.deepEqual(healthyItem.secretKeys, ['apiKey']);

  // Non-admin employee denied 403 on dxosVault:list & dxosEvents:listEvents/listSubscriptions/listDeliveries
  await assert.rejects(
    () => vault.list(makeHttpCtx({ method: 'GET', state: { currentUser: { id: 20 }, currentRole: 'ldx_employee' } }), async () => {}),
    (err) => err.status === 403 && err.code === 'VAULT_ADMIN_REQUIRED',
  );
  for (const readAction of ['listEvents', 'listSubscriptions', 'listDeliveries']) {
    await assert.rejects(
      () => dxosEvents[readAction](makeHttpCtx({ method: 'GET', state: { currentUser: { id: 20 }, currentRole: 'ldx_employee' } }), async () => {}),
      (err) => err.status === 403 && err.code === 'EVENTS_ADMIN_REQUIRED',
      `Expected 403 EVENTS_ADMIN_REQUIRED for employee on dxosEvents:${readAction}`,
    );
  }

  // Wrong-scope PAT (['ledger']) denied 403 API_KEY_SCOPE_INSUFFICIENT on ALL dxosVault:* and dxosEvents:* actions
  const ledgerIssueCtx = makeHttpCtx({
    method: 'POST',
    state: { currentUser: { id: 10, username: 'org-a-admin' }, currentRole: 'ldx_admin' },
    params: { values: { name: 'Ledger Only Admin PAT', roleName: 'ldx_admin', scopes: ['ledger'] } },
  });
  await keyActions.issue(ledgerIssueCtx, async () => {});
  const ledgerToken = ledgerIssueCtx.body.token;

  const invokeWithPat = async (token, resourceName, actionName, method, values = {}) => {
    const reqCtx = makeHttpCtx({
      method,
      headers: { 'x-lattice-api-key': token },
      params: { resourceName, actionName, values },
    });
    const handler = resourceName === 'dxosVault' ? vault[actionName] : dxosEvents[actionName];
    await authMw(reqCtx, async () => handler(reqCtx, async () => {}));
    return reqCtx;
  };

  for (const [resName, actName, httpMethod] of [
    ['dxosVault', 'list', 'GET'],
    ['dxosVault', 'save', 'POST'],
    ['dxosVault', 'rotateSecret', 'POST'],
    ['dxosVault', 'delete', 'POST'],
    ['dxosVault', 'testConnection', 'POST'],
    ['dxosEvents', 'listEvents', 'GET'],
    ['dxosEvents', 'listSubscriptions', 'GET'],
    ['dxosEvents', 'listDeliveries', 'GET'],
    ['dxosEvents', 'publish', 'POST'],
    ['dxosEvents', 'saveSubscription', 'POST'],
    ['dxosEvents', 'toggleSubscription', 'POST'],
    ['dxosEvents', 'deleteSubscription', 'POST'],
    ['dxosEvents', 'dispatchNow', 'POST'],
    ['dxosEvents', 'replayDlq', 'POST'],
    ['dxosEvents', 'resetCircuit', 'POST'],
  ]) {
    await assert.rejects(
      () => invokeWithPat(ledgerToken, resName, actName, httpMethod),
      (err) => err.status === 403 && err.code === 'API_KEY_SCOPE_INSUFFICIENT',
      `Expected 403 API_KEY_SCOPE_INSUFFICIENT for ['ledger'] PAT on ${resName}:${actName}`,
    );
  }

  // Valid ['read'] PAT succeeds on dxosVault:list & dxosEvents:list* for ldx_admin
  const readIssueCtx = makeHttpCtx({
    method: 'POST',
    state: { currentUser: { id: 10, username: 'org-a-admin' }, currentRole: 'ldx_admin' },
    params: { values: { name: 'Read Admin PAT', roleName: 'ldx_admin', scopes: ['read'] } },
  });
  await keyActions.issue(readIssueCtx, async () => {});
  const readToken = readIssueCtx.body.token;
  const patVaultList = await invokeWithPat(readToken, 'dxosVault', 'list', 'GET');
  assert.ok(Array.isArray(patVaultList.body.items));
  for (const act of ['listEvents', 'listSubscriptions', 'listDeliveries']) {
    const patEvList = await invokeWithPat(readToken, 'dxosEvents', act, 'GET');
    assert.ok(Array.isArray(patEvList.body.items));
  }
});

test('Task 6a: APP_CONNECTOR_CATALOG, OAuth2 PKCE S256 oauthStart/oauthCallback, single-flight getFreshConnectorToken (180s buffer), and strict internal allowlist', async () => {
  const {
    APP_CONNECTOR_CATALOG,
    assertSafeConnectorUrl,
    oauthStart,
    oauthCallback,
    getFreshConnectorToken,
    registerConnectorVault,
    decryptSecretText,
  } = require('../src/server/connector-vault');

  // 1. APP_CONNECTOR_CATALOG covers all 11 enterprise app connectors
  assert.ok(Array.isArray(APP_CONNECTOR_CATALOG));
  const appTypes = new Set(APP_CONNECTOR_CATALOG.map((entry) => entry.appType));
  for (const requiredApp of [
    'telegram',
    'email_smtp',
    'gmail_oauth2',
    'google_sheets_oauth2',
    'slack',
    'discord',
    'teams',
    'github',
    'rustfs_s3',
    'n8n_api',
    'partner_webhook',
  ]) {
    assert.ok(appTypes.has(requiredApp), `Missing APP_CONNECTOR_CATALOG entry for ${requiredApp}`);
  }

  // 2. Strict internal-service allowlist: DX_ALLOW_INTERNAL_CONNECTORS=true + DX_INTERNAL_SERVICE_HOSTS
  const strictEnv = { NODE_ENV: 'production', DX_ALLOW_INTERNAL_CONNECTORS: 'true' };
  for (const allowedInternal of [
    'http://n8n:5678/api/v1/workflows',
    'http://orion-ld:1026/ngsi-ld/v1/entities',
    'http://nodered:1880/flows',
    'mqtt://mosquitto:1883',
  ]) {
    const cType = allowedInternal.startsWith('mqtt:') ? 'mqtt' : 'http_api';
    assert.ok(assertSafeConnectorUrl(allowedInternal, { connectorType: cType, env: strictEnv }));
  }

  // Custom DX_INTERNAL_SERVICE_HOSTS restricts to configured services only
  const customHostEnv = {
    NODE_ENV: 'production',
    DX_ALLOW_INTERNAL_CONNECTORS: 'true',
    DX_INTERNAL_SERVICE_HOSTS: 'n8n,orion-ld',
  };
  assert.ok(assertSafeConnectorUrl('http://n8n:5678/healthz', { env: customHostEnv }));
  assert.throws(
    () => assertSafeConnectorUrl('http://nodered:1880/health', { env: customHostEnv }),
    (err) => err.code === 'CONNECTOR_URL_UNSAFE' && err.status === 400,
  );

  // Strictly blocks metadata, link-local, loopback, and arbitrary RFC1918 even when DX_ALLOW_INTERNAL_CONNECTORS=true
  // (and even if misconfigured into DX_INTERNAL_SERVICE_HOSTS)
  const poisonedEnv = {
    NODE_ENV: 'production',
    DX_ALLOW_INTERNAL_CONNECTORS: 'true',
    DX_INTERNAL_SERVICE_HOSTS: 'n8n,169.254.169.254,169.254.10.20,127.0.0.1,localhost,::1,10.0.0.1,172.16.0.5,192.168.1.50',
  };
  for (const blockedUrl of [
    'http://169.254.169.254/latest/meta-data/',
    'http://169.254.10.20/link-local',
    'http://[fe80::1]/link-local6',
    'http://127.0.0.1:8080/admin',
    'http://localhost:5678/admin',
    'http://[::1]:5678/admin',
    'http://10.0.0.1/internal',
    'http://172.16.0.5/internal',
    'http://192.168.1.50/internal',
  ]) {
    assert.throws(
      () => assertSafeConnectorUrl(blockedUrl, { env: strictEnv }),
      (err) => err.code === 'CONNECTOR_URL_UNSAFE' && err.status === 400,
      `Expected strictEnv block for ${blockedUrl}`,
    );
    assert.throws(
      () => assertSafeConnectorUrl(blockedUrl, { env: poisonedEnv }),
      (err) => err.code === 'CONNECTOR_URL_UNSAFE' && err.status === 400,
      `Expected poisonedEnv block for ${blockedUrl}`,
    );
  }

  // 3. OAuth2 PKCE S256 (oauthStart -> oauthCallback -> encrypted tokens -> single-flight refresh)
  const { db, connectors, sqlCalls } = makeInMemoryVaultEventDb({ dialect: 'postgres' });
  const oauthEnv = { NODE_ENV: 'production', DX_VAULT_MASTER_KEY: 'oauth2-pkce-vault-master-key-2026' };
  const nowEpochMs = 1_800_000_000_000;

  const startRes = await oauthStart(db, {
    organizationId: 'org-a',
    connectorKey: 'gmail-ops',
    name: 'Operations Gmail',
    appType: 'gmail_oauth2',
    clientId: 'google-client-id-1',
    clientSecret: 'google-client-secret-top',
    redirectUri: 'https://app.latticedx.example.com/api/dxosVault:oauthCallback',
    scopes: ['https://www.googleapis.com/auth/gmail.send'],
  }, { env: oauthEnv, nowMs: nowEpochMs });

  assert.equal(startRes.connectorKey, 'gmail-ops');
  assert.equal(startRes.codeChallengeMethod, 'S256');
  assert.ok(startRes.state && startRes.state.length >= 32);
  assert.ok(startRes.codeChallenge);
  assert.equal(startRes.codeVerifier, undefined, 'codeVerifier must never leak in oauthStart response');
  assert.equal(JSON.stringify(startRes).includes('google-client-secret-top'), false);

  const authUrl = new URL(startRes.authorizeUrl);
  assert.equal(authUrl.searchParams.get('response_type'), 'code');
  assert.equal(authUrl.searchParams.get('client_id'), 'google-client-id-1');
  assert.equal(authUrl.searchParams.get('state'), startRes.state);
  assert.equal(authUrl.searchParams.get('code_challenge'), startRes.codeChallenge);
  assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');

  assert.equal(connectors.length, 1);
  assert.equal(connectors[0].appType, 'gmail_oauth2');
  assert.equal(connectors[0].oauthStateNonce, startRes.state);

  // CSRF state mismatch rejected 400 OAUTH_STATE_MISMATCH
  await assert.rejects(
    () => oauthCallback(db, {
      organizationId: 'org-a',
      connectorKey: 'gmail-ops',
      code: 'auth-code-123',
      state: 'tampered-wrong-state',
    }, { env: oauthEnv, fetchImpl: async () => { throw new Error('must not call token endpoint on CSRF mismatch'); } }),
    (err) => err.status === 400 && err.code === 'OAUTH_STATE_MISMATCH',
  );

  // Valid oauthCallback exchanges code + PKCE code_verifier & encrypts access/refresh tokens with AES-256-GCM
  const tokenExchangeCalls = [];
  const cbRes = await oauthCallback(db, {
    organizationId: 'org-a',
    connectorKey: 'gmail-ops',
    code: 'auth-code-123',
    state: startRes.state,
  }, {
    env: oauthEnv,
    nowMs: nowEpochMs,
    lookupImpl: async () => [{ address: '142.250.190.10', family: 4 }],
    fetchImpl: async (url, init) => {
      tokenExchangeCalls.push({ url, method: init?.method, body: String(init?.body || ''), redirect: init?.redirect });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          access_token: 'ya29.initial-access-token',
          refresh_token: '1//initial-refresh-token',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: 'https://www.googleapis.com/auth/gmail.send',
        }),
      };
    },
  });

  assert.equal(cbRes.connected, true);
  assert.equal(cbRes.hasAccessToken, true);
  assert.equal(cbRes.hasRefreshToken, true);
  assert.equal(JSON.stringify(cbRes).includes('ya29.initial-access-token'), false);
  assert.equal(JSON.stringify(cbRes).includes('1//initial-refresh-token'), false);
  assert.equal(tokenExchangeCalls.length, 1);
  assert.equal(tokenExchangeCalls[0].redirect, 'error');

  const exchangedParams = new URLSearchParams(tokenExchangeCalls[0].body);
  assert.equal(exchangedParams.get('grant_type'), 'authorization_code');
  assert.equal(exchangedParams.get('code'), 'auth-code-123');
  assert.equal(exchangedParams.get('client_secret'), 'google-client-secret-top');
  const sentVerifier = exchangedParams.get('code_verifier');
  assert.ok(sentVerifier && sentVerifier.length >= 43);
  const expectedChallenge = crypto.createHash('sha256').update(sentVerifier, 'ascii').digest('base64url');
  assert.equal(expectedChallenge, startRes.codeChallenge);

  // One-time state nonce cleared & tokens encrypted in AES-256-GCM format
  assert.equal(connectors[0].oauthStateNonce, null);
  assert.equal(connectors[0].oauthAccessTokenEnc.includes('ya29.initial-access-token'), false);
  assert.equal(connectors[0].oauthRefreshTokenEnc.includes('1//initial-refresh-token'), false);
  assert.equal(decryptSecretText(connectors[0].oauthAccessTokenEnc, oauthEnv), 'ya29.initial-access-token');
  assert.equal(decryptSecretText(connectors[0].oauthRefreshTokenEnc, oauthEnv), '1//initial-refresh-token');

  // Replay of same state nonce fails
  await assert.rejects(
    () => oauthCallback(db, {
      organizationId: 'org-a',
      connectorKey: 'gmail-ops',
      code: 'auth-code-123',
      state: startRes.state,
    }, { env: oauthEnv }),
    (err) => err.status === 400 && err.code === 'OAUTH_STATE_MISMATCH',
  );

  // 4. getFreshConnectorToken: valid token (>180s left) returns cached token with 0 HTTP calls
  let refreshCallCount = 0;
  const freshNoRefresh = await getFreshConnectorToken(db, connectors[0].id, {
    env: oauthEnv,
    nowMs: nowEpochMs + 1000 * 1000, // 2600s left > 180s
    fetchImpl: async () => {
      refreshCallCount += 1;
      throw new Error('should not refresh when >180s remaining');
    },
  });
  assert.equal(freshNoRefresh.accessToken, 'ya29.initial-access-token');
  assert.equal(freshNoRefresh.refreshed, false);
  assert.equal(refreshCallCount, 0);

  // Within 180s early-refresh buffer (120s left) + 5 concurrent callers -> ONLY 1 upstream refresh HTTP call!
  let resolveRefreshFetch;
  const refreshGate = new Promise((r) => { resolveRefreshFetch = r; });
  const refreshBodies = [];
  const nearExpiryNowMs = nowEpochMs + (3600 - 120) * 1000;
  const prevRlsFlag = process.env.DX_PG_RLS_SESSION;
  process.env.DX_PG_RLS_SESSION = 'true';
  try {
    const concurrentPromises = Array.from({ length: 5 }, () => getFreshConnectorToken(db, connectors[0].id, {
      env: oauthEnv,
      nowMs: nearExpiryNowMs,
      lookupImpl: async () => [{ address: '142.250.190.10', family: 4 }],
      fetchImpl: async (url, init) => {
        refreshCallCount += 1;
        refreshBodies.push({ url, body: String(init?.body || ''), redirect: init?.redirect });
        await refreshGate;
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            access_token: 'ya29.refreshed-single-flight-token',
            refresh_token: '1//rotated-refresh-token',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
        };
      },
    }));

    // Let microtasks enter flight, then release upstream response
    await new Promise((r) => setTimeout(r, 15));
    resolveRefreshFetch();
    const results = await Promise.all(concurrentPromises);

    assert.equal(refreshCallCount, 1, 'Single-flight lock must trigger ONLY 1 upstream refresh HTTP call for 5 concurrent callers');
    for (const r of results) {
      assert.equal(r.accessToken, 'ya29.refreshed-single-flight-token');
    }
    const refreshParams = new URLSearchParams(refreshBodies[0].body);
    assert.equal(refreshParams.get('grant_type'), 'refresh_token');
    assert.equal(refreshParams.get('refresh_token'), '1//initial-refresh-token');
    assert.equal(decryptSecretText(connectors[0].oauthAccessTokenEnc, oauthEnv), 'ya29.refreshed-single-flight-token');
    assert.equal(decryptSecretText(connectors[0].oauthRefreshTokenEnc, oauthEnv), '1//rotated-refresh-token');
    assert.ok(sqlCalls.some((q) => /set_config\('app\.(?:rls_bypass|current_org)'/.test(q.sql)), 'PG RLS session context must be applied');
  } finally {
    if (prevRlsFlag === undefined) delete process.env.DX_PG_RLS_SESSION;
    else process.env.DX_PG_RLS_SESSION = prevRlsFlag;
  }

  // 5. dxosVault resource actions expose oauthStart, oauthCallback, appCatalog and enforce admin RBAC
  const resources = new Map();
  const app = {
    db,
    resourceManager: { define(def) { resources.set(def.name, def.actions); }, use() {} },
    acl: { allow() {} },
  };
  registerConnectorVault(app, { env: oauthEnv });
  const vaultActions = resources.get('dxosVault');
  assert.equal(typeof vaultActions.appCatalog, 'function');
  assert.equal(typeof vaultActions.oauthStart, 'function');
  assert.equal(typeof vaultActions.oauthCallback, 'function');

  await assert.rejects(
    () => vaultActions.oauthStart(makeHttpCtx({
      method: 'POST',
      state: { currentUser: { id: 20 }, currentRole: 'ldx_employee' },
      params: { values: { connectorKey: 'gmail-ops', appType: 'gmail_oauth2', clientId: 'c1', redirectUri: 'https://app.latticedx.example.com/cb' } },
    }), async () => {}),
    (err) => err.status === 403 && err.code === 'VAULT_ADMIN_REQUIRED',
  );
});

test('Task 1 remediation: dispatchOneDelivery isolates syncParentEventStatus from write TX and forwards transaction explicitly', async () => {
  const { dispatchOneDelivery, syncParentEventStatus } = require('../src/server/event-bus');
  const { withTenantRlsContext } = require('../src/server/pg-rls');
  const prevFlag = process.env.DX_PG_RLS_SESSION;

  let txSeq = 0;
  let currentTxAborted = false;
  const openTxs = new Set();
  const syncFindTxs = [];
  const committedDeliveries = [];
  let failSyncRead = true;

  const sub = {
    id: 1,
    organizationId: 'org-a',
    subscriptionKey: 'wh-1',
    targetUrl: 'https://hooks.example.org/wh',
    active: true,
    failureCount: 0,
    circuitState: 'closed',
  };
  const delivery = {
    id: 10,
    organizationId: 'org-a',
    eventId: 'ev-sp-1',
    subscriptionId: 1,
    eventType: 'order.submitted',
    attempt: 0,
    maxAttempts: 3,
    status: 'processing',
    payloadSnapshotJson: { id: 'ev-sp-1' },
  };
  const evRow = { id: 1, organizationId: 'org-a', eventId: 'ev-sp-1', status: 'queued' };

  const db = {
    sequelize: {
      getDialect: () => 'postgres',
      transaction: async (cb) => {
        const tx = { id: `tx-ev-${++txSeq}`, LOCK: { UPDATE: 'UPDATE' } };
        openTxs.add(tx);
        currentTxAborted = false;
        try {
          return await cb(tx);
        } finally {
          openTxs.delete(tx);
        }
      },
      query: async (sql) => {
        const text = String(sql);
        if (text.startsWith('ROLLBACK TO SAVEPOINT ')) {
          currentTxAborted = false;
        }
        return [[]];
      },
    },
    getRepository(name) {
      if (name === 'latticeWebhookSubscriptions') {
        return {
          findOne: async () => ({ ...sub, get: (k) => sub[k] }),
          update: async ({ values }) => { Object.assign(sub, values); return [sub]; },
        };
      }
      if (name === 'latticeWebhookDeliveries') {
        return {
          find: async (opts) => {
            syncFindTxs.push({ tx: opts?.transaction || null, inOpenTx: openTxs.size });
            if (failSyncRead) {
              currentTxAborted = true;
              throw Object.assign(new Error('simulated 42P01'), { code: '42P01' });
            }
            return [{ ...delivery, get: (k) => delivery[k] }];
          },
          update: async ({ values }) => {
            if (currentTxAborted) throw Object.assign(new Error('25P02 aborted'), { code: '25P02' });
            Object.assign(delivery, values);
            committedDeliveries.push({ ...delivery });
            return [delivery];
          },
        };
      }
      if (name === 'latticeEventBus') {
        return {
          findOne: async (opts) => {
            syncFindTxs.push({ tx: opts?.transaction || null, inOpenTx: openTxs.size });
            return { ...evRow, get: (k) => evRow[k] };
          },
          update: async ({ values }) => { Object.assign(evRow, values); return [evRow]; },
        };
      }
      return null;
    },
  };

  try {
    process.env.DX_PG_RLS_SESSION = 'true';
    const res = await dispatchOneDelivery(db, { ...delivery, get: (k) => delivery[k] }, {
      fetchImpl: async () => ({ status: 200, ok: true, body: { cancel: async () => {} } }),
    });
    assert.equal(res.outcome, 'delivered');
    assert.equal(delivery.status, 'delivered');
    assert.ok(committedDeliveries.some((d) => d.status === 'delivered'));
    assert.equal(syncFindTxs.length, 1);
    assert.ok(syncFindTxs[0].tx, 'syncParentEventStatus must run in its own scoped transaction');

    // When called inside an active RLS transaction, syncParentEventStatus isolates via SAVEPOINT and forwards tx
    failSyncRead = false;
    syncFindTxs.length = 0;
    await withTenantRlsContext(db, 'org-a', async (tx) => {
      await syncParentEventStatus(db, 'org-a', 'ev-sp-1', { transaction: tx });
      assert.equal(syncFindTxs[0].tx, tx);
      assert.equal(syncFindTxs[1].tx, tx);
    });
    assert.equal(evRow.status, 'dispatched');
  } finally {
    if (prevFlag === undefined) delete process.env.DX_PG_RLS_SESSION;
    else process.env.DX_PG_RLS_SESSION = prevFlag;
  }
});

test('Waves 1-4 remediation: dxosVault HTTP handlers, split-TX oauthCallback, and normalized single-flight refresh enforce PG FORCE RLS & keep HTTP outside TX', async () => {
  const {
    oauthStart,
    oauthCallback,
    getFreshConnectorToken,
    registerConnectorVault,
    decryptSecretText,
  } = require('../src/server/connector-vault');

  const prevFlag = process.env.DX_PG_RLS_SESSION;
  const vaultEnv = {
    NODE_ENV: 'production',
    DX_VAULT_MASTER_KEY: 'rls-vault-test-key-2026',
    DX_ALLOW_INTERNAL_CONNECTORS: 'true',
  };

  const openTxs = new Set();
  let txCounter = 0;
  const txStates = new Map();
  const rows = [];
  let nextConnId = 1;
  const employees = [
    { id: 100, userId: 10, organizationId: 'org-a', departmentId: 1, active: true },
  ];
  const roles = [{ name: 'root', allowAll: true }, { name: 'ldx_admin', allowConfigure: true }];
  const rolesUsers = [{ userId: 1, roleName: 'root' }, { userId: 10, roleName: 'ldx_admin' }];

  const assertRls = (tableName, tx, expectedOrg = null, { requireBypassForAll = false } = {}) => {
    if (!tx || !openTxs.has(tx)) {
      throw new Error(`FORCE RLS violation on ${tableName}: missing active transaction`);
    }
    const st = txStates.get(tx) || {};
    if (st.bypass === 'on') return;
    if (!requireBypassForAll && expectedOrg && st.org === expectedOrg) return;
    throw new Error(`FORCE RLS violation on ${tableName}: org=${st.org || 'none'} bypass=${st.bypass || 'off'}`);
  };

  const matchFilter = (row, filter = {}) => Object.entries(filter || {}).every(([k, v]) => row[k] === v);
  const wrapConn = (row) => (row ? {
    ...row,
    get: (k) => row[k],
    update: async (patch, opts = {}) => {
      assertRls('latticeConnectors', opts?.transaction, row.organizationId);
      Object.assign(row, patch);
      return wrapConn(row);
    },
    destroy: async (opts = {}) => {
      assertRls('latticeConnectors', opts?.transaction, row.organizationId);
      const idx = rows.indexOf(row);
      if (idx >= 0) rows.splice(idx, 1);
      return 1;
    },
  } : null);

  const db = {
    sequelize: {
      getDialect: () => 'postgres',
      transaction: async (cb) => {
        const tx = { id: `tx-rls-vault-${++txCounter}`, LOCK: { UPDATE: 'UPDATE' } };
        openTxs.add(tx);
        txStates.set(tx, { org: '', bypass: '' });
        try {
          return await cb(tx);
        } finally {
          openTxs.delete(tx);
          txStates.delete(tx);
        }
      },
      query: async (sql, opts = {}) => {
        const text = String(sql);
        const tx = opts?.transaction;
        if (text.includes("set_config('app.current_org'") && tx && txStates.has(tx)) {
          txStates.get(tx).org = opts?.replacements?.orgId || '';
        }
        if (text.includes("set_config('app.rls_bypass', 'on'") && tx && txStates.has(tx)) {
          txStates.get(tx).bypass = 'on';
        }
        return [[]];
      },
    },
    getRepository(name) {
      if (name === 'roles') return { find: async ({ filter }) => roles.filter((r) => !filter?.name?.$in || filter.name.$in.includes(r.name)) };
      if (name === 'rolesUsers') return { find: async ({ filter }) => rolesUsers.filter((r) => Number(r.userId) === Number(filter?.userId)) };
      if (name === 'latticeEmployees') {
        return {
          find: async ({ filter, transaction } = {}) => {
            assertRls('latticeEmployees', transaction, null, { requireBypassForAll: true });
            return employees.filter((e) => Number(e.userId) === Number(filter?.userId)).map((e) => ({ ...e, get: (k) => e[k] }));
          },
        };
      }
      if (name === 'latticeConnectors') {
        return {
          find: async ({ filter = {}, transaction } = {}) => {
            assertRls('latticeConnectors', transaction, filter.organizationId || null, { requireBypassForAll: !filter.organizationId });
            return rows.filter((r) => matchFilter(r, filter)).map(wrapConn);
          },
          findOne: async ({ filter = {}, transaction } = {}) => {
            assertRls('latticeConnectors', transaction, filter.organizationId || null);
            const found = rows.find((r) => matchFilter(r, filter)) || null;
            return wrapConn(found);
          },
          create: async ({ values, transaction }) => {
            assertRls('latticeConnectors', transaction, values.organizationId);
            const created = { id: nextConnId++, ...values };
            rows.push(created);
            return wrapConn(created);
          },
          update: async ({ filterByTk, filter = {}, values, transaction }) => {
            assertRls('latticeConnectors', transaction, filter.organizationId || null);
            const matched = rows.filter((r) => (filterByTk == null || r.id === filterByTk) && matchFilter(r, filter));
            for (const m of matched) Object.assign(m, values);
            return matched.map(wrapConn);
          },
          destroy: async ({ filter = {}, transaction }) => {
            assertRls('latticeConnectors', transaction, filter.organizationId || null);
            let n = 0;
            for (let i = rows.length - 1; i >= 0; i -= 1) {
              if (matchFilter(rows[i], filter)) {
                rows.splice(i, 1);
                n += 1;
              }
            }
            return n;
          },
        };
      }
      return null;
    },
  };

  try {
    process.env.DX_PG_RLS_SESSION = 'true';
    const probeEvents = [];
    const resources = new Map();
    const app = {
      db,
      resourceManager: { define(def) { resources.set(def.name, def.actions); }, use() {} },
      acl: { allow() {} },
    };
    registerConnectorVault(app, {
      env: vaultEnv,
      fetchImpl: async (url) => {
        probeEvents.push({ url, openTxCountDuringHttp: openTxs.size });
        assert.equal(openTxs.size, 0, 'probeConnectorEndpoint fetch must run strictly outside any DB transaction');
        return { ok: true, status: 200, body: { cancel: async () => {} } };
      },
    });
    const vault = resources.get('dxosVault');

    // 1. save (both findConnectorInOrg pre-check and write), list, rotateSecret, testConnection, delete under FORCE RLS
    const saveCtx = makeHttpCtx({
      method: 'POST',
      state: { currentUser: { id: 10 }, currentRole: 'ldx_admin' },
      params: { values: { connectorKey: 'rls-n8n', name: 'RLS n8n', connectorType: 'n8n', baseUrl: 'http://n8n:5678', authType: 'bearer', secrets: { token: 't1' } } },
    });
    await vault.save(saveCtx, async () => {});
    assert.equal(saveCtx.body.connectorKey, 'rls-n8n');

    // Update existing via save -> pre-check findConnectorInOrg must succeed inside RLS TX
    const updateCtx = makeHttpCtx({
      method: 'POST',
      state: { currentUser: { id: 10 }, currentRole: 'ldx_admin' },
      params: { values: { connectorKey: 'rls-n8n', name: 'RLS n8n v2', connectorType: 'n8n', baseUrl: 'http://n8n:5678', authType: 'bearer', secrets: { token: 't2' } } },
    });
    await vault.save(updateCtx, async () => {});
    assert.equal(updateCtx.body.secretVersion, 2);

    const listTenantCtx = makeHttpCtx({ method: 'GET', state: { currentUser: { id: 10 }, currentRole: 'ldx_admin' } });
    await vault.list(listTenantCtx, async () => {});
    assert.equal(listTenantCtx.body.items.length, 1);

    const listRootAllCtx = makeHttpCtx({ method: 'GET', state: { currentUser: { id: 1 }, currentRole: 'root' } });
    await vault.list(listRootAllCtx, async () => {});
    assert.equal(listRootAllCtx.body.items.length, 1);

    const rotCtx = makeHttpCtx({
      method: 'POST',
      state: { currentUser: { id: 10 }, currentRole: 'ldx_admin' },
      params: { values: { connectorKey: 'rls-n8n', secrets: { token: 't3' } } },
    });
    await vault.rotateSecret(rotCtx, async () => {});
    assert.equal(rotCtx.body.secretVersion, 3);

    const testCtx = makeHttpCtx({
      method: 'POST',
      state: { currentUser: { id: 10 }, currentRole: 'ldx_admin' },
      params: { values: { connectorKey: 'rls-n8n' } },
    });
    await vault.testConnection(testCtx, async () => {});
    assert.equal(testCtx.body.ok, true);
    assert.equal(probeEvents.length, 1);
    assert.equal(probeEvents[0].openTxCountDuringHttp, 0);
    assert.equal(rows[0].lastTestStatus, 'ok');

    const delCtx = makeHttpCtx({
      method: 'POST',
      state: { currentUser: { id: 10 }, currentRole: 'ldx_admin' },
      params: { values: { connectorKey: 'rls-n8n' } },
    });
    await vault.delete(delCtx, async () => {});
    assert.equal(delCtx.body.deleted, true);
    assert.equal(rows.length, 0);

    // 2. oauthCallback split TX: TX1 consumes nonce, outbound fetch runs with openTxs.size === 0, TX2 saves tokens
    const nowEpochMs = 1_800_000_000_000;
    const startRes = await oauthStart(db, {
      organizationId: 'org-a',
      connectorKey: 'gmail-rls',
      name: 'Gmail RLS',
      appType: 'gmail_oauth2',
      clientId: 'cid-rls',
      clientSecret: 'csec-rls',
      redirectUri: 'https://app.latticedx.example.com/api/dxosVault:oauthCallback',
    }, { env: vaultEnv, nowMs: nowEpochMs });

    const oauthFetchObservations = [];
    const txCountBeforeCb = txCounter;
    const cbRes = await oauthCallback(db, {
      organizationId: 'org-a',
      connectorKey: 'gmail-rls',
      code: 'code-rls-1',
      state: startRes.state,
    }, {
      env: vaultEnv,
      nowMs: nowEpochMs,
      lookupImpl: async () => [{ address: '142.250.190.10', family: 4 }],
      fetchImpl: async (url) => {
        oauthFetchObservations.push({
          url,
          openTxCountDuringHttp: openTxs.size,
          nonceAlreadyCleared: rows[0].oauthStateNonce === null,
        });
        assert.equal(openTxs.size, 0, 'oauthCallback fetchImpl must NOT run inside an open DB transaction');
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            access_token: 'ya29.rls-access',
            refresh_token: '1//rls-refresh',
            expires_in: 300,
          }),
        };
      },
    });
    assert.equal(cbRes.connected, true);
    assert.equal(oauthFetchObservations.length, 1);
    assert.equal(oauthFetchObservations[0].openTxCountDuringHttp, 0);
    assert.equal(oauthFetchObservations[0].nonceAlreadyCleared, true);
    assert.equal(txCounter - txCountBeforeCb, 2, 'oauthCallback must execute two short DB transactions (TX1 nonce consume, TX2 token save)');
    assert.equal(decryptSecretText(rows[0].oauthAccessTokenEnc, vaultEnv), 'ya29.rls-access');

    // 3. Single-flight key normalization: concurrent calls mixing id (number/string) & connectorKey (lower/upper) trigger ONLY 1 HTTP refresh
    let refreshFetches = 0;
    let releaseRefresh;
    const gate = new Promise((r) => { releaseRefresh = r; });
    const nearExpiry = nowEpochMs + 200 * 1000; // 100s left < 180s buffer
    const connRowId = rows[0].id;
    const mixedPromises = [
      getFreshConnectorToken(db, connRowId, {
        organizationId: 'org-a',
        env: vaultEnv,
        nowMs: nearExpiry,
        lookupImpl: async () => [{ address: '142.250.190.10', family: 4 }],
        fetchImpl: async () => {
          refreshFetches += 1;
          assert.equal(openTxs.size, 0);
          await gate;
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ access_token: 'ya29.shared-flight', refresh_token: '1//rot-2', expires_in: 3600 }),
          };
        },
      }),
      getFreshConnectorToken(db, 'gmail-rls', {
        organizationId: 'org-a',
        env: vaultEnv,
        nowMs: nearExpiry,
        lookupImpl: async () => [{ address: '142.250.190.10', family: 4 }],
        fetchImpl: async () => { refreshFetches += 1; throw new Error('duplicate refresh for connectorKey'); },
      }),
      getFreshConnectorToken(db, 'GMAIL-RLS', {
        organizationId: 'org-a',
        env: vaultEnv,
        nowMs: nearExpiry,
        lookupImpl: async () => [{ address: '142.250.190.10', family: 4 }],
        fetchImpl: async () => { refreshFetches += 1; throw new Error('duplicate refresh for uppercase connectorKey'); },
      }),
      getFreshConnectorToken(db, String(connRowId), {
        env: vaultEnv,
        nowMs: nearExpiry,
        lookupImpl: async () => [{ address: '142.250.190.10', family: 4 }],
        fetchImpl: async () => { refreshFetches += 1; throw new Error('duplicate refresh for string id'); },
      }),
    ];
    await new Promise((r) => setTimeout(r, 20));
    releaseRefresh();
    const mixedResults = await Promise.all(mixedPromises);
    assert.equal(refreshFetches, 1);
    for (const r of mixedResults) {
      assert.equal(r.accessToken, 'ya29.shared-flight');
    }
  } finally {
    if (prevFlag === undefined) delete process.env.DX_PG_RLS_SESSION;
    else process.env.DX_PG_RLS_SESSION = prevFlag;
  }
});
