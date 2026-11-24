/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const DEFAULT_NODES = [
  ['trigger.event', 'trigger', 'Event Trigger', ['main'], { eventType: '*' }],
  ['trigger.manual', 'trigger', 'Manual Trigger', ['main'], {}],
  ['control.if', 'control', 'Conditional IF', ['true', 'false', 'error'], { condition: { field: 'data.severity', op: 'eq', value: 'high' } }],
  ['control.approval', 'control', 'Human Approval', ['approved', 'rejected', 'error'], { approverRole: 'ldx_manager', title: 'Review' }],
  ['data.create', 'data', 'Create Record', ['main', 'error'], { collection: 'latticeServiceTickets', values: {} }],
  ['logic.dmn', 'logic', 'DMN Decision', ['main', 'error'], { tableKey: 'cmms_priority_routing_v1' }],
  ['ai.llm', 'ai', 'LLM Prompt', ['main', 'error'], { userPrompt: '{{data}}' }],
  ['notify.send', 'integration', 'Send Notification', ['main', 'error'], { roleNames: ['ldx_operator'], title: 'Alert' }],
].map(([type, category, label, outputs, defaultConfig]) => ({
  type, category, label, inputs: category === 'trigger' ? [] : ['in'], outputs, defaultConfig, inputSchema: { fields: [] },
}));

const DEFAULT_BLUEPRINTS = [
  ['auto_cmms_on_coldchain_fault', 'Cold-Chain CMMS Emergency', 'cold-chain', 'trigger.event', { eventType: 'alarm.triggered' }, 'data.create', 'Create Work Order', { collection: 'latticeCustomWorkOrders' }],
  ['auto_mkt_quarantine_response', 'MKT Lot Quarantine', 'wms', 'trigger.event', { eventType: 'lot.held_mkt' }, 'data.create', 'Open Incident', { collection: 'latticeIncidentCases' }],
  ['auto_sla_breach_escalation', 'SLA Breach Escalation', 'sla', 'trigger.event', { eventType: 'sla.warning,sla.breached' }, 'data.create', 'Create SLA Ticket', { collection: 'latticeServiceTickets', values: { serviceType: 'facilities', priority: 'high' } }],
  ['auto_procurement_hitl_approval', 'Procurement HITL Approval', 'erp-procurement', 'trigger.record', { collection: 'latticeRequests', operation: 'create' }, 'control.approval', 'Director Approval', { approverRole: 'ldx_manager' }],
  ['auto_scheduled_ai_digest', 'Scheduled AI Ops Digest', 'ai-ops', 'trigger.schedule', { cron: '0 8 * * 1-5' }, 'ai.llm', 'AI Digest', { userPrompt: 'Summarize incidents' }],
  ['auto_partner_webhook_sync', 'Partner B2B Webhook Sync', 'b2b-integration', 'trigger.webhook', { webhookPath: 'partner-sync', authMode: 'hmac' }, 'integration.http', 'Sync Connector', { connectorKey: 'erp-webhook-sync', method: 'POST' }],
].map(([ruleKey, name, category, tType, tCfg, sType, sLabel, sCfg]) => ({
  blueprintKey: ruleKey, ruleKey, name, category, active: true, cooldownSec: 60, maxDepth: 8,
  graphJson: {
    version: 2,
    edges: [{ id: 'e_1', source: 'trig_1', sourceHandle: 'main', target: 'step_1', targetHandle: 'in' }],
    nodes: [
      { id: 'trig_1', type: tType, label: 'Trigger', position: { x: 80, y: 180 }, config: tCfg },
      { id: 'step_1', type: sType, label: sLabel, position: { x: 380, y: 180 }, config: sCfg },
    ],
    settings: { errorPolicy: 'stop', cooldownSec: 60, maxDepth: 8, timeoutMs: 30000 },
  },
}));

const ROW = { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'nowrap', flexShrink: 0 };
const INP = { padding: '5px 8px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 12, background: '#ffffff', color: '#0f172a', width: '100%', boxSizing: 'border-box' };
const unwrap = (r) => r?.data?.data ?? r?.data ?? {};
const errMsg = (e, fb) => e?.response?.data?.errors?.[0]?.message || e?.response?.data?.message || e?.message || fb;
const primaryEvt = (a, b) => String(a || b || 'manual.trigger').split(',')[0].trim() || 'manual.trigger';
const cleanCtx = (v, max = 80) => String(v || '').replace(/[\r\n\t\0<>[\]{}`#]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const syncMeta = (s, cdVal, mdVal) => {
  const [cd, md] = [cdVal ?? s?.cooldownSec, mdVal ?? s?.maxDepth];
  return {
    ...(cd != null && cd !== '' && Number.isFinite(Number(cd)) ? { cooldownSec: Number(cd) } : {}),
    ...(md != null && md !== '' && Number.isFinite(Number(md)) ? { maxDepth: Number(md) } : {}),
  };
};

function btnS(tone = 'ghost', dis = false) {
  const m = {
    pri: ['#2563EB', '#ffffff', '#2563EB'],
    ai: ['#0F172A', '#ffffff', '#0F172A'],
    act: ['#EFF6FF', '#1D4ED8', '#93C5FD'],
    run: ['#0F766E', '#ffffff', '#0F766E'],
    err: ['#FEF2F2', '#B91C1C', '#FCA5A5'],
    ok: ['#F0FDF4', '#166534', '#86EFAC'],
    ghost: ['#ffffff', '#0f172a', '#cbd5e1'],
  }[tone] || ['#ffffff', '#0f172a', '#cbd5e1'];
  return {
    padding: '5px 9px', borderRadius: 7, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap',
    cursor: dis ? 'not-allowed' : 'pointer', border: `1px solid ${dis ? '#cbd5e1' : m[2]}`,
    background: dis ? '#e2e8f0' : m[0], color: dis ? '#94a3b8' : m[1], flexShrink: 0,
  };
}

const freshDoc = (seed, makeBlankFlow) => {
  const b = makeBlankFlow(seed);
  return { rule: b.rule, graph: b.graph, undo: [], redo: [], selId: null, preDragGraph: null, dirty: false };
};
const FRESH_DATA = { rules: [], runs: [], catalog: null, regTypes: [], loading: false };
const FRESH_RUN = { selectedRun: null, idx: 0, playing: false, testOut: null, autoExpandSeq: 0 };
const makeFreshUi = (view) => ({
  view, settingsOpen: false, bpOpen: false, paletteOpen: false,
  testRunnerOpen: false, valOpen: false, insertEdge: null, appendSource: null,
  fb: null, busy: {}, inspTab: null, inspTabSeq: 0,
});

function buildRuleSavePayload(rule, graph, orgPayload, deriveTriggerEventType) {
  const g = graph || rule?.graphJson || { version: 2, nodes: [], edges: [] };
  return {
    ...(orgPayload || {}),
    ruleKey: String(rule?.ruleKey || '').trim(),
    name: String(rule?.name || '').trim(),
    description: rule?.description || null,
    triggerEventType: deriveTriggerEventType(g, rule),
    filterJson: rule?.filterJson ?? null,
    dmnTableKey: rule?.dmnTableKey || null,
    cooldownSec: Number(rule?.cooldownSec ?? g.settings?.cooldownSec ?? 0),
    maxDepth: Number(rule?.maxDepth ?? g.settings?.maxDepth ?? 8),
    active: rule?.active !== false,
    schemaVersion: 2,
    graphJson: g,
  };
}

function renderValidationPopover(h, { totalIssues, validation, onSelectIssue, onClose }) {
  const items = [...(validation?.errors || []), ...(validation?.warnings || [])];
  return h('div', { 'data-testid': 'dxos-flow-validation-popover', style: { position: 'absolute', top: 54, right: 14, zIndex: 36, width: 340, maxWidth: 'calc(100% - 28px)', padding: 12, borderRadius: 12, border: '1px solid #cbd5e1', background: '#ffffff', boxShadow: '0 14px 34px rgba(15,23,42,0.16)', display: 'grid', gap: 6 } },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
      h('strong', { style: { fontSize: 12 } }, `Kiểm tra luồng (${totalIssues})`),
      h('button', { type: 'button', 'data-testid': 'dxos-flow-val-close-btn', onClick: onClose, style: btnS('ghost') }, '×'),
    ),
    !totalIssues
      ? h('span', { style: { fontSize: 12, color: '#166534' } }, '✓ Mọi node và kết nối đều hợp lệ.')
      : items.map((it, idx) => h('button', {
        key: idx, type: 'button', 'data-testid': `dxos-flow-val-issue-${idx}`, onClick: () => onSelectIssue(it),
        style: { textAlign: 'left', padding: '6px 8px', borderRadius: 7, border: `1px solid ${it.severity === 'error' ? '#fecaca' : '#fde68a'}`, background: it.severity === 'error' ? '#fef2f2' : '#fffbeb', color: it.severity === 'error' ? '#991b1b' : '#92400e', fontSize: 11, cursor: 'pointer' },
      }, `${it.severity === 'error' ? '✕' : '⚠'} ${it.message}`)),
  );
}

function renderSettingsPopover(h, { doc, handleRuleMeta, blueprintsCount, onToggleBlueprints, onClose }) {
  const fields = [
    ['Rule Key', 'dxos-flow-rule-key-input', 'text', doc.rule.ruleKey ?? '', (v) => handleRuleMeta({ ruleKey: v })],
    ['Rule Name', 'dxos-flow-rule-name-input', 'text', doc.rule.name ?? '', (v) => handleRuleMeta({ name: v })],
    ['Cooldown (sec)', 'dxos-flow-rule-cooldown-input', 'number', doc.rule.cooldownSec ?? doc.graph.settings?.cooldownSec ?? 0, (v) => handleRuleMeta({ cooldownSec: Math.max(0, Math.floor(Number(v) || 0)) }), { min: 0 }],
    ['Max Depth (1..8)', 'dxos-flow-rule-maxdepth-input', 'number', doc.rule.maxDepth ?? doc.graph.settings?.maxDepth ?? 8, (v) => handleRuleMeta({ maxDepth: Math.min(8, Math.max(1, Math.floor(Number(v) || 8))) }), { min: 1, max: 8 }],
  ];
  return h('div', { 'data-testid': 'dxos-flow-settings-popover', style: { position: 'absolute', top: 54, left: 14, zIndex: 35, width: 340, maxWidth: 'calc(100% - 28px)', padding: 14, borderRadius: 12, border: '1px solid #cbd5e1', background: '#ffffff', boxShadow: '0 14px 34px rgba(15,23,42,0.16)', display: 'grid', gap: 10 } },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
      h('strong', { style: { fontSize: 13, color: '#0f172a' } }, 'Cài đặt Workflow'),
      h('button', { type: 'button', 'data-testid': 'dxos-flow-settings-close-btn', onClick: onClose, style: btnS('ghost') }, '×'),
    ),
    h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 } },
      fields.map(([lbl, tid, type, val, onVal, extra = {}]) => h('div', { key: tid },
        h('label', { style: { fontSize: 11, fontWeight: 600 } }, lbl),
        h('input', { 'data-testid': tid, type, value: val, ...extra, onChange: (e) => onVal(e?.target?.value ?? ''), style: INP }),
      )),
    ),
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 } },
      h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600 } },
        h('input', { 'data-testid': 'dxos-flow-rule-active-checkbox', type: 'checkbox', checked: doc.rule.active !== false, onChange: (e) => handleRuleMeta({ active: Boolean(e?.target?.checked) }) }),
        'Kích hoạt Rule',
      ),
      h('button', { 'data-testid': 'dxos-flow-blueprints-btn', type: 'button', onClick: onToggleBlueprints, style: btnS('act') }, `Mẫu sẵn có (${blueprintsCount})`),
    ),
  );
}

function renderBlueprintsGallery(h, { blueprints, onLoadBlueprint }) {
  return h('div', { 'data-testid': 'dxos-flow-blueprints-gallery', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8, padding: 10, background: '#f1f5f9', borderBottom: '1px solid #cbd5e1', maxHeight: 220, overflowY: 'auto' } },
    blueprints.map((bp) => h('div', { key: bp.blueprintKey || bp.ruleKey, style: { padding: 8, borderRadius: 8, background: '#ffffff', border: '1px solid #cbd5e1', display: 'grid', gap: 4 } },
      h('strong', { style: { fontSize: 12, color: '#0f172a' } }, bp.name),
      h('span', { style: { fontSize: 11, color: '#64748b' } }, `${bp.category || 'flow'} · ${bp.graphJson?.nodes?.length || 0} nodes`),
      h('button', { 'data-testid': `dxos-flow-blueprint-load-${bp.blueprintKey || bp.ruleKey}`, type: 'button', onClick: () => onLoadBlueprint(bp), style: btnS('pri') }, 'Load Blueprint'),
    )),
  );
}

function renderDslModal(h, { dsl, dslObj, serializeFlowDsl, setDsl, handleImportDsl }) {
  return h('div', { 'data-testid': 'dxos-flow-dsl-modal', style: { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 16 } },
    h('div', { style: { width: 680, maxWidth: '100%', background: '#ffffff', borderRadius: 12, padding: 16, display: 'grid', gap: 10, boxShadow: '0 12px 32px rgba(15,23,42,0.2)' } },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
        h('strong', { style: { fontSize: 14 } }, 'Flow DSL Export / Import (JSON / YAML)'),
        h('div', { style: { display: 'flex', gap: 6 } },
          h('select', { 'data-testid': 'dxos-flow-dsl-format-select', value: dsl.format, style: { ...INP, width: 'auto' }, onChange: (e) => { const fmt = e?.target?.value === 'yaml' ? 'yaml' : 'json'; setDsl((m) => ({ ...m, format: fmt, text: serializeFlowDsl(dslObj(), fmt), error: null })); } }, h('option', { value: 'json' }, 'JSON'), h('option', { value: 'yaml' }, 'YAML')),
          h('button', { 'data-testid': 'dxos-flow-dsl-close-btn', type: 'button', onClick: () => setDsl({ open: false, format: dsl.format, text: '', error: null }), style: btnS('ghost') }, 'Close'),
        ),
      ),
      h('textarea', { 'data-testid': 'dxos-flow-dsl-textarea', rows: 14, value: dsl.text, onChange: (e) => setDsl((m) => ({ ...m, text: e?.target?.value ?? '', error: null })), style: { width: '100%', fontFamily: 'monospace', fontSize: 11, padding: 8, borderRadius: 6, border: '1px solid #cbd5e1', boxSizing: 'border-box' } }),
      dsl.error ? h('div', { 'data-testid': 'dxos-flow-dsl-error', style: { color: '#b91c1c', fontSize: 12 } }, dsl.error) : null,
      h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
        h('button', { 'data-testid': 'dxos-flow-dsl-import-btn', type: 'button', onClick: handleImportDsl, style: btnS('pri') }, 'Import to Canvas'),
      ),
    ),
  );
}

function dispatchFlowKeyDown(evt, ctx) {
  if (!evt || ctx.ui?.view !== 'editor') return;
  const key = String(evt.key || '').toLowerCase();
  const mod = Boolean(evt.ctrlKey || evt.metaKey);
  const tag = String(evt.target?.tagName || '').toUpperCase();
  const editable = ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || Boolean(evt.target?.isContentEditable);
  if (evt.key === 'Escape') {
    if (ctx.dslOpen) return ctx.closeDsl();
    if (ctx.hasOpenPopover) return ctx.closePopovers();
    if (ctx.selId) ctx.clearSel();
    return;
  }
  if (mod && key === 's') { evt.preventDefault?.(); return ctx.save(); }
  if (mod && key === 'k') { evt.preventDefault?.(); return ctx.togglePalette(); }
  if (!editable && mod && key === 'z' && !evt.shiftKey) { evt.preventDefault?.(); return ctx.undo(); }
  if (!editable && mod && ((key === 'z' && evt.shiftKey) || key === 'y')) { evt.preventDefault?.(); return ctx.redo(); }
  if (!editable && (evt.key === 'Delete' || evt.key === 'Backspace') && ctx.selId) { evt.preventDefault?.(); ctx.deleteSel(); }
}

module.exports = {
  DEFAULT_NODES, DEFAULT_BLUEPRINTS, ROW, INP,
  unwrap, errMsg, primaryEvt, cleanCtx, syncMeta, btnS,
  freshDoc, FRESH_DATA, FRESH_RUN, makeFreshUi, buildRuleSavePayload, dispatchFlowKeyDown,
  renderValidationPopover, renderSettingsPopover, renderBlueprintsGallery, renderDslModal,
};
