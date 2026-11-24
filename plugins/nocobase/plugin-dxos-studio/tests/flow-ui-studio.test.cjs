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
  let currentComponent = null;
  let stateIdx = 0;
  let effectIdx = 0;
  let memoIdx = 0;
  let callbackIdx = 0;
  let pendingUpdates = 0;
  const pendingEffects = [];

  function getBucket(map, comp) {
    let arr = map.get(comp);
    if (!arr) {
      arr = [];
      map.set(comp, arr);
    }
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
      if (bucket.length <= idx) {
        bucket[idx] = { value: typeof init === 'function' ? init() : init, queue: [] };
      }
      const slot = bucket[idx];
      while (slot.queue.length > 0) {
        const next = slot.queue.shift();
        slot.value = typeof next === 'function' ? next(slot.value) : next;
      }
      const setState = (next) => {
        slot.queue.push(next);
        pendingUpdates += 1;
      };
      return [slot.value, setState];
    },
    useEffect(fn, deps) {
      const comp = currentComponent;
      const bucket = getBucket(effectsByComponent, comp);
      const idx = effectIdx++;
      const prev = bucket[idx];
      if (!prev || depsChanged(prev.deps, deps)) {
        bucket[idx] = { deps: Array.isArray(deps) ? deps.slice() : null };
        pendingEffects.push(fn);
      }
    },
    useCallback(fn, deps) {
      const comp = currentComponent;
      const bucket = getBucket(callbacksByComponent, comp);
      const idx = callbackIdx++;
      const prev = bucket[idx];
      if (!prev || depsChanged(prev.deps, deps)) {
        bucket[idx] = { deps: Array.isArray(deps) ? deps.slice() : null, fn };
      }
      return bucket[idx].fn;
    },
    useMemo(fn, deps) {
      const comp = currentComponent;
      const bucket = getBucket(memosByComponent, comp);
      const idx = memoIdx++;
      const prev = bucket[idx];
      if (!prev || depsChanged(prev.deps, deps)) {
        bucket[idx] = { deps: Array.isArray(deps) ? deps.slice() : null, value: fn() };
      }
      return bucket[idx].value;
    },
  };

  function renderNode(node) {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(renderNode);
    if (typeof node.type === 'function') {
      const prevComp = currentComponent;
      const prevS = stateIdx;
      const prevE = effectIdx;
      const prevM = memoIdx;
      const prevC = callbackIdx;
      currentComponent = node.type;
      stateIdx = 0;
      effectIdx = 0;
      memoIdx = 0;
      callbackIdx = 0;
      let out;
      try {
        out = node.type(node.props || {});
      } finally {
        currentComponent = prevComp;
        stateIdx = prevS;
        effectIdx = prevE;
        memoIdx = prevM;
        callbackIdx = prevC;
      }
      return renderNode(out);
    }
    if (Array.isArray(node.children)) {
      return { ...node, children: node.children.map(renderNode) };
    }
    return node;
  }

  async function flush(ComponentFn, props = {}) {
    pendingUpdates = 0;
    let tree = renderNode(React.createElement(ComponentFn, props));
    for (let pass = 0; pass < 12; pass += 1) {
      const batch = pendingEffects.splice(0, pendingEffects.length);
      for (const eff of batch) {
        await eff();
      }
      await new Promise((resolve) => setImmediate(resolve));
      if (pendingUpdates > 0 || pendingEffects.length > 0 || batch.length > 0) {
        pendingUpdates = 0;
        tree = renderNode(React.createElement(ComponentFn, props));
      } else if (pass > 0) {
        break;
      }
    }
    return tree;
  }

  return {
    React,
    render: (ComponentFn, props = {}) => {
      pendingUpdates = 0;
      return renderNode(React.createElement(ComponentFn, props));
    },
    mountAndFlush: flush,
    flush,
  };
}

function createApiMock(handlers) {
  const requests = [];
  const client = {
    useAPIClient: () => ({
      async request(req) {
        requests.push({
          url: req.url,
          method: (req.method || 'get').toLowerCase(),
          params: req.params || null,
          data: req.data || null,
        });
        const key = `${(req.method || 'get').toLowerCase()} ${req.url}`;
        const fn = handlers[key] || handlers[req.url];
        if (!fn) return { data: { data: {} } };
        const payload = await fn(req);
        return { data: { data: payload } };
      },
    }),
  };
  return { client, requests };
}

function createMockXyflow() {
  const Position = { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' };
  function ReactFlow(props) {
    const { nodes = [], edges = [], nodeTypes = {}, edgeTypes = {}, children } = props;
    const NodeComp = nodeTypes.dxosNode;
    const EdgeComp = edgeTypes.dxosEdge;
    return {
      type: 'div',
      props: { 'data-testid': 'dxos-mock-xyflow', 'data-rf-props': props },
      children: [
        ...nodes.map((n) => (NodeComp ? NodeComp({ id: n.id, data: n.data, selected: n.selected }) : null)),
        ...edges.map((e) => (EdgeComp ? EdgeComp({ id: e.id, source: e.source, sourceHandle: e.sourceHandle, target: e.target, targetHandle: e.targetHandle, label: e.label, animated: e.animated, style: e.style, data: e.data, sourceX: 0, sourceY: 0, targetX: 200, targetY: 0 }) : null)),
        ...(Array.isArray(children) ? children : [children]).filter(Boolean),
      ],
    };
  }
  return {
    ReactFlow,
    Background: () => ({ type: 'div', props: { 'data-testid': 'rf-background' }, children: [] }),
    Controls: () => ({ type: 'div', props: { 'data-testid': 'rf-controls' }, children: [] }),
    MiniMap: () => ({ type: 'div', props: { 'data-testid': 'rf-minimap' }, children: [] }),
    Handle: (p) => ({ type: 'div', props: p, children: [] }),
    BaseEdge: (p) => ({ type: 'path', props: p, children: [] }),
    EdgeLabelRenderer: ({ children }) => ({ type: 'div', props: {}, children: Array.isArray(children) ? children : [children] }),
    getBezierPath: ({ sourceX, sourceY, targetX, targetY }) => [`M ${sourceX},${sourceY} L ${targetX},${targetY}`, (sourceX + targetX) / 2, (sourceY + targetY) / 2],
    Position,
  };
}

function getRegistrySchemas() {
  const { listNodeSchemas } = require(path.join(PLUGIN_ROOT, 'src/server/flow/registry.js'));
  return listNodeSchemas();
}

function getBlueprints() {
  const { listFlowBlueprints } = require(path.join(PLUGIN_ROOT, 'src/server/flow/blueprints/index.js'));
  return listFlowBlueprints();
}

test('flow/* modules obey <= 350 lines, SPDX header, zero forbidden branding, and security constraints', () => {
  const flowDir = path.join(PLUGIN_ROOT, 'src/client/flow');
  const flowFiles = readdirSync(flowDir).filter((f) => f.endsWith('.js'));
  assert.ok(flowFiles.includes('flow-studio-app.js'), 'flow-studio-app.js must exist');
  assert.ok(flowFiles.includes('flow-dsl.js'), 'flow-dsl.js must exist');
  assert.equal(flowFiles.length, 8, 'flow/ directory must contain vendor-shims + 7 modular UI files');

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
    assert.ok(lines <= 350, `src/client/flow/${f} must be <= 350 lines (got ${lines})`);
    if (f === 'flow-dsl.js') {
      assert.ok(lines <= 250, `src/client/flow/flow-dsl.js must be <= 250 lines (got ${lines})`);
    }
  }

  assert.equal(existsSync(path.join(PLUGIN_ROOT, 'src', 'client', ['automation', 'studio', 'panel.js'].join('-'))), false, 'Legacy v1 automation panel must be deleted');
});

test('src/client/index.js registers both dxos-studio and dxos-flow-studio settings routes cleanly', async () => {
  const Module = require('node:module');
  const indexPath = path.join(PLUGIN_ROOT, 'src/client/index.js');
  const harness = createQueuedReactHarness();
  class MockPlugin {
    constructor(app) { this.app = app; }
  }
  const mockClient = {
    Plugin: MockPlugin,
    useAPIClient: () => ({ request: async () => ({ data: { data: {} } }) }),
  };

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
  const plugin = new mod.default({
    pluginSettingsManager: {
      add(key, opts) { added.push({ key, opts }); },
    },
  });
  await plugin.load();

  const byKey = Object.fromEntries(added.map((x) => [x.key, x.opts]));
  assert.ok(byKey['dxos-studio'], 'Must keep dxos-studio route');
  assert.equal(byKey['dxos-studio'].aclSnippet, 'pm');
  assert.ok(byKey['dxos-flow-studio'], 'Must register dxos-flow-studio route');
  assert.equal(byKey['dxos-flow-studio'].title, 'DX-OS Flow Studio');
  assert.equal(byKey['dxos-flow-studio'].icon, 'ApartmentOutlined');
  assert.equal(byKey['dxos-flow-studio'].aclSnippet, 'pm');
  assert.equal(typeof byKey['dxos-flow-studio'].Component, 'function');

  const flowTree = await harness.mountAndFlush(byKey['dxos-flow-studio'].Component, {});
  assert.equal(flowTree.props['data-testid'], 'dxos-flow-studio-app');
  assert.equal(flowTree.props.style.height, 'calc(100vh - 110px)');
});

test('FlowStudioApp renders @xyflow/react canvas, 6 Blueprints gallery, Palette add, Connect, InsertBetweenEdge, Auto-Layout, and Undo/Redo', async () => {
  const { createFlowStudioApp } = require(path.join(PLUGIN_ROOT, 'src/client/flow/flow-studio-app.js'));
  const harness = createQueuedReactHarness();
  const nodeTypes = getRegistrySchemas();
  const blueprints = getBlueprints();
  const mockXy = createMockXyflow();
  const feedbackCalls = [];

  const { client } = createApiMock({
    'dxosAutomations:builderCatalog': async () => ({
      llmConfigured: true,
      llmService: { provider: 'openai', modelName: 'gpt-4o-mini' },
      nodeTypes,
      eventTypes: [{ type: 'alarm.triggered', label: 'Alarm' }],
      dmnTables: [{ tableKey: 'cmms_priority_routing_v1', name: 'CMMS Routing', outputsJson: [{ name: 'workOrderPriority' }, { name: 'assignedRole' }] }],
      collections: [{ name: 'latticeCustomWorkOrders', title: 'CMMS', fields: ['workOrderCode', 'title', 'priority'] }],
      roles: ['ldx_admin', 'ldx_manager', 'ldx_operator'],
      connectors: [{ connectorKey: 'n8n-coldchain-orchestrator', name: 'n8n', connectorType: 'n8n', authType: 'hmac' }],
      blueprints,
    }),
    'dxosAutomations:nodeRegistry': async () => ({ nodeTypes }),
    'dxosAutomations:listRules': async () => ({ items: [] }),
    'dxosAutomations:listRuns': async () => ({ items: [] }),
  });

  const FlowStudioApp = createFlowStudioApp(client, harness.React, {}, {});
  const appProps = { selectedOrg: 'org-a', xyflowOverride: mockXy, setFeedback: (fb) => feedbackCalls.push(fb) };
  let tree = await harness.mountAndFlush(FlowStudioApp, appProps);

  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-mock-xyflow').length, 1);
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'rf-minimap').length, 1);
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'rf-controls').length, 1);
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-palette').length, 1);

  // Open Blueprints (6) gallery and load HITL procurement blueprint
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-blueprints-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, appProps);
  const gallery = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-blueprints-gallery')[0];
  assert.ok(gallery, 'Blueprints gallery must render');
  assert.equal(collectNodes(gallery, (n) => String(n.props?.['data-testid'] || '').startsWith('dxos-flow-blueprint-load-')).length, 6);

  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-blueprint-load-auto_procurement_hitl_approval')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, appProps);
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-node-approval_director').length, 1);

  const countCanvasNodes = (rootTree) => {
    const c = collectNodes(rootTree, (n) => n.props?.['data-testid'] === 'dxos-flow-canvas')[0];
    return collectNodes(c, (n) => String(n.props?.['data-testid'] || '').startsWith('dxos-flow-node-')).length;
  };
  const listCanvasNodes = (rootTree) => {
    const c = collectNodes(rootTree, (n) => n.props?.['data-testid'] === 'dxos-flow-canvas')[0];
    return collectNodes(c, (n) => String(n.props?.['data-testid'] || '').startsWith('dxos-flow-node-'));
  };

  // Palette search & click adds node onto canvas
  const nodesBeforeAdd = countCanvasNodes(tree);
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-palette-search')[0].props.onChange({ target: { value: 'data.create' } });
  tree = await harness.flush(FlowStudioApp, appProps);
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-palette-node-data.create')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, appProps);
  const nodesAfterAdd = countCanvasNodes(tree);
  assert.equal(nodesAfterAdd, nodesBeforeAdd + 1);

  // Connect new node via XYFlow onConnect
  const addedNodeEl = listCanvasNodes(tree).at(-1);
  const addedNodeId = addedNodeEl.props['data-testid'].replace('dxos-flow-node-', '');
  const rfMock = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-mock-xyflow')[0];
  rfMock.props['data-rf-props'].onConnect({ source: 'notify_operator_approved', sourceHandle: 'main', target: addedNodeId, targetHandle: 'in' });
  tree = await harness.flush(FlowStudioApp, appProps);
  assert.ok(collectNodes(tree, (n) => String(n.props?.['data-testid'] || '').startsWith('dxos-flow-edge-insert-')).length >= 7);

  // Insert node between edge (`+` button)
  const insertBtn = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-edge-insert-e_trig_if')[0];
  assert.ok(insertBtn, 'Edge insert + button must exist');
  insertBtn.props.onClick({ stopPropagation() {} });
  tree = await harness.flush(FlowStudioApp, appProps);
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-insert-picker').length, 1);
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-insert-node-logic.dmn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, appProps);
  const nodesAfterInsert = countCanvasNodes(tree);
  assert.equal(nodesAfterInsert, nodesAfterAdd + 1);

  // Auto-layout + Undo / Redo
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-autolayout-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, appProps);

  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-undo-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, appProps);
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-undo-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, appProps);
  assert.equal(countCanvasNodes(tree), nodesAfterAdd);

  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-redo-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, appProps);
  assert.equal(countCanvasNodes(tree), nodesAfterInsert);
  assert.equal(feedbackCalls.some((f) => f?.type === 'error'), false);
});

test('NodeInspector preserves selection under React 18/19 queued batching, inserts {{var}} via Variable Picker, and executes Test This Node', async () => {
  const { createFlowStudioApp } = require(path.join(PLUGIN_ROOT, 'src/client/flow/flow-studio-app.js'));
  const harness = createQueuedReactHarness();
  const nodeTypes = getRegistrySchemas();
  const blueprints = getBlueprints();

  const { client, requests } = createApiMock({
    'dxosAutomations:builderCatalog': async () => ({
      llmConfigured: false,
      nodeTypes,
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
    'dxosAutomations:testNode': async (req) => ({
      result: {
        ok: true,
        nodeId: req.data.nodeId,
        status: 'completed',
        output: { notified: ['ldx_manager'], title: 'Tested OK' },
        nextPort: 'main',
        durationMs: 11,
      },
    }),
  });

  const FlowStudioApp = createFlowStudioApp(client, harness.React, {}, {});
  let tree = await harness.mountAndFlush(FlowStudioApp, { selectedOrg: 'org-a' });

  // Select notify_assigned node and type label under queued React batching -> selection stays locked
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-node-notify_assigned')[0].props.onClick({ stopPropagation() {} });
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a' });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-node-label-input')[0].props.value, 'Thông báo vai trò phụ trách');

  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-node-label-input')[0].props.onChange({ target: { value: 'Báo trực tiếp Quản lý' } });
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a' });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-node-label-input')[0].props.value, 'Báo trực tiếp Quản lý');

  // Focus title field -> open Variable Tree Picker -> click {{data.deviceKey}} chip
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-field-title')[0].props.onFocus();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a' });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-var-picker-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a' });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-var-chip-{{data.deviceKey}}')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a' });
  assert.ok(String(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-field-title')[0].props.value).includes('{{data.deviceKey}}'));

  // Switch to Input / Pin -> run Test This Node -> switch to Output
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-inspector-tab-input')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a' });
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-test-node-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a' });

  const testNodeReq = requests.find((r) => r.url === 'dxosAutomations:testNode');
  assert.ok(testNodeReq);
  assert.equal(testNodeReq.data.nodeId, 'notify_assigned');
  assert.equal(testNodeReq.data.organizationId, 'org-a');

  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-inspector-tab-output')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a' });
  const outJson = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-output-json')[0];
  assert.ok(outJson && textOf(outJson).includes('Tested OK'));
});

test('PlaybackBar runs Dry-Run step highlighting, VCR navigation, and HITL Approve / Reject resume', async () => {
  const { createFlowStudioApp } = require(path.join(PLUGIN_ROOT, 'src/client/flow/flow-studio-app.js'));
  const harness = createQueuedReactHarness();
  const nodeTypes = getRegistrySchemas();
  const blueprints = getBlueprints();
  const hitlBp = blueprints.find((b) => b.ruleKey === 'auto_procurement_hitl_approval');

  let runs = [
    {
      id: 90,
      runUid: 'run-hitl-90',
      ruleKey: hitlBp.ruleKey,
      status: 'suspended',
      suspendedNodeId: 'approval_director',
      durationMs: 14,
      nodeStatesJson: {
        trig_request_create: { status: 'completed', durationMs: 2 },
        if_over_50m: { status: 'completed', nextPort: 'true', durationMs: 3 },
        approval_director: { status: 'suspended', suspend: { kind: 'approval', approverRole: 'ldx_manager', title: 'Approve > 50M' }, durationMs: 9 },
      },
      stepTracesJson: [
        { nodeId: 'trig_request_create', type: 'trigger.record', label: 'Trigger', status: 'completed', durationMs: 2 },
        { nodeId: 'if_over_50m', type: 'control.if', label: 'Over 50M?', status: 'completed', durationMs: 3 },
        { nodeId: 'approval_director', type: 'control.approval', label: 'HITL Director', status: 'suspended', durationMs: 9 },
      ],
    },
  ];

  const { client, requests } = createApiMock({
    'dxosAutomations:builderCatalog': async () => ({ nodeTypes, blueprints }),
    'dxosAutomations:nodeRegistry': async () => ({ nodeTypes }),
    'dxosAutomations:listRules': async () => ({ items: [hitlBp] }),
    'dxosAutomations:listRuns': async () => ({ items: runs }),
    'dxosAutomations:testRule': async (req) => ({
      simulation: {
        runUid: 'dry-sim-1',
        ruleKey: req.data.rule.ruleKey,
        status: 'completed',
        durationMs: 12,
        nodeStatesJson: {
          trig_request_create: { status: 'completed', durationMs: 2 },
          if_over_50m: { status: 'completed', nextPort: 'true', durationMs: 4 },
          approval_director: { status: 'completed', durationMs: 6 },
          notify_operator_standard: { status: 'skipped', reason: 'BRANCH_NOT_TAKEN' },
        },
        stepTracesJson: [
          { nodeId: 'trig_request_create', type: 'trigger.record', status: 'completed', simulated: true, durationMs: 2 },
          { nodeId: 'if_over_50m', type: 'control.if', status: 'completed', simulated: true, durationMs: 4 },
          { nodeId: 'approval_director', type: 'control.approval', status: 'completed', simulated: true, durationMs: 6 },
        ],
      },
    }),
    'dxosAutomations:resumeRun': async (req) => {
      const updated = {
        ...runs[0],
        status: 'completed',
        suspendedNodeId: null,
        durationMs: 24,
        nodeStatesJson: {
          ...runs[0].nodeStatesJson,
          approval_director: { status: 'completed', durationMs: 10 },
          update_approved_budget: { status: 'completed', durationMs: 10 },
        },
        stepTracesJson: [
          ...runs[0].stepTracesJson.slice(0, 2),
          { nodeId: 'approval_director', type: 'control.approval', status: 'completed', durationMs: 10 },
          { nodeId: 'update_approved_budget', type: 'data.update', status: 'completed', durationMs: 10 },
        ],
      };
      runs = [updated];
      return { run: updated };
    },
  });

  const FlowStudioApp = createFlowStudioApp(client, harness.React, {}, {});
  let tree = await harness.mountAndFlush(FlowStudioApp, { selectedOrg: 'org-a' });

  // HITL Approval banner visible for suspended run -> click Approve
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-hitl-banner').length, 1);
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-hitl-approve-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a' });

  const resumeReq = requests.find((r) => r.url === 'dxosAutomations:resumeRun');
  assert.ok(resumeReq);
  assert.equal(resumeReq.data.runUid, 'run-hitl-90');
  assert.equal(resumeReq.data.decision, 'approved');
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-hitl-banner').length, 0);

  // Trigger Dry-Run & step VCR backward
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-dryrun-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a' });
  assert.ok(requests.some((r) => r.url === 'dxosAutomations:testRule' && r.data.useDraft === true));
  assert.ok(textOf(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-step-badge')[0]).includes('Step 3/3'));
  assert.ok(textOf(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-node-notify_operator_standard')[0]).includes('skipped'));

  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-vcr-first-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a' });
  assert.ok(textOf(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-step-badge')[0]).includes('Step 1/3'));
});

test('DX-OS Flow Architect Drawer supports full/node/suggest/fix_error modes, Diff Preview, Apply to Canvas, and ZERO forbidden branding', async () => {
  const { createFlowStudioApp } = require(path.join(PLUGIN_ROOT, 'src/client/flow/flow-studio-app.js'));
  const harness = createQueuedReactHarness();
  const nodeTypes = getRegistrySchemas();
  const blueprints = getBlueprints();

  const failedRun = {
    id: 404,
    runUid: 'run-fail-404',
    ruleKey: blueprints[0].ruleKey,
    status: 'failed',
    errorMessage: 'TARGET_COLLECTION_FORBIDDEN',
    nodeStatesJson: {
      create_work_order: { status: 'failed', error: 'TARGET_COLLECTION_FORBIDDEN' },
    },
    stepTracesJson: [
      { nodeId: 'create_work_order', type: 'data.create', status: 'failed', error: 'TARGET_COLLECTION_FORBIDDEN', durationMs: 4 },
    ],
  };

  const { client, requests } = createApiMock({
    'dxosAutomations:builderCatalog': async () => ({
      llmConfigured: true,
      llmService: { provider: 'openai', modelName: 'gpt-4o-mini' },
      nodeTypes,
      blueprints,
    }),
    'dxosAutomations:nodeRegistry': async () => ({ nodeTypes }),
    'dxosAutomations:listRules': async () => ({ items: [blueprints[0]] }),
    'dxosAutomations:listRuns': async () => ({ items: [failedRun] }),
    'dxosAutomations:aiAssist': async (req) => {
      if (req.data.mode === 'suggest') {
        return {
          ok: true,
          mode: 'suggest',
          modeUsed: 'llm',
          repairAttempts: 0,
          summary: '2 optimization suggestions',
          graphDiff: { addedNodes: [], updatedNodes: [], removedNodes: [], addedEdges: [], removedEdges: [] },
          suggestions: [
            {
              id: 'enable-cd',
              title: 'Enable 120s cooldown',
              severity: 'warning',
              operations: [{ op: 'update_settings', settings: { cooldownSec: 120 } }],
            },
          ],
        };
      }
      if (req.data.mode === 'fix_error') {
        return {
          ok: true,
          mode: 'fix_error',
          modeUsed: 'llm',
          repairAttempts: 1,
          summary: 'Fixed target collection & added error alert.',
          graphDiff: {
            addedNodes: [{ id: 'err_notify', type: 'notify.send', label: 'Error Alert' }],
            updatedNodes: [{ id: 'create_work_order', type: 'data.create', label: 'Fixed Create WO' }],
            removedNodes: [],
            addedEdges: [{ id: 'e_err', source: 'create_work_order', sourceHandle: 'error', target: 'err_notify', targetHandle: 'in' }],
            removedEdges: [],
          },
          draftGraph: {
            ...blueprints[0].graphJson,
            nodes: [
              ...blueprints[0].graphJson.nodes,
              { id: 'err_notify', type: 'notify.send', label: 'Error Alert', position: { x: 800, y: 420 }, config: { roleNames: ['ldx_operator'], title: 'Recovered' } },
            ],
            edges: [
              ...blueprints[0].graphJson.edges,
              { id: 'e_err', source: 'create_work_order', sourceHandle: 'error', target: 'err_notify', targetHandle: 'in' },
            ],
          },
        };
      }
      return {
        ok: true,
        mode: req.data.mode,
        modeUsed: 'llm',
        repairAttempts: 0,
        summary: 'Synthesized 2-node DAG',
        graphDiff: { addedNodes: [{ id: 't_new', type: 'trigger.manual', label: 'Manual' }], updatedNodes: [], removedNodes: [], addedEdges: [], removedEdges: [] },
        draftGraph: {
          version: 2,
          nodes: [
            { id: 't_new', type: 'trigger.manual', label: 'Manual', position: { x: 80, y: 180 }, config: {} },
            { id: 'n_new', type: 'notify.send', label: 'Notify Manager', position: { x: 360, y: 180 }, config: { roleNames: ['ldx_manager'], title: 'Done' } },
          ],
          edges: [{ id: 'e_new', source: 't_new', sourceHandle: 'main', target: 'n_new', targetHandle: 'in' }],
        },
        draftRule: { ruleKey: 'architect_built_flow', name: 'Architect Built Flow', cooldownSec: 30, maxDepth: 6 },
      };
    },
  });

  const FlowStudioApp = createFlowStudioApp(client, harness.React, {}, {});
  let tree = await harness.mountAndFlush(FlowStudioApp, { selectedOrg: 'org-a' });

  // Open Architect Drawer
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-open-architect-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a' });
  const drawer = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-architect-drawer')[0];
  assert.ok(drawer);
  assert.ok(textOf(drawer).includes('DX-OS Flow Architect'));
  assert.equal(textOf(drawer).toLowerCase().includes(FORBIDDEN_WORD), false);

  // Run Suggest -> Apply Suggestion
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-architect-suggest-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a' });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-architect-apply-suggestion-enable-cd')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a' });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-rule-cooldown-input')[0].props.value, 120);

  // Run Fix Last Error (enabled because failedRun is selected) -> shows Auto-repair badge & diff -> Apply to Canvas
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-architect-fix-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a' });
  assert.ok(textOf(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-architect-repair-pill')[0]).includes('Auto-repair: 1'));
  assert.ok(textOf(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-architect-diff-preview')[0]).includes('Error Alert'));
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-architect-apply-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a' });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-node-err_notify').length, 1);

  // Run Build Flow -> Apply to Canvas
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-architect-prompt-input')[0].props.onChange({ target: { value: 'Notify manager manually' } });
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a' });
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-architect-build-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a' });
  assert.ok(requests.some((r) => r.url === 'dxosAutomations:aiAssist' && r.data.mode === 'full'));
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-architect-apply-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a' });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-node-n_new').length, 1);
});

test('JSON / YAML DSL modal blocks prototype pollution, imports valid JSON/YAML, preserves org/ruleKey on Save, and drops stale org responses', async () => {
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
    'dxosAutomations:listRuns': async (req) => {
      if (req.params?.organizationId === 'org-a') {
        return new Promise((resolve) => { resolveSlowRuns = resolve; });
      }
      return { items: [{ id: 9, runUid: 'run-org-b', ruleKey: 'rule_org_b', status: 'completed', durationMs: 5, stepTracesJson: [] }] };
    },
    'dxosAutomations:saveRule': async (req) => ({ rule: { id: 1, ...req.data } }),
  });

  const FlowStudioApp = createFlowStudioApp(client, harness.React, {}, {});
  let tree = await harness.mountAndFlush(FlowStudioApp, { selectedOrg: 'org-a' });

  // Open JSON / YAML DSL modal & block prototype pollution JSON
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-dsl-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a' });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-dsl-modal').length, 1);

  const maliciousJson = '{"__proto__":{"polluted":true},"version":2,"nodes":[{"id":"t1","type":"trigger.manual"}],"edges":[]}';
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-dsl-textarea')[0].props.onChange({ target: { value: maliciousJson } });
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a' });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-dsl-import-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a' });
  assert.equal(({}).polluted, undefined, 'Prototype must never be polluted');
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-dsl-error').length, 1);

  // Switch to YAML format & import valid YAML graph
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-dsl-format-select')[0].props.onChange({ target: { value: 'yaml' } });
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a' });
  const yamlText = [
    'ruleKey: yaml_imported_flow',
    'name: YAML Imported Flow',
    'graphJson:',
    '  version: 2',
    '  nodes:',
    '    - id: trig_yaml',
    '      type: trigger.manual',
    '      label: YAML Trigger',
    '  edges: []',
  ].join('\n');
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-dsl-textarea')[0].props.onChange({ target: { value: yamlText } });
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a' });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-dsl-import-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a' });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-node-trig_yaml').length, 1);

  // Save preserves ruleKey & organizationId
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-save-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a' });
  const saveReq = requests.find((r) => r.url === 'dxosAutomations:saveRule');
  assert.ok(saveReq);
  assert.equal(saveReq.data.organizationId, 'org-a');
  assert.equal(saveReq.data.ruleKey, 'yaml_imported_flow');
  assert.equal(saveReq.data.schemaVersion, 2);

  // Switch to org-b BEFORE slow org-a listRuns resolves -> stale org-a runs must be dropped
  tree = await harness.mountAndFlush(FlowStudioApp, { selectedOrg: 'org-b' });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-node-trig_b').length, 1);
  if (resolveSlowRuns) {
    resolveSlowRuns({ items: [{ id: 888, runUid: 'stale-org-a-run', ruleKey: 'rule_org_a', status: 'completed' }] });
    await new Promise((resolve) => setImmediate(resolve));
    tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-b' });
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

  const prePopulated = {
    nodes: [{ id: 'notify_1' }, { id: 'edge_3' }],
    edges: [{ id: 'edge_1' }, { id: 'edge_2' }],
  };
  assert.equal(dslMod.nextCollisionFreeId('edge', prePopulated), 'edge_4');
  assert.equal(dslMod.nextCollisionFreeId('notify', prePopulated), 'notify_2');
  assert.equal(dslMod.nextCollisionFreeId('data', prePopulated), 'data_1');

  const normalized = dslMod.ruleToGraph({
    graphJson: {
      version: 2,
      nodes: [
        { id: 'n1', type: 'trigger.manual' },
        { id: 'n2', type: 'notify.send' },
        { id: 'n3', type: 'data.create' },
      ],
      edges: [
        { source: 'n1', target: 'n2' },
        { id: 'edge_1', source: 'n2', target: 'n3' },
        { source: 'n1', target: 'n3' },
      ],
    },
  });
  assert.deepEqual(normalized.edges.map((e) => e.id), ['edge_2', 'edge_1', 'edge_3']);
  assert.equal(new Set(normalized.edges.map((e) => e.id)).size, 3);
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
        ? [{
          id: 10,
          ruleKey: 'rule_org_a',
          name: 'Org A Only Rule',
          triggerEventType: 'manual.run',
          graphJson: {
            version: 2,
            nodes: [{ id: 'trig_org_a', type: 'trigger.manual', label: 'Org A Trigger', position: { x: 80, y: 180 }, config: {} }],
            edges: [],
          },
        }]
        : [],
    }),
    'dxosAutomations:listRuns': async () => ({ items: [] }),
    'dxosAutomations:testRule': async () => new Promise((resolve) => { resolveSlowDryRun = resolve; }),
  });

  const FlowStudioApp = createFlowStudioApp(client, harness.React, {}, {});
  let tree = await harness.mountAndFlush(FlowStudioApp, { selectedOrg: 'org-a' });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-node-trig_org_a').length, 1);

  // Fire Dry-Run in org-a and leave it in flight
  const dryRunPromise = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-toolbar-dryrun-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a' });

  // Switch to org-empty (0 rules) before Dry-Run settles -> must reset to blank flow, never keep org-a DAG
  tree = await harness.mountAndFlush(FlowStudioApp, { selectedOrg: 'org-empty' });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-node-trig_org_a').length, 0);
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-node-trig_1').length, 1);
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-rule-selector')[0].props.value, '');

  // Resolve stale org-a Dry-Run -> must NOT overwrite org-empty runUi or doc
  if (resolveSlowDryRun) {
    resolveSlowDryRun({
      simulation: {
        runUid: 'stale-dryrun-org-a',
        status: 'completed',
        durationMs: 7,
        stepTracesJson: [{ nodeId: 'trig_org_a', status: 'completed', durationMs: 7 }],
      },
    });
  }
  await dryRunPromise;
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-empty' });
  assert.equal(JSON.stringify(tree).includes('stale-dryrun-org-a'), false);
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-node-trig_org_a').length, 0);
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-node-trig_1').length, 1);
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
          return function SpyFlowCanvas(p) {
            capturedCanvasProps = p;
            return RealCanvas(p);
          };
        },
      };
    }
    return origLoad.call(this, req, parent, isMain);
  };
  let createFlowStudioApp;
  try {
    delete require.cache[flowAppPath];
    ({ createFlowStudioApp } = require(flowAppPath));
  } finally {
    Module._load = origLoad;
  }

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
  let tree = await harness.mountAndFlush(FlowStudioApp, { selectedOrg: 'org-a' });

  // Open insertEdge picker, then click Palette node -> adds directly and clears insertEdge
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-edge-insert-e_trig_if')[0].props.onClick({ stopPropagation() {} });
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a' });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-insert-picker').length, 1);

  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-palette-node-data.create')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a' });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-insert-picker').length, 0);

  // Canvas onDropNode also adds node directly and clears insertEdge
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-edge-insert-e_trig_if')[0].props.onClick({ stopPropagation() {} });
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a' });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-insert-picker').length, 1);
  capturedCanvasProps.onDropNode({ type: 'notify.send', label: 'Dropped Notify', defaultConfig: {} }, { x: 320, y: 260 });
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a' });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-insert-picker').length, 0);
  const countBeforeDrag = capturedCanvasProps.graph.nodes.length;

  // Undo button enabled (2 frames in undo history)
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-undo-btn')[0].props.disabled, false);

  // Dragging frame with { skipUndo: true } updates node position WITHOUT pushing an undo frame
  const draggedNodes = capturedCanvasProps.graph.nodes.map((n, idx) => (idx === 0 ? { ...n, position: { x: 444, y: 222 } } : n));
  capturedCanvasProps.onNodesChangeGraph(draggedNodes, { skipUndo: true });
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a' });
  assert.equal(capturedCanvasProps.graph.nodes[0].position.x, 444);

  // Undo twice reverts both adds (proving skipUndo did NOT push a drag frame)
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-undo-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a' });
  assert.equal(capturedCanvasProps.graph.nodes.length, countBeforeDrag - 1);
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-undo-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a' });
  assert.equal(capturedCanvasProps.graph.nodes.length, countBeforeDrag - 2);
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-undo-btn')[0].props.disabled, true);
});

test('buildSavePayload derives triggerEventType accurately across triggers, handleRunNow splits primary event, and Playback supports stepTraces fallback', async () => {
  const { createFlowStudioApp } = require(path.join(PLUGIN_ROOT, 'src/client/flow/flow-studio-app.js'));
  const harness = createQueuedReactHarness();
  const nodeTypes = getRegistrySchemas();
  const blueprints = getBlueprints();

  const rules = [
    {
      id: 1,
      ruleKey: 'rule_webhook_stale',
      name: 'Webhook Rule',
      triggerEventType: 'alarm.triggered',
      graphJson: {
        version: 2,
        nodes: [
          { id: 'trig_wh', type: 'trigger.webhook', label: 'Webhook', position: { x: 80, y: 180 }, config: { webhookPath: '/hook' } },
          { id: 'step_extra', type: 'notify.send', label: 'Notify', position: { x: 340, y: 180 }, config: { roleNames: ['ldx_operator'], title: 'Hi' } },
        ],
        edges: [{ id: 'e_wh', source: 'trig_wh', sourceHandle: 'main', target: 'step_extra', targetHandle: 'in' }],
      },
    },
    {
      id: 2,
      ruleKey: 'rule_schedule_stale',
      name: 'Schedule Rule',
      triggerEventType: 'alarm.triggered',
      graphJson: {
        version: 2,
        nodes: [{ id: 'trig_sc', type: 'trigger.schedule', label: 'Schedule', position: { x: 80, y: 180 }, config: { cron: '0 8 * * *' } }],
        edges: [],
      },
    },
    {
      id: 3,
      ruleKey: 'rule_record_stale',
      name: 'Record Rule',
      triggerEventType: 'alarm.triggered',
      graphJson: {
        version: 2,
        nodes: [{ id: 'trig_rec', type: 'trigger.record', label: 'Record', position: { x: 80, y: 180 }, config: { collection: 'latticeOrders', operation: 'update' } }],
        edges: [],
      },
    },
    {
      id: 4,
      ruleKey: 'rule_manual_stale',
      name: 'Manual Rule',
      triggerEventType: 'alarm.triggered',
      graphJson: {
        version: 2,
        nodes: [{ id: 'trig_man', type: 'trigger.manual', label: 'Manual', position: { x: 80, y: 180 }, config: {} }],
        edges: [],
      },
    },
    {
      id: 5,
      ruleKey: 'rule_multi_event',
      name: 'Multi Event Rule',
      triggerEventType: 'sla.warning,sla.breached',
      graphJson: {
        version: 2,
        nodes: [{ id: 'trig_ev', type: 'trigger.event', label: 'SLA Event', position: { x: 80, y: 180 }, config: { eventType: 'sla.warning,sla.breached' } }],
        edges: [],
      },
    },
  ];

  const legacyRun = {
    id: 77,
    runUid: 'run-legacy-traces',
    ruleKey: 'rule_webhook_stale',
    status: 'completed',
    durationMs: 15,
    stepTraces: [
      { nodeId: 'trig_wh', type: 'trigger.webhook', label: 'Webhook', status: 'completed', durationMs: 5, output: { ok: true } },
      { nodeId: 'step_extra', type: 'notify.send', label: 'Notify', status: 'completed', durationMs: 10, output: { sent: 'legacy-trace-ok' } },
    ],
  };

  const { client, requests } = createApiMock({
    'dxosAutomations:builderCatalog': async () => ({ nodeTypes, blueprints }),
    'dxosAutomations:nodeRegistry': async () => ({ nodeTypes }),
    'dxosAutomations:listRules': async () => ({ items: rules }),
    'dxosAutomations:listRuns': async () => ({ items: [legacyRun] }),
    'dxosAutomations:saveRule': async (req) => ({ rule: req.data }),
    'dxosAutomations:runNow': async () => ({ run: legacyRun }),
  });

  const FlowStudioApp = createFlowStudioApp(client, harness.React, {}, {});
  let tree = await harness.mountAndFlush(FlowStudioApp, { selectedOrg: 'org-a' });

  // Playback & Inspector activeTrace support run.stepTraces fallback (when stepTracesJson is absent)
  assert.ok(textOf(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-step-badge')[0]).includes('Step 2/2'));
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-node-step_extra')[0].props.onClick({ stopPropagation() {} });
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a' });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-inspector-tab-output')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a' });
  assert.ok(textOf(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-output-json')[0]).includes('legacy-trace-ok'));

  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-vcr-first-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a' });
  assert.ok(textOf(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-step-badge')[0]).includes('Step 1/2'));

  // Save trigger.webhook derives webhook.inbound, trigger.schedule -> schedule.cron, trigger.record -> record.<col>.<op>, trigger.manual -> manual.run
  for (const [ruleKey, expectedEvt] of [
    [null, 'webhook.inbound'],
    ['rule_schedule_stale', 'schedule.cron'],
    ['rule_record_stale', 'record.latticeOrders.update'],
    ['rule_manual_stale', 'manual.run'],
  ]) {
    if (ruleKey) {
      collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-rule-selector')[0].props.onChange({ target: { value: ruleKey } });
      tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a' });
    }
    await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-save-btn')[0].props.onClick();
    tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a' });
    assert.equal(requests.filter((r) => r.url === 'dxosAutomations:saveRule').at(-1).data.triggerEventType, expectedEvt);
  }

  // Switch to multi-event rule -> Run Now splits primary event cleanly
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-rule-selector')[0].props.onChange({ target: { value: 'rule_multi_event' } });
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a' });
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-run-now-btn')[0].props.onClick();
  tree = await harness.flush(FlowStudioApp, { selectedOrg: 'org-a' });
  const runNowReq = requests.find((r) => r.url === 'dxosAutomations:runNow');
  assert.ok(runNowReq);
  assert.equal(runNowReq.data.sampleEvent.type, 'sla.warning');
});
