// SPDX-License-Identifier: Apache-2.0
const {test}=require('node:test');
const assert=require('node:assert/strict');
test('document process is editable native workflow configuration, not a custom executor',()=>{
  const {documentProcessTemplate}=require('../src/server/native-process-template');
  const template=documentProcessTemplate({collection:'latticeRequests',organizationId:'org-a',reviewerEmployeeId:10,assigneeEmployeeId:11});
  assert.equal(template.workflow.type,'collection');assert.equal(template.workflow.config.mode,1);assert.equal(template.workflow.enabled,false);
  assert.ok(template.nodes.length>5);
  assert.ok(template.nodes.every(node=>['query','condition','update','manual','end'].includes(node.type)));
  assert.ok(!JSON.stringify(template).includes('latticeDocuments'));
  const manual=template.nodes.filter(node=>node.type==='manual');assert.equal(manual.length,2);
  for(const node of manual){
    const schema=JSON.stringify(node.config.schema);assert.ok(schema.includes('DetailsBlockProvider'));assert.ok(schema.includes('latticeRequests.description'));assert.ok(schema.includes('$context.data'));
  }
  assert.ok(manual.every(node=>Object.values(node.config.forms).every(form=>form.type==='custom')));
  assert.equal(template.nodes.find(node=>node.key==='reviewer').config.params.filter.organizationId,'org-a');
  assert.throws(()=>documentProcessTemplate({collection:'users',organizationId:'org-a',reviewerEmployeeId:10,assigneeEmployeeId:11}));
});
