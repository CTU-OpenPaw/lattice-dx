/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { configureNativeProcess } from './configure-native-process.mjs';

const origin = new URL(process.env.NOCOBASE_URL ?? 'http://localhost:13001');
assert(['localhost', '127.0.0.1'].includes(origin.hostname), 'Local acceptance only');
const suffix = randomUUID();
const organizationId = process.env.DX_NATIVE_ATTACHMENT_SUBMIT_ORGANIZATION ?? 'native-attachment-submit-lab';
const fixtures = [];
let workflow;

async function call(path, actor, { values, key, method = values === undefined ? 'GET' : 'POST' } = {}) {
  return fetch(new URL('/api/' + path, origin), {
    method,
    headers: {
      ...(actor ? { Authorization: 'Bearer ' + actor.token, 'X-Role': actor.role } : {}),
      ...(values === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    body: values === undefined ? undefined : JSON.stringify(values),
    redirect: 'manual',
    signal: AbortSignal.timeout(25000),
  });
}

async function data(path, actor, options) {
  const response = await call(path, actor, options);
  if (!response.ok) throw Error(`${path.split('?')[0]} HTTP ${response.status}: ${await response.text()}`);
  return (await response.json()).data;
}

async function login(email, password, role) {
  const { token } = await data('auth:signIn', null, { values: { email, password } });
  return { token, role };
}

const root = await login(process.env.NOCOBASE_ADMIN_EMAIL ?? 'admin@nocobase.com', process.env.NOCOBASE_ADMIN_PASSWORD ?? 'admin123', 'root');

async function create(resource, values, actor = root) {
  const row = await data(resource + ':create', actor, { values });
  fixtures.push({ resource, id: row.id });
  return row;
}

async function employee(role, organization = organizationId) {
  const name = randomUUID();
  const email = name + '@example.invalid';
  const password = randomUUID();
  const user = await create('users', { username: name, email, password, roles: [role] });
  const profile = await create('latticeEmployees', { code: name, name: 'Attachment acceptance', organizationId: organization, userId: user.id, active: true });
  return { ...(await login(email, password, role)), profileId: profile.id };
}

try {
  const requester = await employee('ldx_employee');
  const manager = await employee('ldx_manager');
  const warehouse = await employee('ldx_warehouse');
  const foreignManager = await employee('ldx_manager', 'foreign_' + suffix);
  workflow = await configureNativeProcess((path, options) => data(path, root, options), {
    collection: 'latticeRequests', organizationId, reviewerEmployeeId: manager.profileId,
    assigneeEmployeeId: warehouse.profileId, startOnSubmit: true,
  });
  await data('workflows:update?filterByTk=' + workflow.workflowId, root, { values: { enabled: true } });
  const filter = encodeURIComponent(JSON.stringify({ workflowId: workflow.workflowId, nodeId: workflow.nodeIds.review }));
  const reviewTasks = () => data('workflowManualTasks:listMine?paginate=false&filter=' + filter, manager);
  const request = await create('latticeRequests', { code: suffix, name: 'Attachment acceptance draft' }, requester);
  assert.equal(request.status, 'draft');
  const other = await create('latticeRequests', { code: randomUUID(), name: 'Different draft' }, requester);
  const path = (action, requestId = request.id) => `latticeRequestAttachments:${action}?requestId=${requestId}`;
  const content = Buffer.from('native request attachment proof\n');
  const input = { values: { filename: 'request-proof.txt', contentBase64: content.toString('base64') }, key: randomUUID() };
  const uploads = await Promise.all([call(path('upload'), requester, input), call(path('upload'), requester, input)]);
  assert.deepEqual(uploads.map(response => response.status).sort(), [200, 201]);
  const files = await Promise.all(uploads.map(async response => (await response.json()).data));
  const fileId = files[0].fileId;
  assert.equal(files[0].scanStatus, 'clean');
  assert.equal(files[1].fileId, fileId);
  const conflicting = { ...input, values: { ...input.values, filename: 'different.txt' } };
  assert.equal((await call(path('upload'), requester, conflicting)).status, 409);
  const blockedUpload = { values: { filename: 'scanner-test.txt', contentBase64: Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*').toString('base64') }, key: randomUUID() };
  assert.equal((await call(path('upload'), requester, blockedUpload)).status, 409);

  const list = await data(path('list'), manager);
  assert.deepEqual(list, [{ fileId, filename: 'request-proof.txt', size: content.length, scanStatus: 'clean' }]);
  assert.equal((await reviewTasks()).length, 0, 'Draft created a review task');
  assert.equal((await call(path('submit'), manager, { values: {} })).status, 403);
  const submissions = await Promise.all([call(path('submit'), requester, { values: {} }), call(path('submit'), requester, { values: {} })]);
  assert.deepEqual(submissions.map(response => response.status), [200, 200]);
  const deadline = Date.now() + 20000;
  while (!(await reviewTasks()).length && Date.now() < deadline) await delay(250);
  const tasks = await reviewTasks();
  assert.equal(tasks.length, 1);
  const execution = await data('executions:get?filterByTk=' + tasks[0].executionId, root);
  assert.equal(String(execution.context.data.id), String(request.id));
  await delay(1000);
  assert.equal((await reviewTasks()).length, 1, 'Sending again created another task');
  const download = path('download') + '&fileId=' + fileId;
  const response = await call(download, manager);
  assert.equal(response.status, 200);
  const cacheDirectives = response.headers.get('cache-control').split(',').map(value => value.trim());
  assert(cacheDirectives.includes('private') && cacheDirectives.includes('no-store'));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), content);
  assert.equal((await call(path('download', other.id) + '&fileId=' + fileId, manager)).status, 404);
  assert.equal((await call(download, warehouse)).status, 404);
  assert.equal((await call(download, foreignManager)).status, 404);
  await data('latticeEmployees:update?filterByTk=' + manager.profileId, root, { values: { active: false } });
  assert.equal((await call(download, manager)).status, 403);
  console.log(JSON.stringify({ result: 'PASS', checks: ['scan_and_download_bytes', 'concurrent_retry', 'rejected_file_not_listed', 'one_review_task', 'wrong_request_denied', 'unrelated_and_foreign_users_denied', 'revocation_denied'] }));
} finally {
  if (workflow) {
    await data('workflows:update?filterByTk=' + workflow.workflowId, root, { values: { enabled: false } });
    await data('workflows:destroy?filterByTk=' + workflow.workflowId, root, { method: 'POST' });
  }
  for (const { resource, id } of fixtures.reverse()) {
    await data(resource + ':destroy?filterByTk=' + id, root, { method: 'POST' });
  }
}
