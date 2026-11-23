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
  name: 'latticeDataQuarantine',
  migrationRules: ['schema-only'],
  createdAt: true,
  updatedAt: true,
  fields: [
    { name: 'organizationId', type: 'string', allowNull: false },
    { name: 'quarantineUid', type: 'string', allowNull: false },
    { name: 'sourceSystem', type: 'string', allowNull: false, defaultValue: 'iiot' },
    { name: 'assetEntityId', type: 'string' },
    { name: 'metricName', type: 'string' },
    { name: 'numericValue', type: 'double' },
    { name: 'unit', type: 'string' },
    { name: 'reasonCode', type: 'string', allowNull: false },
    { name: 'severity', type: 'string', defaultValue: 'medium' },
    { name: 'rawPayload', type: 'jsonb', allowNull: false },
    { name: 'status', type: 'string', defaultValue: 'quarantined' },
    { name: 'resolvedBy', type: 'string' },
    { name: 'resolvedAt', type: 'date' },
    { name: 'resolutionNote', type: 'string' },
    { name: 'active', type: 'boolean', defaultValue: true },
  ],
  indexes: [
    { name: 'uidx_lattice_quarantine_org_uid', fields: ['organizationId', 'quarantineUid'], unique: true },
    { name: 'idx_lattice_quarantine_org_status', fields: ['organizationId', 'status', 'createdAt'] },
  ],
});
