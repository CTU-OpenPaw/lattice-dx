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
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const FORBIDDEN_WORD = `${'co'}${'pilot'}`;

const originalLoad = Module._load;
Module._load = function mockedNocobaseLoad(request, parent, isMain) {
  if (request === '@nocobase/server') return { Plugin: class {}, Migration: class {} };
  if (request === '@nocobase/database') return { defineCollection: (def) => def };
  return originalLoad.call(this, request, parent, isMain);
};

let executorMod;
let automationMod;
try {
  executorMod = require('../src/server/flow/executor');
  automationMod = require('../src/server/automation-engine');
} finally {
  Module._load = originalLoad;
}

const { executeFlowGraph, resumeFlowRun, tickDueDelayedRuns } = executorMod;
const { createDxosAutomationsActions } = automationMod;
const { createDefaultRegistry } = require('../src/server/flow/registry');
const { validateFlowGraph } = require('../src/server/flow/validator');

function matchRow(row, filter) {
  if (!filter || typeof filter !== 'object') return true;
  for (const [k, v] of Object.entries(filter)) {
    if (k === '$and' && Array.isArray(v)) { if (!v.every((sub) => matchRow(row, sub))) return false; continue; }
    if (k === '$or' && Array.isArray(v)) { if (!v.some((sub) => matchRow(row, sub))) return false; continue; }
    const actual = row?.[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      if ('$in' in v && (!Array.isArray(v.$in) || !v.$in.includes(actual))) return false;
      if ('$ne' in v && actual === v.$ne) return false;
      if ('$gt' in v && !(Number(actual) > Number(v.$gt))) return false;
      if ('$gte' in v && !(Number(actual) >= Number(v.$gte))) return false;
      if ('$lt' in v && !(Number(actual) < Number(v.$lt))) return false;
      if ('$lte' in v && !(Number(actual) <= Number(v.$lte))) return false;
    } else if (actual !== v) return false;
  }
  return true;
}

function makeFlowDb(seed = {}) {
  const baseSeed = {
    latticeEmployees: [
      { id: 1, userId: 20, organizationId: 'org-a', role: 'ldx_admin', active: true },
      { id: 2, userId: 21, organizationId: 'org-a', role: 'ldx_manager', active: true },
      { id: 3, userId: 22, organizationId: 'org-a', role: 'ldx_operator', active: true },
      { id: 4, userId: 23, organizationId: 'org-a', role: 'ldx_employee', active: true },
    ],
    rolesUsers: [
      { userId: 20, roleName: 'ldx_admin' },
      { userId: 21, roleName: 'ldx_manager' },
      { userId: 22, roleName: 'ldx_operator' },
      { userId: 23, roleName: 'ldx_employee' },
    ],
    ...seed,
  };
  const store = {};
  const seq = {};
  for (const [col, rows] of Object.entries(baseSeed)) {
    store[col] = rows.map((r, i) => ({ id: r.id ?? i + 1, ...structuredClone(r) }));
    seq[col] = store[col].length + 1;
  }
  function makeRepo(name) {
    if (!store[name]) { store[name] = []; seq[name] = 1; }
    return {
      async find({ filter = {}, sort = [], limit = 200, offset = 0 } = {}) {
        let rows = store[name].filter((r) => matchRow(r, filter));
        if (Array.isArray(sort) && sort.length) {
          const primary = String(sort[0]);
          const desc = primary.startsWith('-');
          const key = desc ? primary.slice(1) : primary;
          rows = rows.slice().sort((a, b) => {
            const av = a[key] instanceof Date ? a[key].getTime() : a[key];
            const bv = b[key] instanceof Date ? b[key].getTime() : b[key];
            if (av === bv) return 0;
            if (av == null) return 1;
            if (bv == null) return -1;
            return (av < bv ? -1 : 1) * (desc ? -1 : 1);
          });
        }
        return rows.slice(offset, offset + limit).map((r) => ({ ...r }));
      },
      async findOne({ filter = {}, filterByTk } = {}) {
        const eff = filterByTk !== undefined ? { id: filterByTk, ...filter } : filter;
        return (await this.find({ filter: eff, limit: 1 }))[0] || null;
      },
      async count({ filter = {} } = {}) { return store[name].filter((r) => matchRow(r, filter)).length; },
      async create({ values }) {
        const id = values.id ?? seq[name]++;
        const now = new Date();
        const row = { id, createdAt: now, updatedAt: now, ...structuredClone(values) };
        store[name].push(row);
        return { ...row };
      },
      async update({ filter = {}, filterByTk, values }) {
        const eff = filterByTk !== undefined ? { id: filterByTk, ...filter } : filter;
        let updated = 0;
        for (const row of store[name]) {
          if (matchRow(row, eff)) { Object.assign(row, structuredClone(values), { updatedAt: new Date() }); updated += 1; }
        }
        return [updated];
      },
      async destroy({ filter = {}, filterByTk } = {}) {
        const eff = filterByTk !== undefined ? { id: filterByTk, ...filter } : filter;
        const before = store[name].length;
        store[name] = store[name].filter((r) => !matchRow(r, eff));
        return before - store[name].length;
      },
    };
  }
  return { store, getRepository: (name) => makeRepo(name) };
}

function collectNodes(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((item) => collectNodes(item, pred, out)); return out; }
  if (pred(node)) out.push(node);
  if (Array.isArray(node.children)) collectNodes(node.children, pred, out);
  return out;
}

function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && typeof node === 'object' && Array.isArray(node.children)) return textOf(node.children);
  return '';
}

function createQueuedReactHarness() {
  const statesByComponent = new WeakMap();
  const effectsByComponent = new WeakMap();
  const memosByComponent = new WeakMap();
  const callbacksByComponent = new WeakMap();
  const cleanups = [];
  let currentComponent = null;
  let [stateIdx, effectIdx, memoIdx, callbackIdx] = [0, 0, 0, 0];
  const pendingEffects = [];
  const getBucket = (map, comp) => { let arr = map.get(comp); if (!arr) { arr = []; map.set(comp, arr); } return arr; };
  const depsChanged = (p, n) => !p || !Array.isArray(n) || n.length !== p.length || n.some((d, i) => !Object.is(d, p[i]));

  const React = {
    Fragment: 'Fragment',
    createElement(type, props, ...children) {
      const flat = [];
      for (const c of children) if (Array.isArray(c)) flat.push(...c); else flat.push(c);
      const nextProps = { ...(props || {}) };
      if (flat.length === 1) nextProps.children = flat[0];
      else if (flat.length > 1) nextProps.children = flat;
      return { type, props: nextProps, children: flat };
    },
    useState(init) {
      const bucket = getBucket(statesByComponent, currentComponent);
      const idx = stateIdx++;
      if (bucket.length <= idx) bucket[idx] = { value: typeof init === 'function' ? init() : init, queue: [] };
      const slot = bucket[idx];
      while (slot.queue.length) { const next = slot.queue.shift(); slot.value = typeof next === 'function' ? next(slot.value) : next; }
      return [slot.value, (next) => { slot.queue.push(next); }];
    },
    useEffect(fn, deps) {
      const bucket = getBucket(effectsByComponent, currentComponent);
      const idx = effectIdx++;
      const prev = bucket[idx];
      if (!prev || depsChanged(prev.deps, deps)) {
        bucket[idx] = { deps: Array.isArray(deps) ? deps.slice() : null, cleanup: prev?.cleanup || null };
        pendingEffects.push({ entry: bucket[idx], fn });
      }
    },
    useCallback(fn, deps) {
      const bucket = getBucket(callbacksByComponent, currentComponent);
      const idx = callbackIdx++;
      const prev = bucket[idx];
      if (!prev || depsChanged(prev.deps, deps)) bucket[idx] = { deps: Array.isArray(deps) ? deps.slice() : null, fn };
      return bucket[idx].fn;
    },
    useMemo(fn, deps) {
      const bucket = getBucket(memosByComponent, currentComponent);
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
  async function flush(Root, props = {}) {
    let tree = null;
    for (let pass = 0; pass < 8; pass += 1) {
      tree = renderNode(React.createElement(Root, props));
      if (pendingEffects.length) {
        const batch = pendingEffects.splice(0, pendingEffects.length);
        for (const item of batch) {
          if (typeof item.entry.cleanup === 'function') item.entry.cleanup();
          const c = item.fn();
          item.entry.cleanup = typeof c === 'function' ? c : null;
          if (typeof c === 'function') cleanups.push(c);
        }
      }
      await new Promise((r) => setTimeout(r, 5));
      if (!pendingEffects.length && pass > 0) break;
    }
    return tree;
  }
  return { React, mountAndFlush: flush, flush, unmount: () => cleanups.splice(0).forEach((c) => { try { c(); } catch {} }) };
}

test('P0-07 Server ACL: ldx_employee and ldx_operator receive 403 on all read/dry-run automation endpoints while manager/admin succeed', async () => {
  const db = makeFlowDb({
    latticeAutomationRules: [{
      id: 1, organizationId: 'org-a', ruleKey: 'sec_rule', name: 'Sec Rule', active: true, schemaVersion: 2, publishedVersion: 1,
      graphJson: { version: 2, nodes: [{ id: 't1', type: 'trigger.manual', config: {} }], edges: [] },
    }],
    latticeAutomationRuns: [{
      id: 1, organizationId: 'org-a', ruleKey: 'sec_rule', runUid: 'run_sec_1', status: 'completed',
      triggerPayloadJson: { data: { code: 'X' } }, nodeStatesJson: {}, stepTracesJson: [],
    }],
  });
  const actions = createDxosAutomationsActions(db);
  const makeCtx = (userId, role, params = {}) => ({
    method: 'GET',
    state: { currentUser: { id: userId, username: role }, currentRole: role, organizationId: 'org-a' },
    action: { params: { organizationId: 'org-a', ...params } },
    query: {},
    request: { body: {} },
  });

  const guardedCalls = [
    ['listRules', {}],
    ['listRuleVersions', { ruleKey: 'sec_rule' }],
    ['testRule', { ruleKey: 'sec_rule' }],
    ['listRuns', {}],
    ['getRunTrace', { runUid: 'run_sec_1' }],
    ['nodeRegistry', {}],
    ['testNode', { ruleKey: 'sec_rule', nodeId: 't1' }],
    ['testNode', { ruleKey: 'sec_rule', nodeId: 't1', live: true }],
  ];

  for (const [userId, role] of [[23, 'ldx_employee'], [22, 'ldx_operator']]) {
    for (const [fnName, extra] of guardedCalls) {
      await assert.rejects(
        () => actions[fnName](makeCtx(userId, role, extra), async () => {}),
        (err) => err?.status === 403 && err?.code === 'FORBIDDEN',
        `Expected 403 for ${role} on ${fnName}`,
      );
    }
  }

  for (const [fnName, extra] of guardedCalls) {
    const ctx = makeCtx(21, 'ldx_manager', extra);
    await actions[fnName](ctx, async () => {});
    assert.ok(ctx.body && typeof ctx.body === 'object', `Expected ldx_manager to succeed on ${fnName}`);
  }
});

test('P0-07 Client Guards: FlowStudioApp & WorkflowConnectorsPage block ldx_employee via useUIConfigurationPermissions and HTTP 403 without firing unauthorized fetches', async () => {
  const { createFlowStudioApp } = require(path.join(PLUGIN_ROOT, 'src/client/flow/flow-studio-app.js'));
  const indexPath = path.join(PLUGIN_ROOT, 'src/client/index.js');

  // 1. UI permission denial short-circuits all fetches on both pages
  const harness = createQueuedReactHarness();
  const requests = [];
  const navigated = [];
  class MockPlugin { constructor(app) { this.app = app; } }
  const deniedClient = {
    Plugin: MockPlugin,
    useUIConfigurationPermissions: () => ({ allowAll: false, allowConfigUI: false }),
    useAPIClient: () => ({
      request: async (req) => { requests.push(req); return { data: { data: {} } }; },
    }),
  };

  const FlowDeniedApp = createFlowStudioApp(deniedClient, harness.React, {}, { router: { navigate: (p) => navigated.push(p) } });
  const flowDeniedTree = await harness.mountAndFlush(FlowDeniedApp, { selectedOrg: 'org-a' });
  assert.equal(collectNodes(flowDeniedTree, (n) => n.props?.['data-testid'] === 'dxos-flow-studio-forbidden').length, 1);
  assert.equal(requests.length, 0, 'Must not fire automation API calls when useUIConfigurationPermissions denies config UI');
  collectNodes(flowDeniedTree, (n) => n.props?.['data-testid'] === 'dxos-flow-studio-forbidden-back-btn')[0].props.onClick();
  assert.deepEqual(navigated, ['/admin/lattice-workspace']);
  harness.unmount();

  const origLoad = Module._load;
  Module._load = function mocked(req, parent, isMain) {
    if (req === '@nocobase/client') return deniedClient;
    if (req === 'react') return harness.React;
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
  const plugin = new mod.default({
    pluginSettingsManager: { add(k, o) { added.push({ k, o }); } },
    router: { navigate: (p) => navigated.push(p) },
  });
  await plugin.load();
  const connComp = added.find((x) => x.k === 'workflow.connectors').o.Component;
  const connDeniedTree = await harness.mountAndFlush(connComp, {});
  assert.equal(collectNodes(connDeniedTree, (n) => n.props?.['data-testid'] === 'dxos-workflow-connectors-forbidden').length, 1);
  assert.equal(requests.length, 0, 'WorkflowConnectorsPage must not fetch when uiDenied is true');
  harness.unmount();

  // 2. HTTP 403 fallback triggers forbidden card when useUIConfigurationPermissions is absent
  const h2 = createQueuedReactHarness();
  const client403 = {
    Plugin: MockPlugin,
    useAPIClient: () => ({
      request: async () => {
        const err = new Error('Forbidden');
        err.response = { status: 403 };
        throw err;
      },
    }),
  };
  const Flow403App = createFlowStudioApp(client403, h2.React, {}, {});
  const flow403Tree = await h2.mountAndFlush(Flow403App, { selectedOrg: 'org-a' });
  assert.equal(collectNodes(flow403Tree, (n) => n.props?.['data-testid'] === 'dxos-flow-studio-forbidden').length, 1);
  h2.unmount();
});

test('P1-08 control.loop durable suspend/resume handles multi-iteration, post-approval {{loop.item}}, multi-suspend, delay, rejected branch, nested loops, empty items, and halts', async () => {
  // 1. Multi-iteration with post-approval body using {{loop.item.sku}} + done_notify
  const db1 = makeFlowDb();
  const rule1 = {
    organizationId: 'org-a',
    ruleKey: 'loop_multi_post_body',
    schemaVersion: 2,
    graphJson: {
      version: 2,
      nodes: [
        { id: 't1', type: 'trigger.manual', config: {} },
        { id: 'lp1', type: 'control.loop', config: { itemsPath: 'data.items', maxIterations: 10 } },
        { id: 'ap_item', type: 'control.approval', config: { title: 'Duyệt {{loop.item.sku}}' } },
        { id: 'tkt_item', type: 'data.create', config: { collection: 'latticeServiceTickets', values: { code: 'OK-{{loop.item.sku}}-{{loop.index}}', name: '{{loop.item.sku}}' } } },
        { id: 'done_notify', type: 'notify.send', config: { roleNames: ['ldx_admin'], title: 'Done {{nodes.lp1.output.count}}' } },
      ],
      edges: [
        { id: 'e1', source: 't1', sourceHandle: 'main', target: 'lp1' },
        { id: 'e2', source: 'lp1', sourceHandle: 'item', target: 'ap_item' },
        { id: 'e3', source: 'ap_item', sourceHandle: 'approved', target: 'tkt_item' },
        { id: 'e4', source: 'lp1', sourceHandle: 'done', target: 'done_notify' },
      ],
    },
  };
  let run1 = await executeFlowGraph(db1, rule1, { organizationId: 'org-a', data: { items: [{ sku: 'S1' }, { sku: 'S2' }, { sku: 'S3' }] } });
  assert.equal(run1.status, 'suspended');
  assert.equal(run1.nodeStatesJson.loopCursor.currentIndex, 0);
  assert.equal(db1.store.latticeServiceTickets?.length || 0, 0);

  run1 = await resumeFlowRun(db1, { organizationId: 'org-a', runUid: run1.runUid, decision: 'approved', resumeToken: run1.resumeToken, actor: { userId: 21 } });
  assert.equal(run1.status, 'suspended');
  assert.equal(run1.nodeStatesJson.loopCursor.currentIndex, 1);
  assert.deepEqual(db1.store.latticeServiceTickets.map((x) => x.code), ['OK-S1-0']);
  assert.equal(db1.store.latticeNotifications?.length || 0, 0);

  run1 = await resumeFlowRun(db1, { organizationId: 'org-a', runUid: run1.runUid, decision: 'approved', resumeToken: run1.resumeToken, actor: { userId: 21 } });
  assert.equal(run1.status, 'suspended');
  assert.equal(run1.nodeStatesJson.loopCursor.currentIndex, 2);
  assert.deepEqual(db1.store.latticeServiceTickets.map((x) => x.code), ['OK-S1-0', 'OK-S2-1']);

  run1 = await resumeFlowRun(db1, { organizationId: 'org-a', runUid: run1.runUid, decision: 'approved', resumeToken: run1.resumeToken, actor: { userId: 21 } });
  assert.equal(run1.status, 'completed');
  assert.equal(run1.nodeStatesJson.loopCursor, undefined);
  assert.equal(run1.nodeStatesJson.loopCursors, undefined);
  assert.equal(run1.nodeStatesJson.ap_item?.status, 'completed', 'Loop body approval node must stay completed after loop resume');
  assert.equal(run1.nodeStatesJson.tkt_item?.status, 'completed', 'Loop body data node must stay completed after loop resume');
  assert.deepEqual(db1.store.latticeServiceTickets.map((x) => x.code), ['OK-S1-0', 'OK-S2-1', 'OK-S3-2']);
  assert.equal(run1.nodeStatesJson.lp1.output.results.length, 3);
  assert.equal(db1.store.latticeNotifications.length, 1);
  assert.equal(db1.store.latticeNotifications[0].title, 'Done 3');

  // 2. Two sequential approvals inside one iteration + rejected branch on 2nd item
  const db2 = makeFlowDb();
  const rule2 = {
    organizationId: 'org-a',
    ruleKey: 'loop_two_ap_seq',
    schemaVersion: 2,
    graphJson: {
      version: 2,
      nodes: [
        { id: 't1', type: 'trigger.manual', config: {} },
        { id: 'lp1', type: 'control.loop', config: { itemsPath: 'data.items', maxIterations: 5 } },
        { id: 'ap1', type: 'control.approval', config: { title: 'Step 1 {{loop.item.id}}' } },
        { id: 'ap2', type: 'control.approval', config: { title: 'Step 2 {{loop.item.id}}' } },
        { id: 'tkt_ok', type: 'data.create', config: { collection: 'latticeServiceTickets', values: { code: 'AP-{{loop.item.id}}' } } },
        { id: 'tkt_rej', type: 'data.create', config: { collection: 'latticeServiceTickets', values: { code: 'REJ-{{loop.item.id}}' } } },
        { id: 'done_notify', type: 'notify.send', config: { roleNames: ['ldx_admin'], title: 'SeqDone' } },
      ],
      edges: [
        { id: 'e1', source: 't1', sourceHandle: 'main', target: 'lp1' },
        { id: 'e2', source: 'lp1', sourceHandle: 'item', target: 'ap1' },
        { id: 'e3', source: 'ap1', sourceHandle: 'approved', target: 'ap2' },
        { id: 'e4', source: 'ap2', sourceHandle: 'approved', target: 'tkt_ok' },
        { id: 'e5', source: 'ap2', sourceHandle: 'rejected', target: 'tkt_rej' },
        { id: 'e6', source: 'lp1', sourceHandle: 'done', target: 'done_notify' },
      ],
    },
  };
  let r2 = await executeFlowGraph(db2, rule2, { organizationId: 'org-a', data: { items: [{ id: 'A' }, { id: 'B' }] } });
  assert.equal(r2.suspendedNodeId, 'ap1');
  r2 = await resumeFlowRun(db2, { organizationId: 'org-a', runUid: r2.runUid, decision: 'approved', resumeToken: r2.resumeToken, actor: { userId: 21 } });
  assert.equal(r2.suspendedNodeId, 'ap2');
  assert.equal(r2.nodeStatesJson.loopCursor.currentIndex, 0);
  r2 = await resumeFlowRun(db2, { organizationId: 'org-a', runUid: r2.runUid, decision: 'approved', resumeToken: r2.resumeToken, actor: { userId: 21 } });
  assert.equal(r2.suspendedNodeId, 'ap1');
  assert.equal(r2.nodeStatesJson.loopCursor.currentIndex, 1);
  r2 = await resumeFlowRun(db2, { organizationId: 'org-a', runUid: r2.runUid, decision: 'approved', resumeToken: r2.resumeToken, actor: { userId: 21 } });
  assert.equal(r2.suspendedNodeId, 'ap2');
  r2 = await resumeFlowRun(db2, { organizationId: 'org-a', runUid: r2.runUid, decision: 'rejected', resumeToken: r2.resumeToken, actor: { userId: 21 } });
  assert.equal(r2.status, 'completed');
  assert.equal(r2.nodeStatesJson.ap1?.status, 'completed');
  assert.equal(r2.nodeStatesJson.ap2?.status, 'completed');
  assert.equal(r2.nodeStatesJson.tkt_ok?.status, 'completed');
  assert.equal(r2.nodeStatesJson.tkt_rej?.status, 'completed');
  assert.deepEqual(db2.store.latticeServiceTickets.map((x) => x.code), ['AP-A', 'REJ-B']);
  assert.equal(db2.store.latticeNotifications.length, 1);

  // 3. control.delay inside loop resumed via tickDueDelayedRuns
  const db3 = makeFlowDb();
  const delayRule = {
    organizationId: 'org-a',
    ruleKey: 'loop_delay_rule',
    schemaVersion: 2,
    graphJson: {
      version: 2,
      nodes: [
        { id: 't1', type: 'trigger.manual', config: {} },
        { id: 'lp1', type: 'control.loop', config: { itemsPath: 'data.items', maxIterations: 5 } },
        { id: 'dl1', type: 'control.delay', config: { durationSec: 1 } },
        { id: 'tkt_dl', type: 'data.create', config: { collection: 'latticeServiceTickets', values: { code: 'DL-{{loop.item.n}}' } } },
        { id: 'done_dl', type: 'notify.send', config: { roleNames: ['ldx_admin'], title: 'DelayDone' } },
      ],
      edges: [
        { id: 'e1', source: 't1', sourceHandle: 'main', target: 'lp1' },
        { id: 'e2', source: 'lp1', sourceHandle: 'item', target: 'dl1' },
        { id: 'e3', source: 'dl1', sourceHandle: 'main', target: 'tkt_dl' },
        { id: 'e4', source: 'lp1', sourceHandle: 'done', target: 'done_dl' },
      ],
    },
  };
  const dlRun = await executeFlowGraph(db3, delayRule, { organizationId: 'org-a', data: { items: [{ n: 1 }, { n: 2 }] } });
  assert.equal(dlRun.status, 'suspended');
  await tickDueDelayedRuns(db3, { organizationId: 'org-a', now: new Date(Date.now() + 5000) });
  await tickDueDelayedRuns(db3, { organizationId: 'org-a', now: new Date(Date.now() + 10000) });
  const dlFinal = await db3.getRepository('latticeAutomationRuns').findOne({ filter: { runUid: dlRun.runUid } });
  assert.equal(dlFinal.status, 'completed');
  assert.deepEqual(db3.store.latticeServiceTickets.map((x) => x.code), ['DL-1', 'DL-2']);
  assert.equal(db3.store.latticeNotifications.length, 1);

  // 4. Nested control.loop (2x2 = 4 resumes)
  const db4 = makeFlowDb();
  const nestedRule = {
    organizationId: 'org-a',
    ruleKey: 'loop_nested_rule',
    schemaVersion: 2,
    graphJson: {
      version: 2,
      nodes: [
        { id: 't1', type: 'trigger.manual', config: {} },
        { id: 'lp_outer', type: 'control.loop', config: { itemsPath: 'data.outers', maxIterations: 5 } },
        { id: 'lp_inner', type: 'control.loop', config: { itemsPath: 'loop.item.inners', maxIterations: 5 } },
        { id: 'ap_in', type: 'control.approval', config: { title: 'Nested {{loop.item}}' } },
        { id: 'tkt_in', type: 'data.create', config: { collection: 'latticeServiceTickets', values: { code: 'N-{{loop.item}}' } } },
        { id: 'done_out', type: 'notify.send', config: { roleNames: ['ldx_admin'], title: 'NestedDone' } },
      ],
      edges: [
        { id: 'e1', source: 't1', sourceHandle: 'main', target: 'lp_outer' },
        { id: 'e2', source: 'lp_outer', sourceHandle: 'item', target: 'lp_inner' },
        { id: 'e3', source: 'lp_inner', sourceHandle: 'item', target: 'ap_in' },
        { id: 'e4', source: 'ap_in', sourceHandle: 'approved', target: 'tkt_in' },
        { id: 'e5', source: 'lp_outer', sourceHandle: 'done', target: 'done_out' },
      ],
    },
  };
  let nr = await executeFlowGraph(db4, nestedRule, { organizationId: 'org-a', data: { outers: [{ inners: ['A1', 'A2'] }, { inners: ['B1', 'B2'] }] } });
  assert.equal(nr.status, 'suspended');
  assert.equal(nr.nodeStatesJson.loopCursors.length, 2);
  for (let i = 0; i < 4; i += 1) {
    nr = await resumeFlowRun(db4, { organizationId: 'org-a', runUid: nr.runUid, decision: 'approved', resumeToken: nr.resumeToken, actor: { userId: 21 } });
  }
  assert.equal(nr.status, 'completed');
  assert.equal(nr.nodeStatesJson.lp_inner?.status, 'completed');
  assert.equal(nr.nodeStatesJson.ap_in?.status, 'completed');
  assert.equal(nr.nodeStatesJson.tkt_in?.status, 'completed');
  assert.deepEqual(db4.store.latticeServiceTickets.map((x) => x.code), ['N-A1', 'N-A2', 'N-B1', 'N-B2']);
  assert.equal(db4.store.latticeNotifications.length, 1);

  // 4b. Nested 2x2 non-suspending loop preserves inner results arrays in outer.output.results
  const db4b = makeFlowDb();
  const nestedSyncRule = {
    organizationId: 'org-a',
    ruleKey: 'loop_nested_sync_2x2',
    schemaVersion: 2,
    graphJson: {
      version: 2,
      nodes: [
        { id: 't1', type: 'trigger.manual', config: {} },
        { id: 'lp_outer', type: 'control.loop', config: { itemsPath: 'data.outers', maxIterations: 5 } },
        { id: 'lp_inner', type: 'control.loop', config: { itemsPath: 'loop.item.inners', maxIterations: 5 } },
        { id: 'leaf', type: 'logic.transform', config: { baseFromInput: false, operations: [{ op: 'set', target: 'val', value: '{{loop.item}}' }] } },
        { id: 'done_out', type: 'notify.send', config: { roleNames: ['ldx_admin'], title: 'SyncNestedDone' } },
      ],
      edges: [
        { id: 'e1', source: 't1', sourceHandle: 'main', target: 'lp_outer' },
        { id: 'e2', source: 'lp_outer', sourceHandle: 'item', target: 'lp_inner' },
        { id: 'e3', source: 'lp_inner', sourceHandle: 'item', target: 'leaf' },
        { id: 'e4', source: 'lp_outer', sourceHandle: 'done', target: 'done_out' },
      ],
    },
  };
  const syncNestedRun = await executeFlowGraph(db4b, nestedSyncRule, {
    organizationId: 'org-a',
    data: { outers: [{ inners: ['O0-I0', 'O0-I1'] }, { inners: ['O1-I0', 'O1-I1'] }] },
  });
  assert.equal(syncNestedRun.status, 'completed');
  assert.equal(syncNestedRun.nodeStatesJson.lp_outer.output.results.length, 2);
  assert.deepEqual(syncNestedRun.nodeStatesJson.lp_outer.output.results[0].results.map((x) => x.val), ['O0-I0', 'O0-I1']);
  assert.deepEqual(syncNestedRun.nodeStatesJson.lp_outer.output.results[1].results.map((x) => x.val), ['O1-I0', 'O1-I1']);

  // 4c. Nested 2x2 loop with 2 sequential control.approval suspends preserves full inner results arrays
  const db4c = makeFlowDb();
  const nestedTwoSuspRule = {
    organizationId: 'org-a',
    ruleKey: 'loop_nested_two_susp_2x2',
    schemaVersion: 2,
    graphJson: {
      version: 2,
      nodes: [
        { id: 't1', type: 'trigger.manual', config: {} },
        { id: 'lp_outer', type: 'control.loop', config: { itemsPath: 'data.outers', maxIterations: 5 } },
        { id: 'lp_inner', type: 'control.loop', config: { itemsPath: 'loop.item.inners', maxIterations: 5 } },
        { id: 'ap1', type: 'control.approval', config: { title: 'Gate1 {{loop.item}}' } },
        { id: 'ap2', type: 'control.approval', config: { title: 'Gate2 {{loop.item}}' } },
        { id: 'leaf', type: 'logic.transform', config: { baseFromInput: false, operations: [{ op: 'set', target: 'val', value: '{{loop.item}}' }] } },
        { id: 'done_out', type: 'notify.send', config: { roleNames: ['ldx_admin'], title: 'TwoSuspNestedDone' } },
      ],
      edges: [
        { id: 'e1', source: 't1', sourceHandle: 'main', target: 'lp_outer' },
        { id: 'e2', source: 'lp_outer', sourceHandle: 'item', target: 'lp_inner' },
        { id: 'e3', source: 'lp_inner', sourceHandle: 'item', target: 'ap1' },
        { id: 'e4', source: 'ap1', sourceHandle: 'approved', target: 'ap2' },
        { id: 'e5', source: 'ap2', sourceHandle: 'approved', target: 'leaf' },
        { id: 'e6', source: 'lp_outer', sourceHandle: 'done', target: 'done_out' },
      ],
    },
  };
  let n2r = await executeFlowGraph(db4c, nestedTwoSuspRule, {
    organizationId: 'org-a',
    data: { outers: [{ inners: ['O0-I0', 'O0-I1'] }, { inners: ['O1-I0', 'O1-I1'] }] },
  });
  for (let i = 0; i < 8; i += 1) {
    assert.equal(n2r.status, 'suspended');
    n2r = await resumeFlowRun(db4c, { organizationId: 'org-a', runUid: n2r.runUid, decision: 'approved', resumeToken: n2r.resumeToken, actor: { userId: 21 } });
  }
  assert.equal(n2r.status, 'completed');
  assert.equal(n2r.nodeStatesJson.lp_outer.output.results.length, 2);
  assert.deepEqual(n2r.nodeStatesJson.lp_outer.output.results[0].results.map((x) => x.val), ['O0-I0', 'O0-I1']);
  assert.deepEqual(n2r.nodeStatesJson.lp_outer.output.results[1].results.map((x) => x.val), ['O1-I0', 'O1-I1']);
  assert.equal(n2r.nodeStatesJson.ap1?.status, 'completed');
  assert.equal(n2r.nodeStatesJson.ap2?.status, 'completed');
  assert.equal(n2r.nodeStatesJson.leaf?.status, 'completed');

  // 5. Empty items completes immediately and fires done without suspending
  const db5 = makeFlowDb();
  const emptyRun = await executeFlowGraph(db5, rule1, { organizationId: 'org-a', data: { items: [] } });
  assert.equal(emptyRun.status, 'completed');
  assert.equal(db5.store.latticeNotifications.length, 1);
  assert.equal(db5.store.latticeNotifications[0].title, 'Done 0');
});

test('P1-09 control.merge first_completed is non-blocking across asymmetric and suspended branches and never re-fires on resume', async () => {
  // 1. Asymmetric branch depth (1 hop fast vs 3 hops slow) -> merge_first executes before slow_3
  const db1 = makeFlowDb();
  const asymRule = {
    organizationId: 'org-a',
    ruleKey: 'first_asym',
    schemaVersion: 2,
    graphJson: {
      version: 2,
      nodes: [
        { id: 't1', type: 'trigger.manual', config: {} },
        { id: 'par', type: 'control.parallel', config: {} },
        { id: 'fast', type: 'logic.transform', config: { baseFromInput: false, operations: [{ op: 'set', target: 'winner', value: 'fast' }] } },
        { id: 's1', type: 'logic.transform', config: { baseFromInput: false, operations: [{ op: 'set', target: 'step', value: 1 }] } },
        { id: 's2', type: 'logic.transform', config: { baseFromInput: false, operations: [{ op: 'set', target: 'step', value: 2 }] } },
        { id: 's3', type: 'logic.transform', config: { baseFromInput: false, operations: [{ op: 'set', target: 'step', value: 3 }] } },
        { id: 'm_first', type: 'control.merge', config: { mode: 'first_completed' } },
        { id: 'after_m', type: 'notify.send', config: { roleNames: ['ldx_admin'], title: 'Winner {{nodes.m_first.output.merged.winner}}' } },
      ],
      edges: [
        { id: 'e1', source: 't1', target: 'par' },
        { id: 'e2', source: 'par', target: 'fast' },
        { id: 'e3', source: 'par', target: 's1' },
        { id: 'e4', source: 's1', target: 's2' },
        { id: 'e5', source: 's2', target: 's3' },
        { id: 'e6', source: 'fast', target: 'm_first' },
        { id: 'e7', source: 's3', target: 'm_first' },
        { id: 'e8', source: 'm_first', target: 'after_m' },
      ],
    },
  };
  const r1 = await executeFlowGraph(db1, asymRule, { organizationId: 'org-a', data: {} });
  assert.equal(r1.status, 'completed');
  const order = r1.stepTracesJson.map((t) => t.nodeId);
  assert.ok(order.indexOf('m_first') < order.indexOf('s3'), `m_first must execute before slow branch s3 completes: ${order.join(' -> ')}`);
  assert.equal(order.filter((id) => id === 'm_first').length, 1, 'm_first must execute only once');
  assert.deepEqual(r1.nodeStatesJson.m_first.output.merged, { winner: 'fast' });
  assert.equal(db1.store.latticeNotifications.length, 1);
  assert.equal(db1.store.latticeNotifications[0].title, 'Winner fast');

  // 2. Slow branch suspends via control.approval; m_first completes first and NEVER re-fires when slow branch resumes
  const db2 = makeFlowDb();
  const suspRule = {
    organizationId: 'org-a',
    ruleKey: 'first_susp_slow',
    schemaVersion: 2,
    graphJson: {
      version: 2,
      nodes: [
        { id: 't1', type: 'trigger.manual', config: {} },
        { id: 'par', type: 'control.parallel', config: {} },
        { id: 'fast', type: 'logic.transform', config: { baseFromInput: false, operations: [{ op: 'set', target: 'winner', value: 'fast' }] } },
        { id: 's1', type: 'logic.transform', config: { baseFromInput: false, operations: [{ op: 'set', target: 'step', value: 1 }] } },
        { id: 'ap_slow', type: 'control.approval', config: { title: 'Slow Gate' } },
        { id: 'm_first', type: 'control.merge', config: { mode: 'first_completed' } },
        { id: 'after_m', type: 'notify.send', config: { roleNames: ['ldx_admin'], title: 'Merged {{nodes.m_first.output.merged.winner}}' } },
      ],
      edges: [
        { id: 'e1', source: 't1', target: 'par' },
        { id: 'e2', source: 'par', target: 'fast' },
        { id: 'e3', source: 'par', target: 's1' },
        { id: 'e4', source: 's1', target: 'ap_slow' },
        { id: 'e5', source: 'fast', target: 'm_first' },
        { id: 'e6', source: 'ap_slow', sourceHandle: 'approved', target: 'm_first' },
        { id: 'e7', source: 'm_first', target: 'after_m' },
      ],
    },
  };
  const sInit = await executeFlowGraph(db2, suspRule, { organizationId: 'org-a', data: {} });
  assert.equal(sInit.status, 'suspended');
  assert.equal(sInit.suspendedNodeId, 'ap_slow');
  assert.equal(sInit.nodeStatesJson.m_first.status, 'completed');
  assert.deepEqual(sInit.nodeStatesJson.m_first.output.merged, { winner: 'fast' });

  const sFinal = await resumeFlowRun(db2, { organizationId: 'org-a', runUid: sInit.runUid, decision: 'approved', resumeToken: sInit.resumeToken, actor: { userId: 21 } });
  assert.equal(sFinal.status, 'completed');
  assert.equal(sFinal.stepTracesJson.filter((t) => t.nodeId === 'm_first').length, 1, 'm_first must never re-fire after resume');
  assert.deepEqual(sFinal.nodeStatesJson.m_first.output.merged, { winner: 'fast' });
  assert.equal(db2.store.latticeNotifications.length, 1);
  assert.equal(db2.store.latticeNotifications[0].title, 'Merged fast');
});

test('P1-09 ai.agent schema exposes full runtime config fields, client visual builders sync JSON cleanly, and validator parity + Vietnamese server errors pass', async () => {
  // 1. ai.agent schema parity
  const reg = createDefaultRegistry();
  const agentDef = reg.getNodeType('ai.agent');
  const fNames = agentDef.inputSchema.fields.map((f) => f.name);
  for (const name of ['aiEmployee', 'model', 'temperature', 'maxTokens', 'enableMemory', 'toolName', 'mode', 'maxTurns', 'tools', 'outputSchema', 'memoryScope', 'systemPrompt']) {
    assert.ok(fNames.includes(name), `ai.agent missing schema field "${name}"`);
  }

  // 2. Server validator returns Vietnamese error messages while keeping error codes
  const twoTrigGraph = {
    version: 2,
    nodes: [
      { id: 't1', type: 'trigger.manual', config: {} },
      { id: 't2', type: 'trigger.event', config: { eventType: '*' } },
    ],
    edges: [],
  };
  const srvVal = validateFlowGraph(twoTrigGraph, { nodeRegistry: reg, requireTrigger: true });
  assert.equal(srvVal.ok, false);
  assert.equal(srvVal.errors[0].code, 'FLOW_TRIGGER_COUNT_INVALID');
  assert.match(srvVal.errors[0].message, /Chỉ được phép|Trigger/i);
  assert.equal(/At most 1 trigger/i.test(srvVal.errors[0].message), false);

  // 3. Client validator parity catches >1 trigger, >50 nodes, duplicate ID, incoming edge to trigger, invalid loop/subflow/cron
  const { validateFlowClient } = require(path.join(PLUGIN_ROOT, 'src/client/flow/flow-validation.js'));
  const cliVal = validateFlowClient(twoTrigGraph, reg.listNodeSchemas());
  assert.equal(cliVal.valid, false);
  assert.ok(cliVal.errors.some((e) => e.nodeId === 't2' && /Trigger/i.test(e.message)));

  const extraEdgeGraph = {
    version: 2,
    nodes: [
      { id: 't1', type: 'trigger.manual', config: {} },
      { id: 'lp1', type: 'control.loop', config: { itemsPath: 'data.items', maxIterations: 200 } },
      { id: 'sub1', type: 'control.subflow', config: { ruleKey: 'r', maxDepth: 99 } },
      { id: 'sch1', type: 'trigger.schedule', config: { cron: 'bad-cron' } },
    ],
    edges: [{ id: 'e1', source: 'lp1', sourceHandle: 'done', target: 't1' }],
  };
  const cliEdge = validateFlowClient(extraEdgeGraph, reg.listNodeSchemas());
  assert.equal(cliEdge.valid, false);
  assert.ok(cliEdge.byNodeId.lp1.some((e) => /1\.\.100/.test(e.message)));
  assert.ok(cliEdge.byNodeId.sub1.some((e) => /1\.\.8/.test(e.message)));
  assert.ok(cliEdge.byNodeId.sch1.some((e) => /cron/i.test(e.message)));
  assert.ok(cliEdge.byNodeId.t1.some((e) => /nhánh đầu vào/i.test(e.message)));

  // 4. Visual builders for control.if, control.switch, logic.transform + FlowCanvas dynamic switch ports
  const { VISUAL_FILTER_OPS } = require(path.join(PLUGIN_ROOT, 'src/client/flow-inspector-extras.js'));
  assert.equal(VISUAL_FILTER_OPS.some(([k]) => k === 'neq' || k === 'regex'), false, 'Must use strictly VALID_FILTER_OPERATORS');

  const { createFlowStudioApp } = require(path.join(PLUGIN_ROOT, 'src/client/flow/flow-studio-app.js'));
  const harness = createQueuedReactHarness();
  const nodeTypes = reg.listNodeSchemas();
  const visualRule = {
    ruleKey: 'visual_builders_rule',
    name: 'Visual Builders',
    active: true,
    graphJson: {
      version: 2,
      nodes: [
        { id: 't1', type: 'trigger.manual', config: {} },
        { id: 'if_1', type: 'control.if', config: { condition: { field: 'data.amount', op: 'gt', value: 100 } } },
        { id: 'sw_1', type: 'control.switch', config: { expression: 'data.tier', cases: [{ port: 'case_0', operator: 'eq', equals: 'gold' }] } },
        { id: 'tr_1', type: 'logic.transform', config: { baseFromInput: true, operations: [{ op: 'set', target: 'tag', value: 'ok' }] } },
      ],
      edges: [
        { id: 'e1', source: 't1', sourceHandle: 'main', target: 'if_1' },
        { id: 'e2', source: 'if_1', sourceHandle: 'true', target: 'sw_1' },
        { id: 'e3', source: 'sw_1', sourceHandle: 'case_0', target: 'tr_1' },
      ],
    },
  };
  const client = {
    useAPIClient: () => ({
      request: async (req) => {
        if (req.url === 'dxosAutomations:builderCatalog') return { data: { data: { nodeTypes, blueprints: [] } } };
        if (req.url === 'dxosAutomations:nodeRegistry') return { data: { data: { nodeTypes } } };
        if (req.url === 'dxosAutomations:listRules') return { data: { data: { items: [visualRule] } } };
        if (req.url === 'dxosAutomations:listRuns') return { data: { data: { items: [] } } };
        return { data: { data: {} } };
      },
    }),
  };
  const App = createFlowStudioApp(client, harness.React, {}, {});
  let tree = await harness.mountAndFlush(App, { selectedOrg: 'org-a', ruleKey: visualRule.ruleKey });

  // control.if visual builder + synced JSON textarea
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-node-if_1')[0].props.onClick({ stopPropagation() {} });
  tree = await harness.flush(App, { selectedOrg: 'org-a', ruleKey: visualRule.ruleKey });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-if-builder').length, 1);
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-field-condition').length, 1);
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-if-add')[0].props.onClick();
  tree = await harness.flush(App, { selectedOrg: 'org-a', ruleKey: visualRule.ruleKey });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-if-combinator')[0].props.onChange({ target: { value: 'or' } });
  tree = await harness.flush(App, { selectedOrg: 'org-a', ruleKey: visualRule.ruleKey });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-if-field-1')[0].props.onChange({ target: { value: 'data.vip' } });
  tree = await harness.flush(App, { selectedOrg: 'org-a', ruleKey: visualRule.ruleKey });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-if-value-1')[0].props.onChange({ target: { value: 'true' } });
  tree = await harness.flush(App, { selectedOrg: 'org-a', ruleKey: visualRule.ruleKey });
  const syncedCond = JSON.parse(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-field-condition')[0].props.value);
  assert.equal(Array.isArray(syncedCond.$or), true);
  assert.equal(syncedCond.$or[1].field, 'data.vip');
  assert.equal(syncedCond.$or[1].value, true);

  // control.switch visual builder + custom port rendered on FlowCanvas
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-node-sw_1')[0].props.onClick({ stopPropagation() {} });
  tree = await harness.flush(App, { selectedOrg: 'org-a', ruleKey: visualRule.ruleKey });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-switch-builder').length, 1);
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-switch-add')[0].props.onClick();
  tree = await harness.flush(App, { selectedOrg: 'org-a', ruleKey: visualRule.ruleKey });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-switch-port-1')[0].props.onChange({ target: { value: 'vip_tier' } });
  tree = await harness.flush(App, { selectedOrg: 'org-a', ruleKey: visualRule.ruleKey });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-node-append-sw_1')[0].props.onClick({ stopPropagation() {} });
  tree = await harness.flush(App, { selectedOrg: 'org-a', ruleKey: visualRule.ruleKey });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-node-append-sw_1-vip_tier').length, 1);

  // logic.transform visual builder + synced JSON textarea
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-node-tr_1')[0].props.onClick({ stopPropagation() {} });
  tree = await harness.flush(App, { selectedOrg: 'org-a', ruleKey: visualRule.ruleKey });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-transform-builder').length, 1);
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-transform-add')[0].props.onClick();
  tree = await harness.flush(App, { selectedOrg: 'org-a', ruleKey: visualRule.ruleKey });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-transform-op-1')[0].props.onChange({ target: { value: 'math' } });
  tree = await harness.flush(App, { selectedOrg: 'org-a', ruleKey: visualRule.ruleKey });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-transform-target-1')[0].props.onChange({ target: { value: 'total' } });
  tree = await harness.flush(App, { selectedOrg: 'org-a', ruleKey: visualRule.ruleKey });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-transform-left-1')[0].props.onChange({ target: { value: '10' } });
  tree = await harness.flush(App, { selectedOrg: 'org-a', ruleKey: visualRule.ruleKey });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-transform-right-1')[0].props.onChange({ target: { value: '5' } });
  tree = await harness.flush(App, { selectedOrg: 'org-a', ruleKey: visualRule.ruleKey });
  const syncedOps = JSON.parse(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-field-operations')[0].props.value);
  assert.equal(syncedOps[1].op, 'math');
  assert.equal(syncedOps[1].target, 'total');
  assert.equal(syncedOps[1].left, 10);
  assert.equal(syncedOps[1].right, 5);
  harness.unmount();
});

test('P2-08 Cron timezone: saveRule, publishRule, and toggleRule compute nextRunAt using Asia/Ho_Chi_Minh timezone and strip stale cron on republish', async () => {
  const db = makeFlowDb();
  const actions = createDxosAutomationsActions(db);
  const makeAdminCtx = (params) => ({
    method: 'POST',
    state: { currentUser: { id: 20, username: 'admin' }, currentRole: 'ldx_admin', organizationId: 'org-a' },
    action: { params: { organizationId: 'org-a', ...params } },
    query: {},
    request: { body: {} },
  });

  const graph8am = {
    version: 2,
    nodes: [
      { id: 't1', type: 'trigger.schedule', config: { cron: '0 8 * * *', timezone: 'Asia/Ho_Chi_Minh' } },
      { id: 'n1', type: 'notify.send', config: { roleNames: ['ldx_admin'], title: 'Daily 8AM' } },
    ],
    edges: [{ id: 'e1', source: 't1', sourceHandle: 'main', target: 'n1' }],
  };

  const saveCtx = makeAdminCtx({ ruleKey: 'tz_cron_rule', name: 'TZ Cron Rule', schemaVersion: 2, active: true, graphJson: graph8am });
  await actions.saveRule(saveCtx, async () => {});
  assert.equal(new Date(saveCtx.body.rule.nextRunAt).getUTCHours(), 1, '08:00 Asia/Ho_Chi_Minh must be 01:00 UTC on saveRule');

  const offCtx = makeAdminCtx({ ruleKey: 'tz_cron_rule', active: false });
  await actions.toggleRule(offCtx, async () => {});
  assert.equal(offCtx.body.rule.nextRunAt, null);

  const onCtx = makeAdminCtx({ ruleKey: 'tz_cron_rule', active: true });
  await actions.toggleRule(onCtx, async () => {});
  assert.equal(new Date(onCtx.body.rule.nextRunAt).getUTCHours(), 1, '08:00 Asia/Ho_Chi_Minh must be 01:00 UTC on toggleRule');

  const graph10am = {
    ...graph8am,
    nodes: [
      { id: 't1', type: 'trigger.schedule', config: { cron: '0 10 * * *', timezone: 'Asia/Ho_Chi_Minh' } },
      graph8am.nodes[1],
    ],
  };
  const pubCtx = makeAdminCtx({ ruleKey: 'tz_cron_rule', draftGraphJson: graph10am, active: true });
  await actions.publishRule(pubCtx, async () => {});
  assert.equal(pubCtx.body.rule.cronExpression, '0 10 * * *');
  assert.equal(new Date(pubCtx.body.rule.nextRunAt).getUTCHours(), 3, '10:00 Asia/Ho_Chi_Minh must be 03:00 UTC after publishRule strips stale cron');

  // Republishing scheduled rule as non-schedule (trigger.manual) clears stale cronExpression & nextRunAt
  const manualGraph = {
    version: 2,
    nodes: [
      { id: 't1', type: 'trigger.manual', config: {} },
      { id: 'n1', type: 'notify.send', config: { roleNames: ['ldx_admin'], title: 'Manual Now' } },
    ],
    edges: [{ id: 'e1', source: 't1', sourceHandle: 'main', target: 'n1' }],
  };
  const nonSchedPubCtx = makeAdminCtx({ ruleKey: 'tz_cron_rule', draftGraphJson: manualGraph, active: true });
  await actions.publishRule(nonSchedPubCtx, async () => {});
  assert.equal(nonSchedPubCtx.body.rule.cronExpression, null, 'Republishing as trigger.manual must clear cronExpression');
  assert.equal(nonSchedPubCtx.body.rule.nextRunAt, null, 'Republishing as trigger.manual must clear nextRunAt');
});

test('P0-07 / P1-09 Remediation regressions: delegatedFromUserId, switch custom port parity, and CSV typing draft preservation', async () => {
  // 1. P0-07 delegatedFromUserId is populated on delegated control.approval resume
  const nowMs = Date.now();
  const dbDlg = makeFlowDb({
    latticeDelegations: [{
      delegationUid: 'dlg-flow-m6',
      organizationId: 'org-a',
      delegatorUserId: 21,
      delegateUserId: 23,
      roleName: 'ldx_manager',
      scopeCollection: 'latticeAutomationRuns',
      status: 'active',
      active: true,
      startsAt: new Date(nowMs - 60_000).toISOString(),
      endsAt: new Date(nowMs + 3_600_000).toISOString(),
    }],
  });
  const dlgRule = {
    organizationId: 'org-a',
    ruleKey: 'dlg_prop_rule',
    schemaVersion: 2,
    graphJson: {
      version: 2,
      nodes: [
        { id: 't1', type: 'trigger.manual', config: {} },
        { id: 'ap1', type: 'control.approval', config: { approverRole: 'ldx_manager', title: 'Delegated Check' } },
      ],
      edges: [{ id: 'e1', source: 't1', sourceHandle: 'main', target: 'ap1' }],
    },
  };
  const suspDlg = await executeFlowGraph(dbDlg, dlgRule, { organizationId: 'org-a', data: {} });
  assert.equal(suspDlg.status, 'suspended');
  const resDlg = await resumeFlowRun(dbDlg, {
    organizationId: 'org-a',
    runUid: suspDlg.runUid,
    decision: 'approved',
    resumeToken: suspDlg.resumeToken,
    actor: { userId: 23, username: 'emp_23', roleNames: ['ldx_employee'] },
  });
  assert.equal(resDlg.status, 'completed');
  assert.equal(resDlg.nodeStatesJson.ap1.output.delegatedFromUserId, 21);
  assert.equal(resDlg.nodeStatesJson.ap1.output.delegationUid, 'dlg-flow-m6');

  // 2. P1-09 Client/server validator parity on control.switch custom & empty cases
  const reg = createDefaultRegistry();
  const nodeTypes = reg.listNodeSchemas();
  const { validateFlowClient } = require(path.join(PLUGIN_ROOT, 'src/client/flow/flow-validation.js'));
  const customSwitchGraph = {
    version: 2,
    nodes: [
      { id: 't1', type: 'trigger.manual', config: {} },
      { id: 'sw1', type: 'control.switch', config: { expression: 'data.tier', cases: [{ port: 'vip', operator: 'eq', equals: 1 }] } },
      { id: 'n1', type: 'notify.send', config: { roleNames: ['ldx_admin'], title: 'Hi' } },
    ],
    edges: [{ id: 'e1', source: 't1', sourceHandle: 'main', target: 'sw1' }, { id: 'e2', source: 'sw1', sourceHandle: 'case_2', target: 'n1' }],
  };
  assert.equal(validateFlowGraph(customSwitchGraph, { nodeRegistry: reg, requireTrigger: true }).ok, false);
  assert.equal(validateFlowClient(customSwitchGraph, nodeTypes).valid, false, 'Client must reject removed default port case_2 when custom cases are configured');

  const emptyCasesSwitchGraph = {
    version: 2,
    nodes: [
      { id: 't1', type: 'trigger.manual', config: {} },
      { id: 'sw1', type: 'control.switch', config: { expression: 'data.tier', cases: [] } },
      { id: 'n1', type: 'notify.send', config: { roleNames: ['ldx_admin'], title: 'Hi' } },
    ],
    edges: [{ id: 'e1', source: 't1', sourceHandle: 'main', target: 'sw1' }, { id: 'e2', source: 'sw1', sourceHandle: 'case_0', target: 'n1' }],
  };
  assert.equal(validateFlowGraph(emptyCasesSwitchGraph, { nodeRegistry: reg, requireTrigger: true }).ok, false);
  assert.equal(validateFlowClient(emptyCasesSwitchGraph, nodeTypes).valid, false, 'Client must reject case_0 when cases is empty []');

  // 3. P1-09 Controlled CSV inputs preserve trailing commas & spaces during character-by-character typing
  const { createFlowStudioApp } = require(path.join(PLUGIN_ROOT, 'src/client/flow/flow-studio-app.js'));
  const harness = createQueuedReactHarness();
  const csvRule = {
    ruleKey: 'csv_typing_rule',
    name: 'CSV Typing',
    active: true,
    graphJson: {
      version: 2,
      nodes: [
        { id: 't1', type: 'trigger.manual', config: {} },
        { id: 'if_1', type: 'control.if', config: { condition: { field: 'data.tag', op: 'in', value: [] } } },
        { id: 'sw_1', type: 'control.switch', config: { expression: 'data.tier', cases: [{ port: 'case_0', operator: 'nin', equals: [] }] } },
        {
          id: 'tr_1',
          type: 'logic.transform',
          config: {
            baseFromInput: true,
            operations: [
              { op: 'concat', target: 'joined', parts: [], separator: '-' },
              { op: 'pick', keys: [] },
              { op: 'omit', keys: [] },
            ],
          },
        },
      ],
      edges: [
        { id: 'e1', source: 't1', sourceHandle: 'main', target: 'if_1' },
        { id: 'e2', source: 'if_1', sourceHandle: 'true', target: 'sw_1' },
        { id: 'e3', source: 'sw_1', sourceHandle: 'case_0', target: 'tr_1' },
      ],
    },
  };
  const csvClient = {
    useAPIClient: () => ({
      request: async (req) => {
        if (req.url === 'dxosAutomations:builderCatalog') return { data: { data: { nodeTypes, blueprints: [] } } };
        if (req.url === 'dxosAutomations:nodeRegistry') return { data: { data: { nodeTypes } } };
        if (req.url === 'dxosAutomations:listRules') return { data: { data: { items: [csvRule] } } };
        if (req.url === 'dxosAutomations:listRuns') return { data: { data: { items: [] } } };
        return { data: { data: {} } };
      },
    }),
  };
  const CsvApp = createFlowStudioApp(csvClient, harness.React, {}, {});
  let tree = await harness.mountAndFlush(CsvApp, { selectedOrg: 'org-a', ruleKey: csvRule.ruleKey });
  const typeCsvSequence = async (nodeId, inputTestId, jsonFieldTestId, extractArr) => {
    collectNodes(tree, (n) => n.props?.['data-testid'] === `dxos-flow-node-${nodeId}`)[0].props.onClick({ stopPropagation() {} });
    tree = await harness.flush(CsvApp, { selectedOrg: 'org-a', ruleKey: csvRule.ruleKey });
    for (const ch of ['a', 'a,', 'a, ', 'a, b']) {
      collectNodes(tree, (n) => n.props?.['data-testid'] === inputTestId)[0].props.onChange({ target: { value: ch } });
      tree = await harness.flush(CsvApp, { selectedOrg: 'org-a', ruleKey: csvRule.ruleKey });
      assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === inputTestId)[0].props.value, ch, `${inputTestId} must preserve "${ch}"`);
    }
    const compiled = JSON.parse(collectNodes(tree, (n) => n.props?.['data-testid'] === jsonFieldTestId)[0].props.value);
    assert.deepEqual(extractArr(compiled), ['a', 'b'], `${inputTestId} must compile ['a', 'b']`);
  };
  await typeCsvSequence('if_1', 'dxos-flow-if-value-0', 'dxos-flow-field-condition', (c) => c.value);
  await typeCsvSequence('sw_1', 'dxos-flow-switch-value-0', 'dxos-flow-field-cases', (c) => c[0].equals);
  await typeCsvSequence('tr_1', 'dxos-flow-transform-parts-0', 'dxos-flow-field-operations', (o) => o[0].parts);
  await typeCsvSequence('tr_1', 'dxos-flow-transform-keys-1', 'dxos-flow-field-operations', (o) => o[1].keys);
  await typeCsvSequence('tr_1', 'dxos-flow-transform-keys-2', 'dxos-flow-field-operations', (o) => o[2].keys);
  harness.unmount();
});

test('M6 new and modified flow files satisfy line budgets, SPDX headers, and zero forbidden terms', async () => {
  const { addSourceHeader } = await import(pathToFileURL(path.resolve(__dirname, '../../../../scripts/source-headers.mjs')).href);
  const rootDir = path.resolve(__dirname, '../../../..');
  const checks = [
    ['plugins/nocobase/plugin-dxos-studio/src/server/flow/loop-resume.js', 200],
    ['plugins/nocobase/plugin-dxos-studio/src/server/flow/executor.js', 350],
    ['plugins/nocobase/plugin-dxos-studio/src/server/flow/validator.js', 350],
    ['plugins/nocobase/plugin-dxos-studio/src/server/flow/nodes/ai.js', 350],
    ['plugins/nocobase/plugin-dxos-studio/tests/m6-flow-hardening.test.cjs', null],
  ];
  const forbiddenRe = new RegExp(`\\b(?:cold-?chain|vaccine|vac-?xin|mkt|cmms|freezer|lotCode|${FORBIDDEN_WORD})\\b|\\beval\\s*\\(|new\\s+Function`, 'i');
  for (const [rel, cap] of checks) {
    const src = fs.readFileSync(path.join(rootDir, rel), 'utf8');
    if (cap) {
      const lines = src.split(/\r?\n/).length;
      assert.ok(lines <= cap, `${rel} exceeds ${cap} lines (got ${lines})`);
    }
    if (!rel.endsWith('.test.cjs')) {
      assert.equal(forbiddenRe.test(src), false, `Forbidden term found in ${rel}`);
    }
    assert.equal(addSourceHeader(src, rel).status, 'present', `Missing SPDX header in ${rel}`);
  }
});
