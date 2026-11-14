/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createBridge}=require('../bridge.cjs');
const id='11111111-1111-4111-8111-111111111111';
async function fixture(){
 const calls=[];let status=200;
 const bridge=createBridge({gatewayUrl:'http://gateway',tokenUrl:'http://identity/token',userinfoUrl:'http://identity/user',authorizationUrl:'http://identity/auth',clientId:'fixture',callbackUrl:'http://localhost/callback'},
 {schedule:()=>({unref(){}}),cancelTimer:()=>{},fetch:async(url,options)=>{calls.push({url,options});return Response.json(url.endsWith('/token')?{access_token:'fixture-token',expires_in:300}:url.endsWith('/user')?{sub:'alice'}:{items:[],id},{status});}});
 const start=bridge.connect('noco');await bridge.callback({state:new URL(start.authorizationUrl).searchParams.get('state'),code:'fixture'},start.browserId);
 return {calls,bridge,browserId:start.browserId,deny:value=>{status=value;}};
}

test('relations use fixed paths, bounded pagination and immutable versioned commands',async()=>{
 const {bridge,browserId,calls}=await fixture(),targetId='22222222-2222-4222-8222-222222222222';
 await bridge.entity('noco',browserId,{operation:'relations',id,query:{limit:'20',offset:'0'}});
 assert.equal(calls.at(-1).url,`http://gateway/v1/entities/${id}/relations?limit=20&offset=0`);
 const body={expectedVersion:2,name:'department',targetId};
 await bridge.entity('noco',browserId,{operation:'link',id,body,key:'link-1'});
 assert.equal(calls.at(-1).options.method,'POST');assert.deepEqual(JSON.parse(calls.at(-1).options.body),body);
 await bridge.entity('noco',browserId,{operation:'unlink',id,body,key:'unlink-1'});
 assert.equal(calls.at(-1).url,`http://gateway/v1/entities/${id}/relations/department/${targetId}`);
 assert.equal(calls.at(-1).options.method,'DELETE');assert.deepEqual(JSON.parse(calls.at(-1).options.body),{expectedVersion:2});
 const before=calls.length;
 for(const input of [{operation:'relations',id,query:{schemaId:'assets'}},{operation:'link',id,body:{...body,name:'../escape'},key:'bad'},{operation:'unlink',id,body:{...body,targetId:'../escape'},key:'bad'},{operation:'link',id,body:{...body,actorId:'other'},key:'bad'}])await assert.rejects(bridge.entity('noco',browserId,input),{status:400});
 assert.equal(calls.length,before);bridge.disconnect('noco',browserId);
});
test('entity bridge preserves an explicit schema publication and rejects malformed pins',async()=>{
 const {bridge,browserId,calls}=await fixture(),body={schemaId:'assets',schemaVersion:1,title:'Pinned',attributes:{}};
 await bridge.entity('noco',browserId,{operation:'create',body,key:'pin'});assert.equal(JSON.parse(calls.at(-1).options.body).schemaVersion,1);
 const count=calls.length;for(const schemaVersion of [0,-1,'1',1.1,2147483648])await assert.rejects(bridge.entity('noco',browserId,{operation:'create',body:{...body,schemaVersion},key:'bad'}),{status:400});assert.equal(calls.length,count);
 bridge.disconnect('noco',browserId);
});
test('entity commands use fixed paths, backend envelopes and the same supplied key on replay',async()=>{
 const {bridge,browserId,calls}=await fixture();
 await bridge.entity('noco',browserId,{operation:'list',query:{schemaId:'incident-rule',limit:'50',offset:'0'}});
 assert.equal(calls.at(-1).url,'http://gateway/v1/entities?schemaId=incident-rule&limit=50&offset=0');
 const create={operation:'create',body:{schemaId:'incident-rule',title:'Temperature',attributes:{threshold:'60',enabled:true}},key:'rule-key'};
 await bridge.entity('noco',browserId,create);await bridge.entity('noco',browserId,create);
 assert.deepEqual(calls.at(-1),calls.at(-2));
 assert.equal(calls.at(-1).url,'http://gateway/v1/entities');assert.equal(calls.at(-1).options.method,'POST');
 assert.deepEqual(JSON.parse(calls.at(-1).options.body),create.body);
 assert.equal(calls.at(-1).options.headers.authorization,'Bearer fixture-token');assert.equal(calls.at(-1).options.headers['idempotency-key'],'rule-key');
 await bridge.entity('noco',browserId,{operation:'update',id,body:{expectedVersion:2,title:'Temperature',attributes:{enabled:false}},key:'edit'});
 assert.equal(calls.at(-1).options.method,'PATCH');assert.equal(calls.at(-1).url,`http://gateway/v1/entities/${id}`);
 await bridge.entity('noco',browserId,{operation:'archive',id,body:{expectedVersion:3},key:'archive'});
 assert.equal(calls.at(-1).url,`http://gateway/v1/entities/${id}/archive`);assert.equal(calls.at(-1).options.method,'POST');
 bridge.disconnect('noco',browserId);
});
test('entity bridge rejects scope injection, malformed writes and read payloads before dispatch',async()=>{
 const {bridge,browserId,calls}=await fixture(),count=calls.length;
 const body={schemaId:'incident-rule',title:'Temperature',attributes:{enabled:true}};
 for(const input of [
  {operation:'list',query:{organizationId:'other'}},{operation:'list',query:{schemaId:'../rules'}},
  {operation:'list',query:{limit:'101'}},{operation:'list',body:{}},{operation:'list',id},
  {operation:'detail',id,key:'unexpected'},{operation:'detail',id:'../secret'},
  {operation:'create',body,key:'valid',url:'http://evil'},{operation:'create',body,key:'valid',token:'other'},
  {operation:'create',body:{...body,organizationId:'other'},key:'valid'},
  {operation:'create',body},{operation:'create',body,key:'bad key'},{operation:'create',id,body,key:'valid'},
  {operation:'create',body:{schemaId:'incident-rule',attributes:{}},key:'valid'},
  {operation:'update',id,body:{title:'Rule',attributes:{}},key:'valid'},
  {operation:'update',id,body:{expectedVersion:'1',title:'Rule',attributes:{}},key:'valid'},
  {operation:'archive',id,body:{expectedVersion:0},key:'valid'},
  {operation:'archive',id,body:{expectedVersion:1,title:'extra'},key:'valid'},
  {operation:'delete',id,key:'valid'},
  {operation:['list']},{operation:['create']},{operation:{toString:null}},
 ])await assert.rejects(bridge.entity('noco',browserId,input),{status:400});
 await assert.rejects(bridge.entity('other',browserId,{operation:'create',body,key:'valid'}),{status:401});
 assert.equal(calls.length,count);bridge.disconnect('noco',browserId);
});
test('entity writes preserve backend denials and do not retry uncertain operations',async()=>{
 const {bridge,browserId,calls,deny}=await fixture();
 const input={operation:'archive',id,body:{expectedVersion:1},key:'archive'};
 for(const status of [403,404,409,429,503]){deny(status);const before=calls.length;await assert.rejects(bridge.entity('noco',browserId,input),{status});assert.equal(calls.length,before+1);}
 bridge.disconnect('noco',browserId);
});
