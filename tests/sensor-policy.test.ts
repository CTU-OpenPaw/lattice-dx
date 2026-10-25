// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'vitest';
import { generateSensorFixtures } from '../scripts/lib/sensor-simulator.mjs';
import {
  parseSensorReading,
  SensorInputError,
} from '../apps/api/src/sensors/policy';

const options = {
  assetUrn: 'urn:ngsi-ld:Asset:org-a:uc1-demo-asset-001',
  referenceTime: '2026-10-24T08:00:00.000Z',
  seed: 'uc2-demo-v1',
};

function fixture() {
  return generateSensorFixtures(options)[0];
}

test('preserves source identity and observation time without mutating input', () => {
  const input = fixture();
  const before = JSON.stringify(input);
  const result = parseSensorReading(input, 'org-a');

  expect(result).toMatchObject({
    eventId: input.eventId,
    assetUrn: input.assetUrn,
    attribute: 'temperature',
    unit: 'celsius',
    value: 25,
    observedAt: input.observedAt,
    source: input.source,
    simulated: true,
    quality: 'good',
    qualityReason: null,
  });

  expect(JSON.stringify(input)).toBe(before);
  result.source.deviceId = 'changed';
  expect(input.source.deviceId).toBe('simulated-temperature-001');
});

test('classifies all five simulator scenarios independently', () => {
  const readings = generateSensorFixtures(options);

  expect(readings.map(reading =>
    parseSensorReading(reading, 'org-a').quality,
  )).toEqual(['good', 'good', 'missing', 'good', 'invalid']);
});

test('does not trust caller-supplied quality or simulation labels', () => {
  const result = parseSensorReading({
    ...fixture(),
    value: '85',
    quality: 'good',
    simulation: { scenario: 'normal' },
  }, 'org-a');

  expect(result.quality).toBe('invalid');
  expect(result.qualityReason).toBe('VALUE_NOT_FINITE_NUMBER');
  expect(result).not.toHaveProperty('value');
});

test('missing value remains distinct from zero', () => {
  const input: Record<string, unknown> = { ...fixture() };
  delete input.value;

  expect(parseSensorReading(input, 'org-a')).toMatchObject({
    quality: 'missing',
    qualityReason: 'VALUE_MISSING',
  });
  expect(parseSensorReading(input, 'org-a')).not.toHaveProperty('value');

  expect(parseSensorReading({ ...input, value: 0 }, 'org-a'))
    .toMatchObject({ quality: 'good', value: 0 });
});

test.each([null, undefined, '85', '', true, {}, [], NaN, Infinity, -Infinity])(
  'invalid measurement is not coerced: %j',
  value => {
    const result = parseSensorReading({ ...fixture(), value }, 'org-a');

    expect(result.quality).toBe('invalid');
    expect(result.qualityReason).toBe('VALUE_NOT_FINITE_NUMBER');
    expect(result).not.toHaveProperty('value');
  },
);

test.each(['humidity', 'batteryLevel'])(
  '%s accepts percent boundaries and rejects out-of-range values',
  attribute => {
    for (const value of [0, 50.5, 100]) {
      expect(parseSensorReading({
        ...fixture(), attribute, unit: 'percent', value,
      }, 'org-a')).toMatchObject({ quality: 'good', value });
    }

    for (const value of [-0.1, 100.1]) {
      const result = parseSensorReading({
        ...fixture(), attribute, unit: 'percent', value,
      }, 'org-a');

      expect(result.quality).toBe('invalid');
      expect(result.qualityReason).toBe('PERCENT_OUT_OF_RANGE');
      expect(result).not.toHaveProperty('value');
    }
  },
);

test('allows finite negative temperature without inventing a device range', () => {
  expect(parseSensorReading({
    ...fixture(), value: -20.5,
  }, 'org-a')).toMatchObject({ quality: 'good', value: -20.5 });
});

test.each([
  null,
  [],
  {},
  { ...fixture(), schemaVersion: 2 },
  { ...fixture(), eventId: '' },
  { ...fixture(), eventId: 'bad key' },
  { ...fixture(), eventId: 'x'.repeat(129) },
  { ...fixture(), assetUrn: 'urn:ngsi-ld:Asset:org-b:asset-001' },
  { ...fixture(), assetUrn: 'urn:ngsi-ld:Department:org-a:it' },
  { ...fixture(), assetUrn: 'urn:ngsi-ld:Asset:org-a:bad/id' },
  { ...fixture(), attribute: 'pressure' },
  { ...fixture(), unit: 'percent' },
  { ...fixture(), attribute: 'humidity', unit: 'celsius' },
  { ...fixture(), observedAt: '2026-02-30T08:00:00.000Z' },
  { ...fixture(), observedAt: '2026-10-24T08:00:00Z' },
  { ...fixture(), observedAt: '2026-10-24T15:00:00.000+07:00' },
  { ...fixture(), source: null },
  { ...fixture(), source: { system: 'source', deviceId: '' } },
  { ...fixture(), source: { system: 'source\n', deviceId: 'device' } },
  { ...fixture(), simulated: 'true' },
  { ...fixture(), simulated: undefined },
])('rejects invalid envelopes before persistence: %j', input => {
  expect(() => parseSensorReading(input, 'org-a'))
    .toThrow(SensorInputError);
});

test.each(['', 'org a', 'org/a', 'x'.repeat(129)])(
  'rejects invalid configured tenant: %j',
  tenant => {
    expect(() => parseSensorReading(fixture(), tenant))
      .toThrow(SensorInputError);
  },
);

test('accepts an explicit non-simulated reading without granting source authority', () => {
  expect(parseSensorReading({
    ...fixture(), simulated: false,
  }, 'org-a').simulated).toBe(false);
});