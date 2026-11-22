/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');

test('listWorkflowTemplates returns all 4 DX-OS Poka-yoke workflow templates', () => {
  const { listWorkflowTemplates } = require(path.join(PLUGIN_ROOT, 'src/server/workflow-templates.js'));
  const templates = listWorkflowTemplates();
  assert.deepEqual(
    templates.map((t) => t.key),
    ['procurement', 'logistics-5step', 'incident-uc2', 'internal-service'],
  );
  for (const t of templates) {
    assert.ok(t.collection);
    assert.ok(Array.isArray(t.requiredBindings) && t.requiredBindings.length >= 2);
  }
});

test('buildWorkflowTemplate builds valid logistics-5step graph updating assigneeId per stage without schema changes', () => {
  const { buildWorkflowTemplate } = require(path.join(PLUGIN_ROOT, 'src/server/workflow-templates.js'));
  const built = buildWorkflowTemplate('logistics-5step', {
    organizationId: 'demo-organization-01',
    managerEmployeeId: 2,
    warehouseEmployeeId: 3,
    dispatcherEmployeeId: 4,
    driverEmployeeId: 5,
  });

  assert.equal(built.workflow.config.collection, 'latticeOrders');
  assert.equal(built.workflow.options.dxosTemplateKey, 'logistics-5step');

  const keys = built.nodes.map((n) => n.key);
  assert.ok(keys.includes('separation'));
  assert.ok(keys.includes('review'));
  assert.ok(keys.includes('prepareWarehouse'));
  assert.ok(keys.includes('assignWarehouse'));
  assert.ok(keys.includes('dispatchOrder'));
  assert.ok(keys.includes('assignDriver'));
  assert.ok(keys.includes('driverDeliver'));
  assert.ok(keys.includes('markCompleted'));
  assert.ok(keys.includes('endRejected'));

  const assignWarehouse = built.nodes.find((n) => n.key === 'assignWarehouse');
  assert.equal(assignWarehouse.config.params.values.status, 'preparing');
  assert.ok(assignWarehouse.config.params.values.assigneeId);

  const assignDriver = built.nodes.find((n) => n.key === 'assignDriver');
  assert.equal(assignDriver.config.params.values.status, 'in_transit');
  assert.ok(assignDriver.config.params.values.assigneeId);
  assert.ok(assignDriver.config.params.values.decisionReason);

  const endRejected = built.nodes.find((n) => n.key === 'endRejected');
  assert.equal(endRejected.type, 'end');
  assert.equal(endRejected.config.endStatus, 1);

  // Rejects duplicate role bindings
  assert.throws(
    () => buildWorkflowTemplate('logistics-5step', {
      organizationId: 'demo-organization-01',
      managerEmployeeId: 2,
      warehouseEmployeeId: 2,
      dispatcherEmployeeId: 4,
      driverEmployeeId: 5,
    }),
    (err) => err.status === 400,
  );
});

test('buildWorkflowTemplate builds incident-uc2, procurement, and internal-service graphs cleanly', () => {
  const { buildWorkflowTemplate } = require(path.join(PLUGIN_ROOT, 'src/server/workflow-templates.js'));

  const incident = buildWorkflowTemplate('incident-uc2', {
    organizationId: 'org-a',
    reviewerEmployeeId: 2,
    assigneeEmployeeId: 3,
  });
  assert.equal(incident.workflow.config.collection, 'latticeIncidentCases');
  const endRej = incident.nodes.find((n) => n.key === 'endRejected');
  assert.equal(endRej.type, 'end');
  assert.equal(endRej.config.endStatus, 1);

  const service = buildWorkflowTemplate('internal-service', {
    organizationId: 'org-a',
    reviewerEmployeeId: 2,
    assigneeEmployeeId: 4,
  });
  assert.equal(service.workflow.config.collection, 'latticeServiceTickets');
  assert.ok(service.nodes.find((n) => n.key === 'markCompleted' && n.config.params.values.status === 'completed'));
  assert.ok(service.nodes.find((n) => n.key === 'endRejected' && n.config.endStatus === 1));
});
