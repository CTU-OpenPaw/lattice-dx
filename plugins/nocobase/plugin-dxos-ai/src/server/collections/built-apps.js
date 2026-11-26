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
  name: 'latticeBuiltApps',
  title: 'Ứng dụng Doanh nghiệp đã Dựng DX-OS',
  titleField: 'name',
  origin: '@latticedx/plugin-dxos-ai',
  uiManageable: false,
  migrationRules: ['schema-only'],
  createdAt: true,
  updatedAt: true,
  fields: [
    { name: 'organizationId', type: 'string', interface: 'input', allowNull: false },
    { name: 'appKey', type: 'string', interface: 'input', allowNull: false },
    { name: 'name', type: 'string', interface: 'input', allowNull: false },
    { name: 'version', type: 'integer', interface: 'integer', allowNull: false, defaultValue: 1 },
    { name: 'status', type: 'string', interface: 'input', allowNull: false, defaultValue: 'active' },
    { name: 'sourceSpecJson', type: 'jsonb', defaultValue: {} },
    { name: 'artifactRefsJson', type: 'jsonb', defaultValue: {} },
    { name: 'versionHistoryJson', type: 'jsonb', defaultValue: [] },
    { name: 'bundleSnapshotUid', type: 'string', interface: 'input' },
    { name: 'lastVerifiedAt', type: 'date', interface: 'datetime' },
    { name: 'lastVerificationJson', type: 'jsonb' },
    { name: 'createdBy', type: 'string', interface: 'input' },
  ],
  indexes: [
    { name: 'uidx_lattice_built_apps_org_key', fields: ['organizationId', 'appKey'], unique: true },
    { name: 'idx_lattice_built_apps_org_status', fields: ['organizationId', 'status'] },
  ],
});
