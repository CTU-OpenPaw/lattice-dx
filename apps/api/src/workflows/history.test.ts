/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {test,expect,vi} from 'vitest';
import {generateKeyPair,exportJWK,createLocalJWKSet,SignJWT} from 'jose';
import type {Pool} from 'pg';
import type {WorkflowAudit,WorkflowDefinition,WorkflowRun} from '@dx/contracts';
import {createApi} from '../app.js';
import {pageResult} from '../pagination.js';
import {workflowDatabase} from './database.js';
import {canReadRun,WorkflowError} from './policy.js';
import type {WorkflowRepository} from './types.js';

const actor={subject:'alice',organizationId:'org-a',roles:['employee']};
const definition:WorkflowDefinition={id:'history',version:1,title:'History',startRole:'employee',initialState:'draft',startFields:{},readerRoles:['manager'],transitions:[{id:'revise',from:'draft',to:'draft',role:'employee',fields:{reason:'text',privateNote:'text'}}]};
const run:WorkflowRun={id:'11111111-1111-4111-8111-111111111111',recordId:'11111111-1111-4111-8111-111111111111',definitionId:definition.id,definitionVersion:1,title:'History',ownerId:actor.subject,organizationId:actor.organizationId,state:'draft',version:1,data:{reason:'old data',secret:'never audit'},createdAt:'2026-10-14',updatedAt:'2026-10-14'};
const events:WorkflowAudit[]=Array.from({length:105},(_,i)=>({id:String(i).padStart(4,'0'),actorId:'alice',action:'revise',fromState:'draft',toState:'draft',version:Math.floor(i/2)+1,occurredAt:'2026-10-14T00:00:00.000Z'}));
const {privateKey,publicKey}=await generateKeyPair('RS256');
const key=createLocalJWKSet({keys:[{...await exportJWK(publicKey),kid:'history',alg:'RS256'}]});
async function auth(subject='alice',organizationId='org-a',roles=['employee']) {
 return {authorization:'Bearer '+await new SignJWT({organization_id:organizationId,realm_access:{roles}}).setProtectedHeader({alg:'RS256',kid:'history'}).setSubject(subject).setIssuer('https://identity.test').setAudience('dx-api').setExpirationTime('5m').sign(privateKey)};
}
function routeFixture(paging=true){
 const get=async(_id:string,current:typeof actor)=>{if(!canReadRun(definition,run,current))throw new WorkflowError(404,'hidden');return run;};
 const history=vi.fn(async(id:string,current:typeof actor)=>{await get(id,current);return events.slice(0,100);});
 const historyPage=vi.fn(async(id:string,current:typeof actor,query:{limit:number;offset:number;q:string})=>{await get(id,current);return pageResult(events.slice(query.offset,query.offset+query.limit+1),query);});
 const repository={get,history,...(paging?{historyPage}:{})} as unknown as WorkflowRepository;
 return {app:createApi({workerUrl:'http://localhost:1',identity:{issuer:'https://identity.test',audience:'dx-api',key},workflows:repository}),history,historyPage};
}
test('history keeps legacy envelope and pages explicitly through more than 100 events',async()=>{
 const f=routeFixture();try{
  const headers=await auth(),url=`/v1/workflows/${run.id}/history`;
  const legacy=await f.app.inject({url,headers});expect(legacy.statusCode).toBe(200);expect(legacy.json().page).toBeUndefined();expect(legacy.json().items).toHaveLength(100);
  const middle=await f.app.inject({url:url+'?limit=2&offset=2',headers});expect(middle.statusCode).toBe(200);expect(middle.json()).toEqual({items:events.slice(2,4),page:{limit:2,offset:2,hasMore:true,nextOffset:4}});
  const tail=await f.app.inject({url:url+'?limit=100&offset=100',headers});expect(tail.json()).toEqual({items:events.slice(100),page:{limit:100,offset:100,hasMore:false,nextOffset:null}});
  expect(f.history).toHaveBeenCalledOnce();expect(f.historyPage).toHaveBeenCalledWith(run.id,expect.objectContaining(actor),{limit:2,offset:2,q:''});
 }finally{await f.app.close();}
});
test('history rejects unsupported filters and invalid page bounds before dispatch',async()=>{
 const f=routeFixture();try{
  for(const query of ['q=x','q=','unknown=x','limit=0','limit=101','limit=-1','limit=1.5','offset=-1','offset=9007199254740991','limit=2&limit=3']){
   expect((await f.app.inject({url:`/v1/workflows/${run.id}/history?${query}`,headers:await auth()})).statusCode,query).toBe(400);
  }
  expect(f.history).not.toHaveBeenCalled();expect(f.historyPage).not.toHaveBeenCalled();
 }finally{await f.app.close();}
});
test('history defaults explicit page values and handles repositories without paging',async()=>{
 const f=routeFixture(),legacy=routeFixture(false);try{
  const headers=await auth(),url=`/v1/workflows/${run.id}/history`;
  expect((await f.app.inject({url:url+'?limit=2',headers})).json().page).toEqual({limit:2,offset:0,hasMore:true,nextOffset:2});
  expect((await f.app.inject({url:url+'?offset=100',headers})).json().page).toEqual({limit:50,offset:100,hasMore:false,nextOffset:null});
  expect((await legacy.app.inject({url,headers})).statusCode).toBe(200);
  const unavailable=await legacy.app.inject({url:url+'?limit=2',headers});expect(unavailable.statusCode).toBe(503);expect(unavailable.json().error).toBeTypeOf('string');
 }finally{await f.app.close();await legacy.app.close();}
});
test('both history modes enforce current tenant and read permission',async()=>{
 const f=routeFixture();try{
  for(const query of ['', '?limit=2']){
   const url=`/v1/workflows/${run.id}/history${query}`;
   expect((await f.app.inject({url})).statusCode).toBe(401);
   expect((await f.app.inject({url,headers:await auth('alice','org-b',['manager'])})).statusCode).toBe(404);
   expect((await f.app.inject({url,headers:await auth('outsider')})).statusCode).toBe(404);
  }
 }finally{await f.app.close();}
});
async function databaseFixture(){
 const query=vi.fn(async(sql:string,values?:unknown[])=>({rows:
  sql.includes('FROM workflow_runs WHERE id=')?(values?.[1]===run.organizationId?[run]:[]):
  sql.includes('FROM workflow_audit')?events.slice(Number(values?.[2]??0),Number(values?.[2]??0)+Number(values?.[1]??100)):[],rowCount:0}));
 const pool={query} as unknown as Pool;
 const repo=await workflowDatabase(pool,{get:async()=>definition,list:async()=>[definition]});query.mockClear();return {repo,query};
}
test('history SQL pages after authorization with stable version/id order and parameterized limit plus one',async()=>{
 const {repo,query}=await databaseFixture();expect(repo.historyPage).toBeTypeOf('function');
 const result=await repo.historyPage!(run.id,actor,{limit:2,offset:102,q:''});
 expect(result).toEqual({items:events.slice(102,104),page:{limit:2,offset:102,hasMore:true,nextOffset:104}});
 const calls=query.mock.calls;const audit=calls.find(([sql])=>sql.includes('FROM workflow_audit'))!;
 expect(calls[0][0]).toContain('WHERE id=$1 AND organization_id=$2');expect(calls[0][1]).toEqual([run.id,actor.organizationId]);
 expect(audit[0]).toContain('WHERE run_id=$1 ORDER BY version,id LIMIT $2 OFFSET $3');expect(audit[1]).toEqual([run.id,3,102]);
 const tail=await repo.historyPage!(run.id,actor,{limit:2,offset:104,q:''});expect(tail.page).toEqual({limit:2,offset:104,hasMore:false,nextOffset:null});
 const empty=await repo.historyPage!(run.id,actor,{limit:2,offset:105,q:''});expect(empty.items).toEqual([]);expect(empty.page.nextOffset).toBeNull();
 expect(await repo.history(run.id,actor)).toHaveLength(100);
 expect(query.mock.calls.at(-1)?.[0]).toContain('ORDER BY version LIMIT 100');
});
test('paged history repository denies hidden runs and unsafe bounds without reading audit',async()=>{
 const {repo,query}=await databaseFixture();expect(repo.historyPage).toBeTypeOf('function');
 for(const current of [{...actor,subject:'outsider'},{...actor,organizationId:'org-b',roles:['manager']}]){
  await expect(repo.historyPage!(run.id,current,{limit:2,offset:0,q:''})).rejects.toMatchObject({statusCode:404});
 }
 expect(query.mock.calls.some(([sql])=>sql.includes('FROM workflow_audit'))).toBe(false);query.mockClear();
 for(const page of [{limit:0,offset:0,q:''},{limit:101,offset:0,q:''},{limit:1.5,offset:0,q:''},{limit:2,offset:-1,q:''},{limit:2,offset:Number.MAX_SAFE_INTEGER,q:''},{limit:2,offset:0,q:'unsupported'}]){
  await expect(repo.historyPage!(run.id,actor,page)).rejects.toMatchObject({statusCode:400});
 }
 expect(query).not.toHaveBeenCalled();
});
