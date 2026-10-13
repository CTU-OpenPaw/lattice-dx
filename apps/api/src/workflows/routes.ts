// SPDX-License-Identifier: Apache-2.0
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { isRecordId, type WorkflowActor, type WorkflowRun } from '@dx/contracts';
import { verifyIdentity, type IdentityConfig } from '../identity.js';
import { getDefinition, workflowDefinitions } from '../../../../solutions/workflows/definitions.js';
import { availableTransitions, parseCreate, parseCommand, WorkflowError } from './policy.js';
import type { WorkflowRepository } from './types.js';
import { PageError,parsePage,textFilter } from '../pagination.js';
export type WorkflowOptions={identity?:IdentityConfig;workflows?:WorkflowRepository};
function idempotencyKey(req:FastifyRequest):string {
  const key=req.headers['idempotency-key'];
  if(typeof key!=='string'||! /^[A-Za-z0-9._:-]{1,128}$/.test(key))throw new WorkflowError(400,'Cần Idempotency-Key hợp lệ (1–128 ký tự).');
  return key;
}
function workflowId(id:string):string {
  if(!isRecordId(id))throw new WorkflowError(400,'ID quy trình phải là UUID.');
  return id.toLowerCase();
}
function view(run:WorkflowRun,actor:WorkflowActor) {
  const def=getDefinition(run.definitionId,run.definitionVersion);
  return {...run,availableTransitions:def?availableTransitions(def,run,actor):[]};
}
export function registerWorkflows(app:FastifyInstance,options:WorkflowOptions) {
  app.register(async routes=>{
    const actors=new WeakMap<object,WorkflowActor>();
    routes.setErrorHandler((error,_request,reply)=>{
      if(error instanceof WorkflowError||error instanceof PageError)return reply.code(error.statusCode).send({error:error.message});
      return reply.send(error);
    });
    routes.addHook('preHandler',async(req,reply)=>{
      if(!options.identity)return reply.code(503).send({error:'Workflow identity chưa cấu hình.'});
      let identity;
      try{identity=await verifyIdentity(req.headers.authorization,options.identity);}catch{return reply.code(401).send({error:'Token không hợp lệ.'});}
      if(!identity.organizationId)return reply.code(403).send({error:'Token thiếu phạm vi đơn vị.'});
      if(!options.workflows)return reply.code(503).send({error:'Workflow database chưa cấu hình.'});
      actors.set(req,{...identity,organizationId:identity.organizationId});
    });
    const repo=options.workflows!;
    routes.get('/v1/workflow-definitions',async req=>{
      const actor=actors.get(req)!;
      return {items:workflowDefinitions.filter(d=>actor.roles.includes(d.startRole)||d.readerRoles.some(r=>actor.roles.includes(r))||!!d.assignedReader&&actor.roles.includes(d.assignedReader.role))};
    });
    routes.post('/v1/workflow-members/me',async req=>{
      if(req.body!==undefined&&(!req.body||typeof req.body!=='object'||Array.isArray(req.body)||Object.keys(req.body).length))throw new WorkflowError(400,'Không nhận định danh từ body.');
      const actor=actors.get(req)!;await repo.registerMember(actor);
      return {subject:actor.subject,organizationId:actor.organizationId};
    });
    routes.get('/v1/workflow-references',async req=>({items:await repo.references(actors.get(req)!)}));
    routes.post('/v1/workflows',async(req,reply)=>{
      const input=parseCreate(req.body);if(!input)throw new WorkflowError(400,'Dữ liệu tạo quy trình không hợp lệ.');
      const actor=actors.get(req)!,def=getDefinition(input.definitionId);
      if(!def)throw new WorkflowError(400,'Quy trình không tồn tại.');
      if(!actor.roles.includes('workflow:start')||!actor.roles.includes(def.startRole))throw new WorkflowError(403,'Không có quyền tạo quy trình.');
      return reply.code(201).send(view(await repo.create(input,actor,idempotencyKey(req)),actor));
    });
    routes.get<{Querystring:Record<string,unknown>}>('/v1/workflows',async req=>{
      if(req.query.inbox!==undefined&&req.query.inbox!=='true'&&req.query.inbox!=='false')throw new WorkflowError(400,'inbox phải là true/false.');
      const actor=actors.get(req)!;
      const query={...parsePage(req.query),state:textFilter(req.query.state),definitionId:textFilter(req.query.definitionId)};
      if(repo.listPage){const result=await repo.listPage(actor,req.query.inbox==='true',query);return {...result,items:result.items.map(run=>view(run,actor))};}
      return {items:(await repo.list(actor,req.query.inbox==='true')).map(run=>view(run,actor))};
    });
    routes.get<{Params:{id:string}}>('/v1/workflows/:id',async req=>view(await repo.get(workflowId(req.params.id),actors.get(req)!),actors.get(req)!));
    routes.post<{Params:{id:string}}>('/v1/workflows/:id/transitions',async req=>{
      const input=parseCommand(req.body);if(!input)throw new WorkflowError(400,'Dữ liệu chuyển bước không hợp lệ.');
      const actor=actors.get(req)!;
      return view(await repo.transition(workflowId(req.params.id),input,actor,idempotencyKey(req)),actor);
    });
    routes.get<{Params:{id:string}}>('/v1/workflows/:id/history',async req=>({items:await repo.history(workflowId(req.params.id),actors.get(req)!)}));
    routes.get<{Params:{id:string}}>('/v1/workflows/:id/sync',async req=>({items:await repo.jobs(workflowId(req.params.id),actors.get(req)!)}));
    routes.post<{Params:{id:string}}>('/v1/workflows/:id/sync/retry',async req=>{
      if(req.body!==undefined&&(!req.body||typeof req.body!=='object'||Array.isArray(req.body)||Object.keys(req.body).length))throw new WorkflowError(400,'Retry không nhận cấu hình từ body.');
      return {retried:await repo.retryJobs(workflowId(req.params.id),actors.get(req)!,idempotencyKey(req))};
    });
  });
}
