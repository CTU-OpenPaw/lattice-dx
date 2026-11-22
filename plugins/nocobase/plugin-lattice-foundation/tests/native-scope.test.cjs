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

test('resource guard scopes dynamic latticeCustom* collections and rejects blind dotted/sensitive filters, SQL charts, and oversized pageSize', async () => {
  const employee = { id: 1, userId: 12, organizationId: 'org-a', departmentId: 3, active: true };
  const guard = api.createNativeScopeMiddleware(db([employee]), { assets: { name: 'latticeAssets', fields: [] } });
  const ctx = (resourceName, actionName, params = {}, currentRole = 'ldx_employee') => ({
    state: { currentUser: { id: 12 }, currentRole },
    action: { resourceName, actionName, params },
  });

  // Dynamic latticeCustom* collection list/create/update enforced by organizationId
  const customList = ctx('latticeCustomColdAudits', 'list', { filter: { organizationId: 'org-b' }, pageSize: 99999 });
  await guard(customList, async () => {});
  assert.deepEqual(customList.action.params.filter, { $and: [{ organizationId: 'org-a' }, { organizationId: 'org-b' }] });
  assert.equal(customList.action.params.pageSize, 200);

  const customCreate = ctx('latticeCustomColdAudits', 'create', { values: { code: 'CA-1' } });
  await guard(customCreate, async () => {});
  assert.equal(customCreate.action.params.values.organizationId, 'org-a');

  await assert.rejects(
    guard(ctx('latticeCustomColdAudits', 'create', { values: { organizationId: 'org-b', code: 'CA-2' } }), async () => {}),
    { code: 'NATIVE_ORGANIZATION_MISMATCH' },
  );

  // Blind filter oracle via dotted traversal or sensitive keys rejected recursively
  for (const badFilter of [
    { 'user.password': { $startsWith: '$2b$' } },
    { $or: [{ 'requester.identitySubject': 'sub-x' }] },
    { $and: [{ status: 'draft' }, { 'department.organizationId': 'org-b' }] },
    { identitySubject: 'sub-x' },
    { $where: '1=1' },
  ]) {
    await assert.rejects(
      guard(ctx('latticeAssets', 'list', { filter: badFilter }), async () => {}),
      { code: 'NATIVE_RELATION_EXPANSION_UNSUPPORTED' },
    );
  }

  // Dotted sort rejected
  await assert.rejects(
    guard(ctx('latticeAssets', 'list', { sort: ['-user.email'] }), async () => {}),
    { code: 'NATIVE_RELATION_EXPANSION_UNSUPPORTED' },
  );

  // charts:queryData rejects SQL mode, private collections, and dotted filters; scopes latticeCustom*
  await assert.rejects(
    guard(ctx('charts', 'queryData', { values: { mode: 'sql', sql: 'SELECT * FROM users' } }), async () => {}),
    { code: 'NATIVE_CHART_MODE_UNSUPPORTED' },
  );
  await assert.rejects(
    guard(ctx('charts', 'queryData', { values: { mode: 'builder', collection: 'users' } }), async () => {}),
    { code: 'NATIVE_CHART_COLLECTION_FORBIDDEN' },
  );
  await assert.rejects(
    guard(ctx('charts', 'queryData', { values: { mode: 'builder', collection: 'latticeAssets', filter: { 'user.password': { $ne: null } } } }), async () => {}),
    { code: 'NATIVE_RELATION_EXPANSION_UNSUPPORTED' },
  );
  const customChart = ctx('charts', 'queryData', { values: { mode: 'builder', collection: 'latticeCustomColdAudits', filter: {}, pageSize: 5000 } });
  await guard(customChart, async () => {});
  assert.deepEqual(customChart.action.params.values.filter, { $and: [{ organizationId: 'org-a' }, {}] });
  assert.equal(customChart.action.params.values.pageSize, 200);
});

test('updateScopedDocument enforces optimistic version locking and increments version cleanly', async () => {
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const actor = { organizationId: 'org-a', employeeId: 3 };
  let currentRow = { id: 5, organizationId: 'org-a', version: 2 };
  let capturedValues = null;
  const db = {
    sequelize: { transaction: (cb) => cb(transaction) },
    getModel: () => ({ findOne: async () => currentRow }),
    getRepository: () => ({
      update: async (opts) => {
        capturedValues = opts.values;
        return [{ id: 5, version: opts.values.version }];
      },
    }),
  };

  // Matching expectedVersion succeeds and increments version 2 -> 3
  const okCtx = {
    action: { resourceName: 'latticeRequests', params: { filterByTk: 5, values: { name: 'Updated', expectedVersion: 2 } } },
  };
  await api.updateScopedDocument(db, okCtx, actor);
  assert.equal(capturedValues.version, 3);
  assert.equal(capturedValues.expectedVersion, undefined);

  // Stale expectedVersion throws 409 VERSION_CONFLICT without writing
  capturedValues = null;
  const staleCtx = {
    action: { resourceName: 'latticeRequests', params: { filterByTk: 5, values: { name: 'Stale', expectedVersion: 1 } } },
  };
  await assert.rejects(api.updateScopedDocument(db, staleCtx, actor), { status: 409, code: 'VERSION_CONFLICT' });
  assert.equal(capturedValues, null);

  // If-Match header also supported; non-numeric fails 400 INVALID_EXPECTED_VERSION
  const hdrOkCtx = {
    get: (h) => (h === 'If-Match' ? 'W/"2"' : ''),
    action: { resourceName: 'latticeOrders', params: { filterByTk: 5, values: { name: 'Header OK' } } },
  };
  await api.updateScopedDocument(db, hdrOkCtx, actor);
  assert.equal(capturedValues.version, 3);

  const badCtx = {
    action: { resourceName: 'latticeRequests', params: { filterByTk: 5, values: { name: 'Bad', expectedVersion: 'oops' } } },
  };
  await assert.rejects(api.updateScopedDocument(db, badCtx, actor), { status: 400, code: 'INVALID_EXPECTED_VERSION' });
});
