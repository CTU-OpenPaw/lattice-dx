/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { createHash, createHmac, randomBytes, timingSafeEqual } = require('node:crypto');
const path = require('node:path');

const ORG_ID_RE = /^[a-zA-Z0-9_-]{1,80}$/;
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const MAX_IMPORT_ROWS = 500;
const MAX_CONSUMED_NONCES = 10000;
const DEFAULT_TOKEN_TTL_MS = 15 * 60 * 1000;
const TOKEN_RE = /^ldx_imp_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;
const FORMULA_PREFIX_RE = /^(?:[=+\-@\t\r]|\s+[=+\-@])/;
const SCRIPT_PAYLOAD_RE = /<script\b|javascript:|onerror\s*=|onload\s*=/i;
const FORBIDDEN_ROW_KEYS = new Set([
  'id',
  'version',
  'organizationId',
  'createdAt',
  'updatedAt',
  'deletedAt',
  '__proto__',
  'constructor',
  'prototype',
]);

const ALLOWED_IMPORT_COLLECTIONS = new Set([
  'latticeAssets',
  'latticeLocations',
  'latticeDepartments',
]);
const OPTIONAL_IMPORT_COLLECTIONS = new Set(['latticeStockLots']);

const COLLECTION_SPECS = {
  latticeAssets: {
    uniqueKey: 'code',
    required: ['code', 'name'],
    allowedFields: ['code', 'name', 'kind', 'status', 'active', 'departmentId', 'locationId', 'custodianId'],
  },
  latticeLocations: {
    uniqueKey: 'code',
    required: ['code', 'name'],
    allowedFields: ['code', 'name', 'kind', 'address', 'active', 'departmentId'],
  },
  latticeDepartments: {
    uniqueKey: 'code',
    required: ['code', 'name'],
    allowedFields: ['code', 'name', 'active'],
  },
  latticeStockLots: {
    uniqueKey: 'lotCode',
    required: ['lotCode', 'sku', 'productName', 'qtyOnHand', 'expiryDate'],
    allowedFields: [
      'lotCode',
      'sku',
      'productName',
      'qtyOnHand',
      'qtyReserved',
      'unit',
      'expiryDate',
      'manufacturedAt',
      'warehouseLocationId',
      'warehouseCode',
      'assetEntityId',
      'targetTempMinC',
      'targetTempMaxC',
      'status',
      'active',
    ],
  },
};

const consumedNonces = new Set();

const val = (row, key) => (typeof row?.get === 'function' ? row.get(key) : row?.[key]);

function failImport(code, status = 400, message = code) {
  return Object.assign(new Error(message), { code, status });
}

function loadFoundationModule(subpath) {
  const inDist = __dirname.includes(`${path.sep}dist${path.sep}`);
  const candidates = inDist
    ? [
        `../../../plugin-lattice-foundation/dist/server/${subpath}`,
        `../../../plugin-lattice-foundation/src/server/${subpath}`,
      ]
    : [
        `../../../plugin-lattice-foundation/src/server/${subpath}`,
        `../../../plugin-lattice-foundation/dist/server/${subpath}`,
      ];
  for (const modPath of candidates) {
    try {
      return require(modPath);
    } catch (err) {
      if (err?.code !== 'MODULE_NOT_FOUND') throw err;
    }
  }
  return null;
}

function assertAllowedImportCollection(db, rawCollection) {
  const collection = String(rawCollection || '').trim();
  if (ALLOWED_IMPORT_COLLECTIONS.has(collection)) return collection;
  if (OPTIONAL_IMPORT_COLLECTIONS.has(collection)) {
    const repo = db?.getRepository?.(collection);
    if (repo && typeof repo.create === 'function') return collection;
  }
  throw failImport('BULK_IMPORT_COLLECTION_FORBIDDEN', 403, `Không được phép import vào collection "${collection}".`);
}

function assertValidOrgId(organizationId) {
  const org = typeof organizationId === 'string' ? organizationId.trim() : '';
  if (!ORG_ID_RE.test(org)) {
    throw failImport('BULK_IMPORT_ORG_REQUIRED', 400, 'Cần organizationId hợp lệ để import dữ liệu.');
  }
  return org;
}

function resolveImportSigningSecret(explicitSecret = null, env = process.env) {
  const explicit = typeof explicitSecret === 'string' ? explicitSecret.trim() : '';
  if (explicit) return explicit;
  const fromEnv = String(env?.ENCRYPTION_FIELD_KEY || env?.APP_KEY || '').trim();
  if (fromEnv) return fromEnv;
  if (String(env?.NODE_ENV || '').trim().toLowerCase() === 'production') {
    throw failImport('BULK_IMPORT_SIGNING_KEY_MISSING', 503, 'ENCRYPTION_FIELD_KEY or APP_KEY must be set in production.');
  }
  return 'latticedx-dev-import-key';
}

function markNonceConsumed(nonce) {
  if (consumedNonces.size >= MAX_CONSUMED_NONCES) {
    const oldest = consumedNonces.values().next().value;
    if (oldest !== undefined) consumedNonces.delete(oldest);
  }
  consumedNonces.add(nonce);
}

/**
 * Parses an RFC-4180 CSV string with BOM removal, quoted commas, "" escape, and CRLF/LF support.
 */
function parseRfc4180Csv(rawContent) {
  if (typeof rawContent !== 'string') {
    throw failImport('BULK_IMPORT_PARSE_ERROR', 400, 'Nội dung CSV phải là chuỗi.');
  }
  if (Buffer.byteLength(rawContent, 'utf8') > MAX_IMPORT_BYTES) {
    throw failImport('BULK_IMPORT_LIMIT_EXCEEDED', 400, 'Dung lượng payload CSV vượt quá giới hạn 2 MiB.');
  }
  const text = rawContent.startsWith('\uFEFF') ? rawContent.slice(1) : rawContent;
  if (!text.trim()) {
    throw failImport('BULK_IMPORT_EMPTY', 400, 'Nội dung CSV trống.');
  }

  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') {
      if (cell.length > 0) {
        throw failImport('BULK_IMPORT_PARSE_ERROR', 400, 'Dấu ngoặc kép không hợp lệ trong CSV.');
      }
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }

  if (inQuotes) {
    throw failImport('BULK_IMPORT_PARSE_ERROR', 400, 'Chuỗi trích dẫn CSV chưa được đóng.');
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  while (rows.length > 0 && rows[rows.length - 1].every((v) => v === '')) {
    rows.pop();
  }
  if (rows.length < 2) {
    throw failImport('BULK_IMPORT_EMPTY', 400, 'CSV phải có dòng tiêu đề và ít nhất 1 dòng dữ liệu.');
  }

  const headers = rows[0].map((h) => String(h || '').trim());
  if (!headers.length || headers.some((h) => !h || h.length > 64)) {
    throw failImport('BULK_IMPORT_PARSE_ERROR', 400, 'Tiêu đề cột CSV không hợp lệ.');
  }

  const dataRows = rows.slice(1).filter((r) => r.some((v) => String(v || '').trim() !== ''));
  if (!dataRows.length) {
    throw failImport('BULK_IMPORT_EMPTY', 400, 'Không có dòng dữ liệu hợp lệ trong CSV.');
  }
  if (dataRows.length > MAX_IMPORT_ROWS) {
    throw failImport('BULK_IMPORT_LIMIT_EXCEEDED', 400, `Số dòng import vượt quá giới hạn ${MAX_IMPORT_ROWS}.`);
  }

  return dataRows.map((cells) => {
    if (cells.length > headers.length) {
      return { __csvColumnOverflow: true };
    }
    const obj = {};
    for (let c = 0; c < headers.length; c += 1) {
      const hdr = headers[c];
      if (FORBIDDEN_ROW_KEYS.has(hdr)) continue;
      obj[hdr] = c < cells.length ? cells[c] : '';
    }
    return obj;
  });
}

function parseJsonRows({ content, rows } = {}) {
  let parsed = rows;
  if (parsed === undefined || parsed === null) {
    if (typeof content !== 'string' || !content.trim()) {
      throw failImport('BULK_IMPORT_EMPTY', 400, 'Dữ liệu JSON import trống.');
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_IMPORT_BYTES) {
      throw failImport('BULK_IMPORT_LIMIT_EXCEEDED', 400, 'Dung lượng JSON vượt quá giới hạn 2 MiB.');
    }
    try {
      parsed = JSON.parse(content);
    } catch {
      throw failImport('BULK_IMPORT_PARSE_ERROR', 400, 'JSON import không hợp lệ.');
    }
  } else {
    const serialized = JSON.stringify(parsed);
    if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX_IMPORT_BYTES) {
      throw failImport('BULK_IMPORT_LIMIT_EXCEEDED', 400, 'Dung lượng JSON vượt quá giới hạn 2 MiB.');
    }
  }

  if (!Array.isArray(parsed)) {
    throw failImport('BULK_IMPORT_PARSE_ERROR', 400, 'Dữ liệu JSON import phải là một mảng đối tượng.');
  }
  if (!parsed.length) {
    throw failImport('BULK_IMPORT_EMPTY', 400, 'Danh sách dòng import trống.');
  }
  if (parsed.length > MAX_IMPORT_ROWS) {
    throw failImport('BULK_IMPORT_LIMIT_EXCEEDED', 400, `Số dòng import vượt quá giới hạn ${MAX_IMPORT_ROWS}.`);
  }
  return parsed;
}

function parseInputBatch({ format, content, rows } = {}) {
  const resolvedFormat = format
    ? String(format).trim().toLowerCase()
    : (Array.isArray(rows) ? 'json' : 'csv');

  if (resolvedFormat === 'csv') return parseRfc4180Csv(content);
  if (resolvedFormat === 'json') return parseJsonRows({ content, rows });
  throw failImport('BULK_IMPORT_FORMAT_INVALID', 400, 'Định dạng import chỉ hỗ trợ csv hoặc json.');
}

function sanitizeTextCell(raw, { maxLen = 255 } = {}) {
  if (raw === undefined || raw === null) return '';
  const str = String(raw).trim();
  if (!str) return '';
  if (SCRIPT_PAYLOAD_RE.test(str)) {
    throw failImport('UNSAFE_SCRIPT_PAYLOAD', 400, 'Phát hiện mã kịch bản không an toàn trong dữ liệu import.');
  }
  const safe = FORMULA_PREFIX_RE.test(str) && !/^-?\d+(?:\.\d+)?$/.test(str)
    ? `'${str}`
    : str;
  return safe.slice(0, maxLen);
}

function parseOptionalBoolean(raw, defaultValue = true) {
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  if (typeof raw === 'boolean') return raw;
  const s = String(raw).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no') return false;
  throw failImport('INVALID_BOOLEAN', 400, 'Giá trị boolean không hợp lệ.');
}

function parseOptionalPositiveInt(raw, fieldName) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const s = String(raw).trim();
  if (!/^[1-9]\d{0,18}$/.test(s)) {
    throw failImport('INVALID_REFERENCE_ID', 400, `${fieldName} phải là số nguyên dương.`);
  }
  return Number(s);
}

function parseFiniteNum(raw, fieldName) {
  if (raw === undefined || raw === null || raw === '' || typeof raw === 'boolean' || typeof raw === 'object') {
    throw failImport('INVALID_NUMBER', 400, `${fieldName} phải là số hợp lệ.`);
  }
  if (typeof raw === 'string' && raw.trim() === '') {
    throw failImport('INVALID_NUMBER', 400, `${fieldName} phải là số hợp lệ.`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw failImport('INVALID_NUMBER', 400, `${fieldName} phải là số hữu hạn.`);
  }
  return n;
}

function parseIsoDate(raw, fieldName) {
  if (raw === undefined || raw === null || raw === '') {
    throw failImport('INVALID_DATE', 400, `${fieldName} không được để trống.`);
  }
  const dt = raw instanceof Date ? new Date(raw.getTime()) : new Date(String(raw).trim());
  if (!Number.isFinite(dt.getTime())) {
    throw failImport('INVALID_DATE', 400, `${fieldName} không phải ngày hợp lệ.`);
  }
  return dt.toISOString();
}

function validateAndSanitizeRow(collection, rawRow) {
  if (!rawRow || typeof rawRow !== 'object' || Array.isArray(rawRow)) {
    throw failImport('INVALID_ROW_OBJECT', 400, 'Dòng dữ liệu phải là một đối tượng.');
  }
  if (rawRow.__csvColumnOverflow) {
    throw failImport('CSV_COLUMN_COUNT_MISMATCH', 400, 'Số cột trong dòng CSV vượt quá số cột tiêu đề.');
  }
  const spec = COLLECTION_SPECS[collection];
  const clean = {};

  if (collection === 'latticeAssets' || collection === 'latticeLocations' || collection === 'latticeDepartments') {
    const code = sanitizeTextCell(rawRow.code, { maxLen: 100 });
    const name = sanitizeTextCell(rawRow.name, { maxLen: 255 });
    if (!code) throw failImport('MISSING_REQUIRED_FIELD', 400, 'Thiếu trường bắt buộc code.');
    if (!name) throw failImport('MISSING_REQUIRED_FIELD', 400, 'Thiếu trường bắt buộc name.');
    clean.code = code;
    clean.name = name;

    if (collection === 'latticeAssets') {
      const kind = sanitizeTextCell(rawRow.kind, { maxLen: 100 });
      const status = sanitizeTextCell(rawRow.status, { maxLen: 64 }) || 'available';
      const deptId = parseOptionalPositiveInt(rawRow.departmentId, 'departmentId');
      const locId = parseOptionalPositiveInt(rawRow.locationId, 'locationId');
      const custId = parseOptionalPositiveInt(rawRow.custodianId, 'custodianId');
      if (kind) clean.kind = kind;
      clean.status = status;
      clean.active = parseOptionalBoolean(rawRow.active, true);
      if (deptId !== undefined) clean.departmentId = deptId;
      if (locId !== undefined) clean.locationId = locId;
      if (custId !== undefined) clean.custodianId = custId;
    } else if (collection === 'latticeLocations') {
      const kind = sanitizeTextCell(rawRow.kind, { maxLen: 100 });
      const address = sanitizeTextCell(rawRow.address, { maxLen: 255 });
      const deptId = parseOptionalPositiveInt(rawRow.departmentId, 'departmentId');
      if (kind) clean.kind = kind;
      if (address) clean.address = address;
      clean.active = parseOptionalBoolean(rawRow.active, true);
      if (deptId !== undefined) clean.departmentId = deptId;
    } else {
      clean.active = parseOptionalBoolean(rawRow.active, true);
    }
  } else if (collection === 'latticeStockLots') {
    const lotCode = sanitizeTextCell(rawRow.lotCode, { maxLen: 100 });
    const sku = sanitizeTextCell(rawRow.sku, { maxLen: 100 });
    const productName = sanitizeTextCell(rawRow.productName, { maxLen: 255 });
    if (!lotCode) throw failImport('MISSING_REQUIRED_FIELD', 400, 'Thiếu trường bắt buộc lotCode.');
    if (!sku) throw failImport('MISSING_REQUIRED_FIELD', 400, 'Thiếu trường bắt buộc sku.');
    if (!productName) throw failImport('MISSING_REQUIRED_FIELD', 400, 'Thiếu trường bắt buộc productName.');

    const qtyOnHand = parseFiniteNum(rawRow.qtyOnHand, 'qtyOnHand');
    if (qtyOnHand <= 0) {
      throw failImport('INVALID_QUANTITY', 400, 'qtyOnHand phải lớn hơn 0.');
    }
    const expiryDate = parseIsoDate(rawRow.expiryDate, 'expiryDate');

    clean.lotCode = lotCode;
    clean.sku = sku;
    clean.productName = productName;
    clean.qtyOnHand = qtyOnHand;
    clean.qtyReserved = rawRow.qtyReserved !== undefined && rawRow.qtyReserved !== ''
      ? Math.max(0, parseFiniteNum(rawRow.qtyReserved, 'qtyReserved'))
      : 0;
    clean.unit = sanitizeTextCell(rawRow.unit, { maxLen: 64 }) || 'UNIT';
    clean.expiryDate = expiryDate;
    if (rawRow.manufacturedAt !== undefined && rawRow.manufacturedAt !== '') {
      clean.manufacturedAt = parseIsoDate(rawRow.manufacturedAt, 'manufacturedAt');
    }
    const whLocId = parseOptionalPositiveInt(rawRow.warehouseLocationId, 'warehouseLocationId');
    if (whLocId !== undefined) clean.warehouseLocationId = whLocId;
    const whCode = sanitizeTextCell(rawRow.warehouseCode, { maxLen: 100 });
    if (whCode) clean.warehouseCode = whCode;
    const entityId = sanitizeTextCell(rawRow.assetEntityId, { maxLen: 255 });
    if (entityId) clean.assetEntityId = entityId;
    if (rawRow.targetTempMinC !== undefined && rawRow.targetTempMinC !== '') {
      clean.targetTempMinC = parseFiniteNum(rawRow.targetTempMinC, 'targetTempMinC');
    }
    if (rawRow.targetTempMaxC !== undefined && rawRow.targetTempMaxC !== '') {
      clean.targetTempMaxC = parseFiniteNum(rawRow.targetTempMaxC, 'targetTempMaxC');
    }
    if (clean.targetTempMinC !== undefined && clean.targetTempMaxC !== undefined && clean.targetTempMinC > clean.targetTempMaxC) {
      throw failImport('INVALID_TEMP_RANGE', 400, 'targetTempMinC không được lớn hơn targetTempMaxC.');
    }
    clean.status = sanitizeTextCell(rawRow.status, { maxLen: 64 }) || 'available';
    clean.active = parseOptionalBoolean(rawRow.active, true);
  }

  // Re-order properties deterministically according to spec.allowedFields
  const ordered = {};
  for (const field of spec.allowedFields) {
    if (Object.hasOwn(clean, field)) {
      ordered[field] = clean[field];
    }
  }
  return ordered;
}

function prepareImportBatch(collection, rawRows) {
  const uniqueKey = COLLECTION_SPECS[collection].uniqueKey;
  const seenKeys = new Set();
  const validRows = [];
  const errors = [];

  rawRows.forEach((rawRow, idx) => {
    const rowNumber = idx + 1;
    try {
      const sanitized = validateAndSanitizeRow(collection, rawRow);
      const keyVal = sanitized[uniqueKey];
      if (seenKeys.has(keyVal)) {
        errors.push({ row: rowNumber, code: 'DUPLICATE_CODE_IN_BATCH', message: `Trùng ${uniqueKey} "${keyVal}" trong tệp import.` });
        return;
      }
      seenKeys.add(keyVal);
      validRows.push(sanitized);
    } catch (err) {
      errors.push({
        row: rowNumber,
        code: err?.code || 'ROW_VALIDATION_FAILED',
        message: err?.message || 'Dòng dữ liệu không hợp lệ.',
      });
    }
  });

  return { validRows, errors, totalRows: rawRows.length };
}

function computeBatchSha256(organizationId, collection, validRows) {
  return createHash('sha256')
    .update(JSON.stringify({ organizationId, collection, validRows }))
    .digest('hex');
}

function signPreviewToken(claims, secret) {
  const payloadB64 = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const sig = createHmac('sha256', secret).update(payloadB64).digest('base64url');
  return `ldx_imp_${payloadB64}.${sig}`;
}

function verifyPreviewToken(rawToken, { organizationId, collection, payloadSha256, signingSecret, now = Date.now() }) {
  const token = typeof rawToken === 'string' ? rawToken.trim() : '';
  const match = TOKEN_RE.exec(token);
  if (!match) {
    throw failImport('BULK_IMPORT_TOKEN_INVALID', 400, 'previewToken không đúng định dạng.');
  }
  const [, payloadB64, providedSig] = match;
  const expectedSig = createHmac('sha256', signingSecret).update(payloadB64).digest('base64url');
  const expectedBuf = Buffer.from(expectedSig, 'utf8');
  const providedBuf = Buffer.from(providedSig, 'utf8');
  if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
    throw failImport('BULK_IMPORT_TOKEN_INVALID', 401, 'Chữ ký previewToken không hợp lệ.');
  }

  let claims;
  try {
    claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    throw failImport('BULK_IMPORT_TOKEN_INVALID', 400, 'Payload previewToken bị hỏng.');
  }

  if (!claims || typeof claims !== 'object') {
    throw failImport('BULK_IMPORT_TOKEN_INVALID', 400, 'Payload previewToken không hợp lệ.');
  }
  if (claims.organizationId !== organizationId) {
    throw failImport('DXOS_CROSS_ORG_FORBIDDEN', 403, 'previewToken không thuộc phạm vi tổ chức hiện tại.');
  }
  if (claims.collection !== collection) {
    throw failImport('BULK_IMPORT_COLLECTION_MISMATCH', 400, 'previewToken không khớp collection mục tiêu.');
  }
  if (!Number.isFinite(claims.expiresAt) || claims.expiresAt <= now) {
    throw failImport('BULK_IMPORT_TOKEN_EXPIRED', 400, 'previewToken đã hết hạn, vui lòng chạy lại dry-run.');
  }
  if (typeof claims.nonce !== 'string' || !claims.nonce || consumedNonces.has(claims.nonce)) {
    throw failImport('BULK_IMPORT_TOKEN_REPLAYED', 409, 'previewToken đã được sử dụng trước đó.');
  }
  if (claims.payloadSha256 !== payloadSha256) {
    throw failImport('BULK_IMPORT_PAYLOAD_MISMATCH', 409, 'Nội dung dữ liệu commit khác với bản xem trước SHA-256.');
  }

  return claims;
}

/**
 * Phase 1: Validates a CSV/JSON batch, computes canonical SHA-256, and signs an HMAC previewToken.
 */
async function runBulkImportDryRun(db, {
  organizationId,
  collection: rawCollection,
  format,
  content,
  rows,
  signingSecret = null,
  ttlMs = DEFAULT_TOKEN_TTL_MS,
  env = process.env,
} = {}) {
  const orgId = assertValidOrgId(organizationId);
  const collection = assertAllowedImportCollection(db, rawCollection);
  const secret = resolveImportSigningSecret(signingSecret, env);

  const rawRows = parseInputBatch({ format, content, rows });
  const { validRows, errors, totalRows } = prepareImportBatch(collection, rawRows);
  const payloadSha256 = computeBatchSha256(orgId, collection, validRows);
  const expiresAt = Date.now() + Number(ttlMs);
  const nonce = randomBytes(16).toString('hex');

  const previewToken = signPreviewToken(
    { organizationId: orgId, collection, payloadSha256, nonce, expiresAt },
    secret,
  );

  return {
    previewToken,
    payloadSha256,
    collection,
    totalRows,
    validCount: validRows.length,
    invalidCount: errors.length,
    errors,
    expiresAt: new Date(expiresAt).toISOString(),
    sampleValidRows: validRows.slice(0, 20),
  };
}

/**
 * Phase 2: Verifies previewToken HMAC + replay + SHA-256 parity and persists records inside a transaction.
 */
async function commitBulkImport(db, {
  organizationId,
  collection: rawCollection,
  format,
  content,
  rows,
  previewToken,
  signingSecret = null,
  actor = null,
  env = process.env,
} = {}) {
  const orgId = assertValidOrgId(organizationId);
  const collection = assertAllowedImportCollection(db, rawCollection);
  const secret = resolveImportSigningSecret(signingSecret, env);

  const rawRows = parseInputBatch({ format, content, rows });
  const { validRows } = prepareImportBatch(collection, rawRows);
  const payloadSha256 = computeBatchSha256(orgId, collection, validRows);

  const claims = verifyPreviewToken(previewToken, {
    organizationId: orgId,
    collection,
    payloadSha256,
    signingSecret: secret,
  });

  if (!validRows.length) {
    throw failImport('BULK_IMPORT_NO_VALID_ROWS', 400, 'Không có dòng hợp lệ nào để commit.');
  }

  const repo = db?.getRepository?.(collection);
  if (!repo || typeof repo.create !== 'function') {
    throw failImport('BULK_IMPORT_REPO_UNAVAILABLE', 503, `Kho dữ liệu ${collection} chưa sẵn sàng.`);
  }

  // Mark nonce consumed only after all validation & HMAC/SHA-256 checks succeed.
  markNonceConsumed(claims.nonce);

  const uniqueKey = COLLECTION_SPECS[collection].uniqueKey;
  const runInTx = async (fn) => (
    typeof db?.sequelize?.transaction === 'function'
      ? db.sequelize.transaction(fn)
      : fn(null)
  );

  let committedCount = 0;
  let skippedDuplicates = 0;
  const createdIds = [];

  await runInTx(async (transaction) => {
    const isPostgres = typeof db?.sequelize?.getDialect === 'function' && db.sequelize.getDialect() === 'postgres';
    if (isPostgres && transaction) {
      const pgRls = loadFoundationModule('pg-rls');
      if (pgRls && typeof pgRls.setTransactionRlsOrg === 'function') {
        await pgRls.setTransactionRlsOrg(db, orgId, transaction);
      }
    }

    const txOpt = transaction ? { transaction } : {};
    for (const row of validRows) {
      let existing = null;
      if (typeof repo.findOne === 'function') {
        existing = await repo.findOne({
          filter: { organizationId: orgId, [uniqueKey]: row[uniqueKey] },
          ...txOpt,
        });
      } else if (typeof repo.find === 'function') {
        const list = (await repo.find({
          filter: { organizationId: orgId, [uniqueKey]: row[uniqueKey] },
          limit: 1,
          ...txOpt,
        })) || [];
        existing = list[0] || null;
      }

      if (existing && val(existing, 'organizationId') === orgId) {
        skippedDuplicates += 1;
        continue;
      }

      const created = await repo.create({
        values: { ...row, organizationId: orgId },
        ...txOpt,
      });
      committedCount += 1;
      const cid = val(created, 'id');
      if (cid != null) createdIds.push(cid);
    }
  });

  const pki = loadFoundationModule('pki-ledger');
  if (pki && typeof pki.appendLedgerEntrySafely === 'function') {
    await pki.appendLedgerEntrySafely(
      db,
      {
        organizationId: orgId,
        eventType: 'data.bulk_import_committed',
        targetCollection: collection,
        targetRecordId: createdIds[0] != null ? String(createdIds[0]) : payloadSha256.slice(0, 16),
        actor: {
          userId: actor?.userId ? String(actor.userId) : null,
          username: actor?.username || 'operator',
        },
        payload: {
          collection,
          payloadSha256,
          committedCount,
          skippedDuplicates,
        },
      },
      { scope: 'dxos:bulk-import' },
    );
  }

  return {
    committedCount,
    skippedDuplicates,
    collection,
    payloadSha256,
  };
}

module.exports = {
  ALLOWED_IMPORT_COLLECTIONS,
  OPTIONAL_IMPORT_COLLECTIONS,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ROWS,
  parseRfc4180Csv,
  runBulkImportDryRun,
  commitBulkImport,
};
