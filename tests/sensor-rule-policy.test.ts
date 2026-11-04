// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  parseSensorRule,
  SensorRuleError,
} from '../apps/api/src/sensor-rules/policy.js';

function fixture() {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    schemaId: 'incident-rule',
    schemaVersion: 1,
    version: 1,
    archivedAt: null,
    attributes: {
      assetEntityId: '22222222-2222-4222-8222-222222222222',
      attribute: 'temperature',
      operator: 'gt',
      threshold: '80',
      unit: 'celsius',
      maxObservationAgeSeconds: '120',
      cooldownSeconds: '300',
      severity: 'high',
      enabled: true,
      workflowDefinitionId: 'incident-response',
      workflowDefinitionVersion: '1',
      handlerId: 'fixture-handler',
    },
  };
}

function expectCode(input: unknown, code: string) {
  expect(() => parseSensorRule(input)).toThrow(SensorRuleError);
  expect(() => parseSensorRule(input)).toThrow(code);
}

describe('sensor rule policy', () => {
  it('parses the backend entity and converts numeric enum values', () => {
    const rule = parseSensorRule(fixture());

    expect(rule).toMatchObject({
      attribute: 'temperature',
      operator: 'gt',
      threshold: 80,
      unit: 'celsius',
      maxObservationAgeSeconds: 120,
      cooldownSeconds: 300,
      enabled: true,
      workflowDefinitionVersion: 1,
    });
  });

  it.each(['humidity', 'batteryLevel'])(
    'accepts percent measurements for %s',
    attribute => {
      const input = fixture();
      input.attributes.attribute = attribute;
      input.attributes.unit = 'percent';

      expect(parseSensorRule(input).unit).toBe('percent');
    },
  );

  it('preserves disabled rules and zero cooldown', () => {
    const input = fixture();
    input.attributes.enabled = false;
    input.attributes.cooldownSeconds = '0';

    expect(parseSensorRule(input)).toMatchObject({
      enabled: false,
      cooldownSeconds: 0,
    });
  });

  it.each([null, [], {}, 'rule'])(
    'rejects a malformed entity: %j',
    input => {
      expectCode(input, 'INVALID_RULE_ENTITY');
    },
  );

  it.each([
    { schemaId: 'other-schema' },
    { schemaVersion: 2 },
    { id: 'not-a-uuid' },
    { version: 0 },
    { version: 1.5 },
    { version: 1_000_001 },
    { archivedAt: '2026-10-31T00:00:00.000Z' },
  ])('rejects invalid entity metadata: %j', patch => {
    expectCode(
      { ...fixture(), ...patch },
      'INVALID_RULE_ENTITY',
    );
  });

  it.each([
    { assetEntityId: 'not-a-uuid' },
    { enabled: 'true' },
    { attribute: 'pressure' },
    { operator: 'eq' },
    { threshold: '81' },
    { threshold: 80 },
    { maxObservationAgeSeconds: '0' },
    { cooldownSeconds: '-1' },
    { severity: 'urgent' },
    { workflowDefinitionId: 'other-workflow' },
    { workflowDefinitionVersion: '2' },
    { handlerId: '' },
    { handlerId: ' handler ' },
    { handlerId: 'handler\ninjected' },
    { handlerId: 'x'.repeat(101) },
  ])('rejects unsupported rule fields: %j', patch => {
    const input = fixture();

    expectCode(
      {
        ...input,
        attributes: { ...input.attributes, ...patch },
      },
      'INVALID_RULE_FIELD',
    );
  });

  it.each([
    ['temperature', 'percent'],
    ['humidity', 'celsius'],
    ['batteryLevel', 'celsius'],
  ])('rejects a unit mismatch for %s', (attribute, unit) => {
    const input = fixture();
    input.attributes.attribute = attribute;
    input.attributes.unit = unit;

    expectCode(input, 'RULE_UNIT_MISMATCH');
  });
});