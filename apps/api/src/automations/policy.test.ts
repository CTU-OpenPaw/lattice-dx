import {expect,test} from 'vitest';
import {parseRule,validateRuleDefinition,classifyAutomationError} from './policy.js';
const rule={id:'invoice-start',schemaId:'invoice',schemaVersion:1,operations:['entity.create'],serviceId:'automation',definitionId:'invoice-flow',definitionVersion:1,title:{source:'event',field:'entityId'},input:{},enabled:true};
const actor={subject:'service',organizationId:'org',roles:['workflow:service','workflow:start','data:read','start','step','data:write']};
const def={id:'invoice-flow',version:1,title:'Flow',startRole:'start',initialState:'new',startFields:{},readerRoles:[],transitions:[{id:'advance',from:'new',to:'done',role:'step',fields:{}}]};
test('strict automation bodies reject actor snapshots unknown fields and unsafe mappings',()=>{
 expect(parseRule(rule)).toEqual(rule);
 for(const value of [{...rule,roles:['start']},{...rule,input:{x:{source:'event',field:'actorSubject'}}},{...rule,operations:[]},{...rule,definitionVersion:0},{...rule,enabled:'true'}])expect(()=>parseRule(value)).toThrow();
});
test('start mappings enforce declared required fields literal types and actual start authority',()=>{
 expect(()=>validateRuleDefinition(parseRule(rule),def,actor)).not.toThrow();
 expect(()=>validateRuleDefinition(parseRule(rule),{...def,startFields:{count:'positiveInteger'}},actor)).toThrow();
 expect(()=>validateRuleDefinition(parseRule({...rule,input:{count:{source:'literal',value:'no'}}}),{...def,startFields:{count:'positiveInteger'}},actor)).toThrow();
 expect(()=>validateRuleDefinition(parseRule(rule),def,{...actor,roles:['workflow:start','start']})).toThrow();
});
test('initial transition permits only interactive no input no assignee and safe creation/query actions',()=>{
 const configured=parseRule({...rule,transitionId:'advance'});
 expect(()=>validateRuleDefinition(configured,def,actor)).not.toThrow();
 for(const extra of [{execution:'service'},{fields:{x:'text'}},{assigneeField:'owner'},{steps:[{id:'read',action:'entities.read',input:{}}]}])expect(()=>validateRuleDefinition(configured,{...def,transitions:[{...def.transitions[0],...extra}]} as never,actor)).toThrow();
});
test('unknown failures never persist messages and retry is bounded classification',()=>{
 expect(classifyAutomationError(new Error('token secret'))).toEqual({code:'internal_error',transient:true});
 expect(classifyAutomationError({code:'40P01',message:'SQL secret'})).toEqual({code:'database_transient',transient:true});
});
