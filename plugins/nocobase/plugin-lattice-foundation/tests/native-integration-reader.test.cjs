/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {test}=require('node:test'),assert=require('node:assert/strict');
const {readNativeRecord}=require('../src/server/native-integration-reader');
const {boundedJson}=require('../src/server/native-integration-reader');
function ctx(){return {app:{name:'main',db:{getRepository:name=>({find:async()=>[{id:9,userId:4,active:true,organizationId:'org-a'}],findOne:async()=>({id:12})})}},state:{currentUser:{id:4},currentRole:'ldx_employee'},get:key=>key==='Authorization'?'Bearer native-session':undefined};}
test('record reader uses fixed native endpoint and verified role while retaining native field filtering',async()=>{
 let call;const result=await readNativeRecord(ctx(),{collection:'latticeOrders',recordId:12},{fetchImpl:async(url,options)=>{call={url,options};return Response.json({data:{id:12,name:'Visible name'}});}});
 assert.equal(call.url,'http://127.0.0.1/api/latticeOrders:get?filterByTk=12');assert.equal(call.options.headers['X-Role'],'ldx_employee');assert.equal(call.options.headers.Authorization,'Bearer native-session');
 assert.deepEqual(result.record,{id:12,name:'Visible name'});assert.equal(result.record.customer,undefined);assert.equal(result.actor.organizationId,'org-a');
});
test('reader cannot bypass native data ACL, lost membership or unsupported collection',async()=>{
 await assert.rejects(()=>readNativeRecord(ctx(),{collection:'users',recordId:1}),/COLLECTION_DENIED/);
 await assert.rejects(()=>readNativeRecord(ctx(),{collection:'latticeOrders',recordId:12},{fetchImpl:async()=>new Response(null,{status:403})}),/ACCESS_DENIED/);
 const inactive=ctx();inactive.app.db.getRepository=()=>({find:async()=>[{active:false}]});await assert.rejects(()=>readNativeRecord(inactive,{collection:'latticeOrders',recordId:12}),/MEMBERSHIP_REQUIRED/);
});
test('cross-organization row is rejected even if native role has broad view permission',async()=>{
 const actor=ctx();actor.app.db.getRepository=name=>({find:async()=>[{id:9,userId:4,active:true,organizationId:'org-a'}],findOne:async()=>null});
 await assert.rejects(()=>readNativeRecord(actor,{collection:'latticeOrders',recordId:12},{fetchImpl:async()=>Response.json({data:{id:12,name:'Foreign'}})}),/NOT_FOUND/);
});
test('native tool responses reject oversized/malformed JSON and sanitize unavailable backend',async()=>{
 await assert.rejects(()=>boundedJson(new Response('x'.repeat(100)),10),/TOO_LARGE/);
 await assert.rejects(()=>boundedJson(new Response('Not JSON')),/RESPONSE_INVALID/);
 await assert.rejects(()=>readNativeRecord(ctx(),{collection:'latticeOrders',recordId:12},{fetchImpl:async()=>{throw Error('internal private detail');}}),/NATIVE_API_UNAVAILABLE/);
});
