import {expect,test} from 'vitest';
import type {Pool} from 'pg';
import {taskLifecycleDatabase} from './database.js';
import {createFingerprint} from '../create-command.js';
const id='11111111-1111-4111-8111-111111111111';
function fixture(options:{assignee?:string;linked?:boolean;receipt?:boolean;receiptFailure?:boolean;fingerprint?:string;createdBy?:string}={}){
 const log:string[]=[];
 const task={id,title:'Task',organizationId:'org-a',createdBy:options.createdBy??'alice',assigneeId:options.assignee??'',departmentId:'warehouse',dueAt:null,status:'pending',version:1};
 const client={release(){log.push('RELEASE');},async query(sql:string){log.push(sql);
 if(sql.includes('FROM foundation_tasks')&&sql.includes('FOR UPDATE'))return {rows:[task]};
 if(sql.includes('FROM directory_people'))return {rows:[{subject:'bob'}]};
 if(sql.includes('AS linked'))return {rows:[{linked:options.linked??false}]};
 if(sql.includes('SELECT 1 FROM task_lifecycle_commands'))return {rows:options.receipt?[{}]:[]};
 if(sql.includes('SELECT fingerprint,result'))return {rows:options.receipt?[{fingerprint:options.fingerprint??'wrong',result:task}]:[]};
 if(sql.startsWith('UPDATE foundation_tasks'))return {rows:[{...task,version:2,assigneeId:'bob'}]};
 if(sql.startsWith('INSERT INTO task_lifecycle_commands')&&options.receiptFailure)throw new Error('receipt failure');
 return {rows:[]};}};
 const pool={query:async()=>({rows:[]}),connect:async()=>client} as unknown as Pool;
 return {pool,log,task};
}
test('linked task is rejected before receipt replay or mutation',async()=>{const f=fixture({linked:true});const repo=await taskLifecycleDatabase(f.pool);await expect(repo.claim(id,{subject:'bob',organizationId:'org-a'},{expectedVersion:1},'key')).rejects.toMatchObject({statusCode:409});expect(f.log.some(s=>s.includes('SELECT fingerprint,result'))).toBe(false);expect(f.log).toContain('ROLLBACK');});
test('revoked assignee cannot replay claim command',async()=>{const f=fixture({assignee:'carol',receipt:true});const repo=await taskLifecycleDatabase(f.pool);await expect(repo.claim(id,{subject:'bob',organizationId:'org-a'},{expectedVersion:1},'key')).rejects.toMatchObject({statusCode:404});expect(f.log.some(s=>s.includes('SELECT fingerprint,result'))).toBe(false);});
test('receipt failure rolls back update and audit in same client transaction',async()=>{const f=fixture({receiptFailure:true});const repo=await taskLifecycleDatabase(f.pool);await expect(repo.claim(id,{subject:'bob',organizationId:'org-a'},{expectedVersion:1},'key')).rejects.toThrow('receipt failure');expect(f.log.some(s=>s.startsWith('UPDATE foundation_tasks'))).toBe(true);expect(f.log.some(s=>s.startsWith('INSERT INTO task_lifecycle_history'))).toBe(true);expect(f.log).toContain('ROLLBACK');expect(f.log).not.toContain('COMMIT');});


test('queue create replay checks current creator before historical receipt',async()=>{
 const input={title:'Task',departmentId:'warehouse'};
 const f=fixture({receipt:true,fingerprint:createFingerprint(input),createdBy:'carol'});
 const repo=await taskLifecycleDatabase(f.pool);
 await expect(repo.createQueue({subject:'alice',organizationId:'org-a'},input,'create')).rejects.toMatchObject({statusCode:404});
 expect(f.log).toContain('ROLLBACK');
});
