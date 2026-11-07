// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  parseSensorAssetUrn,
} from '../apps/api/src/sensors/asset-identity.js';
import {
  parseSensorReading,
} from '../apps/api/src/sensors/policy.js';

describe('sensor Asset identity', () => {
  it('preserves a legacy business ID', () => {
    expect(
      parseSensorAssetUrn(
        'urn:ngsi-ld:Asset:org-a:uc1-demo-asset-001',
        'org-a',
      ),
    ).toEqual({
      kind: 'legacy',
      organizationId: 'org-a',
      businessId: 'uc1-demo-asset-001',
      urn: 'urn:ngsi-ld:Asset:org-a:uc1-demo-asset-001',
    });
  });

  it('parses a native record ID', () => {
    expect(
      parseSensorAssetUrn(
        'urn:ngsi-ld:Asset:org-a:native:12',
        'org-a',
      ),
    ).toEqual({
      kind: 'native',
      organizationId: 'org-a',
      recordId: '12',
      urn: 'urn:ngsi-ld:Asset:org-a:native:12',
    });
  });

  it('preserves IDs beyond JavaScript safe integer precision', () => {
    const identity = parseSensorAssetUrn(
      'urn:ngsi-ld:Asset:org-a:native:9223372036854775807',
      'org-a',
    );

    expect(identity.kind).toBe('native');

    if (identity.kind === 'native') {
      expect(identity.recordId).toBe('9223372036854775807');
      expect(typeof identity.recordId).toBe('string');
    }
  });

  it.each([
    '0',
    '-1',
    '01',
    '1.5',
    '1e3',
    '+12',
    '12 ',
    '9223372036854775808',
    '12345678901234567890',
    '',
  ])('rejects invalid native ID: %j', id => {
    expect(() =>
      parseSensorAssetUrn(
        `urn:ngsi-ld:Asset:org-a:native:${id}`,
        'org-a',
      ),
    ).toThrow();
  });

  it.each([
    'urn:ngsi-ld:Asset:org-b:native:12',
    'urn:ngsi-ld:Department:org-a:native:12',
    'urn:ngsi-ld:Asset:org-a:native:12:extra',
    'urn:ngsi-ld:Asset:org-a:business:id',
    'urn:ngsi-ld:Asset:org-a:',
    'urn:ngsi-ld:Asset:org-a:asset%2F12',
    null,
    12,
  ])('rejects wrong tenant, type or malformed URN: %j', urn => {
    expect(() => parseSensorAssetUrn(urn, 'org-a')).toThrow();
  });

  it('preserves case in a legacy business ID', () => {
    const identity = parseSensorAssetUrn(
      'urn:ngsi-ld:Asset:org-a:Pump_A',
      'org-a',
    );

    expect(identity.urn).toBe('urn:ngsi-ld:Asset:org-a:Pump_A');
  });

  it('enforces the native organization length limit', () => {
    const organizationId = 'a'.repeat(81);

    expect(() =>
      parseSensorAssetUrn(
        `urn:ngsi-ld:Asset:${organizationId}:native:12`,
        organizationId,
      ),
    ).toThrow();
  });

  it.each(['', 'org/a', 'org a'])(
    'rejects invalid configured organization: %j',
    organizationId => {
      expect(() =>
        parseSensorAssetUrn(
          'urn:ngsi-ld:Asset:org-a:native:12',
          organizationId,
        ),
      ).toThrow();
    },
  );

  it.each([
    'urn:ngsi-ld:Asset:org-a:uc1-demo-asset-001',
    'urn:ngsi-ld:Asset:org-a:native:12',
  ])('sensor policy accepts supported Asset identity: %s', assetUrn => {
    const reading = parseSensorReading({
      schemaVersion: 1,
      eventId: 'sim:asset-identity-fixture',
      assetUrn,
      attribute: 'temperature',
      unit: 'celsius',
      value: 85,
      observedAt: '2026-11-07T08:00:00.000Z',
      source: {
        system: 'latticedx-simulator',
        deviceId: 'simulated-temperature-001',
      },
      simulated: true,
    }, 'org-a');

    expect(reading.assetUrn).toBe(assetUrn);
    expect(reading.quality).toBe('good');
    expect(reading.value).toBe(85);
  });
});