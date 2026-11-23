/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseAiMcpAcceptanceArgs,
  runDxosAiAndMcpAcceptance,
} from '../acceptance-dxos-ai-and-mcp.mjs';

test('parseAiMcpAcceptanceArgs rejects unsafe origins and parses valid origin', () => {
  assert.throws(() => parseAiMcpAcceptanceArgs([]), /Usage:/);
  assert.throws(() => parseAiMcpAcceptanceArgs(['--origin=http://localhost:13000']), /Unsafe/i);
  const res = parseAiMcpAcceptanceArgs(['--origin=http://localhost:13014']);
  assert.equal(res.origin, 'http://localhost:13014');
});

test('runDxosAiAndMcpAcceptance verifies 2-way MCP, 6-plane topology, custom AI lifecycle, RBAC negative checks, and cleanup', async () => {
  let savedUsername = null;
  let deletedCustom = false;

  const callActor = async (role, path, opts = {}) => {
    const clean = path.split('?')[0];
    if (clean === 'dxosAi:enterpriseTopology') {
      if (role !== 'root') return { ok: false, status: 403, data: { errors: [{ code: 'DXOS_ADMIN_REQUIRED' }] } };
      return { ok: true, status: 200, data: { planes: new Array(6).fill({}).map((_, i) => ({ order: i + 1 })), clause52Preserved: true } };
    }
    if (clean === 'dxosAi:saveProfile') {
      savedUsername = opts.values?.username || null;
      return { ok: true, status: 200, data: { profile: opts.values, sync: { synced: true } } };
    }
    if (clean === 'dxosAi:deleteProfile') {
      deletedCustom = true;
      return { ok: true, status: 200, data: { deleted: true } };
    }
    if (clean === 'dxosAi:portalCopilot') {
      const employees = [{ username: 'dxos-workspace' }];
      if (savedUsername && !deletedCustom) employees.push({ username: savedUsername });
      return { ok: true, status: 200, data: { employees } };
    }
    if (clean === 'dxosAi:auditLogs') {
      return { ok: true, status: 200, data: { items: [{ id: 1, toolName: 'dxos_inspect_architecture', status: 'allowed' }] } };
    }
    return { ok: false, status: 404, data: {} };
  };

  const rpcRequest = async (role, endpoint, rpcBody) => {
    if (role === 'anon') return { status: 401, json: { error: { code: -32001 } } };
    if (endpoint === '/api/dxos-mcp') {
      if (rpcBody.method === 'initialize') return { status: 200, json: { result: { protocolVersion: '2025-03-26' } } };
      if (rpcBody.method === 'tools/list') {
        const tools = role === 'root'
          ? [
            { name: 'dxos_inspect_architecture' },
            { name: 'dxos_recommend_page_blueprint' },
            { name: 'dxos_design_creative_block' },
            { name: 'dxos_compose_page_blocks' },
            { name: 'dxos_snapshot_or_rollback_page' },
            { name: 'dxos_provision_role_workspace' },
            { name: 'dxos_manage_portal_and_acl' },
            { name: 'dxos_extend_collection_schema' },
            { name: 'dxos_manage_rbac_permissions' },
            { name: 'dxos_deploy_workflow' },
            { name: 'dxos_configure_workflow' },
            { name: 'dxos_search_enterprise_context' },
            { name: 'dxos_execute_record_action' },
            { name: 'dxos_my_tasks_copilot' },
            { name: 'dxos_orchestrate_enterprise_case' },
            { name: 'dxos_graph_impact_analysis' },
            { name: 'dxos_alarm_action' },
          ]
          : [
            { name: 'dxos_search_enterprise_context' },
            { name: 'dxos_execute_record_action' },
            { name: 'dxos_my_tasks_copilot' },
            { name: 'dxos_orchestrate_enterprise_case' },
            { name: 'dxos_graph_impact_analysis' },
            { name: 'dxos_alarm_action' },
          ];
        return { status: 200, json: { result: { tools } } };
      }
      if (rpcBody.method === 'tools/call') {
        if (role !== 'root' && rpcBody.params?.name === 'dxos_compose_page_blocks') {
          return { status: 200, json: { error: { code: -32003, message: 'Forbidden' } } };
        }
        if ((rpcBody.params?.name === 'dxos_manage_rbac_permissions' || rpcBody.params?.name === 'dxos_provision_role_workspace') && rpcBody.params?.arguments?.roleName === 'root') {
          return { status: 200, json: { error: { code: -32003, message: 'Forbidden role target' } } };
        }
        return {
          status: 200,
          json: { result: { isError: false, content: [{ type: 'text', text: JSON.stringify({ dryRun: true, planes: 6, activeWorkflows: [{ id: 1 }] }) }] } },
        };
      }
      if (rpcBody.method === 'resources/read') {
        return {
          status: 200,
          json: { result: { contents: [{ text: JSON.stringify({ planes: new Array(6).fill({ order: 1 }), clause52Preserved: true }) }] } },
        };
      }
      if (rpcBody.method === 'prompts/list') {
        const prompts = [
          { name: 'dxos-cold-chain-incident-triage', arguments: [{ name: 'assetCode', required: true }] },
          { name: 'dxos-fefo-dispatch-audit', arguments: [{ name: 'lotCode', required: true }] },
          { name: 'dxos-executive-radar-brief', arguments: [] },
        ];
        if (role === 'root') {
          prompts.push({ name: 'dxos-system-blueprint-architect', arguments: [{ name: 'goal', required: true }] });
        }
        return { status: 200, json: { result: { prompts } } };
      }
      if (rpcBody.method === 'prompts/get') {
        const name = rpcBody.params?.name;
        if (name === 'dxos-system-blueprint-architect' && role !== 'root') {
          return { status: 200, json: { error: { code: -32003, message: 'Forbidden prompt' } } };
        }
        const assetCode = rpcBody.params?.arguments?.assetCode || 'UNKNOWN';
        return {
          status: 200,
          json: {
            result: {
              description: 'Cold-chain incident triage prompt',
              messages: [{ role: 'user', content: { type: 'text', text: `Triage asset ${assetCode} using dxos_graph_impact_analysis` } }],
            },
          },
        };
      }
      if (rpcBody.method === 'resources/templates/list') {
        const resourceTemplates = [
          { uriTemplate: 'dxos://org/{organizationId}/lineage/{collection}/{recordId}', mimeType: 'application/json' },
          { uriTemplate: 'dxos://org/{organizationId}/alarms/active', mimeType: 'application/json' },
        ];
        if (role === 'root') {
          resourceTemplates.push({ uriTemplate: 'dxos://topology/planes', mimeType: 'application/json' });
        }
        return { status: 200, json: { result: { resourceTemplates } } };
      }
    }
    if (endpoint === '/api/dxos-mcp/it-ot') {
      if (rpcBody.method === 'tools/list') {
        return {
          status: 200,
          json: {
            result: {
              tools: [
                { name: 'get_live_ngsi_telemetry' },
                { name: 'get_sensor_and_incident_timeline' },
                { name: 'get_stack_connector_health' },
                { name: 'dispatch_itot_webhook_or_sync' },
              ],
            },
          },
        };
      }
      if (rpcBody.method === 'tools/call') {
        return {
          status: 200,
          json: { result: { isError: false, content: [{ type: 'text', text: JSON.stringify({ connectors: { database: { reachable: true } } }) }] } },
        };
      }
    }
    return { status: 404, json: {} };
  };

  const report = await runDxosAiAndMcpAcceptance({ callActor, rpcRequest });
  assert.equal(report.result, 'PASS');
  assert.equal(report.checks.unauthenticatedMcp401, true);
  assert.equal(report.checks.employeeBuilderToolsHidden, true);
  assert.equal(report.checks.employeeBuilderCallDenied, true);
  assert.equal(report.checks.adminMcpToolsListed15, true);
  assert.equal(report.checks.adminMcpToolsListed17, true);
  assert.equal(report.checks.mcpPromptsListAndAdminHiddenOk, true);
  assert.equal(report.checks.mcpPromptsGetOk, true);
  assert.equal(report.checks.mcpResourceTemplatesListOk, true);
  assert.equal(report.checks.adminCreativeBlockDryRunOk, true);
  assert.equal(report.checks.adminProvisionRoleWorkspaceDryRunOk, true);
  assert.equal(report.checks.adminMcpDryRunCompose, true);
  assert.equal(report.checks.itOtMcpHealthOk, true);
  assert.equal(report.checks.customAiLifecycleCleanedUp, true);
  assert.equal(deletedCustom, true);
});
