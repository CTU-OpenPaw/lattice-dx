import {describe,it,expect} from 'vitest';
import {parseProposal,isWorker,assertHuman,incidentContract} from './policy.js';
import {publicJob} from './database.js';
describe('incident agent boundary',()=>{
 it('shows expired leases and never exposes worker lease credentials',()=>{
  const j=publicJob({status:'running',deadline:new Date(Date.now()+60000),lease_until:new Date(Date.now()-1000),lease_token:'secret'} as any);
  expect(j.status).toBe('failed');expect(j).not.toHaveProperty('leaseToken');expect(j).not.toHaveProperty('lease_token');
 });
 it('accepts only bounded typed proposals',()=>{
  expect(parseProposal({summary:'Investigate pump',suggestedStatus:'repair',evidence:['Temperature high']})).toEqual({summary:'Investigate pump',suggestedStatus:'repair',evidence:['Temperature high']});
  for(const value of [{summary:'x',suggestedStatus:'repair',evidence:[],assetId:'other'},{summary:'x',suggestedStatus:'deleted',evidence:[]},{summary:'x'.repeat(2001),suggestedStatus:'ready',evidence:[]}])expect(()=>parseProposal(value)).toThrow();
 });
 it('worker principal cannot acquire human transition authority through extra roles',()=>{
  const actor={subject:'worker',organizationId:'org',roles:['connector:agent','agent:worker','incident:review']};
  expect(isWorker(actor)).toBe(true);expect(()=>assertHuman(actor)).toThrow();
 });
 it('pins the exact connector result and destination contract',()=>{
  const config={resultFields:{proposalId:'text',agentJobId:'text'},successState:'review_pending',failureState:'analysis_failed',timeoutSeconds:300};
  expect(incidentContract({definition_id:'incident-response',definition_version:1,state:'analyzing'},{kind:'connector',connector_id:'agent',config},{eventType:'connector.dispatch',connectorId:'agent',operation:'incident.analyze'})).toBe(true);
  expect(incidentContract({definition_id:'incident-response',definition_version:1,state:'analyzing'},{kind:'connector',connector_id:'agent',config:{...config,resultFields:{...config.resultFields,arbitrary:'text'}}},{eventType:'connector.dispatch',connectorId:'agent',operation:'incident.analyze'})).toBe(false);
 });
});
