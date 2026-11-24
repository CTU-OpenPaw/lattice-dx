/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { resolveN8nEditorUrl } = require('./n8n-setup-modal');

const DEFAULT_APP_CATALOG = Object.freeze([
  { appType: 'telegram', name: 'Telegram Bot API', category: 'messaging', connectorType: 'http_api', authTypes: ['api_key', 'bearer'], defaultAuthType: 'api_key', defaultBaseUrl: 'https://api.telegram.org', capabilities: ['sendMessage', 'sendPhoto', 'webhook'], secretFields: ['botToken', 'defaultChatId'] },
  { appType: 'email_smtp', name: 'Email (SMTP)', category: 'messaging', connectorType: 'smtp_notify', authTypes: ['basic', 'none'], defaultAuthType: 'basic', defaultBaseUrl: 'smtp://smtp.example.org:587', capabilities: ['sendEmail'], secretFields: ['host', 'port', 'username', 'password', 'fromEmail'] },
  { appType: 'gmail_oauth2', name: 'Gmail (OAuth2 PKCE)', category: 'messaging', connectorType: 'http_api', authTypes: ['oauth2'], defaultAuthType: 'oauth2', defaultBaseUrl: 'https://gmail.googleapis.com', capabilities: ['sendEmail', 'readInbox', 'searchThreads'], secretFields: ['clientId', 'clientSecret'] },
  { appType: 'google_sheets_oauth2', name: 'Google Sheets (OAuth2 PKCE)', category: 'productivity', connectorType: 'http_api', authTypes: ['oauth2'], defaultAuthType: 'oauth2', defaultBaseUrl: 'https://sheets.googleapis.com', capabilities: ['appendRow', 'readRange', 'updateRange'], secretFields: ['clientId', 'clientSecret'] },
  { appType: 'slack', name: 'Slack Workspace', category: 'messaging', connectorType: 'http_api', authTypes: ['oauth2', 'bearer'], defaultAuthType: 'oauth2', defaultBaseUrl: 'https://slack.com/api', capabilities: ['postMessage', 'listChannels', 'uploadFile'], secretFields: ['clientId', 'clientSecret', 'botToken'] },
  { appType: 'discord', name: 'Discord Webhook / Bot', category: 'messaging', connectorType: 'webhook', authTypes: ['bearer', 'none'], defaultAuthType: 'bearer', defaultBaseUrl: 'https://discord.com/api', capabilities: ['postMessage', 'sendEmbed'], secretFields: ['webhookUrl', 'botToken'] },
  { appType: 'teams', name: 'Microsoft Teams', category: 'messaging', connectorType: 'http_api', authTypes: ['oauth2', 'bearer'], defaultAuthType: 'oauth2', defaultBaseUrl: 'https://graph.microsoft.com', capabilities: ['postMessage', 'sendAdaptiveCard'], secretFields: ['clientId', 'clientSecret'] },
  { appType: 'github', name: 'GitHub', category: 'engineering', connectorType: 'http_api', authTypes: ['oauth2', 'bearer'], defaultAuthType: 'oauth2', defaultBaseUrl: 'https://api.github.com', capabilities: ['createIssue', 'createComment', 'triggerDispatch'], secretFields: ['clientId', 'clientSecret', 'token'] },
  { appType: 'rustfs_s3', name: 'RustFS / S3 Storage', category: 'storage', connectorType: 'http_api', authTypes: ['api_key', 'basic'], defaultAuthType: 'api_key', defaultBaseUrl: 'https://s3.example.org', capabilities: ['putObject', 'getObject', 'presignUrl'], secretFields: ['accessKeyId', 'secretAccessKey', 'bucket', 'region'] },
  { appType: 'n8n_api', name: 'Stock n8n Public REST API v1', category: 'orchestration', connectorType: 'n8n', authTypes: ['api_key', 'hmac', 'bearer'], defaultAuthType: 'api_key', defaultBaseUrl: 'http://n8n:5678', capabilities: ['listWorkflows', 'createWorkflow', 'updateWorkflow', 'activateWorkflow', 'listExecutions', 'retryExecution', 'syncCredential'], secretFields: ['apiKey', 'webhookSecret'] },
  { appType: 'partner_webhook', name: 'B2B Partner Webhook', category: 'integration', connectorType: 'webhook', authTypes: ['hmac', 'bearer', 'api_key'], defaultAuthType: 'hmac', defaultBaseUrl: 'https://partner.example.org/webhooks/latticedx', capabilities: ['dispatchEvent', 'verifyCallback'], secretFields: ['secret', 'apiKey'] },
]);

const unwrap = (res) => res?.data?.data ?? res?.data ?? {};
const errMsg = (err, fb) => err?.response?.data?.errors?.[0]?.message || err?.response?.data?.message || err?.message || fb;
const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function parseSecretsInput(rawText, authType, appType) {
  const trimmed = String(rawText || '').trim();
  if (!trimmed) return { provided: false, value: undefined };
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed, (k, v) => (BLOCKED_KEYS.has(k) ? undefined : v));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: 'Secrets phải là JSON object hợp lệ.' };
      return { provided: true, value: parsed };
    } catch { return { error: 'Secrets không phải JSON hợp lệ.' }; }
  }
  if (appType === 'telegram') return { provided: true, value: { botToken: trimmed } };
  if (authType === 'api_key') return { provided: true, value: { apiKey: trimmed } };
  if (authType === 'hmac') return { provided: true, value: { secret: trimmed } };
  if (authType === 'basic') return { provided: true, value: { password: trimmed } };
  return { provided: true, value: { token: trimmed } };
}

function createConnectedAppsPanel(client, React, _antd, app) {
  const h = React.createElement;
  const useApi = typeof client?.useAPIClient === 'function' ? client.useAPIClient : () => app?.apiClient || null;
  const S = {
    stack: { display: 'grid', gap: 14 },
    card: { padding: 16, borderRadius: 12, border: '1px solid #E2E8F0', background: '#FFFFFF', display: 'grid', gap: 12 },
    sub: { padding: 12, borderRadius: 10, border: '1px solid #E2E8F0', background: '#F8FAFC', display: 'grid', gap: 10 },
    grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(235px, 1fr))', gap: 10 },
    rowBetween: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
    row: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' },
    inp: { width: '100%', padding: '6px 9px', borderRadius: 7, border: '1px solid #CBD5E1', fontSize: 12, background: '#FFFFFF', color: '#0F172A', boxSizing: 'border-box' },
    lbl: { display: 'block', fontSize: 11, fontWeight: 600, color: '#334155', marginBottom: 3 },
    th: { textAlign: 'left', padding: '7px 8px', borderBottom: '2px solid #E2E8F0', color: '#475569', background: '#F8FAFC', fontSize: 12, whiteSpace: 'nowrap' },
    td: { padding: '7px 8px', borderBottom: '1px solid #F1F5F9', color: '#0F172A', fontSize: 12, verticalAlign: 'top' },
    badge: (tone = 'neutral') => {
      const m = { ok: ['#DCFCE7', '#166534', '#BBF7D0'], warn: ['#FEF3C7', '#92400E', '#FDE68A'], err: ['#FEE2E2', '#991B1B', '#FECACA'], info: ['#DBEAFE', '#1E40AF', '#BFDBFE'], neutral: ['#F1F5F9', '#475569', '#CBD5E1'] }[tone] || ['#F1F5F9', '#475569', '#CBD5E1'];
      return { display: 'inline-block', padding: '2px 7px', borderRadius: 999, fontSize: 11, fontWeight: 600, background: m[0], color: m[1], border: `1px solid ${m[2]}`, whiteSpace: 'nowrap' };
    },
    btn: (tone = 'ghost', dis = false) => {
      const m = { pri: ['#2563EB', '#FFFFFF', '#2563EB'], run: ['#0F766E', '#FFFFFF', '#0F766E'], danger: ['#DC2626', '#FFFFFF', '#DC2626'], act: ['#EFF6FF', '#1D4ED8', '#93C5FD'], ghost: ['#FFFFFF', '#0F172A', '#CBD5E1'] }[tone] || ['#FFFFFF', '#0F172A', '#CBD5E1'];
      return { padding: '6px 11px', borderRadius: 7, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', cursor: dis ? 'not-allowed' : 'pointer', opacity: dis ? 0.6 : 1, background: dis ? '#E2E8F0' : m[0], color: dis ? '#64748B' : m[1], border: `1px solid ${dis ? '#CBD5E1' : m[2]}`, textDecoration: 'none', display: 'inline-flex', alignItems: 'center' };
    },
  };

  return function ConnectedAppsPanel(props = {}) {
    const api = props.api || useApi();
    const organizations = Array.isArray(props.organizations) ? props.organizations : [];
    const [orgOverride, setOrgOverride] = React.useState(null);
    React.useEffect(() => { setOrgOverride(null); }, [props.selectedOrg]);
    const orgInputValue = orgOverride !== null ? orgOverride : String(props.selectedOrg || '');
    const effectiveOrg = String(orgInputValue).trim();
    const orgPayload = effectiveOrg ? { organizationId: effectiveOrg } : {};

    const [loading, setLoading] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const [localFb, setLocalFb] = React.useState(null);
    const [testRes, setTestRes] = React.useState(null);
    const [catalog, setCatalog] = React.useState(DEFAULT_APP_CATALOG);
    const [connectors, setConnectors] = React.useState([]);
    const [n8nStatus, setN8nStatus] = React.useState(null);
    const [workflows, setWorkflows] = React.useState([]);
    const [executions, setExecutions] = React.useState([]);
    const [rotateKey, setRotateKey] = React.useState('');
    const [rotateText, setRotateText] = React.useState('');
    const [modalApp, setModalApp] = React.useState(null);
    const [wizardMode, setWizardMode] = React.useState('token');
    const [form, setForm] = React.useState({ connectorKey: '', name: '', baseUrl: '', authType: 'api_key', secretsText: '' });
    const [oauth, setOauth] = React.useState({ clientId: '', clientSecret: '', redirectUri: 'http://localhost:13014/admin/settings/workflow/connectors', scopes: '', authorizeUrl: '', state: '', code: '' });
    const [refs] = React.useState(() => ({ api, seq: 0 }));
    refs.api = api;

    const reportFb = (fb) => (typeof props.setFeedback === 'function' ? (props.setFeedback(fb), setLocalFb(null)) : setLocalFb(fb));

    const loadAll = React.useCallback(async () => {
      const cApi = refs.api;
      if (!cApi?.request) return;
      const seq = (refs.seq += 1);
      const isFresh = () => seq === refs.seq;
      setLoading(true);
      const p = { ...orgPayload };
      const reqs = await Promise.allSettled([
        cApi.request({ url: 'dxosN8n:appCatalog', method: 'get', params: p, skipNotify: true }),
        cApi.request({ url: 'dxosVault:list', method: 'get', params: p, skipNotify: true }),
        cApi.request({ url: 'dxosN8n:status', method: 'get', params: p, skipNotify: true }),
        cApi.request({ url: 'dxosN8n:workflows', method: 'get', params: { ...p, limit: 50 }, skipNotify: true }),
        cApi.request({ url: 'dxosN8n:executions', method: 'get', params: { ...p, limit: 25 }, skipNotify: true }),
      ]);
      if (!isFresh()) return;
      if (reqs[0].status === 'fulfilled' && Array.isArray(unwrap(reqs[0].value).items) && unwrap(reqs[0].value).items.length) setCatalog(unwrap(reqs[0].value).items);
      if (reqs[1].status === 'fulfilled') setConnectors(Array.isArray(unwrap(reqs[1].value).items) ? unwrap(reqs[1].value).items : []);
      else reportFb({ type: 'error', text: errMsg(reqs[1].reason, 'Không tải được Connector Vault.') });
      setN8nStatus(reqs[2].status === 'fulfilled' ? unwrap(reqs[2].value) : null);
      const pickArr = (r) => (r.status === 'fulfilled' ? (Array.isArray(unwrap(r.value).data) ? unwrap(r.value).data : (unwrap(r.value).items || [])) : []);
      setWorkflows(pickArr(reqs[3]));
      setExecutions(pickArr(reqs[4]));
      setLoading(false);
    }, [effectiveOrg, Boolean(api?.request)]);

    React.useEffect(() => { loadAll(); }, [loadAll]);

    const runMut = async (fallback, fn) => {
      const cApi = refs.api;
      if (!cApi?.request || busy) return;
      if (!effectiveOrg) return reportFb({ type: 'error', text: 'Vui lòng chọn Organization ID trước khi thao tác.' });
      setBusy(true); reportFb(null);
      try { await fn(cApi); } catch (err) { reportFb({ type: 'error', text: errMsg(err, fallback) }); } finally { setBusy(false); }
    };

    const openConnectWizard = (item) => {
      const hasOAuth = Array.isArray(item.authTypes) && item.authTypes.includes('oauth2');
      setModalApp(item);
      setWizardMode(hasOAuth ? 'oauth2' : 'token');
      setForm({ connectorKey: `${item.appType.replace(/_/g, '-')}-primary`, name: item.name, baseUrl: item.defaultBaseUrl || '', authType: item.defaultAuthType || (hasOAuth ? 'oauth2' : 'api_key'), secretsText: '' });
      setOauth({ clientId: '', clientSecret: '', redirectUri: 'http://localhost:13014/admin/settings/workflow/connectors', scopes: Array.isArray(item.oauth2?.defaultScopes) ? item.oauth2.defaultScopes.join(' ') : '', authorizeUrl: '', state: '', code: '' });
    };

    const handleSaveToken = (e) => {
      e?.preventDefault?.();
      const parsed = parseSecretsInput(form.secretsText, form.authType, modalApp?.appType);
      if (parsed.error) return reportFb({ type: 'error', text: parsed.error });
      return runMut('Không lưu được kết nối.', async (cApi) => {
        const res = await cApi.request({
          url: 'dxosVault:save',
          method: 'post',
          data: { ...orgPayload, connectorKey: form.connectorKey.trim(), name: form.name.trim(), connectorType: modalApp?.connectorType || 'http_api', appType: modalApp?.appType || null, capabilitiesJson: modalApp?.capabilities || null, baseUrl: form.baseUrl.trim(), authType: form.authType, ...(parsed.provided ? { secrets: parsed.value } : {}) },
        });
        setForm((f) => ({ ...f, secretsText: '' }));
        setModalApp(null);
        reportFb({ type: 'success', text: `Đã kết nối "${unwrap(res).connectorKey || form.connectorKey}" (Secret đã mã hóa AES-256-GCM).` });
        await loadAll();
      });
    };

    const handleOAuthStart = () => runMut('Không khởi tạo được OAuth2 PKCE.', async (cApi) => {
      const scopes = oauth.scopes.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
      const res = await cApi.request({
        url: 'dxosVault:oauthStart',
        method: 'post',
        data: { ...orgPayload, connectorKey: form.connectorKey.trim(), name: form.name.trim(), appType: modalApp?.appType, clientId: oauth.clientId.trim(), clientSecret: oauth.clientSecret, redirectUri: oauth.redirectUri.trim(), ...(scopes.length ? { scopes } : {}) },
      });
      const d = unwrap(res);
      setOauth((o) => ({ ...o, clientSecret: '', authorizeUrl: d.authorizeUrl || '', state: d.state || '' }));
      reportFb({ type: 'success', text: `Đã tạo URL ủy quyền OAuth2 PKCE S256 cho "${d.connectorKey || form.connectorKey}".` });
    });

    const handleOAuthCallback = () => runMut('Xác nhận OAuth2 Callback thất bại.', async (cApi) => {
      const res = await cApi.request({
        url: 'dxosVault:oauthCallback',
        method: 'post',
        data: { ...orgPayload, connectorKey: form.connectorKey.trim(), code: oauth.code.trim(), state: oauth.state.trim(), redirectUri: oauth.redirectUri.trim() },
      });
      setOauth((o) => ({ ...o, code: '' }));
      setModalApp(null);
      reportFb({ type: 'success', text: `Đã hoàn tất OAuth2 cho "${unwrap(res).connectorKey || form.connectorKey}".` });
      await loadAll();
    });

    const n8nConn = connectors.find((c) => c && (c.appType === 'n8n_api' || c.connectorType === 'n8n'));
    const editorUrl = resolveN8nEditorUrl(n8nStatus?.baseUrl || n8nConn?.baseUrl);

    return h('div', { 'data-testid': 'dxos-connected-apps-panel', style: S.stack },
      localFb ? h('div', { role: 'status', style: { padding: 10, borderRadius: 8, fontSize: 12, background: localFb.type === 'error' ? '#FEF2F2' : '#F0FDF4', border: `1px solid ${localFb.type === 'error' ? '#FECACA' : '#BBF7D0'}`, color: localFb.type === 'error' ? '#991B1B' : '#166534' } }, localFb.text) : null,
      testRes ? h('div', { 'data-testid': 'dxos-app-test-result', role: 'status', style: { padding: 10, borderRadius: 8, fontSize: 12, background: testRes.ok ? '#F0FDF4' : '#FEF2F2', border: `1px solid ${testRes.ok ? '#BBF7D0' : '#FECACA'}`, color: testRes.ok ? '#166534' : '#991B1B' } }, `Kiểm tra "${testRes.connectorKey || ''}": ${testRes.ok ? 'OK' : 'FAILED'} · HTTP ${testRes.statusCode ?? '-'} · ${testRes.latencyMs ?? 0}ms · ${testRes.message || ''}`) : null,
      (!props.selectedOrg || organizations.length > 1) ? h('div', { style: S.row },
        h('span', { style: { fontSize: 12, fontWeight: 600, color: '#475569' } }, 'Organization ID:'),
        h('input', { 'data-testid': 'dxos-connected-apps-org-input', type: 'text', value: orgInputValue, placeholder: 'org-a', onChange: (e) => setOrgOverride(e.target.value), style: { ...S.inp, width: 200 } }),
      ) : null,

      h('div', { style: S.card },
        h('div', { style: S.rowBetween },
          h('div', null,
            h('h3', { style: { margin: 0, fontSize: 16, color: '#0F172A' } }, 'Connected Apps & Stock n8n Hub (1-Stop Integration)'),
            h('p', { style: { margin: '4px 0 0', fontSize: 12, color: '#64748B' } }, 'Kết nối OAuth2 PKCE / Bot Token / API Key vào Secrets Vault (AES-256-GCM) và đồng bộ 1-click sang Stock n8n.'),
          ),
          h('div', { style: S.row },
            h('span', { 'data-testid': 'dxos-n8n-status-badge', style: S.badge(n8nStatus?.ok ? 'ok' : 'warn') }, n8nStatus?.ok ? `n8n Online (${n8nStatus.latencyMs ?? 0}ms)` : 'n8n chưa kết nối / ngoại tuyến'),
            h('a', { 'data-testid': 'dxos-n8n-open-editor-link', href: editorUrl, target: '_blank', rel: 'noopener noreferrer', style: S.btn('act') }, 'Mở trên n8n Editor ↗'),
            h('button', { type: 'button', onClick: loadAll, disabled: loading, style: S.btn('ghost', loading) }, loading ? 'Đang tải…' : 'Làm mới'),
          ),
        ),
        h('div', { 'data-testid': 'dxos-app-catalog-grid', style: S.grid },
          catalog.map((item) => h('div', { key: item.appType, 'data-testid': `dxos-app-card-${item.appType}`, style: { ...S.sub, background: '#FFFFFF', justifyContent: 'space-between' } },
            h('div', { style: { display: 'grid', gap: 6 } },
              h('div', { style: S.rowBetween },
                h('strong', { style: { fontSize: 13, color: '#0F172A' } }, item.name),
                h('span', { style: S.badge(item.configuredCount > 0 ? 'ok' : 'neutral') }, item.configuredCount > 0 ? `${item.configuredCount} đã nối` : item.category || 'app'),
              ),
              h('div', { style: S.row }, (item.capabilities || []).map((cap) => h('span', { key: cap, 'data-testid': `dxos-app-cap-${item.appType}-${cap}`, style: S.badge('info') }, cap))),
            ),
            h('div', { style: S.rowBetween },
              h('span', { style: { fontSize: 11, color: '#64748B' } }, (item.authTypes || []).join(' · ')),
              h('button', { type: 'button', 'data-testid': `dxos-app-connect-${item.appType}`, onClick: () => openConnectWizard(item), style: S.btn('pri') }, 'Kết nối'),
            ),
          )),
        ),
      ),

      h('div', { style: S.card },
        h('h3', { style: { margin: 0, fontSize: 15 } }, `Kết nối đã lưu trong Secrets Vault (${connectors.length})`),
        rotateKey ? h('form', { 'data-testid': 'dxos-app-rotate-form', onSubmit: (e) => {
          e?.preventDefault?.();
          const c = connectors.find((x) => x.connectorKey === rotateKey);
          const p = parseSecretsInput(rotateText, c?.authType || 'bearer', c?.appType);
          if (p.error || !p.provided) return reportFb({ type: 'error', text: p.error || 'Nhập secret mới.' });
          return runMut('Không xoay vòng secret.', async (cApi) => {
            await cApi.request({ url: 'dxosVault:rotateSecret', method: 'post', data: { ...orgPayload, connectorKey: rotateKey, secrets: p.value } });
            setRotateKey(''); setRotateText('');
            reportFb({ type: 'success', text: `Đã xoay vòng secret cho "${rotateKey}".` });
            await loadAll();
          });
        }, style: S.sub },
          h('div', { style: S.rowBetween }, h('strong', { style: { fontSize: 12 } }, `Xoay vòng Secret: ${rotateKey}`), h('button', { type: 'button', onClick: () => { setRotateKey(''); setRotateText(''); }, style: S.btn('ghost') }, 'Hủy')),
          h('div', { style: S.row },
            h('input', { type: 'password', required: true, value: rotateText, placeholder: 'Secret mới (JSON hoặc token)', onChange: (e) => setRotateText(e.target.value), style: { ...S.inp, flex: '1 1 240px' } }),
            h('button', { type: 'submit', disabled: busy, style: S.btn('pri', busy) }, 'Xác nhận'),
          ),
        ) : null,
        h('div', { style: { overflowX: 'auto' } },
          h('table', { 'data-testid': 'dxos-connected-vault-table', style: { width: '100%', borderCollapse: 'collapse' } },
            h('thead', null, h('tr', null, ['Key', 'Ứng dụng', 'Auth', 'Trạng thái Secret / OAuth2', 'n8n Credential', 'Last Test', 'Thao tác'].map((c) => h('th', { key: c, style: S.th }, c)))),
            h('tbody', null, !connectors.length
              ? h('tr', null, h('td', { colSpan: 7, style: { ...S.td, color: '#64748B' } }, 'Chưa có connector nào. Nhấn "Kết nối" trên App Catalog phía trên để bắt đầu.'))
              : connectors.map((c) => h('tr', { key: c.id || c.connectorKey },
                h('td', { style: S.td }, h('code', null, c.connectorKey)),
                h('td', { style: S.td }, `${c.name || c.connectorKey} (${c.appType || c.connectorType})`),
                h('td', { style: S.td }, c.authType || 'none'),
                h('td', { style: S.td }, h('span', { style: S.badge(c.oauthConnected || c.hasSecrets ? 'ok' : 'neutral') }, c.oauthConnected ? 'OAuth2 Connected' : (c.hasSecrets ? 'Encrypted' : 'No secret'))),
                h('td', { style: S.td }, c.n8nCredentialId ? h('code', null, c.n8nCredentialId) : '-'),
                h('td', { style: S.td }, c.lastTestStatus ? h('span', { style: S.badge(c.lastTestStatus === 'ok' ? 'ok' : 'err') }, c.lastTestStatus) : '-'),
                h('td', { style: { ...S.td, display: 'flex', gap: 6, flexWrap: 'wrap' } },
                  h('button', { type: 'button', 'data-testid': `dxos-app-test-${c.connectorKey}`, disabled: busy, onClick: () => runMut('Kiểm tra thất bại.', async (cApi) => { const r = await cApi.request({ url: 'dxosVault:testConnection', method: 'post', data: { ...orgPayload, connectorKey: c.connectorKey } }); setTestRes(unwrap(r)); await loadAll(); }), style: S.btn('ghost', busy) }, 'Kiểm tra'),
                  h('button', { type: 'button', 'data-testid': `dxos-app-sync-n8n-${c.connectorKey}`, disabled: busy, onClick: () => runMut('Đồng bộ sang n8n thất bại.', async (cApi) => { const r = await cApi.request({ url: 'dxosN8n:syncCredential', method: 'post', data: { ...orgPayload, connectorKey: c.connectorKey } }); reportFb({ type: 'success', text: `Đã đồng bộ "${c.connectorKey}" sang n8n (${unwrap(r).n8nCredentialId || 'synced'}).` }); await loadAll(); }), style: S.btn('act', busy) }, 'Đồng bộ sang n8n'),
                  h('button', { type: 'button', 'data-testid': `dxos-app-rotate-${c.connectorKey}`, disabled: busy, onClick: () => { setRotateKey(c.connectorKey); setRotateText(''); }, style: S.btn('ghost', busy) }, 'Rotate'),
                  h('button', { type: 'button', 'data-testid': `dxos-app-delete-${c.connectorKey}`, disabled: busy, onClick: () => runMut('Xóa thất bại.', async (cApi) => { await cApi.request({ url: 'dxosVault:delete', method: 'post', data: { ...orgPayload, connectorKey: c.connectorKey } }); await loadAll(); }), style: S.btn('danger', busy) }, 'Xóa'),
                ),
              ))),
          ),
        ),
      ),

      h('div', { style: S.card },
        h('div', { style: S.rowBetween },
          h('h3', { style: { margin: 0, fontSize: 15 } }, `Stock n8n Workflows (${workflows.length}) & Executions (${executions.length})`),
          h('a', { href: editorUrl, target: '_blank', rel: 'noopener noreferrer', style: S.btn('ghost') }, 'Mở trên n8n Editor ↗'),
        ),
        h('div', { style: { overflowX: 'auto' } },
          h('table', { 'data-testid': 'dxos-n8n-workflows-table', style: { width: '100%', borderCollapse: 'collapse' } },
            h('thead', null, h('tr', null, ['ID', 'Workflow', 'Nodes', 'Trạng thái', 'Thao tác'].map((c) => h('th', { key: c, style: S.th }, c)))),
            h('tbody', null, !workflows.length
              ? h('tr', null, h('td', { colSpan: 5, style: { ...S.td, color: '#64748B' } }, 'Chưa có workflow trên Stock n8n hoặc thiếu connector n8n_api.'))
              : workflows.map((wf) => h('tr', { key: wf.id },
                h('td', { style: S.td }, h('code', null, wf.id)),
                h('td', { style: S.td }, wf.name || wf.id),
                h('td', { style: S.td }, Array.isArray(wf.nodes) ? wf.nodes.length : '-'),
                h('td', { style: S.td }, h('span', { style: S.badge(wf.active ? 'ok' : 'neutral') }, wf.active ? 'active' : 'paused')),
                h('td', { style: { ...S.td, display: 'flex', gap: 6 } },
                  h('button', { type: 'button', 'data-testid': `dxos-n8n-wf-toggle-${wf.id}`, disabled: busy, onClick: () => runMut('Không bật/tắt được workflow.', async (cApi) => { await cApi.request({ url: 'dxosN8n:activateWorkflow', method: 'post', data: { ...orgPayload, workflowId: wf.id, active: !wf.active } }); await loadAll(); }), style: S.btn('act', busy) }, wf.active ? 'Tạm dừng' : 'Kích hoạt'),
                  h('a', { href: `${editorUrl}/workflow/${encodeURIComponent(String(wf.id))}`, target: '_blank', rel: 'noopener noreferrer', style: S.btn('ghost') }, 'Mở trên n8n Editor ↗'),
                ),
              ))),
          ),
        ),
        h('div', { style: { overflowX: 'auto' } },
          h('table', { 'data-testid': 'dxos-n8n-executions-table', style: { width: '100%', borderCollapse: 'collapse' } },
            h('thead', null, h('tr', null, ['Exec ID', 'Workflow ID', 'Trạng thái', 'Bắt đầu', 'Thao tác'].map((c) => h('th', { key: c, style: S.th }, c)))),
            h('tbody', null, !executions.length
              ? h('tr', null, h('td', { colSpan: 5, style: { ...S.td, color: '#64748B' } }, 'Chưa có lượt chạy Stock n8n nào.'))
              : executions.map((ex) => h('tr', { key: ex.id },
                h('td', { style: S.td }, h('code', null, ex.id)),
                h('td', { style: S.td }, h('code', null, ex.workflowId || '-')),
                h('td', { style: S.td }, h('span', { style: S.badge(ex.status === 'success' ? 'ok' : (ex.status === 'error' ? 'err' : 'warn')) }, ex.status || 'unknown')),
                h('td', { style: S.td }, ex.startedAt ? String(ex.startedAt).slice(0, 19).replace('T', ' ') : '-'),
                h('td', { style: S.td }, h('button', { type: 'button', 'data-testid': `dxos-n8n-exec-retry-${ex.id}`, disabled: busy, onClick: () => runMut('Retry thất bại.', async (cApi) => { await cApi.request({ url: 'dxosN8n:retryExecution', method: 'post', data: { ...orgPayload, executionId: ex.id } }); reportFb({ type: 'success', text: `Đã retry execution #${ex.id}.` }); await loadAll(); }), style: S.btn('run', busy) }, 'Retry')),
              ))),
          ),
        ),
      ),

      modalApp ? h('div', { 'data-testid': 'dxos-app-connect-modal', style: { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.48)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60, padding: 16 } },
        h('div', { style: { width: 560, maxWidth: '100%', background: '#FFFFFF', borderRadius: 14, padding: 18, display: 'grid', gap: 12, boxShadow: '0 20px 44px rgba(15,23,42,0.24)' } },
          h('div', { style: S.rowBetween },
            h('strong', { style: { fontSize: 15 } }, `Kết nối ${modalApp.name}`),
            h('button', { type: 'button', onClick: () => setModalApp(null), style: S.btn('ghost') }, 'Đóng'),
          ),
          (modalApp.authTypes || []).includes('oauth2') ? h('div', { style: S.row },
            h('button', { type: 'button', onClick: () => setWizardMode('oauth2'), style: S.btn(wizardMode === 'oauth2' ? 'act' : 'ghost') }, 'OAuth2 PKCE S256'),
            modalApp.authTypes.length > 1 ? h('button', { type: 'button', onClick: () => setWizardMode('token'), style: S.btn(wizardMode === 'token' ? 'act' : 'ghost') }, 'Token / API Key') : null,
          ) : null,
          wizardMode === 'oauth2' ? h('div', { style: { display: 'grid', gap: 8 } },
            h('div', { style: S.grid },
              h('div', null, h('label', { style: S.lbl }, 'Connector Key'), h('input', { type: 'text', value: form.connectorKey, onChange: (e) => setForm((f) => ({ ...f, connectorKey: e.target.value })), style: S.inp })),
              h('div', null, h('label', { style: S.lbl }, 'Tên hiển thị'), h('input', { type: 'text', value: form.name, onChange: (e) => setForm((f) => ({ ...f, name: e.target.value })), style: S.inp })),
              h('div', null, h('label', { style: S.lbl }, 'Client ID'), h('input', { 'data-testid': 'dxos-app-oauth-clientid-input', type: 'text', value: oauth.clientId, onChange: (e) => setOauth((o) => ({ ...o, clientId: e.target.value })), style: S.inp })),
              h('div', null, h('label', { style: S.lbl }, 'Client Secret'), h('input', { 'data-testid': 'dxos-app-oauth-secret-input', type: 'password', value: oauth.clientSecret, onChange: (e) => setOauth((o) => ({ ...o, clientSecret: e.target.value })), style: S.inp })),
            ),
            h('label', { style: S.lbl }, 'Redirect URI'),
            h('input', { type: 'text', value: oauth.redirectUri, onChange: (e) => setOauth((o) => ({ ...o, redirectUri: e.target.value })), style: S.inp }),
            h('label', { style: S.lbl }, 'Scopes'),
            h('input', { type: 'text', value: oauth.scopes, onChange: (e) => setOauth((o) => ({ ...o, scopes: e.target.value })), style: S.inp }),
            h('button', { type: 'button', 'data-testid': 'dxos-app-oauth-start-btn', disabled: busy, onClick: handleOAuthStart, style: S.btn('pri', busy) }, 'Bắt đầu OAuth2 PKCE'),
            oauth.authorizeUrl ? h('div', { style: S.sub },
              h('a', { 'data-testid': 'dxos-app-oauth-authorize-link', href: oauth.authorizeUrl, target: '_blank', rel: 'noopener noreferrer', style: { fontSize: 12, color: '#1D4ED8', fontWeight: 600 } }, 'Mở trang cấp quyền OAuth2 ↗'),
              h('input', { 'data-testid': 'dxos-app-oauth-code-input', type: 'text', placeholder: 'Dán authorization code tại đây…', value: oauth.code, onChange: (e) => setOauth((o) => ({ ...o, code: e.target.value })), style: S.inp }),
              h('button', { type: 'button', 'data-testid': 'dxos-app-oauth-callback-btn', disabled: busy, onClick: handleOAuthCallback, style: S.btn('run', busy) }, 'Hoàn tất OAuth2 Callback'),
            ) : null,
          ) : h('form', { 'data-testid': 'dxos-app-save-form', onSubmit: handleSaveToken, style: { display: 'grid', gap: 8 } },
            h('div', { style: S.grid },
              h('div', null, h('label', { style: S.lbl }, 'Connector Key'), h('input', { 'data-testid': 'dxos-app-key-input', type: 'text', required: true, value: form.connectorKey, onChange: (e) => setForm((f) => ({ ...f, connectorKey: e.target.value })), style: S.inp })),
              h('div', null, h('label', { style: S.lbl }, 'Tên hiển thị'), h('input', { 'data-testid': 'dxos-app-name-input', type: 'text', required: true, value: form.name, onChange: (e) => setForm((f) => ({ ...f, name: e.target.value })), style: S.inp })),
              h('div', null, h('label', { style: S.lbl }, 'Base URL'), h('input', { 'data-testid': 'dxos-app-url-input', type: 'text', value: form.baseUrl, onChange: (e) => setForm((f) => ({ ...f, baseUrl: e.target.value })), style: S.inp })),
              h('div', null, h('label', { style: S.lbl }, 'Auth Type'), h('select', { 'data-testid': 'dxos-app-authtype-select', value: form.authType, onChange: (e) => setForm((f) => ({ ...f, authType: e.target.value })), style: S.inp }, (modalApp.authTypes || ['api_key', 'bearer', 'hmac', 'basic', 'none']).map((a) => h('option', { key: a, value: a }, a)))),
            ),
            h('label', { style: S.lbl }, `Secrets (${(modalApp.secretFields || ['token']).join(', ')} — JSON hoặc token thô)`),
            h('input', { 'data-testid': 'dxos-app-secret-input', type: 'password', value: form.secretsText, placeholder: '{"botToken":"..."} hoặc token thô', onChange: (e) => setForm((f) => ({ ...f, secretsText: e.target.value })), style: S.inp }),
            h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
              h('button', { type: 'submit', 'data-testid': 'dxos-app-save-btn', disabled: busy, style: S.btn('pri', busy) }, 'Lưu vào Secrets Vault'),
            ),
          ),
        ),
      ) : null,
    );
  };
}

module.exports = { DEFAULT_APP_CATALOG, createConnectedAppsPanel };
