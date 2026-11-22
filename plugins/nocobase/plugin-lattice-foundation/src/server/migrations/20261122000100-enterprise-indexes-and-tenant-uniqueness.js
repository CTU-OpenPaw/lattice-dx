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

const TENANT_CODE_TABLES = [
  'latticeRequests',
  'latticeOrders',
  'latticeDepartments',
  'latticeEmployees',
  'latticeLocations',
  'latticeAssets',
  'latticeIncidentRules',
  'latticeIncidentCases',
];

const COMPOSITE_INDEXES = [
  ['uidx_lattice_requests_org_code', 'latticeRequests', ['organizationId', 'code'], true],
  ['idx_lattice_requests_org_status_created', 'latticeRequests', ['organizationId', 'status', 'createdAt'], false],
  ['idx_lattice_requests_org_requester_status', 'latticeRequests', ['organizationId', 'requesterId', 'status'], false],
  ['idx_lattice_requests_org_assignee_status', 'latticeRequests', ['organizationId', 'assigneeId', 'status'], false],
  ['idx_lattice_requests_org_department', 'latticeRequests', ['organizationId', 'departmentId'], false],

  ['uidx_lattice_orders_org_code', 'latticeOrders', ['organizationId', 'code'], true],
  ['idx_lattice_orders_org_status_created', 'latticeOrders', ['organizationId', 'status', 'createdAt'], false],
  ['idx_lattice_orders_org_requester_status', 'latticeOrders', ['organizationId', 'requesterId', 'status'], false],
  ['idx_lattice_orders_org_assignee_status', 'latticeOrders', ['organizationId', 'assigneeId', 'status'], false],
  ['idx_lattice_orders_org_department', 'latticeOrders', ['organizationId', 'departmentId'], false],

  ['uidx_lattice_departments_org_code', 'latticeDepartments', ['organizationId', 'code'], true],
  ['idx_lattice_departments_org_active', 'latticeDepartments', ['organizationId', 'active'], false],
  ['idx_lattice_departments_org_name', 'latticeDepartments', ['organizationId', 'name'], false],

  ['uidx_lattice_employees_org_code', 'latticeEmployees', ['organizationId', 'code'], true],
  ['idx_lattice_employees_org_active', 'latticeEmployees', ['organizationId', 'active'], false],
  ['idx_lattice_employees_org_dept_active', 'latticeEmployees', ['organizationId', 'departmentId', 'active'], false],
  ['idx_lattice_employees_user_id', 'latticeEmployees', ['userId'], false],

  ['uidx_lattice_locations_org_code', 'latticeLocations', ['organizationId', 'code'], true],
  ['idx_lattice_locations_org_dept_active', 'latticeLocations', ['organizationId', 'departmentId', 'active'], false],
  ['idx_lattice_locations_org_kind', 'latticeLocations', ['organizationId', 'kind'], false],

  ['uidx_lattice_assets_org_code', 'latticeAssets', ['organizationId', 'code'], true],
  ['idx_lattice_assets_org_dept_status', 'latticeAssets', ['organizationId', 'departmentId', 'status'], false],
  ['idx_lattice_assets_org_location', 'latticeAssets', ['organizationId', 'locationId'], false],
  ['idx_lattice_assets_org_custodian', 'latticeAssets', ['organizationId', 'custodianId'], false],
  ['idx_lattice_assets_org_active', 'latticeAssets', ['organizationId', 'active'], false],

  ['uidx_lattice_incident_rules_org_code', 'latticeIncidentRules', ['organizationId', 'code'], true],
  ['idx_lattice_incident_rules_org_asset_active', 'latticeIncidentRules', ['organizationId', 'assetEntityId', 'active'], false],
  ['idx_lattice_incident_rules_org_asset_id', 'latticeIncidentRules', ['organizationId', 'assetId'], false],
  ['idx_lattice_incident_rules_org_handler', 'latticeIncidentRules', ['organizationId', 'handlerId'], false],

  ['uidx_lattice_incident_cases_org_code', 'latticeIncidentCases', ['organizationId', 'code'], true],
  ['idx_lattice_incident_cases_org_status_sev', 'latticeIncidentCases', ['organizationId', 'status', 'severity'], false],
  ['idx_lattice_incident_cases_org_asset_status', 'latticeIncidentCases', ['organizationId', 'assetEntityId', 'status'], false],
  ['idx_lattice_incident_cases_org_run', 'latticeIncidentCases', ['organizationId', 'runId'], false],
  ['idx_lattice_incident_cases_org_handler', 'latticeIncidentCases', ['organizationId', 'handlerId'], false],
  ['idx_lattice_incident_cases_org_asset_id', 'latticeIncidentCases', ['organizationId', 'assetId'], false],

  ['idx_lattice_inbox_org_observed', 'latticeIntegrationInbox', ['organizationId', 'observedAt'], false],
  ['idx_lattice_inbox_org_kind_observed', 'latticeIntegrationInbox', ['organizationId', 'kind', 'observedAt'], false],

  ['idx_lattice_proposals_org_state_created', 'latticeAgentProposals', ['organizationId', 'state', 'createdAt'], false],
  ['idx_lattice_proposals_org_target', 'latticeAgentProposals', ['organizationId', 'targetCollection', 'targetRecordId'], false],

  ['idx_lattice_outbox_entity_id', 'latticeContextOutbox', ['entityId', 'id'], false],
  ['idx_lattice_outbox_state_next_id', 'latticeContextOutbox', ['state', 'nextAttemptAt', 'id'], false],
  ['idx_lattice_outbox_org_state_created', 'latticeContextOutbox', ['organizationId', 'state', 'createdAt'], false],
];

class EnterpriseIndexesAndTenantUniqueness extends Migration {
  on = 'afterSync';

  async up() {
    const { sequelize } = this.context.db;
    await sequelize.transaction(async (transaction) => {
      for (const table of TENANT_CODE_TABLES) {
        const constraint = `${table}_code_key`;
        await sequelize.query(`ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${constraint}";`, { transaction });
        await sequelize.query(`DROP INDEX IF EXISTS "${constraint}";`, { transaction });
      }
      await sequelize.query(
        'ALTER TABLE "latticeAssets" ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;',
        { transaction },
      );
      await sequelize.query(
        'ALTER TABLE "latticeContextOutbox" ADD COLUMN IF NOT EXISTS "lockedAt" timestamptz;',
        { transaction },
      );
      await sequelize.query(
        `DO $$
        BEGIN
          IF to_regclass('lattice_native_request_uploads') IS NOT NULL THEN
            ALTER TABLE lattice_native_request_uploads ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
            CREATE INDEX IF NOT EXISTS idx_lattice_uploads_state_created
              ON lattice_native_request_uploads (state, created_at);
          END IF;
        END $$;`,
        { transaction },
      );
      for (const [indexName, table, cols, unique] of COMPOSITE_INDEXES) {
        const colSql = cols.map((c) => `"${c}"`).join(', ');
        const uniqueSql = unique ? 'UNIQUE ' : '';
        await sequelize.query(
          `CREATE ${uniqueSql}INDEX IF NOT EXISTS "${indexName}" ON "${table}" (${colSql});`,
          { transaction },
        );
      }
    });
  }

  async down() {
    const { sequelize } = this.context.db;
    await sequelize.transaction(async (transaction) => {
      for (const [indexName] of [...COMPOSITE_INDEXES].reverse()) {
        await sequelize.query(`DROP INDEX IF EXISTS "${indexName}";`, { transaction });
      }
      await sequelize.query('DROP INDEX IF EXISTS idx_lattice_uploads_state_created;', { transaction });
      await sequelize.query(
        `DO $$
        BEGIN
          IF to_regclass('lattice_native_request_uploads') IS NOT NULL THEN
            ALTER TABLE lattice_native_request_uploads DROP COLUMN IF EXISTS updated_at;
          END IF;
        END $$;`,
        { transaction },
      );
      await sequelize.query('ALTER TABLE "latticeContextOutbox" DROP COLUMN IF EXISTS "lockedAt";', { transaction });
      await sequelize.query('ALTER TABLE "latticeAssets" DROP COLUMN IF EXISTS version;', { transaction });
      for (const table of TENANT_CODE_TABLES) {
        const constraint = `${table}_code_key`;
        await sequelize.query(
          `DO $$
          BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"${table}"'::regclass AND conname = '${constraint}') THEN
              ALTER TABLE "${table}" ADD CONSTRAINT "${constraint}" UNIQUE (code);
            END IF;
          EXCEPTION WHEN unique_violation THEN
            NULL;
          END $$;`,
          { transaction },
        );
      }
    });
  }
}

module.exports = EnterpriseIndexesAndTenantUniqueness;
module.exports.default = EnterpriseIndexesAndTenantUniqueness;
