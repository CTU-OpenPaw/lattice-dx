// SPDX-License-Identifier: Apache-2.0
import type {FastifyInstance} from 'fastify';
import {verifyIdentity,type IdentityConfig} from '../identity.js';
import {OperationsError,parseCutoff} from './policy.js';
import type {OperationsRepository} from './types.js';
import type {Telemetry} from './telemetry.js';
import type {RuntimeConfig} from './runtime-config.js';
export type OperationsOptions={identity?:IdentityConfig;operations?:OperationsRepository;coreConfigured?:boolean;coreCapabilities?:Record<string,boolean>;telemetry?:Telemetry;runtimeWorkers?:RuntimeConfig['workers']};
export function registerOperations(app:FastifyInstance,options:OperationsOptions){
 async function databaseReady(){
  if(!options.operations)return false;
  try{return await options.operations.ready();}catch{return false;}
 }
 app.get('/ready',async(_request,reply)=>{const available=!!options.coreConfigured&&!!options.identity&&await databaseReady();return reply.code(available?200:503).send({status:available?'ready':'not_ready',service:'api'});});
 app.register(async routes=>{
  const orgs=new WeakMap<object,string>();
  routes.addHook('preHandler',async(request,reply)=>{
   if(!options.identity)return reply.code(503).send({error:'Operations are not configured.'});
   let actor;try{actor=await verifyIdentity(request.headers.authorization,options.identity);}catch{return reply.code(401).send({error:'Invalid token.'});}
   if(!actor.organizationId||!actor.roles.includes('platform:operate'))return reply.code(403).send({error:'Operations role required.'});
   orgs.set(request,actor.organizationId);
  });
  routes.get('/v1/operations/diagnostics',async(request,reply)=>{
   if(Object.keys(request.query as object).length)return reply.code(400).send({error:'Unexpected query.'});
   const database=await databaseReady(),available=database&&!!options.coreConfigured;
   return reply.code(available?200:503).send({status:available?'ready':'not_ready',coreConfigured:!!options.coreConfigured,capabilities:options.coreCapabilities??{},database:database?'reachable':'unavailable',workers});
  });
  const workers={outbox:options.runtimeWorkers?.outbox===true,timers:options.runtimeWorkers?.timers===true,waitTimeouts:options.runtimeWorkers?.waitTimeouts===true,automations:options.runtimeWorkers?.automations===true,fileStorage:options.runtimeWorkers?.fileStorage===true};
  const invalidInput=(request:{query:unknown;body:unknown;headers:Record<string,unknown>})=>Object.keys(request.query as object).length>0||request.body!==undefined||request.headers['transfer-encoding']!==undefined||(request.headers['content-length']!==undefined&&request.headers['content-length']!=='0');
  routes.get('/v1/operations/metrics',async(request,reply)=>{
   if(invalidInput(request))return reply.code(400).send({error:'Unexpected query or body.'});
   if(!options.telemetry)return reply.code(503).send({error:'Metrics are not configured.'});
   return options.telemetry.snapshot();
  });
  routes.get('/v1/operations/queues',async(request,reply)=>{
   if(invalidInput(request))return reply.code(400).send({error:'Unexpected query or body.'});
   if(!options.operations?.queues)return reply.code(503).send({error:'Operations database unavailable.'});
   try{return {items:await options.operations.queues(orgs.get(request)!),workers};}
   catch{return reply.code(503).send({error:'Operations database unavailable.'});}
  });
  routes.get<{Querystring:Record<string,unknown>}>('/v1/operations/retention-preview',async(request,reply)=>{
   if(!options.operations)return reply.code(503).send({error:'Operations database unavailable.'});
   try{
    if(Object.keys(request.query).some(key=>key!=='before'))throw new OperationsError(400,'Unexpected query.');
    const before=parseCutoff(request.query.before);
    return await options.operations!.retentionPreview(orgs.get(request)!,before);
   }catch(error){
    if(error instanceof OperationsError)return reply.code(error.statusCode).send({error:error.message});
    return reply.code(503).send({error:'Operations database unavailable.'});
   }
  });
 });
}
