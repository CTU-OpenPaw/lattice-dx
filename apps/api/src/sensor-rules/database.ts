/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Pool } from 'pg';
import { isRecordId } from '@dx/contracts';
import { parseSensorReading } from '../sensors/policy.js';
import { parseSensorAssetUrn } from '../sensors/asset-identity.js';
import { parseSensorRule } from './policy.js';
import {
  evaluateSensorRule,
  type RuleAssetMapping,
} from './evaluator.js';

export class SensorRuleConflictError extends Error {
  constructor() {
    super('Sensor event ID already evaluated with different payload.');
    this.name = 'SensorRuleConflictError';
  }
}

type Outcome = 'not_matched' | 'cooldown' | 'queued';

type ReceiptRow = {
  id: string;
  outcome: Outcome;
  evaluated_at: Date | string;
  alert_id: string | null;
};

export type SensorRuleReceipt = {
  evaluationId: string;
  outcome: Outcome;
  evaluatedAt: string;
  alertId: string | null;
  duplicate: boolean;
};

function receipt(
  row: ReceiptRow,
  duplicate: boolean,
): SensorRuleReceipt {
  return {
    evaluationId: row.id,
    outcome: row.outcome,
    evaluatedAt: new Date(row.evaluated_at).toISOString(),
    alertId: row.alert_id,
    duplicate,
  };
}

/**
 * Scope comes from verified identity or trusted server configuration.
 * The caller must authorize the rule read and resolve the Asset mapping
 * within this organization before calling evaluate().
 */
export function createSensorRuleRepository(
  pool: Pool,
  scope: {
    organizationId: string;
    sourceSystem: string;
  },
) {
  const { organizationId, sourceSystem } = scope;

  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(organizationId) ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(sourceSystem)
  ) {
    throw new Error('Invalid sensor rule repository scope.');
  }

  return {
    async evaluate(input: {
      ruleEntity: unknown;
      sourcePayload: unknown;
      mapping: RuleAssetMapping;
    }): Promise<SensorRuleReceipt> {
      const rule = parseSensorRule(input.ruleEntity);
      const reading = parseSensorReading(
        input.sourcePayload,
        organizationId,
      );

      if (reading.source.system !== sourceSystem) {
        throw new Error('Sensor source does not match configured scope.');
      }

      const { mapping } = input;

      if (
        !isRecordId(mapping.assetEntityId) ||
        mapping.assetEntityId !== rule.assetEntityId ||
        mapping.assetUrn !== reading.assetUrn
      ) {
        throw new Error('Invalid tenant-scoped Asset mapping.');
      }
      parseSensorAssetUrn(mapping.assetUrn, organizationId);

      const sourcePayload = JSON.stringify(input.sourcePayload);
      const client = await pool.connect();

      try {
        await client.query('BEGIN');

        // Serialize this rule within its tenant, including rule edits and
        // changes to its target Asset. Hash collisions only reduce concurrency.
        await client.query(
          `SELECT pg_advisory_xact_lock(
             hashtextextended($1, 0)
           )`,
          [JSON.stringify(['sensor-rule', organizationId, rule.id])],
        );

        const existing = await client.query<
          ReceiptRow & { same_payload: boolean }
        >(
          `SELECT
             e.id, e.outcome, e.evaluated_at,
             a.id AS alert_id,
             e.source_payload = $5::jsonb AS same_payload
           FROM uc2_integration.sensor_rule_evaluations e
           LEFT JOIN uc2_integration.sensor_rule_alerts a
             ON a.organization_id = e.organization_id
            AND a.evaluation_id = e.id
           WHERE e.organization_id = $1
             AND e.source_system = $2
             AND e.rule_id = $3
             AND e.event_id = $4`,
          [
            organizationId,
            sourceSystem,
            rule.id,
            reading.eventId,
            sourcePayload,
          ],
        );

        if (existing.rows.length > 0) {
          const row = existing.rows[0];

          if (!row.same_payload) {
            throw new SensorRuleConflictError();
          }

          const result = receipt(row, true);
          await client.query('COMMIT');
          return result;
        }

        await client.query(
          `INSERT INTO uc2_integration.sensor_rule_state (
             organization_id, rule_id, asset_entity_id
           )
           VALUES ($1, $2, $3)
           ON CONFLICT (
             organization_id, rule_id, asset_entity_id
           ) DO NOTHING`,
          [organizationId, rule.id, rule.assetEntityId],
        );

        const state = await client.query(
          `SELECT last_alert_at
           FROM uc2_integration.sensor_rule_state
           WHERE organization_id = $1
             AND rule_id = $2
             AND asset_entity_id = $3
           FOR UPDATE`,
          [organizationId, rule.id, rule.assetEntityId],
        );

        if (state.rows.length !== 1) {
          throw new Error('Sensor rule state unavailable.');
        }

        // Read database time after acquiring the locks.
        const clock = await client.query<{ now: Date | string }>(
          'SELECT clock_timestamp() AS now',
        );

        const nowMs = new Date(clock.rows[0].now).getTime();

        const evaluation = evaluateSensorRule(
          rule,
          {
            eventId: reading.eventId,
            assetUrn: reading.assetUrn,
            attribute: reading.attribute,
            unit: reading.unit,
            quality: reading.quality,
            value: reading.value ?? null,
            observedAt: reading.observedAt,
          },
          mapping,
          nowMs,
        );

        const lastAlertAt = state.rows[0].last_alert_at;
        const lastAlertMs = lastAlertAt === null
          ? null
          : new Date(lastAlertAt).getTime();

        if (
          lastAlertMs !== null &&
          !Number.isFinite(lastAlertMs)
        ) {
          throw new Error('Invalid stored cooldown timestamp.');
        }

        const coolingDown =
          lastAlertMs !== null &&
          nowMs < lastAlertMs + rule.cooldownSeconds * 1000;

        const outcome: Outcome = !evaluation.matched
          ? 'not_matched'
          : coolingDown
            ? 'cooldown'
            : 'queued';

        const inserted = await client.query<ReceiptRow>(
          `INSERT INTO uc2_integration.sensor_rule_evaluations (
             organization_id, source_system, event_id,
             rule_id, rule_version, asset_entity_id, asset_urn,
             observed_at, evaluated_at, outcome,
             source_payload, rule_snapshot,
             mapping_snapshot, evaluation
           )
           VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
             $11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb
           )
           RETURNING id, outcome, evaluated_at`,
          [
            organizationId,
            sourceSystem,
            reading.eventId,
            rule.id,
            rule.version,
            rule.assetEntityId,
            reading.assetUrn,
            reading.observedAt,
            evaluation.evaluatedAt,
            outcome,
            sourcePayload,
            JSON.stringify(rule),
            JSON.stringify(mapping),
            JSON.stringify(evaluation),
          ],
        );

        const row = inserted.rows[0];

        if (!row) {
          throw new Error('Sensor rule evaluation was not stored.');
        }

        let alertId: string | null = null;

        if (outcome === 'queued') {
          const alert = await client.query<{ id: string }>(
            `INSERT INTO uc2_integration.sensor_rule_alerts (
               organization_id, evaluation_id
             )
             VALUES ($1, $2)
             RETURNING id`,
            [organizationId, row.id],
          );

          alertId = alert.rows[0]?.id ?? null;

          if (!alertId) {
            throw new Error('Sensor alert was not queued.');
          }

          await client.query(
            `UPDATE uc2_integration.sensor_rule_state
             SET last_alert_at = $4,
                 updated_at = clock_timestamp()
             WHERE organization_id = $1
               AND rule_id = $2
               AND asset_entity_id = $3`,
            [
              organizationId,
              rule.id,
              rule.assetEntityId,
              evaluation.evaluatedAt,
            ],
          );
        }

        const result = receipt(
          { ...row, alert_id: alertId },
          false,
        );

        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
