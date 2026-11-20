/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {createHash}=require('node:crypto');
const TYPES={latticeDepartments:'Department',latticeLocations:'Location',latticeAssets:'Asset'};
const NS='https://latticedx.example/ns/';
const CONTEXT={Asset:NS+'Asset',Department:NS+'Department',Location:NS+'Location',name:NS+'name',businessId:NS+'businessId',organizationId:NS+'organizationId',status:NS+'status',active:NS+'active',source:NS+'source',sourceEventId:NS+'sourceEventId',belongsToDepartment:NS+'department',locatedAt:NS+'locatedAt'};
function entityUrn(type,org,id){
 if(!Object.values(TYPES).includes(type)||!/^[-a-zA-Z0-9_]{1,80}$/.test(org)||!/^[1-9]\d*$/.test(String(id)))throw Error('Invalid native context identity');
 return `urn:ngsi-ld:${type}:${org}:native:${id}`;
}
function projectContext(collection,row,eventId){
 const type=TYPES[collection];if(!type)throw Error('Unsupported context collection');
 const observedAt=new Date(row.updatedAt).toISOString();
 const property=value=>({type:'Property',value,observedAt});
 const entity={id:entityUrn(type,row.organizationId,row.id),type,'@context':CONTEXT,
  businessId:property(String(row.id)),organizationId:property(row.organizationId),name:property(row.name),
  active:property(row.active!==false),source:property('nocobase-native'),sourceEventId:property(eventId)};
 if(type==='Asset')entity.status=property(row.status??'unknown');
 if(row.departmentId!=null)entity.belongsToDepartment={type:'Relationship',object:entityUrn('Department',row.organizationId,row.departmentId),observedAt};
 if(type==='Asset'&&row.locationId!=null)entity.locatedAt={type:'Relationship',object:entityUrn('Location',row.organizationId,row.locationId),observedAt};
 return entity;
}
async function enqueueContext(db,collection,model,options={}){
 if(!options.transaction)throw Error('Native context requires the host write transaction');
 let row=model.toJSON?model.toJSON():model;
 if(!options.contextDeleted){
  // Repository.update may have fetched this model before a concurrent writer
  // committed different fields. After save, our transaction owns the row lock;
  // reread persisted values to avoid publishing stale untouched attributes.
  const persisted=await db.getRepository(collection).findOne({filterByTk:row.id,transaction:options.transaction});
  if(!persisted)throw Error('Native context source disappeared inside its transaction');
  row=persisted.toJSON?persisted.toJSON():persisted;
 }
 const projection=projectContext(collection,row,'pending');
 const eventId='native-'+createHash('sha256').update(JSON.stringify(projection)).digest('hex');
 const payload={...projection,sourceEventId:{...projection.sourceEventId,value:eventId}};
 const values={eventId,entityId:payload.id,organizationId:row.organizationId,collectionName:collection,recordId:row.id,payload,state:'pending',attempts:0,nextAttemptAt:new Date()};
 // Native Sequelize findOrCreate uses a savepoint inside the host transaction,
 // including unique-conflict handling; duplicate hook delivery is harmless.
 if(db.getModel)return db.getModel('latticeContextOutbox').findOrCreate({where:{eventId},defaults:values,transaction:options.transaction});
 return db.getRepository('latticeContextOutbox').create({values,transaction:options.transaction});
}
function registerContextHooks(db){
 const affectedIds=Symbol('nativeContextAffectedIds');
 const immutableOrganization=()=>{const e=new Error('NATIVE_CONTEXT_ORGANIZATION_IMMUTABLE');e.status=409;throw e;};
 for(const collection of Object.keys(TYPES)){
  db.on(collection+'.beforeUpdate',model=>{
   if(model.changed('organizationId')&&model.previous('organizationId')!==model.get('organizationId'))immutableOrganization();
  });
  // Native association setters may use model.save or a bulk FK update rather
  // than Repository.update. Observe both host paths; event hashes dedupe the
  // normal repository afterSaveWithAssociations notification.
  db.on(collection+'.afterSave',(model,options)=>enqueueContext(db,collection,model,options));
  db.on(collection+'.afterSaveWithAssociations',(model,options)=>enqueueContext(db,collection,model,options));
  db.on(collection+'.afterDestroy',(model,options)=>enqueueContext(db,collection,{...(model.toJSON?model.toJSON():model),active:false},{...options,contextDeleted:true}));
  db.on(collection+'.beforeBulkUpdate',async options=>{
   if(!options.transaction)throw Error('Native context requires the host write transaction');
   const rows=await db.getModel(collection).findAll({where:options.where,attributes:['id','organizationId'],transaction:options.transaction,lock:options.transaction.LOCK.UPDATE,order:[['id','ASC']]});
   if(options.attributes?.organizationId!==undefined&&rows.some(row=>row.organizationId!==options.attributes.organizationId))immutableOrganization();
   options[affectedIds]=rows.map(row=>row.id);
  });
  db.on(collection+'.afterBulkUpdate',async options=>{
   for(const id of options[affectedIds]??[])await enqueueContext(db,collection,{id},options);
  });
 }
}
function retryDelay(attempt){return Math.min(300000,1000*2**Math.min(20,Math.max(0,attempt-1)));}
module.exports={TYPES,CONTEXT,entityUrn,projectContext,enqueueContext,registerContextHooks,retryDelay};
