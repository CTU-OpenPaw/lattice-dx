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
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');

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

function createReactHarness() {
  const statesByComponent = new WeakMap();
  const effectsByComponent = new WeakMap();
  const memosByComponent = new WeakMap();
  let currentComponent = null;
  let stateIdx = 0;
  let effectIdx = 0;
  let memoIdx = 0;
  const pendingEffects = [];

  function getBucket(map, comp) {
    let arr = map.get(comp);
    if (!arr) {
      arr = [];
      map.set(comp, arr);
    }
    return arr;
  }

  const React = {
    Fragment: 'Fragment',
    createElement(type, props, ...children) {
      const flat = [];
      for (const c of children) {
        if (Array.isArray(c)) flat.push(...c);
        else flat.push(c);
      }
      return { type, props: props || {}, children: flat };
    },
    useState(init) {
      const bucket = getBucket(statesByComponent, currentComponent);
      const idx = stateIdx++;
      if (!(idx in bucket)) bucket[idx] = typeof init === 'function' ? init() : init;
      const setState = (next) => {
        bucket[idx] = typeof next === 'function' ? next(bucket[idx]) : next;
      };
      return [bucket[idx], setState];
    },
    useMemo(fn, deps) {
      const bucket = getBucket(memosByComponent, currentComponent);
      const idx = memoIdx++;
      const prev = bucket[idx];
      const same = prev && Array.isArray(deps) && Array.isArray(prev.deps)
        && deps.length === prev.deps.length
        && deps.every((d, i) => Object.is(d, prev.deps[i]));
      if (same) return prev.value;
      const value = fn();
      bucket[idx] = { deps, value };
      return value;
    },
    useCallback(fn) {
      return fn;
    },
    useEffect(fn, deps) {
      const bucket = getBucket(effectsByComponent, currentComponent);
      const idx = effectIdx++;
      const prev = bucket[idx];
      const changed = !prev || !Array.isArray(deps) || !Array.isArray(prev.deps)
        || deps.length !== prev.deps.length
        || deps.some((d, i) => !Object.is(d, prev.deps[i]));
      if (changed) {
        pendingEffects.push(() => {
          if (typeof prev?.cleanup === 'function') prev.cleanup();
          const cleanup = fn();
          bucket[idx] = { deps, cleanup };
        });
      }
    },
  };

  function renderNode(node) {
    if (node == null || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') return node;
    if (Array.isArray(node)) return node.map(renderNode);
    if (typeof node.type === 'function') {
      const prevComp = currentComponent;
      const prevS = stateIdx;
      const prevE = effectIdx;
      const prevM = memoIdx;
      currentComponent = node.type;
      stateIdx = 0;
      effectIdx = 0;
      memoIdx = 0;
      let out;
      try {
        out = node.type({ ...(node.props || {}), children: node.children });
      } finally {
        currentComponent = prevComp;
        stateIdx = prevS;
        effectIdx = prevE;
        memoIdx = prevM;
      }
      return renderNode(out);
    }
    return { ...node, children: Array.isArray(node.children) ? node.children.map(renderNode) : [] };
  }

  async function mountAndFlush(Comp, props = {}) {
    let tree = renderNode(React.createElement(Comp, props));
    for (let pass = 0; pass < 4 && pendingEffects.length > 0; pass += 1) {
      const batch = pendingEffects.splice(0, pendingEffects.length);
      for (const eff of batch) await eff();
      tree = renderNode(React.createElement(Comp, props));
    }
    return tree;
  }

  return { React, mountAndFlush, renderNode };
}

test('FlowCanvas preserves viewport zoom/pan on ResizeObserver container resize and fits only once per ruleKey', async () => {
  const { createFlowCanvas } = require(path.join(PLUGIN_ROOT, 'src/client/flow/flow-canvas.js'));
  const harness = createReactHarness();
  const rfCalls = [];
  const resizeCallbacks = [];
  const origResizeObserver = globalThis.ResizeObserver;

  globalThis.ResizeObserver = class MockResizeObserver {
    constructor(cb) { resizeCallbacks.push(cb); }
    observe() {}
    disconnect() {}
  };

  try {
    let fitCount = 0;
    const fakeRf = {
      fitView(opts) {
        fitCount += 1;
        rfCalls.push(opts || {});
      },
      zoomIn() {},
      zoomOut() {},
    };
    const mockXyflow = {
      ReactFlow: (props) => harness.React.createElement('div', { 'data-testid': 'mock-rf', 'data-rf-props': props }),
      Background: () => null,
      MiniMap: () => null,
      Handle: () => null,
      BaseEdge: () => null,
      EdgeLabelRenderer: () => null,
      Position: { Left: 'left', Right: 'right' },
      getBezierPath: () => ['M0,0 L10,10', 5, 5],
    };

    const FlowCanvas = createFlowCanvas(harness.React, {});
    const graph = {
      version: 2,
      nodes: [{ id: 'n1', type: 'trigger.manual', label: 'Start', position: { x: 80, y: 120 }, config: {} }],
      edges: [],
    };
    let tree = await harness.mountAndFlush(FlowCanvas, {
      ruleKey: 'rule_alpha', graph, nodeTypes: [], inspectorOpen: false, xyflowOverride: mockXyflow,
    });
    const canvasRoot = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-flow-canvas')[0];
    canvasRoot.props.ref?.({ getBoundingClientRect: () => ({ width: 900, height: 600 }) });

    const rfNode = collectNodes(tree, (n) => n.props?.['data-testid'] === 'mock-rf')[0];
    assert.notEqual(rfNode.props['data-rf-props'].fitView, true, 'ReactFlow fitView prop should be controlled per ruleKey, not forced unconditionally');
    rfNode.props['data-rf-props'].onInit(fakeRf);
    tree = await harness.mountAndFlush(FlowCanvas, {
      ruleKey: 'rule_alpha', graph, nodeTypes: [], inspectorOpen: false, xyflowOverride: mockXyflow,
    });
    assert.equal(fitCount, 1, 'Initial mount should fit view once for rule_alpha');

    // Toggle inspectorOpen -> resizes container -> must NOT reset viewport via fitView
    tree = await harness.mountAndFlush(FlowCanvas, {
      ruleKey: 'rule_alpha', graph, nodeTypes: [], inspectorOpen: true, xyflowOverride: mockXyflow,
    });
    for (const cb of resizeCallbacks) cb([{ contentRect: { width: 520, height: 600 } }]);
    await new Promise((r) => setTimeout(r, 220));
    assert.equal(fitCount, 1, 'Opening Inspector / ResizeObserver resize MUST NOT call fitView again');

    // Switching ruleKey fits view once for the new rule
    await harness.mountAndFlush(FlowCanvas, {
      ruleKey: 'rule_beta', graph, nodeTypes: [], inspectorOpen: true, xyflowOverride: mockXyflow,
    });
    assert.equal(fitCount, 2, 'Switching ruleKey should fit view once for the new rule');
  } finally {
    globalThis.ResizeObserver = origResizeObserver;
  }
});

test('dxosStudio:listAutomationRules action delegates cleanly and enforces manager/admin ACL (P0-07)', async () => {
  const { createDxosStudioActions } = require(path.join(PLUGIN_ROOT, 'src/server/studio-resource.js'));
  const serverIndexSrc = fs.readFileSync(path.join(PLUGIN_ROOT, 'src/server/index.js'), 'utf8');
  assert.match(serverIndexSrc, /acl\.allow\(\s*'dxosStudio'\s*,\s*\[[^\]]*'listAutomationRules'[^\]]*\]\s*,\s*'loggedIn'\s*\)/);

  const mockDb = {
    getRepository(name) {
      if (name === 'rolesUsers') {
        return {
          async find({ filter }) {
            if (filter?.userId === 10) return [{ userId: 10, roleName: 'ldx_manager' }];
            if (filter?.userId === 11) return [{ userId: 11, roleName: 'ldx_employee' }];
            return [];
          },
        };
      }
      if (name === 'latticeEmployees') {
        return {
          async find({ filter }) {
            if (filter?.userId === 11) return [{ id: 2, userId: 11, organizationId: 'org-a', role: 'ldx_employee', active: true }];
            return [{ id: 1, userId: 10, organizationId: 'org-a', role: 'ldx_manager', active: true }];
          },
          async findOne({ filter }) {
            if (filter?.userId === 11) return { id: 2, userId: 11, organizationId: 'org-a', role: 'ldx_employee', active: true };
            return { id: 1, userId: 10, organizationId: 'org-a', role: 'ldx_manager', active: true };
          },
        };
      }
      if (name === 'latticeAutomationRules') {
        return {
          async find({ filter }) {
            assert.equal(filter.organizationId, 'org-a');
            return [{ id: 1, organizationId: 'org-a', ruleKey: 'rule_1', name: 'Rule 1', active: true }];
          },
        };
      }
      return { async find() { return []; }, async findOne() { return null; } };
    },
  };
  const actions = createDxosStudioActions(mockDb);
  assert.equal(typeof actions.listAutomationRules, 'function');

  const ctx = {
    method: 'GET',
    state: { currentUser: { id: 10, roles: [{ name: 'ldx_manager' }] }, currentRole: 'ldx_manager', organizationId: 'org-a' },
    action: { params: { organizationId: 'org-a' } },
    query: {},
  };
  await actions.listAutomationRules(ctx, async () => {});
  assert.equal(Array.isArray(ctx.body?.items), true);
  assert.equal(ctx.body.items[0].ruleKey, 'rule_1');

  const empCtx = {
    method: 'GET',
    state: { currentUser: { id: 11, roles: [{ name: 'ldx_employee' }] }, currentRole: 'ldx_employee', organizationId: 'org-a' },
    action: { params: { organizationId: 'org-a' } },
    query: {},
  };
  await assert.rejects(
    () => actions.listAutomationRules(empCtx, async () => {}),
    (err) => err?.status === 403 && err?.code === 'FORBIDDEN',
  );
});

test('flow-version-ui formats timestamps in +07:00 and localizes Live badge while retaining Draft indicator', () => {
  const { getVersionStatusMeta, renderVersionsModal } = require(path.join(PLUGIN_ROOT, 'src/client/flow-version-ui.js'));
  const React = createReactHarness().React;
  const h = React.createElement;

  const metaDraft = getVersionStatusMeta({ rule: { id: 1, publishedVersion: 2, graphJson: { nodes: [{ id: 'a' }] }, draftGraphJson: { nodes: [{ id: 'b' }] } }, dirty: false });
  assert.ok(metaDraft.label.includes('Draft'));
  assert.ok(metaDraft.label.includes('Đang chạy'));

  const modal = renderVersionsModal(h, {
    modal: {
      open: true,
      loading: false,
      items: [{ id: 1, version: 2, isCurrent: true, publishedBy: 'admin', publishedAt: '2026-11-26T02:30:00.000Z', note: 'Phát hành v2' }],
    },
    currentVersion: 2,
    busy: false,
    onRollback() {},
    onClose() {},
    btnS: () => ({}),
  });
  const modalText = textOf(modal);
  assert.ok(modalText.includes('Đang chạy'), 'Current version badge should display Đang chạy');
  assert.equal(/\bLive\b/.test(modalText), false, 'Should not leak raw English Live badge in modal');
  assert.ok(modalText.includes('2026-11-26 09:30') && modalText.includes('+07:00'), `Expected +07:00 timestamp, got: ${modalText}`);
});

test('Flow Studio UI components and server node schemas are localized in Vietnamese without banned domain terms', async () => {
  const harness = createReactHarness();
  const { createFlowListView } = require(path.join(PLUGIN_ROOT, 'src/client/flow/flow-list-view.js'));
  const { renderSettingsPopover, renderBlueprintsGallery, renderDslModal } = require(path.join(PLUGIN_ROOT, 'src/client/flow/flow-studio-helpers.js'));
  const { renderTraceIoView } = require(path.join(PLUGIN_ROOT, 'src/client/flow-inspector-extras.js'));
  const { createNodeInspector } = require(path.join(PLUGIN_ROOT, 'src/client/flow/node-inspector.js'));
  const { createPlaybackBar } = require(path.join(PLUGIN_ROOT, 'src/client/flow/playback-bar.js'));
  const { createNodePalette } = require(path.join(PLUGIN_ROOT, 'src/client/flow/node-palette.js'));
  const { createFlowCanvas } = require(path.join(PLUGIN_ROOT, 'src/client/flow/flow-canvas.js'));
  const { createFlowTestRunner } = require(path.join(PLUGIN_ROOT, 'src/client/flow/flow-test-runner.js'));
  const { createDefaultRegistry } = require(path.join(PLUGIN_ROOT, 'src/server/flow/registry.js'));

  const h = harness.React.createElement;
  const FlowListView = createFlowListView(harness.React);
  let listTree = await harness.mountAndFlush(FlowListView, {
    rules: [{ ruleKey: 'r1', name: 'Luồng 1', active: true, graphJson: { nodes: [{ id: 'a' }] } }],
    runs: [],
    blueprints: [],
    effectiveOrg: 'org-a',
  });
  collectNodes(listTree, (n) => n.props?.['data-testid'] === 'dxos-flow-delete-rule-r1')[0].props.onClick();
  listTree = await harness.mountAndFlush(FlowListView, {
    rules: [{ ruleKey: 'r1', name: 'Luồng 1', active: true, graphJson: { nodes: [{ id: 'a' }] } }],
    runs: [],
    blueprints: [],
    effectiveOrg: 'org-a',
  });
  const confirmText = textOf(collectNodes(listTree, (n) => n.props?.['data-testid'] === 'dxos-flow-delete-confirm-r1')[0]);
  assert.ok(confirmText.includes('Xác nhận') && confirmText.includes('Hủy'), `Expected Vietnamese Confirm/Cancel, got: ${confirmText}`);

  const settingsText = textOf(renderSettingsPopover(h, {
    doc: { rule: { ruleKey: 'r1', name: 'R1', active: true }, graph: { settings: {} } },
    handleRuleMeta() {},
    blueprintsCount: 1,
    onToggleBlueprints() {},
    onClose() {},
  }));
  assert.ok(settingsText.includes('Mã quy trình') && settingsText.includes('Tên quy trình'), settingsText);

  const bpText = textOf(renderBlueprintsGallery(h, { blueprints: [{ ruleKey: 'bp1', name: 'Mẫu 1', graphJson: { nodes: [] } }], onLoadBlueprint() {} }));
  assert.equal(bpText.includes('Load Blueprint'), false);

  const dslText = textOf(renderDslModal(h, { dsl: { open: true, format: 'json', text: '{}', error: null }, dslObj: () => ({}), serializeFlowDsl: () => '{}', setDsl() {}, handleImportDsl() {} }));
  assert.equal(dslText.includes('Import to Canvas'), false);

  const traceText = textOf(renderTraceIoView(h, { displayOut: null, formatJson: () => '', statusTone: () => 'ok', S: { card: {}, label: {} } }));
  assert.equal(traceText.includes('No test output'), false);

  const NodeInspector = createNodeInspector(harness.React);
  let inspTree = await harness.mountAndFlush(NodeInspector, {
    rule: { ruleKey: 'r1' },
    graph: { nodes: [{ id: 'n1', type: 'control.approval', label: 'Duyệt', config: {} }], edges: [] },
    selectedNode: 'n1',
    nodeSchema: { type: 'control.approval', inputSchema: { fields: [{ name: 'approverRole', label: 'Vai trò duyệt', type: 'role', required: true }] } },
    catalog: { roles: ['ldx_manager'] },
  });
  collectNodes(inspTree, (n) => n.props?.['data-testid'] === 'dxos-flow-inspector-tab-input')[0].props.onClick();
  inspTree = await harness.mountAndFlush(NodeInspector, {
    rule: { ruleKey: 'r1' },
    graph: { nodes: [{ id: 'n1', type: 'control.approval', label: 'Duyệt', config: {} }], edges: [] },
    selectedNode: 'n1',
    nodeSchema: { type: 'control.approval', inputSchema: { fields: [{ name: 'approverRole', label: 'Vai trò duyệt', type: 'role', required: true }] } },
    catalog: { roles: ['ldx_manager'] },
  });
  const inspInputText = textOf(inspTree);
  assert.equal(inspInputText.includes('Test This Node'), false, inspInputText);

  const PlaybackBar = createPlaybackBar(harness.React);
  const pbTree = await harness.mountAndFlush(PlaybackBar, {
    runs: [{ runUid: 'run-1', status: 'suspended', suspendedNodeId: 'n1', nodeStatesJson: { n1: { suspend: { approverRole: 'ldx_manager', title: 'Duyệt' } } }, stepTracesJson: [{ nodeId: 'n1', status: 'suspended', durationMs: 5 }] }],
    selectedRun: { runUid: 'run-1', status: 'suspended', suspendedNodeId: 'n1', nodeStatesJson: { n1: { suspend: { approverRole: 'ldx_manager', title: 'Duyệt' } } }, stepTracesJson: [{ nodeId: 'n1', status: 'suspended', durationMs: 5 }] },
    playbackIndex: 0,
    autoExpandSeq: 1,
  });
  const pbText = textOf(pbTree);
  assert.ok(pbText.includes('Phê duyệt') && pbText.includes('Từ chối'), pbText);
  assert.ok(pbText.includes('Cổng Phê duyệt'), pbText);

  const NodePalette = createNodePalette(harness.React);
  const palTree = await harness.mountAndFlush(NodePalette, { open: true, nodeTypes: [] });
  const palText = textOf(palTree);
  assert.ok(palText.includes('Điều khiển luồng') && palText.includes('Dữ liệu'), palText);

  const FlowCanvas = createFlowCanvas(harness.React, {});
  const canvasTree = await harness.mountAndFlush(FlowCanvas, { ruleKey: 'r1', graph: { version: 2, nodes: [], edges: [] }, nodeTypes: [] });
  const dockText = textOf(collectNodes(canvasTree, (n) => n.props?.['data-testid'] === 'dxos-flow-canvas-dock')[0]);
  assert.equal(dockText.includes('⊡ Fit'), false, dockText);
  assert.equal(dockText.includes('🗺 Map'), false, dockText);

  const FlowTestRunner = createFlowTestRunner(harness.React);
  const runnerTree = await harness.mountAndFlush(FlowTestRunner, { open: true, rule: { ruleKey: 'r1' }, graph: { nodes: [] } });
  assert.equal(textOf(runnerTree).includes('Test Payload Runner'), false);

  const reg = createDefaultRegistry();
  const approvalSchema = reg.listNodeSchemas().find((s) => s.type === 'control.approval');
  const approvalLabels = approvalSchema.inputSchema.fields.map((f) => f.label).join(' | ');
  for (const vnLabel of ['Vai trò duyệt', 'Tiêu đề phê duyệt', 'Tóm tắt quyết định', 'Mức độ rủi ro', 'Thời hạn (giờ)']) {
    assert.ok(approvalLabels.includes(vnLabel), `Expected "${vnLabel}" in control.approval fields: ${approvalLabels}`);
  }

  // Residual Flow Studio Vietnamese parity checks (ai.agent schema, NodeInspector variable groups, DEFAULT_BLUEPRINTS)
  const aiAgentSchema = reg.listNodeSchemas().find((s) => s.type === 'ai.agent');
  assert.equal(aiAgentSchema.label, 'Đề xuất Phân loại AI');
  assert.equal(aiAgentSchema.description.includes('Creates a governed AI proposal'), false);

  collectNodes(inspTree, (n) => n.props?.['data-testid'] === 'dxos-flow-inspector-tab-config')[0].props.onClick();
  inspTree = await harness.mountAndFlush(NodeInspector, {
    rule: { ruleKey: 'r1' },
    graph: { nodes: [{ id: 'n1', type: 'control.approval', label: 'Duyệt', config: {} }], edges: [] },
    selectedNode: 'n1',
    nodeSchema: { type: 'control.approval', inputSchema: { fields: [{ name: 'approverRole', label: 'Vai trò duyệt', type: 'role', required: true }] } },
    catalog: { roles: ['ldx_manager'] },
  });
  collectNodes(inspTree, (n) => n.props?.['data-testid'] === 'dxos-flow-var-picker-btn')[0].props.onClick();
  inspTree = await harness.mountAndFlush(NodeInspector, {
    rule: { ruleKey: 'r1' },
    graph: { nodes: [{ id: 'n1', type: 'control.approval', label: 'Duyệt', config: {} }], edges: [] },
    selectedNode: 'n1',
    nodeSchema: { type: 'control.approval', inputSchema: { fields: [{ name: 'approverRole', label: 'Vai trò duyệt', type: 'role', required: true }] } },
    catalog: { roles: ['ldx_manager'] },
  });
  const varPickerText = textOf(collectNodes(inspTree, (n) => n.props?.['data-testid'] === 'dxos-flow-var-picker-panel')[0]);
  for (const enTerm of ['Event & Trigger', 'DMN Outputs', 'Ancestors', 'Loop Context']) {
    assert.equal(varPickerText.includes(enTerm), false, `Expected Vietnamese variable group instead of "${enTerm}" in: ${varPickerText}`);
  }
  for (const vnTerm of ['Sự kiện & Kích hoạt', 'Đầu ra DMN', 'Bước trước', 'Ngữ cảnh Vòng lặp']) {
    assert.ok(varPickerText.includes(vnTerm), `Expected "${vnTerm}" in variable picker: ${varPickerText}`);
  }

  const { DEFAULT_BLUEPRINTS } = require(path.join(PLUGIN_ROOT, 'src/client/flow/flow-studio-helpers.js'));
  const bpNames = DEFAULT_BLUEPRINTS.map((b) => `${b.name} ${b.graphJson?.nodes?.map((n) => n.label).join(' ')}`).join(' | ');
  for (const enBp of ['Cold-Chain CMMS Emergency', 'Create Work Order', 'MKT Lot Quarantine', 'SLA Breach Escalation', 'Procurement HITL Approval', 'Director Approval', 'Scheduled AI Ops Digest', 'Partner B2B Webhook Sync', 'Call n8n Orchestrator']) {
    assert.equal(bpNames.includes(enBp), false, `Expected Vietnamese DEFAULT_BLUEPRINTS instead of "${enBp}"`);
  }
});
