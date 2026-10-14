// SPDX-License-Identifier: Apache-2.0
import { WorkflowError } from './policy.js';
export class TimerError extends WorkflowError {
  constructor(public readonly code:string,status:400|403|404|409|503=409) {super(status,code);}
}
/** Persist only enumerated codes; never SQL messages or business input. */
export function classifyTimerError(error:unknown):{code:string;transient:boolean} {
  if(error instanceof TimerError)return {code:error.code,transient:false};
  if(error instanceof WorkflowError)return {code:({400:'validation_failed',403:'authority_denied',404:'authority_denied',409:'state_conflict',503:'definition_unavailable'} as const)[error.statusCode],transient:false};
  const code=(error as {code?:string})?.code;
  if(code&&['40001','40P01','55P03','57014','53300','57P03'].includes(code))return {code:'database_transient',transient:true};
  return {code:'execution_failed',transient:false};
}
export function parseTimerRetry(value:unknown):{expectedVersion:number}|undefined {
  if(!value||typeof value!=='object'||Array.isArray(value))return;
  const v=value as Record<string,unknown>;
  if(Object.keys(v).length!==1||!Number.isSafeInteger(v.expectedVersion)||Number(v.expectedVersion)<1)return;
  return {expectedVersion:Number(v.expectedVersion)};
}
