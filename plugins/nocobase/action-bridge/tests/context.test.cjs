/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {test}=require('node:test');const assert=require('node:assert/strict');const {createBridge}=require('../bridge.cjs');
test('Context bridge only forwards fixed authorized read paths and preserves denial status',async()=>{
 const calls=[];let deny=false;const bridge=createBridge({gatewayUrl:'http://gateway',tokenUrl:'http://identity/token',userinfoUrl:'http://identity/user',authorizationUrl:'http://identity/auth',clientId:'fixture',callbackUrl:'http://localhost/callback'},
 {schedule:()=>({unref(){}}),cancelTimer:()=>{},fetch:async(url,options)=>{calls.push({url,options});return Response.json(url.endsWith('/token')?{access_token:'fixture-token',expires_in:300}:url.endsWith('/user')?{sub:'alice'}:{items:[]},{status:deny?404:200});}});
 const start=bridge.connect('noco');await bridge.callback({state:new URL(start.authorizationUrl).searchParams.get('state'),code:'fixture'},start.browserId);
 const id='11111111-1111-4111-8111-111111111111';let count=calls.length;
 for(const input of [{operation:'detail',id:'../asset'},{operation:'detail',id,organizationId:'other'},{operation:'detail',id,url:'http://evil'},{operation:'retry',id},{operation:'detail',id,body:{}}])await assert.rejects(bridge.entity('noco',start.browserId,input),{status:400});
 await assert.rejects(bridge.entity('other',start.browserId,{operation:'detail',id}),{status:401});assert.equal(calls.length,count);
 await bridge.workflow('noco',start.browserId,{operation:'entityContext',id});assert.equal(calls.at(-1).url,`http://gateway/v1/workflows/${id}/entity-context`);
 await bridge.entity('noco',start.browserId,{operation:'detail',id});assert.equal(calls.at(-1).url,`http://gateway/v1/entities/${id}`);assert.equal(calls.at(-1).options.method,'GET');assert.equal(calls.at(-1).options.headers.authorization,'Bearer fixture-token');
 const beforeUnsupportedEntityReads=calls.length;
 await assert.rejects(bridge.entity('noco',start.browserId,{operation:'context',id}),{status:400});
 await assert.rejects(bridge.entity('noco',start.browserId,{operation:'history',id,query:{limit:'10',offset:'0'}}),{status:400});
 assert.equal(calls.length,beforeUnsupportedEntityReads,'Unsupported entity routes must fail before dispatch');
 await bridge.entity('noco',start.browserId,{operation:'relations',id,query:{limit:'5',offset:'0'}});assert.equal(calls.at(-1).url,`http://gateway/v1/entities/${id}/relations?limit=5&offset=0`);assert.equal(calls.at(-1).options.method,'GET');
 await assert.rejects(bridge.workflow('noco',start.browserId,{operation:'entityContext',id,query:{tenant:'other'}}),{status:400});
 deny=true;await assert.rejects(bridge.entity('noco',start.browserId,{operation:'detail',id}),{status:404});bridge.disconnect('noco',start.browserId);
});
