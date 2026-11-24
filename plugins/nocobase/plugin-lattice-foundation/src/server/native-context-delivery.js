/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {retryDelay}=require('./native-context');
const {canUsePgRlsSession,withSystemRlsBypass,withTenantRlsContext}=require('./pg-rls');
function brokerConfig(env){
 if(!env.DX_NATIVE_CONTEXT_BROKER_URL)return null;
 const url=new URL(env.DX_NATIVE_CONTEXT_BROKER_URL);
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('Invalid native context broker deployment URL');
 return url.origin;
}
function brokerError(code){const e=new Error(code);e.deliveryCode=code;return e;}
async function deliverSnapshot(base,event,fetchImpl=fetch){
 const signal=AbortSignal.timeout(7000);
 const headers={'Content-Type':'application/ld+json','NGSILD-Tenant':event.organizationId};
 const response=await fetchImpl(base+'/ngsi-ld/v1/entityOperations/upsert?options=update',{
  method:'POST',redirect:'error',signal,headers,body:JSON.stringify([event.payload]),
 });
 await response.body?.cancel();
 if(![201,204].includes(response.status))throw brokerError('BROKER_HTTP_'+response.status);
 // Merge preserves other writers' telemetry. Explicitly remove absent owned
 // relationships, otherwise moving an asset to no location would leave stale context.
 const owned=event.collectionName==='latticeAssets'?['belongsToDepartment','locatedAt']:event.collectionName==='latticeLocations'?['belongsToDepartment']:[];
 for(const field of owned){
  if(event.payload[field])continue;
  const iri=event.payload['@context'][field];
  const r=await fetchImpl(base+'/ngsi-ld/v1/entities/'+encodeURIComponent(event.entityId)+'/attrs/'+encodeURIComponent(iri),{method:'DELETE',redirect:'error',signal,headers:{'NGSILD-Tenant':event.organizationId}});
  await r.body?.cancel();if(![204,404].includes(r.status))throw brokerError('BROKER_HTTP_'+r.status);
 }
}
const DEFAULT_BATCH_SIZE=10;
const DEFAULT_MAX_ATTEMPTS=Math.max(1,Number(process.env.DX_OUTBOX_MAX_ATTEMPTS)||5);
const DEFAULT_STALE_LOCK_MS=Math.max(10000,Number(process.env.DX_OUTBOX_STALE_LOCK_MS)||120000);

async function claimOutboxBatch(db,{batchSize=DEFAULT_BATCH_SIZE,eventId,staleLockMs=DEFAULT_STALE_LOCK_MS,reclaimStale=true}={}){
 const size=Math.max(1,Math.min(100,Number(batchSize)||DEFAULT_BATCH_SIZE));
 const model=db.getModel('latticeContextOutbox');
 const table=db.sequelize.getQueryInterface().queryGenerator.quoteTable(model.getTableName());
 // Run stale-lock reclaim outside the claim transaction so a non-fatal reclaim error
 // never poisons the Postgres transaction with 25P02 aborted state.
 if(reclaimStale&&staleLockMs>0){
  try{
   const cutoff=new Date(Date.now()-staleLockMs);
   const reclaimSql=`UPDATE ${table} SET state='retry',"lockedAt"=NULL,"nextAttemptAt"=NOW() WHERE state='processing' AND "lockedAt" IS NOT NULL AND "lockedAt" < :cutoff`;
   if(canUsePgRlsSession(db)){
    await withSystemRlsBypass(db,(transaction)=>db.sequelize.query(reclaimSql,{transaction,replacements:{cutoff}}));
   }else{
    await db.sequelize.query(reclaimSql,{replacements:{cutoff}});
   }
  }catch{}
 }
 const runClaim=async(transaction)=>{
  // Failed (dead-lettered) rows do NOT block newer events for the same entityId;
  // only in-flight states ('pending','retry','processing') serialize per entity.
  const [rows]=await db.sequelize.query(
   `SELECT o.id FROM ${table} o WHERE o.state IN ('pending','retry') ${eventId?'AND o."eventId" = :eventId':''} AND (o."nextAttemptAt" IS NULL OR o."nextAttemptAt" <= NOW()) AND NOT EXISTS (SELECT 1 FROM ${table} older WHERE older."entityId"=o."entityId" AND older.id<o.id AND older.state IN ('pending','retry','processing')) ORDER BY o.id LIMIT :batchSize FOR UPDATE OF o SKIP LOCKED`,
   {transaction,replacements:{...(eventId?{eventId}:{}),batchSize:size}},
  );
  if(!rows.length)return [];
  const claimed=[];
  for(const ref of rows){
   const row=await model.findByPk(ref.id,{transaction});
   if(!row)continue;
   const event=typeof row.toJSON==='function'?row.toJSON():{...row};
   await row.update({state:'processing',lockedAt:new Date()},{transaction});
   claimed.push({id:ref.id,row,event});
  }
  return claimed;
 };
 return canUsePgRlsSession(db)?withSystemRlsBypass(db,runClaim):db.sequelize.transaction(runClaim);
}

async function dispatchBatch(db,base,{fetchImpl=fetch,eventId,batchSize=DEFAULT_BATCH_SIZE,maxAttempts=DEFAULT_MAX_ATTEMPTS,staleLockMs=DEFAULT_STALE_LOCK_MS}={}){
 if(!base)return [{state:'disabled'}];
 const claimed=await claimOutboxBatch(db,{batchSize,eventId,staleLockMs});
 if(!claimed.length)return [];
 const deliveries=await Promise.all(claimed.map(async item=>{
  try{
   await deliverSnapshot(base,item.event,fetchImpl);
   return {item,ok:true};
  }catch(error){
   const errorCode=/^BROKER_HTTP_\d{3}$/.test(error?.deliveryCode??'')?error.deliveryCode:'BROKER_UNAVAILABLE';
   return {item,ok:false,errorCode};
  }
 }));
 const runCommit=async(transaction)=>{
  const model=db.getModel('latticeContextOutbox');
  const out=[];
  for(const res of deliveries){
   const {event}=res.item;
   const row=(await model.findByPk(res.item.id,{transaction}))||res.item.row;
   const attempts=(Number(event.attempts)||0)+1;
   if(res.ok){
    await row.update({state:'delivered',attempts,deliveredAt:new Date(),nextAttemptAt:null,lockedAt:null,errorCode:null},{transaction});
    out.push({state:'delivered',eventId:event.eventId,entityId:event.entityId});
   }else{
    const state=attempts>=maxAttempts?'failed':'retry';
    await row.update({state,attempts,errorCode:res.errorCode,lockedAt:null,nextAttemptAt:state==='failed'?null:new Date(Date.now()+retryDelay(attempts,{jitterRatio:0.25}))},{transaction});
    out.push({state,eventId:event.eventId,errorCode:res.errorCode});
   }
  }
  return out;
 };
 return canUsePgRlsSession(db)?withSystemRlsBypass(db,runCommit):db.sequelize.transaction(runCommit);
}

async function dispatchOne(db,base,{fetchImpl=fetch,eventId,maxAttempts=DEFAULT_MAX_ATTEMPTS}={}){
 if(!base)return {state:'disabled'};
 const results=await dispatchBatch(db,base,{fetchImpl,eventId,batchSize:1,maxAttempts});
 return results[0]||{state:'idle'};
}

async function replayDeadLetters(db,{organizationId,eventIds,limit=100}={}){
 const model=db.getModel?.('latticeContextOutbox');
 if(!model)return {replayedCount:0,eventIds:[]};
 const where={state:'failed'};
 if(organizationId)where.organizationId=String(organizationId);
 if(Array.isArray(eventIds)&&eventIds.length)where.eventId=eventIds.map(String);
 const runReplay=async(transaction)=>{
  const txOpt=transaction?{transaction}:{};
  const rows=(await model.findAll({where,limit:Math.max(1,Math.min(500,Number(limit)||100)),...txOpt}))||[];
  const replayedIds=[];
  for(const row of rows){
   const eid=typeof row.get==='function'?row.get('eventId'):row.eventId;
   const patch={state:'pending',attempts:0,errorCode:null,nextAttemptAt:null,lockedAt:null};
   await (transaction?row.update(patch,{transaction}):row.update(patch));
   if(eid)replayedIds.push(eid);
  }
  return {replayedCount:replayedIds.length,eventIds:replayedIds};
 };
 if(canUsePgRlsSession(db)){
  return organizationId
   ?withTenantRlsContext(db,String(organizationId),runReplay)
   :withSystemRlsBypass(db,runReplay);
 }
 return runReplay(undefined);
}
function registerContextResource(app){
 const root=ctx=>{if(ctx.state.currentRole!=='root'||!ctx.state.currentUser)ctx.throw(403,'Native context operations require root.');};
 // Generic collection APIs must not expose cross-organization queue payloads
 // even to a custom non-root role with broad global collection permissions.
 app.resourceManager.use(async(ctx,next)=>{
  if(ctx.action.resourceName?.split('.')[0]==='latticeContextOutbox')root(ctx);
  return next();
 },{tag:'latticePrivateContextJournal',after:'acl'});
 app.resourceManager.define({name:'latticeContextSync',actions:{
  dispatch:async ctx=>{
   root(ctx);if(ctx.method!=='POST')ctx.throw(405);
   const eventId=ctx.action.params.values?.eventId;
   if(eventId!==undefined&&!/^native-[a-f0-9]{64}$/.test(eventId))ctx.throw(400,'Invalid context event ID');
   ctx.body=await dispatchOne(app.db,brokerConfig(process.env),{eventId});
  },
  status:async ctx=>{
   root(ctx);if(ctx.method!=='GET')ctx.throw(405);
   const params=ctx.action.params;
   const page=Math.max(1,Math.min(100000,Number(params.page)||1)),pageSize=Math.max(1,Math.min(100,Number(params.pageSize)||20));
   const repo=app.db.getRepository('latticeContextOutbox');
   const filter={...(params.eventId?{eventId:String(params.eventId)}:{}),...(params.state?{state:String(params.state)}:{})};
   const rows=await repo.find({filter,fields:['id','eventId','entityId','organizationId','collectionName','recordId','state','attempts','nextAttemptAt','deliveredAt','errorCode'],offset:(page-1)*pageSize,limit:pageSize,sort:['-id']});
   ctx.body={items:rows,page,pageSize,total:await repo.count({filter}),enabled:!!brokerConfig(process.env)};
  },
  retry:async ctx=>{
   root(ctx);if(ctx.method!=='POST')ctx.throw(405);
   const eventId=ctx.action.params.values?.eventId;if(!/^native-[a-f0-9]{64}$/.test(eventId??''))ctx.throw(400,'Invalid context event ID');
   const result=await app.db.getRepository('latticeContextOutbox').update({filter:{eventId,state:{$in:['retry','failed']}},values:{state:'pending',attempts:0,nextAttemptAt:new Date(),errorCode:null}});
   ctx.body={reset:Array.isArray(result)?result.length:0};
  },
 }});
 app.acl.allow('latticeContextSync',['dispatch','status','retry'],'loggedIn');
 if(process.env.DX_NATIVE_CONTEXT_AUTO_SYNC==='true'){
  const base=brokerConfig(process.env);if(!base)throw Error('Automatic native context delivery requires a broker URL');
  if(!app._latticeContextAutoSyncRegistered){
   app._latticeContextAutoSyncRegistered=true;
   app.cronJobManager.addJob({cronTime:'*/10 * * * * *',onTick:async()=>{
    try{await dispatchBatch(app.db,base,{batchSize:DEFAULT_BATCH_SIZE});}catch(err){app.logger.error('Native context delivery transaction failed; event remains queued.',{error:err?.message||String(err)});}
   }});
  }
 }
}
module.exports={brokerConfig,deliverSnapshot,claimOutboxBatch,dispatchBatch,dispatchOne,replayDeadLetters,registerContextResource};
