// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { SensorRule } from '../apps/api/src/sensor-rules/policy.js';
import {
  evaluateSensorRule,
  type RuleAssetMapping,
  type RuleObservation,
} from '../apps/api/src/sensor-rules/evaluator.js';

const nowMs = Date.parse('2026-11-04T12:00:00.000Z');

const mapping: RuleAssetMapping = {
  assetEntityId: '22222222-2222-4222-8222-222222222222',
  assetUrn: 'urn:ngsi-ld:Asset:org-a:uc1-demo-asset-001',
};

function rule(patch: Partial<SensorRule> = {}): SensorRule {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    version: 1,
    assetEntityId: mapping.assetEntityId,
    attribute: 'temperature',
    operator: 'gt',
    threshold: 80,
    unit: 'celsius',
    maxObservationAgeSeconds: 120,
    cooldownSeconds: 300,
    severity: 'high',
    enabled: true,
    workflowDefinitionId: 'incident-response',
    workflowDefinitionVersion: 1,
    handlerId: 'fixture-handler',
    ...patch,
  };
}

function observation(
  patch: Partial<RuleObservation> = {},
): RuleObservation {
  return {
    eventId: 'sim:evaluator-fixture',
    assetUrn: mapping.assetUrn,
    attribute: 'temperature',
    unit: 'celsius',
    quality: 'good',
    value: 85,
    observedAt: '2026-11-04T11:59:30.000Z',
    ...patch,
  };
}

describe('sensor rule evaluator', () => {
  it('matches a fresh measurement and preserves trace identifiers', () => {
    const result = evaluateSensorRule(
      rule(),
      observation(),
      mapping,
      nowMs,
    );

    expect(result).toEqual({
      ruleId: rule().id,
      ruleVersion: 1,
      eventId: 'sim:evaluator-fixture',
      assetUrn: mapping.assetUrn,
      evaluatedAt: '2026-11-04T12:00:00.000Z',
      matched: true,
      reason: 'THRESHOLD_MET',
      observationAgeSeconds: 30,
    });
  });

  it.each([
    ['gt', 79, false],
    ['gt', 80, false],
    ['gt', 81, true],
    ['gte', 79, false],
    ['gte', 80, true],
    ['gte', 81, true],
    ['lt', 79, true],
    ['lt', 80, false],
    ['lt', 81, false],
    ['lte', 79, true],
    ['lte', 80, true],
    ['lte', 81, false],
  ] as const)(
    '%s compares value %s against threshold 80',
    (operator, value, matched) => {
      const result = evaluateSensorRule(
        rule({ operator }),
        observation({ value }),
        mapping,
        nowMs,
      );

      expect(result.matched).toBe(matched);
      expect(result.reason).toBe(
        matched ? 'THRESHOLD_MET' : 'THRESHOLD_NOT_MET',
      );
    },
  );

  it.each([
    [0, 'THRESHOLD_MET', true],
    [120_000, 'THRESHOLD_MET', true],
    [120_001, 'STALE_OBSERVATION', false],
    [-1, 'FUTURE_OBSERVATION', false],
  ] as const)(
    'handles observation age %s milliseconds',
    (ageMs, reason, matched) => {
      const result = evaluateSensorRule(
        rule(),
        observation({
          observedAt: new Date(nowMs - ageMs).toISOString(),
        }),
        mapping,
        nowMs,
      );

      expect(result.reason).toBe(reason);
      expect(result.matched).toBe(matched);
      expect(result.observationAgeSeconds).toBe(ageMs / 1000);
    },
  );

  it('does not evaluate disabled rules', () => {
    const result = evaluateSensorRule(
      rule({ enabled: false }),
      observation(),
      mapping,
      nowMs,
    );

    expect(result.reason).toBe('RULE_DISABLED');
    expect(result.matched).toBe(false);
  });

  it('rejects an observation for another Asset URN', () => {
    const result = evaluateSensorRule(
      rule(),
      observation({
        assetUrn: 'urn:ngsi-ld:Asset:org-a:another-asset',
      }),
      mapping,
      nowMs,
    );

    expect(result.reason).toBe('ASSET_MISMATCH');
    expect(result.matched).toBe(false);
  });

  it('rejects a mapping for another backend Asset', () => {
    const result = evaluateSensorRule(
      rule(),
      observation(),
      {
        ...mapping,
        assetEntityId: '33333333-3333-4333-8333-333333333333',
      },
      nowMs,
    );

    expect(result.reason).toBe('ASSET_MISMATCH');
    expect(result.matched).toBe(false);
  });

  it.each([
    [{ attribute: 'humidity' }, 'ATTRIBUTE_MISMATCH'],
    [{ unit: 'percent' }, 'UNIT_MISMATCH'],
    [{ quality: 'missing', value: null }, 'QUALITY_NOT_GOOD'],
    [{ quality: 'invalid', value: null }, 'QUALITY_NOT_GOOD'],
    [{ value: null }, 'INVALID_VALUE'],
    [{ value: NaN }, 'INVALID_VALUE'],
    [{ value: Infinity }, 'INVALID_VALUE'],
    [{ value: -Infinity }, 'INVALID_VALUE'],
  ] satisfies Array<[Partial<RuleObservation>, string]>)(
    'rejects unsuitable measurements: %j',
    (patch, reason) => {
      const result = evaluateSensorRule(
        rule(),
        observation(patch),
        mapping,
        nowMs,
      );

      expect(result.reason).toBe(reason);
      expect(result.matched).toBe(false);
    },
  );

  it.each([
    'not-a-date',
    '2026-02-30T12:00:00.000Z',
    '2026-11-04T12:00:00',
    '2026-11-04T19:00:00.000+07:00',
  ])('rejects invalid or noncanonical timestamps: %s', observedAt => {
    const result = evaluateSensorRule(
      rule(),
      observation({ observedAt }),
      mapping,
      nowMs,
    );

    expect(result.reason).toBe('INVALID_OBSERVED_AT');
    expect(result.matched).toBe(false);
  });

  it.each([NaN, Infinity, 1.5, 9_000_000_000_000_000])(
    'rejects invalid evaluation time: %s',
    time => {
      expect(() =>
        evaluateSensorRule(rule(), observation(), mapping, time),
      ).toThrow('Invalid rule evaluation time.');
    },
  );

  it('is reproducible and does not modify its inputs', () => {
    const configuredRule = rule();
    const reading = observation();
    const before = structuredClone({
      configuredRule,
      reading,
      mapping,
    });

    const first = evaluateSensorRule(
      configuredRule, reading, mapping, nowMs,
    );
    const second = evaluateSensorRule(
      configuredRule, reading, mapping, nowMs,
    );

    expect(second).toEqual(first);
    expect({ configuredRule, reading, mapping }).toEqual(before);
  });
});