// SPDX-License-Identifier: Apache-2.0
const {test}=require('node:test');const assert=require('node:assert/strict');const {createBridge}=require('../bridge.cjs');
test('workflow proxy stays user-bound, allowlisted and forwards idempotency without token leaks',async()=>{
  const calls=[];const bridge=createBridge({gatewayUrl:'http://gateway',tokenUrl:'http://identity/token',userinfoUrl:'http://identity/user',authorizationUrl:'http://identity/auth',clientId:'fixture',callbackUrl:'http://localhost/callback'},
    {schedule:()=>({unref(){}}),cancelTimer:()=>{},fetch:async(url,options)=>{calls.push({url,options});const data=url.endsWith('/token')?{access_token:'fixture-token',expires_in:300}:url.endsWith('/user')?{sub:'alice'}:url.endsWith('/actions')?{items:[]}:{id:'run',state:'draft'};return new Response(JSON.stringify(data));}});
  const start=bridge.connect('noco');await bridge.callback({state:new URL(start.authorizationUrl).searchParams.get('state'),code:'fixture'},start.browserId);
  const count=calls.length;await assert.rejects(bridge.workflow('other',start.browserId,{operation:'list'}),{status:401});await assert.rejects(bridge.workflow('noco',start.browserId,{operation:'__proto__'}),{status:400});await assert.rejects(bridge.workflow('noco',start.browserId,{operation:'detail',id:'../files'}),{status:400});await assert.rejects(bridge.workflow('noco',start.browserId,{operation:'create',body:{},key:'key',url:'https://other'}),{status:400});assert.equal(calls.length,count);
  await bridge.workflow('noco',start.browserId,{operation:'capabilities'});
  assert.equal(calls.at(-1).url,'http://gateway/v1/me/capabilities');assert.equal(calls.at(-1).options.method,'GET');
  for(const extra of [{id:'11111111-1111-4111-8111-111111111111'},{query:{role:'admin'}},{body:{}},{key:'custom'}])await assert.rejects(bridge.workflow('noco',start.browserId,{operation:'capabilities',...extra}),{status:400});
  const result=await bridge.workflow('noco',start.browserId,{operation:'create',key:'ui-fixed',body:{definitionId:'procurement',title:'x',input:{}}});assert.equal(result.token,undefined);assert.equal(calls.at(-1).url,'http://gateway/v1/workflows');assert.equal(calls.at(-1).options.headers['idempotency-key'],'ui-fixed');assert.equal(calls.at(-1).options.headers.authorization,'Bearer fixture-token');bridge.disconnect('noco',start.browserId);
});
test('phase-two wait and sync operations use fixed paths, keys and scoped pagination',async()=>{
  const calls=[];const bridge=createBridge({gatewayUrl:'http://gateway',tokenUrl:'http://identity/token',userinfoUrl:'http://identity/user',authorizationUrl:'http://identity/auth',clientId:'fixture',callbackUrl:'http://localhost/callback'},
    {schedule:()=>({unref(){}}),cancelTimer:()=>{},fetch:async(url,options)=>{calls.push({url,options});return Response.json(url.endsWith('/token')?{access_token:'fixture-token',expires_in:300}:url.endsWith('/user')?{sub:'alice'}:{items:[]});}});
  const start=bridge.connect('noco');await bridge.callback({state:new URL(start.authorizationUrl).searchParams.get('state'),code:'fixture'},start.browserId);
  const id='11111111-1111-4111-8111-111111111111';
  for(const operation of ['waits','executions']){
    await bridge.workflow('noco',start.browserId,{operation,id,query:{limit:'10',offset:'0'}});
    assert.equal(calls.at(-1).url,`http://gateway/v1/workflows/${id}/${operation}?limit=10&offset=0`);
    await assert.rejects(bridge.workflow('noco',start.browserId,{operation,id,query:{state:'draft'}}),{status:400});
  }
  await bridge.workflow('noco',start.browserId,{operation:'people',query:{limit:'100',offset:'0'}});assert.equal(calls.at(-1).url,'http://gateway/v1/directory/people?limit=100&offset=0');
  await assert.rejects(bridge.workflow('noco',start.browserId,{operation:'people',query:{organizationId:'other'}}),{status:400});
  for(const [operation,suffix] of [['completeWait',`workflow-waits/${id}/complete`],['retrySync',`workflows/${id}/sync/retry`]]){
    const body=operation==='completeWait'?{status:'succeeded',result:{}}:{};
    await assert.rejects(bridge.workflow('noco',start.browserId,{operation,id,body}),{status:400});
    await bridge.workflow('noco',start.browserId,{operation,id,body,key:'ui-fixed'});
    assert.equal(calls.at(-1).url,`http://gateway/v1/${suffix}`);
    assert.equal(calls.at(-1).options.headers['idempotency-key'],'ui-fixed');
    assert.equal(calls.at(-1).options.body,JSON.stringify(body));
  }
  bridge.disconnect('noco',start.browserId);
});
