// SPDX-License-Identifier: Apache-2.0
const {test}=require('node:test'),assert=require('node:assert/strict');
const {saveReceipt,installProposalPermission}=require('../src/server/native-integrations');
test('receipt creation rejects a changed active organization or employee mapping inside transaction',async()=>{
 for(const employee of [{id:8,userId:4,organizationId:'org-b',active:true},{id:9,userId:4,organizationId:'org-a',active:true}]){
  let wrote=false;const db={sequelize:{transaction:async fn=>fn({}),query:async()=>{}},getRepository:name=>name==='latticeEmployees'?{find:async()=>[employee]}:{findOne:async()=>null,create:async()=>{wrote=true;}}};
  await assert.rejects(()=>saveReceipt({app:{db},state:{currentUser:{id:4}}},'latticeIntegrationInbox','key','hash',{organizationId:'org-a',sourceUserId:'4',sourceEmployeeId:8}),/MEMBERSHIP_CHANGED/);assert.equal(wrote,false);
 }
});
test('proposal capability uses a native snippet, preserves existing grants and leaves read-only director alone',async()=>{
 const changed=[];const db={getRepository:()=>({findOne:async({filter})=>({name:filter.name,snippets:['existing-native-permission']}),update:async options=>changed.push(options)})};
 await installProposalPermission(db);assert.equal(changed.length,6);assert.ok(changed.every(x=>x.filterByTk!=='ldx_director'));assert.deepEqual(changed[0].values.snippets,['existing-native-permission','lattice.integrations.propose']);
});
