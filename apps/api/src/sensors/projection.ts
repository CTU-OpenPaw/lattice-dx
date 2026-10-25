// SPDX-License-Identifier: Apache-2.0
import {
  parseSensorReading,
  type MeasurementQuality,
} from './policy.js';

export const SENSOR_NAMESPACE = 'https://latticedx.example/ns/';

type Property<T> = {
  type: 'Property';
  value: T;
};

export type SensorProperty = Property<number> & {
  observedAt: string;
  unitCode: 'CEL' | 'P1';
  [key: string]: unknown;
};

export type SensorProjection =
  | {
      kind: 'skipped';
      eventId: string;
      assetUrn: string;
      quality: Exclude<MeasurementQuality, 'good'>;
      reason: string;
    }
  | {
      kind: 'ready';
      eventId: string;
      assetUrn: string;
      attribute: string;
      property: SensorProperty;
    };

function property<T>(value: T): Property<T> {
  return { type: 'Property', value };
}

/**
 * Build a broker projection from a validated source reading.
 * Fully qualified custom terms avoid relying on implicit context mappings.
 * This function performs no network or database operations.
 */
export function buildSensorProjection(
  input: unknown,
  tenant: string,
): SensorProjection {
  const reading = parseSensorReading(input, tenant);

  if (reading.quality !== 'good') {
    return {
      kind: 'skipped',
      eventId: reading.eventId,
      assetUrn: reading.assetUrn,
      quality: reading.quality,
      reason: reading.qualityReason!,
    };
  }

  return {
    kind: 'ready',
    eventId: reading.eventId,
    assetUrn: reading.assetUrn,
    attribute: SENSOR_NAMESPACE + reading.attribute,
    property: {
      type: 'Property',
      value: reading.value!,
      observedAt: reading.observedAt,
      unitCode: reading.unit === 'celsius' ? 'CEL' : 'P1',
      [SENSOR_NAMESPACE + 'sourceSystem']:
        property(reading.source.system),
      [SENSOR_NAMESPACE + 'sourceDeviceId']:
        property(reading.source.deviceId),
      [SENSOR_NAMESPACE + 'sourceEventId']:
        property(reading.eventId),
      [SENSOR_NAMESPACE + 'measurementQuality']:
        property(reading.quality),
      [SENSOR_NAMESPACE + 'simulated']:
        property(reading.simulated),
    },
  };
}