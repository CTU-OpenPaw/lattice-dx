// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApi } from '../apps/api/src/app';
import { createWorker } from '../apps/agent-worker/src/app';

const servers: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); });

test('API forwards a valid request to a real worker over HTTP', async () => {
  const worker = createWorker(); servers.push(worker);
  const workerUrl = await worker.listen({ host: '127.0.0.1', port: 0 });
  const api = createApi({ workerUrl }); servers.push(api);
  const response = await api.inject({ method: 'POST', url: '/v1/agent/demo', payload: { message: '  Kiểm tra kết nối  ' } });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ mode: 'demo', summary: 'Đã nhận yêu cầu: Kiểm tra kết nối' });
});

test.each([
  { label: 'empty', message: '' }, { label: 'whitespace', message: '   ' },
  { label: 'too long', message: 'x'.repeat(2001) }, { label: 'number', message: 42 }, { label: 'null', message: null },
])('API rejects $label input', async ({ message }) => {
  const api = createApi({ workerUrl: 'http://127.0.0.1:1' }); servers.push(api);
  const response = await api.inject({ method: 'POST', url: '/v1/agent/demo', payload: { message } });
  expect(response.statusCode).toBe(400);
});

test('API reports worker unavailability without leaking internal errors', async () => {
  const api = createApi({ workerUrl: 'http://127.0.0.1:1', timeoutMs: 100 }); servers.push(api);
  const response = await api.inject({ method: 'POST', url: '/v1/agent/demo', payload: { message: 'Kiểm tra' } });
  expect(response.statusCode).toBe(503);
  expect(response.json()).toEqual({ error: 'Agent worker chưa sẵn sàng. Vui lòng thử lại.' });
});

test('worker validates requests even when called directly', async () => {
  const worker = createWorker(); servers.push(worker);
  const response = await worker.inject({ method: 'POST', url: '/run', payload: { message: ' ' } });
  expect(response.statusCode).toBe(400);
});
