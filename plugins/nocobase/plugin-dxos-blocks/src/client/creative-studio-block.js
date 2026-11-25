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
  isSafeAppPath,
  safeJsonParse,
  inferPortalSlugFromLocation,
  triggerDxosAgent,
  requestAndDownloadExport,
  formatStatusLabel,
  stripDevBracketTags,
} = require('./blocks-helpers');
const { createRecordChatterView, createVoucherLifecycleBar } = require('./chatter-panel');

const VALID_QUERY_KINDS = new Set(['collection', 'telemetry', 'tasks', 'timeseries']);
const VALID_WIDGET_TYPES = new Set([
  'gauge', 'thermometer', 'timeseries-line', 'stage-pipeline', 'distribution-bars',
  'rule-callout', 'status-matrix', 'quick-actions', 'export-bar', 'chatter', 'voucher-actions',
]);

const CREATIVE_THEMES = {
  'industrial-cockpit': {
    bg: 'linear-gradient(145deg, #0f172a 0%, #1e293b 100%)',
    border: '#334155',
    cardBg: '#1e293b',
    cardBorder: '#334155',
    titleColor: '#f8fafc',
    mutedColor: '#94a3b8',
    accent: '#38bdf8',
    badgeBg: '#0c4a6e',
    badgeColor: '#7dd3fc',
  },
  'emerald-ops': {
    bg: 'linear-gradient(145deg, #ecfdf5 0%, #ffffff 75%)',
    border: '#a7f3d0',
    cardBg: '#ffffff',
    cardBorder: '#d1fae5',
    titleColor: '#064e3b',
    mutedColor: '#047857',
    accent: '#059669',
    badgeBg: '#d1fae5',
    badgeColor: '#065f46',
  },
  'amber-alert': {
    bg: 'linear-gradient(145deg, #fffbeb 0%, #fff7ed 80%)',
    border: '#fcd34d',
    cardBg: '#ffffff',
    cardBorder: '#fde68a',
    titleColor: '#78350f',
    mutedColor: '#b45309',
    accent: '#d97706',
    badgeBg: '#fef3c7',
    badgeColor: '#92400e',
  },
  'royal-indigo': {
    bg: 'linear-gradient(145deg, #eef2ff 0%, #ffffff 78%)',
    border: '#c7d2fe',
    cardBg: '#ffffff',
    cardBorder: '#e0e7ff',
    titleColor: '#1e1b4b',
    mutedColor: '#4338ca',
    accent: '#4f46e5',
    badgeBg: '#e0e7ff',
    badgeColor: '#3730a3',
  },
  'clean-light': {
    bg: '#ffffff',
    border: '#e2e8f0',
    cardBg: '#f8fafc',
    cardBorder: '#e2e8f0',
    titleColor: '#0f172a',
    mutedColor: '#475569',
    accent: '#1677ff',
    badgeBg: '#eff6ff',
    badgeColor: '#1d4ed8',
  },
};

const DEFAULT_CREATIVE_BLUEPRINT = JSON.stringify({
  title: 'Buồng Điều hành Thông minh [AI Studio]',
  subtitle: 'Lắp ghép tự do đồng hồ đo, pipeline, quy tắc cảnh báo & nút thao tác theo RBAC.',
  theme: 'industrial-cockpit',
  columns: 2,
  queries: [{ id: 'orders', collection: 'latticeOrders', limit: 20 }],
  widgets: [
    { type: 'gauge', title: 'Tổng bản ghi theo dõi', queryId: 'orders', metric: 'count', max: 25, unit: 'hồ sơ' },
    { type: 'distribution-bars', title: 'Phân bổ trạng thái', queryId: 'orders', field: 'status' },
  ],
}, null, 2);

function sanitizeQuickButtons(buttons) {
  if (!Array.isArray(buttons)) return [];
  const out = [];
  for (const btn of buttons) {
    if (!btn || typeof btn !== 'object') continue;
    const label = String(btn.label || '').trim().slice(0, 48);
    const kind = ['navigate', 'createRecord', 'askAi'].includes(btn.kind) ? btn.kind : 'navigate';
    if (!label) continue;
    if (kind === 'navigate') {
      const targetPath = String(btn.targetPath || '').trim();
      if (!isSafeAppPath(targetPath)) continue;
      out.push({ label, kind, targetPath, primary: Boolean(btn.primary) });
    } else if (kind === 'createRecord') {
      const collection = String(btn.collection || '').trim();
      if (!SAFE_COLLECTION_RE.test(collection)) continue;
      const defaultValues = btn.defaultValues && typeof btn.defaultValues === 'object' && !Array.isArray(btn.defaultValues)
        ? btn.defaultValues : {};
      out.push({ label, kind, collection, defaultValues, primary: Boolean(btn.primary) });
    } else {
      const aiEmployee = String(btn.aiEmployee || 'dxos-coordinator').trim().slice(0, 64);
      const prompt = String(btn.prompt || label).trim().slice(0, 600);
      out.push({ label, kind, aiEmployee, prompt, primary: Boolean(btn.primary) });
    }
    if (out.length >= 6) break;
  }
  return out;
}

function parseCreativeBlueprint(raw) {
  const obj = safeJsonParse(raw, {}) || {};
  const theme = Object.prototype.hasOwnProperty.call(CREATIVE_THEMES, obj.theme) ? obj.theme : 'industrial-cockpit';
  const columns = Math.max(1, Math.min(4, Number(obj.columns) || 2));

  const queries = [];
  for (const q of Array.isArray(obj.queries) ? obj.queries : []) {
    if (!q || typeof q !== 'object') continue;
    const id = String(q.id || `q_${queries.length + 1}`).trim().slice(0, 40);
    const kind = VALID_QUERY_KINDS.has(q.kind) ? q.kind : 'collection';
    const collection = String(q.collection || '').trim();
    if (kind === 'collection' && !SAFE_COLLECTION_RE.test(collection)) continue;
    const filter = q.filter && typeof q.filter === 'object' && !Array.isArray(q.filter) ? q.filter : {};
    const limit = Math.max(1, Math.min(kind === 'timeseries' ? 200 : 50, Number(q.limit) || 20));
    queries.push({
      id,
      kind,
      collection,
      filter,
      limit,
      ...(q.assetEntityId ? { assetEntityId: String(q.assetEntityId).trim().slice(0, 120) } : {}),
      ...(q.assetId != null ? { assetId: q.assetId } : {}),
      ...(q.attribute ? { attribute: String(q.attribute).trim().slice(0, 60) } : {}),
    });
    if (queries.length >= 6) break;
  }

  const widgets = [];
  for (const w of Array.isArray(obj.widgets) ? obj.widgets : []) {
    if (!w || typeof w !== 'object' || !VALID_WIDGET_TYPES.has(w.type)) continue;
    widgets.push({
      ...w,
      title: String(w.title || w.type).trim().slice(0, 80),
      buttons: w.type === 'quick-actions' ? sanitizeQuickButtons(w.buttons) : undefined,
    });
    if (widgets.length >= 12) break;
  }

  return {
    title: String(obj.title || 'Buồng Điều hành Sáng tạo [AI]').trim().slice(0, 120),
    subtitle: obj.subtitle ? String(obj.subtitle).trim().slice(0, 260) : '',
    badge: obj.badge ? String(obj.badge).trim().slice(0, 48) : 'CREATIVE STUDIO · GUARDRAILED DSL',
    theme,
    columns,
    queries,
    widgets,
  };
}

function evaluateQueryStats(rows, { metric = 'count', field = '' } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (metric === 'count') return list.length;
  if (metric === 'groupBy') {
    const counts = new Map();
    for (const row of list) {
      const k = String(row?.[field] ?? 'Khác');
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    return [...counts.entries()].map(([key, count]) => ({ key, count })).slice(0, 8);
  }
  const nums = list.map((r) => Number(r?.[field])).filter((n) => Number.isFinite(n));
  if (!nums.length) return null;
  if (metric === 'latest') return nums[0];
  if (metric === 'min') return Math.min(...nums);
  if (metric === 'max') return Math.max(...nums);
  const sum = nums.reduce((acc, n) => acc + n, 0);
  if (metric === 'sum') return sum;
  if (metric === 'avg') return sum / nums.length;
  return nums[0];
}

function evaluateRuleCondition(value, operator = 'gt', threshold = 0) {
  const numVal = Number(value);
  const numThreshold = Number(threshold);
  const bothNum = Number.isFinite(numVal) && Number.isFinite(numThreshold) && value !== '' && value !== null && value !== undefined;
  if (operator === 'eq') return bothNum ? numVal === numThreshold : String(value ?? '') === String(threshold ?? '');
  if (!bothNum) return false;
  if (operator === 'gt') return numVal > numThreshold;
  if (operator === 'gte') return numVal >= numThreshold;
  if (operator === 'lt') return numVal < numThreshold;
  if (operator === 'lte') return numVal <= numThreshold;
  return false;
}

function resolveWidgetValue(widget, queryResults, queryCounts = {}) {
  const metric = widget.metric || 'count';
  const rows = queryResults?.[widget.queryId] || [];
  const rawCount = widget.queryId && queryCounts ? queryCounts[widget.queryId] : undefined;
  const hasCount = rawCount != null && Number.isFinite(Number(rawCount));
  const resolvedCount = hasCount ? Number(rawCount) : null;

  if (widget.staticValue !== undefined && (!widget.queryId || (!rows.length && !(metric === 'count' && hasCount && resolvedCount > 0)))) {
    return widget.staticValue;
  }
  if (metric === 'count' && hasCount) {
    return resolvedCount;
  }
  if (!rows.length && widget.staticValue !== undefined) return widget.staticValue;
  return evaluateQueryStats(rows, { metric, field: widget.field || '' });
}

function navigateApp(app, path) {
  if (!isSafeAppPath(path)) return;
  if (app?.router?.navigate) app.router.navigate(path);
  else if (typeof window !== 'undefined' && window.location) window.location.assign(app?.getRouteUrl?.(path) || path);
}

function normalizeTelemetryRows(payload) {
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.sensors)) return payload.sensors;
  if (payload.telemetry && typeof payload.telemetry === 'object' && !Array.isArray(payload.telemetry)) {
    const flat = {
      ...(payload.asset && typeof payload.asset === 'object' ? payload.asset : {}),
      brokerStatus: payload.brokerStatus || 'unknown',
    };
    for (const [k, rawVal] of Object.entries(payload.telemetry)) {
      flat[k] = rawVal && typeof rawVal === 'object' && Object.hasOwn(rawVal, 'value') ? rawVal.value : rawVal;
    }
    return [flat];
  }
  if (payload.latest) return [payload.latest];
  return payload.asset ? [{ ...payload.asset, brokerStatus: payload.brokerStatus || 'unknown' }] : [];
}

function createCreativeStudioView(client, React, _antd, app, { subscribeModelConfig } = {}) {
  const h = React.createElement;
  const useApi = typeof client?.useAPIClient === 'function' ? client.useAPIClient : () => app?.apiClient || null;
  const RecordChatterView = createRecordChatterView(client, React, app);
  const VoucherLifecycleBar = createVoucherLifecycleBar(client, React, app);

  return function DxosCreativeStudioView({ model, liveConfig }) {
    const api = useApi();
    const [, setTick] = React.useState(0);
    React.useEffect(() => (typeof subscribeModelConfig === 'function' ? subscribeModelConfig(model, () => setTick((t) => t + 1)) : undefined), [model]);
    const rawStepCfg = model?.getStepParams?.('dxosBlockSettings', 'config') || model?.stepParams?.dxosBlockSettings?.config || {};
    const mergedCfg = { ...(model?.props || {}), ...rawStepCfg, ...(liveConfig || {}) };
    const bp = React.useMemo(() => parseCreativeBlueprint(mergedCfg.blueprintJson || mergedCfg), [mergedCfg.blueprintJson, mergedCfg.title, mergedCfg.theme]);
    const palette = CREATIVE_THEMES[bp.theme] || CREATIVE_THEMES['industrial-cockpit'];

    const [queryState, setQueryState] = React.useState({ loading: false, results: {}, counts: {}, error: '' });
    const [actionNote, setActionNote] = React.useState('');

    const runQueries = React.useCallback(async () => {
      if (!api?.request || !bp.queries.length) return;
      setQueryState((prev) => ({ ...prev, loading: true, error: '' }));
      const results = {};
      const counts = {};
      await Promise.all(bp.queries.map(async (q) => {
        try {
          if (q.kind === 'timeseries') {
            const res = await api.request({
              url: 'dxosBlocks:telemetrySeries',
              method: 'post',
              data: {
                ...(q.assetEntityId ? { assetEntityId: q.assetEntityId } : {}),
                ...(q.assetId != null ? { assetId: q.assetId } : {}),
                ...(q.attribute ? { attribute: q.attribute } : {}),
                limit: q.limit,
              },
            });
            results[q.id] = res?.data?.data || res?.data || { points: [], stats: {}, activeAlarms: [] };
          } else if (q.kind === 'telemetry') {
            const res = await api.request({ url: 'dxosBlocks:contextTelemetry', method: 'post', data: {} });
            const payload = res?.data?.data || res?.data || {};
            results[q.id] = normalizeTelemetryRows(payload);
          } else if (q.kind === 'tasks') {
            const res = await api.request({ url: 'workflowManualTasks:listMine', method: 'get', params: { pageSize: q.limit, sort: ['-id'] } });
            const rows = Array.isArray(res?.data?.data) ? res.data.data : [];
            results[q.id] = rows;
            const metaCount = Number(res?.data?.meta?.count);
            counts[q.id] = Number.isFinite(metaCount) ? metaCount : rows.length;
          } else {
            const res = await api.request({
              url: `${q.collection}:list`,
              method: 'get',
              params: { pageSize: q.limit, sort: ['-id'], ...(Object.keys(q.filter).length ? { filter: q.filter } : {}) },
            });
            const rows = Array.isArray(res?.data?.data) ? res.data.data : [];
            results[q.id] = rows;
            const metaCount = Number(res?.data?.meta?.count);
            counts[q.id] = Number.isFinite(metaCount) ? metaCount : rows.length;
          }
        } catch {
          results[q.id] = [];
        }
      }));
      setQueryState({ loading: false, results, counts, error: '' });
    }, [api, bp.queries]);

    React.useEffect(() => { runQueries(); }, [runQueries]);

    React.useEffect(() => {
      if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined;
      const onSurfaceUpdate = (ev) => {
        const detailSlug = String(ev?.detail?.portalSlug || '').trim().toLowerCase();
        const curSlug = window.location ? inferPortalSlugFromLocation(window.location.pathname) : '';
        if (!detailSlug || !curSlug || detailSlug === curSlug) {
          runQueries();
        }
      };
      window.addEventListener('latticedx:surface-updated', onSurfaceUpdate);
      return () => window.removeEventListener?.('latticedx:surface-updated', onSurfaceUpdate);
    }, [runQueries]);

    const handleAction = async (btn) => {
      if (btn.kind === 'navigate') {
        navigateApp(app, btn.targetPath);
        return;
      }
      if (btn.kind === 'askAi') {
        const portalSlug = typeof window !== 'undefined' && window.location ? inferPortalSlugFromLocation(window.location.pathname) : '';
        await triggerDxosAgent(app, { aiEmployee: btn.aiEmployee, prompt: btn.prompt, blockTitle: mergedCfg.title || bp.title, portalSlug });
        return;
      }
      if (btn.kind === 'createRecord' && api?.request) {
        try {
          setActionNote(`Đang tạo bản ghi trên ${btn.collection}…`);
          await api.request({ url: `${btn.collection}:create`, method: 'post', data: btn.defaultValues || {} });
          setActionNote(`Đã tạo bản ghi mới trên ${btn.collection}.`);
          runQueries();
        } catch (err) {
          setActionNote(err?.response?.data?.errors?.[0]?.message || 'Không đủ quyền thực thi hành động.');
        }
      }
    };

    const renderWidget = (w, idx) => {
      const cardStyle = {
        padding: 14,
        borderRadius: 10,
        background: palette.cardBg,
        border: `1px solid ${palette.cardBorder}`,
        color: palette.titleColor,
      };
      const handleAlarmTransition = async (alarmId, op) => {
        if (!api?.request || !alarmId) return;
        try {
          setActionNote(op === 'ack' ? 'Đang xác nhận cảnh báo…' : 'Đang đóng cảnh báo…');
          await api.request({
            url: op === 'ack' ? 'dxosBlocks:alarmAck' : 'dxosBlocks:alarmClear',
            method: 'post',
            data: { id: alarmId, ...(op === 'clear' ? { closeNote: 'Đã đóng cảnh báo từ bảng điều khiển telemetry' } : {}) },
          });
          setActionNote(op === 'ack' ? `Đã xác nhận (Ack) cảnh báo #${alarmId}.` : `Đã đóng (Clear) cảnh báo #${alarmId}.`);
          runQueries();
        } catch (err) {
          setActionNote(err?.response?.data?.errors?.[0]?.message || 'Không cập nhật được trạng thái cảnh báo.');
        }
      };

      if (w.type === 'timeseries-line') {
        const series = queryState.results[w.queryId];
        const rawPoints = Array.isArray(series?.points) ? series.points : Array.isArray(series) ? series : [];
        const vals = rawPoints.map((p) => Number(p?.value ?? p?.[w.field || 'value'])).filter((n) => Number.isFinite(n));
        const warnT = w.warningThreshold !== undefined ? Number(w.warningThreshold) : null;
        const critT = w.criticalThreshold !== undefined ? Number(w.criticalThreshold) : null;
        const allVals = [...vals, ...(Number.isFinite(warnT) ? [warnT] : []), ...(Number.isFinite(critT) ? [critT] : [])];
        const minV = allVals.length ? Math.min(...allVals) : 0;
        const maxV = allVals.length && Math.max(...allVals) > minV ? Math.max(...allVals) : minV + 1;
        const svgW = 360;
        const svgH = 110;
        const pad = 10;
        const yFor = (v) => {
          const ratio = (v - minV) / (maxV - minV);
          return Number((svgH - pad - ratio * (svgH - pad * 2)).toFixed(1));
        };
        const coords = vals.map((v, i) => {
          const x = vals.length <= 1 ? svgW / 2 : Number((pad + (i / (vals.length - 1)) * (svgW - pad * 2)).toFixed(1));
          return `${x},${yFor(v)}`;
        });
        const stats = series?.stats || (vals.length ? { min: Math.min(...vals), max: Math.max(...vals), avg: Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1)), latest: vals[vals.length - 1] } : {});
        const activeAlarms = Array.isArray(series?.activeAlarms) ? series.activeAlarms : [];
        const unitLabel = w.unit ? ` ${w.unit}` : '';
        return h('div', { key: idx, 'data-testid': 'dxos-timeseries-line-widget', style: { ...cardStyle, gridColumn: '1 / -1' } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, flexWrap: 'wrap', gap: 6 } },
            h('span', { style: { fontSize: 12, color: palette.mutedColor, fontWeight: 700 } }, w.title),
            h('div', { style: { display: 'flex', gap: 10, fontSize: 11, color: palette.mutedColor } },
              stats.latest != null ? h('span', { style: { fontWeight: 800, color: palette.titleColor } }, `Mới nhất: ${stats.latest}${unitLabel}`) : null,
              stats.min != null ? h('span', null, `Min: ${stats.min}${unitLabel}`) : null,
              stats.max != null ? h('span', null, `Max: ${stats.max}${unitLabel}`) : null,
            ),
          ),
          vals.length
            ? h('svg', { viewBox: `0 0 ${svgW} ${svgH}`, style: { width: '100%', height: 110, display: 'block' } },
              Number.isFinite(warnT) ? h('line', { x1: pad, x2: svgW - pad, y1: yFor(warnT), y2: yFor(warnT), stroke: '#f59e0b', strokeDasharray: '4 4', strokeWidth: 1.2 }) : null,
              Number.isFinite(critT) ? h('line', { x1: pad, x2: svgW - pad, y1: yFor(critT), y2: yFor(critT), stroke: '#ef4444', strokeDasharray: '4 4', strokeWidth: 1.4 }) : null,
              vals.length >= 2
                ? h('polyline', { fill: 'none', stroke: palette.accent, strokeWidth: 2.4, points: coords.join(' ') })
                : h('circle', { cx: svgW / 2, cy: yFor(vals[0]), r: 4, fill: palette.accent }),
            )
            : h('div', { style: { fontSize: 12, color: palette.mutedColor, padding: '16px 0' } }, 'Chưa có chuỗi điểm đo thời gian.'),
          activeAlarms.length
            ? h('div', { style: { marginTop: 8, display: 'grid', gap: 6 } },
              activeAlarms.slice(0, 3).map((alm) => h('div', { key: alm.id, style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 6, background: '#ef444418', border: '1px solid #ef444444', fontSize: 11 } },
                h('span', null, `[${formatStatusLabel(alm.severity)}] ${alm.code} (${formatStatusLabel(alm.status)}, lặp ${alm.occurrenceCount || 1}x)`),
                h('div', { style: { display: 'flex', gap: 6 } },
                  alm.status === 'open' ? h('button', { type: 'button', onClick: () => handleAlarmTransition(alm.id, 'ack'), style: { padding: '3px 8px', borderRadius: 6, border: '1px solid #f59e0b', background: 'transparent', color: '#f59e0b', cursor: 'pointer', fontWeight: 700 } }, 'Xác nhận (Ack)') : null,
                  h('button', { type: 'button', onClick: () => handleAlarmTransition(alm.id, 'clear'), style: { padding: '3px 8px', borderRadius: 6, border: '1px solid #10b981', background: 'transparent', color: '#10b981', cursor: 'pointer', fontWeight: 700 } }, 'Đóng (Clear)'),
                ),
              )),
            )
            : null,
        );
      }
      if (w.type === 'thermometer' || w.type === 'gauge') {
        const valNum = resolveWidgetValue(w, queryState.results, queryState.counts);
        const min = Number.isFinite(Number(w.min)) ? Number(w.min) : 0;
        const max = Number.isFinite(Number(w.max)) && Number(w.max) > min ? Number(w.max) : Math.max(min + 1, 100);
        const numericVal = valNum === null || valNum === undefined || valNum === '' ? NaN : Number(valNum);
        const hasNumeric = Number.isFinite(numericVal);
        const pct = hasNumeric ? Math.max(0, Math.min(100, Math.round(((numericVal - min) / (max - min)) * 100))) : 0;
        const isCritical = hasNumeric && w.criticalThreshold !== undefined && numericVal >= Number(w.criticalThreshold);
        const isWarn = hasNumeric && !isCritical && w.warningThreshold !== undefined && numericVal >= Number(w.warningThreshold);
        const barColor = isCritical ? '#ef4444' : isWarn ? '#f59e0b' : palette.accent;
        return h('div', { key: idx, style: cardStyle },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 12, color: palette.mutedColor, marginBottom: 6 } },
            h('span', null, w.title),
            isCritical || isWarn ? h('span', { style: { fontWeight: 700, color: barColor } }, isCritical ? 'NGUY CẤP' : 'CẢNH BÁO') : null,
          ),
          h('div', { style: { fontSize: 26, fontWeight: 800, color: barColor, marginBottom: 8 } },
            valNum === null || valNum === undefined ? '—' : `${hasNumeric ? Number(numericVal.toFixed(1)) : String(valNum)}${w.unit ? ` ${w.unit}` : ''}`),
          h('div', { style: { height: 8, borderRadius: 999, background: '#33415533', overflow: 'hidden' } },
            h('div', { style: { width: `${pct}%`, height: '100%', background: barColor, borderRadius: 999 } })),
        );
      }
      if (w.type === 'rule-callout') {
        const actual = resolveWidgetValue(w, queryState.results, queryState.counts);
        const triggered = evaluateRuleCondition(actual, w.operator || 'gt', w.threshold ?? 0);
        const toneColor = triggered ? '#ef4444' : '#10b981';
        return h('div', { key: idx, style: { ...cardStyle, borderLeft: `4px solid ${toneColor}` } },
          h('div', { style: { fontSize: 12, fontWeight: 700, color: toneColor, marginBottom: 4 } }, w.title),
          h('div', { style: { fontSize: 13, fontWeight: 600 } }, triggered ? (w.messageWhenTrue || 'Đã kích hoạt điều kiện cảnh báo') : (w.messageWhenFalse || 'Các chỉ số trong ngưỡng an toàn')),
          actual !== null && actual !== undefined ? h('div', { style: { fontSize: 11, color: palette.mutedColor, marginTop: 4 } }, `Giá trị hiện tại: ${actual}`) : null,
        );
      }
      if (w.type === 'stage-pipeline') {
        const stages = Array.isArray(w.stages) ? w.stages : ['Tiếp nhận', 'Kiểm định', 'Phê duyệt', 'Hoàn tất'];
        const activeIdx = Math.max(0, Math.min(stages.length - 1, Number(w.activeIndex) || 1));
        return h('div', { key: idx, style: cardStyle },
          h('div', { style: { fontSize: 12, color: palette.mutedColor, marginBottom: 8, fontWeight: 600 } }, w.title),
          h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
            stages.map((st, sIdx) => h('span', {
              key: sIdx,
              style: {
                padding: '4px 10px', borderRadius: 999, fontSize: 11, fontWeight: 700,
                background: sIdx <= activeIdx ? palette.accent : '#94a3b826',
                color: sIdx <= activeIdx ? '#ffffff' : palette.mutedColor,
              },
            }, `${sIdx + 1}. ${typeof st === 'string' ? st : st?.label || ''}`))),
        );
      }
      if (w.type === 'distribution-bars') {
        const rows = queryState.results[w.queryId] || [];
        const groups = Array.isArray(w.groups) ? w.groups : evaluateQueryStats(rows, { metric: 'groupBy', field: w.field || 'status' });
        const maxCnt = Math.max(1, ...(Array.isArray(groups) ? groups.map((g) => Number(g.count) || 0) : [1]));
        return h('div', { key: idx, style: cardStyle },
          h('div', { style: { fontSize: 12, color: palette.mutedColor, marginBottom: 8, fontWeight: 600 } }, w.title),
          !groups?.length ? h('div', { style: { fontSize: 12, color: palette.mutedColor } }, 'Chưa có dữ liệu nhóm')
            : h('div', { style: { display: 'grid', gap: 6 } }, groups.map((g, gIdx) => h('div', { key: gIdx, style: { fontSize: 12 } },
              h('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: 2 } }, h('span', null, g.key), h('strong', null, String(g.count))),
              h('div', { style: { height: 6, borderRadius: 999, background: '#94a3b830' } },
                h('div', { style: { width: `${Math.round((Number(g.count || 0) / maxCnt) * 100)}%`, height: '100%', background: palette.accent, borderRadius: 999 } })),
            ))),
        );
      }
      if (w.type === 'chatter') {
        return h('div', { key: idx, style: { ...cardStyle, gridColumn: '1 / -1' } },
          h(RecordChatterView, { targetCollection: w.collection, targetRecordId: w.recordId, showExport: Boolean(w.showExport), exportFields: w.fields }),
        );
      }
      if (w.type === 'voucher-actions') {
        return h('div', { key: idx, style: { ...cardStyle, gridColumn: '1 / -1' } },
          w.title ? h('div', { style: { fontSize: 12, color: palette.mutedColor, marginBottom: 8, fontWeight: 600 } }, w.title) : null,
          h(VoucherLifecycleBar, {
            targetCollection: w.collection,
            targetRecordId: w.recordId,
            recordStatus: w.status || '',
            onUpdated: () => runQueries(),
          }),
        );
      }
      if (w.type === 'export-bar') {
        const exportFormats = Array.isArray(w.formats) && w.formats.length ? w.formats : ['csv', 'xlsx', 'pdf'];
        return h('div', { key: idx, style: cardStyle },
          h('div', { style: { fontSize: 12, color: palette.mutedColor, marginBottom: 8, fontWeight: 600 } }, w.title),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
            exportFormats.map((fmt) => h('button', {
              key: fmt,
              type: 'button',
              onClick: async () => {
                if (!api?.request || !w.collection) return;
                try {
                  setActionNote(`Đang xuất ${String(fmt).toUpperCase()}…`);
                  const { meta, download } = await requestAndDownloadExport(api, {
                    collection: w.collection,
                    format: fmt,
                    fields: w.fields,
                  });
                  const dlNote = download?.downloaded ? ' · Đã tải xuống' : '';
                  setActionNote(`Đã xuất ${meta.filename || fmt} (${meta.rowCount ?? 0} dòng)${dlNote}.`);
                } catch (err) {
                  setActionNote(err?.response?.data?.errors?.[0]?.message || 'Không xuất được báo cáo.');
                }
              },
              style: { padding: '6px 12px', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: `1px solid ${palette.accent}`, background: 'transparent', color: palette.accent },
            }, `Xuất ${String(fmt).toUpperCase()}`))),
        );
      }
      if (w.type === 'status-matrix') {
        const items = Array.isArray(w.items) ? w.items : [];
        return h('div', { key: idx, style: cardStyle },
          h('div', { style: { fontSize: 12, color: palette.mutedColor, marginBottom: 8, fontWeight: 600 } }, w.title),
          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 6 } },
            items.map((it, mIdx) => h('div', { key: mIdx, style: { padding: '6px 8px', borderRadius: 6, background: '#94a3b818', fontSize: 12 } },
              h('div', { style: { color: palette.mutedColor, fontSize: 11 } }, String(it.label || '')),
              h('div', { style: { fontWeight: 700, color: it.tone === 'danger' ? '#ef4444' : it.tone === 'ok' ? '#10b981' : palette.titleColor } }, String(it.value || '—')),
            ))),
        );
      }
      return h('div', { key: idx, style: cardStyle },
        h('div', { style: { fontSize: 12, color: palette.mutedColor, marginBottom: 8, fontWeight: 600 } }, w.title),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
          (w.buttons || []).map((btn, bIdx) => h('button', {
            key: bIdx,
            type: 'button',
            onClick: () => handleAction(btn),
            style: {
              padding: '6px 12px', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer',
              border: `1px solid ${palette.accent}`,
              background: btn.primary ? palette.accent : 'transparent',
              color: btn.primary ? '#ffffff' : palette.accent,
            },
          }, btn.label))),
      );
    };

    return h('section', {
      'data-testid': 'dxos-creative-studio-block',
      'data-theme': bp.theme,
      style: {
        borderRadius: 12,
        padding: 18,
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        color: palette.titleColor,
      },
    },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 8, flexWrap: 'wrap' } },
        h('div', null,
          h('span', {
            style: {
              display: 'inline-block', fontSize: 10, fontWeight: 800, padding: '2px 8px', borderRadius: 999,
              background: palette.badgeBg, color: palette.badgeColor, marginBottom: 6,
            },
          }, bp.badge),
          h('h3', { style: { margin: 0, fontSize: 17, fontWeight: 800, color: palette.titleColor } }, stripDevBracketTags(mergedCfg.title || bp.title)),
          bp.subtitle ? h('div', { style: { fontSize: 12, color: palette.mutedColor, marginTop: 2 } }, bp.subtitle) : null,
        ),
        bp.queries.length ? h('button', {
          type: 'button',
          onClick: runQueries,
          disabled: queryState.loading,
          style: { border: `1px solid ${palette.border}`, background: palette.cardBg, color: palette.titleColor, borderRadius: 6, padding: '4px 10px', fontSize: 11, cursor: 'pointer' },
        }, queryState.loading ? 'Đang cập nhật…' : 'Làm mới số liệu') : null,
      ),
      actionNote ? h('div', { style: { fontSize: 12, color: palette.accent, marginBottom: 8 } }, actionNote) : null,
      h('div', { style: { display: 'grid', gridTemplateColumns: `repeat(${bp.columns}, minmax(0, 1fr))`, gap: 10 } },
        bp.widgets.map(renderWidget)),
    );
  };
}

module.exports = {
  VALID_WIDGET_TYPES,
  CREATIVE_THEMES,
  DEFAULT_CREATIVE_BLUEPRINT,
  parseCreativeBlueprint,
  normalizeTelemetryRows,
  evaluateQueryStats,
  resolveWidgetValue,
  evaluateRuleCondition,
  createCreativeStudioView,
};
