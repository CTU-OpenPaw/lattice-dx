// SPDX-License-Identifier: Apache-2.0
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { expect, test, vi } from 'vitest';
import { createApi } from '../app.js';
import type { EntityRepository } from './types.js';
import { EntityError } from './policy.js';
const {publicKey,privateKey}=await generateKeyPair('RS256');
const key=createLocalJWKSet({keys:[{...await exportJWK(publicKey),kid:'entity-test',alg:'RS256'}]});
const identity={key,issuer:'https://identity.test',audience:'dx-api'};
async function token(roles=['data:design','data:read','data:write'],organizationId:string|null='org-a') {
  return new SignJWT({realm_access:{roles},...(organizationId?{organization_id:organizationId}:{})})
    .setProtectedHeader({alg:'RS256',kid:'entity-test'}).setSubject('alice').setIssuer(identity.issuer).setAudience(identity.audience).setIssuedAt().setExpirationTime('5m').sign(privateKey);
}
const id='12345678-1234-1234-1234-123456789abc';
function setup() {
  const entities={
    create:vi.fn(async()=>({id,version:1})),
    find:vi.fn(async()=>undefined),
    list:vi.fn(async()=>({items:[],page:{limit:50,offset:0,hasMore:false,nextOffset:null}})),
    update:vi.fn(async()=>({id,version:2})),
    archive:vi.fn(async()=>({id,version:2})),
    link:vi.fn(async()=>({id,version:2})),
    unlink:vi.fn(async()=>({id,version:2})),
    createSchema:vi.fn(async()=>({id:'invoice',revision:1})),
    listSchemas:vi.fn(async()=>({items:[]})),
    getSchema:vi.fn(async()=>undefined),
    getPublishedSchema:vi.fn(async()=>({id:'invoice',version:1,title:'Invoice',fields:{},relations:{}})),
    saveSchema:vi.fn(async()=>({revision:2})),
    publishSchema:vi.fn(async()=>({version:1})),
    relations:vi.fn(async()=>({items:[]})),
    history:vi.fn(async()=>({items:[]})),
  } as unknown as EntityRepository;
  return {app:createApi({workerUrl:'http://localhost:1',identity,entities}),entities};
}

test('all entity endpoints require signed capability and signed tenant',async()=>{
  const {app}=setup();
  try {
    expect((await app.inject({url:'/v1/entities'})).statusCode).toBe(401);
    expect((await app.inject({url:'/v1/entities',headers:{authorization:`Bearer ${await token([])}`}})).statusCode).toBe(403);
    expect((await app.inject({url:'/v1/entities',headers:{authorization:`Bearer ${await token(['data:read'],null)}`}})).statusCode).toBe(403);
    expect((await app.inject({url:'/v1/entity-schemas',headers:{authorization:`Bearer ${await token(['data:read'])}`}})).statusCode).toBe(403);
  } finally {await app.close();}
});

test('domain errors map to their status and malformed or repeated command headers reject before storage',async()=>{
  const {app,entities}=setup();
  const authorization=`Bearer ${await token()}`;
  const payload={schemaId:'invoice',title:'Invoice',attributes:{}};
  try {
    for(const key of ['bad key','x'.repeat(129)]) {
      expect((await app.inject({method:'POST',url:'/v1/entities',headers:{authorization,'idempotency-key':key},payload})).statusCode).toBe(400);
    }
    expect((await app.inject({method:'POST',url:'/v1/entities',headers:{authorization,'idempotency-key':['one','two']},payload})).statusCode).toBe(400);
    expect(entities.create).not.toHaveBeenCalled();
    for(const statusCode of [400,404,409,503] as const) {
      vi.mocked(entities.create).mockRejectedValueOnce(new EntityError(statusCode,'domain failure'));
      const response=await app.inject({method:'POST',url:'/v1/entities',headers:{authorization,'idempotency-key':'valid'},payload});
      expect(response.statusCode).toBe(statusCode);
      expect(response.json()).toEqual({error:'domain failure'});
    }
  } finally {await app.close();}
});

test('each mutation and history route rejects a signed token without its capability',async()=>{
  const {app}=setup();
  const headers={authorization:`Bearer ${await token([])}`};
  const endpoints=[
    {method:'POST',url:'/v1/entities'},
    {method:'PATCH',url:`/v1/entities/${id}`},
    {method:'POST',url:`/v1/entities/${id}/archive`},
    {method:'POST',url:`/v1/entities/${id}/relations`},
    {method:'DELETE',url:`/v1/entities/${id}/relations/parent/${id}`},
    {method:'GET',url:`/v1/entities/${id}/relations`},
    {method:'GET',url:`/v1/entities/${id}/history`},
    {method:'POST',url:'/v1/entity-schemas'},
    {method:'PUT',url:'/v1/entity-schemas/invoice'},
    {method:'POST',url:'/v1/entity-schemas/invoice/publish'},
  ] as const;
  try {for(const endpoint of endpoints) expect((await app.inject({...endpoint,headers})).statusCode).toBe(403);}
  finally {await app.close();}
});

test('Fastify query objects support valid paging and filters on all paged endpoints',async()=>{
  const {app,entities}=setup();
  const headers={authorization:`Bearer ${await token()}`};
  try {
    for(const url of [
      '/v1/entities?limit=1&offset=2&q=Invoice&schemaId=invoice',
      '/v1/entity-schemas?limit=1&offset=2&q=Invoice',
      `/v1/entities/${id}/relations?limit=1&offset=2&q=parent`,
      `/v1/entities/${id}/history?limit=1&offset=2&q=entity`,
    ]) expect((await app.inject({url,headers})).statusCode).toBe(200);
    expect(entities.list).toHaveBeenCalledWith({actorId:'alice',organizationId:'org-a'},{limit:1,offset:2,q:'Invoice',schemaId:'invoice'});
    expect(entities.relations).toHaveBeenCalledWith({actorId:'alice',organizationId:'org-a'},id,{limit:1,offset:2,q:'parent'});
  } finally {await app.close();}
});
test('entity create requires command key and rejects authority and unknown inputs',async()=>{
  const {app,entities}=setup();
  const authorization=`Bearer ${await token()}`;
  const payload={schemaId:'invoice',title:' Invoice ',attributes:{count:2,amount:'0.0100'}};
  try {
    expect((await app.inject({method:'POST',url:'/v1/entities',headers:{authorization},payload})).statusCode).toBe(400);
    expect((await app.inject({method:'POST',url:'/v1/entities',headers:{authorization,'idempotency-key':'create-1'},payload:{...payload,ownerId:'bob'}})).statusCode).toBe(400);
    const created=await app.inject({method:'POST',url:'/v1/entities',headers:{authorization,'idempotency-key':'create-1'},payload});
    expect(created.statusCode).toBe(201);
    expect(entities.create).toHaveBeenCalledWith({actorId:'alice',organizationId:'org-a'},{...payload,title:'Invoice'},'create-1');
  } finally {await app.close();}
});
test('updates relations archive and schema save validate strict bodies paths and paging',async()=>{
  const {app,entities}=setup();
  const headers={authorization:`Bearer ${await token()}`,'idempotency-key':'command-1'};
  try {
    for(const payload of [{expectedVersion:0,title:'A',attributes:{}},{expectedVersion:1,title:'A',attributes:{},version:9},{expectedVersion:'1',title:'A',attributes:{}}]) {
      expect((await app.inject({method:'PATCH',url:`/v1/entities/${id}`,headers,payload})).statusCode).toBe(400);
    }
    expect((await app.inject({method:'PATCH',url:`/v1/entities/${id}`,headers,payload:{expectedVersion:1,title:'A',attributes:{}}})).statusCode).toBe(200);
    expect(entities.update).toHaveBeenCalledWith({actorId:'alice',organizationId:'org-a'},id,{expectedVersion:1,title:'A',attributes:{}},'command-1');
    expect((await app.inject({url:'/v1/entities/no-id',headers})).statusCode).toBe(400);
    expect((await app.inject({url:'/v1/entities?ownerId=bob',headers})).statusCode).toBe(400);
    expect((await app.inject({url:'/v1/entities?limit=0',headers})).statusCode).toBe(400);
    expect((await app.inject({url:'/v1/entities?schemaId=bad/id',headers})).statusCode).toBe(400);
    expect((await app.inject({url:`/v1/entities/${id}`,headers})).statusCode).toBe(404);
    expect((await app.inject({method:'POST',url:`/v1/entities/${id}/archive`,headers,payload:{expectedVersion:1,hardDelete:true}})).statusCode).toBe(400);
    expect((await app.inject({method:'DELETE',url:`/v1/entities/${id}/relations/parent/${id}`,headers,payload:{expectedVersion:2}})).statusCode).toBe(200);
    expect(entities.unlink).toHaveBeenCalledWith({actorId:'alice',organizationId:'org-a'},id,{name:'parent',targetId:id,expectedVersion:2},'command-1');
    expect((await app.inject({method:'PUT',url:'/v1/entity-schemas/invoice',headers,payload:{expectedRevision:1,title:'Invoice',fields:{},organizationId:'other'}})).statusCode).toBe(400);
  } finally {await app.close();}
});
test('entity repository absence is explicit unavailable',async()=>{
  const app=createApi({workerUrl:'http://localhost:1',identity});
  try {expect((await app.inject({url:'/v1/entities',headers:{authorization:`Bearer ${await token()}`}})).statusCode).toBe(503);}
  finally {await app.close();}
});

test('readers fetch pinned published schemas without receiving draft designer authority',async()=>{
  const {app,entities}=setup();
  const headers={authorization:`Bearer ${await token(['data:read'],'org-b')}`};
  try {
    const published=await app.inject({url:'/v1/entity-schemas/invoice/versions/1',headers});
    expect(published.statusCode).toBe(200);
    expect(published.json()).toMatchObject({version:1});
    expect(entities.getPublishedSchema).toHaveBeenCalledWith({actorId:'alice',organizationId:'org-b'},'invoice',1);
    expect((await app.inject({url:'/v1/entity-schemas/invoice',headers})).statusCode).toBe(403);
    for(const value of ['0','-1','1.1','2147483648','abc']) expect((await app.inject({url:`/v1/entity-schemas/invoice/versions/${value}`,headers})).statusCode).toBe(400);
    expect((await app.inject({url:'/v1/entity-schemas/invoice/versions/1',headers:{authorization:`Bearer ${await token(['data:design'])}`}})).statusCode).toBe(403);
  } finally {await app.close();}
});
test('sharing routes require data:share and fail safely when old repository has no sharing',async()=>{
 const {app}=setup();
 try {
  for(const method of ['GET','POST','DELETE'] as const){
   const url=`/v1/entities/${id}/shares${method==='DELETE'?'/person/bob':''}`;
   expect((await app.inject({method,url,headers:{authorization:`Bearer ${await token(['data:read','data:write'])}`},...(method==='GET'?{}:{payload:method==='POST'?{expectedVersion:1,principal:{kind:'person',id:'bob'},permission:'read'}:{expectedVersion:1}})})).statusCode).toBe(403);
   expect((await app.inject({method,url,headers:{authorization:`Bearer ${await token(['data:share'])}`,'idempotency-key':'share'},...(method==='GET'?{}:{payload:method==='POST'?{expectedVersion:1,principal:{kind:'person',id:'bob'},permission:'read'}:{expectedVersion:1}})})).statusCode).toBe(503);
  }
 }finally{await app.close();}
});

test('sharing routes forward strict signed scope and typed payload and reject principal overrides',async()=>{
 const {app,entities}=setup();entities.share=vi.fn(async()=>({id,version:2})) as unknown as EntityRepository['share'];entities.revokeShare=vi.fn(async()=>({id,version:3})) as unknown as EntityRepository['revokeShare'];entities.shares=vi.fn(async()=>({items:[],page:{limit:50,offset:0,hasMore:false,nextOffset:null}}));
 const headers={authorization:`Bearer ${await token(['data:share'])}`,'idempotency-key':'share-command'};
 const payload={expectedVersion:1,principal:{kind:'department',id:'sales'},permission:'edit'};
 try{
  expect((await app.inject({method:'POST',url:`/v1/entities/${id}/shares`,headers,payload})).statusCode).toBe(200);
  expect(entities.share).toHaveBeenCalledWith({actorId:'alice',organizationId:'org-a'},id,payload,'share-command');
  for(const invalid of [{...payload,organizationId:'org-b'},{...payload,principal:{...payload.principal,role:'data:write'}},{...payload,permission:'owner'},{...payload,principal:{kind:'person',id:'constructor'}},{...payload,expectedVersion:'1'}]){
   expect((await app.inject({method:'POST',url:`/v1/entities/${id}/shares`,headers,payload:invalid})).statusCode).toBe(400);
  }
  expect((await app.inject({method:'DELETE',url:`/v1/entities/${id}/shares/person/bob`,headers,payload:{expectedVersion:2}})).statusCode).toBe(200);
  expect(entities.revokeShare).toHaveBeenCalledWith({actorId:'alice',organizationId:'org-a'},id,{expectedVersion:2,kind:'person',principalId:'bob'},'share-command');
  expect((await app.inject({url:`/v1/entities/${id}/shares`,headers})).statusCode).toBe(200);
 }finally{await app.close();}
});
