/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { setTimeout as delay } from 'node:timers/promises';

export async function runNativeAlertLoop({ runOnce, onResult, onError, intervalMs, signal }) {
  while (!signal.aborted) {
    let outcome = 'idle';
    try {
      const result = await runOnce();
      outcome = result.outcome;
      onResult(result);
    } catch (error) {
      if (signal.aborted && error?.name === 'AbortError') break;
      onError?.(error);
    }
    if (outcome === 'idle' && !signal.aborted) {
      try {
        await delay(intervalMs, undefined, { signal });
      } catch (error) {
        if (error.name !== 'AbortError' || !signal.aborted) throw error;
      }
    }
  }
}
