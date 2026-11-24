/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

function createNodeInspector(React) {
  const h = React.createElement;
  const BLOCKED = new Set(['__proto__', 'constructor', 'prototype']);
  const STEP_VAR_MAP = { 'data.query': ['items', 'count'], 'logic.dmn': ['outputs'], 'ai.llm': ['data', 'content'], 'integration.http': ['response'], 'control.approval': ['decision'] };
  const TONE_MAP = [[['completed', 'ok', 'succeeded', 'approved'], 'ok'], [['failed', 'error', 'rejected'], 'danger'], [['suspended', 'skipped', 'simulated', 'pending'], 'warn']];

  const S = {
    root: { width: 340, minWidth: 290, maxWidth: '100%', height: '100%', overflowY: 'auto', borderLeft: '1px solid #e2e8f0', background: '#ffffff', padding: 12, display: 'flex', flexDirection: 'column', gap: 10, boxSizing: 'border-box' },
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
    tab: (active) => ({ flex: 1, padding: '6px 8px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', border: `1px solid ${active ? '#1677ff' : '#cbd5e1'}`, background: active ? '#eff6ff' : '#ffffff', color: active ? '#1d4ed8' : '#475569' }),
    btn: (primary, danger, disabled) => ({ padding: '6px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer', border: `1px solid ${disabled ? '#cbd5e1' : danger ? '#fca5a5' : primary ? '#1677ff' : '#cbd5e1'}`, background: disabled ? '#e2e8f0' : danger ? '#fef2f2' : primary ? '#1677ff' : '#ffffff', color: disabled ? '#94a3b8' : danger ? '#b91c1c' : primary ? '#ffffff' : '#334155' }),
    chip: { padding: '2px 7px', borderRadius: 999, fontSize: 11, fontWeight: 600, border: '1px solid #bfdbfe', background: '#eff6ff', color: '#1e40af', cursor: 'pointer', fontFamily: 'monospace' },
    badge: (tone) => {
      const m = { ok: ['#dcfce7', '#166534'], danger: ['#fee2e2', '#991b1b'], warn: ['#fef3c7', '#92400e'], info: ['#dbeafe', '#1e40af'] }[tone] || ['#f1f5f9', '#475569'];
      return { display: 'inline-block', padding: '2px 7px', borderRadius: 999, fontSize: 10, fontWeight: 700, background: m[0], color: m[1] };
    },
  };

  function safeParseJson(text) {
    try {
      const reviver = (k, v) => (BLOCKED.has(k) ? (() => { throw new Error(`Blocked key "${k}"`); })() : v);
      return { ok: true, value: JSON.parse(String(text || ''), reviver) };
    } catch (err) {
      return { ok: false, error: err?.message || 'Invalid JSON' };
    }
  }
  const formatJson = (v, fb = {}) => {
    try { return JSON.stringify(v === undefined ? fb : v, null, 2); } catch { return '{}'; }
  };
  const statusTone = (st) => TONE_MAP.find(([keys]) => keys.includes(String(st || '').toLowerCase()))?.[1] || 'info';
  const toNum = (e) => ((e?.target?.value ?? '') === '' ? undefined : Number(e.target.value));

  function collectNames(items, target) {
    for (const item of items || []) {
      const nm = typeof item === 'string' ? item : item?.name;
      if (nm && !BLOCKED.has(nm)) target.add(nm);
    }
  }

  function collectAncestors(graph, targetId) {
    const byId = new Map((Array.isArray(graph?.nodes) ? graph.nodes : []).map((n) => [n.id, n]));
    const edges = Array.isArray(graph?.edges) ? graph.edges : [];
    const seen = new Set([targetId]);
    const queue = [targetId];
    const out = [];
    for (let i = 0; i < queue.length; i += 1) {
      for (const e of edges.filter((x) => x?.target === queue[i] && x.source && !seen.has(x.source))) {
        seen.add(e.source);
        queue.push(e.source);
        if (byId.has(e.source)) out.push(byId.get(e.source));
      }
    }
    return out;
  }

  function buildVariableGroups({ rule, graph, node, catalog }) {
    const dataKeys = new Set(['id', 'code', 'status']);
    if (rule?.sampleEvent?.data && typeof rule.sampleEvent.data === 'object') {
      collectNames(Object.keys(rule.sampleEvent.data).slice(0, 12), dataKeys);
    }
    const trig = (graph?.nodes || []).find((n) => String(n.type || '').startsWith('trigger.'));
    const colName = trig?.config?.collection || node?.config?.collection || node?.config?.targetCollection;
    collectNames(((catalog?.collections || []).find((c) => c.name === colName)?.fields || []).slice(0, 8), dataKeys);

    const dmnKeys = new Set();
    const dmnSet = new Set([
      ...(graph?.nodes || []).filter((n) => n.type === 'logic.dmn').map((n) => n.config?.tableKey).filter(Boolean),
      ...(rule?.dmnTableKey ? [rule.dmnTableKey] : []),
    ]);
    for (const dt of Array.isArray(catalog?.dmnTables) ? catalog.dmnTables : []) {
      if (!dmnSet.size || dmnSet.has(dt.tableKey || dt.key)) collectNames(dt.outputsJson || dt.outputs, dmnKeys);
    }
    if (!dmnKeys.size) collectNames(['priority', 'assignedRole', 'decision'], dmnKeys);

    const ancestors = node ? collectAncestors(graph, node.id) : [];
    const stepVars = ancestors.flatMap((anc) => {
      const suffixes = STEP_VAR_MAP[anc.type];
      return [`{{steps.${anc.id}.id}}`, ...(suffixes ? suffixes.map((s) => `{{steps.${anc.id}.${s}}}`) : [`{{nodes.${anc.id}.output}}`])];
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
      onUpdateNode, onDeleteNode, onUpdateRuleMeta, onTestNode, testOutput = null, testBusy = false, activeTrace = null,
    } = props;
    const node = React.useMemo(() => (!selectedNode ? null : typeof selectedNode === 'string'
      ? (graph?.nodes || []).find((n) => n.id === selectedNode) || null
      : selectedNode), [selectedNode, graph]);
    const schema = React.useMemo(() => nodeSchema
      || (node?.type ? (catalog?.nodeTypes || []).find((t) => t.type === node.type) || null : null), [nodeSchema, node, catalog]);

    const [tab, setTab] = React.useState('config');
    const [varPickerOpen, setVarPickerOpen] = React.useState(false);
    const [expandedGroups, setExpandedGroups] = React.useState({ event: true, dmn: true, steps: true, loop: true });
    const [activeFieldState, setActiveFieldState] = React.useState({ scopeKey: '', name: null });
    const [jsonBuf, setJsonBuf] = React.useState({ scopeKey: '', configSig: '', entries: {}, raw: null });
    const [pinnedMap, setPinnedMap] = React.useState({});
    const ruleKey = rule?.ruleKey || '__draft__';
    const nodeId = node?.id || null;
    const scopeKey = nodeId ? `${ruleKey}:${nodeId}` : '';
    const pinKey = nodeId ? `${ruleKey}::${nodeId}` : null;
    const nodeCfg = node?.config && typeof node.config === 'object' ? node.config : {};
    const configSig = React.useMemo(() => formatJson(nodeCfg, {}), [nodeCfg]);
    const fields = React.useMemo(() => (Array.isArray(schema?.inputSchema?.fields) ? schema.inputSchema.fields : []), [schema]);

    React.useEffect(() => {
      if (jsonBuf.scopeKey && (jsonBuf.scopeKey !== scopeKey || jsonBuf.configSig !== configSig)) {
        setJsonBuf({ scopeKey: '', configSig: '', entries: {}, raw: null });
      }
    }, [scopeKey, configSig, jsonBuf.scopeKey, jsonBuf.configSig]);

    const [safeCols, safeConns, safeDmns, safeRoles, safeEvents] = ['collections', 'connectors', 'dmnTables', 'roles', 'eventTypes']
      .map((k) => (Array.isArray(catalog?.[k]) ? catalog[k] : []));

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
      const f = fields.find((x) => !resolveSelectOptions(x) && ['string', 'textarea', 'json'].includes(x.type))
        || fields.find((x) => ['string', 'textarea', 'json'].includes(x.type));
      return f ? f.name : '__raw__';
    }, [fields, safeCols.length, safeConns.length, safeDmns.length, safeRoles.length]);
    const activeField = (activeFieldState.scopeKey === scopeKey && (activeFieldState.name === '__raw__' || fields.some((f) => f.name === activeFieldState.name)))
      ? activeFieldState.name : defaultField;
    const setActiveField = (name) => setActiveFieldState({ scopeKey, name });
    const bufActive = Boolean(scopeKey && jsonBuf.scopeKey === scopeKey && jsonBuf.configSig === configSig);
    const currentJsonFieldText = (name, fallbackVal) => (
      bufActive && jsonBuf.entries[name] ? jsonBuf.entries[name].text : formatJson(nodeCfg[name] !== undefined ? nodeCfg[name] : fallbackVal, {})
    );
    const currentRawText = () => (bufActive && jsonBuf.raw ? jsonBuf.raw.text : configSig);
    const updateConfigField = (name, nextVal) => node && onUpdateNode?.(node.id, { config: { ...nodeCfg, [name]: nextVal } });

    function updateJsonFieldText(name, text) {
      if (!nodeId) return;
      const parsed = safeParseJson(text);
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
    function insertVariable(expr) {
      if (!node) return;
      if (activeField === '__raw__') return updateRawConfigText(`${currentRawText()}${expr}`);
      const def = fields.find((f) => f.name === activeField);
      if (def?.type === 'json') return updateJsonFieldText(activeField, `${currentJsonFieldText(activeField, schema?.defaultConfig?.[activeField])}${expr}`);
      const cur = nodeCfg[activeField];
      updateConfigField(activeField, `${cur === undefined || cur === null ? '' : String(cur)}${expr}`);
    }

    const defaultPinnedText = React.useMemo(() => {
      const ev = rule?.sampleEvent && typeof rule.sampleEvent === 'object' ? rule.sampleEvent : { type: 'manual.trigger', data: {} };
      return formatJson({ event: ev, data: ev.data || {}, dmn: {}, steps: {} }, {});
    }, [rule]);
    const pinnedEntry = pinKey && pinnedMap[pinKey] ? pinnedMap[pinKey] : { text: defaultPinnedText, error: null };
    const varGroups = React.useMemo(() => buildVariableGroups({ rule, graph, node, catalog }), [rule, graph, node, catalog]);
    const displayOut = (testOutput && (!node || !testOutput.nodeId || testOutput.nodeId === node.id)) ? testOutput : (activeTrace || null);

    function handleTimeoutChange(rawVal) {
      if (!node) return;
      const n = Number(rawVal);
      onUpdateNode?.(node.id, { timeoutMs: rawVal !== '' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined });
    }
    function handlePinnedChange(text) {
      if (!pinKey) return;
      const parsed = safeParseJson(text);
      setPinnedMap((p) => ({ ...p, [pinKey]: { text, error: parsed.ok ? null : parsed.error } }));
    }

    function renderFieldControl(f) {
      const val = nodeCfg[f.name] !== undefined ? nodeCfg[f.name] : (schema?.defaultConfig?.[f.name] ?? '');
      const testId = `dxos-flow-field-${f.name}`;
      const base = { 'data-testid': testId, placeholder: f.placeholder || '', onFocus: () => setActiveField(f.name) };
      const selectSpec = resolveSelectOptions(f);
      if (selectSpec) {
        const strVal = String(val || '');
        const hasVal = !strVal || selectSpec.items.some((it) => it.value === strVal);
        return h('select', { ...base, value: strVal, style: S.input, onChange: (e) => updateConfigField(f.name, e?.target?.value ?? '') },
          selectSpec.placeholder ? h('option', { value: '' }, selectSpec.placeholder) : null,
          selectSpec.items.map((it) => h('option', { key: it.value, value: it.value }, it.label)),
          !hasVal ? h('option', { value: strVal }, strVal) : null);
      }
      if (f.type === 'boolean') {
        return h('label', { style: S.checkRow },
          h('input', { 'data-testid': testId, type: 'checkbox', checked: Boolean(val), onChange: (e) => updateConfigField(f.name, Boolean(e?.target?.checked)) }),
          f.label || f.name);
      }
      if (f.type === 'number') return h('input', { ...base, type: 'number', value: val ?? '', style: S.input, onChange: (e) => updateConfigField(f.name, toNum(e)) });
      if (f.type === 'textarea') return h('textarea', { ...base, rows: 3, value: String(val || ''), style: S.textarea, onChange: (e) => updateConfigField(f.name, e?.target?.value ?? '') });
      if (f.type === 'json') {
        const err = bufActive ? jsonBuf.entries[f.name]?.error : null;
        const onRolePick = (r) => r && updateConfigField('roleNames', Array.isArray(val) && val.includes(r) ? val : [...(Array.isArray(val) ? val : []), r]);
        return h('div', { style: S.grid(4) },
          f.name === 'roleNames' && safeRoles.length ? h('select', { 'data-testid': 'dxos-flow-field-roleNames-picker', value: '', style: S.input, onChange: (e) => onRolePick(e?.target?.value) },
            h('option', { value: '' }, '+ Add role from catalog...'), safeRoles.map((r) => h('option', { key: r, value: r }, r))) : null,
          h('textarea', { ...base, rows: 3, value: currentJsonFieldText(f.name, schema?.defaultConfig?.[f.name]), style: S.textarea, onChange: (e) => updateJsonFieldText(f.name, e?.target?.value ?? '') }),
          err ? h('span', { style: S.err(10) }, err) : null);
      }
      return h('div', { style: S.grid(4) },
        f.name === 'eventType' && safeEvents.length ? h('select', {
          'data-testid': 'dxos-flow-field-eventType-picker', style: S.input,
          value: safeEvents.some((ev) => ev.type === val) ? String(val) : '',
          onChange: (e) => e?.target?.value && updateConfigField(f.name, e.target.value),
        }, h('option', { value: '' }, '-- Pick standard event --'), safeEvents.map((ev) => h('option', { key: ev.type, value: ev.type }, `${ev.type} — ${ev.label}`))) : null,
        h('input', { ...base, type: 'text', value: String(val ?? ''), style: S.input, onChange: (e) => updateConfigField(f.name, e?.target?.value ?? '') }));
    }

    const ruleField = (label, testId, inputProps) => h('div', null,
      h('label', { style: S.label }, label),
      h('input', { 'data-testid': testId, ...inputProps, style: S.input }));

    return h('aside', { 'data-testid': 'dxos-flow-inspector', style: S.root },
      h('div', { style: S.card },
        h('div', { style: S.rowBetween },
          h('strong', { style: { fontSize: 12, color: '#0f172a' } }, 'Flow Rule Settings'),
          h('span', { style: S.badge(rule?.active === false ? 'warn' : 'ok') }, rule?.active === false ? 'paused' : 'active'),
        ),
        h('div', { style: S.grid2 },
          ruleField('Rule Key', 'dxos-flow-rule-key-input', { type: 'text', value: rule?.ruleKey ?? '', placeholder: 'flow_rule_key', onChange: (e) => onUpdateRuleMeta?.({ ruleKey: e?.target?.value ?? '' }) }),
          ruleField('Rule Name', 'dxos-flow-rule-name-input', { type: 'text', value: rule?.name ?? '', placeholder: 'Flow rule name', onChange: (e) => onUpdateRuleMeta?.({ name: e?.target?.value ?? '' }) }),
          ruleField('Cooldown (sec)', 'dxos-flow-rule-cooldown-input', { type: 'number', min: 0, value: rule?.cooldownSec ?? graph?.settings?.cooldownSec ?? 0, onChange: (e) => onUpdateRuleMeta?.({ cooldownSec: Math.max(0, Math.floor(Number(e?.target?.value) || 0)) }) }),
          ruleField('Max Depth (1..8)', 'dxos-flow-rule-maxdepth-input', { type: 'number', min: 1, max: 8, value: rule?.maxDepth ?? graph?.settings?.maxDepth ?? 8, onChange: (e) => onUpdateRuleMeta?.({ maxDepth: Math.min(8, Math.max(1, Math.floor(Number(e?.target?.value) || 8))) }) }),
        ),
      ),
      !node
        ? h('div', { style: { ...S.card, color: '#64748b', fontSize: 12 } }, 'Select a node on the canvas to inspect Config, Input / Pin, and Output.')
        : h(React.Fragment, null,
          h('div', { style: S.card },
            h('div', { style: S.rowBetween },
              h('div', { style: S.rowWrap }, h('span', { style: S.badge('info') }, node.type), h('code', { style: { fontSize: 11, color: '#475569' } }, node.id)),
              h('button', { 'data-testid': 'dxos-flow-delete-node-btn', type: 'button', onClick: () => onDeleteNode?.(node.id), style: S.btn(false, true, false) }, 'Delete'),
            ),
            ruleField('Node Label', 'dxos-flow-node-label-input', { type: 'text', value: node.label || '', onChange: (e) => onUpdateNode?.(node.id, { label: e?.target?.value ?? '' }) }),
          ),
          h('div', { role: 'tablist', style: { display: 'flex', gap: 6 } },
            [['config', 'Config'], ['input', 'Input / Pin'], ['output', 'Output']].map(([key, lbl]) => h('button', {
              key, role: 'tab', type: 'button', 'aria-selected': tab === key,
              'data-testid': `dxos-flow-inspector-tab-${key}`, onClick: () => setTab(key), style: S.tab(tab === key),
            }, lbl)),
          ),
          tab === 'config' ? h('div', { style: S.grid(8) },
            h('div', { style: S.rowBetween },
              h('span', { style: { fontSize: 11, fontWeight: 600, color: '#475569' } }, `Parameters (${fields.length})`),
              h('button', { 'data-testid': 'dxos-flow-var-picker-btn', type: 'button', onClick: () => setVarPickerOpen((p) => !p), style: S.btn(varPickerOpen, false, false) }, '{ } Variables'),
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
            fields.map((f) => h('div', { key: f.name, style: S.grid(2) },
              f.type !== 'boolean' ? h('label', { style: S.label }, `${f.label || f.name}${f.required ? ' *' : ''}`) : null,
              renderFieldControl(f))),
            h('div', { style: S.card },
              h('strong', { style: { fontSize: 11, color: '#334155' } }, 'Execution Policy & Raw JSON'),
              h('div', { style: S.grid2 },
                h('label', { style: S.checkRow },
                  h('input', { 'data-testid': 'dxos-flow-continue-on-fail-checkbox', type: 'checkbox', checked: Boolean(node.continueOnFail), onChange: (e) => onUpdateNode?.(node.id, { continueOnFail: Boolean(e?.target?.checked) }) }), 'Continue on Fail'),
                ruleField('Timeout (ms)', 'dxos-flow-timeout-input', { type: 'number', min: 100, value: node.timeoutMs ?? '', placeholder: '30000', onChange: (e) => handleTimeoutChange(e?.target?.value ?? '') }),
              ),
              h('textarea', { 'data-testid': 'dxos-flow-raw-config-json', rows: 4, value: currentRawText(), onFocus: () => setActiveField('__raw__'), onChange: (e) => updateRawConfigText(e?.target?.value ?? ''), style: S.textarea }),
              bufActive && jsonBuf.raw?.error ? h('span', { style: S.err(10) }, jsonBuf.raw.error) : null,
            ),
          ) : null,
          tab === 'input' ? h('div', { style: S.grid(8) },
            h('div', { style: S.rowBetween },
              h('strong', { style: { fontSize: 12, color: '#0f172a' } }, 'Pinned Mock Input (JSON)'),
              h('button', { type: 'button', onClick: () => pinKey && setPinnedMap((p) => ({ ...p, [pinKey]: { text: defaultPinnedText, error: null } })), style: S.btn(false, false, false) }, 'Reset Sample'),
            ),
            h('textarea', { 'data-testid': 'dxos-flow-pinned-input-json', rows: 8, value: pinnedEntry.text, style: S.textarea, onChange: (e) => handlePinnedChange(e?.target?.value ?? '') }),
            pinnedEntry.error ? h('span', { style: S.err(11) }, pinnedEntry.error) : null,
            h('button', {
              'data-testid': 'dxos-flow-test-node-btn', type: 'button', disabled: Boolean(testBusy || pinnedEntry.error),
              onClick: () => {
                const parsed = safeParseJson(pinnedEntry.text);
                if (parsed.ok) onTestNode?.(node.id, parsed.value);
              },
              style: S.btn(true, false, Boolean(testBusy || pinnedEntry.error)),
            }, testBusy ? 'Testing Node…' : 'Test This Node'),
          ) : null,
          tab === 'output' ? h('div', { 'data-testid': 'dxos-flow-output-view', style: S.card }, !displayOut
            ? h('span', { style: { fontSize: 12, color: '#64748b' } }, 'No test output or trace yet. Run "Test This Node" or Dry-Run.')
            : h(React.Fragment, null,
              h('div', { style: S.rowBetween },
                h('span', { 'data-testid': 'dxos-flow-output-status', style: S.badge(statusTone(displayOut.status)) }, displayOut.status || 'completed'),
                h('span', { style: { fontSize: 11, color: '#475569' } }, `${displayOut.durationMs ?? 0} ms · nextPort: ${displayOut.nextPort || displayOut.nextPorts?.[0] || '-'}`)),
              (displayOut.error || displayOut.reason) ? h('div', { style: { padding: 8, borderRadius: 6, background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', fontSize: 11 } }, String(displayOut.error || displayOut.reason)) : null,
              h('pre', { 'data-testid': 'dxos-flow-output-json', style: { margin: 0, padding: 8, borderRadius: 6, background: '#0f172a', color: '#e2e8f0', fontSize: 11, overflowX: 'auto', maxHeight: 300 } }, formatJson(displayOut.output !== undefined ? displayOut.output : displayOut, null)))) : null,
        ),
    );
  };
}

module.exports = { createNodeInspector };
