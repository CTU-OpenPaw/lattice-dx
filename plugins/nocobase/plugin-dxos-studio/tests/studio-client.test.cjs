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

test('plugin-dxos-studio registers /admin/settings/dxos-studio with aclSnippet pm and handles all 4 tabs cleanly', async () => {
  const { createDxosStudioSettingsPage } = require(path.join(PLUGIN_ROOT, 'src/client/studio-settings.js'));

  let registeredKey = null;
  let registeredOpts = null;
  const React = {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
  };
  const mockClient = {
    useAPIClient: () => ({ request: async () => ({ data: { data: {} } }) }),
  };
  const mockApp = {
    pluginSettingsManager: {
      add(key, opts) {
        registeredKey = key;
        registeredOpts = opts;
      },
    },
  };

  const Page = createDxosStudioSettingsPage(mockClient, React, {}, mockApp);
  assert.equal(typeof Page, 'function');
  mockApp.pluginSettingsManager.add('dxos-studio', { title: 'DX-OS Studio', icon: 'ControlOutlined', Component: Page, aclSnippet: 'pm' });
  assert.equal(registeredKey, 'dxos-studio');
  assert.equal(registeredOpts.aclSnippet, 'pm');

  const tree = Page();
  assert.equal(tree.props['data-testid'], 'dxos-studio-settings-page');
  const dump = JSON.stringify(tree);
  assert.ok(dump.includes('7 Plugin'), 'Studio UI should present the 7 Apache-2.0 Open-Core plugins catalog');
  assert.ok(dump.includes('AI Workforce'), 'Studio UI should expose link/reference to AI Workforce Center');
});

test('plugin-dxos-studio renders Tab 5 Outbox & DLQ panel cleanly', async () => {
  const { createDxosStudioSettingsPage } = require(path.join(PLUGIN_ROOT, 'src/client/studio-settings.js'));
  let activeTab = 'outbox';
  const React = {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (init) => {
      const val = typeof init === 'function' ? init() : init;
      if (val === 'workflows') return [activeTab, () => {}];
      if (val === false && arguments.length === 0) return [val, () => {}];
      return [val, () => {}];
    },
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
  };
  let requestedUrls = [];
  const mockClient = {
    useAPIClient: () => ({
      request: async (req) => {
        requestedUrls.push(req.url);
        return { data: { data: {} } };
      },
    }),
  };
  const Page = createDxosStudioSettingsPage(mockClient, React, {}, {});
  const tree = Page();
  const dump = JSON.stringify(tree);
  assert.ok(dump.includes('Outbox') && dump.includes('DLQ'), 'Studio UI should present Tab 5 Outbox & DLQ');
});

test('plugin-dxos-studio renders Tab 6 GitOps Solution Bundle panel cleanly', async () => {
  const { createDxosStudioSettingsPage } = require(path.join(PLUGIN_ROOT, 'src/client/studio-settings.js'));
  const React = {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (init) => {
      const val = typeof init === 'function' ? init() : init;
      if (val === 'workflows') return ['gitops', () => {}];
      return [val, () => {}];
    },
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
  };
  const mockClient = {
    useAPIClient: () => ({ request: async () => ({ data: { data: {} } }) }),
  };
  const Page = createDxosStudioSettingsPage(mockClient, React, {}, {});
  const tree = Page();
  const dump = JSON.stringify(tree);
  assert.ok(dump.includes('dxos-studio-gitops-bundle-panel'), 'Studio UI should present Tab 6 GitOps Bundle panel');
});

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

test('plugin-dxos-studio renders accessible single-row tablist/tabs and muted grey disabled buttons', () => {
  const { createDxosStudioSettingsPage } = require(path.join(PLUGIN_ROOT, 'src/client/studio-settings.js'));
  const renderTab = (activeTab) => {
    const React = {
      Fragment: 'Fragment',
      createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
      useState: (init) => {
        const val = typeof init === 'function' ? init() : init;
        if (val === 'workflows') return [activeTab, () => {}];
        return [val, () => {}];
      },
      useEffect: () => {},
      useMemo: (fn) => fn(),
      useCallback: (fn) => fn,
    };
    const mockClient = { useAPIClient: () => ({ request: async () => ({ data: { data: {} } }) }) };
    const Page = createDxosStudioSettingsPage(mockClient, React, {}, {});
    return Page();
  };

  // Tab bar a11y + single-row styling
  const wfTree = renderTab('workflows');
  const tablists = collectNodes(wfTree, (n) => n.props?.role === 'tablist');
  assert.equal(tablists.length, 1);
  assert.equal(tablists[0].props.style.flexWrap, 'nowrap');
  assert.equal(tablists[0].props.style.overflowX, 'auto');
  const tabs = collectNodes(tablists[0], (n) => n.props?.role === 'tab');
  assert.equal(tabs.length, 6);
  assert.equal(tabs[0].props['aria-selected'], true);
  assert.equal(tabs[1].props['aria-selected'], false);
  for (const t of tabs) {
    assert.equal(t.props.style.whiteSpace, 'nowrap');
    assert.equal(t.props.style.flexShrink, 0);
    assert.equal(t.props.style.fontSize, 12);
    assert.equal(t.props.style.padding, '6px 10px');
  }

  // Disabled workflow install button uses muted grey style
  const installBtn = collectNodes(wfTree, (n) => n.type === 'button' && textOf(n).includes('Cài đặt quy trình'))[0];
  assert.ok(installBtn);
  assert.equal(installBtn.props.disabled, true);
  assert.equal(installBtn.props.style.background, '#e2e8f0');
  assert.equal(installBtn.props.style.color, '#94a3b8');
  assert.equal(installBtn.props.style.cursor, 'not-allowed');

  // Disabled "Phát lại toàn bộ DLQ" button must NOT look solid clickable blue
  const outboxTree = renderTab('outbox');
  const replayAllBtn = collectNodes(outboxTree, (n) => n.type === 'button' && textOf(n).includes('Phát lại toàn bộ DLQ'))[0];
  assert.ok(replayAllBtn);
  assert.equal(replayAllBtn.props.disabled, true);
  assert.equal(replayAllBtn.props.style.background, '#e2e8f0');
  assert.equal(replayAllBtn.props.style.color, '#94a3b8');
  assert.equal(replayAllBtn.props.style.border, '1px solid #cbd5e1');
  assert.equal(replayAllBtn.props.style.cursor, 'not-allowed');

  // Disabled GitOps diff/apply buttons use muted grey while enabled export stays primary blue
  const gitopsTree = renderTab('gitops');
  const exportBtn = collectNodes(gitopsTree, (n) => n.type === 'button' && textOf(n).includes('Xuất Bundle JSON'))[0];
  const diffBtn = collectNodes(gitopsTree, (n) => n.type === 'button' && textOf(n).includes('Kiểm tra Diff'))[0];
  const applyBtn = collectNodes(gitopsTree, (n) => n.type === 'button' && textOf(n).includes('Áp dụng Bundle'))[0];
  assert.equal(exportBtn.props.disabled, false);
  assert.equal(exportBtn.props.style.background, '#1677ff');
  assert.equal(exportBtn.props.style.cursor, 'pointer');
  for (const disabledBtn of [diffBtn, applyBtn]) {
    assert.equal(disabledBtn.props.disabled, true);
    assert.equal(disabledBtn.props.style.background, '#e2e8f0');
    assert.equal(disabledBtn.props.style.color, '#94a3b8');
    assert.equal(disabledBtn.props.style.cursor, 'not-allowed');
  }
});
