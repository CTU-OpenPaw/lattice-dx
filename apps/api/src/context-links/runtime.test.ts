/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {expect,test,vi} from 'vitest';
import {parseRuntimeConfig} from '../operations/runtime-config.js';
import {bootstrapRuntime} from '../operations/runtime-lifecycle.js';
test('projection flag is strict opt in independent of receiver configuration',()=>{
 expect(parseRuntimeConfig({}).ngsiLdContextRead).toBe(false);expect(parseRuntimeConfig({NGSI_LD_CONTEXT_READ:'false'}).ngsiLdContextRead).toBe(false);expect(parseRuntimeConfig({NGSI_LD_CONTEXT_READ:'true'}).ngsiLdContextRead).toBe(true);
 for(const value of ['','TRUE','yes','1',' true'])expect(()=>parseRuntimeConfig({NGSI_LD_CONTEXT_READ:value})).toThrow('NGSI_LD_CONTEXT_READ');
});
test('only explicit opt in passes projectionEnabled to database connection',async()=>{
 for(const value of [undefined,'false','true']){
  const connect=vi.fn(async()=>({close:async()=>{}}));const app={addHook(){},listen:async()=>{},close:async()=>{}};
  await (await bootstrapRuntime({DATABASE_URL:'postgres://localhost/test',...(value?{NGSI_LD_CONTEXT_READ:value}:{})},{connect,createApp:()=>app})).close();
  expect(connect).toHaveBeenCalledWith('postgres://localhost/test',value==='true'?{store:undefined,projectionEnabled:true}:{store:undefined});
 }
});
