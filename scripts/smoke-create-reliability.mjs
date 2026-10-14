// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const base='http://localhost:8080',tokens={};
for(const username of ['alice','bob']){
 const r=await fetch('http://localhost:8081/realms/lattice/protocol/openid-connect/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'password',client_id:'dx-local',username,password:`local-${username}-password`}),signal:AbortSignal.timeout(15000)});
 assert.equal(r.status,200,`Login ${username}`);tokens[username]=(await r.json()).access_token;
}
const aliceId=JSON.parse(Buffer.from(tokens.alice.split('.')[1],'base64url').toString()).sub;
async function call(path,method='POST',body,expected=200,key,actor='alice'){
 const r=await fetch(base+path,{method,headers:{authorization:`Bearer ${tokens[actor]}`,'content-type':'application/json',...(key===undefined?{}:{'Idempotency-Key':key})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});
 const result=await r.json();assert.equal(r.status,expected,`${actor} ${method} ${path}: ${JSON.stringify(result)}`);return result;
}
const recordKey=randomUUID();
const record=await call('/v1/records','POST',{title:'  Reliable intake  '},201,recordKey);
const replay=await call('/v1/actions/records.create/run','POST',{version:1,input:{title:'Reliable intake'}},200,recordKey);
assert.deepEqual(replay.result,record);
await call('/v1/records','POST',{title:'Changed input'},409,recordKey);
await call('/v1/actions/records.create/run','POST',{version:1,input:{title:'Reliable intake'}},403,recordKey,'bob');
for(const path of ['/v1/records','/v1/tasks']){
 const body=path.endsWith('tasks')?{title:'Bad',assigneeId:aliceId}:{title:'Bad'};
 await call(path,'POST',{...body,organizationId:'org-b'},400);
 await call(path,'POST',body,400,'invalid,key');
}
const taskKey=randomUUID(),taskInput={title:'Review reliable intake',assigneeId:aliceId,recordId:record.id};
const task=(await call('/v1/actions/tasks.create/run','POST',{version:1,input:taskInput},200,taskKey)).result;
assert.deepEqual(await call('/v1/tasks','POST',{...taskInput,recordId:record.id.toUpperCase()},201,taskKey),task);
await call('/v1/tasks','POST',{...taskInput,title:'Different'},409,taskKey);
const decisions=await call(`/v1/tasks/${task.id}/decisions`,'POST',{decision:'approve',expectedVersion:1});
assert.equal(decisions.status,'approved');
assert.equal((await call('/v1/tasks','POST',taskInput,201,taskKey)).status,'pending');
assert.equal((await call(`/v1/tasks/${task.id}`,'GET')).status,'approved');
const taskUsingRecordKey=await call('/v1/tasks','POST',taskInput,201,recordKey);
assert.notEqual(taskUsingRecordKey.id,record.id);
const unkeyed=await Promise.all([1,2].map(()=>call('/v1/records','POST',{title:'Intentional repeat'},201)));
assert.notEqual(unkeyed[0].id,unkeyed[1].id);
const concurrentKey=randomUUID();
const concurrent=await Promise.all(Array.from({length:5},()=>call('/v1/records','POST',{title:'Concurrent record'},201,concurrentKey)));
assert.equal(new Set(concurrent.map(r=>r.id)).size,1);

const sqlSource=`
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {recordDatabase} from './src/database.ts';
import {foundationDatabase} from './src/foundation-database.ts';
import {createDirectoryDatabase} from './src/directory-database.ts';
import {createWorkflowTables} from './src/workflows/schema.ts';
(async()=>{
 const control=new pg.Pool({connectionString:process.env.DATABASE_URL});
 const schema='create_smoke_'+randomUUID().replaceAll('-','');let pool;
 try{
  await control.query('CREATE SCHEMA '+schema);
  pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,max:5,connectionTimeoutMillis:5000});
  let records=await recordDatabase(pool);await createDirectoryDatabase(pool);
  let foundation=await foundationDatabase(pool);await createWorkflowTables(pool);
  for(const [actor,org] of [['actor-a','org-a'],['actor-b','org-a'],['actor-a','org-b']])await pool.query('INSERT INTO directory_people(subject,organization_id,display_name,enabled) VALUES($1,$2,$1,true)',[actor,org]);
  const first=await records.create('Created snapshot','actor-a','org-a','scope-key');
  assert.deepEqual(await records.create('Created snapshot','actor-a','org-a','scope-key'),first);
  await assert.rejects(()=>records.create('Changed','actor-a','org-a','scope-key'),e=>e.statusCode===409);
  const otherActor=await records.create('Created snapshot','actor-b','org-a','scope-key');
  const otherOrg=await records.create('Created snapshot','actor-a','org-b','scope-key');
  assert.equal(new Set([first.id,otherActor.id,otherOrg.id]).size,3);
  const input={title:'Task snapshot',assigneeId:'actor-a',createdBy:'actor-a',organizationId:'org-a',recordId:first.id};
  const task=await foundation.createTask(input,'scope-key');assert.notEqual(task.id,first.id);
  const race=await Promise.all(Array.from({length:5},()=>foundation.createTask(input,'race-equal')));
  assert.equal(new Set(race.map(t=>t.id)).size,1);
  const mixed=await Promise.allSettled(Array.from({length:5},(_,i)=>foundation.createTask({...input,title:'Race '+i},'race-different')));
  assert.equal(mixed.filter(r=>r.status==='fulfilled').length,1);
  assert.ok(mixed.filter(r=>r.status==='rejected').every(r=>r.reason.statusCode===409));
  await foundation.decideTask(task.id,{subject:'actor-a',organizationId:'org-a'},'approve','',1);
  assert.equal((await foundation.createTask(input,'scope-key')).status,'pending');
  assert.equal((await foundation.readTask(task.id,{subject:'actor-a',organizationId:'org-a'})).status,'approved');
  await pool.query('UPDATE directory_people SET enabled=false WHERE subject=$1 AND organization_id=$2',['actor-a','org-a']);
  await assert.rejects(()=>foundation.createTask(input,'scope-key'),e=>e.statusCode===400);
  await pool.query('UPDATE directory_people SET enabled=true WHERE subject=$1 AND organization_id=$2',['actor-a','org-a']);
  await pool.query('UPDATE records SET owner_id=$1 WHERE id=$2',['actor-b',first.id]);
  await assert.rejects(()=>foundation.createTask(input,'scope-key'),e=>e.statusCode===404);
  await pool.query('UPDATE records SET owner_id=$1 WHERE id=$2',['actor-a',first.id]);
  await assert.rejects(()=>foundation.createTask({...input,assigneeId:'missing'},'failure-key'),e=>e.statusCode===400);
  const recovered=await foundation.createTask(input,'failure-key');assert.ok(recovered.id);
  const before=(await pool.query('SELECT count(*)::integer AS count FROM records')).rows[0].count;
  const taskCountBefore=(await pool.query('SELECT count(*)::integer AS count FROM foundation_tasks')).rows[0].count;
  await pool.query('ALTER TABLE foundation_create_commands ADD CONSTRAINT smoke_fail_receipt CHECK (false) NOT VALID');
  await assert.rejects(()=>records.create('Must rollback','actor-a','org-a','rollback-key'));
  await assert.rejects(()=>foundation.createTask(input,'task-rollback-key'));
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM records')).rows[0].count,before);
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM foundation_tasks')).rows[0].count,taskCountBefore);
  await pool.query('ALTER TABLE foundation_create_commands DROP CONSTRAINT smoke_fail_receipt');
  assert.ok((await foundation.createTask(input,'task-rollback-key')).id);
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM foundation_tasks')).rows[0].count,taskCountBefore+1);
  const recoveredRecord=await records.create('Must rollback','actor-a','org-a','rollback-key');assert.ok(recoveredRecord.id);
  const after=(await pool.query('SELECT count(*)::integer AS count FROM records')).rows[0].count;assert.equal(after,before+1);
  await pool.end();
  pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,max:1,connectionTimeoutMillis:5000});
  records=await recordDatabase(pool);foundation=await foundationDatabase(pool);
  assert.deepEqual(await records.create('Created snapshot','actor-a','org-a','scope-key'),first);
  assert.deepEqual(await foundation.createTask(input,'scope-key'),task);
  const single=await Promise.all(Array.from({length:5},()=>records.create('Single connection','actor-a','org-a','single-pool')));
  assert.equal(new Set(single.map(r=>r.id)).size,1);
  console.log('Create SQL passed: actor/org/operation isolation, multi-connection races, current references before replay, snapshot after decision, forced receipt failure rollback/recovery, fresh pool and max1 execution.');
 }finally{
  await pool?.end();if(!/^create_smoke_[a-f0-9]{32}$/.test(schema))throw new Error('Unsafe private schema');
  await control.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await control.end();
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
`;
console.log(execFileSync('docker',['--context','desktop-linux','compose','-f','infra/compose/core.yml','exec','-T','-w','/app/apps/api','api','pnpm','exec','tsx','--eval',sqlSource],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:90000}).trim());
console.log('Create reliability smoke passed: cross REST/action replay, conflict, authority denial, strict inputs, no-key compatibility, task snapshot and current detail.');
console.log(JSON.stringify({recordId:record.id,taskId:task.id,concurrentRecordId:concurrent[0].id,note:'Retained scoped local demo data'}));
