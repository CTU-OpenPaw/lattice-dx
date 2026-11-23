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

function buildZipBuffer(entries, { useDataDescriptor = false } = {}) {
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

function buildPngWithTextChunk(keyword, text, { compressed = false } = {}) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const makeChunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    return Buffer.concat([len, typeBuf, data, crc]);
  };
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(1, 0);
  ihdrData.writeUInt32BE(1, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 2;
  const textPayload = compressed
    ? Buffer.concat([
        Buffer.from(`${keyword}\0`, 'utf8'),
        Buffer.from([1, 0]),
        Buffer.from('vi\0\0', 'utf8'),
        zlib.deflateSync(Buffer.from(text, 'utf8')),
      ])
    : Buffer.concat([
        Buffer.from(`${keyword}\0`, 'utf8'),
        Buffer.from([0, 0]),
        Buffer.from('vi\0\0', 'utf8'),
        Buffer.from(text, 'utf8'),
      ]);
  return Buffer.concat([
    sig,
    makeChunk('IHDR', ihdrData),
    makeChunk('iTXt', textPayload),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

function buildJpegWithComment(commentText) {
  const soi = Buffer.from([0xff, 0xd8]);
  const textBuf = Buffer.from(commentText, 'utf8');
  const lenBuf = Buffer.alloc(2);
  lenBuf.writeUInt16BE(textBuf.length + 2, 0);
  const com = Buffer.concat([Buffer.from([0xff, 0xfe]), lenBuf, textBuf]);
  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([soi, com, eoi]);
}

test('extractXlsxText parses workbook sheets in numeric order, sharedStrings, inlineStr, entities, and optional missing sharedStrings', () => {
  const {
    extractXlsxText,
    extractTextFromBuffer,
    chunkDocumentText,
    listZipEntriesInCentralDirectory,
  } = require(path.join(PLUGIN_ROOT, 'src/server/document-extractor.js'));

  const workbookXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    '<sheets>',
    '<sheet name="Don hang &amp; Lanh" sheetId="1" r:id="rId1"/>',
    '<sheet name="Chi tiet Lo 2" sheetId="2" r:id="rId2"/>',
    '<sheet name="Tong hop 10" sheetId="10" r:id="rId10"/>',
    '</sheets>',
    '</workbook>',
  ].join('');

  const sharedStringsXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="4">',
    '<si><t>Kh&#225;ch h&#224;ng:</t></si>',
    '<si><r><t>Bệnh viện </t></r><r><t>Đa khoa &lt;Cần Thơ&gt;</t></r></si>',
    '<si><t>SKU-VAC-001</t></si>',
    '<si><t>Kho lạnh Bình Thủy</t></si>',
    '</sst>',
  ].join('');

  const sheet1Xml = [
    '<worksheet><sheetData>',
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>',
    '<row r="2"><c r="A2" t="inlineStr"><is><t>Mã đơn:</t></is></c><c r="B2" t="str"><v>ORD-2026-901</v></c></row>',
    '<row r="3"><c r="A3" t="s"><v>2</v></c><c r="B3" t="n"><v>250</v></c><c r="C3" t="inlineStr"><is><t>2027-08-15</t></is></c><c r="D3" t="b"><v>1</v></c></row>',
    '</sheetData></worksheet>',
  ].join('');

  const sheet2Xml = [
    '<worksheet><sheetData>',
    '<row r="1"><c r="A1" t="inlineStr"><is><t>Điểm đến:</t></is></c><c r="B1" t="s"><v>3</v></c></row>',
    '<row r="2"><c r="A2" t="inlineStr"><is><t>Nhiệt độ yêu cầu:</t></is></c><c r="B2" t="inlineStr"><is><t>-20..-15 °C</t></is></c></row>',
    '</sheetData></worksheet>',
  ].join('');

  const sheet10Xml = [
    '<worksheet><sheetData>',
    '<row r="1"><c r="A1" t="inlineStr"><is><t>Xác nhận cuối cùng</t></is></c></row>',
    '</sheetData></worksheet>',
  ].join('');

  // Deliberately store sheet10 before sheet2 in ZIP to assert numeric sort order
  const xlsxBuf = buildZipBuffer([
    { name: 'xl/workbook.xml', data: workbookXml, method: 8 },
    { name: 'xl/sharedStrings.xml', data: sharedStringsXml, method: 8 },
    { name: 'xl/worksheets/sheet10.xml', data: sheet10Xml, method: 8 },
    { name: 'xl/worksheets/sheet2.xml', data: sheet2Xml, method: 8 },
    { name: 'xl/worksheets/sheet1.xml', data: sheet1Xml, method: 8 },
  ], { useDataDescriptor: true });

  const entries = listZipEntriesInCentralDirectory(xlsxBuf);
  assert.equal(entries.length, 5);

  const res = extractXlsxText(xlsxBuf);
  assert.equal(res.format, 'xlsx');
  assert.equal(res.pageCount, 3);
  assert.equal(res.sheets.length, 3);
  assert.match(res.text, /# Sheet: Don hang & Lanh/);
  assert.match(res.text, /Khách hàng:\tBệnh viện Đa khoa <Cần Thơ>/);
  assert.match(res.text, /ORD-2026-901/);
  assert.match(res.text, /SKU-VAC-001\t250\t2027-08-15\tTRUE/);
  assert.ok(
    res.text.indexOf('# Sheet: Chi tiet Lo 2') < res.text.indexOf('# Sheet: Tong hop 10'),
    'Sheets must be sorted numerically (sheet2 before sheet10)',
  );

  const chunks = chunkDocumentText(res.text, { chunkSize: 300, overlap: 40 });
  assert.ok(chunks.some((c) => c.pageNumber === 1 && /Sheet: Don hang & Lanh/.test(c.sectionTitle)));
  assert.ok(chunks.some((c) => c.pageNumber === 2 && /Chi tiet Lo 2/.test(c.sectionTitle)));
  assert.ok(chunks.some((c) => c.pageNumber === 3 && /Tong hop 10/.test(c.sectionTitle)));

  // Dispatches cleanly via ZIP magic without filename/mimeType
  const magicDispatched = extractTextFromBuffer(xlsxBuf);
  assert.equal(magicDispatched.format, 'xlsx');
  assert.equal(magicDispatched.pageCount, 3);

  // Workbook without xl/sharedStrings.xml succeeds cleanly (numeric + inlineStr only)
  const noSharedStringsBuf = buildZipBuffer([
    { name: 'xl/workbook.xml', data: '<workbook><sheets><sheet name="TonKho" sheetId="1"/></sheets></workbook>', method: 0 },
    { name: 'xl/worksheets/sheet1.xml', data: '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>LOT-99</t></is></c><c r="B1"><v>450</v></c></row></sheetData></worksheet>', method: 0 },
  ]);
  const noSharedRes = extractTextFromBuffer(noSharedStringsBuf, {
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  assert.equal(noSharedRes.format, 'xlsx');
  assert.match(noSharedRes.text, /LOT-99\t450/);
});

test('extractPptxText extracts DrawingML slides and notes in numeric order with slide headings and form-feed paging', () => {
  const {
    extractPptxText,
    extractTextFromBuffer,
    chunkDocumentText,
  } = require(path.join(PLUGIN_ROOT, 'src/server/document-extractor.js'));

  const slide1Xml = [
    '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">',
    '<p:cSld><p:spTree><p:sp><p:txBody>',
    '<a:p><a:r><a:t>K&#7871; ho&#7841;ch Giao nh&#7853;n &amp; Kho l&#7841;nh</a:t></a:r></a:p>',
    '<a:p><a:r><a:t>Mã đơn: ORD-PPTX-77</a:t></a:r></a:p>',
    '</p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
  ].join('');

  const slide2Xml = [
    '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">',
    '<p:cSld><p:spTree><p:sp><p:txBody>',
    '<a:p><a:r><a:t>Điểm đi: Kho Trung tâm TP.HCM</a:t></a:r></a:p>',
    '<a:p><a:r><a:t>Điểm đến: Kho Cần Thơ</a:t></a:r></a:p>',
    '</p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
  ].join('');

  const slide10Xml = [
    '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">',
    '<p:cSld><p:spTree><p:sp><p:txBody>',
    '<a:p><a:r><a:t>Slide kết luận &lt;MKT 4.2 C&gt;</a:t></a:r></a:p>',
    '</p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
  ].join('');

  const notes1Xml = [
    '<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">',
    '<p:cSld><p:spTree><p:sp><p:txBody>',
    '<a:p><a:r><a:t>Ghi chú: Nhiệt độ yêu cầu: 2..8 °C</a:t></a:r></a:p>',
    '</p:txBody></p:sp></p:spTree></p:cSld></p:notes>',
  ].join('');

  const pptxBuf = buildZipBuffer([
    { name: 'ppt/presentation.xml', data: '<p:presentation/>', method: 8 },
    { name: 'ppt/slides/slide10.xml', data: slide10Xml, method: 8 },
    { name: 'ppt/slides/slide2.xml', data: slide2Xml, method: 8 },
    { name: 'ppt/slides/slide1.xml', data: slide1Xml, method: 8 },
    { name: 'ppt/notesSlides/notesSlide1.xml', data: notes1Xml, method: 8 },
  ]);

  const res = extractPptxText(pptxBuf);
  assert.equal(res.format, 'pptx');
  assert.equal(res.pageCount, 3);
  assert.match(res.text, /# Slide 1/);
  assert.match(res.text, /Kế hoạch Giao nhận & Kho lạnh/);
  assert.match(res.text, /Nhiệt độ yêu cầu: 2\.\.8 °C/);
  assert.match(res.text, /Slide kết luận <MKT 4\.2 C>/);
  assert.ok(
    res.text.indexOf('# Slide 2') < res.text.indexOf('# Slide 10'),
    'Slides must be sorted numerically (slide2 before slide10)',
  );

  const chunks = chunkDocumentText(res.text, { chunkSize: 300, overlap: 30 });
  assert.ok(chunks.some((c) => c.pageNumber === 1 && c.sectionTitle === 'Slide 1'));
  assert.ok(chunks.some((c) => c.pageNumber === 2 && c.sectionTitle === 'Slide 2'));
  assert.ok(chunks.some((c) => c.pageNumber === 3 && c.sectionTitle === 'Slide 10'));

  const magicDispatched = extractTextFromBuffer(pptxBuf);
  assert.equal(magicDispatched.format, 'pptx');
  assert.equal(magicDispatched.pageCount, 3);
});

test('Office ZIP extractor rejects XXE DOCTYPE/ENTITY, forged/cumulative zip-bombs, and excess entries across xlsx/pptx/docx', () => {
  const {
    extractXlsxText,
    extractPptxText,
    extractDocxText,
  } = require(path.join(PLUGIN_ROOT, 'src/server/document-extractor.js'));

  const xxeDocx = buildZipBuffer([
    { name: 'word/document.xml', data: '<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><w:document><w:p><w:t>&xxe;</w:t></w:p></w:document>' },
  ]);
  assert.throws(
    () => extractDocxText(xxeDocx),
    (err) => err.status === 400 && err.code === 'OFFICE_XML_ENTITY_FORBIDDEN',
  );

  const xxeXlsx = buildZipBuffer([
    { name: 'xl/workbook.xml', data: '<workbook><sheets><sheet name="S1" sheetId="1"/></sheets></workbook>' },
    { name: 'xl/sharedStrings.xml', data: '<!DOCTYPE sst [<!ENTITY leak SYSTEM "http://169.254.169.254/">]><sst><si><t>x</t></si></sst>' },
    { name: 'xl/worksheets/sheet1.xml', data: '<worksheet><sheetData/></worksheet>' },
  ]);
  assert.throws(
    () => extractXlsxText(xxeXlsx),
    (err) => err.status === 400 && err.code === 'OFFICE_XML_ENTITY_FORBIDDEN',
  );

  const xxePptx = buildZipBuffer([
    { name: 'ppt/presentation.xml', data: '<p:presentation/>' },
    { name: 'ppt/slides/slide1.xml', data: '<!ENTITY foo "bar"><p:sld><a:p><a:t>Hello</a:t></a:p></p:sld>' },
  ]);
  assert.throws(
    () => extractPptxText(xxePptx),
    (err) => err.status === 400 && err.code === 'OFFICE_XML_ENTITY_FORBIDDEN',
  );

  // Real deflated zip-bomb in XLSX with spoofed tiny uncompressedSize=64 -> bounded inflate rejects 400
  const bombSheet = Buffer.concat([
    Buffer.from('<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>', 'utf8'),
    Buffer.alloc(10 * 1024 * 1024 + 4096, 0x41),
    Buffer.from('</t></is></c></row></sheetData></worksheet>', 'utf8'),
  ]);
  const realXlsxBomb = buildZipBuffer([
    { name: 'xl/workbook.xml', data: '<workbook/>', method: 8 },
    { name: 'xl/worksheets/sheet1.xml', data: bombSheet, method: 8, fakeUncompressedSize: 64 },
  ]);
  assert.throws(() => extractXlsxText(realXlsxBomb), (err) => err.status === 400);

  // Cumulative multi-entry zip-bomb: 3 slides each 4 MiB = 12 MiB > 10 MiB cumulative limit
  const bigSlideXml = Buffer.concat([
    Buffer.from('<p:sld><a:p><a:t>', 'utf8'),
    Buffer.alloc(4 * 1024 * 1024, 0x42),
    Buffer.from('</a:t></a:p></p:sld>', 'utf8'),
  ]);
  const cumulativeBombPptx = buildZipBuffer([
    { name: 'ppt/presentation.xml', data: '<p:presentation/>', method: 8 },
    { name: 'ppt/slides/slide1.xml', data: bigSlideXml, method: 8 },
    { name: 'ppt/slides/slide2.xml', data: bigSlideXml, method: 8 },
    { name: 'ppt/slides/slide3.xml', data: bigSlideXml, method: 8 },
  ]);
  assert.throws(() => extractPptxText(cumulativeBombPptx), (err) => err.status === 400);

  // Excess entries > MAX_ZIP_ENTRIES (override maxEntries or test > 10000)
  const manyEntries = Array.from({ length: 10002 }, (_, idx) => ({
    name: `ppt/slides/slide${idx + 1}.xml`,
    data: '<p:sld/>',
    method: 0,
  }));
  const manyZip = buildZipBuffer(manyEntries);
  assert.throws(() => extractPptxText(manyZip), (err) => err.status === 400);
});

test('extractStructuredFormFields parses bilingual VN/EN fields, lineItems, cold-chain bounds, sanitizes formula injection/controls, and avoids hallucination', () => {
  const { extractStructuredFormFields } = require(path.join(PLUGIN_ROOT, 'src/server/document-extractor.js'));

  const sampleText = [
    '# Sheet: Đơn đặt hàng Vắc-xin',
    'Mã đơn: ORD-2026-889',
    'Khách hàng: Bệnh viện Đa khoa Trung ương Cần Thơ',
    'Nhà cung cấp: Công ty Dược phẩm Cửu Long',
    'Điểm đi: Kho Lạnh Trung Tâm TP.HCM',
    'Điểm đến: Kho Vắc-xin Cần Thơ',
    'Nhiệt độ yêu cầu: -20..-15 °C (MKT: -17.5 °C)',
    'SKU-VAC-PFZ\tVắc-xin Pfizer\t300 hộp\t2027-09-30\tLOT-PFZ-01',
    'SKU-VAC-MOD\tVắc-xin Moderna\t150 lọ\t15/11/2027\tLOT-MOD-02',
  ].join('\n');

  const res = extractStructuredFormFields(sampleText, { targetCollection: 'latticeOrders' });
  assert.equal(res.targetCollection, 'latticeOrders');
  assert.equal(Object.getPrototypeOf(res.fields), Object.prototype);
  assert.equal(res.fields.code, 'ORD-2026-889');
  assert.equal(res.fields.customer, 'Bệnh viện Đa khoa Trung ương Cần Thơ');
  assert.equal(res.fields.supplier, 'Công ty Dược phẩm Cửu Long');
  assert.equal(res.fields.origin, 'Kho Lạnh Trung Tâm TP.HCM');
  assert.equal(res.fields.destination, 'Kho Vắc-xin Cần Thơ');
  assert.equal(res.fields.targetTempMinC, -20);
  assert.equal(res.fields.targetTempMaxC, -15);
  assert.equal(res.fields.mktCelsius, -17.5);
  assert.equal(res.fields.quantity, 450);
  assert.equal(res.lineItems.length, 2);
  assert.equal(res.lineItems[0].sku, 'SKU-VAC-PFZ');
  assert.equal(res.lineItems[0].quantity, 300);
  assert.equal(res.lineItems[0].expiryDate, '2027-09-30');
  assert.equal(res.lineItems[0].lotCode, 'LOT-PFZ-01');
  assert.equal(res.lineItems[1].sku, 'SKU-VAC-MOD');
  assert.equal(res.lineItems[1].quantity, 150);
  assert.equal(res.lineItems[1].expiryDate, '2027-11-15');
  assert.ok(res.confidence > 0.5 && res.confidence <= 1);

  // Stock lot extraction + cold chain 2..8 C
  const lotRes = extractStructuredFormFields(
    'LOT-COLD-2026-07\nSKU: INSULIN-400\nSL: 800\nHSD: 01/05/2028\nTemp: 2..8 °C',
    { targetCollection: 'latticeStockLots' },
  );
  assert.equal(lotRes.fields.lotCode, 'LOT-COLD-2026-07');
  assert.equal(lotRes.fields.sku, 'INSULIN-400');
  assert.equal(lotRes.fields.qtyOnHand, 800);
  assert.equal(lotRes.fields.expiryDate, '2028-05-01');
  assert.equal(lotRes.fields.targetTempMinC, 2);
  assert.equal(lotRes.fields.targetTempMaxC, 8);

  // Formula injection and control char sanitization
  const dirtyText = [
    'Order Code: REQ-2026-505',
    'Customer: =CMD("calc")\x00\x07',
    'Origin: +1+1 Kho A',
    'Destination: @SUM(A1:A2) Kho B',
  ].join('\n');
  const cleanRes = extractStructuredFormFields(dirtyText, { targetCollection: 'latticeRequests' });
  assert.equal(cleanRes.fields.code, 'REQ-2026-505');
  assert.ok(!/^[=+\-@\x00-\x1f]/.test(cleanRes.fields.customer));
  assert.ok(!/^[=+\-@\x00-\x1f]/.test(cleanRes.fields.origin));
  assert.ok(!/^[=+\-@\x00-\x1f]/.test(cleanRes.fields.destination));
  assert.ok(cleanRes.warnings.includes('FORMULA_PREFIX_SANITIZED'));

  // No hallucination on empty/noise text
  const emptyRes = extractStructuredFormFields('Chỉ là đoạn văn bản thông thường không có trường nghiệp vụ.', {
    targetCollection: 'latticeOrders',
  });
  assert.deepEqual(emptyRes.fields, {});
  assert.deepEqual(emptyRes.lineItems, []);
  assert.equal(emptyRes.confidence, 0);
  assert.ok(emptyRes.warnings.includes('NO_STRUCTURED_FIELDS_FOUND'));
});

test('extractWithMultimodalOcr enforces SSRF guardrails on DX_OCR_ENDPOINT and supports remote OCR + offline PNG/JPEG/PDF fallback', async () => {
  const {
    validateOcrEndpoint,
    extractWithMultimodalOcr,
  } = require(path.join(PLUGIN_ROOT, 'src/server/document-extractor.js'));

  const blockedUrls = [
    'http://169.254.169.254/latest/meta-data',
    'http://[::ffff:169.254.169.254]/latest/meta-data',
    'http://10.0.0.12:8080/ocr',
    'http://172.16.0.8/ocr',
    'http://192.168.1.25/ocr',
    'http://100.100.100.200/latest',
    'http://metadata.google.internal/computeMetadata/v1',
    'https://user:secret@ocr.example.com/v1/extract',
    'file:///etc/passwd',
    'http://untrusted-external.example.com/ocr',
  ];
  let fetchCalled = 0;
  const spyFetch = async () => {
    fetchCalled += 1;
    return { ok: true, json: async () => ({ text: 'should not happen' }) };
  };

  for (const badUrl of blockedUrls) {
    assert.throws(() => validateOcrEndpoint(badUrl, {}), (err) => err.status === 400);
    await assert.rejects(
      () => extractWithMultimodalOcr({
        buffer: buildPngWithTextChunk('caption', 'ORD-1'),
        filename: 'scan.png',
        mimeType: 'image/png',
        env: { DX_OCR_ENDPOINT: badUrl },
        fetchImpl: spyFetch,
      }),
      (err) => err.status === 400,
    );
  }
  assert.equal(fetchCalled, 0, 'SSRF blocked endpoints must never invoke fetch');

  // Trusted HTTPS endpoint works with redirect: 'error' and AbortSignal timeout
  let capturedUrl = null;
  let capturedOpts = null;
  const pngBuf = buildPngWithTextChunk('Description', 'Fallback text');
  const remoteRes = await extractWithMultimodalOcr({
    buffer: pngBuf,
    filename: 'order-scan.png',
    mimeType: 'image/png',
    targetCollection: 'latticeOrders',
    env: { DX_OCR_ENDPOINT: 'https://ocr.internal.example/v1/parse' },
    fetchImpl: async (url, opts) => {
      capturedUrl = url;
      capturedOpts = opts;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          text: 'Mã đơn: ORD-OCR-2026\nKhách hàng: Bệnh viện Chợ Rẫy\nĐiểm đến: Kho Chợ Rẫy\nNhiệt độ yêu cầu: 2..8 °C',
        }),
      };
    },
  });
  assert.equal(capturedUrl, 'https://ocr.internal.example/v1/parse');
  assert.equal(capturedOpts.redirect, 'error');
  assert.ok(capturedOpts.signal && typeof capturedOpts.signal.aborted === 'boolean');
  assert.equal(remoteRes.ocrEngine, 'remote-ocr');
  assert.equal(remoteRes.format, 'png');
  assert.equal(remoteRes.fields.code, 'ORD-OCR-2026');
  assert.equal(remoteRes.fields.customer, 'Bệnh viện Chợ Rẫy');
  assert.equal(remoteRes.fields.targetTempMinC, 2);
  assert.equal(remoteRes.fields.targetTempMaxC, 8);

  // Localhost / Docker-internal HTTP endpoint is allowed and redirect response is rejected
  assert.equal(validateOcrEndpoint('http://localhost:8090/ocr', {}), 'http://localhost:8090/ocr');
  assert.equal(validateOcrEndpoint('http://dxos-ocr:8080/ocr', {}), 'http://dxos-ocr:8080/ocr');
  await assert.rejects(
    () => extractWithMultimodalOcr({
      buffer: pngBuf,
      filename: 'scan.png',
      mimeType: 'image/png',
      env: { DX_OCR_ENDPOINT: 'http://localhost:8090/ocr' },
      fetchImpl: async () => ({ ok: true, redirected: true, status: 200, json: async () => ({ text: 'redirected' }) }),
    }),
    (err) => err.status === 400 && err.code === 'OCR_REDIRECT_FORBIDDEN',
  );

  // Offline deterministic fallback for PNG compressed iTXt and JPEG COM comment
  const offlinePng = buildPngWithTextChunk(
    'ocr_caption',
    'Mã đơn: ORD-PNG-09\nKhách hàng: Viện Pasteur\nSKU-01\t50\t2027-01-15',
    { compressed: true },
  );
  const pngFallback = await extractWithMultimodalOcr({
    buffer: offlinePng,
    filename: 'receipt.png',
    mimeType: 'image/png',
    targetCollection: 'latticeOrders',
    env: {},
  });
  assert.equal(pngFallback.ocrEngine, 'offline-deterministic-fallback');
  assert.equal(pngFallback.fields.code, 'ORD-PNG-09');
  assert.equal(pngFallback.fields.customer, 'Viện Pasteur');
  assert.equal(pngFallback.lineItems[0].sku, 'SKU-01');

  const offlineJpeg = buildJpegWithComment('REQ-JPG-12\nCustomer: BV Nhi Dong 1\nOrigin: Central Hub');
  const jpgFallback = await extractWithMultimodalOcr({
    buffer: offlineJpeg,
    filename: 'photo.jpg',
    mimeType: 'image/jpeg',
    targetCollection: 'latticeRequests',
    env: {},
  });
  assert.equal(jpgFallback.ocrEngine, 'offline-deterministic-fallback');
  assert.equal(jpgFallback.format, 'jpg');
  assert.equal(jpgFallback.fields.code, 'REQ-JPG-12');
  assert.equal(jpgFallback.fields.customer, 'BV Nhi Dong 1');
});

test('latticePara:extractFormFields enforces POST, auth, org isolation, ACL, allowlist, 2MB cap, and never writes DB blindly', async () => {
  const { createParaActions } = require(path.join(PLUGIN_ROOT, 'src/server/para-resource.js'));
  const Module = require('node:module');

  const employees = [
    { id: 10, userId: 100, organizationId: 'org-a', active: true },
    { id: 20, userId: 200, organizationId: 'org-b', active: true },
  ];
  const docs = [
    {
      id: 1,
      code: 'DOC-A-1',
      title: 'Đơn nhập kho lạnh',
      organizationId: 'org-a',
      ownerId: 10,
      contentMarkdown: 'Mã đơn: ORD-DOC-100\nKhách hàng: Bệnh viện Trung Ương\nĐiểm đến: Kho A\nNhiệt độ yêu cầu: 2..8 °C',
      active: true,
    },
    {
      id: 2,
      code: 'DOC-B-1',
      title: 'Tài liệu tổ chức B',
      organizationId: 'org-b',
      ownerId: 20,
      contentMarkdown: 'Mã đơn: ORD-SECRET-B\nKhách hàng: Org B',
      active: true,
    },
  ];

  let dbWrites = 0;
  const db = {
    getRepository(name) {
      if (name === 'latticeEmployees') {
        return { find: async ({ filter }) => employees.filter((e) => Number(e.userId) === Number(filter?.userId)) };
      }
      if (name === 'latticeRoles') return null;
      if (name === 'rolesUsers') {
        return {
          find: async ({ filter }) => {
            if (Number(filter?.userId) === 100) return [{ userId: 100, roleName: 'ldx_employee' }];
            if (Number(filter?.userId) === 200) return [{ userId: 200, roleName: 'ldx_employee' }];
            return [];
          },
        };
      }
      if (name === 'roles') {
        return {
          findOne: async ({ filter }) => ({ name: filter?.name, allowAll: false, strategy: { actions: [] } }),
        };
      }
      if (name === 'dataSourcesRolesResources') {
        return {
          findOne: async ({ filter }) => {
            if (filter?.roleName === 'ldx_employee' && filter?.name === 'latticeParaDocuments') {
              return { name: 'latticeParaDocuments', roleName: 'ldx_employee', usingActionsConfig: true, actions: [{ name: 'view' }] };
            }
            return null;
          },
        };
      }
      if (name === 'latticeParaDocuments') {
        return {
          findOne: async ({ filter }) => docs.find((d) => (
            Number(d.id) === Number(filter?.id)
            && (!filter?.organizationId || d.organizationId === filter.organizationId)
          )) || null,
          create: async () => { dbWrites += 1; },
          update: async () => { dbWrites += 1; },
          destroy: async () => { dbWrites += 1; },
        };
      }
      if (name === 'latticeOrders' || name === 'latticeRequests' || name === 'latticeStockLots' || name === 'latticeServiceTickets') {
        return {
          create: async () => { dbWrites += 1; },
          update: async () => { dbWrites += 1; },
          destroy: async () => { dbWrites += 1; },
        };
      }
      return null;
    },
  };

  const actions = createParaActions(db);
  assert.equal(typeof actions.extractFormFields, 'function');

  const mkCtx = (method, user, role, values, extra = {}) => ({
    method,
    state: { currentUser: user, currentRole: role },
    action: { params: { values } },
    ...extra,
    throw(s, m) { throw Object.assign(new Error(m), { status: s }); },
  });

  // Non-POST -> 405
  await assert.rejects(
    () => actions.extractFormFields(mkCtx('GET', { id: 100 }, 'ldx_employee', { documentId: 1 }), async () => {}),
    (err) => err.status === 405,
  );

  // Unauthenticated -> 401
  await assert.rejects(
    () => actions.extractFormFields(mkCtx('POST', null, 'anonymous', { documentId: 1 }), async () => {}),
    (err) => err.status === 401,
  );

  // Invalid targetCollection -> 400
  await assert.rejects(
    () => actions.extractFormFields(mkCtx('POST', { id: 100 }, 'ldx_employee', { documentId: 1, targetCollection: 'users' }), async () => {}),
    (err) => err.status === 400,
  );

  // ACL denied role -> 403
  await assert.rejects(
    () => actions.extractFormFields(mkCtx('POST', { id: 100 }, 'ldx_guest_denied', { documentId: 1 }, { can: () => false }), async () => {}),
    (err) => err.status === 403,
  );

  // Cross-org documentId -> 404
  await assert.rejects(
    () => actions.extractFormFields(mkCtx('POST', { id: 100 }, 'ldx_employee', { documentId: 2, targetCollection: 'latticeOrders' }), async () => {}),
    (err) => err.status === 404,
  );

  // Oversized base64 > 2MB -> 400
  await assert.rejects(
    () => actions.extractFormFields(mkCtx('POST', { id: 100 }, 'ldx_employee', {
      filename: 'big.xlsx',
      contentBase64: 'A'.repeat(2 * 1024 * 1024 + 128),
      targetCollection: 'latticeOrders',
    }), async () => {}),
    (err) => err.status === 400,
  );

  // Valid XLSX upload returns structured auto-fill draft WITHOUT writing DB
  const xlsxUpload = buildZipBuffer([
    { name: 'xl/workbook.xml', data: '<workbook><sheets><sheet name="Order" sheetId="1"/></sheets></workbook>' },
    { name: 'xl/worksheets/sheet1.xml', data: '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Mã đơn:</t></is></c><c r="B1" t="inlineStr"><is><t>ORD-XLSX-555</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Khách hàng:</t></is></c><c r="B2" t="inlineStr"><is><t>Kho Dược Đồng Nai</t></is></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>SKU-900</t></is></c><c r="B3"><v>75</v></c><c r="C3" t="inlineStr"><is><t>2027-12-01</t></is></c></row></sheetData></worksheet>' },
  ]);
  const xlsxCtx = mkCtx('POST', { id: 100 }, 'ldx_employee', {
    filename: 'don-hang.xlsx',
    contentBase64: xlsxUpload.toString('base64'),
    targetCollection: 'latticeOrders',
  });
  await actions.extractFormFields(xlsxCtx, async () => {});
  assert.equal(xlsxCtx.body.format, 'xlsx');
  assert.equal(xlsxCtx.body.ocrEngine, 'offline-deterministic-fallback');
  assert.equal(xlsxCtx.body.targetCollection, 'latticeOrders');
  assert.equal(xlsxCtx.body.suggestedValues.code, 'ORD-XLSX-555');
  assert.equal(xlsxCtx.body.suggestedValues.customer, 'Kho Dược Đồng Nai');
  assert.equal(xlsxCtx.body.suggestedValues.quantity, 75);
  assert.equal(xlsxCtx.body.lineItems[0].sku, 'SKU-900');
  assert.ok(xlsxCtx.body.extractedTextPreview.includes('ORD-XLSX-555'));
  assert.equal(dbWrites, 0, 'extractFormFields must NEVER write DB blindly');

  // Valid org-scoped documentId fallback extracts structured draft
  const docCtx = mkCtx('POST', { id: 100 }, 'ldx_employee', {
    documentId: 1,
    targetCollection: 'latticeOrders',
  });
  await actions.extractFormFields(docCtx, async () => {});
  assert.equal(docCtx.body.suggestedValues.code, 'ORD-DOC-100');
  assert.equal(docCtx.body.suggestedValues.customer, 'Bệnh viện Trung Ương');
  assert.equal(docCtx.body.suggestedValues.targetTempMinC, 2);
  assert.equal(docCtx.body.suggestedValues.targetTempMaxC, 8);
  assert.equal(dbWrites, 0);

  // DxosParaPlugin ACL registers extractFormFields under loggedIn
  const origLoad = Module._load;
  class MockPlugin {}
  Module._load = function (req, parent, isMain) {
    if (req === '@nocobase/server') return { Plugin: MockPlugin };
    return origLoad.call(this, req, parent, isMain);
  };
  try {
    const indexPath = require.resolve(path.join(PLUGIN_ROOT, 'src/server/index.js'));
    delete require.cache[indexPath];
    const DxosParaPlugin = require(indexPath);
    const allowed = [];
    const plugin = new DxosParaPlugin();
    plugin.db = { on() {}, getRepository: () => null };
    plugin.app = {
      resourceManager: { use() {}, define() {} },
      acl: { allow(res, actionsList, role) { allowed.push({ res, actionsList, role }); } },
    };
    await plugin.load();
    const rule = allowed.find((a) => a.res === 'latticePara' && a.role === 'loggedIn');
    assert.ok(rule);
    assert.ok(rule.actionsList.includes('extractFormFields'));
  } finally {
    Module._load = origLoad;
  }
});

test('extractWithMultimodalOcr handles CSV, PPTX, DOCX, scanned PDF metadata, service tickets, and HTTP 503 OCR fallback', async () => {
  const { extractWithMultimodalOcr } = require(path.join(PLUGIN_ROOT, 'src/server/document-extractor.js'));
  const { createParaActions } = require(path.join(PLUGIN_ROOT, 'src/server/para-resource.js'));

  const csvBuf = Buffer.from([
    'code,customer,origin,destination,sku,quantity,expiryDate',
    'ORD-CSV-2026,Benh vien An Giang,Kho HCM,Kho Long Xuyen,SKU-INS-01,120,2027-10-20',
  ].join('\n'), 'utf8');
  const csvRes = await extractWithMultimodalOcr({
    buffer: csvBuf,
    filename: 'order.csv',
    mimeType: 'text/csv',
    targetCollection: 'latticeOrders',
    env: {},
  });
  assert.equal(csvRes.format, 'csv');
  assert.equal(csvRes.fields.code, 'ORD-CSV-2026');
  assert.equal(csvRes.fields.customer, 'Benh vien An Giang');
  assert.equal(csvRes.fields.origin, 'Kho HCM');
  assert.equal(csvRes.fields.destination, 'Kho Long Xuyen');
  assert.equal(csvRes.fields.quantity, 120);
  assert.equal(csvRes.lineItems[0].sku, 'SKU-INS-01');
  assert.equal(csvRes.lineItems[0].expiryDate, '2027-10-20');

  // Scanned PDF with only Image stream + Info dictionary metadata falls back cleanly, or uses remote OCR when configured
  const scannedPdf = Buffer.from(
    '%PDF-1.4\n1 0 obj << /Title (TKT-2026-88) /Subject (Priority: High) >> endobj\n2 0 obj << /Subtype /Image /Length 4 >>\nstream\nABCD\nendstream\nendobj\n%%EOF\n',
    'latin1',
  );
  const scannedOffline = await extractWithMultimodalOcr({
    buffer: scannedPdf,
    filename: 'ticket-scan.pdf',
    mimeType: 'application/pdf',
    targetCollection: 'latticeServiceTickets',
    env: {},
  });
  assert.equal(scannedOffline.format, 'pdf');
  assert.equal(scannedOffline.ocrEngine, 'offline-deterministic-fallback');
  assert.equal(scannedOffline.fields.code, 'TKT-2026-88');
  assert.equal(scannedOffline.fields.priority, 'high');

  const scannedRemote = await extractWithMultimodalOcr({
    buffer: scannedPdf,
    filename: 'ticket-scan.pdf',
    mimeType: 'application/pdf',
    targetCollection: 'latticeServiceTickets',
    env: { DX_OCR_ENDPOINT: 'https://ocr.trusted.example/parse' },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        text: 'Mã phiếu: TKT-OCR-99\nTiêu đề: Sửa máy nén lạnh\nLoại dịch vụ: Cơ sở vật chất\nĐộ ưu tiên: Cao',
      }),
    }),
  });
  assert.equal(scannedRemote.ocrEngine, 'remote-ocr');
  assert.equal(scannedRemote.fields.code, 'TKT-OCR-99');
  assert.equal(scannedRemote.fields.name, 'Sửa máy nén lạnh');
  assert.equal(scannedRemote.fields.serviceType, 'facilities');
  assert.equal(scannedRemote.fields.priority, 'high');

  // HTTP 503 remote OCR gracefully falls back to offline PNG extraction & targetCollection ACL works via latticeOrders view
  const fallbackDb = {
    getRepository(name) {
      if (name === 'latticeEmployees') {
        return { find: async () => [{ id: 15, userId: 150, organizationId: 'org-a', active: true }] };
      }
      if (name === 'rolesUsers') {
        return { find: async () => [{ userId: 150, roleName: 'ldx_dispatcher' }] };
      }
      if (name === 'roles') {
        return { findOne: async () => ({ name: 'ldx_dispatcher', allowAll: false, strategy: { actions: [] } }) };
      }
      if (name === 'dataSourcesRolesResources') {
        return {
          findOne: async ({ filter }) => (
            filter?.roleName === 'ldx_dispatcher' && filter?.name === 'latticeOrders'
              ? { name: 'latticeOrders', roleName: 'ldx_dispatcher', usingActionsConfig: true, actions: [{ name: 'view' }] }
              : null
          ),
        };
      }
      return null;
    },
  };
  const actions = createParaActions(fallbackDb, {
    env: { DX_OCR_ENDPOINT: 'http://127.0.0.1:8090/ocr' },
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });

  const pngUpload = buildPngWithTextChunk('caption', 'ORD-FB-33\nCustomer: BV Da khoa\nTemp: 2..8 °C');
  const okCtx = {
    method: 'POST',
    state: { currentUser: { id: 150 }, currentRole: 'ldx_dispatcher' },
    action: {
      params: {
        values: {
          filename: 'scan.png',
          mimeType: 'image/png',
          contentBase64: pngUpload.toString('base64'),
          targetCollection: 'latticeOrders',
        },
      },
    },
    throw(s, m) { throw Object.assign(new Error(m), { status: s }); },
  };
  await actions.extractFormFields(okCtx, async () => {});
  assert.equal(okCtx.body.ocrEngine, 'offline-deterministic-fallback');
  assert.ok(okCtx.body.warnings.includes('REMOTE_OCR_UNAVAILABLE_FALLBACK'));
  assert.equal(okCtx.body.suggestedValues.code, 'ORD-FB-33');
  assert.equal(okCtx.body.suggestedValues.customer, 'BV Da khoa');

  // Cross-org organizationId param rejected 403
  await assert.rejects(
    () => actions.extractFormFields({
      method: 'POST',
      state: { currentUser: { id: 150 }, currentRole: 'ldx_dispatcher' },
      action: { params: { values: { organizationId: 'org-b', filename: 'scan.png', contentBase64: pngUpload.toString('base64') } } },
      throw(s, m) { throw Object.assign(new Error(m), { status: s }); },
    }, async () => {}),
    (err) => err.status === 403 && err.code === 'NATIVE_ORGANIZATION_MISMATCH',
  );
});
