// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'vitest';
import { validateDefinition } from './registry.js';
import { customDefinition } from './registry.test.js';
import {resolveTypedBinding} from './block-policy.js';
import type {WorkflowRun} from '@dx/contracts';
import {WorkflowError} from './policy.js';
test('typed conversion rejects coercion and preserves decimal and boolean values',()=>{
  const run={data:{}} as WorkflowRun;
  for(const raw of ['01','1e2',' 1','1.0','-0','9007199254740992'])expect(()=>resolveTypedBinding({source:'input',field:'x',as:'integer'},run,{x:raw})).toThrow();
  for(const raw of ['TRUE','1',' false '])expect(()=>resolveTypedBinding({source:'input',field:'x',as:'boolean'},run,{x:raw})).toThrow();
  expect(resolveTypedBinding({source:'input',field:'x',as:'integer'},run,{x:'42'})).toBe(42);
  expect(resolveTypedBinding({source:'input',field:'x',as:'boolean'},run,{x:'false'})).toBe(false);
  expect(resolveTypedBinding({source:'input',field:'x',as:'decimal'},run,{x:'123.40'})).toBe('123.40');
});
const literal=(value:string)=>({source:'literal',value});
const record={id:'handoff',action:'records.create',input:{title:literal('Handoff')}};
const typed={id:'entity',action:'entities.create',input:{schemaId:'invoice',schemaVersion:1,title:literal('Private'),attributes:{amount:{source:'input',field:'amount',as:'integer'}}}};
test('typed entity declaration accepts typed values but rejects authority and result attribute injection',()=>{
  const check=(step:unknown)=>validateDefinition({...customDefinition,transitions:[{...customDefinition.transitions[0],fields:{amount:'text'},steps:[step]}]});
  expect(()=>check(typed)).not.toThrow();
  for(const attributes of [{constructor:literal('x')},{amount:{source:'result',stepId:'entity',field:'attributes'}},{amount:{source:'input',field:'amount',as:'script'}}]) expect(()=>check({...typed,input:{...typed.input,attributes}})).toThrow();
  expect(()=>check({...typed,input:{...typed.input,ownerId:literal('alice')}})).toThrow();
});

test.each([
  {...typed,input:{...typed.input,schemaId:'Invalid schema'}},
  {...typed,input:{...typed.input,schemaVersion:0}},
  {...typed,input:{...typed.input,attributes:{constructor:literal('x')}}},
  {id:'archive',action:'entities.archive',input:{id:literal('id'),expectedVersion:0}},
])('invalid entity declarations produce controlled workflow errors',step=>{
  try {validateDefinition({...customDefinition,transitions:[{...customDefinition.transitions[0],fields:{amount:'text'},steps:[step]}]});throw new Error('accepted invalid entity');}
  catch(error){expect(error).toBeInstanceOf(WorkflowError);expect(error).toMatchObject({statusCode:400});}
});
function definition(steps:unknown[]){return {...customDefinition,transitions:[{...customDefinition.transitions[0],steps}]};}
test('accepts ordered record/task/connector steps and rejects unsafe or unknown bindings',()=>{
  expect(()=>validateDefinition(definition([record,{id:'assign',action:'tasks.create',input:{title:literal('Review'),recordId:{source:'result',stepId:'handoff',field:'id'}},assignment:{kind:'department',department:literal('it'),role:'tasks:decide'}},{id:'send',action:'connectors.dispatch',input:{connectorId:literal('agent'),operation:literal('handoff.request'),payload:{recordId:{source:'result',stepId:'handoff',field:'id'}}}}]))).not.toThrow();
  for(const steps of [[{...record,action:'eval'}],[record,record],Array(11).fill(record),[{...record,input:{title:{source:'data',field:'unknown'}}}],[{...record,input:{title:{source:'input',field:'request'}}}],[{...record,input:{title:{source:'context',field:'organizationId'}}}],[{...record,input:{title:{source:'result',stepId:'later',field:'id'}}}],[{...record,input:{title:literal('x'),url:literal('https://example.com')}}],[{id:'assign',action:'tasks.create',input:{title:literal('x'),assigneeId:literal('alice')},assignment:{kind:'department',department:literal('it'),role:'tasks:decide'}}]])expect(()=>validateDefinition(definition(steps))).toThrow();
});

test('malformed later transition is rejected with controlled configuration error',()=>{
  for(const invalid of [null,1,'invalid',[]]) {
    try{validateDefinition({...definition([record]),transitions:[{...customDefinition.transitions[0],steps:[record]},invalid]});throw new Error('accepted invalid transition');}
    catch(error){expect(error).toMatchObject({statusCode:400});}
  }
});

test('department selection binding is validated and still excludes input assignee', () => {
  const task = { id: 'assign', action: 'tasks.create', input: { title: literal('Review') }, assignment: { kind: 'department', department: literal('it'), role: 'tasks:decide', assigneeId: literal('bob') } };
  expect(() => validateDefinition(definition([task]))).not.toThrow();
  expect(() => validateDefinition(definition([{ ...task, assignment: { ...task.assignment, assigneeId: { source: 'input', field: 'unknown' } } }]))).toThrow();
  expect(() => validateDefinition(definition([{ ...task, input: { ...task.input, assigneeId: literal('bob') } }]))).toThrow();
});
