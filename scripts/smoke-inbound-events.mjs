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
const root=fileURLToPath(new URL('../',import.meta.url)),actors={};
for(const username of ['alice','warehouse']){
 const r=await fetch('http://localhost:8081/realms/lattice/protocol/openid-connect/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'password',client_id:'dx-local',username,password:`local-${username}-password`})});assert.equal(r.status,200);const token=(await r.json()).access_token;actors[username]={token,subject:JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString()).sub};
}
async function call(path,method='GET',body,expected=200,user='alice',key=randomUUID()){
 const r=await fetch('http://localhost:8080'+path,{method,headers:{authorization:`Bearer ${actors[user].token}`,'content-type':'application/json','Idempotency-Key':key},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});const data=await r.json();assert.equal(r.status,expected,`${user} ${method} ${path}: ${JSON.stringify(data)}`);return data;
}
const tag=randomUUID().replaceAll('-',''),definitionId='event-'+tag,eventType='demo-'+tag;
const definition={id:definitionId,title:'Event workflow',startRole:'employee',initialState:'draft',startFields:{name:'text'},readerRoles:[],transitions:[{id:'finish',from:'draft',to:'done',role:'employee',ownerOnly:true,fields:{}}]};
await call('/v1/workflow-drafts','POST',{definition},201);await call(`/v1/workflow-drafts/${definitionId}/publish`,'POST',{expectedRevision:1});
const subscription={id:'sub-'+tag,eventType,sourceSubject:actors.alice.subject,definitionId,definitionVersion:1,title:{source:'literal',value:'From event'},input:{name:{source:'event',field:'name'}},enabled:true};
let sub=await call('/v1/workflow-event-subscriptions','POST',subscription,201);
const event={eventId:'event-'+randomUUID(),eventType,occurredAt:new Date().toISOString(),data:{name:'External incoming'}};
const receipt=await call('/v1/workflow-events','POST',event,200);assert.equal(receipt.runs.length,1);
assert.deepEqual(await call('/v1/workflow-events','POST',event),receipt);
assert.deepEqual(await call(`/v1/workflow-events/${event.eventId}`),receipt);
await call('/v1/workflow-events','POST',{...event,data:{name:'Changed'}},409);
await call('/v1/workflow-events','POST',event,403,'warehouse');
const run=await call(`/v1/workflows/${receipt.runs[0].runId}`);assert.equal(run.ownerId,actors.alice.subject);assert.equal(run.definitionVersion,1);assert.equal(run.data.name,event.data.name);
sub=await call(`/v1/workflow-event-subscriptions/${sub.id}`,'PATCH',{...subscription,expectedRevision:sub.revision,enabled:false});
assert.equal((await call('/v1/workflow-events','POST',{...event,eventId:'empty-'+randomUUID()})).runs.length,0);

const sqlSource=`
import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import pg from 'pg';import {recordDatabase} from './src/database.ts';import {foundationDatabase} from './src/foundation-database.ts';import {createDirectoryDatabase} from './src/directory-database.ts';import {definitionDatabase} from './src/workflows/registry-database.ts';import {workflowDatabase} from './src/workflows/database.ts';import {eventsDatabase} from './src/events/database.ts';
(async()=>{const control=new pg.Pool({connectionString:process.env.DATABASE_URL}),schema='event_smoke_'+randomUUID().replaceAll('-','');let pool;
 try{
  await control.query('CREATE SCHEMA '+schema);pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,max:5});await recordDatabase(pool);await createDirectoryDatabase(pool);await foundationDatabase(pool);let registry=await definitionDatabase(pool),workflows=await workflowDatabase(pool,registry),repo=await eventsDatabase(pool,registry,workflows);
  const actor={subject:'source',organizationId:'a',roles:['workflow:start','employee','workflow:event:receive','workflow:design','workflow:integrate']};
  await pool.query('INSERT INTO directory_people(subject,organization_id,display_name,enabled,roles) VALUES($1,$2,$1,true,$3)',[actor.subject,'a',JSON.stringify(actor.roles)]);
  const def={id:'event-workflow',title:'Event workflow',startRole:'employee',initialState:'draft',startFields:{name:'text'},readerRoles:[],transitions:[{id:'finish',from:'draft',to:'done',role:'employee',ownerOnly:true,fields:{}}]};await registry.create(def,actor);await registry.publish(def.id,1,actor);
  const sub={id:'sub-one',eventType:'fixture-event',sourceSubject:actor.subject,definitionId:def.id,definitionVersion:1,title:{source:'literal',value:'From fixture'},input:{name:{source:'event',field:'name'}},enabled:true};await repo.createSubscription(sub,actor,'sub-one');
  const event={eventId:'event-one',eventType:'fixture-event',occurredAt:new Date().toISOString(),data:{name:'Value'}};
  const races=await Promise.all(Array.from({length:5},()=>repo.receive(event,actor)));assert.ok(races.every(row=>row.runs[0].runId===races[0].runs[0].runId));
  assert.equal((await pool.query('SELECT count(*) FROM workflow_runs')).rows[0].count,'1');
  await assert.rejects(()=>repo.receive({...event,data:{name:'Changed'}},actor),e=>e.statusCode===409);
  await repo.createSubscription({...sub,id:'sub-two'},actor,'sub-two');
  const before=(await pool.query('SELECT count(*) FROM workflow_runs')).rows[0].count;
  await assert.rejects(()=>repo.receive({...event,eventId:'bad-event',data:{}},actor),e=>e.statusCode===400);assert.equal((await pool.query('SELECT count(*) FROM workflow_runs')).rows[0].count,before);
  const receiptTable=(await pool.query("SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename LIKE '%inbound%'")).rows[0]?.tablename;
  assert.ok(receiptTable&&/^[a-z_]+$/.test(receiptTable));await pool.query('ALTER TABLE '+receiptTable+' ADD CONSTRAINT event_fail_receipt CHECK(false) NOT VALID');
  await assert.rejects(()=>repo.receive({...event,eventId:'rollback'},actor));assert.equal((await pool.query('SELECT count(*) FROM workflow_runs')).rows[0].count,before);
  await pool.query('ALTER TABLE '+receiptTable+' DROP CONSTRAINT event_fail_receipt');
  const two=await repo.receive({...event,eventId:'rollback'},actor);assert.equal(two.runs.length,2);
  await pool.query("UPDATE directory_people SET enabled=false WHERE subject='source' AND organization_id='a'");await assert.rejects(()=>repo.receive(event,actor),e=>e.statusCode===403);
  await pool.query("UPDATE directory_people SET enabled=true WHERE subject='source' AND organization_id='a'");
  await pool.end();pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,max:1});registry=await definitionDatabase(pool);workflows=await workflowDatabase(pool,registry);repo=await eventsDatabase(pool,registry,workflows);
  assert.deepEqual(await repo.receive(event,actor),races[0]);assert.equal((await repo.receive({...event,eventId:'max-one'},actor)).runs.length,2);
  console.log('Inbound event SQL passed: concurrent source dedupe, mismatch409, mapped validation and receipt rollback all-or-none, current disabled source denial, multi-subscription dispatch and max1 replay/new execution.');
 }finally{await pool?.end();if(!/^event_smoke_[a-f0-9]{32}$/.test(schema))throw new Error('Unsafe fixture');await control.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await control.end();}
})().catch(error=>{console.error(error);process.exitCode=1;});
`;
console.log(execFileSync('docker',['--context','desktop-linux','compose','-f','infra/compose/core.yml','exec','-T','-w','/app/apps/api','api','pnpm','exec','tsx','--eval',sqlSource],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:90000}).trim());
console.log(JSON.stringify({result:'Inbound event HTTP passed',eventId:event.eventId,runId:run.id}));
