/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {test}=require('node:test');const assert=require('node:assert/strict');
const {projectContext,entityUrn,enqueueContext,registerContextHooks,retryDelay}=require('../src/server/native-context');
const row={id:12,organizationId:'org-a',name:'Scanner',status:'available',active:true,departmentId:3,locationId:4,updatedAt:'2026-11-05T01:00:00.000Z',email:'never-share',identitySubject:'secret',description:'private'};
test('context IDs are deterministic, namespaced away from legacy, and validate identity',()=>{
 assert.equal(entityUrn('Asset','org-a',12),'urn:ngsi-ld:Asset:org-a:native:12');
 for(const args of [['Other','org-a',12],['Asset','../bad',12],['Asset','org-a',0]])assert.throws(()=>entityUrn(...args));
});
test('projection includes only owned context fields and deterministic relation URNs',()=>{
 const p=projectContext('latticeAssets',row,'event-1');assert.equal(p.id,entityUrn('Asset','org-a',12));
 assert.equal(p.belongsToDepartment.object,entityUrn('Department','org-a',3));assert.equal(p.locatedAt.object,entityUrn('Location','org-a',4));
 assert.equal(p.status.observedAt,row.updatedAt);assert.equal(p.sourceEventId.value,'event-1');
 assert.equal(p.email,undefined);assert.equal(p.description,undefined);assert.equal(p.identitySubject,undefined);
 assert.throws(()=>projectContext('latticeEmployees',row,'event-1'));
 const removed=projectContext('latticeAssets',{...row,departmentId:null,locationId:null},'event-2');assert.equal(removed.belongsToDepartment,undefined);
});
test('enqueue is part of host transaction and never performs broker IO',async()=>{
 const calls=[],tx={id:'tx'},db={getRepository:()=>({findOne:async()=>row,create:async o=>{calls.push(o);return o.values;}})};
 await assert.rejects(()=>enqueueContext(db,'latticeAssets',row,{}),/transaction/);
 await enqueueContext(db,'latticeAssets',row,{transaction:tx});assert.equal(calls.length,1);assert.equal(calls[0].transaction,tx);assert.equal(calls[0].values.state,'pending');
 assert.equal(calls[0].values.organizationId,'org-a');assert.equal(calls[0].values.payload.id,entityUrn('Asset','org-a',12));
});
test('snapshot is reread after save under the host transaction, not stale in-memory fields',async()=>{
 const calls=[],tx={},db={getRepository:name=>({findOne:async options=>{assert.equal(options.transaction,tx);return {...row,name:'Committed concurrent name'};},create:async options=>calls.push(options)})};
 await enqueueContext(db,'latticeAssets',{...row,name:'Stale name'},{transaction:tx});
 assert.equal(calls[0].values.payload.name.value,'Committed concurrent name');
});
test('only selected native source collections register transaction hooks',()=>{
 const hooks=[];registerContextHooks({on:(name,fn)=>hooks.push(name)});
 for(const source of ['latticeDepartments','latticeLocations','latticeAssets'])for(const hook of ['beforeUpdate','afterSave','afterSaveWithAssociations','afterDestroy','beforeBulkUpdate','afterBulkUpdate'])assert.ok(hooks.includes(source+'.'+hook));
 assert.equal(hooks.length,18);
});
test('published native context identity cannot be moved between organization namespaces',()=>{
 const hooks=new Map();registerContextHooks({on:(name,fn)=>hooks.set(name,fn)});
 assert.throws(()=>hooks.get('latticeAssets.beforeUpdate')({changed:()=>true,previous:()=> 'org-a',get:()=> 'org-b'}),/ORGANIZATION_IMMUTABLE/);
 assert.doesNotThrow(()=>hooks.get('latticeAssets.beforeUpdate')({changed:()=>false}));
});
test('retry delay grows and is bounded',()=>{assert.equal(retryDelay(1),1000);assert.equal(retryDelay(2),2000);assert.equal(retryDelay(30),300000);});
