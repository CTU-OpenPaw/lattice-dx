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
