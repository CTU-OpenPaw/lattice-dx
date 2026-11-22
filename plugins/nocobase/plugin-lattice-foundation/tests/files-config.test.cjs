/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {test}=require('node:test');const assert=require('node:assert/strict');
const {validateManifest}=require('../src/shared/manifest');
const {createWorkspaceApi}=require('../src/client/workspace-api');
const purchasing=require('../src/shared/manifests/purchasing.json');
const logistics=require('../src/shared/manifests/logistics.json');
test('attachments only bind record creation and references cannot select arbitrary API paths',()=>{
  const a=structuredClone(purchasing);a.blocks[0].attachments='yes';assert.ok(validateManifest(a).length);
  const b=structuredClone(logistics);b.blocks.find(x=>x.type==='list').attachments=true;assert.ok(validateManifest(b).length);
  const c=structuredClone(logistics);c.blocks[0].fields.find(x=>x.name==='warehouseAssigneeId').reference='../files';assert.ok(validateManifest(c).length);
});
test('file operations use session bridge and a scan-aware timeout; never auto retry',async()=>{
  const calls=[];const api=createWorkspaceApi({apiClient:{request:async options=>{calls.push(options);return {data:{scanStatus:'clean'}}}}});
  assert.equal((await api.file('upload',{filename:'x',contentBase64:'YQ=='})).scanStatus,'clean');
  assert.equal(calls[0].url,'dxActions:files');assert.equal(calls[0].timeout,30000);assert.equal(calls[0].data.operation,'upload');
  await assert.rejects(api.file('arbitrary',{}));assert.equal(calls.length,1);
});
