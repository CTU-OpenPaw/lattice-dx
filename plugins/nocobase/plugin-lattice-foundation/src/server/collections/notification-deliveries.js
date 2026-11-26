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
  name: 'latticeNotificationDeliveries',
  migrationRules: ['schema-only'],
  createdAt: true,
  updatedAt: true,
  fields: [
    { name: 'organizationId', type: 'string', allowNull: false },
    { name: 'deliveryUid', type: 'string', allowNull: false },
    { name: 'notificationId', type: 'bigInt' },
    { name: 'channel', type: 'string', allowNull: false },
    { name: 'connectorKey', type: 'string' },
    { name: 'targetMasked', type: 'string' },
    { name: 'templateKey', type: 'string' },
    { name: 'eventType', type: 'string' },
    { name: 'status', type: 'string', allowNull: false, defaultValue: 'pending' },
    { name: 'attempt', type: 'integer', allowNull: false, defaultValue: 0 },
    { name: 'maxAttempts', type: 'integer', allowNull: false, defaultValue: 3 },
    { name: 'httpStatus', type: 'integer' },
    { name: 'providerMessageId', type: 'string' },
    { name: 'errorCode', type: 'string' },
    { name: 'errorMessage', type: 'text' },
    { name: 'payloadPreviewJson', type: 'jsonb' },
    { name: 'dryRun', type: 'boolean', allowNull: false, defaultValue: false },
    { name: 'sentAt', type: 'date' },
  ],
  indexes: [
    { name: 'uidx_lattice_notif_del_org_uid', fields: ['organizationId', 'deliveryUid'], unique: true },
    { name: 'idx_lattice_notif_del_org_status', fields: ['organizationId', 'status', 'createdAt'] },
    { name: 'idx_lattice_notif_del_org_channel', fields: ['organizationId', 'channel', 'createdAt'] },
  ],
});
