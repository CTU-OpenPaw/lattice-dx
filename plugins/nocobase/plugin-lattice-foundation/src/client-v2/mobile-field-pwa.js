/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const {
  OUTBOX_STORAGE_KEY,
  MAX_OUTBOX_ITEMS,
  MAX_PHOTO_DATA_URL_BYTES,
  ALLOWED_OFFLINE_ACTIONS,
  isQuotaExceededError,
  isValidRasterImageDataUrl,
  isIndexedDbAvailable,
  sanitizeOutboxItem,
  resolveStorage,
  readSyncFallbackOutbox,
  writeSyncFallbackOutbox,
  enqueueSyncFallbackOutbox,
  removeSyncFallbackOutbox,
  enqueueOutboxItem,
  listOutboxItems,
  removeOutboxItem,
  updateOutboxStatus,
} = require('./mobile-offline-db');
const { subscribeSurfaceEvents } = require('../client/sse-hub');

const OFFLINE_QUEUE_STORAGE_KEY = OUTBOX_STORAGE_KEY;
const MAX_OFFLINE_QUEUE_ITEMS = MAX_OUTBOX_ITEMS;
const MAX_QR_PAYLOAD_LENGTH = 2048;

const UNSAFE_QR_RE = /[\x00-\x1f\x7f<>\\]|(?:javascript|data|vbscript):|\.\./i;
const URN_FULL_RE = /^urn:ngsi-ld:([A-Za-z][A-Za-z0-9_-]{0,47}):([a-zA-Z0-9._-]{1,64}):([a-zA-Z0-9._-]{1,32}):([a-zA-Z0-9._-]{1,64})$/;
const URN_SHORT_RE = /^urn:ngsi-ld:([A-Za-z][A-Za-z0-9_-]{0,47}):([a-zA-Z0-9._-]{1,64})$/;
const ENTITY_ID_RE = /^[a-zA-Z0-9:._-]{1,255}$/;
const TRACKING_CODE_RE = /^LDX-TRK-[A-Z0-9-]{4,64}$/i;
const TRACKING_TOKEN_RE = /^ldx_trk_[a-zA-Z0-9_-]{8,128}$/;
const LOT_CODE_RE = /^LOT-[A-Z0-9._-]{1,64}$/i;
const ORDER_CODE_RE = /^ORD-[A-Z0-9._-]{1,64}$/i;

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const sanitizeStoredQueueItem = sanitizeOutboxItem;
const readOfflineQueue = readSyncFallbackOutbox;
const enqueueOfflineAction = enqueueSyncFallbackOutbox;
const removeOfflineQueueItem = removeSyncFallbackOutbox;

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

async function flushOfflineQueue({ apiClient, storage, indexedDB, onProgress, isOnline } = {}) {
  const resolvedStorage = resolveStorage(storage);
  const outboxOpts = {
    storage: resolvedStorage,
    ...(indexedDB !== undefined ? { indexedDB } : {}),
  };
  const hasIdb = isIndexedDbAvailable(outboxOpts);
  const initialQueue = hasIdb
    ? await listOutboxItems(outboxOpts)
    : readSyncFallbackOutbox({ storage: resolvedStorage });
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
      if (hasIdb) {
        await removeOutboxItem(item.id, outboxOpts).catch(() => undefined);
      }
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
      if (hasIdb) {
        await removeOutboxItem(item.id, outboxOpts).catch(() => undefined);
      }
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
        if (hasIdb) {
          await removeOutboxItem(item.id, outboxOpts).catch(() => undefined);
        }
        results.push({ id: item.id, actionType: item.actionType, status: 'failed', httpStatus: status, error: message });
        if (typeof onProgress === 'function') {
          onProgress({ processed: i + 1, total: initialQueue.length, synced, failed, deferred, itemId: item.id, outcome: 'failed' });
        }
      } else {
        deferred += 1;
        const nextAttempts = (Number(item.attempts) || 0) + 1;
        const retriedItem = {
          ...item,
          status: 'failed',
          attempts: nextAttempts,
          lastError: message,
          httpStatus: status || null,
          updatedAt: new Date().toISOString(),
        };
        updatedDeferredMap.set(item.id, retriedItem);
        if (hasIdb) {
          await updateOutboxStatus(item.id, {
            status: 'failed',
            attempts: nextAttempts,
            lastError: message,
            httpStatus: status || null,
          }, outboxOpts).catch(() => undefined);
        }
        results.push({ id: item.id, actionType: item.actionType, status: 'deferred', httpStatus: status || null, error: message });
        if (typeof onProgress === 'function') {
          onProgress({ processed: i + 1, total: initialQueue.length, synced, failed, deferred, itemId: item.id, outcome: 'deferred' });
        }
      }
    }
  }

  let persisted;
  if (hasIdb) {
    persisted = await listOutboxItems(outboxOpts);
  } else {
    // Re-read storage so items enqueued concurrently during async flush are preserved.
    const latestQueue = readSyncFallbackOutbox({ storage: resolvedStorage });
    const finalQueue = [];
    for (const currentItem of latestQueue) {
      if (dropIds.has(currentItem.id)) continue;
      finalQueue.push(updatedDeferredMap.get(currentItem.id) || currentItem);
    }
    persisted = resolvedStorage ? writeSyncFallbackOutbox(finalQueue, resolvedStorage) : finalQueue;
  }

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

  if (
    fields.evidencePhotoDataUrl !== undefined
    && fields.evidencePhotoDataUrl !== null
    && String(fields.evidencePhotoDataUrl).trim() !== ''
  ) {
    const photoUrl = typeof fields.evidencePhotoDataUrl === 'string' ? fields.evidencePhotoDataUrl.trim() : '';
    if (!isValidRasterImageDataUrl(photoUrl, MAX_PHOTO_DATA_URL_BYTES)) {
      return { ok: false, error: 'Ảnh minh chứng ePOD phải là ảnh PNG/JPEG/WebP hợp lệ và tối đa 512KB.' };
    }
    payload.evidencePhotoDataUrl = photoUrl;
  }

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

function resolveClientAuthToken(api, storage) {
  if (!api) return '';
  try {
    const t = typeof api.auth?.getToken === 'function' ? api.auth.getToken() : '';
    if (typeof t === 'string' && t.trim()) return t.trim();
  } catch {}
  try {
    const t = api.auth?.token;
    if (typeof t === 'string' && t.trim()) return t.trim();
  } catch {}
  try {
    if (storage && typeof storage.getItem === 'function') {
      const t = storage.getItem('NOCOBASE_TOKEN');
      if (typeof t === 'string' && t.trim()) return t.trim();
    }
    if (typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function') {
      const t = localStorage.getItem('NOCOBASE_TOKEN');
      if (typeof t === 'string' && t.trim()) return t.trim();
    }
  } catch {}
  return '';
}

function parseSseChunk(chunk) {
  const normalized = String(chunk || '').replace(/\r\n/g, '\n');
  const blocks = normalized.split('\n\n');
  const rest = blocks.pop() ?? '';
  const frames = [];
  for (const block of blocks) {
    if (!block.trim() || block.startsWith(':')) continue;
    let eventName = 'message';
    const dataLines = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim() || 'message';
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) continue;
    let data = {};
    try { data = JSON.parse(dataLines.join('\n')); } catch { data = { raw: dataLines.join('\n') }; }
    frames.push({ event: eventName, data });
  }
  return { frames, rest };
}

function isAuthenticatedMobileClient(api, storage) {
  if (!api || typeof api.request !== 'function') return false;
  return Boolean(resolveClientAuthToken(api, storage));
}

function formatOutboxItemSummary(item) {
  if (!item || !item.payload) return '';
  if (item.actionType === 'wms.epodCapture') {
    const parts = [];
    if (item.payload.orderCode) parts.push(item.payload.orderCode);
    if (item.payload.recipientName) parts.push(item.payload.recipientName);
    if (item.payload.evidencePhotoDataUrl) parts.push('Có ảnh');
    return parts.join(' · ') || 'ePOD';
  }
  if (item.actionType === 'iot.twinSetDesired') {
    const target = item.payload.assetId != null ? `Asset #${item.payload.assetId}` : (item.payload.assetEntityId || 'Twin');
    const temp = item.payload.desiredPatch?.targetTempC;
    return temp !== undefined ? `${target} → ${temp}°C` : target;
  }
  return item.endpoint || item.actionType;
}

function invokeQrDecoder(decoder, imageData) {
  if (typeof decoder !== 'function' || !imageData) return null;
  try {
    const direct = decoder(imageData);
    if (typeof direct === 'string' && direct.trim()) return direct.trim();
    if (direct && typeof direct.data === 'string' && direct.data.trim()) return direct.data.trim();
  } catch {}
  if (imageData.data && imageData.width && imageData.height) {
    try {
      const res = decoder(imageData.data, imageData.width, imageData.height);
      if (typeof res === 'string' && res.trim()) return res.trim();
      if (res && typeof res.data === 'string' && res.data.trim()) return res.data.trim();
    } catch {}
  }
  return null;
}

function extractAiReplyText(body) {
  if (!body) return '';
  if (typeof body === 'string') return body.trim();
  const direct = body.reply || body.answer || (typeof body.message === 'string' ? body.message : '') || (typeof body.content === 'string' ? body.content : '') || body.text;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  if (body.content && typeof body.content === 'object' && typeof body.content.content === 'string' && body.content.content.trim()) {
    return body.content.content.trim();
  }
  const msgList = body.messages || body.result?.messages || body.result?.history;
  if (Array.isArray(msgList)) {
    for (let i = msgList.length - 1; i >= 0; i -= 1) {
      const m = msgList[i];
      if (!m || m.role === 'user') continue;
      if (typeof m.content === 'string' && m.content.trim()) return m.content.trim();
      if (m.content && typeof m.content.content === 'string' && m.content.content.trim()) return m.content.content.trim();
      if (typeof m.text === 'string' && m.text.trim()) return m.text.trim();
      if (Array.isArray(m.parts)) {
        const txt = m.parts.map((p) => (p && typeof p.text === 'string' ? p.text : '')).filter(Boolean).join('\n').trim();
        if (txt) return txt;
      }
    }
  }
  const artifacts = body.result?.artifacts || body.artifacts;
  if (Array.isArray(artifacts)) {
    const partsText = artifacts
      .flatMap((a) => (Array.isArray(a?.parts) ? a.parts : []))
      .map((p) => (p && typeof p.text === 'string' ? p.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim();
    if (partsText) return partsText;
  }
  return '';
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
    const outboxOpts = React.useMemo(() => ({
      storage,
      ...(props.indexedDB !== undefined ? { indexedDB: props.indexedDB } : {}),
    }), [storage, props.indexedDB]);

    const [isOnline, setIsOnline] = React.useState(() => (
      typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean' ? navigator.onLine : true
    ));
    const [queueItems, setQueueItems] = React.useState(() => readSyncFallbackOutbox({ storage }));
    const [syncing, setSyncing] = React.useState(false);
    const [outboxOpen, setOutboxOpen] = React.useState(false);
    const [retryingItemId, setRetryingItemId] = React.useState(null);
    const [confirmDeleteOutboxId, setConfirmDeleteOutboxId] = React.useState(null);

    const [notifUnreadCount, setNotifUnreadCount] = React.useState(() => {
      const initial = Number(props.notificationUnreadCount);
      return Number.isFinite(initial) && initial >= 0 ? initial : 0;
    });
    const [notifOpen, setNotifOpen] = React.useState(false);
    const [notifItems, setNotifItems] = React.useState([]);
    const [notifLoading, setNotifLoading] = React.useState(false);
    const [notifError, setNotifError] = React.useState('');
    const [notifBusy, setNotifBusy] = React.useState(false);

    const [qrInput, setQrInput] = React.useState('');
    const [qrResult, setQrResult] = React.useState(null);
    const [scannerActive, setScannerActive] = React.useState(false);
    const [scannerStream, setScannerStream] = React.useState(null);
    const [scannerMode, setScannerMode] = React.useState('idle');
    const [scannerNote, setScannerNote] = React.useState('');
    const [qrSnapshotUrl, setQrSnapshotUrl] = React.useState('');

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
    const [evidencePhotoDataUrl, setEvidencePhotoDataUrl] = React.useState('');
    const [photoCameraActive, setPhotoCameraActive] = React.useState(false);
    const [photoCameraStream, setPhotoCameraStream] = React.useState(null);

    const [submitting, setSubmitting] = React.useState(false);
    const [receipt, setReceipt] = React.useState(null);
    const [statusNotice, setStatusNotice] = React.useState(null);

    const [twinAssetId, setTwinAssetId] = React.useState('');
    const [twinTargetTempC, setTwinTargetTempC] = React.useState('');
    const [twinBusy, setTwinBusy] = React.useState(false);

    const [authExpired, setAuthExpired] = React.useState(false);
    const [opsTab, setOpsTab] = React.useState('all');
    const [opsLoading, setOpsLoading] = React.useState(false);
    const [opsErrors, setOpsErrors] = React.useState([]);
    const [incidentsRestricted, setIncidentsRestricted] = React.useState(false);
    const [pendingApprovals, setPendingApprovals] = React.useState(() => (Array.isArray(props.initialApprovals) ? props.initialApprovals : []));
    const [deliveryOrders, setDeliveryOrders] = React.useState(() => (Array.isArray(props.initialDeliveries) ? props.initialDeliveries : []));
    const [incidentCases, setIncidentCases] = React.useState(() => (Array.isArray(props.initialIncidents) ? props.initialIncidents : []));
    const [serviceTickets, setServiceTickets] = React.useState(() => (Array.isArray(props.initialTickets) ? props.initialTickets : []));
    const [decidingApprovalId, setDecidingApprovalId] = React.useState(null);
    const [selectedIncident, setSelectedIncident] = React.useState(null);
    const [selectedTicket, setSelectedTicket] = React.useState(null);
    const [detailChatter, setDetailChatter] = React.useState([]);
    const [detailChatterLoading, setDetailChatterLoading] = React.useState(false);
    const [detailNote, setDetailNote] = React.useState('');
    const [detailBusy, setDetailBusy] = React.useState(false);
    const [createTicketOpen, setCreateTicketOpen] = React.useState(false);
    const [newTicketName, setNewTicketName] = React.useState('');
    const [newTicketType, setNewTicketType] = React.useState('it_support');
    const [newTicketPriority, setNewTicketPriority] = React.useState('medium');
    const [newTicketDesc, setNewTicketDesc] = React.useState('');
    const [ticketCreateBusy, setTicketCreateBusy] = React.useState(false);
    const [aiOpen, setAiOpen] = React.useState(false);
    const [aiPrompt, setAiPrompt] = React.useState('');
    const [aiBusy, setAiBusy] = React.useState(false);
    const [aiMessages, setAiMessages] = React.useState([]);

    // Keep canvasRef as the first useRef(null) to preserve deterministic signature-canvas test ref lookup.
    const canvasRef = React.useRef(null);
    const videoRef = React.useRef(null);
    const drawingRef = React.useRef(false);
    const streamRef = React.useRef(null);
    const handleSyncRef = React.useRef(null);
    const syncingRef = React.useRef(false);
    const syncPromiseRef = React.useRef(null);
    const storageRef = React.useRef(storage);
    storageRef.current = storage;
    const outboxOptsRef = React.useRef(outboxOpts);
    outboxOptsRef.current = outboxOpts;
    const mountedRef = React.useRef(true);
    const scannerStartSeqRef = React.useRef(0);
    const qrCanvasRef = React.useRef(null);
    const photoVideoRef = React.useRef(null);
    const photoStreamRef = React.useRef(null);
    const qrFrameDecoderRef = React.useRef(null);
    qrFrameDecoderRef.current = props.qrFrameDecoder || (typeof window !== 'undefined' ? window.jsQR : null);
    const refreshUnreadCountRef = React.useRef(null);
    const refreshOpsSummaryRef = React.useRef(null);
    const roleCapsRef = React.useRef({ token: null, promise: null, data: null });
    const twinBusyRef = React.useRef(false);
    const aiSessionRef = React.useRef({ token: null, sessionId: null, employee: null });

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
          const res = await flushOfflineQueue({
            apiClient,
            storage: outboxOptsRef.current.storage,
            indexedDB: outboxOptsRef.current.indexedDB,
            isOnline: effectiveOnline,
          });
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
    }, [apiClient, isOnline]);

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

      listOutboxItems(outboxOptsRef.current)
        .then((items) => {
          if (mountedRef.current) setQueueItems(items);
        })
        .catch(() => undefined);

      const hasWindowEvents = typeof window !== 'undefined' && typeof window.addEventListener === 'function';
      const onOnline = async () => {
        setIsOnline(true);
        const current = isIndexedDbAvailable(outboxOptsRef.current)
          ? await listOutboxItems(outboxOptsRef.current).catch(() => [])
          : readSyncFallbackOutbox({ storage: storageRef.current });
        if (current.length === 0) {
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
        if (photoStreamRef.current && typeof photoStreamRef.current.getTracks === 'function') {
          for (const tr of photoStreamRef.current.getTracks()) tr.stop?.();
          photoStreamRef.current = null;
        }
      };
    }, []);

    const refreshUnreadCount = React.useCallback(async () => {
      if (!isAuthenticatedMobileClient(apiClient, storageRef.current)) return null;
      try {
        const res = await apiClient.request({
          url: 'latticeNotifications:unreadCount',
          method: 'get',
          skipNotify: true,
        });
        const count = Number(res?.data?.data?.unreadCount ?? res?.data?.unreadCount ?? 0);
        if (mountedRef.current) {
          setAuthExpired(false);
          if (Number.isFinite(count) && count >= 0) {
            setNotifUnreadCount(count);
          }
        }
        return count;
      } catch (err) {
        if (mountedRef.current && extractHttpStatus(err) === 401) {
          setAuthExpired(true);
        }
        return null;
      }
    }, [apiClient]);

    refreshUnreadCountRef.current = refreshUnreadCount;

    const extractListItems = (res) => {
      const d = res?.data;
      if (Array.isArray(d?.data?.items)) return d.data.items;
      if (Array.isArray(d?.data)) return d.data;
      if (Array.isArray(d?.items)) return d.items;
      if (Array.isArray(d)) return d;
      return [];
    };

    const resolveRoleCapabilities = React.useCallback(async () => {
      if (!apiClient || typeof apiClient.request !== 'function') return {};
      const token = resolveClientAuthToken(apiClient, storageRef.current);
      if (!token) return {};
      const cached = roleCapsRef.current;
      if (cached.token === token && cached.data) return cached.data;
      if (cached.token === token && cached.promise) return cached.promise;
      const promise = (async () => {
        try {
          const res = await apiClient.request({ url: 'roles:check', method: 'get', skipNotify: true });
          const data = res?.data?.data ?? res?.data ?? {};
          roleCapsRef.current = { token, promise: null, data };
          return data;
        } catch (err) {
          if (extractHttpStatus(err) === 401) {
            roleCapsRef.current = { token: null, promise: null, data: null };
            return { __unauthorized: true };
          }
          roleCapsRef.current = { token, promise: null, data: {} };
          return {};
        }
      })();
      roleCapsRef.current = { token, promise, data: null };
      return promise;
    }, [apiClient]);

    const refreshOpsSummary = React.useCallback(async () => {
      if (!isOnline || !isAuthenticatedMobileClient(apiClient, storageRef.current)) return null;
      if (mountedRef.current) {
        setOpsLoading(true);
        setOpsErrors([]);
      }
      try {
        const roleData = await resolveRoleCapabilities();
        if (!mountedRef.current) return null;
        if (roleData?.__unauthorized) {
          setAuthExpired(true);
          return null;
        }
        const hasResourceList = roleData && roleData.allowAll !== true && Array.isArray(roleData.resources);
        const canReadIncidents = !hasResourceList || roleData.resources.includes('latticeIncidentCases');
        const canReadOrders = !hasResourceList || roleData.resources.includes('latticeOrders');
        const canReadTickets = !hasResourceList || roleData.resources.includes('latticeServiceTickets');

        setIncidentsRestricted(!canReadIncidents);
        if (!canReadIncidents) {
          setIncidentCases([]);
        }

        const tasks = [
          {
            key: 'approvals',
            label: 'Phê duyệt',
            apply: (res) => setPendingApprovals(extractListItems(res)),
            promise: apiClient.request({ url: 'dxosApprovals:listInbox', method: 'get', params: { status: 'pending', limit: 5 }, skipNotify: true }),
          },
          ...(canReadOrders ? [{
            key: 'deliveries',
            label: 'Giao nhận',
            apply: (res) => setDeliveryOrders(extractListItems(res)),
            promise: apiClient.request({ url: 'latticeOrders:list', method: 'get', params: { pageSize: 5, sort: ['-updatedAt'] }, skipNotify: true }),
          }] : []),
          ...(canReadIncidents ? [{
            key: 'incidents',
            label: 'Sự cố',
            apply: (res) => setIncidentCases(extractListItems(res)),
            promise: apiClient.request({ url: 'latticeIncidentCases:list', method: 'get', params: { pageSize: 5, sort: ['-createdAt'] }, skipNotify: true }),
          }] : []),
          ...(canReadTickets ? [{
            key: 'tickets',
            label: 'Phiếu dịch vụ',
            apply: (res) => setServiceTickets(extractListItems(res)),
            promise: apiClient.request({ url: 'latticeServiceTickets:list', method: 'get', params: { pageSize: 5, sort: ['-createdAt'] }, skipNotify: true }),
          }] : []),
        ];

        const settled = await Promise.allSettled(tasks.map((t) => t.promise));
        if (!mountedRef.current) return null;
        const errors = [];
        let saw401 = false;
        let sawSuccess = false;
        settled.forEach((outcome, idx) => {
          const task = tasks[idx];
          if (outcome.status === 'fulfilled' && outcome.value) {
            sawSuccess = true;
            task.apply(outcome.value);
          } else if (outcome.status === 'rejected') {
            const status = extractHttpStatus(outcome.reason);
            if (status === 401) {
              saw401 = true;
            } else {
              const message = outcome.reason?.response?.data?.errors?.[0]?.message || outcome.reason?.message || 'Lỗi tải dữ liệu';
              errors.push({ key: task.key, label: task.label, status, message });
            }
          }
        });
        if (saw401) {
          setAuthExpired(true);
        } else if (sawSuccess) {
          setAuthExpired(false);
        }
        setOpsErrors(errors);
        return errors.length === 0 && !saw401;
      } catch (err) {
        if (mountedRef.current && extractHttpStatus(err) === 401) {
          setAuthExpired(true);
        }
        return null;
      } finally {
        if (mountedRef.current) setOpsLoading(false);
      }
    }, [apiClient, isOnline, resolveRoleCapabilities]);

    refreshOpsSummaryRef.current = refreshOpsSummary;

    React.useEffect(() => {
      if (!isAuthenticatedMobileClient(apiClient, storageRef.current)) return undefined;
      refreshUnreadCountRef.current?.();
      refreshOpsSummaryRef.current?.();

      const fetchFn = props.fetchImpl
        || (typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function' ? globalThis.fetch : null)
        || (typeof fetch === 'function' ? fetch : null);
      if (!isOnline || typeof fetchFn !== 'function') return undefined;

      const token = resolveClientAuthToken(apiClient, storageRef.current);
      if (!token) return undefined;

      let disposed = false;
      const baseApi = typeof apiClient?.getBaseURL === 'function' ? apiClient.getBaseURL() : '/api/';
      const prefix = String(baseApi || '/api/').replace(/\/?$/, '/');
      const sseUrl = props.notificationSseUrl || `${prefix}dxosAi:surfaceEvents?portalSlug=mobile`;

      const handleSsePayload = (eventName, parsed) => {
        if (!mountedRef.current || disposed || !parsed || typeof parsed !== 'object') return;
        if (Number.isFinite(Number(parsed.unreadCount)) && Number(parsed.unreadCount) >= 0) {
          setNotifUnreadCount(Number(parsed.unreadCount));
          return;
        }
        const kind = String(parsed.kind || parsed.type || '').trim().toLowerCase();
        if (kind === 'notification' || kind === 'unread_count' || eventName === 'notification' || eventName === 'unread_count') {
          refreshUnreadCountRef.current?.();
          refreshOpsSummaryRef.current?.();
        }
      };

      const unsubscribeSse = subscribeSurfaceEvents({
        portalSlug: 'mobile',
        sseUrl,
        token,
        fetchFn,
        minBackoffMs: 3_000,
        maxBackoffMs: 60_000,
        win: typeof window !== 'undefined' ? window : null,
        onEvent: (eventName, data) => {
          if (['notification', 'unread_count', 'update', 'message'].includes(eventName)) {
            handleSsePayload(eventName, data);
          }
        },
        onAuthError: () => {
          if (!disposed && mountedRef.current) setAuthExpired(true);
        },
      });

      return () => {
        disposed = true;
        unsubscribeSse();
      };
    }, [apiClient, isOnline, props.fetchImpl, props.notificationSseUrl]);

    const loadNotifications = React.useCallback(async () => {
      if (!isAuthenticatedMobileClient(apiClient, storageRef.current)) return;
      setNotifLoading(true);
      setNotifError('');
      try {
        const res = await apiClient.request({
          url: 'latticeNotifications:listMine',
          method: 'get',
          params: { limit: 15 },
          skipNotify: true,
        });
        const data = res?.data?.data || res?.data || {};
        if (mountedRef.current) {
          setAuthExpired(false);
          setNotifItems(Array.isArray(data.items) ? data.items : []);
          if (data.unreadCount != null && Number.isFinite(Number(data.unreadCount))) {
            setNotifUnreadCount(Math.max(0, Number(data.unreadCount)));
          }
        }
      } catch (err) {
        if (mountedRef.current) {
          if (extractHttpStatus(err) === 401) {
            setAuthExpired(true);
          } else {
            const msg = err?.response?.data?.errors?.[0]?.message || err?.message || 'Không thể tải danh sách thông báo.';
            setNotifError(String(msg));
          }
        }
      } finally {
        if (mountedRef.current) setNotifLoading(false);
      }
    }, [apiClient]);

    const toggleNotifications = React.useCallback(async () => {
      const next = !notifOpen;
      setNotifOpen(next);
      if (!next) return;
      await loadNotifications();
    }, [notifOpen, loadNotifications]);

    const markNotifRead = React.useCallback(async (item) => {
      if (!item || item.readAt || !apiClient || typeof apiClient.request !== 'function') return;
      const nowIso = new Date().toISOString();
      setNotifError('');
      setNotifItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, readAt: nowIso } : it)));
      setNotifUnreadCount((c) => Math.max(0, c - 1));
      try {
        await apiClient.request({
          url: 'latticeNotifications:markRead',
          method: 'post',
          data: { id: item.id },
          skipNotify: true,
        });
      } catch (err) {
        if (mountedRef.current) {
          if (extractHttpStatus(err) === 401) setAuthExpired(true);
          else setNotifError(err?.response?.data?.errors?.[0]?.message || err?.message || 'Không thể đánh dấu đã đọc.');
        }
      }
    }, [apiClient]);

    const markAllNotifsRead = React.useCallback(async () => {
      if (notifBusy || !apiClient || typeof apiClient.request !== 'function') return;
      setNotifBusy(true);
      setNotifError('');
      const nowIso = new Date().toISOString();
      setNotifItems((prev) => prev.map((it) => (it.readAt ? it : { ...it, readAt: nowIso })));
      setNotifUnreadCount(0);
      try {
        await apiClient.request({
          url: 'latticeNotifications:markAllRead',
          method: 'post',
          data: {},
          skipNotify: true,
        });
      } catch (err) {
        if (mountedRef.current) {
          if (extractHttpStatus(err) === 401) setAuthExpired(true);
          else setNotifError(err?.response?.data?.errors?.[0]?.message || err?.message || 'Không thể đánh dấu tất cả đã đọc.');
        }
      } finally {
        if (mountedRef.current) setNotifBusy(false);
      }
    }, [apiClient, notifBusy]);

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
      setScannerMode('idle');
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
      if (!hasMedia) {
        setScannerMode('manual_only');
        setScannerNote('Thiết bị/trình duyệt chưa hỗ trợ Camera — vui lòng nhập mã QR thủ công bên dưới.');
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
        setQrSnapshotUrl('');
        setScannerMode(Detector ? 'barcode_detector' : 'camera_canvas_fallback');
        setScannerActive(true);
        setScannerNote(
          Detector
            ? 'Đang bật camera quét mã QR...'
            : 'Trình duyệt không hỗ trợ BarcodeDetector — đang dùng chế độ Camera + Canvas dự phòng (hoặc nhập mã QR thủ công bên dưới).',
        );
      } catch {
        setScannerNote('Không mở được camera. Hãy cấp quyền camera hoặc dùng ô nhập thủ công.');
        stopScanner();
      }
    }, [stopScanner]);

    const captureQrFrameFromVideo = React.useCallback(() => {
      const videoEl = videoRef.current;
      const qrCanvas = qrCanvasRef.current;
      if (!videoEl || !qrCanvas || typeof qrCanvas.getContext !== 'function') {
        setScannerNote('Chưa sẵn sàng khung hình camera/canvas — vui lòng nhập mã QR thủ công.');
        return null;
      }
      const width = Number(videoEl.videoWidth) || Number(qrCanvas.width) || 320;
      const height = Number(videoEl.videoHeight) || Number(qrCanvas.height) || 240;
      qrCanvas.width = width;
      qrCanvas.height = height;
      const ctx = qrCanvas.getContext('2d');
      if (!ctx || typeof ctx.drawImage !== 'function') return null;
      ctx.drawImage(videoEl, 0, 0, width, height);
      if (typeof qrCanvas.toDataURL === 'function') {
        try {
          setQrSnapshotUrl(qrCanvas.toDataURL('image/png'));
        } catch {}
      }
      const decoder = qrFrameDecoderRef.current;
      if (typeof decoder === 'function' && typeof ctx.getImageData === 'function') {
        const imageData = ctx.getImageData(0, 0, width, height);
        const decoded = invokeQrDecoder(decoder, imageData);
        if (decoded) {
          setQrInput(decoded);
          const parsed = applyParsedQr(decoded);
          stopScanner();
          return parsed;
        }
      }
      setScannerNote('Đã chụp khung hình camera — nếu không tự giải mã, hãy dán hoặc nhập mã QR vào ô bên dưới.');
      return null;
    }, [applyParsedQr, stopScanner]);

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
      if (Detector && scannerMode === 'barcode_detector') {
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
    }, [scannerActive, scannerStream, scannerMode, applyParsedQr, stopScanner]);

    const stopPhotoCamera = React.useCallback(() => {
      setPhotoCameraActive(false);
      setPhotoCameraStream(null);
      if (photoVideoRef.current && photoVideoRef.current.srcObject) {
        photoVideoRef.current.srcObject = null;
      }
      if (photoStreamRef.current && typeof photoStreamRef.current.getTracks === 'function') {
        for (const tr of photoStreamRef.current.getTracks()) tr.stop?.();
        photoStreamRef.current = null;
      }
    }, []);

    const startPhotoCamera = React.useCallback(async () => {
      const hasMedia = typeof navigator !== 'undefined' && navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function';
      if (!hasMedia) {
        setStatusNotice({ type: 'warn', text: 'Thiết bị không hỗ trợ camera trực tiếp — hãy dùng nút chọn ảnh từ thiết bị.' });
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (!mountedRef.current) {
          for (const tr of stream.getTracks?.() || []) tr.stop?.();
          return;
        }
        if (photoStreamRef.current && photoStreamRef.current !== stream) {
          for (const tr of photoStreamRef.current.getTracks?.() || []) tr.stop?.();
        }
        photoStreamRef.current = stream;
        setPhotoCameraStream(stream);
        setPhotoCameraActive(true);
      } catch {
        setStatusNotice({ type: 'error', text: 'Không mở được camera chụp ảnh minh chứng.' });
      }
    }, []);

    React.useEffect(() => {
      if (!photoCameraActive) return undefined;
      const activeStream = photoCameraStream || photoStreamRef.current;
      const videoEl = photoVideoRef.current;
      if (!activeStream || !videoEl) return undefined;
      videoEl.srcObject = activeStream;
      Promise.resolve(videoEl.play?.()).catch(() => undefined);
      return () => {
        if (photoVideoRef.current && photoVideoRef.current.srcObject === activeStream) {
          photoVideoRef.current.srcObject = null;
        }
        for (const tr of activeStream.getTracks?.() || []) tr.stop?.();
        if (photoStreamRef.current === activeStream) photoStreamRef.current = null;
      };
    }, [photoCameraActive, photoCameraStream]);

    const capturePhotoSnapshot = React.useCallback(() => {
      const videoEl = photoVideoRef.current;
      if (!videoEl || typeof document === 'undefined' || typeof document.createElement !== 'function') return;
      const canvas = document.createElement('canvas');
      const width = Number(videoEl.videoWidth) || 640;
      const height = Number(videoEl.videoHeight) || 480;
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext?.('2d');
      if (!ctx || typeof ctx.drawImage !== 'function' || typeof canvas.toDataURL !== 'function') return;
      ctx.drawImage(videoEl, 0, 0, width, height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
      if (isValidRasterImageDataUrl(dataUrl, MAX_PHOTO_DATA_URL_BYTES)) {
        setEvidencePhotoDataUrl(dataUrl);
        setStatusNotice({ type: 'success', text: 'Đã chụp ảnh minh chứng giao hàng.' });
      } else {
        setStatusNotice({ type: 'error', text: 'Ảnh chụp vượt quá giới hạn 512KB.' });
      }
      stopPhotoCamera();
    }, [stopPhotoCamera]);

    const handlePhotoFileChange = React.useCallback((ev) => {
      const file = ev?.target?.files?.[0];
      if (!file) return;
      const fileType = String(file.type || '').toLowerCase();
      if (fileType && (!fileType.startsWith('image/') || fileType.includes('svg'))) {
        setStatusNotice({ type: 'error', text: 'Chỉ chấp nhận ảnh PNG, JPEG hoặc WebP.' });
        return;
      }
      const ReaderCtor = typeof FileReader !== 'undefined' ? FileReader : globalThis.FileReader;
      if (typeof ReaderCtor !== 'function') {
        setStatusNotice({ type: 'error', text: 'Trình duyệt không hỗ trợ đọc tệp ảnh.' });
        return;
      }
      const reader = new ReaderCtor();
      reader.onload = () => {
        const resultUrl = typeof reader.result === 'string' ? reader.result.trim() : '';
        if (!isValidRasterImageDataUrl(resultUrl, MAX_PHOTO_DATA_URL_BYTES)) {
          setStatusNotice({ type: 'error', text: 'Ảnh minh chứng không hợp lệ hoặc vượt quá 512KB.' });
          return;
        }
        setEvidencePhotoDataUrl(resultUrl);
        setStatusNotice({ type: 'success', text: 'Đã đính kèm ảnh minh chứng giao hàng.' });
      };
      reader.onerror = () => {
        setStatusNotice({ type: 'error', text: 'Không thể đọc tệp ảnh đã chọn.' });
      };
      reader.readAsDataURL(file);
    }, []);

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

    const tryEnqueueOffline = React.useCallback(async (actionType, payload, buildNoticeText) => {
      try {
        const queuedItem = await enqueueOutboxItem({ actionType, payload }, outboxOptsRef.current);
        const nextQueue = await listOutboxItems(outboxOptsRef.current);
        setQueueItems(nextQueue);
        setStatusNotice({ type: 'warn', text: buildNoticeText(nextQueue.length) });
        return { queued: true, item: queuedItem };
      } catch (queueErr) {
        const errorText = queueErr && queueErr.code === 'OFFLINE_QUEUE_FULL'
          ? `Hàng đợi ngoại tuyến đã đầy (${MAX_OFFLINE_QUEUE_ITEMS}/${MAX_OFFLINE_QUEUE_ITEMS}). Vui lòng kết nối mạng và đồng bộ trước khi lưu thêm.`
          : (queueErr && (queueErr.code === 'OFFLINE_STORAGE_QUOTA_EXCEEDED' || isQuotaExceededError(queueErr)))
            ? 'Bộ nhớ ngoại tuyến đã đầy (vượt dung lượng lưu trữ). Vui lòng đồng bộ hoặc giải phóng bộ nhớ trước khi lưu tiếp.'
            : (queueErr && queueErr.message) || 'Không thể lưu tác vụ vào hàng đợi ngoại tuyến.';
        setStatusNotice({ type: 'error', text: errorText });
        return null;
      }
    }, []);

    const retrySingleOutboxItem = React.useCallback(async (item) => {
      if (!item || !item.id) return null;
      if (!apiClient || typeof apiClient.request !== 'function') {
        setStatusNotice({ type: 'warn', text: 'Chưa sẵn sàng kết nối API để thử lại.' });
        return null;
      }
      const spec = Object.hasOwn(ALLOWED_OFFLINE_ACTIONS, item.actionType) ? ALLOWED_OFFLINE_ACTIONS[item.actionType] : null;
      if (!spec) return null;

      setRetryingItemId(item.id);
      try {
        await updateOutboxStatus(item.id, 'syncing', outboxOptsRef.current);
        await apiClient.request({ url: spec.url, method: spec.method, data: item.payload });
        const remaining = await removeOutboxItem(item.id, outboxOptsRef.current);
        setQueueItems(remaining);
        setStatusNotice({ type: 'success', text: `Đã đồng bộ thành công tác vụ ${formatOutboxItemSummary(item)}.` });
        return { ok: true, remaining };
      } catch (err) {
        const status = extractHttpStatus(err);
        const msg = String(err && err.message ? err.message : 'Network error').slice(0, 240);
        await updateOutboxStatus(item.id, {
          status: 'failed',
          attempts: (Number(item.attempts) || 0) + 1,
          lastError: msg,
          httpStatus: status || null,
        }, outboxOptsRef.current);
        const refreshed = await listOutboxItems(outboxOptsRef.current);
        setQueueItems(refreshed);
        setStatusNotice({ type: 'error', text: `Thử lại thất bại: ${msg}` });
        return { ok: false, error: msg };
      } finally {
        setRetryingItemId(null);
      }
    }, [apiClient]);

    const deleteSingleOutboxItem = React.useCallback(async (id) => {
      const remaining = await removeOutboxItem(id, outboxOptsRef.current);
      setQueueItems(remaining);
      setStatusNotice({ type: 'info', text: 'Đã xóa tác vụ khỏi hàng đợi ngoại tuyến.' });
      return remaining;
    }, []);

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
        evidencePhotoDataUrl,
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
      if (twinBusyRef.current) return null;
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
      twinBusyRef.current = true;
      setTwinBusy(true);
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
        if (extractHttpStatus(err) === 401 && mountedRef.current) {
          setAuthExpired(true);
        }
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
      } finally {
        twinBusyRef.current = false;
        if (mountedRef.current) setTwinBusy(false);
      }
    };

    const decideMobileApproval = React.useCallback(async (item, decision) => {
      if (!item || !apiClient || typeof apiClient.request !== 'function') return null;
      const itemKey = String(item.id ?? item.requestUid ?? '');
      setDecidingApprovalId(itemKey);
      try {
        await apiClient.request({
          url: 'dxosApprovals:decide',
          method: 'post',
          data: {
            source: item.source || 'approval',
            ...(item.id != null ? { id: item.id } : {}),
            ...(item.requestUid ? { requestUid: item.requestUid } : {}),
            decision,
          },
        });
        setPendingApprovals((prev) => prev.filter((x) => String(x.id ?? x.requestUid ?? '') !== itemKey));
        setStatusNotice({
          type: 'success',
          text: decision === 'approved'
            ? `Đã phê duyệt: ${item.title || item.targetCode || itemKey}.`
            : `Đã từ chối: ${item.title || item.targetCode || itemKey}.`,
        });
        return true;
      } catch (err) {
        if (extractHttpStatus(err) === 401 && mountedRef.current) setAuthExpired(true);
        const errMsg = err?.response?.data?.errors?.[0]?.message || err?.message || 'Không thể xử lý phê duyệt.';
        setStatusNotice({ type: 'error', text: errMsg });
        return null;
      } finally {
        setDecidingApprovalId(null);
      }
    }, [apiClient]);

    const selectOrderForEpod = React.useCallback((order) => {
      if (!order) return;
      if (order.code) setOrderCode(String(order.code));
      if (order.id != null) setOrderId(String(order.id));
      setStatusNotice({ type: 'info', text: `Đã chọn đơn giao nhận ${order.code || `#${order.id}`} vào biểu mẫu ePOD.` });
    }, []);

    const loadDetailChatter = React.useCallback(async (targetCollection, targetRecordId) => {
      if (!apiClient || typeof apiClient.request !== 'function' || !targetRecordId) {
        setDetailChatter([]);
        return [];
      }
      setDetailChatterLoading(true);
      try {
        const res = await apiClient.request({
          url: 'latticeChatter:list',
          method: 'get',
          params: { targetCollection, targetRecordId, limit: 20 },
          skipNotify: true,
        });
        const items = extractListItems(res);
        if (mountedRef.current) setDetailChatter(items);
        return items;
      } catch (err) {
        if (extractHttpStatus(err) === 401 && mountedRef.current) setAuthExpired(true);
        if (mountedRef.current) setDetailChatter([]);
        return [];
      } finally {
        if (mountedRef.current) setDetailChatterLoading(false);
      }
    }, [apiClient]);

    const openIncidentDetail = React.useCallback(async (inc) => {
      if (!inc) return;
      setSelectedTicket(null);
      setSelectedIncident(inc);
      setDetailNote('');
      await loadDetailChatter('latticeIncidentCases', inc.id);
    }, [loadDetailChatter]);

    const openTicketDetail = React.useCallback(async (tkt) => {
      if (!tkt) return;
      setSelectedIncident(null);
      setSelectedTicket(tkt);
      setDetailNote('');
      await loadDetailChatter('latticeServiceTickets', tkt.id);
    }, [loadDetailChatter]);

    const handleIncidentAlarmAction = React.useCallback(async (action) => {
      if (!selectedIncident || detailBusy || !apiClient || typeof apiClient.request !== 'function') return null;
      setDetailBusy(true);
      const isAck = action === 'ack';
      const url = isAck ? 'dxosBlocks:alarmAck' : 'dxosBlocks:alarmClear';
      try {
        const res = await apiClient.request({
          url,
          method: 'post',
          data: {
            id: selectedIncident.id,
            ...(isAck
              ? { note: detailNote.trim() || 'Đã xác nhận từ Mobile PWA' }
              : { closeNote: detailNote.trim() || 'Đã xử lý từ Mobile PWA' }),
          },
          skipNotify: true,
        });
        const updated = res?.data?.data ?? res?.data ?? {};
        const nextStatus = updated.status || (isAck ? 'acknowledged' : 'closed');
        setSelectedIncident((prev) => (prev ? { ...prev, ...updated, status: nextStatus } : prev));
        setIncidentCases((prev) => prev.map((it) => (it.id === selectedIncident.id ? { ...it, ...updated, status: nextStatus } : it)));
        setStatusNotice({
          type: 'success',
          text: isAck ? `Đã xác nhận (Ack) sự cố ${selectedIncident.code || `#${selectedIncident.id}`}.` : `Đã đóng cảnh báo ${selectedIncident.code || `#${selectedIncident.id}`}.`,
        });
        return updated;
      } catch (err) {
        const status = extractHttpStatus(err);
        if (status === 401 && mountedRef.current) setAuthExpired(true);
        const msg = status === 403
          ? 'Vai trò hiện tại không có quyền cập nhật sự cố IoT.'
          : (err?.response?.data?.errors?.[0]?.message || err?.message || 'Không thể cập nhật trạng thái sự cố.');
        setStatusNotice({ type: 'error', text: msg });
        return null;
      } finally {
        if (mountedRef.current) setDetailBusy(false);
      }
    }, [apiClient, detailBusy, detailNote, selectedIncident]);

    const submitDetailNote = React.useCallback(async (ev) => {
      ev?.preventDefault?.();
      const noteText = String(detailNote || '').trim();
      if (!noteText || detailBusy || !apiClient || typeof apiClient.request !== 'function') return null;
      const target = selectedIncident
        ? { collection: 'latticeIncidentCases', id: selectedIncident.id }
        : selectedTicket
          ? { collection: 'latticeServiceTickets', id: selectedTicket.id }
          : null;
      if (!target || !target.id) return null;
      setDetailBusy(true);
      try {
        await apiClient.request({
          url: 'latticeChatter:post',
          method: 'post',
          data: { targetCollection: target.collection, targetRecordId: target.id, body: noteText },
          skipNotify: true,
        });
        setDetailNote('');
        await loadDetailChatter(target.collection, target.id);
        setStatusNotice({ type: 'success', text: 'Đã lưu ghi chú hiện trường.' });
        return true;
      } catch (err) {
        if (extractHttpStatus(err) === 401 && mountedRef.current) setAuthExpired(true);
        const msg = err?.response?.data?.errors?.[0]?.message || err?.message || 'Không thể lưu ghi chú.';
        setStatusNotice({ type: 'error', text: msg });
        return null;
      } finally {
        if (mountedRef.current) setDetailBusy(false);
      }
    }, [apiClient, detailBusy, detailNote, loadDetailChatter, selectedIncident, selectedTicket]);

    const submitTicketVoucher = React.useCallback(async () => {
      if (!selectedTicket || detailBusy || !apiClient || typeof apiClient.request !== 'function') return null;
      setDetailBusy(true);
      try {
        const res = await apiClient.request({
          url: 'latticeVoucher:submit',
          method: 'post',
          data: {
            collection: 'latticeServiceTickets',
            id: selectedTicket.id,
            ...(selectedTicket.version != null ? { expectedVersion: selectedTicket.version } : {}),
          },
          skipNotify: true,
        });
        const updated = res?.data?.data ?? res?.data ?? {};
        const nextStatus = updated.status || 'submitted';
        setSelectedTicket((prev) => (prev ? { ...prev, ...updated, status: nextStatus } : prev));
        setServiceTickets((prev) => prev.map((it) => (it.id === selectedTicket.id ? { ...it, ...updated, status: nextStatus } : it)));
        setStatusNotice({ type: 'success', text: `Đã trình duyệt phiếu ${selectedTicket.code || `#${selectedTicket.id}`}.` });
        return updated;
      } catch (err) {
        if (extractHttpStatus(err) === 401 && mountedRef.current) setAuthExpired(true);
        const msg = err?.response?.data?.errors?.[0]?.message || err?.message || 'Không thể trình duyệt phiếu dịch vụ.';
        setStatusNotice({ type: 'error', text: msg });
        return null;
      } finally {
        if (mountedRef.current) setDetailBusy(false);
      }
    }, [apiClient, detailBusy, selectedTicket]);

    const submitNewServiceTicket = React.useCallback(async (ev) => {
      ev?.preventDefault?.();
      const title = String(newTicketName || '').trim();
      if (!title) {
        setStatusNotice({ type: 'error', text: 'Vui lòng nhập tiêu đề phiếu dịch vụ.' });
        return null;
      }
      if (ticketCreateBusy || !apiClient || typeof apiClient.request !== 'function') return null;
      setTicketCreateBusy(true);
      try {
        const ticketCode = `TKT-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
        const serviceType = ['leave', 'it_support', 'facilities', 'hr_request'].includes(newTicketType) ? newTicketType : 'it_support';
        const priority = ['low', 'medium', 'high'].includes(newTicketPriority) ? newTicketPriority : 'medium';
        const res = await apiClient.request({
          url: 'latticeServiceTickets:create',
          method: 'post',
          data: {
            code: ticketCode,
            name: title,
            serviceType,
            priority,
            ...(newTicketDesc.trim() ? { description: newTicketDesc.trim() } : {}),
          },
          skipNotify: true,
        });
        const created = res?.data?.data ?? res?.data ?? { id: Date.now(), code: ticketCode, name: title, serviceType, priority, status: 'draft' };
        setServiceTickets((prev) => [created, ...prev]);
        setNewTicketName('');
        setNewTicketDesc('');
        setCreateTicketOpen(false);
        setStatusNotice({ type: 'success', text: `Đã tạo phiếu dịch vụ ${created.code || created.name}.` });
        refreshOpsSummaryRef.current?.();
        return created;
      } catch (err) {
        if (extractHttpStatus(err) === 401 && mountedRef.current) setAuthExpired(true);
        const msg = err?.response?.data?.errors?.[0]?.message || err?.message || 'Không thể tạo phiếu dịch vụ.';
        setStatusNotice({ type: 'error', text: msg });
        return null;
      } finally {
        if (mountedRef.current) setTicketCreateBusy(false);
      }
    }, [apiClient, newTicketDesc, newTicketName, newTicketPriority, newTicketType, ticketCreateBusy]);

    const submitMobileAiPrompt = React.useCallback(async (ev) => {
      ev?.preventDefault?.();
      const promptText = String(aiPrompt || '').trim();
      if (!promptText || aiBusy) return;
      const userMsg = { id: `u-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, role: 'user', text: promptText };
      setAiMessages((prev) => [...prev, userMsg]);
      setAiPrompt('');
      if (!isOnline || !apiClient || typeof apiClient.request !== 'function') {
        setAiMessages((prev) => [
          ...prev,
          { id: `a-${Date.now()}`, role: 'error', text: 'Trợ lý AI cần kết nối mạng và phiên đăng nhập hợp lệ.' },
        ]);
        return;
      }
      setAiBusy(true);
      const token = resolveClientAuthToken(apiClient, storageRef.current);
      const appendReply = (role, text) => {
        if (!mountedRef.current) return;
        setAiMessages((prev) => [
          ...prev,
          { id: `a-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, role, text: String(text) },
        ]);
      };

      try {
        // 1. Primary live path: NocoBase plugin-ai aiConversations:create + sendMessages (with X-Timezone header)
        let sessionId = aiSessionRef.current.token === token ? aiSessionRef.current.sessionId : null;
        let employee = aiSessionRef.current.token === token ? aiSessionRef.current.employee : null;
        let conversationTried = false;
        let liveServerError = null;

        if (!sessionId) {
          try {
            const agentsRes = await apiClient.request({
              url: 'dxosAi:portalAgents',
              method: 'get',
              params: { portalSlug: 'mobile' },
              skipNotify: true,
            });
            const employees = agentsRes?.data?.data?.employees ?? agentsRes?.data?.employees ?? [];
            const picked = Array.isArray(employees)
              ? (employees.find((e) => e?.username && e.username !== 'dxos-architect') || employees[0])
              : null;
            employee = picked?.username || 'dxos-logistics';
          } catch (agentsErr) {
            if (extractHttpStatus(agentsErr) === 401) {
              if (mountedRef.current) setAuthExpired(true);
              appendReply('error', 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
              return;
            }
            employee = employee || 'dxos-logistics';
          }
          try {
            const createRes = await apiClient.request({
              url: 'aiConversations:create',
              method: 'post',
              headers: { 'X-Timezone': '+07:00' },
              data: { aiEmployee: { username: employee }, scope: 'mobile' },
              skipNotify: true,
            });
            const created = createRes?.data?.data ?? createRes?.data ?? {};
            sessionId = created.sessionId || created.id || null;
            if (sessionId) {
              aiSessionRef.current = { token, sessionId, employee };
            }
          } catch (createErr) {
            const status = extractHttpStatus(createErr);
            if (status === 401) {
              if (mountedRef.current) setAuthExpired(true);
              appendReply('error', 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
              return;
            }
            if (status !== 404) {
              liveServerError = createErr;
            }
          }
        }

        if (sessionId) {
          conversationTried = true;
          try {
            const sendRes = await apiClient.request({
              url: 'aiConversations:sendMessages',
              method: 'post',
              headers: { 'X-Timezone': '+07:00' },
              data: {
                sessionId,
                aiEmployee: employee || 'dxos-logistics',
                stream: false,
                messages: [{ role: 'user', content: { type: 'text', content: promptText } }],
              },
              skipNotify: true,
            });
            const replyText = extractAiReplyText(sendRes?.data?.data ?? sendRes?.data ?? {});
            if (replyText) {
              appendReply('assistant', replyText);
              return;
            }
          } catch (sendErr) {
            const status = extractHttpStatus(sendErr);
            if (status === 401) {
              if (mountedRef.current) setAuthExpired(true);
              appendReply('error', 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
              return;
            }
            aiSessionRef.current = { token: null, sessionId: null, employee: null };
            if (status !== 404) {
              liveServerError = sendErr;
            }
          }
        }

        // 2. Governed A2A gateway fallback (exists on live server, avoids 404 on dxosAi:agentChat)
        let a2aHadResult = false;
        try {
          const a2aRes = await apiClient.request({
            url: 'dxos-a2a',
            method: 'post',
            data: {
              jsonrpc: '2.0',
              id: `mobile-${Date.now()}`,
              method: 'tasks/send',
              params: {
                targetAgentId: 'dxos-logistics',
                message: { role: 'user', parts: [{ type: 'text', text: promptText }] },
                metadata: { portalSlug: 'mobile' },
              },
            },
            skipNotify: true,
          });
          const a2aBody = a2aRes?.data ?? {};
          const a2aText = extractAiReplyText(a2aBody);
          if (a2aText) {
            a2aHadResult = true;
            appendReply('assistant', a2aText);
            return;
          }
          if (a2aBody?.error) {
            liveServerError = new Error(a2aBody.error.message || 'Lỗi từ A2A gateway.');
          } else if (a2aBody?.result) {
            a2aHadResult = true;
          }
        } catch (a2aErr) {
          const status = extractHttpStatus(a2aErr);
          if (status === 401) {
            if (mountedRef.current) setAuthExpired(true);
            appendReply('error', 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
            return;
          }
          if (status !== 404) {
            liveServerError = a2aErr;
          }
        }

        // 3. Legacy / unit-test mock fallback only when aiConversations & dxos-a2a returned unmocked/404 or null (never on live server error)
        if (!conversationTried && !a2aHadResult && !liveServerError) {
          const res = await apiClient.request({
            url: 'dxosAi:agentChat',
            method: 'post',
            data: { prompt: promptText, portalSlug: 'mobile' },
            skipNotify: true,
          });
          const body = res?.data?.data ?? res?.data ?? {};
          const text = extractAiReplyText(body) || 'Đã tiếp nhận yêu cầu trợ lý AI.';
          appendReply('assistant', text);
          return;
        }

        if (liveServerError) {
          const msg = liveServerError?.response?.data?.errors?.[0]?.message || liveServerError?.message || 'Không thể kết nối trợ lý AI lúc này.';
          appendReply('error', msg);
          return;
        }

        appendReply('assistant', 'Đã tiếp nhận yêu cầu trợ lý AI.');
      } catch (err) {
        if (extractHttpStatus(err) === 401 && mountedRef.current) {
          setAuthExpired(true);
        }
        const msg = err?.response?.data?.errors?.[0]?.message || err?.message || 'Không thể kết nối trợ lý AI lúc này.';
        appendReply('error', msg);
      } finally {
        if (mountedRef.current) setAiBusy(false);
      }
    }, [aiBusy, aiPrompt, apiClient, isOnline]);

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

    const unreadLabel = notifUnreadCount > 99 ? '99+' : String(notifUnreadCount);

    return h('div', {
      'data-testid': 'mobile-pwa-root',
      style: {
        maxWidth: 520,
        margin: '0 auto',
        minHeight: '100vh',
        background: '#0f172a',
        color: '#f8fafc',
        padding: 16,
        paddingBottom: 76,
        overflowX: 'hidden',
        fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
        boxSizing: 'border-box',
      },
    },
      // Header
      h('header', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 8 } },
        h('div', null,
          h('div', { style: { fontSize: 18, fontWeight: 800, letterSpacing: '-0.02em' } }, 'LatticeDX Field PWA'),
          h('div', { style: { fontSize: 12, color: '#94a3b8' } }, 'Giao nhận hiện trường · /v/mobile'),
        ),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
          h('button', {
            type: 'button',
            'data-testid': 'mobile-pwa-notif-badge',
            onClick: toggleNotifications,
            title: 'Thông báo hiện trường',
            style: {
              padding: '6px 10px',
              borderRadius: 999,
              background: notifUnreadCount > 0 ? '#dc2626' : '#1e293b',
              border: '1px solid #475569',
              color: '#f8fafc',
              fontSize: 12,
              fontWeight: 700,
              cursor: 'pointer',
            },
          }, `Thông báo: ${unreadLabel}`),
          h('button', {
            type: 'button',
            'data-testid': 'mobile-pwa-queue-badge',
            onClick: () => setOutboxOpen((v) => !v),
            title: 'Mở Outbox Inspector',
            style: {
              padding: '6px 10px',
              borderRadius: 999,
              background: queueItems.length > 0 ? '#b45309' : '#1e293b',
              border: '1px solid #475569',
              color: '#f8fafc',
              fontSize: 12,
              fontWeight: 700,
              cursor: 'pointer',
            },
          }, `Hàng đợi: ${queueItems.length}`),
        ),
      ),

      // Notification Panel
      notifOpen ? h('section', {
        'data-testid': 'mobile-pwa-notif-panel',
        style: { ...cardStyle, borderColor: '#3b82f6' },
      },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 6, flexWrap: 'wrap' } },
          h('strong', { style: { fontSize: 14 } }, `Hộp thư thông báo (${notifUnreadCount} chưa đọc)`),
          h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
            h('button', {
              type: 'button',
              'data-testid': 'mobile-pwa-notif-mark-all',
              disabled: notifBusy || (notifUnreadCount === 0 && !notifItems.some((it) => !it.readAt)),
              onClick: markAllNotifsRead,
              style: { ...btnSecondaryStyle, minHeight: 32, padding: '4px 10px', fontSize: 12, background: '#0369a1', borderColor: '#0284c7' },
            }, 'Đánh dấu tất cả đã đọc'),
            h('button', {
              type: 'button',
              onClick: () => setNotifOpen(false),
              style: { ...btnSecondaryStyle, minHeight: 32, padding: '4px 10px', fontSize: 12 },
            }, 'Đóng'),
          ),
        ),
        notifError ? h('div', {
          role: 'alert',
          'data-testid': 'mobile-pwa-notif-error',
          style: { padding: '8px 10px', borderRadius: 8, background: '#7f1d1d', border: '1px solid #ef4444', marginBottom: 8, fontSize: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
        },
          h('span', null, notifError),
          h('button', {
            type: 'button',
            'data-testid': 'mobile-pwa-notif-retry',
            onClick: loadNotifications,
            style: { ...btnSecondaryStyle, minHeight: 28, padding: '2px 8px', fontSize: 11 },
          }, 'Thử lại'),
        ) : null,
        notifLoading && notifItems.length === 0
          ? h('div', { style: { fontSize: 12, color: '#94a3b8' } }, 'Đang tải thông báo...')
          : notifItems.length === 0
            ? h('div', { style: { fontSize: 12, color: '#94a3b8' } }, 'Không có thông báo mới.')
            : notifItems.map((it) => h('div', {
                key: it.id,
                style: {
                  padding: '8px 10px',
                  borderRadius: 8,
                  background: it.readAt ? '#0f172a' : '#172554',
                  border: '1px solid #334155',
                  marginBottom: 6,
                  fontSize: 12,
                },
              },
                h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 } },
                  h('div', { style: { fontWeight: 700 } }, it.title),
                  !it.readAt ? h('button', {
                    type: 'button',
                    'data-testid': `mobile-pwa-notif-mark-${it.id}`,
                    onClick: () => markNotifRead(it),
                    style: { ...btnSecondaryStyle, minHeight: 26, padding: '2px 8px', fontSize: 11, background: '#0369a1', borderColor: '#0284c7', flexShrink: 0 },
                  }, 'Đánh dấu đã đọc') : null,
                ),
                it.body ? h('div', { style: { color: '#cbd5e1', marginTop: 2 } }, String(it.body).slice(0, 120)) : null,
              )),
      ) : null,

      // Outbox Inspector Drawer
      outboxOpen ? h('section', {
        'data-testid': 'mobile-pwa-outbox-drawer',
        style: { ...cardStyle, borderColor: '#f59e0b' },
      },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 8 } },
          h('div', { style: { fontSize: 14, fontWeight: 800 } }, `Outbox Inspector (${queueItems.length}/${MAX_OFFLINE_QUEUE_ITEMS})`),
          h('div', { style: { display: 'flex', gap: 6 } },
            h('button', {
              type: 'button',
              'data-testid': 'mobile-pwa-outbox-retry-all',
              disabled: syncing || queueItems.length === 0,
              onClick: () => handleSync(true),
              style: { ...btnSecondaryStyle, minHeight: 34, padding: '4px 10px', fontSize: 12, background: '#0284c7', borderColor: '#0284c7' },
            }, syncing ? 'Đang gửi...' : 'Thử lại tất cả'),
            h('button', {
              type: 'button',
              'data-testid': 'mobile-pwa-outbox-close',
              onClick: () => setOutboxOpen(false),
              style: { ...btnSecondaryStyle, minHeight: 34, padding: '4px 10px', fontSize: 12 },
            }, 'Đóng'),
          ),
        ),
        queueItems.length === 0
          ? h('div', { style: { fontSize: 12, color: '#94a3b8' } }, 'Hàng đợi ngoại tuyến đang trống.')
          : queueItems.map((item) => {
              const spec = ALLOWED_OFFLINE_ACTIONS[item.actionType] || {};
              const isFailed = item.status === 'failed';
              const statusLabel = item.status === 'syncing' ? 'Đang gửi' : isFailed ? 'Thất bại' : 'Chờ đồng bộ';
              const isConfirmingDelete = confirmDeleteOutboxId === item.id;
              return h('div', {
                key: item.id,
                'data-testid': `mobile-pwa-outbox-item-${item.id}`,
                style: {
                  padding: 10,
                  borderRadius: 8,
                  background: '#0f172a',
                  border: `1px solid ${isFailed ? '#ef4444' : '#334155'}`,
                  marginBottom: 8,
                },
              },
                h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 } },
                  h('strong', { style: { fontSize: 13 } }, `${spec.label || item.actionType} · ${formatOutboxItemSummary(item)}`),
                  h('span', {
                    style: {
                      fontSize: 11,
                      fontWeight: 700,
                      padding: '2px 8px',
                      borderRadius: 999,
                      background: isFailed ? '#7f1d1d' : '#1e3a8a',
                      color: '#f8fafc',
                    },
                  }, statusLabel),
                ),
                h('div', { style: { fontSize: 11, color: '#94a3b8', marginTop: 4 } }, `Lần thử: ${item.attempts || 0} · ${item.createdAt}`),
                item.lastError ? h('div', { style: { fontSize: 11, color: '#fca5a5', marginTop: 3 } }, item.lastError) : null,
                h('div', { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
                  h('button', {
                    type: 'button',
                    'data-testid': `mobile-pwa-outbox-retry-${item.id}`,
                    disabled: retryingItemId === item.id,
                    onClick: () => retrySingleOutboxItem(item),
                    style: { ...btnSecondaryStyle, minHeight: 34, padding: '4px 10px', fontSize: 12, background: '#0369a1' },
                  }, retryingItemId === item.id ? 'Đang thử lại...' : 'Thử lại'),
                  isConfirmingDelete
                    ? h('div', { style: { display: 'flex', gap: 6 } },
                        h('button', {
                          type: 'button',
                          'data-testid': `mobile-pwa-outbox-delete-confirm-${item.id}`,
                          onClick: async () => {
                            await deleteSingleOutboxItem(item.id);
                            setConfirmDeleteOutboxId(null);
                          },
                          style: { ...btnSecondaryStyle, minHeight: 34, padding: '4px 10px', fontSize: 12, background: '#dc2626', borderColor: '#ef4444' },
                        }, 'Xác nhận xóa?'),
                        h('button', {
                          type: 'button',
                          'data-testid': `mobile-pwa-outbox-delete-cancel-${item.id}`,
                          onClick: () => setConfirmDeleteOutboxId(null),
                          style: { ...btnSecondaryStyle, minHeight: 34, padding: '4px 10px', fontSize: 12 },
                        }, 'Hủy'),
                      )
                    : h('button', {
                        type: 'button',
                        'data-testid': `mobile-pwa-outbox-delete-${item.id}`,
                        onClick: () => setConfirmDeleteOutboxId(item.id),
                        style: { ...btnSecondaryStyle, minHeight: 34, padding: '4px 10px', fontSize: 12, background: '#7f1d1d', borderColor: '#ef4444' },
                      }, 'Xóa'),
                ),
              );
            }),
      ) : null,

      // Unauthenticated / Expired Session Banner
      (!isAuthenticatedMobileClient(apiClient, storageRef.current) || authExpired) ? h('section', {
        role: 'alert',
        'data-testid': 'mobile-pwa-auth-banner',
        style: {
          ...cardStyle,
          background: '#7f1d1d',
          borderColor: '#ef4444',
          display: 'flex',
          flexWrap: 'wrap',
          gap: 10,
          alignItems: 'center',
          justifyContent: 'space-between',
        },
      },
        h('div', { style: { fontSize: 13, fontWeight: 600, color: '#fee2e2', flex: '1 1 220px' } },
          'Chưa đăng nhập hoặc phiên làm việc đã hết hạn. Vui lòng đăng nhập để tải tác vụ hiện trường.',
        ),
        h('a', {
          href: '/signin?redirect=%2Fv%2Fmobile',
          'data-testid': 'mobile-pwa-signin-link',
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: 36,
            padding: '6px 14px',
            borderRadius: 8,
            background: '#ffffff',
            color: '#991b1b',
            fontWeight: 800,
            fontSize: 13,
            textDecoration: 'none',
          },
        }, 'Đăng nhập ngay'),
      ) : null,

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

      // Above-the-Fold Compact Mobile Operations Cards (Approvals, Deliveries, Incidents, Service Tickets)
      h('section', {
        'data-testid': 'mobile-pwa-above-fold-cards',
        style: cardStyle,
      },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 8 } },
          h('div', { style: { fontSize: 15, fontWeight: 700 } }, 'Tác vụ Hiện trường Ưu tiên'),
          (isAuthenticatedMobileClient(apiClient, storageRef.current) && !authExpired) ? h('button', {
            type: 'button',
            'data-testid': 'mobile-pwa-ops-refresh-btn',
            disabled: opsLoading,
            onClick: refreshOpsSummary,
            style: { ...btnSecondaryStyle, minHeight: 34, padding: '4px 10px', fontSize: 12 },
          }, opsLoading ? 'Đang tải...' : 'Làm mới') : null,
        ),
        opsErrors.length > 0 && !authExpired ? h('div', {
          role: 'alert',
          'data-testid': 'mobile-pwa-ops-error',
          style: {
            padding: '8px 10px',
            borderRadius: 8,
            background: '#7f1d1d',
            border: '1px solid #ef4444',
            marginBottom: 10,
            fontSize: 12,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 8,
          },
        },
          h('div', null, opsErrors.map((e) => `${e.label}: ${e.message}`).join(' · ')),
          h('button', {
            type: 'button',
            'data-testid': 'mobile-pwa-ops-retry-btn',
            onClick: refreshOpsSummary,
            style: { ...btnSecondaryStyle, minHeight: 28, padding: '2px 10px', fontSize: 11, flexShrink: 0 },
          }, 'Thử lại'),
        ) : null,
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 } },
          [
            { key: 'all', label: 'Tất cả' },
            { key: 'approvals', label: `Phê duyệt (${pendingApprovals.length})` },
            { key: 'deliveries', label: `Giao nhận (${deliveryOrders.length})` },
            { key: 'incidents', label: `Sự cố (${incidentCases.length})` },
            { key: 'tickets', label: `Phiếu DV (${serviceTickets.length})` },
          ].map((tab) => h('button', {
            key: tab.key,
            type: 'button',
            'data-testid': `mobile-pwa-ops-tab-${tab.key}`,
            onClick: () => setOpsTab(tab.key),
            style: {
              minHeight: 34,
              padding: '5px 10px',
              borderRadius: 999,
              border: `1px solid ${opsTab === tab.key ? '#38bdf8' : '#475569'}`,
              background: opsTab === tab.key ? '#0369a1' : '#0f172a',
              color: '#f8fafc',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
            },
          }, tab.label)),
        ),
        (opsTab === 'all' || opsTab === 'approvals') ? h('div', {
          'data-testid': 'mobile-pwa-approvals-section',
          style: { marginBottom: 10 },
        },
          h('div', { style: { fontSize: 12, fontWeight: 700, color: '#93c5fd', marginBottom: 6, textTransform: 'uppercase' } }, `Phê duyệt chờ xử lý (${pendingApprovals.length})`),
          pendingApprovals.length === 0
            ? h('div', { style: { fontSize: 12, color: '#94a3b8', padding: '6px 0' } },
                (!isAuthenticatedMobileClient(apiClient, storageRef.current) || authExpired)
                  ? 'Đăng nhập để xem tác vụ hiện trường.'
                  : 'Không có yêu cầu phê duyệt tồn đọng.',
              )
            : pendingApprovals.slice(0, 4).map((ap, idx) => {
                const apKey = String(ap.id ?? ap.requestUid ?? idx);
                const busy = decidingApprovalId === apKey;
                return h('div', {
                  key: apKey,
                  'data-testid': `mobile-pwa-approval-card-${apKey}`,
                  style: { padding: 10, borderRadius: 10, background: '#0f172a', border: '1px solid #334155', marginBottom: 8 },
                },
                  h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 } },
                    h('strong', { style: { fontSize: 13, lineHeight: 1.35 } }, ap.title || ap.targetCode || `Yêu cầu #${apKey}`),
                    h('span', { style: { fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: '#78350f', color: '#fde68a', flexShrink: 0 } }, ap.riskLevel || ap.status || 'Chờ duyệt'),
                  ),
                  ap.summary ? h('div', { style: { fontSize: 12, color: '#cbd5e1', marginTop: 4 } }, String(ap.summary).slice(0, 120)) : null,
                  h('div', { style: { display: 'flex', gap: 8, marginTop: 8 } },
                    h('button', {
                      type: 'button',
                      'data-testid': `mobile-pwa-approval-approve-${apKey}`,
                      disabled: busy,
                      onClick: () => decideMobileApproval(ap, 'approved'),
                      style: { ...btnSecondaryStyle, flex: 1, minHeight: 38, padding: '6px 10px', fontSize: 13, background: '#15803d', borderColor: '#16a34a' },
                    }, busy ? 'Đang xử lý...' : 'Phê duyệt'),
                    h('button', {
                      type: 'button',
                      'data-testid': `mobile-pwa-approval-reject-${apKey}`,
                      disabled: busy,
                      onClick: () => decideMobileApproval(ap, 'rejected'),
                      style: { ...btnSecondaryStyle, flex: 1, minHeight: 38, padding: '6px 10px', fontSize: 13, background: '#991b1b', borderColor: '#dc2626' },
                    }, 'Từ chối'),
                  ),
                );
              }),
        ) : null,
        (opsTab === 'all' || opsTab === 'deliveries') ? h('div', {
          'data-testid': 'mobile-pwa-deliveries-section',
          style: { marginBottom: 10 },
        },
          h('div', { style: { fontSize: 12, fontWeight: 700, color: '#6ee7b7', marginBottom: 6, textTransform: 'uppercase' } }, `Giao nhận Logistics (${deliveryOrders.length})`),
          deliveryOrders.length === 0
            ? h('div', { style: { fontSize: 12, color: '#94a3b8', padding: '6px 0' } },
                (!isAuthenticatedMobileClient(apiClient, storageRef.current) || authExpired)
                  ? 'Đăng nhập để xem tác vụ hiện trường.'
                  : 'Chưa có chuyến giao nhận nào.',
              )
            : deliveryOrders.slice(0, 4).map((ord, idx) => {
                const ordKey = String(ord.id ?? ord.code ?? idx);
                return h('div', {
                  key: ordKey,
                  'data-testid': `mobile-pwa-delivery-card-${ordKey}`,
                  style: { padding: 10, borderRadius: 10, background: '#0f172a', border: '1px solid #334155', marginBottom: 8 },
                },
                  h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 } },
                    h('strong', { style: { fontSize: 13 } }, `${ord.code || `#${ordKey}`} — ${ord.name || ord.customer || 'Đơn vận chuyển'}`),
                    h('span', { style: { fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: '#064e3b', color: '#a7f3d0', flexShrink: 0 } }, ord.status || 'submitted'),
                  ),
                  ord.destination ? h('div', { style: { fontSize: 12, color: '#cbd5e1', marginTop: 4 } }, `Điểm đến: ${ord.destination}`) : null,
                  h('button', {
                    type: 'button',
                    'data-testid': `mobile-pwa-delivery-select-${ordKey}`,
                    onClick: () => selectOrderForEpod(ord),
                    style: { ...btnSecondaryStyle, width: '100%', minHeight: 36, marginTop: 8, padding: '6px 10px', fontSize: 12, background: '#0369a1', borderColor: '#0284c7' },
                  }, 'Chọn giao ePOD'),
                );
              }),
        ) : null,
        (opsTab === 'all' || opsTab === 'incidents') ? h('div', {
          'data-testid': 'mobile-pwa-incidents-section',
          style: { marginBottom: 10 },
        },
          h('div', { style: { fontSize: 12, fontWeight: 700, color: '#fca5a5', marginBottom: 6, textTransform: 'uppercase' } }, `Sự cố hiện trường (${incidentCases.length})`),
          incidentsRestricted
            ? h('div', { style: { fontSize: 12, color: '#fbbf24', padding: '6px 0' } }, 'Vai trò hiện tại không có quyền xem sự cố IoT.')
            : incidentCases.length === 0
              ? h('div', { style: { fontSize: 12, color: '#94a3b8', padding: '6px 0' } },
                  (!isAuthenticatedMobileClient(apiClient, storageRef.current) || authExpired)
                    ? 'Đăng nhập để xem tác vụ hiện trường.'
                    : 'Không có sự cố đang mở.',
                )
              : incidentCases.slice(0, 4).map((inc, idx) => {
                  const incKey = String(inc.id ?? inc.code ?? idx);
                  return h('div', {
                    key: incKey,
                    'data-testid': `mobile-pwa-incident-card-${incKey}`,
                    style: { padding: 10, borderRadius: 10, background: '#0f172a', border: '1px solid #334155', marginBottom: 8 },
                  },
                    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 } },
                      h('strong', { style: { fontSize: 13 } }, `${inc.code || `#${incKey}`} — ${inc.name || 'Sự cố thiết bị'}`),
                      h('span', { style: { fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: '#7f1d1d', color: '#fecaca', flexShrink: 0 } }, `${inc.severity || 'medium'} · ${inc.status || 'open'}`),
                    ),
                    h('div', { style: { display: 'flex', gap: 8, marginTop: 8 } },
                      h('button', {
                        type: 'button',
                        'data-testid': `mobile-pwa-incident-open-${incKey}`,
                        onClick: () => openIncidentDetail(inc),
                        style: { ...btnSecondaryStyle, flex: 1, minHeight: 34, padding: '4px 10px', fontSize: 12, background: '#1e293b' },
                      }, 'Chi tiết & xử lý'),
                    ),
                  );
                }),
        ) : null,
        selectedIncident ? h('div', {
          'data-testid': 'mobile-pwa-incident-detail',
          style: { padding: 12, borderRadius: 10, background: '#0f172a', border: '1px solid #ef4444', marginBottom: 12 },
        },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8 } },
            h('strong', { style: { fontSize: 14 } }, `${selectedIncident.code || `#${selectedIncident.id}`} — ${selectedIncident.name || 'Sự cố IoT'}`),
            h('button', {
              type: 'button',
              'data-testid': 'mobile-pwa-incident-detail-close',
              onClick: () => setSelectedIncident(null),
              style: { ...btnSecondaryStyle, minHeight: 30, padding: '4px 10px', fontSize: 12 },
            }, 'Đóng'),
          ),
          h('div', { style: { fontSize: 12, color: '#cbd5e1', marginBottom: 6 } }, `Mức độ: ${selectedIncident.severity || 'medium'} · Trạng thái: ${selectedIncident.status || 'open'}`),
          selectedIncident.proposal ? h('div', { style: { fontSize: 12, color: '#fde68a', marginBottom: 6 } }, `Đề xuất: ${selectedIncident.proposal}`) : null,
          selectedIncident.resolutionNote ? h('div', { style: { fontSize: 12, color: '#93c5fd', marginBottom: 6 } }, `Ghi chú: ${selectedIncident.resolutionNote}`) : null,
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 } },
            (selectedIncident.assetId != null || selectedIncident.assetEntityId) ? h('button', {
              type: 'button',
              'data-testid': 'mobile-pwa-incident-fill-twin',
              onClick: () => {
                setTwinAssetId(String(selectedIncident.assetId ?? selectedIncident.assetEntityId));
                setStatusNotice({ type: 'info', text: 'Đã điền mã tài sản vào khung Digital Twin.' });
              },
              style: { ...btnSecondaryStyle, minHeight: 34, padding: '4px 10px', fontSize: 12, background: '#0369a1' },
            }, 'Điền vào Digital Twin') : null,
            !incidentsRestricted ? h('button', {
              type: 'button',
              'data-testid': 'mobile-pwa-incident-ack',
              disabled: detailBusy,
              onClick: () => handleIncidentAlarmAction('ack'),
              style: { ...btnSecondaryStyle, minHeight: 34, padding: '4px 10px', fontSize: 12, background: '#b45309' },
            }, 'Xác nhận (Ack)') : null,
            !incidentsRestricted ? h('button', {
              type: 'button',
              'data-testid': 'mobile-pwa-incident-clear',
              disabled: detailBusy,
              onClick: () => handleIncidentAlarmAction('clear'),
              style: { ...btnSecondaryStyle, minHeight: 34, padding: '4px 10px', fontSize: 12, background: '#15803d' },
            }, 'Đóng cảnh báo') : null,
          ),
          h('div', { style: { fontSize: 12, fontWeight: 700, marginBottom: 4 } }, 'Trao đổi hiện trường (Chatter)'),
          detailChatterLoading
            ? h('div', { style: { fontSize: 11, color: '#94a3b8', marginBottom: 6 } }, 'Đang tải trao đổi...')
            : detailChatter.slice(0, 5).map((ch, idx) => h('div', {
                key: ch.id || idx,
                style: { fontSize: 11, color: '#cbd5e1', padding: '4px 6px', background: '#1e293b', borderRadius: 6, marginBottom: 4 },
              }, `${ch.authorName || 'Nhân viên'}: ${ch.body}`)),
          h('div', { style: { display: 'flex', gap: 6, marginTop: 6 } },
            h('input', {
              type: 'text',
              'data-testid': 'mobile-pwa-incident-note-input',
              value: detailNote,
              onChange: (e) => setDetailNote(e?.target?.value ?? ''),
              placeholder: 'Nhập ghi chú xử lý...',
              style: { ...inputStyle, marginBottom: 0, flex: 1, minHeight: 36, fontSize: 12 },
            }),
            h('button', {
              type: 'button',
              'data-testid': 'mobile-pwa-incident-note-submit',
              disabled: detailBusy,
              onClick: submitDetailNote,
              style: { ...btnSecondaryStyle, minHeight: 36, padding: '4px 10px', fontSize: 12, background: '#0284c7' },
            }, 'Gửi ghi chú'),
          ),
        ) : null,
        (opsTab === 'all' || opsTab === 'tickets') ? h('div', {
          'data-testid': 'mobile-pwa-tickets-section',
        },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, gap: 8 } },
            h('div', { style: { fontSize: 12, fontWeight: 700, color: '#fde68a', textTransform: 'uppercase' } }, `Phiếu dịch vụ (${serviceTickets.length})`),
            (isAuthenticatedMobileClient(apiClient, storageRef.current) && !authExpired) ? h('button', {
              type: 'button',
              'data-testid': 'mobile-pwa-ticket-create-toggle',
              onClick: () => setCreateTicketOpen((v) => !v),
              style: { ...btnSecondaryStyle, minHeight: 30, padding: '3px 10px', fontSize: 11, background: '#0369a1' },
            }, createTicketOpen ? 'Đóng form' : '+ Tạo phiếu dịch vụ') : null,
          ),
          createTicketOpen ? h('div', {
            'data-testid': 'mobile-pwa-ticket-create-form',
            style: { padding: 10, borderRadius: 10, background: '#0f172a', border: '1px solid #38bdf8', marginBottom: 10 },
          },
            h('input', {
              type: 'text',
              'data-testid': 'mobile-pwa-ticket-new-name',
              value: newTicketName,
              onChange: (e) => setNewTicketName(e?.target?.value ?? ''),
              placeholder: 'Tiêu đề phiếu dịch vụ...',
              style: { ...inputStyle, minHeight: 38, fontSize: 13 },
            }),
            h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 8 } },
              h('select', {
                'data-testid': 'mobile-pwa-ticket-new-type',
                value: newTicketType,
                onChange: (e) => setNewTicketType(e?.target?.value ?? 'it_support'),
                style: { ...inputStyle, marginBottom: 0, minHeight: 36, fontSize: 12 },
              },
                h('option', { value: 'it_support' }, 'Hỗ trợ CNTT'),
                h('option', { value: 'facilities' }, 'Cơ sở vật chất'),
                h('option', { value: 'hr_request' }, 'Hành chính Nhân sự'),
                h('option', { value: 'leave' }, 'Nghỉ phép / Công tác'),
              ),
              h('select', {
                'data-testid': 'mobile-pwa-ticket-new-priority',
                value: newTicketPriority,
                onChange: (e) => setNewTicketPriority(e?.target?.value ?? 'medium'),
                style: { ...inputStyle, marginBottom: 0, minHeight: 36, fontSize: 12 },
              },
                h('option', { value: 'low' }, 'Thấp'),
                h('option', { value: 'medium' }, 'Trung bình'),
                h('option', { value: 'high' }, 'Cao'),
              ),
            ),
            h('input', {
              type: 'text',
              'data-testid': 'mobile-pwa-ticket-new-desc',
              value: newTicketDesc,
              onChange: (e) => setNewTicketDesc(e?.target?.value ?? ''),
              placeholder: 'Mô tả sự cố / yêu cầu kỹ thuật...',
              style: { ...inputStyle, minHeight: 38, fontSize: 13 },
            }),
            h('button', {
              type: 'button',
              'data-testid': 'mobile-pwa-ticket-new-submit',
              disabled: ticketCreateBusy,
              onClick: submitNewServiceTicket,
              style: { ...btnPrimaryStyle, minHeight: 38, fontSize: 13 },
            }, ticketCreateBusy ? 'Đang tạo...' : 'Lưu phiếu dịch vụ'),
          ) : null,
          serviceTickets.length === 0
            ? h('div', { style: { fontSize: 12, color: '#94a3b8', padding: '6px 0' } },
                (!isAuthenticatedMobileClient(apiClient, storageRef.current) || authExpired)
                  ? 'Đăng nhập để xem tác vụ hiện trường.'
                  : 'Không có phiếu dịch vụ mới.',
              )
            : serviceTickets.slice(0, 4).map((tkt, idx) => {
                const tktKey = String(tkt.id ?? tkt.code ?? idx);
                return h('div', {
                  key: tktKey,
                  'data-testid': `mobile-pwa-ticket-card-${tktKey}`,
                  style: { padding: 10, borderRadius: 10, background: '#0f172a', border: '1px solid #334155', marginBottom: 8 },
                },
                  h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 } },
                    h('strong', { style: { fontSize: 13 } }, `${tkt.code || `#${tktKey}`} — ${tkt.name || 'Phiếu hỗ trợ'}`),
                    h('span', { style: { fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: '#1e3a8a', color: '#bfdbfe', flexShrink: 0 } }, `${tkt.priority || 'medium'} · ${tkt.status || 'submitted'}`),
                  ),
                  h('div', { style: { display: 'flex', gap: 8, marginTop: 8 } },
                    h('button', {
                      type: 'button',
                      'data-testid': `mobile-pwa-ticket-open-${tktKey}`,
                      onClick: () => openTicketDetail(tkt),
                      style: { ...btnSecondaryStyle, flex: 1, minHeight: 34, padding: '4px 10px', fontSize: 12, background: '#1e293b' },
                    }, 'Chi tiết & thao tác'),
                  ),
                );
              }),
        ) : null,
        selectedTicket ? h('div', {
          'data-testid': 'mobile-pwa-ticket-detail',
          style: { padding: 12, borderRadius: 10, background: '#0f172a', border: '1px solid #3b82f6', marginTop: 10 },
        },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8 } },
            h('strong', { style: { fontSize: 14 } }, `${selectedTicket.code || `#${selectedTicket.id}`} — ${selectedTicket.name || 'Phiếu dịch vụ'}`),
            h('button', {
              type: 'button',
              'data-testid': 'mobile-pwa-ticket-detail-close',
              onClick: () => setSelectedTicket(null),
              style: { ...btnSecondaryStyle, minHeight: 30, padding: '4px 10px', fontSize: 12 },
            }, 'Đóng'),
          ),
          h('div', { style: { fontSize: 12, color: '#cbd5e1', marginBottom: 6 } }, `Loại: ${selectedTicket.serviceType || 'it_support'} · Ưu tiên: ${selectedTicket.priority || 'medium'} · Trạng thái: ${selectedTicket.status || 'draft'}`),
          selectedTicket.description ? h('div', { style: { fontSize: 12, color: '#e2e8f0', marginBottom: 6 } }, selectedTicket.description) : null,
          selectedTicket.resolutionNote ? h('div', { style: { fontSize: 12, color: '#93c5fd', marginBottom: 6 } }, `Ghi chú xử lý: ${selectedTicket.resolutionNote}`) : null,
          (selectedTicket.status || 'draft') === 'draft' ? h('button', {
            type: 'button',
            'data-testid': 'mobile-pwa-ticket-submit-voucher',
            disabled: detailBusy,
            onClick: submitTicketVoucher,
            style: { ...btnSecondaryStyle, width: '100%', minHeight: 36, marginBottom: 8, padding: '6px 10px', fontSize: 12, background: '#15803d', borderColor: '#16a34a' },
          }, detailBusy ? 'Đang trình duyệt...' : 'Trình duyệt phiếu') : null,
          h('div', { style: { fontSize: 12, fontWeight: 700, marginBottom: 4 } }, 'Trao đổi & ghi chú'),
          detailChatterLoading
            ? h('div', { style: { fontSize: 11, color: '#94a3b8', marginBottom: 6 } }, 'Đang tải trao đổi...')
            : detailChatter.slice(0, 5).map((ch, idx) => h('div', {
                key: ch.id || idx,
                style: { fontSize: 11, color: '#cbd5e1', padding: '4px 6px', background: '#1e293b', borderRadius: 6, marginBottom: 4 },
              }, `${ch.authorName || 'Nhân viên'}: ${ch.body}`)),
          h('div', { style: { display: 'flex', gap: 6, marginTop: 6 } },
            h('input', {
              type: 'text',
              'data-testid': 'mobile-pwa-ticket-note-input',
              value: detailNote,
              onChange: (e) => setDetailNote(e?.target?.value ?? ''),
              placeholder: 'Thêm ghi chú phiếu dịch vụ...',
              style: { ...inputStyle, marginBottom: 0, flex: 1, minHeight: 36, fontSize: 12 },
            }),
            h('button', {
              type: 'button',
              'data-testid': 'mobile-pwa-ticket-note-submit',
              disabled: detailBusy,
              onClick: submitDetailNote,
              style: { ...btnSecondaryStyle, minHeight: 36, padding: '4px 10px', fontSize: 12, background: '#0284c7' },
            }, 'Lưu ghi chú'),
          ),
        ) : null,
      ),

      // QR Scanner Card
      h('section', { style: cardStyle },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 8 } },
          h('div', { style: { fontSize: 15, fontWeight: 700 } }, '1. Quét mã QR / Barcode (Đơn hàng, Lô, URN)'),
          scannerMode === 'camera_canvas_fallback' ? h('span', {
            'data-testid': 'mobile-pwa-qr-fallback-badge',
            style: { fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: '#78350f', color: '#fde68a' },
          }, 'Canvas Fallback') : null,
        ),
        h('div', { style: { display: 'flex', gap: 8, marginBottom: 10 } },
          h('button', {
            type: 'button',
            'data-testid': 'mobile-pwa-qr-scan-btn',
            onClick: scannerActive ? stopScanner : startCameraScanner,
            style: { ...btnSecondaryStyle, flex: 1 },
          }, scannerActive ? 'Dừng Camera' : 'Quét QR bằng Camera'),
          scannerActive && scannerMode === 'camera_canvas_fallback' ? h('button', {
            type: 'button',
            'data-testid': 'mobile-pwa-qr-capture-frame-btn',
            onClick: captureQrFrameFromVideo,
            style: { ...btnSecondaryStyle, background: '#0284c7', borderColor: '#0284c7' },
          }, 'Chụp khung hình') : null,
        ),
        scannerActive ? h('video', {
          ref: videoRef,
          muted: true,
          playsInline: true,
          style: { width: '100%', maxHeight: 200, borderRadius: 8, background: '#000', marginBottom: 10 },
        }) : null,
        scannerActive && scannerMode === 'camera_canvas_fallback' ? h('canvas', {
          ref: qrCanvasRef,
          width: 320,
          height: 240,
          'data-testid': 'mobile-pwa-qr-canvas',
          style: { display: 'none' },
        }) : null,
        qrSnapshotUrl ? h('img', {
          src: qrSnapshotUrl,
          alt: 'Khung hình QR đã chụp',
          'data-testid': 'mobile-pwa-qr-snapshot-preview',
          style: { width: '100%', maxHeight: 140, objectFit: 'contain', borderRadius: 8, marginBottom: 8, border: '1px solid #475569' },
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

      // ePOD Capture Form + GPS + Camera Photo + Canvas Signature
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

        // Camera Photo Evidence Capture
        h('div', { style: { marginBottom: 12 } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, gap: 8 } },
            h('span', { style: { ...labelStyle, marginBottom: 0 } }, 'Ảnh minh chứng giao hàng (Camera / Tệp)'),
            h('div', { style: { display: 'flex', gap: 6 } },
              h('button', {
                type: 'button',
                'data-testid': 'mobile-pwa-photo-camera-btn',
                onClick: photoCameraActive ? stopPhotoCamera : startPhotoCamera,
                style: { ...btnSecondaryStyle, minHeight: 36, padding: '6px 10px', fontSize: 12 },
              }, photoCameraActive ? 'Tắt Camera ảnh' : 'Chụp bằng Camera'),
              evidencePhotoDataUrl ? h('button', {
                type: 'button',
                'data-testid': 'mobile-pwa-photo-clear',
                onClick: () => setEvidencePhotoDataUrl(''),
                style: { ...btnSecondaryStyle, minHeight: 36, padding: '6px 10px', fontSize: 12, background: '#7f1d1d' },
              }, 'Xóa ảnh') : null,
            ),
          ),
          h('input', {
            type: 'file',
            accept: 'image/*',
            capture: 'environment',
            'data-testid': 'mobile-pwa-photo-input',
            onChange: handlePhotoFileChange,
            style: { ...inputStyle, padding: '8px 10px', fontSize: 13 },
          }),
          photoCameraActive ? h('div', { style: { marginBottom: 8 } },
            h('video', {
              ref: photoVideoRef,
              muted: true,
              playsInline: true,
              'data-testid': 'mobile-pwa-photo-video',
              style: { width: '100%', maxHeight: 180, borderRadius: 8, background: '#000', marginBottom: 6 },
            }),
            h('button', {
              type: 'button',
              'data-testid': 'mobile-pwa-photo-snapshot-btn',
              onClick: capturePhotoSnapshot,
              style: { ...btnSecondaryStyle, width: '100%', background: '#0284c7', borderColor: '#0284c7' },
            }, 'Chụp ảnh minh chứng'),
          ) : null,
          evidencePhotoDataUrl ? h('img', {
            src: evidencePhotoDataUrl,
            alt: 'Ảnh minh chứng ePOD',
            'data-testid': 'mobile-pwa-photo-preview',
            style: { width: '100%', maxHeight: 180, objectFit: 'cover', borderRadius: 8, border: '1px solid #475569' },
          }) : null,
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
          disabled: twinBusy,
          onClick: submitTwinDesired,
          style: { ...btnSecondaryStyle, width: '100%', opacity: twinBusy ? 0.65 : 1 },
        }, twinBusy ? 'Đang gửi lệnh...' : 'Gửi lệnh Digital Twin'),
      ),

      // Collapsible Floating AI Assistant Drawer + Pill (never buries above-the-fold cards)
      aiOpen ? h('section', {
        'data-testid': 'mobile-pwa-ai-drawer',
        style: {
          position: 'fixed',
          right: 12,
          bottom: 66,
          width: 'calc(100vw - 24px)',
          maxWidth: 380,
          background: '#1e293b',
          border: '1px solid #38bdf8',
          borderRadius: 12,
          padding: 12,
          boxShadow: '0 12px 30px rgba(0, 0, 0, 0.45)',
          zIndex: 1045,
        },
      },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 } },
          h('strong', { style: { fontSize: 13 } }, 'Trợ lý AI Hiện trường'),
          h('button', {
            type: 'button',
            'data-testid': 'mobile-pwa-ai-close',
            onClick: () => setAiOpen(false),
            style: { ...btnSecondaryStyle, minHeight: 30, padding: '4px 10px', fontSize: 12 },
          }, 'Thu gọn'),
        ),
        aiMessages.length > 0 ? h('div', {
          'data-testid': 'mobile-pwa-ai-thread',
          style: { maxHeight: 220, overflowY: 'auto', display: 'grid', gap: 6, marginBottom: 8 },
        }, aiMessages.map((msg, idx) => {
          const isUser = msg.role === 'user';
          const isLatestReply = !isUser && idx === aiMessages.map((m) => m.role !== 'user').lastIndexOf(true);
          return h('div', {
            key: msg.id || idx,
            ...(isLatestReply ? { 'data-testid': 'mobile-pwa-ai-reply' } : {}),
            style: {
              fontSize: 12,
              color: msg.role === 'error' ? '#fecaca' : '#e2e8f0',
              background: isUser ? '#0369a1' : (msg.role === 'error' ? '#7f1d1d' : '#0f172a'),
              padding: '7px 9px',
              borderRadius: 8,
              justifySelf: isUser ? 'end' : 'stretch',
              maxWidth: isUser ? '88%' : '100%',
              whiteSpace: 'pre-wrap',
            },
          }, msg.text);
        })) : null,
        h('form', {
          'data-testid': 'mobile-pwa-ai-form',
          onSubmit: submitMobileAiPrompt,
          style: { display: 'flex', gap: 6 },
        },
          h('input', {
            type: 'text',
            'data-testid': 'mobile-pwa-ai-input',
            value: aiPrompt,
            onChange: (e) => setAiPrompt(e?.target?.value ?? ''),
            placeholder: 'Hỏi AI về đơn giao nhận hoặc sự cố...',
            style: { ...inputStyle, marginBottom: 0, flex: 1, minHeight: 38, fontSize: 13 },
          }),
          h('button', {
            type: 'submit',
            'data-testid': 'mobile-pwa-ai-send',
            disabled: aiBusy,
            style: { ...btnSecondaryStyle, minHeight: 38, padding: '6px 12px', background: '#0284c7', borderColor: '#0284c7', fontSize: 12 },
          }, aiBusy ? '...' : 'Gửi'),
        ),
      ) : null,
      h('button', {
        type: 'button',
        'data-testid': 'mobile-pwa-ai-pill',
        onClick: () => setAiOpen((v) => !v),
        style: {
          position: 'fixed',
          right: 14,
          bottom: 14,
          zIndex: 1046,
          minHeight: 40,
          padding: '8px 14px',
          borderRadius: 999,
          border: '1px solid #38bdf8',
          background: '#0369a1',
          color: '#ffffff',
          fontSize: 13,
          fontWeight: 700,
          cursor: 'pointer',
          boxShadow: '0 4px 14px rgba(2, 132, 199, 0.35)',
        },
      }, aiOpen ? 'Ẩn Trợ lý AI' : 'Trợ lý AI'),
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
  enqueueOutboxItem,
  listOutboxItems,
  removeOutboxItem,
  updateOutboxStatus,
  parseFieldQrPayload,
  buildEpodPayload,
  resolveClientAuthToken,
  isAuthenticatedMobileClient,
  createMobileFieldPwaPage,
};
