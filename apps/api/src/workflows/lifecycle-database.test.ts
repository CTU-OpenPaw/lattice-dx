import {expect,test,vi} from 'vitest';
import {workflowDatabase} from './database.js';
import {availableTransitions} from './policy.js';
import type {Pool} from 'pg';
function fixture(options:{receiptFailure?:boolean;directoryDisabled?:boolean}={}){
 const run:any={id:'11111111-1111-4111-8111-111111111111',recordId:'11111111-1111-4111-8111-111111111111',definitionId:'def',definitionVersion:1,title:'T',ownerId:'owner',organizationId:'org',state:'pending',version:2,data:{assigned:'old'},createdAt:'2026-10-14',updatedAt:'2026-10-14'};
 let receipt:any;
 const query=vi.fn(async(sql:string,values?:unknown[])=>{
  if(sql.startsWith('SELECT actor_id,fingerprint,result'))return {rows:receipt?[receipt]:[],rowCount:receipt?1:0};
  if(sql.startsWith('INSERT INTO workflow_commands')&&!options.receiptFailure)receipt={actor_id:values![2],fingerprint:values![3],result:JSON.parse(values![4] as string)};
  if(sql.startsWith('SELECT id,id AS'))return {rows:[run],rowCount:1};
  if(sql.includes('SELECT * FROM workflow_waits'))return {rows:[{id:'22222222-2222-4222-8222-222222222222',kind:'task',status:'pending',version:2,assignee_id:'old'}],rowCount:1};
  if(sql.startsWith('SELECT * FROM foundation_tasks'))return {rows:[{id:'22222222-2222-4222-8222-222222222222',status:'pending',version:1,assignee_id:'old'}],rowCount:1};
  if(sql.includes('SELECT task_id FROM workflow_task_links'))return {rows:[{task_id:'22222222-2222-4222-8222-222222222222'}],rowCount:1};
  if(sql.includes('SELECT 1 FROM directory_people'))return {rows:options.directoryDisabled?[]:[{}],rowCount:options.directoryDisabled?0:1};
  if(sql.startsWith('INSERT INTO workflow_commands')&&options.receiptFailure)throw new Error('receipt failure');
  if(sql.includes('RETURNING id,version'))return {rows:[{id:'22222222-2222-4222-8222-222222222222',version:2}],rowCount:1};
  if(sql.startsWith('UPDATE workflow_runs'))return {rows:[{...run,version:3,status:sql.includes("status='cancelled'")?'cancelled':'active'}],rowCount:1};
  return {rows:[],rowCount:0};
 });
 const pool={query,connect:async()=>({query,release:vi.fn()})} as unknown as Pool;
 const registry={get:async()=>({id:'def',version:1,readerRoles:[],assignedReader:{field:'assigned',role:'employee',states:['pending']}} as any),list:async()=>[]};
 return {pool,registry,query,run};
}
const actor={subject:'owner',organizationId:'org',roles:['workflow:start','tasks:assign']};
test('cancel requires current exact owner and writes cancellation with receipt in one transaction',async()=>{
 const f=fixture(),r=await workflowDatabase(f.pool,f.registry);
 await expect(r.cancel!('11111111-1111-4111-8111-111111111111',{expectedVersion:2,reason:'Stop'}, {...actor,subject:'other'},'k')).rejects.toMatchObject({statusCode:404});
 const next=await r.cancel!('11111111-1111-4111-8111-111111111111',{expectedVersion:2,reason:'Stop'},actor,'k');
 expect(next.version).toBe(3);expect(next.status).toBe('cancelled');
 const sql=f.query.mock.calls.map(x=>x[0]);expect(sql.some(s=>s.includes("status='cancelled'")&&s.includes('workflow_jobs'))).toBe(true);expect(sql.some(s=>s.startsWith('INSERT INTO workflow_commands'))).toBe(true);
});
test('transfer synchronizes pending wait and legacy assignment and checks current directory',async()=>{
 const f=fixture(),r=await workflowDatabase(f.pool,f.registry);
 await r.taskTransfer!('11111111-1111-4111-8111-111111111111',{taskId:'22222222-2222-4222-8222-222222222222',expectedVersion:2,assigneeId:'new',reason:'Handoff'},actor,'k');
 const sql=f.query.mock.calls.map(x=>x[0]);expect(sql.some(s=>s.includes('directory_people')&&s.includes('FOR SHARE'))).toBe(true);
 expect(sql.some(s=>s.startsWith('UPDATE workflow_waits')&&s.includes('version'))).toBe(true);
 expect(sql.some(s=>s.startsWith('UPDATE foundation_tasks')&&s.includes('assignee_id'))).toBe(true);
});
test('transfer audit stores reason and assignment evidence',async()=>{
 const f=fixture(),r=await workflowDatabase(f.pool,f.registry);
 await r.taskTransfer!('11111111-1111-4111-8111-111111111111',{taskId:'22222222-2222-4222-8222-222222222222',expectedVersion:2,assigneeId:'new',reason:'Handoff'},actor,'k');
 expect(f.query.mock.calls.find(([s])=>s.startsWith('INSERT INTO workflow_audit'))?.[0]).toContain('metadata');
});

test('failed lifecycle receipt rolls back audit and every resource mutation',async()=>{
 const f=fixture({receiptFailure:true}),r=await workflowDatabase(f.pool,f.registry);
 await expect(r.cancel!('11111111-1111-4111-8111-111111111111',{expectedVersion:2,reason:'Stop'},actor,'k')).rejects.toThrow('receipt failure');
 const sql=f.query.mock.calls.map(x=>x[0]);expect(sql).toContain('ROLLBACK');expect(sql).not.toContain('COMMIT');expect(sql.some(s=>s.startsWith('INSERT INTO workflow_audit'))).toBe(true);
});
test('transfer rejects disabled current-directory assignee before writes',async()=>{
 const f=fixture({directoryDisabled:true}),r=await workflowDatabase(f.pool,f.registry);
 await expect(r.taskTransfer!('11111111-1111-4111-8111-111111111111',{taskId:'22222222-2222-4222-8222-222222222222',expectedVersion:2,assigneeId:'new',reason:'Handoff'},actor,'k')).rejects.toMatchObject({statusCode:400});
 expect(f.query.mock.calls.some(([s])=>s.startsWith('UPDATE'))).toBe(false);
});
test('cancel role, cancelled status and stale version do not write',async()=>{
 for(const mode of ['role','cancelled','stale']){
  const f=fixture();if(mode==='cancelled')f.run.status='cancelled';
  const r=await workflowDatabase(f.pool,f.registry);
  await expect(r.cancel!('11111111-1111-4111-8111-111111111111',{expectedVersion:mode==='stale'?1:2,reason:'Stop'},mode==='role'?{...actor,roles:[]}:actor,'k')).rejects.toMatchObject({statusCode:mode==='role'?403:409});
  expect(f.query.mock.calls.some(([s])=>s.startsWith('UPDATE'))).toBe(false);
 }
});

test('repository rejects malformed lifecycle DTOs, keys, UUIDs and principal boundaries',async()=>{
 const id='11111111-1111-4111-8111-111111111111',taskId='22222222-2222-4222-8222-222222222222';
 const variants=[{taskId:'bad-uuid'}, {assigneeId:'🧩'.repeat(101)}, {assigneeId:' new'}, {assigneeId:'new\n'}, {extra:'authority'}];
 for(const variant of variants){
  const f=fixture(),r=await workflowDatabase(f.pool,f.registry);
  await expect(r.taskTransfer!(id,{taskId,expectedVersion:2,assigneeId:'new',reason:'Handoff',...variant} as any,actor,'k')).rejects.toMatchObject({statusCode:400});
  expect(f.query.mock.calls.some(([s])=>s.startsWith('UPDATE'))).toBe(false);
 }
 for(const key of [undefined,'','invalid,key','a'.repeat(129)]){
  const f=fixture(),r=await workflowDatabase(f.pool,f.registry);
  await expect(r.cancel!(id,{expectedVersion:2,reason:'Stop'},actor,key as any)).rejects.toMatchObject({statusCode:400});
 }
 const f=fixture(),r=await workflowDatabase(f.pool,f.registry);
 await expect(r.cancel!('not-uuid',{expectedVersion:2,reason:'Stop'},actor,'k')).rejects.toMatchObject({statusCode:400});
});

test('transfer snapshots preserve pending wait and legacy task projections',async()=>{
 const f=fixture(),r=await workflowDatabase(f.pool,f.registry);
 const result=await r.taskTransfer!('11111111-1111-4111-8111-111111111111',{taskId:'22222222-2222-4222-8222-222222222222',expectedVersion:2,assigneeId:'new',reason:'Handoff'},actor,'k');
 expect(result.waiting).toBe(true);expect(result.taskId).toBe('22222222-2222-4222-8222-222222222222');
 const definition:any={transitions:[{id:'leave',from:'pending',to:'done',role:'workflow:start',fields:{}}]};
 expect(availableTransitions(definition,result,actor)).toEqual([]);
 const replay=await r.taskTransfer!('11111111-1111-4111-8111-111111111111',{taskId:'22222222-2222-4222-8222-222222222222',expectedVersion:2,assigneeId:'new',reason:'Handoff'},actor,'k');
 expect(replay).toEqual(result);expect(availableTransitions(definition,replay,actor)).toEqual([]);
});
