// SPDX-License-Identifier: Apache-2.0
import { test,expect } from 'vitest';
import { generateKeyPair,exportJWK,createLocalJWKSet,SignJWT } from 'jose';
import { createApi } from '../app';
import { getDefinition } from '../../../../solutions/workflows/definitions';
import { canReadRun, planTransition, WorkflowError } from './policy';
import type { WorkflowRepository } from './types';
import type { WorkflowRun } from '@dx/contracts';
const {privateKey,publicKey}=await generateKeyPair('RS256');
const key=createLocalJWKSet({keys:[{...await exportJWK(publicKey),kid:'workflow',alg:'RS256'}]});
const run:WorkflowRun={id:'11111111-1111-4111-8111-111111111111',recordId:'11111111-1111-4111-8111-111111111111',definitionId:'procurement',definitionVersion:1,title:'Laptop',state:'draft',version:1,ownerId:'alice',organizationId:'org-a',data:{},createdAt:'2026-10-12T00:00:00Z',updatedAt:'2026-10-12T00:00:00Z'};
async function auth(roles=['employee','workflow:start'],subject='alice',organizationId:string|undefined='org-a') {
  return {authorization:'Bearer '+await new SignJWT({realm_access:{roles},...(organizationId?{organization_id:organizationId}:{})}).setProtectedHeader({alg:'RS256',kid:'workflow'}).setSubject(subject).setIssuer('https://identity.test').setAudience('dx-api').setExpirationTime('5m').sign(privateKey)};
}
function setup(configured=true){
  let writes=0;
  const repository:WorkflowRepository={
    async create(){writes++;return run;},
    async transition(_id,input,actor){const result=planTransition(getDefinition('procurement',1)!,run,actor,input);writes++;return {...run,state:result.transition.to,version:2};},
    async get(_id,actor){if(!canReadRun(getDefinition('procurement',1)!,run,actor))throw new WorkflowError(404,'hidden');return run;},
    async list(){return [run];},async history(){return [];},async jobs(){return [];},async retryJobs(){return 0;},
    async registerMember(){writes++;},async references(){return [];},async readSharedFile(){return undefined;},
  };
  const options={workerUrl:'http://localhost:1',identity:{issuer:'https://identity.test',audience:'dx-api',key},workflows:configured?repository:undefined};
  return {app:createApi(options),writes:()=>writes};
}
test('authenticated creation returns backing record and role-filtered catalog',async()=>{
  const {app}=setup();try{
    const headers={...await auth(),'idempotency-key':'create-1'};
    const r=await app.inject({method:'POST',url:'/v1/workflows',headers,payload:{definitionId:'procurement',title:'Laptop',input:{}}});
    expect(r.statusCode).toBe(201);expect(r.json().recordId).toBe(run.id);
    const c=await app.inject({url:'/v1/workflow-definitions',headers});expect(c.statusCode).toBe(200);expect(c.json().items.map((x:{id:string})=>x.id)).toEqual(['procurement']);
  }finally{await app.close();}
});
test('auth, signed organization and dependency required before writes',async()=>{
  const {app,writes}=setup();try{
    expect((await app.inject({url:'/v1/workflows'})).statusCode).toBe(401);
    expect((await app.inject({url:'/v1/workflows',headers:await auth([], 'alice', '')})).statusCode).toBe(403);
    expect(writes()).toBe(0);
  }finally{await app.close();}
  const unconfigured=setup(false);try{expect((await unconfigured.app.inject({url:'/v1/workflows',headers:await auth()})).statusCode).toBe(503);}finally{await unconfigured.app.close();}
});
test('bad keys, scope override and wrong creator role do not write',async()=>{
  const {app,writes}=setup();try{
    const payload={definitionId:'procurement',title:'Laptop',input:{}};
    expect((await app.inject({method:'POST',url:'/v1/workflows',headers:await auth(),payload})).statusCode).toBe(400);
    expect((await app.inject({method:'POST',url:'/v1/workflows',headers:{...await auth(),'idempotency-key':'a'},payload:{...payload,organizationId:'org-b'}})).statusCode).toBe(400);
    expect((await app.inject({method:'POST',url:'/v1/workflows',headers:{...await auth([]),'idempotency-key':'a'},payload})).statusCode).toBe(403);
    expect(writes()).toBe(0);
  }finally{await app.close();}
});
test('transition validates command, UUID and actor and returns available actions',async()=>{
  const {app,writes}=setup();try{
    const headers={...await auth(),'idempotency-key':'submit-1'};
    expect((await app.inject({method:'POST',url:`/v1/workflows/${run.id}/transitions`,headers,payload:{action:'submit',expectedVersion:1,input:{}}})).statusCode).toBe(200);
    expect((await app.inject({method:'POST',url:'/v1/workflows/bad/transitions',headers,payload:{action:'submit',expectedVersion:1,input:{}}})).statusCode).toBe(400);
    expect((await app.inject({method:'POST',url:`/v1/workflows/${run.id}/transitions`,headers,payload:{action:'submit',expectedVersion:0,input:{}}})).statusCode).toBe(400);
    expect((await app.inject({method:'POST',url:`/v1/workflows/${run.id}/transitions`,headers:{...await auth(['employee'],'other'),'idempotency-key':'other'},payload:{action:'submit',expectedVersion:1,input:{}}})).statusCode).toBe(403);
    expect(writes()).toBe(1);
    const detail=await app.inject({url:`/v1/workflows/${run.id}`,headers});expect(detail.json().availableTransitions.map((x:{id:string})=>x.id)).toEqual(['submit']);
    expect((await app.inject({url:`/v1/workflows/${run.id}`,headers:await auth(['procurement:manager'],'manager','org-b')})).statusCode).toBe(404);
  }finally{await app.close();}
});
test('self registration uses signed actor and rejects body identifiers',async()=>{
  const {app,writes}=setup();try{
    const headers=await auth();
    expect((await app.inject({method:'POST',url:'/v1/workflow-members/me',headers,payload:{subject:'other'}})).statusCode).toBe(400);
    expect((await app.inject({method:'POST',url:'/v1/workflow-members/me',headers,payload:{}})).statusCode).toBe(200);expect(writes()).toBe(1);
  }finally{await app.close();}
});
test('manual sync retry requires an idempotency key',async()=>{
  const {app}=setup();try{
    expect((await app.inject({method:'POST',url:`/v1/workflows/${run.id}/sync/retry`,headers:await auth(['workflow:sync']),payload:{}})).statusCode).toBe(400);
  }finally{await app.close();}
});

test('block catalogue requires signed organization and filters each action by caller role',async()=>{
  const {app}=setup();try{
    expect((await app.inject({url:'/v1/workflow-blocks'})).statusCode).toBe(401);
    expect((await app.inject({url:'/v1/workflow-blocks',headers:await auth(['tasks:assign'],'alice','')})).statusCode).toBe(403);
    const result=await app.inject({url:'/v1/workflow-blocks',headers:await auth(['tasks:assign'])});
    expect(result.statusCode).toBe(200);expect(result.json().items.map((item:{id:string})=>item.id)).toEqual(['tasks.create']);
    expect((await app.inject({url:'/v1/workflow-blocks',headers:await auth([])})).json().items).toEqual([]);
      const entityItems=(await app.inject({url:'/v1/workflow-blocks',headers:await auth(['data:read','data:write'])})).json().items;
      expect(entityItems.map((item:{id:string})=>item.id)).toEqual(['entities.create','entities.project','data.evaluate','data.assert','entities.read','entities.query','entities.update','entities.archive','entities.link','entities.unlink']);
      expect(entityItems.every((item:{input:unknown;output:unknown})=>item.input&&item.output)).toBe(true);
  }finally{await app.close();}
});
test('execution history authorizes run access and returns bounded page even for legacy fixture',async()=>{
  const {app}=setup();try{
    expect((await app.inject({url:`/v1/workflows/${run.id}/executions`,headers:await auth([], 'outsider')})).statusCode).toBe(404);
    const result=await app.inject({url:`/v1/workflows/${run.id}/executions?limit=2&offset=3`,headers:await auth()});
    expect(result.statusCode).toBe(200);expect(result.json()).toEqual({items:[],page:{limit:2,offset:3,hasMore:false,nextOffset:null}});
    expect((await app.inject({url:`/v1/workflows/${run.id}/executions?limit=101`,headers:await auth()})).statusCode).toBe(400);
  }finally{await app.close();}
});

test('lifecycle routes validate roles, body, key and UUID before optional repository dispatch',async()=>{
 const {app}=setup();try{
  const good={...await auth(['employee','workflow:start','tasks:assign']),'idempotency-key':'cancel'};
  const url=`/v1/workflows/${run.id}/cancel`,payload={expectedVersion:1,reason:'Stop'};
  expect((await app.inject({method:'POST',url,headers:await auth(['workflow:start']),payload})).statusCode).toBe(400);
  expect((await app.inject({method:'POST',url,headers:{...await auth(['manager']),'idempotency-key':'x'},payload})).statusCode).toBe(403);
  for(const reason of ['', ' ', '🧩'.repeat(501)])expect((await app.inject({method:'POST',url,headers:good,payload:{...payload,reason}})).statusCode).toBe(400);
  expect((await app.inject({method:'POST',url,headers:good,payload:{...payload,organizationId:'other'}})).statusCode).toBe(400);
  expect((await app.inject({method:'POST',url:`/v1/workflows/${run.id}/task-transfer`,headers:good,payload:{taskId:run.id,expectedVersion:1,assigneeId:'bob',reason:'Handoff'}})).statusCode).toBe(503);
 }finally{await app.close();}
});
test('context navigation requires signed entity role and strict query',async()=>{
 const {app}=setup();try{
  expect((await app.inject({url:`/v1/workflows/${run.id}/entity-context`,headers:await auth()})).statusCode).toBe(403);
  expect((await app.inject({url:`/v1/entities/${run.id}/workflows`,headers:await auth()})).statusCode).toBe(403);
  expect((await app.inject({url:`/v1/entities/${run.id}/workflows?unknown=x`,headers:await auth(['data:read'])})).statusCode).toBe(400);
 }finally{await app.close();}
});
