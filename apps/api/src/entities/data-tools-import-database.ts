/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Pool } from 'pg';
import { accessPredicate } from './access.js';
import { createEntityAtPublication, entity, entityColumns, missing, publication, scopedEntity } from './client.js';
import { runEntityCommandInTransaction, withEntityTransaction } from './commands.js';
import { compileEntityQuery, parseEntityQuery } from './query.js';
import { bad, EntityError, exact } from './policy.js';
import { digest, exportContent, format, parseImportInput, prepareImport } from './data-tools-policy.js';
import { pageResult } from '../pagination.js';
import type { EntityDataToolsRepository, ImportPreparation } from './data-tools-types.js';
export function importExportRepository(pool:Pool):Pick<EntityDataToolsRepository,'importDryRun'|'importCommit'|'export'>{
 return {
  async importDryRun(scope,input){
   input=parseImportInput(input);
   const schema=await publication(pool,scope,input.schemaId,input.schemaVersion);
   const {rows,...result}=prepareImport(schema,input);return result;
  },
  async importCommit(scope,raw,key){
   const input=parseImportInput(raw,true),expectedDigest=digest(input.expectedDigest);
   let prepared:ImportPreparation;
   return withEntityTransaction(pool,client=>runEntityCommandInTransaction(client,scope,'entity.import',key,input,async db=>{
    const schema=await publication(db,scope,input.schemaId,input.schemaVersion);
    prepared=prepareImport(schema,{schemaId:input.schemaId,schemaVersion:input.schemaVersion,format:input.format,content:input.content});
    if(!prepared.valid)bad(prepared.errors.map(error=>`Row ${error.row}: ${error.error}`).join(' '));
    if(prepared.digest!==expectedDigest)throw new EntityError(409,'Import digest mismatch.');
   },async db=>{
    const entityIds:string[]=[];
    for(const row of prepared.rows){const created=await createEntityAtPublication(db,scope,{...row,schemaId:input.schemaId,schemaVersion:input.schemaVersion});entityIds.push(created.id);}
    return {schemaId:input.schemaId,schemaVersion:input.schemaVersion,entityIds};
   },async(db,accepted)=>{
    for(const id of [...accepted.entityIds].sort())if(!await scopedEntity(db,scope,id,true,'read'))throw missing();
   }));
  },
  async export(scope,raw){
   const body=exact(raw,['query','format']),output=format(body.format);
   const queryBody=exact(body.query,['schemaId','schemaVersion','filters','sort','limit','offset']);
   if(queryBody.limit===undefined)bad('Export query requires a limit at most 100.');
   const query=parseEntityQuery(queryBody);
   const schema=await publication(pool,scope,query.schemaId,query.schemaVersion);
   const compiled=compileEntityQuery(query,schema,5);
   const values=[scope.organizationId,scope.actorId,query.schemaId,query.schemaVersion,...compiled.values,query.limit+1,query.offset];
   const result=await pool.query(`SELECT ${entityColumns} FROM enterprise_entities WHERE ${accessPredicate('enterprise_entities','$2','$1','read')}
    AND archived_at IS NULL AND schema_id=$3 AND schema_version=$4 AND ${compiled.predicate} ORDER BY ${compiled.order} LIMIT $${values.length-1} OFFSET $${values.length}`,values);
   const page=pageResult(result.rows.map(entity),{limit:query.limit,offset:query.offset,q:''});
   return {format:output,content:exportContent(schema,page.items.map(row=>({title:row.title,attributes:row.attributes})),output),page:page.page};
  },
 };
}
