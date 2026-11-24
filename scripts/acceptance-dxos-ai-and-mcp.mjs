/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSafeLabOrigin } from './setup-native-multi-portal-demo.mjs';

const DEMO_PASS = process.env.NATIVE_DEMO_PASSWORD ?? 'NativeLab-2026!';
const ADMIN_TOOLS = [
  'dxos_inspect_architecture',
  'dxos_recommend_page_blueprint',
  'dxos_design_creative_block',
  'dxos_compose_page_blocks',
  'dxos_snapshot_or_rollback_page',
  'dxos_provision_role_workspace',
  'dxos_manage_portal_and_acl',
  'dxos_extend_collection_schema',
  'dxos_manage_rbac_permissions',
  'dxos_deploy_workflow',
  'dxos_configure_workflow',
];
const OPERATIONAL_TOOLS = [
  'dxos_search_enterprise_context',
  'dxos_execute_record_action',
  'dxos_my_workflow_tasks',
  'dxos_orchestrate_enterprise_case',
  'dxos_graph_impact_analysis',
  'dxos_alarm_action',
];

export function parseAiMcpAcceptanceArgs(argv) {
  let reportPath = null;
  let origin = null;
  for (const arg of argv) {
    if (arg.startsWith('--origin=')) origin = arg.slice('--origin='.length);
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else if (reportPath === null) reportPath = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (!reportPath && !origin) {
    throw new Error('Usage: node scripts/acceptance-dxos-ai-and-mcp.mjs <clean-install report.json> | --origin=http://localhost:13014');
  }
  if (origin !== null) origin = assertSafeLabOrigin(origin);
  return { reportPath, origin };
}

export async function runDxosAiAndMcpAcceptance({ callActor, rpcRequest }) {
  const suffix = Date.now().toString(36).slice(-5);
  const customUsername = `dxos-e2e-custom-${suffix}`;
  const checks = {
    unauthenticatedMcp401: false,
    employeeBuilderToolsHidden: false,
    employeeBuilderCallDenied: false,
    employeeTopology403: false,
    employeePortalAgentsScoped: false,
    adminMcpInitialize: false,
    adminMcpToolsListed15: false,
    adminMcpToolsListed17: false,
    mcpPromptsListAndAdminHiddenOk: false,
    mcpPromptsGetOk: false,
    mcpResourceTemplatesListOk: false,
    adminMcpInspectOk: false,
    adminMcpDryRunCompose: false,
    adminMcpRbacInspectAndRootBlocked: false,
    adminMcpWorkflowInspectOk: false,
    adminRecommendBlueprintOk: false,
    adminCreativeBlockDryRunOk: false,
    adminSnapshotListOk: false,
    adminProvisionRoleWorkspaceDryRunOk: false,
    employeeCrossDeptRadarOk: false,
    adminMcpTopologyResource6Planes: false,
    itOtMcp4Tools: false,
    itOtMcpHealthOk: false,
    itOtMcpTelemetrySafe: false,
    customAiCreatedAndVisible: false,
    customAiLifecycleCleanedUp: false,
    auditLogsRecorded: false,
  };

  try {
    // 1. Unauthenticated MCP blocked with 401
    const unauth = await rpcRequest('anon', '/api/dxos-mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    assert.equal(unauth.status, 401, `Expected 401 on unauthenticated /api/dxos-mcp, got ${unauth.status}`);
    checks.unauthenticatedMcp401 = true;

    // 2. Non-admin employee sees operational tools ONLY and cannot invoke Admin Builder or Admin Studio endpoints
    const empTools = await rpcRequest('employee', '/api/dxos-mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    assert.equal(empTools.status, 200);
    const empToolNames = (empTools.json?.result?.tools || []).map((t) => t.name);
    for (const adminTool of ADMIN_TOOLS) {
      assert.ok(!empToolNames.includes(adminTool), `Non-admin tools/list leaked ${adminTool}`);
    }
    for (const opTool of OPERATIONAL_TOOLS) {
      assert.ok(empToolNames.includes(opTool), `Non-admin tools/list missing operational tool ${opTool}`);
    }
    checks.employeeBuilderToolsHidden = true;

    const empBlockedCall = await rpcRequest('employee', '/api/dxos-mcp', {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'dxos_compose_page_blocks', arguments: { portalSlug: 'services', dryRun: true } },
    });
    assert.ok(empBlockedCall.json?.error?.code === -32003, `Expected JSON-RPC -32003 for employee builder call, got ${JSON.stringify(empBlockedCall.json)}`);
    checks.employeeBuilderCallDenied = true;

    const empTopo = await callActor('employee', 'dxosAi:enterpriseTopology');
    assert.ok(!empTopo.ok && empTopo.status === 403, `Expected 403 on dxosAi:enterpriseTopology for employee, got ${empTopo.status}`);
    checks.employeeTopology403 = true;

    const empAgents = await callActor('employee', 'dxosAi:portalAgents?portalSlug=services');
    assert.ok(empAgents.ok && empAgents.status < 300);
    const visibleBefore = (empAgents.data?.employees || []).map((e) => e.username);
    assert.ok(!visibleBefore.includes('dxos-architect'), 'dxos-architect leaked into non-admin portalAgents');
    checks.employeePortalAgentsScoped = true;

    // 3. Admin MCP initialize, tools/list, tools/call, resources/read (6 planes)
    const initRes = await rpcRequest('root', '/api/dxos-mcp', {
      jsonrpc: '2.0',
      id: 4,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', clientInfo: { name: 'dxos-acceptance', version: '0.1.0' } },
    });
    assert.equal(initRes.status, 200);
    assert.ok(initRes.json?.result?.protocolVersion);
    checks.adminMcpInitialize = true;

    const adminTools = await rpcRequest('root', '/api/dxos-mcp', { jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} });
    const adminToolNames = (adminTools.json?.result?.tools || []).map((t) => t.name);
    for (const tool of [...ADMIN_TOOLS, ...OPERATIONAL_TOOLS]) {
      assert.ok(adminToolNames.includes(tool), `Admin MCP missing tool ${tool}`);
    }
    assert.ok(adminToolNames.length >= 17, `Expected >= 17 admin+operational MCP tools, got ${adminToolNames.length}`);
    checks.adminMcpToolsListed15 = true;
    checks.adminMcpToolsListed17 = true;

    const inspectCall = await rpcRequest('root', '/api/dxos-mcp', {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'dxos_inspect_architecture', arguments: {} },
    });
    assert.equal(inspectCall.json?.result?.isError, false);
    const inspectedJson = JSON.parse(inspectCall.json?.result?.content?.[0]?.text || '{}');
    checks.adminMcpInspectOk = true;

    const dryRunCall = await rpcRequest('root', '/api/dxos-mcp', {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: 'dxos_compose_page_blocks',
        arguments: { portalSlug: 'services', blockUse: 'DxosAiProposalBlockModel', title: 'Đề xuất AI Dịch vụ E2E', dryRun: true },
      },
    });
    assert.equal(dryRunCall.json?.result?.isError, false);
    const dryRunParsed = JSON.parse(dryRunCall.json?.result?.content?.[0]?.text || '{}');
    assert.equal(dryRunParsed.dryRun, true);
    checks.adminMcpDryRunCompose = true;

    const rbacInspect = await rpcRequest('root', '/api/dxos-mcp', {
      jsonrpc: '2.0',
      id: 17,
      method: 'tools/call',
      params: { name: 'dxos_manage_rbac_permissions', arguments: { operation: 'inspectRole', roleName: 'ldx_employee' } },
    });
    assert.equal(rbacInspect.json?.result?.isError, false);
    const rbacRootDeny = await rpcRequest('root', '/api/dxos-mcp', {
      jsonrpc: '2.0',
      id: 18,
      method: 'tools/call',
      params: { name: 'dxos_manage_rbac_permissions', arguments: { operation: 'grantResource', roleName: 'root', collectionName: 'latticeOrders', actions: ['view'] } },
    });
    assert.equal(rbacRootDeny.json?.error?.code, -32003);
    checks.adminMcpRbacInspectAndRootBlocked = true;

    const firstWfId = inspectedJson.activeWorkflows?.[0]?.id;
    const wfInspect = await rpcRequest('root', '/api/dxos-mcp', {
      jsonrpc: '2.0',
      id: 19,
      method: 'tools/call',
      params: {
        name: 'dxos_configure_workflow',
        arguments: firstWfId ? { operation: 'inspectWorkflow', workflowId: firstWfId } : { operation: 'inspectWorkflow', titleQuery: 'Logistics' },
      },
    });
    assert.equal(wfInspect.json?.result?.isError, false);
    checks.adminMcpWorkflowInspectOk = true;

    const recBlueprintCall = await rpcRequest('root', '/api/dxos-mcp', {
      jsonrpc: '2.0',
      id: 21,
      method: 'tools/call',
      params: { name: 'dxos_recommend_page_blueprint', arguments: { collectionName: 'latticeOrders', portalSlug: 'logistics', targetRole: 'ldx_manager' } },
    });
    assert.equal(recBlueprintCall.json?.result?.isError, false);
    checks.adminRecommendBlueprintOk = true;

    const creativeDryCall = await rpcRequest('root', '/api/dxos-mcp', {
      jsonrpc: '2.0',
      id: 22,
      method: 'tools/call',
      params: {
        name: 'dxos_design_creative_block',
        arguments: { portalSlug: 'services', dryRun: true, blueprint: { title: 'Test Creative', theme: 'industrial-cockpit', widgets: [] } },
      },
    });
    assert.equal(creativeDryCall.json?.result?.isError, false);
    const creativeDryJson = JSON.parse(creativeDryCall.json?.result?.content?.[0]?.text || '{}');
    assert.equal(creativeDryJson.dryRun, true);
    checks.adminCreativeBlockDryRunOk = true;

    const snapListCall = await rpcRequest('root', '/api/dxos-mcp', {
      jsonrpc: '2.0',
      id: 23,
      method: 'tools/call',
      params: { name: 'dxos_snapshot_or_rollback_page', arguments: { action: 'listSnapshots', portalSlug: 'services' } },
    });
    assert.equal(snapListCall.json?.result?.isError, false);
    checks.adminSnapshotListOk = true;

    const provDryCall = await rpcRequest('root', '/api/dxos-mcp', {
      jsonrpc: '2.0',
      id: 24,
      method: 'tools/call',
      params: {
        name: 'dxos_provision_role_workspace',
        arguments: { roleName: 'ldx_qa_e2e', portalSlug: 'services', pageTitle: 'E2E QA', collectionName: 'latticeServiceTickets', dryRun: true },
      },
    });
    assert.equal(provDryCall.json?.result?.isError, false);
    const provDryJson = JSON.parse(provDryCall.json?.result?.content?.[0]?.text || '{}');
    assert.equal(provDryJson.dryRun, true);
    const provRootDeny = await rpcRequest('root', '/api/dxos-mcp', {
      jsonrpc: '2.0',
      id: 25,
      method: 'tools/call',
      params: { name: 'dxos_provision_role_workspace', arguments: { roleName: 'root', portalSlug: 'services', pageTitle: 'Illegal', collectionName: 'latticeServiceTickets' } },
    });
    assert.equal(provRootDeny.json?.error?.code, -32003);
    checks.adminProvisionRoleWorkspaceDryRunOk = true;

    const empRadar = await rpcRequest('employee', '/api/dxos-mcp', {
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: { name: 'dxos_orchestrate_enterprise_case', arguments: { mode: 'radar' } },
    });
    assert.equal(empRadar.json?.result?.isError, false);
    checks.employeeCrossDeptRadarOk = true;

    const topoRes = await rpcRequest('root', '/api/dxos-mcp', {
      jsonrpc: '2.0',
      id: 8,
      method: 'resources/read',
      params: { uri: 'dxos://topology/planes' },
    });
    const topoJson = JSON.parse(topoRes.json?.result?.contents?.[0]?.text || '{}');
    assert.equal(topoJson.planes?.length, 6);
    assert.equal(topoJson.clause52Preserved, true);
    checks.adminMcpTopologyResource6Planes = true;

    // 3b. MCP prompts/list, prompts/get, and resources/templates/list (with admin scoping)
    const empPrompts = await rpcRequest('employee', '/api/dxos-mcp', { jsonrpc: '2.0', id: 26, method: 'prompts/list', params: {} });
    assert.equal(empPrompts.status, 200);
    const empPromptNames = (empPrompts.json?.result?.prompts || []).map((p) => p.name);
    for (const opPrompt of ['dxos-cold-chain-incident-triage', 'dxos-fefo-dispatch-audit', 'dxos-executive-radar-brief']) {
      assert.ok(empPromptNames.includes(opPrompt), `Employee prompts/list missing ${opPrompt}`);
    }
    assert.ok(!empPromptNames.includes('dxos-system-blueprint-architect'), 'Employee prompts/list leaked admin prompt');

    const rootPrompts = await rpcRequest('root', '/api/dxos-mcp', { jsonrpc: '2.0', id: 27, method: 'prompts/list', params: {} });
    assert.equal(rootPrompts.status, 200);
    const rootPromptNames = (rootPrompts.json?.result?.prompts || []).map((p) => p.name);
    assert.ok(rootPromptNames.includes('dxos-system-blueprint-architect'), 'Root prompts/list missing admin architect prompt');
    assert.ok(rootPromptNames.length >= 4, `Expected >= 4 MCP prompts for admin, got ${rootPromptNames.length}`);
    checks.mcpPromptsListAndAdminHiddenOk = true;

    const empAdminPromptDeny = await rpcRequest('employee', '/api/dxos-mcp', {
      jsonrpc: '2.0',
      id: 28,
      method: 'prompts/get',
      params: { name: 'dxos-system-blueprint-architect', arguments: { goal: 'Unauthorized bypass attempt' } },
    });
    assert.equal(empAdminPromptDeny.json?.error?.code, -32003, 'Expected -32003 when employee fetches admin MCP prompt');

    const empTriagePrompt = await rpcRequest('employee', '/api/dxos-mcp', {
      jsonrpc: '2.0',
      id: 29,
      method: 'prompts/get',
      params: { name: 'dxos-cold-chain-incident-triage', arguments: { assetCode: 'COLD-CHILLER-01' } },
    });
    assert.equal(empTriagePrompt.status, 200);
    assert.match(String(empTriagePrompt.json?.result?.messages?.[0]?.content?.text || ''), /COLD-CHILLER-01/);
    checks.mcpPromptsGetOk = true;

    const empTemplates = await rpcRequest('employee', '/api/dxos-mcp', { jsonrpc: '2.0', id: 30, method: 'resources/templates/list', params: {} });
    assert.equal(empTemplates.status, 200);
    const empUris = (empTemplates.json?.result?.resourceTemplates || []).map((t) => t.uriTemplate);
    assert.ok(empUris.includes('dxos://org/{organizationId}/lineage/{collection}/{recordId}'));
    assert.ok(empUris.includes('dxos://org/{organizationId}/alarms/active'));
    assert.ok(!empUris.includes('dxos://topology/planes'), 'Employee resources/templates/list leaked admin topology template');

    const rootTemplates = await rpcRequest('root', '/api/dxos-mcp', { jsonrpc: '2.0', id: 31, method: 'resources/templates/list', params: {} });
    const rootUris = (rootTemplates.json?.result?.resourceTemplates || []).map((t) => t.uriTemplate);
    assert.ok(rootUris.includes('dxos://topology/planes'));
    checks.mcpResourceTemplatesListOk = true;

    // 4. IT/OT Streamable MCP endpoint (/api/dxos-mcp/it-ot)
    const itOtList = await rpcRequest('root', '/api/dxos-mcp/it-ot', { jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} });
    const itOtNames = (itOtList.json?.result?.tools || []).map((t) => t.name);
    assert.ok(itOtNames.includes('get_live_ngsi_telemetry') && itOtNames.includes('get_stack_connector_health'));
    checks.itOtMcp4Tools = itOtNames.length === 4;

    const itOtHealth = await rpcRequest('root', '/api/dxos-mcp/it-ot', {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'get_stack_connector_health', arguments: {} },
    });
    assert.equal(itOtHealth.json?.result?.isError, false);
    const healthJson = JSON.parse(itOtHealth.json?.result?.content?.[0]?.text || '{}');
    assert.equal(healthJson.connectors?.database?.reachable, true);
    checks.itOtMcpHealthOk = true;

    const itOtTelem = await rpcRequest('root', '/api/dxos-mcp/it-ot', {
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'get_live_ngsi_telemetry', arguments: {} },
    });
    assert.equal(itOtTelem.json?.result?.isError, false);
    checks.itOtMcpTelemetrySafe = true;

    // 5. Dynamic Admin-created AI Employee lifecycle & portalAgents propagation
    const saveRes = await callActor('root', 'dxosAi:saveProfile', {
      method: 'POST',
      values: {
        username: customUsername,
        nickname: 'Trợ lý E2E Kiểm chứng Động AI',
        departmentScope: 'services-qa',
        organizationId: 'native-ui-lab',
        allowedRoles: ['ldx_employee', 'ldx_manager'],
        portalBindings: ['services'],
        toolPermissions: { dxos_search_enterprise_context: 'ALLOW', dxos_my_workflow_tasks: 'ALLOW' },
        quickPrompts: [{ label: 'E2E Agent Check', prompt: 'Kiểm tra phiếu dịch vụ đang mở.' }],
      },
    });
    assert.ok(saveRes.ok && saveRes.status < 300, `saveProfile failed: ${JSON.stringify(saveRes.data)}`);

    const empAgentsAfter = await callActor('employee', 'dxosAi:portalAgents?portalSlug=services');
    assert.ok(empAgentsAfter.ok);
    const visibleAfter = (empAgentsAfter.data?.employees || []).map((e) => e.username);
    assert.ok(visibleAfter.includes(customUsername), `Custom AI employee ${customUsername} missing from portalAgents`);
    checks.customAiCreatedAndVisible = true;
  } finally {
    const delRes = await callActor('root', 'dxosAi:deleteProfile', { method: 'POST', values: { username: customUsername } }).catch(() => ({ ok: false }));
    if (delRes?.ok) checks.customAiLifecycleCleanedUp = true;
  }

  const auditRes = await callActor('root', 'dxosAi:auditLogs?pageSize=20');
  assert.ok(auditRes.ok && Array.isArray(auditRes.data?.items) && auditRes.data.items.length >= 1, 'Expected >= 1 entry in latticeAiAuditLogs');
  checks.auditLogsRecorded = true;

  return {
    result: Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL',
    checks,
    customUsername,
  };
}

export async function createAiMcpClients(origin) {
  const safeOrigin = assertSafeLabOrigin(origin);
  const signIn = async (email, password) => {
    const res = await fetch(new URL('/api/auth:signIn', safeOrigin), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(15000),
    });
    const json = await res.json();
    assert.ok(res.ok && json?.data?.token, `Sign-in failed for ${email}: HTTP ${res.status}`);
    return json.data.token;
  };

  const tokens = {
    root: await signIn(process.env.NOCOBASE_ADMIN_EMAIL ?? 'admin@nocobase.com', process.env.NOCOBASE_ADMIN_PASSWORD ?? 'admin123'),
    employee: await signIn('native.lab.employee@example.invalid', DEMO_PASS),
  };

  const callActor = async (role, path, { method = 'GET', values } = {}) => {
    const res = await fetch(new URL(`/api/${path}`, safeOrigin), {
      method,
      headers: {
        ...(tokens[role] ? { Authorization: `Bearer ${tokens[role]}` } : {}),
        ...(values !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(values !== undefined ? { body: JSON.stringify(values) } : {}),
      signal: AbortSignal.timeout(15000),
    });
    const raw = await res.text();
    let parsed = {};
    try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = { raw }; }
    return {
      ok: res.ok,
      status: res.status,
      data: parsed.data !== undefined ? parsed.data : parsed,
    };
  };

  const rpcRequest = async (role, endpoint, rpcBody) => {
    const res = await fetch(new URL(endpoint, safeOrigin), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(tokens[role] ? { Authorization: `Bearer ${tokens[role]}` } : {}),
      },
      body: JSON.stringify(rpcBody),
      signal: AbortSignal.timeout(15000),
    });
    const raw = await res.text();
    let json = {};
    try { json = raw ? JSON.parse(raw) : {}; } catch { json = { raw }; }
    return { status: res.status, json };
  };

  return { callActor, rpcRequest };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseAiMcpAcceptanceArgs(process.argv.slice(2));
  (async () => {
    let targetOrigin = args.origin;
    if (args.reportPath) {
      const report = JSON.parse(await readFile(resolve(args.reportPath), 'utf8'));
      targetOrigin = assertSafeLabOrigin(report.origin);
    }
    const clients = await createAiMcpClients(targetOrigin);
    const result = await runDxosAiAndMcpAcceptance(clients);
    console.log(JSON.stringify({ origin: targetOrigin, ...result }));
    if (result.result !== 'PASS') process.exitCode = 1;
  })().catch((err) => {
    console.error(JSON.stringify({ result: 'FAIL', error: err.message }));
    process.exitCode = 1;
  });
}
