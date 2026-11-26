/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

module.exports = require('@nocobase/database').defineCollection({
  name: 'latticeA2aTasks',
  title: 'Tác vụ Giao thức A2A LatticeDX',
  titleField: 'taskId',
  origin: '@latticedx/plugin-dxos-ai',
  uiManageable: false,
  migrationRules: ['schema-only'],
  createdAt: true,
  updatedAt: true,
  fields: [
    { name: 'taskId', type: 'string', interface: 'input', allowNull: false, index: true },
    { name: 'organizationId', type: 'string', interface: 'input', allowNull: false, index: true },
    { name: 'sourceAgentId', type: 'string', interface: 'input', allowNull: true },
    { name: 'targetAgentId', type: 'string', interface: 'input', allowNull: true, index: true },
    { name: 'peerUrl', type: 'string', interface: 'input', allowNull: true },
    { name: 'status', type: 'string', interface: 'input', allowNull: false, defaultValue: 'submitted' },
    { name: 'messagesJson', type: 'jsonb', defaultValue: [] },
    { name: 'artifactsJson', type: 'jsonb', defaultValue: [] },
    { name: 'metadataJson', type: 'jsonb', defaultValue: {} },
    { name: 'errorJson', type: 'jsonb', allowNull: true },
    { name: 'createdById', type: 'string', interface: 'input', allowNull: true },
    { name: 'idempotencyKey', type: 'string', interface: 'input', allowNull: true },
  ],
  indexes: [
    { name: 'uidx_lattice_a2a_tasks_org_task', fields: ['organizationId', 'taskId'], unique: true },
    { name: 'idx_lattice_a2a_tasks_task_id', fields: ['taskId'] },
    { name: 'idx_lattice_a2a_tasks_org_target_status', fields: ['organizationId', 'targetAgentId', 'status'] },
    { name: 'idx_lattice_a2a_tasks_org_idem', fields: ['organizationId', 'idempotencyKey'] },
  ],
});
