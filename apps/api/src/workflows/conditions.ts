// SPDX-License-Identifier: Apache-2.0
import type {WorkflowCondition} from '@dx/contracts';
export const numericPattern='^-?[0-9]+([.][0-9]+)?$';
export function strictNumber(value:unknown):number|undefined {
 if(typeof value!=='string'||value.length>20||new RegExp(numericPattern).exec(value)?.[0]!==value)return;
 const n=Number(value);return Number.isFinite(n)?n:undefined;
}
export function validCondition(value:unknown,fields:Set<string>):value is WorkflowCondition {
 let nodes=0;
 const visit=(v:unknown,depth:number):boolean=>{
  if(++nodes>20||depth>3||!v||typeof v!=='object'||Array.isArray(v))return false;
  const c=v as Record<string,unknown>,keys=Object.keys(c);
  if('all'in c||'any'in c){const k='all'in c?'all':'any';const children=c[k];return keys.length===1&&Array.isArray(children)&&children.length>=1&&children.length<=10&&children.every(x=>visit(x,depth+1));}
  return keys.every(k=>['field','operator','value'].includes(k))&&typeof c.field==='string'&&fields.has(c.field)&&['eq','gt','exists'].includes(String(c.operator))&&typeof c.operator==='string'&&(c.operator==='exists'?c.value===undefined:typeof c.value==='string'&&c.value.length<=2000)&&(c.operator!=='gt'||strictNumber(c.value)!==undefined);
 };return visit(value,1);
}
export function conditionMatches(c:WorkflowCondition|undefined,data:Record<string,string>):boolean {
 if(!c)return true;
 if('all'in c)return c.all.every(x=>conditionMatches(x,data));
 if('any'in c)return c.any.some(x=>conditionMatches(x,data));
 if(!Object.hasOwn(data,c.field)||typeof data[c.field]!=='string')return false;
 const v=data[c.field];if(c.operator==='exists')return v.length>0;if(c.operator==='eq')return v===c.value;
 const a=strictNumber(v),b=strictNumber(c.value);return a!==undefined&&b!==undefined&&a>b;
}
export function compileCondition(c:WorkflowCondition,bind:(value:unknown)=>string,column='data'):string {
 if('all'in c)return '('+c.all.map(x=>compileCondition(x,bind,column)).join(' AND ')+')';
 if('any'in c)return '('+c.any.map(x=>compileCondition(x,bind,column)).join(' OR ')+')';
 const f=bind(c.field),raw=`${column}->${f}`,text=`${column}->>${f}`,typed=`jsonb_typeof(${raw})='string'`;
 if(c.operator==='exists')return `COALESCE((${typed} AND length(${text})>0),false)`;
 if(c.operator==='eq')return `COALESCE((${typed} AND ${text}=${bind(c.value)}),false)`;
 if(strictNumber(c.value)===undefined)return 'false';
 // The length bound excludes float overflow. Full character exclusion rejects SQL regex end-anchor newline behavior.
 return `(CASE WHEN ${typed} AND length(${text})<=20 AND ${text} ~ ${bind(numericPattern)} AND ${text} !~ '[^0-9.-]' THEN (${text})::double precision>${bind(c.value)}::double precision ELSE false END)`;
}
