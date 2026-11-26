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
  name: 'latticeDataLineage',
  migrationRules: ['schema-only'],
  createdAt: true,
  updatedAt: true,
  fields: [
    { name: 'organizationId', type: 'string', allowNull: false },
    { name: 'edgeUid', type: 'string', allowNull: false },
    { name: 'sourceCollection', type: 'string', allowNull: false },
    { name: 'sourceRecordId', type: 'string', allowNull: false },
    { name: 'targetCollection', type: 'string', allowNull: false },
    { name: 'targetRecordId', type: 'string', allowNull: false },
    { name: 'relationType', type: 'string', allowNull: false },
    { name: 'actorName', type: 'string' },
    { name: 'metadataJson', type: 'jsonb' },
    { name: 'observedAt', type: 'date', allowNull: false },
  ],
  indexes: [
    { name: 'uidx_lattice_lineage_org_edge', fields: ['organizationId', 'edgeUid'], unique: true },
    { name: 'idx_lattice_lineage_org_source', fields: ['organizationId', 'sourceCollection', 'sourceRecordId'] },
    { name: 'idx_lattice_lineage_org_target', fields: ['organizationId', 'targetCollection', 'targetRecordId'] },
  ],
});
