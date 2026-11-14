/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)),base='http://localhost:8080',actors={};
for(const username of ['alice','sales2','warehouse','warehouse2','warehouse-b','it-demo']) {
  const r=await fetch('http://localhost:8081/realms/lattice/protocol/openid-connect/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'password',client_id:'dx-local',username,password:`local-${username}-password`}),signal:AbortSignal.timeout(15000)});
  assert.equal(r.status,200,`Login ${username}`);
  const token=(await r.json()).access_token;
  actors[username]={token,subject:JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString()).sub};
}
async function call(path,method='GET',body,expected=200,actor='alice',key=randomUUID()) {
  const r=await fetch(base+path,{method,headers:{authorization:`Bearer ${actors[actor].token}`,'content-type':'application/json','Idempotency-Key':key},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});
  const result=await r.json();assert.equal(r.status,expected,`${actor} ${method} ${path}: ${JSON.stringify(result)}`);return result;
}
const literal=value=>({source:'literal',value});
const data=field=>({source:'data',field});
const result=stepId=>({source:'result',stepId,field:'id'});
function definition(id,steps){return {id,title:'Cross-department configurable engine',startRole:'logistics:sales',initialState:'draft',startFields:{departmentId:'department',recipientId:'subject'},readerRoles:[],transitions:[{id:'dispatch',from:'draft',to:'dispatched',role:'logistics:sales',ownerOnly:true,fields:{},steps}]};}
async function publish(definition){await call('/v1/workflow-drafts','POST',{definition},201);return call(`/v1/workflow-drafts/${definition.id}/publish`,'POST',{expectedRevision:1});}
async function create(definitionId,departmentId='it',recipientId=actors['it-demo'].subject,actor='alice') {return call('/v1/workflows','POST',{definitionId,title:'Block acceptance '+randomUUID(),input:{departmentId,recipientId}},201,actor);}
const id='blocks-'+randomUUID().replaceAll('-','');
const steps=[
  {id:'handoff',action:'records.create',input:{title:{source:'context',field:'title'}}},
  {id:'assign',action:'tasks.create',input:{title:literal('Prepare employee workspace'),recordId:result('handoff')},assignment:{kind:'department',department:data('departmentId'),role:'department:it'}},
  {id:'notify',action:'connectors.dispatch',input:{connectorId:literal('n8n'),operation:literal('employee.provision'),payload:{recordId:result('handoff'),taskId:result('assign')}}},
];
const departments=await call('/v1/directory/departments?role=department%3Ait&limit=1');
assert.ok(departments.items.some(d=>d.id==='it'&&d.memberCount===1));
await call('/v1/directory/departments','GET',undefined,403,'warehouse');
const catalog=(await call('/v1/workflow-blocks')).items;
for(const id of ['records.create','tasks.create','connectors.dispatch'])assert.ok(catalog.some(block=>block.id===id));
assert.ok(!(await call('/v1/workflow-blocks','GET',undefined,200,'sales2')).items.some(b=>b.id==='connectors.dispatch'));
await publish(definition(id,steps));
const initial=await create(id),command={action:'dispatch',expectedVersion:1,input:{}},key=randomUUID();
const dispatched=await call(`/v1/workflows/${initial.id}/transitions`,'POST',command,200,'alice',key);
assert.equal(dispatched.state,'dispatched');
await call(`/v1/workflows/${initial.id}/transitions`,'POST',command,200,'alice',key);
const executions=await call(`/v1/workflows/${initial.id}/executions`);
assert.equal(executions.items.length,3);
assert.deepEqual(executions.items.map(e=>e.stepId),['handoff','assign','notify']);
const executionPage=await call(`/v1/workflows/${initial.id}/executions?limit=1`);
assert.equal(executionPage.items[0].stepId,'handoff');assert.equal(executionPage.page.nextOffset,1);
assert.equal((await call(`/v1/workflows/${initial.id}/executions?limit=1&offset=1`)).items[0].stepId,'assign');
const record=executions.items.find(e=>e.stepId==='handoff').result;
const task=executions.items.find(e=>e.stepId==='assign').result;
assert.equal((await call(`/v1/tasks/${task.id}`,'GET',undefined,200,'it-demo')).recordId,record.id);
assert.equal((await call(`/v1/records/${record.id}`,'GET',undefined,200,'it-demo')).id,record.id);
for(const peer of ['warehouse','warehouse-b','sales2']) {
  await call(`/v1/workflows/${initial.id}/executions`,'GET',undefined,404,peer);
  await call(`/v1/records/${record.id}`,'GET',undefined,404,peer);
}
assert.equal((await call(`/v1/workflows/${initial.id}/sync`)).items.length,1);
// Department mismatch, ambiguity and missing action role must not commit earlier steps.
async function unchanged(run,actor,status) {
  await call(`/v1/workflows/${run.id}/transitions`,'POST',{action:'dispatch',expectedVersion:1,input:{}},status,actor);
  assert.equal((await call(`/v1/workflows/${run.id}`,'GET',undefined,200,actor)).version,1);
  assert.equal((await call(`/v1/workflows/${run.id}/executions`,'GET',undefined,200,actor)).items.length,0);
}
const missing=await create(id,'warehouse');await unchanged(missing,'alice',400);
const denied=await create(id,'it',actors['it-demo'].subject,'sales2');await unchanged(denied,'sales2',403);
const personId='person-'+randomUUID().replaceAll('-','');
await publish(definition(personId,[steps[0],{id:'assign',action:'tasks.create',input:{title:literal('Explicit person task'),assigneeId:data('recipientId'),recordId:result('handoff')}}]));
const explicit=await create(personId);await call(`/v1/workflows/${explicit.id}/transitions`,'POST',command);
assert.equal((await call(`/v1/workflows/${explicit.id}/executions`)).items.length,2);
// A published alternate transition lets the user resolve ambiguity without changing this running version.
const manualId='manual-'+randomUUID().replaceAll('-','');
const autoSteps=[steps[0],{...steps[1],assignment:{kind:'department',department:data('departmentId'),role:'logistics:warehouse'}}];
const manual=definition(manualId,autoSteps);
manual.transitions.push({...manual.transitions[0],id:'dispatch_selected',fields:{chosenId:'subject'},steps:[autoSteps[0],{...autoSteps[1],assignment:{...autoSteps[1].assignment,assigneeId:{source:'input',field:'chosenId'}}}]});
await publish(manual);
const ambiguous=await create(manualId,'warehouse');await unchanged(ambiguous,'alice',409);
await call(`/v1/workflows/${ambiguous.id}/transitions`,'POST',{action:'dispatch_selected',expectedVersion:1,input:{chosenId:actors['it-demo'].subject}},400);
await call(`/v1/workflows/${ambiguous.id}/transitions`,'POST',{action:'dispatch_selected',expectedVersion:1,input:{chosenId:actors.warehouse.subject}});
const chosen=(await call(`/v1/workflows/${ambiguous.id}/executions`)).items.find(e=>e.stepId==='assign').result;
assert.equal((await call(`/v1/tasks/${chosen.id}`,'GET',undefined,200,'warehouse')).assigneeId,actors.warehouse.subject);
console.log(JSON.stringify({result:'Workflow blocks REST passed: department/person assignment, linked shared records, stable replay, scoped executions, signed action roles and outbox contract.',definitionId:id,runId:initial.id,recordId:record.id,taskId:task.id}));
// Real SQL fixtures live in a private schema; no production/demo rows are claimed or removed.
const sqlSource=`
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import pg from 'pg';
import {foundationDatabase} from './src/foundation-database.ts';
import {createDirectoryDatabase} from './src/directory-database.ts';
import {definitionDatabase} from './src/workflows/registry-database.ts';
import {workflowDatabase} from './src/workflows/database.ts';
import {workflowJobDatabase} from './src/workflows/job-database.ts';
import {drainOne,sendHttpEvent} from './src/workflows/outbox.ts';
(async()=>{
 const control=new pg.Pool({connectionString:process.env.DATABASE_URL});
 const schema='blocks_smoke_'+randomUUID().replaceAll('-','');
 let pool,server;
 try{
  await control.query('CREATE SCHEMA '+schema);
  pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,max:1,connectionTimeoutMillis:5000});
  await pool.query('CREATE TABLE records(id uuid PRIMARY KEY,title text NOT NULL,owner_id text NOT NULL,organization_id text,created_at timestamptz NOT NULL DEFAULT now())');
  await foundationDatabase(pool);const directory=await createDirectoryDatabase(pool);
  const registry=await definitionDatabase(pool),runtime=await workflowDatabase(pool,registry);
  const actor={subject:'actor',organizationId:'org-a',roles:['workflow:start','workflow:design','employee','records:write','tasks:assign','workflow:integrate']};
  const lit=value=>({source:'literal',value}),data=field=>({source:'data',field}),result=stepId=>({source:'result',stepId,field:'id'});
  const seed=async(subject,organization,department,enabled=true)=>pool.query('INSERT INTO directory_people(subject,organization_id,display_name,department_id,roles,enabled) VALUES($1,$2,$1,$3,$4,$5)',[subject,organization,department,JSON.stringify(['department:it']),enabled]);
  await seed('it-one','org-a','it');await seed('it-two','org-a','it');await seed('foreign','org-b','it');await seed('disabled','org-a','it',false);
  await pool.query("INSERT INTO workflow_references(organization_id,kind,id,name) VALUES('org-a','department','it','IT')");
  const defs={id:'handoff',title:'Handoff',startRole:'employee',initialState:'draft',startFields:{recipientId:'text'},readerRoles:[],transitions:[{id:'dispatch',from:'draft',to:'done',role:'employee',fields:{},steps:[
   {id:'record',action:'records.create',input:{title:lit('Employee handoff')}},
   ...['n8n','ngsi-ld','agent'].map((connector,i)=>({id:'connector'+i,action:'connectors.dispatch',input:{connectorId:lit(connector),operation:lit('employee.provision'),payload:{recordId:result('record')}}})),
   {id:'task',action:'tasks.create',input:{title:lit('Configure workspace'),recordId:result('record')},assignment:{kind:'department',department:lit('it'),role:'department:it'}}
  ]}]};
  await registry.create(defs,actor);await registry.publish(defs.id,1,actor);
  const run=await runtime.create({definitionId:defs.id,title:'Employee',input:{recipientId:'it-one'}},actor,randomUUID());
  const command={action:'dispatch',expectedVersion:1,input:{}};
  const counts=async()=> (await pool.query('SELECT (SELECT count(*)::int FROM records) AS records,(SELECT count(*)::int FROM foundation_tasks) AS tasks,(SELECT count(*)::int FROM workflow_jobs) AS jobs,(SELECT count(*)::int FROM workflow_action_results) AS executions')).rows[0];
  const before=await counts();
  await assert.rejects(()=>runtime.transition(run.id,command,actor,randomUUID()),e=>e.statusCode===409);
  assert.deepEqual(await counts(),before);assert.equal((await runtime.get(run.id,actor)).version,1);
  await assert.rejects(()=>runtime.transition(run.id,command,{...actor,roles:actor.roles.filter(r=>r!=='workflow:integrate')},randomUUID()),e=>e.statusCode===403);
  assert.deepEqual(await counts(),before);
  await pool.query("UPDATE directory_people SET enabled=false WHERE organization_id='org-a' AND subject='it-two'");
  const key=randomUUID(),next=await runtime.transition(run.id,command,actor,key);
  assert.equal(next.state,'done');const after=await counts();assert.equal(after.records,before.records+1);assert.equal(after.tasks,1);assert.equal(after.jobs,3);assert.equal(after.executions,5);
  assert.equal((await runtime.transition(run.id,command,actor,key)).version,next.version);assert.deepEqual(await counts(),after);
  await assert.rejects(()=>runtime.executions(run.id,{...actor,organizationId:'org-b'}),e=>e.statusCode===404);
  const rows=await runtime.executions(run.id,actor);assert.equal(rows.length,5);
  const task=rows.find(e=>e.stepId==='task').result;
  assert.equal((await pool.query('SELECT assignee_id FROM foundation_tasks WHERE id=$1',[task.id])).rows[0].assignee_id,'it-one');
  const concurrent=await runtime.create({definitionId:defs.id,title:'Concurrent',input:{recipientId:'it-one'}},actor,randomUUID());
  const replies=await Promise.allSettled(Array.from({length:5},()=>runtime.transition(concurrent.id,command,actor,randomUUID())));
  assert.equal(replies.filter(r=>r.status==='fulfilled').length,1);assert.ok(replies.filter(r=>r.status==='rejected').every(r=>r.reason.statusCode===409));
  const person={...defs,id:'person',transitions:[{...defs.transitions[0],steps:[defs.transitions[0].steps[0],{id:'task',action:'tasks.create',input:{title:lit('Explicit task'),assigneeId:data('recipientId'),recordId:result('record')}}]}]};
  await registry.create(person,actor);await registry.publish(person.id,1,actor);
  for(const subject of ['foreign','disabled','missing']){
   const r=await runtime.create({definitionId:person.id,title:'Denied',input:{recipientId:subject}},actor,randomUUID()),snapshot=await counts();
   await assert.rejects(()=>runtime.transition(r.id,command,actor,randomUUID()),e=>e.statusCode===400);
   assert.deepEqual(await counts(),snapshot);
  }
  const selected={...person,id:'selected',transitions:[{...person.transitions[0],steps:[person.transitions[0].steps[0],{...person.transitions[0].steps[1],input:{title:lit('Department selection'),recordId:result('record')},assignment:{kind:'department',department:lit('it'),role:'department:it',assigneeId:data('recipientId')}}]}]};
  await registry.create(selected,actor);await registry.publish(selected.id,1,actor);
  await seed('other-department','org-a','hr');
  for(const subject of ['foreign','disabled','missing','other-department','it-two']){
   const r=await runtime.create({definitionId:selected.id,title:'Denied selection',input:{recipientId:subject}},actor,randomUUID()),snapshot=await counts();
   await assert.rejects(()=>runtime.transition(r.id,command,actor,randomUUID()),e=>e.statusCode===400);assert.deepEqual(await counts(),snapshot);
  }
  await pool.query("UPDATE directory_people SET enabled=true WHERE organization_id='org-a' AND subject='it-two'");
  const chosenRun=await runtime.create({definitionId:selected.id,title:'Manual choice from two members',input:{recipientId:'it-one'}},actor,randomUUID());
  await runtime.transition(chosenRun.id,command,actor,randomUUID());
  await pool.query("UPDATE directory_people SET enabled=false WHERE organization_id='org-a' AND subject IN ('it-two','other-department')");
  // Verify all three adapter identities reach a controlled receiver through the existing worker.
  const messages=[];
  server=createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;messages.push({body:JSON.parse(body),key:req.headers['idempotency-key'],auth:req.headers.authorization});res.end('ok');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url='http://127.0.0.1:'+server.address().port,worker=workflowJobDatabase(pool);
  for(let i=0;i<6;i++)await drainOne(worker,job=>sendHttpEvent(job,url,'local-test-token'));
  assert.equal(messages.length,6);
  assert.deepEqual([...new Set(messages.map(m=>m.body.connectorId))].sort(),['agent','n8n','ngsi-ld']);
  assert.ok(messages.every(m=>m.key===m.body.eventId&&m.auth==='Bearer local-test-token'));
  // Produce over 100 real successful execution rows through the engine, then page through API repository SQL.
  const paging={...defs,id:'paging',transitions:[defs.transitions[0],{...defs.transitions[0],id:'repeat',from:'done'}]};
  await registry.create(paging,actor);await registry.publish(paging.id,1,actor);
  let pageRun=await runtime.create({definitionId:paging.id,title:'Execution pagination',input:{recipientId:'it-one'}},actor,randomUUID());
  for(let i=0;i<21;i++)pageRun=await runtime.transition(pageRun.id,{action:i?'repeat':'dispatch',expectedVersion:pageRun.version,input:{}},actor,randomUUID());
  const first=await runtime.executions(pageRun.id,actor,{limit:100,offset:0,q:''});
  const second=await runtime.executions(pageRun.id,actor,{limit:100,offset:100,q:''});
  assert.equal(first.length,101);assert.equal(second.length,5);
  const visible=[...first.slice(0,100),...second];
  assert.equal(new Set(visible.map(e=>e.version+':'+e.stepId)).size,105);
  assert.ok(visible.every((e,i)=>i===0||e.version>visible[i-1].version||e.stepIndex>visible[i-1].stepIndex));
  const pages=await directory.departments('org-a',{limit:1,offset:0,role:'department:it'});
  assert.equal(pages.items[0].id,'it');assert.equal(pages.items[0].memberCount,1);
  for(let i=0;i<105;i++)await seed('member'+i,'org-a','dep'+String(i).padStart(3,'0'));
  const deptFirst=await directory.departments('org-a',{limit:100,offset:0,role:'department:it'});
  const deptSecond=await directory.departments('org-a',{limit:100,offset:deptFirst.page.nextOffset,role:'department:it'});
  assert.equal(deptFirst.items.length,100);assert.equal(deptSecond.items.length,6);assert.equal(deptSecond.page.nextOffset,null);
  assert.equal(new Set([...deptFirst.items,...deptSecond.items].map(d=>d.id)).size,106);
  console.log('Isolated SQL blocks passed: full rollback, action roles, department ambiguity, disabled/foreign recipients, exact replay, 5-way concurrency with one connection, 105 execution/106 department pagination, scoped evidence and controlled delivery of all 3 adapter contracts.');
 }finally{
  if(server)await new Promise(resolve=>server.close(resolve));await pool?.end();
  if(!/^blocks_smoke_[a-f0-9]{32}$/.test(schema))throw new Error('Unsafe smoke schema');
  await control.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await control.end();
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
`;
console.log(execFileSync('docker',['--context','desktop-linux','compose','-f','infra/compose/core.yml','exec','-T','-w','/app/apps/api','api','pnpm','exec','tsx','--eval',sqlSource],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:90000}).trim());
