// SPDX-License-Identifier: Apache-2.0
import type { Pool } from 'pg';
import { audit, current, entity, entityColumns, missing, publication, scopedEntity, type EntityClient } from './client.js';
import { runEntityCommandInTransaction, withEntityTransaction } from './commands.js';
import { EntityError, validateAttributes, uuid } from './policy.js';
import { digest, hash, parseMigrationInput } from './data-tools-policy.js';
import type { Entity, Scope } from './types.js';
import type { EntityDataToolsRepository, MigrationInput, MigrationDryRun } from './data-tools-types.js';
async function prepareMigration(client:EntityClient,scope:Scope,before:Entity,input:MigrationInput):Promise<MigrationDryRun>{
 current(before,input.expectedVersion);
 if(input.targetSchemaVersion<=before.schemaVersion)throw new EntityError(409,'Migration target must be a newer publication.');
 const target=await publication(client,scope,before.schemaId,input.targetSchemaVersion);
 const original=await publication(client,scope,before.schemaId,before.schemaVersion);
 const relations=(await client.query(`SELECT r.name,t.schema_id AS "targetSchemaId" FROM enterprise_relations r JOIN enterprise_entities t ON t.id=r.target_id
  WHERE r.source_id=$1 AND t.organization_id=$2`,[before.id,scope.organizationId])).rows as {name:string;targetSchemaId:string}[];
 for(const relation of relations){
  const old=Object.hasOwn(original.relations,relation.name)?original.relations[relation.name]:undefined;
  const next=Object.hasOwn(target.relations,relation.name)?target.relations[relation.name]:undefined;
  if(!old||!next||old.targetSchemaId!==next.targetSchemaId||next.targetSchemaId!==relation.targetSchemaId)throw new EntityError(409,'Stored relation is incompatible; unlink it before migration.');
 }
 let attributes:Entity['attributes'];
 try{attributes=validateAttributes(target,input.attributes);}
 catch(error){if(!(error instanceof EntityError))throw error;return {valid:false,targetSchemaVersion:input.targetSchemaVersion,expectedVersion:input.expectedVersion,errors:[error.message]};}
 return {valid:true,digest:hash({version:1,id:before.id,schemaId:before.schemaId,sourceSchemaVersion:before.schemaVersion,expectedVersion:input.expectedVersion,targetSchemaVersion:input.targetSchemaVersion,attributes}),targetSchemaVersion:input.targetSchemaVersion,expectedVersion:input.expectedVersion,errors:[]};
}
export function migrationRepository(pool:Pool):Pick<EntityDataToolsRepository,'migrationDryRun'|'migrationCommit'>{
 return {
  async migrationDryRun(scope,id,raw){
   id=uuid(id);const input=parseMigrationInput(raw);
   return withEntityTransaction(pool,async client=>{
    const before=await scopedEntity(client,scope,id,true,'owner');if(!before)throw missing();
    return prepareMigration(client,scope,before,input);
   });
  },
  async migrationCommit(scope,id,raw,key){
   id=uuid(id);const input=parseMigrationInput(raw,true),expectedDigest=digest(input.expectedDigest);let before:Entity;
   return withEntityTransaction(pool,client=>runEntityCommandInTransaction(client,scope,'entity.schema.migrate',key,{id,...input},async db=>{
    const found=await scopedEntity(db,scope,id,true,'owner');if(!found)throw missing();before=found;
   },async db=>{
    const prepared=await prepareMigration(db,scope,before,input);
    if(!prepared.valid)throw new EntityError(400,prepared.errors.join(' '));
    if(prepared.digest!==expectedDigest)throw new EntityError(409,'Migration digest mismatch.');
    const target=await publication(db,scope,before.schemaId,input.targetSchemaVersion);
    const attributes=validateAttributes(target,input.attributes);
    const row=(await db.query(`UPDATE enterprise_entities SET schema_version=$2,attributes=$3::jsonb,version=version+1,updated_at=now() WHERE id=$1 RETURNING ${entityColumns}`,[id,input.targetSchemaVersion,JSON.stringify(attributes)])).rows[0];
    const after=entity(row);
    await audit(db,scope,before,after,'entity.schema.migrate',{...input,oldSchemaVersion:before.schemaVersion,newSchemaVersion:after.schemaVersion});
    return after;
   }));
  },
 };
}
