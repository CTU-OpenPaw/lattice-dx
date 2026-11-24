/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const CONNECTOR_TYPES = ['n8n', 'webhook', 'mqtt', 'orion_ld', 'http_api', 'smtp_notify'];
const AUTH_TYPES = ['bearer', 'hmac', 'basic', 'api_key', 'none'];
const FIELD_TYPES = ['string', 'text', 'integer', 'float', 'boolean', 'date', 'datetime', 'json'];
const BUILDER_ROLES = [
  'ldx_admin',
  'ldx_manager',
  'ldx_operator',
  'ldx_warehouse',
  'ldx_dispatcher',
  'ldx_employee',
  'ldx_viewer',
];

const CUSTOM_COLLECTION_RE = /^latticeCustom[A-Z][A-Za-z0-9]{1,40}$/;
const PORTAL_PATH_RE = /^\/p\/[a-z0-9-]+$/;
const POSITIVE_INT_RE = /^[1-9]\d{0,18}$/;

const DEFAULT_CMMS_PACK = Object.freeze({
  packKey: 'cmms-maintenance',
  title: 'Bảo trì Thiết bị CMMS',
  description: 'Bảo trì Thiết bị CMMS — latticeCustomWorkOrders, DMN routing, Automation tự tạo WO khi có cảnh báo kho lạnh, /p/cmms',
  collectionName: 'latticeCustomWorkOrders',
  routePath: '/p/cmms',
  dmnTableKey: 'cmms_priority_routing_v1',
  automationRuleKey: 'auto_cmms_on_coldchain_fault',
});

function unwrapData(res) {
  return res?.data?.data ?? res?.data ?? {};
}

function extractError(err, fallback) {
  return err?.response?.data?.errors?.[0]?.message
    || err?.response?.data?.message
    || err?.message
    || fallback;
}

function formatTs(value) {
  if (!value) return '-';
  const s = String(value);
  return s.length > 19 ? s.slice(0, 19).replace('T', ' ') : s;
}

function safeJsonParse(rawText, label) {
  try {
    return { ok: true, value: JSON.parse(String(rawText || '')) };
  } catch {
    return { ok: false, error: `${label} không phải JSON hợp lệ.` };
  }
}

function parseVaultSecretsInput(rawText, authType) {
  const trimmed = String(rawText || '').trim();
  if (!trimmed) return { provided: false, value: undefined };
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const parsed = safeJsonParse(trimmed, 'Secrets');
    if (!parsed.ok) return { error: parsed.error };
    if (!parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
      return { error: 'Secrets phải là JSON object hợp lệ (VD: {"token":"..."}).' };
    }
    return { provided: true, value: parsed.value };
  }
  if (authType === 'api_key') return { provided: true, value: { apiKey: trimmed } };
  if (authType === 'hmac') return { provided: true, value: { secret: trimmed } };
  if (authType === 'basic') return { provided: true, value: { password: trimmed } };
  return { provided: true, value: { token: trimmed } };
}

function statusTone(status) {
  const s = String(status || '').toLowerCase();
  if (['online', 'active', 'ok', 'closed', 'delivered', 'dispatched', 'succeeded', 'completed', 'installed', 'synced', 'valid'].includes(s)) {
    return 'ok';
  }
  if (['provisioned', 'queued', 'running', 'info', 'half_open', 'simulated'].includes(s)) return 'info';
  if (['offline', 'pending', 'retry_wait', 'warn', 'warning', 'partial_failed', 'partial', 'skipped'].includes(s)) return 'warn';
  if (['revoked', 'open', 'dlq', 'failed', 'error'].includes(s) || s.startsWith('http_4') || s.startsWith('http_5')) return 'danger';
  return 'neutral';
}

function makeStyles() {
  return {
    stack: { display: 'grid', gap: 14 },
    card: { padding: 16, borderRadius: 12, border: '1px solid #e2e8f0', background: '#ffffff', display: 'grid', gap: 12 },
    subCard: { padding: 12, borderRadius: 8, border: '1px solid #e2e8f0', background: '#f8fafc', display: 'grid', gap: 10 },
    grid2: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 },
    grid3: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 },
    kpiGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 },
    kpiBox: { padding: 10, borderRadius: 8, border: '1px solid #e2e8f0', background: '#f8fafc' },
    rowBetween: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
    rowWrap: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
    label: { display: 'block', fontSize: 12, fontWeight: 600, color: '#334155', marginBottom: 4 },
    input: { width: '100%', padding: '7px 9px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 12, boxSizing: 'border-box', background: '#ffffff' },
    textarea: { width: '100%', padding: 8, borderRadius: 6, border: '1px solid #cbd5e1', fontFamily: 'monospace', fontSize: 12, boxSizing: 'border-box', background: '#ffffff' },
    tableWrap: { width: '100%', overflowX: 'auto' },
    table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
    th: { textAlign: 'left', padding: '7px 8px', borderBottom: '2px solid #e2e8f0', color: '#475569', background: '#f8fafc', whiteSpace: 'nowrap' },
    td: { padding: '7px 8px', borderBottom: '1px solid #f1f5f9', color: '#0f172a', verticalAlign: 'top' },
    badge: (tone = 'neutral') => {
      const palette = {
        ok: { bg: '#dcfce7', color: '#166534', border: '#bbf7d0' },
        warn: { bg: '#fef3c7', color: '#92400e', border: '#fde68a' },
        danger: { bg: '#fee2e2', color: '#991b1b', border: '#fecaca' },
        info: { bg: '#dbeafe', color: '#1e40af', border: '#bfdbfe' },
        neutral: { bg: '#f1f5f9', color: '#475569', border: '#cbd5e1' },
      }[tone] || { bg: '#f1f5f9', color: '#475569', border: '#cbd5e1' };
      return {
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        background: palette.bg,
        color: palette.color,
        border: `1px solid ${palette.border}`,
        whiteSpace: 'nowrap',
      };
    },
    btn: (primary = false, danger = false, disabled = false) => ({
      padding: '7px 12px',
      borderRadius: 8,
      cursor: disabled ? 'not-allowed' : 'pointer',
      fontSize: 12,
      fontWeight: 600,
      border: disabled ? '1px solid #cbd5e1' : danger ? '1px solid #dc2626' : primary ? '1px solid #1677ff' : '1px solid #cbd5e1',
      background: disabled ? '#e2e8f0' : danger ? '#dc2626' : primary ? '#1677ff' : '#ffffff',
      color: disabled ? '#94a3b8' : (primary || danger) ? '#ffffff' : '#1e293b',
      whiteSpace: 'nowrap',
    }),
  };
}

function defaultOpenRoute(app, path) {
  const url = app?.getRouteUrl?.(path) || path;
  if (app?.router?.navigate) app.router.navigate(path);
  else if (typeof window !== 'undefined' && window.location) window.location.assign(url);
}

function usePanelRuntime(React, client, app, props = {}) {
  const useApi = typeof client?.useAPIClient === 'function' ? client.useAPIClient : () => app?.apiClient || null;
  const hookApi = useApi();
  const api = props.api || hookApi;
  const hasApi = Boolean(api?.request);
  const organizations = Array.isArray(props.organizations) ? props.organizations : [];
  const openRoute = typeof props.openRoute === 'function' ? props.openRoute : (p) => defaultOpenRoute(app, p);

  const [orgOverride, setOrgOverride] = React.useState(null);
  const [localFeedback, setLocalFeedback] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [runtimeRef] = React.useState(() => ({ api }));
  runtimeRef.api = api;

  React.useEffect(() => {
    setOrgOverride(null);
  }, [props.selectedOrg]);

  const orgInputValue = orgOverride !== null ? orgOverride : String(props.selectedOrg || '');
  const effectiveOrg = String(orgInputValue).trim();
  const orgPayload = effectiveOrg ? { organizationId: effectiveOrg } : {};

  function reportFeedback(fb) {
    if (typeof props.setFeedback === 'function') {
      props.setFeedback(fb);
      setLocalFeedback(null);
    } else {
      setLocalFeedback(fb);
    }
  }

  async function runMutation(fallbackMsg, fn, { requireOrg = true } = {}) {
    const clientApi = runtimeRef.api;
    if (!clientApi?.request || busy) return;
    if (requireOrg && !effectiveOrg) {
      reportFeedback({ type: 'error', text: 'Vui lòng chọn hoặc nhập mã tổ chức (organizationId) trước khi thao tác.' });
      return;
    }
    setBusy(true);
    reportFeedback(null);
    try {
      await fn(clientApi);
    } catch (err) {
      reportFeedback({ type: 'error', text: extractError(err, fallbackMsg) });
    } finally {
      setBusy(false);
    }
  }

  return {
    api,
    hasApi,
    runtimeRef,
    organizations,
    openRoute,
    orgInputValue,
    setOrgOverride,
    effectiveOrg,
    orgPayload,
    localFeedback,
    reportFeedback,
    busy,
    runMutation,
  };
}

function renderOrgScopeBar(h, S, propsSelectedOrg, organizations, orgInputValue, setOrgOverride, testIdPrefix) {
  if (propsSelectedOrg && organizations.length <= 1) return null;
  return h('div', { style: { ...S.rowWrap, fontSize: 12 } },
    h('span', { style: { fontWeight: 600, color: '#475569' } }, 'Phạm vi Organization ID:'),
    h('input', {
      'data-testid': `${testIdPrefix}-org-input`,
      type: 'text',
      list: organizations.length ? `${testIdPrefix}-org-list` : undefined,
      value: orgInputValue,
      placeholder: 'VD: org-a (bắt buộc với thao tác ghi)',
      onChange: (e) => setOrgOverride(e.target.value),
      style: { ...S.input, width: 240 },
    }),
    organizations.length ? h('datalist', { id: `${testIdPrefix}-org-list` },
      organizations.map((org) => h('option', { key: org, value: org }, org)),
    ) : null,
  );
}

function renderLocalFeedback(h, feedback) {
  if (!feedback) return null;
  const isErr = feedback.type === 'error';
  return h('div', {
    role: 'status',
    style: {
      padding: 10,
      borderRadius: 8,
      fontSize: 12,
      background: isErr ? '#fef2f2' : '#f0fdf4',
      border: `1px solid ${isErr ? '#fecaca' : '#bbf7d0'}`,
      color: isErr ? '#991b1b' : '#166534',
    },
  }, feedback.text);
}

function copyTextSafely(text, onDone) {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      Promise.resolve(navigator.clipboard.writeText(String(text || '')))
        .then(() => onDone?.(true))
        .catch(() => onDone?.(false));
      return;
    }
  } catch {
    // Fallback below
  }
  onDone?.(false);
}

function createBrokerAndEventsPanel(client, React, _antd, app) {
  const h = React.createElement;
  const S = makeStyles();

  return function BrokerAndEventsPanel(props = {}) {
    const rt = usePanelRuntime(React, client, app, props);
    const { effectiveOrg, orgPayload, hasApi, runtimeRef, reportFeedback, busy, runMutation } = rt;

    const [loading, setLoading] = React.useState(false);
    const [devices, setDevices] = React.useState([]);
    const [provisionedSecret, setProvisionedSecret] = React.useState(null);
    const [deviceForm, setDeviceForm] = React.useState({ deviceKey: '', name: '', assetId: '', assetEntityId: '' });

    const [orionData, setOrionData] = React.useState({
      orionReachable: false,
      brokerConfigured: false,
      matched: [],
      orionOnly: [],
      localOnly: [],
      subscriptions: [],
    });
    const [orionForm, setOrionForm] = React.useState({ subscriptionKey: '', entityType: 'Asset', watchedAttributes: 'temperature, humidity' });

    const [events, setEvents] = React.useState([]);
    const [webhookSubs, setWebhookSubs] = React.useState([]);
    const [deliveries, setDeliveries] = React.useState([]);
    const [webhookForm, setWebhookForm] = React.useState({
      subscriptionKey: '',
      name: '',
      targetUrl: '',
      eventPattern: '*',
      signingSecret: '',
    });

    React.useEffect(() => {
      setProvisionedSecret(null);
    }, [effectiveOrg]);

    const loadAll = React.useCallback(async () => {
      const clientApi = runtimeRef.api;
      if (!clientApi?.request) return;
      setLoading(true);
      try {
        const calls = [
          clientApi.request({ url: 'dxosBroker:listDevices', method: 'get', params: { ...orgPayload, limit: 100 }, skipNotify: true }),
          effectiveOrg
            ? clientApi.request({ url: 'dxosBroker:orionEntities', method: 'get', params: orgPayload, skipNotify: true })
            : Promise.resolve({ data: { data: { orionReachable: false, brokerConfigured: false, matched: [], orionOnly: [], localOnly: [] } } }),
          clientApi.request({ url: 'dxosBroker:orionListSubscriptions', method: 'get', params: orgPayload, skipNotify: true }),
          clientApi.request({ url: 'dxosEvents:listEvents', method: 'get', params: { ...orgPayload, limit: 30 }, skipNotify: true }),
          clientApi.request({ url: 'dxosEvents:listSubscriptions', method: 'get', params: orgPayload, skipNotify: true }),
          clientApi.request({ url: 'dxosEvents:listDeliveries', method: 'get', params: { ...orgPayload, limit: 50 }, skipNotify: true }),
        ];
        const results = await Promise.allSettled(calls);
        const firstErr = results.find((r) => r.status === 'rejected');
        if (firstErr) {
          reportFeedback({ type: 'error', text: extractError(firstErr.reason, 'Không tải được đầy đủ dữ liệu Broker & Sự kiện.') });
        }
        if (results[0].status === 'fulfilled') {
          const d = unwrapData(results[0].value);
          setDevices(Array.isArray(d.items) ? d.items : []);
        }
        const entRes = results[1].status === 'fulfilled' ? unwrapData(results[1].value) : {};
        const subRes = results[2].status === 'fulfilled' ? unwrapData(results[2].value) : {};
        if (results[1].status === 'fulfilled' || results[2].status === 'fulfilled') {
          setOrionData((prev) => ({
            orionReachable: Boolean(entRes.orionReachable ?? subRes.orionReachable ?? prev.orionReachable),
            brokerConfigured: Boolean(entRes.brokerConfigured ?? prev.brokerConfigured),
            matched: Array.isArray(entRes.matched) ? entRes.matched : prev.matched,
            orionOnly: Array.isArray(entRes.orionOnly) ? entRes.orionOnly : prev.orionOnly,
            localOnly: Array.isArray(entRes.localOnly) ? entRes.localOnly : prev.localOnly,
            subscriptions: Array.isArray(subRes.items) ? subRes.items : prev.subscriptions,
          }));
        }
        if (results[3].status === 'fulfilled') {
          const d = unwrapData(results[3].value);
          setEvents(Array.isArray(d.items) ? d.items : []);
        }
        if (results[4].status === 'fulfilled') {
          const d = unwrapData(results[4].value);
          setWebhookSubs(Array.isArray(d.items) ? d.items : []);
        }
        if (results[5].status === 'fulfilled') {
          const d = unwrapData(results[5].value);
          setDeliveries(Array.isArray(d.items) ? d.items : []);
        }
      } catch (err) {
        reportFeedback({ type: 'error', text: extractError(err, 'Không tải được dữ liệu Broker & Sự kiện.') });
      } finally {
        setLoading(false);
      }
    }, [effectiveOrg, hasApi]);

    React.useEffect(() => {
      loadAll();
    }, [loadAll]);

    function handleProvisionDevice(e) {
      e?.preventDefault?.();
      const rawAssetId = String(deviceForm.assetId || '').trim();
      if (rawAssetId && !POSITIVE_INT_RE.test(rawAssetId)) {
        reportFeedback({ type: 'error', text: 'assetId phải là số nguyên dương.' });
        return;
      }
      return runMutation('Không cấp phát được thiết bị MQTT.', async (clientApi) => {
        const res = await clientApi.request({
          url: 'dxosBroker:provisionDevice',
          method: 'post',
          data: {
            ...orgPayload,
            deviceKey: deviceForm.deviceKey.trim(),
            name: deviceForm.name.trim(),
            ...(rawAssetId ? { assetId: Number(rawAssetId) } : {}),
            ...(deviceForm.assetEntityId.trim() ? { assetEntityId: deviceForm.assetEntityId.trim() } : {}),
          },
        });
        const d = unwrapData(res);
        setProvisionedSecret(d.mqttPassword ? {
          deviceKey: d.device?.deviceKey || deviceForm.deviceKey.trim(),
          mqttUsername: d.device?.mqttUsername || '',
          topicPrefix: d.device?.topicPrefix || '',
          mqttPassword: d.mqttPassword,
          brokerSynced: Boolean(d.brokerSynced),
          brokerError: d.brokerError || null,
        } : null);
        setDeviceForm({ deviceKey: '', name: '', assetId: '', assetEntityId: '' });
        reportFeedback({
          type: 'success',
          text: `Đã cấp phát thiết bị MQTT "${d.device?.deviceKey || ''}"${d.brokerSynced ? ' (đã đồng bộ Mosquitto DynSec)' : ''}.`,
        });
        await loadAll();
      });
    }

    function handleRevokeDevice(device) {
      return runMutation('Không thu hồi được thiết bị MQTT.', async (clientApi) => {
        await clientApi.request({
          url: 'dxosBroker:revokeDevice',
          method: 'post',
          data: { ...orgPayload, deviceKey: device.deviceKey },
        });
        reportFeedback({ type: 'success', text: `Đã thu hồi thiết bị MQTT "${device.deviceKey}".` });
        await loadAll();
      });
    }

    function handleCreateOrionSub(e) {
      e?.preventDefault?.();
      const watchedAttributes = String(orionForm.watchedAttributes || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      return runMutation('Không tạo được NGSI-LD Subscription.', async (clientApi) => {
        const res = await clientApi.request({
          url: 'dxosBroker:orionCreateSubscription',
          method: 'post',
          data: {
            ...orgPayload,
            subscriptionKey: orionForm.subscriptionKey.trim(),
            entityType: orionForm.entityType.trim() || 'Asset',
            watchedAttributes,
          },
        });
        const d = unwrapData(res);
        setOrionForm((p) => ({ ...p, subscriptionKey: '' }));
        reportFeedback({
          type: 'success',
          text: `Đã tạo NGSI-LD Subscription "${d.subscription?.subscriptionKey || ''}" đẩy về dxosBroker:orionNotify.`,
        });
        await loadAll();
      });
    }

    function handleToggleOrionSub(sub) {
      return runMutation('Không bật/tắt được NGSI-LD Subscription.', async (clientApi) => {
        await clientApi.request({
          url: 'dxosBroker:orionToggleSubscription',
          method: 'post',
          data: { ...orgPayload, id: sub.id, active: !sub.active },
        });
        reportFeedback({ type: 'success', text: `Đã cập nhật trạng thái subscription "${sub.subscriptionKey}".` });
        await loadAll();
      });
    }

    function handleDeleteOrionSub(sub) {
      return runMutation('Không xóa được NGSI-LD Subscription.', async (clientApi) => {
        await clientApi.request({
          url: 'dxosBroker:orionDeleteSubscription',
          method: 'post',
          data: { ...orgPayload, id: sub.id },
        });
        reportFeedback({ type: 'success', text: `Đã xóa subscription "${sub.subscriptionKey}".` });
        await loadAll();
      });
    }

    function handleSaveWebhookSub(e) {
      e?.preventDefault?.();
      const secret = String(webhookForm.signingSecret || '').trim();
      return runMutation('Không lưu được Webhook Subscription.', async (clientApi) => {
        const res = await clientApi.request({
          url: 'dxosEvents:saveSubscription',
          method: 'post',
          data: {
            ...orgPayload,
            subscriptionKey: webhookForm.subscriptionKey.trim(),
            name: webhookForm.name.trim(),
            targetUrl: webhookForm.targetUrl.trim(),
            eventPattern: webhookForm.eventPattern.trim() || '*',
            ...(secret ? { signingSecret: secret } : {}),
          },
        });
        const d = unwrapData(res);
        setWebhookForm((p) => ({ ...p, subscriptionKey: '', name: '', targetUrl: '', signingSecret: '' }));
        reportFeedback({ type: 'success', text: `Đã lưu Webhook Subscription "${d.subscriptionKey || ''}".` });
        await loadAll();
      });
    }

    function handleToggleWebhookSub(sub) {
      return runMutation('Không cập nhật được Webhook Subscription.', async (clientApi) => {
        await clientApi.request({
          url: 'dxosEvents:toggleSubscription',
          method: 'post',
          data: { ...orgPayload, id: sub.id, active: !sub.active },
        });
        reportFeedback({ type: 'success', text: `Đã ${sub.active ? 'tạm dừng' : 'kích hoạt'} webhook "${sub.subscriptionKey}".` });
        await loadAll();
      });
    }

    function handleDeleteWebhookSub(sub) {
      return runMutation('Không xóa được Webhook Subscription.', async (clientApi) => {
        await clientApi.request({
          url: 'dxosEvents:deleteSubscription',
          method: 'post',
          data: { ...orgPayload, id: sub.id },
        });
        reportFeedback({ type: 'success', text: `Đã xóa webhook "${sub.subscriptionKey}".` });
        await loadAll();
      });
    }

    function handleResetCircuit(sub) {
      return runMutation('Không đặt lại Circuit Breaker.', async (clientApi) => {
        await clientApi.request({
          url: 'dxosEvents:resetCircuit',
          method: 'post',
          data: { ...orgPayload, subscriptionId: sub.id },
        });
        reportFeedback({ type: 'success', text: `Đã đặt lại Circuit Breaker cho "${sub.subscriptionKey}".` });
        await loadAll();
      });
    }

    function handleDispatchNow() {
      return runMutation('Không thể gửi Webhook ngay.', async (clientApi) => {
        const res = await clientApi.request({
          url: 'dxosEvents:dispatchNow',
          method: 'post',
          data: { ...orgPayload },
        });
        const d = unwrapData(res);
        reportFeedback({
          type: 'success',
          text: `Đã xử lý ${d.processedCount || 0} webhook (thành công: ${d.deliveredCount || 0}, chờ thử lại: ${d.retryWaitCount || 0}, DLQ: ${d.dlqCount || 0}).`,
        });
        await loadAll();
      });
    }

    function handleReplayDlq(deliveryIds) {
      return runMutation('Không phát lại được Webhook DLQ.', async (clientApi) => {
        const res = await clientApi.request({
          url: 'dxosEvents:replayDlq',
          method: 'post',
          data: { ...orgPayload, deliveryIds },
        });
        const d = unwrapData(res);
        reportFeedback({ type: 'success', text: `Đã đưa ${d.replayedCount || 0} webhook DLQ trở lại hàng đợi.` });
        await loadAll();
      });
    }

    const dlqDeliveryIds = deliveries.filter((d) => d.status === 'dlq' && d.id != null).map((d) => d.id);

    return h('div', { 'data-testid': 'dxos-studio-broker-panel', style: S.stack },
      renderLocalFeedback(h, rt.localFeedback),
      renderOrgScopeBar(h, S, props.selectedOrg, rt.organizations, rt.orgInputValue, rt.setOrgOverride, 'dxos-broker'),

      // Section 1: MQTT DynSec Devices
      h('div', { style: S.card },
        h('div', { style: S.rowBetween },
          h('div', null,
            h('h3', { style: { margin: 0, fontSize: 16 } }, 'MQTT Dynamic Security & Registry Thiết bị IIoT'),
            h('p', { style: { margin: '4px 0 0', fontSize: 12, color: '#64748b' } }, 'Cấp/thu hồi tài khoản Mosquitto DynSec theo tổ chức, theo dõi trạng thái online/offline/revoked và LWT.'),
          ),
          h('button', { type: 'button', onClick: loadAll, disabled: loading, style: S.btn(false, false, loading) }, loading ? 'Đang tải…' : 'Làm mới'),
        ),

        provisionedSecret ? h('div', {
          'data-testid': 'dxos-broker-mqtt-password-once',
          role: 'alert',
          style: { padding: 12, borderRadius: 8, border: '1px solid #f59e0b', background: '#fffbeb', color: '#78350f', display: 'grid', gap: 8 },
        },
          h('div', { style: S.rowBetween },
            h('strong', { style: { fontSize: 13 } }, `Mật khẩu MQTT một lần cho thiết bị "${provisionedSecret.deviceKey}" (không hiển thị lại):`),
            h('div', { style: S.rowWrap },
              h('button', {
                'data-testid': 'dxos-broker-copy-password-btn',
                type: 'button',
                onClick: () => copyTextSafely(provisionedSecret.mqttPassword, (copied) => reportFeedback({
                  type: copied ? 'success' : 'info',
                  text: copied ? 'Đã sao chép mqttPassword vào clipboard.' : 'Hãy sao chép trực tiếp mật khẩu trên màn hình.',
                })),
                style: S.btn(false),
              }, 'Sao chép mật khẩu'),
              h('button', {
                'data-testid': 'dxos-broker-dismiss-password-btn',
                type: 'button',
                onClick: () => setProvisionedSecret(null),
                style: S.btn(false),
              }, 'Đóng & Xóa khỏi màn hình'),
            ),
          ),
          h('div', { style: { fontSize: 12, display: 'flex', gap: 14, flexWrap: 'wrap' } },
            h('span', null, 'Username: ', h('code', null, provisionedSecret.mqttUsername || '-')),
            h('span', null, 'Password: ', h('code', { 'data-testid': 'dxos-broker-mqtt-password-value', style: { background: '#fef3c7', padding: '2px 6px', borderRadius: 4, fontWeight: 700 } }, provisionedSecret.mqttPassword)),
            h('span', null, 'Topic: ', h('code', null, provisionedSecret.topicPrefix || '-')),
          ),
        ) : null,

        h('form', { 'data-testid': 'dxos-broker-device-form', onSubmit: handleProvisionDevice, style: S.subCard },
          h('div', { style: { fontSize: 13, fontWeight: 700, color: '#0f172a' } }, 'Cấp phát Thiết bị MQTT mới'),
          h('div', { style: S.grid2 },
            h('div', null,
              h('label', { style: S.label }, 'Device Key'),
              h('input', {
                'data-testid': 'dxos-broker-device-key-input',
                type: 'text',
                required: true,
                placeholder: 'VD: coldroom-sensor-01',
                value: deviceForm.deviceKey,
                onChange: (e) => setDeviceForm((p) => ({ ...p, deviceKey: e.target.value })),
                style: S.input,
              }),
            ),
            h('div', null,
              h('label', { style: S.label }, 'Tên thiết bị'),
              h('input', {
                'data-testid': 'dxos-broker-device-name-input',
                type: 'text',
                required: true,
                placeholder: 'VD: Cảm biến Kho lạnh A1',
                value: deviceForm.name,
                onChange: (e) => setDeviceForm((p) => ({ ...p, name: e.target.value })),
                style: S.input,
              }),
            ),
            h('div', null,
              h('label', { style: S.label }, 'Asset ID (tùy chọn)'),
              h('input', {
                'data-testid': 'dxos-broker-device-assetid-input',
                type: 'number',
                min: 1,
                placeholder: 'VD: 12',
                value: deviceForm.assetId,
                onChange: (e) => setDeviceForm((p) => ({ ...p, assetId: e.target.value })),
                style: S.input,
              }),
            ),
            h('div', null,
              h('label', { style: S.label }, 'Asset NGSI-LD URN (tùy chọn)'),
              h('input', {
                'data-testid': 'dxos-broker-device-entityid-input',
                type: 'text',
                placeholder: 'urn:ngsi-ld:Asset:org-a:native:12',
                value: deviceForm.assetEntityId,
                onChange: (e) => setDeviceForm((p) => ({ ...p, assetEntityId: e.target.value })),
                style: S.input,
              }),
            ),
          ),
          h('div', null,
            h('button', { type: 'submit', disabled: busy, style: S.btn(true, false, busy) }, busy ? 'Đang cấp phát…' : 'Cấp phát Thiết bị MQTT'),
          ),
        ),

        h('div', { style: S.tableWrap },
          h('table', { 'data-testid': 'dxos-broker-devices-table', style: S.table },
            h('thead', null,
              h('tr', null, ['Device Key', 'Tên thiết bị', 'MQTT User', 'Topic Prefix', 'Asset URN', 'Trạng thái', 'Last Seen', 'Thao tác'].map((c) => h('th', { key: c, style: S.th }, c))),
            ),
            h('tbody', null,
              !devices.length
                ? h('tr', null, h('td', { colSpan: 8, style: { ...S.td, color: '#64748b' } }, 'Chưa có thiết bị MQTT nào được cấp phát.'))
                : devices.map((d) => {
                  const isRevoked = String(d.status || '').toLowerCase() === 'revoked';
                  return h('tr', { key: d.id || d.deviceKey },
                    h('td', { style: S.td }, h('code', null, d.deviceKey)),
                    h('td', { style: S.td }, d.name),
                    h('td', { style: S.td }, h('code', null, d.mqttUsername || '-')),
                    h('td', { style: S.td }, h('code', null, d.topicPrefix || '-')),
                    h('td', { style: S.td }, d.assetEntityId || (d.assetId != null ? `#${d.assetId}` : '-')),
                    h('td', { style: S.td }, h('span', { style: S.badge(statusTone(d.status)) }, d.status || 'provisioned')),
                    h('td', { style: S.td }, formatTs(d.lastSeenAt)),
                    h('td', { style: S.td },
                      isRevoked
                        ? h('span', { style: { fontSize: 11, color: '#94a3b8' } }, 'Đã thu hồi')
                        : h('button', {
                          'data-testid': `dxos-broker-device-revoke-${d.deviceKey}`,
                          type: 'button',
                          disabled: busy,
                          onClick: () => handleRevokeDevice(d),
                          style: S.btn(false, true, busy),
                        }, 'Thu hồi (Revoke)'),
                    ),
                  );
                }),
            ),
          ),
        ),
      ),

      // Section 2: FIWARE Orion-LD Explorer
      h('div', { style: S.card },
        h('div', { style: S.rowBetween },
          h('div', null,
            h('h3', { style: { margin: 0, fontSize: 16 } }, 'FIWARE Orion-LD Explorer & 2-Way NGSI-LD Subscriptions'),
            h('p', { style: { margin: '4px 0 0', fontSize: 12, color: '#64748b' } }, 'Đối chiếu thực thể Digital Twin (matched / orionOnly / localOnly) và đăng ký thông báo đẩy về dxosBroker:orionNotify.'),
          ),
          h('span', {
            'data-testid': 'dxos-broker-orion-status',
            style: S.badge(orionData.orionReachable ? 'ok' : 'warn'),
          }, orionData.orionReachable ? 'Orion-LD: Trực tuyến (Reachable)' : 'Orion-LD: Ngoại tuyến / Chưa kết nối'),
        ),

        h('div', { style: S.kpiGrid },
          [
            ['Khớp đồng bộ (matched)', orionData.matched.length, 'ok'],
            ['Chỉ có trên Orion (orionOnly)', orionData.orionOnly.length, 'info'],
            ['Chỉ có nội bộ (localOnly)', orionData.localOnly.length, 'warn'],
            ['NGSI-LD Subscriptions', orionData.subscriptions.length, 'neutral'],
          ].map(([label, count]) => h('div', { key: label, style: S.kpiBox },
            h('div', { style: { fontSize: 11, color: '#64748b' } }, label),
            h('div', { style: { fontSize: 18, fontWeight: 700, color: '#0f172a', marginTop: 2 } }, count),
          )),
        ),

        (orionData.matched.length || orionData.orionOnly.length || orionData.localOnly.length) ? h('div', { style: S.tableWrap },
          h('table', { 'data-testid': 'dxos-broker-orion-diff-table', style: S.table },
            h('thead', null, h('tr', null, ['Entity ID', 'Type', 'Phân loại Diff', 'Chi tiết'].map((c) => h('th', { key: c, style: S.th }, c)))),
            h('tbody', null, [
              ...orionData.matched.map((m) => h('tr', { key: `m-${m.entityId}` },
                h('td', { style: S.td }, h('code', null, m.entityId)),
                h('td', { style: S.td }, m.type || 'Asset'),
                h('td', { style: S.td }, h('span', { style: S.badge(m.inSync ? 'ok' : 'warn') }, m.inSync ? 'matched (in-sync)' : 'matched (diff)')),
                h('td', { style: S.td }, m.attrDiff?.length ? m.attrDiff.map((d) => `${d.attribute}: ${d.local} vs ${d.orion}`).join('; ') : 'Khớp hoàn toàn'),
              )),
              ...orionData.orionOnly.map((o) => h('tr', { key: `o-${o.entityId}` },
                h('td', { style: S.td }, h('code', null, o.entityId)),
                h('td', { style: S.td }, o.type || 'Unknown'),
                h('td', { style: S.td }, h('span', { style: S.badge('info') }, 'orionOnly')),
                h('td', { style: S.td }, 'Chỉ có trên Orion-LD'),
              )),
              ...orionData.localOnly.map((l) => h('tr', { key: `l-${l.entityId}` },
                h('td', { style: S.td }, h('code', null, l.entityId)),
                h('td', { style: S.td }, l.type || 'Asset'),
                h('td', { style: S.td }, h('span', { style: S.badge('warn') }, 'localOnly')),
                h('td', { style: S.td }, `${l.name || l.code || ''} (chưa có trên Orion-LD)`),
              )),
            ]),
          ),
        ) : null,

        h('form', { 'data-testid': 'dxos-broker-orion-sub-form', onSubmit: handleCreateOrionSub, style: S.subCard },
          h('div', { style: { fontSize: 13, fontWeight: 700 } }, 'Tạo NGSI-LD Subscription (đẩy về dxosBroker:orionNotify)'),
          h('div', { style: S.grid3 },
            h('div', null,
              h('label', { style: S.label }, 'Subscription Key'),
              h('input', {
                'data-testid': 'dxos-broker-orion-sub-key-input',
                type: 'text',
                required: true,
                placeholder: 'VD: coldchain-temp-sub',
                value: orionForm.subscriptionKey,
                onChange: (e) => setOrionForm((p) => ({ ...p, subscriptionKey: e.target.value })),
                style: S.input,
              }),
            ),
            h('div', null,
              h('label', { style: S.label }, 'Entity Type'),
              h('input', {
                'data-testid': 'dxos-broker-orion-sub-type-input',
                type: 'text',
                required: true,
                value: orionForm.entityType,
                onChange: (e) => setOrionForm((p) => ({ ...p, entityType: e.target.value })),
                style: S.input,
              }),
            ),
            h('div', null,
              h('label', { style: S.label }, 'Watched Attributes (cách nhau dấu phẩy)'),
              h('input', {
                'data-testid': 'dxos-broker-orion-sub-attrs-input',
                type: 'text',
                placeholder: 'temperature, humidity',
                value: orionForm.watchedAttributes,
                onChange: (e) => setOrionForm((p) => ({ ...p, watchedAttributes: e.target.value })),
                style: S.input,
              }),
            ),
          ),
          h('div', null,
            h('button', { type: 'submit', disabled: busy, style: S.btn(true, false, busy) }, 'Tạo NGSI-LD Subscription'),
          ),
        ),

        h('div', { style: S.tableWrap },
          h('table', { 'data-testid': 'dxos-broker-orion-subs-table', style: S.table },
            h('thead', null, h('tr', null, ['Key', 'Entity Type', 'Attributes', 'Callback', 'Trạng thái', 'Last Notified', 'Thao tác'].map((c) => h('th', { key: c, style: S.th }, c)))),
            h('tbody', null,
              !orionData.subscriptions.length
                ? h('tr', null, h('td', { colSpan: 7, style: { ...S.td, color: '#64748b' } }, 'Chưa có NGSI-LD Subscription nào.'))
                : orionData.subscriptions.map((sub) => h('tr', { key: sub.id || sub.subscriptionKey },
                  h('td', { style: S.td }, h('code', null, sub.subscriptionKey)),
                  h('td', { style: S.td }, sub.entityType),
                  h('td', { style: S.td }, (sub.watchedAttributesJson || []).join(', ') || '*'),
                  h('td', { style: S.td }, h('code', null, sub.notificationEndpoint || 'dxosBroker:orionNotify')),
                  h('td', { style: S.td }, h('span', { style: S.badge(sub.active ? 'ok' : 'neutral') }, sub.active ? 'active' : 'paused')),
                  h('td', { style: S.td }, formatTs(sub.lastNotifiedAt)),
                  h('td', { style: { ...S.td, display: 'flex', gap: 6 } },
                    h('button', {
                      'data-testid': `dxos-broker-orion-sub-toggle-${sub.id}`,
                      type: 'button',
                      disabled: busy,
                      onClick: () => handleToggleOrionSub(sub),
                      style: S.btn(false, false, busy),
                    }, sub.active ? 'Tạm dừng' : 'Kích hoạt'),
                    h('button', {
                      'data-testid': `dxos-broker-orion-sub-delete-${sub.id}`,
                      type: 'button',
                      disabled: busy,
                      onClick: () => handleDeleteOrionSub(sub),
                      style: S.btn(false, true, busy),
                    }, 'Xóa'),
                  ),
                )),
            ),
          ),
        ),
      ),

      // Section 3: CloudEvents 1.0 Stream & Outbound Standard Webhooks
      h('div', { style: S.card },
        h('div', { style: S.rowBetween },
          h('div', null,
            h('h3', { style: { margin: 0, fontSize: 16 } }, 'CloudEvents 1.0 Event Bus & Standard Webhooks'),
            h('p', { style: { margin: '4px 0 0', fontSize: 12, color: '#64748b' } }, 'Luồng sự kiện CloudEvents 1.0, đăng ký Outbound Webhooks ký HMAC-SHA256, Circuit Breaker và phát lại DLQ.'),
          ),
          h('div', { style: S.rowWrap },
            h('button', { 'data-testid': 'dxos-events-dispatch-btn', type: 'button', disabled: busy, onClick: handleDispatchNow, style: S.btn(true, false, busy) }, 'Dispatch Now'),
            h('button', {
              'data-testid': 'dxos-events-replay-all-dlq-btn',
              type: 'button',
              disabled: busy || !dlqDeliveryIds.length,
              onClick: () => handleReplayDlq(dlqDeliveryIds),
              style: S.btn(false, false, busy || !dlqDeliveryIds.length),
            }, `Replay DLQ (${dlqDeliveryIds.length})`),
          ),
        ),

        h('div', { style: S.subCard },
          h('div', { style: { fontSize: 13, fontWeight: 700 } }, 'Luồng CloudEvents 1.0 gần nhất'),
          h('div', { style: S.tableWrap },
            h('table', { 'data-testid': 'dxos-events-stream-table', style: S.table },
              h('thead', null, h('tr', null, ['Event Type', 'Source', 'Subject', 'Occurred At', 'Status'].map((c) => h('th', { key: c, style: S.th }, c)))),
              h('tbody', null,
                !events.length
                  ? h('tr', null, h('td', { colSpan: 5, style: { ...S.td, color: '#64748b' } }, 'Chưa có sự kiện CloudEvents 1.0 nào.'))
                  : events.map((ev) => h('tr', { key: ev.eventId || ev.id },
                    h('td', { style: S.td }, h('code', null, ev.eventType)),
                    h('td', { style: S.td }, ev.source),
                    h('td', { style: S.td }, ev.subject || '-'),
                    h('td', { style: S.td }, formatTs(ev.occurredAt)),
                    h('td', { style: S.td }, h('span', { style: S.badge(statusTone(ev.status)) }, ev.status)),
                  )),
              ),
            ),
          ),
        ),

        h('form', { 'data-testid': 'dxos-events-webhook-sub-form', onSubmit: handleSaveWebhookSub, style: S.subCard },
          h('div', { style: { fontSize: 13, fontWeight: 700 } }, 'Đăng ký Outbound Standard Webhook Subscription'),
          h('div', { style: S.grid2 },
            h('div', null,
              h('label', { style: S.label }, 'Subscription Key'),
              h('input', {
                'data-testid': 'dxos-events-sub-key-input',
                type: 'text',
                required: true,
                placeholder: 'VD: n8n-coldchain-alert',
                value: webhookForm.subscriptionKey,
                onChange: (e) => setWebhookForm((p) => ({ ...p, subscriptionKey: e.target.value })),
                style: S.input,
              }),
            ),
            h('div', null,
              h('label', { style: S.label }, 'Tên hiển thị'),
              h('input', {
                'data-testid': 'dxos-events-sub-name-input',
                type: 'text',
                required: true,
                placeholder: 'VD: n8n Cảnh báo Kho lạnh',
                value: webhookForm.name,
                onChange: (e) => setWebhookForm((p) => ({ ...p, name: e.target.value })),
                style: S.input,
              }),
            ),
            h('div', null,
              h('label', { style: S.label }, 'Target URL'),
              h('input', {
                'data-testid': 'dxos-events-sub-url-input',
                type: 'url',
                required: true,
                placeholder: 'http://n8n:5678/webhook/coldchain',
                value: webhookForm.targetUrl,
                onChange: (e) => setWebhookForm((p) => ({ ...p, targetUrl: e.target.value })),
                style: S.input,
              }),
            ),
            h('div', null,
              h('label', { style: S.label }, 'Event Pattern'),
              h('input', {
                'data-testid': 'dxos-events-sub-pattern-input',
                type: 'text',
                value: webhookForm.eventPattern,
                onChange: (e) => setWebhookForm((p) => ({ ...p, eventPattern: e.target.value })),
                style: S.input,
              }),
            ),
            h('div', null,
              h('label', { style: S.label }, 'Signing Secret (tùy chọn, mã hóa AES-256-GCM)'),
              h('input', {
                'data-testid': 'dxos-events-sub-secret-input',
                type: 'password',
                placeholder: 'Để trống nếu giữ nguyên secret cũ',
                value: webhookForm.signingSecret,
                onChange: (e) => setWebhookForm((p) => ({ ...p, signingSecret: e.target.value })),
                style: S.input,
              }),
            ),
          ),
          h('div', null,
            h('button', { type: 'submit', disabled: busy, style: S.btn(true, false, busy) }, 'Lưu Webhook Subscription'),
          ),
        ),

        h('div', { style: S.tableWrap },
          h('table', { 'data-testid': 'dxos-events-subs-table', style: S.table },
            h('thead', null, h('tr', null, ['Key', 'Tên', 'Target URL', 'Pattern', 'Circuit Breaker', 'Trạng thái', 'Thao tác'].map((c) => h('th', { key: c, style: S.th }, c)))),
            h('tbody', null,
              !webhookSubs.length
                ? h('tr', null, h('td', { colSpan: 7, style: { ...S.td, color: '#64748b' } }, 'Chưa có Webhook Subscription nào.'))
                : webhookSubs.map((sub) => h('tr', { key: sub.id || sub.subscriptionKey },
                  h('td', { style: S.td }, h('code', null, sub.subscriptionKey)),
                  h('td', { style: S.td }, sub.name),
                  h('td', { style: S.td }, h('code', null, sub.targetUrl)),
                  h('td', { style: S.td }, h('code', null, sub.eventPattern || '*')),
                  h('td', { style: S.td },
                    h('span', { style: S.badge(statusTone(sub.circuitState || 'closed')) }, `${sub.circuitState || 'closed'} (${sub.failureCount || 0})`),
                  ),
                  h('td', { style: S.td }, h('span', { style: S.badge(sub.active ? 'ok' : 'neutral') }, sub.active ? 'active' : 'paused')),
                  h('td', { style: { ...S.td, display: 'flex', gap: 6, flexWrap: 'wrap' } },
                    h('button', {
                      'data-testid': `dxos-events-sub-reset-${sub.id}`,
                      type: 'button',
                      disabled: busy,
                      onClick: () => handleResetCircuit(sub),
                      style: S.btn(sub.circuitState && sub.circuitState !== 'closed', false, busy),
                    }, 'Reset Circuit'),
                    h('button', {
                      'data-testid': `dxos-events-sub-toggle-${sub.id}`,
                      type: 'button',
                      disabled: busy,
                      onClick: () => handleToggleWebhookSub(sub),
                      style: S.btn(false, false, busy),
                    }, sub.active ? 'Tạm dừng' : 'Bật'),
                    h('button', {
                      'data-testid': `dxos-events-sub-delete-${sub.id}`,
                      type: 'button',
                      disabled: busy,
                      onClick: () => handleDeleteWebhookSub(sub),
                      style: S.btn(false, true, busy),
                    }, 'Xóa'),
                  ),
                )),
            ),
          ),
        ),

        h('div', { style: S.subCard },
          h('div', { style: { fontSize: 13, fontWeight: 700 } }, 'Lịch sử Giao hàng Webhook & DLQ'),
          h('div', { style: S.tableWrap },
            h('table', { 'data-testid': 'dxos-events-deliveries-table', style: S.table },
              h('thead', null, h('tr', null, ['ID', 'Event Type', 'Attempt', 'HTTP', 'Status', 'Error', 'Thao tác'].map((c) => h('th', { key: c, style: S.th }, c)))),
              h('tbody', null,
                !deliveries.length
                  ? h('tr', null, h('td', { colSpan: 7, style: { ...S.td, color: '#64748b' } }, 'Chưa có lượt gửi Webhook nào.'))
                  : deliveries.map((del) => h('tr', { key: del.id || del.eventId },
                    h('td', { style: S.td }, `#${del.id}`),
                    h('td', { style: S.td }, h('code', null, del.eventType)),
                    h('td', { style: S.td }, `${del.attempt || 0}/${del.maxAttempts || 5}`),
                    h('td', { style: S.td }, del.httpStatus ?? '-'),
                    h('td', { style: S.td }, h('span', { style: S.badge(statusTone(del.status)) }, del.status)),
                    h('td', { style: S.td }, del.lastError || '-'),
                    h('td', { style: S.td },
                      del.status === 'dlq'
                        ? h('button', {
                          'data-testid': `dxos-events-replay-dlq-${del.id}`,
                          type: 'button',
                          disabled: busy,
                          onClick: () => handleReplayDlq([del.id]),
                          style: S.btn(false, false, busy),
                        }, 'Replay DLQ')
                        : h('span', { style: { fontSize: 11, color: '#94a3b8' } }, formatTs(del.deliveredAt || del.nextAttemptAt)),
                    ),
                  )),
              ),
            ),
          ),
        ),
      ),
    );
  };
}

function createVaultAndAutomationPanel(client, React, _antd, app) {
  const h = React.createElement;
  const S = makeStyles();

  return function VaultAndAutomationPanel(props = {}) {
    const rt = usePanelRuntime(React, client, app, props);
    const { effectiveOrg, orgPayload, hasApi, runtimeRef, openRoute, reportFeedback, busy, runMutation } = rt;

    const [loading, setLoading] = React.useState(false);
    const [connectors, setConnectors] = React.useState([]);
    const [testResult, setTestResult] = React.useState(null);
    const [rotateTargetKey, setRotateTargetKey] = React.useState('');
    const [rotateSecretText, setRotateSecretText] = React.useState('');
    const [vaultForm, setVaultForm] = React.useState({
      connectorKey: '',
      name: '',
      connectorType: 'n8n',
      baseUrl: '',
      authType: 'bearer',
      secretsText: '',
    });

    const [rules, setRules] = React.useState([]);
    const [runs, setRuns] = React.useState([]);
    const [loadSeqRef] = React.useState(() => ({ current: 0 }));

    React.useEffect(() => {
      loadSeqRef.current += 1;
      setTestResult(null);
      setRotateTargetKey('');
      setRotateSecretText('');
      setConnectors([]);
      setRules([]);
      setRuns([]);
    }, [effectiveOrg]);

    const loadAll = React.useCallback(async () => {
      const clientApi = runtimeRef.api;
      if (!clientApi?.request) return;
      const seq = (loadSeqRef.current += 1);
      const reqOrgPayload = { ...orgPayload };
      setLoading(true);
      let pendingCount = 3;
      const done = () => {
        pendingCount -= 1;
        if (pendingCount === 0 && seq === loadSeqRef.current) setLoading(false);
      };
      clientApi.request({ url: 'dxosVault:list', method: 'get', params: reqOrgPayload, skipNotify: true })
        .then((res) => { if (seq === loadSeqRef.current) setConnectors(Array.isArray(unwrapData(res).items) ? unwrapData(res).items : []); })
        .catch((err) => { if (seq === loadSeqRef.current) reportFeedback({ type: 'error', text: extractError(err, 'Không tải được dữ liệu Vault & Automation.') }); })
        .finally(done);
      clientApi.request({ url: 'dxosAutomations:listRules', method: 'get', params: reqOrgPayload, skipNotify: true })
        .then((res) => { if (seq === loadSeqRef.current) setRules(Array.isArray(unwrapData(res).items) ? unwrapData(res).items : []); })
        .catch((err) => { if (seq === loadSeqRef.current) reportFeedback({ type: 'error', text: extractError(err, 'Không tải được dữ liệu Vault & Automation.') }); })
        .finally(done);
      clientApi.request({ url: 'dxosAutomations:listRuns', method: 'get', params: reqOrgPayload, skipNotify: true })
        .then((res) => { if (seq === loadSeqRef.current) setRuns(Array.isArray(unwrapData(res).items) ? unwrapData(res).items : []); })
        .catch((err) => { if (seq === loadSeqRef.current) reportFeedback({ type: 'error', text: extractError(err, 'Không tải được dữ liệu Vault & Automation.') }); })
        .finally(done);
    }, [effectiveOrg, hasApi]);

    React.useEffect(() => {
      loadAll();
    }, [loadAll]);

    function handleSaveConnector(e) {
      e?.preventDefault?.();
      const parsedSecrets = parseVaultSecretsInput(vaultForm.secretsText, vaultForm.authType);
      if (parsedSecrets.error) {
        reportFeedback({ type: 'error', text: parsedSecrets.error });
        return;
      }
      return runMutation('Không lưu được Connector.', async (clientApi) => {
        const res = await clientApi.request({
          url: 'dxosVault:save',
          method: 'post',
          data: {
            ...orgPayload,
            connectorKey: vaultForm.connectorKey.trim(),
            name: vaultForm.name.trim(),
            connectorType: vaultForm.connectorType,
            baseUrl: vaultForm.baseUrl.trim(),
            authType: vaultForm.authType,
            ...(parsedSecrets.provided ? { secrets: parsedSecrets.value } : {}),
          },
        });
        const d = unwrapData(res);
        // Never retain raw plaintext secret in UI state after saving
        setVaultForm((p) => ({ ...p, secretsText: '' }));
        reportFeedback({ type: 'success', text: `Đã lưu Connector "${d.connectorKey || vaultForm.connectorKey}" (Secret v${d.secretVersion || 1}).` });
        await loadAll();
      });
    }

    function handleTestConnection(connector) {
      return runMutation('Kiểm tra kết nối thất bại.', async (clientApi) => {
        const res = await clientApi.request({
          url: 'dxosVault:testConnection',
          method: 'post',
          data: { ...orgPayload, connectorKey: connector.connectorKey },
        });
        const d = unwrapData(res);
        setTestResult(d);
        reportFeedback({
          type: d.ok ? 'success' : 'error',
          text: `Test "${connector.connectorKey}": ${d.ok ? 'Thành công' : 'Thất bại'} (${d.message || d.lastTestStatus || ''}).`,
        });
        await loadAll();
      });
    }

    function handleRotateSecret(e) {
      e?.preventDefault?.();
      const targetConnector = connectors.find((c) => c.connectorKey === rotateTargetKey);
      const parsed = parseVaultSecretsInput(rotateSecretText, targetConnector?.authType || 'bearer');
      if (parsed.error) {
        reportFeedback({ type: 'error', text: parsed.error });
        return;
      }
      if (!parsed.provided) {
        reportFeedback({ type: 'error', text: 'Vui lòng nhập secret mới để xoay vòng.' });
        return;
      }
      return runMutation('Không xoay vòng được secret.', async (clientApi) => {
        const res = await clientApi.request({
          url: 'dxosVault:rotateSecret',
          method: 'post',
          data: { ...orgPayload, connectorKey: rotateTargetKey, secrets: parsed.value },
        });
        const d = unwrapData(res);
        setRotateSecretText('');
        setRotateTargetKey('');
        reportFeedback({ type: 'success', text: `Đã xoay vòng secret cho "${d.connectorKey || rotateTargetKey}" lên v${d.secretVersion || 2}.` });
        await loadAll();
      });
    }

    function handleDeleteConnector(connector) {
      return runMutation('Không xóa được Connector.', async (clientApi) => {
        await clientApi.request({
          url: 'dxosVault:delete',
          method: 'post',
          data: { ...orgPayload, connectorKey: connector.connectorKey },
        });
        reportFeedback({ type: 'success', text: `Đã xóa Connector "${connector.connectorKey}".` });
        await loadAll();
      });
    }

    return h('div', { 'data-testid': 'dxos-studio-automation-panel', style: S.stack },
      renderLocalFeedback(h, rt.localFeedback),
      renderOrgScopeBar(h, S, props.selectedOrg, rt.organizations, rt.orgInputValue, rt.setOrgOverride, 'dxos-automation'),

      // Section 1: Connector & Secrets Vault
      h('div', { style: S.card },
        h('div', { style: S.rowBetween },
          h('div', null,
            h('h3', { style: { margin: 0, fontSize: 16 } }, 'Connector & Secrets Vault (AES-256-GCM)'),
            h('p', { style: { margin: '4px 0 0', fontSize: 12, color: '#64748b' } }, 'Quản lý kết nối n8n, Webhook, MQTT, Orion-LD, HTTP API, SMTP. Secret được mã hóa tại DB và không bao giờ hiển thị lại sau khi lưu.'),
          ),
          h('button', { type: 'button', onClick: () => loadAll(), disabled: loading, style: S.btn(false, false, loading) }, loading ? 'Đang tải…' : 'Làm mới'),
        ),

        testResult ? h('div', {
          'data-testid': 'dxos-vault-test-result',
          role: 'status',
          style: {
            padding: 10,
            borderRadius: 8,
            fontSize: 12,
            background: testResult.ok ? '#f0fdf4' : '#fef2f2',
            border: `1px solid ${testResult.ok ? '#bbf7d0' : '#fecaca'}`,
            color: testResult.ok ? '#166534' : '#991b1b',
          },
        }, `Kiểm tra "${testResult.connectorKey || ''}": ${testResult.ok ? 'OK' : 'FAILED'} · HTTP ${testResult.statusCode ?? '-'} · ${testResult.latencyMs ?? 0}ms · ${testResult.message || ''}`) : null,

        h('form', { 'data-testid': 'dxos-vault-save-form', onSubmit: handleSaveConnector, style: S.subCard },
          h('div', { style: { fontSize: 13, fontWeight: 700 } }, 'Tạo / Cập nhật Connector'),
          h('div', { style: S.grid3 },
            h('div', null,
              h('label', { style: S.label }, 'Connector Key'),
              h('input', {
                'data-testid': 'dxos-vault-key-input',
                type: 'text',
                required: true,
                placeholder: 'VD: n8n-primary',
                value: vaultForm.connectorKey,
                onChange: (e) => setVaultForm((p) => ({ ...p, connectorKey: e.target.value })),
                style: S.input,
              }),
            ),
            h('div', null,
              h('label', { style: S.label }, 'Tên Connector'),
              h('input', {
                'data-testid': 'dxos-vault-name-input',
                type: 'text',
                required: true,
                placeholder: 'VD: n8n Workflow Server',
                value: vaultForm.name,
                onChange: (e) => setVaultForm((p) => ({ ...p, name: e.target.value })),
                style: S.input,
              }),
            ),
            h('div', null,
              h('label', { style: S.label }, 'Loại Connector'),
              h('select', {
                'data-testid': 'dxos-vault-type-select',
                value: vaultForm.connectorType,
                onChange: (e) => setVaultForm((p) => ({ ...p, connectorType: e.target.value })),
                style: S.input,
              }, CONNECTOR_TYPES.map((t) => h('option', { key: t, value: t }, t))),
            ),
            h('div', null,
              h('label', { style: S.label }, 'Base URL'),
              h('input', {
                'data-testid': 'dxos-vault-url-input',
                type: 'text',
                required: vaultForm.connectorType !== 'smtp_notify',
                placeholder: 'http://n8n:5678',
                value: vaultForm.baseUrl,
                onChange: (e) => setVaultForm((p) => ({ ...p, baseUrl: e.target.value })),
                style: S.input,
              }),
            ),
            h('div', null,
              h('label', { style: S.label }, 'Auth Type'),
              h('select', {
                'data-testid': 'dxos-vault-authtype-select',
                value: vaultForm.authType,
                onChange: (e) => setVaultForm((p) => ({ ...p, authType: e.target.value })),
                style: S.input,
              }, AUTH_TYPES.map((a) => h('option', { key: a, value: a }, a))),
            ),
            h('div', null,
              h('label', { style: S.label }, 'Secrets (ẩn sau khi lưu — JSON hoặc token)'),
              h('input', {
                'data-testid': 'dxos-vault-secrets-input',
                type: 'password',
                placeholder: '{"token":"..."} hoặc token thô',
                value: vaultForm.secretsText,
                onChange: (e) => setVaultForm((p) => ({ ...p, secretsText: e.target.value })),
                style: S.input,
              }),
            ),
          ),
          h('div', null,
            h('button', { type: 'submit', disabled: busy, style: S.btn(true, false, busy) }, 'Lưu Connector vào Vault'),
          ),
        ),

        rotateTargetKey ? h('form', {
          'data-testid': 'dxos-vault-rotate-form',
          onSubmit: handleRotateSecret,
          style: { ...S.subCard, border: '1px solid #93c5fd', background: '#eff6ff' },
        },
          h('div', { style: S.rowBetween },
            h('strong', { style: { fontSize: 13 } }, `Xoay vòng Secret cho "${rotateTargetKey}"`),
            h('button', { type: 'button', onClick: () => { setRotateTargetKey(''); setRotateSecretText(''); }, style: S.btn(false) }, 'Hủy'),
          ),
          h('div', { style: S.rowWrap },
            h('input', {
              'data-testid': 'dxos-vault-rotate-input',
              type: 'password',
              required: true,
              placeholder: 'Nhập JSON secret mới (VD: {"token":"new-secret"}) hoặc token thô',
              value: rotateSecretText,
              onChange: (e) => setRotateSecretText(e.target.value),
              style: { ...S.input, flex: '1 1 280px' },
            }),
            h('button', { type: 'submit', disabled: busy, style: S.btn(true, false, busy) }, 'Xác nhận Rotate Secret'),
          ),
        ) : null,

        h('div', { style: S.tableWrap },
          h('table', { 'data-testid': 'dxos-vault-table', style: S.table },
            h('thead', null, h('tr', null, ['Key', 'Tên', 'Loại', 'Base URL', 'Auth', 'Trạng thái Secret', 'Ver', 'Last Test', 'Thao tác'].map((c) => h('th', { key: c, style: S.th }, c)))),
            h('tbody', null,
              !connectors.length
                ? h('tr', null, h('td', { colSpan: 9, style: { ...S.td, color: '#64748b' } }, 'Chưa có Connector nào trong Vault.'))
                : connectors.map((c) => h('tr', { key: c.id || c.connectorKey },
                  h('td', { style: S.td }, h('code', null, c.connectorKey)),
                  h('td', { style: S.td }, c.name),
                  h('td', { style: S.td }, h('span', { style: S.badge('info') }, c.connectorType)),
                  h('td', { style: S.td }, h('code', null, c.baseUrl || '-')),
                  h('td', { style: S.td }, c.authType || 'none'),
                  h('td', { style: S.td },
                    h('span', { style: S.badge(c.hasSecrets ? 'ok' : 'neutral') }, c.hasSecrets ? `Đã mã hóa (${(c.secretKeys || []).join(', ') || 'sealed'})` : 'Chưa có secret'),
                  ),
                  h('td', { style: S.td }, `v${c.secretVersion || 1}`),
                  h('td', { style: S.td },
                    c.lastTestStatus
                      ? h('span', { style: S.badge(statusTone(c.lastTestStatus)) }, c.lastTestStatus)
                      : h('span', { style: { color: '#94a3b8' } }, '-'),
                  ),
                  h('td', { style: { ...S.td, display: 'flex', gap: 6, flexWrap: 'wrap' } },
                    h('button', {
                      'data-testid': `dxos-vault-test-${c.connectorKey}`,
                      type: 'button',
                      disabled: busy,
                      onClick: () => handleTestConnection(c),
                      style: S.btn(false, false, busy),
                    }, 'Test Connection'),
                    h('button', {
                      'data-testid': `dxos-vault-rotate-open-${c.connectorKey}`,
                      type: 'button',
                      disabled: busy,
                      onClick: () => { setRotateTargetKey(c.connectorKey); setRotateSecretText(''); },
                      style: S.btn(false, false, busy),
                    }, 'Rotate Secret'),
                    h('button', {
                      'data-testid': `dxos-vault-edit-${c.connectorKey}`,
                      type: 'button',
                      disabled: busy,
                      onClick: () => setVaultForm({
                        connectorKey: c.connectorKey,
                        name: c.name || '',
                        connectorType: c.connectorType || 'n8n',
                        baseUrl: c.baseUrl || '',
                        authType: c.authType || 'bearer',
                        secretsText: '',
                      }),
                      style: S.btn(false, false, busy),
                    }, 'Nạp sửa'),
                    h('button', {
                      'data-testid': `dxos-vault-delete-${c.connectorKey}`,
                      type: 'button',
                      disabled: busy,
                      onClick: () => handleDeleteConnector(c),
                      style: S.btn(false, true, busy),
                    }, 'Xóa'),
                  ),
                )),
            ),
          ),
        ),
      ),

      // Section 2: Slim LatticeFlow v2 Automation Summary & Studio Launcher
      h('div', { 'data-testid': 'dxos-automation-summary-card', style: S.card },
        h('div', { style: S.rowBetween },
          h('div', null,
            h('h3', { style: { margin: 0, fontSize: 16 } }, 'LatticeFlow v2 — Automation Rules & Full-Screen Studio'),
            h('p', { style: { margin: '4px 0 0', fontSize: 12, color: '#64748b' } }, 'Quản trị nhanh quy tắc tự động hóa & lịch sử chạy; mở DX-OS Flow Studio toàn màn hình để thiết kế DAG, HITL và Flow Architect.'),
          ),
          h('button', {
            'data-testid': 'dxos-open-flow-studio-btn',
            type: 'button',
            onClick: () => openRoute('/admin/settings/dxos-flow-studio'),
            style: S.btn(true),
          }, 'Mở Full-Screen LatticeFlow Studio ↗'),
        ),
        h('div', { style: S.kpiGrid },
          [
            ['Tổng Flow Rules', rules.length],
            ['Đang kích hoạt', rules.filter((r) => r.active !== false).length],
            ['Lượt chạy gần đây', runs.length],
            ['Chờ duyệt HITL', runs.filter((r) => r.status === 'suspended').length],
          ].map(([label, count]) => h('div', { key: label, style: S.kpiBox },
            h('div', { style: { fontSize: 11, color: '#64748b' } }, label),
            h('div', { style: { fontSize: 18, fontWeight: 700, color: '#0f172a', marginTop: 2 } }, count),
          )),
        ),
        h('div', { style: S.tableWrap },
          h('table', { 'data-testid': 'dxos-automation-rules-table', style: S.table },
            h('thead', null, h('tr', null, ['Rule Key', 'Tên quy trình', 'Trigger', 'Schema', 'Trạng thái', 'Thao tác'].map((c) => h('th', { key: c, style: S.th }, c)))),
            h('tbody', null,
              !rules.length
                ? h('tr', null, h('td', { colSpan: 6, style: { ...S.td, color: '#64748b' } }, 'Chưa có Automation Rule nào. Nhấn "Mở Full-Screen LatticeFlow Studio ↗" để khởi tạo từ 6 Blueprint mẫu.'))
                : rules.map((r) => h('tr', { key: r.id || r.ruleKey },
                  h('td', { style: S.td }, h('code', null, r.ruleKey)),
                  h('td', { style: S.td }, r.name || r.ruleKey),
                  h('td', { style: S.td }, h('code', null, r.triggerEventType || '*')),
                  h('td', { style: S.td }, h('span', { style: S.badge(Number(r.schemaVersion) === 2 || r.graphJson ? 'info' : 'neutral') }, Number(r.schemaVersion) === 2 || r.graphJson ? 'v2 DAG' : 'v1')),
                  h('td', { style: S.td }, h('span', { style: S.badge(r.active !== false ? 'ok' : 'neutral') }, r.active !== false ? 'active' : 'paused')),
                  h('td', { style: { ...S.td, display: 'flex', gap: 6, flexWrap: 'wrap' } },
                    h('button', {
                      'data-testid': `dxos-automation-open-studio-${r.ruleKey}`,
                      type: 'button',
                      onClick: () => openRoute(`/admin/settings/dxos-flow-studio?ruleKey=${encodeURIComponent(r.ruleKey)}`),
                      style: S.btn(false),
                    }, 'Mở trong Studio ↗'),
                    h('button', {
                      'data-testid': `dxos-automation-run-${r.ruleKey}`,
                      type: 'button',
                      disabled: busy,
                      onClick: () => runMutation(`Không chạy được rule "${r.ruleKey}".`, async (clientApi) => {
                        const evType = String(r.triggerEventType || 'manual.trigger').split(',')[0].trim() || 'manual.trigger';
                        await clientApi.request({ url: 'dxosAutomations:runNow', method: 'post', data: { ...orgPayload, ruleKey: r.ruleKey, sampleEvent: r.sampleEvent || { type: evType, data: {} } } });
                        reportFeedback({ type: 'success', text: `Đã chạy rule "${r.ruleKey}".` });
                        await loadAll();
                      }),
                      style: S.btn(true, false, busy),
                    }, 'Run Now'),
                    h('button', {
                      'data-testid': `dxos-automation-toggle-${r.ruleKey}`,
                      type: 'button',
                      disabled: busy,
                      onClick: () => runMutation('Không đổi được trạng thái rule.', async (clientApi) => {
                        await clientApi.request({ url: 'dxosAutomations:toggleRule', method: 'post', data: { ...orgPayload, ruleKey: r.ruleKey, active: r.active === false } });
                        await loadAll();
                      }),
                      style: S.btn(false, false, busy),
                    }, r.active !== false ? 'Tạm dừng' : 'Bật'),
                    h('button', {
                      'data-testid': `dxos-automation-delete-${r.ruleKey}`,
                      type: 'button',
                      disabled: busy,
                      onClick: () => runMutation('Không xóa được rule.', async (clientApi) => {
                        await clientApi.request({ url: 'dxosAutomations:deleteRule', method: 'post', data: { ...orgPayload, ruleKey: r.ruleKey } });
                        reportFeedback({ type: 'success', text: `Đã xóa rule "${r.ruleKey}".` });
                        await loadAll();
                      }),
                      style: S.btn(false, true, busy),
                    }, 'Xóa'),
                  ),
                )),
            ),
          ),
        ),
        h('div', { style: S.tableWrap },
          h('table', { 'data-testid': 'dxos-automation-runs-table', style: S.table },
            h('thead', null, h('tr', null, ['Run UID', 'Rule Key', 'Trạng thái', 'Thời gian', 'Bắt đầu', 'Thao tác'].map((c) => h('th', { key: c, style: S.th }, c)))),
            h('tbody', null,
              !runs.length
                ? h('tr', null, h('td', { colSpan: 6, style: { ...S.td, color: '#64748b' } }, 'Chưa có lịch sử chạy Automation nào.'))
                : runs.slice(0, 20).map((run) => {
                  const uid = String(run.runUid || run.runId || run.id || '');
                  return h('tr', { key: uid },
                    h('td', { style: S.td }, h('code', null, uid)),
                    h('td', { style: S.td }, h('code', null, run.ruleKey || '-')),
                    h('td', { style: S.td }, h('span', { style: S.badge(statusTone(run.status)) }, run.status || 'completed')),
                    h('td', { style: S.td }, `${run.durationMs ?? 0} ms`),
                    h('td', { style: S.td }, formatTs(run.startedAt)),
                    h('td', { style: S.td },
                      h('button', {
                        'data-testid': `dxos-automation-replay-${uid}`,
                        type: 'button',
                        disabled: busy,
                        onClick: () => runMutation('Không phát lại được run.', async (clientApi) => {
                          await clientApi.request({ url: 'dxosAutomations:replayRun', method: 'post', data: { ...orgPayload, ...(run.runUid ? { runUid: run.runUid } : { runId: run.runId || run.id }) } });
                          reportFeedback({ type: 'success', text: `Đã replay "${uid}".` });
                          await loadAll();
                        }),
                        style: S.btn(false, false, busy),
                      }, 'Replay'),
                    ),
                  );
                }),
            ),
          ),
        ),
      ),
    );
  };
}

function createDomainBuilderAndTenantsPanel(client, React, _antd, app) {
  const h = React.createElement;
  const S = makeStyles();

  return function DomainBuilderAndTenantsPanel(props = {}) {
    const rt = usePanelRuntime(React, client, app, props);
    const { effectiveOrg, orgPayload, hasApi, runtimeRef, openRoute, reportFeedback, busy, runMutation } = rt;

    const [loading, setLoading] = React.useState(false);
    const [domains, setDomains] = React.useState([]);
    const [packs, setPacks] = React.useState([DEFAULT_CMMS_PACK]);
    const [tenants, setTenants] = React.useState([]);

    const [domainForm, setDomainForm] = React.useState({
      collectionName: 'latticeCustomInspections',
      title: 'Phiếu Kiểm định Chất lượng',
      routePath: '/p/inspections',
      fields: [
        { name: 'code', type: 'string', title: 'Mã phiếu', required: true },
        { name: 'status', type: 'string', title: 'Trạng thái', required: true },
      ],
      roles: ['ldx_admin', 'ldx_manager', 'ldx_operator'],
    });

    const [tenantForm, setTenantForm] = React.useState({
      organizationId: '',
      name: '',
      region: 'VN-SG',
      adminUsername: '',
      adminEmail: '',
      adminPassword: '',
    });

    const loadAll = React.useCallback(async () => {
      const clientApi = runtimeRef.api;
      if (!clientApi?.request) return;
      setLoading(true);
      try {
        const results = await Promise.allSettled([
          clientApi.request({ url: 'dxosBuilder:listDomains', method: 'get', params: orgPayload, skipNotify: true }),
          clientApi.request({ url: 'dxosBuilder:listBusinessPacks', method: 'get', params: orgPayload, skipNotify: true }),
          clientApi.request({ url: 'dxosBuilder:listTenants', method: 'get', skipNotify: true }),
        ]);
        const firstErr = results.find((r) => r.status === 'rejected');
        if (firstErr) {
          reportFeedback({ type: 'error', text: extractError(firstErr.reason, 'Không tải được dữ liệu Domain Builder & Tenant.') });
        }
        if (results[0].status === 'fulfilled') {
          const d = unwrapData(results[0].value);
          setDomains(Array.isArray(d.items) ? d.items : []);
        }
        if (results[1].status === 'fulfilled') {
          const d = unwrapData(results[1].value);
          const items = Array.isArray(d.items) ? d.items : [];
          if (items.length) {
            const hasCmms = items.some((p) => p.packKey === 'cmms-maintenance');
            setPacks(hasCmms ? items : [DEFAULT_CMMS_PACK, ...items]);
          } else {
            setPacks([DEFAULT_CMMS_PACK]);
          }
        }
        if (results[2].status === 'fulfilled') {
          const d = unwrapData(results[2].value);
          setTenants(Array.isArray(d.items) ? d.items : []);
        }
      } catch (err) {
        reportFeedback({ type: 'error', text: extractError(err, 'Không tải được dữ liệu Domain Builder & Tenant.') });
      } finally {
        setLoading(false);
      }
    }, [effectiveOrg, hasApi]);

    React.useEffect(() => {
      loadAll();
    }, [loadAll]);

    function handleCreateDomain(e) {
      e?.preventDefault?.();
      const colName = domainForm.collectionName.trim();
      const routePath = domainForm.routePath.trim();
      if (!CUSTOM_COLLECTION_RE.test(colName)) {
        reportFeedback({ type: 'error', text: 'collectionName phải bắt đầu bằng "latticeCustom" theo định dạng PascalCase (VD: latticeCustomInspections).' });
        return;
      }
      if (!PORTAL_PATH_RE.test(routePath)) {
        reportFeedback({ type: 'error', text: 'Portal Path phải có dạng /p/<slug> (VD: /p/inspections).' });
        return;
      }
      const validFields = domainForm.fields
        .map((f) => ({ name: String(f.name || '').trim(), type: f.type || 'string', title: String(f.title || f.name || '').trim(), required: Boolean(f.required) }))
        .filter((f) => f.name);
      if (!validFields.length) {
        reportFeedback({ type: 'error', text: 'Vui lòng khai báo ít nhất 1 trường dữ liệu cho phân hệ.' });
        return;
      }
      return runMutation('Không tạo được phân hệ Domain mới.', async (clientApi) => {
        const portalSlug = routePath.replace(/^\/+p\//, '');
        const res = await clientApi.request({
          url: 'dxosBuilder:createDomain',
          method: 'post',
          data: {
            ...orgPayload,
            collectionName: colName,
            title: domainForm.title.trim(),
            routePath,
            portalSlug,
            portalTitle: domainForm.title.trim(),
            fields: validFields,
            roles: domainForm.roles,
          },
        });
        const d = unwrapData(res);
        const createdDomain = d.domain || d;
        const createdPath = createdDomain.portalPage?.path || d.routePath || routePath;
        reportFeedback({ type: 'success', text: `Đã tạo phân hệ "${createdDomain.collectionName || colName}" kèm PG RLS, RBAC & Portal ${createdPath}.` });
        await loadAll();
      });
    }

    function handleInstallPack(packKey) {
      return runMutation(`Không cài được gói ${packKey}.`, async (clientApi) => {
        const res = await clientApi.request({
          url: 'dxosBuilder:installBusinessPack',
          method: 'post',
          data: { ...orgPayload, packKey },
        });
        const d = unwrapData(res);
        const colName = d.domain?.collectionName || d.collectionName || 'latticeCustomWorkOrders';
        const portalPath = d.domain?.portalPage?.path || d.routePath || '/p/cmms';
        reportFeedback({ type: 'success', text: `Đã cài gói "${packKey}" (${colName}) và Portal ${portalPath}.` });
        await loadAll();
      });
    }

    function handleProvisionTenant(e) {
      e?.preventDefault?.();
      return runMutation('Không cấp phát được Tenant / Công ty con.', async (clientApi) => {
        const res = await clientApi.request({
          url: 'dxosBuilder:provisionTenant',
          method: 'post',
          data: {
            organizationId: tenantForm.organizationId.trim(),
            name: tenantForm.name.trim(),
            region: tenantForm.region.trim() || 'VN-SG',
            adminUsername: tenantForm.adminUsername.trim(),
            adminEmail: tenantForm.adminEmail.trim(),
            adminPassword: tenantForm.adminPassword,
          },
        });
        const d = unwrapData(res);
        // Never keep plaintext admin password in React state
        setTenantForm({ organizationId: '', name: '', region: 'VN-SG', adminUsername: '', adminEmail: '', adminPassword: '' });
        reportFeedback({
          type: 'success',
          text: `Đã cấp phát Tenant "${d.organizationId || d.organization?.organizationId || ''}" cùng phòng ban, khóa PKI Ed25519 và tài khoản Admin.`,
        });
        await loadAll();
      }, { requireOrg: false });
    }

    function toggleBuilderRole(roleName, checked) {
      setDomainForm((prev) => {
        const set = new Set(prev.roles || []);
        if (checked) set.add(roleName);
        else set.delete(roleName);
        return { ...prev, roles: BUILDER_ROLES.filter((r) => set.has(r)) };
      });
    }

    return h('div', { 'data-testid': 'dxos-studio-builder-panel', style: S.stack },
      renderLocalFeedback(h, rt.localFeedback),
      renderOrgScopeBar(h, S, props.selectedOrg, rt.organizations, rt.orgInputValue, rt.setOrgOverride, 'dxos-builder'),

      // Section 1: 1-Click Business Packs Grid
      h('div', { style: S.card },
        h('div', { style: S.rowBetween },
          h('div', null,
            h('h3', { style: { margin: 0, fontSize: 16 } }, 'Gói Nghiệp vụ 1-Click (Business Packs)'),
            h('p', { style: { margin: '4px 0 0', fontSize: 12, color: '#64748b' } }, 'Triển khai nhanh bộ sưu tập latticeCustom*, bảng DMN, Automation và Cổng Portal chỉ với 1 nút bấm.'),
          ),
          h('button', { type: 'button', onClick: loadAll, disabled: loading, style: S.btn(false, false, loading) }, loading ? 'Đang tải…' : 'Làm mới'),
        ),
        h('div', { 'data-testid': 'dxos-builder-packs-grid', style: S.grid2 },
          packs.map((pack) => {
            const isCmms = pack.packKey === 'cmms-maintenance';
            const routePath = pack.routePath || (pack.components?.portalSlug ? `/p/${pack.components.portalSlug}` : (isCmms ? '/p/cmms' : `/p/${pack.packKey}`));
            const description = isCmms
              ? DEFAULT_CMMS_PACK.description
              : (pack.description || `${pack.collectionName || pack.components?.collection || ''} · ${routePath}`);
            return h('div', {
              key: pack.packKey,
              'data-testid': `dxos-builder-pack-${pack.packKey}`,
              style: { ...S.subCard, background: '#ffffff' },
            },
              h('div', { style: S.rowBetween },
                h('strong', { style: { fontSize: 14, color: '#0f172a' } }, pack.title || (isCmms ? DEFAULT_CMMS_PACK.title : (pack.name || pack.packKey))),
                h('span', { style: S.badge(pack.installed ? 'ok' : 'info') }, pack.installed ? 'Đã cài đặt' : 'Sẵn sàng'),
              ),
              h('p', { style: { margin: 0, fontSize: 12, color: '#475569' } }, description),
              h('div', { style: S.rowWrap },
                h('button', {
                  'data-testid': isCmms ? 'dxos-builder-install-cmms-btn' : `dxos-builder-install-pack-${pack.packKey}`,
                  type: 'button',
                  disabled: busy,
                  onClick: () => handleInstallPack(pack.packKey),
                  style: S.btn(true, false, busy),
                }, isCmms ? 'Cài gói CMMS 1-Click' : `Cài gói ${pack.packKey}`),
                h('button', {
                  'data-testid': isCmms ? 'dxos-builder-open-cmms-btn' : `dxos-builder-open-pack-${pack.packKey}`,
                  type: 'button',
                  onClick: () => openRoute(routePath),
                  style: S.btn(false),
                }, isCmms ? 'Mở Portal CMMS' : 'Mở Portal'),
              ),
            );
          }),
        ),
      ),

      // Section 2: Visual latticeCustom* Domain Builder
      h('div', { style: S.card },
        h('h3', { style: { margin: 0, fontSize: 16 } }, 'Visual Domain Builder (Phân hệ động latticeCustom* + PG RLS + Portal)'),
        h('form', { 'data-testid': 'dxos-builder-domain-form', onSubmit: handleCreateDomain, style: S.subCard },
          h('div', { style: S.grid3 },
            h('div', null,
              h('label', { style: S.label }, 'Collection Name (latticeCustom...)'),
              h('input', {
                'data-testid': 'dxos-builder-collection-input',
                type: 'text',
                required: true,
                value: domainForm.collectionName,
                onChange: (e) => setDomainForm((p) => ({ ...p, collectionName: e.target.value })),
                style: S.input,
              }),
            ),
            h('div', null,
              h('label', { style: S.label }, 'Tiêu đề phân hệ'),
              h('input', {
                'data-testid': 'dxos-builder-title-input',
                type: 'text',
                required: true,
                value: domainForm.title,
                onChange: (e) => setDomainForm((p) => ({ ...p, title: e.target.value })),
                style: S.input,
              }),
            ),
            h('div', null,
              h('label', { style: S.label }, 'Đường dẫn Portal (/p/...)'),
              h('input', {
                'data-testid': 'dxos-builder-routepath-input',
                type: 'text',
                required: true,
                value: domainForm.routePath,
                onChange: (e) => setDomainForm((p) => ({ ...p, routePath: e.target.value })),
                style: S.input,
              }),
            ),
          ),

          h('div', { 'data-testid': 'dxos-builder-fields-editor', style: { display: 'grid', gap: 8 } },
            h('div', { style: S.rowBetween },
              h('span', { style: S.label }, 'Các trường dữ liệu (Fields)'),
              h('button', {
                'data-testid': 'dxos-builder-add-field-btn',
                type: 'button',
                onClick: () => setDomainForm((p) => ({
                  ...p,
                  fields: [...p.fields, { name: '', type: 'string', title: '', required: false }],
                })),
                style: S.btn(false),
              }, '+ Thêm trường'),
            ),
            domainForm.fields.map((f, idx) => h('div', {
              key: idx,
              'data-testid': `dxos-builder-field-row-${idx}`,
              style: { display: 'grid', gridTemplateColumns: '1fr 120px 1fr auto auto', gap: 8, alignItems: 'center' },
            },
              h('input', {
                'data-testid': `dxos-builder-field-name-${idx}`,
                type: 'text',
                required: true,
                placeholder: 'Tên cột (VD: severity)',
                value: f.name,
                onChange: (e) => setDomainForm((p) => ({
                  ...p,
                  fields: p.fields.map((item, i) => (i === idx ? { ...item, name: e.target.value } : item)),
                })),
                style: S.input,
              }),
              h('select', {
                'data-testid': `dxos-builder-field-type-${idx}`,
                value: f.type,
                onChange: (e) => setDomainForm((p) => ({
                  ...p,
                  fields: p.fields.map((item, i) => (i === idx ? { ...item, type: e.target.value } : item)),
                })),
                style: S.input,
              }, FIELD_TYPES.map((ft) => h('option', { key: ft, value: ft }, ft))),
              h('input', {
                'data-testid': `dxos-builder-field-title-${idx}`,
                type: 'text',
                placeholder: 'Nhãn hiển thị',
                value: f.title,
                onChange: (e) => setDomainForm((p) => ({
                  ...p,
                  fields: p.fields.map((item, i) => (i === idx ? { ...item, title: e.target.value } : item)),
                })),
                style: S.input,
              }),
              h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, whiteSpace: 'nowrap' } },
                h('input', {
                  'data-testid': `dxos-builder-field-required-${idx}`,
                  type: 'checkbox',
                  checked: Boolean(f.required),
                  onChange: (e) => setDomainForm((p) => ({
                    ...p,
                    fields: p.fields.map((item, i) => (i === idx ? { ...item, required: Boolean(e?.target?.checked) } : item)),
                  })),
                }),
                'Bắt buộc',
              ),
              h('button', {
                'data-testid': `dxos-builder-field-remove-${idx}`,
                type: 'button',
                onClick: () => setDomainForm((p) => ({
                  ...p,
                  fields: p.fields.filter((_, i) => i !== idx),
                })),
                style: S.btn(false, true),
              }, 'Xóa'),
            )),
          ),

          h('div', { 'data-testid': 'dxos-builder-roles' },
            h('span', { style: S.label }, 'Cấp quyền RBAC cho vai trò'),
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 10 } },
              BUILDER_ROLES.map((r) => h('label', { key: r, style: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 } },
                h('input', {
                  'data-testid': `dxos-builder-role-${r}`,
                  type: 'checkbox',
                  checked: domainForm.roles.includes(r),
                  onChange: (e) => toggleBuilderRole(r, Boolean(e?.target?.checked)),
                }),
                r,
              )),
            ),
          ),

          h('div', null,
            h('button', { type: 'submit', disabled: busy, style: S.btn(true, false, busy) }, busy ? 'Đang khởi tạo…' : 'Tạo Phân hệ & Đồng bộ RLS / Portal'),
          ),
        ),

        h('div', { style: S.tableWrap },
          h('table', { 'data-testid': 'dxos-builder-domains-table', style: S.table },
            h('thead', null, h('tr', null, ['Collection', 'Tiêu đề', 'Portal Path', 'Fields', 'Bảo mật RLS', 'Vai trò', 'Thao tác'].map((c) => h('th', { key: c, style: S.th }, c)))),
            h('tbody', null,
              !domains.length
                ? h('tr', null, h('td', { colSpan: 7, style: { ...S.td, color: '#64748b' } }, 'Chưa có phân hệ latticeCustom* nào.'))
                : domains.map((d) => {
                  const colName = d.collectionName || d.name;
                  const routePath = d.routePath || d.portalPages?.[0]?.path || d.portalPage?.path || '';
                  const rlsOn = d.rlsActive !== false && d.rlsProtected !== false && d.rls?.verified !== false;
                  const roles = Array.isArray(d.roles) ? d.roles : (Array.isArray(d.grantedRoles) ? d.grantedRoles : []);
                  const fieldCount = Array.isArray(d.fields) ? d.fields.length : Number(d.fieldCount || 0);
                  return h('tr', { key: colName },
                    h('td', { style: S.td }, h('code', null, colName)),
                    h('td', { style: S.td }, d.title || colName),
                    h('td', { style: S.td }, h('code', null, routePath || '-')),
                    h('td', { style: S.td }, `${fieldCount} trường`),
                    h('td', { style: S.td }, h('span', { style: S.badge(rlsOn ? 'ok' : 'warn') }, rlsOn ? 'RLS Active' : 'No RLS')),
                    h('td', { style: S.td }, roles.join(', ') || '-'),
                    h('td', { style: S.td },
                      routePath
                        ? h('button', {
                          'data-testid': `dxos-builder-open-portal-${colName}`,
                          type: 'button',
                          onClick: () => openRoute(routePath),
                          style: S.btn(false),
                        }, 'Mở Portal')
                        : '-',
                    ),
                  );
                }),
            ),
          ),
        ),
      ),

      // Section 3: 1-Click Multi-Tenant Subsidiary Provisioning
      h('div', { style: S.card },
        h('h3', { style: { margin: 0, fontSize: 16 } }, 'Cấp phát Nhanh Công ty con / Tenant (Multi-Tenant Provisioning)'),
        h('form', { 'data-testid': 'dxos-builder-tenant-form', onSubmit: handleProvisionTenant, style: S.subCard },
          h('div', { style: S.grid3 },
            h('div', null,
              h('label', { style: S.label }, 'Organization ID mới'),
              h('input', {
                'data-testid': 'dxos-builder-tenant-org-input',
                type: 'text',
                required: true,
                placeholder: 'VD: org-branch-cantho',
                value: tenantForm.organizationId,
                onChange: (e) => setTenantForm((p) => ({ ...p, organizationId: e.target.value })),
                style: S.input,
              }),
            ),
            h('div', null,
              h('label', { style: S.label }, 'Tên Công ty con / Chi nhánh'),
              h('input', {
                'data-testid': 'dxos-builder-tenant-name-input',
                type: 'text',
                required: true,
                placeholder: 'VD: Chi nhánh Cần Thơ',
                value: tenantForm.name,
                onChange: (e) => setTenantForm((p) => ({ ...p, name: e.target.value })),
                style: S.input,
              }),
            ),
            h('div', null,
              h('label', { style: S.label }, 'Khu vực (Region)'),
              h('input', {
                'data-testid': 'dxos-builder-tenant-region-input',
                type: 'text',
                value: tenantForm.region,
                onChange: (e) => setTenantForm((p) => ({ ...p, region: e.target.value })),
                style: S.input,
              }),
            ),
            h('div', null,
              h('label', { style: S.label }, 'Admin Username'),
              h('input', {
                'data-testid': 'dxos-builder-tenant-username-input',
                type: 'text',
                required: true,
                placeholder: 'admin_cantho',
                value: tenantForm.adminUsername,
                onChange: (e) => setTenantForm((p) => ({ ...p, adminUsername: e.target.value })),
                style: S.input,
              }),
            ),
            h('div', null,
              h('label', { style: S.label }, 'Admin Email'),
              h('input', {
                'data-testid': 'dxos-builder-tenant-email-input',
                type: 'email',
                required: true,
                placeholder: 'admin@branch.latticedx.vn',
                value: tenantForm.adminEmail,
                onChange: (e) => setTenantForm((p) => ({ ...p, adminEmail: e.target.value })),
                style: S.input,
              }),
            ),
            h('div', null,
              h('label', { style: S.label }, 'Admin Password'),
              h('input', {
                'data-testid': 'dxos-builder-tenant-password-input',
                type: 'password',
                required: true,
                placeholder: 'Mật khẩu khởi tạo (>= 8 ký tự)',
                value: tenantForm.adminPassword,
                onChange: (e) => setTenantForm((p) => ({ ...p, adminPassword: e.target.value })),
                style: S.input,
              }),
            ),
          ),
          h('div', null,
            h('button', { type: 'submit', disabled: busy, style: S.btn(true, false, busy) }, busy ? 'Đang cấp phát…' : 'Cấp phát Tenant 1-Click'),
          ),
        ),

        h('div', { style: S.tableWrap },
          h('table', { 'data-testid': 'dxos-builder-tenants-table', style: S.table },
            h('thead', null, h('tr', null, ['Organization ID', 'Tên tổ chức', 'Region', 'Phòng ban', 'Nhân sự', 'PKI Ed25519', 'Trạng thái'].map((c) => h('th', { key: c, style: S.th }, c)))),
            h('tbody', null,
              !tenants.length
                ? h('tr', null, h('td', { colSpan: 7, style: { ...S.td, color: '#64748b' } }, 'Chưa có dữ liệu Tenant từ latticeOrganizations.'))
                : tenants.map((t) => {
                  const deptCount = t.departmentCount ?? (Array.isArray(t.departments) ? t.departments.length : 0);
                  const empCount = t.employeeCount ?? (Array.isArray(t.employees) ? t.employees.length : 0);
                  const pkiKeyId = t.activePkiKey?.keyId || t.pkiKeyId || '';
                  const hasPki = Boolean(t.activePkiKey || t.pkiActive || t.pkiKeyId || t.hasPkiKey);
                  const active = t.active !== false && t.status !== 'suspended' && t.status !== 'inactive';
                  return h('tr', { key: t.organizationId || t.id },
                    h('td', { style: S.td }, h('code', null, t.organizationId)),
                    h('td', { style: S.td }, t.name || t.organizationId),
                    h('td', { style: S.td }, t.region || 'VN'),
                    h('td', { style: S.td }, deptCount),
                    h('td', { style: S.td }, empCount),
                    h('td', { style: S.td }, h('span', { style: S.badge(hasPki ? 'ok' : 'warn') }, hasPki ? (pkiKeyId || 'PKI Active') : 'Chưa có PKI')),
                    h('td', { style: S.td }, h('span', { style: S.badge(active ? 'ok' : 'danger') }, t.status || (active ? 'active' : 'inactive'))),
                  );
                }),
            ),
          ),
        ),
      ),
    );
  };
}

function createBuilderBrokerPanels(client, React, antd, app) {
  return {
    BrokerAndEventsPanel: createBrokerAndEventsPanel(client, React, antd, app),
    VaultAndAutomationPanel: createVaultAndAutomationPanel(client, React, antd, app),
    DomainBuilderAndTenantsPanel: createDomainBuilderAndTenantsPanel(client, React, antd, app),
  };
}

function makeDirectPanelWrapper(factory) {
  return function DirectPanelWrapper(props = {}) {
    const reactImpl = props.React || globalThis.React;
    if (!reactImpl || typeof reactImpl.createElement !== 'function') {
      throw new Error('Pass React via createBuilderBrokerPanels(client, React, antd, app) or props.React.');
    }
    const Inner = factory(props.client || null, reactImpl, props.antd || {}, props.app || null);
    return Inner(props);
  };
}

module.exports = {
  createBuilderBrokerPanels,
  createBrokerAndEventsPanel,
  createVaultAndAutomationPanel,
  createDomainBuilderAndTenantsPanel,
  BrokerAndEventsPanel: makeDirectPanelWrapper(createBrokerAndEventsPanel),
  VaultAndAutomationPanel: makeDirectPanelWrapper(createVaultAndAutomationPanel),
  DomainBuilderAndTenantsPanel: makeDirectPanelWrapper(createDomainBuilderAndTenantsPanel),
};
