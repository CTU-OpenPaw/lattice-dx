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
const root=fileURLToPath(new URL('../',import.meta.url));
const source=`
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {recordDatabase} from './src/database.ts';
import {foundationDatabase} from './src/foundation-database.ts';
import {entityDatabase} from './src/entities/database.ts';
import {definitionDatabase} from './src/workflows/registry-database.ts';
import {workflowDatabase} from './src/workflows/database.ts';
(async()=>{
 const control=new pg.Pool({connectionString:process.env.DATABASE_URL});
 const schema='private_blocks_smoke_'+randomUUID().replaceAll('-','');let pool;
 try{
  await control.query('CREATE SCHEMA '+schema);
  const options={connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema,connectionTimeoutMillis:5000};
  pool=new pg.Pool({...options,max:5});await recordDatabase(pool);await foundationDatabase(pool);
  let entities=await entityDatabase(pool),registry=await definitionDatabase(pool),workflows=await workflowDatabase(pool,registry);
  const scope={actorId:'owner',organizationId:'a'};
  const actor={subject:'owner',organizationId:'a',roles:['employee','workflow:design','workflow:start','data:read','data:write']};
  const reader={subject:'reader',organizationId:'a',roles:['employee','data:read']};
  await pool.query("INSERT INTO directory_people(subject,organization_id,display_name,enabled) VALUES('owner','a','Owner',true),('reader','a','Reader',true)");
  await entities.createSchema(scope,{id:'ledger',title:'Ledger',fields:{amount:{type:'decimal',required:true},optional:{type:'text'}},relations:{}});await entities.publishSchema(scope,'ledger',1);
  const literal=value=>({source:'literal',value});
  const ref=(source,stepId,field)=>({op:'ref',source,stepId,field});
  const expression=expression=>({source:'expression',expression});
  const entityId={source:'data',field:'entityId'};
  const steps=[
   {id:'source',action:'entities.project',input:{id:entityId,fields:['amount','optional']}},
   {id:'calculation',action:'data.evaluate',input:{values:{total:{op:'add',args:[ref('projection','source','amount'),{op:'literal',value:{type:'decimal',value:'0.20'}}]}}}},
   {id:'update',action:'entities.update',input:{id:{source:'result',stepId:'source',field:'id'},expectedVersion:{source:'result',stepId:'source',field:'version'},title:literal('Calculated'),attributes:{amount:expression(ref('evaluation','calculation','total'))}}},
   {id:'check',action:'data.assert',input:{condition:{op:'gt',args:[ref('evaluation','calculation','total'),{op:'literal',value:{type:'decimal',value:'0'}}]}}}
  ];
  const definition={id:'calculate',title:'Private calculations',startRole:'employee',initialState:'draft',startFields:{entityId:'text'},readerRoles:['employee'],transitions:[{id:'run',from:'draft',to:'done',role:'employee',ownerOnly:true,fields:{},steps}]};
  await registry.create(definition,actor);await registry.publish(definition.id,1,actor);
  const sourceEntity=await entities.create(scope,{schemaId:'ledger',title:'Private balance',attributes:{amount:'99999999999999999999.10'}},'source');
  const run=await workflows.create({definitionId:definition.id,title:'Calculate',input:{entityId:sourceEntity.id}},actor,'run');
  const command={action:'run',expectedVersion:1,input:{}};
  const receipts=await Promise.all(Array.from({length:5},()=>workflows.transition(run.id,command,actor,'calculate')));
  for(const receipt of receipts)assert.deepEqual(receipt,receipts[0]);
  assert.equal((await entities.find(scope,sourceEntity.id)).attributes.amount,'99999999999999999999.30');
  const evidence=JSON.stringify({run:await workflows.get(run.id,reader),history:await workflows.history(run.id,reader),executions:await workflows.executions(run.id,reader),jobs:await workflows.jobs(run.id,reader),receipt:receipts[0]});
  assert.ok(!evidence.includes('99999999999999999999'));assert.equal(await entities.find({actorId:'reader',organizationId:'a'},sourceEntity.id),undefined);
  const falseDefinition={...definition,id:'false-check',transitions:[{...definition.transitions[0],steps:[...steps.slice(0,3),{id:'check',action:'data.assert',input:{condition:{op:'literal',value:{type:'boolean',value:false}}}}]}]};
  await registry.create(falseDefinition,actor);await registry.publish(falseDefinition.id,1,actor);
  const failing=await workflows.create({definitionId:falseDefinition.id,title:'Rollback',input:{entityId:sourceEntity.id}},actor,'failing');
  const before=await entities.find(scope,sourceEntity.id),events=(await pool.query('SELECT count(*) FROM enterprise_entity_events')).rows[0].count;
  await assert.rejects(()=>workflows.transition(failing.id,command,actor,'fail'),e=>e.statusCode===409&&!e.message.includes('999999'));
  assert.deepEqual(await entities.find(scope,sourceEntity.id),before);assert.equal((await workflows.get(failing.id,actor)).version,1);assert.equal((await pool.query('SELECT count(*) FROM enterprise_entity_events')).rows[0].count,events);assert.equal((await workflows.executions(failing.id,actor)).length,0);

  const peerScope={actorId:'reader',organizationId:'a'};
  let peerEntity=await entities.create(peerScope,{schemaId:'ledger',title:'Peer balance',attributes:{amount:'12.00'}},'peer-source');
  peerEntity=await entities.share(peerScope,peerEntity.id,{expectedVersion:peerEntity.version,principal:{kind:'person',id:'owner'},permission:'read'},'peer-share');
  const readDefinition={...definition,id:'read-only',transitions:[{...definition.transitions[0],steps:[...steps.slice(0,2),steps[3]]}]};
  await registry.create(readDefinition,actor);await registry.publish(readDefinition.id,1,actor);
  const revoked=await workflows.create({definitionId:readDefinition.id,title:'Current grant',input:{entityId:peerEntity.id}},actor,'revoked-run');
  await entities.revokeShare(peerScope,peerEntity.id,{expectedVersion:peerEntity.version,kind:'person',principalId:'owner'},'peer-revoke');
  await assert.rejects(()=>workflows.transition(revoked.id,command,actor,'revoked'),e=>e.statusCode===404);assert.equal((await workflows.get(revoked.id,actor)).version,1);assert.equal((await workflows.executions(revoked.id,actor)).length,0);
  await pool.end();pool=new pg.Pool({...options,max:1});entities=await entityDatabase(pool);registry=await definitionDatabase(pool);workflows=await workflowDatabase(pool,registry);
  assert.deepEqual(await workflows.transition(run.id,command,actor,'calculate'),receipts[0]);
  const fresh=await workflows.create({definitionId:definition.id,title:'Max one',input:{entityId:sourceEntity.id}},actor,'max-one');await workflows.transition(fresh.id,command,actor,'max-one-transition');assert.equal((await entities.find(scope,sourceEntity.id)).attributes.amount,'99999999999999999999.50');
  console.log('Private workflow PostgreSQL passed: exact decimal projection/calculation/update, five-way replay, wider workflow reader sees metadata only, false assertion rolls back data/events/run/results, max1 restart and fresh execution.');
 }finally{await pool?.end();if(!/^private_blocks_smoke_[a-f0-9]{32}$/.test(schema))throw new Error('Unsafe fixture');await control.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await control.end();}
})().catch(error=>{console.error(error);process.exitCode=1;});
`;
console.log(execFileSync('docker',['--context','desktop-linux','compose','-f','infra/compose/core.yml','exec','-T','-w','/app/apps/api','api','pnpm','exec','tsx','--eval',source],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:90000}).trim());
const login=await fetch('http://localhost:8081/realms/lattice/protocol/openid-connect/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'password',client_id:'dx-local',username:'alice',password:'local-alice-password'}),signal:AbortSignal.timeout(15000)});assert.equal(login.status,200);
const token=(await login.json()).access_token;
const catalog=await fetch('http://localhost:8080/v1/workflow-blocks',{headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(15000)});assert.equal(catalog.status,200);const blocks=JSON.stringify(await catalog.json());for(const action of ['entities.project','data.evaluate','data.assert'])assert.ok(blocks.includes(action));
console.log('Private workflow signed HTTP passed: all three block descriptors available.');
async function call(path,body,expected=200){
 const response=await fetch('http://localhost:8080'+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','Idempotency-Key':randomUUID()},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});
 const result=await response.json();assert.equal(response.status,expected,JSON.stringify(result));return result;
}
const tag=randomUUID().replaceAll('-',''),schemaId='private-'+tag,definitionId='private-'+tag;
await call('/v1/entity-schemas',{id:schemaId,title:'Private calculation',fields:{amount:{type:'decimal'}},relations:{}},201);await call('/v1/entity-schemas/'+schemaId+'/publish',{expectedRevision:1});
const entity=await call('/v1/entities',{schemaId,title:'Private amount',attributes:{amount:'99999999999999999999.10'}},201);
const definition={id:definitionId,title:'Private calculation',startRole:'employee',initialState:'draft',startFields:{entityId:'text'},readerRoles:[],transitions:[{id:'run',from:'draft',to:'done',role:'employee',ownerOnly:true,fields:{},steps:[
 {id:'source',action:'entities.project',input:{id:{source:'data',field:'entityId'},fields:['amount']}},
 {id:'calculation',action:'data.evaluate',input:{values:{total:{op:'add',args:[{op:'ref',source:'projection',stepId:'source',field:'amount'},{op:'literal',value:{type:'decimal',value:'0.20'}}]}}}},
 {id:'check',action:'data.assert',input:{condition:{op:'eq',args:[{op:'ref',source:'evaluation',stepId:'calculation',field:'total'},{op:'literal',value:{type:'decimal',value:'99999999999999999999.30'}}]}}}
]}]};
await call('/v1/workflow-drafts',{definition},201);await call('/v1/workflow-drafts/'+definitionId+'/publish',{expectedRevision:1});const run=await call('/v1/workflows',{definitionId,title:'Signed private calculation',input:{entityId:entity.id}},201);const done=await call('/v1/workflows/'+run.id+'/transitions',{action:'run',expectedVersion:1,input:{}});assert.equal(done.state,'done');const executions=await call('/v1/workflows/'+run.id+'/executions');assert.equal(executions.items.length,3);assert.ok(!JSON.stringify(executions).includes('99999999999999999999'));
console.log('Private workflow signed execution passed: published projection/calculation/assert chain and metadata-only evidence.');
