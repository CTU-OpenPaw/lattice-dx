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
