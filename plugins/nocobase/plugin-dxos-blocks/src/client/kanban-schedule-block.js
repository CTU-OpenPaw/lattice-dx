/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const KANBAN_STAGE_ORDER = ['draft', 'submitted', 'approved', 'in_progress', 'completed', 'cancelled'];
const STOCK_LOT_STAGE_ORDER = ['available', 'reserved', 'hold_mkt', 'expired'];
const ALLOWED_KANBAN_COLLECTIONS = new Set([
  'latticeOrders',
  'latticeRequests',
  'latticeServiceTickets',
  'latticeStockLots',
]);
const VOUCHER_COLLECTIONS = new Set(['latticeOrders', 'latticeRequests', 'latticeServiceTickets']);
const CANCELLABLE_STAGES = new Set(['submitted', 'approved', 'in_progress']);

const STAGE_META = {
  draft: { label: 'Nháp (draft)', color: '#475569', bg: '#f1f5f9', border: '#cbd5e1' },
  submitted: { label: 'Đã trình duyệt (submitted)', color: '#1d4ed8', bg: '#dbeafe', border: '#93c5fd' },
  approved: { label: 'Đã phê duyệt (approved)', color: '#166534', bg: '#dcfce7', border: '#86efac' },
  in_progress: { label: 'Đang xử lý (in_progress)', color: '#0369a1', bg: '#e0f2fe', border: '#7dd3fc' },
  completed: { label: 'Hoàn tất (completed)', color: '#065f46', bg: '#d1fae5', border: '#6ee7b7' },
  cancelled: { label: 'Đã hủy (cancelled)', color: '#991b1b', bg: '#fee2e2', border: '#fca5a5' },
  available: { label: 'Sẵn sàng (available)', color: '#065f46', bg: '#d1fae5', border: '#6ee7b7' },
  reserved: { label: 'Đã giữ chỗ (reserved)', color: '#1d4ed8', bg: '#dbeafe', border: '#93c5fd' },
  hold_mkt: { label: 'Tạm giữ MKT (hold_mkt)', color: '#92400e', bg: '#fef3c7', border: '#fcd34d' },
  expired: { label: 'Hết hạn (expired)', color: '#991b1b', bg: '#fee2e2', border: '#fca5a5' },
};

const WEEKDAY_LABELS = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];

function normalizeKanbanCollection(raw) {
  const clean = String(raw || '').trim();
  return ALLOWED_KANBAN_COLLECTIONS.has(clean) ? clean : 'latticeOrders';
}

function getStagesForCollection(collection) {
  return collection === 'latticeStockLots' ? STOCK_LOT_STAGE_ORDER.slice() : KANBAN_STAGE_ORDER.slice();
}

function resolveRecordStage(record, collection) {
  const rawStatus = String(record?.status || '').trim().toLowerCase();
  if (collection === 'latticeStockLots') {
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
  return KANBAN_STAGE_ORDER.includes(rawStatus) ? rawStatus : 'draft';
}

function groupRecordsByKanbanStage(records, collection = 'latticeOrders') {
  const targetCol = normalizeKanbanCollection(collection);
  const stages = getStagesForCollection(targetCol);
  const byStage = {};
  for (const st of stages) byStage[st] = [];

  for (const rec of Array.isArray(records) ? records : []) {
    if (!rec || typeof rec !== 'object') continue;
    const st = resolveRecordStage(rec, targetCol);
    if (!Object.hasOwn(byStage, st)) byStage[stages[0]].push(rec);
    else byStage[st].push(rec);
  }

  const columns = stages.map((st) => ({
    stage: st,
    ...(STAGE_META[st] || { label: st, color: '#334155', bg: '#f8fafc', border: '#cbd5e1' }),
    items: byStage[st],
  }));

  return { stages, columns, byStage };
}

function parseRecordScheduleDate(record) {
  const raw = record?.submittedAt || record?.expiryDate || record?.dueDate || record?.createdAt;
  if (!raw) return null;
  const ts = raw instanceof Date ? raw.getTime() : Date.parse(String(raw));
  if (!Number.isFinite(ts)) return null;
  return new Date(ts);
}

function toUtcDateKey(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getUtcMonday(referenceDate) {
  let base;
  if (referenceDate instanceof Date && Number.isFinite(referenceDate.getTime())) {
    base = new Date(Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth(), referenceDate.getUTCDate()));
  } else if (typeof referenceDate === 'string' && /^\d{4}-\d{2}-\d{2}/.test(referenceDate.trim())) {
    const [y, m, d] = referenceDate.trim().slice(0, 10).split('-').map(Number);
    base = new Date(Date.UTC(y, m - 1, d));
  } else {
    const now = new Date();
    base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }
  const day = base.getUTCDay();
  const diffToMon = day === 0 ? -6 : 1 - day;
  base.setUTCDate(base.getUTCDate() + diffToMon);
  return base;
}

function buildScheduleDaysGrid(records, referenceDate = new Date()) {
  const monday = getUtcMonday(referenceDate);
  const days = [];
  const dayMap = new Map();
  const todayKey = toUtcDateKey(new Date());

  for (let i = 0; i < 7; i += 1) {
    const dt = new Date(monday.getTime());
    dt.setUTCDate(monday.getUTCDate() + i);
    const dateKey = toUtcDateKey(dt);
    const weekday = WEEKDAY_LABELS[dt.getUTCDay()];
    const dayNum = String(dt.getUTCDate()).padStart(2, '0');
    const monthNum = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const entry = {
      dateKey,
      label: `${weekday} ${dayNum}/${monthNum}`,
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
    const dt = parseRecordScheduleDate(rec);
    if (!dt) {
      unscheduled.push(rec);
      continue;
    }
    const bucket = dayMap.get(toUtcDateKey(dt));
    if (bucket) bucket.items.push(rec);
  }

  return {
    weekStart: days[0].dateKey,
    weekEnd: days[6].dateKey,
    days,
    unscheduled,
  };
}

function resolveSlaBadge(rec) {
  const rawSla = String(rec?.slaStatus || '').trim().toLowerCase();
  if (rawSla === 'breached' || rawSla === 'critical') {
    return { level: 'breached', label: 'SLA Quá hạn', bg: '#fee2e2', color: '#991b1b', border: '#fca5a5' };
  }
  if (rawSla === 'warning') {
    return { level: 'warning', label: 'SLA Sắp hạn', bg: '#fef3c7', color: '#92400e', border: '#fcd34d' };
  }
  const dueRaw = rec?.dueDate || rec?.expiryDate;
  if (dueRaw) {
    const dueMs = Date.parse(String(dueRaw));
    const status = String(rec?.status || '').toLowerCase();
    if (Number.isFinite(dueMs) && !['completed', 'cancelled', 'depleted'].includes(status)) {
      const diffHours = (dueMs - Date.now()) / 3600000;
      if (diffHours < 0) return { level: 'breached', label: 'Quá hạn', bg: '#fee2e2', color: '#991b1b', border: '#fca5a5' };
      if (diffHours <= 48) return { level: 'warning', label: 'Sắp đến hạn', bg: '#fef3c7', color: '#92400e', border: '#fcd34d' };
    }
  }
  return null;
}

function formatDateChip(rec) {
  const dt = parseRecordScheduleDate(rec);
  if (!dt) return '';
  return toUtcDateKey(dt);
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
    const [loading, setLoading] = React.useState(false);
    const [busyId, setBusyId] = React.useState(null);
    const [cancelTargetId, setCancelTargetId] = React.useState(null);
    const [cancelReason, setCancelReason] = React.useState('');
    const [statusNote, setStatusNote] = React.useState('');

    React.useEffect(() => {
      setActiveCollection(configuredCollection);
    }, [configuredCollection]);

    React.useEffect(() => {
      setViewMode(configuredMode);
    }, [configuredMode]);

    const loadRecords = React.useCallback(async () => {
      if (!api?.request) return;
      setLoading(true);
      setStatusNote('');
      const limit = Math.max(5, Math.min(100, Number(cfg.pageSize) || 40));
      try {
        const res = await api.request({
          url: `${activeCollection}:list`,
          method: 'get',
          params: { pageSize: limit, sort: ['-id'] },
          skipNotify: true,
        });
        const rows = res?.data?.data ?? res?.data?.items ?? [];
        setRecords(Array.isArray(rows) ? rows : []);
      } catch {
        if (activeCollection === 'latticeStockLots') {
          try {
            const lotsRes = await api.request({
              url: 'dxosWms:lots',
              method: 'get',
              params: { limit },
              skipNotify: true,
            });
            const items = lotsRes?.data?.data?.items ?? lotsRes?.data?.items ?? [];
            setRecords(Array.isArray(items) ? items : []);
          } catch {
            setRecords([]);
            setStatusNote('Không tải được danh sách lô tồn kho.');
          }
        } else {
          setRecords([]);
          setStatusNote('Không tải được dữ liệu cho phân hệ đã chọn.');
        }
      } finally {
        setLoading(false);
      }
    }, [api, activeCollection, cfg.pageSize]);

    React.useEffect(() => {
      loadRecords();
    }, [loadRecords]);

    const filteredRecords = React.useMemo(() => {
      const q = String(searchQuery || '').trim().toLowerCase();
      if (!q) return records;
      return records.filter((rec) => {
        const hay = `${rec.code || ''} ${rec.lotCode || ''} ${rec.name || ''} ${rec.title || ''} ${rec.productName || ''} ${rec.sku || ''} ${rec.customer || ''}`.toLowerCase();
        return hay.includes(q);
      });
    }, [records, searchQuery]);

    const kanbanData = React.useMemo(
      () => groupRecordsByKanbanStage(filteredRecords, activeCollection),
      [filteredRecords, activeCollection],
    );

    const scheduleRefDate = React.useMemo(() => {
      const mon = getUtcMonday(new Date());
      mon.setUTCDate(mon.getUTCDate() + weekOffset * 7);
      return mon;
    }, [weekOffset]);

    const scheduleGrid = React.useMemo(
      () => buildScheduleDaysGrid(filteredRecords, scheduleRefDate),
      [filteredRecords, scheduleRefDate],
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
      setBusyId(rec.id);
      try {
        setStatusNote(action === 'submit' ? `Đang trình duyệt ${rec.code || `#${rec.id}`}…` : `Đang hủy ${rec.code || `#${rec.id}`}…`);
        await api.request({
          url: `latticeVoucher:${action}`,
          method: 'post',
          data: {
            collection: activeCollection,
            id: Number(rec.id),
            ...(rec.version != null ? { expectedVersion: rec.version } : {}),
            ...(action === 'cancel' ? { cancelReason: String(cancelReason).trim() } : {}),
          },
        });
        setCancelTargetId(null);
        setCancelReason('');
        setStatusNote(action === 'submit' ? 'Đã trình duyệt chứng từ.' : 'Đã hủy chứng từ.');
        await loadRecords();
      } catch (err) {
        setStatusNote(err?.response?.data?.errors?.[0]?.message || 'Không thực hiện được chuyển trạng thái.');
      } finally {
        setBusyId(null);
      }
    };

    const collectionOptions = [
      { value: 'latticeOrders', label: 'Đơn Logistics (latticeOrders)' },
      { value: 'latticeRequests', label: 'Yêu cầu mua sắm (latticeRequests)' },
      { value: 'latticeServiceTickets', label: 'Phiếu dịch vụ (latticeServiceTickets)' },
      { value: 'latticeStockLots', label: 'Lô kho lạnh (latticeStockLots)' },
    ];

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

    return h('section', {
      'data-testid': 'dxos-kanban-schedule-block',
      style: {
        padding: 16,
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
          h('strong', { style: { fontSize: 15, color: '#0f172a' } }, String(cfg.title || 'Bảng Kanban & Lịch [H]')),
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
            onClick: loadRecords,
            disabled: loading,
            style: { padding: '4px 10px', borderRadius: 6, border: '1px solid #cbd5e1', background: '#f8fafc', fontSize: 12, fontWeight: 600, cursor: 'pointer' },
          }, loading ? 'Đang tải…' : 'Làm mới'),
        ),
      ),
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' } },
        h('select', {
          'aria-label': 'Chọn phân hệ Kanban',
          value: activeCollection,
          onChange: (e) => { setActiveCollection(normalizeKanbanCollection(e.target.value)); setCancelTargetId(null); },
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
      statusNote ? h('div', { style: { fontSize: 11, color: '#1d4ed8' } }, statusNote) : null,
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
              style: {
                borderRadius: 10,
                border: `1px solid ${col.border}`,
                background: '#f8fafc',
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
                    const sla = resolveSlaBadge(rec);
                    const dateChip = formatDateChip(rec);
                    const code = rec.code || rec.lotCode || `#${rec.id ?? idx}`;
                    const name = rec.name || rec.title || rec.productName || 'Bản ghi';
                    const st = resolveRecordStage(rec, activeCollection);
                    return h('div', {
                      key: rec.id ?? code,
                      style: {
                        padding: 8,
                        borderRadius: 8,
                        background: '#ffffff',
                        border: sla ? `1px solid ${sla.border}` : '1px solid #e2e8f0',
                        display: 'grid',
                        gap: 4,
                      },
                    },
                      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 4 } },
                        h('strong', { style: { fontSize: 12, color: '#0f172a' } }, String(code)),
                        sla ? h('span', { style: { fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 999, background: sla.bg, color: sla.color } }, sla.label) : null,
                      ),
                      h('div', { style: { fontSize: 12, color: '#334155', wordBreak: 'break-word' } }, String(name)),
                      dateChip ? h('div', { style: { fontSize: 10, color: '#64748b' } }, `Ngày: ${dateChip}`) : null,
                      isVoucherCol && st === 'draft' ? h('button', {
                        type: 'button',
                        'data-testid': `dxos-kanban-submit-${rec.id}`,
                        disabled: busyId === rec.id,
                        onClick: () => runVoucherStageAction(rec, 'submit'),
                        style: {
                          marginTop: 2, padding: '3px 8px', borderRadius: 6, border: 'none',
                          background: '#2563eb', color: '#ffffff', fontSize: 11, fontWeight: 700, cursor: 'pointer',
                        },
                      }, 'Trình duyệt') : null,
                      isVoucherCol && CANCELLABLE_STAGES.has(st) ? (
                        cancelTargetId === rec.id
                          ? h('div', { style: { display: 'grid', gap: 4, marginTop: 2 } },
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
                                  onClick: () => runVoucherStageAction(rec, 'cancel'),
                                  style: { padding: '2px 8px', borderRadius: 4, border: 'none', background: '#dc2626', color: '#fff', fontSize: 11, fontWeight: 700, cursor: 'pointer' },
                                }, 'Xác nhận hủy'),
                                h('button', {
                                  type: 'button',
                                  onClick: () => { setCancelTargetId(null); setCancelReason(''); },
                                  style: { padding: '2px 8px', borderRadius: 4, border: '1px solid #cbd5e1', background: '#fff', fontSize: 11, cursor: 'pointer' },
                                }, 'Đóng'),
                              ),
                            )
                          : h('button', {
                              type: 'button',
                              'data-testid': `dxos-kanban-cancel-${rec.id}`,
                              onClick: () => { setCancelTargetId(rec.id); setCancelReason(''); },
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
                      const sla = resolveSlaBadge(rec);
                      const st = resolveRecordStage(rec, activeCollection);
                      const meta = STAGE_META[st] || { bg: '#f1f5f9', color: '#334155' };
                      return h('div', {
                        key: rec.id ?? idx,
                        style: { padding: 6, borderRadius: 6, background: '#ffffff', border: '1px solid #e2e8f0', fontSize: 11, display: 'grid', gap: 2 },
                      },
                        h('strong', null, String(rec.code || rec.lotCode || `#${rec.id}`)),
                        h('div', { style: { color: '#475569' } }, String(rec.name || rec.title || rec.productName || '')),
                        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4 } },
                          h('span', { style: { fontSize: 10, padding: '1px 5px', borderRadius: 999, background: meta.bg, color: meta.color, fontWeight: 700 } }, st),
                          sla ? h('span', { style: { fontSize: 10, padding: '1px 5px', borderRadius: 999, background: sla.bg, color: sla.color, fontWeight: 700 } }, sla.label) : null,
                        ),
                      );
                    }),
              )),
            ),
          ),
    );
  };
}

module.exports = {
  KANBAN_STAGE_ORDER,
  STOCK_LOT_STAGE_ORDER,
  groupRecordsByKanbanStage,
  buildScheduleDaysGrid,
  createKanbanScheduleBlockView,
};
