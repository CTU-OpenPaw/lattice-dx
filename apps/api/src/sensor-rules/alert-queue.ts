/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Pool } from 'pg';
import type {
  AlertSettlement,
  ClaimedSensorAlert,
  SensorAlertQueue,
} from './alert-worker.js';

type AlertRow = {
  id: string;
  organization_id: string;
  evaluation_id: string;
  attempts: number;
  lease_token: string;
  source_system: string;
  event_id: string;
  asset_entity_id: string;
  asset_urn: string;
  rule_id: string;
  rule_version: number;
  observed_at: Date | string;
  evaluated_at: Date | string;
  source_payload: Record<string, unknown>;
  rule_snapshot: Record<string, unknown>;
  mapping_snapshot: Record<string, unknown>;
  evaluation: Record<string, unknown>;
};

function claimed(row: AlertRow): ClaimedSensorAlert {
  return {
    id: row.id,
    organizationId: row.organization_id,
    evaluationId: row.evaluation_id,
    attempt: row.attempts,
    leaseToken: row.lease_token,
    sourceSystem: row.source_system,
    eventId: row.event_id,
    assetEntityId: row.asset_entity_id,
    assetUrn: row.asset_urn,
    ruleId: row.rule_id,
    ruleVersion: row.rule_version,
    observedAt: new Date(row.observed_at).toISOString(),
    evaluatedAt: new Date(row.evaluated_at).toISOString(),
    sourcePayload: row.source_payload,
    ruleSnapshot: row.rule_snapshot,
    mappingSnapshot: row.mapping_snapshot,
    evaluation: row.evaluation,
  };
}

/**
 * Use the same maxAttempts value for this queue and its worker.
 * Scope comes from trusted configuration, never from a delivery payload.
 */
export function createSensorAlertQueue(
  pool: Pool,
  options: {
    organizationId: string;
    maxAttempts?: number;
  },
): SensorAlertQueue {
  const { organizationId, maxAttempts = 5 } = options;

  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(organizationId) ||
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 20
  ) {
    throw new Error('Invalid sensor alert queue configuration.');
  }

  return {
    async claim(): Promise<ClaimedSensorAlert | null> {
      const client = await pool.connect();

      try {
        await client.query('BEGIN');

        // Finish exhausted deliveries in bounded batches.
        // An active lease is never reclaimed before its deadline.
        await client.query(
          `WITH exhausted AS (
             SELECT id
             FROM uc2_integration.sensor_rule_alerts
             WHERE organization_id = $1
               AND attempts >= $2
               AND (
                 (status = 'pending'
                   AND available_at <= clock_timestamp())
                 OR
                 (status = 'processing'
                   AND lease_until <= clock_timestamp())
               )
             ORDER BY created_at, id
             LIMIT 25
             FOR UPDATE SKIP LOCKED
           )
           UPDATE uc2_integration.sensor_rule_alerts a
           SET status = 'failed',
               lease_token = NULL,
               lease_until = NULL,
               last_error_code = 'ALERT_ATTEMPTS_EXHAUSTED',
               completed_at = clock_timestamp(),
               updated_at = clock_timestamp()
           FROM exhausted x
           WHERE a.id = x.id
             AND a.organization_id = $1`,
          [organizationId, maxAttempts],
        );

        const result = await client.query<AlertRow>(
          `WITH candidate AS (
             SELECT id
             FROM uc2_integration.sensor_rule_alerts
             WHERE organization_id = $1
               AND attempts < $2
               AND (
                 (status = 'pending'
                   AND available_at <= clock_timestamp())
                 OR
                 (status = 'processing'
                   AND lease_until <= clock_timestamp())
               )
             ORDER BY available_at, created_at, id
             LIMIT 1
             FOR UPDATE SKIP LOCKED
           ),
           leased AS (
             UPDATE uc2_integration.sensor_rule_alerts a
             SET status = 'processing',
                 attempts = a.attempts + 1,
                 lease_token = gen_random_uuid(),
                 lease_until = clock_timestamp() + interval '60 seconds',
                 completed_at = NULL,
                 updated_at = clock_timestamp()
             FROM candidate c
             WHERE a.id = c.id
               AND a.organization_id = $1
             RETURNING a.*
           )
           SELECT
             a.id, a.organization_id, a.evaluation_id,
             a.attempts, a.lease_token,
             e.source_system, e.event_id,
             e.asset_entity_id, e.asset_urn,
             e.rule_id, e.rule_version,
             e.observed_at, e.evaluated_at,
             e.source_payload, e.rule_snapshot,
             e.mapping_snapshot, e.evaluation
           FROM leased a
           JOIN uc2_integration.sensor_rule_evaluations e
             ON e.organization_id = a.organization_id
            AND e.id = a.evaluation_id`,
          [organizationId, maxAttempts],
        );

        const row = result.rows[0];
        const alert = row ? claimed(row) : null;

        await client.query('COMMIT');
        return alert;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async settle(
      alert: ClaimedSensorAlert,
      result: AlertSettlement,
    ): Promise<boolean> {
      if (alert.organizationId !== organizationId) {
        return false;
      }

      if (result.status === 'succeeded') {
        const updated = await pool.query(
          `UPDATE uc2_integration.sensor_rule_alerts
           SET status = 'succeeded',
               target_record_id = $5,
               receipt = $6::jsonb,
               lease_token = NULL,
               lease_until = NULL,
               last_error_code = NULL,
               completed_at = clock_timestamp(),
               updated_at = clock_timestamp()
           WHERE organization_id = $1
             AND id = $2
             AND status = 'processing'
             AND lease_token = $3
             AND attempts = $4
             AND lease_until > clock_timestamp()`,
          [
            organizationId,
            alert.id,
            alert.leaseToken,
            alert.attempt,
            result.targetRecordId,
            JSON.stringify(result.receipt),
          ],
        );

        return updated.rowCount === 1;
      }

      if (
        !Number.isSafeInteger(result.retrySeconds) ||
        result.retrySeconds < 0 ||
        result.retrySeconds > 300 ||
        !/^[A-Z][A-Z0-9_]{0,79}$/.test(result.errorCode)
      ) {
        throw new Error('Invalid alert failure settlement.');
      }

      // Enforce the attempt limit even if a caller requests another retry.
      const status = result.status === 'pending' &&
        alert.attempt < maxAttempts
        ? 'pending'
        : 'failed';

      const updated = await pool.query(
        `UPDATE uc2_integration.sensor_rule_alerts
         SET status = $5,
             lease_token = NULL,
             lease_until = NULL,
             last_error_code = $6,
             available_at = CASE WHEN $5 = 'pending'
               THEN clock_timestamp() + $7 * interval '1 second'
               ELSE available_at END,
             completed_at = CASE WHEN $5 = 'failed'
               THEN clock_timestamp() ELSE NULL END,
             updated_at = clock_timestamp()
         WHERE organization_id = $1
           AND id = $2
           AND status = 'processing'
           AND lease_token = $3
           AND attempts = $4
           AND lease_until > clock_timestamp()`,
        [
          organizationId,
          alert.id,
          alert.leaseToken,
          alert.attempt,
          status,
          result.errorCode,
          result.retrySeconds,
        ],
      );

      return updated.rowCount === 1;
    },
  };
}