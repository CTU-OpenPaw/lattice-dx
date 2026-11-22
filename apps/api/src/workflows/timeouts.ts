/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type { WorkflowRepository } from './types.js';
import {observedTick,type WorkerObserver} from '../operations/telemetry.js';
export function startWaitTimeoutWorker(repository:WorkflowRepository, intervalMs=1000,observer?:WorkerObserver) {
  let active:Promise<unknown>|undefined;
  const timer=setInterval(()=>{
    if(!active && repository.expireWaits) active=observedTick(()=>repository.expireWaits!(),observer).catch(()=>console.error('Workflow wait timeout failed')).finally(()=>{active=undefined;});
  },intervalMs);
  timer.unref();
  return {async stop() {clearInterval(timer);await active;}};
}
