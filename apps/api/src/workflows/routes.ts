// SPDX-License-Identifier: Apache-2.0
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { isRecordId, type WorkflowActor, type WorkflowRun, type TransferWorkflowTask } from '@dx/contracts';
import { verifyIdentity, type IdentityConfig } from '../identity.js';
import { sourceRegistry,type DefinitionRegistry } from './registry.js';
import { availableTransitions, parseCreate, parseCommand, WorkflowError } from './policy.js';
import type { WorkflowRepository } from './types.js';
import { PageError,pageResult,parsePage,textFilter } from '../pagination.js';
import {parseTimerRetry} from './timer-policy.js';
import {parseLifecycle} from './lifecycle-database.js';
import { parseCompletion } from './completion-policy.js';
export type WorkflowOptions={identity?:IdentityConfig;workflows?:WorkflowRepository;definitionRegistry?:DefinitionRegistry};
function idempotencyKey(req:FastifyRequest):string {
  const key=req.headers['idempotency-key'];
  if(typeof key!=='string'||! /^[A-Za-z0-9._:-]{1,128}$/.test(key))throw new WorkflowError(400,'Cần Idempotency-Key hợp lệ (1–128 ký tự).');
  return key;
}
function workflowId(id:string):string {
  if(!isRecordId(id))throw new WorkflowError(400,'ID quy trình phải là UUID.');
  return id.toLowerCase();
}
export function registerWorkflows(app:FastifyInstance,options:WorkflowOptions) {
  const registry=options.definitionRegistry??sourceRegistry;
  async function view(run:WorkflowRun,actor:WorkflowActor){const def=await registry.get(actor.organizationId,run.definitionId,run.definitionVersion);if(!def)throw new WorkflowError(503,'Phiên bản quy trình không khả dụng.');return {...run,availableTransitions:availableTransitions(def,run,actor)};}
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
    routes.post<{Params:{id:string}}>('/v1/workflow-waits/:id/complete',async req=>{
      const value=parseCompletion(req.body);if(!value)throw new WorkflowError(400,'Dữ liệu hoàn thành không hợp lệ.');
      if(!repo.completeWait)throw new WorkflowError(503,'Workflow completion chưa cấu hình.');
      return repo.completeWait(workflowId(req.params.id),value,actors.get(req)!,idempotencyKey(req));
    });
    routes.get<{Params:{id:string};Querystring:Record<string,unknown>}>('/v1/workflows/:id/waits',async req=>{
      if(!repo.listWaits)throw new WorkflowError(503,'Workflow waits chưa cấu hình.');
      return repo.listWaits(workflowId(req.params.id),actors.get(req)!,parsePage(req.query));
    });
    routes.get('/v1/workflow-services',async req=>{
      if(!repo.listServices)throw new WorkflowError(503,'Workflow services unavailable.');
      return {items:await repo.listServices(actors.get(req)!)};
    });
    routes.get<{Params:{id:string};Querystring:Record<string,unknown>}>('/v1/workflows/:id/timers',async req=>{
      if(!repo.listTimers)throw new WorkflowError(503,'Workflow timers unavailable.');
      return repo.listTimers(workflowId(req.params.id),actors.get(req)!,parsePage(req.query));
    });
    routes.post<{Params:{id:string;timerId:string}}>('/v1/workflows/:id/timers/:timerId/retry',async req=>{
      const value=parseTimerRetry(req.body);if(!value)throw new WorkflowError(400,'Invalid timer retry.');
      if(!repo.retryTimer)throw new WorkflowError(503,'Workflow timers unavailable.');
      return repo.retryTimer(workflowId(req.params.id),workflowId(req.params.timerId),value.expectedVersion,actors.get(req)!,idempotencyKey(req));
    });
    routes.get('/v1/workflow-blocks',async req=>({items:[
      {id:'records.create',version:1,title:'Create record',requiredRole:'records:write'},
      {id:'tasks.create',version:1,title:'Create task',requiredRole:'tasks:assign'},
      {id:'connectors.dispatch',version:1,title:'Dispatch connector',requiredRole:'workflow:integrate'},
      {id:'timers.schedule',version:1,title:'Schedule service transition',requiredRole:'workflow:schedule'},
    ].filter(block=>actors.get(req)!.roles.includes(block.requiredRole))}));
    routes.get('/v1/workflow-definitions',async req=>{
      const actor=actors.get(req)!;
      const definitions=await registry.list(actor.organizationId);
      const latest=definitions.filter(d=>!definitions.some(other=>other.id===d.id&&other.version>d.version));
      return {items:latest.filter(d=>actor.roles.includes(d.startRole)||d.readerRoles.some(r=>actor.roles.includes(r))||!!d.assignedReader&&actor.roles.includes(d.assignedReader.role))};
    });
    routes.post('/v1/workflow-members/me',async req=>{
      if(req.body!==undefined&&(!req.body||typeof req.body!=='object'||Array.isArray(req.body)||Object.keys(req.body).length))throw new WorkflowError(400,'Không nhận định danh từ body.');
      const actor=actors.get(req)!;await repo.registerMember(actor);
      return {subject:actor.subject,organizationId:actor.organizationId};
    });
    routes.get('/v1/workflow-references',async req=>({items:await repo.references(actors.get(req)!)}));
    routes.post('/v1/workflows',async(req,reply)=>{
      const input=parseCreate(req.body);if(!input)throw new WorkflowError(400,'Dữ liệu tạo quy trình không hợp lệ.');
      const actor=actors.get(req)!;
      if(!actor.roles.includes('workflow:start'))throw new WorkflowError(403,'Không có quyền tạo quy trình.');
      return reply.code(201).send(await view(await repo.create(input,actor,idempotencyKey(req)),actor));
    });
    routes.get<{Querystring:Record<string,unknown>}>('/v1/workflows',async req=>{
      if(req.query.inbox!==undefined&&req.query.inbox!=='true'&&req.query.inbox!=='false')throw new WorkflowError(400,'inbox phải là true/false.');
      const actor=actors.get(req)!;
      const query={...parsePage(req.query),state:textFilter(req.query.state),definitionId:textFilter(req.query.definitionId)};
      if(repo.listPage){const result=await repo.listPage(actor,req.query.inbox==='true',query);return {...result,items:await Promise.all(result.items.map(run=>view(run,actor)))};}
      return {items:await Promise.all((await repo.list(actor,req.query.inbox==='true')).map(run=>view(run,actor)))};
    });
    routes.get<{Params:{id:string}}>('/v1/workflows/:id',async req=>view(await repo.get(workflowId(req.params.id),actors.get(req)!),actors.get(req)!));
    routes.post<{Params:{id:string}}>('/v1/workflows/:id/transitions',async req=>{
      const input=parseCommand(req.body);if(!input)throw new WorkflowError(400,'Dữ liệu chuyển bước không hợp lệ.');
      const actor=actors.get(req)!;
      return view(await repo.transition(workflowId(req.params.id),input,actor,idempotencyKey(req)),actor);
    });
    routes.post<{Params:{id:string}}>('/v1/workflows/:id/cancel',async req=>{
      const value=parseLifecycle(req.body);if(!value)throw new WorkflowError(400,'Dữ liệu huỷ không hợp lệ.');
      const actor=actors.get(req)!;if(!actor.roles.includes('workflow:start'))throw new WorkflowError(403,'Không có quyền huỷ quy trình.');
      const key=idempotencyKey(req);if(!repo.cancel)throw new WorkflowError(503,'Workflow lifecycle chưa cấu hình.');
      return view(await repo.cancel(workflowId(req.params.id),value,actor,key),actor);
    });
    routes.post<{Params:{id:string}}>('/v1/workflows/:id/task-transfer',async req=>{
      const value=parseLifecycle(req.body,true);if(!value)throw new WorkflowError(400,'Dữ liệu chuyển giao không hợp lệ.');
      const actor=actors.get(req)!;if(!actor.roles.includes('workflow:start')||!actor.roles.includes('tasks:assign'))throw new WorkflowError(403,'Không có quyền chuyển giao việc.');
      const key=idempotencyKey(req);if(!repo.taskTransfer)throw new WorkflowError(503,'Workflow lifecycle chưa cấu hình.');
      return view(await repo.taskTransfer(workflowId(req.params.id),value as TransferWorkflowTask,actor,key),actor);
    });
    routes.get<{Params:{id:string};Querystring:Record<string,unknown>}>('/v1/workflows/:id/executions',async req=>{
      const id=workflowId(req.params.id),actor=actors.get(req)!,query=parsePage(req.query);
      await repo.get(id,actor);
      return pageResult(repo.executions?await repo.executions(id,actor,query):[],query);
    });
    routes.get<{Params:{id:string}}>('/v1/workflows/:id/history',async req=>({items:await repo.history(workflowId(req.params.id),actors.get(req)!)}));
    routes.get<{Params:{id:string}}>('/v1/workflows/:id/sync',async req=>({items:await repo.jobs(workflowId(req.params.id),actors.get(req)!)}));
    routes.post<{Params:{id:string}}>('/v1/workflows/:id/sync/retry',async req=>{
      if(req.body!==undefined&&(!req.body||typeof req.body!=='object'||Array.isArray(req.body)||Object.keys(req.body).length))throw new WorkflowError(400,'Retry không nhận cấu hình từ body.');
      return {retried:await repo.retryJobs(workflowId(req.params.id),actors.get(req)!,idempotencyKey(req))};
    });
  });
}
