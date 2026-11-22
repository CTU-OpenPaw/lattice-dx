/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { Migration } = require('@nocobase/server');

const INDEXES = [
  ['idx_lattice_ai_profiles_org_enabled', 'latticeAiProfiles', ['organizationId', 'enabled']],
  ['idx_lattice_ai_audit_org_created', 'latticeAiAuditLogs', ['organizationId', 'createdAt']],
  ['idx_lattice_ai_audit_emp_status_created', 'latticeAiAuditLogs', ['aiEmployee', 'status', 'createdAt']],
  ['idx_lattice_ai_audit_actor_created', 'latticeAiAuditLogs', ['actorUserId', 'createdAt']],
  ['idx_lattice_ai_audit_tool_created', 'latticeAiAuditLogs', ['toolName', 'createdAt']],
  ['idx_lattice_ui_snapshots_portal_page_created', 'latticeUiSnapshots', ['portalSlug', 'pageTitle', 'createdAt']],
  ['idx_lattice_ui_snapshots_grid_created', 'latticeUiSnapshots', ['gridUid', 'createdAt']],
];

class AiIndexes extends Migration {
  on = 'afterSync';

  async up() {
    const { sequelize } = this.context.db;
    await sequelize.transaction(async (transaction) => {
      for (const [name, table, cols] of INDEXES) {
        const colSql = cols.map((c) => `"${c}"`).join(', ');
        await sequelize.query(`CREATE INDEX IF NOT EXISTS "${name}" ON "${table}" (${colSql});`, { transaction });
      }
    });
  }

  async down() {
    const { sequelize } = this.context.db;
    await sequelize.transaction(async (transaction) => {
      for (const [name] of [...INDEXES].reverse()) {
        await sequelize.query(`DROP INDEX IF EXISTS "${name}";`, { transaction });
      }
    });
  }
}

module.exports = AiIndexes;
module.exports.default = AiIndexes;
