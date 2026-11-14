/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
/** Explicit opt-in scheduling; one tick at a time, stop always waits for the active tick. */
import {observedTick,type WorkerObserver} from '../operations/telemetry.js';
export function startFileStorageWorker(tick:()=>Promise<unknown>,intervalMs=1000,onFailure:()=>void=()=>console.error('File storage tick failed'),observer?:WorkerObserver) {
 if(!Number.isFinite(intervalMs)||intervalMs<1)throw new Error('Invalid storage interval');
 let active:Promise<void>|undefined;
 const timer=setInterval(()=>{
  if(active)return;
  active=observedTick(tick,observer).catch(()=>{onFailure();}).finally(()=>{active=undefined;});
 },intervalMs);timer.unref();
 return {async stop(){clearInterval(timer);await active;}};
}
