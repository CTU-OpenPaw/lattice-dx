/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import {
  generateSensorFixtures,
  SENSOR_SCENARIOS,
} from '../scripts/lib/sensor-simulator.mjs';

const options = {
  assetUrn: 'urn:ngsi-ld:Asset:org-a:uc1-demo-asset-001',
  referenceTime: '2026-10-24T08:00:00.000Z',
  seed: 'uc2-demo-v1',
};

const cli = fileURLToPath(
  new URL('../scripts/simulate-sensor.mjs', import.meta.url),
);

test('generates five distinct, explicitly simulated scenarios', () => {
  const readings = generateSensorFixtures(options);

  expect(readings.map(r => r.simulation.scenario))
    .toEqual([...SENSOR_SCENARIOS]);
  expect(new Set(readings.map(r => r.eventId)).size).toBe(5);

  for (const reading of readings) {
    expect(reading.assetUrn).toBe(options.assetUrn);
    expect(reading.simulated).toBe(true);
    expect(reading.source.system).toBe('latticedx-simulator');
    expect(reading.attribute).toBe('temperature');
    expect(reading.unit).toBe('celsius');
    expect(reading.eventId).toMatch(/^sim:[a-f0-9]{64}$/);
  }
});

test('preserves numeric, missing and malformed fixture values', () => {
  const readings = generateSensorFixtures(options);
  const byScenario = (name: string) =>
    readings.find(r => r.simulation.scenario === name)!;

  expect(byScenario('normal').value).toBe(25);
  expect(byScenario('anomalous').value).toBe(85);
  expect(byScenario('missing')).not.toHaveProperty('value');
  expect(byScenario('malformed').value).toBe('not-a-number');

  expect(JSON.parse(JSON.stringify(byScenario('missing'))))
    .not.toHaveProperty('value');
});

test('stale observation is exactly one hour older than reference time', () => {
  const readings = generateSensorFixtures(options);
  const referenceMs = Date.parse(options.referenceTime);

  for (const reading of readings) {
    const age = referenceMs - Date.parse(reading.observedAt);
    expect(age).toBe(
      reading.simulation.scenario === 'stale'
        ? 3_600_000
        : {
            normal: 4000,
            anomalous: 3000,
            missing: 2000,
            malformed: 1000,
          }[reading.simulation.scenario],
    );
  }
});

test('exact replay preserves all payloads and event IDs', () => {
  expect(generateSensorFixtures(options))
    .toEqual(generateSensorFixtures(options));
});

test.each([
  { seed: 'different-seed' },
  { referenceTime: '2026-10-24T08:01:00.000Z' },
  { assetUrn: 'urn:ngsi-ld:Asset:org-a:another-asset' },
])('changed scenario inputs produce different event IDs: %j', change => {
  const original = generateSensorFixtures(options);
  const changed = generateSensorFixtures({ ...options, ...change });

  expect(changed.every((r, index) =>
    r.eventId !== original[index].eventId,
  )).toBe(true);
});

test.each([
  '',
  'not-a-urn',
  'urn:ngsi-ld:Department:org-a:it',
  'urn:ngsi-ld:Asset:org-a:bad/id',
  'urn:ngsi-ld:Asset::asset',
])('rejects invalid Asset identity: %s', assetUrn => {
  expect(() => generateSensorFixtures({ ...options, assetUrn }))
    .toThrow();
});

test.each([
  'not-a-date',
  '2026-02-30T08:00:00.000Z',
  '2026-10-24T08:00:00Z',
  '2026-10-24T15:00:00.000+07:00',
  '1970-01-01T00:00:00.000Z',
])('rejects invalid or unsupported reference time: %s', referenceTime => {
  expect(() => generateSensorFixtures({ ...options, referenceTime }))
    .toThrow();
});

test.each(['', 'bad seed', 'x'.repeat(65)])(
  'rejects invalid seed: %j',
  seed => {
    expect(() => generateSensorFixtures({ ...options, seed })).toThrow();
  },
);

test('CLI emits only five replayable JSON lines', () => {
  const args = [
    cli,
    options.assetUrn,
    options.referenceTime,
    options.seed,
  ];

  const first = execFileSync(process.execPath, args, { encoding: 'utf8' });
  const second = execFileSync(process.execPath, args, { encoding: 'utf8' });

  expect(first).toBe(second);
  expect(first.trim().split('\n').map(line => JSON.parse(line)))
    .toEqual(generateSensorFixtures(options));
});

test('CLI rejects missing arguments without emitting fixture data', () => {
  const result = spawnSync(process.execPath, [cli], { encoding: 'utf8' });

  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('Usage:');
});