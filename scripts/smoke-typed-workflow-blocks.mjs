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
for(const username of ['alice','sales2']){
 const login=await fetch('http://localhost:8081/realms/lattice/protocol/openid-connect/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'password',client_id:'dx-local',username,password:`local-${username}-password`}),signal:AbortSignal.timeout(15000)});assert.equal(login.status,200);actors[username]=(await login.json()).access_token;
}
async function call(path,body,expected=200,user='alice',key=randomUUID()){
 const response=await fetch('http://localhost:8080'+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+actors[user],'content-type':'application/json','Idempotency-Key':key},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});const result=await response.json();assert.equal(response.status,expected,`${path}: ${JSON.stringify(result)}`);return result;
}
const literal=value=>({source:'literal',value}),resultId=stepId=>({source:'result',stepId,field:'id'}),resultVersion=stepId=>({source:'result',stepId,field:'version'});
const tag=randomUUID().replaceAll('-',''),schemaId='typed-'+tag,definitionId='typed-'+tag;
await call('/v1/entity-schemas',{id:schemaId,title:'Workflow typed data',fields:{note:{type:'text'},count:{type:'integer'},enabled:{type:'boolean'}},relations:{related:{targetSchemaId:schemaId}}},201);
await call('/v1/entity-schemas/'+schemaId+'/publish',{expectedRevision:1});
const definition={id:definitionId,title:'Typed workflow',startRole:'employee',initialState:'draft',startFields:{count:'text',enabled:'text'},readerRoles:[],transitions:[{id:'execute',from:'draft',to:'done',role:'employee',ownerOnly:true,fields:{},steps:[
 {id:'create',action:'entities.create',input:{schemaId,schemaVersion:1,title:literal('Typed entity'),attributes:{note:literal('Confidential value'),count:{source:'data',field:'count',as:'integer'},enabled:{source:'data',field:'enabled',as:'boolean'}}}},
 {id:'update',action:'entities.update',input:{id:resultId('create'),expectedVersion:resultVersion('create'),title:literal('Updated'),attributes:{note:literal('Still private'),count:literal(3),enabled:literal(true)}}},
 {id:'read',action:'entities.read',input:{id:resultId('update')}},
 {id:'query',action:'entities.query',input:{schemaId,schemaVersion:1,limit:10,filters:[{field:'count',operator:'eq',value:literal(3)}]}},
 ]}]};
await call('/v1/workflow-drafts',{definition},201);await call('/v1/workflow-drafts/'+definitionId+'/publish',{expectedRevision:1});
const run=await call('/v1/workflows',{definitionId,title:'Typed acceptance',input:{count:'2',enabled:'true'}},201),command={action:'execute',expectedVersion:1,input:{}},key=randomUUID();
const done=await call('/v1/workflows/'+run.id+'/transitions',command,200,'alice',key);assert.equal(done.state,'done');assert.deepEqual(await call('/v1/workflows/'+run.id+'/transitions',command,200,'alice',key),done);
const executions=(await call('/v1/workflows/'+run.id+'/executions')).items;assert.equal(executions.length,4);assert.ok(!JSON.stringify(executions).includes('Confidential value'));assert.ok(!JSON.stringify(executions).includes('Still private'));
assert.equal((await call('/v1/entities/'+executions.find(row=>row.stepId==='create').result.id)).version,2);
const bad=await call('/v1/workflows',{definitionId,title:'No coercion',input:{count:'02',enabled:'true'}},201);await call('/v1/workflows/'+bad.id+'/transitions',command,400);assert.equal((await call('/v1/workflows/'+bad.id)).version,1);
const source=`
import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import pg from 'pg';import {recordDatabase} from './src/database.ts';import {foundationDatabase} from './src/foundation-database.ts';import {entityDatabase} from './src/entities/database.ts';import {definitionDatabase} from './src/workflows/registry-database.ts';import {workflowDatabase} from './src/workflows/database.ts';
(async()=>{const control=new pg.Pool({connectionString:process.env.DATABASE_URL}),schema='typed_workflow_smoke_'+randomUUID().replaceAll('-','');let pool;
try{
 await control.query('CREATE SCHEMA '+schema);pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,max:5,connectionTimeoutMillis:5000});await recordDatabase(pool);await foundationDatabase(pool);let entities=await entityDatabase(pool),registry=await definitionDatabase(pool),workflows=await workflowDatabase(pool,registry);
 const owner={actorId:'owner',organizationId:'a'},actor={subject:'owner',organizationId:'a',roles:['employee','workflow:design','workflow:start','data:write','data:read']},reader={subject:'reader',organizationId:'a',roles:['employee','data:read']};
 await pool.query("INSERT INTO directory_people(subject,organization_id,display_name,enabled) VALUES('owner','a','Owner',true),('reader','a','Reader',true)");
 const schemaDef={id:'typed',title:'Typed',fields:{note:{type:'text'},count:{type:'integer'}},relations:{related:{targetSchemaId:'typed'}}};await entities.createSchema(owner,schemaDef);await entities.publishSchema(owner,'typed',1);
 const literal=value=>({source:'literal',value}),id=stepId=>({source:'result',stepId,field:'id'}),version=stepId=>({source:'result',stepId,field:'version'});
 const definition={id:'typed-flow',title:'Typed flow',startRole:'employee',initialState:'draft',startFields:{},readerRoles:['employee'],transitions:[{id:'execute',from:'draft',to:'done',role:'employee',ownerOnly:true,fields:{},steps:[
 {id:'source',action:'entities.create',input:{schemaId:'typed',schemaVersion:1,title:literal('Source'),attributes:{note:literal('Secret source'),count:literal(1)}}},
 {id:'target',action:'entities.create',input:{schemaId:'typed',schemaVersion:1,title:literal('Target'),attributes:{note:literal('Secret target'),count:literal(2)}}},
 {id:'link',action:'entities.link',input:{id:id('source'),targetId:id('target'),name:'related',expectedVersion:version('source')}},
 {id:'unlink',action:'entities.unlink',input:{id:id('link'),targetId:id('target'),name:'related',expectedVersion:version('link')}},
 {id:'archive',action:'entities.archive',input:{id:id('unlink'),expectedVersion:version('unlink')}}]}]};
 await registry.create(definition,actor);await registry.publish(definition.id,1,actor);await entities.saveSchema(owner,'typed',{...schemaDef,fields:{...schemaDef.fields,extra:{type:'text',required:true}},expectedRevision:1});await entities.publishSchema(owner,'typed',2);
 const run=await workflows.create({definitionId:definition.id,title:'Transactional typed',input:{}},actor,'create'),command={action:'execute',expectedVersion:1,input:{}};
 await assert.rejects(()=>workflows.transition(run.id,command,{...actor,roles:actor.roles.filter(role=>role!=='data:write')},'missing-cap'),e=>e.statusCode===403);
 await pool.query('ALTER TABLE workflow_commands ADD CONSTRAINT fail_typed_receipt CHECK(false) NOT VALID');await assert.rejects(()=>workflows.transition(run.id,command,actor,'execute'));assert.equal((await workflows.get(run.id,actor)).version,1);assert.equal((await pool.query('SELECT count(*) FROM enterprise_entities')).rows[0].count,'0');assert.equal((await pool.query('SELECT count(*) FROM enterprise_audit')).rows[0].count,'0');assert.equal((await pool.query('SELECT count(*) FROM workflow_action_results')).rows[0].count,'0');
 await pool.query('ALTER TABLE workflow_commands DROP CONSTRAINT fail_typed_receipt');const commands=await Promise.all(Array.from({length:5},()=>workflows.transition(run.id,command,actor,'execute')));for(const value of commands)assert.deepEqual(value,commands[0]);assert.equal((await pool.query('SELECT count(*) FROM enterprise_entities')).rows[0].count,'2');
 const executions=await workflows.executions(run.id,reader,{limit:100,offset:0,q:''});assert.equal(executions.length,5);assert.ok(!JSON.stringify(executions).includes('Secret'));const created=executions.find(row=>row.stepId==='source').result;assert.equal((await entities.find(owner,created.id)).schemaVersion,1);assert.ok((await entities.find(owner,created.id)).archivedAt);
 await assert.rejects(()=>workflows.transition(run.id,command,{...actor,roles:actor.roles.filter(role=>role!=='data:write')},'execute'),e=>e.statusCode===403);
 const peer={actorId:'reader',organizationId:'a'};let shared=await entities.create(peer,{schemaId:'typed',title:'Peer data',attributes:{note:'Before',count:1,extra:'V2'}},'peer-entity');
 shared=await entities.share(peer,shared.id,{expectedVersion:shared.version,principal:{kind:'person',id:'owner'},permission:'edit'},'peer-grant');
 const editDefinition={...definition,id:'edit-flow',transitions:[{id:'execute',from:'draft',to:'done',role:'employee',ownerOnly:true,fields:{},steps:[{id:'edit',action:'entities.update',input:{id:literal(shared.id),expectedVersion:shared.version,title:literal('Edited through workflow'),attributes:{note:literal('After'),count:literal(2),extra:literal('V2')}}}]}]};
 await registry.create(editDefinition,actor);await registry.publish(editDefinition.id,1,actor);const editing=await workflows.create({definitionId:editDefinition.id,title:'Current entity grant',input:{}},actor,'edit-run');await workflows.transition(editing.id,command,actor,'edit');assert.equal((await entities.find(peer,shared.id)).title,'Edited through workflow');
 shared=await entities.find(peer,shared.id);const revokedRun=await workflows.create({definitionId:editDefinition.id,title:'Revoked entity grant',input:{}},actor,'revoked-run');await entities.revokeShare(peer,shared.id,{expectedVersion:shared.version,kind:'person',principalId:'owner'},'peer-revoke');await assert.rejects(()=>workflows.transition(revokedRun.id,command,actor,'revoked'),e=>e.statusCode===404);assert.equal((await workflows.get(revokedRun.id,actor)).version,1);
 await pool.end();pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,max:1,connectionTimeoutMillis:5000});entities=await entityDatabase(pool);registry=await definitionDatabase(pool);workflows=await workflowDatabase(pool,registry);assert.deepEqual(await workflows.transition(run.id,command,actor,'execute'),commands[0]);const next=await workflows.create({definitionId:definition.id,title:'One pool client',input:{}},actor,'new-run');await workflows.transition(next.id,command,actor,'new-execute');assert.equal((await pool.query('SELECT count(*) FROM enterprise_entities')).rows[0].count,'5');
 console.log('Typed workflow PostgreSQL passed: actual actor capabilities, late receipt rollback of run/entities/audit/results, five concurrent commands one effect, pinned schema after v2, link/unlink/archive, metadata-only reader evidence, max1 restart and new execution.');
}finally{await pool?.end();if(!/^typed_workflow_smoke_[a-f0-9]{32}$/.test(schema))throw new Error('Unsafe fixture');await control.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await control.end();}
})().catch(error=>{console.error(error);process.exitCode=1;});
`;
console.log(execFileSync('docker',['--context','desktop-linux','compose','-f','infra/compose/core.yml','exec','-T','-w','/app/apps/api','api','pnpm','exec','tsx','--eval',source],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:90000}).trim());
console.log('Typed workflow signed HTTP passed: typed create/update/read/query, strict conversion, stable replay and metadata-only execution evidence.');
