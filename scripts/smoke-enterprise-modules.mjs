// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)),actors={};
for(const username of ['alice','warehouse']){
 const r=await fetch('http://localhost:8081/realms/lattice/protocol/openid-connect/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'password',client_id:'dx-local',username,password:`local-${username}-password`})});assert.equal(r.status,200);const token=(await r.json()).access_token;actors[username]={token,subject:JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString()).sub};
}
async function call(path,method='GET',body,expected=200,user='alice',key=randomUUID()){
 const r=await fetch('http://localhost:8080'+path,{method,headers:{authorization:`Bearer ${actors[user].token}`,'content-type':'application/json','Idempotency-Key':key},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});const result=await r.json();assert.equal(r.status,expected,`${user} ${method} ${path}: ${JSON.stringify(result)}`);return result;
}
const tag=randomUUID().replaceAll('-',''),moduleId='module-'+tag,schemaId='schema-'+tag,definitionId='flow-'+tag;
const definition={id:definitionId,title:'Module workflow',startRole:'employee',initialState:'draft',startFields:{name:'text'},readerRoles:[],transitions:[{id:'finish',from:'draft',to:'done',role:'employee',ownerOnly:true,fields:{}}]};
const manifest={format:'latticedx.enterprise-module',formatVersion:1,id:moduleId,version:'1.0.0',title:'Reusable module',schemas:[{id:schemaId,title:'Module entity',fields:{name:{type:'text'}},relations:{}}],bundle:{format:'latticedx.workflow-bundle',formatVersion:1,definitions:[definition]},blocks:[{id:'entities.create',version:1}],dependencies:[]};
const preview=await call('/v1/enterprise-modules/preview','POST',{manifest});assert.equal(preview.conflicts.length,0);
const installKey=randomUUID();let installed=await call('/v1/enterprise-modules/install','POST',{manifest},201,'alice',installKey);
assert.deepEqual(await call('/v1/enterprise-modules/install','POST',{manifest},201,'alice',installKey),installed);assert.equal(installed.enabled,false);
await call(`/v1/enterprise-modules/${moduleId}/versions/1.0.0/enabled`,'POST',{expectedRevision:installed.revision,enabled:true},409);
await call(`/v1/workflow-drafts/${definitionId}/publish`,'POST',{expectedRevision:1});
await call('/v1/workflows','POST',{definitionId,title:'Disabled standard start',input:{name:'Denied'}},409);
installed=await call(`/v1/enterprise-modules/${moduleId}/versions/1.0.0/enabled`,'POST',{expectedRevision:installed.revision,enabled:true});
const run=await call(`/v1/enterprise-modules/${moduleId}/versions/1.0.0/start`,'POST',{definitionId,title:'Module start',input:{name:'Value'}},201);
assert.equal(run.definitionVersion,1);assert.equal(run.ownerId,actors.alice.subject);
await call(`/v1/enterprise-modules/${moduleId}/versions/1.0.0/start`,'POST',{definitionId,title:'Denied start',input:{name:'Value'}},403,'warehouse');
installed=await call(`/v1/enterprise-modules/${moduleId}/versions/1.0.0/enabled`,'POST',{expectedRevision:installed.revision,enabled:false});
await call('/v1/workflows','POST',{definitionId,title:'Disabled standard start',input:{name:'Denied'}},409);
assert.equal((await call(`/v1/workflows/${run.id}`)).id,run.id);

const sqlSource=`
import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import pg from 'pg';import {recordDatabase} from './src/database.ts';import {foundationDatabase} from './src/foundation-database.ts';import {createDirectoryDatabase} from './src/directory-database.ts';import {entityDatabase} from './src/entities/database.ts';import {definitionDatabase} from './src/workflows/registry-database.ts';import {workflowDatabase} from './src/workflows/database.ts';import {modulesDatabase} from './src/modules/database.ts';
(async()=>{const control=new pg.Pool({connectionString:process.env.DATABASE_URL}),schema='module_smoke_'+randomUUID().replaceAll('-','');let pool;
 try{
  await control.query('CREATE SCHEMA '+schema);pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,max:5});await recordDatabase(pool);await createDirectoryDatabase(pool);await foundationDatabase(pool);await entityDatabase(pool);let registry=await definitionDatabase(pool),workflows=await workflowDatabase(pool,registry),repo=await modulesDatabase(pool,workflows);
  const actor={subject:'admin',organizationId:'a',roles:['data:design','workflow:design','workflow:start','employee']};
  const def={id:'module-flow',title:'Module workflow',startRole:'employee',initialState:'draft',startFields:{name:'text'},readerRoles:[],transitions:[{id:'finish',from:'draft',to:'done',role:'employee',ownerOnly:true,fields:{}}]};
  const manifest={format:'latticedx.enterprise-module',formatVersion:1,id:'fixture',version:'1.0.0',title:'Fixture',schemas:[{id:'module-schema',title:'Schema',fields:{name:{type:'text'}},relations:{}}],bundle:{format:'latticedx.workflow-bundle',formatVersion:1,definitions:[def]},blocks:[{id:'entities.create',version:1}],dependencies:[]};
  const preview=await repo.preview(manifest,actor);assert.equal(preview.conflicts.length,0);assert.equal((await pool.query('SELECT count(*) FROM enterprise_schemas')).rows[0].count,'0');
  const raceDefinitions=[{...def,id:'race-b'},{...def,id:'race-a'}];
  await pool.query("CREATE FUNCTION delay_draft() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id LIKE 'race-%' THEN PERFORM pg_sleep(0.1); END IF; RETURN NEW; END $$; CREATE TRIGGER delay_draft BEFORE INSERT ON workflow_definition_drafts FOR EACH ROW EXECUTE FUNCTION delay_draft()");
  const installs=await Promise.allSettled([repo.install({...manifest,id:'race-module',schemas:[],bundle:{...manifest.bundle,definitions:raceDefinitions}},actor,'race-install'),registry.createMany([...raceDefinitions].reverse(),actor)]);
  assert.equal(installs.filter(row=>row.status==='fulfilled').length,1);assert.equal(installs.find(row=>row.status==='rejected').reason.statusCode,409);
  await pool.query('DROP TRIGGER delay_draft ON workflow_definition_drafts; DROP FUNCTION delay_draft()');
  const commandTable=(await pool.query("SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename LIKE '%module%command%'")).rows[0]?.tablename;assert.ok(commandTable&&/^[a-z_]+$/.test(commandTable));
  const draftBefore=(await pool.query('SELECT count(*) FROM workflow_definition_drafts')).rows[0].count;
  await pool.query('ALTER TABLE '+commandTable+' ADD CONSTRAINT module_fail_receipt CHECK(false) NOT VALID');await assert.rejects(()=>repo.install(manifest,actor,'install'));assert.equal((await pool.query('SELECT count(*) FROM enterprise_schemas')).rows[0].count,'0');assert.equal((await pool.query('SELECT count(*) FROM workflow_definition_drafts')).rows[0].count,draftBefore);
  await pool.query('ALTER TABLE '+commandTable+' DROP CONSTRAINT module_fail_receipt');let installed=await repo.install(manifest,actor,'install');const installReceipt=installed;assert.deepEqual(await repo.install(manifest,actor,'install'),installed);
  await assert.rejects(()=>repo.install({...manifest,title:'Changed'},actor,'new-key'),e=>e.statusCode===409);
  await registry.publish(def.id,1,actor);installed=await repo.setEnabled('fixture','1.0.0',{expectedRevision:installed.revision,enabled:true},actor,'enable');
  const run=await repo.start('fixture','1.0.0',{definitionId:def.id,title:'Pinned',input:{name:'Value'}},actor,'start');assert.equal(run.definitionVersion,1);
  installed=await repo.setEnabled('fixture','1.0.0',{expectedRevision:installed.revision,enabled:false},actor,'disable');
  await assert.rejects(()=>workflows.create({definitionId:def.id,title:'Blocked',input:{name:'Denied'}},actor,'blocked'),e=>e.statusCode===409);assert.equal((await workflows.get(run.id,actor)).id,run.id);
  await pool.end();pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,max:1});registry=await definitionDatabase(pool);workflows=await workflowDatabase(pool,registry);repo=await modulesDatabase(pool,workflows);assert.equal((await repo.get('fixture','1.0.0',actor)).enabled,false);assert.deepEqual(await repo.install(manifest,actor,'install'),installReceipt);
  console.log('Module SQL passed: preview no effects, resource/receipt rollback, immutable same-version installs, published mappings, disabled normal starts, preserved historical read and max1 persistence.');
 }finally{await pool?.end();if(!/^module_smoke_[a-f0-9]{32}$/.test(schema))throw new Error('Unsafe fixture');await control.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await control.end();}
})().catch(error=>{console.error(error);process.exitCode=1;});
`;
console.log(execFileSync('docker',['--context','desktop-linux','compose','-f','infra/compose/core.yml','exec','-T','-w','/app/apps/api','api','pnpm','exec','tsx','--eval',sqlSource],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:90000}).trim());
console.log(JSON.stringify({result:'Enterprise module HTTP passed',moduleId,runId:run.id}));
