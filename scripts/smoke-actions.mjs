// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';

const gateway = 'http://localhost:8080';
async function token(username) {
  const response = await fetch('http://localhost:8081/realms/lattice/protocol/openid-connect/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'dx-local', username, password: `local-${username}-password` }),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200, `local login for ${username}`);
  return (await response.json()).access_token;
}
async function call(path, auth, input) {
  return fetch(gateway + path, {
    method: input === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(10000),
  });
}
const alice = await token('alice'), bob = await token('bob');
const subject = JSON.parse(Buffer.from(alice.split('.')[1], 'base64url').toString()).sub;
assert.equal((await fetch(gateway + '/v1/actions', { signal: AbortSignal.timeout(10000) })).status, 401);
const catalog = await call('/v1/actions', alice);
assert.equal(catalog.status, 200);
assert.deepEqual((await catalog.json()).items.map(item => item.id).sort(), ['records.create', 'tasks.create']);
assert.deepEqual((await (await call('/v1/actions', bob)).json()).items, []);
const denied = await call('/v1/actions/records.create/run', bob, { version: 1, input: { title: 'Denied' } });
assert.equal(denied.status, 403);
const spoof = await call('/v1/actions/records.create/run', alice, { version: 1, input: { title: 'Denied scope', organizationId: 'org-b' } });
assert.equal(spoof.status, 400);

const recordResponse = await call('/v1/actions/records.create/run', alice, { version: 1, input: { title: 'Action smoke record' } });
assert.equal(recordResponse.status, 200);
const recordRun = await recordResponse.json();
assert.equal(recordRun.status, 'succeeded');
assert.equal(recordRun.result.organizationId, 'org-a');
assert.equal(recordRun.result.ownerId, subject);
const records = await call('/v1/records', alice);
assert.equal(records.status, 200);
assert.ok((await records.json()).items.some(item => item.id === recordRun.result.id));
const bobRecords = await call('/v1/records', bob);
assert.equal(bobRecords.status, 200);
assert.ok(!(await bobRecords.json()).items.some(item => item.id === recordRun.result.id));

const taskResponse = await call('/v1/actions/tasks.create/run', alice, { version: 1, input: { title: 'Action smoke task', assigneeId: subject } });
assert.equal(taskResponse.status, 200);
const taskRun = await taskResponse.json();
assert.equal(taskRun.result.createdBy, subject);
assert.equal(taskRun.result.organizationId, 'org-a');
assert.equal(taskRun.result.status, 'pending');
const tasks = await call('/v1/tasks', alice);
assert.equal(tasks.status, 200);
assert.ok((await tasks.json()).items.some(item => item.id === taskRun.result.id));
const bobTasks = await call('/v1/tasks', bob);
assert.equal(bobTasks.status, 200);
assert.ok(!(await bobTasks.json()).items.some(item => item.id === taskRun.result.id));
console.log('Action smoke passed: gateway authentication, authorized catalog, role/scope denial, real PostgreSQL record and task writes, cross-organization isolation.');
console.log(`Created record ${recordRun.result.id} and task ${taskRun.result.id}; local demo data retained.`);
