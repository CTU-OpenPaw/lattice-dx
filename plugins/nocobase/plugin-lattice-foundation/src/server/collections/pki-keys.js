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
  name: 'latticePkiKeys',
  migrationRules: ['schema-only'],
  createdAt: true,
  updatedAt: true,
  fields: [
    { name: 'organizationId', type: 'string', unique: true, allowNull: false },
    { name: 'keyId', type: 'string', allowNull: false },
    { name: 'algorithm', type: 'string', defaultValue: 'Ed25519' },
    { name: 'publicKeyPem', type: 'text', allowNull: false },
    { name: 'encryptedPrivateKey', type: 'text', allowNull: false },
    { name: 'fingerprintSha256', type: 'string', allowNull: false },
    { name: 'active', type: 'boolean', defaultValue: true },
  ],
  indexes: [
    { name: 'uidx_lattice_pki_keys_org', fields: ['organizationId'], unique: true },
    { name: 'idx_lattice_pki_keys_key_id', fields: ['keyId'] },
  ],
});
