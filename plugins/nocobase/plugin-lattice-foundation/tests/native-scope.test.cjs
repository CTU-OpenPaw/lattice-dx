/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {test} = require('node:test');
const assert = require('node:assert/strict');
let api;
try { api = require('../src/server/native-scope'); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
const db = rows => ({getRepository(name) {assert.equal(name, 'latticeEmployees'); return {find: async ({filter}) => rows.filter(r => String(r.userId) === String(filter.userId)).map(r => ({get:k=>r[k]}))};}});

test('native scope uses verified user ID and refuses email/legacy-subject inference', async () => {
  assert.equal(typeof api?.resolveNativeActor, 'function');
  const rows = [{id:1,userId:12,organizationId:'org-a',departmentId:3,active:true}];
  assert.deepEqual(await api.resolveNativeActor(db(rows), {id:12}), {userId:'12',employeeId:1,organizationId:'org-a',departmentId:3});
  await assert.rejects(api.resolveNativeActor(db(rows), {id:13,email:'same@example.com'}), {code:'NATIVE_MEMBERSHIP_REQUIRED'});
  await assert.rejects(api.resolveNativeActor(db(rows), null), {status:401});
});

test('native scope fails closed for disabled or ambiguous employee mappings', async () => {
  assert.equal(typeof api?.resolveNativeActor, 'function');
  const row = {id:1,userId:12,organizationId:'org-a',active:true};
  await assert.rejects(api.resolveNativeActor(db([{...row,active:false}]), {id:12}), {code:'NATIVE_MEMBERSHIP_REQUIRED'});
  await assert.rejects(api.resolveNativeActor(db([row,{...row,id:2,organizationId:'org-b'}]), {id:12}), {code:'NATIVE_MEMBERSHIP_AMBIGUOUS'});
});

test('native filters cannot replace mandatory organization scoping', () => {
  assert.equal(typeof api?.scopeNativeRead, 'function');
  const query = {filter:{$or:[{organizationId:'org-b'},{}]},pageSize:10};
  const scoped = api.scopeNativeRead(query, {organizationId:'org-a'});
  assert.deepEqual(scoped.filter, {$and:[{organizationId:'org-a'},query.filter]});
  assert.equal(scoped.pageSize,10);
  assert.deepEqual(query.filter,{$or:[{organizationId:'org-b'},{}]});
});

test('native writes enforce organization and refuse identity and nested relation changes', () => {
  assert.equal(typeof api?.scopeNativeValues, 'function');
  const actor = {organizationId:'org-a'};
  assert.deepEqual(api.scopeNativeValues({name:'Asset'},actor),{name:'Asset',organizationId:'org-a'});
  for(const values of [{organizationId:'org-b'}, {id:7}, {userId:7}, {identitySubject:'other'}, {department:{id:8}}]) {
    assert.throws(()=>api.scopeNativeValues(values,actor),{status:403});
  }
});

test('resource guard scopes collection commands and blocks association and identity mutation', async () => {
  assert.equal(typeof api?.createNativeScopeMiddleware,'function');
  const guard = api.createNativeScopeMiddleware(db([{id:1,userId:12,organizationId:'org-a',departmentId:3,active:true}]),{assets:{name:'latticeAssets',fields:[]},employees:{name:'latticeEmployees',fields:[]}});
  const ctx = (resourceName,actionName,params={})=>({state:{currentUser:{id:12},currentRole:'member'},action:{resourceName,actionName,params}});
  const list=ctx('latticeAssets','list',{filter:{organizationId:'org-b'}});
  let ran=false;await guard(list,async()=>{ran=true;});assert.equal(ran,true);
  assert.deepEqual(list.action.params.filter,{$and:[{organizationId:'org-a'},{organizationId:'org-b'}]});
  await assert.rejects(guard(ctx('latticeAssets.custodian','set'),async()=>{}),{status:403});
  await assert.rejects(guard(ctx('latticeEmployees','update',{values:{active:true}}),async()=>{}),{status:403});
  await assert.rejects(guard(ctx('latticeAssets','update',{values:{organizationId:'org-b'}}),async()=>{}),{status:403});
  await assert.rejects(guard(ctx('latticeAssets','updateOrCreate'),async()=>{}),{status:403});
});

test('resource guard rejects cross-organization foreign keys and does not change legacy resources', async () => {
  const employee={id:1,userId:12,organizationId:'org-a',departmentId:3,active:true};
  const repositories={latticeEmployees:{find:async()=>[employee]},latticeDepartments:{findOne:async({filter})=>filter.id===3 && filter.organizationId==='org-a'?{id:3}:null}};
  const guard=api.createNativeScopeMiddleware({getRepository:n=>repositories[n]},{assets:{name:'latticeAssets',fields:[{name:'department',type:'belongsTo',foreignKey:'departmentId',target:'latticeDepartments'}]},departments:{name:'latticeDepartments',fields:[]}});
  const make=id=>({state:{currentUser:{id:12},currentRole:'member'},action:{resourceName:'latticeAssets',actionName:'create',params:{values:{name:'A',departmentId:id}}}});
  await guard(make(3),async()=>{});
  await assert.rejects(guard(make(4),async()=>{}),{code:'NATIVE_REFERENCE_UNAVAILABLE'});
  let passed=false;
  await guard({action:{resourceName:'dxActions',actionName:'run'},state:{}},async()=>{passed=true;});assert.equal(passed,true);
});

test('collection reads reject association expansion and target collection overrides', async () => {
  const guard=api.createNativeScopeMiddleware(db([{id:1,userId:12,organizationId:'org-a',active:true}]),{employees:{name:'latticeEmployees',fields:[]}});
  for(const params of [{appends:['user']},{fields:['id','user.email']},{targetCollection:'users'}]) {
    await assert.rejects(guard({state:{currentUser:{id:12},currentRole:'member'},action:{resourceName:'latticeEmployees',actionName:'list',params}},async()=>{}),{code:'NATIVE_RELATION_EXPANSION_UNSUPPORTED'});
  }
});

test('document edits preserve native ACL filters and lock the row through mutation',async()=>{
  assert.equal(typeof api.updateScopedDocument,'function');
  const transaction={LOCK:{UPDATE:'UPDATE'}},actor={organizationId:'org-a',employeeId:3};let found=true,saved=false;
  const db={sequelize:{transaction:callback=>callback(transaction)},getModel:()=>({findOne:async options=>{assert.equal(options.transaction,transaction);assert.equal(options.lock,'UPDATE');assert.deepEqual(options.where,{id:5,organizationId:'org-a'});return found?{id:5}:null;}}),getRepository:()=>({update:async options=>{assert.equal(options.transaction,transaction);assert.deepEqual(options.filter,{organizationId:'org-a'});saved=true;return [{id:5}];}})};
  const ctx={action:{resourceName:'latticeRequests',params:{filterByTk:5,filter:{organizationId:'org-a'},values:{name:'Edited'}}}};
  await api.updateScopedDocument(db,ctx,actor);assert.equal(saved,true);assert.equal(ctx.status,200);
  found=false;saved=false;await assert.rejects(api.updateScopedDocument(db,ctx,actor),{status:404});assert.equal(saved,false);
  ctx.action.params.filterByTk=undefined;await assert.rejects(api.updateScopedDocument(db,ctx,actor),{status:400});
});
