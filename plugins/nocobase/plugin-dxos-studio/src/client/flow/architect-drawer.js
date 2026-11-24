/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

function createArchitectDrawer(React) {
  const h = React.createElement;

  const QUICK_PROMPTS = [
    'On record creation in latticeRequests: if data.amount > 1000 require ldx_manager approval then notify ldx_operator',
    'Schedule daily 0 8 * * 1-5 AI summary report and notify ldx_manager',
    'Receive inbound webhook, iterate items in bounded loop, and sync via HTTP connector',
  ];

  const S = {
    root: { position: 'absolute', top: 0, right: 0, bottom: 0, width: 400, minWidth: 320, maxWidth: '100%', zIndex: 30, boxShadow: '-8px 0 24px rgba(15, 23, 42, 0.14)', overflowY: 'auto', borderLeft: '1px solid #ddd6fe', background: '#ffffff', padding: 12, display: 'flex', flexDirection: 'column', gap: 10, boxSizing: 'border-box' },
    header: { padding: 10, borderRadius: 8, border: '1px solid #ddd6fe', background: 'linear-gradient(135deg, #f5f3ff 0%, #eff6ff 100%)', display: 'grid', gap: 6 },
    rowBetween: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
    rowWrap: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' },
    card: { padding: 10, borderRadius: 8, border: '1px solid #e2e8f0', background: '#f8fafc', display: 'grid', gap: 6 },
    textarea: { width: '100%', padding: 8, borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 12, boxSizing: 'border-box', background: '#ffffff', color: '#0f172a', resize: 'vertical' },
    btn: (primary, disabled) => ({ padding: '6px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer', border: `1px solid ${disabled ? '#cbd5e1' : primary ? '#6d28d9' : '#cbd5e1'}`, background: disabled ? '#e2e8f0' : primary ? '#6d28d9' : '#ffffff', color: disabled ? '#94a3b8' : primary ? '#ffffff' : '#1e293b' }),
    chip: { padding: '3px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600, border: '1px solid #ddd6fe', background: '#f5f3ff', color: '#5b21b6', cursor: 'pointer' },
    pill: (tone) => {
      const m = { llm: ['#dcfce7', '#166534', '#bbf7d0'], offline: ['#fef3c7', '#92400e', '#fde68a'], repair: ['#dbeafe', '#1e40af', '#bfdbfe'], danger: ['#fee2e2', '#991b1b', '#fecaca'] }[tone] || ['#f1f5f9', '#475569', '#cbd5e1'];
      return { display: 'inline-block', padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700, background: m[0], color: m[1], border: `1px solid ${m[2]}` };
    },
  };

  function hasRunFailure(run) {
    if (!run || typeof run !== 'object') return false;
    const st = String(run.status || '').toLowerCase();
    if (st === 'failed' || st === 'error' || st === 'partial') return true;
    if (run.errorMessage && String(run.errorMessage).trim()) return true;
    const states = run.nodeStatesJson && typeof run.nodeStatesJson === 'object' ? Object.values(run.nodeStatesJson) : [];
    if (states.some((s) => ['failed', 'error'].includes(String(s?.status || '').toLowerCase()) || s?.error)) return true;
    const traces = Array.isArray(run.stepTracesJson) ? run.stepTracesJson : [];
    return traces.some((t) => ['failed', 'error'].includes(String(t?.status || '').toLowerCase()) || t?.error);
  }

  return function ArchitectDrawer(props = {}) {
    const {
      open = false, onClose, rule = null, graph = null, selectedNode = null, selectedRun = null,
      catalog = {}, onRunArchitect, architectBusy = false, result = null, onApplyResult,
    } = props;

    const [prompt, setPrompt] = React.useState('');

    const targetNodeId = React.useMemo(() => {
      if (!selectedNode) return null;
      return typeof selectedNode === 'string' ? selectedNode : (selectedNode.id || null);
    }, [selectedNode]);

    const runHasError = React.useMemo(() => hasRunFailure(selectedRun), [selectedRun]);

    if (!open) return null;

    const modeUsed = result?.modeUsed || (catalog?.llmConfigured ? 'llm' : 'offline-fallback');
    const isRealLlm = modeUsed === 'llm';
    const repairAttempts = Number(result?.repairAttempts || 0);

    const diff = result?.graphDiff || {};
    const addedNodes = Array.isArray(diff.addedNodes) ? diff.addedNodes : [];
    const updatedNodes = Array.isArray(diff.updatedNodes) ? diff.updatedNodes : [];
    const removedNodes = Array.isArray(diff.removedNodes) ? diff.removedNodes : [];
    const addedEdges = Array.isArray(diff.addedEdges) ? diff.addedEdges : [];
    const removedEdges = Array.isArray(diff.removedEdges) ? diff.removedEdges : [];
    const hasDiffItems = addedNodes.length + updatedNodes.length + removedNodes.length + addedEdges.length + removedEdges.length > 0;
    const canApply = Boolean(result && !result.refused && result.ok !== false && (result.draftGraph || result.draftRule || result.graphDiff));
    const suggestions = Array.isArray(result?.suggestions) ? result.suggestions : [];

    function triggerMode(mode) {
      onRunArchitect?.({
        mode,
        prompt,
        ruleKey: rule?.ruleKey || null,
        graph,
        targetNodeId,
        runUid: selectedRun?.runUid || null,
        runTrace: selectedRun || null,
      });
    }

    return h('aside', { 'data-testid': 'dxos-flow-architect-drawer', style: S.root },
      // Header
      h('div', { style: S.header },
        h('div', { style: S.rowBetween },
          h('strong', { style: { fontSize: 14, color: '#4c1d95' } }, 'DX-OS Flow Architect'),
          h('button', { 'data-testid': 'dxos-architect-close-btn', type: 'button', onClick: () => onClose?.(), style: S.btn(false, false) }, 'Close'),
        ),
        h('div', { style: S.rowWrap },
          h('span', { 'data-testid': 'dxos-architect-llm-status', style: S.pill(isRealLlm ? 'llm' : 'offline') }, isRealLlm ? 'LLM thật' : 'Offline Fallback'),
          repairAttempts > 0 ? h('span', { 'data-testid': 'dxos-architect-repair-pill', style: S.pill('repair') }, `Auto-repair: ${repairAttempts}`) : null,
          catalog?.llmService?.modelName ? h('span', { style: { fontSize: 11, color: '#475569' } }, String(catalog.llmService.modelName)) : null,
        ),
        h('div', { style: { fontSize: 11, color: '#64748b' } },
          `Target: ${targetNodeId ? `Node "${targetNodeId}"` : 'Whole Flow'} · Nodes: ${(graph?.nodes || []).length}${selectedRun?.runUid ? ` · Run: ${selectedRun.runUid}` : ''}`,
        ),
      ),

      // Prompt Textarea + Quick Examples
      h('div', { style: { display: 'grid', gap: 6 } },
        h('label', { style: { fontSize: 11, fontWeight: 600, color: '#334155' } }, 'Architecture / Repair Prompt'),
        h('textarea', {
          'data-testid': 'dxos-architect-prompt-input',
          rows: 3,
          value: prompt,
          placeholder: 'Describe the automation DAG to build, node patch to apply, or validation fix...',
          onChange: (e) => setPrompt(e?.target?.value ?? ''),
          style: S.textarea,
        }),
        h('div', { style: S.rowWrap },
          QUICK_PROMPTS.map((qp, idx) => h('button', {
            key: idx,
            type: 'button',
            onClick: () => setPrompt(qp),
            style: S.chip,
          }, `${qp.slice(0, 38)}…`)),
        ),
      ),

      // 4 Mode Buttons
      h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 } },
        h('button', { 'data-testid': 'dxos-architect-build-btn', type: 'button', disabled: Boolean(architectBusy), onClick: () => triggerMode('full'), style: S.btn(true, Boolean(architectBusy)) }, 'Build Flow'),
        h('button', { 'data-testid': 'dxos-architect-patch-btn', type: 'button', disabled: Boolean(architectBusy || !targetNodeId), onClick: () => triggerMode('node'), style: S.btn(false, Boolean(architectBusy || !targetNodeId)) }, 'Patch Node'),
        h('button', { 'data-testid': 'dxos-architect-suggest-btn', type: 'button', disabled: Boolean(architectBusy), onClick: () => triggerMode('suggest'), style: S.btn(false, Boolean(architectBusy)) }, 'Suggest'),
        h('button', { 'data-testid': 'dxos-architect-fix-btn', type: 'button', disabled: Boolean(architectBusy || !runHasError), onClick: () => triggerMode('fix_error'), style: S.btn(false, Boolean(architectBusy || !runHasError)) }, 'Fix Last Error'),
      ),

      // Result Error / Refusal
      result && (result.refused || result.ok === false || result.error) ? h('div', {
        'data-testid': 'dxos-architect-error',
        style: { padding: 10, borderRadius: 8, border: '1px solid #fecaca', background: '#fef2f2', color: '#991b1b', fontSize: 12, display: 'grid', gap: 4 },
      },
        h('strong', null, result.refused ? 'Security / Policy Refused' : 'Architect Error'),
        h('span', null, String(result.error || 'Request could not be completed.')),
        Array.isArray(result.validationErrors) && result.validationErrors.length
          ? h('ul', { style: { margin: 0, paddingLeft: 16, fontSize: 11 } }, result.validationErrors.map((ve, i) => h('li', { key: i }, ve.message || ve.code)))
          : null,
      ) : null,

      // Result Summary, Diff Preview, Suggestions, Apply to Canvas
      result && !result.refused && result.ok !== false ? h('div', { style: { ...S.card, background: '#ffffff', border: '1px solid #ddd6fe' } },
        h('div', { style: S.rowBetween },
          h('strong', { style: { fontSize: 12, color: '#4c1d95' } }, `Draft Result (${result.mode || 'full'})`),
          canApply ? h('button', {
            'data-testid': 'dxos-architect-apply-btn',
            type: 'button',
            onClick: () => onApplyResult?.(result),
            style: S.btn(true, false),
          }, 'Apply to Canvas') : null,
        ),
        result.summary ? h('div', { style: { fontSize: 12, color: '#1e293b' } }, String(result.summary)) : null,
        result.dryRunPreview ? h('div', { style: { fontSize: 11, color: '#0369a1', background: '#f0f9ff', padding: '4px 8px', borderRadius: 6, border: '1px solid #bae6fd' } },
          `Dry-Run Preview: ${result.dryRunPreview.status || 'completed'} (${result.dryRunPreview.durationMs ?? 0} ms)`,
        ) : null,

        // Graph Diff Preview
        h('div', { 'data-testid': 'dxos-architect-diff-preview', style: { ...S.card, padding: 8 } },
          h('div', { style: S.rowBetween },
            h('strong', { style: { fontSize: 11, color: '#334155' } }, 'Graph Diff Preview'),
            h('span', { style: { fontSize: 10, color: '#475569', fontFamily: 'monospace' } }, `+${addedNodes.length} ~${updatedNodes.length} -${removedNodes.length} ->${addedEdges.length}`),
          ),
          !hasDiffItems
            ? h('span', { style: { fontSize: 11, color: '#64748b' } }, 'No structural graph changes in diff.')
            : h('ul', { style: { margin: 0, paddingLeft: 16, fontSize: 11, display: 'grid', gap: 3 } },
              addedNodes.map((n) => h('li', { key: `add-${n.id}`, style: { color: '#15803d' } }, `+ ${n.label || n.id} [${n.type}]`)),
              updatedNodes.map((n) => h('li', { key: `upd-${n.id}`, style: { color: '#1d4ed8' } }, `~ ${n.label || n.id} [${n.type}]`)),
              removedNodes.map((n) => h('li', { key: `rem-${n.id}`, style: { color: '#b91c1c' } }, `- ${n.label || n.id} [${n.type}]`)),
              addedEdges.map((e, idx) => h('li', { key: `edge-${e.id || idx}`, style: { color: '#6d28d9' } }, `-> ${e.source}:${e.sourceHandle || 'main'} -> ${e.target}`)),
              removedEdges.map((e, idx) => h('li', { key: `rm-edge-${e.id || idx}`, style: { color: '#991b1b' } }, `- edge ${e.source} -> ${e.target}`)),
            ),
        ),

        // Suggestions
        suggestions.length ? h('div', { style: { display: 'grid', gap: 6 } },
          h('strong', { style: { fontSize: 11, color: '#334155' } }, `Suggestions (${suggestions.length})`),
          suggestions.map((sug, idx) => h('div', { key: sug.id || idx, style: { padding: 8, borderRadius: 6, border: '1px solid #e2e8f0', background: '#f8fafc', display: 'grid', gap: 4 } },
            h('div', { style: S.rowBetween },
              h('strong', { style: { fontSize: 11, color: '#0f172a' } }, sug.title || sug.id || `Suggestion ${idx + 1}`),
              sug.severity ? h('span', { style: S.pill(sug.severity === 'warning' ? 'offline' : 'repair') }, sug.severity) : null,
            ),
            sug.reason ? h('span', { style: { fontSize: 11, color: '#475569' } }, sug.reason) : null,
            Array.isArray(sug.operations) && sug.operations.length ? h('button', {
              'data-testid': `dxos-architect-apply-suggestion-${sug.id || idx}`,
              type: 'button',
              onClick: () => onApplyResult?.(sug),
              style: S.btn(false, false),
            }, 'Apply Suggestion') : null,
          )),
        ) : null,
      ) : null,
    );
  };
}

module.exports = { createArchitectDrawer };
