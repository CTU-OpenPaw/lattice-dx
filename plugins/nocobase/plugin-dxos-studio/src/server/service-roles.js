/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { serviceTickets } = require('./service-schema');

const CURRENT_USER = '{{ ctx.state.currentUser.id }}';
const ALL_ROLES = ['ldx_employee', 'ldx_manager', 'ldx_warehouse', 'ldx_dispatcher', 'ldx_driver', 'ldx_director', 'ldx_admin'];
const PROTECTED_WRITES = new Set([
  'id', 'createdAt', 'updatedAt', 'organizationId', 'status', 'version',
  'requesterId', 'assigneeId', 'resolutionNote', 'decisionReason',
]);

function serviceFields() {
  return [
    'id',
    'createdAt',
    'updatedAt',
    ...serviceTickets.fields.map((f) => (f.type === 'belongsTo' ? f.foreignKey : f.name)),
  ];
}

function buildServiceGrant(roleName) {
  const fields = serviceFields();
  const writable = fields.filter((f) => !PROTECTED_WRITES.has(f));
  const ownScope = { name: 'Lattice — Phiếu liên quan', resourceName: serviceTickets.name, dataSourceKey: 'main', scope: { $or: [{ 'requester.userId': CURRENT_USER }, { 'assignee.userId': CURRENT_USER }] } };
  const draftScope = { name: 'Lattice — Nháp của tôi', resourceName: serviceTickets.name, dataSourceKey: 'main', scope: { 'requester.userId': CURRENT_USER, status: 'draft' } };
  const isOrgWide = ['ldx_manager', 'ldx_dispatcher', 'ldx_director', 'ldx_admin'].includes(roleName);
  const actions = [{ name: 'view', fields, ...(isOrgWide ? {} : { scope: ownScope }) }];
  if (roleName !== 'ldx_director') {
    actions.push(
      { name: 'create', fields: writable },
      { name: 'update', fields: writable, scope: draftScope },
    );
  }
  return { name: serviceTickets.name, roleName, dataSourceKey: 'main', usingActionsConfig: true, actions };
}

async function installServiceRoleGrants(db) {
  const roles = db.getRepository('roles');
  const resources = db.getRepository('dataSourcesRolesResources');
  if (!roles || !resources) return { granted: [] };
  const granted = [];
  const run = async (transaction) => {
    for (const roleName of ALL_ROLES) {
      if (!(await roles.findOne({ filter: { name: roleName }, transaction }))) continue;
      const filter = { name: serviceTickets.name, roleName, dataSourceKey: 'main' };
      if (await resources.findOne({ filter, transaction })) continue;
      await resources.create({ values: buildServiceGrant(roleName), transaction });
      granted.push(roleName);
    }
  };
  if (typeof db.sequelize?.transaction === 'function') await db.sequelize.transaction(run);
  else await run(undefined);
  return { granted };
}

module.exports = { ALL_ROLES, serviceFields, buildServiceGrant, installServiceRoleGrants };
