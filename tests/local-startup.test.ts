/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {expect,test,vi} from 'vitest';
import {startLocal} from '../scripts/start-local.mjs';
test('all Compose calls retain the integration env, with validation before startup',async()=>{
 const run=vi.fn(async()=>Buffer.from('ok'));
 const result=await startLocal({integration:true,hasIntegrationEnv:true,platform:'win32',run});
 expect(result.envFile).toBe('.env.integration');
 const calls=run.mock.calls as unknown as [string,string[],unknown][];
 const compose=calls.filter(([file,args])=>file==='docker'&&args.includes('compose'));
 expect(compose).toHaveLength(6);
 expect(compose.every(([,args])=>args.includes('--env-file')&&args.some(a=>a.endsWith('.env.integration')))).toBe(true);
 expect(compose.slice(0,3).every(([,args])=>args.includes('--quiet'))).toBe(true);
 const commands=calls.map(([file,args])=>file+' '+args.join(' '));
 expect(commands.findIndex(c=>c.startsWith('powershell'))).toBe(3);
 expect(compose.slice(3).map(([,args])=>args.find(a=>a.endsWith('.yml'))?.split(/[\\/]/).at(-1))).toEqual(['core.yml','nocobase.yml','integration.yml']);
 expect(commands.some(c=>c.includes('remove-orphans')||c.includes('down')||c.includes('seed')||c.includes('WORKER=true'))).toBe(false);
});
test('cold checkout starts only core and Studio using default Compose project context',async()=>{
 const run=vi.fn(async()=>Buffer.from('ok'));
 const result=await startLocal({hasIntegrationEnv:false,platform:'linux',run});
 expect(result.envFile).toBe(null);
 expect(run.mock.calls.every(([,args])=>!args.includes('--context')&&!args.includes('--env-file'))).toBe(true);
 expect(run.mock.calls.filter(([,args])=>args.includes('up'))).toHaveLength(2);
});
test('missing integration configuration fails before Docker or any mutation',async()=>{
 const run=vi.fn();await expect(startLocal({integration:true,hasIntegrationEnv:false,run})).rejects.toThrow('.env.integration');expect(run).not.toHaveBeenCalled();
});
test('preflight failures stop startup without leaking command output',async()=>{
 const run=vi.fn(async()=>{throw Error('private-token=fixture');});
 await expect(startLocal({hasIntegrationEnv:true,run})).rejects.toThrow('Compose validation failed: core');
 expect(run).toHaveBeenCalledTimes(1);
});
test('a later integration preflight failure still prevents every container mutation',async()=>{
 const run=vi.fn(async()=>Buffer.from('ok')).mockImplementationOnce(async()=>Buffer.from('ok')).mockImplementationOnce(async()=>Buffer.from('ok')).mockImplementationOnce(async()=>{throw Error('private');});
 await expect(startLocal({integration:true,hasIntegrationEnv:true,platform:'win32',run})).rejects.toThrow('Compose validation failed: integration');
 expect(run).toHaveBeenCalledTimes(3);
 expect(run.mock.calls.every(([,args])=>args.includes('--quiet')&&!args.includes('up'))).toBe(true);
});
