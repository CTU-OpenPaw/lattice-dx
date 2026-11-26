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
  name: 'latticeOrderLines',
  title: 'Dòng đơn hàng WMS/OMS',
  origin: '@latticedx/plugin-dxos-studio',
  uiManageable: true,
  migrationRules: ['schema-only'],
  createdAt: true,
  updatedAt: true,
  fields: [
    { name: 'organizationId', type: 'string', allowNull: false },
    { name: 'orderId', type: 'bigInt' },
    { name: 'orderCode', type: 'string' },
    { name: 'lineNo', type: 'integer', allowNull: false, defaultValue: 1 },
    { name: 'sku', type: 'string', allowNull: false },
    { name: 'productName', type: 'string', allowNull: false },
    { name: 'lotId', type: 'bigInt' },
    { name: 'lotCode', type: 'string' },
    { name: 'requestedQty', type: 'double', allowNull: false },
    { name: 'allocatedQty', type: 'double', defaultValue: 0 },
    { name: 'unit', type: 'string', defaultValue: 'UNIT' },
    { name: 'targetTempMinC', type: 'double' },
    { name: 'targetTempMaxC', type: 'double' },
    { name: 'status', type: 'string', defaultValue: 'pending' },
    { name: 'notes', type: 'string' },
  ],
  indexes: [
    { name: 'uidx_lattice_order_lines_org_order_line', fields: ['organizationId', 'orderCode', 'lineNo'], unique: true },
    { name: 'idx_lattice_order_lines_org_sku', fields: ['organizationId', 'sku', 'status'] },
  ],
});
