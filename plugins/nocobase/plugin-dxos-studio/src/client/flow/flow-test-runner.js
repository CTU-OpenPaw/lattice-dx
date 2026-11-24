/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const BLOCKED_JSON_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function parseSampleEventJson(text) {
  try {
    const val = JSON.parse(String(text || ''), (k, v) => {
      if (BLOCKED_JSON_KEYS.has(k)) throw new Error(`Blocked key "${k}"`);
      return v;
    });
    if (!val || typeof val !== 'object' || Array.isArray(val)) return { ok: false, error: 'Payload phải là JSON object.' };
    return { ok: true, value: val };
  } catch (err) {
    return { ok: false, error: err?.message || 'JSON không hợp lệ' };
  }
}

function inferPrimaryEventType(rule, graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const trig = nodes.find((n) => String(n?.type || '').startsWith('trigger.'));
  const cfg = trig?.config || {};
  if (trig?.type === 'trigger.record' && cfg.collection) return `record.${cfg.collection}.${cfg.operation || 'create'}`;
  if (trig?.type === 'trigger.event' && cfg.eventType) return String(cfg.eventType).split(',')[0].trim() || 'alarm.triggered';
  if (trig?.type === 'trigger.webhook') return `webhook.${cfg.webhookPath || 'inbound'}`;
  if (trig?.type === 'trigger.schedule') return 'schedule.cron';
  return String(rule?.triggerEventType || 'manual.trigger').split(',')[0].trim() || 'manual.trigger';
}

function buildScenarioPresets(rule, graph) {
  const evtType = inferPrimaryEventType(rule, graph);
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const presets = [];
  if (rule?.sampleEvent && typeof rule.sampleEvent === 'object') {
    presets.push({ key: 'saved', label: 'Payload đã lưu', event: rule.sampleEvent });
  }
  for (const n of nodes) {
    if (n?.type !== 'control.if' || !n.config?.condition?.field) continue;
    const rawField = String(n.config.condition.field);
    const fieldName = rawField.startsWith('data.') ? rawField.slice(5) : rawField;
    const op = String(n.config.condition.op || 'eq');
    const cmpVal = n.config.condition.value;
    const numVal = Number(cmpVal);
    if ((op === 'gt' || op === 'gte') && Number.isFinite(numVal)) {
      const highVal = numVal >= 1000 ? numVal * 2 + 20000000 : numVal + 10;
      const lowVal = Math.max(0, Math.floor(numVal / 3));
      presets.push({ key: `if_hit_${fieldName}`, label: `Nhánh HITL (${fieldName} > ${numVal.toLocaleString('en-US')})`, event: { type: evtType, data: { id: 1, code: 'REQ-HITL-01', [fieldName]: highVal, title: 'Đề xuất vượt ngưỡng phê duyệt' } } });
      presets.push({ key: `if_std_${fieldName}`, label: `Nhánh tiêu chuẩn (${fieldName} <= ${numVal.toLocaleString('en-US')})`, event: { type: evtType, data: { id: 1, code: 'REQ-STD-01', [fieldName]: lowVal, title: 'Đề xuất tiêu chuẩn' } } });
      break;
    }
    if (op === 'eq' && cmpVal !== undefined && fieldName) {
      presets.push({ key: `if_eq_${fieldName}`, label: `Nhánh True (${fieldName}=${cmpVal})`, event: { type: evtType, data: { [fieldName]: cmpVal, deviceKey: 'cold-truck-ct-01', assetId: 4 } } });
      break;
    }
  }
  if (evtType.includes('alarm.triggered')) {
    presets.push({ key: 'alarm_critical', label: 'Sự cố Critical (CMMS + HITL)', event: { type: 'alarm.triggered', data: { severity: 'critical', deviceKey: 'cold-truck-ct-01', assetId: 4, temperatureC: -11.4, message: 'Kho lạnh vượt ngưỡng -15°C' } } });
    presets.push({ key: 'alarm_warning', label: 'Cảnh báo Warning', event: { type: 'alarm.triggered', data: { severity: 'warning', deviceKey: 'cold-truck-ct-01', assetId: 4, temperatureC: -17.8 } } });
  }
  if (nodes.some((n) => n?.type === 'integration.http' && (String(n.config?.connectorKey || '').includes('n8n') || String(n.config?.path || '').includes('orchestrator')))) {
    presets.push({
      key: 'n8n_critical_batch',
      label: 'n8n Critical Batch (PKI Sign)',
      event: { type: evtType, data: { id: 1, code: 'REQ-COMP-01', amount: 125000000, severity: 'critical', temperatureC: -9.5, slaOverdueMinutes: 45, items: [{ sku: 'LOT-A1', qty: 40, value: 75000000 }, { sku: 'LOT-B2', qty: 25, value: 50000000 }] } },
    });
    presets.push({
      key: 'n8n_escalated',
      label: 'n8n Escalated Branch',
      event: { type: evtType, data: { id: 1, code: 'REQ-ESC-02', amount: 35000000, severity: 'high', slaOverdueMinutes: 20, items: [{ sku: 'LOT-C3', qty: 10, value: 35000000 }] } },
    });
  }
  if (!presets.length) {
    presets.push({ key: 'default', label: 'Sự kiện mặc định', event: { type: evtType, data: { id: 1, status: 'active', severity: 'high' } } });
  }
  return presets.slice(0, 4);
}

function createFlowTestRunner(React) {
  const h = React.createElement;
  const B = (bg, col, bdr, dis) => ({
    padding: '5px 10px', borderRadius: 7, fontSize: 12, fontWeight: 600,
    cursor: dis ? 'not-allowed' : 'pointer', opacity: dis ? 0.6 : 1,
    background: dis ? '#E2E8F0' : bg, color: dis ? '#64748B' : col, border: `1px solid ${dis ? '#CBD5E1' : bdr}`,
  });

  return function FlowTestRunner(props = {}) {
    const { open = false, rule = null, graph = null, busyDryRun = false, busyRunNow = false, onClose, onDryRun, onRunNow, onUpdateSampleEvent } = props;
    const presets = React.useMemo(() => buildScenarioPresets(rule, graph), [rule, graph]);
    const ruleKey = rule?.ruleKey || '__draft__';
    const [text, setText] = React.useState(() => JSON.stringify(presets[0]?.event || { type: 'manual.trigger', data: {} }, null, 2));
    const [err, setErr] = React.useState(null);
    const [scopeRef] = React.useState(() => ({ ruleKey: '', wasOpen: false }));

    React.useEffect(() => {
      if ((open && !scopeRef.wasOpen) || (open && scopeRef.ruleKey !== ruleKey)) {
        scopeRef.wasOpen = open;
        scopeRef.ruleKey = ruleKey;
        setText(JSON.stringify(presets[0]?.event || { type: 'manual.trigger', data: {} }, null, 2));
        setErr(null);
      } else if (!open) {
        scopeRef.wasOpen = false;
      }
    }, [open, ruleKey, presets]);

    if (!open) return null;

    const applyPreset = (p) => {
      setText(JSON.stringify(p.event, null, 2));
      setErr(null);
      onUpdateSampleEvent?.(p.event);
    };

    const runWith = (fn) => {
      const parsed = parseSampleEventJson(text);
      if (!parsed.ok) return setErr(parsed.error);
      onUpdateSampleEvent?.(parsed.value);
      return fn?.(parsed.value);
    };

    return h('div', {
      'data-testid': 'dxos-flow-test-runner-popover',
      style: {
        position: 'absolute', top: 54, right: 14, zIndex: 36, width: 396, maxWidth: 'calc(100% - 28px)',
        padding: 14, borderRadius: 12, border: '1px solid #CBD5E1', background: '#FFFFFF',
        boxShadow: '0 14px 36px rgba(15, 23, 42, 0.16)', display: 'grid', gap: 10, boxSizing: 'border-box',
      },
    },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 } },
        h('strong', { style: { fontSize: 13, color: '#0F172A' } }, '🧪 Test Payload Runner'),
        h('button', { type: 'button', 'data-testid': 'dxos-flow-runner-close-btn', onClick: () => onClose?.(), style: B('#F8FAFC', '#334155', '#CBD5E1', false) }, '×'),
      ),
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
        presets.map((p, idx) => h('button', {
          key: p.key || idx, type: 'button', 'data-testid': `dxos-flow-preset-${idx}`,
          onClick: () => applyPreset(p),
          style: { padding: '4px 9px', borderRadius: 999, border: '1px solid #93C5FD', background: '#EFF6FF', color: '#1D4ED8', fontSize: 11, fontWeight: 600, cursor: 'pointer' },
        }, p.label)),
      ),
      h('textarea', {
        'data-testid': 'dxos-flow-sample-event-textarea', rows: 7, value: text,
        onChange: (e) => {
          const next = e?.target?.value ?? '';
          setText(next);
          const p = parseSampleEventJson(next);
          setErr(p.ok ? null : p.error);
        },
        style: { width: '100%', boxSizing: 'border-box', padding: 8, borderRadius: 8, border: `1px solid ${err ? '#EF4444' : '#CBD5E1'}`, fontFamily: 'monospace', fontSize: 11, background: '#F8FAFC', color: '#0F172A' },
      }),
      err ? h('span', { 'data-testid': 'dxos-flow-runner-error', style: { fontSize: 11, color: '#B91C1C' } }, err) : null,
      h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
        h('button', { type: 'button', 'data-testid': 'dxos-flow-runner-dryrun-btn', disabled: Boolean(busyDryRun || err), onClick: () => runWith(onDryRun), style: B('#EFF6FF', '#1D4ED8', '#93C5FD', Boolean(busyDryRun || err)) }, busyDryRun ? 'Đang mô phỏng…' : '▶ Chạy thử (Dry-Run)'),
        h('button', { type: 'button', 'data-testid': 'dxos-flow-runner-live-btn', disabled: Boolean(busyRunNow || err), onClick: () => runWith(onRunNow), style: B('#0F766E', '#FFFFFF', '#0F766E', Boolean(busyRunNow || err)) }, busyRunNow ? 'Đang chạy…' : '⚡ Chạy thật (Run Now)'),
      ),
    );
  };
}

module.exports = { parseSampleEventJson, inferPrimaryEventType, buildScenarioPresets, createFlowTestRunner };
