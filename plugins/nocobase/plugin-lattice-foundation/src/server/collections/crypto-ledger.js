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
  name: 'latticeCryptoLedger',
  migrationRules: ['schema-only'],
  createdAt: true,
  updatedAt: true,
  fields: [
    { name: 'organizationId', type: 'string', allowNull: false },
    { name: 'seq', type: 'bigInt', allowNull: false },
    { name: 'eventType', type: 'string', allowNull: false },
    { name: 'targetCollection', type: 'string', allowNull: false },
    { name: 'targetRecordId', type: 'string', allowNull: false },
    { name: 'actorUserId', type: 'string' },
    { name: 'actorName', type: 'string' },
    { name: 'payloadHash', type: 'string', allowNull: false },
    { name: 'prevHash', type: 'string', allowNull: false },
    { name: 'entryHash', type: 'string', allowNull: false },
    { name: 'merkleRoot', type: 'string', allowNull: false },
    { name: 'signatureBase64', type: 'text', allowNull: false },
    { name: 'keyId', type: 'string', allowNull: false },
    { name: 'metadataJson', type: 'jsonb' },
    { name: 'recordedAt', type: 'date', allowNull: false },
  ],
  indexes: [
    { name: 'uidx_lattice_ledger_org_seq', fields: ['organizationId', 'seq'], unique: true },
    { name: 'idx_lattice_ledger_org_target', fields: ['organizationId', 'targetCollection', 'targetRecordId'] },
    { name: 'idx_lattice_ledger_org_recorded', fields: ['organizationId', 'recordedAt'] },
  ],
});
