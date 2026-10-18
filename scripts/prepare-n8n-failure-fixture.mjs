// SPDX-License-Identifier: Apache-2.0
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
const [workflow]=JSON.parse(readFileSync(new URL('../logistics-order-webhook.json',import.meta.url),'utf8'));
workflow.id='LatticeRuntimeFailureTest';workflow.name='LOCAL TEST - Logistics failure handling';workflow.versionId=randomUUID();workflow.active=false;workflow.activeVersionId=null;
const hook=workflow.nodes.find(node=>node.name==='Webhook');hook.parameters.path='latticedx/runtime-failure-test';hook.webhookId='b2136e02-5266-48f5-9c13-4de61ffcc908';
workflow.nodes.find(node=>node.name==='Create Logistics Order').parameters.url='http://api:4107/orders';
mkdirSync(new URL('../output/n8n-failure-test/',import.meta.url),{recursive:true});
writeFileSync(new URL('../output/n8n-failure-test/workflow.json',import.meta.url),JSON.stringify([workflow],null,2)+'\n');
console.log('Prepared LOCAL TEST workflow: output/n8n-failure-test/workflow.json; credential values are not included.');
