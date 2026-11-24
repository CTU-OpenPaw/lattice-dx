/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const N8N_WEBHOOK_PRESETS = Object.freeze([
  {
    key: 'enterprise-compliance-orchestrator',
    connectorKey: 'n8n-enterprise-orchestrator',
    name: 'Enterprise Multi-System Compliance & PKI Orchestrator (17 nodes · 4 hệ thống)',
    path: '/webhook/latticedx/v1/enterprise-compliance-orchestrator',
    blueprintKey: 'auto_enterprise_n8n_compliance',
    description: 'HMAC-SHA256 + Switch 3 nhánh + song song 4 hệ thống: NocoBase PKI, FIWARE Orion-LD, Node-RED/MQTT Interlock & Partner Dossier.',
  },
  {
    key: 'alert-orchestrator',
    connectorKey: 'n8n-coldchain-orchestrator',
    name: 'Telemetry Alert & Work-Order Orchestrator (8 nodes)',
    path: '/webhook/latticedx/v1/coldchain-alert',
    blueprintKey: 'auto_cmms_on_coldchain_fault',
    description: 'Xác thực chữ ký Standard Webhooks, phân tuyến sự cố thiết bị và kích hoạt quy trình xử lý tự động.',
  },
  {
    key: 'epod-partner-sync',
    connectorKey: 'erp-webhook-sync',
    name: 'ePOD & Voucher PKI Partner Sync (9 nodes)',
    path: '/webhook/latticedx/v1/epod-partner-sync',
    blueprintKey: 'auto_partner_webhook_sync',
    description: 'Nhận chứng từ giao nhận từ đối tác và ký xác thực Ed25519 lên sổ cái LatticeDX.',
  },
]);

function resolveN8nEditorUrl(baseUrl) {
  const raw = String(baseUrl || '').trim();
  if (!raw) return 'http://localhost:5678';
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) return 'http://localhost:5678';
    const host = String(parsed.hostname || '').toLowerCase();
    if (host === 'n8n') {
      const port = parsed.port ? `:${parsed.port}` : ':5678';
      return `${parsed.protocol}//localhost${port}`;
    }
    return parsed.origin;
  } catch {
    return 'http://localhost:5678';
  }
}

const buildSecretPayload = (authType, rawSecret) => {
  const clean = String(rawSecret || '').trim();
  if (!clean || authType === 'none') return null;
  if (clean.startsWith('{')) { try { return JSON.parse(clean); } catch {} }
  if (authType === 'bearer') return { token: clean };
  if (authType === 'api_key') return { apiKey: clean };
  if (authType === 'basic') return { username: 'n8n', password: clean };
  return { secret: clean };
};

function createN8nSetupModal(React) {
  const h = React.createElement;
  const INP = { width: '100%', padding: '6px 9px', borderRadius: 7, border: '1px solid #CBD5E1', fontSize: 12, background: '#FFFFFF', color: '#0F172A', boxSizing: 'border-box' };
  const BTN = (tone = 'ghost', dis = false) => {
    const c = {
      pri: ['#2563EB', '#FFFFFF', '#2563EB'],
      run: ['#0F766E', '#FFFFFF', '#0F766E'],
      act: ['#EFF6FF', '#1D4ED8', '#93C5FD'],
      ghost: ['#FFFFFF', '#0F172A', '#CBD5E1'],
    }[tone] || ['#FFFFFF', '#0F172A', '#CBD5E1'];
    return { padding: '6px 11px', borderRadius: 7, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', cursor: dis ? 'not-allowed' : 'pointer', opacity: dis ? 0.6 : 1, background: c[0], color: c[1], border: `1px solid ${c[2]}` };
  };

  return function N8nSetupModal(props = {}) {
    const { open = false, api = null, organizationId = '', selectedNode = null, onClose, onConnectorsChanged, onApplyToSelectedNode, onOpenEnterpriseBlueprint } = props;
    const [connectors, setConnectors] = React.useState([]);
    const [loading, setLoading] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const [status, setStatus] = React.useState(null);
    const [testRes, setTestRes] = React.useState(null);
    const [form, setForm] = React.useState({ connectorKey: 'n8n-enterprise-orchestrator', name: 'n8n Enterprise Orchestrator', baseUrl: 'http://n8n:5678', authType: 'hmac', secret: '' });
    const [refs] = React.useState(() => ({ api }));
    refs.api = api;

    const loadConnectors = React.useCallback(async () => {
      const cApi = refs.api;
      if (!cApi?.request || !organizationId) return;
      setLoading(true);
      try {
        const res = await cApi.request({ url: 'dxosVault:list', method: 'get', params: { organizationId }, skipNotify: true });
        const items = res?.data?.data?.items || res?.data?.items || [];
        setConnectors(Array.isArray(items) ? items : []);
      } catch (err) {
        setStatus({ type: 'error', text: err?.message || 'Không tải được danh sách connector.' });
      } finally {
        setLoading(false);
      }
    }, [organizationId, Boolean(api?.request)]);

    React.useEffect(() => {
      if (open) { setStatus(null); setTestRes(null); loadConnectors(); }
    }, [open, organizationId, loadConnectors]);

    if (!open) return null;

    const n8nConnectors = connectors.filter((c) => c && (c.connectorType === 'n8n' || String(c.connectorKey || '').includes('n8n') || String(c.baseUrl || '').includes('5678')));
    const editorUrl = resolveN8nEditorUrl(form.baseUrl || n8nConnectors[0]?.baseUrl);
    const canAttachNode = selectedNode?.type === 'integration.http';

    const handleSave = async (e) => {
      e?.preventDefault?.();
      if (!api?.request || !organizationId) return setStatus({ type: 'error', text: 'Thiếu Organization ID hoặc API client.' });
      setBusy(true);
      setStatus(null);
      try {
        const secrets = buildSecretPayload(form.authType, form.secret);
        await api.request({
          url: 'dxosVault:save',
          method: 'post',
          data: {
            organizationId,
            connectorKey: String(form.connectorKey || '').trim(),
            name: String(form.name || '').trim(),
            connectorType: 'n8n',
            baseUrl: String(form.baseUrl || '').trim(),
            authType: form.authType || 'hmac',
            ...(secrets ? { secrets } : {}),
            active: true,
          },
        });
        setForm((f) => ({ ...f, secret: '' }));
        setStatus({ type: 'ok', text: `Đã lưu kết nối n8n "${form.connectorKey}" (secret đã mã hóa AES-256-GCM).` });
        await loadConnectors();
        onConnectorsChanged?.();
      } catch (err) {
        setStatus({ type: 'error', text: err?.response?.data?.errors?.[0]?.message || err?.message || 'Lưu connector n8n thất bại.' });
      } finally {
        setBusy(false);
      }
    };

    const handleTest = async (connectorKey) => {
      if (!api?.request || !organizationId) return;
      setBusy(true);
      setTestRes(null);
      try {
        const res = await api.request({ url: 'dxosVault:testConnection', method: 'post', data: { organizationId, connectorKey } });
        const d = res?.data?.data || res?.data || {};
        setTestRes({ ...d, connectorKey });
        await loadConnectors();
      } catch (err) {
        setTestRes({ ok: false, connectorKey, statusCode: null, latencyMs: 0, message: err?.message || 'Kiểm tra kết nối thất bại.' });
      } finally {
        setBusy(false);
      }
    };

    return h('div', { 'data-testid': 'dxos-n8n-setup-modal', style: { position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.48)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 55, padding: 16 } },
      h('div', { style: { width: 760, maxWidth: '100%', maxHeight: '90vh', overflowY: 'auto', background: '#FFFFFF', borderRadius: 14, padding: 18, display: 'grid', gap: 14, boxShadow: '0 20px 44px rgba(15,23,42,0.24)' } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
          h('div', null,
            h('strong', { style: { fontSize: 15, color: '#0F172A' } }, '⚡ Kết nối & Điều phối Dịch vụ n8n'),
            h('div', { style: { fontSize: 12, color: '#64748B' } }, 'n8n chạy như microservice độc lập; cấu hình URL, xác thực HMAC/Bearer và gắn luồng n8n trực tiếp ngay tại đây.'),
          ),
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
            h('a', { 'data-testid': 'dxos-n8n-open-editor-link', href: editorUrl, target: '_blank', rel: 'noopener noreferrer', style: { ...BTN('act'), textDecoration: 'none', display: 'inline-flex', alignItems: 'center' } }, 'Mở n8n Editor ↗'),
            h('button', { type: 'button', 'data-testid': 'dxos-n8n-close-btn', onClick: () => onClose?.(), style: BTN('ghost') }, 'Đóng'),
          ),
        ),

        status ? h('div', { 'data-testid': 'dxos-n8n-status-banner', role: 'status', style: { padding: '8px 12px', borderRadius: 8, fontSize: 12, background: status.type === 'ok' ? '#ECFDF5' : '#FEF2F2', color: status.type === 'ok' ? '#047857' : '#991B1B', border: `1px solid ${status.type === 'ok' ? '#A7F3D0' : '#FECACA'}` } }, status.text) : null,
        testRes ? h('div', { 'data-testid': 'dxos-n8n-test-result', role: 'status', style: { padding: '8px 12px', borderRadius: 8, fontSize: 12, background: testRes.ok ? '#ECFDF5' : '#FEF2F2', color: testRes.ok ? '#047857' : '#991B1B', border: `1px solid ${testRes.ok ? '#A7F3D0' : '#FECACA'}` } }, `Ping "${testRes.connectorKey}": ${testRes.ok ? 'OK' : 'FAILED'} · HTTP ${testRes.statusCode ?? '-'} · ${testRes.latencyMs ?? 0}ms · ${testRes.message || ''}`) : null,

        h('form', { 'data-testid': 'dxos-n8n-save-form', onSubmit: handleSave, style: { padding: 12, borderRadius: 10, background: '#F8FAFC', border: '1px solid #E2E8F0', display: 'grid', gap: 10 } },
          h('strong', { style: { fontSize: 12, color: '#0F172A' } }, '1. Đăng ký / Cập nhật Service n8n vào Secrets Vault'),
          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 } },
            h('input', { 'data-testid': 'dxos-n8n-key-input', type: 'text', required: true, value: form.connectorKey, placeholder: 'Connector key', onChange: (e) => setForm((f) => ({ ...f, connectorKey: e?.target?.value ?? '' })), style: INP }),
            h('input', { 'data-testid': 'dxos-n8n-name-input', type: 'text', required: true, value: form.name, placeholder: 'Tên hiển thị', onChange: (e) => setForm((f) => ({ ...f, name: e?.target?.value ?? '' })), style: INP }),
            h('input', { 'data-testid': 'dxos-n8n-url-input', type: 'text', required: true, value: form.baseUrl, placeholder: 'http://n8n:5678', onChange: (e) => setForm((f) => ({ ...f, baseUrl: e?.target?.value ?? '' })), style: INP }),
            h('select', { 'data-testid': 'dxos-n8n-auth-select', value: form.authType, onChange: (e) => setForm((f) => ({ ...f, authType: e?.target?.value ?? 'hmac' })), style: INP }, ['hmac', 'bearer', 'api_key', 'none'].map((a) => h('option', { key: a, value: a }, a))),
            h('input', { 'data-testid': 'dxos-n8n-secret-input', type: 'password', value: form.secret, placeholder: 'DX_WEBHOOK_SECRET / Token', onChange: (e) => setForm((f) => ({ ...f, secret: e?.target?.value ?? '' })), style: INP }),
          ),
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
            h('button', { type: 'submit', 'data-testid': 'dxos-n8n-save-btn', disabled: busy, style: BTN('pri', busy) }, busy ? 'Đang lưu…' : 'Lưu cấu hình n8n'),
          ),
        ),

        h('div', { style: { display: 'grid', gap: 6 } },
          h('strong', { style: { fontSize: 12, color: '#0F172A' } }, `2. Dịch vụ n8n đã cấu hình (${n8nConnectors.length})`),
          loading ? h('span', { style: { fontSize: 12, color: '#64748B' } }, 'Đang kiểm tra…') : !n8nConnectors.length
            ? h('span', { style: { fontSize: 12, color: '#64748B' } }, 'Chưa có connector n8n nào cho tổ chức này.')
            : n8nConnectors.map((c) => h('div', { key: c.connectorKey, 'data-testid': `dxos-n8n-connector-row-${c.connectorKey}`, style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 8, border: '1px solid #E2E8F0', background: '#FFFFFF', flexWrap: 'wrap' } },
              h('div', { style: { display: 'grid', gap: 2 } },
                h('span', { style: { fontSize: 12, fontWeight: 700, color: '#0F172A' } }, `${c.name || c.connectorKey} (${c.connectorKey})`),
                h('span', { style: { fontSize: 11, color: '#475569' } }, `${c.baseUrl || ''} · ${c.authType || 'none'} · secret=${c.hasSecrets ? 'encrypted' : 'none'} · ${c.lastTestStatus || 'untested'}`),
              ),
              h('div', { style: { display: 'flex', gap: 6 } },
                h('button', { type: 'button', 'data-testid': `dxos-n8n-use-${c.connectorKey}`, onClick: () => setForm((f) => ({ ...f, connectorKey: c.connectorKey, name: c.name || f.name, baseUrl: c.baseUrl || f.baseUrl, authType: c.authType || f.authType })), style: BTN('ghost') }, 'Nạp vào form'),
                h('button', { type: 'button', 'data-testid': `dxos-n8n-test-${c.connectorKey}`, disabled: busy, onClick: () => handleTest(c.connectorKey), style: BTN('run', busy) }, 'Test /healthz'),
              ),
            )),
        ),

        h('div', { style: { display: 'grid', gap: 6 } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 } },
            h('strong', { style: { fontSize: 12, color: '#0F172A' } }, '3. Luồng nghiệp vụ n8n sẵn dùng (n8n Webhooks)'),
            onOpenEnterpriseBlueprint ? h('button', { type: 'button', 'data-testid': 'dxos-n8n-open-blueprint-btn', onClick: () => { onOpenEnterpriseBlueprint(); onClose?.(); }, style: BTN('pri') }, '⚡ Mở Blueprint n8n Enterprise trên Canvas') : null,
          ),
          N8N_WEBHOOK_PRESETS.map((p, idx) => h('div', { key: p.key, style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 8, border: '1px solid #E2E8F0', background: '#F8FAFC', flexWrap: 'wrap' } },
            h('div', { style: { display: 'grid', gap: 2, flex: '1 1 320px' } },
              h('span', { style: { fontSize: 12, fontWeight: 700, color: '#0F172A' } }, p.name),
              h('code', { style: { fontSize: 11, color: '#1D4ED8' } }, p.path),
              h('span', { style: { fontSize: 11, color: '#64748B' } }, p.description),
            ),
            canAttachNode ? h('button', { type: 'button', 'data-testid': `dxos-n8n-apply-preset-${idx}`, onClick: () => { onApplyToSelectedNode?.(p); onClose?.(); }, style: BTN('act') }, 'Gắn vào node đang chọn') : null,
          )),
        ),
      ),
    );
  };
}

module.exports = { N8N_WEBHOOK_PRESETS, resolveN8nEditorUrl, createN8nSetupModal };
