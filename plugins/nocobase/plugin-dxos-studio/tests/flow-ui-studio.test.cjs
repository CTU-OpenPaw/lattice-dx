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
const { existsSync, readdirSync, readFileSync } = require('node:fs');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const FORBIDDEN_WORD = `${'co'}${'pilot'}`;

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
  let stateIdx = 0;
  let effectIdx = 0;
  let memoIdx = 0;
  let callbackIdx = 0;
  let pendingUpdates = 0;
  const pendingEffects = [];

  function getBucket(map, comp) {
    let arr = map.get(comp);
    if (!arr) { arr = []; map.set(comp, arr); }
    return arr;
  }

  function depsChanged(prevDeps, nextDeps) {
    if (!prevDeps || !Array.isArray(nextDeps) || nextDeps.length !== prevDeps.length) return true;
    return nextDeps.some((d, i) => !Object.is(d, prevDeps[i]));
  }

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
      const setState = (next) => { slot.queue.push(next); pendingUpdates += 1; };
      return [slot.value, setState];
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

  async function flush(ComponentFn, props = {}) {
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
    render: (ComponentFn, props = {}) => { pendingUpdates = 0; return renderNode(React.createElement(ComponentFn, props)); },
    mountAndFlush: flush,
    flush,
    unmount() {
      for (const entry of cleanups.splice(0, cleanups.length)) {
        if (typeof entry.cleanup === 'function') entry.cleanup();
        entry.cleanup = null;
      }
    },
  };
}

function createApiMock(handlers) {
  const requests = [];
  const client = {
    useAPIClient: () => ({
      async request(req) {
        requests.push({ url: req.url, method: (req.method || 'get').toLowerCase(), params: req.params || null, data: req.data || null });
        const key = `${(req.method || 'get').toLowerCase()} ${req.url}`;
        const fn = handlers[key] || handlers[req.url];
        if (!fn) return { data: { data: {} } };
        return { data: { data: await fn(req) } };
      },
    }),
  };
  return { client, requests };
}

function createMockXyflow() {
  const Position = { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' };
  const fakeInstance = { zoomInCalls: 0, zoomOutCalls: 0, fitViewCalls: 0, zoomIn() { this.zoomInCalls += 1; }, zoomOut() { this.zoomOutCalls += 1; }, fitView() { this.fitViewCalls += 1; } };
  function ReactFlow(props) {
    const { nodes = [], edges = [], nodeTypes = {}, edgeTypes = {}, children } = props;
    const NodeComp = nodeTypes.dxosNode;
    const EdgeComp = edgeTypes.dxosEdge;
    return {
      type: 'div',
      props: { 'data-testid': 'dxos-mock-xyflow', 'data-rf-props': props, 'data-rf-instance': fakeInstance },
      children: [
        ...nodes.map((n) => (NodeComp ? NodeComp({ id: n.id, data: n.data, selected: n.selected }) : null)),
        ...edges.map((e) => (EdgeComp ? EdgeComp({ id: e.id, source: e.source, sourceHandle: e.sourceHandle, target: e.target, targetHandle: e.targetHandle, label: e.label, animated: e.animated, style: e.style, data: e.data, sourceX: 0, sourceY: 0, targetX: 200, targetY: 0 }) : null)),
        ...(Array.isArray(children) ? children : [children]).filter(Boolean),
      ],
    };
  }
  return {
    fakeInstance,
    ReactFlow,
    Background: () => ({ type: 'div', props: { 'data-testid': 'rf-background' }, children: [] }),
    MiniMap: () => ({ type: 'div', props: { 'data-testid': 'rf-minimap' }, children: [] }),
    Handle: (p) => ({ type: 'div', props: p, children: [] }),
    BaseEdge: (p) => ({ type: 'path', props: p, children: [] }),
    EdgeLabelRenderer: ({ children }) => ({ type: 'div', props: {}, children: Array.isArray(children) ? children : [children] }),
    getBezierPath: ({ sourceX, sourceY, targetX, targetY }) => [`M ${sourceX},${sourceY} L ${targetX},${targetY}`, (sourceX + targetX) / 2, (sourceY + targetY) / 2],
    Position,
  };
}

const getRegistrySchemas = () => require(path.join(PLUGIN_ROOT, 'src/server/flow/registry.js')).listNodeSchemas();
const getBlueprints = () => require(path.join(PLUGIN_ROOT, 'src/server/flow/blueprints/index.js')).listFlowBlueprints();

test('flow/* modules obey strict per-file line limits, SPDX header, zero forbidden branding, no architect-drawer.js, and security constraints', () => {
  const flowDir = path.join(PLUGIN_ROOT, 'src/client/flow');
  const flowFiles = readdirSync(flowDir).filter((f) => f.endsWith('.js'));
  assert.equal(existsSync(path.join(flowDir, 'architect-drawer.js')), false, 'architect-drawer.js must be deleted');
  assert.ok(flowFiles.includes('flow-list-view.js'), 'flow-list-view.js must exist');
  assert.ok(flowFiles.includes('flow-studio-app.js'), 'flow-studio-app.js must exist');
  assert.ok(flowFiles.includes('flow-dsl.js'), 'flow-dsl.js must exist');
  assert.equal(flowFiles.length, 8, 'flow/ directory must contain vendor-shims + 7 modular UI files');

  const budgets = {
    'flow-list-view.js': 280,
    'node-palette.js': 240,
    'node-inspector.js': 345,
    'playback-bar.js': 260,
    'flow-canvas.js': 350,
    'flow-studio-app.js': 350,
    'flow-dsl.js': 250,
    'vendor-shims.js': 120,
  };

  const clientFiles = [
    ...flowFiles.map((f) => path.join(flowDir, f)),
    path.join(PLUGIN_ROOT, 'src/client/index.js'),
    path.join(PLUGIN_ROOT, 'src/client/builder-broker-panels.js'),
  ];

  for (const filePath of clientFiles) {
    const src = readFileSync(filePath, 'utf8');
    assert.ok(src.includes('SPDX-License-Identifier: Apache-2.0'), `Missing SPDX header in ${filePath}`);
    assert.equal(src.toLowerCase().includes(FORBIDDEN_WORD), false, `Forbidden branding found in ${filePath}`);
    if (!filePath.endsWith(`${path.sep}index.js`)) {
      assert.doesNotMatch(src, /require\(['"](?:react|antd|@nocobase\/client)['"]\)/, `Forbidden external require in ${filePath}`);
    }
    assert.doesNotMatch(src, /\blocalStorage\b|\bsessionStorage\b|dangerouslySetInnerHTML|\.innerHTML\b/, `Forbidden browser sink in ${filePath}`);
    assert.doesNotMatch(src, /\bReact\.useRef\b/, `Must not assume React.useRef exists in minimal harnesses (${filePath})`);
  }

  for (const f of flowFiles) {
    const lines = readFileSync(path.join(flowDir, f), 'utf8').split(/\r?\n/).length;
    const max = budgets[f] ?? 350;
    assert.ok(lines <= max, `src/client/flow/${f} must be <= ${max} lines (got ${lines})`);
  }

  assert.equal(existsSync(path.join(PLUGIN_ROOT, 'src', 'client', ['automation', 'studio', 'panel.js'].join('-'))), false);
});

test('src/client/index.js registers workflow.automation under Workflow, preserves dxos-studio, and adds /admin/settings/dxos-flow-studio alias', async () => {
  const Module = require('node:module');
  const indexPath = path.join(PLUGIN_ROOT, 'src/client/index.js');
  const harness = createQueuedReactHarness();
  class MockPlugin { constructor(app) { this.app = app; } }
  const mockClient = { Plugin: MockPlugin, useAPIClient: () => ({ request: async () => ({ data: { data: {} } }) }) };

  const origLoad = Module._load;
  Module._load = function mocked(req, parent, isMain) {
    if (req === '@nocobase/client') return mockClient;
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
  const routesAdded = [];
  const plugin = new mod.default({
    pluginSettingsManager: { add(key, opts) { added.push({ key, opts }); } },
    router: { add(name, opts) { routesAdded.push({ name, opts }); } },
  });
  await plugin.load();

  const byKey = Object.fromEntries(added.map((x) => [x.key, x.opts]));
  assert.equal(byKey['dxos-flow-studio'], undefined, 'Must NOT register standalone dxos-flow-studio sidebar item');
  assert.ok(byKey['dxos-studio'], 'Must keep dxos-studio route');
  assert.equal(byKey['dxos-studio'].aclSnippet, 'pm');
  assert.ok(byKey['workflow.automation'], 'Must register workflow.automation under Workflow');
  assert.equal(byKey['workflow.automation'].title, 'Workflow Automation');
  assert.equal(byKey['workflow.automation'].icon, 'ApartmentOutlined');
  assert.equal(byKey['workflow.automation'].aclSnippet, 'pm');
  assert.equal(byKey['workflow.automation'].sort, 20);
  assert.equal(typeof byKey['workflow.automation'].Component, 'function');

  const aliasRoute = routesAdded.find((r) => r.name === 'admin.settings.dxos-flow-studio');
  assert.ok(aliasRoute, 'Must register backward-compatible router alias');
  assert.equal(aliasRoute.opts.path, '/admin/settings/dxos-flow-studio');
  assert.equal(aliasRoute.opts.Component, byKey['workflow.automation'].Component);

  const flowTree = await harness.mountAndFlush(byKey['workflow.automation'].Component, {});
  assert.equal(flowTree.props['data-testid'], 'dxos-flow-studio-app');
  assert.equal(flowTree.props.style.height, 'calc(100vh - 110px)');
  assert.equal(collectNodes(flowTree, (n) => n.props?.['data-testid'] === 'dxos-flow-list-view').length, 1);
});

test('Screen 1 FlowListView supports search, active/paused/HITL filters, HITL callout, 6 Blueprints gallery, 1-click n8n/Broker links, and List <-> Editor navigation', async () => {
  const { createFlowStudioApp } = require(path.join(PLUGIN_ROOT, 'src/client/flow/flow-studio-app.js'));
  const harness = createQueuedReactHarness();
  const nodeTypes = getRegistrySchemas();
  const blueprints = getBlueprints();
  const navigated = [];

  const rules = [
    { ...blueprints[0], active: true },
    { ...blueprints[3], active: false },
  ];
  const runs = [
    { id: 1, runUid: 'run-susp-1', ruleKey: blueprints[3].ruleKey, status: 'suspended', suspendedNodeId: 'approval_director', durationMs: 11, stepTracesJson: [] },
  ];

  const { client, requests } = createApiMock({
    'dxosAutomations:builderCatalog': async () => ({ nodeTypes, blueprints }),
    'dxosAutomations:nodeRegistry': async () => ({ nodeTypes }),
    'dxosAutomations:listRules': async () => ({ items: rules }),
    'dxosAutomations:listRuns': async () => ({ items: runs }),
    'dxosAutomations:runNow': async (req) => ({ run: { runUid: 'run-list-1', ruleKey: req.data.ruleKey, status: 'completed', durationMs: 8, stepTracesJson: [] } }),
  });

  const FlowStudioApp = createFlowStudioApp(client, harness.React, {}, { router: { navigate: (p) => navigated.push(p) } });
  let tree = await harness.mountAndFlush(FlowStudioApp, { selectedOrg: 'org-a' });

  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-list-view').length, 1);
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-list-header').length, 1);
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-canvas').length, 0);

  // 1-click n8n Vault and Broker links
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-goto-vault-btn')[0].props.onClick();
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-goto-broker-btn')[0].props.onClick();
  assert.deepEqual(navigated, ['/admin/settings/dxos-studio?tab=automation', '/admin/settings/dxos-studio?tab=broker']);

  // Status filter pills & search
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-filter-paused')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a' });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === `dxos-flow-list-card-${blueprints[0].ruleKey}`).length, 0);
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === `dxos-flow-list-card-${blueprints[3].ruleKey}`).length, 1);

  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-filter-hitl')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a' });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === `dxos-flow-list-card-${blueprints[3].ruleKey}`).length, 1);

  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-filter-all')[0].props.onClick();
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-list-search')[0].props.onChange({ target: { value: 'cold' } });
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a' });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === `dxos-flow-list-card-${blueprints[0].ruleKey}`).length, 1);
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === `dxos-flow-list-card-${blueprints[3].ruleKey}`).length, 0);

  // Clear search & run directly from List View
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-list-search')[0].props.onChange({ target: { value: '' } });
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a' });
  await collectNodes(tree, (n) => n.props?.['data-testid'] === `dxos-flow-list-run-${blueprints[0].ruleKey}`)[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a' });
  assert.ok(requests.some((r) => r.url === 'dxosAutomations:runNow' && r.data.ruleKey === blueprints[0].ruleKey));

  // Toggle 6-Blueprint gallery
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-blueprints-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a' });
  const gallery = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-blueprints-gallery')[0];
  assert.ok(gallery);
  assert.equal(collectNodes(gallery, (n) => String(n.props?.['data-testid'] || '').startsWith('dxos-flow-blueprint-load-')).length, 6);

  // Pending HITL callout opens suspended rule directly in Editor with HITL banner visible
  collectNodes(tree, (n) => n.props?.['data-testid'] === `dxos-flow-list-hitl-open-${blueprints[3].ruleKey}`)[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a' });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-list-view').length, 0);
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-canvas').length, 1);
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-hitl-banner').length, 1);

  // Back to List View
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-back-to-list-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a' });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-list-view').length, 1);
});

test('Screen 2 Canvas-First Editor: collapsed Palette/Inspector/MiniMap by default, Settings Popover, Mini-Toolbar, Edge Insert, Connect, Bottom Dock & Undo/Redo', async () => {
  const { createFlowStudioApp } = require(path.join(PLUGIN_ROOT, 'src/client/flow/flow-studio-app.js'));
  const harness = createQueuedReactHarness();
  const nodeTypes = getRegistrySchemas();
  const blueprints = getBlueprints();
  const mockXy = createMockXyflow();
  const feedbackCalls = [];

  const { client, requests } = createApiMock({
    'dxosAutomations:builderCatalog': async () => ({ nodeTypes, blueprints, collections: [{ name: 'latticeCustomWorkOrders', fields: ['code'] }] }),
    'dxosAutomations:nodeRegistry': async () => ({ nodeTypes }),
    'dxosAutomations:listRules': async () => ({ items: [] }),
    'dxosAutomations:listRuns': async () => ({ items: [] }),
    'dxosAutomations:testNode': async (req) => ({ result: { ok: true, nodeId: req.data.nodeId, status: 'completed', output: { quick: true }, nextPort: 'main', durationMs: 5 } }),
  });

  const FlowStudioApp = createFlowStudioApp(client, harness.React, {}, {});
  const appProps = { selectedOrg: 'org-a', initialView: 'editor', xyflowOverride: mockXy, setFeedback: (fb) => feedbackCalls.push(fb) };
  let tree = await harness.mountAndFlush(FlowStudioApp, appProps);

  // Default 100% Canvas: Palette collapsed, Inspector hidden, MiniMap hidden, Dock visible
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-mock-xyflow').length, 1);
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-toggle-palette-btn').length, 1);
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-palette').length, 0);
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-inspector').length, 0);
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'rf-minimap').length, 0);
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-canvas-dock').length, 1);
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-autolayout-btn').length, 1);
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-dryrun-btn').length, 1);

  // Toggle MiniMap from Bottom Dock
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-toggle-minimap-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, appProps);
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'rf-minimap').length, 1);

  // Open Settings Popover -> open Blueprints (6) -> load HITL procurement blueprint
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-settings-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, appProps);
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-settings-popover').length, 1);
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-blueprints-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, appProps);
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-blueprint-load-auto_procurement_hitl_approval')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, appProps);
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-node-approval_director').length, 1);
  assert.ok(textOf(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-node-preview-approval_director')[0]).includes('HITL'));

  const listCanvasNodes = (rootTree) => collectNodes(
    collectNodes(rootTree, (n) => n.props?.['data-testid'] === 'dxos-flow-canvas')[0],
    (n) => {
      const tid = String(n.props?.['data-testid'] || '');
      return tid.startsWith('dxos-flow-node-') && !tid.startsWith('dxos-flow-node-preview-') && !tid.startsWith('dxos-flow-node-mini-toolbar-') && !tid.startsWith('dxos-flow-node-quick-');
    },
  );
  const countCanvasNodes = (rootTree) => listCanvasNodes(rootTree).length;

  // Open Palette overlay, search, and add node -> auto-selects node -> Inspector & Mini-Toolbar appear
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-toggle-palette-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, appProps);
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-palette').length, 1);

  const nodesBeforeAdd = countCanvasNodes(tree);
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-palette-search')[0].props.onChange({ target: { value: 'data.create' } });
  tree = await harness.flush(FlowStudioApp, appProps);
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-palette-node-data.create')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, appProps);
  const nodesAfterAdd = countCanvasNodes(tree);
  assert.equal(nodesAfterAdd, nodesBeforeAdd + 1);
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-inspector').length, 1);

  // Close Palette & Inspector
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-palette-close-btn')[0].props.onClick();
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-inspector-close-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, appProps);
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-palette').length, 0);
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-inspector').length, 0);

  // Connect new node via XYFlow onConnect
  const addedNodeId = listCanvasNodes(tree).at(-1).props['data-testid'].replace('dxos-flow-node-', '');
  const rfMock = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-mock-xyflow')[0];
  rfMock.props['data-rf-props'].onConnect({ source: 'notify_operator_approved', sourceHandle: 'main', target: addedNodeId, targetHandle: 'in' });
  tree = await harness.flush(FlowStudioApp, appProps);
  assert.ok(collectNodes(tree, (n) => String(n.props?.['data-testid'] || '').startsWith('dxos-flow-edge-insert-')).length >= 7);

  // Contextual Mini-Toolbar on selected node: Duplicate -> Quick Test -> Delete
  collectNodes(tree, (n) => n.props?.['data-testid'] === `dxos-flow-node-${addedNodeId}`)[0].props.onClick({ stopPropagation() {} });
  tree = await harness.flush(FlowStudioApp, appProps);
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === `dxos-flow-node-mini-toolbar-${addedNodeId}`).length, 1);

  collectNodes(tree, (n) => n.props?.['data-testid'] === `dxos-flow-node-quick-dup-${addedNodeId}`)[0].props.onClick({ stopPropagation() {} });
  tree = await harness.flush(FlowStudioApp, appProps);
  assert.equal(countCanvasNodes(tree), nodesAfterAdd + 1);

  const dupNodeId = listCanvasNodes(tree).at(-1).props['data-testid'].replace('dxos-flow-node-', '');
  await collectNodes(tree, (n) => n.props?.['data-testid'] === `dxos-flow-node-quick-test-${dupNodeId}`)[0].props.onClick({ stopPropagation() {} });
  tree = await harness.flush(FlowStudioApp, appProps);
  assert.ok(requests.some((r) => r.url === 'dxosAutomations:testNode' && r.data.nodeId === dupNodeId));
  assert.ok(textOf(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-output-json')[0]).includes('"quick": true'));

  collectNodes(tree, (n) => n.props?.['data-testid'] === `dxos-flow-node-quick-del-${dupNodeId}`)[0].props.onClick({ stopPropagation() {} });
  tree = await harness.flush(FlowStudioApp, appProps);
  assert.equal(countCanvasNodes(tree), nodesAfterAdd);

  // Insert node between edge (`+` button) -> opens Palette Quick-Add mode -> click logic.dmn
  const insertBtn = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-edge-insert-e_trig_if')[0];
  insertBtn.props.onClick({ stopPropagation() {} });
  tree = await harness.flush(FlowStudioApp, appProps);
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-insert-picker').length, 1);
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-insert-node-logic.dmn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, appProps);
  const nodesAfterInsert = countCanvasNodes(tree);
  assert.equal(nodesAfterInsert, nodesAfterAdd + 1);

  // Auto-layout + Undo / Redo from Bottom Dock
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-autolayout-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, appProps);
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-undo-btn')[0].props.onClick();
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-undo-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, appProps);
  assert.equal(countCanvasNodes(tree), nodesAfterAdd);

  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-redo-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, appProps);
  assert.equal(countCanvasNodes(tree), nodesAfterInsert);
  assert.equal(feedbackCalls.some((f) => f?.type === 'error'), false);
});

test('NodeInspector preserves selection under React 18/19 queued batching, inserts {{var}} via Variable Picker, toggles Nâng cao, and executes Test This Node', async () => {
  const { createFlowStudioApp } = require(path.join(PLUGIN_ROOT, 'src/client/flow/flow-studio-app.js'));
  const harness = createQueuedReactHarness();
  const nodeTypes = getRegistrySchemas();
  const blueprints = getBlueprints();

  const { client, requests } = createApiMock({
    'dxosAutomations:builderCatalog': async () => ({
      llmConfigured: false, nodeTypes,
      eventTypes: [{ type: 'alarm.triggered', label: 'Alarm' }],
      dmnTables: [{ tableKey: 'cmms_priority_routing_v1', name: 'CMMS Routing', outputsJson: [{ name: 'workOrderPriority' }] }],
      collections: [{ name: 'latticeCustomWorkOrders', title: 'CMMS', fields: ['workOrderCode', 'title', 'priority'] }],
      roles: ['ldx_admin', 'ldx_manager', 'ldx_operator'],
      connectors: [{ connectorKey: 'n8n-coldchain-orchestrator', name: 'n8n', connectorType: 'n8n', authType: 'hmac' }],
      blueprints,
    }),
    'dxosAutomations:nodeRegistry': async () => ({ nodeTypes }),
    'dxosAutomations:listRules': async () => ({ items: [blueprints[0]] }),
    'dxosAutomations:listRuns': async () => ({ items: [] }),
    'dxosAutomations:testNode': async (req) => ({ result: { ok: true, nodeId: req.data.nodeId, status: 'completed', output: { notified: ['ldx_manager'], title: 'Tested OK' }, nextPort: 'main', durationMs: 11 } }),
  });

  const FlowStudioApp = createFlowStudioApp(client, harness.React, {}, {});
  let tree = await harness.mountAndFlush(FlowStudioApp, { selectedOrg: 'org-a', initialView: 'editor' });

  // Inspector hidden until node clicked
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-inspector').length, 0);

  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-node-notify_assigned')[0].props.onClick({ stopPropagation() {} });
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a', initialView: 'editor' });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-node-label-input')[0].props.value, 'Thông báo vai trò phụ trách');

  // Nâng cao collapsed by default -> toggle reveals Raw Config JSON
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-raw-config-json').length, 0);
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-inspector-advanced-toggle')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a', initialView: 'editor' });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-raw-config-json').length, 1);

  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-node-label-input')[0].props.onChange({ target: { value: 'Báo trực tiếp Quản lý' } });
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a', initialView: 'editor' });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-node-label-input')[0].props.value, 'Báo trực tiếp Quản lý');

  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-field-title')[0].props.onFocus();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a', initialView: 'editor' });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-var-picker-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a', initialView: 'editor' });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-var-chip-{{data.deviceKey}}')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a', initialView: 'editor' });
  assert.ok(String(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-field-title')[0].props.value).includes('{{data.deviceKey}}'));

  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-inspector-tab-input')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a', initialView: 'editor' });
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-test-node-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a', initialView: 'editor' });
  assert.equal(requests.find((r) => r.url === 'dxosAutomations:testNode')?.data.nodeId, 'notify_assigned');

  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-inspector-tab-output')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a', initialView: 'editor' });
  assert.ok(textOf(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-output-json')[0]).includes('Tested OK'));
});

test('PlaybackBar starts collapsed, renders HITL banner when suspended, auto-expands on Dry-Run, and supports VCR navigation & stepTraces fallback', async () => {
  const { createFlowStudioApp } = require(path.join(PLUGIN_ROOT, 'src/client/flow/flow-studio-app.js'));
  const harness = createQueuedReactHarness();
  const nodeTypes = getRegistrySchemas();
  const blueprints = getBlueprints();
  const hitlBp = blueprints.find((b) => b.ruleKey === 'auto_procurement_hitl_approval');

  let runs = [{
    id: 90, runUid: 'run-hitl-90', ruleKey: hitlBp.ruleKey, status: 'suspended', suspendedNodeId: 'approval_director', durationMs: 14,
    nodeStatesJson: { trig_request_create: { status: 'completed', durationMs: 2 }, if_over_50m: { status: 'completed', nextPort: 'true', durationMs: 3 }, approval_director: { status: 'suspended', suspend: { kind: 'approval', approverRole: 'ldx_manager', title: 'Approve > 50M' }, durationMs: 9 } },
    stepTracesJson: [{ nodeId: 'trig_request_create', type: 'trigger.record', label: 'Trigger', status: 'completed', durationMs: 2 }, { nodeId: 'if_over_50m', type: 'control.if', label: 'Over 50M?', status: 'completed', durationMs: 3 }, { nodeId: 'approval_director', type: 'control.approval', label: 'HITL Director', status: 'suspended', durationMs: 9 }],
  }];

  const { client, requests } = createApiMock({
    'dxosAutomations:builderCatalog': async () => ({ nodeTypes, blueprints }),
    'dxosAutomations:nodeRegistry': async () => ({ nodeTypes }),
    'dxosAutomations:listRules': async () => ({ items: [hitlBp] }),
    'dxosAutomations:listRuns': async () => ({ items: runs }),
    'dxosAutomations:testRule': async (req) => ({
      simulation: {
        runUid: 'dry-sim-1', ruleKey: req.data.rule.ruleKey, status: 'completed', durationMs: 12,
        nodeStatesJson: { trig_request_create: { status: 'completed', durationMs: 2 }, if_over_50m: { status: 'completed', nextPort: 'true', durationMs: 4 }, approval_director: { status: 'completed', durationMs: 6 }, notify_operator_standard: { status: 'skipped', reason: 'BRANCH_NOT_TAKEN' } },
        stepTraces: [{ nodeId: 'trig_request_create', type: 'trigger.record', status: 'completed', simulated: true, durationMs: 2 }, { nodeId: 'if_over_50m', type: 'control.if', status: 'completed', simulated: true, durationMs: 4 }, { nodeId: 'approval_director', type: 'control.approval', status: 'completed', simulated: true, durationMs: 6 }],
      },
    }),
    'dxosAutomations:resumeRun': async () => {
      const updated = { ...runs[0], status: 'completed', suspendedNodeId: null, durationMs: 24, nodeStatesJson: { ...runs[0].nodeStatesJson, approval_director: { status: 'completed', durationMs: 10 } }, stepTracesJson: [...runs[0].stepTracesJson.slice(0, 2), { nodeId: 'approval_director', type: 'control.approval', status: 'completed', durationMs: 10 }] };
      runs = [updated];
      return { run: updated };
    },
  });

  const FlowStudioApp = createFlowStudioApp(client, harness.React, {}, {});
  let tree = await harness.mountAndFlush(FlowStudioApp, { selectedOrg: 'org-a', initialView: 'editor' });

  // Collapsed by default, single Dry-Run button, prominent HITL banner
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-dryrun-btn').length, 1);
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-toggle-trace-btn')[0].props['aria-expanded'], false);
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-run-selector').length, 0);
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-hitl-banner').length, 1);

  // Approve HITL -> auto-expands trace drawer & clears HITL banner
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-hitl-approve-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a', initialView: 'editor' });
  assert.equal(requests.find((r) => r.url === 'dxosAutomations:resumeRun')?.data.decision, 'approved');
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-hitl-banner').length, 0);
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-toggle-trace-btn')[0].props['aria-expanded'], true);

  // Collapse manually, then Dry-Run auto-expands & supports stepTraces fallback
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-toggle-trace-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a', initialView: 'editor' });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-run-selector').length, 0);

  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-dryrun-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a', initialView: 'editor' });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-toggle-trace-btn')[0].props['aria-expanded'], true);
  assert.ok(textOf(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-step-badge')[0]).includes('Step 3/3'));
  assert.ok(textOf(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-node-notify_operator_standard')[0]).includes('skipped'));

  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-vcr-first-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a', initialView: 'editor' });
  assert.ok(textOf(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-step-badge')[0]).includes('Step 1/3'));
});

test('Native Agent Chat trigger (ai.triggerTask), window.__LATTICEDX_FLOW_CONTEXT__ sync, and latticedx:flow-updated live SSE canvas sync with cross-org guard', async () => {
  const { createFlowStudioApp } = require(path.join(PLUGIN_ROOT, 'src/client/flow/flow-studio-app.js'));
  const nodeTypes = getRegistrySchemas();
  const blueprints = getBlueprints();
  const triggeredTasks = [];
  const listeners = new Map();
  const origWin = globalThis.window;

  globalThis.window = {
    location: { search: '' },
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    dispatchEvent(evt) { for (const fn of listeners.get(evt?.type) || []) fn(evt); },
  };

  try {
    const harness = createQueuedReactHarness();
    let listRuleCalls = 0;
    const { client } = createApiMock({
      'dxosAutomations:builderCatalog': async () => ({ nodeTypes, blueprints }),
      'dxosAutomations:nodeRegistry': async () => ({ nodeTypes }),
      'dxosAutomations:listRules': async () => { listRuleCalls += 1; return { items: [blueprints[0]] }; },
      'dxosAutomations:listRuns': async () => ({ items: [] }),
    });

    const mockApp = { flowEngine: { context: { ai: { triggerTask: async (payload) => { triggeredTasks.push(payload); } } } } };
    const FlowStudioApp = createFlowStudioApp(client, harness.React, {}, mockApp);
    let tree = await harness.mountAndFlush(FlowStudioApp, { selectedOrg: 'org-a' });

    // Window context bridge reflects List View org
    assert.equal(globalThis.window.__LATTICEDX_FLOW_CONTEXT__?.organizationId, 'org-a');
    assert.equal(globalThis.window.__LATTICEDX_FLOW_CONTEXT__?.view, 'list');

    // Clicking AI button in List View triggers native Agent Chat with dxos-architect
    await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-list-ai-btn')[0].props.onClick();
    assert.equal(triggeredTasks.length, 1);
    assert.equal(triggeredTasks[0].aiEmployee, 'dxos-architect');
    assert.equal(triggeredTasks[0].auto, true);
    assert.equal(triggeredTasks[0].open, true);
    assert.equal(triggeredTasks[0].tasks[0].autoSend, false);
    assert.ok(triggeredTasks[0].tasks[0].message.system.includes('organizationId="org-a"'));

    // Cross-org SSE event MUST be ignored
    globalThis.window.dispatchEvent({
      type: 'latticedx:flow-updated',
      detail: {
        organizationId: 'org-evil',
        draftGraph: { version: 2, nodes: [{ id: 'evil_node', type: 'trigger.manual', label: 'Evil' }], edges: [] },
        message: 'Should be ignored',
      },
    });
    tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a' });
    assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-list-view').length, 1);
    assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-node-evil_node').length, 0);

    // Matching-org SSE event switches to Editor, applies undoable draftGraph, shows simulation & toast, and reloads on applied:true
    const callsBeforeApplied = listRuleCalls;
    globalThis.window.dispatchEvent({
      type: 'latticedx:flow-updated',
      detail: {
        organizationId: 'org-a',
        applied: true,
        ruleKey: 'ai_drafted_rule',
        draftRule: { ruleKey: 'ai_drafted_rule', name: 'AI Drafted Flow', cooldownSec: 45, maxDepth: 5 },
        draftGraph: {
          version: 2,
          nodes: [
            { id: 'ai_trig', type: 'trigger.manual', label: 'AI Trigger', position: { x: 80, y: 180 }, config: {} },
            { id: 'ai_notify', type: 'notify.send', label: 'AI Alert', position: { x: 360, y: 180 }, config: { roleNames: ['ldx_manager'], title: 'Synced' } },
          ],
          edges: [{ id: 'e_ai', source: 'ai_trig', sourceHandle: 'main', target: 'ai_notify', targetHandle: 'in' }],
        },
        simulation: {
          runUid: 'sim-sse-1', status: 'completed', durationMs: 9,
          stepTracesJson: [{ nodeId: 'ai_trig', status: 'completed', simulated: true, durationMs: 4 }, { nodeId: 'ai_notify', status: 'completed', simulated: true, durationMs: 5 }],
        },
        message: 'Đã đồng bộ luồng từ AI Architect.',
      },
    });
    tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a' });
    assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-canvas').length, 1);
    assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-node-ai_notify').length, 1);
    assert.ok(textOf(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-feedback')[0]).includes('Đã đồng bộ luồng từ AI Architect.'));
    assert.ok(textOf(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-step-badge')[0]).includes('Step 2/2'));
    assert.ok(listRuleCalls > callsBeforeApplied, 'applied: true must reload rules');
    assert.equal(globalThis.window.__LATTICEDX_FLOW_CONTEXT__?.ruleKey, 'ai_drafted_rule');
    assert.equal(globalThis.window.__LATTICEDX_FLOW_CONTEXT__?.view, 'editor');

    // Fallback toast when aiCtx.triggerTask is unavailable
    const h2 = createQueuedReactHarness();
    const fbList = [];
    const AppNoAi = createFlowStudioApp(client, h2.React, {}, {});
    const treeNoAi = await h2.mountAndFlush(AppNoAi, { selectedOrg: 'org-a', initialView: 'editor', setFeedback: (fb) => fbList.push(fb) });
    collectNodes(treeNoAi, (n) => n.props?.['data-testid'] === 'dxos-flow-open-architect-btn')[0].props.onClick();
    assert.ok(fbList.some((f) => f?.type === 'info' && f.text.includes('DX-OS Architect')));

    // Unmount cleans up window bridge & listeners
    harness.unmount();
    h2.unmount();
    assert.equal(globalThis.window.__LATTICEDX_FLOW_CONTEXT__, undefined);
  } finally {
    if (origWin === undefined) delete globalThis.window;
    else globalThis.window = origWin;
  }
});

test('JSON / YAML DSL modal blocks prototype pollution, imports valid JSON/YAML, preserves org/ruleKey/triggerEventType on Save, and drops stale org responses', async () => {
  const { createFlowStudioApp } = require(path.join(PLUGIN_ROOT, 'src/client/flow/flow-studio-app.js'));
  const harness = createQueuedReactHarness();
  const nodeTypes = getRegistrySchemas();
  let resolveSlowRuns = null;

  const { client, requests } = createApiMock({
    'dxosAutomations:builderCatalog': async (req) => {
      if (req.params?.organizationId === 'org-b') throw new Error('404 catalog');
      return { nodeTypes, blueprints: getBlueprints(), collections: [{ name: 'latticeCustomOrgA', fields: ['code'] }] };
    },
    'dxosAutomations:nodeRegistry': async () => ({ nodeTypes }),
    'dxosAutomations:listRules': async (req) => ({
      items: req.params?.organizationId === 'org-a'
        ? [{ id: 1, ruleKey: 'rule_org_a', name: 'Org A Flow', graphJson: { version: 2, nodes: [{ id: 'trig_a', type: 'trigger.manual', label: 'A', position: { x: 80, y: 180 }, config: {} }], edges: [] } }]
        : [{ id: 2, ruleKey: 'rule_org_b', name: 'Org B Flow', graphJson: { version: 2, nodes: [{ id: 'trig_b', type: 'trigger.manual', label: 'B', position: { x: 80, y: 180 }, config: {} }], edges: [] } }],
    }),
    'dxosAutomations:listRuns': async (req) => (req.params?.organizationId === 'org-a'
      ? new Promise((resolve) => { resolveSlowRuns = resolve; })
      : { items: [{ id: 9, runUid: 'run-org-b', ruleKey: 'rule_org_b', status: 'completed', durationMs: 5, stepTracesJson: [] }] }),
    'dxosAutomations:saveRule': async (req) => ({ rule: { id: 1, ...req.data } }),
  });

  const FlowStudioApp = createFlowStudioApp(client, harness.React, {}, {});
  let tree = await harness.mountAndFlush(FlowStudioApp, { selectedOrg: 'org-a', initialView: 'editor' });

  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-dsl-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a', initialView: 'editor' });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-dsl-modal').length, 1);

  const maliciousJson = '{"__proto__":{"polluted":true},"version":2,"nodes":[{"id":"t1","type":"trigger.manual"}],"edges":[]}';
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-dsl-textarea')[0].props.onChange({ target: { value: maliciousJson } });
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a', initialView: 'editor' });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-dsl-import-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a', initialView: 'editor' });
  assert.equal(({}).polluted, undefined);
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-dsl-error').length, 1);

  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-dsl-format-select')[0].props.onChange({ target: { value: 'yaml' } });
  const yamlText = ['ruleKey: yaml_imported_flow', 'name: YAML Imported Flow', 'graphJson:', '  version: 2', '  nodes:', '    - id: trig_yaml', '      type: trigger.record', '      config:', '        collection: latticeOrders', '        operation: update', '  edges: []'].join('\n');
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-dsl-textarea')[0].props.onChange({ target: { value: yamlText } });
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a', initialView: 'editor' });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-dsl-import-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a', initialView: 'editor' });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-node-trig_yaml').length, 1);

  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-save-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a', initialView: 'editor' });
  const saveReq = requests.find((r) => r.url === 'dxosAutomations:saveRule');
  assert.equal(saveReq.data.organizationId, 'org-a');
  assert.equal(saveReq.data.ruleKey, 'yaml_imported_flow');
  assert.equal(saveReq.data.triggerEventType, 'record.latticeOrders.update');

  tree = await harness.mountAndFlush(FlowStudioApp, { selectedOrg: 'org-b', initialView: 'editor' });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-node-trig_b').length, 1);
  if (resolveSlowRuns) {
    resolveSlowRuns({ items: [{ id: 888, runUid: 'stale-org-a-run', ruleKey: 'rule_org_a', status: 'completed' }] });
    await new Promise((resolve) => setImmediate(resolve));
    tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-b', initialView: 'editor' });
  }
  assert.equal(JSON.stringify(tree).includes('stale-org-a-run'), false);
});

test('All 6 LatticeFlow v2 server blueprints enforce schema parity (no urgent priority on ServiceTickets, required fields present)', () => {
  const { SERVICE_PRIORITIES, SERVICE_TYPES } = require(path.join(PLUGIN_ROOT, 'src/server/service-schema.js'));
  const blueprints = getBlueprints();
  assert.equal(blueprints.length, 6);

  const slaBp = blueprints.find((b) => b.ruleKey === 'auto_sla_breach_escalation');
  const tktNode = slaBp.graphJson.nodes.find((n) => n.type === 'data.create' && n.config?.collection === 'latticeServiceTickets');
  assert.ok(tktNode);
  assert.ok(SERVICE_TYPES.includes(tktNode.config.values.serviceType));
  assert.ok(SERVICE_PRIORITIES.includes(tktNode.config.values.priority));
  assert.notEqual(tktNode.config.values.priority, 'urgent');

  const mktBp = blueprints.find((b) => b.ruleKey === 'auto_mkt_quarantine_response');
  const incNode = mktBp.graphJson.nodes.find((n) => n.type === 'data.create' && n.config?.collection === 'latticeIncidentCases');
  assert.ok(incNode);
  for (const reqField of ['code', 'name', 'runId', 'assetEntityId', 'handlerId', 'severity', 'status', 'proposal']) {
    assert.ok(incNode.config.values[reqField], `Missing latticeIncidentCases.${reqField}`);
  }
});

test('flow-dsl.js provides collision-free nextCollisionFreeId(), normalizes missing Graph v2 edge IDs in ruleToGraph(), and supports DSL roundtrip', () => {
  const dslMod = require(path.join(PLUGIN_ROOT, 'src/client/flow/flow-dsl.js'));
  assert.equal(typeof dslMod.nextCollisionFreeId, 'function');
  assert.equal(typeof dslMod.ruleToGraph, 'function');
  assert.equal(typeof dslMod.parseDslText, 'function');
  assert.equal(typeof dslMod.serializeFlowDsl, 'function');
  assert.equal(typeof dslMod.buildRunOverlay, 'function');
  assert.equal(typeof dslMod.formatRunLabel, 'function');
  assert.equal(typeof dslMod.makeBlankFlow, 'function');
  assert.equal(typeof dslMod.sanitizeSafeValue, 'function');
  assert.ok(dslMod.BLOCKED_KEYS instanceof Set && dslMod.BLOCKED_KEYS.has('__proto__'));

  const prePopulated = { nodes: [{ id: 'notify_1' }, { id: 'edge_3' }], edges: [{ id: 'edge_1' }, { id: 'edge_2' }] };
  assert.equal(dslMod.nextCollisionFreeId('edge', prePopulated), 'edge_4');
  assert.equal(dslMod.nextCollisionFreeId('notify', prePopulated), 'notify_2');

  const normalized = dslMod.ruleToGraph({
    graphJson: { version: 2, nodes: [{ id: 'n1', type: 'trigger.manual' }, { id: 'n2', type: 'notify.send' }, { id: 'n3', type: 'data.create' }], edges: [{ source: 'n1', target: 'n2' }, { id: 'edge_1', source: 'n2', target: 'n3' }, { source: 'n1', target: 'n3' }] },
  });
  assert.deepEqual(normalized.edges.map((e) => e.id), ['edge_2', 'edge_1', 'edge_3']);
});

test('FlowStudioApp resets doc/graph cleanly when switching to a 0-rule org and drops stale in-flight runAction responses', async () => {
  const { createFlowStudioApp } = require(path.join(PLUGIN_ROOT, 'src/client/flow/flow-studio-app.js'));
  const harness = createQueuedReactHarness();
  const nodeTypes = getRegistrySchemas();
  let resolveSlowDryRun = null;

  const { client } = createApiMock({
    'dxosAutomations:builderCatalog': async () => ({ nodeTypes, blueprints: getBlueprints() }),
    'dxosAutomations:nodeRegistry': async () => ({ nodeTypes }),
    'dxosAutomations:listRules': async (req) => ({
      items: req.params?.organizationId === 'org-a'
        ? [{ id: 10, ruleKey: 'rule_org_a', name: 'Org A Only Rule', triggerEventType: 'manual.run', graphJson: { version: 2, nodes: [{ id: 'trig_org_a', type: 'trigger.manual', label: 'Org A Trigger', position: { x: 80, y: 180 }, config: {} }], edges: [] } }]
        : [],
    }),
    'dxosAutomations:listRuns': async () => ({ items: [] }),
    'dxosAutomations:testRule': async () => new Promise((resolve) => { resolveSlowDryRun = resolve; }),
  });

  const FlowStudioApp = createFlowStudioApp(client, harness.React, {}, {});
  let tree = await harness.mountAndFlush(FlowStudioApp, { selectedOrg: 'org-a', initialView: 'editor' });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-node-trig_org_a').length, 1);

  const dryRunPromise = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-dryrun-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a', initialView: 'editor' });

  tree = await harness.mountAndFlush(FlowStudioApp, { selectedOrg: 'org-empty', initialView: 'editor' });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-node-trig_org_a').length, 0);
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-node-trig_1').length, 1);

  if (resolveSlowDryRun) resolveSlowDryRun({ simulation: { runUid: 'stale-dryrun-org-a', status: 'completed', durationMs: 7, stepTracesJson: [{ nodeId: 'trig_org_a', status: 'completed', durationMs: 7 }] } });
  await dryRunPromise;
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-empty', initialView: 'editor' });
  assert.equal(JSON.stringify(tree).includes('stale-dryrun-org-a'), false);
});

test('handleNodesChangeGraph(nodes, { skipUndo: true }) preserves undo history and palette add clears insertEdge', async () => {
  const Module = require('node:module');
  const flowCanvasPath = require.resolve(path.join(PLUGIN_ROOT, 'src/client/flow/flow-canvas.js'));
  const flowAppPath = require.resolve(path.join(PLUGIN_ROOT, 'src/client/flow/flow-studio-app.js'));
  const realCanvasMod = require(flowCanvasPath);
  let capturedCanvasProps = null;

  const origLoad = Module._load;
  Module._load = function mockedCanvas(req, parent, isMain) {
    if (req === './flow-canvas') {
      return {
        ...realCanvasMod,
        createFlowCanvas(ReactArg, vendorArg) {
          const RealCanvas = realCanvasMod.createFlowCanvas(ReactArg, vendorArg);
          return function SpyFlowCanvas(p) { capturedCanvasProps = p; return RealCanvas(p); };
        },
      };
    }
    return origLoad.call(this, req, parent, isMain);
  };
  let createFlowStudioApp;
  try { delete require.cache[flowAppPath]; ({ createFlowStudioApp } = require(flowAppPath)); } finally { Module._load = origLoad; }

  const harness = createQueuedReactHarness();
  const nodeTypes = getRegistrySchemas();
  const blueprints = getBlueprints();
  const { client } = createApiMock({
    'dxosAutomations:builderCatalog': async () => ({ nodeTypes, blueprints }),
    'dxosAutomations:nodeRegistry': async () => ({ nodeTypes }),
    'dxosAutomations:listRules': async () => ({ items: [blueprints[3]] }),
    'dxosAutomations:listRuns': async () => ({ items: [] }),
  });

  const FlowStudioApp = createFlowStudioApp(client, harness.React, {}, {});
  let tree = await harness.mountAndFlush(FlowStudioApp, { selectedOrg: 'org-a', initialView: 'editor' });

  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-edge-insert-e_trig_if')[0].props.onClick({ stopPropagation() {} });
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a', initialView: 'editor' });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-insert-picker').length, 1);

  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-palette-node-data.create')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a', initialView: 'editor' });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-insert-picker').length, 0);

  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-edge-insert-e_if_approval')[0].props.onClick({ stopPropagation() {} });
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a', initialView: 'editor' });
  capturedCanvasProps.onDropNode({ type: 'notify.send', label: 'Dropped Notify', defaultConfig: {} }, { x: 320, y: 260 });
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a', initialView: 'editor' });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-insert-picker').length, 0);
  const countBeforeDrag = capturedCanvasProps.graph.nodes.length;

  const draggedNodes = capturedCanvasProps.graph.nodes.map((n, idx) => (idx === 0 ? { ...n, position: { x: 444, y: 222 } } : n));
  capturedCanvasProps.onNodesChangeGraph(draggedNodes, { skipUndo: true });
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a', initialView: 'editor' });
  assert.equal(capturedCanvasProps.graph.nodes[0].position.x, 444);

  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-undo-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a', initialView: 'editor' });
  assert.equal(capturedCanvasProps.graph.nodes.length, countBeforeDrag - 1);
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-undo-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a', initialView: 'editor' });
  assert.equal(capturedCanvasProps.graph.nodes.length, countBeforeDrag - 2);
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-undo-btn')[0].props.disabled, true);
});

test('P1-2: multi-frame node drag captures exact pre-drag position for Undo/Redo and clears pending drag on + New Flow', async () => {
  const { createFlowStudioApp } = require(path.join(PLUGIN_ROOT, 'src/client/flow/flow-studio-app.js'));
  const harness = createQueuedReactHarness();
  const nodeTypes = getRegistrySchemas();
  const mockXy = createMockXyflow();

  const { client } = createApiMock({
    'dxosAutomations:builderCatalog': async () => ({ nodeTypes, blueprints: getBlueprints() }),
    'dxosAutomations:nodeRegistry': async () => ({ nodeTypes }),
    'dxosAutomations:listRules': async () => ({ items: [] }),
    'dxosAutomations:listRuns': async () => ({ items: [] }),
  });

  const FlowStudioApp = createFlowStudioApp(client, harness.React, {}, {});
  let tree = await harness.mountAndFlush(FlowStudioApp, { selectedOrg: 'org-a', initialView: 'editor', xyflowOverride: mockXy });
  const getRf = (root) => collectNodes(root, (n) => n.props?.['data-testid'] === 'dxos-mock-xyflow')[0].props['data-rf-props'];
  const getTrigPos = (root) => getRf(root).nodes.find((n) => n.id === 'trig_1').position;

  assert.deepEqual(getTrigPos(tree), { x: 80, y: 180 });
  getRf(tree).onNodesChange([{ id: 'trig_1', type: 'position', position: { x: 185, y: 215 }, dragging: true }]);
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a', initialView: 'editor', xyflowOverride: mockXy });
  getRf(tree).onNodesChange([{ id: 'trig_1', type: 'position', position: { x: 420, y: 310 }, dragging: true }]);
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a', initialView: 'editor', xyflowOverride: mockXy });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-undo-btn')[0].props.disabled, true);

  getRf(tree).onNodesChange([{ id: 'trig_1', type: 'position', position: { x: 420, y: 310 }, dragging: false }]);
  getRf(tree).onNodeDragStop?.({}, { id: 'trig_1', position: { x: 420, y: 310 } });
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a', initialView: 'editor', xyflowOverride: mockXy });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-undo-btn')[0].props.disabled, false);

  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-undo-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a', initialView: 'editor', xyflowOverride: mockXy });
  assert.deepEqual(getTrigPos(tree), { x: 80, y: 180 });

  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-redo-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a', initialView: 'editor', xyflowOverride: mockXy });
  assert.deepEqual(getTrigPos(tree), { x: 420, y: 310 });

  getRf(tree).onNodesChange([{ id: 'trig_1', type: 'position', position: { x: 777, y: 888 }, dragging: true }]);
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a', initialView: 'editor', xyflowOverride: mockXy });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-back-to-list-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a', initialView: 'editor', xyflowOverride: mockXy });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-new-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a', initialView: 'editor', xyflowOverride: mockXy });
  assert.deepEqual(getTrigPos(tree), { x: 80, y: 180 });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-undo-btn')[0].props.disabled, true);
});

test('P1-3: DSL import (bare & wrapped) and Undo/Redo keep doc.rule.{cooldownSec,maxDepth} in sync with graph.settings via Settings Popover', async () => {
  const { createFlowStudioApp } = require(path.join(PLUGIN_ROOT, 'src/client/flow/flow-studio-app.js'));
  const harness = createQueuedReactHarness();
  const nodeTypes = getRegistrySchemas();

  const { client, requests } = createApiMock({
    'dxosAutomations:builderCatalog': async () => ({ nodeTypes, blueprints: getBlueprints() }),
    'dxosAutomations:nodeRegistry': async () => ({ nodeTypes }),
    'dxosAutomations:listRules': async () => ({ items: [] }),
    'dxosAutomations:listRuns': async () => ({ items: [] }),
    'dxosAutomations:saveRule': async (req) => ({ rule: req.data }),
  });

  const FlowStudioApp = createFlowStudioApp(client, harness.React, {}, {});
  let tree = await harness.mountAndFlush(FlowStudioApp, { selectedOrg: 'org-a', initialView: 'editor' });

  // Open Settings Popover so we can observe cooldownSec / maxDepth inputs reactively
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-settings-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a', initialView: 'editor' });

  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-dsl-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a', initialView: 'editor' });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-dsl-textarea')[0].props.onChange({
    target: { value: JSON.stringify({ version: 2, nodes: [{ id: 'trig_bare', type: 'trigger.manual', label: 'Bare' }], edges: [], settings: { cooldownSec: 95, maxDepth: 4 } }) },
  });
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a', initialView: 'editor' });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-dsl-import-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a', initialView: 'editor' });

  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-rule-cooldown-input')[0].props.value, 95);
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-rule-maxdepth-input')[0].props.value, 4);

  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-save-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a', initialView: 'editor' });
  let lastSave = requests.filter((r) => r.url === 'dxosAutomations:saveRule').at(-1);
  assert.equal(lastSave.data.cooldownSec, 95);
  assert.equal(lastSave.data.maxDepth, 4);

  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-dsl-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a', initialView: 'editor' });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-dsl-textarea')[0].props.onChange({
    target: { value: JSON.stringify({ ruleKey: 'wrapped_sync_rule', name: 'Wrapped Sync', graphJson: { version: 2, nodes: [{ id: 'trig_w', type: 'trigger.manual' }], edges: [], settings: { cooldownSec: 45, maxDepth: 5 } } }) },
  });
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a', initialView: 'editor' });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-dsl-import-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a', initialView: 'editor' });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-rule-cooldown-input')[0].props.value, 45);
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-rule-maxdepth-input')[0].props.value, 5);

  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-undo-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a', initialView: 'editor' });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-rule-cooldown-input')[0].props.value, 95);
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-rule-maxdepth-input')[0].props.value, 4);
});

test('UX polish: pre-org gating waits for listEmployees before automation GETs (with empty-org fallback)', async () => {
  const { createFlowStudioApp } = require(path.join(PLUGIN_ROOT, 'src/client/flow/flow-studio-app.js'));
  const nodeTypes = getRegistrySchemas();

  const harnessA = createQueuedReactHarness();
  const mockA = createApiMock({
    'dxosStudio:listEmployees': async () => ({ items: [], organizations: ['native-ui-lab'], organizationCounts: { 'native-ui-lab': 3 } }),
    'dxosAutomations:builderCatalog': async () => ({ nodeTypes, blueprints: getBlueprints() }),
    'dxosAutomations:nodeRegistry': async () => ({ nodeTypes }),
    'dxosAutomations:listRules': async () => ({ items: [] }),
    'dxosAutomations:listRuns': async () => ({ items: [] }),
  });
  const AppA = createFlowStudioApp(mockA.client, harnessA.React, {}, {});
  await harnessA.mountAndFlush(AppA, {});
  const autoReqsA = mockA.requests.filter((r) => r.url.startsWith('dxosAutomations:'));
  assert.equal(autoReqsA.length, 4);
  assert.ok(autoReqsA.every((r) => r.params?.organizationId === 'native-ui-lab'));

  const harnessB = createQueuedReactHarness();
  const mockB = createApiMock({
    'dxosStudio:listEmployees': async () => ({ items: [], organizations: [] }),
    'dxosAutomations:builderCatalog': async () => ({ nodeTypes, blueprints: getBlueprints() }),
    'dxosAutomations:nodeRegistry': async () => ({ nodeTypes }),
    'dxosAutomations:listRules': async () => ({ items: [] }),
    'dxosAutomations:listRuns': async () => ({ items: [] }),
  });
  const AppB = createFlowStudioApp(mockB.client, harnessB.React, {}, {});
  await harnessB.mountAndFlush(AppB, {});
  assert.equal(mockB.requests.filter((r) => r.url.startsWith('dxosAutomations:')).length, 4);
});
