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
for(const username of ['alice','sales2','warehouse']){
 const login=await fetch('http://localhost:8081/realms/lattice/protocol/openid-connect/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'password',client_id:'dx-local',username,password:`local-${username}-password`}),signal:AbortSignal.timeout(15000)});assert.equal(login.status,200);const token=(await login.json()).access_token;actors[username]={token,subject:JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString()).sub};
}
async function call(path,method='GET',body,expected=200,user='alice',key=randomUUID()){
 const response=await fetch('http://localhost:8080'+path,{method,headers:{authorization:'Bearer '+actors[user].token,'content-type':'application/json','Idempotency-Key':key},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});const result=await response.json();assert.equal(response.status,expected,`${user} ${method} ${path}: ${JSON.stringify(result)}`);return result;
}
const tag=randomUUID().replaceAll('-',''),schemaId='context-'+tag,definitionId='context-'+tag;
await call('/v1/entity-schemas','POST',{id:schemaId,title:'Business context',fields:{note:{type:'text'}},relations:{}},201);await call('/v1/entity-schemas/'+schemaId+'/publish','POST',{expectedRevision:1});
let entity=await call('/v1/entities','POST',{schemaId,title:'Shared asset',attributes:{note:'Private attribute'}},201);
await call('/v1/workflow-drafts','POST',{definition:{id:definitionId,title:'Entity workflow',startRole:'logistics:sales',initialState:'draft',startFields:{},readerRoles:['logistics:warehouse'],transitions:[{id:'finish',from:'draft',to:'done',role:'logistics:sales',ownerOnly:true,fields:{}}]}},201);await call('/v1/workflow-drafts/'+definitionId+'/publish','POST',{expectedRevision:1});
const input={definitionId,title:'Linked asset workflow',input:{},entityContext:{entityId:entity.id}},key=randomUUID(),run=await call('/v1/workflows','POST',input,201,'alice',key);
assert.equal(run.recordId,run.id);assert.notEqual(run.recordId,entity.id);assert.equal(run.entityContext.entityId,entity.id);
assert.deepEqual(await call('/v1/workflows','POST',input,201,'alice',key),run);
assert.ok((await call('/v1/entities/'+entity.id+'/workflows')).items.some(row=>row.id===run.id));
await call('/v1/workflows/'+run.id+'/entity-context','GET',undefined,404,'warehouse');
entity=await call('/v1/entities/'+entity.id+'/shares','POST',{expectedVersion:entity.version,principal:{kind:'person',id:actors.warehouse.subject},permission:'read'});
const context=await call('/v1/workflows/'+run.id+'/entity-context','GET',undefined,200,'warehouse');assert.equal(context.context.entityId,entity.id);assert.ok(!JSON.stringify(context).includes('Private attribute'));
entity=await call('/v1/entities/'+entity.id+'/shares','POST',{expectedVersion:entity.version,principal:{kind:'person',id:actors.sales2.subject},permission:'read'});
assert.equal((await call('/v1/entities/'+entity.id+'/workflows','GET',undefined,200,'sales2')).items.length,0);
const peerKey=randomUUID();await call('/v1/workflows','POST',input,201,'sales2',peerKey);
entity=await call('/v1/entities/'+entity.id+'/shares/person/'+actors.sales2.subject,'DELETE',{expectedVersion:entity.version});
await call('/v1/workflows','POST',input,404,'sales2',peerKey);await call('/v1/workflows','POST',{...input,title:'Altered after revoke'},404,'sales2',peerKey);
const source=`
import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import pg from 'pg';import {recordDatabase} from './src/database.ts';import {foundationDatabase} from './src/foundation-database.ts';import {entityDatabase} from './src/entities/database.ts';import {entityDataToolsDatabase} from './src/entities/data-tools-database.ts';import {definitionDatabase} from './src/workflows/registry-database.ts';import {workflowDatabase} from './src/workflows/database.ts';
(async()=>{const control=new pg.Pool({connectionString:process.env.DATABASE_URL}),schema='entity_context_smoke_'+randomUUID().replaceAll('-','');let pool;
try{
 await control.query('CREATE SCHEMA '+schema);pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,max:5,connectionTimeoutMillis:5000});await recordDatabase(pool);await foundationDatabase(pool);let entities=await entityDatabase(pool),registry=await definitionDatabase(pool),workflows=await workflowDatabase(pool,registry);const tools=await entityDataToolsDatabase(pool);
 const owner={actorId:'owner',organizationId:'a'},readerScope={actorId:'reader',organizationId:'a'},actor={subject:'owner',organizationId:'a',roles:['employee','workflow:start','workflow:design','data:read']},reader={subject:'reader',organizationId:'a',roles:['employee','workflow:start','manager','data:read']};
 await pool.query("INSERT INTO directory_people(subject,organization_id,display_name,enabled) VALUES('owner','a','Owner',true),('reader','a','Reader',true)");
 const schemaDef={id:'asset',title:'Asset',fields:{note:{type:'text'}},relations:{}};await entities.createSchema(owner,schemaDef);await entities.publishSchema(owner,'asset',1);let asset=await entities.create(owner,{schemaId:'asset',title:'Asset',attributes:{note:'Private'}},'asset');
 const definition={id:'linked',title:'Linked',startRole:'employee',initialState:'draft',startFields:{},readerRoles:['manager'],transitions:[{id:'finish',from:'draft',to:'done',role:'employee',ownerOnly:true,fields:{}}]};await registry.create(definition,actor);await registry.publish(definition.id,1,actor);
 const input={definitionId:'linked',title:'Linked workflow',input:{},entityContext:{entityId:asset.id}};
 await pool.query('ALTER TABLE workflow_starts ADD CONSTRAINT fail_context_receipt CHECK(false) NOT VALID');await assert.rejects(()=>workflows.create(input,actor,'start'));assert.equal((await pool.query('SELECT count(*) FROM workflow_runs')).rows[0].count,'0');assert.equal((await pool.query('SELECT count(*) FROM workflow_entity_contexts')).rows[0].count,'0');assert.equal((await pool.query('SELECT count(*) FROM workflow_audit')).rows[0].count,'0');await pool.query('ALTER TABLE workflow_starts DROP CONSTRAINT fail_context_receipt');
 const starts=await Promise.all(Array.from({length:5},()=>workflows.create(input,actor,'start')));for(const row of starts)assert.deepEqual(row,starts[0]);assert.equal((await pool.query('SELECT count(*) FROM workflow_entity_contexts')).rows[0].count,'1');const run=starts[0];
 await assert.rejects(()=>workflows.create(input,{...actor,roles:actor.roles.filter(role=>role!=='data:read')},'start'),e=>e.statusCode===403);await assert.rejects(()=>workflows.entityContext(run.id,reader),e=>e.statusCode===404);
 asset=await entities.share(owner,asset.id,{expectedVersion:asset.version,principal:{kind:'person',id:'reader'},permission:'read'},'share');assert.equal((await workflows.entityContext(run.id,reader)).context.schemaVersion,1);assert.equal((await workflows.listEntityWorkflows(asset.id,reader,{limit:100,offset:0,q:''})).items.length,1);
 await entities.saveSchema(owner,'asset',{...schemaDef,fields:{...schemaDef.fields,extra:{type:'text'}},expectedRevision:1});await entities.publishSchema(owner,'asset',2);const migration={expectedVersion:asset.version,targetSchemaVersion:2,attributes:{note:'New',extra:'Field'}},dry=await tools.migrationDryRun(owner,asset.id,migration);asset=await tools.migrationCommit(owner,asset.id,{...migration,expectedDigest:dry.digest},'migrate');const context=await workflows.entityContext(run.id,reader);assert.equal(context.context.schemaVersion,1);assert.equal(context.current.schemaVersion,2);
 const peer=await workflows.create(input,reader,'peer-start');asset=await entities.revokeShare(owner,asset.id,{expectedVersion:asset.version,kind:'person',principalId:'reader'},'revoke');await assert.rejects(()=>workflows.create(input,reader,'peer-start'),e=>e.statusCode===404);await assert.rejects(()=>workflows.entityContext(peer.id,reader),e=>e.statusCode===404);
 asset=await entities.share(owner,asset.id,{expectedVersion:asset.version,principal:{kind:'person',id:'reader'},permission:'read'},'reshare');const hidden={...definition,id:'hidden',readerRoles:[]};await registry.create(hidden,actor);await registry.publish(hidden.id,1,actor);
 for(let i=0;i<104;i++)await workflows.create({...input,title:'Visible '+i},actor,'visible-'+i);for(let i=0;i<105;i++)await workflows.create({...input,definitionId:'hidden',title:'Hidden '+i},actor,'hidden-'+i);
 const first=await workflows.listEntityWorkflows(asset.id,reader,{limit:100,offset:0,q:''}),second=await workflows.listEntityWorkflows(asset.id,reader,{limit:100,offset:100,q:''});assert.equal(first.items.length,100);assert.equal(second.items.length,6);assert.equal(new Set([...first.items,...second.items].map(row=>row.id)).size,106);assert.ok([...first.items,...second.items].every(row=>row.definitionId==='linked'));
 await pool.end();pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,max:1,connectionTimeoutMillis:5000});registry=await definitionDatabase(pool);workflows=await workflowDatabase(pool,registry);assert.deepEqual(await workflows.create(input,actor,'start'),run);assert.equal((await workflows.entityContext(run.id,actor)).context.schemaVersion,1);const next=await workflows.create({...input,title:'Fresh max1'},actor,'fresh');assert.equal(next.entityContext.schemaVersion,2);assert.equal((await workflows.listEntityWorkflows(asset.id,actor,{limit:1,offset:0,q:''})).items.length,1);
 console.log('Entity context PostgreSQL passed: late receipt rollback, five starts one link, role/current grant before replay, original/current schema distinction, no implicit grant, 106 visible runs paged before hidden rows, max1 restart and fresh execution.');
}finally{await pool?.end();if(!/^entity_context_smoke_[a-f0-9]{32}$/.test(schema))throw new Error('Unsafe fixture');await control.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await control.end();}
})().catch(error=>{console.error(error);process.exitCode=1;});
`;
console.log(execFileSync('docker',['--context','desktop-linux','compose','-f','infra/compose/core.yml','exec','-T','-w','/app/apps/api','api','pnpm','exec','tsx','--eval',source],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:120000}).trim());
console.log('Entity context signed HTTP passed: independent record ID, linked navigation, both run/entity policies, metadata-only context and grant/revoke replay denial.');
