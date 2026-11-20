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
  let complete: (value: { outcome: string }) => void = () => {};
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

it('backs off cleanly on transient runOnce errors and recovers on the next iteration', async () => {
  const stop = new AbortController();
  const err = new Error('ECONNRESET');
  const onError = vi.fn();
  const onResult = vi.fn(() => stop.abort());
  const runOnce = vi.fn()
    .mockRejectedValueOnce(err)
    .mockResolvedValueOnce({ outcome: 'succeeded' });
  await runNativeAlertLoop({ runOnce, onResult, onError, intervalMs: 10, signal: stop.signal });
  expect(onError).toHaveBeenCalledWith(err);
  expect(runOnce).toHaveBeenCalledTimes(2);
  expect(onResult).toHaveBeenCalledWith({ outcome: 'succeeded' });
});

it('aborts cleanly while sleeping after a runOnce error', async () => {
  const stop = new AbortController();
  let errored!: () => void;
  const waited = new Promise<void>(resolve => { errored = resolve; });
  const loop = runNativeAlertLoop({
    runOnce: vi.fn().mockRejectedValue(new Error('DB down')),
    onResult: vi.fn(),
    onError: () => errored(),
    intervalMs: 60000,
    signal: stop.signal,
  });
  await waited;
  await new Promise(resolve => setTimeout(resolve, 10));
  stop.abort();
  await loop;
});
