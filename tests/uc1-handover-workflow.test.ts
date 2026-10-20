// SPDX-License-Identifier: Apache-2.0
import {readFileSync} from 'node:fs';
import {expect,test} from 'vitest';
const workflow=JSON.parse(readFileSync(new URL('../infra/config/n8n/uc1-handover.json',import.meta.url),'utf8'));
test('handover n8n export is inactive, unpinned and keeps distinct credentials out of source',()=>{
 expect(workflow.active).toBe(false);expect(workflow.pinData).toEqual({});
 expect(workflow.settings.saveDataSuccessExecution).toBe('none');expect(workflow.settings.saveDataErrorExecution).toBe('none');
 const credentials=workflow.nodes.flatMap((n:any)=>Object.values(n.credentials??{}));
 expect(credentials).toEqual([{name:'LatticeDX UC1 Handover Webhook'},{name:'LatticeDX UC1 Handover Adapter'}]);
});
test('n8n waits for the adapter, preserves its status and routes transport failure to sanitized 502',()=>{
 const node=(name:string)=>workflow.nodes.find((n:any)=>n.name===name);
 expect(node('Receive Handover').parameters).toMatchObject({authentication:'headerAuth',responseMode:'responseNode'});
 expect(node('Synchronize Asset')).toMatchObject({retryOnFail:false,onError:'continueErrorOutput',parameters:{url:'http://api:4000/v1/integrations/asset-handovers',jsonBody:'={{ $json.body }}'}});
 expect(node('Synchronize Asset').parameters.headerParameters.parameters[0].value).toContain('idempotency-key');
 expect(node('Synchronize Asset').parameters.options.response.response).toMatchObject({fullResponse:true,neverError:true,responseFormat:'json'});
 expect(workflow.connections['Synchronize Asset'].main.map((output:any)=>output[0].node)).toEqual(['Return Synchronization Result','Return Delivery Failure']);
 expect(node('Return Synchronization Result').parameters.options.responseCode).toBe('={{ $json.statusCode }}');
 expect(node('Return Delivery Failure').parameters).toMatchObject({responseBody:'{"error":"handover_adapter_unavailable"}',options:{responseCode:502}});
});
