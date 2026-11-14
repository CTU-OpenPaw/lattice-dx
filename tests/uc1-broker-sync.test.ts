/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { expect, test } from 'vitest';
import type { WorkflowEvent } from '@dx/contracts';
import {
  mapHandoverToAsset,
  type MappingOptions,
} from '../apps/api/src/uc1-integration/asset-mapping';
import {
  observationTime,
  syncAssetProjection,
  type BrokerPort,
} from '../apps/api/src/uc1-integration/broker-sync';

function projection(
  eventId = 'handover-001',
  occurredAt = '2026-10-22T10:00:00Z',
) {
  const event: WorkflowEvent = {
    eventId,
    eventType: 'asset.handed_over',
    organizationId: 'org-a',
    runId: 'run-001',
    recordId: 'record-001',
    definitionId: 'procurement',
    version: 6,
    occurredAt,
    data: {
      assetId: 'asset-source',
      departmentId: 'department-source',
      locationId: 'location-source',
      recipientId: 'recipient-fixture',
      attachmentId: 'attachment-fixture',
    },
  };

  const options: MappingOptions = {
    organizationId: 'org-a',
    sourceSystem: 'latticedx',
    mappings: [
      {
        organizationId: 'org-a',
        sourceSystem: 'latticedx',
        sourceEntityType: 'Asset',
        sourceId: 'asset-source',
        brokerUrn: 'urn:ngsi-ld:Asset:org-a:uc1-demo-001',
        name: 'UC1 demo Asset',
      },
      {
        organizationId: 'org-a',
        sourceSystem: 'latticedx',
        sourceEntityType: 'Department',
        sourceId: 'department-source',
        brokerUrn: 'urn:ngsi-ld:Department:org-a:it',
      },
      {
        organizationId: 'org-a',
        sourceSystem: 'latticedx',
        sourceEntityType: 'Location',
        sourceId: 'location-source',
        brokerUrn: 'urn:ngsi-ld:Location:org-a:office-1',
      },
    ],
  };

  return mapHandoverToAsset(event, options);
}

function setup() {
  const entities = new Map<string, Record<string, unknown>>();

  for (const [type, businessId] of [
    ['Department', 'it'],
    ['Location', 'office-1'],
  ]) {
    const id = `urn:ngsi-ld:${type}:org-a:${businessId}`;
    entities.set(id, {
      id,
      type,
      businessId: { type: 'Property', value: businessId },
      organizationId: { type: 'Property', value: 'org-a' },
    });
  }

  let creates = 0;
  let updates = 0;
  let loseCreateResponse = false;
  let truncateTimestamp = false;

  const broker: BrokerPort = {
    async getEntity(id) {
      const entity = entities.get(id);
      if (!entity) {
        throw Object.assign(new Error('Not found'), { status: 404 });
      }
      return structuredClone(entity);
    },

    async createAsset(entity) {
      creates++;
      if (entities.has(entity.id)) {
        throw Object.assign(new Error('Already exists'), { status: 409 });
      }

      const stored = structuredClone(entity);
      if (truncateTimestamp) {
        for (const name of [
          'status',
          'belongsToDepartment',
          'locatedAt',
        ] as const) {
          const attribute = stored[name] as { observedAt: string };
          attribute.observedAt = attribute.observedAt.slice(0, 19) + 'Z';
        }
      }
      entities.set(entity.id, stored);

      if (loseCreateResponse) {
        loseCreateResponse = false;
        throw new Error('Connection lost after commit');
      }
    },

    async updateAsset(id, attributes) {
      updates++;
      const existing = entities.get(id);
      if (!existing) {
        throw Object.assign(new Error('Not found'), { status: 404 });
      }

      entities.set(id, {
        ...existing,
        ...structuredClone(attributes),
      });
    },
  };

  return {
    broker,
    entities,
    counts: () => ({ creates, updates }),
    loseNextCreateResponse: () => { loseCreateResponse = true; },
    truncateNextCreate: () => { truncateTimestamp = true; },
  };
}

test('creates an Asset and verifies its stored projection', async () => {
  const f = setup();
  const expected = projection();

  expect(await syncAssetProjection(f.broker, expected)).toBe('created');
  expect(f.entities.get(expected.entity.id)).toEqual(expected.entity);
  expect(f.counts()).toEqual({ creates: 1, updates: 0 });
});

test('exact replay performs no additional write', async () => {
  const f = setup();
  const expected = projection();

  await syncAssetProjection(f.broker, expected);

  expect(await syncAssetProjection(f.broker, expected)).toBe('duplicate');
  expect(f.counts()).toEqual({ creates: 1, updates: 0 });
});

test('retry after a lost create response retains one Asset', async () => {
  const f = setup();
  const expected = projection();
  f.loseNextCreateResponse();

  await expect(syncAssetProjection(f.broker, expected))
    .rejects.toThrow('Connection lost after commit');

  expect(await syncAssetProjection(f.broker, expected)).toBe('duplicate');
  expect(f.counts()).toEqual({ creates: 1, updates: 0 });
  expect(
    [...f.entities.values()].filter(entity => entity.type === 'Asset'),
  ).toHaveLength(1);
});

test('newer event updates the same URN and preserves the existing name', async () => {
  const f = setup();
  const first = projection();
  await syncAssetProjection(f.broker, first);

  const existing = f.entities.get(first.entity.id)!;
  existing.name = { type: 'Property', value: 'Backend-managed name' };

  const next = projection('handover-002', '2026-10-22T11:00:00Z');

  expect(await syncAssetProjection(f.broker, next)).toBe('updated');
  expect(f.counts()).toEqual({ creates: 1, updates: 1 });
  expect(f.entities.get(first.entity.id)?.name)
    .toEqual({ type: 'Property', value: 'Backend-managed name' });
});

test('older event cannot overwrite a newer projection', async () => {
  const f = setup();
  const newer = projection('handover-002', '2026-10-22T11:00:00Z');
  await syncAssetProjection(f.broker, newer);

  const before = structuredClone(f.entities.get(newer.entity.id));

  expect(await syncAssetProjection(f.broker, projection())).toBe('stale');
  expect(f.entities.get(newer.entity.id)).toEqual(before);
  expect(f.counts()).toEqual({ creates: 1, updates: 0 });
});

test('equal-time conflicting state is rejected without writing', async () => {
  const f = setup();
  const first = projection();
  await syncAssetProjection(f.broker, first);

  const conflict = projection('handover-conflict');
  conflict.attributes.status.value = 'repair';
  conflict.entity.status.value = 'repair';

  await expect(syncAssetProjection(f.broker, conflict))
    .rejects.toMatchObject({ code: 'OBSERVATION_CONFLICT' });

  expect(f.counts()).toEqual({ creates: 1, updates: 0 });
});

test('missing relationship target prevents Asset creation', async () => {
  const f = setup();
  f.entities.delete('urn:ngsi-ld:Location:org-a:office-1');

  await expect(syncAssetProjection(f.broker, projection()))
    .rejects.toMatchObject({ status: 404 });

  expect(f.counts()).toEqual({ creates: 0, updates: 0 });
});

test('relationship target from another tenant prevents creation', async () => {
  const f = setup();
  const id = 'urn:ngsi-ld:Department:org-a:it';
  f.entities.get(id)!.organizationId = {
    type: 'Property',
    value: 'org-b',
  };

  await expect(syncAssetProjection(f.broker, projection()))
    .rejects.toMatchObject({ code: 'RELATIONSHIP_TARGET_MISMATCH' });

  expect(f.counts()).toEqual({ creates: 0, updates: 0 });
});

test('existing Asset with mismatched identity is rejected', async () => {
  const f = setup();
  const expected = projection();

  f.entities.set(expected.entity.id, {
    ...expected.entity,
    businessId: { type: 'Property', value: 'other-asset' },
  });

  await expect(syncAssetProjection(f.broker, expected))
    .rejects.toMatchObject({ code: 'ASSET_IDENTITY_MISMATCH' });

  expect(f.counts()).toEqual({ creates: 0, updates: 0 });
});

test('missing relation timestamps fall back to the stored status timestamp', async () => {
  const f = setup();
  const older = projection('handover-old', '2026-10-22T09:00:00Z');
  await syncAssetProjection(f.broker, older);

  const stored = f.entities.get(older.entity.id)!;
  delete (stored.belongsToDepartment as { observedAt?: string }).observedAt;
  delete (stored.locatedAt as { observedAt?: string }).observedAt;

  const next = projection('handover-next', '2026-10-22T10:00:00Z');
  expect(await syncAssetProjection(f.broker, next)).toBe('updated');
  expect(f.counts()).toEqual({ creates: 1, updates: 1 });
  expect(f.entities.get(next.entity.id)?.status).toEqual(next.entity.status);
  expect(f.entities.get(next.entity.id)?.belongsToDepartment)
    .toEqual(next.entity.belongsToDepartment);
});

test('present invalid relation timestamps remain invalid', async () => {
  const f = setup();
  const existing = projection('handover-old', '2026-10-22T09:00:00Z');
  await syncAssetProjection(f.broker, existing);
  (f.entities.get(existing.entity.id)!.belongsToDepartment as { observedAt: string })
    .observedAt = 'not-a-timestamp';

  await expect(syncAssetProjection(
    f.broker,
    projection('handover-next', '2026-10-22T10:00:00Z'),
  )).rejects.toMatchObject({ code: 'INVALID_OBSERVATION' });
  expect(f.counts()).toEqual({ creates: 1, updates: 0 });
});

test('present newer relation timestamps still make the event stale', async () => {
  const f = setup();
  const existing = projection('handover-old', '2026-10-22T09:00:00Z');
  await syncAssetProjection(f.broker, existing);
  (f.entities.get(existing.entity.id)!.locatedAt as { observedAt: string })
    .observedAt = '2026-10-22T11:00:00Z';

  expect(await syncAssetProjection(
    f.broker,
    projection('handover-next', '2026-10-22T10:00:00Z'),
  )).toBe('stale');
  expect(f.counts()).toEqual({ creates: 1, updates: 0 });
});

test('different event IDs at the same observed time are conflicts', async () => {
  const f = setup();
  const first = projection('handover-first');
  await syncAssetProjection(f.broker, first);

  await expect(syncAssetProjection(
    f.broker,
    projection('handover-second'),
  )).rejects.toMatchObject({ code: 'OBSERVATION_CONFLICT' });
  expect(f.entities.get(first.entity.id)?.sourceEventId)
    .toEqual(first.entity.sourceEventId);
  expect(f.counts()).toEqual({ creates: 1, updates: 0 });
});

test('normalizes broker timestamps to seconds and conflicts on same-second changes', async () => {
  const f = setup();
  const original = projection(
    'handover-first',
    '2026-10-22T10:00:00.123456789Z',
  );
  f.truncateNextCreate();

  expect(await syncAssetProjection(f.broker, original)).toBe('created');

  const stored = f.entities.get(original.entity.id)!;
  for (const name of [
    'status',
    'belongsToDepartment',
    'locatedAt',
  ] as const) {
    expect((stored[name] as { observedAt: string }).observedAt)
      .toBe('2026-10-22T10:00:00Z');
  }
  expect(original.entity.status.observedAt)
    .toBe('2026-10-22T10:00:00.123456789Z');

  const conflict = projection(
    'handover-second',
    '2026-10-22T10:00:00.987654321Z',
  );
  conflict.attributes.status.value = 'repair';
  conflict.entity.status.value = 'repair';

  await expect(syncAssetProjection(f.broker, conflict))
    .rejects.toMatchObject({ code: 'OBSERVATION_CONFLICT' });
  expect(f.entities.get(original.entity.id)?.status.value).toBe('in_use');
  expect(conflict.entity.status.observedAt)
    .toBe('2026-10-22T10:00:00.987654321Z');
  expect(f.counts()).toEqual({ creates: 1, updates: 0 });
});

test('timestamp comparison preserves nanoseconds', () => {
  expect(observationTime('2026-10-22T10:00:00.000000002Z'))
    .toBeGreaterThan(observationTime('2026-10-22T10:00:00.000000001Z'));

  expect(observationTime('2026-10-22T10:00:00Z'))
    .toBe(observationTime('2026-10-22T10:00:00.000Z'));
});
