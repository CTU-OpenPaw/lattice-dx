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
const { createHash } = require('node:crypto');
const Module = require('node:module');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');

function makeTestHarness({ employees = [], users = [], roles = [], rolesUsers = [], resources = [], orders = [], locations = [], telemetry = [] } = {}) {
  let seq = 100;
  const orderLines = [];
  const stockLots = [];
  const epodRecords = [];
  const decisionTables = [];
  const delegations = [];
  const ledgerEntries = [];
  const pkiKeys = [];
  const lineageEdges = [];
  const quarantineRows = [];

  const attachUpdate = (row) => {
    if (row && typeof row === 'object' && !Object.hasOwn(row, 'update')) {
      Object.defineProperty(row, 'update', {
        value: async (patch) => Object.assign(row, patch),
        enumerable: false,
        configurable: true,
      });
    }
    return row;
  };

  const matchOne = (row, filter = {}) => {
    for (const [k, cond] of Object.entries(filter || {})) {
      if (k === '$and' && Array.isArray(cond)) {
        if (!cond.every((sub) => matchOne(row, sub))) return false;
        continue;
      }
      if (k === '$or' && Array.isArray(cond)) {
        if (!cond.some((sub) => matchOne(row, sub))) return false;
        continue;
      }
      const actual = row?.[k];
      if (cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)) {
        if (Object.hasOwn(cond, '$eq') && actual !== cond.$eq) return false;
        if (Object.hasOwn(cond, '$ne') && actual === cond.$ne) return false;
        if (Object.hasOwn(cond, '$in') && !cond.$in.includes(actual)) return false;
        if (Object.hasOwn(cond, '$gt') && !(new Date(actual).getTime() > new Date(cond.$gt).getTime())) return false;
        if (Object.hasOwn(cond, '$gte') && !(new Date(actual).getTime() >= new Date(cond.$gte).getTime())) return false;
        if (Object.hasOwn(cond, '$lte') && !(new Date(actual).getTime() <= new Date(cond.$lte).getTime())) return false;
      } else if (actual !== cond) {
        return false;
      }
    }
    return true;
  };

  const makeRepo = (arr) => ({
    _rows: arr,
    find: async ({ filter = {}, sort, limit, offset = 0 } = {}) => {
      let list = arr.filter((r) => matchOne(r, filter));
      if (Array.isArray(sort) && sort.length) {
        list = list.slice().sort((a, b) => {
          for (const field of sort) {
            const desc = String(field).startsWith('-');
            const key = desc ? String(field).slice(1) : String(field);
            const av = a[key];
            const bv = b[key];
            if (av === bv) continue;
            const an = av instanceof Date ? av.getTime() : Number(av);
            const bn = bv instanceof Date ? bv.getTime() : Number(bv);
            const cmp = Number.isFinite(an) && Number.isFinite(bn)
              ? an - bn
              : String(av ?? '').localeCompare(String(bv ?? ''));
            return desc ? -cmp : cmp;
          }
          return 0;
        });
      }
      const end = limit ? offset + limit : undefined;
      return list.slice(offset, end).map(attachUpdate);
    },
    findOne: async ({ filter = {}, filterByTk } = {}) => {
      const merged = filterByTk != null ? { ...filter, id: Number(filterByTk) } : filter;
      const hit = arr.find((r) => matchOne(r, merged)) || null;
      return hit ? attachUpdate(hit) : null;
    },
    count: async ({ filter = {} } = {}) => arr.filter((r) => matchOne(r, filter)).length,
    create: async ({ values }) => {
      const row = attachUpdate({ id: ++seq, createdAt: new Date(), updatedAt: new Date(), ...values });
      arr.push(row);
      return row;
    },
    update: async ({ filter = {}, filterByTk, values = {} }) => {
      const merged = filterByTk != null ? { ...filter, id: Number(filterByTk) } : filter;
      const updated = [];
      for (const row of arr) {
        if (matchOne(row, merged)) {
          Object.assign(row, values, { updatedAt: new Date() });
          updated.push(attachUpdate(row));
        }
      }
      return updated;
    },
  });

  const repos = {
    latticeEmployees: makeRepo(employees),
    users: makeRepo(users),
    roles: makeRepo(roles),
    rolesUsers: makeRepo(rolesUsers),
    dataSourcesRolesResources: makeRepo(resources),
    latticeOrders: makeRepo(orders),
    latticeLocations: makeRepo(locations),
    latticeTelemetryPoints: makeRepo(telemetry),
    latticeOrderLines: makeRepo(orderLines),
    latticeStockLots: makeRepo(stockLots),
    latticeEpodRecords: makeRepo(epodRecords),
    latticeDecisionTables: makeRepo(decisionTables),
    latticeDelegations: makeRepo(delegations),
    latticeCryptoLedger: makeRepo(ledgerEntries),
    latticePkiKeys: makeRepo(pkiKeys),
    latticeDataLineage: makeRepo(lineageEdges),
    latticeDataQuarantine: makeRepo(quarantineRows),
  };

  const db = {
    sequelize: {
      getDialect: () => 'sqlite',
      transaction: async (fn) => fn({ id: `tx-${++seq}` }),
    },
    hasCollection: (name) => Object.hasOwn(repos, name),
    getRepository: (name) => repos[name] || null,
  };

  return {
    db,
    orderLines,
    stockLots,
    epodRecords,
    decisionTables,
    delegations,
    ledgerEntries,
    pkiKeys,
    lineageEdges,
    quarantineRows,
    orders,
  };
}

test('Task 2.2 collections & migration 20261124000300 declare schemas, named indexes without inline UNIQUE, and reversible PG RLS', async () => {
  const origLoad = Module._load;
  Module._load = function mockedNocobase(request, parent, isMain) {
    if (request === '@nocobase/database') return { defineCollection: (def) => def };
    if (request === '@nocobase/server') return { Migration: class MockMigration { constructor(ctx) { this.context = ctx; } } };
    return origLoad.call(this, request, parent, isMain);
  };
  try {
    const orderLinesDef = require(path.join(PLUGIN_ROOT, 'src/server/collections/order-lines.js'));
    const stockLotsDef = require(path.join(PLUGIN_ROOT, 'src/server/collections/stock-lots.js'));
    const epodDef = require(path.join(PLUGIN_ROOT, 'src/server/collections/epod-records.js'));
    const dmnDef = require(path.join(PLUGIN_ROOT, 'src/server/collections/decision-tables.js'));
    const dlgDef = require(path.join(PLUGIN_ROOT, 'src/server/collections/delegations.js'));
    const MigrationCls = require(path.join(PLUGIN_ROOT, 'src/server/migrations/20261124000300-wms-epod-dmn-delegations.js'));

    const expectedCols = [
      [orderLinesDef, 'latticeOrderLines'],
      [stockLotsDef, 'latticeStockLots'],
      [epodDef, 'latticeEpodRecords'],
      [dmnDef, 'latticeDecisionTables'],
      [dlgDef, 'latticeDelegations'],
    ];
    for (const [def, name] of expectedCols) {
      assert.equal(def.name, name);
      assert.deepEqual(def.migrationRules, ['schema-only']);
      assert.equal(def.createdAt, true);
      assert.equal(def.updatedAt, true);
      for (const idx of def.indexes || []) {
        assert.ok(idx.name && idx.name.length <= 63, `Index too long: ${idx.name}`);
      }
      for (const f of def.fields || []) {
        assert.notEqual(f.unique, true, `${name}.${f.name} must not set inline unique:true alongside uidx_*`);
      }
    }

    const sqlStatements = [];
    const rlsAttached = [];
    const mig = new MigrationCls({
      db: {
        attachLatticeRlsPolicy: async (tableName) => { rlsAttached.push(tableName); },
        sequelize: {
          getDialect: () => 'postgres',
          transaction: async (fn) => fn({ id: 'tx-mig' }),
          query: async (sql) => { sqlStatements.push(sql); return [[]]; },
        },
      },
    });
    assert.equal(mig.on, 'afterSync');
    await mig.up();
    const createTables = sqlStatements.filter((s) => /CREATE TABLE IF NOT EXISTS/i.test(s));
    assert.equal(createTables.length, 5);
    for (const stmt of createTables) {
      assert.equal(/\bUNIQUE\b/i.test(stmt), false, `CREATE TABLE must not contain inline UNIQUE: ${stmt}`);
    }
    assert.deepEqual(rlsAttached, [
      'latticeOrderLines',
      'latticeStockLots',
      'latticeEpodRecords',
      'latticeDecisionTables',
      'latticeDelegations',
    ]);

    sqlStatements.length = 0;
    await mig.down();
    const dropTables = sqlStatements.filter((s) => /DROP TABLE IF EXISTS/i.test(s));
    assert.equal(dropTables.length, 5);
  } finally {
    Module._load = origLoad;
  }
});

test('dxosWms enforces org isolation, FEFO dynamic allocation, issueStock hold rejection, and Arrhenius MKT quarantine', async () => {
  const { createDxosWmsActions } = require(path.join(PLUGIN_ROOT, 'src/server/wms-engine.js'));

  const harness = makeTestHarness({
    employees: [
      { id: 10, userId: 100, organizationId: 'org-a', active: true },
      { id: 20, userId: 200, organizationId: 'org-b', active: true },
      { id: 30, userId: 300, organizationId: 'org-a', active: true },
    ],
    orders: [
      { id: 501, code: 'ORD-A-01', name: 'Cold Vaccine Batch', organizationId: 'org-a', status: 'approved' },
      { id: 601, code: 'ORD-B-01', name: 'Org B Order', organizationId: 'org-b', status: 'approved' },
    ],
    telemetry: [
      { id: 1, organizationId: 'org-a', assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:77', metricName: 'temperature', numericValue: 22, observedAt: new Date('2026-11-23T01:00:00Z') },
      { id: 2, organizationId: 'org-a', assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:77', metricName: 'temperature', numericValue: 24, observedAt: new Date('2026-11-23T02:00:00Z') },
    ],
  });

  const wms = createDxosWmsActions(harness.db);
  const warehouseCtx = (actionParams) => ({
    method: 'POST',
    state: { currentUser: { id: 100, username: 'wh-a' }, currentRole: 'ldx_warehouse' },
    can: () => true,
    action: { params: { values: actionParams } },
  });
  const directorCtx = (actionParams) => ({
    method: 'POST',
    state: { currentUser: { id: 300, username: 'dir-a' }, currentRole: 'ldx_director' },
    can: ({ action }) => action === 'view',
    action: { params: { values: actionParams } },
  });

  // Read-only director denied on receiveStock
  await assert.rejects(
    () => wms.receiveStock(directorCtx({ lotCode: 'LOT-DENY', sku: 'VAC-01', productName: 'Vaccine', qtyOnHand: 10, expiryDate: '2027-01-01' }), async () => {}),
    (err) => err.status === 403,
  );

  // Non-root cannot spoof organizationId
  await assert.rejects(
    () => wms.receiveStock(warehouseCtx({ organizationId: 'org-b', lotCode: 'LOT-SPOOF', sku: 'VAC-01', productName: 'Vaccine', qtyOnHand: 10, expiryDate: '2027-01-01' }), async () => {}),
    (err) => err.status === 403 && err.code === 'NATIVE_ORGANIZATION_MISMATCH',
  );

  // Receive 4 lots for SKU VAC-01: expired, far-expiry, near-expiry, and hot-zone incompatible
  for (const spec of [
    { lotCode: 'LOT-EXPIRED', sku: 'VAC-01', productName: 'Vaccine X', qtyOnHand: 50, expiryDate: '2025-01-01', targetTempMinC: 2, targetTempMaxC: 8 },
    { lotCode: 'LOT-FAR', sku: 'VAC-01', productName: 'Vaccine X', qtyOnHand: 30, expiryDate: '2027-06-01', targetTempMinC: 2, targetTempMaxC: 8 },
    { lotCode: 'LOT-NEAR', sku: 'VAC-01', productName: 'Vaccine X', qtyOnHand: 12, expiryDate: '2026-12-10', targetTempMinC: 2, targetTempMaxC: 8, assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:77' },
    { lotCode: 'LOT-AMBIENT', sku: 'VAC-01', productName: 'Vaccine X', qtyOnHand: 40, expiryDate: '2026-12-01', targetTempMinC: 15, targetTempMaxC: 25 },
  ]) {
    const rCtx = warehouseCtx(spec);
    await wms.receiveStock(rCtx, async () => {});
    assert.equal(rCtx.body.lot.lotCode, spec.lotCode);
    assert.equal(rCtx.body.lot.organizationId, 'org-a');
  }
  assert.equal(harness.ledgerEntries.length, 4);

  // Org B receives lot with same SKU — must stay invisible to Org A
  await wms.receiveStock({
    method: 'POST',
    state: { currentUser: { id: 200, username: 'wh-b' }, currentRole: 'ldx_warehouse' },
    can: () => true,
    action: { params: { values: { lotCode: 'LOT-B1', sku: 'VAC-01', productName: 'Vaccine X', qtyOnHand: 99, expiryDate: '2026-11-25', targetTempMinC: 2, targetTempMaxC: 8 } } },
  }, async () => {});

  // FEFO allocates 20 units in [2, 8] C: skips LOT-EXPIRED, skips LOT-AMBIENT (15..25), takes 12 from LOT-NEAR then 8 from LOT-FAR
  const fefoCtx = warehouseCtx({
    sku: 'VAC-01',
    quantity: 20,
    orderId: 501,
    orderCode: 'ORD-A-01',
    lineNo: 1,
    minTempC: 2,
    maxTempC: 8,
    now: '2026-11-23T00:00:00Z',
  });
  await wms.allocateFefo(fefoCtx, async () => {});
  assert.equal(fefoCtx.body.allocatedTotal, 20);
  assert.equal(fefoCtx.body.shortfall, 0);
  assert.deepEqual(
    fefoCtx.body.allocations.map((a) => [a.lotCode, a.qtyAllocated]),
    [['LOT-NEAR', 12], ['LOT-FAR', 8]],
  );
  assert.equal(harness.orderLines.length, 1);
  assert.equal(harness.orderLines[0].status, 'allocated');
  assert.equal(harness.orderLines[0].allocatedQty, 20);
  assert.equal(harness.lineageEdges.length, 2);

  // Steady cold samples -> NOT held
  const okMktCtx = warehouseCtx({ lotCode: 'LOT-FAR', samplesC: [3.2, 4.1, 4.8], maxAllowedC: 8 });
  await wms.holdLotByMkt(okMktCtx, async () => {});
  assert.equal(okMktCtx.body.held, false);
  assert.equal(okMktCtx.body.lotStatus, 'available');
  assert.ok(okMktCtx.body.mktCelsius >= 3.2 && okMktCtx.body.mktCelsius <= 5.0);

  // Excursions from telemetry (22, 24 C) on LOT-NEAR -> MKT > 8 C -> hold_mkt + quarantine!
  const holdCtx = warehouseCtx({ lotCode: 'LOT-NEAR' });
  await wms.holdLotByMkt(holdCtx, async () => {});
  assert.equal(holdCtx.body.held, true);
  assert.equal(holdCtx.body.lotStatus, 'hold_mkt');
  assert.ok(holdCtx.body.mktCelsius > 20);
  assert.equal(harness.quarantineRows.length, 1);

  // issueStock rejects held lot & expired lot with 409 WMS_LOT_ON_HOLD
  await assert.rejects(
    () => wms.issueStock(warehouseCtx({ lotCode: 'LOT-NEAR', quantity: 5 }), async () => {}),
    (err) => err.status === 409 && err.code === 'WMS_LOT_ON_HOLD',
  );
  await assert.rejects(
    () => wms.issueStock(warehouseCtx({ lotCode: 'LOT-EXPIRED', quantity: 5 }), async () => {}),
    (err) => err.status === 409 && err.code === 'WMS_LOT_ON_HOLD',
  );

  // issueStock on available LOT-FAR decrements qtyOnHand & qtyReserved and transitions to depleted when 0
  const issueCtx = warehouseCtx({ lotCode: 'LOT-FAR', quantity: 30, orderCode: 'ORD-A-01', lineNo: 1 });
  await wms.issueStock(issueCtx, async () => {});
  assert.equal(issueCtx.body.lot.qtyOnHand, 0);
  assert.equal(issueCtx.body.lot.qtyReserved, 0);
  assert.equal(issueCtx.body.lot.status, 'depleted');
  assert.equal(harness.orderLines[0].status, 'dispatched');

  // Lots listing scoped strictly to org-a
  const listCtx = {
    method: 'GET',
    state: { currentUser: { id: 100 }, currentRole: 'ldx_warehouse' },
    can: () => true,
    action: { params: {} },
  };
  await wms.lots(listCtx, async () => {});
  assert.equal(listCtx.body.items.some((l) => l.lotCode === 'LOT-B1'), false);
});

test('dxosWms epodCapture, zero-PII fail-closed publicTrack, and XSS-escaped printVoucher work end-to-end', async () => {
  const { createDxosWmsActions } = require(path.join(PLUGIN_ROOT, 'src/server/wms-engine.js'));

  const harness = makeTestHarness({
    employees: [
      { id: 15, userId: 150, organizationId: 'org-a', active: true },
      { id: 25, userId: 250, organizationId: 'org-b', active: true },
    ],
    orders: [
      { id: 801, code: 'ORD-DEL-01', name: 'Order <script>alert(1)</script>', customer: 'BV <img src=x onerror=alert(2)>', organizationId: 'org-a', status: 'in_transit' },
    ],
  });
  harness.orderLines.push({
    id: 901,
    organizationId: 'org-a',
    orderId: 801,
    orderCode: 'ORD-DEL-01',
    lineNo: 1,
    sku: 'SKU-<script>',
    productName: 'Thuốc <b>Lạnh</b>',
    lotCode: 'LOT-A1',
    requestedQty: 10,
    allocatedQty: 10,
    unit: 'BOX',
    status: 'dispatched',
  });

  const wms = createDxosWmsActions(harness.db);

  // Invalid GPS rejected 400
  await assert.rejects(
    () => wms.epodCapture({
      method: 'POST',
      state: { currentUser: { id: 150, username: 'drv-a' }, currentRole: 'ldx_driver' },
      can: () => true,
      action: { params: { values: { orderId: 801, recipientName: 'Nguyen Van A', deliveredQty: 10, gpsLat: 95, gpsLng: 105.7, signatureDataUrl: 'data:image/png;base64,AAA=' } } },
    }, async () => {}),
    (err) => err.status === 400,
  );

  // Valid ePOD capture
  const capCtx = {
    method: 'POST',
    state: { currentUser: { id: 150, username: 'drv-a' }, currentRole: 'ldx_driver' },
    can: () => true,
    action: {
      params: {
        values: {
          orderId: 801,
          recipientName: 'Nguyen Thi Giao Nhan',
          recipientPhone: '0901234567',
          deliveredQty: 10,
          gpsLat: 10.0452,
          gpsLng: 105.7469,
          gpsAccuracyM: 8.5,
          signatureDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
          tempSummary: { mktCelsius: 4.32, inRange: true },
          notes: 'Giao đủ thùng lạnh',
        },
      },
    },
  };
  await wms.epodCapture(capCtx, async () => {});
  const { epod, trackingCode, trackingToken } = capCtx.body;
  assert.match(trackingCode, /^LDX-TRK-/);
  assert.match(trackingToken, /^ldx_trk_/);
  assert.equal(epod.recipientPhoneMasked, '***567');
  assert.equal(epod.trackingTokenHash, undefined);
  assert.equal(harness.epodRecords[0].trackingTokenHash, createHash('sha256').update(trackingToken).digest('hex'));
  assert.equal(JSON.stringify(harness.epodRecords[0]).includes('0901234567'), false);
  assert.equal(harness.orders[0].status, 'completed');
  assert.equal(harness.orderLines[0].status, 'delivered');
  assert.ok(epod.ledgerSeq >= 1);
  assert.ok(epod.ledgerSignatureBase64);
  assert.ok(epod.keyId);

  // Public track: missing / unknown code / wrong token all yield identical 401 TRACKING_UNAUTHORIZED
  const errors = [];
  for (const badParams of [
    {},
    { trackingCode },
    { trackingCode: 'LDX-TRK-DOESNOTEXIST', token: trackingToken },
    { trackingCode, token: 'ldx_trk_wrongtoken' },
  ]) {
    try {
      await wms.publicTrack({ method: 'GET', state: {}, action: { params: badParams } }, async () => {});
      assert.fail('Expected 401 TRACKING_UNAUTHORIZED');
    } catch (err) {
      errors.push({ status: err.status, code: err.code, message: err.message });
    }
  }
  assert.ok(errors.every((e) => e.status === 401 && e.code === 'TRACKING_UNAUTHORIZED'));
  assert.equal(errors[2].message, errors[3].message);

  // Valid publicTrack returns zero PII
  const trackCtx = {
    method: 'GET',
    state: {},
    action: { params: { trackingCode, token: trackingToken } },
  };
  await wms.publicTrack(trackCtx, async () => {});
  assert.equal(trackCtx.body.trackingCode, trackingCode);
  assert.equal(trackCtx.body.status, 'delivered');
  assert.equal(trackCtx.body.orderCode, 'ORD-DEL-01');
  assert.deepEqual(trackCtx.body.tempSummary, { mktCelsius: 4.32, inRange: true });
  assert.equal(trackCtx.body.ledgerVerification.verifiedFormat, true);
  const trackJson = JSON.stringify(trackCtx.body);
  for (const pii of ['Nguyen Thi Giao Nhan', '567', '10.0452', '105.7469', 'data:image/png', 'drv-a', '150', 'org-a', 'Giao đủ']) {
    assert.equal(trackJson.includes(pii), false, `publicTrack leaked PII: ${pii}`);
  }

  // printVoucher enforces org isolation & strict HTML escaping without raw token
  await assert.rejects(
    () => wms.printVoucher({
      method: 'GET',
      state: { currentUser: { id: 250 }, currentRole: 'ldx_warehouse' },
      can: () => true,
      action: { params: { documentType: 'order', orderId: 801 } },
    }, async () => {}),
    (err) => err.status === 404,
  );

  const printCtx = {
    method: 'GET',
    state: { currentUser: { id: 150 }, currentRole: 'ldx_driver' },
    can: () => true,
    action: { params: { documentType: 'delivery_note', orderCode: 'ORD-DEL-01' } },
  };
  await wms.printVoucher(printCtx, async () => {});
  assert.equal(printCtx.body.htmlSha256, createHash('sha256').update(printCtx.body.html).digest('hex'));
  assert.equal(printCtx.body.html.includes('<script>alert(1)</script>'), false);
  assert.equal(printCtx.body.html.includes('<img src=x onerror=alert(2)>'), false);
  assert.equal(printCtx.body.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), true);
  assert.equal(printCtx.body.html.includes(trackingToken), false);

  // Also test orderLines GET, saveOrderLine, and printVoucher documentType='epod'
  await wms.saveOrderLine({
    method: 'POST',
    state: { currentUser: { id: 150 }, currentRole: 'ldx_driver' },
    can: () => true,
    action: { params: { values: { orderId: 801, lineNo: 2, sku: 'SKU-2', productName: 'Bơm tiêm', requestedQty: 5 } } },
  }, async () => {});
  const olGetCtx = {
    method: 'GET',
    state: { currentUser: { id: 150 }, currentRole: 'ldx_driver' },
    can: () => true,
    action: { params: { orderCode: 'ORD-DEL-01' } },
  };
  await wms.orderLines(olGetCtx, async () => {});
  assert.equal(olGetCtx.body.items.length, 2);

  const epodPrintCtx = {
    method: 'GET',
    state: { currentUser: { id: 150 }, currentRole: 'ldx_driver' },
    can: () => true,
    action: { params: { documentType: 'epod', epodUid: epod.epodUid } },
  };
  await wms.printVoucher(epodPrintCtx, async () => {});
  assert.ok(epodPrintCtx.body.html.includes(epod.epodUid));
  assert.ok(epodPrintCtx.body.html.includes(epod.trackingCode));
});

test('dxosDmn evaluates FIRST and COLLECT policies declaratively without eval/Function and enforces tenant isolation', async () => {
  const { createDxosDmnActions, evaluateDecisionTable } = require(path.join(PLUGIN_ROOT, 'src/server/dmn-engine.js'));
  const harness = makeTestHarness({
    employees: [
      { id: 10, userId: 100, organizationId: 'org-a', active: true },
      { id: 20, userId: 200, organizationId: 'org-b', active: true },
    ],
    roles: [
      { name: 'ldx_admin', allowConfigure: true, snippets: ['pm'] },
      { name: 'ldx_employee', allowConfigure: false, snippets: [] },
    ],
  });
  const dmn = createDxosDmnActions(harness.db);

  // Employee cannot save DMN table
  await assert.rejects(
    () => dmn.saveTable({
      method: 'POST',
      state: { currentUser: { id: 100 }, currentRole: 'ldx_employee' },
      action: { params: { values: { tableKey: 't1', name: 'T1', inputsJson: [{ name: 'tempC' }], outputsJson: [{ name: 'action' }], rulesJson: [] } } },
    }, async () => {}),
    (err) => err.status === 403,
  );

  // Unsupported operator rejected 400
  await assert.rejects(
    () => dmn.saveTable({
      method: 'POST',
      state: { currentUser: { id: 100, username: 'adm-a' }, currentRole: 'ldx_admin' },
      action: {
        params: {
          values: {
            tableKey: 'cold_route',
            name: 'Cold Chain Routing',
            hitPolicy: 'FIRST',
            inputsJson: [{ name: 'tempC' }],
            outputsJson: [{ name: 'route' }],
            rulesJson: [{ when: { tempC: { op: 'eval_js', value: 'process.exit(1)' } }, then: { route: 'pwn' } }],
          },
        },
      },
    }, async () => {}),
    (err) => err.status === 400,
  );

  // Save FIRST table covering all required operators
  await dmn.saveTable({
    method: 'POST',
    state: { currentUser: { id: 100, username: 'adm-a' }, currentRole: 'ldx_admin' },
    action: {
      params: {
        values: {
          tableKey: 'cold_triage',
          name: 'Cold Triage Rules',
          hitPolicy: 'FIRST',
          inputsJson: [{ name: 'tempC' }, { name: 'zone' }, { name: 'sku' }, { name: 'notes' }],
          outputsJson: [{ name: 'severity' }, { name: 'action' }],
          rulesJson: [
            {
              when: {
                tempC: { op: 'gt', value: 12 },
                zone: { op: 'in', value: ['cold_a', 'cold_b'] },
                sku: { op: 'neq', value: 'TEST' },
                notes: { op: 'contains', value: 'alarm' },
              },
              then: { severity: 'critical', action: 'quarantine_immediate' },
            },
            {
              when: {
                tempC: { op: 'between', value: [2, 8] },
                zone: { op: 'not_in', value: ['quarantine'] },
              },
              then: { severity: 'normal', action: 'release' },
            },
            {
              when: { tempC: { op: 'any' } },
              then: { severity: 'warning', action: 'inspect' },
            },
          ],
        },
      },
    },
  }, async () => {});

  const evalFirst1 = {
    method: 'POST',
    state: { currentUser: { id: 100 }, currentRole: 'ldx_employee' },
    action: { params: { values: { tableKey: 'cold_triage', context: { tempC: 15, zone: 'cold_a', sku: 'VAC-1', notes: 'High ALARM spike' } } } },
  };
  await dmn.evaluate(evalFirst1, async () => {});
  assert.equal(evalFirst1.body.matched, true);
  assert.equal(evalFirst1.body.matchedRuleIndex, 0);
  assert.deepEqual(evalFirst1.body.result, { severity: 'critical', action: 'quarantine_immediate' });

  const evalFirst2 = {
    method: 'POST',
    state: { currentUser: { id: 100 }, currentRole: 'ldx_employee' },
    action: { params: { values: { tableKey: 'cold_triage', context: { tempC: 5, zone: 'cold_a' } } } },
  };
  await dmn.evaluate(evalFirst2, async () => {});
  assert.equal(evalFirst2.body.matchedRuleIndex, 1);
  assert.equal(evalFirst2.body.result.action, 'release');

  // Org B cannot evaluate Org A table
  await assert.rejects(
    () => dmn.evaluate({
      method: 'POST',
      state: { currentUser: { id: 200 }, currentRole: 'ldx_employee' },
      action: { params: { values: { tableKey: 'cold_triage', context: { tempC: 5 } } } },
    }, async () => {}),
    (err) => err.status === 404,
  );

  // COLLECT hitPolicy returns all matching rule outputs in order
  const collectOut = evaluateDecisionTable(
    {
      hitPolicy: 'COLLECT',
      rulesJson: [
        { when: { qty: { op: 'gte', value: 10 } }, then: { tag: 'bulk' } },
        { when: { qty: { op: 'lt', value: 50 } }, then: { tag: 'standard_van' } },
        { when: { qty: { op: 'lte', value: 5 } }, then: { tag: 'small_parcel' } },
        { when: { qty: { op: 'eq', value: 25 } }, then: { tag: 'exact_25' } },
      ],
    },
    { qty: 25 },
  );
  assert.equal(collectOut.matched, true);
  assert.deepEqual(collectOut.results, [{ tag: 'bulk' }, { tag: 'standard_van' }, { tag: 'exact_25' }]);
});

test('dxosDelegations enforces anti-escalation, same-org bounds, 90-day cap, revocation, and ledger entries', async () => {
  const { createDxosDelegationsActions, FORBIDDEN_DELEGATION_ROLES } = require(path.join(PLUGIN_ROOT, 'src/server/delegation-engine.js'));
  assert.deepEqual([...FORBIDDEN_DELEGATION_ROLES].sort(), ['admin', 'ldx_admin', 'root']);

  const harness = makeTestHarness({
    employees: [
      { id: 10, userId: 100, organizationId: 'org-a', active: true },
      { id: 11, userId: 101, organizationId: 'org-a', active: true },
      { id: 20, userId: 200, organizationId: 'org-b', active: true },
      { id: 12, userId: 102, organizationId: 'org-a', active: false },
    ],
    roles: [
      { name: 'ldx_manager', allowConfigure: false, snippets: [] },
      { name: 'ldx_dispatcher', allowConfigure: false, snippets: [] },
      { name: 'ldx_admin', allowConfigure: true, snippets: ['pm'] },
      { name: 'ldx_sysadmin', allowConfigure: true, snippets: ['pm'] },
    ],
    rolesUsers: [
      { userId: 100, roleName: 'ldx_manager' },
      { userId: 100, roleName: 'ldx_admin' },
      { userId: 101, roleName: 'ldx_employee' },
    ],
  });
  const dlg = createDxosDelegationsActions(harness.db);

  const now = new Date('2026-11-23T00:00:00Z');
  const plus5d = new Date('2026-11-28T00:00:00Z');
  const plus100d = new Date('2027-03-10T00:00:00Z');

  // Non-root cannot delegate forbidden/elevated roles (even if user holds ldx_admin!)
  for (const forbiddenRole of ['root', 'admin', 'ldx_admin', 'ldx_sysadmin']) {
    await assert.rejects(
      () => dlg.create({
        method: 'POST',
        state: { currentUser: { id: 100 }, currentRole: 'ldx_admin' },
        action: { params: { values: { delegateUserId: 101, roleName: forbiddenRole, startsAt: now, endsAt: plus5d } } },
      }, async () => {}),
      (err) => err.status === 403 && err.code === 'DELEGATION_ESCALATION_FORBIDDEN',
    );
  }

  // Non-root cannot delegate a role they do NOT hold in verified rolesUsers
  await assert.rejects(
    () => dlg.create({
      method: 'POST',
      state: { currentUser: { id: 100 }, currentRole: 'ldx_dispatcher' },
      action: { params: { values: { delegateUserId: 101, roleName: 'ldx_dispatcher', startsAt: now, endsAt: plus5d } } },
    }, async () => {}),
    (err) => err.status === 403 && err.code === 'DELEGATION_ROLE_NOT_HELD',
  );

  // Self-delegation, >90d, cross-org, inactive delegate all rejected
  await assert.rejects(
    () => dlg.create({
      method: 'POST',
      state: { currentUser: { id: 100 }, currentRole: 'ldx_manager' },
      action: { params: { values: { delegateUserId: 100, roleName: 'ldx_manager', startsAt: now, endsAt: plus5d } } },
    }, async () => {}),
    (err) => err.status === 400,
  );
  await assert.rejects(
    () => dlg.create({
      method: 'POST',
      state: { currentUser: { id: 100 }, currentRole: 'ldx_manager' },
      action: { params: { values: { delegateUserId: 101, roleName: 'ldx_manager', startsAt: now, endsAt: plus100d } } },
    }, async () => {}),
    (err) => err.status === 400,
  );
  await assert.rejects(
    () => dlg.create({
      method: 'POST',
      state: { currentUser: { id: 100 }, currentRole: 'ldx_manager' },
      action: { params: { values: { delegateUserId: 200, roleName: 'ldx_manager', startsAt: now, endsAt: plus5d } } },
    }, async () => {}),
    (err) => err.status === 403,
  );
  await assert.rejects(
    () => dlg.create({
      method: 'POST',
      state: { currentUser: { id: 100 }, currentRole: 'ldx_manager' },
      action: { params: { values: { delegateUserId: 102, roleName: 'ldx_manager', startsAt: now, endsAt: plus5d } } },
    }, async () => {}),
    (err) => err.status === 403,
  );

  // Valid same-org delegation succeeds
  const createCtx = {
    method: 'POST',
    state: { currentUser: { id: 100, username: 'mgr-a' }, currentRole: 'ldx_manager' },
    action: { params: { values: { delegateUserId: 101, roleName: 'ldx_manager', reason: 'Annual leave backup', startsAt: now, endsAt: plus5d } } },
  };
  await dlg.create(createCtx, async () => {});
  const createdDlg = createCtx.body.delegation;
  assert.equal(createdDlg.organizationId, 'org-a');
  assert.equal(createdDlg.status, 'active');
  assert.equal(harness.ledgerEntries.at(-1).eventType, 'auth.delegation_created');

  // activeForUser returns delegation inside window and excludes outside window
  const activeCtx = {
    method: 'GET',
    state: { currentUser: { id: 101 }, currentRole: 'ldx_employee' },
    action: { params: { now: '2026-11-25T12:00:00Z' } },
  };
  await dlg.activeForUser(activeCtx, async () => {});
  assert.deepEqual(activeCtx.body.roles, ['ldx_manager']);

  const expiredCtx = {
    method: 'GET',
    state: { currentUser: { id: 101 }, currentRole: 'ldx_employee' },
    action: { params: { now: '2026-12-01T00:00:00Z' } },
  };
  await dlg.activeForUser(expiredCtx, async () => {});
  assert.deepEqual(expiredCtx.body.roles, []);

  // Revoke removes from activeForUser & writes auth.delegation_revoked
  const revokeCtx = {
    method: 'POST',
    state: { currentUser: { id: 100, username: 'mgr-a' }, currentRole: 'ldx_manager' },
    action: { params: { values: { id: createdDlg.id } } },
  };
  await dlg.revoke(revokeCtx, async () => {});
  assert.equal(revokeCtx.body.delegation.status, 'revoked');
  assert.equal(harness.ledgerEntries.at(-1).eventType, 'auth.delegation_revoked');

  await dlg.activeForUser(activeCtx, async () => {});
  assert.deepEqual(activeCtx.body.roles, []);
});

test('Plugin registration mounts dxosWms, dxosDmn, dxosDelegations, publicTrack ACL, and direct guard before latticeNativeScope', async () => {
  const studioIndexPath = require.resolve(path.join(PLUGIN_ROOT, 'src/server/index.js'));
  const foundationIndexPath = require.resolve(path.resolve(PLUGIN_ROOT, '../plugin-lattice-foundation/src/server/index.js'));
  const origLoad = Module._load;

  class MockPlugin {
    constructor(app, options = {}) { this.app = app; this.db = app?.db; this.options = options; }
  }
  class MockMigration { constructor(ctx) { this.context = ctx; } }

  delete require.cache[studioIndexPath];
  delete require.cache[foundationIndexPath];
  Module._load = function mockedNocobase(request, parent, isMain) {
    if (request === '@nocobase/server') return { Plugin: MockPlugin, Migration: MockMigration };
    if (request === '@nocobase/database') return { defineCollection: (def) => def };
    return origLoad.call(this, request, parent, isMain);
  };

  try {
    const LatticeFoundationPlugin = require(foundationIndexPath);
    const DxosStudioPlugin = require(studioIndexPath);

    const harness = makeTestHarness({
      employees: [{ id: 10, userId: 100, organizationId: 'org-a', active: true }],
    });
    const registeredMiddlewares = [];
    const definedResources = [];
    const aclGrants = [];
    const dbEvents = [];

    harness.db.on = (evt, fn) => { dbEvents.push({ evt, fn }); };
    const app = {
      db: harness.db,
      use() {},
      resourceManager: {
        use(fn, opts) { registeredMiddlewares.push({ fn, opts }); },
        define(def) { definedResources.push(def); },
      },
      acl: {
        allow(res, actions, role) { aclGrants.push({ res, actions, role }); },
        registerSnippet() {},
      },
      cronJobManager: { addJob() {} },
      logger: { info() {}, warn() {}, error() {} },
    };

    await new LatticeFoundationPlugin(app).load();
    await new DxosStudioPlugin(app).load();

    for (const name of ['dxosStudio', 'dxosWms', 'dxosDmn', 'dxosDelegations']) {
      assert.ok(definedResources.some((r) => r.name === name), `Missing resource ${name}`);
    }
    const pubTrackAcl = aclGrants.find((g) => g.res === 'dxosWms' && g.role === 'public');
    assert.ok(pubTrackAcl);
    assert.deepEqual(pubTrackAcl.actions, ['publicTrack']);

    const wmsGuard = registeredMiddlewares.find((m) => m.opts?.tag === 'dxosWmsDmnScope');
    const nativeEntry = registeredMiddlewares.find((m) => m.opts?.tag === 'latticeNativeScope');
    assert.ok(wmsGuard);
    assert.equal(wmsGuard.opts.after, 'acl');
    assert.equal(wmsGuard.opts.before, 'latticeNativeScope');

    // Direct writes on protected collections blocked 403
    for (const col of ['latticeEpodRecords', 'latticeDecisionTables', 'latticeDelegations']) {
      await assert.rejects(
        () => wmsGuard.fn({
          state: { currentUser: { id: 100 }, currentRole: 'ldx_manager' },
          action: { resourceName: col, actionName: 'create', params: { values: {} } },
        }, async () => {}),
        (err) => err.status === 403,
      );
    }

    // Direct list on latticeEpodRecords scopes organizationId and strips trackingTokenHash
    const listCtx = {
      state: { currentUser: { id: 100 }, currentRole: 'ldx_manager' },
      action: { resourceName: 'latticeEpodRecords', actionName: 'list', params: {} },
      body: null,
    };
    await wmsGuard.fn(listCtx, async () => {
      listCtx.body = { rows: [{ id: 1, organizationId: 'org-a', trackingCode: 'LDX-TRK-1', trackingTokenHash: 'secret-hash' }] };
    });
    assert.deepEqual(listCtx.action.params.filter, { $and: [{ organizationId: 'org-a' }, {}] });
    assert.equal(listCtx.body.rows[0].trackingTokenHash, undefined);

    // charts:queryData passes downstream latticeNativeScope cleanly
    const chartCtx = {
      state: { currentUser: { id: 100 }, currentRole: 'ldx_warehouse' },
      action: { resourceName: 'charts', actionName: 'queryData', params: { values: { mode: 'builder', collection: 'latticeStockLots', filter: { status: 'available' } } } },
    };
    await wmsGuard.fn(chartCtx, () => nativeEntry.fn(chartCtx, async () => {}));
    assert.deepEqual(chartCtx.action.params.values.filter, {
      $and: [{ organizationId: 'org-a' }, { status: 'available' }],
    });
    assert.ok(dbEvents.some((e) => e.evt === 'latticeStockLots.beforeValidate'));

    // DX_PG_RLS_SESSION=true wraps direct queries and charts in PG RLS transaction
    const prevRls = process.env.DX_PG_RLS_SESSION;
    const fakeTx = { id: 'tx-wms-rls' };
    const sqlCalls = [];
    harness.db.sequelize = {
      getDialect: () => 'postgres',
      transaction: async (cb) => cb(fakeTx),
      query: async (sql, opts) => { sqlCalls.push({ sql, opts }); return [[]]; },
    };
    try {
      process.env.DX_PG_RLS_SESSION = 'true';
      let seenTx = null;
      const rlsCtx = {
        state: { currentUser: { id: 100 }, currentRole: 'ldx_warehouse' },
        action: { resourceName: 'latticeStockLots', actionName: 'list', params: {} },
      };
      await wmsGuard.fn(rlsCtx, async () => { seenTx = rlsCtx.state.latticeRlsTransaction; });
      assert.equal(seenTx, fakeTx);
      assert.equal(sqlCalls.length, 1);
      assert.equal(sqlCalls[0].sql, "SELECT set_config('app.current_org', :orgId, true)");
      assert.deepEqual(sqlCalls[0].opts.replacements, { orgId: 'org-a' });
    } finally {
      if (prevRls === undefined) delete process.env.DX_PG_RLS_SESSION;
      else process.env.DX_PG_RLS_SESSION = prevRls;
    }
  } finally {
    Module._load = origLoad;
    delete require.cache[studioIndexPath];
    delete require.cache[foundationIndexPath];
  }
});

test('Ledger security invariants propagate and optional foundation loader handles MODULE_NOT_FOUND vs SyntaxError safely', async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevFieldKey = process.env.ENCRYPTION_FIELD_KEY;
  const prevAppKey = process.env.APP_KEY;
  const wmsPath = require.resolve(path.join(PLUGIN_ROOT, 'src/server/wms-engine.js'));

  try {
    // 1. PKI_MASTER_KEY_MISSING in production must NOT be swallowed by receiveStock / epodCapture
    process.env.NODE_ENV = 'production';
    delete process.env.ENCRYPTION_FIELD_KEY;
    delete process.env.APP_KEY;
    const { createDxosWmsActions } = require(wmsPath);
    const harness = makeTestHarness({
      employees: [{ id: 10, userId: 100, organizationId: 'org-a', active: true }],
    });
    const wms = createDxosWmsActions(harness.db);
    await assert.rejects(
      () => wms.receiveStock({
        method: 'POST',
        state: { currentUser: { id: 100 }, currentRole: 'ldx_warehouse' },
        can: () => true,
        action: { params: { values: { lotCode: 'LOT-SEC', sku: 'SKU-1', productName: 'P1', qtyOnHand: 5, expiryDate: '2027-01-01' } } },
      }, async () => {}),
      (err) => err.code === 'PKI_MASTER_KEY_MISSING',
    );
  } finally {
    if (prevEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevEnv;
    if (prevFieldKey === undefined) delete process.env.ENCRYPTION_FIELD_KEY; else process.env.ENCRYPTION_FIELD_KEY = prevFieldKey;
    if (prevAppKey === undefined) delete process.env.APP_KEY; else process.env.APP_KEY = prevAppKey;
  }

  // 2. Non-MODULE_NOT_FOUND error when loading foundation helper must throw (never masked)
  const origLoad = Module._load;
  delete require.cache[wmsPath];
  Module._load = function failSyntax(request, parent, isMain) {
    if (typeof request === 'string' && request.includes('pki-ledger')) {
      throw new SyntaxError('Broken pki-ledger');
    }
    return origLoad.call(this, request, parent, isMain);
  };
  try {
    assert.throws(() => require(wmsPath), SyntaxError);
  } finally {
    Module._load = origLoad;
    delete require.cache[wmsPath];
  }

  // 3. MODULE_NOT_FOUND gracefully falls back to standalone mode
  delete require.cache[wmsPath];
  Module._load = function missingFoundation(request, parent, isMain) {
    if (typeof request === 'string' && request.includes('plugin-lattice-foundation')) {
      throw Object.assign(new Error(`Cannot find module '${request}'`), { code: 'MODULE_NOT_FOUND' });
    }
    return origLoad.call(this, request, parent, isMain);
  };
  try {
    const standalone = require(wmsPath);
    const mkt = standalone.computeMeanKineticTemperature([25, 25]);
    assert.equal(mkt.mktCelsius, 25);
  } finally {
    Module._load = origLoad;
    delete require.cache[wmsPath];
  }
});
