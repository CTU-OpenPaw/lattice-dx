// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { createSensorBrokerClient, SensorBrokerError } from './broker-client.js';
import { syncSensorReading, SensorSyncError } from './broker-sync.js';
import { SensorInputError } from './policy.js';

type Broker = ReturnType<typeof createSensorBrokerClient>;

export type SensorDeliveryResult = {
  outcome:
    | 'idle'
    | 'busy'
    | 'succeeded'
    | 'stale'
    | 'skipped'
    | 'retry'
    | 'failed';
  readingId?: string;
  attempt?: number;
  errorCode?: string;
};

type Job = {
  reading_id: string;
  asset_urn: string;
  attribute: string;
  source_payload: unknown;
  attempts: number;
};

function failure(error: unknown): {
  code: string;
  permanent: boolean;
} {
  if (error instanceof SensorInputError) {
    return { code: 'INVALID_STORED_READING', permanent: true };
  }

  if (error instanceof SensorSyncError) {
    return {
      code: error.code,
      permanent: error.code !== 'BROKER_READBACK_MISMATCH',
    };
  }

  if (error instanceof SensorBrokerError) {
    return {
      code: error.code,
      permanent:
        error.status === 400 ||
        error.status === 401 ||
        error.status === 403 ||
        error.status === 404 ||
        [
          'BROKER_CONFIG_INVALID',
          'ASSET_ID_INVALID',
          'SENSOR_ATTRIBUTE_INVALID',
        ].includes(error.code),
    };
  }

  return { code: 'SENSOR_DELIVERY_FAILED', permanent: false };
}

/**
 * Process at most one pending delivery for the configured tenant.
 * Network calls occur under transaction-scoped locks.
 * External broker writers do not share these PostgreSQL locks.
 */
export async function runSensorDelivery(
  pool: Pool,
  broker: Broker,
  tenant: string,
): Promise<SensorDeliveryResult> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(tenant)) {
    throw new SensorInputError('Invalid configured tenant.');
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const selected = await client.query<Job>(
      `SELECT
         d.reading_id::text,
         d.attempts,
         r.asset_urn,
         r.attribute,
         r.source_payload
       FROM uc2_integration.sensor_deliveries d
       JOIN uc2_integration.sensor_readings r
         ON r.id = d.reading_id
       WHERE r.organization_id = $1
         AND d.status = 'pending'
         AND d.attempts < 5
       ORDER BY d.created_at, d.reading_id
       LIMIT 1
       FOR UPDATE OF d SKIP LOCKED`,
      [tenant],
    );

    const job = selected.rows[0];

    if (!job) {
      await client.query('COMMIT');
      return { outcome: 'idle' };
    }

    const lockKey = createHash('sha256')
      .update(JSON.stringify([
        'uc2-sensor',
        tenant,
        job.asset_urn,
        job.attribute,
      ]))
      .digest()
      .readBigInt64BE(0)
      .toString();

    const lock = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_xact_lock($1::bigint) AS acquired',
      [lockKey],
    );

    if (!lock.rows[0].acquired) {
      await client.query('ROLLBACK');
      return { outcome: 'busy', readingId: job.reading_id };
    }

    const attempt = job.attempts + 1;
    let outcome: SensorDeliveryResult['outcome'];
    let status: string;
    let errorCode: string | null = null;

    try {
      const synced = await syncSensorReading(
        broker,
        job.source_payload,
        tenant,
      );

      // Both an update and an already matching broker value are successful.
      status =
        synced === 'stale'
          ? 'stale'
          : synced === 'skipped'
            ? 'skipped'
            : 'succeeded';

      outcome = status as 'stale' | 'skipped' | 'succeeded';
    } catch (error) {
      const classified = failure(error);
      errorCode = classified.code;

      const terminal = classified.permanent || attempt >= 5;
      status = terminal ? 'failed' : 'pending';
      outcome = terminal ? 'failed' : 'retry';
    }

    const updated = await client.query(
      `UPDATE uc2_integration.sensor_deliveries
       SET status = $2,
           attempts = attempts + 1,
           last_error_code = $3,
           last_attempt_at = clock_timestamp(),
           completed_at = CASE
             WHEN $2 = 'pending' THEN NULL
             ELSE clock_timestamp()
           END
       WHERE reading_id = $1
         AND status = 'pending'
         AND attempts = $4`,
      [job.reading_id, status, errorCode, job.attempts],
    );

    if (updated.rowCount !== 1) {
      throw new Error('Sensor delivery state changed unexpectedly.');
    }

    await client.query('COMMIT');

    return {
      outcome,
      readingId: job.reading_id,
      attempt,
      ...(errorCode ? { errorCode } : {}),
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}