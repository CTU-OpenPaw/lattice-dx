/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type {AutomationRepository} from './types.js';
import {observedTick,type WorkerObserver} from '../operations/telemetry.js';
export function parseAutomationWorkerEnabled(value:string|undefined):boolean{if(value===undefined||value==='false')return false;if(value==='true')return true;throw new Error('ENTITY_AUTOMATION_WORKER must be true or false.');}
/** Single flight, explicit host startup, and drain before the database closes. */
export function startAutomationWorker(repository:Pick<AutomationRepository,'tickOne'>,intervalMs=1000,observer?:WorkerObserver){
 let active:Promise<unknown>|undefined;let stopped=false;
 const timer=setInterval(()=>{if(!stopped&&!active)active=observedTick(()=>repository.tickOne(),observer).catch(()=>console.error('Entity automation tick failed')).finally(()=>{active=undefined;});},intervalMs);timer.unref();
 return {async stop(){stopped=true;clearInterval(timer);await active;}};
}
