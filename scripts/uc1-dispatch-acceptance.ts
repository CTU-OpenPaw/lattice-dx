/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {workflowJobDatabase} from '../apps/api/src/workflows/job-database.js';
import {drainOne,sendHttpEvent} from '../apps/api/src/workflows/outbox.js';
const pool=new Pool({connectionString:process.env.DATABASE_URL,max:2});
async function main(){
 const config=JSON.parse(process.env.UC1_ACCEPTANCE_INPUT!);
 const eventId=config.eventId;assert.match(eventId,/^[0-9a-f-]{36}$/);
 const before=(await pool.query('SELECT id,status,attempts,lease_token,last_error FROM workflow_jobs WHERE id<>$1 ORDER BY id',[eventId])).rows;
 const row=(await pool.query('SELECT id,status,payload FROM workflow_jobs WHERE id=$1',[eventId])).rows[0];
 assert.ok(row);assert.equal(row.payload.eventType,'asset.handed_over');
 if(row.status!=='succeeded'){
  assert.equal(row.status,'pending','Only a new pending event is dispatched by this acceptance command');
  assert.equal(await drainOne(workflowJobDatabase(pool,{eventId}),job=>sendHttpEvent(job,'http://n8n:5678/webhook/latticedx/uc1/handovers',config.token)),'success');
 }
 assert.equal((await pool.query('SELECT status FROM workflow_jobs WHERE id=$1',[eventId])).rows[0].status,'succeeded');
 assert.deepEqual((await pool.query('SELECT id,status,attempts,lease_token,last_error FROM workflow_jobs WHERE id<>$1 ORDER BY id',[eventId])).rows,before,'Unrelated backlog must remain unchanged');
 const receipts=(await pool.query('SELECT result FROM asset_handover_receipts WHERE event_id=$1',[eventId])).rows;
 assert.equal(receipts.length,1);assert.equal(receipts[0].result.sourceEventId,eventId);
 console.log(JSON.stringify({result:'Real scoped outbox dispatch via n8n and broker passed; unrelated backlog unchanged',eventId,...receipts[0].result}));
}
main().catch(()=>{console.error('Scoped UC1 dispatch failed; raw error withheld. Inspect the selected job and n8n/adapter readiness.');process.exitCode=1;}).finally(()=>pool.end());
