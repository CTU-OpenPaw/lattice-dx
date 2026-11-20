/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {test,expect,vi} from 'vitest';
import {startAutomationWorker} from '../automations/worker.js';
import {startWorkflowTimerWorker} from '../workflows/timer-worker.js';
import {startWaitTimeoutWorker} from '../workflows/timeouts.js';
import {startOutboxWorker} from '../workflows/outbox.js';
import {startFileStorageWorker} from '../files/storage-worker.js';
import {createRuntimeDrain} from './runtime-lifecycle.js';
import {createTelemetry,type WorkerId} from './telemetry.js';

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
test('five worker observers classify idle, handled failures, successful work and thrown errors',async()=>{
 vi.useFakeTimers();const logging=vi.spyOn(console,'error').mockImplementation(()=>{});const telemetry=createTelemetry();
 const observe=(worker:WorkerId)=>(result:'success'|'failure'|'idle',duration:number)=>telemetry.recordWorker(worker,result,duration);
 const automation=vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce({status:'pending'}).mockResolvedValueOnce({status:'succeeded'}).mockRejectedValueOnce(Error('private'));
 const timers=vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce({status:'failed'}).mockResolvedValueOnce({status:'succeeded'}).mockRejectedValueOnce(Error('private'));
 const waits=vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(1).mockRejectedValueOnce(Error('private')).mockResolvedValue(0);
 const storage=vi.fn().mockResolvedValueOnce('idle').mockResolvedValueOnce('switched').mockRejectedValueOnce(Error('private')).mockResolvedValue('idle');
 const claim=vi.fn().mockResolvedValueOnce(undefined).mockResolvedValue({id:'private-job'});
 const send=vi.fn().mockRejectedValueOnce(Error('private')).mockResolvedValue(undefined);
 const workers=[startAutomationWorker({tickOne:automation} as never,10,observe('automations')),startWorkflowTimerWorker({tickOne:timers} as never,10,observe('timers')),startWaitTimeoutWorker({expireWaits:waits} as never,10,observe('waitTimeouts')),startOutboxWorker({claim,fail:async()=>{},succeed:async()=>{}} as never,send,10,observe('outbox')),startFileStorageWorker(storage,10,()=>{},observe('fileStorage'))];
 try{
  await vi.advanceTimersByTimeAsync(40);
  for(const worker of ['outbox','timers','waitTimeouts','automations','fileStorage'])for(const result of ['idle','success','failure'])expect(telemetry.snapshot().workers.find(row=>row.worker===worker&&row.result===result)?.count).toBeGreaterThan(0);
  expect(telemetry.snapshot().workers.find(row=>row.worker==='outbox'&&row.result==='failure')?.count).toBe(1);
  expect(JSON.stringify(telemetry.snapshot())).not.toContain('private');
 }finally{await Promise.all(workers.map(worker=>worker.stop()));vi.useRealTimers();logging.mockRestore();}
});
