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
  name: 'latticeBrokerSubscriptions',
  migrationRules: ['schema-only'],
  createdAt: true,
  updatedAt: true,
  fields: [
    { name: 'organizationId', type: 'string', allowNull: false },
    { name: 'subscriptionKey', type: 'string', allowNull: false },
    { name: 'brokerType', type: 'string', allowNull: false, defaultValue: 'orion_ld' },
    { name: 'externalSubscriptionId', type: 'string' },
    { name: 'entityType', type: 'string', allowNull: false },
    { name: 'watchedAttributesJson', type: 'jsonb', allowNull: false, defaultValue: [] },
    { name: 'notificationEndpoint', type: 'string', allowNull: false },
    { name: 'throttlingSec', type: 'integer', allowNull: false, defaultValue: 5 },
    { name: 'active', type: 'boolean', allowNull: false, defaultValue: true },
    { name: 'lastNotifiedAt', type: 'date' },
    { name: 'lastError', type: 'text' },
  ],
  indexes: [
    {
      name: 'uidx_lattice_broker_subs_org_key',
      fields: ['organizationId', 'subscriptionKey'],
      unique: true,
    },
    {
      name: 'idx_lattice_broker_subs_org_active',
      fields: ['organizationId', 'brokerType', 'active'],
    },
  ],
});
