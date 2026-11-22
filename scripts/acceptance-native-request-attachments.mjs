/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';

function localOrigin(value) {
  const url = new URL(value);
  assert(['localhost', '127.0.0.1'].includes(url.hostname), 'Local acceptance only');
  return url.origin;
}

const native = localOrigin(process.env.NOCOBASE_URL ?? 'http://localhost:13001');
const gateway = localOrigin(process.env.DX_REQUEST_ATTACHMENTS_URL ?? native);
const password = process.env.DX_NATIVE_LAB_PASSWORD ?? 'NativeLab-2026!';
const run = process.argv.includes('--run');
const filter = value => encodeURIComponent(JSON.stringify(value));
const draftFile = Buffer.from('native request attachment proof\n');
const lab = JSON.parse(await readFile(new URL('../output/native-platform/ui-lab.json', import.meta.url)));

function call(origin, path, actor, {values, key, method = values === undefined ? 'GET' : 'POST'} = {}) {
  return fetch(new URL(path, origin), {
    method,
    headers: {
      ...(actor ? {Authorization: 'Bearer ' + actor.token, 'X-Role': actor.role} : {}),
      ...(values === undefined ? {} : {'Content-Type': 'application/json'}),
      ...(key ? {'Idempotency-Key': key} : {}),
    },
    body: values === undefined ? undefined : JSON.stringify(values),
    redirect: 'manual',
    signal: AbortSignal.timeout(15000),
  });
}

async function nativeData(path, actor, options) {
  const response = await call(native, '/api/' + path, actor, options);
  assert(response.ok, `${path.split('?')[0]} HTTP ${response.status}`);
  return (await response.json()).data;
}

async function signIn(email, secret, role) {
  const {token} = await nativeData('auth:signIn', null, {values: {email, password: secret}});
  assert(token, 'Missing session token');
  return {token, role};
}

const accounts = await Promise.all(lab.accounts.map(account => signIn(account.email, password, account.role)));
const requester = accounts.find(actor => actor.role === 'ldx_employee');
const manager = accounts.find(actor => actor.role === 'ldx_manager');
const warehouse = accounts.find(actor => actor.role === 'ldx_warehouse');
const fixtureCode = process.env.DX_ATTACHMENT_FIXTURE_CODE ?? 'STUDIO-FIELD-01';
const [fixture] = await nativeData('latticeRequests:list?filter=' + filter({code: fixtureCode}), requester);
assert(fixture?.id && fixture.status === 'submitted', 'Preflight requires a submitted fixture');
assert((await nativeData('latticeRequests:get?filterByTk=' + fixture.id, manager))?.id);
assert(!(await nativeData('latticeRequests:get?filterByTk=' + fixture.id, warehouse))?.id);

const requestPath = id => '/v1/native/requests/' + id;
const probe = await call(gateway, requestPath(fixture.id) + '/attachments', manager);
const contentType = probe.headers.get('content-type');
const responseBody = probe.ok && contentType?.includes('application/json') ? await probe.json() : null;
const apiReady = Array.isArray(responseBody?.data ?? responseBody);
console.log(JSON.stringify({fixture: fixtureCode, requestAcl: 'PASS', attachmentsEndpoint: apiReady ? 'READY' : 'UNAVAILABLE', http: probe.status, contentType}));
if (!run) process.exit(0);
if (!apiReady) {
  console.error('Acceptance blocked before writes: the attachment list did not return successful JSON.');
  process.exit(2);
}

const root = await signIn(process.env.NOCOBASE_ADMIN_EMAIL ?? 'admin@nocobase.com', process.env.NOCOBASE_ADMIN_PASSWORD ?? 'admin123', 'root');
const suffix = randomUUID();
const code = 'STUDIO-ATTACH-' + suffix;
const draft = await nativeData('latticeRequests:create', requester, {values: {code, name: 'Request attachment acceptance'}});
console.log(JSON.stringify({fixture: code, requestId: draft.id}));
assert.equal(draft.status, 'draft');

async function reviewTasks() {
  const rows = await nativeData('workflowManualTasks:listMine?paginate=false&filter=' + filter({workflowId: lab.workflow.workflowId, nodeId: lab.workflow.nodeIds.review}), manager);
  const executions = await Promise.all(rows.map(row => nativeData('executions:get?filterByTk=' + row.executionId, root)));
  return executions.filter(execution => execution?.context?.data?.code === code).length;
}

async function expectTaskCount(expected, milliseconds) {
  const deadline = Date.now() + milliseconds;
  do {
    assert.equal(await reviewTasks(), expected, 'Unexpected review task count');
    await delay(250);
  } while (Date.now() < deadline);
}

const path = requestPath(draft.id);
await expectTaskCount(0, 2000);
const upload = {values: {filename: 'request-proof.txt', contentBase64: draftFile.toString('base64')}, key: randomUUID()};
async function attach() {
  const response = await call(gateway, path + '/attachments', requester, upload);
  assert([200, 201].includes(response.status), `Upload HTTP ${response.status}`);
  const body = await response.json();
  return body.data ?? body;
}
const attachment = await attach();
assert.match(attachment.fileId, /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i);
assert.equal((await attach()).fileId, attachment.fileId, 'Retry created a second file');
assert.equal(await reviewTasks(), 0, 'Attaching a file started review');

const submission = {values: {}, key: randomUUID()};
for (let attempt = 0; attempt < 2; attempt++) {
  const response = await call(gateway, path + '/submit', requester, submission);
  assert(response.ok, `Submit HTTP ${response.status}`);
}
const deadline = Date.now() + 20000;
while (await reviewTasks() === 0 && Date.now() < deadline) await delay(250);
await expectTaskCount(1, 2000);

const contentPath = path + '/attachments/' + attachment.fileId + '/content';
async function expectContent(actor) {
  const deadline = Date.now() + 20000;
  while (true) {
    const response = await call(gateway, contentPath, actor);
    if (response.status === 200) {
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), draftFile);
      return;
    }
    assert(response.status === 409 && Date.now() < deadline, `Download HTTP ${response.status}`);
    await delay(250);
  }
}
async function expectDenied(actor) {
  const response = await call(gateway, contentPath, actor);
  assert([403, 404].includes(response.status), `Expected download denial, got HTTP ${response.status}`);
}
await expectContent(manager);
await expectDenied(warehouse);

const email = suffix + '@example.invalid';
const secret = randomUUID();
const user = await nativeData('users:create', root, {values: {username: suffix, email, password: secret, roles: ['ldx_manager']}});
let employee;
try {
  employee = await nativeData('latticeEmployees:create', root, {values: {code: suffix, name: 'Temporary attachment reader', organizationId: lab.organizationId, userId: user.id, active: true}});
  const reader = await signIn(email, secret, 'ldx_manager');
  await expectContent(reader);
  await nativeData('latticeEmployees:update?filterByTk=' + employee.id, root, {values: {active: false}});
  await expectDenied(reader);
} finally {
  if (employee) await nativeData('latticeEmployees:destroy?filterByTk=' + employee.id, root, {method: 'POST'});
  await nativeData('users:destroy?filterByTk=' + user.id, root, {method: 'POST'});
}
console.log(JSON.stringify({result: 'PASS', requestId: draft.id, fileId: attachment.fileId, checks: ['single_review_task', 'manager_download', 'warehouse_denied', 'revoked_reader_denied']}));
