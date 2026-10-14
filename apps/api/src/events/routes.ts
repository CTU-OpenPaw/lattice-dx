// SPDX-License-Identifier: Apache-2.0
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {WorkflowActor} from '@dx/contracts';
import {verifyIdentity,type IdentityConfig} from '../identity.js';
import {CreateCommandError,parseCreateKey} from '../create-command.js';
import {PageError,parsePage} from '../pagination.js';
import {WorkflowError} from '../workflows/policy.js';
import {parseEvent,parseSubscription,requireDesigner,requireReceiver,validEventId,validSubscriptionId} from './policy.js';
import type {EventRepository} from './types.js';

export type EventOptions={identity?:IdentityConfig;events?:EventRepository};
function mutationKey(request:FastifyRequest):string {
 const key=parseCreateKey(request.headers['idempotency-key'],request.raw.rawHeaders);
 if(!key)throw new WorkflowError(400,'Idempotency-Key is required.');
 return key;
}
function noQuery(value:Record<string,unknown>):void {
 if(Object.keys(value).length)throw new WorkflowError(400,'Unexpected query.');
}
export function registerWorkflowEvents(app:FastifyInstance,options:EventOptions):void {
 app.register(async routes=>{
  const actors=new WeakMap<object,WorkflowActor>();
  routes.setErrorHandler((error,_request,reply)=>{
   if(error instanceof WorkflowError||error instanceof PageError||error instanceof CreateCommandError)return reply.code(error.statusCode).send({error:error.message});
   return reply.send(error);
  });
  routes.addHook('preHandler',async(request,reply)=>{
   if(!options.identity)return reply.code(503).send({error:'Event identity is not configured.'});
   let identity;
   try {identity=await verifyIdentity(request.headers.authorization,options.identity);}
   catch {return reply.code(401).send({error:'Invalid token.'});}
   if(!identity.organizationId)return reply.code(403).send({error:'Organization scope is required.'});
   if(!options.events)return reply.code(503).send({error:'Event database is not configured.'});
   actors.set(request,{...identity,organizationId:identity.organizationId});
  });
  routes.post<{Querystring:Record<string,unknown>}>('/v1/workflow-events',{bodyLimit:128*1024},async request=>{
   const actor=actors.get(request)!;
   requireReceiver(actor);
   noQuery(request.query);
   const value=parseEvent(request.body);
   if(!value)throw new WorkflowError(400,'Invalid inbound event.');
   return options.events!.receive(value,actor);
  });
  routes.get<{Params:{eventId:string};Querystring:Record<string,unknown>}>('/v1/workflow-events/:eventId',async request=>{
   const actor=actors.get(request)!;
   requireReceiver(actor);
   noQuery(request.query);
   if(!validEventId(request.params.eventId))throw new WorkflowError(400,'Invalid event ID.');
   return options.events!.get(request.params.eventId,actor);
  });
  routes.get<{Querystring:Record<string,unknown>}>('/v1/workflow-event-subscriptions',async request=>{
   const actor=actors.get(request)!;
   requireDesigner(actor);
   if(Object.keys(request.query).some(key=>!['limit','offset','q'].includes(key)))throw new WorkflowError(400,'Unexpected query.');
   return options.events!.listSubscriptions(actor,parsePage(request.query));
  });
  routes.post<{Querystring:Record<string,unknown>}>('/v1/workflow-event-subscriptions',{bodyLimit:128*1024},async(request,reply)=>{
   const actor=actors.get(request)!;
   requireDesigner(actor);
   noQuery(request.query);
   const value=parseSubscription(request.body);
   if(!value)throw new WorkflowError(400,'Invalid subscription.');
   return reply.code(201).send(await options.events!.createSubscription(value,actor,mutationKey(request)));
  });
  routes.patch<{Params:{id:string};Querystring:Record<string,unknown>}>('/v1/workflow-event-subscriptions/:id',{bodyLimit:128*1024},async request=>{
   const actor=actors.get(request)!;
   requireDesigner(actor);
   noQuery(request.query);
   const value=parseSubscription(request.body,true);
   if(!value||!validSubscriptionId(request.params.id)||value.id!==request.params.id)throw new WorkflowError(400,'Invalid subscription or fixed ID.');
   return options.events!.updateSubscription(request.params.id,value,actor,mutationKey(request));
  });
 });
}
