/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { randomUUID } from 'node:crypto';
import type { Pool,PoolClient } from 'pg';
import type { OutboxJob, WorkflowJobs } from './types.js';
export function workflowJobDatabase(pool: Pool,options:{eventId?:string;eventType?:string;createdAfter?:string;organizationId?:string}={}): WorkflowJobs {
 if(options.eventId&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.eventId))throw Error('Invalid scoped outbox event ID');
 const eventId=options.eventId??null;
 const eventType=options.eventType??null,createdAfter=options.createdAfter??null;
 const organizationId=options.organizationId??null;
 if((eventType===null)!==(organizationId===null)||organizationId&&!/^[A-Za-z0-9_-]{1,128}$/.test(organizationId))throw Error('Invalid outbox organization scope');
 if((eventType===null)!==(createdAfter===null)||eventType&&(!/^[a-z][a-z0-9_.-]{0,127}$/.test(eventType)||!Number.isFinite(Date.parse(createdAfter!))||new Date(createdAfter!).toISOString()!==createdAfter))throw Error('Invalid scoped outbox selection');
 async function transaction<T>(fn:(c:PoolClient)=>Promise<T>){const c=await pool.connect();try{await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
 const eligible=`((j.status='pending' AND j.available_at<=now()) OR (j.status='processing' AND j.lease_until<=now()))`;
 const waitReady=`NOT EXISTS(SELECT 1 FROM workflow_waits w WHERE w.id=j.id AND (w.status<>'pending' OR w.deadline<=clock_timestamp()))`;
 return {
  async claim(){return transaction(async c=>{
   // Dispatch and lifecycle mutations share run-first ordering. Selection skips locked runs, never locks a job first.
   const run=(await c.query(`SELECT r.id FROM workflow_runs r WHERE r.status='active' AND EXISTS(
    SELECT 1 FROM workflow_jobs j WHERE j.run_id=r.id AND ($1::uuid IS NULL OR j.id=$1) AND ($2::text IS NULL OR j.payload->>'eventType'=$2) AND ($3::timestamptz IS NULL OR j.created_at>=$3) AND ($4::text IS NULL OR j.organization_id=$4) AND ${eligible} AND ${waitReady})
    ORDER BY r.updated_at,r.id FOR UPDATE OF r SKIP LOCKED LIMIT 1`,[eventId,eventType,createdAfter,organizationId])).rows[0];
   if(!run)return;
   await c.query(`UPDATE workflow_jobs SET status='failed',lease_until=NULL,lease_token=NULL,last_error='Workflow event delivery lease expired'
    WHERE run_id=$1 AND ($2::uuid IS NULL OR id=$2) AND ($3::text IS NULL OR payload->>'eventType'=$3) AND ($4::timestamptz IS NULL OR created_at>=$4) AND ($5::text IS NULL OR organization_id=$5) AND status='processing' AND attempts>=5 AND lease_until<=now()`,[run.id,eventId,eventType,createdAfter,organizationId]);
   const result=await c.query<OutboxJob>(`WITH candidate AS (
    SELECT j.id FROM workflow_jobs j WHERE j.run_id=$2 AND ($3::uuid IS NULL OR j.id=$3) AND ($4::text IS NULL OR j.payload->>'eventType'=$4) AND ($5::timestamptz IS NULL OR j.created_at>=$5) AND ($6::text IS NULL OR j.organization_id=$6) AND j.attempts<5 AND ${eligible}
    AND NOT EXISTS(SELECT 1 FROM workflow_waits w WHERE w.id=j.id AND NOT (w.status='pending' AND w.deadline>clock_timestamp()))
    ORDER BY j.available_at,j.created_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1
   ) UPDATE workflow_jobs job SET status='processing',attempts=job.attempts+1,lease_until=now()+interval '60 seconds',lease_token=$1
    FROM candidate WHERE job.id=candidate.id RETURNING job.id,job.run_id AS "runId",job.organization_id AS "organizationId",job.payload,job.attempts,job.lease_token AS "leaseToken"`,[randomUUID(),run.id,eventId,eventType,createdAfter,organizationId]);
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
