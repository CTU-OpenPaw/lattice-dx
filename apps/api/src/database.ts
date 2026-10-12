// SPDX-License-Identifier: Apache-2.0
import { Pool } from 'pg';
import type { RecordItem, RecordRepository } from './records.js';
import { foundationDatabase } from './foundation-database.js';
export async function connectRecords(connectionString: string) {
  const pool = new Pool({ connectionString, max: 5, connectionTimeoutMillis: 5000 });
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS records (
      id uuid PRIMARY KEY, title text NOT NULL, owner_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await pool.query('CREATE INDEX IF NOT EXISTS records_owner_idx ON records(owner_id, created_at)');
    // Legacy rows remain unscoped and invisible until an explicit audited migration.
    await pool.query('ALTER TABLE records ADD COLUMN IF NOT EXISTS organization_id text');
    await pool.query('CREATE INDEX IF NOT EXISTS records_scope_idx ON records(organization_id, owner_id, created_at)');
  } catch (error) { await pool.end(); throw error; }
  const columns = 'id, title, owner_id AS "ownerId", organization_id AS "organizationId", created_at AS "createdAt"';
  function serialize(row: RecordItem & { createdAt: Date | string }): RecordItem {
    return { ...row, createdAt: new Date(row.createdAt).toISOString() };
  }
  const repository: RecordRepository = {
    async create(title, ownerId, organizationId) {
      const result = await pool.query(`INSERT INTO records(id, title, owner_id, organization_id) VALUES ($1, $2, $3, $4) RETURNING ${columns}`, [crypto.randomUUID(), title, ownerId, organizationId]);
      return serialize(result.rows[0]);
    },
    async list(ownerId, organizationId) {
      const result = await pool.query(`SELECT ${columns} FROM records WHERE owner_id = $1 AND organization_id = $2 ORDER BY created_at DESC LIMIT 100`, [ownerId, organizationId]);
      return result.rows.map(serialize);
    },
  };
  try { return { repository, foundation:await foundationDatabase(pool), close: () => pool.end() }; }
  catch(error){await pool.end();throw error;}
}
