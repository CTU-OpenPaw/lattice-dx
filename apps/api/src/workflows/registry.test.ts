// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'vitest';
import { validateDefinition } from './registry.js';
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
