/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type {PoolClient} from 'pg';
import {ContextLinksError} from './policy.js';
import type {Observation,ObservationState} from './types.js';
function invalid():never {throw new ContextLinksError(503,'source_invalid','Context observation source returned invalid data.');}
function timestamp(value:unknown,now:number):string {
 if(value instanceof Date) {if(!Number.isFinite(value.getTime()))invalid();value=value.toISOString();}
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value))invalid();
 const ms=Date.parse(value);const canonical=value.includes('.')?value.replace(/\.(\d+)Z$/,(_,d:string)=>`.${d.padEnd(3,'0')}Z`):value.replace('Z','.000Z');
 if(!Number.isFinite(ms)||new Date(ms).toISOString()!==canonical||ms>now+300_000)invalid();
 return canonical;
}
/** Reads only the known receiver projection; never initializes or writes receiver storage. */
export async function readProjection(db:Pick<PoolClient,'query'>,organizationId:string,externalId:string,enabled:boolean,now=Date.now()):Promise<ObservationState> {
 if(!enabled)return {status:'source_unavailable',observation:null};
 try {
  const relation=(await db.query("SELECT to_regclass('public.ngsi_ld_asset_context') AS relation")).rows[0];
  if(!relation?.relation)return {status:'source_unavailable',observation:null};
  const row=(await db.query(`SELECT organization_id AS "organizationId",entity_id AS "entityId",business_id AS "businessId",status,
   observed_at AS "observedAt",received_at AS "receivedAt" FROM public.ngsi_ld_asset_context WHERE organization_id=$1 AND entity_id=$2`,[organizationId,externalId])).rows[0];
  if(!row)return {status:'no_observation',observation:null};
  if(row.organizationId!==organizationId||row.entityId!==externalId||typeof row.businessId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(row.businessId)||externalId!==`urn:ngsi-ld:Asset:${organizationId}:${row.businessId}`||!['ready','in_use','repair','retired'].includes(row.status))invalid();
  const observedAt=timestamp(row.observedAt,now),receivedAt=timestamp(row.receivedAt,now);
  const observation:Observation={provider:'ngsi-ld',externalId,status:row.status,observedAt,receivedAt};
  return {status:now-Date.parse(observedAt)>300_000?'stale':'fresh',observation};
 }catch(error){if(error instanceof ContextLinksError)throw error;throw new ContextLinksError(503,'source_unavailable','Context observation source is unavailable.');}
}
