/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, expect, test } from 'vitest';
import { createWorker } from './app.js';

const workers: ReturnType<typeof createWorker>[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map((w) => w.close()));
});

test('GET /health returns demo status', async () => {
  const worker = createWorker();
  workers.push(worker);
  const res = await worker.inject({ method: 'GET', url: '/health' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ status: 'ok', service: 'agent-worker', mode: 'demo' });
});

test('POST /run accepts valid message and trims whitespace', async () => {
  const worker = createWorker();
  workers.push(worker);
  const res = await worker.inject({ method: 'POST', url: '/run', payload: { message: '  Xin chào  ' } });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ mode: 'demo', summary: 'Đã nhận yêu cầu: Xin chào' });
});

test('POST /run rejects invalid inputs and malformed JSON with 400', async () => {
  const worker = createWorker();
  workers.push(worker);
  for (const payload of [{ message: '' }, { message: '   ' }, { message: 'x'.repeat(2001) }, { message: 123 }, {}, null]) {
    const res = await worker.inject({ method: 'POST', url: '/run', payload });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Nhập yêu cầu từ 1 đến 2000 ký tự.' });
  }
  const badJson = await worker.inject({
    method: 'POST',
    url: '/run',
    headers: { 'content-type': 'application/json' },
    payload: '{bad-json',
  });
  expect(badJson.statusCode).toBe(400);
});

test('POST /run enforces 16 KiB bodyLimit and unknown routes return 404', async () => {
  const worker = createWorker();
  workers.push(worker);
  const big = await worker.inject({
    method: 'POST',
    url: '/run',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ message: 'a'.repeat(17_000) }),
  });
  expect(big.statusCode).toBe(413);

  const missing = await worker.inject({ method: 'GET', url: '/missing' });
  expect(missing.statusCode).toBe(404);
});

test('worker listens on real TCP socket and closes cleanly', async () => {
  const worker = createWorker();
  workers.push(worker);
  const url = await worker.listen({ host: '127.0.0.1', port: 0 });
  expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

  const health = await fetch(new URL('/health', url));
  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({ status: 'ok', service: 'agent-worker', mode: 'demo' });

  const run = await fetch(new URL('/run', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'Kiểm tra HTTP thật' }),
  });
  expect(run.status).toBe(200);
  expect(await run.json()).toEqual({ mode: 'demo', summary: 'Đã nhận yêu cầu: Kiểm tra HTTP thật' });

  const bigOverWire = await fetch(new URL('/run', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'a'.repeat(17_000) }),
  });
  expect(bigOverWire.status).toBe(413);

  const multiSegmentOverWire = await fetch(new URL('/run', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'b'.repeat(131_072) }),
  });
  expect(multiSegmentOverWire.status).toBe(413);

  await worker.close();
  // Calling close on an unstarted worker also resolves cleanly
  const unstarted = createWorker();
  await expect(unstarted.close()).resolves.toBeUndefined();
});
