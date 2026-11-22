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

const MAX_INFLATED_BYTES = 10 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const MAX_PDF_PAGE_COUNT = 5000;
const MAX_ZIP_ENTRIES = 10000;
const ZIP_LOCAL_SIG = 0x04034b50;
const ZIP_CD_SIG = 0x02014b50;
const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_DD_SIG = 0x08074b50;

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

function findZipEntryInCentralDirectory(buf, targetPath) {
  if (buf.length < 22) return null;
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
  if (eocdOffset < 0) return null;

  const cdSize = buf.readUInt32LE(eocdOffset + 12);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff || cdOffset + cdSize > eocdOffset) {
    throw failExtract('DOCX_CORRUPT_ARCHIVE', 400, 'Cấu trúc Central Directory của tệp DOCX không hợp lệ.');
  }

  let cursor = cdOffset;
  let entries = 0;
  let ciMatch = null;
  const targetLower = targetPath.toLowerCase();

  while (cursor + 46 <= cdOffset + cdSize && entries < MAX_ZIP_ENTRIES) {
    entries += 1;
    if (buf.readUInt32LE(cursor) !== ZIP_CD_SIG) break;
    const method = buf.readUInt16LE(cursor + 10);
    const compressedSize = buf.readUInt32LE(cursor + 20);
    const uncompressedSize = buf.readUInt32LE(cursor + 24);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const localHeaderOffset = buf.readUInt32LE(cursor + 42);
    const headerEnd = cursor + 46 + nameLen + extraLen + commentLen;
    if (headerEnd > cdOffset + cdSize) break;

    const name = normalizeEntryPath(buf.toString('utf8', cursor + 46, cursor + 46 + nameLen));
    const record = { name, method, compressedSize, uncompressedSize, localHeaderOffset };
    if (name === targetPath) return record;
    if (!ciMatch && name.toLowerCase() === targetLower) ciMatch = record;
    cursor = headerEnd;
  }
  return ciMatch;
}

function findZipEntryInLocalHeaders(buf, targetPath) {
  let cursor = 0;
  let entries = 0;
  const targetLower = targetPath.toLowerCase();
  let ciMatch = null;

  while (cursor + 30 <= buf.length && entries < MAX_ZIP_ENTRIES) {
    if (buf.readUInt32LE(cursor) !== ZIP_LOCAL_SIG) break;
    entries += 1;
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

    const record = { name, method, compressedSize, uncompressedSize, localHeaderOffset: cursor };
    if (name === targetPath) return record;
    if (!ciMatch && name.toLowerCase() === targetLower) ciMatch = record;

    let next = dataStart + compressedSize;
    if ((flags & 0x08) !== 0 && next + 12 <= buf.length) {
      next += buf.readUInt32LE(next) === ZIP_DD_SIG ? 16 : 12;
    }
    cursor = next;
  }
  return ciMatch;
}

function extractDocxText(buffer, { maxInflatedBytes = MAX_INFLATED_BYTES } = {}) {
  const buf = toBuffer(buffer);
  if (buf.length < 30 || (buf.readUInt32LE(0) !== ZIP_LOCAL_SIG && findZipEntryInCentralDirectory(buf, 'word/document.xml') == null)) {
    throw failExtract('DOCX_INVALID_ARCHIVE', 400, 'Tệp DOCX không đúng định dạng nén ZIP hợp lệ.');
  }

  const entry = findZipEntryInCentralDirectory(buf, 'word/document.xml')
    || findZipEntryInLocalHeaders(buf, 'word/document.xml');
  if (!entry) {
    throw failExtract('DOCX_MISSING_DOCUMENT_XML', 400, 'Tệp DOCX không chứa thành phần word/document.xml.');
  }

  if (entry.uncompressedSize > maxInflatedBytes) {
    throw failExtract('DOCX_ZIP_BOMB', 400, 'Kích thước XML giải nén của DOCX vượt quá giới hạn an toàn 10MB.');
  }

  const localOff = entry.localHeaderOffset;
  if (localOff < 0 || localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== ZIP_LOCAL_SIG) {
    throw failExtract('DOCX_CORRUPT_ARCHIVE', 400, 'Header cục bộ của word/document.xml bị hỏng.');
  }
  const localNameLen = buf.readUInt16LE(localOff + 26);
  const localExtraLen = buf.readUInt16LE(localOff + 28);
  const dataStart = localOff + 30 + localNameLen + localExtraLen;
  const dataEnd = dataStart + entry.compressedSize;
  if (entry.compressedSize > buf.length || dataEnd > buf.length) {
    throw failExtract('DOCX_CORRUPT_ARCHIVE', 400, 'Dữ liệu nén word/document.xml bị cắt cụt.');
  }

  const compressedSlice = buf.subarray(dataStart, dataEnd);
  let xmlBuf;
  if (entry.method === 0) {
    if (compressedSlice.length > maxInflatedBytes) {
      throw failExtract('DOCX_ZIP_BOMB', 400, 'Kích thước word/document.xml vượt quá giới hạn 10MB.');
    }
    xmlBuf = compressedSlice;
  } else if (entry.method === 8) {
    try {
      xmlBuf = zlib.inflateRawSync(compressedSlice, { maxOutputLength: maxInflatedBytes });
    } catch (err) {
      if (err?.code === 'ERR_BUFFER_TOO_LARGE') {
        throw failExtract('DOCX_ZIP_BOMB', 400, 'Kích thước XML giải nén vượt quá giới hạn 10MB (nghi vấn zip-bomb).');
      }
      throw failExtract('DOCX_CORRUPT_ARCHIVE', 400, 'Không thể giải nén dữ liệu XML từ tệp DOCX.');
    }
  } else {
    throw failExtract('DOCX_UNSUPPORTED_COMPRESSION', 400, `Phương thức nén ZIP (${entry.method}) chưa được hỗ trợ.`);
  }

  const rawXml = xmlBuf.toString('utf8');
  const withBreaks = rawXml
    .replace(/<w:br\b[^>]*w:type="page"[^>]*\/?>/gi, '\f')
    .replace(/<w:lastRenderedPageBreak\b[^>]*\/?>/gi, '\f')
    .replace(/<\/w:p>/gi, '\n')
    .replace(/<\/w:tr>/gi, '\n')
    .replace(/<\/w:tc>/gi, '\t')
    .replace(/<w:(?:br|cr)\b[^>]*\/?>/gi, '\n')
    .replace(/<w:tab\b[^>]*\/?>/gi, ' ');

  const stripped = withBreaks.replace(/<[^>]+>/g, '');
  const decoded = decodeXmlEntities(stripped);
  return decoded
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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

function decodePdfHexString(hexRaw) {
  const clean = String(hexRaw || '').replace(/\s+/g, '');
  if (!clean) return '';
  const padded = clean.length % 2 === 1 ? `${clean}0` : clean;
  const bytes = Buffer.from(padded, 'hex');
  return decodePdfBytes(bytes);
}

function parsePdfLiteralString(str, startIdx) {
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
  return { value: decodePdfBytes(bytes), nextIdx: i };
}

function extractTextFromPdfContentStream(contentStr) {
  const out = [];
  const stack = [];
  let i = 0;
  let lastTmY = null;
  const len = contentStr.length;

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
    if (ch === '(') {
      const parsed = parsePdfLiteralString(contentStr, i);
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
        stack.push({ type: 'str', value: decodePdfHexString(rawHex) });
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
          const parsed = parsePdfLiteralString(contentStr, i);
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
            joined += decodePdfHexString(rawHex);
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
      if (tok === 'Tj') {
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

function mapPdfPageContents(rawLatin1) {
  const objToPage = new Map();
  let pageObjectsCount = 0;
  let cursor = 0;
  const objHeaderRe = /\b(\d+)\s+\d+\s+obj\b/g;

  while (cursor < rawLatin1.length) {
    const endobjIdx = rawLatin1.indexOf('endobj', cursor);
    if (endobjIdx < 0) break;
    const windowStart = Math.max(cursor, endobjIdx - 16384);
    const windowSlice = rawLatin1.slice(windowStart, endobjIdx);
    cursor = endobjIdx + 6;

    if (!windowSlice.includes('/Page')) continue;

    objHeaderRe.lastIndex = 0;
    let lastObjMatch = null;
    let m;
    while ((m = objHeaderRe.exec(windowSlice)) !== null) {
      lastObjMatch = m;
    }
    const body = lastObjMatch ? windowSlice.slice(lastObjMatch.index + lastObjMatch[0].length) : windowSlice;
    if (!/\/Type\s*\/Page\b(?!s)/.test(body)) continue;

    pageObjectsCount += 1;
    if (pageObjectsCount > MAX_PDF_PAGE_COUNT) break;

    const single = body.match(/\/Contents\s+(\d+)\s+\d+\s+R/);
    if (single) {
      objToPage.set(Number(single[1]), pageObjectsCount);
    } else {
      const arr = body.match(/\/Contents\s*\[([^\]]+)\]/);
      if (arr) {
        for (const ref of arr[1].matchAll(/(\d+)\s+\d+\s+R/g)) {
          objToPage.set(Number(ref[1]), pageObjectsCount);
        }
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
    detectedPageCount: Math.min(MAX_PDF_PAGE_COUNT, Math.max(pageObjectsCount, pagesCountHint, 1)),
  };
}

function extractPdfText(buffer, { maxInflatedBytes = MAX_INFLATED_BYTES } = {}) {
  const buf = toBuffer(buffer);
  const head = buf.subarray(0, Math.min(buf.length, 1024)).toString('latin1');
  if (!head.includes('%PDF-')) {
    throw failExtract('PDF_INVALID_DOCUMENT', 400, 'Tệp tải lên không có chữ ký PDF (%PDF-) hợp lệ.');
  }

  const raw = buf.toString('latin1');
  const { objToPage, detectedPageCount } = mapPdfPageContents(raw);
  const pageTexts = new Map();
  const unmappedTexts = [];
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
    const extracted = extractTextFromPdfContentStream(contentStr);
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

function extractTextFromBuffer(buffer, { filename = '', mimeType = '' } = {}) {
  const buf = toBuffer(buffer);
  if (buf.length === 0) {
    throw failExtract('ATTACHMENT_EMPTY', 400, 'Tệp đính kèm rỗng.');
  }

  const lowerName = String(filename || '').trim().toLowerCase();
  const lowerMime = String(mimeType || '').trim().toLowerCase();
  const head = buf.subarray(0, Math.min(buf.length, 64));
  const headLatin = head.toString('latin1');

  const looksPdf = lowerName.endsWith('.pdf')
    || lowerMime === 'application/pdf'
    || headLatin.startsWith('%PDF-');
  if (looksPdf) {
    const pdfRes = extractPdfText(buf);
    return {
      text: pdfRes.text,
      format: 'pdf',
      pageCount: pdfRes.pageCount,
    };
  }

  const looksZip = buf.length >= 4 && buf.readUInt32LE(0) === ZIP_LOCAL_SIG;
  const looksDocx = lowerName.endsWith('.docx')
    || lowerMime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    || (looksZip && findZipEntryInCentralDirectory(buf, 'word/document.xml') != null);
  if (looksDocx) {
    const docxText = extractDocxText(buf);
    const pageCount = docxText ? Math.max(1, docxText.split('\f').length) : 1;
    return {
      text: docxText,
      format: 'docx',
      pageCount,
    };
  }

  const allowedTextExt = !lowerName || /\.(txt|md|markdown|json|csv|log|yml|yaml|xml|html?)$/.test(lowerName);
  const allowedTextMime = !lowerMime || lowerMime.startsWith('text/') || lowerMime === 'application/json';
  if (!allowedTextExt || !allowedTextMime || buf.includes(0)) {
    throw failExtract('UNSUPPORTED_ATTACHMENT_FORMAT', 400, 'Định dạng tệp đính kèm chưa được hỗ trợ (chỉ hỗ trợ PDF, DOCX, Markdown, TXT, JSON).');
  }

  const rawText = buf.toString('utf8').replace(/\r\n/g, '\n').trim();
  let format = 'text';
  if (lowerName.endsWith('.md') || lowerName.endsWith('.markdown') || lowerMime === 'text/markdown') {
    format = 'markdown';
  } else if (lowerName.endsWith('.json') || lowerMime === 'application/json') {
    format = 'json';
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

module.exports = {
  MAX_INFLATED_BYTES,
  MAX_UPLOAD_BYTES,
  extractDocxText,
  extractPdfText,
  extractTextFromBuffer,
  chunkDocumentText,
};
