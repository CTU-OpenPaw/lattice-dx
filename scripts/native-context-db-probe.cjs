// SPDX-License-Identifier: Apache-2.0
// Invoked only inside the local NocoBase container by the acceptance runner.
const assert=require('node:assert/strict');
const {createRequire}=require('node:module');
const req=createRequire('/app/nocobase/package.json');
const {Database}=req('@nocobase/database');
const foundation='/app/nocobase/node_modules/@latticedx/plugin-lattice-foundation/dist/server/';
const {registerContextHooks}=require(foundation+'native-context');
const {dispatchOne,deliverSnapshot}=require(foundation+'native-context-delivery');
const db=new Database({dialect:'postgres',host:'nocobase-db',port:5432,database:'nocobase',username:'nocobase',password:'local-nocobase-password',logging:false});
const schemas=require(foundation+'schema');
db.collection({name:'users',fields:[]});
for(const schema of Object.values(schemas))db.collection(schema);
db.collection(require(foundation+'collections/context-outbox'));
registerContextHooks(db);
const [mode,arg]=process.argv.slice(2);
async function main(){
 await db.sequelize.authenticate();
 const outbox=db.getRepository('latticeContextOutbox');
 if(mode==='rollback'){
  const code='ctx_rollback_'+Date.now(),org='context-rollback-test';
  await assert.rejects(()=>db.sequelize.transaction(async transaction=>{
   const asset=await db.getRepository('latticeAssets').create({values:{code,name:'Rollback asset',organizationId:org,status:'ready'},transaction});
   assert.equal(await outbox.count({filter:{organizationId:org,recordId:asset.id},transaction}),1);
   throw Error('Expected rollback');
  }),/Expected rollback/);
  assert.equal(await db.getRepository('latticeAssets').count({filter:{code}}),0);
  assert.equal(await outbox.count({filter:{organizationId:org}}),0);
  console.log(JSON.stringify({result:'PASS',check:'native_repository_and_outbox_rollback_together'}));
 }else if(mode==='concurrent'){
  assert.match(arg,/^context-accept-[a-f0-9]{12}$/);
  const repo=db.getRepository('latticeAssets'),asset=await repo.findOne({filter:{organizationId:arg}});assert.ok(asset);
  const a=await db.getModel('latticeAssets').findByPk(asset.id),b=await db.getModel('latticeAssets').findByPk(asset.id);
  // Deliberately load B before A commits, reproducing the host's stale instance path.
  await db.sequelize.transaction(transaction=>a.update({name:'Concurrent committed name'},{transaction}));
  await db.sequelize.transaction(transaction=>b.update({status:'concurrent-status'},{transaction}));
  const newest=await outbox.findOne({filter:{organizationId:arg,recordId:asset.id,collectionName:'latticeAssets'},sort:['-id']});
  assert.equal(newest.payload.name.value,'Concurrent committed name');assert.equal(newest.payload.status.value,'concurrent-status');
  console.log(JSON.stringify({result:'PASS',check:'stale_model_disjoint_update_snapshot_is_current'}));
 }else if(mode==='association'){
  assert.match(arg,/^context-accept-[a-f0-9]{12}$/);
  const repo=db.getRepository('latticeAssets'),asset=await repo.findOne({filter:{organizationId:arg}});
  const location=await db.getRepository('latticeLocations').findOne({filter:{organizationId:arg}});
  assert.ok(asset&&location);
  await db.getRepository('latticeAssets.location',asset.id).set(location.id);
  let newest=await outbox.findOne({filter:{organizationId:arg,recordId:asset.id,collectionName:'latticeAssets'},sort:['-id']});
  assert.ok(newest.payload.locatedAt.object.endsWith(':'+location.id));
  await db.getRepository('latticeAssets.location',asset.id).remove();
  newest=await outbox.findOne({filter:{organizationId:arg,recordId:asset.id,collectionName:'latticeAssets'},sort:['-id']});assert.equal(newest.payload.locatedAt,undefined);
  await db.getRepository('latticeDepartments.assets',asset.departmentId).remove(asset.id);
  newest=await outbox.findOne({filter:{organizationId:arg,recordId:asset.id,collectionName:'latticeAssets'},sort:['-id']});assert.equal(newest.payload.belongsToDepartment,undefined);
  console.log(JSON.stringify({result:'PASS',check:'native_single_and_bulk_association_changes_enqueue'}));
 }else if(mode==='unavailable'){
  assert.match(arg,/^native-[a-f0-9]{64}$/);
  const result=await dispatchOne(db,'http://127.0.0.1:1',{eventId:arg});assert.equal(result.state,'retry');
  const row=await outbox.findOne({filter:{eventId:arg}});assert.equal(row.attempts,1);assert.equal(row.errorCode,'BROKER_UNAVAILABLE');
  assert.ok(await db.getRepository(row.collectionName).findOne({filterByTk:row.recordId}));
  console.log(JSON.stringify({result:'PASS',check:'broker_unavailable_keeps_committed_source_and_retry'}));
 }else if(mode==='duplicate'){
  const row=await outbox.findOne({filter:{eventId:arg}});assert.ok(row);assert.equal(row.state,'delivered');
  await deliverSnapshot('http://orion-ld:1026',row.toJSON());
  console.log(JSON.stringify({result:'PASS',check:'duplicate_snapshot_resend_safe'}));
 }else if(mode==='cleanup'){
  assert.match(arg,/^context-accept-[a-f0-9]{12}$/);
  // Only this disposable acceptance tenant's rows; user records are untouched.
  await db.sequelize.transaction(async transaction=>{
   for(const name of ['latticeAssets','latticeLocations','latticeDepartments'])await db.getRepository(name).destroy({filter:{organizationId:arg},transaction,hooks:false});
   await outbox.destroy({filter:{organizationId:arg},transaction});
  });
  console.log(JSON.stringify({result:'PASS',check:'disposable_native_context_fixtures_cleaned'}));
 }else throw Error('Unsupported native context probe');
}
main().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>db.close());
