/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { defineCollection } = require('@nocobase/database');

module.exports = defineCollection({
  name: 'latticeOrganizations',
  migrationRules: ['schema-only'],
  createdAt: true,
  updatedAt: true,
  fields: [
    { name: 'organizationId', type: 'string', allowNull: false },
    { name: 'name', type: 'string', allowNull: false },
    { name: 'region', type: 'string', allowNull: false, defaultValue: 'VN' },
    { name: 'status', type: 'string', allowNull: false, defaultValue: 'active' },
    { name: 'active', type: 'boolean', allowNull: false, defaultValue: true },
    { name: 'metadataJson', type: 'jsonb', allowNull: true },
  ],
  indexes: [
    { name: 'uidx_lattice_orgs_org_id', fields: ['organizationId'], unique: true },
  ],
});
