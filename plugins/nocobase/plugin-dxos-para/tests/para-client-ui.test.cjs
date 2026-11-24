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
    Table: comp('Table'),
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
  out.push(node);
  const children = node.props?.children;
  if (Array.isArray(children)) {
    for (const c of children) collectNodes(c, out);
  } else if (children && typeof children === 'object') {
    collectNodes(children, out);
  }
  return out;
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
