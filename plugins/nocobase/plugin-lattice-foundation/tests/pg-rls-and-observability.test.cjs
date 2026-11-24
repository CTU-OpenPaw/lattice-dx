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

  // withSystemRlsBypass sets app.rls_bypass='on' inside a transaction and rejects invalid inputs
  assert.equal(typeof pgRls.withSystemRlsBypass, 'function');
  await assert.rejects(() => pgRls.withSystemRlsBypass(pgDb, null), TypeError);
  await assert.rejects(() => pgRls.withSystemRlsBypass({}, async () => 'nope'), { code: 'RLS_TRANSACTION_UNAVAILABLE' });

  queries.length = 0;
  const bypassOut = await pgRls.withSystemRlsBypass(pgDb, async (tx) => {
    assert.equal(tx, fakeTx);
    assert.equal(pgRls.getActiveRlsContext()?.systemRlsBypass, true);
    return 'bypass-ok';
  });
  assert.equal(bypassOut, 'bypass-ok');
  assert.equal(queries.length, 1);
  assert.equal(queries[0].sql, "SELECT set_config('app.rls_bypass', 'on', true)");
  assert.equal(queries[0].opts.transaction, fakeTx);

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
  const sqliteBypassOut = await pgRls.withSystemRlsBypass(sqliteDb, async () => 'bypass-sqlite-ok');
  assert.equal(sqliteBypassOut, 'bypass-sqlite-ok');
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
    assert.equal(seqCalls[0].sql, "SELECT set_config('app.rls_bypass', 'on', true)");
    assert.equal(seqCalls[1].sql, "SELECT set_config('app.current_org', :orgId, true)");
    assert.equal(repoCalls.find((c) => c.method === 'assetFindOne').opts.transaction, fakeTx);
    assert.equal(repoCalls.find((c) => c.method === 'deptFindOne').opts.transaction, fakeTx);
    assert.equal(repoCalls.find((c) => c.method === 'find').opts.transaction, fakeTx);
  } finally {
    if (prevFlag === undefined) delete process.env.DX_PG_RLS_SESSION;
    else process.env.DX_PG_RLS_SESSION = prevFlag;
  }
});

test('attachRlsPolicyToTable and migrations 20261123000600 & 20261127000100 emit fail-closed FORCE PostgreSQL RLS DDL and OAuth2 connector columns', async () => {
  await withMockedNocobase(async () => {
    const pgRls = require('../src/server/pg-rls');
    const migPath = require.resolve('../src/server/migrations/20261123000600-postgresql-rls-policies');
    delete require.cache[migPath];
    const Migration = require('../src/server/migrations/20261123000600-postgresql-rls-policies');

    const policySql = pgRls.buildRlsPolicySql('latticeOrders');
    assert.match(policySql.enableSql, /ENABLE ROW LEVEL SECURITY/);
    assert.match(policySql.enableSql, /FORCE ROW LEVEL SECURITY/);
    assert.match(policySql.createSql, /current_setting\('app\.rls_bypass', true\) = 'on'/);
    assert.equal(policySql.createSql.includes('IS NULL'), false, 'RLS policy must fail closed (no IS NULL)');
    assert.equal(policySql.createSql.includes("= ''"), false, 'RLS policy must fail closed (no empty string bypass)');

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
    assert.match(ddl[0].sql, /ALTER TABLE public\."latticeOrders" FORCE ROW LEVEL SECURITY/);
    assert.match(ddl[1].sql, /DROP POLICY IF EXISTS lattice_tenant_isolation ON public\."latticeOrders"/);
    assert.match(ddl[2].sql, /CREATE POLICY lattice_tenant_isolation ON public\."latticeOrders"/);
    assert.match(ddl[2].sql, /AS PERMISSIVE FOR ALL TO PUBLIC/);
    assert.match(ddl[2].sql, /current_setting\('app\.rls_bypass', true\) = 'on'/);
    assert.equal(ddl[2].sql.includes('IS NULL'), false);
    assert.match(ddl[2].sql, /"organizationId" = nullif\(current_setting\('app\.current_org', true\), ''\)/);
    assert.match(ddl[2].sql, /WITH CHECK \(/);

    ddl.length = 0;
    const migration = new Migration({ db: fakeDb });
    assert.equal(migration.on, 'afterSync');
    await migration.up();

    const joinedUp = ddl.map((d) => d.sql).join('\n');
    assert.match(joinedUp, /information_schema\.columns/);
    assert.match(joinedUp, /ALTER TABLE public\."latticeRequests" ENABLE ROW LEVEL SECURITY/);
    assert.match(joinedUp, /ALTER TABLE public\."latticeRequests" FORCE ROW LEVEL SECURITY/);
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

    // Migration 20261127000100 re-attaches FORCE RLS and adds OAuth2/n8n columns on latticeConnectors reversibly
    const forceMigPath = require.resolve('../src/server/migrations/20261127000100-force-rls-and-oauth2-connectors');
    delete require.cache[forceMigPath];
    const ForceRlsMigration = require('../src/server/migrations/20261127000100-force-rls-and-oauth2-connectors');
    const forceMig = new ForceRlsMigration({ db: fakeDb });
    assert.equal(forceMig.on, 'afterSync');

    ddl.length = 0;
    await forceMig.up();
    const forceUpSql = ddl.map((d) => d.sql).join('\n');
    assert.match(forceUpSql, /FORCE ROW LEVEL SECURITY/);
    for (const col of [
      'appType',
      'capabilitiesJson',
      'oauthConfigJson',
      'oauthAccessTokenEnc',
      'oauthRefreshTokenEnc',
      'oauthTokenExpiresAt',
      'oauthScope',
      'oauthStateNonce',
      'n8nCredentialId',
    ]) {
      assert.match(forceUpSql, new RegExp(`ALTER TABLE IF EXISTS "latticeConnectors" ADD COLUMN IF NOT EXISTS "${col}"`));
    }

    ddl.length = 0;
    await forceMig.down();
    const forceDownSql = ddl.map((d) => d.sql).join('\n');
    for (const col of [
      'appType',
      'capabilitiesJson',
      'oauthConfigJson',
      'oauthAccessTokenEnc',
      'oauthRefreshTokenEnc',
      'oauthTokenExpiresAt',
      'oauthScope',
      'oauthStateNonce',
      'n8nCredentialId',
    ]) {
      assert.match(forceDownSql, new RegExp(`ALTER TABLE IF EXISTS "latticeConnectors" DROP COLUMN IF EXISTS "${col}"`));
    }
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
    assert.equal(sqlCalls.length, 2);
    assert.equal(sqlCalls[0].sql, "SELECT set_config('app.rls_bypass', 'on', true)");
    assert.equal(sqlCalls[1].sql, "SELECT set_config('app.current_org', :orgId, true)");
    assert.deepEqual(sqlCalls[1].opts.replacements, { orgId: 'org-a' });

    // Root uses explicit system RLS bypass without locking a tenant org
    sqlCalls.length = 0;
    const rootCtx = { state: { currentUser: { id: 1 }, currentRole: 'root' }, action: { resourceName: 'latticeAssets', actionName: 'list', params: {} } };
    await guard(rootCtx, async () => {});
    assert.equal(rootCtx.state.latticeRlsOrg, undefined);
    assert.equal(sqlCalls.length, 1);
    assert.equal(sqlCalls[0].sql, "SELECT set_config('app.rls_bypass', 'on', true)");

    // charts:queryData & updateScopedDocument also bind app.current_org when DX_PG_RLS_SESSION=true
    sqlCalls.length = 0;
    const chartCtx = {
      state: { currentUser: { id: 12 }, currentRole: 'ldx_employee' },
      action: { resourceName: 'charts', actionName: 'queryData', params: { values: { mode: 'builder', collection: 'latticeAssets', filter: {} } } },
    };
    await guard(chartCtx, async () => {});
    assert.equal(chartCtx.state.latticeRlsOrg, 'org-a');
    assert.equal(sqlCalls.length, 2);
    assert.equal(sqlCalls[0].sql, "SELECT set_config('app.rls_bypass', 'on', true)");
    assert.equal(sqlCalls[1].sql, "SELECT set_config('app.current_org', :orgId, true)");
    assert.deepEqual(sqlCalls[1].opts.replacements, { orgId: 'org-a' });

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

test('CodeQL remediation: build.mjs bundles avoid dep wrapper interpolation, full-backup-core uses DX_RESTORE_ARG_JSON, backup-policy avoids lstat-open race', async () => {
  const customBundleFiles = [
    'plugins/nocobase/plugin-lattice-foundation/scripts/build.mjs',
    'plugins/nocobase/plugin-dxos-ai/build.mjs',
  ];
  for (const rel of customBundleFiles) {
    const src = readFileSync(join(REPO_ROOT, rel), 'utf8');
    assert.match(src, /const __deps = /, `${rel} must emit top-level const __deps`);
    assert.match(src, /__modules\[id\]\(module,\s*module\.exports,\s*id\)/, `${rel} must pass id into __modules[id]`);
    assert.equal(/\$\{JSON\.stringify\((?:dependencies|deps)\)\}/.test(src), false, `${rel} must not interpolate deps JSON into wrapper function string`);
  }
  for (const esbuildRel of [
    'plugins/nocobase/plugin-dxos-studio/build.mjs',
    'plugins/nocobase/plugin-dxos-blocks/build.mjs',
  ]) {
    const esbuildSrc = readFileSync(join(REPO_ROOT, esbuildRel), 'utf8');
    assert.match(esbuildSrc, /esbuild\.build\(/, `${esbuildRel} must use esbuild bundler`);
    assert.match(esbuildSrc, /__dxosHostExternals/, `${esbuildRel} must resolve host externals lexically`);
    assert.equal(/\$\{JSON\.stringify\((?:dependencies|deps)\)\}/.test(esbuildSrc), false, `${esbuildRel} must not interpolate deps JSON into wrapper function string`);
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
  ]) {
    const bundleSrc = readFileSync(join(REPO_ROOT, distRel), 'utf8');
    assert.match(bundleSrc, /const __deps = \{/);
    assert.match(bundleSrc, /__modules\[id\]\(module,module\.exports,id\)/);
  }
  const studioDistSrc = readFileSync(join(REPO_ROOT, 'plugins/nocobase/plugin-dxos-studio/dist/client/index.js'), 'utf8');
  assert.match(studioDistSrc, /define\(['"]@latticedx\/plugin-dxos-studio['"]/);
  assert.equal(/\bnew Function\s*\(|\beval\s*\(/.test(studioDistSrc), false);
  const blocksDistSrc = readFileSync(join(REPO_ROOT, 'plugins/nocobase/plugin-dxos-blocks/dist/client/index.js'), 'utf8');
  assert.match(blocksDistSrc, /define\(['"]@latticedx\/plugin-dxos-blocks['"]/);
  assert.match(blocksDistSrc, /var __dxosHostExternals = \{/);

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

test('runInRlsSavepoint isolates SQL failures inside active PostgreSQL RLS transactions and passes through otherwise', async () => {
  const pgRls = require('../src/server/pg-rls');
  const sqlLog = [];
  let aborted = false;
  const fakeTx = { id: 'tx-sp-1' };
  const pgDb = {
    sequelize: {
      getDialect: () => 'postgres',
      transaction: async (cb) => {
        aborted = false;
        return cb(fakeTx);
      },
      query: async (sql, opts) => {
        const text = String(sql);
        sqlLog.push({ text, tx: opts?.transaction });
        if (text.startsWith('ROLLBACK TO SAVEPOINT ')) {
          aborted = false;
        } else if (aborted) {
          throw new Error('current transaction is aborted, commands ignored until end of transaction block');
        }
        return [[]];
      },
    },
  };

  // Outside RLS tx -> pass-through without issuing SAVEPOINT
  const outside = await pgRls.runInRlsSavepoint(pgDb, async (tx) => {
    assert.equal(tx, null);
    return 'plain';
  });
  assert.equal(outside, 'plain');
  assert.equal(sqlLog.length, 0);

  // Inside PG RLS tx -> SAVEPOINT + RELEASE on success; ROLLBACK TO SAVEPOINT + RELEASE on error leaving outer tx healthy
  await pgRls.withTenantRlsContext(pgDb, 'org-sp-1', async () => {
    const okVal = await pgRls.runInRlsSavepoint(pgDb, async (tx) => {
      assert.equal(tx, fakeTx);
      return 99;
    });
    assert.equal(okVal, 99);

    await assert.rejects(
      () => pgRls.runInRlsSavepoint(pgDb, async () => {
        aborted = true;
        throw Object.assign(new Error('invalid input syntax for type bigint: ""'), { code: '22P02' });
      }),
      { code: '22P02' },
    );

    // Outer tx must still accept queries after savepoint rollback!
    await pgDb.sequelize.query('SELECT 1', { transaction: fakeTx });
  });

  assert.ok(sqlLog.some((e) => /^SAVEPOINT "ldx_sp_\d+"$/.test(e.text)));
  assert.ok(sqlLog.some((e) => /^ROLLBACK TO SAVEPOINT "ldx_sp_\d+"$/.test(e.text)));
  assert.ok(sqlLog.some((e) => /^RELEASE SAVEPOINT "ldx_sp_\d+"$/.test(e.text)));
  assert.equal(sqlLog.at(-1).text, 'SELECT 1');

  // Non-postgres dialect passes through cleanly even inside RLS transaction
  const sqliteLog = [];
  const sqliteDb = {
    sequelize: {
      getDialect: () => 'sqlite',
      transaction: async (cb) => cb(fakeTx),
      query: async (sql) => { sqliteLog.push(sql); return [[]]; },
    },
  };
  const spSqlite = await pgRls.withTenantRlsContext(sqliteDb, 'org-sp-2', () => pgRls.runInRlsSavepoint(sqliteDb, async () => 'sqlite-ok'));
  assert.equal(spSqlite, 'sqlite-ok');
  assert.equal(sqliteLog.length, 0);
});

test('system/auth/observability/bootstrap helpers execute inside withSystemRlsBypass when DX_PG_RLS_SESSION=true', async () => {
  const { createHash } = require('node:crypto');
  const { collectDbGauges } = require('../src/server/observability');
  const { createPaasApiKeyAuthMiddleware } = require('../src/server/paas-api-keys');
  const { seedFoundation } = require('../src/server/seed');
  const prevFlag = process.env.DX_PG_RLS_SESSION;

  const rawPat = 'ldx_pat_12345678_1234567890abcdef1234567890abcdef';
  const keyHash = createHash('sha256').update(rawPat, 'utf8').digest('hex');

  const sqlLog = [];
  const fakeTx = { id: 'tx-sys-bypass' };
  const seenCountTxs = [];
  const seenPatFindTxs = [];
  const seenSeedTxs = [];

  const db = {
    sequelize: {
      getDialect: () => 'postgres',
      transaction: async (cb) => cb(fakeTx),
      query: async (sql, opts) => {
        sqlLog.push({ sql, opts });
        return [[]];
      },
    },
    getRepository(name) {
      if (name === 'latticeApiKeys') {
        return {
          findOne: async (opts) => {
            seenPatFindTxs.push(opts?.transaction || null);
            return {
              id: 7,
              organizationId: 'org-a',
              keyPrefix: 'ldx_pat_12345678',
              keyHash,
              userId: 12,
              employeeId: 1,
              roleName: 'ldx_admin',
              scopesJson: ['read'],
              active: true,
              revokedAt: null,
              expiresAt: null,
              lastUsedAt: new Date(),
            };
          },
        };
      }
      if (name === 'users') {
        return { findOne: async () => ({ id: 12, active: true }) };
      }
      if (name === 'rolesUsers') {
        return { find: async () => [{ userId: 12, roleName: 'ldx_admin' }] };
      }
      if (name === 'latticeEmployees') {
        return {
          findOne: async (opts) => {
            if (opts?.filter?.code) {
              seenSeedTxs.push(opts?.transaction || null);
              return null;
            }
            seenPatFindTxs.push(opts?.transaction || null);
            return { id: 1, userId: 12, organizationId: 'org-a', active: true };
          },
          create: async (opts) => {
            seenSeedTxs.push(opts?.transaction || null);
            return { get: () => 1 };
          },
        };
      }
      if (['latticeDepartments', 'latticeLocations', 'latticeAssets'].includes(name)) {
        return {
          findOne: async (opts) => {
            seenSeedTxs.push(opts?.transaction || null);
            return null;
          },
          create: async (opts) => {
            seenSeedTxs.push(opts?.transaction || null);
            return { get: (k) => (k === 'id' ? 1 : 'org-a') };
          },
        };
      }
      return {
        count: async (opts) => {
          seenCountTxs.push(opts?.transaction || null);
          return 3;
        },
      };
    },
  };

  try {
    process.env.DX_PG_RLS_SESSION = 'true';

    // 1. collectDbGauges sets app.rls_bypass='on' and passes transaction to repo.count
    sqlLog.length = 0;
    const gauges = await collectDbGauges(db);
    assert.equal(gauges.ai_audit_logs_total, 3);
    assert.ok(sqlLog.some((e) => e.sql === "SELECT set_config('app.rls_bypass', 'on', true)" && e.opts?.transaction === fakeTx));
    assert.ok(seenCountTxs.length > 0 && seenCountTxs.every((tx) => tx === fakeTx));

    // 2. PaaS API key auth middleware looks up key & employee under app.rls_bypass='on' before calling next()
    sqlLog.length = 0;
    const patMw = createPaasApiKeyAuthMiddleware(db);
    const patCtx = {
      method: 'GET',
      headers: { 'x-lattice-api-key': rawPat },
      request: { headers: { 'x-lattice-api-key': rawPat } },
      state: {},
      action: { resourceName: 'latticeAssets', actionName: 'list' },
    };
    let activeCtxDuringNext = null;
    const pgRls = require('../src/server/pg-rls');
    await patMw(patCtx, async () => {
      activeCtxDuringNext = pgRls.getActiveRlsContext();
    });
    assert.equal(patCtx.state.currentUser.id, 12);
    assert.equal(activeCtxDuringNext, null, 'PaaS auth must exit system bypass before running downstream next()');
    assert.ok(sqlLog.some((e) => e.sql === "SELECT set_config('app.rls_bypass', 'on', true)" && e.opts?.transaction === fakeTx));
    assert.ok(seenPatFindTxs.length >= 2 && seenPatFindTxs.every((tx) => tx === fakeTx));

    // 3. seedFoundation sets app.rls_bypass='on' when invoked with a PG transaction
    sqlLog.length = 0;
    await seedFoundation(db, fakeTx);
    assert.ok(sqlLog.some((e) => e.sql === "SELECT set_config('app.rls_bypass', 'on', true)" && e.opts?.transaction === fakeTx));
    assert.ok(seenSeedTxs.length > 0 && seenSeedTxs.every((tx) => tx === fakeTx));
  } finally {
    if (prevFlag === undefined) delete process.env.DX_PG_RLS_SESSION;
    else process.env.DX_PG_RLS_SESSION = prevFlag;
  }
});

test('Task 1 remediation: collectDbGauges isolates 42P01 failures via SAVEPOINT so PG 25P02 never poisons subsequent counts', async () => {
  const { collectDbGauges } = require('../src/server/observability');
  const prevFlag = process.env.DX_PG_RLS_SESSION;
  let txAborted = false;
  let activeSavepoint = null;
  let abortedAtSavepoint = false;
  const fakeTx = { id: 'tx-gauges-sp' };

  const db = {
    sequelize: {
      getDialect: () => 'postgres',
      transaction: async (cb) => {
        txAborted = false;
        activeSavepoint = null;
        return cb(fakeTx);
      },
      query: async (sql) => {
        const text = String(sql);
        if (text.startsWith('SAVEPOINT ')) {
          if (txAborted) throw Object.assign(new Error('current transaction is aborted'), { code: '25P02' });
          activeSavepoint = text;
          abortedAtSavepoint = false;
          return [[]];
        }
        if (text.startsWith('ROLLBACK TO SAVEPOINT ')) {
          if (activeSavepoint) {
            txAborted = abortedAtSavepoint;
          }
          return [[]];
        }
        if (text.startsWith('RELEASE SAVEPOINT ')) {
          activeSavepoint = null;
          return [[]];
        }
        if (txAborted) throw Object.assign(new Error('current transaction is aborted'), { code: '25P02' });
        return [[]];
      },
    },
    getRepository(name) {
      return {
        count: async () => {
          if (txAborted) {
            throw Object.assign(new Error('current transaction is aborted, commands ignored until end of transaction block'), { code: '25P02' });
          }
          if (name === 'latticeAiAuditLogs') {
            txAborted = true;
            if (!activeSavepoint) abortedAtSavepoint = true;
            throw Object.assign(new Error('relation "latticeAiAuditLogs" does not exist'), { code: '42P01' });
          }
          if (name === 'latticeIncidentCases') return 7;
          if (name === 'latticeNotifications') return 4;
          if (name === 'latticeSlaPolicies') return 2;
          return 1;
        },
      };
    },
  };

  try {
    process.env.DX_PG_RLS_SESSION = 'true';
    const gauges = await collectDbGauges(db);
    assert.equal(gauges.ai_audit_logs_total, 0);
    assert.equal(gauges.active_alarms_total, 7);
    assert.equal(gauges.unread_notifications_total, 4);
    assert.equal(gauges.sla_policies_active, 2);
    assert.equal(gauges.outbox_by_state.pending, 1);
    assert.equal(gauges.event_bus_by_status.queued, 1);
  } finally {
    if (prevFlag === undefined) delete process.env.DX_PG_RLS_SESSION;
    else process.env.DX_PG_RLS_SESSION = prevFlag;
  }
});

test('Task 1 remediation: foundation custom-resource HTTP handlers wrap DB operations in RLS context and paas-api-keys gates dxosN8n mutating actions', async () => {
  const { registerEventBus } = require('../src/server/event-bus');
  const { registerContextResource } = require('../src/server/native-context-delivery');
  const { registerNotificationCenter } = require('../src/server/notification-center');
  const { registerChatterResource } = require('../src/server/record-chatter');
  const { registerVoucherLifecycleResource } = require('../src/server/voucher-lifecycle');
  const { registerPkiLedger } = require('../src/server/pki-ledger');
  const { registerDataGovernance } = require('../src/server/data-governance');
  const { createPaasApiKeyAuthMiddleware } = require('../src/server/paas-api-keys');
  const { TENANT_RLS_TABLES } = require('../src/server/pg-rls');
  const { createHash } = require('node:crypto');

  const prevFlag = process.env.DX_PG_RLS_SESSION;
  const rlsTableSet = new Set(TENANT_RLS_TABLES);
  const txStateMap = new WeakMap();
  let txSeq = 0;

  const tables = {
    users: [{ id: 10, username: 'admin-a', active: true }, { id: 1, username: 'root', active: true }],
    roles: [{ name: 'ldx_admin', allowConfigure: true, snippets: ['pm'] }, { name: 'root', allowAll: true, allowConfigure: true }],
    rolesUsers: [{ userId: 10, roleName: 'ldx_admin' }, { userId: 1, roleName: 'root' }],
    latticeEmployees: [{ id: 100, userId: 10, organizationId: 'org-a', active: true, code: 'ADM-A', name: 'Admin A' }],
    latticeRequests: [{ id: 5, organizationId: 'org-a', code: 'REQ-5', name: 'Cold Box', requesterId: 100, status: 'draft', version: 1, amendmentNo: 0, amendedFromId: null }],
    latticeNotifications: [{ id: 1, organizationId: 'org-a', recipientUserId: 10, title: 'Alert', category: 'system', severity: 'info', readAt: null, active: true }],
    latticeRecordChatter: [],
    latticeContextOutbox: [{ id: 1, eventId: `native-${'a'.repeat(64)}`, organizationId: 'org-a', state: 'failed', attempts: 2 }],
    latticeEventBus: [{ id: 1, organizationId: 'org-a', eventId: 'ev-1', eventType: 'test.ev', source: 'test', status: 'queued', occurredAt: new Date().toISOString() }],
    latticeWebhookSubscriptions: [],
    latticeWebhookDeliveries: [],
    latticePkiKeys: [],
    latticeCryptoLedger: [],
    latticeFrozenSnapshots: [],
    latticeDataLineage: [],
    latticeDataQuarantine: [],
    latticeOrders: [],
    latticeServiceTickets: [],
    latticeApiKeys: [],
  };

  const rawReadPat = 'ldx_pat_aaaaaaaa_11111111111111111111111111111111';
  const rawIotPat = 'ldx_pat_bbbbbbbb_22222222222222222222222222222222';
  const rawAiPat = 'ldx_pat_cccccccc_33333333333333333333333333333333';
  const rawWritePat = 'ldx_pat_dddddddd_44444444444444444444444444444444';
  tables.latticeApiKeys.push(
    { id: 1, organizationId: 'org-a', userId: 10, employeeId: 100, roleName: 'ldx_admin', keyPrefix: 'ldx_pat_aaaaaaaa', keyHash: createHash('sha256').update(rawReadPat).digest('hex'), scopesJson: ['read'], active: true },
    { id: 2, organizationId: 'org-a', userId: 10, employeeId: 100, roleName: 'ldx_admin', keyPrefix: 'ldx_pat_bbbbbbbb', keyHash: createHash('sha256').update(rawIotPat).digest('hex'), scopesJson: ['iot'], active: true },
    { id: 3, organizationId: 'org-a', userId: 10, employeeId: 100, roleName: 'ldx_admin', keyPrefix: 'ldx_pat_cccccccc', keyHash: createHash('sha256').update(rawAiPat).digest('hex'), scopesJson: ['ai'], active: true },
    { id: 4, organizationId: 'org-a', userId: 10, employeeId: 100, roleName: 'ldx_admin', keyPrefix: 'ldx_pat_dddddddd', keyHash: createHash('sha256').update(rawWritePat).digest('hex'), scopesJson: ['write'], active: true },
  );

  const assertRlsVisibility = (tableName, row, opts) => {
    if (!rlsTableSet.has(tableName)) return true;
    const tx = opts?.transaction;
    if (!tx) return false;
    const st = txStateMap.get(tx);
    if (!st) return false;
    if (st.bypass === 'on') return true;
    return st.orgId && row.organizationId === st.orgId;
  };

  const assertRlsWrite = (tableName, orgId, opts) => {
    if (!rlsTableSet.has(tableName)) return;
    const tx = opts?.transaction;
    const st = tx ? txStateMap.get(tx) : null;
    if (!st || (st.bypass !== 'on' && (!st.orgId || st.orgId !== orgId))) {
      throw Object.assign(new Error(`new row violates row-level security policy for table "${tableName}"`), { code: '42501' });
    }
  };

  const match = (row, filter = {}) => Object.entries(filter || {}).every(([k, cond]) => {
    if (k === '$and' && Array.isArray(cond)) return cond.every((s) => match(row, s));
    if (k === '$or' && Array.isArray(cond)) return cond.some((s) => match(row, s));
    if (cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)) {
      if (Array.isArray(cond.$in)) return cond.$in.includes(row[k]);
      if (Object.hasOwn(cond, '$ne')) return row[k] !== cond.$ne;
    }
    return row[k] === cond;
  });

  const wrapRow = (tableName, r) => (r ? {
    ...r,
    get: (k) => r[k],
    toJSON: () => ({ ...r }),
    update: async (patch, opts) => {
      assertRlsWrite(tableName, r.organizationId, opts);
      Object.assign(r, patch);
      return wrapRow(tableName, r);
    },
  } : null);

  const db = {
    on() {},
    sequelize: {
      getDialect: () => 'postgres',
      transaction: async (cb) => {
        const tx = { id: `tx-${++txSeq}`, LOCK: { UPDATE: 'UPDATE', SHARE: 'SHARE' } };
        txStateMap.set(tx, { bypass: '', orgId: '' });
        return cb(tx);
      },
      query: async (sql, opts = {}) => {
        const text = String(sql);
        const st = opts?.transaction ? txStateMap.get(opts.transaction) : null;
        if (text.includes("SELECT current_setting('app.rls_bypass', true) AS prev")) {
          return [[{ prev: st?.bypass || '' }]];
        }
        if (text.includes("set_config('app.rls_bypass', 'on'")) {
          if (st) st.bypass = 'on';
          return [[]];
        }
        if (text.includes("set_config('app.rls_bypass', :prev")) {
          if (st) st.bypass = String(opts?.replacements?.prev || '');
          return [[]];
        }
        if (text.includes("set_config('app.current_org'")) {
          if (st) st.orgId = String(opts?.replacements?.orgId || '');
          return [[]];
        }
        return [[]];
      },
    },
    getModel(name) {
      if (!(name in tables)) return null;
      return {
        findOne: async ({ where, transaction }) => {
          const hit = tables[name].find((r) => match(r, where) && assertRlsVisibility(name, r, { transaction }));
          return wrapRow(name, hit);
        },
      };
    },
    getRepository(name) {
      if (!(name in tables)) return null;
      return {
        find: async (opts = {}) => tables[name]
          .filter((r) => match(r, opts.filter) && assertRlsVisibility(name, r, opts))
          .slice(0, opts.limit || 200)
          .map((r) => wrapRow(name, r)),
        findOne: async (opts = {}) => {
          const hit = tables[name].find((r) => match(r, opts.filter) && assertRlsVisibility(name, r, opts));
          return wrapRow(name, hit);
        },
        count: async (opts = {}) => tables[name].filter((r) => match(r, opts.filter) && assertRlsVisibility(name, r, opts)).length,
        create: async (opts = {}) => {
          assertRlsWrite(name, opts.values?.organizationId, opts);
          const row = { id: tables[name].length + 1, createdAt: new Date().toISOString(), ...opts.values };
          tables[name].push(row);
          return wrapRow(name, row);
        },
        update: async (opts = {}) => {
          const updated = [];
          for (const r of tables[name]) {
            if ((opts.filterByTk == null || Number(r.id) === Number(opts.filterByTk)) && (!opts.filter || match(r, opts.filter))) {
              if (!assertRlsVisibility(name, r, opts)) continue;
              assertRlsWrite(name, r.organizationId, opts);
              Object.assign(r, opts.values);
              updated.push(wrapRow(name, r));
            }
          }
          return updated;
        },
      };
    },
  };

  const resources = new Map();
  const app = {
    db,
    resourceManager: { define: (def) => resources.set(def.name, def.actions), use() {} },
    acl: { allow() {}, registerSnippet() {} },
    cronJobManager: { addJob() {} },
    logger: { info() {}, warn() {}, error() {} },
  };

  registerEventBus(app, { startDrainer: false });
  registerContextResource(app);
  registerNotificationCenter(app);
  registerChatterResource(app);
  registerVoucherLifecycleResource(app);
  registerPkiLedger(app);
  registerDataGovernance(app);

  const makeCtx = (method, params = {}, role = 'ldx_admin', user = { id: 10, username: 'admin-a' }) => ({
    method,
    state: { currentUser: user, currentRole: role, currentRoles: [role] },
    action: { params },
    throw(status, msg) { throw Object.assign(new Error(msg || `HTTP ${status}`), { status }); },
  });

  try {
    process.env.DX_PG_RLS_SESSION = 'true';

    // 1. dxosEvents
    const evCtx = makeCtx('GET', {});
    await resources.get('dxosEvents').listEvents(evCtx, async () => {});
    assert.equal(evCtx.body.items.length, 1);

    // 2. latticeContextSync (root)
    const syncCtx = makeCtx('GET', {}, 'root', { id: 1, username: 'root' });
    await resources.get('latticeContextSync').status(syncCtx, async () => {});
    assert.equal(syncCtx.body.total, 1);

    // 3. latticeNotifications
    const notifCtx = makeCtx('GET', {});
    await resources.get('latticeNotifications').listMine(notifCtx, async () => {});
    assert.equal(notifCtx.body.unreadCount, 1);

    // 4. latticeChatter
    const chatPostCtx = makeCtx('POST', { values: { targetCollection: 'latticeRequests', targetRecordId: 5, body: 'RLS OK' } });
    await resources.get('latticeChatter').post(chatPostCtx, async () => {});
    assert.equal(chatPostCtx.body.body, 'RLS OK');

    // 5. latticeVoucher
    const submitCtx = makeCtx('POST', { values: { collection: 'latticeRequests', id: 5, expectedVersion: 1 } });
    await resources.get('latticeVoucher').submit(submitCtx, async () => {});
    assert.equal(submitCtx.body.status, 'submitted');

    // 6. dxosLedger
    const { signCanonicalPayload } = require('../src/server/pki-ledger');
    const pkCtx = makeCtx('GET', {});
    await resources.get('dxosLedger').publicKey(pkCtx, async () => {});
    assert.ok(pkCtx.body.keyId);
    const signCtx = makeCtx('POST', { values: { targetCollection: 'latticeRequests', targetRecordId: 5 } });
    await resources.get('dxosLedger').signDocument(signCtx, async () => {});
    assert.equal(signCtx.body.signed, true);
    const verifyLedgerCtx = makeCtx('GET', {});
    await resources.get('dxosLedger').verify(verifyLedgerCtx, async () => {});
    assert.equal(verifyLedgerCtx.body.valid, true);
    const signedPayload = await signCanonicalPayload(db, 'org-a', tables.latticeRequests[0]);
    const verifySigCtx = makeCtx('POST', { values: { payload: tables.latticeRequests[0], signatureBase64: signedPayload.signatureBase64, keyId: signedPayload.keyId } });
    await resources.get('dxosLedger').verifySignature(verifySigCtx, async () => {});
    assert.equal(verifySigCtx.body.valid, true);

    // 7. dxosDataGov
    const tierCtx = makeCtx('GET', {});
    await resources.get('dxosDataGov').tierSummary(tierCtx, async () => {});
    assert.equal(tierCtx.body.organizationId, 'org-a');
    const freezeCtx = makeCtx('POST', { values: { sourceCollection: 'latticeRequests' } });
    await resources.get('dxosDataGov').freezeSnapshot(freezeCtx, async () => {});
    assert.equal(freezeCtx.body.recordCount, 1);

    // 8. paas-api-keys gates dxosN8n mutating actions appropriately
    const patMw = createPaasApiKeyAuthMiddleware(db);
    const runPatReq = (token, method, actionName) => patMw({
      method,
      headers: { 'x-lattice-api-key': token },
      request: { headers: { 'x-lattice-api-key': token } },
      state: {},
      action: { resourceName: 'dxosN8n', actionName, params: {} },
    }, async () => 'ok');

    for (const mutAct of ['createWorkflow', 'updateWorkflow', 'activateWorkflow', 'retryExecution', 'syncCredential']) {
      await assert.rejects(() => runPatReq(rawReadPat, 'POST', mutAct), { code: 'API_KEY_SCOPE_INSUFFICIENT' });
      await assert.rejects(() => runPatReq(rawReadPat, 'GET', mutAct), { code: 'API_KEY_SCOPE_INSUFFICIENT' });
      await assert.rejects(() => runPatReq(rawIotPat, 'POST', mutAct), { code: 'API_KEY_SCOPE_INSUFFICIENT' });
      assert.equal(await runPatReq(rawAiPat, 'POST', mutAct), 'ok');
      assert.equal(await runPatReq(rawWritePat, 'POST', mutAct), 'ok');
    }
    assert.equal(await runPatReq(rawReadPat, 'GET', 'workflows'), 'ok');
  } finally {
    if (prevFlag === undefined) delete process.env.DX_PG_RLS_SESSION;
    else process.env.DX_PG_RLS_SESSION = prevFlag;
  }
});
