/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {test,expect,vi} from 'vitest';
import type {Pool} from 'pg';
import type {WorkflowAudit,WorkflowDefinition,WorkflowRun,WorkflowField} from '@dx/contracts';
import {workflowDatabase} from './database.js';

const actor={subject:'alice',organizationId:'org-a',roles:['employee']};
const definition:WorkflowDefinition={id:'history',version:1,title:'History',startRole:'employee',initialState:'draft',startFields:{},readerRoles:[],transitions:[{id:'revise',from:'draft',to:'draft',role:'employee',fields:{reason:'text',privateNote:'text'}}]};
const run:WorkflowRun={id:'11111111-1111-4111-8111-111111111111',recordId:'11111111-1111-4111-8111-111111111111',definitionId:definition.id,definitionVersion:1,title:'History',ownerId:actor.subject,organizationId:actor.organizationId,state:'draft',version:1,data:{reason:'old data',secret:'never audit'},createdAt:'2026-10-14',updatedAt:'2026-10-14'};
async function fixture(fields:Record<string,WorkflowField>=definition.transitions[0].fields,failReceipt=false){
 let committed=structuredClone(run),audits:WorkflowAudit[]=[],pending=structuredClone(run),pendingAudits:WorkflowAudit[]=[];
 const query=vi.fn(async(sql:string,values?:unknown[])=>{
  if(sql==='BEGIN'){pending=structuredClone(committed);pendingAudits=structuredClone(audits);}
  if(sql==='COMMIT'){committed=pending;audits=pendingAudits;}
  if(sql.startsWith('SELECT')&&sql.includes('FROM workflow_runs'))return {rows:[sql.includes('FOR UPDATE')?pending:committed],rowCount:1};
  if(sql.startsWith('UPDATE workflow_runs')){pending={...pending,state:String(values?.[0]),version:pending.version+1,data:{...pending.data,...JSON.parse(String(values?.[1]))}};return {rows:[pending],rowCount:1};}
  if(sql.startsWith('INSERT INTO workflow_audit'))pendingAudits.push({id:String(values?.[0]),actorId:String(values?.[2]),action:String(values?.[3]),fromState:String(values?.[4]),toState:String(values?.[5]),version:Number(values?.[6]),metadata:sql.includes('metadata')?JSON.parse(String(values?.[7])):null,occurredAt:'2026-10-14T00:00:00Z'});
  if(sql.startsWith('INSERT INTO workflow_commands')&&failReceipt)throw Error('receipt failed');
  if(sql.includes('FROM workflow_audit'))return {rows:structuredClone(audits),rowCount:audits.length};
  return {rows:[],rowCount:0};
 });
 const client={query,release:vi.fn()},pool={query:vi.fn(async(sql:string,values?:unknown[])=>query(sql,values)),connect:vi.fn(async()=>client)} as unknown as Pool;
 const def={...definition,transitions:[{...definition.transitions[0],fields}]};
 const repo=await workflowDatabase(pool,{get:async()=>def,list:async()=>[def]});query.mockClear();vi.mocked(pool.query).mockClear();
 return {repo,query,pool,client};
}
test('transition snapshots only validated declared reason in audit on the transaction client',async()=>{
 const f=await fixture();const value={action:'revise',expectedVersion:1,input:{reason:'  Needs review 🧩  ',privateNote:'private'}};
 const next=await f.repo.transition(run.id,value,actor,'first');
 const audit=(await f.repo.history(run.id,actor))[0];
 expect(audit.metadata).toEqual({reason:'Needs review 🧩'});expect(audit.version).toBe(next.version);
 const calls=f.query.mock.calls,update=calls.findIndex(([sql])=>sql.startsWith('UPDATE workflow_runs')),insert=calls.findIndex(([sql])=>sql.startsWith('INSERT INTO workflow_audit'));
 expect(calls[0][0]).toBe('BEGIN');expect(update).toBeLessThan(insert);expect(calls.findIndex(([sql])=>sql==='COMMIT')).toBeGreaterThan(insert);
 expect(calls[insert][1]?.[7]).toBe(JSON.stringify({reason:'Needs review 🧩'}));
 expect(vi.mocked(f.pool.query).mock.calls.every(([sql])=>!String(sql).startsWith('INSERT')&&!String(sql).startsWith('UPDATE'))).toBe(true);
 await f.repo.transition(run.id,{action:'revise',expectedVersion:2,input:{reason:'Later reason',privateNote:'different private'}},actor,'second');
 const history=await f.repo.history(run.id,actor);expect(history.map(item=>item.metadata)).toEqual([{reason:'Needs review 🧩'},{reason:'Later reason'}]);
 expect((await f.repo.get(run.id,actor)).data.reason).toBe('Later reason');
});
test('reason snapshot accepts 2000 Unicode code points through existing text validation',async()=>{
 const f=await fixture();const reason='🧩'.repeat(2000);
 await f.repo.transition(run.id,{action:'revise',expectedVersion:1,input:{reason,privateNote:'private'}},actor,'unicode');
 expect((await f.repo.history(run.id,actor))[0].metadata).toEqual({reason});
});
test('invalid reason and unexpected inputs have no audit or version effect',async()=>{
 const invalidInputs:Record<string,string>[]=[{reason:'',privateNote:'private'},{reason:'   ',privateNote:'private'},{reason:'🧩'.repeat(2001),privateNote:'private'},{reason:'valid',privateNote:'private',other:'secret'}];
 for(const input of invalidInputs){
  const f=await fixture();await expect(f.repo.transition(run.id,{action:'revise',expectedVersion:1,input},actor,'bad')).rejects.toMatchObject({statusCode:400});
  expect(f.query.mock.calls.some(([sql])=>sql.startsWith('UPDATE')||sql.startsWith('INSERT'))).toBe(false);
  expect(f.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');expect((await f.repo.get(run.id,actor)).version).toBe(1);expect(await f.repo.history(run.id,actor)).toEqual([]);
 }
});
test('undeclared or non-text reason is never copied from current data or other input',async()=>{
 for(const [fields,input] of [[{privateNote:'text'},{privateNote:'private'}],[{reason:'positiveInteger',privateNote:'text'},{reason:'42',privateNote:'private'}]] as [Record<string,WorkflowField>,Record<string,string>][]){
  const f=await fixture(fields);await f.repo.transition(run.id,{action:'revise',expectedVersion:1,input},actor,'no-reason');
  expect((await f.repo.history(run.id,actor))[0].metadata??null).toBeNull();
 }
});
test('late receipt failure rolls back transition and audit together and releases its client',async()=>{
 const f=await fixture(undefined,true);
 await expect(f.repo.transition(run.id,{action:'revise',expectedVersion:1,input:{reason:'Reason',privateNote:'private'}},actor,'fail')).rejects.toThrow('receipt failed');
 const calls=f.query.mock.calls;expect(calls.some(([sql])=>sql.startsWith('UPDATE workflow_runs'))).toBe(true);expect(calls.some(([sql])=>sql.startsWith('INSERT INTO workflow_audit'))).toBe(true);
 expect(calls.at(-1)?.[0]).toBe('ROLLBACK');expect(calls.some(([sql])=>sql==='COMMIT')).toBe(false);expect(f.client.release).toHaveBeenCalledOnce();
 expect((await f.repo.get(run.id,actor)).version).toBe(1);expect(await f.repo.history(run.id,actor)).toEqual([]);
});
