/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {test}=require('node:test');const assert=require('node:assert/strict');
const {createWorkflowCommands}=require('../src/client/workflow');
test('workflow retry preserves key/body, blocks concurrent writes and clears definitive failures',async()=>{
  const calls=[];let failed=true;const controller=createWorkflowCommands({actorId:'alice',newKey:()=> 'fixed',api:{workflow:async(op,payload)=>{calls.push({op,payload});if(failed)throw {status:502};return {id:'run'};}}});
  const body={definitionId:'procurement',title:'Original',input:{}};await assert.rejects(controller.execute('create',body));body.title='Changed';
  await assert.rejects(controller.execute('create',body));assert.equal(calls.length,1);failed=false;await controller.retry();
  assert.deepEqual(calls[0],calls[1]);assert.equal(calls[1].payload.body.title,'Original');assert.equal(controller.uncertain,false);
  const denied=createWorkflowCommands({actorId:'alice',api:{workflow:async()=>{throw {status:403}}},newKey:()=> 'deny'});await assert.rejects(denied.execute('create',body));assert.equal(denied.uncertain,false);
});
test('workflow command cannot be sent twice while pending',async()=>{
  let finish;const controller=createWorkflowCommands({actorId:'alice',newKey:()=> 'fixed',api:{workflow:()=>new Promise(resolve=>{finish=resolve})}});
  const first=controller.execute('transition',{action:'submit',expectedVersion:1,input:{}},'run');await assert.rejects(controller.retry());finish({id:'run'});await first;
});
