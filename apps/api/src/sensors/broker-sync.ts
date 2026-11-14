/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  buildSensorProjection,
  SENSOR_NAMESPACE as ns,
} from './projection.js';
import { createSensorBrokerClient } from './broker-client.js';

type Broker = ReturnType<typeof createSensorBrokerClient>;
type Entity = Record<string, unknown>;

export class SensorSyncError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'SensorSyncError';
  }
}

function fail(code: string): never {
  throw new SensorSyncError(code);
}

function object(value: unknown): value is Entity {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value);
}

// Accept compact or expanded project terms, but reject ambiguity.
function field(entity: Entity, name: string): unknown {
  if (
    Object.hasOwn(entity, name) &&
    Object.hasOwn(entity, ns + name)
  ) {
    return fail('AMBIGUOUS_BROKER_ATTRIBUTE');
  }

  return Object.hasOwn(entity, name)
    ? entity[name]
    : entity[ns + name];
}

function propertyValue(entity: Entity, name: string): unknown {
  const value = field(entity, name);

  if (
    !object(value) ||
    value.type !== 'Property' ||
    value.datasetId !== undefined
  ) {
    return fail('INVALID_BROKER_PROPERTY');
  }

  return value.value;
}

function timestamp(value: unknown): number {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
  ) {
    return fail('INVALID_BROKER_OBSERVATION_TIME');
  }

  const canonical = value.includes('.')
    ? value.replace(
        /\.(\d+)Z$/,
        (_, digits: string) => `.${digits.padEnd(3, '0')}Z`,
      )
    : value.replace('Z', '.000Z');

  const parsed = Date.parse(value);

  if (
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString() !== canonical
  ) {
    return fail('INVALID_BROKER_OBSERVATION_TIME');
  }

  return parsed;
}

function assertIdentity(entity: Entity, id: string, tenant: string) {
  const prefix = `urn:ngsi-ld:Asset:${tenant}:`;

  if (
    entity.id !== id ||
    !['Asset', ns + 'Asset'].includes(entity.type as string) ||
    propertyValue(entity, 'organizationId') !== tenant ||
    propertyValue(entity, 'businessId') !== id.slice(prefix.length)
  ) {
    fail('ASSET_IDENTITY_MISMATCH');
  }
}

function matches(actual: Entity, expected: Entity): boolean {
  if (
    actual.type !== 'Property' ||
    actual.datasetId !== undefined ||
    actual.value !== expected.value ||
    actual.unitCode !== expected.unitCode ||
    timestamp(actual.observedAt) !== timestamp(expected.observedAt)
  ) {
    return false;
  }

  return [
    'sourceSystem',
    'sourceDeviceId',
    'sourceEventId',
    'measurementQuality',
    'simulated',
  ].every(name =>
    propertyValue(actual, name) === propertyValue(expected, name),
  );
}

/**
 * Synchronize one reading.
 * Caller must serialize writes for the same tenant/Asset/attribute
 * across the complete read/write/read-back operation.
 */
export async function syncSensorReading(
  broker: Broker,
  input: unknown,
  tenant: string,
): Promise<'skipped' | 'stale' | 'duplicate' | 'updated'> {
  const projection = buildSensorProjection(input, tenant);

  if (projection.kind === 'skipped') {
    return 'skipped';
  }

  const entity = await broker.getAsset(projection.assetUrn);
  assertIdentity(entity, projection.assetUrn, tenant);

  const attribute = projection.attribute.slice(ns.length);
  const existing = field(entity, attribute);

  if (existing !== undefined) {
    if (
      !object(existing) ||
      existing.type !== 'Property' ||
      existing.datasetId !== undefined ||
      typeof existing.value !== 'number' ||
      !Number.isFinite(existing.value)
    ) {
      return fail('INVALID_EXISTING_MEASUREMENT');
    }

    // Do not silently take over an attribute owned by another source/device.
    for (const name of ['sourceSystem', 'sourceDeviceId']) {
      if (
        propertyValue(existing, name) !==
        propertyValue(projection.property, name)
      ) {
        return fail('MEASUREMENT_SOURCE_CONFLICT');
      }
    }

    const currentTime = timestamp(existing.observedAt);
    const incomingTime = timestamp(projection.property.observedAt);

    if (currentTime > incomingTime) {
      return 'stale';
    }

    if (currentTime === incomingTime) {
      if (!matches(existing, projection.property)) {
        return fail('MEASUREMENT_TIME_CONFLICT');
      }

      return 'duplicate';
    }
  }

  await broker.appendMeasurement(projection);

  const confirmed = await broker.getAsset(projection.assetUrn);
  assertIdentity(confirmed, projection.assetUrn, tenant);

  const stored = field(confirmed, attribute);

  if (!object(stored) || !matches(stored, projection.property)) {
    return fail('BROKER_READBACK_MISMATCH');
  }

  return 'updated';
}