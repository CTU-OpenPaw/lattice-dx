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
  name: 'latticePublicFormSubmissions',
  migrationRules: ['schema-only'],
  createdAt: true,
  updatedAt: true,
  fields: [
    { name: 'organizationId', type: 'string', allowNull: false },
    { name: 'formId', type: 'bigInt', allowNull: false },
    { name: 'slug', type: 'string', allowNull: false },
    { name: 'submissionCode', type: 'string', allowNull: false },
    { name: 'statusTokenHash', type: 'string', allowNull: false },
    { name: 'targetCollection', type: 'string', allowNull: false },
    { name: 'targetRecordId', type: 'string', allowNull: false },
    { name: 'status', type: 'string', allowNull: false, defaultValue: 'submitted' },
    { name: 'submittedAt', type: 'date', allowNull: false },
  ],
  indexes: [
    { name: 'uidx_lattice_pfs_org_code', fields: ['organizationId', 'submissionCode'], unique: true },
    { name: 'idx_lattice_pfs_slug_code', fields: ['slug', 'submissionCode'] },
    { name: 'idx_lattice_pfs_org_form', fields: ['organizationId', 'formId', 'submittedAt'] },
  ],
});
