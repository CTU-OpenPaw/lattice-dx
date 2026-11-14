/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {expect,it,vi} from 'vitest';
import {readQueuesWithClient} from './queues.js';
import {operationsDatabase} from './database.js';
it('uses one client and signed tenant before every fixed aggregation, filling missing statuses',async()=>{
 const query=vi.fn(async(text:string,values?:unknown[])=>({rows:text.includes('workflow_jobs')?[{status:'pending',count:'2',oldestPendingAt:new Date('2020-01-01Z'),payload:'private'}]:[]}));
 const result=await readQueuesWithClient({query} as never,'tenant-a');
 expect(result.find(row=>row.queue==='outbox'&&row.status==='pending')).toEqual({queue:'outbox',status:'pending',count:'2',oldestPendingAt:'2020-01-01T00:00:00.000Z'});
 expect(result.find(row=>row.queue==='timers'&&row.status==='failed')?.count).toBe('0');
 expect(JSON.stringify(result)).not.toContain('private');
 for(const [sql,values] of query.mock.calls){expect(sql).toContain('organization_id=$1');expect(values).toEqual(['tenant-a']);expect(sql).not.toContain('payload');}
});
it('owns one connection for the timeout and all queue queries and always releases on failure',async()=>{
 const query=vi.fn(async()=>({rows:[]}));const release=vi.fn();const connect=vi.fn(async()=>({query,release}));
 const repository=operationsDatabase({connect} as never);
 await repository.queues!('tenant-a');
 expect(connect).toHaveBeenCalledTimes(1);expect(query.mock.calls[0]).toEqual(['BEGIN']);
 expect(query.mock.calls[1]).toEqual(["SET LOCAL statement_timeout='3s'"]);expect(release).toHaveBeenCalledTimes(1);
 query.mockRejectedValueOnce(Error('private unavailable database'));
 await expect(repository.queues!('tenant-b')).rejects.toThrow();
 expect(query.mock.calls.at(-1)).toEqual(['ROLLBACK']);expect(release).toHaveBeenCalledTimes(2);
});
