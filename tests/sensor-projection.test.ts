/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { expect, test } from 'vitest';
import { generateSensorFixtures } from '../scripts/lib/sensor-simulator.mjs';
import {
  buildSensorProjection,
  SENSOR_NAMESPACE as ns,
} from '../apps/api/src/sensors/projection';
import { SensorInputError } from '../apps/api/src/sensors/policy';

const readings = () => generateSensorFixtures({
  assetUrn: 'urn:ngsi-ld:Asset:org-a:uc1-demo-asset-001',
  referenceTime: '2026-10-24T08:00:00.000Z',
  seed: 'projection-test',
});

test('maps temperature onto the original Asset with source metadata', () => {
  const input = readings()[0];
  const result = buildSensorProjection(input, 'org-a');

  expect(result.kind).toBe('ready');
  if (result.kind !== 'ready') throw new Error('Expected ready projection');

  expect(result.assetUrn).toBe(input.assetUrn);
  expect(result.attribute).toBe(ns + 'temperature');
  expect(result.property).toEqual({
    type: 'Property',
    value: 25,
    observedAt: input.observedAt,
    unitCode: 'CEL',
    [ns + 'sourceSystem']: {
      type: 'Property',
      value: input.source.system,
    },
    [ns + 'sourceDeviceId']: {
      type: 'Property',
      value: input.source.deviceId,
    },
    [ns + 'sourceEventId']: {
      type: 'Property',
      value: input.eventId,
    },
    [ns + 'measurementQuality']: {
      type: 'Property',
      value: 'good',
    },
    [ns + 'simulated']: {
      type: 'Property',
      value: true,
    },
  });
});

test.each([
  ['missing', 'missing', 'VALUE_MISSING'],
  ['malformed', 'invalid', 'VALUE_NOT_FINITE_NUMBER'],
])('skips %s without producing a broker property', (scenario, quality, reason) => {
  const input = readings().find(
    r => r.simulation.scenario === scenario,
  )!;

  const result = buildSensorProjection(input, 'org-a');

  expect(result).toEqual({
    kind: 'skipped',
    eventId: input.eventId,
    assetUrn: input.assetUrn,
    quality,
    reason,
  });
  expect(result).not.toHaveProperty('property');
});

test.each(['humidity', 'batteryLevel'])(
  'maps %s with percent unit and preserves zero',
  attribute => {
    const result = buildSensorProjection({
      ...readings()[0],
      attribute,
      unit: 'percent',
      value: 0,
    }, 'org-a');

    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') throw new Error('Expected ready projection');

    expect(result.attribute).toBe(ns + attribute);
    expect(result.property.value).toBe(0);
    expect(result.property.unitCode).toBe('P1');
  },
);

test('does not infer freshness or rewrite an old observation time', () => {
  const input = readings().find(
    r => r.simulation.scenario === 'stale',
  )!;

  const result = buildSensorProjection(input, 'org-a');

  expect(result.kind).toBe('ready');
  if (result.kind !== 'ready') throw new Error('Expected ready projection');

  expect(result.property.observedAt).toBe('2026-10-24T07:00:00.000Z');
});

test('replay is deterministic and the source input remains unchanged', () => {
  const input = readings()[0];
  const before = JSON.stringify(input);

  expect(buildSensorProjection(input, 'org-a'))
    .toEqual(buildSensorProjection(input, 'org-a'));
  expect(JSON.stringify(input)).toBe(before);
});

test('rejects an Asset from another tenant', () => {
  expect(() => buildSensorProjection(readings()[0], 'org-b'))
    .toThrow(SensorInputError);
});

test('ignores supplied quality and never projects an invalid value', () => {
  const result = buildSensorProjection({
    ...readings()[0],
    value: '85',
    quality: 'good',
  }, 'org-a');

  expect(result.kind).toBe('skipped');
  expect(result).not.toHaveProperty('property');
});

test('keeps the projection separate from Asset status and relationships', () => {
  const result = buildSensorProjection(readings()[0], 'org-a');

  expect(result).not.toHaveProperty('status');
  expect(result).not.toHaveProperty('belongsToDepartment');
  expect(result).not.toHaveProperty('locatedAt');

  if (result.kind !== 'ready') throw new Error('Expected ready projection');
  expect(result.attribute).not.toBe(ns + 'status');
});