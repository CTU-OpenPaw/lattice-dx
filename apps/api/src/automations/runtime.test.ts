import {expect,test,vi} from 'vitest';
import type {Pool} from 'pg';
import {automationRuntime} from './runtime.js';
import {WorkflowError} from '../workflows/policy.js';
const rule={id:'rule',schemaId:'invoice',schemaVersion:1,operations:['entity.create'],serviceId:'automation',definitionId:'flow',definitionVersion:1,title:{source:'event',field:'entityId'},input:{event:{source:'event',field:'eventId'}},enabled:true};
const event={id:'event',entityId:'11111111-1111-1111-1111-111111111111',schemaId:'invoice',schemaVersion:1,toVersion:1,operation:'entity.create'};
const def={id:'flow',version:1,title:'Flow',startRole:'start',initialState:'new',startFields:{event:'text'},readerRoles:[],transitions:[{id:'advance',from:'new',to:'done',role:'step',fields:{}}]};
function fixture(options:{changed?:boolean;serviceOff?:boolean;transition?:boolean;attempts?:number;failure?:Error;depth?:number;retry?:boolean;replay?:boolean}={}){
 const calls:{sql:string;v:unknown[]}[]=[];const snapshot={...rule,...(options.transition?{transitionId:'advance'}:{})};
 const delivery={id:'delivery',organization_id:'org',rule_id:'rule',rule_revision:1,event_id:'event',rule_snapshot:snapshot,event_snapshot:{...event,automationDepth:options.depth??0},status:options.retry?'failed':'pending',attempts:options.attempts??0,version:1,due:true};
 const client={release:vi.fn(),async query(sql:string,v:unknown[]=[]){calls.push({sql,v});if(sql.includes('SELECT id FROM entity_automation_deliveries'))return {rows:[{id:'delivery'}]};if(sql.includes('SELECT *,available_at')||sql.startsWith('SELECT * FROM entity_automation_deliveries'))return {rows:[delivery]};if(sql.includes('FROM entity_automation_rules'))return {rows:[{enabled:true,revision:options.changed?2:1,snapshot}]};if(sql.includes('SELECT subject FROM workflow_services'))return {rows:options.serviceOff?[]:[{subject:'actual-service'}]};if(sql.includes('SELECT subject,roles'))return {rows:[{subject:'actual-service',roles:['workflow:service','workflow:start','data:read','start','step']}]};if(sql.includes('FROM enterprise_schema_versions'))return {rows:[{version:1}]};if(sql.includes('FROM enterprise_entities'))return {rows:[{id:event.entityId,schemaId:'invoice',schemaVersion:1,version:4,archivedAt:null,ownerId:'actual-service',organizationId:'org'}]};if(sql.startsWith('UPDATE entity_automation_deliveries')&&sql.includes('RETURNING'))return {rows:[{id:'delivery',status:'pending',version:2,availableAt:new Date(),createdAt:new Date(),completedAt:null}]};return {rows:[],rowCount:0};}};
 const pool={query:client.query,connect:async()=>client} as unknown as Pool;
 const createWithClient=vi.fn(async()=>({id:'run',definitionId:'flow',definitionVersion:1,version:1}));
 const transitionWithClient=vi.fn(async()=>{if(options.failure)throw options.failure;return {id:'run',definitionId:'flow',definitionVersion:1,version:2};});
 return {calls,client,createWithClient,transitionWithClient,runtime:automationRuntime(pool,{get:async()=>def} as never,{createWithClient,transitionWithClient} as never)};
}
test('due claim releases candidate connection then locks delivery skip locked and starts with actual service and context',async()=>{
 const f=fixture();expect(await f.runtime.tickOne()).toEqual({deliveryId:'delivery',status:'succeeded'});
 expect(f.calls.some(c=>c.sql.includes('FOR UPDATE SKIP LOCKED'))).toBe(true);
 expect(f.createWithClient).toHaveBeenCalledWith(f.client,{definitionId:'flow',definitionVersion:1,title:event.entityId,input:{event:'event'},entityContext:{entityId:event.entityId}},expect.objectContaining({subject:'actual-service'}),'automation:delivery');
 const receipt=f.calls.findIndex(c=>c.sql.includes('INSERT INTO entity_automation_receipts'));expect(receipt).toBeGreaterThan(0);expect(f.calls.at(-1)?.sql).toBe('COMMIT');
});
const admin={subject:'admin',organizationId:'org',roles:['workflow:design','data:automate']};
test('retry checks fresh profile and current revision before resetting only failed delivery with versioned receipt',async()=>{
 const f=fixture({retry:true});expect(await f.runtime.retry('rule','delivery',1,admin,'retry-1')).toMatchObject({status:'pending',version:2});
 expect(f.calls.some(c=>c.sql.includes('INSERT INTO entity_automation_commands'))).toBe(true);
 const off=fixture({retry:true,serviceOff:true});await expect(off.runtime.retry('rule','delivery',1,admin,'retry-1')).rejects.toThrow('service_unavailable');
 const changed=fixture({retry:true,changed:true});await expect(changed.runtime.retry('rule','delivery',1,admin,'retry-1')).rejects.toThrow('rule_changed');
 const wrongVersion=fixture({retry:true});await expect(wrongVersion.runtime.retry('rule','delivery',2,admin,'retry-1')).rejects.toThrow('version_conflict');
});
test('superseded rule cancels and current disabled service fails without creating run',async()=>{
 const changed=fixture({changed:true});expect(await changed.runtime.tickOne()).toEqual({deliveryId:'delivery',status:'cancelled'});expect(changed.createWithClient).not.toHaveBeenCalled();
 const off=fixture({serviceOff:true});expect(await off.runtime.tickOne()).toEqual({deliveryId:'delivery',status:'failed'});expect(off.createWithClient).not.toHaveBeenCalled();
});
test('late transition failure rolls back savepoint before sanitized attempt and terminal status',async()=>{
 const f=fixture({transition:true,failure:new WorkflowError(403,'secret business data')});expect(await f.runtime.tickOne()).toEqual({deliveryId:'delivery',status:'failed'});
 const rollback=f.calls.findIndex(c=>c.sql==='ROLLBACK TO SAVEPOINT automation_attempt');expect(rollback).toBeGreaterThan(0);
 expect(f.calls.slice(rollback+1).some(c=>c.sql.includes('INSERT INTO entity_automation_attempts'))).toBe(true);
 expect(JSON.stringify(f.calls.slice(rollback+1))).not.toContain('secret business data');
 expect(f.transitionWithClient).toHaveBeenCalledWith(f.client,'run',{action:'advance',expectedVersion:1,input:{}},expect.objectContaining({subject:'actual-service'}),'automation:delivery');
});
test('unknown failure retries at most three attempts',async()=>{
 for(const attempts of [0,1,2]){const f=fixture({transition:true,failure:new Error('secret SQL'),attempts});expect((await f.runtime.tickOne())?.status).toBe(attempts<2?'pending':'failed');}
});
test('same schema creating transitions propagate server derived bounded chain depth only on transaction client',async()=>{
 const f=fixture({transition:true,depth:7});expect((await f.runtime.tickOne())?.status).toBe('succeeded');
 expect(f.calls.some(c=>c.sql.includes("set_config('latticedx.automation_depth'")&&c.v[0]==='8')).toBe(true);
});
