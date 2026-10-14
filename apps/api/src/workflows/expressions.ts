// SPDX-License-Identifier: Apache-2.0
import type { Expression, TypedScalar } from '@dx/contracts';
import { calculateDecimal, compareDecimal, expressionFailure, formatDecimal, parseDecimal } from './decimal.js';
import { ownValue, validateExpression, validateTypedScalar } from './expression-policy.js';
export interface ExpressionEnvironment {
  data?:Readonly<Record<string,TypedScalar>>;input?:Readonly<Record<string,TypedScalar>>;
  projection?:Readonly<Record<string,Readonly<Record<string,TypedScalar>>>>;
  evaluation?:Readonly<Record<string,Readonly<Record<string,TypedScalar>>>>;
}
const numeric=(v:TypedScalar)=>v.type==='integer'||v.type==='decimal';
const decimal=(v:TypedScalar)=>parseDecimal(String(v.value));
export function evaluateExpression(expression:Expression,environment:ExpressionEnvironment):TypedScalar {
  validateExpression(expression);
  function evaluate(node:Expression):TypedScalar {
    if(node.op==='literal')return {...node.value};
    if(node.op==='ref') {
      const source=ownValue(environment,node.source);
      const value=ownValue('stepId' in node?ownValue(source,node.stepId):source,node.field);
      validateTypedScalar(value);if('as' in node&&node.as!==value.type)expressionFailure();return {...value};
    }
    // Every branch is evaluated so malformed or missing references never hide behind short circuits.
    const args=node.args.map(evaluate);
    if(node.op==='coalesce')return args.find(v=>v.type!=='null')??{type:'null',value:null};
    if(['all','any','not'].includes(node.op)) {
      if(args.some(v=>v.type!=='boolean'))expressionFailure();
      return {type:'boolean',value:node.op==='not'?!args[0]!.value:node.op==='all'?args.every(v=>v.value===true):args.some(v=>v.value===true)};
    }
    if(node.op==='add'||node.op==='subtract'||node.op==='multiply'||node.op==='divide') {
      if(args.some(v=>!numeric(v)))expressionFailure();
      if(node.op!=='divide'&&args.every(v=>v.type==='integer')) {
        let result=BigInt(args[0]!.value as number);
        for(const arg of args.slice(1)){const n=BigInt(arg.value as number);result=node.op==='add'?result+n:node.op==='subtract'?result-n:result*n;}
        if(result>BigInt(Number.MAX_SAFE_INTEGER)||result<BigInt(Number.MIN_SAFE_INTEGER))expressionFailure();return {type:'integer',value:Number(result)};
      }
      let result=decimal(args[0]!);
      for(const arg of args.slice(1)){result=calculateDecimal(node.op,result,decimal(arg));formatDecimal(result);}
      return {type:'decimal',value:formatDecimal(result)};
    }
    const [a,b]=args as [TypedScalar,TypedScalar];let comparison:number;
    if(a.type==='null'||b.type==='null') {
      if(node.op!=='eq'&&node.op!=='ne')expressionFailure();
      const equal=a.type==='null'&&b.type==='null';return {type:'boolean',value:node.op==='eq'?equal:!equal};
    }
    if(numeric(a)&&numeric(b))comparison=compareDecimal(decimal(a),decimal(b));
    else {
      if(a.type!==b.type||(['boolean','null'].includes(a.type)&&node.op!=='eq'&&node.op!=='ne'))expressionFailure();
      comparison=a.value===b.value?0:a.value!<b.value!?-1:1;
    }
    return {type:'boolean',value:node.op==='eq'?comparison===0:node.op==='ne'?comparison!==0:node.op==='gt'?comparison>0:node.op==='gte'?comparison>=0:node.op==='lt'?comparison<0:comparison<=0};
  }
  return evaluate(expression);
}
