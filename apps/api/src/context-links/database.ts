/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type {Pool,PoolClient} from 'pg';
import {scopedEntity} from '../entities/client.js';
import {EntityError} from '../entities/policy.js';
import {runEntityCommandInTransaction,withEntityTransaction} from '../entities/commands.js';
import type {EntityRepository,Scope} from '../entities/types.js';
import {pageResult} from '../pagination.js';
import {commandKey,ContextLinksError,entityId,invalid,parseMutation} from './policy.js';
import {readProjection} from './projection.js';
import type {ContextLinksRepository,ContextMapping,MappingEvent,MappingMutation,MappingRemoval} from './types.js';
const columns=`'ngsi-ld' AS provider,entity_id AS "entityId",external_id AS "externalId",revision,updated_at AS "updatedAt"`;
function mapping(row:ContextMapping):ContextMapping {
 return {provider:'ngsi-ld',entityId:row.entityId,externalId:row.externalId,revision:row.revision,updatedAt:new Date(row.updatedAt).toISOString()};
}
/** entities denotes the configured business repository; SQL ACL helpers reauthorize using this transaction's client. */
export async function contextLinksDatabase(pool:Pool,_entities:EntityRepository,options:{projectionEnabled?:boolean}={}):Promise<ContextLinksRepository> {
 await pool.query(`CREATE TABLE IF NOT EXISTS enterprise_context_links (
  organization_id text NOT NULL,entity_id uuid NOT NULL REFERENCES enterprise_entities(id),provider text NOT NULL CHECK(provider='ngsi-ld'),
  external_id text,revision integer NOT NULL CHECK(revision>0),updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,entity_id,provider)
 );
 CREATE UNIQUE INDEX IF NOT EXISTS enterprise_context_links_active_external_idx ON enterprise_context_links(organization_id,provider,external_id) WHERE external_id IS NOT NULL;
 CREATE TABLE IF NOT EXISTS enterprise_context_link_history (
  organization_id text NOT NULL,entity_id uuid NOT NULL REFERENCES enterprise_entities(id),provider text NOT NULL CHECK(provider='ngsi-ld'),
  actor_id text NOT NULL,operation text NOT NULL CHECK(operation IN ('link','remove')),from_revision integer NOT NULL,to_revision integer NOT NULL,
  external_id text,occurred_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(organization_id,entity_id,provider,to_revision),
  CHECK(to_revision=from_revision+1)
 )`);
 async function authorize(client:PoolClient,scope:Scope,id:string,mutation=false) {
  const entity=await scopedEntity(client,scope,id,true,'read');
  if(!entity)throw new ContextLinksError(404,'not_found','Entity not found.');
  if(mutation&&entity.archivedAt)throw new ContextLinksError(409,'entity_archived','Archived entity cannot change context mappings.');
 }
 async function get(client:PoolClient,scope:Scope,id:string):Promise<ContextMapping|null> {
  const row=(await client.query(`SELECT ${columns} FROM enterprise_context_links WHERE organization_id=$1 AND entity_id=$2 AND provider='ngsi-ld'`,[scope.organizationId,id])).rows[0];
  return row?mapping(row):null;
 }
 async function mutate(scope:Scope,id:string,input:MappingMutation|MappingRemoval,key:string,remove:boolean):Promise<ContextMapping> {
  id=entityId(id);key=commandKey(key);
  const accepted=remove?parseMutation(input,scope.organizationId,true):parseMutation(input,scope.organizationId,false);
  try {
   return await withEntityTransaction(pool,client=>runEntityCommandInTransaction(client,scope,remove?'context.links.remove':'context.links.put',key,{id,...accepted},
    client=>authorize(client,scope,id,true),async client=>{
     const before=await get(client,scope,id),fromRevision=before?.revision??0;
     if(fromRevision!==accepted.expectedRevision)throw new ContextLinksError(409,'revision_conflict','Mapping revision conflict.');
     if(remove&&!before?.externalId)throw new ContextLinksError(409,'revision_conflict','No active context mapping to remove.');
     const externalId=remove?null:(accepted as MappingMutation).externalId,toRevision=fromRevision+1;
     const result=(await client.query(`INSERT INTO enterprise_context_links(organization_id,entity_id,external_id,revision,provider) VALUES($1,$2,$3,$4,'ngsi-ld')
      ON CONFLICT(organization_id,entity_id,provider) DO UPDATE SET external_id=EXCLUDED.external_id,revision=EXCLUDED.revision,updated_at=now() RETURNING ${columns}`,[scope.organizationId,id,externalId,toRevision])).rows[0];
     await client.query(`INSERT INTO enterprise_context_link_history(organization_id,entity_id,provider,actor_id,operation,from_revision,to_revision,external_id)
      VALUES($1,$2,'ngsi-ld',$3,$4,$5,$6,$7)`,[scope.organizationId,id,scope.actorId,remove?'remove':'link',fromRevision,toRevision,externalId]);
     return mapping(result);
    }));
  }catch(error){
   if(error instanceof EntityError&&error.statusCode===409)throw new ContextLinksError(409,'idempotency_conflict','Idempotency-Key was used with different input.');
   if((error as {code?:string}).code==='23505')throw new ContextLinksError(409,'external_id_conflict','External Asset is already mapped.');
   throw error;
  }
 }
 return {
  get(scope,id){id=entityId(id);return withEntityTransaction(pool,async client=>{await authorize(client,scope,id);return get(client,scope,id);});},
  put(scope,id,input,key){return mutate(scope,id,input,key,false);},
  remove(scope,id,input,key){return mutate(scope,id,input,key,true);},
  async history(scope,id,page){
   id=entityId(id);
   if(!Number.isSafeInteger(page.limit)||page.limit<1||page.limit>100||!Number.isSafeInteger(page.offset)||page.offset<0||page.offset>Number.MAX_SAFE_INTEGER-101||page.q!=='')invalid('Invalid history pagination.');
   return withEntityTransaction(pool,async client=>{
    await authorize(client,scope,id);
    const rows=(await client.query(`SELECT entity_id AS "entityId",provider,actor_id AS "actorId",operation,from_revision AS "fromRevision",to_revision AS "toRevision",external_id AS "externalId",occurred_at AS "occurredAt"
     FROM enterprise_context_link_history WHERE organization_id=$1 AND entity_id=$2 AND provider='ngsi-ld' ORDER BY to_revision DESC LIMIT $3 OFFSET $4`,[scope.organizationId,id,page.limit+1,page.offset])).rows;
    return pageResult(rows.map((row:MappingEvent)=>({...row,occurredAt:new Date(row.occurredAt).toISOString()})),page);
   });
  },
  async context(scope,id){
   id=entityId(id);
   return withEntityTransaction(pool,async client=>{
    await authorize(client,scope,id);const mapping=await get(client,scope,id);
    const state=mapping?.externalId?await readProjection(client,scope.organizationId,mapping.externalId,options.projectionEnabled===true):{status:'not_linked' as const,observation:null};
    return {version:1,entityId:id,mapping,freshnessThresholdSeconds:300,...state};
   });
  },
 };
}
