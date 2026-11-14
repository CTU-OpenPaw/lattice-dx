/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {verifyIdentity,type IdentityConfig} from '../identity.js';
import {parseCreateKey,CreateCommandError} from '../create-command.js';
import {parsePage,PageError} from '../pagination.js';
import {bad,exact,uuid,EntityError} from './policy.js';
import {parseReportInput} from './reports-policy.js';
import type {ReportsRepository} from './reports-types.js';
import type {Scope} from './types.js';
export type ReportsOptions={identity?:IdentityConfig;reports?:ReportsRepository};
export function registerReports(app:FastifyInstance,options:ReportsOptions){
 function route(method:'GET'|'POST',url:string,handler:(request:FastifyRequest,repo:ReportsRepository,scope:Scope)=>Promise<unknown>){
  app.route({method,url,handler:async(request,reply)=>{
   if(!options.identity||!options.reports)return reply.code(503).send({error:'Reports are unavailable.'});
   let actor;try{actor=await verifyIdentity(request.headers.authorization,options.identity);}catch{return reply.code(401).send({error:'Invalid token.'});}
   if(!actor.organizationId||!actor.roles.includes('data:read'))return reply.code(403).send({error:'Forbidden.'});
   try{const result=await handler(request,options.reports,{actorId:actor.subject,organizationId:actor.organizationId});return reply.code(method==='POST'?201:200).send(result);}
   catch(error){if(error instanceof EntityError||error instanceof CreateCommandError||error instanceof PageError)return reply.code(error.statusCode).send({error:error.message});throw error;}
  }});
 }
 route('POST','/v1/entity-report-snapshots',async(request,repo,scope)=>{
  exact(request.query,[]);const input=parseReportInput(request.body),key=parseCreateKey(request.headers['idempotency-key'],request.raw.rawHeaders);if(!key)bad('Idempotency-Key is required.');return repo.create(scope,input,key);
 });
 route('GET','/v1/entity-report-snapshots',async(request,repo,scope)=>repo.list(scope,parsePage(exact(request.query,['limit','offset','q']))));
 route('GET','/v1/entity-report-snapshots/:id',async(request,repo,scope)=>{exact(request.query,[]);return repo.get(scope,uuid((request.params as {id:string}).id));});
}
