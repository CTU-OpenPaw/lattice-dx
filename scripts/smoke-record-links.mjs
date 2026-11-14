/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
const base = 'http://localhost:8080';
async function login(username) {
  const r = await fetch('http://localhost:8081/realms/lattice/protocol/openid-connect/token', {
    method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({grant_type:'password',client_id:'dx-local',username,password:`local-${username}-password`}),signal:AbortSignal.timeout(10000),
  });
  assert.equal(r.status,200); return (await r.json()).access_token;
}
const alice=await login('alice'),bob=await login('bob');
const subject=JSON.parse(Buffer.from(alice.split('.')[1],'base64url').toString()).sub;
async function call(path, body, auth=alice) {
  return fetch(base+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${auth}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(25000)});
}
const created=await call('/v1/records',{title:'Linked logistics handoff'});assert.equal(created.status,201);
const record=await created.json();
for(const path of ['/v1/tasks','/v1/actions/tasks.create/run']){
  const input={title:'Warehouse preparation',assigneeId:subject,recordId:record.id};
  const response=await call(path,path.includes('/actions/')?{version:1,input}:input);
  assert.equal(response.status,path.includes('/actions/')?200:201);
  const json=await response.json(),task=path.includes('/actions/')?json.result:json;
  assert.equal(task.recordId,record.id);
  const inbox=await call('/v1/tasks');assert.equal(inbox.status,200);
  assert.ok((await inbox.json()).items.some(t=>t.id===task.id&&t.recordId===record.id));
  const decision=await call(`/v1/tasks/${task.id}/decisions`,{decision:'approve',expectedVersion:1});assert.equal(decision.status,200);
  assert.equal((await decision.json()).recordId,record.id);
}
const upload=await call('/v1/files',{filename:'delivery-evidence.txt',contentBase64:Buffer.from('Logistics linked evidence').toString('base64'),recordId:record.id});
assert.equal(upload.status,201);const file=await upload.json();assert.equal(file.recordId,record.id);assert.equal(file.scanStatus,'clean');
const metadata=await call(`/v1/files/${file.id}`);assert.equal(metadata.status,200);assert.equal((await metadata.json()).recordId,record.id);
const content=await call(`/v1/files/${file.id}/content`);assert.equal(content.status,200);assert.equal(await content.text(),'Logistics linked evidence');
assert.equal((await call(`/v1/files/${file.id}`,undefined,bob)).status,404);
// Bob lacks write/assign roles: fail at authorization before any reference lookup.
assert.equal((await call('/v1/tasks',{title:'Denied',assigneeId:subject,recordId:record.id},bob)).status,403);
assert.equal((await call('/v1/files',{filename:'a.txt',contentBase64:'YQ==',recordId:'bad'})).status,400);
assert.equal((await call('/v1/tasks',{title:'Missing',assigneeId:subject,recordId:'00000000-0000-4000-8000-000000000000'})).status,404);
console.log('Record links smoke passed: PostgreSQL record/task/file association, action and REST, decision preserves reference, metadata/download, real clean scan, role and missing-reference denial.');
console.log(`Demo record ${record.id}; retained locally. Same-role cross-owner/org denial is covered by API tests.`);
