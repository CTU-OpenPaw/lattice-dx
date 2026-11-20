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
const root=fileURLToPath(new URL('../',import.meta.url)),actors={};
for(const username of ['alice','warehouse','bob']){
 const response=await fetch('http://localhost:8081/realms/lattice/protocol/openid-connect/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'password',client_id:'dx-local',username,password:`local-${username}-password`})});
 assert.equal(response.status,200);const token=(await response.json()).access_token;
 actors[username]={token,subject:JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString()).sub};
}
async function call(path,method='GET',body,expected=200,user='alice',key=randomUUID()){
 const response=await fetch('http://localhost:8080'+path,{method,headers:{authorization:`Bearer ${actors[user].token}`,'content-type':'application/json','Idempotency-Key':key},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});
 const result=await response.json();assert.equal(response.status,expected,`${user} ${method} ${path}: ${JSON.stringify(result)}`);return result;
}
const schemaId='query-'+randomUUID().replaceAll('-','');
await call('/v1/entity-schemas','POST',{id:schemaId,title:'Typed query',fields:{cost:{type:'decimal',required:true},quantity:{type:'integer'},label:{type:'text'},active:{type:'boolean'},day:{type:'date'}},relations:{}},201);
await call(`/v1/entity-schemas/${schemaId}/publish`,'POST',{expectedRevision:1});
const create={schemaId,title:'Precision data',attributes:{cost:'9007199254740993.01',quantity:1,label:'Stock',active:true,day:'2026-10-14'}},createKey=randomUUID();
let entity=await call('/v1/entities','POST',create,201,'alice',createKey);
assert.deepEqual((await call('/v1/blocks/entities.create/run','POST',{version:1,input:create},200,'alice',createKey)).result,entity);
await call('/v1/blocks/entities.create/run','POST',{version:1,input:{...create,title:'Changed'}},409,'alice',createKey);
const catalog=await call('/v1/blocks');assert.equal(catalog.items.filter(row=>row.id.startsWith('entities.')).length,7);assert.ok(catalog.items.every(row=>row.inputSchema&&row.outputSchema));
await call('/v1/blocks/entities.read/run','POST',{version:2,input:{id:entity.id}},400);
await call('/v1/blocks/entities.read/run','POST',{version:1,input:{id:entity.id}},403,'bob');
await call('/v1/blocks/arbitrary.run/run','POST',{version:1,input:{}},404);
const query={schemaId,schemaVersion:1,filters:[{field:'cost',operator:'gt',value:'9007199254740993.00'}],sort:{field:'cost',direction:'asc'},limit:1,offset:0};
assert.equal((await call('/v1/entities/query','POST',query)).items[0].id,entity.id);
assert.equal((await call('/v1/blocks/entities.query/run','POST',{version:1,input:query})).result.items[0].id,entity.id);
await call('/v1/entities/query','POST',{...query,filters:[{field:'active',operator:'gt',value:true}]},400);
await call('/v1/entities/query','POST',{...query,organizationId:'org-b'},400);
entity=await call(`/v1/entities/${entity.id}/shares`,'POST',{expectedVersion:entity.version,principal:{kind:'person',id:actors.warehouse.subject},permission:'read'});
assert.equal((await call('/v1/entities/query','POST',query,200,'warehouse')).items.length,1);
entity=await call(`/v1/entities/${entity.id}/shares/person/${actors.warehouse.subject}`,'DELETE',{expectedVersion:entity.version});
assert.equal((await call('/v1/entities/query','POST',query,200,'warehouse')).items.length,0);
await call('/v1/blocks/entities.read/run','POST',{version:1,input:{id:entity.id}},404,'warehouse');
const edit={expectedVersion:entity.version,title:'Block update',attributes:{...create.attributes,quantity:2}},updateKey=randomUUID();
entity=(await call('/v1/blocks/entities.update/run','POST',{version:1,input:{id:entity.id,...edit}},200,'alice',updateKey)).result;
assert.deepEqual(await call(`/v1/entities/${entity.id}`,'PATCH',edit,200,'alice',updateKey),entity);

const sqlSource=`
import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import pg from 'pg';import {entityDatabase} from './src/entities/database.ts';
(async()=>{const control=new pg.Pool({connectionString:process.env.DATABASE_URL}),schema='query_smoke_'+randomUUID().replaceAll('-','');let pool;
 try{
  await control.query('CREATE SCHEMA '+schema);pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,max:5});let repo=await entityDatabase(pool);
  const owner={actorId:'owner',organizationId:'a'},peer={actorId:'peer',organizationId:'a'};
  const def={id:'query-data',title:'Query',fields:{cost:{type:'decimal'},n:{type:'integer'},label:{type:'text'},active:{type:'boolean'},day:{type:'date'}},relations:{}};
  await repo.createSchema(owner,def);await repo.publishSchema(owner,def.id,1);
  await repo.createSchema(owner,{id:'unrelated-text',title:'Unrelated',fields:{cost:{type:'text'}},relations:{}});await repo.publishSchema(owner,'unrelated-text',1);
  await repo.create(owner,{schemaId:'unrelated-text',title:'Unrelated cast adversary',attributes:{cost:'not-numeric'}},'unrelated');
  const low=await repo.create(owner,{schemaId:def.id,title:'Low',attributes:{cost:'9007199254740993.00',n:1,label:'Warehouse',active:false,day:'2026-10-13'}},'low');
  const high=await repo.create(owner,{schemaId:def.id,title:'High',attributes:{cost:'9007199254740993.01',n:2,label:'Warehouse stock',active:true,day:'2026-10-14'}},'high');
  await repo.create(owner,{schemaId:def.id,title:'Missing',attributes:{}},'missing');
  const q={schemaId:def.id,schemaVersion:1,limit:100,offset:0};
  assert.deepEqual((await repo.query(owner,{...q,filters:[{field:'cost',operator:'gt',value:'9007199254740993.00'}]})).items.map(row=>row.id),[high.id]);
  assert.equal((await repo.query(owner,{...q,filters:[{field:'n',operator:'ne',value:1}]})).items.length,1);
  assert.equal((await repo.query(owner,{...q,filters:[{field:'cost',operator:'exists'}]})).items.length,2);
  assert.equal((await repo.query(owner,{...q,filters:[{field:'label',operator:'contains',value:'stock'}]})).items.length,1);
  const sorted=await repo.query(owner,{...q,sort:{field:'cost',direction:'asc'}});assert.equal(sorted.items[0].id,low.id);assert.equal(sorted.items[1].id,high.id);assert.equal(sorted.items[2].title,'Missing');
  assert.equal((await repo.query(peer,q)).items.length,0);
  await assert.rejects(()=>repo.query(owner,{...q,filters:[{field:'unknown',operator:'eq',value:'a'}]}),e=>e.statusCode===400);
  await assert.rejects(()=>repo.query(owner,{...q,schemaVersion:999}),e=>e.statusCode===404);
  await repo.saveSchema(owner,def.id,{...def,expectedRevision:1,fields:{...def.fields,extra:{type:'text'}}});await repo.publishSchema(owner,def.id,2);
  await repo.create(owner,{schemaId:def.id,title:'New version',attributes:{cost:'1'}},'v2');
  assert.equal((await repo.query(owner,q)).items.length,3);assert.equal((await repo.query(owner,{...q,schemaVersion:2})).items.length,1);
  const pagePrefix='Page '+randomUUID();
  for(let i=0;i<105;i++)await repo.create(owner,{schemaId:def.id,title:pagePrefix+i,attributes:{n:i}},'page-'+i);
  const pageQuery={...q,schemaVersion:2,filters:[{field:'n',operator:'gte',value:0}],sort:{field:'n',direction:'asc'},limit:100};
  const first=await repo.query(owner,pageQuery),second=await repo.query(owner,{...pageQuery,offset:first.page.nextOffset});assert.equal(first.items.length,100);assert.equal(second.items.length,5);assert.equal(first.items[0].attributes.n,0);assert.equal(second.items[4].attributes.n,104);
  await pool.end();pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,max:1});repo=await entityDatabase(pool);assert.equal((await repo.query(owner,pageQuery)).items.length,100);
  console.log('Typed query SQL passed: exact decimal, type validation, exists/ne/missing, pinned schema, ACL, deterministic NULL-last sort, 105 pagination and max1 reconnect.');
 }finally{await pool?.end();if(!/^query_smoke_[a-f0-9]{32}$/.test(schema))throw new Error('Unsafe fixture');await control.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await control.end();}
})().catch(error=>{console.error(error);process.exitCode=1;});
`;
console.log(execFileSync('docker',['--context','desktop-linux','compose','-f','infra/compose/core.yml','exec','-T','-w','/app/apps/api','api','pnpm','exec','tsx','--eval',sqlSource],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:90000}).trim());
console.log(JSON.stringify({result:'Entity query/block HTTP passed',entityId:entity.id,schemaId}));
