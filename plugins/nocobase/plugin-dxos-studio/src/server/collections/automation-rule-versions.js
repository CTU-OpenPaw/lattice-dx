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
  name: 'latticeAutomationRuleVersions',
  migrationRules: ['schema-only'],
  createdAt: true,
  updatedAt: true,
  fields: [
    { name: 'organizationId', type: 'string', allowNull: false },
    { name: 'ruleId', type: 'bigInt', allowNull: true },
    { name: 'ruleUid', type: 'string', allowNull: true },
    { name: 'ruleKey', type: 'string', allowNull: false },
    { name: 'version', type: 'integer', allowNull: false },
    { name: 'graphJson', type: 'jsonb', allowNull: false },
    { name: 'triggerIndexJson', type: 'jsonb', allowNull: false, defaultValue: [] },
    { name: 'changeSummary', type: 'text', allowNull: true },
    { name: 'publishedBy', type: 'string', allowNull: true },
    { name: 'publishedAt', type: 'date', allowNull: false },
  ],
  indexes: [
    { name: 'uidx_lattice_auto_rule_ver_org_key_ver', fields: ['organizationId', 'ruleKey', 'version'], unique: true },
    { name: 'idx_lattice_auto_rule_ver_org_rule_id', fields: ['organizationId', 'ruleId'] },
  ],
});
