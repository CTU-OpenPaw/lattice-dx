/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Pool, PoolClient } from 'pg';
import { parseSensorReading, SensorInputError } from './policy.js';

export class SensorConflictError extends Error {
  constructor() {
    super('Sensor event ID already used with different payload.');
    this.name = 'SensorConflictError';
  }
}

export type StoredSensorReading = {
  id: string;
  eventId: string;
  assetUrn: string;
  quality: 'good' | 'missing' | 'invalid';
  observedAt: string;
  receivedAt: string;
  duplicate: boolean;
};

type ReadingRow = {
  id: string;
  event_id: string;
  asset_urn: string;
  quality: StoredSensorReading['quality'];
  observed_at: Date | string;
  received_at: Date | string;
};

function result(
  row: ReadingRow,
  duplicate: boolean,
): StoredSensorReading {
  return {
    id: row.id,
    eventId: row.event_id,
    assetUrn: row.asset_urn,
    quality: row.quality,
    observedAt: new Date(row.observed_at).toISOString(),
    receivedAt: new Date(row.received_at).toISOString(),
    duplicate,
  };
}

async function ensureDelivery(
  client: PoolClient,
  readingId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO uc2_integration.sensor_deliveries (
       reading_id, status, completed_at
     )
     SELECT
       id,
       CASE WHEN quality = 'good' THEN 'pending' ELSE 'skipped' END,
       CASE WHEN quality = 'good' THEN NULL ELSE clock_timestamp() END
     FROM uc2_integration.sensor_readings
     WHERE id = $1
     ON CONFLICT (reading_id) DO NOTHING`,
    [readingId],
  );
}

/**
 * Scope must come from trusted server configuration or verified identity.
 * Payload source labels do not authenticate the caller.
 */
export function createSensorRepository(
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
    throw new SensorInputError('Invalid configured sensor source scope.');
  }

  return {
    async record(input: unknown): Promise<StoredSensorReading> {
      const reading = parseSensorReading(input, organizationId);

      if (reading.source.system !== sourceSystem) {
        throw new SensorInputError(
          'Sensor source does not match the configured source.',
        );
      }

      // Expected input is a parsed JSON request or fixture.
      // JSONB comparison ignores object-key order.
      const sourcePayload = JSON.stringify(input);

      const client = await pool.connect();

      try {
        await client.query('BEGIN');

        const inserted = await client.query<ReadingRow>(
          `INSERT INTO uc2_integration.sensor_readings (
             organization_id,
             source_system,
             source_device_id,
             event_id,
             asset_urn,
             attribute,
             unit,
             observed_at,
             simulated,
             quality,
             quality_reason,
             value,
             source_payload
           )
           VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb
           )
           ON CONFLICT (
             organization_id, source_system, event_id
           ) DO NOTHING
           RETURNING
             id::text, event_id, asset_urn, quality,
             observed_at, received_at`,
          [
            organizationId,
            sourceSystem,
            reading.source.deviceId,
            reading.eventId,
            reading.assetUrn,
            reading.attribute,
            reading.unit,
            reading.observedAt,
            reading.simulated,
            reading.quality,
            reading.qualityReason,
            reading.value ?? null,
            sourcePayload,
          ],
        );

        if (inserted.rows.length === 1) {
          const stored = result(inserted.rows[0], false);
          await ensureDelivery(client, stored.id);
          await client.query('COMMIT');
          return stored;
      }

        // A separate statement sees a competing committed insert under
        // PostgreSQL's default READ COMMITTED isolation.
        const existing = await client.query<
          ReadingRow & { same_payload: boolean }
        >(
          `SELECT
             id::text, event_id, asset_urn, quality,
             observed_at, received_at,
             source_payload = $4::jsonb AS same_payload
           FROM uc2_integration.sensor_readings
           WHERE organization_id = $1
             AND source_system = $2
             AND event_id = $3
           FOR SHARE`,
          [
            organizationId,
            sourceSystem,
            reading.eventId,
            sourcePayload,
          ],
        );

        const row = existing.rows[0];

        if (!row) {
          throw new Error('Sensor receipt unavailable after insert conflict.');
        }

        if (!row.same_payload) {
          throw new SensorConflictError();
        }

        const stored = result(row, true);
        await ensureDelivery(client, stored.id);
        await client.query('COMMIT');
        return stored;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}