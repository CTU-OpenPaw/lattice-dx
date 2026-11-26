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
  name: 'latticeDecisionTables',
  title: 'Bảng quyết định DMN',
  origin: '@latticedx/plugin-dxos-studio',
  uiManageable: true,
  migrationRules: ['schema-only'],
  createdAt: true,
  updatedAt: true,
  fields: [
    { name: 'organizationId', type: 'string', allowNull: false },
    { name: 'tableKey', type: 'string', allowNull: false },
    { name: 'name', type: 'string', allowNull: false },
    { name: 'description', type: 'string' },
    { name: 'hitPolicy', type: 'string', defaultValue: 'FIRST' },
    { name: 'inputsJson', type: 'jsonb', allowNull: false },
    { name: 'outputsJson', type: 'jsonb', allowNull: false },
    { name: 'rulesJson', type: 'jsonb', allowNull: false },
    { name: 'version', type: 'integer', defaultValue: 1 },
    { name: 'published', type: 'boolean', defaultValue: true },
    { name: 'updatedBy', type: 'string' },
    { name: 'active', type: 'boolean', defaultValue: true },
  ],
  indexes: [
    { name: 'uidx_lattice_dmn_org_key', fields: ['organizationId', 'tableKey'], unique: true },
  ],
});
