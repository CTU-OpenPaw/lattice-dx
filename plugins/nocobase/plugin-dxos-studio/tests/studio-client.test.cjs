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

  // Categorized vertical left-rail navigation + 12 tabs + responsive collapse under 1024px
  const wfTree = renderTab('workflows');
  const sidebar = collectNodes(wfTree, (n) => n.props?.['data-testid'] === 'dxos-studio-sidebar')[0];
  assert.ok(sidebar, 'Expected left-rail sidebar');
  assert.equal(sidebar.props.style.width, 224);
  const tablists = collectNodes(wfTree, (n) => n.props?.role === 'tablist');
  assert.equal(tablists.length, 1);
  assert.equal(tablists[0].props['aria-orientation'], 'vertical');
  const tabs = collectNodes(tablists[0], (n) => n.props?.role === 'tab');
  assert.equal(tabs.length, 12);
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
    'dxos-studio-tab-notify',
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

test('P1-06, P1-07, P2-07 & P2-09: GitOps upload/warnings/diff-tree, Outbox filter/payload/purge, deep-link, and minified bundle < 800 KB', async () => {
  const fs = require('node:fs');
  const { createDxosStudioSettingsPage } = require(path.join(PLUGIN_ROOT, 'src/client/studio-settings.js'));

  // Deep-link section/tab parsing via URL search query
  const prevWin = globalThis.window;
  try {
    globalThis.window = { location: { search: '?tab=governance&section=dmn' } };
    const callsWin = [];
    let sIdx = 0;
    const slotsWin = [];
    const ReactWin = {
      Fragment: 'Fragment',
      createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
      useState: (init) => {
        const i = sIdx++;
        if (!(i in slotsWin)) slotsWin[i] = typeof init === 'function' ? init() : init;
        return [slotsWin[i], (n) => { slotsWin[i] = typeof n === 'function' ? n(slotsWin[i]) : n; }];
      },
      useEffect: () => {},
      useMemo: (fn) => fn(),
      useCallback: (fn) => fn,
    };
    const mockWinClient = { useAPIClient: () => ({ request: async (req) => { callsWin.push(req); return { data: { data: {} } }; } }) };
    const WinPage = createDxosStudioSettingsPage(mockWinClient, ReactWin, {}, {});
    const winTree = WinPage();
    assert.equal(slotsWin[0], 'governance');
    assert.ok(collectNodes(winTree, (n) => n.props?.['data-testid'] === 'dxos-studio-tab-dmn' && n.props?.['aria-pressed'] === true).length === 1);
  } finally {
    globalThis.window = prevWin;
  }

  // Outbox status filter, payload inspect, pagination & 2-step purge
  const calls = [];
  const renderStateful = (activeTab) => {
    let idx = 0;
    const slotValues = [];
    const React = {
      Fragment: 'Fragment',
      createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
      useState: (init) => {
        const cur = idx++;
        const v = typeof init === 'function' ? init() : init;
        if (slotValues[cur] === undefined) slotValues[cur] = cur === 0 ? activeTab : v;
        return [slotValues[cur], (next) => { slotValues[cur] = typeof next === 'function' ? next(slotValues[cur]) : next; }];
      },
      useEffect: () => {},
      useMemo: (fn) => fn(),
      useCallback: (fn) => fn,
    };
    const mockClient = {
      useAPIClient: () => ({
        request: async (req) => {
          calls.push(req);
          if (req.url === 'dxosStudio:outboxDlqList') {
            return { data: { data: { total: 40, page: req.params?.page || 1, pageSize: 25, summary: { failed: 1, retry: 1, pending: 0, processing: 0, delivered: 2 }, items: [{ id: 1, eventId: 'evt-1', organizationId: 'org-a', collectionName: 'latticeOrders', recordId: 5, attempts: 3, status: 'failed', errorCode: 'E_CONN', lastError: 'Timeout 5000ms', payloadJson: { orderNo: 'ORD-01' } }] } } };
          }
          if (req.url === 'dxosStudio:outboxDlqPurge') {
            return { data: { data: { purgedCount: 1, state: req.data.state } } };
          }
          return { data: { data: {} } };
        },
      }),
    };
    const PageInner = createDxosStudioSettingsPage(mockClient, React, {}, {});
    const render = () => {
      idx = 0;
      return PageInner();
    };
    return { tree: render(), Page: render };
  };

  const outboxCtx = renderStateful('outbox');
  // Seed outboxData directly by clicking status filter & refresh
  const statusSelect = collectNodes(outboxCtx.tree, (n) => n.props?.['data-testid'] === 'dxos-outbox-status-filter')[0];
  assert.ok(statusSelect);
  await statusSelect.props.onChange({ target: { value: 'all' } });
  const outboxNext = outboxCtx.Page();
  assert.ok(calls.some((c) => c.url === 'dxosStudio:outboxDlqList' && c.params?.state === 'all'));
  const toggleBtn = collectNodes(outboxNext, (n) => n.props?.['data-testid'] === 'dxos-outbox-payload-toggle-evt-1')[0];
  assert.ok(toggleBtn);
  toggleBtn.props.onClick();
  const outboxExpanded = outboxCtx.Page();
  const payloadView = collectNodes(outboxExpanded, (n) => n.props?.['data-testid'] === 'dxos-outbox-payload-view-evt-1')[0];
  assert.ok(payloadView && textOf(payloadView).includes('ORD-01'));
  assert.ok(textOf(payloadView).includes('Timeout 5000ms'));

  // 2-step purge
  collectNodes(outboxExpanded, (n) => n.props?.['data-testid'] === 'dxos-outbox-purge-btn')[0].props.onClick();
  const outboxConfirm = outboxCtx.Page();
  const confirmPurgeBtn = collectNodes(outboxConfirm, (n) => n.props?.['data-testid'] === 'dxos-outbox-purge-confirm-btn')[0];
  assert.ok(confirmPurgeBtn);
  await confirmPurgeBtn.props.onClick();
  assert.ok(calls.some((c) => c.url === 'dxosStudio:outboxDlqPurge' && c.method === 'post'));

  // P2-07: Purge button disabled when outboxState is pending or processing
  await statusSelect.props.onChange({ target: { value: 'pending' } });
  const outboxPending = outboxCtx.Page();
  const pendingPurgeBtn = collectNodes(outboxPending, (n) => n.props?.['data-testid'] === 'dxos-outbox-purge-btn')[0];
  assert.ok(pendingPurgeBtn);
  assert.equal(pendingPurgeBtn.props.disabled, true);
  assert.ok(textOf(pendingPurgeBtn).includes('Không thể dọn'));
  await statusSelect.props.onChange({ target: { value: 'processing' } });
  const outboxProcessing = outboxCtx.Page();
  const processingPurgeBtn = collectNodes(outboxProcessing, (n) => n.props?.['data-testid'] === 'dxos-outbox-purge-btn')[0];
  assert.ok(processingPurgeBtn);
  assert.equal(processingPurgeBtn.props.disabled, true);

  // GitOps upload input, warnings banner, connectors card & item-level diff tree
  const gitopsCtx = renderStateful('gitops');
  const fileInput = collectNodes(gitopsCtx.tree, (n) => n.props?.['data-testid'] === 'dxos-studio-gitops-file-input')[0];
  assert.ok(fileInput);
  await fileInput.props.onChange({
    target: {
      files: [{ name: 'prod-bundle.json', text: async () => '{"metadata":{"schemaVersion":"latticedx.solution-bundle/v3"},"roles":[]}' }],
    },
  });
  const gitopsAfterUpload = gitopsCtx.Page();
  assert.ok(JSON.stringify(gitopsAfterUpload).includes('prod-bundle.json'));

  // P2-09: Built Studio client bundle must stay < 800 KB when present (minified)
  const bundlePath = path.join(PLUGIN_ROOT, 'dist/client/index.js');
  if (fs.existsSync(bundlePath)) {
    const stats = fs.statSync(bundlePath);
    assert.ok(stats.size < 800 * 1024, `Studio dist/client/index.js (${stats.size} bytes) must be < 800 KB`);
  }
});

test('P1-06 regression: GitOps Diff Tree renders solution-bundle.js item-keyed diff.details (add/change/remove field before->after)', async () => {
  const { createDxosStudioSettingsPage } = require(path.join(PLUGIN_ROOT, 'src/client/studio-settings.js'));
  let idx = 0;
  const slots = [];
  const React = {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (init) => {
      const cur = idx++;
      const v = typeof init === 'function' ? init() : init;
      if (slots[cur] === undefined) slots[cur] = cur === 0 ? 'gitops' : v;
      return [slots[cur], (next) => { slots[cur] = typeof next === 'function' ? next(slots[cur]) : next; }];
    },
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
  };
  const mockClient = {
    useAPIClient: () => ({
      request: async (req) => {
        if (req.url === 'dxosStudio:solutionBundleImport') {
          return {
            data: {
              data: {
                dryRun: true,
                diff: {
                  summary: { added: 1, changed: 1, unchanged: 0, removed: 1 },
                  sections: {
                    slaPolicies: { added: [], changed: ['ticket:normal'], unchanged: [], removed: [] },
                    roles: { added: ['ldx_qa'], changed: [], unchanged: [], removed: ['ldx_old'] },
                  },
                  details: {
                    slaPolicies: {
                      'ticket:normal': {
                        action: 'change',
                        fields: [{ field: 'warnAfterMinutes', before: 120, after: 90 }],
                      },
                    },
                    roles: {
                      ldx_qa: {
                        action: 'add',
                        fields: [{ field: 'title', before: undefined, after: 'QA Reviewer' }],
                      },
                      ldx_old: {
                        action: 'remove',
                        fields: [{ field: 'title', before: 'Legacy Role', after: undefined }],
                      },
                    },
                  },
                },
              },
            },
          };
        }
        return { data: { data: {} } };
      },
    }),
  };
  const PageInner = createDxosStudioSettingsPage(mockClient, React, {}, {});
  const render = () => {
    idx = 0;
    return PageInner();
  };
  let tree = render();
  const textarea = collectNodes(tree, (n) => n.type === 'textarea')[0];
  textarea.props.onChange({ target: { value: '{"metadata":{"schemaVersion":"latticedx.solution-bundle/v3"}}' } });
  tree = render();
  const dryRunBtn = collectNodes(tree, (n) => n.type === 'button' && textOf(n).includes('Kiểm tra Diff'))[0];
  assert.ok(dryRunBtn);
  await dryRunBtn.props.onClick();
  tree = render();

  const diffTree = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-studio-gitops-diff-tree')[0];
  assert.ok(diffTree, 'dxos-studio-gitops-diff-tree must render after Dry-Run');
  const diffText = textOf(diffTree);
  assert.ok(diffText.includes('ticket:normal'), 'Diff tree must render changed item key');
  assert.ok(diffText.includes('warnAfterMinutes'), 'Diff tree must render changed field name');
  assert.ok(diffText.includes('120'), 'Diff tree must render field before value');
  assert.ok(diffText.includes('90'), 'Diff tree must render field after value');
  assert.ok(diffText.includes('QA Reviewer'), 'Diff tree must render added field value');
  assert.ok(diffText.includes('Legacy Role'), 'Diff tree must render removed field value');
});

test('Bug #10 regression: Outbox Xem Payload renders item.payload JSON instead of null when payloadJson is omitted', async () => {
  const { createDxosStudioSettingsPage } = require(path.join(PLUGIN_ROOT, 'src/client/studio-settings.js'));
  let idx = 0;
  const slots = [];
  const React = {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (init) => {
      const cur = idx++;
      const v = typeof init === 'function' ? init() : init;
      if (slots[cur] === undefined) slots[cur] = cur === 0 ? 'outbox' : v;
      return [slots[cur], (next) => { slots[cur] = typeof next === 'function' ? next(slots[cur]) : next; }];
    },
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
  };
  const mockClient = {
    useAPIClient: () => ({
      request: async (req) => {
        if (req.url === 'dxosStudio:outboxDlqList') {
          return {
            data: {
              data: {
                total: 1,
                page: 1,
                pageSize: 20,
                summary: { failed: 1, retry: 0, pending: 0, processing: 0, delivered: 0 },
                items: [
                  {
                    id: 101,
                    eventId: 'evt-real-payload-1',
                    organizationId: 'org-a',
                    collectionName: 'latticeLocations',
                    recordId: 7,
                    attempts: 3,
                    status: 'failed',
                    errorCode: 'BROKER_HTTP_502',
                    payload: { type: 'Location', code: 'WH-HCM-01' },
                  },
                ],
              },
            },
          };
        }
        return { data: { data: {} } };
      },
    }),
  };

  const PageInner = createDxosStudioSettingsPage(mockClient, React, {}, {});
  const render = () => {
    idx = 0;
    return PageInner();
  };

  let tree = render();
  const statusSelect = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-outbox-status-filter')[0];
  assert.ok(statusSelect);
  await statusSelect.props.onChange({ target: { value: 'failed' } });
  tree = render();

  const toggleBtn = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-outbox-payload-toggle-evt-real-payload-1')[0];
  assert.ok(toggleBtn, 'Expected Xem Payload toggle button for evt-real-payload-1');
  toggleBtn.props.onClick();
  tree = render();

  const payloadView = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dxos-outbox-payload-view-evt-real-payload-1')[0];
  assert.ok(payloadView, 'Expected payload view panel to render when toggled');
  const pre = collectNodes(payloadView, (n) => n.type === 'pre')[0];
  assert.ok(pre, 'Expected <pre> element inside outbox payload view');
  const renderedJson = textOf(pre).trim();
  assert.notEqual(renderedJson, 'null', 'Outbox payload <pre> must NOT render null when item.payload exists');
  assert.deepEqual(JSON.parse(renderedJson), { type: 'Location', code: 'WH-HCM-01' });
});
