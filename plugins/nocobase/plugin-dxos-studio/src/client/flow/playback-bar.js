/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const STATUS_BADGE_MAP = Object.freeze({
  completed: { bg: '#f0fdf4', color: '#166534', border: '#86efac' },
  simulated: { bg: '#ecfeff', color: '#0e7490', border: '#67e8f9' },
  suspended: { bg: '#fffbeb', color: '#92400e', border: '#fcd34d' },
  skipped: { bg: '#f8fafc', color: '#475569', border: '#cbd5e1' },
  failed: { bg: '#fef2f2', color: '#991b1b', border: '#fca5a5' },
  partial: { bg: '#fff7ed', color: '#9a3412', border: '#fdba74' },
  running: { bg: '#eff6ff', color: '#1d4ed8', border: '#93c5fd' },
});

function statusBadgeStyle(status) {
  const s = String(status || '').toLowerCase();
  const tone = STATUS_BADGE_MAP[s] || STATUS_BADGE_MAP.skipped;
  return {
    fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
    background: tone.bg, color: tone.color, border: `1px solid ${tone.border}`, whiteSpace: 'nowrap',
  };
}

function vcrButtonStyle(disabled, primary = false) {
  if (disabled) {
    return {
      padding: '4px 9px', borderRadius: 6, border: '1px solid #cbd5e1', background: '#e2e8f0',
      color: '#94a3b8', fontSize: 12, fontWeight: 600, cursor: 'not-allowed',
    };
  }
  return {
    padding: '4px 9px', borderRadius: 6, border: `1px solid ${primary ? '#2563EB' : '#cbd5e1'}`,
    background: primary ? '#2563EB' : '#ffffff', color: primary ? '#ffffff' : '#0f172a',
    fontSize: 12, fontWeight: 600, cursor: 'pointer',
  };
}

function createPlaybackBar(React) {
  const h = React.createElement;

  return function PlaybackBar(props = {}) {
    const {
      runs, selectedRun, onSelectRun, playbackIndex, onStepChange,
      playing, onTogglePlay, onResumeApproval, resumeBusy, autoExpandSeq = 0, onFocusNode,
      onFixErrorWithAi, aiFixBusy = false,
    } = props;

    const [expanded, setExpanded] = React.useState(() => Boolean(autoExpandSeq > 0));
    const [seqRef] = React.useState(() => ({ val: autoExpandSeq || 0 }));

    React.useEffect(() => {
      if (autoExpandSeq && autoExpandSeq !== seqRef.val) {
        seqRef.val = autoExpandSeq;
        setExpanded(true);
      }
    }, [autoExpandSeq]);

    const runOptions = React.useMemo(() => {
      const list = Array.isArray(runs) ? runs.filter(Boolean) : [];
      if (selectedRun?.runUid && !list.some((r) => r.runUid === selectedRun.runUid)) {
        return [selectedRun, ...list];
      }
      return list;
    }, [runs, selectedRun]);

    const traces = React.useMemo(() => {
      if (Array.isArray(selectedRun?.stepTracesJson)) return selectedRun.stepTracesJson;
      if (Array.isArray(selectedRun?.stepTraces)) return selectedRun.stepTraces;
      return [];
    }, [selectedRun]);

    const activeIdx = traces.length === 0
      ? -1
      : Math.max(0, Math.min(traces.length - 1, Number.isInteger(playbackIndex) ? playbackIndex : 0));
    const currentTrace = activeIdx >= 0 ? traces[activeIdx] : null;
    const isSuspended = selectedRun?.status === 'suspended';
    const suspendedState = selectedRun?.suspendedNodeId
      ? selectedRun?.nodeStatesJson?.[selectedRun.suspendedNodeId]?.suspend
      : null;

    const canPrev = traces.length > 0 && activeIdx > 0;
    const canNext = traces.length > 0 && activeIdx < traces.length - 1;
    const canPlay = traces.length > 0;
    const failedTraces = React.useMemo(() => {
      const seen = new Set();
      return traces.filter((t) => {
        if (!t?.nodeId || String(t.status || '').toLowerCase() !== 'failed' || seen.has(t.nodeId)) return false;
        seen.add(t.nodeId);
        return true;
      });
    }, [traces]);

    function handleRunSelect(evt) {
      const uid = evt?.target?.value ?? '';
      if (typeof onSelectRun !== 'function') return;
      if (!uid) {
        onSelectRun(null);
        return;
      }
      const found = runOptions.find((r) => String(r.runUid || r.id || '') === uid);
      onSelectRun(found || uid);
    }

    const hitlBanner = isSuspended ? h('div', {
      'data-testid': 'dxos-flow-hitl-banner',
      style: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10,
        padding: '8px 12px', borderRadius: 8, border: '1px solid #fcd34d', background: '#fffbeb',
      },
    },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12, color: '#78350f' } },
        h('strong', null, 'Cổng Phê duyệt (HITL)'),
        h('span', null, `Phiên ${selectedRun.runUid || ''} đang tạm dừng tại nút "${selectedRun.suspendedNodeId || 'approval'}"`),
        suspendedState?.approverRole ? h('span', { style: statusBadgeStyle('suspended') }, `Vai trò: ${suspendedState.approverRole}`) : null,
        suspendedState?.title ? h('span', null, `· ${suspendedState.title}`) : null,
      ),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        h('button', {
          type: 'button',
          'data-testid': 'dxos-flow-hitl-approve-btn',
          disabled: Boolean(resumeBusy),
          onClick: () => { if (typeof onResumeApproval === 'function') onResumeApproval(selectedRun.runUid, 'approved'); },
          style: resumeBusy ? vcrButtonStyle(true) : { padding: '5px 12px', borderRadius: 6, border: '1px solid #16a34a', background: '#16a34a', color: '#ffffff', fontSize: 12, fontWeight: 700, cursor: 'pointer' },
        }, 'Phê duyệt'),
        h('button', {
          type: 'button',
          'data-testid': 'dxos-flow-hitl-reject-btn',
          disabled: Boolean(resumeBusy),
          onClick: () => { if (typeof onResumeApproval === 'function') onResumeApproval(selectedRun.runUid, 'rejected'); },
          style: resumeBusy ? vcrButtonStyle(true) : { padding: '5px 12px', borderRadius: 6, border: '1px solid #dc2626', background: '#ffffff', color: '#dc2626', fontSize: 12, fontWeight: 700, cursor: 'pointer' },
        }, 'Từ chối'),
      ),
    ) : null;

    const toggleBtn = h('button', {
      type: 'button',
      'data-testid': 'dxos-flow-toggle-trace-btn',
      'aria-expanded': expanded,
      onClick: () => setExpanded((v) => !v),
      style: {
        display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 9px', borderRadius: 6,
        border: '1px solid #e2e8f0', background: expanded ? '#eff6ff' : '#f8fafc',
        color: expanded ? '#1d4ed8' : '#0f172a', fontSize: 12, fontWeight: 600, cursor: 'pointer',
      },
    }, `${expanded ? '▾' : '▸'} Lịch sử chạy & Trace (${runOptions.length})`);

    return h('div', {
      'data-testid': 'dxos-flow-playback-bar',
      style: { borderTop: '1px solid #cbd5e1', background: '#ffffff', padding: expanded ? '8px 92px 8px 14px' : '5px 92px 5px 14px', minHeight: 38, boxSizing: 'border-box', display: 'grid', gap: 8 },
    },
      hitlBanner,
      !expanded
        ? h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, minHeight: 28 } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            toggleBtn,
            selectedRun ? h('span', { style: statusBadgeStyle(selectedRun.status) }, `${selectedRun.status || 'completed'} · ${selectedRun.durationMs ?? 0}ms`) : h('span', { style: { fontSize: 11, color: '#64748b' } }, 'Chưa có trace · Nhấn "▶ Chạy thử" để mô phỏng'),
          ),
          canPlay ? h('button', {
            type: 'button',
            'data-testid': 'dxos-flow-vcr-play-btn',
            onClick: () => { if (typeof onTogglePlay === 'function') onTogglePlay(); },
            style: vcrButtonStyle(false, Boolean(playing)),
          }, playing ? 'Tạm dừng' : 'Phát') : null,
        )
        : h(React.Fragment, null,
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
              toggleBtn,
              h('select', {
                'data-testid': 'dxos-flow-run-selector',
                value: String(selectedRun?.runUid || selectedRun?.id || ''),
                onChange: handleRunSelect,
                style: { padding: '4px 10px', borderRadius: 6, border: '1px solid #cbd5e1', background: '#f8fafc', fontSize: 12, color: '#0f172a', minWidth: 210 },
              },
                h('option', { value: '' }, '-- Chọn Phiên chạy / Trace --'),
                runOptions.map((r) => {
                  const uid = String(r.runUid || r.id || '');
                  return h('option', { key: uid, value: uid }, `${uid} · ${r.status || 'completed'} (${r.durationMs ?? 0}ms)`);
                }),
              ),
            ),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 4 } },
              h('button', { type: 'button', 'data-testid': 'dxos-flow-vcr-first-btn', disabled: !canPrev, onClick: () => onStepChange?.(0), style: vcrButtonStyle(!canPrev) }, '|<'),
              h('button', { type: 'button', 'data-testid': 'dxos-flow-vcr-prev-btn', disabled: !canPrev, onClick: () => onStepChange?.(Math.max(0, activeIdx - 1)), style: vcrButtonStyle(!canPrev) }, '<'),
              h('button', { type: 'button', 'data-testid': 'dxos-flow-vcr-play-btn', disabled: !canPlay, onClick: () => onTogglePlay?.(), style: vcrButtonStyle(!canPlay, Boolean(playing)) }, playing ? 'Tạm dừng' : 'Phát'),
              h('button', { type: 'button', 'data-testid': 'dxos-flow-vcr-next-btn', disabled: !canNext, onClick: () => onStepChange?.(Math.min(traces.length - 1, activeIdx + 1)), style: vcrButtonStyle(!canNext) }, '>'),
              h('button', { type: 'button', 'data-testid': 'dxos-flow-vcr-last-btn', disabled: !canNext, onClick: () => onStepChange?.(traces.length - 1), style: vcrButtonStyle(!canNext) }, '>|'),
            ),
            h('div', { 'data-testid': 'dxos-flow-step-badge', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12, color: '#334155' } },
              currentTrace
                ? h(React.Fragment, null,
                  h('strong', null, `Bước ${activeIdx + 1}/${traces.length}`),
                  h('span', null, currentTrace.label || currentTrace.nodeId || currentTrace.type || '-'),
                  h('span', { style: statusBadgeStyle(currentTrace.status) }, currentTrace.status || 'completed'),
                  h('span', { style: { fontFamily: 'monospace', fontSize: 11, color: '#64748b' } }, `${currentTrace.durationMs ?? 0}ms`),
                )
                : selectedRun
                  ? h(React.Fragment, null,
                    h('span', { style: statusBadgeStyle(selectedRun.status) }, selectedRun.status || 'completed'),
                    h('span', { style: { fontFamily: 'monospace', fontSize: 11, color: '#64748b' } }, `${selectedRun.durationMs ?? 0}ms`),
                  )
                  : h('span', { style: { color: '#64748b' } }, 'Chưa có trace · Nhấn "▶ Chạy thử" để mô phỏng'),
            ),
          ),
          traces.length > 0 ? h('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' } },
            traces.map((t, idx) => {
              const active = idx === activeIdx;
              return h('button', {
                key: `${t.nodeId || t.type || 'step'}-${idx}`,
                type: 'button',
                'data-testid': `dxos-flow-step-chip-${idx}`,
                onClick: () => { onStepChange?.(idx); if (t.nodeId) onFocusNode?.(t.nodeId); },
                style: {
                  padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: active ? 700 : 500, cursor: 'pointer',
                  border: `1px solid ${active ? '#2563EB' : '#cbd5e1'}`, background: active ? '#dbeafe' : '#f8fafc', color: active ? '#1d4ed8' : '#475569',
                },
              }, `${idx + 1}. ${t.nodeId || t.label || t.type} (${t.durationMs ?? 0}ms)`);
            }),
            failedTraces.map((t) => h('button', {
              key: `ai-fix-${t.nodeId}`,
              type: 'button',
              'data-testid': `dxos-flow-ai-fix-btn-${t.nodeId}`,
              disabled: Boolean(aiFixBusy),
              onClick: () => onFixErrorWithAi?.(t),
              style: {
                padding: '2px 9px', borderRadius: 999, fontSize: 11, fontWeight: 700, cursor: aiFixBusy ? 'not-allowed' : 'pointer',
                border: '1px solid #fca5a5', background: aiFixBusy ? '#e2e8f0' : '#fef2f2', color: aiFixBusy ? '#94a3b8' : '#b91c1c',
              },
            }, `✦ Sửa lỗi bằng AI (${t.nodeId})`)),
          ) : null,
        ),
    );
  };
}

module.exports = { createPlaybackBar, statusBadgeStyle };
