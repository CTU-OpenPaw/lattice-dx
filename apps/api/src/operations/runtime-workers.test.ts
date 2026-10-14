import {test,expect,vi} from 'vitest';
import {startAutomationWorker} from '../automations/worker.js';
import {startWorkflowTimerWorker} from '../workflows/timer-worker.js';
import {startWaitTimeoutWorker} from '../workflows/timeouts.js';
import {startOutboxWorker} from '../workflows/outbox.js';
import {startFileStorageWorker} from '../files/storage-worker.js';
import {createRuntimeDrain} from './runtime-lifecycle.js';

test('every worker runs single flight and all schedules stop while active ticks drain',async()=>{
 vi.useFakeTimers();const releases:Array<()=>void>=[];
 const ticks=Array.from({length:5},()=>vi.fn(()=>new Promise<void>(r=>releases.push(r))));
 const workers=[startAutomationWorker({tickOne:ticks[0]!} as never,10),startWorkflowTimerWorker({tickOne:ticks[1]!} as never,10),startWaitTimeoutWorker({expireWaits:ticks[2]!} as never,10),startOutboxWorker({claim:ticks[3]!} as never,async()=>{},10),startFileStorageWorker(ticks[4]!,10)];
 try {
  await vi.advanceTimersByTimeAsync(30);for(const tick of ticks)expect(tick).toHaveBeenCalledTimes(1);
  const poolClose=vi.fn(async()=>{});const drain=createRuntimeDrain(workers,poolClose);const closing=drain();await Promise.resolve();
  await vi.advanceTimersByTimeAsync(100);for(const tick of ticks)expect(tick).toHaveBeenCalledTimes(1);expect(poolClose).not.toHaveBeenCalled();
  releases.forEach(release=>release());await closing;expect(poolClose).toHaveBeenCalledTimes(1);await drain();expect(poolClose).toHaveBeenCalledTimes(1);
 }finally{releases.forEach(release=>release());await Promise.all(workers.map(worker=>worker.stop()));vi.useRealTimers();}
});
