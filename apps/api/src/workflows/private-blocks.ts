// SPDX-License-Identifier: Apache-2.0
import type {Expression,TypedScalar,WorkflowRun} from '@dx/contracts';
import type {Entity,SchemaPublication} from '../entities/types.js';
import {evaluateExpression} from './expressions.js';
import {validateExpression,validateTypedScalar} from './expression-policy.js';
import {WorkflowError} from './policy.js';
export type PrivateValues={projection:Record<string,Record<string,TypedScalar>>;evaluation:Record<string,Record<string,TypedScalar>>};
export const createPrivateValues=():PrivateValues=>({projection:Object.create(null),evaluation:Object.create(null)});
const fail=():never=>{throw new WorkflowError(400,'Private expression unavailable.');};
export function projectFields(row:Entity,schema:SchemaPublication,fields:string[]):Record<string,TypedScalar>{
 const values:Record<string,TypedScalar>=Object.create(null);
 for(const field of fields){
  if(!Object.hasOwn(schema.fields,field))fail();const declaration=schema.fields[field]!;
  const value=Object.hasOwn(row.attributes,field)?{type:declaration.type,value:row.attributes[field]!}:declaration.required?fail():{type:'null',value:null};
  validateTypedScalar(value);values[field]=value;
 }
 return values;
}
export function evaluatePrivateExpression(expression:Expression,run:WorkflowRun,input:Record<string,string>,privateValues=createPrivateValues()):TypedScalar{
 validateExpression(expression);
 const data:Record<string,TypedScalar>=Object.create(null),inputs:Record<string,TypedScalar>=Object.create(null);
 function collect(node:Expression):void{
  if(node.op==='ref'&&(node.source==='data'||node.source==='input')){
   const source=node.source==='data'?run.data:input,target=node.source==='data'?data:inputs;
   const descriptor=Object.getOwnPropertyDescriptor(source,node.field);if(!descriptor||!('value' in descriptor)||typeof descriptor.value!=='string')fail();
   const raw=descriptor!.value;let value:string|number|boolean=raw;
   if(node.as==='integer'){if(!/^-?(0|[1-9]\d*)$/.test(raw)||raw==='-0')fail();value=Number(raw);}
   if(node.as==='boolean'){if(raw!=='true'&&raw!=='false')fail();value=raw==='true';}
   const scalar={type:node.as,value};validateTypedScalar(scalar);
   if(Object.hasOwn(target,node.field)&&target[node.field]!.type!==scalar.type)fail();target[node.field]=scalar;
  }else if('args' in node)node.args.forEach(collect);
 }
 collect(expression);return evaluateExpression(expression,{data,input:inputs,...privateValues});
}
