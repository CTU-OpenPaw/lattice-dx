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

function makeQuarantineTelemetryDb({ withQuarantineRepo = true } = {}) {
  let pointSeq = 1;
  let incidentSeq = 1;
  let quarantineSeq = 1;
  const points = [];
  const incidents = [];
  const quarantined = [];
  const rules = [
    {
      id: 1,
      code: 'COLD-HIGH',
      name: 'Nhiệt độ cao',
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
  ];

  const matchFilter = (row, filter = {}) => Object.entries(filter || {}).every(([k, cond]) => {
    if (cond && typeof cond === 'object' && Array.isArray(cond.$in)) return cond.$in.includes(row[k]);
    return row[k] === cond;
  });

  const db = {
    getRepository(name) {
      if (name === 'latticeAssets') {
        return {
          findOne: async ({ filter }) => (Number(filter?.id) === 12 && filter?.organizationId === 'org-a'
            ? { id: 12, organizationId: 'org-a', code: 'COLD-12' }
            : null),
        };
      }
      if (name === 'latticeTelemetryPoints') {
        return {
          create: async ({ values }) => {
            const row = { id: pointSeq++, ...values };
            points.push(row);
            return row;
          },
          find: async ({ filter = {} } = {}) => points.filter((r) => matchFilter(r, filter)),
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
            const row = { id: incidentSeq++, ...values, update: async (patch) => Object.assign(row, patch) };
            incidents.push(row);
            return row;
          },
        };
      }
      if (name === 'latticeDataQuarantine' && withQuarantineRepo) {
        return {
          create: async ({ values }) => {
            const row = { id: quarantineSeq++, createdAt: new Date(), ...values };
            quarantined.push(row);
            return row;
          },
          find: async ({ filter = {} } = {}) => quarantined.filter((r) => matchFilter(r, filter)),
        };
      }
      return null;
    },
  };

  return { db, points, incidents, quarantined };
}

test('ingestTelemetryPoint quarantines out-of-physical-range temperature glitches and bad sensor quality without polluting telemetry or alarms', async () => {
  const { ingestTelemetryPoint } = require(path.join(PLUGIN_ROOT, 'src/server/alarm-engine.js'));
  const { db, points, incidents, quarantined } = makeQuarantineTelemetryDb({ withQuarantineRepo: true });

  // 1. Out-of-physical-range glitches (< -100 or > 150 °C) -> quarantined
  for (const glitchVal of [-150, -100.1, 150.1, 999]) {
    const res = await ingestTelemetryPoint(db, {
      organizationId: 'org-a',
      assetId: 12,
      assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12',
      metricName: 'temperature',
      numericValue: glitchVal,
      unit: 'CEL',
      quality: 'good',
      sourceProtocol: 'mqtt',
    });
    assert.equal(res.quarantined, true);
    assert.equal(res.reasonCode, 'SENSOR_OUT_OF_PHYSICAL_RANGE');
    assert.ok(res.quarantineUid);
    assert.equal(res.point, null);
    assert.deepEqual(res.triggeredAlarms, []);
  }
  assert.equal(points.length, 0);
  assert.equal(incidents.length, 0);
  assert.equal(quarantined.length, 4);

  // 2. Explicit bad sensor quality flags even for normal physical temperature -> quarantined
  for (const badQual of ['bad', 'FAULT', 'corrupt', 'quarantined']) {
    const res = await ingestTelemetryPoint(db, {
      organizationId: 'org-a',
      assetId: 12,
      assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12',
      metricName: 'temperature',
      numericValue: 4.5,
      unit: 'CEL',
      quality: badQual,
    });
    assert.equal(res.quarantined, true);
    assert.equal(res.reasonCode, 'BAD_TELEMETRY_QUALITY');
    assert.ok(res.quarantineUid);
    assert.equal(res.point, null);
    assert.deepEqual(res.triggeredAlarms, []);
  }
  assert.equal(points.length, 0);
  assert.equal(incidents.length, 0);
  assert.equal(quarantined.length, 8);

  // 3. Normal cold-chain temperatures (-80 to +150 °C) with quality 'good' continue ingesting & firing alarms normally
  for (const okVal of [-80, -18, 4, 10, 35, 85]) {
    const res = await ingestTelemetryPoint(db, {
      organizationId: 'org-a',
      assetId: 12,
      assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12',
      metricName: 'temperature',
      numericValue: okVal,
      unit: 'CEL',
      quality: 'good',
    });
    assert.notEqual(res.quarantined, true);
    assert.ok(res.point);
    assert.equal(res.point.numericValue, okVal);
  }
  assert.equal(points.length, 6);
  assert.equal(incidents.length, 1); // triggered once for > -15 and coalesced

  // 4. Non-temperature metrics (e.g. voltage=220 without explicit unit:'CEL') are NOT falsely quarantined
  const voltRes = await ingestTelemetryPoint(db, {
    organizationId: 'org-a',
    assetId: 12,
    assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12',
    metricName: 'voltage',
    numericValue: 220,
    quality: 'good',
  });
  assert.notEqual(voltRes.quarantined, true);
  assert.equal(voltRes.point.numericValue, 220);

  // 5. bypassQuarantine: true skips quarantine check
  const bypassed = await ingestTelemetryPoint(db, {
    organizationId: 'org-a',
    assetId: 12,
    assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12',
    metricName: 'temperature',
    numericValue: 160,
    unit: 'CEL',
    quality: 'good',
    bypassQuarantine: true,
  });
  assert.notEqual(bypassed.quarantined, true);
  assert.equal(bypassed.point.numericValue, 160);

  // 6. Non-numeric/NaN/Infinity still fail closed 400 TELEMETRY_VALUE_INVALID before quarantine
  for (const invalidVal of [NaN, Infinity, -Infinity, 'abc', '', true, null]) {
    await assert.rejects(
      () => ingestTelemetryPoint(db, {
        organizationId: 'org-a',
        assetId: 12,
        assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12',
        metricName: 'temperature',
        numericValue: invalidVal,
      }),
      (err) => err.status === 400 && err.code === 'TELEMETRY_VALUE_INVALID',
    );
  }
});

test('ingestTelemetryPoint degrades cleanly when latticeDataQuarantine repo is absent and keeps zero cross-plugin require', async () => {
  const { ingestTelemetryPoint } = require(path.join(PLUGIN_ROOT, 'src/server/alarm-engine.js'));
  const { db, points } = makeQuarantineTelemetryDb({ withQuarantineRepo: false });

  const res = await ingestTelemetryPoint(db, {
    organizationId: 'org-a',
    assetId: 12,
    assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:12',
    metricName: 'temperature',
    numericValue: -18,
    unit: 'CEL',
    quality: 'good',
  });
  assert.equal(res.point.numericValue, -18);
  assert.equal(points.length, 1);

  const engineSrc = readFileSync(path.join(PLUGIN_ROOT, 'src/server/alarm-engine.js'), 'utf8');
  assert.equal(/require\([^)]*plugin-lattice-foundation/.test(engineSrc), false);
  assert.equal(/require\(['"]\.\.\//.test(engineSrc), false);
  assert.match(engineSrc, /SPDX-License-Identifier:\s*Apache-2\.0/);
});
