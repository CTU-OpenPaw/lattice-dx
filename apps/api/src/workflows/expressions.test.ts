/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { evaluateExpression } from './expressions.js';
import { validateExpression, validateTypedScalar } from './expression-policy.js';
const lit = (type: string, value: unknown): any => ({ op: 'literal', value: { type, value } });
const calc = (op: string, ...args: any[]): any => ({ op, args });
describe('private pure expressions', () => {
  it('calculates exact decimals and signed rounding', () => {
    expect(evaluateExpression(calc('add',lit('decimal','99999999999999999999.10'),lit('decimal','0.20')),{})).toEqual({type:'decimal',value:'99999999999999999999.30'});
    expect(evaluateExpression(calc('multiply',lit('decimal','-1.20'),lit('integer',3)),{}).value).toBe('-3.60');
    expect(evaluateExpression(calc('divide',lit('decimal','-0.000000000000000001'),lit('integer',2)),{}).value).toBe('-0.000000000000000001');
  });
  it('rejects overflow, zero, mismatched types and scalar bounds', () => {
    for(const expr of [calc('add',lit('integer',Number.MAX_SAFE_INTEGER),lit('integer',1)),calc('divide',lit('integer',1),lit('integer',0)),calc('eq',lit('boolean',true),lit('text','true')),calc('multiply',lit('decimal','0.0000000001'),lit('decimal','0.0000000001'))]) expect(()=>evaluateExpression(expr,{})).toThrow();
    for(const scalar of [{type:'integer',value:1.5},{type:'decimal',value:'1e2'},{type:'decimal',value:'1'.repeat(81)},{type:'date',value:'2025-02-29'},{type:'boolean',value:'true'},{type:'text',value:'x\u0000'}]) expect(()=>validateTypedScalar(scalar)).toThrow();
    expect(()=>validateTypedScalar({type:'text',value:'😀'.repeat(4000)})).not.toThrow();
  });
  it('resolves explicit typed refs and null coalesce', () => {
    expect(evaluateExpression({op:'ref',source:'data',field:'amount',as:'decimal'},{data:{amount:{type:'decimal',value:'2.00'}}})).toEqual({type:'decimal',value:'2.00'});
    expect(evaluateExpression(calc('coalesce',lit('null',null),lit('integer',2)),{}).value).toBe(2);
    expect(()=>evaluateExpression({op:'ref',source:'input',field:'missing',as:'text'},{})).toThrow();
    expect(()=>validateExpression({op:'ref',source:'projection',stepId:'later',field:'price'},{projection:{}})).toThrow();
    expect(evaluateExpression(calc('eq',lit('null',null),lit('integer',2)),{}).value).toBe(false);
    expect(evaluateExpression(calc('ne',lit('null',null),lit('integer',2)),{}).value).toBe(true);
  });
  it('covers subtraction, integer cross comparisons, precision and declaration policy', () => {
    expect(evaluateExpression(calc('subtract',lit('decimal','100000000000000000000.00'),lit('decimal','0.01')),{}).value).toBe('99999999999999999999.99');
    expect(evaluateExpression(calc('divide',lit('integer',2),lit('integer',3)),{}).value).toBe('0.666666666666666667');
    expect(evaluateExpression(calc('eq',lit('integer',2),lit('decimal','2.000')),{}).value).toBe(true);
    expect(()=>evaluateExpression(calc('multiply',lit('decimal','9'.repeat(80)),lit('integer',2)),{})).toThrow();
    const ref:any={op:'ref',source:'projection',stepId:'prior',field:'amount'};
    expect(()=>validateExpression(ref,{projection:{prior:new Set(['amount'])}})).not.toThrow();
    expect(evaluateExpression(ref,{projection:{prior:{amount:{type:'null',value:null}}}})).toEqual({type:'null',value:null});
    expect(()=>evaluateExpression({op:'ref',source:'data',field:'amount',as:'integer'},{data:{amount:{type:'decimal',value:'2'}}})).toThrow();
    const args:any=[lit('boolean',true)];args.constructor='unsafe';expect(()=>validateExpression({op:'all',args})).toThrow();
  });
  it('rejects shapes, accessors, cycles and bounds', () => {
    const cycle:any=calc('not');cycle.args=[cycle];
    const accessor=Object.defineProperty({},'op',{get(){throw new Error('getter executed');},enumerable:true});
    for(const expr of [cycle,accessor,{op:'literal',value:{type:'integer',value:1},extra:true},{op:'ref',source:'data',field:'constructor',as:'text'},calc('wat'),calc('not',lit('integer',1)),calc('add',lit('integer',1))]) expect(()=>evaluateExpression(expr,{})).toThrow();
    let deep:any=lit('boolean',true);for(let i=0;i<8;i++)deep=calc('not',deep);expect(()=>validateExpression(deep)).toThrow();
    expect(()=>validateExpression(calc('all',...Array.from({length:20},()=>calc('all',...Array.from({length:5},()=>lit('boolean',true))))))).toThrow();
  });
});
