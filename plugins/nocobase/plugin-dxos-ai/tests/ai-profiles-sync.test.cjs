/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STARTER_AI_BLUEPRINTS,
  aiProfiles,
  aiAuditLogs,
  validateAiProfilePayload,
  validateMcpServerUrl,
  sanitizeAuditSummary,
  recordAiAuditLog,
} = require('../src/server/ai-schemas');
const {
  enforceProfileRoleLock,
  syncProfileToNocobaseAi,
  installAiRoleGrants,
} = require('../src/server/ai-sync');

const ADMIN_TOOLS = [
  'dxos_inspect_architecture',
  'dxos_compose_page_blocks',
  'dxos_manage_portal_and_acl',
  'dxos_extend_collection_schema',
  'dxos_deploy_workflow',
];

test('collections & starter blueprints cover 5 customizable AI roles without hardcoded secrets', () => {
  assert.equal(aiProfiles.name, 'latticeAiProfiles');
  assert.equal(aiProfiles.uiManageable, true);
  assert.equal(aiAuditLogs.name, 'latticeAiAuditLogs');
  assert.equal(aiAuditLogs.uiManageable, false);

  const usernames = STARTER_AI_BLUEPRINTS.map((b) => b.username);
  assert.deepEqual(usernames, ['dxos-coordinator', 'dxos-architect', 'dxos-ops', 'dxos-logistics', 'dxos-workspace']);
  const architect = STARTER_AI_BLUEPRINTS.find((b) => b.username === 'dxos-architect');
  assert.equal(architect.isAdminBuilder, true);
  assert.deepEqual(architect.allowedRoles, ['root', 'admin']);
  assert.equal(JSON.stringify(STARTER_AI_BLUEPRINTS).includes('sk-'), false);
});

test('validateMcpServerUrl enforces SSRF & credential guardrails', () => {
  assert.equal(validateMcpServerUrl('http://127.0.0.1:13014/api/dxos-mcp/it-ot'), 'http://127.0.0.1:13014/api/dxos-mcp/it-ot');
  assert.equal(validateMcpServerUrl('https://mcp.enterprise.local/v1'), 'https://mcp.enterprise.local/v1');
  assert.throws(() => validateMcpServerUrl('http://169.254.169.254/latest/meta-data'), /SSRF|Unsafe/i);
  assert.throws(() => validateMcpServerUrl('file:///etc/passwd'), /protocol|http/i);
  assert.throws(() => validateMcpServerUrl('https://user:pass@mcp.example.com/sse'), /credential/i);
  assert.throws(() => validateMcpServerUrl('http://public-mcp.example.com/mcp'), /https/i);
});

test('enforceProfileRoleLock strips non-admin roles whenever admin builder tools are granted', () => {
  const normalized = enforceProfileRoleLock({
    username: 'custom-dept-ai',
    isAdminBuilder: false,
    allowedRoles: ['ldx_employee', 'ldx_manager', 'root'],
    toolPermissions: {
      dxos_search_enterprise_context: 'ALLOW',
      dxos_compose_page_blocks: 'ASK',
    },
  }, ADMIN_TOOLS);
  assert.equal(normalized.isAdminBuilder, true);
  assert.deepEqual(normalized.allowedRoles, ['root', 'admin']);

  const validated = validateAiProfilePayload({
    username: 'hr-ops-ai',
    nickname: 'Chuyên viên Nhân sự AI',
    organizationId: 'native-ui-lab',
    allowedRoles: ['ldx_employee', 'ldx_manager'],
    toolPermissions: { dxos_search_enterprise_context: 'ALLOW', dxos_execute_record_action: 'ASK' },
    mcpServers: [{ name: 'it-ot', url: 'http://127.0.0.1:13014/api/dxos-mcp/it-ot', useUserContext: true, enabled: true }],
    portalBindings: ['services'],
    quickPrompts: [{ label: 'Tóm tắt phiếu HR', prompt: 'Tìm các phiếu nhân sự đang mở' }],
  }, { adminToolNames: ADMIN_TOOLS });
  assert.equal(validated.isAdminBuilder, false);
  assert.deepEqual(validated.allowedRoles, ['ldx_employee', 'ldx_manager']);
});

test('sanitizeAuditSummary redacts sensitive keys and syncProfileToNocobaseAi updates aiEmployees, roles, and aiMcpClients', async () => {
  const redacted = sanitizeAuditSummary({ code: 'ORD-1', token: 'secret-jwt', nested: { apiKey: '12345' } });
  assert.equal(redacted.code, 'ORD-1');
  assert.equal(redacted.token, '[REDACTED]');
  assert.equal(redacted.nested.apiKey, '[REDACTED]');

  const empStore = new Map();
  const roleBindings = new Map();
  const mcpStore = new Map();
  const auditRows = [];
  const fakeDb = {
    hasCollection: () => true,
    sequelize: { transaction: async (fn) => fn({}) },
    getRepository(name) {
      if (name === 'aiEmployees') {
        return {
          findOne: async ({ filter }) => empStore.get(filter.username) || null,
          create: async ({ values }) => { const row = { ...values, get: (k) => row[k], update: async (u) => Object.assign(row, u) }; empStore.set(values.username, row); return row; },
        };
      }
      if (name === 'rolesAiEmployees') {
        return {
          find: async ({ filter }) => roleBindings.get(filter.aiEmployee) || [],
          destroy: async ({ filter }) => { roleBindings.delete(filter.aiEmployee); },
          create: async ({ values }) => {
            const list = roleBindings.get(values.aiEmployee) || [];
            list.push(values);
            roleBindings.set(values.aiEmployee, list);
          },
        };
      }
      if (name === 'aiMcpClients') {
        return {
          findOne: async ({ filter }) => mcpStore.get(filter.name) || null,
          create: async ({ values }) => { const row = { ...values, update: async (u) => Object.assign(row, u) }; mcpStore.set(values.name, row); return row; },
        };
      }
      if (name === 'latticeAiAuditLogs') {
        return { create: async ({ values }) => { auditRows.push(values); return values; } };
      }
      if (name === 'roles') {
        return { findOne: async ({ filter }) => ({ name: filter.name }) };
      }
      if (name === 'dataSourcesRolesResources') {
        return { findOne: async () => null, create: async ({ values }) => values };
      }
      return null;
    },
  };

  await syncProfileToNocobaseAi(fakeDb, {
    username: 'dxos-architect',
    nickname: 'Kiến trúc sư Hệ thống AI',
    position: 'Admin Builder',
    systemPrompt: 'Support admin',
    llmService: 'local-9router',
    modelName: 'combo',
    enabled: true,
    isAdminBuilder: true,
    allowedRoles: ['ldx_employee', 'root', 'admin'],
    toolPermissions: {
      dxos_inspect_architecture: 'ALLOW',
      dxos_compose_page_blocks: 'ASK',
      dxos_search_enterprise_context: 'OFF',
    },
    mcpServers: [{ name: 'dxos-it-ot-mcp', url: 'http://127.0.0.1:13000/api/dxos-mcp/it-ot', useUserContext: true, enabled: true }],
  }, { adminToolNames: ADMIN_TOOLS });

  const emp = empStore.get('dxos-architect');
  assert.ok(emp);
  assert.deepEqual(emp.skillSettings.tools, [
    { name: 'dxos_inspect_architecture', autoCall: true },
    { name: 'dxos_compose_page_blocks', autoCall: false },
  ]);
  const assignedRoles = (roleBindings.get('dxos-architect') || []).map((r) => r.roleName);
  assert.deepEqual(assignedRoles.sort(), ['admin', 'root']);
  const mcp = mcpStore.get('dxos-it-ot-mcp');
  assert.equal(mcp.transport, 'http');
  assert.equal(mcp.useUserContext, true);
  assert.equal(mcp.headers.Authorization, 'Bearer {{request.token}}');

  await recordAiAuditLog(fakeDb, {
    actorUserId: 1,
    actorUsername: 'admin',
    organizationId: 'native-ui-lab',
    channel: 'ai-tool',
    aiEmployee: 'dxos-architect',
    toolName: 'dxos_compose_page_blocks',
    argsSummary: { token: 'abc', slug: 'services' },
    status: 'allowed',
  });
  assert.equal(auditRows.length, 1);
  assert.equal(auditRows[0].argsSummary.token, '[REDACTED]');

  const grants = await installAiRoleGrants(fakeDb);
  assert.equal(Array.isArray(grants.granted), true);
});

test('validateMcpServerUrl blocks IPv6-mapped SSRF & arbitrary internal HTTP hosts, and redactAuditText strips bearer/jwt/sk secrets', () => {
  const { redactAuditText } = require('../src/server/ai-schemas');
  assert.throws(() => validateMcpServerUrl('http://[::ffff:169.254.169.254]/latest'), /SSRF|https|blocked/i);
  assert.throws(() => validateMcpServerUrl('http://10.0.0.5:8080/mcp'), /SSRF|https|blocked/i);
  assert.throws(() => validateMcpServerUrl('http://internal-postgres:5432/mcp'), /https/i);
  assert.equal(validateMcpServerUrl('http://orion-ld:1026/version'), 'http://orion-ld:1026/version');

  const cleaned = redactAuditText('Failed calling Bearer eyJhbGciOiJIUzI1NiJ9.eyJ1IjoxfQ.abc with sk-secretKey99');
  assert.equal(cleaned.includes('eyJhbGciOiJIUzI1NiJ9'), false);
  assert.equal(cleaned.includes('sk-secretKey99'), false);
});
