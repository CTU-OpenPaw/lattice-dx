/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const REPO_ROOT = resolve(__dirname, '../../../..');

function makeN8nTestDb() {
  const connectors = [];
  const roles = [
    { name: 'root', allowAll: true, allowConfigure: true, snippets: ['pm', 'pm.*'] },
    { name: 'ldx_admin', allowConfigure: true, snippets: ['pm.*'] },
    { name: 'admin', allowConfigure: true, snippets: ['pm.*'] },
    { name: 'ldx_employee', allowConfigure: false, snippets: [] },
    { name: 'ldx_operator', allowConfigure: false, snippets: [] },
  ];
  const rolesUsers = [
    { userId: 1, roleName: 'root' },
    { userId: 10, roleName: 'ldx_admin' },
    { userId: 11, roleName: 'admin' },
    { userId: 20, roleName: 'ldx_employee' },
    { userId: 21, roleName: 'ldx_operator' },
    { userId: 30, roleName: 'ldx_admin' },
  ];
  const employees = [
    { id: 100, userId: 10, organizationId: 'org-a', active: true, code: 'ADM-A', name: 'Admin A' },
    { id: 110, userId: 11, organizationId: 'org-a', active: true, code: 'ADM-A2', name: 'Admin A2' },
    { id: 200, userId: 20, organizationId: 'org-a', active: true, code: 'EMP-A', name: 'Emp A' },
    { id: 210, userId: 21, organizationId: 'org-a', active: true, code: 'OP-A', name: 'Op A' },
    { id: 300, userId: 30, organizationId: 'org-b', active: true, code: 'ADM-B', name: 'Admin B' },
  ];
  let seq = 1;

  const match = (row, filter = {}) => Object.entries(filter || {}).every(([k, cond]) => {
    if (k === '$and' && Array.isArray(cond)) return cond.every((sub) => match(row, sub));
    if (k === '$or' && Array.isArray(cond)) return cond.some((sub) => match(row, sub));
    if (cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)) {
      if (Array.isArray(cond.$in)) return cond.$in.includes(row[k]);
      if (Object.hasOwn(cond, '$eq')) return row[k] === cond.$eq;
      if (Object.hasOwn(cond, '$ne')) return row[k] !== cond.$ne;
    }
    return row[k] === cond;
  });

  const wrap = (row) => (row ? {
    ...row,
    toJSON: () => ({ ...row }),
    get: (k) => row[k],
    update: async (patch) => {
      Object.assign(row, patch, { updatedAt: new Date().toISOString() });
      return wrap(row);
    },
  } : null);

  const makeRepo = (list) => ({
    find: async ({ filter } = {}) => list.filter((r) => match(r, filter)).map(wrap),
    findOne: async ({ filter, filterByTk } = {}) => {
      if (filterByTk != null && !filter) return wrap(list.find((r) => Number(r.id) === Number(filterByTk)));
      return wrap(list.find((r) => match(r, filter)) || null);
    },
    create: async ({ values }) => {
      const row = { id: seq++, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...values };
      list.push(row);
      return wrap(row);
    },
    update: async ({ filterByTk, filter, values } = {}) => {
      const targets = list.filter((r) => (filterByTk != null ? Number(r.id) === Number(filterByTk) : true) && (!filter || match(r, filter)));
      for (const t of targets) Object.assign(t, values, { updatedAt: new Date().toISOString() });
      return targets.map(wrap);
    },
  });

  const db = {
    sequelize: {
      getDialect: () => 'postgres',
      transaction: async (cb) => cb({ id: 'tx-n8n' }),
      query: async () => [[]],
    },
    getRepository(name) {
      if (name === 'roles') return makeRepo(roles);
      if (name === 'rolesUsers') return makeRepo(rolesUsers);
      if (name === 'latticeEmployees') return makeRepo(employees);
      if (name === 'latticeConnectors') return makeRepo(connectors);
      return null;
    },
  };
  return { db, connectors };
}

function makeCtx({ method = 'GET', state = {}, headers = {}, params = {}, query = {}, body = undefined } = {}) {
  return {
    method,
    headers: { ...headers },
    request: { headers: { ...headers }, ...(body !== undefined ? { body } : {}) },
    query,
    state: { ...state },
    action: { resourceName: params.resourceName || 'dxosN8n', actionName: params.actionName || '', params },
    get(k) { return this.headers[String(k).toLowerCase()] || ''; },
    throw(status, message, props) { throw Object.assign(new Error(message || `HTTP ${status}`), { status }, props || {}); },
  };
}

test('createN8nApiClient enforces Stock n8n v1 /api/v1/* paths, X-N8N-API-KEY, Idempotency-Key, SSRF allowlist, and credential sync', async () => {
  const { createN8nApiClient } = require('../src/server/n8n-api-client');

  // SSRF blocks metadata / loopback / RFC1918 even with DX_ALLOW_INTERNAL_CONNECTORS=true
  for (const unsafeBase of [
    'http://169.254.169.254',
    'http://127.0.0.1:5678',
    'http://localhost:5678',
    'http://10.0.0.8:5678',
    'http://192.168.1.5:5678',
  ]) {
    assert.throws(
      () => createN8nApiClient({
        baseUrl: unsafeBase,
        apiKey: 'n8n-secret-key',
        env: { NODE_ENV: 'production', DX_ALLOW_INTERNAL_CONNECTORS: 'true' },
      }),
      (err) => err.status === 400 && /UNSAFE/i.test(err.code || err.message),
      `Expected SSRF block for ${unsafeBase}`,
    );
  }

  const calls = [];
  const mockFetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', headers: init.headers || {}, body: init.body, redirect: init.redirect, hasSignal: Boolean(init.signal) });
    const parsed = new URL(url);
    if (parsed.pathname === '/healthz') {
      return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'ok' }) };
    }
    if (parsed.pathname === '/api/v1/workflows' && init.method === 'GET') {
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'wf-1', name: 'Cold Chain', active: true }] }) };
    }
    if (parsed.pathname === '/api/v1/workflows/wf-1' && init.method === 'GET') {
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'wf-1', name: 'Cold Chain', active: true, nodes: [] }) };
    }
    if (parsed.pathname === '/api/v1/workflows' && init.method === 'POST') {
      return { ok: true, status: 201, text: async () => JSON.stringify({ id: 'wf-2', name: 'New Flow', active: false }) };
    }
    if (parsed.pathname === '/api/v1/workflows/wf-2' && init.method === 'PUT') {
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'wf-2', name: 'Updated Flow', active: false }) };
    }
    if (parsed.pathname === '/api/v1/workflows/wf-2/activate' && init.method === 'POST') {
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'wf-2', active: true }) };
    }
    if (parsed.pathname === '/api/v1/workflows/wf-2/deactivate' && init.method === 'POST') {
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'wf-2', active: false }) };
    }
    if (parsed.pathname === '/api/v1/executions' && init.method === 'GET') {
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'exec-9', workflowId: 'wf-1', status: 'error' }] }) };
    }
    if (parsed.pathname === '/api/v1/executions/exec-9' && init.method === 'GET') {
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'exec-9', workflowId: 'wf-1', status: 'error', data: {} }) };
    }
    if (parsed.pathname === '/api/v1/executions/exec-9/retry' && init.method === 'POST') {
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'exec-10', retriedFrom: 'exec-9', finished: true }) };
    }
    if (parsed.pathname === '/api/v1/credentials' && init.method === 'GET') {
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'cred-1', name: 'Telegram', type: 'telegramApi' }] }) };
    }
    if (parsed.pathname === '/api/v1/credentials' && init.method === 'POST') {
      return { ok: true, status: 201, text: async () => JSON.stringify({ id: 'cred-77', name: 'Telegram Prod', type: 'telegramApi' }) };
    }
    return { ok: false, status: 404, text: async () => JSON.stringify({ message: 'Not found' }) };
  };

  const client = createN8nApiClient({
    baseUrl: 'http://n8n:5678',
    apiKey: 'n8n-api-secret-xyz',
    fetchFn: mockFetch,
    env: { NODE_ENV: 'production', DX_ALLOW_INTERNAL_CONNECTORS: 'true' },
  });

  const health = await client.healthCheck();
  assert.equal(health.ok, true);
  assert.equal(health.healthzOk, true);
  assert.equal(health.apiOk, true);

  const wfs = await client.listWorkflows({ active: true, limit: 20 });
  assert.equal(wfs.data.length, 1);
  assert.equal(wfs.data[0].id, 'wf-1');

  const wf = await client.getWorkflow('wf-1');
  assert.equal(wf.id, 'wf-1');

  const createdWf = await client.createWorkflow({ name: 'New Flow', nodes: [], connections: {}, settings: {} }, { idempotencyKey: 'idem-create-1' });
  assert.equal(createdWf.id, 'wf-2');

  const updatedWf = await client.updateWorkflow('wf-2', { name: 'Updated Flow', nodes: [], connections: {}, settings: {} });
  assert.equal(updatedWf.name, 'Updated Flow');

  const actWf = await client.activateWorkflow('wf-2', true);
  assert.equal(actWf.active, true);
  const deactWf = await client.activateWorkflow('wf-2', false);
  assert.equal(deactWf.active, false);

  const execs = await client.listExecutions({ workflowId: 'wf-1', status: 'error', limit: 10 });
  assert.equal(execs.data[0].id, 'exec-9');

  const execDetail = await client.getExecution('exec-9');
  assert.equal(execDetail.id, 'exec-9');

  const retried = await client.retryExecution('exec-9');
  assert.equal(retried.id, 'exec-10');

  const creds = await client.listCredentials();
  assert.equal(creds.data[0].id, 'cred-1');

  const createdCred = await client.createCredential({ name: 'Telegram Prod', type: 'telegramApi', data: { accessToken: 'tg-bot-secret' } });
  assert.equal(createdCred.id, 'cred-77');

  const syncRes = await client.syncConnectorCredentialToN8n({
    connector: { organizationId: 'org-a', connectorKey: 'tg-ops', name: 'Telegram Ops', appType: 'telegram', secretVersion: 2 },
    secrets: { botToken: 'tg-bot-secret-99' },
  });
  assert.equal(syncRes.synced, true);
  assert.equal(syncRes.n8nCredentialId, 'cred-77');
  assert.equal(JSON.stringify(syncRes).includes('tg-bot-secret-99'), false);

  // Verify X-N8N-API-KEY & Idempotency-Key & redirect:error on all mutating calls
  const apiCalls = calls.filter((c) => new URL(c.url).pathname.startsWith('/api/v1/'));
  assert.ok(apiCalls.length >= 10);
  for (const call of apiCalls) {
    assert.equal(call.headers['X-N8N-API-KEY'], 'n8n-api-secret-xyz');
    assert.equal(call.redirect, 'error');
    assert.equal(call.hasSignal, true);
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(call.method)) {
      assert.ok(call.headers['Idempotency-Key'], `Missing Idempotency-Key on ${call.method} ${call.url}`);
    }
  }
  const createCall = apiCalls.find((c) => c.method === 'POST' && new URL(c.url).pathname === '/api/v1/workflows');
  assert.equal(createCall.headers['Idempotency-Key'], 'idem-create-1');

  // Verify secret scrubbing on upstream error
  const failClient = createN8nApiClient({
    baseUrl: 'http://n8n:5678',
    apiKey: 'super-secret-n8n-key',
    env: { NODE_ENV: 'production', DX_ALLOW_INTERNAL_CONNECTORS: 'true' },
    fetchFn: async () => {
      throw new Error('upstream failed with super-secret-n8n-key');
    },
  });
  await assert.rejects(
    () => failClient.listWorkflows(),
    (err) => !String(err.message).includes('super-secret-n8n-key'),
  );
});

test('createN8nRouteHandlers exposes dxosN8n actions, enforces root/admin/ldx_admin RBAC, PAT scopes, cross-org isolation, and persists n8nCredentialId', async () => {
  const { createN8nRouteHandlers } = require('../src/server/n8n-api-client');
  const vault = require('../../plugin-lattice-foundation/src/server/connector-vault');
  const { db, connectors } = makeN8nTestDb();

  const vaultKeyEnv = {
    NODE_ENV: 'production',
    DX_VAULT_MASTER_KEY: 'n8n-route-test-vault-key',
    DX_ALLOW_INTERNAL_CONNECTORS: 'true',
  };

  // Seed n8n_api connector + telegram connector for org-a
  connectors.push({
    id: 1,
    organizationId: 'org-a',
    connectorKey: 'n8n-primary',
    name: 'Primary n8n',
    connectorType: 'n8n',
    appType: 'n8n_api',
    baseUrl: 'http://n8n:5678',
    authType: 'api_key',
    encryptedSecretsJson: vault.encryptVaultSecrets({ apiKey: 'org-a-n8n-key' }, vaultKeyEnv),
    secretVersion: 1,
    active: true,
  });
  connectors.push({
    id: 2,
    organizationId: 'org-a',
    connectorKey: 'tg-alerts',
    name: 'Telegram Alerts',
    connectorType: 'http_api',
    appType: 'telegram',
    baseUrl: 'https://api.telegram.org',
    authType: 'api_key',
    encryptedSecretsJson: vault.encryptVaultSecrets({ botToken: '123456:tg-secret' }, vaultKeyEnv),
    secretVersion: 1,
    active: true,
  });

  const n8nRequests = [];
  const { actions } = createN8nRouteHandlers(db, {
    env: vaultKeyEnv,
    fetchImpl: async (url, init = {}) => {
      n8nRequests.push({ url, method: init.method || 'GET', headers: init.headers || {}, body: init.body });
      const pathname = new URL(url).pathname;
      if (pathname === '/healthz') return { ok: true, status: 200, text: async () => '{"status":"ok"}' };
      if (pathname === '/api/v1/workflows' && init.method === 'GET') return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'wf-1', name: 'Flagship', active: true }] }) };
      if (pathname === '/api/v1/workflows/wf-1' && init.method === 'GET') return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'wf-1', name: 'Flagship', active: true }) };
      if (pathname === '/api/v1/workflows' && init.method === 'POST') return { ok: true, status: 201, text: async () => JSON.stringify({ id: 'wf-new', name: 'Created' }) };
      if (pathname === '/api/v1/workflows/wf-new' && init.method === 'PUT') return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'wf-new', name: 'Edited' }) };
      if (pathname === '/api/v1/workflows/wf-new/activate' && init.method === 'POST') return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'wf-new', active: true }) };
      if (pathname === '/api/v1/executions' && init.method === 'GET') return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'ex-1', status: 'error' }] }) };
      if (pathname === '/api/v1/executions/ex-1/retry' && init.method === 'POST') return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'ex-2', retried: true }) };
      if (pathname === '/api/v1/credentials' && init.method === 'POST') return { ok: true, status: 201, text: async () => JSON.stringify({ id: 'cred-sync-99', name: 'Telegram Alerts', type: 'telegramApi' }) };
      return { ok: false, status: 404, text: async () => '{}' };
    },
  });

  for (const requiredAction of [
    'status',
    'appCatalog',
    'workflows',
    'getWorkflow',
    'createWorkflow',
    'updateWorkflow',
    'activateWorkflow',
    'executions',
    'retryExecution',
    'syncCredential',
  ]) {
    assert.equal(typeof actions[requiredAction], 'function', `Missing dxosN8n action ${requiredAction}`);
  }

  // Unauthenticated 401
  await assert.rejects(
    () => actions.workflows(makeCtx({ method: 'GET', state: {} }), async () => {}),
    (err) => err.status === 401,
  );

  // Employee & Operator denied 403
  for (const [uid, role] of [[20, 'ldx_employee'], [21, 'ldx_operator']]) {
    await assert.rejects(
      () => actions.workflows(makeCtx({ method: 'GET', state: { currentUser: { id: uid }, currentRole: role } }), async () => {}),
      (err) => err.status === 403,
    );
    await assert.rejects(
      () => actions.createWorkflow(makeCtx({ method: 'POST', state: { currentUser: { id: uid }, currentRole: role }, params: { values: { name: 'x' } } }), async () => {}),
      (err) => err.status === 403,
    );
  }

  // Read-only PAT denied on mutating actions
  await assert.rejects(
    () => actions.createWorkflow(makeCtx({
      method: 'POST',
      state: { currentUser: { id: 10 }, currentRole: 'ldx_admin', latticeApiKey: { scopes: ['read'] } },
      params: { values: { name: 'x' } },
    }), async () => {}),
    (err) => err.status === 403 && err.code === 'API_KEY_SCOPE_INSUFFICIENT',
  );

  // Cross-org access denied 403
  await assert.rejects(
    () => actions.workflows(makeCtx({
      method: 'GET',
      state: { currentUser: { id: 30 }, currentRole: 'ldx_admin' },
      params: { organizationId: 'org-a' },
    }), async () => {}),
    (err) => err.status === 403 && err.code === 'NATIVE_ORGANIZATION_MISMATCH',
  );

  // ldx_admin, admin, and root succeed
  const catCtx = makeCtx({ method: 'GET', state: { currentUser: { id: 10 }, currentRole: 'ldx_admin' } });
  await actions.appCatalog(catCtx, async () => {});
  assert.equal(catCtx.body.items.length >= 11, true);

  const statusCtx = makeCtx({ method: 'GET', state: { currentUser: { id: 11 }, currentRole: 'admin' } });
  await actions.status(statusCtx, async () => {});
  assert.equal(statusCtx.body.ok, true);

  const rootWfCtx = makeCtx({ method: 'GET', state: { currentUser: { id: 1 }, currentRole: 'root' }, params: { organizationId: 'org-a' } });
  await actions.workflows(rootWfCtx, async () => {});
  assert.equal(rootWfCtx.body.data[0].id, 'wf-1');

  const createCtx = makeCtx({
    method: 'POST',
    state: { currentUser: { id: 10 }, currentRole: 'ldx_admin' },
    params: { values: { workflow: { name: 'Created', nodes: [], connections: {} } } },
  });
  await actions.createWorkflow(createCtx, async () => {});
  assert.equal(createCtx.body.id, 'wf-new');

  const actCtx = makeCtx({
    method: 'POST',
    state: { currentUser: { id: 10 }, currentRole: 'ldx_admin' },
    params: { values: { workflowId: 'wf-new', active: true } },
  });
  await actions.activateWorkflow(actCtx, async () => {});
  assert.equal(actCtx.body.active, true);

  const retryCtx = makeCtx({
    method: 'POST',
    state: { currentUser: { id: 10 }, currentRole: 'ldx_admin' },
    params: { values: { executionId: 'ex-1' } },
  });
  await actions.retryExecution(retryCtx, async () => {});
  assert.equal(retryCtx.body.id, 'ex-2');

  const syncCtx = makeCtx({
    method: 'POST',
    state: { currentUser: { id: 10 }, currentRole: 'ldx_admin' },
    params: { values: { connectorKey: 'tg-alerts' } },
  });
  await actions.syncCredential(syncCtx, async () => {});
  assert.equal(syncCtx.body.synced, true);
  assert.equal(syncCtx.body.n8nCredentialId, 'cred-sync-99');
  assert.equal(connectors[1].n8nCredentialId, 'cred-sync-99');
  assert.equal(JSON.stringify(syncCtx.body).includes('123456:tg-secret'), false);
  assert.equal(JSON.stringify(syncCtx.body).includes('org-a-n8n-key'), false);

  const { addSourceHeader } = await import(pathToFileURL(join(REPO_ROOT, 'scripts/source-headers.mjs')).href);
  for (const rel of [
    'plugins/nocobase/plugin-dxos-studio/src/server/n8n-api-client.js',
    'plugins/nocobase/plugin-dxos-studio/tests/n8n-api-client.test.cjs',
  ]) {
    const res = addSourceHeader(readFileSync(join(REPO_ROOT, rel), 'utf8'), rel);
    assert.equal(res.status, 'present', `${rel} missing valid SPDX header`);
  }
});
