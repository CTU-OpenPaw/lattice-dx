/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { mapHandoverToAsset } from './asset-mapping.js';
import {
  syncAssetProjection,
  type BrokerPort,
} from './broker-sync.js';

type Projection = ReturnType<typeof mapHandoverToAsset>;

type Job = {
  organization_id: string;
  event_id: string;
  asset_urn: string;
  source_observed_at: string;
  projection: Projection;
  attempts: number;
  lease_token: string;
};

const MAX_ATTEMPTS = 5;
const LOCK_NAMESPACE = 184903;
const LOCK_ID = 1;

function errorCode(error: unknown): string {
  if (error && typeof error === 'object') {
    const value = error as { code?: unknown; status?: unknown };

    if (
      typeof value.code === 'string' &&
      /^[A-Z][A-Z0-9_]{0,63}$/.test(value.code)
    ) {
      return value.code;
    }

    if (typeof value.status === 'number') {
      return `BROKER_HTTP_${value.status}`;
    }
  }

  // Do not persist URLs, credentials or raw upstream error bodies.
  return 'BROKER_DELIVERY_FAILED';
}

function permanent(code: string): boolean {
  return [
    'OBSERVATION_CONFLICT',
    'ASSET_IDENTITY_MISMATCH',
    'RELATIONSHIP_TARGET_MISMATCH',
    'INVALID_OBSERVATION',
    'INVALID_JOB_PROJECTION',
  ].includes(code);
}

async function claim(client: PoolClient, organizationId: string,): Promise<Job | undefined> {
  await client.query('BEGIN');

  try {
    // Recover attempts whose worker stopped before recording a result.
        await client.query(
      `UPDATE uc1_integration.asset_attempts a
       SET outcome = 'abandoned', finished_at = clock_timestamp(),
           error_code = 'LEASE_EXPIRED'
       FROM uc1_integration.asset_jobs j
       WHERE a.organization_id = j.organization_id
         AND a.event_id = j.event_id
         AND a.lease_token = j.lease_token
         AND a.outcome = 'processing'
         AND j.status = 'processing'
         AND j.lease_until <= clock_timestamp()
         AND j.organization_id = $1`,
      [organizationId],
    );

    await client.query(
      `UPDATE uc1_integration.asset_jobs
       SET status = 'failed', lease_token = NULL, lease_until = NULL,
           last_error_code = 'LEASE_EXPIRED',
           updated_at = clock_timestamp(),
           completed_at = clock_timestamp()
       WHERE status = 'processing'
         AND lease_until <= clock_timestamp()
         AND attempts >= $1
         AND organization_id = $2`,
      [MAX_ATTEMPTS, organizationId],
    );

    const token = randomUUID();

    const result = await client.query<Job>(
      `WITH candidate AS (
         SELECT organization_id, event_id
         FROM uc1_integration.asset_jobs
         WHERE organization_id = $3 AND attempts < $1
           AND (
             (status = 'pending' AND available_at <= clock_timestamp())
             OR
             (status = 'processing' AND lease_until <= clock_timestamp())
           )
         ORDER BY created_at, organization_id, event_id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE uc1_integration.asset_jobs j
       SET status = 'processing',
           attempts = j.attempts + 1,
           lease_token = $2,
           lease_until = clock_timestamp() + interval '60 seconds',
           updated_at = clock_timestamp(),
           completed_at = NULL
       FROM candidate c
       WHERE j.organization_id = c.organization_id
         AND j.event_id = c.event_id
       RETURNING j.*`,
      [MAX_ATTEMPTS, token, organizationId],
    );

    const job = result.rows[0];

    if (job) {
      await client.query(
        `INSERT INTO uc1_integration.asset_attempts (
           organization_id, event_id, attempt_number, lease_token
         ) VALUES ($1,$2,$3,$4)`,
        [
          job.organization_id,
          job.event_id,
          job.attempts,
          job.lease_token,
        ],
      );
    }

    await client.query('COMMIT');
    return job;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function runAssetJob(
  pool: Pool,
  broker: BrokerPort,
  organizationId: string,
): Promise<'idle' | 'succeeded' | 'stale' | 'retry' | 'failed' | 'conflict'> {
  const client = await pool.connect();
  let locked = false;
  let discardConnection = false;

  try {
    const lock = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1::int, $2::int) AS acquired',
      [LOCK_NAMESPACE, LOCK_ID],
    );

    locked = lock.rows[0]?.acquired === true;
    if (!locked) return 'idle';

    const job = await claim(client, organizationId);
    if (!job) return 'idle';

    let outcome: 'succeeded' | 'stale' | 'retry' | 'failed' | 'conflict';
    let code: string | null = null;
    let result: string | null = null;

    try {
      if (
        job.projection?.entity?.id !== job.asset_urn ||
        job.projection.entity.organizationId.value !== job.organization_id ||
        job.projection.entity.sourceEventId.value !== job.event_id ||
        job.projection.entity.status.observedAt !== job.source_observed_at
      ) {
        throw Object.assign(new Error('Invalid frozen projection'), {
          code: 'INVALID_JOB_PROJECTION',
        });
      }

      result = await syncAssetProjection(broker, job.projection);
      outcome = result === 'stale' ? 'stale' : 'succeeded';
    } catch (error) {
      code = errorCode(error);

      outcome = code === 'OBSERVATION_CONFLICT'
        ? 'conflict'
        : permanent(code) || job.attempts >= MAX_ATTEMPTS
          ? 'failed'
          : 'retry';
    }

    await client.query('BEGIN');

    try {
      const status = outcome === 'retry' ? 'pending' : outcome;
      const retrySeconds = Math.min(300, 5 * 2 ** (job.attempts - 1));

      const updated = await client.query(
        `UPDATE uc1_integration.asset_jobs
         SET status = $4,
             lease_token = NULL,
             lease_until = NULL,
             last_error_code = $5,
             available_at = CASE WHEN $4 = 'pending'
               THEN clock_timestamp() + $6 * interval '1 second'
               ELSE available_at END,
             updated_at = clock_timestamp(),
             completed_at = CASE WHEN $4 = 'pending'
               THEN NULL ELSE clock_timestamp() END
         WHERE organization_id = $1 AND event_id = $2
           AND status = 'processing' AND lease_token = $3`,
        [
          job.organization_id, job.event_id, job.lease_token,
          status, code, retrySeconds,
        ],
      );

      if (updated.rowCount !== 1) {
        throw new Error('Job lease no longer belongs to this worker');
      }

      const attempt = await client.query(
        `UPDATE uc1_integration.asset_attempts
         SET outcome = $4, error_code = $5,
             finished_at = clock_timestamp()
         WHERE organization_id = $1 AND event_id = $2
           AND lease_token = $3 AND outcome = 'processing'`,
        [
          job.organization_id, job.event_id, job.lease_token,
          outcome, code,
        ],
      );

      if (attempt.rowCount !== 1) {
        throw new Error('Attempt record no longer belongs to this worker');
      }

      if (outcome === 'succeeded') {
        await client.query(
          `INSERT INTO uc1_integration.asset_heads (
             organization_id, asset_urn, applied_event_id,
             source_observed_at, applied_attributes
           ) VALUES ($1,$2,$3,$4,$5::jsonb)
           ON CONFLICT (organization_id, asset_urn)
           DO UPDATE SET
             applied_event_id = EXCLUDED.applied_event_id,
             source_observed_at = EXCLUDED.source_observed_at,
             applied_attributes = EXCLUDED.applied_attributes,
             updated_at = clock_timestamp()`,
          [
            job.organization_id,
            job.asset_urn,
            job.event_id,
            job.source_observed_at,
            JSON.stringify(job.projection.attributes),
          ],
        );
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }

    console.info(JSON.stringify({
      component: 'uc1-broker-worker',
      eventId: job.event_id,
      assetUrn: job.asset_urn,
      attempt: job.attempts,
      outcome,
      result,
      errorCode: code,
    }));

    return outcome;
  } finally {
    if (locked) {
      try {
        await client.query(
          'SELECT pg_advisory_unlock($1::int, $2::int)',
          [LOCK_NAMESPACE, LOCK_ID],
        );
      } catch {
        // A connection with uncertain lock state must not return to the pool.
        discardConnection = true;
      }
    }

    client.release(discardConnection);
  }
}