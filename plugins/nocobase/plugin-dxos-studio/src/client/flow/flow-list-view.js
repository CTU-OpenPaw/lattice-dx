/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

function createFlowListView(React) {
  const h = React.createElement;
  const S = {
    root: { flex: 1, minHeight: 0, overflowY: 'auto', background: '#F8FAFC', padding: '18px 22px 32px', display: 'flex', flexDirection: 'column', gap: 14, boxSizing: 'border-box' },
    header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, padding: '14px 16px', borderRadius: 12, background: '#FFFFFF', border: '1px solid #E2E8F0' },
    row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
    bar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 },
    input: { padding: '6px 10px', borderRadius: 8, border: '1px solid #CBD5E1', background: '#FFFFFF', color: '#0F172A', fontSize: 12, outline: 'none' },
    card: { padding: '14px 16px', borderRadius: 12, background: '#FFFFFF', border: '1px solid #E2E8F0', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 },
    btn: (tone = 'ghost', disabled = false) => {
      const m = { primary: ['#2563EB', '#FFFFFF', '#2563EB'], ai: ['#0F172A', '#FFFFFF', '#0F172A'], active: ['#EFF6FF', '#1D4ED8', '#93C5FD'], infra: ['#F8FAFC', '#334155', '#CBD5E1'], ghost: ['#FFFFFF', '#0F172A', '#CBD5E1'] }[tone] || ['#FFFFFF', '#0F172A', '#CBD5E1'];
      return { padding: '6px 12px', borderRadius: 8, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.55 : 1, background: disabled ? '#E2E8F0' : m[0], color: disabled ? '#64748B' : m[1], border: `1px solid ${disabled ? '#CBD5E1' : m[2]}` };
    },
    pill: (active) => ({ padding: '5px 11px', borderRadius: 999, fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap', border: `1px solid ${active ? '#2563EB' : '#CBD5E1'}`, background: active ? '#EFF6FF' : '#FFFFFF', color: active ? '#1D4ED8' : '#475569' }),
    badge: (tone) => {
      const m = { ok: ['#ECFDF5', '#047857', '#A7F3D0'], paused: ['#F1F5F9', '#475569', '#CBD5E1'], warn: ['#FFFBEB', '#B45309', '#FDE68A'], err: ['#FEF2F2', '#B91C1C', '#FECACA'], info: ['#EFF6FF', '#1D4ED8', '#BFDBFE'] }[tone] || ['#F1F5F9', '#475569', '#CBD5E1'];
      return { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600, background: m[0], color: m[1], border: `1px solid ${m[2]}`, whiteSpace: 'nowrap' };
    },
  };

  return function FlowListView(props = {}) {
    const {
      rules = [], runs = [], blueprints = [], loading = false, runBusy = false,
      effectiveOrg = '', orgList = [], onOrgChange, bpOpen = false, onToggleBlueprints,
      onLoadBlueprint, onOpenRule, onRunNow, onNewFlow, onOpenAiArchitect, onOpenRoute,
      onToggleRuleActive, onDuplicateRule,
    } = props;
    const [search, setSearch] = React.useState('');
    const [filter, setFilter] = React.useState('all');

    const safeRules = Array.isArray(rules) ? rules : [];
    const safeRuns = Array.isArray(runs) ? runs : [];
    const safeBlueprints = Array.isArray(blueprints) ? blueprints : [];
    const activeCount = React.useMemo(() => safeRules.filter((r) => r && r.active !== false).length, [safeRules]);
    const successRate = React.useMemo(() => {
      if (!safeRuns.length) return '100%';
      const ok = safeRuns.filter((r) => ['completed', 'simulated'].includes(String(r?.status || '').toLowerCase())).length;
      return `${Math.round((ok / safeRuns.length) * 100)}%`;
    }, [safeRuns]);
    const suspendedRuns = React.useMemo(() => safeRuns.filter((run) => String(run?.status || '').toLowerCase() === 'suspended'), [safeRuns]);
    const suspendedRuleKeys = React.useMemo(() => new Set(suspendedRuns.map((run) => run.ruleKey).filter(Boolean)), [suspendedRuns]);
    const latestRunByRule = React.useMemo(() => {
      const map = new Map();
      for (const run of safeRuns) if (run?.ruleKey && !map.has(run.ruleKey)) map.set(run.ruleKey, run);
      return map;
    }, [safeRuns]);

    const filteredRules = React.useMemo(() => {
      const q = String(search || '').trim().toLowerCase();
      return safeRules.filter((r) => {
        if (!r) return false;
        const isActive = r.active !== false;
        if ((filter === 'active' && !isActive) || (filter === 'paused' && isActive) || (filter === 'hitl' && !suspendedRuleKeys.has(r.ruleKey))) return false;
        return !q || `${r.name || ''} ${r.ruleKey || ''} ${r.description || ''} ${r.triggerEventType || ''}`.toLowerCase().includes(q);
      });
    }, [safeRules, search, filter, suspendedRuleKeys]);

    return h('div', { 'data-testid': 'dxos-flow-list-view', style: S.root },
      h('header', { 'data-testid': 'dxos-flow-list-header', style: S.header },
        h('div', { style: { display: 'grid', gap: 2 } },
          h('strong', { style: { fontSize: 16, color: '#0F172A', letterSpacing: '-0.01em' } }, 'Workflow Automation'),
          h('span', { style: { fontSize: 12, color: '#64748B' } }, 'Thiết kế DAG, mô phỏng Dry-Run, phê duyệt HITL và điều phối qua AI Architect'),
        ),
        h('div', { style: S.row },
          h('input', { 'data-testid': 'dxos-flow-org-input', type: 'text', list: orgList.length ? 'dxos-flow-org-list' : undefined, value: effectiveOrg, placeholder: 'Org ID', onChange: (e) => onOrgChange?.(e?.target?.value ?? ''), style: { ...S.input, width: 120 } }),
          orgList.length ? h('datalist', { id: 'dxos-flow-org-list' }, orgList.map((o) => h('option', { key: o, value: o }, o))) : null,
          h('input', { 'data-testid': 'dxos-flow-list-search', type: 'search', value: search, placeholder: 'Tìm theo tên, ruleKey, trigger…', onChange: (e) => setSearch(e?.target?.value ?? ''), style: { ...S.input, width: 210 } }),
          h('button', { 'data-testid': 'dxos-flow-list-ai-btn', type: 'button', onClick: () => onOpenAiArchitect?.(), style: S.btn('ai') }, '✦ Tạo bằng AI'),
          h('button', { 'data-testid': 'dxos-flow-blueprints-btn', type: 'button', onClick: () => onToggleBlueprints?.(), style: S.btn(bpOpen ? 'active' : 'ghost') }, `Mẫu sẵn có (${safeBlueprints.length})`),
          h('button', { 'data-testid': 'dxos-flow-new-btn', type: 'button', onClick: () => onNewFlow?.(), style: S.btn('primary') }, '+ Tạo luồng mới'),
        ),
      ),

      h('div', { 'data-testid': 'dxos-flow-kpi-strip', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(155px, 1fr))', gap: 10 } },
        [
          ['Tổng quy trình', String(safeRules.length), '#0F172A', () => setFilter('all')],
          ['Đang bật', String(activeCount), '#047857', () => setFilter('active')],
          ['Chờ duyệt HITL', String(suspendedRuns.length), suspendedRuns.length ? '#B45309' : '#475569', () => setFilter('hitl')],
          ['Tỷ lệ chạy thành công', successRate, '#1D4ED8', null],
        ].map(([lbl, val, col, onClick], i) => h('div', {
          key: i,
          role: onClick ? 'button' : undefined,
          tabIndex: onClick ? 0 : undefined,
          onClick: onClick || undefined,
          style: { padding: '10px 14px', borderRadius: 10, background: '#FFFFFF', border: '1px solid #E2E8F0', cursor: onClick ? 'pointer' : 'default', display: 'grid', gap: 2 },
        },
          h('span', { style: { fontSize: 11, color: '#64748B', fontWeight: 600 } }, lbl),
          h('strong', { style: { fontSize: 18, color: col, letterSpacing: '-0.02em' } }, val),
        )),
      ),

      h('div', { style: S.bar },
        h('div', { style: S.row },
          [['all', 'Tất cả'], ['active', 'Đang bật'], ['paused', 'Tạm dừng'], ['hitl', 'Chờ duyệt HITL']].map(([key, label]) => h('button', {
            key, type: 'button', 'data-testid': `dxos-flow-filter-${key}`, 'aria-pressed': filter === key,
            onClick: () => setFilter(key), style: S.pill(filter === key),
          }, key === 'hitl' && suspendedRuleKeys.size ? `${label} (${suspendedRuleKeys.size})` : label)),
        ),
        h('div', { style: S.row },
          h('button', { 'data-testid': 'dxos-flow-goto-vault-btn', type: 'button', onClick: () => onOpenRoute?.('/admin/settings/dxos-studio?tab=automation'), style: S.btn('infra') }, '🔗 Connectors / n8n ↗'),
          h('button', { 'data-testid': 'dxos-flow-goto-broker-btn', type: 'button', onClick: () => onOpenRoute?.('/admin/settings/dxos-studio?tab=broker'), style: S.btn('infra') }, '📡 Broker (MQTT / Orion-LD) ↗'),
        ),
      ),

      bpOpen ? h('section', { 'data-testid': 'dxos-flow-blueprints-gallery', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10, padding: 14, borderRadius: 12, background: '#FFFFFF', border: '1px solid #CBD5E1' } },
        safeBlueprints.map((bp) => {
          const bpKey = bp.blueprintKey || bp.ruleKey;
          return h('div', { key: bpKey, style: { padding: 12, borderRadius: 10, background: '#F8FAFC', border: '1px solid #E2E8F0', display: 'grid', gap: 6 } },
            h('strong', { style: { fontSize: 13, color: '#0F172A' } }, bp.name || bpKey),
            h('span', { style: { fontSize: 11, color: '#64748B' } }, `${bp.category || 'flow'} · ${bp.graphJson?.nodes?.length || 0} nodes`),
            h('button', { 'data-testid': `dxos-flow-blueprint-load-${bpKey}`, type: 'button', onClick: () => onLoadBlueprint?.(bp), style: S.btn('primary') }, 'Mở Blueprint trên Canvas'),
          );
        }),
      ) : null,

      suspendedRuns.length > 0 ? h('div', {
        'data-testid': 'dxos-flow-list-hitl-callout', role: 'status',
        style: { padding: '10px 14px', borderRadius: 10, background: '#FFFBEB', border: '1px solid #FDE68A', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 },
      },
        h('div', { style: { fontSize: 12, color: '#92400E' } },
          h('strong', null, `${suspendedRuns.length} phiên chạy đang chờ duyệt HITL: `),
          suspendedRuns.slice(0, 3).map((r) => `${r.ruleKey || r.runUid}`).join(', '),
        ),
        h('div', { style: S.row },
          suspendedRuns.slice(0, 3).map((run) => h('button', {
            key: run.runUid || run.id, 'data-testid': `dxos-flow-list-hitl-open-${run.ruleKey}`, type: 'button',
            onClick: () => onOpenRule?.(run.ruleKey),
            style: { padding: '5px 10px', borderRadius: 8, border: '1px solid #F59E0B', background: '#FFFFFF', color: '#B45309', fontSize: 12, fontWeight: 600, cursor: 'pointer' },
          }, `Xem & Duyệt (${run.ruleKey}) →`)),
        ),
      ) : null,

      loading && !safeRules.length
        ? h('div', { 'data-testid': 'dxos-flow-list-loading', style: { padding: 32, textAlign: 'center', borderRadius: 12, background: '#FFFFFF', border: '1px solid #E2E8F0', color: '#64748B', fontSize: 13 } }, 'Đang tải danh sách quy trình tự động hóa…')
        : !filteredRules.length
          ? h('div', { 'data-testid': 'dxos-flow-list-empty', style: { padding: 36, textAlign: 'center', borderRadius: 12, background: '#FFFFFF', border: '1px dashed #CBD5E1', display: 'grid', gap: 10, justifyItems: 'center' } },
            h('strong', { style: { fontSize: 14, color: '#0F172A' } }, safeRules.length ? 'Không có quy trình phù hợp bộ lọc hiện tại' : 'Chưa có quy trình tự động hóa nào'),
            h('span', { style: { fontSize: 12, color: '#64748B' } }, 'Bắt đầu nhanh từ 6 Blueprint chuẩn công nghiệp hoặc mô tả yêu cầu để AI Architect dựng DAG.'),
            h('div', { style: S.row },
              h('button', { 'data-testid': 'dxos-flow-empty-blueprint-btn', type: 'button', onClick: () => onToggleBlueprints?.(true), style: S.btn('primary') }, '+ Tạo từ Blueprint'),
              h('button', { 'data-testid': 'dxos-flow-empty-ai-btn', type: 'button', onClick: () => onOpenAiArchitect?.(), style: S.btn('ai') }, '✦ Tạo bằng AI'),
            ),
          )
          : h('div', { style: { display: 'grid', gap: 10 } },
            filteredRules.map((r) => {
              const isActive = r.active !== false;
              const latest = latestRunByRule.get(r.ruleKey) || null;
              const hasHitl = suspendedRuleKeys.has(r.ruleKey);
              const nodeCount = Array.isArray(r.graphJson?.nodes) ? r.graphJson.nodes.length : 0;
              return h('article', { key: r.ruleKey, 'data-testid': `dxos-flow-list-card-${r.ruleKey}`, style: S.card },
                h('div', { style: { display: 'grid', gap: 6, flex: '1 1 360px', minWidth: 0 } },
                  h('div', { style: S.row },
                    h('span', { style: S.badge(isActive ? 'ok' : 'paused') },
                      h('span', { style: { width: 6, height: 6, borderRadius: 999, background: isActive ? '#10B981' : '#94A3B8', display: 'inline-block' } }),
                      isActive ? 'Đang bật' : 'Tạm dừng',
                    ),
                    h('strong', { style: { fontSize: 14, color: '#0F172A' } }, r.name || r.ruleKey),
                    h('code', { style: { fontSize: 11, color: '#475569', background: '#F1F5F9', padding: '2px 6px', borderRadius: 6 } }, r.ruleKey),
                  ),
                  r.description ? h('span', { style: { fontSize: 12, color: '#475569', lineHeight: 1.4 } }, r.description) : null,
                  h('div', { style: S.row },
                    h('span', { style: S.badge('info') }, `⚡ ${r.triggerEventType || '*'}`),
                    h('span', { style: S.badge('paused') }, `${nodeCount} nodes`),
                    hasHitl ? h('span', { style: S.badge('warn') }, '⏸ Chờ duyệt HITL') : (latest ? h('span', { style: S.badge(latest.status === 'failed' ? 'err' : 'ok') }, `Run gần nhất: ${latest.status}`) : null),
                  ),
                ),
                h('div', { style: S.row },
                  h('button', { 'data-testid': `dxos-flow-toggle-active-${r.ruleKey}`, type: 'button', onClick: () => onToggleRuleActive?.(r), style: S.btn(isActive ? 'active' : 'ghost') }, isActive ? 'Tạm dừng' : 'Kích hoạt'),
                  h('button', { 'data-testid': `dxos-flow-dup-rule-${r.ruleKey}`, type: 'button', onClick: () => onDuplicateRule?.(r), style: S.btn('ghost') }, 'Nhân bản'),
                  h('button', { 'data-testid': `dxos-flow-list-run-${r.ruleKey}`, type: 'button', disabled: Boolean(runBusy), onClick: () => onRunNow?.(r), style: S.btn('ghost', Boolean(runBusy)) }, '▶ Chạy'),
                  h('button', { 'data-testid': `dxos-flow-edit-${r.ruleKey}`, type: 'button', onClick: () => onOpenRule?.(r.ruleKey), style: S.btn('primary') }, 'Mở Canvas'),
                ),
              );
            }),
          ),
    );
  };
}

module.exports = { createFlowListView };
