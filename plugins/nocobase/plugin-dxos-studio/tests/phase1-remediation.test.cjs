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

function loadWithNocobaseMocks(relPath) {
  const originalLoad = Module._load;
  class MockMigration {
    constructor(ctx = {}) {
      this.context = ctx;
      this.db = ctx.db;
    }
  }
  Module._load = function mockedNocobaseLoad(request, parent, isMain) {
    if (request === '@nocobase/server') return { Plugin: class {}, Migration: MockMigration };
    if (request === '@nocobase/database') return { defineCollection: (def) => def };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(path.join(PLUGIN_ROOT, relPath));
  } finally {
    Module._load = originalLoad;
  }
}

function collectNodes(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) collectNodes(item, pred, out);
    return out;
  }
  if (pred(node)) out.push(node);
  if (Array.isArray(node.children)) collectNodes(node.children, pred, out);
  return out;
}

function createQueuedReactHarness() {
  const statesByComponent = new WeakMap();
  const effectsByComponent = new WeakMap();
  const memosByComponent = new WeakMap();
  const callbacksByComponent = new WeakMap();
  const cleanups = [];
  let currentComponent = null;
  let stateIdx = 0;
  let effectIdx = 0;
  let memoIdx = 0;
  let callbackIdx = 0;
  let pendingUpdates = 0;
  const pendingEffects = [];

  const getBucket = (map, comp) => {
    let arr = map.get(comp);
    if (!arr) { arr = []; map.set(comp, arr); }
    return arr;
  };
  const depsChanged = (prevDeps, nextDeps) => !prevDeps || !Array.isArray(nextDeps) || nextDeps.length !== prevDeps.length || nextDeps.some((d, i) => !Object.is(d, prevDeps[i]));

  const React = {
    Fragment: 'Fragment',
    createElement(type, props, ...children) {
      const flat = [];
      for (const c of children) {
        if (Array.isArray(c)) flat.push(...c);
        else flat.push(c);
      }
      const nextProps = { ...(props || {}) };
      if (flat.length === 1) nextProps.children = flat[0];
      else if (flat.length > 1) nextProps.children = flat;
      return { type, props: nextProps, children: flat };
    },
    useState(init) {
      const comp = currentComponent;
      const bucket = getBucket(statesByComponent, comp);
      const idx = stateIdx++;
      if (bucket.length <= idx) bucket[idx] = { value: typeof init === 'function' ? init() : init, queue: [] };
      const slot = bucket[idx];
      while (slot.queue.length > 0) {
        const next = slot.queue.shift();
        slot.value = typeof next === 'function' ? next(slot.value) : next;
      }
      return [slot.value, (next) => { slot.queue.push(next); pendingUpdates += 1; }];
    },
    useEffect(fn, deps) {
      const comp = currentComponent;
      const bucket = getBucket(effectsByComponent, comp);
      const idx = effectIdx++;
      const prev = bucket[idx];
      if (!prev || depsChanged(prev.deps, deps)) {
        bucket[idx] = { deps: Array.isArray(deps) ? deps.slice() : null, cleanup: prev?.cleanup || null };
        pendingEffects.push({ entry: bucket[idx], fn });
      }
    },
    useCallback(fn, deps) {
      const comp = currentComponent;
      const bucket = getBucket(callbacksByComponent, comp);
      const idx = callbackIdx++;
      const prev = bucket[idx];
      if (!prev || depsChanged(prev.deps, deps)) bucket[idx] = { deps: Array.isArray(deps) ? deps.slice() : null, fn };
      return bucket[idx].fn;
    },
    useMemo(fn, deps) {
      const comp = currentComponent;
      const bucket = getBucket(memosByComponent, comp);
      const idx = memoIdx++;
      const prev = bucket[idx];
      if (!prev || depsChanged(prev.deps, deps)) bucket[idx] = { deps: Array.isArray(deps) ? deps.slice() : null, value: fn() };
      return bucket[idx].value;
    },
  };

  function renderNode(node) {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(renderNode);
    if (typeof node.type === 'function') {
      const [prevComp, prevS, prevE, prevM, prevC] = [currentComponent, stateIdx, effectIdx, memoIdx, callbackIdx];
      currentComponent = node.type;
      stateIdx = 0; effectIdx = 0; memoIdx = 0; callbackIdx = 0;
      let out;
      try { out = node.type(node.props || {}); }
      finally { currentComponent = prevComp; stateIdx = prevS; effectIdx = prevE; memoIdx = prevM; callbackIdx = prevC; }
      return renderNode(out);
    }
    if (Array.isArray(node.children)) return { ...node, children: node.children.map(renderNode) };
    return node;
  }

  async function mountAndFlush(ComponentFn, props = {}) {
    pendingUpdates = 0;
    let tree = renderNode(React.createElement(ComponentFn, props));
    for (let pass = 0; pass < 12; pass += 1) {
      const batch = pendingEffects.splice(0, pendingEffects.length);
      for (const item of batch) {
        if (typeof item.entry.cleanup === 'function') item.entry.cleanup();
        const nextClean = await item.fn();
        item.entry.cleanup = typeof nextClean === 'function' ? nextClean : null;
        if (item.entry.cleanup && !cleanups.includes(item.entry)) cleanups.push(item.entry);
      }
      await new Promise((resolve) => setImmediate(resolve));
      if (pendingUpdates > 0 || pendingEffects.length > 0 || batch.length > 0) {
        pendingUpdates = 0;
        tree = renderNode(React.createElement(ComponentFn, props));
      } else if (pass > 0) break;
    }
    return tree;
  }

  return {
    React,
    mountAndFlush,
    unmount() {
      for (const entry of cleanups.splice(0, cleanups.length)) {
        if (typeof entry.cleanup === 'function') entry.cleanup();
        entry.cleanup = null;
      }
    },
  };
}

test('Fix 1 (T1-PORTAL-02/05/06): alignPortalOverviewRoutesSort sets sort=1 on cockpit overview pages & groups and runs on plugin startup', async () => {
  const { alignPortalOverviewRoutesSort } = require(path.join(PLUGIN_ROOT, 'src/server/portal-composer.js'));
  const DxosStudioPlugin = loadWithNocobaseMocks('src/server/index.js');

  // Cleanly returns { updated: 0 } when desktopRoutes is absent
  assert.deepEqual(await alignPortalOverviewRoutesSort({ getRepository: () => null }), { updated: 0 });

  const routes = [
    // Services: CRUD group sorted before overview group
    { id: 1, type: 'group', title: 'Danh bạ', sort: 1795573422917860 },
    { id: 2, type: 'flowPage', parentId: 1, title: 'Danh bạ Nhân viên', schemaUid: 'k2yqzxn03aw', sort: 1795573422917862 },
    { id: 3, type: 'group', title: 'Tổ chức & Nhân sự', sort: 1795573458185410 },
    { id: 4, type: 'flowPage', parentId: 3, title: 'Không gian P.A.R.A. & Dịch vụ', schemaUid: 'qu2oi1bfaeo', sort: 1795573458185413 },
    // Procurement
    { id: 5, type: 'flowPage', title: 'Tạo yêu cầu mới', schemaUid: 'ua771ue2mug', sort: 1795573377888029 },
    { id: 6, type: 'group', title: 'Yêu cầu mua sắm', sort: 1795573454150300 },
    { id: 7, type: 'flowPage', parentId: 6, title: 'Tổng quan Điều hành Mua sắm', schemaUid: '0zyek9ly55l', sort: 1795573454150306 },
    // Logistics
    { id: 8, type: 'flowPage', title: 'Danh sách Đơn hàng', schemaUid: 's9ihaxg10uv', sort: 1795573408548514 },
    { id: 9, type: 'group', title: 'Điều phối Vận chuyển', sort: 1795573456906930 },
    { id: 10, type: 'flowPage', parentId: 9, title: 'Điều hành Logistics 5 bước', schemaUid: 'zhfwr9j7i78', sort: 1795573456906939 },
  ];
  const links = [
    { uiLayoutUid: 'ldx-portal-services', desktopRouteId: 1 },
    { uiLayoutUid: 'ldx-portal-services', desktopRouteId: 2 },
    { uiLayoutUid: 'ldx-portal-services', desktopRouteId: 3 },
    { uiLayoutUid: 'ldx-portal-services', desktopRouteId: 4 },
    { uiLayoutUid: 'ldx-portal-procurement', desktopRouteId: 5 },
    { uiLayoutUid: 'ldx-portal-procurement', desktopRouteId: 6 },
    { uiLayoutUid: 'ldx-portal-procurement', desktopRouteId: 7 },
    { uiLayoutUid: 'ldx-portal-logistics', desktopRouteId: 8 },
    { uiLayoutUid: 'ldx-portal-logistics', desktopRouteId: 9 },
    { uiLayoutUid: 'ldx-portal-logistics', desktopRouteId: 10 },
  ];

  const db = {
    getRepository(name) {
      if (name === 'desktopRoutes') {
        return {
          async find() { return routes; },
          async update({ filterByTk, values }) {
            const target = routes.find((r) => r.id === filterByTk);
            if (target) Object.assign(target, values);
            return target ? 1 : 0;
          },
        };
      }
      if (name === 'desktopRoutesUiLayouts') {
        return {
          async find({ filter } = {}) {
            return links.filter((l) => !filter?.uiLayoutUid || l.uiLayoutUid === filter.uiLayoutUid);
          },
        };
      }
      return null;
    },
  };

  const plugin = Object.create(DxosStudioPlugin.prototype);
  plugin.db = db;
  const res = await plugin.runStartupRepairs();
  assert.equal(res.routesUpdated, 6);
  for (const id of [3, 4, 6, 7, 9, 10]) {
    assert.equal(routes.find((r) => r.id === id).sort, 1, `Route/group #${id} must align to sort=1`);
  }

  // Idempotent on second call
  const res2 = await alignPortalOverviewRoutesSort(db);
  assert.equal(res2.updated, 0);
});

test('Fix 2 (T1-FLOW-01/05, T2-FLOW-02): FlowStudioApp & WorkflowConnectorsPage allow ldx_manager even when allowConfigUI=false while blocking ldx_employee/ldx_driver', async () => {
  const { createFlowStudioApp } = require(path.join(PLUGIN_ROOT, 'src/client/flow/flow-studio-app.js'));
  const indexPath = path.join(PLUGIN_ROOT, 'src/client/index.js');
  class MockPlugin { constructor(app) { this.app = app; } }

  // 1. ldx_manager with allowConfigUI === false -> ALLOWED on FlowStudioApp & WorkflowConnectorsPage, zero 403 listEmployees call
  const hMgr = createQueuedReactHarness();
  const mgrRequests = [];
  const mgrClient = {
    Plugin: MockPlugin,
    useUIConfigurationPermissions: () => ({ allowAll: false, allowConfigUI: false }),
    useCurrentUserContext: () => ({ data: { id: 21, username: 'mgr', currentRole: 'ldx_manager' } }),
    useAPIClient: () => ({
      auth: { role: 'ldx_manager' },
      request: async (req) => {
        mgrRequests.push(req.url);
        if (req.url === 'dxosStudio:listEmployees') {
          const err = new Error('Forbidden');
          err.response = { status: 403 };
          throw err;
        }
        return { data: { data: { items: [], nodeTypes: [], blueprints: [] } } };
      },
    }),
  };

  const FlowMgrApp = createFlowStudioApp(mgrClient, hMgr.React, {}, {});
  const mgrTree = await hMgr.mountAndFlush(FlowMgrApp, {});
  assert.equal(collectNodes(mgrTree, (n) => n.props?.['data-testid'] === 'dxos-flow-studio-forbidden').length, 0);
  assert.equal(collectNodes(mgrTree, (n) => n.props?.['data-testid'] === 'dxos-flow-list-view').length, 1);
  assert.equal(collectNodes(mgrTree, (n) => n.props?.['data-testid'] === 'dxos-flow-new-btn').length, 1);
  assert.equal(mgrRequests.includes('dxosStudio:listEmployees'), false, 'ldx_manager must skip admin-only listEmployees probe');
  assert.ok(mgrRequests.includes('dxosAutomations:listRules'));
  hMgr.unmount();

  const origLoad = Module._load;
  Module._load = function mocked(req, parent, isMain) {
    if (req === '@nocobase/client') return mgrClient;
    if (req === 'react') return hMgr.React;
    if (req === 'antd') return {};
    return origLoad.call(this, req, parent, isMain);
  };
  let mod;
  try {
    delete require.cache[require.resolve(indexPath)];
    mod = require(indexPath);
  } finally {
    Module._load = origLoad;
  }
  const added = [];
  await new mod.default({ pluginSettingsManager: { add(k, o) { added.push({ k, o }); } } }).load();
  const connComp = added.find((x) => x.k === 'workflow.connectors').o.Component;
  const connMgrTree = await hMgr.mountAndFlush(connComp, {});
  assert.equal(collectNodes(connMgrTree, (n) => n.props?.['data-testid'] === 'dxos-workflow-connectors-forbidden').length, 0);
  assert.equal(collectNodes(connMgrTree, (n) => n.props?.['data-testid'] === 'dxos-workflow-connectors-tab').length, 1);
  hMgr.unmount();

  // 2. ldx_employee & ldx_driver -> STRICTLY BLOCKED with zero API calls
  for (const role of ['ldx_employee', 'ldx_driver']) {
    const hEmp = createQueuedReactHarness();
    const empReqs = [];
    const empClient = {
      Plugin: MockPlugin,
      useUIConfigurationPermissions: () => ({ allowAll: false, allowConfigUI: false }),
      useCurrentUserContext: () => ({ data: { id: 30, username: role, currentRole: role } }),
      useAPIClient: () => ({
        auth: { role },
        request: async (req) => { empReqs.push(req.url); return { data: { data: {} } }; },
      }),
    };
    const FlowEmpApp = createFlowStudioApp(empClient, hEmp.React, {}, {});
    const empTree = await hEmp.mountAndFlush(FlowEmpApp, {});
    assert.equal(collectNodes(empTree, (n) => n.props?.['data-testid'] === 'dxos-flow-studio-forbidden').length, 1, `${role} must see forbidden card`);
    assert.equal(empReqs.length, 0, `${role} must trigger zero automation API calls`);
    hEmp.unmount();
  }
});

test('Fix 3 (T1-PUBLIC-02, T1-STUDIO-03, T3-CF-03): SERVICE_PRIORITIES & latticeServiceTickets accept low, normal, medium, high, urgent, critical', () => {
  const { SERVICE_PRIORITIES, serviceTickets, validateServiceTicket } = require(path.join(PLUGIN_ROOT, 'src/server/service-schema.js'));
  assert.deepEqual(SERVICE_PRIORITIES, ['low', 'normal', 'medium', 'high', 'urgent', 'critical']);
  const prioField = serviceTickets.fields.find((f) => f.name === 'priority');
  assert.deepEqual(prioField.uiSchema.enum.map((e) => e.value), SERVICE_PRIORITIES);

  for (const prio of SERVICE_PRIORITIES) {
    const m = { code: 'TKT-1', name: 'Test', serviceType: 'it_support', priority: prio, isNewRecord: true };
    validateServiceTicket(m, {});
    assert.equal(m.priority, prio);
  }
  assert.throws(
    () => validateServiceTicket({ code: 'TKT-2', name: 'Bad', serviceType: 'it_support', priority: 'invalid_prio' }, {}),
    (err) => err.code === 'SERVICE_PRIORITY_INVALID' && err.status === 400,
  );
});

test('Fix 4 (T1-FLOW-03): control.merge first_completed settles in same batch as suspended sibling control.delay and continues downstream', async () => {
  const { executeFlowGraph, resumeFlowRun } = require(path.join(PLUGIN_ROOT, 'src/server/flow/executor.js'));
  const store = {
    latticeEmployees: [{ id: 2, userId: 21, organizationId: 'org-a', role: 'ldx_manager', active: true }],
    rolesUsers: [{ userId: 21, roleName: 'ldx_manager' }],
    latticeAutomationRules: [],
    latticeAutomationRuns: [],
    latticeNotifications: [],
    latticeAiApprovalQueue: [],
  };
  let seq = 1;
  const makeRepo = (name) => {
    const arr = (store[name] = store[name] || []);
    const match = (r, f = {}) => Object.entries(f || {}).every(([k, v]) => {
      if (v && typeof v === 'object' && Array.isArray(v.$in)) return v.$in.includes(r[k]);
      return r[k] === v;
    });
    return {
      async find({ filter } = {}) { return arr.filter((r) => match(r, filter)); },
      async findOne({ filter } = {}) { return arr.find((r) => match(r, filter)) || null; },
      async create({ values }) { const row = { id: seq++, ...structuredClone(values) }; arr.push(row); return row; },
      async update({ filter, values }) {
        let count = 0;
        for (const r of arr) { if (match(r, filter)) { Object.assign(r, structuredClone(values)); count += 1; } }
        return count;
      },
    };
  };
  const db = { getRepository: (name) => makeRepo(name) };

  const rule = {
    organizationId: 'org-a',
    ruleKey: 'first_completed_delay_sibling',
    schemaVersion: 2,
    graphJson: {
      version: 2,
      nodes: [
        { id: 't1', type: 'trigger.manual', config: {} },
        { id: 'fast', type: 'logic.transform', config: { baseFromInput: false, operations: [{ op: 'set', target: 'winner', value: 'fast' }] } },
        { id: 'slow', type: 'control.delay', config: { delaySeconds: 60 } },
        { id: 'after_slow', type: 'logic.transform', config: { baseFromInput: false, operations: [{ op: 'set', target: 'afterSlow', value: true }] } },
        { id: 'merge1', type: 'control.merge', config: { mode: 'first_completed' } },
        { id: 'after_m', type: 'notify.send', config: { roleNames: ['ldx_manager'], title: 'Merged {{nodes.merge1.output.merged.winner}}' } },
      ],
      edges: [
        { id: 'e1', source: 't1', target: 'fast' },
        { id: 'e2', source: 't1', target: 'slow' },
        { id: 'e3', source: 'fast', target: 'merge1' },
        { id: 'e4', source: 'slow', target: 'after_slow' },
        { id: 'e5', source: 'after_slow', target: 'merge1' },
        { id: 'e6', source: 'merge1', target: 'after_m' },
      ],
    },
  };

  const run = await executeFlowGraph(db, rule, { organizationId: 'org-a', data: {} });
  assert.equal(run.status, 'suspended');
  assert.equal(run.suspendedNodeId, 'slow');
  assert.equal(run.nodeStatesJson.fast.status, 'completed');
  assert.equal(run.nodeStatesJson.slow.status, 'suspended');
  assert.equal(run.nodeStatesJson.merge1?.status, 'completed', 'merge1 must settle even when sibling slow delay suspends in same batch');
  assert.deepEqual(run.nodeStatesJson.merge1.output.merged, { winner: 'fast' });
  assert.equal(run.nodeStatesJson.after_m?.status, 'completed', 'Downstream node after merge1 must execute');
  assert.equal(run.nodeStatesJson.after_slow, undefined, 'after_slow waiting on suspended slow must NOT be marked skipped');
  assert.equal(store.latticeNotifications.length, 1);
  assert.equal(store.latticeNotifications[0].title, 'Merged fast');

  // Resuming slow finishes after_slow without re-firing merge1 or after_m
  const resumed = await resumeFlowRun(db, { organizationId: 'org-a', runUid: run.runUid, decision: 'main', resumeToken: run.resumeToken, actor: { username: 'system:delay-ticker' } });
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.nodeStatesJson.after_slow.status, 'completed');
  assert.equal(resumed.stepTracesJson.filter((t) => t.nodeId === 'merge1').length, 1);
  assert.equal(store.latticeNotifications.length, 1);
});

test('Fix 5 (T1-FLOW-06): latticeAutomationRules collection declares cronExpression and nextRunAt for toggleRule persistence', async () => {
  const rulesCol = loadWithNocobaseMocks('src/server/collections/automation-rules.js');
  const fields = rulesCol.options?.fields || rulesCol.fields || [];
  const cronField = fields.find((f) => f.name === 'cronExpression');
  const nextRunField = fields.find((f) => f.name === 'nextRunAt');
  assert.deepEqual(cronField, { name: 'cronExpression', type: 'string', allowNull: true });
  assert.deepEqual(nextRunField, { name: 'nextRunAt', type: 'date', allowNull: true });
});

test('Fix 6 (T2-STUDIO-05): normalizeLegacySlaEscalateRoles and migration 20261208000100 update legacy ldx_admin SLA rows to ldx_manager', async () => {
  const DxosStudioPlugin = loadWithNocobaseMocks('src/server/index.js');
  const Migration = loadWithNocobaseMocks('src/server/migrations/20261208000100-normalize-sla-escalate-role.js');
  const { exportSolutionBundle } = require(path.join(PLUGIN_ROOT, 'src/server/solution-bundle.js'));

  const slaRows = [
    { id: 1, organizationId: 'native-ui-lab', targetCollection: 'latticeIncidentCases', priority: 'critical', escalateToRole: 'ldx_admin', warnAfterMinutes: 15, breachAfterMinutes: 60, active: true },
    { id: 2, organizationId: 'native-ui-lab', targetCollection: 'latticeServiceTickets', priority: 'urgent', escalateToRole: 'ldx_manager', warnAfterMinutes: 60, breachAfterMinutes: 240, active: true },
  ];
  const db = {
    getRepository(name) {
      if (name === 'latticeSlaPolicies') {
        return {
          async find({ filter } = {}) {
            const roles = filter?.escalateToRole?.$in;
            return slaRows.filter((r) => (!roles || roles.includes(r.escalateToRole)) && (!filter?.organizationId || r.organizationId === filter.organizationId));
          },
          async update({ filterByTk, values }) {
            const row = slaRows.find((r) => r.id === filterByTk);
            if (row) Object.assign(row, values);
            return row ? 1 : 0;
          },
        };
      }
      return null;
    },
  };

  const res = await DxosStudioPlugin.normalizeLegacySlaEscalateRoles(db);
  assert.equal(res.updated, 1);
  assert.equal(slaRows[0].escalateToRole, 'ldx_manager');

  const warnings = [];
  const bundle = await exportSolutionBundle(db, { organizationId: 'native-ui-lab', warnings });
  assert.equal(warnings.length, 0, 'After normalization, exportSolutionBundle must emit zero stale SLA warnings');
  assert.equal(bundle.governance.slaPolicies.every((s) => s.escalateToRole === 'ldx_manager'), true);

  // Verify migration SQL under PG16 RLS
  const queries = [];
  const mig = new Migration({
    db: {
      sequelize: {
        getDialect: () => 'postgres',
        transaction: async (fn) => fn({}),
        async query(sql) {
          queries.push(sql);
          if (sql.includes('to_regclass')) return [[{ tbl: 'latticeSlaPolicies' }], []];
          return [[], []];
        },
      },
    },
  });
  await mig.up();
  assert.ok(queries.some((q) => q.includes("set_config('app.current_org', '*', true)")));
  assert.ok(queries.some((q) => q.includes('UPDATE "latticeSlaPolicies"') && q.includes("'ldx_manager'")));
});

test('Fix 7 (T1-STUDIO-01): DMN & broker/automation table styles are compacted while preserving overflowX: auto wrappers', async () => {
  const { createDmnVisualEditor } = require(path.join(PLUGIN_ROOT, 'src/client/dmn-visual-editor.js'));
  const { createBuilderBrokerPanels } = require(path.join(PLUGIN_ROOT, 'src/client/builder-broker-panels.js'));
  const harness = createQueuedReactHarness();

  const Editor = createDmnVisualEditor(harness.React, {});
  const dmnTree = await harness.mountAndFlush(Editor, {
    table: {
      tableKey: 't1',
      name: 'DMN Test',
      hitPolicy: 'FIRST',
      inputsJson: [{ name: 'severity', type: 'string' }],
      outputsJson: [{ name: 'assignee', type: 'string' }],
      rulesJson: [{ when: { severity: 'high' }, then: { assignee: 'ops' } }],
    },
  });
  const dmnWrap = collectNodes(dmnTree, (n) => n.type === 'div' && n.props?.style?.overflowX === 'auto')[0];
  assert.ok(dmnWrap, 'DMN tableWrap must preserve overflowX: auto');
  const inTh = collectNodes(dmnTree, (n) => n.type === 'th' && collectNodes(n, (c) => c.props?.['data-testid'] === 'dmn-input-col-name-0').length > 0)[0];
  const outTh = collectNodes(dmnTree, (n) => n.type === 'th' && collectNodes(n, (c) => c.props?.['data-testid'] === 'dmn-output-col-name-0').length > 0)[0];
  assert.ok(Number(inTh.props.style.minWidth) < 210, `Expected DMN input <th> minWidth < 210, got ${inTh.props.style.minWidth}`);
  assert.ok(Number(outTh.props.style.minWidth) < 170, `Expected DMN output <th> minWidth < 170, got ${outTh.props.style.minWidth}`);

  const { BrokerAndEventsPanel } = createBuilderBrokerPanels(
    { useAPIClient: () => ({ request: async () => ({ data: { data: {} } }) }) },
    harness.React,
    {},
    {},
  );
  const brokerTree = await harness.mountAndFlush(BrokerAndEventsPanel, { selectedOrg: 'org-a' });
  const brokerWrap = collectNodes(brokerTree, (n) => n.type === 'div' && n.props?.style?.overflowX === 'auto')[0];
  assert.ok(brokerWrap, 'Broker tableWrap must preserve overflowX: auto');
  const brokerTh = collectNodes(brokerTree, (n) => n.type === 'th')[0];
  assert.equal(brokerTh.props.style.whiteSpace, 'normal', 'Broker/automation <th> must allow wrapping');
  harness.unmount();
});
