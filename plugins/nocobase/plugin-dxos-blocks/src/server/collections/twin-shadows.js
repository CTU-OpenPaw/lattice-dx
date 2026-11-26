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
  name: 'latticeTwinShadows',
  migrationRules: ['schema-only'],
  createdAt: true,
  updatedAt: true,
  fields: [
    { name: 'organizationId', type: 'string', allowNull: false },
    { name: 'assetId', type: 'bigInt' },
    { name: 'assetEntityId', type: 'string', allowNull: false },
    { name: 'desiredJson', type: 'jsonb', allowNull: false, defaultValue: {} },
    { name: 'reportedJson', type: 'jsonb', allowNull: false, defaultValue: {} },
    { name: 'lastDeltaJson', type: 'jsonb', allowNull: false, defaultValue: {} },
    { name: 'pendingCommandId', type: 'string' },
    { name: 'commandStatus', type: 'string', allowNull: false, defaultValue: 'synced' },
    { name: 'lastDispatchedAt', type: 'date' },
    { name: 'lastAckedAt', type: 'date' },
    { name: 'lastReportedAt', type: 'date' },
    { name: 'version', type: 'integer', allowNull: false, defaultValue: 1 },
    { name: 'updatedBy', type: 'string' },
  ],
  indexes: [
    {
      name: 'uidx_lattice_twin_org_entity',
      fields: ['organizationId', 'assetEntityId'],
      unique: true,
    },
    {
      name: 'idx_lattice_twin_org_status',
      fields: ['organizationId', 'commandStatus'],
    },
  ],
});
