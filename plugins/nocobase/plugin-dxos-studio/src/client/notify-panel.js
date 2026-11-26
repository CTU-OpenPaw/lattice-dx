/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const CHANNEL_META = Object.freeze([
  { id: 'smtp', label: 'Email (SMTP)', targetLabel: 'Email người nhận (To)', placeholder: 'ops@example.com', field: 'to' },
  { id: 'telegram', label: 'Telegram Bot', targetLabel: 'Chat ID', placeholder: '-1001234567890', field: 'chatId' },
  { id: 'slack', label: 'Slack', targetLabel: 'Kênh Slack (#channel hoặc ID)', placeholder: '#coldchain-alerts', field: 'slackChannel' },
  { id: 'webhook', label: 'Partner Webhook', targetLabel: 'URL đích (HTTPS)', placeholder: 'https://hooks.example.com/notify', field: 'url' },
]);

const LOG_PAGE_SIZE = 20;

function extractErrorMsg(err, fallback) {
  return err?.response?.data?.errors?.[0]?.message
    || err?.response?.data?.message
    || err?.message
    || fallback;
}

function createNotifyPanel(client, React, _antd, app) {
  const h = React.createElement;
  const useApi = typeof client?.useAPIClient === 'function' ? client.useAPIClient : () => app?.apiClient || null;

  const S = {
    stack: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 14, minWidth: 0, maxWidth: '100%' },
    card: {
      padding: 18,
      borderRadius: 12,
      border: '1px solid #e2e8f0',
      background: '#fff',
      display: 'grid',
      gridTemplateColumns: 'minmax(0, 1fr)',
      gap: 12,
      minWidth: 0,
      maxWidth: '100%',
    },
    subCard: {
      padding: 12,
      borderRadius: 8,
      border: '1px solid #e2e8f0',
      background: '#f8fafc',
      display: 'grid',
      gridTemplateColumns: 'minmax(0, 1fr)',
      gap: 6,
      minWidth: 0,
    },
    gridCards: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 10, minWidth: 0 },
    input: { width: '100%', padding: '7px 10px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 12, boxSizing: 'border-box', minWidth: 0 },
    tableWrap: { width: '100%', overflowX: 'auto', minWidth: 0 },
    table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
    th: { textAlign: 'left', padding: '8px 10px', borderBottom: '1px solid #cbd5e1', background: '#f8fafc', fontWeight: 600, whiteSpace: 'nowrap' },
    td: { padding: '8px 10px', borderBottom: '1px solid #e2e8f0', verticalAlign: 'top' },
    btn: (primary = false, disabled = false) => ({
      padding: '7px 12px',
      borderRadius: 7,
      fontSize: 12,
      fontWeight: 600,
      cursor: disabled ? 'not-allowed' : 'pointer',
      border: disabled ? '1px solid #cbd5e1' : primary ? '1px solid #1677ff' : '1px solid #cbd5e1',
      background: disabled ? '#e2e8f0' : primary ? '#1677ff' : '#ffffff',
      color: disabled ? '#94a3b8' : primary ? '#ffffff' : '#1e293b',
    }),
  };

  return function NotifyPanel(props) {
    const api = props.api || useApi();
    const organizationId = String(props.selectedOrg || props.organizationId || '').trim();
    const openRoute = typeof props.openRoute === 'function' ? props.openRoute : () => {};
    const setFeedback = typeof props.setFeedback === 'function' ? props.setFeedback : () => {};

    const [channelsData, setChannelsData] = React.useState({ supportedChannels: ['smtp', 'telegram', 'slack', 'webhook'], items: [] });
    const [logsData, setLogsData] = React.useState({ total: 0, items: [] });
    const [loading, setLoading] = React.useState(false);
    const [sending, setSending] = React.useState(false);
    const [channel, setChannel] = React.useState('smtp');
    const [connectorKey, setConnectorKey] = React.useState('');
    const [target, setTarget] = React.useState('');
    const [title, setTitle] = React.useState('Kiểm tra thông báo DX-OS');
    const [body, setBody] = React.useState('Thông điệp kiểm tra kênh Omnichannel từ Control Studio.');
    const [dryRun, setDryRun] = React.useState(true);
    const [lastResult, setLastResult] = React.useState(null);
    const [logChannelFilter, setLogChannelFilter] = React.useState('');
    const [logStatusFilter, setLogStatusFilter] = React.useState('');
    const [logDryRunFilter, setLogDryRunFilter] = React.useState('all');
    const [page, setPage] = React.useState(1);
    const [expandedLogId, setExpandedLogId] = React.useState(null);

    const loadChannels = React.useCallback(async () => {
      if (!api?.request || !organizationId) return;
      try {
        const res = await api.request({
          url: 'dxosNotify:channels',
          method: 'get',
          params: { organizationId },
          skipNotify: true,
        });
        const d = res?.data?.data || res?.data || {};
        setChannelsData({
          supportedChannels: Array.isArray(d.supportedChannels) ? d.supportedChannels : ['smtp', 'telegram', 'slack', 'webhook'],
          items: Array.isArray(d.items) ? d.items : [],
        });
      } catch (err) {
        setFeedback({ type: 'error', text: extractErrorMsg(err, 'Không tải được danh sách kênh thông báo.') });
      }
    }, [api, organizationId]);

    const loadLogs = React.useCallback(async (targetPage = page) => {
      if (!api?.request || !organizationId) return;
      setLoading(true);
      try {
        const params = {
          organizationId,
          ...(logChannelFilter ? { channel: logChannelFilter } : {}),
          ...(logStatusFilter ? { status: logStatusFilter } : {}),
          ...(logDryRunFilter !== 'all' ? { dryRun: logDryRunFilter === 'true' } : {}),
          limit: LOG_PAGE_SIZE,
          offset: Math.max(0, (targetPage - 1) * LOG_PAGE_SIZE),
        };
        const res = await api.request({
          url: 'dxosNotify:logs',
          method: 'get',
          params,
          skipNotify: true,
        });
        const d = res?.data?.data || res?.data || {};
        setLogsData({
          total: Number(d.total || 0),
          items: Array.isArray(d.items) ? d.items : [],
        });
      } catch (err) {
        setFeedback({ type: 'error', text: extractErrorMsg(err, 'Không tải được nhật ký gửi thông báo.') });
      } finally {
        setLoading(false);
      }
    }, [api, organizationId, logChannelFilter, logStatusFilter, logDryRunFilter, page]);

    React.useEffect(() => {
      if (!organizationId) return;
      loadChannels();
    }, [organizationId, loadChannels]);

    React.useEffect(() => {
      if (!organizationId) return;
      loadLogs(page);
    }, [organizationId, loadLogs, page]);

    async function handleTestSend(e) {
      e?.preventDefault?.();
      if (!api?.request || sending || !organizationId) return;
      const meta = CHANNEL_META.find((m) => m.id === channel) || CHANNEL_META[0];
      setSending(true);
      setFeedback(null);
      try {
        const cleanTarget = String(target || '').trim();
        const payload = {
          organizationId,
          channel,
          ...(connectorKey ? { connectorKey } : {}),
          ...(cleanTarget ? { [meta.field]: cleanTarget, target: cleanTarget } : {}),
          title: String(title || '').trim(),
          body: String(body || '').trim(),
          dryRun: Boolean(dryRun),
        };
        const res = await api.request({
          url: 'dxosNotify:testSend',
          method: 'post',
          data: payload,
        });
        const d = res?.data?.data || res?.data || {};
        setLastResult(d);
        setFeedback({
          type: d.ok === false ? 'error' : 'success',
          text: d.ok === false
            ? `Gửi thử thất bại (${d.errorCode || d.status}): ${d.errorMessage || 'Lỗi không xác định'}`
            : `Đã gửi thử qua ${d.channel || channel} (${d.status || 'ok'}) · Mã: ${d.deliveryUid || ''}.`,
        });
        setPage(1);
        await loadLogs(1);
      } catch (err) {
        setFeedback({ type: 'error', text: extractErrorMsg(err, 'Không gửi thử được thông báo.') });
      } finally {
        setSending(false);
      }
    }

    const activeMeta = CHANNEL_META.find((m) => m.id === channel) || CHANNEL_META[0];
    const channelConnectors = (channelsData.items || []).filter((c) => c.channel === channel);
    const totalPages = Math.max(1, Math.ceil((logsData.total || 0) / LOG_PAGE_SIZE));

    return h('div', { 'data-testid': 'dxos-studio-notify-panel', style: S.stack },
      h('div', { style: S.card },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('div', null,
            h('h3', { style: { margin: 0, fontSize: 16 } }, 'Kênh Thông báo Đa kênh (Omnichannel Vault)'),
            h('p', { style: { margin: '4px 0 0', fontSize: 12, color: '#64748b' } }, 'Theo dõi kết nối SMTP, Telegram, Slack, Webhook và kiểm tra gửi thử an toàn từ Control Studio.'),
          ),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            h('button', { type: 'button', disabled: loading || !organizationId, onClick: () => { loadChannels(); loadLogs(page); }, style: S.btn(false, loading || !organizationId) }, 'Làm mới'),
            h('button', { type: 'button', onClick: () => openRoute('/admin/settings/workflow/connectors'), style: S.btn(false) }, 'Cấu hình Connector ↗'),
          ),
        ),
        h('div', { 'data-testid': 'dxos-notify-channels', style: S.gridCards },
          CHANNEL_META.map((ch) => {
            const matched = (channelsData.items || []).filter((item) => item.channel === ch.id);
            const activeCount = matched.filter((m) => m.active !== false).length;
            return h('div', { key: ch.id, 'data-testid': `dxos-notify-channel-card-${ch.id}`, style: S.subCard },
              h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 } },
                h('strong', { style: { fontSize: 13 } }, ch.label),
                h('span', {
                  style: {
                    fontSize: 11,
                    fontWeight: 600,
                    padding: '2px 7px',
                    borderRadius: 999,
                    background: activeCount > 0 ? '#dcfce7' : '#f1f5f9',
                    color: activeCount > 0 ? '#166534' : '#64748b',
                  },
                }, activeCount > 0 ? `${activeCount} kết nối bật` : 'Chưa cấu hình'),
              ),
              matched.length > 0
                ? matched.map((m) => h('div', { key: m.connectorKey, style: { fontSize: 11, color: '#334155' } },
                    `${m.name || m.connectorKey} (${m.connectorKey}) · ${m.authType || 'vault'}`,
                  ))
                : h('div', { style: { fontSize: 11, color: '#64748b' } }, 'Chưa có Vault connector đang bật cho kênh này.'),
            );
          }),
        ),
      ),

      h('form', { 'data-testid': 'dxos-notify-test-form', onSubmit: handleTestSend, style: S.card },
        h('h4', { style: { margin: 0, fontSize: 14 } }, 'Gửi thử Thông báo (dxosNotify:testSend)'),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10, minWidth: 0 } },
          h('div', null,
            h('label', { style: { display: 'block', fontSize: 11, fontWeight: 600, marginBottom: 4 } }, 'Kênh gửi'),
            h('select', {
              'data-testid': 'dxos-notify-channel-select',
              value: channel,
              onChange: (e) => { setChannel(e.target.value); setConnectorKey(''); },
              style: S.input,
            }, CHANNEL_META.map((ch) => h('option', { key: ch.id, value: ch.id }, ch.label))),
          ),
          h('div', null,
            h('label', { style: { display: 'block', fontSize: 11, fontWeight: 600, marginBottom: 4 } }, 'Connector (tùy chọn)'),
            h('select', {
              'data-testid': 'dxos-notify-connector-select',
              value: connectorKey,
              onChange: (e) => setConnectorKey(e.target.value),
              style: S.input,
            },
              h('option', { value: '' }, '-- Tự chọn connector đang bật --'),
              channelConnectors.map((c) => h('option', { key: c.connectorKey, value: c.connectorKey }, `${c.name || c.connectorKey} (${c.connectorKey})`)),
            ),
          ),
          h('div', null,
            h('label', { style: { display: 'block', fontSize: 11, fontWeight: 600, marginBottom: 4 } }, activeMeta.targetLabel),
            h('input', {
              'data-testid': 'dxos-notify-target-input',
              type: 'text',
              value: target,
              onChange: (e) => setTarget(e.target.value),
              placeholder: activeMeta.placeholder,
              style: S.input,
            }),
          ),
        ),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10, minWidth: 0 } },
          h('div', null,
            h('label', { style: { display: 'block', fontSize: 11, fontWeight: 600, marginBottom: 4 } }, 'Tiêu đề'),
            h('input', {
              'data-testid': 'dxos-notify-title-input',
              type: 'text',
              value: title,
              onChange: (e) => setTitle(e.target.value),
              style: S.input,
            }),
          ),
          h('div', null,
            h('label', { style: { display: 'block', fontSize: 11, fontWeight: 600, marginBottom: 4 } }, 'Nội dung'),
            h('input', {
              'data-testid': 'dxos-notify-body-input',
              type: 'text',
              value: body,
              onChange: (e) => setBody(e.target.value),
              style: S.input,
            }),
          ),
        ),
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
          h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 } },
            h('input', {
              'data-testid': 'dxos-notify-dryrun-checkbox',
              type: 'checkbox',
              checked: dryRun,
              onChange: (e) => setDryRun(Boolean(e?.target?.checked)),
            }),
            'Chạy thử an toàn (dryRun — không gửi ra ngoài mạng)',
          ),
          h('button', {
            'data-testid': 'dxos-notify-test-send-btn',
            type: 'submit',
            disabled: sending || !organizationId,
            style: S.btn(true, sending || !organizationId),
          }, sending ? 'Đang gửi…' : 'Gửi thử (Test Send)'),
        ),
        lastResult ? h('div', {
          'data-testid': 'dxos-notify-test-result',
          style: {
            padding: 10,
            borderRadius: 8,
            border: `1px solid ${lastResult.ok === false ? '#fecaca' : '#bbf7d0'}`,
            background: lastResult.ok === false ? '#fef2f2' : '#f0fdf4',
            fontSize: 12,
          },
        },
          h('div', null, `Kết quả: ${lastResult.status || (lastResult.ok ? 'sent' : 'failed')} · Delivery UID: ${lastResult.deliveryUid || '-'} · Đích: ${lastResult.targetMasked || '-'}`),
          lastResult.errorMessage ? h('div', { style: { color: '#991b1b', marginTop: 4 } }, `Lỗi: ${lastResult.errorMessage}`) : null,
        ) : null,
      ),

      h('div', { style: S.card },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('h4', { style: { margin: 0, fontSize: 14 } }, `Nhật ký Gửi Thông báo (${logsData.total || 0})`),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
            h('select', {
              'data-testid': 'dxos-notify-logs-channel-filter',
              value: logChannelFilter,
              onChange: (e) => { setLogChannelFilter(e.target.value); setPage(1); },
              style: { ...S.input, width: 'auto' },
            },
              h('option', { value: '' }, 'Tất cả kênh'),
              CHANNEL_META.map((ch) => h('option', { key: ch.id, value: ch.id }, ch.label)),
            ),
            h('select', {
              'data-testid': 'dxos-notify-logs-status-filter',
              value: logStatusFilter,
              onChange: (e) => { setLogStatusFilter(e.target.value); setPage(1); },
              style: { ...S.input, width: 'auto' },
            },
              h('option', { value: '' }, 'Tất cả trạng thái'),
              h('option', { value: 'sent' }, 'sent'),
              h('option', { value: 'dry_run' }, 'dry_run'),
              h('option', { value: 'failed' }, 'failed'),
              h('option', { value: 'blocked' }, 'blocked'),
            ),
            h('select', {
              'data-testid': 'dxos-notify-logs-dryrun-filter',
              value: logDryRunFilter,
              onChange: (e) => { setLogDryRunFilter(e.target.value); setPage(1); },
              style: { ...S.input, width: 'auto' },
            },
              h('option', { value: 'all' }, 'Thật & Dry-Run'),
              h('option', { value: 'false' }, 'Chỉ gửi thật'),
              h('option', { value: 'true' }, 'Chỉ Dry-Run'),
            ),
          ),
        ),
        !(logsData.items || []).length
          ? h('div', { style: { padding: 12, borderRadius: 8, background: '#f8fafc', fontSize: 12, color: '#64748b' } }, loading ? 'Đang tải nhật ký…' : 'Chưa có nhật ký gửi thông báo nào.')
          : h('div', { style: S.tableWrap },
              h('table', { 'data-testid': 'dxos-notify-logs-table', style: S.table },
                h('thead', null,
                  h('tr', null,
                    h('th', { style: S.th }, 'Kênh'),
                    h('th', { style: S.th }, 'Đích nhận'),
                    h('th', { style: S.th }, 'Trạng thái'),
                    h('th', { style: S.th }, 'Thử'),
                    h('th', { style: S.th }, 'HTTP'),
                    h('th', { style: S.th }, 'Thời gian'),
                    h('th', { style: S.th }, 'Chi tiết'),
                  ),
                ),
                h('tbody', null,
                  logsData.items.map((item) => {
                    const rowKey = item.deliveryUid || String(item.id);
                    const isExpanded = expandedLogId === rowKey;
                    return [
                      h('tr', { key: rowKey },
                        h('td', { style: S.td }, `${item.channel}${item.dryRun ? ' (dry)' : ''}`),
                        h('td', { style: S.td }, item.targetMasked || item.connectorKey || '-'),
                        h('td', { style: S.td }, item.status),
                        h('td', { style: S.td }, `${item.attempt ?? 0}/${item.maxAttempts ?? 3}`),
                        h('td', { style: S.td }, item.httpStatus ?? '-'),
                        h('td', { style: S.td }, item.sentAt || item.createdAt || '-'),
                        h('td', { style: S.td },
                          h('button', {
                            type: 'button',
                            onClick: () => setExpandedLogId(isExpanded ? null : rowKey),
                            style: S.btn(false),
                          }, isExpanded ? 'Ẩn' : 'Xem'),
                        ),
                      ),
                      isExpanded ? h('tr', { key: `${rowKey}-detail` },
                        h('td', { colSpan: 7, style: { ...S.td, background: '#f8fafc' } },
                          item.errorMessage ? h('div', { style: { color: '#991b1b', marginBottom: 4 } }, `Lỗi (${item.errorCode || 'ERR'}): ${item.errorMessage}`) : null,
                          h('pre', { style: { margin: 0, fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, JSON.stringify(item.payloadPreviewJson || {}, null, 2)),
                        ),
                      ) : null,
                    ];
                  }),
                ),
              ),
            ),
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, color: '#64748b' } },
          h('span', null, `Trang ${page} / ${totalPages} (Tổng ${logsData.total || 0})`),
          h('div', { style: { display: 'flex', gap: 6 } },
            h('button', {
              'data-testid': 'dxos-notify-logs-prev',
              type: 'button',
              disabled: page <= 1 || loading,
              onClick: () => setPage((p) => Math.max(1, p - 1)),
              style: S.btn(false, page <= 1 || loading),
            }, 'Trước'),
            h('button', {
              'data-testid': 'dxos-notify-logs-next',
              type: 'button',
              disabled: page >= totalPages || loading,
              onClick: () => setPage((p) => p + 1),
              style: S.btn(false, page >= totalPages || loading),
            }, 'Sau'),
          ),
        ),
      ),
    );
  };
}

module.exports = { createNotifyPanel, CHANNEL_META };
