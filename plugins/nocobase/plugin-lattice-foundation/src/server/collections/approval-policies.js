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
  name: 'latticeApprovalPolicies',
  migrationRules: ['schema-only'],
  createdAt: true,
  updatedAt: true,
  fields: [
    { name: 'organizationId', type: 'string', allowNull: false },
    { name: 'policyKey', type: 'string', allowNull: false },
    { name: 'name', type: 'string', allowNull: false },
    { name: 'description', type: 'text' },
    { name: 'targetCollection', type: 'string', allowNull: false },
    { name: 'triggerOperation', type: 'string', allowNull: false, defaultValue: 'submit' },
    { name: 'conditionJson', type: 'json' },
    { name: 'stagesJson', type: 'json', allowNull: false, defaultValue: [] },
    { name: 'allowSelfApproval', type: 'boolean', defaultValue: false },
    { name: 'slaMinutes', type: 'integer', defaultValue: 1440 },
    { name: 'escalateToRole', type: 'string', defaultValue: 'ldx_director' },
    { name: 'notifyChannels', type: 'json' },
    { name: 'priority', type: 'integer', defaultValue: 100 },
    { name: 'active', type: 'boolean', defaultValue: true },
  ],
  indexes: [
    { name: 'uidx_lattice_approval_policies_org_key', fields: ['organizationId', 'policyKey'], unique: true },
    { name: 'idx_lattice_approval_policies_org_col', fields: ['organizationId', 'targetCollection', 'active'] },
  ],
});
