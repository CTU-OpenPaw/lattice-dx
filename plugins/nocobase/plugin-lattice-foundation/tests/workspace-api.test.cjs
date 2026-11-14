/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createWorkspaceApi} = require('../src/client/workspace-api');
test('shared client delegates authentication to host APIClient, adds timeout and preserves wrapping', async () => {
  const calls=[];
  const api=createWorkspaceApi({apiClient:{request:async options=>{calls.push(options);return {data:{data:{items:[{id:'purchasing'}]}}};}}});
  assert.deepEqual(await api.applications(),[{id:'purchasing'}]);
  assert.deepEqual(calls,[{url:'latticeApps:list',method:'get',timeout:15000}]);
  assert.ok(!('headers' in calls[0]));
});
test('expired app/bridge sessions are distinguished; failed writes are never retried', async () => {
  for(const [url,source] of [['latticeApps:list','nocobase'],['dxActions:run','bridge']]) {
    const expired=[],notices=[];let count=0;
    const api=createWorkspaceApi({apiClient:{request:async()=>{count++;throw {response:{status:401}};}},onExpired:s=>expired.push(s),notify:n=>notices.push(n)});
    await assert.rejects(api.request({url,method:'post'}),{status:401,source});
    assert.deepEqual(expired,[source]);assert.equal(notices[0].type,'error');assert.equal(count,1);
  }
});
test('403 and network errors notify; untrusted authorization URL is rejected', async () => {
  for(const status of [403,undefined]) {
    const notices=[];
    const api=createWorkspaceApi({apiClient:{request:async()=>{throw {response:{status}};}},notify:n=>notices.push(n)});
    await assert.rejects(api.applications());assert.equal(notices.length,1);
  }
  const api=createWorkspaceApi({apiClient:{request:async()=>({data:{authorizationUrl:'https://untrusted.invalid/auth'}})}});
  await assert.rejects(api.connect(),{status:502});
});
test('sign out disconnects business session before host signOut', async () => {
  const calls=[];
  const api=createWorkspaceApi({apiClient:{request:async r=>{calls.push(r.url);return {data:{}};},auth:{signOut:async()=>calls.push('host.signOut')}}});
  await api.signOut();assert.deepEqual(calls,['dxActions:disconnect','host.signOut']);
});
