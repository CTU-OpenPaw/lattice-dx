// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'vitest';
import type { WorkflowEvent } from '@dx/contracts';
import {
  mapHandoverToAsset,
  type MappingOptions,
} from '../apps/api/src/uc1-integration/asset-mapping';

function fixture(): WorkflowEvent {
  return {
    eventId: 'handover-001',
    eventType: 'asset.handed_over',
    organizationId: 'org-a',
    runId: 'run-001',
    recordId: 'record-001',
    definitionId: 'procurement',
    version: 6,
    occurredAt: '2026-10-22T10:00:00.123Z',
    data: {
      assetId: 'source-asset-001',
      departmentId: 'source-department-001',
      locationId: 'source-location-001',
      recipientId: 'fixture-recipient',
      attachmentId: 'fixture-attachment',
    },
  };
}

function options(): MappingOptions {
  return {
    organizationId: 'org-a',
    sourceSystem: 'latticedx',
    mappings: [
      {
        organizationId: 'org-a',
        sourceSystem: 'latticedx',
        sourceEntityType: 'Asset',
        sourceId: 'source-asset-001',
        brokerUrn: 'urn:ngsi-ld:Asset:org-a:laptop-001',
        name: 'Demo laptop',
      },
      {
        organizationId: 'org-a',
        sourceSystem: 'latticedx',
        sourceEntityType: 'Department',
        sourceId: 'source-department-001',
        brokerUrn: 'urn:ngsi-ld:Department:org-a:it',
      },
      {
        organizationId: 'org-a',
        sourceSystem: 'latticedx',
        sourceEntityType: 'Location',
        sourceId: 'source-location-001',
        brokerUrn: 'urn:ngsi-ld:Location:org-a:office-1',
      },
    ],
  };
}

test('resolves source IDs through explicit mappings', () => {
  const { entity } = mapHandoverToAsset(fixture(), options());

  expect(entity.id).toBe('urn:ngsi-ld:Asset:org-a:laptop-001');
  expect(entity.businessId.value).toBe('laptop-001');
  expect(entity.belongsToDepartment.object)
    .toBe('urn:ngsi-ld:Department:org-a:it');
  expect(entity.locatedAt.object)
    .toBe('urn:ngsi-ld:Location:org-a:office-1');
  expect(entity.status.value).toBe('in_use');
});

test('different handovers of the same Asset retain the same URN', () => {
  const first = fixture();
  const second = {
    ...fixture(),
    eventId: 'handover-002',
    runId: 'run-002',
    recordId: 'record-002',
    occurredAt: '2026-10-23T10:00:00Z',
  };

  const a = mapHandoverToAsset(first, options());
  const b = mapHandoverToAsset(second, options());

  expect(b.entity.id).toBe(a.entity.id);
  expect(b.entity.sourceEventId.value).toBe('handover-002');
  expect(b.entity.status.observedAt).toBe(second.occurredAt);
});

test('replay produces exactly the same projection', () => {
  expect(mapHandoverToAsset(fixture(), options()))
    .toEqual(mapHandoverToAsset(fixture(), options()));
});

test('preserves source time and excludes transactional fields', () => {
  const event = fixture();
  const result = mapHandoverToAsset(event, options());

  expect(result.entity.status.observedAt).toBe(event.occurredAt);
  expect(result.entity.locatedAt.observedAt).toBe(event.occurredAt);
  expect(result.entity).not.toHaveProperty('recipientId');
  expect(result.entity).not.toHaveProperty('attachmentId');
  expect(result.entity).not.toHaveProperty('data');
  expect(result.attributes).not.toHaveProperty('name');
});

test('rejects an event from another tenant', () => {
  expect(() => mapHandoverToAsset(
    { ...fixture(), organizationId: 'org-b' },
    options(),
  )).toThrow(/organization/);
});

test.each(['Asset', 'Department', 'Location'])(
  'rejects missing %s mapping',
  (type) => {
    const config = options();
    config.mappings = config.mappings.filter(
      (mapping) => mapping.sourceEntityType !== type,
    );

    expect(() => mapHandoverToAsset(fixture(), config))
      .toThrow(/Missing/);
  },
);

test('rejects ambiguous mappings', () => {
  const config = options();
  config.mappings = [...config.mappings, { ...config.mappings[0]! }];

  expect(() => mapHandoverToAsset(fixture(), config))
    .toThrow(/Multiple/);
});

test.each([
  'urn:ngsi-ld:Department:org-b:it',
  'urn:ngsi-ld:Location:org-a:it',
  'urn:ngsi-ld:Department:org-a:invalid id',
])('rejects invalid Department URN: %s', (brokerUrn) => {
  const config = options();
  config.mappings = config.mappings.map((mapping) =>
    mapping.sourceEntityType === 'Department'
      ? { ...mapping, brokerUrn }
      : mapping,
  );

  expect(() => mapHandoverToAsset(fixture(), config))
    .toThrow(/URN/);
});

test('does not invent an Asset display name', () => {
  const config = options();
  config.mappings = config.mappings.map((mapping) =>
    mapping.sourceEntityType === 'Asset'
      ? { ...mapping, name: undefined }
      : mapping,
  );

  expect(() => mapHandoverToAsset(fixture(), config))
    .toThrow(/name/);
});

test.each(['assetId', 'departmentId', 'locationId'])(
  'rejects missing source field: %s',
  (field) => {
    const event = fixture();
    delete event.data[field];

    expect(() => mapHandoverToAsset(event, options()))
      .toThrow(/required/);
  },
);

test.each(['invalid', '2026-02-30T10:00:00Z'])(
  'rejects invalid source timestamp: %s',
  (occurredAt) => {
    expect(() => mapHandoverToAsset(
      { ...fixture(), occurredAt },
      options(),
    )).toThrow(/occurredAt/);
  },
);