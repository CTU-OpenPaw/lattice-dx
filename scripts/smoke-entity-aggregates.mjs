// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const source=`
import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import pg from 'pg';
import {recordDatabase} from './src/database.ts';import {foundationDatabase} from './src/foundation-database.ts';import {entityDatabase} from './src/entities/database.ts';
(async()=>{
 const control=new pg.Pool({connectionString:process.env.DATABASE_URL}),schema='aggregate_smoke_'+randomUUID().replaceAll('-','');let pool;
 try{
  await control.query('CREATE SCHEMA '+schema);const options={connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,connectionTimeoutMillis:5000};pool=new pg.Pool({...options,max:5});await recordDatabase(pool);await foundationDatabase(pool);let entities=await entityDatabase(pool);
  const owner={actorId:'owner',organizationId:'a'},reader={actorId:'reader',organizationId:'a'};
  await pool.query("INSERT INTO directory_people(subject,organization_id,display_name,enabled) VALUES('owner','a','Owner',true),('reader','a','Reader',true)");
  await entities.createSchema(owner,{id:'balances',title:'Balances',fields:{amount:{type:'decimal'},department:{type:'text'}},relations:{}});await entities.publishSchema(owner,'balances',1);
  const source=await entities.create(owner,{schemaId:'balances',title:'Large',attributes:{amount:'99999999999999999999.10',department:'finance'}},'source');await entities.create(owner,{schemaId:'balances',title:'Small',attributes:{amount:'0.20',department:'finance'}},'small');await entities.create(owner,{schemaId:'balances',title:'Missing amount',attributes:{department:'operations'}},'missing');
  const query={schemaId:'balances',schemaVersion:1,metrics:[{name:'count',operation:'count'},{name:'total',operation:'sum',field:'amount'},{name:'average',operation:'avg',field:'amount'}]};
  let result=await entities.aggregate(owner,query);assert.equal(result.groups.length,1);assert.equal(result.groups[0].metrics.count,'3');assert.equal(result.groups[0].metrics.total,'99999999999999999999.30');assert.equal(result.groups[0].metrics.average,'49999999999999999999.650000000000000000');
  result=await entities.aggregate(reader,query);assert.equal(result.groups[0].metrics.count,'0');assert.equal(result.groups[0].metrics.total,null);
  const shared=await entities.share(owner,source.id,{expectedVersion:source.version,principal:{kind:'person',id:'reader'},permission:'read'},'share');assert.equal((await entities.aggregate(reader,query)).groups[0].metrics.count,'1');await entities.revokeShare(owner,source.id,{expectedVersion:shared.version,kind:'person',principalId:'reader'},'revoke');assert.equal((await entities.aggregate(reader,query)).groups[0].metrics.count,'0');

  await entities.createSchema(owner,{id:'other',title:'Adversary',fields:{amount:{type:'text'}},relations:{}});await entities.publishSchema(owner,'other',1);await entities.create(owner,{schemaId:'other',title:'Wrong numeric field',attributes:{amount:'not a number'}},'adversary');assert.equal((await entities.aggregate(owner,query)).groups[0].metrics.total,'99999999999999999999.30');

  await entities.create({actorId:'reader',organizationId:'a'},{schemaId:'balances',title:'Hidden from owner',attributes:{amount:'123.45'}},'hidden');assert.equal((await entities.aggregate(owner,query)).groups[0].metrics.count,'3');
  const numericGroups=await entities.aggregate(owner,{...query,groupBy:['amount']});assert.equal(numericGroups.groups.length,3);
  await entities.createSchema(owner,{id:'numeric-groups',title:'Numeric groups',fields:{amount:{type:'decimal'}},relations:{}});await entities.publishSchema(owner,'numeric-groups',1);await entities.create(owner,{schemaId:'numeric-groups',title:'One A',attributes:{amount:'1.0'}},'one-a');await entities.create(owner,{schemaId:'numeric-groups',title:'One B',attributes:{amount:'1.00'}},'one-b');const grouped=await entities.aggregate(owner,{schemaId:'numeric-groups',schemaVersion:1,groupBy:['amount'],metrics:[{name:'count',operation:'count'}]});assert.equal(grouped.groups.length,1);assert.equal(grouped.groups[0].metrics.count,'2');
  await pool.query("INSERT INTO enterprise_entities(id,schema_id,schema_version,title,attributes,owner_id,organization_id) SELECT gen_random_uuid(),'balances',1,'Bulk',jsonb_build_object('amount','1.00','department','bulk'),'owner','a' FROM generate_series(1,5100)");assert.equal((await entities.aggregate(owner,query)).groups[0].metrics.count,'5103');
  await pool.query("INSERT INTO enterprise_entities(id,schema_id,schema_version,title,attributes,owner_id,organization_id) SELECT gen_random_uuid(),'balances',1,'Groups',jsonb_build_object('department','group-'||n),'owner','a' FROM generate_series(1,201) n");await assert.rejects(()=>entities.aggregate(owner,{...query,groupBy:['department']}),e=>e.statusCode===409);
  await pool.end();pool=new pg.Pool({...options,max:1});entities=await entityDatabase(pool);assert.equal((await entities.aggregate(owner,query)).groups[0].metrics.count,'5304');
  console.log('Aggregate PostgreSQL passed: exact large decimal totals/average, missing-field source count, current grant/revoke visibility, ordinary aggregate exceeds 5000 without truncation, group201 rejection and max1 restart.');
 }finally{await pool?.end();if(!/^aggregate_smoke_[a-f0-9]{32}$/.test(schema))throw new Error('Unsafe fixture');await control.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await control.end();}
})().catch(error=>{console.error(error);process.exitCode=1;});
`;
console.log(execFileSync('docker',['--context','desktop-linux','compose','-f','infra/compose/core.yml','exec','-T','-w','/app/apps/api','api','pnpm','exec','tsx','--eval',source],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:90000}).trim());
const login=await fetch('http://localhost:8081/realms/lattice/protocol/openid-connect/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'password',client_id:'dx-local',username:'alice',password:'local-alice-password'}),signal:AbortSignal.timeout(15000)});assert.equal(login.status,200);const token=(await login.json()).access_token;
async function call(path,body,expected=200){const response=await fetch('http://localhost:8080'+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});const result=await response.json();assert.equal(response.status,expected,JSON.stringify(result));return result;}
const schemaId='aggregate-'+randomUUID().replaceAll('-','');await call('/v1/entity-schemas',{id:schemaId,title:'Aggregate',fields:{amount:{type:'decimal'}},relations:{}},201);await call('/v1/entity-schemas/'+schemaId+'/publish',{expectedRevision:1});await call('/v1/entities',{schemaId,title:'Balance',attributes:{amount:'99999999999999999999.10'}},201);
const result=await call('/v1/entities/aggregate',{schemaId,schemaVersion:1,metrics:[{name:'total',operation:'sum',field:'amount'}]});assert.equal(result.groups[0].metrics.total,'99999999999999999999.10');await call('/v1/entities/aggregate',{schemaId,schemaVersion:1,metrics:[{name:'count',operation:'count'}],rawSql:'SELECT 1'},400);
console.log('Aggregate signed HTTP passed: exact authorized total and unknown SQL field denial.');
