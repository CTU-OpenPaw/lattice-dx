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
  fetchCollectionsMeta,
  subscribeCollectionsMeta,
  formatBiFieldLabel,
  extractBiFieldOptions,
  stripDevBracketTags,
  formatStatusLabel,
} = require('./blocks-helpers');

const BI_CHART_TYPES = ['bar', 'line', 'pie', 'kpi', 'pivot'];
const BI_METRIC_OPS = ['count', 'sum', 'avg', 'min', 'max'];
const BI_PALETTE = ['#2563eb', '#10b981', '#f59e0b', '#ef4444', '#6366f1', '#06b6d4', '#ec4899', '#84cc16'];
const BI_DEFAULT_COLLECTION = 'latticeOrders';
const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const DANGEROUS_FILTER_KEYS = new Set(['$where', '$raw', '$sql', '$eval', '$function', '$expr']);
const SAFE_FIELD_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,62}$/;

const BI_COLLECTION_FALLBACKS = [
  { value: 'latticeOrders', label: 'Đơn Logistics' },
  { value: 'latticeOrderLines', label: 'Dòng đơn hàng' },
  { value: 'latticeRequests', label: 'Yêu cầu mua sắm' },
  { value: 'latticeServiceTickets', label: 'Phiếu dịch vụ nội bộ' },
  { value: 'latticeStockLots', label: 'Lô kho lạnh' },
  { value: 'latticeAssets', label: 'Tài sản & Thiết bị' },
  { value: 'latticeLocations', label: 'Địa điểm & Kho trạm' },
  { value: 'latticeDepartments', label: 'Phòng ban' },
  { value: 'latticeIncidentCases', label: 'Sự cố IoT' },
  { value: 'latticeParaDocuments', label: 'Tài liệu P.A.R.A.' },
  { value: 'latticeAgentProposals', label: 'Đề xuất AI' },
  { value: 'latticeEpodRecords', label: 'Chứng từ ePOD' },
];

const CHART_TYPE_LABELS = {
  bar: 'Cột (Bar)',
  line: 'Đường (Line)',
  pie: 'Tròn (Pie)',
  kpi: 'Chỉ số (KPI)',
  pivot: 'Bảng chéo (Pivot)',
};

const METRIC_OP_LABELS = {
  count: 'Đếm (COUNT)',
  sum: 'Tổng (SUM)',
  avg: 'Trung bình (AVG)',
  min: 'Nhỏ nhất (MIN)',
  max: 'Lớn nhất (MAX)',
};

function normalizeBiCollection(raw) {
  const s = String(raw || '').trim();
  if (!s || BLOCKED_KEYS.has(s) || !SAFE_COLLECTION_RE.test(s)) return BI_DEFAULT_COLLECTION;
  return s;
}

function normalizeBiField(raw) {
  const s = String(raw || '').trim();
  if (!s || BLOCKED_KEYS.has(s) || !SAFE_FIELD_RE.test(s)) return '';
  return s;
}

const INVALID_FILTER_NODE = Symbol('invalid_filter_node');

function sanitizeClientFilterNode(node, depth = 0) {
  if (depth > 10) return INVALID_FILTER_NODE;
  if (node == null) return node;
  if (Array.isArray(node)) {
    const arr = [];
    for (const item of node) {
      const cleaned = sanitizeClientFilterNode(item, depth + 1);
      if (cleaned === INVALID_FILTER_NODE) return INVALID_FILTER_NODE;
      if (cleaned !== undefined) arr.push(cleaned);
    }
    return arr;
  }
  if (typeof node !== 'object') return node;
  const out = {};
  for (const k of Object.getOwnPropertyNames(node)) {
    if (BLOCKED_KEYS.has(k)) return INVALID_FILTER_NODE;
    if (DANGEROUS_FILTER_KEYS.has(k.toLowerCase())) return INVALID_FILTER_NODE;
    if (!k.startsWith('$') && k.includes('.')) return INVALID_FILTER_NODE;
    if (node[k] === undefined) continue;
    const cleaned = sanitizeClientFilterNode(node[k], depth + 1);
    if (cleaned === INVALID_FILTER_NODE) return INVALID_FILTER_NODE;
    if (cleaned !== undefined) {
      Object.defineProperty(out, k, { value: cleaned, enumerable: true, configurable: true, writable: true });
    }
  }
  return out;
}

function hasOwnProps(obj) {
  return Boolean(
    obj
    && typeof obj === 'object'
    && !Array.isArray(obj)
    && Object.getOwnPropertyNames(obj).length > 0,
  );
}

function parseBiFilterJson(rawFilterJson, rawFilterObj) {
  let candidate = null;
  if (hasOwnProps(rawFilterObj)) {
    candidate = rawFilterObj;
  } else if (typeof rawFilterJson === 'string' && rawFilterJson.trim()) {
    try {
      const parsed = JSON.parse(rawFilterJson.trim());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        candidate = parsed;
      }
    } catch {
      return undefined;
    }
  } else if (hasOwnProps(rawFilterJson)) {
    candidate = rawFilterJson;
  }
  if (!candidate) return undefined;
  const cleaned = sanitizeClientFilterNode(candidate, 0);
  if (cleaned === INVALID_FILTER_NODE || !cleaned || typeof cleaned !== 'object' || !Object.keys(cleaned).length) {
    return undefined;
  }
  return cleaned;
}

function buildAggregateQueryPayload(cfg = {}) {
  const collection = normalizeBiCollection(cfg.collection);
  const rawType = String(cfg.chartType || 'bar').trim().toLowerCase();
  const chartType = BI_CHART_TYPES.includes(rawType) ? rawType : 'bar';
  const groupBy = normalizeBiField(cfg.groupBy);
  const secondaryGroupBy = chartType === 'pivot' ? normalizeBiField(cfg.secondaryGroupBy) : '';

  const rawOp = String(cfg.metric?.op ?? cfg.metricOp ?? 'count').trim().toLowerCase();
  const op = BI_METRIC_OPS.includes(rawOp) ? rawOp : 'count';
  const metricField = op !== 'count' ? normalizeBiField(cfg.metric?.field ?? cfg.metricField) : '';

  const parsedLimit = Number(cfg.limit ?? cfg.maxGroups);
  const limit = Number.isFinite(parsedLimit) && parsedLimit >= 1
    ? Math.min(500, Math.max(1, Math.floor(parsedLimit)))
    : 20;

  const filter = parseBiFilterJson(cfg.filterJson, cfg.filter);

  const payload = {
    collection,
    chartType,
    metric: metricField ? { op, field: metricField } : { op },
    limit,
  };
  if (groupBy) payload.groupBy = groupBy;
  if (chartType === 'pivot' && secondaryGroupBy) payload.secondaryGroupBy = secondaryGroupBy;
  if (filter) payload.filter = filter;
  return payload;
}

function normalizeSeriesItems(series) {
  if (!Array.isArray(series)) return [];
  return series.map((item, idx) => {
    const key = String(item?.key ?? item?.label ?? `Nhóm ${idx + 1}`);
    const label = String(item?.label ?? item?.key ?? key);
    const val = Number(item?.value ?? item?.count ?? 0);
    return {
      key,
      label,
      value: Number.isFinite(val) ? val : 0,
      count: Number(item?.count ?? 0) || 0,
      color: BI_PALETTE[idx % BI_PALETTE.length],
    };
  });
}

function computeBarGeometry(rawSeries, { width = 560, height = 240 } = {}) {
  const items = normalizeSeriesItems(rawSeries);
  const pad = { top: 20, right: 20, bottom: 44, left: 54 };
  const plotW = Math.max(80, width - pad.left - pad.right);
  const plotH = Math.max(60, height - pad.top - pad.bottom);
  const maxVal = Math.max(1, ...items.map((d) => Math.max(0, d.value)));
  const slotW = items.length ? plotW / items.length : plotW;
  const barW = Math.max(12, Math.min(48, slotW * 0.62));

  const bars = items.map((item, idx) => {
    const safeVal = Math.max(0, item.value);
    const h = (safeVal / maxVal) * plotH;
    const x = pad.left + idx * slotW + (slotW - barW) / 2;
    const y = pad.top + (plotH - h);
    return {
      ...item,
      x: Number(x.toFixed(2)),
      y: Number(y.toFixed(2)),
      width: Number(barW.toFixed(2)),
      height: Number(Math.max(2, h).toFixed(2)),
    };
  });

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => ({
    value: Number((maxVal * ratio).toFixed(2)),
    y: Number((pad.top + plotH * (1 - ratio)).toFixed(2)),
  }));

  return { width, height, pad, plotW, plotH, maxVal, bars, ticks };
}

function computeLineGeometry(rawSeries, { width = 560, height = 240 } = {}) {
  const items = normalizeSeriesItems(rawSeries);
  const pad = { top: 20, right: 24, bottom: 44, left: 54 };
  const plotW = Math.max(80, width - pad.left - pad.right);
  const plotH = Math.max(60, height - pad.top - pad.bottom);
  const vals = items.map((d) => d.value);
  const minVal = vals.length ? Math.min(0, ...vals) : 0;
  const maxRaw = vals.length ? Math.max(...vals) : 1;
  const maxVal = maxRaw <= minVal ? minVal + 1 : maxRaw;
  const span = maxVal - minVal;

  const points = items.map((item, idx) => {
    const x = items.length === 1
      ? pad.left + plotW / 2
      : pad.left + (idx / Math.max(1, items.length - 1)) * plotW;
    const y = pad.top + plotH - ((item.value - minVal) / span) * plotH;
    return {
      ...item,
      x: Number(x.toFixed(2)),
      y: Number(y.toFixed(2)),
    };
  });

  const polylinePoints = points.map((p) => `${p.x},${p.y}`).join(' ');
  const baseY = Number((pad.top + plotH).toFixed(2));
  const areaPoints = points.length >= 2
    ? `${points[0].x},${baseY} ${polylinePoints} ${points[points.length - 1].x},${baseY}`
    : '';
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => ({
    value: Number((minVal + span * ratio).toFixed(2)),
    y: Number((pad.top + plotH * (1 - ratio)).toFixed(2)),
  }));

  return { width, height, pad, plotW, plotH, minVal, maxVal, points, polylinePoints, areaPoints, ticks };
}

function computePieSlices(rawSeries, { cx = 120, cy = 120, r = 92, innerR = 48 } = {}) {
  const items = normalizeSeriesItems(rawSeries).filter((d) => d.value > 0);
  const total = items.reduce((acc, d) => acc + d.value, 0);
  if (total <= 0) {
    return { cx, cy, r, innerR, total: 0, slices: [] };
  }

  if (items.length === 1) {
    return {
      cx,
      cy,
      r,
      innerR,
      total,
      slices: [
        {
          ...items[0],
          pct: 1,
          isFullCircle: true,
          pathD: '',
        },
      ],
    };
  }

  let angle = -Math.PI / 2;
  const slices = items.map((item) => {
    const pct = item.value / total;
    const sweep = pct * Math.PI * 2;
    const startAngle = angle;
    const endAngle = angle + sweep;
    angle = endAngle;

    const x1 = cx + r * Math.cos(startAngle);
    const y1 = cy + r * Math.sin(startAngle);
    const x2 = cx + r * Math.cos(endAngle);
    const y2 = cy + r * Math.sin(endAngle);
    const ix1 = cx + innerR * Math.cos(endAngle);
    const iy1 = cy + innerR * Math.sin(endAngle);
    const ix2 = cx + innerR * Math.cos(startAngle);
    const iy2 = cy + innerR * Math.sin(startAngle);
    const largeArc = sweep > Math.PI ? 1 : 0;

    const pathD = [
      `M ${x1.toFixed(2)} ${y1.toFixed(2)}`,
      `A ${r} ${r} 0 ${largeArc} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`,
      `L ${ix1.toFixed(2)} ${iy1.toFixed(2)}`,
      `A ${innerR} ${innerR} 0 ${largeArc} 0 ${ix2.toFixed(2)} ${iy2.toFixed(2)}`,
      'Z',
    ].join(' ');

    return {
      ...item,
      pct,
      isFullCircle: false,
      pathD,
    };
  });

  return { cx, cy, r, innerR, total, slices };
}

function formatMetricNumber(val) {
  const num = Number(val);
  if (!Number.isFinite(num)) return '0';
  if (Number.isInteger(num)) return num.toLocaleString('vi-VN');
  return num.toLocaleString('vi-VN', { maximumFractionDigits: 2 });
}

const BI_VN_DT_FMT = typeof Intl !== 'undefined' && typeof Intl.DateTimeFormat === 'function'
  ? new Intl.DateTimeFormat('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  : null;

function formatBiDateTime(raw) {
  if (!raw) return '—';
  const ts = Date.parse(String(raw));
  if (!Number.isFinite(ts) || !BI_VN_DT_FMT) return String(raw);
  return BI_VN_DT_FMT.format(new Date(ts));
}

const NON_STRING_BI_TYPES = new Set([
  'integer',
  'float',
  'double',
  'decimal',
  'number',
  'bigint',
  'date',
  'datetime',
  'time',
  'boolean',
  'json',
  'jsonb',
  'uuid',
]);

function isNonStringBiField(field, fieldType) {
  const t = String(fieldType || '').trim().toLowerCase();
  if (t) return NON_STRING_BI_TYPES.has(t);
  return field === 'id' || field === 'version' || field === 'createdAt' || field === 'updatedAt' || /(?:Id|At|Date)$/.test(field);
}

function buildDrilldownFilter(baseFilter, conditions = [], fieldTypeMap = null) {
  const clauses = [];
  if (baseFilter && typeof baseFilter === 'object' && !Array.isArray(baseFilter) && Object.keys(baseFilter).length > 0) {
    clauses.push(baseFilter);
  }
  for (const cond of Array.isArray(conditions) ? conditions : []) {
    const field = normalizeBiField(cond?.field);
    if (!field || BLOCKED_KEYS.has(field)) continue;
    const rawVal = cond?.value;
    if (rawVal === '(Trống)' || rawVal === null || rawVal === undefined || rawVal === '') {
      const mappedType = fieldTypeMap instanceof Map ? fieldTypeMap.get(field) : fieldTypeMap?.[field];
      if (isNonStringBiField(field, cond?.fieldType ?? mappedType)) {
        clauses.push({ [field]: null });
      } else {
        clauses.push({ $or: [{ [field]: null }, { [field]: '' }] });
      }
    } else {
      clauses.push({ [field]: rawVal });
    }
  }
  if (!clauses.length) return undefined;
  if (clauses.length === 1) return clauses[0];
  return { $and: clauses };
}

function extractErrorMessage(err) {
  return (
    err?.response?.data?.errors?.[0]?.message
    || err?.response?.data?.message
    || err?.message
    || 'Không thể tải dữ liệu phân tích BI.'
  );
}

function readSafeObjProp(obj, key, fallback = 0) {
  if (!obj || typeof obj !== 'object') return fallback;
  return Object.hasOwn(obj, key) ? obj[key] : fallback;
}

function resolvePivotSecondaryField(groupBy, secondaryGroupBy, fieldOptions = []) {
  const cleanGroup = normalizeBiField(groupBy);
  const cleanSecondary = normalizeBiField(secondaryGroupBy);
  if (cleanSecondary && cleanSecondary !== cleanGroup) {
    return cleanSecondary;
  }
  if (Array.isArray(fieldOptions) && fieldOptions.length > 0) {
    const distinct = fieldOptions.find((opt) => {
      const val = normalizeBiField(opt?.value);
      return val && val !== cleanGroup;
    });
    if (distinct) return normalizeBiField(distinct.value);
  }
  return '';
}

function createBiChartBlockView(client, React, _antd, app, { subscribeModelConfig } = {}) {
  const h = React.createElement;
  const useApi = typeof client?.useAPIClient === 'function' ? client.useAPIClient : () => app?.apiClient || null;

  return function DxosBiChartView({ model, liveConfig } = {}) {
    const api = useApi();
    const [, setTick] = React.useState(0);
    React.useEffect(() => {
      if (typeof subscribeModelConfig === 'function' && model) {
        return subscribeModelConfig(model, () => setTick((t) => t + 1));
      }
      return undefined;
    }, [model]);

    const stepCfg = model?.getStepParams?.('dxosBlockSettings', 'config')
      || model?.stepParams?.dxosBlockSettings?.config
      || {};
    const cfg = {
      title: 'Phân tích & Biểu đồ BI',
      collection: BI_DEFAULT_COLLECTION,
      chartType: 'bar',
      groupBy: 'status',
      secondaryGroupBy: '',
      metricOp: 'count',
      metricField: '',
      limit: 20,
      filterJson: '',
      ...(model?.props || {}),
      ...stepCfg,
      ...(liveConfig || {}),
    };

    const configCollection = normalizeBiCollection(cfg.collection);
    const configChartType = BI_CHART_TYPES.includes(String(cfg.chartType || '').toLowerCase())
      ? String(cfg.chartType).toLowerCase()
      : 'bar';
    const configGroupBy = normalizeBiField(cfg.groupBy);
    const configSecondaryGroupBy = normalizeBiField(cfg.secondaryGroupBy);
    const rawConfigMetricOp = String(cfg.metric?.op ?? cfg.metricOp ?? 'count').trim().toLowerCase();
    const configMetricOp = BI_METRIC_OPS.includes(rawConfigMetricOp) ? rawConfigMetricOp : 'count';
    const configMetricField = normalizeBiField(cfg.metric?.field ?? cfg.metricField);
    const configLimit = buildAggregateQueryPayload({ limit: cfg.limit }).limit;

    const [activeCollection, setActiveCollection] = React.useState(configCollection);
    const [activeChartType, setActiveChartType] = React.useState(configChartType);
    const [activeGroupBy, setActiveGroupBy] = React.useState(configGroupBy);
    const [activeSecondaryGroupBy, setActiveSecondaryGroupBy] = React.useState(configSecondaryGroupBy);
    const [activeMetricOp, setActiveMetricOp] = React.useState(configMetricOp);
    const [activeMetricField, setActiveMetricField] = React.useState(configMetricField);
    const [activeLimit, setActiveLimit] = React.useState(configLimit);

    React.useEffect(() => { setActiveCollection(configCollection); }, [configCollection]);
    React.useEffect(() => { setActiveChartType(configChartType); }, [configChartType]);
    React.useEffect(() => { setActiveGroupBy(configGroupBy); }, [configGroupBy]);
    React.useEffect(() => { setActiveSecondaryGroupBy(configSecondaryGroupBy); }, [configSecondaryGroupBy]);
    React.useEffect(() => { setActiveMetricOp(configMetricOp); }, [configMetricOp]);
    React.useEffect(() => { setActiveMetricField(configMetricField); }, [configMetricField]);
    React.useEffect(() => { setActiveLimit(configLimit); }, [configLimit]);

    const [collectionsMeta, setCollectionsMeta] = React.useState([]);
    const [state, setState] = React.useState({ loading: false, error: '', data: null });
    const [activeHoverKey, setActiveHoverKey] = React.useState('');
    const [refreshNonce, setRefreshNonce] = React.useState(0);
    const [reqTracker] = React.useState(() => ({ seq: 0, drillSeq: 0, unmounted: false }));
    const [drilldown, setDrilldown] = React.useState({
      open: false,
      title: '',
      conditions: [],
      loading: false,
      items: [],
      error: '',
    });

    React.useEffect(() => {
      reqTracker.unmounted = false;
      const unsub = subscribeCollectionsMeta((cols) => {
        if (!reqTracker.unmounted && Array.isArray(cols)) setCollectionsMeta(cols);
      });
      if (api?.request) {
        Promise.resolve(fetchCollectionsMeta(api))
          .then((cols) => {
            if (!reqTracker.unmounted && Array.isArray(cols) && cols.length) {
              setCollectionsMeta(cols);
            }
          })
          .catch(() => {});
      }
      return () => {
        reqTracker.unmounted = true;
        unsub();
      };
    }, [api]);

    const matchedCollection = collectionsMeta.find((c) => c?.name === activeCollection)
      || (cfg.collectionMeta && typeof cfg.collectionMeta === 'object' && (!cfg.collectionMeta.name || cfg.collectionMeta.name === activeCollection) ? cfg.collectionMeta : null)
      || null;
    const allFieldOptions = extractBiFieldOptions(matchedCollection, { numericOnly: false });
    const numericFieldOptions = extractBiFieldOptions(matchedCollection, { numericOnly: true });
    const fieldTypeMap = React.useMemo(() => {
      const map = {};
      const fields = Array.isArray(matchedCollection?.fields) ? matchedCollection.fields : [];
      for (const f of fields) {
        if (f?.name && f?.type) map[f.name] = String(f.type).trim().toLowerCase();
      }
      for (const opt of allFieldOptions) {
        if (opt?.value && opt?.type && !map[opt.value]) map[opt.value] = String(opt.type).trim().toLowerCase();
      }
      return map;
    }, [matchedCollection, allFieldOptions]);

    const effectiveGroupBy = activeGroupBy || (activeChartType !== 'kpi' ? (allFieldOptions[0]?.value || '') : '');
    const effectiveSecondaryGroupBy = activeChartType === 'pivot'
      ? resolvePivotSecondaryField(effectiveGroupBy, activeSecondaryGroupBy, allFieldOptions)
      : '';
    const effectiveMetricField = activeMetricOp !== 'count'
      ? (activeMetricField || numericFieldOptions[0]?.value || '')
      : '';

    const payload = buildAggregateQueryPayload({
      ...cfg,
      collection: activeCollection,
      chartType: activeChartType,
      groupBy: effectiveGroupBy,
      secondaryGroupBy: effectiveSecondaryGroupBy,
      metricOp: activeMetricOp,
      metricField: effectiveMetricField,
      limit: activeLimit,
    });
    const rawFilterStr = typeof cfg.filterJson === 'string' ? cfg.filterJson.trim() : '';
    const hasFilterObjInput = hasOwnProps(cfg.filter)
      || (cfg.filter != null && cfg.filter !== '' && (typeof cfg.filter !== 'object' || Array.isArray(cfg.filter)));
    const hasFilterJsonObjInput = Boolean(
      cfg.filterJson
      && typeof cfg.filterJson === 'object'
      && (Array.isArray(cfg.filterJson) || Object.getOwnPropertyNames(cfg.filterJson).length > 0),
    );
    const hasFilterJsonStrInput = rawFilterStr !== '' && !/^\{\s*\}$/.test(rawFilterStr);
    const hasInvalidFilter = Boolean(
      (hasFilterObjInput && !payload.filter)
      || (!hasFilterObjInput && (hasFilterJsonStrInput || hasFilterJsonObjInput) && !payload.filter),
    );
    const needsGroupBy = activeChartType !== 'kpi' && !effectiveGroupBy;
    const needsPivotSecondaryGroupBy = activeChartType === 'pivot'
      && (!effectiveSecondaryGroupBy || effectiveSecondaryGroupBy === effectiveGroupBy);
    const needsMetricField = activeMetricOp !== 'count' && !effectiveMetricField;
    const blockQueryGuard = hasInvalidFilter || needsGroupBy || needsPivotSecondaryGroupBy || needsMetricField;
    const payloadKey = JSON.stringify(payload);

    React.useEffect(() => {
      if (blockQueryGuard) {
        reqTracker.seq += 1;
        setState({ loading: false, error: '', data: null });
        return undefined;
      }
      if (!api?.request) return undefined;
      reqTracker.seq += 1;
      const mySeq = reqTracker.seq;
      setState((prev) => ({ ...prev, loading: true, error: '' }));

      Promise.resolve(
        api.request({
          url: 'dxosBlocks:aggregateQuery',
          method: 'post',
          data: payload,
          skipNotify: true,
        }),
      )
        .then((res) => {
          if (reqTracker.unmounted || reqTracker.seq !== mySeq) return;
          const body = res?.data?.data ?? res?.data ?? {};
          setState({ loading: false, error: '', data: body });
        })
        .catch((err) => {
          if (reqTracker.unmounted || reqTracker.seq !== mySeq) return;
          setState({ loading: false, error: extractErrorMessage(err), data: null });
        });

      return undefined;
    }, [api, payloadKey, refreshNonce, blockQueryGuard]);

    const viewerCollectionOptions = React.useMemo(() => {
      const map = new Map(BI_COLLECTION_FALLBACKS.map((o) => [o.value, o]));
      for (const col of collectionsMeta) {
        const name = String(col?.name || '').trim();
        if (!name || BLOCKED_KEYS.has(name)) continue;
        map.set(name, { value: name, label: String(col.title || name).trim() || name });
      }
      if (activeCollection && !map.has(activeCollection)) {
        map.set(activeCollection, { value: activeCollection, label: activeCollection });
      }
      return [...map.values()];
    }, [collectionsMeta, activeCollection]);

    const resolveFieldLabel = React.useCallback((fname) => {
      if (!fname) return '';
      const matched = allFieldOptions.find((o) => o.value === fname);
      return matched ? matched.label : formatBiFieldLabel(fname);
    }, [allFieldOptions]);

    const groupBySelectOptions = React.useMemo(() => {
      const opts = allFieldOptions.slice();
      if (effectiveGroupBy && !opts.some((o) => o.value === effectiveGroupBy)) {
        opts.unshift({ value: effectiveGroupBy, label: formatBiFieldLabel(effectiveGroupBy) });
      }
      return opts;
    }, [allFieldOptions, effectiveGroupBy]);

    const secondarySelectOptions = React.useMemo(() => {
      const opts = allFieldOptions.filter((o) => o.value !== effectiveGroupBy);
      if (effectiveSecondaryGroupBy && effectiveSecondaryGroupBy !== effectiveGroupBy && !opts.some((o) => o.value === effectiveSecondaryGroupBy)) {
        opts.unshift({ value: effectiveSecondaryGroupBy, label: formatBiFieldLabel(effectiveSecondaryGroupBy) });
      }
      return opts;
    }, [allFieldOptions, effectiveGroupBy, effectiveSecondaryGroupBy]);

    const metricFieldSelectOptions = React.useMemo(() => {
      const opts = numericFieldOptions.slice();
      if (effectiveMetricField && !opts.some((o) => o.value === effectiveMetricField)) {
        opts.unshift({ value: effectiveMetricField, label: formatBiFieldLabel(effectiveMetricField) });
      }
      return opts;
    }, [numericFieldOptions, effectiveMetricField]);

    const handleSelectChartType = (nextType) => {
      setActiveChartType(nextType);
      if (nextType === 'pivot') {
        const resolved = resolvePivotSecondaryField(effectiveGroupBy, activeSecondaryGroupBy, allFieldOptions);
        if (resolved && resolved !== activeSecondaryGroupBy) {
          setActiveSecondaryGroupBy(resolved);
        }
      }
    };

    const handleSelectCollection = (nextCollectionRaw) => {
      const nextCollection = normalizeBiCollection(nextCollectionRaw);
      setActiveCollection(nextCollection);
      const nextMeta = collectionsMeta.find((c) => c?.name === nextCollection) || null;
      const nextAll = extractBiFieldOptions(nextMeta, { numericOnly: false });
      const nextNums = extractBiFieldOptions(nextMeta, { numericOnly: true });
      const nextGroup = nextAll.some((o) => o.value === activeGroupBy)
        ? activeGroupBy
        : (nextAll.find((o) => o.value === 'status')?.value || nextAll[0]?.value || '');
      setActiveGroupBy(nextGroup);
      if (activeChartType === 'pivot') {
        const candidateSec = nextAll.some((o) => o.value === activeSecondaryGroupBy) ? activeSecondaryGroupBy : '';
        setActiveSecondaryGroupBy(resolvePivotSecondaryField(nextGroup, candidateSec, nextAll));
      } else if (activeSecondaryGroupBy && nextAll.length && !nextAll.some((o) => o.value === activeSecondaryGroupBy)) {
        setActiveSecondaryGroupBy('');
      }
      if (activeMetricOp !== 'count') {
        if (nextNums.some((o) => o.value === activeMetricField)) {
          // keep current numeric field
        } else if (nextNums.length > 0) {
          setActiveMetricField(nextNums[0].value);
        } else {
          setActiveMetricOp('count');
          setActiveMetricField('');
        }
      }
    };

    const handleSelectGroupBy = (nextRaw) => {
      const nextField = normalizeBiField(nextRaw);
      setActiveGroupBy(nextField);
      if (activeChartType === 'pivot' && activeSecondaryGroupBy === nextField) {
        setActiveSecondaryGroupBy(resolvePivotSecondaryField(nextField, '', allFieldOptions));
      }
    };

    const handleSelectMetricOp = (nextRaw) => {
      const nextOp = BI_METRIC_OPS.includes(String(nextRaw || '').toLowerCase())
        ? String(nextRaw).toLowerCase()
        : 'count';
      setActiveMetricOp(nextOp);
      if (nextOp === 'count') {
        setActiveMetricField('');
      } else if (!activeMetricField || (numericFieldOptions.length > 0 && !numericFieldOptions.some((o) => o.value === activeMetricField))) {
        setActiveMetricField(numericFieldOptions[0]?.value || '');
      }
    };

    const fallbackColOpt = BI_COLLECTION_FALLBACKS.find((o) => o.value === payload.collection);
    const collectionTitle = matchedCollection?.title || fallbackColOpt?.label || payload.collection;
    const cleanTitle = stripDevBracketTags(cfg.title) || 'Phân tích & Biểu đồ BI';
    const data = state.data || {};
    const series = Array.isArray(data.series) ? data.series : [];
    const summary = data.summary || null;
    const pivotMatrix = data.pivotMatrix || null;
    const totalRows = Number(data.totalRows ?? summary?.count ?? 0);

    React.useEffect(() => {
      setDrilldown((prev) => (prev.open ? { open: false, title: '', conditions: [], loading: false, items: [], error: '' } : prev));
    }, [activeCollection, effectiveGroupBy, effectiveSecondaryGroupBy]);

    const openDrilldown = React.useCallback(async (conditions = [], titleLabel = '') => {
      if (!api?.request || !SAFE_COLLECTION_RE.test(activeCollection)) return undefined;
      reqTracker.drillSeq += 1;
      const mySeq = reqTracker.drillSeq;
      const filter = buildDrilldownFilter(payload.filter, conditions, fieldTypeMap);
      const label = titleLabel || conditions.map((c) => `${resolveFieldLabel(c.field)}: ${c.value ?? '(Trống)'}`).join(' · ') || collectionTitle;
      setDrilldown({ open: true, title: label, conditions, loading: true, items: [], error: '' });
      try {
        const res = await api.request({
          url: `${activeCollection}:list`,
          method: 'get',
          params: {
            pageSize: 20,
            sort: ['-id'],
            ...(filter ? { filter: JSON.stringify(filter) } : {}),
          },
          skipNotify: true,
        });
        if (reqTracker.unmounted || reqTracker.drillSeq !== mySeq) return undefined;
        const rows = res?.data?.data ?? res?.data?.items ?? [];
        setDrilldown({ open: true, title: label, conditions, loading: false, items: Array.isArray(rows) ? rows : [], error: '' });
      } catch (err) {
        if (reqTracker.unmounted || reqTracker.drillSeq !== mySeq) return undefined;
        setDrilldown({
          open: true,
          title: label,
          conditions,
          loading: false,
          items: [],
          error: extractErrorMessage(err),
        });
      }
      return undefined;
    }, [api, activeCollection, payload.filter, fieldTypeMap, collectionTitle, reqTracker, resolveFieldLabel]);

    const limitOptions = React.useMemo(() => {
      const presets = new Set([10, 20, 50, 100, 200, 500, activeLimit, configLimit]);
      return [...presets].filter((n) => Number.isFinite(n) && n >= 1 && n <= 500).sort((a, b) => a - b);
    }, [activeLimit, configLimit]);

    const isEmpty = !blockQueryGuard && !state.loading && !state.error && (
      activeChartType === 'pivot'
        ? !pivotMatrix || !Array.isArray(pivotMatrix.rows) || pivotMatrix.rows.length === 0
        : activeChartType === 'kpi'
          ? !summary
          : series.length === 0
    );

    const renderBarView = () => {
      const geo = computeBarGeometry(series);
      return h('div', { 'data-testid': 'dxos-bi-chart-bar' },
        h('svg', {
          viewBox: `0 0 ${geo.width} ${geo.height}`,
          style: { width: '100%', height: 'auto', maxHeight: 260, display: 'block', overflow: 'visible' },
          role: 'img',
          'aria-label': `${cleanTitle} Bar Chart`,
        },
          ...geo.ticks.map((t, i) => h('g', { key: `tick-${i}` },
            h('line', { x1: geo.pad.left, y1: t.y, x2: geo.width - geo.pad.right, y2: t.y, stroke: '#e2e8f0', strokeDasharray: '3 3' }),
            h('text', { x: geo.pad.left - 8, y: t.y + 4, textAnchor: 'end', fontSize: 10, fill: '#64748b' }, formatMetricNumber(t.value)),
          )),
          h('line', { x1: geo.pad.left, y1: geo.pad.top + geo.plotH, x2: geo.width - geo.pad.right, y2: geo.pad.top + geo.plotH, stroke: '#94a3b8' }),
          ...geo.bars.map((bar, idx) => h('g', { key: `${bar.key}-${idx}` },
            h('rect', {
              'data-testid': 'dxos-bi-bar-item',
              x: bar.x,
              y: bar.y,
              width: bar.width,
              height: bar.height,
              rx: 4,
              fill: bar.color,
              opacity: activeHoverKey && activeHoverKey !== bar.key ? 0.45 : 1,
              onMouseEnter: () => setActiveHoverKey(bar.key),
              onMouseLeave: () => setActiveHoverKey(''),
              onClick: () => openDrilldown([{ field: effectiveGroupBy, value: bar.key }], `${resolveFieldLabel(effectiveGroupBy)}: ${bar.label}`),
              style: { cursor: 'pointer', transition: 'opacity 120ms ease' },
            }, h('title', null, `${bar.label}: ${formatMetricNumber(bar.value)} (${bar.count} dòng)`)),
            h('text', {
              x: bar.x + bar.width / 2,
              y: geo.pad.top + geo.plotH + 16,
              textAnchor: 'middle',
              fontSize: 10,
              fill: '#334155',
            }, bar.label.length > 12 ? `${bar.label.slice(0, 11)}…` : bar.label),
          )),
        ),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 8, fontSize: 12, color: '#475569' } },
          ...geo.bars.map((b, idx) => h('button', {
            key: `leg-${idx}`,
            type: 'button',
            onClick: () => openDrilldown([{ field: effectiveGroupBy, value: b.key }], `${resolveFieldLabel(effectiveGroupBy)}: ${b.label}`),
            style: {
              display: 'inline-flex', alignItems: 'center', gap: 5,
              border: '1px solid #e2e8f0', background: '#f8fafc', borderRadius: 999, padding: '2px 8px',
              fontSize: 12, color: '#334155', cursor: 'pointer',
            },
          },
            h('span', { style: { width: 8, height: 8, borderRadius: 999, background: b.color, display: 'inline-block' } }),
            `${b.label}: ${formatMetricNumber(b.value)}`,
          )),
        ),
      );
    };

    const renderLineView = () => {
      const geo = computeLineGeometry(series);
      return h('div', { 'data-testid': 'dxos-bi-chart-line' },
        h('svg', {
          viewBox: `0 0 ${geo.width} ${geo.height}`,
          style: { width: '100%', height: 'auto', maxHeight: 260, display: 'block', overflow: 'visible' },
          role: 'img',
          'aria-label': `${cleanTitle} Line Chart`,
        },
          ...geo.ticks.map((t, i) => h('g', { key: `ltick-${i}` },
            h('line', { x1: geo.pad.left, y1: t.y, x2: geo.width - geo.pad.right, y2: t.y, stroke: '#e2e8f0', strokeDasharray: '3 3' }),
            h('text', { x: geo.pad.left - 8, y: t.y + 4, textAnchor: 'end', fontSize: 10, fill: '#64748b' }, formatMetricNumber(t.value)),
          )),
          geo.areaPoints ? h('polygon', { points: geo.areaPoints, fill: 'rgba(37, 99, 235, 0.12)' }) : null,
          geo.points.length >= 2 ? h('polyline', {
            fill: 'none',
            stroke: '#2563eb',
            strokeWidth: 2.5,
            strokeLinejoin: 'round',
            strokeLinecap: 'round',
            points: geo.polylinePoints,
          }) : null,
          ...geo.points.map((pt, idx) => h('g', { key: `pt-${idx}` },
            h('circle', {
              'data-testid': 'dxos-bi-line-point',
              cx: pt.x,
              cy: pt.y,
              r: activeHoverKey === pt.key ? 6 : 4.5,
              fill: '#2563eb',
              stroke: '#ffffff',
              strokeWidth: 1.5,
              onMouseEnter: () => setActiveHoverKey(pt.key),
              onMouseLeave: () => setActiveHoverKey(''),
              onClick: () => openDrilldown([{ field: effectiveGroupBy, value: pt.key }], `${resolveFieldLabel(effectiveGroupBy)}: ${pt.label}`),
              style: { cursor: 'pointer' },
            }, h('title', null, `${pt.label}: ${formatMetricNumber(pt.value)}`)),
            h('text', {
              x: pt.x,
              y: geo.pad.top + geo.plotH + 16,
              textAnchor: 'middle',
              fontSize: 10,
              fill: '#334155',
            }, pt.label.length > 12 ? `${pt.label.slice(0, 11)}…` : pt.label),
          )),
        ),
      );
    };

    const renderPieView = () => {
      const geo = computePieSlices(series);
      return h('div', {
        'data-testid': 'dxos-bi-chart-pie',
        style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 20 },
      },
        h('svg', {
          viewBox: '0 0 240 240',
          style: { width: 210, height: 210, flexShrink: 0 },
          role: 'img',
          'aria-label': `${cleanTitle} Pie Chart`,
        },
          ...geo.slices.map((s, idx) => (s.isFullCircle
            ? h('circle', {
                key: `slice-${idx}`,
                'data-testid': 'dxos-bi-pie-slice',
                cx: geo.cx,
                cy: geo.cy,
                r: (geo.r + geo.innerR) / 2,
                fill: 'none',
                stroke: s.color,
                strokeWidth: geo.r - geo.innerR,
                onClick: () => openDrilldown([{ field: effectiveGroupBy, value: s.key }], `${resolveFieldLabel(effectiveGroupBy)}: ${s.label}`),
                style: { cursor: 'pointer' },
              }, h('title', null, `${s.label}: ${formatMetricNumber(s.value)} (100%)`))
            : h('path', {
                key: `slice-${idx}`,
                'data-testid': 'dxos-bi-pie-slice',
                d: s.pathD,
                fill: s.color,
                stroke: '#ffffff',
                strokeWidth: 1.5,
                onClick: () => openDrilldown([{ field: effectiveGroupBy, value: s.key }], `${resolveFieldLabel(effectiveGroupBy)}: ${s.label}`),
                style: { cursor: 'pointer' },
              }, h('title', null, `${s.label}: ${formatMetricNumber(s.value)} (${(s.pct * 100).toFixed(1)}%)`)))),
          h('text', { x: geo.cx, y: geo.cy - 4, textAnchor: 'middle', fontSize: 11, fill: '#64748b' }, 'Tổng'),
          h('text', { x: geo.cx, y: geo.cy + 14, textAnchor: 'middle', fontSize: 15, fontWeight: 700, fill: '#0f172a' }, formatMetricNumber(geo.total)),
        ),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 180 } },
          ...geo.slices.map((s, idx) => h('button', {
            key: `pie-leg-${idx}`,
            type: 'button',
            onClick: () => openDrilldown([{ field: effectiveGroupBy, value: s.key }], `${resolveFieldLabel(effectiveGroupBy)}: ${s.label}`),
            style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, padding: '6px 8px', background: '#f8fafc', borderRadius: 6, border: '1px solid #e2e8f0', cursor: 'pointer', width: '100%' },
          },
            h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, color: '#0f172a' } },
              h('span', { style: { width: 10, height: 10, borderRadius: 999, background: s.color, display: 'inline-block' } }),
              s.label,
            ),
            h('span', { style: { fontWeight: 600, color: '#334155' } }, `${formatMetricNumber(s.value)} (${(s.pct * 100).toFixed(1)}%)`),
          )),
        ),
      );
    };

    const renderKpiView = () => {
      const kpiValue = summary ? summary.value : 0;
      return h('div', {
        'data-testid': 'dxos-bi-chart-kpi',
        style: { display: 'grid', gap: 12 },
      },
        h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, padding: 14, borderRadius: 10, background: '#f0f9ff', border: '1px solid #bae6fd' } },
          h('div', null,
            h('div', { style: { fontSize: 12, color: '#0369a1', fontWeight: 600 } }, `${METRIC_OP_LABELS[payload.metric.op] || payload.metric.op}${payload.metric.field ? ` · ${resolveFieldLabel(payload.metric.field)}` : ''}`),
            h('div', { 'data-testid': 'dxos-bi-kpi-value', style: { fontSize: 32, fontWeight: 800, color: '#0f172a', lineHeight: 1.15, marginTop: 4 } }, formatMetricNumber(kpiValue)),
          ),
          h('div', { style: { fontSize: 12, color: '#475569' } }, `${formatMetricNumber(totalRows)} bản ghi`),
        ),
        summary && payload.metric.op !== 'count' ? h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 8 } },
          [['Nhỏ nhất', summary.min], ['Trung bình', summary.avg], ['Lớn nhất', summary.max], ['Tổng', summary.sum]].map(([lbl, v]) =>
            h('div', { key: lbl, style: { padding: 8, borderRadius: 8, background: '#f8fafc', border: '1px solid #e2e8f0' } },
              h('div', { style: { fontSize: 11, color: '#64748b' } }, lbl),
              h('div', { style: { fontSize: 15, fontWeight: 700, color: '#0f172a' } }, formatMetricNumber(v)),
            ),
          ),
        ) : null,
        series.length ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
          ...series.slice(0, 8).map((s, idx) => h('span', {
            key: `kpi-chip-${idx}`,
            style: { padding: '4px 9px', borderRadius: 999, background: '#f1f5f9', fontSize: 12, color: '#334155' },
          }, `${s.label || s.key}: ${formatMetricNumber(s.value)}`)),
        ) : null,
      );
    };

    const renderPivotView = () => {
      const rows = Array.isArray(pivotMatrix?.rows) ? pivotMatrix.rows : [];
      const columns = Array.isArray(pivotMatrix?.columns) ? pivotMatrix.columns : [];
      const cells = pivotMatrix?.cells || {};
      const rowTotals = pivotMatrix?.rowTotals || {};
      const colTotals = pivotMatrix?.colTotals || {};
      return h('div', { 'data-testid': 'dxos-bi-chart-pivot', style: { overflowX: 'auto' } },
        h('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: 12 } },
          h('thead', null,
            h('tr', { style: { background: '#f1f5f9' } },
              h('th', { style: { textAlign: 'left', padding: '8px 10px', border: '1px solid #cbd5e1', color: '#0f172a' } }, `${resolveFieldLabel(pivotMatrix?.rowField || payload.groupBy) || 'Hàng'} \\ ${resolveFieldLabel(pivotMatrix?.colField || payload.secondaryGroupBy) || 'Cột'}`),
              ...columns.map((cKey) => h('th', { key: `col-${cKey}`, style: { textAlign: 'right', padding: '8px 10px', border: '1px solid #cbd5e1', color: '#0f172a' } }, cKey)),
              h('th', { style: { textAlign: 'right', padding: '8px 10px', border: '1px solid #cbd5e1', background: '#e2e8f0', color: '#0f172a' } }, 'Tổng hàng'),
            ),
          ),
          h('tbody', null,
            ...rows.map((rKey) => {
              const rowObj = readSafeObjProp(cells, rKey, null);
              return h('tr', { key: `row-${rKey}` },
                h('td', { style: { padding: '7px 10px', border: '1px solid #e2e8f0', fontWeight: 600, color: '#1e293b' } }, rKey),
                ...columns.map((cKey) => {
                  const rowField = pivotMatrix?.rowField || effectiveGroupBy;
                  const colField = pivotMatrix?.colField || effectiveSecondaryGroupBy;
                  return h('td', {
                    key: `cell-${rKey}-${cKey}`,
                    'data-testid': 'dxos-bi-pivot-cell',
                    onClick: () => openDrilldown(
                      [
                        ...(rowField ? [{ field: rowField, value: rKey }] : []),
                        ...(colField ? [{ field: colField, value: cKey }] : []),
                      ],
                      `${rKey} / ${cKey}`,
                    ),
                    style: { textAlign: 'right', padding: '7px 10px', border: '1px solid #e2e8f0', color: '#334155', cursor: 'pointer' },
                  }, formatMetricNumber(readSafeObjProp(rowObj, cKey, 0)));
                }),
                h('td', { style: { textAlign: 'right', padding: '7px 10px', border: '1px solid #e2e8f0', fontWeight: 700, background: '#f8fafc' } }, formatMetricNumber(readSafeObjProp(rowTotals, rKey, 0))),
              );
            }),
          ),
          h('tfoot', null,
            h('tr', { style: { background: '#f1f5f9', fontWeight: 700 } },
              h('td', { style: { padding: '8px 10px', border: '1px solid #cbd5e1' } }, 'Tổng cột'),
              ...columns.map((cKey) => h('td', { key: `tot-${cKey}`, style: { textAlign: 'right', padding: '8px 10px', border: '1px solid #cbd5e1' } }, formatMetricNumber(readSafeObjProp(colTotals, cKey, 0)))),
              h('td', { style: { textAlign: 'right', padding: '8px 10px', border: '1px solid #cbd5e1', background: '#dbeafe', color: '#1e3a8a' } }, formatMetricNumber(pivotMatrix?.grandTotal ?? summary?.value ?? 0)),
            ),
          ),
        ),
      );
    };

    const viewerSelectStyle = {
      padding: '4px 8px',
      borderRadius: 6,
      border: '1px solid #cbd5e1',
      background: '#ffffff',
      color: '#0f172a',
      fontSize: 12,
      minWidth: 0,
      maxWidth: 210,
    };

    return h('section', {
      'data-testid': 'dxos-bi-chart-block',
      style: {
        background: '#ffffff',
        border: '1px solid #e2e8f0',
        borderRadius: 12,
        padding: 16,
        paddingBottom: 56,
        display: 'grid',
        gap: 12,
      },
    },
      h('div', { style: { display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 8 } },
        h('div', null,
          h('h3', { style: { margin: 0, fontSize: 16, fontWeight: 700, color: '#0f172a' } }, cleanTitle),
          h('div', { style: { fontSize: 12, color: '#64748b', marginTop: 2 } }, `${collectionTitle} · ${METRIC_OP_LABELS[payload.metric.op] || payload.metric.op}${payload.metric.field ? ` (${resolveFieldLabel(payload.metric.field)})` : ''}`),
        ),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' } },
          ...BI_CHART_TYPES.map((ct) => h('button', {
            key: ct,
            type: 'button',
            'data-testid': `dxos-bi-mode-${ct}`,
            onClick: () => handleSelectChartType(ct),
            style: {
              padding: '4px 9px',
              borderRadius: 6,
              border: activeChartType === ct ? '1px solid #2563eb' : '1px solid #cbd5e1',
              background: activeChartType === ct ? '#eff6ff' : '#ffffff',
              color: activeChartType === ct ? '#1d4ed8' : '#334155',
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
            },
          }, CHART_TYPE_LABELS[ct])),
          h('button', {
            type: 'button',
            'data-testid': 'dxos-bi-chart-refresh-btn',
            onClick: () => setRefreshNonce((n) => n + 1),
            style: {
              padding: '4px 10px',
              borderRadius: 6,
              border: '1px solid #cbd5e1',
              background: '#f8fafc',
              color: '#0f172a',
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
            },
          }, 'Làm mới'),
        ),
      ),
      h('div', {
        'data-testid': 'dxos-bi-viewer-controls',
        style: {
          display: 'flex',
          flexWrap: 'wrap',
          gap: 8,
          alignItems: 'center',
          padding: '8px 10px',
          borderRadius: 8,
          background: '#f8fafc',
          border: '1px solid #e2e8f0',
        },
      },
        h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 600, color: '#475569' } },
          'Nguồn dữ liệu',
          h('select', {
            'data-testid': 'dxos-bi-viewer-collection',
            'aria-label': 'Chọn nguồn dữ liệu BI',
            value: activeCollection,
            onChange: (e) => handleSelectCollection(e.target.value),
            style: viewerSelectStyle,
          }, viewerCollectionOptions.map((opt) => h('option', { key: opt.value, value: opt.value }, opt.label))),
        ),
        activeChartType !== 'kpi' ? h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 600, color: '#475569' } },
          activeChartType === 'pivot' ? 'Nhóm hàng' : 'Nhóm theo',
          h('select', {
            'data-testid': 'dxos-bi-viewer-groupby',
            'aria-label': 'Chọn trường nhóm chính BI',
            value: effectiveGroupBy,
            onChange: (e) => handleSelectGroupBy(e.target.value),
            style: viewerSelectStyle,
          },
            !effectiveGroupBy ? h('option', { value: '' }, '-- Chọn trường nhóm --') : null,
            groupBySelectOptions.map((opt) => h('option', { key: opt.value, value: opt.value }, opt.label)),
          ),
        ) : null,
        activeChartType === 'pivot' ? h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 600, color: '#475569' } },
          'Cột Pivot',
          h('select', {
            'data-testid': 'dxos-bi-viewer-secondary-groupby',
            'aria-label': 'Chọn trường nhóm phụ Pivot',
            value: effectiveSecondaryGroupBy,
            onChange: (e) => setActiveSecondaryGroupBy(normalizeBiField(e.target.value)),
            style: viewerSelectStyle,
          },
            h('option', { value: '' }, '-- Chọn cột Pivot --'),
            secondarySelectOptions.map((opt) => h('option', { key: opt.value, value: opt.value }, opt.label)),
          ),
        ) : null,
        h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 600, color: '#475569' } },
          'Phép tính',
          h('select', {
            'data-testid': 'dxos-bi-viewer-metric-op',
            'aria-label': 'Chọn phép tổng hợp BI',
            value: activeMetricOp,
            onChange: (e) => handleSelectMetricOp(e.target.value),
            style: viewerSelectStyle,
          }, BI_METRIC_OPS.map((opKey) => h('option', { key: opKey, value: opKey }, METRIC_OP_LABELS[opKey]))),
        ),
        activeMetricOp !== 'count' ? h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 600, color: '#475569' } },
          'Trường số',
          h('select', {
            'data-testid': 'dxos-bi-viewer-metric-field',
            'aria-label': 'Chọn trường số tổng hợp BI',
            value: effectiveMetricField,
            onChange: (e) => setActiveMetricField(normalizeBiField(e.target.value)),
            style: viewerSelectStyle,
          },
            !effectiveMetricField ? h('option', { value: '' }, '-- Chọn trường số --') : null,
            metricFieldSelectOptions.map((opt) => h('option', { key: opt.value, value: opt.value }, opt.label)),
          ),
        ) : null,
        h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 600, color: '#475569' } },
          'Giới hạn nhóm',
          h('select', {
            'data-testid': 'dxos-bi-viewer-limit',
            'aria-label': 'Giới hạn số nhóm BI',
            value: String(activeLimit),
            onChange: (e) => setActiveLimit(buildAggregateQueryPayload({ limit: e.target.value }).limit),
            style: viewerSelectStyle,
          }, limitOptions.map((n) => h('option', { key: n, value: String(n) }, `${n} nhóm`))),
        ),
      ),
      hasInvalidFilter ? h('div', {
        'data-testid': 'dxos-bi-chart-filter-warning',
        role: 'alert',
        style: { padding: 12, borderRadius: 8, background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e', fontSize: 13 },
      }, 'Bộ lọc JSON không hợp lệ hoặc chứa khóa/toán tử bị chặn — đã từ chối truy vấn.') : null,
      !hasInvalidFilter && needsPivotSecondaryGroupBy ? h('div', {
        'data-testid': 'dxos-bi-chart-pivot-prompt',
        role: 'status',
        style: { padding: 14, borderRadius: 8, background: '#eff6ff', border: '1px solid #bfdbfe', color: '#1e40af', fontSize: 13 },
      }, 'Vui lòng chọn trường nhóm phụ (Cột Pivot) để xem bảng chéo.') : null,
      !hasInvalidFilter && !needsPivotSecondaryGroupBy && needsGroupBy ? h('div', {
        'data-testid': 'dxos-bi-chart-groupby-prompt',
        role: 'status',
        style: { padding: 14, borderRadius: 8, background: '#eff6ff', border: '1px solid #bfdbfe', color: '#1e40af', fontSize: 13 },
      }, 'Vui lòng chọn trường nhóm chính để xem biểu đồ.') : null,
      !hasInvalidFilter && !needsPivotSecondaryGroupBy && !needsGroupBy && needsMetricField ? h('div', {
        'data-testid': 'dxos-bi-chart-metric-prompt',
        role: 'status',
        style: { padding: 14, borderRadius: 8, background: '#eff6ff', border: '1px solid #bfdbfe', color: '#1e40af', fontSize: 13 },
      }, 'Vui lòng chọn trường số để tính chỉ số.') : null,
      state.loading ? h('div', { 'data-testid': 'dxos-bi-chart-loading', style: { padding: 16, fontSize: 13, color: '#475569' } }, 'Đang tổng hợp dữ liệu BI...') : null,
      state.error ? h('div', {
        'data-testid': 'dxos-bi-chart-error',
        role: 'alert',
        style: { padding: 12, borderRadius: 8, background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', fontSize: 13 },
      }, state.error) : null,
      isEmpty ? h('div', {
        'data-testid': 'dxos-bi-chart-empty',
        style: { padding: 20, textAlign: 'center', color: '#64748b', fontSize: 13, background: '#f8fafc', borderRadius: 8 },
      }, 'Chưa có dữ liệu phù hợp để hiển thị biểu đồ.') : null,
      !blockQueryGuard && !state.loading && !state.error && !isEmpty ? (
        activeChartType === 'line' ? renderLineView()
          : activeChartType === 'pie' ? renderPieView()
            : activeChartType === 'kpi' ? renderKpiView()
              : activeChartType === 'pivot' ? renderPivotView()
                : renderBarView()
      ) : null,
      drilldown.open ? h('div', {
        'data-testid': 'dxos-bi-drilldown-panel',
        role: 'region',
        'aria-label': `Chi tiết bản ghi BI: ${drilldown.title}`,
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
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('strong', { style: { fontSize: 13, color: '#0f172a' } }, `Chi tiết phân nhóm: ${drilldown.title} (${drilldown.items.length} bản ghi)`),
          h('button', {
            type: 'button',
            'data-testid': 'dxos-bi-drilldown-close',
            onClick: () => setDrilldown({ open: false, title: '', conditions: [], loading: false, items: [], error: '' }),
            style: { border: '1px solid #cbd5e1', background: '#ffffff', color: '#334155', borderRadius: 6, padding: '2px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer' },
          }, 'Đóng'),
        ),
        drilldown.loading ? h('div', { style: { fontSize: 12, color: '#475569' } }, 'Đang tải danh sách bản ghi chi tiết...') : null,
        drilldown.error ? h('div', {
          role: 'alert',
          style: { fontSize: 12, color: '#991b1b', background: '#fee2e2', borderRadius: 6, padding: '6px 10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
        },
          h('span', null, drilldown.error),
          h('button', {
            type: 'button',
            onClick: () => openDrilldown(drilldown.conditions, drilldown.title),
            style: { border: '1px solid #dc2626', background: '#ffffff', color: '#dc2626', borderRadius: 4, padding: '2px 8px', fontSize: 11, fontWeight: 600, cursor: 'pointer' },
          }, 'Thử lại'),
        ) : null,
        !drilldown.loading && !drilldown.error && !drilldown.items.length
          ? h('div', { style: { fontSize: 12, color: '#64748b' } }, 'Không tìm thấy bản ghi chi tiết phù hợp.')
          : null,
        !drilldown.loading && !drilldown.error && drilldown.items.length > 0 ? h('div', { style: { overflowX: 'auto' } },
          h('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: 12, background: '#ffffff' } },
            h('thead', null, h('tr', { style: { background: '#e2e8f0', textAlign: 'left' } },
              ['ID', 'Mã', 'Tên / Mô tả', 'Trạng thái', 'Thời gian'].map((col) => h('th', { key: col, style: { padding: '6px 8px', border: '1px solid #cbd5e1' } }, col)),
            )),
            h('tbody', null, drilldown.items.map((rec, idx) => h('tr', { key: rec.id ?? idx, style: { borderTop: '1px solid #e2e8f0' } },
              h('td', { style: { padding: '6px 8px' } }, String(rec.id ?? '—')),
              h('td', { style: { padding: '6px 8px', fontWeight: 600 } }, String(rec.code || rec.lotCode || '—')),
              h('td', { style: { padding: '6px 8px' } }, String(rec.name || rec.title || rec.subject || rec.productName || '—')),
              h('td', { style: { padding: '6px 8px' } }, rec.status ? formatStatusLabel(rec.status) : '—'),
              h('td', { style: { padding: '6px 8px', color: '#475569' } }, formatBiDateTime(rec.createdAt || rec.updatedAt)),
            ))),
          ),
        ) : null,
      ) : null,
    );
  };
}

module.exports = {
  BI_CHART_TYPES,
  BI_METRIC_OPS,
  BI_PALETTE,
  BI_DEFAULT_COLLECTION,
  normalizeBiCollection,
  normalizeBiField,
  parseBiFilterJson,
  buildAggregateQueryPayload,
  resolvePivotSecondaryField,
  computeBarGeometry,
  computeLineGeometry,
  computePieSlices,
  formatMetricNumber,
  buildDrilldownFilter,
  createBiChartBlockView,
};
