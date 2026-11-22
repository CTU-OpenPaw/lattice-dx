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
  name: 'latticeRecordChatter',
  migrationRules: ['schema-only'],
  createdAt: true,
  updatedAt: true,
  fields: [
    { name: 'organizationId', type: 'string', allowNull: false },
    { name: 'targetCollection', type: 'string', allowNull: false },
    { name: 'targetRecordId', type: 'bigInt', allowNull: false },
    { name: 'entryType', type: 'string', allowNull: false, defaultValue: 'comment' },
    { name: 'body', type: 'text', allowNull: false },
    { name: 'mentionsJson', type: 'json' },
    { name: 'diffJson', type: 'json' },
    { name: 'authorUserId', type: 'bigInt' },
    { name: 'authorEmployeeId', type: 'bigInt' },
    { name: 'authorName', type: 'string', allowNull: false },
  ],
  indexes: [
    { name: 'idx_lattice_chatter_org_target', fields: ['organizationId', 'targetCollection', 'targetRecordId', 'createdAt'] },
    { name: 'idx_lattice_chatter_org_type', fields: ['organizationId', 'entryType', 'createdAt'] },
    { name: 'idx_lattice_chatter_org_author', fields: ['organizationId', 'authorUserId', 'createdAt'] },
  ],
});
