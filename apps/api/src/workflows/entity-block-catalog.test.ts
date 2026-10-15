// SPDX-License-Identifier: Apache-2.0
import {expect,test} from 'vitest';
import {entityWorkflowBlocks} from './entity-block-catalog.js';
test('recursive catalog expressions advertise exact runtime operator arities',()=>{
 const schema=entityWorkflowBlocks.find(block=>block.id==='data.evaluate')!.input.$defs.expression;
 const variants=schema.oneOf.map(variant=>variant.properties as Record<string,any>);
 const operators=['add','multiply','subtract','divide','eq','ne','gt','gte','lt','lte','not','all','any','coalesce'];
 for(const operator of operators){
  const matches=variants.filter(properties=>properties.op.const===operator||properties.op.enum?.includes(operator));
  expect(matches,operator).toHaveLength(1);
  const args=matches[0]!.args;
  const exact=operator==='not'?1:['subtract','divide','eq','ne','gt','gte','lt','lte'].includes(operator)?2:undefined;
  expect(args.minItems,operator).toBe(exact??(['add','multiply'].includes(operator)?2:1));
  expect(args.maxItems,operator).toBe(exact??20);
  expect(args.items).toEqual({$ref:'#/$defs/expression'});
 }
});
test('catalog scalar literal bounds match stable runtime constraints',()=>{
 const variants=entityWorkflowBlocks[0]!.input.$defs.expression.oneOf;
 const literal=variants.find(variant=>(variant.properties.op as any).const==='literal')!.properties.value as any;
 const schema=(type:string)=>literal.oneOf.find((variant:any)=>variant.properties.type.const===type).properties.value;
 expect(schema('integer')).toMatchObject({type:'integer',minimum:Number.MIN_SAFE_INTEGER,maximum:Number.MAX_SAFE_INTEGER});
 expect(schema('text').maxLength).toBe(4000);expect(schema('enum').maxLength).toBe(200);
 const decimal=new RegExp(schema('decimal').pattern);
 for(const value of ['-0','123.4500','9'.repeat(80),'1.'+'2'.repeat(18)])expect(decimal.test(value),value).toBe(true);
 for(const value of ['01','1e2',' 1','9'.repeat(81),'1.'+'2'.repeat(19),'9'.repeat(80)+'.1'])expect(decimal.test(value),value).toBe(false);
 expect(new RegExp(schema('text').pattern).test('secret\u0000')).toBe(false);
 expect(new RegExp(schema('date').pattern).test('2026-10-14')).toBe(true);
 expect(schema('null')).toEqual({type:'null'});
});
