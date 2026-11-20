/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {test,expect,vi} from 'vitest';
import type {PoolClient} from 'pg';
import {mkdtemp,mkdir,lstat,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createFilesystemStore} from './filesystem-store.js';
import {offloadFileWithClient,initializeFileStorage,offloadOneFile,assertFileStorageReadable} from './storage-database.js';

test('directory sync failure rolls back offload and retains postgres bytes',async()=>{
 const base=join(process.cwd(),'output');await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'dx-sync-'));
 const bytes=Buffer.from('database original');const key='12345678-1234-4234-8234-123456789abc';
 const close=vi.fn(async()=>{});
 const store=await createFilesystemStore(root,{objectKey:()=>key,openRoot:async()=>({stat:()=>lstat(root),sync:async()=>{throw new Error('directory sync failed');},close})});
 const row={id:'id',storage_provider:'postgres',storage_version:1,scan_status:'clean',content:bytes,size:bytes.length};
 const statements:string[]=[];const release=vi.fn();
 const query=vi.fn(async(sql:string)=>{statements.push(sql);if(sql.startsWith('SELECT'))return {rows:[row]};if(sql.startsWith('UPDATE')){row.content=null as never;return {rowCount:1};}return {rows:[]};});
 await expect(offloadOneFile({connect:async()=>({query,release})} as never,store)).rejects.toThrow('directory sync failed');
 expect(statements.at(-1)).toBe('ROLLBACK');expect(statements.some(sql=>sql.startsWith('UPDATE')||sql==='COMMIT')).toBe(false);
 expect(row.content).toEqual(bytes);expect(await readFile(join(root,key))).toEqual(bytes);expect(release).toHaveBeenCalledTimes(1);expect(close).toHaveBeenCalledTimes(1);
});

test('startup refuses filesystem pointers without configured store and permits postgres-only rows',async()=>{
 const query=vi.fn(async()=>({rows:[{exists:true}]}));
 await expect(assertFileStorageReadable({query} as never)).rejects.toThrow('Filesystem storage requires a configured root');
 query.mockResolvedValueOnce({rows:[]});await assertFileStorageReadable({query} as never);
 query.mockClear();await assertFileStorageReadable({query} as never,{readVerified:vi.fn(),writeVerified:vi.fn()});expect(query).not.toHaveBeenCalled();
});
test('switch locks caller row then verifies object before removing database content',async()=>{
 const order:string[]=[];
 const query=vi.fn(async(sql:string)=>{order.push(sql);return sql.startsWith('SELECT')?{rows:[{storage_provider:'postgres',storage_version:1,scan_status:'clean',content:Buffer.from('abc'),size:3}]}:{rowCount:1};});
 const store={writeVerified:vi.fn(async()=>{order.push('verified');return {objectKey:'key',sha256:'hash',size:3};}),readVerified:vi.fn()};
 expect(await offloadFileWithClient({query} as unknown as PoolClient,'id',1,store)).toBe('switched');
 expect(order[0]).toContain('FOR UPDATE');expect(order[1]).toBe('verified');expect(order[2]).toContain('content=NULL');
 expect(order.some(sql=>/BEGIN|COMMIT/.test(sql))).toBe(false);
});
test('write failure leaves database untouched and update failure propagates without cleanup',async()=>{
 const query=vi.fn(async(sql:string)=>sql.startsWith('SELECT')?{rows:[{storage_provider:'postgres',storage_version:1,scan_status:'clean',content:Buffer.from('abc'),size:3}]}:{rowCount:0});
 const client={query} as unknown as PoolClient;
 const store={writeVerified:vi.fn(async()=>{throw new Error('write failed');}),readVerified:vi.fn()};
 await expect(offloadFileWithClient(client,'id',1,store)).rejects.toThrow('write failed');expect(query).toHaveBeenCalledTimes(1);
 store.writeVerified.mockImplementation(async()=>({objectKey:'key',sha256:'hash',size:3}) as never);
 await expect(offloadFileWithClient(client,'id',1,store)).rejects.toThrow('revision changed');
});
test('migration validates legacy shapes and introspects named constraint; idle tick commits and releases one client',async()=>{
 const query=vi.fn(async()=>({rows:[]}));await initializeFileStorage({query} as never);
 expect(query.mock.calls.flat().join(' ')).toContain('pg_constraint');
 const release=vi.fn();const pool={connect:vi.fn(async()=>({query,release}))};
 expect(await offloadOneFile(pool as never,{writeVerified:vi.fn(),readVerified:vi.fn()})).toBe('idle');
 expect(pool.connect).toHaveBeenCalledTimes(1);expect(release).toHaveBeenCalledTimes(1);
});
test('revision and nonclean rows fail before write; already switched verifies bytes',async()=>{
 const row={storage_provider:'postgres',storage_version:2,scan_status:'clean',content:Buffer.from('a'),size:1};
 const client={query:vi.fn(async()=>({rows:[row]}))} as unknown as PoolClient;
 const store={writeVerified:vi.fn(),readVerified:vi.fn(async()=>Buffer.from('a'))};
 await expect(offloadFileWithClient(client,'id',1,store)).rejects.toThrow();expect(store.writeVerified).not.toHaveBeenCalled();
 Object.assign(row,{storage_provider:'filesystem',object_key:'key',content_sha256:'hash'});
 expect(await offloadFileWithClient(client,'id',1,store)).toBe('already_switched');expect(store.readVerified).toHaveBeenCalled();
});
