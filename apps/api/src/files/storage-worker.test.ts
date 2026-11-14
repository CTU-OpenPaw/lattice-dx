/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {test,expect,vi} from 'vitest';
import {startFileStorageWorker} from './storage-worker.js';
test('single flight scheduling stops and drains active work',async()=>{
 vi.useFakeTimers();let finish!:()=>void;const tick=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;}));
 const worker=startFileStorageWorker(tick,10);await vi.advanceTimersByTimeAsync(30);expect(tick).toHaveBeenCalledTimes(1);
 let drained=false;const stop=worker.stop().then(()=>{drained=true;});await Promise.resolve();expect(drained).toBe(false);
 finish();await stop;await worker.stop();await vi.advanceTimersByTimeAsync(30);expect(tick).toHaveBeenCalledTimes(1);vi.useRealTimers();
});
