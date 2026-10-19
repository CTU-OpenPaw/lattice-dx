// SPDX-License-Identifier: Apache-2.0
import { expect, test, vi } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createApi } from '../app.js';
import type { EntityDataToolsRepository } from './data-tools-types.js';
const {publicKey,privateKey}=await generateKeyPair('RS256');
const identity={key:createLocalJWKSet({keys:[{...await exportJWK(publicKey),kid:'tools',alg:'RS256'}]}),issuer:'https://identity.test',audience:'dx-api'};
async function token(roles:string[]){return new SignJWT({realm_access:{roles},organization_id:'org-a'}).setProtectedHeader({alg:'RS256',kid:'tools'}).setSubject('alice').setIssuer(identity.issuer).setAudience(identity.audience).setExpirationTime('5m').sign(privateKey);}
const id='11111111-1111-1111-1111-111111111111',fileId='22222222-2222-2222-2222-222222222222';
test('attachment endpoints enforce signed capabilities, strict body and mandatory key',async()=>{
 const attach=vi.fn(async()=>({id,version:2}));const app=createApi({workerUrl:'http://localhost:1',identity,dataTools:{attach} as unknown as EntityDataToolsRepository});
 try {
  const url=`/v1/entities/${id}/attachments`,payload={fileId,expectedVersion:1};
  expect((await app.inject({method:'POST',url,payload})).statusCode).toBe(401);
  const headers={authorization:`Bearer ${await token(['data:write'])}`};
  expect((await app.inject({method:'POST',url,headers,payload})).statusCode).toBe(400);
  expect((await app.inject({method:'POST',url,headers:{...headers,'idempotency-key':'key'},payload:{...payload,scanStatus:'clean'}})).statusCode).toBe(400);
  expect((await app.inject({method:'POST',url,headers:{...headers,'idempotency-key':'key'},payload})).statusCode).toBe(200);
  expect(attach).toHaveBeenCalledOnce();expect(attach).toHaveBeenCalledWith({actorId:'alice',organizationId:'org-a'},id,payload,'key');
  expect((await app.inject({url:`${url}/${fileId}/content`,headers:{authorization:`Bearer ${await token(['data:read'])}`}})).statusCode).toBe(403);
 }finally{await app.close();}
});

test('import/export/migration routes validate strict bodies, pins, keys and signed roles',async()=>{
 const importDryRun=vi.fn(async()=>({valid:true,digest:'a'.repeat(64)})),importCommit=vi.fn(async()=>({entityIds:[id]})),exportRows=vi.fn(async()=>({format:'json',content:'[]',page:{}})),migrationDryRun=vi.fn(async()=>({valid:true})),migrationCommit=vi.fn(async()=>({id,schemaVersion:2}));
 const dataTools={importDryRun,importCommit,export:exportRows,migrationDryRun,migrationCommit} as unknown as EntityDataToolsRepository;
 const app=createApi({workerUrl:'http://localhost:1',identity,dataTools});
 try{
  const headers={authorization:`Bearer ${await token(['data:write','data:read'])}`,'idempotency-key':'key'};
  const input={schemaId:'invoice',schemaVersion:1,format:'json',content:'[{"title":"A","attributes":{}}]'};
  expect((await app.inject({method:'POST',url:'/v1/entity-imports/dry-run',headers,payload:input})).statusCode).toBe(200);
  expect((await app.inject({method:'POST',url:'/v1/entity-imports/commit',headers,payload:{...input,expectedDigest:'a'.repeat(64)}})).statusCode).toBe(200);
  expect((await app.inject({method:'POST',url:'/v1/entity-imports/commit',headers:{authorization:headers.authorization},payload:{...input,expectedDigest:'a'.repeat(64)}})).statusCode).toBe(400);
  expect((await app.inject({method:'POST',url:'/v1/entity-imports/dry-run',headers,payload:{...input,schemaVersion:'1'}})).statusCode).toBe(400);
  expect((await app.inject({method:'POST',url:'/v1/entity-imports/dry-run',headers,payload:{...input,content:'x'.repeat(262145)}})).statusCode).toBe(400);
  expect((await app.inject({method:'POST',url:'/v1/entities/export',headers,payload:{query:{schemaId:'invoice',schemaVersion:1,limit:100},format:'csv'}})).statusCode).toBe(200);
  expect((await app.inject({method:'POST',url:'/v1/entities/export',headers,payload:{query:{schemaId:'invoice',schemaVersion:1,limit:101},format:'csv'}})).statusCode).toBe(400);
  const migration={expectedVersion:1,targetSchemaVersion:2,attributes:{}};
  expect((await app.inject({method:'POST',url:`/v1/entities/${id}/migration/dry-run`,headers,payload:migration})).statusCode).toBe(200);
  expect((await app.inject({method:'POST',url:`/v1/entities/${id}/migration/commit`,headers,payload:{...migration,expectedDigest:'b'.repeat(64)}})).statusCode).toBe(200);
  expect((await app.inject({method:'POST',url:`/v1/entities/${id}/migration/dry-run`,headers,payload:{...migration,ownerId:'bob'}})).statusCode).toBe(400);
  expect((await app.inject({method:'POST',url:'/v1/entity-imports/dry-run',headers:{authorization:`Bearer ${await token(['data:read'])}`},payload:input})).statusCode).toBe(403);
 }finally{await app.close();}
});
