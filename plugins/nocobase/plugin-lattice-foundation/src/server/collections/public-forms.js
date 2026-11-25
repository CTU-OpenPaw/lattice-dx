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
  name: 'latticePublicForms',
  migrationRules: ['schema-only'],
  createdAt: true,
  updatedAt: true,
  fields: [
    { name: 'organizationId', type: 'string', allowNull: false },
    { name: 'slug', type: 'string', allowNull: false },
    { name: 'title', type: 'string', allowNull: false },
    { name: 'description', type: 'text' },
    { name: 'targetCollection', type: 'string', allowNull: false },
    { name: 'allowedFieldsJson', type: 'jsonb', allowNull: false },
    { name: 'defaultValuesJson', type: 'jsonb' },
    { name: 'requireAccessToken', type: 'boolean', defaultValue: false },
    { name: 'accessTokenHash', type: 'string' },
    { name: 'honeypotField', type: 'string', defaultValue: '_hp_website' },
    { name: 'rateLimitPerMinute', type: 'integer', defaultValue: 20 },
    { name: 'workflowRuleKey', type: 'string' },
    { name: 'active', type: 'boolean', defaultValue: true },
    { name: 'createdByUserId', type: 'bigInt' },
  ],
  indexes: [
    { name: 'uidx_lattice_public_forms_slug', fields: ['slug'], unique: true },
    { name: 'idx_lattice_public_forms_org_active', fields: ['organizationId', 'active'] },
  ],
});
