// SPDX-License-Identifier: Apache-2.0
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../',import.meta.url));
for(const username of ['alice','warehouse']){
 const response=await fetch('http://localhost:8081/realms/lattice/protocol/openid-connect/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'password',client_id:'dx-local',username,password:`local-${username}-password`})});assert.equal(response.status,200);
 const token=(await response.json()).access_token;
 const services=await fetch('http://localhost:8080/v1/workflow-services',{headers:{authorization:'Bearer '+token}});
 assert.equal(services.status,username==='alice'?200:403);if(services.ok)assert.ok((await services.json()).items.every(item=>!Object.hasOwn(item,'subject')));
}
const sqlSource=`
import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import pg from 'pg';import {recordDatabase} from './src/database.ts';import {createDirectoryDatabase} from './src/directory-database.ts';import {foundationDatabase} from './src/foundation-database.ts';import {definitionDatabase} from './src/workflows/registry-database.ts';import {workflowDatabase} from './src/workflows/database.ts';
(async()=>{const control=new pg.Pool({connectionString:process.env.DATABASE_URL}),schema='timer_smoke_'+randomUUID().replaceAll('-','');let pool;
 try{
  await control.query('CREATE SCHEMA '+schema);pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,max:5});await recordDatabase(pool);await createDirectoryDatabase(pool);await foundationDatabase(pool);let registry=await definitionDatabase(pool),repo=await workflowDatabase(pool,registry);
  const actor={subject:'owner',organizationId:'a',roles:['employee','workflow:design','workflow:start','workflow:schedule','workflow:sync']},service={subject:'service',organizationId:'a',roles:['workflow:service','automation','records:write']};
  for(const person of [actor,service])await pool.query('INSERT INTO directory_people(subject,organization_id,display_name,enabled,roles) VALUES($1,$2,$1,true,$3)',[person.subject,'a',JSON.stringify(person.roles)]);
  await pool.query("INSERT INTO workflow_services(organization_id,id,subject,enabled,revision) VALUES('a','fixture','service',true,1)");
  const lit=value=>({source:'literal',value});
  const def={id:'timer-fixture',title:'Timer fixture',startRole:'employee',initialState:'draft',startFields:{name:'text'},readerRoles:['automation'],transitions:[
   {id:'schedule',from:'draft',to:'scheduled',role:'employee',ownerOnly:true,fields:{},steps:[{id:'timer',action:'timers.schedule',input:{afterSeconds:1,serviceId:'fixture',transitionId:'automatic',input:{}}}]},
   {id:'automatic',from:'scheduled',to:'done',role:'automation',execution:'service',fields:{},steps:[{id:'record',action:'records.create',input:{title:lit('Created by service')}}]}
  ]};await registry.create(def,actor);await registry.publish(def.id,1,actor);
  const create={definitionId:def.id,title:'Timer run',input:{name:'Value'}};
  let run=await repo.create(create,actor,'create');run=await repo.transition(run.id,{action:'schedule',expectedVersion:run.version,input:{}},actor,'schedule');assert.equal(run.waiting,true);
  await assert.rejects(()=>repo.transition(run.id,{action:'automatic',expectedVersion:run.version,input:{}},service,'public-service'),e=>e.statusCode===403);
  await pool.query("UPDATE workflow_timers SET due_at=now()-interval '1 second',available_at=now()-interval '1 second' WHERE run_id=$1",[run.id]);
  const ticks=await Promise.all(Array.from({length:5},()=>repo.tickOne()));assert.equal((await repo.get(run.id,actor)).state,'done');
  assert.equal((await pool.query("SELECT count(*) FROM records WHERE owner_id='service' AND title='Created by service'")).rows[0].count,'1');
  const timers=await repo.listTimers(run.id,actor,{limit:100,offset:0,q:''});assert.equal(timers.items[0].status,'succeeded');
  let rollback=await repo.create({...create,title:'Receipt rollback'},actor,'rollback-create');rollback=await repo.transition(rollback.id,{action:'schedule',expectedVersion:1,input:{}},actor,'rollback-schedule');
  await pool.query("UPDATE workflow_timers SET due_at=now()-interval '1 second',available_at=now()-interval '1 second' WHERE run_id=$1",[rollback.id]);
  await pool.query('ALTER TABLE workflow_commands ADD CONSTRAINT timer_fail_receipt CHECK(false) NOT VALID');await repo.tickOne();
  assert.equal((await repo.get(rollback.id,actor)).state,'scheduled');assert.equal((await pool.query("SELECT count(*) FROM records WHERE owner_id='service'")).rows[0].count,'1');
  await pool.query('ALTER TABLE workflow_commands DROP CONSTRAINT timer_fail_receipt');
  const rollbackTimer=(await repo.listTimers(rollback.id,actor,{limit:100,offset:0,q:''})).items[0];
  if(rollbackTimer.status==='failed')await repo.retryTimer(rollback.id,rollbackTimer.id,rollback.version,actor,'rollback-retry');
  await pool.query("UPDATE workflow_timers SET available_at=now()-interval '1 second' WHERE run_id=$1",[rollback.id]);await repo.tickOne();assert.equal((await repo.get(rollback.id,actor)).state,'done');
  let denied=await repo.create({...create,title:'Authority revoked'},actor,'denied-create');denied=await repo.transition(denied.id,{action:'schedule',expectedVersion:1,input:{}},actor,'denied-schedule');
  await pool.query("UPDATE directory_people SET enabled=false WHERE subject='service' AND organization_id='a'");await pool.query("UPDATE workflow_timers SET due_at=now()-interval '1 second',available_at=now()-interval '1 second' WHERE run_id=$1",[denied.id]);await repo.tickOne();
  const failed=(await repo.listTimers(denied.id,actor,{limit:100,offset:0,q:''})).items[0];assert.equal(failed.status,'failed');assert.equal((await pool.query("SELECT count(*) FROM records WHERE owner_id='service'")).rows[0].count,'2');
  await pool.query("UPDATE directory_people SET enabled=true WHERE subject='service' AND organization_id='a'");await repo.retryTimer(denied.id,failed.id,denied.version,actor,'retry');
  await pool.query("UPDATE workflow_timers SET due_at=now()-interval '1 second',available_at=now()-interval '1 second' WHERE run_id=$1",[denied.id]);
  await pool.end();pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,max:1});registry=await definitionDatabase(pool);repo=await workflowDatabase(pool,registry);await repo.tickOne();assert.equal((await repo.get(denied.id,actor)).state,'done');
  let cancelled=await repo.create({...create,title:'Cancelled timer'},actor,'cancel-create');cancelled=await repo.transition(cancelled.id,{action:'schedule',expectedVersion:1,input:{}},actor,'cancel-schedule');await repo.cancel(cancelled.id,{expectedVersion:cancelled.version,reason:'Stop'},actor,'cancel');
  await pool.query("UPDATE workflow_timers SET due_at=now()-interval '1 second',available_at=now()-interval '1 second' WHERE run_id=$1",[cancelled.id]);await repo.tickOne();assert.equal((await repo.listTimers(cancelled.id,actor,{limit:100,offset:0,q:''})).items[0].status,'cancelled');
  console.log('Timer SQL passed: current designated service authority, public service denial, concurrent due exactly one effect, disabled source no effect, fresh authority retry, cancellation fence and max1 restart/new execution.');
 }finally{await pool?.end();if(!/^timer_smoke_[a-f0-9]{32}$/.test(schema))throw new Error('Unsafe fixture');await control.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await control.end();}
})().catch(error=>{console.error(error);process.exitCode=1;});
`;
console.log(execFileSync('docker',['--context','desktop-linux','compose','-f','infra/compose/core.yml','exec','-T','-w','/app/apps/api','api','pnpm','exec','tsx','--eval',sqlSource],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:90000}).trim());
