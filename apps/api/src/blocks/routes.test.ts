/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {createLocalJWKSet,exportJWK,generateKeyPair,SignJWT} from 'jose';
import {expect,test,vi} from 'vitest';
import {createApi} from '../app.js';
import type {EntityRepository} from '../entities/types.js';
const {publicKey,privateKey}=await generateKeyPair('RS256');
const identity={key:createLocalJWKSet({keys:[{...await exportJWK(publicKey),kid:'blocks',alg:'RS256'}]}),issuer:'https://identity.test',audience:'dx-api'};
async function authorization(roles=['data:read','data:write']){return `Bearer ${await new SignJWT({realm_access:{roles},organization_id:'org-a'}).setProtectedHeader({alg:'RS256',kid:'blocks'}).setSubject('alice').setIssuer(identity.issuer).setAudience(identity.audience).setExpirationTime('5m').sign(privateKey)}`;}
test('catalog and execution enforce signed roles version and strict authority-free input',async()=>{
 const create=vi.fn(async()=>({id:'entity',version:1}));const entities={create} as unknown as EntityRepository;const app=createApi({workerUrl:'http://localhost:1',identity,entities});
 try{
  expect((await app.inject({url:'/v1/blocks'})).statusCode).toBe(401);
  const headers={authorization:await authorization(['data:read'])};const catalog=await app.inject({url:'/v1/blocks',headers});expect(catalog.statusCode).toBe(200);expect(catalog.json().items.map((x:{id:string})=>x.id)).toEqual(['entities.read']);
  expect((await app.inject({method:'POST',url:'/v1/blocks/entities.create/run',headers,payload:{version:1,input:{}}})).statusCode).toBe(403);
  const writeHeaders={authorization:await authorization(),'idempotency-key':'same-key'};const input={schemaId:'invoice',title:'A',attributes:{}};
  for(const payload of [{version:2,input},{version:1,input:{...input,actorId:'bob'}},{version:1,input,code:'x'}])expect((await app.inject({method:'POST',url:'/v1/blocks/entities.create/run',headers:writeHeaders,payload})).statusCode).toBe(400);
  expect((await app.inject({method:'POST',url:'/v1/blocks/entities.create/run',headers:writeHeaders,payload:{version:1,input}})).json()).toEqual({blockId:'entities.create',version:1,status:'succeeded',result:{id:'entity',version:1}});
  expect(create).toHaveBeenCalledWith({actorId:'alice',organizationId:'org-a'},input,'same-key');
  expect((await app.inject({method:'POST',url:'/v1/blocks/arbitrary/run',headers:writeHeaders,payload:{version:1,input}})).statusCode).toBe(404);
 }finally{await app.close();}
});
test('seven descriptors have bounded nested inputs and entity/page outputs and are immutable',async()=>{
 const {blockCatalog}=await import('./registry.js');expect(blockCatalog).toHaveLength(7);expect(Object.isFrozen(blockCatalog)).toBe(true);
 for(const block of blockCatalog){expect(block.inputSchema.additionalProperties).toBe(false);expect(block.outputSchema.additionalProperties).toBe(false);expect(block.outputSchema.required).toBeInstanceOf(Array);expect(Object.isFrozen(block.inputSchema)).toBe(true);}
 const query=blockCatalog.find(block=>block.id==='entities.query')!;expect(query.inputSchema.required).toEqual(['schemaId','schemaVersion']);expect((query.outputSchema.properties as Record<string,unknown>).page).toBeDefined();
});
test('read query and all mutations delegate their strict normalized arguments and unchanged command key',async()=>{
 const id='12345678-1234-1234-1234-123456789abc';const methods={create:vi.fn(async()=>({id,version:1})),find:vi.fn(async()=>({id})),query:vi.fn(async()=>({items:[],page:{limit:50,offset:0,hasMore:false,nextOffset:null}})),update:vi.fn(async()=>({id,version:2})),archive:vi.fn(async()=>({id,version:2})),link:vi.fn(async()=>({id,version:2})),unlink:vi.fn(async()=>({id,version:2}))};
 const app=createApi({workerUrl:'http://localhost:1',identity,entities:methods as unknown as EntityRepository});const headers={authorization:await authorization(),'idempotency-key':'shared-key'};const scope={actorId:'alice',organizationId:'org-a'};
 try{
  const inputs={create:{schemaId:'invoice',title:'A',attributes:{}},read:{id},query:{schemaId:'invoice',schemaVersion:1},update:{id,expectedVersion:1,title:'A',attributes:{}},archive:{id,expectedVersion:1},link:{id,expectedVersion:1,name:'parent',targetId:id},unlink:{id,expectedVersion:1,name:'parent',targetId:id}};
  expect((await app.inject({url:'/v1/blocks',headers})).json().items.map((block:{id:string})=>block.id)).toContain('entities.query');
  for(const [operation,input]of Object.entries(inputs))expect((await app.inject({method:'POST',url:`/v1/blocks/entities.${operation}/run`,headers,payload:{version:1,input}})).statusCode).toBe(200);
  expect(methods.find).toHaveBeenCalledWith(scope,id);expect(methods.query).toHaveBeenCalledWith(scope,{schemaId:'invoice',schemaVersion:1,filters:[],limit:50,offset:0});expect(methods.update).toHaveBeenCalledWith(scope,id,{expectedVersion:1,title:'A',attributes:{}},'shared-key');expect(methods.archive).toHaveBeenCalledWith(scope,id,1,'shared-key');
  for(const operation of ['link','unlink'] as const)expect(methods[operation]).toHaveBeenCalledWith(scope,id,{expectedVersion:1,name:'parent',targetId:id},'shared-key');
  for(const key of [undefined,'bad key',['a','b']])expect((await app.inject({method:'POST',url:'/v1/blocks/entities.create/run',headers:{authorization:headers.authorization,...(key?{'idempotency-key':key}:{})},payload:{version:1,input:inputs.create}})).statusCode).toBe(400);
  expect((await app.inject({method:'POST',url:'/v1/entities/query',headers:{authorization:headers.authorization},payload:inputs.query})).statusCode).toBe(200);
  expect((await app.inject({method:'POST',url:'/v1/entities/query',headers:{authorization:await authorization(['data:write'])},payload:inputs.query})).statusCode).toBe(403);
 }finally{await app.close();}
});
test('missing query capability returns 503 and repository error statuses remain intact',async()=>{
 const {EntityError}=await import('../entities/policy.js');const find=vi.fn(async()=>undefined);const app=createApi({workerUrl:'http://localhost:1',identity,entities:{find} as unknown as EntityRepository});const headers={authorization:await authorization()};
 try{
  for(const url of ['/v1/entities/query','/v1/blocks/entities.query/run'])expect((await app.inject({method:'POST',url,headers,payload:url.includes('blocks')?{version:1,input:{schemaId:'invoice',schemaVersion:1}}:{schemaId:'invoice',schemaVersion:1}})).statusCode).toBe(503);
  for(const statusCode of [400,404,409,503] as const){find.mockRejectedValueOnce(new EntityError(statusCode,'domain'));expect((await app.inject({method:'POST',url:'/v1/blocks/entities.read/run',headers,payload:{version:1,input:{id:'12345678-1234-1234-1234-123456789abc'}}})).statusCode).toBe(statusCode);}
 }finally{await app.close();}
});

test('create block accepts an optional bounded schema publication pin without changing legacy inputs',async()=>{
 const {findBlock,runBlock}=await import('./registry.js');const create=vi.fn(async()=>({id:'entity'}));const repository={create} as unknown as EntityRepository;const scope={actorId:'alice',organizationId:'org-a'};
 const input={schemaId:'invoice',schemaVersion:1,title:'A',attributes:{}};
 await expect(runBlock(findBlock('entities.create')!,repository,scope,input,'pin-key')).resolves.toEqual({id:'entity'});expect(create).toHaveBeenCalledWith(scope,input,'pin-key');
 for(const schemaVersion of [0,2.5,2147483648,'1'])await expect(runBlock(findBlock('entities.create')!,repository,scope,{...input,schemaVersion},'pin-key')).rejects.toThrow();
});
