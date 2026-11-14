/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {handoverDatabase} from '../apps/api/src/ngsi-ld/handover-database.js';
import type {HandoverEvent} from '../apps/api/src/ngsi-ld/handover.js';
import {workflowJobDatabase} from '../apps/api/src/workflows/job-database.js';
const admin=new Pool({connectionString:process.env.DATABASE_URL}),schema='uc1_accept_'+randomUUID().replaceAll('-','');
let pool:Pool|undefined;
async function main(){
 await admin.query(`CREATE SCHEMA ${schema}`);
 pool=new Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`,max:5});
 await pool.query("CREATE TABLE workflow_runs(id uuid PRIMARY KEY,status text NOT NULL DEFAULT 'active',updated_at timestamptz DEFAULT now(),organization_id text)");
 await pool.query('CREATE TABLE workflow_waits(id uuid,status text,deadline timestamptz)');
 await pool.query("CREATE TABLE workflow_jobs(id uuid PRIMARY KEY,run_id uuid,organization_id text,payload jsonb,status text,created_at timestamptz DEFAULT now(),attempts int DEFAULT 0,available_at timestamptz DEFAULT now(),lease_until timestamptz,lease_token uuid,last_error text)");
 let deliver=await handoverDatabase(pool),calls=0;
 const id=randomUUID(),event:HandoverEvent={eventId:id,eventType:'asset.handed_over',runId:id,recordId:id,organizationId:'org-a',definitionId:'procurement',version:6,occurredAt:'2026-10-20T12:00:00.123Z',data:{assetId:'urn:ngsi-ld:Asset:org-a:'+randomUUID(),departmentId:'warehouse',locationId:'office-1'}};
 async function source(e:HandoverEvent){await pool!.query('INSERT INTO workflow_runs(id,organization_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[e.runId,e.organizationId]);await pool!.query("INSERT INTO workflow_jobs(id,run_id,organization_id,payload,status) VALUES($1,$2,$3,$4,'pending')",[e.eventId,e.runId,e.organizationId,JSON.stringify(e)]);}
 const synchronize=async(e:HandoverEvent)=>{calls++;await new Promise(r=>setTimeout(r,30));return {assetId:e.data.assetId,status:'in_use',sourceEventId:e.eventId};};
 await source(event);
 const results=await Promise.all(Array.from({length:4},()=>deliver(event,synchronize)));
 assert.equal(calls,1);assert.ok(results.every(r=>r.sourceEventId===event.eventId));
 await assert.rejects(deliver({...event,data:{...event.data,locationId:'other'}},synchronize),{code:'handover_source_conflict'});
 const older={...event,eventId:randomUUID(),occurredAt:'2026-10-19T12:00:00.000Z'};await source(older);
 await assert.rejects(deliver(older,synchronize),{code:'handover_order_conflict'});
 const failed={...event,eventId:randomUUID(),data:{...event.data,assetId:'urn:ngsi-ld:Asset:org-a:'+randomUUID()}};await source(failed);
 await assert.rejects(deliver(failed,async()=>{throw Error('simulated broker outage');}));
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM asset_handover_receipts WHERE event_id=$1',[failed.eventId])).rows[0].n,0);
 await deliver(failed,synchronize);
 await pool.end();pool=new Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`});deliver=await handoverDatabase(pool);
 const before=calls;await deliver(event,synchronize);assert.equal(calls,before);
 await pool.query("UPDATE workflow_jobs SET status='cancelled' WHERE id=$1",[event.eventId]);
 await deliver(event,synchronize);assert.equal(calls,before,'A committed receipt remains replayable after source cancellation');
 const cancelled={...event,eventId:randomUUID(),data:{...event.data,assetId:'urn:ngsi-ld:Asset:org-a:'+randomUUID()}};await source(cancelled);
 await pool.query("UPDATE workflow_jobs SET status='cancelled' WHERE id=$1",[cancelled.eventId]);
 await assert.rejects(deliver(cancelled,synchronize),{code:'handover_source_conflict'});
 await pool.query("UPDATE workflow_jobs SET created_at='2020-01-01T00:00:00Z'");
 const fresh={...event,eventId:randomUUID(),runId:randomUUID()};fresh.recordId=fresh.runId;await source(fresh);
 const other={...fresh,eventId:randomUUID(),eventType:'employee.onboarded'};await source(other);
 const foreign={...fresh,eventId:randomUUID(),runId:randomUUID(),organizationId:'org-b'};foreign.recordId=foreign.runId;await source(foreign);
 const jobs=workflowJobDatabase(pool,{eventType:'asset.handed_over',createdAfter:'2026-01-01T00:00:00.000Z',organizationId:'org-a'}),claimed=await jobs.claim();
 assert.equal(claimed!.id,fresh.eventId);await jobs.succeed(claimed!);assert.equal(await jobs.claim(),undefined);
 assert.equal((await pool.query('SELECT attempts FROM workflow_jobs WHERE id=$1',[other.eventId])).rows[0].attempts,0);
 assert.equal((await pool.query('SELECT attempts FROM workflow_jobs WHERE id=$1',[foreign.eventId])).rows[0].attempts,0);
 const inflight={...event,eventId:randomUUID(),runId:randomUUID(),data:{...event.data,assetId:'urn:ngsi-ld:Asset:org-a:'+randomUUID()}};inflight.recordId=inflight.runId;await source(inflight);
 let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
 const delivery=deliver(inflight,async e=>{entered();await gate;return synchronize(e);});await started;
 let cancellationFinished=false;const cancellation=pool.query("UPDATE workflow_runs SET status='cancelled' WHERE id=$1",[inflight.runId]).then(()=>{cancellationFinished=true;});
 try{await new Promise(r=>setTimeout(r,30));assert.equal(cancellationFinished,false,'Cancellation must wait for an accepted delivery');}finally{release();await Promise.all([delivery,cancellation]);}
 await deliver(inflight,synchronize);
 console.log('UC1 real PostgreSQL passed: duplicate concurrency, canonical source binding, ordering, rollback/retry, reconnect receipts, cancellation serialization and event/type/org/cutoff selection. Isolated schema only; broker simulated.');
}
main().catch(()=>{console.error('UC1 database acceptance failed');process.exitCode=1;}).finally(async()=>{await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();});
