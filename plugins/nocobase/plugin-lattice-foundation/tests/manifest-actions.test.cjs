// SPDX-License-Identifier: Apache-2.0
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {runInNewContext} = require('node:vm');
const {validateManifest, validateCatalog} = require('../src/shared/manifest');
const {createFormActions} = require('../src/client/actions');
const purchasing = require('../src/shared/manifests/purchasing.json');
const logistics = require('../src/shared/manifests/logistics.json');
test('samples validate; duplicate routes and unsupported API mappings fail', () => {
  assert.deepEqual(validateCatalog([purchasing, logistics]), []);
  assert.ok(validateCatalog([purchasing, purchasing]).some(e => e.includes('duplicate application route')));
  const invalid = structuredClone(purchasing);
  invalid.blocks[0].fields.push({name: 'organizationId', title: 'Đơn vị', type: 'string', required: false, maxLength: 80});
  assert.ok(validateManifest(invalid).some(e => e.includes('API does not accept organizationId')));
  invalid.blocks[0].collection = 'missing';
  assert.ok(validateManifest(invalid).some(e => e.includes('unknown reference')));
  invalid.blocks[0].fields = null;
  assert.doesNotThrow(() => validateManifest(invalid));
  invalid.transitions[0].availability = 'available';
  assert.ok(validateManifest(invalid).some(e => e.includes('not implemented')));
});
function setup(manifest = purchasing, blockId = 'create-request', run = async () => ({data: {actionId: 'records.create', version: 1, status: 'succeeded', result: {id: 'record-1'}}})) {
  const calls = [];
  const apiClient = {async request(request) {
    calls.push(request);
    if (request.url === 'dxActions:catalog') return {data: {items: [{id: 'records.create', version: 1}, {id: 'tasks.create', version: 1}]}};
    return run(request);
  }};
  return {calls, controller: createFormActions({apiClient, manifest, blockId})};
}
test('save calls authenticated bridge catalog/run without arbitrary scope fields', async () => {
  const {controller, calls} = setup();
  assert.deepEqual(await controller.submit({title: '  Mua máy tính  '}), {id: 'record-1'});
  const {key,...payload}=calls[1].data;
  assert.match(key,/^ui-[0-9a-f-]{36}$/);
  assert.deepEqual(payload, {actionId: 'records.create', version: 1, input: {title: 'Mua máy tính'}});
  await assert.rejects(controller.submit({title: 'x', organizationId: 'other'}), {code: 'VALIDATION'});
  assert.equal(calls.length, 2);
});
test('generic task controller preserves actual assignee subject and record UUID', async () => {
  const taskManifest=structuredClone(logistics);
  delete taskManifest.workspace;
  taskManifest.blocks=[{id:'assign-warehouse-task',type:'form',title:'Giao việc',collection:'warehouse-tasks',permissions:['tasks:assign'],fields:[{name:'title',title:'Nội dung',type:'string',required:true,maxLength:200},{name:'assigneeId',title:'Subject',type:'string',required:true,maxLength:100},{name:'recordId',title:'Hồ sơ',type:'string',required:false,maxLength:36,pattern:'uuid',reference:'records'}],submit:{actionId:'tasks.create',version:1}}];
  const {controller, calls} = setup(taskManifest, 'assign-warehouse-task', async () => ({data: {actionId: 'tasks.create', version: 1, status: 'succeeded', result: {id: 'task-1'}}}));
  const input = {title: 'Chuẩn bị hàng', assigneeId: 'keycloak-subject', recordId: '11111111-1111-4111-8111-111111111111'};
  await controller.submit(input);
  assert.deepEqual(calls[1].data.input, input);
  await assert.rejects(controller.submit({...input, recordId: 'display-name'}), {code: 'VALIDATION'});
});
test('401/403/timeout errors propagate with no automatic retry', async () => {
  for (const status of [401, 403, undefined]) {
    const {controller, calls} = setup(purchasing, 'create-request', async () => {throw {response: {status}};});
    await assert.rejects(controller.submit({title: 'x'}), {code: status === 401 ? 'AUTH_REQUIRED' : status === 403 ? 'FORBIDDEN' : 'API_FAILED'});
    assert.equal(calls.length, 2);
    assert.equal(controller.pending, false);
  }
});
test('uncertain catalog writes retry the same key/body and new submissions get a new key', async () => {
  let attempt=0;
  const {controller,calls}=setup(purchasing,'create-request',async()=>{
    if(++attempt===1)throw {response:{status:502}};
    return {data:{actionId:'records.create',version:1,status:'succeeded',result:{id:'record-1'}}};
  });
  await assert.rejects(controller.submit({title:'Original'}));
  assert.equal(controller.uncertain,true);
  await assert.rejects(controller.submit({title:'Changed'}),{code:'BUSY'});
  assert.equal((await controller.retry()).id,'record-1');
  const writes=calls.filter(call=>call.url==='dxActions:run');
  assert.deepEqual(writes[0].data,writes[1].data);
  assert.equal(controller.uncertain,false);
  await controller.submit({title:'New request'});
  assert.notEqual(calls.at(-1).data.key,writes[0].data.key);
});
test('double click is blocked, unavailable transition never issues a write', async () => {
  let finish;
  const {controller, calls} = setup(purchasing, 'create-request', () => new Promise(resolve => {finish = resolve;}));
  const first = controller.submit({title: 'x'});
  await assert.rejects(controller.submit({title: 'x'}), {code: 'BUSY'});
  await assert.rejects(controller.transition('submit-request'), {code: 'TRANSITION_UNAVAILABLE'});
  finish({data: {actionId: 'records.create', version: 1, status: 'succeeded', result: {id: 'record-1'}}});
  await first;
  assert.equal(calls.length, 2);
});
test('missing catalog permission blocks writes and mismatched success is rejected', async () => {
  const controller = createFormActions({manifest: purchasing, blockId: 'create-request', apiClient: {request: async () => ({data: {items: []}})}});
  await assert.rejects(controller.submit({title: 'x'}), {code: 'ACTION_UNAVAILABLE'});
  const {controller: wrong} = setup(purchasing, 'create-request', async () => ({data: {actionId: 'tasks.create', version: 1, status: 'succeeded', result: {id: 'wrong'}}}));
  await assert.rejects(wrong.submit({title: 'x'}), {code: 'INVALID_RESPONSE'});
});
test('built browser entrypoints load through AMD without CommonJS require or missing dependencies', async () => {
  for (const entry of ['client', 'client-v2']) {
    let module;
    const define = (name, deps, factory) => {
      assert.equal(name, '@latticedx/plugin-lattice-foundation' + (entry === 'client-v2' ? '/client-v2' : ''));
      assert.deepEqual(Array.from(deps), entry==='client'?['@nocobase/client', 'react','antd','@nocobase/client-v2']:['@nocobase/client', 'react']);
      module = factory({Plugin: class {}}, {}, {}, {BlockModel:class {static define(metadata){this.metadata=metadata} static registerFlow(flow){this.flow=flow}}});
    };
    define.amd = {};
    runInNewContext(readFileSync(require.resolve(`../dist/${entry}/index.js`), 'utf8'), {define,sessionStorage:{getItem:()=>null},window:{location:{pathname:'/lattice'}}});
    assert.equal(typeof module.createFormActions, 'function');
    assert.equal(typeof module.createWorkspaceApi, 'function');
    const plugin = new module.default();
    let models;
    plugin.flowEngine={registerModels:value=>{models=value}};
    const scopes = {};
    const routes=[];
    plugin.app = {addScopes: value => Object.assign(scopes, value),router:{add:(name,route)=>routes.push(route)},addComponents:()=>{},use:()=>{},schemaInitializerManager:{get:()=>({add:()=>{}})}};
    await plugin.load();
    if (entry === 'client') assert.equal(typeof scopes.useLatticeFormAction, 'function');
    if (entry === 'client') assert.deepEqual(routes.map(r=>r.path), ['/lattice','/lattice/apps/:applicationId']);
    if (entry === 'client') {
      assert.deepEqual(Object.keys(models),['LatticeFormBlockModel','LatticeListBlockModel','LatticeTaskInboxBlockModel','LatticeApprovalBlockModel']);
      const fields=await models.LatticeFormBlockModel.flow.steps.binding.uiSchema({api:{request:async()=>({data:{data:{items:[purchasing,logistics]}}})}});
      assert.equal(fields.binding.enum.length,3);
      let binding;
      models.LatticeFormBlockModel.flow.steps.binding.handler({model:{setProps:props=>{binding=props}}},{binding:'logistics:create-order-record'});
      assert.equal(binding.manifestId,'logistics');assert.equal(binding.blockId,'create-order-record');
    }
  }
});
