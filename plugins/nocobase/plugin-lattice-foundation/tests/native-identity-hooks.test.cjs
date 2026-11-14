/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {test}=require('node:test');const assert=require('node:assert/strict');
test('server identity is applied in host validation hooks after user-field ACL sanitization',()=>{
  const {applyNativeIdentity}=require('../src/server/native-identity-hooks');
  const values={},model={isNewRecord:true,set:(key,value)=>{values[key]=value;}};
  const options={fields:['name'],context:{state:{latticeNativeActor:{organizationId:'org-a',employeeId:8}}}};
  applyNativeIdentity(model,options);
  assert.deepEqual(values,{organizationId:'org-a',requesterId:8,status:'draft',version:1});assert.ok(options.fields.includes('organizationId'));
  const untouched={isNewRecord:true,set:()=>assert.fail('background native workflow has no HTTP actor')};applyNativeIdentity(untouched,{});
});
