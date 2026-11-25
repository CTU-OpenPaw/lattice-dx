/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

function buildDraftPayload(rule, graph, orgPayload, deriveTriggerEventType) {
  const g = graph || rule?.draftGraphJson || rule?.graphJson || { version: 2, nodes: [], edges: [] };
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
    schemaVersion: 2,
    draftGraphJson: g,
  };
}

function getVersionStatusMeta(doc) {
  const rule = doc?.rule || {};
  const pubVer = Math.max(0, Number(rule.publishedVersion || 0));
  const hasPublished = Boolean(rule.graphJson?.nodes?.length || (pubVer > 0 && rule.id));
  const draftDiff = Boolean(rule.draftGraphJson?.nodes?.length && rule.graphJson?.nodes?.length
    && JSON.stringify(rule.draftGraphJson) !== JSON.stringify(rule.graphJson));
  const hasDraft = Boolean(doc?.dirty || draftDiff || (!hasPublished && rule.draftGraphJson?.nodes?.length));
  if (!hasPublished) {
    return { label: 'Draft (Chưa publish)', bg: '#fffbeb', color: '#b45309', border: '#fcd34d', pubVer: 0 };
  }
  if (hasDraft) {
    return { label: `Draft · Live v${pubVer}`, bg: '#fffbeb', color: '#b45309', border: '#fcd34d', pubVer };
  }
  return { label: `Published v${pubVer}`, bg: '#f0fdf4', color: '#166534', border: '#86efac', pubVer };
}

function renderVersionStatusBadge(h, doc) {
  const st = getVersionStatusMeta(doc);
  return h('span', {
    'data-testid': 'dxos-flow-version-badge',
    style: {
      fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999, flexShrink: 0,
      background: st.bg, color: st.color, border: `1px solid ${st.border}`,
    },
  }, st.label);
}

function synthesizeBaselineVersionIfMissing(items, rule) {
  const list = Array.isArray(items) ? items.slice() : [];
  const pubVer = Math.max(0, Number(rule?.publishedVersion || 0));
  const hasLiveGraph = Boolean(rule?.graphJson?.nodes?.length || rule?.publishedGraphJson?.nodes?.length || (pubVer >= 1 && rule?.id));
  if (pubVer >= 1 && hasLiveGraph && !list.some((v) => Number(v?.version || 0) === pubVer)) {
    list.unshift({
      id: `baseline-${rule?.id ?? rule?.ruleKey ?? 'rule'}-v${pubVer}`,
      ruleKey: rule?.ruleKey || '',
      version: pubVer,
      status: 'published',
      isCurrent: true,
      syntheticBaseline: true,
      note: 'Phiên bản đang chạy (Live Baseline)',
      changeSummary: 'Phiên bản đang chạy (Live Baseline)',
      publishedBy: rule?.createdBy || 'system',
      publishedAt: rule?.updatedAt || rule?.createdAt || null,
    });
  }
  return list.sort((a, b) => Number(b?.version || 0) - Number(a?.version || 0));
}

function renderVersionsModal(h, { modal, currentVersion, busy, onRollback, onClose, btnS }) {
  if (!modal?.open) return null;
  const items = Array.isArray(modal.items) ? modal.items : [];
  return h('div', {
    'data-testid': 'dxos-flow-versions-modal',
    role: 'dialog',
    'aria-modal': 'true',
    style: {
      position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 55, padding: 16,
    },
  },
    h('div', { style: { width: 580, maxWidth: '100%', maxHeight: '80vh', overflowY: 'auto', background: '#ffffff', borderRadius: 12, padding: 16, display: 'grid', gap: 10, boxShadow: '0 14px 36px rgba(15,23,42,0.22)' } },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
        h('strong', { style: { fontSize: 14, color: '#0f172a' } }, `Lịch sử phiên bản (Live v${Math.max(0, Number(currentVersion || 0))})`),
        h('button', { type: 'button', 'data-testid': 'dxos-flow-versions-close-btn', onClick: onClose, style: btnS('ghost') }, 'Đóng'),
      ),
      modal.loading
        ? h('div', { style: { fontSize: 12, color: '#64748b', padding: 12 } }, 'Đang tải phiên bản...')
        : !items.length
          ? h('div', { style: { fontSize: 12, color: '#64748b', padding: 12 } }, 'Chưa có phiên bản đã publish nào.')
          : items.map((v) => {
            const ver = Number(v.version || 0);
            const isCurrent = Boolean(v.isCurrent) || ver === Number(currentVersion || 0);
            const summaryText = v.note || v.changeSummary || '';
            return h('div', {
              key: v.id || ver,
              'data-testid': `dxos-flow-version-row-v${ver}`,
              style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 8, border: `1px solid ${isCurrent ? '#86efac' : '#e2e8f0'}`, background: isCurrent ? '#f0fdf4' : '#f8fafc' },
            },
              h('div', { style: { display: 'grid', gap: 2 } },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                  h('strong', { style: { fontSize: 12, color: '#0f172a' } }, `v${ver}`),
                  isCurrent ? h('span', { style: { fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 999, background: '#dcfce7', color: '#166534' } }, 'Live') : null,
                  h('span', { style: { fontSize: 11, color: '#64748b' } }, `${v.publishedBy || 'system'}${v.publishedAt ? ` · ${String(v.publishedAt).slice(0, 19).replace('T', ' ')}` : ''}`),
                ),
                summaryText ? h('span', { style: { fontSize: 11, color: '#334155' } }, summaryText) : null,
              ),
              h('button', {
                type: 'button',
                'data-testid': `dxos-flow-rollback-v${ver}`,
                disabled: Boolean(busy || isCurrent),
                onClick: () => onRollback?.(ver),
                style: btnS(isCurrent ? 'ghost' : 'act', Boolean(busy || isCurrent)),
              }, isCurrent ? 'Đang chạy' : 'Khôi phục'),
            );
          }),
    ),
  );
}

function createVersionLifecycleHandlers({
  refs, getDoc, setDoc, getOrgPayload, buildSavePayload, deriveTriggerEventType,
  runAction, reportFb, loadAll, applyRule, setVerModal, unwrap, errMsg,
}) {
  const saveDraft = async () => {
    const doc = getDoc();
    const p = buildDraftPayload(doc.rule, doc.graph, getOrgPayload(), deriveTriggerEventType);
    if (!p.ruleKey || !p.name) { reportFb({ type: 'error', text: 'Rule Key và Rule Name không được để trống.' }); return false; }
    let ok = false;
    await runAction('save', 'dxosAutomations:saveDraft', p, (d) => {
      ok = true;
      const nextR = d?.rule ? { ...doc.rule, ...d.rule } : { ...doc.rule, ruleKey: p.ruleKey, name: p.name, draftGraphJson: p.draftGraphJson };
      refs.docRule = nextR;
      setDoc((s) => ({ ...s, dirty: false, rule: d?.rule ? { ...s.rule, ...d.rule } : { ...s.rule, draftGraphJson: p.draftGraphJson } }));
      reportFb({ type: 'success', text: `Đã lưu nháp "${p.ruleKey}".` });
      loadAll();
    });
    return ok;
  };
  const handlePublish = async () => {
    const doc = getDoc();
    const p = buildSavePayload();
    if (!p.ruleKey || !p.name) { reportFb({ type: 'error', text: 'Rule Key và Rule Name không được để trống.' }); return false; }
    return runAction('publish', 'dxosAutomations:publishRule', { ...p, draftGraphJson: p.graphJson }, (d) => {
      const nr = d?.rule ? { ...doc.rule, ...d.rule } : { ...doc.rule, ...p };
      refs.docRule = nr;
      setDoc((s) => ({ ...s, dirty: false, rule: nr }));
      reportFb({ type: 'success', text: `Đã publish "${p.ruleKey}" v${nr.publishedVersion || 1}.` });
      loadAll();
    });
  };
  const handleOpenVersions = () => {
    const currentRule = getDoc().rule;
    const rk = String(currentRule?.ruleKey || '').trim();
    if (!rk || !refs.api?.request) return;
    setVerModal({ open: true, loading: true, items: [] });
    refs.api.request({ url: 'dxosAutomations:listRuleVersions', method: 'get', params: { ...getOrgPayload(), ruleKey: rk }, skipNotify: true })
      .then((res) => {
        const rawItems = Array.isArray(unwrap(res)?.items) ? unwrap(res).items : [];
        setVerModal({ open: true, loading: false, items: synthesizeBaselineVersionIfMissing(rawItems, currentRule) });
      })
      .catch((err) => { setVerModal({ open: false, loading: false, items: [] }); reportFb({ type: 'error', text: errMsg(err, 'Không tải được lịch sử phiên bản.') }); });
  };
  const handleRollbackVersion = (ver) => runAction('rollback', 'dxosAutomations:rollbackRuleVersion', { ...getOrgPayload(), ruleKey: getDoc().rule.ruleKey, version: ver }, (d) => {
    if (d?.rule) applyRule(d.rule);
    setVerModal({ open: false, loading: false, items: [] });
    reportFb({ type: 'success', text: `Đã khôi phục phiên bản v${ver}.` });
    loadAll();
  });
  const ensureSavedForRun = async () => {
    const doc = getDoc();
    const p = buildSavePayload();
    if (!p.ruleKey || !p.name) { reportFb({ type: 'error', text: 'Rule Key và Rule Name không được để trống.' }); return false; }
    let ok = false;
    await runAction('save', 'dxosAutomations:saveRule', p, (d) => {
      ok = true;
      refs.docRule = d?.rule ? { ...doc.rule, ...d.rule } : { ...doc.rule, ruleKey: p.ruleKey, name: p.name };
      setDoc((s) => ({ ...s, dirty: false, rule: refs.docRule }));
    });
    return ok;
  };
  return { saveDraft, handlePublish, handleOpenVersions, handleRollbackVersion, ensureSavedForRun };
}

module.exports = {
  buildDraftPayload,
  getVersionStatusMeta,
  synthesizeBaselineVersionIfMissing,
  renderVersionStatusBadge,
  renderVersionsModal,
  createVersionLifecycleHandlers,
};
