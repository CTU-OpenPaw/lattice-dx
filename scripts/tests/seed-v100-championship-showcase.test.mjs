/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertLoopbackOrigin,
  createSeederClient,
  parseSeedArgs,
  runV100ChampionshipShowcaseSeed,
} from '../seed-v100-championship-showcase.mjs';

const ALLOWED_DESIRED_KEYS = new Set([
  'targetTempC',
  'maxTempC',
  'minTempC',
  'defrostMode',
  'fanMode',
  'doorLock',
  'reportingIntervalSec',
]);
const ALLOWED_DEFROST_MODES = new Set(['auto', 'manual', 'off']);
const ALLOWED_FAN_MODES = new Set(['auto', 'high', 'low', 'eco']);
const ALLOWED_DOOR_LOCKS = new Set(['locked', 'unlocked']);

function validateTwinPatch(desiredPatch) {
  if (!desiredPatch || typeof desiredPatch !== 'object' || Array.isArray(desiredPatch) || Object.keys(desiredPatch).length === 0) {
    return { code: 'TWIN_DESIRED_INVALID', message: 'desiredPatch must be a non-empty object' };
  }
  for (const [key, rawVal] of Object.entries(desiredPatch)) {
    if (!ALLOWED_DESIRED_KEYS.has(key)) {
      return { code: 'TWIN_FIELD_FORBIDDEN', message: `Forbidden twin key: ${key}` };
    }
    if (key === 'doorLock' && (typeof rawVal !== 'string' || !ALLOWED_DOOR_LOCKS.has(rawVal))) {
      return { code: 'TWIN_DESIRED_INVALID', message: `Invalid doorLock: ${rawVal}` };
    }
    if (key === 'fanMode' && (typeof rawVal !== 'string' || !ALLOWED_FAN_MODES.has(rawVal))) {
      return { code: 'TWIN_DESIRED_INVALID', message: `Invalid fanMode: ${rawVal}` };
    }
    if (key === 'defrostMode' && (typeof rawVal !== 'string' || !ALLOWED_DEFROST_MODES.has(rawVal))) {
      return { code: 'TWIN_DESIRED_INVALID', message: `Invalid defrostMode: ${rawVal}` };
    }
    if ((key === 'targetTempC' || key === 'maxTempC' || key === 'minTempC') && (typeof rawVal !== 'number' || !Number.isFinite(rawVal))) {
      return { code: 'TWIN_DESIRED_INVALID', message: `Invalid temperature ${key}` };
    }
  }
  return null;
}

function createMockShowcaseServer({
  initialLedgerEntries = [],
  initialSnapshots = [],
  delegationCreateError = null,
} = {}) {
  const state = {
    nextId: 100,
    locations: [],
    assets: [],
    telemetry: new Map(),
    shadows: new Map(),
    orders: [],
    orderLines: [],
    lots: [],
    dmnTables: [],
    delegations: [],
    ledgerEntries: [...initialLedgerEntries],
    snapshots: [...initialSnapshots],
    calls: [],
  };

  const mockFetch = async (url, init = {}) => {
    const parsedUrl = new URL(String(url));
    const path = `${parsedUrl.pathname}${parsedUrl.search}`;
    const body = init.body ? JSON.parse(init.body) : {};
    state.calls.push(path);

    const jsonResp = (data) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data }),
    });
    const errorResp = (status, code, message) => ({
      ok: false,
      status,
      text: async () => JSON.stringify({ errors: [{ code, message }] }),
    });

    if (parsedUrl.pathname === '/api/latticeDepartments:list') {
      return jsonResp([{ id: 10, code: 'OPS', organizationId: 'native-ui-lab' }]);
    }
    if (parsedUrl.pathname === '/api/latticeEmployees:list') {
      return jsonResp([
        { id: 1, userId: 2, code: 'MGR-01', active: true, organizationId: 'native-ui-lab' },
        { id: 2, userId: 3, code: 'EMP-01', active: true, organizationId: 'native-ui-lab' },
      ]);
    }
    if (parsedUrl.pathname === '/api/latticeLocations:list') {
      const f = JSON.parse(parsedUrl.searchParams.get('filter') || '{}');
      return jsonResp(state.locations.filter((r) => r.code === f.code));
    }
    if (parsedUrl.pathname === '/api/latticeLocations:create') {
      const row = { id: ++state.nextId, ...body };
      state.locations.push(row);
      return jsonResp(row);
    }
    if (parsedUrl.pathname === '/api/latticeAssets:list') {
      const f = JSON.parse(parsedUrl.searchParams.get('filter') || '{}');
      return jsonResp(state.assets.filter((r) => r.code === f.code));
    }
    if (parsedUrl.pathname === '/api/latticeAssets:create') {
      const row = { id: ++state.nextId, ...body };
      state.assets.push(row);
      return jsonResp(row);
    }
    if (parsedUrl.pathname === '/api/dxosBlocks:telemetrySeries') {
      const entity = parsedUrl.searchParams.get('assetEntityId');
      return jsonResp({ points: state.telemetry.get(entity) || [] });
    }
    if (parsedUrl.pathname === '/api/dxosBlocks:telemetryIngest') {
      const arr = state.telemetry.get(body.assetEntityId) || [];
      arr.push({ timestamp: body.observedAt, value: body.numericValue });
      state.telemetry.set(body.assetEntityId, arr);
      return jsonResp({ ingested: true });
    }
    if (parsedUrl.pathname === '/api/dxosBlocks:twinShadow') {
      const assetId = parsedUrl.searchParams.get('assetId');
      return jsonResp({ shadow: state.shadows.get(String(assetId)) || null });
    }
    if (parsedUrl.pathname === '/api/dxosBlocks:twinSetDesired') {
      const err = validateTwinPatch(body.desiredPatch);
      if (err) return errorResp(400, err.code, err.message);
      const shadow = { id: ++state.nextId, assetId: body.assetId, desiredJson: body.desiredPatch };
      state.shadows.set(String(body.assetId), shadow);
      return jsonResp({ gatedByHitl: false, shadow });
    }
    if (parsedUrl.pathname === '/api/latticeOrders:list') {
      const f = JSON.parse(parsedUrl.searchParams.get('filter') || '{}');
      return jsonResp(state.orders.filter((o) => o.code === f.code));
    }
    if (parsedUrl.pathname === '/api/latticeOrders:create') {
      const row = { id: ++state.nextId, ...body };
      state.orders.push(row);
      return jsonResp(row);
    }
    if (parsedUrl.pathname === '/api/dxosWms:orderLines') {
      return jsonResp({ items: state.orderLines });
    }
    if (parsedUrl.pathname === '/api/dxosWms:saveOrderLine') {
      const row = { id: ++state.nextId, allocatedQty: 0, ...body };
      state.orderLines.push(row);
      return jsonResp({ orderLine: row });
    }
    if (parsedUrl.pathname === '/api/dxosWms:lots') {
      return jsonResp({ items: state.lots });
    }
    if (parsedUrl.pathname === '/api/dxosWms:receiveStock') {
      const row = { id: ++state.nextId, status: 'available', ...body };
      state.lots.push(row);
      return jsonResp({ lot: row });
    }
    if (parsedUrl.pathname === '/api/dxosWms:holdLotByMkt') {
      const lot = state.lots.find((l) => l.lotCode === body.lotCode);
      if (lot) lot.status = 'hold_mkt';
      return jsonResp({ held: true, lotStatus: 'hold_mkt', mktCelsius: 10.3 });
    }
    if (parsedUrl.pathname === '/api/dxosWms:allocateFefo') {
      const line = state.orderLines.find((l) => l.lineNo === body.lineNo);
      if (line) line.allocatedQty = Number(line.allocatedQty || 0) + Number(body.quantity || 0);
      return jsonResp({ allocatedTotal: body.quantity, shortfall: 0 });
    }
    if (parsedUrl.pathname === '/api/dxosDmn:listTables') {
      return jsonResp({ items: state.dmnTables });
    }
    if (parsedUrl.pathname === '/api/dxosDmn:saveTable') {
      const table = { id: ++state.nextId, ...body };
      state.dmnTables.push(table);
      return jsonResp({ table });
    }
    if (parsedUrl.pathname === '/api/dxosDelegations:list') {
      return jsonResp({ items: state.delegations });
    }
    if (parsedUrl.pathname === '/api/dxosDelegations:create') {
      if (delegationCreateError) {
        return errorResp(delegationCreateError.status, delegationCreateError.code, delegationCreateError.message);
      }
      const row = { id: ++state.nextId, delegationUid: 'DLG-V100', status: 'active', ...body };
      state.delegations.push(row);
      return jsonResp({ delegationUid: 'DLG-V100', delegation: row });
    }
    if (parsedUrl.pathname === '/api/dxosLedger:publicKey') {
      return jsonResp({ keyId: 'key-v100', algorithm: 'Ed25519', active: true });
    }
    if (parsedUrl.pathname === '/api/dxosLedger:entries') {
      const tCol = parsedUrl.searchParams.get('targetCollection');
      const tRec = parsedUrl.searchParams.get('targetRecordId');
      const page = Math.max(1, Number(parsedUrl.searchParams.get('page') || 1));
      const pageSize = Math.max(1, Number(parsedUrl.searchParams.get('pageSize') || parsedUrl.searchParams.get('limit') || 20));
      const filtered = state.ledgerEntries.filter(
        (e) => (!tCol || e.targetCollection === tCol) && (!tRec || String(e.targetRecordId) === String(tRec)),
      );
      const start = (page - 1) * pageSize;
      return jsonResp({ total: filtered.length, page, pageSize, items: filtered.slice(start, start + pageSize) });
    }
    if (parsedUrl.pathname === '/api/dxosLedger:signDocument') {
      state.ledgerEntries.push({
        seq: state.ledgerEntries.length + 1,
        targetCollection: body.targetCollection,
        targetRecordId: String(body.targetRecordId),
      });
      return jsonResp({ signed: true });
    }
    if (parsedUrl.pathname === '/api/dxosDataGov:listSnapshots') {
      const srcCol = parsedUrl.searchParams.get('sourceCollection');
      const page = Math.max(1, Number(parsedUrl.searchParams.get('page') || 1));
      const pageSize = Math.max(1, Math.min(100, Number(parsedUrl.searchParams.get('pageSize') || parsedUrl.searchParams.get('limit') || 20)));
      const filtered = state.snapshots.filter((s) => !srcCol || s.sourceCollection === srcCol);
      const start = (page - 1) * pageSize;
      return jsonResp({ total: filtered.length, page, pageSize, items: filtered.slice(start, start + pageSize) });
    }
    if (parsedUrl.pathname === '/api/dxosDataGov:freezeSnapshot') {
      const snap = { snapshotUid: 'SNAP-V100', sourceCollection: body.sourceCollection, status: 'sealed' };
      state.snapshots.push(snap);
      return jsonResp(snap);
    }
    if (parsedUrl.pathname === '/api/latticePara:reindex') {
      return jsonResp({ indexedCount: 5 });
    }
    if (parsedUrl.pathname === '/api/dxosAi:triageScan') {
      return jsonResp({ scannedCount: 3, proposalsCreated: 1, deduplicatedSkipped: 0 });
    }
    if (parsedUrl.pathname === '/api/dxosStudio:composePortals') {
      return jsonResp({ composed: 7 });
    }

    throw new Error(`Unexpected path in mock: ${path}`);
  };

  return { state, mockFetch };
}

test('assertLoopbackOrigin rejects non-loopback or credentialed URLs and parseSeedArgs parses defaults', () => {
  assert.throws(() => assertLoopbackOrigin('https://prod.example.com'), /Unsafe protocol/);
  assert.throws(() => assertLoopbackOrigin('http://user:pass@localhost:13014'), /credentials/);
  assert.throws(() => assertLoopbackOrigin('http://10.0.0.5:13014'), /Unsafe non-loopback host/);

  const parsed = parseSeedArgs(['--origin=http://127.0.0.1:13014', '--org=mekong-ops'], {});
  assert.equal(parsed.origin, 'http://127.0.0.1:13014');
  assert.equal(parsed.organizationId, 'mekong-ops');
});

test('mock twinSetDesired catches forbidden keys (compressorMode, doorLocked) and invalid enums', async () => {
  const { mockFetch } = createMockShowcaseServer();
  const api = await createSeederClient({
    origin: 'http://localhost:13014',
    token: 'tok-root',
  }, mockFetch);

  await assert.rejects(
    () => api('dxosBlocks:twinSetDesired', {
      method: 'POST',
      values: { organizationId: 'native-ui-lab', assetId: 101, desiredPatch: { targetTempC: 4.0, compressorMode: 'eco-auto', doorLocked: true } },
    }),
    /TWIN_FIELD_FORBIDDEN/,
  );
  await assert.rejects(
    () => api('dxosBlocks:twinSetDesired', {
      method: 'POST',
      values: { organizationId: 'native-ui-lab', assetId: 101, desiredPatch: { fanMode: 'turbo', doorLock: 'yes' } },
    }),
    /TWIN_DESIRED_INVALID/,
  );
});

test('runV100ChampionshipShowcaseSeed executes full showcase cleanly and is idempotent on repeat run', async () => {
  const { state, mockFetch } = createMockShowcaseServer();
  const options = {
    origin: 'http://localhost:13014',
    organizationId: 'native-ui-lab',
    token: 'tok-root',
  };

  const first = await runV100ChampionshipShowcaseSeed(options, mockFetch);
  assert.equal(first.result, 'PASS');
  assert.equal(first.locations.created, 3);
  assert.equal(first.assets.created, 3);
  assert.equal(first.digitalTwin.seeded, true);
  assert.equal(first.wms.orderCreated, true);
  assert.equal(first.wms.linesCreated, 2);
  assert.equal(first.wms.lotsCreated, 4);
  assert.equal(first.wms.heldMkt, true);
  assert.equal(first.wms.line1AllocatedQty, 30);
  assert.equal(first.dmn.seeded, true);
  assert.equal(first.delegation.seeded, true);
  assert.equal(first.pkiSnapshot.signedNow, true);
  assert.equal(first.pkiSnapshot.frozenNow, true);

  // Second run MUST create zero duplicate resources
  const second = await runV100ChampionshipShowcaseSeed(options, mockFetch);
  assert.equal(second.result, 'PASS');
  assert.equal(second.locations.created, 0);
  assert.equal(second.locations.reused, 3);
  assert.equal(second.assets.created, 0);
  assert.equal(second.assets.reused, 3);
  assert.equal(second.digitalTwin.seeded, false);
  assert.equal(second.wms.orderCreated, false);
  assert.equal(second.wms.linesCreated, 0);
  assert.equal(second.wms.lotsCreated, 0);
  assert.equal(second.wms.heldMkt, false);
  assert.equal(second.dmn.seeded, false);
  assert.equal(second.delegation.seeded, false);
  assert.equal(second.pkiSnapshot.signedNow, false);
  assert.equal(second.pkiSnapshot.frozenNow, false);
  assert.equal(state.locations.length, 3);
  assert.equal(state.assets.length, 3);
  assert.equal(state.orders.length, 1);
  assert.equal(state.orderLines.length, 2);
  assert.equal(state.lots.length, 4);
  assert.equal(state.dmnTables.length, 1);
  assert.equal(state.delegations.length, 1);
  assert.equal(state.ledgerEntries.length, 1);
  assert.equal(state.snapshots.length, 1);
});

test('runV100ChampionshipShowcaseSeed paginates ledger/snapshots beyond 100 entries and filters snapshots strictly by latticeOrders', async () => {
  const initialLedgerEntries = Array.from({ length: 145 }, (_, idx) => ({
    seq: idx + 1,
    targetCollection: 'latticeAssets',
    targetRecordId: String(500 + idx),
  }));
  // Order ID created by mock server for ORD-V100-001: 3 locations (101..103), 3 assets (104..106), 3 shadows (107? no 1 shadow=107) -> order=108
  initialLedgerEntries.push({
    seq: 146,
    targetCollection: 'latticeOrders',
    targetRecordId: '108',
  });

  const initialSnapshots = [
    ...Array.from({ length: 120 }, (_, idx) => ({
      snapshotUid: `SNAP-OTHER-${idx + 1}`,
      sourceCollection: 'latticeAssets',
      status: 'sealed',
    })),
    {
      snapshotUid: 'SNAP-ORD-EXISTING',
      sourceCollection: 'latticeOrders',
      status: 'sealed',
    },
  ];

  const { state, mockFetch } = createMockShowcaseServer({ initialLedgerEntries, initialSnapshots });
  const result = await runV100ChampionshipShowcaseSeed({
    origin: 'http://localhost:13014',
    organizationId: 'native-ui-lab',
    token: 'tok-root',
  }, mockFetch);

  assert.equal(result.wms.orderId, 108);
  assert.equal(result.pkiSnapshot.alreadySigned, true);
  assert.equal(result.pkiSnapshot.signedNow, false);
  assert.equal(result.pkiSnapshot.frozenNow, false);
  assert.equal(result.pkiSnapshot.snapshotUid, 'SNAP-ORD-EXISTING');
  assert.equal(state.ledgerEntries.length, 146);
  assert.equal(state.snapshots.length, 121);
});

test('seedDelegationSample skips missing/inactive user preconditions but surfaces unexpected HTTP 403/500 errors', async () => {
  const options = {
    origin: 'http://localhost:13014',
    organizationId: 'native-ui-lab',
    token: 'tok-root',
  };

  const inactiveMock = createMockShowcaseServer({
    delegationCreateError: { status: 403, code: 'DELEGATION_TARGET_INACTIVE', message: 'Target user inactive' },
  });
  const skippedRes = await runV100ChampionshipShowcaseSeed(options, inactiveMock.mockFetch);
  assert.equal(skippedRes.result, 'PASS');
  assert.equal(skippedRes.delegation.seeded, false);
  assert.match(skippedRes.delegation.skippedReason, /DELEGATION_TARGET_INACTIVE/);

  const forbiddenMock = createMockShowcaseServer({
    delegationCreateError: { status: 403, code: 'DELEGATION_ESCALATION_FORBIDDEN', message: 'Unexpected forbidden' },
  });
  await assert.rejects(
    () => runV100ChampionshipShowcaseSeed(options, forbiddenMock.mockFetch),
    /HTTP 403: DELEGATION_ESCALATION_FORBIDDEN/,
  );

  const serverErrMock = createMockShowcaseServer({
    delegationCreateError: { status: 500, code: 'INTERNAL_ERROR', message: 'DB failure' },
  });
  await assert.rejects(
    () => runV100ChampionshipShowcaseSeed(options, serverErrMock.mockFetch),
    /HTTP 500: INTERNAL_ERROR/,
  );
});
