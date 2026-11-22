/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { SAFE_COLLECTION_RE } = require('./blocks-helpers');

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
};

function createRecordChatterView(client, React, app) {
  const h = React.createElement;
  const useApi = typeof client?.useAPIClient === 'function' ? client.useAPIClient : () => app?.apiClient || null;

  return function LatticeRecordChatterView({ targetCollection, targetRecordId, showExport = false, exportFields = null }) {
    const api = useApi();
    const [items, setItems] = React.useState([]);
    const [draftBody, setDraftBody] = React.useState('');
    const [statusNote, setStatusNote] = React.useState('');

    const validTarget = SAFE_COLLECTION_RE.test(String(targetCollection || '')) && Number(targetRecordId) > 0;

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
        const res = await api.request({
          url: 'dxosBlocks:exportReport',
          method: 'post',
          data: {
            collection: targetCollection,
            format,
            ...(Array.isArray(exportFields) && exportFields.length ? { fields: exportFields } : {}),
            ...(Number(targetRecordId) > 0 ? { filter: { id: Number(targetRecordId) } } : {}),
          },
        });
        const meta = res?.data?.data || res?.data || {};
        setStatusNote(`Xuất ${meta.filename || format.toUpperCase()} (${meta.rowCount ?? 0} dòng, SHA256 ${String(meta.sha256 || '').slice(0, 8)}).`);
      } catch (err) {
        setStatusNote(err?.response?.data?.errors?.[0]?.message || 'Không có quyền xuất trường đã chọn.');
      }
    };

    return h('div', {
      'data-testid': 'dxos-record-chatter',
      style: { padding: 14, borderRadius: 10, border: '1px solid #cbd5e1', background: '#ffffff', display: 'grid', gap: 10, color: '#0f172a' },
    },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
        h('div', { style: { fontWeight: 700, fontSize: 13 } }, `Nhật ký Chatter & Thay đổi (${targetCollection || 'record'}${targetRecordId ? `#${targetRecordId}` : ''})`),
        showExport ? h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
          ['csv', 'xlsx', 'pdf'].map((fmt) => h('button', {
            key: fmt,
            type: 'button',
            onClick: () => handleExport(fmt),
            style: { padding: '4px 10px', borderRadius: 6, border: '1px solid #94a3b8', background: '#f8fafc', fontSize: 11, fontWeight: 700, cursor: 'pointer' },
          }, fmt.toUpperCase())),
        ) : null,
      ),
      validTarget ? h('form', { onSubmit: handlePost, style: { display: 'flex', gap: 8, alignItems: 'center' } },
        h('input', {
          type: 'text',
          value: draftBody,
          onChange: (e) => setDraftBody(e.target.value),
          placeholder: 'Nhắn trao đổi, dùng @mã-nhân-viên để gắn thẻ…',
          style: { flex: 1, padding: '6px 10px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 12 },
        }),
        h('button', {
          type: 'submit',
          style: { padding: '6px 12px', borderRadius: 6, border: 'none', background: '#2563eb', color: '#ffffff', fontSize: 12, fontWeight: 700, cursor: 'pointer' },
        }, 'Gửi'),
      ) : null,
      statusNote ? h('div', { style: { fontSize: 11, color: '#2563eb' } }, statusNote) : null,
      !items.length
        ? h('div', { style: { fontSize: 12, color: '#64748b' } }, 'Chưa có ghi nhận Chatter nào.')
        : h('div', { style: { display: 'grid', gap: 8 } }, items.map((entry, idx) => h('div', {
            key: entry.id || idx,
            style: { padding: 8, borderRadius: 8, background: '#f8fafc', border: '1px solid #e2e8f0', fontSize: 12, display: 'grid', gap: 4 },
          },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#475569' } },
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

module.exports = {
  formatMentionSegments,
  createRecordChatterView,
};
