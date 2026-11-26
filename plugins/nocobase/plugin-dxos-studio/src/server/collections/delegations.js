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
  name: 'latticeDelegations',
  title: 'Ủy quyền vai trò có thời hạn',
  origin: '@latticedx/plugin-dxos-studio',
  uiManageable: true,
  migrationRules: ['schema-only'],
  createdAt: true,
  updatedAt: true,
  fields: [
    { name: 'organizationId', type: 'string', allowNull: false },
    { name: 'delegationUid', type: 'string', allowNull: false },
    { name: 'delegatorUserId', type: 'bigInt', allowNull: false },
    { name: 'delegatorEmployeeId', type: 'bigInt' },
    { name: 'delegateUserId', type: 'bigInt', allowNull: false },
    { name: 'delegateEmployeeId', type: 'bigInt' },
    { name: 'roleName', type: 'string', allowNull: false },
    { name: 'scopeCollection', type: 'string' },
    { name: 'reason', type: 'string' },
    { name: 'startsAt', type: 'date', allowNull: false },
    { name: 'endsAt', type: 'date', allowNull: false },
    { name: 'status', type: 'string', defaultValue: 'active' },
    { name: 'revokedBy', type: 'string' },
    { name: 'revokedAt', type: 'date' },
    { name: 'active', type: 'boolean', defaultValue: true },
  ],
  indexes: [
    { name: 'uidx_lattice_delegation_org_uid', fields: ['organizationId', 'delegationUid'], unique: true },
    { name: 'idx_lattice_delegation_org_delegate', fields: ['organizationId', 'delegateUserId', 'status'] },
  ],
});
