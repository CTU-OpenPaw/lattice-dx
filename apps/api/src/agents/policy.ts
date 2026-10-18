// SPDX-License-Identifier: Apache-2.0
import type {WorkflowActor} from '@dx/contracts';
import {WorkflowError} from '../workflows/policy.js';
export type Proposal={
  summary:string;
  suggestedStatus:'ready'|'in_use'|'repair'|'retired';
  evidence:string[]
};
export function bad(status:400|403|404|409|503,message:string):never{
  throw new WorkflowError(status,message);
}
export function object(value:unknown,keys:string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))bad(400,'Invalid agent input.');
  return value as Record<string,unknown>;
}
export function text(value:unknown,max:number):string{
  if(typeof value!=='string'||!value.trim()||value.length>max)bad(400,'Invalid agent text.');
  return value;
}
export function parseProposal(value:unknown):Proposal{
  const p=object(value,['summary','suggestedStatus','evidence']);
  if(!['ready','in_use','repair','retired'].includes(p.suggestedStatus as string)||!Array.isArray(p.evidence)||p.evidence.length>20)bad(400,'Invalid agent proposal.');
  return {
    summary:text(p.summary,2000),suggestedStatus:p.suggestedStatus as Proposal['suggestedStatus'],evidence:p.evidence.map(v=>text(v,1000))
  };
}
export function isWorker(actor:WorkflowActor){
  return actor.roles.includes('connector:agent')||actor.roles.includes('agent:worker');
}
export function assertHuman(actor:WorkflowActor){
  if(isWorker(actor))bad(403,'Agent principals cannot perform human operations.');
}
export function worker(actor:WorkflowActor){
  if(!actor.roles.includes('connector:agent')||!actor.roles.includes('agent:worker'))bad(403,'Agent worker authority required.');
}
export function incidentContract(run:{
  definition_id:string;
  definition_version:number;
  state:string
},wait:{
  kind:string;
  connector_id:string|null;
  config:{successState:string;failureState:string;timeoutSeconds:number;resultFields:Record<string,string>}
},value:unknown){
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const event=value as Record<string,unknown>;
  const c=wait.config;
  return run.definition_id==='incident-response'&&run.definition_version===1&&run.state==='analyzing'&&wait.kind==='connector'&&wait.connector_id==='agent'&&event?.eventType==='connector.dispatch'&&event.connectorId==='agent'&&event.operation==='incident.analyze'&&c.successState==='review_pending'&&c.failureState==='analysis_failed'&&c.timeoutSeconds===300&&JSON.stringify(Object.entries(c.resultFields??{
  }).sort())===JSON.stringify(Object.entries({
    proposalId:'text',agentJobId:'text'
  }).sort());
}

export const INCIDENT_ASSET_SCHEMA='incident-asset';
export function assertAssetSchema(asset:{schemaId:string}){if(asset.schemaId!==INCIDENT_ASSET_SCHEMA)bad(409,'Incident requires the incident-asset schema.');}
