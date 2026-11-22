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
          find: async ({ filter }) => docs.filter((d) => (
            (!filter?.organizationId || d.organizationId === filter.organizationId)
            && (!filter?.paraSpace || d.paraSpace === filter.paraSpace)
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
