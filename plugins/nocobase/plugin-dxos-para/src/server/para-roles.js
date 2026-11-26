/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { paraDocuments } = require('./schema');

const ALL_LDX_ROLES = ['ldx_employee', 'ldx_manager', 'ldx_warehouse', 'ldx_dispatcher', 'ldx_driver', 'ldx_director', 'ldx_admin'];
const READ_ONLY_FIELDS = new Set(['id', 'createdAt', 'updatedAt', 'organizationId', 'ownerId']);

function paraFields() {
  return [
    'id',
    'createdAt',
    'updatedAt',
    ...paraDocuments.fields.map((f) => (f.type === 'belongsTo' ? f.foreignKey : f.name)),
  ];
}

function buildParaGrant(roleName) {
  const fields = paraFields();
  const writable = fields.filter((f) => !READ_ONLY_FIELDS.has(f));
  const actions = [{ name: 'view', fields }];
  if (roleName !== 'ldx_director') {
    actions.push(
      { name: 'create', fields: writable },
      { name: 'update', fields: writable },
    );
  }
  return {
    name: paraDocuments.name,
    roleName,
    dataSourceKey: 'main',
    usingActionsConfig: true,
    actions,
  };
}

async function installParaRoleGrants(db) {
  const roles = db.getRepository('roles');
  const resources = db.getRepository('dataSourcesRolesResources');
  if (!roles || !resources) return { granted: [] };
  const granted = [];
  const run = async (transaction) => {
    for (const roleName of ALL_LDX_ROLES) {
      if (!(await roles.findOne({ filter: { name: roleName }, transaction }))) continue;
      const filter = { name: paraDocuments.name, roleName, dataSourceKey: 'main' };
      if (await resources.findOne({ filter, transaction })) continue;
      await resources.create({ values: buildParaGrant(roleName), transaction });
      granted.push(roleName);
    }
  };
  if (typeof db.sequelize?.transaction === 'function') await db.sequelize.transaction(run);
  else await run(undefined);
  return { granted };
}

module.exports = { ALL_LDX_ROLES, paraFields, buildParaGrant, installParaRoleGrants };
