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
  name: 'latticeTelemetryPoints',
  migrationRules: ['schema-only'],
  createdAt: true,
  updatedAt: true,
  fields: [
    { name: 'organizationId', type: 'string', allowNull: false },
    { name: 'assetId', type: 'bigInt' },
    { name: 'assetEntityId', type: 'string', allowNull: false },
    { name: 'metricName', type: 'string', allowNull: false, defaultValue: 'temperature' },
    { name: 'numericValue', type: 'double', allowNull: false },
    { name: 'unit', type: 'string', defaultValue: 'CEL' },
    { name: 'quality', type: 'string', defaultValue: 'good' },
    { name: 'sourceProtocol', type: 'string', defaultValue: 'http' },
    { name: 'observedAt', type: 'date', allowNull: false },
  ],
  indexes: [
    {
      name: 'idx_lattice_telemetry_org_entity_metric_obs',
      fields: ['organizationId', 'assetEntityId', 'metricName', 'observedAt'],
    },
  ],
});
