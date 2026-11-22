/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { test,expect } from 'vitest';
import { generateKeyPair,exportJWK,createLocalJWKSet,SignJWT } from 'jose';
import { createApi } from './app';
import type { WorkflowRepository } from './workflows/types';
import type { WorkflowRun } from '@dx/contracts';
const {privateKey,publicKey}=await generateKeyPair('RS256');
const key=createLocalJWKSet({keys:[{...await exportJWK(publicKey),kid:'logistics',alg:'RS256'}]});
async function headers(roles=['logistics:sales','workflow:start']){return {authorization:'Bearer '+await new SignJWT({organization_id:'org-a',realm_access:{roles}}).setProtectedHeader({alg:'RS256',kid:'logistics'}).setSubject('sales').setIssuer('https://identity.test').setAudience('dx-api').setExpirationTime('5m').sign(privateKey),'idempotency-key':'order-1'};}
const run:WorkflowRun={id:'11111111-1111-4111-8111-111111111111',recordId:'11111111-1111-4111-8111-111111111111',definitionId:'logistics_order',definitionVersion:1,title:'Order',ownerId:'sales',organizationId:'org-a',state:'draft',version:1,data:{quantity:'2',warehouseAssigneeId:'warehouse'},createdAt:'2026-10-13T00:00:00Z',updatedAt:'2026-10-13T00:00:00Z'};
function setup(){let writes=0;const repo:WorkflowRepository={async create(value){writes++;return {...run,title:value.title,data:value.input};},async get(){return run;},async transition(_id,command){writes++;return {...run,state:command.action==='submit'?'submitted':'received',version:2,taskId:'task-id'};},async list(){return [run];},async history(){return [];},async jobs(){return [];},async retryJobs(){return 0;},async registerMember(){},async references(){return [];},async readSharedFile(){return undefined;}};return {app:createApi({workerUrl:'http://localhost:1',identity:{issuer:'https://identity.test',audience:'dx-api',key},workflows:repo}),writes:()=>writes};}
const payload={title:'Order',customerName:'CTU',deliveryAddress:'Can Tho',sku:'BOX',quantity:2,warehouseAssigneeId:'warehouse'};
test('order facade creates through shared workflow and returns numeric quantity',async()=>{
  const {app,writes}=setup();try{const response=await app.inject({method:'POST',url:'/v1/logistics/orders',headers:await headers(),payload});expect(response.statusCode).toBe(201);expect(response.json().quantity).toBe(2);expect(response.json().id).toBe(run.id);expect(writes()).toBe(1);}finally{await app.close();}
});
test('order facade refuses malformed numbers, identity override and missing role/key',async()=>{
  const {app,writes}=setup();try{
    for(const extra of [{quantity:0},{quantity:'2'},{quantity:1.5},{organizationId:'org-b'},{warehouseAssigneeId:''}])expect((await app.inject({method:'POST',url:'/v1/logistics/orders',headers:await headers(),payload:{...payload,...extra}})).statusCode).toBe(400);
    expect((await app.inject({method:'POST',url:'/v1/logistics/orders',headers:await headers([]),payload})).statusCode).toBe(403);
    expect((await app.inject({method:'POST',url:'/v1/logistics/orders',headers:{authorization:(await headers()).authorization},payload})).statusCode).toBe(400);
    expect(writes()).toBe(0);
  }finally{await app.close();}
});
test('order facade hides other definitions and validates command boundaries',async()=>{
  const {app,writes}=setup();try{
    expect((await app.inject({method:'POST',url:`/v1/logistics/orders/${run.id}/submit`,headers:await headers(),payload:{expectedVersion:1}})).statusCode).toBe(200);
    expect((await app.inject({method:'POST',url:`/v1/logistics/orders/${run.id}/receive`,headers:await headers(),payload:{expectedVersion:2}})).statusCode).toBe(400);
    expect((await app.inject({url:'/v1/logistics/orders/not-uuid',headers:await headers()})).statusCode).toBe(400);
    expect(writes()).toBe(1);
  }finally{await app.close();}
});
