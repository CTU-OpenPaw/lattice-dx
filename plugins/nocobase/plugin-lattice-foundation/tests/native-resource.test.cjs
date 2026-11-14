/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {registerNativeResource} = require('../src/server/native-resource');
function setup(rows) {
  let resource;
  const grants=[];
  const names=[];
  const app={db:{getRepository:()=>({find:async({filter})=>rows.filter(r=>String(r.userId)===String(filter.userId))})},
    resourceManager:{define:r=>{names.push(r.name);if(r.name==='latticeNative')resource=r;}},acl:{allow:(...args)=>grants.push(args)}};
  registerNativeResource(app);
  return {run:resource.actions.context,grants,names};
}
function context(user,method='GET') {return {method,state:{currentUser:user},action:{params:{values:{organizationId:'org-b'}}},throw(status){throw Object.assign(new Error('HTTP error'),{status});}};}
test('native context returns own mapping and grants no business collection permission',async()=>{
  const {run,grants}=setup([{id:8,userId:12,name:'Employee',active:true,organizationId:'org-a',departmentId:3}]);
  const ctx=context({id:12});let called=false;
  await run(ctx,async()=>{called=true;});
  assert.deepEqual(ctx.body,{userId:'12',employeeId:8,organizationId:'org-a',departmentId:3});
  assert.equal(called,true);
  assert.deepEqual(grants,[['latticeNative','context','loggedIn']]);
});

test('native extension does not register a second document workflow API',()=>{
  assert.deepEqual(setup([]).names,['latticeNative']);
});
test('native context refuses unauthenticated, unmapped, disabled and write requests',async()=>{
  const {run}=setup([{id:8,userId:12,active:false,organizationId:'org-a'}]);
  await assert.rejects(run(context(null),async()=>{}),{status:401});
  await assert.rejects(run(context({id:13}),async()=>{}),{status:403});
  await assert.rejects(run(context({id:12}),async()=>{}),{status:403});
  await assert.rejects(run(context({id:12},'POST'),async()=>{}),{status:405});
});
