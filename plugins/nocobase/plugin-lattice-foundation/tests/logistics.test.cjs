// SPDX-License-Identifier: Apache-2.0
const {test}=require('node:test');const assert=require('node:assert/strict');
const {createFormActions}=require('../src/client/actions');
const {validateManifest}=require('../src/shared/manifest');
const {createWorkspaceApi}=require('../src/client/workspace-api');
const manifest=require('../src/shared/manifests/logistics.json');
const input={title:'Order',customerName:'Customer',deliveryAddress:'Address',sku:'SKU-1',quantity:'2',warehouseAssigneeId:'actual-subject'};
test('order creation converts quantity, locks uncertain writes and replays the exact key/body',async()=>{
  const calls=[];const api={request:async options=>{assert.equal(options.url,'dxActions:logistics');calls.push(structuredClone(options.data));if(calls.length===1)throw {response:{status:502}};return {data:{id:'order-1',definitionId:'logistics_order'}};}};
  const form=createFormActions({apiClient:api,manifest,blockId:'create-order-record'});
  await assert.rejects(form.submit({...input,quantity:'1.5'}),{code:'VALIDATION'});assert.equal(calls.length,0);
  await assert.rejects(form.submit(input));assert.equal(form.pending,false);assert.ok(form.uncertain);
  await assert.rejects(form.submit({...input,title:'different'}),{code:'BUSY'});
  assert.equal((await form.retry()).id,'order-1');assert.deepEqual(calls[0],calls[1]);assert.equal(calls[0].body.quantity,2);assert.equal(form.uncertain,false);
});
test('orders reject missing directory/numeric schema safely and definitive authorization clears command',async()=>{
  const malformed=structuredClone(manifest);malformed.blocks[0].fields=null;assert.doesNotThrow(()=>validateManifest(malformed));assert.ok(validateManifest(malformed).length);
  const form=createFormActions({manifest,blockId:'create-order-record',apiClient:{request:async()=>{throw {response:{status:403}};}}});
  await assert.rejects(form.submit(input));assert.equal(form.uncertain,false);
});
test('paged lists preserve API pagination and block unsupported resources before requests',async()=>{
  const calls=[];const api=createWorkspaceApi({apiClient:{request:async options=>{calls.push(options);return {data:{items:[],page:{offset:10,limit:10,hasMore:true,nextOffset:20}}};}}});
  assert.equal((await api.listPage('orders',{limit:'10',offset:'10',q:'SKU'})).page.nextOffset,20);
  assert.equal(calls[0].url,'dxActions:logistics');assert.equal(calls[0].data.operation,'orders');
  await assert.rejects(api.listPage('../files',{}));assert.equal(calls.length,1);
});
