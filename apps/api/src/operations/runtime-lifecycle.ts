// SPDX-License-Identifier: Apache-2.0
import type {ObjectStore} from '../files/object-store.js';
import {parseRuntimeConfig,type RuntimeConfig} from './runtime-config.js';
export interface RuntimeWorker {stop():Promise<void>}
export function startConfiguredWorkers(config:RuntimeConfig,factories:Record<keyof RuntimeConfig['workers'],()=>RuntimeWorker>,add:(worker:RuntimeWorker)=>void) {
 for(const key of Object.keys(config.workers) as Array<keyof RuntimeConfig['workers']>)if(config.workers[key])add(factories[key]());
}
interface RuntimeApp {addHook(name:'onClose',hook:()=>Promise<void>):unknown;listen(options:{host:string;port:number}):Promise<unknown>;close():Promise<void>}
/** Calling every stop first cancels all schedules before any active work is awaited. */
export function createRuntimeDrain(workers:RuntimeWorker[],closeDatabase:()=>Promise<void>) {
 let stopping:Promise<PromiseSettledResult<void>[]>|undefined;
 const stopWorkers=()=>{
  if(!stopping){
   const stops=workers.map(worker=>{try{return worker.stop();}catch{return Promise.reject(new Error('Worker shutdown failed'));}});
   stopping=Promise.allSettled(stops);
  }
  return stopping;
 };
 let flight:Promise<void>|undefined;
 const drain=()=>{
  const stopped=stopWorkers();
  return flight??=Promise.resolve().then(async()=>{
  const results=await stopped;
  let failed=results.some(result=>result.status==='rejected');
  try{await closeDatabase();}catch{failed=true;}
  if(failed)throw new Error('Runtime shutdown failed');
  });
 };
 return Object.assign(drain,{stopWorkers});
}
/** Resource ownership seam: parsing and store validation precede the first connection. */
export async function bootstrapRuntime<D extends {close():Promise<void>}>(env:NodeJS.ProcessEnv,deps:{
 createStore?:(root:string)=>Promise<ObjectStore>;connect:(url:string,options:{store?:ObjectStore;projectionEnabled?:boolean})=>Promise<D>;
 createApp:(config:RuntimeConfig,database:D|undefined)=>RuntimeApp;
 startWorkers?:(config:RuntimeConfig,database:D|undefined,add:(worker:RuntimeWorker)=>void)=>RuntimeWorker[]|void;
}) {
 const config=parseRuntimeConfig(env);
 const store=config.storage.root?await deps.createStore?.(config.storage.root):undefined;
 if(config.storage.root&&!store)throw new Error('Storage initialization failed');
 let database:D|undefined;let app:RuntimeApp|undefined;const workers:RuntimeWorker[]=[];
 const drain=createRuntimeDrain(workers,async()=>{await database?.close();});
 let closeFlight:Promise<void>|undefined;
 const close=()=>{
  // Cancel worker schedules immediately; onClose closes the pool after HTTP drains.
  drain.stopWorkers();
  return closeFlight??=Promise.resolve().then(async()=>{try{await app?.close();}finally{await drain();}});
 };
 try {
  database=config.databaseUrl?await deps.connect(config.databaseUrl,{store,...(config.ngsiLdContextRead?{projectionEnabled:true}:{})}):undefined;
  app=deps.createApp(config,database);app.addHook('onClose',drain);
  await app.listen({host:config.host,port:config.port});
  const started=deps.startWorkers?.(config,database,worker=>workers.push(worker));if(started)workers.push(...started);
  return {config,app,database,close};
 }catch(error){try{await close();}catch{}throw error;}
}
