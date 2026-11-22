/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type {FastifyInstance} from 'fastify';
import {verifyIdentity,type IdentityConfig} from '../identity.js';
import {parsePage,PageError} from '../pagination.js';
import {parseCreateKey,CreateCommandError} from '../create-command.js';
import type {Scope} from '../foundation.js';
import {TaskLifecycleError,type TaskLifecycleRepository,type MutationOperation} from './types.js';
import {parseQueueInput,parseMutation,taskId} from './policy.js';
export type TaskLifecycleOptions={identity?:IdentityConfig;taskLifecycle?:TaskLifecycleRepository};
export function registerTaskLifecycle(app:FastifyInstance,options:TaskLifecycleOptions){
 app.register(async routes=>{
  const actors=new WeakMap<object,Scope>();
  routes.setErrorHandler((error,_req,reply)=>{if(error instanceof TaskLifecycleError||error instanceof PageError||error instanceof CreateCommandError)return reply.code(error.statusCode).send({error:error.message});return reply.send(error);});
  routes.addHook('preHandler',async(req,reply)=>{
   if(!options.identity||!options.taskLifecycle)return reply.code(503).send({error:'Task lifecycle chưa được cấu hình.'});
   let identity;try{identity=await verifyIdentity(req.headers.authorization,options.identity);}catch{return reply.code(401).send({error:'Token không hợp lệ.'});}
   if(!identity.organizationId||!identity.roles.includes(req.method==='GET'?'tasks:read':'tasks:assign'))return reply.code(403).send({error:'Không có quyền thực hiện tác vụ.'});
   actors.set(req,{subject:identity.subject,organizationId:identity.organizationId});
  });
  const key=(req:{headers:Record<string,unknown>;raw:{rawHeaders:string[]}})=>{const k=parseCreateKey(req.headers['idempotency-key'],req.raw.rawHeaders);if(!k)throw new TaskLifecycleError(400,'Idempotency-Key bắt buộc.');return k;};
  routes.post('/v1/task-queues',async(req,reply)=>reply.code(201).send(await options.taskLifecycle!.createQueue(actors.get(req)!,parseQueueInput(req.body),key(req))));
  routes.get<{Querystring:Record<string,unknown>}>('/v1/task-queues',async req=>options.taskLifecycle!.queue(actors.get(req)!,parsePage(req.query)));
  for(const op of ['claim','reassign','cancel','deadline'] as MutationOperation[]){
   routes.post<{Params:{id:string}}>(`/v1/tasks/:id/${op}`,async req=>options.taskLifecycle![op==='deadline'?'setDeadline':op](taskId(req.params.id),actors.get(req)!,parseMutation(op,req.body),key(req)));
  }
  routes.get<{Params:{id:string};Querystring:Record<string,unknown>}>('/v1/tasks/:id/history',async req=>options.taskLifecycle!.history(taskId(req.params.id),actors.get(req)!,parsePage(req.query)));
 });
}
