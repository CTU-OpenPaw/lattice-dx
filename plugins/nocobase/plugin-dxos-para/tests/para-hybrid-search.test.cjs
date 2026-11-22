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

test('hybrid search normalizes Vietnamese diacritics, produces deterministic 256-d vectors, and ranks relevant docs above noise', () => {
  const {
    EMBEDDING_DIM,
    stripVietnameseDiacritics,
    computeDeterministicEmbedding,
    cosineSimilarity,
    rankHybridDocuments,
  } = require(path.join(PLUGIN_ROOT, 'src/server/para-hybrid-search.js'));

  assert.equal(EMBEDDING_DIM, 256);
  assert.equal(stripVietnameseDiacritics('Đề nghị xử lý sự cố mất điện kho lạnh'), 'De nghi xu ly su co mat dien kho lanh');

  const qVec = computeDeterministicEmbedding('mat dien kho lanh vaccine');
  const relVec = computeDeterministicEmbedding('Quy trình xử lý sự cố mất điện kho lạnh bảo quản vaccine');
  const noiseVec = computeDeterministicEmbedding('Biểu mẫu đăng ký nghỉ phép nhân sự văn phòng');

  assert.equal(qVec.length, 256);
  const simRel = cosineSimilarity(qVec, relVec);
  const simNoise = cosineSimilarity(qVec, noiseVec);
  assert.ok(simRel > simNoise, `Expected relevant similarity (${simRel}) > noise (${simNoise})`);

  const ranked = rankHybridDocuments('mat dien kho lanh', [
    { id: 1, code: 'SOP-HR-01', title: 'Biểu mẫu nghỉ phép năm', paraSpace: 'areas', summary: 'Dành cho nhân sự hành chính', contentMarkdown: '' },
    { id: 2, code: 'SOP-COLD-99', title: 'Quy trình xử lý sự cố mất điện kho lạnh', paraSpace: 'resources', summary: 'Kích hoạt máy phát dự phòng trong 5 phút', contentMarkdown: 'Kiểm tra nhiệt độ buồng lạnh âm 18 độ C.' },
    { id: 3, code: 'SOP-TRUCK-02', title: 'Hướng dẫn giao nhận xe tải', paraSpace: 'projects', summary: 'Kiểm tra niêm phong container', contentMarkdown: '' },
  ], { limit: 5 });

  assert.equal(ranked.length >= 1, true);
  assert.equal(ranked[0].code, 'SOP-COLD-99');
  assert.ok(ranked[0].score > 0);
  assert.equal(ranked[0].citation, '[latticeParaDocuments:SOP-COLD-99#2 · resources]');
  assert.ok(ranked[0].snippet.length > 0);
});

test('latticePara:hybridSearch enforces login, org isolation, paraSpace filter, and root preview', async () => {
  const { createParaActions } = require(path.join(PLUGIN_ROOT, 'src/server/para-resource.js'));

  const employees = [
    { id: 10, userId: 100, organizationId: 'org-a', active: true },
    { id: 20, userId: 200, organizationId: 'org-b', active: true },
  ];
  const docs = [
    { id: 1, code: 'SOP-A-1', title: 'Quy trình ứng phó mất điện kho lạnh', organizationId: 'org-a', paraSpace: 'resources', active: true, summary: 'Máy phát điện dự phòng Zone-A' },
    { id: 2, code: 'SOP-B-1', title: 'Quy trình ứng phó mất điện kho lạnh', organizationId: 'org-b', paraSpace: 'resources', active: true, summary: 'Tài liệu mật tổ chức B' },
    { id: 3, code: 'PROJ-A-2', title: 'Dự án mở rộng kho lạnh Cần Thơ', organizationId: 'org-a', paraSpace: 'projects', active: true, summary: 'Giai đoạn 2' },
  ];
  const db = {
    getRepository(name) {
      if (name === 'latticeEmployees') {
        return { find: async ({ filter }) => employees.filter((e) => Number(e.userId) === Number(filter?.userId)) };
      }
      if (name === 'latticeDepartments') return { find: async () => [] };
      if (name === 'latticeParaDocuments') {
        return {
          // Intentionally ignore filter.organizationId to verify JS defense-in-depth guard
          find: async ({ filter }) => docs.filter((d) => (
            (!filter?.paraSpace || d.paraSpace === filter.paraSpace)
            && (filter?.active === undefined || d.active === filter.active)
          )),
        };
      }
      return null;
    },
  };

  const actions = createParaActions(db);
  assert.equal(typeof actions.hybridSearch, 'function');

  await assert.rejects(
    () => actions.hybridSearch({ method: 'GET', state: {}, action: { params: { query: 'kho lanh' } }, throw(s, m) { throw Object.assign(Error(m), { status: s }); } }, async () => {}),
    (err) => err.status === 401 || err.status === 403,
  );

  const empCtx = {
    method: 'GET',
    state: { currentUser: { id: 100 }, currentRole: 'ldx_employee' },
    action: { params: { query: 'mat dien kho lanh' } },
    throw(s, m) { throw Object.assign(Error(m), { status: s }); },
  };
  await actions.hybridSearch(empCtx, async () => {});
  assert.equal(empCtx.body.organizationId, 'org-a');
  assert.equal(empCtx.body.engine, 'hybrid-rrf');
  assert.ok(empCtx.body.items.every((it) => it.organizationId === 'org-a'));
  assert.equal(empCtx.body.items[0].code, 'SOP-A-1');
  assert.equal(empCtx.body.items[0].citation, '[latticeParaDocuments:SOP-A-1#1 · resources]');

  const spaceCtx = {
    method: 'POST',
    state: { currentUser: { id: 1 }, currentRole: 'root' },
    action: { params: { values: { query: 'kho lanh', paraSpace: 'projects', organizationId: 'org-a' } } },
    throw(s, m) { throw Object.assign(Error(m), { status: s }); },
  };
  await actions.hybridSearch(spaceCtx, async () => {});
  assert.equal(spaceCtx.body.items.length, 1);
  assert.equal(spaceCtx.body.items[0].code, 'PROJ-A-2');
});

test('migration 20261122000500 adds tsvector + guarded pgvector columns with down() reversal', () => {
  const migPath = path.join(PLUGIN_ROOT, 'src/server/migrations/20261122000500-para-hybrid-search-indexes.js');
  const src = readFileSync(migPath, 'utf8');
  assert.match(src, /\bup\s*\(/);
  assert.match(src, /\bdown\s*\(/);
  assert.match(src, /pg_available_extensions\s+WHERE\s+name\s*=\s*'vector'/i);
  assert.match(src, /idx_lattice_para_search_tsv/);
});

test('computeNeuralEmbedding validates endpoint URLs, uses AbortSignal timeout + redirect error, and honestly reports engine', async () => {
  const {
    computeNeuralEmbedding,
  } = require(path.join(PLUGIN_ROOT, 'src/server/para-hybrid-search.js'));

  let fetchCalled = 0;
  const spyFetch = async () => {
    fetchCalled += 1;
    return { ok: true, json: async () => ({ data: [{ embedding: new Array(1536).fill(0.05) }] }) };
  };

  // Rejects credentials, non-http/https, and cloud metadata SSRF hosts WITHOUT calling fetch
  const dangerousUrls = [
    'https://user:secret@embed.example.com/v1/embeddings',
    'file:///etc/passwd',
    'ftp://embed.example.com/v1',
    'http://169.254.169.254/latest/meta-data',
    'http://[::ffff:169.254.169.254]/latest/meta-data',
    'http://[fe89::1]/metadata',
    'http://[::ffff:100.64.0.1]/metadata',
    'http://100.100.100.200/latest/meta-data',
    'http://metadata.google.internal/computeMetadata/v1',
  ];
  for (const badUrl of dangerousUrls) {
    const res = await computeNeuralEmbedding('kho lanh vaccine', {
      env: { DXOS_EMBEDDING_URL: badUrl },
      fetchImpl: spyFetch,
    });
    assert.equal(fetchCalled, 0, `fetch must not be called for blocked URL: ${badUrl}`);
    assert.equal(res.engine, 'deterministic-fallback');
    assert.equal(res.dim, 256);
    assert.equal(res.model, 'fnv1a-256');
  }

  // Valid endpoint succeeds and reports engine: 'neural' + passes redirect:'error' and AbortSignal
  let capturedUrl = null;
  let capturedOpts = null;
  const okRes = await computeNeuralEmbedding('quy trinh mat dien kho lanh', {
    env: { DXOS_EMBEDDING_URL: 'https://llm.internal.example/v1/embeddings', DXOS_EMBEDDING_MODEL: 'text-embedding-3-small' },
    fetchImpl: async (url, opts) => {
      capturedUrl = url;
      capturedOpts = opts;
      return {
        ok: true,
        json: async () => ({ model: 'text-embedding-3-small', data: [{ embedding: new Array(1536).fill(0.025) }] }),
      };
    },
  });
  assert.equal(capturedUrl, 'https://llm.internal.example/v1/embeddings');
  assert.equal(capturedOpts.redirect, 'error');
  assert.ok(capturedOpts.signal && typeof capturedOpts.signal.aborted === 'boolean');
  assert.equal(okRes.engine, 'neural');
  assert.equal(okRes.dim, 1536);
  assert.equal(okRes.vector.length, 1536);

  // Timeout / HTTP 500 falls back honestly to 'deterministic-fallback'
  const failRes = await computeNeuralEmbedding('quy trinh kho lanh', {
    env: { AGENT_BASE_URL: 'http://127.0.0.1:20128/v1' },
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });
  assert.equal(failRes.engine, 'deterministic-fallback');
  assert.equal(failRes.dim, 256);
});

test('executeHybridSearch queries latticeParaChunks first with org-scoped SQL/pgvector, merges unchunked docs, and formats chunk citations', async () => {
  const {
    executeHybridSearch,
    computeDeterministicEmbedding,
  } = require(path.join(PLUGIN_ROOT, 'src/server/para-hybrid-search.js'));

  const chunks = [
    {
      id: 501,
      documentId: 10,
      organizationId: 'org-a',
      code: 'SOP-COLD-10',
      title: 'Sổ tay Kho lạnh Trung tâm',
      paraSpace: 'resources',
      chunkIndex: 0,
      sectionTitle: 'Giới thiệu',
      pageNumber: 1,
      content: 'Phạm vi áp dụng cho toàn bộ nhân viên vận hành kho.',
      embeddingModel: 'fnv1a-256',
      embeddingEngine: 'deterministic-fallback',
      embeddingDim: 256,
      embeddingJson: computeDeterministicEmbedding('Phạm vi áp dụng cho toàn bộ nhân viên vận hành kho'),
      active: true,
    },
    {
      id: 502,
      documentId: 10,
      organizationId: 'org-a',
      code: 'SOP-COLD-10',
      title: 'Sổ tay Kho lạnh Trung tâm',
      paraSpace: 'resources',
      chunkIndex: 2,
      sectionTitle: 'Quy trình Máy phát dự phòng',
      pageNumber: 4,
      content: 'Khi mất điện buồng lạnh âm 18 độ, kích hoạt máy phát dự phòng và kiểm tra van NH3.',
      embeddingModel: 'fnv1a-256',
      embeddingEngine: 'deterministic-fallback',
      embeddingDim: 256,
      embeddingJson: computeDeterministicEmbedding('Khi mất điện buồng lạnh âm 18 độ kích hoạt máy phát dự phòng và kiểm tra van NH3'),
      active: true,
    },
    {
      id: 503,
      documentId: 99,
      organizationId: 'org-b',
      code: 'SOP-B-99',
      title: 'Tài liệu mật Org B',
      paraSpace: 'resources',
      chunkIndex: 0,
      sectionTitle: 'Mật',
      pageNumber: 1,
      content: 'mất điện buồng lạnh máy phát dự phòng van NH3',
      embeddingModel: 'fnv1a-256',
      embeddingEngine: 'deterministic-fallback',
      embeddingDim: 256,
      embeddingJson: computeDeterministicEmbedding('mất điện buồng lạnh máy phát dự phòng van NH3'),
      active: true,
    },
  ];

  const docs = [
    { id: 10, code: 'SOP-COLD-10', title: 'Sổ tay Kho lạnh Trung tâm', organizationId: 'org-a', paraSpace: 'resources', summary: 'Vận hành kho lạnh', active: true },
    { id: 11, code: 'SOP-UN-11', title: 'Phiếu bàn giao ca trực kho lạnh', organizationId: 'org-a', paraSpace: 'resources', summary: 'Kiểm tra máy phát dự phòng đầu ca', active: true },
    { id: 12, code: 'SOP-LEAK-12', title: 'Mất điện máy phát dự phòng van NH3 Org B', organizationId: 'org-b', paraSpace: 'resources', summary: 'Cross-org doc leak test', active: true },
  ];

  const sqlCalls = [];
  const db = {
    sequelize: {
      query: async (sql, opts) => {
        sqlCalls.push({ sql, replacements: opts?.replacements });
        if (sql.includes('<=>')) {
          throw new Error('column "embedding" does not exist');
        }
        return [[{ ...chunks[1], pgTsRank: 0.92 }]];
      },
    },
    getRepository(name) {
      if (name === 'latticeParaChunks') {
        return {
          find: async ({ filter }) => chunks.filter((c) => (
            (!filter?.organizationId || c.organizationId === filter.organizationId)
            && (!filter?.paraSpace || c.paraSpace === filter.paraSpace)
            && (filter?.active === undefined || c.active === filter.active)
          )),
        };
      }
      if (name === 'latticeParaDocuments') {
        return {
          // Intentionally ignore filter.organizationId to verify JS defense-in-depth guard
          find: async ({ filter }) => docs.filter((d) => (
            (!filter?.paraSpace || d.paraSpace === filter.paraSpace)
            && (filter?.active === undefined || d.active === filter.active)
          )),
        };
      }
      return null;
    },
  };

  const results = await executeHybridSearch(db, {
    organizationId: 'org-a',
    query: 'mất điện máy phát dự phòng van NH3',
    limit: 5,
    env: {},
  });

  assert.ok(results.length >= 2, 'Should return chunk-matched doc and unchunked doc');
  assert.ok(results.every((r) => r.organizationId === 'org-a'), 'Must never leak org-b chunks');
  assert.ok(sqlCalls.some((c) => c.replacements?.org === 'org-a' && c.replacements?.qRaw && c.replacements?.qNorm), 'SQL query must parameterize organizationId, qRaw, and qNorm');
  assert.equal(results[0].id, 10);
  assert.equal(results[0].sectionTitle, 'Quy trình Máy phát dự phòng');
  assert.equal(results[0].pageNumber, 4);
  assert.equal(results[0].chunkIndex, 2);
  assert.equal(results[0].embeddingEngine, 'deterministic-fallback');
  assert.equal(results[0].citation, '[latticeParaDocuments:SOP-COLD-10#10 · đoạn #3]');

  const unchunked = results.find((r) => r.id === 11);
  assert.ok(unchunked, 'Unchunked doc should be merged into results');
  assert.equal(unchunked.citation, '[latticeParaDocuments:SOP-UN-11#11 · resources]');

  // Neural + pgvector <=> path when endpoint returns 1536-dim vector and pgvector query succeeds
  const pgSqlCalls = [];
  const pgDb = {
    sequelize: {
      query: async (sql, opts) => {
        pgSqlCalls.push({ sql, replacements: opts?.replacements });
        if (sql.includes('<=>')) {
          return [[{
            id: 601,
            documentId: 20,
            organizationId: 'org-a',
            code: 'SOP-VEC-20',
            title: 'Quy trình Vaccine Neural',
            paraSpace: 'resources',
            chunkIndex: 1,
            sectionTitle: 'Bảo quản 2-8C',
            pageNumber: 3,
            content: 'Theo dõi cảm biến nhiệt độ liên tục.',
            embeddingModel: 'text-embedding-3-small',
            embeddingEngine: 'neural',
            embeddingDim: 1536,
            pgVectorSim: 0.94,
          }]];
        }
        return [[]];
      },
    },
    getRepository(name) {
      if (name === 'latticeParaChunks') return { find: async () => [] };
      if (name === 'latticeParaDocuments') return { find: async () => [] };
      return null;
    },
  };
  const neuralResults = await executeHybridSearch(pgDb, {
    organizationId: 'org-a',
    query: 'cảm biến nhiệt độ vaccine',
    limit: 5,
    env: { DXOS_EMBEDDING_URL: 'https://embed.internal.test/v1/embeddings' },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ model: 'text-embedding-3-small', data: [{ embedding: new Array(1536).fill(0.025) }] }),
    }),
  });
  assert.ok(pgSqlCalls.some((c) => c.sql.includes('<=>') && c.replacements?.org === 'org-a'));
  assert.equal(neuralResults.length, 1);
  assert.equal(neuralResults[0].embeddingEngine, 'neural');
  assert.equal(neuralResults[0].citation, '[latticeParaDocuments:SOP-VEC-20#20 · đoạn #2]');
});

test('paraChunks collection and migration 20261123000300 safely support both pgvector and plain Postgres', async () => {
  const Module = require('node:module');
  const origLoad = Module._load;
  class MockMigration {
    constructor(context) { this.context = context; }
  }
  Module._load = function (req, parent, isMain) {
    if (req === '@nocobase/server') return { Migration: MockMigration };
    if (req === '@nocobase/database') return { defineCollection: (def) => def };
    return origLoad.call(this, req, parent, isMain);
  };

  try {
    const paraChunksCollection = require(path.join(PLUGIN_ROOT, 'src/server/collections/para-chunks.js'));
    assert.equal(paraChunksCollection.name, 'latticeParaChunks');
    const chunkFieldNames = paraChunksCollection.fields.map((f) => f.name);
    for (const reqField of ['documentId', 'organizationId', 'code', 'title', 'paraSpace', 'chunkIndex', 'sectionTitle', 'pageNumber', 'content', 'tokenCount', 'embeddingModel', 'embeddingDim', 'embeddingJson', 'active']) {
      assert.ok(chunkFieldNames.includes(reqField), `Missing paraChunks field ${reqField}`);
    }

    const MigrationClass = require(path.join(PLUGIN_ROOT, 'src/server/migrations/20261123000300-para-chunks-and-semantic-vector.js'));
    const migPath = path.join(PLUGIN_ROOT, 'src/server/migrations/20261123000300-para-chunks-and-semantic-vector.js');
    const src = readFileSync(migPath, 'utf8');
    assert.match(src, /pg_extension\s+WHERE\s+extname\s*=\s*'vector'/i);
    assert.match(src, /idx_lattice_para_chunks_org_doc/);
    assert.match(src, /vector\(1536\)/i);
    assert.match(src, /translate\(/i, 'Migration trigger must normalize Vietnamese diacritics in searchVector');
    assert.match(src, /sourceType/i, 'Migration must include sourceType column');
    assert.match(src, /to_regclass\('"latticeParaChunks"'\)/i, 'Migration down() must guard DROP TRIGGER with to_regclass check');

    const queries = [];
    const mig = new MigrationClass({
      db: {
        sequelize: {
          transaction: async (fn) => fn({}),
          query: async (sql) => {
            queries.push(sql);
            return [[]];
          },
        },
      },
    });
    await mig.up();
    assert.ok(queries.some((q) => q.includes('"latticeParaChunks"')));
    assert.ok(queries.some((q) => q.includes('idx_lattice_para_chunks_org_doc')));
    assert.ok(queries.some((q) => q.includes('gin ("searchVector")')));

    queries.length = 0;
    await mig.down();
    assert.ok(queries.some((q) => q.includes('DROP TABLE IF EXISTS "latticeParaChunks"')));
  } finally {
    Module._load = origLoad;
  }
});
