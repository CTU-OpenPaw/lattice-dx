// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const source=`
import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import pg from 'pg';
import {recordDatabase} from './src/database.ts';import {foundationDatabase} from './src/foundation-database.ts';import {entityDatabase} from './src/entities/database.ts';import {reportsDatabase} from './src/entities/reports-database.ts';
(async()=>{
 const control=new pg.Pool({connectionString:process.env.DATABASE_URL}),schema='reports_smoke_'+randomUUID().replaceAll('-','');let pool;
 try{
  await control.query('CREATE SCHEMA '+schema);const options={connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,connectionTimeoutMillis:5000};pool=new pg.Pool({...options,max:5});await recordDatabase(pool);await foundationDatabase(pool);let entities=await entityDatabase(pool),reports=await reportsDatabase(pool);
  const scope={actorId:'owner',organizationId:'a'},reader={actorId:'reader',organizationId:'a'},page={limit:100,offset:0,q:''};await pool.query("INSERT INTO directory_people(subject,organization_id,display_name,enabled) VALUES('owner','a','Owner',true),('reader','a','Reader',true)");
  await entities.createSchema(scope,{id:'balances',title:'Balances',fields:{amount:{type:'decimal'}},relations:{}});await entities.publishSchema(scope,'balances',1);
  let entity=await entities.create(scope,{schemaId:'balances',title:'Balance',attributes:{amount:'99999999999999999999.10'}},'entity');
  const input={title:'Frozen balance',query:{schemaId:'balances',schemaVersion:1,metrics:[{name:'total',operation:'sum',field:'amount'},{name:'count',operation:'count'}]}};
  const snapshots=await Promise.all(Array.from({length:5},()=>reports.create(scope,input,'snapshot')));for(const value of snapshots)assert.deepEqual(value,snapshots[0]);let frozen=snapshots[0];assert.equal(frozen.result.groups[0].metrics.total,'99999999999999999999.10');
  entity=await entities.update(scope,entity.id,{expectedVersion:entity.version,title:'Updated',attributes:{amount:'1.00'}},'update');assert.equal((await reports.get(scope,frozen.id)).result.groups[0].metrics.total,'99999999999999999999.10');const metadata=JSON.stringify(await reports.list(scope,page));assert.ok(!metadata.includes('99999999999999999999'));assert.ok(!metadata.includes('metrics'));
  entity=await entities.share(scope,entity.id,{expectedVersion:entity.version,principal:{kind:'person',id:'reader'},permission:'read'},'share');const shared=await reports.create(reader,input,'shared');entity=await entities.revokeShare(scope,entity.id,{expectedVersion:entity.version,kind:'person',principalId:'reader'},'revoke');await assert.rejects(()=>reports.get(reader,shared.id),e=>e.statusCode===404);await assert.rejects(()=>reports.create(reader,input,'shared'),e=>e.statusCode===404);
  const receipts=(await pool.query("SELECT result FROM enterprise_commands WHERE operation='entity.report.snapshot'")).rows;assert.ok(receipts.length>=2);for(const row of receipts)assert.deepEqual(Object.keys(row.result),['snapshotId']);


  async function pauseCapture(work){
   let captured,release;const ready=new Promise(resolve=>captured=resolve),gate=new Promise(resolve=>release=resolve);let paused=false;
   const scopedPool={query:pool.query.bind(pool),connect:async()=>{const client=await pool.connect();return {release:()=>client.release(),query:async(...args)=>{const result=await client.query(...args);if(!paused&&String(args[0]).includes('WITH eligible AS MATERIALIZED')){paused=true;captured();await gate;}return result;}};}};
   const raceReports=await reportsDatabase(scopedPool);const pending=work(raceReports);await ready;return {pending,release};
  }
  const editRace=await pauseCapture(repo=>repo.create(scope,{...input,title:'Edit capture'},'edit-race'));entity=await entities.update(scope,entity.id,{expectedVersion:entity.version,title:'Edited after capture',attributes:{amount:'2.00'}},'capture-edit');editRace.release();const capturedBeforeEdit=await editRace.pending;assert.equal(capturedBeforeEdit.result.groups[0].metrics.total,'1.00');
  entity=await entities.share(scope,entity.id,{expectedVersion:entity.version,principal:{kind:'person',id:'reader'},permission:'read'},'race-share');const revokeRace=await pauseCapture(repo=>repo.create(reader,{...input,title:'Revoked during capture'},'revoke-race'));entity=await entities.revokeShare(scope,entity.id,{expectedVersion:entity.version,kind:'person',principalId:'reader'},'capture-revoke');revokeRace.release();await assert.rejects(()=>revokeRace.pending,e=>e.statusCode===404);
  const snapshotCount=(await pool.query('SELECT count(*) FROM enterprise_report_snapshots')).rows[0].count;
  await pool.query("ALTER TABLE enterprise_commands ADD CONSTRAINT fail_report_receipt CHECK(operation<>'entity.report.snapshot') NOT VALID");await assert.rejects(()=>reports.create(scope,input,'late-failure'));assert.equal((await pool.query('SELECT count(*) FROM enterprise_report_snapshots')).rows[0].count,snapshotCount);await pool.query('ALTER TABLE enterprise_commands DROP CONSTRAINT fail_report_receipt');
  await pool.query("INSERT INTO enterprise_entities(id,schema_id,schema_version,title,attributes,owner_id,organization_id) SELECT gen_random_uuid(),'balances',1,'Bulk','{}'::jsonb,'owner','a' FROM generate_series(1,5000)");const before=(await pool.query('SELECT count(*) FROM enterprise_report_snapshots')).rows[0].count;await assert.rejects(()=>reports.create(scope,input,'overflow'),e=>e.statusCode===409);assert.equal((await pool.query('SELECT count(*) FROM enterprise_report_snapshots')).rows[0].count,before);
  entity=await entities.archive(scope,entity.id,entity.version,'archive');await assert.rejects(()=>reports.get(scope,frozen.id),e=>e.statusCode===404);
  await pool.end();pool=new pg.Pool({...options,max:1});entities=await entityDatabase(pool);reports=await reportsDatabase(pool);const empty=await reports.create(reader,{...input,title:'Empty'},'empty');assert.equal(empty.result.groups[0].metrics.count,'0');assert.deepEqual(await reports.get(reader,empty.id),empty);assert.deepEqual(await reports.create(reader,{...input,title:'Empty'},'empty'),empty);
  console.log('Report snapshot PostgreSQL passed: five-way atomic capture, exact frozen values after edits, metadata-only lists and ID-only receipts, current grant/revoke and archived-source denial, 5001 source rejection, max1 restart/new/replay.');
 }finally{await pool?.end();if(!/^reports_smoke_[a-f0-9]{32}$/.test(schema))throw new Error('Unsafe fixture');await control.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await control.end();}
})().catch(error=>{console.error(error);process.exitCode=1;});
`;
console.log(execFileSync('docker',['--context','desktop-linux','compose','-f','infra/compose/core.yml','exec','-T','-w','/app/apps/api','api','pnpm','exec','tsx','--eval',source],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:90000}).trim());
const login=await fetch('http://localhost:8081/realms/lattice/protocol/openid-connect/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'password',client_id:'dx-local',username:'alice',password:'local-alice-password'}),signal:AbortSignal.timeout(15000)});assert.equal(login.status,200);const token=(await login.json()).access_token;
async function call(path,method='GET',body,expected=200,key=randomUUID()){
 const response=await fetch('http://localhost:8080'+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json','Idempotency-Key':key},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});const result=await response.json();assert.equal(response.status,expected,JSON.stringify(result));return result;
}
const schemaId='report-'+randomUUID().replaceAll('-','');await call('/v1/entity-schemas','POST',{id:schemaId,title:'Report',fields:{amount:{type:'decimal'}},relations:{}},201);await call('/v1/entity-schemas/'+schemaId+'/publish','POST',{expectedRevision:1});let entity=await call('/v1/entities','POST',{schemaId,title:'Balance',attributes:{amount:'99999999999999999999.10'}},201);
const input={title:'Frozen report',query:{schemaId,schemaVersion:1,metrics:[{name:'total',operation:'sum',field:'amount'}]}},key=randomUUID();const snapshot=await call('/v1/entity-report-snapshots','POST',input,201,key);assert.equal(snapshot.result.groups[0].metrics.total,'99999999999999999999.10');assert.deepEqual(await call('/v1/entity-report-snapshots','POST',input,201,key),snapshot);entity=await call('/v1/entities/'+entity.id,'PATCH',{expectedVersion:entity.version,title:'Changed',attributes:{amount:'1.00'}});assert.equal((await call('/v1/entity-report-snapshots/'+snapshot.id)).result.groups[0].metrics.total,'99999999999999999999.10');const list=await call('/v1/entity-report-snapshots');assert.ok(list.items.every(item=>!Object.hasOwn(item,'result')));
console.log('Report snapshot signed HTTP passed: exact frozen creation/replay, current get and metadata-only list.');
