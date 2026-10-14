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
