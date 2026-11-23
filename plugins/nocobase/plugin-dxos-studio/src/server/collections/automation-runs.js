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
  name: 'latticeAutomationRuns',
  migrationRules: ['schema-only'],
  createdAt: true,
  updatedAt: true,
  fields: [
    { name: 'organizationId', type: 'string', allowNull: false },
    { name: 'ruleId', type: 'bigInt', allowNull: true },
    { name: 'ruleKey', type: 'string', allowNull: false },
    { name: 'runUid', type: 'string', allowNull: false },
    { name: 'triggerEventId', type: 'string', allowNull: true },
    { name: 'triggerEventType', type: 'string', allowNull: false },
    { name: 'status', type: 'string', allowNull: false, defaultValue: 'running' },
    { name: 'depth', type: 'integer', allowNull: false, defaultValue: 0 },
    { name: 'matched', type: 'boolean', allowNull: false, defaultValue: false },
    { name: 'dmnResultJson', type: 'jsonb', allowNull: true },
    { name: 'stepTracesJson', type: 'jsonb', allowNull: false, defaultValue: [] },
    { name: 'errorMessage', type: 'text', allowNull: true },
    { name: 'startedAt', type: 'date', allowNull: false },
    { name: 'finishedAt', type: 'date', allowNull: true },
    { name: 'durationMs', type: 'integer', allowNull: true },
  ],
  indexes: [
    { name: 'uidx_lattice_auto_runs_org_uid', fields: ['organizationId', 'runUid'], unique: true },
    { name: 'idx_lattice_auto_runs_org_rule', fields: ['organizationId', 'ruleKey'] },
    { name: 'idx_lattice_auto_runs_org_started', fields: ['organizationId', 'startedAt'] },
  ],
});
