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
  name: 'latticeApiKeys',
  migrationRules: ['schema-only'],
  createdAt: true,
  updatedAt: true,
  fields: [
    { name: 'organizationId', type: 'string', allowNull: false },
    { name: 'name', type: 'string', allowNull: false },
    { name: 'keyPrefix', type: 'string', allowNull: false },
    { name: 'keyHash', type: 'string', unique: true, allowNull: false },
    { name: 'userId', type: 'bigInt', allowNull: false },
    { name: 'employeeId', type: 'bigInt' },
    { name: 'roleName', type: 'string', allowNull: false },
    { name: 'scopesJson', type: 'jsonb' },
    { name: 'expiresAt', type: 'date' },
    { name: 'lastUsedAt', type: 'date' },
    { name: 'revokedAt', type: 'date' },
    { name: 'revokedBy', type: 'string' },
    { name: 'createdByUserId', type: 'bigInt' },
    { name: 'active', type: 'boolean', defaultValue: true },
  ],
  indexes: [
    { name: 'uidx_lattice_api_keys_hash', fields: ['keyHash'], unique: true },
    { name: 'idx_lattice_api_keys_org_user', fields: ['organizationId', 'userId', 'active'] },
    { name: 'idx_lattice_api_keys_org_prefix', fields: ['organizationId', 'keyPrefix'] },
  ],
});
