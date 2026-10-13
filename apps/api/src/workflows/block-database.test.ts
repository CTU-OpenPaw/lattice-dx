// SPDX-License-Identifier: Apache-2.0
import { expect, test, vi } from 'vitest';
import type { PoolClient } from 'pg';
import type { WorkflowActor, WorkflowRun, WorkflowStep } from '@dx/contracts';
import { executeBlocks } from './block-database.js';
const actor:WorkflowActor={subject:'alice',organizationId:'org',roles:['records:write','tasks:assign','workflow:integrate']};
const run:WorkflowRun={id:'00000000-0000-4000-8000-000000000001',recordId:'00000000-0000-4000-8000-000000000001',definitionId:'hr-request',definitionVersion:1,title:'HR',ownerId:'alice',organizationId:'org',state:'done',version:2,data:{},createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
const literal=<T extends string>(value:T)=>({source:'literal' as const,value});
const record:WorkflowStep={id:'record',action:'records.create',input:{title:literal('Handoff')}};
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
