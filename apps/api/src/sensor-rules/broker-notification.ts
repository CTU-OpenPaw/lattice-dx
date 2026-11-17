// SPDX-License-Identifier: Apache-2.0
import { SENSOR_NAMESPACE } from '../sensors/projection.js';
import { parseSensorReading } from '../sensors/policy.js';
import type { SensorRule } from './policy.js';
import type { RuleAssetMapping } from './evaluator.js';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid notification object');
  return value as Record<string, unknown>;
}

export function sensorReadingsFromNotification(
  input: unknown,
  options: { tenant: string; subscriptionId: string; mapping: RuleAssetMapping; rule: SensorRule },
) {
  const notification = object(input);
  if (notification.type !== 'Notification' || notification.subscriptionId !== options.subscriptionId ||
      !Array.isArray(notification.data) || notification.data.length > 50) throw new Error('Invalid sensor notification');
  const { attribute, unit } = options.rule;
  return notification.data.flatMap(value => {
    const entity = object(value);
    if (entity.id !== options.mapping.assetUrn) throw new Error('Unexpected Asset in notification');
    const property = entity[attribute] ?? entity[SENSOR_NAMESPACE + attribute];
    if (property == null) return [];
    const measurement = object(property);
    const metadata = (name: string) => object(measurement[SENSOR_NAMESPACE + name] ?? measurement[name]).value;
    if (measurement.type !== 'Property' || measurement.unitCode !== (unit === 'celsius' ? 'CEL' : 'P1') ||
        metadata('measurementQuality') !== 'good' || typeof measurement.observedAt !== 'string') {
      throw new Error('Invalid sensor measurement');
    }
    const reading = {
      schemaVersion: 1, assetUrn: entity.id, attribute, unit, value: measurement.value,
      observedAt: new Date(measurement.observedAt).toISOString(), eventId: metadata('sourceEventId'),
      source: { system: metadata('sourceSystem'), deviceId: metadata('sourceDeviceId') },
      simulated: metadata('simulated'),
    };
    if (parseSensorReading(reading, options.tenant).quality !== 'good') throw new Error('Invalid sensor value');
    return [reading];
  });
}
