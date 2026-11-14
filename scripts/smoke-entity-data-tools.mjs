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
const login=await fetch('http://localhost:8081/realms/lattice/protocol/openid-connect/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'password',client_id:'dx-local',username:'alice',password:'local-alice-password'}),signal:AbortSignal.timeout(15000)});
assert.equal(login.status,200);const token=(await login.json()).access_token;
async function call(path,body,expected=200,key=randomUUID()){
 const response=await fetch('http://localhost:8080'+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','Idempotency-Key':key},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
 const result=await response.json();assert.equal(response.status,expected,JSON.stringify(result));return result;
}
const schemaId='tools-'+randomUUID().replaceAll('-','');
await call('/v1/entity-schemas',{id:schemaId,title:'Data tools acceptance',fields:{note:{type:'text',required:true},count:{type:'integer'}},relations:{}},201);
await call('/v1/entity-schemas/'+schemaId+'/publish',{expectedRevision:1});
const input={schemaId,schemaVersion:1,format:'csv',content:'title,note,count\r\n"CSV, quoted","Line one\nLine two",2\r\nFormula,=SUM(A1:A2),-3'};
const dry=await call('/v1/entity-imports/dry-run',input);assert.equal(dry.valid,true);assert.equal(dry.rowCount,2);
const key=randomUUID(),batch=await call('/v1/entity-imports/commit',{...input,expectedDigest:dry.digest},200,key);
assert.equal(batch.entityIds.length,2);assert.deepEqual(await call('/v1/entity-imports/commit',{...input,expectedDigest:dry.digest},200,key),batch);
await call('/v1/entity-imports/commit',{...input,content:input.content+'\nExtra,more,1',expectedDigest:dry.digest},409);
const exported=await call('/v1/entities/export',{query:{schemaId,schemaVersion:1,limit:100,offset:0},format:'csv'});
assert.ok(exported.content.includes("'=SUM(A1:A2)"));assert.ok(exported.content.includes('-3'));

const source=`
import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import pg from 'pg';
import {recordDatabase} from './src/database.ts';import {foundationDatabase} from './src/foundation-database.ts';import {entityDatabase} from './src/entities/database.ts';import {entityDataToolsDatabase} from './src/entities/data-tools-database.ts';
(async()=>{const control=new pg.Pool({connectionString:process.env.DATABASE_URL}),schema='data_tools_smoke_'+randomUUID().replaceAll('-','');let pool;
try{
 await control.query('CREATE SCHEMA '+schema);pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,max:5,connectionTimeoutMillis:5000});
 await recordDatabase(pool);let foundation=await foundationDatabase(pool),entities=await entityDatabase(pool),tools=await entityDataToolsDatabase(pool);
 const owner={actorId:'owner',organizationId:'a'},reader={actorId:'reader',organizationId:'a'},foreign={actorId:'reader',organizationId:'b'},page={limit:100,offset:0,q:''};
 await pool.query("INSERT INTO directory_people(subject,organization_id,display_name,enabled) VALUES('owner','a','Owner',true),('reader','a','Reader',true)");
 const definition={id:'tools',title:'Tools',fields:{note:{type:'text',required:true},count:{type:'integer'}},relations:{}};
 await entities.createSchema(owner,definition);await entities.publishSchema(owner,'tools',1);
 const input={schemaId:'tools',schemaVersion:1,format:'json',content:JSON.stringify([{title:'One',attributes:{note:'Private',count:1}},{title:'Two',attributes:{note:'Other',count:2}}])};
 const dry=await tools.importDryRun(owner,input);assert.equal(dry.valid,true);assert.equal((await pool.query('SELECT count(*) FROM enterprise_entities')).rows[0].count,'0');
 const commit={...input,expectedDigest:dry.digest};
 await pool.query('ALTER TABLE enterprise_commands ADD CONSTRAINT fail_tools_receipt CHECK(false) NOT VALID');
 await assert.rejects(()=>tools.importCommit(owner,commit,'batch'));assert.equal((await pool.query('SELECT count(*) FROM enterprise_entities')).rows[0].count,'0');assert.equal((await pool.query('SELECT count(*) FROM enterprise_audit')).rows[0].count,'0');
 await pool.query('ALTER TABLE enterprise_commands DROP CONSTRAINT fail_tools_receipt');
 const races=await Promise.all(Array.from({length:5},()=>tools.importCommit(owner,commit,'batch')));for(const result of races)assert.deepEqual(result,races[0]);assert.equal((await pool.query('SELECT count(*) FROM enterprise_entities')).rows[0].count,'2');const batch=races[0];
 let item=await entities.find(owner,batch.entityIds[0]);
 const file=await foundation.createFile({filename:'context.txt',ownerId:'owner',organizationId:'a',content:Buffer.from('Context private')});
 await assert.rejects(()=>tools.attach(owner,item.id,{fileId:file.id,expectedVersion:item.version},'attach'),e=>e.statusCode===409);
 await foundation.markFile(file.id,'clean');item=await tools.attach(owner,item.id,{fileId:file.id,expectedVersion:item.version},'attach');
 item=await entities.share(owner,item.id,{expectedVersion:item.version,principal:{kind:'person',id:'reader'},permission:'read'},'grant');
 assert.equal((await tools.attachmentContent(reader,item.id,file.id)).content.toString(),'Context private');assert.equal(await foundation.readFile(file.id,{subject:'reader',organizationId:'a'}),undefined);
 await assert.rejects(()=>tools.attachmentContent(foreign,item.id,file.id),e=>e.statusCode===404);
 await foundation.markFile(file.id,'infected');await assert.rejects(()=>tools.attachmentContent(reader,item.id,file.id),e=>e.statusCode===409);await foundation.markFile(file.id,'clean');
 item=await entities.revokeShare(owner,item.id,{expectedVersion:item.version,kind:'person',principalId:'reader'},'revoke');await assert.rejects(()=>tools.attachmentContent(reader,item.id,file.id),e=>e.statusCode===404);
 assert.equal((await tools.attachments(owner,item.id,page)).items.length,1);
 await entities.saveSchema(owner,'tools',{...definition,fields:{...definition.fields,extra:{type:'text',required:true}},expectedRevision:1});await entities.publishSchema(owner,'tools',2);
 assert.equal((await entities.find(owner,item.id)).schemaVersion,1);
 const migration={expectedVersion:item.version,targetSchemaVersion:2,attributes:{note:'Migrated',count:1,extra:'New field'}},preview=await tools.migrationDryRun(owner,item.id,migration);assert.equal(preview.valid,true);
 await assert.rejects(()=>tools.migrationCommit(reader,item.id,{...migration,expectedDigest:preview.digest},'denied'),e=>e.statusCode===404);
 const results=await Promise.allSettled(['one','two'].map(key=>tools.migrationCommit(owner,item.id,{...migration,expectedDigest:preview.digest},key)));assert.equal(results.filter(row=>row.status==='fulfilled').length,1);assert.equal(results.find(row=>row.status==='rejected').reason.statusCode,409);
 const migrated=await entities.find(owner,item.id);assert.equal(migrated.schemaVersion,2);assert.equal(migrated.ownerId,'owner');assert.equal((await tools.export(reader,{query:{schemaId:'tools',schemaVersion:2,limit:100},format:'json'})).content,'[]');
 const relatedDefinition={id:'linked',title:'Linked',fields:{note:{type:'text'}},relations:{related:{targetSchemaId:'tools'}}};
 await entities.createSchema(owner,relatedDefinition);await entities.publishSchema(owner,'linked',1);let linked=await entities.create(owner,{schemaId:'linked',title:'Linked',attributes:{note:'Before'}},'linked-create');linked=await entities.link(owner,linked.id,{name:'related',targetId:item.id,expectedVersion:linked.version},'linked-link');
 await entities.saveSchema(owner,'linked',{...relatedDefinition,relations:{},expectedRevision:1});await entities.publishSchema(owner,'linked',2);
 await assert.rejects(()=>tools.migrationDryRun(owner,linked.id,{expectedVersion:linked.version,targetSchemaVersion:2,attributes:{note:'After'}}),e=>e.statusCode===409);
 linked=await entities.unlink(owner,linked.id,{name:'related',targetId:item.id,expectedVersion:linked.version},'linked-unlink');const compatible={expectedVersion:linked.version,targetSchemaVersion:2,attributes:{note:'After'}},compatiblePreview=await tools.migrationDryRun(owner,linked.id,compatible);assert.equal(compatiblePreview.valid,true);
 await pool.end();pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,max:1,connectionTimeoutMillis:5000});entities=await entityDatabase(pool);tools=await entityDataToolsDatabase(pool);
 assert.deepEqual(await tools.importCommit(owner,commit,'batch'),batch);assert.equal((await tools.attachmentContent(owner,item.id,file.id)).content.toString(),'Context private');
 const single={...input,content:JSON.stringify([{title:'New connection',attributes:{note:'Pinned one'}}])},prepared=await tools.importDryRun(owner,single);const pinned=await tools.importCommit(owner,{...single,expectedDigest:prepared.digest},'max-one');assert.equal((await entities.find(owner,pinned.entityIds[0])).schemaVersion,1);
 console.log('Data tools PostgreSQL passed: dry-run no writes, batch receipt rollback, five concurrent imports one batch, clean contextual attachment without direct file access, scan/revocation/tenant denial, explicit migration race and max1 pinned import after restart.');
}finally{await pool?.end();if(!/^data_tools_smoke_[a-f0-9]{32}$/.test(schema))throw new Error('Unsafe fixture');await control.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await control.end();}
})().catch(error=>{console.error(error);process.exitCode=1;});
`;
console.log(execFileSync('docker',['--context','desktop-linux','compose','-f','infra/compose/core.yml','exec','-T','-w','/app/apps/api','api','pnpm','exec','tsx','--eval',source],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:90000}).trim());
console.log('Data tools signed HTTP passed: quoted CSV, typed negative integer, bounded dry-run, import replay/digest mismatch and formula-safe export.');
