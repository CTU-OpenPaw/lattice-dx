/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { SAFE_COLLECTION_RE, requestAndDownloadExport } = require('./blocks-helpers');

const VOUCHER_COLLECTIONS = new Set(['latticeRequests', 'latticeOrders', 'latticeServiceTickets']);
const CANCELLABLE_STATUSES = new Set(['submitted', 'approved', 'in_progress']);
const VOUCHER_STATUS_META = {
  draft: { label: 'Nháp (draft)', bg: '#f1f5f9', color: '#334155', border: '#cbd5e1' },
  submitted: { label: 'Đã trình duyệt (submitted)', bg: '#dbeafe', color: '#1d4ed8', border: '#93c5fd' },
  approved: { label: 'Đã phê duyệt (approved)', bg: '#dcfce7', color: '#166534', border: '#86efac' },
  in_progress: { label: 'Đang xử lý (in_progress)', bg: '#e0f2fe', color: '#0369a1', border: '#7dd3fc' },
  completed: { label: 'Hoàn tất (completed)', bg: '#d1fae5', color: '#065f46', border: '#6ee7b7' },
  cancelled: { label: 'Đã hủy (cancelled)', bg: '#fee2e2', color: '#991b1b', border: '#fca5a5' },
};

function formatMentionSegments(body) {
  const raw = String(body || '');
  if (!raw) return [];
  const re = /(^|[\s(])(@[a-zA-Z0-9._-]{2,64})/g;
  const segments = [];
  let lastIndex = 0;
  for (const match of raw.matchAll(re)) {
    const lead = match[1] || '';
    const token = match[2] || '';
    const tokenStart = match.index + lead.length;
    if (tokenStart > lastIndex) {
      segments.push({ type: 'text', text: raw.slice(lastIndex, tokenStart) });
    }
    segments.push({ type: 'mention', text: token, handle: token.slice(1).toLowerCase() });
    lastIndex = tokenStart + token.length;
  }
  if (lastIndex < raw.length) {
    segments.push({ type: 'text', text: raw.slice(lastIndex) });
  }
  return segments;
}

const ENTRY_TYPE_LABELS = {
  comment: 'Bình luận',
  field_diff: 'Thay đổi trường',
  lifecycle: 'Vòng đời chứng từ',
  sla_escalation: 'Cảnh báo SLA',
};

function createRecordChatterView(client, React, app) {
  const h = React.createElement;
  const useApi = typeof client?.useAPIClient === 'function' ? client.useAPIClient : () => app?.apiClient || null;

  return function LatticeRecordChatterView({ targetCollection, targetRecordId, showExport = false, exportFields = null }) {
    const api = useApi();
    const [items, setItems] = React.useState([]);
    const [typeFilter, setTypeFilter] = React.useState('all');
    const [draftBody, setDraftBody] = React.useState('');
    const [statusNote, setStatusNote] = React.useState('');

    const validTarget = SAFE_COLLECTION_RE.test(String(targetCollection || '')) && Number(targetRecordId) > 0;
    const visibleItems = typeFilter === 'all'
      ? items
      : items.filter((entry) => String(entry?.entryType || 'comment') === typeFilter);

    const loadEntries = React.useCallback(async () => {
      if (!api?.request || !validTarget) return;
      try {
        const res = await api.request({
          url: 'latticeChatter:list',
          method: 'get',
          params: { targetCollection, targetRecordId: Number(targetRecordId), limit: 50 },
          skipNotify: true,
        });
        const list = res?.data?.data?.items || res?.data?.items || [];
        setItems(Array.isArray(list) ? list : []);
      } catch {
        // Degrade without wiping existing timeline
      }
    }, [api, targetCollection, targetRecordId, validTarget]);

    React.useEffect(() => {
      loadEntries();
    }, [loadEntries]);

    const handlePost = async (e) => {
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
      const text = String(draftBody || '').trim();
      if (!api?.request || !validTarget || !text) return;
      try {
        setStatusNote('Đang gửi ghi chú…');
        await api.request({
          url: 'latticeChatter:post',
          method: 'post',
          data: { targetCollection, targetRecordId: Number(targetRecordId), body: text },
        });
        setDraftBody('');
        setStatusNote('Đã ghi nhận vào Chatter.');
        await loadEntries();
      } catch (err) {
        setStatusNote(err?.response?.data?.errors?.[0]?.message || 'Không gửi được ghi chú Chatter.');
      }
    };

    const handleExport = async (format) => {
      if (!api?.request || !SAFE_COLLECTION_RE.test(String(targetCollection || ''))) return;
      try {
        setStatusNote(`Đang xuất báo cáo ${format.toUpperCase()}…`);
        const { meta, download } = await requestAndDownloadExport(api, {
          collection: targetCollection,
          format,
          fields: exportFields,
          filter: Number(targetRecordId) > 0 ? { id: Number(targetRecordId) } : null,
        });
        const downloadNote = download?.downloaded ? ' · Đã tải xuống' : '';
        setStatusNote(`Xuất ${meta.filename || format.toUpperCase()} (${meta.rowCount ?? 0} dòng, SHA256 ${String(meta.sha256 || '').slice(0, 8)})${downloadNote}.`);
      } catch (err) {
        setStatusNote(err?.response?.data?.errors?.[0]?.message || 'Không có quyền xuất trường đã chọn.');
      }
    };

    return h('div', {
      'data-testid': 'dxos-record-chatter',
      style: { padding: 14, borderRadius: 10, border: '1px solid #cbd5e1', background: '#ffffff', display: 'grid', gap: 10, color: '#0f172a', minWidth: 0, maxWidth: '100%' },
    },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
        h('div', { style: { fontWeight: 700, fontSize: 13, minWidth: 0, wordBreak: 'break-word' } }, `Nhật ký Chatter & Thay đổi (${targetCollection || 'record'}${targetRecordId ? `#${targetRecordId}` : ''})`),
        h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
          h('select', {
            'aria-label': 'Lọc nhật ký Chatter',
            value: typeFilter,
            onChange: (e) => setTypeFilter(e.target.value),
            style: { padding: '4px 8px', borderRadius: 6, border: '1px solid #cbd5e1', background: '#fff', color: '#0f172a', fontSize: 11 },
          },
            h('option', { value: 'all' }, 'Lọc: Tất cả'),
            h('option', { value: 'comment' }, 'Bình luận'),
            h('option', { value: 'field_diff' }, 'Thay đổi trường'),
            h('option', { value: 'lifecycle' }, 'Vòng đời chứng từ'),
          ),
          validTarget ? h('button', {
            type: 'button',
            onClick: () => loadEntries(),
            style: { padding: '4px 10px', borderRadius: 6, border: '1px solid #cbd5e1', background: '#fff', color: '#0f172a', fontSize: 11, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' },
          }, 'Làm mới') : null,
          showExport ? ['csv', 'xlsx', 'pdf'].map((fmt) => h('button', {
            key: fmt,
            type: 'button',
            onClick: () => handleExport(fmt),
            style: { padding: '4px 10px', borderRadius: 6, border: '1px solid #94a3b8', background: '#f8fafc', fontSize: 11, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' },
          }, fmt.toUpperCase())) : null,
        ),
      ),
      validTarget ? h('form', { onSubmit: handlePost, style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' } },
        h('input', {
          type: 'text',
          value: draftBody,
          onChange: (e) => setDraftBody(e.target.value),
          placeholder: 'Nhắn trao đổi, dùng @mã-nhân-viên để gắn thẻ…',
          style: { flex: '1 1 180px', minWidth: 0, maxWidth: '100%', padding: '6px 10px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 12 },
        }),
        h('button', {
          type: 'submit',
          style: { padding: '6px 12px', borderRadius: 6, border: 'none', background: '#2563eb', color: '#ffffff', fontSize: 12, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0 },
        }, 'Gửi'),
      ) : null,
      statusNote ? h('div', { style: { fontSize: 11, color: '#2563eb' } }, statusNote) : null,
      !visibleItems.length
        ? h('div', { style: { fontSize: 12, color: '#64748b' } }, 'Chưa có ghi nhận Chatter nào.')
        : h('div', { style: { display: 'grid', gap: 8 } }, visibleItems.map((entry, idx) => h('div', {
            key: entry.id || idx,
            style: { padding: 8, borderRadius: 8, background: '#f8fafc', border: '1px solid #e2e8f0', fontSize: 12, display: 'grid', gap: 4, minWidth: 0 },
          },
            h('div', { style: { display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 4, fontSize: 11, color: '#475569' } },
              h('strong', null, `${entry.authorName || 'system'} · ${ENTRY_TYPE_LABELS[entry.entryType] || entry.entryType || 'Ghi chú'}`),
              h('span', null, String(entry.createdAt || '')),
            ),
            h('div', null, formatMentionSegments(entry.body).map((seg, sIdx) => (
              seg.type === 'mention'
                ? h('strong', { key: sIdx, style: { color: '#1d4ed8', background: '#dbeafe', padding: '0 4px', borderRadius: 4 } }, seg.text)
                : h('span', { key: sIdx }, seg.text)
            ))),
            Array.isArray(entry.diffJson) && entry.diffJson.length
              ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4 } }, entry.diffJson.map((d, dIdx) => h('span', {
                  key: dIdx,
                  style: { fontSize: 11, padding: '2px 6px', borderRadius: 4, background: '#fef3c7', color: '#92400e' },
                }, `${d.field}: ${d.before ?? '∅'} -> ${d.after ?? '∅'}`)))
              : null,
          ))),
    );
  };
}

function createVoucherLifecycleBar(client, React, app) {
  const h = React.createElement;
  const useApi = typeof client?.useAPIClient === 'function' ? client.useAPIClient : () => app?.apiClient || null;

  return function LatticeVoucherLifecycleBar({
    targetCollection,
    targetRecordId,
    recordStatus = '',
    recordVersion = null,
    amendmentNo = 0,
    amendedFromId = null,
    onUpdated,
  }) {
    const api = useApi();
    const validTarget = VOUCHER_COLLECTIONS.has(String(targetCollection || '')) && Number(targetRecordId) > 0;
    const [info, setInfo] = React.useState({
      status: String(recordStatus || ''),
      version: recordVersion ?? null,
      amendmentNo: Number(amendmentNo) || 0,
      amendedFromId: amendedFromId ?? null,
      lineage: [],
    });
    const [reasonText, setReasonText] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [statusNote, setStatusNote] = React.useState('');

    React.useEffect(() => {
      setInfo({
        status: String(recordStatus || ''),
        version: recordVersion ?? null,
        amendmentNo: Number(amendmentNo) || 0,
        amendedFromId: amendedFromId ?? null,
        lineage: [],
      });
      setReasonText('');
      setStatusNote('');
    }, [targetCollection, targetRecordId]);

    React.useEffect(() => {
      setInfo((prev) => ({
        ...prev,
        ...(recordStatus ? { status: String(recordStatus) } : {}),
        ...(recordVersion != null ? { version: recordVersion } : {}),
        ...(Number(amendmentNo) > 0 ? { amendmentNo: Number(amendmentNo) } : {}),
        ...(amendedFromId != null ? { amendedFromId } : {}),
      }));
    }, [recordStatus, recordVersion, amendmentNo, amendedFromId]);

    const loadVoucherState = React.useCallback(async (isCancelled = () => false) => {
      if (!api?.request || !validTarget) return;
      const recId = Number(targetRecordId);
      try {
        const res = await api.request({
          url: 'latticeVoucher:lineage',
          method: 'get',
          params: { collection: targetCollection, id: recId },
          skipNotify: true,
        });
        if (isCancelled()) return;
        const payload = res?.data?.data || res?.data || {};
        const items = Array.isArray(payload.items) ? payload.items : [];
        const current = items.find((it) => Number(it?.id) === recId);
        setInfo({
          status: current?.status != null ? String(current.status) : String(recordStatus || ''),
          version: current?.version ?? null,
          amendmentNo: Number(current?.amendmentNo) || 0,
          amendedFromId: current?.amendedFromId ?? null,
          lineage: items,
        });
        return;
      } catch {
        // Fallback to single record fetch when lineage endpoint unavailable for collection
      }
      if (isCancelled()) return;
      try {
        const recRes = await api.request({
          url: `${targetCollection}:get`,
          method: 'get',
          params: { filterByTk: recId },
          skipNotify: true,
        });
        if (isCancelled()) return;
        const rec = recRes?.data?.data || recRes?.data || null;
        if (rec && typeof rec === 'object') {
          setInfo({
            status: rec.status != null ? String(rec.status) : '',
            version: rec.version ?? null,
            amendmentNo: Number(rec.amendmentNo) || 0,
            amendedFromId: rec.amendedFromId ?? null,
            lineage: [],
          });
        }
      } catch {}
    }, [api, targetCollection, targetRecordId, validTarget, recordStatus]);

    React.useEffect(() => {
      let cancelled = false;
      loadVoucherState(() => cancelled);
      return () => { cancelled = true; };
    }, [loadVoucherState]);

    if (!validTarget) return null;

    const curStatus = String(info.status || '').toLowerCase();
    const statusBadge = VOUCHER_STATUS_META[curStatus] || {
      label: curStatus || 'Chưa tải trạng thái',
      bg: '#f8fafc',
      color: '#475569',
      border: '#cbd5e1',
    };

    const runAction = async (action) => {
      if (!api?.request || busy) return;
      const recId = Number(targetRecordId);
      const trimmedReason = String(reasonText || '').trim();
      if (action === 'cancel' && (trimmedReason.length < 3 || trimmedReason.length > 255)) {
        setStatusNote('Cần nhập lý do hủy chứng từ từ 3 đến 255 ký tự.');
        return;
      }
      setBusy(true);
      try {
        const actionLabel = action === 'submit' ? 'trình duyệt' : action === 'cancel' ? 'hủy chứng từ' : 'lập bản điều chỉnh';
        setStatusNote(`Đang ${actionLabel}…`);
        const payload = {
          collection: targetCollection,
          id: recId,
          ...(action !== 'amend' && info.version != null ? { expectedVersion: info.version } : {}),
          ...(action === 'cancel' ? { cancelReason: trimmedReason } : {}),
          ...(action === 'amend' && trimmedReason ? { patch: { description: trimmedReason } } : {}),
        };
        const res = await api.request({
          url: `latticeVoucher:${action}`,
          method: 'post',
          data: payload,
        });
        const updated = res?.data?.data || res?.data || {};
        if (action === 'cancel' || action === 'amend') setReasonText('');
        if (action === 'amend') {
          setStatusNote(`Đã lập bản điều chỉnh ${updated.code || `#${updated.id || ''}`} (Lần #${updated.amendmentNo || 1}).`);
        } else {
          setStatusNote(`Đã cập nhật trạng thái: ${updated.status || action}.`);
        }
        await loadVoucherState();
        if (typeof onUpdated === 'function') onUpdated(updated);
      } catch (err) {
        setStatusNote(err?.response?.data?.errors?.[0]?.message || err?.message || 'Không thực hiện được thao tác chứng từ.');
      } finally {
        setBusy(false);
      }
    };

    const canSubmit = !curStatus || curStatus === 'draft';
    const canCancel = !curStatus || CANCELLABLE_STATUSES.has(curStatus);
    const canAmend = !curStatus || curStatus === 'cancelled';

    const btnStyle = (enabled, accentColor) => ({
      padding: '5px 10px',
      borderRadius: 6,
      border: `1px solid ${enabled ? accentColor : '#cbd5e1'}`,
      background: enabled ? accentColor : '#f1f5f9',
      color: enabled ? '#ffffff' : '#94a3b8',
      fontSize: 12,
      fontWeight: 700,
      cursor: enabled && !busy ? 'pointer' : 'not-allowed',
      whiteSpace: 'nowrap',
      minWidth: 0,
      textAlign: 'center',
    });

    return h('div', {
      'data-testid': 'dxos-voucher-lifecycle-bar',
      style: {
        padding: 12,
        borderRadius: 10,
        border: '1px solid #cbd5e1',
        background: '#f8fafc',
        display: 'grid',
        gap: 8,
        color: '#0f172a',
        minWidth: 0,
        maxWidth: '100%',
      },
    },
      h('div', { style: { display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 8 } },
        h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, minWidth: 0 } },
          h('strong', { style: { fontSize: 12, minWidth: 0 } }, `Vòng đời chứng từ (${targetCollection} #${targetRecordId})`),
          h('span', {
            'data-testid': 'dxos-voucher-status-badge',
            style: {
              fontSize: 11,
              fontWeight: 700,
              padding: '2px 8px',
              borderRadius: 999,
              background: statusBadge.bg,
              color: statusBadge.color,
              border: `1px solid ${statusBadge.border}`,
              whiteSpace: 'nowrap',
            },
          }, statusBadge.label),
        ),
        h('span', {
          'data-testid': 'dxos-voucher-lineage',
          style: { fontSize: 11, color: '#475569' },
        }, info.amendmentNo > 0 || info.amendedFromId != null
          ? `Điều chỉnh #${info.amendmentNo}${info.amendedFromId != null ? ` (từ #${info.amendedFromId})` : ''}`
          : 'Chứng từ gốc'),
      ),
      info.lineage.length > 1 ? h('div', { style: { fontSize: 11, color: '#475569', display: 'flex', flexWrap: 'wrap', gap: 4 } },
        'Chuỗi phiên bản: ',
        info.lineage.map((it) => `${it.code || `#${it.id}`} [${it.status || '?'}]`).join(' → '),
      ) : null,
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' } },
        h('input', {
          'data-testid': 'dxos-voucher-reason-input',
          type: 'text',
          value: reasonText,
          onChange: (e) => setReasonText(e.target.value),
          placeholder: 'Lý do hủy / ghi chú điều chỉnh (3-255 ký tự)…',
          style: { flex: '1 1 200px', minWidth: 0, maxWidth: '100%', padding: '5px 10px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 12, background: '#ffffff' },
        }),
        h('div', {
          style: {
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(135px, 1fr))',
            gap: 6,
            flex: '1 1 280px',
            minWidth: 0,
          },
        },
          h('button', {
            type: 'button',
            'data-testid': 'dxos-voucher-submit-btn',
            disabled: busy || !canSubmit,
            onClick: () => runAction('submit'),
            style: btnStyle(canSubmit, '#2563eb'),
          }, 'Trình duyệt'),
          h('button', {
            type: 'button',
            'data-testid': 'dxos-voucher-cancel-btn',
            disabled: busy || !canCancel,
            onClick: () => runAction('cancel'),
            style: btnStyle(canCancel, '#dc2626'),
          }, 'Hủy chứng từ'),
          h('button', {
            type: 'button',
            'data-testid': 'dxos-voucher-amend-btn',
            disabled: busy || !canAmend,
            onClick: () => runAction('amend'),
            style: btnStyle(canAmend, '#0f766e'),
          }, 'Lập bản điều chỉnh'),
        ),
      ),
      statusNote ? h('div', { style: { fontSize: 11, color: '#1d4ed8' } }, statusNote) : null,
    );
  };
}

module.exports = {
  VOUCHER_COLLECTIONS,
  formatMentionSegments,
  createRecordChatterView,
  createVoucherLifecycleBar,
};
