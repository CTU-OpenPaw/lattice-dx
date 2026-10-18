import {test,expect,vi} from 'vitest';
import {parseCreate} from './policy.js';
import {workflowDatabase} from './database.js';
import type {Pool} from 'pg';
const entityId='ABCDEFAB-1111-4111-8111-111111111111';
test('create context is strict, normalized, and optional without changing legacy DTO',()=>{
 const body={definitionId:'x',title:' Test ',input:{}};
 expect(parseCreate({...body,entityContext:{entityId}})).toEqual({...body,title:'Test',entityContext:{entityId:entityId.toLowerCase()}});
 for(const extra of ['ownerId','schemaId','roles'])expect(parseCreate({...body,entityContext:{entityId,[extra]:'x'}})).toBeUndefined();
 expect(parseCreate(body)).toEqual({...body,title:'Test'});
});
test('direct contextual start requires current data role before creating records',async()=>{
 const query=vi.fn(async(sql:string)=>({rows:[],rowCount:sql.startsWith('SELECT 1 FROM directory_people')?1:0})); const client={query,release:vi.fn()};
 const pool={query,connect:async()=>client} as unknown as Pool;
 const def={id:'x',version:1,title:'X',startRole:'employee',initialState:'draft',startFields:{},readerRoles:[],transitions:[]};
 const repo=await workflowDatabase(pool,{get:async()=>def,list:async()=>[def]});
 await expect(repo.create({definitionId:'x',title:'Test',input:{},entityContext:{entityId}} as never,{subject:'alice',organizationId:'org',roles:['workflow:start','employee']},'key')).rejects.toMatchObject({statusCode:403});
 expect(query.mock.calls.some(([sql])=>String(sql).startsWith('INSERT INTO records'))).toBe(false);
});
const eid=entityId.toLowerCase(),rid='11111111-1111-4111-8111-111111111111';
const actor={subject:'alice',organizationId:'org',roles:['workflow:start','employee','data:read']};
const def={id:'x',version:1,title:'X',startRole:'employee',initialState:'draft',startFields:{},readerRoles:['manager'],assignedReader:{field:'assignee',role:'worker',states:['assigned']},transitions:[]};
const run={id:rid,recordId:rid,definitionId:'x',definitionVersion:1,title:'Test',ownerId:'alice',organizationId:'org',state:'draft',version:1,data:{},createdAt:'2026-10-14',updatedAt:'2026-10-14'};
const source={id:eid,schemaId:'business',schemaVersion:2,version:4,archivedAt:null,ownerId:'alice',organizationId:'org'};
async function fixture(options:{replay?:boolean;available?:boolean;owner?:string;archived?:boolean}={}){
 const {createHash}=await import('node:crypto');
 const context={entityId:eid,schemaId:'business',schemaVersion:2,entityVersion:4};
 const value={definitionId:'x',title:'Test',input:{},entityContext:{entityId:eid}};
 const query=vi.fn(async(sql:string,values?:unknown[])=>({rows:
 sql.startsWith('SELECT 1 FROM directory_people')?[{present:true}]:
 sql.startsWith('SELECT fingerprint')&&options.replay?[{fingerprint:createHash('sha256').update(JSON.stringify(value)).digest('hex'),result:{...run,entityContext:context}}]:
 sql.includes('FROM enterprise_entities')?(options.available===false?[]:[{...source,ownerId:options.owner??'alice',archivedAt:options.archived?'2026-10-14':null}]):
 sql.includes('FROM workflow_entity_contexts')&&sql.includes('WHERE run_id=$1')?[context]:
 sql.startsWith('SELECT')&&sql.includes('FROM workflow_runs')?[run]:
 sql.startsWith('INSERT INTO workflow_runs')?[{...run,id:values?.[0],recordId:values?.[0]}]:[],rowCount:sql.startsWith('SELECT 1 FROM directory_people')?1:0}));
 const client={query,release:vi.fn()};const pool={query:vi.fn(async()=>({rows:[],rowCount:0})),connect:vi.fn(async()=>client)} as unknown as Pool;
 const list=vi.fn(async()=>[def]);const repo=await workflowDatabase(pool,{get:async()=>def,list});vi.mocked(pool.query).mockClear();
 return {repo,query,pool,list,context,value};
}
test('creation stores source pin and metadata atomically on caller client with independent record ID',async()=>{
 const {repo,query,pool,value}=await fixture();const created=await repo.createWithClient!({query} as never,value,actor,'new');
 expect(created.entityContext).toEqual({entityId:eid,schemaId:'business',schemaVersion:2,entityVersion:4});expect(created.recordId).toBe(created.id);expect(created.id).not.toBe(eid);
 expect(query.mock.calls.find(([s])=>s.startsWith('INSERT INTO workflow_entity_contexts'))?.[1]).toEqual([created.id,'org',eid,'business',2,4]);
 expect(query.mock.calls.find(([s])=>s.startsWith('INSERT INTO workflow_audit'))?.[1]?.[5]).toBe(JSON.stringify({entityContext:created.entityContext}));
 expect(pool.query).not.toHaveBeenCalled();expect(pool.connect).not.toHaveBeenCalled();
});
test('accepted replay checks stored entity before changed-body conflict and allows only owner archive read',async()=>{
 const revoked=await fixture({replay:true,available:false});await expect(revoked.repo.create({...revoked.value,title:'changed'},actor,'accepted')).rejects.toMatchObject({statusCode:404});
 const owner=await fixture({replay:true,archived:true});expect((await owner.repo.create(owner.value,actor,'accepted')).entityContext).toEqual(owner.context);
 const shared=await fixture({replay:true,owner:'other',archived:true});await expect(shared.repo.create(shared.value,actor,'accepted')).rejects.toMatchObject({statusCode:404});
 const first=await fixture({archived:true});await expect(first.repo.create(first.value,actor,'first')).rejects.toMatchObject({statusCode:409});
});
test('context detail locks run before entity and hides current entity from readable run owner',async()=>{
 const f=await fixture();expect(await f.repo.entityContext!(rid,actor)).toEqual({context:f.context,current:{id:eid,schemaId:'business',schemaVersion:2,version:4,archivedAt:null}});
 const sql=f.query.mock.calls.map(([s])=>s);expect(sql.findIndex(s=>s.includes('FROM workflow_runs')&&s.includes('FOR SHARE'))).toBeLessThan(sql.findIndex(s=>s.includes('FROM enterprise_entities')));
 const hidden=await fixture({available:false});await expect(hidden.repo.entityContext!(rid,actor)).rejects.toMatchObject({statusCode:404});expect(f.pool.query).not.toHaveBeenCalled();
});
test('entity list uses shared owner role and assignee SQL policy before limit on same client',async()=>{
 const f=await fixture();await f.repo.listEntityWorkflows!(eid,{...actor,roles:[...actor.roles,'worker','manager']},{limit:10,offset:20,q:'Test'});
 const call=f.query.mock.calls.find(([s])=>s.includes('JOIN workflow_entity_contexts c'))!;
 expect(call[0]).toContain('r.owner_id=$2');expect(call[0]).toContain('r.data->>');expect(call[0].indexOf('r.data->>')).toBeLessThan(call[0].indexOf(' LIMIT '));expect(call[1]).toEqual(expect.arrayContaining([['x:1'],['assigned'],11,20]));
 expect(f.list).toHaveBeenCalledWith('org',expect.objectContaining({query:f.query}));expect(f.pool.query).not.toHaveBeenCalled();
});
