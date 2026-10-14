// SPDX-License-Identifier: Apache-2.0
import type {WorkflowRepository} from './types.js';
/** Explicit startup belongs to the host; ticks never overlap and shutdown drains. */
export function startWorkflowTimerWorker(repository:WorkflowRepository,intervalMs=1000) {
  let active:Promise<unknown>|undefined;
  const timer=setInterval(()=>{
    if(!active&&repository.tickOne)active=repository.tickOne().catch(()=>console.error('Workflow timer tick failed')).finally(()=>{active=undefined;});
  },intervalMs);
  timer.unref();
  return {async stop(){clearInterval(timer);await active;}};
}
