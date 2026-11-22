/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {test}=require('node:test');const assert=require('node:assert/strict');
const {brokerConfig,deliverSnapshot,dispatchOne,dispatchBatch,replayDeadLetters,registerContextResource}=require('../src/server/native-context-delivery');
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
 assert.equal(result.state,'retry');assert.equal(result.errorCode,'BROKER_UNAVAILABLE');assert.equal(updated.attempts,1);assert.ok(updated.nextAttemptAt>Date.now());assert.match(query,/NOT EXISTS/);assert.match(query,/SKIP LOCKED/);assert.match(query,/older\.state IN \('pending','retry','processing'\)/);
 assert.equal(JSON.stringify(result).includes('private upstream detail'),false);
});
test('dispatchBatch claims with SKIP LOCKED, executes HTTP completely outside DB transactions, and dead-letters at max attempts without blocking failed peers',async()=>{
 const txLog=[];
 const rowsById={
  1:{id:1,...event,eventId:'evt-ok',attempts:0,state:'pending',update:async function(v){Object.assign(this,v);}},
  2:{id:2,...event,entityId:'urn:ngsi-ld:Asset:other',payload:{...event.payload,id:'urn:ngsi-ld:Asset:other'},eventId:'evt-dlq',attempts:4,state:'retry',update:async function(v){Object.assign(this,v);}},
 };
 let inTx=false,sawClaimSql='',callCount=0;
 const db={
  getModel:()=>({
   getTableName:()=>({tableName:'private_outbox'}),
   findByPk:async id=>rowsById[id]||null,
   findAll:async()=>Object.values(rowsById),
  }),
  sequelize:{
   getQueryInterface:()=>({queryGenerator:{quoteTable:()=>'"private_outbox"'}}),
   transaction:async fn=>{
    inTx=true;
    txLog.push('begin');
    try{return await fn({id:'tx-'+txLog.length});}
    finally{inTx=false;txLog.push('end');}
   },
   query:async(sql)=>{
    if(sql.includes('SKIP LOCKED')){
     sawClaimSql=sql;
     return [[{id:1},{id:2}]];
    }
    return [[]];
   },
  },
 };
 const results=await dispatchBatch(db,'http://broker',{
  batchSize:5,
  fetchImpl:async(url,opts)=>{
   assert.equal(inTx,false,'Remote Orion-LD HTTP must run outside Postgres transaction locks');
   callCount+=1;
   if(typeof opts.body==='string'&&opts.body.includes('urn:ngsi-ld:Asset:other')){
    throw new Error('simulated timeout');
   }
   return new Response(null,{status:204});
  },
 });
 assert.equal(results.length,2);
 assert.equal(rowsById[1].state,'delivered');
 assert.equal(rowsById[2].state,'failed');
 assert.equal(rowsById[2].attempts,5);
 assert.ok(callCount>=4);
 assert.match(sawClaimSql,/LIMIT :batchSize FOR UPDATE OF o SKIP LOCKED/);
 assert.match(sawClaimSql,/older\.state IN \('pending','retry','processing'\)/);
});
test('replayDeadLetters resets failed rows in org scope back to pending cleanly',async()=>{
 const store=[
  {id:10,eventId:'e-10',organizationId:'org-a',state:'failed',attempts:5,errorCode:'BROKER_HTTP_500',nextAttemptAt:new Date(),lockedAt:new Date(),update:async function(v){Object.assign(this,v);}},
  {id:11,eventId:'e-11',organizationId:'org-b',state:'failed',attempts:5,errorCode:'BROKER_HTTP_500',update:async function(v){Object.assign(this,v);}},
 ];
 const db={
  getModel:()=>({
   findAll:async({where})=>store.filter(r=>r.state===where.state&&(!where.organizationId||r.organizationId===where.organizationId)&&(!where.eventId||where.eventId.includes(r.eventId))),
  }),
 };
 const replayed=await replayDeadLetters(db,{organizationId:'org-a',eventIds:['e-10']});
 assert.equal(replayed.replayedCount,1);
 assert.equal(store[0].state,'pending');
 assert.equal(store[0].attempts,0);
 assert.equal(store[0].errorCode,null);
 assert.equal(store[0].nextAttemptAt,null);
 assert.equal(store[0].lockedAt,null);
 assert.equal(store[1].state,'failed');
});
test('all sync management routes require verified native root role',async()=>{
 let actions,guard;registerContextResource({resourceManager:{define:r=>{actions=r.actions;},use:fn=>{guard=fn;}},acl:{allow:()=>{}}});
 const ctx={state:{currentUser:{id:1},currentRole:'ldx_manager'},throw(status){assert.equal(status,403);throw Error('denied');}};
 for(const fn of Object.values(actions))await assert.rejects(()=>fn(ctx),/denied/);
 await assert.rejects(()=>guard({...ctx,action:{resourceName:'latticeContextOutbox'}},()=>assert.fail()),/denied/);
});
test('claimOutboxBatch separates stale reclaim from claim transaction with spaces around :cutoff and registerContextResource is idempotent',async()=>{
 const {claimOutboxBatch}=require('../src/server/native-context-delivery');
 const queries=[];
 let inTx=false;
 const row={toJSON:()=>({...event,eventId:'evt-reclaim',attempts:0}),update:async()=>{}};
 const db={
  getModel:()=>({getTableName:()=>({tableName:'latticeContextOutbox'}),findByPk:async()=>row}),
  sequelize:{
   getQueryInterface:()=>({queryGenerator:{quoteTable:()=>'"latticeContextOutbox"'}}),
   transaction:async fn=>{inTx=true;try{return await fn({id:'tx-reclaim'});}finally{inTx=false;}},
   query:async(sql,opts={})=>{
    queries.push({sql,inTx,hasTransaction:Boolean(opts.transaction)});
    if(sql.startsWith('UPDATE ')){
     assert.match(sql,/"lockedAt" < :cutoff/);
     assert.equal(inTx,false);
     assert.equal(Boolean(opts.transaction),false);
     throw new Error('simulated transient reclaim failure');
    }
    return [[{id:7}]];
   },
  },
 };
 const claimed=await claimOutboxBatch(db,{batchSize:5});
 assert.equal(claimed.length,1);
 assert.equal(queries.length,2);
 assert.match(queries[1].sql,/FOR UPDATE OF o SKIP LOCKED/);
 assert.equal(queries[1].inTx,true);

 const prevAuto=process.env.DX_NATIVE_CONTEXT_AUTO_SYNC;
 const prevBroker=process.env.DX_NATIVE_CONTEXT_BROKER_URL;
 try{
  process.env.DX_NATIVE_CONTEXT_AUTO_SYNC='true';
  process.env.DX_NATIVE_CONTEXT_BROKER_URL='http://orion-ld:1026';
  const jobs=[];
  const app={
   resourceManager:{define:()=>{},use:()=>{}},
   acl:{allow:()=>{}},
   cronJobManager:{addJob:job=>jobs.push(job)},
   logger:{error:()=>{}},
   db,
  };
  registerContextResource(app);
  registerContextResource(app);
  assert.equal(jobs.length,1);
 }finally{
  if(prevAuto===undefined)delete process.env.DX_NATIVE_CONTEXT_AUTO_SYNC;else process.env.DX_NATIVE_CONTEXT_AUTO_SYNC=prevAuto;
  if(prevBroker===undefined)delete process.env.DX_NATIVE_CONTEXT_BROKER_URL;else process.env.DX_NATIVE_CONTEXT_BROKER_URL=prevBroker;
 }
});
