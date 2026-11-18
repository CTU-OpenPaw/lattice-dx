/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {expect,test} from 'vitest';
import {conditionMatches} from './completion-policy.js';
import {validateDefinition} from './registry.js';
test('nested conditions evaluate all and any and preserve missing-field semantics',()=>{
 const c:any={all:[{field:'n',operator:'gt',value:'2'},{any:[{field:'x',operator:'eq',value:'yes'},{field:'y',operator:'exists'}]}]};
 expect(conditionMatches(c,{n:'3',x:'yes'})).toBe(true);
 expect(conditionMatches(c,{n:'3\n',x:'yes'})).toBe(false);
 expect(conditionMatches(c,{n:'3'})).toBe(false);
});
test('nested condition shapes and budgets are validated',()=>{
 const base:any={id:'nested-test',title:'Nested',startRole:'employee',initialState:'start',startFields:{n:'text'},readerRoles:[],transitions:[{id:'next',from:'start',to:'done',role:'employee',fields:{}}]};
 const leaf={field:'n',operator:'exists'};
 const check=(condition:any)=>validateDefinition({...base,transitions:[{...base.transitions[0],condition}]});
 expect(check({all:[leaf,{any:[leaf]}]})).toBeTruthy();
 for(const c of [{all:[]},{all:[leaf],any:[leaf]},{all:[{all:[{all:[leaf]}]}]},{any:Array(11).fill(leaf)},{all:Array(10).fill({any:[leaf,leaf]})}])expect(()=>check(c)).toThrow();
});
import {compileCondition} from './conditions.js';
test('SQL compiler fails closed for malformed numeric right operands and parameterizes nested leaves',()=>{
 const values:unknown[]=[];const bind=(v:unknown)=>{values.push(v);return '$'+values.length;};
 for(const value of ['Infinity','1e400','3\n','999999999999999999999']) expect(compileCondition({field:'n',operator:'gt',value},bind)).toBe('false');
 const sql=compileCondition({any:[{field:'n',operator:'eq',value:"quoted'payload"},{field:'x',operator:'exists'}]},bind);
 expect(sql).toContain(' OR ');expect(sql).not.toContain("quoted'payload");expect(values).toContain("quoted'payload");expect(sql).toContain('COALESCE');
});
