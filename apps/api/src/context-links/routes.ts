/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {verifyIdentity,type IdentityConfig} from '../identity.js';
import {EntityError} from '../entities/policy.js';
import type {EntityRepository,Scope} from '../entities/types.js';
import {PageError,parsePage} from '../pagination.js';
import {commandKey,ContextLinksError,entityId,exact,invalid,parseMutation} from './policy.js';
import type {ContextLinksRepository} from './types.js';
export type ContextLinksOptions={identity?:IdentityConfig;entities?:EntityRepository;contextLinks?:ContextLinksRepository};
export function registerContextLinks(app:FastifyInstance,options:ContextLinksOptions):void {
 app.register(async routes=>{
  const scopes=new WeakMap<object,Scope>();
  routes.setErrorHandler((error,_request,reply)=>{
   let safe:ContextLinksError;
   if(error instanceof ContextLinksError)safe=error;
   else if(error instanceof EntityError)safe=new ContextLinksError(error.statusCode,error.statusCode===404?'not_found':error.statusCode===409?'resource_conflict':'invalid_request','Context request failed.');
   else if(error instanceof PageError)safe=new ContextLinksError(400,'invalid_request','Invalid pagination.');
   else {
    const framework=error as {code?:string;statusCode?:number};
    safe=framework.code?.startsWith('FST_ERR_CTP_')&&[400,413,415].includes(framework.statusCode??0)
     ?new ContextLinksError(framework.statusCode!,'invalid_request','Invalid request body.')
     :new ContextLinksError(503,'runtime_unavailable','Context service is unavailable.');
   }
   return reply.code(safe.statusCode).send({error:{code:safe.code,message:safe.message}});
  });
  routes.addHook('onRequest',async request=>{
   if(request.method==='GET'&&(request.headers['transfer-encoding']!==undefined||(request.headers['content-length']!==undefined&&request.headers['content-length']!=='0')))invalid('Unexpected request body.');
  });
  routes.addHook('preHandler',async request=>{
   if(!options.identity)throw new ContextLinksError(503,'identity_unavailable','Identity is not configured.');
   let actor;try{actor=await verifyIdentity(request.headers.authorization,options.identity);}catch{throw new ContextLinksError(401,'invalid_token','Invalid token.');}
   if(!actor.organizationId||!actor.roles.includes('data:read')||(request.method!=='GET'&&!actor.roles.includes('data:design')))throw new ContextLinksError(403,'authority_denied','Required data roles and organization scope are missing.');
   if(!options.entities||!options.contextLinks)throw new ContextLinksError(503,'runtime_unavailable','Context service is not configured.');
   const scope={actorId:actor.subject,organizationId:actor.organizationId};scopes.set(request,scope);
   const id=entityId((request.params as {id:string}).id);
   if(!await options.entities.find(scope,id))throw new ContextLinksError(404,'not_found','Entity not found.');
  });
  function input(request:FastifyRequest){exact(request.query,[]);return {scope:scopes.get(request)!,id:entityId((request.params as {id:string}).id)};}
  const base='/v1/entities/:id/context-links/ngsi-ld';
  routes.get(base,async request=>{const {scope,id}=input(request);return {version:1,entityId:id,mapping:await options.contextLinks!.get(scope,id)};});
  routes.put(base,async request=>{const {scope,id}=input(request);return options.contextLinks!.put(scope,id,parseMutation(request.body,scope.organizationId,false),commandKey(request.headers['idempotency-key'],request.raw.rawHeaders));});
  routes.delete(base,async request=>{const {scope,id}=input(request);return options.contextLinks!.remove(scope,id,parseMutation(request.body,scope.organizationId,true),commandKey(request.headers['idempotency-key'],request.raw.rawHeaders));});
  routes.get(base+'/history',async request=>{
   const query=request.query as Record<string,unknown>;
   if(Object.keys(query).some(key=>!['limit','offset'].includes(key)))invalid();
   const page=parsePage(query),scope=scopes.get(request)!,id=entityId((request.params as {id:string}).id);
   return options.contextLinks!.history(scope,id,page);
  });
  routes.get('/v1/entities/:id/context',async request=>{const {scope,id}=input(request);return options.contextLinks!.context(scope,id);});
 });
}
