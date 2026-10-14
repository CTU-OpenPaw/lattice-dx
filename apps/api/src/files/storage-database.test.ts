// SPDX-License-Identifier: Apache-2.0
import {test,expect,vi} from 'vitest';
import type {PoolClient} from 'pg';
import {offloadFileWithClient,initializeFileStorage,offloadOneFile} from './storage-database.js';
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
