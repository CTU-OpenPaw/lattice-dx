/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {expect,test} from 'vitest';
import {createApi} from '../app.js';
import {generateKeyPair,SignJWT,createLocalJWKSet,exportJWK} from 'jose';
import type {TaskLifecycleRepository} from './types.js';
const {privateKey,publicKey}=await generateKeyPair('RS256');
const identity={issuer:'https://identity.test',audience:'dx-api',key:createLocalJWKSet({keys:[{...await exportJWK(publicKey),kid:'tasks',alg:'RS256'}]})};
async function headers(roles=['tasks:assign']){return {authorization:'Bearer '+await new SignJWT({organization_id:'org-a',realm_access:{roles}}).setSubject('alice').setProtectedHeader({alg:'RS256',kid:'tasks'}).setIssuer(identity.issuer).setAudience(identity.audience).setExpirationTime('5m').sign(privateKey)};}
const id='11111111-1111-4111-8111-111111111111';
test('unconfigured lifecycle routes fail closed',async()=>{const app=createApi({workerUrl:'http://localhost:1'});try{expect((await app.inject({url:'/v1/task-queues'})).statusCode).toBe(503);}finally{await app.close();}});
test('signed lifecycle routes enforce roles, key, strict payload and normalized dispatch',async()=>{
 let calls=0;
 const repo={claim:async(taskId:string,actor:unknown,input:unknown,key:string)=>{calls++;expect(taskId).toBe(id);expect(actor).toEqual({subject:'alice',organizationId:'org-a'});expect(input).toEqual({expectedVersion:1});expect(key).toBe('command-1');return {id,version:2};}} as unknown as TaskLifecycleRepository;
 const app=createApi({workerUrl:'http://localhost:1',identity,taskLifecycle:repo});
 try{
  const url=`/v1/tasks/${id}/claim`,payload={expectedVersion:1};
  expect((await app.inject({method:'POST',url,payload})).statusCode).toBe(401);
  expect((await app.inject({method:'POST',url,payload,headers:await headers(['tasks:read'])})).statusCode).toBe(403);
  expect((await app.inject({method:'POST',url,payload,headers:await headers()})).statusCode).toBe(400);
  const h={...await headers(),'idempotency-key':'command-1'};
  expect((await app.inject({method:'POST',url,payload:{...payload,organizationId:'org-b'},headers:h})).statusCode).toBe(400);
  expect((await app.inject({method:'POST',url,payload,headers:h})).statusCode).toBe(200);expect(calls).toBe(1);
 }finally{await app.close();}
});
