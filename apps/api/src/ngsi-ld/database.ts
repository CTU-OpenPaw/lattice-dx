// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { shouldApply } from './policy.js';
import type { AssetContext, ContextRepository } from './types.js';
const columns = `organization_id AS "organizationId", entity_id AS "entityId", business_id AS "businessId", status,
  observed_at AS "observedAt", subscription_id AS "subscriptionId", notification_id AS "notificationId", received_at AS "receivedAt"`;
function context(row: AssetContext): AssetContext {
  return { ...row, observedAt: new Date(row.observedAt).toISOString(), receivedAt: new Date(row.receivedAt).toISOString() };
}
export async function ngsiLdDatabase(pool: Pool): Promise<ContextRepository> {
  await pool.query(`CREATE TABLE IF NOT EXISTS ngsi_ld_asset_context (
    organization_id text NOT NULL, entity_id text NOT NULL, business_id text NOT NULL, status text NOT NULL,
    observed_at timestamptz NOT NULL, subscription_id text NOT NULL, notification_id text NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (organization_id, entity_id)
  )`);
  return {
    async find(organizationId, entityId) {
      const row = (await pool.query(`SELECT ${columns} FROM ngsi_ld_asset_context WHERE organization_id=$1 AND entity_id=$2`, [organizationId, entityId])).rows[0];
      return row ? context(row) : undefined;
    },
    async apply(organizationId, notification) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        let applied = 0, ignored = 0;
        // Sorted advisory locks also serialize concurrent first inserts and prevent opposite batch lock order.
        for (const incoming of [...notification.observations].sort((a, b) => a.entityId.localeCompare(b.entityId))) {
          const key = createHash('sha256').update(JSON.stringify([organizationId, incoming.entityId])).digest().readBigInt64BE(0).toString();
          await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [key]);
          const row = (await client.query(`SELECT ${columns} FROM ngsi_ld_asset_context WHERE organization_id=$1 AND entity_id=$2 FOR UPDATE`, [organizationId, incoming.entityId])).rows[0];
          if (!shouldApply(row ? context(row) : undefined, incoming)) { ignored++; continue; }
          await client.query(`INSERT INTO ngsi_ld_asset_context (organization_id,entity_id,business_id,status,observed_at,subscription_id,notification_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (organization_id,entity_id) DO UPDATE SET
            status=EXCLUDED.status,observed_at=EXCLUDED.observed_at,subscription_id=EXCLUDED.subscription_id,
            notification_id=EXCLUDED.notification_id,received_at=now()`,
            [organizationId, incoming.entityId, incoming.businessId, incoming.status, incoming.observedAt, notification.subscriptionId, notification.id]);
          applied++;
        }
        await client.query('COMMIT');
        return { applied, ignored };
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    },
  };
}
