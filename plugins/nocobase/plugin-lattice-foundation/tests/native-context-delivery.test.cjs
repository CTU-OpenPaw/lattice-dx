/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {test}=require('node:test');const assert=require('node:assert/strict');
const {brokerConfig,deliverSnapshot,dispatchOne,registerContextResource}=require('../src/server/native-context-delivery');
const {projectContext}=require('../src/server/native-context');
const payload=projectContext('latticeAssets',{id:1,organizationId:'org-a',name:'Asset',status:'ready',updatedAt:'2026-11-05T00:00:00Z'},'event-1');
const event={entityId:payload.id,organizationId:'org-a',collectionName:'latticeAssets',payload};
test('broker URL comes from deployment and rejects credentials, query and paths',()=>{
 assert.equal(brokerConfig({}),null);assert.equal(brokerConfig({DX_NATIVE_CONTEXT_BROKER_URL:'http://orion-ld:1026'}),'http://orion-ld:1026');
 for(const url of ['file:///etc','http://user:pass@localhost','http://localhost/path','http://localhost/?token=x'])assert.throws(()=>brokerConfig({DX_NATIVE_CONTEXT_BROKER_URL:url}));
});
test('merge upsert uses trusted tenant, owns only its fields and removes cleared relationships',async()=>{
 const calls=[];
 await deliverSnapshot('http://broker',event,async(url,options)=>{calls.push({url,options});return new Response(null,{status:204});});
 assert.equal(calls.length,3);assert.equal(calls[0].options.headers['NGSILD-Tenant'],'org-a');
 assert.deepEqual(JSON.parse(calls[0].options.body),[payload]);assert.match(calls[0].url,/options=update$/);
 assert.equal(calls[1].options.method,'DELETE');assert.ok(calls[1].url.includes(encodeURIComponent('https://latticedx.example/ns/department')));
 assert.equal(calls[0].options.redirect,'error');assert.ok(calls[0].options.signal);
});
test('HTTP errors and partial batch responses are not acknowledged as delivery',async()=>{
 for(const status of [400,429,500,207])await assert.rejects(()=>deliverSnapshot('http://broker',event,async()=>new Response(null,{status})),new RegExp('BROKER_HTTP_'+status));
});
test('disabled sender leaves queued data untouched',async()=>{assert.deepEqual(await dispatchOne({sequelize:{transaction:()=>assert.fail()}},null),{state:'disabled'});});
test('ordered claim uses private table metadata and SKIP LOCKED; network failure retains retry',async()=>{
 let query,updated;const row={toJSON:()=>({...event,eventId:'test',attempts:0}),update:async v=>{updated=v;}};
 const db={getModel:()=>({getTableName:()=>({tableName:'private_outbox'}),findByPk:async()=>row}),sequelize:{getQueryInterface:()=>({queryGenerator:{quoteTable:()=> '"private_outbox"'}}),query:async sql=>{query=sql;return [[{id:1}]];},transaction:async fn=>fn({id:'tx'})}};
 const result=await dispatchOne(db,'http://broker',{fetchImpl:async()=>{throw Error('private upstream detail');}});
 assert.equal(result.state,'retry');assert.equal(result.errorCode,'BROKER_UNAVAILABLE');assert.equal(updated.attempts,1);assert.ok(updated.nextAttemptAt>Date.now());assert.match(query,/NOT EXISTS/);assert.match(query,/SKIP LOCKED/);assert.match(query,/older.state<>'delivered'/);
 assert.equal(JSON.stringify(result).includes('private upstream detail'),false);
});
test('all sync management routes require verified native root role',async()=>{
 let actions,guard;registerContextResource({resourceManager:{define:r=>{actions=r.actions;},use:fn=>{guard=fn;}},acl:{allow:()=>{}}});
 const ctx={state:{currentUser:{id:1},currentRole:'ldx_manager'},throw(status){assert.equal(status,403);throw Error('denied');}};
 for(const fn of Object.values(actions))await assert.rejects(()=>fn(ctx),/denied/);
 await assert.rejects(()=>guard({...ctx,action:{resourceName:'latticeContextOutbox'}},()=>assert.fail()),/denied/);
});
