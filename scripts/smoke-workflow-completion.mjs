// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)),base='http://localhost:8080',actors={};
for(const username of ['alice','warehouse','it-demo','connector-demo','connector-b','connector-agent']){
 const r=await fetch('http://localhost:8081/realms/lattice/protocol/openid-connect/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'password',client_id:'dx-local',username,password:`local-${username}-password`}),signal:AbortSignal.timeout(15000)});
 assert.equal(r.status,200,`Login ${username}; sync local identity fixtures first`);
 const token=(await r.json()).access_token;actors[username]={token,subject:JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString()).sub};
}
async function call(path,method='GET',body,expected=200,actor='alice',key=randomUUID()){
 const r=await fetch(base+path,{method,headers:{authorization:`Bearer ${actors[actor].token}`,'content-type':'application/json','Idempotency-Key':key},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});
 const result=await r.json();assert.equal(r.status,expected,`${actor} ${method} ${path}: ${JSON.stringify(result)}`);return result;
}
const lit=value=>({source:'literal',value}),data=field=>({source:'data',field});
const id='completion-'+randomUUID().replaceAll('-','');
const definition={id,title:'Employee task and connector completion',startRole:'employee',initialState:'draft',startFields:{employeeName:'text',itAssignee:'subject',cost:'positiveInteger'},readerRoles:[],transitions:[
 {id:'prepare',from:'draft',to:'waiting_it',role:'employee',ownerOnly:true,fields:{},steps:[
  {id:'handoff',action:'records.create',input:{title:data('employeeName')}},
  {id:'assign',action:'tasks.create',input:{title:lit('Prepare employee account'),assigneeId:data('itAssignee'),recordId:{source:'result',stepId:'handoff',field:'id'}}}
 ],wait:{stepId:'assign',successState:'account_ready',failureState:'needs_review',resultFields:{accountRef:'text'},timeoutSeconds:3600}},
 {id:'synchronize',from:'account_ready',to:'integrating',role:'employee',ownerOnly:true,fields:{},condition:{field:'accountRef',operator:'exists'},steps:[
  {id:'send',action:'connectors.dispatch',input:{connectorId:lit('n8n'),operation:lit('employee.synchronize'),payload:{accountRef:data('accountRef')}}}
 ],wait:{stepId:'send',successState:'completed',failureState:'integration_failed',resultFields:{externalRef:'text'},timeoutSeconds:3600}},
 {id:'expensive_review',from:'account_ready',to:'reviewed',role:'employee',ownerOnly:true,fields:{},condition:{field:'cost',operator:'gt',value:'1000'}},
 {id:'early',from:'waiting_it',to:'completed',role:'employee',ownerOnly:true,fields:{}},
 {id:'early_connector',from:'integrating',to:'completed',role:'employee',ownerOnly:true,fields:{}},
]};
await call('/v1/workflow-drafts','POST',{definition},201);
await call(`/v1/workflow-drafts/${id}/publish`,'POST',{expectedRevision:1});
let run=await call('/v1/workflows','POST',{definitionId:id,title:'Employee completion demo',input:{employeeName:'Demo employee',itAssignee:actors['it-demo'].subject,cost:'500'}},201);
const start={action:'prepare',expectedVersion:1,input:{}},startKey=randomUUID();
run=await call(`/v1/workflows/${run.id}/transitions`,'POST',start,200,'alice',startKey);
assert.equal(run.state,'waiting_it');assert.equal(run.waiting,true);assert.deepEqual(run.availableTransitions,[]);
const waits=await call(`/v1/workflows/${run.id}/waits`);assert.equal(waits.items.length,1);
const taskWait=waits.items[0];
const task=await call(`/v1/tasks/${taskWait.id}`,'GET',undefined,200,'it-demo');assert.equal(task.workflowWaitId,taskWait.id);
// Restart the API process while a business wait is pending; its durable resource/config must survive.
execFileSync('docker',['--context','desktop-linux','compose','-f','infra/compose/core.yml','restart','api'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000});
for(let i=0;i<20;i++){
 try{const health=await fetch(base+'/health',{signal:AbortSignal.timeout(2000)});if(health.ok)break;}catch{}
 await new Promise(resolve=>setTimeout(resolve,250));
}
assert.equal((await call(`/v1/workflows/${run.id}`)).waiting,true);
await call(`/v1/tasks/${task.id}/decisions`,'POST',{decision:'approve',expectedVersion:1},409,'it-demo');
await call(`/v1/workflows/${run.id}/transitions`,'POST',{action:'early',expectedVersion:run.version,input:{}},409);
assert.equal((await call(`/v1/workflows/${run.id}/transitions`,'POST',start,200,'alice',startKey)).id,run.id);
await call(`/v1/workflows/${run.id}/waits`,'GET',undefined,404,'it-demo');
const result={status:'succeeded',result:{accountRef:'local-account'}},completionKey=randomUUID();
await call(`/v1/workflow-waits/${taskWait.id}/complete`,'POST',result,403,'warehouse');
await call(`/v1/workflow-waits/${taskWait.id}/complete`,'POST',{...result,status:['succeeded']},400,'it-demo');
await call(`/v1/workflow-waits/${taskWait.id}/complete`,'POST',{...result,result:{itAssignee:actors.warehouse.subject}},400,'it-demo');
const receipt=await call(`/v1/workflow-waits/${taskWait.id}/complete`,'POST',result,200,'it-demo',completionKey);
assert.equal(receipt.state,'account_ready');assert.ok(!('data' in receipt));
assert.deepEqual(await call(`/v1/workflow-waits/${taskWait.id}/complete`,'POST',result,200,'it-demo',completionKey),receipt);
await call(`/v1/workflow-waits/${taskWait.id}/complete`,'POST',{...result,result:{accountRef:'changed'}},409,'it-demo',completionKey);
assert.equal((await call(`/v1/tasks/${task.id}`,'GET',undefined,200,'it-demo')).status,'completed');
run=await call(`/v1/workflows/${run.id}`);assert.equal(run.waiting,false);assert.equal(run.data.accountRef,'local-account');
assert.ok(run.availableTransitions.some(t=>t.id==='synchronize'));
assert.ok(!run.availableTransitions.some(t=>t.id==='expensive_review'));
await call(`/v1/workflows/${run.id}/transitions`,'POST',{action:'expensive_review',expectedVersion:run.version,input:{}},409);
run=await call(`/v1/workflows/${run.id}/transitions`,'POST',{action:'synchronize',expectedVersion:run.version,input:{}});
assert.equal(run.waiting,true);
const connectorWait=(await call(`/v1/workflows/${run.id}/waits`)).items.find(w=>w.kind==='connector');
await call(`/v1/workflow-waits/${connectorWait.id}/complete`,'POST',{status:'succeeded',result:{externalRef:'synced'}},404,'connector-b');
await call(`/v1/workflow-waits/${connectorWait.id}/complete`,'POST',{status:'succeeded',result:{externalRef:'synced'}},403,'connector-agent');
const callbacks=await Promise.all(['synced-a','synced-b'].map(value=>fetch(base+`/v1/workflow-waits/${connectorWait.id}/complete`,{method:'POST',headers:{authorization:`Bearer ${actors['connector-demo'].token}`,'content-type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify({status:'succeeded',result:{externalRef:value}})})));
assert.deepEqual(callbacks.map(r=>r.status).sort(),[200,409]);
run=await call(`/v1/workflows/${run.id}`);assert.equal(run.state,'completed');assert.equal(run.waiting,false);assert.equal(run.version,5);
const waitPage=await call(`/v1/workflows/${run.id}/waits?limit=1`);assert.equal(waitPage.page.nextOffset,1);
assert.notEqual((await call(`/v1/workflows/${run.id}/waits?limit=1&offset=1`)).items[0].id,waitPage.items[0].id);
const timeoutDefinition={...definition,id:id+'-timeout',transitions:[{...definition.transitions[0],wait:{...definition.transitions[0].wait,timeoutSeconds:2}}]};
await call('/v1/workflow-drafts','POST',{definition:timeoutDefinition},201);
await call(`/v1/workflow-drafts/${timeoutDefinition.id}/publish`,'POST',{expectedRevision:1});
let timed=await call('/v1/workflows','POST',{definitionId:timeoutDefinition.id,title:'Real worker deadline',input:{employeeName:'Timeout employee',itAssignee:actors['it-demo'].subject,cost:'500'}},201);
timed=await call(`/v1/workflows/${timed.id}/transitions`,'POST',{action:'prepare',expectedVersion:1,input:{}});
const timeoutWait=(await call(`/v1/workflows/${timed.id}/waits`)).items[0];
for(let i=0;i<20;i++){
 timed=await call(`/v1/workflows/${timed.id}`);
 if(timed.state==='needs_review')break;
 await new Promise(resolve=>setTimeout(resolve,250));
}
assert.equal(timed.state,'needs_review','Default durable timeout poller should settle a two-second wait');
assert.equal((await call(`/v1/workflows/${timed.id}/waits`)).items[0].status,'timed_out');
await call(`/v1/workflow-waits/${timeoutWait.id}/complete`,'POST',result,409,'it-demo');
console.log(JSON.stringify({result:'Workflow completion REST passed: task result, waiting/guard choices, generic bypass denial, scoped receipts, connector callback roles, exact replay and concurrent outcomes.',runId:run.id,taskId:task.id,connectorEventId:connectorWait.id}));
// Private SQL fixtures test deadline processing and callback race without touching retained business demos.
const sqlSource=`
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {foundationDatabase} from './src/foundation-database.ts';
import {createDirectoryDatabase} from './src/directory-database.ts';
import {definitionDatabase} from './src/workflows/registry-database.ts';
import {workflowDatabase} from './src/workflows/database.ts';
(async()=>{
 const control=new pg.Pool({connectionString:process.env.DATABASE_URL}),schema='completion_smoke_'+randomUUID().replaceAll('-','');let pool;
 try{
  await control.query('CREATE SCHEMA '+schema);
  pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,max:1,connectionTimeoutMillis:5000});
  await pool.query('CREATE TABLE records(id uuid PRIMARY KEY,title text NOT NULL,owner_id text NOT NULL,organization_id text,created_at timestamptz NOT NULL DEFAULT now())');
  const foundation=await foundationDatabase(pool);await createDirectoryDatabase(pool);
  const registry=await definitionDatabase(pool),repo=await workflowDatabase(pool,registry);
  const owner={subject:'owner',organizationId:'org-a',roles:['workflow:design','workflow:start','employee','records:write','tasks:assign','workflow:integrate','workflow:sync']};
  const worker={subject:'worker',organizationId:'org-a',roles:['tasks:decide']};
  const connector={subject:'connector',organizationId:'org-a',roles:['workflow:callback','connector:n8n']};
  await pool.query('INSERT INTO directory_people(subject,organization_id,display_name,roles,enabled) VALUES($1,$2,$1,$3,true)',[worker.subject,worker.organizationId,JSON.stringify(worker.roles)]);
  const lit=value=>({source:'literal',value}),defs={id:'completion',title:'Completion SQL',startRole:'employee',initialState:'draft',startFields:{cost:'positiveInteger'},readerRoles:[],transitions:[
   {id:'prepare',from:'draft',to:'waiting_task',role:'employee',fields:{},steps:[{id:'task',action:'tasks.create',input:{title:lit('Prepare'),assigneeId:lit(worker.subject)}}],wait:{stepId:'task',successState:'ready',failureState:'failed',resultFields:{account:'text'},timeoutSeconds:3600}},
   {id:'send',from:'ready',to:'waiting_connector',role:'employee',fields:{},condition:{field:'cost',operator:'gt',value:'1000'},steps:[{id:'event',action:'connectors.dispatch',input:{connectorId:lit('n8n'),operation:lit('sync')}}],wait:{stepId:'event',successState:'done',failureState:'failed',resultFields:{external:'text'},timeoutSeconds:3600}},
   {id:'early',from:'waiting_task',to:'done',role:'employee',fields:{}}
  ]};
  await registry.create(defs,owner);await registry.publish(defs.id,1,owner);
  const start=async(cost='1500')=>{
   const r=await repo.create({definitionId:defs.id,title:'SQL wait',input:{cost}},owner,randomUUID());
   return repo.transition(r.id,{action:'prepare',expectedVersion:1,input:{}},owner,randomUUID());
  };
  const wait=async r=>(await pool.query('SELECT * FROM workflow_waits WHERE run_id=$1 AND status=$2',[r.id,'pending'])).rows[0];
  let r=await start(),w=await wait(r);
  await assert.rejects(()=>repo.transition(r.id,{action:'early',expectedVersion:2,input:{}},owner,randomUUID()),e=>e.statusCode===409);
  assert.equal(await foundation.decideTask(w.id,worker,'approve','',1),undefined);
  const candidates=await Promise.allSettled(['a','b','c','d','e'].map(account=>repo.completeWait(w.id,{status:'succeeded',result:{account}},worker,randomUUID())));
  assert.equal(candidates.filter(v=>v.status==='fulfilled').length,1);assert.ok(candidates.filter(v=>v.status==='rejected').every(v=>v.reason.statusCode===409));
  r=await repo.get(r.id,owner);assert.equal(r.state,'ready');assert.equal(r.version,3);
  assert.equal((await pool.query('SELECT version,status FROM foundation_tasks WHERE id=$1',[w.id])).rows[0].version,2);
  assert.equal((await repo.history(r.id,owner)).length,3);
  r=await repo.transition(r.id,{action:'send',expectedVersion:3,input:{}},owner,randomUUID());w=await wait(r);
  await assert.rejects(()=>repo.completeWait(w.id,{status:'succeeded',result:{external:'x'}},{...connector,roles:['workflow:callback','connector:agent']},randomUUID()),e=>[403,404].includes(e.statusCode));
  const completionKey=randomUUID(),body={status:'succeeded',result:{external:'synced'}};
  const receipt=await repo.completeWait(w.id,body,connector,completionKey);
  assert.equal(receipt.state,'done');assert.ok(!('data' in receipt));assert.deepEqual(await repo.completeWait(w.id,body,connector,completionKey),receipt);
  const gated=await start('500'),gatedWait=await wait(gated);
  await repo.completeWait(gatedWait.id,{status:'succeeded',result:{account:'prepared'}},worker,randomUUID());
  assert.ok(!(await repo.listPage(owner,true,{limit:100,offset:0,q:''})).items.some(v=>v.id===gated.id));
  await assert.rejects(()=>repo.transition(gated.id,{action:'send',expectedVersion:3,input:{}},owner,randomUUID()),e=>e.statusCode===409);
  for(const cost of ['1e3','Infinity','5\\n',' '.repeat(2)+'5000', '9'.repeat(21),5,null]){
   await pool.query('UPDATE workflow_runs SET data=jsonb_set(data,$1::text[],$2::jsonb) WHERE id=$3',[['cost'],JSON.stringify(cost),gated.id]);
   assert.ok(!(await repo.listPage(owner,true,{limit:100,offset:0,q:''})).items.some(v=>v.id===gated.id));
   await assert.rejects(()=>repo.transition(gated.id,{action:'send',expectedVersion:3,input:{}},owner,randomUUID()),e=>e.statusCode===409);
  }
  const expired=await start(),expiredWait=await wait(expired);
  await pool.query("UPDATE workflow_waits SET deadline=now()-interval '1 second' WHERE id=$1",[expiredWait.id]);
  await assert.rejects(()=>repo.completeWait(expiredWait.id,{status:'succeeded',result:{account:'late'}},worker,randomUUID()),e=>e.statusCode===409);
  const restarted=await workflowDatabase(pool,registry);await restarted.expireWaits();
  assert.equal((await restarted.get(expired.id,owner)).state,'failed');
  assert.equal((await pool.query('SELECT status FROM workflow_waits WHERE id=$1',[expiredWait.id])).rows[0].status,'timed_out');
  await assert.rejects(()=>restarted.completeWait(expiredWait.id,{status:'succeeded',result:{account:'late'}},worker,randomUUID()),e=>e.statusCode===409);
  const failed=await start(),failedWait=await wait(failed);
  await restarted.completeWait(failedWait.id,{status:'failed',result:{},reason:'Cannot provision'},worker,randomUUID());
  assert.equal((await restarted.get(failed.id,owner)).state,'failed');
  assert.equal((await restarted.listWaits(failed.id,owner,{limit:10,offset:0,q:''})).items[0].evidence.reason,'Cannot provision');
  console.log('Isolated completion SQL passed: atomic task/run, five concurrent results, guarded inbox, resource authority, replay, failed outcome and durable timeout/late rejection with one connection.');
 }finally{
  await pool?.end();if(!/^completion_smoke_[a-f0-9]{32}$/.test(schema))throw new Error('Unsafe fixture schema');
  await control.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await control.end();
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
`;
console.log(execFileSync('docker',['--context','desktop-linux','compose','-f','infra/compose/core.yml','exec','-T','-w','/app/apps/api','api','pnpm','exec','tsx','--eval',sqlSource],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:90000}).trim());
