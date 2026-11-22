/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { expect, test, vi } from 'vitest';
import type { PoolClient } from 'pg';
import type { WorkflowActor, WorkflowRun, WorkflowStep } from '@dx/contracts';
import { executeBlocks } from './block-database.js';
import type {Entity} from '../entities/types.js';
const actor:WorkflowActor={subject:'alice',organizationId:'org',roles:['records:write','tasks:assign','workflow:integrate']};
const run:WorkflowRun={id:'00000000-0000-4000-8000-000000000001',recordId:'00000000-0000-4000-8000-000000000001',definitionId:'hr-request',definitionVersion:1,title:'HR',ownerId:'alice',organizationId:'org',state:'done',version:2,data:{},createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
const literal=<T extends string>(value:T)=>({source:'literal' as const,value});
const record:WorkflowStep={id:'record',action:'records.create',input:{title:literal('Handoff')}};
test('typed create pins publication and stores only metadata under actual actor',async()=>{
  const id='00000000-0000-4000-8000-000000000003';
  const query=vi.fn(async(sql:string,values?:unknown[])=>{
    if(sql.includes('FROM enterprise_schema_versions'))return {rows:[{version:1,definition:{id:'invoice',title:'Invoice',fields:{amount:{type:'integer'}},relations:{}}}],rowCount:1};
    if(sql.startsWith('INSERT INTO enterprise_entities'))return {rows:[{id,schemaId:'invoice',schemaVersion:1,title:values![5],attributes:JSON.parse(values![6] as string),ownerId:values![2],organizationId:'org',version:1,archivedAt:null,createdAt:run.createdAt,updatedAt:run.updatedAt}],rowCount:1};
    return {rows:[],rowCount:1};
  });
  const step:WorkflowStep={id:'entity',action:'entities.create',input:{schemaId:'invoice',schemaVersion:1,title:literal('Secret title'),attributes:{amount:{source:'input',field:'amount',as:'integer'}}}};
  await executeBlocks({query} as unknown as PoolClient,[step],run,{amount:'42'},{...actor,subject:'bob',roles:['data:write']});
  expect(query.mock.calls.find(([sql])=>sql.includes('FROM enterprise_schema_versions'))![1]).toEqual(['org','invoice',1]);
  expect(query.mock.calls.find(([sql])=>sql.startsWith('INSERT INTO enterprise_entities'))![1]![2]).toBe('bob');
  const evidence=query.mock.calls.find(([sql])=>sql.startsWith('INSERT INTO workflow_action_results'))![1]!;
  expect(JSON.parse(evidence[5] as string)).toEqual({schemaId:'invoice',schemaVersion:1});
  expect(JSON.parse(evidence[6] as string)).toEqual({id,version:1,schemaVersion:1});
  expect(query.mock.calls.some(([sql])=>/BEGIN|COMMIT|enterprise_commands/.test(sql))).toBe(false);
});
test('missing prelocked entity produces controlled workflow 404',async()=>{
  const query=vi.fn(async()=>({rows:[],rowCount:0}));
  await expect(executeBlocks({query} as unknown as PoolClient,[{id:'read',action:'entities.read',input:{id:literal('00000000-0000-4000-8000-000000000010')}}],run,{}, {...actor,roles:['data:read']})).rejects.toBeInstanceOf((await import('./policy.js')).WorkflowError);
});
test('read and query metadata omit private snapshots and require data read capability',async()=>{
  const id='00000000-0000-4000-8000-000000000010';
  const row={id,schemaId:'invoice',schemaVersion:1,title:'Secret title',attributes:{amount:42},ownerId:'alice',organizationId:'org',version:1,archivedAt:null,createdAt:run.createdAt,updatedAt:run.updatedAt};
  const query=vi.fn(async(sql:string)=>({rows:sql.includes('enterprise_schema_versions')?[{version:1,definition:{id:'invoice',fields:{amount:{type:'integer'}},relations:{}}}]:sql.startsWith('SELECT')?[row]:[],rowCount:1}));
  const steps:WorkflowStep[]=[{id:'read',action:'entities.read',input:{id:literal(id)}},{id:'query',action:'entities.query',input:{schemaId:'invoice',schemaVersion:1,filters:[{field:'amount',operator:'eq',value:{source:'input',field:'amount',as:'integer'}}],limit:1}}];
  await expect(executeBlocks({query} as unknown as PoolClient,steps,run,{amount:'42'},actor)).rejects.toMatchObject({statusCode:403});
  expect(query).not.toHaveBeenCalled();
  await executeBlocks({query} as unknown as PoolClient,steps,run,{amount:'42'},{...actor,roles:['data:read']});
  const evidence=query.mock.calls.filter(([sql])=>sql.startsWith('INSERT INTO workflow_action_results'));
  expect(evidence).toHaveLength(2);
  expect(JSON.stringify(evidence)).not.toContain('Secret title');
  expect(JSON.stringify(evidence)).not.toContain('attributes');
  const search=query.mock.calls.find(([sql])=>sql.includes('LIMIT')&&sql.includes('enterprise_entities'))![0];
  expect(search).toContain('enterprise_entity_shares');
  expect(search.indexOf('enterprise_entity_shares')).toBeLessThan(search.indexOf('LIMIT'));
});
test('update link unlink archive share one client, preserve pins and lock existing UUIDs in sorted order',async()=>{
  const sourceId='00000000-0000-4000-8000-000000000020',targetId='00000000-0000-4000-8000-000000000010';
  const make=(id:string)=>({id,schemaId:'invoice',schemaVersion:1,title:'Secret title',attributes:{amount:1},ownerId:'alice',organizationId:'org',version:1,archivedAt:null,createdAt:run.createdAt,updatedAt:run.updatedAt});
  const state=new Map<string,Entity>([sourceId,targetId].map(id=>[id,make(id)]));
  const query=vi.fn(async(sql:string,values?:unknown[])=>{
    if(sql.includes('FROM enterprise_schema_versions'))return {rows:[{version:1,definition:{id:'invoice',fields:{amount:{type:'integer'}},relations:{related:{targetSchemaId:'invoice'}}}}],rowCount:1};
    if(sql.startsWith('SELECT'))return {rows:[state.get(values![0] as string)!],rowCount:1};
    if(sql.startsWith('UPDATE enterprise_entities')){const before=state.get(values![0] as string)!;const after={...before,title:values![1] as string,attributes:JSON.parse(values![2] as string),version:before.version+1,archivedAt:values![3]?run.updatedAt:null};state.set(after.id,after);return {rows:[after],rowCount:1};}
    return {rows:sql.includes('enterprise_relations')?[{source_id:sourceId}]:[],rowCount:1};
  });
  const prior=(stepId:string)=>({source:'result' as const,stepId,field:'version' as const});
  const steps:WorkflowStep[]=[{id:'update',action:'entities.update',input:{id:literal(sourceId),expectedVersion:1,title:literal('New secret'),attributes:{amount:{source:'literal',value:2}}}},{id:'link',action:'entities.link',input:{id:literal(sourceId),targetId:literal(targetId),name:'related',expectedVersion:prior('update')}},{id:'unlink',action:'entities.unlink',input:{id:literal(sourceId),targetId:literal(targetId),name:'related',expectedVersion:prior('link')}},{id:'archive',action:'entities.archive',input:{id:literal(sourceId),expectedVersion:prior('unlink')}}];
  await executeBlocks({query} as unknown as PoolClient,steps,run,{}, {...actor,roles:['data:write']});
  expect(query.mock.calls.filter(([sql])=>sql.includes('FOR UPDATE')).map(([,values])=>values![0])).toEqual([targetId,sourceId]);
  expect(state.get(sourceId)).toMatchObject({version:5,schemaVersion:1,archivedAt:run.updatedAt});
  expect(query.mock.calls.filter(([sql])=>sql.includes('FROM enterprise_schema_versions')).every(([,values])=>values![2]===1)).toBe(true);
  expect(query.mock.calls.filter(([sql])=>sql.startsWith('INSERT INTO workflow_action_results'))).toHaveLength(4);
  expect(JSON.stringify(query.mock.calls.filter(([sql])=>sql.startsWith('INSERT INTO workflow_action_results')))).not.toContain('secret');
});
test('revoked entity edit grant and non-owner archive deny without writes',async()=>{
  const id='00000000-0000-4000-8000-000000000010';
  const row={id,schemaId:'invoice',schemaVersion:1,title:'Private',attributes:{},ownerId:'bob',organizationId:'org',version:1,archivedAt:null,createdAt:run.createdAt,updatedAt:run.updatedAt};
  const query=vi.fn(async(sql:string)=>({rows:sql.includes('enterprise_entities')?[row]:[],rowCount:sql.includes('enterprise_entities')?1:0}));
  const update:WorkflowStep={id:'update',action:'entities.update',input:{id:literal(id),expectedVersion:1,title:literal('Changed'),attributes:{}}};
  for(const step of [update,{id:'archive',action:'entities.archive',input:{id:literal(id),expectedVersion:1}} as WorkflowStep]) await expect(executeBlocks({query} as unknown as PoolClient,[step],run,{}, {...actor,roles:['data:write']})).rejects.toMatchObject({statusCode:404});
  expect(query.mock.calls.some(([sql])=>sql.startsWith('UPDATE')||sql.startsWith('INSERT'))).toBe(false);
});

test('result aliases retain sorted existing locks and fresh create IDs need no second row lock',async()=>{
  const lower='00000000-0000-4000-8000-000000000010',higher='00000000-0000-4000-8000-000000000020',created='00000000-0000-4000-8000-000000000005';
  const make=(id:string):Entity=>({id,schemaId:'invoice',schemaVersion:1,title:'Private',attributes:{},ownerId:'alice',organizationId:'org',version:1,archivedAt:null,createdAt:run.createdAt,updatedAt:run.updatedAt});
  const query=vi.fn(async(sql:string,values?:unknown[])=>{
    if(sql.includes('enterprise_schema_versions'))return {rows:[{version:1,definition:{id:'invoice',title:'Invoice',fields:{},relations:{}}}],rowCount:1};
    if(sql.startsWith('SELECT'))return {rows:[make(values![0] as string)],rowCount:1};
    if(sql.startsWith('INSERT INTO enterprise_entities'))return {rows:[make(created)],rowCount:1};
    return {rows:[],rowCount:1};
  });
  const resultId=(stepId:string)=>({source:'result' as const,stepId,field:'id' as const});
  const steps:WorkflowStep[]=[
    {id:'higher',action:'entities.read',input:{id:literal(higher)}},
    {id:'alias',action:'entities.read',input:{id:resultId('higher')}},
    {id:'lower',action:'entities.read',input:{id:literal(lower)}},
    {id:'create',action:'entities.create',input:{schemaId:'invoice',schemaVersion:1,title:literal('Private'),attributes:{}}},
    {id:'createdRead',action:'entities.read',input:{id:resultId('create')}},
  ];
  await executeBlocks({query} as unknown as PoolClient,steps,run,{}, {...actor,roles:['data:read','data:write']});
  expect(query.mock.calls.filter(([sql])=>sql.includes('FOR UPDATE')).map(([,values])=>values![0])).toEqual([lower,higher]);
  const evidence=query.mock.calls.filter(([sql])=>sql.startsWith('INSERT INTO workflow_action_results'));
  expect(JSON.parse(evidence[1][1]![6] as string)).toEqual({id:higher,version:1,schemaVersion:1});
  expect(JSON.parse(evidence[4][1]![6] as string)).toEqual({id:created,version:1,schemaVersion:1});
});
test('uses only active client and persists record, task and connector execution evidence',async()=>{
  const query=vi.fn(async(sql:string,_values?:unknown[])=>({rows:sql.includes('directory_people')?[{subject:'bob'}]:sql.includes('SELECT 1 FROM records')?[{}]:[],rowCount:1}));
  const steps:WorkflowStep[]=[record,{id:'task',action:'tasks.create',input:{title:literal('Review'),recordId:{source:'result',stepId:'record',field:'id'}},assignment:{kind:'department',department:literal('it'),role:'tasks:decide'}},{id:'send',action:'connectors.dispatch',input:{connectorId:literal('agent'),operation:literal('request'),payload:{record:{source:'result',stepId:'record',field:'id'}}}}];
  await executeBlocks({query} as unknown as PoolClient,steps,run,{},actor);
  expect(query.mock.calls.filter(([sql])=>sql.startsWith('INSERT INTO workflow_action_results'))).toHaveLength(3);
  expect(query.mock.calls.filter(([sql])=>sql.startsWith('INSERT INTO workflow_action_results')).map(call=>(call as unknown as [string,unknown[]])[1][7])).toEqual([0,1,2]);
  expect(query.mock.calls.some(([sql])=>sql.includes('workflow_task_links'))).toBe(false);
  expect(query.mock.calls.filter(([sql])=>sql.startsWith('INSERT INTO workflow_jobs'))).toHaveLength(1);
});
test('requires each signed action role and rejects zero or ambiguous department recipients',async()=>{
  const task:WorkflowStep={id:'task',action:'tasks.create',input:{title:literal('Review')},assignment:{kind:'department',department:literal('it'),role:'tasks:decide'}};
  const query=vi.fn(async()=>({rows:[],rowCount:0}));
  await expect(executeBlocks({query} as unknown as PoolClient,[record],run,{}, {...actor,roles:['workflow:start']})).rejects.toMatchObject({statusCode:403});
  expect(query).not.toHaveBeenCalled();
  await expect(executeBlocks({query} as unknown as PoolClient,[task],run,{},actor)).rejects.toMatchObject({statusCode:400});
  query.mockResolvedValue({rows:[{subject:'a'},{subject:'b'}] as never[],rowCount:2});
  await expect(executeBlocks({query} as unknown as PoolClient,[task],run,{},actor)).rejects.toMatchObject({statusCode:409});
});

test('connector audit preserves routing identity when payload uses the same names',async()=>{
  const calls:{sql:string;values?:unknown[]}[]=[];
  const query=async(sql:string,values?:unknown[])=>{calls.push({sql,values});return {rows:[],rowCount:1};};
  await executeBlocks({query} as unknown as PoolClient,[{id:'send',action:'connectors.dispatch',input:{connectorId:literal('agent'),operation:literal('request'),payload:{connectorId:literal('fake'),operation:literal('fake')}}}],run,{},actor);
  const evidence=JSON.parse(calls.find(call=>call.sql.startsWith('INSERT INTO workflow_action_results'))!.values![5] as string);
  expect(evidence).toEqual({connectorId:'agent',operation:'request',payload:{connectorId:'fake',operation:'fake'}});
});

test('explicit department selection validates the chosen member instead of arbitrarily routing among candidates', async () => {
  const step: WorkflowStep = {
    id: 'task', action: 'tasks.create', input: { title: literal('Review') },
    assignment: { kind: 'department', department: literal('it'), role: 'tasks:decide', assigneeId: { source: 'input', field: 'selectedPerson' } },
  };
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes('directory_people')) {
      if (values?.[3] === 'bob') return { rows: [{ subject: 'bob' }], rowCount: 1 };
      return { rows: [{ subject: 'bob' }, { subject: 'carol' }], rowCount: 2 };
    }
    return { rows: [], rowCount: 1 };
  });
  await executeBlocks({ query } as unknown as PoolClient, [step], run, { selectedPerson: 'bob' }, actor);
  const lookup = query.mock.calls.find(([sql]) => sql.includes('directory_people'))!;
  expect(lookup[0]).toContain('department_id=$2');
  expect(lookup[0]).toContain('enabled=true');
  expect(lookup[0]).toContain('roles @> $3::jsonb');
  expect(lookup[0]).toContain('subject=$4');
  expect(lookup[1]).toEqual(['org', 'it', '["tasks:decide"]', 'bob']);
  const insert = query.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO foundation_tasks'))!;
  expect(insert[1]?.[3]).toBe('bob');
});

test.each(['wrong-department', 'foreign', 'disabled', 'missing-role'])('explicit department selection rejects %s without fallback', async selectedPerson => {
  const step: WorkflowStep = {
    id: 'task', action: 'tasks.create', input: { title: literal('Review') },
    assignment: { kind: 'department', department: literal('it'), role: 'tasks:decide', assigneeId: literal(selectedPerson) },
  };
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes('directory_people') && values?.[3] === selectedPerson) return { rows: [], rowCount: 0 };
    return { rows: [{ subject: 'bob' }], rowCount: 1 };
  });
  await expect(executeBlocks({ query } as unknown as PoolClient, [step], run, {}, actor)).rejects.toMatchObject({ statusCode: 400 });
  expect(query.mock.calls.filter(([sql]) => sql.includes('directory_people'))).toHaveLength(1);
  expect(query.mock.calls.some(([sql]) => sql.startsWith('INSERT'))).toBe(false);
});
