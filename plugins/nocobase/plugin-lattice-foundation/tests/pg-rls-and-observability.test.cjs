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
const { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
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

test('pg-rls defines all 42 tenant-scoped tables, validates identifiers strictly, and parameterizes set_config', async () => {
  const pgRls = require('../src/server/pg-rls');

  assert.equal(pgRls.TENANT_RLS_TABLES.length, 42);
  for (const required of [
    'latticeRequests', 'latticeOrders', 'latticeAssets', 'latticeEmployees',
    'latticeDepartments', 'latticeLocations', 'latticeIncidentCases', 'latticeIncidentRules',
    'latticeAgentProposals', 'latticeContextOutbox', 'latticeIntegrationInbox',
    'latticeRecordChatter', 'latticeNotifications', 'latticeSlaPolicies',
    'latticeParaDocuments', 'latticeParaChunks', 'latticeServiceTickets',
    'latticeAiProfiles', 'latticeAiAuditLogs', 'latticeAiQuotaUsage',
    'latticeAiApprovalQueue', 'latticeTelemetryPoints',
    'latticeApiKeys', 'latticePkiKeys', 'latticeCryptoLedger',
    'latticeFrozenSnapshots', 'latticeDataLineage', 'latticeDataQuarantine',
    'latticeOrderLines', 'latticeStockLots', 'latticeEpodRecords',
    'latticeDecisionTables', 'latticeDelegations', 'latticeTwinShadows',
    'latticeConnectors', 'latticeEventBus', 'latticeWebhookSubscriptions',
    'latticeWebhookDeliveries', 'latticeIotDevices', 'latticeBrokerSubscriptions',
    'latticeAutomationRules', 'latticeAutomationRuns',
  ]) {
    assert.ok(pgRls.TENANT_RLS_TABLES.includes(required), `Missing RLS table ${required}`);
  }

  for (const badIdent of ['', 'latticeRequests; DROP TABLE users;--', 'foo"bar', '1bad', 'foo-bar', 'public.latticeRequests', null, 123]) {
    assert.throws(() => pgRls.assertSafeSqlIdentifier(badIdent), { code: 'INVALID_SQL_IDENTIFIER' });
  }
  assert.equal(pgRls.assertSafeSqlIdentifier('latticeCustomColdAudits_01'), 'latticeCustomColdAudits_01');

  // withTenantRlsContext rejects invalid/wildcard/empty org IDs fail-closed
  const queries = [];
  const fakeTx = { id: 'tx-rls-1' };
  const pgDb = {
    sequelize: {
      getDialect: () => 'postgres',
      transaction: async (cb) => cb(fakeTx),
      query: async (sql, opts) => {
        queries.push({ sql, opts });
        return [[]];
      },
    },
  };

  for (const badOrg of ['', '*', 'org-a; DROP TABLE users', null, undefined, 'org a']) {
    await assert.rejects(() => pgRls.withTenantRlsContext(pgDb, badOrg, async () => 'nope'), { code: 'INVALID_RLS_ORGANIZATION' });
  }
  assert.equal(queries.length, 0);

  const out = await pgRls.withTenantRlsContext(pgDb, 'org-alpha_01', async (tx) => {
    assert.equal(tx, fakeTx);
    return 42;
  });
  assert.equal(out, 42);
  assert.equal(queries.length, 1);
  assert.equal(queries[0].sql, "SELECT set_config('app.current_org', :orgId, true)");
  assert.deepEqual(queries[0].opts.replacements, { orgId: 'org-alpha_01' });
  assert.equal(queries[0].opts.transaction, fakeTx);
  assert.equal(queries[0].sql.includes('org-alpha_01'), false);

  // setTransactionRlsOrg fails closed when transaction is missing
  await assert.rejects(() => pgRls.setTransactionRlsOrg(pgDb, 'org-alpha_01', null), { code: 'RLS_TRANSACTION_UNAVAILABLE' });

  // Non-postgres dialect skips set_config cleanly while running transaction callback
  const sqliteQueries = [];
  const sqliteDb = {
    sequelize: {
      getDialect: () => 'sqlite',
      transaction: async (cb) => cb(fakeTx),
      query: async (sql) => { sqliteQueries.push(sql); },
    },
  };
  const sqliteOut = await pgRls.withTenantRlsContext(sqliteDb, 'org-alpha_01', async () => 'ok');
  assert.equal(sqliteOut, 'ok');
  assert.equal(sqliteQueries.length, 0);
});

test('installRlsTransactionBridge injects active AsyncLocalStorage transaction into Repository and sequelize.query without mutating frozen options', async () => {
  const pgRls = require('../src/server/pg-rls');
  const { createNativeScopeMiddleware } = require('../src/server/native-scope');
  const prevFlag = process.env.DX_PG_RLS_SESSION;

  const repoCalls = [];
  const seqCalls = [];
  const fakeTx = { id: 'tx-bridge-1' };

  class FakeRepository {
    constructor(database) { this.database = database; }
    async find(opts) { repoCalls.push({ method: 'find', opts }); return []; }
    async findOne(opts) { repoCalls.push({ method: 'findOne', opts }); return null; }
    async create(opts) { repoCalls.push({ method: 'create', opts }); return { id: 1 }; }
    async update(opts) { repoCalls.push({ method: 'update', opts }); return [{ id: 1 }]; }
    async query(arg0, arg1) { repoCalls.push({ method: 'query', arg0, arg1 }); return []; }
  }

  const employee = { id: 1, userId: 12, organizationId: 'org-a', departmentId: 3, active: true };
  const fakeDb = {
    sequelize: {
      getDialect: () => 'postgres',
      transaction: async (cb) => cb(fakeTx),
      query: async (sql, opts) => {
        seqCalls.push({ sql, opts });
        return [[]];
      },
    },
    getRepository(name) {
      if (name === 'latticeEmployees') {
        return { find: async () => [{ get: (k) => employee[k] }] };
      }
      if (name === 'latticeDepartments') {
        return { findOne: async (opts) => { repoCalls.push({ method: 'deptFindOne', opts }); return { id: 3 }; } };
      }
      if (name === 'latticeAssets') {
        return { findOne: async (opts) => { repoCalls.push({ method: 'assetFindOne', opts }); return { id: 9, version: 1 }; } };
      }
      return new FakeRepository(fakeDb);
    },
  };

  assert.equal(pgRls.installRlsTransactionBridge(fakeDb, FakeRepository), true);
  // Idempotent on second call
  assert.equal(pgRls.installRlsTransactionBridge(fakeDb, FakeRepository), true);

  const repo = fakeDb.getRepository('latticeOrders');
  const frozenOpts = Object.freeze({ filter: { status: 'draft' } });

  // Outside RLS context, no transaction injected
  await repo.find(frozenOpts);
  assert.equal(repoCalls.at(-1).opts, frozenOpts);
  assert.equal(repoCalls.at(-1).opts.transaction, undefined);

  // Inside withTenantRlsContext, Repository & sequelize.query receive store.transaction
  await pgRls.withTenantRlsContext(fakeDb, 'org-a', async () => {
    await repo.find(frozenOpts);
    assert.equal(repoCalls.at(-1).opts.transaction, fakeTx);
    assert.equal(frozenOpts.transaction, undefined);

    await repo.create({ values: { code: 'ORD-1' } });
    assert.equal(repoCalls.at(-1).opts.transaction, fakeTx);

    await repo.update({ filterByTk: 1, values: { name: 'Updated' } });
    assert.equal(repoCalls.at(-1).opts.transaction, fakeTx);

    await repo.query('SELECT 1', frozenOpts);
    assert.equal(repoCalls.at(-1).arg0, 'SELECT 1');
    assert.equal(repoCalls.at(-1).arg1.transaction, fakeTx);

    await repo.query({ raw: true });
    assert.equal(repoCalls.at(-1).arg0.transaction, fakeTx);

    await fakeDb.sequelize.query('SELECT count(*) FROM "latticeOrders"', frozenOpts);
    assert.equal(seqCalls.at(-1).opts.transaction, fakeTx);
  });

  // Middleware pre-checks (asset version & belongsTo) AND downstream next() repo calls run inside RLS tx
  try {
    process.env.DX_PG_RLS_SESSION = 'true';
    repoCalls.length = 0;
    seqCalls.length = 0;
    const guard = createNativeScopeMiddleware(fakeDb, {
      assets: {
        name: 'latticeAssets',
        fields: [{ name: 'department', type: 'belongsTo', foreignKey: 'departmentId', target: 'latticeDepartments' }],
      },
      departments: { name: 'latticeDepartments', fields: [] },
    });
    const ctx = {
      state: { currentUser: { id: 12 }, currentRole: 'ldx_employee' },
      action: {
        resourceName: 'latticeAssets',
        actionName: 'update',
        params: { filterByTk: 9, values: { name: 'Cold Unit', departmentId: 3, expectedVersion: 1 } },
      },
    };
    await guard(ctx, async () => {
      await fakeDb.getRepository('latticeOrders').find({ filter: {} });
    });
    assert.equal(seqCalls[0].sql, "SELECT set_config('app.current_org', :orgId, true)");
    assert.equal(repoCalls.find((c) => c.method === 'assetFindOne').opts.transaction, fakeTx);
    assert.equal(repoCalls.find((c) => c.method === 'deptFindOne').opts.transaction, fakeTx);
    assert.equal(repoCalls.find((c) => c.method === 'find').opts.transaction, fakeTx);
  } finally {
    if (prevFlag === undefined) delete process.env.DX_PG_RLS_SESSION;
    else process.env.DX_PG_RLS_SESSION = prevFlag;
  }
});

test('attachRlsPolicyToTable and migration 20261123000600 emit valid permissive PostgreSQL RLS DDL and reversible down()', async () => {
  await withMockedNocobase(async () => {
    const pgRls = require('../src/server/pg-rls');
    const migPath = require.resolve('../src/server/migrations/20261123000600-postgresql-rls-policies');
    delete require.cache[migPath];
    const Migration = require('../src/server/migrations/20261123000600-postgresql-rls-policies');

    const ddl = [];
    const fakeTx = { id: 'tx-mig' };
    const fakeDb = {
      sequelize: {
        getDialect: () => 'postgres',
        transaction: async (cb) => cb(fakeTx),
        query: async (sql, opts) => {
          ddl.push({ sql, opts });
          if (sql.includes('information_schema.columns')) {
            return [[
              { table_name: 'latticeRequests' },
              { table_name: 'latticeNotifications' },
              { table_name: 'latticeCustomColdAudits' },
            ]];
          }
          return [[]];
        },
      },
    };

    const single = await pgRls.attachRlsPolicyToTable(fakeDb, 'latticeOrders', { transaction: fakeTx });
    assert.equal(single.applied, true);
    assert.match(ddl[0].sql, /ALTER TABLE public\."latticeOrders" ENABLE ROW LEVEL SECURITY/);
    assert.match(ddl[1].sql, /DROP POLICY IF EXISTS lattice_tenant_isolation ON public\."latticeOrders"/);
    assert.match(ddl[2].sql, /CREATE POLICY lattice_tenant_isolation ON public\."latticeOrders"/);
    assert.match(ddl[2].sql, /AS PERMISSIVE FOR ALL TO PUBLIC/);
    assert.match(ddl[2].sql, /current_setting\('app\.current_org', true\) IS NULL/);
    assert.match(ddl[2].sql, /"organizationId" = current_setting\('app\.current_org', true\)/);
    assert.match(ddl[2].sql, /WITH CHECK \(/);

    ddl.length = 0;
    const migration = new Migration({ db: fakeDb });
    assert.equal(migration.on, 'afterSync');
    await migration.up();

    const joinedUp = ddl.map((d) => d.sql).join('\n');
    assert.match(joinedUp, /information_schema\.columns/);
    assert.match(joinedUp, /ALTER TABLE public\."latticeRequests" ENABLE ROW LEVEL SECURITY/);
    assert.match(joinedUp, /ALTER TABLE public\."latticeNotifications" ENABLE ROW LEVEL SECURITY/);
    assert.match(joinedUp, /ALTER TABLE public\."latticeCustomColdAudits" ENABLE ROW LEVEL SECURITY/);
    assert.equal(joinedUp.includes('"latticeAssets"'), false, 'must not alter unsynced tables absent from information_schema.columns');

    ddl.length = 0;
    await migration.down();
    const joinedDown = ddl.map((d) => d.sql).join('\n');
    assert.match(joinedDown, /DROP POLICY IF EXISTS lattice_tenant_isolation ON public\."latticeRequests"/);
    assert.match(joinedDown, /ALTER TABLE IF EXISTS public\."latticeRequests" DISABLE ROW LEVEL SECURITY/);
    assert.match(joinedDown, /DROP POLICY IF EXISTS lattice_tenant_isolation ON public\."latticeCustomColdAudits"/);
    assert.match(joinedDown, /ALTER TABLE IF EXISTS public\."latticeCustomColdAudits" DISABLE ROW LEVEL SECURITY/);

    // Non-postgres dialect is safely skipped
    ddl.length = 0;
    const sqliteMigration = new Migration({
      db: { sequelize: { getDialect: () => 'sqlite', transaction: async () => { throw new Error('should not run'); } } },
    });
    await sqliteMigration.up();
    await sqliteMigration.down();
  });
});

test('native-scope sets ctx.state.latticeRlsOrg and executes withTenantRlsContext when DX_PG_RLS_SESSION=true', async () => {
  const { createNativeScopeMiddleware } = require('../src/server/native-scope');
  const prevFlag = process.env.DX_PG_RLS_SESSION;
  const sqlCalls = [];
  const fakeTx = { LOCK: { UPDATE: 'UPDATE' }, id: 'tx-scope' };
  const employee = { id: 1, userId: 12, organizationId: 'org-a', departmentId: 3, active: true };
  const db = {
    sequelize: {
      getDialect: () => 'postgres',
      transaction: async (cb) => cb(fakeTx),
      query: async (sql, opts) => {
        sqlCalls.push({ sql, opts });
        return [[]];
      },
    },
    getRepository: (name) => {
      assert.equal(name, 'latticeEmployees');
      return {
        find: async () => [{ get: (k) => employee[k] }],
      };
    },
  };

  try {
    process.env.DX_PG_RLS_SESSION = 'false';
    const guard = createNativeScopeMiddleware(db, { assets: { name: 'latticeAssets', fields: [] } });
    const ctxOff = { state: { currentUser: { id: 12 }, currentRole: 'ldx_employee' }, action: { resourceName: 'latticeAssets', actionName: 'list', params: {} } };
    await guard(ctxOff, async () => {});
    assert.equal(ctxOff.state.latticeRlsOrg, 'org-a');
    assert.equal(sqlCalls.length, 0);

    process.env.DX_PG_RLS_SESSION = 'true';
    const circularSeq = {};
    circularSeq.dialect = { sequelize: circularSeq };
    fakeTx.sequelize = circularSeq;
    const ctxOn = { state: { currentUser: { id: 12 }, currentRole: 'ldx_employee' }, action: { resourceName: 'latticeAssets', actionName: 'list', params: {} } };
    let sawTxInsideNext = null;
    let stateSerialized = null;
    await guard(ctxOn, async () => {
      sawTxInsideNext = ctxOn.state.latticeRlsTransaction;
      stateSerialized = JSON.parse(JSON.stringify(ctxOn.state));
    });
    assert.equal(ctxOn.state.latticeRlsOrg, 'org-a');
    assert.equal(sawTxInsideNext, fakeTx);
    assert.equal(Object.getOwnPropertyDescriptor(ctxOn.state, 'latticeRlsTransaction').enumerable, false);
    assert.equal(stateSerialized.latticeRlsOrg, 'org-a');
    assert.equal('latticeRlsTransaction' in stateSerialized, false);
    assert.equal(sqlCalls.length, 1);
    assert.equal(sqlCalls[0].sql, "SELECT set_config('app.current_org', :orgId, true)");
    assert.deepEqual(sqlCalls[0].opts.replacements, { orgId: 'org-a' });

    // Root bypasses actor resolution and does not lock tenant RLS org
    sqlCalls.length = 0;
    const rootCtx = { state: { currentUser: { id: 1 }, currentRole: 'root' }, action: { resourceName: 'latticeAssets', actionName: 'list', params: {} } };
    await guard(rootCtx, async () => {});
    assert.equal(rootCtx.state.latticeRlsOrg, undefined);
    assert.equal(sqlCalls.length, 0);

    // charts:queryData & updateScopedDocument also bind app.current_org when DX_PG_RLS_SESSION=true
    sqlCalls.length = 0;
    const chartCtx = {
      state: { currentUser: { id: 12 }, currentRole: 'ldx_employee' },
      action: { resourceName: 'charts', actionName: 'queryData', params: { values: { mode: 'builder', collection: 'latticeAssets', filter: {} } } },
    };
    await guard(chartCtx, async () => {});
    assert.equal(chartCtx.state.latticeRlsOrg, 'org-a');
    assert.equal(sqlCalls.length, 1);
    assert.deepEqual(sqlCalls[0].opts.replacements, { orgId: 'org-a' });

    const { updateScopedDocument } = require('../src/server/native-scope');
    sqlCalls.length = 0;
    const docDb = {
      sequelize: {
        getDialect: () => 'postgres',
        transaction: async (cb) => cb(fakeTx),
        query: async (sql, opts) => { sqlCalls.push({ sql, opts }); return [[]]; },
      },
      getModel: () => ({ findOne: async () => ({ id: 5, organizationId: 'org-a', status: 'draft', version: 1 }) }),
      getRepository: () => ({ update: async () => [{ id: 5, version: 2 }] }),
    };
    await updateScopedDocument(
      docDb,
      { action: { resourceName: 'latticeRequests', params: { filterByTk: 5, filter: { organizationId: 'org-a' }, values: { name: 'RLS Doc' } } } },
      { organizationId: 'org-a', employeeId: 1 },
    );
    assert.equal(sqlCalls.length, 1);
    assert.equal(sqlCalls[0].sql, "SELECT set_config('app.current_org', :orgId, true)");
    assert.deepEqual(sqlCalls[0].opts.replacements, { orgId: 'org-a' });
  } finally {
    if (prevFlag === undefined) delete process.env.DX_PG_RLS_SESSION;
    else process.env.DX_PG_RLS_SESSION = prevFlag;
  }
});

test('observability middleware enforces security headers, strict CORS allowlist, and bounded Prometheus metrics', async () => {
  const { createObservabilityMiddleware, createMetricsRegistry } = require('../src/server/observability');

  function makeHttpCtx({ method = 'GET', origin = '', host = 'localhost:13014', initialStatus = 200, downstreamCorsOrigin } = {}) {
    const resHeaders = {};
    if (downstreamCorsOrigin) resHeaders['Access-Control-Allow-Origin'] = downstreamCorsOrigin;
    return {
      method,
      status: initialStatus,
      headers: { host, ...(origin ? { origin } : {}) },
      request: { headers: { host, ...(origin ? { origin } : {}) } },
      response: { headers: resHeaders },
      get(name) { return this.headers[String(name).toLowerCase()] || ''; },
      set(name, val) { this.response.headers[name] = val; },
      remove(name) {
        const lower = String(name).toLowerCase();
        for (const k of Object.keys(this.response.headers)) {
          if (k.toLowerCase() === lower) delete this.response.headers[k];
        }
      },
      state: {},
    };
  }

  const registry = createMetricsRegistry();
  const mw = createObservabilityMiddleware(registry, {
    env: { DX_CORS_STRICT: 'true', DX_CORS_ALLOWED_ORIGINS: 'https://portal.example.com' },
  });

  // Same-origin localhost:13014 keeps reflected CORS header + sets security headers
  const sameCtx = makeHttpCtx({ origin: 'http://localhost:13014', host: 'localhost:13014' });
  await mw(sameCtx, async () => {
    sameCtx.set('Access-Control-Allow-Origin', 'http://localhost:13014');
    sameCtx.set('Access-Control-Allow-Credentials', 'true');
    sameCtx.status = 200;
  });
  assert.equal(sameCtx.response.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(sameCtx.response.headers['X-Frame-Options'], 'SAMEORIGIN');
  assert.equal(sameCtx.response.headers['Referrer-Policy'], 'strict-origin-when-cross-origin');
  assert.equal(sameCtx.response.headers['Access-Control-Allow-Origin'], 'http://localhost:13014');

  // Loopback equivalent 127.0.0.1:13014 <-> localhost:13014 allowed
  const loopbackCtx = makeHttpCtx({ origin: 'http://127.0.0.1:13014', host: 'localhost:13014' });
  await mw(loopbackCtx, async () => {
    loopbackCtx.set('Access-Control-Allow-Origin', 'http://127.0.0.1:13014');
    loopbackCtx.status = 204;
  });
  assert.equal(loopbackCtx.response.headers['Access-Control-Allow-Origin'], 'http://127.0.0.1:13014');

  // Allowlisted origin permitted
  const allowCtx = makeHttpCtx({ origin: 'https://portal.example.com', host: 'api.internal' });
  await mw(allowCtx, async () => {
    allowCtx.set('Access-Control-Allow-Origin', 'https://portal.example.com');
    allowCtx.status = 201;
  });
  assert.equal(allowCtx.response.headers['Access-Control-Allow-Origin'], 'https://portal.example.com');

  // Foreign untrusted origin has Access-Control-Allow-* headers stripped
  const evilCtx = makeHttpCtx({ origin: 'https://evil.example.com', host: 'localhost:13014' });
  await mw(evilCtx, async () => {
    evilCtx.set('Access-Control-Allow-Origin', 'https://evil.example.com');
    evilCtx.set('Access-Control-Allow-Credentials', 'true');
    evilCtx.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    evilCtx.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    evilCtx.status = 200;
  });
  assert.equal(evilCtx.response.headers['Access-Control-Allow-Origin'], undefined);
  assert.equal(evilCtx.response.headers['Access-Control-Allow-Credentials'], undefined);
  assert.equal(evilCtx.response.headers['Access-Control-Allow-Methods'], undefined);
  assert.equal(evilCtx.response.headers['Access-Control-Allow-Headers'], undefined);
  assert.equal(evilCtx.response.headers['X-Content-Type-Options'], 'nosniff');

  // Thrown downstream 403 error still records 4xx metric and security headers
  const errCtx = makeHttpCtx({ method: 'POST', origin: 'https://evil.example.com', host: 'localhost:13014' });
  await assert.rejects(
    () => mw(errCtx, async () => {
      errCtx.set('Access-Control-Allow-Origin', '*');
      throw Object.assign(new Error('Forbidden'), { status: 403 });
    }),
    { status: 403 },
  );
  assert.equal(errCtx.response.headers['Access-Control-Allow-Origin'], undefined);

  const prom = await registry.formatPrometheusMetrics(null);
  assert.match(prom, /latticedx_http_requests_total\{method="GET",status_class="2xx"\} 4/);
  assert.match(prom, /latticedx_http_requests_total\{method="POST",status_class="4xx"\} 1/);
  assert.match(prom, /latticedx_http_request_duration_seconds_bucket\{le="0\.025"\}/);
  assert.match(prom, /latticedx_http_request_duration_seconds_bucket\{le="0\.1"\}/);
  assert.match(prom, /latticedx_http_request_duration_seconds_bucket\{le="0\.5"\}/);
  assert.match(prom, /latticedx_http_request_duration_seconds_bucket\{le="2\.0"\}/);
  assert.match(prom, /latticedx_http_request_duration_seconds_bucket\{le="\+Inf"\} 5/);
  assert.match(prom, /latticedx_http_request_duration_seconds_count 5/);
  // Fault-tolerant DB gauges degrade to 0 when DB is absent
  assert.match(prom, /latticedx_ai_audit_logs_total 0/);
  assert.match(prom, /latticedx_outbox_by_state\{state="pending"\} 0/);
  assert.match(prom, /latticedx_active_alarms_total 0/);
  assert.match(prom, /latticedx_unread_notifications_total 0/);
  assert.match(prom, /latticedx_sla_policies_active 0/);
});

test('dxos:health and dxos:metrics enforce fail-closed auth, timing-safe token, role check, and live DB gauges', async () => {
  const { registerObservability } = require('../src/server/observability');

  const resources = new Map();
  const aclAllows = [];
  const middlewares = [];
  const counts = {
    latticeAiAuditLogs: 14,
    latticeContextOutbox: { pending: 3, retry: 1, processing: 0, delivered: 20, failed: 2 },
    latticeIncidentCases: 4,
    latticeNotifications: 7,
    latticeSlaPolicies: 5,
  };

  let dbHealthy = true;
  const db = {
    sequelize: {
      query: async () => {
        if (!dbHealthy) throw new Error('Connection refused');
        return [[{ '?column?': 1 }]];
      },
    },
    getRepository(name) {
      if (name === 'rolesUsers') {
        return {
          find: async ({ filter }) => {
            if (Number(filter.userId) === 1) return [{ roleName: 'root' }];
            if (Number(filter.userId) === 2) return [{ roleName: 'ldx_admin' }];
            if (Number(filter.userId) === 3) return [{ roleName: 'ldx_employee' }];
            return [];
          },
        };
      }
      if (name === 'latticeContextOutbox') {
        return {
          count: async ({ filter } = {}) => counts.latticeContextOutbox[filter?.state] ?? 0,
        };
      }
      if (name === 'latticeNotifications') {
        return {
          count: async () => { throw new Error('table not migrated yet'); },
        };
      }
      if (name in counts) {
        return { count: async () => counts[name] };
      }
      return null;
    },
  };

  const app = {
    db,
    use(fn, opts) { middlewares.push({ fn, opts }); },
    resourceManager: { define(def) { resources.set(def.name, def.actions); } },
    acl: { allow(...args) { aclAllows.push(args); } },
    authManager: {
      middleware() {
        return async (ctx, next) => {
          const auth = ctx.headers?.authorization || '';
          if (auth === 'Bearer user-jwt-admin') {
            ctx.state.currentUser = { id: 2, username: 'org-admin' };
          } else if (auth === 'Bearer user-jwt-employee') {
            ctx.state.currentUser = { id: 3, username: 'staff' };
          }
          await next();
        };
      },
    },
  };

  const env = { DX_METRICS_TOKEN: 'secret-metrics-token-42' };
  registerObservability(app, { env });

  assert.equal(middlewares.length, 1);
  assert.ok(aclAllows.some(([res, actions, perm]) => res === 'dxos' && actions.includes('health') && actions.includes('metrics') && perm === 'public'));

  const dxos = resources.get('dxos');
  assert.ok(dxos?.health && dxos?.metrics);

  const makeCtx = ({ method = 'GET', auth = '', headers = {}, state = {} } = {}) => {
    const resHeaders = {};
    return {
      method,
      headers: { ...(auth ? { authorization: auth } : {}), ...headers },
      request: { headers: { ...(auth ? { authorization: auth } : {}), ...headers } },
      response: { headers: resHeaders },
      state: { ...state },
      get(k) { return this.headers[String(k).toLowerCase()] || ''; },
      set(k, v) { this.response.headers[k] = v; },
      throw(status, msg) { throw Object.assign(new Error(msg || `HTTP ${status}`), { status }); },
    };
  };

  // Health OK and degraded
  const healthCtx = makeCtx();
  await dxos.health(healthCtx, async () => {});
  assert.equal(healthCtx.body.status, 'ok');
  assert.equal(healthCtx.body.dbHealthy, true);
  assert.equal(typeof healthCtx.body.version, 'string');
  assert.equal(typeof healthCtx.body.uptimeSec, 'number');

  dbHealthy = false;
  const degradedCtx = makeCtx();
  await dxos.health(degradedCtx, async () => {});
  assert.equal(degradedCtx.status, 503);
  assert.equal(degradedCtx.body.status, 'degraded');
  assert.equal(degradedCtx.body.dbHealthy, false);
  dbHealthy = true;

  // Metrics fail-closed: unauthenticated -> 401; wrong token -> 401; even when DX_METRICS_TOKEN is unset!
  await assert.rejects(() => dxos.metrics(makeCtx(), async () => {}), { status: 401 });
  await assert.rejects(() => dxos.metrics(makeCtx({ auth: 'Bearer wrong-token' }), async () => {}), { status: 401 });

  delete env.DX_METRICS_TOKEN;
  await assert.rejects(() => dxos.metrics(makeCtx(), async () => {}), { status: 401 });
  env.DX_METRICS_TOKEN = 'secret-metrics-token-42';

  // Employee with spoofed X-Role: root still denied 403
  await assert.rejects(
    () => dxos.metrics(makeCtx({ auth: 'Bearer user-jwt-employee', headers: { 'x-role': 'root' } }), async () => {}),
    { status: 403 },
  );

  // Valid DX_METRICS_TOKEN returns 200 text/plain Prometheus exposition + withoutDataWrapping=true
  const tokenCtx = makeCtx({ auth: 'Bearer secret-metrics-token-42' });
  await dxos.metrics(tokenCtx, async () => {});
  assert.equal(tokenCtx.withoutDataWrapping, true);
  assert.equal(tokenCtx.response.headers['Content-Type'], 'text/plain; version=0.0.4; charset=utf-8');
  assert.match(tokenCtx.body, /latticedx_ai_audit_logs_total 14/);
  assert.match(tokenCtx.body, /latticedx_outbox_by_state\{state="pending"\} 3/);
  assert.match(tokenCtx.body, /latticedx_outbox_by_state\{state="failed"\} 2/);
  assert.match(tokenCtx.body, /latticedx_active_alarms_total 4/);
  assert.match(tokenCtx.body, /latticedx_unread_notifications_total 0/); // degraded cleanly on throw
  assert.match(tokenCtx.body, /latticedx_sla_policies_active 5/);

  // Authenticated ldx_admin via authManager allowed
  const adminCtx = makeCtx({ auth: 'Bearer user-jwt-admin' });
  await dxos.metrics(adminCtx, async () => {});
  assert.equal(adminCtx.withoutDataWrapping, true);
  assert.match(adminCtx.body, /latticedx_ai_audit_logs_total 14/);

  // Authenticated root allowed
  const rootCtx = makeCtx({ state: { currentUser: { id: 1 }, currentRole: 'root' } });
  await dxos.metrics(rootCtx, async () => {});
  assert.equal(rootCtx.withoutDataWrapping, true);
});

test('dxos:metrics resolves admin JWT when ACL is public (ctx.auth.skipCheck() === true) and checks DX_METRICS_TOKEN before JWT parsing', async () => {
  const { registerObservability } = require('../src/server/observability');

  const resources = new Map();
  let authCheckCalls = 0;
  const db = {
    sequelize: { query: async () => [[1]] },
    getRepository(name) {
      if (name === 'rolesUsers') {
        return {
          find: async ({ filter }) => {
            if (Number(filter.userId) === 1) return [{ roleName: 'root' }];
            if (Number(filter.userId) === 2) return [{ roleName: 'ldx_admin' }];
            if (Number(filter.userId) === 3) return [{ roleName: 'ldx_employee' }];
            return [];
          },
        };
      }
      return null;
    },
  };

  // Simulate NocoBase AuthManager.middleware() skipping ctx.auth.check() on public routes!
  const authManager = {
    defaultAuthenticator: 'basic',
    middleware() {
      return async (ctx, next) => {
        if (ctx.auth?.skipCheck && (await ctx.auth.skipCheck())) {
          return next();
        }
        return next();
      };
    },
    async get(name, ctx) {
      if (name !== 'custom-sso') return null;
      return {
        async check() {
          const auth = ctx.headers?.authorization || '';
          if (auth === 'Bearer sso-root-jwt') return { id: 1, username: 'sso-root' };
          throw new Error('Invalid SSO JWT');
        },
      };
    },
  };

  const app = {
    db,
    use() {},
    resourceManager: { define(def) { resources.set(def.name, def.actions); } },
    acl: { allow() {} },
    authManager,
  };

  const env = { DX_METRICS_TOKEN: 'prom-scrape-secret' };
  registerObservability(app, { env });
  const dxos = resources.get('dxos');

  const makePublicAclCtx = ({ authHeader = '', xAuth = '', withAuthCheck = true } = {}) => {
    const resHeaders = {};
    const ctx = {
      method: 'GET',
      headers: {
        ...(authHeader ? { authorization: authHeader } : {}),
        ...(xAuth ? { 'x-authenticator': xAuth } : {}),
      },
      request: { headers: {} },
      response: { headers: resHeaders },
      state: {},
      get(k) { return this.headers[String(k).toLowerCase()] || ''; },
      set(k, v) { this.response.headers[k] = v; },
      throw(status, msg, props) { throw Object.assign(new Error(msg || `HTTP ${status}`), { status }, props || {}); },
      auth: withAuthCheck ? {
        skipCheck: async () => true,
        user: null,
        async check() {
          authCheckCalls += 1;
          if (authHeader === 'Bearer valid-admin-jwt') return { id: 2, username: 'ldx-admin' };
          if (authHeader === 'Bearer valid-employee-jwt') return { id: 3, username: 'employee' };
          if (authHeader === 'Bearer expired-jwt') throw new Error('jwt expired');
          return null;
        },
      } : undefined,
    };
    return ctx;
  };

  // 1. DX_METRICS_TOKEN succeeds BEFORE calling ctx.auth.check() (never hits JWT parser)
  const promCtx = makePublicAclCtx({ authHeader: 'Bearer prom-scrape-secret' });
  await authManager.middleware()(promCtx, async () => dxos.metrics(promCtx, async () => {}));
  assert.equal(authCheckCalls, 0);
  assert.equal(promCtx.withoutDataWrapping, true);

  // 2. Even though skipCheck() === true left currentUser empty, valid ldx_admin JWT passes via ctx.auth.check()
  const adminCtx = makePublicAclCtx({ authHeader: 'Bearer valid-admin-jwt' });
  await authManager.middleware()(adminCtx, async () => dxos.metrics(adminCtx, async () => {}));
  assert.equal(authCheckCalls, 1);
  assert.equal(adminCtx.state.currentUser.id, 2);
  assert.equal(adminCtx.auth.user.id, 2);

  // 3. Non-admin employee JWT resolves user via ctx.auth.check() and gets 403 METRICS_FORBIDDEN
  const empCtx = makePublicAclCtx({ authHeader: 'Bearer valid-employee-jwt' });
  await assert.rejects(
    () => authManager.middleware()(empCtx, async () => dxos.metrics(empCtx, async () => {})),
    { status: 403, code: 'METRICS_FORBIDDEN' },
  );

  // 4. Expired/invalid JWT and unauthenticated callers get 401 METRICS_AUTH_REQUIRED
  const expiredCtx = makePublicAclCtx({ authHeader: 'Bearer expired-jwt' });
  await assert.rejects(
    () => authManager.middleware()(expiredCtx, async () => dxos.metrics(expiredCtx, async () => {})),
    { status: 401, code: 'METRICS_AUTH_REQUIRED' },
  );
  await assert.rejects(
    () => dxos.metrics(makePublicAclCtx(), async () => {}),
    { status: 401, code: 'METRICS_AUTH_REQUIRED' },
  );

  // 5. Fallback to app.authManager.get(X-Authenticator) when ctx.auth.check is absent
  const ssoCtx = makePublicAclCtx({ authHeader: 'Bearer sso-root-jwt', xAuth: 'custom-sso', withAuthCheck: false });
  await dxos.metrics(ssoCtx, async () => {});
  assert.equal(ssoCtx.state.currentUser.id, 1);
  assert.equal(ssoCtx.auth.user.id, 1);

  await assert.rejects(
    () => dxos.metrics(makePublicAclCtx({ authHeader: 'Bearer bad-sso-jwt', xAuth: 'custom-sso', withAuthCheck: false }), async () => {}),
    { status: 401, code: 'METRICS_AUTH_REQUIRED' },
  );
});

test('CodeQL remediation: build.mjs bundles use top-level __deps, full-backup-core uses DX_RESTORE_ARG_JSON, backup-policy avoids lstat-open race', async () => {
  const buildFiles = [
    'plugins/nocobase/plugin-lattice-foundation/scripts/build.mjs',
    'plugins/nocobase/plugin-dxos-ai/build.mjs',
    'plugins/nocobase/plugin-dxos-blocks/build.mjs',
    'plugins/nocobase/plugin-dxos-studio/build.mjs',
  ];
  for (const rel of buildFiles) {
    const src = readFileSync(join(REPO_ROOT, rel), 'utf8');
    assert.match(src, /const __deps = /, `${rel} must emit top-level const __deps`);
    assert.match(src, /__modules\[id\]\(module,\s*module\.exports,\s*id\)/, `${rel} must pass id into __modules[id]`);
    assert.equal(/\$\{JSON\.stringify\((?:dependencies|deps)\)\}/.test(src), false, `${rel} must not interpolate deps JSON into wrapper function string`);
  }

  const backupCoreSrc = readFileSync(join(REPO_ROOT, 'scripts/full-backup-core.mjs'), 'utf8');
  assert.match(backupCoreSrc, /DX_RESTORE_ARG_JSON/);
  assert.equal(/\$\{JSON\.stringify\(/.test(backupCoreSrc), false, 'full-backup-core.mjs must not template-interpolate JSON.stringify into tsx --eval code strings');

  const policySrc = readFileSync(join(REPO_ROOT, 'scripts/lib/backup-policy.mjs'), 'utf8');
  assert.match(policySrc, /O_NOFOLLOW/);
  assert.match(policySrc, /fstatSync/);
  assert.equal(/export function sha256File[\s\S]*?lstatSync/.test(policySrc), false, 'sha256File must not use pre-lstatSync before openSync');
  assert.equal(/export function streamFileToDocker[\s\S]*?lstatSync/.test(policySrc), false, 'streamFileToDocker must not use pre-lstatSync before openSync');

  const policyUrl = pathToFileURL(join(REPO_ROOT, 'scripts/lib/backup-policy.mjs')).href;
  const { sha256File, streamFileToDocker } = await import(policyUrl);
  const dir = mkdtempSync(join(tmpdir(), 'ldx-policy-race-'));
  try {
    const okFile = join(dir, 'ok.bin');
    writeFileSync(okFile, 'hello-rls', 'utf8');
    const hashed = sha256File(okFile, { maxBytes: 1024 });
    assert.equal(hashed.bytes, 9);
    assert.match(hashed.sha256, /^[a-f0-9]{64}$/);
    assert.throws(() => sha256File(okFile, { maxBytes: 4 }), /size|limit/i);

    const subDir = join(dir, 'subdir');
    mkdirSync(subDir);
    assert.throws(() => sha256File(subDir), /.+/);
    assert.throws(() => streamFileToDocker(subDir, ['version']), /.+/);

    const symPath = join(dir, 'link.bin');
    try {
      symlinkSync(okFile, symPath);
      if (process.platform !== 'win32') {
        assert.throws(() => sha256File(symPath), /ELOOP|symlink/i);
      }
    } catch {
      // Symlink creation may require privilege on Windows.
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // Verify generated dist client bundles emit top-level const __deps and pass __id to __modules[id]
  for (const distRel of [
    'plugins/nocobase/plugin-lattice-foundation/dist/client/index.js',
    'plugins/nocobase/plugin-lattice-foundation/dist/client-v2/index.js',
    'plugins/nocobase/plugin-dxos-ai/dist/client/index.js',
    'plugins/nocobase/plugin-dxos-blocks/dist/client/index.js',
    'plugins/nocobase/plugin-dxos-studio/dist/client/index.js',
  ]) {
    const bundleSrc = readFileSync(join(REPO_ROOT, distRel), 'utf8');
    assert.match(bundleSrc, /const __deps = \{/);
    assert.match(bundleSrc, /__modules\[id\]\(module,module\.exports,id\)/);
  }

  // Runtime smoke check on compiled client bundle with top-level __deps + __load
  const origLoad = Module._load;
  Module._load = function mockedBundleExternals(req, parent, isMain) {
    if (req === '@nocobase/client') return { Plugin: class {}, SchemaComponentOptions: () => null };
    if (req === '@nocobase/client-v2') return { Plugin: class {} };
    if (req === 'react') return { createElement: () => null, useEffect: () => {} };
    if (req === 'antd') return {};
    if (req === 'react-router-dom') return {};
    if (req === '@nocobase/flow-engine') return {};
    return origLoad.call(this, req, parent, isMain);
  };
  try {
    const bundlePath = join(REPO_ROOT, 'plugins/nocobase/plugin-lattice-foundation/dist/client/index.js');
    delete require.cache[bundlePath];
    const exported = require(bundlePath);
    assert.equal(typeof exported.createWorkspaceApi, 'function');
    assert.equal(typeof exported.useLatticeFormAction, 'function');
  } finally {
    Module._load = origLoad;
  }

  // Verify SPDX Apache-2.0 headers on all new Task 4.2 files
  const { addSourceHeader } = await import(pathToFileURL(join(REPO_ROOT, 'scripts/source-headers.mjs')).href);
  for (const newRel of [
    'plugins/nocobase/plugin-lattice-foundation/src/server/pg-rls.js',
    'plugins/nocobase/plugin-lattice-foundation/src/server/observability.js',
    'plugins/nocobase/plugin-lattice-foundation/src/server/migrations/20261123000600-postgresql-rls-policies.js',
    'plugins/nocobase/plugin-lattice-foundation/tests/pg-rls-and-observability.test.cjs',
  ]) {
    const res = addSourceHeader(readFileSync(join(REPO_ROOT, newRel), 'utf8'), newRel);
    assert.equal(res.status, 'present', `${newRel} missing valid SPDX header`);
  }
});

test('LatticeFoundationPlugin.load wires observability resource & middleware while preserving Wave 1-3 resources', async () => {
  await withMockedNocobase(async () => {
    const indexPath = require.resolve('../src/server/index');
    delete require.cache[indexPath];
    const LatticeFoundationPlugin = require('../src/server/index');

    const definedResources = new Map();
    const aclAllows = [];
    const appMiddlewares = [];
    const rmMiddlewares = [];
    const cronJobs = [];
    const dbEvents = [];

    const app = {
      db: {
        on(ev) { dbEvents.push(ev); },
        getRepository() { return null; },
        sequelize: { query: async () => [[1]] },
      },
      use(fn, opts) { appMiddlewares.push({ fn, opts }); },
      resourceManager: {
        define(def) { definedResources.set(def.name, def.actions); },
        use(fn, opts) { rmMiddlewares.push({ fn, opts }); },
      },
      acl: {
        allow(...args) { aclAllows.push(args); },
        registerSnippet() {},
      },
      cronJobManager: {
        addJob(job) { cronJobs.push(job); },
      },
      logger: { info() {}, warn() {}, error() {} },
    };

    const plugin = new LatticeFoundationPlugin(app);
    await plugin.load();

    for (const expectedResource of [
      'latticeNative',
      'latticeContextSync',
      'latticeIntegrations',
      'latticePortals',
      'latticeChatter',
      'latticeVoucher',
      'latticeNotifications',
      'latticeSla',
      'dxos',
      'latticeApps',
    ]) {
      assert.ok(definedResources.has(expectedResource), `Missing resource ${expectedResource}`);
    }
    assert.ok(definedResources.get('dxos').health);
    assert.ok(definedResources.get('dxos').metrics);
    assert.ok(appMiddlewares.some((m) => m.opts?.tag === 'dxosObservability'));
    assert.ok(rmMiddlewares.some((m) => m.opts?.tag === 'latticeNativeScope'));
    assert.ok(aclAllows.some(([res, actions, role]) => res === 'dxos' && actions.includes('health') && actions.includes('metrics') && role === 'public'));
    assert.equal(typeof app.db.attachLatticeRlsPolicy, 'function');

    const sqlCalls = [];
    const queryOptsCalls = [];
    app.db.sequelize = {
      getDialect: () => 'postgres',
      query: async (sql, opts) => {
        sqlCalls.push(sql);
        queryOptsCalls.push(opts);
        return [[]];
      },
    };
    const fakeTx = { id: 'tx-rls-attach' };
    await app.db.attachLatticeRlsPolicy('latticeCustomSample', fakeTx);
    assert.equal(sqlCalls.some((s) => /ENABLE ROW LEVEL SECURITY/.test(s)), true);
    assert.equal(sqlCalls.length, 3);
    assert.equal(queryOptsCalls.every((o) => o && o.transaction === fakeTx), true);

    queryOptsCalls.length = 0;
    await app.db.attachLatticeRlsPolicy('latticeCustomSample', null);
    assert.equal(queryOptsCalls.length, 3);
    assert.equal(queryOptsCalls.every((o) => o === undefined), true);
  });
});
