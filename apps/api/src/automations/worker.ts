// SPDX-License-Identifier: Apache-2.0
import type {AutomationRepository} from './types.js';
export function parseAutomationWorkerEnabled(value:string|undefined):boolean{if(value===undefined||value==='false')return false;if(value==='true')return true;throw new Error('ENTITY_AUTOMATION_WORKER must be true or false.');}
/** Single flight, explicit host startup, and drain before the database closes. */
export function startAutomationWorker(repository:Pick<AutomationRepository,'tickOne'>,intervalMs=1000){
 let active:Promise<unknown>|undefined;let stopped=false;
 const timer=setInterval(()=>{if(!stopped&&!active)active=Promise.resolve().then(()=>repository.tickOne()).catch(()=>console.error('Entity automation tick failed')).finally(()=>{active=undefined;});},intervalMs);timer.unref();
 return {async stop(){stopped=true;clearInterval(timer);await active;}};
}
