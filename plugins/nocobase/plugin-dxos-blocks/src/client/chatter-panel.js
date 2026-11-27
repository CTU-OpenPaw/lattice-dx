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
  requestAndDownloadExport,
  getStatusMeta,
  formatStatusLabel,
  createCompactIdBadge,
} = require('./blocks-helpers');

const VOUCHER_COLLECTIONS = new Set(['latticeRequests', 'latticeOrders', 'latticeServiceTickets']);
const BLOCKED_COLLECTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const CANCELLABLE_STATUSES = new Set(['submitted', 'approved', 'in_progress']);
const PRINTABLE_ORDER_DOCUMENT_TYPES = new Set(['order', 'delivery_note', 'epod']);
const VOUCHER_STATUS_META = {
  draft: getStatusMeta('draft'),
  submitted: getStatusMeta('submitted'),
  approved: getStatusMeta('approved'),
  in_progress: getStatusMeta('in_progress'),
  completed: getStatusMeta('completed'),
  cancelled: getStatusMeta('cancelled'),
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

const CHATTER_VN_DT_FMT = typeof Intl !== 'undefined' && typeof Intl.DateTimeFormat === 'function'
  ? new Intl.DateTimeFormat('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  : null;

function formatChatterTimestamp(raw) {
  if (!raw) return '';
  const ts = Date.parse(String(raw));
  if (!Number.isFinite(ts) || !CHATTER_VN_DT_FMT) return String(raw);
  return CHATTER_VN_DT_FMT.format(new Date(ts));
}

function createRecordChatterView(client, React, app) {
  const h = React.createElement;
  const useApi = typeof client?.useAPIClient === 'function' ? client.useAPIClient : () => app?.apiClient || null;

  return function LatticeRecordChatterView({ targetCollection, targetRecordId, showExport = false, exportFields = null }) {
    const api = useApi();
    const [items, setItems] = React.useState([]);
    const [typeFilter, setTypeFilter] = React.useState('all');
    const [draftBody, setDraftBody] = React.useState('');
    const [statusNote, setStatusNote] = React.useState('');
    const [loadError, setLoadError] = React.useState('');
    const [loading, setLoading] = React.useState(false);

    const validTarget = SAFE_COLLECTION_RE.test(String(targetCollection || '')) && Number(targetRecordId) > 0;
    const visibleItems = typeFilter === 'all'
      ? items
      : items.filter((entry) => String(entry?.entryType || 'comment') === typeFilter);

    const loadEntries = React.useCallback(async () => {
      if (!api?.request || !validTarget) return;
      setLoading(true);
      setLoadError('');
      try {
        const res = await api.request({
          url: 'latticeChatter:list',
          method: 'get',
          params: { targetCollection, targetRecordId: Number(targetRecordId), limit: 50 },
          skipNotify: true,
        });
        const list = res?.data?.data?.items || res?.data?.items || [];
        setItems(Array.isArray(list) ? list : []);
      } catch (err) {
        setLoadError(
          err?.response?.data?.errors?.[0]?.message
          || err?.response?.data?.message
          || err?.message
          || 'Không tải được nhật ký Chatter.',
        );
      } finally {
        setLoading(false);
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
      loadError ? h('div', {
        'data-testid': 'dxos-chatter-load-error',
        role: 'alert',
        style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 6, background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', fontSize: 12 },
      },
        h('span', null, loadError),
        h('button', {
          type: 'button',
          'data-testid': 'dxos-chatter-retry-btn',
          onClick: () => loadEntries(),
          style: { padding: '3px 10px', borderRadius: 6, border: '1px solid #dc2626', background: '#ffffff', color: '#dc2626', fontSize: 11, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' },
        }, 'Thử lại'),
      ) : null,
      loading && !visibleItems.length ? h('div', { style: { fontSize: 12, color: '#64748b' } }, 'Đang tải nhật ký Chatter…') : null,
      !loading && !loadError && !visibleItems.length
        ? h('div', { style: { fontSize: 12, color: '#64748b' } }, 'Chưa có ghi nhận Chatter nào.')
        : (visibleItems.length ? h('div', { style: { display: 'grid', gap: 8 } }, visibleItems.map((entry, idx) => h('div', {
            key: entry.id || idx,
            style: { padding: 8, borderRadius: 8, background: '#f8fafc', border: '1px solid #e2e8f0', fontSize: 12, display: 'grid', gap: 4, minWidth: 0 },
          },
            h('div', { style: { display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 4, fontSize: 11, color: '#475569' } },
              h('strong', null, `${entry.authorName || 'system'} · ${ENTRY_TYPE_LABELS[entry.entryType] || entry.entryType || 'Ghi chú'}`),
              h('span', null, formatChatterTimestamp(entry.createdAt)),
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
          ))) : null),
    );
  };
}

function createVoucherLifecycleBar(client, React, app) {
  const h = React.createElement;
  const useApi = typeof client?.useAPIClient === 'function' ? client.useAPIClient : () => app?.apiClient || null;
  const useRecord = typeof client?.useRecord === 'function' ? client.useRecord : () => null;

  return function LatticeVoucherLifecycleBar({
    targetCollection,
    targetRecordId,
    recordStatus = '',
    recordVersion = null,
    amendmentNo = 0,
    amendedFromId = null,
    organizationId = '',
    record = null,
    showPkiBadge = true,
    showLineage = true,
    showPrintVoucher = true,
    showVoucherActions = true,
    printDocumentType = 'order',
    onUpdated,
  }) {
    const api = useApi();
    const ctxRecord = useRecord();
    const propOrg = String(organizationId || record?.organizationId || ctxRecord?.organizationId || '').trim();
    const colName = String(targetCollection || '').trim();
    const numericRecordId = Number(targetRecordId);
    const validRecordTarget = SAFE_COLLECTION_RE.test(colName)
      && !BLOCKED_COLLECTION_KEYS.has(colName)
      && Number.isInteger(numericRecordId)
      && numericRecordId > 0;
    const validVoucherTarget = showVoucherActions !== false && VOUCHER_COLLECTIONS.has(colName) && validRecordTarget;
    const [info, setInfo] = React.useState({
      status: String(recordStatus || ''),
      version: recordVersion ?? null,
      amendmentNo: Number(amendmentNo) || 0,
      amendedFromId: amendedFromId ?? null,
      organizationId: propOrg,
      lineage: [],
    });
    const [reasonText, setReasonText] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [statusNote, setStatusNote] = React.useState(null);
    const currentTargetKey = `${String(targetCollection || '')}:${Number(targetRecordId) || 0}`;
    const [reqTracker] = React.useState(() => ({
      pkiEntriesSeq: 0,
      pkiVerifySeq: 0,
      pkiVerifying: false,
      lineageSeq: 0,
      printSeq: 0,
      unmounted: false,
    }));
    const [printFrameHolder] = React.useState(() => ({ el: null }));
    const [pkiState, setPkiState] = React.useState({
      targetKey: currentTargetKey,
      loading: false,
      entry: null,
      total: 0,
      verifyResult: null,
      error: null,
    });
    const [lineageState, setLineageState] = React.useState({
      targetKey: currentTargetKey,
      open: false,
      loading: false,
      nodes: [],
      edges: [],
      truncated: false,
      error: null,
    });
    const [printDocType, setPrintDocType] = React.useState(
      PRINTABLE_ORDER_DOCUMENT_TYPES.has(printDocumentType) ? printDocumentType : 'order',
    );
    const [printState, setPrintState] = React.useState({
      targetKey: currentTargetKey,
      open: false,
      loading: false,
      html: null,
      htmlSha256: null,
      qrVerificationHash: null,
      ledgerSeq: null,
      keyId: null,
      documentType: null,
      error: null,
    });

    const effectivePrintDocType = PRINTABLE_ORDER_DOCUMENT_TYPES.has(printDocType) ? printDocType : 'order';
    const canPrintOrder = showPrintVoucher !== false
      && targetCollection === 'latticeOrders'
      && PRINTABLE_ORDER_DOCUMENT_TYPES.has(effectivePrintDocType);

    React.useEffect(() => {
      reqTracker.unmounted = false;
      return () => {
        reqTracker.unmounted = true;
        reqTracker.pkiEntriesSeq += 1;
        reqTracker.pkiVerifySeq += 1;
        reqTracker.pkiVerifying = false;
        reqTracker.lineageSeq += 1;
        reqTracker.printSeq += 1;
      };
    }, [reqTracker]);

    React.useEffect(() => {
      if (PRINTABLE_ORDER_DOCUMENT_TYPES.has(printDocumentType)) {
        setPrintDocType((prev) => (prev === printDocumentType ? prev : printDocumentType));
      }
    }, [printDocumentType]);

    React.useEffect(() => {
      reqTracker.pkiEntriesSeq += 1;
      reqTracker.pkiVerifySeq += 1;
      reqTracker.pkiVerifying = false;
      reqTracker.lineageSeq += 1;
      reqTracker.printSeq += 1;
      setInfo({
        status: String(recordStatus || ''),
        version: recordVersion ?? null,
        amendmentNo: Number(amendmentNo) || 0,
        amendedFromId: amendedFromId ?? null,
        organizationId: propOrg,
        lineage: [],
      });
      setReasonText('');
      setStatusNote(null);
      setPkiState({ targetKey: currentTargetKey, loading: false, entry: null, total: 0, verifyResult: null, error: null });
      setLineageState({ targetKey: currentTargetKey, open: false, loading: false, nodes: [], edges: [], truncated: false, error: null });
      setPrintState({
        targetKey: currentTargetKey,
        open: false,
        loading: false,
        html: null,
        htmlSha256: null,
        qrVerificationHash: null,
        ledgerSeq: null,
        keyId: null,
        documentType: null,
        error: null,
      });
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

    const recordOrg = String(propOrg || info.organizationId || '').trim();

    const loadPkiEntries = React.useCallback(async (isCancelled = () => false) => {
      if (!api?.request || !validRecordTarget || showPkiBadge === false) return;
      const reqKey = currentTargetKey;
      const recId = String(Number(targetRecordId));
      const myEntriesSeq = ++reqTracker.pkiEntriesSeq;
      const verifySeqAtStart = reqTracker.pkiVerifySeq;
      const isStale = () => (
        reqTracker.unmounted
        || reqTracker.pkiEntriesSeq !== myEntriesSeq
        || (typeof isCancelled === 'function' && isCancelled())
      );
      try {
        const res = await api.request({
          url: 'dxosLedger:entries',
          method: 'get',
          params: {
            targetCollection,
            targetRecordId: recId,
            pageSize: 5,
            ...(recordOrg ? { organizationId: recordOrg } : {}),
          },
          skipNotify: true,
        });
        if (isStale()) return;
        const payload = res?.data?.data || res?.data || {};
        const items = Array.isArray(payload.items) ? payload.items : [];
        setPkiState((prev) => {
          if (prev.targetKey && prev.targetKey !== reqKey) return prev;
          const verifyActiveOrRan = reqTracker.pkiVerifying || reqTracker.pkiVerifySeq !== verifySeqAtStart;
          return {
            ...prev,
            loading: verifyActiveOrRan ? prev.loading : false,
            entry: items[0] || null,
            total: Number(payload.total) || items.length,
            error: verifyActiveOrRan ? prev.error : null,
          };
        });
      } catch {
        if (!isStale()) {
          setPkiState((prev) => {
            if (prev.targetKey && prev.targetKey !== reqKey) return prev;
            if (reqTracker.pkiVerifying || reqTracker.pkiVerifySeq !== verifySeqAtStart) return prev;
            return { ...prev, loading: false };
          });
        }
      }
    }, [api, targetCollection, targetRecordId, validRecordTarget, showPkiBadge, currentTargetKey, reqTracker, recordOrg]);

    const loadVoucherState = React.useCallback(async (isCancelled = () => false) => {
      if (!api?.request || !validRecordTarget) return;
      const recId = Number(targetRecordId);
      if (validVoucherTarget) {
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
          const resolvedOrg = String(current?.organizationId || items[0]?.organizationId || propOrg || '').trim();
          setInfo({
            status: current?.status != null ? String(current.status) : String(recordStatus || ''),
            version: current?.version ?? null,
            amendmentNo: Number(current?.amendmentNo) || 0,
            amendedFromId: current?.amendedFromId ?? null,
            organizationId: resolvedOrg,
            lineage: items,
          });
          return;
        } catch {
          // Fallback to single record fetch when lineage endpoint unavailable for collection
        }
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
            status: rec.status != null ? String(rec.status) : String(recordStatus || ''),
            version: rec.version ?? null,
            amendmentNo: Number(rec.amendmentNo) || 0,
            amendedFromId: rec.amendedFromId ?? null,
            organizationId: String(rec.organizationId || propOrg || '').trim(),
            lineage: [],
          });
        }
      } catch {}
    }, [api, targetCollection, targetRecordId, validRecordTarget, validVoucherTarget, recordStatus, propOrg]);

    React.useEffect(() => {
      let cancelled = false;
      loadVoucherState(() => cancelled);
      loadPkiEntries(() => cancelled);
      return () => { cancelled = true; };
    }, [loadVoucherState, loadPkiEntries]);

    const showGovernanceRow = showPkiBadge !== false || showLineage !== false || canPrintOrder;
    if (!validRecordTarget || (!validVoucherTarget && !showGovernanceRow)) return null;

    const handleVerifyPki = async () => {
      if (!api?.request || pkiState.loading || reqTracker.pkiVerifying) return;
      const reqKey = currentTargetKey;
      const myVerifySeq = ++reqTracker.pkiVerifySeq;
      reqTracker.pkiVerifying = true;
      const isStale = () => reqTracker.unmounted || reqTracker.pkiVerifySeq !== myVerifySeq;
      setPkiState((prev) => ({ ...prev, targetKey: reqKey, loading: true, error: null }));
      try {
        const res = await api.request({
          url: 'dxosLedger:verify',
          method: 'get',
          ...(recordOrg ? { params: { organizationId: recordOrg } } : {}),
          skipNotify: true,
        });
        if (isStale()) return;
        reqTracker.pkiVerifying = false;
        const payload = res?.data?.data || res?.data || {};
        setPkiState((prev) => (prev.targetKey && prev.targetKey !== reqKey ? prev : {
          ...prev,
          loading: false,
          verifyResult: {
            valid: Boolean(payload.valid),
            checkedCount: Number(payload.checkedCount) || 0,
            brokenAtSeq: payload.brokenAtSeq ?? null,
          },
          error: null,
        }));
      } catch (err) {
        if (isStale()) return;
        reqTracker.pkiVerifying = false;
        setPkiState((prev) => (prev.targetKey && prev.targetKey !== reqKey ? prev : {
          ...prev,
          loading: false,
          error: err?.response?.data?.errors?.[0]?.message || 'Không xác minh được chuỗi Merkle PKI.',
        }));
      }
    };

    const handleToggleLineage = async () => {
      if (lineageState.open) {
        setLineageState((prev) => ({ ...prev, open: false }));
        return;
      }
      const reqKey = currentTargetKey;
      if (!api?.request) {
        setLineageState((prev) => ({ ...prev, targetKey: reqKey, open: true, error: 'Chưa kết nối API tra cứu phả hệ.' }));
        return;
      }
      const myLineageSeq = ++reqTracker.lineageSeq;
      const isStale = () => reqTracker.unmounted || reqTracker.lineageSeq !== myLineageSeq;
      setLineageState((prev) => ({ ...prev, targetKey: reqKey, open: true, loading: true, error: null }));
      try {
        let effectiveOrg = recordOrg;
        if (!effectiveOrg) {
          try {
            const recRes = await api.request({
              url: `${targetCollection}:get`,
              method: 'get',
              params: { filterByTk: Number(targetRecordId) },
              skipNotify: true,
            });
            if (isStale()) return;
            const rec = recRes?.data?.data || recRes?.data || null;
            effectiveOrg = String(rec?.organizationId || '').trim();
          } catch {}
        }
        const res = await api.request({
          url: 'dxosDataGov:lineageTrace',
          method: 'get',
          params: {
            collection: targetCollection,
            recordId: String(Number(targetRecordId)),
            maxDepth: 3,
            direction: 'both',
            ...(effectiveOrg ? { organizationId: effectiveOrg } : {}),
          },
          skipNotify: true,
        });
        if (isStale()) return;
        const payload = res?.data?.data || res?.data || {};
        setLineageState((prev) => (prev.targetKey && prev.targetKey !== reqKey ? prev : {
          targetKey: reqKey,
          open: true,
          loading: false,
          nodes: Array.isArray(payload.nodes) ? payload.nodes : [],
          edges: Array.isArray(payload.edges) ? payload.edges : [],
          truncated: Boolean(payload.truncated),
          error: null,
        }));
      } catch (err) {
        if (isStale()) return;
        setLineageState((prev) => (prev.targetKey && prev.targetKey !== reqKey ? prev : {
          targetKey: reqKey,
          open: true,
          loading: false,
          nodes: [],
          edges: [],
          truncated: false,
          error: err?.response?.data?.errors?.[0]?.message || 'Không tải được đồ thị phả hệ dữ liệu.',
        }));
      }
    };

    const handlePrintVoucher = async () => {
      if (!api?.request || printState.loading || !canPrintOrder) return;
      const reqKey = currentTargetKey;
      const myPrintSeq = ++reqTracker.printSeq;
      const isStale = () => reqTracker.unmounted || reqTracker.printSeq !== myPrintSeq;
      setPrintState((prev) => ({ ...prev, targetKey: reqKey, loading: true, error: null }));
      try {
        const res = await api.request({
          url: 'dxosWms:printVoucher',
          method: 'get',
          params: { documentType: effectivePrintDocType, orderId: Number(targetRecordId) },
          skipNotify: true,
        });
        if (isStale()) return;
        const payload = res?.data?.data || res?.data || {};
        if (!payload.html) {
          setPrintState((prev) => (prev.targetKey && prev.targetKey !== reqKey ? prev : {
            targetKey: reqKey,
            open: false,
            loading: false,
            html: null,
            htmlSha256: null,
            qrVerificationHash: null,
            ledgerSeq: null,
            keyId: null,
            documentType: null,
            error: 'Không nhận được nội dung HTML chứng từ hợp lệ.',
          }));
          return;
        }
        setPrintState((prev) => (prev.targetKey && prev.targetKey !== reqKey ? prev : {
          targetKey: reqKey,
          open: true,
          loading: false,
          html: String(payload.html),
          htmlSha256: payload.htmlSha256 || null,
          qrVerificationHash: payload.qrVerificationHash || null,
          ledgerSeq: payload.ledgerSeq ?? null,
          keyId: payload.keyId || null,
          documentType: payload.documentType || effectivePrintDocType,
          error: null,
        }));
      } catch (err) {
        if (isStale()) return;
        setPrintState((prev) => (prev.targetKey && prev.targetKey !== reqKey ? prev : {
          targetKey: reqKey,
          open: false,
          loading: false,
          html: null,
          htmlSha256: null,
          qrVerificationHash: null,
          ledgerSeq: null,
          keyId: null,
          documentType: null,
          error: err?.response?.data?.errors?.[0]?.message || err?.message || 'Không có quyền hoặc chưa sẵn sàng bản in chứng từ.',
        }));
      }
    };

    const cloneSafePrintNode = (srcNode, doc) => {
      if (!srcNode || !doc) return null;
      if (srcNode.nodeType === 3) {
        return doc.createTextNode(String(srcNode.textContent || ''));
      }
      if (srcNode.nodeType !== 1) return null;
      const rawTag = String(srcNode.tagName || '').toLowerCase();
      if (!rawTag || ['script', 'iframe', 'object', 'embed', 'link', 'meta', 'base'].includes(rawTag)) {
        return null;
      }
      const isSvg = srcNode.namespaceURI === 'http://www.w3.org/2000/svg'
        || ['svg', 'path', 'rect', 'circle', 'line', 'polyline', 'polygon', 'g', 'text', 'defs', 'use'].includes(rawTag);
      const el = isSvg && typeof doc.createElementNS === 'function'
        ? doc.createElementNS('http://www.w3.org/2000/svg', rawTag)
        : doc.createElement(rawTag);
      const attrs = Array.from(srcNode.attributes || []);
      for (const attr of attrs) {
        const attrName = String(attr?.name || '');
        const lowerName = attrName.toLowerCase();
        const attrVal = String(attr?.value ?? '');
        if (!attrName || lowerName.startsWith('on') || lowerName === 'srcdoc') continue;
        if ((lowerName === 'href' || lowerName === 'src' || lowerName === 'xlink:href')
          && /^\s*(javascript|vbscript|data\s*:\s*text\/html)/i.test(attrVal)) {
          continue;
        }
        el.setAttribute(attrName, attrVal);
      }
      if (rawTag === 'style') {
        const cssText = String(srcNode.textContent || '').replace(/<\/style/gi, '').replace(/@import/gi, '/*blocked*/');
        el.appendChild(doc.createTextNode(cssText));
        return el;
      }
      for (const child of Array.from(srcNode.childNodes || [])) {
        const cloned = cloneSafePrintNode(child, doc);
        if (cloned) el.appendChild(cloned);
      }
      return el;
    };

    const triggerBrowserPrint = () => {
      if (
        printState.html
        && typeof DOMParser === 'function'
        && typeof document !== 'undefined'
        && typeof document.createElement === 'function'
        && document.body
        && typeof document.body.appendChild === 'function'
        && document.head
        && typeof document.head.appendChild === 'function'
        && typeof window !== 'undefined'
        && typeof window.print === 'function'
      ) {
        try {
          const prevRoot = document.getElementById?.('dxos-isolated-print-root');
          prevRoot?.remove?.();
          const prevStyle = document.getElementById?.('dxos-isolated-print-style');
          prevStyle?.remove?.();

          const parsed = new DOMParser().parseFromString(String(printState.html), 'text/html');
          const printStyle = document.createElement('style');
          printStyle.setAttribute('id', 'dxos-isolated-print-style');
          printStyle.textContent = [
            '@media screen { #dxos-isolated-print-root { display: none !important; } }',
            '@media print {',
            '  body > *:not(#dxos-isolated-print-root) { display: none !important; }',
            '  #dxos-isolated-print-root { display: block !important; position: static !important; margin: 0 !important; padding: 0 !important; background: #ffffff !important; }',
            '}',
          ].join('\n');

          const printRoot = document.createElement('div');
          printRoot.setAttribute('id', 'dxos-isolated-print-root');
          for (const headChild of Array.from(parsed?.head?.childNodes || [])) {
            if (String(headChild?.tagName || '').toLowerCase() === 'style') {
              const clonedStyle = cloneSafePrintNode(headChild, document);
              if (clonedStyle) printRoot.appendChild(clonedStyle);
            }
          }
          for (const bodyChild of Array.from(parsed?.body?.childNodes || [])) {
            const clonedNode = cloneSafePrintNode(bodyChild, document);
            if (clonedNode) printRoot.appendChild(clonedNode);
          }

          document.head.appendChild(printStyle);
          document.body.appendChild(printRoot);

          const cleanup = () => {
            try { printRoot.remove?.(); } catch {}
            try { printStyle.remove?.(); } catch {}
            if (typeof window.removeEventListener === 'function') {
              window.removeEventListener('afterprint', cleanup);
            }
          };
          if (typeof window.addEventListener === 'function') {
            window.addEventListener('afterprint', cleanup);
          }
          window.print();
          return;
        } catch {}
      }

      try {
        const frame = printFrameHolder.el
          || (typeof document !== 'undefined' && typeof document.querySelector === 'function'
            ? (document.querySelector(`iframe[data-print-target="${currentTargetKey}"]`)
              || document.querySelector('iframe[title="Chứng từ In DX-OS"]'))
            : null);
        if (frame?.contentWindow && typeof frame.contentWindow.print === 'function') {
          frame.contentWindow.print();
          return;
        }
      } catch {}
      try {
        if (typeof window !== 'undefined' && typeof window.print === 'function') {
          window.print();
        }
      } catch {}
    };

    const curStatus = String(info.status || '').toLowerCase();
    const statusBadge = VOUCHER_STATUS_META[curStatus] || (
      curStatus
        ? getStatusMeta(curStatus)
        : { label: 'Chưa tải trạng thái', bg: '#f8fafc', color: '#475569', border: '#cbd5e1' }
    );

    const runAction = async (action) => {
      if (!api?.request || busy || !validVoucherTarget) return;
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
        if (reqTracker.unmounted) return;
        const updated = res?.data?.data || res?.data || {};
        if (action === 'cancel' || action === 'amend') setReasonText('');
        if (action === 'amend') {
          setStatusNote(`Đã lập bản điều chỉnh ${updated.code || `#${updated.id || ''}`} (Lần #${updated.amendmentNo || 1}).`);
        } else {
          setStatusNote(`Đã cập nhật trạng thái: ${formatStatusLabel(updated.status || action)}.`);
        }
        await loadVoucherState();
        await loadPkiEntries();
        if (!reqTracker.unmounted && typeof onUpdated === 'function') onUpdated(updated);
      } catch (err) {
        if (!reqTracker.unmounted) {
          setStatusNote(err?.response?.data?.errors?.[0]?.message || err?.message || 'Không thực hiện được thao tác chứng từ.');
        }
      } finally {
        if (!reqTracker.unmounted) setBusy(false);
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
          h('strong', { style: { fontSize: 12, minWidth: 0 } },
            validVoucherTarget
              ? `Vòng đời chứng từ (${targetCollection} #${targetRecordId})`
              : `Xác thực & Phả hệ bản ghi (${targetCollection} #${targetRecordId})`,
          ),
          (validVoucherTarget || curStatus) ? h('span', {
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
          }, statusBadge.label) : null,
        ),
        validVoucherTarget ? h('span', {
          'data-testid': 'dxos-voucher-lineage',
          style: { fontSize: 11, color: '#475569' },
        }, info.amendmentNo > 0 || info.amendedFromId != null
          ? `Điều chỉnh #${info.amendmentNo}${info.amendedFromId != null ? ` (từ #${info.amendedFromId})` : ''}`
          : 'Chứng từ gốc') : null,
      ),
      validVoucherTarget && info.lineage.length > 1 ? h('div', { style: { fontSize: 11, color: '#475569', display: 'flex', flexWrap: 'wrap', gap: 4 } },
        'Chuỗi phiên bản: ',
        info.lineage.map((it) => `${it.code || `#${it.id}`} [${formatStatusLabel(it.status, '?')}]`).join(' → '),
      ) : null,
      validVoucherTarget ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' } },
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
      ) : null,
      statusNote ? h('div', { style: { fontSize: 11, color: '#1d4ed8' } }, statusNote) : null,
      showGovernanceRow ? h('div', {
        style: {
          paddingTop: 8,
          borderTop: '1px dashed #cbd5e1',
          display: 'grid',
          gap: 8,
        },
      },
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'space-between' } },
          showPkiBadge !== false ? h('div', {
            'data-testid': 'dxos-workbench-pki-badge',
            style: {
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: 6,
              padding: '4px 8px',
              borderRadius: 8,
              border: '1px solid #cbd5e1',
              background: '#ffffff',
              fontSize: 11,
            },
          },
            h('strong', { style: { color: '#0f172a' } }, 'Ed25519 PKI:'),
            pkiState.entry
              ? h('span', { style: { display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, color: '#334155' } },
                  `Seq #${pkiState.entry.seq} · ${pkiState.entry.keyId || 'key'}`,
                  pkiState.entry.entryHash ? createCompactIdBadge(React, pkiState.entry.entryHash, { prefixLen: 12 }) : null,
                )
              : h('span', { style: { color: '#64748b' } }, 'Chưa có bút ký sổ cái'),
            h('button', {
              type: 'button',
              'data-testid': 'dxos-workbench-pki-verify-btn',
              disabled: pkiState.loading,
              onClick: handleVerifyPki,
              style: {
                padding: '2px 8px',
                borderRadius: 6,
                border: '1px solid #0284c7',
                background: '#f0f9ff',
                color: '#0369a1',
                fontSize: 11,
                fontWeight: 700,
                cursor: 'pointer',
              },
            }, pkiState.loading ? 'Đang kiểm…' : 'Xác minh PKI'),
            pkiState.verifyResult ? h('span', {
              style: {
                fontWeight: 700,
                color: pkiState.verifyResult.valid ? '#166534' : '#991b1b',
                background: pkiState.verifyResult.valid ? '#dcfce7' : '#fee2e2',
                padding: '1px 6px',
                borderRadius: 999,
              },
            }, pkiState.verifyResult.valid
              ? `Hợp lệ (${pkiState.verifyResult.checkedCount} mục)`
              : `Sai lệch tại seq #${pkiState.verifyResult.brokenAtSeq ?? '?'}`) : null,
            pkiState.error ? h('span', { style: { color: '#b91c1c' } }, pkiState.error) : null,
          ) : null,
          canPrintOrder ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' } },
            h('select', {
              'aria-label': 'Loại chứng từ in',
              value: printDocType,
              onChange: (e) => setPrintDocType(e.target.value),
              style: { padding: '4px 6px', borderRadius: 6, border: '1px solid #cbd5e1', background: '#ffffff', fontSize: 11 },
            },
              h('option', { value: 'order' }, 'Đơn hàng'),
              h('option', { value: 'delivery_note' }, 'Phiếu giao hàng'),
              h('option', { value: 'epod' }, 'Chứng thư ePOD'),
            ),
            h('button', {
              type: 'button',
              'data-testid': 'dxos-workbench-print-voucher-btn',
              disabled: printState.loading,
              onClick: handlePrintVoucher,
              style: {
                padding: '4px 10px',
                borderRadius: 6,
                border: '1px solid #334155',
                background: '#0f172a',
                color: '#ffffff',
                fontSize: 11,
                fontWeight: 700,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              },
            }, printState.loading ? 'Đang tạo bản in…' : 'In chứng từ'),
          ) : null,
        ),
        printState.error ? h('div', { style: { fontSize: 11, color: '#b91c1c', background: '#fee2e2', padding: '4px 8px', borderRadius: 6 } }, printState.error) : null,
        printState.open && printState.html ? h('div', {
          'data-testid': 'dxos-workbench-print-modal',
          style: {
            padding: 10,
            borderRadius: 8,
            border: '1px solid #94a3b8',
            background: '#ffffff',
            display: 'grid',
            gap: 8,
          },
        },
          h('div', { style: { display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 6, fontSize: 11 } },
            h('div', null,
              h('strong', null, 'Bản xem trước chứng từ In DX-OS'),
              printState.htmlSha256 ? h('span', { style: { marginLeft: 8, color: '#475569' } }, `SHA-256: ${String(printState.htmlSha256).slice(0, 16)}…`) : null,
              printState.keyId ? h('span', { style: { marginLeft: 8, color: '#0369a1' } }, `PKI: ${printState.keyId}${printState.ledgerSeq != null ? ` #${printState.ledgerSeq}` : ''}`) : null,
            ),
            h('div', { style: { display: 'flex', gap: 6 } },
              h('button', {
                type: 'button',
                'data-testid': 'dxos-workbench-print-browser-btn',
                onClick: triggerBrowserPrint,
                style: { padding: '3px 8px', borderRadius: 6, border: '1px solid #2563eb', background: '#eff6ff', color: '#1d4ed8', fontSize: 11, fontWeight: 700, cursor: 'pointer' },
              }, 'In / Lưu PDF'),
              h('button', {
                type: 'button',
                onClick: () => setPrintState((prev) => ({ ...prev, open: false })),
                style: { padding: '3px 8px', borderRadius: 6, border: '1px solid #cbd5e1', background: '#f8fafc', fontSize: 11, cursor: 'pointer' },
              }, 'Đóng'),
            ),
          ),
          h('iframe', {
            ref: (el) => { printFrameHolder.el = el || null; },
            sandbox: '',
            title: 'Chứng từ In DX-OS',
            'data-print-target': currentTargetKey,
            srcDoc: String(printState.html),
            style: { width: '100%', height: 320, border: '1px solid #cbd5e1', borderRadius: 6, background: '#ffffff' },
          }),
        ) : null,
        showLineage !== false ? h('div', {
          'data-testid': 'dxos-workbench-lineage-panel',
          style: { display: 'grid', gap: 6 },
        },
          h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 } },
            h('button', {
              type: 'button',
              'data-testid': 'dxos-workbench-lineage-btn',
              onClick: handleToggleLineage,
              style: {
                padding: '4px 10px',
                borderRadius: 6,
                border: '1px solid #6366f1',
                background: lineageState.open ? '#6366f1' : '#eef2ff',
                color: lineageState.open ? '#ffffff' : '#4338ca',
                fontSize: 11,
                fontWeight: 700,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              },
            }, lineageState.open ? 'Ẩn Phả hệ (Lineage)' : 'Xem Phả hệ (Lineage)'),
          ),
          lineageState.open ? h('div', {
            style: {
              padding: 8,
              borderRadius: 8,
              border: '1px solid #c7d2fe',
              background: '#ffffff',
              fontSize: 11,
              display: 'grid',
              gap: 4,
            },
          },
            lineageState.loading ? h('div', { style: { color: '#64748b' } }, 'Đang truy vết phả hệ dữ liệu…') : null,
            lineageState.error ? h('div', { style: { color: '#b91c1c' } }, lineageState.error) : null,
            !lineageState.loading && !lineageState.error ? h('div', null,
              h('div', { style: { fontWeight: 700, color: '#312e81', marginBottom: 4 } },
                `Nút: ${lineageState.nodes.length} · Quan hệ: ${lineageState.edges.length}${lineageState.truncated ? ' (đã giới hạn)' : ''}`,
              ),
              lineageState.edges.length
                ? lineageState.edges.map((edge, idx) => h('div', {
                    key: edge.edgeUid || idx,
                    style: { padding: '3px 6px', borderRadius: 4, background: '#f8fafc', border: '1px solid #e2e8f0', marginBottom: 3 },
                  }, `${edge.sourceCollection}#${edge.sourceRecordId} —[${edge.relationType}]→ ${edge.targetCollection}#${edge.targetRecordId}`))
                : h('div', { style: { color: '#64748b' } }, 'Chưa có liên kết phả hệ thượng nguồn / hạ nguồn.'),
            ) : null,
          ) : null,
        ) : null,
      ) : null,
    );
  };
}

module.exports = {
  VOUCHER_COLLECTIONS,
  formatMentionSegments,
  createRecordChatterView,
  createVoucherLifecycleBar,
};
