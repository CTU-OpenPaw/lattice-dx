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
  name: 'latticeWebhookDeliveries',
  migrationRules: ['schema-only'],
  createdAt: true,
  updatedAt: true,
  fields: [
    { name: 'organizationId', type: 'string', allowNull: false },
    { name: 'eventId', type: 'string', allowNull: false },
    { name: 'subscriptionId', type: 'bigInt', allowNull: false },
    { name: 'eventType', type: 'string', allowNull: false },
    { name: 'attempt', type: 'integer', allowNull: false, defaultValue: 0 },
    { name: 'maxAttempts', type: 'integer', allowNull: false, defaultValue: 5 },
    { name: 'status', type: 'string', allowNull: false, defaultValue: 'pending' },
    { name: 'nextAttemptAt', type: 'date' },
    { name: 'lockedAt', type: 'date' },
    { name: 'lockedBy', type: 'string' },
    { name: 'httpStatus', type: 'integer' },
    { name: 'lastError', type: 'text' },
    { name: 'payloadSnapshotJson', type: 'jsonb', allowNull: false },
    { name: 'deliveredAt', type: 'date' },
  ],
  indexes: [
    { name: 'idx_lattice_wh_del_status_next', fields: ['status', 'nextAttemptAt'] },
    { name: 'idx_lattice_wh_del_org_status', fields: ['organizationId', 'status', 'createdAt'] },
    { name: 'idx_lattice_wh_del_sub_event', fields: ['subscriptionId', 'eventId'] },
  ],
});
