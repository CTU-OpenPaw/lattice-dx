// SPDX-License-Identifier: Apache-2.0
import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {isRecordId,type WorkflowRun,type WorkflowDefinition} from '@dx/contracts';
import type {FileItem} from '../foundation.js';
import {getDefinition,workflowDefinitions} from '../../../../solutions/workflows/definitions.js';
import {canReadRun,WorkflowError} from '../workflows/policy.js';
import {checkAccess} from '../entities/access.js';
import {EntityError} from '../entities/policy.js';
import type {ObjectStore} from './object-store.js';
export type FileAccessContext={kind:'foundation'}|{kind:'entityAttachment';entityId:string};
export type FileReadActor={subject:string;organizationId:string;roles:string[]};
export type FileDefinitionResolver=(client:PoolClient,run:WorkflowRun)=>Promise<WorkflowDefinition|undefined>;
export type FileContent={filename:string;content:Buffer};
export class FileReadError extends Error {constructor(public readonly statusCode:409|503,message:string){super(message);}}
const metadata='id,filename,owner_id AS "ownerId",organization_id AS "organizationId",record_id AS "recordId",size,scan_status AS "scanStatus"';
async function foundationAuthority(client:PoolClient,actor:FileReadActor,id:string,path:'all'|'owner'|'task'|'workflow'='all',resolveDefinition?:FileDefinitionResolver):Promise<boolean>{
 // Lock authority before the file: owner itself is immutable, while links and current tasks/runs can change.
 const owner=(await client.query('SELECT id,owner_id FROM foundation_files WHERE id=$1 AND organization_id=$2 AND owner_id=$3',[id,actor.organizationId,actor.subject])).rows[0];
 if(owner&&path!=='task'&&path!=='workflow')return true;
 if(path==='owner')return false;
 const tables=(await client.query('SELECT to_regclass($1) AS runs,to_regclass($2) AS files',['workflow_runs','workflow_files'])).rows[0];
 const hasRuns=!!tables?.runs;
 const hasFiles=!!tables?.files;
 const runs=hasRuns&&hasFiles&&path!=='task'?(await client.query(`SELECT r.id,r.owner_id AS "ownerId",r.organization_id AS "organizationId",r.definition_id AS "definitionId",r.definition_version AS "definitionVersion",r.state,r.data FROM workflow_runs r JOIN workflow_files wf ON wf.run_id=r.id WHERE wf.file_id=$1 AND r.organization_id=$2 ORDER BY r.id FOR SHARE OF r,wf`,[id,actor.organizationId])).rows as WorkflowRun[]:[];
 for(const run of runs){
  const builtin=workflowDefinitions.some(d=>d.id===run.definitionId);
  const definition=resolveDefinition?await resolveDefinition(client,run):builtin?getDefinition(run.definitionId,run.definitionVersion):(await client.query('SELECT definition FROM workflow_definition_versions WHERE organization_id=$1 AND id=$2 AND version=$3',[actor.organizationId,run.definitionId,run.definitionVersion])).rows[0]?.definition;
  if(!definition)throw new WorkflowError(503,'Phiên bản quy trình không khả dụng.');
  if(canReadRun(definition,run,actor))return true;
 }
 if(path==='workflow')return false;
 const workflowGuard=hasRuns?'NOT EXISTS(SELECT 1 FROM workflow_runs w WHERE w.id=r.id)':'TRUE';
 const task=(await client.query(`SELECT r.id,t.id AS task_id FROM records r JOIN foundation_tasks t ON t.record_id=r.id JOIN foundation_files f ON f.record_id=r.id WHERE f.id=$1 AND f.organization_id=$2 AND r.organization_id=$2 AND f.owner_id=r.owner_id AND ${workflowGuard} AND t.organization_id=$2 AND t.assignee_id=$3 AND t.created_by=r.owner_id AND t.status<>'cancelled' ORDER BY t.id FOR SHARE OF r,t`,[id,actor.organizationId,actor.subject])).rows[0];
 return !!task;
}
async function authorized(client:PoolClient,actor:FileReadActor,id:string,context:FileAccessContext,resolveDefinition?:FileDefinitionResolver):Promise<boolean>{
 if(!isRecordId(id))return false;
 if(context.kind==='foundation')return foundationAuthority(client,actor,id,'all',resolveDefinition);
 if(context.kind!=='entityAttachment'||!isRecordId(context.entityId)||!actor.roles.includes('files:read')||!actor.roles.includes('data:read'))return false;
 const scope={actorId:actor.subject,organizationId:actor.organizationId};
 const found=(await client.query('SELECT id,owner_id AS "ownerId",organization_id AS "organizationId",archived_at AS "archivedAt" FROM enterprise_entities WHERE id=$1 AND organization_id=$2 FOR SHARE',[context.entityId,actor.organizationId])).rows[0];
 if(!found)return false;
 try{await checkAccess(client,scope,found,'read');}catch(error){if(error instanceof EntityError&&error.statusCode===404)return false;throw error;}
 if(found.archivedAt&&found.ownerId!==actor.subject)return false;
 return !!(await client.query('SELECT file_id FROM enterprise_entity_attachments WHERE entity_id=$1 AND file_id=$2 AND organization_id=$3 FOR SHARE',[context.entityId,id,actor.organizationId])).rows[0];
}
async function lockedMetadata(client:PoolClient,actor:FileReadActor,id:string,context:FileAccessContext,resolveDefinition?:FileDefinitionResolver){
 if(!await authorized(client,actor,id,context,resolveDefinition))return;
 return (await client.query(`SELECT ${metadata} FROM foundation_files WHERE id=$1 AND organization_id=$2 FOR SHARE`,[id,actor.organizationId])).rows[0] as FileItem|undefined;
}
export async function readFileMetadataWithClient(client:PoolClient,actor:FileReadActor,fileId:string,context:FileAccessContext,resolveDefinition?:FileDefinitionResolver):Promise<FileItem|undefined>{return lockedMetadata(client,actor,fileId,context,resolveDefinition);}
export async function loadFileContentWithClient(client:PoolClient,actor:FileReadActor,fileId:string,context:FileAccessContext,store:ObjectStore|undefined,resolveDefinition?:FileDefinitionResolver):Promise<FileContent|undefined>{
 const file=await lockedMetadata(client,actor,fileId,context,resolveDefinition);if(!file)return;
 if(file.scanStatus!=='clean')throw new FileReadError(409,'Tệp chưa được phép sử dụng.');
 try{
  const pointer=(await client.query('SELECT storage_provider,object_key,content_sha256 FROM foundation_files WHERE id=$1',[fileId])).rows[0];
  let content:Buffer;
  if(pointer.storage_provider==='filesystem'){
   if(!store)throw Error();
   content=await store.readVerified({provider:'filesystem',objectKey:pointer.object_key,sha256:pointer.content_sha256,size:file.size});
   if(!Buffer.isBuffer(content)||content.length!==file.size||createHash('sha256').update(content).digest('hex')!==pointer.content_sha256)throw Error();
  }else if(pointer.storage_provider==='postgres')content=(await client.query('SELECT content FROM foundation_files WHERE id=$1',[fileId])).rows[0]?.content;
  else throw Error();
  if(!Buffer.isBuffer(content)||content.length!==file.size||content.length>1048576)throw Error();
  return {filename:file.filename,content};
 }catch{throw new FileReadError(503,'file_storage_unavailable');}
}

// Narrow legacy repository contexts retain their original authority boundaries.
export async function readFoundationPathMetadataWithClient(client:PoolClient,actor:FileReadActor,id:string,path:'owner'|'task'|'workflow',resolveDefinition?:FileDefinitionResolver):Promise<FileItem|undefined>{
 if(!isRecordId(id)||!await foundationAuthority(client,actor,id,path,resolveDefinition))return;
 return (await client.query(`SELECT ${metadata} FROM foundation_files WHERE id=$1 AND organization_id=$2 FOR SHARE`,[id,actor.organizationId])).rows[0];
}
