/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { sensorReadingsFromNotification } from '../apps/api/src/sensor-rules/broker-notification.js';
import { buildSensorProjection } from '../apps/api/src/sensors/projection.js';
import { parseSensorRule } from '../apps/api/src/sensor-rules/policy.js';

const tenant = 'org-a';
const subscriptionId = 'urn:ngsi-ld:Subscription:sensor-test';
const mapping = {
  assetEntityId: '11111111-1111-4111-8111-111111111111',
  assetUrn: 'urn:ngsi-ld:Asset:org-a:native:1',
};
const rule = parseSensorRule({
  id: '22222222-2222-4222-8222-222222222222', schemaId: 'incident-rule', schemaVersion: 1, version: 1,
  attributes: { assetEntityId: mapping.assetEntityId, attribute: 'temperature', operator: 'gt', threshold: '80', unit: 'celsius',
    maxObservationAgeSeconds: '600', cooldownSeconds: '300', severity: 'high', enabled: true,
    workflowDefinitionId: 'incident-response', workflowDefinitionVersion: '1', handlerId: '2' },
});
const reading = { schemaVersion: 1, assetUrn: mapping.assetUrn, attribute: 'temperature', unit: 'celsius', value: 85,
  eventId: 'sim:duplicate-test', observedAt: '2026-11-16T01:00:00.000Z',
  source: { system: 'sensor-test', deviceId: 'fixture-1' }, simulated: true };
const projection = buildSensorProjection(reading, tenant);
if (projection.kind !== 'ready') throw new Error('Expected projected fixture');
const measurement = { id: mapping.assetUrn, [projection.attribute]: projection.property };
const notification = { type: 'Notification', subscriptionId, data: [measurement] };
const options = { tenant, subscriptionId, mapping, rule };

describe('native sensor rule notification', () => {
  it('preserves the source event identity across broker retries', () => {
    expect(sensorReadingsFromNotification({ ...notification, id: 'delivery-1' }, options)).toEqual([reading]);
    expect(sensorReadingsFromNotification({ ...notification, id: 'delivery-2' }, options)).toEqual([reading]);
  });
  it('rejects a different subscription or Asset', () => {
    expect(() => sensorReadingsFromNotification({ ...notification, subscriptionId: 'another-subscription' }, options)).toThrow();
    expect(() => sensorReadingsFromNotification({ ...notification, data: [{ ...measurement, id: 'foreign' }] }, options)).toThrow();
  });
  it('rejects impossible calendar dates and timezone-less observedAt values', () => {
    for (const badTime of ['2026-02-31T00:00:00Z', '2026-10-19T10:00:00', '2026-10-19T10:00:00+07:00']) {
      const badMeasurement = {
        ...measurement,
        [projection.attribute]: { ...projection.property, observedAt: badTime },
      };
      expect(() => sensorReadingsFromNotification({ ...notification, data: [badMeasurement] }, options)).toThrow();
    }
  });
});
