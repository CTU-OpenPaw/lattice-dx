/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { createHash, randomBytes } = require('node:crypto');
const fs = require('node:fs');
const zlib = require('node:zlib');

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
const VIRTUAL_OR_ASSOC_FIELD_TYPES = new Set([
  'virtual',
  'hasmany',
  'belongstomany',
  'hasone',
  'belongsto',
  'password',
  'encryption',
]);
const BLOCKED_EXPORT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

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
  if (!clean || BLOCKED_EXPORT_KEYS.has(clean) || clean.includes('.') || clean.startsWith('$')) return true;
  return SENSITIVE_EXPORT_FIELDS.has(clean) || SENSITIVE_KEY_RE.test(clean);
}

function extractExportableCollectionFields(db, collection) {
  const colObj = typeof db?.getCollection === 'function'
    ? db.getCollection(collection)
    : (db?.collections instanceof Map ? db.collections.get(collection) : db?.collections?.[collection]) || null;
  const rawFields = colObj?.fields;
  if (!rawFields) return null;
  const list = rawFields instanceof Map
    ? [...rawFields.entries()].map(([key, f]) => ({ key, f }))
    : Array.isArray(rawFields)
      ? rawFields.map((f) => ({ key: f?.name || f?.options?.name || (typeof f === 'string' ? f : ''), f }))
      : typeof rawFields === 'object'
        ? Object.entries(rawFields).map(([key, f]) => ({ key, f }))
        : [];
  const out = [];
  const seen = new Set();
  for (const { key, f } of list) {
    const opts = f?.options && typeof f.options === 'object' ? f.options : {};
    const name = String(f?.name || opts.name || key || '').trim();
    if (!name || BLOCKED_EXPORT_KEYS.has(name) || name.includes('.') || name.startsWith('$') || seen.has(name)) {
      continue;
    }
    const fieldType = String(f?.type || opts.type || '').trim().toLowerCase();
    if (
      VIRTUAL_OR_ASSOC_FIELD_TYPES.has(fieldType)
      || f?.virtual === true
      || opts.virtual === true
      || f?.isAssociation === true
    ) {
      continue;
    }
    seen.add(name);
    out.push(name);
  }
  return out.some((name) => !isSensitiveField(name)) ? out : null;
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
  const metaColumns = !requested.length && !roleAllowedSet
    ? extractExportableCollectionFields(db, collection)
    : null;
  const candidates = requested.length
    ? requested
    : roleAllowedSet
      ? [...roleAllowedSet]
      : metaColumns
        ? metaColumns
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
  const colWidths = columns.map((col) => {
    let maxLen = String(col || '').length;
    for (const row of rows) {
      const safe = sanitizeFormulaCell(val(row, col));
      const len = String(safe ?? '').length;
      if (len > maxLen) maxLen = len;
    }
    return Math.min(48, Math.max(12, maxLen + 4));
  });
  const colsXml = colWidths.length
    ? `<cols>${colWidths.map((w, idx) => `<col min="${idx + 1}" max="${idx + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    : '';

  const rowXml = [];
  const hdrCells = columns
    .map((c, idx) => `<c r="${colLetter(idx)}1" s="1" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(c)}</t></is></c>`)
    .join('');
  rowXml.push(`<row r="1" ht="22" customHeight="1">${hdrCells}</row>`);

  rows.forEach((row, rIdx) => {
    const rNum = rIdx + 2;
    const cells = columns.map((col, cIdx) => {
      const ref = `${colLetter(cIdx)}${rNum}`;
      const safe = sanitizeFormulaCell(val(row, col));
      if (typeof safe === 'number' && Number.isFinite(safe)) {
        return `<c r="${ref}" s="2" t="n"><v>${safe}</v></c>`;
      }
      return `<c r="${ref}" s="2" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(safe)}</t></is></c>`;
    }).join('');
    rowXml.push(`<row r="${rNum}">${cells}</row>`);
  });

  const sheetViewsXml = '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>';
  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${sheetViewsXml}${colsXml}<sheetData>${rowXml.join('')}</sheetData></worksheet>`;
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1E3A5F"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFCBD5E1"/></left><right style="thin"><color rgb="FFCBD5E1"/></right><top style="thin"><color rgb="FFCBD5E1"/></top><bottom style="thin"><color rgb="FFCBD5E1"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEscape(safeSheet)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

  return createStoreZip([
    { name: '[Content_Types].xml', content: contentTypes },
    { name: '_rels/.rels', content: rootRels },
    { name: 'xl/workbook.xml', content: workbookXml },
    { name: 'xl/_rels/workbook.xml.rels', content: wbRels },
    { name: 'xl/styles.xml', content: stylesXml },
    { name: 'xl/worksheets/sheet1.xml', content: sheetXml },
  ]);
}

const DEFAULT_PDF_FONT_PATHS = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  'C:\\Windows\\Fonts\\arial.ttf',
  'C:\\Windows\\Fonts\\segoeui.ttf',
];

const PARSED_FONT_CACHE = new Map();

function findUnicodeFontPath(candidates = null) {
  const list = Array.isArray(candidates)
    ? candidates
    : [process.env.DXOS_PDF_FONT_PATH, ...DEFAULT_PDF_FONT_PATHS];
  for (const raw of list) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const candidate = raw.trim();
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

function parseCmapFormat4(buf, subOff) {
  if (subOff + 14 > buf.length) {
    throw new Error('Truncated cmap format 4 header');
  }
  const segCountX2 = buf.readUInt16BE(subOff + 6);
  const segCount = segCountX2 / 2;
  const endCodeBase = subOff + 14;
  const startCodeBase = endCodeBase + segCountX2 + 2;
  const idDeltaBase = startCodeBase + segCountX2;
  const idRangeOffsetBase = idDeltaBase + segCountX2;
  if (idRangeOffsetBase + segCountX2 > buf.length) {
    throw new Error('Truncated cmap format 4 segments');
  }
  const segments = [];
  for (let i = 0; i < segCount; i += 1) {
    segments.push({
      endCode: buf.readUInt16BE(endCodeBase + i * 2),
      startCode: buf.readUInt16BE(startCodeBase + i * 2),
      idDelta: buf.readInt16BE(idDeltaBase + i * 2),
      idRangeOffset: buf.readUInt16BE(idRangeOffsetBase + i * 2),
      idRangeOffsetAddr: idRangeOffsetBase + i * 2,
    });
  }
  return (cp) => {
    if (cp < 0 || cp > 0xffff) return 0;
    let lo = 0;
    let hi = segments.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const seg = segments[mid];
      if (cp < seg.startCode) hi = mid - 1;
      else if (cp > seg.endCode) lo = mid + 1;
      else {
        if (seg.idRangeOffset === 0) return (cp + seg.idDelta) & 0xffff;
        const glyphAddr = seg.idRangeOffsetAddr + seg.idRangeOffset + (cp - seg.startCode) * 2;
        if (glyphAddr + 2 > buf.length) return 0;
        const gid = buf.readUInt16BE(glyphAddr);
        return gid === 0 ? 0 : (gid + seg.idDelta) & 0xffff;
      }
    }
    return 0;
  };
}

function parseCmapFormat12(buf, subOff) {
  if (subOff + 16 > buf.length) {
    throw new Error('Truncated cmap format 12 header');
  }
  const numGroups = buf.readUInt32BE(subOff + 12);
  const groupsStart = subOff + 16;
  const maxGroups = Math.min(numGroups, Math.floor(Math.max(0, buf.length - groupsStart) / 12));
  return (cp) => {
    let lo = 0;
    let hi = maxGroups - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const gOff = groupsStart + mid * 12;
      if (gOff + 12 > buf.length) return 0;
      const start = buf.readUInt32BE(gOff);
      const end = buf.readUInt32BE(gOff + 4);
      if (cp < start) hi = mid - 1;
      else if (cp > end) lo = mid + 1;
      else return buf.readUInt32BE(gOff + 8) + (cp - start);
    }
    return 0;
  };
}

function parseTrueTypeFont(ttfBuffer) {
  if (!Buffer.isBuffer(ttfBuffer) || ttfBuffer.length < 12) {
    throw new Error('Invalid TTF buffer');
  }
  const sfnt = ttfBuffer.readUInt32BE(0);
  if (sfnt !== 0x00010000 && sfnt !== 0x74727565) {
    throw new Error(`Unsupported SFNT version: 0x${sfnt.toString(16)}`);
  }
  const numTables = ttfBuffer.readUInt16BE(4);
  const tables = {};
  for (let i = 0; i < numTables; i += 1) {
    const recOff = 12 + i * 16;
    if (recOff + 16 > ttfBuffer.length) break;
    const tag = ttfBuffer.toString('ascii', recOff, recOff + 4);
    const offset = ttfBuffer.readUInt32BE(recOff + 8);
    const length = ttfBuffer.readUInt32BE(recOff + 12);
    if (offset + length <= ttfBuffer.length) {
      tables[tag] = { offset, length };
    }
  }
  for (const req of ['head', 'hhea', 'maxp', 'hmtx', 'cmap']) {
    if (!tables[req]) throw new Error(`TTF missing required table: ${req}`);
  }

  const headOff = tables.head.offset;
  if (tables.head.length < 44 || headOff + 44 > ttfBuffer.length) {
    throw new Error('TTF head table truncated');
  }
  const unitsPerEm = ttfBuffer.readUInt16BE(headOff + 18) || 1000;
  const scale = (v) => Math.round((v * 1000) / unitsPerEm);
  const bbox = [
    scale(ttfBuffer.readInt16BE(headOff + 36)),
    scale(ttfBuffer.readInt16BE(headOff + 38)),
    scale(ttfBuffer.readInt16BE(headOff + 40)),
    scale(ttfBuffer.readInt16BE(headOff + 42)),
  ];

  const hheaOff = tables.hhea.offset;
  if (tables.hhea.length < 36 || hheaOff + 36 > ttfBuffer.length) {
    throw new Error('TTF hhea table truncated');
  }
  const ascent = scale(ttfBuffer.readInt16BE(hheaOff + 4));
  const descent = scale(ttfBuffer.readInt16BE(hheaOff + 6));
  const numberOfHMetrics = ttfBuffer.readUInt16BE(hheaOff + 34);

  const maxpOff = tables.maxp.offset;
  if (tables.maxp.length < 6 || maxpOff + 6 > ttfBuffer.length) {
    throw new Error('TTF maxp table truncated');
  }
  const numGlyphs = ttfBuffer.readUInt16BE(maxpOff + 4);

  const hmtxOff = tables.hmtx.offset;
  const hmtxEnd = hmtxOff + tables.hmtx.length;
  const getAdvanceWidth = (gid) => {
    const idx = Math.max(0, Math.min(gid, Math.max(0, numberOfHMetrics - 1)));
    const addr = hmtxOff + idx * 4;
    if (addr + 2 > hmtxEnd) return 500;
    return scale(ttfBuffer.readUInt16BE(addr));
  };

  const cmapOff = tables.cmap.offset;
  const cmapEnd = cmapOff + tables.cmap.length;
  if (tables.cmap.length < 4 || cmapOff + 4 > ttfBuffer.length) {
    throw new Error('TTF cmap table truncated');
  }
  const numSubtables = ttfBuffer.readUInt16BE(cmapOff + 2);
  let fmt12 = null;
  let fmt4 = null;
  for (let i = 0; i < numSubtables; i += 1) {
    const eOff = cmapOff + 4 + i * 8;
    if (eOff + 8 > cmapEnd || eOff + 8 > ttfBuffer.length) break;
    const pid = ttfBuffer.readUInt16BE(eOff);
    const eid = ttfBuffer.readUInt16BE(eOff + 2);
    const subOff = cmapOff + ttfBuffer.readUInt32BE(eOff + 4);
    if (subOff < cmapOff || subOff + 16 > cmapEnd || subOff + 16 > ttfBuffer.length) continue;
    const fmt = ttfBuffer.readUInt16BE(subOff);
    if (fmt === 12 && (!fmt12 || (pid === 3 && eid === 10) || (pid === 0 && eid === 4))) {
      fmt12 = parseCmapFormat12(ttfBuffer, subOff);
    } else if (fmt === 4 && (!fmt4 || (pid === 3 && eid === 1) || (pid === 0 && eid === 3))) {
      fmt4 = parseCmapFormat4(ttfBuffer, subOff);
    }
  }
  const lookup = fmt12 || fmt4;
  if (!lookup) throw new Error('TTF cmap missing Unicode format 4/12 subtable');

  const glyphCache = new Map();
  const getGlyphId = (cp) => {
    if (glyphCache.has(cp)) return glyphCache.get(cp);
    let gid = lookup(cp);
    if (!Number.isInteger(gid) || gid < 0 || gid >= numGlyphs) gid = 0;
    glyphCache.set(cp, gid);
    return gid;
  };

  return {
    fontName: 'LatticeUnicodeSans',
    bbox,
    ascent,
    descent,
    getAdvanceWidth,
    getGlyphId,
    rawLength: ttfBuffer.length,
    compressedBuffer: zlib.deflateSync(ttfBuffer),
  };
}

function loadCachedTrueTypeFont(fontPath) {
  const st = fs.statSync(fontPath);
  const key = `${fontPath}:${st.size}:${st.mtimeMs}`;
  if (PARSED_FONT_CACHE.has(key)) return PARSED_FONT_CACHE.get(key);
  const parsed = parseTrueTypeFont(fs.readFileSync(fontPath));
  if (PARSED_FONT_CACHE.size > 6) PARSED_FONT_CACHE.clear();
  PARSED_FONT_CACHE.set(key, parsed);
  return parsed;
}

function encodeUtf16Hex(cp) {
  if (cp <= 0xffff) return cp.toString(16).toUpperCase().padStart(4, '0');
  const u = cp - 0x10000;
  const hi = 0xd800 + (u >> 10);
  const lo = 0xdc00 + (u & 0x3ff);
  return `${hi.toString(16).toUpperCase().padStart(4, '0')}${lo.toString(16).toUpperCase().padStart(4, '0')}`;
}

function buildToUnicodeCMap(usedGids) {
  const entries = [...usedGids.entries()]
    .filter(([gid]) => gid > 0)
    .sort((a, b) => a[0] - b[0]);
  const lines = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
  ];
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    lines.push(`${chunk.length} beginbfchar`);
    for (const [gid, cp] of chunk) {
      lines.push(`<${gid.toString(16).toUpperCase().padStart(4, '0')}> <${encodeUtf16Hex(cp)}>`);
    }
    lines.push('endbfchar');
  }
  lines.push('endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end');
  return lines.join('\n');
}

function buildPdfBinaryFromObjects(objectList) {
  const sorted = objectList.slice().sort((a, b) => a.id - b.id);
  const chunks = [Buffer.from('%PDF-1.4\n', 'latin1')];
  let byteOffset = chunks[0].length;
  const offsets = [0];
  for (const obj of sorted) {
    offsets[obj.id] = byteOffset;
    const head = Buffer.from(`${obj.id} 0 obj\n`, 'latin1');
    const bodyParts = Array.isArray(obj.parts)
      ? obj.parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(String(p), 'latin1')))
      : [Buffer.isBuffer(obj.body) ? obj.body : Buffer.from(String(obj.body), 'latin1')];
    const tail = Buffer.from('\nendobj\n', 'latin1');
    chunks.push(head, ...bodyParts, tail);
    byteOffset += head.length + tail.length + bodyParts.reduce((s, p) => s + p.length, 0);
  }
  const xrefOffset = byteOffset;
  let trailerStr = `xref\n0 ${sorted.length + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= sorted.length; id += 1) {
    trailerStr += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  trailerStr += `trailer\n<< /Size ${sorted.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  chunks.push(Buffer.from(trailerStr, 'latin1'));
  return Buffer.concat(chunks);
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

function buildReportLines(columns, rows, { title = 'LatticeDX Report', organizationId = '', exportedBy = '', exportedAt = '' } = {}) {
  const allLines = [
    String(title || 'LatticeDX Report').normalize('NFC'),
    `Org: ${organizationId || 'all'} | By: ${exportedBy || 'system'} | At: ${exportedAt || new Date().toISOString()}`.normalize('NFC'),
    `Columns: ${columns.join(' | ')}`.normalize('NFC'),
    '-'.repeat(84),
  ];
  for (const row of rows) {
    const rowText = columns
      .map((c) => `${c}=${String(sanitizeFormulaCell(val(row, c))).normalize('NFC').slice(0, 60)}`)
      .join(' | ');
    allLines.push(rowText);
  }
  return allLines;
}

function wrapUnicodeLine(line, font, maxFontUnits = 58000) {
  const normalized = String(line || '').normalize('NFC');
  if (!normalized) return [''];
  const out = [];
  let cur = '';
  let curUnits = 0;
  for (const ch of normalized) {
    const cp = ch.codePointAt(0);
    const gid = font.getGlyphId(cp);
    const w = font.getAdvanceWidth(gid);
    if (cur && curUnits + w > maxFontUnits) {
      out.push(cur);
      cur = ch;
      curUnits = w;
    } else {
      cur += ch;
      curUnits += w;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function buildAsciiPdfBuffer(columns, rows, opts = {}) {
  const allLines = buildReportLines(columns, rows, opts).map((l) => l.slice(0, 110));
  const perPage = 42;
  const pageChunks = [];
  for (let i = 0; i < allLines.length; i += perPage) {
    pageChunks.push(allLines.slice(i, i + perPage));
  }
  if (!pageChunks.length) pageChunks.push(['(No records)']);

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
  return buildPdfBinaryFromObjects([
    { id: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { id: 2, body: `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>` },
    { id: 3, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' },
    ...objects,
  ]);
}

function buildUnicodePdfWithMode(columns, rows, opts = {}) {
  if (opts.fontPath === null || opts.disableUnicode === true) {
    return { buffer: buildAsciiPdfBuffer(columns, rows, opts), pdfUnicodeMode: 'ascii-fallback' };
  }
  const fontPath = typeof opts.fontPath === 'string' ? (fs.existsSync(opts.fontPath) ? opts.fontPath : null) : findUnicodeFontPath();
  if (!fontPath) {
    return { buffer: buildAsciiPdfBuffer(columns, rows, opts), pdfUnicodeMode: 'ascii-fallback' };
  }

  let font;
  try {
    font = loadCachedTrueTypeFont(fontPath);
  } catch {
    return { buffer: buildAsciiPdfBuffer(columns, rows, opts), pdfUnicodeMode: 'ascii-fallback' };
  }

  const rawLines = buildReportLines(columns, rows, opts);
  const wrappedLines = [];
  for (const line of rawLines) {
    wrappedLines.push(...wrapUnicodeLine(line, font, 58000));
  }
  const perPage = 44;
  const pageChunks = [];
  for (let i = 0; i < wrappedLines.length; i += perPage) {
    pageChunks.push(wrappedLines.slice(i, i + perPage));
  }
  if (!pageChunks.length) pageChunks.push(['(No records)']);

  const usedGids = new Map();
  const encodeLineHex = (text) => {
    let hex = '';
    for (const ch of String(text || '').normalize('NFC')) {
      const cp = ch.codePointAt(0);
      const gid = font.getGlyphId(cp);
      if (gid > 0 && !usedGids.has(gid)) usedGids.set(gid, cp);
      hex += gid.toString(16).toUpperCase().padStart(4, '0');
    }
    return hex;
  };

  const pageObjects = [];
  const pageIds = [];
  let nextId = 8;
  for (const lines of pageChunks) {
    const pageId = nextId++;
    const contentId = nextId++;
    pageIds.push(pageId);
    const ops = ['BT', '/F1 9 Tf', '40 760 Td', '15 TL'];
    for (const line of lines) {
      ops.push(`<${encodeLineHex(line)}> Tj T*`);
    }
    ops.push('ET');
    const streamStr = ops.join('\n');
    pageObjects.push({
      id: pageId,
      body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`,
    });
    pageObjects.push({
      id: contentId,
      body: `<< /Length ${Buffer.byteLength(streamStr, 'latin1')} >>\nstream\n${streamStr}\nendstream`,
    });
  }

  const widthPairs = [...usedGids.keys()]
    .sort((a, b) => a - b)
    .map((gid) => `${gid} [${font.getAdvanceWidth(gid)}]`)
    .join(' ');
  const cmapStr = buildToUnicodeCMap(usedGids);

  const buffer = buildPdfBinaryFromObjects([
    { id: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { id: 2, body: `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>` },
    { id: 3, body: `<< /Type /Font /Subtype /Type0 /BaseFont /${font.fontName} /Encoding /Identity-H /DescendantFonts [4 0 R] /ToUnicode 5 0 R >>` },
    { id: 4, body: `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${font.fontName} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 6 0 R /DW 500 /W [${widthPairs}] /CIDToGIDMap /Identity >>` },
    { id: 5, body: `<< /Length ${Buffer.byteLength(cmapStr, 'latin1')} >>\nstream\n${cmapStr}\nendstream` },
    { id: 6, body: `<< /Type /FontDescriptor /FontName /${font.fontName} /Flags 32 /FontBBox [${font.bbox.join(' ')}] /ItalicAngle 0 /Ascent ${font.ascent} /Descent ${font.descent} /CapHeight ${font.ascent} /StemV 80 /FontFile2 7 0 R >>` },
    {
      id: 7,
      parts: [
        `<< /Length ${font.compressedBuffer.length} /Length1 ${font.rawLength} /Filter /FlateDecode >>\nstream\n`,
        font.compressedBuffer,
        '\nendstream',
      ],
    },
    ...pageObjects,
  ]);
  return { buffer, pdfUnicodeMode: 'truetype-cid' };
}

function buildUnicodePdfBuffer(columns, rows, opts = {}) {
  return buildUnicodePdfWithMode(columns, rows, opts).buffer;
}

function buildPdfBuffer(columns, rows, opts = {}) {
  return buildUnicodePdfWithMode(columns, rows, opts).buffer;
}

function normalizeGotenbergUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const parsed = new URL(raw.trim());
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

async function renderGotenbergPdf(
  columns,
  rows,
  {
    gotenbergUrl = process.env.DXOS_GOTENBERG_URL,
    fetchImpl = globalThis.fetch,
    title = 'LatticeDX Report',
    organizationId = '',
    exportedBy = '',
    exportedAt = '',
  } = {},
) {
  const baseUrl = normalizeGotenbergUrl(gotenbergUrl);
  if (!baseUrl || typeof fetchImpl !== 'function') return null;

  const th = columns.map((c) => `<th>${xmlEscape(c)}</th>`).join('');
  const tr = rows.map((row) => {
    const tds = columns.map((c) => `<td>${xmlEscape(sanitizeFormulaCell(val(row, c)))}</td>`).join('');
    return `<tr>${tds}</tr>`;
  }).join('');
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:"Noto Sans","DejaVu Sans","Liberation Sans",Arial,sans-serif;font-size:11px;margin:18px;color:#0f172a}h1{font-size:15px;margin:0 0 6px}.meta{font-size:10px;color:#475569;margin-bottom:12px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #cbd5e1;padding:5px 7px;text-align:left;word-break:break-word}th{background:#1e3a5f;color:#fff;font-weight:700}tr:nth-child(even) td{background:#f8fafc}</style></head><body><h1>${xmlEscape(title)}</h1><div class="meta">Org: ${xmlEscape(organizationId || 'all')} | By: ${xmlEscape(exportedBy || 'system')} | At: ${xmlEscape(exportedAt || new Date().toISOString())}</div><table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></body></html>`;

  const boundary = `----LatticeDxGotenberg${randomBytes(8).toString('hex')}`;
  const partHeader = `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="index.html"\r\nContent-Type: text/html; charset=utf-8\r\n\r\n`;
  const partFooter = `\r\n--${boundary}--\r\n`;
  const body = Buffer.concat([
    Buffer.from(partHeader, 'utf8'),
    Buffer.from(html, 'utf8'),
    Buffer.from(partFooter, 'utf8'),
  ]);

  try {
    const res = await fetchImpl(`${baseUrl}/forms/chromium/convert/html`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
      signal: AbortSignal.timeout(10000),
    });
    if (!res?.ok) {
      await res?.body?.cancel?.();
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 8 || buf.subarray(0, 4).toString('latin1') !== '%PDF') return null;
    return buf;
  } catch {
    return null;
  }
}

async function executeGovernedExport(
  db,
  ctx,
  params,
  { isRoot = false, actor = null, fetchImpl = globalThis.fetch, fontPath = undefined } = {},
) {
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

  const maxRows = Math.max(1, Math.min(10000, Number(params.limit) || 500));
  const { columns, omittedColumns } = await resolveAllowedExportColumns(db, ctx, {
    collection,
    requestedFields: params.fields,
    isRoot,
  });

  const repo = db?.getRepository?.(collection);
  if (!repo) throw failExport('EXPORT_COLLECTION_UNAVAILABLE', 503);

  const BATCH_SIZE = 1000;
  const rows = [];
  for (let offset = 0; offset < maxRows; offset += BATCH_SIZE) {
    const batchLimit = Math.min(BATCH_SIZE, maxRows - offset);
    const batch = (await repo.find({ filter, limit: batchLimit, offset, sort: ['-id'] })) || [];
    if (!Array.isArray(batch) || !batch.length) break;
    rows.push(...batch);
    if (batch.length < batchLimit) break;
  }

  const exportedAt = new Date().toISOString();
  const exportedBy = val(ctx?.state?.currentUser, 'username') || (actor?.employeeId ? `employee-${actor.employeeId}` : 'root');
  let buffer;
  let mimeType;
  let pdfUnicodeMode;
  if (format === 'xlsx') {
    buffer = buildXlsxBuffer(columns, rows, { sheetName: collection });
    mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  } else if (format === 'pdf') {
    const pdfOpts = {
      title: `LatticeDX Export — ${collection}`,
      organizationId: effectiveOrg || 'all',
      exportedBy,
      exportedAt,
    };
    const gotenbergBuf = await renderGotenbergPdf(columns, rows, { ...pdfOpts, fetchImpl });
    if (gotenbergBuf) {
      buffer = gotenbergBuf;
      pdfUnicodeMode = 'gotenberg';
    } else {
      const pdfRes = buildUnicodePdfWithMode(columns, rows, { ...pdfOpts, fontPath });
      buffer = pdfRes.buffer;
      pdfUnicodeMode = pdfRes.pdfUnicodeMode;
    }
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
    ...(pdfUnicodeMode ? { pdfUnicodeMode } : {}),
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
  findUnicodeFontPath,
  buildUnicodePdfBuffer,
  renderGotenbergPdf,
  executeGovernedExport,
};
