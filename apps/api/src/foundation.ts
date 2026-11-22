/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { CreateCommandError,parseCreateKey,requireCreateCapability } from './create-command.js';
import type { FastifyInstance } from 'fastify';
import { verifyIdentity, type IdentityConfig } from './identity.js';
import type { RecordRepository } from './records.js';
import { resolveRecordLink, RecordLinkError } from './record-link.js';
import type { WorkflowActor } from '@dx/contracts';
import { isRecordId,parseTaskCreateInput } from '@dx/contracts';
import { PageError,parsePage,textFilter,type Page,type PageQuery } from './pagination.js';
export type TaskQuery=PageQuery & {status?:string;recordId?:string};
import { requireAssignee, DirectoryError, type DirectoryOptions } from './directory.js';
import {FileReadError,type FileContent} from './files/content.js';
export type Scope = {subject:string; organizationId:string};
export type TaskInput = {title:string;assigneeId:string;organizationId:string;createdBy:string;recordId?:string};
export type Task = Omit<TaskInput,'recordId'> & {id:string;status:string;version:number;recordId?:string|null;workflowWaitId?:string|null;departmentId?:string|null;dueAt?:string|null};
export type ScanStatus = 'pending'|'clean'|'rejected'|'error';
export type FileInput = {filename:string;ownerId:string;organizationId:string;content:Buffer;recordId?:string};
export type FileItem = Omit<FileInput,'content'|'recordId'> & {id:string;size:number;scanStatus:ScanStatus;recordId?:string|null};
export interface FoundationRepository {
  readFileMetadata?(id:string,scope:WorkflowActor):Promise<FileItem|undefined>;
  loadFileContent?(id:string,scope:WorkflowActor):Promise<FileContent|undefined>;
  supportsCreateCommands?:boolean;
  listTasks(scope:Scope):Promise<Task[]>;
  listTasksPage?(scope:Scope,query:TaskQuery):Promise<Page<Task>>;
  readTask?(id:string,scope:Scope):Promise<Task|undefined>;
  readTaskFile?(id:string,scope:Scope):Promise<(FileItem&{content?:Buffer})|undefined>;
  createTask(input:TaskInput,key?:string):Promise<Task>;
  decideTask(id:string,scope:Scope,decision:'approve'|'reject',reason:string,version:number):Promise<Task|undefined>;
  createFile(input:FileInput):Promise<FileItem>;
  markFile(id:string,status:ScanStatus):Promise<void>;
  readFile(id:string,scope:Scope):Promise<(FileItem & {content?:Buffer})|undefined>;
}
export type FoundationOptions = DirectoryOptions & {identity?:IdentityConfig; records?:RecordRepository; foundation?:FoundationRepository;readSharedFile?:(id:string,actor:WorkflowActor)=>Promise<(FileItem&{content?:Buffer})|undefined>;scan?:(content:Buffer)=>Promise<'clean'|'rejected'>};
export function registerFoundation(app:FastifyInstance,options:FoundationOptions){
  // This authorization applies before accessing every task/file repository method.
  app.register(async routes=>{
    routes.setErrorHandler((error, _req, reply) => {
      if (error instanceof FileReadError || error instanceof RecordLinkError || error instanceof DirectoryError || error instanceof PageError || error instanceof CreateCommandError) return reply.code(error.statusCode).send({error: error.message});
      return reply.send(error);
    });
    routes.addHook('preHandler',async(req,reply)=>{
      if(!options.identity||!options.foundation) return reply.code(503).send({error:'Foundation chưa được cấu hình.'});
      let user;
      try{user=await verifyIdentity(req.headers.authorization,options.identity);}catch{return reply.code(401).send({error:'Token không hợp lệ.'});}
      if(!user.organizationId)return reply.code(403).send({error:'Token thiếu phạm vi đơn vị.'});
      const role=req.url.split('?')[0].startsWith('/v1/files')?(req.method==='POST'?'files:write':'files:read'):
        req.method==='GET'?'tasks:read':req.url.split('?')[0].endsWith('/decisions')?'tasks:decide':'tasks:assign';
      if(!user.roles.includes(role))return reply.code(403).send({error:'Không có quyền thực hiện tác vụ.'});
      scopes.set(req,{subject:user.subject,organizationId:user.organizationId,roles:user.roles});
    });
    const scopes=new WeakMap<object,WorkflowActor>();
    const repo=options.foundation!;
    routes.get<{Querystring:Record<string,unknown>}>('/v1/tasks',async req=>{
      const query={...parsePage(req.query),status:textFilter(req.query.status),recordId:textFilter(req.query.recordId)};
      if(query.recordId&&!isRecordId(query.recordId))throw new PageError('recordId phải là UUID.');
      if(repo.listTasksPage)return repo.listTasksPage(scopes.get(req)!,query);
      return {items:await repo.listTasks(scopes.get(req)!)};
    });
    routes.get<{Params:{id:string}}>('/v1/tasks/:id',async(req,reply)=>{
      if(!isRecordId(req.params.id))return reply.code(400).send({error:'Task ID phải là UUID.'});
      if(!repo.readTask)return reply.code(503).send({error:'Task detail chưa cấu hình.'});
      return await repo.readTask(req.params.id,scopes.get(req)!)??reply.code(404).send({error:'Không tìm thấy task.'});
    });
    routes.post<{Body:{title?:unknown;assigneeId?:unknown;recordId?:unknown}}>('/v1/tasks',async(req,reply)=>{
      const input=parseTaskCreateInput(req.body);
      if(!input)return reply.code(400).send({error:'Input nhiệm vụ không hợp lệ.'});
      const key=parseCreateKey(req.headers['idempotency-key'],req.raw.rawHeaders);
      requireCreateCapability(key,repo);
      const scope=scopes.get(req)!;
      await requireAssignee(input.assigneeId,scope,options.directory);
      const recordId=await resolveRecordLink(input.recordId,scope,options.records);
      return reply.code(201).send(await repo.createTask({...input,organizationId:scope.organizationId,createdBy:scope.subject,...(recordId?{recordId}:{})},key));
    });
    routes.post<{Params:{id:string};Body:{decision?:unknown;reason?:unknown;expectedVersion?:unknown}}>('/v1/tasks/:id/decisions',async(req,reply)=>{
      const {decision,reason='',expectedVersion}=req.body??{};
      if((decision!=='approve'&&decision!=='reject')||typeof reason!=='string'||reason.length>2000||(decision==='reject'&&!reason.trim())||!Number.isSafeInteger(expectedVersion)||Number(expectedVersion)<1)return reply.code(400).send({error:'Quyết định, lý do hoặc phiên bản không hợp lệ.'});
      const task=await repo.decideTask(req.params.id,scopes.get(req)!,decision,reason.trim(),Number(expectedVersion));
      return task??reply.code(409).send({error:'Task không khả dụng, đã xử lý hoặc sai phiên bản.'});
    });
    routes.post<{Body:{filename?:unknown;contentBase64?:unknown;recordId?:unknown}}>('/v1/files',{bodyLimit:1_450_000},async(req,reply)=>{
      const {filename,contentBase64}=req.body??{};
      if(typeof filename!=='string'||!filename.trim()||filename.length>200||/[\x00-\x1f\/\\]/.test(filename)||typeof contentBase64!=='string'||!contentBase64.length)return reply.code(400).send({error:'Tên hoặc nội dung tệp không hợp lệ.'});
      try{encodeURIComponent(filename);}catch{return reply.code(400).send({error:'Tên tệp chứa Unicode không hợp lệ.'});}
      const content=Buffer.from(contentBase64,'base64');
      if(content.length>1_048_576)return reply.code(413).send({error:'Giới hạn tệp 1 MiB.'});
      if(content.toString('base64')!==contentBase64)return reply.code(400).send({error:'Base64 không hợp lệ.'});
      const scope=scopes.get(req)!;
      const recordId=await resolveRecordLink(req.body?.recordId,scope,options.records);
      let status:ScanStatus='error';
      try{if(options.scan)status=await options.scan(content);}catch{ /* Scanner errors never grant download access. */ }
      if(status==='rejected')return reply.code(409).send({error:'Tệp bị từ chối bởi bộ quét mã độc.'});
      if(status!=='clean')return reply.code(503).send({error:'Dịch vụ quét mã độc tạm thời không khả dụng.'});
      const file=await repo.createFile({filename:filename.trim(),ownerId:scope.subject,organizationId:scope.organizationId,content,...(recordId?{recordId}:{})});
      await repo.markFile(file.id,'clean');
      return reply.code(201).send({...file,scanStatus:'clean'});
    });
    routes.get<{Params:{id:string}}>('/v1/files/:id',async(req,reply)=>{
      const file=repo.readFileMetadata?await repo.readFileMetadata(req.params.id,scopes.get(req)!):await repo.readFile(req.params.id,scopes.get(req)!)??await options.readSharedFile?.(req.params.id,scopes.get(req)!)??await repo.readTaskFile?.(req.params.id,scopes.get(req)!);
      if(!file)return reply.code(404).send({error:'Không tìm thấy tệp.'});
      const {content,...metadata}=file as FileItem&{content?:Buffer};return metadata;
    });
    routes.get<{Params:{id:string}}>('/v1/files/:id/content',async(req,reply)=>{
      if(repo.loadFileContent){const file=await repo.loadFileContent(req.params.id,scopes.get(req)!);if(!file)return reply.code(404).send({error:'Không tìm thấy tệp.'});return reply.type('application/octet-stream').header('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`).header('X-Content-Type-Options','nosniff').send(file.content);}
      const file=await repo.readFile(req.params.id,scopes.get(req)!)??await options.readSharedFile?.(req.params.id,scopes.get(req)!)??await repo.readTaskFile?.(req.params.id,scopes.get(req)!);
      if(!file)return reply.code(404).send({error:'Không tìm thấy tệp.'});
      if(file.scanStatus!=='clean')return reply.code(409).send({error:'Tệp chưa được phép sử dụng.'});
      return reply.type('application/octet-stream').header('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`).header('X-Content-Type-Options','nosniff').send(file.content);
    });
  });
}
