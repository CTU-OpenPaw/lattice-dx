/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { createHash } from 'node:crypto';
import { parseSensorAssetUrn } from './asset-identity.js';
import { parseSensorReading } from './policy.js';

export class NativeSensorEnvelopeError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'NativeSensorEnvelopeError';
  }
}

export type NativeObservationEnvelope = {
  eventId: string;
  kind: 'observation';
  observedAt: string;
  data: {
    assetId: string;
    attribute: 'temperature' | 'humidity' | 'batteryLevel';
    value: number;
    unit: 'celsius' | 'percent';
  };
};

export type NativeObservationTrace = {
  organizationId: string;
  sourceSystem: string;
  sourceEventId: string;
  sourceDeviceId: string;
  assetUrn: string;
  simulated: boolean;
  quality: 'good' | 'missing' | 'invalid';
};

export type NativeEnvelopeResult =
  | {
      status: 'ready';
      envelope: NativeObservationEnvelope;
      trace: NativeObservationTrace;
    }
  | {
      status: 'skipped';
      reason: 'VALUE_MISSING' | 'VALUE_INVALID';
      trace: NativeObservationTrace;
    };

/**
 * Builds only the fields accepted by the native ingress.
 *
 * Scope must come from trusted configuration or verified identity.
 * URN parsing does not authorize access; native ingress checks the Asset.
 * Source labels and simulated flags remain in the integration trace:
 * the current native ingress does not accept these extra fields.
 */
export function buildNativeSensorEnvelope(
  input: unknown,
  scope: {
    organizationId: string;
    sourceSystem: string;
  },
): NativeEnvelopeResult {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(scope.sourceSystem)) {
    throw new NativeSensorEnvelopeError('INVALID_SOURCE_CONFIGURATION');
  }

  const reading = parseSensorReading(input, scope.organizationId);

  if (reading.source.system !== scope.sourceSystem) {
    throw new NativeSensorEnvelopeError('SOURCE_SCOPE_MISMATCH');
  }

  const identity = parseSensorAssetUrn(
    reading.assetUrn,
    scope.organizationId,
  );

  if (identity.kind !== 'native') {
    // Legacy business IDs must not be guessed into native record IDs.
    throw new NativeSensorEnvelopeError('NATIVE_ASSET_MAPPING_REQUIRED');
  }

  const trace: NativeObservationTrace = {
    organizationId: scope.organizationId,
    sourceSystem: scope.sourceSystem,
    sourceEventId: reading.eventId,
    sourceDeviceId: reading.source.deviceId,
    assetUrn: reading.assetUrn,
    simulated: reading.simulated,
    quality: reading.quality,
  };

  if (reading.quality !== 'good') {
    return {
      status: 'skipped',
      reason: reading.quality === 'missing'
        ? 'VALUE_MISSING'
        : 'VALUE_INVALID',
      trace,
    };
  }

  if (
    typeof reading.value !== 'number' ||
    !Number.isFinite(reading.value)
  ) {
    throw new NativeSensorEnvelopeError('INVALID_VALIDATED_READING');
  }

  // Stable across retries; independent of delivery time and credentials.
  // Payload changes under the same source event retain the same ID,
  // allowing the receiver to detect a conflicting replay.
  const eventHash = createHash('sha256')
    .update(JSON.stringify([
      'uc2-native-observation-v1',
      scope.organizationId,
      scope.sourceSystem,
      reading.eventId,
    ]))
    .digest('hex');

  return {
    status: 'ready',
    envelope: {
      eventId: `sensor-${eventHash}`,
      kind: 'observation',
      observedAt: reading.observedAt,
      data: {
        assetId: identity.recordId,
        attribute: reading.attribute,
        value: reading.value,
        unit: reading.unit,
      },
    },
    trace,
  };
}