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
    ttlMs: 5,
  });
  const expiredAtMs = Date.parse(expiredDry.expiresAt);
  while (Date.now() <= expiredAtMs + 2) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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

  const cmdFnNode = flows.find((n) => n.z === 'latticedx-twin-downlink-tab' && n.type === 'function' && n.wires?.[0]?.includes(mqttOut.id));
  const errResNode = flows.find((n) => n.z === 'latticedx-twin-downlink-tab' && n.type === 'http response' && n.id === 'latticedx-twin-http-err');
  const ackFnNode = flows.find((n) => n.z === 'latticedx-twin-downlink-tab' && n.type === 'function' && n.wires?.flat().includes(ackHttp.id));
  assert.ok(cmdFnNode && errResNode && ackFnNode);
  assert.equal(cmdFnNode.outputs, 2);
  assert.ok(cmdFnNode.wires[1].includes(errResNode.id), 'Second output of twin command function must wire to http error response');

  const envMap = new Map([['DX_IIOT_INGEST_TOKEN', 'edge-secret-token-2026-0123456789']]);
  const fakeEnv = { get: (k) => envMap.get(k) };
  const fakeNode = { warn: () => {}, error: () => {} };

  const runCmdFn = new Function('msg', 'node', 'env', cmdFnNode.func);
  const unauthOut = runCmdFn({ res: { id: 'res-1' }, headers: {}, payload: { organizationId: 'org-a', assetId: 12 } }, fakeNode, fakeEnv);
  assert.equal(unauthOut[0], null);
  assert.equal(unauthOut[1].statusCode, 401);
  assert.equal(unauthOut[1].res.id, 'res-1');

  const badTokenOut = runCmdFn({ headers: { 'x-lattice-edge-token': 'wrong-token-value-1234567890' }, payload: { organizationId: 'org-a', assetId: 12 } }, fakeNode, fakeEnv);
  assert.equal(badTokenOut[0], null);
  assert.equal(badTokenOut[1].statusCode, 401);

  const badEntityOut = runCmdFn({ headers: { 'x-lattice-edge-token': 'edge-secret-token-2026-0123456789' }, payload: { organizationId: 'org-a', assetEntityId: 'bad/#' } }, fakeNode, fakeEnv);
  assert.equal(badEntityOut[0], null);
  assert.equal(badEntityOut[1].statusCode, 400);

  // Cross-org URN in assetEntityId MUST be rejected 400 even when valid assetId is supplied
  const crossOrgUrnWithAssetId = runCmdFn({
    headers: { 'x-lattice-edge-token': 'edge-secret-token-2026-0123456789' },
    payload: { organizationId: 'org-a', assetId: 12, assetEntityId: 'urn:ngsi-ld:Asset:org-b:native:12' },
  }, fakeNode, fakeEnv);
  assert.equal(crossOrgUrnWithAssetId[0], null);
  assert.equal(crossOrgUrnWithAssetId[1].statusCode, 400);

  const mismatchUrnOut = runCmdFn({
    headers: { 'x-lattice-edge-token': 'edge-secret-token-2026-0123456789' },
    payload: { organizationId: 'org-a', assetId: 12, assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:99' },
  }, fakeNode, fakeEnv);
  assert.equal(mismatchUrnOut[0], null);
  assert.equal(mismatchUrnOut[1].statusCode, 400);

  const cmdOutArr = runCmdFn({
    headers: { 'X-Lattice-Edge-Token': 'edge-secret-token-2026-0123456789' },
    payload: {
      organizationId: 'org-a',
      assetId: 12,
      assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12',
      commandId: 'cmd-123',
      desired: { targetTempC: -18 },
    },
  }, fakeNode, fakeEnv);
  assert.equal(cmdOutArr[1], null);
  assert.equal(cmdOutArr[0].statusCode, 202);
  assert.equal(cmdOutArr[0].topic, 'latticedx/org-a/12/command');

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

test('Digital Twin executes DB + ledger inside transaction before downlink, enforces merged bounds, and aligns fallback lineage edgeUid', async () => {
  const { requestDesiredSetpoint } = require(path.join(PLUGIN_ROOT, 'src/server/digital-twin.js'));

  // 1. Transactional rollback proof: real snapshot-rollback sequelize stub ensures uncommitted writes roll back & fetchImpl never fires
  const committed = {
    shadows: [],
    approvals: [],
    ledger: [],
  };
  const assets = [{ id: 12, code: 'CH-12', name: 'Kho A', organizationId: 'org-a', status: 'active' }];
  const pkiKeys = [
    { id: 1, organizationId: 'org-a', keyId: 'k1', algorithm: 'Ed25519', publicKeyPem: 'stub', encryptedPrivateKey: '00:00:00', fingerprintSha256: '0'.repeat(64), active: false },
  ];
  let activeBuffer = null;
  let txSeq = 0;
  const txEventLog = [];

  const getStore = (name, tx) => {
    const buf = tx && activeBuffer?.tx === tx ? activeBuffer.data : committed;
    return buf[name];
  };
  const makeTxRepo = (storeName) => ({
    find: async ({ filter = {}, limit = 100, transaction } = {}) => {
      const arr = storeName ? getStore(storeName, transaction) : [];
      return arr.filter((r) => Object.entries(filter).every(([k, v]) => r[k] === v)).slice(0, limit);
    },
    findOne: async ({ filter = {}, transaction } = {}) => {
      const arr = storeName ? getStore(storeName, transaction) : [];
      return arr.find((r) => Object.entries(filter).every(([k, v]) => r[k] === v)) || null;
    },
    create: async ({ values, transaction }) => {
      txEventLog.push(`create:${storeName}`);
      const arr = getStore(storeName, transaction);
      const row = { id: arr.length + 100, ...values };
      arr.push(row);
      return row;
    },
    update: async ({ filterByTk, filter = {}, values, transaction }) => {
      txEventLog.push(`update:${storeName}`);
      const arr = getStore(storeName, transaction);
      const out = [];
      for (const row of arr) {
        if ((filterByTk == null || Number(row.id) === Number(filterByTk)) && Object.entries(filter).every(([k, v]) => row[k] === v)) {
          Object.assign(row, values);
          out.push(row);
        }
      }
      return out;
    },
  });

  const txDb = {
    sequelize: {
      getDialect: () => 'sqlite',
      transaction: async (fn) => {
        const tx = { id: `tx-${++txSeq}` };
        const snapshot = {
          shadows: structuredClone(committed.shadows),
          approvals: structuredClone(committed.approvals),
          ledger: structuredClone(committed.ledger),
        };
        activeBuffer = { tx, data: snapshot };
        txEventLog.push(`tx:start:${tx.id}`);
        try {
          const out = await fn(tx);
          committed.shadows = snapshot.shadows;
          committed.approvals = snapshot.approvals;
          committed.ledger = snapshot.ledger;
          txEventLog.push(`tx:commit:${tx.id}`);
          return out;
        } catch (err) {
          txEventLog.push(`tx:rollback:${tx.id}`);
          throw err;
        } finally {
          activeBuffer = null;
        }
      },
    },
    getRepository(name) {
      if (name === 'latticeTwinShadows') return makeTxRepo('shadows');
      if (name === 'latticeAiApprovalQueue') return makeTxRepo('approvals');
      if (name === 'latticeCryptoLedger') return makeTxRepo('ledger');
      if (name === 'latticePkiKeys') {
        return {
          find: async ({ filter = {} } = {}) => pkiKeys.filter((k) => k.organizationId === filter.organizationId),
          findOne: async ({ filter = {} } = {}) => pkiKeys.find((k) => k.organizationId === filter.organizationId) || null,
          create: async ({ values }) => values,
        };
      }
      if (name === 'latticeAssets') {
        return { findOne: async ({ filter = {} } = {}) => assets.find((a) => a.id === filter.id && a.organizationId === filter.organizationId) || null };
      }
      return null;
    },
  };

  let downlinkCalls = 0;
  await assert.rejects(
    () => requestDesiredSetpoint(txDb, {
      organizationId: 'org-a',
      assetId: 12,
      desiredPatch: { targetTempC: -18 },
      actor: { userId: '101', username: 'mgr-a' },
      downlinkUrl: 'http://nodered:1880/twin/command',
      fetchImpl: async () => {
        downlinkCalls += 1;
        return new Response('', { status: 202 });
      },
    }),
    (err) => err.code === 'PKI_KEY_INACTIVE',
  );
  assert.equal(downlinkCalls, 0, 'Node-RED webhook MUST NOT fire when ledger/transaction fails');
  assert.equal(committed.shadows.length, 0, 'Shadow insert MUST roll back on PKI_KEY_INACTIVE');

  // HITL path rollback when PKI key is inactive
  committed.shadows.push({
    id: 501,
    organizationId: 'org-a',
    assetId: 12,
    assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12',
    desiredJson: { targetTempC: -18, minTempC: -22, maxTempC: -15 },
    reportedJson: {},
    commandStatus: 'synced',
    version: 1,
  });
  await assert.rejects(
    () => requestDesiredSetpoint(txDb, {
      organizationId: 'org-a',
      assetId: 12,
      desiredPatch: { targetTempC: -10 },
      actor: { userId: '101', username: 'mgr-a' },
    }),
    (err) => err.code === 'PKI_KEY_INACTIVE',
  );
  assert.equal(committed.approvals.length, 0, 'HITL approval queue insert MUST roll back on PKI_KEY_INACTIVE');
  assert.equal(committed.shadows[0].commandStatus, 'synced', 'HITL shadow status update MUST roll back');

  // Ack path rollback when PKI key is inactive
  const { ackCommandFromEdge } = require(path.join(PLUGIN_ROOT, 'src/server/digital-twin.js'));
  await assert.rejects(
    () => ackCommandFromEdge(txDb, {
      organizationId: 'org-a',
      assetId: 12,
      reportedPatch: { targetTempC: -17 },
      ackStatus: 'acked',
    }),
    (err) => err.code === 'PKI_KEY_INACTIVE',
  );
  assert.equal(committed.shadows[0].commandStatus, 'synced', 'Ack shadow status update MUST roll back on PKI_KEY_INACTIVE');
  assert.equal(committed.shadows[0].reportedJson.targetTempC, undefined, 'Ack reportedJson mutation MUST roll back');

  // 2. Merged minTempC/maxTempC bounds check catches partial patches inverting persisted bounds
  const { db: mergedDb, shadows: mergedShadows } = makeTwinAndImportHarness();
  await requestDesiredSetpoint(mergedDb, {
    organizationId: 'org-a',
    assetId: 12,
    desiredPatch: { targetTempC: -18, minTempC: -22, maxTempC: -15 },
    actor: { userId: '101', username: 'mgr-a' },
  });
  await assert.rejects(
    () => requestDesiredSetpoint(mergedDb, {
      organizationId: 'org-a',
      assetId: 12,
      desiredPatch: { minTempC: -10 },
      actor: { userId: '101', username: 'mgr-a' },
    }),
    (err) => err.status === 400 && err.code === 'TWIN_DESIRED_INVALID',
  );
  await assert.rejects(
    () => requestDesiredSetpoint(mergedDb, {
      organizationId: 'org-a',
      assetId: 12,
      desiredPatch: { maxTempC: -25 },
      actor: { userId: '101', username: 'mgr-a' },
    }),
    (err) => err.status === 400 && err.code === 'TWIN_DESIRED_INVALID',
  );
  assert.equal(mergedShadows[0].desiredJson.minTempC, -22);
  assert.equal(mergedShadows[0].desiredJson.maxTempC, -15);

  // 3. Commit-before-dispatch execution order proof
  txEventLog.length = 0;
  const orderRes = await requestDesiredSetpoint(
    {
      sequelize: txDb.sequelize,
      getRepository: (name) => {
        if (name === 'latticeCryptoLedger' || name === 'latticePkiKeys') return null;
        return txDb.getRepository(name);
      },
    },
    {
      organizationId: 'org-a',
      assetId: 12,
      desiredPatch: { targetTempC: -17 },
      actor: { userId: '101', username: 'mgr-a' },
      downlinkUrl: 'http://nodered:1880/twin/command',
      fetchImpl: async () => {
        txEventLog.push('fetch:dispatch');
        return new Response('', { status: 202 });
      },
    },
  );
  assert.equal(orderRes.downlinkDispatched, true);
  const commitIdx = txEventLog.findIndex((e) => e.startsWith('tx:commit:'));
  const fetchIdx = txEventLog.indexOf('fetch:dispatch');
  assert.ok(commitIdx >= 0 && fetchIdx > commitIdx, `Expected tx:commit before fetch:dispatch, got ${txEventLog.join(' -> ')}`);

  // 4. Fallback recordTwinLineageSafely matches data-governance.js edgeUid format `lin-${sha256.slice(0, 32)}`
  const twinPath = path.join(PLUGIN_ROOT, 'src/server/digital-twin.js');
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (typeof request === 'string' && request.includes('data-governance')) {
      const err = new Error(`Cannot find module '${request}'`);
      err.code = 'MODULE_NOT_FOUND';
      throw err;
    }
    return origLoad.call(this, request, parent, isMain);
  };
  let isolatedTwin;
  try {
    delete require.cache[require.resolve(twinPath)];
    isolatedTwin = require(twinPath);
  } finally {
    Module._load = origLoad;
    delete require.cache[require.resolve(twinPath)];
  }
  const fallbackLin = makeTwinAndImportHarness({ withLineage: true });
  await isolatedTwin.requestDesiredSetpoint(fallbackLin.db, {
    organizationId: 'org-a',
    assetId: 12,
    desiredPatch: { targetTempC: -18 },
    actor: { userId: '101', username: 'mgr-a' },
  });
  assert.equal(fallbackLin.lineageEdges.length, 1);
  assert.match(fallbackLin.lineageEdges[0].edgeUid, /^lin-[0-9a-f]{32}$/);
  const normalLin = makeTwinAndImportHarness({ withLineage: true });
  await requestDesiredSetpoint(normalLin.db, {
    organizationId: 'org-a',
    assetId: 12,
    desiredPatch: { targetTempC: -18 },
    actor: { userId: '101', username: 'mgr-a' },
  });
  assert.equal(fallbackLin.lineageEdges[0].edgeUid, normalLin.lineageEdges[0].edgeUid);
});

test('Bulk Import validates cross-org & missing FKs, rejects malformed quoted CSV, negative qtyReserved, and invalid ttlMs', async () => {
  const {
    parseRfc4180Csv,
    runBulkImportDryRun,
    commitBulkImport,
  } = require(path.join(PLUGIN_ROOT, 'src/server/bulk-import.js'));

  // 1. Trailing unquoted non-whitespace characters after closing CSV quote must fail 400
  assert.throws(
    () => parseRfc4180Csv('code,name\n"A"trailing,"Valid"\n'),
    (err) => err.status === 400 && err.code === 'BULK_IMPORT_PARSE_ERROR',
  );
  assert.throws(
    () => parseRfc4180Csv('code,name\n"A" "B","Valid"\n'),
    (err) => err.status === 400 && err.code === 'BULK_IMPORT_PARSE_ERROR',
  );
  const spacedRows = parseRfc4180Csv('code,name\n"A"  \t,"Valid" \n');
  assert.equal(spacedRows[0].code, 'A');
  assert.equal(spacedRows[0].name, 'Valid');

  // 2. Non-finite / non-positive ttlMs rejected 400 BULK_IMPORT_TTL_INVALID
  const { db, departments, locations } = makeTwinAndImportHarness();
  departments.push(
    { id: 3, code: 'DEPT-A', name: 'Kho A', organizationId: 'org-a', active: true },
    { id: 4, code: 'DEPT-B', name: 'Kho B', organizationId: 'org-b', active: true },
  );
  locations.push(
    { id: 2, code: 'LOC-B', name: 'Kho Org B', organizationId: 'org-b', active: true },
  );

  for (const badTtl of [0, -1000, NaN, Infinity, -Infinity, 'abc', '', null, true]) {
    await assert.rejects(
      () => runBulkImportDryRun(db, {
        organizationId: 'org-a',
        collection: 'latticeDepartments',
        format: 'json',
        rows: [{ code: 'D-1', name: 'Dept 1' }],
        ttlMs: badTtl,
      }),
      (err) => err.status === 400 && err.code === 'BULK_IMPORT_TTL_INVALID',
    );
  }

  // 3. Negative qtyReserved rejected 400 INVALID_QUANTITY instead of clamping to 0
  const negQtyDry = await runBulkImportDryRun(db, {
    organizationId: 'org-a',
    collection: 'latticeStockLots',
    format: 'json',
    rows: [
      { lotCode: 'LOT-NEG', sku: 'VAC-01', productName: 'Vaccine', qtyOnHand: 20, qtyReserved: -5, expiryDate: '2027-06-01T00:00:00Z' },
    ],
  });
  assert.equal(negQtyDry.validCount, 0);
  assert.equal(negQtyDry.invalidCount, 1);
  assert.equal(negQtyDry.errors[0].code, 'INVALID_QUANTITY');

  // 4. Cross-org & missing relational FK checks (departmentId, locationId, custodianId, warehouseLocationId)
  const assetFkDry = await runBulkImportDryRun(db, {
    organizationId: 'org-a',
    collection: 'latticeAssets',
    format: 'json',
    rows: [
      { code: 'AST-OK', name: 'Valid Asset', departmentId: 3, locationId: 1, custodianId: 10 },
      { code: 'AST-XORG-DEPT', name: 'Cross-org Dept', departmentId: 4 },
      { code: 'AST-XORG-LOC', name: 'Cross-org Loc', locationId: 2 },
      { code: 'AST-XORG-CUST', name: 'Cross-org Custodian', custodianId: 20 },
      { code: 'AST-MISS-DEPT', name: 'Missing Dept', departmentId: 9999 },
    ],
  });
  assert.equal(assetFkDry.validCount, 1);
  assert.equal(assetFkDry.invalidCount, 4);
  assert.equal(assetFkDry.errors[0].code, 'DXOS_CROSS_ORG_FORBIDDEN');
  assert.equal(assetFkDry.errors[1].code, 'DXOS_CROSS_ORG_FORBIDDEN');
  assert.equal(assetFkDry.errors[2].code, 'DXOS_CROSS_ORG_FORBIDDEN');
  assert.equal(assetFkDry.errors[3].code, 'BULK_IMPORT_REFERENCE_NOT_FOUND');

  const locFkDry = await runBulkImportDryRun(db, {
    organizationId: 'org-a',
    collection: 'latticeLocations',
    format: 'json',
    rows: [
      { code: 'LOC-OK', name: 'Valid Loc', departmentId: 3 },
      { code: 'LOC-XORG', name: 'Bad Loc', departmentId: 4 },
    ],
  });
  assert.equal(locFkDry.validCount, 1);
  assert.equal(locFkDry.invalidCount, 1);
  assert.equal(locFkDry.errors[0].code, 'DXOS_CROSS_ORG_FORBIDDEN');

  const lotFkDry = await runBulkImportDryRun(db, {
    organizationId: 'org-a',
    collection: 'latticeStockLots',
    format: 'json',
    rows: [
      { lotCode: 'LOT-OK-WH', sku: 'VAC-1', productName: 'Vac', qtyOnHand: 10, warehouseLocationId: 1, expiryDate: '2027-06-01T00:00:00Z' },
      { lotCode: 'LOT-XORG-WH', sku: 'VAC-1', productName: 'Vac', qtyOnHand: 10, warehouseLocationId: 2, expiryDate: '2027-06-01T00:00:00Z' },
      { lotCode: 'LOT-MISS-WH', sku: 'VAC-1', productName: 'Vac', qtyOnHand: 10, warehouseLocationId: 9999, expiryDate: '2027-06-01T00:00:00Z' },
      { lotCode: 'LOT-XORG-URN', sku: 'VAC-1', productName: 'Vac', qtyOnHand: 10, assetEntityId: 'urn:ngsi-ld:Asset:org-b:native:99', expiryDate: '2027-06-01T00:00:00Z' },
    ],
  });
  assert.equal(lotFkDry.validCount, 1);
  assert.equal(lotFkDry.invalidCount, 3);
  assert.equal(lotFkDry.errors[0].code, 'DXOS_CROSS_ORG_FORBIDDEN');
  assert.equal(lotFkDry.errors[1].code, 'BULK_IMPORT_REFERENCE_NOT_FOUND');
  assert.equal(lotFkDry.errors[2].code, 'DXOS_CROSS_ORG_FORBIDDEN');

  // Valid FK commit succeeds
  const assetCommit = await commitBulkImport(db, {
    organizationId: 'org-a',
    collection: 'latticeAssets',
    format: 'json',
    rows: [
      { code: 'AST-OK', name: 'Valid Asset', departmentId: 3, locationId: 1, custodianId: 10 },
      { code: 'AST-XORG-DEPT', name: 'Cross-org Dept', departmentId: 4 },
      { code: 'AST-XORG-LOC', name: 'Cross-org Loc', locationId: 2 },
      { code: 'AST-XORG-CUST', name: 'Cross-org Custodian', custodianId: 20 },
      { code: 'AST-MISS-DEPT', name: 'Missing Dept', departmentId: 9999 },
    ],
    previewToken: assetFkDry.previewToken,
  });
  assert.equal(assetCommit.committedCount, 1);

  // 5. TOCTOU guard inside commitBulkImport transaction rejects missing FK deterministically before create
  const toctouRows = [{ code: 'AST-TOCTOU', name: 'Toctou Asset', departmentId: 3 }];
  const toctouDry = await runBulkImportDryRun(db, {
    organizationId: 'org-a',
    collection: 'latticeAssets',
    format: 'json',
    rows: toctouRows,
  });
  assert.equal(toctouDry.validCount, 1);
  let deptLookups = 0;
  let assetCreateCalled = false;
  const toctouDb = {
    sequelize: db.sequelize,
    getRepository(name) {
      if (name === 'latticeDepartments') {
        return {
          findOne: async ({ filter = {} } = {}) => {
            deptLookups += 1;
            // Succeed during outer prepareImportBatch, then vanish inside tx
            if (deptLookups === 1) return departments.find((d) => d.id === filter.id && d.organizationId === filter.organizationId) || null;
            return null;
          },
        };
      }
      if (name === 'latticeAssets') {
        const base = db.getRepository('latticeAssets');
        return {
          ...base,
          create: async (args) => {
            assetCreateCalled = true;
            return base.create(args);
          },
        };
      }
      return db.getRepository(name);
    },
  };
  await assert.rejects(
    () => commitBulkImport(toctouDb, {
      organizationId: 'org-a',
      collection: 'latticeAssets',
      format: 'json',
      rows: toctouRows,
      previewToken: toctouDry.previewToken,
    }),
    (err) => err.status === 400 && err.code === 'BULK_IMPORT_REFERENCE_NOT_FOUND',
  );
  assert.equal(assetCreateCalled, false, 'TOCTOU guard MUST reject before repo.create');
});

test('DxosBlocksServerPlugin registers dxosTelemetryDirectGuard before latticeNativeScope and composed charts:queryData pipeline blocks direct telemetry/twin access', async () => {
  const blocksIndexPath = require.resolve(path.join(PLUGIN_ROOT, 'src/server/index.js'));
  const foundationIndexPath = require.resolve(path.resolve(PLUGIN_ROOT, '../plugin-lattice-foundation/src/server/index.js'));
  const origLoad = Module._load;
  class MockPlugin {
    constructor(app, options = {}) {
      this.app = app;
      this.db = app?.db;
      this.options = options;
    }
  }
  class MockMigration {
    constructor(context = {}) { this.context = context; }
  }
  delete require.cache[blocksIndexPath];
  delete require.cache[foundationIndexPath];
  Module._load = function mockedNocobase(request, parent, isMain) {
    if (request === '@nocobase/server') return { Plugin: MockPlugin, Migration: MockMigration };
    if (request === '@nocobase/database') return { defineCollection: (def) => def };
    return origLoad.call(this, request, parent, isMain);
  };

  try {
    const LatticeFoundationPlugin = require(foundationIndexPath);
    const DxosBlocksServerPlugin = require(blocksIndexPath);

    const employees = [{ id: 11, userId: 101, organizationId: 'org-a', departmentId: 3, active: true }];
    const db = {
      on() {},
      sequelize: {
        getDialect: () => 'sqlite',
        transaction: async (cb) => cb({ id: 'tx-composed' }),
        query: async () => [[]],
      },
      getRepository(name) {
        if (name === 'latticeEmployees') {
          return { find: async ({ filter }) => employees.filter((e) => Number(e.userId) === Number(filter?.userId)) };
        }
        return null;
      },
    };
    const registered = [];
    const app = {
      db,
      use() {},
      resourceManager: {
        use(fn, opts) { registered.push({ fn, opts }); },
        define() {},
      },
      acl: { allow() {}, registerSnippet() {} },
      cronJobManager: { addJob() {} },
      logger: { info() {}, warn() {}, error() {} },
    };

    // Load plugin-lattice-foundation FIRST (matching runtime load order), then plugin-dxos-blocks
    await new LatticeFoundationPlugin(app).load();
    await new DxosBlocksServerPlugin(app).load();

    const guardEntry = registered.find((m) => m.opts?.tag === 'dxosTelemetryDirectGuard');
    const nativeEntry = registered.find((m) => m.opts?.tag === 'latticeNativeScope');
    assert.ok(guardEntry, 'DxosBlocksServerPlugin must register dxosTelemetryDirectGuard');
    assert.ok(nativeEntry, 'LatticeFoundationPlugin must register latticeNativeScope');
    assert.deepEqual(guardEntry.opts, {
      tag: 'dxosTelemetryDirectGuard',
      after: 'acl',
      before: 'latticeNativeScope',
    });

    const resolveOrder = (entries) => {
      const remaining = [...entries];
      const ordered = [];
      const placed = new Set(['acl']);
      while (remaining.length) {
        const idx = remaining.findIndex((item) => {
          const afterTags = item.opts?.after ? (Array.isArray(item.opts.after) ? item.opts.after : [item.opts.after]) : [];
          const afterOk = afterTags.every((t) => placed.has(t) || !entries.some((e) => e.opts?.tag === t));
          const blockedByBefore = remaining.some((other) => {
            if (other === item) return false;
            const beforeTags = other.opts?.before ? (Array.isArray(other.opts.before) ? other.opts.before : [other.opts.before]) : [];
            return beforeTags.includes(item.opts?.tag);
          });
          return afterOk && !blockedByBefore;
        });
        assert.ok(idx >= 0, 'Cycle detected in middleware topological constraints');
        const [chosen] = remaining.splice(idx, 1);
        ordered.push(chosen);
        if (chosen.opts?.tag) placed.add(chosen.opts.tag);
      }
      return ordered;
    };

    const sortedEntries = resolveOrder(registered);
    const sortedTags = sortedEntries.map((m) => m.opts?.tag);
    assert.ok(
      sortedTags.indexOf('dxosTelemetryDirectGuard') < sortedTags.indexOf('latticeNativeScope'),
      `Expected dxosTelemetryDirectGuard before latticeNativeScope, got ${sortedTags.join(' -> ')}`,
    );

    const compose = (middlewares, handler) => async (ctx) => {
      let idx = -1;
      const dispatch = async (i) => {
        if (i <= idx) throw new Error('next() called multiple times');
        idx = i;
        const fn = i < middlewares.length ? middlewares[i] : handler;
        if (!fn) return undefined;
        return fn(ctx, () => dispatch(i + 1));
      };
      return dispatch(0);
    };

    const pipeline = compose([guardEntry.fn, nativeEntry.fn], async () => {});

    // Both without mode:'builder' and with mode:'builder', direct guard MUST reject before latticeNativeScope
    for (const values of [
      { collection: 'latticeTwinShadows' },
      { mode: 'builder', collection: 'latticeTwinShadows' },
    ]) {
      await assert.rejects(
        () => pipeline({
          state: { currentRole: 'ldx_manager', currentUser: { id: 101 } },
          action: { resourceName: 'charts', actionName: 'queryData', params: { values } },
        }),
        (err) => err.status === 403 && err.code === 'TWIN_DIRECT_CRUD_FORBIDDEN',
      );
    }

    for (const values of [
      { collection: 'latticeTelemetryPoints' },
      { mode: 'builder', collection: 'latticeTelemetryPoints' },
    ]) {
      await assert.rejects(
        () => pipeline({
          state: { currentRole: 'ldx_manager', currentUser: { id: 101 } },
          action: { resourceName: 'charts', actionName: 'queryData', params: { values } },
        }),
        (err) => err.status === 403 && err.code === 'TELEMETRY_DIRECT_CRUD_FORBIDDEN',
      );
    }

    // Normal scoped chart query passes both middlewares
    let downstreamRan = false;
    const okCtx = {
      state: { currentRole: 'ldx_manager', currentUser: { id: 101 } },
      action: { resourceName: 'charts', actionName: 'queryData', params: { values: { mode: 'builder', collection: 'latticeAssets' } } },
    };
    await compose([guardEntry.fn, nativeEntry.fn], async () => { downstreamRan = true; })(okCtx);
    assert.equal(downstreamRan, true);
    assert.equal(okCtx.state.latticeRlsOrg, 'org-a');
  } finally {
    Module._load = origLoad;
    delete require.cache[blocksIndexPath];
    delete require.cache[foundationIndexPath];
  }
});
