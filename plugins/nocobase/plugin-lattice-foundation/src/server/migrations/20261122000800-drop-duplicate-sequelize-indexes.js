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

const DUPLICATE_AUTO_INDEXES = [
  'lattice_agent_proposals_organization_id_state_created_at',
  'lattice_agent_proposals_organization_id_target_collection_targe',
  'lattice_ai_audit_logs_actor_user_id_created_at',
  'lattice_ai_audit_logs_ai_employee_status_created_at',
  'lattice_ai_audit_logs_organization_id_created_at',
  'lattice_ai_audit_logs_tool_name_created_at',
  'lattice_ai_profiles_organization_id_enabled',
  'lattice_assets_organization_id_active',
  'lattice_assets_organization_id_code',
  'lattice_assets_organization_id_custodian_id',
  'lattice_assets_organization_id_department_id_status',
  'lattice_assets_organization_id_location_id',
  'lattice_context_outbox_entity_id_id',
  'lattice_context_outbox_organization_id_state_created_at',
  'lattice_context_outbox_state_next_attempt_at_id',
  'lattice_departments_organization_id_active',
  'lattice_departments_organization_id_code',
  'lattice_departments_organization_id_name',
  'lattice_employees_organization_id_active',
  'lattice_employees_organization_id_code',
  'lattice_employees_organization_id_department_id_active',
  'lattice_incident_cases_organization_id_asset_entity_id_status',
  'lattice_incident_cases_organization_id_asset_id',
  'lattice_incident_cases_organization_id_code',
  'lattice_incident_cases_organization_id_handler_id',
  'lattice_incident_cases_organization_id_run_id',
  'lattice_incident_cases_organization_id_status_severity',
  'lattice_incident_rules_organization_id_asset_entity_id_active',
  'lattice_incident_rules_organization_id_asset_id',
  'lattice_incident_rules_organization_id_code',
  'lattice_incident_rules_organization_id_handler_id',
  'lattice_integration_inbox_organization_id_kind_observed_at',
  'lattice_integration_inbox_organization_id_observed_at',
  'lattice_locations_organization_id_code',
  'lattice_locations_organization_id_department_id_active',
  'lattice_locations_organization_id_kind',
  'lattice_orders_organization_id_assignee_id_status',
  'lattice_orders_organization_id_code',
  'lattice_orders_organization_id_department_id',
  'lattice_orders_organization_id_requester_id_status',
  'lattice_orders_organization_id_status_created_at',
  'lattice_para_documents_organization_id_code',
  'lattice_para_documents_organization_id_department_id',
  'lattice_para_documents_organization_id_owner_id_active',
  'lattice_para_documents_organization_id_para_space_status',
  'lattice_requests_organization_id_assignee_id_status',
  'lattice_requests_organization_id_code',
  'lattice_requests_organization_id_department_id',
  'lattice_requests_organization_id_requester_id_status',
  'lattice_requests_organization_id_status_created_at',
  'lattice_service_tickets_organization_id_assignee_id',
  'lattice_service_tickets_organization_id_code',
  'lattice_service_tickets_organization_id_department_id',
  'lattice_service_tickets_organization_id_requester_id_status',
  'lattice_service_tickets_organization_id_status_priority',
  'lattice_ui_snapshots_grid_uid_created_at',
  'lattice_ui_snapshots_portal_slug_page_title_created_at',
];

class DropDuplicateSequelizeIndexes extends Migration {
  on = 'afterSync';

  async up() {
    const { sequelize } = this.context.db;
    await sequelize.transaction(async (transaction) => {
      for (const indexName of DUPLICATE_AUTO_INDEXES) {
        await sequelize.query(`DROP INDEX IF EXISTS "${indexName}";`, { transaction });
      }
    });
  }

  async down() {
    // No-op: canonical explicit idx_lattice_* and uidx_lattice_* indexes remain intact.
  }
}

module.exports = DropDuplicateSequelizeIndexes;
module.exports.default = DropDuplicateSequelizeIndexes;
