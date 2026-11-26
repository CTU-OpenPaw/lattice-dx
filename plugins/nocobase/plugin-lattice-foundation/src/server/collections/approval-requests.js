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
  name: 'latticeApprovalRequests',
  migrationRules: ['schema-only'],
  createdAt: true,
  updatedAt: true,
  fields: [
    { name: 'organizationId', type: 'string', allowNull: false },
    { name: 'requestUid', type: 'string', allowNull: false },
    { name: 'policyId', type: 'bigInt' },
    { name: 'policyKey', type: 'string' },
    { name: 'targetCollection', type: 'string', allowNull: false },
    { name: 'targetRecordId', type: 'bigInt' },
    { name: 'targetCode', type: 'string' },
    { name: 'title', type: 'string', allowNull: false },
    { name: 'summary', type: 'text' },
    { name: 'riskLevel', type: 'string', allowNull: false, defaultValue: 'medium' },
    { name: 'status', type: 'string', allowNull: false, defaultValue: 'pending' },
    { name: 'currentStageIndex', type: 'integer', allowNull: false, defaultValue: 0 },
    { name: 'totalStages', type: 'integer', allowNull: false, defaultValue: 1 },
    { name: 'stagesStateJson', type: 'json', allowNull: false, defaultValue: [] },
    { name: 'requesterUserId', type: 'bigInt', allowNull: false },
    { name: 'requesterEmployeeId', type: 'bigInt' },
    { name: 'requesterUsername', type: 'string' },
    { name: 'payloadJson', type: 'json' },
    { name: 'dueAt', type: 'date' },
    { name: 'escalatedAt', type: 'date' },
    { name: 'decidedAt', type: 'date' },
    { name: 'finalDecisionByUserId', type: 'bigInt' },
    { name: 'finalDecisionByUsername', type: 'string' },
    { name: 'finalDecisionNote', type: 'text' },
    { name: 'active', type: 'boolean', defaultValue: true },
  ],
  indexes: [
    { name: 'uidx_lattice_approval_reqs_org_uid', fields: ['organizationId', 'requestUid'], unique: true },
    { name: 'idx_lattice_approval_reqs_org_status', fields: ['organizationId', 'status', 'dueAt'] },
    { name: 'idx_lattice_approval_reqs_org_target', fields: ['organizationId', 'targetCollection', 'targetRecordId'] },
    { name: 'idx_lattice_approval_reqs_org_req', fields: ['organizationId', 'requesterUserId', 'status'] },
  ],
});
