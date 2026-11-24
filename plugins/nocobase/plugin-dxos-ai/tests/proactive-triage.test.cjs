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
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');

function makeTriageHarness({ withRBACGrants = true } = {}) {
  const store = {
    latticeAssets: [
      { id: 101, code: 'CH-101', name: 'Kho lạnh A1', entityId: 'urn:ngsi-ld:Asset:org-a:native:101', organizationId: 'org-a', status: 'active' },
      { id: 102, code: 'CH-102', name: 'Kho lạnh A2 (Vaccine)', entityId: 'urn:ngsi-ld:Asset:org-a:native:102', organizationId: 'org-a', status: 'active' },
      { id: 103, code: 'CH-103', name: 'Kho lạnh A3 (Chiller)', entityId: 'urn:ngsi-ld:Asset:org-a:native:103', organizationId: 'org-a', status: 'active' },
      { id: 201, code: 'CH-201', name: 'Kho lạnh Org B', entityId: 'urn:ngsi-ld:Asset:org-b:native:201', organizationId: 'org-b', status: 'active' },
    ],
    latticeIncidentCases: [
      {
        id: 1,
        code: 'ALM-MED-1',
        name: 'Cảnh báo cửa mở lâu A1',
        organizationId: 'org-a',
        assetId: 101,
        assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:101',
        severity: 'medium',
        status: 'open',
        proposal: 'Manual operator note — keep me',
      },
      {
        id: 2,
        code: 'ALM-CRIT-2',
        name: 'Cảnh báo nhiệt độ vượt ngưỡng buồng lạnh A2',
        organizationId: 'org-a',
        assetId: 102,
        assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:102',
        severity: 'critical',
        status: 'open',
        proposal: '',
      },
      {
        id: 3,
        code: 'ALM-HIGH-3',
        name: 'Cảnh báo trôi setpoint nhiệt độ thiết bị A3',
        organizationId: 'org-a',
        assetId: 103,
        assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:103',
        severity: 'high',
        status: 'acknowledged',
        proposal: null,
      },
      {
        id: 4,
        code: 'ALM-CLOSED-4',
        name: 'Cảnh báo đã đóng',
        organizationId: 'org-a',
        assetId: 101,
        assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:101',
        severity: 'critical',
        status: 'closed',
        proposal: '',
      },
      {
        id: 5,
        code: 'ALM-ORGB-5',
        name: 'Cảnh báo Org B',
        organizationId: 'org-b',
        assetId: 201,
        assetEntityId: 'urn:ngsi-ld:Asset:org-b:native:201',
        severity: 'critical',
        status: 'open',
        proposal: '',
      },
    ],
    latticeTwinShadows: [
      {
        id: 201,
        organizationId: 'org-a',
        assetId: 102,
        assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:102',
        desiredJson: { targetTempC: -20, fanMode: 'auto' },
        reportedJson: { targetTempC: -11, temperature: -10.5 },
        commandStatus: 'acked',
        version: 1,
      },
      {
        id: 202,
        organizationId: 'org-a',
        assetId: 103,
        assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:103',
        desiredJson: { targetTempC: -18, fanMode: 'auto' },
        reportedJson: { targetTempC: -12, temperature: -12 },
        commandStatus: 'acked',
        version: 1,
      },
    ],
    latticeStockLots: [
      {
        id: 301,
        organizationId: 'org-a',
        lotCode: 'LOT-VAC-301',
        sku: 'VAC-01',
        productName: 'Vaccine Cold Batch',
        assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:102',
        qtyOnHand: 50,
        qtyReserved: 10,
        expiryDate: '2027-06-01T00:00:00Z',
        targetTempMinC: -25,
        targetTempMaxC: -15,
        mktCelsius: -12.4,
        status: 'available',
        active: true,
      },
      {
        id: 302,
        organizationId: 'org-b',
        lotCode: 'LOT-B-302',
        sku: 'VAC-01',
        productName: 'Org B Lot',
        assetEntityId: 'urn:ngsi-ld:Asset:org-b:native:201',
        qtyOnHand: 20,
        qtyReserved: 0,
        expiryDate: '2027-06-01T00:00:00Z',
        targetTempMinC: -25,
        targetTempMaxC: -15,
        status: 'available',
        active: true,
      },
    ],
    latticeOrderLines: [
      {
        id: 401,
        organizationId: 'org-a',
        orderId: 501,
        orderCode: 'ORD-A-501',
        lineNo: 1,
        sku: 'VAC-01',
        lotId: 301,
        lotCode: 'LOT-VAC-301',
        requestedQty: 10,
        allocatedQty: 10,
        status: 'allocated',
      },
    ],
    latticeOrders: [
      { id: 501, code: 'ORD-A-501', name: 'Giao Vaccine HCM', organizationId: 'org-a', status: 'approved' },
    ],
    latticeDataLineage: [
      {
        id: 601,
        organizationId: 'org-a',
        edgeUid: 'edge-lot301-ord501',
        sourceCollection: 'latticeStockLots',
        sourceRecordId: '301',
        targetCollection: 'latticeOrders',
        targetRecordId: '501',
        relationType: 'allocated_to',
        observedAt: new Date().toISOString(),
      },
    ],
    latticeDataQuarantine: [],
    latticeTelemetryPoints: [],
    latticeCryptoLedger: [],
    latticePkiKeys: [],
    latticeAiApprovalQueue: [],
    latticeAiAuditLogs: [],
    latticeNotifications: [],
    latticeAiProfiles: [],
    latticeEmployees: [
      { id: 13, userId: 9, code: 'EMP-9', organizationId: 'org-a', active: true },
      { id: 14, userId: 10, code: 'MGR-10', organizationId: 'org-a', active: true },
      { id: 15, userId: 11, code: 'DIR-11', organizationId: 'org-a', active: true },
      { id: 16, userId: 12, code: 'DISP-12', organizationId: 'org-a', active: true },
      { id: 21, userId: 20, code: 'MGR-20', organizationId: 'org-b', active: true },
    ],
    roles: [
      { name: 'root', allowConfigure: true, allowAll: true, snippets: ['*'] },
      { name: 'admin', allowConfigure: true, snippets: ['pm'] },
      { name: 'ldx_manager', allowConfigure: false, snippets: [] },
      { name: 'ldx_dispatcher', allowConfigure: false, snippets: [] },
      { name: 'ldx_director', allowConfigure: false, snippets: [] },
      { name: 'ldx_employee', allowConfigure: false, snippets: [] },
    ],
    rolesUsers: [
      { userId: 1, roleName: 'root' },
      { userId: 9, roleName: 'ldx_employee' },
      { userId: 10, roleName: 'ldx_manager' },
      { userId: 11, roleName: 'ldx_director' },
      { userId: 12, roleName: 'ldx_dispatcher' },
      { userId: 20, roleName: 'ldx_manager' },
    ],
    dataSourcesRolesResources: withRBACGrants
      ? [
          {
            roleName: 'ldx_manager',
            name: 'latticeStockLots',
            dataSourceKey: 'main',
            usingActionsConfig: true,
            actions: [{ name: 'view' }, { name: 'update' }],
          },
          {
            roleName: 'ldx_manager',
            name: 'latticeOrders',
            dataSourceKey: 'main',
            usingActionsConfig: true,
            actions: [{ name: 'view' }, { name: 'update' }],
          },
          {
            roleName: 'ldx_manager',
            name: 'latticeAssets',
            dataSourceKey: 'main',
            usingActionsConfig: true,
            actions: [{ name: 'view' }, { name: 'update' }],
          },
          {
            roleName: 'ldx_manager',
            name: 'latticeTwinShadows',
            dataSourceKey: 'main',
            usingActionsConfig: true,
            actions: [{ name: 'view' }, { name: 'update' }],
          },
          {
            roleName: 'ldx_manager',
            name: 'latticeIncidentCases',
            dataSourceKey: 'main',
            usingActionsConfig: true,
            actions: [{ name: 'view' }, { name: 'update' }],
          },
          {
            roleName: 'ldx_director',
            name: 'latticeServiceTickets',
            dataSourceKey: 'main',
            usingActionsConfig: true,
            actions: [{ name: 'view' }, { name: 'update' }],
          },
        ]
      : [],
  };

  let seq = 1000;
  const matchFilter = (row, filter = {}) => Object.entries(filter || {}).every(([k, cond]) => {
    if (k === '$and' && Array.isArray(cond)) return cond.every((sub) => matchFilter(row, sub));
    if (k === '$or' && Array.isArray(cond)) return cond.some((sub) => matchFilter(row, sub));
    if (cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)) {
      if (Array.isArray(cond.$in)) return cond.$in.includes(row[k]);
      if ('$eq' in cond) return row[k] === cond.$eq;
      if ('$gt' in cond) return new Date(row[k]).getTime() > new Date(cond.$gt).getTime();
      if ('$gte' in cond) return new Date(row[k]).getTime() >= new Date(cond.$gte).getTime();
    }
    return row[k] === cond;
  });

  const wrap = (row) => ({
    ...row,
    get: (k) => row[k],
    set: (k, v) => { row[k] = v; },
    toJSON: () => ({ ...row }),
    update: async (patch = {}) => { Object.assign(row, patch, { updatedAt: new Date() }); return wrap(row); },
  });

  const db = {
    store,
    hasCollection: (name) => Object.prototype.hasOwnProperty.call(store, name),
    sequelize: {
      getDialect: () => 'sqlite',
      transaction: async (fn) => fn({ id: `tx-${++seq}` }),
    },
    getRepository(name) {
      const arr = store[name];
      if (!arr) return null;
      return {
        find: async ({ filter = {}, sort, limit = 100 } = {}) => {
          let rows = arr.filter((r) => matchFilter(r, filter));
          if (Array.isArray(sort) && sort.includes('-id')) {
            rows = [...rows].sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
          }
          return rows.slice(0, limit).map(wrap);
        },
        findOne: async ({ filter = {}, filterByTk } = {}) => {
          const hit = filterByTk != null
            ? arr.find((r) => String(r.id ?? r.username ?? r.name) === String(filterByTk))
            : arr.find((r) => matchFilter(r, filter));
          return hit ? wrap(hit) : null;
        },
        create: async ({ values = {} } = {}) => {
          const row = { id: ++seq, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...values };
          arr.push(row);
          return wrap(row);
        },
        update: async ({ filter = {}, filterByTk, values = {} } = {}) => {
          const matched = [];
          for (const row of arr) {
            if (filterByTk != null && String(row.id) !== String(filterByTk)) continue;
            if (!matchFilter(row, filter)) continue;
            Object.assign(row, values, { updatedAt: new Date().toISOString() });
            matched.push(wrap(row));
          }
          return matched;
        },
        count: async ({ filter = {} } = {}) => arr.filter((r) => matchFilter(r, filter)).length,
      };
    },
  };

  const makeCtx = ({ userId, username, roles, values, params = {}, method = 'POST' } = {}) => ({
    db,
    method,
    state: {
      currentUser: userId != null ? { id: userId, username } : null,
      currentRoles: roles || [],
      currentRole: roles?.[0] || null,
    },
    action: {
      params: {
        ...params,
        ...(values !== undefined ? { values } : {}),
      },
    },
    app: { resourceManager: { getResource: () => null } },
  });

  return { db, store, makeCtx };
}

test('proactive-triage correlates context, sorts by severity, preserves manual proposal, deduplicates HITL cards, and records lineage', async () => {
  const {
    TRIAGE_DEDUP_WINDOW_MS,
    buildTriageRecommendation,
    runProactiveIncidentTriage,
  } = require(path.join(PLUGIN_ROOT, 'src/server/proactive-triage.js'));

  assert.equal(typeof TRIAGE_DEDUP_WINDOW_MS, 'number');
  assert.ok(TRIAGE_DEDUP_WINDOW_MS > 0);
  assert.equal(typeof buildTriageRecommendation, 'function');

  const { db, store } = makeTriageHarness();

  // dryRun=true does NOT mutate DB or create HITL rows
  const dryRes = await runProactiveIncidentTriage(db, {
    organizationId: 'org-a',
    actor: { userId: 12, username: 'disp12' },
    dryRun: true,
  });
  assert.equal(dryRes.scannedCount, 3);
  assert.equal(dryRes.matchedAlarms, 3);
  assert.equal(dryRes.proposalsCreated, 0);
  assert.equal(store.latticeAiApprovalQueue.length, 0);
  assert.equal(store.latticeIncidentCases.find((a) => a.id === 2).proposal, '');

  // Live run creates 3 HITL cards sorted critical -> high -> medium
  const res = await runProactiveIncidentTriage(db, {
    organizationId: 'org-a',
    actor: { userId: 12, username: 'disp12' },
  });
  assert.equal(res.scannedCount, 3);
  assert.equal(res.matchedAlarms, 3);
  assert.equal(res.proposalsCreated, 3);
  assert.equal(res.deduplicatedSkipped, 0);
  assert.equal(res.proposals.length, 3);

  assert.deepEqual(
    res.proposals.map((p) => p.alarmId),
    [2, 3, 1],
    'Alarms must be prioritized critical > high > medium',
  );

  // Critical alarm 2 (cold-chain lot exposed) proposes dxos_wms_hold_lot -> NEVER mutates stock lot directly
  assert.equal(res.proposals[0].toolName, 'dxos_wms_hold_lot');
  assert.equal(store.latticeStockLots.find((l) => l.id === 301).status, 'available');

  // High alarm 3 (setpoint drift, no unheld lot) proposes dxos_twin_set_desired -> NEVER mutates twin shadow directly
  assert.equal(res.proposals[1].toolName, 'dxos_twin_set_desired');
  assert.equal(store.latticeTwinShadows.find((s) => s.id === 202).desiredJson.targetTempC, -18);

  // Medium alarm 1 proposes dxos_alarm_action and preserves existing non-empty manual proposal
  assert.equal(res.proposals[2].toolName, 'dxos_alarm_action');
  assert.equal(store.latticeIncidentCases.find((a) => a.id === 1).proposal, 'Manual operator note — keep me');

  // Empty proposals on alarms 2 and 3 were populated cleanly
  assert.ok(String(store.latticeIncidentCases.find((a) => a.id === 2).proposal || '').length > 10);
  assert.ok(String(store.latticeIncidentCases.find((a) => a.id === 3).proposal || '').length > 10);

  // Foreign org-b alarm 5 was untouched
  assert.equal(store.latticeIncidentCases.find((a) => a.id === 5).proposal, '');
  assert.equal(store.latticeAiApprovalQueue.some((q) => q.organizationId === 'org-b'), false);

  // HITL records have required fields + affectedLots + summary
  const holdCard = store.latticeAiApprovalQueue.find((q) => q.toolName === 'dxos_wms_hold_lot');
  assert.ok(holdCard);
  assert.equal(holdCard.organizationId, 'org-a');
  assert.equal(holdCard.requesterUserId, 12);
  assert.equal(holdCard.aiEmployee, 'dxos-coordinator');
  assert.equal(holdCard.targetCollection, 'latticeStockLots');
  assert.equal(holdCard.targetRecordId, 301);
  assert.equal(holdCard.riskLevel, 'critical');
  assert.equal(holdCard.status, 'pending');
  assert.ok(holdCard.diffPreview.summary);
  assert.ok(Array.isArray(holdCard.diffPreview.affectedLots) && holdCard.diffPreview.affectedLots.length === 1);
  assert.ok(Array.isArray(holdCard.diffPreview.changes) && holdCard.diffPreview.changes.length >= 1);

  // Lineage recorded for latticeIncidentCases -> latticeAiApprovalQueue ('triaged_into')
  const triageEdges = store.latticeDataLineage.filter((e) => e.relationType === 'triaged_into');
  assert.equal(triageEdges.length, 3);
  assert.ok(triageEdges.some((e) => e.sourceCollection === 'latticeIncidentCases' && e.targetCollection === 'latticeAiApprovalQueue'));

  // Repeated sweep deduplicates all 3 pending proposals
  const second = await runProactiveIncidentTriage(db, {
    organizationId: 'org-a',
    actor: { userId: 12, username: 'disp12' },
  });
  assert.equal(second.proposalsCreated, 0);
  assert.equal(second.deduplicatedSkipped, 3);
  assert.equal(store.latticeAiApprovalQueue.length, 3);
});

test('dxosAi:triageScan enforces auth/roles/org scope, logs audit, emits SSE pubsub, and index.js keeps scheduler disabled by default', async () => {
  const { createDxosAiActions } = require(path.join(PLUGIN_ROOT, 'src/server/ai-resource.js'));
  const { subscribeSurfaceEvents } = require(path.join(PLUGIN_ROOT, 'src/server/surface-events.js'));
  const { startProactiveTriageScheduler } = require(path.join(PLUGIN_ROOT, 'src/server/proactive-triage.js'));

  const { db, store, makeCtx } = makeTriageHarness();
  const actions = createDxosAiActions(db);

  // Unauthenticated -> 401
  await assert.rejects(
    () => actions.triageScan(makeCtx({ userId: null, method: 'POST' }), async () => {}),
    (err) => err.status === 401,
  );

  // Wrong HTTP method -> 405
  await assert.rejects(
    () => actions.triageScan(makeCtx({ userId: 12, username: 'disp12', roles: ['ldx_dispatcher'], method: 'GET' }), async () => {}),
    (err) => err.status === 405,
  );

  // Plain employee denied -> 403
  await assert.rejects(
    () => actions.triageScan(makeCtx({ userId: 9, username: 'emp9', roles: ['ldx_employee'], method: 'POST' }), async () => {}),
    (err) => err.status === 403,
  );

  // Non-root cannot target another organizationId -> 403 DXOS_ORG_MISMATCH
  await assert.rejects(
    () => actions.triageScan(makeCtx({ userId: 12, username: 'disp12', roles: ['ldx_dispatcher'], method: 'POST', values: { organizationId: 'org-b' } }), async () => {}),
    (err) => err.status === 403 && err.code === 'DXOS_ORG_MISMATCH',
  );

  // Dispatcher runs triageScan -> scoped to org-a, writes audit log, emits SSE surface event
  const sseEvents = [];
  const off = subscribeSurfaceEvents('incidents', (ev) => sseEvents.push(ev));
  try {
    const scanCtx = makeCtx({ userId: 12, username: 'disp12', roles: ['ldx_dispatcher'], method: 'POST', values: {} });
    await actions.triageScan(scanCtx, async () => {});
    assert.equal(scanCtx.body.proposalsCreated, 3);
    assert.equal(scanCtx.body.organizationId, 'org-a');
    assert.ok(store.latticeAiAuditLogs.some((l) => l.toolName === 'dxosAi:triageScan' && l.status === 'allowed'));
    assert.ok(sseEvents.some((ev) => ev.type === 'hitl_triage_scan' && ev.proposalsCreated === 3));
  } finally {
    off();
  }

  // index.js registers dxosAi:triageScan:loggedIn and leaves triage scheduler off when DX_PROACTIVE_TRIAGE_INTERVAL_MS is unset
  const origLoad = Module._load;
  const origSetInterval = global.setInterval;
  const allowed = [];
  const intervals = [];
  class MockPlugin { constructor(app) { this.app = app; this.db = app?.db; } }
  Module._load = function (req, parent, isMain) {
    if (req === '@nocobase/server') return { Plugin: MockPlugin };
    return origLoad.call(this, req, parent, isMain);
  };
  global.setInterval = (fn, ms) => {
    const handle = { unrefCalled: false, unref() { this.unrefCalled = true; }, fn, ms };
    intervals.push(handle);
    return handle;
  };
  try {
    const ServerPlugin = require(path.join(PLUGIN_ROOT, 'src/server/index.js'));
    const pluginInst = new ServerPlugin({
      db,
      use: () => {},
      resourceManager: { define: () => {}, use: () => {} },
      acl: { registerSnippet: () => {}, allow: (res, act, cond) => allowed.push(`${res}:${act}:${cond}`) },
    });
    await pluginInst.load();
    assert.ok(allowed.includes('dxosAi:triageScan:loggedIn'));
    assert.equal(intervals.length, 0, 'Background triage timer must stay disabled when DX_PROACTIVE_TRIAGE_INTERVAL_MS is not > 0');

    // Explicit positive interval schedules timer and calls .unref()
    const sched = startProactiveTriageScheduler(db, { env: { DX_PROACTIVE_TRIAGE_INTERVAL_MS: '60000' } });
    assert.equal(sched.enabled, true);
    assert.equal(intervals.length, 1);
    assert.equal(intervals[0].unrefCalled, true);
    sched.stop();
  } finally {
    Module._load = origLoad;
    global.setInterval = origSetInterval;
  }
});

test('approveAction executes dxos_wms_hold_lot, dxos_twin_set_desired, and dxos_alarm_action, enforces cross-org/tamper locks & MODULE_NOT_FOUND fallbacks without swallowing security invariants', async () => {
  const { createDxosAiActions } = require(path.join(PLUGIN_ROOT, 'src/server/ai-resource.js'));
  const { runProactiveIncidentTriage } = require(path.join(PLUGIN_ROOT, 'src/server/proactive-triage.js'));

  const { db, store, makeCtx } = makeTriageHarness();
  const actions = createDxosAiActions(db);

  // Dispatcher triages org-a alarms -> creates 3 pending HITL items (hold lot, twin setpoint, alarm ack)
  await runProactiveIncidentTriage(db, {
    organizationId: 'org-a',
    actor: { userId: 12, username: 'disp12' },
  });

  const holdCard = store.latticeAiApprovalQueue.find((q) => q.toolName === 'dxos_wms_hold_lot');
  const twinCard = store.latticeAiApprovalQueue.find((q) => q.toolName === 'dxos_twin_set_desired');
  const alarmCard = store.latticeAiApprovalQueue.find((q) => q.toolName === 'dxos_alarm_action');

  // Foreign org manager cannot approve org-a card
  await assert.rejects(
    () => actions.approveAction(makeCtx({ userId: 20, username: 'mgr20', roles: ['ldx_manager'], values: { approvalId: holdCard.id } }), async () => {}),
    (err) => err.status === 404 || err.status === 403,
  );

  // 1. Manager approves dxos_wms_hold_lot -> real WMS engine holds lot 301 & creates quarantine + ledger
  const approveHoldCtx = makeCtx({
    userId: 10,
    username: 'mgr10',
    roles: ['ldx_manager'],
    values: { approvalId: holdCard.id, note: 'Phê duyệt tạm giữ lô' },
  });
  await actions.approveAction(approveHoldCtx, async () => {});
  assert.equal(approveHoldCtx.body.status, 'executed');
  assert.equal(store.latticeStockLots.find((l) => l.id === 301).status, 'hold_mkt');
  assert.ok(store.latticeDataQuarantine.length >= 1);

  // 2. Manager approves dxos_twin_set_desired -> real digital-twin sets desiredJson & commandStatus='dispatched' with hitlApproved=true
  const approveTwinCtx = makeCtx({
    userId: 10,
    username: 'mgr10',
    roles: ['ldx_manager'],
    values: { approvalId: twinCard.id, note: 'Phê duyệt hạ nhiệt độ chiller' },
  });
  await actions.approveAction(approveTwinCtx, async () => {});
  assert.equal(approveTwinCtx.body.status, 'executed');
  const updatedShadow = store.latticeTwinShadows.find((s) => s.id === 202);
  assert.equal(updatedShadow.commandStatus, 'dispatched');
  assert.ok(updatedShadow.desiredJson.targetTempC < -18);

  // 3. Manager approves dxos_alarm_action -> updates latticeIncidentCases 1 to acknowledged
  const approveAlarmCtx = makeCtx({
    userId: 10,
    username: 'mgr10',
    roles: ['ldx_manager'],
    values: { approvalId: alarmCard.id, note: 'Đã xác nhận kiểm tra cửa kho' },
  });
  await actions.approveAction(approveAlarmCtx, async () => {});
  assert.equal(approveAlarmCtx.body.status, 'executed');
  assert.equal(store.latticeIncidentCases.find((a) => a.id === 1).status, 'acknowledged');

  // 4. Tampered proposedArgs (empty desiredPatch) fails 409 HITL_ARGS_MISMATCH
  const tamperedTwin = await db.getRepository('latticeAiApprovalQueue').create({
    values: {
      organizationId: 'org-a',
      requesterUserId: 12,
      requesterUsername: 'disp12',
      aiEmployee: 'dxos-coordinator',
      toolName: 'dxos_twin_set_desired',
      targetCollection: 'latticeTwinShadows',
      targetRecordId: 202,
      operation: 'update',
      proposedArgs: { assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:103', desiredPatch: {} },
      riskLevel: 'high',
      status: 'pending',
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  await assert.rejects(
    () => actions.approveAction(makeCtx({ userId: 10, username: 'mgr10', roles: ['ldx_manager'], values: { approvalId: tamperedTwin.id } }), async () => {}),
    (err) => err.status === 409 && err.code === 'HITL_ARGS_MISMATCH',
  );

  // 5. MODULE_NOT_FOUND standalone fallback works cleanly for dxos_wms_hold_lot & dxos_twin_set_desired
  const extraLot = await db.getRepository('latticeStockLots').create({
    values: {
      organizationId: 'org-a',
      lotCode: 'LOT-FALLBACK-9',
      sku: 'VAC-02',
      productName: 'Fallback Lot',
      qtyOnHand: 10,
      qtyReserved: 0,
      expiryDate: '2027-08-01T00:00:00Z',
      status: 'available',
      active: true,
    },
  });
  const fallbackHoldRow = await db.getRepository('latticeAiApprovalQueue').create({
    values: {
      organizationId: 'org-a',
      requesterUserId: 12,
      requesterUsername: 'disp12',
      aiEmployee: 'dxos-coordinator',
      toolName: 'dxos_wms_hold_lot',
      targetCollection: 'latticeStockLots',
      targetRecordId: extraLot.id,
      operation: 'update',
      proposedArgs: { lotId: extraLot.id, lotCode: 'LOT-FALLBACK-9', organizationId: 'org-a', forceHold: true, reason: 'Standalone fallback' },
      riskLevel: 'high',
      status: 'pending',
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });

  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (String(request).includes('wms-engine') || String(request).includes('digital-twin')) {
      throw Object.assign(new Error(`Cannot find module '${request}'`), { code: 'MODULE_NOT_FOUND' });
    }
    return origLoad.call(this, request, parent, isMain);
  };
  try {
    const fbCtx = makeCtx({ userId: 10, username: 'mgr10', roles: ['ldx_manager'], values: { approvalId: fallbackHoldRow.id } });
    await actions.approveAction(fbCtx, async () => {});
    assert.equal(fbCtx.body.status, 'executed');
    assert.equal(store.latticeStockLots.find((l) => l.id === extraLot.id).status, 'hold_mkt');

    const fallbackTwinRow = await db.getRepository('latticeAiApprovalQueue').create({
      values: {
        organizationId: 'org-a',
        requesterUserId: 12,
        requesterUsername: 'disp12',
        aiEmployee: 'dxos-coordinator',
        toolName: 'dxos_twin_set_desired',
        targetCollection: 'latticeTwinShadows',
        targetRecordId: 202,
        operation: 'update',
        proposedArgs: { assetId: 103, assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:103', desiredPatch: { targetTempC: -24, fanMode: 'eco' } },
        riskLevel: 'high',
        status: 'pending',
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    const fbTwinCtx = makeCtx({ userId: 10, username: 'mgr10', roles: ['ldx_manager'], values: { approvalId: fallbackTwinRow.id } });
    await actions.approveAction(fbTwinCtx, async () => {});
    assert.equal(fbTwinCtx.body.status, 'executed');
    assert.equal(store.latticeTwinShadows.find((s) => s.id === 202).desiredJson.targetTempC, -24);
  } finally {
    Module._load = origLoad;
  }

  // 5b. dxos_alarm_action clear transitions alarm to closed & rejects double-clear with 409 ALARM_ALREADY_CLEARED
  const clearAlarmRow = await db.getRepository('latticeAiApprovalQueue').create({
    values: {
      organizationId: 'org-a',
      requesterUserId: 12,
      requesterUsername: 'disp12',
      aiEmployee: 'dxos-coordinator',
      toolName: 'dxos_alarm_action',
      targetCollection: 'latticeIncidentCases',
      targetRecordId: 1,
      operation: 'update',
      proposedArgs: { action: 'clear', alarmId: 1, note: 'Đã khắc phục cửa kho' },
      riskLevel: 'medium',
      status: 'pending',
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  const clearCtx = makeCtx({ userId: 10, username: 'mgr10', roles: ['ldx_manager'], values: { approvalId: clearAlarmRow.id } });
  await actions.approveAction(clearCtx, async () => {});
  assert.equal(clearCtx.body.status, 'executed');
  assert.equal(store.latticeIncidentCases.find((a) => a.id === 1).status, 'closed');

  const doubleClearRow = await db.getRepository('latticeAiApprovalQueue').create({
    values: {
      organizationId: 'org-a',
      requesterUserId: 12,
      requesterUsername: 'disp12',
      aiEmployee: 'dxos-coordinator',
      toolName: 'dxos_alarm_action',
      targetCollection: 'latticeIncidentCases',
      targetRecordId: 1,
      operation: 'update',
      proposedArgs: { action: 'clear', alarmId: 1, note: 'Double clear' },
      riskLevel: 'medium',
      status: 'pending',
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  await assert.rejects(
    () => actions.approveAction(makeCtx({ userId: 10, username: 'mgr10', roles: ['ldx_manager'], values: { approvalId: doubleClearRow.id } }), async () => {}),
    (err) => err.status === 409 && err.code === 'ALARM_ALREADY_CLEARED',
  );

  // 6. Security invariant (PKI_MASTER_KEY_MISSING) thrown inside digital-twin MUST NOT be swallowed!
  const invTwinRow = await db.getRepository('latticeAiApprovalQueue').create({
    values: {
      organizationId: 'org-a',
      requesterUserId: 12,
      requesterUsername: 'disp12',
      aiEmployee: 'dxos-coordinator',
      toolName: 'dxos_twin_set_desired',
      targetCollection: 'latticeTwinShadows',
      targetRecordId: 202,
      operation: 'update',
      proposedArgs: { assetId: 103, assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:103', desiredPatch: { targetTempC: -22 } },
      riskLevel: 'high',
      status: 'pending',
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  Module._load = function (request, parent, isMain) {
    if (String(request).includes('digital-twin')) {
      return {
        requestDesiredSetpoint: async () => {
          throw Object.assign(new Error('ENCRYPTION_FIELD_KEY or APP_KEY must be set in production.'), {
            code: 'PKI_MASTER_KEY_MISSING',
            status: 500,
          });
        },
      };
    }
    return origLoad.call(this, request, parent, isMain);
  };
  try {
    await assert.rejects(
      () => actions.approveAction(makeCtx({ userId: 10, username: 'mgr10', roles: ['ldx_manager'], values: { approvalId: invTwinRow.id } }), async () => {}),
      (err) => err.code === 'PKI_MASTER_KEY_MISSING',
    );
  } finally {
    Module._load = origLoad;
  }
});

test('Fix Round 1 (Important 1): approveAction enforces fail-closed target-collection update ACL & reverts card to pending on 403', async () => {
  const { createDxosAiActions } = require(path.join(PLUGIN_ROOT, 'src/server/ai-resource.js'));
  const { runProactiveIncidentTriage } = require(path.join(PLUGIN_ROOT, 'src/server/proactive-triage.js'));

  // Case A: ldx_director only has grants on latticeServiceTickets (no WMS/Twin/Incident grants)
  const { db, store, makeCtx } = makeTriageHarness({ withRBACGrants: true });
  const actions = createDxosAiActions(db);
  await runProactiveIncidentTriage(db, { organizationId: 'org-a', actor: { userId: 12, username: 'disp12' } });

  const holdCard = store.latticeAiApprovalQueue.find((q) => q.toolName === 'dxos_wms_hold_lot');
  const twinCard = store.latticeAiApprovalQueue.find((q) => q.toolName === 'dxos_twin_set_desired');
  const alarmCard = store.latticeAiApprovalQueue.find((q) => q.toolName === 'dxos_alarm_action');

  for (const card of [holdCard, twinCard, alarmCard]) {
    await assert.rejects(
      () => actions.approveAction(makeCtx({
        userId: 11,
        username: 'dir11',
        roles: ['ldx_director'],
        values: { approvalId: card.id, note: 'Attempt without target ACL' },
      }), async () => {}),
      (err) => err.status === 403 && err.code === 'DXOS_ACL_DENIED',
    );
    const reloaded = store.latticeAiApprovalQueue.find((q) => q.id === card.id);
    assert.equal(reloaded.status, 'pending', `Card #${card.id} must revert to pending after 403 ACL denial`);
    assert.equal(reloaded.decidedByUserId, null);
    assert.equal(reloaded.decidedAt, null);
  }
  assert.equal(store.latticeStockLots.find((l) => l.id === 301).status, 'available');
  assert.equal(store.latticeTwinShadows.find((s) => s.id === 202).desiredJson.targetTempC, -18);
  assert.equal(store.latticeIncidentCases.find((a) => a.id === 1).status, 'open');

  // Case B: Empty dataSourcesRolesResources (withRBACGrants=false) fails closed (never fail-open!)
  const noAcl = makeTriageHarness({ withRBACGrants: false });
  const noAclActions = createDxosAiActions(noAcl.db);
  await runProactiveIncidentTriage(noAcl.db, { organizationId: 'org-a', actor: { userId: 12, username: 'disp12' } });
  const noAclHold = noAcl.store.latticeAiApprovalQueue.find((q) => q.toolName === 'dxos_wms_hold_lot');
  await assert.rejects(
    () => noAclActions.approveAction(noAcl.makeCtx({
      userId: 10,
      username: 'mgr10',
      roles: ['ldx_manager'],
      values: { approvalId: noAclHold.id },
    }), async () => {}),
    (err) => err.status === 403 && err.code === 'DXOS_ACL_DENIED',
  );
  assert.equal(noAcl.store.latticeAiApprovalQueue.find((q) => q.id === noAclHold.id).status, 'pending');

  // Case C: ctx.can returning false fails closed with 403 DXOS_ACL_DENIED even if DB grants exist
  const deniedCanCtx = makeCtx({
    userId: 10,
    username: 'mgr10',
    roles: ['ldx_manager'],
    values: { approvalId: holdCard.id },
  });
  deniedCanCtx.can = () => false;
  await assert.rejects(
    () => actions.approveAction(deniedCanCtx, async () => {}),
    (err) => err.status === 403 && err.code === 'DXOS_ACL_DENIED',
  );
  assert.equal(store.latticeAiApprovalQueue.find((q) => q.id === holdCard.id).status, 'pending');

  // Case D: Multi-role approver with empty currentRole picks approver role ('ldx_manager') and preserves verified currentRole
  noAcl.store.rolesUsers.push({ userId: 10, roleName: 'ldx_employee' });
  noAcl.store.roles.find((r) => r.name === 'ldx_manager').strategy = { actions: ['update'] };
  const multiRoleCtx = noAcl.makeCtx({
    userId: 10,
    username: 'mgr10',
    roles: ['ldx_employee', 'ldx_manager'],
    values: { approvalId: noAclHold.id },
  });
  multiRoleCtx.state.currentRole = '';
  await noAclActions.approveAction(multiRoleCtx, async () => {});
  assert.equal(multiRoleCtx.body.status, 'executed');

  // Case E: allowAll: true role passes ACL & verified currentRole ('ldx_director') is preserved into wmsActions.holdLotByMkt
  const allowAllHarness = makeTriageHarness({ withRBACGrants: false });
  allowAllHarness.store.rolesUsers.push({ userId: 11, roleName: 'ldx_manager' });
  allowAllHarness.store.roles.find((r) => r.name === 'ldx_director').allowAll = true;
  const allowAllActions = createDxosAiActions(allowAllHarness.db);
  await runProactiveIncidentTriage(allowAllHarness.db, { organizationId: 'org-a', actor: { userId: 12, username: 'disp12' } });
  const dirHold = allowAllHarness.store.latticeAiApprovalQueue.find((q) => q.toolName === 'dxos_wms_hold_lot');
  let seenWmsRole = null;
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (String(request).includes('wms-engine')) {
      return {
        createDxosWmsActions: () => ({
          holdLotByMkt: async (subCtx) => {
            seenWmsRole = subCtx.state.currentRole;
            subCtx.body = { held: true };
          },
        }),
      };
    }
    return origLoad.call(this, request, parent, isMain);
  };
  try {
    const dirCtx = allowAllHarness.makeCtx({
      userId: 11,
      username: 'dir11',
      roles: ['ldx_director', 'ldx_manager'],
      values: { approvalId: dirHold.id },
    });
    dirCtx.state.currentRole = 'ldx_director';
    await allowAllActions.approveAction(dirCtx, async () => {});
    assert.equal(dirCtx.body.status, 'executed');
    assert.equal(seenWmsRole, 'ldx_director');
  } finally {
    Module._load = origLoad;
  }
});

test('Fix Round 1 (Important 2): runProactiveIncidentTriage serializes concurrent Promise.all sweeps per org and queries PG advisory lock', async () => {
  const { runProactiveIncidentTriage } = require(path.join(PLUGIN_ROOT, 'src/server/proactive-triage.js'));
  const { db, store } = makeTriageHarness();

  // Inject async delay into latticeIncidentCases.find and latticeStockLots.find to force interleaving if unlocked
  const origGetRepo = db.getRepository.bind(db);
  db.getRepository = (name) => {
    const repo = origGetRepo(name);
    if (!repo) return repo;
    return {
      ...repo,
      find: async (opts) => {
        await new Promise((r) => setTimeout(r, 8));
        return repo.find(opts);
      },
    };
  };

  const results = await Promise.all([
    runProactiveIncidentTriage(db, { organizationId: 'org-a', actor: { userId: 12, username: 'disp12' } }),
    runProactiveIncidentTriage(db, { organizationId: 'org-a', actor: { userId: 12, username: 'disp12' } }),
    runProactiveIncidentTriage(db, { organizationId: 'org-a', actor: { userId: 12, username: 'disp12' } }),
  ]);

  assert.equal(store.latticeAiApprovalQueue.length, 3, 'Concurrent sweeps must produce ZERO duplicate HITL cards');
  const totalCreated = results.reduce((sum, r) => sum + r.proposalsCreated, 0);
  const totalSkipped = results.reduce((sum, r) => sum + r.deduplicatedSkipped, 0);
  assert.equal(totalCreated, 3);
  assert.equal(totalSkipped, 6);

  // Verify PostgreSQL advisory lock is acquired inside sequelize.transaction when dialect is postgres
  const pgQueries = [];
  const pgHarness = makeTriageHarness();
  pgHarness.db.sequelize = {
    getDialect: () => 'postgres',
    transaction: async (fn) => fn({ pgTx: true }),
    query: async (sql, opts) => {
      pgQueries.push({ sql, opts });
      return [[]];
    },
  };
  await runProactiveIncidentTriage(pgHarness.db, {
    organizationId: 'org-a',
    actor: { userId: 12, username: 'disp12' },
    alarmIds: [2],
  });
  assert.ok(
    pgQueries.some((q) => q.sql.includes('pg_advisory_xact_lock') && q.opts?.replacements?.lockKey === 'latticedx:triage:org-a'),
    'Must acquire tenant-scoped pg_advisory_xact_lock in postgres dialect',
  );
});

test('Fix Round 1 (Important 3): proactive-triage redacts CCCD, phone, email, and tokens while preserving ALM/LOT/ORD codes and URNs', async () => {
  const { runProactiveIncidentTriage } = require(path.join(PLUGIN_ROOT, 'src/server/proactive-triage.js'));
  const { db, store } = makeTriageHarness();

  store.latticeAssets = [
    {
      id: 109,
      code: '',
      name: 'Kho lạnh B9 liên hệ 0912345678 ops@coldchain.vn',
      entityId: 'urn:ngsi-ld:Asset:org-a:native:109',
      organizationId: 'org-a',
      status: 'active',
    },
  ];
  store.latticeStockLots = [
    {
      id: 309,
      organizationId: 'org-a',
      lotCode: 'LOT-PII-309',
      sku: 'VAC-09',
      assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:109',
      targetTempMaxC: -15,
      mktCelsius: -10,
      holdReason: 'Ghi chú cũ CCCD 079091009999 sk-secretLiveKey9988',
      status: 'available',
      active: true,
    },
  ];
  store.latticeOrderLines = [
    {
      id: 409,
      organizationId: 'org-a',
      orderId: 509,
      orderCode: 'ORD-PII-509',
      lotId: 309,
      lotCode: 'LOT-PII-309',
    },
  ];
  store.latticeOrders = [
    { id: 509, code: 'ORD-PII-509', organizationId: 'org-a', status: 'approved' },
  ];
  store.latticeIncidentCases = [
    {
      id: 91,
      code: 'ALM-PII-91',
      name: 'Sự cố quá nhiệt CCCD 079091001234 SĐT +84987654321 Bearer secretToken987654321',
      organizationId: 'org-a',
      assetId: 109,
      assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:109',
      severity: 'critical',
      status: 'open',
      proposal: '',
      resolutionNote: 'Liên hệ 0901234567',
    },
  ];

  const res = await runProactiveIncidentTriage(db, {
    organizationId: 'org-a',
    actor: { userId: 12, username: 'disp12' },
  });
  assert.equal(res.proposalsCreated, 1);

  const alarm = store.latticeIncidentCases.find((a) => a.id === 91);
  const card = store.latticeAiApprovalQueue[0];
  const serialized = JSON.stringify({ proposal: alarm.proposal, card });

  for (const leaked of ['079091001234', '079091009999', '0912345678', '84987654321', 'secretToken987654321', 'sk-secretLiveKey9988', 'ops@coldchain.vn']) {
    assert.equal(serialized.includes(leaked), false, `Raw PII/secret "${leaked}" must be stripped`);
  }
  assert.ok(serialized.includes('[REDACTED_CCCD]'));
  assert.ok(serialized.includes('[REDACTED_PHONE]'));
  assert.ok(serialized.includes('ALM-PII-91'), 'Business alarm code must be preserved');
  assert.ok(serialized.includes('LOT-PII-309'), 'Business lot code must be preserved');
  assert.ok(serialized.includes('ORD-PII-509'), 'Business order code must be preserved');
  assert.ok(serialized.includes('urn:ngsi-ld:Asset:org-a:native:109'), 'NGSI-LD URN must be preserved');
});

test('Fix Round 1 (Important 4): strict ID parsing, integrity checks, lastDeltaJson, merged temp bounds, and fallback transactions', async () => {
  const { createDxosAiActions } = require(path.join(PLUGIN_ROOT, 'src/server/ai-resource.js'));
  const { db, store, makeCtx } = makeTriageHarness();
  const actions = createDxosAiActions(db);

  const makePending = (overrides) => db.getRepository('latticeAiApprovalQueue').create({
    values: {
      organizationId: 'org-a',
      requesterUserId: 12,
      requesterUsername: 'disp12',
      aiEmployee: 'dxos-coordinator',
      operation: 'update',
      riskLevel: 'high',
      status: 'pending',
      expiresAt: new Date(Date.now() + 3600_000),
      ...overrides,
    },
  });

  // 1. Invalid IDs ('abc', -1, 1.5, 0) reject with 409 HITL_ARGS_MISMATCH
  for (const badId of ['abc', -1, 1.5, 0]) {
    const badLot = await makePending({
      toolName: 'dxos_wms_hold_lot',
      targetCollection: 'latticeStockLots',
      targetRecordId: null,
      proposedArgs: { lotId: badId, lotCode: 'LOT-VAC-301', organizationId: 'org-a', forceHold: true },
    });
    await assert.rejects(
      () => actions.approveAction(makeCtx({ userId: 10, username: 'mgr10', roles: ['ldx_manager'], values: { approvalId: badLot.id } }), async () => {}),
      (err) => err.status === 409 && err.code === 'HITL_ARGS_MISMATCH',
    );

    const badAlarm = await makePending({
      toolName: 'dxos_alarm_action',
      targetCollection: 'latticeIncidentCases',
      targetRecordId: null,
      proposedArgs: { action: 'ack', alarmId: badId, alarmCode: 'ALM-MED-1' },
    });
    await assert.rejects(
      () => actions.approveAction(makeCtx({ userId: 10, username: 'mgr10', roles: ['ldx_manager'], values: { approvalId: badAlarm.id } }), async () => {}),
      (err) => err.status === 409 && err.code === 'HITL_ARGS_MISMATCH',
    );

    const badTwin = await makePending({
      toolName: 'dxos_twin_set_desired',
      targetCollection: 'latticeTwinShadows',
      targetRecordId: null,
      proposedArgs: { assetId: badId, desiredPatch: { targetTempC: -20 } },
    });
    await assert.rejects(
      () => actions.approveAction(makeCtx({ userId: 10, username: 'mgr10', roles: ['ldx_manager'], values: { approvalId: badTwin.id } }), async () => {}),
      (err) => err.status === 409 && err.code === 'HITL_ARGS_MISMATCH',
    );
  }

  // 2. executeTwinSetpointApproval: deleted targetRecordId -> 404 SHADOW_NOT_FOUND; mismatched assetId -> 409
  const missingShadowRow = await makePending({
    toolName: 'dxos_twin_set_desired',
    targetCollection: 'latticeTwinShadows',
    targetRecordId: 99999,
    proposedArgs: { assetId: 103, desiredPatch: { targetTempC: -20 } },
  });
  await assert.rejects(
    () => actions.approveAction(makeCtx({ userId: 10, username: 'mgr10', roles: ['ldx_manager'], values: { approvalId: missingShadowRow.id } }), async () => {}),
    (err) => err.status === 404 && err.code === 'SHADOW_NOT_FOUND',
  );

  const mismatchedAssetTwin = await makePending({
    toolName: 'dxos_twin_set_desired',
    targetCollection: 'latticeTwinShadows',
    targetRecordId: 202,
    proposedArgs: { assetId: 102, desiredPatch: { targetTempC: -20 } },
  });
  await assert.rejects(
    () => actions.approveAction(makeCtx({ userId: 10, username: 'mgr10', roles: ['ldx_manager'], values: { approvalId: mismatchedAssetTwin.id } }), async () => {}),
    (err) => err.status === 409 && err.code === 'HITL_ARGS_MISMATCH',
  );

  // 3. executeWmsHoldLotApproval: lotId + mismatched lotCode throws 409 BEFORE calling wmsActions.holdLotByMkt
  let wmsCalled = false;
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (String(request).includes('wms-engine')) {
      return {
        createDxosWmsActions: () => ({
          holdLotByMkt: async () => { wmsCalled = true; },
        }),
      };
    }
    return origLoad.call(this, request, parent, isMain);
  };
  try {
    const mismatchLotRow = await makePending({
      toolName: 'dxos_wms_hold_lot',
      targetCollection: 'latticeStockLots',
      targetRecordId: 301,
      proposedArgs: { lotId: 301, lotCode: 'LOT-WRONG-999', organizationId: 'org-a', forceHold: true },
    });
    await assert.rejects(
      () => actions.approveAction(makeCtx({ userId: 10, username: 'mgr10', roles: ['ldx_manager'], values: { approvalId: mismatchLotRow.id } }), async () => {}),
      (err) => err.status === 409 && err.code === 'HITL_ARGS_MISMATCH',
    );
    assert.equal(wmsCalled, false, 'wmsActions.holdLotByMkt must NOT be called when lotCode mismatches lotId');
  } finally {
    Module._load = origLoad;
  }

  // 4. Standalone fallback: merged minTempC > maxTempC rejected, lastDeltaJson updated, and db.sequelize.transaction used
  store.latticeTwinShadows.find((s) => s.id === 202).desiredJson = { targetTempC: -18, maxTempC: -15 };
  let txCount = 0;
  const origTx = db.sequelize.transaction;
  db.sequelize.transaction = async (fn) => {
    txCount += 1;
    return origTx(fn);
  };
  Module._load = function (request, parent, isMain) {
    if (String(request).includes('digital-twin') || String(request).includes('wms-engine') || String(request).includes('alarm-engine')) {
      throw Object.assign(new Error(`Cannot find module '${request}'`), { code: 'MODULE_NOT_FOUND' });
    }
    return origLoad.call(this, request, parent, isMain);
  };
  try {
    const badMergedTemp = await makePending({
      toolName: 'dxos_twin_set_desired',
      targetCollection: 'latticeTwinShadows',
      targetRecordId: 202,
      proposedArgs: { assetId: 103, desiredPatch: { minTempC: -10 } },
    });
    await assert.rejects(
      () => actions.approveAction(makeCtx({ userId: 10, username: 'mgr10', roles: ['ldx_manager'], values: { approvalId: badMergedTemp.id } }), async () => {}),
      (err) => err.status === 400 && err.code === 'TWIN_DESIRED_INVALID',
    );

    const validTwinFb = await makePending({
      toolName: 'dxos_twin_set_desired',
      targetCollection: 'latticeTwinShadows',
      targetRecordId: 202,
      proposedArgs: { assetId: 103, desiredPatch: { targetTempC: -22 } },
    });
    const txBeforeTwin = txCount;
    await actions.approveAction(makeCtx({ userId: 10, username: 'mgr10', roles: ['ldx_manager'], values: { approvalId: validTwinFb.id } }), async () => {});
    assert.ok(txCount > txBeforeTwin, 'Twin fallback must run inside db.sequelize.transaction');
    const updated202 = store.latticeTwinShadows.find((s) => s.id === 202);
    assert.equal(updated202.lastDeltaJson.inSync, false);
    assert.equal(updated202.lastDeltaJson.fields.targetTempC.numericDelta, -10);

    const validAlarmFb = await makePending({
      toolName: 'dxos_alarm_action',
      targetCollection: 'latticeIncidentCases',
      targetRecordId: 1,
      proposedArgs: { action: 'ack', alarmId: 1, note: 'Fallback ack tx' },
    });
    const txBeforeAlarm = txCount;
    await actions.approveAction(makeCtx({ userId: 10, username: 'mgr10', roles: ['ldx_manager'], values: { approvalId: validAlarmFb.id } }), async () => {});
    assert.ok(txCount > txBeforeAlarm, 'Alarm fallback must run inside db.sequelize.transaction');
    assert.equal(store.latticeIncidentCases.find((a) => a.id === 1).status, 'acknowledged');
  } finally {
    Module._load = origLoad;
    db.sequelize.transaction = origTx;
  }
});

test('Fix Round 1 (Minor 2-5): entityId backfill, dispatched/ack skip, null-targetRecordId dedup symmetry, alarmIds bounds, and Tab 6 UI filter switch', async () => {
  const { buildTriageRecommendation, runProactiveIncidentTriage } = require(path.join(PLUGIN_ROOT, 'src/server/proactive-triage.js'));
  const { createDxosAiStudioPage } = require(path.join(PLUGIN_ROOT, 'src/client/ai-studio-page.js'));
  const { db, store } = makeTriageHarness();

  // Minor 2: assetEntityId backfilled from latticeAssets.entityId matches telemetry & custom entity lots
  store.latticeAssets.push({
    id: 104,
    code: 'CH-104',
    name: 'Kho tùy chỉnh',
    entityId: 'urn:ngsi-ld:Asset:org-a:custom-ch104',
    organizationId: 'org-a',
    status: 'active',
  });
  store.latticeTelemetryPoints.push({
    id: 701,
    organizationId: 'org-a',
    assetEntityId: 'urn:ngsi-ld:Asset:org-a:custom-ch104',
    metricName: 'temperature',
    numericValue: -9.5,
    observedAt: new Date().toISOString(),
  });
  store.latticeIncidentCases = [
    {
      id: 41,
      code: 'ALM-BACKFILL-41',
      name: 'Nhiệt độ tăng cao',
      organizationId: 'org-a',
      assetId: 104,
      assetEntityId: '',
      severity: 'high',
      status: 'open',
      proposal: '',
    },
  ];
  const backfillRes = await runProactiveIncidentTriage(db, {
    organizationId: 'org-a',
    actor: { userId: 12, username: 'disp12' },
    dryRun: true,
  });
  assert.equal(backfillRes.proposals.length, 1);
  assert.ok(backfillRes.proposals[0].causalSummary.includes('-9.5°C'));
  assert.equal(backfillRes.proposals[0].proposedArgs.assetEntityId, 'urn:ngsi-ld:Asset:org-a:custom-ch104');

  // Minor 3: skip twin setpoint while commandStatus='dispatched' AND skip redundant 'ack' when alarm.status='acknowledged'
  const skippedRec = buildTriageRecommendation({
    alarm: { id: 51, code: 'ALM-ACK-51', name: 'Trôi setpoint', organizationId: 'org-a', status: 'acknowledged', severity: 'high' },
    shadow: { id: 205, organizationId: 'org-a', assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:105', commandStatus: 'dispatched', desiredJson: { targetTempC: -20 } },
    stockLots: [],
  });
  assert.equal(skippedRec, null, 'Dispatched shadow + acknowledged alarm with no other actions must return null');

  // Minor 4a: explicit empty / invalid alarmIds matches 0 instead of scanning all; >50 ids capped cleanly
  const emptyIdsRes = await runProactiveIncidentTriage(db, {
    organizationId: 'org-a',
    actor: { userId: 12, username: 'disp12' },
    alarmIds: [],
  });
  assert.equal(emptyIdsRes.scannedCount, 0);
  const invalidIdsRes = await runProactiveIncidentTriage(db, {
    organizationId: 'org-a',
    actor: { userId: 12, username: 'disp12' },
    alarmIds: [-1, 'bad'],
  });
  assert.equal(invalidIdsRes.scannedCount, 0);

  store.latticeIncidentCases.push(
    { id: 1001, code: 'ALM-CAP-1', name: 'In cap', organizationId: 'org-a', severity: 'medium', status: 'open', proposal: '' },
    { id: 1060, code: 'ALM-CAP-60', name: 'Beyond cap', organizationId: 'org-a', severity: 'medium', status: 'open', proposal: '' },
  );
  const cappedIds = Array.from({ length: 65 }, (_, i) => 1001 + i);
  const cappedRes = await runProactiveIncidentTriage(db, {
    organizationId: 'org-a',
    actor: { userId: 12, username: 'disp12' },
    alarmIds: cappedIds,
    dryRun: true,
  });
  assert.deepEqual(cappedRes.proposals.map((p) => p.alarmId), [1001], 'alarmIds must be capped at 50 entries');

  // Minor 4b: null-targetRecordId dedup symmetry intra-sweep and cross-sweep on unshadowed assetEntityId
  store.latticeIncidentCases = [
    {
      id: 61,
      code: 'ALM-UNSHAD-61',
      name: 'Nhiệt độ tăng kho 106',
      organizationId: 'org-a',
      assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:106',
      severity: 'high',
      status: 'open',
      proposal: '',
    },
    {
      id: 62,
      code: 'ALM-UNSHAD-62',
      name: 'Nhiệt độ tăng kho 106 lần 2',
      organizationId: 'org-a',
      assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:106',
      severity: 'medium',
      status: 'open',
      proposal: '',
    },
  ];
  const unshadSweep1 = await runProactiveIncidentTriage(db, {
    organizationId: 'org-a',
    actor: { userId: 12, username: 'disp12' },
  });
  assert.equal(unshadSweep1.proposalsCreated, 1);
  assert.equal(unshadSweep1.deduplicatedSkipped, 1);

  const unshadSweep2 = await runProactiveIncidentTriage(db, {
    organizationId: 'org-a',
    actor: { userId: 12, username: 'disp12' },
    alarmIds: [62],
  });
  assert.equal(unshadSweep2.proposalsCreated, 0);
  assert.equal(unshadSweep2.deduplicatedSkipped, 1, 'Cross-sweep dedup must match intra-sweep dedup when targetRecordId is null');

  // Minor 5: ai-studio-page switches approvalStatusFilter to 'pending' on new triage proposals & handles duplicate/empty change fields
  const stateSlots = [];
  const effectSlots = [];
  const memoSlots = [];
  let sIdx = 0;
  let eIdx = 0;
  let mIdx = 0;
  const listFilters = [];
  const depsChanged = (p, n) => !p || !n || p.length !== n.length || n.some((d, i) => d !== p[i]);
  const ReactMock = {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (init) => {
      const i = sIdx++;
      if (!(i in stateSlots)) stateSlots[i] = typeof init === 'function' ? init() : init;
      return [stateSlots[i], (v) => { stateSlots[i] = typeof v === 'function' ? v(stateSlots[i]) : v; }];
    },
    useRef: (init) => ({ current: init }),
    useEffect: (fn, deps) => {
      const i = eIdx++;
      effectSlots[i] = { fn, deps, changed: depsChanged(effectSlots[i]?.deps, deps) };
    },
    useMemo: (fn, deps) => {
      const i = mIdx++;
      if (!memoSlots[i] || depsChanged(memoSlots[i].deps, deps)) memoSlots[i] = { value: fn(), deps };
      return memoSlots[i].value;
    },
    useCallback: (fn, deps) => {
      const i = mIdx++;
      if (!memoSlots[i] || depsChanged(memoSlots[i].deps, deps)) memoSlots[i] = { value: fn, deps };
      return memoSlots[i].value;
    },
  };
  const api = {
    request: async (req) => {
      if (req.url === 'dxosAi:listApprovals') {
        listFilters.push(req.params?.status);
        return {
          data: {
            data: {
              items: [{
                id: 901,
                targetCollection: 'latticeStockLots',
                operation: 'update',
                toolName: 'dxos_wms_hold_lot',
                status: 'pending',
                diffPreview: { changes: [{ field: '', before: null, after: 'a' }, { field: '', before: 'a', after: 'b' }] },
              }],
            },
          },
        };
      }
      if (req.url === 'dxosAi:triageScan') return { data: { data: { scannedCount: 1, proposalsCreated: 1, deduplicatedSkipped: 0 } } };
      return { data: { data: { profiles: [], catalog: { availableTools: [] } } } };
    },
  };
  const Page = createDxosAiStudioPage({ useAPIClient: () => api }, ReactMock, {}, {});
  const render = () => {
    sIdx = 0; eIdx = 0; mIdx = 0;
    const t = Page();
    for (const fx of effectSlots) { if (fx.changed) { fx.changed = false; fx.fn(); } }
    return t;
  };
  const findAll = (n, pred, acc = []) => {
    if (!n || typeof n !== 'object') return acc;
    if (pred(n)) acc.push(n);
    const kids = Array.isArray(n.children) ? n.children.flat(Infinity) : [];
    for (const k of kids) findAll(k, pred, acc);
    return acc;
  };
  let tree = render();
  findAll(tree, (n) => n.type === 'button' && n.children?.includes('6. Duyệt AI (HITL)'))[0].props.onClick();
  tree = render();
  const statusSelect = findAll(tree, (n) => n.type === 'select' && n.props?.['data-testid'] === 'dxos-hitl-status-filter')[0];
  statusSelect.props.onChange({ target: { value: 'executed' } });
  tree = render();
  const triageBtn = findAll(tree, (n) => n.type === 'button' && n.props?.['data-testid'] === 'dxos-ai-triage-scan-btn')[0];
  await triageBtn.props.onClick();
  tree = render();
  const statusSelectAfter = findAll(tree, (n) => n.type === 'select' && n.props?.['data-testid'] === 'dxos-hitl-status-filter')[0];
  assert.equal(statusSelectAfter.props.value, 'pending', 'Must switch filter back to pending when new proposals are created');
  assert.equal(listFilters[listFilters.length - 1], 'pending');
  const changeRows = findAll(tree, (n) => n.type === 'div' && n.props?.style?.fontFamily === 'monospace');
  assert.equal(changeRows.length, 2);
  assert.equal(changeRows[0].props.key, 0);
  assert.equal(changeRows[1].props.key, 1);
});

test('Live Postgres schema guard: skips latticeAssets.entityId SQL filter when column is absent and correlates lot:* incidents', async () => {
  const { runProactiveIncidentTriage } = require(path.join(PLUGIN_ROOT, 'src/server/proactive-triage.js'));
  const { db, store } = makeTriageHarness();

  // Simulate NocoBase PostgreSQL schema where latticeAssets does NOT define an entityId column
  db.getCollection = (name) => {
    if (name === 'latticeAssets') {
      return {
        hasField: (field) => field !== 'entityId',
        getField: (field) => (field === 'entityId' ? null : { name: field }),
      };
    }
    return null;
  };
  const baseAssetRepo = db.getRepository('latticeAssets');
  const origGetRepo = db.getRepository.bind(db);
  db.getRepository = (name) => {
    if (name !== 'latticeAssets') return origGetRepo(name);
    return {
      ...baseAssetRepo,
      async findOne(opts = {}) {
        if (opts?.filter && Object.prototype.hasOwnProperty.call(opts.filter, 'entityId')) {
          throw new Error('column latticeAssets.entityId does not exist');
        }
        return baseAssetRepo.findOne(opts);
      },
    };
  };

  store.latticeStockLots.push({
    id: 88,
    organizationId: 'org-a',
    lotCode: 'LOT-MKT-99',
    sku: 'SKU-VAC-99',
    status: 'hold_mkt',
    mktCelsius: 13.1,
    targetTempMaxC: 8,
    active: true,
  });
  store.latticeIncidentCases = [
    {
      id: 77,
      code: 'MKT-77',
      name: 'Cách ly lô vượt MKT: LOT-MKT-99',
      organizationId: 'org-a',
      assetId: null,
      assetEntityId: 'lot:LOT-MKT-99',
      severity: 'critical',
      status: 'open',
      proposal: '',
    },
  ];

  const res = await runProactiveIncidentTriage(db, {
    organizationId: 'org-a',
    actor: { userId: 12, username: 'disp12' },
    dryRun: true,
  });
  assert.equal(res.scannedCount, 1);
  assert.equal(res.proposals.length, 1);
  assert.ok(res.proposals[0].diffPreview?.affectedLots?.some((l) => l.lotCode === 'LOT-MKT-99'));
});
