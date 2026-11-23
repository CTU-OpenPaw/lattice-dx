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
  name: 'latticeWebhookSubscriptions',
  migrationRules: ['schema-only'],
  createdAt: true,
  updatedAt: true,
  fields: [
    { name: 'organizationId', type: 'string', allowNull: false },
    { name: 'subscriptionKey', type: 'string', allowNull: false },
    { name: 'name', type: 'string', allowNull: false },
    { name: 'targetUrl', type: 'string', allowNull: false },
    { name: 'eventPattern', type: 'string', allowNull: false, defaultValue: '*' },
    { name: 'encryptedSigningSecret', type: 'text' },
    { name: 'connectorId', type: 'bigInt' },
    { name: 'active', type: 'boolean', defaultValue: true },
    { name: 'failureCount', type: 'integer', allowNull: false, defaultValue: 0 },
    { name: 'circuitState', type: 'string', allowNull: false, defaultValue: 'closed' },
    { name: 'circuitOpenUntil', type: 'date' },
    { name: 'lastError', type: 'text' },
  ],
  indexes: [
    { name: 'uidx_lattice_wh_sub_org_key', fields: ['organizationId', 'subscriptionKey'], unique: true },
    { name: 'idx_lattice_wh_sub_org_active', fields: ['organizationId', 'active', 'circuitState'] },
  ],
});
