/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { createHash } = require('node:crypto');

const EXPORTABLE_COLLECTIONS = new Set([
  'latticeRequests',
  'latticeOrders',
  'latticeAssets',
  'latticeIncidentCases',
  'latticeServiceTickets',
  'latticeParaDocuments',
  'latticeDepartments',
  'latticeLocations',
]);
const CUSTOM_COLLECTION_RE = /^latticeCustom[A-Z][A-Za-z0-9]{1,40}$/;

const SENSITIVE_EXPORT_FIELDS = new Set([
  'password',
  'passwordHash',
  'secret',
  'token',
  'apiKey',
  'identitySubject',
  'privateKey',
  'hash',
  'salt',
  'embeddingJson',
  'searchVector',
  'searchText',
]);
const SENSITIVE_KEY_RE = /password|secret|token|apikey|api_key|identitySubject|privateKey|hash|salt|embedding/i;
const FORMULA_PREFIX_RE = /^(?:[=+\-@\t\r]|\s+[=+\-@])/;
const EXPORT_FORMATS = new Set(['csv', 'xlsx', 'pdf']);

const DEFAULT_FALLBACK_COLUMNS = ['id', 'code', 'name', 'status', 'organizationId', 'createdAt'];

const val = (row, key) => (typeof row?.get === 'function' ? row.get(key) : row?.[key]);

function failExport(code, status = 400, message = code) {
  return Object.assign(new Error(message), { code, status });
}

function isExportableCollection(name) {
  const s = String(name || '').trim();
  return EXPORTABLE_COLLECTIONS.has(s) || CUSTOM_COLLECTION_RE.test(s);
}

function sanitizeFormulaCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? value : '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const str = value instanceof Date
    ? value.toISOString()
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value);
  return FORMULA_PREFIX_RE.test(str) ? `'${str}` : str;
}

function assertSafeFilter(node, depth = 0) {
  if (node == null) return null;
  if (depth > 15) throw failExport('EXPORT_FILTER_FORBIDDEN', 403, 'Bộ lọc vượt quá độ sâu cho phép.');
  let target = node;
  if (typeof target === 'string') {
    const trimmed = target.trim();
    if (!trimmed) return null;
    try { target = JSON.parse(trimmed); } catch { throw failExport('EXPORT_FILTER_FORBIDDEN', 403, 'Bộ lọc không hợp lệ.'); }
  }
  if (Array.isArray(target)) {
    return target.map((item) => assertSafeFilter(item, depth + 1));
  }
  if (typeof target !== 'object') return target;
  for (const [k, entry] of Object.entries(target)) {
    if (k === '$where' || k === '$raw' || k === '$sql') {
      throw failExport('EXPORT_FILTER_FORBIDDEN', 403, 'Toán tử lọc không an toàn bị từ chối.');
    }
    if (!k.startsWith('$') && (k.includes('.') || SENSITIVE_KEY_RE.test(k))) {
      throw failExport('EXPORT_FILTER_FORBIDDEN', 403, 'Bộ lọc chứa trường bị hạn chế.');
    }
    assertSafeFilter(entry, depth + 1);
  }
  return target;
}

function isSensitiveField(name) {
  const clean = String(name || '').trim();
  if (!clean || clean.includes('.') || clean.startsWith('$')) return true;
  return SENSITIVE_EXPORT_FIELDS.has(clean) || SENSITIVE_KEY_RE.test(clean);
}

async function resolveAllowedExportColumns(
  db,
  ctx,
  { collection, requestedFields = null, isRoot = false, fallbackFields = DEFAULT_FALLBACK_COLUMNS } = {},
) {
  const requested = Array.isArray(requestedFields)
    ? requestedFields.map((f) => String(f || '').trim()).filter(Boolean)
    : typeof requestedFields === 'string' && requestedFields.trim()
      ? requestedFields.split(',').map((f) => f.trim()).filter(Boolean)
      : [];

  let roleAllowedSet = null;
  if (!isRoot) {
    const roleName = ctx?.state?.currentRole;
    if (roleName && db?.getRepository) {
      const role = await db.getRepository('roles')?.findOne({ filter: { name: roleName } });
      if (val(role, 'allowAll') !== true) {
        const res = await db.getRepository('dataSourcesRolesResources')?.findOne({
          filter: { roleName, name: collection, dataSourceKey: 'main' },
        });
        if (res && val(res, 'usingActionsConfig') !== false) {
          const actions = val(res, 'actions') || [];
          const viewAct = actions.find((a) => (a?.name || a) === 'view') || actions.find((a) => (a?.name || a) === 'list');
          const rawFields = Array.isArray(viewAct?.fields) ? viewAct.fields : [];
          if (rawFields.length) {
            roleAllowedSet = new Set(rawFields.map((f) => String(f?.name || f)).filter((n) => !isSensitiveField(n)));
          }
        }
      }
    }
  }

  const omittedSet = new Set();
  const columns = [];
  const candidates = requested.length
    ? requested
    : roleAllowedSet
      ? [...roleAllowedSet]
      : (Array.isArray(fallbackFields) && fallbackFields.length ? fallbackFields : DEFAULT_FALLBACK_COLUMNS);

  for (const col of candidates) {
    if (isSensitiveField(col)) {
      omittedSet.add(col);
      continue;
    }
    if (roleAllowedSet && !roleAllowedSet.has(col)) {
      omittedSet.add(col);
      continue;
    }
    if (!columns.includes(col)) columns.push(col);
  }

  if (requested.length && !columns.length) {
    throw failExport('EXPORT_FIELDS_FORBIDDEN', 403, 'Không có cột nào được phép xuất theo phân quyền hiện tại.');
  }
  return { columns, omittedColumns: [...omittedSet] };
}

function csvCell(v) {
  const safe = sanitizeFormulaCell(v);
  const str = String(safe);
  return `"${str.replace(/"/g, '""')}"`;
}

function buildCsvBuffer(columns, rows) {
  const lines = [columns.map(csvCell).join(',')];
  for (const row of rows) {
    lines.push(columns.map((col) => csvCell(val(row, col))).join(','));
  }
  return Buffer.from(`\uFEFF${lines.join('\r\n')}`, 'utf8');
}

const CRC_TABLE = (() => {
  const tbl = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    tbl[i] = c >>> 0;
  }
  return tbl;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function xmlEscape(str) {
  return String(str)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function colLetter(indexZero) {
  let n = indexZero;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

function createStoreZip(files) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;
  for (const { name, content } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const dataBuf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const sum = crc32(dataBuf);
    const localHdr = Buffer.alloc(30);
    localHdr.writeUInt32LE(0x04034b50, 0);
    localHdr.writeUInt16LE(20, 4);
    localHdr.writeUInt16LE(0x0800, 6);
    localHdr.writeUInt16LE(0, 8);
    localHdr.writeUInt16LE(0, 10);
    localHdr.writeUInt16LE(0, 12);
    localHdr.writeUInt32LE(sum, 14);
    localHdr.writeUInt32LE(dataBuf.length, 18);
    localHdr.writeUInt32LE(dataBuf.length, 22);
    localHdr.writeUInt16LE(nameBuf.length, 26);
    localHdr.writeUInt16LE(0, 28);
    localChunks.push(localHdr, nameBuf, dataBuf);

    const centralHdr = Buffer.alloc(46);
    centralHdr.writeUInt32LE(0x02014b50, 0);
    centralHdr.writeUInt16LE(20, 4);
    centralHdr.writeUInt16LE(20, 6);
    centralHdr.writeUInt16LE(0x0800, 8);
    centralHdr.writeUInt16LE(0, 10);
    centralHdr.writeUInt16LE(0, 12);
    centralHdr.writeUInt16LE(0, 14);
    centralHdr.writeUInt32LE(sum, 16);
    centralHdr.writeUInt32LE(dataBuf.length, 20);
    centralHdr.writeUInt32LE(dataBuf.length, 24);
    centralHdr.writeUInt16LE(nameBuf.length, 28);
    centralHdr.writeUInt16LE(0, 30);
    centralHdr.writeUInt16LE(0, 32);
    centralHdr.writeUInt16LE(0, 34);
    centralHdr.writeUInt16LE(0, 36);
    centralHdr.writeUInt32LE(0, 38);
    centralHdr.writeUInt32LE(offset, 42);
    centralChunks.push(centralHdr, nameBuf);

    offset += localHdr.length + nameBuf.length + dataBuf.length;
  }
  const centralBuf = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localChunks, centralBuf, eocd]);
}

function buildXlsxBuffer(columns, rows, { sheetName = 'LatticeDX' } = {}) {
  const safeSheet = String(sheetName || 'LatticeDX').replace(/[\\/?*[\]:]/g, '').slice(0, 31) || 'LatticeDX';
  const rowXml = [];
  const hdrCells = columns
    .map((c, idx) => `<c r="${colLetter(idx)}1" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(c)}</t></is></c>`)
    .join('');
  rowXml.push(`<row r="1">${hdrCells}</row>`);

  rows.forEach((row, rIdx) => {
    const rNum = rIdx + 2;
    const cells = columns.map((col, cIdx) => {
      const ref = `${colLetter(cIdx)}${rNum}`;
      const safe = sanitizeFormulaCell(val(row, col));
      if (typeof safe === 'number' && Number.isFinite(safe)) {
        return `<c r="${ref}" t="n"><v>${safe}</v></c>`;
      }
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(safe)}</t></is></c>`;
    }).join('');
    rowXml.push(`<row r="${rNum}">${cells}</row>`);
  });

  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowXml.join('')}</sheetData></worksheet>`;
  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEscape(safeSheet)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;

  return createStoreZip([
    { name: '[Content_Types].xml', content: contentTypes },
    { name: '_rels/.rels', content: rootRels },
    { name: 'xl/workbook.xml', content: workbookXml },
    { name: 'xl/_rels/workbook.xml.rels', content: wbRels },
    { name: 'xl/worksheets/sheet1.xml', content: sheetXml },
  ]);
}

function pdfAscii(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, (m) => (m === 'đ' ? 'd' : 'D'))
    .replace(/[^\x20-\x7e]/g, ' ');
}

function pdfEscape(text) {
  return pdfAscii(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function buildPdfBuffer(columns, rows, { title = 'LatticeDX Report', organizationId = '', exportedBy = '', exportedAt = '' } = {}) {
  const allLines = [
    `${title}`,
    `Org: ${organizationId || 'all'} | By: ${exportedBy || 'system'} | At: ${exportedAt || new Date().toISOString()}`,
    `Columns: ${columns.join(' | ')}`,
    '-'.repeat(84),
  ];
  for (const row of rows) {
    const rowText = columns.map((c) => `${c}=${String(sanitizeFormulaCell(val(row, c))).slice(0, 48)}`).join(' | ');
    allLines.push(rowText.slice(0, 110));
  }
  const perPage = 42;
  const pageChunks = [];
  for (let i = 0; i < allLines.length; i += perPage) {
    pageChunks.push(allLines.slice(i, i + perPage));
  }
  if (!pageChunks.length) pageChunks.push(['(No records)']);

  // PDF Objects: 1 Catalog, 2 Pages, 3 Font, then paired Page + Content per page
  const objects = [];
  const pageIds = [];
  const fontObjId = 3;
  let nextId = 4;
  for (const lines of pageChunks) {
    const pageId = nextId++;
    const contentId = nextId++;
    pageIds.push(pageId);
    const ops = ['BT', '/F1 9 Tf', '40 760 Td', '15 TL'];
    for (const line of lines) {
      ops.push(`(${pdfEscape(line)}) Tj T*`);
    }
    ops.push('ET');
    const streamStr = ops.join('\n');
    objects.push({
      id: pageId,
      body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObjId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    });
    objects.push({
      id: contentId,
      body: `<< /Length ${Buffer.byteLength(streamStr, 'latin1')} >>\nstream\n${streamStr}\nendstream`,
    });
  }
  const headerObjects = [
    { id: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { id: 2, body: `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>` },
    { id: 3, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' },
    ...objects,
  ].sort((a, b) => a.id - b.id);

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const obj of headerObjects) {
    offsets[obj.id] = Buffer.byteLength(pdf, 'latin1');
    pdf += `${obj.id} 0 obj\n${obj.body}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${headerObjects.length + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= headerObjects.length; id += 1) {
    pdf += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${headerObjects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

async function executeGovernedExport(db, ctx, params, { isRoot = false, actor = null } = {}) {
  const collection = String(params.collection || '').trim();
  if (!isExportableCollection(collection)) {
    throw failExport('EXPORT_COLLECTION_INVALID', 400, 'Collection không được hỗ trợ xuất báo cáo.');
  }
  const format = String(params.format || 'csv').trim().toLowerCase();
  if (!EXPORT_FORMATS.has(format)) {
    throw failExport('EXPORT_FORMAT_INVALID', 400, 'Định dạng xuất phải là csv, xlsx hoặc pdf.');
  }

  const requestedOrg = params.organizationId ? String(params.organizationId).trim() : '';
  if (!isRoot && requestedOrg && requestedOrg !== actor.organizationId) {
    throw failExport('NATIVE_ORGANIZATION_MISMATCH', 403, 'Không thể xuất dữ liệu tổ chức khác.');
  }
  const effectiveOrg = isRoot ? (requestedOrg || null) : actor.organizationId;

  const safeFilter = assertSafeFilter(params.filter);
  const filter = effectiveOrg
    ? (safeFilter ? { $and: [{ organizationId: effectiveOrg }, safeFilter] } : { organizationId: effectiveOrg })
    : (safeFilter || {});

  const limit = Math.max(1, Math.min(2000, Number(params.limit) || 500));
  const { columns, omittedColumns } = await resolveAllowedExportColumns(db, ctx, {
    collection,
    requestedFields: params.fields,
    isRoot,
  });

  const repo = db?.getRepository?.(collection);
  if (!repo) throw failExport('EXPORT_COLLECTION_UNAVAILABLE', 503);
  const rows = (await repo.find({ filter, limit, sort: ['-id'] })) || [];

  const exportedAt = new Date().toISOString();
  const exportedBy = val(ctx?.state?.currentUser, 'username') || (actor?.employeeId ? `employee-${actor.employeeId}` : 'root');
  let buffer;
  let mimeType;
  if (format === 'xlsx') {
    buffer = buildXlsxBuffer(columns, rows, { sheetName: collection });
    mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  } else if (format === 'pdf') {
    buffer = buildPdfBuffer(columns, rows, {
      title: `LatticeDX Export — ${collection}`,
      organizationId: effectiveOrg || 'all',
      exportedBy,
      exportedAt,
    });
    mimeType = 'application/pdf';
  } else {
    buffer = buildCsvBuffer(columns, rows);
    mimeType = 'text/csv; charset=utf-8';
  }

  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const safeSlug = collection.replace(/[^a-zA-Z0-9_-]/g, '');
  const filename = `${safeSlug}-${effectiveOrg || 'all'}.${format}`;

  return {
    filename,
    format,
    mimeType,
    organizationId: effectiveOrg,
    rowCount: rows.length,
    columns,
    omittedColumns,
    sha256,
    buffer,
  };
}

module.exports = {
  EXPORTABLE_COLLECTIONS,
  SENSITIVE_EXPORT_FIELDS,
  isExportableCollection,
  sanitizeFormulaCell,
  resolveAllowedExportColumns,
  buildCsvBuffer,
  buildXlsxBuffer,
  buildPdfBuffer,
  executeGovernedExport,
};
