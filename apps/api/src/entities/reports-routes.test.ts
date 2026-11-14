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
import type {ReportsRepository} from './reports-types.js';
const {publicKey,privateKey}=await generateKeyPair('RS256');
const identity={key:createLocalJWKSet({keys:[{...await exportJWK(publicKey),kid:'reports',alg:'RS256'}]}),issuer:'https://identity.test',audience:'dx-api'};
async function token(roles=['data:read']){return new SignJWT({realm_access:{roles},organization_id:'org'}).setProtectedHeader({alg:'RS256',kid:'reports'}).setSubject('reader').setIssuer(identity.issuer).setAudience(identity.audience).setIssuedAt().setExpirationTime('5m').sign(privateKey);}
test('report create returns 201 and enforces signed read scope, key and exact input',async()=>{
 const create=vi.fn(async()=>({id:'snapshot',version:1})),app=createApi({workerUrl:'http://localhost:1',identity,reports:{create} as unknown as ReportsRepository});
 const url='/v1/entity-report-snapshots',payload={title:'Report',query:{schemaId:'invoice',schemaVersion:1,metrics:[{name:'count',operation:'count'}]}};
 try{
  expect((await app.inject({method:'POST',url,payload})).statusCode).toBe(401);
  expect((await app.inject({method:'POST',url,payload,headers:{authorization:`Bearer ${await token(['data:write'])}`,'idempotency-key':'report'}})).statusCode).toBe(403);
  const headers={authorization:`Bearer ${await token()}`,'idempotency-key':'report'};
  expect((await app.inject({method:'POST',url,payload,headers})).statusCode).toBe(201);
  expect(create).toHaveBeenCalledWith({actorId:'reader',organizationId:'org'},expect.objectContaining({title:'Report'}),'report');
  expect((await app.inject({method:'POST',url,payload,headers:{authorization:headers.authorization}})).statusCode).toBe(400);
  expect((await app.inject({method:'POST',url,payload:{...payload,result:{}},headers})).statusCode).toBe(400);
  expect((await app.inject({method:'POST',url:url+'?ownerId=other',payload,headers})).statusCode).toBe(400);
 }finally{await app.close();}
});
