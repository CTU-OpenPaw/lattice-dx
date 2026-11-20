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
const root=fileURLToPath(new URL('../',import.meta.url)),base='http://localhost:8080',actors={};
for(const username of ['alice','warehouse','sales2','bob']){
 const r=await fetch('http://localhost:8081/realms/lattice/protocol/openid-connect/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'password',client_id:'dx-local',username,password:`local-${username}-password`}),signal:AbortSignal.timeout(15000)});
 assert.equal(r.status,200,`Login ${username}`);const token=(await r.json()).access_token;
 actors[username]={token,subject:JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString()).sub};
}
async function call(path,method='GET',body,expected=200,actor='alice',key=randomUUID()){
 const r=await fetch(base+path,{method,headers:{authorization:`Bearer ${actors[actor].token}`,'content-type':'application/json','Idempotency-Key':key},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});
 const raw=await r.text();let result;try{result=JSON.parse(raw);}catch{throw new Error(`${method} ${path} HTTP${r.status}: ${raw.slice(0,200)}`);}
 assert.equal(r.status,expected,`${actor} ${method} ${path}: ${JSON.stringify(result)}`);return result;
}
const schemaId='sharing-'+randomUUID().replaceAll('-','');
await call('/v1/entity-schemas','POST',{id:schemaId,title:'Shared data',fields:{note:{type:'text',required:true}},relations:{related:{targetSchemaId:schemaId}}},201);
await call(`/v1/entity-schemas/${schemaId}/publish`,'POST',{expectedRevision:1});
let source=await call('/v1/entities','POST',{schemaId,title:'Team entity',attributes:{note:'Shared current value'}},201);
await call(`/v1/entities/${source.id}`,'GET',undefined,404,'warehouse');
const read={expectedVersion:source.version,principal:{kind:'person',id:actors.warehouse.subject},permission:'read'},readKey=randomUUID();
source=await call(`/v1/entities/${source.id}/shares`,'POST',read,200,'alice',readKey);
assert.deepEqual(await call(`/v1/entities/${source.id}/shares`,'POST',read,200,'alice',readKey),source);
assert.equal((await call(`/v1/entities/${source.id}`,'GET',undefined,200,'warehouse')).id,source.id);
assert.ok((await call(`/v1/entities?schemaId=${schemaId}`,'GET',undefined,200,'warehouse')).items.some(e=>e.id===source.id));
await call(`/v1/entities/${source.id}`,'GET',undefined,404,'sales2');
await call(`/v1/entities/${source.id}`,'PATCH',{expectedVersion:source.version,title:'Read cannot edit',attributes:{note:'Denied'}},404,'warehouse');
source=await call(`/v1/entities/${source.id}/shares`,'POST',{...read,expectedVersion:source.version,permission:'edit'});
const editKey=randomUUID(),edit={expectedVersion:source.version,title:'Warehouse edit',attributes:{note:'Updated by recipient'}};
source=await call(`/v1/entities/${source.id}`,'PATCH',edit,200,'warehouse',editKey);
const history=await call(`/v1/entities/${source.id}/history?limit=1`,'GET',undefined,200,'warehouse');
assert.equal(history.items.length,1);assert.ok(!Object.hasOwn(history.items[0],'input'));assert.ok(!Object.hasOwn(history.items[0],'result'));
assert.ok(Object.hasOwn((await call(`/v1/entities/${source.id}/history`)).items[0],'result'));
await call(`/v1/entities/${source.id}/archive`,'POST',{expectedVersion:source.version},404,'warehouse');
await call(`/v1/entities/${source.id}/shares`,'GET',undefined,403,'warehouse');
assert.equal((await call(`/v1/entities/${source.id}/shares?limit=1`)).items.length,1);
source=await call(`/v1/entities/${source.id}/shares/person/${actors.warehouse.subject}`,'DELETE',{expectedVersion:source.version});
await call(`/v1/entities/${source.id}`,'GET',undefined,404,'warehouse');
await call(`/v1/entities/${source.id}`,'PATCH',edit,404,'warehouse',editKey);
await call(`/v1/entities/${source.id}`,'GET',undefined,403,'bob');

const sqlSource=`
import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import pg from 'pg';
import {entityDatabase} from './src/entities/database.ts';import {createDirectoryDatabase} from './src/directory-database.ts';
import {checkAccess} from './src/entities/access.ts';
(async()=>{const control=new pg.Pool({connectionString:process.env.DATABASE_URL});const schema='sharing_smoke_'+randomUUID().replaceAll('-','');let pool;
try{
 await control.query('CREATE SCHEMA '+schema);pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,max:5,connectionTimeoutMillis:5000});
 await createDirectoryDatabase(pool);let repo=await entityDatabase(pool);
 const owner={actorId:'owner',organizationId:'a'},reader={actorId:'reader',organizationId:'a'},peer={actorId:'peer',organizationId:'a'},foreign={actorId:'reader',organizationId:'b'};
 for(const [id,org,dept] of [['owner','a','hr'],['reader','a','it'],['peer','a','sales'],['reader','b','it']])await pool.query('INSERT INTO directory_people(subject,organization_id,display_name,department_id,enabled) VALUES($1,$2,$1,$3,true)',[id,org,dept]);
 const def={id:'case',title:'Shared case',fields:{note:{type:'text'}},relations:{related:{targetSchemaId:'case'}}};
 await repo.createSchema(owner,def);await repo.publishSchema(owner,def.id,1);
 let entity=await repo.create(owner,{schemaId:def.id,title:'Entity',attributes:{note:'Private'}},'create');
 const grant={principal:{kind:'department',id:'it'},permission:'edit'};
 entity=await repo.share(owner,entity.id,{...grant,expectedVersion:entity.version},'grant-it');
 assert.ok(await repo.find(reader,entity.id));assert.equal(await repo.find(peer,entity.id),undefined);assert.equal(await repo.find(foreign,entity.id),undefined);
 const noOp=await repo.share(owner,entity.id,{...grant,expectedVersion:entity.version},'grant-noop');assert.equal(noOp.version,entity.version);
 const edit={expectedVersion:entity.version,title:'Recipient update',attributes:{note:'New'}};
 entity=await repo.update(reader,entity.id,edit,'recipient-edit');
 await assert.rejects(()=>repo.archive(reader,entity.id,entity.version,'forbidden-archive'),e=>e.statusCode===404);
 await assert.rejects(()=>repo.share(reader,entity.id,{expectedVersion:entity.version,principal:{kind:'person',id:'peer'},permission:'read'},'delegate'),e=>e.statusCode===404);
 const sharedHistory=await repo.history(reader,entity.id,{limit:100,offset:0,q:''});assert.ok(sharedHistory.items.length>0);assert.ok(sharedHistory.items.every(row=>!Object.hasOwn(row,'input')&&!Object.hasOwn(row,'result')));
 assert.ok((await repo.history(owner,entity.id,{limit:100,offset:0,q:''})).items.every(row=>Object.hasOwn(row,'result')));
 await pool.query('UPDATE directory_people SET department_id=$1 WHERE subject=$2 AND organization_id=$3',['sales','reader','a']);
 assert.equal(await repo.find(reader,entity.id),undefined);await assert.rejects(()=>repo.update(reader,entity.id,edit,'recipient-edit'),e=>e.statusCode===404);
 await pool.query('UPDATE directory_people SET department_id=$1 WHERE subject=$2 AND organization_id=$3',['it','reader','a']);
 await pool.query('UPDATE directory_people SET enabled=false WHERE subject=$1 AND organization_id=$2',['reader','a']);assert.equal(await repo.find(reader,entity.id),undefined);
 await pool.query('UPDATE directory_people SET enabled=true WHERE subject=$1 AND organization_id=$2',['reader','a']);
 const races=await Promise.allSettled([repo.revokeShare(owner,entity.id,{expectedVersion:entity.version,kind:'department',principalId:'it'},'revoke'),repo.update(reader,entity.id,{expectedVersion:entity.version,title:'Race update',attributes:{note:'Race'}},'race-edit')]);
 assert.equal(races.filter(r=>r.status==='fulfilled').length,1);
 assert.ok([404,409].includes(races.find(r=>r.status==='rejected').reason.statusCode));entity=await repo.find(owner,entity.id);
 const grants=(await repo.shares(owner,entity.id,{limit:100,offset:0,q:''})).items;
 if(grants.length)entity=await repo.revokeShare(owner,entity.id,{expectedVersion:entity.version,kind:'department',principalId:'it'},'final-revoke');
 assert.equal(await repo.find(reader,entity.id),undefined);await assert.rejects(()=>repo.update(reader,entity.id,edit,'recipient-edit'),e=>e.statusCode===404);
 // A failed command receipt must roll back the grant, version and audit together.
 const auditBefore=(await repo.history(owner,entity.id,{limit:100,offset:0,q:''})).items.length;
 const rollbackGrant={expectedVersion:entity.version,principal:{kind:'person',id:'reader'},permission:'edit'};
 await pool.query('ALTER TABLE enterprise_commands ADD CONSTRAINT sharing_fail_receipt CHECK(false) NOT VALID');
 await assert.rejects(()=>repo.share(owner,entity.id,rollbackGrant,'rollback-grant'));
 assert.equal((await repo.find(owner,entity.id)).version,entity.version);
 assert.equal((await repo.shares(owner,entity.id,{limit:100,offset:0,q:''})).items.length,0);
 assert.equal((await repo.history(owner,entity.id,{limit:100,offset:0,q:''})).items.length,auditBefore);
 await pool.query('ALTER TABLE enterprise_commands DROP CONSTRAINT sharing_fail_receipt');
 entity=await repo.share(owner,entity.id,rollbackGrant,'rollback-grant');
 const target=await repo.create(peer,{schemaId:def.id,title:'Peer target',attributes:{note:'Separate authority'}},'target');
 await assert.rejects(()=>repo.link(reader,entity.id,{expectedVersion:entity.version,name:'related',targetId:target.id},'hidden-target'),e=>e.statusCode===404);
 let readableTarget=await repo.share(peer,target.id,{expectedVersion:target.version,principal:{kind:'person',id:'reader'},permission:'read'},'target-read');
 entity=await repo.link(reader,entity.id,{expectedVersion:entity.version,name:'related',targetId:target.id},'shared-link');
 assert.equal((await repo.relations(reader,entity.id,{limit:1,offset:0,q:''})).items[0].targetId,target.id);
 assert.equal((await repo.relations(owner,entity.id,{limit:1,offset:0,q:''})).items.length,0);
 assert.equal(await repo.find(owner,target.id),undefined);
 readableTarget=await repo.revokeShare(peer,target.id,{expectedVersion:readableTarget.version,kind:'person',principalId:'reader'},'target-revoke');
 assert.equal((await repo.relations(reader,entity.id,{limit:1,offset:0,q:''})).items.length,0);
 await assert.rejects(()=>repo.link(reader,entity.id,{expectedVersion:entity.version-1,name:'related',targetId:target.id},'shared-link'),e=>e.statusCode===404);
 let visibleTarget=await repo.create(owner,{schemaId:def.id,title:'Visible target',attributes:{note:'Visible'}},'visible-target');
 visibleTarget=await repo.share(owner,visibleTarget.id,{expectedVersion:visibleTarget.version,principal:{kind:'person',id:'reader'},permission:'read'},'visible-target-read');
 entity=await repo.link(reader,entity.id,{expectedVersion:entity.version,name:'related',targetId:visibleTarget.id},'visible-link');
 const mixedPage=await repo.relations(reader,entity.id,{limit:1,offset:0,q:''});
 assert.equal(mixedPage.items.length,1);assert.equal(mixedPage.items[0].targetId,visibleTarget.id);assert.equal(mixedPage.page.hasMore,false);
 readableTarget=await repo.share(peer,target.id,{expectedVersion:readableTarget.version,principal:{kind:'person',id:'reader'},permission:'read'},'restore-target-read');
 await repo.archive(peer,target.id,readableTarget.version,'archive-peer-target');
 entity=await repo.unlink(reader,entity.id,{expectedVersion:entity.version,name:'related',targetId:target.id},'unlink-archived-target');
 assert.equal((await repo.relations(reader,entity.id,{limit:100,offset:0,q:''})).items.length,1);
 // Permission validation holds the directory row until the entity write commits.
 const directoryClient=await pool.connect();
 await directoryClient.query('BEGIN');
 await directoryClient.query('SELECT id FROM enterprise_entities WHERE id=$1 FOR UPDATE',[entity.id]);
 await checkAccess(directoryClient,reader,entity,'edit');
 const timeoutClient=await pool.connect();
 try{
  await timeoutClient.query('BEGIN');await timeoutClient.query("SET LOCAL lock_timeout='150ms'");
  await assert.rejects(()=>timeoutClient.query('UPDATE directory_people SET enabled=false WHERE organization_id=$1 AND subject=$2',['a','reader']),e=>e.code==='55P03');
  await timeoutClient.query('ROLLBACK');
 }finally{timeoutClient.release();await directoryClient.query('ROLLBACK');directoryClient.release();}
 // Revoking a disabled recipient remains possible, and replay cannot expose the snapshot.
 await pool.query('UPDATE directory_people SET enabled=false WHERE subject=$1 AND organization_id=$2',['reader','a']);
 entity=await repo.revokeShare(owner,entity.id,{expectedVersion:entity.version,kind:'person',principalId:'reader'},'disabled-revoke');
 await assert.rejects(()=>repo.update(reader,entity.id,edit,'recipient-edit'),e=>e.statusCode===404);
 await pool.query('UPDATE directory_people SET enabled=true WHERE subject=$1 AND organization_id=$2',['reader','a']);
 const prefix='Shared page '+randomUUID();
 for(let i=0;i<105;i++){let e=await repo.create(owner,{schemaId:def.id,title:prefix+' '+i,attributes:{note:'Page'}},'page-'+i);await repo.share(owner,e.id,{expectedVersion:e.version,principal:{kind:'person',id:'reader'},permission:'read'},'page-share-'+i);}
 const first=await repo.list(reader,{limit:100,offset:0,q:prefix}),second=await repo.list(reader,{limit:100,offset:first.page.nextOffset,q:prefix});assert.equal(first.items.length,100);assert.equal(second.items.length,5);assert.equal(new Set([...first.items,...second.items].map(e=>e.id)).size,105);
 assert.equal((await repo.list(peer,{limit:100,offset:0,q:prefix})).items.length,0);
 await pool.end();pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,max:1,connectionTimeoutMillis:5000});repo=await entityDatabase(pool);
 assert.equal((await repo.list(reader,{limit:1,offset:0,q:prefix})).items.length,1);assert.equal(await repo.find(reader,entity.id),undefined);
 console.log('Sharing SQL passed: person/department grants, read/edit/owner boundaries, current membership and disable, revoke/replay isolation, shared history redaction, race serialization, grant/version/audit rollback, non-transitive relation visibility, directory row lock, 105-row shared paging and max1 reconnect.');
}finally{await pool?.end();if(!/^sharing_smoke_[a-f0-9]{32}$/.test(schema))throw new Error('Unsafe schema');await control.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await control.end();}})().catch(e=>{console.error(e);process.exitCode=1;});
`;
console.log(execFileSync('docker',['--context','desktop-linux','compose','-f','infra/compose/core.yml','exec','-T','-w','/app/apps/api','api','pnpm','exec','tsx','--eval',sqlSource],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:90000}).trim());
console.log('Entity sharing smoke passed: signed grant/read/edit/revoke, cross-owner denial, historic replay revocation and redacted audit.');
console.log(JSON.stringify({entityId:source.id,schemaId,note:'Retained local entity with grants revoked'}));
