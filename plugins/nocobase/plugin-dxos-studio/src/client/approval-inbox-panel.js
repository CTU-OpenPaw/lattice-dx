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
  { id: 'proposals', label: 'Đề xuất AI' },
]);

const STATUS_OPTIONS = Object.freeze(['pending', 'reviewed', 'approved', 'rejected', 'executed', 'all']);
const ESCALATION_ROLE_OPTIONS = Object.freeze(['ldx_manager', 'ldx_director', 'ldx_operator', 'ldx_warehouse', 'ldx_dispatcher']);
const POLICY_TARGET_COLLECTIONS = Object.freeze([
  'latticeRequests',
  'latticeOrders',
  'latticeServiceTickets',
  'latticeParaDocuments',
  'latticeIncidentCases',
  'latticeAssets',
]);

function formatVnDateTime(value) {
  if (!value) return '';
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return String(value).slice(0, 16).replace('T', ' ');
  const vn = new Date(d.getTime() + 7 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${vn.getUTCFullYear()}-${pad(vn.getUTCMonth() + 1)}-${pad(vn.getUTCDate())} ${pad(vn.getUTCHours())}:${pad(vn.getUTCMinutes())} (+07:00)`;
}

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
  if (s === 'proposals' || s === 'proposal' || s === 'agent_proposal' || s === 'ai_proposal') return 'proposals';
  return 'business';
}

function sourceLabel(src) {
  if (src === 'ai_hitl') return 'AI HITL';
  if (src === 'flow') return 'Flow v2';
  if (src === 'proposals') return 'Đề xuất AI';
  return 'Nghiệp vụ';
}

function riskTone(risk) {
  const r = String(risk || 'medium').toLowerCase();
  if (r === 'critical' || r === 'high') return 'danger';
  if (r === 'medium') return 'warn';
  return 'info';
}

function riskLabel(risk) {
  const r = String(risk || 'medium').toLowerCase();
  if (r === 'critical') return 'Nghiêm trọng';
  if (r === 'high') return 'Cao';
  if (r === 'medium') return 'Trung bình';
  if (r === 'low') return 'Thấp';
  return risk || 'Trung bình';
}

function statusTone(status) {
  const s = String(status || 'pending').toLowerCase();
  if (s === 'approved' || s === 'executed') return 'ok';
  if (s === 'reviewed') return 'info';
  if (s === 'rejected' || s === 'expired' || s === 'failed') return 'danger';
  if (s === 'pending' || s === 'suspended') return 'warn';
  return 'neutral';
}

function statusLabel(status) {
  const s = String(status || 'pending').toLowerCase();
  if (s === 'pending') return 'Chờ duyệt';
  if (s === 'reviewed') return 'Đã xem xét';
  if (s === 'approved') return 'Đã duyệt';
  if (s === 'rejected') return 'Từ chối';
  if (s === 'executed') return 'Đã thực thi';
  if (s === 'suspended') return 'Tạm dừng';
  if (s === 'expired') return 'Hết hạn';
  if (s === 'failed') return 'Thất bại';
  if (s === 'all') return 'Tất cả';
  return status || 'Chờ duyệt';
}

function formatDiffScalar(v) {
  if (v === undefined) return '∅';
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function formatDiffPreview(diffPreview) {
  if (diffPreview == null) return null;
  if (typeof diffPreview === 'string') {
    const trimmed = diffPreview.trim();
    return trimmed ? { summary: trimmed, changes: [] } : null;
  }
  if (Array.isArray(diffPreview)) {
    const changes = diffPreview
      .filter((x) => x && typeof x === 'object')
      .map((c) => ({
        field: String(c.field || c.key || c.name || 'field'),
        before: c.before !== undefined ? c.before : (c.old !== undefined ? c.old : (c.oldValue !== undefined ? c.oldValue : c.from)),
        after: c.after !== undefined ? c.after : (c.new !== undefined ? c.new : (c.newValue !== undefined ? c.newValue : c.to)),
      }));
    return changes.length ? { summary: 'Chi tiết thay đổi đề xuất:', changes } : null;
  }
  if (typeof diffPreview !== 'object') return null;

  const summary = typeof diffPreview.summary === 'string' && diffPreview.summary.trim()
    ? diffPreview.summary.trim()
    : 'Chi tiết thay đổi đề xuất:';

  if (Array.isArray(diffPreview.changes)) {
    const changes = diffPreview.changes
      .filter((x) => x && typeof x === 'object')
      .map((c) => ({
        field: String(c.field || c.key || c.name || 'field'),
        before: c.before !== undefined ? c.before : (c.old !== undefined ? c.old : (c.oldValue !== undefined ? c.oldValue : c.from)),
        after: c.after !== undefined ? c.after : (c.new !== undefined ? c.new : (c.newValue !== undefined ? c.newValue : c.to)),
      }));
    return { summary, changes };
  }

  const beforeObj = (diffPreview.before && typeof diffPreview.before === 'object' && !Array.isArray(diffPreview.before))
    ? diffPreview.before
    : ((diffPreview.old && typeof diffPreview.old === 'object' && !Array.isArray(diffPreview.old)) ? diffPreview.old : null);
  const afterObj = (diffPreview.after && typeof diffPreview.after === 'object' && !Array.isArray(diffPreview.after))
    ? diffPreview.after
    : ((diffPreview.new && typeof diffPreview.new === 'object' && !Array.isArray(diffPreview.new)) ? diffPreview.new : null);

  if (beforeObj || afterObj) {
    const keys = new Set([...Object.keys(beforeObj || {}), ...Object.keys(afterObj || {})]);
    const changes = [];
    for (const k of keys) {
      const bVal = beforeObj ? beforeObj[k] : undefined;
      const aVal = afterObj ? afterObj[k] : undefined;
      if (JSON.stringify(bVal) !== JSON.stringify(aVal)) {
        changes.push({ field: k, before: bVal, after: aVal });
      }
    }
    return { summary, changes };
  }

  const kvChanges = [];
  for (const [k, v] of Object.entries(diffPreview)) {
    if (k === 'summary' || k === 'changes') continue;
    if (v && typeof v === 'object' && !Array.isArray(v) && ('before' in v || 'after' in v || 'old' in v || 'new' in v)) {
      kvChanges.push({
        field: k,
        before: v.before !== undefined ? v.before : v.old,
        after: v.after !== undefined ? v.after : v.new,
      });
    }
  }
  return { summary, changes: kvChanges };
}

function makeStyles() {
  return {
    stack: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', minWidth: 0, maxWidth: '100%', gap: 14 },
    card: { padding: 16, borderRadius: 12, border: '1px solid #e2e8f0', background: '#ffffff', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', minWidth: 0, maxWidth: '100%', gap: 12 },
    itemCard: { padding: 14, borderRadius: 10, border: '1px solid #e2e8f0', background: '#f8fafc', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', minWidth: 0, maxWidth: '100%', gap: 10 },
    subCard: { padding: 10, borderRadius: 8, border: '1px solid #e2e8f0', background: '#ffffff', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', minWidth: 0, maxWidth: '100%', gap: 6 },
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
    const [countsLoaded, setCountsLoaded] = React.useState(false);
    const [delegations, setDelegations] = React.useState([]);
    const [delegatedRoles, setDelegatedRoles] = React.useState([]);
    const [notes, setNotes] = React.useState({});
    const [feedback, setFeedback] = React.useState(null);
    const [busy, setBusy] = React.useState(false);
    const [reloadTick, setReloadTick] = React.useState(0);
    const [search, setSearch] = React.useState('');
    const [selectedKeys, setSelectedKeys] = React.useState([]);
    const [bulkNote, setBulkNote] = React.useState('');
    const [policyDrawer, setPolicyDrawer] = React.useState({
      open: false,
      items: [],
      loading: false,
      slaResult: null,
      form: {
        policyKey: '',
        name: '',
        targetCollection: 'latticeRequests',
        triggerOperation: 'submit',
        slaMinutes: '240',
        escalateToRole: 'ldx_manager',
        stageRole: 'ldx_manager',
        active: true,
      },
    });
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

    async function loadInbox(currentApi, orgId, src, st, onlyMine, searchText = search, opts = {}) {
      if (!currentApi?.request) return;
      const isCancelled = typeof opts?.isCancelled === 'function' ? opts.isCancelled : null;
      const baseParams = orgId ? { organizationId: orgId } : {};
      const cleanSearch = String(searchText || '').trim();
      try {
        const [inboxRes, dlgRes] = await Promise.all([
          currentApi.request({
            url: 'dxosApprovals:listInbox',
            method: 'get',
            params: {
              ...baseParams,
              source: src,
              status: st,
              ...(onlyMine ? { assignedToMe: true } : {}),
              ...(cleanSearch ? { search: cleanSearch } : {}),
            },
            skipNotify: true,
          }),
          orgId
            ? currentApi.request({
              url: 'dxosDelegations:activeForUser',
              method: 'get',
              params: baseParams,
              skipNotify: true,
            }).catch(() => null)
            : Promise.resolve(null),
        ]);
        if (isCancelled?.()) return;
        const idata = unwrapData(inboxRes);
        const nextItems = (Array.isArray(idata.items) ? idata.items : []).filter((x) => x && typeof x === 'object');
        setItems(nextItems);
        setSelectedKeys((prev) => {
          const validSet = new Set(nextItems.map((it, i) => resolveItemKey(it, i)));
          return prev.filter((k) => validSet.has(k));
        });
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
      } finally {
        if (!isCancelled?.()) {
          setCountsLoaded(true);
        }
      }
    }

    async function loadPolicies() {
      const clientApi = runtimeRef.api;
      if (!clientApi?.request) return;
      setPolicyDrawer((p) => ({ ...p, open: true, loading: true }));
      try {
        const res = await clientApi.request({
          url: 'dxosApprovals:listPolicies',
          method: 'get',
          params: { ...orgPayload },
          skipNotify: true,
        });
        const d = unwrapData(res);
        setPolicyDrawer((p) => ({
          ...p,
          open: true,
          loading: false,
          items: (Array.isArray(d.items) ? d.items : []).filter((x) => x && typeof x === 'object'),
        }));
      } catch (err) {
        setPolicyDrawer((p) => ({ ...p, loading: false }));
        reportFeedback({ type: 'error', text: extractError(err, 'Không tải được danh sách chính sách phê duyệt.') });
      }
    }

    async function handleSavePolicy(e) {
      e?.preventDefault?.();
      const clientApi = runtimeRef.api;
      if (!clientApi?.request || busy) return;
      const f = policyDrawer.form;
      if (!String(f.policyKey || '').trim() || !String(f.name || '').trim()) {
        reportFeedback({ type: 'error', text: 'Vui lòng nhập policyKey và tên chính sách.' });
        return;
      }
      setBusy(true);
      reportFeedback(null);
      try {
        await clientApi.request({
          url: 'dxosApprovals:savePolicy',
          method: 'post',
          data: {
            ...orgPayload,
            policyKey: String(f.policyKey).trim(),
            name: String(f.name).trim(),
            targetCollection: f.targetCollection || 'latticeRequests',
            triggerOperation: f.triggerOperation || 'submit',
            slaMinutes: Math.max(5, Number(f.slaMinutes) || 240),
            escalateToRole: ESCALATION_ROLE_OPTIONS.includes(f.escalateToRole) ? f.escalateToRole : 'ldx_manager',
            stagesJson: [{
              stageIndex: 0,
              name: 'Phê duyệt chính',
              mode: 'sequential',
              requiredApprovals: 1,
              approverRoles: [ESCALATION_ROLE_OPTIONS.includes(f.stageRole) ? f.stageRole : 'ldx_manager'],
            }],
            active: Boolean(f.active),
          },
        });
        setPolicyDrawer((p) => ({ ...p, form: { ...p.form, policyKey: '', name: '' } }));
        await loadPolicies();
        reportFeedback({ type: 'ok', text: `Đã lưu chính sách phê duyệt "${f.policyKey}".` });
      } catch (err) {
        reportFeedback({ type: 'error', text: extractError(err, 'Không lưu được chính sách phê duyệt.') });
      } finally {
        setBusy(false);
      }
    }

    async function handleDeletePolicy(policy) {
      const clientApi = runtimeRef.api;
      if (!clientApi?.request || busy) return;
      setBusy(true);
      reportFeedback(null);
      try {
        await clientApi.request({
          url: 'dxosApprovals:deletePolicy',
          method: 'post',
          data: {
            ...orgPayload,
            ...(policy.id != null ? { policyId: policy.id } : {}),
            ...(policy.policyKey ? { policyKey: policy.policyKey } : {}),
          },
        });
        await loadPolicies();
        reportFeedback({ type: 'ok', text: `Đã xóa chính sách "${policy.policyKey || policy.id}".` });
      } catch (err) {
        reportFeedback({ type: 'error', text: extractError(err, 'Không xóa được chính sách phê duyệt.') });
      } finally {
        setBusy(false);
      }
    }

    async function handleEvaluateSlaNow() {
      const clientApi = runtimeRef.api;
      if (!clientApi?.request || busy) return;
      setBusy(true);
      reportFeedback(null);
      try {
        const res = await clientApi.request({
          url: 'dxosApprovals:evaluateSlaNow',
          method: 'post',
          data: { ...orgPayload },
        });
        const d = unwrapData(res);
        setPolicyDrawer((p) => ({ ...p, slaResult: d }));
        await loadInbox(clientApi, effectiveOrg, source, status, assignedToMe, search);
        reportFeedback({ type: 'ok', text: `Đã đánh giá SLA: ${d.escalatedCount ?? 0} yêu cầu được leo thang.` });
      } catch (err) {
        reportFeedback({ type: 'error', text: extractError(err, 'Không chạy được đánh giá SLA.') });
      } finally {
        setBusy(false);
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
        if (cancelled) return;
        try {
          await loadInbox(api, activeOrg || effectiveOrg, source, status, assignedToMe, search, { isCancelled: () => cancelled });
        } catch (err) {
          if (!cancelled) reportFeedback({ type: 'error', text: extractError(err, 'Không thể tải Hộp thư Phê duyệt.') });
        }
      }
      run();
      return () => { cancelled = true; };
    }, [hasApi, props.selectedOrg, effectiveOrg, source, status, assignedToMe, search, reloadTick]);

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
        await loadInbox(clientApi, effectiveOrg, source, status, assignedToMe, search);
        const verb = decision === 'approve' ? 'phê duyệt' : (decision === 'review' ? 'đánh dấu đã xem' : 'từ chối');
        reportFeedback({ type: 'ok', text: `Đã ${verb} mục ${itemKey}.` });
      } catch (err) {
        reportFeedback({ type: 'error', text: extractError(err, 'Không thể xử lý phê duyệt.') });
      } finally {
        setBusy(false);
      }
    }

    async function handleBulkDecide(decision) {
      const clientApi = runtimeRef.api;
      if (!clientApi?.request || busy) return;
      const selectedSet = new Set(selectedKeys);
      const targets = items
        .map((item, idx) => ({ item, itemKey: resolveItemKey(item, idx) }))
        .filter(({ item, itemKey }) => selectedSet.has(itemKey) && (item.status === 'pending' || item.status === 'suspended') && item.canAct !== false);
      if (!targets.length) {
        reportFeedback({ type: 'error', text: 'Vui lòng chọn ít nhất 1 yêu cầu đang chờ xử lý.' });
        return;
      }
      const cleanBulkNote = String(bulkNote || '').trim();
      if (decision === 'reject' && cleanBulkNote.length < 3) {
        reportFeedback({ type: 'error', text: 'Từ chối hàng loạt phải nhập lý do tối thiểu 3 ký tự.' });
        return;
      }
      setBusy(true);
      reportFeedback(null);
      let okCount = 0;
      let errMsg = '';
      try {
        for (const { item, itemKey } of targets) {
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
                note: cleanBulkNote || String(notes[itemKey] || '').trim(),
              },
            });
            okCount += 1;
          } catch (err) {
            errMsg = extractError(err, 'Một số mục không thể xử lý.');
          }
        }
        setSelectedKeys([]);
        if (decision === 'reject') setBulkNote('');
        await loadInbox(clientApi, effectiveOrg, source, status, assignedToMe, search);
        if (errMsg && okCount === 0) {
          reportFeedback({ type: 'error', text: errMsg });
        } else {
          reportFeedback({
            type: 'ok',
            text: `Đã ${decision === 'approve' ? 'phê duyệt' : 'từ chối'} ${okCount}/${targets.length} mục đã chọn.${errMsg ? ` Lỗi còn lại: ${errMsg}` : ''}`,
          });
        }
      } finally {
        setBusy(false);
      }
    }

    const actionableKeys = items
      .filter((x) => x && typeof x === 'object' && (x.status === 'pending' || x.status === 'suspended') && x.canAct !== false)
      .map((x, idx) => resolveItemKey(x, items.indexOf(x) >= 0 ? items.indexOf(x) : idx));
    const allActionableSelected = actionableKeys.length > 0 && actionableKeys.every((k) => selectedKeys.includes(k));

    return h('div', {
      'data-testid': 'dxos-approval-inbox',
      'data-counts-ready': countsLoaded ? 'true' : 'false',
      style: S.stack,
    },
      h('div', { style: S.card },
        h('div', { style: S.rowBetween },
          h('div', null,
            h('h3', { style: { margin: 0, fontSize: 16, color: '#0f172a' } }, 'Hộp thư Phê duyệt Thống nhất'),
            h('div', { style: { fontSize: 12, color: '#64748b' } }, 'Hợp nhất phê duyệt Nghiệp vụ nhiều cấp, AI HITL và tạm dừng/tiếp tục quy trình LatticeFlow v2.'),
          ),
          h('div', { style: S.rowWrap },
            h('button', {
              type: 'button',
              'data-testid': 'dxos-approvals-policies-btn',
              onClick: () => (policyDrawer.open ? setPolicyDrawer((p) => ({ ...p, open: false })) : loadPolicies()),
              style: S.btn(false, false, busy),
            }, policyDrawer.open ? 'Đóng Chính sách Phê duyệt' : 'Chính sách Phê duyệt & SLA'),
            h('button', {
              type: 'button',
              'data-testid': 'dxos-approvals-refresh-btn',
              onClick: () => setReloadTick((n) => n + 1),
              style: S.btn(false, false, busy),
            }, 'Làm mới'),
          ),
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
              const count = counts[t.id] ?? (t.id === 'all' ? counts.total : undefined);
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
            h('input', {
              'data-testid': 'dxos-approvals-search-input',
              type: 'text',
              value: search,
              placeholder: 'Tìm tiêu đề / mã yêu cầu / người gửi…',
              onChange: (e) => setSearch(e.target.value),
              style: { ...S.input, minWidth: 200 },
            }),
            h('select', {
              'data-testid': 'dxos-approvals-status-filter',
              value: status,
              onChange: (e) => setStatus(e.target.value),
              style: S.input,
            }, STATUS_OPTIONS.map((opt) => h('option', { key: opt, value: opt }, statusLabel(opt)))),
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

        actionableKeys.length ? h('div', {
          'data-testid': 'dxos-approvals-bulk-bar',
          style: { ...S.subCard, background: '#f8fafc', padding: 10 },
        },
          h('div', { style: S.rowWrap },
            h('label', { style: { fontSize: 12, display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600 } },
              h('input', {
                'data-testid': 'dxos-approvals-select-all',
                type: 'checkbox',
                checked: allActionableSelected,
                onChange: (e) => setSelectedKeys(e?.target?.checked ? actionableKeys : []),
              }),
              `Chọn tất cả (${selectedKeys.length}/${actionableKeys.length})`,
            ),
            h('input', {
              'data-testid': 'dxos-approvals-bulk-note',
              type: 'text',
              value: bulkNote,
              placeholder: 'Ghi chú xử lý hàng loạt (tối thiểu 3 ký tự nếu Từ chối)',
              onChange: (e) => setBulkNote(e.target.value),
              style: { ...S.input, flex: 1, minWidth: 190 },
            }),
            h('button', {
              type: 'button',
              'data-testid': 'dxos-approvals-bulk-approve',
              disabled: busy || !selectedKeys.length,
              onClick: () => handleBulkDecide('approve'),
              style: S.btn(true, false, busy || !selectedKeys.length),
            }, `Duyệt hàng loạt (${selectedKeys.length})`),
            h('button', {
              type: 'button',
              'data-testid': 'dxos-approvals-bulk-reject',
              disabled: busy || !selectedKeys.length,
              onClick: () => handleBulkDecide('reject'),
              style: S.btn(false, true, busy || !selectedKeys.length),
            }, 'Từ chối hàng loạt'),
          ),
        ) : null,

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
            const parsedDiff = formatDiffPreview(item.diffPreview);

            return h('div', { key: itemKey, 'data-testid': `dxos-approval-card-${itemKey}`, style: S.itemCard },
              h('div', { style: S.rowBetween },
                h('div', { style: S.rowWrap },
                  canAct ? h('input', {
                    'data-testid': `dxos-approval-select-${itemKey}`,
                    type: 'checkbox',
                    checked: selectedKeys.includes(itemKey),
                    onChange: (e) => {
                      const checked = Boolean(e?.target?.checked);
                      setSelectedKeys((prev) => (checked ? Array.from(new Set([...prev, itemKey])) : prev.filter((k) => k !== itemKey)));
                    },
                  }) : null,
                  h('span', { style: S.badge('info') }, sourceLabel(normSrc)),
                  h('span', { style: S.badge(riskTone(item.riskLevel)) }, `Rủi ro: ${riskLabel(item.riskLevel)}`),
                  h('span', { style: S.badge(statusTone(item.status)) }, statusLabel(item.status)),
                  dlgTag
                    ? h('span', { 'data-testid': `dxos-approval-delegation-${itemKey}`, style: S.badge('info') }, `Ủy quyền: ${dlgTag}`)
                    : null,
                ),
                h('div', { style: { fontSize: 11, color: '#64748b' } },
                  item.dueAt ? `SLA: ${formatVnDateTime(item.dueAt)}` : '',
                  item.escalatedAt ? ' · Đã leo thang' : '',
                ),
              ),

              h('div', null,
                h('div', { style: { fontSize: 14, fontWeight: 700, color: '#0f172a' } }, item.title || `${item.targetCollection || ''} #${item.targetRecordId || item.targetCode || itemKey}`),
                h('div', { style: { fontSize: 12, color: '#475569' } },
                  `Đối tượng: ${item.targetCollection || '-'} · Mã: ${item.targetCode || item.targetRecordId || '-'} · Người gửi: ${item.requesterUsername || '-'}`,
                ),
                item.summary ? h('div', { style: { fontSize: 12, color: '#334155', marginTop: 4 } }, item.summary) : null,
                Array.isArray(item.evidence) && item.evidence.length
                  ? h('div', { 'data-testid': `dxos-approval-evidence-${itemKey}`, style: { ...S.rowWrap, marginTop: 6 } },
                    h('strong', { style: { fontSize: 11, color: '#475569' } }, 'Bằng chứng:'),
                    item.evidence.filter((e) => e && typeof e === 'object').map((ev, eIdx) => h('span', { key: eIdx, style: S.badge('info') },
                      `${ev.kind || 'evidence'}${ev.collection ? `: ${ev.collection}#${ev.recordId ?? ''}` : (ev.entityId ? `: ${ev.entityId}` : '')}`,
                    )),
                  )
                  : null,
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
                        h('span', { style: S.badge(statusTone(st.status)) }, statusLabel(st.status)),
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

              parsedDiff
                ? h('div', { 'data-testid': `dxos-approval-diff-${itemKey}`, style: S.subCard },
                  h('strong', { style: { fontSize: 11, color: '#475569' } }, parsedDiff.summary),
                  parsedDiff.changes.length
                    ? h('div', { style: { display: 'grid', gap: 4 } },
                      parsedDiff.changes.map((c, cIdx) => h('div', {
                        key: cIdx,
                        style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 4, fontSize: 12, fontFamily: 'monospace' },
                      },
                        h('span', { style: { fontWeight: 600, color: '#0f172a' } }, `${c.field}: `),
                        h('span', { style: { padding: '1px 6px', borderRadius: 4, background: '#fee2e2', color: '#991b1b' } }, formatDiffScalar(c.before)),
                        h('span', { style: { color: '#64748b' } }, ' -> '),
                        h('span', { style: { padding: '1px 6px', borderRadius: 4, background: '#dcfce7', color: '#166534' } }, formatDiffScalar(c.after)),
                      )),
                    )
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
                  normSrc === 'proposals' ? h('button', {
                    type: 'button',
                    'data-testid': `dxos-approval-review-${itemKey}`,
                    disabled: busy,
                    onClick: () => handleDecide(item, itemKey, 'review'),
                    style: S.btn(false, false, busy),
                  }, 'Đã xem (Review)') : null,
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

      policyDrawer.open ? h('div', {
        'data-testid': 'dxos-approvals-policies-drawer',
        style: { ...S.card, border: '2px solid #93c5fd', background: '#f8fafc' },
      },
        h('div', { style: S.rowBetween },
          h('div', null,
            h('h4', { style: { margin: 0, fontSize: 15, color: '#0f172a' } }, 'Quản trị Chính sách Phê duyệt & Leo thang SLA'),
            h('div', { style: { fontSize: 12, color: '#64748b' } }, 'Cấu hình quy tắc phê duyệt đa cấp và vai trò leo thang khi quá hạn SLA (loại trừ vai trò quản trị tối cao).'),
          ),
          h('div', { style: S.rowWrap },
            h('button', {
              type: 'button',
              'data-testid': 'dxos-approvals-eval-sla-btn',
              disabled: busy,
              onClick: handleEvaluateSlaNow,
              style: S.btn(true, false, busy),
            }, 'Đánh giá SLA ngay'),
            h('button', {
              type: 'button',
              'data-testid': 'dxos-approvals-policies-close-btn',
              onClick: () => setPolicyDrawer((p) => ({ ...p, open: false })),
              style: S.btn(false),
            }, 'Đóng'),
          ),
        ),
        policyDrawer.slaResult ? h('div', {
          'data-testid': 'dxos-approvals-sla-result',
          style: { padding: 8, borderRadius: 6, border: '1px solid #bfdbfe', background: '#eff6ff', fontSize: 12, color: '#1e3a8a' },
        }, `SLA Check: ${policyDrawer.slaResult.escalatedCount ?? 0} yêu cầu được leo thang · Đã kiểm tra ${policyDrawer.slaResult.checkedCount ?? 0}.`) : null,
        h('form', {
          'data-testid': 'dxos-approvals-policy-form',
          onSubmit: handleSavePolicy,
          style: { ...S.subCard, padding: 12 },
        },
          h('strong', { style: { fontSize: 12 } }, 'Tạo / Cập nhật Chính sách Phê duyệt'),
          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 8 } },
            h('input', {
              'data-testid': 'dxos-policy-key-input',
              type: 'text',
              required: true,
              value: policyDrawer.form.policyKey,
              placeholder: 'policyKey (vd: po-high-value)',
              onChange: (e) => setPolicyDrawer((p) => ({ ...p, form: { ...p.form, policyKey: e.target.value } })),
              style: S.input,
            }),
            h('input', {
              'data-testid': 'dxos-policy-name-input',
              type: 'text',
              required: true,
              value: policyDrawer.form.name,
              placeholder: 'Tên chính sách',
              onChange: (e) => setPolicyDrawer((p) => ({ ...p, form: { ...p.form, name: e.target.value } })),
              style: S.input,
            }),
            h('select', {
              'data-testid': 'dxos-policy-collection-select',
              value: policyDrawer.form.targetCollection,
              onChange: (e) => setPolicyDrawer((p) => ({ ...p, form: { ...p.form, targetCollection: e.target.value } })),
              style: S.input,
            }, POLICY_TARGET_COLLECTIONS.map((col) => h('option', { key: col, value: col }, col))),
            h('input', {
              'data-testid': 'dxos-policy-sla-input',
              type: 'number',
              min: 5,
              value: policyDrawer.form.slaMinutes,
              placeholder: 'SLA (phút)',
              onChange: (e) => setPolicyDrawer((p) => ({ ...p, form: { ...p.form, slaMinutes: e.target.value } })),
              style: S.input,
            }),
            h('select', {
              'data-testid': 'dxos-policy-escalate-select',
              value: policyDrawer.form.escalateToRole,
              onChange: (e) => setPolicyDrawer((p) => ({ ...p, form: { ...p.form, escalateToRole: e.target.value } })),
              style: S.input,
            }, ESCALATION_ROLE_OPTIONS.map((r) => h('option', { key: r, value: r }, `Leo thang: ${r}`))),
          ),
          h('div', null,
            h('button', { type: 'submit', disabled: busy, style: S.btn(true, false, busy) }, 'Lưu Chính sách'),
          ),
        ),
        !(policyDrawer.items || []).length
          ? h('div', { style: { fontSize: 12, color: '#64748b' } }, policyDrawer.loading ? 'Đang tải chính sách…' : 'Chưa có chính sách phê duyệt nào.')
          : h('div', { style: { display: 'grid', gap: 8 } },
            policyDrawer.items.map((pol) => h('div', {
              key: pol.policyKey || pol.id,
              'data-testid': `dxos-policy-row-${pol.policyKey}`,
              style: { ...S.subCard, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
            },
              h('div', { style: { fontSize: 12 } },
                h('div', { style: { fontWeight: 700, color: '#0f172a' } }, `${pol.name} (${pol.policyKey})`),
                h('div', { style: { color: '#475569' } }, `${pol.targetCollection} · ${pol.triggerOperation || 'submit'} · SLA ${pol.slaMinutes ?? 240}m · Leo thang: ${pol.escalateToRole || '-'}`),
              ),
              h('button', {
                type: 'button',
                'data-testid': `dxos-policy-delete-${pol.policyKey}`,
                disabled: busy,
                onClick: () => handleDeletePolicy(pol),
                style: S.btn(false, true, busy),
              }, 'Xóa'),
            )),
          ),
      ) : null,
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
  formatDiffPreview,
  riskLabel,
  statusLabel,
};
