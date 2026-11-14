/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
const base='http://localhost:13000/api/',broker='http://localhost:1026',org='context-accept-'+randomBytes(6).toString('hex'),checks=[],entities=[];
function probe(mode,arg){
 const r=spawnSync('docker',['exec','lattice-dx-nocobase-1','node','/tmp/native-context-db-probe.cjs',mode,...(arg?[arg]:[])],{encoding:'utf8',timeout:20000,windowsHide:true});
 if(r.status!==0)throw Error('Native DB probe '+mode+' failed: '+r.stderr.slice(-1200));
 return JSON.parse(r.stdout.trim().split('\n').at(-1));
}
const copied=spawnSync('docker',['cp','scripts/native-context-db-probe.cjs','lattice-dx-nocobase-1:/tmp/native-context-db-probe.cjs'],{encoding:'utf8',windowsHide:true,timeout:10000});assert.equal(copied.status,0);
async function call(path,{method='GET',values,token}={}){
 const r=await fetch(base+path,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},...(values?{body:JSON.stringify(values)}:{}),signal:AbortSignal.timeout(15000)});
 const body=await r.json();return {status:r.status,data:body.data,error:body.errors?.[0]?.message};
}
async function ok(path,options){const r=await call(path,options);assert.ok(r.status<300,path+' HTTP '+r.status+': '+(r.error??''));return r.data;}
const readyDeadline=Date.now()+45000;
while(true){
 try{const ready=await fetch(base+'app:getLang',{signal:AbortSignal.timeout(2000)});if(ready.ok)break;}catch{}
 if(Date.now()>=readyDeadline)throw Error('Native runtime is not ready; retry acceptance after startup.');
 await new Promise(r=>setTimeout(r,500));
}
const {token}=await ok('auth:signIn',{method:'POST',values:{email:'admin@nocobase.com',password:'admin123'}});
const create=async(name,values)=>ok(name+':create',{method:'POST',token,values:{...values,organizationId:org}});
async function events(recordId,collection){
 const page=await ok('latticeContextSync:status?pageSize=100',{token});
 return page.items.filter(e=>e.organizationId===org&&String(e.recordId)===String(recordId)&&e.collectionName===collection).sort((a,b)=>Number(a.id)-Number(b.id));
}
async function dispatch(eventId){return ok('latticeContextSync:dispatch',{method:'POST',token,values:{eventId}});}
async function getEntity(id){const r=await fetch(broker+'/ngsi-ld/v1/entities/'+encodeURIComponent(id),{headers:{'NGSILD-Tenant':org,Accept:'application/ld+json'},signal:AbortSignal.timeout(10000)});assert.equal(r.status,200);return r.json();}
const attr=(e,k)=>e['https://latticedx.example/ns/'+k]??e[k];
const auto=process.argv.includes('--auto');
try{
 if(auto){
  const asset=await create('latticeAssets',{code:org+'-AUTO',name:'Automatic delivery acceptance',status:'ready'});
  const [queued]=await events(asset.id,'latticeAssets');assert.ok(queued);entities.push(queued.entityId);
  const deadline=Date.now()+30000;
  let latest;
  do{
   [latest]=await events(asset.id,'latticeAssets');if(latest?.state==='delivered')break;
   await new Promise(r=>setTimeout(r,500));
  }while(Date.now()<deadline);
  assert.equal(latest?.state,'delivered','Native cron did not deliver before deadline');
  const projected=await getEntity(queued.entityId);assert.equal(attr(projected,'status').value,'ready');
  checks.push('native_cron_automatically_delivers_without_dispatch_call','automatic_entity_has_native_record_identity');
 }else{
 assert.equal(probe('rollback').result,'PASS');checks.push('native_repository_outbox_atomic_rollback');
 const dept=await create('latticeDepartments',{code:org+'-D',name:'Acceptance department'});
 const loc=await create('latticeLocations',{code:org+'-L',name:'Acceptance warehouse',departmentId:dept.id});
 const asset=await create('latticeAssets',{code:org+'-A',name:'Acceptance scanner',departmentId:dept.id,locationId:loc.id,status:'available'});
 for(const [collection,row] of [['latticeDepartments',dept],['latticeLocations',loc],['latticeAssets',asset]]){
  const queue=await events(row.id,collection);assert.equal(queue.length,1);assert.equal(queue[0].state,'pending');entities.push(queue[0].entityId);
 }
 checks.push('native_http_writes_enqueue_one_snapshot_each');
 const [first]=await events(asset.id,'latticeAssets');
 assert.equal((await call('latticeAssets:update?filterByTk='+asset.id,{method:'POST',token,values:{organizationId:org+'-moved'}})).status,409);checks.push('native_context_organization_identity_is_immutable');
 assert.equal(probe('unavailable',first.eventId).result,'PASS');checks.push('broker_failure_keeps_source_and_retry');
 await ok('latticeContextSync:retry',{method:'POST',token,values:{eventId:first.eventId}});
 for(const [collection,row] of [['latticeDepartments',dept],['latticeLocations',loc]])assert.equal((await dispatch((await events(row.id,collection))[0].eventId)).state,'delivered');
 const concurrent=await Promise.all([dispatch(first.eventId),dispatch(first.eventId)]);assert.equal(concurrent.filter(r=>r.state==='delivered').length,1);assert.equal(concurrent.filter(r=>r.state==='idle').length,1);checks.push('concurrent_dispatch_claims_once');
 const actual=await getEntity(first.entityId);assert.equal(attr(actual,'status').value,'available');assert.equal(attr(actual,'department').object,entities[0]);assert.equal(attr(actual,'locatedAt').object,entities[1]);checks.push('real_orion_entity_and_relationships');
 assert.equal(probe('duplicate',first.eventId).result,'PASS');assert.equal(attr(await getEntity(first.entityId),'sourceEventId').value,first.eventId);checks.push('duplicate_delivery_idempotent');
 await ok('latticeAssets:update?filterByTk='+asset.id,{method:'POST',token,values:{status:'maintenance'}});
 await ok('latticeAssets:update?filterByTk='+asset.id,{method:'POST',token,values:{status:'in_use',departmentId:null,locationId:null}});
 const queue=await events(asset.id,'latticeAssets');assert.equal(queue.length,3);
 assert.equal((await dispatch(queue[2].eventId)).state,'idle');checks.push('newer_event_cannot_overtake_predecessor');
 assert.equal((await dispatch(queue[1].eventId)).state,'delivered');assert.equal((await dispatch(queue[2].eventId)).state,'delivered');
 const final=await getEntity(first.entityId);assert.equal(attr(final,'status').value,'in_use');assert.equal(attr(final,'department'),undefined);assert.equal(attr(final,'locatedAt'),undefined);checks.push('latest_snapshot_and_cleared_relationships');
 const employee=await ok('auth:signIn',{method:'POST',values:{email:'native.lab.employee@example.invalid',password:'NativeLab-2026!'}});
 for(const action of ['dispatch','retry','status']){
  const denied=await call('latticeContextSync:'+action,{token:employee.token,...(action!=='status'?{method:'POST',values:{eventId:first.eventId}}:{})});assert.equal(denied.status,403);
 }checks.push('non_root_sync_operations_denied');
 assert.equal((await call('latticeContextOutbox:list',{token:employee.token})).status,403);checks.push('private_outbox_not_readable_by_employee');
 assert.equal(probe('concurrent',org).result,'PASS');checks.push('stale_native_model_does_not_publish_old_fields');
 // Restore department through scalar native API, then test both association paths.
 await ok('latticeAssets:update?filterByTk='+asset.id,{method:'POST',token,values:{departmentId:dept.id}});
 assert.equal(probe('association',org).result,'PASS');checks.push('native_association_set_remove_and_bulk_fk_enqueue');
 for(const e of await events(asset.id,'latticeAssets'))if(e.state!=='delivered')assert.ok(['delivered','idle'].includes((await dispatch(e.eventId)).state));
 await ok('latticeAssets:destroy?filterByTk='+asset.id,{method:'POST',token});
 const tombstones=await events(asset.id,'latticeAssets');assert.ok(tombstones.length>=4);assert.equal((await dispatch(tombstones.at(-1).eventId)).state,'delivered');assert.equal(attr(await getEntity(first.entityId),'active').value,false);checks.push('native_delete_emits_inactive_tombstone');
 }
 await mkdir('output/native-platform',{recursive:true});await writeFile('output/native-platform/native-context'+(auto?'-auto':'')+'-acceptance.json',JSON.stringify({at:new Date().toISOString(),checks,scope:auto?'Real native HTTP create -> native CronJobManager -> PostgreSQL outbox -> real Orion without dispatch API call.':'Real native HTTP repositories/ACL + PostgreSQL rollback and ordered outbox + real Orion NGSI-LD. Broker failure injected via unreachable sender URL for one disposable event; no services stopped. No UI/workflow/AI/n8n integration claim.'},null,2));
 console.log(JSON.stringify({result:'PASS',checks}));
}finally{
 probe('cleanup',org);
 for(const id of entities){const r=await fetch(broker+'/ngsi-ld/v1/entities/'+encodeURIComponent(id),{method:'DELETE',headers:{'NGSILD-Tenant':org},signal:AbortSignal.timeout(10000)});assert.ok([204,404].includes(r.status),'Broker fixture cleanup failed');}
}
