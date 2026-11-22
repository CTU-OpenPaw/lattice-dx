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
  name: 'latticeNotifications',
  migrationRules: ['schema-only'],
  createdAt: true,
  updatedAt: true,
  fields: [
    { name: 'organizationId', type: 'string', allowNull: false },
    { name: 'recipientUserId', type: 'bigInt', allowNull: false },
    { name: 'recipientEmployeeId', type: 'bigInt' },
    { name: 'category', type: 'string', allowNull: false, defaultValue: 'system' },
    { name: 'severity', type: 'string', allowNull: false, defaultValue: 'info' },
    { name: 'title', type: 'string', allowNull: false },
    { name: 'body', type: 'text' },
    { name: 'targetCollection', type: 'string' },
    { name: 'targetRecordId', type: 'bigInt' },
    { name: 'targetPath', type: 'string' },
    { name: 'dedupKey', type: 'string' },
    { name: 'readAt', type: 'date' },
    { name: 'channelsDispatched', type: 'json' },
    { name: 'active', type: 'boolean', defaultValue: true },
  ],
  indexes: [
    { name: 'idx_lattice_notif_org_user_read', fields: ['organizationId', 'recipientUserId', 'readAt', 'createdAt'] },
    { name: 'idx_lattice_notif_org_dedup', fields: ['organizationId', 'recipientUserId', 'dedupKey', 'createdAt'] },
  ],
});
