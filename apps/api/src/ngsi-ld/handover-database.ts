/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type {Pool} from 'pg';
import {canonical} from '../events/policy.js';
import {HandoverError,type HandoverEvent,type HandoverResult} from './handover.js';

export async function handoverDatabase(pool:Pool){
 await pool.query(`CREATE TABLE IF NOT EXISTS asset_handover_receipts (
  organization_id text NOT NULL,event_id uuid NOT NULL,asset_id text NOT NULL,
  occurred_at timestamptz NOT NULL,payload jsonb NOT NULL,result jsonb NOT NULL,
  synchronized_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(organization_id,event_id)
 )`);
 await pool.query('CREATE INDEX IF NOT EXISTS asset_handover_latest ON asset_handover_receipts(organization_id,asset_id,occurred_at DESC)');
 return async(event:HandoverEvent,synchronize:(event:HandoverEvent)=>Promise<HandoverResult>)=>{
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   await client.query("SET LOCAL lock_timeout='1500ms'");
   await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['asset-handover',event.organizationId,event.data.assetId])]);
   // A shared integration credential cannot invent, edit or cross-route a backend event.
   const original=(await client.query('SELECT payload,status FROM workflow_jobs WHERE id=$1 AND organization_id=$2 AND run_id=$3',[event.eventId,event.organizationId,event.runId])).rows[0];
   if(!original||canonical(original.payload)!==canonical(event))throw new HandoverError(409,'handover_source_conflict');
   const receipt=(await client.query('SELECT payload,result FROM asset_handover_receipts WHERE organization_id=$1 AND event_id=$2',[event.organizationId,event.eventId])).rows[0];
   if(receipt){if(canonical(receipt.payload)!==canonical(event))throw new HandoverError(409,'handover_content_conflict');await client.query('COMMIT');return receipt.result as HandoverResult;}
   // Serialize new delivery against workflow cancellation; historical receipts remain replayable.
   const run=(await client.query('SELECT status FROM workflow_runs WHERE id=$1 AND organization_id=$2 FOR SHARE',[event.runId,event.organizationId])).rows[0];
   if(original.status==='cancelled'||run?.status!=='active')throw new HandoverError(409,'handover_source_conflict');
   const latest=(await client.query('SELECT occurred_at FROM asset_handover_receipts WHERE organization_id=$1 AND asset_id=$2 ORDER BY occurred_at DESC LIMIT 1',[event.organizationId,event.data.assetId])).rows[0];
   if(latest&&new Date(latest.occurred_at).getTime()>=Date.parse(event.occurredAt))throw new HandoverError(409,'handover_order_conflict');
   const result=await synchronize(event);
   await client.query('INSERT INTO asset_handover_receipts(organization_id,event_id,asset_id,occurred_at,payload,result) VALUES($1,$2,$3,$4,$5,$6)',[event.organizationId,event.eventId,event.data.assetId,event.occurredAt,JSON.stringify(event),JSON.stringify(result)]);
   await client.query('COMMIT');return result;
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 };
}
