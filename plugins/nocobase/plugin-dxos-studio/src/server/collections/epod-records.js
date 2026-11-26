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
  name: 'latticeEpodRecords',
  title: 'Biên bản giao nhận điện tử ePOD',
  origin: '@latticedx/plugin-dxos-studio',
  uiManageable: true,
  migrationRules: ['schema-only'],
  createdAt: true,
  updatedAt: true,
  fields: [
    { name: 'organizationId', type: 'string', allowNull: false },
    { name: 'epodUid', type: 'string', allowNull: false },
    { name: 'trackingCode', type: 'string', allowNull: false },
    { name: 'trackingTokenHash', type: 'string', allowNull: false },
    { name: 'orderId', type: 'bigInt' },
    { name: 'orderCode', type: 'string' },
    { name: 'driverUserId', type: 'bigInt' },
    { name: 'driverEmployeeId', type: 'bigInt' },
    { name: 'recipientName', type: 'string', allowNull: false },
    { name: 'recipientPhoneMasked', type: 'string' },
    { name: 'deliveredQty', type: 'double', defaultValue: 0 },
    { name: 'signatureDataUrl', type: 'text' },
    { name: 'signatureSha256', type: 'string', allowNull: false },
    { name: 'gpsLat', type: 'double' },
    { name: 'gpsLng', type: 'double' },
    { name: 'gpsAccuracyM', type: 'double' },
    { name: 'photoHashesJson', type: 'jsonb' },
    { name: 'tempSummaryJson', type: 'jsonb' },
    { name: 'ledgerSeq', type: 'bigInt' },
    { name: 'ledgerSignatureBase64', type: 'text' },
    { name: 'keyId', type: 'string' },
    { name: 'status', type: 'string', defaultValue: 'delivered' },
    { name: 'deliveredAt', type: 'date', allowNull: false },
    { name: 'notes', type: 'string' },
  ],
  indexes: [
    { name: 'uidx_lattice_epod_org_uid', fields: ['organizationId', 'epodUid'], unique: true },
    { name: 'uidx_lattice_epod_tracking_code', fields: ['trackingCode'], unique: true },
    { name: 'idx_lattice_epod_org_order', fields: ['organizationId', 'orderCode'] },
  ],
});
