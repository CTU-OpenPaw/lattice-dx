/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {expect,test,vi} from 'vitest';
import {bootstrapRuntime,createRuntimeDrain,startConfiguredWorkers} from './runtime-lifecycle.js';
import {parseRuntimeConfig} from './runtime-config.js';
test('validated outbox selection reaches the database connection before workers start',async()=>{
 const connect=vi.fn(async()=>({close:async()=>{}})),selection={eventType:'asset.handed_over',createdAfter:'2026-10-21T00:00:00.000Z',organizationId:'org-a'};
 const runtime=await bootstrapRuntime({DATABASE_URL:'postgres://localhost/test',WORKFLOW_EVENT_URL:'http://n8n/events',WORKFLOW_EVENT_TOKEN:'fixture',WORKFLOW_OUTBOX_EVENT_TYPE:selection.eventType,WORKFLOW_OUTBOX_CREATED_AFTER:selection.createdAfter,WORKFLOW_OUTBOX_ORGANIZATION_ID:selection.organizationId},{connect,createApp:()=>({addHook(){},listen:async()=>{},close:async()=>{}})});
 expect(connect).toHaveBeenCalledWith('postgres://localhost/test',{store:undefined,outboxSelection:selection});await runtime.close();
});

test('host activates only explicitly enabled worker factories',()=>{
 const factories={automations:vi.fn(),timers:vi.fn(),waitTimeouts:vi.fn(),outbox:vi.fn(),fileStorage:vi.fn()},add=vi.fn();
 startConfiguredWorkers(parseRuntimeConfig({}),factories,add);for(const factory of Object.values(factories))expect(factory).not.toHaveBeenCalled();
 startConfiguredWorkers(parseRuntimeConfig({DATABASE_URL:'postgres://localhost/test',WORKFLOW_WAIT_TIMEOUT_WORKER:'true'}),factories,add);
 expect(factories.waitTimeouts).toHaveBeenCalledTimes(1);expect(factories.outbox).not.toHaveBeenCalled();expect(add).toHaveBeenCalledTimes(1);
});
test('postgres provider still configures filesystem reads before connecting and failed roots prevent DB',async()=>{
 const store={readVerified:vi.fn(),writeVerified:vi.fn()},events:string[]=[];const connect=vi.fn(async(_url:string,options:unknown)=>{events.push('connect');expect(options).toEqual({store});return {close:async()=>{}};});
 const deps={createStore:async()=>{events.push('store');return store;},connect,createApp:()=>({addHook(){},listen:async()=>{},close:async()=>{}})};
 const runtime=await bootstrapRuntime({DATABASE_URL:'postgres://localhost/test',FILE_STORAGE_PROVIDER:'postgres',FILE_STORAGE_ROOT:process.cwd()},deps);expect(events).toEqual(['store','connect']);await runtime.close();
 connect.mockClear();await expect(bootstrapRuntime({DATABASE_URL:'postgres://localhost/test',FILE_STORAGE_ROOT:process.cwd()},{...deps,createStore:async()=>{throw new Error('unsafe root');}})).rejects.toThrow('unsafe root');expect(connect).not.toHaveBeenCalled();
});

test('stop all scheduling immediately and drain every worker before closing database',async()=>{
 let release!:()=>void;const active=new Promise<void>(r=>{release=r;});const events:string[]=[];
 const drain=createRuntimeDrain([{stop(){events.push('stop1');return Promise.reject(new Error('secret'));}},{stop(){events.push('stop2');return active;}}],async()=>{events.push('database');});
 const first=drain();expect(drain()).toBe(first);await Promise.resolve();expect(events).toEqual(['stop1','stop2']);release();await expect(first).rejects.toThrow('Runtime shutdown failed');expect(events).toEqual(['stop1','stop2','database']);
});
test('invalid configuration never connects or creates app',async()=>{
 const connect=vi.fn(),createApp=vi.fn();await expect(bootstrapRuntime({API_PORT:'bad'},{connect,createApp} as never)).rejects.toThrow();expect(connect).not.toHaveBeenCalled();expect(createApp).not.toHaveBeenCalled();
});
test('bootstrap starts workers only after listen and owns close once',async()=>{
 const events:string[]=[];let closeHook!:()=>Promise<void>;
 const app={addHook(_name:string,hook:()=>Promise<void>){closeHook=hook;},async listen(){events.push('listen');},async close(){events.push('app-close');await closeHook();}};
 const runtime=await bootstrapRuntime({DATABASE_URL:'postgres://localhost/test'},{connect:async()=>({close:async()=>{events.push('database');}}),createApp:()=>app,startWorkers:()=>{events.push('workers');return [{stop:async()=>{events.push('stop');}}];}});
 expect(events).toEqual(['listen','workers']);const first=runtime.close();expect(runtime.close()).toBe(first);await first;expect(events).toEqual(['listen','workers','stop','app-close','database']);
});
test('close stops scheduling before HTTP drains but keeps pool until both HTTP and active tick finish',async()=>{
 let finishHttp!:()=>void,finishTick!:()=>void,closeHook!:()=>Promise<void>;
 const http=new Promise<void>(r=>{finishHttp=r;}),tick=new Promise<void>(r=>{finishTick=r;});const stop=vi.fn(()=>tick),poolClose=vi.fn(async()=>{});
 const runtime=await bootstrapRuntime({DATABASE_URL:'postgres://localhost/test'},{connect:async()=>({close:poolClose}),createApp:()=>({addHook(_name,hook){closeHook=hook;},listen:async()=>{},close:async()=>{await http;await closeHook();}}),startWorkers:()=>[{stop}]});
 const closing=runtime.close();expect(stop).toHaveBeenCalledTimes(1);expect(poolClose).not.toHaveBeenCalled();
 finishTick();await Promise.resolve();expect(poolClose).not.toHaveBeenCalled();finishHttp();await closing;expect(poolClose).toHaveBeenCalledTimes(1);
});
test('failure creating app or listening cleans up database',async()=>{
 for(const stage of ['create','listen']){const close=vi.fn(async()=>{});await expect(bootstrapRuntime({DATABASE_URL:'postgres://localhost/test'},{connect:async()=>({close}),createApp:()=>{if(stage==='create')throw new Error('create');return {addHook(){},listen:async()=>{throw new Error('listen');},close:async()=>{}};}})).rejects.toThrow(stage);expect(close).toHaveBeenCalledTimes(1);}
});
test('partly started workers are drained after startup failure',async()=>{
 const stop=vi.fn(async()=>{}),close=vi.fn(async()=>{});
 await expect(bootstrapRuntime({DATABASE_URL:'postgres://localhost/test'},{connect:async()=>({close}),createApp:()=>({addHook(){},listen:async()=>{},close:async()=>{}}),startWorkers:(_config,_db,add)=>{add({stop});throw new Error('startup');}})).rejects.toThrow('startup');expect(stop).toHaveBeenCalledTimes(1);expect(close).toHaveBeenCalledTimes(1);
});
