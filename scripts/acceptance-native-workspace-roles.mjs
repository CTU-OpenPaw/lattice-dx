// SPDX-License-Identifier: Apache-2.0
// Persistent fixtures for manual browser acceptance; restricted to the isolated
// local runtime. Existing users, role resource permissions and workflows are untouched.
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {instantiateNativePage} from './lib/native-ui-fixture.mjs';

const origin = process.env.NOCOBASE_URL ?? 'http://localhost:13001';
const host = new URL(origin);
assert.ok(host.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(host.hostname));
const dbContainer = process.env.NOCOBASE_DB_CONTAINER;
assert.ok(dbContainer && dbContainer !== 'lattice-dx-nocobase-db-1', 'Explicit isolated DB container required');
assert.notEqual(host.port, '13000', 'Do not seed the regular local runtime');
const organizationId = 'native-workspace-roles-lab';
const manifestPath = 'output/native-platform/workspace-roles-lab.json';
const roles = ['employee', 'manager', 'warehouse', 'dispatcher', 'driver', 'director', 'admin'];
const filter = value => 'filter=' + encodeURIComponent(JSON.stringify(value));
async function call(path, {token, role, method = 'GET', values} = {}) {
  const response = await fetch(new URL('/api/' + path, host), {
    method, headers: {'content-type': 'application/json',
      ...(token ? {authorization: 'Bearer ' + token} : {}), ...(role ? {'X-Role': role} : {})},
    ...(values !== undefined ? {body: JSON.stringify(values)} : {}), signal: AbortSignal.timeout(15000),
  });
  return {status: response.status, body: await response.json()};
}
async function ok(path, options) {
  const result = await call(path, options);
  assert.ok(result.status < 300, `${path.split('?')[0]} HTTP ${result.status}: ${JSON.stringify(result.body.errors)}`);
  return result.body.data;
}
const token = (await ok('auth:signIn', {method: 'POST', values: {
  email: process.env.NOCOBASE_ADMIN_EMAIL ?? 'admin@nocobase.com',
  password: process.env.NOCOBASE_ADMIN_PASSWORD ?? 'admin123',
}})).token;
const root = (path, options) => ok(path, {...options, token});
let manifest;
try {manifest = JSON.parse(await readFile(manifestPath, 'utf8'));}
catch (error) {if (error.code !== 'ENOENT') throw error;}
if (!manifest) {
  const backup = spawnSync('docker', ['exec', dbContainer, 'pg_dump', '--format=custom', '-U', 'nocobase', '-d', 'nocobase'],
    {encoding: null, maxBuffer: 256 * 1024 * 1024, windowsHide: true});
  assert.equal(backup.status, 0, 'Database backup required');
  assert.equal(backup.stdout.subarray(0, 5).toString(), 'PGDMP');
  await mkdir('output/backups', {recursive: true});
  await mkdir('output/native-platform', {recursive: true});
  const backupPath = `output/backups/workspace-roles-${randomUUID()}.dump`;
  await writeFile(backupPath, backup.stdout, {flag: 'wx'});
  manifest = {origin: host.origin, organizationId, backupPath, accounts: [], documents: {}, pages: {}};
}
assert.equal(manifest.origin, host.origin);
assert.equal(manifest.organizationId, organizationId);
const save = () => writeFile(manifestPath, JSON.stringify(manifest, null, 2));
await save();
for (const key of roles) {
  let account = manifest.accounts.find(account => account.key === key);
  if (!account) {
    const username = 'native.workspace.' + key, email = username + '@example.invalid';
    assert.equal((await root('users:list?' + filter({username}))).length, 0, 'Do not overwrite a user outside this manifest');
    const user = await root('users:create', {method: 'POST', values: {
      username, email, nickname: 'Workspace lab — ' + key, password: 'NativeLab-2026!', roles: ['ldx_' + key],
    }});
    account = {key, role: 'ldx_' + key, username, email, userId: user.id};
    manifest.accounts.push(account); await save();
  }
  if (!account.employeeId) {
    const employee = await root('latticeEmployees:create', {method: 'POST', values: {
      code: 'WS-' + key.toUpperCase(), name: 'Workspace lab — ' + key, organizationId,
      userId: account.userId, active: true,
    }});
    account.employeeId = employee.id; await save();
  }
  if (!manifest.documents[key]) {
    const row = await root('latticeRequests:create', {method: 'POST', values: {
      organizationId, requesterId: account.employeeId, code: 'WS-' + key.toUpperCase(),
      name: 'Hồ sơ của ' + key, status: 'draft',
    }});
    manifest.documents[key] = row.id; await save();
  }
}
if (!manifest.documents.assigned) {
  const row = await root('latticeRequests:create', {method: 'POST', values: {
    organizationId, requesterId: manifest.accounts[0].employeeId,
    assigneeId: manifest.accounts.find(account => account.key === 'driver').employeeId,
    code: 'WS-ASSIGNED-DRIVER', name: 'Hồ sơ được giao cho tài xế', status: 'assigned',
  }});
  manifest.documents.assigned = row.id; await save();
}
if (!manifest.documents.foreign) {
  const row = await root('latticeRequests:create', {method: 'POST', values: {
    organizationId: organizationId + '-other', code: 'WS-FOREIGN', name: 'Hồ sơ tổ chức khác', status: 'draft',
  }});
  manifest.documents.foreign = row.id; await save();
}
for (const [key, title] of [['allowed', 'Kiểm thử quyền Workspace'], ['denied', 'Trang chưa được cấp quyền']]) {
  if (!manifest.pages[key]) {
    const template = JSON.parse(await readFile(new URL('./fixtures/native-ui-page.json', import.meta.url), 'utf8'));
    const schemaUid = 'workspaceroles' + randomUUID().replaceAll('-', '').slice(0, 10);
    const {schema, tabUid} = instantiateNativePage(template, schemaUid);
    await root('uiSchemas:insert', {method: 'POST', values: schema});
    const route = await root('desktopRoutes:create', {method: 'POST', values: {title, type: 'page', schemaUid, enableTabs: false}});
    manifest.pages[key] = {routeId: route.id, path: '/admin/' + schemaUid, tabUid}; await save();
  }
  const page = manifest.pages[key];
  if (!page.tabId) {
    const tab = await root('desktopRoutes:create', {method: 'POST', values: {
      parentId: page.routeId, type: 'tabs', schemaUid: page.tabUid, tabSchemaName: page.tabUid + 'name', hidden: true,
    }});
    page.tabId = tab.id; await save();
  }
}
// Only this explicitly named test page is added; existing grants are preserved.
for (const key of roles) await root(`roles/ldx_${key}/desktopRoutes:add`, {method: 'POST', values: {
  tk: [manifest.pages.allowed.routeId, manifest.pages.allowed.tabId],
}});

const results = [];
for (const account of manifest.accounts) {
  const session = await ok('auth:signIn', {method: 'POST', values: {email: account.email, password: 'NativeLab-2026!'}});
  const auth = {token: session.token, role: account.role};
  const check = (path, options) => ok(path, {...options, ...auth});
  assert.equal((await check('latticeNative:context')).organizationId, organizationId);
  const broad = ['manager', 'dispatcher', 'director', 'admin'].includes(account.key);
  const expected = (broad ? roles.map(key => manifest.documents[key]) : [manifest.documents[account.key]])
    .concat(broad || account.key === 'employee' || account.key === 'driver' ? [manifest.documents.assigned] : []).map(String).sort();
  const rows = await check('latticeRequests:list?paginate=false&' + filter({id: {$in: Object.values(manifest.documents)}}));
  assert.deepEqual(rows.map(row => String(row.id)).sort(), expected, account.role + ': exact record scope');
  const foreign = await call('latticeRequests:get?filterByTk=' + manifest.documents.foreign, auth);
  assert.ok(foreign.status === 404 || foreign.status === 200 && !foreign.body.data, account.role + ': foreign detail hidden');
  if (!broad) {
    const peer = await check('latticeRequests:get?filterByTk=' + manifest.documents.manager);
    assert.ok(!peer?.id, account.role + ': peer record hidden');
  }
  const own = manifest.documents[account.key];
  if (account.key === 'director') {
    assert.equal((await call('latticeRequests:create', {...auth, method: 'POST', values: {name: 'Denied', code: randomUUID()}})).status, 403);
    assert.equal((await call('latticeRequests:update?filterByTk=' + own, {...auth, method: 'POST', values: {description: 'Denied'}})).status, 403);
  } else {
    await check('latticeRequests:update?filterByTk=' + own, {method: 'POST', values: {description: 'Workspace scope verified'}});
    assert.equal((await call('latticeRequests:update?filterByTk=' + manifest.documents.assigned,
      {...auth, method: 'POST', values: {description: 'Late edit denied'}})).status, 403);
  }
  for (const values of [{status: 'completed'}, {organizationId: organizationId + '-other'}]) {
    assert.equal((await call('latticeRequests:update?filterByTk=' + own, {...auth, method: 'POST', values})).status, 403);
  }
  assert.equal((await call('latticeRequests:destroy?filterByTk=' + own, {...auth, method: 'POST'})).status, 403);
  assert.equal((await call('latticeEmployees:update?filterByTk=' + account.employeeId,
    {...auth, method: 'POST', values: {organizationId: organizationId + '-other'}})).status, 403);
  await check('auth:signOut', {method: 'POST'});
  results.push({role: account.role, visibleRecords: expected.length, writeMode: account.key === 'director' ? 'read-only' : 'own-draft-only', result: 'PASS'});
}
await writeFile('output/native-platform/workspace-roles-acceptance.json', JSON.stringify({at: new Date().toISOString(), origin: host.origin,
  scope: 'Real HTTP identity, record scopes and protected writes; browser role/menu/action checks are recorded separately.', results}, null, 2));
console.log(JSON.stringify({result: 'PASS', path: manifest.pages.allowed.path, deniedPath: manifest.pages.denied.path, results}));
