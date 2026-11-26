/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const DEFAULT_AGENT_TOOLS = [
  'memory_recall',
  'memory_store',
  'dxos_search_enterprise_context',
  'dxos_my_workflow_tasks',
  'dxos_graph_impact_analysis',
  'dxos_execute_record_action',
  'dxos_alarm_action',
];

const shSingleQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

function buildWebhookCurlCommand({ origin, organizationId, ruleKey, authMode, secretHeader, samplePayloadText }) {
  const safeOrigin = String(origin || 'http://localhost:13014').replace(/[\r\n\t\0]/g, '').replace(/\/+$/, '');
  const url = `${safeOrigin}/api/dxosAutomations:webhookIngress?organizationId=${encodeURIComponent(String(organizationId || 'default'))}&ruleKey=${encodeURIComponent(String(ruleKey || 'flow_rule'))}`;
  const mode = String(authMode || 'hmac').toLowerCase();
  const hdrName = String(secretHeader || 'X-Lattice-Signature-256').replace(/[^A-Za-z0-9!#$%&'*+.^_`|~-]/g, '').trim() || 'X-Lattice-Signature-256';
  const authHeaderVal = mode === 'bearer'
    ? 'Authorization: Bearer <WEBHOOK_BEARER_TOKEN>'
    : `${hdrName}: sha256=<WEBHOOK_HMAC_SHA256_HEX>`;
  const body = String(samplePayloadText || '{"code":"WH-01"}');
  return `curl -X POST ${shSingleQuote(url)} \\\n  -H 'Content-Type: application/json' \\\n  -H ${shSingleQuote(authHeaderVal)} \\\n  -d ${shSingleQuote(body)}`;
}

function renderTraceIoView(h, { displayOut, activeTrace, formatJson, statusTone, S }) {
  const resolvedOut = displayOut || null;
  if (!resolvedOut) {
    return h('div', { 'data-testid': 'dxos-flow-output-view', style: S.card },
      h('span', { style: { fontSize: 12, color: '#64748b' } }, 'No test output or trace yet. Run "Test This Node" or Dry-Run.'),
    );
  }
  const traceInput = resolvedOut.input !== undefined ? resolvedOut.input : (activeTrace?.input !== undefined ? activeTrace.input : null);
  return h('div', { 'data-testid': 'dxos-flow-output-view', style: S.card },
    h('div', { style: S.rowBetween },
      h('span', { 'data-testid': 'dxos-flow-output-status', style: S.badge(statusTone(resolvedOut.status)) }, resolvedOut.status || 'completed'),
      h('span', { style: { fontSize: 11, color: '#475569' } }, `${resolvedOut.durationMs ?? 0} ms · nextPort: ${resolvedOut.nextPort || resolvedOut.nextPorts?.[0] || '-'}`),
    ),
    (resolvedOut.error || resolvedOut.reason)
      ? h('div', { style: { padding: 8, borderRadius: 6, background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', fontSize: 11 } }, String(resolvedOut.error || resolvedOut.reason))
      : null,
    h('div', { style: S.grid(3) },
      h('span', { style: { ...S.label, marginBottom: 0 } }, 'Input JSON'),
      h('pre', { 'data-testid': 'dxos-flow-trace-input-json', style: { margin: 0, padding: 8, borderRadius: 6, background: '#1e293b', color: '#cbd5e1', fontSize: 11, overflowX: 'auto', maxHeight: 160 } }, formatJson(traceInput, null)),
    ),
    h('div', { style: S.grid(3) },
      h('span', { style: { ...S.label, marginBottom: 0 } }, 'Output JSON'),
      h('pre', { 'data-testid': 'dxos-flow-output-json', style: { margin: 0, padding: 8, borderRadius: 6, background: '#0f172a', color: '#e2e8f0', fontSize: 11, overflowX: 'auto', maxHeight: 240 } }, formatJson(resolvedOut.output !== undefined ? resolvedOut.output : resolvedOut, null)),
    ),
  );
}

function createWebhookHelperComponent(React, S) {
  const h = React.createElement;
  return function WebhookHelper({ nodeId, nodeCfg, ruleKey, orgKey, onTestNode, onDryRunWebhook, onSwitchToOutput, testBusy }) {
    const [sampleText, setSampleText] = React.useState('{"code":"WH-01","source":"webhook"}');
    const [copied, setCopied] = React.useState(false);
    const origin = (typeof window !== 'undefined' && window?.location?.origin) ? window.location.origin : 'http://localhost:13014';
    const ingressPath = `/api/dxosAutomations:webhookIngress?organizationId=${encodeURIComponent(String(orgKey || 'default'))}&ruleKey=${encodeURIComponent(String(ruleKey || 'flow_rule'))}`;
    const configuredWebhookPath = String(nodeCfg?.webhookPath || '').trim();
    const curlCmd = buildWebhookCurlCommand({
      origin,
      organizationId: orgKey,
      ruleKey,
      authMode: nodeCfg?.authMode,
      secretHeader: nodeCfg?.secretHeader,
      samplePayloadText: sampleText,
    });
    const parseSample = () => {
      try { const p = JSON.parse(sampleText || '{}'); return (p && typeof p === 'object' && !Array.isArray(p)) ? p : { payload: p }; }
      catch { return { raw: sampleText }; }
    };
    return h('div', { 'data-testid': 'dxos-flow-webhook-helper', style: { ...S.card, background: '#f0f9ff', border: '1px solid #bae6fd' } },
      h('div', { style: S.rowBetween },
        h('strong', { style: { fontSize: 12, color: '#0369a1' } }, 'Kiểm thử Webhook & Lệnh cURL'),
        h('button', {
          type: 'button',
          'data-testid': 'dxos-flow-webhook-copy-btn',
          onClick: () => {
            try { if (typeof navigator !== 'undefined') navigator?.clipboard?.writeText?.(curlCmd); } catch {}
            setCopied(true);
          },
          style: S.btn(false, false, false),
        }, copied ? '✓ Đã chép' : 'Sao chép cURL'),
      ),
      h('div', { 'data-testid': 'dxos-flow-webhook-endpoints', style: { display: 'grid', gap: 3, padding: '6px 8px', borderRadius: 6, background: '#e0f2fe', fontSize: 11, color: '#0c4a6e' } },
        h('div', null, h('strong', null, 'URL nhận Webhook Ingress: '), h('code', null, `POST ${ingressPath}`)),
        h('div', null, h('strong', null, 'Đường dẫn cấu hình (webhookPath): '), h('code', null, configuredWebhookPath || '(chưa cấu hình)')),
      ),
      h('pre', { 'data-testid': 'dxos-flow-webhook-curl', style: { margin: 0, padding: 8, borderRadius: 6, background: '#0f172a', color: '#e2e8f0', fontSize: 10, overflowX: 'auto', whiteSpace: 'pre-wrap' } }, curlCmd),
      h('textarea', {
        'data-testid': 'dxos-flow-webhook-sample-input',
        rows: 2,
        value: sampleText,
        onChange: (e) => setSampleText(e?.target?.value ?? ''),
        style: S.textarea,
      }),
      h('div', { style: S.rowWrap },
        h('button', {
          type: 'button',
          'data-testid': 'dxos-flow-webhook-test-btn',
          disabled: Boolean(testBusy),
          onClick: () => {
            const sampleObj = parseSample();
            onSwitchToOutput?.();
            onTestNode?.(nodeId, {
              event: { type: 'webhook.inbound', data: sampleObj },
              data: sampleObj,
              webhook: { webhookPath: nodeCfg?.webhookPath || '', authMode: nodeCfg?.authMode || 'hmac' },
            });
          },
          style: S.btn(true, false, Boolean(testBusy)),
        }, testBusy ? 'Đang thử…' : 'Thử Trigger'),
        onDryRunWebhook ? h('button', {
          type: 'button',
          'data-testid': 'dxos-flow-webhook-dryrun-btn',
          onClick: () => onDryRunWebhook(parseSample()),
          style: S.btn(false, false, false),
        }, 'Chạy thử luồng') : null,
      ),
    );
  };
}

function renderToolsPicker(h, { val, catalog, updateConfigField, inputStyle }) {
  const options = Array.isArray(catalog?.agentTools) && catalog.agentTools.length ? catalog.agentTools : DEFAULT_AGENT_TOOLS;
  const cur = Array.isArray(val) ? val : [];
  return h('select', {
    'data-testid': 'dxos-flow-field-tools-picker',
    value: '',
    style: inputStyle,
    onChange: (e) => {
      const picked = e?.target?.value;
      if (picked) updateConfigField('tools', cur.includes(picked) ? cur : [...cur, picked]);
    },
  },
    h('option', { value: '' }, '+ Thêm công cụ được phép...'),
    options.map((t) => h('option', { key: t, value: t }, t)),
  );
}

module.exports = {
  DEFAULT_AGENT_TOOLS,
  buildWebhookCurlCommand,
  renderTraceIoView,
  createWebhookHelperComponent,
  renderToolsPicker,
};
