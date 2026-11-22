/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { createApi } from '../apps/api/src/app';
import { createWorker } from '../apps/agent-worker/src/app';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const identity = { key: async () => publicKey, issuer: 'https://identity.test', audience: 'dx-api' };
async function authHeaders(organizationId = 'org-a') {
  const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const header = b64url({ alg: 'RS256', typ: 'JWT' });
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url({
    sub: 'alice',
    iss: 'https://identity.test',
    aud: 'dx-api',
    exp: now + 300,
    organization_id: organizationId,
    realm_access: { roles: ['records:read'] },
  });
  const sig = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKey, 'base64url');
  return { authorization: `Bearer ${header}.${payload}.${sig}` };
}

const servers: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); });

test('API rejects unauthenticated /v1/agent/demo, sets security headers, and sanitizes 500s', async () => {
  const unconfigured = createApi({ workerUrl: 'http://127.0.0.1:1' }); servers.push(unconfigured);
  const res503 = await unconfigured.inject({ method: 'POST', url: '/v1/agent/demo', payload: { message: 'hello' } });
  expect(res503.statusCode).toBe(503);
  expect(res503.headers['x-content-type-options']).toBe('nosniff');
  expect(res503.headers['x-frame-options']).toBe('DENY');

  const api = createApi({ workerUrl: 'http://127.0.0.1:1', identity }); servers.push(api);
  const unauth = await api.inject({ method: 'POST', url: '/v1/agent/demo', payload: { message: 'hello' } });
  expect(unauth.statusCode).toBe(401);

  const boomApi = createApi({ workerUrl: 'http://127.0.0.1:1', identity }); servers.push(boomApi);
  boomApi.get('/v1/test-boom', async () => { throw new Error('SELECT * FROM secret_table FAILED'); });
  const boom = await boomApi.inject({ url: '/v1/test-boom' });
  expect(boom.statusCode).toBe(500);
  expect(JSON.stringify(boom.json())).not.toContain('secret_table');
});

test('API forwards a valid request to a real worker over HTTP', async () => {
  const worker = createWorker(); servers.push(worker);
  const workerUrl = await worker.listen({ host: '127.0.0.1', port: 0 });
  const api = createApi({ workerUrl, identity }); servers.push(api);
  const response = await api.inject({ method: 'POST', url: '/v1/agent/demo', headers: await authHeaders(), payload: { message: '  Kiểm tra kết nối  ' } });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ mode: 'demo', summary: 'Đã nhận yêu cầu: Kiểm tra kết nối' });
});

test.each([
  { label: 'empty', message: '' }, { label: 'whitespace', message: '   ' },
  { label: 'too long', message: 'x'.repeat(2001) }, { label: 'number', message: 42 }, { label: 'null', message: null },
])('API rejects $label input', async ({ message }) => {
  const api = createApi({ workerUrl: 'http://127.0.0.1:1', identity }); servers.push(api);
  const response = await api.inject({ method: 'POST', url: '/v1/agent/demo', headers: await authHeaders(), payload: { message } });
  expect(response.statusCode).toBe(400);
});

test('API reports worker unavailability without leaking internal errors', async () => {
  const api = createApi({ workerUrl: 'http://127.0.0.1:1', timeoutMs: 100, identity }); servers.push(api);
  const response = await api.inject({ method: 'POST', url: '/v1/agent/demo', headers: await authHeaders(), payload: { message: 'Kiểm tra' } });
  expect(response.statusCode).toBe(503);
  expect(response.json()).toEqual({ error: 'Agent worker chưa sẵn sàng. Vui lòng thử lại.' });
});

test('worker validates requests even when called directly', async () => {
  const worker = createWorker(); servers.push(worker);
  const response = await worker.inject({ method: 'POST', url: '/run', payload: { message: ' ' } });
  expect(response.statusCode).toBe(400);
});
