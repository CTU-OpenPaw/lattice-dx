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
  SAFE_COLLECTION_RE,
  CUSTOM_COLLECTION_RE,
  isSafeAppPath,
  fetchCollectionsMeta,
  inferCollectionFieldsMeta,
  getStatusMeta,
  formatStatusLabel,
  stripDevBracketTags,
} = require('./blocks-helpers');

const KANBAN_STAGE_ORDER = ['draft', 'submitted', 'approved', 'in_progress', 'completed', 'cancelled'];
const LOGISTICS_ACTIVE_STAGES = ['preparing', 'ready_for_dispatch', 'in_transit'];
const STOCK_LOT_STAGE_ORDER = ['available', 'reserved', 'hold_mkt', 'expired'];
const ALLOWED_KANBAN_COLLECTIONS = new Set([
  'latticeOrders',
  'latticeRequests',
  'latticeServiceTickets',
  'latticeStockLots',
]);
const VOUCHER_COLLECTIONS = new Set(['latticeOrders', 'latticeRequests', 'latticeServiceTickets']);
const CANCELLABLE_STAGES = new Set(['submitted', 'approved', 'in_progress']);
const DEFAULT_SCHEDULE_DATE_FIELDS = ['dueDate', 'scheduledAt', 'startDate', 'expiryDate', 'submittedAt', 'createdAt'];

const STAGE_META = {
  draft: getStatusMeta('draft'),
  submitted: getStatusMeta('submitted'),
  approved: getStatusMeta('approved'),
  preparing: getStatusMeta('preparing'),
  ready_for_dispatch: getStatusMeta('ready_for_dispatch'),
  in_transit: getStatusMeta('in_transit'),
  in_progress: getStatusMeta('in_progress'),
  completed: getStatusMeta('completed'),
  cancelled: getStatusMeta('cancelled'),
  available: getStatusMeta('available'),
  reserved: getStatusMeta('reserved'),
  hold_mkt: getStatusMeta('hold_mkt'),
  expired: getStatusMeta('expired'),
};

const WEEKDAY_LABELS = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
const SAFE_KANBAN_COLLECTION_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
const BLOCKED_PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function normalizeKanbanCollection(raw) {
  const clean = String(raw || '').trim();
  if (!clean || BLOCKED_PROTO_KEYS.has(clean)) return 'latticeOrders';
  if (ALLOWED_KANBAN_COLLECTIONS.has(clean) || CUSTOM_COLLECTION_RE.test(clean) || SAFE_KANBAN_COLLECTION_RE.test(clean)) {
    return clean;
  }
  return 'latticeOrders';
}

function getStagesForCollection(collection) {
  return collection === 'latticeStockLots' ? STOCK_LOT_STAGE_ORDER.slice() : KANBAN_STAGE_ORDER.slice();
}

function dedupeStageValues(items) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const val = item && typeof item === 'object'
      ? String(item.value ?? item.stage ?? item.label ?? '').trim()
      : String(item ?? '').trim();
    if (!val || BLOCKED_PROTO_KEYS.has(val) || seen.has(val)) continue;
    seen.add(val);
    out.push(val);
  }
  return out;
}

function mergeObservedLogisticsStages(baseStages, records, statusField, collection) {
  const stages = Array.isArray(baseStages) ? baseStages.slice() : [];
  if (!collection || collection === 'latticeStockLots' || !VOUCHER_COLLECTIONS.has(collection)) {
    return stages;
  }
  if (!Array.isArray(records) || !records.length) {
    return stages;
  }
  const observedLogistics = new Set();
  for (const rec of records) {
    if (!rec || typeof rec !== 'object') continue;
    const rawVal = String(rec[statusField] ?? '').trim().toLowerCase();
    if (LOGISTICS_ACTIVE_STAGES.includes(rawVal)) {
      observedLogistics.add(rawVal);
    }
  }
  if (!observedLogistics.size) {
    return stages;
  }
  const existingLower = new Set(stages.map((s) => String(s).toLowerCase()));
  const activeToInsert = LOGISTICS_ACTIVE_STAGES.filter(
    (s) => observedLogistics.has(s) && !existingLower.has(s),
  );
  if (!activeToInsert.length) {
    return stages;
  }
  const approvedIdx = stages.findIndex((s) => String(s).toLowerCase() === 'approved');
  const insertAt = approvedIdx >= 0 ? approvedIdx + 1 : stages.length;
  stages.splice(insertAt, 0, ...activeToInsert);
  return stages;
}

function inferKanbanStages(meta, records = [], cfg = {}) {
  const explicitStages = dedupeStageValues(cfg?.stages);
  if (explicitStages.length) return explicitStages;

  const inferred = inferCollectionFieldsMeta(meta);
  const statusField = String(cfg?.statusField || inferred.statusField || 'status').trim() || 'status';
  const col = cfg?.collection ? normalizeKanbanCollection(cfg.collection) : '';

  let metaEnumSource = null;
  if (Array.isArray(meta?.fields)) {
    const matchedField = meta.fields.find((f) => String(f?.name || '').trim() === statusField)
      || meta.fields.find((f) => String(f?.name || '').trim().toLowerCase() === statusField.toLowerCase());
    if (Array.isArray(matchedField?.enumValues) && matchedField.enumValues.length) {
      metaEnumSource = matchedField.enumValues;
    }
  }
  if (!metaEnumSource && Array.isArray(meta?.stages) && meta.stages.length) {
    metaEnumSource = meta.stages;
  } else if (!metaEnumSource && inferred.stages.length && statusField === inferred.statusField) {
    metaEnumSource = inferred.stages;
  }
  const metaStages = dedupeStageValues(metaEnumSource);
  if (metaStages.length) {
    return mergeObservedLogisticsStages(metaStages, records, statusField, col);
  }

  if (col && ALLOWED_KANBAN_COLLECTIONS.has(col)) {
    return mergeObservedLogisticsStages(getStagesForCollection(col), records, statusField, col);
  }

  const liveStages = [];
  const seenLive = new Set();
  for (const rec of Array.isArray(records) ? records : []) {
    if (!rec || typeof rec !== 'object') continue;
    const rawVal = String(rec[statusField] ?? '').trim();
    if (!rawVal || BLOCKED_PROTO_KEYS.has(rawVal) || seenLive.has(rawVal)) continue;
    seenLive.add(rawVal);
    liveStages.push(rawVal);
  }
  if (liveStages.length) return liveStages;

  return KANBAN_STAGE_ORDER.slice();
}

function buildStageLabelMap(meta, statusField, cfg = {}) {
  const labels = {};
  for (const item of Array.isArray(cfg?.stages) ? cfg.stages : []) {
    if (item && typeof item === 'object') {
      const value = String(item.value ?? item.stage ?? '').trim();
      const label = String(item.label ?? value).trim();
      if (value && label) labels[value] = label;
    }
  }
  if (Array.isArray(meta?.fields)) {
    const fieldObj = meta.fields.find((f) => String(f?.name || '').trim() === statusField)
      || meta.fields.find((f) => String(f?.name || '').trim().toLowerCase() === statusField.toLowerCase());
    for (const item of Array.isArray(fieldObj?.enumValues) ? fieldObj.enumValues : []) {
      const value = item && typeof item === 'object' ? String(item.value ?? '').trim() : String(item ?? '').trim();
      const label = item && typeof item === 'object' ? String(item.label ?? value).trim() : value;
      if (value && label && !labels[value]) labels[value] = label;
    }
  }
  return labels;
}

function resolveRecordStage(record, collection, { statusField = 'status', stages = null } = {}) {
  const rawRaw = String(record?.[statusField] ?? '').trim();
  const rawStatus = rawRaw.toLowerCase();
  if (collection === 'latticeStockLots' && statusField === 'status' && (!stages || stages.length === STOCK_LOT_STAGE_ORDER.length)) {
    if (rawStatus === 'expired') return 'expired';
    const expTs = record?.expiryDate ? Date.parse(String(record.expiryDate)) : NaN;
    if (Number.isFinite(expTs) && expTs <= Date.now() && rawStatus !== 'hold_mkt') {
      return 'expired';
    }
    if (rawStatus === 'hold_mkt') return 'hold_mkt';
    if (rawStatus === 'reserved') return 'reserved';
    if (rawStatus === 'available' && Number(record?.qtyReserved) > 0) return 'reserved';
    if (STOCK_LOT_STAGE_ORDER.includes(rawStatus)) return rawStatus;
    return 'available';
  }
  if (Array.isArray(stages) && stages.length) {
    if (stages.includes(rawRaw)) return rawRaw;
    const ci = stages.find((s) => s.toLowerCase() === rawStatus);
    if (ci) return ci;
    if (LOGISTICS_ACTIVE_STAGES.includes(rawStatus)) {
      const inProg = stages.find((s) => s.toLowerCase() === 'in_progress');
      if (inProg) return inProg;
    }
    return stages[0];
  }
  if (KANBAN_STAGE_ORDER.includes(rawStatus) || LOGISTICS_ACTIVE_STAGES.includes(rawStatus)) {
    return rawStatus;
  }
  return 'draft';
}

function groupRecordsByKanbanStage(records, collection = 'latticeOrders', options = {}) {
  const targetCol = normalizeKanbanCollection(collection);
  const meta = options?.meta || null;
  const inferred = inferCollectionFieldsMeta(meta);
  const statusField = String(options?.statusField || inferred.statusField || 'status').trim() || 'status';
  const stages = inferKanbanStages(meta, records, {
    collection: targetCol,
    statusField,
    stages: options?.stages,
  });
  const stageLabels = buildStageLabelMap(meta, statusField, options);
  const byStage = Object.create(null);
  for (const st of stages) byStage[st] = [];

  for (const rec of Array.isArray(records) ? records : []) {
    if (!rec || typeof rec !== 'object') continue;
    const st = resolveRecordStage(rec, targetCol, { statusField, stages });
    if (!Object.hasOwn(byStage, st)) byStage[stages[0]].push(rec);
    else byStage[st].push(rec);
  }

  const columns = stages.map((st) => {
    const baseMeta = STAGE_META[st] || { label: st, color: '#334155', bg: '#f8fafc', border: '#cbd5e1' };
    return {
      stage: st,
      ...baseMeta,
      label: stageLabels[st] || baseMeta.label || st,
      items: byStage[st],
    };
  });

  return { stages, columns, byStage, statusField };
}

function parseRecordScheduleDate(record, dateFields = null, preferredField = '') {
  const candidates = [];
  if (preferredField) candidates.push(preferredField);
  if (Array.isArray(dateFields) && dateFields.length) {
    for (const f of dateFields) {
      if (f && !candidates.includes(f)) candidates.push(f);
    }
  }
  for (const f of ['submittedAt', 'expiryDate', 'dueDate', 'scheduledAt', 'startDate', 'createdAt']) {
    if (!candidates.includes(f)) candidates.push(f);
  }
  for (const field of candidates) {
    const raw = record?.[field];
    if (raw == null || raw === '') continue;
    const ts = raw instanceof Date ? raw.getTime() : Date.parse(String(raw));
    if (Number.isFinite(ts)) return new Date(ts);
  }
  return null;
}

const VN_DATE_KEY_FMT = typeof Intl !== 'undefined' && typeof Intl.DateTimeFormat === 'function'
  ? new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Ho_Chi_Minh',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
  : null;

function toVnDateKey(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return '';
  if (VN_DATE_KEY_FMT) {
    const parts = VN_DATE_KEY_FMT.formatToParts(date);
    const y = parts.find((p) => p.type === 'year')?.value;
    const m = parts.find((p) => p.type === 'month')?.value;
    const d = parts.find((p) => p.type === 'day')?.value;
    if (y && m && d) return `${y}-${m}-${d}`;
  }
  const vnDate = new Date(date.getTime() + 7 * 3600 * 1000);
  const y = vnDate.getUTCFullYear();
  const m = String(vnDate.getUTCMonth() + 1).padStart(2, '0');
  const d = String(vnDate.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getVnMonday(referenceDate) {
  let y;
  let m;
  let d;
  if (typeof referenceDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(referenceDate.trim())) {
    [y, m, d] = referenceDate.trim().split('-').map(Number);
  } else if (referenceDate instanceof Date && Number.isFinite(referenceDate.getTime())) {
    [y, m, d] = toVnDateKey(referenceDate).split('-').map(Number);
  } else if (typeof referenceDate === 'string' && Number.isFinite(Date.parse(referenceDate.trim()))) {
    [y, m, d] = toVnDateKey(new Date(Date.parse(referenceDate.trim()))).split('-').map(Number);
  } else {
    [y, m, d] = toVnDateKey(new Date()).split('-').map(Number);
  }
  const base = new Date(Date.UTC(y, m - 1, d));
  const day = base.getUTCDay();
  const diffToMon = day === 0 ? -6 : 1 - day;
  base.setUTCDate(base.getUTCDate() + diffToMon);
  return base;
}

function buildScheduleDaysGrid(records, referenceDate = new Date(), options = {}) {
  const monday = getVnMonday(referenceDate);
  const days = [];
  const dayMap = new Map();
  const todayKey = toVnDateKey(new Date());
  const dateFields = Array.isArray(options?.dateFields) ? options.dateFields : null;
  const preferredDateField = typeof options?.dateField === 'string' ? options.dateField.trim() : '';

  for (let i = 0; i < 7; i += 1) {
    const dt = new Date(monday.getTime());
    dt.setUTCDate(monday.getUTCDate() + i);
    const y = dt.getUTCFullYear();
    const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const d = String(dt.getUTCDate()).padStart(2, '0');
    const dateKey = `${y}-${m}-${d}`;
    const weekday = WEEKDAY_LABELS[dt.getUTCDay()];
    const entry = {
      dateKey,
      label: `${weekday} ${d}/${m}`,
      weekday: dt.getUTCDay(),
      isToday: dateKey === todayKey,
      items: [],
    };
    days.push(entry);
    dayMap.set(dateKey, entry);
  }

  const unscheduled = [];
  for (const rec of Array.isArray(records) ? records : []) {
    if (!rec || typeof rec !== 'object') continue;
    const dt = parseRecordScheduleDate(rec, dateFields, preferredDateField);
    if (!dt) {
      unscheduled.push(rec);
      continue;
    }
    const bucket = dayMap.get(toVnDateKey(dt));
    if (bucket) bucket.items.push(rec);
  }

  return {
    weekStart: days[0].dateKey,
    weekEnd: days[6].dateKey,
    days,
    unscheduled,
  };
}

function resolveSlaBadge(rec, statusField = 'status') {
  const rawSla = String(rec?.slaStatus || '').trim().toLowerCase();
  if (rawSla === 'breached' || rawSla === 'critical') {
    return { level: 'breached', label: 'SLA Quá hạn', bg: '#fee2e2', color: '#991b1b', border: '#fca5a5' };
  }
  if (rawSla === 'warning') {
    return { level: 'warning', label: 'SLA Sắp hạn', bg: '#fef3c7', color: '#92400e', border: '#fcd34d' };
  }
  const dueRaw = rec?.dueDate || rec?.scheduledAt || rec?.expiryDate;
  if (dueRaw) {
    const dueMs = Date.parse(String(dueRaw));
    const status = String(rec?.[statusField] ?? rec?.status ?? '').toLowerCase();
    if (Number.isFinite(dueMs) && !['completed', 'cancelled', 'depleted', 'fixed', 'closed', 'done'].includes(status)) {
      const diffHours = (dueMs - Date.now()) / 3600000;
      if (diffHours < 0) return { level: 'breached', label: 'Quá hạn', bg: '#fee2e2', color: '#991b1b', border: '#fca5a5' };
      if (diffHours <= 48) return { level: 'warning', label: 'Sắp đến hạn', bg: '#fef3c7', color: '#92400e', border: '#fcd34d' };
    }
  }
  return null;
}

function formatDateChip(rec, dateFields = null, preferredField = '') {
  const dt = parseRecordScheduleDate(rec, dateFields, preferredField);
  if (!dt) return '';
  return toVnDateKey(dt);
}

function resolveRecordDisplayTitle(rec, titleField) {
  if (titleField && rec?.[titleField] != null && String(rec[titleField]).trim()) {
    return String(rec[titleField]);
  }
  return String(rec?.name || rec?.title || rec?.subject || rec?.productName || 'Bản ghi');
}

function createKanbanScheduleBlockView(client, React, _antd, app, { subscribeModelConfig } = {}) {
  const h = React.createElement;
  const useApi = typeof client?.useAPIClient === 'function' ? client.useAPIClient : () => app?.apiClient || null;

  return function DxosKanbanScheduleBlockView({ model, liveConfig }) {
    const api = useApi();
    const [, setTick] = React.useState(0);
    React.useEffect(
      () => (typeof subscribeModelConfig === 'function' ? subscribeModelConfig(model, () => setTick((t) => t + 1)) : undefined),
      [model],
    );

    const stepCfg = model?.getStepParams?.('dxosBlockSettings', 'config')
      || model?.stepParams?.dxosBlockSettings?.config
      || {};
    const cfg = {
      title: 'Bảng Kanban & Lịch vận hành [H]',
      collection: 'latticeOrders',
      viewMode: 'kanban',
      pageSize: 40,
      ...(model?.props || {}),
      ...stepCfg,
      ...(liveConfig || {}),
    };

    const configuredCollection = normalizeKanbanCollection(cfg.collection);
    const configuredMode = cfg.viewMode === 'schedule' ? 'schedule' : 'kanban';
    const [activeCollection, setActiveCollection] = React.useState(configuredCollection);
    const [viewMode, setViewMode] = React.useState(configuredMode);
    const [searchQuery, setSearchQuery] = React.useState('');
    const [weekOffset, setWeekOffset] = React.useState(0);
    const [records, setRecords] = React.useState([]);
    const [collectionsMeta, setCollectionsMeta] = React.useState([]);
    const [loading, setLoading] = React.useState(false);
    const [busyId, setBusyId] = React.useState(null);
    const [draggedRecordId, setDraggedRecordId] = React.useState(null);
    const [dragOverStage, setDragOverStage] = React.useState(null);
    const [cancelTargetId, setCancelTargetId] = React.useState(null);
    const [cancelReason, setCancelReason] = React.useState('');
    const [statusNote, setStatusNote] = React.useState('');
    const [selectedRecord, setSelectedRecord] = React.useState(null);
    const [gatedDropCta, setGatedDropCta] = React.useState(false);
    const [reqTracker] = React.useState(() => ({
      seq: 0,
      unmounted: false,
      collection: configuredCollection,
    }));

    React.useEffect(() => {
      reqTracker.unmounted = false;
      return () => {
        reqTracker.unmounted = true;
        reqTracker.seq += 1;
      };
    }, [reqTracker]);

    React.useEffect(() => {
      let cancelled = false;
      if (!api?.request) return undefined;
      fetchCollectionsMeta(api)
        .then((cols) => {
          if (!cancelled && !reqTracker.unmounted && Array.isArray(cols)) {
            setCollectionsMeta(cols);
          }
        })
        .catch(() => {});
      return () => { cancelled = true; };
    }, [api, reqTracker]);

    React.useEffect(() => {
      setActiveCollection(configuredCollection);
    }, [configuredCollection]);

    React.useEffect(() => {
      setViewMode(configuredMode);
    }, [configuredMode]);

    React.useEffect(() => {
      if (reqTracker.collection !== activeCollection) {
        reqTracker.collection = activeCollection;
        reqTracker.seq += 1;
        setRecords([]);
        setCancelTargetId(null);
        setCancelReason('');
        setStatusNote('');
        setSelectedRecord(null);
        setGatedDropCta(false);
        setDraggedRecordId(null);
        setDragOverStage(null);
      }
    }, [activeCollection, reqTracker]);

    const activeMeta = React.useMemo(() => {
      if (cfg.collectionMeta && typeof cfg.collectionMeta === 'object') {
        if (!cfg.collectionMeta.name || cfg.collectionMeta.name === activeCollection) {
          return cfg.collectionMeta;
        }
      }
      return collectionsMeta.find((c) => c?.name === activeCollection) || null;
    }, [cfg.collectionMeta, collectionsMeta, activeCollection]);

    const inferredMeta = React.useMemo(
      () => inferCollectionFieldsMeta(activeMeta),
      [activeMeta],
    );

    const rawStatusField = String(cfg.statusField || inferredMeta.statusField || 'status').trim();
    const effectiveStatusField = /^[a-zA-Z][a-zA-Z0-9_]{0,62}$/.test(rawStatusField)
      && !['__proto__', 'constructor', 'prototype'].includes(rawStatusField)
      ? rawStatusField
      : 'status';
    const effectiveDateField = typeof cfg.dateField === 'string' ? cfg.dateField.trim() : '';
    const effectiveDateFields = React.useMemo(() => {
      const list = Array.isArray(inferredMeta.dateFields) && inferredMeta.dateFields.length
        ? inferredMeta.dateFields.slice()
        : DEFAULT_SCHEDULE_DATE_FIELDS.slice();
      if (effectiveDateField) {
        return [effectiveDateField, ...list.filter((f) => f !== effectiveDateField)];
      }
      return list;
    }, [effectiveDateField, inferredMeta.dateFields]);
    const effectiveTitleField = String(cfg.titleField || inferredMeta.titleField || '').trim() || '';

    const loadRecords = React.useCallback(async (isCancelled = null) => {
      if (!api?.request) return;
      reqTracker.seq += 1;
      const mySeq = reqTracker.seq;
      const targetCollection = activeCollection;
      const isStale = () => (
        reqTracker.unmounted
        || reqTracker.seq !== mySeq
        || reqTracker.collection !== targetCollection
        || (typeof isCancelled === 'function' && isCancelled())
      );

      setLoading(true);
      setStatusNote('');
      setGatedDropCta(false);
      const limit = Math.max(5, Math.min(100, Number(cfg.pageSize) || 40));
      try {
        const res = await api.request({
          url: `${targetCollection}:list`,
          method: 'get',
          params: { pageSize: limit, sort: ['-id'] },
          skipNotify: true,
        });
        if (isStale()) return;
        const rows = res?.data?.data ?? res?.data?.items ?? [];
        setRecords(Array.isArray(rows) ? rows : []);
      } catch {
        if (isStale()) return;
        if (targetCollection === 'latticeStockLots') {
          try {
            const lotsRes = await api.request({
              url: 'dxosWms:lots',
              method: 'get',
              params: { limit },
              skipNotify: true,
            });
            if (isStale()) return;
            const items = lotsRes?.data?.data?.items ?? lotsRes?.data?.items ?? [];
            setRecords(Array.isArray(items) ? items : []);
          } catch {
            if (isStale()) return;
            setRecords([]);
            setStatusNote('Không tải được danh sách lô tồn kho.');
          }
        } else {
          setRecords([]);
          setStatusNote('Không tải được dữ liệu cho phân hệ đã chọn.');
        }
      } finally {
        if (!isStale()) setLoading(false);
      }
    }, [api, activeCollection, cfg.pageSize, reqTracker]);

    React.useEffect(() => {
      let cancelled = false;
      loadRecords(() => cancelled);
      return () => { cancelled = true; };
    }, [loadRecords]);

    const filteredRecords = React.useMemo(() => {
      const q = String(searchQuery || '').trim().toLowerCase();
      if (!q) return records;
      return records.filter((rec) => {
        const titleVal = effectiveTitleField ? (rec[effectiveTitleField] ?? '') : '';
        const statusVal = rec[effectiveStatusField] ?? '';
        const hay = `${rec.code || ''} ${rec.lotCode || ''} ${rec.name || ''} ${rec.title || ''} ${rec.subject || ''} ${rec.productName || ''} ${rec.sku || ''} ${rec.customer || ''} ${titleVal} ${statusVal}`.toLowerCase();
        return hay.includes(q);
      });
    }, [records, searchQuery, effectiveTitleField, effectiveStatusField]);

    const kanbanData = React.useMemo(
      () => groupRecordsByKanbanStage(filteredRecords, activeCollection, {
        meta: activeMeta,
        statusField: effectiveStatusField,
        stages: cfg.stages,
      }),
      [filteredRecords, activeCollection, activeMeta, effectiveStatusField, cfg.stages],
    );

    const scheduleRefDate = React.useMemo(() => {
      const mon = getVnMonday(new Date());
      mon.setUTCDate(mon.getUTCDate() + weekOffset * 7);
      const y = mon.getUTCFullYear();
      const m = String(mon.getUTCMonth() + 1).padStart(2, '0');
      const d = String(mon.getUTCDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }, [weekOffset]);

    const scheduleGrid = React.useMemo(
      () => buildScheduleDaysGrid(filteredRecords, scheduleRefDate, {
        dateField: effectiveDateField,
        dateFields: effectiveDateFields,
      }),
      [filteredRecords, scheduleRefDate, effectiveDateField, effectiveDateFields],
    );

    const runVoucherStageAction = async (rec, action) => {
      if (!api?.request || !VOUCHER_COLLECTIONS.has(activeCollection) || !rec?.id || busyId != null) return;
      if (action === 'cancel') {
        const cleanReason = String(cancelReason || '').trim();
        if (cleanReason.length < 3 || cleanReason.length > 255) {
          setStatusNote('Cần nhập lý do hủy từ 3 đến 255 ký tự.');
          return;
        }
      }
      const targetCollection = activeCollection;
      setGatedDropCta(false);
      setBusyId(rec.id);
      try {
        setStatusNote(action === 'submit' ? `Đang trình duyệt ${rec.code || `#${rec.id}`}…` : `Đang hủy ${rec.code || `#${rec.id}`}…`);
        await api.request({
          url: `latticeVoucher:${action}`,
          method: 'post',
          data: {
            collection: targetCollection,
            id: Number(rec.id),
            ...(rec.version != null ? { expectedVersion: rec.version } : {}),
            ...(action === 'cancel' ? { cancelReason: String(cancelReason).trim() } : {}),
          },
        });
        if (reqTracker.unmounted || reqTracker.collection !== targetCollection) return;
        setCancelTargetId(null);
        setCancelReason('');
        setStatusNote(action === 'submit' ? 'Đã trình duyệt chứng từ.' : 'Đã hủy chứng từ.');
        await loadRecords();
      } catch (err) {
        if (!reqTracker.unmounted && reqTracker.collection === targetCollection) {
          setStatusNote(err?.response?.data?.errors?.[0]?.message || 'Không thực hiện được chuyển trạng thái.');
        }
      } finally {
        if (!reqTracker.unmounted) setBusyId(null);
      }
    };

    const openApprovalInbox = () => {
      const targetPath = '/admin/lattice-workspace';
      if (!isSafeAppPath(targetPath)) return;
      if (app?.router?.navigate) app.router.navigate(targetPath);
      else if (typeof window !== 'undefined' && window.location) window.location.assign(app?.getRouteUrl?.(targetPath) || targetPath);
    };

    const handleRecordClick = (rec) => {
      if (!rec) return;
      if (typeof cfg.onRecordClick === 'function') {
        cfg.onRecordClick(rec, activeCollection);
      }
      setSelectedRecord(rec);
    };

    const moveRecordToStage = async (rec, nextStage) => {
      if (!api?.request || !rec?.id || !nextStage || busyId != null) return;
      const currentStage = resolveRecordStage(rec, activeCollection, {
        statusField: effectiveStatusField,
        stages: kanbanData.stages,
      });
      if (nextStage === currentStage) return;

      if (VOUCHER_COLLECTIONS.has(activeCollection)) {
        if (currentStage === 'draft' && nextStage === 'submitted') {
          await runVoucherStageAction(rec, 'submit');
          return;
        }
        if (nextStage === 'cancelled' && CANCELLABLE_STAGES.has(currentStage)) {
          setGatedDropCta(false);
          setCancelTargetId(rec.id);
          setCancelReason('');
          setStatusNote('Vui lòng nhập lý do hủy chứng từ.');
          return;
        }
        setGatedDropCta(true);
        setStatusNote('Chứng từ chuẩn chuyển trạng thái qua quy trình Trình duyệt / Phê duyệt / Hủy.');
        return;
      }

      const targetCollection = activeCollection;
      setGatedDropCta(false);
      setBusyId(rec.id);
      try {
        setStatusNote(`Đang cập nhật ${rec.code || rec.lotCode || `#${rec.id}`} → ${formatStatusLabel(nextStage)}…`);
        await api.request({
          url: `${targetCollection}:update`,
          method: 'post',
          params: { filterByTk: rec.id },
          data: { [effectiveStatusField]: nextStage },
          skipNotify: true,
        });
        if (reqTracker.unmounted || reqTracker.collection !== targetCollection) return;
        setStatusNote(`Đã chuyển sang giai đoạn ${formatStatusLabel(nextStage)}.`);
        await loadRecords();
      } catch (err) {
        if (!reqTracker.unmounted && reqTracker.collection === targetCollection) {
          setStatusNote(err?.response?.data?.errors?.[0]?.message || err?.message || 'Không thực hiện được chuyển trạng thái.');
        }
      } finally {
        if (!reqTracker.unmounted) setBusyId(null);
      }
    };

    const collectionOptions = React.useMemo(() => {
      const defaults = [
        { value: 'latticeOrders', label: 'Đơn Logistics (latticeOrders)' },
        { value: 'latticeRequests', label: 'Yêu cầu mua sắm (latticeRequests)' },
        { value: 'latticeServiceTickets', label: 'Phiếu dịch vụ (latticeServiceTickets)' },
        { value: 'latticeStockLots', label: 'Lô kho lạnh (latticeStockLots)' },
      ];
      const map = new Map(defaults.map((d) => [d.value, d]));
      for (const col of collectionsMeta) {
        if (!col?.name) continue;
        if (!map.has(col.name)) {
          map.set(col.name, {
            value: col.name,
            label: col.title && col.title !== col.name ? `${col.title} (${col.name})` : col.name,
          });
        }
      }
      if (activeCollection && !map.has(activeCollection)) {
        map.set(activeCollection, { value: activeCollection, label: activeCollection });
      }
      return [...map.values()];
    }, [collectionsMeta, activeCollection]);

    const modeBtnStyle = (active) => ({
      padding: '4px 10px',
      borderRadius: 6,
      border: `1px solid ${active ? '#2563eb' : '#cbd5e1'}`,
      background: active ? '#2563eb' : '#ffffff',
      color: active ? '#ffffff' : '#334155',
      fontSize: 12,
      fontWeight: 700,
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    });

    const isVoucherCol = VOUCHER_COLLECTIONS.has(activeCollection);
    const columnStyleMap = new Map(kanbanData.columns.map((c) => [c.stage, c]));

    return h('section', {
      'data-testid': 'dxos-kanban-schedule-block',
      style: {
        padding: 16,
        paddingBottom: 56,
        borderRadius: 12,
        border: '1px solid #cbd5e1',
        background: '#ffffff',
        color: '#0f172a',
        display: 'grid',
        gap: 12,
        minWidth: 0,
      },
    },
      h('div', { style: { display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 8 } },
        h('div', null,
          h('strong', { style: { fontSize: 15, color: '#0f172a' } }, stripDevBracketTags(cfg.title || 'Bảng Kanban & Lịch')),
          h('div', { style: { fontSize: 11, color: '#64748b' } }, `${activeCollection} · ${filteredRecords.length} bản ghi`),
        ),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' } },
          h('button', {
            type: 'button',
            'data-testid': 'dxos-view-mode-kanban',
            onClick: () => setViewMode('kanban'),
            style: modeBtnStyle(viewMode === 'kanban'),
          }, 'Kanban'),
          h('button', {
            type: 'button',
            'data-testid': 'dxos-view-mode-schedule',
            onClick: () => setViewMode('schedule'),
            style: modeBtnStyle(viewMode === 'schedule'),
          }, 'Lịch (Schedule)'),
          h('button', {
            type: 'button',
            onClick: () => loadRecords(),
            disabled: loading,
            style: { padding: '4px 10px', borderRadius: 6, border: '1px solid #cbd5e1', background: '#f8fafc', fontSize: 12, fontWeight: 600, cursor: 'pointer' },
          }, loading ? 'Đang tải…' : 'Làm mới'),
        ),
      ),
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' } },
        h('select', {
          'aria-label': 'Chọn phân hệ Kanban',
          value: activeCollection,
          onChange: (e) => {
            const nextCollection = normalizeKanbanCollection(e.target.value);
            if (nextCollection !== activeCollection) {
              setRecords([]);
              setStatusNote('');
              setCancelReason('');
              setSelectedRecord(null);
              setGatedDropCta(false);
            }
            setActiveCollection(nextCollection);
            setCancelTargetId(null);
          },
          style: { padding: '5px 8px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 12, background: '#fff' },
        }, collectionOptions.map((opt) => h('option', { key: opt.value, value: opt.value }, opt.label))),
        h('input', {
          type: 'search',
          'data-testid': 'dxos-kanban-search-input',
          value: searchQuery,
          onChange: (e) => setSearchQuery(e.target.value),
          placeholder: 'Lọc theo mã, tên, SKU, khách hàng…',
          style: { flex: '1 1 200px', minWidth: 0, maxWidth: '100%', padding: '5px 10px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 12 },
        }),
      ),
      statusNote ? h('div', {
        'data-testid': 'dxos-kanban-status-note',
        style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, fontSize: 11, color: '#1d4ed8', background: '#eff6ff', padding: '6px 10px', borderRadius: 6, border: '1px solid #bfdbfe' },
      },
        h('span', null, statusNote),
        gatedDropCta ? h('button', {
          type: 'button',
          'data-testid': 'dxos-kanban-approval-cta',
          onClick: openApprovalInbox,
          style: { padding: '3px 10px', borderRadius: 6, border: '1px solid #1d4ed8', background: '#1d4ed8', color: '#ffffff', fontSize: 11, fontWeight: 700, cursor: 'pointer' },
        }, 'Mở Hộp Phê duyệt') : null,
      ) : null,
      viewMode === 'kanban'
        ? h('div', {
            style: {
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
              gap: 10,
              alignItems: 'start',
            },
          },
            kanbanData.columns.map((col) => h('div', {
              key: col.stage,
              'data-testid': 'dxos-kanban-column',
              'data-stage': col.stage,
              onDragOver: (e) => {
                if (e && typeof e.preventDefault === 'function') e.preventDefault();
                if (dragOverStage !== col.stage) setDragOverStage(col.stage);
              },
              onDragLeave: () => {
                if (dragOverStage === col.stage) setDragOverStage(null);
              },
              onDrop: (e) => {
                if (e && typeof e.preventDefault === 'function') e.preventDefault();
                const dtId = e?.dataTransfer?.getData?.('text/plain');
                const rawId = dtId !== undefined && dtId !== '' ? dtId : draggedRecordId;
                setDragOverStage(null);
                setDraggedRecordId(null);
                if (rawId == null || String(rawId).trim() === '') return undefined;
                const targetRec = records.find((r) => String(r?.id) === String(rawId));
                if (targetRec) {
                  return moveRecordToStage(targetRec, col.stage);
                }
                return undefined;
              },
              style: {
                borderRadius: 10,
                border: dragOverStage === col.stage ? '2px dashed #2563eb' : `1px solid ${col.border}`,
                background: dragOverStage === col.stage ? '#eff6ff' : '#f8fafc',
                padding: 8,
                display: 'grid',
                gap: 8,
                minWidth: 0,
              },
            },
              h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 4 } },
                h('span', { style: { fontSize: 11, fontWeight: 800, color: col.color, background: col.bg, padding: '2px 8px', borderRadius: 999 } }, col.label),
                h('strong', { style: { fontSize: 11, color: '#64748b' } }, String(col.items.length)),
              ),
              !col.items.length
                ? h('div', { style: { fontSize: 11, color: '#94a3b8', padding: '4px 2px' } }, 'Trống')
                : col.items.map((rec, idx) => {
                    const sla = resolveSlaBadge(rec, effectiveStatusField);
                    const dateChip = formatDateChip(rec, effectiveDateFields, effectiveDateField);
                    const code = rec.code || rec.lotCode || `#${rec.id ?? idx}`;
                    const name = resolveRecordDisplayTitle(rec, effectiveTitleField);
                    const st = resolveRecordStage(rec, activeCollection, {
                      statusField: effectiveStatusField,
                      stages: kanbanData.stages,
                    });
                    const canDrag = Boolean(rec?.id) && kanbanData.stages.length > 1;
                    return h('div', {
                      key: rec.id ?? code,
                      'data-testid': `dxos-kanban-card-${rec.id ?? idx}`,
                      draggable: canDrag,
                      onClick: () => handleRecordClick(rec),
                      onDragStart: (e) => {
                        setDraggedRecordId(rec.id);
                        if (e?.dataTransfer && typeof e.dataTransfer.setData === 'function') {
                          e.dataTransfer.setData('text/plain', String(rec.id ?? ''));
                        }
                      },
                      onDragEnd: () => {
                        setDraggedRecordId(null);
                        setDragOverStage(null);
                      },
                      style: {
                        padding: 8,
                        borderRadius: 8,
                        background: '#ffffff',
                        border: selectedRecord?.id === rec.id ? '1.5px solid #2563eb' : (sla ? `1px solid ${sla.border}` : '1px solid #e2e8f0'),
                        display: 'grid',
                        gap: 4,
                        cursor: 'pointer',
                      },
                    },
                      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 4 } },
                        h('strong', { style: { fontSize: 12, color: '#0f172a' } }, String(code)),
                        sla ? h('span', { style: { fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 999, background: sla.bg, color: sla.color } }, sla.label) : null,
                      ),
                      h('div', { style: { fontSize: 12, color: '#334155', wordBreak: 'break-word' } }, String(name)),
                      dateChip ? h('div', { style: { fontSize: 10, color: '#64748b' } }, `Ngày: ${dateChip}`) : null,
                      !isVoucherCol && rec.id != null && kanbanData.stages.length > 1 ? h('select', {
                        'aria-label': `Chuyển trạng thái ${code}`,
                        'data-testid': `dxos-kanban-move-${rec.id}`,
                        value: st,
                        disabled: busyId === rec.id,
                        onClick: (e) => e?.stopPropagation?.(),
                        onChange: (e) => {
                          e?.stopPropagation?.();
                          const nextStage = String(e?.target?.value || '').trim();
                          if (nextStage && nextStage !== st) {
                            return moveRecordToStage(rec, nextStage);
                          }
                          return undefined;
                        },
                        style: {
                          marginTop: 2,
                          padding: '3px 6px',
                          borderRadius: 4,
                          border: '1px solid #cbd5e1',
                          fontSize: 11,
                          background: '#ffffff',
                        },
                      }, kanbanData.columns.map((optCol) => h('option', { key: optCol.stage, value: optCol.stage }, optCol.label))) : null,
                      isVoucherCol && st === 'draft' ? h('button', {
                        type: 'button',
                        'data-testid': `dxos-kanban-submit-${rec.id}`,
                        disabled: busyId === rec.id,
                        onClick: (e) => { e?.stopPropagation?.(); return runVoucherStageAction(rec, 'submit'); },
                        style: {
                          marginTop: 2, padding: '3px 8px', borderRadius: 6, border: 'none',
                          background: '#2563eb', color: '#ffffff', fontSize: 11, fontWeight: 700, cursor: 'pointer',
                        },
                      }, 'Trình duyệt') : null,
                      isVoucherCol && CANCELLABLE_STAGES.has(st) && (!rec?.[effectiveStatusField] || CANCELLABLE_STAGES.has(String(rec[effectiveStatusField]).trim().toLowerCase())) ? (
                        cancelTargetId === rec.id
                          ? h('div', { onClick: (e) => e?.stopPropagation?.(), style: { display: 'grid', gap: 4, marginTop: 2 } },
                              h('input', {
                                type: 'text',
                                value: cancelReason,
                                onChange: (e) => setCancelReason(e.target.value),
                                placeholder: 'Lý do hủy (3-255 ký tự)…',
                                style: { padding: '3px 6px', borderRadius: 4, border: '1px solid #cbd5e1', fontSize: 11 },
                              }),
                              h('div', { style: { display: 'flex', gap: 4 } },
                                h('button', {
                                  type: 'button',
                                  disabled: busyId === rec.id,
                                  onClick: (e) => { e?.stopPropagation?.(); return runVoucherStageAction(rec, 'cancel'); },
                                  style: { padding: '2px 8px', borderRadius: 4, border: 'none', background: '#dc2626', color: '#fff', fontSize: 11, fontWeight: 700, cursor: 'pointer' },
                                }, 'Xác nhận hủy'),
                                h('button', {
                                  type: 'button',
                                  onClick: (e) => { e?.stopPropagation?.(); setCancelTargetId(null); setCancelReason(''); },
                                  style: { padding: '2px 8px', borderRadius: 4, border: '1px solid #cbd5e1', background: '#fff', fontSize: 11, cursor: 'pointer' },
                                }, 'Đóng'),
                              ),
                            )
                          : h('button', {
                              type: 'button',
                              'data-testid': `dxos-kanban-cancel-${rec.id}`,
                              onClick: (e) => { e?.stopPropagation?.(); setCancelTargetId(rec.id); setCancelReason(''); },
                              style: {
                                marginTop: 2, padding: '3px 8px', borderRadius: 6, border: '1px solid #fca5a5',
                                background: '#fff', color: '#dc2626', fontSize: 11, fontWeight: 700, cursor: 'pointer',
                              },
                            }, 'Hủy chứng từ')
                      ) : null,
                    );
                  }),
            )),
          )
        : h('div', {
            'data-testid': 'dxos-schedule-grid',
            style: { display: 'grid', gap: 10 },
          },
            h('div', { style: { display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 8 } },
              h('span', { style: { fontSize: 12, fontWeight: 700, color: '#334155' } }, `Tuần: ${scheduleGrid.weekStart} → ${scheduleGrid.weekEnd}`),
              h('div', { style: { display: 'flex', gap: 6 } },
                h('button', { type: 'button', 'data-testid': 'dxos-schedule-prev-week', onClick: () => setWeekOffset((w) => w - 1), style: { padding: '3px 10px', borderRadius: 6, border: '1px solid #cbd5e1', background: '#fff', fontSize: 11, fontWeight: 600, cursor: 'pointer' } }, '← Tuần trước'),
                h('button', { type: 'button', onClick: () => setWeekOffset(0), style: { padding: '3px 10px', borderRadius: 6, border: '1px solid #cbd5e1', background: '#f8fafc', fontSize: 11, fontWeight: 600, cursor: 'pointer' } }, 'Tuần này'),
                h('button', { type: 'button', 'data-testid': 'dxos-schedule-next-week', onClick: () => setWeekOffset((w) => w + 1), style: { padding: '3px 10px', borderRadius: 6, border: '1px solid #cbd5e1', background: '#fff', fontSize: 11, fontWeight: 600, cursor: 'pointer' } }, 'Tuần sau →'),
              ),
            ),
            h('div', {
              style: {
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(135px, 1fr))',
                gap: 8,
              },
            },
              scheduleGrid.days.map((day) => h('div', {
                key: day.dateKey,
                style: {
                  borderRadius: 8,
                  border: day.isToday ? '1.5px solid #2563eb' : '1px solid #cbd5e1',
                  background: day.isToday ? '#eff6ff' : '#f8fafc',
                  padding: 8,
                  display: 'grid',
                  gap: 6,
                  alignContent: 'start',
                  minHeight: 110,
                },
              },
                h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 11, fontWeight: 800, color: day.isToday ? '#1d4ed8' : '#0f172a' } },
                  h('span', null, day.label),
                  h('span', { style: { color: '#64748b' } }, String(day.items.length)),
                ),
                !day.items.length
                  ? h('div', { style: { fontSize: 11, color: '#94a3b8' } }, '—')
                  : day.items.map((rec, idx) => {
                      const sla = resolveSlaBadge(rec, effectiveStatusField);
                      const st = resolveRecordStage(rec, activeCollection, {
                        statusField: effectiveStatusField,
                        stages: kanbanData.stages,
                      });
                      const meta = columnStyleMap.get(st) || STAGE_META[st] || { bg: '#f1f5f9', color: '#334155' };
                      return h('div', {
                        key: rec.id ?? idx,
                        'data-testid': `dxos-schedule-day-item-${rec.id ?? idx}`,
                        onClick: () => handleRecordClick(rec),
                        style: { padding: 6, borderRadius: 6, background: '#ffffff', border: selectedRecord?.id === rec.id ? '1.5px solid #2563eb' : '1px solid #e2e8f0', fontSize: 11, display: 'grid', gap: 2, cursor: 'pointer' },
                      },
                        h('strong', null, String(rec.code || rec.lotCode || `#${rec.id}`)),
                        h('div', { style: { color: '#475569' } }, resolveRecordDisplayTitle(rec, effectiveTitleField)),
                        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4 } },
                          h('span', { style: { fontSize: 10, padding: '1px 5px', borderRadius: 999, background: meta.bg, color: meta.color, fontWeight: 700 } }, meta.label || formatStatusLabel(st)),
                          sla ? h('span', { style: { fontSize: 10, padding: '1px 5px', borderRadius: 999, background: sla.bg, color: sla.color, fontWeight: 700 } }, sla.label) : null,
                        ),
                      );
                    }),
              )),
            ),
            scheduleGrid.unscheduled.length > 0
              ? h('div', {
                  'data-testid': 'dxos-schedule-unscheduled',
                  style: {
                    borderRadius: 8,
                    border: '1px dashed #cbd5e1',
                    background: '#f8fafc',
                    padding: 10,
                    display: 'grid',
                    gap: 8,
                  },
                },
                  h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 800, color: '#334155' } },
                    h('span', null, 'Chưa xếp lịch (Chưa có ngày)'),
                    h('span', { style: { fontSize: 11, color: '#64748b' } }, `${scheduleGrid.unscheduled.length} bản ghi`),
                  ),
                  h('div', {
                    style: {
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
                      gap: 8,
                    },
                  },
                    scheduleGrid.unscheduled.map((rec, idx) => {
                      const sla = resolveSlaBadge(rec, effectiveStatusField);
                      const st = resolveRecordStage(rec, activeCollection, {
                        statusField: effectiveStatusField,
                        stages: kanbanData.stages,
                      });
                      const meta = columnStyleMap.get(st) || STAGE_META[st] || { bg: '#f1f5f9', color: '#334155' };
                      return h('div', {
                        key: rec.id ?? idx,
                        'data-testid': `dxos-schedule-unscheduled-item-${rec.id ?? idx}`,
                        onClick: () => handleRecordClick(rec),
                        style: {
                          padding: 8,
                          borderRadius: 6,
                          background: '#ffffff',
                          border: selectedRecord?.id === rec.id ? '1.5px solid #2563eb' : (sla ? `1px solid ${sla.border}` : '1px solid #e2e8f0'),
                          fontSize: 11,
                          display: 'grid',
                          gap: 3,
                          cursor: 'pointer',
                        },
                      },
                        h('strong', { style: { color: '#0f172a' } }, String(rec.code || rec.lotCode || `#${rec.id ?? idx}`)),
                        h('div', { style: { color: '#475569', wordBreak: 'break-word' } }, resolveRecordDisplayTitle(rec, effectiveTitleField)),
                        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4 } },
                          h('span', { style: { fontSize: 10, padding: '1px 5px', borderRadius: 999, background: meta.bg, color: meta.color, fontWeight: 700 } }, meta.label || formatStatusLabel(st)),
                          sla ? h('span', { style: { fontSize: 10, padding: '1px 5px', borderRadius: 999, background: sla.bg, color: sla.color, fontWeight: 700 } }, sla.label) : null,
                        ),
                      );
                    }),
                  ),
                )
              : null,
          ),
      selectedRecord ? (() => {
        const selCode = selectedRecord.code || selectedRecord.lotCode || `#${selectedRecord.id ?? ''}`;
        const selName = resolveRecordDisplayTitle(selectedRecord, effectiveTitleField);
        const selStage = resolveRecordStage(selectedRecord, activeCollection, {
          statusField: effectiveStatusField,
          stages: kanbanData.stages,
        });
        const selRawStatus = String(selectedRecord?.[effectiveStatusField] ?? '').trim();
        const selRawKey = selRawStatus.toLowerCase();
        const selMeta = (selRawKey && STAGE_META[selRawKey])
          || columnStyleMap.get(selStage)
          || STAGE_META[selStage]
          || getStatusMeta(selRawStatus || selStage);
        const selStatusLabel = selMeta.label || formatStatusLabel(selRawStatus || selStage);
        const selDate = formatDateChip(selectedRecord, effectiveDateFields, effectiveDateField);
        return h('div', {
          'data-testid': 'dxos-kanban-detail-drawer',
          role: 'region',
          'aria-label': `Chi tiết ${selCode}`,
          style: {
            marginTop: 4,
            padding: 12,
            borderRadius: 10,
            border: '1px solid #93c5fd',
            background: '#f8fafc',
            display: 'grid',
            gap: 8,
          },
        },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
            h('strong', {
              style: {
                flex: '1 1 200px',
                minWidth: 0,
                fontSize: 13,
                color: '#0f172a',
                wordBreak: 'break-word',
              },
            }, `${selCode} — ${selName}`),
            h('div', {
              'data-testid': 'dxos-kanban-detail-actions',
              style: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, marginLeft: 'auto' },
            },
              h('span', {
                'data-testid': 'dxos-kanban-detail-status-badge',
                style: {
                  fontSize: 11,
                  fontWeight: 700,
                  padding: '2px 8px',
                  borderRadius: 999,
                  background: selMeta.bg,
                  color: selMeta.color,
                  whiteSpace: 'nowrap',
                },
              }, selStatusLabel),
              h('button', {
                type: 'button',
                'data-testid': 'dxos-kanban-detail-close',
                onClick: () => setSelectedRecord(null),
                style: { border: '1px solid #cbd5e1', background: '#ffffff', color: '#334155', borderRadius: 6, padding: '2px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' },
              }, 'Đóng'),
            ),
          ),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: 12, color: '#475569' } },
            h('span', null, `Phân hệ: ${activeCollection}`),
            selDate ? h('span', null, `Ngày (Asia/Ho_Chi_Minh): ${selDate}`) : null,
            selectedRecord.customer ? h('span', null, `Khách hàng: ${selectedRecord.customer}`) : null,
            selectedRecord.sku ? h('span', null, `SKU: ${selectedRecord.sku}`) : null,
            selectedRecord.qtyAvailable != null ? h('span', null, `Khả dụng: ${selectedRecord.qtyAvailable}`) : null,
            selectedRecord.quantity != null ? h('span', null, `Số lượng: ${selectedRecord.quantity}`) : null,
          ),
          isVoucherCol && selStage === 'submitted' ? h('div', { style: { display: 'flex', gap: 8 } },
            h('button', {
              type: 'button',
              onClick: openApprovalInbox,
              style: { padding: '4px 10px', borderRadius: 6, border: '1px solid #1d4ed8', background: '#1d4ed8', color: '#ffffff', fontSize: 11, fontWeight: 700, cursor: 'pointer' },
            }, 'Mở Hộp Phê duyệt'),
          ) : null,
        );
      })() : null,
    );
  };
}

module.exports = {
  KANBAN_STAGE_ORDER,
  STOCK_LOT_STAGE_ORDER,
  normalizeKanbanCollection,
  inferKanbanStages,
  groupRecordsByKanbanStage,
  buildScheduleDaysGrid,
  createKanbanScheduleBlockView,
};
