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
  assert.ok(dump.includes('GitOps Solution Bundle v3'), 'Studio UI Tab 6 should present GitOps Solution Bundle v3 heading');
  assert.ok(dump.includes('latticedx.solution-bundle/v3 (hỗ trợ cả v1/v2)'), 'Studio UI Tab 6 should present Bundle v3 placeholder');
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

  // Categorized vertical left-rail navigation + 11 tabs + responsive collapse under 1024px
  const wfTree = renderTab('workflows');
  const sidebar = collectNodes(wfTree, (n) => n.props?.['data-testid'] === 'dxos-studio-sidebar')[0];
  assert.ok(sidebar, 'Expected left-rail sidebar');
  assert.equal(sidebar.props.style.width, 224);
  const tablists = collectNodes(wfTree, (n) => n.props?.role === 'tablist');
  assert.equal(tablists.length, 1);
  assert.equal(tablists[0].props['aria-orientation'], 'vertical');
  const tabs = collectNodes(tablists[0], (n) => n.props?.role === 'tab');
  assert.equal(tabs.length, 11);
  const wfTab = tabs.find((t) => t.props['data-testid'] === 'dxos-studio-tab-workflows');
  const portTab = tabs.find((t) => t.props['data-testid'] === 'dxos-studio-tab-portals');
  assert.equal(wfTab.props['aria-selected'], true);
  assert.equal(portTab.props['aria-selected'], false);
  const tabIds = new Set(tabs.map((t) => t.props['data-testid']));
  for (const expectedId of [
    'dxos-studio-tab-workflows',
    'dxos-studio-tab-portals',
    'dxos-studio-tab-plugins',
    'dxos-studio-tab-pof',
    'dxos-studio-tab-outbox',
    'dxos-studio-tab-gitops',
    'dxos-studio-tab-broker',
    'dxos-studio-tab-automation',
    'dxos-studio-tab-builder',
    'dxos-studio-tab-forms',
    'dxos-studio-tab-approvals',
  ]) {
    assert.ok(tabIds.has(expectedId), `Missing tab ${expectedId}`);
  }
  const treeDump = JSON.stringify(wfTree);
  assert.ok(treeDump.includes('Ứng dụng & Dữ liệu'));
  assert.ok(treeDump.includes('Quy trình & Phê duyệt'));
  assert.ok(treeDump.includes('Tích hợp & Vận hành'));
  assert.equal(/\[P\]|\[D\]|\[H\]|\[W\]/.test(treeDump), false, 'Studio UI must not expose raw [P]/[D]/[H]/[W] tags');
  for (const t of tabs) {
    assert.equal(t.props.style.fontSize, 12);
    assert.equal(t.props.style.width, '100%');
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

test('plugin-dxos-studio Tab 6 renders download .json, rollback button, and per-section counts safely in Node', async () => {
  const { createDxosStudioSettingsPage } = require(path.join(PLUGIN_ROOT, 'src/client/studio-settings.js'));
  const calls = [];
  const stateValues = {
    bundleText: '{"metadata":{"schemaVersion":"latticedx.solution-bundle/v2"}}',
    bundleInfo: {
      sha256: 'abcdef1234567890',
      diff: {
        summary: { added: 2, changed: 1, unchanged: 4, removed: 0 },
        sections: {
          roles: { added: ['ldx_qa'], changed: [], unchanged: ['ldx_employee'], removed: ['ldx_legacy'] },
          portals: { added: ['ldx-portal-qa'], changed: [], unchanged: [], removed: [] },
          workflows: { added: [], changed: ['wf-1'], unchanged: [], removed: [] },
          customCollections: { added: [], changed: [], unchanged: ['latticeCustomA'], removed: [] },
          aiProfiles: { added: [], changed: [], unchanged: ['dxos-ops'], removed: [] },
        },
        roleResources: { added: ['ldx_qa::main::latticeRequests'], changed: [], unchanged: [], removed: [] },
      },
      applied: {
        rolesUpserted: 2,
        roleResourcesUpserted: 3,
        portalsUpserted: 1,
        workflowsUpserted: 1,
        nodesUpserted: 2,
        customCollectionsUpserted: 1,
        aiProfilesUpserted: 1,
      },
    },
  };

  let emptyCount = 0;
  let nullCount = 0;
  const React = {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (init) => {
      const val = typeof init === 'function' ? init() : init;
      if (val === 'workflows') return ['gitops', () => {}];
      if (val === '') {
        emptyCount += 1;
        if (emptyCount === 2) return [stateValues.bundleText, (v) => { stateValues.bundleText = v; }];
      }
      if (val === null) {
        nullCount += 1;
        if (nullCount === 3) return [stateValues.bundleInfo, (v) => { stateValues.bundleInfo = typeof v === 'function' ? v(stateValues.bundleInfo) : v; }];
      }
      return [val, () => {}];
    },
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
  };
  const mockClient = {
    useAPIClient: () => ({
      request: async (req) => {
        calls.push(req);
        return {
          data: {
            data: {
              rolledBack: true,
              snapshotUid: 'gitops-test-01',
              restored: {
                rolesUpserted: 2,
                roleResourcesUpserted: 1,
                portalsUpserted: 1,
                workflowsUpserted: 1,
                nodesUpserted: 1,
                customCollectionsUpserted: 1,
                aiProfilesUpserted: 1,
              },
            },
          },
        };
      },
    }),
  };

  const Page = createDxosStudioSettingsPage(mockClient, React, {}, {});
  const tree = Page();
  const dump = JSON.stringify(tree);

  const downloadBtn = collectNodes(tree, (n) => n.type === 'button' && textOf(n).includes('Tải tệp .json'))[0];
  const rollbackBtn = collectNodes(tree, (n) => n.type === 'button' && textOf(n).includes('Hoàn tác Import gần nhất'))[0];
  assert.ok(downloadBtn, 'Tab 6 should render "Tải tệp .json" button');
  assert.ok(rollbackBtn, 'Tab 6 should render "Hoàn tác Import gần nhất" button');
  assert.equal(downloadBtn.props.disabled, false);

  // Per-section counts displayed for all sections including governance and removed count
  for (const sectionKey of ['roles', 'roleResources', 'portals', 'workflows', 'customCollections', 'aiProfiles', 'governance']) {
    assert.ok(dump.includes(sectionKey), `Tab 6 should display per-section count for ${sectionKey}`);
  }
  assert.ok(dump.includes('-1'), 'Tab 6 diffSummary should display removed count when removed has items');

  // Safe no-op in Node without window/Blob/document, and invokes Blob+<a download> with URL.revokeObjectURL in finally
  downloadBtn.props.onClick();
  const origBlob = globalThis.Blob;
  const origUrl = globalThis.URL;
  const origDoc = globalThis.document;
  let downloadedName = '';
  let clicked = false;
  const revokedUrls = [];
  try {
    globalThis.Blob = class FakeBlob { constructor(parts, opts) { this.parts = parts; this.opts = opts; } };
    globalThis.URL = {
      createObjectURL: () => 'blob:mock-1',
      revokeObjectURL: (u) => { revokedUrls.push(u); },
    };
    globalThis.document = {
      createElement: () => ({ click: () => { clicked = true; }, set download(v) { downloadedName = v; }, get download() { return downloadedName; } }),
      body: { appendChild: () => {}, removeChild: () => {} },
    };
    downloadBtn.props.onClick();
    assert.equal(clicked, true);
    assert.equal(downloadedName, 'latticedx-solution-bundle.json');
    assert.deepEqual(revokedUrls, ['blob:mock-1']);

    // Ensure finally still revokes object URL if click throws
    globalThis.document.createElement = () => ({ click: () => { throw new Error('boom'); } });
    assert.throws(() => downloadBtn.props.onClick(), /boom/);
    assert.deepEqual(revokedUrls, ['blob:mock-1', 'blob:mock-1']);
  } finally {
    if (origBlob === undefined) delete globalThis.Blob; else globalThis.Blob = origBlob;
    globalThis.URL = origUrl;
    if (origDoc === undefined) delete globalThis.document; else globalThis.document = origDoc;
  }

  // Clicking rollback calls dxosStudio:solutionBundleRollback and clears stale dry-run diff
  await rollbackBtn.props.onClick();
  assert.ok(calls.some((c) => c.url === 'dxosStudio:solutionBundleRollback' && c.method === 'post'));
  assert.equal(stateValues.bundleInfo.diff, null);
  assert.equal(stateValues.bundleInfo.applied.roleResourcesUpserted, 1);
});
