/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { accessPredicate, checkAccess, type AccessMode } from './access.js';
import { title, uuid, version, validateAttributes, EntityError, bad } from './policy.js';
import type { Entity, EntityCreate, EntityUpdate, RelationInput, SchemaPublication, Scope } from './types.js';
import {compileEntityQuery,parseEntityQuery} from './query.js';
import {pageResult} from '../pagination.js';
import {appendEntityEventWithClient,isEntityEventOperation} from './events.js';
export type EntityClient = Pick<PoolClient,'query'>;
type Queryable = EntityClient;
export const entityColumns=`id, schema_id AS "schemaId", schema_version AS "schemaVersion", title, attributes,
  owner_id AS "ownerId", organization_id AS "organizationId", version, archived_at AS "archivedAt",
  created_at AS "createdAt", updated_at AS "updatedAt"`;
export function entity(row:Entity):Entity {
  return {...row,createdAt:new Date(row.createdAt).toISOString(),updatedAt:new Date(row.updatedAt).toISOString(),archivedAt:row.archivedAt?new Date(row.archivedAt).toISOString():null};
}
export const missing=()=>new EntityError(404,'Entity or schema not found.');
export function current(row:Entity,expected:number) {
  if(row.archivedAt) throw new EntityError(409,'Archived entity cannot mutate.');
  if(row.version!==expected) throw new EntityError(409,'Entity version conflict.');
}
export async function scopedEntity(db:Queryable,scope:Scope,id:string,lock=false,mode:AccessMode='read'):Promise<Entity|undefined> {
  const predicate=lock?'organization_id=$2':accessPredicate('enterprise_entities','$2','$3',mode);
  const row=(await db.query(`SELECT ${entityColumns} FROM enterprise_entities WHERE id=$1 AND ${predicate}${lock?' FOR UPDATE':''}`,(lock?[id,scope.organizationId]:[id,scope.actorId,scope.organizationId]))).rows[0];
  if(!row) return undefined;
  const found=entity(row);
  if(lock) await checkAccess(db,scope,found,mode);
  return found;
}
export async function publication(db:Queryable,scope:Scope,id:string,pinned?:number):Promise<SchemaPublication> {
  const result=await db.query(`SELECT definition,version FROM enterprise_schema_versions WHERE organization_id=$1 AND schema_id=$2 ${pinned===undefined?'ORDER BY version DESC LIMIT 1':'AND version=$3'}`,
    pinned===undefined?[scope.organizationId,id]:[scope.organizationId,id,pinned]);
  const row=result.rows[0];
  if(!row) throw missing();
  return {...row.definition,version:row.version};
}
export async function audit(db:Queryable,scope:Scope,before:Entity|undefined,after:Entity,operation:string,input:unknown) {
  await db.query(`INSERT INTO enterprise_audit(id,organization_id,owner_id,entity_id,actor_id,operation,from_version,to_version,input,result)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)`,
    [randomUUID(),scope.organizationId,after.ownerId,after.id,scope.actorId,operation,before?.version??0,after.version,JSON.stringify(input),JSON.stringify(after)]);
  if(isEntityEventOperation(operation)) await appendEntityEventWithClient(db,scope,{operation,entityId:after.id,schemaId:after.schemaId,schemaVersion:after.schemaVersion,fromVersion:before?.version??0,toVersion:after.version});
}
export async function updateRow(db:Queryable,scope:Scope,before:Entity,operation:string,input:unknown,changes?:{title:string;attributes:Entity['attributes']},archive=false):Promise<Entity> {
  const row=(await db.query(`UPDATE enterprise_entities SET title=$2,attributes=$3::jsonb,version=version+1,updated_at=now(),archived_at=CASE WHEN $4 THEN now() ELSE archived_at END WHERE id=$1 RETURNING ${entityColumns}`,
    [before.id,changes?.title??before.title,JSON.stringify(changes?.attributes??before.attributes),archive])).rows[0];
  const result=entity(row);
  await audit(db,scope,before,result,operation,input);
  return result;
}

export async function createEntityAtPublication(client:EntityClient,scope:Scope,input:EntityCreate & {schemaVersion:number}):Promise<Entity> {
  const schema=await publication(client,scope,input.schemaId,version(input.schemaVersion));
  await checkAccess(client,scope,{organizationId:scope.organizationId,ownerId:scope.actorId,schemaId:input.schemaId},'owner');
  const normalized={...input,title:title(input.title),attributes:validateAttributes(schema,input.attributes)};
  const row=(await client.query(`INSERT INTO enterprise_entities(id,organization_id,owner_id,schema_id,schema_version,title,attributes) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING ${entityColumns}`,
    [randomUUID(),scope.organizationId,scope.actorId,input.schemaId,schema.version,normalized.title,JSON.stringify(normalized.attributes)])).rows[0];
  const created=entity(row);
  const {schemaVersion:acceptedPin,...auditInput}=normalized;
  await audit(client,scope,undefined,created,'entity.create',auditInput);
  return created;
}
export async function lockEntities(client:EntityClient,scope:Scope,ids:string[]):Promise<Map<string,Entity>> {
  const locked=new Map<string,Entity>();
  for(const id of [...new Set(ids.map(uuid))].sort()) {
    const row=(await client.query(`SELECT ${entityColumns} FROM enterprise_entities WHERE id=$1 AND organization_id=$2 FOR UPDATE`,[id,scope.organizationId])).rows[0];
    if(!row) throw missing();
    locked.set(id,entity(row));
  }
  return locked;
}
/** Apply to rows already locked by the caller; recheck shared authority and typed policy. */
export async function applyEntityUpdateWithClient(client:EntityClient,scope:Scope,before:Entity,input:EntityUpdate):Promise<Entity> {
  await checkAccess(client,scope,before,'edit');
  current(before,version(input.expectedVersion));
  const normalized={...input,title:title(input.title)};
  const schema=await publication(client,scope,before.schemaId,before.schemaVersion);
  return updateRow(client,scope,before,'entity.update',normalized,{title:normalized.title,attributes:validateAttributes(schema,input.attributes)});
}
export async function updateEntityWithClient(client:EntityClient,scope:Scope,id:string,input:EntityUpdate):Promise<Entity> {
  const before=await scopedEntity(client,scope,uuid(id),true,'edit');
  if(!before) throw missing();
  return applyEntityUpdateWithClient(client,scope,before,input);
}
export async function applyEntityArchiveWithClient(client:EntityClient,scope:Scope,before:Entity,expectedVersion:number):Promise<Entity> {
  await checkAccess(client,scope,before,'owner');
  current(before,version(expectedVersion));
  return updateRow(client,scope,before,'entity.archive',{expectedVersion},undefined,true);
}
export async function archiveEntityWithClient(client:EntityClient,scope:Scope,id:string,expectedVersion:number):Promise<Entity> {
  const before=await scopedEntity(client,scope,uuid(id),true,'owner');
  if(!before) throw missing();
  return applyEntityArchiveWithClient(client,scope,before,expectedVersion);
}
export async function applyEntityRelationWithClient(client:EntityClient,scope:Scope,source:Entity,target:Entity,input:RelationInput,remove:boolean):Promise<Entity> {
  await checkAccess(client,scope,source,'edit');
  await checkAccess(client,scope,target,'read');
  current(source,version(input.expectedVersion));
  if(!remove&&target.archivedAt) throw new EntityError(409,'Archived target cannot link.');
  const schema=await publication(client,scope,source.schemaId,source.schemaVersion);
  const declaration=Object.hasOwn(schema.relations,input.name)?schema.relations[input.name]:undefined;
  if(!declaration||declaration.targetSchemaId!==target.schemaId) bad('Undeclared relation or wrong target schema.');
  if(uuid(input.targetId)!==target.id) bad('Relation target mismatch.');
  const changed=await client.query(remove
    ?'DELETE FROM enterprise_relations WHERE source_id=$1 AND name=$2 AND target_id=$3 RETURNING source_id'
    :'INSERT INTO enterprise_relations(source_id,name,target_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING source_id',
    [source.id,input.name,input.targetId]);
  return changed.rows.length?updateRow(client,scope,source,remove?'entity.unlink':'entity.link',input):source;
}
export async function linkEntityWithClient(client:EntityClient,scope:Scope,id:string,input:RelationInput,remove=false):Promise<Entity> {
  id=uuid(id);
  input={...input,targetId:uuid(input.targetId),expectedVersion:version(input.expectedVersion)};
  const rows=await lockEntities(client,scope,[id,input.targetId]);
  return applyEntityRelationWithClient(client,scope,rows.get(id)!,rows.get(input.targetId)!,input,remove);
}
export function unlinkEntityWithClient(client:EntityClient,scope:Scope,id:string,input:RelationInput) {
  return linkEntityWithClient(client,scope,id,input,true);
}
/** ACL is part of the predicate before pagination; uses only the supplied connection. */
export async function queryEntitiesWithClient(client:EntityClient,scope:Scope,input:import('./types.js').EntityQuery) {
  const query=parseEntityQuery(input),schema=await publication(client,scope,query.schemaId,query.schemaVersion);
  const compiled=compileEntityQuery(query,schema,5);
  const values=[scope.organizationId,scope.actorId,query.schemaId,query.schemaVersion,...compiled.values,query.limit+1,query.offset];
  const rows=(await client.query(`SELECT ${entityColumns} FROM enterprise_entities WHERE ${accessPredicate('enterprise_entities','$2','$1','read')} AND archived_at IS NULL AND schema_id=$3 AND schema_version=$4 AND ${compiled.predicate} ORDER BY ${compiled.order} LIMIT $${values.length-1} OFFSET $${values.length}`,values)).rows;
  return pageResult(rows.map(entity),{limit:query.limit,offset:query.offset,q:''});
}
