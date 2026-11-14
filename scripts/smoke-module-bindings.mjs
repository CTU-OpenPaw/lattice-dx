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
const source=`
import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import pg from 'pg';
import {recordDatabase} from './src/database.ts';import {foundationDatabase} from './src/foundation-database.ts';import {createDirectoryDatabase} from './src/directory-database.ts';import {entityDatabase} from './src/entities/database.ts';import {definitionDatabase} from './src/workflows/registry-database.ts';import {workflowDatabase} from './src/workflows/database.ts';import {modulesDatabase} from './src/modules/database.ts';
(async()=>{
 const control=new pg.Pool({connectionString:process.env.DATABASE_URL}),schema='bindings_smoke_'+randomUUID().replaceAll('-','');let pool;
 try{
  await control.query('CREATE SCHEMA '+schema);const options={connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,connectionTimeoutMillis:5000};pool=new pg.Pool({...options,max:5});
  await recordDatabase(pool);await createDirectoryDatabase(pool);await foundationDatabase(pool);let entities=await entityDatabase(pool),registry=await definitionDatabase(pool),workflows=await workflowDatabase(pool,registry),modules=await modulesDatabase(pool,workflows);
  const actor={subject:'owner',organizationId:'a',roles:['employee','data:design','data:write','data:read','workflow:design','workflow:start']},scope={actorId:'owner',organizationId:'a'};
  const definition={id:'bound-flow',title:'Bound flow',startRole:'employee',initialState:'draft',startFields:{},readerRoles:[],transitions:[{id:'allowed',from:'draft',to:'done',role:'employee',ownerOnly:true,fields:{}},{id:'blocked',from:'draft',to:'done',role:'employee',ownerOnly:true,fields:{}}]};
  const manifest={format:'latticedx.enterprise-module',formatVersion:1,id:'bound-module',version:'1.0.0',title:'Bound module',schemas:[{id:'bound-data',title:'Data',fields:{name:{type:'text'}},relations:{}}],bundle:{format:'latticedx.workflow-bundle',formatVersion:1,definitions:[definition]},blocks:[],dependencies:[],bindings:[{id:'business',schemaId:'bound-data',schemaVersion:1,definitionId:definition.id,allowedTransitions:['allowed']}]};
  assert.equal((await modules.preview(manifest,actor)).conflicts.length,0);let installed=await modules.install(manifest,actor,'install');await registry.publish(definition.id,1,actor);installed=await modules.setEnabled(manifest.id,manifest.version,{expectedRevision:installed.revision,enabled:true},actor,'enable');
  const entity=await entities.create(scope,{schemaId:'bound-data',title:'Source',attributes:{name:'Value'}},'entity');
  await assert.rejects(()=>workflows.create({definitionId:definition.id,title:'Missing context',input:{}},actor,'missing'),e=>e.statusCode===409);
  const input={definitionId:definition.id,title:'Bound source',input:{},entityContext:{entityId:entity.id}};
  const runs=await Promise.all(Array.from({length:5},()=>workflows.create(input,actor,'start')));for(const run of runs)assert.deepEqual(run,runs[0]);const run=runs[0];assert.deepEqual(run.binding,{moduleId:manifest.id,moduleVersion:manifest.version,bindingId:'business',allowedTransitions:['allowed']});
  await assert.rejects(()=>workflows.transition(run.id,{action:'blocked',expectedVersion:1,input:{}},actor,'blocked'),e=>e.statusCode===403);assert.equal((await workflows.get(run.id,actor)).version,1);

  const beforeRuns=(await pool.query('SELECT count(*) FROM workflow_runs')).rows[0].count,beforeContexts=(await pool.query('SELECT count(*) FROM workflow_entity_contexts')).rows[0].count;
  await pool.query('ALTER TABLE workflow_starts ADD CONSTRAINT fail_binding_receipt CHECK(false) NOT VALID');await assert.rejects(()=>workflows.create(input,actor,'rollback-binding'));assert.equal((await pool.query('SELECT count(*) FROM workflow_runs')).rows[0].count,beforeRuns);assert.equal((await pool.query('SELECT count(*) FROM workflow_entity_contexts')).rows[0].count,beforeContexts);await pool.query('ALTER TABLE workflow_starts DROP CONSTRAINT fail_binding_receipt');
  installed=await modules.setEnabled(manifest.id,manifest.version,{expectedRevision:installed.revision,enabled:false},actor,'disable');const done=await workflows.transition(run.id,{action:'allowed',expectedVersion:1,input:{}},actor,'allowed');assert.equal(done.state,'done');assert.deepEqual(done.binding,run.binding);await assert.rejects(()=>workflows.create(input,actor,'disabled'),e=>e.statusCode===409);

  const dependency={...manifest,id:'dependency',schemas:[{id:'dependency-data',title:'Dependency',fields:{name:{type:'text'}},relations:{}}],bundle:{...manifest.bundle,definitions:[{...definition,id:'dependency-flow'}]},bindings:[]};
  let dep=await modules.install(dependency,actor,'dep-install');await registry.publish('dependency-flow',1,actor);dep=await modules.setEnabled('dependency','1.0.0',{expectedRevision:dep.revision,enabled:true},actor,'dep-enable');
  const consumerDef={...definition,id:'consumer-flow'};const consumer={...manifest,id:'consumer',schemas:[],bundle:{...manifest.bundle,definitions:[consumerDef]},dependencies:[{id:'dependency',version:'1.0.0'}],bindings:[{...manifest.bindings[0],schemaId:'dependency-data',definitionId:'consumer-flow'}]};
  let consumed=await modules.install(consumer,actor,'consumer-install');await registry.publish(consumerDef.id,1,actor);consumed=await modules.setEnabled('consumer','1.0.0',{expectedRevision:consumed.revision,enabled:true},actor,'consumer-enable');
  const depEntity=await entities.create(scope,{schemaId:'dependency-data',title:'Dependency entity',attributes:{name:'Value'}},'dep-entity');const depInput={definitionId:'consumer-flow',title:'Consumer start',input:{},entityContext:{entityId:depEntity.id}};
  const historical=await workflows.create(depInput,actor,'consumer-start');dep=await modules.setEnabled('dependency','1.0.0',{expectedRevision:dep.revision,enabled:false},actor,'dep-disable');await assert.rejects(()=>workflows.create(depInput,actor,'dependency-disabled'),e=>e.statusCode===409);assert.equal((await workflows.transition(historical.id,{action:'allowed',expectedVersion:1,input:{}},actor,'consumer-finish')).state,'done');
  await pool.end();pool=new pg.Pool({...options,max:1});entities=await entityDatabase(pool);registry=await definitionDatabase(pool);workflows=await workflowDatabase(pool,registry);modules=await modulesDatabase(pool,workflows);assert.deepEqual((await workflows.get(run.id,actor)).binding,run.binding);assert.deepEqual(await workflows.transition(run.id,{action:'allowed',expectedVersion:1,input:{}},actor,'allowed'),done);
  console.log('Module binding PostgreSQL passed: published mapping, generic start cannot bypass required context, five-way receipt, allowed transition policy, disabled new start and preserved historical policy, max1 restart.');
 }finally{await pool?.end();if(!/^bindings_smoke_[a-f0-9]{32}$/.test(schema))throw new Error('Unsafe fixture');await control.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await control.end();}
})().catch(error=>{console.error(error);process.exitCode=1;});
`;
console.log(execFileSync('docker',['--context','desktop-linux','compose','-f','infra/compose/core.yml','exec','-T','-w','/app/apps/api','api','pnpm','exec','tsx','--eval',source],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:90000}).trim());
const login=await fetch('http://localhost:8081/realms/lattice/protocol/openid-connect/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'password',client_id:'dx-local',username:'alice',password:'local-alice-password'}),signal:AbortSignal.timeout(15000)});assert.equal(login.status,200);const token=(await login.json()).access_token;
async function call(path,body,expected=200){const response=await fetch('http://localhost:8080'+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});const result=await response.json();assert.equal(response.status,expected,JSON.stringify(result));return result;}
const tag=randomUUID().replaceAll('-',''),moduleId='bound-'+tag,schemaId='bound-data-'+tag,definitionId='bound-flow-'+tag;
const definition={id:definitionId,title:'Bound flow',startRole:'employee',initialState:'draft',startFields:{},readerRoles:[],transitions:[{id:'allowed',from:'draft',to:'done',role:'employee',ownerOnly:true,fields:{}},{id:'blocked',from:'draft',to:'done',role:'employee',ownerOnly:true,fields:{}}]};
const manifest={format:'latticedx.enterprise-module',formatVersion:1,id:moduleId,version:'1.0.0',title:'Business module',schemas:[{id:schemaId,title:'Business data',fields:{name:{type:'text'}},relations:{}}],bundle:{format:'latticedx.workflow-bundle',formatVersion:1,definitions:[definition]},blocks:[],dependencies:[],bindings:[{id:'business',schemaId,schemaVersion:1,definitionId,allowedTransitions:['allowed']}]};
const installed=await call('/v1/enterprise-modules/install',{manifest},201);await call('/v1/workflow-drafts/'+definitionId+'/publish',{expectedRevision:1});await call('/v1/enterprise-modules/'+moduleId+'/versions/1.0.0/enabled',{expectedRevision:installed.revision,enabled:true});const entity=await call('/v1/entities',{schemaId,title:'Business entity',attributes:{name:'Value'}},201);
await call('/v1/workflows',{definitionId,title:'Missing context',input:{}},409);const run=await call('/v1/enterprise-modules/'+moduleId+'/versions/1.0.0/bindings/business/start',{entityId:entity.id,title:'Bound start',input:{}},201);assert.equal(run.binding.bindingId,'business');await call('/v1/workflows/'+run.id+'/transitions',{action:'blocked',expectedVersion:1,input:{}},403);const done=await call('/v1/workflows/'+run.id+'/transitions',{action:'allowed',expectedVersion:1,input:{}});assert.equal(done.state,'done');
console.log('Module binding signed HTTP passed: server-resolved start, generic context guard and blocked/allowed transitions.');
