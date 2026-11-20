/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {retryDelay}=require('./native-context');
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
async function dispatchOne(db,base,{fetchImpl=fetch,eventId}={}){
 if(!base)return {state:'disabled'};
 return db.sequelize.transaction(async transaction=>{
  const model=db.getModel('latticeContextOutbox');
  const table=db.sequelize.getQueryInterface().queryGenerator.quoteTable(model.getTableName());
  // Older undelivered events (including rows locked by another sender) block
  // their entity. Other entities may progress via SKIP LOCKED.
  const [rows]=await db.sequelize.query(`SELECT o.id FROM ${table} o WHERE o.state IN ('pending','retry') ${eventId?'AND o."eventId"=:eventId':''} AND (o."nextAttemptAt" IS NULL OR o."nextAttemptAt" <= NOW()) AND NOT EXISTS (SELECT 1 FROM ${table} older WHERE older."entityId"=o."entityId" AND older.id<o.id AND older.state<>'delivered') ORDER BY o.id LIMIT 1 FOR UPDATE OF o SKIP LOCKED`,{transaction,replacements:eventId?{eventId}:undefined});
  if(!rows.length)return {state:'idle'};
  const row=await model.findByPk(rows[0].id,{transaction});
  const event=row.toJSON(),attempts=event.attempts+1;
  try{
   await deliverSnapshot(base,event,fetchImpl);
   await row.update({state:'delivered',attempts,deliveredAt:new Date(),nextAttemptAt:null,errorCode:null},{transaction});
   return {state:'delivered',eventId:event.eventId,entityId:event.entityId};
  }catch(error){
   const errorCode=/^BROKER_HTTP_\d{3}$/.test(error.deliveryCode??'')?error.deliveryCode:'BROKER_UNAVAILABLE';
   const state=attempts>=8?'failed':'retry';
   await row.update({state,attempts,errorCode,nextAttemptAt:state==='failed'?null:new Date(Date.now()+retryDelay(attempts))},{transaction});
   return {state,eventId:event.eventId,errorCode};
  }
 });
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
  app.cronJobManager.addJob({cronTime:'*/10 * * * * *',onTick:async()=>{
   try{await dispatchOne(app.db,base);}catch{app.logger.error('Native context delivery transaction failed; event remains queued.');}
  }});
 }
}
module.exports={brokerConfig,deliverSnapshot,dispatchOne,registerContextResource};
