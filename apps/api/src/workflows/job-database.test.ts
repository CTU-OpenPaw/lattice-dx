import {expect,test,vi} from 'vitest';
import type {Pool} from 'pg';
import {workflowJobDatabase} from './job-database.js';
test('job claims lock active run before job and require pending unexpired waits',async()=>{
 const log:string[]=[];
 const query=vi.fn(async(s:string)=>{log.push(s);if(s.includes('SELECT r.id FROM workflow_runs'))return {rows:[{id:'run'}]};return {rows:[]};});
 const pool={query,connect:async()=>({query,release:vi.fn()})} as unknown as Pool;
 await workflowJobDatabase(pool).claim();
 expect(log.some(s=>s.includes("r.status='active'")&&s.includes('FOR UPDATE OF r SKIP LOCKED'))).toBe(true);
 expect(log.some(s=>s.includes("w.status='pending'")&&s.includes('w.deadline>clock_timestamp()'))).toBe(true);
 expect(log[0]).toBe('BEGIN');expect(log.at(-1)).toBe('COMMIT');
});
test('scoped dispatcher filters the run and job candidates with the same event ID',async()=>{
 const id='ee4b283b-5049-4082-a49b-9a1e0181f328';
 const query=vi.fn(async(s:string)=>({rows:s.includes('SELECT r.id FROM workflow_runs')?[{id:'run'}]:[]}));
 const pool={connect:async()=>({query,release:vi.fn()})} as unknown as Pool;
 await workflowJobDatabase(pool,{eventId:id}).claim();
 const calls=query.mock.calls as unknown as [string,unknown[]][];
 expect(calls.find(([sql])=>sql.includes('SELECT r.id FROM workflow_runs'))).toEqual([expect.stringContaining('j.id=$1'),[id,null,null,null]]);
 expect(calls.find(([sql])=>sql.includes('WITH candidate'))?.[1][2]).toBe(id);
 expect(()=>workflowJobDatabase(pool,{eventId:'not-a-uuid'})).toThrow();
});
