// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'vitest';
import {
  normalizeBrokerEntity,
} from '../scripts/lib/ngsi-ld-client.mjs';

const ns = 'https://latticedx.example/ns/';

test('normalizes expanded Department response without changing identity', () => {
  const result = normalizeBrokerEntity({
    id: 'urn:ngsi-ld:Department:org-a:it',
    type: ns + 'Department',
    [ns + 'organizationId']: { type: 'Property', value: 'org-a' },
    [ns + 'businessId']: { type: 'Property', value: 'it' },
  });

  expect(result).toEqual({
    id: 'urn:ngsi-ld:Department:org-a:it',
    type: 'Department',
    organizationId: { type: 'Property', value: 'org-a' },
    businessId: { type: 'Property', value: 'it' },
  });
});

test('preserves compact entity responses', () => {
  const entity = {
    id: 'urn:ngsi-ld:Location:org-a:office-1',
    type: 'Location',
    organizationId: { type: 'Property', value: 'org-a' },
  };

  expect(normalizeBrokerEntity(entity)).toEqual(entity);
});

test('normalizes Asset relationships and retains source timestamp', () => {
  const relationship = {
    type: 'Relationship',
    object: 'urn:ngsi-ld:Department:org-a:it',
    observedAt: '2026-10-22T10:00:00.123Z',
  };

  const result = normalizeBrokerEntity({
    id: 'urn:ngsi-ld:Asset:org-a:demo',
    type: ns + 'Asset',
    [ns + 'department']: relationship,
  });

  expect(result.type).toBe('Asset');
  expect(result.belongsToDepartment).toEqual(relationship);
});

test('rejects conflicting compact and expanded attribute names', () => {
  expect(() => normalizeBrokerEntity({
    type: 'Asset',
    organizationId: { type: 'Property', value: 'org-a' },
    [ns + 'organizationId']: { type: 'Property', value: 'org-b' },
  })).toThrow(/Ambiguous broker attribute/);
});

test('does not reinterpret another namespace as a trusted entity type', () => {
  const type = 'https://other.example/Department';
  expect(normalizeBrokerEntity({ type }).type).toBe(type);
});