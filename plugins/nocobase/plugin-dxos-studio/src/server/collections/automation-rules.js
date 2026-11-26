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
  name: 'latticeAutomationRules',
  migrationRules: ['schema-only'],
  createdAt: true,
  updatedAt: true,
  fields: [
    { name: 'organizationId', type: 'string', allowNull: false },
    { name: 'ruleKey', type: 'string', allowNull: false },
    { name: 'name', type: 'string', allowNull: false },
    { name: 'description', type: 'text', allowNull: true },
    { name: 'triggerEventType', type: 'string', allowNull: false, defaultValue: '*' },
    { name: 'filterJson', type: 'jsonb', allowNull: true },
    { name: 'dmnTableKey', type: 'string', allowNull: true },
    { name: 'actionsJson', type: 'jsonb', allowNull: false, defaultValue: [] },
    { name: 'maxDepth', type: 'integer', allowNull: false, defaultValue: 8 },
    { name: 'cooldownSec', type: 'integer', allowNull: false, defaultValue: 0 },
    { name: 'active', type: 'boolean', allowNull: false, defaultValue: true },
    { name: 'lastTriggeredAt', type: 'date', allowNull: true },
    { name: 'createdBy', type: 'string', allowNull: true },
    { name: 'schemaVersion', type: 'integer', allowNull: false, defaultValue: 1 },
    { name: 'graphJson', type: 'jsonb', allowNull: true },
    { name: 'draftGraphJson', type: 'jsonb', allowNull: true },
    { name: 'publishedVersion', type: 'integer', allowNull: false, defaultValue: 1 },
    { name: 'triggerIndexJson', type: 'jsonb', allowNull: false, defaultValue: [] },
  ],
  indexes: [
    { name: 'uidx_lattice_auto_rules_org_key', fields: ['organizationId', 'ruleKey'], unique: true },
    { name: 'idx_lattice_auto_rules_org_event', fields: ['organizationId', 'triggerEventType'] },
  ],
});
