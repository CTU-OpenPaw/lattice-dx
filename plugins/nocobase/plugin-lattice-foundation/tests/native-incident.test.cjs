// SPDX-License-Identifier: Apache-2.0
const assert=require('node:assert/strict');
const test=require('node:test');
const {incidentProcessTemplate}=require('../src/server/native-process-template');
const {createIntegrationActions}=require('../src/server/native-integrations');

test('native incident separates reviewer, handler and closing tasks',()=>{
  const template=incidentProcessTemplate({organizationId:'org-a',reviewerEmployeeId:1,assigneeEmployeeId:2});
  assert.equal(template.workflow.config.collection,'latticeIncidentCases');
  assert.deepEqual(template.nodes.filter(node=>node.type==='manual').map(node=>node.key),['review','resolution','close']);
  assert.throws(()=>incidentProcessTemplate({organizationId:'org-a',reviewerEmployeeId:1,assigneeEmployeeId:'1'}));
});
test('native alert requires a connector role',async()=>{
  await assert.rejects(createIntegrationActions().receiveAlert({method:'POST',state:{currentRole:'ldx_employee'}}),{status:403});
});

test('native case dispatch uses the case id and filters by organization',async()=>{
  const {uc2InboxWorkflow}=await import('../../../../scripts/lib/uc2-inbox-workflow.mjs');
  const workflow=uc2InboxWorkflow({
    organizationId:'org-a',target:'case',
    webhookUrl:'http://n8n/webhook/latticedx/uc2/observation',webhookKey:'fixture-credential-value-123',
  });
  assert.equal(workflow.config.collection,'latticeIncidentCases');
  assert.deepEqual(workflow.config.condition,{organizationId:'org-a',status:'open',code:{$startsWith:'UC2-'}});
  assert.deepEqual(JSON.parse(workflow.request.config.data),{caseId:'{{$context.data.id}}'});
});
