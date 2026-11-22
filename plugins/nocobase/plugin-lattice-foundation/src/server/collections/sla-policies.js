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
  name: 'latticeSlaPolicies',
  migrationRules: ['schema-only'],
  createdAt: true,
  updatedAt: true,
  fields: [
    { name: 'organizationId', type: 'string', allowNull: false },
    { name: 'targetCollection', type: 'string', allowNull: false },
    { name: 'priority', type: 'string', allowNull: false, defaultValue: 'normal' },
    { name: 'warnAfterMinutes', type: 'integer', allowNull: false, defaultValue: 240 },
    { name: 'breachAfterMinutes', type: 'integer', allowNull: false, defaultValue: 1440 },
    { name: 'escalateToRole', type: 'string', allowNull: false, defaultValue: 'ldx_manager' },
    { name: 'notifyChannels', type: 'json' },
    { name: 'active', type: 'boolean', defaultValue: true },
  ],
  indexes: [
    { name: 'uidx_lattice_sla_org_col_prio', fields: ['organizationId', 'targetCollection', 'priority'], unique: true },
  ],
});
