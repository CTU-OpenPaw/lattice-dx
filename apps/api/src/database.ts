// SPDX-License-Identifier: Apache-2.0
import { Pool } from 'pg';
import { taskLifecycleDatabase } from './tasks/database.js';
import { initializeCreateCommands, runCreateCommand } from './create-command.js';
import { createDirectoryDatabase } from './directory-database.js';
import { pageResult } from './pagination.js';
import type { RecordItem, RecordRepository } from './records.js';
import { foundationDatabase } from './foundation-database.js';
import { definitionDatabase } from './workflows/registry-database.js';
import { workflowDatabase } from './workflows/database.js';
import { workflowJobDatabase } from './workflows/job-database.js';
import { entityDatabase } from './entities/database.js';
import { entityDataToolsDatabase } from './entities/data-tools-database.js';
import { organizationDatabase } from './organization/database.js';
import {operationsDatabase} from './operations/database.js';
import {eventsDatabase} from './events/database.js';
import {modulesDatabase} from './modules/database.js';
import {automationsDatabase} from './automations/database.js';
export async function connectRecords(connectionString: string) {
  const pool = new Pool({ connectionString, max: 5, connectionTimeoutMillis: 5000 });
  try {
    const repository=await recordDatabase(pool);
    const directory=await createDirectoryDatabase(pool);
    const organization=await organizationDatabase(pool);
    const foundation=await foundationDatabase(pool);
    const definitionRegistry=await definitionDatabase(pool);
    const workflows=await workflowDatabase(pool,definitionRegistry);
    const events=await eventsDatabase(pool,definitionRegistry,workflows);
    const entities=await entityDatabase(pool);
    const automations=await automationsDatabase(pool,definitionRegistry,workflows);
    const dataTools=await entityDataToolsDatabase(pool);
    const modules=await modulesDatabase(pool,workflows);
    const taskLifecycle=await taskLifecycleDatabase(pool);
    return {repository,foundation,directory,organization,workflows,events,automations,modules,taskLifecycle,definitionRegistry,entities,dataTools,operations:operationsDatabase(pool),jobs:workflowJobDatabase(pool),close:()=>pool.end()};
  } catch(error){await pool.end();throw error;}
}
export async function recordDatabase(pool:Pool):Promise<RecordRepository> {
    await pool.query(`CREATE TABLE IF NOT EXISTS records (
      id uuid PRIMARY KEY, title text NOT NULL, owner_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await pool.query('CREATE INDEX IF NOT EXISTS records_owner_idx ON records(owner_id, created_at)');
    // Legacy rows remain unscoped and invisible until an explicit audited migration.
    await pool.query('ALTER TABLE records ADD COLUMN IF NOT EXISTS organization_id text');
    await pool.query('CREATE INDEX IF NOT EXISTS records_scope_idx ON records(organization_id, owner_id, created_at)');
  await initializeCreateCommands(pool);
  const columns = 'id, title, owner_id AS "ownerId", organization_id AS "organizationId", created_at AS "createdAt"';
  function serialize(row: RecordItem & { createdAt: Date | string }): RecordItem {
    return { ...row, createdAt: new Date(row.createdAt).toISOString() };
  }
  const repository: RecordRepository = {
    supportsCreateCommands:true,
    async listPage(subject,organizationId,query) {
      const rows=(await pool.query(`SELECT ${columns} FROM records r WHERE organization_id=$1 AND
        (owner_id=$2 OR (NOT EXISTS(SELECT 1 FROM workflow_runs w WHERE w.id=r.id) AND EXISTS(SELECT 1 FROM foundation_tasks t WHERE t.record_id=r.id AND t.organization_id=$1 AND t.assignee_id=$2 AND t.created_by=r.owner_id AND t.status<>'cancelled')))
        AND ($3='' OR strpos(lower(title),lower($3))>0) ORDER BY created_at DESC,id DESC LIMIT $4 OFFSET $5`,[organizationId,subject,query.q,query.limit+1,query.offset])).rows.map(serialize);
      return pageResult(rows,query);
    },
    async findReadable(id,subject,organizationId) {
      const rows=(await pool.query(`SELECT ${columns} FROM records r WHERE id::text=$1 AND organization_id=$3 AND
        (owner_id=$2 OR (NOT EXISTS(SELECT 1 FROM workflow_runs w WHERE w.id=r.id) AND EXISTS(SELECT 1 FROM foundation_tasks t WHERE t.record_id=r.id AND t.organization_id=$3 AND t.assignee_id=$2 AND t.created_by=r.owner_id AND t.status<>'cancelled')))`,[id.toLowerCase(),subject,organizationId])).rows;
      return rows[0]?serialize(rows[0]):undefined;
    },
    async find(id, ownerId, organizationId) {
      const result = await pool.query(`SELECT ${columns} FROM records WHERE id::text=$1 AND owner_id=$2 AND organization_id=$3`, [id.toLowerCase(), ownerId, organizationId]);
      return result.rows[0] ? serialize(result.rows[0]) : undefined;
    },
    async create(title, ownerId, organizationId,key) {
      title=title.trim();
      return runCreateCommand(pool,{organizationId,actorId:ownerId,operation:'records.create',key},{title},async()=>{},async client=>{
        const result = await client.query(`INSERT INTO records(id, title, owner_id, organization_id) VALUES ($1, $2, $3, $4) RETURNING ${columns}`, [crypto.randomUUID(), title, ownerId, organizationId]);
        return serialize(result.rows[0]);
      });
    },
    async list(ownerId, organizationId) {
      const result = await pool.query(`SELECT ${columns} FROM records WHERE owner_id = $1 AND organization_id = $2 ORDER BY created_at DESC LIMIT 100`, [ownerId, organizationId]);
      return result.rows.map(serialize);
    },
  };
  return repository;
}
