// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import type { Pool,PoolClient } from 'pg';
import type { OutboxJob, WorkflowJobs } from './types.js';
export function workflowJobDatabase(pool: Pool): WorkflowJobs {
 async function transaction<T>(fn:(c:PoolClient)=>Promise<T>){const c=await pool.connect();try{await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
 const eligible=`((j.status='pending' AND j.available_at<=now()) OR (j.status='processing' AND j.lease_until<=now()))`;
 const waitReady=`NOT EXISTS(SELECT 1 FROM workflow_waits w WHERE w.id=j.id AND (w.status<>'pending' OR w.deadline<=clock_timestamp()))`;
 return {
  async claim(){return transaction(async c=>{
   // Dispatch and lifecycle mutations share run-first ordering. Selection skips locked runs, never locks a job first.
   const run=(await c.query(`SELECT r.id FROM workflow_runs r WHERE r.status='active' AND EXISTS(
    SELECT 1 FROM workflow_jobs j WHERE j.run_id=r.id AND ${eligible} AND ${waitReady})
    ORDER BY r.updated_at,r.id FOR UPDATE OF r SKIP LOCKED LIMIT 1`)).rows[0];
   if(!run)return;
   await c.query(`UPDATE workflow_jobs SET status='failed',lease_until=NULL,lease_token=NULL,last_error='Workflow event delivery lease expired'
    WHERE run_id=$1 AND status='processing' AND attempts>=5 AND lease_until<=now()`,[run.id]);
   const result=await c.query<OutboxJob>(`WITH candidate AS (
    SELECT j.id FROM workflow_jobs j WHERE j.run_id=$2 AND j.attempts<5 AND ${eligible}
    AND NOT EXISTS(SELECT 1 FROM workflow_waits w WHERE w.id=j.id AND NOT (w.status='pending' AND w.deadline>clock_timestamp()))
    ORDER BY j.available_at,j.created_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1
   ) UPDATE workflow_jobs job SET status='processing',attempts=job.attempts+1,lease_until=now()+interval '60 seconds',lease_token=$1
    FROM candidate WHERE job.id=candidate.id RETURNING job.id,job.run_id AS "runId",job.organization_id AS "organizationId",job.payload,job.attempts,job.lease_token AS "leaseToken"`,[randomUUID(),run.id]);
   return result.rows[0];
  });},
  async succeed(job){await transaction(async c=>{
   const run=(await c.query("SELECT id FROM workflow_runs WHERE id=$1 AND status='active' FOR UPDATE",[job.runId])).rows[0];if(!run)return;
   await c.query("UPDATE workflow_jobs SET status='succeeded',lease_until=NULL,lease_token=NULL,last_error=NULL WHERE id=$1 AND status='processing' AND lease_token=$2",[job.id,job.leaseToken]);
  });},
  async fail(job,_error){await transaction(async c=>{
   const run=(await c.query("SELECT id FROM workflow_runs WHERE id=$1 AND status='active' FOR UPDATE",[job.runId])).rows[0];if(!run)return;
   await c.query(`UPDATE workflow_jobs SET status=CASE WHEN attempts>=5 THEN 'failed' ELSE 'pending' END,
    available_at=now()+make_interval(secs=>LEAST(300,5*power(2,attempts-1))::int),lease_until=NULL,lease_token=NULL,last_error=$3
    WHERE id=$1 AND status='processing' AND lease_token=$2`,[job.id,job.leaseToken,'Workflow event delivery failed']);
  });}
 };
}
