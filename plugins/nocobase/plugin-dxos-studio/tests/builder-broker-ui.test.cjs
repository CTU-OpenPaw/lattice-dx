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
const { existsSync, readFileSync } = require('node:fs');
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
  const flowAppPath = path.join(PLUGIN_ROOT, 'src/client/flow/flow-studio-app.js');
  const mod = require(panelsPath);

  assert.equal(typeof mod.createBuilderBrokerPanels, 'function');
  assert.equal(typeof mod.BrokerAndEventsPanel, 'function');
  assert.equal(typeof mod.VaultAndAutomationPanel, 'function');
  assert.equal(typeof mod.DomainBuilderAndTenantsPanel, 'function');
  assert.equal(existsSync(path.join(PLUGIN_ROOT, 'src', 'client', ['automation', 'studio', 'panel.js'].join('-'))), false, 'Legacy v1 automation panel must be removed');

  for (const filePath of [panelsPath, studioPath, flowAppPath]) {
    const src = readFileSync(filePath, 'utf8');
    assert.ok(src.includes('SPDX-License-Identifier: Apache-2.0'), `Missing SPDX header in ${filePath}`);
    assert.doesNotMatch(src, /require\(['"](?:react|antd|@nocobase\/client)['"]\)/, `Forbidden external require in ${filePath}`);
    assert.doesNotMatch(src, /\blocalStorage\b|\bsessionStorage\b/, `Must not access browser storage in ${filePath}`);
    assert.doesNotMatch(src, /dangerouslySetInnerHTML/, `Must never use dangerouslySetInnerHTML in ${filePath}`);
  }
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

test('Tab 8 (VaultAndAutomationPanel): saves/tests/rotates secrets without leaking plaintext, launches Flow Studio, and runs rule quick-actions', async () => {
  const { createBuilderBrokerPanels } = require(path.join(PLUGIN_ROOT, 'src/client/builder-broker-panels.js'));
  const harness = createReactHarness();
  const openedRoutes = [];
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
      schemaVersion: 2,
      graphJson: { version: 2, nodes: [{ id: 'trig_1', type: 'trigger.event' }], edges: [] },
      active: true,
    },
  ];
  let runs = [
    {
      id: 501,
      runUid: 'run-501',
      runId: 'run-501',
      ruleKey: 'auto_cmms_on_coldchain_fault',
      status: 'completed',
      durationMs: 42,
      startedAt: '2026-11-23T11:00:00.000Z',
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
        runUid: 'run-502',
        runId: 'run-502',
        ruleKey: req.data.ruleKey,
        status: 'completed',
        durationMs: 19,
      };
      runs = [newRun, ...runs];
      return { run: newRun };
    },
    'dxosAutomations:listRuns': async () => ({ items: runs }),
    'dxosAutomations:replayRun': async (req) => ({ run: { id: 503, runUid: 'run-503', status: 'completed', durationMs: 15, replayedFrom: req.data.runUid } }),
  });

  const { VaultAndAutomationPanel } = createBuilderBrokerPanels(client, harness.React, {}, {});
  let tree = await harness.mountAndFlush(VaultAndAutomationPanel, {
    selectedOrg: 'org-a',
    openRoute: (p) => openedRoutes.push(p),
  });

  // Save connector with secret -> clears secret input immediately and never renders plaintext secret
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-vault-key-input')[0].props.onChange({ target: { value: 'erp-webhook' } });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-vault-name-input')[0].props.onChange({ target: { value: 'ERP Webhook' } });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-vault-url-input')[0].props.onChange({ target: { value: 'https://erp.example.com/hook' } });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-vault-secrets-input')[0].props.onChange({ target: { value: '{"token":"super-secret-xyz-123"}' } });
  tree = harness.render(VaultAndAutomationPanel, { selectedOrg: 'org-a', openRoute: (p) => openedRoutes.push(p) });
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-vault-save-form')[0].props.onSubmit({ preventDefault() {} });
  tree = harness.render(VaultAndAutomationPanel, { selectedOrg: 'org-a', openRoute: (p) => openedRoutes.push(p) });

  const saveVaultReq = requests.find((r) => r.url === 'dxosVault:save');
  assert.ok(saveVaultReq);
  assert.deepEqual(saveVaultReq.data.secrets, { token: 'super-secret-xyz-123' });
  assert.equal(JSON.stringify(tree).includes('super-secret-xyz-123'), false, 'Saved plaintext secret must never remain in UI state/DOM');

  // Test Connection
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-vault-test-n8n-prod')[0].props.onClick();
  tree = harness.render(VaultAndAutomationPanel, { selectedOrg: 'org-a', openRoute: (p) => openedRoutes.push(p) });
  assert.ok(requests.some((r) => r.url === 'dxosVault:testConnection' && r.data.connectorKey === 'n8n-prod'));
  const testBanner = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-vault-test-result')[0];
  assert.ok(testBanner && textOf(testBanner).includes('Endpoint reachable'));

  // Rotate Secret
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-vault-rotate-open-n8n-prod')[0].props.onClick();
  tree = harness.render(VaultAndAutomationPanel, { selectedOrg: 'org-a', openRoute: (p) => openedRoutes.push(p) });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-vault-rotate-input')[0].props.onChange({ target: { value: 'rotated-tok-999' } });
  tree = harness.render(VaultAndAutomationPanel, { selectedOrg: 'org-a', openRoute: (p) => openedRoutes.push(p) });
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-vault-rotate-form')[0].props.onSubmit({ preventDefault() {} });
  tree = harness.render(VaultAndAutomationPanel, { selectedOrg: 'org-a', openRoute: (p) => openedRoutes.push(p) });
  assert.ok(requests.some((r) => r.url === 'dxosVault:rotateSecret' && r.data.connectorKey === 'n8n-prod' && r.data.secrets.token === 'rotated-tok-999'));
  assert.equal(JSON.stringify(tree).includes('rotated-tok-999'), false);

  // Slim Automation Summary & Full-Screen LatticeFlow Studio Launcher
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-summary-card').length, 1);
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-open-flow-studio-btn')[0].props.onClick();
  assert.equal(openedRoutes[0], '/admin/settings/workflow/automation');

  // Rule quick-actions: Open in Studio, Run Now, Toggle, Delete, Replay Run & Delete Vault Connector
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-open-studio-auto_cmms_on_coldchain_fault')[0].props.onClick();
  assert.ok(openedRoutes[1].startsWith('/admin/settings/workflow/automation?ruleKey=auto_cmms_on_coldchain_fault'));

  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-run-auto_cmms_on_coldchain_fault')[0].props.onClick();
  tree = harness.render(VaultAndAutomationPanel, { selectedOrg: 'org-a', openRoute: (p) => openedRoutes.push(p) });
  const runReq = requests.find((r) => r.url === 'dxosAutomations:runNow');
  assert.ok(runReq && runReq.data.ruleKey === 'auto_cmms_on_coldchain_fault');
  assert.equal(runReq.data.sampleEvent.type, 'telemetry.alarm');

  const runsTable = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-runs-table')[0];
  assert.ok(runsTable && textOf(runsTable).includes('run-502'));

  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-automation-replay-run-501')[0].props.onClick();
  assert.ok(requests.some((r) => r.url === 'dxosAutomations:replayRun' && (r.data.runUid === 'run-501' || r.data.runId === 'run-501')));

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

  // Malformed Vault Secrets JSON blocks dxosVault:save API call
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-vault-key-input')[0].props.onChange({ target: { value: 'bad-vault' } });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-vault-name-input')[0].props.onChange({ target: { value: 'Bad Vault' } });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-vault-url-input')[0].props.onChange({ target: { value: 'https://example.com' } });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-vault-secrets-input')[0].props.onChange({ target: { value: '{broken' } });
  tree = harness.render(VaultAndAutomationPanel, { selectedOrg: 'org-a', setFeedback: (fb) => feedbackCalls.push(fb) });
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-vault-save-form')[0].props.onSubmit({ preventDefault() {} });
  assert.equal(requests.some((r) => r.url === 'dxosVault:save'), false);
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

test('Tab 8 (VaultAndAutomationPanel): org-switch clears stale Vault/Automation state and drops stale async responses via loadSeqRef', async () => {
  const { createBuilderBrokerPanels } = require(path.join(PLUGIN_ROOT, 'src/client/builder-broker-panels.js'));
  const harness = createQueuedReactHarness();

  let resolveSlowOrgARuns = null;
  let slowOrgARunsPromise = null;

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
    'dxosAutomations:listRules': async (req) => ({
      items: req.params.organizationId === 'org-a'
        ? [{ id: 101, ruleKey: 'rule_org_a', name: 'Rule Org A', triggerEventType: 'alarm.triggered', schemaVersion: 2, active: true }]
        : [{ id: 201, ruleKey: 'rule_org_b', name: 'Rule Org B', triggerEventType: 'telemetry.alarm', schemaVersion: 2, active: true }],
    }),
    'dxosAutomations:listRuns': async (req) => {
      if (req.params.organizationId === 'org-a') {
        if (!slowOrgARunsPromise) {
          slowOrgARunsPromise = new Promise((resolve) => {
            resolveSlowOrgARuns = resolve;
          });
        }
        return slowOrgARunsPromise;
      }
      return { items: [{ id: 902, runUid: 'run-org-b-902', ruleKey: 'rule_org_b', status: 'completed', durationMs: 8 }] };
    },
  });

  const { VaultAndAutomationPanel } = createBuilderBrokerPanels(client, harness.React, {}, {});
  let tree = await harness.mountAndFlush(VaultAndAutomationPanel, { selectedOrg: 'org-a' });
  assert.ok(JSON.stringify(tree).includes('rule_org_a'));

  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-vault-test-n8n-org-a')[0].props.onClick();
  tree = await harness.flush(VaultAndAutomationPanel, { selectedOrg: 'org-a' });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-vault-test-result').length, 1);

  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-vault-rotate-open-n8n-org-a')[0].props.onClick();
  tree = await harness.flush(VaultAndAutomationPanel, { selectedOrg: 'org-a' });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-vault-rotate-form').length, 1);

  // Switch to org-b BEFORE org-a runs response resolves
  tree = await harness.flush(VaultAndAutomationPanel, { selectedOrg: 'org-b' });
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-vault-test-result').length, 0);
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-vault-rotate-form').length, 0);
  assert.ok(JSON.stringify(tree).includes('rule_org_b'));
  assert.ok(JSON.stringify(tree).includes('run-org-b-902'));

  // Resolve stale org-a response -> loadSeqRef must discard it
  resolveSlowOrgARuns({ items: [{ id: 999, runUid: 'stale-org-a-run', ruleKey: 'rule_org_a', status: 'completed', durationMs: 99 }] });
  await new Promise((resolve) => setImmediate(resolve));
  tree = await harness.flush(VaultAndAutomationPanel, { selectedOrg: 'org-b' });
  assert.equal(JSON.stringify(tree).includes('stale-org-a-run'), false, 'Stale org-a response must never overwrite org-b runs');
  assert.ok(requests.some((r) => r.url === 'dxosAutomations:listRules' && r.params?.organizationId === 'org-b'));
});

test('studio-settings initializes tab from URL ?tab= query param safely and falls back to workflows on invalid values', async () => {
  const { createDxosStudioSettingsPage } = require(path.join(PLUGIN_ROOT, 'src/client/studio-settings.js'));
  const { client } = createApiMock({
    'dxosStudio:listTemplates': async () => ({ items: [] }),
    'dxosStudio:listEmployees': async () => ({ items: [], organizations: ['org-a'], organizationCounts: { 'org-a': 1 } }),
    'dxosStudio:readiness': async () => ({ plugins: [] }),
    'dxosVault:list': async () => ({ items: [] }),
    'dxosAutomations:listRules': async () => ({ items: [] }),
    'dxosAutomations:listRuns': async () => ({ items: [] }),
    'dxosBroker:listDevices': async () => ({ items: [] }),
    'dxosBroker:orionEntities': async () => ({ orionReachable: false, matched: [], orionOnly: [], localOnly: [] }),
    'dxosBroker:orionListSubscriptions': async () => ({ items: [] }),
    'dxosEvents:listEvents': async () => ({ items: [] }),
    'dxosEvents:listSubscriptions': async () => ({ items: [] }),
    'dxosEvents:listDeliveries': async () => ({ items: [] }),
  });

  const origWindow = globalThis.window;
  try {
    for (const [search, expectedPanelTestId] of [
      ['?tab=automation', 'dxos-studio-automation-panel'],
      ['?tab=broker', 'dxos-studio-broker-panel'],
    ]) {
      globalThis.window = { location: { search } };
      const harness = createReactHarness();
      const Page = createDxosStudioSettingsPage(client, harness.React, {}, {});
      const tree = await harness.mountAndFlush(Page);
      assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === expectedPanelTestId).length, 1);
    }

    globalThis.window = { location: { search: '?tab=invalid_evil_tab' } };
    const harnessInvalid = createReactHarness();
    const PageInvalid = createDxosStudioSettingsPage(client, harnessInvalid.React, {}, {});
    const invalidTree = await harnessInvalid.mountAndFlush(PageInvalid);
    const wfTab = collectNodes(invalidTree, (n) => n.props?.['data-testid'] === 'dxos-studio-tab-workflows')[0];
    assert.equal(wfTab.props['aria-selected'], true);
  } finally {
    if (origWindow === undefined) delete globalThis.window;
    else globalThis.window = origWindow;
  }
});

test('VaultAndAutomationPanel skips dxosAutomations:listRules and listRuns while selectedOrg is empty and fetches once resolved', async () => {
  const { createBuilderBrokerPanels } = require(path.join(PLUGIN_ROOT, 'src/client/builder-broker-panels.js'));
  const harness = createQueuedReactHarness();
  const { client, requests } = createApiMock({
    'dxosVault:list': async () => ({ items: [] }),
    'dxosAutomations:listRules': async (req) => ({ items: [{ id: 1, ruleKey: `r_${req.params.organizationId}`, name: 'R', triggerEventType: 'alarm.triggered', active: true }] }),
    'dxosAutomations:listRuns': async () => ({ items: [] }),
  });

  const { VaultAndAutomationPanel } = createBuilderBrokerPanels(client, harness.React, {}, {});
  await harness.mountAndFlush(VaultAndAutomationPanel, { selectedOrg: '' });
  assert.equal(requests.some((r) => r.url === 'dxosVault:list'), true);
  assert.equal(requests.some((r) => r.url === 'dxosAutomations:listRules'), false, 'Must NOT call listRules when selectedOrg is empty');
  assert.equal(requests.some((r) => r.url === 'dxosAutomations:listRuns'), false, 'Must NOT call listRuns when selectedOrg is empty');

  const tree = await harness.flush(VaultAndAutomationPanel, { selectedOrg: 'org-a' });
  assert.equal(requests.some((r) => r.url === 'dxosAutomations:listRules' && r.params?.organizationId === 'org-a'), true);
  assert.equal(requests.some((r) => r.url === 'dxosAutomations:listRuns' && r.params?.organizationId === 'org-a'), true);
  assert.equal(JSON.stringify(tree).includes('r_org-a'), true);
});
