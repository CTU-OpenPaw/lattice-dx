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
const { readFileSync } = require('node:fs');
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
    useCallback(fn) {
      return fn;
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
      currentComponent = node.type;
      stateIdx = 0;
      effectIdx = 0;
      memoIdx = 0;
      let out;
      try {
        out = node.type(node.props || {});
      } finally {
        currentComponent = prevComp;
        stateIdx = prevS;
        effectIdx = prevE;
        memoIdx = prevM;
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

test('builder-broker-panels obeys SPDX, bundler, and security constraints', () => {
  const panelsPath = path.join(PLUGIN_ROOT, 'src/client/builder-broker-panels.js');
  const studioPath = path.join(PLUGIN_ROOT, 'src/client/studio-settings.js');
  const autoStudioPath = path.join(PLUGIN_ROOT, 'src/client/automation-studio-panel.js');
  const mod = require(panelsPath);

  assert.equal(typeof mod.createBuilderBrokerPanels, 'function');
  assert.equal(typeof mod.BrokerAndEventsPanel, 'function');
  assert.equal(typeof mod.VaultAndAutomationPanel, 'function');
  assert.equal(typeof mod.DomainBuilderAndTenantsPanel, 'function');

  for (const filePath of [panelsPath, studioPath, autoStudioPath]) {
    const src = readFileSync(filePath, 'utf8');
    assert.ok(src.includes('SPDX-License-Identifier: Apache-2.0'), `Missing SPDX header in ${filePath}`);
    assert.doesNotMatch(src, /require\(['"](?:react|antd|@nocobase\/client)['"]\)/, `Forbidden external require in ${filePath}`);
    assert.doesNotMatch(src, /\blocalStorage\b|\bsessionStorage\b/, `Must not access browser storage in ${filePath}`);
    assert.doesNotMatch(src, /dangerouslySetInnerHTML/, `Must never use dangerouslySetInnerHTML in ${filePath}`);
  }
  const autoSrc = readFileSync(autoStudioPath, 'utf8');
  assert.doesNotMatch(autoSrc, /require\(['"][^'"]+['"]\)/, 'automation-studio-panel.js must have ZERO require() calls');
});

test('studio-settings exposes Tabs 7-9 and GitOps Solution Bundle v3 heading', async () => {
  const { createDxosStudioSettingsPage } = require(path.join(PLUGIN_ROOT, 'src/client/studio-settings.js'));
  const harness = createReactHarness();
  const { client } = createApiMock({
    'dxosStudio:listTemplates': async () => ({ items: [] }),
    'dxosStudio:listEmployees': async () => ({ items: [], organizations: ['org-a'], organizationCounts: { 'org-a': 2 } }),
    'dxosStudio:readiness': async () => ({ plugins: [] }),
    'dxosBroker:listDevices': async () => ({ items: [] }),
    'dxosBroker:orionEntities': async () => ({ orionReachable: false, matched: [], orionOnly: [], localOnly: [] }),
    'dxosBroker:orionListSubscriptions': async () => ({ items: [] }),
    'dxosEvents:listEvents': async () => ({ items: [] }),
    'dxosEvents:listSubscriptions': async () => ({ items: [] }),
    'dxosEvents:listDeliveries': async () => ({ items: [] }),
    'dxosVault:list': async () => ({ items: [] }),
    'dxosAutomations:listRules': async () => ({ items: [] }),
    'dxosAutomations:listRuns': async () => ({ items: [] }),
    'dxosBuilder:listDomains': async () => ({ items: [] }),
    'dxosBuilder:listBusinessPacks': async () => ({ items: [] }),
    'dxosBuilder:listTenants': async () => ({ items: [] }),
  });

  const Page = createDxosStudioSettingsPage(client, harness.React, {}, {});
  let tree = await harness.mountAndFlush(Page);

  const tablist = collectNodes(tree, (n) => n.props?.role === 'tablist')[0];
  assert.ok(tablist);
  const tabs = collectNodes(tablist, (n) => n.props?.role === 'tab');
  assert.equal(tabs.length, 9);
  assert.deepEqual(
    tabs.map((t) => t.props['data-testid']),
    [
      'dxos-studio-tab-workflows',
      'dxos-studio-tab-portals',
      'dxos-studio-tab-plugins',
      'dxos-studio-tab-pof',
      'dxos-studio-tab-outbox',
      'dxos-studio-tab-gitops',
      'dxos-studio-tab-broker',
      'dxos-studio-tab-automation',
      'dxos-studio-tab-builder',
    ],
  );

  // Tab 6 shows Bundle v3
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-studio-tab-gitops')[0].props.onClick();
  tree = await harness.mountAndFlush(Page);
  assert.ok(JSON.stringify(tree).includes('GitOps Solution Bundle v3 (Schema · RBAC · Portals · Workflows · AI · Governance)'));

  // Tab 7 mounts BrokerAndEventsPanel
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-studio-tab-broker')[0].props.onClick();
  tree = await harness.mountAndFlush(Page);
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-studio-broker-panel').length, 1);

  // Tab 8 mounts VaultAndAutomationPanel
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-studio-tab-automation')[0].props.onClick();
  tree = await harness.mountAndFlush(Page);
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-studio-automation-panel').length, 1);

  // Tab 9 mounts DomainBuilderAndTenantsPanel
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-studio-tab-builder')[0].props.onClick();
  tree = await harness.mountAndFlush(Page);
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-studio-builder-panel').length, 1);
});

test('Tab 7 (BrokerAndEventsPanel): provisions MQTT device with one-time password reveal/dismiss, Orion-LD, and replays DLQ / resets circuit', async () => {
  const { createBuilderBrokerPanels } = require(path.join(PLUGIN_ROOT, 'src/client/builder-broker-panels.js'));
  const harness = createReactHarness();
  let devices = [
    {
      id: 1,
      organizationId: 'org-a',
      deviceKey: 'sensor-01',
      name: 'Kho Lạnh 01',
      mqttUsername: 'ldx_org-a_sensor-01',
      topicPrefix: 'latticedx/org-a/sensor-01',
      status: 'online',
      lastSeenAt: '2026-11-23T10:00:00.000Z',
    },
    {
      id: 2,
      organizationId: 'org-a',
      deviceKey: 'sensor-02',
      name: 'Kho Lạnh 02',
      mqttUsername: 'ldx_org-a_sensor-02',
      topicPrefix: 'latticedx/org-a/sensor-02',
      status: 'offline',
      lastSeenAt: '2026-11-23T09:00:00.000Z',
    },
  ];
  let orionSubs = [
    {
      id: 10,
      subscriptionKey: 'sub-temp',
      entityType: 'Asset',
      watchedAttributesJson: ['temperature'],
      notificationEndpoint: 'http://nocobase/api/dxosBroker:orionNotify',
      active: true,
    },
  ];
  let webhookSubs = [
    {
      id: 21,
      subscriptionKey: 'n8n-alert',
      name: 'n8n Alert Webhook',
      targetUrl: 'http://n8n:5678/webhook/coldchain',
      eventPattern: 'telemetry.*',
      circuitState: 'open',
      failureCount: 5,
      active: true,
    },
  ];
  let deliveries = [
    {
      id: 77,
      eventId: 'evt-77',
      subscriptionId: 21,
      eventType: 'telemetry.alarm',
      attempt: 5,
      maxAttempts: 5,
      status: 'dlq',
      httpStatus: 502,
      lastError: 'Bad Gateway',
    },
  ];

  const { client, requests } = createApiMock({
    'dxosBroker:listDevices': async () => ({ items: devices }),
    'dxosBroker:provisionDevice': async (req) => {
      const created = {
        id: 3,
        organizationId: 'org-a',
        deviceKey: req.data.deviceKey,
        name: req.data.name,
        mqttUsername: `ldx_org-a_${req.data.deviceKey}`,
        topicPrefix: `latticedx/org-a/${req.data.deviceKey}`,
        assetId: req.data.assetId || null,
        assetEntityId: req.data.assetEntityId || null,
        status: 'provisioned',
      };
      devices = [created, ...devices];
      return { device: created, mqttPassword: 'once-only-mqtt-pwd-999', brokerSynced: true };
    },
    'dxosBroker:revokeDevice': async (req) => {
      devices = devices.map((d) => (d.deviceKey === req.data.deviceKey ? { ...d, status: 'revoked' } : d));
      return { device: devices.find((d) => d.deviceKey === req.data.deviceKey), brokerSynced: true };
    },
    'dxosBroker:orionEntities': async () => ({
      orionReachable: true,
      matched: [{ entityId: 'urn:ngsi-ld:Asset:org-a:native:1', type: 'Asset', inSync: true, attrDiff: [] }],
      orionOnly: [{ entityId: 'urn:ngsi-ld:Asset:org-a:native:99', type: 'Asset' }],
      localOnly: [{ entityId: 'urn:ngsi-ld:Asset:org-a:native:2', type: 'Asset', name: 'Xe lạnh 02' }],
    }),
    'dxosBroker:orionListSubscriptions': async () => ({ items: orionSubs, orionReachable: true }),
    'dxosBroker:orionCreateSubscription': async (req) => {
      const sub = {
        id: 11,
        subscriptionKey: req.data.subscriptionKey,
        entityType: req.data.entityType,
        watchedAttributesJson: req.data.watchedAttributes,
        notificationEndpoint: 'http://nocobase/api/dxosBroker:orionNotify',
        active: true,
      };
      orionSubs = [sub, ...orionSubs];
      return { subscription: sub, orionSynced: true };
    },
    'dxosBroker:orionToggleSubscription': async (req) => {
      orionSubs = orionSubs.map((s) => (s.id === req.data.id ? { ...s, active: req.data.active } : s));
      return { subscription: orionSubs.find((s) => s.id === req.data.id) };
    },
    'dxosBroker:orionDeleteSubscription': async (req) => {
      orionSubs = orionSubs.filter((s) => s.id !== req.data.id);
      return { deleted: true, id: req.data.id };
    },
    'dxosEvents:listEvents': async () => ({
      items: [{ eventId: 'evt-77', eventType: 'telemetry.alarm', source: '/dxos/broker', occurredAt: '2026-11-23T10:05:00.000Z', status: 'partial_failed' }],
    }),
    'dxosEvents:listSubscriptions': async () => ({ items: webhookSubs }),
    'dxosEvents:listDeliveries': async () => ({ items: deliveries }),
    'dxosEvents:saveSubscription': async (req) => {
      const sub = { id: 22, ...req.data, hasSigningSecret: Boolean(req.data.signingSecret), circuitState: 'closed', failureCount: 0, active: true };
      webhookSubs = [sub, ...webhookSubs];
      return sub;
    },
    'dxosEvents:toggleSubscription': async (req) => {
      webhookSubs = webhookSubs.map((s) => (s.id === req.data.id ? { ...s, active: req.data.active } : s));
      return webhookSubs.find((s) => s.id === req.data.id);
    },
    'dxosEvents:deleteSubscription': async (req) => {
      webhookSubs = webhookSubs.filter((s) => s.id !== req.data.id);
      return { deleted: true, id: req.data.id };
    },
    'dxosEvents:resetCircuit': async (req) => {
      webhookSubs = webhookSubs.map((s) => (s.id === req.data.subscriptionId ? { ...s, circuitState: 'closed', failureCount: 0 } : s));
      return webhookSubs[0];
    },
    'dxosEvents:dispatchNow': async () => ({ processedCount: 1, deliveredCount: 1, retryWaitCount: 0, dlqCount: 0 }),
    'dxosEvents:replayDlq': async (req) => {
      deliveries = deliveries.map((d) => (req.data.deliveryIds.includes(d.id) ? { ...d, status: 'pending', attempt: 0 } : d));
      return { replayedCount: req.data.deliveryIds.length, deliveryIds: req.data.deliveryIds };
    },
  });

  const { BrokerAndEventsPanel } = createBuilderBrokerPanels(client, harness.React, {}, {});
  let tree = await harness.mountAndFlush(BrokerAndEventsPanel, { selectedOrg: 'org-a' });
  const initialDump = JSON.stringify(tree);
  assert.ok(initialDump.includes('sensor-01'));
  assert.ok(initialDump.includes('Orion-LD: Trực tuyến'));
  assert.ok(initialDump.includes('telemetry.alarm'));
  assert.ok(initialDump.includes('open (5)'));

  // Provision MQTT device -> reveals one-time password, then dismiss clears it
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-broker-device-key-input')[0].props.onChange({ target: { value: 'sensor-03' } });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-broker-device-name-input')[0].props.onChange({ target: { value: 'Kho Lạnh 03' } });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-broker-device-assetid-input')[0].props.onChange({ target: { value: '15' } });
  tree = harness.render(BrokerAndEventsPanel, { selectedOrg: 'org-a' });
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-broker-device-form')[0].props.onSubmit({ preventDefault() {} });
  tree = harness.render(BrokerAndEventsPanel, { selectedOrg: 'org-a' });

  const provReq = requests.find((r) => r.url === 'dxosBroker:provisionDevice');
  assert.ok(provReq);
  assert.equal(provReq.data.deviceKey, 'sensor-03');
  assert.equal(provReq.data.assetId, 15);
  const pwdBanner = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-broker-mqtt-password-once')[0];
  assert.ok(pwdBanner, 'One-time mqttPassword banner must appear');
  assert.ok(textOf(pwdBanner).includes('once-only-mqtt-pwd-999'));

  // Dismiss clears one-time password from DOM
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-broker-dismiss-password-btn')[0].props.onClick();
  tree = harness.render(BrokerAndEventsPanel, { selectedOrg: 'org-a' });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-broker-mqtt-password-once').length, 0);
  assert.equal(JSON.stringify(tree).includes('once-only-mqtt-pwd-999'), false);

  // Revoke device
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-broker-device-revoke-sensor-01')[0].props.onClick();
  assert.ok(requests.some((r) => r.url === 'dxosBroker:revokeDevice' && r.data.deviceKey === 'sensor-01'));

  // Orion-LD Create / Toggle / Delete Subscription
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-broker-orion-sub-key-input')[0].props.onChange({ target: { value: 'sub-hum' } });
  tree = harness.render(BrokerAndEventsPanel, { selectedOrg: 'org-a' });
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-broker-orion-sub-form')[0].props.onSubmit({ preventDefault() {} });
  assert.ok(requests.some((r) => r.url === 'dxosBroker:orionCreateSubscription' && r.data.subscriptionKey === 'sub-hum'));
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-broker-orion-sub-toggle-10')[0].props.onClick();
  assert.ok(requests.some((r) => r.url === 'dxosBroker:orionToggleSubscription' && r.data.id === 10 && r.data.active === false));
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-broker-orion-sub-delete-10')[0].props.onClick();
  assert.ok(requests.some((r) => r.url === 'dxosBroker:orionDeleteSubscription' && r.data.id === 10));

  // Save Webhook Subscription (clears signingSecret), Toggle & Delete Webhook Subscription
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-events-sub-key-input')[0].props.onChange({ target: { value: 'erp-sync' } });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-events-sub-name-input')[0].props.onChange({ target: { value: 'ERP Sync' } });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-events-sub-url-input')[0].props.onChange({ target: { value: 'https://erp.example.com/events' } });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-events-sub-secret-input')[0].props.onChange({ target: { value: 'whsec_test_only_999' } });
  tree = harness.render(BrokerAndEventsPanel, { selectedOrg: 'org-a' });
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-events-webhook-sub-form')[0].props.onSubmit({ preventDefault() {} });
  tree = harness.render(BrokerAndEventsPanel, { selectedOrg: 'org-a' });
  assert.ok(requests.some((r) => r.url === 'dxosEvents:saveSubscription' && r.data.subscriptionKey === 'erp-sync' && r.data.signingSecret === 'whsec_test_only_999'));
  assert.equal(JSON.stringify(tree).includes('whsec_test_only_999'), false, 'signingSecret must be cleared after save');
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-events-sub-toggle-21')[0].props.onClick();
  assert.ok(requests.some((r) => r.url === 'dxosEvents:toggleSubscription' && r.data.id === 21));
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-events-sub-delete-21')[0].props.onClick();
  assert.ok(requests.some((r) => r.url === 'dxosEvents:deleteSubscription' && r.data.id === 21));

  // Reset Circuit, Dispatch Now, Replay DLQ
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-events-sub-reset-21')[0].props.onClick();
  assert.ok(requests.some((r) => r.url === 'dxosEvents:resetCircuit' && r.data.subscriptionId === 21));
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-events-dispatch-btn')[0].props.onClick();
  assert.ok(requests.some((r) => r.url === 'dxosEvents:dispatchNow'));
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-events-replay-dlq-77')[0].props.onClick();
  assert.ok(requests.some((r) => r.url === 'dxosEvents:replayDlq' && Array.isArray(r.data.deliveryIds) && r.data.deliveryIds[0] === 77));
});

test('Tab 8 (VaultAndAutomationPanel): saves/tests/rotates secrets without leaking plaintext, runs & replays automations with trace', async () => {
  const { createBuilderBrokerPanels } = require(path.join(PLUGIN_ROOT, 'src/client/builder-broker-panels.js'));
  const harness = createReactHarness();
  let connectors = [
    {
      id: 1,
      connectorKey: 'n8n-prod',
      name: 'n8n Server',
      connectorType: 'n8n',
      baseUrl: 'http://n8n:5678',
      authType: 'bearer',
      hasSecrets: true,
      secretKeys: ['token'],
      secretVersion: 1,
      lastTestStatus: 'ok',
    },
  ];
  let rules = [
    {
      id: 10,
      ruleKey: 'auto_cmms_on_coldchain_fault',
      name: 'Cold-Chain CMMS',
      triggerEventType: 'telemetry.alarm',
      dmnTableKey: 'cmms_priority_routing_v1',
      actionsJson: [{ type: 'create_record', collection: 'latticeCustomWorkOrders' }],
      active: true,
    },
  ];
  let runs = [
    {
      id: 501,
      runId: 'run-501',
      ruleKey: 'auto_cmms_on_coldchain_fault',
      status: 'succeeded',
      durationMs: 42,
      startedAt: '2026-11-23T11:00:00.000Z',
      stepTracesJson: [
        { stage: 'trigger', status: 'ok', durationMs: 2 },
        { stage: 'dmn', tableKey: 'cmms_priority_routing_v1', status: 'ok', durationMs: 8 },
        { stage: 'action', type: 'create_record', status: 'ok', durationMs: 32 },
      ],
    },
  ];

  const { client, requests } = createApiMock({
    'dxosVault:list': async () => ({ items: connectors }),
    'dxosVault:save': async (req) => {
      const saved = {
        id: 2,
        connectorKey: req.data.connectorKey,
        name: req.data.name,
        connectorType: req.data.connectorType,
        baseUrl: req.data.baseUrl,
        authType: req.data.authType,
        hasSecrets: Boolean(req.data.secrets),
        secretKeys: req.data.secrets ? Object.keys(req.data.secrets) : [],
        secretVersion: 1,
        lastTestStatus: null,
      };
      connectors = [saved, ...connectors];
      return saved;
    },
    'dxosVault:testConnection': async (req) => ({
      ok: true,
      statusCode: 200,
      latencyMs: 14,
      message: 'Endpoint reachable',
      connectorKey: req.data.connectorKey,
      lastTestStatus: 'ok',
    }),
    'dxosVault:rotateSecret': async (req) => {
      connectors = connectors.map((c) => (c.connectorKey === req.data.connectorKey ? { ...c, secretVersion: c.secretVersion + 1 } : c));
      return connectors.find((c) => c.connectorKey === req.data.connectorKey);
    },
    'dxosVault:delete': async (req) => {
      connectors = connectors.filter((c) => c.connectorKey !== req.data.connectorKey);
      return { deleted: true, connectorKey: req.data.connectorKey };
    },
    'dxosAutomations:listRules': async () => ({ items: rules }),
    'dxosAutomations:saveRule': async (req) => {
      const created = { id: 11, ...req.data, actionsJson: req.data.actions };
      rules = [created, ...rules];
      return { rule: created };
    },
    'dxosAutomations:toggleRule': async (req) => {
      rules = rules.map((r) => (r.ruleKey === req.data.ruleKey ? { ...r, active: req.data.active } : r));
      return { rule: rules.find((r) => r.ruleKey === req.data.ruleKey) };
    },
    'dxosAutomations:deleteRule': async (req) => {
      rules = rules.filter((r) => r.ruleKey !== req.data.ruleKey);
      return { deleted: true, ruleKey: req.data.ruleKey };
    },
    'dxosAutomations:runNow': async (req) => {
      const newRun = {
        id: 502,
        runId: 'run-502',
        ruleKey: req.data.ruleKey,
        status: 'succeeded',
        durationMs: 19,
        stepTracesJson: [{ stage: 'trigger', status: 'ok', durationMs: 19 }],
      };
      runs = [newRun, ...runs];
      return { run: newRun };
    },
    'dxosAutomations:listRuns': async () => ({ items: runs }),
    'dxosAutomations:replayRun': async (req) => ({ run: { id: 503, runId: 'run-503', status: 'succeeded', durationMs: 15, replayedFrom: req.data.runId } }),
  });

  const { VaultAndAutomationPanel } = createBuilderBrokerPanels(client, harness.React, {}, {});
  let tree = await harness.mountAndFlush(VaultAndAutomationPanel, { selectedOrg: 'org-a' });

  // Save connector with secret -> clears secret input immediately and never renders plaintext secret
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-vault-key-input')[0].props.onChange({ target: { value: 'erp-webhook' } });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-vault-name-input')[0].props.onChange({ target: { value: 'ERP Webhook' } });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-vault-url-input')[0].props.onChange({ target: { value: 'https://erp.example.com/hook' } });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-vault-secrets-input')[0].props.onChange({ target: { value: '{"token":"super-secret-xyz-123"}' } });
  tree = harness.render(VaultAndAutomationPanel, { selectedOrg: 'org-a' });
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-vault-save-form')[0].props.onSubmit({ preventDefault() {} });
  tree = harness.render(VaultAndAutomationPanel, { selectedOrg: 'org-a' });

  const saveVaultReq = requests.find((r) => r.url === 'dxosVault:save');
  assert.ok(saveVaultReq);
  assert.deepEqual(saveVaultReq.data.secrets, { token: 'super-secret-xyz-123' });
  assert.equal(JSON.stringify(tree).includes('super-secret-xyz-123'), false, 'Saved plaintext secret must never remain in UI state/DOM');

  // Test Connection
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-vault-test-n8n-prod')[0].props.onClick();
  tree = harness.render(VaultAndAutomationPanel, { selectedOrg: 'org-a' });
  assert.ok(requests.some((r) => r.url === 'dxosVault:testConnection' && r.data.connectorKey === 'n8n-prod'));
  const testBanner = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-vault-test-result')[0];
  assert.ok(testBanner && textOf(testBanner).includes('Endpoint reachable'));

  // Rotate Secret
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-vault-rotate-open-n8n-prod')[0].props.onClick();
  tree = harness.render(VaultAndAutomationPanel, { selectedOrg: 'org-a' });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-vault-rotate-input')[0].props.onChange({ target: { value: 'rotated-tok-999' } });
  tree = harness.render(VaultAndAutomationPanel, { selectedOrg: 'org-a' });
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-vault-rotate-form')[0].props.onSubmit({ preventDefault() {} });
  tree = harness.render(VaultAndAutomationPanel, { selectedOrg: 'org-a' });
  assert.ok(requests.some((r) => r.url === 'dxosVault:rotateSecret' && r.data.connectorKey === 'n8n-prod' && r.data.secrets.token === 'rotated-tok-999'));
  assert.equal(JSON.stringify(tree).includes('rotated-tok-999'), false);

  // Automation Rule Run Now, Trace Inspector, Replay
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-run-auto_cmms_on_coldchain_fault')[0].props.onClick();
  tree = harness.render(VaultAndAutomationPanel, { selectedOrg: 'org-a' });
  const runReq = requests.find((r) => r.url === 'dxosAutomations:runNow');
  assert.ok(runReq && runReq.data.ruleKey === 'auto_cmms_on_coldchain_fault');
  assert.equal(runReq.data.sampleEvent.type, 'telemetry.alarm');

  const traceBox = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-trace-inspector')[0];
  assert.ok(traceBox, 'Execution trace inspector must render stepTracesJson');
  assert.ok(textOf(traceBox).includes('19 ms'));

  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-replay-run-501')[0].props.onClick();
  assert.ok(requests.some((r) => r.url === 'dxosAutomations:replayRun' && r.data.runId === 'run-501'));

  // Save, Toggle, Delete Automation Rule & Delete Vault Connector
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-rule-key-input')[0].props.onChange({ target: { value: 'rule_new_01' } });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-rule-name-input')[0].props.onChange({ target: { value: 'New Rule 01' } });
  tree = harness.render(VaultAndAutomationPanel, { selectedOrg: 'org-a' });
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-rule-form')[0].props.onSubmit({ preventDefault() {} });
  assert.ok(requests.some((r) => r.url === 'dxosAutomations:saveRule' && r.data.ruleKey === 'rule_new_01'));
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-toggle-auto_cmms_on_coldchain_fault')[0].props.onClick();
  assert.ok(requests.some((r) => r.url === 'dxosAutomations:toggleRule' && r.data.ruleKey === 'auto_cmms_on_coldchain_fault'));
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-delete-auto_cmms_on_coldchain_fault')[0].props.onClick();
  assert.ok(requests.some((r) => r.url === 'dxosAutomations:deleteRule' && r.data.ruleKey === 'auto_cmms_on_coldchain_fault'));
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-vault-delete-n8n-prod')[0].props.onClick();
  assert.ok(requests.some((r) => r.url === 'dxosVault:delete' && r.data.connectorKey === 'n8n-prod'));
});

test('Tab 9 (DomainBuilderAndTenantsPanel): creates latticeCustom* domain, installs CMMS pack, provisions tenant without retaining password', async () => {
  const { createBuilderBrokerPanels } = require(path.join(PLUGIN_ROOT, 'src/client/builder-broker-panels.js'));
  const harness = createReactHarness();
  const openedRoutes = [];
  let domains = [
    {
      collectionName: 'latticeCustomWorkOrders',
      title: 'Lệnh Bảo trì CMMS',
      routePath: '/p/cmms',
      fields: [{ name: 'code', type: 'string', required: true }],
      roles: ['ldx_admin', 'ldx_operator'],
      rlsActive: true,
    },
  ];
  let packs = [
    {
      packKey: 'cmms-maintenance',
      title: 'Bảo trì Thiết bị CMMS',
      routePath: '/p/cmms',
      installed: false,
    },
  ];
  let tenants = [
    {
      organizationId: 'org-a',
      name: 'Tổng công ty Minh Tâm',
      region: 'VN-SG',
      departmentCount: 4,
      employeeCount: 25,
      pkiKeyId: 'ed25519-01',
      pkiActive: true,
      active: true,
    },
  ];

  const { client, requests } = createApiMock({
    'dxosBuilder:listDomains': async () => ({ items: domains }),
    'dxosBuilder:createDomain': async (req) => {
      const created = { ...req.data, rlsActive: true };
      domains = [created, ...domains];
      return created;
    },
    'dxosBuilder:listBusinessPacks': async () => ({ items: packs }),
    'dxosBuilder:installBusinessPack': async (req) => {
      packs = packs.map((p) => (p.packKey === req.data.packKey ? { ...p, installed: true } : p));
      return { packKey: req.data.packKey, collectionName: 'latticeCustomWorkOrders', routePath: '/p/cmms' };
    },
    'dxosBuilder:listTenants': async () => ({ items: tenants }),
    'dxosBuilder:provisionTenant': async (req) => {
      const t = {
        organizationId: req.data.organizationId,
        name: req.data.name,
        region: req.data.region,
        departmentCount: 3,
        employeeCount: 1,
        pkiActive: true,
        active: true,
      };
      tenants = [...tenants, t];
      return { organizationId: req.data.organizationId, organization: t };
    },
  });

  const { DomainBuilderAndTenantsPanel } = createBuilderBrokerPanels(client, harness.React, {}, {});
  let tree = await harness.mountAndFlush(DomainBuilderAndTenantsPanel, {
    selectedOrg: 'org-a',
    openRoute: (p) => openedRoutes.push(p),
  });
  const dump = JSON.stringify(tree);
  assert.ok(dump.includes('Bảo trì Thiết bị CMMS'));
  assert.ok(dump.includes('latticeCustomWorkOrders'));
  assert.ok(dump.includes('RLS Active'));
  assert.ok(dump.includes('ed25519-01'));

  // Install 1-click CMMS Business Pack & Open CMMS Portal
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-builder-install-cmms-btn')[0].props.onClick();
  assert.ok(requests.some((r) => r.url === 'dxosBuilder:installBusinessPack' && r.data.packKey === 'cmms-maintenance'));
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-builder-open-cmms-btn')[0].props.onClick();
  assert.deepEqual(openedRoutes, ['/p/cmms']);

  // Create custom domain via Domain Builder
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-builder-collection-input')[0].props.onChange({ target: { value: 'latticeCustomAudits' } });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-builder-routepath-input')[0].props.onChange({ target: { value: '/p/audits' } });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-builder-add-field-btn')[0].props.onClick();
  tree = harness.render(DomainBuilderAndTenantsPanel, { selectedOrg: 'org-a', openRoute: (p) => openedRoutes.push(p) });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-builder-field-name-2')[0].props.onChange({ target: { value: 'score' } });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-builder-field-type-2')[0].props.onChange({ target: { value: 'integer' } });
  tree = harness.render(DomainBuilderAndTenantsPanel, { selectedOrg: 'org-a', openRoute: (p) => openedRoutes.push(p) });
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-builder-domain-form')[0].props.onSubmit({ preventDefault() {} });

  const domainReq = requests.find((r) => r.url === 'dxosBuilder:createDomain');
  assert.ok(domainReq);
  assert.equal(domainReq.data.collectionName, 'latticeCustomAudits');
  assert.equal(domainReq.data.routePath, '/p/audits');
  assert.equal(domainReq.data.fields.length, 3);
  assert.equal(domainReq.data.fields[2].name, 'score');
  assert.equal(domainReq.data.fields[2].type, 'integer');

  // Provision subsidiary tenant -> clears adminPassword from DOM/state
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-builder-tenant-org-input')[0].props.onChange({ target: { value: 'org-cantho' } });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-builder-tenant-name-input')[0].props.onChange({ target: { value: 'Chi nhánh Cần Thơ' } });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-builder-tenant-username-input')[0].props.onChange({ target: { value: 'admin_ct' } });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-builder-tenant-email-input')[0].props.onChange({ target: { value: 'ct@latticedx.vn' } });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-builder-tenant-password-input')[0].props.onChange({ target: { value: 'SecretInitPass#2026' } });
  tree = harness.render(DomainBuilderAndTenantsPanel, { selectedOrg: 'org-a' });
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-builder-tenant-form')[0].props.onSubmit({ preventDefault() {} });
  tree = harness.render(DomainBuilderAndTenantsPanel, { selectedOrg: 'org-a' });

  const tenantReq = requests.find((r) => r.url === 'dxosBuilder:provisionTenant');
  assert.ok(tenantReq);
  assert.equal(tenantReq.data.organizationId, 'org-cantho');
  assert.equal(tenantReq.data.adminPassword, 'SecretInitPass#2026');
  assert.equal(JSON.stringify(tree).includes('SecretInitPass#2026'), false, 'Admin password must be cleared immediately after submit');
});

test('error handling and client-side validation surface errors without calling API on malformed input', async () => {
  const { createBuilderBrokerPanels } = require(path.join(PLUGIN_ROOT, 'src/client/builder-broker-panels.js'));
  const harness = createReactHarness();
  const feedbackCalls = [];
  const { client, requests } = createApiMock({
    'dxosVault:list': async () => {
      throw Object.assign(new Error('Vault unreachable'), { response: { data: { errors: [{ message: 'Vault DB error 503' }] } } });
    },
    'dxosAutomations:listRules': async () => ({ items: [] }),
    'dxosAutomations:listRuns': async () => ({ items: [] }),
    'dxosBuilder:listDomains': async () => ({ items: [] }),
    'dxosBuilder:listBusinessPacks': async () => ({ items: [] }),
    'dxosBuilder:listTenants': async () => ({ items: [] }),
  });

  const { VaultAndAutomationPanel, DomainBuilderAndTenantsPanel } = createBuilderBrokerPanels(client, harness.React, {}, {});
  let tree = await harness.mountAndFlush(VaultAndAutomationPanel, {
    selectedOrg: 'org-a',
    setFeedback: (fb) => feedbackCalls.push(fb),
  });
  assert.ok(feedbackCalls.some((f) => f && f.type === 'error' && f.text.includes('Vault DB error 503')));

  // Malformed Actions JSON blocks saveRule API call
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-actions-json')[0].props.onChange({ target: { value: '{broken' } });
  tree = harness.render(VaultAndAutomationPanel, { selectedOrg: 'org-a', setFeedback: (fb) => feedbackCalls.push(fb) });
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-rule-form')[0].props.onSubmit({ preventDefault() {} });
  assert.equal(requests.some((r) => r.url === 'dxosAutomations:saveRule'), false);
  assert.ok(feedbackCalls.some((f) => f && f.type === 'error' && f.text.includes('JSON')));

  // Invalid non-latticeCustom collectionName blocks createDomain API call
  const builderFeedback = [];
  let bTree = await harness.mountAndFlush(DomainBuilderAndTenantsPanel, {
    selectedOrg: 'org-a',
    setFeedback: (fb) => builderFeedback.push(fb),
  });
  collectNodes(bTree, (n) => n.props?.['data-testid'] === 'dxos-builder-collection-input')[0].props.onChange({ target: { value: 'users' } });
  bTree = harness.render(DomainBuilderAndTenantsPanel, { selectedOrg: 'org-a', setFeedback: (fb) => builderFeedback.push(fb) });
  await collectNodes(bTree, (n) => n.props?.['data-testid'] === 'dxos-builder-domain-form')[0].props.onSubmit({ preventDefault() {} });
  assert.equal(requests.some((r) => r.url === 'dxosBuilder:createDomain'), false);
  assert.ok(builderFeedback.some((f) => f && f.type === 'error' && f.text.includes('latticeCustom')));
});

test('Visual Automation Studio: Blueprint Gallery, 5-step branching Canvas, Filter/Cooldown save preservation, Dry-Run highlighting, and graceful catalog fallback', async () => {
  const { createBuilderBrokerPanels } = require(path.join(PLUGIN_ROOT, 'src/client/builder-broker-panels.js'));
  const harness = createReactHarness();
  const feedbackCalls = [];
  const rules = [
    {
      id: 1,
      ruleKey: 'existing_cold_rule',
      name: 'Existing Cold Rule',
      triggerEventType: 'alarm.triggered',
      filterJson: { temperature: { $gte: 8 } },
      dmnTableKey: 'cmms_priority_routing_v1',
      cooldownSec: 45,
      maxDepth: 6,
      actionsJson: [
        { type: 'create_record', label: 'Mở CMMS', collection: 'latticeCustomWorkOrders', values: { title: 'WO {{data.deviceKey}}' } },
      ],
      active: true,
    },
  ];

  const { client, requests } = createApiMock({
    'dxosVault:list': async () => ({
      items: [{ connectorKey: 'n8n-coldchain-orchestrator', name: 'n8n Cold-Chain', connectorType: 'n8n', authType: 'hmac' }],
    }),
    // Simulate legacy backend without builderCatalog -> must NOT emit error feedback
    'dxosAutomations:builderCatalog': async () => {
      throw new Error('404 builderCatalog not available');
    },
    'dxosAutomations:listRules': async () => ({ items: rules }),
    'dxosAutomations:listRuns': async () => ({ items: [] }),
    'dxosAutomations:saveRule': async (req) => ({ rule: { id: 2, ...req.data } }),
    'dxosAutomations:testRule': async (req) => ({
      simulation: {
        ruleKey: req.data.rule.ruleKey,
        status: 'completed',
        matched: true,
        durationMs: 7,
        dmnResultJson: {
          tableKey: 'cmms_priority_routing_v1',
          matched: true,
          outputs: { workOrderPriority: 'high', assignedRole: 'ldx_operator', slaHours: 4 },
        },
        stepTracesJson: [
          { stepIndex: 0, type: 'create_record', status: 'simulated', durationMs: 2 },
          { stepIndex: 1, type: 'notify_role', status: 'simulated', durationMs: 1 },
          { stepIndex: 2, type: 'twin_set_desired', status: 'skipped', skipReason: 'BRANCH_CONDITION_NOT_MATCHED', durationMs: 0 },
          { stepIndex: 3, type: 'trigger_ai_triage', status: 'skipped', skipReason: 'BRANCH_CONDITION_NOT_MATCHED', durationMs: 0 },
          { stepIndex: 4, type: 'call_connector', status: 'skipped', skipReason: 'BRANCH_CONDITION_NOT_MATCHED', durationMs: 0 },
        ],
      },
    }),
  });

  const { VaultAndAutomationPanel } = createBuilderBrokerPanels(client, harness.React, {}, {});
  let tree = await harness.mountAndFlush(VaultAndAutomationPanel, {
    selectedOrg: 'org-a',
    setFeedback: (fb) => feedbackCalls.push(fb),
  });

  assert.equal(feedbackCalls.some((f) => f && f.type === 'error'), false, 'Missing builderCatalog must fall back silently');
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-studio-toolbar').length, 1);
  const canvas = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-flow-canvas')[0];
  assert.ok(canvas, 'Flow canvas must render');
  assert.ok(collectNodes(canvas, (n) => n.type === 'svg').length >= 3, 'Flow canvas must render inline SVG connectors');

  // Toggle Blueprint Gallery & load 5-step Cold-Chain blueprint
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-blueprint-toggle-btn')[0].props.onClick();
  tree = harness.render(VaultAndAutomationPanel, { selectedOrg: 'org-a', setFeedback: (fb) => feedbackCalls.push(fb) });
  const gallery = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-blueprint-gallery')[0];
  assert.ok(gallery, 'Blueprint gallery must render 3 templates');
  assert.equal(collectNodes(gallery, (n) => String(n.props?.['data-testid'] || '').startsWith('dxos-automation-blueprint-load-')).length, 3);

  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-blueprint-load-auto_cmms_on_coldchain_fault')[0].props.onClick();
  tree = harness.render(VaultAndAutomationPanel, { selectedOrg: 'org-a', setFeedback: (fb) => feedbackCalls.push(fb) });

  assert.equal(collectNodes(tree, (n) => String(n.props?.['data-testid'] || '').startsWith('dxos-canvas-node-step-')).length, 5);
  assert.ok(textOf(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-flow-canvas')[0]).includes('Khi ưu tiên = critical'));

  // Select Filter node -> edit Cooldown; Select Step 0 -> edit title value; Save Rule & verify preserved fields
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-canvas-node-filter')[0].props.onClick();
  tree = harness.render(VaultAndAutomationPanel, { selectedOrg: 'org-a', setFeedback: (fb) => feedbackCalls.push(fb) });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-cooldown-input')[0].props.onChange({ target: { value: '180' } });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-canvas-node-step-0')[0].props.onClick();
  tree = harness.render(VaultAndAutomationPanel, { selectedOrg: 'org-a', setFeedback: (fb) => feedbackCalls.push(fb) });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-step-label-input')[0].props.onChange({ target: { value: 'Mở CMMS khẩn cấp' } });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-step-val-title')[0].props.onChange({ target: { value: 'Cảnh báo kho lạnh {{data.deviceKey}}' } });
  tree = harness.render(VaultAndAutomationPanel, { selectedOrg: 'org-a', setFeedback: (fb) => feedbackCalls.push(fb) });

  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-rule-form')[0].props.onSubmit({ preventDefault() {} });
  const saveReq = requests.find((r) => r.url === 'dxosAutomations:saveRule');
  assert.ok(saveReq);
  assert.equal(saveReq.data.ruleKey, 'auto_cmms_on_coldchain_fault');
  assert.equal(saveReq.data.cooldownSec, 180);
  assert.equal(saveReq.data.maxDepth, 8);
  assert.deepEqual(saveReq.data.filterJson, { severity: { $in: ['high', 'critical'] } });
  assert.equal(saveReq.data.actionsJson[0].label, 'Mở CMMS khẩn cấp');
  assert.equal(saveReq.data.actionsJson[0].values.title, 'Cảnh báo kho lạnh {{data.deviceKey}}');
  assert.equal(saveReq.data.actionsJson[2].branchLabel, 'Khi ưu tiên = critical');
  assert.ok(saveReq.data.actionsJson[2].when);

  // Dry-Run illuminates simulated vs skipped nodes and DMN outputs on Canvas
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-dryrun-btn')[0].props.onClick();
  tree = harness.render(VaultAndAutomationPanel, { selectedOrg: 'org-a', setFeedback: (fb) => feedbackCalls.push(fb) });
  const testReq = requests.find((r) => r.url === 'dxosAutomations:testRule');
  assert.ok(testReq);
  assert.equal(testReq.data.rule.ruleKey, 'auto_cmms_on_coldchain_fault');
  assert.ok(textOf(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-canvas-node-dmn')[0]).includes('workOrderPriority: high'));
  assert.ok(textOf(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-canvas-node-step-0')[0]).includes('simulated'));
  assert.ok(textOf(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-canvas-node-step-2')[0]).includes('skipped'));
  assert.ok(textOf(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-trace-inspector')[0]).includes('Dry-Run Simulation'));
});

test('Inline AI Automation Copilot supports suggest, node, full modes and 1-click Apply to Canvas', async () => {
  const { createBuilderBrokerPanels } = require(path.join(PLUGIN_ROOT, 'src/client/builder-broker-panels.js'));
  const harness = createReactHarness();
  const { client, requests } = createApiMock({
    'dxosVault:list': async () => ({ items: [] }),
    'dxosAutomations:builderCatalog': async () => ({
      eventTypes: [{ eventType: 'alarm.triggered', label: 'Alarm' }],
      dmnTables: [{ tableKey: 'cmms_priority_routing_v1', name: 'CMMS Routing', outputs: ['workOrderPriority', 'assignedRole'] }],
      collections: [{ name: 'latticeCustomWorkOrders', title: 'CMMS', fields: ['workOrderCode', 'title', 'priority'] }],
      roles: ['ldx_admin', 'ldx_manager', 'ldx_operator'],
      connectors: [],
    }),
    'dxosAutomations:listRules': async () => ({ items: [] }),
    'dxosAutomations:listRuns': async () => ({ items: [] }),
    'dxosAutomations:aiAssist': async (req) => {
      if (req.data.mode === 'suggest') {
        return {
          summary: 'Nên bật cooldown 120s để tránh tạo trùng phiếu CMMS.',
          diffSummary: ['Thêm cooldownSec = 120', 'Thêm điều kiện temperature >= 8'],
          suggestions: [
            {
              id: 'add-cooldown',
              title: 'Thêm Cooldown 120s + Filter >= 8°C',
              description: 'Chống bão cảnh báo khi cảm biến dao động quanh ngưỡng.',
              previewRule: {
                ...req.data.rule,
                ruleKey: 'ai_suggested_rule',
                name: 'AI Suggested Cold-Chain',
                cooldownSec: 120,
                filterJson: { temperature: { $gte: 8 } },
              },
            },
          ],
        };
      }
      if (req.data.mode === 'node') {
        return {
          summary: `Đã vá node ${req.data.targetNode} theo ngữ cảnh.`,
          diffSummary: ['Cập nhật cooldownSec = 240'],
          patch: { cooldownSec: 240 },
        };
      }
      return {
        summary: 'Đã dựng flow SLA 2 nhánh từ mô tả tiếng Việt.',
        diffSummary: ['Trigger sla.warning,sla.breached', '2 nhánh theo event.type'],
        rule: {
          ruleKey: 'ai_sla_escalation_flow',
          name: 'AI SLA Escalation Flow',
          triggerEventType: 'sla.warning,sla.breached',
          filterJson: null,
          dmnTableKey: '',
          cooldownSec: 90,
          maxDepth: 8,
          active: true,
          actionsJson: [
            { type: 'notify_role', label: 'Nhắc dispatcher', when: { field: 'event.type', op: '$eq', value: 'sla.warning' }, branchLabel: 'sla.warning', role: 'ldx_dispatcher', title: 'Warning' },
            { type: 'create_record', label: 'Tạo ticket khẩn', when: { field: 'event.type', op: '$eq', value: 'sla.breached' }, branchLabel: 'sla.breached', collection: 'latticeServiceTickets', values: { title: 'SLA Breached' } },
          ],
        },
      };
    },
  });

  const { VaultAndAutomationPanel } = createBuilderBrokerPanels(client, harness.React, {}, {});
  let tree = await harness.mountAndFlush(VaultAndAutomationPanel, { selectedOrg: 'org-a' });

  const copilot = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-ai-copilot')[0];
  assert.ok(copilot);

  // 1. Suggest mode + 1-click suggestion apply
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-ai-prompt')[0].props.onChange({ target: { value: 'Tối ưu chống bão cảnh báo' } });
  tree = harness.render(VaultAndAutomationPanel, { selectedOrg: 'org-a' });
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-ai-suggest-btn')[0].props.onClick();
  tree = harness.render(VaultAndAutomationPanel, { selectedOrg: 'org-a' });

  assert.ok(requests.some((r) => r.url === 'dxosAutomations:aiAssist' && r.data.mode === 'suggest'));
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-ai-apply-suggestion-add-cooldown')[0].props.onClick();
  tree = harness.render(VaultAndAutomationPanel, { selectedOrg: 'org-a' });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-rule-key-input')[0].props.value, 'ai_suggested_rule');
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-cooldown-input')[0].props.value, 120);

  // 2. Node mode on Filter node
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-canvas-node-filter')[0].props.onClick();
  tree = harness.render(VaultAndAutomationPanel, { selectedOrg: 'org-a' });
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-ai-node-btn')[0].props.onClick();
  tree = harness.render(VaultAndAutomationPanel, { selectedOrg: 'org-a' });
  assert.ok(requests.some((r) => r.url === 'dxosAutomations:aiAssist' && r.data.mode === 'node' && r.data.targetNode === 'filter'));

  // 3. Full mode + Áp dụng vào Canvas
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-ai-prompt')[0].props.onChange({ target: { value: 'Dựng flow leo thang SLA 2 nhánh' } });
  tree = harness.render(VaultAndAutomationPanel, { selectedOrg: 'org-a' });
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-ai-full-btn')[0].props.onClick();
  tree = harness.render(VaultAndAutomationPanel, { selectedOrg: 'org-a' });
  assert.ok(requests.some((r) => r.url === 'dxosAutomations:aiAssist' && r.data.mode === 'full'));

  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-ai-apply-btn')[0].props.onClick();
  tree = harness.render(VaultAndAutomationPanel, { selectedOrg: 'org-a' });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-rule-key-input')[0].props.value, 'ai_sla_escalation_flow');
  assert.equal(collectNodes(tree, (n) => String(n.props?.['data-testid'] || '').startsWith('dxos-canvas-node-step-')).length, 2);
});

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
      return { type, props: props || {}, children: flat };
    },
    useState(init) {
      const comp = currentComponent;
      const bucket = getBucket(statesByComponent, comp);
      const idx = stateIdx++;
      if (bucket.length <= idx) {
        bucket[idx] = {
          value: typeof init === 'function' ? init() : init,
          queue: [],
        };
      }
      const slot = bucket[idx];
      // Drain queued updaters in hook declaration order at render time (React 18/19 async batching)
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
      if (pendingEffects.length === 0 && pendingUpdates === 0) break;
      const batch = pendingEffects.splice(0, pendingEffects.length);
      for (const eff of batch) {
        await eff();
      }
      await new Promise((resolve) => setImmediate(resolve));
      if (pendingUpdates > 0 || pendingEffects.length > 0 || batch.length > 0) {
        pendingUpdates = 0;
        tree = renderNode(React.createElement(ComponentFn, props));
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

test('R1 P0 #1 & P2 #9 (queued React 18/19 async batching): preserves selectedNode step:0/step:2 on label & targetTempC typing and buffers $in CSV lists', async () => {
  const { createBuilderBrokerPanels } = require(path.join(PLUGIN_ROOT, 'src/client/builder-broker-panels.js'));
  const harness = createQueuedReactHarness();
  const { client, requests } = createApiMock({
    'dxosVault:list': async () => ({ items: [] }),
    'dxosAutomations:listRules': async () => ({ items: [] }),
    'dxosAutomations:listRuns': async () => ({ items: [] }),
    'dxosAutomations:saveRule': async (req) => ({ rule: { id: 1, ...req.data } }),
  });

  const { VaultAndAutomationPanel } = createBuilderBrokerPanels(client, harness.React, {}, {});
  let tree = await harness.mountAndFlush(VaultAndAutomationPanel, { selectedOrg: 'org-a' });

  // Load 5-step blueprint
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-blueprint-toggle-btn')[0].props.onClick();
  tree = await harness.flush(VaultAndAutomationPanel, { selectedOrg: 'org-a' });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-blueprint-load-auto_cmms_on_coldchain_fault')[0].props.onClick();
  tree = await harness.flush(VaultAndAutomationPanel, { selectedOrg: 'org-a' });

  // Select step:0 and edit label under queued async batching -> selectedNode must stay on step:0
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-canvas-node-step-0')[0].props.onClick();
  tree = await harness.flush(VaultAndAutomationPanel, { selectedOrg: 'org-a' });
  assert.ok(textOf(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-inspector')[0]).includes('Inspector · Bước #1'));

  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-step-label-input')[0].props.onChange({ target: { value: 'CMMS khẩn' } });
  tree = await harness.flush(VaultAndAutomationPanel, { selectedOrg: 'org-a' });
  assert.ok(textOf(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-inspector')[0]).includes('Inspector · Bước #1'));
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-step-label-input')[0].props.value, 'CMMS khẩn');

  // Select step:2 (twin_set_desired) and type targetTempC '4.0' -> '3.5' -> selectedNode must stay on step:2
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-canvas-node-step-2')[0].props.onClick();
  tree = await harness.flush(VaultAndAutomationPanel, { selectedOrg: 'org-a' });
  assert.ok(textOf(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-inspector')[0]).includes('Inspector · Bước #3'));

  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-step-target-temp')[0].props.onChange({ target: { value: '4.0' } });
  tree = await harness.flush(VaultAndAutomationPanel, { selectedOrg: 'org-a' });
  assert.ok(textOf(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-inspector')[0]).includes('Inspector · Bước #3'));
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-step-target-temp')[0].props.value, '4.0');

  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-step-target-temp')[0].props.onChange({ target: { value: '3.5' } });
  tree = await harness.flush(VaultAndAutomationPanel, { selectedOrg: 'org-a' });
  assert.ok(textOf(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-inspector')[0]).includes('Inspector · Bước #3'));
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-step-target-temp')[0].props.value, '3.5');

  // Switch step:2 when operator to $in and type comma-separated 'high, critical' without losing the comma mid-typing
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-step-when-op')[0].props.onChange({ target: { value: '$in' } });
  tree = await harness.flush(VaultAndAutomationPanel, { selectedOrg: 'org-a' });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-step-when-value')[0].props.onChange({ target: { value: 'high, ' } });
  tree = await harness.flush(VaultAndAutomationPanel, { selectedOrg: 'org-a' });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-step-when-value')[0].props.value, 'high, ');

  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-step-when-value')[0].props.onChange({ target: { value: 'high, critical' } });
  tree = await harness.flush(VaultAndAutomationPanel, { selectedOrg: 'org-a' });

  // Save directly (even before blur) and verify coerced values + preserved step edits
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-rule-form')[0].props.onSubmit({ preventDefault() {} });
  const saveReq = requests.find((r) => r.url === 'dxosAutomations:saveRule');
  assert.ok(saveReq);
  assert.equal(saveReq.data.actionsJson[0].label, 'CMMS khẩn');
  assert.equal(saveReq.data.actionsJson[2].desiredPatch.targetTempC, 3.5);
  assert.deepEqual(saveReq.data.actionsJson[2].when.value, ['high', 'critical']);

  // Trigger onBlur coercion cleanly too and keep selectedNode on step:2
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-step-target-temp')[0].props.onBlur();
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-step-when-value')[0].props.onBlur();
  tree = await harness.flush(VaultAndAutomationPanel, { selectedOrg: 'org-a' });
  assert.ok(textOf(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-inspector')[0]).includes('Inspector · Bước #3'));

  // Batched addStep + duplicateStep + moveStep + removeStep keep selection aligned without dropping to trigger
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-add-action-btn')[0].props.onClick();
  tree = await harness.flush(VaultAndAutomationPanel, { selectedOrg: 'org-a' });
  assert.ok(textOf(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-inspector')[0]).includes('Inspector · Bước #6'));

  const step5Card = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-canvas-node-step-5')[0];
  collectNodes(step5Card, (n) => n.type === 'button' && textOf(n) === '↑')[0].props.onClick({ stopPropagation() {} });
  tree = await harness.flush(VaultAndAutomationPanel, { selectedOrg: 'org-a' });
  assert.ok(textOf(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-inspector')[0]).includes('Inspector · Bước #5'));

  const step4Card = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-canvas-node-step-4')[0];
  collectNodes(step4Card, (n) => n.type === 'button' && textOf(n) === '⧉')[0].props.onClick({ stopPropagation() {} });
  tree = await harness.flush(VaultAndAutomationPanel, { selectedOrg: 'org-a' });
  assert.ok(textOf(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-inspector')[0]).includes('Inspector · Bước #6'));
  assert.equal(collectNodes(tree, (n) => String(n.props?.['data-testid'] || '').startsWith('dxos-canvas-node-step-')).length, 7);

  const step5AfterDup = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-canvas-node-step-5')[0];
  collectNodes(step5AfterDup, (n) => n.type === 'button' && textOf(n) === 'Xóa')[0].props.onClick({ stopPropagation() {} });
  tree = await harness.flush(VaultAndAutomationPanel, { selectedOrg: 'org-a' });
  assert.equal(collectNodes(tree, (n) => String(n.props?.['data-testid'] || '').startsWith('dxos-canvas-node-step-')).length, 6);
  assert.ok(textOf(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-inspector')[0]).includes('Inspector · Bước #6'));
});

test('R1 P1 #6: org-switch clears stale Vault/Automation state, drops stale async responses via loadSeqRef, isolates Dry-Run highlights, and safely handles applyAiCandidate', async () => {
  const { createBuilderBrokerPanels } = require(path.join(PLUGIN_ROOT, 'src/client/builder-broker-panels.js'));
  const harness = createQueuedReactHarness();

  let resolveSlowOrgARuns = null;
  let slowOrgARunsPromise = null;
  const listRunsRequests = [];

  const { client, requests } = createApiMock({
    'dxosVault:list': async (req) => ({
      items: req.params.organizationId === 'org-a'
        ? [{ id: 1, connectorKey: 'n8n-org-a', name: 'n8n Org A', connectorType: 'n8n', authType: 'bearer', hasSecrets: true }]
        : [{ id: 2, connectorKey: 'n8n-org-b', name: 'n8n Org B', connectorType: 'n8n', authType: 'bearer', hasSecrets: true }],
    }),
    'dxosVault:testConnection': async (req) => ({
      ok: true,
      statusCode: 200,
      latencyMs: 9,
      message: 'Org A reachable',
      connectorKey: req.data.connectorKey,
    }),
    'dxosAutomations:builderCatalog': async (req) => {
      if (req.params.organizationId === 'org-b') throw new Error('404 catalog unavailable on org-b');
      return {
        eventTypes: [{ eventType: 'custom.org_a.event', label: 'Org A Custom Event' }],
        dmnTables: [{ tableKey: 'org_a_dmn', name: 'Org A DMN', outputs: ['tier'] }],
        collections: [{ name: 'latticeCustomOrgA', title: 'Org A Domain', fields: ['code'] }],
        roles: ['ldx_admin'],
        connectors: [],
      };
    },
    'dxosAutomations:listRules': async (req) => ({
      items: req.params.organizationId === 'org-a'
        ? [
          {
            id: 101,
            ruleKey: 'rule_org_a',
            name: 'Rule Org A',
            triggerEventType: 'alarm.triggered',
            dmnTableKey: 'cmms_priority_routing_v1',
            actionsJson: [
              { type: 'notify_role', label: 'Step 0', role: 'ldx_operator', title: 'A0' },
              { type: 'notify_role', label: 'Step 1', role: 'ldx_manager', title: 'A1' },
              { type: 'notify_role', label: 'Step 2', role: 'ldx_manager', title: 'A2' },
            ],
            active: true,
          },
          {
            id: 102,
            ruleKey: 'rule_org_a_2',
            name: 'Rule Org A 2',
            triggerEventType: 'device.offline',
            actionsJson: [{ type: 'notify_role', label: 'B0', role: 'ldx_operator', title: 'B0' }],
            active: true,
          },
        ]
        : [
          {
            id: 201,
            ruleKey: 'rule_org_b',
            name: 'Rule Org B',
            triggerEventType: 'telemetry.alarm',
            actionsJson: [{ type: 'notify_role', label: 'Org B Step', role: 'ldx_operator', title: 'B' }],
            active: true,
          },
        ],
    }),
    'dxosAutomations:listRuns': async (req) => {
      listRunsRequests.push({ org: req.params.organizationId, ruleKey: req.params.ruleKey || '' });
      if (req.params.organizationId === 'org-a' && req.params.ruleKey === 'rule_org_a') {
        if (!slowOrgARunsPromise) {
          slowOrgARunsPromise = new Promise((resolve) => {
            resolveSlowOrgARuns = resolve;
          });
        }
        return slowOrgARunsPromise;
      }
      if (req.params.organizationId === 'org-a') {
        return {
          items: [
            {
              id: 901,
              runId: 'run-org-a-901',
              ruleKey: 'rule_org_a',
              status: 'completed',
              durationMs: 12,
              stepTracesJson: [{ stepIndex: 0, status: 'completed', durationMs: 5 }],
            },
          ],
        };
      }
      return { items: [] };
    },
    'dxosAutomations:testRule': async (req) => ({
      simulation: {
        ruleKey: req.data.rule.ruleKey,
        status: 'completed',
        durationMs: 6,
        dmnResultJson: { tableKey: 'cmms_priority_routing_v1', matched: true, outputs: { workOrderPriority: 'critical' } },
        stepTracesJson: [{ stepIndex: 0, type: 'notify_role', status: 'simulated', durationMs: 3 }],
      },
    }),
    'dxosAutomations:aiAssist': async () => ({
      summary: 'Generated compact 2-step flow',
      rule: {
        ruleKey: 'ai_compact_flow',
        name: 'AI Compact Flow',
        triggerEventType: 'telemetry.alarm',
        actionsJson: [
          { type: 'notify_role', label: 'Step 0', role: 'ldx_operator', title: 'S0' },
          { type: 'notify_role', label: 'Step 1', role: 'ldx_manager', title: 'S1' },
        ],
      },
    }),
  });

  const { VaultAndAutomationPanel } = createBuilderBrokerPanels(client, harness.React, {}, {});
  let tree = await harness.mountAndFlush(VaultAndAutomationPanel, { selectedOrg: 'org-a' });

  assert.ok(JSON.stringify(tree).includes('custom.org_a.event'));
  assert.ok(JSON.stringify(tree).includes('run-org-a-901'));

  // Populate Vault testResult, rotate form, and load rule_org_a + run Dry-Run
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-vault-test-n8n-org-a')[0].props.onClick();
  tree = await harness.flush(VaultAndAutomationPanel, { selectedOrg: 'org-a' });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-vault-test-result').length, 1);

  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-vault-rotate-open-n8n-org-a')[0].props.onClick();
  tree = await harness.flush(VaultAndAutomationPanel, { selectedOrg: 'org-a' });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-vault-rotate-input')[0].props.onChange({ target: { value: 'temp-secret-a' } });
  tree = await harness.flush(VaultAndAutomationPanel, { selectedOrg: 'org-a' });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-vault-rotate-form').length, 1);

  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-edit-rule_org_a')[0].props.onClick();
  tree = await harness.flush(VaultAndAutomationPanel, { selectedOrg: 'org-a' });
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-dryrun-btn')[0].props.onClick();
  tree = await harness.flush(VaultAndAutomationPanel, { selectedOrg: 'org-a' });
  assert.ok(textOf(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-trace-inspector')[0]).includes('Dry-Run Simulation'));

  // Editing ruleKey or switching rule clears stale Dry-Run highlights
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-rule-key-input')[0].props.onChange({ target: { value: 'rule_edited' } });
  tree = await harness.flush(VaultAndAutomationPanel, { selectedOrg: 'org-a' });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-trace-inspector').length, 0);

  // Re-run Dry-Run on rule_org_a, then switch to rule_org_a_2 -> selectedRun clears; + Rule mới also clears
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-edit-rule_org_a')[0].props.onClick();
  tree = await harness.flush(VaultAndAutomationPanel, { selectedOrg: 'org-a' });
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-dryrun-btn')[0].props.onClick();
  tree = await harness.flush(VaultAndAutomationPanel, { selectedOrg: 'org-a' });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-edit-rule_org_a_2')[0].props.onClick();
  tree = await harness.flush(VaultAndAutomationPanel, { selectedOrg: 'org-a' });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-trace-inspector').length, 0);

  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-dryrun-btn')[0].props.onClick();
  tree = await harness.flush(VaultAndAutomationPanel, { selectedOrg: 'org-a' });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-new-rule-btn')[0].props.onClick();
  tree = await harness.flush(VaultAndAutomationPanel, { selectedOrg: 'org-a' });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-trace-inspector').length, 0);

  // Select step:2 on rule_org_a and apply a 2-step full AI draft -> must navigate to 'trigger' (never stale step:2)
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-edit-rule_org_a')[0].props.onClick();
  tree = await harness.flush(VaultAndAutomationPanel, { selectedOrg: 'org-a' });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-canvas-node-step-2')[0].props.onClick();
  tree = await harness.flush(VaultAndAutomationPanel, { selectedOrg: 'org-a' });
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-ai-full-btn')[0].props.onClick();
  tree = await harness.flush(VaultAndAutomationPanel, { selectedOrg: 'org-a' });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-ai-apply-btn')[0].props.onClick();
  tree = await harness.flush(VaultAndAutomationPanel, { selectedOrg: 'org-a' });
  assert.ok(textOf(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-inspector')[0]).includes('Node 1: Event Trigger'));

  // Trigger an in-flight org-a listRuns request, then immediately switch to org-b BEFORE org-a resolves
  const pendingInspectPromise = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-runs-btn-rule_org_a')[0].props.onClick();
  tree = await harness.flush(VaultAndAutomationPanel, { selectedOrg: 'org-b' });

  // Verify org-b clears stale Vault/Automation state, falls back to default catalog (no custom.org_a.event), and never queries org-b with rule_org_a
  const orgBRunReqs = listRunsRequests.filter((r) => r.org === 'org-b');
  assert.ok(orgBRunReqs.length >= 1);
  assert.equal(orgBRunReqs.some((r) => r.ruleKey === 'rule_org_a'), false, 'org-b listRuns must not inherit org-a selectedRuleKey');
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-vault-test-result').length, 0);
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-vault-rotate-form').length, 0);
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-trace-inspector').length, 0);
  assert.equal(JSON.stringify(tree).includes('custom.org_a.event'), false, 'Failed org-b catalog fetch must clear org-a rawCatalog');
  assert.ok(JSON.stringify(tree).includes('rule_org_b'));

  // Now resolve the stale org-a response AFTER org-b finished -> loadSeqRef must discard it!
  resolveSlowOrgARuns({
    items: [{ id: 999, runId: 'stale-org-a-run', ruleKey: 'rule_org_a', status: 'completed', durationMs: 99 }],
  });
  await pendingInspectPromise;
  tree = await harness.flush(VaultAndAutomationPanel, { selectedOrg: 'org-b' });
  assert.equal(JSON.stringify(tree).includes('stale-org-a-run'), false, 'Stale org-a response must never overwrite org-b runs');
  assert.ok(requests.some((r) => r.url === 'dxosAutomations:listRules' && r.params?.organizationId === 'org-b'));
});

test('R1 P2 #9: preserves multi-clause / $or / $not / $and when conditions, blocks prototype keys in pairsToObject, and rejects invalid non-object items in Actions JSON', async () => {
  const autoPanel = require(path.join(PLUGIN_ROOT, 'src/client/automation-studio-panel.js'));
  const { createBuilderBrokerPanels } = require(path.join(PLUGIN_ROOT, 'src/client/builder-broker-panels.js'));

  // Unit assertions on parseWhenCondition and pairsToObject
  const multiClause = { $or: [{ severity: 'critical' }, { maxTempC: { $gt: 8 } }] };
  const parsedOr = autoPanel.parseWhenCondition(multiClause);
  assert.equal(parsedOr.isComplex, true);
  assert.deepEqual(parsedOr.rawWhen, multiClause);

  const twoFieldWhen = { severity: 'critical', maxTempC: { $gt: 8 } };
  const parsedTwo = autoPanel.parseWhenCondition(twoFieldWhen);
  assert.equal(parsedTwo.isComplex, true);
  assert.equal(parsedTwo.rows.length, 2);

  const sanitizedObj = autoPanel.pairsToObject([
    { key: '__proto__', value: '{"polluted":true}' },
    { key: 'constructor', value: 'bad' },
    { key: 'prototype', value: 'bad' },
    { key: 'title', value: 'Safe Title' },
  ]);
  assert.deepEqual(Object.keys(sanitizedObj), ['title']);
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(sanitizedObj, 'constructor'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(sanitizedObj, 'prototype'), false);

  // Integration check on AutomationStudioPanel UI
  const harness = createQueuedReactHarness();
  const feedbackCalls = [];
  const complexWhen = { $and: [{ severity: 'critical' }, { $or: [{ maxTempC: { $gt: 8 } }, { mktCelsius: { $gte: 10 } }] }] };
  const { client, requests } = createApiMock({
    'dxosVault:list': async () => ({ items: [] }),
    'dxosAutomations:listRules': async () => ({
      items: [
        {
          id: 55,
          ruleKey: 'multi_clause_rule',
          name: 'Multi Clause Rule',
          triggerEventType: 'lot.held_mkt',
          actionsJson: [
            {
              type: 'notify_role',
              label: 'Initial Step',
              when: complexWhen,
              branchLabel: 'Nhánh đa điều kiện',
              role: 'ldx_manager',
              title: 'Alert',
            },
          ],
          active: true,
        },
      ],
    }),
    'dxosAutomations:listRuns': async () => ({ items: [] }),
    'dxosAutomations:saveRule': async (req) => ({ rule: { id: 55, ...req.data } }),
  });

  const { VaultAndAutomationPanel } = createBuilderBrokerPanels(client, harness.React, {}, {});
  let tree = await harness.mountAndFlush(VaultAndAutomationPanel, {
    selectedOrg: 'org-a',
    setFeedback: (fb) => feedbackCalls.push(fb),
  });

  // Load multi_clause_rule and select step:0
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-edit-multi_clause_rule')[0].props.onClick();
  tree = await harness.flush(VaultAndAutomationPanel, { selectedOrg: 'org-a', setFeedback: (fb) => feedbackCalls.push(fb) });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-canvas-node-step-0')[0].props.onClick();
  tree = await harness.flush(VaultAndAutomationPanel, { selectedOrg: 'org-a', setFeedback: (fb) => feedbackCalls.push(fb) });

  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-step-when-complex').length, 1);

  // Edit branchLabel and step label -> multi-clause `when` must stay 100% untouched on Save
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-step-branch-label')[0].props.onChange({ target: { value: 'Nhánh đã đổi tên' } });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-step-label-input')[0].props.onChange({ target: { value: 'Updated Label' } });
  tree = await harness.flush(VaultAndAutomationPanel, { selectedOrg: 'org-a', setFeedback: (fb) => feedbackCalls.push(fb) });

  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-rule-form')[0].props.onSubmit({ preventDefault() {} });
  const saveReq = requests.find((r) => r.url === 'dxosAutomations:saveRule');
  assert.ok(saveReq);
  assert.equal(saveReq.data.actionsJson[0].branchLabel, 'Nhánh đã đổi tên');
  assert.deepEqual(saveReq.data.actionsJson[0].when, complexWhen);

  // Invalid non-object array elements in Actions JSON must NOT corrupt actionsList and must block Save
  for (const invalidJson of ['[123]', '[null]', '["str"]', '[[]]']) {
    collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-actions-json')[0].props.onChange({ target: { value: invalidJson } });
    tree = await harness.flush(VaultAndAutomationPanel, { selectedOrg: 'org-a', setFeedback: (fb) => feedbackCalls.push(fb) });
    assert.equal(collectNodes(tree, (n) => String(n.props?.['data-testid'] || '').startsWith('dxos-canvas-node-step-')).length, 1);
    const saveCountBefore = requests.filter((r) => r.url === 'dxosAutomations:saveRule').length;
    await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-rule-form')[0].props.onSubmit({ preventDefault() {} });
    assert.equal(requests.filter((r) => r.url === 'dxosAutomations:saveRule').length, saveCountBefore);
  }
});

test('R1 P1 #7: DEFAULT_AUTOMATION_BLUEPRINTS and DEFAULT_AUTOMATION_CATALOG enforce schema parity for Twin, IncidentCases, and ServiceTickets', () => {
  const { DEFAULT_AUTOMATION_BLUEPRINTS, DEFAULT_AUTOMATION_CATALOG } = require(path.join(PLUGIN_ROOT, 'src/client/automation-studio-panel.js'));
  const { SERVICE_PRIORITIES, SERVICE_TYPES } = require(path.join(PLUGIN_ROOT, 'src/server/service-schema.js'));

  const bp0 = DEFAULT_AUTOMATION_BLUEPRINTS.find((b) => b.ruleKey === 'auto_cmms_on_coldchain_fault');
  assert.ok(bp0);
  assert.equal(bp0.actionsJson[2].type, 'twin_set_desired');
  assert.equal(bp0.actionsJson[2].assetEntityId, '{{data.assetEntityId}}');

  const bp1 = DEFAULT_AUTOMATION_BLUEPRINTS.find((b) => b.ruleKey === 'auto_mkt_quarantine_response');
  assert.ok(bp1);
  const incCreate = bp1.actionsJson[0];
  assert.equal(incCreate.collection, 'latticeIncidentCases');
  for (const reqField of ['code', 'name', 'runId', 'assetEntityId', 'handlerId', 'severity', 'status', 'proposal']) {
    assert.ok(Object.prototype.hasOwnProperty.call(incCreate.values, reqField) && incCreate.values[reqField], `Blueprint 1 missing latticeIncidentCases.${reqField}`);
  }

  const bp2 = DEFAULT_AUTOMATION_BLUEPRINTS.find((b) => b.ruleKey === 'auto_sla_breach_escalation');
  assert.ok(bp2);
  const tktCreate = bp2.actionsJson[1];
  assert.equal(tktCreate.collection, 'latticeServiceTickets');
  for (const reqField of ['code', 'name', 'serviceType', 'priority', 'description']) {
    assert.ok(Object.prototype.hasOwnProperty.call(tktCreate.values, reqField) && tktCreate.values[reqField], `Blueprint 2 missing latticeServiceTickets.${reqField}`);
  }
  assert.ok(SERVICE_TYPES.includes(tktCreate.values.serviceType));
  assert.ok(SERVICE_PRIORITIES.includes(tktCreate.values.priority));
  assert.equal(tktCreate.values.priority, 'high');
  assert.equal(JSON.stringify(DEFAULT_AUTOMATION_BLUEPRINTS).includes('"urgent"'), false, 'DEFAULT_AUTOMATION_BLUEPRINTS must never use urgent priority');
  assert.equal(JSON.stringify(DEFAULT_AUTOMATION_CATALOG).includes('"urgent"'), false, 'DEFAULT_AUTOMATION_CATALOG must never use urgent priority');
});
