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
const Module = require('node:module');
const path = require('node:path');
const { readFileSync } = require('node:fs');

const PLUGIN_ROOT = path.resolve(__dirname, '..');

function createReactStub() {
  return {
    createElement(type, props, ...children) {
      return { type, props: { ...(props || {}), children } };
    },
    useState(init) { return [typeof init === 'function' ? init() : init, () => {}]; },
    useEffect() {},
    useCallback(fn) { return fn; },
    useMemo(fn) { return fn(); },
    useRef(init) { return { current: init }; },
  };
}

function createMiniHooks() {
  const depsChanged = (a, b) => !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]));
  const states = [];
  const effects = [];
  const memos = [];
  const callbacks = [];
  let si = 0;
  let ei = 0;
  let mi = 0;
  let ci = 0;
  let dirty = false;

  const React = {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({
      type,
      props: { ...(props || {}), children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) },
    }),
    useState(init) {
      const idx = si++;
      if (!(idx in states)) states[idx] = typeof init === 'function' ? init() : init;
      return [
        states[idx],
        (updater) => {
          states[idx] = typeof updater === 'function' ? updater(states[idx]) : updater;
          dirty = true;
        },
      ];
    },
    useEffect(fn, deps) {
      const idx = ei++;
      const prev = effects[idx];
      if (!prev || depsChanged(prev.deps, deps)) {
        effects[idx] = { fn, deps, cleanup: prev?.cleanup, pending: true };
      }
    },
    useMemo(fn, deps) {
      const idx = mi++;
      const prev = memos[idx];
      if (!prev || depsChanged(prev.deps, deps)) {
        memos[idx] = { value: fn(), deps };
      }
      return memos[idx].value;
    },
    useCallback(fn, deps) {
      const idx = ci++;
      const prev = callbacks[idx];
      if (!prev || depsChanged(prev.deps, deps)) {
        callbacks[idx] = { fn, deps };
      }
      return callbacks[idx].fn;
    },
  };

  const render = (Comp, props) => {
    let tree;
    for (let pass = 0; pass < 6; pass += 1) {
      si = 0;
      ei = 0;
      mi = 0;
      ci = 0;
      dirty = false;
      tree = Comp(props);
      for (const ef of effects) {
        if (ef && ef.pending) {
          ef.pending = false;
          if (typeof ef.cleanup === 'function') ef.cleanup();
          ef.cleanup = ef.fn();
        }
      }
      if (!dirty) break;
    }
    return tree;
  };

  return { React, render };
}

function createAntdStub() {
  const comp = (name) => Object.assign(function Stub(props) { return { name, props }; }, { displayName: name });
  return {
    Card: comp('Card'),
    Button: comp('Button'),
    Space: comp('Space'),
    Tag: comp('Tag'),
    Alert: comp('Alert'),
    Select: comp('Select'),
    Input: Object.assign(comp('Input'), { TextArea: comp('Input.TextArea') }),
    InputNumber: comp('InputNumber'),
    Table: comp('Table'),
    Modal: comp('Modal'),
    Drawer: comp('Drawer'),
    Popconfirm: comp('Popconfirm'),
    Tabs: comp('Tabs'),
    Descriptions: comp('Descriptions'),
    Statistic: comp('Statistic'),
    Row: comp('Row'),
    Col: comp('Col'),
    Typography: { Title: comp('Typography.Title'), Text: comp('Typography.Text'), Paragraph: comp('Typography.Paragraph') },
    Divider: comp('Divider'),
    Spin: comp('Spin'),
    Empty: comp('Empty'),
  };
}

function collectNodes(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) collectNodes(item, out);
    return out;
  }
  out.push(node);
  const children = node.props?.children;
  if (Array.isArray(children)) {
    for (const c of children) collectNodes(c, out);
  } else if (children && typeof children === 'object') {
    collectNodes(children, out);
  }
  if (node.props?.extra && typeof node.props.extra === 'object') {
    collectNodes(node.props.extra, out);
  }
  return out;
}

function findByTestId(node, id) {
  return collectNodes(node).find((n) => n.props?.['data-testid'] === id) || null;
}

test('plugin-dxos-para client registers /admin/settings/dxos-para settings panel and renders index health + OCR test UI', async () => {
  const origLoad = Module._load;
  const ReactStub = createReactStub();
  const AntdStub = createAntdStub();
  class MockClientPlugin {
    constructor(app) { this.app = app; }
  }
  const mockClient = {
    Plugin: MockClientPlugin,
    useAPIClient: () => ({ request: async () => ({ data: { data: {} } }) }),
  };

  Module._load = function (req, parent, isMain) {
    if (req === '@nocobase/client') return mockClient;
    if (req === 'react') return ReactStub;
    if (req === 'antd') return AntdStub;
    return origLoad.call(this, req, parent, isMain);
  };

  try {
    const clientIndexPath = path.join(PLUGIN_ROOT, 'src/client/index.js');
    const clientSrc = readFileSync(clientIndexPath, 'utf8');
    assert.match(clientSrc, /@copyright \(C\) 2026 CTU-OpenPaw/);
    assert.match(clientSrc, /SPDX-License-Identifier: Apache-2\.0/);
    const bannedBrandRe = new RegExp('co' + 'pilot', 'i');
    assert.ok(!bannedBrandRe.test(clientSrc), 'Client source must contain zero banned brand strings');

    delete require.cache[require.resolve(clientIndexPath)];
    const clientMod = require(clientIndexPath);
    const DxosParaClient = clientMod.default || clientMod;
    assert.equal(typeof clientMod.createDxosParaSettingsPage, 'function');

    const addedSettings = [];
    const mockApp = {
      pluginSettingsManager: {
        add(key, opts) { addedSettings.push({ key, opts }); },
      },
      apiClient: { request: async () => ({ data: {} }) },
    };

    const inst = new DxosParaClient(mockApp);
    await inst.load();

    const paraSetting = addedSettings.find((s) => s.key === 'dxos-para');
    assert.ok(paraSetting, 'DxosParaClientPlugin must register dxos-para setting (/admin/settings/dxos-para)');
    assert.equal(typeof paraSetting.opts.Component, 'function');
    assert.equal(paraSetting.opts.aclSnippet, 'pm');
    assert.ok(paraSetting.opts.title && paraSetting.opts.title.length > 0);

    const rendered = paraSetting.opts.Component({});
    const nodes = collectNodes(rendered);
    const serialized = JSON.stringify(nodes);
    assert.match(serialized, /dxos-para-settings-page/);
    assert.match(serialized, /P\.A\.R\.A\./);
    assert.match(serialized, /OCR/);
  } finally {
    Module._load = origLoad;
  }
});

test('latticePara:indexHealth action returns org-scoped chunk, vector dimension, and retry health stats', async () => {
  const { createParaActions } = require(path.join(PLUGIN_ROOT, 'src/server/para-resource.js'));

  const employees = [{ id: 10, userId: 100, organizationId: 'org-a', active: true }];
  const docs = [
    { id: 1, organizationId: 'org-a', active: true },
    { id: 2, organizationId: 'org-b', active: true },
  ];
  const chunks = [
    { id: 1, documentId: 1, organizationId: 'org-a', embeddingEngine: 'neural', embeddingDim: 768, active: true },
    { id: 2, documentId: 1, organizationId: 'org-a', embeddingEngine: 'deterministic-fallback', embeddingDim: 256, active: true },
    { id: 3, documentId: 2, organizationId: 'org-b', embeddingEngine: 'neural', embeddingDim: 1536, active: true },
  ];
  const retryLog = [
    { event: 'dxos_para.after_commit_failed', operation: 'syncDocumentChunks', documentId: 1, organizationId: 'org-a', attempt: 1, retryable: true, errorMessage: 'Transient' },
    { event: 'dxos_para.after_commit_failed', operation: 'syncDocumentChunks', documentId: 2, organizationId: 'org-b', attempt: 1, retryable: true, errorMessage: 'Org B error' },
  ];

  const db = {
    sequelize: {
      query: async (sql) => {
        if (/pg_extension/i.test(sql)) return [[{ present: 1 }]];
        return [[]];
      },
    },
    getRepository(name) {
      if (name === 'latticeEmployees') return { find: async ({ filter }) => employees.filter((e) => Number(e.userId) === Number(filter?.userId)) };
      if (name === 'latticeParaDocuments') return { count: async ({ filter }) => docs.filter((d) => !filter?.organizationId || d.organizationId === filter.organizationId).length };
      if (name === 'latticeParaChunks') return { find: async ({ filter }) => chunks.filter((c) => !filter?.organizationId || c.organizationId === filter.organizationId) };
      return null;
    },
  };

  const actions = createParaActions(db, {
    env: { DX_EMBEDDING_DIM: '768', DXOS_EMBEDDING_URL: 'https://embed.internal.test/v1/embeddings', DX_OCR_ENDPOINT: 'http://dxos-ocr:8080/ocr' },
    getIndexingFailures: () => retryLog,
  });

  assert.equal(typeof actions.indexHealth, 'function');
  const ctx = {
    method: 'GET',
    state: { currentUser: { id: 100 }, currentRole: 'ldx_manager' },
    action: { params: {} },
    throw(s, m) { throw Object.assign(new Error(m), { status: s }); },
  };
  await actions.indexHealth(ctx, async () => {});
  assert.equal(ctx.body.organizationId, 'org-a');
  assert.equal(ctx.body.documentsCount, 1);
  assert.equal(ctx.body.chunksCount, 2);
  assert.equal(ctx.body.neuralChunks, 1);
  assert.equal(ctx.body.fallbackChunks, 1);
  assert.equal(ctx.body.targetEmbeddingDim, 768);
  assert.deepEqual(ctx.body.embeddingDims.sort((a, b) => a - b), [256, 768]);
  assert.equal(ctx.body.pgvectorAvailable, true);
  assert.equal(ctx.body.embeddingConfigured, true);
  assert.equal(ctx.body.ocrConfigured, true);
  assert.equal(ctx.body.recentFailures.length, 1);
  assert.equal(ctx.body.recentFailures[0].organizationId, 'org-a');
});

test('M2-4: P.A.R.A. Studio supports Document CRUD, clickable Hybrid Search preview, empty search guard, FileReader/size validation, and OCR-to-Record creation', async () => {
  const origLoad = Module._load;
  const origFileReader = global.FileReader;
  const { React, render } = createMiniHooks();
  const AntdStub = createAntdStub();
  class MockClientPlugin {
    constructor(app) { this.app = app; }
  }
  const calls = [];
  const api = {
    async request(req) {
      calls.push(req);
      if (req.url === 'latticePara:summary') {
        return { data: { data: { organizationId: 'org-a', organizations: ['org-a'], total: 1, spaces: { projects: 1, areas: 0, resources: 0, archives: 0 } } } };
      }
      if (req.url === 'latticePara:indexHealth') {
        return { data: { data: { organizationId: 'org-a', documentsCount: 1, chunksCount: 2, neuralChunks: 1, fallbackChunks: 1 } } };
      }
      if (req.url === 'latticeParaDocuments:list') {
        return {
          data: {
            data: [
              { id: 10, code: 'SOP-CL-01', title: 'Quy trình kho lạnh', paraSpace: 'projects', status: 'active', summary: 'Kiểm soát 2-8C', version: 2 },
            ],
          },
        };
      }
      if (req.url === 'latticeParaDocuments:get') {
        return {
          data: {
            data: { id: 10, code: 'SOP-CL-01', title: 'Quy trình kho lạnh', paraSpace: 'projects', status: 'active', summary: 'Kiểm soát 2-8C', contentMarkdown: '# Nội dung đầy đủ SOP', version: 2 },
          },
        };
      }
      if (req.url === 'latticeParaDocuments:create') {
        return { data: { data: { id: 11, ...req.data, version: 1 } } };
      }
      if (req.url === 'latticeParaDocuments:update') {
        return { data: { data: { id: req.params?.filterByTk, ...req.data, version: 3 } } };
      }
      if (req.url === 'latticeParaDocuments:destroy') {
        return { data: { data: { destroyed: true } } };
      }
      if (req.url === 'latticePara:hybridSearch') {
        return {
          data: {
            data: {
              items: [
                { id: 'c1', documentId: 10, code: 'SOP-CL-01', title: 'Quy trình kho lạnh', paraSpace: 'projects', embeddingEngine: 'neural', score: 0.92, citation: 'SOP-CL-01#1', snippet: 'Nhiệt độ 2..8C' },
              ],
            },
          },
        };
      }
      if (req.url === 'latticePara:extractFormFields') {
        return {
          data: {
            data: {
              organizationId: 'org-a',
              filename: 'mau-don.txt',
              format: 'txt',
              ocrEngine: 'offline',
              targetCollection: 'latticeOrders',
              confidence: 0.91,
              suggestedValues: {
                code: 'ORD-OCR-990',
                customer: 'Bệnh viện Cần Thơ',
                destination: 'Kho lạnh Cần Thơ',
                temperatureRequirement: '2..8 °C',
                quantity: 120,
              },
              lineItems: [{ sku: 'SKU-VAC-01', productName: 'Vaccine', quantity: 120, unit: 'hộp', expiryDate: '2027-12-31' }],
              warnings: [],
            },
          },
        };
      }
      if (req.url === 'latticeOrders:create') {
        return { data: { data: { id: 77, ...req.data } } };
      }
      return { data: { data: {} } };
    },
  };
  const mockClient = { Plugin: MockClientPlugin, useAPIClient: () => api };

  Module._load = function (req, parent, isMain) {
    if (req === '@nocobase/client') return mockClient;
    if (req === 'react') return React;
    if (req === 'antd') return AntdStub;
    return origLoad.call(this, req, parent, isMain);
  };

  try {
    const clientIndexPath = path.join(PLUGIN_ROOT, 'src/client/index.js');
    delete require.cache[require.resolve(clientIndexPath)];
    const { createDxosParaSettingsPage } = require(clientIndexPath);
    const Page = createDxosParaSettingsPage(mockClient, React, AntdStub, { apiClient: api });

    let tree = render(Page, {});
    await new Promise((r) => setTimeout(r, 20));
    tree = render(Page, {});

    // 1. P.A.R.A. Documents browser loaded latticeParaDocuments:list
    assert.ok(calls.some((c) => c.url === 'latticeParaDocuments:list'), 'Studio must load latticeParaDocuments:list');
    assert.ok(findByTestId(tree, 'dxos-para-docs-table'), 'Studio must render P.A.R.A. documents table');

    // Create Document modal -> submit calls latticeParaDocuments:create
    findByTestId(tree, 'dxos-para-create-doc-btn').props.onClick();
    tree = render(Page, {});
    const docModal = findByTestId(tree, 'dxos-para-doc-modal');
    assert.ok(docModal && docModal.props.open === true, 'Create button must open P.A.R.A. document modal');
    findByTestId(tree, 'dxos-para-doc-code-input').props.onChange({ target: { value: 'SOP-NEW-02' } });
    findByTestId(tree, 'dxos-para-doc-title-input').props.onChange({ target: { value: 'SOP Bảo quản mới' } });
    tree = render(Page, {});
    await findByTestId(tree, 'dxos-para-doc-modal').props.onOk();
    tree = render(Page, {});
    assert.ok(calls.some((c) => c.url === 'latticeParaDocuments:create' && c.data?.code === 'SOP-NEW-02'));

    // Edit Document -> sends expectedVersion
    const docsTable = findByTestId(tree, 'dxos-para-docs-table');
    const actionCol = docsTable.props.columns.find((c) => c.key === 'actions' || c.title === 'Thao tác');
    assert.ok(actionCol);
    const rowActionsNode = actionCol.render(null, docsTable.props.dataSource[0]);
    const editBtn = findByTestId(rowActionsNode, 'dxos-para-doc-edit-btn');
    assert.ok(editBtn);
    editBtn.props.onClick();
    tree = render(Page, {});
    findByTestId(tree, 'dxos-para-doc-title-input').props.onChange({ target: { value: 'Quy trình kho lạnh v2' } });
    tree = render(Page, {});
    await findByTestId(tree, 'dxos-para-doc-modal').props.onOk();
    tree = render(Page, {});
    assert.ok(calls.some((c) => c.url === 'latticeParaDocuments:update' && c.params?.filterByTk === 10 && c.data?.expectedVersion === 2));

    // Delete Popconfirm -> calls latticeParaDocuments:destroy
    const delPop = findByTestId(rowActionsNode, 'dxos-para-doc-delete-confirm');
    assert.ok(delPop);
    await delPop.props.onConfirm();
    assert.ok(calls.some((c) => c.url === 'latticeParaDocuments:destroy' && c.params?.filterByTk === 10));

    // 2. Empty search query guard + clickable search results opening preview modal
    findByTestId(tree, 'dxos-para-search-input').props.onChange({ target: { value: '   ' } });
    tree = render(Page, {});
    const searchCallsBefore = calls.filter((c) => c.url === 'latticePara:hybridSearch').length;
    await findByTestId(tree, 'dxos-para-search-btn').props.onClick();
    tree = render(Page, {});
    assert.equal(calls.filter((c) => c.url === 'latticePara:hybridSearch').length, searchCallsBefore, 'Empty search must not call hybridSearch');

    findByTestId(tree, 'dxos-para-search-input').props.onChange({ target: { value: 'kho lạnh' } });
    tree = render(Page, {});
    await findByTestId(tree, 'dxos-para-search-btn').props.onClick();
    tree = render(Page, {});
    const searchTable = findByTestId(tree, 'dxos-para-search-table');
    assert.ok(searchTable && typeof searchTable.props.onRow === 'function', 'Search result rows must be clickable');
    await searchTable.props.onRow(searchTable.props.dataSource[0]).onClick();
    tree = render(Page, {});
    assert.ok(calls.some((c) => c.url === 'latticeParaDocuments:get' && c.params?.filterByTk === 10));
    const previewModal = findByTestId(tree, 'dxos-para-doc-preview-modal');
    assert.ok(previewModal && previewModal.props.open === true, 'Clicking search result must open Document Preview modal');

    // 3. FileReader.onerror + >2 MiB validation
    let readerRejected = false;
    global.FileReader = class MockFileReader {
      readAsDataURL() {
        readerRejected = true;
        if (typeof this.onerror === 'function') this.onerror(new Error('read fail'));
      }
    };
    const fileInput = findByTestId(tree, 'dxos-para-ocr-file-input');
    assert.ok(fileInput);
    fileInput.props.onChange({ target: { files: [{ name: 'big.pdf', type: 'application/pdf', size: 3 * 1024 * 1024 }] } });
    tree = render(Page, {});
    assert.equal(readerRejected, false, 'Oversized >2 MiB file must be rejected before FileReader reads');
    fileInput.props.onChange({ target: { files: [{ name: 'bad.pdf', type: 'application/pdf', size: 1024 }] } });
    tree = render(Page, {});
    assert.equal(readerRejected, true);
    assert.match(JSON.stringify(tree), /Không đọc được/);

    // 4. OCR Auto-Fill & "Tạo bản ghi từ OCR"
    await findByTestId(tree, 'dxos-para-ocr-run-btn').props.onClick();
    tree = render(Page, {});
    const createFromOcrBtn = findByTestId(tree, 'dxos-para-ocr-create-record-btn');
    assert.ok(createFromOcrBtn, 'OCR result panel must expose Tạo bản ghi từ OCR button');
    await createFromOcrBtn.props.onClick();
    tree = render(Page, {});
    const orderCreateCall = calls.find((c) => c.url === 'latticeOrders:create');
    assert.ok(orderCreateCall, 'Tạo bản ghi từ OCR must post to targetCollection:create');
    assert.equal(orderCreateCall.data.code, 'ORD-OCR-990');
    assert.ok(orderCreateCall.data.name, 'Sanitized latticeOrders payload must include required name');
    assert.equal(Object.hasOwn(orderCreateCall.data, 'status'), false, 'latticeOrders payload must omit protected status');
    assert.equal(orderCreateCall.data.temperatureRequirement, undefined, 'Unsupported OCR keys must be sanitized/folded before create');

    // 5. buildOcrRecordPayload edge cases for latticeStockLots and latticeRequests
    const { buildOcrRecordPayload } = require(clientIndexPath);
    const badLot = buildOcrRecordPayload('latticeStockLots', { lotCode: 'L1' }, null, 'org-a');
    assert.equal(badLot.ok, false);
    const goodLot = buildOcrRecordPayload(
      'latticeStockLots',
      { lotCode: 'LOT-9', sku: 'VAC-9', productName: 'Vaccine 9', qtyOnHand: 25, expiryDate: '2027-12-31' },
      null,
      'org-a',
    );
    assert.equal(goodLot.ok, true);
    assert.equal(goodLot.payload.organizationId, 'org-a');
  } finally {
    global.FileReader = origFileReader;
    Module._load = origLoad;
  }
});

test('M2-R2: buildOcrRecordPayload omits protected status and sanitizes latticeServiceTickets enums against server contract', () => {
  const origLoad = Module._load;
  const ReactStub = createReactStub();
  const AntdStub = createAntdStub();
  class MockClientPlugin {
    constructor(app) { this.app = app; }
  }
  const mockClient = { Plugin: MockClientPlugin, useAPIClient: () => ({ request: async () => ({ data: {} }) }) };
  Module._load = function (req, parent, isMain) {
    if (req === '@nocobase/client') return mockClient;
    if (req === 'react') return ReactStub;
    if (req === 'antd') return AntdStub;
    return origLoad.call(this, req, parent, isMain);
  };

  try {
    const clientIndexPath = path.join(PLUGIN_ROOT, 'src/client/index.js');
    delete require.cache[require.resolve(clientIndexPath)];
    const { buildOcrRecordPayload } = require(clientIndexPath);
    const { validateServiceTicket } = require(path.resolve(PLUGIN_ROOT, '../plugin-dxos-studio/src/server/service-schema.js'));

    const orderRes = buildOcrRecordPayload('latticeOrders', { code: 'ORD-1', name: 'Don 1' }, null, 'org-a');
    assert.equal(orderRes.ok, true);
    assert.equal(Object.hasOwn(orderRes.payload, 'status'), false, 'latticeOrders must omit protected status');
    assert.equal(orderRes.payload.status, undefined);

    const reqRes = buildOcrRecordPayload('latticeRequests', { code: 'REQ-1', name: 'Yeu cau 1' }, null, 'org-a');
    assert.equal(reqRes.ok, true);
    assert.equal(Object.hasOwn(reqRes.payload, 'status'), false, 'latticeRequests must omit protected status');
    assert.equal(reqRes.payload.status, undefined);

    const invalidTicket = buildOcrRecordPayload(
      'latticeServiceTickets',
      { code: 'TKT-BAD', name: 'Su co may lanh', serviceType: 'unknown_ocr_type', priority: 'super_critical' },
      null,
      'org-a',
    );
    assert.equal(invalidTicket.ok, true);
    assert.equal(Object.hasOwn(invalidTicket.payload, 'status'), false, 'latticeServiceTickets must omit protected status');
    assert.equal(invalidTicket.payload.status, undefined);
    assert.equal(invalidTicket.payload.serviceType, undefined, 'Invalid OCR serviceType must be omitted');
    assert.equal(invalidTicket.payload.priority, undefined, 'Invalid OCR priority must be omitted');
    assert.doesNotThrow(() => validateServiceTicket({ ...invalidTicket.payload, isNewRecord: true }, {}));

    const mappedNormal = buildOcrRecordPayload(
      'latticeServiceTickets',
      { code: 'TKT-NORM', name: 'Ho tro IT', serviceType: ' IT_SUPPORT ', priority: 'normal' },
      null,
      'org-a',
    );
    assert.equal(mappedNormal.ok, true);
    assert.equal(mappedNormal.payload.serviceType, 'it_support');
    assert.equal(mappedNormal.payload.priority, 'medium');
    assert.doesNotThrow(() => validateServiceTicket({ ...mappedNormal.payload, isNewRecord: true }, {}));

    const mappedUrgent = buildOcrRecordPayload(
      'latticeServiceTickets',
      { code: 'TKT-URG', name: 'Sua cua kho', serviceType: 'facilities', priority: 'URGENT' },
      null,
      'org-a',
    );
    assert.equal(mappedUrgent.ok, true);
    assert.equal(mappedUrgent.payload.serviceType, 'facilities');
    assert.equal(mappedUrgent.payload.priority, 'high');
    assert.doesNotThrow(() => validateServiceTicket({ ...mappedUrgent.payload, isNewRecord: true }, {}));
  } finally {
    Module._load = origLoad;
  }
});

test('DxosParaSettingsPage falls back to organizations[0] when summary.organizationId is null (root user OCR create)', async () => {
  const origLoad = Module._load;
  const { React, render } = createMiniHooks();
  const AntdStub = createAntdStub();
  const calls = [];
  class MockClientPlugin {
    constructor(app) { this.app = app; }
  }
  Module._load = function mockedLoad(req, parent, isMain) {
    if (req === '@nocobase/client') {
      return {
        Plugin: MockClientPlugin,
        useAPIClient: () => ({
          async request(cfg) {
            calls.push(cfg);
            if (cfg.url === 'latticePara:summary') {
              return { data: { data: { organizationId: null, organizations: ['native-ui-lab', 'demo-organization-01'], spaces: {}, total: 4 } } };
            }
            if (cfg.url === 'latticePara:indexHealth') {
              return { data: { data: { organizationId: null, documentsCount: 4, chunksCount: 8, recentFailures: [] } } };
            }
            if (cfg.url === 'latticeParaDocuments:list') {
              return { data: { data: [] } };
            }
            if (cfg.url === 'latticePara:extractFormFields') {
              return { data: { data: { format: 'text', ocrEngine: 'offline', confidence: 0.98, suggestedValues: { code: 'ORD-ROOT-1', customer: 'BV Can Tho' }, lineItems: [] } } };
            }
            if (cfg.url === 'latticeOrders:create') {
              return { data: { data: { id: 88, ...cfg.data } } };
            }
            return { data: { data: {} } };
          },
        }),
      };
    }
    if (req === 'react') return React;
    if (req === 'antd') return AntdStub;
    return origLoad.call(this, req, parent, isMain);
  };

  try {
    const clientIndexPath = path.join(PLUGIN_ROOT, 'src/client/index.js');
    delete require.cache[require.resolve(clientIndexPath)];
    const { default: DxosParaClientPlugin } = require(clientIndexPath);
    const settingsPages = [];
    const plugin = new DxosParaClientPlugin({
      pluginSettingsManager: { add: (_k, opts) => settingsPages.push(opts) },
    });
    await plugin.load();
    const Page = settingsPages[0].Component;

    let tree = render(Page, {});
    await new Promise((r) => setTimeout(r, 10));
    tree = render(Page, {});

    await findByTestId(tree, 'dxos-para-ocr-run-btn').props.onClick();
    tree = render(Page, {});
    await findByTestId(tree, 'dxos-para-ocr-create-record-btn').props.onClick();

    const orderCreateCall = calls.find((c) => c.url === 'latticeOrders:create');
    assert.ok(orderCreateCall, 'latticeOrders:create must be called');
    assert.equal(orderCreateCall.data.organizationId, 'native-ui-lab');
  } finally {
    Module._load = origLoad;
  }
});

test('P1-10: OCR-to-Record renders collection-matched fields, avoids code->lotCode leak, and honors user edits/clears', async () => {
  const origLoad = Module._load;
  const { React, render } = createMiniHooks();
  const AntdStub = createAntdStub();
  const calls = [];
  class MockClientPlugin {
    constructor(app) { this.app = app; }
  }
  const api = {
    async request(cfg) {
      calls.push(cfg);
      if (cfg.url === 'latticePara:summary') {
        return { data: { data: { organizationId: 'org-a', organizations: ['org-a'], spaces: {}, total: 1 } } };
      }
      if (cfg.url === 'latticePara:indexHealth') {
        return { data: { data: { organizationId: 'org-a', documentsCount: 1, chunksCount: 1, recentFailures: [] } } };
      }
      if (cfg.url === 'latticeParaDocuments:list') {
        return { data: { data: [] } };
      }
      if (cfg.url === 'latticePara:extractFormFields') {
        return {
          data: {
            data: {
              organizationId: 'org-a',
              format: 'text',
              ocrEngine: 'offline-deterministic-fallback',
              targetCollection: cfg.data?.targetCollection || 'latticeOrders',
              confidence: 0.9,
              suggestedValues: {
                code: 'ORD-OCR-PW-01',
                customer: 'Bệnh viện Cần Thơ',
                destination: 'Kho lạnh Cần Thơ',
                quantity: 120,
              },
              lineItems: [
                { sku: 'SKU-VAC-01', productName: 'Vaccine Lạnh', quantity: 120, unit: 'hộp', expiryDate: '2027-12-31' },
              ],
              warnings: [],
            },
          },
        };
      }
      if (cfg.url === 'dxosWms:receiveStock') {
        return { data: { data: { lot: { id: 99, ...cfg.data, status: 'available' } } } };
      }
      if (cfg.url === 'latticeServiceTickets:create') {
        return { data: { data: { id: 99, ...cfg.data } } };
      }
      return { data: { data: {} } };
    },
  };
  Module._load = function mockedLoad(req, parent, isMain) {
    if (req === '@nocobase/client') return { Plugin: MockClientPlugin, useAPIClient: () => api };
    if (req === 'react') return React;
    if (req === 'antd') return AntdStub;
    return origLoad.call(this, req, parent, isMain);
  };

  try {
    const clientIndexPath = path.join(PLUGIN_ROOT, 'src/client/index.js');
    delete require.cache[require.resolve(clientIndexPath)];
    const { createDxosParaSettingsPage, buildOcrRecordPayload } = require(clientIndexPath);

    // 1. Unit contract: buildOcrRecordPayload NEVER falls back lotCode to vals.code and honors explicit clears
    const noFallbackLot = buildOcrRecordPayload(
      'latticeStockLots',
      { lotCode: '', code: 'ORD-OCR-PW-01', sku: 'S1', productName: 'P1', qtyOnHand: 10, expiryDate: '2027-12-31' },
      null,
      'org-a',
    );
    assert.equal(noFallbackLot.ok, false);

    const clearedNameLot = buildOcrRecordPayload(
      'latticeStockLots',
      { lotCode: 'LOT-1', sku: 'S1', productName: '', qtyOnHand: 10, expiryDate: '2027-12-31' },
      { lineItems: [{ productName: 'Should Not Overwrite', quantity: 99 }] },
      'org-a',
    );
    assert.equal(clearedNameLot.ok, false);

    // 2. Interactive UI: run OCR on latticeOrders, switch Select -> latticeStockLots, verify fields & edited submit
    const Page = createDxosParaSettingsPage({ useAPIClient: () => api }, React, AntdStub, { apiClient: api });
    let tree = render(Page, {});
    await new Promise((r) => setTimeout(r, 10));
    tree = render(Page, {});

    await findByTestId(tree, 'dxos-para-ocr-run-btn').props.onClick();
    tree = render(Page, {});

    // Switch targetCollection to latticeStockLots
    const targetSelect = findByTestId(tree, 'dxos-para-ocr-target-select');
    assert.ok(targetSelect);
    targetSelect.props.onChange('latticeStockLots');
    tree = render(Page, {});

    const lotCodeInput = findByTestId(tree, 'dxos-para-ocr-field-lotCode');
    const productNameInput = findByTestId(tree, 'dxos-para-ocr-field-productName');
    const qtyOnHandInput = findByTestId(tree, 'dxos-para-ocr-field-qtyOnHand');
    assert.ok(lotCodeInput && productNameInput && qtyOnHandInput, 'latticeStockLots must render lotCode, productName, qtyOnHand inputs');
    assert.equal(findByTestId(tree, 'dxos-para-ocr-field-code'), null, 'latticeStockLots must not render unrelated code input');
    assert.equal(lotCodeInput.props.value, '', 'lotCode must remain empty instead of inheriting ORD-OCR-PW-01');

    // Without lotCode, clicking create must fail validation instead of falling back to ORD-OCR-PW-01
    await findByTestId(tree, 'dxos-para-ocr-create-record-btn').props.onClick();
    tree = render(Page, {});
    assert.equal(calls.some((c) => c.url === 'latticeStockLots:create'), false);
    assert.equal(calls.some((c) => c.url === 'dxosWms:receiveStock'), false);

    // Edit lotCode, productName, and qtyOnHand and submit
    findByTestId(tree, 'dxos-para-ocr-field-lotCode').props.onChange({ target: { value: 'LOT-PW-99' } });
    findByTestId(tree, 'dxos-para-ocr-field-productName').props.onChange({ target: { value: 'Vaccine Edited' } });
    findByTestId(tree, 'dxos-para-ocr-field-qtyOnHand').props.onChange({ target: { value: '45' } });
    tree = render(Page, {});

    await findByTestId(tree, 'dxos-para-ocr-create-record-btn').props.onClick();
    tree = render(Page, {});

    assert.equal(
      calls.some((c) => c.url === 'latticeStockLots:create'),
      false,
      'T3-CF-07 regression: latticeStockLots OCR create must NOT call direct latticeStockLots:create',
    );
    const receiveStockCall = calls.find((c) => c.url === 'dxosWms:receiveStock');
    assert.ok(receiveStockCall, 'T3-CF-07 regression: latticeStockLots OCR create must call dxosWms:receiveStock');
    assert.equal(receiveStockCall.method, 'post');
    assert.equal(receiveStockCall.data.lotCode, 'LOT-PW-99');
    assert.equal(receiveStockCall.data.productName, 'Vaccine Edited');
    assert.equal(receiveStockCall.data.qtyOnHand, 45);
    assert.equal(receiveStockCall.data.organizationId, 'org-a');
    const createdAlert = findByTestId(tree, 'dxos-para-ocr-created-alert');
    assert.ok(createdAlert, 'dxos-para-ocr-created-alert must render after dxosWms:receiveStock succeeds');
    assert.equal(createdAlert.props.type, 'success');
    assert.match(String(createdAlert.props.message || ''), /LOT-PW-99/);
    assert.match(String(createdAlert.props.message || ''), /latticeStockLots/);

    // 3. Switch targetCollection -> latticeServiceTickets, verify description & priority fields + submit
    findByTestId(tree, 'dxos-para-ocr-target-select').props.onChange('latticeServiceTickets');
    tree = render(Page, {});
    assert.ok(findByTestId(tree, 'dxos-para-ocr-field-description'));
    assert.ok(findByTestId(tree, 'dxos-para-ocr-field-priority'));

    findByTestId(tree, 'dxos-para-ocr-field-code').props.onChange({ target: { value: 'TKT-PW-01' } });
    findByTestId(tree, 'dxos-para-ocr-field-name').props.onChange({ target: { value: 'Kiểm tra buồng lạnh' } });
    findByTestId(tree, 'dxos-para-ocr-field-priority').props.onChange({ target: { value: 'high' } });
    findByTestId(tree, 'dxos-para-ocr-field-description').props.onChange({ target: { value: 'Cửa kho bị hở' } });
    tree = render(Page, {});

    await findByTestId(tree, 'dxos-para-ocr-create-record-btn').props.onClick();
    const ticketCreateCall = calls.find((c) => c.url === 'latticeServiceTickets:create');
    assert.ok(ticketCreateCall, 'latticeServiceTickets:create must be called');
    assert.equal(ticketCreateCall.data.code, 'TKT-PW-01');
    assert.equal(ticketCreateCall.data.priority, 'high');
    assert.match(ticketCreateCall.data.description, /Cửa kho bị hở/);
  } finally {
    Module._load = origLoad;
  }
});
