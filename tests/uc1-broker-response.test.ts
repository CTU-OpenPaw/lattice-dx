/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, expect, test, vi } from 'vitest';
import {
  createAssetConnector,
  normalizeBrokerEntity,
} from '../scripts/lib/ngsi-ld-client.mjs';

const ns = 'https://latticedx.example/ns/';

afterEach(() => {
  vi.unstubAllGlobals();
});

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

test('updates use POST attrs so missing attributes are added without replacing unrelated ones', async () => {
  const id = 'urn:ngsi-ld:Asset:org-a:demo';
  const context = { Asset: ns + 'Asset', status: ns + 'status' };
  const attributes = {
    status: { type: 'Property', value: 'in_use', observedAt: '2026-10-22T10:00:00Z' },
    sourceEventId: { type: 'Property', value: 'handover-002' },
  };
  const transport = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', transport);
  const connector = createAssetConnector({
    baseUrl: 'http://broker.test',
    tenant: 'org-a',
    context,
  });

  await connector.updateAsset(id, attributes);

  const [url, options] = transport.mock.calls[0]!;
  expect(url).toBe(
    `http://broker.test/ngsi-ld/v1/entities/${encodeURIComponent(id)}/attrs`,
  );
  expect(options.method).toBe('POST');
  expect(options.headers['Content-Type']).toBe('application/ld+json');
  expect(JSON.parse(options.body)).toEqual({ ...attributes, '@context': context });
});
