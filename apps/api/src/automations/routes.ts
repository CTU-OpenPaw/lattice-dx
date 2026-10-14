// SPDX-License-Identifier: Apache-2.0
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {WorkflowActor} from '@dx/contracts';
import {isRecordId} from '@dx/contracts';
import {verifyIdentity,type IdentityConfig} from '../identity.js';
import {parsePage,PageError} from '../pagination.js';
import {WorkflowError} from '../workflows/policy.js';
import {AutomationError,parseRule,requireConfiguration,requireKey} from './policy.js';
import type {AutomationRepository} from './types.js';
export type AutomationOptions={identity?:IdentityConfig;automations?:AutomationRepository};
export function registerAutomations(app:FastifyInstance,options:AutomationOptions){app.register(async routes=>{
 const actors=new WeakMap<object,WorkflowActor>();
 routes.setErrorHandler((error,_req,reply)=>error instanceof WorkflowError||error instanceof PageError?reply.code(error.statusCode).send({error:error instanceof AutomationError?error.code:'validation_failed'}):reply.code(500).send({error:'internal_error'}));
 routes.addHook('preHandler',async(req,reply)=>{
  if(!options.identity)return reply.code(503).send({error:'identity_unavailable'});
  let identity;try{identity=await verifyIdentity(req.headers.authorization,options.identity);}catch{return reply.code(401).send({error:'invalid_token'});}
  if(!identity.organizationId)return reply.code(403).send({error:'authority_denied'});
  const actor={...identity,organizationId:identity.organizationId};requireConfiguration(actor);
  if(!options.automations)return reply.code(503).send({error:'runtime_unavailable'});actors.set(req,actor);
 });
 function key(req:FastifyRequest){const value=req.headers['idempotency-key'];if(req.raw.rawHeaders.filter((_,i,a)=>i%2===0&&a[i].toLowerCase()==='idempotency-key').length!==1)throw new AutomationError('validation_failed',400);requireKey(value);return value;}
 function page(req:FastifyRequest){const q=req.query as Record<string,unknown>;if(Object.keys(q).some(k=>!['limit','offset','q'].includes(k)))throw new AutomationError('validation_failed',400);return parsePage(q);}
 routes.post('/v1/entity-automations',async(req,reply)=>{const value=parseRule(req.body);return reply.code(201).send(await options.automations!.create(value,actors.get(req)!,key(req)));});
 routes.put<{Params:{id:string}}>('/v1/entity-automations/:id',async req=>{const value=parseRule(req.body,true);if(value.id!==req.params.id)throw new AutomationError('validation_failed',400);return options.automations!.update(req.params.id,{...value,expectedRevision:value.expectedRevision!},actors.get(req)!,key(req));});
 routes.get('/v1/entity-automations',async req=>options.automations!.list(actors.get(req)!,page(req)));
 routes.get<{Params:{id:string}}>('/v1/entity-automations/:id/deliveries',async req=>options.automations!.deliveries(req.params.id,actors.get(req)!,page(req)));
 routes.post<{Params:{id:string;deliveryId:string}}>('/v1/entity-automations/:id/deliveries/:deliveryId/retry',async req=>{
  const body=req.body as Record<string,unknown>;if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==1||!Number.isSafeInteger(body.expectedVersion)||Number(body.expectedVersion)<1||!isRecordId(req.params.deliveryId))throw new AutomationError('validation_failed',400);
  return options.automations!.retry(req.params.id,req.params.deliveryId,Number(body.expectedVersion),actors.get(req)!,key(req));
 });
});}
