/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import { dockerContextArgs } from './lib/docker-context.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),base='http://localhost:8080',tokens={};
for(const username of ['alice','bob']){
 const r=await fetch('http://localhost:8081/realms/lattice/protocol/openid-connect/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'password',client_id:'dx-local',username,password:`local-${username}-password`}),signal:AbortSignal.timeout(15000)});
 assert.equal(r.status,200,`Login ${username}`);tokens[username]=(await r.json()).access_token;
}
async function call(path,method='GET',body,expected=200,actor='alice',key=randomUUID()){
 const r=await fetch(base+path,{method,headers:{authorization:`Bearer ${tokens[actor]}`,'content-type':'application/json','Idempotency-Key':key},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});
 const text=await r.text();let value;try{value=JSON.parse(text);}catch{throw new Error(`${method} ${path} HTTP${r.status}: ${text.slice(0,200)}`);}
 assert.equal(r.status,expected,`${actor} ${method} ${path}: ${JSON.stringify(value)}`);return value;
}
const suffix=randomUUID().replaceAll('-','');
const schema={id:'asset-'+suffix,title:'Enterprise asset',fields:{name:{type:'text',required:true,maxLength:200},active:{type:'boolean',required:true},count:{type:'integer',required:true},cost:{type:'decimal',required:true},purchasedOn:{type:'date',required:true},status:{type:'enum',required:true,choices:['ready','repair']}},relations:{related:{targetSchemaId:'asset-'+suffix}}};
const attributes={name:'Device',active:true,count:2,cost:'12345678901234567890.01',purchasedOn:'2026-02-28',status:'ready'};
await call('/v1/entity-schemas','POST',schema,201);
await call(`/v1/entity-schemas/${schema.id}/publish`,'POST',{expectedRevision:1});
await call('/v1/entity-schemas','POST',{...schema,id:'forbidden-'+suffix},403,'bob');
const key=randomUUID(),create={schemaId:schema.id,title:'Typed device',attributes};
let entity=await call('/v1/entities','POST',create,201,'alice',key);
assert.equal(entity.schemaVersion,1);assert.equal(entity.attributes.cost,attributes.cost);
assert.deepEqual(await call('/v1/entities','POST',create,201,'alice',key),entity);
await call('/v1/entities','POST',{...create,title:'Changed'},409,'alice',key);
await call('/v1/entities','POST',{...create,organizationId:'org-b'},400);
await call('/v1/entities','POST',{...create,attributes:{...attributes,count:'2'}},400);
await call('/v1/entities','POST',{...create,attributes:{...attributes,purchasedOn:'2026-02-30'}},400);
await call(`/v1/entities/${entity.id}`,'GET',undefined,403,'bob');
const edited={expectedRevision:1,title:schema.title,fields:{...schema.fields,serial:{type:'text',required:true}},relations:schema.relations};
await call(`/v1/entity-schemas/${schema.id}`,'PUT',edited);
await call(`/v1/entity-schemas/${schema.id}/publish`,'POST',{expectedRevision:2});
await call('/v1/entities','POST',create,400);
const latest=await call('/v1/entities','POST',{...create,title:'Latest device',attributes:{...attributes,serial:'SER-001'}},201);
assert.equal(latest.schemaVersion,2);
assert.ok(!Object.hasOwn((await call(`/v1/entity-schemas/${schema.id}/versions/1`)).fields,'serial'));
assert.ok(Object.hasOwn((await call(`/v1/entity-schemas/${schema.id}/versions/2`)).fields,'serial'));
await call(`/v1/entity-schemas/${schema.id}/versions/2147483648`,'GET',undefined,400);
const updateKey=randomUUID(),update={expectedVersion:entity.version,title:'Updated device',attributes:{...attributes,count:3}};
entity=await call(`/v1/entities/${entity.id}`,'PATCH',update,200,'alice',updateKey);
assert.equal(entity.schemaVersion,1);assert.equal(entity.attributes.count,3);
assert.deepEqual(await call(`/v1/entities/${entity.id}`,'PATCH',update,200,'alice',updateKey),entity);
await call(`/v1/entities/${entity.id}`,'PATCH',{...update,title:'Stale'},409);
const linkKey=randomUUID(),link={name:'related',targetId:latest.id,expectedVersion:entity.version};
entity=await call(`/v1/entities/${entity.id}/relations`,'POST',link,200,'alice',linkKey);
assert.deepEqual(await call(`/v1/entities/${entity.id}/relations`,'POST',link,200,'alice',linkKey),entity);
const relations=await call(`/v1/entities/${entity.id}/relations?limit=1`);assert.equal(relations.items.length,1);
entity=await call(`/v1/entities/${entity.id}/relations/related/${latest.id}`,'DELETE',{expectedVersion:entity.version});
assert.equal((await call(`/v1/entities/${entity.id}/relations`)).items.length,0);
const history=await call(`/v1/entities/${entity.id}/history?limit=2`);assert.equal(history.items.length,2);assert.ok(history.page.hasMore);
const archiveKey=randomUUID(),archive={expectedVersion:entity.version};
entity=await call(`/v1/entities/${entity.id}/archive`,'POST',archive,200,'alice',archiveKey);
assert.ok(entity.archivedAt);
assert.deepEqual(await call(`/v1/entities/${entity.id}/archive`,'POST',archive,200,'alice',archiveKey),entity);
assert.ok(!(await call(`/v1/entities?schemaId=${schema.id}`)).items.some(e=>e.id===entity.id));
await call(`/v1/entities/${entity.id}`,'PATCH',{expectedVersion:entity.version,title:'Cannot update archive',attributes},409);
assert.ok((await call(`/v1/entities/${entity.id}`)).archivedAt);

const sqlSource=`
import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import pg from 'pg';
import {entityDatabase} from './src/entities/database.ts';
(async()=>{const control=new pg.Pool({connectionString:process.env.DATABASE_URL});const schema='entity_smoke_'+randomUUID().replaceAll('-','');let pool;
try{
 await control.query('CREATE SCHEMA '+schema);
 pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,max:5,connectionTimeoutMillis:5000});
 let repo=await entityDatabase(pool);
 const a={actorId:'alice',organizationId:'org-a'},peer={actorId:'peer',organizationId:'org-a'},foreign={actorId:'alice',organizationId:'org-b'};
 const def={id:'typed-asset',title:'Typed asset',fields:{name:{type:'text',required:true},count:{type:'integer',required:true}},relations:{related:{targetSchemaId:'typed-asset'}}};
 await repo.createSchema(a,def);
 const publications=await Promise.all([repo.publishSchema(a,def.id,1),repo.publishSchema(a,def.id,1)]);
 assert.ok(publications.every(p=>p.version===1));
 await repo.createSchema(foreign,def);await repo.publishSchema(foreign,def.id,1);
 const create={schemaId:def.id,title:'Original',attributes:{name:'Device',count:1}};
 const same=await Promise.all(Array.from({length:5},()=>repo.create(a,create,'create-race')));
 assert.equal(new Set(same.map(e=>e.id)).size,1);let source=same[0];
 await pool.query('UPDATE enterprise_entities SET owner_id=$1 WHERE id=$2',[peer.actorId,source.id]);
 assert.equal(await repo.find(a,source.id),undefined);
 await assert.rejects(()=>repo.create(a,create,'create-race'),e=>e.statusCode===404);
 await pool.query('UPDATE enterprise_entities SET owner_id=$1 WHERE id=$2',[a.actorId,source.id]);
 await pool.query('UPDATE enterprise_entities SET organization_id=$1 WHERE id=$2',[foreign.organizationId,source.id]);
 await assert.rejects(()=>repo.create(a,create,'create-race'),e=>e.statusCode===404);
 await pool.query('UPDATE enterprise_entities SET organization_id=$1 WHERE id=$2',[a.organizationId,source.id]);
 const saves=await Promise.allSettled([repo.saveSchema(a,def.id,{expectedRevision:1,title:'Revision A',fields:{...def.fields,noteA:{type:'text'}},relations:def.relations}),repo.saveSchema(a,def.id,{expectedRevision:1,title:'Revision B',fields:{...def.fields,noteB:{type:'text'}},relations:def.relations})]);
 assert.equal(saves.filter(r=>r.status==='fulfilled').length,1);assert.equal(saves.find(r=>r.status==='rejected').reason.statusCode,409);
 await repo.publishSchema(a,def.id,2);
 const other=await repo.create(peer,create,'create-race'),otherOrg=await repo.create(foreign,create,'create-race');
 assert.equal(await repo.find(peer,source.id),undefined);
 assert.equal(await repo.find(foreign,source.id),undefined);
 const target=await repo.create(a,{...create,title:'Target'},'target');
 await assert.rejects(()=>repo.link(a,source.id,{name:'related',targetId:other.id,expectedVersion:1},'hidden-link'),e=>e.statusCode===404);
 const races=await Promise.allSettled(Array.from({length:5},(_,i)=>repo.update(a,source.id,{expectedVersion:1,title:'Update '+i,attributes:create.attributes},'update-'+i)));
 assert.equal(races.filter(r=>r.status==='fulfilled').length,1);assert.ok(races.filter(r=>r.status==='rejected').every(r=>r.reason.statusCode===409));
 source=await repo.find(a,source.id);
 source=await repo.link(a,source.id,{name:'related',targetId:target.id,expectedVersion:source.version},'link');
 const duplicate=await repo.link(a,source.id,{name:'related',targetId:target.id,expectedVersion:source.version},'link-noop');assert.equal(duplicate.version,source.version);
 assert.equal((await repo.relations(a,source.id,{limit:100,offset:0,q:''})).items.length,1);
 await repo.archive(a,target.id,target.version,'archive-target');
 assert.equal((await repo.relations(a,source.id,{limit:100,offset:0,q:''})).items.length,0);
 source=await repo.unlink(a,source.id,{name:'related',targetId:target.id,expectedVersion:source.version},'remove-archived-target');
 const beforeVersion=source.version,beforeAudit=(await repo.history(a,source.id,{limit:100,offset:0,q:''})).items.length;
 await pool.query('ALTER TABLE enterprise_commands ADD CONSTRAINT smoke_fail_receipt CHECK(false) NOT VALID');
 await assert.rejects(()=>repo.update(a,source.id,{expectedVersion:source.version,title:'Must rollback',attributes:create.attributes},'failed-update'));
 assert.equal((await repo.find(a,source.id)).version,beforeVersion);
 assert.equal((await repo.history(a,source.id,{limit:100,offset:0,q:''})).items.length,beforeAudit);
 await pool.query('ALTER TABLE enterprise_commands DROP CONSTRAINT smoke_fail_receipt');
 source=await repo.update(a,source.id,{expectedVersion:source.version,title:'Must rollback',attributes:create.attributes},'failed-update');
 assert.equal(source.version,beforeVersion+1);
 const pagePrefix='Page '+randomUUID();
 for(let i=0;i<105;i++)await repo.create(a,{...create,title:pagePrefix+' '+i},'page-'+i);
 const first=await repo.list(a,{limit:100,offset:0,q:pagePrefix}),second=await repo.list(a,{limit:100,offset:first.page.nextOffset,q:pagePrefix});
 assert.equal(first.items.length,100);assert.equal(second.items.length,5);assert.equal(new Set([...first.items,...second.items].map(e=>e.id)).size,105);
 const hiddenPage=await repo.list(peer,{limit:100,offset:0,q:pagePrefix});assert.equal(hiddenPage.items.length,0);
 await pool.end();pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,max:1,connectionTimeoutMillis:5000});repo=await entityDatabase(pool);
 assert.equal((await repo.create(a,create,'create-race')).id,source.id);
 const preserved=await repo.find(a,source.id);assert.equal(preserved.version,source.version);
 assert.ok((await repo.history(a,source.id,{limit:100,offset:0,q:''})).items.length>=3);
 console.log('Enterprise data SQL passed: typed schemas, equal-command and optimistic races, owner/tenant isolation, relational visibility/archive, 105-row pagination, fresh-pool persistence and max1.');
}finally{await pool?.end();if(!/^entity_smoke_[a-f0-9]{32}$/.test(schema))throw new Error('Unsafe schema');await control.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await control.end();}})().catch(e=>{console.error(e);process.exitCode=1;});
`;
console.log(execFileSync('docker',[...dockerContextArgs(), 'compose','-f','infra/compose/core.yml','exec','-T','-w','/app/apps/api','api','pnpm','exec','tsx','--eval',sqlSource],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:90000}).trim());
console.log('Enterprise data smoke passed: published typed schemas, pinned entity versions, safe CRUD/relations/archive, idempotency and paginated audit.');
console.log(JSON.stringify({schemaId:schema.id,archivedEntity:entity.id,latestEntity:latest.id,note:'Retained local demo schema and entities'}));
