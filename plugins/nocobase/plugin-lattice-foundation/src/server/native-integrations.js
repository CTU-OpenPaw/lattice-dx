/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {resolveNativeActor}=require('./native-scope');
const {readNativeRecord,boundedJson}=require('./native-integration-reader');
const {failure,strict,envelope,recordInput,proposalInput,receiptKey,fingerprint}=require('./native-integration-policy');
const {brokerConfig}=require('./native-context-delivery');
const {entityUrn}=require('./native-context');
const JOURNALS=['latticeIntegrationInbox','latticeAgentProposals'];
const PROPOSE_SNIPPET='lattice.integrations.propose';
async function installProposalPermission(db){
 const repo=db.getRepository('roles');
 for(const name of ['ldx_employee','ldx_manager','ldx_warehouse','ldx_dispatcher','ldx_driver','ldx_admin']){
  const role=await repo.findOne({filter:{name}});if(!role)continue;
  const snippets=role.snippets??[];
  if(!snippets.includes(PROPOSE_SNIPPET))await repo.update({filterByTk:name,values:{snippets:[...snippets,PROPOSE_SNIPPET]}});
 }
}
async function installConnectorRole(db){
 const repo=db.getRepository('roles');
 if(!await repo.findOne({filter:{name:'ldx_connector'}}))await repo.create({values:{name:'ldx_connector',title:'Lattice — Integration connector',allowConfigure:false,allowNewMenu:false,allowNewAiEmployee:false,strategy:{actions:[]},snippets:[],resources:[{name:'latticeAssets',dataSourceKey:'main',usingActionsConfig:true,actions:[{name:'view',fields:['id','organizationId','name','status','updatedAt']}]}]}});
}
async function saveReceipt(ctx,collection,key,contentHash,values){
 return ctx.app.db.sequelize.transaction(async transaction=>{
  // Cross-process dedupe within the host transaction; repository.create (not
  // direct model.create) preserves native collection workflow event semantics.
  await ctx.app.db.sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:key,0))',{replacements:{key:collection+':'+key},transaction});
  const current=await resolveNativeActor(ctx.app.db,ctx.state.currentUser,{transaction});
  if(current.organizationId!==values.organizationId||String(current.employeeId)!==String(values.sourceEmployeeId)||String(current.userId)!==String(values.sourceUserId))throw failure('INTEGRATION_MEMBERSHIP_CHANGED',403);
  const repo=ctx.app.db.getRepository(collection);
  const existing=await repo.findOne({filter:{receiptKey:key},transaction});
  if(existing){if(existing.contentHash!==contentHash)throw failure('INTEGRATION_EVENT_CONFLICT',409);return {id:existing.id,duplicate:true};}
  const row=await repo.create({values:{...values,receiptKey:key,contentHash},transaction,context:ctx});
  return {id:row.id,duplicate:false};
 });
}
async function readContext(ctx,input){
 const target=recordInput(input);if(target.collection!=='latticeAssets')throw failure('INTEGRATION_CONTEXT_ASSET_REQUIRED');
 const visible=await readNativeRecord(ctx,target),base=brokerConfig(process.env);if(!base)throw failure('INTEGRATION_BROKER_UNAVAILABLE',503);
 const id=entityUrn('Asset',visible.actor.organizationId,target.recordId);
 let response;
 try{response=await fetch(base+'/ngsi-ld/v1/entities/'+encodeURIComponent(id),{redirect:'error',headers:{Accept:'application/ld+json','NGSILD-Tenant':visible.actor.organizationId},signal:AbortSignal.timeout(5000)});}catch{throw failure('INTEGRATION_BROKER_UNAVAILABLE',503);}
 if(!response.ok){await response.body?.cancel();throw failure(response.status===404?'INTEGRATION_CONTEXT_NOT_FOUND':'INTEGRATION_BROKER_UNAVAILABLE',response.status===404?404:503);}
 const entity=await boundedJson(response,65536);
 const attr=k=>entity['https://latticedx.example/ns/'+k]??entity[k];
 if(entity.id!==id||attr('organizationId')?.value!==visible.actor.organizationId||attr('source')?.value!=='nocobase-native')throw failure('INTEGRATION_CONTEXT_IDENTITY_MISMATCH',409);
 const context={id,source:'nocobase-native'};
 // Domain fields honor their native field visibility. Telemetry is a separate
 // explicitly bounded context capability granted by Asset view access.
 for(const key of ['name','status','temperature','humidity','batteryLevel','speed']){
  if(['name','status'].includes(key)&&!Object.hasOwn(visible.record,key))continue;
  const value=attr(key);if(!value||value.type!=='Property')continue;
  const telemetry=!['name','status'].includes(key);
  if(telemetry?(typeof value.value!=='number'||!Number.isFinite(value.value)):(typeof value.value!=='string'||value.value.length>255))continue;
  const time=Date.parse(value.observedAt),validTime=Number.isFinite(time);
  context[key]={value:value.value,...(validTime?{observedAt:new Date(time).toISOString()}:{}),...(telemetry?{stale:!validTime||time<Date.now()-300000||time>Date.now()+60000}:{})};
 }
 return {collection:target.collection,recordId:target.recordId,context,fingerprint:fingerprint(context)};
}
function createIntegrationActions(){return {
 receive:async ctx=>{
  if(ctx.method!=='POST')ctx.throw(405);
  if(ctx.state.currentRole!=='ldx_connector')throw failure('INTEGRATION_CONNECTOR_ROLE_REQUIRED',403);
  const actor=await resolveNativeActor(ctx.app.db,ctx.state.currentUser);
  const input=envelope(ctx.action.params.values);
  if(input.kind==='observation')await readNativeRecord(ctx,{collection:'latticeAssets',recordId:input.data.assetId});
  const {late,...stable}=input;
  const result=await saveReceipt(ctx,'latticeIntegrationInbox',receiptKey(actor.organizationId,actor.userId,input.eventId),fingerprint(stable),{
   eventId:input.eventId,organizationId:actor.organizationId,sourceUserId:actor.userId,sourceEmployeeId:actor.employeeId,kind:input.kind,observedAt:input.observedAt,late,data:input.data,
  });
  ctx.body={...result,accepted:true};
 },
 record:async ctx=>{
  if(ctx.method!=='POST')ctx.throw(405);
  const visible=await readNativeRecord(ctx,ctx.action.params.values);
  ctx.body={collection:visible.collection,recordId:visible.recordId,record:visible.record,fingerprint:visible.fingerprint};
 },
 context:async ctx=>{if(ctx.method!=='POST')ctx.throw(405);ctx.body=await readContext(ctx,ctx.action.params.values);},
 propose:async ctx=>{
  if(ctx.method!=='POST')ctx.throw(405);
  const input=proposalInput(ctx.action.params.values),visible=await readNativeRecord(ctx,{collection:input.collection,recordId:input.recordId});
  if(visible.fingerprint!==input.fingerprint)throw failure('INTEGRATION_EVIDENCE_STALE',409);
  const evidence=[{kind:'native-record',collection:input.collection,recordId:visible.recordId,fingerprint:visible.fingerprint}];
  if(input.contextFingerprint){const context=await readContext(ctx,{collection:input.collection,recordId:input.recordId});if(context.fingerprint!==input.contextFingerprint)throw failure('INTEGRATION_CONTEXT_EVIDENCE_STALE',409);evidence.push({kind:'ngsi-ld',entityId:context.context.id,fingerprint:context.fingerprint});}
  const result=await saveReceipt(ctx,'latticeAgentProposals',receiptKey(visible.actor.organizationId,visible.actor.userId,input.eventId),fingerprint(input),{
   eventId:input.eventId,organizationId:visible.actor.organizationId,sourceUserId:visible.actor.userId,sourceEmployeeId:visible.actor.employeeId,
   targetCollection:input.collection,targetRecordId:visible.recordId,recordFingerprint:visible.fingerprint,recommendation:input.text,evidence,state:'proposed',
  });
  ctx.body={...result,state:'proposed',requiresHumanApproval:true};
 },
 proposals:async ctx=>{
  if(ctx.method!=='POST')ctx.throw(405);
  const input=ctx.action.params.values;strict(input,['collection','recordId','page','pageSize']);
  const page=input.page??1,pageSize=input.pageSize??20;
  if(!Number.isInteger(page)||page<1||page>100000||!Number.isInteger(pageSize)||pageSize<1||pageSize>100)throw failure('INTEGRATION_INVALID_PAGE');
  const visible=await readNativeRecord(ctx,{collection:input.collection,recordId:input.recordId});
  const filter={organizationId:visible.actor.organizationId,targetCollection:visible.collection,targetRecordId:visible.recordId},repo=ctx.app.db.getRepository('latticeAgentProposals');
  const rows=await repo.find({filter,offset:(page-1)*pageSize,limit:pageSize,sort:['-id']});
  let currentContext;
  if(rows.some(row=>row.evidence?.some(e=>e.kind==='ngsi-ld'))){try{currentContext=await readContext(ctx,{collection:visible.collection,recordId:visible.recordId});}catch{currentContext=null;}}
  ctx.body={items:rows.map(row=>{
   const brokerEvidence=row.evidence?.find(e=>e.kind==='ngsi-ld');
   const stale=row.recordFingerprint!==visible.fingerprint||(!!brokerEvidence&&brokerEvidence.fingerprint!==currentContext?.fingerprint);
   return {id:row.id,state:row.state,stale,...(!stale?{recommendation:row.recommendation,evidence:row.evidence}:{})};
  }),page,pageSize,total:await repo.count({filter})};
 },
};}
function registerNativeIntegrations(app){
 app.resourceManager.define({name:'latticeIntegrations',actions:createIntegrationActions()});
 app.acl.registerSnippet({name:PROPOSE_SNIPPET,actions:['latticeIntegrations:propose']});
 app.acl.allow('latticeIntegrations',['receive','record','context','proposals'],'loggedIn');
 app.resourceManager.use(async(ctx,next)=>{
  if(JOURNALS.includes(ctx.action.resourceName?.split('.')[0])&&ctx.state.currentRole!=='root')throw failure('INTEGRATION_JOURNAL_PRIVATE',403);
  return next();
 },{tag:'latticePrivateIntegrationJournals',after:'acl'});
}
module.exports={installConnectorRole,installProposalPermission,saveReceipt,readContext,createIntegrationActions,registerNativeIntegrations};
