// SPDX-License-Identifier: Apache-2.0
// Requires the published LOCAL TEST fixture and its container-only upstream; never targets business orders.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const token=process.env.N8N_DEMO_WEBHOOK_TOKEN;
if(!token)throw Error('Load .env.integration with the local demo webhook credential.');
const url='http://localhost:5678/webhook/latticedx/runtime-failure-test';
const results=[];
for(const [sku,status] of [['DROP',502],['NONJSON',502],['TIMEOUT',502],['SUCCESS',201],['HTTP401',401]]){
 const start=performance.now();
 const response=await fetch(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(25000),headers:{'content-type':'application/json','Idempotency-Key':'failure-'+randomUUID(),'X-Lattice-Webhook-Token':token},body:JSON.stringify({title:'Failure fixture',customerName:'Fixture',deliveryAddress:'Fixture',sku,quantity:1,warehouseAssigneeId:'fixture'})});
 const body=await response.json(),durationMs=Math.round(performance.now()-start);
 assert.equal(response.status,status,sku);
 if(status===502)assert.equal(body.error,'upstream_unavailable',sku);
 if(sku==='SUCCESS')assert.equal(body.id,'fixture-order');
 if(sku==='HTTP401')assert.equal(body.error,'fixture_denied');
 if(sku==='TIMEOUT')assert.ok(durationMs>=9000&&durationMs<16000,'Configured upstream timeout should finish around 10 seconds.');
 results.push({case:sku,status:response.status,durationMs});
}
console.log(JSON.stringify({result:'PASS actual n8n failure branches',upstream:'SIMULATED; no business orders created',results}));
