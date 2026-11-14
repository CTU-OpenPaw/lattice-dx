/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Expression, TypedScalar } from '@dx/contracts';
import { expressionFailure, parseDecimal } from './decimal.js';
export interface ExpressionReferencePolicy {
  data?:ReadonlySet<string>;input?:ReadonlySet<string>;
  projection?:Readonly<Record<string,ReadonlySet<string>>>;
  evaluation?:Readonly<Record<string,ReadonlySet<string>>>;
}
export function ownValue(value:unknown,key:string):unknown {
  if(!value||typeof value!=='object')expressionFailure();
  const descriptor=Object.getOwnPropertyDescriptor(value,key);
  if(!descriptor||!('value' in descriptor))expressionFailure();
  return descriptor.value;
}
function shape(value:unknown,keys:string[]):void {
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))expressionFailure();
  if(Reflect.ownKeys(value).length!==keys.length||Reflect.ownKeys(value).some(k=>typeof k!=='string'||!keys.includes(k)))expressionFailure();
  keys.forEach(k=>ownValue(value,k));
}
export function expressionName(value:unknown):value is string {
  return typeof value==='string'&&value.length<=80&&!['__proto__','prototype','constructor'].includes(value)&&/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(value);
}
export function validateTypedScalar(value:unknown):asserts value is TypedScalar {
  shape(value,['type','value']);const type=ownValue(value,'type'),scalar=ownValue(value,'value');
  switch(type) {
    case 'integer':if(typeof scalar!=='number'||!Number.isSafeInteger(scalar))expressionFailure();break;
    case 'decimal':if(typeof scalar!=='string')expressionFailure();parseDecimal(scalar);break;
    case 'boolean':if(typeof scalar!=='boolean')expressionFailure();break;
    case 'null':if(scalar!==null)expressionFailure();break;
    case 'text':case 'enum':if(typeof scalar!=='string'||Array.from(scalar).length>(type==='text'?4000:200)||/[\x00-\x1f\x7f-\x9f]/.test(scalar))expressionFailure();break;
    case 'date': {
      if(typeof scalar!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(scalar))expressionFailure();
      const date=new Date(scalar+'T00:00:00Z');if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==scalar)expressionFailure();break;
    }
    default:expressionFailure();
  }
}
export function validateExpression(value:unknown,policy?:ExpressionReferencePolicy):asserts value is Expression {
  let count=0;
  function visit(node:unknown,depth:number):void {
    if(depth>8||++count>100)expressionFailure();const op=ownValue(node,'op');
    if(op==='literal'){shape(node,['op','value']);validateTypedScalar(ownValue(node,'value'));return;}
    if(op==='ref') {
      const source=ownValue(node,'source'),field=ownValue(node,'field');if(!expressionName(field))expressionFailure();
      if(source==='data'||source==='input') {
        shape(node,['op','source','field','as']);if(!['text','integer','decimal','boolean','date','enum'].includes(ownValue(node,'as') as string))expressionFailure();
        if(policy&&!policy[source]?.has(field))expressionFailure();
      } else if(source==='projection'||source==='evaluation') {
        shape(node,['op','source','stepId','field']);const step=ownValue(node,'stepId');if(!expressionName(step))expressionFailure();
        if(policy){const declarations=policy[source];if(!declarations||!(ownValue(declarations,step) as ReadonlySet<string>).has(field))expressionFailure();}
      } else expressionFailure();return;
    }
    shape(node,['op','args']);const args=ownValue(node,'args');if(!Array.isArray(args)||args.length>20)expressionFailure();
    if(Object.getPrototypeOf(args)!==Array.prototype||Reflect.ownKeys(args).length!==args.length+1)expressionFailure();
    const exact=['subtract','divide','eq','ne','gt','gte','lt','lte'].includes(op as string)?2:op==='not'?1:undefined;
    if(!['add','subtract','multiply','divide','eq','ne','gt','gte','lt','lte','all','any','not','coalesce'].includes(op as string)||args.length<(op==='add'||op==='multiply'?2:1)||exact!==undefined&&args.length!==exact)expressionFailure();
    for(let i=0;i<args.length;i++)visit(ownValue(args,String(i)),depth+1);
  }
  visit(value,1);
}
