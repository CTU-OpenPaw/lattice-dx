// SPDX-License-Identifier: Apache-2.0
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { drainOne, sendHttpEvent, startOutboxWorker } from './outbox.js';
import type { OutboxJob, WorkflowJobs } from './types.js';

const job: OutboxJob = {
  id: 'job', runId: 'run', organizationId: 'org', attempts: 1, leaseToken: 'lease',
  payload: { eventId: 'event', eventType: 'handover', runId: 'run', recordId: 'run', organizationId: 'org', definitionId: 'procurement', version: 1, occurredAt: '2026-10-12T00:00:00Z', data: {} },
};
const servers: Server[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
async function receiver(status: number, received: (headers: Record<string, unknown>, body: string) => void = () => {}) {
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      received(request.headers, body);
      response.writeHead(status, { location: '/redirected' });
      response.end('private receiver response');
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing receiver address');
  return `http://127.0.0.1:${address.port}`;
}
function repository(): WorkflowJobs {
  return { claim: vi.fn(async () => job), succeed: vi.fn(async () => {}), fail: vi.fn(async () => {}) };
}
describe('outbox delivery', () => {
  it('sends the same event and idempotency key on repeated delivery', async () => {
    const received: { headers: Record<string, unknown>; body: string }[] = [];
    const url = await receiver(204, (headers, body) => received.push({ headers, body }));
    await sendHttpEvent(job, url, 'secret');
    await sendHttpEvent(job, url, 'secret');
    expect(received).toHaveLength(2);
    for (const request of received) {
      expect(request.headers.authorization).toBe('Bearer secret');
      expect(request.headers['idempotency-key']).toBe('event');
      expect(JSON.parse(request.body)).toEqual(job.payload);
    }
  });
  it.each([503, 302])('rejects HTTP %s without disclosing receiver details', async status => {
    const url = await receiver(status);
    await expect(sendHttpEvent(job, url, 'secret')).rejects.toThrow('Workflow event delivery failed');
  });
  it('requires the credential', async () => {
    await expect(sendHttpEvent(job, 'http://127.0.0.1', '')).rejects.toThrow('Workflow connector token is required');
  });
  it('times out a receiver that does not respond', async () => {
    const server = createServer(() => {});
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing receiver address');
    await expect(sendHttpEvent(job, `http://127.0.0.1:${address.port}`, 'secret'))
      .rejects.toThrow('Workflow event delivery failed');
  }, 15_000);
  it('records delivery failure with a safe generic message', async () => {
    const jobs = repository();
    await drainOne(jobs, async () => { throw new Error('secret and private body'); });
    expect(jobs.fail).toHaveBeenCalledWith(job, 'Workflow event delivery failed');
    expect(jobs.succeed).not.toHaveBeenCalled();
  });
  it('completes only after delivery and does nothing when empty', async () => {
    const jobs = repository();
    const send = vi.fn(async () => {});
    await drainOne(jobs, send);
    expect(jobs.succeed).toHaveBeenCalledWith(job);
    vi.mocked(jobs.claim).mockResolvedValue(undefined);
    await drainOne(jobs, send);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('allows one outstanding send and waits for it during shutdown', async () => {
    vi.useFakeTimers();
    const jobs = repository();
    let finish!: () => void;
    const send = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const worker = startOutboxWorker(jobs, send, 10);
    await vi.advanceTimersByTimeAsync(100);
    expect(send).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stopping = worker.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish();
    await stopping;
    await vi.advanceTimersByTimeAsync(100);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('recovers on the next poll after an unexpected repository error', async () => {
    vi.useFakeTimers();
    const jobs = repository();
    vi.mocked(jobs.claim).mockRejectedValueOnce(new Error('private database connection'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const send = vi.fn(async () => {});
    const worker = startOutboxWorker(jobs, send, 10);
    try {
      await vi.advanceTimersByTimeAsync(20);
      expect(send).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith('Workflow outbox poll failed');
    } finally {
      await worker.stop();
      log.mockRestore();
    }
  });
});
