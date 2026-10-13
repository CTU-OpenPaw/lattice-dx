// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'vitest';
import { validateDefinition } from './registry.js';
import { customDefinition } from './registry.test.js';
const literal=(value:string)=>({source:'literal',value});
const record={id:'handoff',action:'records.create',input:{title:literal('Handoff')}};
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
