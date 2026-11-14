/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {it,expect,vi} from 'vitest';
import type {Pool,QueryResult} from 'pg';
import {workflowDatabase} from './database.js';
const entityId='11111111-1111-4111-8111-111111111111';
const actor={subject:'owner',organizationId:'org',roles:['employee','workflow:start','data:read']};
const binding={id:'business',definitionId:'flow',schemaId:'business',schemaVersion:1,allowedTransitions:['allowed']};
const definition={id:'flow',version:1,title:'Flow',startRole:'employee',initialState:'draft',startFields:{},readerRoles:[],transitions:[{id:'allowed',from:'draft',to:'done',role:'employee',fields:{}}]};
async function fixture(schemaId='business',schemaVersion=1,receiptFailure=false){
 const query=vi.fn(async(sql:string,values?:unknown[]):Promise<QueryResult>=>{
  if(receiptFailure&&sql.startsWith('INSERT INTO workflow_starts'))throw Error('receipt failed');
  return {rows:sql.includes('SELECT m.enabled')?[{enabled:true,isOwner:true,definitionVersion:1,id:'module',version:'1.0.0',manifest:{schemas:[{id:'business'}],dependencies:[],bindings:[binding]}}]:sql.includes('FROM enterprise_entities')?[{id:entityId,schemaId,schemaVersion,version:3,ownerId:'owner',organizationId:'org'}]:sql.startsWith('INSERT INTO workflow_runs')?[{id:values?.[0],recordId:values?.[0],definitionId:'flow',definitionVersion:1,title:'Flow',ownerId:'owner',organizationId:'org',state:'draft',version:1,data:{},binding:JSON.parse(String(values?.[8])),createdAt:'2026-10-14',updatedAt:'2026-10-14'}]:[],rowCount:0,command:'SELECT',oid:0,fields:[]};
 });
 const client={query,release:vi.fn()};const pool={query,connect:vi.fn(async()=>client)} as unknown as Pool;
 const repo=await workflowDatabase(pool,{get:async()=>definition,list:async()=>[definition]});query.mockClear();return {query,repo,client,pool};
}
it('shared create denies missing context and wrong schema or pin before writes',async()=>{
 for(const [schema,pin,context] of [['business',1,false],['other',1,true],['business',2,true]] as const){
 const f=await fixture(schema,pin);await expect(f.repo.create({definitionId:'flow',title:'Flow',input:{},...(context?{entityContext:{entityId}}:{})},actor,'start')).rejects.toMatchObject({statusCode:409});
 expect(f.query.mock.calls.some(([s])=>s.startsWith('INSERT INTO records'))).toBe(false);
 }
});
it('locks module before entity and persists derived binding and context on caller client',async()=>{
 const f=await fixture();const run=await f.repo.createWithClient!(f.client as never,{definitionId:'flow',title:'Flow',input:{},entityContext:{entityId}},actor,'start');
 expect(run.binding).toEqual({moduleId:'module',moduleVersion:'1.0.0',bindingId:'business',allowedTransitions:['allowed']});
 const sql=f.query.mock.calls.map(([s])=>s);expect(sql.findIndex(s=>s.includes('FOR SHARE OF m'))).toBeLessThan(sql.findIndex(s=>s.includes('FROM enterprise_entities')));
 expect(JSON.parse(String(f.query.mock.calls.find(([s])=>s.startsWith('INSERT INTO workflow_starts'))?.[1]?.[5])).binding).toEqual(run.binding);expect(f.pool.connect).not.toHaveBeenCalled();
});
it('receipt failure rolls back run, source association and binding together',async()=>{
 const f=await fixture('business',1,true);await expect(f.repo.create({definitionId:'flow',title:'Flow',input:{},entityContext:{entityId}},actor,'start')).rejects.toThrow('receipt failed');expect(f.query.mock.calls.map(([s])=>s)).toContain('ROLLBACK');expect(f.query.mock.calls.some(([s])=>s==='COMMIT')).toBe(false);
});
it('fresh generic starts reject a disabled exact schema dependency before entity locks',async()=>{
 const f=await fixture();
 const original=f.query.getMockImplementation()!;
 f.query.mockImplementation(async(sql,values)=>sql.includes('WITH ownership')?{rows:[
  {enabled:true,isOwner:true,definitionVersion:1,id:'module',version:'1.0.0',manifest:{schemas:[],dependencies:[{id:'dependency',version:'1.0.0'}],bindings:[binding]}},
  {enabled:false,id:'dependency',version:'1.0.0',isOwner:false,manifest:{schemas:[{id:'business'}]}}
 ],rowCount:2,command:'SELECT',oid:0,fields:[]}:original(sql,values));
 await expect(f.repo.create({definitionId:'flow',title:'Flow',input:{},entityContext:{entityId}},actor,'fresh')).rejects.toMatchObject({statusCode:409});
 expect(f.query.mock.calls.some(([s])=>s.includes('FROM enterprise_entities'))).toBe(false);
});
