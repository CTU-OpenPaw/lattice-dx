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
test('file bridge enforces user binding, fixed paths, size and quarantine',async()=>{
  const id='11111111-1111-4111-8111-111111111111';
  const calls=[];let status='clean';
  const bridge=createBridge({gatewayUrl:'http://gateway',tokenUrl:'http://identity/token',userinfoUrl:'http://identity/user',authorizationUrl:'http://identity/auth',clientId:'fixture',callbackUrl:'http://localhost/callback'},
    {schedule:()=>({unref(){}}),cancelTimer:()=>{},fetch:async(url,options)=>{
      calls.push({url,options});
      if(url.endsWith('/content'))return new Response('a');
      const data=url.endsWith('/token')?{access_token:'fixture-token',expires_in:300}:url.endsWith('/user')?{sub:'subject'}:url.endsWith('/actions')?{items:[]}:{id,filename:'a.txt',size:1,scanStatus:status};
      return new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
    }});
  const start=bridge.connect('noco-user');await bridge.callback({state:new URL(start.authorizationUrl).searchParams.get('state'),code:'code'},start.browserId);
  const input={operation:'upload',filename:'a.txt',contentBase64:'YQ==',recordId:id};
  const count=calls.length;
  await assert.rejects(bridge.files('other-user',start.browserId,input),{status:401});
  await assert.rejects(bridge.files('noco-user',start.browserId,{...input,organizationId:'other'}),{status:400});
  await assert.rejects(bridge.files('noco-user',start.browserId,{...input,contentBase64:'not-base64'}),{status:400});
  await assert.rejects(bridge.files('noco-user',start.browserId,{...input,contentBase64:Buffer.alloc(1048577).toString('base64')}),{status:413});
  await assert.rejects(bridge.files('noco-user',start.browserId,{operation:'metadata',id:'../../secret'}),{status:400});
  assert.equal(calls.length,count);
  assert.equal((await bridge.files('noco-user',start.browserId,input)).scanStatus,'clean');
  assert.equal(calls.at(-1).url,'http://gateway/v1/files');
  assert.equal(JSON.parse(calls.at(-1).options.body).operation,undefined);
  assert.equal((await bridge.files('noco-user',start.browserId,{operation:'content',id})).contentBase64,'YQ==');
  status='error';const before=calls.length;
  await assert.rejects(bridge.files('noco-user',start.browserId,{operation:'content',id}),{status:409});
  assert.equal(calls.length,before+1,'no content call for quarantined file');
  bridge.disconnect('noco-user',start.browserId);
});
