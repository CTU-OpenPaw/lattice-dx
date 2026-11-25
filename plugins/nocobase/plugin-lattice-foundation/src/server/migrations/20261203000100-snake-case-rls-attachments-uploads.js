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
const { attachRlsPolicyToTable, detachRlsPolicyFromTable } = require('../pg-rls');

const SNAKE_CASE_TABLES = [
  'lattice_native_request_attachments',
  'lattice_native_request_uploads',
];

async function findExistingSnakeCaseTables(sequelize, transaction) {
  const raw = await sequelize.query(
    [
      'SELECT table_name',
      'FROM information_schema.tables',
      "WHERE table_schema = 'public'",
      "  AND table_name IN ('lattice_native_request_attachments', 'lattice_native_request_uploads')",
      'ORDER BY table_name;',
    ].join('\n'),
    { transaction },
  );
  const rows = Array.isArray(raw?.[0]) ? raw[0] : (Array.isArray(raw) ? raw : []);
  const found = new Set();
  for (const row of rows) {
    const name = row?.table_name ?? row?.TABLE_NAME;
    if (typeof name === 'string') found.add(name);
  }
  return found;
}

class SnakeCaseRlsAttachmentsUploadsMigration extends Migration {
  on = 'afterSync';

  async up() {
    const db = this.context?.db;
    const sequelize = db?.sequelize;
    if (!sequelize || typeof sequelize.transaction !== 'function') return;
    if (typeof sequelize.getDialect !== 'function' || sequelize.getDialect() !== 'postgres') return;

    await sequelize.transaction(async (transaction) => {
      const existing = await findExistingSnakeCaseTables(sequelize, transaction);
      for (const tableName of SNAKE_CASE_TABLES) {
        if (!existing.has(tableName)) continue;
        if (typeof db.attachLatticeRlsPolicy === 'function') {
          await db.attachLatticeRlsPolicy(tableName, { transaction, orgColumn: 'organization_id' });
        } else {
          await attachRlsPolicyToTable(db, tableName, { transaction, orgColumn: 'organization_id' });
        }
      }
    });
  }

  async down() {
    const db = this.context?.db;
    const sequelize = db?.sequelize;
    if (!sequelize || typeof sequelize.transaction !== 'function') return;
    if (typeof sequelize.getDialect !== 'function' || sequelize.getDialect() !== 'postgres') return;

    await sequelize.transaction(async (transaction) => {
      const existing = await findExistingSnakeCaseTables(sequelize, transaction);
      for (const tableName of [...SNAKE_CASE_TABLES].reverse()) {
        if (!existing.has(tableName)) continue;
        await detachRlsPolicyFromTable(db, tableName, { transaction, orgColumn: 'organization_id' });
      }
    });
  }
}

module.exports = SnakeCaseRlsAttachmentsUploadsMigration;
module.exports.default = SnakeCaseRlsAttachmentsUploadsMigration;
