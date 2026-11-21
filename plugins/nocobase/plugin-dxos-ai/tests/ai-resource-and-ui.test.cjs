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
const Module = require('node:module');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');

function makeMockDb() {
  const stores = {
    latticeAiProfiles: [],
    latticeAiAuditLogs: [],
    aiEmployees: [],
    rolesAiEmployees: [],
    aiMcpClients: [],
    llmServices: [],
    roles: [
      { name: 'root', allowConfigure: true, snippets: ['*'] },
      { name: 'admin', allowConfigure: true, snippets: ['pm', 'pm.*'] },
      { name: 'ldx_admin', allowConfigure: false, snippets: ['ui.*'] },
      { name: 'ldx_employee', allowConfigure: false, snippets: [] },
      { name: 'ldx_manager', allowConfigure: false, snippets: [] },
    ],
    rolesUsers: [
      { userId: 1, roleName: 'root' },
      { userId: 2, roleName: 'ldx_employee' },
    ],
    latticeEmployees: [
      { id: 20, userId: 2, organizationId: 'org-a', active: true },
    ],
    latticeAssets: [{ id: 1 }],
    latticeContextOutbox: [],
    workflows: [{ id: 1, current: true }],
    uiLayouts: [{ id: 1 }],
    latticeParaDocuments: [{ id: 1 }],
    collections: [{ name: 'latticeOrders' }],
  };
  let seq = 100;

  function matchesFilter(row, filter = {}) {
    return Object.entries(filter).every(([k, cond]) => {
      if (cond && typeof cond === 'object' && '$in' in cond) {
        return cond.$in.includes(row[k]);
      }
      return String(row[k]) === String(cond);
    });
  }

  function makeRepo(name) {
    const arr = stores[name];
    if (!arr) return null;
    const wrap = (row) => ({
      ...row,
      get: (k) => row[k],
      set: (k, v) => { row[k] = v; },
      async update(values = {}) { Object.assign(row, values); return this; },
    });
    return {
      async find({ filter = {}, sort, limit } = {}) {
        let rows = arr.filter((r) => matchesFilter(r, filter));
        if (Array.isArray(sort) && sort.includes('-id')) {
          rows = [...rows].sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
        }
        if (limit) rows = rows.slice(0, limit);
        return rows.map(wrap);
      },
      async findOne({ filter = {}, filterByTk } = {}) {
        const hit = filterByTk != null
          ? arr.find((r) => String(r.id) === String(filterByTk) || String(r.username) === String(filterByTk) || String(r.name) === String(filterByTk))
          : arr.find((r) => matchesFilter(r, filter));
        return hit ? wrap(hit) : null;
      },
      async create({ values = {} } = {}) {
        const row = { id: ++seq, ...values };
        arr.push(row);
        return wrap(row);
      },
      async destroy({ filter = {} } = {}) {
        let removed = 0;
        for (let i = arr.length - 1; i >= 0; i -= 1) {
          if (matchesFilter(arr[i], filter)) {
            arr.splice(i, 1);
            removed += 1;
          }
        }
        return removed;
      },
      async count({ filter = {} } = {}) {
        return arr.filter((r) => matchesFilter(r, filter)).length;
      },
    };
  }

  return {
    stores,
    sequelize: { transaction: async (fn) => fn({}) },
    hasCollection: (name) => Boolean(stores[name]),
    getRepository: (name) => makeRepo(name),
  };
}

test('dxosAi actions enforce admin locks, bootstrapDefaults without hardcoded keys, saveProfile role-lock, auditLogs, topology, and portalCopilot filtering', async () => {
  const { createDxosAiActions } = require(path.join(PLUGIN_ROOT, 'src/server/ai-resource.js'));
  const db = makeMockDb();
  const mockFetch = async () => ({ ok: true, status: 200, json: async () => ({ version: '1.8' }) });
  const actions = createDxosAiActions(db, {
    env: { AGENT_BASE_URL: 'http://host.docker.internal:20128/v1' },
    fetchImpl: mockFetch,
  });

  // 1. Unauthenticated caller rejected on portalCopilot
  await assert.rejects(
    () => actions.portalCopilot({ state: {}, action: { params: { portalSlug: 'services' } } }, async () => {}),
    (err) => err.status === 401,
  );

  // 2. Non-admin employee denied 403 on write/admin actions (including rolesUsers fallback with empty currentRoles)
  const empCtx = { state: { currentUser: { id: 2, username: 'emp1' }, currentRoles: [] }, action: { params: {} } };
  for (const actName of ['listProfiles', 'saveProfile', 'deleteProfile', 'bootstrapDefaults', 'auditLogs', 'enterpriseTopology']) {
    await assert.rejects(
      () => actions[actName](empCtx, async () => {}),
      (err) => err.status === 403 && err.code === 'DXOS_ADMIN_REQUIRED',
    );
  }

  // 3. bootstrapDefaults WITHOUT AGENT_API_KEY skips creating llmServices without embedding hardcoded secrets
  const adminCtx = (values = {}) => ({
    state: { currentUser: { id: 1, username: 'root' }, currentRoles: ['root'] },
    action: { params: { values } },
  });
  const noKeyCtx = adminCtx({});
  await actions.bootstrapDefaults(noKeyCtx, async () => {});
  assert.equal(noKeyCtx.body.bootstrappedCount, 5);
  assert.equal(noKeyCtx.body.llm.skipped, true);
  assert.equal(db.stores.llmServices.length, 0);
  assert.equal(db.stores.latticeAiProfiles.length, 5);
  assert.equal(db.stores.aiEmployees.length, 5);

  const itOtMcp = db.stores.aiMcpClients.find((m) => m.name === 'dxos-it-ot-mcp');
  assert.ok(itOtMcp, 'dxos-it-ot-mcp must be synced into aiMcpClients');
  assert.equal(itOtMcp.transport, 'http');
  assert.equal(itOtMcp.useUserContext, true);
  assert.equal(itOtMcp.headers.Authorization, 'Bearer {{request.token}}');

  // Verify dxos-architect strictly locked to root/admin in rolesAiEmployees
  const archRoles = db.stores.rolesAiEmployees.filter((r) => r.aiEmployee === 'dxos-architect').map((r) => r.roleName);
  assert.deepEqual(archRoles.sort(), ['admin', 'root']);

  // 4. bootstrapDefaults WITH AGENT_API_KEY env configures local-9router using env key & stays idempotent
  const withKeyActions = createDxosAiActions(db, {
    env: { AGENT_API_KEY: 'sk-test-env-9router', AGENT_BASE_URL: 'http://host.docker.internal:20128/v1' },
    fetchImpl: mockFetch,
  });
  const keyCtx = adminCtx({});
  await withKeyActions.bootstrapDefaults(keyCtx, async () => {});
  assert.equal(keyCtx.body.llm.configured, true);
  assert.equal(db.stores.llmServices.length, 1);
  assert.equal(db.stores.llmServices[0].name, 'local-9router');
  assert.equal(db.stores.llmServices[0].provider, 'openai-completions');
  assert.equal(db.stores.llmServices[0].options.apiKey, 'sk-test-env-9router');
  assert.equal(db.stores.latticeAiProfiles.length, 5);

  // 5. saveProfile creates custom employee hr-ops-ai, syncs 2-way, and forces admin lock when builder tools added
  const customCtx = adminCtx({
    username: 'hr-ops-ai',
    nickname: 'Trợ lý Nhân sự & Nghỉ phép AI',
    departmentScope: 'hr-services',
    allowedRoles: ['ldx_employee', 'ldx_manager'],
    portalBindings: ['services'],
    toolPermissions: {
      dxos_search_enterprise_context: 'ALLOW',
      dxos_execute_record_action: 'ASK',
      dxos_my_tasks_copilot: 'ALLOW',
    },
    quickPrompts: [{ label: 'Tra cứu phép năm', prompt: 'Kiểm tra phiếu dịch vụ nghỉ phép của tôi.' }],
  });
  await actions.saveProfile(customCtx, async () => {});
  assert.equal(customCtx.body.profile.username, 'hr-ops-ai');
  assert.equal(customCtx.body.sync.synced, true);
  assert.ok(db.stores.latticeAiAuditLogs.some((l) => l.toolName === 'dxosAi:saveProfile'));

  const escalationCtx = adminCtx({
    username: 'sneaky-builder',
    nickname: 'Sneaky Builder',
    allowedRoles: ['ldx_employee'],
    toolPermissions: { dxos_compose_page_blocks: 'ASK' },
  });
  await actions.saveProfile(escalationCtx, async () => {});
  assert.equal(escalationCtx.body.profile.isAdminBuilder, true);
  assert.deepEqual(escalationCtx.body.profile.allowedRoles, ['root', 'admin']);
  const sneakyRoles = db.stores.rolesAiEmployees.filter((r) => r.aiEmployee === 'sneaky-builder').map((r) => r.roleName);
  assert.deepEqual(sneakyRoles.sort(), ['admin', 'root']);

  // 6. portalCopilot for ldx_employee on portal 'services' includes hr-ops-ai, NEVER exposes dxos-architect or sneaky-builder
  const portalEmpCtx = {
    state: { currentUser: { id: 2, username: 'emp1' }, currentRoles: [] },
    action: { params: { portalSlug: 'services' } },
  };
  await actions.portalCopilot(portalEmpCtx, async () => {});
  const visibleUsernames = portalEmpCtx.body.employees.map((e) => e.username);
  assert.ok(visibleUsernames.includes('hr-ops-ai'));
  assert.ok(visibleUsernames.includes('dxos-workspace'));
  assert.ok(visibleUsernames.includes('dxos-coordinator'));
  assert.ok(!visibleUsernames.includes('dxos-architect'));
  assert.ok(!visibleUsernames.includes('sneaky-builder'));

  // 7. listProfiles, auditLogs, enterpriseTopology, and deleteProfile
  const listCtx = adminCtx({});
  await actions.listProfiles(listCtx, async () => {});
  assert.equal(listCtx.body.profiles.length, 7);
  assert.ok(Array.isArray(listCtx.body.catalog.availableTools));
  assert.equal(listCtx.body.catalog.availableTools.length, 11);

  const auditCtx = adminCtx({});
  await actions.auditLogs(auditCtx, async () => {});
  assert.ok(auditCtx.body.items.length >= 2);

  const topoCtx = adminCtx({});
  await actions.enterpriseTopology(topoCtx, async () => {});
  assert.equal(topoCtx.body.planes.length, 6);
  assert.equal(topoCtx.body.clause52Preserved, true);

  const delCtx = adminCtx({ username: 'hr-ops-ai' });
  await actions.deleteProfile(delCtx, async () => {});
  assert.equal(delCtx.body.deleted, true);
  assert.ok(!db.stores.latticeAiProfiles.some((p) => p.username === 'hr-ops-ai'));
  assert.ok(!db.stores.aiEmployees.some((p) => p.username === 'hr-ops-ai'));
});

test('createDxosAiStudioPage renders 4-tab studio UI & helper utilities, and plugin entrypoints wire cleanly', async () => {
  const {
    createDxosAiStudioPage,
    buildProfileDraftFromStarter,
    parseToolModeMap,
  } = require(path.join(PLUGIN_ROOT, 'src/client/ai-studio-page.js'));

  const React = {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
  };
  const mockClient = {
    useAPIClient: () => ({ request: async () => ({ data: { data: {} } }) }),
  };

  const Page = createDxosAiStudioPage(mockClient, React, {}, {});
  assert.equal(typeof Page, 'function');
  const tree = Page();
  assert.equal(tree.props['data-testid'], 'dxos-ai-studio-page');
  const textDump = JSON.stringify(tree);
  assert.ok(textDump.includes('6 Phân hệ') || textDump.includes('topology'));
  assert.ok(textDump.includes('Nhân sự AI'));
  assert.ok(textDump.includes('MCP'));
  assert.ok(textDump.includes('Kiểm toán'));

  const draft = buildProfileDraftFromStarter({
    username: 'dxos-ops',
    nickname: 'Ops AI',
    allowedRoles: ['ldx_employee'],
    toolPermissions: { dxos_search_enterprise_context: 'ALLOW' },
  });
  assert.ok(draft.username.startsWith('dxos-ops-copy'));
  assert.equal(parseToolModeMap({ dxos_inspect_architecture: 'ALLOW' }).dxos_inspect_architecture, 'ALLOW');

  // Verify client-v2 & server plugin registration with stubbed host SDKs
  const origLoad = Module._load;
  const registered = { resources: [], middlewares: [], tools: [], snippets: [], allowed: [], settingsPages: [] };
  class MockPlugin {
    constructor(app) {
      this.app = app;
      this.db = app?.db;
    }
  }
  Module._load = function (request, parent, isMain) {
    if (request === '@nocobase/server') return { Plugin: MockPlugin };
    if (request === '@nocobase/client') {
      return {
        Plugin: MockPlugin,
        useAPIClient: () => ({ request: async () => ({ data: { data: {} } }) }),
      };
    }
    if (request === 'react') return React;
    if (request === 'antd') return {};
    return origLoad.call(this, request, parent, isMain);
  };
  try {
    const db = makeMockDb();
    const mockServerApp = {
      db,
      use: (_fn, opts) => registered.middlewares.push(opts?.tag),
      resourceManager: {
        define: (def) => registered.resources.push(def.name),
      },
      acl: {
        registerSnippet: (s) => registered.snippets.push(s.name),
        allow: (res, act, cond) => registered.allowed.push(`${res}:${act}:${cond}`),
      },
      aiManager: {
        toolsManager: {
          registerTools: (tools) => registered.tools.push(...tools.map((t) => t.definition.name)),
        },
      },
    };
    const ServerPlugin = require(path.join(PLUGIN_ROOT, 'src/server/index.js'));
    const serverInst = new ServerPlugin(mockServerApp);
    await serverInst.load();
    assert.ok(registered.resources.includes('dxosAi'));
    assert.ok(registered.middlewares.includes('dxosMcpGateway'));
    assert.ok(registered.snippets.includes('pm.dxosAi'));
    assert.ok(registered.allowed.includes('dxosAi:portalCopilot:loggedIn'));
    assert.equal(registered.tools.length, 11);

    const ClientPluginMod = require(path.join(PLUGIN_ROOT, 'src/client/index.js'));
    const clientInst = new ClientPluginMod.default({
      pluginSettingsManager: { add: (key, opts) => registered.settingsPages.push({ key, opts }) },
    });
    await clientInst.load();
    assert.equal(registered.settingsPages[0].key, 'dxos-ai');
    assert.equal(registered.settingsPages[0].opts.aclSnippet, 'pm');

    const ClientV2Mod = require(path.join(PLUGIN_ROOT, 'src/client-v2/index.js'));
    const v2Inst = new ClientV2Mod.default({});
    await v2Inst.load();
  } finally {
    Module._load = origLoad;
  }
});
