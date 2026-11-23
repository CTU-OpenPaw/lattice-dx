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

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(PLUGIN_ROOT, '../../..');

function loadWithNocobaseStubs(filePath, stubs = {}) {
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (Object.hasOwn(stubs, request)) return stubs[request];
    return origLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(filePath)];
    return require(filePath);
  } finally {
    Module._load = origLoad;
  }
}

function makeTwinAndImportHarness({
  withApprovalQueue = true,
  withStockLots = true,
  withLedger = false,
  inactivePki = false,
  withLineage = false,
} = {}) {
  const shadows = [];
  const approvals = [];
  const assets = [
    { id: 12, code: 'CH-12', name: 'Kho lạnh Vaccine A', organizationId: 'org-a', status: 'active' },
    { id: 99, code: 'CH-99', name: 'Kho lạnh Org B', organizationId: 'org-b', status: 'active' },
  ];
  const locations = [
    { id: 1, code: 'LOC-EXIST', name: 'Kho sẵn có', organizationId: 'org-a', active: true },
  ];
  const departments = [];
  const stockLots = [];
  const lineageEdges = [];
  const ledgerRows = [];
  const pkiKeys = [];
  const employees = [
    { id: 10, userId: 101, organizationId: 'org-a', active: true },
    { id: 20, userId: 201, organizationId: 'org-b', active: true },
  ];
  const roles = [
    { name: 'root', allowAll: true },
    { name: 'ldx_manager', allowAll: false },
    { name: 'ldx_operator', allowAll: false },
    { name: 'ldx_employee', allowAll: false },
  ];
  const roleResources = [
    { roleName: 'ldx_manager', name: 'latticeAssets', dataSourceKey: 'main', usingActionsConfig: true, actions: [{ name: 'view' }, { name: 'create' }, { name: 'update' }] },
    { roleName: 'ldx_manager', name: 'latticeLocations', dataSourceKey: 'main', usingActionsConfig: true, actions: [{ name: 'view' }, { name: 'create' }] },
    { roleName: 'ldx_manager', name: 'latticeDepartments', dataSourceKey: 'main', usingActionsConfig: true, actions: [{ name: 'view' }, { name: 'create' }] },
    { roleName: 'ldx_manager', name: 'latticeStockLots', dataSourceKey: 'main', usingActionsConfig: true, actions: [{ name: 'view' }, { name: 'create' }] },
    { roleName: 'ldx_operator', name: 'latticeAssets', dataSourceKey: 'main', usingActionsConfig: true, actions: [{ name: 'view' }, { name: 'update' }] },
    { roleName: 'ldx_employee', name: 'latticeAssets', dataSourceKey: 'main', usingActionsConfig: true, actions: [{ name: 'view' }] },
  ];

  let nextId = 500;
  const matchFilter = (row, filter = {}) => Object.entries(filter || {}).every(([k, cond]) => {
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      if (Array.isArray(cond.$in)) return cond.$in.includes(row[k]);
      if (cond.$eq !== undefined) return row[k] === cond.$eq;
    }
    return row[k] === cond;
  });

  const makeRepo = (arr) => ({
    find: async ({ filter = {}, limit = 100 } = {}) => arr.filter((r) => matchFilter(r, filter)).slice(0, limit),
    findOne: async ({ filter = {}, filterByTk } = {}) => {
      if (filterByTk != null) return arr.find((r) => Number(r.id) === Number(filterByTk)) || null;
      return arr.find((r) => matchFilter(r, filter)) || null;
    },
    create: async ({ values }) => {
      const row = { id: ++nextId, createdAt: new Date(), updatedAt: new Date(), ...values };
      arr.push(row);
      return row;
    },
    update: async ({ filterByTk, filter = {}, values }) => {
      const updated = [];
      for (const row of arr) {
        const hitTk = filterByTk == null || Number(row.id) === Number(filterByTk);
        if (hitTk && matchFilter(row, filter)) {
          Object.assign(row, values, { updatedAt: new Date() });
          updated.push(row);
        }
      }
      return updated;
    },
  });

  if (inactivePki) {
    pkiKeys.push({
      id: 1,
      organizationId: 'org-a',
      keyId: 'ed25519-inactive',
      algorithm: 'Ed25519',
      publicKeyPem: 'stub',
      encryptedPrivateKey: '00:00:00',
      fingerprintSha256: '0'.repeat(64),
      active: false,
    });
  }

  const db = {
    sequelize: {
      getDialect: () => 'sqlite',
      transaction: async (fn) => fn({ id: 'tx-mock' }),
    },
    getRepository(name) {
      if (name === 'latticeTwinShadows') return makeRepo(shadows);
      if (name === 'latticeAssets') return makeRepo(assets);
      if (name === 'latticeLocations') return makeRepo(locations);
      if (name === 'latticeDepartments') return makeRepo(departments);
      if (name === 'latticeStockLots' && withStockLots) return makeRepo(stockLots);
      if (name === 'latticeAiApprovalQueue' && withApprovalQueue) return makeRepo(approvals);
      if (name === 'latticeDataLineage' && withLineage) return makeRepo(lineageEdges);
      if (name === 'latticeCryptoLedger' && (withLedger || inactivePki)) return makeRepo(ledgerRows);
      if (name === 'latticePkiKeys' && (withLedger || inactivePki)) return makeRepo(pkiKeys);
      if (name === 'latticeEmployees') return makeRepo(employees);
      if (name === 'roles') return makeRepo(roles);
      if (name === 'dataSourcesRolesResources') {
        return {
          findOne: async ({ filter = {} } = {}) =>
            roleResources.find((r) => r.roleName === filter.roleName && r.name === filter.name) || null,
        };
      }
      return null;
    },
  };

  return {
    db,
    shadows,
    approvals,
    assets,
    locations,
    departments,
    stockLots,
    lineageEdges,
    ledgerRows,
  };
}

test('latticeTwinShadows collection & migration 20261124000400 define schema, named unique index without duplicate inline UNIQUE, and reversible PG RLS', async () => {
  const colPath = path.join(PLUGIN_ROOT, 'src/server/collections/twin-shadows.js');
  const colSrc = readFileSync(colPath, 'utf8');
  assert.match(colSrc, /@copyright \(C\) 2026 CTU-OpenPaw/);
  assert.match(colSrc, /SPDX-License-Identifier:\s*Apache-2\.0/);

  const colDef = loadWithNocobaseStubs(colPath, {
    '@nocobase/database': { defineCollection: (def) => def },
  });
  assert.equal(colDef.name, 'latticeTwinShadows');
  assert.deepEqual(colDef.migrationRules, ['schema-only']);
  for (const fieldName of [
    'organizationId', 'assetId', 'assetEntityId',
    'desiredJson', 'reportedJson', 'lastDeltaJson',
    'pendingCommandId', 'commandStatus',
    'lastDispatchedAt', 'lastAckedAt', 'lastReportedAt',
    'version', 'updatedBy',
  ]) {
    assert.ok(colDef.fields.some((f) => f.name === fieldName), `Missing field ${fieldName}`);
  }
  assert.ok(colDef.indexes.some((i) => i.name === 'uidx_lattice_twin_org_entity' && i.unique === true));
  assert.ok(colDef.indexes.some((i) => i.name === 'idx_lattice_twin_org_status'));

  const migPath = path.join(PLUGIN_ROOT, 'src/server/migrations/20261124000400-digital-twin-shadows.js');
  const migSrc = readFileSync(migPath, 'utf8');
  assert.match(migSrc, /@copyright \(C\) 2026 CTU-OpenPaw/);
  assert.match(migSrc, /SPDX-License-Identifier:\s*Apache-2\.0/);
  assert.match(migSrc, /CREATE TABLE IF NOT EXISTS "latticeTwinShadows"/);
  assert.match(migSrc, /uidx_lattice_twin_org_entity/);
  assert.match(migSrc, /idx_lattice_twin_org_status/);
  assert.doesNotMatch(migSrc, /\bUNIQUE\s*,/i, 'Must not declare duplicate inline UNIQUE alongside CREATE UNIQUE INDEX');
  assert.match(migSrc, /DROP TABLE IF EXISTS "latticeTwinShadows"/);

  const MigrationCls = loadWithNocobaseStubs(migPath, {
    '@nocobase/server': { Migration: class { constructor(ctx) { this.context = ctx; } } },
  });

  const sqlLog = [];
  const rlsAttached = [];
  const pgMig = new MigrationCls({
    db: {
      attachLatticeRlsPolicy: async (tableName, opts) => {
        rlsAttached.push({ tableName, hasTx: Boolean(opts?.transaction) });
      },
      sequelize: {
        getDialect: () => 'postgres',
        transaction: async (fn) => fn({ id: 'tx-pg' }),
        query: async (sql) => {
          sqlLog.push(sql);
          return [[]];
        },
      },
    },
  });
  assert.equal(pgMig.on, 'afterSync');
  await pgMig.up();
  assert.ok(sqlLog.some((q) => q.includes('CREATE TABLE IF NOT EXISTS "latticeTwinShadows"')));
  assert.ok(sqlLog.some((q) => q.includes('CREATE UNIQUE INDEX IF NOT EXISTS uidx_lattice_twin_org_entity')));
  assert.ok(sqlLog.some((q) => q.includes('CREATE INDEX IF NOT EXISTS idx_lattice_twin_org_status')));
  assert.deepEqual(rlsAttached, [{ tableName: 'latticeTwinShadows', hasTx: true }]);

  await pgMig.down();
  assert.ok(sqlLog.some((q) => q.includes('DROP POLICY IF EXISTS') || q.includes('DISABLE ROW LEVEL SECURITY')));
  assert.ok(sqlLog.some((q) => q.includes('DROP INDEX IF EXISTS uidx_lattice_twin_org_entity')));
  assert.ok(sqlLog.some((q) => q.includes('DROP TABLE IF EXISTS "latticeTwinShadows"')));
});

test('computeShadowDelta, validateDesiredPatch, and resolveAssetEntity enforce strict validation & org isolation', async () => {
  const {
    computeShadowDelta,
    validateDesiredPatch,
    resolveAssetEntity,
  } = require(path.join(PLUGIN_ROOT, 'src/server/digital-twin.js'));

  const delta = computeShadowDelta(
    { targetTempC: -20, fanMode: 'high', doorLock: 'locked' },
    { targetTempC: -18, fanMode: 'high' },
  );
  assert.equal(delta.inSync, false);
  assert.deepEqual(delta.fields.targetTempC, { desired: -20, reported: -18, numericDelta: -2 });
  assert.deepEqual(delta.fields.doorLock, { desired: 'locked', reported: null, numericDelta: null });
  assert.equal(delta.fields.fanMode, undefined);

  const syncedDelta = computeShadowDelta(
    { targetTempC: -18, fanMode: 'high' },
    { targetTempC: -18, fanMode: 'high', extraSensor: 123 },
  );
  assert.equal(syncedDelta.inSync, true);
  assert.deepEqual(syncedDelta.fields, {});

  for (const bad of [null, undefined, [], 'str', 42, {}]) {
    assert.throws(
      () => validateDesiredPatch(bad),
      (err) => err.status === 400 && err.code === 'TWIN_DESIRED_INVALID',
    );
  }
  assert.throws(
    () => validateDesiredPatch({ targetTempC: -18, rebootHost: true }),
    (err) => err.status === 400 && err.code === 'TWIN_FIELD_FORBIDDEN',
  );
  assert.throws(
    () => validateDesiredPatch({ targetTempC: -99 }),
    (err) => err.status === 400 && err.code === 'TWIN_DESIRED_INVALID',
  );
  assert.throws(
    () => validateDesiredPatch({ reportingIntervalSec: 4.5 }),
    (err) => err.status === 400 && err.code === 'TWIN_DESIRED_INVALID',
  );
  assert.throws(
    () => validateDesiredPatch({ defrostMode: 'nuclear' }),
    (err) => err.status === 400 && err.code === 'TWIN_DESIRED_INVALID',
  );

  const clean = validateDesiredPatch({
    targetTempC: -18.5,
    maxTempC: -15,
    minTempC: -22,
    defrostMode: 'auto',
    fanMode: 'eco',
    doorLock: 'locked',
    reportingIntervalSec: 30,
  });
  assert.equal(clean.targetTempC, -18.5);
  assert.equal(clean.reportingIntervalSec, 30);

  const { db } = makeTwinAndImportHarness();
  await assert.rejects(
    () => resolveAssetEntity(db, { organizationId: 'org-a', assetEntityId: 'urn:ngsi-ld:Asset:org-b:native:99' }),
    (err) => err.status === 403 && err.code === 'DXOS_CROSS_ORG_FORBIDDEN',
  );
  await assert.rejects(
    () => resolveAssetEntity(db, { organizationId: 'org-a', assetId: 99 }),
    (err) => err.status === 404 && err.code === 'DXOS_ASSET_NOT_FOUND',
  );
  const resolved = await resolveAssetEntity(db, { organizationId: 'org-a', assetId: 12 });
  assert.equal(resolved.assetEntityId, 'urn:ngsi-ld:Asset:org-a:native:12');
  assert.equal(resolved.assetId, 12);
});

test('requestDesiredSetpoint enforces >2C HITL safety gate, SSRF downlink check, ledger propagation, and ackCommandFromEdge lifecycle', async () => {
  const { requestDesiredSetpoint, ackCommandFromEdge } = require(path.join(PLUGIN_ROOT, 'src/server/digital-twin.js'));
  const { db, shadows, approvals, ledgerRows } = makeTwinAndImportHarness({ withLedger: true });

  // 1. Initial setpoint (-18 C) applies immediately without HITL
  const webhookCalls = [];
  const initRes = await requestDesiredSetpoint(db, {
    organizationId: 'org-a',
    assetId: 12,
    desiredPatch: { targetTempC: -18, fanMode: 'auto' },
    actor: { userId: '101', username: 'mgr-a' },
    downlinkUrl: 'http://nodered:1880/twin/command',
    ingestToken: 'edge-secret-token-2026-0123456789',
    fetchImpl: async (url, init) => {
      webhookCalls.push({ url, init });
      return new Response(JSON.stringify({ accepted: true }), { status: 202 });
    },
  });
  assert.equal(initRes.gatedByHitl, false);
  assert.match(initRes.commandId, /^cmd-[0-9a-f]{16}$/);
  assert.equal(initRes.downlinkDispatched, true);
  assert.equal(initRes.shadow.commandStatus, 'dispatched');
  assert.equal(webhookCalls.length, 1);
  assert.equal(webhookCalls[0].url, 'http://nodered:1880/twin/command');
  assert.equal(webhookCalls[0].init.redirect, 'error');
  assert.equal(webhookCalls[0].init.headers['X-Lattice-Edge-Token'], 'edge-secret-token-2026-0123456789');
  assert.ok(ledgerRows.some((e) => e.eventType === 'iot.twin_desired_dispatched'));

  // 2. SSRF URL (metadata / credential / external host) MUST be rejected before fetch
  let ssrfFetched = false;
  for (const badUrl of [
    'http://169.254.169.254/latest/meta-data/',
    'http://user:pass@nodered:1880/twin/command',
    'https://evil.attacker.example/exfil',
    'file:///etc/passwd',
  ]) {
    await assert.rejects(
      () => requestDesiredSetpoint(db, {
        organizationId: 'org-a',
        assetId: 12,
        desiredPatch: { targetTempC: -17.5 },
        actor: { userId: '101', username: 'mgr-a' },
        downlinkUrl: badUrl,
        fetchImpl: async () => {
          ssrfFetched = true;
          return new Response('', { status: 200 });
        },
      }),
      (err) => err.status === 400 && err.code === 'TWIN_DOWNLINK_URL_FORBIDDEN',
    );
  }
  assert.equal(ssrfFetched, false);

  // 3. Large setpoint delta (|-14 - (-18)| = 4.0 > 2.0) MUST gate via HITL and preserve previous desiredJson
  const gatedRes = await requestDesiredSetpoint(db, {
    organizationId: 'org-a',
    assetId: 12,
    desiredPatch: { targetTempC: -14 },
    actor: { userId: '101', username: 'mgr-a' },
  });
  assert.equal(gatedRes.gatedByHitl, true);
  assert.equal(gatedRes.deltaTempC, 4);
  assert.ok(gatedRes.approvalId);
  assert.equal(gatedRes.shadow.commandStatus, 'pending_hitl');
  assert.equal(gatedRes.shadow.desiredJson.targetTempC, -18);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].aiEmployee, 'dxos-ops');
  assert.equal(approvals[0].toolName, 'dxos_twin_set_desired');
  assert.equal(approvals[0].targetCollection, 'latticeTwinShadows');
  assert.equal(approvals[0].riskLevel, 'high');
  assert.equal(approvals[0].status, 'pending');
  assert.equal(approvals[0].diffPreview.targetTempC.before, -18);
  assert.equal(approvals[0].diffPreview.targetTempC.after, -14);
  assert.equal(approvals[0].diffPreview.targetTempC.delta, 4);
  assert.ok(ledgerRows.some((e) => e.eventType === 'iot.twin_hitl_required'));

  // 4. Without latticeAiApprovalQueue repo, STILL gates safely without applying setpoint
  const noQueue = makeTwinAndImportHarness({ withApprovalQueue: false });
  await requestDesiredSetpoint(noQueue.db, {
    organizationId: 'org-a',
    assetId: 12,
    desiredPatch: { targetTempC: -18 },
    actor: { userId: '101', username: 'mgr-a' },
  });
  const gatedNoQueue = await requestDesiredSetpoint(noQueue.db, {
    organizationId: 'org-a',
    assetId: 12,
    desiredPatch: { targetTempC: -10 },
    actor: { userId: '101', username: 'mgr-a' },
  });
  assert.equal(gatedNoQueue.gatedByHitl, true);
  assert.equal(gatedNoQueue.approvalId, null);
  assert.equal(gatedNoQueue.shadow.desiredJson.targetTempC, -18);

  // 5. hitlApproved: true allows the >2C setpoint through
  const approvedRes = await requestDesiredSetpoint(db, {
    organizationId: 'org-a',
    assetId: 12,
    desiredPatch: { targetTempC: -14 },
    hitlApproved: true,
    actor: { userId: '101', username: 'mgr-a' },
  });
  assert.equal(approvedRes.gatedByHitl, false);
  assert.equal(approvedRes.shadow.desiredJson.targetTempC, -14);
  assert.equal(approvedRes.shadow.commandStatus, 'dispatched');

  // 6. Edge acks partial match -> 'acked' (clears pendingCommandId on matching commandId)
  const partialAck = await ackCommandFromEdge(db, {
    organizationId: 'org-a',
    assetId: 12,
    commandId: approvedRes.commandId,
    reportedPatch: { targetTempC: -14 },
    ackStatus: 'acked',
  });
  assert.equal(partialAck.commandStatus, 'acked');
  assert.equal(partialAck.pendingCommandId, null);
  assert.ok(partialAck.lastAckedAt);
  assert.equal(partialAck.lastDeltaJson.inSync, false);

  // 7. Edge reports remaining field -> inSync -> 'synced'
  const fullAck = await ackCommandFromEdge(db, {
    organizationId: 'org-a',
    assetId: 12,
    reportedPatch: { fanMode: 'auto' },
    ackStatus: 'acked',
  });
  assert.equal(fullAck.commandStatus, 'synced');
  assert.equal(fullAck.lastDeltaJson.inSync, true);

  // 8. Failed ack marks 'failed'
  const failDispatch = await requestDesiredSetpoint(db, {
    organizationId: 'org-a',
    assetId: 12,
    desiredPatch: { targetTempC: -15 },
    actor: { userId: '101', username: 'mgr-a' },
  });
  const failedAck = await ackCommandFromEdge(db, {
    organizationId: 'org-a',
    assetId: 12,
    commandId: failDispatch.commandId,
    reportedPatch: { targetTempC: -14 },
    ackStatus: 'failed',
  });
  assert.equal(failedAck.commandStatus, 'failed');
  assert.equal(failedAck.pendingCommandId, null);
  assert.equal(shadows.length, 1);

  // 9. Ledger security invariant (PKI_KEY_INACTIVE) MUST propagate instead of being swallowed
  const inactive = makeTwinAndImportHarness({ inactivePki: true });
  await assert.rejects(
    () => requestDesiredSetpoint(inactive.db, {
      organizationId: 'org-a',
      assetId: 12,
      desiredPatch: { targetTempC: -18 },
      actor: { userId: '101', username: 'mgr-a' },
    }),
    (err) => err.code === 'PKI_KEY_INACTIVE',
  );

  // 10. Lineage edge ('twin_command') recorded cleanly when latticeDataLineage repo exists
  const lin = makeTwinAndImportHarness({ withLineage: true });
  await requestDesiredSetpoint(lin.db, {
    organizationId: 'org-a',
    assetId: 12,
    desiredPatch: { targetTempC: -18 },
    actor: { userId: '101', username: 'mgr-a' },
  });
  assert.equal(lin.lineageEdges.length, 1);
  assert.equal(lin.lineageEdges[0].relationType, 'twin_command');
});

test('2-Phase SHA-256 Bulk Import enforces allowlist, RFC-4180 CSV, limits, formula/XSS sanitization, fail-closed prod secret, replay & mismatch guards', async () => {
  const {
    ALLOWED_IMPORT_COLLECTIONS,
    runBulkImportDryRun,
    commitBulkImport,
  } = require(path.join(PLUGIN_ROOT, 'src/server/bulk-import.js'));

  assert.equal(ALLOWED_IMPORT_COLLECTIONS.has('latticeAssets'), true);
  assert.equal(ALLOWED_IMPORT_COLLECTIONS.has('latticeLocations'), true);
  assert.equal(ALLOWED_IMPORT_COLLECTIONS.has('latticeDepartments'), true);

  const { db, locations, stockLots, ledgerRows } = makeTwinAndImportHarness({ withLedger: true });

  // 1. Disallowed collections rejected 403
  for (const forbidden of ['users', 'roles', 'latticeApiKeys', 'latticeCryptoLedger']) {
    await assert.rejects(
      () => runBulkImportDryRun(db, {
        organizationId: 'org-a',
        collection: forbidden,
        format: 'json',
        rows: [{ code: 'X', name: 'Y' }],
      }),
      (err) => err.status === 403 && err.code === 'BULK_IMPORT_COLLECTION_FORBIDDEN',
    );
  }

  // 2. Fail-closed production signing key check when ENCRYPTION_FIELD_KEY and APP_KEY are missing
  const prevEnv = {
    NODE_ENV: process.env.NODE_ENV,
    ENCRYPTION_FIELD_KEY: process.env.ENCRYPTION_FIELD_KEY,
    APP_KEY: process.env.APP_KEY,
  };
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.ENCRYPTION_FIELD_KEY;
    delete process.env.APP_KEY;
    await assert.rejects(
      () => runBulkImportDryRun(db, {
        organizationId: 'org-a',
        collection: 'latticeLocations',
        format: 'json',
        rows: [{ code: 'LOC-P1', name: 'Prod Loc' }],
      }),
      (err) => err.status === 503 && err.code === 'BULK_IMPORT_SIGNING_KEY_MISSING',
    );
    await assert.rejects(
      () => commitBulkImport(db, {
        organizationId: 'org-a',
        collection: 'latticeLocations',
        format: 'json',
        rows: [{ code: 'LOC-P1', name: 'Prod Loc' }],
        previewToken: 'ldx_imp_a.b',
      }),
      (err) => err.status === 503 && err.code === 'BULK_IMPORT_SIGNING_KEY_MISSING',
    );
    process.env.APP_KEY = 'prod-app-key-for-bulk-import-test';
    const prodOk = await runBulkImportDryRun(db, {
      organizationId: 'org-a',
      collection: 'latticeLocations',
      format: 'json',
      rows: [{ code: 'LOC-P1', name: 'Prod Loc' }],
    });
    assert.match(prodOk.previewToken, /^ldx_imp_/);
  } finally {
    if (prevEnv.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevEnv.NODE_ENV;
    if (prevEnv.ENCRYPTION_FIELD_KEY === undefined) delete process.env.ENCRYPTION_FIELD_KEY;
    else process.env.ENCRYPTION_FIELD_KEY = prevEnv.ENCRYPTION_FIELD_KEY;
    if (prevEnv.APP_KEY === undefined) delete process.env.APP_KEY;
    else process.env.APP_KEY = prevEnv.APP_KEY;
  }

  // 3. Payload size (>2 MiB) & row count (>500) caps enforced
  await assert.rejects(
    () => runBulkImportDryRun(db, {
      organizationId: 'org-a',
      collection: 'latticeLocations',
      format: 'csv',
      content: 'code,name\n' + 'A,B\n'.repeat(501),
    }),
    (err) => err.status === 400 && err.code === 'BULK_IMPORT_LIMIT_EXCEEDED',
  );
  await assert.rejects(
    () => runBulkImportDryRun(db, {
      organizationId: 'org-a',
      collection: 'latticeLocations',
      format: 'csv',
      content: 'code,name\nA,' + 'x'.repeat(2 * 1024 * 1024 + 100),
    }),
    (err) => err.status === 400 && err.code === 'BULK_IMPORT_LIMIT_EXCEEDED',
  );

  // 4. RFC-4180 CSV with BOM, quoted commas, "" escape, formula injection, XSS row, protected fields & org override attempt
  const csvContent = '\uFEFFcode,name,address,organizationId,id,version,secretRole\r\n'
    + 'LOC-EXIST,"Kho cũ, ""Đã có""","Số 1, Cần Thơ",org-b,999,99,admin\r\n'
    + 'LOC-NEW,"=CMD|\'/C calc\'!A0","Quận Ninh Kiều, ""TT""",org-b,888,5,super\r\n'
    + 'LOC-XSS,"<script>alert(1)</script>","Bad",org-a,1,1,none\r\n'
    + ',Missing Code,"Addr",org-a,2,1,none\r\n';

  const dryRun = await runBulkImportDryRun(db, {
    organizationId: 'org-a',
    collection: 'latticeLocations',
    format: 'csv',
    content: csvContent,
    signingSecret: 'unit-test-import-secret-2026',
  });
  assert.match(dryRun.previewToken, /^ldx_imp_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.match(dryRun.payloadSha256, /^[0-9a-f]{64}$/);
  assert.equal(dryRun.totalRows, 4);
  assert.equal(dryRun.validCount, 2);
  assert.equal(dryRun.invalidCount, 2);
  assert.equal(dryRun.sampleValidRows[0].address, 'Số 1, Cần Thơ');
  assert.equal(dryRun.sampleValidRows[0].id, undefined);
  assert.equal(dryRun.sampleValidRows[0].version, undefined);
  assert.equal(dryRun.sampleValidRows[0].secretRole, undefined);
  assert.equal(dryRun.sampleValidRows[0].organizationId, undefined);
  assert.equal(dryRun.sampleValidRows[1].name.startsWith('='), false);
  assert.ok(dryRun.sampleValidRows[1].name.startsWith("'="));

  // 5. Edited payload between Dry-Run and Commit rejected 409 BULK_IMPORT_PAYLOAD_MISMATCH (and does NOT consume nonce)
  await assert.rejects(
    () => commitBulkImport(db, {
      organizationId: 'org-a',
      collection: 'latticeLocations',
      format: 'csv',
      content: csvContent.replace('LOC-NEW', 'LOC-TAMPERED'),
      previewToken: dryRun.previewToken,
      signingSecret: 'unit-test-import-secret-2026',
    }),
    (err) => err.status === 409 && err.code === 'BULK_IMPORT_PAYLOAD_MISMATCH',
  );

  // 6. Cross-org token reuse blocked 403 DXOS_CROSS_ORG_FORBIDDEN (and does NOT consume nonce)
  await assert.rejects(
    () => commitBulkImport(db, {
      organizationId: 'org-b',
      collection: 'latticeLocations',
      format: 'csv',
      content: csvContent,
      previewToken: dryRun.previewToken,
      signingSecret: 'unit-test-import-secret-2026',
    }),
    (err) => err.status === 403 && err.code === 'DXOS_CROSS_ORG_FORBIDDEN',
  );

  // 7. Tampered HMAC signature rejected
  const tamperedToken = `${dryRun.previewToken.slice(0, -1)}${dryRun.previewToken.endsWith('a') ? 'b' : 'a'}`;
  await assert.rejects(
    () => commitBulkImport(db, {
      organizationId: 'org-a',
      collection: 'latticeLocations',
      format: 'csv',
      content: csvContent,
      previewToken: tamperedToken,
      signingSecret: 'unit-test-import-secret-2026',
    }),
    (err) => err.status === 401 || err.status === 403,
  );

  // 8. Valid Commit succeeds: skips existing LOC-EXIST, inserts LOC-NEW strictly scoped to org-a, logs ledger
  const commitRes = await commitBulkImport(db, {
    organizationId: 'org-a',
    collection: 'latticeLocations',
    format: 'csv',
    content: csvContent,
    previewToken: dryRun.previewToken,
    signingSecret: 'unit-test-import-secret-2026',
    actor: { userId: '101', username: 'mgr-a' },
  });
  assert.equal(commitRes.committedCount, 1);
  assert.equal(commitRes.skippedDuplicates, 1);
  assert.equal(commitRes.payloadSha256, dryRun.payloadSha256);
  const insertedLoc = locations.find((l) => l.code === 'LOC-NEW');
  assert.ok(insertedLoc);
  assert.equal(insertedLoc.organizationId, 'org-a');
  assert.ok(ledgerRows.some((e) => e.eventType === 'data.bulk_import_committed'));

  // 9. Replay of already-consumed previewToken rejected 409 BULK_IMPORT_TOKEN_REPLAYED
  await assert.rejects(
    () => commitBulkImport(db, {
      organizationId: 'org-a',
      collection: 'latticeLocations',
      format: 'csv',
      content: csvContent,
      previewToken: dryRun.previewToken,
      signingSecret: 'unit-test-import-secret-2026',
    }),
    (err) => err.status === 409 && err.code === 'BULK_IMPORT_TOKEN_REPLAYED',
  );

  // 10. Expired previewToken rejected 400 BULK_IMPORT_TOKEN_EXPIRED
  const expiredDry = await runBulkImportDryRun(db, {
    organizationId: 'org-a',
    collection: 'latticeStockLots',
    format: 'json',
    rows: [{ lotCode: 'LOT-01', sku: 'VAC-01', productName: 'Vaccine A', qtyOnHand: 50, expiryDate: '2027-06-01T00:00:00Z' }],
    signingSecret: 'unit-test-import-secret-2026',
    ttlMs: -1000,
  });
  await assert.rejects(
    () => commitBulkImport(db, {
      organizationId: 'org-a',
      collection: 'latticeStockLots',
      format: 'json',
      rows: [{ lotCode: 'LOT-01', sku: 'VAC-01', productName: 'Vaccine A', qtyOnHand: 50, expiryDate: '2027-06-01T00:00:00Z' }],
      previewToken: expiredDry.previewToken,
      signingSecret: 'unit-test-import-secret-2026',
    }),
    (err) => err.status === 400 && err.code === 'BULK_IMPORT_TOKEN_EXPIRED',
  );

  // 11. Stock lots optional import works when repo exists & enforces qtyOnHand > 0
  const lotDry = await runBulkImportDryRun(db, {
    organizationId: 'org-a',
    collection: 'latticeStockLots',
    format: 'json',
    rows: [
      { lotCode: 'LOT-OK', sku: 'VAC-01', productName: 'Vaccine A', qtyOnHand: 25, expiryDate: '2027-06-01T00:00:00Z' },
      { lotCode: 'LOT-BAD', sku: 'VAC-01', productName: 'Vaccine B', qtyOnHand: 0, expiryDate: '2027-06-01T00:00:00Z' },
    ],
    signingSecret: 'unit-test-import-secret-2026',
  });
  assert.equal(lotDry.validCount, 1);
  assert.equal(lotDry.invalidCount, 1);
  const lotCommit = await commitBulkImport(db, {
    organizationId: 'org-a',
    collection: 'latticeStockLots',
    format: 'json',
    rows: [
      { lotCode: 'LOT-OK', sku: 'VAC-01', productName: 'Vaccine A', qtyOnHand: 25, expiryDate: '2027-06-01T00:00:00Z' },
      { lotCode: 'LOT-BAD', sku: 'VAC-01', productName: 'Vaccine B', qtyOnHand: 0, expiryDate: '2027-06-01T00:00:00Z' },
    ],
    previewToken: lotDry.previewToken,
    signingSecret: 'unit-test-import-secret-2026',
  });
  assert.equal(lotCommit.committedCount, 1);
  assert.equal(stockLots.length, 1);
});

test('blocks-api, plugin index.js ACLs & direct REST guard, and Node-RED twin downlink flows wire cleanly', async () => {
  const { createDxosBlocksActions } = require(path.join(PLUGIN_ROOT, 'src/server/blocks-api.js'));
  const DxosBlocksServerPlugin = loadWithNocobaseStubs(
    path.join(PLUGIN_ROOT, 'src/server/index.js'),
    { '@nocobase/server': { Plugin: class { constructor(opts = {}) { Object.assign(this, opts); } } } },
  );

  const { db } = makeTwinAndImportHarness();
  const aclCalls = [];
  const middlewares = [];
  let definedResource = null;
  const plugin = new DxosBlocksServerPlugin({
    db,
    app: {
      resourceManager: {
        define: (def) => { definedResource = def; },
        use: (fn) => { middlewares.push(fn); },
      },
      acl: { allow: (...args) => aclCalls.push(args) },
    },
  });
  await plugin.load();

  for (const actName of ['twinShadow', 'twinSetDesired', 'twinAckCommand', 'bulkImportDryRun', 'bulkImportCommit']) {
    assert.equal(typeof definedResource.actions[actName], 'function', `Missing action ${actName}`);
  }
  assert.ok(aclCalls.some(([r, acts, scope]) => r === 'dxosBlocks' && Array.isArray(acts) && acts.includes('twinShadow') && acts.includes('twinSetDesired') && acts.includes('bulkImportDryRun') && acts.includes('bulkImportCommit') && scope === 'loggedIn'));
  assert.ok(aclCalls.some(([r, acts, scope]) => r === 'dxosBlocks' && Array.isArray(acts) && acts.includes('twinAckCommand') && scope === 'public'));

  const guardMw = middlewares[0];
  await assert.rejects(
    () => guardMw({ state: { currentRole: 'ldx_manager' }, action: { resourceName: 'latticeTwinShadows', actionName: 'update' } }, async () => {}),
    (err) => err.status === 403 && err.code === 'TWIN_DIRECT_CRUD_FORBIDDEN',
  );
  await assert.rejects(
    () => guardMw({ state: { currentRole: 'ldx_manager' }, action: { resourceName: 'charts', actionName: 'queryData', params: { values: { collection: 'latticeTwinShadows' } } } }, async () => {}),
    (err) => err.status === 403 && err.code === 'TWIN_DIRECT_CRUD_FORBIDDEN',
  );
  let rootAllowed = false;
  await guardMw({ state: { currentRole: 'root' }, action: { resourceName: 'latticeTwinShadows', actionName: 'list' } }, async () => { rootAllowed = true; });
  assert.equal(rootAllowed, true);

  // Action-level end-to-end checks
  const actions = createDxosBlocksActions(db, { ingestToken: 'edge-secret-token-2026-0123456789' });

  // Unauthenticated twinAckCommand rejected 401
  await assert.rejects(
    () => actions.twinAckCommand({
      method: 'POST',
      headers: {},
      state: {},
      action: { params: { values: { organizationId: 'org-a', assetId: 12, reportedPatch: { targetTempC: -18 } } } },
    }, async () => {}),
    (err) => err.status === 401,
  );

  // Set desired via twinSetDesired -> twinAckCommand w/ edge token -> twinShadow GET
  // Non-root caller attempting hitlApproved bypass over HTTP is denied 403
  await assert.rejects(
    () => actions.twinSetDesired({
      method: 'POST',
      state: { currentUser: { id: 101, username: 'mgr-a' }, currentRole: 'ldx_manager' },
      action: { params: { values: { assetId: 12, desiredPatch: { targetTempC: -18 }, hitlApproved: true } } },
    }, async () => {}),
    (err) => err.status === 403 && err.code === 'TWIN_HITL_APPROVAL_REQUIRED',
  );

  const setCtx = {
    method: 'POST',
    state: { currentUser: { id: 101, username: 'mgr-a' }, currentRole: 'ldx_manager' },
    action: { params: { values: { assetId: 12, desiredPatch: { targetTempC: -18 } } } },
  };
  await actions.twinSetDesired(setCtx, async () => {});
  assert.equal(setCtx.body.gatedByHitl, false);

  const ackCtx = {
    method: 'POST',
    headers: { 'X-Lattice-Edge-Token': 'edge-secret-token-2026-0123456789' },
    state: {},
    action: {
      params: {
        values: {
          organizationId: 'org-a',
          assetId: 12,
          commandId: setCtx.body.commandId,
          reportedPatch: { targetTempC: -18 },
          ackStatus: 'acked',
        },
      },
    },
  };
  await actions.twinAckCommand(ackCtx, async () => {});
  assert.equal(ackCtx.body.commandStatus, 'synced');

  const getCtx = {
    method: 'GET',
    state: { currentUser: { id: 101, username: 'mgr-a' }, currentRole: 'ldx_manager' },
    action: { params: { assetId: 12 } },
  };
  await actions.twinShadow(getCtx, async () => {});
  assert.equal(getCtx.body.shadow.commandStatus, 'synced');
  assert.equal(getCtx.body.shadow.desiredJson.targetTempC, -18);

  // Bulk import actions enforce ACL and round-trip
  await assert.rejects(
    () => actions.bulkImportDryRun({
      method: 'POST',
      state: { currentUser: { id: 101, username: 'emp' }, currentRole: 'ldx_employee' },
      action: { params: { values: { collection: 'latticeAssets', format: 'json', rows: [{ code: 'A1', name: 'Asset 1' }] } } },
    }, async () => {}),
    (err) => err.status === 403 && err.code === 'DXOS_ACL_DENIED',
  );

  const dryCtx = {
    method: 'POST',
    state: { currentUser: { id: 101, username: 'mgr-a' }, currentRole: 'ldx_manager' },
    action: { params: { values: { collection: 'latticeDepartments', format: 'json', rows: [{ code: 'DEPT-01', name: 'Kho vận' }] } } },
  };
  await actions.bulkImportDryRun(dryCtx, async () => {});
  assert.equal(dryCtx.body.validCount, 1);

  const commitCtx = {
    method: 'POST',
    state: { currentUser: { id: 101, username: 'mgr-a' }, currentRole: 'ldx_manager' },
    action: { params: { values: { collection: 'latticeDepartments', format: 'json', rows: [{ code: 'DEPT-01', name: 'Kho vận' }], previewToken: dryCtx.body.previewToken } } },
  };
  await actions.bulkImportCommit(commitCtx, async () => {});
  assert.equal(commitCtx.body.committedCount, 1);

  // Node-RED flows.json validation
  const flows = JSON.parse(readFileSync(path.join(REPO_ROOT, 'infra/config/nodered/flows.json'), 'utf8'));
  assert.ok(flows.some((n) => n.id === 'latticedx-iiot-tab' && n.type === 'tab'));
  assert.ok(flows.some((n) => n.id === 'latticedx-twin-downlink-tab' && n.type === 'tab' && n.label === 'LatticeDX Digital Twin Downlink'));
  const httpIn = flows.find((n) => n.z === 'latticedx-twin-downlink-tab' && n.type === 'http in');
  assert.ok(httpIn && httpIn.url === '/twin/command' && httpIn.method.toLowerCase() === 'post');
  const mqttOut = flows.find((n) => n.z === 'latticedx-twin-downlink-tab' && n.type === 'mqtt out');
  assert.ok(mqttOut && mqttOut.broker === 'latticedx-mqtt-broker');
  const ackIn = flows.find((n) => n.z === 'latticedx-twin-downlink-tab' && n.type === 'mqtt in' && n.topic === 'latticedx/+/+/ack');
  assert.ok(ackIn && ackIn.broker === 'latticedx-mqtt-broker');
  const ackHttp = flows.find((n) => n.z === 'latticedx-twin-downlink-tab' && n.type === 'http request');
  assert.ok(ackHttp && ackHttp.url === '' && ackHttp.method === 'POST');

  const cmdFnNode = flows.find((n) => n.z === 'latticedx-twin-downlink-tab' && n.type === 'function' && n.wires?.flat().includes(mqttOut.id));
  const ackFnNode = flows.find((n) => n.z === 'latticedx-twin-downlink-tab' && n.type === 'function' && n.wires?.flat().includes(ackHttp.id));
  assert.ok(cmdFnNode && ackFnNode);

  const envMap = new Map([['DX_IIOT_INGEST_TOKEN', 'edge-secret-token-2026-0123456789']]);
  const fakeEnv = { get: (k) => envMap.get(k) };
  const fakeNode = { warn: () => {}, error: () => {} };

  const runCmdFn = new Function('msg', 'node', 'env', cmdFnNode.func);
  assert.equal(runCmdFn({ headers: {}, payload: { organizationId: 'org-a', assetId: 12 } }, fakeNode, fakeEnv), null);
  assert.equal(runCmdFn({ headers: { 'x-lattice-edge-token': 'edge-secret-token-2026-0123456789' }, payload: { organizationId: 'org-a', assetEntityId: 'bad/#' } }, fakeNode, fakeEnv), null);
  const cmdOut = runCmdFn({
    headers: { 'X-Lattice-Edge-Token': 'edge-secret-token-2026-0123456789' },
    payload: { organizationId: 'org-a', assetId: 12, commandId: 'cmd-123', desired: { targetTempC: -18 } },
  }, fakeNode, fakeEnv);
  assert.equal(cmdOut.topic, 'latticedx/org-a/12/command');

  const runAckFn = new Function('msg', 'node', 'env', ackFnNode.func);
  assert.equal(runAckFn({ topic: 'bad/topic', payload: {} }, fakeNode, fakeEnv), null);
  assert.equal(runAckFn({ topic: 'latticedx/org-a/12/ack', payload: {} }, fakeNode, { get: () => 'short' }), null);
  const ackOut = runAckFn({
    topic: 'latticedx/org-a/12/ack',
    payload: JSON.stringify({ commandId: 'cmd-123', ackStatus: 'acked', reportedPatch: { targetTempC: -18 } }),
  }, fakeNode, fakeEnv);
  assert.equal(ackOut.url, 'http://nocobase/api/dxosBlocks:twinAckCommand');
  assert.equal(ackOut.headers['X-Lattice-Edge-Token'], 'edge-secret-token-2026-0123456789');
  assert.equal(ackOut.payload.organizationId, 'org-a');
  assert.equal(ackOut.payload.assetEntityId, 'urn:ngsi-ld:Asset:org-a:native:12');
});
