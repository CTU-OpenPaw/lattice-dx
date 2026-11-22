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
const zlib = require('node:zlib');

const PLUGIN_ROOT = path.resolve(__dirname, '..');

function buildZipBuffer(entries, { useDataDescriptor = false, omitCentralDirectory = false } = {}) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const rawBuf = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8');
    const method = entry.method ?? 8;
    const compressed = method === 8 ? zlib.deflateRawSync(rawBuf) : rawBuf;
    const flags = useDataDescriptor ? 0x08 : 0x00;
    const reportedCompSize = useDataDescriptor ? 0 : compressed.length;
    const reportedUncompSize = useDataDescriptor ? 0 : (entry.fakeUncompressedSize ?? rawBuf.length);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(flags, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt32LE(0, 14);
    localHeader.writeUInt32LE(reportedCompSize, 18);
    localHeader.writeUInt32LE(reportedUncompSize, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    const descriptor = useDataDescriptor ? Buffer.alloc(16) : Buffer.alloc(0);
    if (useDataDescriptor) {
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(0, 4);
      descriptor.writeUInt32LE(compressed.length, 8);
      descriptor.writeUInt32LE(entry.fakeUncompressedSize ?? rawBuf.length, 12);
    }

    localParts.push(localHeader, nameBuf, compressed, descriptor);

    const cdHeader = Buffer.alloc(46);
    cdHeader.writeUInt32LE(0x02014b50, 0);
    cdHeader.writeUInt16LE(20, 4);
    cdHeader.writeUInt16LE(20, 6);
    cdHeader.writeUInt16LE(flags, 8);
    cdHeader.writeUInt16LE(method, 10);
    cdHeader.writeUInt32LE(0, 16);
    cdHeader.writeUInt32LE(compressed.length, 20);
    cdHeader.writeUInt32LE(entry.fakeUncompressedSize ?? rawBuf.length, 24);
    cdHeader.writeUInt16LE(nameBuf.length, 28);
    cdHeader.writeUInt16LE(0, 30);
    cdHeader.writeUInt16LE(0, 32);
    cdHeader.writeUInt32LE(offset, 42);
    centralParts.push(cdHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + compressed.length + descriptor.length;
  }

  if (omitCentralDirectory) {
    return Buffer.concat(localParts);
  }

  const cdBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, cdBuf, eocd]);
}

function toUtf16BeHex(str) {
  const utf16le = Buffer.from(str, 'utf16le');
  utf16le.swap16();
  return `<FEFF${utf16le.toString('hex').toUpperCase()}>`;
}

function buildMinimalPdf(pages) {
  const parts = ['%PDF-1.4\n'];
  const objects = [];
  const pageObjNums = [];
  let nextObj = 3;

  for (const pageContent of pages) {
    const pageObj = nextObj++;
    const streamObj = nextObj++;
    pageObjNums.push(pageObj);
    const compressed = zlib.deflateSync(Buffer.from(pageContent, 'latin1'));
    objects.push({
      id: pageObj,
      body: `<< /Type /Page /Parent 2 0 R /Contents ${streamObj} 0 R >>`,
    });
    objects.push({
      id: streamObj,
      raw: Buffer.concat([
        Buffer.from(`<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
        compressed,
        Buffer.from('\nendstream', 'latin1'),
      ]),
    });
  }

  const allObjects = [
    { id: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { id: 2, body: `<< /Type /Pages /Count ${pages.length} /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(' ')}] >>` },
    ...objects,
  ];

  const buffers = [Buffer.from(parts[0], 'latin1')];
  for (const obj of allObjects) {
    buffers.push(Buffer.from(`${obj.id} 0 obj\n`, 'latin1'));
    buffers.push(obj.raw ? obj.raw : Buffer.from(obj.body, 'latin1'));
    buffers.push(Buffer.from('\nendobj\n', 'latin1'));
  }
  buffers.push(Buffer.from('%%EOF\n', 'latin1'));
  return Buffer.concat(buffers);
}

test('extractDocxText parses standard local headers, bit-3 data descriptor via central directory, XML entities, and rejects zip-bombs', () => {
  const {
    extractDocxText,
    extractTextFromBuffer,
  } = require(path.join(PLUGIN_ROOT, 'src/server/document-extractor.js'));

  const xml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    '<w:body>',
    '<w:p><w:r><w:t>Quy tr&#236;nh V&#7853;n h&#224;nh &amp; An to&#224;n &lt;Kho l&#7841;nh&gt;</w:t></w:r></w:p>',
    '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Nhiệt độ chuẩn</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>-18 C</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
    '</w:body></w:document>',
  ].join('');

  // Standard local header without central directory (method 8)
  const localOnlyDocx = buildZipBuffer(
    [{ name: 'word/document.xml', data: xml, method: 8 }],
    { omitCentralDirectory: true },
  );
  const localRes = extractDocxText(localOnlyDocx);
  assert.match(localRes, /Quy trình Vận hành & An toàn <Kho lạnh>/);
  assert.match(localRes, /Nhiệt độ chuẩn/);
  assert.match(localRes, /-18 C/);

  // Bit-3 deferred size (compressedSize=0 in local headers!) with preceding entry -> needs Central Directory fallback
  const bit3Docx = buildZipBuffer([
    { name: '[Content_Types].xml', data: '<Types></Types>', method: 8 },
    { name: 'word/document.xml', data: xml, method: 8 },
  ], { useDataDescriptor: true });
  const dispatched = extractTextFromBuffer(bit3Docx, { filename: 'sop-kho-lanh.docx' });
  assert.equal(dispatched.format, 'docx');
  assert.ok(dispatched.pageCount >= 1);
  assert.match(dispatched.text, /Quy trình Vận hành & An toàn <Kho lạnh>/);

  // Stored method 0 DOCX
  const storedDocx = buildZipBuffer([{ name: 'word/document.xml', data: xml, method: 0 }]);
  assert.match(extractDocxText(storedDocx), /Nhiệt độ chuẩn/);

  // Zip-bomb: forged uncompressed size > 10MB
  const forgedZipBomb = buildZipBuffer([
    { name: 'word/document.xml', data: '<w:document><w:p><w:t>ok</w:t></w:p></w:document>', method: 8, fakeUncompressedSize: 12 * 1024 * 1024 },
  ]);
  assert.throws(() => extractDocxText(forgedZipBomb), (err) => err.status === 400);

  // Zip-bomb: real compressed zeros > 10MB despite small fakeUncompressedSize
  const realBombPayload = Buffer.alloc(10 * 1024 * 1024 + 4096, 0x41);
  const realZipBomb = buildZipBuffer([
    { name: 'word/document.xml', data: realBombPayload, method: 8, fakeUncompressedSize: 100 },
  ]);
  assert.throws(() => extractDocxText(realZipBomb), (err) => err.status === 400);

  // Corrupt archive returns 400
  assert.throws(() => extractDocxText(Buffer.from('not-a-zip-file')), (err) => err.status === 400);
});

test('extractPdfText decodes Tj, TJ arrays, UTF-16BE hex strings, pageCount, zip-bombs, and corrupt streams safely', () => {
  const {
    extractPdfText,
    extractTextFromBuffer,
  } = require(path.join(PLUGIN_ROOT, 'src/server/document-extractor.js'));

  const page1 = [
    'BT',
    '/F1 12 Tf',
    '72 720 Td',
    '(SOP \\(Cold Chain\\) Zone-A) Tj',
    '0 -16 Td',
    '[(Kiem tra ) -150 (may phat dien)] TJ',
    'ET',
  ].join('\n');
  const page2 = [
    'BT',
    '/F1 12 Tf',
    '1 0 0 1 72 720 Tm',
    `${toUtf16BeHex('Cảnh báo nhiệt độ vượt ngưỡng')} Tj`,
    '1 0 0 1 72 700 Tm',
    `[${toUtf16BeHex('Báo cáo')} -160 ${toUtf16BeHex('khẩn cấp')}] TJ`,
    'ET',
  ].join('\n');

  const pdfBuf = buildMinimalPdf([page1, page2]);
  const extracted = extractTextFromBuffer(pdfBuf, { filename: 'manual.pdf' });
  assert.equal(extracted.format, 'pdf');
  assert.equal(extracted.pageCount, 2);
  assert.match(extracted.text, /SOP \(Cold Chain\) Zone-A/);
  assert.match(extracted.text, /Kiem tra\s+may phat dien/);
  assert.match(extracted.text, /Cảnh báo nhiệt độ vượt ngưỡng/);
  assert.match(extracted.text, /Báo cáo\s+khẩn cấp/);

  // Oversized FlateDecode stream (> 10MB) rejected cleanly with 400
  const hugeStream = zlib.deflateSync(Buffer.alloc(10 * 1024 * 1024 + 4096, 0x20));
  const bombPdf = Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n2 0 obj << /Filter /FlateDecode >>\nstream\n', 'latin1'),
    hugeStream,
    Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1'),
  ]);
  assert.throws(() => extractPdfText(bombPdf), (err) => err.status === 400);

  // Corrupt stream mixed with valid stream -> safe partial extraction without crash
  const validStream = zlib.deflateSync(Buffer.from('BT (Partial Safe Text) Tj ET', 'latin1'));
  const mixedPdf = Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj << /Filter /FlateDecode >>\nstream\n', 'latin1'),
    Buffer.from('CORRUPT_ZLIB_BYTES_XYZ', 'latin1'),
    Buffer.from('\nendstream\nendobj\n2 0 obj << /Filter /FlateDecode >>\nstream\n', 'latin1'),
    validStream,
    Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1'),
  ]);
  const partial = extractPdfText(mixedPdf);
  assert.match(partial.text, /Partial Safe Text/);

  // Regression: /Type /Pages /Count 999999999 must be bounded cleanly without OOM
  const bombPageCountStream = zlib.deflateSync(Buffer.from('BT (Bounded Page Text) Tj ET', 'latin1'));
  const hugeCountPdf = Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj << /Type /Pages /Count 999999999 /Kids [2 0 R] >> endobj\n', 'latin1'),
    Buffer.from('2 0 obj << /Type /Page /Parent 1 0 R /Contents 3 0 R >> endobj\n', 'latin1'),
    Buffer.from(`3 0 obj << /Length ${bombPageCountStream.length} /Filter /FlateDecode /DecodeParms << /Predictor 12 >> >>\nstream\n`, 'latin1'),
    bombPageCountStream,
    Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1'),
  ]);
  const t0 = Date.now();
  const boundedRes = extractPdfText(hugeCountPdf);
  const dtBounded = Date.now() - t0;
  assert.ok(dtBounded < 100, `Expected bounded extraction < 100ms, got ${dtBounded}ms`);
  assert.ok(boundedRes.pageCount <= 5000, `Expected pageCount <= 5000, got ${boundedRes.pageCount}`);
  assert.match(boundedRes.text, /Bounded Page Text/);

  // Regression: nested << /DecodeParms << ... >> >> still extracts even when stream has multiple pages
  const nestedStream = zlib.deflateSync(Buffer.from('BT (Nested Dict Ok) Tj ET', 'latin1'));
  const nestedPdf = Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page /Contents 2 0 R >> endobj\n', 'latin1'),
    Buffer.from(`2 0 obj << /Length ${nestedStream.length} /Filter /FlateDecode /DecodeParms << /Columns 4 >> >>\nstream\n`, 'latin1'),
    nestedStream,
    Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1'),
  ]);
  assert.match(extractPdfText(nestedPdf).text, /Nested Dict Ok/);

  // Regression: 200,000 repeated '1 0 obj ' tokens must complete in linear time (< 100ms) with zero ReDoS
  const redosBuf = Buffer.from(`%PDF-1.4\n${'1 0 obj '.repeat(200000)}\n%%EOF\n`, 'latin1');
  const tRedos0 = Date.now();
  const redosRes = extractPdfText(redosBuf);
  const dtRedos = Date.now() - tRedos0;
  assert.ok(dtRedos < 100, `Expected linear ReDoS defense < 100ms, took ${dtRedos}ms`);
  assert.equal(redosRes.text, '');
});

test('extractTextFromBuffer dispatches markdown/txt/json and chunkDocumentText tracks headings, pages, overlap, and tokens', () => {
  const {
    extractTextFromBuffer,
    chunkDocumentText,
  } = require(path.join(PLUGIN_ROOT, 'src/server/document-extractor.js'));

  const md = extractTextFromBuffer(Buffer.from('# Mở đầu\nNội dung markdown', 'utf8'), { filename: 'guide.md' });
  assert.equal(md.format, 'markdown');
  assert.equal(md.pageCount, 1);
  assert.match(md.text, /Nội dung markdown/);

  const multiPageText = [
    '# Tổng quan\nĐoạn một giới thiệu quy trình bảo quản vaccine ở nhiệt độ âm sâu và kiểm tra cảm biến tự động.',
    '## Quy trình xử lý sự cố\nKhi mất điện lưới cần khởi động máy phát dự phòng trong vòng năm phút và ghi nhận nhật ký nhiệt độ.',
    '\f## Danh mục kiểm tra\nKiểm tra niêm phong cửa kho lạnh, mức nhiên liệu máy phát, và báo cáo quản lý ca trực ngay lập tức.',
  ].join('\n\n');

  const chunks = chunkDocumentText(multiPageText, { chunkSize: 110, overlap: 25, title: 'Tài liệu gốc' });
  assert.ok(chunks.length >= 3, `Expected >= 3 chunks, got ${chunks.length}`);
  assert.equal(chunks[0].chunkIndex, 0);
  assert.equal(chunks[0].sectionTitle, 'Tổng quan');
  assert.equal(chunks[0].pageNumber, 1);
  assert.ok(chunks[0].tokenCount > 0);
  assert.ok(chunks.some((c) => c.sectionTitle === 'Quy trình xử lý sự cố' && c.pageNumber === 1));
  assert.ok(chunks.some((c) => c.sectionTitle === 'Danh mục kiểm tra' && c.pageNumber === 2));
  assert.ok(chunks.every((c, idx) => c.chunkIndex === idx && c.content.length <= 140 && !c.content.includes('\f')));
});

test('latticePara:extractAttachment and reindex enforce strict auth, org isolation, permissions, size bounds, and chunk indexing', async () => {
  const { createParaActions } = require(path.join(PLUGIN_ROOT, 'src/server/para-resource.js'));

  const employees = [
    { id: 10, userId: 100, organizationId: 'org-a', active: true },
    { id: 11, userId: 101, organizationId: 'org-a', active: true },
    { id: 20, userId: 200, organizationId: 'org-b', active: true },
  ];
  const docs = [
    { id: 1, code: 'SOP-A-1', title: 'SOP Kho lạnh', organizationId: 'org-a', ownerId: 10, paraSpace: 'resources', contentMarkdown: '# Mục 1\nNội dung ban đầu.', active: true },
    { id: 2, code: 'SOP-B-1', title: 'SOP Tổ chức B', organizationId: 'org-b', ownerId: 20, paraSpace: 'resources', contentMarkdown: 'Bí mật B', active: true },
  ];
  let chunks = [];
  let nextChunkId = 1;

  const db = {
    sequelize: { transaction: async (fn) => fn({}) },
    getRepository(name) {
      if (name === 'latticeEmployees') {
        return { find: async ({ filter }) => employees.filter((e) => Number(e.userId) === Number(filter?.userId)) };
      }
      if (name === 'latticeDepartments') return { find: async () => [] };
      if (name === 'latticeParaDocuments') {
        return {
          findOne: async ({ filter }) => docs.find((d) => (
            Number(d.id) === Number(filter?.id)
            && (!filter?.organizationId || d.organizationId === filter.organizationId)
          )) || null,
          find: async ({ filter }) => docs.filter((d) => (
            (!filter?.organizationId || d.organizationId === filter.organizationId)
            && (filter?.active === undefined || d.active === filter.active)
          )),
        };
      }
      if (name === 'latticeParaChunks') {
        return {
          destroy: async ({ filter }) => {
            chunks = chunks.filter((c) => !(
              (filter?.documentId == null || Number(c.documentId) === Number(filter.documentId))
              && (!filter?.organizationId || c.organizationId === filter.organizationId)
            ));
          },
          create: async ({ values }) => {
            const row = { id: nextChunkId++, ...values };
            chunks.push(row);
            return row;
          },
          find: async ({ filter }) => chunks.filter((c) => (
            (!filter?.organizationId || c.organizationId === filter.organizationId)
            && (filter?.active === undefined || c.active === filter.active)
          )),
        };
      }
      return null;
    },
  };

  const actions = createParaActions(db);
  assert.equal(typeof actions.extractAttachment, 'function');
  assert.equal(typeof actions.reindex, 'function');

  const mkCtx = (user, role, values) => ({
    method: 'POST',
    state: { currentUser: user, currentRole: role },
    action: { params: { values } },
    throw(s, m) { throw Object.assign(new Error(m), { status: s }); },
  });

  const sampleDocx = buildZipBuffer([
    {
      name: 'word/document.xml',
      data: '<w:document><w:body><w:p><w:r><w:t>Hướng dẫn xử lý sự cố van điều áp NH3 trong kho lạnh</w:t></w:r></w:p></w:body></w:document>',
      method: 8,
    },
  ]);
  const sampleB64 = sampleDocx.toString('base64');

  // Unauthenticated -> 401
  await assert.rejects(
    () => actions.extractAttachment(mkCtx(null, 'anonymous', { documentId: 1, filename: 'sop.docx', contentBase64: sampleB64 }), async () => {}),
    (err) => err.status === 401,
  );

  // Cross-org documentId -> 404
  await assert.rejects(
    () => actions.extractAttachment(mkCtx({ id: 100 }, 'ldx_employee', { documentId: 2, filename: 'sop.docx', contentBase64: sampleB64 }), async () => {}),
    (err) => err.status === 404,
  );

  // Non-owner employee in same org -> 403
  await assert.rejects(
    () => actions.extractAttachment(mkCtx({ id: 101 }, 'ldx_employee', { documentId: 1, filename: 'sop.docx', contentBase64: sampleB64 }), async () => {}),
    (err) => err.status === 403,
  );

  // Read-only director -> 403
  await assert.rejects(
    () => actions.extractAttachment(mkCtx({ id: 101 }, 'ldx_director', { documentId: 1, filename: 'sop.docx', contentBase64: sampleB64 }), async () => {}),
    (err) => err.status === 403,
  );

  // Oversized > 2MB base64 -> 400
  const hugeB64 = 'A'.repeat(2 * 1024 * 1024 + 64);
  await assert.rejects(
    () => actions.extractAttachment(mkCtx({ id: 100 }, 'ldx_employee', { documentId: 1, filename: 'sop.docx', contentBase64: hugeB64 }), async () => {}),
    (err) => err.status === 400,
  );

  // Valid owner extracts DOCX and indexes chunks
  const okCtx = mkCtx({ id: 100 }, 'ldx_employee', { documentId: 1, filename: 'sop.docx', contentBase64: sampleB64 });
  await actions.extractAttachment(okCtx, async () => {});
  assert.equal(okCtx.body.organizationId, 'org-a');
  assert.equal(okCtx.body.format, 'docx');
  assert.ok(okCtx.body.chunksIndexed >= 1);
  assert.ok(chunks.some((c) => c.organizationId === 'org-a' && c.documentId === 1 && /van điều áp NH3/.test(c.content)));

  // Reindex: employee forbidden (403)
  await assert.rejects(
    () => actions.reindex(mkCtx({ id: 100 }, 'ldx_employee', {}), async () => {}),
    (err) => err.status === 403,
  );

  // Reindex: manager cross-org rejected (403)
  await assert.rejects(
    () => actions.reindex(mkCtx({ id: 101 }, 'ldx_manager', { organizationId: 'org-b' }), async () => {}),
    (err) => err.status === 403,
  );

  // Reindex: manager reindexes org-a cleanly without touching org-b AND preserves extracted attachment chunks
  const reindexCtx = mkCtx({ id: 101 }, 'ldx_manager', {});
  await actions.reindex(reindexCtx, async () => {});
  assert.equal(reindexCtx.body.organizationId, 'org-a');
  assert.equal(reindexCtx.body.documentsProcessed, 1);
  assert.ok(reindexCtx.body.chunksIndexed >= 2);
  assert.ok(chunks.every((c) => c.organizationId === 'org-a'));
  assert.ok(chunks.some((c) => c.sourceType === 'attachment' && /van điều áp NH3/.test(c.content)), 'Reindex must preserve previously extracted attachment chunks');
  assert.ok(chunks.some((c) => c.sourceType === 'document' && /Nội dung ban đầu/.test(c.content)), 'Reindex must also index document chunks');
});

test('para-scope blocks non-root charts:queryData and CRUD on latticeParaChunks while scoping latticeParaDocuments', async () => {
  const { createParaScopeMiddleware } = require(path.join(PLUGIN_ROOT, 'src/server/para-scope.js'));
  const employees = [{ id: 11, userId: 101, organizationId: 'org-a', departmentId: 3, active: true }];
  const db = {
    getRepository(name) {
      if (name === 'latticeEmployees') return { find: async () => employees };
      return null;
    },
  };
  const mw = createParaScopeMiddleware(db);

  // Non-root charts:queryData on latticeParaChunks must be denied (403)
  await assert.rejects(
    () => mw({
      state: { currentRole: 'ldx_employee', currentUser: { id: 101 } },
      action: { resourceName: 'charts', actionName: 'queryData', params: { values: { mode: 'builder', collection: 'latticeParaChunks', filter: {} } } },
    }, async () => {}),
    (err) => err.status === 403 && err.code === 'PARA_CHUNKS_READ_ONLY',
  );

  // Non-root direct CRUD (even list/get) on latticeParaChunks must be denied (403)
  for (const act of ['list', 'get', 'create', 'update', 'destroy']) {
    await assert.rejects(
      () => mw({
        state: { currentRole: 'ldx_manager', currentUser: { id: 101 } },
        action: { resourceName: 'latticeParaChunks', actionName: act, params: {} },
      }, async () => {}),
      (err) => err.status === 403 && err.code === 'PARA_CHUNKS_READ_ONLY',
    );
  }

  // Non-root charts:queryData on latticeParaDocuments remains scoped to caller org
  const docChartCtx = {
    state: { currentRole: 'ldx_employee', currentUser: { id: 101 } },
    action: { resourceName: 'charts', actionName: 'queryData', params: { values: { mode: 'builder', collection: 'latticeParaDocuments', filter: { paraSpace: 'resources' } } } },
  };
  await mw(docChartCtx, async () => {});
  assert.deepEqual(docChartCtx.action.params.values.filter, { $and: [{ organizationId: 'org-a' }, { paraSpace: 'resources' }] });
});

test('DxosParaPlugin wires afterCreate/afterUpdate/afterDestroy with transaction.afterCommit and ACL allowances', async () => {
  const Module = require('node:module');
  const origLoad = Module._load;
  class MockPlugin {}
  Module._load = function (req, parent, isMain) {
    if (req === '@nocobase/server') return { Plugin: MockPlugin };
    return origLoad.call(this, req, parent, isMain);
  };
  try {
    const DxosParaPlugin = require(path.join(PLUGIN_ROOT, 'src/server/index.js'));
    const events = [];
    const allowed = [];
    const destroyedFilters = [];
    const createdChunks = [];
    const plugin = new DxosParaPlugin();
    plugin.db = {
      on(eventName, handler) { events.push({ eventName, handler }); },
      getRepository(name) {
        if (name === 'latticeParaChunks') {
          return {
            destroy: async ({ filter }) => { destroyedFilters.push(filter); },
            create: async ({ values }) => { createdChunks.push(values); return { id: 1, ...values }; },
          };
        }
        return null;
      },
    };
    plugin.app = {
      resourceManager: {
        use() {},
        define() {},
      },
      acl: {
        allow(res, actionsList, role) { allowed.push({ res, actionsList, role }); },
      },
    };
    await plugin.load();
    const afterCreate = events.find((e) => e.eventName === 'latticeParaDocuments.afterCreate');
    const afterUpdate = events.find((e) => e.eventName === 'latticeParaDocuments.afterUpdate');
    const afterDestroy = events.find((e) => e.eventName === 'latticeParaDocuments.afterDestroy');
    assert.ok(afterCreate);
    assert.ok(afterUpdate);
    assert.ok(afterDestroy);

    const allowRule = allowed.find((a) => a.res === 'latticePara' && a.role === 'loggedIn');
    assert.ok(allowRule);
    assert.ok(allowRule.actionsList.includes('extractAttachment'));
    assert.ok(allowRule.actionsList.includes('reindex'));

    // skipParaChunkSync suppresses sync
    await afterUpdate.handler({ id: 5, organizationId: 'org-a', contentMarkdown: 'Skip' }, { context: { skipParaChunkSync: true } });
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(createdChunks.length, 0);

    // Rolled-back transaction defers via afterCommit and never executes destroy/create
    const afterCommitCbs = [];
    await afterCreate.handler(
      { id: 7, organizationId: 'org-a', code: 'D-7', title: 'Rollback doc', contentMarkdown: 'Should not sync until commit' },
      { transaction: { afterCommit: (fn) => afterCommitCbs.push(fn) } },
    );
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(createdChunks.length, 0, 'Must not sync chunks before transaction commits');
    assert.equal(afterCommitCbs.length, 1);

    // Committed transaction triggers chunk sync
    await afterCommitCbs[0]();
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(createdChunks.some((c) => c.documentId === 7 && c.organizationId === 'org-a'));

    // afterDestroy deletes orphan chunks via afterCommit
    const destroyCommitCbs = [];
    await afterDestroy.handler(
      { id: 7, organizationId: 'org-a' },
      { transaction: { afterCommit: (fn) => destroyCommitCbs.push(fn) } },
    );
    assert.equal(destroyCommitCbs.length, 1);
    await destroyCommitCbs[0]();
    await new Promise((r) => setTimeout(r, 15));
    assert.ok(destroyedFilters.some((f) => f.documentId === 7 && f.organizationId === 'org-a'));
  } finally {
    Module._load = origLoad;
  }
});
