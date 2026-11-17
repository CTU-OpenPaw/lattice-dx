// SPDX-License-Identifier: Apache-2.0
import { setTimeout as delay } from 'node:timers/promises';

export async function runNativeAlertLoop({ runOnce, onResult, intervalMs, signal }) {
  while (!signal.aborted) {
    const result = await runOnce();
    onResult(result);
    if (result.outcome === 'idle' && !signal.aborted) {
      try {
        await delay(intervalMs, undefined, { signal });
      } catch (error) {
        if (error.name !== 'AbortError' || !signal.aborted) throw error;
      }
    }
  }
}
