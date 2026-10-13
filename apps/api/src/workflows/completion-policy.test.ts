import { expect, test } from 'vitest';
import { completionResult, conditionMatches, parseCompletion } from './completion-policy.js';
import { availableTransitions, planTransition, validateInput } from './policy.js';
import { validateDefinition } from './registry.js';
import type { WorkflowActor, WorkflowDefinition, WorkflowRun } from '@dx/contracts';
test('guards fail closed and compare literal strings', () => {
  expect(conditionMatches({field:'amount',operator:'gt',value:'2'}, {amount:'3'})).toBe(true);
  for (const amount of ['Infinity','3e2',' 3','0x10','', '3\n', '3\r', '999999999999999999999']) expect(conditionMatches({field:'amount',operator:'gt',value:'2'}, {amount})).toBe(false);
  expect(conditionMatches({field:'note',operator:'exists'}, {note:' '})).toBe(true);
  expect(conditionMatches({field:'toString',operator:'exists'}, {})).toBe(false);
  expect(conditionMatches({field:'note',operator:'eq',value:'a'}, {note:'a'})).toBe(true);
});
test('completion body rejects authority overrides and failed success data', () => {
  expect(parseCompletion({status:'succeeded',result:{count:'2'}})).toEqual({status:'succeeded',result:{count:'2'}});
  expect(parseCompletion({status:'failed',result:{count:'2'}})).toBeUndefined();
  expect(parseCompletion({status:'succeeded',result:{},organizationId:'other'})).toBeUndefined();
  for(const status of [['succeeded'], {toString:()=> 'succeeded'}, null, 1]) expect(parseCompletion({status,result:{}})).toBeUndefined();
  expect(parseCompletion({status:'failed',result:{}})).toBeUndefined();
});
test('positive integer inputs and completion results reject trailing newlines',()=>{
  const config={stepId:'task',successState:'ready',failureState:'failed',resultFields:{count:'positiveInteger' as const},timeoutSeconds:20};
  for(const count of ['1\n','1\r']) {
    expect(()=>validateInput({count:'positiveInteger'},{count})).toThrow();
    expect(()=>completionResult(config,{status:'succeeded',result:{count}})).toThrow();
  }
  expect(validateInput({count:'positiveInteger'},{count:'1000000'})).toEqual({count:'1000000'});
  expect(()=>completionResult(config,{status:'succeeded',result:{count:'1000001'}})).toThrow();
});
const definition:WorkflowDefinition={id:'completion-test',version:1,title:'Completion',startRole:'employee',initialState:'draft',startFields:{request:'text'},readerRoles:[],transitions:[
  {id:'assign',from:'draft',to:'pending',role:'employee',fields:{},steps:[{id:'task',action:'tasks.create',input:{title:{source:'context',field:'title'},assigneeId:{source:'context',field:'ownerId'}}}],wait:{stepId:'task',successState:'ready',failureState:'failed',resultFields:{count:'positiveInteger'},timeoutSeconds:20}},
  {id:'finish',from:'ready',to:'done',role:'employee',fields:{},condition:{field:'count',operator:'gt',value:'2'}},
]};
test('wait config validates final resources, fields and reachable completion states',()=>{
  const {version:_,...draft}=definition;
  expect(validateDefinition(draft)).toEqual(draft);
  const transition=draft.transitions[0];
  for(const wait of [{...transition.wait,stepId:'absent'},{...transition.wait,timeoutSeconds:0},{...transition.wait,resultFields:{request:'text'}},{...transition.wait,resultFields:{target:'subject'}}]) {
    expect(()=>validateDefinition({...draft,transitions:[{...transition,wait},draft.transitions[1]]})).toThrow();
  }
  expect(()=>validateDefinition({...draft,transitions:[transition,{...draft.transitions[1],condition:{field:'missing',operator:'exists'}}]})).toThrow();
  expect(()=>validateDefinition({...draft,transitions:[transition,{...draft.transitions[1],condition:{field:'count',operator:['eq'],value:'3'}}]})).toThrow();
});
test('waiting runs and false guards hide transitions and reject execution',()=>{
  const actor:WorkflowActor={subject:'a',organizationId:'org',roles:['employee']};
  const run:WorkflowRun={id:'r',recordId:'r',definitionId:definition.id,definitionVersion:1,title:'t',ownerId:'a',organizationId:'org',state:'ready',version:2,data:{count:'3'},createdAt:'',updatedAt:''};
  expect(availableTransitions(definition,run,actor).map(t=>t.id)).toEqual(['finish']);
  const variants:WorkflowRun[]=[{...run,waiting:true},{...run,data:{count:'3e2'}},{...run,data:{}}];
  for(const variant of variants) {
    expect(availableTransitions(definition,variant,actor)).toEqual([]);
    expect(()=>planTransition(definition,variant,actor,{action:'finish',expectedVersion:2,input:{}})).toThrow();
  }
});
