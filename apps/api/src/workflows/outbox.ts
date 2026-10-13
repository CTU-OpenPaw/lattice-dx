// SPDX-License-Identifier: Apache-2.0
import type { OutboxJob, WorkflowJobs } from './types.js';

export async function sendHttpEvent(job: OutboxJob, url: string, token: string): Promise<void> {
  if (!token.trim()) throw new Error('Workflow connector token is required');
  try {
    const response = await fetch(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Idempotency-Key': job.payload.eventId },
      body: JSON.stringify(job.payload),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error('Rejected delivery');
  } catch {
    throw new Error('Workflow event delivery failed');
  }
}

export async function drainOne(jobs: WorkflowJobs, send: (job: OutboxJob) => Promise<void>): Promise<void> {
  const job = await jobs.claim();
  if (!job) return;
  try {
    await send(job);
  } catch {
    await jobs.fail(job, 'Workflow event delivery failed');
    return;
  }
  await jobs.succeed(job);
}

export function startOutboxWorker(jobs: WorkflowJobs, send: (job: OutboxJob) => Promise<void>, intervalMs = 1000): { stop(): Promise<void> } {
  let flight: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (flight) return;
    flight = drainOne(jobs, send)
      .catch(() => { console.error('Workflow outbox poll failed'); })
      .finally(() => { flight = undefined; });
  }, intervalMs);
  timer.unref();
  return {
    async stop() {
      clearInterval(timer);
      await flight;
    },
  };
}
