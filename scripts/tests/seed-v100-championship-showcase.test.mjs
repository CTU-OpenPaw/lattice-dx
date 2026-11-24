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
  omitCmmsPortalOnDomain = false,
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
    domains: [],
    automationRules: [],
    automationRuns: [],
    workOrders: [],
    connectors: [],
    iotDevices: [],
    webhookSubscriptions: [],
    provisionedPasswords: [],
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
    if (parsedUrl.pathname === '/api/dxosBuilder:listBusinessPacks') {
      const hasCol = state.domains.some((d) => d.collectionName === 'latticeCustomWorkOrders');
      const hasDmn = state.dmnTables.some((t) => t.tableKey === 'cmms_priority_routing_v1');
      const hasRule = state.automationRules.some((r) => r.ruleKey === 'auto_cmms_on_coldchain_fault');
      return jsonResp({
        items: [
          {
            packKey: 'cmms-maintenance',
            installed: Boolean(hasCol && hasDmn && hasRule),
          },
        ],
      });
    }
    if (parsedUrl.pathname === '/api/dxosBuilder:listDomains') {
      return jsonResp({ items: state.domains });
    }
    if (parsedUrl.pathname === '/api/dxosBuilder:installBusinessPack') {
      if (body.packKey !== 'cmms-maintenance') {
        return errorResp(400, 'UNKNOWN_BUSINESS_PACK', 'Unsupported pack');
      }
      if (!state.domains.some((d) => d.collectionName === 'latticeCustomWorkOrders')) {
        state.domains.push({
          collectionName: 'latticeCustomWorkOrders',
          rlsProtected: true,
          portalPages: omitCmmsPortalOnDomain ? [] : [{ path: '/p/cmms', title: 'CMMS Maintenance' }],
        });
      } else if (!omitCmmsPortalOnDomain) {
        const existingDom = state.domains.find((d) => d.collectionName === 'latticeCustomWorkOrders');
        existingDom.portalPages = [{ path: '/p/cmms', title: 'CMMS Maintenance' }];
      }
      if (!state.dmnTables.some((t) => t.tableKey === 'cmms_priority_routing_v1')) {
        state.dmnTables.push({ id: ++state.nextId, organizationId: body.organizationId, tableKey: 'cmms_priority_routing_v1' });
      }
      if (!state.automationRules.some((r) => r.ruleKey === 'auto_cmms_on_coldchain_fault')) {
        state.automationRules.push({ id: ++state.nextId, organizationId: body.organizationId, ruleKey: 'auto_cmms_on_coldchain_fault' });
      }
      return jsonResp({
        installed: true,
        packKey: 'cmms-maintenance',
        organizationId: body.organizationId,
        domain: {
          collectionName: 'latticeCustomWorkOrders',
          rls: { attached: true, verified: true },
          portalPage: { path: '/p/cmms' },
        },
        dmnTable: { tableKey: 'cmms_priority_routing_v1' },
        automationRule: { ruleKey: 'auto_cmms_on_coldchain_fault' },
      });
    }
    if (parsedUrl.pathname === '/api/dxosAutomations:listRules') {
      const org = parsedUrl.searchParams.get('organizationId');
      return jsonResp({
        items: state.automationRules.filter((r) => !org || r.organizationId === org),
      });
    }
    if (parsedUrl.pathname === '/api/dxosAutomations:saveRule') {
      const idx = state.automationRules.findIndex(
        (r) => r.organizationId === body.organizationId && r.ruleKey === body.ruleKey,
      );
      const entry = {
        id: idx >= 0 ? state.automationRules[idx].id : ++state.nextId,
        ...body,
      };
      if (idx >= 0) state.automationRules[idx] = entry;
      else state.automationRules.push(entry);
      return jsonResp({ rule: entry });
    }
    if (parsedUrl.pathname === '/api/latticeCustomWorkOrders:list') {
      const f = JSON.parse(parsedUrl.searchParams.get('filter') || '{}');
      return jsonResp(
        state.workOrders.filter((w) => !f.organizationId || w.organizationId === f.organizationId),
      );
    }
    if (parsedUrl.pathname === '/api/dxosAutomations:runNow') {
      const wo = {
        id: ++state.nextId,
        organizationId: body.organizationId,
        workOrderCode: `WO-${state.nextId}`,
        deviceKey: body.data?.deviceKey || '',
        priority: body.data?.severity === 'critical' ? 'critical' : 'high',
        status: 'open',
      };
      state.workOrders.push(wo);
      const run = {
        id: ++state.nextId,
        organizationId: body.organizationId,
        ruleKey: body.ruleKey,
        runUid: `run_${state.nextId}`,
        status: 'completed',
        stepTracesJson: [
          { stepIndex: 0, type: 'create_record', status: 'completed', output: { id: wo.id } },
          { stepIndex: 1, type: 'notify_role', status: 'completed', output: { dispatched: 1 } },
          { stepIndex: 2, type: 'twin_set_desired', status: 'skipped', skipReason: 'BRANCH_CONDITION_NOT_MATCHED' },
          { stepIndex: 3, type: 'trigger_ai_triage', status: 'skipped', skipReason: 'BRANCH_CONDITION_NOT_MATCHED' },
          { stepIndex: 4, type: 'call_connector', status: 'skipped', skipReason: 'BRANCH_CONDITION_NOT_MATCHED' },
        ],
      };
      state.automationRuns.push(run);
      return jsonResp({ run });
    }
    if (parsedUrl.pathname === '/api/dxosVault:list') {
      return jsonResp({
        organizationId: parsedUrl.searchParams.get('organizationId'),
        items: state.connectors.map(({ secrets, ...safe }) => ({
          ...safe,
          hasSecrets: Boolean(secrets && Object.keys(secrets).length > 0),
          secretKeys: secrets ? Object.keys(secrets) : [],
        })),
      });
    }
    if (parsedUrl.pathname === '/api/dxosVault:save') {
      const idx = state.connectors.findIndex(
        (c) => c.organizationId === body.organizationId && c.connectorKey === body.connectorKey,
      );
      const entry = {
        id: idx >= 0 ? state.connectors[idx].id : ++state.nextId,
        organizationId: body.organizationId,
        connectorKey: body.connectorKey,
        name: body.name,
        connectorType: body.connectorType,
        baseUrl: body.baseUrl,
        authType: body.authType,
        secrets: body.secrets || {},
      };
      if (idx >= 0) state.connectors[idx] = entry;
      else state.connectors.push(entry);
      return jsonResp({
        id: entry.id,
        organizationId: entry.organizationId,
        connectorKey: entry.connectorKey,
        connectorType: entry.connectorType,
        authType: entry.authType,
        hasSecrets: Boolean(body.secrets && Object.keys(body.secrets).length > 0),
        secretKeys: Object.keys(entry.secrets),
      });
    }
    if (parsedUrl.pathname === '/api/dxosBroker:listDevices') {
      return jsonResp({
        items: state.iotDevices.map(({ mqttPassword, ...safe }) => safe),
        total: state.iotDevices.length,
      });
    }
    if (parsedUrl.pathname === '/api/dxosBroker:provisionDevice') {
      if (state.iotDevices.some((d) => d.organizationId === body.organizationId && d.deviceKey === body.deviceKey)) {
        return errorResp(409, 'BROKER_DEVICE_EXISTS', 'Device exists');
      }
      const pwd = `mock-mqtt-secret-${++state.nextId}`;
      state.provisionedPasswords.push(pwd);
      const device = {
        id: ++state.nextId,
        organizationId: body.organizationId,
        deviceKey: body.deviceKey,
        name: body.name,
        assetId: body.assetId ?? null,
        mqttUsername: `ldx_${body.organizationId}_${body.deviceKey}`,
        mqttClientId: `ldx-${body.organizationId}-${body.deviceKey}`,
        topicPrefix: `latticedx/${body.organizationId}/${body.deviceKey}`,
        metadataJson: { brokerSynced: true },
      };
      state.iotDevices.push({ ...device, mqttPassword: pwd });
      return jsonResp({
        device,
        mqttPassword: pwd,
        brokerSynced: true,
      });
    }
    if (parsedUrl.pathname === '/api/dxosEvents:listSubscriptions') {
      return jsonResp({
        organizationId: parsedUrl.searchParams.get('organizationId'),
        items: state.webhookSubscriptions.map(({ signingSecret, ...safe }) => ({
          ...safe,
          hasSigningSecret: Boolean(signingSecret),
        })),
      });
    }
    if (parsedUrl.pathname === '/api/dxosEvents:saveSubscription') {
      const idx = state.webhookSubscriptions.findIndex(
        (s) => s.organizationId === body.organizationId && s.subscriptionKey === body.subscriptionKey,
      );
      const entry = {
        id: idx >= 0 ? state.webhookSubscriptions[idx].id : ++state.nextId,
        organizationId: body.organizationId,
        subscriptionKey: body.subscriptionKey,
        name: body.name,
        targetUrl: body.targetUrl,
        eventPattern: body.eventPattern,
        signingSecret: body.signingSecret,
        active: body.active !== false,
      };
      if (idx >= 0) state.webhookSubscriptions[idx] = entry;
      else state.webhookSubscriptions.push(entry);
      const { signingSecret, ...safe } = entry;
      return jsonResp({
        ...safe,
        hasSigningSecret: Boolean(signingSecret),
      });
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

test('runV100ChampionshipShowcaseSeed executes full showcase cleanly and is idempotent on repeat run with zero secret leaks', async () => {
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
  assert.equal(first.cmmsPack.seeded, true);
  assert.equal(first.cmmsPack.collectionName, 'latticeCustomWorkOrders');
  assert.equal(first.cmmsPack.dmnTableKey, 'cmms_priority_routing_v1');
  assert.equal(first.cmmsPack.automationRuleKey, 'auto_cmms_on_coldchain_fault');
  assert.equal(first.cmmsPack.portalPath, '/p/cmms');
  assert.deepEqual(first.automationShowcase.ruleKeys, [
    'auto_cmms_on_coldchain_fault',
    'auto_mkt_quarantine_response',
    'auto_sla_breach_escalation',
  ]);
  assert.equal(first.automationShowcase.initialRunTriggered, true);
  assert.equal(first.automationShowcase.initialRunStepsCompleted, 2);
  assert.equal(first.automationShowcase.initialRunStepsSkipped, 3);
  assert.equal(first.connectorVault.seeded, true);
  assert.equal(first.connectorVault.connectorKey, 'n8n-coldchain-orchestrator');
  assert.equal(first.connectorVault.hasSecrets, true);
  assert.equal(state.connectors.length, 1);
  assert.deepEqual(Object.keys(state.connectors[0].secrets), ['secret']);
  assert.equal(state.connectors[0].secrets.secret, 'demo-showcase-webhook-secret-2026');
  assert.equal(first.mqttDevice.seeded, true);
  assert.equal(first.mqttDevice.deviceKey, 'cold-truck-ct-01');
  assert.equal(first.mqttDevice.mqttPasswordProvisioned, true);
  assert.equal(first.mqttDevice.mqttPassword, undefined);
  assert.equal(first.webhookSubscription.seeded, true);
  assert.equal(first.webhookSubscription.subscriptionKey, 'n8n-coldchain-alerts');
  assert.equal(first.webhookSubscription.hasSigningSecret, true);

  const vaultSaveCallIdx = state.calls.indexOf('/api/dxosVault:save');
  const devProvisionCallIdx = state.calls.indexOf('/api/dxosBroker:provisionDevice');
  const runNowCallIdx = state.calls.indexOf('/api/dxosAutomations:runNow');
  assert.ok(vaultSaveCallIdx >= 0 && devProvisionCallIdx >= 0 && runNowCallIdx >= 0);
  assert.ok(vaultSaveCallIdx < runNowCallIdx, 'seedConnectorVault must execute before automation runNow');
  assert.ok(devProvisionCallIdx < runNowCallIdx, 'seedMqttDevice must execute before automation runNow');

  const firstJson = JSON.stringify(first);
  assert.equal(firstJson.includes('demo-showcase-webhook-secret-2026'), false);
  for (const pwd of state.provisionedPasswords) {
    assert.equal(firstJson.includes(pwd), false, 'Summary leaked raw mqttPassword');
  }

  // Second run MUST create zero duplicate resources and leak zero secrets
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
  assert.equal(second.cmmsPack.seeded, false);
  assert.equal(second.cmmsPack.alreadyInstalled, true);
  assert.equal(second.connectorVault.seeded, false);
  assert.equal(second.connectorVault.hasSecrets, true);
  assert.equal(second.mqttDevice.seeded, false);
  assert.equal(second.mqttDevice.mqttPasswordProvisioned, false);
  assert.equal(second.mqttDevice.mqttPassword, undefined);
  assert.equal(second.webhookSubscription.seeded, false);
  assert.equal(second.webhookSubscription.hasSigningSecret, true);
  assert.equal(state.locations.length, 3);
  assert.equal(state.assets.length, 3);
  assert.equal(state.orders.length, 1);
  assert.equal(state.orderLines.length, 2);
  assert.equal(state.lots.length, 4);
  assert.equal(state.dmnTables.length, 2);
  assert.equal(state.delegations.length, 1);
  assert.equal(state.ledgerEntries.length, 1);
  assert.equal(state.snapshots.length, 1);
  assert.equal(state.domains.length, 1);
  assert.equal(state.automationRules.length, 3);
  assert.equal(second.automationShowcase.createdRules.length, 0);
  assert.equal(second.automationShowcase.initialRunTriggered, false);
  assert.equal(state.workOrders.length, 1);
  assert.equal(state.connectors.length, 1);
  assert.equal(state.iotDevices.length, 1);
  assert.equal(state.webhookSubscriptions.length, 1);

  const secondJson = JSON.stringify(second);
  assert.equal(secondJson.includes('demo-showcase-webhook-secret-2026'), false);
  for (const pwd of state.provisionedPasswords) {
    assert.equal(secondJson.includes(pwd), false, 'Repeat summary leaked raw mqttPassword');
  }
});

test('runV100ChampionshipShowcaseSeed repairs CMMS pack if /p/cmms portal page is missing and keeps secrets masked', async () => {
  const { state, mockFetch } = createMockShowcaseServer({ omitCmmsPortalOnDomain: true });
  const options = {
    origin: 'http://localhost:13014',
    organizationId: 'native-ui-lab',
    token: 'tok-root',
  };
  const first = await runV100ChampionshipShowcaseSeed(options, mockFetch);
  assert.equal(first.cmmsPack.seeded, true);
  const second = await runV100ChampionshipShowcaseSeed(options, mockFetch);
  // Because /p/cmms was omitted from listDomains in this fixture, seedCmmsBusinessPack triggers idempotent reinstall without duplicating records
  assert.equal(second.cmmsPack.seeded, true);
  assert.equal(state.domains.length, 1);
  assert.equal(state.automationRules.length, 3);
  assert.equal(second.automationShowcase.createdRules.length, 0);
  assert.equal(second.automationShowcase.initialRunTriggered, false);
  assert.equal(state.workOrders.length, 1);
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
