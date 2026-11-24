/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const zlib = require('node:zlib');
const path = require('node:path');

const MAX_INFLATED_BYTES = 10 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const MAX_PDF_PAGE_COUNT = 5000;
const MAX_CMAP_ENTRIES = 65536;
const MAX_BFRANGE_SPAN = 4096;
const MAX_ZIP_ENTRIES = 10000;
const OCR_TIMEOUT_MS = 5000;
const MAX_EXTRACTED_FIELD_LEN = 240;
const MAX_EXTRACTED_DESC_LEN = 1000;
const ZIP_LOCAL_SIG = 0x04034b50;
const ZIP_CD_SIG = 0x02014b50;
const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_DD_SIG = 0x08074b50;
const ALLOWED_FORM_COLLECTIONS = new Set([
  'latticeOrders',
  'latticeRequests',
  'latticeStockLots',
  'latticeServiceTickets',
]);
const TRUSTED_OCR_HTTP_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  'host.docker.internal',
  'ocr',
  'ocr-service',
  'dxos-ocr',
  'paddleocr',
  'tesseract',
  'vllm',
  'ollama',
  'ninerouter',
  '9router',
]);
const BLOCKED_OCR_HOST_RE = /^(0\.\d+\.\d+\.\d+|(?:22[4-9]|2[3-5]\d)\.\d+\.\d+\.\d+|\[?::\]?|\[?::ffff:.*|::169\.254\..*|(?:[0-9a-f]{1,4}:){2,}ffff:.*|169\.254\.\d+\.\d+|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|127\.(?!0\.0\.1$)\d+\.\d+\.\d+|fe[89ab][0-9a-f]?:.*|f[cd][0-9a-f]{0,2}:.*|ff[0-9a-f]{0,2}:.*|metadata|metadata\.google\.internal|metadata\.azure\.com|instance-data)$/i;

function safeBasename(rawName, fallback = '') {
  const normalized = String(rawName || fallback || '').trim().replace(/\\/g, '/');
  if (!normalized) return '';
  return path.posix.basename(normalized).slice(0, 255);
}

function failExtract(code, status = 400, message = code) {
  return Object.assign(new Error(message || code), { code, status });
}

function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input);
  throw failExtract('EXTRACTOR_INVALID_INPUT', 400, 'Dữ liệu tệp đính kèm phải là Buffer nhị phân.');
}

function decodeXmlEntities(xmlText) {
  const named = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&', nbsp: ' ' };
  return String(xmlText || '').replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|quot|apos|amp|nbsp);/g, (full, entity) => {
    if (Object.hasOwn(named, entity)) return named[entity];
    const cp = entity.startsWith('#x')
      ? Number.parseInt(entity.slice(2), 16)
      : Number.parseInt(entity.slice(1), 10);
    if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return full;
    try {
      return String.fromCodePoint(cp);
    } catch {
      return full;
    }
  });
}

function normalizeEntryPath(name) {
  return String(name || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function assertSafeEntryPath(name) {
  if (!name || name.includes('\0') || /(?:^|\/)\.\.(?:\/|$)/.test(name)) {
    throw failExtract('OFFICE_CORRUPT_ARCHIVE', 400, 'Đường dẫn thành phần trong tệp nén không hợp lệ.');
  }
}

function assertSafeOfficeXml(xmlText) {
  const normalized = String(xmlText || '').replace(/\0/g, '');
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(normalized)) {
    throw failExtract(
      'OFFICE_XML_ENTITY_FORBIDDEN',
      400,
      'Tài liệu Office XML chứa khai báo DOCTYPE/ENTITY không được phép (chống XXE).',
    );
  }
}

function decodeOfficeXmlBuffer(xmlBuf) {
  if (!xmlBuf || xmlBuf.length === 0) return '';
  if (xmlBuf.length >= 2 && xmlBuf[0] === 0xff && xmlBuf[1] === 0xfe) {
    return xmlBuf.subarray(2).toString('utf16le');
  }
  if (xmlBuf.length >= 2 && xmlBuf[0] === 0xfe && xmlBuf[1] === 0xff) {
    const body = xmlBuf.subarray(2);
    const evenLen = body.length - (body.length % 2);
    if (evenLen <= 0) return '';
    const copy = Buffer.from(body.subarray(0, evenLen));
    copy.swap16();
    return copy.toString('utf16le');
  }
  return xmlBuf.toString('utf8');
}

/**
 * Parse ZIP Central Directory entries without inflating payload data.
 *
 * @param {Buffer|Uint8Array} buffer - Raw ZIP archive buffer.
 * @param {object} [options]
 * @param {number} [options.maxEntries=10000] - Safety upper bound on archive entry count.
 * @returns {Array<{name: string, flags: number, method: number, compressedSize: number, uncompressedSize: number, localHeaderOffset: number}>}
 */
function listZipEntriesInCentralDirectory(buffer, { maxEntries = MAX_ZIP_ENTRIES } = {}) {
  const buf = toBuffer(buffer);
  if (buf.length < 22) return [];
  const minOffset = Math.max(0, buf.length - 65557);
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= minOffset; i -= 1) {
    if (buf.readUInt32LE(i) === ZIP_EOCD_SIG) {
      const commentLen = buf.readUInt16LE(i + 20);
      if (i + 22 + commentLen <= buf.length) {
        eocdOffset = i;
        break;
      }
    }
  }
  if (eocdOffset < 0) return [];

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdSize = buf.readUInt32LE(eocdOffset + 12);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff || cdOffset + cdSize > eocdOffset) {
    throw failExtract('OFFICE_CORRUPT_ARCHIVE', 400, 'Cấu trúc Central Directory của tệp nén không hợp lệ.');
  }
  if (totalEntries > maxEntries) {
    throw failExtract('OFFICE_ZIP_TOO_MANY_ENTRIES', 400, 'Số lượng thành phần trong tệp nén vượt quá giới hạn an toàn.');
  }

  let cursor = cdOffset;
  const cdEnd = cdOffset + cdSize;
  const entries = [];

  while (cursor < cdEnd) {
    if (entries.length >= maxEntries) {
      throw failExtract('OFFICE_ZIP_TOO_MANY_ENTRIES', 400, 'Số lượng thành phần trong tệp nén vượt quá giới hạn an toàn.');
    }
    if (cursor + 46 > cdEnd || buf.readUInt32LE(cursor) !== ZIP_CD_SIG) {
      throw failExtract('OFFICE_CORRUPT_ARCHIVE', 400, 'Cấu trúc Central Directory của tệp nén bị hỏng.');
    }
    const flags = buf.readUInt16LE(cursor + 8);
    const method = buf.readUInt16LE(cursor + 10);
    const compressedSize = buf.readUInt32LE(cursor + 20);
    const uncompressedSize = buf.readUInt32LE(cursor + 24);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const localHeaderOffset = buf.readUInt32LE(cursor + 42);
    const headerEnd = cursor + 46 + nameLen + extraLen + commentLen;
    if (headerEnd > cdEnd) {
      throw failExtract('OFFICE_CORRUPT_ARCHIVE', 400, 'Entry Central Directory bị cắt cụt.');
    }

    const name = normalizeEntryPath(buf.toString('utf8', cursor + 46, cursor + 46 + nameLen));
    assertSafeEntryPath(name);
    entries.push({ name, flags, method, compressedSize, uncompressedSize, localHeaderOffset });
    cursor = headerEnd;
  }

  return entries;
}

function listZipEntriesInLocalHeaders(buffer, { maxEntries = MAX_ZIP_ENTRIES } = {}) {
  const buf = toBuffer(buffer);
  let cursor = 0;
  const entries = [];

  while (cursor + 30 <= buf.length) {
    if (buf.readUInt32LE(cursor) !== ZIP_LOCAL_SIG) break;
    if (entries.length >= maxEntries) {
      throw failExtract('OFFICE_ZIP_TOO_MANY_ENTRIES', 400, 'Số lượng thành phần trong tệp nén vượt quá giới hạn an toàn.');
    }
    const flags = buf.readUInt16LE(cursor + 6);
    const method = buf.readUInt16LE(cursor + 8);
    const compressedSize = buf.readUInt32LE(cursor + 18);
    const uncompressedSize = buf.readUInt32LE(cursor + 22);
    const nameLen = buf.readUInt16LE(cursor + 26);
    const extraLen = buf.readUInt16LE(cursor + 28);
    const dataStart = cursor + 30 + nameLen + extraLen;
    if (dataStart > buf.length) break;

    const name = normalizeEntryPath(buf.toString('utf8', cursor + 30, cursor + 30 + nameLen));
    const hasDeferredSize = (flags & 0x08) !== 0 && compressedSize === 0;
    if (hasDeferredSize) break;

    assertSafeEntryPath(name);
    entries.push({ name, flags, method, compressedSize, uncompressedSize, localHeaderOffset: cursor });

    let next = dataStart + compressedSize;
    if ((flags & 0x08) !== 0 && next + 12 <= buf.length) {
      next += buf.readUInt32LE(next) === ZIP_DD_SIG ? 16 : 12;
    }
    cursor = next;
  }
  return entries;
}

function findEntryByPath(entries, targetPath) {
  const targetLower = String(targetPath || '').toLowerCase();
  let ciMatch = null;
  for (const entry of entries) {
    if (entry.name === targetPath) return entry;
    if (!ciMatch && entry.name.toLowerCase() === targetLower) ciMatch = entry;
  }
  return ciMatch;
}

function findZipEntryInCentralDirectory(buf, targetPath) {
  const entries = listZipEntriesInCentralDirectory(buf);
  return entries.length ? findEntryByPath(entries, targetPath) : null;
}

function findZipEntryInLocalHeaders(buf, targetPath) {
  const entries = listZipEntriesInLocalHeaders(buf);
  return entries.length ? findEntryByPath(entries, targetPath) : null;
}

function assertArchiveNotEncrypted(entries) {
  for (const entry of entries) {
    if (((Number(entry.flags) || 0) & 0x01) !== 0) {
      throw failExtract('OFFICE_ENCRYPTED_ARCHIVE', 400, 'Tệp Office đã được mã hóa/bảo vệ bằng mật khẩu nên không thể trích xuất.');
    }
  }
}

function inflateZipEntry(buf, entry, budget = { maxInflatedBytes: MAX_INFLATED_BYTES, totalInflatedBytes: 0 }) {
  const maxBytes = Number(budget.maxInflatedBytes) > 0 ? Number(budget.maxInflatedBytes) : MAX_INFLATED_BYTES;
  const remaining = maxBytes - (Number(budget.totalInflatedBytes) || 0);
  if (remaining <= 0 || entry.uncompressedSize > remaining) {
    throw failExtract('OFFICE_ZIP_BOMB', 400, 'Kích thước XML giải nén vượt quá giới hạn an toàn 10MB (nghi vấn zip-bomb).');
  }

  const localOff = entry.localHeaderOffset;
  if (localOff < 0 || localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== ZIP_LOCAL_SIG) {
    throw failExtract('OFFICE_CORRUPT_ARCHIVE', 400, `Header cục bộ của ${entry.name} bị hỏng.`);
  }
  const localFlags = buf.readUInt16LE(localOff + 6);
  if (((Number(entry.flags) || 0) & 0x01) !== 0 || (localFlags & 0x01) !== 0) {
    throw failExtract('OFFICE_ENCRYPTED_ARCHIVE', 400, 'Tệp Office đã được mã hóa/bảo vệ bằng mật khẩu nên không thể trích xuất.');
  }
  const localNameLen = buf.readUInt16LE(localOff + 26);
  const localExtraLen = buf.readUInt16LE(localOff + 28);
  const dataStart = localOff + 30 + localNameLen + localExtraLen;
  if (dataStart > buf.length || entry.compressedSize > buf.length - dataStart) {
    throw failExtract('OFFICE_CORRUPT_ARCHIVE', 400, `Dữ liệu nén ${entry.name} bị cắt cụt.`);
  }
  const dataEnd = dataStart + entry.compressedSize;
  const compressedSlice = buf.subarray(dataStart, dataEnd);

  let outBuf;
  if (entry.method === 0) {
    if (compressedSlice.length > remaining) {
      throw failExtract('OFFICE_ZIP_BOMB', 400, `Kích thước ${entry.name} vượt quá giới hạn an toàn 10MB.`);
    }
    outBuf = compressedSlice;
  } else if (entry.method === 8) {
    try {
      outBuf = zlib.inflateRawSync(compressedSlice, { maxOutputLength: remaining });
    } catch (err) {
      if (err?.code === 'ERR_BUFFER_TOO_LARGE') {
        throw failExtract('OFFICE_ZIP_BOMB', 400, 'Kích thước XML giải nén vượt quá giới hạn 10MB (nghi vấn zip-bomb).');
      }
      throw failExtract('OFFICE_CORRUPT_ARCHIVE', 400, `Không thể giải nén dữ liệu XML từ ${entry.name}.`);
    }
  } else {
    throw failExtract('OFFICE_UNSUPPORTED_COMPRESSION', 400, `Phương thức nén ZIP (${entry.method}) chưa được hỗ trợ.`);
  }

  budget.totalInflatedBytes = (Number(budget.totalInflatedBytes) || 0) + outBuf.length;
  if (budget.totalInflatedBytes > maxBytes) {
    throw failExtract('OFFICE_ZIP_BOMB', 400, 'Tổng dung lượng XML giải nén vượt quá giới hạn an toàn 10MB.');
  }
  return outBuf;
}

function readOfficeXmlEntry(buf, entry, budget) {
  const xmlBuf = inflateZipEntry(buf, entry, budget);
  const rawXml = decodeOfficeXmlBuffer(xmlBuf);
  assertSafeOfficeXml(rawXml);
  return rawXml;
}

function scanAndCacheArchiveXml(buf, entries, budget) {
  const xmlCache = new Map();
  for (const entry of entries) {
    if (!/\.(?:xml|rels)$/i.test(entry.name)) continue;
    const rawXml = readOfficeXmlEntry(buf, entry, budget);
    xmlCache.set(entry.name.toLowerCase(), rawXml);
  }
  return xmlCache;
}

function getCachedOfficeXml(buf, entry, budget, xmlCache) {
  if (!entry) return '';
  const key = entry.name.toLowerCase();
  if (xmlCache && xmlCache.has(key)) return xmlCache.get(key);
  return readOfficeXmlEntry(buf, entry, budget);
}

function listArchiveEntries(buf, { maxEntries = MAX_ZIP_ENTRIES } = {}) {
  const cdEntries = listZipEntriesInCentralDirectory(buf, { maxEntries });
  if (cdEntries.length) return cdEntries;
  if (buf.length >= 30 && buf.readUInt32LE(0) === ZIP_LOCAL_SIG) {
    return listZipEntriesInLocalHeaders(buf, { maxEntries });
  }
  return [];
}

function findNextOpenTag(xml, lowerXml, openPrefix, fromIdx) {
  let pos = fromIdx;
  while (pos < lowerXml.length) {
    const start = lowerXml.indexOf(openPrefix, pos);
    if (start < 0) return null;
    const afterName = start + openPrefix.length;
    if (afterName >= lowerXml.length) return null;
    const ch = lowerXml[afterName];
    const isBoundary = ch === '>' || ch === '/' || ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n';
    if (!isBoundary) {
      pos = afterName;
      continue;
    }
    const openEnd = xml.indexOf('>', afterName);
    if (openEnd < 0) return null;
    if (ch === '/' && openEnd !== afterName + 1) {
      pos = afterName + 1;
      continue;
    }
    const selfClosing = openEnd > afterName && xml[openEnd - 1] === '/';
    const attrsEnd = selfClosing ? openEnd - 1 : openEnd;
    return {
      start,
      openEnd: openEnd + 1,
      attrs: xml.slice(afterName, attrsEnd),
      selfClosing,
    };
  }
  return null;
}

function findClosingTag(lowerXml, lowerTag, fromIdx) {
  const prefix = `</${lowerTag}`;
  let searchPos = fromIdx;
  while (searchPos < lowerXml.length) {
    const idx = lowerXml.indexOf(prefix, searchPos);
    if (idx < 0) return null;
    const afterNameIdx = idx + prefix.length;
    if (afterNameIdx >= lowerXml.length) return null;
    const boundary = lowerXml[afterNameIdx];
    if (boundary === '>') {
      return { start: idx, end: afterNameIdx + 1 };
    }
    if (boundary === ' ' || boundary === '\t' || boundary === '\r' || boundary === '\n') {
      const closeGt = lowerXml.indexOf('>', afterNameIdx);
      if (closeGt < 0) return null;
      return { start: idx, end: closeGt + 1 };
    }
    searchPos = afterNameIdx;
  }
  return null;
}

function forEachXmlElement(xmlText, tagName, onElement) {
  const xml = String(xmlText || '');
  if (!xml) return;
  const lowerXml = xml.toLowerCase();
  const lowerTag = String(tagName || '').toLowerCase();
  const openPrefix = `<${lowerTag}`;
  let cursor = 0;

  while (cursor < xml.length) {
    const open = findNextOpenTag(xml, lowerXml, openPrefix, cursor);
    if (!open) break;
    if (open.selfClosing) {
      onElement({ attrs: open.attrs, body: '', selfClosing: true, start: open.start, end: open.openEnd });
      cursor = open.openEnd;
      continue;
    }
    const close = findClosingTag(lowerXml, lowerTag, open.openEnd);
    if (!close) break;
    onElement({
      attrs: open.attrs,
      body: xml.slice(open.openEnd, close.start),
      selfClosing: false,
      start: open.start,
      end: close.end,
    });
    cursor = close.end;
  }
}

function findFirstXmlElement(xmlText, tagName) {
  const xml = String(xmlText || '');
  if (!xml) return null;
  const lowerXml = xml.toLowerCase();
  const lowerTag = String(tagName || '').toLowerCase();
  const openPrefix = `<${lowerTag}`;
  const open = findNextOpenTag(xml, lowerXml, openPrefix, 0);
  if (!open) return null;
  if (open.selfClosing) {
    return { attrs: open.attrs, body: '', selfClosing: true, start: open.start, end: open.openEnd };
  }
  const close = findClosingTag(lowerXml, lowerTag, open.openEnd);
  if (!close) return null;
  return {
    attrs: open.attrs,
    body: xml.slice(open.openEnd, close.start),
    selfClosing: false,
    start: open.start,
    end: close.end,
  };
}

function forEachXmlTag(xmlText, tagName, onTag) {
  const xml = String(xmlText || '');
  if (!xml) return;
  const lowerXml = xml.toLowerCase();
  const lowerTag = String(tagName || '').toLowerCase();
  const openPrefix = `<${lowerTag}`;
  let cursor = 0;
  while (cursor < xml.length) {
    const open = findNextOpenTag(xml, lowerXml, openPrefix, cursor);
    if (!open) break;
    onTag({ attrs: open.attrs, selfClosing: open.selfClosing });
    cursor = open.openEnd;
  }
}

function stripXmlElements(xmlText, tagName) {
  const xml = String(xmlText || '');
  if (!xml) return '';
  const lowerXml = xml.toLowerCase();
  const lowerTag = String(tagName || '').toLowerCase();
  const openPrefix = `<${lowerTag}`;
  const out = [];
  let cursor = 0;
  while (cursor < xml.length) {
    const open = findNextOpenTag(xml, lowerXml, openPrefix, cursor);
    if (!open) {
      out.push(xml.slice(cursor));
      break;
    }
    out.push(xml.slice(cursor, open.start));
    if (open.selfClosing) {
      cursor = open.openEnd;
      continue;
    }
    const close = findClosingTag(lowerXml, lowerTag, open.openEnd);
    if (!close) {
      out.push(xml.slice(open.start));
      break;
    }
    cursor = close.end;
  }
  return out.join('');
}

function stripXmlTags(xmlText, replacement = '') {
  const xml = String(xmlText || '');
  if (!xml) return '';
  const out = [];
  let cursor = 0;
  while (cursor < xml.length) {
    const lt = xml.indexOf('<', cursor);
    if (lt < 0) {
      out.push(xml.slice(cursor));
      break;
    }
    if (lt > cursor) out.push(xml.slice(cursor, lt));
    const gt = xml.indexOf('>', lt + 1);
    if (gt < 0) {
      out.push(xml.slice(lt));
      break;
    }
    if (replacement) out.push(replacement);
    cursor = gt + 1;
  }
  return out.join('');
}

function extractWordMlText(rawXml) {
  const xml = String(rawXml || '');
  const out = [];
  let cursor = 0;
  while (cursor < xml.length) {
    const lt = xml.indexOf('<', cursor);
    if (lt < 0) {
      out.push(xml.slice(cursor));
      break;
    }
    if (lt > cursor) out.push(xml.slice(cursor, lt));
    const gt = xml.indexOf('>', lt + 1);
    if (gt < 0) break;
    const lowerTag = xml.slice(lt + 1, gt).trim().toLowerCase();
    if (lowerTag.startsWith('/w:p') && (lowerTag.length === 4 || /\s/.test(lowerTag[4]))) {
      out.push('\n');
    } else if (lowerTag.startsWith('/w:tr') && (lowerTag.length === 5 || /\s/.test(lowerTag[5]))) {
      out.push('\n');
    } else if (lowerTag.startsWith('/w:tc') && (lowerTag.length === 5 || /\s/.test(lowerTag[5]))) {
      out.push('\t');
    } else if (/^w:br(?:\s|\/|$)/.test(lowerTag)) {
      out.push(/w:type[ \t]*=[ \t]*["']page["']/.test(lowerTag) ? '\f' : '\n');
    } else if (/^w:lastrenderedpagebreak(?:\s|\/|$)/.test(lowerTag)) {
      out.push('\f');
    } else if (/^w:cr(?:\s|\/|$)/.test(lowerTag)) {
      out.push('\n');
    } else if (/^w:tab(?:\s|\/|$)/.test(lowerTag)) {
      out.push(' ');
    }
    cursor = gt + 1;
  }
  return out.join('');
}

/**
 * Extract plain text from a `.docx` WordprocessingML ZIP buffer.
 *
 * @param {Buffer|Uint8Array} buffer - Raw `.docx` binary buffer.
 * @param {object} [options]
 * @param {number} [options.maxInflatedBytes=10485760] - Cumulative XML inflation budget.
 * @returns {string} Extracted document text with page breaks normalized to `\f`.
 */
function extractDocxText(buffer, { maxInflatedBytes = MAX_INFLATED_BYTES } = {}) {
  const buf = toBuffer(buffer);
  if (buf.length < 30 || (buf.readUInt32LE(0) !== ZIP_LOCAL_SIG && findZipEntryInCentralDirectory(buf, 'word/document.xml') == null)) {
    throw failExtract('DOCX_INVALID_ARCHIVE', 400, 'Tệp DOCX không đúng định dạng nén ZIP hợp lệ.');
  }

  const entries = listArchiveEntries(buf);
  assertArchiveNotEncrypted(entries);
  const entry = findEntryByPath(entries, 'word/document.xml');
  if (!entry) {
    throw failExtract('DOCX_MISSING_DOCUMENT_XML', 400, 'Tệp DOCX không chứa thành phần word/document.xml.');
  }

  const budget = { maxInflatedBytes, totalInflatedBytes: 0 };
  const xmlCache = scanAndCacheArchiveXml(buf, entries, budget);
  const rawXml = getCachedOfficeXml(buf, entry, budget, xmlCache);
  const withBreaks = extractWordMlText(rawXml);
  const decoded = decodeXmlEntities(withBreaks);
  return decoded
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function getXmlAttr(attrText, attrName) {
  const re = new RegExp(`(?:^|[ \\t\\r\\n])${attrName}[ \\t\\r\\n]*=[ \\t\\r\\n]*(?:"([^"]*)"|'([^']*)')`, 'i');
  const m = String(attrText || '').match(re);
  return m ? decodeXmlEntities(m[1] ?? m[2] ?? '') : '';
}

function colLettersToIndex(letters) {
  let idx = 0;
  const upper = String(letters || '').toUpperCase();
  for (let i = 0; i < upper.length; i += 1) {
    const code = upper.charCodeAt(i);
    if (code >= 65 && code <= 90) {
      idx = idx * 26 + (code - 64);
    }
  }
  return idx > 0 ? idx - 1 : -1;
}

function parseSharedStringsXml(xmlText) {
  const strings = [];
  forEachXmlElement(xmlText, 'si', ({ body, selfClosing }) => {
    if (selfClosing || !body) {
      strings.push('');
      return;
    }
    const cleanSi = stripXmlElements(body, 'rPh');
    let combined = '';
    forEachXmlElement(cleanSi, 't', ({ body: tBody, selfClosing: tSelf }) => {
      if (!tSelf && tBody) {
        combined += decodeXmlEntities(tBody);
      }
    });
    strings.push(combined);
  });
  return strings;
}

function parseWorkbookSheetMetadata(workbookXml, relsXml) {
  const rIdToTarget = new Map();
  if (relsXml) {
    forEachXmlTag(relsXml, 'Relationship', ({ attrs }) => {
      const id = getXmlAttr(attrs, 'Id');
      const target = normalizeEntryPath(getXmlAttr(attrs, 'Target'));
      if (id && target) {
        const normalizedTarget = target.startsWith('xl/') ? target : normalizeEntryPath(`xl/${target.replace(/^\.\//, '')}`);
        rIdToTarget.set(id, normalizedTarget.toLowerCase());
      }
    });
  }

  const byTarget = new Map();
  const orderedNames = [];
  if (workbookXml) {
    forEachXmlTag(workbookXml, 'sheet', ({ attrs }) => {
      const name = getXmlAttr(attrs, 'name').trim();
      const rId = getXmlAttr(attrs, 'r:id') || getXmlAttr(attrs, 'id');
      orderedNames.push(name);
      if (rId && rIdToTarget.has(rId) && name) {
        byTarget.set(rIdToTarget.get(rId), name);
      }
    });
  }
  return { byTarget, orderedNames };
}

function parseWorksheetXml(sheetXml, sharedStrings) {
  const lines = [];
  forEachXmlElement(sheetXml, 'row', ({ body: rowBody, selfClosing: rowSelf }) => {
    if (rowSelf || !rowBody) return;
    const rowCells = [];
    forEachXmlElement(rowBody, 'c', ({ attrs, body }) => {
      const cellRef = getXmlAttr(attrs, 'r');
      const cellType = getXmlAttr(attrs, 't').toLowerCase() || 'n';

      let value = '';
      if (cellType === 's') {
        const vElem = findFirstXmlElement(body, 'v');
        if (vElem && !vElem.selfClosing) {
          const idx = Number.parseInt(vElem.body.trim(), 10);
          value = Number.isInteger(idx) && idx >= 0 && idx < sharedStrings.length ? sharedStrings[idx] : '';
        }
      } else if (cellType === 'inlinestr') {
        const isElem = findFirstXmlElement(body, 'is');
        const isBody = isElem ? isElem.body : body;
        let parts = '';
        forEachXmlElement(isBody, 't', ({ body: tBody, selfClosing: tSelf }) => {
          if (!tSelf && tBody) parts += decodeXmlEntities(tBody);
        });
        value = parts || decodeXmlEntities(stripXmlTags(isBody, ''));
      } else if (cellType === 'b') {
        const vElem = findFirstXmlElement(body, 'v');
        if (vElem && !vElem.selfClosing) {
          const rawBool = vElem.body.trim().toLowerCase();
          value = rawBool === '1' || rawBool === 'true' ? 'TRUE' : 'FALSE';
        }
      } else {
        const vElem = findFirstXmlElement(body, 'v');
        if (vElem && !vElem.selfClosing) {
          value = decodeXmlEntities(vElem.body);
        }
      }

      const cleanValue = String(value || '')
        .replace(/\r\n/g, ' ')
        .replace(/[\r\n]+/g, ' ')
        .replace(/\t+/g, ' ')
        .trim();

      const colMatch = cellRef.match(/^([A-Za-z]+)\d+$/);
      if (colMatch) {
        const colIdx = colLettersToIndex(colMatch[1]);
        if (colIdx >= 0 && colIdx >= rowCells.length && colIdx - rowCells.length <= 32) {
          while (rowCells.length < colIdx) rowCells.push('');
        }
      }
      rowCells.push(cleanValue);
    });

    while (rowCells.length && rowCells[rowCells.length - 1] === '') {
      rowCells.pop();
    }
    if (rowCells.some(Boolean)) {
      lines.push(rowCells.join('\t'));
    }
  });
  return lines;
}

/**
 * Extract structured sheet text from an `.xlsx` SpreadsheetML ZIP buffer.
 *
 * @param {Buffer|Uint8Array} buffer - Raw `.xlsx` binary buffer.
 * @param {object} [options]
 * @param {number} [options.maxInflatedBytes=10485760] - Cumulative XML inflation budget.
 * @returns {{text: string, format: 'xlsx', pageCount: number, sheets: Array<{name: string, path: string, rowCount: number, text: string}>}}
 */
function extractXlsxText(buffer, { maxInflatedBytes = MAX_INFLATED_BYTES } = {}) {
  const buf = toBuffer(buffer);
  const entries = listArchiveEntries(buf);
  if (!entries.length) {
    throw failExtract('XLSX_INVALID_ARCHIVE', 400, 'Tệp XLSX không đúng định dạng nén ZIP hợp lệ.');
  }
  assertArchiveNotEncrypted(entries);

  const worksheetEntries = entries
    .filter((e) => /^xl\/worksheets\/[^/]+\.xml$/i.test(e.name))
    .sort((a, b) => {
      const ma = a.name.match(/sheet(\d+)\.xml$/i);
      const mb = b.name.match(/sheet(\d+)\.xml$/i);
      if (ma && mb) return Number(ma[1]) - Number(mb[1]);
      if (ma) return -1;
      if (mb) return 1;
      return a.name.localeCompare(b.name);
    });

  if (!worksheetEntries.length) {
    throw failExtract('XLSX_MISSING_WORKSHEETS', 400, 'Tệp XLSX không chứa trang tính (xl/worksheets/sheet*.xml).');
  }

  const budget = { maxInflatedBytes, totalInflatedBytes: 0 };
  const xmlCache = scanAndCacheArchiveXml(buf, entries, budget);

  const workbookEntry = findEntryByPath(entries, 'xl/workbook.xml');
  const workbookXml = getCachedOfficeXml(buf, workbookEntry, budget, xmlCache);
  const relsEntry = findEntryByPath(entries, 'xl/_rels/workbook.xml.rels');
  const relsXml = getCachedOfficeXml(buf, relsEntry, budget, xmlCache);
  const sheetMeta = parseWorkbookSheetMetadata(workbookXml, relsXml);

  const sharedStringsEntry = findEntryByPath(entries, 'xl/sharedStrings.xml');
  const sharedStrings = sharedStringsEntry
    ? parseSharedStringsXml(getCachedOfficeXml(buf, sharedStringsEntry, budget, xmlCache))
    : [];

  const sheets = [];
  const sheetTexts = [];
  worksheetEntries.forEach((wsEntry, idx) => {
    const wsXml = getCachedOfficeXml(buf, wsEntry, budget, xmlCache);
    const numMatch = wsEntry.name.match(/sheet(\d+)\.xml$/i);
    const ordinalIdx = numMatch ? Number(numMatch[1]) - 1 : idx;
    const sheetName = sheetMeta.byTarget.get(wsEntry.name.toLowerCase())
      || sheetMeta.orderedNames[idx]
      || sheetMeta.orderedNames[ordinalIdx]
      || `Sheet ${numMatch ? numMatch[1] : idx + 1}`;
    const rows = parseWorksheetXml(wsXml, sharedStrings);
    const bodyText = rows.join('\n');
    const sectionText = bodyText ? `# Sheet: ${sheetName}\n${bodyText}` : `# Sheet: ${sheetName}`;
    sheets.push({
      name: sheetName,
      path: wsEntry.name,
      rowCount: rows.length,
      text: bodyText,
    });
    sheetTexts.push(sectionText);
  });

  return {
    text: sheetTexts.join('\f').trim(),
    format: 'xlsx',
    pageCount: sheets.length,
    sheets,
  };
}

function matchDrawingMlTag(xml, lower, idx, tagName) {
  const prefix = `<${tagName}`;
  if (!lower.startsWith(prefix, idx)) return null;
  const afterName = idx + prefix.length;
  const ch = lower[afterName];
  const isBoundary = ch === '>' || ch === '/' || ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n';
  if (!isBoundary) return null;
  const openEnd = xml.indexOf('>', afterName);
  if (openEnd < 0) return { eof: true };
  if (ch === '/' && openEnd !== afterName + 1) return null;
  const selfClosing = openEnd > afterName && xml[openEnd - 1] === '/';
  return { tagName, openEnd: openEnd + 1, selfClosing };
}

function extractDrawingMlRunsText(fragment) {
  const xml = String(fragment || '');
  if (!xml) return '';
  const lower = xml.toLowerCase();
  const tokens = [];
  let cursor = 0;

  while (cursor < xml.length) {
    const idx = lower.indexOf('<a:', cursor);
    if (idx < 0) break;

    const tag = matchDrawingMlTag(xml, lower, idx, 'a:tab')
      || matchDrawingMlTag(xml, lower, idx, 'a:br')
      || matchDrawingMlTag(xml, lower, idx, 'a:t');

    if (!tag) {
      cursor = idx + 3;
      continue;
    }
    if (tag.eof) break;

    if (tag.tagName === 'a:t') {
      if (tag.selfClosing) {
        cursor = tag.openEnd;
        continue;
      }
      const close = findClosingTag(lower, 'a:t', tag.openEnd);
      if (!close) break;
      tokens.push(decodeXmlEntities(xml.slice(tag.openEnd, close.start)));
      cursor = close.end;
    } else {
      tokens.push(tag.tagName === 'a:br' ? '\n' : '\t');
      if (tag.selfClosing) {
        cursor = tag.openEnd;
      } else {
        const close = findClosingTag(lower, tag.tagName, tag.openEnd);
        cursor = close ? close.end : tag.openEnd;
      }
    }
  }

  return tokens.join('').replace(/ {2,}/g, ' ').trim();
}

function parseDrawingMlParagraphs(xmlText) {
  const paragraphs = [];
  forEachXmlElement(xmlText, 'a:p', ({ body, selfClosing }) => {
    if (selfClosing || !body) return;
    const line = extractDrawingMlRunsText(body);
    if (line) paragraphs.push(line);
  });
  if (!paragraphs.length) {
    const fallback = extractDrawingMlRunsText(xmlText);
    if (fallback) paragraphs.push(fallback);
  }
  return paragraphs.join('\n').trim();
}

/**
 * Extract slide and speaker-note text from a `.pptx` PresentationML ZIP buffer.
 *
 * @param {Buffer|Uint8Array} buffer - Raw `.pptx` binary buffer.
 * @param {object} [options]
 * @param {number} [options.maxInflatedBytes=10485760] - Cumulative XML inflation budget.
 * @returns {{text: string, format: 'pptx', pageCount: number, slides: Array<{slideNumber: number, path: string, text: string, notesText: string}>}}
 */
function extractPptxText(buffer, { maxInflatedBytes = MAX_INFLATED_BYTES } = {}) {
  const buf = toBuffer(buffer);
  const entries = listArchiveEntries(buf);
  if (!entries.length) {
    throw failExtract('PPTX_INVALID_ARCHIVE', 400, 'Tệp PPTX không đúng định dạng nén ZIP hợp lệ.');
  }
  assertArchiveNotEncrypted(entries);

  const slideEntries = entries
    .filter((e) => /^ppt\/slides\/slide(\d+)\.xml$/i.test(e.name))
    .sort((a, b) => {
      const na = Number(a.name.match(/slide(\d+)\.xml$/i)[1]);
      const nb = Number(b.name.match(/slide(\d+)\.xml$/i)[1]);
      return na - nb;
    });

  if (!slideEntries.length) {
    throw failExtract('PPTX_MISSING_SLIDES', 400, 'Tệp PPTX không chứa slide (ppt/slides/slide*.xml).');
  }

  const budget = { maxInflatedBytes, totalInflatedBytes: 0 };
  const xmlCache = scanAndCacheArchiveXml(buf, entries, budget);

  const notesByNum = new Map();
  const notesEntries = entries
    .filter((e) => /^ppt\/notesSlides\/notesSlide(\d+)\.xml$/i.test(e.name))
    .sort((a, b) => {
      const na = Number(a.name.match(/notesSlide(\d+)\.xml$/i)[1]);
      const nb = Number(b.name.match(/notesSlide(\d+)\.xml$/i)[1]);
      return na - nb;
    });
  for (const nEntry of notesEntries) {
    const num = Number(nEntry.name.match(/notesSlide(\d+)\.xml$/i)[1]);
    notesByNum.set(num, nEntry);
  }

  const slides = [];
  const slideSections = [];
  for (const sEntry of slideEntries) {
    const slideNum = Number(sEntry.name.match(/slide(\d+)\.xml$/i)[1]);
    const slideXml = getCachedOfficeXml(buf, sEntry, budget, xmlCache);
    const bodyText = parseDrawingMlParagraphs(slideXml);

    let notesEntry = null;
    const relsEntry = findEntryByPath(entries, `ppt/slides/_rels/slide${slideNum}.xml.rels`);
    if (relsEntry) {
      const relsXml = getCachedOfficeXml(buf, relsEntry, budget, xmlCache);
      forEachXmlTag(relsXml, 'Relationship', ({ attrs }) => {
        if (notesEntry) return;
        const target = normalizeEntryPath(getXmlAttr(attrs, 'Target'));
        const m = target.match(/notesSlides\/notesSlide(\d+)\.xml$/i);
        if (m) {
          notesEntry = findEntryByPath(entries, `ppt/notesSlides/notesSlide${m[1]}.xml`);
        }
      });
    }
    if (!notesEntry && notesByNum.has(slideNum)) {
      notesEntry = notesByNum.get(slideNum);
    }

    let notesText = '';
    if (notesEntry) {
      notesText = parseDrawingMlParagraphs(getCachedOfficeXml(buf, notesEntry, budget, xmlCache));
    }

    const parts = [`# Slide ${slideNum}`];
    if (bodyText) parts.push(bodyText);
    if (notesText) parts.push(`Notes:\n${notesText}`);
    const section = parts.join('\n');
    slides.push({
      slideNumber: slideNum,
      path: sEntry.name,
      text: bodyText,
      notesText,
    });
    slideSections.push(section);
  }

  return {
    text: slideSections.join('\f').trim(),
    format: 'pptx',
    pageCount: slides.length,
    slides,
  };
}

function decodePdfBytes(byteArray) {
  const buf = Buffer.from(byteArray);
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const body = buf.subarray(2);
    const evenLen = body.length - (body.length % 2);
    if (evenLen <= 0) return '';
    const copy = Buffer.from(body.subarray(0, evenLen));
    copy.swap16();
    return copy.toString('utf16le');
  }
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  return buf.toString('latin1');
}

function decodeCMapDestHex(hexRaw) {
  const clean = String(hexRaw || '').replace(/\s+/g, '');
  if (!clean) return '';
  const padded = clean.length % 2 === 1 ? `${clean}0` : clean;
  const buf = Buffer.from(padded, 'hex');
  if (buf.length >= 2 && buf.length % 2 === 0) {
    const copy = Buffer.from(buf);
    copy.swap16();
    return copy.toString('utf16le').normalize('NFC');
  }
  return buf.toString('utf8').normalize('NFC');
}

function incrementCMapDestHex(hexRaw, offset) {
  const clean = String(hexRaw || '').replace(/\s+/g, '');
  if (!clean) return '';
  const padded = clean.length % 2 === 1 ? `${clean}0` : clean;
  const buf = Buffer.from(padded, 'hex');
  if (buf.length >= 2 && buf.length % 2 === 0) {
    const lastOffset = buf.length - 2;
    const codeUnit = buf.readUInt16BE(lastOffset);
    buf.writeUInt16BE((codeUnit + offset) & 0xffff, lastOffset);
  } else if (buf.length >= 1) {
    const lastOffset = buf.length - 1;
    buf[lastOffset] = (buf[lastOffset] + offset) & 0xff;
  }
  return decodeCMapDestHex(buf.toString('hex'));
}

function extractCMapHexTokens(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === '<') {
      const end = text.indexOf('>', i + 1);
      if (end < 0) break;
      const inner = text.slice(i + 1, end).replace(/\s+/g, '');
      if (inner && /^[0-9a-fA-F]+$/.test(inner)) {
        tokens.push({ kind: 'hex', value: inner.toUpperCase() });
      }
      i = end + 1;
      continue;
    }
    if (text[i] === '[') {
      const end = text.indexOf(']', i + 1);
      if (end < 0) break;
      const innerText = text.slice(i + 1, end);
      const arr = [];
      let p = 0;
      while (p < innerText.length) {
        const lt = innerText.indexOf('<', p);
        if (lt < 0) break;
        const gt = innerText.indexOf('>', lt + 1);
        if (gt < 0) break;
        const hex = innerText.slice(lt + 1, gt).replace(/\s+/g, '');
        if (hex && /^[0-9a-fA-F]+$/.test(hex)) arr.push(hex.toUpperCase());
        p = gt + 1;
      }
      tokens.push({ kind: 'arr', value: arr });
      i = end + 1;
      continue;
    }
    i += 1;
  }
  return tokens;
}

function scanCMapSections(cmapText, beginKw, endKw, onSection) {
  let cursor = 0;
  while (cursor < cmapText.length) {
    const beginIdx = cmapText.indexOf(beginKw, cursor);
    if (beginIdx < 0) break;
    const bodyStart = beginIdx + beginKw.length;
    const endIdx = cmapText.indexOf(endKw, bodyStart);
    if (endIdx < 0) break;
    onSection(cmapText.slice(bodyStart, endIdx));
    cursor = endIdx + endKw.length;
  }
}

/**
 * Parse a PDF `/ToUnicode` CMap stream (`begincodespacerange`, `beginbfchar`, `beginbfrange`)
 * into a glyph-to-UTF-8 Unicode lookup structure.
 *
 * @param {string} cmapText - Inflated CMap stream text.
 * @returns {{map: Map<string, string>, codespaces: Array<{byteLength: number, minInt: number, maxInt: number}>, byteLengths: number[]}|null}
 */
function parseToUnicodeCMap(cmapText) {
  const text = String(cmapText || '');
  if (!text) return null;

  const map = new Map();
  const codespaces = [];
  const byteLengthsSet = new Set();

  scanCMapSections(text, 'begincodespacerange', 'endcodespacerange', (section) => {
    const tokens = extractCMapHexTokens(section).filter((t) => t.kind === 'hex');
    for (let i = 0; i + 1 < tokens.length && codespaces.length < 256; i += 2) {
      const lo = tokens[i].value;
      const hi = tokens[i + 1].value;
      const byteLength = Math.max(1, Math.ceil(lo.length / 2));
      const minInt = Number.parseInt(lo, 16);
      const maxInt = Number.parseInt(hi, 16);
      if (Number.isFinite(minInt) && Number.isFinite(maxInt) && minInt <= maxInt && byteLength <= 4) {
        codespaces.push({ byteLength, minInt, maxInt });
        byteLengthsSet.add(byteLength);
      }
    }
  });

  scanCMapSections(text, 'beginbfchar', 'endbfchar', (section) => {
    const tokens = extractCMapHexTokens(section).filter((t) => t.kind === 'hex');
    for (let i = 0; i + 1 < tokens.length && map.size < MAX_CMAP_ENTRIES; i += 2) {
      const srcHex = tokens[i].value.length % 2 === 1 ? `0${tokens[i].value}` : tokens[i].value;
      const dstStr = decodeCMapDestHex(tokens[i + 1].value);
      if (srcHex && dstStr) {
        map.set(srcHex, dstStr);
        byteLengthsSet.add(Math.max(1, srcHex.length / 2));
      }
    }
  });

  scanCMapSections(text, 'beginbfrange', 'endbfrange', (section) => {
    const tokens = extractCMapHexTokens(section);
    let i = 0;
    while (i + 2 < tokens.length && map.size < MAX_CMAP_ENTRIES) {
      const startTok = tokens[i];
      const endTok = tokens[i + 1];
      const dstTok = tokens[i + 2];
      if (startTok.kind !== 'hex' || endTok.kind !== 'hex') {
        i += 1;
        continue;
      }
      const srcWidth = Math.max(2, startTok.value.length % 2 === 1 ? startTok.value.length + 1 : startTok.value.length);
      const startInt = Number.parseInt(startTok.value, 16);
      const endInt = Number.parseInt(endTok.value, 16);
      if (!Number.isFinite(startInt) || !Number.isFinite(endInt) || endInt < startInt || srcWidth > 8) {
        i += 3;
        continue;
      }
      const span = Math.min(endInt - startInt + 1, MAX_BFRANGE_SPAN, MAX_CMAP_ENTRIES - map.size);
      const byteLen = srcWidth / 2;
      if (dstTok.kind === 'hex') {
        for (let offset = 0; offset < span; offset += 1) {
          const srcKey = (startInt + offset).toString(16).toUpperCase().padStart(srcWidth, '0');
          const mapped = incrementCMapDestHex(dstTok.value, offset);
          if (mapped) {
            map.set(srcKey, mapped);
            byteLengthsSet.add(byteLen);
          }
        }
      } else if (dstTok.kind === 'arr') {
        const count = Math.min(span, dstTok.value.length);
        for (let offset = 0; offset < count; offset += 1) {
          const srcKey = (startInt + offset).toString(16).toUpperCase().padStart(srcWidth, '0');
          const mapped = decodeCMapDestHex(dstTok.value[offset]);
          if (mapped) {
            map.set(srcKey, mapped);
            byteLengthsSet.add(byteLen);
          }
        }
      }
      i += 3;
    }
  });

  if (!map.size) return null;
  const byteLengths = [...byteLengthsSet].sort((a, b) => b - a);
  return { map, codespaces, byteLengths };
}

function mergeToUnicodeCMaps(cmaps) {
  const valid = (Array.isArray(cmaps) ? cmaps : []).filter((c) => c && c.map && c.map.size > 0);
  if (!valid.length) return null;
  if (valid.length === 1) return valid[0];
  const map = new Map();
  const codespaces = [];
  const byteLengthsSet = new Set();
  for (const cm of valid) {
    for (const [k, v] of cm.map.entries()) {
      if (!map.has(k) && map.size < MAX_CMAP_ENTRIES) map.set(k, v);
    }
    for (const cs of cm.codespaces || []) {
      if (codespaces.length < 256) codespaces.push(cs);
    }
    for (const bl of cm.byteLengths || []) byteLengthsSet.add(bl);
  }
  return {
    map,
    codespaces,
    byteLengths: [...byteLengthsSet].sort((a, b) => b - a),
  };
}

function decodeBytesWithCMap(bytes, cmap) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (!buf.length || !cmap?.map?.size) return { text: '', hits: 0 };

  const lengths = cmap.byteLengths?.length ? cmap.byteLengths : [2, 1];
  let pos = 0;
  let hits = 0;
  const parts = [];

  while (pos < buf.length) {
    let matched = false;
    for (const len of lengths) {
      if (pos + len > buf.length) continue;
      const slice = buf.subarray(pos, pos + len);
      const key = slice.toString('hex').toUpperCase();
      if (cmap.map.has(key)) {
        parts.push(cmap.map.get(key));
        pos += len;
        hits += 1;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    let step = 1;
    if (cmap.codespaces?.length) {
      for (const cs of cmap.codespaces) {
        if (pos + cs.byteLength <= buf.length) {
          let codeVal = 0;
          for (let b = 0; b < cs.byteLength; b += 1) {
            codeVal = (codeVal << 8) | buf[pos + b];
          }
          if (codeVal >= cs.minInt && codeVal <= cs.maxInt) {
            step = cs.byteLength;
            break;
          }
        }
      }
    }
    if (step === 1 && buf[pos] >= 0x20 && buf[pos] <= 0x7e) {
      parts.push(String.fromCharCode(buf[pos]));
    } else if (step === 2 && buf[pos] === 0 && buf[pos + 1] >= 0x20 && buf[pos + 1] <= 0x7e) {
      parts.push(String.fromCharCode(buf[pos + 1]));
    }
    pos += step;
  }

  return { text: parts.join('').normalize('NFC'), hits };
}

function decodePdfHexString(hexRaw, cmap = null, fallbackCmap = null) {
  const clean = String(hexRaw || '').replace(/\s+/g, '');
  if (!clean) return '';
  const padded = clean.length % 2 === 1 ? `${clean}0` : clean;
  const bytes = Buffer.from(padded, 'hex');
  if (cmap) {
    const res = decodeBytesWithCMap(bytes, cmap);
    if (res.hits > 0) return res.text;
  }
  const hasUtf16Bom = bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff;
  if (!hasUtf16Bom && fallbackCmap) {
    const res = decodeBytesWithCMap(bytes, fallbackCmap);
    if (res.hits > 0) return res.text;
  }
  return decodePdfBytes(bytes);
}

function parsePdfLiteralString(str, startIdx, activeCmap = null) {
  let i = startIdx + 1;
  let depth = 1;
  const bytes = [];
  while (i < str.length && depth > 0) {
    const ch = str[i];
    if (ch === '\\') {
      i += 1;
      if (i >= str.length) break;
      const esc = str[i];
      if (esc === 'n') bytes.push(10);
      else if (esc === 'r') bytes.push(13);
      else if (esc === 't') bytes.push(9);
      else if (esc === 'b') bytes.push(8);
      else if (esc === 'f') bytes.push(12);
      else if (esc === '(' || esc === ')' || esc === '\\') bytes.push(esc.charCodeAt(0));
      else if (esc === '\r') {
        if (str[i + 1] === '\n') i += 1;
      } else if (esc === '\n') {
        // Line continuation: skip newline
      } else if (esc >= '0' && esc <= '7') {
        let oct = esc;
        if (i + 1 < str.length && str[i + 1] >= '0' && str[i + 1] <= '7') {
          oct += str[++i];
          if (i + 1 < str.length && str[i + 1] >= '0' && str[i + 1] <= '7') {
            oct += str[++i];
          }
        }
        bytes.push(Number.parseInt(oct, 8) & 0xff);
      } else {
        bytes.push(esc.charCodeAt(0));
      }
      i += 1;
    } else if (ch === '(') {
      depth += 1;
      bytes.push(40);
      i += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth > 0) bytes.push(41);
      i += 1;
    } else {
      bytes.push(str.charCodeAt(i) & 0xff);
      i += 1;
    }
  }
  if (activeCmap) {
    const cmapRes = decodeBytesWithCMap(bytes, activeCmap);
    if (cmapRes.hits > 0) return { value: cmapRes.text, nextIdx: i };
  }
  return { value: decodePdfBytes(bytes), nextIdx: i };
}

function extractTextFromPdfContentStream(contentStr, { fontCmaps = null, fallbackCmap = null } = {}) {
  const out = [];
  const stack = [];
  let i = 0;
  let lastTmY = null;
  let activeFontName = '';
  const len = contentStr.length;

  const activeCmap = () => (activeFontName && fontCmaps ? fontCmaps.get(activeFontName) || null : null);

  const pushNewline = () => {
    if (out.length && out[out.length - 1] !== '\n') out.push('\n');
  };

  while (i < len) {
    const ch = contentStr[i];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === '\f') {
      i += 1;
      continue;
    }
    if (ch === '%') {
      while (i < len && contentStr[i] !== '\n' && contentStr[i] !== '\r') i += 1;
      continue;
    }
    if (ch === '/') {
      const nameMatch = contentStr.slice(i + 1, i + 80).match(/^[^\s()<>[\]{}/%]+/);
      if (nameMatch) {
        stack.push({ type: 'name', value: nameMatch[0] });
        if (stack.length > 16) stack.shift();
        i += 1 + nameMatch[0].length;
      } else {
        i += 1;
      }
      continue;
    }
    if (ch === '(') {
      const parsed = parsePdfLiteralString(contentStr, i, activeCmap());
      stack.push({ type: 'str', value: parsed.value });
      if (stack.length > 16) stack.shift();
      i = parsed.nextIdx;
      continue;
    }
    if (ch === '<') {
      if (contentStr[i + 1] === '<') {
        i += 2;
        continue;
      }
      const endHex = contentStr.indexOf('>', i + 1);
      if (endHex < 0) break;
      const rawHex = contentStr.slice(i + 1, endHex);
      if (/^[0-9a-fA-F\s]*$/.test(rawHex)) {
        stack.push({ type: 'str', value: decodePdfHexString(rawHex, activeCmap(), fallbackCmap) });
        if (stack.length > 16) stack.shift();
      }
      i = endHex + 1;
      continue;
    }
    if (ch === '>' && contentStr[i + 1] === '>') {
      i += 2;
      continue;
    }
    if (ch === '[') {
      i += 1;
      let joined = '';
      while (i < len && contentStr[i] !== ']') {
        const inner = contentStr[i];
        if (inner === ' ' || inner === '\t' || inner === '\r' || inner === '\n') {
          i += 1;
          continue;
        }
        if (inner === '(') {
          const parsed = parsePdfLiteralString(contentStr, i, activeCmap());
          joined += parsed.value;
          i = parsed.nextIdx;
          continue;
        }
        if (inner === '<') {
          const endHex = contentStr.indexOf('>', i + 1);
          if (endHex < 0) {
            i = len;
            break;
          }
          const rawHex = contentStr.slice(i + 1, endHex);
          if (/^[0-9a-fA-F\s]*$/.test(rawHex)) {
            joined += decodePdfHexString(rawHex, activeCmap(), fallbackCmap);
          }
          i = endHex + 1;
          continue;
        }
        const numMatch = contentStr.slice(i, i + 24).match(/^[+-]?(?:\d+\.?\d*|\.\d+)/);
        if (numMatch) {
          const num = Number(numMatch[0]);
          if (Number.isFinite(num) && num <= -120 && joined && !joined.endsWith(' ')) {
            joined += ' ';
          }
          i += numMatch[0].length;
          continue;
        }
        i += 1;
      }
      if (contentStr[i] === ']') i += 1;
      stack.push({ type: 'arr', value: joined });
      if (stack.length > 16) stack.shift();
      continue;
    }

    if (ch === "'" || ch === '"') {
      const top = stack[stack.length - 1];
      if (top?.type === 'str') {
        pushNewline();
        out.push(top.value);
      }
      stack.length = 0;
      i += 1;
      continue;
    }

    const tokenMatch = contentStr.slice(i, i + 40).match(/^[^\s()<>[\]{}/%]+/);
    if (tokenMatch) {
      const tok = tokenMatch[0];
      if (tok === 'Tf') {
        for (let s = stack.length - 1; s >= 0; s -= 1) {
          if (stack[s]?.type === 'name') {
            activeFontName = stack[s].value;
            break;
          }
        }
        stack.length = 0;
      } else if (tok === 'Tj') {
        const top = stack[stack.length - 1];
        if (top?.type === 'str' && top.value) out.push(top.value);
        stack.length = 0;
      } else if (tok === 'TJ') {
        const top = stack[stack.length - 1];
        if (top?.type === 'arr' && top.value) out.push(top.value);
        stack.length = 0;
      } else if (tok === 'T*' || tok === 'ET' || tok === 'BT') {
        if (tok === 'T*' || tok === 'ET') pushNewline();
        lastTmY = null;
        stack.length = 0;
      } else if (tok === 'Tm') {
        const y = Number(stack[stack.length - 1]?.value);
        if (Number.isFinite(y)) {
          if (lastTmY !== null && Math.abs(y - lastTmY) > 1) pushNewline();
          else if (lastTmY !== null && out.length && !/\s$/.test(out[out.length - 1])) out.push(' ');
          lastTmY = y;
        }
        stack.length = 0;
      } else if (tok === 'Td' || tok === 'TD') {
        const dy = Number(stack[stack.length - 1]?.value);
        const dx = Number(stack[stack.length - 2]?.value);
        if (Number.isFinite(dy) && Math.abs(dy) > 0.1) pushNewline();
        else if (Number.isFinite(dx) && Math.abs(dx) > 5 && out.length && !/\s$/.test(out[out.length - 1])) out.push(' ');
        stack.length = 0;
      } else if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(tok)) {
        stack.push({ type: 'num', value: Number(tok) });
        if (stack.length > 16) stack.shift();
      } else {
        stack.length = 0;
      }
      i += tok.length;
      continue;
    }

    i += 1;
  }

  return out.join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractEnclosingPdfDict(preContext, dictEnd) {
  let depth = 1;
  let pos = dictEnd - 1;
  while (pos >= 1) {
    if (preContext[pos] === '>' && preContext[pos - 1] === '>') {
      depth += 1;
      pos -= 2;
      continue;
    }
    if (preContext[pos] === '<' && preContext[pos - 1] === '<') {
      depth -= 1;
      if (depth === 0) {
        return preContext.slice(pos - 1, dictEnd + 2);
      }
      pos -= 2;
      continue;
    }
    pos -= 1;
  }
  const fallbackStart = preContext.lastIndexOf('<<', dictEnd);
  return fallbackStart >= 0 ? preContext.slice(fallbackStart, dictEnd + 2) : '';
}

function extractPdfDictBlock(body, key) {
  const idx = body.indexOf(key);
  if (idx < 0) return '';
  const openIdx = body.indexOf('<<', idx + key.length);
  if (openIdx < 0 || openIdx - (idx + key.length) > 32) return '';
  let depth = 0;
  let pos = openIdx;
  while (pos + 1 < body.length) {
    if (body[pos] === '<' && body[pos + 1] === '<') {
      depth += 1;
      pos += 2;
      continue;
    }
    if (body[pos] === '>' && body[pos + 1] === '>') {
      depth -= 1;
      pos += 2;
      if (depth === 0) return body.slice(openIdx, pos);
      continue;
    }
    pos += 1;
  }
  return '';
}

function mapPdfPageContents(rawLatin1) {
  const objToPage = new Map();
  const objBodies = new Map();
  const pageFontRefs = [];
  let pageObjectsCount = 0;
  let cursor = 0;
  const objHeaderRe = /\b(\d+)\s+\d+\s+obj\b/g;

  while (cursor < rawLatin1.length) {
    const endobjIdx = rawLatin1.indexOf('endobj', cursor);
    if (endobjIdx < 0) break;
    const windowStart = Math.max(cursor, endobjIdx - 16384);
    const windowSlice = rawLatin1.slice(windowStart, endobjIdx);
    cursor = endobjIdx + 6;

    objHeaderRe.lastIndex = 0;
    let lastObjMatch = null;
    let m;
    while ((m = objHeaderRe.exec(windowSlice)) !== null) {
      lastObjMatch = m;
    }
    const objId = lastObjMatch ? Number(lastObjMatch[1]) : null;
    const body = lastObjMatch ? windowSlice.slice(lastObjMatch.index + lastObjMatch[0].length) : windowSlice;
    if (objId != null && !body.includes('stream')) {
      objBodies.set(objId, body);
    }

    if (!windowSlice.includes('/Page') || !/\/Type\s*\/Page\b(?!s)/.test(body)) continue;

    pageObjectsCount += 1;
    if (pageObjectsCount > MAX_PDF_PAGE_COUNT) break;

    const contentIds = [];
    const single = body.match(/\/Contents\s+(\d+)\s+\d+\s+R/);
    if (single) {
      const cid = Number(single[1]);
      objToPage.set(cid, pageObjectsCount);
      contentIds.push(cid);
    } else {
      const arr = body.match(/\/Contents\s*\[([^\]]+)\]/);
      if (arr) {
        for (const ref of arr[1].matchAll(/(\d+)\s+\d+\s+R/g)) {
          const cid = Number(ref[1]);
          objToPage.set(cid, pageObjectsCount);
          contentIds.push(cid);
        }
      }
    }

    const resInline = extractPdfDictBlock(body, '/Resources');
    const resRefMatch = body.match(/\/Resources\s+(\d+)\s+\d+\s+R/);
    pageFontRefs.push({
      contentIds,
      resInline,
      resRefObjId: resRefMatch ? Number(resRefMatch[1]) : null,
    });
  }

  const fontToUnicodeObj = new Map();
  const toUnicodeStreamIds = new Set();
  for (const [objId, body] of objBodies.entries()) {
    const tuMatch = body.match(/\/ToUnicode\s+(\d+)\s+\d+\s+R/);
    if (tuMatch) {
      const tuObjId = Number(tuMatch[1]);
      fontToUnicodeObj.set(objId, tuObjId);
      toUnicodeStreamIds.add(tuObjId);
    }
  }

  const contentToFontMappings = new Map();
  for (const pageRef of pageFontRefs) {
    const resDict = pageRef.resInline || (pageRef.resRefObjId != null ? (objBodies.get(pageRef.resRefObjId) || '') : '');
    if (!resDict) continue;
    const fontInline = extractPdfDictBlock(resDict, '/Font');
    const fontRefMatch = !fontInline ? resDict.match(/\/Font\s+(\d+)\s+\d+\s+R/) : null;
    const fontDict = fontInline || (fontRefMatch ? (objBodies.get(Number(fontRefMatch[1])) || '') : '');
    if (!fontDict) continue;

    const fontMap = new Map();
    for (const fm of fontDict.matchAll(/\/([^\s()<>[\]{}/%]+)\s+(\d+)\s+\d+\s+R/g)) {
      const fontName = fm[1];
      const fontObjId = Number(fm[2]);
      const tuObjId = fontToUnicodeObj.get(fontObjId);
      if (tuObjId != null) {
        fontMap.set(fontName, tuObjId);
      }
    }
    if (fontMap.size) {
      for (const cid of pageRef.contentIds) {
        contentToFontMappings.set(cid, fontMap);
      }
    }
  }

  const pagesCountMatches = [...rawLatin1.matchAll(/\/Type\s*\/Pages\b[\s\S]{0,400}?\/Count\s+(\d+)/g)];
  const pagesCountHint = pagesCountMatches.reduce(
    (max, m) => Math.max(max, Math.min(MAX_PDF_PAGE_COUNT, Number(m[1]) || 0)),
    0,
  );
  return {
    objToPage,
    toUnicodeStreamIds,
    contentToFontMappings,
    detectedPageCount: Math.min(MAX_PDF_PAGE_COUNT, Math.max(pageObjectsCount, pagesCountHint, 1)),
  };
}

/**
 * Extract plain text and page count from a PDF buffer without executing scripts.
 *
 * @param {Buffer|Uint8Array} buffer - Raw PDF binary buffer.
 * @param {object} [options]
 * @param {number} [options.maxInflatedBytes=10485760] - Cumulative FlateDecode stream budget.
 * @returns {{text: string, pageCount: number, corruptStreams: number}}
 */
function extractPdfText(buffer, { maxInflatedBytes = MAX_INFLATED_BYTES } = {}) {
  const buf = toBuffer(buffer);
  const head = buf.subarray(0, Math.min(buf.length, 1024)).toString('latin1');
  if (!head.includes('%PDF-')) {
    throw failExtract('PDF_INVALID_DOCUMENT', 400, 'Tệp tải lên không có chữ ký PDF (%PDF-) hợp lệ.');
  }

  const raw = buf.toString('latin1');
  const {
    objToPage,
    toUnicodeStreamIds,
    contentToFontMappings,
    detectedPageCount,
  } = mapPdfPageContents(raw);
  const pageTexts = new Map();
  const unmappedTexts = [];
  const streams = [];
  const cmapByObjId = new Map();
  const allCmaps = [];
  let totalInflatedBytes = 0;
  let corruptStreams = 0;
  let cursor = 0;

  while (cursor < raw.length) {
    const streamIdx = raw.indexOf('stream', cursor);
    if (streamIdx < 0) break;

    const afterKw = raw.slice(streamIdx + 6, streamIdx + 8);
    let dataStart = -1;
    if (afterKw === '\r\n') dataStart = streamIdx + 8;
    else if (afterKw[0] === '\n' || afterKw[0] === '\r') dataStart = streamIdx + 7;

    const preContext = raw.slice(Math.max(0, streamIdx - 2048), streamIdx);
    const dictEnd = preContext.lastIndexOf('>>');
    const isStreamHeader = dataStart > 0 && dictEnd >= 0 && preContext.slice(dictEnd + 2).trim() === '';
    if (!isStreamHeader) {
      cursor = streamIdx + 6;
      continue;
    }

    const dictStr = extractEnclosingPdfDict(preContext, dictEnd);
    const objHeaderMatches = [...preContext.matchAll(/(\d+)\s+\d+\s+obj\b/g)];
    const objId = objHeaderMatches.length ? Number(objHeaderMatches[objHeaderMatches.length - 1][1]) : null;

    let dataEnd = -1;
    let nextCursor = -1;
    const lenMatch = dictStr.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/);
    if (lenMatch) {
      const declaredLen = Number(lenMatch[1]);
      if (declaredLen > maxInflatedBytes) {
        throw failExtract('PDF_STREAM_TOO_LARGE', 400, 'Kích thước luồng PDF vượt quá giới hạn an toàn 10MB.');
      }
      const candidateEnd = dataStart + declaredLen;
      if (candidateEnd <= buf.length) {
        const tail = raw.slice(candidateEnd, candidateEnd + 16);
        const endMatch = tail.match(/^(?:\r\n|\n|\r)?endstream/);
        if (endMatch) {
          dataEnd = candidateEnd;
          nextCursor = candidateEnd + endMatch[0].length;
        }
      }
    }

    if (dataEnd < 0) {
      const endIdx = raw.indexOf('endstream', dataStart);
      if (endIdx < 0) break;
      dataEnd = endIdx;
      if (raw[dataEnd - 1] === '\n') dataEnd -= 1;
      if (raw[dataEnd - 1] === '\r') dataEnd -= 1;
      nextCursor = endIdx + 9;
    }

    cursor = Math.max(nextCursor, streamIdx + 6);

    if (/\/Subtype\s*\/(?:Image|XML)\b|\/Type\s*\/(?:ObjStm|XRef|Metadata)\b/i.test(dictStr)) {
      continue;
    }
    if (/\/Filter\s*(?:\[[^\]]*)?\/(?:DCTDecode|JPXDecode|JBIG2Decode|CCITTFaxDecode)\b/.test(dictStr)) {
      continue;
    }

    const rawSlice = buf.subarray(dataStart, Math.max(dataStart, dataEnd));
    if (rawSlice.length > maxInflatedBytes) {
      throw failExtract('PDF_STREAM_TOO_LARGE', 400, 'Kích thước luồng PDF vượt quá giới hạn 10MB.');
    }

    let decodedBuf = rawSlice;
    const isFlate = /\/Filter\s*(?:\[[^\]]*)?\/FlateDecode\b/.test(dictStr);
    if (isFlate) {
      const remaining = maxInflatedBytes - totalInflatedBytes;
      if (remaining <= 0) {
        throw failExtract('PDF_STREAM_TOO_LARGE', 400, 'Tổng dung lượng luồng PDF giải nén vượt quá 10MB.');
      }
      try {
        decodedBuf = zlib.inflateSync(rawSlice, { maxOutputLength: remaining });
      } catch (err) {
        if (err?.code === 'ERR_BUFFER_TOO_LARGE') {
          throw failExtract('PDF_STREAM_TOO_LARGE', 400, 'Luồng PDF giải nén vượt quá giới hạn 10MB.');
        }
        corruptStreams += 1;
        continue;
      }
      totalInflatedBytes += decodedBuf.length;
    }

    const contentStr = decodedBuf.toString('latin1');
    const isCmapStream = (objId != null && toUnicodeStreamIds.has(objId))
      || (contentStr.includes('begincmap') && (contentStr.includes('beginbfchar') || contentStr.includes('beginbfrange')));
    if (isCmapStream) {
      const parsedCmap = parseToUnicodeCMap(contentStr);
      if (parsedCmap) {
        if (objId != null) cmapByObjId.set(objId, parsedCmap);
        allCmaps.push(parsedCmap);
      }
      continue;
    }

    streams.push({ objId, contentStr });
  }

  const fallbackCmap = mergeToUnicodeCMaps(allCmaps);
  for (const { objId, contentStr } of streams) {
    let fontCmaps = null;
    if (objId != null && contentToFontMappings.has(objId)) {
      fontCmaps = new Map();
      for (const [fontName, tuObjId] of contentToFontMappings.get(objId).entries()) {
        const cm = cmapByObjId.get(tuObjId);
        if (cm) fontCmaps.set(fontName, cm);
      }
    }

    const extracted = extractTextFromPdfContentStream(contentStr, { fontCmaps, fallbackCmap });
    if (!extracted) continue;

    const mappedPage = objId != null ? objToPage.get(objId) : null;
    if (mappedPage) {
      const prev = pageTexts.get(mappedPage) || [];
      prev.push(extracted);
      pageTexts.set(mappedPage, prev);
    } else {
      unmappedTexts.push(extracted);
    }
  }

  let text = '';
  if (pageTexts.size > 0) {
    const orderedPages = [...pageTexts.keys()]
      .sort((a, b) => a - b)
      .map((p) => (pageTexts.get(p) || []).join('\n'))
      .filter(Boolean);
    if (unmappedTexts.length) {
      orderedPages.push(unmappedTexts.join('\n'));
    }
    text = orderedPages.join('\f').trim();
  } else {
    text = unmappedTexts.join('\n\n').trim();
  }

  return {
    text,
    pageCount: Math.min(MAX_PDF_PAGE_COUNT, Math.max(detectedPageCount, pageTexts.size, 1)),
    corruptStreams,
  };
}

/**
 * Dispatch a document buffer to the appropriate extractor (PDF, DOCX, XLSX, PPTX, or UTF-8 text/CSV/JSON/XML).
 *
 * @param {Buffer|Uint8Array} buffer - Raw uploaded file buffer.
 * @param {object} [options]
 * @param {string} [options.filename=''] - Original filename hint.
 * @param {string} [options.mimeType=''] - MIME content type hint.
 * @returns {{text: string, format: string, pageCount: number, sheets?: Array, slides?: Array}}
 */
function extractTextFromBuffer(buffer, { filename = '', mimeType = '' } = {}) {
  const buf = toBuffer(buffer);
  if (buf.length === 0) {
    throw failExtract('ATTACHMENT_EMPTY', 400, 'Tệp đính kèm rỗng.');
  }

  const lowerName = String(filename || '').trim().toLowerCase();
  const baseMime = String(mimeType || '').trim().toLowerCase().split(';')[0].trim();
  const head = buf.subarray(0, Math.min(buf.length, 64));
  const headLatin = head.toString('latin1');

  const looksPdf = lowerName.endsWith('.pdf')
    || baseMime === 'application/pdf'
    || headLatin.startsWith('%PDF-');
  if (looksPdf) {
    const pdfRes = extractPdfText(buf);
    return {
      text: pdfRes.text,
      format: 'pdf',
      pageCount: pdfRes.pageCount,
    };
  }

  const isXlsxHint = lowerName.endsWith('.xlsx')
    || baseMime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const isPptxHint = lowerName.endsWith('.pptx')
    || baseMime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  const isDocxHint = lowerName.endsWith('.docx')
    || baseMime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  if (isXlsxHint) return extractXlsxText(buf);
  if (isPptxHint) return extractPptxText(buf);
  if (isDocxHint) {
    const docxText = extractDocxText(buf);
    const pageCount = docxText ? Math.max(1, docxText.split('\f').length) : 1;
    return { text: docxText, format: 'docx', pageCount };
  }

  const looksZip = buf.length >= 4 && buf.readUInt32LE(0) === ZIP_LOCAL_SIG;
  if (looksZip) {
    const entries = listArchiveEntries(buf);
    assertArchiveNotEncrypted(entries);
    if (entries.some((e) => e.name.toLowerCase() === 'xl/workbook.xml' || /^xl\/worksheets\/[^/]+\.xml$/i.test(e.name))) {
      return extractXlsxText(buf);
    }
    if (entries.some((e) => e.name.toLowerCase() === 'ppt/presentation.xml' || /^ppt\/slides\/slide\d+\.xml$/i.test(e.name))) {
      return extractPptxText(buf);
    }
    if (entries.some((e) => e.name.toLowerCase() === 'word/document.xml')) {
      const docxText = extractDocxText(buf);
      const pageCount = docxText ? Math.max(1, docxText.split('\f').length) : 1;
      return { text: docxText, format: 'docx', pageCount };
    }
  }

  const isCsvExt = lowerName.endsWith('.csv');
  const isXmlExt = lowerName.endsWith('.xml');
  const allowedTextExt = !lowerName || /\.(txt|md|markdown|json|csv|log|yml|yaml|xml|html?)$/.test(lowerName);
  const allowedTextMime = !baseMime
    || baseMime.startsWith('text/')
    || baseMime === 'application/json'
    || (isCsvExt && (
      baseMime === 'application/csv'
      || baseMime === 'application/vnd.ms-excel'
      || baseMime === 'application/octet-stream'
    ))
    || (isXmlExt && (
      baseMime === 'application/xml'
      || baseMime === 'application/octet-stream'
    ));
  if (!allowedTextExt || !allowedTextMime || buf.includes(0)) {
    throw failExtract('UNSUPPORTED_ATTACHMENT_FORMAT', 400, 'Định dạng tệp đính kèm chưa được hỗ trợ (hỗ trợ PDF, DOCX, XLSX, PPTX, CSV, Markdown, TXT, JSON).');
  }

  const rawText = buf.toString('utf8').replace(/\r\n/g, '\n').trim();
  let format = 'text';
  if (lowerName.endsWith('.md') || lowerName.endsWith('.markdown') || baseMime === 'text/markdown') {
    format = 'markdown';
  } else if (lowerName.endsWith('.json') || baseMime === 'application/json') {
    format = 'json';
  } else if (isCsvExt || baseMime === 'text/csv' || baseMime === 'application/csv') {
    format = 'csv';
  }
  return {
    text: rawText,
    format,
    pageCount: Math.max(1, rawText.split('\f').length),
  };
}

function estimateTokenCount(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  return words.length;
}

function tailOverlapSlice(text, overlap) {
  if (!text || overlap <= 0) return '';
  if (text.length <= overlap) return text;
  const rawTail = text.slice(text.length - overlap);
  const spaceIdx = rawTail.indexOf(' ');
  if (spaceIdx > 0 && spaceIdx < rawTail.length - 1) {
    return rawTail.slice(spaceIdx + 1).trim();
  }
  return rawTail.trim();
}

function splitLongBlock(text, chunkSize, overlap) {
  const pieces = [];
  const clean = String(text || '').trim();
  if (!clean) return pieces;
  if (clean.length <= chunkSize) return [clean];

  let start = 0;
  const safeOverlap = Math.min(chunkSize - 1, Math.max(0, overlap));
  while (start < clean.length) {
    let end = Math.min(clean.length, start + chunkSize);
    if (end < clean.length) {
      const lastSpace = clean.lastIndexOf(' ', end);
      if (lastSpace > start + Math.floor(chunkSize * 0.4)) {
        end = lastSpace;
      }
    }
    const piece = clean.slice(start, end).trim();
    if (piece) pieces.push(piece);
    if (end >= clean.length) break;
    const nextStart = Math.max(start + 1, end - safeOverlap);
    const aligned = clean.indexOf(' ', nextStart);
    start = aligned > nextStart && aligned < end ? aligned + 1 : nextStart;
  }
  return pieces;
}

/**
 * Split extracted document text into overlapping page/heading-aware chunks for indexing.
 *
 * @param {string} text - Normalized document text (using `\f` for page breaks).
 * @param {object} [options]
 * @param {number} [options.chunkSize=800] - Maximum character length per chunk.
 * @param {number} [options.overlap=120] - Target character overlap between adjacent chunks.
 * @param {string} [options.title=''] - Default section title when no heading is present.
 * @returns {Array<{chunkIndex: number, sectionTitle: string, pageNumber: number, content: string, tokenCount: number}>}
 */
function chunkDocumentText(text, { chunkSize = 800, overlap = 120, title = '' } = {}) {
  const raw = String(text || '');
  if (!raw.trim()) return [];

  const safeChunkSize = Math.max(20, Number(chunkSize) || 800);
  const safeOverlap = Math.max(0, Math.min(Math.floor(safeChunkSize * 0.8), Number(overlap ?? 120) || 0));
  const pages = raw.split('\f');
  const chunks = [];
  let currentSection = String(title || '').trim();

  const pushChunk = (content, sectionTitle, pageNumber) => {
    const clean = String(content || '').replace(/\f/g, '').trim();
    if (!clean) return;
    chunks.push({
      chunkIndex: chunks.length,
      sectionTitle: sectionTitle || String(title || '').trim(),
      pageNumber,
      content: clean,
      tokenCount: estimateTokenCount(clean),
    });
  };

  for (let pIdx = 0; pIdx < pages.length; pIdx += 1) {
    const pageNumber = pIdx + 1;
    const pageText = pages[pIdx].replace(/\r\n/g, '\n').trim();
    if (!pageText) continue;

    // Group lines into logical blocks, breaking whenever a markdown heading (#) starts
    const lines = pageText.split('\n');
    const blocks = [];
    let accLines = [];
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (/^#{1,6}\s+.+$/.test(trimmedLine)) {
        if (accLines.length) {
          blocks.push({ kind: 'text', value: accLines.join('\n').trim() });
          accLines = [];
        }
        blocks.push({ kind: 'heading', value: trimmedLine });
      } else if (!trimmedLine) {
        if (accLines.length) {
          blocks.push({ kind: 'text', value: accLines.join('\n').trim() });
          accLines = [];
        }
      } else {
        accLines.push(trimmedLine);
      }
    }
    if (accLines.length) {
      blocks.push({ kind: 'text', value: accLines.join('\n').trim() });
    }

    let buffer = '';
    for (const block of blocks) {
      if (block.kind === 'heading') {
        if (buffer) {
          pushChunk(buffer, currentSection, pageNumber);
          buffer = '';
        }
        currentSection = block.value.replace(/^#{1,6}\s+/, '').trim().slice(0, 240);
        buffer = block.value;
        continue;
      }

      const pieces = splitLongBlock(block.value, safeChunkSize, safeOverlap);
      for (const piece of pieces) {
        if (!buffer) {
          buffer = piece;
        } else if (buffer.length + 2 + piece.length <= safeChunkSize) {
          buffer = `${buffer}\n\n${piece}`;
        } else {
          pushChunk(buffer, currentSection, pageNumber);
          const overlapPrefix = tailOverlapSlice(buffer, safeOverlap);
          if (overlapPrefix && overlapPrefix.length + 2 + piece.length <= safeChunkSize) {
            buffer = `${overlapPrefix}\n\n${piece}`;
          } else {
            buffer = piece;
          }
        }
      }
    }
    if (buffer) {
      pushChunk(buffer, currentSection, pageNumber);
    }
  }

  return chunks;
}

function addWarning(warnings, code) {
  if (Array.isArray(warnings) && code && !warnings.includes(code)) {
    warnings.push(code);
  }
}

function sanitizeExtractedString(raw, {
  maxLen = MAX_EXTRACTED_FIELD_LEN,
  allowNegativeRange = false,
  warnings = null,
} = {}) {
  let clean = String(raw ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return '';

  const isSafeTempRange = allowNegativeRange
    && /^-\d+(?:\.\d+)?(?:\s*(?:\.\.|~|đến|to|-)\s*[+-]?\d+(?:\.\d+)?|\s*°?\s*C\b)/i.test(clean);

  if (!isSafeTempRange) {
    while (/^[=+\-@]/.test(clean)) {
      addWarning(warnings, 'FORMULA_PREFIX_SANITIZED');
      clean = clean.replace(/^[=+\-@]+/, '').trim();
    }
  } else if (/^[=+@]/.test(clean)) {
    addWarning(warnings, 'FORMULA_PREFIX_SANITIZED');
    clean = clean.replace(/^[=+@]+/, '').trim();
  }

  return clean.slice(0, maxLen).trim();
}

function defineSafeField(target, key, value) {
  if (!key || key === '__proto__' || key === 'constructor' || key === 'prototype') return;
  if (value === undefined || value === null || value === '') return;
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function normalizeDateToken(raw) {
  const s = String(raw || '').trim();
  let year;
  let month;
  let day;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    year = Number(m[1]);
    month = Number(m[2]);
    day = Number(m[3]);
  } else {
    m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (!m) return null;
    day = Number(m[1]);
    month = Number(m[2]);
    year = Number(m[3]);
  }
  if (year < 1970 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    return null;
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parsePositiveNumber(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const normalized = /^\d{1,3}(?:,\d{3})+$/.test(s)
    ? s.replace(/,/g, '')
    : s.replace(/,/g, '.');
  const num = Number(normalized);
  if (!Number.isFinite(num) || num <= 0) return null;
  return num;
}

function extractLabeledValue(lines, labelPattern, warnings, maxLen = MAX_EXTRACTED_FIELD_LEN) {
  const re = new RegExp(`(?:^|[;\\t|] *)(?:${labelPattern}) *(?:[:=][\\t| ]*|[\\t|][\\t| ]*)([^\\r\\n\\t| ][^\\r\\n\\t|]*)`, 'i');
  for (const line of lines) {
    const m = line.match(re);
    if (m && m[1]) {
      const cleaned = sanitizeExtractedString(m[1], { maxLen, warnings });
      if (cleaned) return cleaned;
    }
  }
  return '';
}

function extractTemperatureMetadata(text, warnings) {
  const out = {};
  const labelMatch = text.match(/(?:^|[\n\t|] *)(?:Nhiệt[ \t]*độ(?:[ \t]*yêu[ \t]*cầu|[ \t]*bảo[ \t]*quản)?|Temperature(?:[ \t]*Range|[ \t]*Bounds)?|Temp) *(?:[:=][\t| ]*|[\t|][\t| ]*)([^\r\n\t| ][^\r\n\t|]*)/i);
  if (labelMatch && labelMatch[1]) {
    const cleaned = sanitizeExtractedString(labelMatch[1], {
      maxLen: 80,
      allowNegativeRange: true,
      warnings,
    });
    if (cleaned) out.temperatureRequirement = cleaned;
  }

  const rangeRe = /(?<![\d/-])([+-]?\d+(?:\.\d+)?)[ \t]*(?:\.\.|~|đến|to|-)[ \t]*([+-]?\d+(?:\.\d+)?)(?:[ \t]*°?[ \t]*C\b|\b)/i;
  const rangeSource = out.temperatureRequirement || text;
  const rm = rangeSource.match(rangeRe) || text.match(rangeRe);
  if (rm) {
    const a = Number(rm[1]);
    const b = Number(rm[2]);
    if (Number.isFinite(a) && Number.isFinite(b) && a >= -100 && b <= 100 && a <= b) {
      out.targetTempMinC = a;
      out.targetTempMaxC = b;
      if (!out.temperatureRequirement) {
        out.temperatureRequirement = `${a}..${b} °C`;
      }
    }
  }

  const mktMatch = text.match(/\bMKT\b[ :=|\t]+([+-]?\d+(?:\.\d+)?)(?:[ \t]*°?[ \t]*C\b|\b)/i);
  if (mktMatch) {
    const mkt = Number(mktMatch[1]);
    if (Number.isFinite(mkt) && mkt >= -100 && mkt <= 100) {
      out.mktCelsius = mkt;
    }
  }

  return out;
}

function parseLineItemsFromText(lines, warnings) {
  const items = [];
  const seenKey = new Set();
  const unitRe = /(\d+(?:[.,]\d+)?)[ \t]*(hộp|thùng|lọ|chai|kiện|pallet|kg|lít|ml|pcs|box(?:es)?|units?|vials?)\b/i;
  const labeledQtyRe = /(?:SL|Số[ \t]*lượng|Qty|Quantity)[ :=|\t]+(\d+(?:[.,]\d+)?)/i;
  const skuTokenRe = /\b(SKU[-_][A-Z0-9][A-Z0-9_-]{0,40})\b/i;
  const labeledSkuRe = /(?:Mã[ \t]*(?:hàng|SKU)|SKU) *(?:[:=][\t| ]*|[\t|][\t| ]*)([A-Za-z0-9][A-Za-z0-9_.-]{1,40})/i;

  for (const rawLine of lines) {
    if (items.length >= 100) break;
    const line = rawLine.trim();
    if (!line || /^#{1,6}\s/.test(line)) continue;

    let sku = '';
    const tokenMatch = line.match(skuTokenRe);
    if (tokenMatch) {
      sku = sanitizeExtractedString(tokenMatch[1], { maxLen: 64, warnings }).toUpperCase();
    } else {
      const lblMatch = line.match(labeledSkuRe);
      if (lblMatch) {
        const candidate = sanitizeExtractedString(lblMatch[1], { maxLen: 64, warnings });
        if (candidate && !/^(tên|product|qty|số|hạn|expiry)$/i.test(candidate)) {
          sku = candidate;
        }
      }
    }
    if (!sku) continue;

    const cells = line.split(/\t|\|/).map((c) => c.trim()).filter(Boolean);
    let lotCode = '';
    const lotMatch = line.match(/\b(LOT-[A-Z0-9][A-Z0-9_-]{1,40})\b/);
    if (lotMatch) {
      lotCode = sanitizeExtractedString(lotMatch[1], { maxLen: 64, warnings });
    }

    let expiryDate = null;
    const dateMatches = [...line.matchAll(/\b(\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{4})\b/g)];
    for (const dm of dateMatches) {
      const normalized = normalizeDateToken(dm[1]);
      if (normalized) {
        expiryDate = normalized;
        break;
      }
    }

    let quantity = null;
    let unit = '';
    const lblQtyMatch = line.match(labeledQtyRe);
    if (lblQtyMatch) {
      quantity = parsePositiveNumber(lblQtyMatch[1]);
    }
    const uMatch = line.match(unitRe);
    if (uMatch) {
      if (quantity == null) quantity = parsePositiveNumber(uMatch[1]);
      unit = sanitizeExtractedString(uMatch[2], { maxLen: 24, warnings });
    }
    if (quantity == null && cells.length > 1) {
      for (let idx = 0; idx < cells.length; idx += 1) {
        const cell = cells[idx];
        if (cell.includes(sku) || (lotCode && cell.includes(lotCode))) continue;
        if (normalizeDateToken(cell)) continue;
        if (idx === 0 && /^\d{1,2}$/.test(cell) && cells.length >= 3) continue;
        const numMatch = cell.match(/^(\d+(?:[.,]\d+)?)(?:\s+([A-Za-zÀ-ỹ]{1,20}))?$/);
        if (numMatch) {
          quantity = parsePositiveNumber(numMatch[1]);
          if (numMatch[2] && !unit) unit = sanitizeExtractedString(numMatch[2], { maxLen: 24, warnings });
          if (quantity != null) break;
        }
      }
    }

    let productName = '';
    for (const cell of cells) {
      if (cell.includes(sku)) continue;
      if (lotCode && cell.includes(lotCode)) continue;
      if (normalizeDateToken(cell)) continue;
      if (/^\d+(?:[.,]\d+)?(?:\s+[A-Za-zÀ-ỹ]{1,20})?$/.test(cell)) continue;
      if (/^[+-]?\d+(?:\.\d+)?\s*(?:\.\.|~|-)\s*[+-]?\d+/.test(cell)) continue;
      if (/^(?:SKU|Mã\s*SKU|SL|Số\s*lượng|HSD|Hạn\s*dùng)\s*[:=]?/i.test(cell)) continue;
      const cleaned = sanitizeExtractedString(cell, { maxLen: 160, warnings });
      if (cleaned && cleaned.length >= 2) {
        productName = cleaned;
        break;
      }
    }

    const dedupeKey = `${sku}|${lotCode}|${expiryDate || ''}|${quantity ?? ''}`;
    if (seenKey.has(dedupeKey)) continue;
    seenKey.add(dedupeKey);

    const item = {};
    defineSafeField(item, 'sku', sku);
    if (productName) defineSafeField(item, 'productName', productName);
    if (quantity != null) defineSafeField(item, 'quantity', quantity);
    if (unit) defineSafeField(item, 'unit', unit);
    if (expiryDate) defineSafeField(item, 'expiryDate', expiryDate);
    if (lotCode) defineSafeField(item, 'lotCode', lotCode);
    items.push(item);
  }
  return items;
}

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

const CSV_HEADER_ALIASES = new Map([
  ['code', 'Order Code'],
  ['ordercode', 'Order Code'],
  ['order_code', 'Order Code'],
  ['madon', 'Mã đơn'],
  ['requestcode', 'Request Code'],
  ['lotcode', 'Lot Code'],
  ['lot_code', 'Lot Code'],
  ['malo', 'Mã lô'],
  ['customer', 'Customer'],
  ['khachhang', 'Khách hàng'],
  ['supplier', 'Supplier'],
  ['vendor', 'Vendor'],
  ['nhacungcap', 'Nhà cung cấp'],
  ['origin', 'Origin'],
  ['diemdi', 'Điểm đi'],
  ['destination', 'Destination'],
  ['diemden', 'Điểm đến'],
  ['name', 'Title'],
  ['title', 'Title'],
  ['tieude', 'Tiêu đề'],
  ['category', 'Category'],
  ['priority', 'Priority'],
  ['servicetype', 'Service Type'],
  ['service_type', 'Service Type'],
  ['description', 'Description'],
  ['notes', 'Notes'],
  ['sku', 'SKU'],
  ['productname', 'Product Name'],
  ['product_name', 'Product Name'],
  ['quantity', 'Quantity'],
  ['qty', 'Qty'],
  ['soluong', 'Số lượng'],
  ['sl', 'SL'],
  ['unit', 'Unit'],
  ['expirydate', 'Expiry Date'],
  ['expiry_date', 'Expiry Date'],
  ['expiry', 'Expiry'],
  ['hsd', 'HSD'],
  ['temperature', 'Temperature'],
  ['temp', 'Temp'],
  ['nhietdo', 'Nhiệt độ'],
]);

function normalizeCsvKey(raw) {
  return String(raw || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '');
}

const CSV_LINE_ITEM_HEADERS = new Set(['SKU', 'Product Name', 'Quantity', 'Qty', 'Số lượng', 'SL', 'Unit', 'Expiry Date', 'Expiry', 'HSD', 'Lot Code', 'Mã lô']);

function expandCsvStructuredLines(lines, isCsvFormat) {
  const expanded = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.includes(',') || line.includes('\t') || line.includes('|')) {
      expanded.push(line);
      continue;
    }
    const cells = splitCsvLine(line);
    if (cells.length < 2) {
      expanded.push(line);
      continue;
    }
    const mappedHeaders = cells.map((c) => CSV_HEADER_ALIASES.get(normalizeCsvKey(c)) || null);
    const recognizedCount = mappedHeaders.filter(Boolean).length;
    if (recognizedCount >= 2 && recognizedCount >= Math.ceil(cells.length / 2)) {
      let j = i + 1;
      while (j < lines.length && lines[j].trim()) {
        const dataCells = splitCsvLine(lines[j]);
        if (dataCells.length < 2) break;
        const rowPairs = [];
        const itemCells = [];
        for (let col = 0; col < mappedHeaders.length && col < dataCells.length; col += 1) {
          const header = mappedHeaders[col];
          const val = dataCells[col];
          if (!header || !val) continue;
          if (CSV_LINE_ITEM_HEADERS.has(header)) {
            if (header === 'SKU') {
              itemCells.push(/^SKU[-_]/i.test(val) ? val : `SKU: ${val}`);
            } else if (header === 'Quantity' || header === 'Qty' || header === 'Số lượng' || header === 'SL') {
              itemCells.push(`Qty: ${val}`);
            } else {
              itemCells.push(val);
            }
          }
          if (!CSV_LINE_ITEM_HEADERS.has(header) || header === 'Lot Code' || header === 'Mã lô') {
            rowPairs.push(`${header}: ${val}`);
          }
        }
        if (j === i + 1 && rowPairs.length) {
          expanded.push(...rowPairs);
        }
        if (itemCells.length) {
          expanded.push(itemCells.join('\t'));
        } else if (!rowPairs.length) {
          expanded.push(dataCells.join('\t'));
        }
        j += 1;
      }
      i = j - 1;
      continue;
    }
    const firstMapped = CSV_HEADER_ALIASES.get(normalizeCsvKey(cells[0]));
    if (firstMapped && cells.length === 2) {
      expanded.push(`${firstMapped}: ${cells[1]}`);
      continue;
    }
    if (isCsvFormat || /\b(?:SKU[-_][A-Z0-9]|ORD-|REQ-|PO-|LOT-|TKT-)/i.test(line)) {
      expanded.push(cells.join('\t'));
      continue;
    }
    expanded.push(line);
  }
  return expanded;
}

/**
 * Deterministically parse bilingual (VI/EN) form fields, cold-chain bounds, and line items from extracted text.
 *
 * @param {string} text - Raw or OCR-extracted document text.
 * @param {object} [options]
 * @param {string} [options.targetCollection='latticeOrders'] - Target collection allowlist entry.
 * @param {object|null} [options.ocrMetadata=null] - Format and OCR engine metadata.
 * @returns {{targetCollection: string, fields: Record<string, any>, lineItems: Array<Record<string, any>>, confidence: number, warnings: string[]}}
 */
function extractStructuredFormFields(text, { targetCollection = 'latticeOrders', ocrMetadata = null } = {}) {
  const safeTarget = String(targetCollection || 'latticeOrders').trim();
  if (!ALLOWED_FORM_COLLECTIONS.has(safeTarget)) {
    throw failExtract('INVALID_TARGET_COLLECTION', 400, 'Bảng đích auto-fill không hợp lệ.');
  }

  const warnings = [];
  if (ocrMetadata && typeof ocrMetadata === 'object' && ocrMetadata.ocrEngine === 'offline-deterministic-fallback') {
    addWarning(warnings, 'OCR_FALLBACK_USED');
  }

  const normalizedText = String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\f/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');

  const isCsvFormat = Boolean(ocrMetadata && typeof ocrMetadata === 'object' && ocrMetadata.format === 'csv');
  const lines = expandCsvStructuredLines(normalizedText.split('\n'), isCsvFormat);
  const effectiveText = lines.join('\n');
  const fields = {};

  const codePriorityByCollection = {
    latticeOrders: ['ORD', 'PO', 'REQ', 'LOT', 'TKT'],
    latticeRequests: ['REQ', 'ORD', 'PO', 'TKT', 'LOT'],
    latticeStockLots: ['LOT', 'ORD', 'PO', 'REQ', 'TKT'],
    latticeServiceTickets: ['TKT', 'REQ', 'ORD', 'PO', 'LOT'],
  };
  const foundCodes = {};
  for (const m of effectiveText.matchAll(/\b(ORD|REQ|PO|LOT|TKT)-[A-Z0-9][A-Z0-9_-]{1,48}\b/g)) {
    const prefix = m[1];
    if (!foundCodes[prefix]) {
      foundCodes[prefix] = sanitizeExtractedString(m[0], { maxLen: 64, warnings });
    }
  }

  const explicitCode = extractLabeledValue(
    lines,
    'Mã\\s*(?:đơn(?:\\s*hàng)?|phiếu|yêu\\s*cầu|lô)|Order\\s*(?:Code|No\\.?|ID)|Request\\s*(?:Code|No\\.?|ID)|PO\\s*(?:No\\.?|Number|Code)|Lot\\s*(?:Code|No\\.?)|Ticket\\s*(?:Code|No\\.?)',
    warnings,
    64,
  );

  let primaryCode = '';
  for (const prefix of codePriorityByCollection[safeTarget]) {
    if (foundCodes[prefix]) {
      primaryCode = foundCodes[prefix];
      break;
    }
  }
  if (!primaryCode && explicitCode && /^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$/.test(explicitCode)) {
    primaryCode = explicitCode;
  }

  const customer = extractLabeledValue(lines, 'Khách\\s*hàng|Bên\\s*mua|Đơn\\s*vị\\s*nhận|Customer(?:\\s*Name)?|Client|Buyer|Consignee', warnings);
  const supplier = extractLabeledValue(lines, 'Nhà\\s*cung\\s*cấp|Bên\\s*bán|Đơn\\s*vị\\s*cung\\s*cấp|Supplier(?:\\s*Name)?|Vendor', warnings);
  const origin = extractLabeledValue(lines, 'Điểm\\s*đi|Kho\\s*xuất|Nơi\\s*xuất|Xuất\\s*từ|Origin|From(?:\\s*Location|\\s*Warehouse)?|Source\\s*Warehouse', warnings);
  const destination = extractLabeledValue(lines, 'Điểm\\s*đến|Kho\\s*nhận|Nơi\\s*nhận|Giao\\s*đến|Destination|Ship\\s*To|To(?:\\s*Location|\\s*Warehouse)?|Target\\s*Warehouse', warnings);
  const name = extractLabeledValue(lines, 'Tiêu\\s*đề|Tên\\s*đơn(?:\\s*hàng)?|Tên\\s*phiếu|Tên\\s*yêu\\s*cầu|Title|Subject', warnings);
  const category = extractLabeledValue(lines, 'Loại\\s*yêu\\s*cầu|Danh\\s*mục|Category', warnings, 100);
  const serviceTypeRaw = extractLabeledValue(lines, 'Loại\\s*dịch\\s*vụ|Service\\s*Type', warnings, 40);
  const priorityRaw = extractLabeledValue(lines, 'Độ\\s*ưu\\s*tiên|Mức\\s*ưu\\s*tiên|Priority', warnings, 40);
  const description = extractLabeledValue(lines, 'Mô\\s*tả|Nội\\s*dung|Ghi\\s*chú|Notes?|Description|Remarks', warnings, MAX_EXTRACTED_DESC_LEN);
  const productNameLabel = extractLabeledValue(lines, 'Tên\\s*sản\\s*phẩm|Sản\\s*phẩm|Tên\\s*hàng|Product(?:\\s*Name)?|Item\\s*Name', warnings);

  const globalSkuRaw = extractLabeledValue(lines, 'Mã\\s*SKU|SKU', warnings, 64);
  const globalSku = globalSkuRaw && !/^(tên|product|qty|số|hạn|expiry)$/i.test(globalSkuRaw) ? globalSkuRaw : '';
  const globalQtyRaw = extractLabeledValue(lines, 'Tổng\\s*số\\s*lượng|Số\\s*lượng|SL|Total\\s*Qty|Total\\s*Quantity|Qty|Quantity', warnings, 40);
  const globalQty = globalQtyRaw ? parsePositiveNumber(globalQtyRaw.match(/\d+(?:[.,]\d+)?/)?.[0]) : null;
  const globalExpiryRaw = extractLabeledValue(lines, 'Hạn\\s*sử\\s*dụng|Hạn\\s*dùng|HSD|Expiry(?:\\s*Date)?|Exp(?:\\s*Date)?', warnings, 40);
  const globalExpiry = globalExpiryRaw ? normalizeDateToken(globalExpiryRaw) : null;

  const lineItems = parseLineItemsFromText(lines, warnings);
  if (!lineItems.length && globalSku) {
    const synth = {};
    defineSafeField(synth, 'sku', globalSku);
    if (productNameLabel) defineSafeField(synth, 'productName', productNameLabel);
    if (globalQty != null) defineSafeField(synth, 'quantity', globalQty);
    if (globalExpiry) defineSafeField(synth, 'expiryDate', globalExpiry);
    if (foundCodes.LOT) defineSafeField(synth, 'lotCode', foundCodes.LOT);
    lineItems.push(synth);
  }

  const lineQtySum = lineItems.reduce((acc, item) => acc + (Number(item.quantity) > 0 ? Number(item.quantity) : 0), 0);
  const effectiveQty = globalQty ?? (lineQtySum > 0 ? lineQtySum : null);
  const tempMeta = extractTemperatureMetadata(effectiveText, warnings);

  if (safeTarget === 'latticeStockLots') {
    const lotCode = foundCodes.LOT || (explicitCode && /^LOT-/i.test(explicitCode) ? explicitCode : primaryCode);
    if (lotCode) defineSafeField(fields, 'lotCode', lotCode);
    if (primaryCode) defineSafeField(fields, 'code', primaryCode);
    const firstItem = lineItems[0] || {};
    defineSafeField(fields, 'sku', firstItem.sku || globalSku);
    defineSafeField(fields, 'productName', firstItem.productName || productNameLabel);
    if (effectiveQty != null) defineSafeField(fields, 'qtyOnHand', effectiveQty);
    if (firstItem.unit) defineSafeField(fields, 'unit', firstItem.unit);
    defineSafeField(fields, 'expiryDate', firstItem.expiryDate || globalExpiry);
    if (destination || origin) defineSafeField(fields, 'warehouseCode', destination || origin);
    if (tempMeta.targetTempMinC !== undefined) defineSafeField(fields, 'targetTempMinC', tempMeta.targetTempMinC);
    if (tempMeta.targetTempMaxC !== undefined) defineSafeField(fields, 'targetTempMaxC', tempMeta.targetTempMaxC);
    if (tempMeta.mktCelsius !== undefined) defineSafeField(fields, 'mktCelsius', tempMeta.mktCelsius);
  } else if (safeTarget === 'latticeServiceTickets') {
    if (primaryCode) defineSafeField(fields, 'code', primaryCode);
    if (name) defineSafeField(fields, 'name', name);
    if (serviceTypeRaw) {
      const sLower = serviceTypeRaw.toLowerCase();
      let mappedServiceType = '';
      if (/leave|nghỉ\s*phép|công\s*tác/.test(sLower)) mappedServiceType = 'leave';
      else if (/it_support|cntt|it\b|máy\s*tính|phần\s*mềm/.test(sLower)) mappedServiceType = 'it_support';
      else if (/facilities|cơ\s*sở\s*vật\s*chất|điện|lạnh|sửa\s*chữa/.test(sLower)) mappedServiceType = 'facilities';
      else if (/hr_request|nhân\s*sự|hành\s*chính/.test(sLower)) mappedServiceType = 'hr_request';
      if (mappedServiceType) defineSafeField(fields, 'serviceType', mappedServiceType);
    }
    if (priorityRaw) {
      const pLower = priorityRaw.toLowerCase();
      const normalizedPriority = /cao|high|khẩn/.test(pLower)
        ? 'high'
        : (/thấp|low/.test(pLower) ? 'low' : (/trung|medium/.test(pLower) ? 'medium' : priorityRaw));
      defineSafeField(fields, 'priority', normalizedPriority);
    }
    if (description) defineSafeField(fields, 'description', description);
  } else {
    if (primaryCode) defineSafeField(fields, 'code', primaryCode);
    if (name) defineSafeField(fields, 'name', name);
    if (category) defineSafeField(fields, 'category', category);
    if (customer) defineSafeField(fields, 'customer', customer);
    if (supplier) defineSafeField(fields, 'supplier', supplier);
    if (origin) defineSafeField(fields, 'origin', origin);
    if (destination) defineSafeField(fields, 'destination', destination);
    if (effectiveQty != null) defineSafeField(fields, 'quantity', effectiveQty);
    if (description) defineSafeField(fields, 'description', description);
    if (tempMeta.targetTempMinC !== undefined) defineSafeField(fields, 'targetTempMinC', tempMeta.targetTempMinC);
    if (tempMeta.targetTempMaxC !== undefined) defineSafeField(fields, 'targetTempMaxC', tempMeta.targetTempMaxC);
    if (tempMeta.mktCelsius !== undefined) defineSafeField(fields, 'mktCelsius', tempMeta.mktCelsius);
    if (tempMeta.temperatureRequirement) defineSafeField(fields, 'temperatureRequirement', tempMeta.temperatureRequirement);
  }

  const fieldCount = Object.keys(fields).length;
  let confidence = 0;
  if (fieldCount === 0 && lineItems.length === 0) {
    addWarning(warnings, 'NO_STRUCTURED_FIELDS_FOUND');
  } else {
    const rawScore = Math.min(0.98, 0.28 + fieldCount * 0.1 + Math.min(lineItems.length, 3) * 0.08);
    confidence = Number(rawScore.toFixed(2));
  }

  return {
    targetCollection: safeTarget,
    fields,
    lineItems,
    confidence,
    warnings,
  };
}

/**
 * Validate a remote OCR endpoint URL against SSRF, credential-embedding, and HTTPS policies.
 *
 * @param {string} rawUrl - Configured `DX_OCR_ENDPOINT` URL.
 * @param {Record<string, string|undefined>} [env=process.env] - Environment containing optional `DX_OCR_TRUSTED_HOSTS`.
 * @returns {string} Canonicalized safe endpoint URL.
 */
function validateOcrEndpoint(rawUrl, env = process.env) {
  const raw = String(rawUrl || '');
  if (/[\r\n\0]/.test(raw)) {
    throw failExtract('OCR_ENDPOINT_INVALID', 400, 'Địa chỉ DX_OCR_ENDPOINT chứa ký tự điều khiển không hợp lệ.');
  }
  const str = raw.trim();
  let parsed;
  try {
    parsed = new URL(str);
  } catch {
    throw failExtract('OCR_ENDPOINT_INVALID', 400, 'Địa chỉ DX_OCR_ENDPOINT không hợp lệ.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw failExtract('OCR_ENDPOINT_PROTOCOL_INVALID', 400, 'DX_OCR_ENDPOINT chỉ hỗ trợ giao thức http/https.');
  }
  if (parsed.username || parsed.password) {
    throw failExtract('OCR_ENDPOINT_CREDENTIALS_FORBIDDEN', 400, 'Không được phép nhúng thông tin xác thực trong DX_OCR_ENDPOINT.');
  }
  const host = parsed.hostname.toLowerCase();
  const bareHost = host.replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  const extraTrusted = String(env?.DX_OCR_TRUSTED_HOSTS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, ''))
    .filter(Boolean);
  const isTrustedInternal = TRUSTED_OCR_HTTP_HOSTS.has(bareHost) || extraTrusted.includes(bareHost);
  const isBlockedInternalSuffix = !isTrustedInternal && (
    bareHost.endsWith('.internal')
    || bareHost.endsWith('.local')
    || bareHost.endsWith('.localhost')
  );
  if (!bareHost || BLOCKED_OCR_HOST_RE.test(host) || BLOCKED_OCR_HOST_RE.test(bareHost) || isBlockedInternalSuffix) {
    throw failExtract('OCR_ENDPOINT_SSRF_BLOCKED', 400, 'Từ chối DX_OCR_ENDPOINT do thuộc vùng metadata/nội bộ không tin cậy (SSRF guard).');
  }
  if (parsed.protocol === 'http:' && !isTrustedInternal) {
    throw failExtract('OCR_ENDPOINT_HTTPS_REQUIRED', 400, 'DX_OCR_ENDPOINT bên ngoài bắt buộc dùng HTTPS hoặc host Docker/localhost tin cậy.');
  }
  return parsed.toString();
}

function extractReadableUtf8Runs(buf) {
  const text = Buffer.from(buf).toString('utf8');
  const runs = [];
  for (const line of text.split(/\r?\n/)) {
    const clean = line.replace(/[\u0000-\u0008\u000b-\u001f\u007f\uFFFD]/g, ' ').replace(/\s+/g, ' ').trim();
    if (clean.length < 4) continue;
    const printableCount = (clean.match(/[A-Za-z0-9À-ỹ°:.,;/\-_()\s]/g) || []).length;
    if (printableCount / clean.length >= 0.85) {
      runs.push(clean);
    }
  }
  return runs.join('\n').trim();
}

function extractOfflinePngText(buf, maxInflatedBytes = MAX_INFLATED_BYTES) {
  const texts = [];
  let offset = 8;
  let parsedChunks = 0;
  let totalInflated = 0;
  while (offset + 12 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    const dataEnd = dataStart + len;
    if (!/^[A-Za-z]{4}$/.test(type) || dataEnd + 4 > buf.length) break;
    parsedChunks += 1;
    const payload = buf.subarray(dataStart, dataEnd);
    if (type === 'tEXt') {
      const nul = payload.indexOf(0);
      const valBuf = nul >= 0 ? payload.subarray(nul + 1) : payload;
      const decoded = valBuf.toString('utf8').trim();
      if (decoded) texts.push(decoded);
    } else if (type === 'zTXt') {
      if (totalInflated >= maxInflatedBytes) break;
      const nul = payload.indexOf(0);
      if (nul >= 0 && nul + 2 < payload.length) {
        try {
          const remaining = maxInflatedBytes - totalInflated;
          if (remaining <= 0) break;
          const inf = zlib.inflateSync(payload.subarray(nul + 2), { maxOutputLength: remaining });
          totalInflated += inf.length;
          const decoded = inf.toString('utf8').trim();
          if (decoded) texts.push(decoded);
          if (totalInflated >= maxInflatedBytes) break;
        } catch {
          // Skip corrupt PNG zTXt chunk
        }
      }
    } else if (type === 'iTXt') {
      const nul1 = payload.indexOf(0);
      if (nul1 >= 0 && nul1 + 3 <= payload.length) {
        const compFlag = payload[nul1 + 1];
        const nul2 = payload.indexOf(0, nul1 + 3);
        const nul3 = nul2 >= 0 ? payload.indexOf(0, nul2 + 1) : -1;
        const textSlice = nul3 >= 0 ? payload.subarray(nul3 + 1) : payload.subarray(nul1 + 3);
        if (compFlag === 1) {
          const remaining = maxInflatedBytes - totalInflated;
          if (remaining <= 0) break;
          try {
            const inf = zlib.inflateSync(textSlice, { maxOutputLength: remaining });
            totalInflated += inf.length;
            const decoded = inf.toString('utf8').trim();
            if (decoded) texts.push(decoded);
            if (totalInflated >= maxInflatedBytes) break;
          } catch {
            // Skip corrupt PNG iTXt chunk
          }
        } else {
          const decoded = textSlice.toString('utf8').trim();
          if (decoded) texts.push(decoded);
        }
      }
    }
    offset = dataEnd + 4;
    if (type === 'IEND') break;
  }
  if (texts.length) return texts.join('\n').trim();
  if (parsedChunks === 0) return extractReadableUtf8Runs(buf.subarray(8));
  return '';
}

function extractOfflineJpegText(buf) {
  const texts = [];
  let offset = 2;
  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xff) break;
    const marker = buf[offset + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2;
      continue;
    }
    const segLen = buf.readUInt16BE(offset + 2);
    if (segLen < 2 || offset + 2 + segLen > buf.length) break;
    const payload = buf.subarray(offset + 4, offset + 2 + segLen);
    if (marker === 0xfe) {
      const comment = payload.toString('utf8').trim();
      if (comment) texts.push(comment);
    } else if (marker === 0xe1) {
      const asStr = payload.toString('utf8');
      if (asStr.includes('xmpmeta') || asStr.includes('dc:description')) {
        const stripped = decodeXmlEntities(stripXmlTags(asStr, '\n')).trim();
        if (stripped) texts.push(stripped);
      }
    }
    offset += 2 + segLen;
  }
  if (texts.length) return texts.join('\n').trim();
  return extractReadableUtf8Runs(buf.subarray(2));
}

function extractOfflinePdfMetadataText(buf) {
  const raw = buf.toString('latin1');
  const fields = [];
  for (const key of ['Title', 'Subject', 'Keywords']) {
    const re = new RegExp(`/${key}\\s*\\(([^)]*)\\)`, 'g');
    let m;
    while ((m = re.exec(raw)) !== null) {
      const decoded = decodePdfBytes(Buffer.from(m[1], 'latin1')).trim();
      if (decoded) fields.push(decoded);
    }
  }
  return fields.join('\n').trim();
}

function detectInputFormat(buf, filename = '', mimeType = '') {
  const lowerName = String(filename || '').trim().toLowerCase();
  const lowerMime = String(mimeType || '').trim().toLowerCase();

  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { kind: 'image', format: 'png', mimeType: 'image/png' };
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { kind: 'image', format: 'jpg', mimeType: 'image/jpeg' };
  }
  if (
    buf.length >= 12
    && buf.subarray(0, 4).toString('ascii') === 'RIFF'
    && buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { kind: 'image', format: 'webp', mimeType: 'image/webp' };
  }
  if (lowerName.endsWith('.png') || lowerMime === 'image/png') {
    return { kind: 'image', format: 'png', mimeType: 'image/png' };
  }
  if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg') || lowerMime === 'image/jpeg') {
    return { kind: 'image', format: 'jpg', mimeType: 'image/jpeg' };
  }
  if (lowerName.endsWith('.webp') || lowerMime === 'image/webp') {
    return { kind: 'image', format: 'webp', mimeType: 'image/webp' };
  }
  const headLatin = buf.subarray(0, Math.min(buf.length, 64)).toString('latin1');
  if (lowerName.endsWith('.pdf') || lowerMime === 'application/pdf' || headLatin.startsWith('%PDF-')) {
    return { kind: 'pdf', format: 'pdf', mimeType: 'application/pdf' };
  }
  return { kind: 'document', format: '', mimeType: lowerMime || 'application/octet-stream' };
}

async function callRemoteOcrEndpoint({
  endpointUrl,
  buf,
  filename,
  mimeType,
  targetCollection,
  env,
  fetchImpl,
}) {
  const apiKey = String(env?.DX_OCR_API_KEY || env?.AGENT_API_KEY || '').trim();
  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const res = await fetchImpl(endpointUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      filename: safeBasename(filename, 'document'),
      mimeType,
      contentBase64: buf.toString('base64'),
      targetCollection,
      languageHints: ['vi', 'en'],
    }),
    redirect: 'error',
    signal: AbortSignal.timeout(OCR_TIMEOUT_MS),
  });

  if (res && (res.redirected === true || (Number(res.status) >= 300 && Number(res.status) < 400))) {
    try { await res?.body?.cancel?.(); } catch {}
    throw failExtract('OCR_REDIRECT_FORBIDDEN', 400, 'Dịch vụ OCR chuyển hướng không hợp lệ.');
  }
  if (!res || !res.ok) {
    try { await res?.body?.cancel?.(); } catch {}
    return null;
  }

  const payload = await res.json();
  const pageTexts = Array.isArray(payload?.pages)
    ? payload.pages.map((p) => String(p?.text || '').trim()).filter(Boolean).join('\f')
    : '';
  const extracted = String(
    payload?.text
    || payload?.extractedText
    || payload?.content
    || payload?.result?.text
    || payload?.data?.text
    || payload?.choices?.[0]?.message?.content
    || pageTexts
    || '',
  ).trim();

  if (!extracted) return null;
  return {
    text: extracted,
    pageCount: Math.max(1, Number(payload?.pageCount) || extracted.split('\f').length),
  };
}

async function tryRemoteOcrFallback({
  validatedEndpoint,
  buf,
  filename,
  mimeType,
  targetCollection,
  env,
  fetchImpl,
  warnings,
}) {
  if (!validatedEndpoint || typeof fetchImpl !== 'function') return null;
  try {
    const remote = await callRemoteOcrEndpoint({
      endpointUrl: validatedEndpoint,
      buf,
      filename,
      mimeType,
      targetCollection,
      env,
      fetchImpl,
    });
    if (remote) return remote;
    warnings.push('REMOTE_OCR_UNAVAILABLE_FALLBACK');
    return null;
  } catch (err) {
    if (err?.code === 'OCR_REDIRECT_FORBIDDEN') throw err;
    warnings.push('REMOTE_OCR_UNAVAILABLE_FALLBACK');
    return null;
  }
}

/**
 * Extract document/image text (via remote OCR when configured or offline deterministic parser) and map structured form fields.
 *
 * @param {object} options
 * @param {Buffer|Uint8Array} options.buffer - Uploaded document or image buffer.
 * @param {string} [options.filename=''] - Uploaded filename.
 * @param {string} [options.mimeType=''] - Uploaded MIME type.
 * @param {string} [options.targetCollection='latticeOrders'] - Target collection allowlist entry.
 * @param {Record<string, string|undefined>} [options.env=process.env] - Environment containing optional OCR config.
 * @param {Function} [options.fetchImpl=globalThis.fetch] - Fetch implementation for remote OCR.
 * @returns {Promise<{text: string, format: string, pageCount: number, ocrEngine: string, targetCollection: string, fields: Record<string, any>, suggestedValues: Record<string, any>, lineItems: Array<Record<string, any>>, confidence: number, warnings: string[]}>}
 */
async function extractWithMultimodalOcr({
  buffer,
  filename = '',
  mimeType = '',
  targetCollection = 'latticeOrders',
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const buf = toBuffer(buffer);
  if (buf.length === 0) {
    throw failExtract('ATTACHMENT_EMPTY', 400, 'Tệp đính kèm rỗng.');
  }
  if (!ALLOWED_FORM_COLLECTIONS.has(String(targetCollection || '').trim())) {
    throw failExtract('INVALID_TARGET_COLLECTION', 400, 'Bảng đích auto-fill không hợp lệ.');
  }

  const rawEndpoint = String(env?.DX_OCR_ENDPOINT || '').trim();
  const validatedEndpoint = rawEndpoint ? validateOcrEndpoint(rawEndpoint, env) : null;

  const detected = detectInputFormat(buf, filename, mimeType);
  let text = '';
  let format = detected.format;
  let pageCount = 1;
  let ocrEngine = 'offline-deterministic-fallback';
  const extraWarnings = [];

  if (detected.kind === 'document') {
    const extracted = extractTextFromBuffer(buf, { filename, mimeType });
    text = extracted.text;
    format = extracted.format;
    pageCount = extracted.pageCount;
  } else if (detected.kind === 'pdf') {
    const pdfRes = extractPdfText(buf);
    format = 'pdf';
    pageCount = pdfRes.pageCount;
    text = pdfRes.text;
    if (!text) {
      const remote = await tryRemoteOcrFallback({
        validatedEndpoint,
        buf,
        filename,
        mimeType: 'application/pdf',
        targetCollection,
        env,
        fetchImpl,
        warnings: extraWarnings,
      });
      if (remote) {
        text = remote.text;
        pageCount = Math.max(pageCount, remote.pageCount);
        ocrEngine = 'remote-ocr';
      }
    }
    if (!text) {
      text = extractOfflinePdfMetadataText(buf);
    }
  } else {
    format = detected.format;
    const remote = await tryRemoteOcrFallback({
      validatedEndpoint,
      buf,
      filename,
      mimeType: detected.mimeType,
      targetCollection,
      env,
      fetchImpl,
      warnings: extraWarnings,
    });
    if (remote) {
      text = remote.text;
      pageCount = remote.pageCount;
      ocrEngine = 'remote-ocr';
    }
    if (!text && ocrEngine !== 'remote-ocr') {
      if (format === 'png') text = extractOfflinePngText(buf);
      else if (format === 'jpg') text = extractOfflineJpegText(buf);
      else text = extractReadableUtf8Runs(buf.subarray(12));
    }
  }

  const structured = extractStructuredFormFields(text, {
    targetCollection,
    ocrMetadata: { ocrEngine, format, pageCount },
  });
  for (const w of extraWarnings) addWarning(structured.warnings, w);

  return {
    text,
    format,
    pageCount,
    ocrEngine,
    targetCollection: structured.targetCollection,
    fields: structured.fields,
    suggestedValues: structured.fields,
    lineItems: structured.lineItems,
    confidence: structured.confidence,
    warnings: structured.warnings,
  };
}

module.exports = {
  MAX_INFLATED_BYTES,
  MAX_UPLOAD_BYTES,
  MAX_ZIP_ENTRIES,
  ALLOWED_FORM_COLLECTIONS,
  listZipEntriesInCentralDirectory,
  extractDocxText,
  extractXlsxText,
  extractPptxText,
  extractPdfText,
  parseToUnicodeCMap,
  extractTextFromBuffer,
  extractStructuredFormFields,
  validateOcrEndpoint,
  extractWithMultimodalOcr,
  chunkDocumentText,
};
