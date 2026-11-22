/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import { dockerContextArgs } from './lib/docker-context.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const source=`
import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {mkdtemp,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import pg from 'pg';
import {recordDatabase} from './src/database.ts';import {createDirectoryDatabase} from './src/directory-database.ts';import {foundationDatabase} from './src/foundation-database.ts';import {entityDatabase} from './src/entities/database.ts';import {entityDataToolsDatabase} from './src/entities/data-tools-database.ts';import {definitionDatabase} from './src/workflows/registry-database.ts';import {workflowDatabase} from './src/workflows/database.ts';import {createFilesystemStore} from './src/files/filesystem-store.ts';import {offloadFileWithClient} from './src/files/storage-database.ts';import {loadFileContentWithClient,readFileMetadataWithClient} from './src/files/content.ts';
(async()=>{
 const control=new pg.Pool({connectionString:process.env.DATABASE_URL}),schema='content_smoke_'+randomUUID().replaceAll('-','');let pool;
 const objectRoot=await mkdtemp(join(tmpdir(),'latticedx-content-')),store=await createFilesystemStore(objectRoot),bytes=Buffer.from('Four authorized storage paths');
 try{
  await control.query('CREATE SCHEMA '+schema);const options={connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,connectionTimeoutMillis:5000};pool=new pg.Pool({...options,max:1});await recordDatabase(pool);await createDirectoryDatabase(pool);const foundation=await foundationDatabase(pool),entities=await entityDatabase(pool),tools=await entityDataToolsDatabase(pool),registry=await definitionDatabase(pool),workflows=await workflowDatabase(pool,registry);
  const actor={subject:'owner',organizationId:'a',roles:['employee','workflow:design','workflow:start','files:read','files:write','data:read','data:write']},peer={subject:'peer',organizationId:'a',roles:['employee','files:read','data:read']},scope={actorId:'owner',organizationId:'a'};
  await pool.query("INSERT INTO directory_people(subject,organization_id,display_name,enabled) VALUES('owner','a','Owner',true),('peer','a','Peer',true)");
  async function transaction(work){const client=await pool.connect();try{await client.query('BEGIN');const result=await work(client);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}
  async function file(name,recordId){const file=await foundation.createFile({filename:name,ownerId:'owner',organizationId:'a',content:bytes,...(recordId?{recordId}:{})});await foundation.markFile(file.id,'clean');return file;}
  const ownerFile=await file('owner.txt'),taskRecord=randomUUID();await pool.query("INSERT INTO records(id,title,owner_id,organization_id) VALUES($1,'Task record','owner','a')",[taskRecord]);const taskFile=await file('task.txt',taskRecord);const task=await foundation.createTask({title:'Handle record',assigneeId:'peer',organizationId:'a',createdBy:'owner',recordId:taskRecord},'task');
  const workflowFile=await file('workflow.txt'),definition={id:'file-flow',title:'File flow',startRole:'employee',initialState:'draft',startFields:{document:'file'},readerRoles:['employee'],transitions:[{id:'finish',from:'draft',to:'done',role:'employee',ownerOnly:true,fields:{}}]};await registry.create(definition,actor);await registry.publish(definition.id,1,actor);await workflows.create({definitionId:definition.id,title:'Share document',input:{document:workflowFile.id}},actor,'workflow');
  await entities.createSchema(scope,{id:'context',title:'Context',fields:{note:{type:'text'}},relations:{}});await entities.publishSchema(scope,'context',1);let entity=await entities.create(scope,{schemaId:'context',title:'Attachment',attributes:{note:'Value'}},'entity');const entityFile=await file('entity.txt');entity=await tools.attach(scope,entity.id,{expectedVersion:entity.version,fileId:entityFile.id},'attach');entity=await entities.share(scope,entity.id,{expectedVersion:entity.version,principal:{kind:'person',id:'peer'},permission:'read'},'share');
  for(const item of [ownerFile,taskFile,workflowFile,entityFile])await transaction(client=>offloadFileWithClient(client,item.id,1,store));
  async function read(id,who,context={kind:'foundation'}){return transaction(client=>loadFileContentWithClient(client,who,id,context,store));}
  assert.deepEqual((await read(ownerFile.id,actor)).content,bytes);assert.deepEqual((await read(taskFile.id,peer)).content,bytes);assert.deepEqual((await read(workflowFile.id,peer)).content,bytes);assert.deepEqual((await read(entityFile.id,peer,{kind:'entityAttachment',entityId:entity.id})).content,bytes);

  const externalPool=new pg.Pool({...options,max:1}),externalEntities=await entityDatabase(externalPool);
  try{
   async function heldRead(fileId,context){let ready,release;const started=new Promise(resolve=>ready=resolve),gate=new Promise(resolve=>release=resolve);const heldStore={...store,readVerified:async pointer=>{ready();await gate;return store.readVerified(pointer);}};const pending=transaction(client=>loadFileContentWithClient(client,peer,fileId,context,heldStore));await started;return {pending,release};}
   const scanRead=await heldRead(workflowFile.id,{kind:'foundation'});let scanChanged=false;const scanChange=externalPool.query("UPDATE foundation_files SET scan_status='rejected' WHERE id=$1",[workflowFile.id]).then(()=>{scanChanged=true;});await new Promise(resolve=>setTimeout(resolve,25));assert.equal(scanChanged,false);scanRead.release();assert.deepEqual((await scanRead.pending).content,bytes);await scanChange;await assert.rejects(()=>read(workflowFile.id,peer),e=>e.statusCode===409);
   const grantRead=await heldRead(entityFile.id,{kind:'entityAttachment',entityId:entity.id});let grantChanged=false;const grantChange=externalEntities.revokeShare(scope,entity.id,{expectedVersion:entity.version,kind:'person',principalId:'peer'},'held-revoke').then(row=>{grantChanged=true;entity=row;});await new Promise(resolve=>setTimeout(resolve,25));assert.equal(grantChanged,false);grantRead.release();assert.deepEqual((await grantRead.pending).content,bytes);await grantChange;assert.equal(await read(entityFile.id,peer,{kind:'entityAttachment',entityId:entity.id}),undefined);
  }finally{await externalPool.end();}
  assert.equal(await read(entityFile.id,peer),undefined);assert.equal(await read(ownerFile.id,{...peer,organizationId:'other'}),undefined);
  await pool.query("UPDATE foundation_tasks SET status='cancelled' WHERE id=$1",[task.id]);assert.equal(await read(taskFile.id,peer),undefined);entity=await entities.revokeShare(scope,entity.id,{expectedVersion:entity.version,kind:'person',principalId:'peer'},'revoke');assert.equal(await read(entityFile.id,peer,{kind:'entityAttachment',entityId:entity.id}),undefined);
  await foundation.markFile(ownerFile.id,'rejected');const metadata=await transaction(client=>readFileMetadataWithClient(client,actor,ownerFile.id,{kind:'foundation'}));assert.equal(metadata.scanStatus,'rejected');assert.ok(!Object.hasOwn(metadata,'content'));await assert.rejects(()=>read(ownerFile.id,actor),e=>e.statusCode===409);
  await foundation.markFile(ownerFile.id,'clean');const pointer=(await pool.query('SELECT object_key FROM foundation_files WHERE id=$1',[ownerFile.id])).rows[0];await writeFile(join(objectRoot,pointer.object_key),'Corrupt');await assert.rejects(()=>read(ownerFile.id,actor),e=>e.statusCode===503);assert.ok(await transaction(client=>readFileMetadataWithClient(client,actor,ownerFile.id,{kind:'foundation'})));
  console.log('File content PostgreSQL/filesystem passed: all four actual authorized download paths with max1, no generic attachment grant, current task cancellation/entity revoke/tenant denial, scan metadata preserved, nonclean bytes denied, corruption503 without metadata loss.');
 }finally{await pool?.end();if(!/^content_smoke_[a-f0-9]{32}$/.test(schema))throw new Error('Unsafe fixture');await control.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await control.end();}
})().catch(error=>{console.error(error);process.exitCode=1;});
`;
console.log(execFileSync('docker',[...dockerContextArgs(), 'compose','-f','infra/compose/core.yml','exec','-T','-w','/app/apps/api','api','pnpm','exec','tsx','--eval',source],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:90000}).trim());
