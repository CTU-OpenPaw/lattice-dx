/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type { FastifyInstance, FastifyRequest, HTTPMethods } from 'fastify';
import { CreateCommandError, parseCreateKey } from '../create-command.js';
import { verifyIdentity, type IdentityConfig } from '../identity.js';
import { PageError, parsePage } from '../pagination.js';
import { bad, EntityError, exact, name, object, parseSchema, parseShare, principalKind, principalId, slug, title, uuid, version } from './policy.js';
import type { Attributes, EntityRepository, Scope } from './types.js';
import {parseEntityQuery} from './query.js';
import {aggregateRoute} from './aggregate-routes.js';
import {searchRoute} from './search-routes.js';
import {SearchUnavailableError} from './search-client.js';
export type EntityOptions = {identity?:IdentityConfig;entities?:EntityRepository};
function commandKey(request:FastifyRequest):string {
  const key=parseCreateKey(request.headers['idempotency-key'],request.raw.rawHeaders);
  if(!key) bad('Idempotency-Key is required.');
  return key;
}
function page(request:FastifyRequest,entityFilter=false) {
  const query=exact({...request.query as Record<string,unknown>},entityFilter?['limit','offset','q','schemaId']:['limit','offset','q']);
  return {...parsePage(query),...(query.schemaId!==undefined?{schemaId:slug(query.schemaId)}:{})};
}
function params(request:FastifyRequest):Record<string,string> { return request.params as Record<string,string>; }
function attributes(value:unknown):Attributes { return object(value) as Attributes; }

export function registerEntities(app:FastifyInstance,options:EntityOptions) {
  function route(method:HTTPMethods,url:string,role:string,handler:(request:FastifyRequest,repository:EntityRepository,scope:Scope)=>Promise<unknown>,statusCode=200) {
    app.route({method,url,...(url==='/v1/entities/search'?{bodyLimit:4096}:{}),handler:async(request,reply)=>{
      if(!options.identity||!options.entities) return reply.code(503).send({error:'Dịch vụ dữ liệu chưa được cấu hình.'});
      let actor;
      try { actor=await verifyIdentity(request.headers.authorization,options.identity); }
      catch { return reply.code(401).send({error:'Token không hợp lệ.'}); }
      if(!actor.organizationId||!actor.roles.includes(role)) return reply.code(403).send({error:'Không có quyền thực hiện tác vụ.'});
      try {
        if(method!=='GET') exact(request.query,[]);
        const result=await handler(request,options.entities,{actorId:actor.subject,organizationId:actor.organizationId});
        if(result===undefined) return reply.code(404).send({error:'Không tìm thấy dữ liệu.'});
        return reply.code(statusCode).send(result);
      } catch(error) {
        if(error instanceof SearchUnavailableError) return reply.code(503).send({error:'search_unavailable'});
        if(error instanceof EntityError||error instanceof CreateCommandError||error instanceof PageError) return reply.code(error.statusCode).send({error:error.message});
        throw error;
      }
    }});
  }
  route('POST','/v1/entity-schemas','data:design',async(request,repository,scope)=>repository.createSchema(scope,parseSchema(request.body)),201);
  route('GET','/v1/entity-schemas','data:design',async(request,repository,scope)=>repository.listSchemas(scope,page(request)));
  route('GET','/v1/entity-schemas/:id','data:design',async(request,repository,scope)=>{
    exact(request.query,[]);
    return repository.getSchema(scope,slug(params(request).id));
  });
  route('GET','/v1/entity-schemas/:id/versions/:version','data:read',async(request,repository,scope)=>{
    exact(request.query,[]);
    const path=params(request);
    if(!/^[1-9]\d*$/.test(path.version)||Number(path.version)>2147483647) bad('Invalid schema version.');
    return repository.getPublishedSchema(scope,slug(path.id),Number(path.version));
  });
  route('PUT','/v1/entity-schemas/:id','data:design',async(request,repository,scope)=>{
    const body=exact(request.body,['expectedRevision','title','fields','relations']);
    const expectedRevision=version(body.expectedRevision);
    const definition=parseSchema({id:slug(params(request).id),title:body.title,fields:body.fields,relations:body.relations});
    return repository.saveSchema(scope,definition.id,{title:definition.title,fields:definition.fields,relations:definition.relations,expectedRevision});
  });
  route('POST','/v1/entity-schemas/:id/publish','data:design',async(request,repository,scope)=>{
    const body=exact(request.body,['expectedRevision']);
    return repository.publishSchema(scope,slug(params(request).id),version(body.expectedRevision));
  });
  route('POST','/v1/entities','data:write',async(request,repository,scope)=>{
    const body=exact(request.body,['schemaId','schemaVersion','title','attributes']);
    const schemaVersion=body.schemaVersion===undefined?undefined:version(body.schemaVersion);
    if(schemaVersion!==undefined&&schemaVersion>2147483647)bad('Invalid schema version.');
    return repository.create(scope,{schemaId:slug(body.schemaId),...(schemaVersion===undefined?{}:{schemaVersion}),title:title(body.title),attributes:attributes(body.attributes)},commandKey(request));
  },201);
  route('GET','/v1/entities','data:read',async(request,repository,scope)=>repository.list(scope,page(request,true)));
  route('POST','/v1/entities/aggregate','data:read',aggregateRoute);
  route('POST','/v1/entities/search','data:read',searchRoute);
  route('POST','/v1/entities/query','data:read',async(request,repository,scope)=>{
    const input=parseEntityQuery(request.body);
    if(!repository.query) throw new EntityError(503,'Entity query is unavailable.');
    return repository.query(scope,input);
  });
  route('GET','/v1/entities/:id','data:read',async(request,repository,scope)=>{
    exact(request.query,[]);
    return repository.find(scope,uuid(params(request).id));
  });
  route('PATCH','/v1/entities/:id','data:write',async(request,repository,scope)=>{
    const body=exact(request.body,['expectedVersion','title','attributes']);
    return repository.update(scope,uuid(params(request).id),{expectedVersion:version(body.expectedVersion),title:title(body.title),attributes:attributes(body.attributes)},commandKey(request));
  });
  route('POST','/v1/entities/:id/archive','data:write',async(request,repository,scope)=>{
    const body=exact(request.body,['expectedVersion']);
    return repository.archive(scope,uuid(params(request).id),version(body.expectedVersion),commandKey(request));
  });
  route('POST','/v1/entities/:id/relations','data:write',async(request,repository,scope)=>{
    const body=exact(request.body,['expectedVersion','name','targetId']);
    return repository.link(scope,uuid(params(request).id),{name:name(body.name),targetId:uuid(body.targetId),expectedVersion:version(body.expectedVersion)},commandKey(request));
  });
  route('DELETE','/v1/entities/:id/relations/:name/:targetId','data:write',async(request,repository,scope)=>{
    const body=exact(request.body,['expectedVersion']);
    const path=params(request);
    return repository.unlink(scope,uuid(path.id),{name:name(path.name),targetId:uuid(path.targetId),expectedVersion:version(body.expectedVersion)},commandKey(request));
  });
  route('GET','/v1/entities/:id/relations','data:read',async(request,repository,scope)=>repository.relations(scope,uuid(params(request).id),page(request)));
  route('POST','/v1/entities/:id/shares','data:share',async(request,repository,scope)=>{
    const id=uuid(params(request).id), input=parseShare(request.body), key=commandKey(request);
    if(!repository.share) throw new EntityError(503,'Entity sharing is unavailable.');
    return repository.share(scope,id,input,key);
  });
  route('DELETE','/v1/entities/:id/shares/:kind/:principalId','data:share',async(request,repository,scope)=>{
    const body=exact(request.body,['expectedVersion']), path=params(request);
    const id=uuid(path.id), input={expectedVersion:version(body.expectedVersion),kind:principalKind(path.kind),principalId:principalId(path.principalId)},key=commandKey(request);
    if(!repository.revokeShare) throw new EntityError(503,'Entity sharing is unavailable.');
    return repository.revokeShare(scope,id,input,key);
  });
  route('GET','/v1/entities/:id/shares','data:share',async(request,repository,scope)=>{
    const id=uuid(params(request).id), query=page(request);
    if(!repository.shares) throw new EntityError(503,'Entity sharing is unavailable.');
    return repository.shares(scope,id,query);
  });
  route('GET','/v1/entities/:id/history','data:read',async(request,repository,scope)=>repository.history(scope,uuid(params(request).id),page(request)));
  route('GET','/v1/entities/:id/events','data:read',async(request,repository,scope)=>{
    const id=uuid(params(request).id),query=page(request);
    if(!repository.events) throw new EntityError(503,'Entity events are unavailable.');
    return repository.events(scope,id,query);
  });
}
