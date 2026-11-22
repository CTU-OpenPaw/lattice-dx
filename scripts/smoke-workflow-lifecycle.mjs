/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import { dockerContextArgs } from './lib/docker-context.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),actors={};
for(const username of ['alice','it-demo','warehouse','connector-demo']){
 const r=await fetch('http://localhost:8081/realms/lattice/protocol/openid-connect/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'password',client_id:'dx-local',username,password:`local-${username}-password`})});
 assert.equal(r.status,200);const token=(await r.json()).access_token;actors[username]={token,subject:JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString()).sub};
}
async function call(path,method='GET',body,expected=200,user='alice',key=randomUUID()){
 const r=await fetch('http://localhost:8080'+path,{method,headers:{authorization:`Bearer ${actors[user].token}`,'content-type':'application/json','Idempotency-Key':key},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});
 const result=await r.json();assert.equal(r.status,expected,`${user} ${method} ${path}: ${JSON.stringify(result)}`);return result;
}
for(const user of ['it-demo','warehouse'])await call('/v1/workflow-members/me','POST',{},200,user);
const definitionId='lifecycle-'+randomUUID().replaceAll('-',''),lit=value=>({source:'literal',value});
const definition={id:definitionId,title:'Coordinated lifecycle',startRole:'employee',initialState:'draft',startFields:{cost:'positiveInteger',flag:'text',worker:'subject'},readerRoles:[],transitions:[
 {id:'prepare',from:'draft',to:'waiting',role:'employee',ownerOnly:true,fields:{},condition:{all:[{field:'cost',operator:'gt',value:'100'},{any:[{field:'flag',operator:'eq',value:'yes'},{field:'flag',operator:'eq',value:'override'}]}]},steps:[{id:'work',action:'tasks.create',input:{title:lit('Prepare'),assigneeId:{source:'data',field:'worker'}}}],wait:{stepId:'work',successState:'ready',failureState:'failed',resultFields:{reference:'text'},timeoutSeconds:3600}},
 {id:'send',from:'ready',to:'integrating',role:'employee',ownerOnly:true,fields:{},steps:[{id:'connector',action:'connectors.dispatch',input:{connectorId:lit('n8n'),operation:lit('lifecycle.sync'),payload:{reference:{source:'data',field:'reference'}}}}],wait:{stepId:'connector',successState:'done',failureState:'failed',resultFields:{external:'text'},timeoutSeconds:3600}},
 {id:'early',from:'waiting',to:'done',role:'employee',ownerOnly:true,fields:{}}
]};
await call('/v1/workflow-drafts','POST',{definition},201);await call(`/v1/workflow-drafts/${definitionId}/publish`,'POST',{expectedRevision:1});
let run=await call('/v1/workflows','POST',{definitionId,title:'Lifecycle good',input:{cost:'101',flag:'yes',worker:actors['it-demo'].subject}},201);
const blocked=await call('/v1/workflows','POST',{definitionId,title:'Lifecycle blocked',input:{cost:'1',flag:'no',worker:actors['it-demo'].subject}},201);
assert.ok(run.availableTransitions.some(row=>row.id==='prepare'));assert.equal(blocked.availableTransitions.length,0);
const inbox=await call(`/v1/workflows?inbox=true&definitionId=${definitionId}`);assert.ok(inbox.items.some(row=>row.id===run.id));assert.ok(!inbox.items.some(row=>row.id===blocked.id));
await call(`/v1/workflows/${blocked.id}/transitions`,'POST',{action:'prepare',expectedVersion:1,input:{}},409);
run=await call(`/v1/workflows/${run.id}/transitions`,'POST',{action:'prepare',expectedVersion:run.version,input:{}});
const wait=(await call(`/v1/workflows/${run.id}/waits`)).items[0];
const transfer={taskId:wait.id,expectedVersion:run.version,assigneeId:actors.warehouse.subject,reason:'Transfer to active colleague'},transferKey=randomUUID();
run=await call(`/v1/workflows/${run.id}/task-transfer`,'POST',transfer,200,'alice',transferKey);
assert.equal(run.waiting,true);assert.equal(run.availableTransitions.length,0);
assert.deepEqual(await call(`/v1/workflows/${run.id}/task-transfer`,'POST',transfer,200,'alice',transferKey),run);
await call(`/v1/workflow-waits/${wait.id}/complete`,'POST',{status:'succeeded',result:{reference:'old'}},403,'it-demo');
await call(`/v1/workflow-waits/${wait.id}/complete`,'POST',{status:'succeeded',result:{reference:'new'}},200,'warehouse');
run=await call(`/v1/workflows/${run.id}`);assert.equal(run.state,'ready');
run=await call(`/v1/workflows/${run.id}/transitions`,'POST',{action:'send',expectedVersion:run.version,input:{}});
const connectorWait=(await call(`/v1/workflows/${run.id}/waits`)).items.find(row=>row.kind==='connector');
const cancel={expectedVersion:run.version,reason:'Stop integration'},cancelKey=randomUUID();
run=await call(`/v1/workflows/${run.id}/cancel`,'POST',cancel,200,'alice',cancelKey);
assert.equal(run.status,'cancelled');assert.equal(run.availableTransitions.length,0);
assert.deepEqual(await call(`/v1/workflows/${run.id}/cancel`,'POST',cancel,200,'alice',cancelKey),run);
await call(`/v1/workflow-waits/${connectorWait.id}/complete`,'POST',{status:'succeeded',result:{external:'late'}},409,'connector-demo');
assert.ok((await call(`/v1/workflows/${run.id}/sync`)).items.every(job=>job.status==='cancelled'));

const sqlSource=`
import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import pg from 'pg';
import {recordDatabase} from './src/database.ts';import {foundationDatabase} from './src/foundation-database.ts';import {createDirectoryDatabase} from './src/directory-database.ts';
import {definitionDatabase} from './src/workflows/registry-database.ts';import {workflowDatabase} from './src/workflows/database.ts';import {workflowJobDatabase} from './src/workflows/job-database.ts';
(async()=>{const control=new pg.Pool({connectionString:process.env.DATABASE_URL}),schema='lifecycle_smoke_'+randomUUID().replaceAll('-','');let pool;
 try{
  await control.query('CREATE SCHEMA '+schema);pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,max:5});
  await recordDatabase(pool);await createDirectoryDatabase(pool);await foundationDatabase(pool);let registry=await definitionDatabase(pool),repo=await workflowDatabase(pool,registry);
  const owner={subject:'owner',organizationId:'a',roles:['workflow:start','workflow:design','employee','tasks:assign','records:write','workflow:integrate']},worker={subject:'worker',organizationId:'a',roles:['tasks:decide']},other={subject:'other',organizationId:'a',roles:['tasks:decide']};
  for(const actor of [owner,worker,other]){await pool.query('INSERT INTO directory_people(subject,organization_id,display_name,enabled,roles) VALUES($1,$2,$1,true,$3)',[actor.subject,'a',JSON.stringify(actor.roles)]);await repo.registerMember(actor);}
  const lit=value=>({source:'literal',value});
  const def={id:'lifecycle',title:'Lifecycle',startRole:'employee',initialState:'draft',startFields:{worker:'subject'},readerRoles:[],transitions:[{id:'prepare',from:'draft',to:'waiting',role:'employee',ownerOnly:true,fields:{},steps:[{id:'work',action:'tasks.create',input:{title:lit('Task'),assigneeId:{source:'data',field:'worker'}}}],wait:{stepId:'work',successState:'done',failureState:'failed',resultFields:{reference:'text'},timeoutSeconds:3600}}]};
  await registry.create(def,owner);await registry.publish(def.id,1,owner);
  const create={definitionId:def.id,title:'SQL lifecycle',input:{worker:'worker'}};
  let run=await repo.create(create,owner,'create');run=await repo.transition(run.id,{action:'prepare',expectedVersion:1,input:{}},owner,'prepare');
  const wait=(await repo.listWaits(run.id,owner,{limit:100,offset:0,q:''})).items[0];
  run=await repo.taskTransfer(run.id,{taskId:wait.id,expectedVersion:run.version,assigneeId:'other',reason:'Transfer'},owner,'transfer');
  await assert.rejects(()=>repo.completeWait(wait.id,{status:'succeeded',result:{reference:'old'}},worker,'old'),e=>e.statusCode===403);
  const version=run.version,auditBefore=(await repo.history(run.id,owner)).length;
  await pool.query('ALTER TABLE workflow_commands ADD CONSTRAINT lifecycle_fail_receipt CHECK(false) NOT VALID');
  await assert.rejects(()=>repo.cancel(run.id,{expectedVersion:version,reason:'Cancel'},owner,'cancel'));
  assert.equal((await repo.get(run.id,owner)).version,version);assert.equal((await repo.history(run.id,owner)).length,auditBefore);
  assert.equal((await pool.query('SELECT status FROM workflow_waits WHERE id=$1',[wait.id])).rows[0].status,'pending');
  await pool.query('ALTER TABLE workflow_commands DROP CONSTRAINT lifecycle_fail_receipt');
  const races=await Promise.allSettled([repo.cancel(run.id,{expectedVersion:version,reason:'Cancel'},owner,'cancel'),repo.completeWait(wait.id,{status:'succeeded',result:{reference:'done'}},other,'complete')]);
  assert.equal(races.filter(row=>row.status==='fulfilled').length,1);assert.equal(races.find(row=>row.status==='rejected').reason.statusCode,409);
  run=await repo.get(run.id,owner);
  if(run.status!=='cancelled')run=await repo.cancel(run.id,{expectedVersion:run.version,reason:'After completed'},owner,'cancel-after');
  const deliveryRun=await repo.create({...create,title:'Delivery fence'},owner,'delivery-create'),eventId=randomUUID();
  await pool.query('INSERT INTO workflow_jobs(id,run_id,organization_id,payload) VALUES($1,$2,$3,$4)',[eventId,deliveryRun.id,'a',JSON.stringify({eventId,eventType:'connector.dispatch',runId:deliveryRun.id,organizationId:'a',connectorId:'n8n',operation:'fixture',data:{}})]);
  const jobs=workflowJobDatabase(pool),leased=await jobs.claim();assert.equal(leased.id,eventId);
  const backgroundTaskId=randomUUID();
  await pool.query("INSERT INTO foundation_tasks(id,title,organization_id,assignee_id,created_by) VALUES($1,'Background','a','worker','owner')",[backgroundTaskId]);
  await pool.query("INSERT INTO workflow_action_results(run_id,version,step_id,actor_id,action,input,result) VALUES($1,1,'background','owner','tasks.create','{}',$2)",[deliveryRun.id,JSON.stringify({id:backgroundTaskId})]);
  await repo.cancel(deliveryRun.id,{expectedVersion:deliveryRun.version,reason:'Fence delivery'},owner,'delivery-cancel');
  await jobs.succeed(leased);await jobs.fail(leased,'ignored');
  assert.equal((await pool.query('SELECT status,lease_token FROM workflow_jobs WHERE id=$1',[eventId])).rows[0].status,'cancelled');
  assert.equal((await pool.query('SELECT status FROM foundation_tasks WHERE id=$1',[backgroundTaskId])).rows[0].status,'cancelled');
  assert.equal(await jobs.claim(),undefined);
  assert.equal((await repo.listPage(owner,true,{limit:100,offset:0,q:''})).items.length,0);
  await pool.end();pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,max:1});registry=await definitionDatabase(pool);repo=await workflowDatabase(pool,registry);
  assert.equal((await repo.get(run.id,owner)).status,'cancelled');assert.equal((await repo.get(run.id,owner)).version,run.version);
  console.log('Workflow lifecycle SQL passed: transfer authority, wait/run version coherence, rollback cancellation, cancel/completion race, cancelled inbox and max1 persistence.');
 }finally{await pool?.end();if(!/^lifecycle_smoke_[a-f0-9]{32}$/.test(schema))throw new Error('Unsafe fixture');await control.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await control.end();}
})().catch(error=>{console.error(error);process.exitCode=1;});
`;
console.log(execFileSync('docker',[...dockerContextArgs(), 'compose','-f','infra/compose/core.yml','exec','-T','-w','/app/apps/api','api','pnpm','exec','tsx','--eval',sqlSource],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:90000}).trim());
console.log(JSON.stringify({result:'Workflow lifecycle HTTP passed',runId:run.id,taskWaitId:wait.id,connectorWaitId:connectorWait.id}));
