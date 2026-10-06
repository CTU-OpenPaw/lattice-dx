// SPDX-License-Identifier: Apache-2.0
import { Pool } from 'pg';
import type { RecordItem, RecordRepository } from './records.js';
export async function connectRecords(connectionString: string) {
  const pool = new Pool({ connectionString, max: 5, connectionTimeoutMillis: 5000 });
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS records (
      id uuid PRIMARY KEY, title text NOT NULL, owner_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await pool.query('CREATE INDEX IF NOT EXISTS records_owner_idx ON records(owner_id, created_at)');
  } catch (error) { await pool.end(); throw error; }
  const columns = 'id, title, owner_id AS "ownerId", created_at AS "createdAt"';
  function serialize(row: RecordItem & { createdAt: Date | string }): RecordItem {
    return { ...row, createdAt: new Date(row.createdAt).toISOString() };
  }
  const repository: RecordRepository = {
    async create(title, ownerId) {
      const result = await pool.query(`INSERT INTO records(id, title, owner_id) VALUES ($1, $2, $3) RETURNING ${columns}`, [crypto.randomUUID(), title, ownerId]);
      return serialize(result.rows[0]);
    },
    async list(ownerId) {
      const result = await pool.query(`SELECT ${columns} FROM records WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 100`, [ownerId]);
      return result.rows.map(serialize);
    },
  };
  return { repository, close: () => pool.end() };
}
