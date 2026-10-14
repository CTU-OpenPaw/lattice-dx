// SPDX-License-Identifier: Apache-2.0
/** Explicit opt-in scheduling; one tick at a time, stop always waits for the active tick. */
export function startFileStorageWorker(tick:()=>Promise<unknown>,intervalMs=1000,onFailure:()=>void=()=>console.error('File storage tick failed')) {
 if(!Number.isFinite(intervalMs)||intervalMs<1)throw new Error('Invalid storage interval');
 let active:Promise<void>|undefined;
 const timer=setInterval(()=>{
  if(active)return;
  active=Promise.resolve().then(tick).then(()=>{},()=>{onFailure();}).finally(()=>{active=undefined;});
 },intervalMs);timer.unref();
 return {async stop(){clearInterval(timer);await active;}};
}
