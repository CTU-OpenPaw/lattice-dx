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
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');

function makeAlarmAndTsHarness() {
  let seq = 100;
  const incidents = [];
  const assets = [
    { id: 12, code: 'COLD-A1', name: 'Kho lạnh Vaccine A1', organizationId: 'org-a', status: 'warning', custodianId: 5 },
    { id: 99, code: 'COLD-B1', name: 'Kho B', organizationId: 'org-b', status: 'ok', custodianId: 99 },
  ];
  const inbox = [
    { id: 1, organizationId: 'org-a', kind: 'ngsi-ld-notification', observedAt: '2026-11-22T01:00:00Z', data: { entityId: 'urn:ngsi-ld:Asset:org-a:native:12', attribute: 'temperature', value: -18.4, unit: 'CEL' } },
    { id: 2, organizationId: 'org-a', kind: 'ngsi-ld-notification', observedAt: '2026-11-22T02:00:00Z', data: { entityId: 'urn:ngsi-ld:Asset:org-a:native:12', attribute: 'temperature', value: -14.2, unit: 'CEL' } },
    { id: 3, organizationId: 'org-a', kind: 'ngsi-ld-notification', observedAt: '2026-11-22T03:00:00Z', data: { entityId: 'urn:ngsi-ld:Asset:org-a:native:12', attribute: 'temperature', value: -11.5, unit: 'CEL' } },
    { id: 4, organizationId: 'org-b', kind: 'ngsi-ld-notification', observedAt: '2026-11-22T03:00:00Z', data: { entityId: 'urn:ngsi-ld:Asset:org-b:native:99', attribute: 'temperature', value: 99, unit: 'CEL' } },
  ];
  const employees = [
    { id: 5, userId: 50, organizationId: 'org-a', active: true },
    { id: 8, userId: 80, organizationId: 'org-b', active: true },
  ];
  const db = {
    getRepository(name) {
      if (name === 'latticeEmployees') return { find: async ({ filter }) => employees.filter((e) => Number(e.userId) === Number(filter?.userId)) };
      if (name === 'roles') return { findOne: async () => ({ name: 'ldx_manager', allowAll: false, strategy: { actions: [] } }) };
      if (name === 'dataSourcesRolesResources') {
        return {
          findOne: async ({ filter }) => ({
            roleName: filter.roleName,
            name: filter.name,
            usingActionsConfig: true,
            actions: [{ name: 'view' }, { name: 'list' }, { name: 'create' }, { name: 'update' }],
          }),
        };
      }
      if (name === 'latticeAssets') {
        return {
          findOne: async ({ filter }) => assets.find((a) => (!filter?.id || Number(a.id) === Number(filter.id)) && (!filter?.organizationId || a.organizationId === filter.organizationId)) || null,
          find: async ({ filter }) => assets.filter((a) => !filter?.organizationId || a.organizationId === filter.organizationId),
        };
      }
      if (name === 'latticeIntegrationInbox') {
        return {
          find: async ({ filter }) => inbox.filter((r) => !filter?.organizationId || r.organizationId === filter.organizationId),
        };
      }
      if (name === 'latticeIncidentCases') {
        const matchFilter = (row, filter = {}) => Object.entries(filter).every(([k, cond]) => {
          if (cond && typeof cond === 'object' && Array.isArray(cond.$in)) return cond.$in.includes(row[k]);
          return row[k] === cond;
        });
        return {
          find: async ({ filter }) => incidents.filter((r) => matchFilter(r, filter)),
          findOne: async ({ filter, filterByTk }) => {
            if (filterByTk != null) return incidents.find((r) => Number(r.id) === Number(filterByTk)) || null;
            return incidents.find((r) => matchFilter(r, filter)) || null;
          },
          create: async ({ values }) => {
            const row = {
              id: ++seq,
              ...values,
              update: async (patch) => Object.assign(row, patch),
            };
            incidents.push(row);
            return row;
          },
        };
      }
      return null;
    },
  };
  return { db, incidents };
}

test('alarm deduplication coalesces repeated triggers while open/acknowledged, supports Ack -> Clear, and resets after Clear', async () => {
  const {
    computeAlarmFingerprint,
    ingestOrDeduplicateAlarm,
    acknowledgeAlarm,
    clearAlarm,
  } = require(path.join(PLUGIN_ROOT, 'src/server/alarm-engine.js'));

  const fpA = computeAlarmFingerprint({ organizationId: 'org-a', assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12', ruleCode: 'TEMP-HIGH', attribute: 'temperature' });
  const fpB = computeAlarmFingerprint({ organizationId: 'org-b', assetEntityId: 'urn:ngsi-ld:Asset:org-b:native:99', ruleCode: 'TEMP-HIGH', attribute: 'temperature' });
  assert.equal(fpA.length, 64);
  assert.notEqual(fpA, fpB);

  const { db, incidents } = makeAlarmAndTsHarness();

  const first = await ingestOrDeduplicateAlarm(db, {
    organizationId: 'org-a',
    assetId: 12,
    assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12',
    ruleCode: 'TEMP-HIGH',
    attribute: 'temperature',
    severity: 'high',
    summary: 'Nhiệt độ -14.2°C vượt -15°C',
    handlerId: '5',
  });
  assert.equal(first.deduplicated, false);
  assert.equal(first.occurrenceCount, 1);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].status, 'open');

  // Second and third triggers deduplicate cleanly into the same active case
  const second = await ingestOrDeduplicateAlarm(db, {
    organizationId: 'org-a',
    assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12',
    ruleCode: 'TEMP-HIGH',
    attribute: 'temperature',
    severity: 'critical',
    summary: 'Nhiệt độ -11.5°C tăng tiếp',
  });
  assert.equal(second.deduplicated, true);
  assert.equal(second.id, first.id);
  assert.equal(second.occurrenceCount, 2);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].severity, 'critical');

  // Ack transition
  const acked = await acknowledgeAlarm(db, { id: first.id, organizationId: 'org-a', actorName: 'mgr50', note: 'Đã cử kỹ thuật kiểm tra' });
  assert.equal(acked.status, 'acknowledged');
  assert.equal(acked.acknowledgedBy, 'mgr50');
  assert.ok(acked.acknowledgedAt);

  // Trigger while acknowledged STILL deduplicates
  const third = await ingestOrDeduplicateAlarm(db, {
    organizationId: 'org-a',
    assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12',
    ruleCode: 'TEMP-HIGH',
    attribute: 'temperature',
  });
  assert.equal(third.deduplicated, true);
  assert.equal(third.occurrenceCount, 3);

  // Clear transition
  const cleared = await clearAlarm(db, { id: first.id, organizationId: 'org-a', actorName: 'mgr50', closeNote: 'Nhiệt độ trở lại -19°C' });
  assert.equal(cleared.status, 'closed');
  assert.equal(cleared.clearedBy, 'mgr50');

  // Re-clearing fails closed 409
  await assert.rejects(
    () => clearAlarm(db, { id: first.id, organizationId: 'org-a', actorName: 'mgr50' }),
    (err) => err.status === 409 && err.code === 'ALARM_ALREADY_CLEARED',
  );

  // Fresh trigger after Clear opens a NEW incident
  const fresh = await ingestOrDeduplicateAlarm(db, {
    organizationId: 'org-a',
    assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12',
    ruleCode: 'TEMP-HIGH',
    attribute: 'temperature',
  });
  assert.equal(fresh.deduplicated, false);
  assert.equal(fresh.occurrenceCount, 1);
  assert.equal(incidents.length, 2);
});

test('dxosBlocks:telemetrySeries and alarmAck/alarmClear enforce org boundaries and compute sorted time-series stats', async () => {
  const { createDxosBlocksActions } = require(path.join(PLUGIN_ROOT, 'src/server/blocks-api.js'));
  const { db } = makeAlarmAndTsHarness();
  const actions = createDxosBlocksActions(db, {});

  assert.equal(typeof actions.telemetrySeries, 'function');
  assert.equal(typeof actions.alarmIngest, 'function');
  assert.equal(typeof actions.alarmAck, 'function');
  assert.equal(typeof actions.alarmClear, 'function');

  // Foreign org asset denied 403
  const crossCtx = {
    method: 'POST',
    state: { currentUser: { id: 50, username: 'u50' }, currentRole: 'ldx_manager' },
    action: { params: { assetEntityId: 'urn:ngsi-ld:Asset:org-b:native:99' } },
  };
  await assert.rejects(() => actions.telemetrySeries(crossCtx, async () => {}), (err) => err.status === 403);

  // Ingest an alarm first
  const ingestCtx = {
    method: 'POST',
    state: { currentUser: { id: 50, username: 'u50' }, currentRole: 'ldx_manager' },
    action: { params: { values: { assetId: 12, ruleCode: 'COLD-WARN', attribute: 'temperature', severity: 'high', summary: 'Vượt ngưỡng lạnh' } } },
  };
  await actions.alarmIngest(ingestCtx, async () => {});
  assert.equal(ingestCtx.body.occurrenceCount, 1);

  const tsCtx = {
    method: 'POST',
    state: { currentUser: { id: 50, username: 'u50' }, currentRole: 'ldx_manager' },
    action: { params: { values: { assetId: 12, attribute: 'temperature', limit: 20 } } },
  };
  await actions.telemetrySeries(tsCtx, async () => {});
  assert.equal(tsCtx.body.points.length, 3);
  assert.equal(tsCtx.body.points[0].value, -18.4);
  assert.equal(tsCtx.body.points[2].value, -11.5);
  assert.equal(tsCtx.body.stats.latest, -11.5);
  assert.equal(tsCtx.body.stats.min, -18.4);
  assert.equal(tsCtx.body.stats.max, -11.5);
  assert.equal(tsCtx.body.activeAlarms.length, 1);

  // Cross-org Ack blocked cleanly
  await assert.rejects(
    () => actions.alarmAck({
      method: 'POST',
      state: { currentUser: { id: 80, username: 'u80' }, currentRole: 'ldx_manager' },
      action: { params: { values: { id: ingestCtx.body.id } } },
    }, async () => {}),
    (err) => err.status === 404 || err.status === 403,
  );
});

test('creative-studio-block supports timeseries-line SVG chart (0, 1, N points) with threshold line and Ack/Clear controls', () => {
  const { parseCreativeBlueprint, createCreativeStudioView } = require(path.join(PLUGIN_ROOT, 'src/client/creative-studio-block.js'));

  const bp = parseCreativeBlueprint(JSON.stringify({
    title: 'Kho lạnh 24h',
    theme: 'industrial-cockpit',
    queries: [{ id: 'ts', kind: 'timeseries', assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12', limit: 24 }],
    widgets: [{ type: 'timeseries-line', title: 'Lịch sử Nhiệt độ 24h', queryId: 'ts', warningThreshold: -15, criticalThreshold: -12, unit: '°C' }],
  }));
  assert.equal(bp.queries.length, 1);
  assert.equal(bp.queries[0].kind, 'timeseries');
  assert.equal(bp.widgets.length, 1);
  assert.equal(bp.widgets[0].type, 'timeseries-line');

  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (init) => {
      const v = typeof init === 'function' ? init() : init;
      if (v && typeof v === 'object' && Object.hasOwn(v, 'results')) {
        return [{
          loading: false,
          results: {
            ts: {
              points: [{ timestamp: '2026-11-22T01:00:00Z', value: -18 }, { timestamp: '2026-11-22T02:00:00Z', value: -11 }],
              stats: { count: 2, min: -18, max: -11, avg: -14.5, latest: -11 },
              activeAlarms: [{ id: 101, code: 'ALM-101', status: 'open', occurrenceCount: 3, severity: 'critical' }],
            },
          },
          error: '',
        }, () => {}];
      }
      return [v, () => {}];
    },
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
  };
  const View = createCreativeStudioView({ useAPIClient: () => ({ request: async () => ({ data: {} }) }) }, React, {}, {});
  const tree = View({ model: { props: { blueprintJson: JSON.stringify({ queries: [{ id: 'ts', kind: 'timeseries' }], widgets: [{ type: 'timeseries-line', title: 'Nhiệt độ 24h', queryId: 'ts', warningThreshold: -15, criticalThreshold: -12, unit: '°C' }] }) } } });
  const dump = JSON.stringify(tree);
  assert.ok(dump.includes('dxos-timeseries-line-widget'));
  assert.ok(dump.includes('"polyline"'));
  assert.ok(dump.includes('Xác nhận (Ack)'));
  assert.ok(dump.includes('Đóng (Clear)'));
  assert.equal(dump.includes('NaN'), false);
});

test('migration 20261122000700 adds alarm deduplication columns reversibly', () => {
  const src = readFileSync(path.resolve(PLUGIN_ROOT, '../plugin-lattice-foundation/src/server/migrations/20261122000700-incident-alarm-dedup-columns.js'), 'utf8');
  assert.match(src, /\bup\s*\(/);
  assert.match(src, /\bdown\s*\(/);
  assert.match(src, /idx_lattice_incident_cases_dedup/);
});

test('clearAlarm supplies default audit closeNote, clamps to 255 chars, and satisfies validateIncidentNotes', async () => {
  const {
    ingestOrDeduplicateAlarm,
    clearAlarm,
  } = require(path.join(PLUGIN_ROOT, 'src/server/alarm-engine.js'));
  const { validateIncidentNotes } = require(path.resolve(PLUGIN_ROOT, '../plugin-lattice-foundation/src/server/native-identity-hooks.js'));
  const { db } = makeAlarmAndTsHarness();

  const a1 = await ingestOrDeduplicateAlarm(db, {
    organizationId: 'org-a',
    assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12',
    ruleCode: 'EMPTY-NOTE-CHECK',
    attribute: 'temperature',
  });
  const clearedDefault = await clearAlarm(db, { id: a1.id, organizationId: 'org-a', actorName: 'op1' });
  assert.equal(clearedDefault.status, 'closed');
  assert.ok(clearedDefault.closeNote && clearedDefault.closeNote.includes('op1'));
  assert.ok(clearedDefault.closeNote.length <= 255);
  assert.doesNotThrow(() => validateIncidentNotes(clearedDefault));

  const a2 = await ingestOrDeduplicateAlarm(db, {
    organizationId: 'org-a',
    assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12',
    ruleCode: 'LONG-NOTE-CHECK',
    attribute: 'temperature',
  });
  const clearedLong = await clearAlarm(db, {
    id: a2.id,
    organizationId: 'org-a',
    actorName: 'op1',
    closeNote: 'x'.repeat(400),
  });
  assert.equal(clearedLong.status, 'closed');
  assert.equal(clearedLong.closeNote.length, 255);
  assert.doesNotThrow(() => validateIncidentNotes(clearedLong));
});

test('alarm-engine uses crypto.randomBytes instead of Math.random for alarm codes', () => {
  const src = readFileSync(path.join(PLUGIN_ROOT, 'src/server/alarm-engine.js'), 'utf8');
  assert.equal(src.includes('Math.random'), false);
  assert.ok(src.includes('randomBytes'));
});

test('high/critical alarms emit org-scoped, 30m-deduped latticeNotifications and tolerate missing/failing notifications repo', async () => {
  const {
    computeAlarmFingerprint,
    ingestOrDeduplicateAlarm,
    notifyOrgOperatorsOnAlarm,
  } = require(path.join(PLUGIN_ROOT, 'src/server/alarm-engine.js'));

  assert.equal(typeof notifyOrgOperatorsOnAlarm, 'function');

  // Ensure zero cross-plugin filesystem require in alarm-engine.js
  const engineSrc = readFileSync(path.join(PLUGIN_ROOT, 'src/server/alarm-engine.js'), 'utf8');
  assert.equal(/require\([^)]*plugin-lattice-foundation/.test(engineSrc), false);
  assert.equal(/require\(['"]\.\.\//.test(engineSrc), false);

  let incidentSeq = 200;
  let notifSeq = 1;
  const incidents = [];
  const notifications = [];
  const employees = [
    { id: 11, userId: 101, organizationId: 'org-a', active: true },
    { id: 12, userId: 102, organizationId: 'org-a', active: true },
    { id: 13, userId: 103, organizationId: 'org-a', active: false },
    { id: 21, userId: 201, organizationId: 'org-b', active: true },
  ];

  const matchFilter = (row, filter = {}) => Object.entries(filter).every(([k, cond]) => {
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      if (Array.isArray(cond.$in)) return cond.$in.includes(row[k]);
      if (cond.$gt !== undefined) {
        const rowTs = row[k] instanceof Date ? row[k].getTime() : Date.parse(String(row[k]));
        const cmpTs = cond.$gt instanceof Date ? cond.$gt.getTime() : Date.parse(String(cond.$gt));
        return Number.isFinite(rowTs) && Number.isFinite(cmpTs) ? rowTs > cmpTs : row[k] > cond.$gt;
      }
    }
    return row[k] === cond;
  });

  const db = {
    getRepository(name) {
      if (name === 'latticeEmployees') {
        return { find: async ({ filter = {} } = {}) => employees.filter((e) => matchFilter(e, filter)) };
      }
      if (name === 'latticeIncidentCases') {
        return {
          find: async ({ filter = {} } = {}) => incidents.filter((r) => matchFilter(r, filter)),
          findOne: async ({ filter = {}, filterByTk } = {}) => {
            if (filterByTk != null) return incidents.find((r) => Number(r.id) === Number(filterByTk)) || null;
            return incidents.find((r) => matchFilter(r, filter)) || null;
          },
          create: async ({ values }) => {
            const row = { id: ++incidentSeq, ...values, update: async (patch) => Object.assign(row, patch) };
            incidents.push(row);
            return row;
          },
        };
      }
      if (name === 'latticeNotifications') {
        return {
          find: async ({ filter = {} } = {}) => notifications.filter((r) => matchFilter(r, filter)),
          create: async ({ values }) => {
            const row = { id: notifSeq++, createdAt: new Date(), ...values };
            notifications.push(row);
            return row;
          },
        };
      }
      return null;
    },
  };

  // 1. Medium severity must NOT emit notifications
  const medAlarm = await ingestOrDeduplicateAlarm(db, {
    organizationId: 'org-a',
    assetId: 12,
    assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12',
    ruleCode: 'TEMP-DRIFT',
    attribute: 'temperature',
    severity: 'medium',
    summary: 'Nhiệt độ tăng nhẹ',
  });
  assert.equal(notifications.length, 0);

  // 2. Escalation from medium -> high MUST emit notifications ONLY to active org-a operators
  const escAlarm = await ingestOrDeduplicateAlarm(db, {
    organizationId: 'org-a',
    assetId: 12,
    assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12',
    ruleCode: 'TEMP-DRIFT',
    attribute: 'temperature',
    severity: 'high',
    summary: 'Nhiệt độ vượt ngưỡng cao',
  });
  assert.equal(escAlarm.id, medAlarm.id);
  assert.equal(escAlarm.severity, 'high');
  assert.equal(notifications.length, 2);

  const expectedFp = computeAlarmFingerprint({
    organizationId: 'org-a',
    assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12',
    ruleCode: 'TEMP-DRIFT',
    attribute: 'temperature',
  });
  assert.deepEqual(notifications.map((n) => n.recipientUserId).sort(), [101, 102]);
  assert.deepEqual(notifications.map((n) => n.recipientEmployeeId).sort(), [11, 12]);
  for (const n of notifications) {
    assert.equal(n.organizationId, 'org-a');
    assert.equal(n.category, 'alarm');
    assert.equal(n.severity, 'high');
    assert.ok(n.title && n.title.length > 0);
    assert.ok(n.body && n.body.length > 0);
    assert.equal(n.targetCollection, 'latticeIncidentCases');
    assert.equal(n.targetRecordId, escAlarm.id);
    assert.equal(n.targetPath, '/p/incidents');
    assert.equal(n.dedupKey, `alarm:${expectedFp}`);
  }

  // 3. Escalation to critical within 30m MUST deduplicate per (organizationId, recipientUserId, dedupKey)
  await ingestOrDeduplicateAlarm(db, {
    organizationId: 'org-a',
    assetId: 12,
    assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12',
    ruleCode: 'TEMP-DRIFT',
    attribute: 'temperature',
    severity: 'critical',
    summary: 'Nhiệt độ quá giới hạn',
  });
  assert.equal(notifications.length, 2);

  // 4. After 30m window expires, notifyOrgOperatorsOnAlarm emits fresh rows
  for (const n of notifications) {
    n.createdAt = new Date(Date.now() - 31 * 60 * 1000);
  }
  await notifyOrgOperatorsOnAlarm(db, incidents[0]);
  assert.equal(notifications.length, 4);

  // 5. New critical alarm for org-b notifies ONLY org-b active operators
  const orgBAlarm = await ingestOrDeduplicateAlarm(db, {
    organizationId: 'org-b',
    assetId: 99,
    assetEntityId: 'urn:ngsi-ld:Asset:org-b:native:99',
    ruleCode: 'POWER-LOSS',
    attribute: 'voltage',
    severity: 'critical',
    summary: 'Mất nguồn kho B',
  });
  const orgBNotifs = notifications.filter((n) => n.organizationId === 'org-b');
  assert.equal(orgBNotifs.length, 1);
  assert.equal(orgBNotifs[0].recipientUserId, 201);
  assert.equal(orgBNotifs[0].targetRecordId, orgBAlarm.id);
  assert.equal(orgBNotifs[0].severity, 'critical');

  // 6. Non-fatal when latticeNotifications repo throws (e.g. table does not exist yet)
  const failingDb = {
    getRepository(name) {
      if (name === 'latticeNotifications') {
        return {
          find: async () => { throw new Error('relation "latticeNotifications" does not exist'); },
          create: async () => { throw new Error('relation "latticeNotifications" does not exist'); },
        };
      }
      return db.getRepository(name);
    },
  };
  const safeAlarm = await ingestOrDeduplicateAlarm(failingDb, {
    organizationId: 'org-a',
    assetId: 12,
    assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12',
    ruleCode: 'DOOR-OPEN',
    attribute: 'doorState',
    severity: 'critical',
    summary: 'Cửa kho mở quá lâu',
  });
  assert.equal(safeAlarm.severity, 'critical');
  assert.equal(safeAlarm.deduplicated, false);
});

test('evaluateRuleCondition handles gt/gte/lt/lte/eq operators and rejects non-finite or unknown inputs', () => {
  const { evaluateRuleCondition } = require(path.join(PLUGIN_ROOT, 'src/server/alarm-engine.js'));
  assert.equal(typeof evaluateRuleCondition, 'function');

  assert.equal(evaluateRuleCondition('gt', -11.5, -15), true);
  assert.equal(evaluateRuleCondition('>', -15, -15), false);
  assert.equal(evaluateRuleCondition('gte', -15, -15), true);
  assert.equal(evaluateRuleCondition('>=', -15.1, -15), false);
  assert.equal(evaluateRuleCondition('lt', 12, '15'), true);
  assert.equal(evaluateRuleCondition('<', 15, 15), false);
  assert.equal(evaluateRuleCondition('lte', 15, 15), true);
  assert.equal(evaluateRuleCondition('<=', 15.01, 15), false);
  assert.equal(evaluateRuleCondition('eq', 42, '42'), true);
  assert.equal(evaluateRuleCondition('==', 0, 0), true);

  assert.equal(evaluateRuleCondition('gt', NaN, 10), false);
  assert.equal(evaluateRuleCondition('gt', 10, Infinity), false);
  assert.equal(evaluateRuleCondition('gt', null, 10), false);
  assert.equal(evaluateRuleCondition('gt', '', 10), false);
  assert.equal(evaluateRuleCondition('unknown_op', 20, 10), false);
});

test('ingestTelemetryPoint persists latticeTelemetryPoints, evaluates active latticeIncidentRules, and deduplicates triggered alarms', async () => {
  const { ingestTelemetryPoint } = require(path.join(PLUGIN_ROOT, 'src/server/alarm-engine.js'));
  assert.equal(typeof ingestTelemetryPoint, 'function');

  let pointSeq = 1;
  let incidentSeq = 300;
  const telemetryPoints = [];
  const incidents = [];
  const rules = [
    {
      id: 1,
      code: 'COLD-TEMP-HIGH',
      name: 'Nhiệt độ kho lạnh vượt -15°C',
      organizationId: 'org-a',
      assetId: 12,
      assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12',
      attribute: 'temperature',
      operator: 'gt',
      threshold: '-15',
      unit: 'CEL',
      severity: 'high',
      handlerId: '5',
      active: true,
    },
    {
      id: 2,
      code: 'INACTIVE-RULE',
      name: 'Luật đã tắt',
      organizationId: 'org-a',
      assetId: 12,
      assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12',
      attribute: 'temperature',
      operator: 'gt',
      threshold: '-30',
      unit: 'CEL',
      severity: 'critical',
      handlerId: '5',
      active: false,
    },
    {
      id: 3,
      code: 'ORG-B-RULE',
      name: 'Luật org B',
      organizationId: 'org-b',
      assetId: 12,
      assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12',
      attribute: 'temperature',
      operator: 'gt',
      threshold: '-30',
      unit: 'CEL',
      severity: 'critical',
      handlerId: '8',
      active: true,
    },
  ];

  const matchFilter = (row, filter = {}) => Object.entries(filter).every(([k, cond]) => {
    if (cond && typeof cond === 'object' && Array.isArray(cond.$in)) return cond.$in.includes(row[k]);
    return row[k] === cond;
  });

  const db = {
    getRepository(name) {
      if (name === 'latticeTelemetryPoints') {
        return {
          create: async ({ values }) => {
            const row = { id: pointSeq++, createdAt: new Date(), ...values };
            telemetryPoints.push(row);
            return row;
          },
          find: async ({ filter = {} } = {}) => telemetryPoints.filter((r) => matchFilter(r, filter)),
        };
      }
      if (name === 'latticeIncidentRules') {
        return {
          find: async ({ filter = {} } = {}) => rules.filter((r) => matchFilter(r, filter)),
        };
      }
      if (name === 'latticeIncidentCases') {
        return {
          find: async ({ filter = {} } = {}) => incidents.filter((r) => matchFilter(r, filter)),
          create: async ({ values }) => {
            const row = { id: ++incidentSeq, ...values, update: async (patch) => Object.assign(row, patch) };
            incidents.push(row);
            return row;
          },
        };
      }
      return null;
    },
  };

  // Safe value (-18.5 <= -15): persists point, triggers 0 alarms
  const okRes = await ingestTelemetryPoint(db, {
    organizationId: 'org-a',
    assetId: 12,
    assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12',
    metricName: 'temperature',
    numericValue: -18.5,
    unit: 'CEL',
    quality: 'good',
    sourceProtocol: 'mqtt',
    observedAt: '2026-11-22T10:00:00Z',
  });
  assert.equal(okRes.point.numericValue, -18.5);
  assert.equal(okRes.point.sourceProtocol, 'mqtt');
  assert.equal(okRes.triggeredAlarms.length, 0);
  assert.equal(telemetryPoints.length, 1);

  // Breach (-11.5 > -15): triggers 1 alarm (only active org-a rule!)
  const breach1 = await ingestTelemetryPoint(db, {
    organizationId: 'org-a',
    assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12',
    metricName: 'temperature',
    numericValue: -11.5,
    unit: 'CEL',
    sourceProtocol: 'mqtt',
  });
  assert.equal(breach1.point.assetId, 12);
  assert.equal(breach1.triggeredAlarms.length, 1);
  assert.equal(breach1.triggeredAlarms[0].deduplicated, false);
  assert.equal(breach1.triggeredAlarms[0].severity, 'high');
  assert.equal(incidents.length, 1);

  // Repeated breach deduplicates into existing active incident
  const breach2 = await ingestTelemetryPoint(db, {
    organizationId: 'org-a',
    assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12',
    metricName: 'temperature',
    numericValue: -9.8,
  });
  assert.equal(breach2.triggeredAlarms.length, 1);
  assert.equal(breach2.triggeredAlarms[0].deduplicated, true);
  assert.equal(breach2.triggeredAlarms[0].occurrenceCount, 2);
  assert.equal(incidents.length, 1);

  // Rejects non-finite/boolean numericValue and cross-org URN mismatch
  await assert.rejects(
    () => ingestTelemetryPoint(db, {
      organizationId: 'org-a',
      assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12',
      numericValue: true,
    }),
    (err) => err.status === 400,
  );
  await assert.rejects(
    () => ingestTelemetryPoint(db, {
      organizationId: 'org-a',
      assetEntityId: 'urn:ngsi-ld:Asset:org-b:native:99',
      numericValue: -10,
    }),
    (err) => err.status === 403,
  );
});

test('queryTelemetryTimeSeries filters windowHours and aggregates bucketMinutes chronologically from latticeTelemetryPoints', async () => {
  const { queryTelemetryTimeSeries } = require(path.join(PLUGIN_ROOT, 'src/server/alarm-engine.js'));

  const nowMs = Date.parse('2026-11-22T12:00:00Z');
  const rows = [
    // Outside 6h window (10h old)
    { id: 1, organizationId: 'org-a', assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12', metricName: 'temperature', numericValue: -25.0, unit: 'CEL', observedAt: '2026-11-22T02:00:00Z' },
    // Bucket 10:00Z -> avg(-18, -16) = -17
    { id: 2, organizationId: 'org-a', assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12', metricName: 'temperature', numericValue: -18.0, unit: 'CEL', observedAt: '2026-11-22T10:15:00Z' },
    { id: 3, organizationId: 'org-a', assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12', metricName: 'temperature', numericValue: -16.0, unit: 'CEL', observedAt: '2026-11-22T10:45:00Z' },
    // Bucket 11:00Z -> avg(-12, -10, -14) = -12
    { id: 4, organizationId: 'org-a', assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12', metricName: 'temperature', numericValue: -12.0, unit: 'CEL', observedAt: '2026-11-22T11:05:00Z' },
    { id: 5, organizationId: 'org-a', assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12', metricName: 'temperature', numericValue: -10.0, unit: 'CEL', observedAt: '2026-11-22T11:30:00Z' },
    { id: 6, organizationId: 'org-a', assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12', metricName: 'temperature', numericValue: -14.0, unit: 'CEL', observedAt: '2026-11-22T11:50:00Z' },
    // Different metric and foreign org must be excluded
    { id: 7, organizationId: 'org-a', assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12', metricName: 'humidity', numericValue: 85, unit: 'PCT', observedAt: '2026-11-22T11:40:00Z' },
    { id: 8, organizationId: 'org-b', assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12', metricName: 'temperature', numericValue: 99, unit: 'CEL', observedAt: '2026-11-22T11:40:00Z' },
  ];

  const db = {
    getRepository(name) {
      if (name === 'latticeTelemetryPoints') {
        return { find: async () => rows };
      }
      return null;
    },
  };

  const bucketed = await queryTelemetryTimeSeries(db, {
    organizationId: 'org-a',
    assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12',
    attribute: 'temperature',
    windowHours: 6,
    bucketMinutes: 60,
    limit: 50,
    now: nowMs,
  });

  assert.equal(bucketed.points.length, 2);
  assert.deepEqual(bucketed.points[0], {
    timestamp: '2026-11-22T10:00:00.000Z',
    value: -17,
    min: -18,
    max: -16,
    count: 2,
    unit: 'CEL',
  });
  assert.deepEqual(bucketed.points[1], {
    timestamp: '2026-11-22T11:00:00.000Z',
    value: -12,
    min: -14,
    max: -10,
    count: 3,
    unit: 'CEL',
  });
  assert.equal(bucketed.stats.count, 2);
  assert.equal(bucketed.stats.latest, -12);
});

function loadWithNocobaseStubs(filePath, stubs = {}) {
  const Module = require('node:module');
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

test('dxosBlocks:telemetryIngest fails closed 401 when unauthenticated/unset token and authorizes valid edge token or ACL user', async () => {
  const { createDxosBlocksActions } = require(path.join(PLUGIN_ROOT, 'src/server/blocks-api.js'));
  const DxosBlocksServerPlugin = loadWithNocobaseStubs(
    path.join(PLUGIN_ROOT, 'src/server/index.js'),
    {
      '@nocobase/server': {
        Plugin: class {
          constructor(opts = {}) {
            this.db = opts.db;
            this.app = opts.app;
          }
        },
      },
    },
  );

  const storedPoints = [];
  const storedAlarms = [];
  const employees = [{ id: 5, userId: 50, organizationId: 'org-a', active: true }];
  const rules = [{
    id: 1,
    code: 'TEMP-CRIT',
    organizationId: 'org-a',
    assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12',
    attribute: 'temperature',
    operator: 'gte',
    threshold: '-12',
    unit: 'CEL',
    severity: 'critical',
    handlerId: '5',
    active: true,
  }];
  let allowIncidentCreate = false;
  let allowAssetUpdate = false;

  const db = {
    getRepository(name) {
      if (name === 'latticeEmployees') return { find: async ({ filter }) => employees.filter((e) => Number(e.userId) === Number(filter?.userId)) };
      if (name === 'roles') return { findOne: async () => ({ name: 'ldx_operator', allowAll: false, strategy: { actions: [] } }) };
      if (name === 'dataSourcesRolesResources') {
        return {
          findOne: async ({ filter }) => {
            if (filter?.name === 'latticeIncidentCases') {
              return { usingActionsConfig: true, actions: allowIncidentCreate ? [{ name: 'create' }] : [{ name: 'view' }] };
            }
            if (filter?.name === 'latticeAssets') {
              return { usingActionsConfig: true, actions: allowAssetUpdate ? [{ name: 'update' }] : [{ name: 'view' }] };
            }
            return { usingActionsConfig: true, actions: [] };
          },
        };
      }
      if (name === 'latticeTelemetryPoints') {
        return { create: async ({ values }) => { const row = { id: storedPoints.length + 1, ...values }; storedPoints.push(row); return row; } };
      }
      if (name === 'latticeIncidentRules') {
        return { find: async ({ filter }) => rules.filter((r) => r.organizationId === filter.organizationId && r.assetEntityId === filter.assetEntityId && r.attribute === filter.attribute) };
      }
      if (name === 'latticeIncidentCases') {
        return {
          find: async () => storedAlarms.filter((a) => ['open', 'acknowledged'].includes(a.status)),
          create: async ({ values }) => { const row = { id: 900 + storedAlarms.length + 1, ...values }; storedAlarms.push(row); return row; },
        };
      }
      return null;
    },
  };

  const actions = createDxosBlocksActions(db, {});
  assert.equal(typeof actions.telemetryIngest, 'function');

  const prevToken = process.env.DX_IIOT_INGEST_TOKEN;
  try {
    // 1. Unauthenticated request ALWAYS fails 401 when DX_IIOT_INGEST_TOKEN is unset
    delete process.env.DX_IIOT_INGEST_TOKEN;
    await assert.rejects(
      () => actions.telemetryIngest({
        method: 'POST',
        headers: {},
        state: {},
        action: { params: { values: { organizationId: 'org-a', assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12', metricName: 'temperature', numericValue: -10 } } },
      }, async () => {}),
      (err) => err.status === 401,
    );

    // 2. Short token (< 16 chars) fails closed with 401 even if header matches
    process.env.DX_IIOT_INGEST_TOKEN = 'too-short-123';
    await assert.rejects(
      () => actions.telemetryIngest({
        method: 'POST',
        headers: { 'X-Lattice-Edge-Token': 'too-short-123' },
        state: {},
        action: { params: { values: { organizationId: 'org-a', assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12', metricName: 'temperature', numericValue: -10 } } },
      }, async () => {}),
      (err) => err.status === 401,
    );

    // 3. Valid >=16 char token: mismatched/different-length header fails 401
    process.env.DX_IIOT_INGEST_TOKEN = 'edge-secret-token-2026-0123456789';
    await assert.rejects(
      () => actions.telemetryIngest({
        method: 'POST',
        headers: { 'x-lattice-edge-token': 'wrong-len' },
        state: {},
        action: { params: { values: { organizationId: 'org-a', assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12', numericValue: -10 } } },
      }, async () => {}),
      (err) => err.status === 401,
    );

    // 4. Valid edge token without explicit organizationId fails 400
    await assert.rejects(
      () => actions.telemetryIngest({
        method: 'POST',
        headers: { 'X-Lattice-Edge-Token': 'edge-secret-token-2026-0123456789' },
        state: {},
        action: { params: { values: { assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12', numericValue: -10 } } },
      }, async () => {}),
      (err) => err.status === 400,
    );

    // 5. Valid edge token + explicit organizationId succeeds and triggers rule alarm
    const edgeCtx = {
      method: 'POST',
      headers: { 'X-Lattice-Edge-Token': 'edge-secret-token-2026-0123456789' },
      state: {},
      action: {
        params: {
          values: {
            organizationId: 'org-a',
            assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12',
            metricName: 'temperature',
            numericValue: -11.2,
            unit: 'CEL',
            sourceProtocol: 'mqtt',
          },
        },
      },
    };
    await actions.telemetryIngest(edgeCtx, async () => {});
    assert.equal(edgeCtx.body.point.numericValue, -11.2);
    assert.equal(edgeCtx.body.triggeredAlarms.length, 1);
    assert.equal(edgeCtx.body.triggeredAlarms[0].severity, 'critical');

    // 6. Logged-in user without latticeIncidentCases:create OR latticeAssets:update denied 403
    await assert.rejects(
      () => actions.telemetryIngest({
        method: 'POST',
        headers: {},
        state: { currentUser: { id: 50 }, currentRole: 'ldx_operator' },
        action: { params: { values: { assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12', numericValue: -18 } } },
      }, async () => {}),
      (err) => err.status === 403,
    );

    // 7. Logged-in user with latticeAssets:update succeeds, scoped strictly to actor.organizationId
    allowAssetUpdate = true;
    const userCtx = {
      method: 'POST',
      headers: {},
      state: { currentUser: { id: 50 }, currentRole: 'ldx_operator' },
      action: { params: { values: { assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12', metricName: 'temperature', numericValue: -19.0 } } },
    };
    await actions.telemetryIngest(userCtx, async () => {});
    assert.equal(userCtx.body.point.organizationId, 'org-a');
    assert.equal(userCtx.body.triggeredAlarms.length, 0);

    // Cross-org override by logged-in user blocked 403
    await assert.rejects(
      () => actions.telemetryIngest({
        method: 'POST',
        headers: {},
        state: { currentUser: { id: 50 }, currentRole: 'ldx_operator' },
        action: { params: { values: { organizationId: 'org-b', assetEntityId: 'urn:ngsi-ld:Asset:org-b:native:99', numericValue: -18 } } },
      }, async () => {}),
      (err) => err.status === 403,
    );

    // Logged-in user with latticeIncidentCases:create (without latticeAssets:update) also succeeds
    allowAssetUpdate = false;
    allowIncidentCreate = true;
    const creatorCtx = {
      method: 'POST',
      headers: {},
      state: { currentUser: { id: 50 }, currentRole: 'ldx_operator' },
      action: { params: { values: { assetId: 12, metricName: 'temperature', numericValue: -16.5 } } },
    };
    await actions.telemetryIngest(creatorCtx, async () => {});
    assert.equal(creatorCtx.body.point.assetEntityId, 'urn:ngsi-ld:Asset:org-a:native:12');

    // Non-POST method rejected 405
    await assert.rejects(
      () => actions.telemetryIngest({
        method: 'GET',
        headers: { 'X-Lattice-Edge-Token': 'edge-secret-token-2026-0123456789' },
        state: {},
        action: { params: { organizationId: 'org-a', assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12', numericValue: -10 } },
      }, async () => {}),
      (err) => err.status === 405,
    );
  } finally {
    if (prevToken === undefined) delete process.env.DX_IIOT_INGEST_TOKEN;
    else process.env.DX_IIOT_INGEST_TOKEN = prevToken;
  }

  // Verify plugin load() registers dxosBlocks:telemetryIngest on public ACL (with handler-level fail-closed auth)
  // and blocks non-root direct CRUD / charts:queryData on latticeTelemetryPoints
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
      acl: {
        allow: (...args) => aclCalls.push(args),
      },
    },
  });
  await plugin.load();
  assert.equal(definedResource.name, 'dxosBlocks');
  assert.equal(typeof definedResource.actions.telemetryIngest, 'function');
  assert.ok(aclCalls.some(([res, act, scope]) => res === 'dxosBlocks' && (act === 'telemetryIngest' || (Array.isArray(act) && act.includes('telemetryIngest'))) && scope === 'public'));
  assert.ok(middlewares.length >= 1, 'Plugin should register direct telemetry CRUD guard middleware');
  const guardMw = middlewares[0];
  await assert.rejects(
    () => guardMw({ state: { currentRole: 'ldx_manager' }, action: { resourceName: 'latticeTelemetryPoints', actionName: 'list' } }, async () => {}),
    (err) => err.status === 403,
  );
  await assert.rejects(
    () => guardMw({ state: { currentRole: 'ldx_manager' }, action: { resourceName: 'charts', actionName: 'queryData', params: { values: { collection: 'latticeTelemetryPoints' } } } }, async () => {}),
    (err) => err.status === 403,
  );
  let rootPassed = false;
  await guardMw({ state: { currentRole: 'root' }, action: { resourceName: 'latticeTelemetryPoints', actionName: 'list' } }, async () => { rootPassed = true; });
  assert.equal(rootPassed, true);

  // Verify blocks-api telemetrySeries forwards windowHours and bucketMinutes
  const tsDb = {
    getRepository(name) {
      if (name === 'latticeTelemetryPoints') {
        const now = Date.now();
        const bucketBase = Math.floor((now - 15 * 60_000) / 3600_000) * 3600_000;
        return {
          find: async () => [
            { id: 1, organizationId: 'org-a', assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12', metricName: 'temperature', numericValue: -18, unit: 'CEL', observedAt: new Date(now - 5 * 3600_000).toISOString() },
            { id: 2, organizationId: 'org-a', assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12', metricName: 'temperature', numericValue: -14, unit: 'CEL', observedAt: new Date(bucketBase + 10 * 60_000).toISOString() },
            { id: 3, organizationId: 'org-a', assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12', metricName: 'temperature', numericValue: -12, unit: 'CEL', observedAt: new Date(bucketBase + 12 * 60_000).toISOString() },
          ],
        };
      }
      return db.getRepository(name);
    },
  };
  const tsActions = createDxosBlocksActions(tsDb, {});
  const tsSeriesCtx = {
    method: 'POST',
    state: { currentUser: { id: 50 }, currentRole: 'ldx_operator' },
    can: () => ({}),
    action: { params: { values: { assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12', attribute: 'temperature', windowHours: 2, bucketMinutes: 60 } } },
  };
  await tsActions.telemetrySeries(tsSeriesCtx, async () => {});
  assert.equal(tsSeriesCtx.body.points.length, 1);
  assert.equal(tsSeriesCtx.body.points[0].count, 2);
  assert.equal(tsSeriesCtx.body.points[0].value, -13);
});

test('telemetry-points collection, migration 20261123000500, and OSI-clean IIoT compose/config meet security & TimescaleDB guardrails', async () => {
  const collectionPath = path.join(PLUGIN_ROOT, 'src/server/collections/telemetry-points.js');
  const collectionSrc = readFileSync(collectionPath, 'utf8');
  assert.match(collectionSrc, /SPDX-License-Identifier:\s*Apache-2\.0/);
  assert.match(collectionSrc, /latticeTelemetryPoints/);
  assert.match(collectionSrc, /idx_lattice_telemetry_org_entity_metric_obs/);

  const colDef = loadWithNocobaseStubs(collectionPath, {
    '@nocobase/database': { defineCollection: (def) => def },
  });
  assert.equal(colDef.name, 'latticeTelemetryPoints');
  assert.deepEqual(colDef.migrationRules, ['schema-only']);
  for (const fieldName of ['organizationId', 'assetId', 'assetEntityId', 'metricName', 'numericValue', 'unit', 'quality', 'sourceProtocol', 'observedAt']) {
    assert.ok(colDef.fields.some((f) => f.name === fieldName), `Missing field ${fieldName}`);
  }
  assert.equal(colDef.indexes[0].name, 'idx_lattice_telemetry_org_entity_metric_obs');
  assert.ok(colDef.indexes[0].name.length <= 55);

  const migPath = path.join(PLUGIN_ROOT, 'src/server/migrations/20261123000500-dxos-telemetry-timeseries.js');
  const migSrc = readFileSync(migPath, 'utf8');
  assert.match(migSrc, /SPDX-License-Identifier:\s*Apache-2\.0/);
  assert.match(migSrc, /CREATE TABLE IF NOT EXISTS "latticeTelemetryPoints"/);
  assert.match(migSrc, /idx_lattice_telemetry_org_entity_metric_obs/);
  assert.match(migSrc, /pg_available_extensions/);
  assert.match(migSrc, /pg_extension/);
  assert.match(migSrc, /create_hypertable/);
  assert.match(migSrc, /DROP TABLE IF EXISTS "latticeTelemetryPoints"/);

  // Execute migration up()/down() cleanly against plain Postgres and TimescaleDB mocks
  const Module = require('node:module');
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === '@nocobase/server') {
      return { Migration: class { constructor(ctx) { this.context = ctx; } } };
    }
    return origLoad.call(this, request, parent, isMain);
  };
  let MigrationCls;
  try {
    delete require.cache[require.resolve(migPath)];
    MigrationCls = require(migPath);
  } finally {
    Module._load = origLoad;
  }

  const plainQueries = [];
  const plainMig = new MigrationCls({
    db: {
      sequelize: {
        transaction: async (fn) => fn({ id: 'tx-plain' }),
        query: async (sql) => {
          plainQueries.push(sql);
          return [[]];
        },
      },
    },
  });
  await plainMig.up();
  assert.equal(plainQueries.some((q) => q.includes('create_hypertable')), false, 'Plain Postgres must NOT invoke create_hypertable');
  await plainMig.down();
  assert.ok(plainQueries.some((q) => q.includes('DROP TABLE IF EXISTS "latticeTelemetryPoints"')));

  const tsQueries = [];
  const tsMig = new MigrationCls({
    db: {
      sequelize: {
        transaction: async (fn) => fn({ id: 'tx-ts' }),
        query: async (sql) => {
          tsQueries.push(sql);
          if (sql.includes('pg_extension') || sql.includes('pg_available_extensions')) return [[{ exists: 1 }]];
          return [[]];
        },
      },
    },
  });
  await tsMig.up();
  assert.ok(
    tsQueries.some((q) => q.includes('pg_constraint') && q.includes('pg_attribute') && q.includes('ADD PRIMARY KEY (id, "observedAt")')),
    'TimescaleDB migration must upgrade single-column PK to composite (id, "observedAt")',
  );
  assert.ok(
    tsQueries.some((q) => q.includes("create_hypertable('\"latticeTelemetryPoints\"', 'observedAt', if_not_exists => TRUE, migrate_data => TRUE)")),
    'TimescaleDB migration must invoke create_hypertable with if_not_exists => TRUE, migrate_data => TRUE',
  );

  // Verify IIoT compose and configs (Valkey/PG only, unused timescaledb removed)
  const repoRoot = path.resolve(PLUGIN_ROOT, '../../..');
  const iiotYml = readFileSync(path.join(repoRoot, 'infra/compose/iiot.yml'), 'utf8');
  assert.match(iiotYml, /SPDX-License-Identifier:\s*Apache-2\.0/);
  assert.match(iiotYml, /eclipse-mosquitto:2\.0\.21@sha256:94f5a3d7deafa59fa3440d227ddad558f59d293c612138de841eec61bfa4d353/);
  assert.match(iiotYml, /nodered\/node-red:4\.0\.9@sha256:0b295b3a14c512548567ca99db631bc37b23bfc79fd009ee8248a610fafdb4b5/);
  assert.doesNotMatch(iiotYml, /timescaledb/i);
  assert.doesNotMatch(iiotYml, /thingsboard|emqx|:latest\b/i);
  assert.match(iiotYml, /no-new-privileges:true/);
  assert.match(iiotYml, /cap_drop:\s*\r?\n\s*-\s*ALL/);
  assert.match(iiotYml, /mem_limit:/);
  assert.match(iiotYml, /healthcheck:/);
  assert.match(iiotYml, /iiot-net:\s*\r?\n[\s\S]*?internal:\s*true/);
  // Mosquitto must remain internal on iiot-net (expose 1883, no host ports binding)
  const mosquittoBlock = iiotYml.match(/^\s{2}mosquitto:\r?\n([\s\S]*?)(?=^\s{2}[a-z0-9_-]+:|\z)/m)?.[1] || '';
  assert.doesNotMatch(mosquittoBlock, /^\s+ports:/m, 'mosquitto must not bind host ports on an internal network');
  assert.match(mosquittoBlock, /^\s+expose:\s*\r?\n\s*-\s*["']?1883["']?/m);

  const mosq = readFileSync(path.join(repoRoot, 'infra/config/mosquitto/mosquitto.conf'), 'utf8');
  assert.match(mosq, /SPDX-License-Identifier:\s*Apache-2\.0/);
  assert.match(mosq, /listener\s+1883/);
  assert.match(mosq, /allow_anonymous\s+false/);
  assert.match(mosq, /plugin\s+\/usr\/lib\/mosquitto_dynamic_security\.so/);
  assert.match(mosq, /persistence\s+true/);

  const flowsRaw = readFileSync(path.join(repoRoot, 'infra/config/nodered/flows.json'), 'utf8');
  const flows = JSON.parse(flowsRaw);
  assert.ok(Array.isArray(flows) && flows.length >= 4);
  assert.ok(flows.some((n) => n.type === 'mqtt in' && n.topic === 'latticedx/+/+/telemetry'));
  assert.ok(flows.some((n) => n.type === 'mqtt in' && n.topic === 'latticedx/+/+/status'));
  const statusFn = flows.find((n) => n.id === 'latticedx-status-fn');
  assert.ok(statusFn && String(statusFn.func || '').includes('dxosBroker:deviceStatusIngest'));
  const sanitizerNode = flows.find((n) => n.type === 'function');
  assert.ok(sanitizerNode && String(sanitizerNode.func || '').includes('X-Lattice-Edge-Token'));
  assert.ok(String(sanitizerNode.func || '').includes("env.get('DX_IIOT_INGEST_URL') || 'http://nocobase/api/dxosBlocks:telemetryIngest'"));
  assert.ok(String(sanitizerNode.func || '').includes('rawValue.trim()'));
  const httpNode = flows.find((n) => n.type === 'http request');
  assert.ok(httpNode, 'Missing Node-RED http request node');
  assert.equal(httpNode.url, '', 'http request node url must be empty so Node-RED honors dynamic msg.url');
});

test('Fix Round 1: queryTelemetryTimeSeries returns latest N of 250 points and aggregates full window when bucketMinutes > 0', async () => {
  const { queryTelemetryTimeSeries } = require(path.join(PLUGIN_ROOT, 'src/server/alarm-engine.js'));

  const baseMs = Date.parse('2026-11-22T00:00:00Z');
  const nowMs = baseMs + 250 * 60_000; // 250 minutes later (~4.16h)
  const allPoints = Array.from({ length: 250 }, (_, idx) => ({
    id: idx + 1,
    organizationId: 'org-a',
    assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12',
    metricName: 'temperature',
    numericValue: idx, // 0..249
    unit: 'CEL',
    observedAt: new Date(baseMs + idx * 60_000).toISOString(),
  }));

  const db = {
    getRepository(name) {
      if (name === 'latticeTelemetryPoints') {
        return {
          find: async ({ sort = [], limit = 100, offset = 0 } = {}) => {
            let out = allPoints.slice();
            if (Array.isArray(sort) && sort.includes('-observedAt')) {
              out.sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt) || b.id - a.id);
            }
            return out.slice(offset, offset + limit);
          },
        };
      }
      return null;
    },
  };

  // Raw query with limit: 50 MUST return the latest 50 points (values 200..249), sorted ascending
  const latest50 = await queryTelemetryTimeSeries(db, {
    organizationId: 'org-a',
    assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12',
    attribute: 'temperature',
    windowHours: 24,
    limit: 50,
    now: nowMs,
  });
  assert.equal(latest50.points.length, 50);
  assert.equal(latest50.points[0].value, 200);
  assert.equal(latest50.points[49].value, 249);
  assert.equal(latest50.stats.latest, 249);

  // Mock with small page cap (100) still aggregates all 250 points across 5 hourly buckets via pagination
  const pagedDb = {
    getRepository(name) {
      if (name === 'latticeTelemetryPoints') {
        return {
          find: async ({ sort = [], limit = 100, offset = 0 } = {}) => {
            let out = allPoints.slice();
            if (Array.isArray(sort) && sort.includes('-observedAt')) {
              out.sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt) || b.id - a.id);
            }
            return out.slice(offset, offset + Math.min(limit, 100));
          },
        };
      }
      return null;
    },
  };
  const bucketed = await queryTelemetryTimeSeries(pagedDb, {
    organizationId: 'org-a',
    assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12',
    attribute: 'temperature',
    windowHours: 24,
    bucketMinutes: 60,
    limit: 50,
    now: nowMs,
  });
  assert.equal(bucketed.points.length, 5);
  assert.equal(bucketed.points.reduce((s, b) => s + b.count, 0), 250);
});

test('Fix Round 1: ingestTelemetryPoint scans past >200 rules, enforces cross-tenant assetId 404 before insert, and blocks bad org/window inputs', async () => {
  const { ingestTelemetryPoint } = require(path.join(PLUGIN_ROOT, 'src/server/alarm-engine.js'));
  const { createDxosBlocksActions } = require(path.join(PLUGIN_ROOT, 'src/server/blocks-api.js'));

  const assets = [
    { id: 12, organizationId: 'org-a', code: 'COLD-A1' },
    { id: 99, organizationId: 'org-b', code: 'COLD-B1' },
  ];
  const insertedPoints = [];
  const incidents = [];
  const manyRules = [
    ...Array.from({ length: 220 }, (_, i) => ({
      id: i + 1,
      code: `OTHER-${i + 1}`,
      name: `Unrelated rule ${i + 1}`,
      organizationId: 'org-a',
      assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:999',
      attribute: 'humidity',
      operator: 'gt',
      threshold: '99',
      severity: 'low',
      handlerId: '5',
      active: true,
    })),
    {
      id: 221,
      code: 'RULE-221',
      name: 'Rule past 200 threshold',
      organizationId: 'org-a',
      assetId: 12,
      assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12',
      attribute: 'temperature',
      operator: 'gt',
      threshold: '-15',
      severity: 'critical',
      handlerId: '5',
      active: true,
    },
  ];

  const db = {
    getRepository(name) {
      if (name === 'latticeAssets') {
        return {
          findOne: async ({ filter = {} } = {}) => assets.find((a) => (!filter.id || Number(a.id) === Number(filter.id)) && (!filter.organizationId || a.organizationId === filter.organizationId)) || null,
        };
      }
      if (name === 'latticeTelemetryPoints') {
        return {
          create: async ({ values }) => {
            const row = { id: insertedPoints.length + 1, ...values };
            insertedPoints.push(row);
            return row;
          },
          find: async () => insertedPoints,
        };
      }
      if (name === 'latticeIncidentRules') {
        return {
          find: async ({ limit = 200, offset = 0 } = {}) => manyRules.slice(offset, offset + limit),
        };
      }
      if (name === 'latticeIncidentCases') {
        return {
          find: async () => incidents,
          create: async ({ values }) => {
            const row = { id: 700 + incidents.length + 1, ...values };
            incidents.push(row);
            return row;
          },
        };
      }
      if (name === 'latticeEmployees') {
        return { find: async () => [{ id: 5, userId: 50, organizationId: 'org-a', active: true }] };
      }
      if (name === 'roles') {
        return { findOne: async () => ({ name: 'ldx_manager', allowAll: false, strategy: { actions: [] } }) };
      }
      if (name === 'dataSourcesRolesResources') {
        return { findOne: async () => ({ usingActionsConfig: true, actions: [{ name: 'view' }, { name: 'create' }] }) };
      }
      return null;
    },
  };

  // 1. Cross-tenant assetId (asset 99 belongs to org-b) MUST throw 404 TELEMETRY_ASSET_NOT_FOUND before inserting
  await assert.rejects(
    () => ingestTelemetryPoint(db, {
      organizationId: 'org-a',
      assetId: 99,
      assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:99',
      metricName: 'temperature',
      numericValue: -10,
    }),
    (err) => err.status === 404 && err.code === 'TELEMETRY_ASSET_NOT_FOUND',
  );
  assert.equal(insertedPoints.length, 0, 'Must not insert telemetry point when assetId does not belong to org');

  // 2. Non-existent assetId throws 404 TELEMETRY_ASSET_NOT_FOUND before inserting
  await assert.rejects(
    () => ingestTelemetryPoint(db, {
      organizationId: 'org-a',
      assetId: 5555,
      assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:5555',
      metricName: 'temperature',
      numericValue: -10,
    }),
    (err) => err.status === 404 && err.code === 'TELEMETRY_ASSET_NOT_FOUND',
  );
  assert.equal(insertedPoints.length, 0);

  // 3. Matching rule at position 221 (>200 unrelated rules) MUST still trigger alarm
  const ok = await ingestTelemetryPoint(db, {
    organizationId: 'org-a',
    assetId: 12,
    assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12',
    metricName: 'temperature',
    numericValue: -11.0,
  });
  assert.equal(insertedPoints.length, 1);
  assert.equal(ok.triggeredAlarms.length, 1);
  assert.equal(ok.triggeredAlarms[0].severity, 'critical');

  // 4. Edge-token telemetryIngest rejects invalid organizationId format and telemetrySeries rejects NaN/negative windowHours & bucketMinutes
  const actions = createDxosBlocksActions(db, { ingestToken: 'edge-secret-token-2026-0123456789' });
  await assert.rejects(
    () => actions.telemetryIngest({
      method: 'POST',
      headers: { 'X-Lattice-Edge-Token': 'edge-secret-token-2026-0123456789' },
      state: {},
      action: { params: { values: { organizationId: 'org-a;drop', assetId: 12, numericValue: -10 } } },
    }, async () => {}),
    (err) => err.status === 400 && err.code === 'TELEMETRY_ORG_REQUIRED',
  );

  for (const badParams of [
    { assetId: 12, windowHours: -1 },
    { assetId: 12, windowHours: 'not-a-number' },
    { assetId: 12, windowHours: '   ' },
    { assetId: 12, bucketMinutes: -5 },
    { assetId: 12, bucketMinutes: 'NaN' },
    { assetId: 12, bucketMinutes: '   ' },
  ]) {
    await assert.rejects(
      () => actions.telemetrySeries({
        method: 'POST',
        state: { currentUser: { id: 50 }, currentRole: 'ldx_manager' },
        action: { params: { values: badParams } },
      }, async () => {}),
      (err) => err.status === 400,
    );
  }

  // 5. Fix Round 2: whitespace-only numericValue and contradictory assetId vs assetEntityId URN fail closed 400
  const { evaluateRuleCondition } = require(path.join(PLUGIN_ROOT, 'src/server/alarm-engine.js'));
  assert.equal(evaluateRuleCondition('lt', '   ', 10), false);
  await assert.rejects(
    () => ingestTelemetryPoint(db, {
      organizationId: 'org-a',
      assetId: 12,
      assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12',
      numericValue: '   ',
    }),
    (err) => err.status === 400 && err.code === 'TELEMETRY_VALUE_INVALID',
  );
  await assert.rejects(
    () => ingestTelemetryPoint(db, {
      organizationId: 'org-a',
      assetId: 12,
      assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:99',
      numericValue: -10,
    }),
    (err) => err.status === 400 && err.code === 'TELEMETRY_ASSET_MISMATCH',
  );
});

test('Fix Round 2: Node-RED sanitizer function routes to http://nocobase/api/dxosBlocks:telemetryIngest and drops whitespace values', () => {
  const repoRoot = path.resolve(PLUGIN_ROOT, '../../..');
  const flows = JSON.parse(readFileSync(path.join(repoRoot, 'infra/config/nodered/flows.json'), 'utf8'));
  const sanitizer = flows.find((n) => n.id === 'latticedx-sanitizer-fn');
  const httpNode = flows.find((n) => n.id === 'latticedx-http-ingest');
  assert.equal(httpNode.url, '');

  const fn = new Function('msg', 'node', 'env', sanitizer.func);
  const warnings = [];
  const errors = [];
  const fakeNode = { warn: (m) => warnings.push(m), error: (m) => errors.push(m) };
  const fakeEnv = new Map([['DX_IIOT_INGEST_TOKEN', 'edge-secret-token-2026-0123456789']]);

  // Whitespace-only value must be dropped (never coerced to 0) on both NocoBase and Orion outputs
  const dropped = fn(
    { topic: 'latticedx/org-a/12/telemetry', payload: { numericValue: '   ' } },
    fakeNode,
    { get: (k) => fakeEnv.get(k) },
  );
  assert.deepEqual(dropped, [null, null]);
  assert.ok(warnings.length > 0);

  // Valid MQTT telemetry uses internal docker URL http://nocobase/api/dxosBlocks:telemetryIngest
  const [out, orionSkipped] = fn(
    { topic: 'latticedx/org-a/12/telemetry', payload: JSON.stringify({ metricName: 'temperature', value: -14.5, unit: 'CEL' }) },
    fakeNode,
    { get: (k) => fakeEnv.get(k) },
  );
  assert.equal(out.url, 'http://nocobase/api/dxosBlocks:telemetryIngest');
  assert.equal(out.headers['X-Lattice-Edge-Token'], 'edge-secret-token-2026-0123456789');
  assert.equal(out.payload.organizationId, 'org-a');
  assert.equal(out.payload.assetEntityId, 'urn:ngsi-ld:Asset:org-a:native:12');
  assert.equal(out.payload.numericValue, -14.5);
  assert.equal(orionSkipped, null);
  assert.equal(errors.length, 0);

  // When DX_ORION_URL is set, output 2 emits a matching NGSI-LD Property PATCH
  const orionEnv = new Map([
    ['DX_IIOT_INGEST_TOKEN', 'edge-secret-token-2026-0123456789'],
    ['DX_ORION_URL', 'http://orion-ld:1026'],
  ]);
  const [ingestWithOrion, orionOut] = fn(
    { topic: 'latticedx/org-a/12/telemetry', payload: JSON.stringify({ metricName: 'temperature', value: -14.5, unit: 'CEL' }) },
    fakeNode,
    { get: (k) => orionEnv.get(k) },
  );
  assert.equal(ingestWithOrion.payload.numericValue, -14.5);
  assert.equal(orionOut.url, 'http://orion-ld:1026/ngsi-ld/v1/entities/urn%3Angsi-ld%3AAsset%3Aorg-a%3Anative%3A12/attrs');
  assert.equal(orionOut.headers['NGSILD-Tenant'], 'org-a');
  assert.equal(orionOut.payload.temperature.type, 'Property');
  assert.equal(orionOut.payload.temperature.value, -14.5);
});

test('dxosBlocks:telemetryIngest resolves Bearer JWT and verified DB roles when ACL skipCheck leaves currentUser undefined', async () => {
  const { createDxosBlocksActions } = require(path.join(PLUGIN_ROOT, 'src/server/blocks-api.js'));
  const telemetryRows = [];
  const rolesUsersRows = [
    { userId: 1, roleName: 'root', default: true },
    { userId: 2, roleName: 'ldx_employee', default: true },
    { userId: 3, roleName: 'ldx_operator', default: true },
  ];
  const employeesRows = [
    { id: 20, userId: 2, active: true, organizationId: 'org-a' },
    { id: 30, userId: 3, active: true, organizationId: 'org-a' },
  ];
  const rolesRows = [
    { name: 'root', allowAll: true },
    { name: 'ldx_employee', allowAll: false },
    { name: 'ldx_operator', allowAll: false },
  ];
  const roleResources = [
    { roleName: 'ldx_operator', name: 'latticeIncidentCases', dataSourceKey: 'main', usingActionsConfig: true, actions: [{ name: 'create' }] },
  ];

  const db = {
    getRepository(name) {
      if (name === 'rolesUsers') return { find: async ({ filter } = {}) => rolesUsersRows.filter((r) => r.userId === filter?.userId) };
      if (name === 'latticeEmployees') return { find: async ({ filter } = {}) => employeesRows.filter((r) => r.userId === filter?.userId) };
      if (name === 'roles') return { findOne: async ({ filter } = {}) => rolesRows.find((r) => r.name === filter?.name) || null };
      if (name === 'dataSourcesRolesResources') {
        return {
          findOne: async ({ filter } = {}) =>
            roleResources.find((r) => r.roleName === filter?.roleName && r.name === filter?.name) || null,
        };
      }
      if (name === 'latticeIncidentRules') return { find: async () => [] };
      if (name === 'latticeAssets') return { findOne: async () => ({ id: 12, organizationId: 'org-a', code: 'CH-01', name: 'Chiller' }) };
      if (name === 'latticeTelemetryPoints') {
        return {
          find: async () => [],
          create: async ({ values }) => {
            const row = { id: telemetryRows.length + 1, ...values };
            telemetryRows.push(row);
            return row;
          },
        };
      }
      return null;
    },
  };

  const actions = createDxosBlocksActions(db, { ingestToken: '' });
  const baseValues = { assetId: 12, metricName: 'temperature', numericValue: -17.2, unit: 'CEL' };

  // 1. Admin JWT on skipCheck() public route succeeds with verified root role
  const rootCtx = {
    method: 'POST',
    headers: { authorization: 'Bearer admin-jwt', 'x-role': 'root' },
    state: { currentUser: undefined, currentRole: undefined },
    auth: { skipCheck: async () => true, check: async () => ({ id: 1 }) },
    can: () => false,
    action: { params: { values: { organizationId: 'org-a', ...baseValues } } },
  };
  await actions.telemetryIngest(rootCtx, async () => {});
  assert.equal(telemetryRows.length, 1);
  assert.equal(rootCtx.body.point.organizationId, 'org-a');

  // 2. Employee spoofing X-Role: root is demoted to verified ldx_employee role and rejected 403
  const spoofCtx = {
    method: 'POST',
    headers: { authorization: 'Bearer emp-jwt', 'x-role': 'root' },
    state: { currentUser: undefined, currentRole: 'root' },
    auth: { skipCheck: async () => true, check: async () => ({ id: 2 }) },
    can: () => true,
    action: { params: { values: { organizationId: 'org-a', ...baseValues } } },
  };
  await assert.rejects(
    () => actions.telemetryIngest(spoofCtx, async () => {}),
    (err) => err.status === 403 && err.code === 'DXOS_ACL_DENIED',
  );
  assert.equal(spoofCtx.state.currentRole, 'ldx_employee');

  // 3. Operator JWT bypasses anonymous-bound ctx.can and succeeds via verified DB ACL
  const opCtx = {
    method: 'POST',
    headers: { authorization: 'Bearer op-jwt' },
    state: { currentUser: undefined, currentRole: undefined },
    auth: { skipCheck: async () => true, check: async () => ({ id: 3 }) },
    can: () => false,
    action: { params: { values: { ...baseValues } } },
  };
  await actions.telemetryIngest(opCtx, async () => {});
  assert.equal(telemetryRows.length, 2);

  // 4. Throwing / missing JWT returns 401 NATIVE_LOGIN_REQUIRED
  const unauthCtx = {
    method: 'POST',
    headers: {},
    state: {},
    auth: { skipCheck: async () => true, check: async () => { throw new Error('invalid token'); } },
    action: { params: { values: { organizationId: 'org-a', ...baseValues } } },
  };
  await assert.rejects(
    () => actions.telemetryIngest(unauthCtx, async () => {}),
    (err) => err.status === 401 && err.code === 'NATIVE_LOGIN_REQUIRED',
  );
});
