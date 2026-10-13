// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const base='http://localhost:8080',actors={};
for(const username of ['alice','bob','warehouse','it-demo']) {
  const r=await fetch('http://localhost:8081/realms/lattice/protocol/openid-connect/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'password',client_id:'dx-local',username,password:`local-${username}-password`}),signal:AbortSignal.timeout(15000)});
  assert.equal(r.status,200,`Login ${username}`);
  actors[username]=(await r.json()).access_token;
}
async function call(path,method='GET',body,expected=200,actor='alice',key=randomUUID()) {
  const r=await fetch(base+path,{method,headers:{authorization:`Bearer ${actors[actor]}`,'content-type':'application/json','Idempotency-Key':key},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});
  const result=await r.json();
  assert.equal(r.status,expected,`${actor} ${method} ${path}: ${JSON.stringify(result)}`);
  return result;
}
const id='studio-'+randomUUID().replaceAll('-','');
const definition={id,title:'HR → IT configurable demo',startRole:'employee',initialState:'draft',startFields:{employeeName:'text'},readerRoles:['department:it'],transitions:[
  {id:'submit',from:'draft',to:'submitted',role:'employee',ownerOnly:true,fields:{}},
  {id:'provision',from:'submitted',to:'completed',role:'department:it',fields:{accountRef:'text'},eventType:'employee.onboarded'},
]};
const draft=await call('/v1/workflow-drafts','POST',{definition},201);
assert.equal(draft.id,id);assert.equal(draft.revision,1);
await call(`/v1/workflow-drafts/${id}`,'GET',undefined,403,'warehouse');
// Bob has no designer role: authority is denied before looking up tenant data.
await call(`/v1/workflow-drafts/${id}`,'GET',undefined,403,'bob');
await call('/v1/workflow-drafts','POST',{definition:{...definition,id:'procurement'}},400);
await call('/v1/workflow-drafts','POST',{definition:{...definition,id:id+'-bad',transitions:[...definition.transitions,{id:'lost',from:'unreachable',to:'done',role:'employee',fields:{}}]}},400);
await call(`/v1/workflow-drafts/${id}`,'PUT',{expectedRevision:99,definition},409);
const published=await call(`/v1/workflow-drafts/${id}/publish`,'POST',{expectedRevision:1});
assert.equal(published.version,1);
assert.deepEqual(await call(`/v1/workflow-drafts/${id}/publish`,'POST',{expectedRevision:1}),published);
assert.ok((await call('/v1/workflow-definitions')).items.some(d=>d.id===id&&d.version===1));
assert.ok(!(await call('/v1/workflow-definitions','GET',undefined,200,'bob')).items.some(d=>d.id===id));
const createKey=randomUUID(),payload={definitionId:id,title:'Configurable employee intake',input:{employeeName:'Demo employee'}};
const original=await call('/v1/workflows','POST',payload,201,'alice',createKey);
assert.equal(original.definitionVersion,1);
await call(`/v1/workflows/${original.id}`,'GET',undefined,404,'bob');
const v2Definition={...definition,startFields:{employeeName:'text',costCenter:'text'},transitions:[
  definition.transitions[0],{...definition.transitions[1],to:'ready',fields:{accountRef:'text',checklist:'text'}},
]};
const edited=await call(`/v1/workflow-drafts/${id}`,'PUT',{expectedRevision:1,definition:v2Definition});
assert.equal(edited.revision,2);
await call(`/v1/workflow-drafts/${id}/publish`,'POST',{expectedRevision:1},409);
const results=await Promise.all([1,2].map(()=>call(`/v1/workflow-drafts/${id}/publish`,'POST',{expectedRevision:2})));
assert.ok(results.every(d=>d.version===2));
// Replay v1 input after v2 added mandatory fields must still return accepted v1 result.
const replay=await call('/v1/workflows','POST',payload,201,'alice',createKey);
assert.equal(replay.id,original.id);assert.equal(replay.definitionVersion,1);
let running=await call(`/v1/workflows/${original.id}/transitions`,'POST',{action:'submit',expectedVersion:1,input:{}});
assert.equal(running.definitionVersion,1);
assert.ok((await call(`/v1/workflows?inbox=true&definitionId=${id}`,'GET',undefined,200,'it-demo')).items.some(r=>r.id===running.id));
running=await call(`/v1/workflows/${running.id}/transitions`,'POST',{action:'provision',expectedVersion:2,input:{accountRef:'demo-account'}},200,'it-demo');
assert.equal(running.state,'completed');
assert.equal((await call(`/v1/workflows/${running.id}/history`)).items.length,3);
assert.equal((await call(`/v1/workflows/${running.id}/sync`)).items.length,1);
await call('/v1/workflows','POST',payload,400);
const latest=await call('/v1/workflows','POST',{...payload,input:{employeeName:'New employee',costCenter:'IT'}},201);
assert.equal(latest.definitionVersion,2);
const page=await call('/v1/workflow-drafts?limit=1');assert.equal(page.items.length,1);assert.ok(page.page);
// Use an isolated schema for bulk fixtures and concurrency; business data remains intact.
const sqlSource=`
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {definitionDatabase} from './src/workflows/registry-database.ts';
import {foundationDatabase} from './src/foundation-database.ts';
import {workflowDatabase} from './src/workflows/database.ts';
(async()=>{
 const control=new pg.Pool({connectionString:process.env.DATABASE_URL});
 const schema='studio_smoke_'+randomUUID().replaceAll('-','');
 let pool;
 try{
  await control.query('CREATE SCHEMA '+schema);
  pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,max:1,connectionTimeoutMillis:5000});
  const registry=await definitionDatabase(pool);
  const a={subject:'designer-a',organizationId:'isolated-a',roles:['workflow:design']};
  const b={...a,subject:'designer-b',organizationId:'isolated-b'};
  const definition={id:'process',title:'A',startRole:'employee',initialState:'draft',startFields:{},readerRoles:[],transitions:[{id:'submit',from:'draft',to:'done',role:'employee',fields:{}}]};
  await registry.create(definition,a);
  await assert.rejects(()=>registry.getDraft('process',b),e=>e.statusCode===404);
  await registry.create({...definition,title:'B'},b);
  const versions=await Promise.all([registry.publish('process',1,a),registry.publish('process',1,a)]);
  assert.ok(versions.every(v=>v.version===1));
  await registry.publish('process',1,b);
  assert.equal((await registry.get(a.organizationId,'process')).title,'A');
  assert.equal((await registry.get(b.organizationId,'process')).title,'B');
  const saves=await Promise.allSettled([registry.updateDraft('process',1,{...definition,title:'A2'},a),registry.updateDraft('process',1,{...definition,title:'A3'},a)]);
  assert.equal(saves.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(saves.find(r=>r.status==='rejected').reason.statusCode,409);
  await registry.publish('process',2,a);
  const reconnected=await definitionDatabase(pool);
  assert.equal((await reconnected.get(a.organizationId,'process',1)).title,'A');
  assert.equal((await reconnected.get(a.organizationId,'process')).version,2);
  assert.equal((await reconnected.getDraft('process',a)).updatedBy,a.subject);
  for(let i=0;i<105;i++)await registry.create({...definition,id:'page-'+String(i).padStart(3,'0')},a);
  const first=await registry.listDrafts(a,{limit:100,offset:0,q:''});
  const next=await registry.listDrafts(a,{limit:100,offset:first.page.nextOffset,q:''});
  assert.equal(first.items.length,100);assert.equal(next.items.length,6);
  assert.equal(next.page.nextOffset,null);
  assert.equal(new Set([...first.items,...next.items].map(d=>d.id)).size,106);
  assert.equal((await registry.listDrafts(b,{limit:100,offset:0,q:''})).items.length,1);
  await pool.query('CREATE TABLE records(id uuid PRIMARY KEY,title text NOT NULL,owner_id text NOT NULL,organization_id text,created_at timestamptz NOT NULL DEFAULT now())');
  await foundationDatabase(pool);
  const runtime=await workflowDatabase(pool,registry);
  const actor={...a,roles:['workflow:start','employee']};
  const runs=await Promise.all(Array.from({length:5},(_,i)=>runtime.create({definitionId:'process',title:'Concurrent '+i,input:{}},actor,randomUUID())));
  assert.ok(runs.every(r=>r.definitionVersion===2));
  const finished=await Promise.all(runs.map(r=>runtime.transition(r.id,{action:'submit',expectedVersion:1,input:{}},actor,randomUUID())));
  assert.ok(finished.every(r=>r.state==='done'));
  console.log('Real registry SQL passed: competing saves/publication, 106-row paging, tenant name isolation, immutable versions and 5 concurrent starts/transitions with a single DB connection.');
 }finally{
  await pool?.end();
  if(!/^studio_smoke_[a-f0-9]{32}$/.test(schema))throw new Error('Unsafe smoke schema');
  await control.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await control.end();
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
`;
console.log(execFileSync('docker',['--context','desktop-linux','compose','-f','infra/compose/core.yml','exec','-T','-w','/app/apps/api','api','pnpm','exec','tsx','--eval',sqlSource],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:90000}).trim());
console.log('Workflow Studio smoke passed: configuration API, permission checks, reserved IDs, graph validation, optimistic conflict, serialized publication, tenant isolation, pinned runtime, v1 replay after v2, dynamic inbox and outbox.');
console.log(JSON.stringify({definitionId:id,runV1:original.id,runV2:latest.id,note:'Retained local demo configuration and instances'}));
