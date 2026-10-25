// SPDX-License-Identifier: Apache-2.0
import { expect, test, vi } from 'vitest';
import { generateSensorFixtures } from '../scripts/lib/sensor-simulator.mjs';
import {
  buildSensorProjection,
  SENSOR_NAMESPACE as ns,
} from '../apps/api/src/sensors/projection';
import { syncSensorReading } from '../apps/api/src/sensors/broker-sync';

function reading() {
  return generateSensorFixtures({
    assetUrn: 'urn:ngsi-ld:Asset:org-a:uc1-demo-asset-001',
    referenceTime: '2026-10-24T08:00:00.000Z',
    seed: 'broker-sync-test',
  })[0];
}

function projection(input = reading()) {
  const result = buildSensorProjection(input, 'org-a');
  if (result.kind !== 'ready') throw new Error('Expected ready projection');
  return result;
}

function asset(
  measurement?: Record<string, unknown>,
): Record<string, unknown> {
  const input = reading();

  return {
    id: input.assetUrn,
    type: ns + 'Asset',
    [ns + 'organizationId']: { type: 'Property', value: 'org-a' },
    [ns + 'businessId']: {
      type: 'Property',
      value: 'uc1-demo-asset-001',
    },
    [ns + 'status']: { type: 'Property', value: 'in_use' },
    ...(measurement === undefined
      ? {}
      : { [ns + 'temperature']: measurement }),
  };
}

function fixture(initial = asset()) {
  let stored = structuredClone(initial);

  const getAsset = vi.fn(async (_id: string) => structuredClone(stored));

  const appendMeasurement = vi.fn(
    async (input: ReturnType<typeof projection>) => {
      stored[input.attribute] = structuredClone(input.property);
    },
  );

  return {
    broker: { getAsset, appendMeasurement },
    stored: () => structuredClone(stored),
  };
}

test('adds a reading, reads it back and preserves Asset status', async () => {
  const f = fixture();

  expect(await syncSensorReading(f.broker, reading(), 'org-a'))
    .toBe('updated');

  expect(f.broker.getAsset).toHaveBeenCalledTimes(2);
  expect(f.broker.appendMeasurement).toHaveBeenCalledTimes(1);
  expect(f.stored()[ns + 'temperature']).toEqual(projection().property);
  expect(f.stored()[ns + 'status'])
    .toEqual({ type: 'Property', value: 'in_use' });
});

test('exact replay does not write again', async () => {
  const f = fixture(asset(projection().property));

  expect(await syncSensorReading(f.broker, reading(), 'org-a'))
    .toBe('duplicate');

  expect(f.broker.appendMeasurement).not.toHaveBeenCalled();
});

test('older input cannot overwrite a newer measurement', async () => {
  const current = projection().property;
  const f = fixture(asset({
    ...current,
    observedAt: '2026-10-24T08:00:00.000Z',
  }));

  expect(await syncSensorReading(f.broker, reading(), 'org-a'))
    .toBe('stale');

  expect(f.broker.appendMeasurement).not.toHaveBeenCalled();
});

test('a newer observation updates the same Asset', async () => {
  const f = fixture(asset(projection().property));
  const newer = {
    ...reading(),
    eventId: 'sensor:newer',
    observedAt: '2026-10-24T08:00:01.000Z',
    value: 85,
  };

  expect(await syncSensorReading(f.broker, newer, 'org-a'))
    .toBe('updated');

  expect(f.stored().id).toBe(reading().assetUrn);
  expect(f.stored()[ns + 'temperature'])
    .toEqual(projection(newer).property);
});

test.each([
  { value: 99 },
  { unitCode: 'P1' },
  {
    [ns + 'sourceEventId']: {
      type: 'Property',
      value: 'another-event',
    },
  },
])('equal-time disagreement fails without writing: %j', change => {
  const f = fixture(asset({ ...projection().property, ...change }));

  return expect(syncSensorReading(f.broker, reading(), 'org-a'))
    .rejects.toMatchObject({ code: 'MEASUREMENT_TIME_CONFLICT' })
    .then(() => {
      expect(f.broker.appendMeasurement).not.toHaveBeenCalled();
    });
});

test.each(['sourceSystem', 'sourceDeviceId'])(
  'does not take over a different %s',
  async name => {
    const f = fixture(asset({
      ...projection().property,
      [ns + name]: { type: 'Property', value: 'another-owner' },
    }));

    await expect(syncSensorReading(f.broker, reading(), 'org-a'))
      .rejects.toMatchObject({ code: 'MEASUREMENT_SOURCE_CONFLICT' });

    expect(f.broker.appendMeasurement).not.toHaveBeenCalled();
  },
);

test.each(['missing', 'malformed'])(
  '%s input does not contact the broker',
  async scenario => {
    const input = generateSensorFixtures({
      assetUrn: reading().assetUrn,
      referenceTime: '2026-10-24T08:00:00.000Z',
    }).find(r => r.simulation.scenario === scenario)!;

    const f = fixture();

    expect(await syncSensorReading(f.broker, input, 'org-a'))
      .toBe('skipped');

    expect(f.broker.getAsset).not.toHaveBeenCalled();
    expect(f.broker.appendMeasurement).not.toHaveBeenCalled();
  },
);

test('rejects an Asset with mismatched tenant identity', async () => {
  const f = fixture({
    ...asset(),
    [ns + 'organizationId']: { type: 'Property', value: 'org-b' },
  });

  await expect(syncSensorReading(f.broker, reading(), 'org-a'))
    .rejects.toMatchObject({ code: 'ASSET_IDENTITY_MISMATCH' });

  expect(f.broker.appendMeasurement).not.toHaveBeenCalled();
});

test('rejects ambiguous compact and expanded attributes', async () => {
  const f = fixture({
    ...asset(projection().property),
    temperature: projection().property,
  });

  await expect(syncSensorReading(f.broker, reading(), 'org-a'))
    .rejects.toMatchObject({ code: 'AMBIGUOUS_BROKER_ATTRIBUTE' });

  expect(f.broker.appendMeasurement).not.toHaveBeenCalled();
});

test('HTTP write success without matching read-back is not accepted', async () => {
  const f = fixture();
  f.broker.appendMeasurement.mockImplementation(async () => {});

  await expect(syncSensorReading(f.broker, reading(), 'org-a'))
    .rejects.toMatchObject({ code: 'BROKER_READBACK_MISMATCH' });
});

test('lost write response can be retried without writing twice', async () => {
  const f = fixture();

  f.broker.appendMeasurement.mockImplementationOnce(async input => {
    f.broker.getAsset.mockResolvedValue(asset(input.property));
    throw new Error('Simulated lost write response');
  });

  await expect(syncSensorReading(f.broker, reading(), 'org-a'))
    .rejects.toThrow('Simulated lost write response');

  expect(await syncSensorReading(f.broker, reading(), 'org-a'))
    .toBe('duplicate');

  expect(f.broker.appendMeasurement).toHaveBeenCalledTimes(1);
});

test('broker timestamp truncation cannot silently pass read-back', async () => {
  const f = fixture();
  const input = {
    ...reading(),
    observedAt: '2026-10-24T07:59:56.123Z',
  };

  f.broker.appendMeasurement.mockImplementationOnce(async projected => {
    f.broker.getAsset.mockResolvedValue(asset({
      ...projected.property,
      observedAt: '2026-10-24T07:59:56Z',
    }));
  });

  await expect(syncSensorReading(f.broker, input, 'org-a'))
    .rejects.toMatchObject({ code: 'BROKER_READBACK_MISMATCH' });
});