/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const OUTBOX_DB_NAME = 'latticedx-mobile-outbox';
const OUTBOX_STORE_NAME = 'outbox';
const OUTBOX_DB_VERSION = 1;
const OUTBOX_STORAGE_KEY = 'latticedx:mobile:offline-queue';
const MAX_OUTBOX_ITEMS = 50;
const MAX_OUTBOX_PAYLOAD_BYTES = 320 * 1024;
const MAX_PHOTO_DATA_URL_BYTES = 512 * 1024;
const MAX_OUTBOX_TOTAL_BYTES_WITH_PHOTO = 768 * 1024;
const FORBIDDEN_STORAGE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const VALID_OUTBOX_STATUSES = Object.freeze(['pending', 'syncing', 'failed', 'synced']);
const VALID_OUTBOX_STATUS_SET = new Set(VALID_OUTBOX_STATUSES);

const ALLOWED_OFFLINE_ACTIONS = Object.freeze({
  'wms.epodCapture': Object.freeze({ url: 'dxosWms:epodCapture', method: 'post', label: 'Xác nhận ePOD' }),
  'iot.twinSetDesired': Object.freeze({ url: 'dxosBlocks:twinSetDesired', method: 'post', label: 'Đặt ngưỡng Twin' }),
});

const memoryOutboxMap = new Map();
let queueSeqCounter = 0;

function nextQueueSequence() {
  queueSeqCounter += 1;
  return queueSeqCounter;
}

function generateQueueId(nowMs = Date.now(), seq = nextQueueSequence()) {
  const tsPart = Math.max(0, Math.floor(Number(nowMs) || 0)).toString(36).padStart(9, '0');
  const seqPart = Math.max(0, Math.floor(Number(seq) || 0)).toString(36).padStart(6, '0');
  const suffix = (typeof globalThis !== 'undefined' && globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function')
    ? globalThis.crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  return `mq-${tsPart}-${seqPart}-${suffix}`;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function stripForbiddenKeys(value, depth = 0) {
  if (depth > 16) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    const cleanArr = [];
    for (const entry of value) {
      const cleanEntry = stripForbiddenKeys(entry, depth + 1);
      if (cleanEntry !== undefined) cleanArr.push(cleanEntry);
    }
    return cleanArr;
  }
  if (isPlainObject(value)) {
    const cleanObj = {};
    for (const [key, val] of Object.entries(value)) {
      if (FORBIDDEN_STORAGE_KEYS.has(key)) continue;
      const cleanVal = stripForbiddenKeys(val, depth + 1);
      if (cleanVal !== undefined) cleanObj[key] = cleanVal;
    }
    return cleanObj;
  }
  return undefined;
}

function isQuotaExceededError(err) {
  if (!err || typeof err !== 'object') return false;
  const name = String(err.name || '');
  const code = Number(err.code);
  return name === 'QuotaExceededError'
    || name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || code === 22
    || code === 1014;
}

function isValidRasterImageDataUrl(value, maxBytes) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxBytes) return false;
  if (!trimmed.startsWith('data:image/')) return false;
  if (/^data:image\/svg\+xml/i.test(trimmed)) return false;
  return true;
}

function validateAndSerializePayload(payload) {
  if (!isPlainObject(payload)) {
    throw Object.assign(new Error('Dữ liệu hàng đợi phải là đối tượng JSON hợp lệ.'), { code: 'INVALID_OFFLINE_PAYLOAD' });
  }
  try {
    const stripped = stripForbiddenKeys(payload);
    if (!isPlainObject(stripped)) {
      throw Object.assign(new Error('Dữ liệu hàng đợi phải là đối tượng JSON hợp lệ.'), { code: 'INVALID_OFFLINE_PAYLOAD' });
    }
    if (
      stripped.signatureDataUrl !== undefined
      && (typeof stripped.signatureDataUrl !== 'string' || stripped.signatureDataUrl.length > MAX_OUTBOX_PAYLOAD_BYTES)
    ) {
      throw Object.assign(new Error('Chữ ký trong hàng đợi vượt quá kích thước cho phép.'), { code: 'INVALID_OFFLINE_PAYLOAD' });
    }
    if (
      stripped.evidencePhotoDataUrl !== undefined
      && !isValidRasterImageDataUrl(stripped.evidencePhotoDataUrl, MAX_PHOTO_DATA_URL_BYTES)
    ) {
      throw Object.assign(new Error('Ảnh minh chứng trong hàng đợi không hợp lệ hoặc vượt quá kích thước.'), { code: 'INVALID_OFFLINE_PAYLOAD' });
    }
    const maxBytes = stripped.evidencePhotoDataUrl !== undefined
      ? MAX_OUTBOX_TOTAL_BYTES_WITH_PHOTO
      : MAX_OUTBOX_PAYLOAD_BYTES;
    const serialized = JSON.stringify(stripped);
    if (typeof serialized !== 'string' || serialized.length > maxBytes) {
      throw Object.assign(new Error('Dữ liệu hàng đợi vượt quá kích thước cho phép.'), { code: 'INVALID_OFFLINE_PAYLOAD' });
    }
    return JSON.parse(serialized);
  } catch (err) {
    if (err && err.code === 'INVALID_OFFLINE_PAYLOAD') throw err;
    throw Object.assign(new Error('Không thể tuần tự hóa dữ liệu hàng đợi.'), { code: 'INVALID_OFFLINE_PAYLOAD' });
  }
}

function sanitizeOutboxItem(raw) {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.id !== 'string' || !raw.id.trim()) return null;
  const spec = Object.hasOwn(ALLOWED_OFFLINE_ACTIONS, raw.actionType) ? ALLOWED_OFFLINE_ACTIONS[raw.actionType] : null;
  if (!spec) return null;
  if (!isPlainObject(raw.payload)) return null;
  const strippedPayload = stripForbiddenKeys(raw.payload);
  if (!isPlainObject(strippedPayload)) return null;
  if (
    strippedPayload.signatureDataUrl !== undefined
    && (typeof strippedPayload.signatureDataUrl !== 'string' || strippedPayload.signatureDataUrl.length > MAX_OUTBOX_PAYLOAD_BYTES)
  ) {
    return null;
  }
  if (
    strippedPayload.evidencePhotoDataUrl !== undefined
    && !isValidRasterImageDataUrl(strippedPayload.evidencePhotoDataUrl, MAX_PHOTO_DATA_URL_BYTES)
  ) {
    return null;
  }
  const maxBytes = strippedPayload.evidencePhotoDataUrl !== undefined
    ? MAX_OUTBOX_TOTAL_BYTES_WITH_PHOTO
    : MAX_OUTBOX_PAYLOAD_BYTES;
  let cleanPayload;
  try {
    const serialized = JSON.stringify(strippedPayload);
    if (typeof serialized !== 'string' || serialized.length > maxBytes) return null;
    cleanPayload = JSON.parse(serialized);
  } catch {
    return null;
  }
  const rawStatus = typeof raw.status === 'string' ? raw.status.trim() : '';
  const status = VALID_OUTBOX_STATUS_SET.has(rawStatus) ? rawStatus : 'pending';
  const createdAt = typeof raw.createdAt === 'string' && raw.createdAt ? raw.createdAt : new Date().toISOString();
  const updatedAt = typeof raw.updatedAt === 'string' && raw.updatedAt ? raw.updatedAt : createdAt;
  const rawHttpStatus = Number(raw.httpStatus);
  const httpStatus = Number.isInteger(rawHttpStatus) && rawHttpStatus >= 100 && rawHttpStatus < 600 ? rawHttpStatus : null;
  return {
    id: raw.id.trim().slice(0, 128),
    actionType: raw.actionType,
    endpoint: spec.url,
    payload: cleanPayload,
    status,
    createdAt,
    updatedAt,
    ...(Number.isInteger(raw.seq) && raw.seq >= 0 ? { seq: raw.seq } : {}),
    attempts: Number.isInteger(raw.attempts) && raw.attempts >= 0 ? raw.attempts : 0,
    lastError: typeof raw.lastError === 'string' ? raw.lastError.slice(0, 240) : null,
    httpStatus,
  };
}

function resolveStorage(storageOrOpts) {
  if (storageOrOpts && typeof storageOrOpts.getItem === 'function' && typeof storageOrOpts.setItem === 'function') {
    return storageOrOpts;
  }
  const candidate = storageOrOpts && storageOrOpts.storage ? storageOrOpts.storage : null;
  if (candidate && typeof candidate.getItem === 'function' && typeof candidate.setItem === 'function') {
    return candidate;
  }
  if (typeof window !== 'undefined' && window && window.localStorage && typeof window.localStorage.getItem === 'function') {
    return window.localStorage;
  }
  if (typeof globalThis !== 'undefined' && globalThis.localStorage && typeof globalThis.localStorage.getItem === 'function') {
    return globalThis.localStorage;
  }
  return null;
}

function resolveIndexedDbFactory(opts) {
  if (opts && opts.useIndexedDB === false) return null;
  if (opts && opts.indexedDB && typeof opts.indexedDB.open === 'function') {
    return opts.indexedDB;
  }
  if (opts && Object.hasOwn(opts, 'indexedDB') && opts.indexedDB == null) {
    return null;
  }
  if (typeof globalThis !== 'undefined' && globalThis.indexedDB && typeof globalThis.indexedDB.open === 'function') {
    return globalThis.indexedDB;
  }
  if (typeof window !== 'undefined' && window && window.indexedDB && typeof window.indexedDB.open === 'function') {
    return window.indexedDB;
  }
  return null;
}

function isIndexedDbAvailable(opts) {
  return Boolean(resolveIndexedDbFactory(opts));
}

function sortOutboxItems(items) {
  return [...items].sort((a, b) => {
    const ta = Date.parse(a.createdAt || '');
    const tb = Date.parse(b.createdAt || '');
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
    const sa = Number(a.seq);
    const sb = Number(b.seq);
    if (Number.isInteger(sa) && Number.isInteger(sb) && sa !== sb) return sa - sb;
    const idA = String(a.id || '');
    const idB = String(b.id || '');
    if (idA < idB) return -1;
    if (idA > idB) return 1;
    return 0;
  });
}

function filterOutboxItems(items, statusFilter) {
  if (!statusFilter) return items;
  const allowed = Array.isArray(statusFilter) ? new Set(statusFilter) : new Set([String(statusFilter)]);
  return items.filter((item) => allowed.has(item.status));
}

function readSyncFallbackOutbox(storageOrOpts = {}) {
  const storage = resolveStorage(storageOrOpts);
  if (!storage) return [];
  try {
    const raw = storage.getItem(OUTBOX_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const clean = [];
    for (const entry of parsed) {
      const sanitized = sanitizeOutboxItem(entry);
      if (sanitized) clean.push(sanitized);
      if (clean.length >= MAX_OUTBOX_ITEMS) break;
    }
    return sortOutboxItems(clean);
  } catch {
    return [];
  }
}

function writeSyncFallbackOutbox(items, storage) {
  if (!storage || typeof storage.setItem !== 'function') {
    throw Object.assign(new Error('Trình duyệt không hỗ trợ bộ nhớ ngoại tuyến.'), { code: 'OFFLINE_STORAGE_UNAVAILABLE' });
  }
  const bounded = Array.isArray(items) ? items.slice(0, MAX_OUTBOX_ITEMS) : [];
  try {
    storage.setItem(OUTBOX_STORAGE_KEY, JSON.stringify(bounded));
  } catch (err) {
    if (isQuotaExceededError(err)) {
      throw Object.assign(
        new Error('Bộ nhớ ngoại tuyến đã đầy (vượt dung lượng lưu trữ). Vui lòng đồng bộ hoặc xóa bớt tác vụ.'),
        { code: 'OFFLINE_STORAGE_QUOTA_EXCEEDED', cause: err },
      );
    }
    throw Object.assign(
      new Error((err && err.message) || 'Không thể lưu dữ liệu vào bộ nhớ ngoại tuyến.'),
      { code: 'OFFLINE_STORAGE_WRITE_FAILED', cause: err },
    );
  }
  return bounded;
}

function buildNewOutboxItem(entry) {
  const actionType = entry && typeof entry.actionType === 'string' ? entry.actionType.trim() : '';
  const spec = Object.hasOwn(ALLOWED_OFFLINE_ACTIONS, actionType) ? ALLOWED_OFFLINE_ACTIONS[actionType] : null;
  if (!spec) {
    throw Object.assign(new Error('Loại thao tác ngoại tuyến không được hỗ trợ.'), { code: 'UNSUPPORTED_OFFLINE_ACTION' });
  }
  const safePayload = validateAndSerializePayload(entry ? entry.payload : null);
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const seq = nextQueueSequence();
  const rawStatus = entry && typeof entry.status === 'string' ? entry.status.trim() : 'pending';
  const status = VALID_OUTBOX_STATUS_SET.has(rawStatus) ? rawStatus : 'pending';
  return {
    id: generateQueueId(nowMs, seq),
    actionType,
    endpoint: spec.url,
    payload: safePayload,
    status,
    createdAt: nowIso,
    updatedAt: nowIso,
    seq,
    attempts: 0,
    lastError: null,
    httpStatus: null,
  };
}

function enqueueSyncFallbackOutbox(entry, opts = {}) {
  const storage = resolveStorage(opts && opts.storage ? opts.storage : entry && entry.storage ? entry.storage : null);
  if (!storage) {
    throw Object.assign(new Error('Bộ nhớ ngoại tuyến không khả dụng.'), { code: 'OFFLINE_STORAGE_UNAVAILABLE' });
  }
  const item = buildNewOutboxItem(entry);
  const current = readSyncFallbackOutbox({ storage });
  if (current.length >= MAX_OUTBOX_ITEMS) {
    throw Object.assign(
      new Error('Hàng đợi ngoại tuyến đã đạt giới hạn tối đa ' + MAX_OUTBOX_ITEMS + ' tác vụ.'),
      { code: 'OFFLINE_QUEUE_FULL' },
    );
  }
  const next = writeSyncFallbackOutbox([...current, item], storage);
  return { item, queue: next };
}

function removeSyncFallbackOutbox(id, storageOrOpts = {}) {
  const storage = resolveStorage(storageOrOpts);
  if (!storage) return [];
  const targetId = typeof id === 'string' ? id.trim() : '';
  const current = readSyncFallbackOutbox({ storage });
  const next = current.filter((item) => item.id !== targetId);
  return writeSyncFallbackOutbox(next, storage);
}

function openOutboxDatabase(opts = {}) {
  const idb = resolveIndexedDbFactory(opts);
  if (!idb) return Promise.resolve(null);
  return new Promise((resolve) => {
    let req;
    try {
      req = idb.open(OUTBOX_DB_NAME, OUTBOX_DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    if (!req) {
      resolve(null);
      return;
    }
    req.onupgradeneeded = (ev) => {
      try {
        const db = ev?.target?.result || req.result;
        if (!db) return;
        if (!db.objectStoreNames?.contains?.(OUTBOX_STORE_NAME)) {
          const store = db.createObjectStore(OUTBOX_STORE_NAME, { keyPath: 'id' });
          if (store && typeof store.createIndex === 'function') {
            store.createIndex('status', 'status', { unique: false });
            store.createIndex('createdAt', 'createdAt', { unique: false });
          }
        }
      } catch {
        // Ignore upgrade index errors on constrained mock/browser implementations
      }
    };
    req.onsuccess = (ev) => {
      resolve(ev?.target?.result || req.result || null);
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

function runIdbGetAll(store) {
  return new Promise((resolve, reject) => {
    if (typeof store.getAll === 'function') {
      const req = store.getAll();
      req.onsuccess = (ev) => resolve(Array.isArray(ev?.target?.result ?? req.result) ? (ev?.target?.result ?? req.result) : []);
      req.onerror = (ev) => reject(req.error || ev?.target?.error || new Error('IndexedDB getAll failed'));
      return;
    }
    if (typeof store.openCursor === 'function') {
      const items = [];
      const req = store.openCursor();
      req.onsuccess = (ev) => {
        const cursor = ev?.target?.result || req.result;
        if (cursor) {
          items.push(cursor.value);
          cursor.continue();
        } else {
          resolve(items);
        }
      };
      req.onerror = (ev) => reject(req.error || ev?.target?.error || new Error('IndexedDB cursor failed'));
      return;
    }
    resolve([]);
  });
}

function runIdbGet(store, id) {
  return new Promise((resolve, reject) => {
    const req = store.get(id);
    req.onsuccess = (ev) => resolve(ev?.target?.result ?? req.result ?? null);
    req.onerror = (ev) => reject(req.error || ev?.target?.error || new Error('IndexedDB get failed'));
  });
}

function runIdbWrite(tx, requestFn) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let reqResult;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (err) {
        if (isQuotaExceededError(err)) {
          reject(Object.assign(
            new Error('Bộ nhớ ngoại tuyến đã đầy (vượt dung lượng lưu trữ). Vui lòng đồng bộ hoặc xóa bớt tác vụ.'),
            { code: 'OFFLINE_STORAGE_QUOTA_EXCEEDED', cause: err },
          ));
        } else {
          reject(Object.assign(
            new Error((err && err.message) || 'Không thể ghi dữ liệu IndexedDB.'),
            { code: 'OFFLINE_STORAGE_WRITE_FAILED', cause: err },
          ));
        }
      } else {
        resolve(reqResult);
      }
    };
    tx.oncomplete = () => finish(null);
    tx.onerror = (ev) => finish(tx.error || ev?.target?.error || new Error('IndexedDB transaction failed'));
    tx.onabort = (ev) => finish(tx.error || ev?.target?.error || new Error('IndexedDB transaction aborted'));
    try {
      const req = requestFn();
      if (req) {
        req.onsuccess = (ev) => {
          reqResult = ev?.target?.result ?? req.result;
        };
        req.onerror = (ev) => {
          finish(req.error || ev?.target?.error || tx.error || new Error('IndexedDB request failed'));
        };
      }
    } catch (err) {
      finish(err);
    }
  });
}

function listMemoryItems() {
  const clean = [];
  for (const entry of memoryOutboxMap.values()) {
    const sanitized = sanitizeOutboxItem(entry);
    if (sanitized) clean.push(sanitized);
    if (clean.length >= MAX_OUTBOX_ITEMS) break;
  }
  return clean;
}

function resetMemoryOutboxStore() {
  memoryOutboxMap.clear();
}

async function listOutboxItems(opts = {}) {
  const db = await openOutboxDatabase(opts);
  if (db) {
    try {
      const tx = db.transaction([OUTBOX_STORE_NAME], 'readonly');
      const store = tx.objectStore(OUTBOX_STORE_NAME);
      const rawItems = await runIdbGetAll(store);
      const clean = [];
      for (const entry of rawItems) {
        const sanitized = sanitizeOutboxItem(entry);
        if (sanitized) clean.push(sanitized);
      }
      return filterOutboxItems(sortOutboxItems(clean), opts.status);
    } catch {
      // Fall through to storage/memory fallback on unexpected read failure
    } finally {
      try { db.close?.(); } catch {}
    }
  }
  const storage = resolveStorage(opts);
  if (storage) {
    return filterOutboxItems(readSyncFallbackOutbox({ storage }), opts.status);
  }
  return filterOutboxItems(sortOutboxItems(listMemoryItems()), opts.status);
}

async function enqueueOutboxItem(entry, opts = {}) {
  const item = buildNewOutboxItem(entry);
  const db = await openOutboxDatabase(opts);
  if (db) {
    try {
      const readTx = db.transaction([OUTBOX_STORE_NAME], 'readonly');
      const existingRaw = await runIdbGetAll(readTx.objectStore(OUTBOX_STORE_NAME));
      const existing = existingRaw.map(sanitizeOutboxItem).filter(Boolean);
      if (existing.length >= MAX_OUTBOX_ITEMS) {
        throw Object.assign(
          new Error('Hàng đợi ngoại tuyến đã đạt giới hạn tối đa ' + MAX_OUTBOX_ITEMS + ' tác vụ.'),
          { code: 'OFFLINE_QUEUE_FULL' },
        );
      }
      const writeTx = db.transaction([OUTBOX_STORE_NAME], 'readwrite');
      const store = writeTx.objectStore(OUTBOX_STORE_NAME);
      await runIdbWrite(writeTx, () => store.put(item));
      return item;
    } finally {
      try { db.close?.(); } catch {}
    }
  }

  const storage = resolveStorage(opts && opts.storage ? opts.storage : entry && entry.storage ? entry.storage : null);
  if (storage) {
    const res = enqueueSyncFallbackOutbox({ ...entry, status: item.status }, { storage });
    return res.item;
  }

  const current = listMemoryItems();
  if (current.length >= MAX_OUTBOX_ITEMS) {
    throw Object.assign(
      new Error('Hàng đợi ngoại tuyến đã đạt giới hạn tối đa ' + MAX_OUTBOX_ITEMS + ' tác vụ.'),
      { code: 'OFFLINE_QUEUE_FULL' },
    );
  }
  memoryOutboxMap.set(item.id, item);
  return item;
}

async function removeOutboxItem(id, opts = {}) {
  const targetId = typeof id === 'string' ? id.trim() : '';
  const db = await openOutboxDatabase(opts);
  if (db) {
    try {
      if (targetId) {
        const writeTx = db.transaction([OUTBOX_STORE_NAME], 'readwrite');
        const store = writeTx.objectStore(OUTBOX_STORE_NAME);
        await runIdbWrite(writeTx, () => store.delete(targetId));
      }
      const readTx = db.transaction([OUTBOX_STORE_NAME], 'readonly');
      const rawItems = await runIdbGetAll(readTx.objectStore(OUTBOX_STORE_NAME));
      const clean = [];
      for (const entry of rawItems) {
        const sanitized = sanitizeOutboxItem(entry);
        if (sanitized) clean.push(sanitized);
      }
      return sortOutboxItems(clean);
    } finally {
      try { db.close?.(); } catch {}
    }
  }

  const storage = resolveStorage(opts);
  if (storage) {
    return removeSyncFallbackOutbox(targetId, { storage });
  }

  if (targetId) memoryOutboxMap.delete(targetId);
  return sortOutboxItems(listMemoryItems());
}

function applyOutboxStatusPatch(existing, statusOrPatch) {
  const patch = typeof statusOrPatch === 'string'
    ? { status: statusOrPatch }
    : (isPlainObject(statusOrPatch) ? statusOrPatch : {});
  const nextStatus = typeof patch.status === 'string' && VALID_OUTBOX_STATUS_SET.has(patch.status.trim())
    ? patch.status.trim()
    : existing.status;
  const nextAttempts = Number.isInteger(patch.attempts) && patch.attempts >= 0
    ? patch.attempts
    : existing.attempts;
  let nextError = existing.lastError;
  if (Object.hasOwn(patch, 'lastError')) {
    nextError = typeof patch.lastError === 'string' && patch.lastError ? patch.lastError.slice(0, 240) : null;
  }
  let nextHttpStatus = existing.httpStatus ?? null;
  if (Object.hasOwn(patch, 'httpStatus')) {
    const code = Number(patch.httpStatus);
    nextHttpStatus = Number.isInteger(code) && code >= 100 && code < 600 ? code : null;
  }
  return {
    ...existing,
    status: nextStatus,
    attempts: nextAttempts,
    lastError: nextError,
    httpStatus: nextHttpStatus,
    updatedAt: new Date().toISOString(),
  };
}

async function updateOutboxStatus(id, statusOrPatch, opts = {}) {
  const targetId = typeof id === 'string' ? id.trim() : '';
  if (!targetId) return null;

  const db = await openOutboxDatabase(opts);
  if (db) {
    try {
      const readTx = db.transaction([OUTBOX_STORE_NAME], 'readonly');
      const existingRaw = await runIdbGet(readTx.objectStore(OUTBOX_STORE_NAME), targetId);
      const existing = sanitizeOutboxItem(existingRaw);
      if (!existing) return null;
      const updated = applyOutboxStatusPatch(existing, statusOrPatch);
      const writeTx = db.transaction([OUTBOX_STORE_NAME], 'readwrite');
      await runIdbWrite(writeTx, () => writeTx.objectStore(OUTBOX_STORE_NAME).put(updated));
      return updated;
    } finally {
      try { db.close?.(); } catch {}
    }
  }

  const storage = resolveStorage(opts);
  if (storage) {
    const current = readSyncFallbackOutbox({ storage });
    let updatedItem = null;
    const next = current.map((item) => {
      if (item.id !== targetId) return item;
      updatedItem = applyOutboxStatusPatch(item, statusOrPatch);
      return updatedItem;
    });
    if (!updatedItem) return null;
    writeSyncFallbackOutbox(next, storage);
    return updatedItem;
  }

  const existingMem = sanitizeOutboxItem(memoryOutboxMap.get(targetId));
  if (!existingMem) return null;
  const updatedMem = applyOutboxStatusPatch(existingMem, statusOrPatch);
  memoryOutboxMap.set(targetId, updatedMem);
  return updatedMem;
}

module.exports = {
  OUTBOX_DB_NAME,
  OUTBOX_STORE_NAME,
  OUTBOX_DB_VERSION,
  OUTBOX_STORAGE_KEY,
  MAX_OUTBOX_ITEMS,
  MAX_OUTBOX_PAYLOAD_BYTES,
  MAX_PHOTO_DATA_URL_BYTES,
  MAX_OUTBOX_TOTAL_BYTES_WITH_PHOTO,
  ALLOWED_OFFLINE_ACTIONS,
  VALID_OUTBOX_STATUSES,
  isQuotaExceededError,
  isValidRasterImageDataUrl,
  isIndexedDbAvailable,
  sanitizeOutboxItem,
  validateAndSerializePayload,
  resolveStorage,
  readSyncFallbackOutbox,
  writeSyncFallbackOutbox,
  enqueueSyncFallbackOutbox,
  removeSyncFallbackOutbox,
  enqueueOutboxItem,
  listOutboxItems,
  removeOutboxItem,
  updateOutboxStatus,
  resetMemoryOutboxStore,
};
