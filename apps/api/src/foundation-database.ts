// SPDX-License-Identifier: Apache-2.0
import type { Pool } from 'pg';
import type { FoundationRepository } from './foundation.js';
import { DirectoryError } from './directory.js';
import { pageResult } from './pagination.js';
export async function foundationDatabase(pool:Pool):Promise<FoundationRepository>{
  await pool.query(`CREATE TABLE IF NOT EXISTS foundation_tasks (
    id uuid PRIMARY KEY,title text NOT NULL,organization_id text NOT NULL,assignee_id text NOT NULL,
    created_by text NOT NULL,status text NOT NULL DEFAULT 'pending',version integer NOT NULL DEFAULT 1,
    reason text,decided_by text,decided_at timestamptz,created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS foundation_tasks_scope ON foundation_tasks(organization_id,assignee_id)');
  await pool.query(`CREATE TABLE IF NOT EXISTS foundation_files (
    id uuid PRIMARY KEY,filename text NOT NULL,owner_id text NOT NULL,organization_id text NOT NULL,
    content bytea NOT NULL,size integer NOT NULL,scan_status text NOT NULL DEFAULT 'pending',created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await pool.query('ALTER TABLE foundation_tasks ADD COLUMN IF NOT EXISTS record_id uuid REFERENCES records(id)');
  await pool.query('ALTER TABLE foundation_files ADD COLUMN IF NOT EXISTS record_id uuid REFERENCES records(id)');
  await pool.query('CREATE INDEX IF NOT EXISTS foundation_tasks_record ON foundation_tasks(record_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS foundation_files_record ON foundation_files(record_id)');
  const tc=`id,title,organization_id AS "organizationId",assignee_id AS "assigneeId",created_by AS "createdBy",status,version,record_id AS "recordId",(SELECT w.id FROM workflow_waits w WHERE w.id=foundation_tasks.id AND w.kind='task') AS "workflowWaitId"`;
  const fc='id,filename,owner_id AS "ownerId",organization_id AS "organizationId",size,scan_status AS "scanStatus",record_id AS "recordId"';
  return {
    async listTasksPage(s,q) {
      const rows=(await pool.query(`SELECT ${tc} FROM foundation_tasks WHERE organization_id=$1 AND assignee_id=$2 AND ($3::text IS NULL OR status=$3) AND ($4::text IS NULL OR record_id::text=$4) AND ($5='' OR strpos(lower(title),lower($5))>0) ORDER BY created_at DESC,id DESC LIMIT $6 OFFSET $7`,[s.organizationId,s.subject,q.status??null,q.recordId??null,q.q,q.limit+1,q.offset])).rows;
      return pageResult(rows,q);
    },
    async readTask(id,s) {return (await pool.query(`SELECT ${tc} FROM foundation_tasks WHERE id::text=$1 AND organization_id=$2 AND (assignee_id=$3 OR created_by=$3)`,[id.toLowerCase(),s.organizationId,s.subject])).rows[0];},
    async readTaskFile(id,s) {
      return (await pool.query(`SELECT ${fc.split(',').map(c=>'f.'+c).join(',')},f.content FROM foundation_files f JOIN records r ON r.id=f.record_id WHERE f.id::text=$1 AND f.organization_id=$2 AND r.organization_id=$2 AND f.owner_id=r.owner_id AND NOT EXISTS(SELECT 1 FROM workflow_runs w WHERE w.id=r.id) AND EXISTS(SELECT 1 FROM foundation_tasks t WHERE t.record_id=r.id AND t.organization_id=$2 AND t.assignee_id=$3 AND t.created_by=r.owner_id)`,[id.toLowerCase(),s.organizationId,s.subject])).rows[0];
    },
    async listTasks(s){return (await pool.query(`SELECT ${tc} FROM foundation_tasks WHERE organization_id=$1 AND assignee_id=$2 ORDER BY created_at DESC LIMIT 100`,[s.organizationId,s.subject])).rows;},
    async createTask(i){const row=(await pool.query(`INSERT INTO foundation_tasks(id,title,organization_id,assignee_id,created_by,record_id) SELECT $1,$2,$3,$4,$5,$6 WHERE EXISTS(SELECT 1 FROM directory_people WHERE subject=$4 AND organization_id=$3 AND enabled=true) RETURNING ${tc}`,[crypto.randomUUID(),i.title,i.organizationId,i.assigneeId,i.createdBy,i.recordId??null])).rows[0];if(!row)throw new DirectoryError(400,'Assignee không khả dụng trong đơn vị.');return row;},
    async decideTask(id,s,decision,reason,version){
      return (await pool.query(`UPDATE foundation_tasks SET status=$1,reason=$2,decided_by=$3,decided_at=now(),version=version+1 WHERE id::text=$4 AND organization_id=$5 AND assignee_id=$3 AND version=$6 AND status='pending' AND NOT EXISTS(SELECT 1 FROM workflow_task_links l WHERE l.task_id=foundation_tasks.id) AND NOT EXISTS(SELECT 1 FROM workflow_waits w WHERE w.id=foundation_tasks.id) RETURNING ${tc}`,[decision==='approve'?'approved':'rejected',reason,s.subject,id,s.organizationId,version])).rows[0];
    },
    async createFile(i){return (await pool.query(`INSERT INTO foundation_files(id,filename,owner_id,organization_id,content,size,record_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING ${fc}`,[crypto.randomUUID(),i.filename,i.ownerId,i.organizationId,i.content,i.content.length,i.recordId??null])).rows[0];},
    async markFile(id,status){await pool.query('UPDATE foundation_files SET scan_status=$1 WHERE id=$2',[status,id]);},
    async readFile(id,s){return (await pool.query(`SELECT ${fc},content FROM foundation_files WHERE id::text=$1 AND owner_id=$2 AND organization_id=$3`,[id,s.subject,s.organizationId])).rows[0];},
  };
}
