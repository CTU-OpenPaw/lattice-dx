/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { N8N_WEBHOOK_PRESETS } = require('./n8n-setup-modal');
const { insertVariableAtCursor, buildUpstreamPinnedInputs } = require('./flow-validation');
const { renderTraceIoView, createWebhookHelperComponent, renderToolsPicker } = require('../flow-inspector-extras');

function createNodeInspector(React) {
  const h = React.createElement;
  const BLOCKED = new Set(['__proto__', 'constructor', 'prototype']);
  const STEP_VAR_MAP = { 'data.query': ['items', 'count'], 'logic.dmn': ['outputs'], 'ai.llm': ['data', 'content'], 'integration.http': ['response'], 'control.approval': ['decision'] };
  const TONE_MAP = [[['completed', 'ok', 'succeeded', 'approved'], 'ok'], [['failed', 'error', 'rejected'], 'danger'], [['suspended', 'skipped', 'simulated', 'pending'], 'warn']];
  const S = {
    root: { position: 'absolute', top: 12, right: 12, bottom: 12, width: 356, maxWidth: 'calc(100% - 24px)', zIndex: 24, overflowY: 'auto', borderRadius: 12, border: '1px solid #cbd5e1', background: '#ffffff', padding: 12, display: 'flex', flexDirection: 'column', gap: 10, boxSizing: 'border-box', boxShadow: '0 12px 32px rgba(15, 23, 42, 0.14)' },
    card: { padding: 10, borderRadius: 8, border: '1px solid #e2e8f0', background: '#f8fafc', display: 'grid', gap: 8 },
    rowBetween: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
    rowWrap: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' },
    checkRow: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#0f172a' },
    grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 },
    grid: (gap) => ({ display: 'grid', gap }),
    err: (fontSize) => ({ fontSize, color: '#b91c1c' }),
    label: { display: 'block', fontSize: 11, fontWeight: 600, color: '#334155', marginBottom: 3 },
    input: { width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 12, boxSizing: 'border-box', background: '#ffffff', color: '#0f172a' },
    textarea: { width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid #cbd5e1', fontFamily: 'monospace', fontSize: 11, boxSizing: 'border-box', background: '#ffffff', color: '#0f172a' },
    tab: (active) => ({ flex: 1, padding: '6px 8px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', border: `1px solid ${active ? '#2563EB' : '#cbd5e1'}`, background: active ? '#eff6ff' : '#ffffff', color: active ? '#1d4ed8' : '#475569' }),
    btn: (primary, danger, disabled) => ({ padding: '5px 9px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer', border: `1px solid ${disabled ? '#cbd5e1' : danger ? '#fca5a5' : primary ? '#2563EB' : '#cbd5e1'}`, background: disabled ? '#e2e8f0' : danger ? '#fef2f2' : primary ? '#2563EB' : '#ffffff', color: disabled ? '#94a3b8' : danger ? '#b91c1c' : primary ? '#ffffff' : '#334155' }),
    chip: { padding: '2px 7px', borderRadius: 999, fontSize: 11, fontWeight: 600, border: '1px solid #bfdbfe', background: '#eff6ff', color: '#1e40af', cursor: 'pointer', fontFamily: 'monospace' },
    badge: (tone) => {
      const m = { ok: ['#dcfce7', '#166534'], danger: ['#fee2e2', '#991b1b'], warn: ['#fef3c7', '#92400e'], info: ['#dbeafe', '#1e40af'] }[tone] || ['#f1f5f9', '#475569'];
      return { display: 'inline-block', padding: '2px 7px', borderRadius: 999, fontSize: 10, fontWeight: 700, background: m[0], color: m[1] };
    },
  };
  const WebhookHelper = createWebhookHelperComponent(React, S);

  function safeParseJson(text) {
    try {
      const reviver = (k, v) => (BLOCKED.has(k) ? (() => { throw new Error(`Blocked key "${k}"`); })() : v);
      return { ok: true, value: JSON.parse(String(text || ''), reviver) };
    } catch (err) { return { ok: false, error: err?.message || 'Invalid JSON' }; }
  }
  const formatJson = (v, fb = {}) => { try { return JSON.stringify(v === undefined ? fb : v, null, 2); } catch { return '{}'; } };
  const statusTone = (st) => TONE_MAP.find(([keys]) => keys.includes(String(st || '').toLowerCase()))?.[1] || 'info';
  const toNum = (e) => ((e?.target?.value ?? '') === '' ? undefined : Number(e.target.value));
  const collectNames = (items, target) => { for (const it of items || []) { const nm = typeof it === 'string' ? it : it?.name; if (nm && !BLOCKED.has(nm)) target.add(nm); } };

  function collectAncestors(graph, targetId) {
    const byId = new Map((Array.isArray(graph?.nodes) ? graph.nodes : []).map((n) => [n.id, n]));
    const edges = Array.isArray(graph?.edges) ? graph.edges : [];
    const seen = new Set([targetId]);
    const queue = [targetId];
    const out = [];
    for (let i = 0; i < queue.length; i += 1) {
      for (const e of edges.filter((x) => x?.target === queue[i] && x.source && !seen.has(x.source))) {
        seen.add(e.source); queue.push(e.source); if (byId.has(e.source)) out.push(byId.get(e.source));
      }
    }
    return out;
  }

  function buildVariableGroups({ rule, graph, node, catalog }) {
    const dataKeys = new Set(['id', 'code', 'status']);
    if (rule?.sampleEvent?.data && typeof rule.sampleEvent.data === 'object') collectNames(Object.keys(rule.sampleEvent.data).slice(0, 12), dataKeys);
    const trig = (graph?.nodes || []).find((n) => String(n.type || '').startsWith('trigger.'));
    const colName = trig?.config?.collection || node?.config?.collection || node?.config?.targetCollection;
    collectNames(((catalog?.collections || []).find((c) => c.name === colName)?.fields || []).slice(0, 8), dataKeys);

    const dmnKeys = new Set();
    const dmnSet = new Set([...(graph?.nodes || []).filter((n) => n.type === 'logic.dmn').map((n) => n.config?.tableKey).filter(Boolean), ...(rule?.dmnTableKey ? [rule.dmnTableKey] : [])]);
    for (const dt of Array.isArray(catalog?.dmnTables) ? catalog.dmnTables : []) if (!dmnSet.size || dmnSet.has(dt.tableKey || dt.key)) collectNames(dt.outputsJson || dt.outputs, dmnKeys);
    if (!dmnKeys.size) collectNames(['priority', 'assignedRole', 'decision'], dmnKeys);

    const ancestors = node ? collectAncestors(graph, node.id) : [];
    const stepVars = ancestors.flatMap((anc) => {
      const sfx = STEP_VAR_MAP[anc.type];
      return [`{{steps.${anc.id}.id}}`, ...(sfx ? sfx.map((s) => `{{steps.${anc.id}.${s}}}`) : [`{{nodes.${anc.id}.output}}`])];
    });
    return [
      { key: 'event', title: 'Event & Trigger', vars: ['{{event.id}}', '{{event.type}}', '{{event.source}}', '{{event.subject}}', ...[...dataKeys].map((k) => `{{data.${k}}}`)] },
      { key: 'dmn', title: 'DMN Outputs', vars: [...dmnKeys].map((k) => `{{dmn.${k}}}`) },
      { key: 'steps', title: `Ancestors (${ancestors.length})`, vars: stepVars.length ? stepVars : ['{{steps.prev.id}}', '{{nodes.prev.output}}'] },
      { key: 'loop', title: 'Loop Context', vars: ['{{loop.item}}', '{{loop.index}}', '{{loop.count}}'] },
    ];
  }

  return function NodeInspector(props = {}) {
    const {
      rule = null, graph = null, selectedNode = null, nodeSchema = null, catalog = {},
      onUpdateNode, onDeleteNode, onCloseInspector, onTestNode, onDryRunWebhook, onOpenN8nSetup,
      testOutput = null, testBusy = false, activeTrace = null, externalTab = null, externalTabSeq = 0,
      nodeValidationIssues = [], selectedRun = null, organizationId = '', pinStorage = null,
    } = props;
    const node = React.useMemo(() => (!selectedNode ? null : typeof selectedNode === 'string' ? (graph?.nodes || []).find((n) => n.id === selectedNode) || null : selectedNode), [selectedNode, graph]);
    const schema = React.useMemo(() => nodeSchema || (node?.type ? (catalog?.nodeTypes || []).find((t) => t.type === node.type) || null : null), [nodeSchema, node, catalog]);

    const [tab, setTab] = React.useState('config');
    const [advancedOpen, setAdvancedOpen] = React.useState(false);
    const [varPickerOpen, setVarPickerOpen] = React.useState(false);
    const [expandedGroups, setExpandedGroups] = React.useState({ event: true, dmn: true, steps: true, loop: true });
    const [activeFieldState, setActiveFieldState] = React.useState({ scopeKey: '', name: null });
    const [jsonBuf, setJsonBuf] = React.useState({ scopeKey: '', configSig: '', entries: {}, raw: null });
    const [pinnedMap, setPinnedMap] = React.useState({});
    const [tabSeqRef] = React.useState(() => ({ val: externalTabSeq || 0, nodeId: null }));
    const [cursorRef] = React.useState(() => ({ scopeKey: '', field: null, start: null, end: null }));

    const ruleKey = rule?.ruleKey || '__draft__';
    const nodeId = node?.id || null;
    const scopeKey = nodeId ? `${ruleKey}:${nodeId}` : '';
    const orgKey = String(organizationId || 'default').trim() || 'default';
    const pinKey = nodeId ? `${orgKey}::${ruleKey}::${nodeId}` : null;
    const pinStorageKey = `latticedx:flow-pin:${orgKey}:${ruleKey}`;

    React.useEffect(() => {
      const extChanged = Boolean(externalTabSeq && externalTabSeq !== tabSeqRef.val);
      const nodeChanged = nodeId !== tabSeqRef.nodeId;
      tabSeqRef.nodeId = nodeId;
      if (extChanged) {
        tabSeqRef.val = externalTabSeq;
        if (externalTab) setTab(externalTab);
      } else if (nodeChanged && !(selectedRun && tab === 'output')) {
        setTab('config');
      }
    }, [nodeId, externalTab, externalTabSeq]);

    React.useEffect(() => {
      if (!pinStorage || typeof pinStorage.getItem !== 'function') return;
      let raw = null;
      try { raw = pinStorage.getItem(pinStorageKey); } catch { return; }
      if (!raw) return;
      const parsed = safeParseJson(raw);
      if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) return;
      setPinnedMap((prev) => {
        const next = { ...prev };
        for (const [nid, textVal] of Object.entries(parsed.value)) {
          if (!nid || BLOCKED.has(nid) || typeof textVal !== 'string') continue;
          const chk = safeParseJson(textVal);
          next[`${orgKey}::${ruleKey}::${nid}`] = { text: textVal, error: chk.ok ? null : chk.error };
        }
        return next;
      });
    }, [pinStorageKey, pinStorage, orgKey, ruleKey]);
    const nodeCfg = node?.config && typeof node.config === 'object' ? node.config : {};
    const configSig = React.useMemo(() => formatJson(nodeCfg, {}), [nodeCfg]);
    const fields = React.useMemo(() => (Array.isArray(schema?.inputSchema?.fields) ? schema.inputSchema.fields : []), [schema]);

    React.useEffect(() => {
      if (jsonBuf.scopeKey && (jsonBuf.scopeKey !== scopeKey || jsonBuf.configSig !== configSig)) setJsonBuf({ scopeKey: '', configSig: '', entries: {}, raw: null });
    }, [scopeKey, configSig, jsonBuf.scopeKey, jsonBuf.configSig]);

    const [safeCols, safeConns, safeDmns, safeRoles, safeEvents] = ['collections', 'connectors', 'dmnTables', 'roles', 'eventTypes'].map((k) => (Array.isArray(catalog?.[k]) ? catalog[k] : []));
    function resolveSelectOptions(f) {
      const specs = [
        [f.type === 'collection' || f.name === 'collection' || f.name === 'targetCollection', safeCols, '-- Select collection --', (c) => ({ value: c.name, label: c.title && c.title !== c.name ? `${c.name} (${c.title})` : c.name })],
        [f.type === 'connector' || f.name === 'connectorKey', safeConns, '-- Select connector --', (c) => ({ value: c.connectorKey, label: `${c.connectorKey} (${c.connectorType || 'http_api'} · ${c.authType || 'none'})` })],
        [f.type === 'dmn' || f.name === 'tableKey' || f.name === 'dmnTableKey', safeDmns, '-- Select DMN table --', (d) => ({ value: d.tableKey || d.key, label: d.name && d.name !== (d.tableKey || d.key) ? `${d.tableKey || d.key} — ${d.name}` : (d.tableKey || d.key) })],
        [f.type === 'role' || f.name === 'approverRole', safeRoles, '-- Select role --', (r) => ({ value: r, label: r })],
      ];
      const hit = specs.find(([ok, arr]) => ok && arr.length);
      if (hit) return { placeholder: hit[2], items: hit[1].map(hit[3]) };
      return f.type === 'select' && Array.isArray(f.options) ? { placeholder: null, items: f.options.map((o) => ({ value: String(o), label: String(o) })) } : null;
    }

    const defaultField = React.useMemo(() => {
      const f = fields.find((x) => !resolveSelectOptions(x) && ['string', 'textarea', 'json'].includes(x.type)) || fields.find((x) => ['string', 'textarea', 'json'].includes(x.type));
      return f ? f.name : '__raw__';
    }, [fields, safeCols.length, safeConns.length, safeDmns.length, safeRoles.length]);
    const activeField = (activeFieldState.scopeKey === scopeKey && (activeFieldState.name === '__raw__' || fields.some((f) => f.name === activeFieldState.name))) ? activeFieldState.name : defaultField;
    const setActiveField = (name) => setActiveFieldState({ scopeKey, name });
    const bufActive = Boolean(scopeKey && jsonBuf.scopeKey === scopeKey && jsonBuf.configSig === configSig);
    const currentJsonFieldText = (name, fallbackVal) => {
      if (bufActive && jsonBuf.entries[name]) return jsonBuf.entries[name].text;
      const rawVal = nodeCfg[name] !== undefined ? nodeCfg[name] : fallbackVal;
      return (rawVal === null || rawVal === undefined) ? '' : formatJson(rawVal, {});
    };
    const currentRawText = () => (bufActive && jsonBuf.raw ? jsonBuf.raw.text : configSig);
    const updateConfigField = (name, nextVal) => node && onUpdateNode?.(node.id, { config: { ...nodeCfg, [name]: nextVal } });

    function updateJsonFieldText(name, text) {
      if (!nodeId) return;
      const trimmed = String(text || '').trim();
      const parsed = trimmed === '' ? { ok: true, value: null } : safeParseJson(text);
      const nextSig = parsed.ok ? formatJson({ ...nodeCfg, [name]: parsed.value }, {}) : configSig;
      setJsonBuf((prev) => {
        const same = prev.scopeKey === scopeKey && prev.configSig === configSig;
        return { scopeKey, configSig: nextSig, raw: !parsed.ok && same ? prev.raw : null, entries: { ...(same ? prev.entries : {}), [name]: { text, error: parsed.ok ? null : parsed.error } } };
      });
      if (parsed.ok) updateConfigField(name, parsed.value);
    }
    function updateRawConfigText(text) {
      if (!nodeId) return;
      const parsed = safeParseJson(text);
      const validObj = parsed.ok && parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value);
      const err = parsed.ok ? (validObj ? null : 'Config must be a JSON object') : parsed.error;
      setJsonBuf({ scopeKey, configSig: validObj ? formatJson(parsed.value, {}) : configSig, entries: {}, raw: { text, error: err } });
      if (validObj) onUpdateNode?.(node.id, { config: parsed.value });
    }
    function trackCursor(fieldName, evt) {
      setActiveField(fieldName);
      const el = evt?.target;
      if (el && Number.isFinite(Number(el.selectionStart))) {
        Object.assign(cursorRef, {
          scopeKey, field: fieldName, start: Number(el.selectionStart),
          end: Number.isFinite(Number(el.selectionEnd)) ? Number(el.selectionEnd) : Number(el.selectionStart),
        });
      } else if (cursorRef.scopeKey !== scopeKey || cursorRef.field !== fieldName) {
        Object.assign(cursorRef, { scopeKey, field: fieldName, start: null, end: null });
      }
    }
    function insertVariable(expr) {
      if (!node) return;
      const hasPos = cursorRef.scopeKey === scopeKey && cursorRef.field === activeField && Number.isFinite(cursorRef.start);
      const selStart = hasPos ? cursorRef.start : null;
      const selEnd = hasPos ? cursorRef.end : null;
      if (activeField === '__raw__') {
        Object.assign(cursorRef, { start: null, end: null });
        return updateRawConfigText(insertVariableAtCursor(currentRawText(), expr, selStart, selEnd, true));
      }
      const def = fields.find((f) => f.name === activeField);
      if (def?.type === 'json') {
        Object.assign(cursorRef, { start: null, end: null });
        return updateJsonFieldText(activeField, insertVariableAtCursor(currentJsonFieldText(activeField, schema?.defaultConfig?.[activeField]), expr, selStart, selEnd, true));
      }
      const cur = nodeCfg[activeField];
      const next = insertVariableAtCursor(cur === undefined || cur === null ? '' : String(cur), expr, selStart, selEnd, false);
      if (hasPos) {
        const nextPos = Math.min(next.length, selStart + String(expr || '').length);
        Object.assign(cursorRef, { start: nextPos, end: nextPos });
      }
      updateConfigField(activeField, next);
    }

    const defaultPinnedText = React.useMemo(() => {
      const ev = rule?.sampleEvent && typeof rule.sampleEvent === 'object' ? rule.sampleEvent : { type: 'manual.trigger', data: {} };
      return formatJson(buildUpstreamPinnedInputs(graph, nodeId, selectedRun, ev), {});
    }, [rule, graph, nodeId, selectedRun]);
    const persistPins = (nextMap) => {
      if (!pinStorage || typeof pinStorage.setItem !== 'function') return;
      const prefix = `${orgKey}::${ruleKey}::`;
      const out = {};
      for (const [k, v] of Object.entries(nextMap || {})) {
        if (k.startsWith(prefix) && v && typeof v.text === 'string') {
          const nid = k.slice(prefix.length);
          if (nid && !BLOCKED.has(nid)) out[nid] = v.text;
        }
      }
      try { pinStorage.setItem(pinStorageKey, JSON.stringify(out)); } catch { /* ignore */ }
    };
    const pinnedEntry = pinKey && pinnedMap[pinKey] ? pinnedMap[pinKey] : { text: defaultPinnedText, error: null };
    const varGroups = React.useMemo(() => buildVariableGroups({ rule, graph, node, catalog }), [rule, graph, node, catalog]);
    const displayOut = (testOutput && (!node || !testOutput.nodeId || testOutput.nodeId === node.id)) ? testOutput : (activeTrace || null);

    if (!node) return null;

    function renderFieldControl(f) {
      const val = nodeCfg[f.name] !== undefined ? nodeCfg[f.name] : (schema?.defaultConfig?.[f.name] ?? '');
      const testId = `dxos-flow-field-${f.name}`;
      const base = { 'data-testid': testId, placeholder: f.placeholder || '', onFocus: (e) => trackCursor(f.name, e), onClick: (e) => trackCursor(f.name, e), onKeyUp: (e) => trackCursor(f.name, e), onSelect: (e) => trackCursor(f.name, e) };
      const selectSpec = resolveSelectOptions(f);
      if (selectSpec) {
        const strVal = String(val || '');
        const hasVal = !strVal || selectSpec.items.some((it) => it.value === strVal);
        const selEl = h('select', { ...base, value: strVal, style: S.input, onChange: (e) => updateConfigField(f.name, e?.target?.value ?? '') },
          selectSpec.placeholder ? h('option', { value: '' }, selectSpec.placeholder) : null,
          selectSpec.items.map((it) => h('option', { key: it.value, value: it.value }, it.label)),
          !hasVal ? h('option', { value: strVal }, strVal) : null);
        if (f.name === 'connectorKey' && onOpenN8nSetup) {
          return h('div', { style: S.grid(4) }, selEl, h('button', { type: 'button', 'data-testid': 'dxos-flow-open-n8n-from-inspector', onClick: () => onOpenN8nSetup(), style: S.btn(false, false, false) }, '⚙ Cấu hình dịch vụ n8n'));
        }
        return selEl;
      }
      if (f.type === 'boolean') return h('label', { style: S.checkRow }, h('input', { 'data-testid': testId, type: 'checkbox', checked: Boolean(val), onChange: (e) => updateConfigField(f.name, Boolean(e?.target?.checked)) }), f.label || f.name);
      if (f.type === 'number') return h('input', { ...base, type: 'number', value: val ?? '', style: S.input, onChange: (e) => updateConfigField(f.name, toNum(e)) });
      if (f.type === 'textarea') return h('textarea', { ...base, rows: 3, value: String(val || ''), style: S.textarea, onChange: (e) => { trackCursor(f.name, e); updateConfigField(f.name, e?.target?.value ?? ''); } });
      if (f.type === 'json') {
        const err = bufActive ? jsonBuf.entries[f.name]?.error : null;
        const onRolePick = (r) => r && updateConfigField('roleNames', Array.isArray(val) && val.includes(r) ? val : [...(Array.isArray(val) ? val : []), r]);
        return h('div', { style: S.grid(4) },
          f.name === 'roleNames' && safeRoles.length ? h('select', { 'data-testid': 'dxos-flow-field-roleNames-picker', value: '', style: S.input, onChange: (e) => onRolePick(e?.target?.value) }, h('option', { value: '' }, '+ Add role from catalog...'), safeRoles.map((r) => h('option', { key: r, value: r }, r))) : null,
          f.name === 'tools' ? renderToolsPicker(h, { val, catalog, updateConfigField, inputStyle: S.input }) : null,
          h('textarea', { ...base, rows: 3, placeholder: '{} (tùy chọn)', value: currentJsonFieldText(f.name, schema?.defaultConfig?.[f.name]), style: S.textarea, onChange: (e) => { trackCursor(f.name, e); updateJsonFieldText(f.name, e?.target?.value ?? ''); } }),
          err ? h('span', { style: S.err(10) }, err) : null);
      }
      return h('div', { style: S.grid(4) },
        f.name === 'eventType' && safeEvents.length ? h('select', { 'data-testid': 'dxos-flow-field-eventType-picker', style: S.input, value: safeEvents.some((ev) => ev.type === val) ? String(val) : '', onChange: (e) => e?.target?.value && updateConfigField(f.name, e.target.value) }, h('option', { value: '' }, '-- Pick standard event --'), safeEvents.map((ev) => h('option', { key: ev.type, value: ev.type }, `${ev.type} — ${ev.label}`))) : null,
        f.name === 'path' && node.type === 'integration.http' ? h('select', { 'data-testid': 'dxos-flow-n8n-path-picker', style: S.input, value: N8N_WEBHOOK_PRESETS.some((p) => p.path === val) ? String(val) : '', onChange: (e) => e?.target?.value && updateConfigField(f.name, e.target.value) }, h('option', { value: '' }, '-- Chọn preset n8n Webhook --'), N8N_WEBHOOK_PRESETS.map((p) => h('option', { key: p.key, value: p.path }, `${p.path} — ${p.name}`))) : null,
        f.name === 'connectorKey' && onOpenN8nSetup ? h('button', { type: 'button', 'data-testid': 'dxos-flow-open-n8n-from-inspector', onClick: () => onOpenN8nSetup(), style: S.btn(false, false, false) }, '⚙ Cấu hình dịch vụ n8n') : null,
        h('input', { ...base, type: 'text', value: String(val ?? ''), style: S.input, onChange: (e) => { trackCursor(f.name, e); updateConfigField(f.name, e?.target?.value ?? ''); } }));
    }

    const inpField = (label, testId, inputProps) => h('div', null, h('label', { style: S.label }, label), h('input', { 'data-testid': testId, ...inputProps, style: S.input }));
    return h('aside', { 'data-testid': 'dxos-flow-inspector', style: S.root },
      h('div', { style: S.card },
        h('div', { style: S.rowBetween },
          h('div', { style: S.rowWrap }, h('span', { style: S.badge('info') }, node.type), h('code', { style: { fontSize: 11, color: '#475569' } }, node.id)),
          h('div', { style: S.rowWrap },
            h('button', { 'data-testid': 'dxos-flow-delete-node-btn', type: 'button', onClick: () => onDeleteNode?.(node.id), style: S.btn(false, true, false) }, 'Xóa'),
            h('button', { 'data-testid': 'dxos-flow-inspector-close-btn', type: 'button', onClick: () => onCloseInspector?.(), style: S.btn(false, false, false) }, 'Đóng'),
          ),
        ),
        inpField('Nhãn nút', 'dxos-flow-node-label-input', { type: 'text', value: node.label || '', onChange: (e) => onUpdateNode?.(node.id, { label: e?.target?.value ?? '' }) }),
      ),
      h('div', { role: 'tablist', style: { display: 'flex', gap: 6 } },
        [['config', 'Cấu hình'], ['input', 'Đầu vào / Pin'], ['output', 'Trace / I/O']].map(([key, lbl]) => h('button', { key, role: 'tab', type: 'button', 'aria-selected': tab === key, 'data-testid': `dxos-flow-inspector-tab-${key}`, onClick: () => setTab(key), style: S.tab(tab === key) }, lbl)),
      ),
      tab === 'config' ? h('div', { style: S.grid(8) },
        Array.isArray(nodeValidationIssues) && nodeValidationIssues.length
          ? h('div', { 'data-testid': 'dxos-flow-inspector-validation', style: { padding: '7px 9px', borderRadius: 8, background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', fontSize: 11, display: 'grid', gap: 2 } }, nodeValidationIssues.map((it, idx) => h('span', { key: idx }, `⚠ ${it.message}`)))
          : null,
        h('div', { style: S.rowBetween },
          h('span', { style: { fontSize: 11, fontWeight: 600, color: '#475569' } }, `Tham số (${fields.length})`),
          h('button', { 'data-testid': 'dxos-flow-var-picker-btn', type: 'button', onClick: () => setVarPickerOpen((p) => !p), style: S.btn(varPickerOpen, false, false) }, '{ } Chèn biến'),
        ),
        varPickerOpen ? h('div', { 'data-testid': 'dxos-flow-var-picker-panel', style: { ...S.card, background: '#f0f9ff', border: '1px solid #bae6fd' } },
          h('div', { style: S.rowBetween },
            h('strong', { style: { fontSize: 11, color: '#0369a1' } }, `Variable Tree Picker → ${activeField}`),
            h('select', { value: activeField, onChange: (e) => setActiveField(e?.target?.value || defaultField), style: { ...S.input, width: 'auto', fontSize: 11, padding: '2px 6px' } },
              fields.filter((f) => !['boolean', 'number'].includes(f.type)).map((f) => h('option', { key: f.name, value: f.name }, f.label || f.name)),
              h('option', { value: '__raw__' }, 'Raw Config JSON')),
          ),
          varGroups.map((grp) => h('div', { key: grp.key, style: S.grid(4) },
            h('button', { type: 'button', onClick: () => setExpandedGroups((p) => ({ ...p, [grp.key]: !p[grp.key] })), style: { textAlign: 'left', background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', fontSize: 11, fontWeight: 700, color: '#1e293b' } }, `${expandedGroups[grp.key] ? '▾' : '▸'} ${grp.title}`),
            expandedGroups[grp.key] ? h('div', { style: S.rowWrap }, grp.vars.map((v) => h('button', { key: v, type: 'button', 'data-testid': `dxos-flow-var-chip-${v}`, onClick: () => insertVariable(v), style: S.chip }, v))) : null,
          )),
        ) : null,
        fields.map((f) => h('div', { key: f.name, style: S.grid(2) }, f.type !== 'boolean' ? h('label', { style: S.label }, `${f.label || f.name}${f.required ? ' *' : ''}`) : null, renderFieldControl(f))),
        node.type === 'trigger.webhook' ? h(WebhookHelper, { nodeId: node.id, nodeCfg, ruleKey, orgKey, onTestNode, onDryRunWebhook, onSwitchToOutput: () => setTab('output'), testBusy }) : null,
        h('div', { style: S.card },
          h('button', { type: 'button', 'data-testid': 'dxos-flow-inspector-advanced-toggle', 'aria-expanded': advancedOpen, onClick: () => setAdvancedOpen((v) => !v), style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', fontSize: 12, fontWeight: 700, color: '#334155' } }, 'Nâng cao (Execution Policy & Raw JSON)', h('span', null, advancedOpen ? '▾' : '▸')),
          advancedOpen ? h('div', { style: S.grid(8) },
            h('div', { style: S.grid2 },
              h('label', { style: S.checkRow }, h('input', { 'data-testid': 'dxos-flow-continue-on-fail-checkbox', type: 'checkbox', checked: Boolean(node.continueOnFail), onChange: (e) => onUpdateNode?.(node.id, { continueOnFail: Boolean(e?.target?.checked) }) }), 'Continue on Fail'),
              inpField('Timeout (ms)', 'dxos-flow-timeout-input', { type: 'number', min: 100, value: node.timeoutMs ?? '', placeholder: '30000', onChange: (e) => { const raw = e?.target?.value ?? ''; const n = Number(raw); onUpdateNode?.(node.id, { timeoutMs: raw !== '' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined }); } }),
            ),
            h('textarea', { 'data-testid': 'dxos-flow-raw-config-json', rows: 4, value: currentRawText(), onFocus: (e) => trackCursor('__raw__', e), onClick: (e) => trackCursor('__raw__', e), onKeyUp: (e) => trackCursor('__raw__', e), onSelect: (e) => trackCursor('__raw__', e), onChange: (e) => { trackCursor('__raw__', e); updateRawConfigText(e?.target?.value ?? ''); }, style: S.textarea }),
            bufActive && jsonBuf.raw?.error ? h('span', { style: S.err(10) }, jsonBuf.raw.error) : null,
          ) : null,
        ),
      ) : null,
      tab === 'input' ? h('div', { style: S.grid(8) },
        h('div', { style: S.rowBetween },
          h('strong', { style: { fontSize: 12, color: '#0f172a' } }, 'Pinned Mock Input (JSON)'),
          h('button', { type: 'button', onClick: () => { if (!pinKey) return; const nextMap = { ...pinnedMap }; delete nextMap[pinKey]; setPinnedMap(nextMap); persistPins(nextMap); }, style: S.btn(false, false, false) }, 'Reset Sample'),
        ),
        h('textarea', { 'data-testid': 'dxos-flow-pinned-input-json', rows: 8, value: pinnedEntry.text, style: S.textarea, onChange: (e) => { if (!pinKey) return; const t = e?.target?.value ?? ''; const parsed = safeParseJson(t); const nextMap = { ...pinnedMap, [pinKey]: { text: t, error: parsed.ok ? null : parsed.error } }; setPinnedMap(nextMap); persistPins(nextMap); } }),
        pinnedEntry.error ? h('span', { style: S.err(11) }, pinnedEntry.error) : null,
        h('button', { 'data-testid': 'dxos-flow-test-node-btn', type: 'button', disabled: Boolean(testBusy || pinnedEntry.error), onClick: () => { const parsed = safeParseJson(pinnedEntry.text); if (parsed.ok) { setTab('output'); onTestNode?.(node.id, parsed.value); } }, style: S.btn(true, false, Boolean(testBusy || pinnedEntry.error)) }, testBusy ? 'Testing Node…' : 'Test This Node'),
      ) : null,
      tab === 'output' ? renderTraceIoView(h, { displayOut, activeTrace, formatJson, statusTone, S }) : null,
    );
  };
}

module.exports = { createNodeInspector };
