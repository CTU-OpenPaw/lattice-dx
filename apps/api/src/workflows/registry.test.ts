/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { expect, test } from 'vitest';
import { validateDefinition } from './registry.js';
test('assignment tasks require a subject assignment and unambiguous completion',()=>{
 const definition={id:'assignment-fixture',title:'Assignment',startRole:'creator',initialState:'open',startFields:{handlerId:'subject'},readerRoles:[],assignedReader:{field:'handlerId',role:'handler',states:['open','assigned','done']},transitions:[{id:'assign',from:'open',to:'assigned',role:'manager',fields:{},task:'assign'},{id:'accept',from:'assigned',to:'done',role:'handler',assigneeField:'handlerId',fields:{},task:'complete'}]};
 expect(validateDefinition(definition)).toEqual(definition);
 for(const mutate of [()=>({...definition,assignedReader:undefined}),()=>({...definition,transitions:[{...definition.transitions[0],task:'other'}]}),()=>({...definition,transitions:[definition.transitions[0],{...definition.transitions[1],assigneeField:undefined}]}),()=>({...definition,transitions:[{...definition.transitions[0],wait:{}}]})])expect(()=>validateDefinition(mutate())).toThrow();
});
export const customDefinition={id:'hr-request',title:'HR request',startRole:'employee',initialState:'draft',startFields:{request:'text'},readerRoles:['manager'],transitions:[{id:'submit',from:'draft',to:'done',role:'employee',ownerOnly:true,fields:{}}]};
test('validates configuration and rejects executable, unsafe and unreachable definitions',()=>{
  expect(validateDefinition(customDefinition)).toEqual(customDefinition);
  for(const definition of [
    {...customDefinition,version:1}, {...customDefinition,id:'procurement'},
    {...customDefinition,startFields:JSON.parse('{"__proto__":"text"}')},
    {...customDefinition,startFields:{request:'script'}},
    {...customDefinition,startFields:{request:['text']}},
    {...customDefinition,transitions:[{...customDefinition.transitions[0],from:'hidden'}]},
    {...customDefinition,transitions:[customDefinition.transitions[0],customDefinition.transitions[0]]},
    {...customDefinition,transitions:[{...customDefinition.transitions[0],task:'assign'}]},
    {...customDefinition,assignedReader:{field:'unknown',role:'manager',states:['done']}},
    {...customDefinition,transitions:[{...customDefinition.transitions[0],assigneeField:'request'}]},
  ])expect(()=>validateDefinition(definition)).toThrow();
});
