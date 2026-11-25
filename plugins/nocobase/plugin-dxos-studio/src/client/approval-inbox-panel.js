/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const APPROVAL_SOURCE_TABS = Object.freeze([
  { id: 'all', label: 'Tất cả' },
  { id: 'business', label: 'Nghiệp vụ (Multi-Level)' },
  { id: 'ai_hitl', label: 'AI HITL' },
  { id: 'flow', label: 'LatticeFlow v2' },
]);

const STATUS_OPTIONS = Object.freeze(['pending', 'approved', 'rejected', 'executed', 'all']);

function unwrapData(res) {
  return res?.data?.data ?? res?.data ?? {};
}

function extractError(err, fallback) {
  return err?.response?.data?.errors?.[0]?.message
    || err?.response?.data?.message
    || err?.message
    || fallback;
}

function normalizeSource(raw) {
  const s = String(raw || 'business').toLowerCase();
  if (s === 'flow_approval' || s === 'flow') return 'flow';
  if (s === 'ai' || s === 'ai_hitl') return 'ai_hitl';
  return 'business';
}

function sourceLabel(src) {
  if (src === 'ai_hitl') return 'AI HITL';
  if (src === 'flow') return 'Flow v2';
  return 'Nghiệp vụ';
}

function riskTone(risk) {
  const r = String(risk || 'medium').toLowerCase();
  if (r === 'critical' || r === 'high') return 'danger';
  if (r === 'medium') return 'warn';
  return 'info';
}

function statusTone(status) {
  const s = String(status || 'pending').toLowerCase();
  if (s === 'approved' || s === 'executed') return 'ok';
  if (s === 'rejected' || s === 'expired' || s === 'failed') return 'danger';
  if (s === 'pending' || s === 'suspended') return 'warn';
  return 'neutral';
}

function makeStyles() {
  return {
    stack: { display: 'grid', gap: 14 },
    card: { padding: 16, borderRadius: 12, border: '1px solid #e2e8f0', background: '#ffffff', display: 'grid', gap: 12 },
    itemCard: { padding: 14, borderRadius: 10, border: '1px solid #e2e8f0', background: '#f8fafc', display: 'grid', gap: 10 },
    subCard: { padding: 10, borderRadius: 8, border: '1px solid #e2e8f0', background: '#ffffff', display: 'grid', gap: 6 },
    rowBetween: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
    rowWrap: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
    input: { padding: '6px 9px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 12, boxSizing: 'border-box', background: '#ffffff' },
    tab: (active) => ({
      padding: '6px 12px',
      borderRadius: 999,
      cursor: 'pointer',
      fontSize: 12,
      fontWeight: 600,
      border: active ? '1px solid #1677ff' : '1px solid #cbd5e1',
      background: active ? '#1677ff' : '#ffffff',
      color: active ? '#ffffff' : '#334155',
    }),
    badge: (tone = 'neutral') => {
      const palette = {
        ok: { bg: '#dcfce7', color: '#166534', border: '#bbf7d0' },
        warn: { bg: '#fef3c7', color: '#92400e', border: '#fde68a' },
        danger: { bg: '#fee2e2', color: '#991b1b', border: '#fecaca' },
        info: { bg: '#dbeafe', color: '#1e40af', border: '#bfdbfe' },
        neutral: { bg: '#f1f5f9', color: '#475569', border: '#cbd5e1' },
      }[tone] || { bg: '#f1f5f9', color: '#475569', border: '#cbd5e1' };
      return {
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        background: palette.bg,
        color: palette.color,
        border: `1px solid ${palette.border}`,
        whiteSpace: 'nowrap',
      };
    },
    btn: (primary = false, danger = false, disabled = false) => ({
      padding: '6px 12px',
      borderRadius: 8,
      cursor: disabled ? 'not-allowed' : 'pointer',
      fontSize: 12,
      fontWeight: 600,
      border: disabled ? '1px solid #cbd5e1' : danger ? '1px solid #dc2626' : primary ? '1px solid #1677ff' : '1px solid #cbd5e1',
      background: disabled ? '#e2e8f0' : danger ? '#dc2626' : primary ? '#1677ff' : '#ffffff',
      color: disabled ? '#94a3b8' : (primary || danger) ? '#ffffff' : '#1e293b',
      whiteSpace: 'nowrap',
    }),
  };
}

function resolveItemKey(item, idx) {
  if (item.itemKey) return String(item.itemKey);
  if (item.requestUid) return String(item.requestUid);
  if (item.id != null) return `${normalizeSource(item.source)}-${item.id}`;
  if (item.runUid) return String(item.runUid);
  return `item-${idx}`;
}

function findItemDelegation(item, activeDelegations, delegatedRolesSet) {
  if (!item || typeof item !== 'object') return '';
  if (item.delegationUid || item.delegatedFromUserId || item.delegatedVia) {
    return item.delegationUid || item.delegatedVia || `Từ user #${item.delegatedFromUserId}`;
  }
  const safeDelegations = (Array.isArray(activeDelegations) ? activeDelegations : []).filter((x) => x && typeof x === 'object');
  const stages = (Array.isArray(item.stagesStateJson) ? item.stagesStateJson : Array.isArray(item.stages) ? item.stages : [])
    .filter((x) => x && typeof x === 'object');
  for (const st of stages) {
    const decisions = (Array.isArray(st.decisions) ? st.decisions : []).filter((x) => x && typeof x === 'object');
    for (const dec of decisions) {
      if (dec.delegationUid || dec.delegatedFromUserId) {
        return dec.delegationUid || `Ủy quyền #${dec.delegatedFromUserId}`;
      }
    }
    const roles = Array.isArray(st.approverRoles) ? st.approverRoles : [];
    const hit = roles.find((r) => delegatedRolesSet.has(r));
    if (hit) {
      const matchDlg = safeDelegations.find((d) => d.roleName === hit);
      return matchDlg?.delegationUid || `Ủy quyền vai trò ${hit}`;
    }
  }
  const reqRoles = Array.isArray(item.requiredRoles) ? item.requiredRoles : [];
  const hitReq = reqRoles.find((r) => delegatedRolesSet.has(r));
  if (hitReq) {
    const matchDlg = safeDelegations.find((d) => d.roleName === hitReq);
    return matchDlg?.delegationUid || `Ủy quyền vai trò ${hitReq}`;
  }
  return '';
}

function createApprovalInboxPanel(client, React, _antd, app) {
  const h = React.createElement;
  const S = makeStyles();

  return function ApprovalInboxPanelInner(props = {}) {
    const useApi = typeof client?.useAPIClient === 'function' ? client.useAPIClient : () => app?.apiClient || null;
    const hookApi = useApi();
    const api = props.api || hookApi;
    const hasApi = Boolean(api?.request);

    const [discoveredOrgs, setDiscoveredOrgs] = React.useState([]);
    const [orgOverride, setOrgOverride] = React.useState(null);
    const [source, setSource] = React.useState('all');
    const [status, setStatus] = React.useState('pending');
    const [assignedToMe, setAssignedToMe] = React.useState(false);
    const [items, setItems] = React.useState([]);
    const [counts, setCounts] = React.useState({});
    const [delegations, setDelegations] = React.useState([]);
    const [delegatedRoles, setDelegatedRoles] = React.useState([]);
    const [notes, setNotes] = React.useState({});
    const [feedback, setFeedback] = React.useState(null);
    const [busy, setBusy] = React.useState(false);
    const [reloadTick, setReloadTick] = React.useState(0);
    const [runtimeRef] = React.useState(() => ({ api }));
    runtimeRef.api = api;

    React.useEffect(() => {
      setOrgOverride(null);
    }, [props.selectedOrg]);

    const propOrgs = Array.isArray(props.organizations) ? props.organizations : [];
    const orgInputValue = orgOverride !== null
      ? orgOverride
      : String(props.selectedOrg || discoveredOrgs[0] || '');
    const effectiveOrg = String(orgInputValue).trim();
    const orgPayload = effectiveOrg ? { organizationId: effectiveOrg } : {};

    function reportFeedback(fb) {
      if (typeof props.setFeedback === 'function') {
        props.setFeedback(fb);
        setFeedback(null);
      } else {
        setFeedback(fb);
      }
    }

    async function loadInbox(currentApi, orgId, src, st, onlyMine) {
      if (!currentApi?.request) return;
      const baseParams = orgId ? { organizationId: orgId } : {};
      const [inboxRes, dlgRes] = await Promise.all([
        currentApi.request({
          url: 'dxosApprovals:listInbox',
          method: 'get',
          params: { ...baseParams, source: src, status: st, ...(onlyMine ? { assignedToMe: true } : {}) },
          skipNotify: true,
        }),
        currentApi.request({
          url: 'dxosDelegations:activeForUser',
          method: 'get',
          params: baseParams,
          skipNotify: true,
        }).catch(() => null),
      ]);
      const idata = unwrapData(inboxRes);
      setItems((Array.isArray(idata.items) ? idata.items : []).filter((x) => x && typeof x === 'object'));
      setCounts(idata.counts && typeof idata.counts === 'object' ? idata.counts : {});
      if (dlgRes) {
        const dd = unwrapData(dlgRes);
        const dlItems = (Array.isArray(dd.items) ? dd.items : []).filter((x) => x && typeof x === 'object');
        setDelegations(dlItems);
        setDelegatedRoles(Array.isArray(dd.roles) ? dd.roles : dlItems.map((d) => d.roleName).filter(Boolean));
      } else {
        setDelegations([]);
        setDelegatedRoles([]);
      }
    }

    React.useEffect(() => {
      if (!hasApi) return;
      let cancelled = false;
      async function run() {
        let activeOrg = String(props.selectedOrg || '').trim();
        if (!activeOrg && !propOrgs.length && !discoveredOrgs.length) {
          try {
            const empRes = await api.request({ url: 'dxosStudio:listEmployees', method: 'get', skipNotify: true });
            const ed = unwrapData(empRes);
            const orgs = Array.isArray(ed.organizations) ? ed.organizations : [];
            if (!cancelled && orgs.length) {
              setDiscoveredOrgs(orgs);
              activeOrg = orgs[0];
            }
          } catch {
            // optional fallback
          }
        }
        try {
          await loadInbox(api, activeOrg || effectiveOrg, source, status, assignedToMe);
        } catch (err) {
          if (!cancelled) reportFeedback({ type: 'error', text: extractError(err, 'Không thể tải Hộp thư Phê duyệt.') });
        }
      }
      run();
      return () => { cancelled = true; };
    }, [hasApi, props.selectedOrg, effectiveOrg, source, status, assignedToMe, reloadTick]);

    const delegatedRolesSet = new Set(delegatedRoles);

    async function handleDecide(item, itemKey, decision) {
      const clientApi = runtimeRef.api;
      if (!clientApi?.request || busy) return;
      const note = String(notes[itemKey] || '').trim();
      if (decision === 'reject' && note.length < 3) {
        reportFeedback({ type: 'error', text: 'Từ chối yêu cầu phải nhập lý do tối thiểu 3 ký tự.' });
        return;
      }
      setBusy(true);
      reportFeedback(null);
      try {
        await clientApi.request({
          url: 'dxosApprovals:decide',
          method: 'post',
          data: {
            ...orgPayload,
            source: item.source || normalizeSource(item.source),
            itemKey,
            ...(item.id != null ? { id: item.id } : {}),
            ...(item.requestUid ? { requestUid: item.requestUid } : {}),
            ...(item.runUid ? { runUid: item.runUid } : {}),
            decision,
            note,
          },
        });
        setNotes((prev) => ({ ...prev, [itemKey]: '' }));
        await loadInbox(clientApi, effectiveOrg, source, status, assignedToMe);
        reportFeedback({ type: 'ok', text: `Đã ${decision === 'approve' ? 'phê duyệt' : 'từ chối'} mục ${itemKey}.` });
      } catch (err) {
        reportFeedback({ type: 'error', text: extractError(err, 'Không thể xử lý phê duyệt.') });
      } finally {
        setBusy(false);
      }
    }

    return h('div', { 'data-testid': 'dxos-approval-inbox', style: S.stack },
      h('div', { style: S.card },
        h('div', { style: S.rowBetween },
          h('div', null,
            h('h3', { style: { margin: 0, fontSize: 16, color: '#0f172a' } }, 'Hộp thư Phê duyệt Hợp nhất (Unified Approval Inbox)'),
            h('div', { style: { fontSize: 12, color: '#64748b' } }, 'Hợp nhất phê duyệt Nghiệp vụ M-of-N, AI HITL và LatticeFlow v2 Pause/Resume.'),
          ),
          h('button', {
            type: 'button',
            'data-testid': 'dxos-approvals-refresh-btn',
            onClick: () => setReloadTick((n) => n + 1),
            style: S.btn(false, false, busy),
          }, 'Làm mới'),
        ),

        delegations.length
          ? h('div', {
            'data-testid': 'dxos-approvals-delegation-banner',
            style: { padding: 10, borderRadius: 8, background: '#eff6ff', border: '1px solid #bfdbfe', fontSize: 12, color: '#1e3a8a', display: 'grid', gap: 4 },
          },
            h('strong', null, `Đang nhận ủy quyền phê duyệt (${delegations.length}):`),
            h('div', { style: S.rowWrap },
              delegations.filter((x) => x && typeof x === 'object').map((d, idx) => h('span', { key: d.delegationUid || d.roleName || `dlg-${idx}`, style: S.badge('info') },
                `${d.delegationUid || 'DLG'} · ${d.roleName}${d.scopeCollection ? ` (${d.scopeCollection})` : ''}${d.endsAt ? ` · đến ${String(d.endsAt).slice(0, 10)}` : ''}`,
              )),
            ),
          )
          : null,

        feedback
          ? h('div', {
            role: 'status',
            style: {
              padding: 10,
              borderRadius: 8,
              fontSize: 12,
              background: feedback.type === 'error' ? '#fef2f2' : '#f0fdf4',
              border: `1px solid ${feedback.type === 'error' ? '#fecaca' : '#bbf7d0'}`,
              color: feedback.type === 'error' ? '#991b1b' : '#166534',
            },
          }, feedback.text)
          : null,

        h('div', { style: S.rowBetween },
          h('div', { role: 'tablist', style: S.rowWrap },
            APPROVAL_SOURCE_TABS.map((t) => {
              const count = counts[t.id];
              return h('button', {
                key: t.id,
                type: 'button',
                role: 'tab',
                'aria-selected': source === t.id,
                'data-testid': `dxos-approvals-source-${t.id}`,
                onClick: () => setSource(t.id),
                style: S.tab(source === t.id),
              }, count != null ? `${t.label} (${count})` : t.label);
            }),
          ),
          h('div', { style: S.rowWrap },
            h('select', {
              'data-testid': 'dxos-approvals-status-filter',
              value: status,
              onChange: (e) => setStatus(e.target.value),
              style: S.input,
            }, STATUS_OPTIONS.map((opt) => h('option', { key: opt, value: opt }, opt))),
            h('label', { style: { fontSize: 12, display: 'flex', alignItems: 'center', gap: 5 } },
              h('input', {
                'data-testid': 'dxos-approvals-assigned-toggle',
                type: 'checkbox',
                checked: assignedToMe,
                onChange: (e) => setAssignedToMe(e.target.checked),
              }),
              'Chỉ việc giao cho tôi',
            ),
          ),
        ),

        !items.length
          ? h('div', { style: { padding: 16, fontSize: 12, color: '#64748b', textAlign: 'center' } }, 'Không có yêu cầu phê duyệt nào phù hợp bộ lọc.')
          : items.filter((x) => x && typeof x === 'object').map((item, idx) => {
            const itemKey = resolveItemKey(item, idx);
            const normSrc = normalizeSource(item.source);
            const stages = (Array.isArray(item.stagesStateJson)
              ? item.stagesStateJson
              : Array.isArray(item.stages) ? item.stages : []).filter((x) => x && typeof x === 'object');
            const dlgTag = findItemDelegation(item, delegations, delegatedRolesSet);
            const canAct = (item.status === 'pending' || item.status === 'suspended') && item.canAct !== false;

            return h('div', { key: itemKey, 'data-testid': `dxos-approval-card-${itemKey}`, style: S.itemCard },
              h('div', { style: S.rowBetween },
                h('div', { style: S.rowWrap },
                  h('span', { style: S.badge('info') }, sourceLabel(normSrc)),
                  h('span', { style: S.badge(riskTone(item.riskLevel)) }, `Rủi ro: ${item.riskLevel || 'medium'}`),
                  h('span', { style: S.badge(statusTone(item.status)) }, item.status || 'pending'),
                  dlgTag
                    ? h('span', { 'data-testid': `dxos-approval-delegation-${itemKey}`, style: S.badge('info') }, `Ủy quyền: ${dlgTag}`)
                    : null,
                ),
                h('div', { style: { fontSize: 11, color: '#64748b' } },
                  item.dueAt ? `SLA: ${String(item.dueAt).slice(0, 16).replace('T', ' ')}` : '',
                  item.escalatedAt ? ' · Đã leo thang' : '',
                ),
              ),

              h('div', null,
                h('div', { style: { fontSize: 14, fontWeight: 700, color: '#0f172a' } }, item.title || `${item.targetCollection || ''} #${item.targetRecordId || item.targetCode || itemKey}`),
                h('div', { style: { fontSize: 12, color: '#475569' } },
                  `Đối tượng: ${item.targetCollection || '-'} · Mã: ${item.targetCode || item.targetRecordId || '-'} · Người gửi: ${item.requesterUsername || '-'}`,
                ),
                item.summary ? h('div', { style: { fontSize: 12, color: '#334155', marginTop: 4 } }, item.summary) : null,
              ),

              stages.length
                ? h('div', { 'data-testid': `dxos-approval-stages-${itemKey}`, style: S.subCard },
                  h('strong', { style: { fontSize: 11, color: '#475569' } }, 'Tiến trình phê duyệt đa cấp (Sequential / M-of-N):'),
                  stages.filter((x) => x && typeof x === 'object').map((st, sIdx) => {
                    const decisions = (Array.isArray(st.decisions) ? st.decisions : []).filter((x) => x && typeof x === 'object');
                    const approveCount = st.approveCount != null
                      ? Number(st.approveCount)
                      : decisions.filter((d) => d.decision === 'approve').length;
                    const reqCount = Number(st.requiredApprovals) || 1;
                    return h('div', { key: `${itemKey}-st-${sIdx}`, style: { padding: '6px 8px', borderRadius: 6, background: '#f8fafc', border: '1px solid #e2e8f0', fontSize: 12 } },
                      h('div', { style: S.rowBetween },
                        h('span', null,
                          h('strong', null, `Bước ${(st.stageIndex ?? sIdx) + 1}: ${st.name || 'Phê duyệt'}`),
                          ` (${st.mode || 'sequential'} · ${approveCount}/${reqCount})`,
                        ),
                        h('span', { style: S.badge(statusTone(st.status)) }, st.status || 'pending'),
                      ),
                      Array.isArray(st.approverRoles) && st.approverRoles.length
                        ? h('div', { style: { fontSize: 11, color: '#64748b' } }, `Vai trò duyệt: ${st.approverRoles.join(', ')}`)
                        : null,
                      decisions.length
                        ? h('div', { style: { ...S.rowWrap, marginTop: 4 } },
                          decisions.filter((x) => x && typeof x === 'object').map((dec, dIdx) => h('span', { key: dIdx, style: S.badge(dec.decision === 'approve' ? 'ok' : 'danger') },
                            `${dec.username || dec.userId}: ${dec.decision}${dec.delegationUid ? ` [${dec.delegationUid}]` : ''}`,
                          )),
                        )
                        : null,
                    );
                  }),
                )
                : null,

              item.diffPreview && typeof item.diffPreview === 'object'
                ? h('div', { 'data-testid': `dxos-approval-diff-${itemKey}`, style: S.subCard },
                  h('strong', { style: { fontSize: 11, color: '#475569' } }, item.diffPreview.summary || 'Chi tiết thay đổi đề xuất:'),
                  Array.isArray(item.diffPreview.changes)
                    ? item.diffPreview.changes.filter((x) => x && typeof x === 'object').map((c, cIdx) => h('div', { key: cIdx, style: { fontSize: 12, fontFamily: 'monospace' } },
                      `${c.field}: ${JSON.stringify(c.before)} -> ${JSON.stringify(c.after)}`,
                    ))
                    : null,
                )
                : null,

              canAct
                ? h('div', { style: S.rowWrap },
                  h('input', {
                    'data-testid': `dxos-approval-note-${itemKey}`,
                    type: 'text',
                    value: notes[itemKey] || '',
                    placeholder: 'Ghi chú quyết định (bắt buộc >= 3 ký tự khi từ chối)',
                    onChange: (e) => setNotes((prev) => ({ ...prev, [itemKey]: e.target.value })),
                    style: { ...S.input, flex: 1, minWidth: 220 },
                  }),
                  h('button', {
                    type: 'button',
                    'data-testid': `dxos-approval-approve-${itemKey}`,
                    disabled: busy,
                    onClick: () => handleDecide(item, itemKey, 'approve'),
                    style: S.btn(true, false, busy),
                  }, 'Phê duyệt'),
                  h('button', {
                    type: 'button',
                    'data-testid': `dxos-approval-reject-${itemKey}`,
                    disabled: busy,
                    onClick: () => handleDecide(item, itemKey, 'reject'),
                    style: S.btn(false, true, busy),
                  }, 'Từ chối'),
                )
                : null,
            );
          }),
      ),
    );
  };
}

function makeDirectPanelWrapper(factory) {
  return function DirectPanelWrapper(props = {}) {
    const reactImpl = props.React || globalThis.React;
    if (!reactImpl || typeof reactImpl.createElement !== 'function') {
      throw new Error('Pass React via createApprovalInboxPanel(client, React, antd, app) or props.React.');
    }
    const Inner = factory(props.client || null, reactImpl, props.antd || {}, props.app || null);
    return Inner(props);
  };
}

module.exports = {
  APPROVAL_SOURCE_TABS,
  createApprovalInboxPanel,
  ApprovalInboxPanel: makeDirectPanelWrapper(createApprovalInboxPanel),
};
