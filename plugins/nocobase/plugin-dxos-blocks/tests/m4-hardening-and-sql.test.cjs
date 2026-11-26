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
const vm = require('node:vm');
const { readFileSync, statSync, readdirSync } = require('node:fs');
const { spawnSync } = require('node:child_process');

const PLUGIN_ROOT = path.resolve(__dirname, '..');

function createMiniHooks() {
  const states = [];
  let cursor = 0;
  let pendingRender = null;
  const effectCleanups = [];
  const effectDeps = [];
  let effectCursor = 0;

  const React = {
    Fragment: 'Fragment',
    createElement(type, props, ...children) {
      return { type, props: props || {}, children };
    },
    useState(init) {
      const idx = cursor++;
      if (!(idx in states)) {
        states[idx] = typeof init === 'function' ? init() : init;
      }
      const setState = (updater) => {
        states[idx] = typeof updater === 'function' ? updater(states[idx]) : updater;
      };
      return [states[idx], setState];
    },
    useEffect(fn, deps) {
      const idx = effectCursor++;
      const prev = effectDeps[idx];
      const changed = !prev || !deps || deps.length !== prev.length || deps.some((d, i) => !Object.is(d, prev[i]));
      if (changed) {
        effectDeps[idx] = deps ? deps.slice() : null;
        if (typeof effectCleanups[idx] === 'function') {
          try { effectCleanups[idx](); } catch {}
        }
        const cleanup = fn();
        effectCleanups[idx] = typeof cleanup === 'function' ? cleanup : null;
      }
    },
    useMemo(fn) {
      return fn();
    },
    useCallback(fn) {
      return fn;
    },
  };

  function resolveNode(node) {
    if (node == null || typeof node === 'boolean') return null;
    if (Array.isArray(node)) return node.map(resolveNode);
    if (typeof node !== 'object') return node;
    if (typeof node.type === 'function') {
      return resolveNode(node.type({ ...(node.props || {}), children: node.children }));
    }
    return {
      ...node,
      children: (node.children || []).map(resolveNode),
    };
  }

  function render(Component, props = {}) {
    pendingRender = () => {
      cursor = 0;
      effectCursor = 0;
      return resolveNode(Component(props));
    };
    return pendingRender();
  }

  function unmount() {
    for (const c of effectCleanups) {
      if (typeof c === 'function') {
        try { c(); } catch {}
      }
    }
  }

  return { React, render, resolveNode, unmount };
}

function findAll(node, predicate, out = []) {
  if (!node) return out;
  if (Array.isArray(node)) {
    for (const item of node) findAll(item, predicate, out);
    return out;
  }
  if (typeof node === 'object') {
    if (predicate(node)) out.push(node);
    if (Array.isArray(node.children)) findAll(node.children, predicate, out);
  }
  return out;
}

function findByTestId(node, id) {
  return findAll(node, (n) => n?.props?.['data-testid'] === id)[0] || null;
}

function textOf(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (typeof node === 'object') return textOf(node.children);
  return '';
}

function createMockBlockModelClass() {
  return class MockBlockModel {
    constructor(opts = {}) {
      this.props = opts.props || {};
      this.stepParams = opts.stepParams || {};
    }
    setProps(next) { this.props = { ...this.props, ...next }; }
    getStepParams(f, s) { return this.stepParams?.[f]?.[s]; }
    static define(meta) { this.meta = meta; }
    static registerFlow(flow) { this.flows = [...(this.flows || []), flow]; }
  };
}

test('P0-04 & P1-11: fetchParaVault filters status=active, forwards page, and renderSafeMarkdown safely parses Markdown without dangerouslySetInnerHTML', async () => {
  const { fetchParaVault, renderSafeMarkdown } = require(path.join(PLUGIN_ROOT, 'src/client/blocks-helpers.js'));
  const { React } = createMiniHooks();

  const recorded = [];
  const api = {
    async request(req) {
      recorded.push(req);
      return {
        data: {
          data: [{ id: 10, code: 'SOP-10', title: 'SOP Active', status: 'active' }],
          meta: { count: 14 },
        },
      };
    },
  };

  const res = await fetchParaVault(api, { paraSpace: 'resources', search: 'kho', page: 2, pageSize: 6 });
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].params.page, 2);
  assert.equal(recorded[0].params.pageSize, 6);
  assert.equal(typeof recorded[0].params.filter, 'string');
  const parsedParaFilter = JSON.parse(recorded[0].params.filter);
  assert.ok(parsedParaFilter.$and.some((c) => c.active === true));
  assert.ok(parsedParaFilter.$and.some((c) => c.status === 'active'));
  assert.ok(parsedParaFilter.$and.some((c) => c.paraSpace === 'resources'));
  const orBlock = parsedParaFilter.$and.find((c) => Array.isArray(c.$or));
  assert.equal(orBlock?.$or?.length, 4);
  assert.equal(res.page, 2);
  assert.equal(res.pageSize, 6);
  assert.equal(res.total, 14);

  const md = [
    '# Tiêu đề cấp 1',
    '## Mục 2 **đậm** và *nghiêng* và `code`',
    '',
    '- Gạch đầu dòng 1 [An toàn](/p/logistics)',
    '- Link ngoài [Docs](https://example.org/docs)',
    '- Link độc [XSS](javascript:alert(1))',
    '- Data URI [Bad](data:text/html,<script>alert(1)</script>)',
    '',
    '1. Bước một',
    '2. Bước hai',
    '',
    '```js',
    'const x = 1;',
    '```',
  ].join('\n');

  const rendered = renderSafeMarkdown(React, md);
  assert.ok(rendered, 'renderSafeMarkdown must return React nodes');
  const dump = JSON.stringify(rendered);
  assert.equal(dump.includes('dangerouslySetInnerHTML'), false);
  assert.equal(dump.includes('javascript:'), false);
  assert.equal(dump.includes('data:text/html'), false);

  const h1s = findAll(rendered, (n) => n.type === 'h1');
  const h2s = findAll(rendered, (n) => n.type === 'h2');
  const uls = findAll(rendered, (n) => n.type === 'ul');
  const ols = findAll(rendered, (n) => n.type === 'ol');
  const pres = findAll(rendered, (n) => n.type === 'pre');
  const anchors = findAll(rendered, (n) => n.type === 'a');
  assert.equal(h1s.length, 1);
  assert.equal(h2s.length, 1);
  assert.equal(uls.length, 1);
  assert.equal(ols.length, 1);
  assert.equal(pres.length, 1);
  assert.equal(anchors.length, 2);
  assert.equal(anchors[0].props.href, '/p/logistics');
  assert.equal(anchors[1].props.href, 'https://example.org/docs');
  assert.equal(anchors[1].props.rel, 'noopener noreferrer');
  assert.ok(textOf(rendered).includes('XSS'));
  assert.ok(textOf(rendered).includes('const x = 1;'));
});

test('P0-04: DxosParaVaultView renders contentMarkdown, blocks draft/archived ?paraDocId=, and supports pagination', async () => {
  const { registerDxosBlockModels } = require(path.join(PLUGIN_ROOT, 'src/client/block-models.js'));
  const hooks = createMiniHooks();
  const MockBlockModel = createMockBlockModelClass();

  const origWin = global.window;
  const apiCalls = [];
  const page1Docs = Array.from({ length: 6 }, (_, i) => ({
    id: i + 1,
    code: `SOP-0${i + 1}`,
    title: `Tài liệu ${i + 1}`,
    paraSpace: 'resources',
    status: 'active',
    contentMarkdown: `## Nội dung Markdown #${i + 1}\n\n- Kiểm tra **nhiệt độ**`,
  }));
  const page2Docs = [
    { id: 7, code: 'SOP-07', title: 'Tài liệu trang 2', paraSpace: 'resources', status: 'active', contentMarkdown: 'Trang 2 nội dung' },
  ];

  try {
    global.window = {
      location: { pathname: '/p/services', search: '', href: 'http://localhost/p/services' },
      history: { replaceState() {} },
      addEventListener() {},
      removeEventListener() {},
    };

    const api = {
      async request(req) {
        apiCalls.push(req);
        if (req.url === 'latticePara:summary') {
          return { data: { data: { organizationId: 'org-a', organizations: ['org-a'] } } };
        }
        if (req.url === 'latticeParaDocuments:list') {
          const p = Number(req.params?.page || 1);
          return { data: { data: p === 2 ? page2Docs : page1Docs, meta: { count: 7 } } };
        }
        if (req.url === 'latticeParaDocuments:get') {
          const id = String(req.params?.filterByTk);
          if (id === '888') {
            return { data: { data: { id: 888, code: 'SOP-DRAFT', title: 'Bản nháp mật', status: 'draft', contentMarkdown: 'SECRET DRAFT BODY' } } };
          }
          return { data: { data: page1Docs[0] } };
        }
        return { data: { data: {} } };
      },
    };

    const models = registerDxosBlockModels(
      { useAPIClient: () => api, useUIConfigurationPermissions: () => ({ allowAll: true }) },
      hooks.React,
      {},
      { BlockModel: MockBlockModel },
      { registerModels() {} },
      {},
    );
    const paraInst = new models.DxosParaVaultBlockModel({ props: { title: 'Kho P.A.R.A.', pageSize: 6 } });
    const renderComp = () => hooks.render(() => paraInst.renderComponent());

    let tree = renderComp();
    await new Promise((r) => setTimeout(r, 25));
    tree = renderComp();

    // Pagination shows Trang 1 / 2
    const pager = findByTestId(tree, 'dxos-para-pagination');
    assert.ok(pager, 'Expected pagination bar');
    assert.ok(textOf(pager).includes('Trang 1 / 2'));

    // Click Next page -> loads page 2
    findByTestId(tree, 'dxos-para-next-page').props.onClick();
    tree = renderComp();
    await new Promise((r) => setTimeout(r, 25));
    tree = renderComp();
    assert.ok(apiCalls.some((c) => c.url === 'latticeParaDocuments:list' && c.params?.page === 2));
    assert.ok(textOf(findByTestId(tree, 'dxos-para-pagination')).includes('Trang 2 / 2'));
    assert.ok(textOf(tree).includes('Tài liệu trang 2'));

    // Click Prev page -> returns to page 1 and click doc #1 to open contentMarkdown
    findByTestId(tree, 'dxos-para-prev-page').props.onClick();
    tree = renderComp();
    await new Promise((r) => setTimeout(r, 25));
    tree = renderComp();
    const firstRow = findAll(tree, (n) => n?.props?.onClick && textOf(n).includes('SOP-01'))[0];
    assert.ok(firstRow);
    firstRow.props.onClick();
    tree = renderComp();
    tree = renderComp();
    const detailBody = findByTestId(tree, 'dxos-para-doc-body');
    assert.ok(detailBody, 'Expected dxos-para-doc-body to render contentMarkdown');
    assert.ok(textOf(detailBody).includes('Nội dung Markdown #1'));
    assert.ok(findAll(detailBody, (n) => n.type === 'h2').length >= 1);

    // Search change resets page back to 1
    findByTestId(tree, 'dxos-para-next-page').props.onClick();
    tree = renderComp();
    const searchInput = findAll(tree, (n) => n.type === 'input' && n.props?.type === 'search')[0];
    searchInput.props.onChange({ target: { value: 'SOP' } });
    tree = renderComp();
    await new Promise((r) => setTimeout(r, 25));
    tree = renderComp();
    assert.ok(textOf(findByTestId(tree, 'dxos-para-pagination')).includes('Trang 1 / 2'));
  } finally {
    hooks.unmount();
    global.window = origWin;
  }

  // Test ?paraDocId=888 pointing to draft doc does NOT leak draft body
  const hooks2 = createMiniHooks();
  try {
    global.window = {
      location: { pathname: '/p/services', search: '?paraDocId=888', href: 'http://localhost/p/services?paraDocId=888' },
      history: { replaceState() {} },
      addEventListener() {},
      removeEventListener() {},
    };
    const api2 = {
      async request(req) {
        if (req.url === 'latticePara:summary') return { data: { data: { organizationId: 'org-a', organizations: ['org-a'] } } };
        if (req.url === 'latticeParaDocuments:list') return { data: { data: [], meta: { count: 0 } } };
        if (req.url === 'latticeParaDocuments:get') {
          return { data: { data: { id: 888, code: 'SOP-DRAFT', title: 'Bản nháp mật', status: 'draft', contentMarkdown: 'SECRET DRAFT BODY' } } };
        }
        return { data: { data: {} } };
      },
    };
    const models2 = registerDxosBlockModels(
      { useAPIClient: () => api2, useUIConfigurationPermissions: () => ({ allowAll: true }) },
      hooks2.React,
      {},
      { BlockModel: MockBlockModel },
      { registerModels() {} },
      {},
    );
    const paraDraft = new models2.DxosParaVaultBlockModel({ props: { title: 'Kho P.A.R.A.' } });
    let tree2 = hooks2.render(() => paraDraft.renderComponent());
    await new Promise((r) => setTimeout(r, 25));
    tree2 = hooks2.render(() => paraDraft.renderComponent());
    assert.ok(findByTestId(tree2, 'dxos-para-doc-inactive-notice'));
    assert.equal(findByTestId(tree2, 'dxos-para-doc-body'), null);
    assert.equal(JSON.stringify(tree2).includes('SECRET DRAFT BODY'), false);
  } finally {
    hooks2.unmount();
    global.window = origWin;
  }
});

test('P1-14a: WmsOps supports root org selector, releaseLotByQa button on held lots, and 390x844 responsive overflow guards', async () => {
  const { createWmsOpsBlockView } = require(path.join(PLUGIN_ROOT, 'src/client/wms-ops-block.js'));
  const hooks = createMiniHooks();
  const calls = [];
  let lotStatus = 'hold_mkt';

  const api = {
    async request(req) {
      calls.push(req);
      if (req.url === 'dxosWms:lots') {
        const orgParam = req.params?.organizationId;
        return {
          data: {
            data: {
              organizationId: orgParam || null,
              items: [
                { id: 10, lotCode: 'LOT-HOLD-01', sku: 'VAC-01', productName: 'Vaccine A', qtyAvailable: 30, status: lotStatus, organizationId: orgParam || 'org-alpha' },
                { id: 11, lotCode: 'LOT-OK-02', sku: 'VAC-01', productName: 'Vaccine B', qtyAvailable: 50, status: 'available', organizationId: orgParam || 'org-alpha' },
              ],
            },
          },
        };
      }
      if (req.url === 'latticeOrganizations:list') {
        return {
          data: {
            data: [
              { id: 1, organizationId: 'org-alpha', active: true },
              { id: 2, organizationId: 'org-beta', active: true },
            ],
          },
        };
      }
      if (req.url === 'dxosWms:allocateFefo') {
        return { data: { data: { allocatedTotal: 5, allocations: [{ lotCode: 'LOT-OK-02', qtyAllocated: 5 }] } } };
      }
      if (req.url === 'dxosWms:releaseLotByQa') {
        lotStatus = 'available';
        return { data: { data: { released: true, lot: { id: 10, lotCode: 'LOT-HOLD-01', status: 'available' }, message: 'Đã mở khóa QA lô LOT-HOLD-01.' } } };
      }
      return { data: { data: {} } };
    },
  };

  const model = { props: {}, stepParams: {}, getStepParams() { return undefined; } };
  const View = createWmsOpsBlockView({ useAPIClient: () => api }, hooks.React, {}, {});

  let tree = hooks.render(View, { model });
  await new Promise((r) => setTimeout(r, 25));
  tree = hooks.render(View, { model });

  // Root org selector appears and lists merged orgs
  const orgSelect = findByTestId(tree, 'dxos-wms-org-select');
  assert.ok(orgSelect, 'Expected dxos-wms-org-select when root is detected');
  const orgOpts = findAll(orgSelect, (n) => n.type === 'option').map((o) => o.props.value);
  assert.ok(orgOpts.includes('org-alpha') && orgOpts.includes('org-beta'));

  // Switch org to org-beta
  orgSelect.props.onChange({ target: { value: 'org-beta' } });
  tree = hooks.render(View, { model });
  await new Promise((r) => setTimeout(r, 25));
  tree = hooks.render(View, { model });
  assert.ok(calls.some((c) => c.url === 'dxosWms:lots' && c.params?.organizationId === 'org-beta'));

  // Verify allocateFefo sends selected organizationId
  findByTestId(tree, 'dxos-wms-ops-fefo-sku').props.onChange({ target: { value: 'VAC-01' } });
  tree = hooks.render(View, { model });
  await findByTestId(tree, 'dxos-wms-ops-fefo-form').props.onSubmit({ preventDefault() {} });
  tree = hooks.render(View, { model });
  const fefoCall = calls.find((c) => c.url === 'dxosWms:allocateFefo');
  assert.ok(fefoCall);
  assert.equal(fefoCall.data.organizationId, 'org-beta');

  // Release button only on hold_mkt lot, NOT on available lot
  const releaseBtn = findByTestId(tree, 'dxos-wms-release-lot-LOT-HOLD-01');
  assert.ok(releaseBtn, 'Expected Mở khóa QA button on held lot');
  assert.equal(findByTestId(tree, 'dxos-wms-release-lot-LOT-OK-02'), null);

  await releaseBtn.props.onClick();
  tree = hooks.render(View, { model });
  const relCall = calls.find((c) => c.url === 'dxosWms:releaseLotByQa');
  assert.ok(relCall);
  assert.equal(relCall.data.lotId, 10);
  assert.equal(relCall.data.lotCode, 'LOT-HOLD-01');
  assert.equal(relCall.data.organizationId, 'org-beta');
  assert.ok(textOf(findByTestId(tree, 'dxos-wms-ops-feedback')).includes('Đã mở khóa QA'));
  assert.equal(findByTestId(tree, 'dxos-wms-release-lot-LOT-HOLD-01'), null);

  // 390x844 responsive overflow guards
  const rootEl = findByTestId(tree, 'dxos-wms-ops-block');
  assert.equal(rootEl.props.style.minWidth, 0);
  assert.equal(rootEl.props.style.maxWidth, '100%');
  assert.equal(rootEl.props.style.boxSizing, 'border-box');
  const scrollWrap = findAll(tree, (n) => n.type === 'div' && n.props?.style?.overflowX === 'auto')[0];
  assert.ok(scrollWrap);
  assert.equal(scrollWrap.props.style.minWidth, 0);
  assert.equal(scrollWrap.props.style.maxWidth, '100%');
  hooks.unmount();
});

test('P1-14b: DxosAiProposalView & DxosWorkflowTasksView execute direct approve/review/reject & workflow submit CTAs with error handling', async () => {
  const { registerDxosBlockModels } = require(path.join(PLUGIN_ROOT, 'src/client/block-models.js'));
  const MockBlockModel = createMockBlockModelClass();

  // 1. AiProposal
  const hooks1 = createMiniHooks();
  const propCalls = [];
  let propState = 'proposed';
  let nextErr = null;
  const propApi = {
    async request(req) {
      propCalls.push(req);
      if (req.url === 'dxosBlocks:proposals') {
        return {
          data: {
            data: {
              items: [
                { id: 41, targetRecordId: 9, state: propState, recommendation: 'Kiểm tra van lạnh #9', evidence: [{ kind: 'telemetry' }] },
                { id: 42, targetRecordId: 10, state: 'approved', recommendation: 'Đã duyệt trước đó', evidence: [] },
              ],
            },
          },
        };
      }
      if (req.url === 'dxosBlocks:decideProposal') {
        if (nextErr) {
          const e = nextErr;
          nextErr = null;
          throw e;
        }
        propState = req.data.decision === 'approve' ? 'approved' : req.data.decision === 'review' ? 'reviewed' : 'rejected';
        return { data: { data: { ok: true, id: req.data.id, state: propState } } };
      }
      return { data: { data: {} } };
    },
  };

  const models1 = registerDxosBlockModels(
    { useAPIClient: () => propApi, useUIConfigurationPermissions: () => ({ allowAll: true }) },
    hooks1.React,
    {},
    { BlockModel: MockBlockModel },
    { registerModels() {} },
    {},
  );
  const propInst = new models1.DxosAiProposalBlockModel({ props: { targetCollection: 'latticeIncidentCases' } });
  const renderProp = () => hooks1.render(() => propInst.renderComponent());
  let pTree = renderProp();
  await new Promise((r) => setTimeout(r, 25));
  pTree = renderProp();

  assert.ok(findByTestId(pTree, 'dxos-proposal-approve-41'));
  assert.ok(findByTestId(pTree, 'dxos-proposal-review-41'));
  assert.ok(findByTestId(pTree, 'dxos-proposal-reject-toggle-41'));
  assert.equal(findByTestId(pTree, 'dxos-proposal-approve-42'), null);

  // Reject validation < 3 chars blocks API call
  findByTestId(pTree, 'dxos-proposal-reject-toggle-41').props.onClick();
  pTree = renderProp();
  findByTestId(pTree, 'dxos-proposal-reject-note-41').props.onChange({ target: { value: 'no' } });
  pTree = renderProp();
  await findByTestId(pTree, 'dxos-proposal-reject-confirm-41').props.onClick();
  pTree = renderProp();
  assert.equal(propCalls.filter((c) => c.url === 'dxosBlocks:decideProposal').length, 0);
  assert.equal(findByTestId(pTree, 'dxos-ai-proposal-feedback').props.role, 'alert');

  // 403 SELF_APPROVAL_FORBIDDEN surfaces clear Vietnamese error
  nextErr = { response: { status: 403, data: { errors: [{ code: 'SELF_APPROVAL_FORBIDDEN', message: 'Self approval' }] } } };
  await findByTestId(pTree, 'dxos-proposal-approve-41').props.onClick();
  pTree = renderProp();
  assert.ok(textOf(findByTestId(pTree, 'dxos-ai-proposal-feedback')).includes('Không thể tự phê duyệt'));

  // Valid reject >= 3 chars succeeds & reloads
  findByTestId(pTree, 'dxos-proposal-reject-note-41').props.onChange({ target: { value: 'Cảnh báo giả do bảo trì' } });
  pTree = renderProp();
  await findByTestId(pTree, 'dxos-proposal-reject-confirm-41').props.onClick();
  pTree = renderProp();
  const decCall = propCalls.find((c) => c.url === 'dxosBlocks:decideProposal' && c.data.decision === 'reject');
  assert.ok(decCall);
  assert.equal(decCall.data.note, 'Cảnh báo giả do bảo trì');
  assert.equal(findByTestId(pTree, 'dxos-proposal-approve-41'), null);
  hooks1.unmount();

  // 2. WorkflowTasks
  const hooks2 = createMiniHooks();
  const wfCalls = [];
  let taskStatus = 0;
  const wfApi = {
    async request(req) {
      wfCalls.push(req);
      if (req.url === 'workflowManualTasks:listMine') {
        return {
          data: {
            data: [
              {
                id: 77,
                status: taskStatus,
                node: {
                  key: 'reviewStep',
                  title: 'Duyệt đơn mua sắm',
                  config: {
                    forms: {
                      reviewStep: {
                        type: 'custom',
                        actions: [
                          { key: 'approve', title: 'Duyệt', values: { decision: 'approved' } },
                          { key: 'reject', title: 'Từ chối', values: { decision: 'rejected' } },
                        ],
                      },
                    },
                  },
                },
                workflow: { title: 'Quy trình Mua sắm' },
              },
            ],
            meta: { count: 1 },
          },
        };
      }
      if (req.url === 'workflowManualTasks:submit') {
        taskStatus = 1;
        return { data: { data: { id: 77, status: 1 } } };
      }
      return { data: { data: {} } };
    },
  };

  const models2 = registerDxosBlockModels(
    { useAPIClient: () => wfApi, useUIConfigurationPermissions: () => ({ allowAll: true }) },
    hooks2.React,
    {},
    { BlockModel: MockBlockModel },
    { registerModels() {} },
    {},
  );
  const wfInst = new models2.DxosWorkflowTasksBlockModel({ props: {} });
  const renderWf = () => hooks2.render(() => wfInst.renderComponent());
  let wTree = renderWf();
  await new Promise((r) => setTimeout(r, 25));
  wTree = renderWf();

  assert.ok(textOf(wTree).includes('Mở tất cả'), 'Must preserve Mở tất cả button');
  findByTestId(wTree, 'dxos-workflow-task-note-77').props.onChange({ target: { value: 'OK duyệt nhanh' } });
  wTree = renderWf();
  await findByTestId(wTree, 'dxos-workflow-task-action-77-approve').props.onClick();
  wTree = renderWf();

  const submitCall = wfCalls.find((c) => c.url === 'workflowManualTasks:submit');
  assert.ok(submitCall);
  assert.equal(submitCall.params.filterByTk, 77);
  assert.deepEqual(submitCall.data.result, {
    reviewStep: { decision: 'approved', note: 'OK duyệt nhanh' },
    _: 'approve',
  });
  assert.equal(findByTestId(wTree, 'dxos-workflow-task-action-77-approve'), null);
  hooks2.unmount();
});

test('P1-14c: BiChart aggregateQuery executes parameterized PG SQL GROUP BY inside RLS transaction and rejects SQL injection', async () => {
  const { createDxosBlocksActions } = require(path.join(PLUGIN_ROOT, 'src/server/blocks-api.js'));
  const prev = process.env.DX_PG_RLS_SESSION;
  process.env.DX_PG_RLS_SESSION = 'true';

  try {
    const orders = [
      { id: 1, organizationId: 'org-sql', status: 'approved', region: 'HCM', totalAmount: 100 },
      { id: 2, organizationId: 'org-sql', status: 'approved', region: 'CT', totalAmount: 250 },
      { id: 3, organizationId: 'org-sql', status: 'draft', region: 'CT', totalAmount: 50 },
      { id: 4, organizationId: 'org-sql', status: '__proto__', region: 'HN', totalAmount: 25 },
      { id: 5, organizationId: 'org-other', status: 'approved', region: 'HCM', totalAmount: 9999 },
    ];

    const sqlQueries = [];
    const db = {
      sequelize: {
        getDialect: () => 'postgres',
        async transaction(fn) {
          return fn({ id: 'pg-tx-1' });
        },
        async query(sql, opts = {}) {
          sqlQueries.push({ sql, opts });
          if (/set_config|SAVEPOINT/i.test(sql)) return [[], {}];

          const orgFilter = opts.replacements?.p0;
          const scoped = orgFilter ? orders.filter((r) => r.organizationId === orgFilter) : orders;

          if (/GROUP BY 1, 2/i.test(sql)) {
            const grouped = new Map();
            for (const r of scoped) {
              const rk = r.status || '(Trống)';
              const ck = r.region || '(Trống)';
              const k = `${rk}:::${ck}`;
              const prevAcc = grouped.get(k) || { rowKey: rk, colKey: ck, count: 0, numericCount: 0, sum: 0, min: Infinity, max: -Infinity };
              prevAcc.count += 1;
              prevAcc.numericCount += 1;
              prevAcc.sum += Number(r.totalAmount);
              prevAcc.min = Math.min(prevAcc.min, Number(r.totalAmount));
              prevAcc.max = Math.max(prevAcc.max, Number(r.totalAmount));
              grouped.set(k, prevAcc);
            }
            const rows = [...grouped.values()].map((a) => ({ ...a, avg: a.sum / a.numericCount, value: a.sum }));
            return [rows, {}];
          }

          if (/AS "colKey"/i.test(sql)) {
            const cols = [...new Set(scoped.map((r) => r.region || '(Trống)'))].slice(0, 2);
            return [cols.map((colKey) => ({ colKey })), {}];
          }

          if (/GROUP BY 1/i.test(sql)) {
            const grouped = new Map();
            for (const r of scoped) {
              const gk = r.status || '(Trống)';
              const prevAcc = grouped.get(gk) || { groupKey: gk, count: 0, numericCount: 0, sum: 0, min: Infinity, max: -Infinity };
              prevAcc.count += 1;
              prevAcc.numericCount += 1;
              prevAcc.sum += Number(r.totalAmount);
              prevAcc.min = Math.min(prevAcc.min, Number(r.totalAmount));
              prevAcc.max = Math.max(prevAcc.max, Number(r.totalAmount));
              grouped.set(gk, prevAcc);
            }
            const totalGroups = grouped.size;
            const lim = Number(opts.replacements?.p1 || 100);
            const rows = [...grouped.values()]
              .map((a) => ({ ...a, avg: a.sum / a.numericCount, value: a.sum, totalGroups }))
              .sort((a, b) => (b.value - a.value) || a.groupKey.localeCompare(b.groupKey))
              .slice(0, lim);
            return [rows, {}];
          }

          const totalSum = scoped.reduce((acc, r) => acc + Number(r.totalAmount), 0);
          return [[{
            count: scoped.length,
            numericCount: scoped.length,
            sum: totalSum,
            avg: scoped.length ? totalSum / scoped.length : 0,
            min: scoped.length ? Math.min(...scoped.map((r) => r.totalAmount)) : 0,
            max: scoped.length ? Math.max(...scoped.map((r) => r.totalAmount)) : 0,
            value: totalSum,
          }], {}];
        },
      },
      getModel(name) {
        if (name !== 'latticeOrders') return null;
        return {
          getTableName: () => 'latticeOrders',
          rawAttributes: {
            id: { type: 'INTEGER' },
            organizationId: { type: 'STRING' },
            status: { type: 'STRING' },
            region: { type: 'STRING' },
            totalAmount: { type: 'DECIMAL' },
          },
        };
      },
      getCollection(name) {
        if (name !== 'latticeOrders') return null;
        return {
          name: 'latticeOrders',
          fields: new Map([
            ['id', { name: 'id', type: 'bigInt' }],
            ['organizationId', { name: 'organizationId', type: 'string' }],
            ['status', { name: 'status', type: 'string' }],
            ['region', { name: 'region', type: 'string' }],
            ['totalAmount', { name: 'totalAmount', type: 'decimal' }],
          ]),
        };
      },
      getRepository(name) {
        if (name === 'latticeEmployees') {
          return { find: async () => [{ id: 10, userId: 301, organizationId: 'org-sql', active: true }] };
        }
        if (name === 'roles') {
          return { findOne: async () => ({ name: 'ldx_manager', allowAll: true }) };
        }
        if (name === 'latticeOrders') {
          return {
            find: async () => {
              throw new Error('repo.find must NOT be called when PG SQL GROUP BY path is active');
            },
          };
        }
        return null;
      },
    };

    const actions = createDxosBlocksActions(db);
    const ctx = {
      method: 'POST',
      state: { currentUser: { id: 301 }, currentRole: 'ldx_manager' },
      can: () => true,
      action: {
        params: {
          values: {
            collection: 'latticeOrders',
            chartType: 'pivot',
            groupBy: 'status',
            secondaryGroupBy: 'region',
            metric: { op: 'sum', field: 'totalAmount' },
            limit: 2,
          },
        },
      },
    };
    await actions.aggregateQuery(ctx, async () => {});
    assert.equal(ctx.body.ok, true);
    assert.equal(ctx.body.summary.sum, 425);
    assert.equal(ctx.body.summary.groupCount, 3);
    assert.equal(ctx.body.series.length, 2);
    assert.equal(ctx.body.meta.truncated, false);
    // Pivot grandTotal only sums displayed 2 rows x 2 cols (approved: 350, draft: 50 -> 400, excludes __proto__ row outside limit 2)
    assert.equal(ctx.body.pivotMatrix.grandTotal, 400);
    assert.equal(Object.getPrototypeOf(ctx.body.pivotMatrix.cells), null);

    // Verify RLS & SQL pushdown queries were emitted with bound replacements
    assert.ok(sqlQueries.some((q) => /set_config\('app\.current_org'/.test(q.sql) && q.opts?.replacements?.orgId === 'org-sql'));
    const groupSql = sqlQueries.find((q) => /GROUP BY 1 ORDER BY/i.test(q.sql));
    assert.ok(groupSql, 'Expected GROUP BY SQL query');
    assert.ok(groupSql.sql.includes('"latticeOrders"'));
    assert.ok(groupSql.sql.includes('"status"'));
    assert.equal(groupSql.opts.replacements.p0, 'org-sql');
    assert.equal(groupSql.sql.includes('org-sql'), false, 'Org ID must be bound, never interpolated');

    // SQL injection attempts rejected cleanly
    for (const badBody of [
      { collection: 'latticeOrders; DROP TABLE users', chartType: 'kpi', metric: { op: 'count' } },
      { collection: 'latticeOrders', chartType: 'bar', groupBy: 'status" FROM users --', metric: { op: 'count' } },
      { collection: 'latticeOrders', chartType: 'kpi', metric: { op: 'count' }, filter: { $sql: '1=1' } },
      { collection: 'latticeOrders', chartType: 'kpi', metric: { op: 'count' }, filter: { $col: 'passwordHash' } },
    ]) {
      await assert.rejects(
        () => actions.aggregateQuery({
          method: 'POST',
          state: { currentUser: { id: 301 }, currentRole: 'ldx_manager' },
          can: () => true,
          action: { params: { values: badBody } },
        }, async () => {}),
        (err) => err.status === 400 || err.status === 403,
      );
    }
  } finally {
    if (prev === undefined) delete process.env.DX_PG_RLS_SESSION;
    else process.env.DX_PG_RLS_SESSION = prev;
  }
});

test('P1-14d: Clean [AI Studio]/[AI]/[BI] tags and English BI column labels while preserving WebGIS/Kanban meta.label', () => {
  const { stripDevBracketTags, extractBiFieldOptions, formatBiFieldLabel } = require(path.join(PLUGIN_ROOT, 'src/client/blocks-helpers.js'));
  const { registerDxosBlockModels } = require(path.join(PLUGIN_ROOT, 'src/client/block-models.js'));
  const { DEFAULT_CREATIVE_BLUEPRINT, parseCreativeBlueprint } = require(path.join(PLUGIN_ROOT, 'src/client/creative-studio-block.js'));
  const MockBlockModel = createMockBlockModelClass();
  const { React } = createMiniHooks();

  assert.equal(stripDevBracketTags('Buồng Điều hành Thông minh [AI Studio]'), 'Buồng Điều hành Thông minh');
  assert.equal(stripDevBracketTags('Phân tích Mua sắm [BI]'), 'Phân tích Mua sắm');
  assert.equal(stripDevBracketTags('Creative App [AI]'), 'Creative App');

  assert.equal(DEFAULT_CREATIVE_BLUEPRINT.includes('[AI Studio]'), false);
  assert.equal(parseCreativeBlueprint('{}').title.includes('[AI]'), false);

  assert.equal(formatBiFieldLabel('amendmentNo'), 'Số lần điều chỉnh');
  assert.equal(formatBiFieldLabel('amendedFromId'), 'Điều chỉnh từ chứng từ ID');
  assert.equal(formatBiFieldLabel('createdAt'), 'Ngày tạo');

  const opts = extractBiFieldOptions({
    name: 'latticeOrders',
    fields: [
      { name: 'amendmentNo', type: 'integer', title: 'amendmentNo' },
      { name: 'amendedFromId', type: 'bigInt' },
      { name: 'version', type: 'integer' },
      { name: 'submittedAt', type: 'date' },
    ],
  });
  assert.deepEqual(opts.map((o) => o.value), ['amendmentNo', 'amendedFromId', 'version', 'submittedAt']);
  assert.equal(opts[0].label, 'Số lần điều chỉnh');
  assert.equal(opts[1].label, 'Điều chỉnh từ chứng từ ID');
  assert.equal(opts[2].label, 'Phiên bản');
  assert.equal(opts[3].label, 'Ngày trình duyệt');

  const models = registerDxosBlockModels(
    { useAPIClient: () => null, useUIConfigurationPermissions: () => ({ allowAll: false }) },
    React,
    {},
    { BlockModel: MockBlockModel },
    { registerModels() {} },
    {},
  );
  assert.equal(models.DxosWebGisBlockModel.meta.label, 'DX-OS Bản đồ Giám sát WebGIS [D]');
  assert.equal(models.DxosKanbanScheduleBlockModel.meta.label, 'DX-OS Bảng Kanban & Lịch [H]');
  assert.equal(models.DxosCreativeStudioBlockModel.meta.label.includes('[AI]'), false);
  const biUi = models.DxosBiChartBlockModel.flows[0].steps.config.uiSchema;
  assert.equal(biUi.groupBy.title, 'Trường nhóm chính');
});

test('P2-09b: globalSearch executes bounded SQL ILIKE per collection column whitelist, escapes wildcards, and filters active PARA docs', async () => {
  const { createDxosBlocksActions } = require(path.join(PLUGIN_ROOT, 'src/server/blocks-api.js'));
  const queries = [];

  const db = {
    sequelize: {
      getDialect: () => 'postgres',
      async transaction(fn) { return fn({ id: 'tx-gs' }); },
      async query(sql, opts = {}) {
        queries.push({ sql, opts });
        if (/FROM "latticeAssets"/.test(sql)) {
          return [[{ id: 8, code: 'AST-08', titleVal: 'Cảm biến 100%_test', status: 'active' }], {}];
        }
        if (/FROM "latticeParaDocuments"/.test(sql)) {
          return [[{ id: 15, code: 'DOC-15', titleVal: 'SOP 100%_test', status: 'active' }], {}];
        }
        return [[], {}];
      },
    },
    getModel(name) {
      const schemas = {
        latticeRequests: { id: {}, organizationId: {}, requesterId: {}, assigneeId: {}, code: {}, name: {}, description: {}, status: {} },
        latticeOrders: { id: {}, organizationId: {}, requesterId: {}, assigneeId: {}, code: {}, name: {}, description: {}, status: {} },
        latticeAssets: { id: {}, organizationId: {}, code: {}, name: {}, status: {} },
        latticeIncidentCases: { id: {}, organizationId: {}, code: {}, name: {}, status: {} },
        latticeServiceTickets: { id: {}, organizationId: {}, requesterId: {}, assigneeId: {}, code: {}, name: {}, description: {}, status: {} },
        latticeParaDocuments: { id: {}, organizationId: {}, code: {}, title: {}, summary: {}, searchText: {}, active: {}, status: {} },
      };
      if (!schemas[name]) return null;
      return { getTableName: () => name, rawAttributes: schemas[name] };
    },
    getRepository(name) {
      if (name === 'latticeEmployees') {
        return { find: async () => [{ id: 10, userId: 101, organizationId: 'org-a', active: true }] };
      }
      return {
        find: async () => {
          throw new Error(`repo.find must NOT be called for ${name} when PG SQL ILIKE is active`);
        },
      };
    },
  };

  const actions = createDxosBlocksActions(db);
  const ctx = {
    method: 'GET',
    state: { currentUser: { id: 101 }, currentRole: 'ldx_employee' },
    can: ({ resource }) => ['latticeAssets', 'latticeParaDocuments', 'latticeRequests'].includes(resource),
    action: { params: { query: '100%_test', limit: 6 } },
  };
  await actions.globalSearch(ctx, async () => {});

  assert.equal(ctx.body.count, 2);
  assert.ok(ctx.body.items.some((i) => i.collection === 'latticeAssets' && i.id === 8));
  assert.ok(ctx.body.items.some((i) => i.collection === 'latticeParaDocuments' && i.path === '/p/services?paraDocId=15'));

  const assetSql = queries.find((q) => q.sql.includes('"latticeAssets"'));
  assert.ok(assetSql);
  assert.equal(assetSql.sql.includes('"description"'), false, 'latticeAssets has no description column');
  assert.ok(assetSql.sql.includes('ILIKE'));
  assert.ok(assetSql.sql.includes('LIMIT :'));
  assert.ok(Object.values(assetSql.opts.replacements).includes('%100\\%\\_test%'), 'Must escape LIKE % and _ wildcards');

  const paraSql = queries.find((q) => q.sql.includes('"latticeParaDocuments"'));
  assert.ok(paraSql);
  assert.equal(paraSql.sql.includes('"name"'), false, 'latticeParaDocuments has no name column');
  assert.ok(paraSql.sql.includes('"active" = true'));
  assert.ok(paraSql.sql.includes('"status" ='));

  const reqSql = queries.find((q) => q.sql.includes('"latticeRequests"'));
  assert.ok(reqSql);
  assert.ok(reqSql.sql.includes('"requesterId" =') && reqSql.sql.includes('"assigneeId" ='), 'Must enforce ownScope in SQL');
});

test('P2-09a & P3-04: build.mjs enables minify/treeShaking, package.json describes 12 BlockModels @ 0.4.2, and all client files are XSS/bundler compliant', async () => {
  const pkg = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '0.4.2');
  assert.equal(pkg.license, 'Apache-2.0');
  assert.equal(pkg.nocobase?.sdkProvidedByHost, true);
  assert.equal(/six/i.test(pkg.description), false);
  assert.match(pkg.description, /12|twelve/i);

  const buildSrc = readFileSync(path.join(PLUGIN_ROOT, 'build.mjs'), 'utf8');
  assert.match(buildSrc, /minify:\s*true/);
  assert.match(buildSrc, /treeShaking:\s*true/);

  const distBundle = path.join(PLUGIN_ROOT, 'dist/client/index.js');
  const distSize = statSync(distBundle).size;
  assert.ok(distSize > 100000 && distSize < 2_200_000, `Expected minified dist/client/index.js < 2.2 MB, got ${distSize}`);
  const chk = spawnSync(process.execPath, ['--check', distBundle], { stdio: 'pipe' });
  assert.equal(chk.status, 0, 'dist/client/index.js must pass node --check');

  const clientFiles = readdirSync(path.join(PLUGIN_ROOT, 'src/client')).filter((f) => f.endsWith('.js'));
  for (const file of clientFiles) {
    const src = readFileSync(path.join(PLUGIN_ROOT, 'src/client', file), 'utf8');
    assert.equal(src.includes('dangerouslySetInnerHTML'), false, `${file} must never use dangerouslySetInnerHTML`);
    assert.ok(src.includes('SPDX-License-Identifier: Apache-2.0'), `${file} must keep SPDX header`);
    if (file !== 'index.js') {
      for (const m of src.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
        assert.ok(m[1].startsWith('.'), `${file} has forbidden non-relative require: ${m[1]}`);
      }
    }
  }
});

test('Iteration 2 Regression 1: dist/client/index.js UMD bundle preserves DxosBlocksClientPlugin, LatticeCommandPaletteProvider, and all 12 exact BlockModel keys in vm sandbox', () => {
  const distPath = path.join(PLUGIN_ROOT, 'dist/client/index.js');
  const code = readFileSync(distPath, 'utf8');
  const { React } = createMiniHooks();
  const MockBlockModel = createMockBlockModelClass();
  class MockPlugin {
    constructor(app) {
      this.app = app;
      this.flowEngine = app?.flowEngine;
    }
  }

  let registeredModels = null;
  const usedProviders = [];
  const mockApp = {
    use(provider) { usedProviders.push(provider); },
    flowEngine: {
      registerModels(models) { registeredModels = models; },
    },
  };

  const sandboxDoc = {
    documentElement: { style: {} },
    head: { appendChild() {} },
    body: {},
    createElement() { return { style: {}, setAttribute() {}, appendChild() {} }; },
    getElementById() { return null; },
    querySelector() { return null; },
  };
  const sandboxWindow = {
    document: sandboxDoc,
    location: { pathname: '/p/logistics', search: '', href: 'http://localhost/p/logistics' },
    navigator: { userAgent: 'node-vm' },
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false, addListener() {}, removeListener() {} }),
  };

  const mod = { exports: {} };
  const sandbox = {
    module: mod,
    exports: mod.exports,
    window: sandboxWindow,
    document: sandboxDoc,
    navigator: sandboxWindow.navigator,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    TextEncoder,
    TextDecoder,
    require(id) {
      if (id === '@nocobase/client') {
        return {
          Plugin: MockPlugin,
          useAPIClient: () => null,
          useUIConfigurationPermissions: () => ({ allowAll: true }),
        };
      }
      if (id === 'react') return React;
      if (id === 'antd') return {};
      if (id === '@nocobase/client-v2') return { BlockModel: MockBlockModel };
      throw new Error(`Unexpected external require in UMD sandbox: ${id}`);
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  vm.runInNewContext(code, sandbox, { filename: 'dist/client/index.js' });
  const exported = mod.exports;
  assert.deepEqual(
    Object.keys(exported).sort(),
    ['__esModule', 'createBiChartBlockView', 'createCommandPaletteProvider', 'createRecordChatterView', 'default', 'registerDxosBlockModels'].sort(),
  );
  assert.equal(exported.default.name, 'DxosBlocksClientPlugin');

  const pluginInst = new exported.default(mockApp);
  return Promise.resolve(pluginInst.load()).then(() => {
    assert.equal(usedProviders.length, 1);
    assert.equal(usedProviders[0].name, 'LatticeCommandPaletteProvider');
    const expectedModels = [
      'DxosPortalHeroBlockModel',
      'DxosKpiMetricBlockModel',
      'DxosContextTelemetryBlockModel',
      'DxosAiProposalBlockModel',
      'DxosWorkflowTasksBlockModel',
      'DxosParaVaultBlockModel',
      'DxosCreativeStudioBlockModel',
      'DxosRecordWorkbenchBlockModel',
      'DxosWebGisBlockModel',
      'DxosKanbanScheduleBlockModel',
      'DxosWmsOpsBlockModel',
      'DxosBiChartBlockModel',
    ];
    assert.ok(registeredModels, 'flowEngine.registerModels must be called');
    assert.deepEqual(Object.keys(registeredModels).sort(), expectedModels.slice().sort());
    for (const key of expectedModels) {
      assert.equal(typeof registeredModels[key], 'function');
      assert.equal(registeredModels[key].name, key);
    }
  });
});

test('Iteration 2 Regression 2: renderSafeMarkdown terminates immediately on all fence variants and handles balanced-paren links & XSS safely', () => {
  const { renderSafeMarkdown } = require(path.join(PLUGIN_ROOT, 'src/client/blocks-helpers.js'));
  const { React } = createMiniHooks();

  const fenceCases = [
    { md: '```c++\nint x = 1;\n```', expectPre: true, expectText: 'int x = 1;' },
    { md: '```js title="x"\nconst a = 1;\n```', expectPre: true, expectText: 'const a = 1;' },
    { md: '```inline```', expectPre: false, expectText: 'inline' },
    { md: '```inline``` and text', expectPre: false, expectText: 'and text' },
    { md: '````4 backticks\n```\ninside\n```\n````', expectPre: true, expectText: '```\ninside\n```' },
    { md: '```c++\nunclosed', expectPre: true, expectText: 'unclosed' },
  ];

  for (const tc of fenceCases) {
    const t0 = Date.now();
    const tree = renderSafeMarkdown(React, tc.md);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 500, `renderSafeMarkdown took too long (${elapsed}ms) for: ${tc.md}`);
    assert.ok(tree, `Expected tree for: ${tc.md}`);
    const pres = findAll(tree, (n) => n.type === 'pre');
    if (tc.expectPre) {
      assert.equal(pres.length, 1, `Expected <pre> for: ${tc.md}`);
    } else {
      assert.equal(pres.length, 0, `Expected inline <code>, not <pre> for: ${tc.md}`);
      assert.equal(findAll(tree, (n) => n.type === 'code').length, 1);
    }
    assert.ok(textOf(tree).includes(tc.expectText));
  }

  // Balanced parentheses in URLs
  const wikiTree = renderSafeMarkdown(React, '([wiki](https://en.wikipedia.org/wiki/Foo_(bar)))');
  const wikiAnchors = findAll(wikiTree, (n) => n.type === 'a');
  assert.equal(wikiAnchors.length, 1);
  assert.equal(wikiAnchors[0].props.href, 'https://en.wikipedia.org/wiki/Foo_(bar)');
  assert.equal(textOf(wikiAnchors[0]), 'wiki');
  const wikiFullText = textOf(wikiTree).replace(/\s+/g, '');
  assert.equal(wikiFullText, '(wiki)');

  const deepTree = renderSafeMarkdown(React, '[deep](https://example.org/a(b(c)))');
  const deepAnchors = findAll(deepTree, (n) => n.type === 'a');
  assert.equal(deepAnchors.length, 1);
  assert.equal(deepAnchors[0].props.href, 'https://example.org/a(b(c))');

  // XSS / unsafe scheme neutralization (with nested parens & C0 control chars)
  const xssMd = [
    '[xss1](javascript:void(alert(1)))',
    '[xss2](vbscript:msgbox(1))',
    '[xss3](data:text/html,<script>alert(1)</script>)',
    '[xss4](//evil.com/foo_(bar))',
    '[xss5](java\u0000script:alert(1))',
    '[xss6](https://example.org/\u0007bell)',
  ].join('\n');
  const xssTree = renderSafeMarkdown(React, xssMd);
  assert.equal(findAll(xssTree, (n) => n.type === 'a').length, 0);
  const dump = JSON.stringify(xssTree);
  assert.equal(dump.includes('dangerouslySetInnerHTML'), false);
  assert.equal(dump.includes('javascript:'), false);
  assert.equal(dump.includes('vbscript:'), false);
  assert.equal(dump.includes('data:text/html'), false);
  assert.equal(findAll(xssTree, (n) => n.type === 'span').length, 6);
});

test('Iteration 2 Regression 3: DxosParaVaultView blocks ?paraDocId= when active === false even if status === "active"', async () => {
  const { registerDxosBlockModels } = require(path.join(PLUGIN_ROOT, 'src/client/block-models.js'));
  const hooks = createMiniHooks();
  const MockBlockModel = createMockBlockModelClass();
  const origWin = global.window;

  try {
    global.window = {
      location: { pathname: '/p/services', search: '?paraDocId=889', href: 'http://localhost/p/services?paraDocId=889' },
      history: { replaceState() {} },
      addEventListener() {},
      removeEventListener() {},
    };
    const api = {
      async request(req) {
        if (req.url === 'latticePara:summary') return { data: { data: { organizationId: 'org-a', organizations: ['org-a'] } } };
        if (req.url === 'latticeParaDocuments:list') return { data: { data: [], meta: { count: 0 } } };
        if (req.url === 'latticeParaDocuments:get') {
          return {
            data: {
              data: {
                id: 889,
                code: 'SOP-INACTIVE',
                title: 'Ngừng hoạt động',
                active: false,
                status: 'active',
                contentMarkdown: 'SECRET INACTIVE BODY',
              },
            },
          };
        }
        return { data: { data: {} } };
      },
    };
    const models = registerDxosBlockModels(
      { useAPIClient: () => api, useUIConfigurationPermissions: () => ({ allowAll: true }) },
      hooks.React,
      {},
      { BlockModel: MockBlockModel },
      { registerModels() {} },
      {},
    );
    const paraInst = new models.DxosParaVaultBlockModel({ props: { title: 'Kho P.A.R.A.' } });
    let tree = hooks.render(() => paraInst.renderComponent());
    await new Promise((r) => setTimeout(r, 25));
    tree = hooks.render(() => paraInst.renderComponent());

    const notice = findByTestId(tree, 'dxos-para-doc-inactive-notice');
    assert.ok(notice, 'Expected dxos-para-doc-inactive-notice when active === false');
    assert.equal(textOf(notice).includes('trạng thái "active"'), false);
    assert.ok(textOf(notice).includes('ngừng kích hoạt'));
    assert.equal(findByTestId(tree, 'dxos-para-doc-body'), null);
    assert.equal(JSON.stringify(tree).includes('SECRET INACTIVE BODY'), false);
  } finally {
    hooks.unmount();
    global.window = origWin;
  }
});

test('Iteration 2 Regression 4: WmsOps renders Mở khóa QA on hold_mkt & quarantined lots, omits hold & depleted, and formats quarantined/depleted badges', async () => {
  const { formatStatusLabel, getStatusMeta } = require(path.join(PLUGIN_ROOT, 'src/client/blocks-helpers.js'));
  const { createWmsOpsBlockView } = require(path.join(PLUGIN_ROOT, 'src/client/wms-ops-block.js'));

  assert.equal(formatStatusLabel('quarantined'), 'Cách ly QA');
  assert.equal(formatStatusLabel('depleted'), 'Đã xuất hết');
  const qMeta = getStatusMeta('quarantined');
  const dMeta = getStatusMeta('depleted');
  assert.ok(qMeta.bg && qMeta.color && qMeta.border);
  assert.ok(dMeta.bg && dMeta.color && dMeta.border);

  const hooks = createMiniHooks();
  const calls = [];
  let qtnStatus = 'quarantined';
  const api = {
    async request(req) {
      calls.push(req);
      if (req.url === 'dxosWms:lots') {
        return {
          data: {
            data: {
              organizationId: 'org-alpha',
              items: [
                { id: 201, lotCode: 'LOT-MKT-01', sku: 'VAC-01', productName: 'Vaccine MKT', qtyAvailable: 10, status: 'hold_mkt', organizationId: 'org-alpha' },
                { id: 202, lotCode: 'LOT-QTN-02', sku: 'VAC-02', productName: 'Vaccine QTN', qtyAvailable: 20, status: qtnStatus, organizationId: 'org-alpha' },
                { id: 203, lotCode: 'LOT-HOLD-03', sku: 'VAC-03', productName: 'Vaccine Legacy', qtyAvailable: 15, status: 'hold', organizationId: 'org-alpha' },
                { id: 204, lotCode: 'LOT-DEP-04', sku: 'VAC-04', productName: 'Vaccine Empty', qtyAvailable: 0, status: 'depleted', organizationId: 'org-alpha' },
              ],
            },
          },
        };
      }
      if (req.url === 'latticeOrganizations:list') {
        return { data: { data: [{ id: 1, organizationId: 'org-alpha', active: true }] } };
      }
      if (req.url === 'dxosWms:releaseLotByQa') {
        qtnStatus = 'available';
        return { data: { data: { released: true, lot: { id: 202, lotCode: 'LOT-QTN-02', status: 'available' }, message: 'Đã mở khóa QA lô LOT-QTN-02.' } } };
      }
      return { data: { data: {} } };
    },
  };

  const model = { props: {}, stepParams: {}, getStepParams() { return undefined; } };
  const View = createWmsOpsBlockView({ useAPIClient: () => api }, hooks.React, {}, {});
  let tree = hooks.render(View, { model });
  await new Promise((r) => setTimeout(r, 25));
  tree = hooks.render(View, { model });

  assert.ok(findByTestId(tree, 'dxos-wms-release-lot-LOT-MKT-01'));
  const qtnBtn = findByTestId(tree, 'dxos-wms-release-lot-LOT-QTN-02');
  assert.ok(qtnBtn, 'Expected Mở khóa QA button on quarantined lot');
  assert.equal(textOf(findByTestId(tree, 'dxos-wms-lot-status-LOT-QTN-02')), 'Cách ly QA');
  assert.equal(findByTestId(tree, 'dxos-wms-release-lot-LOT-HOLD-03'), null);
  assert.equal(findByTestId(tree, 'dxos-wms-release-lot-LOT-DEP-04'), null);
  assert.equal(textOf(findByTestId(tree, 'dxos-wms-lot-status-LOT-DEP-04')), 'Đã xuất hết');

  await qtnBtn.props.onClick();
  tree = hooks.render(View, { model });
  const relCall = calls.find((c) => c.url === 'dxosWms:releaseLotByQa');
  assert.ok(relCall);
  assert.equal(relCall.data.lotId, 202);
  assert.equal(relCall.data.lotCode, 'LOT-QTN-02');
  assert.equal(findByTestId(tree, 'dxos-wms-release-lot-LOT-QTN-02'), null);
  hooks.unmount();
});

test('Iteration 2 Regression 5: BiChart pivot colRaw uses ORDER BY COUNT(*) DESC, "colKey" ASC LIMIT with identical PG SQL and JS fallback column selection', async () => {
  const { createDxosBlocksActions } = require(path.join(PLUGIN_ROOT, 'src/server/blocks-api.js'));

  const makeDataset = (rows) => ({
    async run(useSql, limit) {
      const sqlQueries = [];
      const db = {
        sequelize: useSql ? {
          getDialect: () => 'postgres',
          async transaction(fn) { return fn({ id: 'tx-pivot' }); },
          async query(sql, opts = {}) {
            sqlQueries.push({ sql, opts });
            if (/set_config|SAVEPOINT/i.test(sql)) return [[], {}];
            if (/GROUP BY 1, 2/i.test(sql)) {
              const grouped = new Map();
              for (const r of rows) {
                const k = `${r.status}:::${r.region}`;
                const prevAcc = grouped.get(k) || { rowKey: r.status, colKey: r.region, count: 0, numericCount: 0, sum: 0, min: Infinity, max: -Infinity };
                prevAcc.count += 1;
                prevAcc.numericCount += 1;
                prevAcc.sum += Number(r.totalAmount);
                prevAcc.min = Math.min(prevAcc.min, Number(r.totalAmount));
                prevAcc.max = Math.max(prevAcc.max, Number(r.totalAmount));
                grouped.set(k, prevAcc);
              }
              return [[...grouped.values()].map((a) => ({ ...a, avg: a.sum / a.numericCount, value: a.count })), {}];
            }
            if (/AS "colKey"/i.test(sql)) {
              const counts = new Map();
              for (const r of rows) counts.set(r.region, (counts.get(r.region) || 0) + 1);
              const cols = [...counts.entries()]
                .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
                .map(([colKey]) => ({ colKey }))
                .slice(0, limit);
              return [cols, {}];
            }
            if (/GROUP BY 1/i.test(sql)) {
              const grouped = new Map();
              for (const r of rows) {
                const prevAcc = grouped.get(r.status) || { groupKey: r.status, count: 0, numericCount: 0, sum: 0, min: Infinity, max: -Infinity };
                prevAcc.count += 1;
                prevAcc.numericCount += 1;
                prevAcc.sum += Number(r.totalAmount);
                prevAcc.min = Math.min(prevAcc.min, Number(r.totalAmount));
                prevAcc.max = Math.max(prevAcc.max, Number(r.totalAmount));
                grouped.set(r.status, prevAcc);
              }
              const totalGroups = grouped.size;
              return [[...grouped.values()].map((a) => ({ ...a, avg: a.sum / a.numericCount, value: a.count, totalGroups })).slice(0, limit), {}];
            }
            return [[{ count: rows.length, numericCount: rows.length, sum: rows.length, avg: 1, min: 1, max: 1, value: rows.length }], {}];
          },
        } : undefined,
        getModel: () => ({
          getTableName: () => 'latticeOrders',
          rawAttributes: { id: {}, organizationId: {}, status: {}, region: {}, totalAmount: {} },
        }),
        getCollection: () => ({
          name: 'latticeOrders',
          fields: new Map([
            ['id', { name: 'id', type: 'bigInt' }],
            ['organizationId', { name: 'organizationId', type: 'string' }],
            ['status', { name: 'status', type: 'string' }],
            ['region', { name: 'region', type: 'string' }],
            ['totalAmount', { name: 'totalAmount', type: 'decimal' }],
          ]),
        }),
        getRepository(name) {
          if (name === 'latticeEmployees') return { find: async () => [{ id: 1, userId: 301, organizationId: 'org-a', active: true }] };
          if (name === 'roles') return { findOne: async () => ({ name: 'ldx_manager', allowAll: true }) };
          if (name === 'latticeOrders') return { find: async () => rows };
          return null;
        },
      };

      const actions = createDxosBlocksActions(db);
      const ctx = {
        method: 'POST',
        state: { currentUser: { id: 301 }, currentRole: 'ldx_manager' },
        can: () => true,
        action: {
          params: {
            values: {
              collection: 'latticeOrders',
              chartType: 'pivot',
              groupBy: 'status',
              secondaryGroupBy: 'region',
              metric: { op: 'count' },
              limit,
            },
          },
        },
      };
      await actions.aggregateQuery(ctx, async () => {});
      return { body: ctx.body, sqlQueries };
    },
  });

  // Top-N frequency test ('Z-1x':1, 'A-1x':1, 'M-3x':3, 'B-2x':2)
  const freqRows = [
    { id: 1, organizationId: 'org-a', status: 'open', region: 'Z-1x', totalAmount: 10 },
    { id: 2, organizationId: 'org-a', status: 'open', region: 'A-1x', totalAmount: 10 },
    { id: 3, organizationId: 'org-a', status: 'open', region: 'B-2x', totalAmount: 10 },
    { id: 4, organizationId: 'org-a', status: 'open', region: 'B-2x', totalAmount: 10 },
    { id: 5, organizationId: 'org-a', status: 'open', region: 'M-3x', totalAmount: 10 },
    { id: 6, organizationId: 'org-a', status: 'open', region: 'M-3x', totalAmount: 10 },
    { id: 7, organizationId: 'org-a', status: 'open', region: 'M-3x', totalAmount: 10 },
  ];
  const sqlRes = await makeDataset(freqRows).run(true, 2);
  const colSql = sqlRes.sqlQueries.find((q) => /AS "colKey"/i.test(q.sql));
  assert.ok(colSql, 'Expected colRaw SQL query');
  assert.match(colSql.sql, /GROUP BY 1 ORDER BY COUNT\(\*\) DESC,\s*"colKey" ASC LIMIT :p\d+/);
  assert.deepEqual(sqlRes.body.pivotMatrix.columns, ['M-3x', 'B-2x']);

  const jsRes = await makeDataset(freqRows.slice().reverse()).run(false, 2);
  assert.deepEqual(jsRes.body.pivotMatrix.columns, ['M-3x', 'B-2x']);

  // Tie-break determinism ('Z-tie':2, 'A-tie':2, 'M-1x':1, limit 1 -> 'A-tie')
  const tieRows = [
    { id: 1, organizationId: 'org-a', status: 'open', region: 'Z-tie', totalAmount: 10 },
    { id: 2, organizationId: 'org-a', status: 'open', region: 'Z-tie', totalAmount: 10 },
    { id: 3, organizationId: 'org-a', status: 'open', region: 'M-1x', totalAmount: 10 },
    { id: 4, organizationId: 'org-a', status: 'open', region: 'A-tie', totalAmount: 10 },
    { id: 5, organizationId: 'org-a', status: 'open', region: 'A-tie', totalAmount: 10 },
  ];
  const sqlTie = await makeDataset(tieRows).run(true, 1);
  const jsTie = await makeDataset(tieRows).run(false, 1);
  assert.deepEqual(sqlTie.body.pivotMatrix.columns, ['A-tie']);
  assert.deepEqual(jsTie.body.pivotMatrix.columns, ['A-tie']);
});
