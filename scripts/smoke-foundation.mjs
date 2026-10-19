// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
const gateway='http://localhost:8080';
async function token(username){
  const r=await fetch('http://localhost:8081/realms/lattice/protocol/openid-connect/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'password',client_id:'dx-local',username,password:`local-${username}-password`})});
  assert.equal(r.status,200);return (await r.json()).access_token;
}
const alice=await token('alice'),bob=await token('bob');
const subject=JSON.parse(Buffer.from(alice.split('.')[1],'base64url').toString()).sub;
async function call(path,method='GET',body,auth=alice){
  return fetch(gateway+path,{method,headers:{authorization:`Bearer ${auth}`,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(25000)});
}
assert.equal((await fetch(gateway+'/v1/tasks')).status,401);
assert.equal((await call('/v1/tasks','POST',{title:'Smoke approval',assigneeId:subject,organizationId:'org-b'})).status,400);
const created=await call('/v1/tasks','POST',{title:'Smoke approval',assigneeId:subject});
assert.equal(created.status,201);const task=await created.json();assert.equal(task.organizationId,'org-a');
const other=await call('/v1/tasks','GET',undefined,bob);assert.equal(other.status,200);assert.ok(!(await other.json()).items.some(x=>x.id===task.id));
assert.equal((await call(`/v1/tasks/${task.id}/decisions`,'POST',{decision:'approve',expectedVersion:1},bob)).status,409);
const decisions=await Promise.all([call(`/v1/tasks/${task.id}/decisions`,'POST',{decision:'approve',expectedVersion:1}),call(`/v1/tasks/${task.id}/decisions`,'POST',{decision:'approve',expectedVersion:1})]);
assert.deepEqual(decisions.map(r=>r.status).sort(),[200,409]);
const upload=await call('/v1/files','POST',{filename:'smoke.txt',contentBase64:Buffer.from('LatticeDX safe smoke').toString('base64')});
assert.equal(upload.status,201);const file=await upload.json();assert.equal(file.scanStatus,'clean');
const download=await call(`/v1/files/${file.id}/content`);assert.equal(download.status,200);assert.equal(await download.text(),'LatticeDX safe smoke');
assert.equal((await call(`/v1/files/${file.id}/content`,'GET',undefined,bob)).status,404);
// Standard harmless antivirus test string, transmitted directly; never saved to host disk.
const rejected=await call('/v1/files','POST',{filename:'antivirus-test.txt',contentBase64:'WDVPIVAlQEFQWzRcUFpYNTQoUF4pN0NDKTd9JEVJQ0FSLVNUQU5EQVJELUFOVElWSVJVUy1URVNULUZJTEUhJEgrSCo='});
assert.equal(rejected.status,201);const infected=await rejected.json();assert.equal(infected.scanStatus,'rejected');
assert.equal((await call(`/v1/files/${infected.id}/content`)).status,409);
console.log('Foundation smoke passed: durable task assignment/decision, concurrent decision conflict, organization isolation, real ClamAV clean/rejected scans and guarded download.');
