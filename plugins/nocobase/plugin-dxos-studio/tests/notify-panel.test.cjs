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
const { readFileSync } = require('node:fs');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const SOURCE_PATH = path.join(PLUGIN_ROOT, 'src/client/notify-panel.js');

function collectNodes(node, pred, acc = []) {
  if (!node) return acc;
  if (Array.isArray(node)) {
    for (const item of node) collectNodes(item, pred, acc);
    return acc;
  }
  if (typeof node === 'object') {
    if (pred(node)) acc.push(node);
    if (Array.isArray(node.children)) collectNodes(node.children, pred, acc);
  }
  return acc;
}

function textOf(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && typeof node === 'object' && Array.isArray(node.children)) return textOf(node.children);
  return '';
}

function createReactHarness() {
  let states = [];
  let effects = [];
  let memos = [];
  let pendingEffects = [];
  let stateIdx = 0;
  let effectIdx = 0;
  let memoIdx = 0;

  const React = {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (init) => {
      const idx = stateIdx++;
      if (!(idx in states)) states[idx] = typeof init === 'function' ? init() : init;
      return [
        states[idx],
        (next) => {
          states[idx] = typeof next === 'function' ? next(states[idx]) : next;
        },
      ];
    },
    useEffect: (fn, deps) => {
      const idx = effectIdx++;
      const prev = effects[idx];
      const changed = !prev || !Array.isArray(deps) || deps.length !== prev.deps?.length || deps.some((d, i) => !Object.is(d, prev.deps[i]));
      if (changed) {
        effects[idx] = { deps };
        pendingEffects.push(fn);
      }
    },
    useMemo: (fn, deps) => {
      const idx = memoIdx++;
      const prev = memos[idx];
      const changed = !prev || !Array.isArray(deps) || deps.length !== prev.deps?.length || deps.some((d, i) => !Object.is(d, prev.deps[i]));
      if (changed) memos[idx] = { deps, value: fn() };
      return memos[idx].value;
    },
    useCallback: (fn) => fn,
  };

  function renderNode(node) {
    if (!node) return node;
    if (Array.isArray(node)) return node.map(renderNode);
    if (typeof node === 'object' && typeof node.type === 'function') {
      const prevS = stateIdx;
      const prevE = effectIdx;
      const prevM = memoIdx;
      let out;
      if (prevS === 0) {
        out = node.type(node.props || {});
      } else {
        // Subcomponent renders sequentially after parent hooks in single-component harness
        out = node.type(node.props || {});
      }
      void prevE;
      void prevM;
      return renderNode(out);
    }
    if (node && typeof node === 'object' && Array.isArray(node.children)) {
      return { ...node, children: node.children.map(renderNode) };
    }
    return node;
  }

  function render(ComponentFn, props = {}) {
    stateIdx = 0;
    effectIdx = 0;
    memoIdx = 0;
    return renderNode(React.createElement(ComponentFn, props));
  }

  async function mountAndFlush(ComponentFn, props = {}) {
    let tree = render(ComponentFn, props);
    for (let pass = 0; pass < 5 && pendingEffects.length > 0; pass += 1) {
      const batch = pendingEffects.splice(0, pendingEffects.length);
      for (const eff of batch) {
        await eff();
      }
      await new Promise((resolve) => setImmediate(resolve));
      tree = render(ComponentFn, props);
    }
    return tree;
  }

  return { React, render, mountAndFlush };
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

test('notify-panel.js exports createNotifyPanel & CHANNEL_META and obeys Studio security & SPDX rules', () => {
  const src = readFileSync(SOURCE_PATH, 'utf8');
  assert.ok(src.includes('SPDX-License-Identifier: Apache-2.0'));
  assert.doesNotMatch(src, /require\(['"](?:react|antd|@nocobase\/client)['"]\)/);
  assert.doesNotMatch(src, /\blocalStorage\b|\bsessionStorage\b/);
  assert.doesNotMatch(src, /dangerouslySetInnerHTML/);

  const mod = require(SOURCE_PATH);
  assert.equal(typeof mod.createNotifyPanel, 'function');
  assert.deepEqual(mod.CHANNEL_META.map((c) => c.id), ['smtp', 'telegram', 'slack', 'webhook']);
});

test('NotifyPanel renders 4 channel cards, sends test notification via dxosNotify:testSend, and filters/paginates logs', async () => {
  const { createNotifyPanel } = require(SOURCE_PATH);
  const harness = createReactHarness();
  const sampleLogs = Array.from({ length: 22 }, (_, idx) => ({
    id: idx + 1,
    deliveryUid: `NTF-${idx + 1}`,
    channel: idx === 0 ? 'telegram' : 'smtp',
    targetMasked: idx === 0 ? '-100***789' : 'ops@***',
    status: idx % 3 === 0 ? 'dry_run' : 'sent',
    dryRun: idx % 3 === 0,
    attempt: 1,
    maxAttempts: 3,
    httpStatus: 200,
    createdAt: '2026-11-26T08:00:00.000Z',
    payloadPreviewJson: { title: `Alert #${idx + 1}` },
  }));

  const { client, requests } = createApiMock({
    'get dxosNotify:channels': async () => ({
      supportedChannels: ['smtp', 'telegram', 'slack', 'webhook'],
      items: [
        { channel: 'smtp', connectorKey: 'smtp-primary', name: 'Primary SMTP', authType: 'smtp', active: true },
        { channel: 'telegram', connectorKey: 'tg-ops', name: 'Telegram Ops', authType: 'bot', active: true },
      ],
    }),
    'get dxosNotify:logs': async (req) => {
      const ch = req.params?.channel || '';
      const st = req.params?.status || '';
      const dry = req.params?.dryRun;
      const offset = Number(req.params?.offset || 0);
      const limit = Number(req.params?.limit || 20);
      const filtered = sampleLogs.filter((l) => {
        if (ch && l.channel !== ch) return false;
        if (st && l.status !== st) return false;
        if (typeof dry === 'boolean' && l.dryRun !== dry) return false;
        return true;
      });
      return {
        total: filtered.length,
        items: filtered.slice(offset, offset + limit),
      };
    },
    'post dxosNotify:testSend': async (req) => ({
      ok: true,
      channel: req.data.channel,
      status: req.data.dryRun ? 'dry_run' : 'sent',
      deliveryUid: 'NTF-TEST-99',
      targetMasked: '-100***999',
    }),
  });

  const NotifyPanel = createNotifyPanel(client, harness.React, {}, {});
  let tree = await harness.mountAndFlush(NotifyPanel, { selectedOrg: 'org-a', openRoute: () => {} });

  for (const ch of ['smtp', 'telegram', 'slack', 'webhook']) {
    const card = collectNodes(tree, (n) => n.props?.['data-testid'] === `dxos-notify-channel-card-${ch}`)[0];
    assert.ok(card, `Expected channel card for ${ch}`);
  }
  assert.ok(JSON.stringify(tree).includes('Primary SMTP (smtp-primary)'));

  // Switch channel to telegram, enter chatId, submit testSend
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-notify-channel-select')[0].props.onChange({ target: { value: 'telegram' } });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-notify-target-input')[0].props.onChange({ target: { value: '-10099887766' } });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-notify-title-input')[0].props.onChange({ target: { value: 'Cold Excursion' } });
  tree = harness.render(NotifyPanel, { selectedOrg: 'org-a', openRoute: () => {} });

  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-notify-test-form')[0].props.onSubmit({ preventDefault() {} });
  tree = harness.render(NotifyPanel, { selectedOrg: 'org-a', openRoute: () => {} });

  const testReq = requests.find((r) => r.url === 'dxosNotify:testSend');
  assert.ok(testReq);
  assert.equal(testReq.data.channel, 'telegram');
  assert.equal(testReq.data.chatId, '-10099887766');
  assert.equal(testReq.data.dryRun, true);
  assert.equal(testReq.data.organizationId, 'org-a');
  const resultBanner = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-notify-test-result')[0];
  assert.ok(resultBanner && textOf(resultBanner).includes('NTF-TEST-99'));

  // Filter logs + paginate
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-notify-logs-next')[0].props.onClick();
  tree = await harness.mountAndFlush(NotifyPanel, { selectedOrg: 'org-a', openRoute: () => {} });
  assert.ok(requests.some((r) => r.url === 'dxosNotify:logs' && r.params?.offset === 20));

  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-notify-logs-channel-filter')[0].props.onChange({ target: { value: 'telegram' } });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-notify-logs-dryrun-filter')[0].props.onChange({ target: { value: 'true' } });
  tree = await harness.mountAndFlush(NotifyPanel, { selectedOrg: 'org-a', openRoute: () => {} });
  assert.ok(requests.some((r) => r.url === 'dxosNotify:logs' && r.params?.channel === 'telegram' && r.params?.dryRun === true));

  // Expand log row detail
  const viewBtn = collectNodes(tree, (n) => n.type === 'button' && textOf(n) === 'Xem')[0];
  assert.ok(viewBtn);
  viewBtn.props.onClick();
  tree = harness.render(NotifyPanel, { selectedOrg: 'org-a', openRoute: () => {} });
  assert.ok(JSON.stringify(tree).includes('Alert #1'));
});

test('NotifyPanel skips dxosNotify:channels and dxosNotify:logs when organizationId is empty on mount and fetches once provided', async () => {
  const { createNotifyPanel } = require(SOURCE_PATH);
  const harness = createReactHarness();
  const feedbackEvents = [];
  const { client, requests } = createApiMock({
    'get dxosNotify:channels': async (req) => {
      assert.ok(req.params?.organizationId, 'channels must receive non-empty organizationId');
      return {
        organizationId: req.params.organizationId,
        supportedChannels: ['smtp', 'telegram', 'slack', 'webhook'],
        items: [{ channel: 'smtp', connectorKey: 'smtp-lab', name: 'Lab SMTP', authType: 'smtp', active: true }],
      };
    },
    'get dxosNotify:logs': async (req) => {
      assert.ok(req.params?.organizationId, 'logs must receive non-empty organizationId');
      return {
        total: 1,
        items: [{
          id: 1,
          deliveryUid: 'NTF-LAB-1',
          channel: 'smtp',
          targetMasked: 'ops@***',
          status: 'dry_run',
          dryRun: true,
          attempt: 1,
          maxAttempts: 3,
          httpStatus: 200,
          createdAt: '2026-11-26T09:00:00.000Z',
        }],
      };
    },
  });

  const NotifyPanel = createNotifyPanel(client, harness.React, {}, {});

  // Initial mount before studio-settings resolves selectedOrg
  let tree = await harness.mountAndFlush(NotifyPanel, { selectedOrg: '', setFeedback: (fb) => feedbackEvents.push(fb) });
  assert.equal(requests.length, 0);

  // Whitespace-only organizationId should also skip fetching
  tree = await harness.mountAndFlush(NotifyPanel, { selectedOrg: '   ', setFeedback: (fb) => feedbackEvents.push(fb) });
  assert.equal(requests.length, 0);

  // Clicking Refresh or submitting while organizationId is unset must not trigger 403 requests
  const refreshBtn = collectNodes(tree, (n) => n.type === 'button' && textOf(n) === 'Làm mới')[0];
  assert.ok(refreshBtn);
  assert.equal(refreshBtn.props.disabled, true);
  refreshBtn.props.onClick();
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-notify-test-form')[0].props.onSubmit({ preventDefault() {} });
  assert.equal(requests.length, 0);

  // Once organizationId resolves, both channels and logs are fetched with consistent organizationId
  tree = await harness.mountAndFlush(NotifyPanel, { selectedOrg: 'native-ui-lab', setFeedback: (fb) => feedbackEvents.push(fb) });
  const channelReqs = requests.filter((r) => r.url === 'dxosNotify:channels');
  const logReqs = requests.filter((r) => r.url === 'dxosNotify:logs');
  assert.ok(channelReqs.length >= 1);
  assert.ok(logReqs.length >= 1);
  assert.ok(channelReqs.every((r) => r.params?.organizationId === 'native-ui-lab'));
  assert.ok(logReqs.every((r) => r.params?.organizationId === 'native-ui-lab'));
  assert.equal(feedbackEvents.filter((f) => f?.type === 'error').length, 0);
  assert.ok(JSON.stringify(tree).includes('Lab SMTP (smtp-lab)'));
  assert.ok(JSON.stringify(tree).includes('ops@***'));
});

test('DxosStudioSettingsPage mounts NotifyPanel on ?tab=notify without firing un-scoped notify calls before selectedOrg resolves', async () => {
  const { createDxosStudioSettingsPage } = require(path.join(PLUGIN_ROOT, 'src/client/studio-settings.js'));
  const harness = createReactHarness();
  const prevWindow = globalThis.window;
  globalThis.window = { location: { search: '?tab=notify' } };
  try {
    const { client, requests } = createApiMock({
      'dxosStudio:listTemplates': async () => ({ items: [] }),
      'dxosStudio:listEmployees': async () => ({ items: [], organizations: ['org-a'], organizationCounts: { 'org-a': 1 } }),
      'dxosStudio:readiness': async () => ({ plugins: [] }),
      'dxosNotify:channels': async (req) => {
        if (!req.params?.organizationId) {
          const err = new Error('NATIVE_MEMBERSHIP_REQUIRED');
          err.response = { status: 403, data: { errors: [{ message: 'NATIVE_MEMBERSHIP_REQUIRED', code: 'NATIVE_MEMBERSHIP_REQUIRED' }] } };
          throw err;
        }
        return { supportedChannels: ['smtp', 'telegram', 'slack', 'webhook'], items: [] };
      },
      'dxosNotify:logs': async (req) => {
        if (!req.params?.organizationId) {
          const err = new Error('NATIVE_MEMBERSHIP_REQUIRED');
          err.response = { status: 403, data: { errors: [{ message: 'NATIVE_MEMBERSHIP_REQUIRED', code: 'NATIVE_MEMBERSHIP_REQUIRED' }] } };
          throw err;
        }
        return { total: 0, items: [] };
      },
    });
    const Page = createDxosStudioSettingsPage(client, harness.React, {}, {});
    const tree = await harness.mountAndFlush(Page);
    assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-studio-notify-panel').length, 1);
    const channelReqs = requests.filter((r) => r.url === 'dxosNotify:channels');
    const logReqs = requests.filter((r) => r.url === 'dxosNotify:logs');
    assert.ok(channelReqs.length >= 1);
    assert.ok(logReqs.length >= 1);
    assert.ok(channelReqs.every((r) => r.params?.organizationId === 'org-a'));
    assert.ok(logReqs.every((r) => r.params?.organizationId === 'org-a'));
    assert.equal(collectNodes(tree, (n) => n.props?.role === 'status').length, 0);
  } finally {
    globalThis.window = prevWindow;
  }
});
