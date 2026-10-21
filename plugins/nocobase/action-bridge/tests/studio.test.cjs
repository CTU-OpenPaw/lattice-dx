// SPDX-License-Identifier: Apache-2.0
const {test}=require('node:test');const assert=require('node:assert/strict');const {createBridge}=require('../bridge.cjs');
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
