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
 const r=await fetch('http://localhost:8080'+path,{method,headers:{authorization:`Bearer ${actors[user].token}`,'content-type':'application/json','Idempotency-Key':key,'X-Request-Id':'organization-smoke'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});
 const data=await r.json();assert.equal(r.status,expected,`${user} ${method} ${path}: ${JSON.stringify(data)}`);assert.ok(r.headers.get('x-request-id'));return data;
}
assert.equal((await fetch('http://localhost:8080/ready')).status,200);
assert.equal((await call('/v1/operations/diagnostics')).database,'reachable');
await call('/v1/operations/diagnostics','GET',undefined,403,'warehouse');
assert.equal((await call('/v1/operations/retention-preview?before=2020-01-01T00:00:00Z')).dryRun,true);
await call('/v1/operations/retention-preview?before=9999-01-01T00:00:00Z','GET',undefined,400);
const id='dept-'+randomUUID().replaceAll('-','');
let dept=await call('/v1/organization/departments','POST',{id,name:'Demo department',parentId:null,managerId:actors.warehouse.subject},201);
await call('/v1/organization/departments','POST',{id:id+'x',name:'Denied',parentId:null,managerId:null},403,'warehouse');
dept=await call(`/v1/organization/departments/${id}`,'PATCH',{expectedVersion:dept.version,name:'Updated department',parentId:null,managerId:null});
assert.equal((await call(`/v1/organization/departments/${id}/history`)).items.length,2);
assert.ok((await call(`/v1/organization/departments?q=${id}`)).items.some(row=>row.id===id));
assert.ok(Number.isInteger((await call('/v1/organization/directory-state')).revision));
// Do not replace the live directory: teammate identities are preserved.
const sqlSource=`
import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import pg from 'pg';
import {organizationDatabase} from './src/organization/database.ts';import {createDirectoryDatabase} from './src/directory-database.ts';import {entityDatabase} from './src/entities/database.ts';import {recordDatabase} from './src/database.ts';import {foundationDatabase} from './src/foundation-database.ts';import {createWorkflowTables} from './src/workflows/schema.ts';import {taskLifecycleDatabase} from './src/tasks/database.ts';import {operationsDatabase} from './src/operations/database.ts';
(async()=>{const control=new pg.Pool({connectionString:process.env.DATABASE_URL}),schema='organization_smoke_'+randomUUID().replaceAll('-','');let pool;
 try{
  await control.query('CREATE SCHEMA '+schema);pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,max:5});
  await recordDatabase(pool);await createDirectoryDatabase(pool);await foundationDatabase(pool);await createWorkflowTables(pool);const tasks=await taskLifecycleDatabase(pool);let repo=await organizationDatabase(pool),entities=await entityDatabase(pool);
  const admin={subject:'admin',organizationId:'a',roles:['directory:manage']},peer={subject:'peer',organizationId:'a',roles:[]},foreign={subject:'admin',organizationId:'b',roles:['directory:manage']};
  const people=[{subject:'admin',displayName:'Admin',roles:['directory:manage'],enabled:true,departmentId:'sales'},{subject:'peer',displayName:'Peer',roles:[],enabled:true,departmentId:'warehouse'}];
  let state=await repo.replaceSnapshot(admin,{expectedRevision:0,people},'initial');assert.equal(state.revision,1);
  assert.deepEqual(await repo.replaceSnapshot(admin,{expectedRevision:0,people:[...people].reverse()},'initial'),state);
  await assert.rejects(()=>repo.replaceSnapshot(peer,{expectedRevision:1,people},'denied'),e=>e.statusCode===403);
  const a=await repo.createDepartment(admin,{id:'a',name:'A',parentId:null,managerId:'peer'},'a'),b=await repo.createDepartment(admin,{id:'b',name:'B',parentId:null,managerId:null},'b');
  const cycles=await Promise.allSettled([repo.updateDepartment(admin,'a',{expectedVersion:1,name:'A',parentId:'b',managerId:null},'a-parent'),repo.updateDepartment(admin,'b',{expectedVersion:1,name:'B',parentId:'a',managerId:null},'b-parent')]);
  assert.equal(cycles.filter(row=>row.status==='fulfilled').length,1);assert.equal(cycles.find(row=>row.status==='rejected').reason.statusCode,409);
  await assert.rejects(()=>repo.createDepartment(foreign,{id:'foreign',name:'Foreign',parentId:'a',managerId:null},'foreign'),e=>e.statusCode===404);
  await assert.rejects(()=>repo.createDepartment(foreign,{id:'foreign',name:'Foreign',parentId:null,managerId:'peer'},'foreign-manager'),e=>e.statusCode===400);
  const owner={actorId:'admin',organizationId:'a'},reader={actorId:'peer',organizationId:'a'};
  const def={id:'shared',title:'Shared',fields:{name:{type:'text'}},relations:{}};await entities.createSchema(owner,def);await entities.publishSchema(owner,def.id,1);
  let entity=await entities.create(owner,{schemaId:def.id,title:'Entity',attributes:{name:'Shared'}},'entity');entity=await entities.share(owner,entity.id,{expectedVersion:entity.version,principal:{kind:'department',id:'warehouse'},permission:'read'},'share');
  await tasks.createQueue(admin,{title:'Warehouse task',departmentId:'warehouse'},'task');assert.ok(await entities.find(reader,entity.id));assert.equal((await tasks.queue(peer,{limit:100,offset:0,q:''})).items.length,1);
  const moved=people.map(person=>person.subject==='peer'?{...person,departmentId:'sales'}:person);state=await repo.replaceSnapshot(admin,{expectedRevision:state.revision,people:moved},'move');
  assert.equal(await entities.find(reader,entity.id),undefined);assert.equal((await tasks.queue(peer,{limit:100,offset:0,q:''})).items.length,0);
  await pool.query('ALTER TABLE organization_commands ADD CONSTRAINT org_fail_receipt CHECK(false) NOT VALID');
  await assert.rejects(()=>repo.replaceSnapshot(admin,{expectedRevision:state.revision,people:[]},'rollback'));
  assert.equal((await repo.directoryState('a')).revision,state.revision);assert.equal((await pool.query("SELECT enabled FROM directory_people WHERE subject='admin' AND organization_id='a'")).rows[0].enabled,true);
  await pool.query('ALTER TABLE organization_commands DROP CONSTRAINT org_fail_receipt');
  state=await repo.replaceSnapshot(admin,{expectedRevision:state.revision,people:[people[0]]},'disable');assert.equal((await pool.query("SELECT enabled FROM directory_people WHERE subject='peer' AND organization_id='a'")).rows[0].enabled,false);
  const prefix='Page department ';for(let i=0;i<105;i++)await repo.createDepartment(admin,{id:'page-'+i,name:prefix+String(i).padStart(3,'0'),parentId:null,managerId:null},'page-'+i);
  const first=await repo.listDepartments('a',{limit:100,offset:0,q:prefix}),second=await repo.listDepartments('a',{limit:100,offset:first.page.nextOffset,q:prefix});assert.equal(first.items.length,100);assert.equal(second.items.length,5);
  const ops=operationsDatabase(pool);assert.equal(await ops.ready(),true);const preview=await ops.retentionPreview('b',new Date().toISOString());assert.ok(preview.items.every(row=>row.count==='0'));
  await pool.end();pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,max:1});repo=await organizationDatabase(pool);assert.equal((await repo.directoryState('a')).revision,state.revision);assert.deepEqual(await repo.replaceSnapshot(admin,{expectedRevision:0,people},'initial'),{revision:1,updatedAt:(await pool.query("SELECT result FROM organization_commands WHERE key='initial'")).rows[0].result.updatedAt,changeCount:2});
  console.log('Organization SQL passed: current admin role, snapshot canonical replay/revision/rollback, cycle race, tenant manager/parent, member movement/disable resource revocation,105 paging, operations counts and max1 persistence.');
 }finally{await pool?.end();if(!/^organization_smoke_[a-f0-9]{32}$/.test(schema))throw new Error('Unsafe fixture');await control.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await control.end();}
})().catch(error=>{console.error(error);process.exitCode=1;});
`;
console.log(execFileSync('docker',['--context','desktop-linux','compose','-f','infra/compose/core.yml','exec','-T','-w','/app/apps/api','api','pnpm','exec','tsx','--eval',sqlSource],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:90000}).trim());
console.log(JSON.stringify({result:'Organization/operations HTTP passed',departmentId:id}));
