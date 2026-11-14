/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { WorkflowError } from './policy.js';
export function expressionFailure(): never { throw new WorkflowError(400,'Biểu thức không hợp lệ.'); }
export interface Decimal { coefficient:bigint;scale:number }
const power=(scale:number)=>10n**BigInt(scale);
export function parseDecimal(value:string):Decimal {
  if(!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value))expressionFailure();
  const [whole,fraction='']=value.split('.');
  if(fraction.length>18||whole!.replace('-','').length+fraction.length>80)expressionFailure();
  return {coefficient:BigInt(whole!+fraction),scale:fraction.length};
}
export function formatDecimal(value:Decimal):string {
  const negative=value.coefficient<0n;
  const digits=(negative?-value.coefficient:value.coefficient).toString().padStart(value.scale+1,'0');
  const result=(negative?'-':'')+(value.scale?digits.slice(0,-value.scale)+'.'+digits.slice(-value.scale):digits);
  parseDecimal(result);
  return result;
}
export function compareDecimal(a:Decimal,b:Decimal):number {
  const scale=Math.max(a.scale,b.scale),left=a.coefficient*power(scale-a.scale),right=b.coefficient*power(scale-b.scale);
  return left<right?-1:left>right?1:0;
}
export function calculateDecimal(op:'add'|'subtract'|'multiply'|'divide',a:Decimal,b:Decimal):Decimal {
  if(op==='multiply')return {coefficient:a.coefficient*b.coefficient,scale:a.scale+b.scale};
  if(op==='divide') {
    if(b.coefficient===0n)expressionFailure();
    const numerator=a.coefficient*power(18+b.scale),denominator=b.coefficient*power(a.scale);
    let quotient=numerator/denominator;
    const remainder=numerator%denominator,abs=(v:bigint)=>v<0n?-v:v;
    if(abs(remainder)*2n>=abs(denominator))quotient+=(numerator<0n)!==(denominator<0n)?-1n:1n;
    let scale=18;while(scale>0&&quotient%10n===0n){quotient/=10n;scale--;}
    return {coefficient:quotient,scale};
  }
  const scale=Math.max(a.scale,b.scale);
  return {coefficient:a.coefficient*power(scale-a.scale)+(op==='add'?1n:-1n)*b.coefficient*power(scale-b.scale),scale};
}
