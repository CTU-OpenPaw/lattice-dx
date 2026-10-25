// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
const root=fileURLToPath(new URL('../',import.meta.url)),base='http://localhost:8080';
const actors={};
for(const name of ['alice','bob','manager','warehouse','warehouse2','hr-demo','it-demo','administration','receiver']) {
  const r=await fetch('http://localhost:8081/realms/lattice/protocol/openid-connect/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'password',client_id:'dx-local',username:name,password:`local-${name}-password`}),signal:AbortSignal.timeout(15000)});
  assert.equal(r.status,200,`Login ${name}`);const {access_token}=await r.json();
  actors[name]={token:access_token,subject:JSON.parse(Buffer.from(access_token.split('.')[1],'base64url').toString()).sub};
}
async function request(path,actor='alice',body,expected=200,key=randomUUID()) {
  const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${actors[actor].token}`,'content-type':'application/json','Idempotency-Key':key},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
  assert.equal(response.status,expected,`${actor} ${path}: expected ${expected}, got ${response.status}`);
  if(path.endsWith('/content'))return response.text();
  return response.json();
}
const create=(actor,definitionId='procurement',input={},key=randomUUID(),title='Workflow acceptance '+randomUUID(),expected=201)=>request('/v1/workflows',actor,{definitionId,title,input},expected,key);
const transition=(run,actor,action,input={},expected=200,key=randomUUID())=>request(`/v1/workflows/${run.id}/transitions`,actor,{action,expectedVersion:run.version,input},expected,key);
const history=run=>request(`/v1/workflows/${run.id}/history`);
const get=run=>request(`/v1/workflows/${run.id}`);
async function unchanged(run,actor,action,input,status) {await transition(run,actor,action,input,status);const after=await get(run);assert.equal(after.version,run.version);assert.equal(after.state,run.state);}
async function upload(actor,infected=false) {return request('/v1/files',actor,{filename:'workflow-evidence.txt',contentBase64:infected?'WDVPIVAlQEFQWzRcUFpYNTQoUF4pN0NDKTd9JEVJQ0FSLVNUQU5EQVJELUFOVElWSVJVUy1URVNULUZJTEUhJEgrSCo=':Buffer.from('Workflow clean evidence').toString('base64')},201);}
for(const name of Object.keys(actors))await request('/v1/workflow-members/me',name,{});
const definitions=await request('/v1/workflow-definitions');assert.ok(definitions.items.some(d=>d.id==='procurement'));
const key=randomUUID(),title='Procurement acceptance '+randomUUID();let run=await create('alice','procurement',{},key,title);
assert.equal((await create('alice','procurement',{},key,title)).id,run.id);
await create('alice','procurement',{},key,title+' conflict',409);
await request(`/v1/workflows/${run.id}`,'bob',undefined,404);await request(`/v1/workflows/${run.id}`,'receiver',undefined,404);
await create('bob','procurement',{},randomUUID(),'Denied start',403);
const receipt=await upload('warehouse'),rejected=await upload('warehouse',true),foreign=await upload('administration');
assert.equal(receipt.scanStatus,'clean');assert.equal(rejected.scanStatus,'rejected');assert.equal(foreign.scanStatus,'clean');
await unchanged(run,'warehouse','receive',{receiptAttachmentId:receipt.id},409);
await unchanged(run,'warehouse','approve',{},403);
run=await transition(run,'alice','submit');
assert.ok((await request('/v1/workflows?inbox=true','manager')).items.some(r=>r.id===run.id));
await unchanged(run,'manager','reject',{},400);
const approval={action:'approve',expectedVersion:run.version,input:{}},keys=[randomUUID(),randomUUID()];
const replies=await Promise.all(keys.map(k=>fetch(`${base}/v1/workflows/${run.id}/transitions`,{method:'POST',headers:{authorization:`Bearer ${actors.manager.token}`,'content-type':'application/json','Idempotency-Key':k},body:JSON.stringify(approval),signal:AbortSignal.timeout(30000)})));
assert.deepEqual(replies.map(r=>r.status).sort(),[200,409]);const winner=replies.findIndex(r=>r.status===200);run=await replies[winner].json();
assert.equal((await request(`/v1/workflows/${run.id}/transitions`,'manager',approval,200,keys[winner])).version,run.version);
assert.equal((await history(run)).items.length,3);
assert.ok((await request('/v1/workflows?inbox=true','warehouse')).items.some(r=>r.id===run.id));
await unchanged(run,'warehouse','receive',{receiptAttachmentId:rejected.id},400);await unchanged(run,'warehouse','receive',{receiptAttachmentId:foreign.id},400);
run=await transition(run,'warehouse','receive',{receiptAttachmentId:receipt.id});
assert.equal(await request(`/v1/files/${receipt.id}/content`,'warehouse2'),'Workflow clean evidence');
await request(`/v1/files/${receipt.id}/content`,'receiver',undefined,404);await request(`/v1/files/${receipt.id}/content`,'bob',undefined,404);
await request(`/v1/files/${receipt.id}/content`,'it-demo',undefined,404);
const handover={assetId:'urn:ngsi-ld:Asset:org-a:'+randomUUID(),recipientId:actors.receiver.subject,departmentId:'warehouse',locationId:'office-1',attachmentId:receipt.id};
await unchanged(run,'warehouse2','handover',handover,409);
run=await transition(run,'warehouse','accept',{acceptanceNote:'Checked quantity and condition'});
for(const patch of [{recipientId:'unregistered-'+randomUUID()},{recipientId:actors.bob.subject},{departmentId:'missing-department'},{locationId:'missing-location'},{attachmentId:foreign.id},{attachmentId:rejected.id}])await unchanged(run,'warehouse2','handover',{...handover,...patch},400);
const handoverKey=randomUUID(),handoverCommand={action:'handover',expectedVersion:run.version,input:handover};
run=await transition(run,'warehouse2','handover',handover,200,handoverKey);
await request(`/v1/workflows/${run.id}/transitions`,'warehouse2',handoverCommand,200,handoverKey);
const jobs=(await request(`/v1/workflows/${run.id}/sync`,'manager')).items;assert.equal(jobs.length,1);assert.equal(jobs[0].status,'pending');
const audit=(await history(run)).items;
const states=['draft','submitted','approved','received','accepted','handed_over'],names=['alice','alice','manager','warehouse','warehouse','warehouse2'];
assert.equal(audit.length,states.length);for(let i=0;i<audit.length;i++){assert.equal(audit[i].version,i+1);assert.equal(audit[i].actorId,actors[names[i]].subject);assert.equal(audit[i].fromState,i?states[i-1]:null);assert.equal(audit[i].toState,states[i]);assert.ok(!Number.isNaN(Date.parse(audit[i].occurredAt)));}
// Read only this acceptance's own event. This does not deliver or claim a public job.
const handoverEvent=JSON.parse(containerEval(`
import pg from 'pg';
(async()=>{const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});const client=await pool.connect();try{
 await client.query('BEGIN READ ONLY');
 const rows=(await client.query('SELECT payload FROM workflow_jobs WHERE id=$1 AND run_id=$2 AND organization_id=$3',[${JSON.stringify(jobs[0].id)},${JSON.stringify(run.id)},${JSON.stringify(run.organizationId)}])).rows;
 if(rows.length!==1)throw Error('Expected one handover event');
 await client.query('COMMIT');process.stdout.write(JSON.stringify(rows[0].payload));
}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();await pool.end();}})().catch(()=>{console.error('Own handover event read failed');process.exitCode=1});`));
assert.deepEqual(handoverEvent,{eventId:jobs[0].id,eventType:'asset.handed_over',organizationId:run.organizationId,runId:run.id,recordId:run.recordId,definitionId:'procurement',version:run.version,occurredAt:run.updatedAt,data:run.data});
assert.equal(run.state,'handed_over');assert.equal(run.version,6);
assert.equal(handoverEvent.occurredAt,audit.at(-1).occurredAt);
for(const [field,value] of Object.entries(handover))assert.equal(handoverEvent.data[field],value);
assert.equal(handoverEvent.data.receiptAttachmentId,receipt.id);
assert.equal(handoverEvent.data.acceptanceNote,'Checked quantity and condition');
for(const path of [`/v1/workflows/${run.id}/history`,`/v1/workflows/${run.id}/history/${audit[0].id}`])for(const method of ['POST','PUT','PATCH','DELETE']) {
  const response=await fetch(base+path,{method,headers:{authorization:`Bearer ${actors.manager.token}`,'content-type':'application/json'},body:JSON.stringify({action:'tampered',toState:'draft'}),signal:AbortSignal.timeout(30000)});
  assert.equal(response.status,404,`${method} history must have no mutation route`);
}
assert.deepEqual((await history(run)).items,audit);
let denied=await create('alice');denied=await transition(denied,'alice','submit');denied=await transition(denied,'manager','reject',{reason:'Budget unavailable'});assert.equal(denied.data.reason,'Budget unavailable');assert.equal((await history(denied)).items.at(-1).action,'reject');
await create('hr-demo','onboarding',{recipientId:actors.bob.subject},randomUUID(),'Foreign recipient',400);
let onboarding=await create('hr-demo','onboarding',{recipientId:actors.receiver.subject});onboarding=await transition(onboarding,'hr-demo','submit');onboarding=await transition(onboarding,'manager','approve');onboarding=await transition(onboarding,'it-demo','provision',{accountRef:'local-demo-account'});
const adminFile=await upload('administration');onboarding=await transition(onboarding,'administration','complete',{locationId:'office-1',attachmentId:adminFile.id});
const onboardingAudit=(await request(`/v1/workflows/${onboarding.id}/history`,'hr-demo')).items;
for(const [i,name] of ['hr-demo','hr-demo','manager','it-demo','administration'].entries()){assert.equal(onboardingAudit[i].actorId,actors[name].subject);assert.equal(onboardingAudit[i].version,i+1);}
assert.equal((await request(`/v1/workflows/${onboarding.id}/sync`,'manager')).items.length,1);
// Exercise production SQL/worker code in an isolated schema, so retained pending
// demo jobs are never claimed, delayed, or otherwise touched by acceptance.
function containerEval(source) {
  return execFileSync('docker',['--context','desktop-linux','compose','-f','infra/compose/core.yml','exec','-T','-w','/app/apps/api','api','pnpm','exec','tsx','--eval',source],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:90000}).trim();
}
const workerSource=`
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import pg from 'pg';
import { workflowJobDatabase } from './src/workflows/job-database.ts';
import { drainOne, sendHttpEvent } from './src/workflows/outbox.ts';
(async()=>{
 const control=new pg.Pool({connectionString:process.env.DATABASE_URL});
 const schema='smoke_workflow_'+randomUUID().replaceAll('-','');
 let pool,server;
 try {
  const business=(await control.query('SELECT state,version FROM workflow_runs WHERE id=$1',[${JSON.stringify(run.id)}])).rows[0];
  assert.equal(business.state,'handed_over');assert.equal(business.version,6);
  const before=(await control.query('SELECT id,status,attempts,available_at,lease_until,lease_token,last_error FROM workflow_jobs ORDER BY id')).rows;
  const event=(await control.query('SELECT payload FROM workflow_jobs WHERE id=$1',[${JSON.stringify(jobs[0].id)}])).rows[0].payload;
  assert.equal(event.eventId,${JSON.stringify(jobs[0].id)});
  await control.query('CREATE SCHEMA '+schema);
  pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:4,options:'-c search_path='+schema+',public'});
  await pool.query('CREATE TABLE workflow_jobs (LIKE public.workflow_jobs INCLUDING ALL)');
  // The dispatcher locks active runs before jobs and checks connector waits.
  // Keep every dependency in the isolated schema; never fall back to public.
  await pool.query('CREATE TABLE workflow_runs (LIKE public.workflow_runs INCLUDING ALL)');
  await pool.query('CREATE TABLE workflow_waits (LIKE public.workflow_waits INCLUDING ALL)');
  await pool.query('INSERT INTO workflow_runs SELECT * FROM public.workflow_runs WHERE id=$1',[event.runId]);
  const jobs=workflowJobDatabase(pool);
  async function add(payload=event) {const id=randomUUID();await pool.query('INSERT INTO workflow_jobs(id,run_id,organization_id,payload) VALUES($1,$2,$3,$4)',[id,event.runId,event.organizationId,payload]);return id;}
  let requests=0;const received=[],seen=new Set();
  server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;const payload=JSON.parse(body);assert.equal(req.headers.authorization,'Bearer local-controlled-receiver-token');assert.equal(req.headers['idempotency-key'],payload.eventId);received.push(payload.eventId);requests++;if(requests===1){res.writeHead(503);res.end();return;}seen.add(payload.eventId);res.writeHead(200);res.end();});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url='http://127.0.0.1:'+server.address().port;
  const selected=await add();
  const send=job=>sendHttpEvent(job,url,'local-controlled-receiver-token');
  await drainOne(jobs,send);
  let row=(await pool.query('SELECT * FROM workflow_jobs WHERE id=$1',[selected])).rows[0];assert.equal(row.status,'pending');assert.equal(row.attempts,1);assert.ok(row.available_at>new Date());
  assert.equal((await control.query('SELECT state FROM workflow_runs WHERE id=$1',[event.runId])).rows[0].state,'handed_over');
  await pool.query('UPDATE workflow_jobs SET available_at=now() WHERE id=$1',[selected]);
  await drainOne(jobs,send);
  row=(await pool.query('SELECT * FROM workflow_jobs WHERE id=$1',[selected])).rows[0];assert.equal(row.status,'succeeded');assert.equal(row.attempts,2);assert.deepEqual(received,[event.eventId,event.eventId]);assert.equal(seen.size,1);
  await add();await add();const claims=await Promise.all([jobs.claim(),jobs.claim()]);assert.ok(claims.every(Boolean));assert.notEqual(claims[0].id,claims[1].id);for(const job of claims)await jobs.succeed(job);
  const fenceId=await add();const old=await jobs.claim();assert.equal(old.id,fenceId);
  await pool.query("UPDATE workflow_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[fenceId]);
  const reclaimed=await jobs.claim();assert.equal(reclaimed.id,fenceId);assert.notEqual(old.leaseToken,reclaimed.leaseToken);
  await jobs.succeed(old);assert.equal((await pool.query('SELECT status FROM workflow_jobs WHERE id=$1',[fenceId])).rows[0].status,'processing');await jobs.fail(old,'old lease');assert.equal((await pool.query('SELECT lease_token FROM workflow_jobs WHERE id=$1',[fenceId])).rows[0].lease_token,reclaimed.leaseToken);await jobs.succeed(reclaimed);
  const exhausted=await add();await pool.query("UPDATE workflow_jobs SET status='processing',attempts=5,lease_token=$2,lease_until=now()-interval '1 second' WHERE id=$1",[exhausted,randomUUID()]);assert.equal(await jobs.claim(),undefined);assert.equal((await pool.query('SELECT status FROM workflow_jobs WHERE id=$1',[exhausted])).rows[0].status,'failed');
  assert.deepEqual((await control.query('SELECT id,status,attempts,available_at,lease_until,lease_token,last_error FROM workflow_jobs ORDER BY id')).rows,before);
  console.log(JSON.stringify({result:'Isolated real SQL worker acceptance passed',eventId:event.eventId,deliveries:requests,effectiveDeliveries:seen.size}));
 } finally {if(server)await new Promise(resolve=>server.close(resolve));if(pool)await pool.end();await control.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await control.end();}
})().catch(()=>{console.error('Isolated workflow worker acceptance failed');process.exitCode=1});`;
console.log(containerEval(workerSource));
// Only this script's newly created business job is failed for the manual retry
// acceptance. A repeated command must replay its result after another failure.
function failOwnJob() {
  containerEval(`import pg from 'pg';(async()=>{const p=new pg.Pool({connectionString:process.env.DATABASE_URL});try{const r=await p.query("UPDATE workflow_jobs SET status='failed',attempts=5,lease_until=NULL,lease_token=NULL WHERE id=$1 AND run_id=$2",[${JSON.stringify(jobs[0].id)},${JSON.stringify(run.id)}]);if(r.rowCount!==1)throw Error('missing own job');}finally{await p.end();}})().catch(()=>{console.error('Own demo job setup failed');process.exitCode=1});`);
}
failOwnJob();
await request(`/v1/workflows/${run.id}/sync/retry`,'warehouse',{},403);
const retryKey=randomUUID();assert.equal((await request(`/v1/workflows/${run.id}/sync/retry`,'manager',{},200,retryKey)).retried,1);
let ownJob=(await request(`/v1/workflows/${run.id}/sync`,'manager')).items[0];assert.equal(ownJob.status,'pending');assert.equal(ownJob.attempts,0);
failOwnJob();assert.equal((await request(`/v1/workflows/${run.id}/sync/retry`,'manager',{},200,retryKey)).retried,1);
ownJob=(await request(`/v1/workflows/${run.id}/sync`,'manager')).items[0];assert.equal(ownJob.status,'failed');assert.equal(ownJob.attempts,5);
assert.equal((await request(`/v1/workflows/${run.id}/sync/retry`,'manager',{},200,randomUUID())).retried,1);
console.log(JSON.stringify({result:'REST workflow and durable manual retry acceptance passed; local controlled receiver only',procurementId:run.id,rejectedId:denied.id,onboardingId:onboarding.id,eventId:jobs[0].id}));
const artifactUrl=new URL(`../output/uc1-handoff/${handoverEvent.eventId}.json`,import.meta.url);
await mkdir(new URL('./',artifactUrl),{recursive:true});
await writeFile(artifactUrl,JSON.stringify({format:'latticedx.uc1-handoff',formatVersion:1,evidenceScope:'Actual REST/PostgreSQL producer; isolated queue and controlled receiver; no broker delivery',event:handoverEvent,workflow:{id:run.id,state:run.state,version:run.version},audit: audit.at(-1)},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({result:'Persisted handover event matches API state and audit',artifact:fileURLToPath(artifactUrl)}));
