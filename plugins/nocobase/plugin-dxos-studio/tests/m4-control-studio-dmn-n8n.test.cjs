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
  const callbacksByComponent = new WeakMap();
  let currentComponent = null;
  let stateIdx = 0;
  let effectIdx = 0;
  let memoIdx = 0;
  let callbackIdx = 0;
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
      const comp = currentComponent;
      const bucket = getBucket(statesByComponent, comp);
      const idx = stateIdx++;
      if (bucket.length <= idx) {
        bucket[idx] = typeof init === 'function' ? init() : init;
      }
      const setState = (next) => {
        bucket[idx] = typeof next === 'function' ? next(bucket[idx]) : next;
      };
      return [bucket[idx], setState];
    },
    useEffect(fn, deps) {
      const comp = currentComponent;
      const bucket = getBucket(effectsByComponent, comp);
      const idx = effectIdx++;
      const prev = bucket[idx];
      const changed = !prev || !Array.isArray(deps) || deps.length !== prev.deps?.length || deps.some((d, i) => !Object.is(d, prev.deps[i]));
      if (changed) {
        bucket[idx] = { deps: Array.isArray(deps) ? deps.slice() : null };
        pendingEffects.push(fn);
      }
    },
    useCallback(fn, deps) {
      const comp = currentComponent;
      const bucket = getBucket(callbacksByComponent, comp);
      const idx = callbackIdx++;
      const prev = bucket[idx];
      const changed = !prev || !Array.isArray(deps) || deps.length !== prev.deps?.length || deps.some((d, i) => !Object.is(d, prev.deps[i]));
      if (changed) {
        bucket[idx] = { deps: Array.isArray(deps) ? deps.slice() : null, fn };
      }
      return bucket[idx].fn;
    },
    useMemo(fn, deps) {
      const comp = currentComponent;
      const bucket = getBucket(memosByComponent, comp);
      const idx = memoIdx++;
      const prev = bucket[idx];
      const changed = !prev || !Array.isArray(deps) || deps.length !== prev.deps?.length || deps.some((d, i) => !Object.is(d, prev.deps[i]));
      if (changed) {
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

  async function mountAndFlush(ComponentFn, props = {}) {
    let tree = renderNode(React.createElement(ComponentFn, props));
    for (let pass = 0; pass < 6 && pendingEffects.length > 0; pass += 1) {
      const batch = pendingEffects.splice(0, pendingEffects.length);
      for (const eff of batch) {
        await eff();
      }
      await new Promise((resolve) => setImmediate(resolve));
      tree = renderNode(React.createElement(ComponentFn, props));
    }
    return tree;
  }

  return {
    React,
    render: (ComponentFn, props = {}) => renderNode(React.createElement(ComponentFn, props)),
    mountAndFlush,
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
        const fn = handlers[req.url];
        if (!fn) return { data: { data: {} } };
        const payload = await fn(req);
        return { data: { data: payload } };
      },
    }),
  };
  return { client, requests };
}

test('ConnectedAppsPanel: delete confirmation, n8n error surfacing, OAuth2 query parse, modal scroll, +07:00 timestamps & VN localization', async () => {
  const { createConnectedAppsPanel } = require(path.join(PLUGIN_ROOT, 'src/client/flow/connected-apps-panel.js'));
  const origWin = globalThis.window;
  try {
    globalThis.window = { location: { origin: 'http://127.0.0.1:13015', search: '?code=auth-code-99&state=st-99' } };
    const harness = createReactHarness();
    const { client, requests } = createApiMock({
      'dxosN8n:appCatalog': async () => ({ items: [] }),
      'dxosVault:list': async () => ({
        items: [
          { id: 1, connectorKey: 'slack-primary', name: 'Slack', appType: 'slack', authType: 'oauth2', oauthConnected: true, hasSecrets: true },
        ],
      }),
      'dxosN8n:status': async () => ({ ok: false, reason: 'N8N_UNREACHABLE' }),
      'dxosN8n:workflows': async () => { throw new Error('N8N_WF_503'); },
      'dxosN8n:executions': async () => ({
        data: [{ id: 'ex-1', workflowId: 'wf-1', status: 'error', startedAt: '2026-11-26T10:00:00.000Z' }],
      }),
      'dxosVault:delete': async () => ({ deleted: true }),
    });

    const Panel = createConnectedAppsPanel(client, harness.React, {}, {});
    let tree = await harness.mountAndFlush(Panel, { selectedOrg: 'org-a' });

    // OAuth2 query params auto-parsed and modal auto-opened with scroll constraints
    const modal = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-app-connect-modal')[0];
    assert.ok(modal, 'OAuth2 modal must auto-open when ?code=&state= present in URL');
    const modalCard = modal.children?.[0];
    assert.equal(modalCard?.props?.style?.maxHeight, '90vh');
    assert.equal(modalCard?.props?.style?.overflowY, 'auto');
    const codeInput = collectNodes(modal, (n) => n.props?.['data-testid'] === 'dxos-app-oauth-code-input')[0];
    assert.equal(codeInput?.props?.value, 'auth-code-99');

    // Close modal to inspect main panel
    collectNodes(modal, (n) => n.type === 'button' && textOf(n) === 'Đóng')[0].props.onClick();
    tree = await harness.mountAndFlush(Panel, { selectedOrg: 'org-a' });

    const fullText = textOf(tree);
    // n8n error surfaced in status banner
    assert.ok(fullText.includes('N8N_WF_503') || fullText.includes('N8N_UNREACHABLE'), `Expected n8n error surfaced in ${fullText}`);
    // Execution timestamp converted to +07:00
    assert.ok(fullText.includes('17:00') && fullText.includes('+07:00'), `Expected +07:00 execution timestamp in ${fullText}`);
    // Vietnamese localization
    assert.ok(!fullText.includes('OAuth2 Connected'), 'Must localize OAuth2 Connected');
    assert.ok(!fullText.includes('>Rotate<') && !fullText.includes('Rotate'), 'Must localize Rotate');

    // Delete confirmation guard: first click does NOT fire dxosVault:delete
    collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-app-delete-slack-primary')[0].props.onClick();
    tree = harness.render(Panel, { selectedOrg: 'org-a' });
    assert.equal(requests.some((r) => r.url === 'dxosVault:delete'), false);

    const confirmBtn = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-app-delete-confirm-slack-primary')[0];
    assert.ok(confirmBtn, 'Inline delete confirmation button must appear');
    await confirmBtn.props.onClick();
    assert.ok(requests.some((r) => r.url === 'dxosVault:delete' && r.data.connectorKey === 'slack-primary'));
    tree = harness.render(Panel, { selectedOrg: 'org-a' });
    assert.ok(textOf(tree).includes('Đã xóa'), 'Success feedback must be shown after delete');
  } finally {
    if (origWin === undefined) delete globalThis.window;
    else globalThis.window = origWin;
  }
});

test('N8nSetupModal surfaces wfRes.reason warning, adds delete connector confirmation, and localizes active/paused', async () => {
  const { createN8nSetupModal } = require(path.join(PLUGIN_ROOT, 'src/client/flow/n8n-setup-modal.js'));
  const harness = createReactHarness();
  const { client, requests } = createApiMock({
    'dxosVault:list': async () => ({
      items: [{ connectorKey: 'n8n-main', name: 'n8n Main', connectorType: 'n8n', baseUrl: 'http://n8n:5678', authType: 'hmac', hasSecrets: true }],
    }),
    'dxosN8n:workflows': async () => { throw new Error('N8N_API_KEY_INVALID'); },
    'dxosVault:delete': async () => ({ deleted: true }),
  });

  const Modal = createN8nSetupModal(harness.React);
  let tree = await harness.mountAndFlush(Modal, { open: true, api: client.useAPIClient(), organizationId: 'org-a' });
  const wfSection = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-n8n-modal-live-workflows')[0];
  assert.ok(textOf(wfSection).includes('N8N_API_KEY_INVALID'), 'Must display wfRes.reason warning in Section 4');

  // Delete connector with confirmation
  const delBtn = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-n8n-delete-n8n-main')[0];
  assert.ok(delBtn, 'N8nSetupModal must expose delete connector button');
  delBtn.props.onClick();
  tree = harness.render(Modal, { open: true, api: client.useAPIClient(), organizationId: 'org-a' });
  assert.equal(requests.some((r) => r.url === 'dxosVault:delete'), false);

  const confirmDel = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-n8n-delete-confirm-n8n-main')[0];
  assert.ok(confirmDel);
  await confirmDel.props.onClick();
  assert.ok(requests.some((r) => r.url === 'dxosVault:delete' && r.data.connectorKey === 'n8n-main'));
});

test('studio-settings enforces pre-flight allowConfigUI guard and surfaces loadOutbox errors', async () => {
  const { createDxosStudioSettingsPage } = require(path.join(PLUGIN_ROOT, 'src/client/studio-settings.js'));
  const harness = createReactHarness();

  // Case 1: non-admin with allowConfigUI === false -> 403 card, ZERO API calls
  const requests1 = [];
  const deniedClient = {
    useUIConfigurationPermissions: () => ({ allowConfigUI: false }),
    useAPIClient: () => ({
      async request(req) {
        requests1.push(req.url);
        return { data: { data: {} } };
      },
    }),
  };
  const DeniedPage = createDxosStudioSettingsPage(deniedClient, harness.React, {}, {});
  const deniedTree = await harness.mountAndFlush(DeniedPage);
  assert.equal(collectNodes(deniedTree, (n) => n.props?.['data-testid'] === 'dxos-studio-forbidden').length, 1);
  assert.equal(requests1.length, 0, 'Must NOT fire dxosStudio:* fetches when allowConfigUI is false');

  // Case 2: outboxDlqList error surfaces in feedback banner
  const { client: errClient } = createApiMock({
    'dxosStudio:listTemplates': async () => ({ items: [] }),
    'dxosStudio:listEmployees': async () => ({ items: [], organizations: ['org-a'], organizationCounts: { 'org-a': 1 } }),
    'dxosStudio:readiness': async () => ({ plugins: [] }),
    'dxosStudio:outboxDlqList': async () => { throw new Error('OUTBOX_QUERY_FAILED'); },
  });
  const Page = createDxosStudioSettingsPage(errClient, harness.React, {}, {});
  let tree = await harness.mountAndFlush(Page);
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-studio-tab-outbox')[0].props.onClick();
  tree = await harness.mountAndFlush(Page);
  assert.ok(textOf(tree).includes('OUTBOX_QUERY_FAILED') || textOf(tree).includes('Không tải được Outbox'), 'loadOutbox errors must surface in feedback banner');

  // Case 3: async permission hydration (allowConfigUI transitions false -> true) with stable api ref re-evaluates loadAll via uiDenied dep
  let allowConfig = false;
  let asyncFetches = 0;
  const stableAsyncApi = {
    async request() {
      asyncFetches += 1;
      return { data: { data: { items: [], organizations: ['org-a'], organizationCounts: { 'org-a': 1 }, plugins: [] } } };
    },
  };
  const asyncPermClient = {
    useUIConfigurationPermissions: () => ({ allowConfigUI: allowConfig }),
    useAPIClient: () => stableAsyncApi,
  };
  const AsyncPage = createDxosStudioSettingsPage(asyncPermClient, harness.React, {}, {});
  let asyncTree = await harness.mountAndFlush(AsyncPage);
  assert.equal(collectNodes(asyncTree, (n) => n.props?.['data-testid'] === 'dxos-studio-forbidden').length, 1);
  assert.equal(asyncFetches, 0);
  allowConfig = true;
  asyncTree = await harness.mountAndFlush(AsyncPage);
  assert.equal(collectNodes(asyncTree, (n) => n.props?.['data-testid'] === 'dxos-studio-forbidden').length, 0, 'loadAll must include uiDenied in deps so async permission grant clears forbidden state');
  assert.ok(asyncFetches > 0, 'loadAll must fetch studio data once uiDenied transitions to false');
});

test('DmnVisualEditor prevents header clipping, validates empty string simulation inline, renders boolean select, and localizes labels', async () => {
  const { createDmnVisualEditor } = require(path.join(PLUGIN_ROOT, 'src/client/dmn-visual-editor.js'));
  const harness = createReactHarness();
  const Editor = createDmnVisualEditor(harness.React, {});
  const cmmsTable = {
    tableKey: 'cmms_priority_routing_v1',
    name: 'CMMS Cold-Chain Fault Priority Routing',
    hitPolicy: 'FIRST',
    inputsJson: [
      { name: 'severity', type: 'string' },
      { name: 'isUrgent', type: 'boolean' },
    ],
    outputsJson: [{ name: 'priority', type: 'string' }],
    rulesJson: [{ when: { severity: 'critical', isUrgent: true }, then: { priority: 'P1' } }],
  };

  let evalCalls = 0;
  let tree = await harness.mountAndFlush(Editor, {
    table: cmmsTable,
    onEvaluate: async () => {
      evalCalls += 1;
      return { matched: true, hitPolicy: 'FIRST', matchedRuleIndex: 0, matchedRuleIndices: [0], outputs: { priority: 'P1' } };
    },
  });

  // Name input wrapper spans/widens cleanly
  const nameInput = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dmn-table-name-input')[0];
  assert.ok(nameInput.props.title === 'CMMS Cold-Chain Fault Priority Routing');

  // Boolean simulator input is a <select> with true/false
  const boolInput = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dmn-sim-input-isUrgent')[0];
  assert.equal(boolInput.type, 'select');

  // Clicking Chạy Mô Phỏng with empty string severity shows inline validation inside dmn-simulator-panel
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dmn-sim-run-btn')[0].props.onClick();
  tree = harness.render(Editor, { table: cmmsTable });
  assert.equal(evalCalls, 0, 'Empty string input must trigger inline validation before calling evaluate');
  const simPanel = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dmn-simulator-panel')[0];
  const simVal = collectNodes(simPanel, (n) => n.props?.['data-testid'] === 'dmn-sim-validation')[0];
  assert.ok(simVal && textOf(simVal).includes('severity'), 'Inline validation must name missing string input');

  // Fill severity and isUrgent and run -> localized Khớp: CÓ
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dmn-sim-input-severity')[0].props.onChange({ target: { value: 'critical' } });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dmn-sim-input-isUrgent')[0].props.onChange({ target: { value: 'true' } });
  tree = harness.render(Editor, { table: cmmsTable });
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dmn-sim-run-btn')[0].props.onClick();
  tree = harness.render(Editor, { table: cmmsTable });
  const simRes = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dmn-sim-result')[0];
  assert.ok(textOf(simRes).includes('Khớp: CÓ'));
  assert.ok(textOf(simRes).includes('Luật khớp'));
});

test('DmnVisualEditor allows mixed numeric 0 + empty string wildcard simulation while still blocking pure empty string inputs', async () => {
  const { createDmnVisualEditor } = require(path.join(PLUGIN_ROOT, 'src/client/dmn-visual-editor.js'));
  const harness = createReactHarness();
  const Editor = createDmnVisualEditor(harness.React, {});

  // 1. Mixed number (0) + optional string ('') must NOT falsely block simulation
  const mixedTable = {
    tableKey: 'coldchain_temp_tier_v1',
    name: 'Kiểm tra nhiệt độ 0°C và hạng đối tác',
    hitPolicy: 'FIRST',
    inputsJson: [
      { name: 'temperature', type: 'number' },
      { name: 'tier', type: 'string' },
    ],
    outputsJson: [{ name: 'action', type: 'string' }],
    rulesJson: [
      { when: { temperature: { op: 'lte', value: 0 }, tier: { op: 'any', value: null } }, then: { action: 'freeze_ok' } },
    ],
  };
  let mixedEvalCalls = 0;
  let mixedTree = await harness.mountAndFlush(Editor, {
    table: mixedTable,
    onEvaluate: async ({ context }) => {
      mixedEvalCalls += 1;
      assert.equal(context.temperature, 0);
      assert.equal(context.tier, '');
      return { matched: true, hitPolicy: 'FIRST', matchedRuleIndex: 0, matchedRuleIndices: [0], outputs: { action: 'freeze_ok' } };
    },
  });
  await collectNodes(mixedTree, (n) => n.props?.['data-testid'] === 'dmn-sim-run-btn')[0].props.onClick();
  mixedTree = harness.render(Editor, { table: mixedTable });
  assert.equal(mixedEvalCalls, 1, 'Numeric 0 alongside empty optional string must evaluate instead of false validation block');
  assert.equal(collectNodes(mixedTree, (n) => n.props?.['data-testid'] === 'dmn-sim-validation').length, 0);
  assert.ok(textOf(collectNodes(mixedTree, (n) => n.props?.['data-testid'] === 'dmn-sim-result')[0]).includes('freeze_ok'));

  // 2. cmms_priority_routing_v1 with default empty { severity: '', eventType: '' } MUST still show inline validation
  const cmmsRoutingTable = {
    tableKey: 'cmms_priority_routing_v1',
    name: 'Định tuyến Ưu tiên Sự cố Bảo trì (CMMS)',
    hitPolicy: 'FIRST',
    inputsJson: [
      { name: 'severity', type: 'string' },
      { name: 'eventType', type: 'string' },
    ],
    outputsJson: [{ name: 'workOrderPriority', type: 'string' }],
    rulesJson: [{ when: { severity: 'critical', eventType: 'alarm.triggered' }, then: { workOrderPriority: 'P1' } }],
  };
  let cmmsEvalCalls = 0;
  let cmmsTree = await harness.mountAndFlush(Editor, {
    table: cmmsRoutingTable,
    onEvaluate: async () => { cmmsEvalCalls += 1; return { matched: false }; },
  });
  await collectNodes(cmmsTree, (n) => n.props?.['data-testid'] === 'dmn-sim-run-btn')[0].props.onClick();
  cmmsTree = harness.render(Editor, { table: cmmsRoutingTable });
  assert.equal(cmmsEvalCalls, 0);
  const valBox = collectNodes(cmmsTree, (n) => n.props?.['data-testid'] === 'dmn-sim-validation')[0];
  assert.ok(valBox && textOf(valBox).includes('severity') && textOf(valBox).includes('eventType'));
});

test('governance-consoles and builder-broker-panels use +07:00 timestamps and Vietnamese button/header labels', async () => {
  const { createDxosGovernanceConsoles } = require(path.join(PLUGIN_ROOT, 'src/client/governance-consoles.js'));
  const { createBuilderBrokerPanels } = require(path.join(PLUGIN_ROOT, 'src/client/builder-broker-panels.js'));
  const harness = createReactHarness();

  const { client: govClient } = createApiMock({
    'dxosApiKeys:list': async () => ({
      items: [{ id: 1, name: 'Bot', keyPrefix: 'ldx_pat_ab', roleName: 'ldx_manager', scopes: ['read'], expiresAt: '2026-11-26T10:00:00.000Z', active: true }],
    }),
    'dxosDataGov:tierSummary': async () => ({}),
    'dxosDataGov:snapshots': async () => ({ items: [] }),
    'dxosDataGov:quarantineList': async () => ({
      items: [{ quarantineUid: 'Q-1', sourceSystem: 'mqtt', reasonCode: 'OUT_OF_RANGE', status: 'quarantined' }],
    }),
  });
  const Consoles = createDxosGovernanceConsoles(govClient, harness.React, {}, {});
  let govTree = await harness.mountAndFlush(Consoles, { initialSection: 'api-keys', selectedOrg: 'org-a' });
  assert.ok(textOf(govTree).includes('17:00') && textOf(govTree).includes('+07:00'));
  assert.ok(textOf(govTree).includes('Hoạt động'));

  govTree = await harness.mountAndFlush(Consoles, { activeSection: 'data-gov', selectedOrg: 'org-a' });
  assert.ok(textOf(govTree).includes('Phê duyệt / Phát hành'));
  assert.ok(textOf(govTree).includes('Từ chối'));

  const { client: bClient } = createApiMock({
    'dxosBroker:listDevices': async () => ({ items: [] }),
    'dxosBroker:orionEntities': async () => ({ matched: [], orionOnly: [], localOnly: [] }),
    'dxosBroker:orionListSubscriptions': async () => ({ items: [] }),
    'dxosEvents:listSubscriptions': async () => ({
      items: [{ id: 1, subscriptionKey: 's1', name: 'Sub 1', targetUrl: 'https://example.org', circuitState: 'open', active: true }],
    }),
    'dxosEvents:listDeliveries': async () => ({ items: [] }),
    'dxosVault:list': async () => ({ items: [] }),
    'dxosAutomations:listRules': async () => ({
      items: [{ id: 1, ruleKey: 'r1', name: 'Rule 1', triggerEventType: 'alarm.triggered', active: true }],
    }),
    'dxosAutomations:listRuns': async () => ({ items: [] }),
  });
  const { BrokerAndEventsPanel, VaultAndAutomationPanel } = createBuilderBrokerPanels(bClient, harness.React, {}, {});
  const brokerTree = await harness.mountAndFlush(BrokerAndEventsPanel, { selectedOrg: 'org-a' });
  assert.ok(textOf(brokerTree).includes('Đặt lại ngắt mạch'));
  const autoTree = await harness.mountAndFlush(VaultAndAutomationPanel, { selectedOrg: 'org-a' });
  assert.ok(textOf(autoTree).includes('Chạy ngay'));
});
