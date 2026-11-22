/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type { mapHandoverToAsset } from './asset-mapping.js';

type Projection = ReturnType<typeof mapHandoverToAsset>;
type Entity = Record<string, unknown>;

export interface BrokerPort {
  getEntity(id: string): Promise<Entity>;
  createAsset(entity: Projection['entity']): Promise<unknown>;
  updateAsset(
    id: string,
    attributes: Projection['attributes'],
  ): Promise<unknown>;
}

export class BrokerSyncError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BrokerSyncError';
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function fail(code: string, message: string): never {
  throw new BrokerSyncError(code, message);
}

function statusOf(error: unknown): number | undefined {
  const status = object(error)?.status;
  return typeof status === 'number' ? status : undefined;
}

function property(entity: Entity, name: string): unknown {
  return object(entity[name])?.value;
}

/** Compare UTC timestamps without discarding fractional precision. */
export function observationTime(value: unknown): bigint {
  if (typeof value !== 'string') {
    return fail('INVALID_OBSERVATION', 'Missing observation timestamp');
  }

  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/
    .exec(value);

  if (!match) {
    return fail('INVALID_OBSERVATION', 'Invalid UTC observation timestamp');
  }

  const milliseconds = Date.parse(`${match[1]}Z`);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString().slice(0, 19) !== match[1]
  ) {
    return fail('INVALID_OBSERVATION', 'Invalid observation calendar date');
  }

  return BigInt(milliseconds) * 1_000_000n +
    BigInt((match[2] ?? '').padEnd(9, '0'));
}

function brokerObservationTime(value: unknown): string {
  observationTime(value);
  return `${(value as string).slice(0, 19)}Z`;
}

function normalizeBrokerProjection(projection: Projection): Projection {
  const normalize = <T extends { observedAt: string }>(attribute: T): T => ({
    ...attribute,
    observedAt: brokerObservationTime(attribute.observedAt),
  });

  const attributes = {
    ...projection.attributes,
    status: normalize(projection.attributes.status),
    belongsToDepartment: normalize(projection.attributes.belongsToDepartment),
    locatedAt: normalize(projection.attributes.locatedAt),
  };

  return {
    attributes,
    entity: {
      ...projection.entity,
      ...attributes,
    },
  };
}

function assertIdentity(entity: Entity, expected: Projection['entity']) {
  if (
    entity.id !== expected.id ||
    entity.type !== 'Asset' ||
    property(entity, 'organizationId') !== expected.organizationId.value ||
    property(entity, 'businessId') !== expected.businessId.value
  ) {
    fail('ASSET_IDENTITY_MISMATCH', 'Stored Asset identity differs');
  }
}

function sameState(current: Entity, projection: Projection): boolean {
  const expected = projection.attributes;
  const statusTime = observationTime(object(current.status)?.observedAt);

  for (const name of ['status', 'belongsToDepartment', 'locatedAt'] as const) {
    const actual = object(current[name]);
    const wanted = expected[name];

    if (!actual || actual.type !== wanted.type) return false;

    const key = name === 'status' ? 'value' : 'object';
    if (actual[key] !== (wanted as Record<string, unknown>)[key]) {
      return false;
    }

    const actualTime = actual.observedAt === undefined && name !== 'status'
      ? statusTime
      : observationTime(actual.observedAt);
    if (actualTime !== observationTime(wanted.observedAt)) {
      return false;
    }
  }

  const actualSourceEventId = object(current.sourceEventId);
  return actualSourceEventId?.type === expected.sourceEventId.type &&
    actualSourceEventId.value === expected.sourceEventId.value;
}

async function assertTarget(
  broker: BrokerPort,
  id: string,
  type: 'Department' | 'Location',
  organizationId: string,
) {
  const target = await broker.getEntity(id);
  const prefix = `urn:ngsi-ld:${type}:${organizationId}:`;

  if (
    target.id !== id ||
    target.type !== type ||
    property(target, 'organizationId') !== organizationId ||
    !id.startsWith(prefix) ||
    property(target, 'businessId') !== id.slice(prefix.length)
  ) {
    fail('RELATIONSHIP_TARGET_MISMATCH', `Invalid ${type} target`);
  }
}

/**
 * Caller must serialize processing for the same tenant and Asset URN.
 * All writers of these projected attributes must use the same coordination.
 */
export async function syncAssetProjection(
  broker: BrokerPort,
  projection: Projection,
): Promise<'created' | 'updated' | 'duplicate' | 'stale'> {
  // Keep the source projection untouched in the durable job and normalize only
  // the broker-facing copy to Orion-LD's second-level observedAt precision.
  const brokerProjection = normalizeBrokerProjection(projection);
  const expected = brokerProjection.entity;
  const organizationId = expected.organizationId.value;

  let current: Entity | undefined;
  try {
    current = await broker.getEntity(expected.id);
  } catch (error) {
    if (statusOf(error) !== 404) throw error;
  }

  if (current) {
    assertIdentity(current, expected);

    const incomingTime = observationTime(expected.status.observedAt);
    const statusTime = observationTime(object(current.status)?.observedAt);
    const existingTimes = [
      statusTime,
      ...['belongsToDepartment', 'locatedAt'].map((name) => {
        const observedAt = object(current![name])?.observedAt;
        return observedAt === undefined
          ? statusTime
          : observationTime(observedAt);
      }),
    ];

    // An event older than any projected attribute must not overwrite it.
    if (existingTimes.some((time) => time > incomingTime)) return 'stale';

    if (existingTimes.some((time) => time === incomingTime)) {
      if (sameState(current, brokerProjection)) return 'duplicate';

      fail(
        'OBSERVATION_CONFLICT',
        'Equal observation time has a different or incomplete projection',
      );
    }
  }

  await assertTarget(
    broker,
    expected.belongsToDepartment.object,
    'Department',
    organizationId,
  );
  await assertTarget(
    broker,
    expected.locatedAt.object,
    'Location',
    organizationId,
  );

  if (current) {
    await broker.updateAsset(expected.id, brokerProjection.attributes);
  } else {
    // A 409 or uncertain transport result is handled by a subsequent job retry.
    // The next attempt reads the same URN before deciding whether to write.
    await broker.createAsset(expected);
  }

  const readBack = await broker.getEntity(expected.id);
  assertIdentity(readBack, expected);

  if (
    !sameState(readBack, brokerProjection) ||
    property(readBack, 'sourceEventId') !== expected.sourceEventId.value
  ) {
    fail('READBACK_MISMATCH', 'Broker did not preserve the expected projection');
  }

  return current ? 'updated' : 'created';
}
