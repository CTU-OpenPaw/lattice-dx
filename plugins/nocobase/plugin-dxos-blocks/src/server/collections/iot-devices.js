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
  name: 'latticeIotDevices',
  migrationRules: ['schema-only'],
  createdAt: true,
  updatedAt: true,
  fields: [
    { name: 'organizationId', type: 'string', allowNull: false },
    { name: 'deviceKey', type: 'string', allowNull: false },
    { name: 'name', type: 'string', allowNull: false },
    { name: 'mqttUsername', type: 'string', allowNull: false },
    { name: 'mqttClientId', type: 'string', allowNull: false },
    { name: 'assetId', type: 'bigInt' },
    { name: 'assetEntityId', type: 'string' },
    { name: 'topicPrefix', type: 'string', allowNull: false },
    { name: 'status', type: 'string', allowNull: false, defaultValue: 'provisioned' },
    { name: 'lastSeenAt', type: 'date' },
    { name: 'lastReason', type: 'string' },
    { name: 'metadataJson', type: 'jsonb', allowNull: false, defaultValue: {} },
  ],
  indexes: [
    {
      name: 'uidx_lattice_iot_devices_org_key',
      fields: ['organizationId', 'deviceKey'],
      unique: true,
    },
    {
      name: 'idx_lattice_iot_devices_org_status',
      fields: ['organizationId', 'status'],
    },
  ],
});
