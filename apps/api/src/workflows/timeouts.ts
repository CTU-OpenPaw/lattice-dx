// SPDX-License-Identifier: Apache-2.0
import type { WorkflowRepository } from './types.js';
export function startWaitTimeoutWorker(repository:WorkflowRepository, intervalMs=1000) {
  let active:Promise<unknown>|undefined;
  const timer=setInterval(()=>{
    if(!active && repository.expireWaits) active=repository.expireWaits().catch(()=>console.error('Workflow wait timeout failed')).finally(()=>{active=undefined;});
  },intervalMs);
  timer.unref();
  return {async stop() {clearInterval(timer);await active;}};
}
