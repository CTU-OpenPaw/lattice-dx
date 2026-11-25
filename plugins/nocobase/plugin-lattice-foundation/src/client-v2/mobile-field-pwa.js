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

    const [notifUnreadCount, setNotifUnreadCount] = React.useState(() => {
      const initial = Number(props.notificationUnreadCount);
      return Number.isFinite(initial) && initial >= 0 ? initial : 0;
    });
    const [notifOpen, setNotifOpen] = React.useState(false);
    const [notifItems, setNotifItems] = React.useState([]);
    const [notifLoading, setNotifLoading] = React.useState(false);

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
        if (mountedRef.current && Number.isFinite(count) && count >= 0) {
          setNotifUnreadCount(count);
        }
        return count;
      } catch {
        return null;
      }
    }, [apiClient]);

    refreshUnreadCountRef.current = refreshUnreadCount;

    React.useEffect(() => {
      if (!isAuthenticatedMobileClient(apiClient, storageRef.current)) return undefined;
      refreshUnreadCountRef.current?.();

      const fetchFn = props.fetchImpl
        || (typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function' ? globalThis.fetch : null)
        || (typeof fetch === 'function' ? fetch : null);
      if (!isOnline || typeof fetchFn !== 'function') return undefined;

      let disposed = false;
      let controller = null;
      let activeReader = null;
      let reconnectTimer = null;
      let retryAttempt = 0;

      const handleSsePayload = (eventName, parsed) => {
        if (!mountedRef.current || disposed || !parsed || typeof parsed !== 'object') return;
        if (Number.isFinite(Number(parsed.unreadCount)) && Number(parsed.unreadCount) >= 0) {
          setNotifUnreadCount(Number(parsed.unreadCount));
          return;
        }
        const kind = String(parsed.kind || parsed.type || '').trim().toLowerCase();
        if (kind === 'notification' || kind === 'unread_count' || eventName === 'notification' || eventName === 'unread_count') {
          refreshUnreadCountRef.current?.();
        }
      };

      const connectSse = async () => {
        if (disposed || !mountedRef.current) return;
        const token = resolveClientAuthToken(apiClient, storageRef.current);
        if (!token) return;
        const baseApi = typeof apiClient?.getBaseURL === 'function' ? apiClient.getBaseURL() : '/api/';
        const prefix = String(baseApi || '/api/').replace(/\/?$/, '/');
        const sseUrl = props.notificationSseUrl || `${prefix}dxosAi:surfaceEvents?portalSlug=mobile`;
        controller = typeof AbortController === 'function' ? new AbortController() : null;
        let stopReconnect = false;
        try {
          const res = await fetchFn(sseUrl, {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'text/event-stream',
            },
            credentials: 'same-origin',
            ...(controller ? { signal: controller.signal } : {}),
          });
          if (res && (res.status === 401 || res.status === 403)) {
            stopReconnect = true;
            return;
          }
          if (!res?.ok || !res.body?.getReader) {
            throw new Error('SSE_UNAVAILABLE');
          }
          retryAttempt = 0;
          activeReader = res.body.getReader();
          const decoder = typeof TextDecoder === 'function' ? new TextDecoder('utf-8') : null;
          let buffer = '';
          while (!disposed && mountedRef.current) {
            const part = await activeReader.read();
            if (part.done) break;
            const text = decoder ? decoder.decode(part.value, { stream: true }) : String(part.value || '');
            buffer += text;
            const parsed = parseSseChunk(buffer);
            buffer = parsed.rest;
            for (const frame of parsed.frames) {
              if (frame.event === 'snapshot') {
                retryAttempt = 0;
                continue;
              }
              if (['notification', 'unread_count', 'update', 'message'].includes(frame.event)) {
                handleSsePayload(frame.event, frame.data);
              }
            }
          }
        } catch {
          // Transient drop handled below unless disposed or 401/403
        } finally {
          activeReader = null;
        }
        if (!disposed && mountedRef.current && !stopReconnect && !reconnectTimer) {
          const delayMs = Math.min(60_000, 3_000 * (2 ** Math.min(4, retryAttempt)));
          retryAttempt += 1;
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connectSse();
          }, delayMs);
          if (typeof reconnectTimer?.unref === 'function') reconnectTimer.unref();
        }
      };

      connectSse();

      return () => {
        disposed = true;
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        controller?.abort?.();
        try { activeReader?.cancel?.(); } catch {}
        activeReader = null;
      };
    }, [apiClient, isOnline, props.fetchImpl, props.notificationSseUrl]);

    const toggleNotifications = React.useCallback(async () => {
      const next = !notifOpen;
      setNotifOpen(next);
      if (!next || !isAuthenticatedMobileClient(apiClient, storageRef.current)) return;
      setNotifLoading(true);
      try {
        const res = await apiClient.request({
          url: 'latticeNotifications:listMine',
          method: 'get',
          params: { limit: 15 },
          skipNotify: true,
        });
        const data = res?.data?.data || res?.data || {};
        if (mountedRef.current) {
          setNotifItems(Array.isArray(data.items) ? data.items : []);
          if (data.unreadCount != null && Number.isFinite(Number(data.unreadCount))) {
            setNotifUnreadCount(Math.max(0, Number(data.unreadCount)));
          }
        }
      } catch {
        // Retain current items on error
      } finally {
        if (mountedRef.current) setNotifLoading(false);
      }
    }, [apiClient, notifOpen]);

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
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 } },
          h('strong', { style: { fontSize: 14 } }, `Hộp thư thông báo (${notifUnreadCount} chưa đọc)`),
          h('button', {
            type: 'button',
            onClick: () => setNotifOpen(false),
            style: { ...btnSecondaryStyle, minHeight: 32, padding: '4px 10px', fontSize: 12 },
          }, 'Đóng'),
        ),
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
                h('div', { style: { fontWeight: 700 } }, it.title),
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
                h('div', { style: { display: 'flex', gap: 8, marginTop: 8 } },
                  h('button', {
                    type: 'button',
                    'data-testid': `mobile-pwa-outbox-retry-${item.id}`,
                    disabled: retryingItemId === item.id,
                    onClick: () => retrySingleOutboxItem(item),
                    style: { ...btnSecondaryStyle, minHeight: 34, padding: '4px 10px', fontSize: 12, background: '#0369a1' },
                  }, retryingItemId === item.id ? 'Đang thử lại...' : 'Thử lại'),
                  h('button', {
                    type: 'button',
                    'data-testid': `mobile-pwa-outbox-delete-${item.id}`,
                    onClick: () => deleteSingleOutboxItem(item.id),
                    style: { ...btnSecondaryStyle, minHeight: 34, padding: '4px 10px', fontSize: 12, background: '#7f1d1d', borderColor: '#ef4444' },
                  }, 'Xóa'),
                ),
              );
            }),
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
