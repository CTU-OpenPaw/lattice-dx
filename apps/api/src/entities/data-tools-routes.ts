// SPDX-License-Identifier: Apache-2.0
import type { FastifyInstance, FastifyReply, FastifyRequest, HTTPMethods } from 'fastify';
import { CreateCommandError, parseCreateKey } from '../create-command.js';
import { verifyIdentity, type IdentityConfig } from '../identity.js';
import { PageError, parsePage } from '../pagination.js';
import { bad, EntityError, exact, uuid, version } from './policy.js';
import type { Scope } from './types.js';
import { format, parseImportInput, parseMigrationInput } from './data-tools-policy.js';
import { parseEntityQuery } from './query.js';
import type { EntityDataToolsRepository } from './data-tools-types.js';
import {FileReadError} from '../files/content.js';
export type EntityDataToolsOptions={identity?:IdentityConfig;dataTools?:EntityDataToolsRepository};
function key(request:FastifyRequest){const value=parseCreateKey(request.headers['idempotency-key'],request.raw.rawHeaders);if(!value)bad('Idempotency-Key is required.');return value;}
function path(request:FastifyRequest){return request.params as Record<string,string>;}
export function registerEntityDataTools(app:FastifyInstance,options:EntityDataToolsOptions){
 function route(method:HTTPMethods,url:string,roles:string[],handler:(request:FastifyRequest,repository:EntityDataToolsRepository,scope:Scope,reply:FastifyReply)=>Promise<unknown>){
  app.route({method,url,bodyLimit:2*1024*1024,handler:async(request,reply)=>{
   if(!options.identity||!options.dataTools)return reply.code(503).send({error:'Entity data tools are unavailable.'});
   let actor;try{actor=await verifyIdentity(request.headers.authorization,options.identity);}catch{return reply.code(401).send({error:'Invalid token.'});}
   if(!actor.organizationId||roles.some(role=>!actor.roles.includes(role)))return reply.code(403).send({error:'Forbidden.'});
   try{if(method!=='GET')exact(request.query,[]);return await handler(request,options.dataTools,{actorId:actor.subject,organizationId:actor.organizationId},reply);}
   catch(error){if(error instanceof FileReadError||error instanceof EntityError||error instanceof CreateCommandError||error instanceof PageError)return reply.code(error.statusCode).send({error:error.message});throw error;}
  }});
 }
 route('POST','/v1/entities/:id/attachments',['data:write'],async(request,repo,scope)=>{
  const body=exact(request.body,['fileId','expectedVersion']);return repo.attach(scope,uuid(path(request).id),{fileId:uuid(body.fileId),expectedVersion:version(body.expectedVersion)},key(request));
 });
 route('DELETE','/v1/entities/:id/attachments/:fileId',['data:write'],async(request,repo,scope)=>{
  const body=exact(request.body,['expectedVersion']);return repo.detach(scope,uuid(path(request).id),{fileId:uuid(path(request).fileId),expectedVersion:version(body.expectedVersion)},key(request));
 });
 route('GET','/v1/entities/:id/attachments',['data:read'],async(request,repo,scope)=>repo.attachments(scope,uuid(path(request).id),parsePage(exact(request.query,['limit','offset','q']))));
 route('GET','/v1/entities/:id/attachments/:fileId/content',['data:read','files:read'],async(request,repo,scope,reply)=>{
  exact(request.query,[]);const result=await repo.attachmentContent(scope,uuid(path(request).id),uuid(path(request).fileId));
  reply.type('application/octet-stream').header('X-Content-Type-Options','nosniff').header('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`);return result.content;
 });
 route('POST','/v1/entity-imports/dry-run',['data:write'],async(request,repo,scope)=>repo.importDryRun(scope,parseImportInput(request.body)));
 route('POST','/v1/entity-imports/commit',['data:write'],async(request,repo,scope)=>{
  const input=parseImportInput(request.body,true);
  return repo.importCommit(scope,{...input,expectedDigest:input.expectedDigest!},key(request));
 });
 route('POST','/v1/entities/export',['data:read'],async(request,repo,scope)=>{
  const body=exact(request.body,['query','format']);
  const queryBody=exact(body.query,['schemaId','schemaVersion','filters','sort','limit','offset']);
  if(queryBody.limit===undefined)bad('Export query requires a limit at most 100.');
  return repo.export(scope,{query:parseEntityQuery(queryBody),format:format(body.format)});
 });
 route('POST','/v1/entities/:id/migration/dry-run',['data:write'],async(request,repo,scope)=>repo.migrationDryRun(scope,uuid(path(request).id),parseMigrationInput(request.body)));
 route('POST','/v1/entities/:id/migration/commit',['data:write'],async(request,repo,scope)=>{
  const input=parseMigrationInput(request.body,true);
  return repo.migrationCommit(scope,uuid(path(request).id),{...input,expectedDigest:input.expectedDigest!},key(request));
 });

}
