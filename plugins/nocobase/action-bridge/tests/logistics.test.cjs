/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {test}=require('node:test');const assert=require('node:assert/strict');const {createBridge}=require('../bridge.cjs');
test('Logistics bridge fixes routes, scopes browser session and forwards version/key with bounded queries',async()=>{
 const calls=[];const bridge=createBridge({gatewayUrl:'http://gateway',tokenUrl:'http://identity/token',userinfoUrl:'http://identity/user',authorizationUrl:'http://identity/auth',clientId:'fixture',callbackUrl:'http://localhost/callback'},
 {schedule:()=>({unref(){}}),cancelTimer:()=>{},fetch:async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify(url.endsWith('/token')?{access_token:'fixture-token',expires_in:300}:url.endsWith('/user')?{sub:'alice'}:url.endsWith('/actions')?{items:[]}:{items:[]}));}});
 const start=bridge.connect('noco');await bridge.callback({state:new URL(start.authorizationUrl).searchParams.get('state'),code:'fixture'},start.browserId);
 const count=calls.length;
 for(const data of [{operation:'__proto__'},{operation:'detail',id:'../files'},{operation:'orders',query:{limit:'101'}},{operation:'orders',query:{url:'http://other'}},{operation:'create',body:{},key:'key',url:'http://other'}])await assert.rejects(bridge.logistics('noco',start.browserId,data),{status:400});
 await assert.rejects(bridge.logistics('other',start.browserId,{operation:'orders'}),{status:401});assert.equal(calls.length,count);
 await bridge.logistics('noco',start.browserId,{operation:'people',query:{role:'logistics:warehouse',limit:'10',offset:'10',q:'Kho'}});
 assert.equal(calls.at(-1).url,'http://gateway/v1/directory/people?role=logistics%3Awarehouse&limit=10&offset=10&q=Kho');
 const id='11111111-1111-4111-8111-111111111111';await bridge.logistics('noco',start.browserId,{operation:'receive',id,key:'ui-fixed',body:{expectedVersion:2,receiptNote:'ok'}});
 assert.equal(calls.at(-1).url,`http://gateway/v1/logistics/orders/${id}/receive`);assert.equal(calls.at(-1).options.headers['idempotency-key'],'ui-fixed');assert.deepEqual(JSON.parse(calls.at(-1).options.body),{expectedVersion:2,receiptNote:'ok'});bridge.disconnect('noco',start.browserId);
});
