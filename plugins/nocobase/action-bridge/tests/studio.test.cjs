// SPDX-License-Identifier: Apache-2.0
const {test}=require('node:test');const assert=require('node:assert/strict');const {createBridge}=require('../bridge.cjs');
test('configured entity queries use one fixed path and reject scope injection',()=>{
 const {studioRequest}=require('../studio.cjs');
 class BridgeError extends Error {constructor(status,message){super(message);this.status=status;}}
 const body={schemaId:'contracts',schemaVersion:1,filters:[{field:'status',operator:'eq',value:'active'}],limit:20,offset:0};
 const parse=input=>studioRequest(input,BridgeError,()=>''),input={operation:'queryEntities',body,key:'read-1'};
 assert.deepEqual(parse(input),{method:'POST',path:'entities/query',body:JSON.stringify(body),key:'read-1'});
 for(const extra of [{organizationId:'other'},{schemaVersion:0},{limit:101},{offset:-1},{schemaId:'../escape'}])assert.throws(()=>parse({...input,body:{...body,...extra}}),{status:400});
});
test('Studio bridge keeps fixed paths, actor-bound sessions and idempotent write envelopes',async()=>{
 const calls=[];const bridge=createBridge({gatewayUrl:'http://gateway',tokenUrl:'http://identity/token',userinfoUrl:'http://identity/user',authorizationUrl:'http://identity/auth',clientId:'fixture',callbackUrl:'http://localhost/callback'}, {schedule:()=>({unref(){}}),cancelTimer:()=>{},fetch:async(url,options)=>{calls.push({url,options});return Response.json(url.endsWith('/token')?{access_token:'fixture-token',expires_in:300}:url.endsWith('/user')?{sub:'alice'}:{items:[]});}});
 const start=bridge.connect('noco');await bridge.callback({state:new URL(start.authorizationUrl).searchParams.get('state'),code:'fixture'},start.browserId);
 await assert.rejects(bridge.studio('other',start.browserId,{operation:'drafts'}),{status:401});
 const before=calls.length;
 for(const value of [{operation:'__proto__'},{operation:'draft',id:'../files'},{operation:'plan',body:{},key:'one',url:'http://other'},{operation:'apps',body:{}},{operation:'install',body:{}}])await assert.rejects(bridge.studio('noco',start.browserId,value),{status:400});
 assert.equal(calls.length,before);
 await bridge.studio('noco',start.browserId,{operation:'save',body:{recipe:{}},key:'draft-1'});
 assert.equal(calls.at(-1).url,'http://gateway/v1/system-drafts');assert.equal(calls.at(-1).options.headers['idempotency-key'],'draft-1');
 await bridge.studio('noco',start.browserId,{operation:'save',id:'company-a',body:{recipe:{},expectedRevision:1},key:'draft-2'});assert.equal(calls.at(-1).options.method,'PUT');
 await bridge.studio('noco',start.browserId,{operation:'app',id:'company-a',version:'1.0.0'});assert.equal(calls.at(-1).url,'http://gateway/v1/system-apps/company-a/versions/1.0.0');
 bridge.disconnect('noco',start.browserId);
});

test('enterprise Studio operations use exact fixed paths and reject unneeded parameters',()=>{
 const {studioRequest}=require('../studio.cjs');
 class BridgeError extends Error {constructor(status,message){super(message);this.status=status;}}
 const query=(value,allowed)=>{if(value===undefined)return '';if(Object.keys(value).some(k=>!allowed.includes(k)))throw new BridgeError(400,'query');return new URLSearchParams(value).toString();};
 const uuid='00000000-0000-4000-8000-000000000001';
 const cases=[
  ['catalog','GET','studio/catalog'], ['schemas','GET','entity-schemas'], ['schema','GET','entity-schemas/invoice','invoice'],
  ['createSchema','POST','entity-schemas'], ['saveSchema','PUT','entity-schemas/invoice','invoice'], ['publishSchema','POST','entity-schemas/invoice/publish','invoice'],
  ['publishedSchema','GET','entity-schemas/invoice/versions/1','invoice',1], ['departments','GET','organization/departments'],
  ['createDepartment','POST','organization/departments'], ['updateDepartment','PATCH','organization/departments/purchasing','purchasing'],
  ['departmentHistory','GET','organization/departments/purchasing/history','purchasing'], ['diagnostics','GET','operations/diagnostics'], ['queues','GET','operations/queues'],
  ['entityHistory','GET',`entities/${uuid}/history`,uuid], ['shares','GET',`entities/${uuid}/shares`,uuid], ['share','POST',`entities/${uuid}/shares`,uuid],
 ];
 const paged=['schemas','departments','departmentHistory','entityHistory','shares'];
 for(const [operation,method,path,id,version] of cases){
  const input={operation,...(id===undefined?{}:{id}),...(version===undefined?{}:{version}),...(method==='GET'?{}:{body:{value:1},key:'immutable-1'})};
  assert.deepEqual(studioRequest(input,BridgeError,query),{method,path,...(method==='GET'?{}:{body:'{"value":1}',key:'immutable-1'})});
  for(const extra of [{url:'https://bad'},{version:'1.0.0'},...(id===undefined?[{id:'invoice'}]:[{id:'../escape'}]),...(!paged.includes(operation)?[{query:{}}]:[{query:{tenant:'other'}}]),...(method==='GET'?[{body:{}},{key:'bad'}]:[{key:undefined},{body:[]}])])assert.throws(()=>studioRequest({...input,...extra},BridgeError,query),{status:400});
  if(paged.includes(operation))assert.equal(studioRequest({...input,query:{limit:'10',offset:'0',q:'hello'}},BridgeError,query).path,path+'?limit=10&offset=0&q=hello');
 }
 for(const version of [0,-1,1.1,2147483648,'1','01',NaN])assert.throws(()=>studioRequest({operation:'publishedSchema',id:'invoice',version},BridgeError,query),{status:400});
 assert.throws(()=>studioRequest({operation:'share',id:'invoice',body:{},key:'one'},BridgeError,query),{status:400});
 assert.throws(()=>studioRequest({operation:'createSchema',body:{large:'x'.repeat(128*1024)},key:'one'},BridgeError,query),{status:413});
});

test('system membership and policy bridge operations use strict versioned paths and idempotency envelopes',()=>{
 const {studioRequest}=require('../studio.cjs');
 class BridgeError extends Error {constructor(status,message){super(message);this.status=status;}}
 const query=(value,allowed)=>{if(value===undefined)return '';if(Object.keys(value).some(k=>!allowed.includes(k)))throw new BridgeError(400,'query');return new URLSearchParams(value).toString();};

 // policy read
 assert.deepEqual(
   studioRequest({operation:'policy',id:'procurement',version:'1.0.0'},BridgeError,query),
   {method:'GET',path:'systems/procurement/versions/1.0.0/policy'}
 );
 // policy activate
 assert.deepEqual(
   studioRequest({operation:'activatePolicy',id:'procurement',version:'1.0.0',body:{expectedRevision:0},key:'act-1'},BridgeError,query),
   {method:'POST',path:'systems/procurement/versions/1.0.0/policy/activate',body:'{"expectedRevision":0}',key:'act-1'}
 );
 // members list
 assert.deepEqual(
   studioRequest({operation:'members',id:'procurement',version:'1.0.0',query:{limit:'20',offset:'0'}},BridgeError,query),
   {method:'GET',path:'systems/procurement/versions/1.0.0/members?limit=20&offset=0'}
 );
 // grant member
 assert.deepEqual(
   studioRequest({operation:'grantMember',id:'procurement',version:'1.0.0',body:{principalType:'person',principalId:'alice',roles:['buyer']},key:'grant-1'},BridgeError,query),
   {method:'POST',path:'systems/procurement/versions/1.0.0/members',body:'{"principalType":"person","principalId":"alice","roles":["buyer"]}',key:'grant-1'}
 );
 // update member
 assert.deepEqual(
   studioRequest({operation:'updateMember',id:'procurement',version:'1.0.0',principalType:'person',principalId:'alice',body:{roles:['approver'],expectedRevision:1},key:'up-1'},BridgeError,query),
   {method:'PUT',path:'systems/procurement/versions/1.0.0/members/person/alice',body:'{"roles":["approver"],"expectedRevision":1}',key:'up-1'}
 );
 // revoke member
 assert.deepEqual(
   studioRequest({operation:'revokeMember',id:'procurement',version:'1.0.0',principalType:'department',principalId:'eng',key:'rev-1'},BridgeError,query),
   {method:'DELETE',path:'systems/procurement/versions/1.0.0/members/department/eng',key:'rev-1'}
 );
 // member history
 assert.deepEqual(
   studioRequest({operation:'memberHistory',id:'procurement',version:'1.0.0',query:{limit:'10',offset:'0'}},BridgeError,query),
   {method:'GET',path:'systems/procurement/versions/1.0.0/members/history?limit=10&offset=0'}
 );
 // my access
 assert.deepEqual(
   studioRequest({operation:'myAccess',id:'procurement',version:'1.0.0'},BridgeError,query),
   {method:'GET',path:'system-apps/procurement/versions/1.0.0/access/me'}
 );

 // Rejections: missing id or version
 assert.throws(()=>studioRequest({operation:'policy',id:'procurement'},BridgeError,query),{status:400});
 assert.throws(()=>studioRequest({operation:'policy',version:'1.0.0'},BridgeError,query),{status:400});
 // Invalid principalType
 assert.throws(()=>studioRequest({operation:'updateMember',id:'procurement',version:'1.0.0',principalType:'invalid',principalId:'x',body:{},key:'k'},BridgeError,query),{status:400});
 // Missing key on writes
 assert.throws(()=>studioRequest({operation:'activatePolicy',id:'procurement',version:'1.0.0'},BridgeError,query),{status:400});
 assert.throws(()=>studioRequest({operation:'grantMember',id:'procurement',version:'1.0.0',body:{roles:[]}},BridgeError,query),{status:400});
});
