// SPDX-License-Identifier: Apache-2.0
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {CreateCommandError,parseCreateKey} from '../create-command.js';
import {verifyIdentity} from '../identity.js';
import {PageError} from '../pagination.js';
import {bad,EntityError,exact} from '../entities/policy.js';
import type {EntityOptions} from '../entities/routes.js';
import {blockCatalog,findBlock,runBlock} from './registry.js';
export function registerBlocks(app:FastifyInstance,options:EntityOptions){
 async function authenticate(request:FastifyRequest){
  if(!options.identity||!options.entities)return {error:503 as const};
  try{const actor=await verifyIdentity(request.headers.authorization,options.identity);return actor.organizationId?{actor}:{error:403 as const};}catch{return {error:401 as const};}
 }
 app.get('/v1/blocks',async(request,reply)=>{
  const auth=await authenticate(request);if(auth.error)return reply.code(auth.error).send({error:'Block service unavailable or unauthorized.'});
  try{exact(request.query,[]);return {items:blockCatalog.filter(block=>auth.actor.roles.includes(block.requiredRole)&&(block.id!=='entities.query'||!!options.entities?.query))};}catch(error){if(error instanceof EntityError)return reply.code(error.statusCode).send({error:error.message});throw error;}
 });
 app.post<{Params:{id:string}}>('/v1/blocks/:id/run',async(request,reply)=>{
  const auth=await authenticate(request);if(auth.error)return reply.code(auth.error).send({error:'Block service unavailable or unauthorized.'});
  const block=findBlock(request.params.id);if(!block)return reply.code(404).send({error:'Block not found.'});
  if(!auth.actor.roles.includes(block.requiredRole))return reply.code(403).send({error:'Block role required.'});
  try{
   exact(request.query,[]);const body=exact(request.body,['version','input']);if(body.version!==1)bad('Unsupported block version.');
   const key=block.mutation?parseCreateKey(request.headers['idempotency-key'],request.raw.rawHeaders):undefined;
   const result=await runBlock(block,options.entities!,{actorId:auth.actor.subject,organizationId:auth.actor.organizationId!},body.input,key);
   if(result===undefined)return reply.code(404).send({error:'Entity not found.'});
   return {blockId:block.id,version:1,status:'succeeded',result};
  }catch(error){if(error instanceof EntityError||error instanceof CreateCommandError||error instanceof PageError)return reply.code(error.statusCode).send({error:error.message});throw error;}
 });
}
