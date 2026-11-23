/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const OFFLINE_QUEUE_STORAGE_KEY = 'latticedx:mobile:offline-queue';
const MAX_OFFLINE_QUEUE_ITEMS = 50;
const MAX_OFFLINE_PAYLOAD_BYTES = 320 * 1024;
const MAX_QR_PAYLOAD_LENGTH = 2048;
const FORBIDDEN_STORAGE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const ALLOWED_OFFLINE_ACTIONS = Object.freeze({
  'wms.epodCapture': Object.freeze({ url: 'dxosWms:epodCapture', method: 'post', label: 'Xác nhận ePOD' }),
  'iot.twinSetDesired': Object.freeze({ url: 'dxosBlocks:twinSetDesired', method: 'post', label: 'Đặt ngưỡng Twin' }),
});

const UNSAFE_QR_RE = /[\x00-\x1f\x7f<>\\]|(?:javascript|data|vbscript):|\.\./i;
const URN_FULL_RE = /^urn:ngsi-ld:([A-Za-z][A-Za-z0-9_-]{0,47}):([a-zA-Z0-9._-]{1,64}):([a-zA-Z0-9._-]{1,32}):([a-zA-Z0-9._-]{1,64})$/;
const URN_SHORT_RE = /^urn:ngsi-ld:([A-Za-z][A-Za-z0-9_-]{0,47}):([a-zA-Z0-9._-]{1,64})$/;
const ENTITY_ID_RE = /^[a-zA-Z0-9:._-]{1,255}$/;
const TRACKING_CODE_RE = /^LDX-TRK-[A-Z0-9-]{4,64}$/i;
const TRACKING_TOKEN_RE = /^ldx_trk_[a-zA-Z0-9_-]{8,128}$/;
const LOT_CODE_RE = /^LOT-[A-Z0-9._-]{1,64}$/i;
const ORDER_CODE_RE = /^ORD-[A-Z0-9._-]{1,64}$/i;

let fallbackIdCounter = 0;

function generateQueueId() {
  if (typeof globalThis !== 'undefined' && globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return 'mq-' + globalThis.crypto.randomUUID();
  }
  fallbackIdCounter = (fallbackIdCounter + 1) % 1000000;
  return 'mq-' + Date.now().toString(36) + '-' + fallbackIdCounter.toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function resolveStorage(storageOrOpts) {
  if (storageOrOpts && typeof storageOrOpts.getItem === 'function' && typeof storageOrOpts.setItem === 'function') {
    return storageOrOpts;
  }
  const candidate = storageOrOpts && storageOrOpts.storage ? storageOrOpts.storage : null;
  if (candidate && typeof candidate.getItem === 'function' && typeof candidate.setItem === 'function') {
    return candidate;
  }
  if (typeof window !== 'undefined' && window.localStorage && typeof window.localStorage.getItem === 'function') {
    return window.localStorage;
  }
  return null;
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

function cloneSafePayload(payload) {
  if (!isPlainObject(payload)) {
    throw Object.assign(new Error('Dữ liệu hàng đợi phải là đối tượng JSON hợp lệ.'), { code: 'INVALID_OFFLINE_PAYLOAD' });
  }
  try {
    const stripped = stripForbiddenKeys(payload);
    if (!isPlainObject(stripped)) {
      throw Object.assign(new Error('Dữ liệu hàng đợi phải là đối tượng JSON hợp lệ.'), { code: 'INVALID_OFFLINE_PAYLOAD' });
    }
    const serialized = JSON.stringify(stripped);
    if (typeof serialized !== 'string' || serialized.length > MAX_OFFLINE_PAYLOAD_BYTES) {
      throw Object.assign(new Error('Dữ liệu hàng đợi vượt quá kích thước cho phép.'), { code: 'INVALID_OFFLINE_PAYLOAD' });
    }
    return JSON.parse(serialized);
  } catch (err) {
    if (err && err.code === 'INVALID_OFFLINE_PAYLOAD') throw err;
    throw Object.assign(new Error('Không thể tuần tự hóa dữ liệu hàng đợi.'), { code: 'INVALID_OFFLINE_PAYLOAD' });
  }
}

function sanitizeStoredQueueItem(raw) {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.id !== 'string' || !raw.id.trim()) return null;
  const spec = Object.hasOwn(ALLOWED_OFFLINE_ACTIONS, raw.actionType) ? ALLOWED_OFFLINE_ACTIONS[raw.actionType] : null;
  if (!spec) return null;
  if (!isPlainObject(raw.payload)) return null;
  const strippedPayload = stripForbiddenKeys(raw.payload);
  if (!isPlainObject(strippedPayload)) return null;
  if (
    strippedPayload.signatureDataUrl !== undefined
    && (typeof strippedPayload.signatureDataUrl !== 'string' || strippedPayload.signatureDataUrl.length > MAX_OFFLINE_PAYLOAD_BYTES)
  ) {
    return null;
  }
  let cleanPayload;
  try {
    const serialized = JSON.stringify(strippedPayload);
    if (typeof serialized !== 'string' || serialized.length > MAX_OFFLINE_PAYLOAD_BYTES) return null;
    cleanPayload = JSON.parse(serialized);
  } catch {
    return null;
  }
  return {
    id: raw.id.trim().slice(0, 128),
    actionType: raw.actionType,
    endpoint: spec.url,
    payload: cleanPayload,
    createdAt: typeof raw.createdAt === 'string' && raw.createdAt ? raw.createdAt : new Date().toISOString(),
    attempts: Number.isInteger(raw.attempts) && raw.attempts >= 0 ? raw.attempts : 0,
    lastError: typeof raw.lastError === 'string' ? raw.lastError.slice(0, 240) : null,
  };
}

function writeOfflineQueue(items, storage) {
  if (!storage || typeof storage.setItem !== 'function') {
    throw Object.assign(new Error('Trình duyệt không hỗ trợ bộ nhớ ngoại tuyến.'), { code: 'OFFLINE_STORAGE_UNAVAILABLE' });
  }
  const bounded = Array.isArray(items) ? items.slice(0, MAX_OFFLINE_QUEUE_ITEMS) : [];
  try {
    storage.setItem(OFFLINE_QUEUE_STORAGE_KEY, JSON.stringify(bounded));
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

function readOfflineQueue(storageOrOpts = {}) {
  const storage = resolveStorage(storageOrOpts);
  if (!storage) return [];
  try {
    const raw = storage.getItem(OFFLINE_QUEUE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const clean = [];
    for (const entry of parsed) {
      const sanitized = sanitizeStoredQueueItem(entry);
      if (sanitized) clean.push(sanitized);
      if (clean.length >= MAX_OFFLINE_QUEUE_ITEMS) break;
    }
    return clean;
  } catch {
    return [];
  }
}

function enqueueOfflineAction(entry, opts = {}) {
  const storage = resolveStorage(opts && opts.storage ? opts.storage : entry && entry.storage ? entry.storage : null);
  if (!storage) {
    throw Object.assign(new Error('Bộ nhớ ngoại tuyến không khả dụng.'), { code: 'OFFLINE_STORAGE_UNAVAILABLE' });
  }
  const actionType = entry && typeof entry.actionType === 'string' ? entry.actionType.trim() : '';
  const spec = Object.hasOwn(ALLOWED_OFFLINE_ACTIONS, actionType) ? ALLOWED_OFFLINE_ACTIONS[actionType] : null;
  if (!spec) {
    throw Object.assign(new Error('Loại thao tác ngoại tuyến không được hỗ trợ.'), { code: 'UNSUPPORTED_OFFLINE_ACTION' });
  }
  const safePayload = cloneSafePayload(entry ? entry.payload : null);
  const current = readOfflineQueue({ storage });
  if (current.length >= MAX_OFFLINE_QUEUE_ITEMS) {
    throw Object.assign(
      new Error('Hàng đợi ngoại tuyến đã đạt giới hạn tối đa ' + MAX_OFFLINE_QUEUE_ITEMS + ' tác vụ.'),
      { code: 'OFFLINE_QUEUE_FULL' },
    );
  }
  const item = {
    id: generateQueueId(),
    actionType,
    endpoint: spec.url,
    payload: safePayload,
    createdAt: new Date().toISOString(),
    attempts: 0,
    lastError: null,
  };
  const next = writeOfflineQueue([...current, item], storage);
  return { item, queue: next };
}

function removeOfflineQueueItem(id, storageOrOpts = {}) {
  const storage = resolveStorage(storageOrOpts);
  if (!storage) return [];
  const targetId = typeof id === 'string' ? id.trim() : '';
  const current = readOfflineQueue({ storage });
  const next = current.filter((item) => item.id !== targetId);
  return writeOfflineQueue(next, storage);
}

function extractHttpStatus(err) {
  const raw = err && (err.status ?? err.statusCode ?? (err.response && err.response.status));
  const code = Number(raw);
  return Number.isInteger(code) && code >= 100 && code < 600 ? code : 0;
}

function isPermanentRejectionStatus(status) {
  return status === 400 || status === 403 || status === 404 || status === 422;
}

function isTransientOrNetworkFailure(err) {
  const status = extractHttpStatus(err);
  if (!status) return true;
  return status === 408 || status === 429 || status >= 500;
}

async function flushOfflineQueue({ apiClient, storage, onProgress, isOnline } = {}) {
  const resolvedStorage = resolveStorage(storage);
  const initialQueue = readOfflineQueue({ storage: resolvedStorage });
  const online = typeof isOnline === 'boolean'
    ? isOnline
    : (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean' ? navigator.onLine : true);

  if (!online || initialQueue.length === 0) {
    return {
      total: initialQueue.length,
      synced: 0,
      failed: 0,
      deferred: online ? 0 : initialQueue.length,
      remaining: initialQueue,
      results: [],
    };
  }

  if (!apiClient || typeof apiClient.request !== 'function') {
    throw Object.assign(new Error('Thiếu apiClient để đồng bộ hàng đợi ngoại tuyến.'), { code: 'API_CLIENT_REQUIRED' });
  }

  let synced = 0;
  let failed = 0;
  let deferred = 0;
  const results = [];
  const dropIds = new Set();
  const updatedDeferredMap = new Map();

  for (let i = 0; i < initialQueue.length; i += 1) {
    const item = initialQueue[i];
    const spec = Object.hasOwn(ALLOWED_OFFLINE_ACTIONS, item.actionType) ? ALLOWED_OFFLINE_ACTIONS[item.actionType] : null;
    if (!spec) {
      failed += 1;
      dropIds.add(item.id);
      results.push({ id: item.id, actionType: item.actionType, status: 'failed', httpStatus: 400, error: 'Unsupported action' });
      if (typeof onProgress === 'function') {
        onProgress({ processed: i + 1, total: initialQueue.length, synced, failed, deferred, itemId: item.id, outcome: 'failed' });
      }
      continue;
    }

    try {
      const response = await apiClient.request({ url: spec.url, method: spec.method, data: item.payload });
      synced += 1;
      dropIds.add(item.id);
      results.push({
        id: item.id,
        actionType: item.actionType,
        status: 'synced',
        response: response && response.data !== undefined ? response.data : response,
      });
      if (typeof onProgress === 'function') {
        onProgress({ processed: i + 1, total: initialQueue.length, synced, failed, deferred, itemId: item.id, outcome: 'synced' });
      }
    } catch (err) {
      const status = extractHttpStatus(err);
      const message = String(err && err.message ? err.message : 'Network error').slice(0, 240);
      if (isPermanentRejectionStatus(status)) {
        // Drop permanently invalid 400/403/404/422 mutations rather than looping forever.
        failed += 1;
        dropIds.add(item.id);
        results.push({ id: item.id, actionType: item.actionType, status: 'failed', httpStatus: status, error: message });
        if (typeof onProgress === 'function') {
          onProgress({ processed: i + 1, total: initialQueue.length, synced, failed, deferred, itemId: item.id, outcome: 'failed' });
        }
      } else {
        deferred += 1;
        const retriedItem = {
          ...item,
          attempts: (Number(item.attempts) || 0) + 1,
          lastError: message,
        };
        updatedDeferredMap.set(item.id, retriedItem);
        results.push({ id: item.id, actionType: item.actionType, status: 'deferred', httpStatus: status || null, error: message });
        if (typeof onProgress === 'function') {
          onProgress({ processed: i + 1, total: initialQueue.length, synced, failed, deferred, itemId: item.id, outcome: 'deferred' });
        }
      }
    }
  }

  // Re-read storage so items enqueued concurrently during async flush are preserved.
  const latestQueue = readOfflineQueue({ storage: resolvedStorage });
  const finalQueue = [];
  for (const currentItem of latestQueue) {
    if (dropIds.has(currentItem.id)) continue;
    finalQueue.push(updatedDeferredMap.get(currentItem.id) || currentItem);
  }
  const persisted = resolvedStorage ? writeOfflineQueue(finalQueue, resolvedStorage) : finalQueue;

  return {
    total: initialQueue.length,
    synced,
    failed,
    deferred,
    remaining: persisted,
    results,
  };
}

function rejectQr(error) {
  return { valid: false, kind: null, error };
}

function hasUnsafeKeyInRawJson(rawText) {
  return /"(?:__proto__|constructor|prototype)"\s*:/.test(rawText);
}

function parseStrictFiniteNumber(val) {
  if (typeof val !== 'number' && typeof val !== 'string') return null;
  if (typeof val === 'string' && val.trim() === '') return null;
  const num = Number(val);
  return Number.isFinite(num) ? num : null;
}

function parsePositiveInt(val) {
  if (typeof val === 'number') {
    return Number.isSafeInteger(val) && val > 0 ? val : null;
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (!/^[1-9]\d{0,18}$/.test(trimmed)) return null;
    const num = Number(trimmed);
    return Number.isSafeInteger(num) && num > 0 ? num : null;
  }
  return null;
}

function parseTwinTarget(rawTarget) {
  const numericId = parsePositiveInt(rawTarget);
  if (numericId !== null) {
    return { assetId: numericId, assetEntityId: null, label: `Asset #${numericId}` };
  }
  if (typeof rawTarget !== 'string') return null;
  const trimmed = rawTarget.trim();
  if (!trimmed || UNSAFE_QR_RE.test(trimmed) || !ENTITY_ID_RE.test(trimmed)) return null;
  const fullMatch = URN_FULL_RE.exec(trimmed);
  if (fullMatch) {
    if (fullMatch[3] === 'native' && parsePositiveInt(fullMatch[4]) === null) return null;
    return { assetId: null, assetEntityId: trimmed, label: trimmed };
  }
  const shortMatch = URN_SHORT_RE.exec(trimmed);
  if (shortMatch) {
    if (shortMatch[1] === 'Asset' && /^\d+$/.test(shortMatch[2]) && parsePositiveInt(shortMatch[2]) === null) return null;
    return { assetId: null, assetEntityId: trimmed, label: trimmed };
  }
  return null;
}

function parseFieldQrPayload(raw) {
  if (typeof raw !== 'string') return rejectQr('Payload QR phải là chuỗi ký tự.');
  if (raw.length > MAX_QR_PAYLOAD_LENGTH) return rejectQr('Payload QR vượt quá độ dài tối đa 2048 ký tự.');
  const text = raw.trim();
  if (!text) return rejectQr('Payload QR rỗng.');
  if (UNSAFE_QR_RE.test(text)) return rejectQr('Payload QR chứa ký tự hoặc lược đồ không an toàn.');

  if (text.startsWith('{') && text.endsWith('}')) {
    if (hasUnsafeKeyInRawJson(text)) return rejectQr('Payload JSON QR chứa khóa không hợp lệ.');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return rejectQr('Payload JSON QR không hợp lệ.');
    }
    if (!isPlainObject(parsed)) return rejectQr('Payload JSON QR phải là đối tượng JSON.');

    const extracted = { valid: true, kind: 'json', raw: text };
    let matchedCount = 0;

    const urnRaw = parsed.urn || parsed.assetUrn || parsed.assetEntityId || parsed.entityId;
    if (typeof urnRaw === 'string') {
      const trimmedUrn = urnRaw.trim();
      const m = URN_FULL_RE.exec(trimmedUrn);
      if (m) {
        extracted.urn = trimmedUrn;
        extracted.entityType = m[1];
        extracted.organizationId = m[2];
        extracted.entityId = m[4];
        const urnAssetId = parsePositiveInt(m[4]);
        if (urnAssetId !== null) extracted.assetId = urnAssetId;
        matchedCount += 1;
      } else {
        const ms = URN_SHORT_RE.exec(trimmedUrn);
        if (ms) {
          extracted.urn = trimmedUrn;
          extracted.entityType = ms[1];
          extracted.entityId = ms[2];
          const urnAssetId = parsePositiveInt(ms[2]);
          if (urnAssetId !== null) extracted.assetId = urnAssetId;
          matchedCount += 1;
        }
      }
    }
    if (typeof parsed.trackingCode === 'string' && TRACKING_CODE_RE.test(parsed.trackingCode.trim())) {
      extracted.trackingCode = parsed.trackingCode.trim().toUpperCase();
      matchedCount += 1;
    }
    if (typeof parsed.trackingToken === 'string' && TRACKING_TOKEN_RE.test(parsed.trackingToken.trim())) {
      extracted.trackingToken = parsed.trackingToken.trim();
    }
    if (typeof parsed.lotCode === 'string' && LOT_CODE_RE.test(parsed.lotCode.trim())) {
      extracted.lotCode = parsed.lotCode.trim().toUpperCase();
      matchedCount += 1;
    }
    if (typeof parsed.orderCode === 'string' && ORDER_CODE_RE.test(parsed.orderCode.trim())) {
      extracted.orderCode = parsed.orderCode.trim().toUpperCase();
      matchedCount += 1;
    }
    const orderId = parsePositiveInt(parsed.orderId);
    if (orderId !== null) {
      extracted.orderId = orderId;
      matchedCount += 1;
    }
    const assetId = parsePositiveInt(parsed.assetId);
    if (assetId !== null) {
      extracted.assetId = assetId;
      matchedCount += 1;
    }
    const targetTemp = parsed.targetTempC !== undefined ? parsed.targetTempC : parsed.setpointC;
    if (targetTemp !== undefined && targetTemp !== null) {
      const tempNum = parseStrictFiniteNumber(targetTemp);
      if (tempNum === null || tempNum < -80 || tempNum > 120) {
        return rejectQr('Nhiệt độ mục tiêu (targetTempC) trong QR phải là số hữu hạn trong khoảng [-80, 120] °C.');
      }
      extracted.targetTempC = tempNum;
      matchedCount += 1;
    }
    if (matchedCount === 0) {
      return rejectQr('Payload JSON QR không chứa mã định danh LatticeDX hợp lệ.');
    }
    return extracted;
  }

  const urnFullMatch = URN_FULL_RE.exec(text);
  if (urnFullMatch) {
    const entityId = urnFullMatch[4];
    return {
      valid: true,
      kind: 'urn',
      raw: text,
      urn: text,
      entityType: urnFullMatch[1],
      organizationId: urnFullMatch[2],
      source: urnFullMatch[3],
      entityId,
      assetId: parsePositiveInt(entityId),
    };
  }

  const urnShortMatch = URN_SHORT_RE.exec(text);
  if (urnShortMatch) {
    const entityId = urnShortMatch[2];
    return {
      valid: true,
      kind: 'urn',
      raw: text,
      urn: text,
      entityType: urnShortMatch[1],
      organizationId: null,
      source: null,
      entityId,
      assetId: parsePositiveInt(entityId),
    };
  }

  if (TRACKING_CODE_RE.test(text)) {
    return { valid: true, kind: 'tracking', raw: text, trackingCode: text.toUpperCase() };
  }
  if (LOT_CODE_RE.test(text)) {
    return { valid: true, kind: 'lot', raw: text, lotCode: text.toUpperCase() };
  }
  if (ORDER_CODE_RE.test(text)) {
    return { valid: true, kind: 'order', raw: text, orderCode: text.toUpperCase() };
  }

  return rejectQr('Mã QR/Barcode không đúng định dạng URN, LDX-TRK-, LOT-, ORD- hoặc JSON hợp lệ.');
}

function buildEpodPayload(fields = {}) {
  const recipientName = typeof fields.recipientName === 'string' ? fields.recipientName.trim().slice(0, 128) : '';
  if (!recipientName) {
    return { ok: false, error: 'Vui lòng nhập tên người nhận hàng.' };
  }

  const qtyIsBlank = fields.deliveredQty === undefined
    || fields.deliveredQty === null
    || (typeof fields.deliveredQty === 'string' && fields.deliveredQty.trim() === '');
  const rawQty = qtyIsBlank ? 0 : parseStrictFiniteNumber(fields.deliveredQty);
  if (rawQty === null || rawQty < 0) {
    return { ok: false, error: 'Số lượng giao phải là số không âm.' };
  }

  const gpsLat = parseStrictFiniteNumber(fields.gpsLat);
  const gpsLng = parseStrictFiniteNumber(fields.gpsLng);
  if (gpsLat === null || gpsLat < -90 || gpsLat > 90 || gpsLng === null || gpsLng < -180 || gpsLng > 180) {
    return { ok: false, error: 'Cần tọa độ GPS hợp lệ (Lat [-90..90], Lng [-180..180]).' };
  }

  const signatureDataUrl = typeof fields.signatureDataUrl === 'string' ? fields.signatureDataUrl.trim() : '';
  if (!signatureDataUrl || signatureDataUrl.length < 4 || !signatureDataUrl.startsWith('data:image/')) {
    return { ok: false, error: 'Vui lòng ký xác nhận trên khung chữ ký ePOD.' };
  }
  if (signatureDataUrl.length > 256 * 1024) {
    return { ok: false, error: 'Chữ ký ePOD vượt quá giới hạn 256KB.' };
  }

  const payload = {
    recipientName,
    deliveredQty: rawQty,
    gpsLat,
    gpsLng,
    signatureDataUrl,
    deliveredAt: new Date().toISOString(),
  };

  if (typeof fields.orderCode === 'string' && fields.orderCode.trim()) {
    payload.orderCode = fields.orderCode.trim().slice(0, 64);
  }
  const parsedOrderId = parsePositiveInt(fields.orderId);
  if (parsedOrderId !== null) {
    payload.orderId = parsedOrderId;
  }
  if (typeof fields.recipientPhone === 'string' && fields.recipientPhone.trim()) {
    payload.recipientPhone = fields.recipientPhone.trim().slice(0, 32);
  }
  if (
    fields.gpsAccuracyM !== undefined
    && fields.gpsAccuracyM !== null
    && (typeof fields.gpsAccuracyM !== 'string' || fields.gpsAccuracyM.trim() !== '')
  ) {
    const acc = parseStrictFiniteNumber(fields.gpsAccuracyM);
    if (acc !== null && acc >= 0) payload.gpsAccuracyM = acc;
  }
  if (typeof fields.notes === 'string' && fields.notes.trim()) {
    payload.notes = fields.notes.trim().slice(0, 500);
  }
  return { ok: true, payload };
}

function createMobileFieldPwaPage(client, React, app) {
  // Resolve hook selection safely without accessing React.createElement or hooks at load() time.
  const useApiHook = typeof client?.useAPIClient === 'function'
    ? client.useAPIClient
    : typeof client?.useApp === 'function'
      ? () => client.useApp()?.apiClient || app?.apiClient || null
      : () => app?.apiClient || null;

  return function MobileFieldPwaPage(props = {}) {
    const h = React.createElement;
    const hookApi = useApiHook();
    const apiClient = props.apiClient || hookApi || app?.apiClient || null;
    const storage = props.storage || (typeof window !== 'undefined' ? window.localStorage : null);

    const [isOnline, setIsOnline] = React.useState(() => (
      typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean' ? navigator.onLine : true
    ));
    const [queueItems, setQueueItems] = React.useState(() => readOfflineQueue({ storage }));
    const [syncing, setSyncing] = React.useState(false);

    const [qrInput, setQrInput] = React.useState('');
    const [qrResult, setQrResult] = React.useState(null);
    const [scannerActive, setScannerActive] = React.useState(false);
    const [scannerStream, setScannerStream] = React.useState(null);
    const [scannerNote, setScannerNote] = React.useState('');

    const [orderCode, setOrderCode] = React.useState('');
    const [orderId, setOrderId] = React.useState('');
    const [recipientName, setRecipientName] = React.useState('');
    const [recipientPhone, setRecipientPhone] = React.useState('');
    const [deliveredQty, setDeliveredQty] = React.useState('1');
    const [notes, setNotes] = React.useState('');

    const [gpsLat, setGpsLat] = React.useState('');
    const [gpsLng, setGpsLng] = React.useState('');
    const [gpsAccuracyM, setGpsAccuracyM] = React.useState(null);
    const [gpsPending, setGpsPending] = React.useState(false);

    const [hasSignature, setHasSignature] = React.useState(false);
    const [signatureDataUrl, setSignatureDataUrl] = React.useState('');
    const [submitting, setSubmitting] = React.useState(false);
    const [receipt, setReceipt] = React.useState(null);
    const [statusNotice, setStatusNotice] = React.useState(null);

    const [twinAssetId, setTwinAssetId] = React.useState('');
    const [twinTargetTempC, setTwinTargetTempC] = React.useState('');

    const canvasRef = React.useRef(null);
    const videoRef = React.useRef(null);
    const drawingRef = React.useRef(false);
    const streamRef = React.useRef(null);
    const handleSyncRef = React.useRef(null);
    const syncingRef = React.useRef(false);
    const syncPromiseRef = React.useRef(null);
    const storageRef = React.useRef(storage);
    storageRef.current = storage;
    const mountedRef = React.useRef(true);
    const scannerStartSeqRef = React.useRef(0);

    const handleSync = React.useCallback(async (overrideOnline) => {
      if (syncingRef.current) {
        return syncPromiseRef.current || null;
      }
      if (!apiClient || typeof apiClient.request !== 'function') {
        setStatusNotice({ type: 'warn', text: 'Chưa sẵn sàng kết nối API để đồng bộ.' });
        return null;
      }
      const effectiveOnline = typeof overrideOnline === 'boolean' ? overrideOnline : isOnline;
      syncingRef.current = true;
      setSyncing(true);
      const run = (async () => {
        try {
          const res = await flushOfflineQueue({ apiClient, storage, isOnline: effectiveOnline });
          setQueueItems(res.remaining);
          const hasUnauthorized = Array.isArray(res.results)
            && res.results.some((r) => r.status === 'deferred' && r.httpStatus === 401);
          if (hasUnauthorized) {
            setStatusNotice({
              type: 'warn',
              text: `Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại (giữ ${res.deferred} tác vụ trong hàng đợi${res.synced > 0 ? `, đã đồng bộ ${res.synced}` : ''}${res.failed > 0 ? `, ${res.failed} lỗi vĩnh viễn` : ''}).`,
            });
          } else if (res.synced > 0 || res.failed > 0) {
            setStatusNotice({
              type: res.failed > 0 ? 'warn' : 'success',
              text: `Đồng bộ xong: ${res.synced} thành công, ${res.failed} lỗi vĩnh viễn, ${res.deferred} chờ thử lại.`,
            });
          } else if (res.deferred > 0) {
            setStatusNotice({ type: 'warn', text: `Vẫn ngoại tuyến hoặc mất kết nối — giữ ${res.deferred} tác vụ trong hàng đợi.` });
          } else {
            setStatusNotice({ type: 'info', text: 'Hàng đợi ngoại tuyến đang trống.' });
          }
          return res;
        } catch (err) {
          setStatusNotice({
            type: 'error',
            text: (err && err.message) || 'Không thể đồng bộ hàng đợi ngoại tuyến.',
          });
          return null;
        } finally {
          syncingRef.current = false;
          syncPromiseRef.current = null;
          setSyncing(false);
        }
      })();
      syncPromiseRef.current = run;
      return run;
    }, [apiClient, storage, isOnline]);

    handleSyncRef.current = handleSync;

    React.useEffect(() => {
      mountedRef.current = true;
      // Inject PWA manifest link + register Service Worker cleanly once on mount in browser runtime.
      if (typeof document !== 'undefined' && document.head) {
        if (typeof document.querySelector === 'function' && !document.querySelector('link[rel="manifest"]')) {
          const link = document.createElement('link');
          link.rel = 'manifest';
          link.href = '/api/dxos:manifest';
          link.setAttribute?.('data-dxos-pwa', '1');
          document.head.appendChild(link);
        }
      }
      if (typeof navigator !== 'undefined' && navigator.serviceWorker && typeof navigator.serviceWorker.register === 'function') {
        navigator.serviceWorker.register('/api/dxos:sw.js', { scope: '/' }).catch(() => undefined);
      }

      const hasWindowEvents = typeof window !== 'undefined' && typeof window.addEventListener === 'function';
      const onOnline = () => {
        setIsOnline(true);
        if (readOfflineQueue({ storage: storageRef.current }).length === 0) {
          return undefined;
        }
        return handleSyncRef.current?.(true)?.catch(() => undefined);
      };
      const onOffline = () => setIsOnline(false);

      if (hasWindowEvents) {
        window.addEventListener('online', onOnline);
        window.addEventListener('offline', onOffline);
      }
      return () => {
        mountedRef.current = false;
        scannerStartSeqRef.current += 1;
        if (hasWindowEvents) {
          window.removeEventListener?.('online', onOnline);
          window.removeEventListener?.('offline', onOffline);
        }
        if (streamRef.current && typeof streamRef.current.getTracks === 'function') {
          for (const tr of streamRef.current.getTracks()) tr.stop?.();
          streamRef.current = null;
        }
      };
    }, []);

    const applyParsedQr = React.useCallback((rawText) => {
      const parsed = parseFieldQrPayload(rawText);
      setQrResult(parsed);
      if (!parsed.valid) {
        setStatusNotice({ type: 'error', text: parsed.error });
        return parsed;
      }
      if (parsed.orderCode) setOrderCode(parsed.orderCode);
      if (parsed.orderId) setOrderId(String(parsed.orderId));
      if (parsed.assetId) {
        setTwinAssetId(String(parsed.assetId));
      } else if (parsed.urn) {
        setTwinAssetId(parsed.urn);
      }
      if (parsed.targetTempC !== undefined) setTwinTargetTempC(String(parsed.targetTempC));
      if (parsed.lotCode) {
        setNotes((prev) => (prev && prev.includes(parsed.lotCode) ? prev : [prev, `Lô: ${parsed.lotCode}`].filter(Boolean).join(' | ')));
      }
      if (parsed.trackingCode) {
        setNotes((prev) => (prev && prev.includes(parsed.trackingCode) ? prev : [prev, `Vận đơn: ${parsed.trackingCode}`].filter(Boolean).join(' | ')));
      }
      setStatusNotice({ type: 'success', text: `Đã nhận diện mã QR (${parsed.kind.toUpperCase()}).` });
      return parsed;
    }, []);

    const stopScanner = React.useCallback(() => {
      scannerStartSeqRef.current += 1;
      setScannerActive(false);
      setScannerStream(null);
      if (videoRef.current && videoRef.current.srcObject) {
        videoRef.current.srcObject = null;
      }
      if (streamRef.current && typeof streamRef.current.getTracks === 'function') {
        for (const tr of streamRef.current.getTracks()) tr.stop?.();
        streamRef.current = null;
      }
    }, []);

    const startCameraScanner = React.useCallback(async () => {
      const hasMedia = typeof navigator !== 'undefined' && navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function';
      const Detector = typeof window !== 'undefined' && typeof window.BarcodeDetector === 'function' ? window.BarcodeDetector : null;
      if (!hasMedia || !Detector) {
        setScannerNote('Thiết bị/trình duyệt chưa hỗ trợ Camera BarcodeDetector — vui lòng nhập mã QR thủ công bên dưới.');
        return;
      }
      const startSeq = ++scannerStartSeqRef.current;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (!mountedRef.current || scannerStartSeqRef.current !== startSeq) {
          if (stream && typeof stream.getTracks === 'function') {
            for (const tr of stream.getTracks()) tr.stop?.();
          }
          return;
        }
        if (streamRef.current && streamRef.current !== stream && typeof streamRef.current.getTracks === 'function') {
          for (const tr of streamRef.current.getTracks()) tr.stop?.();
        }
        streamRef.current = stream;
        setScannerStream(stream);
        setScannerActive(true);
        setScannerNote('Đang bật camera quét mã QR...');
      } catch {
        setScannerNote('Không mở được camera. Hãy cấp quyền camera hoặc dùng ô nhập thủ công.');
        stopScanner();
      }
    }, [stopScanner]);

    React.useEffect(() => {
      if (!scannerActive) return undefined;
      const activeStream = scannerStream || streamRef.current;
      const videoEl = videoRef.current;
      if (!activeStream || !videoEl) return undefined;

      let cancelled = false;
      let rafId = null;

      videoEl.srcObject = activeStream;
      Promise.resolve(videoEl.play?.()).catch(() => undefined);

      const Detector = typeof window !== 'undefined' && typeof window.BarcodeDetector === 'function' ? window.BarcodeDetector : null;
      if (Detector) {
        const detector = new Detector({ formats: ['qr_code', 'code_128', 'ean_13'] });
        const scanTick = async () => {
          if (cancelled || !streamRef.current || !videoRef.current) return;
          try {
            const codes = await detector.detect(videoRef.current);
            if (!cancelled && Array.isArray(codes) && codes.length > 0 && codes[0].rawValue) {
              const rawVal = String(codes[0].rawValue);
              setQrInput(rawVal);
              applyParsedQr(rawVal);
              stopScanner();
              return;
            }
          } catch {
            // Continue scanning on frame error
          }
          if (!cancelled && streamRef.current && typeof requestAnimationFrame === 'function') {
            rafId = requestAnimationFrame(scanTick);
          }
        };
        if (typeof requestAnimationFrame === 'function') {
          rafId = requestAnimationFrame(scanTick);
        }
      }

      return () => {
        cancelled = true;
        if (rafId !== null && typeof cancelAnimationFrame === 'function') {
          cancelAnimationFrame(rafId);
        }
        if (videoRef.current && videoRef.current.srcObject === activeStream) {
          videoRef.current.srcObject = null;
        }
        if (typeof activeStream.getTracks === 'function') {
          for (const tr of activeStream.getTracks()) tr.stop?.();
        }
        if (streamRef.current === activeStream) {
          streamRef.current = null;
        }
      };
    }, [scannerActive, scannerStream, applyParsedQr, stopScanner]);

    const captureGps = React.useCallback(() => {
      const geo = typeof navigator !== 'undefined' ? navigator.geolocation : null;
      if (!geo || typeof geo.getCurrentPosition !== 'function') {
        setStatusNotice({ type: 'warn', text: 'Trình duyệt không có Geolocation API — hãy nhập Lat/Lng thủ công.' });
        return;
      }
      setGpsPending(true);
      geo.getCurrentPosition(
        (pos) => {
          const coords = pos && pos.coords ? pos.coords : {};
          setGpsLat(String(Number(coords.latitude).toFixed(6).replace(/\.?0+$/, '') || coords.latitude));
          setGpsLng(String(Number(coords.longitude).toFixed(6).replace(/\.?0+$/, '') || coords.longitude));
          setGpsAccuracyM(Number.isFinite(coords.accuracy) ? Number(coords.accuracy.toFixed(1)) : null);
          setGpsPending(false);
          setStatusNotice({ type: 'success', text: 'Đã ghi nhận tọa độ GPS hiện trường.' });
        },
        (err) => {
          setGpsPending(false);
          setStatusNotice({ type: 'error', text: `Không lấy được GPS (${err?.message || 'Permission denied'}).` });
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 15000 },
      );
    }, []);

    const getCanvasPoint = (ev) => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };
      const rect = typeof canvas.getBoundingClientRect === 'function'
        ? canvas.getBoundingClientRect()
        : { left: 0, top: 0, width: canvas.width || 440, height: canvas.height || 160 };
      const scaleX = (canvas.width || 440) / (rect.width || 1);
      const scaleY = (canvas.height || 160) / (rect.height || 1);
      return {
        x: ((ev?.clientX ?? 0) - rect.left) * scaleX,
        y: ((ev?.clientY ?? 0) - rect.top) * scaleY,
      };
    };

    const handlePointerDown = (ev) => {
      const canvas = canvasRef.current;
      const ctx = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
      drawingRef.current = true;
      setHasSignature(true);
      ev?.currentTarget?.setPointerCapture?.(ev.pointerId);
      if (ctx) {
        const pt = getCanvasPoint(ev);
        ctx.lineWidth = 2.5;
        ctx.lineCap = 'round';
        ctx.strokeStyle = '#0f172a';
        ctx.beginPath();
        ctx.moveTo(pt.x, pt.y);
      }
    };

    const handlePointerMove = (ev) => {
      if (!drawingRef.current) return;
      const canvas = canvasRef.current;
      const ctx = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
      if (ctx) {
        const pt = getCanvasPoint(ev);
        ctx.lineTo(pt.x, pt.y);
        ctx.stroke();
      }
    };

    const handlePointerUp = (ev) => {
      if (!drawingRef.current) return;
      drawingRef.current = false;
      ev?.currentTarget?.releasePointerCapture?.(ev.pointerId);
      const canvas = canvasRef.current;
      if (canvas && typeof canvas.toDataURL === 'function') {
        setSignatureDataUrl(canvas.toDataURL('image/png'));
      }
    };

    const clearSignature = () => {
      drawingRef.current = false;
      setHasSignature(false);
      setSignatureDataUrl('');
      const canvas = canvasRef.current;
      const ctx = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
      if (ctx && canvas) {
        ctx.clearRect(0, 0, canvas.width || 440, canvas.height || 160);
      }
    };

    const tryEnqueueOffline = React.useCallback((actionType, payload, buildNoticeText) => {
      try {
        const queued = enqueueOfflineAction({ actionType, payload }, { storage });
        setQueueItems(queued.queue);
        setStatusNotice({ type: 'warn', text: buildNoticeText(queued.queue.length) });
        return { queued: true, item: queued.item };
      } catch (queueErr) {
        const errorText = queueErr && queueErr.code === 'OFFLINE_QUEUE_FULL'
          ? `Hàng đợi ngoại tuyến đã đầy (${MAX_OFFLINE_QUEUE_ITEMS}/${MAX_OFFLINE_QUEUE_ITEMS}). Vui lòng kết nối mạng và đồng bộ trước khi lưu thêm.`
          : queueErr && queueErr.code === 'OFFLINE_STORAGE_QUOTA_EXCEEDED'
            ? 'Bộ nhớ ngoại tuyến đã đầy (vượt dung lượng lưu trữ). Vui lòng đồng bộ hoặc giải phóng bộ nhớ trước khi lưu tiếp.'
            : (queueErr && queueErr.message) || 'Không thể lưu tác vụ vào hàng đợi ngoại tuyến.';
        setStatusNotice({ type: 'error', text: errorText });
        return null;
      }
    }, [storage]);

    const submitEpod = async (ev) => {
      ev?.preventDefault?.();
      const liveCanvasUrl = hasSignature && canvasRef.current && typeof canvasRef.current.toDataURL === 'function'
        ? canvasRef.current.toDataURL('image/png')
        : '';
      const finalSig = liveCanvasUrl || signatureDataUrl || '';

      const built = buildEpodPayload({
        orderCode,
        orderId,
        recipientName,
        recipientPhone,
        deliveredQty,
        gpsLat,
        gpsLng,
        gpsAccuracyM,
        notes,
        signatureDataUrl: finalSig,
      });
      if (!built.ok) {
        setStatusNotice({ type: 'error', text: built.error });
        return null;
      }

      if (!isOnline || !apiClient || typeof apiClient.request !== 'function') {
        return tryEnqueueOffline(
          'wms.epodCapture',
          built.payload,
          (len) => `Đang ngoại tuyến — đã lưu ePOD vào hàng đợi (${len}/${MAX_OFFLINE_QUEUE_ITEMS}).`,
        );
      }

      setSubmitting(true);
      try {
        const res = await apiClient.request({ url: 'dxosWms:epodCapture', method: 'post', data: built.payload });
        const body = res && res.data ? (res.data.data || res.data) : {};
        const epod = body.epod || {};
        setReceipt({
          trackingCode: body.trackingCode || epod.trackingCode || 'LDX-TRK-OK',
          epodUid: epod.epodUid || 'EPOD',
          ledgerSeq: epod.ledgerSeq ?? null,
          deliveredAt: built.payload.deliveredAt,
        });
        setStatusNotice({ type: 'success', text: `Đã ghi nhận ePOD thành công (${body.trackingCode || epod.trackingCode || 'OK'}).` });
        return body;
      } catch (err) {
        if (isTransientOrNetworkFailure(err)) {
          return tryEnqueueOffline(
            'wms.epodCapture',
            built.payload,
            (len) => `Mất kết nối máy chủ — đã tự động xếp hàng đợi ePOD (${len}/${MAX_OFFLINE_QUEUE_ITEMS}).`,
          );
        }
        const errMsg = err?.response?.data?.errors?.[0]?.message || err?.message || 'Không thể gửi ePOD.';
        setStatusNotice({ type: 'error', text: errMsg });
        return null;
      } finally {
        setSubmitting(false);
      }
    };

    const submitTwinDesired = async (ev) => {
      ev?.preventDefault?.();
      const target = parseTwinTarget(twinAssetId);
      const tempNum = parseStrictFiniteNumber(twinTargetTempC);
      if (!target || tempNum === null || tempNum < -80 || tempNum > 120) {
        setStatusNotice({
          type: 'error',
          text: 'Cần Asset ID dương hoặc URN hợp lệ và nhiệt độ mục tiêu trong khoảng [-80, 120] °C.',
        });
        return null;
      }
      const payload = target.assetId !== null
        ? { assetId: target.assetId, desiredPatch: { targetTempC: tempNum } }
        : { assetEntityId: target.assetEntityId, desiredPatch: { targetTempC: tempNum } };
      if (!isOnline || !apiClient || typeof apiClient.request !== 'function') {
        return tryEnqueueOffline(
          'iot.twinSetDesired',
          payload,
          (len) => `Đã xếp hàng đợi lệnh Digital Twin (${len}/${MAX_OFFLINE_QUEUE_ITEMS}).`,
        );
      }
      try {
        const res = await apiClient.request({ url: 'dxosBlocks:twinSetDesired', method: 'post', data: payload });
        const body = res && res.data ? (res.data.data || res.data) : (res || {});
        if (body && body.gatedByHitl === true) {
          const approvalLabel = body.approvalId != null ? ` (Approval #${body.approvalId})` : '';
          setStatusNotice({
            type: 'warn',
            text: `Thay đổi vượt ngưỡng an toàn — đã tạo yêu cầu phê duyệt HITL${approvalLabel} cho ${target.label} (${tempNum}°C).`,
          });
          return { ok: true, gatedByHitl: true, approvalId: body.approvalId ?? null, data: body };
        }
        setStatusNotice({ type: 'success', text: `Đã gửi lệnh Digital Twin tới ${target.label} (${tempNum}°C).` });
        return { ok: true, data: body };
      } catch (err) {
        if (isTransientOrNetworkFailure(err)) {
          return tryEnqueueOffline(
            'iot.twinSetDesired',
            payload,
            (len) => `Mất mạng — đã lưu lệnh Digital Twin vào hàng đợi (${len}/${MAX_OFFLINE_QUEUE_ITEMS}).`,
          );
        }
        const errMsg = err?.response?.data?.errors?.[0]?.message || err?.message || 'Không thể gửi lệnh Digital Twin.';
        setStatusNotice({ type: 'error', text: errMsg });
        return null;
      }
    };

    const cardStyle = {
      background: '#1e293b',
      border: '1px solid #334155',
      borderRadius: 12,
      padding: 14,
      marginBottom: 14,
    };
    const labelStyle = {
      display: 'block',
      fontSize: 13,
      fontWeight: 600,
      color: '#cbd5e1',
      marginBottom: 6,
    };
    const inputStyle = {
      width: '100%',
      minHeight: 44,
      padding: '10px 12px',
      borderRadius: 8,
      border: '1px solid #475569',
      background: '#0f172a',
      color: '#f8fafc',
      fontSize: 15,
      boxSizing: 'border-box',
      marginBottom: 10,
    };
    const btnPrimaryStyle = {
      width: '100%',
      minHeight: 44,
      padding: '10px 14px',
      borderRadius: 8,
      border: 'none',
      background: '#0284c7',
      color: '#ffffff',
      fontWeight: 700,
      fontSize: 15,
      cursor: 'pointer',
    };
    const btnSecondaryStyle = {
      minHeight: 44,
      padding: '10px 14px',
      borderRadius: 8,
      border: '1px solid #475569',
      background: '#334155',
      color: '#f8fafc',
      fontWeight: 600,
      fontSize: 14,
      cursor: 'pointer',
    };

    return h('div', {
      'data-testid': 'mobile-pwa-root',
      style: {
        maxWidth: 520,
        margin: '0 auto',
        minHeight: '100vh',
        background: '#0f172a',
        color: '#f8fafc',
        padding: 16,
        fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
        boxSizing: 'border-box',
      },
    },
      // Header
      h('header', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 } },
        h('div', null,
          h('div', { style: { fontSize: 18, fontWeight: 800, letterSpacing: '-0.02em' } }, 'LatticeDX Field PWA'),
          h('div', { style: { fontSize: 12, color: '#94a3b8' } }, 'Giao nhận hiện trường · /v/mobile'),
        ),
        h('span', {
          'data-testid': 'mobile-pwa-queue-badge',
          style: {
            padding: '6px 10px',
            borderRadius: 999,
            background: queueItems.length > 0 ? '#b45309' : '#1e293b',
            border: '1px solid #475569',
            fontSize: 12,
            fontWeight: 700,
          },
        }, `Hàng đợi: ${queueItems.length}`),
      ),

      // Network Banner + Sync Action
      h('section', {
        'data-testid': 'mobile-pwa-network-banner',
        style: {
          ...cardStyle,
          background: isOnline ? '#064e3b' : '#78350f',
          borderColor: isOnline ? '#10b981' : '#f59e0b',
          display: 'flex',
          flexWrap: 'wrap',
          gap: 10,
          alignItems: 'center',
          justifyContent: 'space-between',
        },
      },
        h('div', { style: { fontSize: 13, fontWeight: 700 } },
          isOnline ? 'Trực tuyến (Online) — Sẵn sàng đồng bộ' : 'Ngoại tuyến (Offline) — Lưu cục bộ an toàn',
        ),
        h('button', {
          type: 'button',
          'data-testid': 'mobile-pwa-sync-btn',
          disabled: syncing,
          onClick: handleSync,
          style: { ...btnSecondaryStyle, background: '#0f172a', borderColor: '#94a3b8' },
        }, syncing ? 'Đang đồng bộ...' : 'Đồng bộ ngay (Sync)'),
      ),

      // Status Notice
      statusNotice ? h('div', {
        role: 'status',
        'data-testid': 'mobile-pwa-status-notice',
        style: {
          ...cardStyle,
          background: statusNotice.type === 'error' ? '#7f1d1d' : statusNotice.type === 'warn' ? '#78350f' : '#1e3a8a',
          borderColor: statusNotice.type === 'error' ? '#ef4444' : statusNotice.type === 'warn' ? '#f59e0b' : '#3b82f6',
          fontSize: 13,
          fontWeight: 600,
        },
      }, statusNotice.text) : null,

      // QR Scanner Card
      h('section', { style: cardStyle },
        h('div', { style: { fontSize: 15, fontWeight: 700, marginBottom: 10 } }, '1. Quét mã QR / Barcode (Đơn hàng, Lô, URN)'),
        h('div', { style: { display: 'flex', gap: 8, marginBottom: 10 } },
          h('button', {
            type: 'button',
            'data-testid': 'mobile-pwa-qr-scan-btn',
            onClick: scannerActive ? stopScanner : startCameraScanner,
            style: { ...btnSecondaryStyle, flex: 1 },
          }, scannerActive ? 'Dừng Camera' : 'Quét QR bằng Camera'),
        ),
        scannerActive ? h('video', {
          ref: videoRef,
          muted: true,
          playsInline: true,
          style: { width: '100%', maxHeight: 200, borderRadius: 8, background: '#000', marginBottom: 10 },
        }) : null,
        scannerNote ? h('div', { style: { fontSize: 12, color: '#fbbf24', marginBottom: 8 } }, scannerNote) : null,
        h('label', { style: labelStyle, htmlFor: 'mobile-qr-input' }, 'Nhập / dán mã QR (ORD-..., LOT-..., LDX-TRK-..., urn:ngsi-ld:...)'),
        h('div', { style: { display: 'flex', gap: 8 } },
          h('input', {
            id: 'mobile-qr-input',
            type: 'text',
            'data-testid': 'mobile-pwa-qr-input',
            value: qrInput,
            onChange: (e) => setQrInput(e.target.value),
            placeholder: 'ORD-2026-001 hoặc urn:ngsi-ld:Asset:...',
            style: { ...inputStyle, marginBottom: 0, flex: 1 },
          }),
          h('button', {
            type: 'button',
            'data-testid': 'mobile-pwa-qr-parse-btn',
            onClick: () => applyParsedQr(qrInput),
            style: { ...btnSecondaryStyle, whiteSpace: 'nowrap' },
          }, 'Áp dụng'),
        ),
        qrResult ? h('div', {
          'data-testid': 'mobile-pwa-qr-result',
          style: { marginTop: 8, fontSize: 12, color: qrResult.valid ? '#34d399' : '#f87171' },
        }, qrResult.valid ? `Hợp lệ [${qrResult.kind}]: ${qrResult.orderCode || qrResult.trackingCode || qrResult.lotCode || qrResult.urn || 'OK'}` : qrResult.error) : null,
      ),

      // ePOD Capture Form + GPS + Canvas Signature
      h('section', { style: cardStyle },
        h('div', { style: { fontSize: 15, fontWeight: 700, marginBottom: 10 } }, '2. Ghi nhận Giao hàng Điện tử (ePOD)'),
        h('label', { style: labelStyle, htmlFor: 'mobile-order-input' }, 'Mã đơn hàng (Order Code)'),
        h('input', {
          id: 'mobile-order-input',
          type: 'text',
          'data-testid': 'mobile-pwa-order-input',
          value: orderCode,
          onChange: (e) => setOrderCode(e.target.value),
          placeholder: 'ORD-2026-001',
          style: inputStyle,
        }),
        h('label', { style: labelStyle, htmlFor: 'mobile-recipient-input' }, 'Người nhận hàng *'),
        h('input', {
          id: 'mobile-recipient-input',
          type: 'text',
          'data-testid': 'mobile-pwa-recipient-input',
          value: recipientName,
          onChange: (e) => setRecipientName(e.target.value),
          placeholder: 'Nguyễn Văn A',
          style: inputStyle,
        }),
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 120px', gap: 8 } },
          h('div', null,
            h('label', { style: labelStyle, htmlFor: 'mobile-phone-input' }, 'SĐT người nhận'),
            h('input', {
              id: 'mobile-phone-input',
              type: 'tel',
              'data-testid': 'mobile-pwa-phone-input',
              value: recipientPhone,
              onChange: (e) => setRecipientPhone(e.target.value),
              placeholder: '090xxxxxxx',
              style: inputStyle,
            }),
          ),
          h('div', null,
            h('label', { style: labelStyle, htmlFor: 'mobile-qty-input' }, 'Số lượng giao'),
            h('input', {
              id: 'mobile-qty-input',
              type: 'number',
              min: 0,
              'data-testid': 'mobile-pwa-qty-input',
              value: deliveredQty,
              onChange: (e) => setDeliveredQty(e.target.value),
              style: inputStyle,
            }),
          ),
        ),

        // GPS Capture
        h('div', { style: { marginBottom: 10 } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, gap: 8 } },
            h('span', { style: { ...labelStyle, marginBottom: 0 } }, 'Tọa độ GPS *'),
            h('button', {
              type: 'button',
              'data-testid': 'mobile-pwa-gps-btn',
              disabled: gpsPending,
              onClick: captureGps,
              style: btnSecondaryStyle,
            }, gpsPending ? 'Đang định vị...' : 'Lấy tọa độ GPS'),
          ),
          h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 } },
            h('input', {
              type: 'number',
              step: 'any',
              'data-testid': 'mobile-pwa-lat-input',
              value: gpsLat,
              onChange: (e) => setGpsLat(e.target.value),
              placeholder: 'Latitude (vd: 10.0452)',
              style: { ...inputStyle, marginBottom: 4 },
            }),
            h('input', {
              type: 'number',
              step: 'any',
              'data-testid': 'mobile-pwa-lng-input',
              value: gpsLng,
              onChange: (e) => setGpsLng(e.target.value),
              placeholder: 'Longitude (vd: 105.7469)',
              style: { ...inputStyle, marginBottom: 4 },
            }),
          ),
          h('div', {
            'data-testid': 'mobile-pwa-gps-display',
            style: { fontSize: 12, color: '#94a3b8' },
          }, gpsLat && gpsLng
            ? `GPS: ${gpsLat}, ${gpsLng}${gpsAccuracyM != null ? ` (±${gpsAccuracyM}m)` : ''}`
            : 'Chưa có tọa độ GPS.'),
        ),

        // Canvas Signature Pad
        h('div', { style: { marginBottom: 12 } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 } },
            h('span', { style: { ...labelStyle, marginBottom: 0 } }, 'Chữ ký tay người nhận *'),
            h('button', {
              type: 'button',
              'data-testid': 'mobile-pwa-signature-clear',
              onClick: clearSignature,
              style: btnSecondaryStyle,
            }, 'Xóa chữ ký'),
          ),
          h('canvas', {
            ref: canvasRef,
            width: 440,
            height: 160,
            'data-testid': 'mobile-pwa-signature-canvas',
            onPointerDown: handlePointerDown,
            onPointerMove: handlePointerMove,
            onPointerUp: handlePointerUp,
            onPointerCancel: handlePointerUp,
            style: {
              width: '100%',
              height: 160,
              background: '#ffffff',
              borderRadius: 8,
              border: '2px solid #475569',
              touchAction: 'none',
              display: 'block',
            },
          }),
        ),

        h('label', { style: labelStyle, htmlFor: 'mobile-notes-input' }, 'Ghi chú hiện trường'),
        h('input', {
          id: 'mobile-notes-input',
          type: 'text',
          'data-testid': 'mobile-pwa-notes-input',
          value: notes,
          onChange: (e) => setNotes(e.target.value),
          placeholder: 'Tình trạng kiện hàng / nhiệt độ...',
          style: inputStyle,
        }),

        h('button', {
          type: 'button',
          'data-testid': 'mobile-pwa-epod-submit',
          disabled: submitting,
          onClick: submitEpod,
          style: btnPrimaryStyle,
        }, submitting ? 'Đang gửi ePOD...' : 'Xác nhận Giao hàng (ePOD)'),
      ),

      // ePOD Confirmation Receipt
      receipt ? h('section', {
        'data-testid': 'mobile-pwa-epod-receipt',
        style: { ...cardStyle, background: '#064e3b', borderColor: '#10b981' },
      },
        h('div', { style: { fontSize: 15, fontWeight: 800, marginBottom: 6 } }, 'Chứng thư ePOD đã ký số PKI'),
        h('div', { style: { fontSize: 13 } }, `Mã vận đơn QR: ${receipt.trackingCode}`),
        h('div', { style: { fontSize: 13 } }, `Mã ePOD: ${receipt.epodUid}`),
        receipt.ledgerSeq != null ? h('div', { style: { fontSize: 12, color: '#a7f3d0' } }, `Sổ cái Ledger Seq #${receipt.ledgerSeq}`) : null,
      ) : null,

      // Quick Digital Twin Setpoint Card
      h('section', { style: cardStyle },
        h('div', { style: { fontSize: 14, fontWeight: 700, marginBottom: 8 } }, '3. Điều khiển nhanh Digital Twin Kho lạnh'),
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 } },
          h('input', {
            type: 'text',
            'data-testid': 'mobile-pwa-twin-asset-input',
            value: twinAssetId,
            onChange: (e) => setTwinAssetId(e.target.value),
            placeholder: 'Asset ID hoặc URN (vd: 12)',
            style: inputStyle,
          }),
          h('input', {
            type: 'number',
            step: '0.1',
            'data-testid': 'mobile-pwa-twin-temp-input',
            value: twinTargetTempC,
            onChange: (e) => setTwinTargetTempC(e.target.value),
            placeholder: 'Nhiệt độ °C (vd: -18)',
            style: inputStyle,
          }),
        ),
        h('button', {
          type: 'button',
          'data-testid': 'mobile-pwa-twin-submit',
          onClick: submitTwinDesired,
          style: { ...btnSecondaryStyle, width: '100%' },
        }, 'Gửi lệnh Digital Twin'),
      ),
    );
  };
}

module.exports = {
  OFFLINE_QUEUE_STORAGE_KEY,
  MAX_OFFLINE_QUEUE_ITEMS,
  ALLOWED_OFFLINE_ACTIONS,
  sanitizeStoredQueueItem,
  enqueueOfflineAction,
  readOfflineQueue,
  flushOfflineQueue,
  removeOfflineQueueItem,
  parseFieldQrPayload,
  buildEpodPayload,
  createMobileFieldPwaPage,
};
