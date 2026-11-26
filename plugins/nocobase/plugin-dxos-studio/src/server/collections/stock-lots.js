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
  name: 'latticeStockLots',
  title: 'Lô tồn kho FEFO & Kho lạnh',
  origin: '@latticedx/plugin-dxos-studio',
  uiManageable: true,
  migrationRules: ['schema-only'],
  createdAt: true,
  updatedAt: true,
  fields: [
    { name: 'organizationId', type: 'string', allowNull: false },
    { name: 'lotCode', type: 'string', allowNull: false },
    { name: 'sku', type: 'string', allowNull: false },
    { name: 'productName', type: 'string', allowNull: false },
    { name: 'warehouseLocationId', type: 'bigInt' },
    { name: 'warehouseCode', type: 'string' },
    { name: 'assetEntityId', type: 'string' },
    { name: 'qtyOnHand', type: 'double', allowNull: false, defaultValue: 0 },
    { name: 'qtyReserved', type: 'double', allowNull: false, defaultValue: 0 },
    { name: 'unit', type: 'string', defaultValue: 'UNIT' },
    { name: 'expiryDate', type: 'date', allowNull: false },
    { name: 'manufacturedAt', type: 'date' },
    { name: 'targetTempMinC', type: 'double' },
    { name: 'targetTempMaxC', type: 'double' },
    { name: 'mktCelsius', type: 'double' },
    { name: 'status', type: 'string', defaultValue: 'available' },
    { name: 'holdReason', type: 'string' },
    { name: 'heldAt', type: 'date' },
    { name: 'heldBy', type: 'string' },
    { name: 'active', type: 'boolean', defaultValue: true },
  ],
  indexes: [
    { name: 'uidx_lattice_stock_lots_org_code', fields: ['organizationId', 'lotCode'], unique: true },
    { name: 'idx_lattice_stock_lots_org_fefo', fields: ['organizationId', 'sku', 'status', 'expiryDate'] },
  ],
});
