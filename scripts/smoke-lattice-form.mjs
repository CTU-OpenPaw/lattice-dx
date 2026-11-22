/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
// Local fixtures only. Tokens/cookies/authorization codes remain in memory.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {createFormActions} = require('../plugins/nocobase/plugin-lattice-foundation/src/client/actions.js');
const noco = 'http://localhost:13000', gateway = 'http://localhost:8080', identity = 'http://localhost:8081';
const cookies = new Map(), keycloakCookies = new Map();
async function request(url, options = {}, jar) {
  const headers = new Headers(options.headers);
  if (jar?.size) headers.set('cookie', [...jar].map(([k,v]) => `${k}=${v}`).join('; '));
  const response = await fetch(url, {...options, headers, redirect: 'manual', signal: AbortSignal.timeout(15000)});
  if (jar) for (const cookie of response.headers.getSetCookie()) {
    const [name,...value] = cookie.split(';')[0].split('=');
    if (value.join('=')) jar.set(name,value.join('=')); else jar.delete(name);
  }
  return response;
}
const login = await request(`${noco}/api/auth:signIn`, {method: 'POST', headers: {'content-type':'application/json'},
  body: JSON.stringify({email:'admin@nocobase.com',password:'admin123'})});
assert.equal(login.status,200,'NocoBase login');
const token = (await login.json()).data.token;
const headers = {authorization:`Bearer ${token}`,'content-type':'application/json'};
const apiClient = {async request({url,method='get',data}) {
  const r = await request(`${noco}/api/${url}`, {method:method.toUpperCase(),headers,...(data ? {body:JSON.stringify(data)} : {})},cookies);
  if (!r.ok) {const error = new Error(`NocoBase API HTTP ${r.status}`);error.response={status:r.status};throw error;}
  return {data:await r.json()};
}};
const {data:start} = await apiClient.request({url:'dxActions:connect',method:'post'});
const authUrl = new URL(start.authorizationUrl);
assert.equal(authUrl.origin,identity);
const auth = await request(authUrl,{},keycloakCookies);
assert.equal(auth.status,200,'Keycloak form');
const formAction = (await auth.text()).match(/<form[^>]*action="([^"]+)"/i)?.[1]?.replaceAll('&amp;','&');
assert.ok(formAction,'authorization form action');
const formUrl = new URL(formAction,authUrl);
assert.equal(formUrl.origin,identity);
const signedIn = await request(formUrl,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
  body:new URLSearchParams({username:'alice',password:'local-alice-password',credentialId:''})},keycloakCookies);
assert.equal(signedIn.status,302,'Keycloak authorization');
const callbackUrl = new URL(signedIn.headers.get('location'));
assert.equal(callbackUrl.origin,noco);
assert.equal(callbackUrl.pathname,'/api/dxActions:callback');
assert.equal((await request(callbackUrl,{},cookies)).status,302,'PKCE account connection');
try {
  const {data:status} = await apiClient.request({url:'dxActions:status'});
  assert.equal(status.connected,true);
  const {data:catalog} = await apiClient.request({url:'latticeApps:list'});
  const manifests = catalog.data.items;
  const purchasing = manifests.find(m=>m.id==='purchasing');
  const logistics = manifests.find(m=>m.id==='logistics');
  assert.ok(purchasing && logistics);
  const record = await createFormActions({apiClient,manifest:purchasing,blockId:'create-request'}).submit({title:`Lattice form E2E ${new Date().toISOString()}`});
  assert.equal(record.ownerId,status.identity.subject);
  assert.equal(record.organizationId,'org-a');
  const task = await createFormActions({apiClient,manifest:logistics,blockId:'assign-warehouse-task'}).submit({
    title:'Lattice form E2E: kho nhận việc',assigneeId:status.identity.subject,recordId:record.id});
  assert.equal(task.recordId,record.id);
  assert.equal(task.organizationId,'org-a');
  // Development client is used only to read back the same user's persisted data.
  const authResponse = await request(`${identity}/realms/lattice/protocol/openid-connect/token`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({grant_type:'password',client_id:'dx-local',username:'alice',password:'local-alice-password'})});
  assert.equal(authResponse.status,200,'readback identity');
  const accessToken = (await authResponse.json()).access_token;
  for (const [resource,id] of [['records',record.id],['tasks',task.id]]) {
    const r = await request(`${gateway}/v1/${resource}`,{headers:{authorization:`Bearer ${accessToken}`}});
    assert.equal(r.status,200,`${resource} readback`);
    assert.ok((await r.json()).items.some(item=>item.id===id),`${resource} persisted`);
  }
  console.log(JSON.stringify({result:'PASS',recordId:record.id,taskId:task.id,organizationId:'org-a',readback:'PASS',flow:'manifest -> form controller -> PKCE bridge -> Gateway/API -> PostgreSQL'}));
} finally {
  await apiClient.request({url:'dxActions:disconnect',method:'post'});
}
