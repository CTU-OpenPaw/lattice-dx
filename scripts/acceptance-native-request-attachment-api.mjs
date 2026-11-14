/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { configureNativeProcess } from './configure-native-process.mjs';

const origin = new URL(process.env.NOCOBASE_URL ?? 'http://localhost:13001');
assert(['localhost', '127.0.0.1'].includes(origin.hostname), 'Local acceptance only');
const suffix = randomUUID();
const organizationId = process.env.DX_NATIVE_ATTACHMENT_SUBMIT_ORGANIZATION ?? 'native-attachment-submit-lab';
const fixtures = [];
let workflow;

async function withBlockedSharedInsert(work) {
  const container = process.env.DX_NATIVE_UPLOAD_TEST_DATABASE_CONTAINER;
  assert(/^lattice-native-[a-z0-9-]+-postgres-1$/.test(container ?? ''), 'Use an explicit isolated native test PostgreSQL container');
  const lock = spawn('docker', ['exec', '-i', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'lattice', '-d', 'lattice', '-At'],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  let failure;
  const closed = new Promise(resolve => lock.once('close', resolve));
  lock.on('error', error => { failure = error; });
  lock.stdin.on('error', error => { failure = error; });
  lock.stdout.on('data', chunk => { output += chunk.toString(); });
  lock.stderr.on('data', () => {});
  const watchdog = setTimeout(() => lock.kill(), 55000);
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    if (lock.exitCode === null && !lock.killed) lock.stdin.end('COMMIT;\n');
    await closed;
  };
  try {
    lock.stdin.write("BEGIN;\nLOCK TABLE foundation_files IN SHARE MODE;\nSELECT 'LOCKED';\n");
    const deadline = Date.now() + 5000;
    while (!output.includes('LOCKED')) {
      if (failure || lock.exitCode !== null || Date.now() > deadline) throw Error('Could not acquire isolated shared-file fixture lock');
      await delay(50);
    }
    return await work(release);
  } finally {
    await release();
    clearTimeout(watchdog);
  }
}

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
  const checks = ['scan_and_download_bytes', 'concurrent_retry', 'rejected_file_not_listed', 'one_review_task', 'wrong_request_denied', 'unrelated_and_foreign_users_denied', 'revocation_denied'];
  if (process.argv.includes('--shared-upload-recovery')) {
    const recoveryPath = action => path(action, other.id);
    const pending = { values: { filename: 'late-proof.txt', contentBase64: Buffer.from('native timeout recovery proof\n').toString('base64') }, key: randomUUID() };
    await withBlockedSharedInsert(async release => {
      assert.equal((await call(recoveryPath('upload'), requester, pending)).status, 503);
      assert.equal((await call(recoveryPath('submit'), requester, { values: {} })).status, 409, 'Timed-out upload allowed submit');
      assert.equal((await call(recoveryPath('upload'), requester, { ...pending, values: { ...pending.values, filename: 'changed.txt' } })).status, 409);
      await data('latticeEmployees:update?filterByTk=' + requester.profileId, root, { values: { active: false } });
      assert.equal((await call(recoveryPath('upload'), requester, pending)).status, 403);
      await data('latticeEmployees:update?filterByTk=' + requester.profileId, root, { values: { active: true } });
      await release();
    });
    const deadline = Date.now() + 15000;
    let lateFiles;
    while (Date.now() < deadline) {
      lateFiles = await data(recoveryPath('list'), requester);
      if (lateFiles.length) break;
      await delay(100);
    }
    assert.equal(lateFiles.length, 1);
    assert.equal((await call(recoveryPath('submit'), requester, { values: {} })).status, 409, 'Late shared commit bypassed reconciliation');
    const replay = await data(recoveryPath('upload'), requester, { ...pending, key: randomUUID() });
    assert.equal(replay.fileId, lateFiles[0].fileId, 'Reload retry created a new shared file');
    assert.equal((await data(recoveryPath('list'), requester)).length, 1);
    await data('latticeEmployees:update?filterByTk=' + manager.profileId, root, { values: { active: true } });
    const recovered = await Promise.all([call(recoveryPath('submit'), requester, { values: {} }), call(recoveryPath('submit'), requester, { values: {} })]);
    assert.deepEqual(recovered.map(response => response.status), [200, 200]);
    const tasksDeadline = Date.now() + 20000;
    while ((await reviewTasks()).length < 2 && Date.now() < tasksDeadline) await delay(100);
    const recoveredTasks = await reviewTasks();
    assert.equal(recoveredTasks.length, 2, 'Recovered request created duplicate review tasks');
    let matched = 0;
    for (const task of recoveredTasks) {
      const execution = await data('executions:get?filterByTk=' + task.executionId, root);
      if (String(execution.context.data.id) === String(other.id)) matched++;
    }
    assert.equal(matched, 1);
    checks.push('timeout_blocks_submit_before_and_after_late_commit', 'changed_payload_and_revoked_actor_cannot_reconcile', 'reload_retry_reuses_canonical_key_and_file', 'recovered_concurrent_submit_creates_one_task');
  }
  console.log(JSON.stringify({ result: 'PASS', checks }));
} finally {
  if (workflow) {
    await data('workflows:update?filterByTk=' + workflow.workflowId, root, { values: { enabled: false } });
    await data('workflows:destroy?filterByTk=' + workflow.workflowId, root, { method: 'POST' });
  }
  for (const { resource, id } of fixtures.reverse()) {
    await data(resource + ':destroy?filterByTk=' + id, root, { method: 'POST' });
  }
}
