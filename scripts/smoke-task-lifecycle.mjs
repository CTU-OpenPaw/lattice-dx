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

const root=fileURLToPath(new URL('../',import.meta.url));
const actors={};
for(const username of ['alice','warehouse','sales2']){
 const response=await fetch('http://localhost:8081/realms/lattice/protocol/openid-connect/token',{
  method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
  body:new URLSearchParams({grant_type:'password',client_id:'dx-local',username,password:`local-${username}-password`})});
 assert.equal(response.status,200);const token=(await response.json()).access_token;
 actors[username]={token,subject:JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString()).sub};
}
async function call(path,method='GET',body,expected=200,user='alice',key=randomUUID()){
 const response=await fetch('http://localhost:8080'+path,{method,
  headers:{authorization:`Bearer ${actors[user].token}`,'content-type':'application/json','Idempotency-Key':key},
  ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});
 const result=await response.json();assert.equal(response.status,expected,`${user} ${method} ${path}: ${JSON.stringify(result)}`);return result;
}
const record=await call('/v1/records','POST',{title:'Task lifecycle '+randomUUID()},201);
let task=await call('/v1/task-queues','POST',{title:'Kho nhận việc',departmentId:'warehouse',recordId:record.id},201);
assert.ok((await call('/v1/task-queues','GET',undefined,200,'warehouse')).items.some(row=>row.id===task.id));
await call('/v1/records/'+record.id,'GET',undefined,404,'warehouse');
await call(`/v1/tasks/${task.id}/claim`,'POST',{expectedVersion:task.version},404,'sales2');
const claim={expectedVersion:task.version},claimKey=randomUUID();
task=await call(`/v1/tasks/${task.id}/claim`,'POST',claim,200,'warehouse',claimKey);
assert.equal(task.assigneeId,actors.warehouse.subject);
assert.deepEqual(await call(`/v1/tasks/${task.id}/claim`,'POST',claim,200,'warehouse',claimKey),task);
await call('/v1/records/'+record.id,'GET',undefined,200,'warehouse');
task=await call(`/v1/tasks/${task.id}/reassign`,'POST',{expectedVersion:task.version,assigneeId:actors.sales2.subject,reason:'Chuyển người xử lý'});
await call('/v1/records/'+record.id,'GET',undefined,404,'warehouse');
await call(`/v1/tasks/${task.id}/claim`,'POST',claim,404,'warehouse',claimKey);
await call('/v1/records/'+record.id,'GET',undefined,200,'sales2');
task=await call(`/v1/tasks/${task.id}/deadline`,'POST',{expectedVersion:task.version,dueAt:new Date(Date.now()+86400000).toISOString()});
assert.ok(task.dueAt);
const cancel={expectedVersion:task.version,reason:'Không còn cần xử lý'},cancelKey=randomUUID();
task=await call(`/v1/tasks/${task.id}/cancel`,'POST',cancel,200,'alice',cancelKey);
assert.equal(task.status,'cancelled');
assert.deepEqual(await call(`/v1/tasks/${task.id}/cancel`,'POST',cancel,200,'alice',cancelKey),task);
await call('/v1/records/'+record.id,'GET',undefined,404,'sales2');
const history=await call(`/v1/tasks/${task.id}/history?limit=2`);
assert.equal(history.items.length,2);assert.ok(history.page.hasMore);
assert.ok(history.items.every(row=>!Object.hasOwn(row,'result')&&!Object.hasOwn(row,'input')));

const sqlSource=`
import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import pg from 'pg';
import {recordDatabase} from './src/database.ts';import {foundationDatabase} from './src/foundation-database.ts';
import {createDirectoryDatabase} from './src/directory-database.ts';import {createWorkflowTables} from './src/workflows/schema.ts';
import {taskLifecycleDatabase} from './src/tasks/database.ts';
(async()=>{const control=new pg.Pool({connectionString:process.env.DATABASE_URL});
 const schema='task_smoke_'+randomUUID().replaceAll('-','');let pool;
 try{
  await control.query('CREATE SCHEMA '+schema);pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,max:5,connectionTimeoutMillis:5000});
  const records=await recordDatabase(pool);await createDirectoryDatabase(pool);const foundation=await foundationDatabase(pool);await createWorkflowTables(pool);
  let repo=await taskLifecycleDatabase(pool);
  const owner={subject:'owner',organizationId:'a'},first={subject:'first',organizationId:'a'},second={subject:'second',organizationId:'a'},foreign={subject:'first',organizationId:'b'};
  for(const [id,org,dept] of [['owner','a','sales'],['first','a','warehouse'],['second','a','warehouse'],['first','b','warehouse']])await pool.query('INSERT INTO directory_people(subject,organization_id,display_name,department_id,enabled) VALUES($1,$2,$1,$3,true)',[id,org,dept]);
  const record=await records.create('Evidence',owner.subject,owner.organizationId);
  const file=await foundation.createFile({filename:'evidence.txt',ownerId:owner.subject,organizationId:'a',recordId:record.id,content:Buffer.from('Evidence')});
  let task=await repo.createQueue(owner,{title:'Queue',departmentId:'warehouse',recordId:record.id},'create');
  const claims=await Promise.allSettled([repo.claim(task.id,first,{expectedVersion:task.version},'first-claim'),repo.claim(task.id,second,{expectedVersion:task.version},'second-claim')]);
  assert.equal(claims.filter(result=>result.status==='fulfilled').length,1);assert.equal(claims.find(result=>result.status==='rejected').reason.statusCode,409);
  task=claims.find(result=>result.status==='fulfilled').value;
  const winner=task.assigneeId==='first'?first:second,loser=task.assigneeId==='first'?second:first;
  assert.ok(await records.findReadable(record.id,winner.subject,'a'));assert.equal(await records.findReadable(record.id,loser.subject,'a'),undefined);
  assert.ok(await foundation.readTaskFile(file.id,winner));assert.equal(await foundation.readTaskFile(file.id,loser),undefined);
  await assert.rejects(()=>repo.reassign(task.id,foreign,{expectedVersion:task.version,assigneeId:loser.subject,reason:'Foreign'},'foreign'),e=>e.statusCode===404);
  const input={expectedVersion:task.version,assigneeId:loser.subject,reason:'Transfer'};
  task=await repo.reassign(task.id,owner,input,'transfer');
  assert.equal(await records.findReadable(record.id,winner.subject,'a'),undefined);assert.ok(await records.findReadable(record.id,loser.subject,'a'));
  assert.equal(await foundation.readTaskFile(file.id,winner),undefined);assert.ok(await foundation.readTaskFile(file.id,loser));
  await assert.rejects(()=>repo.claim(task.id,winner,{expectedVersion:1},winner.subject+'-claim'),e=>e.statusCode===404);
  const version=task.version,historyBefore=(await repo.history(task.id,owner,{limit:100,offset:0,q:''})).items.length;
  await pool.query('ALTER TABLE task_lifecycle_commands ADD CONSTRAINT task_fail_receipt CHECK(false) NOT VALID');
  await assert.rejects(()=>repo.cancel(task.id,owner,{expectedVersion:version,reason:'Cancel'},'cancel'));
  assert.equal((await repo.history(task.id,owner,{limit:100,offset:0,q:''})).items.length,historyBefore);
  assert.equal((await pool.query('SELECT version FROM foundation_tasks WHERE id=$1',[task.id])).rows[0].version,version);
  await pool.query('ALTER TABLE task_lifecycle_commands DROP CONSTRAINT task_fail_receipt');
  task=await repo.cancel(task.id,owner,{expectedVersion:version,reason:'Cancel'},'cancel');
  assert.equal(await records.findReadable(record.id,loser.subject,'a'),undefined);
  assert.equal(await foundation.readTaskFile(file.id,loser),undefined);
  const linkedRecord=await records.create('Workflow protected',owner.subject,'a');
  const linkedTask=await foundation.createTask({title:'Protected',assigneeId:first.subject,organizationId:'a',createdBy:owner.subject,recordId:linkedRecord.id});
  await pool.query("INSERT INTO workflow_runs(id,definition_id,definition_version,title,owner_id,organization_id,state) VALUES($1,'fixture',1,'Fixture','owner','a','pending')",[linkedRecord.id]);
  await pool.query('INSERT INTO workflow_task_links(run_id,task_id) VALUES($1,$2)',[linkedRecord.id,linkedTask.id]);
  await assert.rejects(()=>repo.cancel(linkedTask.id,owner,{expectedVersion:1,reason:'Guard'},'linked-cancel'),e=>e.statusCode===409);
  const raceTask=await repo.createQueue(owner,{title:'Lifecycle race',departmentId:'warehouse'},'race-create');
  const assigned=await repo.claim(raceTask.id,first,{expectedVersion:1},'race-claim');
  const changes=await Promise.allSettled([repo.cancel(assigned.id,owner,{expectedVersion:assigned.version,reason:'Race'},'race-cancel'),repo.reassign(assigned.id,owner,{expectedVersion:assigned.version,assigneeId:second.subject,reason:'Race'},'race-transfer')]);
  assert.equal(changes.filter(row=>row.status==='fulfilled').length,1);assert.equal(changes.find(row=>row.status==='rejected').reason.statusCode,409);
  const prefix='Queue page '+randomUUID();
  for(let i=0;i<105;i++)await repo.createQueue(owner,{title:prefix+' '+i,departmentId:'warehouse'},'page-'+i);
  const firstPage=await repo.queue(first,{limit:100,offset:0,q:prefix}),secondPage=await repo.queue(first,{limit:100,offset:firstPage.page.nextOffset,q:prefix});
  assert.equal(firstPage.items.length,100);assert.equal(secondPage.items.length,5);assert.equal(new Set([...firstPage.items,...secondPage.items].map(row=>row.id)).size,105);
  await pool.query('UPDATE directory_people SET enabled=false WHERE subject=$1 AND organization_id=$2',['first','a']);
  assert.equal((await repo.queue(first,{limit:100,offset:0,q:prefix})).items.length,0);
  await assert.rejects(()=>repo.claim(firstPage.items[0].id,first,{expectedVersion:1},'disabled-claim'),e=>e.statusCode===404);
  await assert.rejects(()=>repo.reassign(linkedTask.id,owner,{expectedVersion:1,assigneeId:first.subject,reason:'Disabled'},'disabled-transfer'),e=>e.statusCode===409);
  const ordinary=await foundation.createTask({title:'Ordinary',assigneeId:second.subject,organizationId:'a',createdBy:owner.subject});
  await assert.rejects(()=>repo.reassign(ordinary.id,owner,{expectedVersion:ordinary.version,assigneeId:first.subject,reason:'Disabled'},'disabled-ordinary'),e=>e.statusCode===400);
  await pool.query('UPDATE directory_people SET enabled=true WHERE subject=$1 AND organization_id=$2',['first','a']);
  const due=new Date(Date.now()+86400000).toISOString();
  let scheduled=await repo.setDeadline(ordinary.id,owner,{expectedVersion:ordinary.version,dueAt:due},'due');
  assert.equal(scheduled.dueAt,due);
  scheduled=await repo.setDeadline(ordinary.id,owner,{expectedVersion:scheduled.version,dueAt:null},'clear-due');assert.equal(scheduled.dueAt,null);
  await assert.rejects(()=>repo.setDeadline(ordinary.id,owner,{expectedVersion:scheduled.version,dueAt:'2026-02-30T00:00:00Z'},'invalid-date'),e=>e.statusCode===400);
  await assert.rejects(()=>repo.setDeadline(ordinary.id,owner,{expectedVersion:scheduled.version,dueAt:new Date(Date.now()+367*86400000).toISOString()},'too-far'),e=>e.statusCode===400);
  for(let i=0;i<105;i++)scheduled=await repo.setDeadline(ordinary.id,owner,{expectedVersion:scheduled.version,dueAt:null},'history-'+i);
  const h1=await repo.history(ordinary.id,owner,{limit:100,offset:0,q:''}),h2=await repo.history(ordinary.id,owner,{limit:100,offset:h1.page.nextOffset,q:''});
  assert.equal(h1.items.length,100);assert.equal(h2.items.length,7);assert.equal(new Set([...h1.items,...h2.items].map(row=>row.id)).size,107);
  const replayInput={title:'Replay authority',departmentId:'warehouse'},replayTask=await repo.createQueue(owner,replayInput,'authority-create');
  await pool.query('UPDATE foundation_tasks SET created_by=$1 WHERE id=$2',[second.subject,replayTask.id]);
  await assert.rejects(()=>repo.createQueue(owner,replayInput,'authority-create'),e=>e.statusCode===404);
  await assert.rejects(()=>repo.createQueue(owner,{...replayInput,title:'Altered'},'authority-create'),e=>e.statusCode===404);
  await pool.query('UPDATE foundation_tasks SET created_by=$1 WHERE id=$2',[owner.subject,replayTask.id]);
  await assert.rejects(()=>repo.createQueue(owner,{...replayInput,title:'Altered'},'authority-create'),e=>e.statusCode===409);
  await pool.end();pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,max:1});repo=await taskLifecycleDatabase(pool);
  assert.deepEqual(await repo.cancel(task.id,owner,{expectedVersion:version,reason:'Cancel'},'cancel'),task);
  assert.ok((await repo.history(task.id,owner,{limit:100,offset:0,q:''})).items.length>historyBefore);
  console.log('Task lifecycle SQL passed: queue claim race, tenant isolation, transfer/replay revocation, cancellation evidence removal, atomic audit/receipt rollback and max1 persistence.');
 }finally{await pool?.end();if(!/^task_smoke_[a-f0-9]{32}$/.test(schema))throw new Error('Unsafe schema');await control.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await control.end();}
})().catch(error=>{console.error(error);process.exitCode=1;});
`;
console.log(execFileSync('docker',['--context','desktop-linux','compose','-f','infra/compose/core.yml','exec','-T','-w','/app/apps/api','api','pnpm','exec','tsx','--eval',sqlSource],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:90000}).trim());
console.log(JSON.stringify({result:'Task lifecycle HTTP passed',taskId:task.id,recordId:record.id}));
