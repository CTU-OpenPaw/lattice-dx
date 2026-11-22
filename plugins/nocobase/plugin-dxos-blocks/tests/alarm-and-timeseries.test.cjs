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
