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
  name: 'latticeConnectors',
  migrationRules: ['schema-only'],
  createdAt: true,
  updatedAt: true,
  fields: [
    { name: 'organizationId', type: 'string', allowNull: false },
    { name: 'connectorKey', type: 'string', allowNull: false },
    { name: 'name', type: 'string', allowNull: false },
    { name: 'connectorType', type: 'string', allowNull: false, defaultValue: 'webhook' },
    { name: 'baseUrl', type: 'string' },
    { name: 'authType', type: 'string', allowNull: false, defaultValue: 'none' },
    { name: 'encryptedSecretsJson', type: 'text' },
    { name: 'secretVersion', type: 'integer', allowNull: false, defaultValue: 1 },
    { name: 'lastTestedAt', type: 'date' },
    { name: 'lastTestStatus', type: 'string' },
    { name: 'active', type: 'boolean', defaultValue: true },
  ],
  indexes: [
    { name: 'uidx_lattice_connectors_org_key', fields: ['organizationId', 'connectorKey'], unique: true },
    { name: 'idx_lattice_connectors_org_type', fields: ['organizationId', 'connectorType', 'active'] },
  ],
});
