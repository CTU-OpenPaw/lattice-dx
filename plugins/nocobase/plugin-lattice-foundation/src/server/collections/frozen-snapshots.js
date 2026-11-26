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
  name: 'latticeFrozenSnapshots',
  migrationRules: ['schema-only'],
  createdAt: true,
  updatedAt: true,
  fields: [
    { name: 'organizationId', type: 'string', allowNull: false },
    { name: 'snapshotUid', type: 'string', allowNull: false },
    { name: 'tier', type: 'string', defaultValue: 'cold' },
    { name: 'sourceCollection', type: 'string', allowNull: false },
    { name: 'filterSummary', type: 'jsonb' },
    { name: 'recordCount', type: 'integer', allowNull: false },
    { name: 'payloadJson', type: 'jsonb', allowNull: false },
    { name: 'payloadHash', type: 'string', allowNull: false },
    { name: 'ledgerEntrySeq', type: 'bigInt' },
    { name: 'signatureBase64', type: 'text' },
    { name: 'keyId', type: 'string' },
    { name: 'frozenAt', type: 'date', allowNull: false },
    { name: 'frozenBy', type: 'string' },
    { name: 'retentionDays', type: 'integer', defaultValue: 1825 },
    { name: 'expiresAt', type: 'date' },
    { name: 'coldStorageUri', type: 'string' },
    { name: 'status', type: 'string', defaultValue: 'sealed' },
    { name: 'active', type: 'boolean', defaultValue: true },
  ],
  indexes: [
    { name: 'uidx_lattice_frozen_org_uid', fields: ['organizationId', 'snapshotUid'], unique: true },
    { name: 'idx_lattice_frozen_org_col_tier', fields: ['organizationId', 'sourceCollection', 'tier', 'frozenAt'] },
  ],
});
