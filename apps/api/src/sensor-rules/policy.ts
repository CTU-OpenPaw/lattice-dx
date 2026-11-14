/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { isRecordId } from '@dx/contracts';

export class SensorRuleError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'SensorRuleError';
  }
}

export type SensorRule = {
  id: string;
  version: number;
  assetEntityId: string;
  attribute: 'temperature' | 'humidity' | 'batteryLevel';
  operator: 'gt' | 'gte' | 'lt' | 'lte';
  threshold: number;
  unit: 'celsius' | 'percent';
  maxObservationAgeSeconds: number;
  cooldownSeconds: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
  enabled: boolean;
  workflowDefinitionId: 'incident-response';
  workflowDefinitionVersion: 1;
  handlerId: string;
};

function fail(code: string): never {
  throw new SensorRuleError(code);
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value);
}

function choice<T extends readonly string[]>(
  value: unknown,
  allowed: T,
): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    return fail('INVALID_RULE_FIELD');
  }

  return value as T[number];
}

/**
 * Parse an incident-rule entity returned by an authorized backend read.
 * Parsing does not establish tenant scope, permissions or Asset mapping.
 */
export function parseSensorRule(input: unknown): SensorRule {
  if (
    !object(input) ||
    !isRecordId(input.id) ||
    input.schemaId !== 'incident-rule' ||
    input.schemaVersion !== 1 ||
    !Number.isSafeInteger(input.version) ||
    (input.version as number) < 1 ||
    (input.version as number) > 1_000_000 ||
    (input.archivedAt !== undefined && input.archivedAt !== null) ||
    !object(input.attributes)
  ) {
    return fail('INVALID_RULE_ENTITY');
  }

  const a = input.attributes;

  if (
    !isRecordId(a.assetEntityId) ||
    typeof a.enabled !== 'boolean' ||
    typeof a.handlerId !== 'string' ||
    !a.handlerId.trim() ||
    a.handlerId !== a.handlerId.trim() ||
    a.handlerId.length > 100 ||
    /[\u0000-\u001f\u007f]/.test(a.handlerId)
  ) {
    return fail('INVALID_RULE_FIELD');
  }

  const attribute = choice(
    a.attribute,
    ['temperature', 'humidity', 'batteryLevel'] as const,
  );

  const unit = choice(a.unit, ['celsius', 'percent'] as const);

  if (unit !== (attribute === 'temperature' ? 'celsius' : 'percent')) {
    return fail('RULE_UNIT_MISMATCH');
  }

  const threshold = choice(a.threshold, [
    '0', '5', '10', '15', '20', '25', '30', '35',
    '40', '50', '60', '70', '80', '90', '100',
  ] as const);

  const maxAge = choice(
    a.maxObservationAgeSeconds,
    ['30', '60', '120', '300', '600'] as const,
  );

  const cooldown = choice(
    a.cooldownSeconds,
    ['0', '60', '300', '900', '3600'] as const,
  );

  choice(a.workflowDefinitionId, ['incident-response'] as const);
  choice(a.workflowDefinitionVersion, ['1'] as const);

  return {
    id: input.id.toLowerCase(),
    version: input.version as number,
    assetEntityId: a.assetEntityId.toLowerCase(),
    attribute,
    operator: choice(a.operator, ['gt', 'gte', 'lt', 'lte'] as const),
    threshold: Number(threshold),
    unit,
    maxObservationAgeSeconds: Number(maxAge),
    cooldownSeconds: Number(cooldown),
    severity: choice(
      a.severity,
      ['low', 'medium', 'high', 'critical'] as const,
    ),
    enabled: a.enabled,
    workflowDefinitionId: 'incident-response',
    workflowDefinitionVersion: 1,
    handlerId: a.handlerId,
  };
}