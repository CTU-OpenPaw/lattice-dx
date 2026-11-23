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
const Module = require('node:module');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const PG_RLS_PATH = path.join(REPO_ROOT, 'plugins/nocobase/plugin-lattice-foundation/src/server/pg-rls.js');

const SIBLING_MIGRATIONS = [
  {
    relPath: 'plugins/nocobase/plugin-dxos-para/src/server/migrations/20261120000100-dxos-para-init.js',
    tables: ['latticeParaDocuments'],
    kind: 'sync',
  },
  {
    relPath: 'plugins/nocobase/plugin-dxos-para/src/server/migrations/20261123000300-para-chunks-and-semantic-vector.js',
    tables: ['latticeParaChunks'],
    kind: 'ddl',
  },
  {
    relPath: 'plugins/nocobase/plugin-dxos-studio/src/server/migrations/20261120000200-dxos-service-tickets.js',
    tables: ['latticeServiceTickets'],
    kind: 'sync',
  },
  {
    relPath: 'plugins/nocobase/plugin-dxos-ai/src/server/migrations/20261121000100-dxos-ai-workforce.js',
    tables: ['latticeAiProfiles', 'latticeAiAuditLogs'],
    kind: 'sync',
  },
  {
    relPath: 'plugins/nocobase/plugin-dxos-ai/src/server/migrations/20261123000100-ai-quota-buckets.js',
    tables: ['latticeAiQuotaUsage'],
    kind: 'ddl',
  },
  {
    relPath: 'plugins/nocobase/plugin-dxos-ai/src/server/migrations/20261123000400-ai-hitl-approvals.js',
    tables: ['latticeAiApprovalQueue'],
    kind: 'ddl',
  },
  {
    relPath: 'plugins/nocobase/plugin-dxos-blocks/src/server/migrations/20261123000500-dxos-telemetry-timeseries.js',
    tables: ['latticeTelemetryPoints'],
    kind: 'ddl',
  },
];

function loadMigrationClass(absPath) {
  const origLoad = Module._load;
  class MockMigration {
    constructor(context) {
      this.context = context;
    }
  }
  Module._load = function mockedNocobase(request, parent, isMain) {
    if (request === '@nocobase/server') return { Migration: MockMigration };
    if (request === '@nocobase/database') return { defineCollection: (def) => def };
    return origLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(absPath)];
    return require(absPath);
  } finally {
    Module._load = origLoad;
  }
}

function makeMockRepoDb(extra = {}) {
  return {
    hasCollection: () => false,
    getRepository: () => ({
      findOne: async () => ({ id: 1 }),
      find: async () => [],
      create: async ({ values }) => values,
      destroy: async () => {},
    }),
    ...extra,
  };
}

test('all 7 pre-20261124 sibling-plugin migrations attach PG RLS across all 8 tables via db.attachLatticeRlsPolicy and pg-rls fallback', async () => {
  for (const spec of SIBLING_MIGRATIONS) {
    const absPath = path.join(REPO_ROOT, spec.relPath);
    const MigrationCls = loadMigrationClass(absPath);

    // 1. Postgres with db.attachLatticeRlsPolicy
    const attached = [];
    const sqlWithHook = [];
    const tx1 = { id: 'tx-hook' };
    const dbWithHook = makeMockRepoDb({
      attachLatticeRlsPolicy: async (tableName, opts) => {
        attached.push({ tableName, tx: opts?.transaction });
      },
      sequelize: {
        getDialect: () => 'postgres',
        transaction: async (fn) => fn(tx1),
        query: async (sql) => {
          sqlWithHook.push(sql);
          if (sql.includes('information_schema.columns')) {
            return [spec.tables.map((t) => ({ table_name: t }))];
          }
          return [[]];
        },
      },
    });
    const migHook = new MigrationCls({ db: dbWithHook });
    assert.equal(migHook.on, 'afterSync', `${spec.relPath} must declare on = 'afterSync'`);
    await migHook.up();
    assert.deepEqual(
      attached.map((x) => x.tableName),
      spec.tables,
      `${spec.relPath} must attach RLS via db.attachLatticeRlsPolicy for ${spec.tables.join(', ')}`,
    );
    assert.equal(attached.every((x) => x.tx === tx1), true);

    // 2. Postgres fallback to pg-rls attachRlsPolicyToTable when db.attachLatticeRlsPolicy is absent
    const sqlFallback = [];
    const tx2 = { id: 'tx-fallback' };
    const dbFallback = makeMockRepoDb({
      sequelize: {
        getDialect: () => 'postgres',
        transaction: async (fn) => fn(tx2),
        query: async (sql, opts) => {
          sqlFallback.push({ sql, opts });
          if (sql.includes('information_schema.columns')) {
            return [spec.tables.map((t) => ({ table_name: t }))];
          }
          return [[]];
        },
      },
    });
    const migFallback = new MigrationCls({ db: dbFallback });
    await migFallback.up();
    for (const tableName of spec.tables) {
      assert.equal(
        sqlFallback.some((q) => q.sql.includes(`ALTER TABLE public."${tableName}" ENABLE ROW LEVEL SECURITY`) && q.opts?.transaction === tx2),
        true,
        `${spec.relPath} fallback must enable RLS on ${tableName}`,
      );
      assert.equal(
        sqlFallback.some((q) => q.sql.includes(`CREATE POLICY lattice_tenant_isolation ON public."${tableName}"`)),
        true,
        `${spec.relPath} fallback must create policy on ${tableName}`,
      );
    }

    // down() safely detaches RLS on Postgres
    sqlFallback.length = 0;
    await migFallback.down();
    for (const tableName of spec.tables) {
      assert.equal(
        sqlFallback.some((q) => q.sql.includes(`DROP POLICY IF EXISTS lattice_tenant_isolation ON public."${tableName}"`)),
        true,
        `${spec.relPath} down() must detach RLS policy on ${tableName}`,
      );
    }

    // 3. Non-Postgres dialect (sqlite) skips RLS cleanly
    const sqliteAttached = [];
    const sqliteSql = [];
    const dbSqlite = makeMockRepoDb({
      attachLatticeRlsPolicy: async (tableName) => { sqliteAttached.push(tableName); },
      sequelize: {
        getDialect: () => 'sqlite',
        transaction: async (fn) => fn({ id: 'tx-sqlite' }),
        query: async (sql) => { sqliteSql.push(sql); return [[]]; },
      },
    });
    const migSqlite = new MigrationCls({ db: dbSqlite });
    await migSqlite.up();
    await migSqlite.down();
    assert.deepEqual(sqliteAttached, []);
    assert.equal(sqliteSql.some((s) => /ROW LEVEL SECURITY|CREATE POLICY/i.test(s)), false);

    // 4. Mocked db without sequelize (and missing table in information_schema for sync migrations) passes cleanly
    const dbNoSeq = makeMockRepoDb();
    await new MigrationCls({ db: dbNoSeq }).up();
    await new MigrationCls({ db: dbNoSeq }).down();

    if (spec.kind === 'sync') {
      const missingTableAttached = [];
      const dbMissing = makeMockRepoDb({
        attachLatticeRlsPolicy: async (t) => { missingTableAttached.push(t); },
        sequelize: {
          getDialect: () => 'postgres',
          transaction: async (fn) => fn({}),
          query: async () => [[]],
        },
      });
      await new MigrationCls({ db: dbMissing }).up();
      await new MigrationCls({ db: dbMissing }).down();
      assert.deepEqual(missingTableAttached, [], `${spec.relPath} must not alter tables missing from information_schema`);
    }
  }
});

test('migration 20261124000500-reconcile-sibling-rls discovers and attaches PG RLS for all 42 TENANT_RLS_TABLES and is a safe no-op on non-Postgres and down()', async () => {
  const migPath = path.join(REPO_ROOT, 'plugins/nocobase/plugin-dxos-ai/src/server/migrations/20261124000500-reconcile-sibling-rls.js');
  const migSrc = readFileSync(migPath, 'utf8');
  assert.match(migSrc, /SPDX-License-Identifier:\s*Apache-2\.0/);
  assert.match(migSrc, /discoverTenantRlsTables/);
  assert.match(migSrc, /attachRlsPolicyToTable/);

  const pgRls = require(PG_RLS_PATH);
  assert.equal(pgRls.TENANT_RLS_TABLES.length, 42);

  const MigrationCls = loadMigrationClass(migPath);

  // 1. Postgres fallback reconciles all 42 tables via discoverTenantRlsTables -> attachRlsPolicyToTable
  const sqlLog = [];
  const fakeTx = { id: 'tx-reconcile-42' };
  const migPg = new MigrationCls({
    db: {
      sequelize: {
        getDialect: () => 'postgres',
        transaction: async (fn) => fn(fakeTx),
        query: async (sql, opts) => {
          sqlLog.push({ sql, opts });
          if (sql.includes('information_schema.columns')) {
            return [pgRls.TENANT_RLS_TABLES.map((table_name) => ({ table_name }))];
          }
          return [[]];
        },
      },
    },
  });
  assert.equal(migPg.on, 'afterSync');
  await migPg.up();

  for (const tableName of pgRls.TENANT_RLS_TABLES) {
    assert.equal(
      sqlLog.some((q) => q.sql.includes(`ALTER TABLE public."${tableName}" ENABLE ROW LEVEL SECURITY`) && q.opts?.transaction === fakeTx),
      true,
      `Reconciliation migration must enable RLS on ${tableName}`,
    );
    assert.equal(
      sqlLog.some((q) => q.sql.includes(`CREATE POLICY lattice_tenant_isolation ON public."${tableName}"`)),
      true,
      `Reconciliation migration must create policy on ${tableName}`,
    );
  }

  // down() must be an intentional safe no-op returning undefined without stripping RLS
  sqlLog.length = 0;
  const downResult = await migPg.down();
  assert.equal(downResult, undefined);
  assert.equal(sqlLog.length, 0);

  // 2. Postgres with db.attachLatticeRlsPolicy delegates all discovered tables
  const hookAttached = [];
  const migHook = new MigrationCls({
    db: {
      attachLatticeRlsPolicy: async (tableName, opts) => {
        hookAttached.push({ tableName, tx: opts?.transaction });
      },
      sequelize: {
        getDialect: () => 'postgres',
        transaction: async (fn) => fn(fakeTx),
        query: async (sql) => {
          if (sql.includes('information_schema.columns')) {
            return [pgRls.TENANT_RLS_TABLES.map((table_name) => ({ table_name }))];
          }
          return [[]];
        },
      },
    },
  });
  await migHook.up();
  assert.deepEqual(hookAttached.map((x) => x.tableName), [...pgRls.TENANT_RLS_TABLES]);
  assert.equal(hookAttached.every((x) => x.tx === fakeTx), true);

  // 3. Non-Postgres dialect and mocked db without sequelize no-op cleanly
  let sqliteCalled = false;
  const migSqlite = new MigrationCls({
    db: {
      sequelize: {
        getDialect: () => 'sqlite',
        transaction: async () => { sqliteCalled = true; },
        query: async () => { sqliteCalled = true; return [[]]; },
      },
    },
  });
  await migSqlite.up();
  assert.equal(await migSqlite.down(), undefined);
  assert.equal(sqliteCalled, false);

  const migNoSeq = new MigrationCls({ db: {} });
  await migNoSeq.up();
  assert.equal(await migNoSeq.down(), undefined);
});

test('cross-plugin foundation loaders try @latticedx/plugin-lattice-foundation/* candidates and rethrow transitive MODULE_NOT_FOUND', async () => {
  const loaderSpecs = [
    {
      relPath: 'plugins/nocobase/plugin-dxos-para/src/server/para-scope.js',
      subpath: 'pg-rls',
      loadCheck: (modPath) => require(modPath),
    },
    {
      relPath: 'plugins/nocobase/plugin-dxos-studio/src/server/service-scope.js',
      subpath: 'pg-rls',
      loadCheck: (modPath) => require(modPath),
    },
    {
      relPath: 'plugins/nocobase/plugin-dxos-blocks/src/server/migrations/20261124000400-digital-twin-shadows.js',
      subpath: 'pg-rls',
      invoke: async (ModCls) => {
        await new ModCls({
          db: {
            sequelize: {
              getDialect: () => 'postgres',
              transaction: async (fn) => fn({}),
              query: async () => [[]],
            },
          },
        }).up();
      },
    },
    {
      relPath: 'plugins/nocobase/plugin-dxos-blocks/src/server/digital-twin.js',
      subpath: 'pg-rls',
      invoke: async (mod) => {
        const db = {
          sequelize: {
            getDialect: () => 'postgres',
            transaction: async (fn) => fn({ id: 'tx-twin' }),
          },
          getRepository: (name) => {
            if (name === 'latticeAssets') {
              return { findOne: async () => ({ id: 1, organizationId: 'org-a', ngsiEntityId: 'urn:ngsi-ld:Asset:org-a:native:1' }) };
            }
            if (name === 'latticeTwinShadows') {
              return { findOne: async () => null, create: async ({ values }) => values };
            }
            return null;
          },
        };
        await mod.requestDesiredSetpoint(db, {
          organizationId: 'org-a',
          assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:1',
          desiredPatch: { targetTempC: -18 },
        });
      },
    },
    {
      relPath: 'plugins/nocobase/plugin-dxos-blocks/src/server/bulk-import.js',
      subpath: 'pg-rls',
      invoke: async (mod) => {
        const db = {
          sequelize: {
            getDialect: () => 'postgres',
            transaction: async (fn) => fn({ id: 'tx-import' }),
          },
          getRepository: () => ({
            findOne: async () => null,
            create: async ({ values }) => ({ id: 1, ...values }),
          }),
        };
        const preview = await mod.runBulkImportDryRun(db, {
          organizationId: 'org-a',
          collection: 'latticeAssets',
          rows: [{ code: 'A1', name: 'Asset 1' }],
          signingSecret: 'test-secret',
        });
        await mod.commitBulkImport(db, {
          organizationId: 'org-a',
          collection: 'latticeAssets',
          rows: [{ code: 'A1', name: 'Asset 1' }],
          previewToken: preview.previewToken,
          signingSecret: 'test-secret',
        });
      },
    },
  ];

  for (const spec of loaderSpecs) {
    const absPath = path.join(REPO_ROOT, spec.relPath);
    const src = readFileSync(absPath, 'utf8');
    assert.match(src, /@latticedx\/plugin-lattice-foundation\//, `${spec.relPath} must include @latticedx/plugin-lattice-foundation/* candidate`);
    assert.match(src, /requireStack\[0\]\s*===\s*__filename/, `${spec.relPath} must check isDirectMissing via requireStack[0] === __filename`);

    // Verify transitive MODULE_NOT_FOUND (requireStack[0] !== loader file) propagates for load-time loaders
    if (spec.loadCheck) {
      const origLoad = Module._load;
      Module._load = function mockedTransitive(request, parent, isMain) {
        if (request === '@nocobase/server') return { Migration: class { constructor(c) { this.context = c; } } };
        if (typeof request === 'string' && request.includes(spec.subpath)) {
          const err = new Error(`Cannot find transitive module 'missing-dep'`);
          err.code = 'MODULE_NOT_FOUND';
          err.requireStack = ['/some/other/module.js', absPath];
          throw err;
        }
        return origLoad.call(this, request, parent, isMain);
      };
      try {
        delete require.cache[absPath];
        assert.throws(
          () => spec.loadCheck(absPath),
          (err) => err?.code === 'MODULE_NOT_FOUND' && err.message.includes('missing-dep'),
          `${spec.relPath} must rethrow transitive MODULE_NOT_FOUND`,
        );
      } finally {
        Module._load = origLoad;
        delete require.cache[absPath];
      }
    }

    // Verify runtime loaders in digital-twin.js, bulk-import.js, 20261124000400 also rethrow transitive MODULE_NOT_FOUND
    if (spec.invoke) {
      const origLoad = Module._load;
      Module._load = function mockedTransitive(request, parent, isMain) {
        if (request === '@nocobase/server') return { Migration: class { constructor(c) { this.context = c; } } };
        if (typeof request === 'string' && request.includes(spec.subpath)) {
          const err = new Error(`Cannot find transitive module 'missing-dep'`);
          err.code = 'MODULE_NOT_FOUND';
          err.requireStack = ['/some/other/module.js', absPath];
          throw err;
        }
        return origLoad.call(this, request, parent, isMain);
      };
      try {
        delete require.cache[absPath];
        const loaded = require(absPath);
        let caught = null;
        try {
          await spec.invoke(loaded);
        } catch (err) {
          caught = err;
        }
        assert.equal(caught?.code, 'MODULE_NOT_FOUND', `${spec.relPath} must propagate transitive MODULE_NOT_FOUND`);
      } finally {
        Module._load = origLoad;
        delete require.cache[absPath];
      }
    }
  }
});
