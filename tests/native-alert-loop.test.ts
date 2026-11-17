// SPDX-License-Identifier: Apache-2.0
import { expect, it, vi } from 'vitest';
import { runNativeAlertLoop } from '../scripts/lib/native-alert-loop.mjs';

it('stops waiting when idle and does not claim again', async () => {
  const stop = new AbortController();
  const runOnce = vi.fn().mockResolvedValue({ outcome: 'idle' });
  const loop = runNativeAlertLoop({ runOnce, onResult: vi.fn(), intervalMs: 60000, signal: stop.signal });
  await Promise.resolve();
  stop.abort();
  await loop;
  expect(runOnce).toHaveBeenCalledTimes(1);
});

it('finishes an in-flight delivery before stopping', async () => {
  const stop = new AbortController();
  let complete;
  const runOnce = vi.fn(() => new Promise(resolve => { complete = resolve; }));
  const onResult = vi.fn();
  const loop = runNativeAlertLoop({ runOnce, onResult, intervalMs: 500, signal: stop.signal });
  stop.abort();
  expect(onResult).not.toHaveBeenCalled();
  complete({ outcome: 'succeeded' });
  await loop;
  expect(onResult).toHaveBeenCalledWith({ outcome: 'succeeded' });
  expect(runOnce).toHaveBeenCalledTimes(1);
});
