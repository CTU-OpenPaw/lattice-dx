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
const { readFileSync } = require('node:fs');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');

function makeIntegrationDb() {
  const stores = {
    latticeEmployees: [
      { id: 10, userId: 1, organizationId: 'org-a', active: true },
      { id: 11, userId: 2, organizationId: 'org-a', active: true },
      { id: 12, userId: 3, organizationId: 'org-a', active: true },
      { id: 13, userId: 4, organizationId: 'org-b', active: true },
    ],
    roles: [
      { name: 'root', allowConfigure: true, snippets: ['*'] },
      { name: 'admin', allowConfigure: true, snippets: ['pm', 'pm.*'] },
      { name: 'ldx_admin', allowConfigure: true, snippets: ['pm.dxosAi'] },
      { name: 'ldx_employee', allowConfigure: false, snippets: [] },
    ],
    rolesUsers: [
      { userId: 1, roleName: 'root' },
      { userId: 2, roleName: 'ldx_employee' },
      { userId: 3, roleName: 'ldx_admin' },
      { userId: 4, roleName: 'ldx_employee' },
    ],
    latticeAiProfiles: [],
    latticeAiAuditLogs: [],
    latticeAiMemory: [],
    latticeAiTraces: [],
    latticeA2aTasks: [],
    latticeAiQuotaUsage: [],
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
      toJSON: () => ({ ...row }),
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
          ? arr.find((r) => String(r.id) === String(filterByTk))
          : arr.find((r) => matchesFilter(r, filter));
        return hit ? wrap(hit) : null;
      },
      async create({ values = {} } = {}) {
        const row = { id: ++seq, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...values };
        arr.push(row);
        return wrap(row);
      },
      async update({ filterByTk, filter = {}, values = {} } = {}) {
        const hits = filterByTk != null
          ? arr.filter((r) => String(r.id) === String(filterByTk))
          : arr.filter((r) => matchesFilter(r, filter));
        for (const h of hits) Object.assign(h, values);
        return hits.map(wrap);
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

test('Lane C integration: 7 starter blueprints (incl. dxos-operator & dxos-analyst) align with A2A_AGENT_CATALOG and 8 new collections are protected', () => {
  const { STARTER_AI_BLUEPRINTS } = require(path.join(PLUGIN_ROOT, 'src/server/ai-schemas.js'));
  const { A2A_AGENT_CATALOG } = require(path.join(PLUGIN_ROOT, 'src/server/a2a-gateway.js'));
  const coreMod = require(path.join(PLUGIN_ROOT, 'src/server/ai-tools-core.js'));
  const orchMod = require(path.join(PLUGIN_ROOT, 'src/server/app-builder-orchestrator.js'));

  assert.equal(STARTER_AI_BLUEPRINTS.length, 7);
  for (const agentId of ['dxos-coordinator', 'dxos-architect', 'dxos-ops', 'dxos-logistics', 'dxos-workspace', 'dxos-operator', 'dxos-analyst']) {
    const bp = STARTER_AI_BLUEPRINTS.find((b) => b.username === agentId);
    assert.ok(bp, `Missing starter blueprint ${agentId}`);
    assert.ok(A2A_AGENT_CATALOG[agentId], `Missing A2A catalog entry ${agentId}`);
    assert.equal(String(bp.nickname || '').includes('&'), false, `Nickname for ${agentId} must not contain '&'`);
  }

  const operatorBp = STARTER_AI_BLUEPRINTS.find((b) => b.username === 'dxos-operator');
  assert.deepEqual(operatorBp.allowedRoles, A2A_AGENT_CATALOG['dxos-operator'].allowedRoles);
  assert.equal(operatorBp.isAdminBuilder, false);
  assert.equal(operatorBp.toolPermissions.dxos_memory_recall, 'ALLOW');

  const analystBp = STARTER_AI_BLUEPRINTS.find((b) => b.username === 'dxos-analyst');
  assert.deepEqual(analystBp.allowedRoles, A2A_AGENT_CATALOG['dxos-analyst'].allowedRoles);
  assert.equal(analystBp.isAdminBuilder, false);
  assert.equal(analystBp.toolPermissions.dxos_graph_impact_analysis, 'ALLOW');
  assert.equal(analystBp.toolPermissions.dxos_memory_recall, 'ALLOW');

  const architectBp = STARTER_AI_BLUEPRINTS.find((b) => b.username === 'dxos-architect');
  assert.equal(architectBp.toolPermissions.dxos_memory_remember, 'ALLOW');
  assert.equal(architectBp.toolPermissions.dxos_memory_recall, 'ALLOW');
  assert.equal(architectBp.toolPermissions.dxos_memory_forget, 'ASK');

  const wave23Protected = [
    'latticeAiMemory',
    'latticeAiTraces',
    'latticeAutomationRuleVersions',
    'latticeA2aTasks',
    'latticeApprovalPolicies',
    'latticeApprovalRequests',
    'latticeNotificationDeliveries',
    'latticePublicForms',
  ];
  for (const col of wave23Protected) {
    assert.equal(coreMod.SYSTEM_PROTECTED_COLLECTIONS.has(col), true, `ai-tools-core missing protected ${col}`);
    assert.equal(orchMod.SYSTEM_PROTECTED_COLLECTIONS.has(col), true, `app-builder-orchestrator missing protected ${col}`);
    assert.equal(coreMod.isProtectedCollection(col.toLowerCase()), true, `isProtectedCollection must match ${col} case-insensitively`);
  }
});

test('Lane C integration: Memory tools wired into ai-tools-core (20 tools), dxos_search_enterprise_context, and buildAgentMemoryContext', async () => {
  const {
    MEMORY_TOOL_NAMES,
    createDxosTools,
    buildAgentMemoryContext,
  } = require(path.join(PLUGIN_ROOT, 'src/server/ai-tools-core.js'));

  assert.deepEqual([...MEMORY_TOOL_NAMES], ['dxos_memory_remember', 'dxos_memory_recall', 'dxos_memory_forget']);
  const tools = createDxosTools();
  assert.equal(tools.length, 20);
  const byName = new Map(tools.map((t) => [t.definition.name, t]));
  for (const mTool of MEMORY_TOOL_NAMES) {
    assert.ok(byName.has(mTool), `Missing memory tool ${mTool} in createDxosTools()`);
  }

  const db = makeIntegrationDb();
  const rootCtx = { db, state: { currentUser: { id: 1, username: 'root' }, currentRoles: ['root'], dxosAiUsername: 'dxos-architect' } };
  const empCtx = { db, state: { currentUser: { id: 2, username: 'emp2' }, currentRoles: ['ldx_employee'], dxosAiUsername: 'dxos-workspace' } };

  // Non-admin cannot write org-wide shared memory via tool
  await assert.rejects(
    () => byName.get('dxos_memory_remember').invoke(empCtx, { scope: 'org', memoryKey: 'policy-x', content: 'Tamper org policy' }),
    (err) => err.status === 403 && err.code === 'MEMORY_ORG_WRITE_FORBIDDEN',
  );

  // Admin writes org memory, then search tool (scope: ai_memory) and buildAgentMemoryContext recall it safely
  const remembered = await byName.get('dxos_memory_remember').invoke(rootCtx, {
    scope: 'org',
    memoryKey: 'cold-chain-sop',
    content: 'Ngưỡng nhiệt độ bảo quản vaccine chuẩn là -18°C.',
    tags: ['cold-chain', 'sop'],
    importance: 0.9,
  });
  assert.equal(remembered.ok, true);

  const recalled = await byName.get('dxos_memory_recall').invoke(empCtx, {
    scope: 'org',
    query: 'nhiệt độ bảo quản vaccine',
  });
  assert.equal(recalled.count, 1);
  assert.match(recalled.memories[0].content, /-18°C/);

  const searchMem = await byName.get('dxos_search_enterprise_context').invoke(empCtx, {
    scope: 'ai_memory',
    query: 'vaccine',
  });
  assert.equal(searchMem.scope, 'ai_memory');
  assert.equal(searchMem.count, 1);
  assert.match(searchMem.memoryContext, /dxos_memory_context/);

  const promptBlock = await buildAgentMemoryContext(db, { organizationId: 'org-a', userId: 1, aiEmployee: 'dxos-architect' }, { query: 'vaccine' });
  assert.match(promptBlock, /<dxos_memory_context/);
  assert.match(promptBlock, /-18°C/);
});

test('Lane C integration: ai-resource.js exposes Memory, Trace Waterfall & Eval Lab REST endpoints with strict RBAC and tenant/user isolation', async () => {
  const { createDxosAiActions } = require(path.join(PLUGIN_ROOT, 'src/server/ai-resource.js'));
  const db = makeIntegrationDb();
  const baseMs = 1700000000000;
  db.stores.latticeAiTraces.push(
    {
      id: 1,
      organizationId: 'org-a',
      traceId: 'trace-int-1',
      spanId: 'sp-root',
      name: 'invoke_agent dxos-architect',
      agentName: 'dxos-architect',
      genAiOperationName: 'invoke_agent',
      status: 'ok',
      startTimeMs: baseMs,
      endTimeMs: baseMs + 250,
      inputTokens: 100,
      outputTokens: 50,
    },
    {
      id: 2,
      organizationId: 'org-b',
      traceId: 'trace-org-b-secret',
      spanId: 'sp-b',
      name: 'invoke_agent dxos-ops',
      agentName: 'dxos-ops',
      status: 'ok',
      startTimeMs: baseMs,
      endTimeMs: baseMs + 100,
    },
  );

  const actions = createDxosAiActions(db);
  for (const name of [
    'listMemories',
    'rememberFact',
    'recallMemories',
    'forgetMemory',
    'listAgentTraces',
    'getAgentTraceDetail',
    'listEvalSuites',
    'runEvalBenchmark',
  ]) {
    assert.equal(typeof actions[name], 'function', `ai-resource must export ${name}`);
  }

  const empCtx = (method = 'GET', params = {}, values = undefined) => ({
    method,
    state: { currentUser: { id: 2, username: 'emp2' }, currentRoles: ['ldx_employee'] },
    action: { params: { ...params, ...(values ? { values } : {}) } },
    body: null,
  });
  const orgAdminCtx = (method = 'GET', params = {}, values = undefined) => ({
    method,
    state: { currentUser: { id: 3, username: 'orgadmin' }, currentRoles: ['ldx_admin'] },
    action: { params: { ...params, ...(values ? { values } : {}) } },
    body: null,
  });

  // 1. Non-admin blocked from Trace/Eval & org-memory mutations (403)
  await assert.rejects(() => actions.listAgentTraces(empCtx('GET')), (e) => e.status === 403);
  await assert.rejects(() => actions.getAgentTraceDetail(empCtx('GET', { traceId: 'trace-int-1' })), (e) => e.status === 403);
  await assert.rejects(() => actions.listEvalSuites(empCtx('GET')), (e) => e.status === 403);
  await assert.rejects(() => actions.runEvalBenchmark(empCtx('POST', {}, { suiteId: 'security-red-team' })), (e) => e.status === 403);
  await assert.rejects(() => actions.rememberFact(empCtx('POST', {}, { scope: 'org', memoryKey: 'k', content: 'v' })), (e) => e.status === 403);
  await assert.rejects(() => actions.forgetMemory(empCtx('POST', {}, { scope: 'org', memoryKey: 'k' })), (e) => e.status === 403);

  // 2. Non-admin cannot access another user's user-scoped memory (403 MEMORY_USER_MISMATCH)
  await assert.rejects(
    () => actions.listMemories(empCtx('GET', { scope: 'user', userId: '999' })),
    (e) => e.status === 403 && e.code === 'MEMORY_USER_MISMATCH',
  );
  await assert.rejects(
    () => actions.rememberFact(empCtx('POST', {}, { scope: 'user', userId: '999', memoryKey: 'p', content: 'x' })),
    (e) => e.status === 403 && e.code === 'MEMORY_USER_MISMATCH',
  );

  // 3. Non-admin CAN store/recall their own user-scoped memory in org-a
  const ownSave = empCtx('POST', {}, { scope: 'user', memoryKey: 'ui-pref', content: 'Ngôn ngữ tiếng Việt' });
  await actions.rememberFact(ownSave);
  assert.equal(ownSave.body.ok, true);
  assert.equal(ownSave.body.memory.organizationId, 'org-a');
  assert.equal(ownSave.body.memory.userId, '2');

  const ownRecall = empCtx('POST', {}, { scope: 'user', query: 'tiếng Việt' });
  await actions.recallMemories(ownRecall);
  assert.equal(ownRecall.body.count, 1);

  // 4. Org-admin (non-root) cannot query traces, memories, or evals for org-b (403 DXOS_ORG_MISMATCH)
  await assert.rejects(
    () => actions.listAgentTraces(orgAdminCtx('GET', { organizationId: 'org-b' })),
    (e) => e.status === 403 && e.code === 'DXOS_ORG_MISMATCH',
  );
  await assert.rejects(
    () => actions.listMemories(orgAdminCtx('GET', { organizationId: 'org-b' })),
    (e) => e.status === 403 && e.code === 'DXOS_ORG_MISMATCH',
  );
  await assert.rejects(
    () => actions.runEvalBenchmark(orgAdminCtx('POST', {}, { organizationId: 'org-b', suiteId: 'security-red-team' })),
    (e) => e.status === 403 && e.code === 'DXOS_ORG_MISMATCH',
  );

  // 5. Org-admin lists org-a traces & detail, cannot read org-b traceId (404)
  const traceListCtx = orgAdminCtx('GET', {});
  await actions.listAgentTraces(traceListCtx);
  assert.equal(traceListCtx.body.organizationId, 'org-a');
  assert.equal(traceListCtx.body.items.some((t) => t.traceId === 'trace-int-1'), true);
  assert.equal(traceListCtx.body.items.some((t) => t.traceId === 'trace-org-b-secret'), false);
  assert.equal(traceListCtx.body.items.every((t) => t.organizationId === 'org-a'), true);

  const traceDetailCtx = orgAdminCtx('GET', { traceId: 'trace-int-1' });
  await actions.getAgentTraceDetail(traceDetailCtx);
  assert.equal(traceDetailCtx.body.traceId, 'trace-int-1');

  await assert.rejects(
    () => actions.getAgentTraceDetail(orgAdminCtx('GET', { traceId: 'trace-org-b-secret' })),
    (e) => e.status === 404 && e.code === 'TRACE_NOT_FOUND',
  );

  // 6. Eval suites & benchmark
  const suitesCtx = orgAdminCtx('GET', {});
  await actions.listEvalSuites(suitesCtx);
  assert.ok(suitesCtx.body.suites.some((s) => s.id === 'vietnamese-nl-agent'));

  const benchCtx = orgAdminCtx('POST', {}, { suiteId: 'wave1-3-capabilities' });
  await actions.runEvalBenchmark(benchCtx);
  assert.equal(benchCtx.body.organizationId, 'org-a');
  assert.equal(benchCtx.body.passRate, 100);
});

test('Lane C integration: index.js mounts A2A middlewares, registers collections when db.collection exists, and keeps acl.allow strict', async () => {
  const indexSrc = readFileSync(path.join(PLUGIN_ROOT, 'src/server/index.js'), 'utf8');
  for (const restrictedAction of ['rememberFact', 'forgetMemory', 'listAgentTraces', 'getAgentTraceDetail', 'listEvalSuites', 'runEvalBenchmark']) {
    assert.equal(indexSrc.includes(`'${restrictedAction}'`), false, `${restrictedAction} must NOT be opened to loggedIn via acl.allow`);
  }

  const origLoad = Module._load;
  class MockPlugin {
    constructor(app) {
      this.app = app;
      this.db = app?.db;
    }
  }
  const registeredCols = [];
  const middlewares = [];
  Module._load = function mocked(request, parent, isMain) {
    if (request === '@nocobase/server') return { Plugin: MockPlugin };
    if (request === '@nocobase/database') return { defineCollection: (def) => def };
    return origLoad.call(this, request, parent, isMain);
  };
  try {
    const db = makeIntegrationDb();
    db.hasCollection = (name) => registeredCols.some((c) => c.name === name);
    db.collection = (def) => { registeredCols.push(def); };
    const pluginApp = {
      db,
      use: (fn, opts) => middlewares.push({ fn, opts }),
      resourceManager: { define: () => {}, use: () => {} },
      acl: { registerSnippet: () => {}, allow: () => {} },
    };
    delete require.cache[require.resolve(path.join(PLUGIN_ROOT, 'src/server/index.js'))];
    const ServerPlugin = require(path.join(PLUGIN_ROOT, 'src/server/index.js'));
    await new ServerPlugin(pluginApp).load();

    assert.ok(registeredCols.some((c) => c.name === 'latticeAiMemory'), 'latticeAiMemory must register on load');
    assert.ok(registeredCols.some((c) => c.name === 'latticeA2aTasks'), 'latticeA2aTasks must register on load');

    const cardMw = middlewares.find((m) => m.opts?.tag === 'dxosA2aAgentCard')?.fn;
    const rpcMw = middlewares.find((m) => m.opts?.tag === 'dxosA2aGateway')?.fn;
    assert.equal(typeof cardMw, 'function');
    assert.equal(typeof rpcMw, 'function');

    const cardCtx = { path: '/.well-known/agent-card.json', method: 'GET', set() {} };
    await cardMw(cardCtx, async () => {});
    assert.equal(cardCtx.status, 200);
    assert.ok(cardCtx.body.skills.some((s) => s.id === 'dxos-operator'));
    assert.ok(cardCtx.body.skills.some((s) => s.id === 'dxos-analyst'));

    const unauthRpcCtx = { path: '/api/dxos-a2a', method: 'POST', headers: {}, request: { body: { jsonrpc: '2.0', id: 1, method: 'tasks/send' } }, set() {} };
    await rpcMw(unauthRpcCtx, async () => {});
    assert.equal(unauthRpcCtx.status, 401);
  } finally {
    Module._load = origLoad;
    delete require.cache[require.resolve(path.join(PLUGIN_ROOT, 'src/server/index.js'))];
  }
});

test('Lane C integration: ai-studio-page.js wires Trace Waterfall & Eval Lab tabs cleanly with zero external imports', () => {
  const studioPath = path.join(PLUGIN_ROOT, 'src/client/ai-studio-page.js');
  const src = readFileSync(studioPath, 'utf8');
  for (const m of src.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
    assert.ok(m[1].startsWith('.'), `Unexpected external require in ai-studio-page.js: ${m[1]}`);
  }

  const { createDxosAiStudioPage } = require(studioPath);
  const { AiTraceWaterfallPanel, AiEvalLabPanel } = require(path.join(PLUGIN_ROOT, 'src/client/ai-trace-eval-panel.js'));

  const makeTabTree = (activeTab) => {
    let idx = 0;
    const stateVals = [
      activeTab,
      false,
      false,
      false,
      null,
      [],
      { availableTools: [], adminBuilderTools: [], roleOptions: [] },
      { defaultOrganizationId: 'org-ui', planes: [] },
      [],
      null,
      '[]',
      '[]',
      'org-ui',
    ];
    const React = {
      Fragment: 'Fragment',
      createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
      useState: (init) => [idx < stateVals.length ? stateVals[idx++] : (typeof init === 'function' ? init() : init), () => {}],
      useEffect: () => {},
      useMemo: (fn) => fn(),
      useCallback: (fn) => fn,
      useRef: (init) => ({ current: init }),
    };
    const Page = createDxosAiStudioPage({ useAPIClient: () => ({ request: async () => ({ data: {} }) }) }, React, {}, {});
    return Page();
  };

  const findNodes = (node, pred, acc = []) => {
    if (!node || typeof node !== 'object') return acc;
    if (pred(node)) acc.push(node);
    const kids = Array.isArray(node.children) ? node.children.flat(Infinity) : [];
    for (const k of kids) findNodes(k, pred, acc);
    return acc;
  };

  const traceTree = makeTabTree('traces');
  assert.ok(findNodes(traceTree, (n) => n.props?.['data-testid'] === 'dxos-tab-traces').length === 1);
  assert.ok(findNodes(traceTree, (n) => n.props?.['data-testid'] === 'dxos-tab-eval-lab').length === 1);
  const traceComp = findNodes(traceTree, (n) => n.type === AiTraceWaterfallPanel)[0];
  assert.ok(traceComp, 'Tab traces must render AiTraceWaterfallPanel');
  assert.equal(traceComp.props.organizationId, 'org-ui');
  assert.ok(traceComp.props.api);

  const evalTree = makeTabTree('eval-lab');
  const evalComp = findNodes(evalTree, (n) => n.type === AiEvalLabPanel)[0];
  assert.ok(evalComp, 'Tab eval-lab must render AiEvalLabPanel');
  assert.equal(evalComp.props.organizationId, 'org-ui');
  assert.ok(evalComp.props.api);
});

test('Lane C remediation: 0.4.0 version lock across package.json, A2A Agent Card, MCP initialize, exportAppBundle, and Eval Lab', async () => {
  const pkg = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '0.4.0');

  const { buildAgentCard } = require(path.join(PLUGIN_ROOT, 'src/server/a2a-gateway.js'));
  const card = buildAgentCard();
  assert.equal(card.version, '0.4.0');

  const { createMcpGatewayMiddleware } = require(path.join(PLUGIN_ROOT, 'src/server/mcp-gateway.js'));
  const mcpMw = createMcpGatewayMiddleware({
    tools: [],
    authResolver: async () => ({ currentUser: { id: 2, username: 'emp2' }, currentRoles: ['ldx_employee'] }),
  });
  const initCtx = {
    path: '/api/dxos-mcp',
    method: 'POST',
    headers: { authorization: 'Bearer tok' },
    request: { body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } } },
    set() {},
  };
  await mcpMw(initCtx, async () => {});
  assert.equal(initCtx.body.result.serverInfo.version, '0.4.0');

  const { listEvalSuites } = require(path.join(PLUGIN_ROOT, 'src/server/ai-eval-lab.js'));
  const srvSuites = listEvalSuites();
  const srvWave = srvSuites.find((s) => s.id === 'wave1-3-capabilities');
  assert.ok(srvWave);
  assert.match(srvWave.name, /0\.4\.0/);
  assert.doesNotMatch(srvWave.name, /v1\.1|Flagship/i);

  const { DEFAULT_EVAL_SUITES } = require(path.join(PLUGIN_ROOT, 'src/client/ai-trace-eval-panel.js'));
  const uiFull = DEFAULT_EVAL_SUITES.find((s) => s.id === 'vietnamese-nl-agent');
  assert.equal(uiFull.estimatedCaseCount, 163);
  const uiWave = DEFAULT_EVAL_SUITES.find((s) => s.id === 'wave1-3-capabilities');
  assert.match(uiWave.name, /0\.4\.0/);
  assert.doesNotMatch(uiWave.name, /v1\.1|Flagship/i);

  // exportAppBundle defaults platformVersion to 0.4.0
  const orchSrc = readFileSync(path.join(PLUGIN_ROOT, 'src/server/app-builder-orchestrator.js'), 'utf8');
  assert.match(orchSrc, /platformVersion\s*=\s*'0\.4\.0'/);
  assert.doesNotMatch(orchSrc, /platformVersion\s*=\s*'1\.0\.0'/);
});

test('Lane C remediation: non-admin dxos_memory_* & dxos_search_enterprise_context enforce agent-scope RBAC, agentId anti-spoofing, and session user binding', async () => {
  const { createDxosTools } = require(path.join(PLUGIN_ROOT, 'src/server/ai-tools-core.js'));
  const { createDxosAiActions } = require(path.join(PLUGIN_ROOT, 'src/server/ai-resource.js'));

  const db = makeIntegrationDb();
  const tools = createDxosTools();
  const byName = new Map(tools.map((t) => [t.definition.name, t]));

  const rootCtx = { db, state: { currentUser: { id: 1, username: 'root' }, currentRoles: ['root'], dxosAiUsername: 'dxos-architect', dxosSessionId: 'sess-shared' } };
  const emp2Ctx = { db, state: { currentUser: { id: 2, username: 'emp2' }, currentRoles: ['ldx_employee'], dxosAiUsername: 'dxos-workspace', dxosSessionId: 'sess-shared' } };
  db.stores.latticeEmployees.push({ id: 14, userId: 5, organizationId: 'org-a', active: true });
  db.stores.rolesUsers.push({ userId: 5, roleName: 'ldx_employee' });
  const emp5Ctx = { db, state: { currentUser: { id: 5, username: 'emp5' }, currentRoles: ['ldx_employee'], dxosAiUsername: 'dxos-workspace', dxosSessionId: 'sess-shared' } };

  // Seed private agent memory as admin
  await byName.get('dxos_memory_remember').invoke(rootCtx, {
    scope: 'agent',
    agentId: 'dxos-architect',
    memoryKey: 'arch-secret',
    content: 'Internal architect heuristic',
  });

  // Non-admin cannot read/write/delete scope:'agent' or scopes:['org','agent'] or spoof agentId
  await assert.rejects(
    () => byName.get('dxos_memory_recall').invoke(emp2Ctx, { scope: 'agent', agentId: 'dxos-architect', query: 'heuristic' }),
    (e) => e.status === 403 && e.code === 'MEMORY_AGENT_FORBIDDEN',
  );
  await assert.rejects(
    () => byName.get('dxos_memory_recall').invoke(emp2Ctx, { scopes: ['org', 'agent'], query: 'heuristic' }),
    (e) => e.status === 403 && e.code === 'MEMORY_AGENT_FORBIDDEN',
  );
  await assert.rejects(
    () => byName.get('dxos_memory_remember').invoke(emp2Ctx, { scope: 'agent', memoryKey: 'k', content: 'v' }),
    (e) => e.status === 403 && e.code === 'MEMORY_AGENT_FORBIDDEN',
  );
  await assert.rejects(
    () => byName.get('dxos_memory_forget').invoke(emp2Ctx, { scope: 'agent', memoryKey: 'arch-secret' }),
    (e) => e.status === 403 && e.code === 'MEMORY_AGENT_FORBIDDEN',
  );
  await assert.rejects(
    () => byName.get('dxos_memory_recall').invoke(emp2Ctx, { scope: 'user', agentId: 'dxos-architect', query: 'heuristic' }),
    (e) => e.status === 403 && e.code === 'MEMORY_AGENT_FORBIDDEN',
  );
  await assert.rejects(
    () => byName.get('dxos_memory_remember').invoke(emp2Ctx, { scope: 'org', memoryKey: 'k', content: 'v' }),
    (e) => e.status === 403 && e.code === 'MEMORY_ORG_WRITE_FORBIDDEN',
  );
  const { executeMemoryTool } = require(path.join(PLUGIN_ROOT, 'src/server/ai-memory.js'));
  await assert.rejects(
    () => executeMemoryTool(db, 'dxos_memory_remember', { scopes: ['user', 'org'], memoryKey: 'k', content: 'v' }, {
      actor: { organizationId: 'org-a', userId: 2, isAdmin: false },
    }),
    (e) => e.status === 403 && e.code === 'MEMORY_ORG_WRITE_FORBIDDEN',
  );
  await assert.rejects(
    () => byName.get('dxos_search_enterprise_context').invoke(emp2Ctx, { scope: 'ai_memory', scopes: ['org', 'agent'], query: 'heuristic' }),
    (e) => e.status === 403 && e.code === 'MEMORY_AGENT_FORBIDDEN',
  );
  await assert.rejects(
    () => byName.get('dxos_search_enterprise_context').invoke(emp2Ctx, { scope: 'ai_memory', agentId: 'dxos-architect', query: 'heuristic' }),
    (e) => e.status === 403 && e.code === 'MEMORY_AGENT_FORBIDDEN',
  );
  await assert.rejects(
    () => byName.get('dxos_search_enterprise_context').invoke(emp2Ctx, { scope: 'ai_memory', memoryScope: 'agent', query: 'x' }),
    (e) => e.status === 403 && e.code === 'MEMORY_AGENT_FORBIDDEN',
  );
  await assert.rejects(
    () => byName.get('dxos_search_enterprise_context').invoke(emp2Ctx, { scope: 'ai_memory', scopes: ['user'], memoryScope: 'agent', query: 'x' }),
    (e) => e.status === 403 && e.code === 'MEMORY_AGENT_FORBIDDEN',
  );

  // Non-admin session-scope isolation via tool & ai-resource
  const actions = createDxosAiActions(db);
  const saveSess2 = {
    method: 'POST',
    state: { currentUser: { id: 2, username: 'emp2' }, currentRoles: ['ldx_employee'] },
    action: { params: { values: { scope: 'session', sessionId: 'sess-shared', memoryKey: 'draft-1', content: 'Emp2 private session note' } } },
    body: null,
  };
  await actions.rememberFact(saveSess2);
  assert.equal(saveSess2.body.memory.userId, '2');

  // Another non-admin in same org & same sessionId cannot read, overwrite, delete, or spoof userId/createdById
  const listSess5 = {
    method: 'GET',
    state: { currentUser: { id: 5, username: 'emp5' }, currentRoles: ['ldx_employee'] },
    action: { params: { scope: 'session', sessionId: 'sess-shared' } },
    body: null,
  };
  await actions.listMemories(listSess5);
  assert.equal(listSess5.body.total, 0);

  await assert.rejects(
    () => actions.listMemories({
      method: 'GET',
      state: { currentUser: { id: 5, username: 'emp5' }, currentRoles: ['ldx_employee'] },
      action: { params: { scope: 'session', sessionId: 'sess-shared', userId: '2' } },
    }),
    (e) => e.status === 403 && e.code === 'MEMORY_USER_MISMATCH',
  );
  await assert.rejects(
    () => actions.listMemories({
      method: 'GET',
      state: { currentUser: { id: 5, username: 'emp5' }, currentRoles: ['ldx_employee'] },
      action: { params: { scope: 'session', sessionId: 'sess-shared', createdById: '2' } },
    }),
    (e) => e.status === 403 && e.code === 'MEMORY_USER_MISMATCH',
  );
  await assert.rejects(
    () => actions.rememberFact({
      method: 'POST',
      state: { currentUser: { id: 5, username: 'emp5' }, currentRoles: ['ldx_employee'] },
      action: { params: { values: { scope: 'session', sessionId: 'sess-shared', memoryKey: 'draft-1', content: 'hijack' } } },
    }),
    (e) => e.status === 403 && e.code === 'MEMORY_USER_MISMATCH',
  );
  await assert.rejects(
    () => byName.get('dxos_memory_forget').invoke(emp5Ctx, { scope: 'session', sessionId: 'sess-shared', id: saveSess2.body.memory.id }),
    (e) => e.status === 403 && e.code === 'MEMORY_USER_MISMATCH',
  );

  // Org-admin can still inspect org session memories when omitting userId
  const adminSessList = {
    method: 'GET',
    state: { currentUser: { id: 3, username: 'orgadmin' }, currentRoles: ['ldx_admin'] },
    action: { params: { scope: 'session', sessionId: 'sess-shared' } },
    body: null,
  };
  await actions.listMemories(adminSessList);
  assert.equal(adminSessList.body.total, 1);

  // REST resolveScopedMemoryParams must neutralize empty/mixed/invalid scope & scopes bypasses
  const empReqCtx = (method = 'GET', params = {}, values = undefined) => ({
    method,
    state: { currentUser: { id: 2, username: 'emp2' }, currentRoles: ['ldx_employee'] },
    action: { params: { ...params, ...(values ? { values } : {}) } },
    body: null,
  });
  const orgAdminReqCtx = (method = 'GET', params = {}, values = undefined) => ({
    method,
    state: { currentUser: { id: 3, username: 'orgadmin' }, currentRoles: ['ldx_admin'] },
    action: { params: { ...params, ...(values ? { values } : {}) } },
    body: null,
  });
  await actions.rememberFact(orgAdminReqCtx('POST', {}, { scope: 'org', memoryKey: 'org-policy', content: 'Official Org Policy' }));

  // { scopes: [''] } -> rejects fail-closed with 400 MEMORY_SCOPE_INVALID
  await assert.rejects(
    () => actions.rememberFact(empReqCtx('POST', {}, { scopes: [''], memoryKey: 'org-policy', content: 'PWNED' })),
    (e) => e.status === 400 && e.code === 'MEMORY_SCOPE_INVALID',
  );
  await assert.rejects(
    () => actions.forgetMemory(empReqCtx('POST', {}, { scopes: [''], memoryKey: 'org-policy' })),
    (e) => e.status === 400 && e.code === 'MEMORY_SCOPE_INVALID',
  );
  await assert.rejects(
    () => actions.listMemories(empReqCtx('GET', { scopes: [''] })),
    (e) => e.status === 400 && e.code === 'MEMORY_SCOPE_INVALID',
  );

  // { scope: 'agent', scopes: [''] } & { scope: 'agent', scopes: ['user'] } -> 403 DXOS_ADMIN_REQUIRED
  await assert.rejects(
    () => actions.rememberFact(empReqCtx('POST', {}, { scope: 'agent', scopes: [''], memoryKey: 'k', content: 'v' })),
    (e) => e.status === 403 && e.code === 'DXOS_ADMIN_REQUIRED',
  );
  await assert.rejects(
    () => actions.rememberFact(empReqCtx('POST', {}, { scope: 'agent', scopes: ['user'], memoryKey: 'k', content: 'v' })),
    (e) => e.status === 403 && e.code === 'DXOS_ADMIN_REQUIRED',
  );
  await assert.rejects(
    () => actions.forgetMemory(empReqCtx('POST', {}, { scope: 'agent', scopes: ['user'], memoryKey: 'arch-secret' })),
    (e) => e.status === 403 && e.code === 'DXOS_ADMIN_REQUIRED',
  );
  await assert.rejects(
    () => actions.listMemories(empReqCtx('GET', { scope: 'agent', scopes: ['user'] })),
    (e) => e.status === 403 && e.code === 'DXOS_ADMIN_REQUIRED',
  );

  // { scopes: ['', 'user'] } and { scopes: ['   ', 'user'] } -> fail-closed 400 MEMORY_SCOPE_INVALID, org-policy untouched
  await assert.rejects(
    () => actions.rememberFact(empReqCtx('POST', {}, { scopes: ['', 'user'], memoryKey: 'org-policy', content: 'Emp2 personal note' })),
    (e) => e.status === 400 && e.code === 'MEMORY_SCOPE_INVALID',
  );
  await assert.rejects(
    () => actions.forgetMemory(empReqCtx('POST', {}, { scopes: ['', 'user'], memoryKey: 'org-policy' })),
    (e) => e.status === 400 && e.code === 'MEMORY_SCOPE_INVALID',
  );
  await assert.rejects(
    () => actions.listMemories(empReqCtx('GET', { scopes: ['   ', 'user'] })),
    (e) => e.status === 400 && e.code === 'MEMORY_SCOPE_INVALID',
  );
  const orgCheckCtx = orgAdminReqCtx('GET', { scope: 'org', memoryKey: 'org-policy' });
  await actions.listMemories(orgCheckCtx);
  assert.equal(orgCheckCtx.body.memories[0].content, 'Official Org Policy');

  // Invalid scope values fail closed with 400 MEMORY_SCOPE_INVALID
  await assert.rejects(
    () => actions.rememberFact(empReqCtx('POST', {}, { scope: 'global', memoryKey: 'k', content: 'v' })),
    (e) => e.status === 400 && e.code === 'MEMORY_SCOPE_INVALID',
  );
  await assert.rejects(
    () => actions.listMemories(empReqCtx('GET', { scopes: ['user', 'bogus'] })),
    (e) => e.status === 400 && e.code === 'MEMORY_SCOPE_INVALID',
  );
});

test('Lane C remediation: index.js dxosAiMemoryAndA2aScope blocks direct NocoBase CRUD and charts:queryData on latticeAiMemory and latticeA2aTasks', async () => {
  const origLoad = Module._load;
  class MockPlugin {
    constructor(app) {
      this.app = app;
      this.db = app?.db;
    }
  }
  const rmMiddlewares = [];
  Module._load = function mocked(request, parent, isMain) {
    if (request === '@nocobase/server') return { Plugin: MockPlugin };
    if (request === '@nocobase/database') return { defineCollection: (def) => def };
    return origLoad.call(this, request, parent, isMain);
  };
  try {
    const db = makeIntegrationDb();
    db.hasCollection = () => false;
    db.collection = () => {};
    const pluginApp = {
      db,
      use: () => {},
      resourceManager: {
        define: () => {},
        use: (fn, opts) => rmMiddlewares.push({ fn, opts }),
      },
      acl: { registerSnippet: () => {}, allow: () => {} },
    };
    delete require.cache[require.resolve(path.join(PLUGIN_ROOT, 'src/server/index.js'))];
    const ServerPlugin = require(path.join(PLUGIN_ROOT, 'src/server/index.js'));
    await new ServerPlugin(pluginApp).load();

    const guard = rmMiddlewares.find((m) => m.opts?.tag === 'dxosAiMemoryAndA2aScope');
    const profileGuard = rmMiddlewares.find((m) => m.opts?.tag === 'dxosAiProfileScope');
    assert.ok(guard && typeof guard.fn === 'function', 'dxosAiMemoryAndA2aScope middleware must be registered');
    assert.ok(profileGuard && typeof profileGuard.fn === 'function', 'dxosAiProfileScope middleware must be registered');
    assert.equal(guard.opts.after, 'acl');
    assert.equal(guard.opts.before, 'latticeNativeScope');

    // Non-admin blocked from dotted latticeAiProfiles association and charts:queryData on latticeAiProfiles
    await assert.rejects(
      () => profileGuard.fn({
        state: { currentRole: 'ldx_employee', currentRoles: ['ldx_employee'] },
        action: { resourceName: 'latticeOrganizations.latticeAiProfiles', actionName: 'list', params: {} },
      }, async () => {}),
      (e) => e.status === 403 && e.code === 'DXOS_ADMIN_REQUIRED',
    );
    await assert.rejects(
      () => profileGuard.fn({
        state: { currentRole: 'ldx_employee', currentRoles: ['ldx_employee'] },
        action: { resourceName: 'charts', actionName: 'queryData', params: { values: { collection: 'latticeOrders', collectionName: 'latticeAiProfiles' } } },
      }, async () => {}),
      (e) => e.status === 403 && e.code === 'DXOS_ADMIN_REQUIRED',
    );
    await assert.rejects(
      () => profileGuard.fn({
        state: { currentRole: 'ldx_employee', currentRoles: ['ldx_employee'] },
        action: { resourceName: 'main.charts', actionName: 'queryData', params: { values: { collection: ['latticeOrders', 'latticeAiProfiles'] } } },
      }, async () => {}),
      (e) => e.status === 403 && e.code === 'DXOS_ADMIN_REQUIRED',
    );

    for (const role of ['ldx_employee', 'ldx_admin', 'admin']) {
      for (const actionName of ['list', 'get', 'create', 'update', 'destroy']) {
        await assert.rejects(
          () => guard.fn({ state: { currentRole: role }, action: { resourceName: 'latticeAiMemory', actionName, params: {} } }, async () => {}),
          (e) => e.status === 403 && e.code === 'DXOS_MEMORY_DIRECT_CRUD_FORBIDDEN',
        );
        await assert.rejects(
          () => guard.fn({ state: { currentRole: role }, action: { resourceName: 'latticeA2aTasks', actionName, params: {} } }, async () => {}),
          (e) => e.status === 403 && e.code === 'DXOS_A2A_DIRECT_CRUD_FORBIDDEN',
        );
        await assert.rejects(
          () => guard.fn({ state: { currentRole: role }, action: { resourceName: 'latticeAiTraces', actionName, params: {} } }, async () => {}),
          (e) => e.status === 403 && e.code === 'DXOS_TRACES_DIRECT_CRUD_FORBIDDEN',
        );
      }

      // Dotted association & main.charts / array collection vectors must also be blocked
      await assert.rejects(
        () => guard.fn({ state: { currentRole: role }, action: { resourceName: 'latticeOrganizations.latticeAiTraces', actionName: 'list', params: {} } }, async () => {}),
        (e) => e.status === 403 && e.code === 'DXOS_TRACES_DIRECT_CRUD_FORBIDDEN',
      );
      await assert.rejects(
        () => guard.fn({
          state: { currentRole: role },
          action: { resourceName: 'main.charts', actionName: 'queryData', params: { values: { collection: ['safeCollection', 'latticeAiMemory'] } } },
        }, async () => {}),
        (e) => e.status === 403 && e.code === 'DXOS_MEMORY_DIRECT_CRUD_FORBIDDEN',
      );
      await assert.rejects(
        () => guard.fn({
          state: { currentRole: role },
          action: { resourceName: 'main.charts', actionName: 'queryData', params: { values: { collection: 'latticeAiTraces' } } },
        }, async () => {}),
        (e) => e.status === 403 && e.code === 'DXOS_TRACES_DIRECT_CRUD_FORBIDDEN',
      );

      const chartPayloads = [
        { action: { resourceName: 'charts', actionName: 'queryData', params: { values: { mode: 'builder', collection: 'latticeAiMemory' } } } },
        { action: { resourceName: 'charts', actionName: 'queryData', params: { values: { collectionName: 'latticeAiMemory' } } } },
        { action: { resourceName: 'charts', actionName: 'queryData', params: { collectionName: 'latticeAiMemory' } } },
        { action: { resourceName: 'charts', actionName: 'queryData', params: { table: 'latticeAiMemory' } } },
        { action: { resourceName: 'charts', actionName: 'queryData', params: {} }, request: { body: { collectionName: 'latticeAiMemory' } } },
        { action: { resourceName: 'charts', actionName: 'queryData', params: { values: { collection: 'other', collectionName: 'latticeAiMemory' } } } },
        { action: { resourceName: 'charts', actionName: 'queryData', params: {} }, query: { table: 'latticeAiMemory' } },
      ];
      for (const payload of chartPayloads) {
        await assert.rejects(
          () => guard.fn({ state: { currentRole: role }, ...payload }, async () => {}),
          (e) => e.status === 403 && e.code === 'DXOS_MEMORY_DIRECT_CRUD_FORBIDDEN',
        );
      }

      const a2aChartPayloads = [
        { action: { resourceName: 'charts', actionName: 'queryData', params: { values: { mode: 'builder', collection: 'latticeA2aTasks' } } } },
        { action: { resourceName: 'charts', actionName: 'queryData', params: { values: { collectionName: 'latticeA2aTasks' } } } },
        { action: { resourceName: 'charts', actionName: 'queryData', params: { collectionName: 'latticeA2aTasks' } } },
        { action: { resourceName: 'charts', actionName: 'queryData', params: { table: 'latticeA2aTasks' } } },
        { action: { resourceName: 'charts', actionName: 'queryData', params: {} }, request: { body: { collectionName: 'latticeA2aTasks' } } },
        { action: { resourceName: 'charts', actionName: 'queryData', params: { values: { collection: 'other', collectionName: 'latticeA2aTasks' } } } },
      ];
      for (const payload of a2aChartPayloads) {
        await assert.rejects(
          () => guard.fn({ state: { currentRole: role }, ...payload }, async () => {}),
          (e) => e.status === 403 && e.code === 'DXOS_A2A_DIRECT_CRUD_FORBIDDEN',
        );
      }
    }

    // Root and unrelated collections pass through
    let nextCount = 0;
    await guard.fn({ state: { currentRole: 'root' }, action: { resourceName: 'latticeAiMemory', actionName: 'list', params: {} } }, async () => { nextCount += 1; });
    await guard.fn({ state: { currentRole: 'ldx_employee' }, action: { resourceName: 'latticeOrders', actionName: 'list', params: {} } }, async () => { nextCount += 1; });
    await guard.fn({
      state: { currentRole: 'ldx_employee' },
      action: { resourceName: 'charts', actionName: 'queryData', params: { values: { mode: 'builder', collection: 'latticeOrders' } } },
    }, async () => { nextCount += 1; });
    assert.equal(nextCount, 3);
  } finally {
    Module._load = origLoad;
    delete require.cache[require.resolve(path.join(PLUGIN_ROOT, 'src/server/index.js'))];
  }
});
