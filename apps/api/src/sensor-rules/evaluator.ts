/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type { SensorRule } from './policy.js';

export type RuleObservation = {
  eventId: string;
  assetUrn: string;
  attribute: string;
  unit: string;
  quality: 'good' | 'missing' | 'invalid';
  value: number | null;
  observedAt: string;
};

/**
 * Supplied by a trusted, tenant-scoped mapping lookup.
 * Never derive this mapping from an unverified sensor payload.
 */
export type RuleAssetMapping = {
  assetEntityId: string;
  assetUrn: string;
};

export type RuleEvaluationReason =
  | 'RULE_DISABLED'
  | 'ASSET_MISMATCH'
  | 'ATTRIBUTE_MISMATCH'
  | 'UNIT_MISMATCH'
  | 'QUALITY_NOT_GOOD'
  | 'INVALID_VALUE'
  | 'INVALID_OBSERVED_AT'
  | 'FUTURE_OBSERVATION'
  | 'STALE_OBSERVATION'
  | 'THRESHOLD_NOT_MET'
  | 'THRESHOLD_MET';

export type RuleEvaluation = {
  ruleId: string;
  ruleVersion: number;
  eventId: string;
  assetUrn: string;
  evaluatedAt: string;
  matched: boolean;
  reason: RuleEvaluationReason;
  observationAgeSeconds: number | null;
};

/**
 * Sensor policy stores timestamps in canonical UTC ISO format.
 * Round-trip validation also rejects impossible calendar dates.
 */
function observationTimestamp(value: string): number | null {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    return null;
  }

  const timestamp = Date.parse(value);

  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== value
  ) {
    return null;
  }

  return timestamp;
}

function thresholdMatches(
  operator: SensorRule['operator'],
  value: number,
  threshold: number,
): boolean {
  switch (operator) {
    case 'gt':
      return value > threshold;
    case 'gte':
      return value >= threshold;
    case 'lt':
      return value < threshold;
    case 'lte':
      return value <= threshold;
    default:
      throw new Error('Unsupported parsed sensor rule operator.');
  }
}

/**
 * Pure evaluation: no database writes, cooldown reservation or case creation.
 *
 * rule must come from parseSensorRule().
 * observation must come from the validated sensor repository.
 * Authorization and tenant-scoped mapping are caller responsibilities.
 *
 * nowMs is supplied explicitly for reproducible fixtures and replay.
 * A match is only a candidate; durable dedupe/cooldown must authorize delivery.
 */
export function evaluateSensorRule(
  rule: SensorRule,
  observation: RuleObservation,
  mapping: RuleAssetMapping,
  nowMs: number,
): RuleEvaluation {
  if (
    !Number.isSafeInteger(nowMs) ||
    !Number.isFinite(new Date(nowMs).getTime())
  ) {
    throw new Error('Invalid rule evaluation time.');
  }

  const base = {
    ruleId: rule.id,
    ruleVersion: rule.version,
    eventId: observation.eventId,
    assetUrn: observation.assetUrn,
    evaluatedAt: new Date(nowMs).toISOString(),
  };

  let observationAgeSeconds: number | null = null;

  function decision(
    reason: RuleEvaluationReason,
    matched = false,
  ): RuleEvaluation {
    return {
      ...base,
      matched,
      reason,
      observationAgeSeconds,
    };
  }

  if (!rule.enabled) {
    return decision('RULE_DISABLED');
  }

  if (
    rule.assetEntityId !== mapping.assetEntityId ||
    observation.assetUrn !== mapping.assetUrn
  ) {
    return decision('ASSET_MISMATCH');
  }

  if (observation.attribute !== rule.attribute) {
    return decision('ATTRIBUTE_MISMATCH');
  }

  if (observation.unit !== rule.unit) {
    return decision('UNIT_MISMATCH');
  }

  if (observation.quality !== 'good') {
    return decision('QUALITY_NOT_GOOD');
  }

  if (
    typeof observation.value !== 'number' ||
    !Number.isFinite(observation.value)
  ) {
    return decision('INVALID_VALUE');
  }

  const observedMs = observationTimestamp(observation.observedAt);

  if (observedMs === null) {
    return decision('INVALID_OBSERVED_AT');
  }

  const ageMs = nowMs - observedMs;
  observationAgeSeconds = ageMs / 1000;

  // Reject future timestamps rather than silently treating them as fresh.
  if (ageMs < 0) {
    return decision('FUTURE_OBSERVATION');
  }

  // Exactly at the configured age limit remains valid.
  if (ageMs > rule.maxObservationAgeSeconds * 1000) {
    return decision('STALE_OBSERVATION');
  }

  if (!thresholdMatches(rule.operator, observation.value, rule.threshold)) {
    return decision('THRESHOLD_NOT_MET');
  }

  return decision('THRESHOLD_MET', true);
}