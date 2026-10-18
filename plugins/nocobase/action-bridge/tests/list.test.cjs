// SPDX-License-Identifier: Apache-2.0
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createBridge}=require('../bridge.cjs');
test('list stays session-bound, uses fixed API paths and rejects unexpected results',async()=>{
  const calls=[];let invalid=false;
  const bridge=createBridge({gatewayUrl:'http://gateway',tokenUrl:'http://identity/token',userinfoUrl:'http://identity/user',authorizationUrl:'http://identity/auth',clientId:'fixture',callbackUrl:'http://localhost/callback'},
    {schedule:()=>({unref(){}}),cancelTimer:()=>{},fetch:async(url,options)=>{
      calls.push({url,options});
      const data=url.endsWith('/token')?{access_token:'fixture-token',expires_in:300}
        :url.endsWith('/user')?{sub:'subject',preferred_username:'alice'}
        :url.endsWith('/actions')?{items:[]}
        :invalid?{items:'invalid'}:{items:[{id:'record'}]};
      return {ok:true,json:async()=>data};
    }});
  const start=bridge.connect('noco-user');
  await bridge.callback({state:new URL(start.authorizationUrl).searchParams.get('state'),code:'fixture-code'},start.browserId);
  const count=calls.length;
  await assert.rejects(bridge.list('other-user',start.browserId,'records'),{status:401});
  await assert.rejects(bridge.list('noco-user',start.browserId,'../files'),{status:400});
  assert.equal(calls.length,count);
  assert.deepEqual(await bridge.list('noco-user',start.browserId,'records'),{items:[{id:'record'}]});
  assert.equal(calls.at(-1).url,'http://gateway/v1/records');
  assert.equal(calls.at(-1).options.headers.authorization,'Bearer fixture-token');
  invalid=true;await assert.rejects(bridge.list('noco-user',start.browserId,'tasks'),{status:502});
  bridge.disconnect('noco-user',start.browserId);
});
