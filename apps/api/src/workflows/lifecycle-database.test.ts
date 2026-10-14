import {expect,test,vi} from 'vitest';
import {workflowDatabase} from './database.js';
import type {Pool} from 'pg';
function fixture(options:{receiptFailure?:boolean;directoryDisabled?:boolean}={}){
 const run:any={id:'run',recordId:'run',definitionId:'def',definitionVersion:1,title:'T',ownerId:'owner',organizationId:'org',state:'pending',version:2,data:{assigned:'old'},createdAt:'2026-10-14',updatedAt:'2026-10-14'};
 const query=vi.fn(async(sql:string)=>{
  if(sql.startsWith('SELECT id,id AS'))return {rows:[run],rowCount:1};
  if(sql.includes('SELECT * FROM workflow_waits'))return {rows:[{id:'task',kind:'task',status:'pending',version:2,assignee_id:'old'}],rowCount:1};
  if(sql.startsWith('SELECT * FROM foundation_tasks'))return {rows:[{id:'task',status:'pending',version:1,assignee_id:'old'}],rowCount:1};
  if(sql.includes('SELECT task_id FROM workflow_task_links'))return {rows:[{task_id:'task'}],rowCount:1};
  if(sql.includes('SELECT 1 FROM directory_people'))return {rows:options.directoryDisabled?[]:[{}],rowCount:options.directoryDisabled?0:1};
  if(sql.startsWith('INSERT INTO workflow_commands')&&options.receiptFailure)throw new Error('receipt failure');
  if(sql.includes('RETURNING id,version'))return {rows:[{id:'task',version:2}],rowCount:1};
  if(sql.startsWith('UPDATE workflow_runs'))return {rows:[{...run,version:3,status:'cancelled'}],rowCount:1};
  return {rows:[],rowCount:0};
 });
 const pool={query,connect:async()=>({query,release:vi.fn()})} as unknown as Pool;
 const registry={get:async()=>({id:'def',version:1,readerRoles:[],assignedReader:{field:'assigned',role:'employee',states:['pending']}} as any),list:async()=>[]};
 return {pool,registry,query,run};
}
const actor={subject:'owner',organizationId:'org',roles:['workflow:start','tasks:assign']};
test('cancel requires current exact owner and writes cancellation with receipt in one transaction',async()=>{
 const f=fixture(),r=await workflowDatabase(f.pool,f.registry);
 await expect(r.cancel!('run',{expectedVersion:2,reason:'Stop'}, {...actor,subject:'other'},'k')).rejects.toMatchObject({statusCode:404});
 const next=await r.cancel!('run',{expectedVersion:2,reason:'Stop'},actor,'k');
 expect(next.version).toBe(3);expect(next.status).toBe('cancelled');
 const sql=f.query.mock.calls.map(x=>x[0]);expect(sql.some(s=>s.includes("status='cancelled'")&&s.includes('workflow_jobs'))).toBe(true);expect(sql.some(s=>s.startsWith('INSERT INTO workflow_commands'))).toBe(true);
});
test('transfer synchronizes pending wait and legacy assignment and checks current directory',async()=>{
 const f=fixture(),r=await workflowDatabase(f.pool,f.registry);
 await r.taskTransfer!('run',{taskId:'task',expectedVersion:2,assigneeId:'new',reason:'Handoff'},actor,'k');
 const sql=f.query.mock.calls.map(x=>x[0]);expect(sql.some(s=>s.includes('directory_people')&&s.includes('FOR SHARE'))).toBe(true);
 expect(sql.some(s=>s.startsWith('UPDATE workflow_waits')&&s.includes('version'))).toBe(true);
 expect(sql.some(s=>s.startsWith('UPDATE foundation_tasks')&&s.includes('assignee_id'))).toBe(true);
});
test('transfer audit stores reason and assignment evidence',async()=>{
 const f=fixture(),r=await workflowDatabase(f.pool,f.registry);
 await r.taskTransfer!('run',{taskId:'task',expectedVersion:2,assigneeId:'new',reason:'Handoff'},actor,'k');
 expect(f.query.mock.calls.find(([s])=>s.startsWith('INSERT INTO workflow_audit'))?.[0]).toContain('metadata');
});

test('failed lifecycle receipt rolls back audit and every resource mutation',async()=>{
 const f=fixture({receiptFailure:true}),r=await workflowDatabase(f.pool,f.registry);
 await expect(r.cancel!('run',{expectedVersion:2,reason:'Stop'},actor,'k')).rejects.toThrow('receipt failure');
 const sql=f.query.mock.calls.map(x=>x[0]);expect(sql).toContain('ROLLBACK');expect(sql).not.toContain('COMMIT');expect(sql.some(s=>s.startsWith('INSERT INTO workflow_audit'))).toBe(true);
});
test('transfer rejects disabled current-directory assignee before writes',async()=>{
 const f=fixture({directoryDisabled:true}),r=await workflowDatabase(f.pool,f.registry);
 await expect(r.taskTransfer!('run',{taskId:'task',expectedVersion:2,assigneeId:'new',reason:'Handoff'},actor,'k')).rejects.toMatchObject({statusCode:400});
 expect(f.query.mock.calls.some(([s])=>s.startsWith('UPDATE'))).toBe(false);
});
test('cancel role, cancelled status and stale version do not write',async()=>{
 for(const mode of ['role','cancelled','stale']){
  const f=fixture();if(mode==='cancelled')f.run.status='cancelled';
  const r=await workflowDatabase(f.pool,f.registry);
  await expect(r.cancel!('run',{expectedVersion:mode==='stale'?1:2,reason:'Stop'},mode==='role'?{...actor,roles:[]}:actor,'k')).rejects.toMatchObject({statusCode:mode==='role'?403:409});
  expect(f.query.mock.calls.some(([s])=>s.startsWith('UPDATE'))).toBe(false);
 }
});
