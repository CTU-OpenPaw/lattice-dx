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
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');

function makeM3MockDb() {
  const stores = {
    latticeAiProfiles: [],
    latticeAiAuditLogs: [],
    latticeAiQuotaUsage: [],
    latticeAiQuotaPolicies: [],
    latticeAiApprovalQueue: [],
    latticeUiSnapshots: [],
    latticeOrganizations: [{ id: 1, organizationId: 'org-a', active: true, status: 'active' }, { id: 2, organizationId: 'org-b', active: true, status: 'active' }],
    latticeEmployees: [
      { id: 10, userId: 1, organizationId: 'org-a', active: true },
      { id: 20, userId: 2, organizationId: 'org-b', active: true },
    ],
    roles: [
      { name: 'root', allowConfigure: true, snippets: ['pm', 'pm.*'] },
      { name: 'ldx_admin', allowConfigure: true, snippets: ['pm'] },
    ],
    rolesUsers: [
      { userId: 1, roleName: 'ldx_admin' },
      { userId: 2, roleName: 'ldx_admin' },
      { userId: 99, roleName: 'root' },
    ],
    aiEmployees: [],
    rolesAiEmployees: [],
    llmServices: [],
    uiLayouts: [],
    desktopRoutes: [],
    desktopRoutesUiLayouts: [],
    flowModels: [],
    collections: [],
    fields: [],
    workflows: [],
    flow_nodes: [],
  };
  let seq = 100;

  function matchesFilter(row, filter = {}) {
    if (!filter || typeof filter !== 'object') return true;
    return Object.entries(filter).every(([k, cond]) => {
      if (k === '$and' && Array.isArray(cond)) return cond.every((sub) => matchesFilter(row, sub));
      if (k === '$or' && Array.isArray(cond)) return cond.some((sub) => matchesFilter(row, sub));
      if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
        if ('$in' in cond) return cond.$in.includes(row[k]);
        if ('$ne' in cond) return row[k] !== cond.$ne;
      }
      return String(row[k]) === String(cond);
    });
  }

  function wrap(arr, row) {
    return {
      ...row,
      get: (k) => row[k],
      set: (k, v) => { row[k] = v; },
      update: async (patch = {}) => {
        Object.assign(row, patch);
        return wrap(arr, row);
      },
      toJSON: () => ({ ...row }),
    };
  }

  return {
    stores,
    hasCollection: (name) => Boolean(stores[name]),
    getCollection: (name) => (stores[name] ? { name, sync: async () => {} } : null),
    getRepository(name) {
      const arr = stores[name];
      if (!arr) return null;
      return {
        async find({ filter = {}, sort, limit, offset } = {}) {
          let rows = arr.filter((r) => matchesFilter(r, filter));
          if (Array.isArray(sort) && sort.includes('-id')) {
            rows = [...rows].sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
          }
          if (offset) rows = rows.slice(offset);
          if (limit) rows = rows.slice(0, limit);
          return rows.map((r) => wrap(arr, r));
        },
        async findOne({ filter = {}, filterByTk } = {}) {
          const hit = filterByTk != null
            ? arr.find((r) => String(r.id) === String(filterByTk) || String(r.uid) === String(filterByTk))
            : arr.find((r) => matchesFilter(r, filter));
          return hit ? wrap(arr, hit) : null;
        },
        async count({ filter = {} } = {}) {
          return arr.filter((r) => matchesFilter(r, filter)).length;
        },
        async create({ values = {} } = {}) {
          const row = { id: ++seq, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...values };
          arr.push(row);
          return wrap(arr, row);
        },
        async update({ filter = {}, filterByTk, values = {} } = {}) {
          const targets = filterByTk != null
            ? arr.filter((r) => String(r.id) === String(filterByTk))
            : arr.filter((r) => matchesFilter(r, filter));
          for (const t of targets) Object.assign(t, values);
          return targets.map((t) => wrap(arr, t));
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
        async findModelByParentId() { return null; },
        async findModelById() { return null; },
        async upsertModel() { return null; },
      };
    },
  };
}

function makeStatefulReact() {
  const stateSlots = [];
  const refSlots = [];
  const effectSlots = [];
  const memoSlots = [];
  let sIdx = 0;
  let rIdx = 0;
  let eIdx = 0;
  let mIdx = 0;
  const depsChanged = (p, n) => !p || !n || p.length !== n.length || n.some((d, i) => d !== p[i]);
  const React = {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (init) => {
      const i = sIdx++;
      if (!(i in stateSlots)) stateSlots[i] = typeof init === 'function' ? init() : init;
      return [stateSlots[i], (v) => { stateSlots[i] = typeof v === 'function' ? v(stateSlots[i]) : v; }];
    },
    useRef: (init) => {
      const i = rIdx++;
      if (!(i in refSlots)) refSlots[i] = { current: init };
      return refSlots[i];
    },
    useEffect: (fn, deps) => {
      const i = eIdx++;
      effectSlots[i] = { fn, deps, changed: depsChanged(effectSlots[i]?.deps, deps) };
    },
    useMemo: (fn, deps) => {
      const i = mIdx++;
      if (!memoSlots[i] || depsChanged(memoSlots[i].deps, deps)) memoSlots[i] = { value: fn(), deps };
      return memoSlots[i].value;
    },
    useCallback: (fn, deps) => {
      const i = mIdx++;
      if (!memoSlots[i] || depsChanged(memoSlots[i].deps, deps)) memoSlots[i] = { value: fn, deps };
      return memoSlots[i].value;
    },
  };
  const render = (Comp, props = {}) => {
    sIdx = 0; rIdx = 0; eIdx = 0; mIdx = 0;
    const t = Comp(props);
    for (const ef of effectSlots) {
      if (ef.changed) { ef.changed = false; ef.fn(); }
    }
    return t;
  };
  return { React, render };
}

function findByTestId(node, id) {
  if (!node || typeof node !== 'object') return null;
  if (node.props?.['data-testid'] === id) return node;
  const kids = Array.isArray(node.children) ? node.children.flat(Infinity) : [];
  for (const k of kids) {
    const hit = findByTestId(k, id);
    if (hit) return hit;
  }
  return null;
}

function findAll(node, pred, acc = []) {
  if (!node || typeof node !== 'object') return acc;
  if (pred(node)) acc.push(node);
  const kids = Array.isArray(node.children) ? node.children.flat(Infinity) : [];
  for (const k of kids) findAll(k, pred, acc);
  return acc;
}

test('M3.1 probeLlmHealth verifyCompletion runs real completion probes for google-genai, anthropic, and ollama', async () => {
  const { probeLlmHealth } = require(path.join(PLUGIN_ROOT, 'src/server/ai-llm-health.js'));
  const cases = [
    {
      name: 'quick-google-genai',
      provider: 'google-genai',
      options: { baseURL: 'https://generativelanguage.googleapis.com', apiKey: 'AIzaTest1234' },
      modelName: 'gemini-2.5-flash',
      expectedModelUrl: '/v1beta/models',
      expectedCompUrl: '/v1beta/models/gemini-2.5-flash:generateContent',
      expectedHeaderKey: 'x-goog-api-key',
    },
    {
      name: 'quick-anthropic',
      provider: 'anthropic',
      options: { baseURL: 'https://api.anthropic.com/v1', apiKey: 'sk-ant-1234' },
      modelName: 'claude-3-5-sonnet-latest',
      expectedModelUrl: '/v1/models',
      expectedCompUrl: '/v1/messages',
      expectedHeaderKey: 'x-api-key',
    },
    {
      name: 'quick-ollama',
      provider: 'ollama',
      options: { baseURL: 'http://127.0.0.1:11434' },
      modelName: 'llama3.1',
      expectedModelUrl: '/api/tags',
      expectedCompUrl: '/api/chat',
      expectedHeaderKey: null,
    },
  ];

  for (const c of cases) {
    const db = makeM3MockDb();
    db.stores.llmServices.push({ id: 1, name: c.name, provider: c.provider, enabled: true, options: c.options });
    const calls = [];
    const okRes = await probeLlmHealth(db, {
      isAdmin: true,
      llmServiceName: c.name,
      modelName: c.modelName,
      verifyCompletion: true,
      fetchImpl: async (url, init) => {
        calls.push({ url, method: init.method, headers: init.headers });
        return { ok: true, status: 200, json: async () => ({}) };
      },
    });
    assert.equal(okRes.ok, true, `${c.name} probe should pass`);
    assert.equal(okRes.completionChecked, true, `${c.name} must set completionChecked=true`);
    assert.equal(calls.length, 2, `${c.name} must run both GET models and POST completion probe`);
    assert.ok(calls[0].url.includes(c.expectedModelUrl));
    assert.ok(calls[1].url.endsWith(c.expectedCompUrl), `${c.name} completion URL expected ${c.expectedCompUrl}, got ${calls[1].url}`);
    if (c.expectedHeaderKey) {
      assert.ok(calls[1].headers[c.expectedHeaderKey], `${c.name} completion probe must send ${c.expectedHeaderKey}`);
    }

    // Also verify completion failure returns completionChecked: true
    const failRes = await probeLlmHealth(db, {
      isAdmin: true,
      llmServiceName: c.name,
      modelName: c.modelName,
      verifyCompletion: true,
      fetchImpl: async (url) => (String(url).endsWith(c.expectedCompUrl) ? { ok: false, status: 503 } : { ok: true, status: 200 }),
    });
    assert.equal(failRes.ok, false);
    assert.equal(failRes.completionChecked, true, `${c.name} failed completion probe must still set completionChecked=true`);
  }
});

test('M3.2 ai-resource:runEvalBenchmark wires llmInvoker for mode=llm and handles unconfigured/ok/error cleanly', async () => {
  const { createDxosAiActions } = require(path.join(PLUGIN_ROOT, 'src/server/ai-resource.js'));
  const db = makeM3MockDb();
  const rootCtx = (body) => ({
    method: 'POST',
    state: { currentUser: { id: 99, username: 'root' }, currentRoles: ['root'] },
    request: { body },
    action: { params: {} },
  });

  // 1. Fails closed with 503 NO_LLM_SERVICE when LLM is unconfigured
  const unconfiguredActions = createDxosAiActions(db, {
    env: {},
    llmClient: {
      resolveActiveLlmService: async () => ({ configured: false, reason: 'Chưa cấu hình LLM.' }),
      callConfiguredLlm: async () => ({ ok: false }),
    },
  });
  await assert.rejects(
    () => unconfiguredActions.runEvalBenchmark(rootCtx({ organizationId: 'org-a', suiteId: 'security-red-team', limit: 1, mode: 'llm' }), async () => {}),
    (err) => err.status === 503 && err.code === 'NO_LLM_SERVICE',
  );

  // 2. Runs mode='llm' via callConfiguredLlm, extracts tokens, model, and JSON decision
  const capturedCalls = [];
  const okActions = createDxosAiActions(db, {
    env: {},
    llmClient: {
      resolveActiveLlmService: async () => ({ configured: true, serviceName: 'quick-openai', modelName: 'gpt-4o-mini' }),
      callConfiguredLlm: async (opts) => {
        capturedCalls.push(opts);
        return {
          ok: true,
          model: opts.model || 'gpt-4o-mini',
          content: '{"refused":true,"toolName":null,"intent":"security_refusal","args":{},"reason":"Từ chối prompt injection"}',
          parsedJson: { refused: true, toolName: null, intent: 'security_refusal', args: {}, reason: 'Từ chối prompt injection' },
          usage: { prompt_tokens: 44, completion_tokens: 16, total_tokens: 60 },
        };
      },
    },
  });
  const ctxOk = rootCtx({ organizationId: 'org-a', suiteId: 'security-red-team', limit: 2, mode: 'llm', modelName: 'gpt-4o' });
  await okActions.runEvalBenchmark(ctxOk, async () => {});
  assert.equal(ctxOk.body.mode, 'llm');
  assert.equal(ctxOk.body.modelName, 'gpt-4o');
  assert.equal(ctxOk.body.total, 2);
  assert.equal(ctxOk.body.passed, 2);
  assert.equal(ctxOk.body.totalInputTokens, 88);
  assert.equal(ctxOk.body.totalOutputTokens, 32);
  assert.equal(capturedCalls[0].model, 'gpt-4o');
  assert.equal(capturedCalls[0].responseFormat, 'json');

  // 2b. When payload.modelName is omitted in mode='llm', summary.modelName falls back to active svc.modelName
  const ctxDefaultModel = rootCtx({ organizationId: 'org-a', suiteId: 'security-red-team', limit: 1, mode: 'llm' });
  await okActions.runEvalBenchmark(ctxDefaultModel, async () => {});
  assert.equal(ctxDefaultModel.body.modelName, 'gpt-4o-mini');

  // 3. Propagates LLM transport failure as invokeError instead of misclassifying as unrefused null tool
  const failActions = createDxosAiActions(db, {
    env: {},
    llmClient: {
      resolveActiveLlmService: async () => ({ configured: true, serviceName: 'quick-openai', modelName: 'gpt-4o-mini' }),
      callConfiguredLlm: async () => ({ ok: false, code: 'LLM_HTTP_502', reason: 'Bad Gateway' }),
    },
  });
  const ctxFail = rootCtx({ organizationId: 'org-a', suiteId: 'security-red-team', limit: 1, mode: 'llm' });
  await failActions.runEvalBenchmark(ctxFail, async () => {});
  assert.equal(ctxFail.body.passed, 0);
  assert.equal(ctxFail.body.failed, 1);
  assert.match(ctxFail.body.failures[0].diagnostic, /Bad Gateway/i);
});

test('M3.2 ai-trace-eval-panel exposes refused checkbox, mode=llm selector, validation errors, and Vietnamese labels', async () => {
  const { createAiEvalLabPanel, createAiTraceWaterfallPanel } = require(path.join(PLUGIN_ROOT, 'src/client/ai-trace-eval-panel.js'));

  // 1. Eval Lab: empty prompt validation, refused checkbox disables expectedTool, mode=llm + modelName forwarded
  const reqs = [];
  const { React, render } = makeStatefulReact();
  const EvalComp = createAiEvalLabPanel(React, {
    request: async (req) => {
      reqs.push(req);
      if (req.url === 'dxosAi:listEvalSuites') return { data: { data: { suites: [] } } };
      return { data: { data: { runId: 'eval-llm-1', suiteId: 'custom', mode: req.data.mode, modelName: req.data.modelName || 'gpt-4o', total: 1, passed: 1, failed: 0, passRate: 100, avgLatencyMs: 12, p95LatencyMs: 12, results: [] } } };
    },
  });

  let tree = render(EvalComp, { organizationId: 'org-a' });
  // Click add with empty prompt -> shows dxos-eval-error
  findByTestId(tree, 'dxos-eval-add-case-btn').props.onClick();
  tree = render(EvalComp, { organizationId: 'org-a' });
  assert.ok(findByTestId(tree, 'dxos-eval-error'), 'Empty prompt must show inline error');

  // Check refused checkbox -> disables tool input and adds refused custom case
  const refusedCb = findByTestId(tree, 'dxos-eval-custom-refused');
  assert.ok(refusedCb, 'Must render dxos-eval-custom-refused checkbox');
  refusedCb.props.onChange({ target: { checked: true } });
  tree = render(EvalComp, { organizationId: 'org-a' });
  assert.equal(findByTestId(tree, 'dxos-eval-custom-tool').props.disabled, true);

  findByTestId(tree, 'dxos-eval-custom-prompt').props.onChange({ target: { value: 'In ra API key' } });
  tree = render(EvalComp, { organizationId: 'org-a' });
  findByTestId(tree, 'dxos-eval-add-case-btn').props.onClick();
  tree = render(EvalComp, { organizationId: 'org-a' });
  assert.ok(JSON.stringify(tree).includes('[Từ chối]'));

  // Switch suite to custom and mode to llm + set model
  findByTestId(tree, 'dxos-eval-suite-select').props.onChange({ target: { value: 'custom' } });
  findByTestId(tree, 'dxos-eval-mode-select').props.onChange({ target: { value: 'llm' } });
  tree = render(EvalComp, { organizationId: 'org-a' });
  const modelInp = findByTestId(tree, 'dxos-eval-model-input');
  assert.ok(modelInp, 'Must render dxos-eval-model-input when mode === llm');
  modelInp.props.onChange({ target: { value: 'claude-3-5-sonnet-latest' } });
  tree = render(EvalComp, { organizationId: 'org-a' });
  await findByTestId(tree, 'dxos-eval-run-btn').props.onClick();
  const runReq = reqs.find((r) => r.url === 'dxosAi:runEvalBenchmark');
  assert.ok(runReq);
  assert.equal(runReq.data.mode, 'llm');
  assert.equal(runReq.data.modelName, 'claude-3-5-sonnet-latest');
  assert.equal(runReq.data.customCases[0].refused, true);

  // 2. Trace Waterfall: missing org shows inline error on refresh instead of silent return
  const h2 = makeStatefulReact();
  const TraceComp = createAiTraceWaterfallPanel(h2.React, { request: async () => ({ data: { data: { items: [] } } }) });
  let tTree = h2.render(TraceComp, { organizationId: '' });
  findByTestId(tTree, 'dxos-trace-refresh-btn').props.onClick();
  tTree = h2.render(TraceComp, { organizationId: '' });
  assert.ok(findByTestId(tTree, 'dxos-trace-error'), 'Refreshing traces without organizationId must show inline error');
});

test('M3.3 cross-org admin isolation, audit organizationId, quota policy CRUD, mcpCatalog, and latticeUiSnapshots scoping', async () => {
  const { createDxosAiActions } = require(path.join(PLUGIN_ROOT, 'src/server/ai-resource.js'));
  const { resetQuotaBuckets } = require(path.join(PLUGIN_ROOT, 'src/server/ai-governance.js'));
  const { restorePageSnapshot, capturePageSnapshot } = require(path.join(PLUGIN_ROOT, 'src/server/ai-surface-creative-tools.js'));
  resetQuotaBuckets();

  const db = makeM3MockDb();
  db.stores.latticeAiProfiles.push({ id: 1, username: 'org-b-agent', nickname: 'Org B Agent', organizationId: 'org-b', enabled: true });
  db.stores.latticeUiSnapshots.push({ id: 1, snapshotUid: 'snap-b-1', organizationId: 'org-b', portalSlug: 'services', pageTitle: 'Services', layoutState: {}, blocks: [] });

  const actions = createDxosAiActions(db);
  const orgAAdminCtx = (body = {}, params = {}, method = 'POST') => ({
    method,
    state: { currentUser: { id: 1, username: 'admin-a' }, currentRoles: ['ldx_admin'] },
    request: { body },
    action: { params },
  });
  const rootCtx = (body = {}, params = {}, method = 'POST') => ({
    method,
    state: { currentUser: { id: 99, username: 'root' }, currentRoles: ['root'] },
    request: { body },
    action: { params },
  });

  // 1. Cross-org saveProfile & deleteProfile rejected with 403 DXOS_ORG_MISMATCH
  await assert.rejects(
    () => actions.saveProfile(orgAAdminCtx({ username: 'agent-x', nickname: 'X', organizationId: 'org-b' }), async () => {}),
    (err) => err.status === 403 && err.code === 'DXOS_ORG_MISMATCH',
  );
  await assert.rejects(
    () => actions.saveProfile(orgAAdminCtx({ username: 'org-b-agent', nickname: 'Hijack' }), async () => {}),
    (err) => err.status === 403 && err.code === 'DXOS_ORG_MISMATCH',
  );
  await assert.rejects(
    () => actions.deleteProfile(orgAAdminCtx({ username: 'org-b-agent' }), async () => {}),
    (err) => err.status === 403 && err.code === 'DXOS_ORG_MISMATCH',
  );
  assert.equal(db.stores.latticeAiProfiles.some((p) => p.username === 'org-b-agent'), true, 'org-b profile must survive org-a delete attempt');

  // 2. Cross-org quotaSummary & saveQuotaPolicy rejected for non-root, allowed for own org & root
  await assert.rejects(
    () => actions.quotaSummary(orgAAdminCtx({}, { organizationId: 'org-b' }, 'GET'), async () => {}),
    (err) => err.status === 403 && err.code === 'DXOS_ORG_MISMATCH',
  );
  const saveQCtx = orgAAdminCtx({ orgDailyCalls: 999, userDailyCalls: 120, orgDailyTokens: 1200000, orgDailyUsd: 25 });
  await actions.saveQuotaPolicy(saveQCtx, async () => {});
  assert.equal(saveQCtx.body.organizationId, 'org-a');
  assert.equal(saveQCtx.body.limits.orgDailyCalls, 999);
  const getQCtx = orgAAdminCtx({}, {}, 'GET');
  await actions.quotaSummary(getQCtx, async () => {});
  assert.equal(getQCtx.body.limits.orgDailyCalls, 999);

  // 3. Cross-org rollbackPageSnapshot rejected & snapshot organizationId persisted
  await assert.rejects(
    () => actions.rollbackPageSnapshot(orgAAdminCtx({ portalSlug: 'services', snapshotUid: 'snap-b-1' }), async () => {}),
    (err) => err.status === 403 || err.rolledBack === false,
  );
  const rbRes = await restorePageSnapshot(db, { portalSlug: 'services', snapshotUid: 'snap-b-1', organizationId: 'org-a', allowCrossOrg: false }, (r, k) => r?.[k]);
  assert.equal(rbRes.rolledBack, false);
  const snapSave = await capturePageSnapshot({
    ...db,
    getRepository: (n) => {
      if (n === 'desktopRoutes') return { find: async () => [{ id: 1, type: 'flowPage', title: 'S', uiLayoutUid: 'ldx-portal-services', schemaUid: 'tab1' }] };
      if (n === 'desktopRoutesUiLayouts') return { find: async () => [{ desktopRouteId: 1, uiLayoutUid: 'ldx-portal-services' }] };
      if (n === 'flowModels') return { findModelByParentId: async () => ({ uid: 'g1', props: {}, subModels: { items: [] } }), findModelById: async () => null };
      return db.getRepository(n);
    },
  }, { portalSlug: 'services', pageTitle: 'S', organizationId: 'org-a', createdByUsername: 'admin-a' }, (r, k) => r?.[k]);
  assert.equal(snapSave.organizationId, 'org-a');

  // 4. Audit logs include organizationId on bootstrapDefaults & deleteProfile, and auditLogs pagination works
  await actions.bootstrapDefaults(orgAAdminCtx({}), async () => {});
  const bsLog = db.stores.latticeAiAuditLogs.find((l) => l.toolName === 'dxosAi:bootstrapDefaults');
  assert.equal(bsLog?.organizationId, 'org-a');
  const saveLogCtx = orgAAdminCtx({ username: 'temp-a', nickname: 'Temp A' });
  await actions.saveProfile(saveLogCtx, async () => {});
  await actions.deleteProfile(orgAAdminCtx({ username: 'temp-a' }), async () => {});
  const delLog = db.stores.latticeAiAuditLogs.find((l) => l.toolName === 'dxosAi:deleteProfile');
  assert.equal(delLog?.organizationId, 'org-a');

  const auditCtx = rootCtx({}, { organizationId: 'org-a', page: 1, pageSize: 2 }, 'GET');
  await actions.auditLogs(auditCtx, async () => {});
  assert.equal(typeof auditCtx.body.total, 'number');
  assert.equal(auditCtx.body.page, 1);
  assert.equal(auditCtx.body.pageSize, 2);
  assert.ok(auditCtx.body.items.length <= 2);

  // 5. mcpCatalog returns enterprise + itot tools, resources, prompts, agentCard, and redacted configSnippet
  const mcpCtx = orgAAdminCtx({}, {}, 'GET');
  await actions.mcpCatalog(mcpCtx, async () => {});
  assert.ok(mcpCtx.body.enterpriseTools.length >= 15);
  assert.ok(mcpCtx.body.itOtTools.length >= 4);
  assert.ok(mcpCtx.body.agentCard?.skills?.length >= 7);
  assert.ok(mcpCtx.body.configSnippet.includes('<YOUR_NOCOBASE_BEARER_TOKEN>'));
});

test('M3.4 ai-builder-flow captures workflows:update errors and app-builder-planner parses extended Vietnamese patches', async () => {
  const { createFlowBuilderTools } = require(path.join(PLUGIN_ROOT, 'src/server/ai-builder-flow.js'));
  const { parseNaturalAppPlanOrPatch, applySpecPatch } = require(path.join(PLUGIN_ROOT, 'src/server/app-builder-planner.js'));

  // 1. ai-builder-flow buildCustomWorkflow captures workflows:update error
  const db = makeM3MockDb();
  db.sequelize = { transaction: async (fn) => fn({}) };
  const tools = createFlowBuilderTools({
    val: (r, k) => r?.[k],
    failTool: (code, status, message) => Object.assign(new Error(message), { code, status }),
    hasRes: (_c, name) => name === 'workflows',
    safeGetResource: (_c, name) => (name === 'workflows' ? {} : null),
    invokeResourceAction: async (_c, res, act) => {
      if (res === 'workflows' && act === 'update') throw new Error('Trigger registration failed');
      return {};
    },
    isProtected: () => false,
    SYSTEM_PROTECTED_COLLECTIONS: new Set(),
    createAuditedTool: (spec) => spec,
  });
  const wfTool = tools.find((t) => t.name === 'dxos_configure_workflow');
  const wfOut = await wfTool.run({}, db, { userId: 1, username: 'root', organizationId: 'org-a', isAdmin: true }, {
    operation: 'buildCustomWorkflow',
    collectionName: 'latticeCustomOrders',
    title: 'Test Flow Warn',
    enabled: true,
  });
  assert.equal(wfOut.enabled, false, 'enabled must be false when workflows:update fails');
  assert.match(wfOut.activationWarning || '', /Trigger registration failed/);

  // 2. app-builder-planner extended Vietnamese NL patch patterns
  const baseSpec = {
    appKey: 'demo-app',
    portalSlug: 'services',
    pageTitle: 'Demo',
    collectionName: 'latticeCustomTickets',
    fields: [{ name: 'title', type: 'string' }, { name: 'legacyNote', type: 'string' }],
    blocks: [{ blockUse: 'DxosPortalHeroBlockModel', title: 'Hero' }, { blockUse: 'DxosBiChartBlockModel', title: 'Biểu đồ cũ' }],
  };
  const nlPatch = parseNaturalAppPlanOrPatch(
    'thêm các trường priority bắt buộc, budget kiểu float, liên kết belongsTo latticeCustomClients, ẩn trường legacyNote, xóa khối Biểu đồ cũ, thêm vai trò Điều phối kho, đổi theme sang emerald-ops',
    baseSpec,
  );
  assert.ok(nlPatch.addFields.some((f) => f.name === 'priority' && f.required === true));
  assert.ok(nlPatch.addFields.some((f) => f.name === 'budget' && f.type === 'float'));
  assert.ok(nlPatch.addRelations.some((r) => r.type === 'belongsTo' && r.target === 'latticeCustomClients'));
  assert.ok(nlPatch.deprecateFields.includes('legacyNote'));
  assert.ok(nlPatch.removeBlocks.includes('Biểu đồ cũ'));
  assert.ok(nlPatch.addRoles.some((r) => r.roleTitle.includes('Điều phối kho')));
  assert.equal(nlPatch.creativeTheme, 'emerald-ops');

  const patched = applySpecPatch(baseSpec, null, 'ẩn trường legacyNote và đổi theme sang emerald-ops');
  assert.equal(patched.creativeTheme, 'emerald-ops');
  assert.equal(patched.fields.find((f) => f.name === 'legacyNote')?.deprecated, true);
});

test('M3.4 ai-studio-page sequential 1..9 sidebar, persistent Quick-Start, clickable /p/* links, confirm modal, MCP/Workforce/Audit/Quota forms', async () => {
  const { createDxosAiStudioPage } = require(path.join(PLUGIN_ROOT, 'src/client/ai-studio-page.js'));
  const apiCalls = [];
  const builtApps = [
    {
      id: 1,
      appKey: 'clinic-suite',
      name: 'Phòng khám',
      version: 2,
      status: 'active',
      organizationId: 'org-a',
      artifactRefsJson: { collections: ['latticeCustomVisits'], roles: ['ldx_clinic'], portals: [{ portalSlug: 'clinic-ops' }] },
      lastVerificationJson: { ok: false, passedCount: 1, totalCount: 2, failedChecks: [{ id: 'portal-check', detail: 'Thiếu khối Kanban' }] },
    },
  ];
  const { React, render } = makeStatefulReact();
  const Page = createDxosAiStudioPage({
    useAPIClient: () => ({
      auth: { getToken: () => 'tok-secret-jwt' },
      request: async (req) => {
        apiCalls.push(req);
        if (req.url === 'dxosAi:listProfiles') {
          return { data: { data: { profiles: [{ username: 'dxos-ops', nickname: 'Ops', organizationId: 'org-a', enabled: true }], organizations: ['org-a'], defaultOrganizationId: 'org-a', catalog: { availableTools: ['dxos_search_enterprise_context'], roleOptions: ['ldx_admin'] } } } };
        }
        if (req.url === 'dxosAi:enterpriseTopology') return { data: { data: { defaultOrganizationId: 'org-a', organizations: ['org-a'], planes: [] } } };
        if (req.url === 'dxosAi:auditLogs') {
          return { data: { data: { items: [{ id: 1, toolName: 'dxos_alarm_action', channel: 'mcp', aiEmployee: 'dxos-ops', status: 'allowed', resultSummary: 'OK', createdAt: '2026-11-26T02:00:00.000Z' }], total: 35, page: req.params?.page || 1, pageSize: req.params?.pageSize || 25 } } };
        }
        if (req.url === 'dxosAi:listBuiltApps') return { data: { data: { apps: builtApps } } };
        if (req.url === 'dxosAi:quotaSummary') return { data: { data: { organizationId: 'org-a', day: '2026-11-26', limits: { orgDailyCalls: 5000, userDailyCalls: 500, orgDailyTokens: 5000000, orgDailyUsd: 50 }, usage: { calls: 5, tokens: 100, costUsd: 0.01 }, allTimeTotals: {} } } };
        if (req.url === 'dxosAi:saveQuotaPolicy') return { data: { data: { organizationId: 'org-a', limits: req.data } } };
        if (req.url === 'dxosAi:mcpCatalog') {
          return {
            data: {
              data: {
                endpoints: { enterprise: '/api/dxos-mcp', itot: '/api/dxos-mcp/it-ot', agentCard: '/.well-known/agent-card.json' },
                enterpriseTools: [{ name: 'dxos_search_enterprise_context', description: 'Search', adminOnly: false, inputSchema: { type: 'object', properties: {} } }],
                itOtTools: [{ name: 'get_live_ngsi_telemetry', description: 'Telemetry', adminOnly: false, inputSchema: { type: 'object', properties: {} } }],
                resources: [{ uri: 'dxos://topology/planes', name: 'Topology' }],
                prompts: [{ name: 'dxos-cold-chain-incident-triage', title: 'Triage' }],
                agentCard: { name: 'LatticeDX A2A', skills: [{ id: 'dxos-ops', name: 'Ops' }] },
                configSnippet: '{"token":"<YOUR_NOCOBASE_BEARER_TOKEN>"}',
              },
            },
          };
        }
        return { data: { data: { ok: true } } };
      },
    }),
  }, React, {}, { defaultOrganizationId: 'org-a' });

  let tree = render(Page);
  await new Promise((r) => setTimeout(r, 15));
  tree = render(Page);

  // 1. Sequential 1..9 sidebar
  const tabBtns = findAll(tree, (n) => n.type === 'button' && String(n.props?.['data-testid'] || '').startsWith('dxos-tab-'));
  const labels = tabBtns.map((b) => String(b.children?.join('') || ''));
  assert.deepEqual(
    labels.map((l) => l.match(/^(\d+)\./)?.[1]),
    ['1', '2', '3', '4', '5', '6', '7', '8', '9'],
    'Sidebar numbering must be strictly sequential 1..9',
  );

  // 2. Tab 2 Workforce exposes 6 missing fields + client validation
  findByTestId(tree, 'dxos-tab-workforce').props.onClick();
  tree = render(Page);
  for (const tid of [
    'dxos-profile-org-input',
    'dxos-profile-department-input',
    'dxos-profile-greeting-input',
    'dxos-profile-enabled-checkbox',
    'dxos-profile-admin-builder-checkbox',
    'dxos-profile-subagent-checkbox',
  ]) {
    assert.ok(findByTestId(tree, tid), `Missing workforce field ${tid}`);
  }
  // Delete profile opens confirmation modal instead of immediate POST
  const delBtn = findAll(tree, (n) => n.type === 'button' && n.children?.includes('Xóa'))[0];
  delBtn.props.onClick();
  tree = render(Page);
  assert.ok(findByTestId(tree, 'dxos-confirm-modal'), 'Delete profile must open dxos-confirm-modal');
  assert.equal(apiCalls.some((c) => c.url === 'dxosAi:deleteProfile'), false);
  findByTestId(tree, 'dxos-confirm-modal-cancel').props.onClick();
  tree = render(Page);
  assert.equal(findByTestId(tree, 'dxos-confirm-modal'), null);

  // 3. Tab 3 MCP live catalog & config snippet without real JWT
  findByTestId(tree, 'dxos-tab-mcp').props.onClick();
  tree = render(Page);
  await new Promise((r) => setTimeout(r, 15));
  tree = render(Page);
  const mcpDump = JSON.stringify(tree);
  assert.ok(mcpDump.includes('dxos_search_enterprise_context'));
  assert.ok(mcpDump.includes('<YOUR_NOCOBASE_BEARER_TOKEN>'));
  assert.equal(mcpDump.includes('tok-secret-jwt'), false);

  // 4. Tab 4 Built Apps: persistent Quick-Start toggle, clickable /p/* link, failedChecks, teardown confirm with keepData=false
  findByTestId(tree, 'dxos-tab-built-apps').props.onClick();
  tree = render(Page);
  await new Promise((r) => setTimeout(r, 15));
  tree = render(Page);
  assert.ok(findByTestId(tree, 'dxos-built-apps-new-btn'));
  findByTestId(tree, 'dxos-built-apps-new-btn').props.onClick();
  tree = render(Page);
  assert.ok(findByTestId(tree, 'dxos-built-apps-quickstart'), 'Quick-Start must open when clicking + Tạo Ứng dụng Mới');
  const portalLink = findByTestId(tree, 'dxos-built-app-portal-link-clinic-suite-clinic-ops');
  assert.ok(portalLink && portalLink.type === 'a' && portalLink.props.href === '/p/clinic-ops');
  assert.ok(JSON.stringify(tree).includes('Thiếu khối Kanban'));

  findByTestId(tree, 'dxos-built-app-teardown-clinic-suite').props.onClick();
  tree = render(Page);
  assert.ok(findByTestId(tree, 'dxos-confirm-modal'));
  const keepCb = findByTestId(tree, 'dxos-teardown-keepdata-checkbox');
  assert.equal(keepCb.props.checked, true);
  keepCb.props.onChange({ target: { checked: false } });
  tree = render(Page);
  await findByTestId(tree, 'dxos-confirm-modal-ok').props.onClick();
  const tdCall = apiCalls.find((c) => c.url === 'dxosAi:teardownBuiltApp');
  assert.ok(tdCall);
  assert.equal(tdCall.data.keepData, false);

  // 5. Tab 5 Audit: GMT+7 timestamp column & pagination
  findByTestId(tree, 'dxos-tab-audit').props.onClick();
  tree = render(Page);
  assert.ok(JSON.stringify(findByTestId(tree, 'dxos-audit-table')).includes('Thời gian (GMT+7)'));
  assert.ok(findByTestId(tree, 'dxos-audit-next-btn'));

  // 6. Tab 9 Quota: editable policy form calls dxosAi:saveQuotaPolicy
  findByTestId(tree, 'dxos-tab-quota').props.onClick();
  tree = render(Page);
  await new Promise((r) => setTimeout(r, 15));
  tree = render(Page);
  const policyForm = findByTestId(tree, 'dxos-quota-policy-form');
  assert.ok(policyForm, 'Quota tab must render dxos-quota-policy-form');
  findByTestId(tree, 'dxos-quota-limit-org-calls').props.onChange({ target: { value: '7500' } });
  tree = render(Page);
  await findByTestId(tree, 'dxos-quota-policy-form').props.onSubmit({ preventDefault: () => {} });
  const savePolicyCall = apiCalls.find((c) => c.url === 'dxosAi:saveQuotaPolicy');
  assert.ok(savePolicyCall);
  assert.equal(Number(savePolicyCall.data.orgDailyCalls), 7500);
});

test('M3.3 migration 20261205000100 adds latticeUiSnapshots.organizationId and latticeAiQuotaPolicies with FORCE RLS reversibly', async () => {
  const Module = require('node:module');
  const origLoad = Module._load;
  class MockMigration { constructor(context) { this.context = context; } }
  const migPath = path.join(PLUGIN_ROOT, 'src/server/migrations/20261205000100-ui-snapshots-org-and-quota-policies.js');
  Module._load = function mocked(request, parent, isMain) {
    if (request === '@nocobase/server') return { Migration: MockMigration };
    return origLoad.call(this, request, parent, isMain);
  };
  let MigrationClass;
  try {
    delete require.cache[require.resolve(migPath)];
    MigrationClass = require(migPath);
  } finally {
    Module._load = origLoad;
  }
  const sqlCalls = [];
  const addedCols = [];
  const addedIdxs = [];
  const attachedRls = [];
  const mig = new MigrationClass({
    db: {
      sequelize: {
        getDialect: () => 'postgres',
        transaction: async (fn) => fn({ id: 'tx-m3' }),
        query: async (sql) => { sqlCalls.push(sql); return [[]]; },
        getQueryInterface: () => ({
          describeTable: async (tbl) => (tbl === 'latticeUiSnapshots' ? { id: {}, snapshotUid: {} } : {}),
          addColumn: async (tbl, col, def) => { addedCols.push({ tbl, col, def }); },
          addIndex: async (tbl, cols, opts) => { addedIdxs.push({ tbl, cols, opts }); },
          removeColumn: async () => {},
          dropTable: async () => {},
        }),
      },
      attachLatticeRlsPolicy: async (tbl) => { attachedRls.push(tbl); },
      detachLatticeRlsPolicy: async (tbl) => { attachedRls.push(`detach:${tbl}`); },
    },
  });
  await mig.up();
  assert.equal(sqlCalls.some((s) => s.includes('ALTER TABLE IF EXISTS "latticeUiSnapshots" ADD COLUMN IF NOT EXISTS "organizationId" VARCHAR(80)')), true);
  assert.equal(sqlCalls.some((s) => s.includes('CREATE TABLE IF NOT EXISTS "latticeAiQuotaPolicies"')), true);
  assert.deepEqual([...attachedRls].sort(), ['latticeAiQuotaPolicies', 'latticeUiSnapshots'], 'Both latticeUiSnapshots and latticeAiQuotaPolicies must attach FORCE RLS');
  await mig.down();
  assert.equal(attachedRls.includes('detach:latticeAiQuotaPolicies'), true);
});

test('M3.3 testMcpEndpoint validates SSRF and executes live initialize JSON-RPC probe', async () => {
  const { createDxosAiActions } = require(path.join(PLUGIN_ROOT, 'src/server/ai-resource.js'));
  const db = makeM3MockDb();
  const fetched = [];
  const actions = createDxosAiActions(db, {
    env: { NOCOBASE_INTERNAL_URL: 'http://127.0.0.1:13015' },
    fetchImpl: async (url, init) => {
      fetched.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => ({ jsonrpc: '2.0', id: 'mcp-probe', result: { protocolVersion: '2025-03-26', serverInfo: { name: 'latticedx-mcp' } } }),
      };
    },
  });
  const rootCtx = (body) => ({
    method: 'POST',
    state: { currentUser: { id: 99, username: 'root' }, currentRoles: ['root'] },
    headers: { authorization: 'Bearer test-tok' },
    request: { body },
    action: { params: {} },
  });
  const okCtx = rootCtx({ endpointType: 'itot' });
  await actions.testMcpEndpoint(okCtx, async () => {});
  assert.equal(okCtx.body.ok, true);
  assert.equal(okCtx.body.protocolVersion, '2025-03-26');
  assert.ok(fetched[0].url.endsWith('/api/dxos-mcp/it-ot'));
  assert.equal(fetched[0].init.headers.Authorization, 'Bearer test-tok');
  await assert.rejects(
    () => actions.testMcpEndpoint(rootCtx({ url: 'http://169.254.169.254/latest/meta-data/' }), async () => {}),
    (err) => err.status === 400 || err.status === 403 || /metadata|chặn|SSRF|loopback|TLS/i.test(err.message || ''),
  );

  // External / non-self / non-canonical URLs must be rejected BEFORE fetch and NEVER receive Authorization header
  const { validateMcpServerUrl } = require(path.join(PLUGIN_ROOT, 'src/server/ai-schemas.js'));
  for (const badMcp of ['https://2130706433/mcp', 'https://0x7f000001/mcp', 'http://0177.0.0.1:13015/mcp']) {
    assert.throws(() => validateMcpServerUrl(badMcp), /SSRF|Non-canonical|blocked/i);
  }
  const beforeCount = fetched.length;
  for (const unsafeTarget of [
    'https://evil.example.com/api/dxos-mcp',
    'http://n8n:5678/webhook',
    'http://127.0.0.1:13015/api/users:list',
    'https://2130706433/api/dxos-mcp',
    '//evil.example.com/api/dxos-mcp',
  ]) {
    await assert.rejects(
      () => actions.testMcpEndpoint(rootCtx({ url: unsafeTarget }), async () => {}),
      (err) => err.status === 400 || err.status === 403,
    );
  }
  assert.equal(fetched.length, beforeCount, 'External or non-self URLs must never trigger fetch or receive caller Authorization');
});

test('M3.5 persisted latticeAiQuotaPolicies limit is enforced after resetQuotaBuckets via hydrateQuotaBucketFromDb + checkAndConsumeAiQuota', async () => {
  const {
    saveQuotaPolicy,
    resetQuotaBuckets,
    hydrateQuotaBucketFromDb,
    checkAndConsumeAiQuota,
    recordQuotaUsagePersistent,
  } = require(path.join(PLUGIN_ROOT, 'src/server/ai-governance.js'));
  resetQuotaBuckets();
  const db = makeM3MockDb();
  await saveQuotaPolicy(db, 'org-a', {
    orgDailyCalls: 3,
    userDailyCalls: 1,
    orgDailyTokens: 100000,
    orgDailyUsd: 10,
  }, { username: 'admin-a' });
  assert.equal(db.stores.latticeAiQuotaPolicies.length, 1);

  // Simulate process restart / worker rotation
  resetQuotaBuckets();

  const actor = { userId: 101, username: 'u101', organizationId: 'org-a' };
  await recordQuotaUsagePersistent(db, actor, { promptTokens: 50, completionTokens: 20, costUsd: 0.001 });
  // Simulate second worker with empty in-memory quotaBuckets and quotaPolicyOverrides
  resetQuotaBuckets();

  await hydrateQuotaBucketFromDb(db, 'org-a');
  assert.throws(
    () => checkAndConsumeAiQuota(actor, { estimatedPromptTokens: 20 }),
    (err) => err.status === 429 && err.code === 'AI_QUOTA_EXCEEDED',
    'Persisted userDailyCalls=1 from latticeAiQuotaPolicies must be enforced after resetQuotaBuckets()',
  );
  resetQuotaBuckets();
});

test('M3.6 probeLlmHealth blocks unsafe SSRF baseURL from llmServices before calling fetchImpl', async () => {
  const { probeLlmHealth } = require(path.join(PLUGIN_ROOT, 'src/server/ai-llm-health.js'));
  const db = makeM3MockDb();
  db.stores.llmServices.push({
    id: 50,
    name: 'unsafe-ssrf',
    provider: 'openai-completions',
    enabled: true,
    options: { baseURL: 'http://169.254.169.254/latest/meta-data', apiKey: 'sk-test' },
  });
  let fetched = false;
  const res = await probeLlmHealth(db, {
    isAdmin: true,
    llmServiceName: 'unsafe-ssrf',
    fetchImpl: async () => { fetched = true; return { ok: true, status: 200 }; },
  });
  assert.equal(fetched, false, 'probeLlmHealth must validate baseURL against SSRF before calling fetchImpl');
  assert.equal(res.ok, false);
  assert.equal(res.code, 'LLM_URL_UNSAFE');
});

test('M3.7 Tab 5 Audit Apply Filter button queries server with active filters and Tab 3 clipboard fallback surfaces Vietnamese notice', async () => {
  const { createDxosAiStudioPage } = require(path.join(PLUGIN_ROOT, 'src/client/ai-studio-page.js'));
  const apiCalls = [];
  const { React, render } = makeStatefulReact();
  const Page = createDxosAiStudioPage({
    useAPIClient: () => ({
      auth: { getToken: () => 'tok-test' },
      request: async (req) => {
        apiCalls.push(req);
        if (req.url === 'dxosAi:listProfiles') return { data: { data: { profiles: [], organizations: ['org-a'], defaultOrganizationId: 'org-a', catalog: { availableTools: [], roleOptions: [] } } } };
        if (req.url === 'dxosAi:enterpriseTopology') return { data: { data: { defaultOrganizationId: 'org-a', organizations: ['org-a'], planes: [] } } };
        if (req.url === 'dxosAi:auditLogs') {
          return { data: { data: { items: [{ id: 1, toolName: 'dxos_alarm_action', channel: 'mcp', aiEmployee: 'dxos-ops', status: 'denied', resultSummary: 'ALM-1', createdAt: '2026-11-26T02:00:00.000Z' }], total: 1, page: 1, pageSize: 20 } } };
        }
        if (req.url === 'dxosAi:mcpCatalog') return { data: { data: { endpoints: { enterprise: '/api/dxos-mcp', itot: '/api/dxos-mcp/it-ot' }, enterpriseTools: [], itOtTools: [], configSnippet: '{}' } } };
        return { data: { data: {} } };
      },
    }),
  }, React, {}, { defaultOrganizationId: 'org-a' });

  let tree = render(Page);
  await new Promise((r) => setTimeout(r, 15));
  tree = render(Page);

  // 1. Tab 3 MCP clipboard fallback notice when clipboard rejects
  const origNavDesc = Object.getOwnPropertyDescriptor(global, 'navigator');
  Object.defineProperty(global, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText: async () => { throw new Error('NotAllowedError'); } } },
  });
  try {
    findByTestId(tree, 'dxos-tab-mcp').props.onClick();
    tree = render(Page);
    await new Promise((r) => setTimeout(r, 15));
    tree = render(Page);
    await findByTestId(tree, 'dxos-mcp-copy-snippet-btn').props.onClick();
    tree = render(Page);
    assert.ok(JSON.stringify(tree).includes('Trình duyệt không cho phép tự động sao chép'), 'Clipboard rejection must show fallback Vietnamese notice');
  } finally {
    if (origNavDesc) Object.defineProperty(global, 'navigator', origNavDesc);
    else delete global.navigator;
  }

  // 2. Tab 5 Audit Apply Filter button sends status, aiEmployee, q, page=1 to dxosAi:auditLogs
  findByTestId(tree, 'dxos-tab-audit').props.onClick();
  tree = render(Page);
  await new Promise((r) => setTimeout(r, 15));
  tree = render(Page);
  findByTestId(tree, 'dxos-audit-search-input').props.onChange({ target: { value: 'ALM' } });
  findByTestId(tree, 'dxos-audit-status-filter').props.onChange({ target: { value: 'denied' } });
  findByTestId(tree, 'dxos-audit-agent-filter').props.onChange({ target: { value: 'dxos-ops' } });
  tree = render(Page);
  const applyBtn = findByTestId(tree, 'dxos-audit-apply-filter-btn');
  assert.ok(applyBtn, 'Tab 5 Audit must render dxos-audit-apply-filter-btn');
  await applyBtn.props.onClick();
  const auditFilteredReq = [...apiCalls].reverse().find((c) => c.url === 'dxosAi:auditLogs' && c.params?.status === 'denied');
  assert.ok(auditFilteredReq, 'Apply filter must call dxosAi:auditLogs with status=denied');
  assert.equal(auditFilteredReq.params.aiEmployee, 'dxos-ops');
  assert.equal(auditFilteredReq.params.q, 'ALM');
  assert.equal(auditFilteredReq.params.page, 1);
});
