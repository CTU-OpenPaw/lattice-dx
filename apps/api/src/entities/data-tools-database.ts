// SPDX-License-Identifier: Apache-2.0
import type { Pool, PoolClient } from 'pg';
import { accessPredicate, checkAccess } from './access.js';
import { current, entity, entityColumns, missing, scopedEntity, updateRow } from './client.js';
import { runEntityCommandInTransaction, withEntityTransaction } from './commands.js';
import { bad, EntityError, uuid, version } from './policy.js';
import { pageResult, type PageQuery } from '../pagination.js';
import type { Entity, Scope } from './types.js';
import type { AttachmentInput, EntityDataToolsRepository } from './data-tools-types.js';
type FileRow={fileId:string;filename:string;size:number;scanStatus:string;ownerId:string;organizationId:string;recordId:string|null;content?:Buffer};
const fileColumns='id AS "fileId",filename,size,scan_status AS "scanStatus",owner_id AS "ownerId",organization_id AS "organizationId",record_id AS "recordId"';
async function lockFile(client:PoolClient,scope:Scope,id:string,bytes=false):Promise<FileRow> {
 const row=(await client.query(`SELECT ${fileColumns}${bytes?',content':''} FROM foundation_files WHERE id=$1 AND organization_id=$2 FOR SHARE`,[id,scope.organizationId])).rows[0] as FileRow|undefined;
 if(!row||row.organizationId!==scope.organizationId)throw missing();
 return row;
}
function clean(file:FileRow){if(file.scanStatus!=='clean')throw new EntityError(409,'File is not clean.');}
async function contextualEntity(client:PoolClient,scope:Scope,id:string):Promise<Entity>{
 const row=(await client.query(`SELECT ${entityColumns} FROM enterprise_entities WHERE id=$1 AND organization_id=$2 FOR SHARE`,[id,scope.organizationId])).rows[0];
 if(!row)throw missing();
 const found=entity(row);await checkAccess(client,scope,found,'read');
 if(found.archivedAt&&found.ownerId!==scope.actorId)throw missing();
 return found;
}
function boundedPage(page:PageQuery){if(!Number.isSafeInteger(page.limit)||page.limit<1||page.limit>100||!Number.isSafeInteger(page.offset)||page.offset<0||page.offset>Number.MAX_SAFE_INTEGER-101||typeof page.q!=='string'||Array.from(page.q).length>200)bad('Invalid pagination.');}
export async function entityDataToolsDatabase(pool:Pool):Promise<EntityDataToolsRepository>{
 await pool.query(`CREATE TABLE IF NOT EXISTS enterprise_entity_attachments (
  entity_id uuid NOT NULL REFERENCES enterprise_entities(id),file_id uuid NOT NULL REFERENCES foundation_files(id),
  organization_id text NOT NULL,created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(entity_id,file_id)
 );CREATE INDEX IF NOT EXISTS enterprise_entity_attachments_scope_idx ON enterprise_entity_attachments(organization_id,entity_id,created_at,file_id)`);
 async function attachmentCommand(scope:Scope,id:string,input:AttachmentInput,key:string,remove:boolean){
  id=uuid(id);input={fileId:uuid(input.fileId),expectedVersion:version(input.expectedVersion)};
  let before:Entity,file:FileRow;
  const operation=remove?'entity.attachment.unlink':'entity.attachment.link';
  return withEntityTransaction(pool,client=>runEntityCommandInTransaction(client,scope,operation,key,{id,...input},async db=>{
   const found=await scopedEntity(db,scope,id,true,'edit');if(!found)throw missing();before=found;
   if(!remove){file=await lockFile(db,scope,input.fileId);if(file.ownerId!==scope.actorId||file.recordId!==null)throw missing();clean(file);}
  },async db=>{
   current(before,input.expectedVersion);
   if(remove)await lockFile(db,scope,input.fileId);
   const changed=await db.query(remove?'DELETE FROM enterprise_entity_attachments WHERE entity_id=$1 AND file_id=$2 AND organization_id=$3 RETURNING entity_id':'INSERT INTO enterprise_entity_attachments(entity_id,file_id,organization_id,created_by) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING entity_id',[id,input.fileId,scope.organizationId,...(remove?[]:[scope.actorId])]);
   return changed.rows.length?updateRow(db,scope,before,operation,{...input,...(!remove?{scanStatus:file.scanStatus}:{})}):before;
  }));
 }
 return {
  attach:(scope,id,input,key)=>attachmentCommand(scope,id,input,key,false),
  detach:(scope,id,input,key)=>attachmentCommand(scope,id,input,key,true),
  async attachments(scope,id,page){
   id=uuid(id);boundedPage(page);
   return withEntityTransaction(pool,async client=>{
    await contextualEntity(client,scope,id);
    const rows=(await client.query(`SELECT f.id AS "fileId",f.filename,f.size,f.scan_status AS "scanStatus",a.created_by AS "createdBy",a.created_at AS "createdAt"
     FROM enterprise_entity_attachments a JOIN foundation_files f ON f.id=a.file_id JOIN enterprise_entities e ON e.id=a.entity_id
     WHERE a.entity_id=$1 AND a.organization_id=$2 AND f.organization_id=$2 AND e.organization_id=$2
     AND ${accessPredicate('e','$3','$2','read')} AND (e.archived_at IS NULL OR e.owner_id=$3)
     AND ($4='' OR strpos(lower(f.filename),lower($4))>0) ORDER BY a.created_at DESC,a.file_id DESC LIMIT $5 OFFSET $6`,[id,scope.organizationId,scope.actorId,page.q,page.limit+1,page.offset])).rows;
    return pageResult(rows.map(row=>({...row,createdAt:new Date(row.createdAt).toISOString()})),page);
   });
  },
  async attachmentContent(scope,id,fileId){
   id=uuid(id);fileId=uuid(fileId);
   return withEntityTransaction(pool,async client=>{
    await contextualEntity(client,scope,id);
    const link=(await client.query('SELECT file_id FROM enterprise_entity_attachments WHERE entity_id=$1 AND file_id=$2 AND organization_id=$3',[id,fileId,scope.organizationId])).rows[0];
    if(!link)throw missing();
    const file=await lockFile(client,scope,fileId,true);clean(file);
    return {filename:file.filename,content:file.content!};
   });
  },
 };
}
