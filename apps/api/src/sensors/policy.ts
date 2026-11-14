/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { parseSensorAssetUrn } from './asset-identity.js';

export type MeasurementQuality = 'good' | 'missing' | 'invalid';

export type SensorReading = {
  eventId: string;
  assetUrn: string;
  attribute: 'temperature' | 'humidity' | 'batteryLevel';
  unit: 'celsius' | 'percent';
  observedAt: string;
  source: {
    system: string;
    deviceId: string;
  };
  simulated: boolean;
  quality: MeasurementQuality;
  qualityReason: string | null;
  value?: number;
};

export class SensorInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SensorInputError';
  }
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value);

const boundedText = (value: unknown, max: number): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  value === value.trim() &&
  !/[\u0000-\u001f\u007f]/.test(value);

function reject(message: string): never {
  throw new SensorInputError(message);
}

/**
 * Validate identity and measurement structure.
 * The authenticated ingestion layer must supply the trusted tenant.
 * This function does not authorize sources or verify Asset existence.
 */
export function parseSensorReading(
  input: unknown,
  tenant: string,
): SensorReading {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(tenant)) {
    return reject('Invalid configured tenant.');
  }

  if (!object(input) || input.schemaVersion !== 1) {
    return reject('Sensor schemaVersion 1 is required.');
  }

  if (
    !boundedText(input.eventId, 128) ||
    !/^[A-Za-z0-9._:-]+$/.test(input.eventId)
  ) {
    return reject('Invalid sensor event ID.');
  }

  let assetUrn: string;

  try {
    assetUrn = parseSensorAssetUrn(input.assetUrn, tenant).urn;
  } catch {
    return reject('Asset URN must belong to the configured tenant.');
  }

  const attribute = input.attribute;
  if (
    attribute !== 'temperature' &&
    attribute !== 'humidity' &&
    attribute !== 'batteryLevel'
  ) {
    return reject('Unsupported sensor attribute.');
  }

  const expectedUnit =
    attribute === 'temperature' ? 'celsius' : 'percent';

  if (input.unit !== expectedUnit) {
    return reject('Sensor unit does not match its attribute.');
  }

  const observedAt = input.observedAt;
  if (
    typeof observedAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(observedAt)
  ) {
    return reject('Canonical UTC observation time is required.');
  }

  const observedMs = Date.parse(observedAt);
  if (
    !Number.isFinite(observedMs) ||
    new Date(observedMs).toISOString() !== observedAt
  ) {
    return reject('Invalid observation date.');
  }

  if (
    !object(input.source) ||
    !boundedText(input.source.system, 128) ||
    !boundedText(input.source.deviceId, 128)
  ) {
    return reject('Bounded source system and device ID are required.');
  }

  if (typeof input.simulated !== 'boolean') {
    return reject('An explicit simulated flag is required.');
  }

  let quality: MeasurementQuality = 'good';
  let qualityReason: string | null = null;
  let value: number | undefined;

  if (!Object.hasOwn(input, 'value')) {
    quality = 'missing';
    qualityReason = 'VALUE_MISSING';
  } else if (
    typeof input.value !== 'number' ||
    !Number.isFinite(input.value)
  ) {
    quality = 'invalid';
    qualityReason = 'VALUE_NOT_FINITE_NUMBER';
  } else if (
    attribute !== 'temperature' &&
    (input.value < 0 || input.value > 100)
  ) {
    quality = 'invalid';
    qualityReason = 'PERCENT_OUT_OF_RANGE';
  } else {
    value = input.value;
  }

  return {
    eventId: input.eventId,
    assetUrn,
    attribute,
    unit: expectedUnit,
    observedAt,
    source: {
      system: input.source.system,
      deviceId: input.source.deviceId,
    },
    simulated: input.simulated,
    quality,
    qualityReason,
    ...(value === undefined ? {} : { value }),
  };
}