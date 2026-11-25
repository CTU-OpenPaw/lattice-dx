/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const DEFAULT_TOOL_NAMES = [
  'dxos_inspect_architecture',
  'dxos_recommend_page_blueprint',
  'dxos_design_creative_block',
  'dxos_compose_page_blocks',
  'dxos_snapshot_or_rollback_page',
  'dxos_provision_role_workspace',
  'dxos_manage_portal_and_acl',
  'dxos_extend_collection_schema',
  'dxos_manage_rbac_permissions',
  'dxos_deploy_workflow',
  'dxos_configure_workflow',
  'dxos_search_enterprise_context',
  'dxos_execute_record_action',
  'dxos_my_workflow_tasks',
  'dxos_orchestrate_enterprise_case',
  'dxos_graph_impact_analysis',
  'dxos_alarm_action',
];

const DEFAULT_ROLE_OPTIONS = [
  'root', 'admin', 'ldx_admin', 'ldx_director', 'ldx_manager',
  'ldx_operator', 'ldx_warehouse', 'ldx_dispatcher', 'ldx_driver', 'ldx_employee',
];

const DEFAULT_PORTALS = ['procurement', 'logistics', 'incidents', 'services', 'admin-studio'];

const MODEL_PRESETS = [
  'local-9router:ag/gemini-3.8-flash',
  'local-9router:combo',
  'local-9router:openai/gpt-4o-mini',
];

function defaultItOtMcpUrl() {
  const origin = typeof window !== 'undefined' && window.location?.origin
    ? window.location.origin
    : 'http://127.0.0.1:13014';
  return `${origin}/api/dxos-mcp/it-ot`;
}

function randomThreeDigitSuffix() {
  const c = typeof globalThis !== 'undefined' && globalThis.crypto
    ? globalThis.crypto
    : (typeof window !== 'undefined' ? window.crypto : null);
  if (c && typeof c.getRandomValues === 'function') {
    const buf = new Uint32Array(1);
    c.getRandomValues(buf);
    return 100 + (buf[0] % 900);
  }
  return 100 + (Date.now() % 900);
}

function resolveTopologyRuntimeVersion(topology, app) {
  if (topology?.nocobaseVersion) {
    return String(topology.nocobaseVersion).trim().replace(/^v/i, '');
  }
  const attr = topology?.planes?.find((p) => p?.key === 'appDataSubstrate')?.clause52Attribution || '';
  const m = String(attr).match(/v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/i);
  if (m && m[1]) return m[1];
  const stmt = String(topology?.positioningStatement || '');
  const m2 = stmt.match(/NocoBase\s+v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/i);
  if (m2 && m2[1]) return m2[1];
  const appVer = app?.version || app?.maintaining?.version;
  if (appVer) return String(appVer).trim().replace(/^v/i, '');
  return '2.2.50';
}

function formatMetricEntries(metrics) {
  if (!metrics || typeof metrics !== 'object') return [];
  return Object.entries(metrics).map(([key, value]) => ({
    key,
    value: value == null ? '0' : String(value),
  }));
}

function parseToolModeMap(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  const legacyTasksKey = ['dxos_my_tasks_co', 'pilot'].join('');
  for (const [k, v] of Object.entries(input)) {
    const mode = String(v || 'OFF').toUpperCase();
    const normalizedMode = mode === 'ALLOW' || mode === 'ASK' ? mode : 'OFF';
    if (k === legacyTasksKey) {
      if (!Object.prototype.hasOwnProperty.call(out, 'dxos_my_workflow_tasks')) {
        out.dxos_my_workflow_tasks = normalizedMode;
      }
      continue;
    }
    out[k] = normalizedMode;
  }
  return out;
}

function resolveStudioDefaultOrg({ topology, catalog, profiles, app } = {}) {
  const candidates = [
    topology?.defaultOrganizationId,
    ...(Array.isArray(topology?.organizations) ? topology.organizations : []),
    catalog?.defaultOrganizationId,
    ...(Array.isArray(catalog?.organizations) ? catalog.organizations : []),
    ...(Array.isArray(profiles) ? profiles.map((p) => p?.organizationId) : []),
    app?.defaultOrganizationId,
    app?.organizationId,
    typeof globalThis !== 'undefined' ? globalThis.__LATTICEDX_DEFAULT_ORG__ : '',
  ];
  for (const c of candidates) {
    const clean = String(c || '').trim();
    if (clean && clean.toLowerCase() !== 'all') return clean;
  }
  return '';
}

function createEmptyProfileDraft(defaultOrg = '') {
  return {
    username: '',
    nickname: '',
    position: 'Trợ lý AI Phòng ban',
    departmentScope: 'general',
    organizationId: String(defaultOrg || '').trim(),
    llmService: 'local-9router',
    modelName: 'ag/gemini-3.8-flash',
    enabled: true,
    isAdminBuilder: false,
    allowSubAgentDispatch: false,
    allowedRoles: ['ldx_employee', 'ldx_manager'],
    toolPermissions: {
      dxos_search_enterprise_context: 'ALLOW',
      dxos_execute_record_action: 'ASK',
      dxos_my_workflow_tasks: 'ALLOW',
    },
    mcpServers: [{ name: 'dxos-it-ot-mcp', url: defaultItOtMcpUrl(), useUserContext: true, enabled: true }],
    portalBindings: ['services'],
    quickPrompts: [{ label: 'Tóm tắt công việc & SOP', prompt: 'Kiểm tra công việc chờ xử lý và tra cứu SOP liên quan.' }],
    greeting: 'Xin chào! Tôi là nhân sự AI được cấu hình từ DX-OS AI Studio.',
    systemPrompt: 'Trả lời ngắn gọn bằng tiếng Việt, luôn trích dẫn mã tham chiếu bản ghi [collection:code#id].',
  };
}

function buildProfileDraftFromStarter(profile = {}) {
  const baseSlug = String(profile.username || 'custom-ai').replace(/[^a-z0-9_-]/gi, '').slice(0, 40) || 'custom-ai';
  const suffix = randomThreeDigitSuffix();
  return {
    ...createEmptyProfileDraft(),
    ...profile,
    username: `${baseSlug}-copy-${suffix}`,
    nickname: `${profile.nickname || baseSlug} (Bản sao)`,
    allowedRoles: Array.isArray(profile.allowedRoles) ? [...profile.allowedRoles] : ['ldx_employee'],
    toolPermissions: parseToolModeMap(profile.toolPermissions),
    mcpServers: Array.isArray(profile.mcpServers) ? profile.mcpServers.map((s) => ({ ...s })) : [],
    portalBindings: Array.isArray(profile.portalBindings) ? [...profile.portalBindings] : [],
    quickPrompts: Array.isArray(profile.quickPrompts) ? profile.quickPrompts.map((q) => ({ ...q })) : [],
  };
}

function parseModelSelection(rawValue) {
  const str = String(rawValue || '');
  const idx = str.indexOf(':');
  if (idx < 0) {
    return { llmService: str.trim() || 'local-9router', modelName: 'ag/gemini-3.8-flash' };
  }
  const llmService = str.slice(0, idx).trim() || 'local-9router';
  const modelName = str.slice(idx + 1).trim() || 'ag/gemini-3.8-flash';
  return { llmService, modelName };
}

function toggleArrayItem(arr, item) {
  const list = Array.isArray(arr) ? arr : [];
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

function createDxosAiStudioPage(client, React, _antd, app) {
  const h = React.createElement;
  const useApi = typeof client?.useAPIClient === 'function' ? client.useAPIClient : () => app?.apiClient || null;

  const btnStyle = (primary, danger) => ({
    padding: '6px 14px',
    borderRadius: 8,
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 600,
    border: danger ? '1px solid #ef4444' : primary ? '1px solid #0284c7' : '1px solid #cbd5e1',
    background: danger ? '#fee2e2' : primary ? '#0284c7' : '#ffffff',
    color: danger ? '#b91c1c' : primary ? '#ffffff' : '#0f172a',
  });

  const badgeStyle = (bg, fg) => ({
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: 999,
    fontSize: 11,
    fontWeight: 700,
    background: bg,
    color: fg,
    whiteSpace: 'nowrap',
    flexShrink: 0,
  });

  const renderProgressBar = (label, used, limit, displayUsed, displayLimit) => {
    const safeLimit = Math.max(1e-9, Number(limit) || 1);
    const pct = Math.min(100, Math.max(0, Math.round(((Number(used) || 0) / safeLimit) * 100)));
    const barColor = pct >= 95 ? '#ef4444' : pct >= 75 ? '#f59e0b' : '#0284c7';
    return h('div', {
      key: label,
      style: { padding: 12, borderRadius: 10, border: '1px solid #e2e8f0', background: '#f8fafc', display: 'grid', gap: 6 },
    },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, fontSize: 12 } },
        h('strong', { style: { color: '#0f172a' } }, label),
        h('span', { style: { color: '#334155', fontWeight: 600 } }, `${displayUsed} / ${displayLimit} (${pct}%)`),
      ),
      h('div', { style: { height: 8, borderRadius: 999, background: '#e2e8f0', overflow: 'hidden' } },
        h('div', { style: { width: `${pct}%`, height: '100%', background: barColor, borderRadius: 999 } }),
      ),
    );
  };

  return function DxosAiStudioPage() {
    const api = useApi();
    const uiPerms = typeof client?.useUIConfigurationPermissions === 'function' ? client.useUIConfigurationPermissions() : null;
    const clientDenied = Boolean(uiPerms && uiPerms.allowAll === false && uiPerms.allowConfigUI === false);
    const [tab, setTab] = React.useState('topology');
    const [loading, setLoading] = React.useState(!clientDenied);
    const [forbidden, setForbidden] = React.useState(clientDenied);
    const [busy, setBusy] = React.useState(false);
    const [notice, setNotice] = React.useState(null);
    const [profiles, setProfiles] = React.useState([]);
    const [catalog, setCatalog] = React.useState({
      availableTools: DEFAULT_TOOL_NAMES,
      adminBuilderTools: DEFAULT_TOOL_NAMES.slice(0, 11),
      roleOptions: DEFAULT_ROLE_OPTIONS,
    });
    const [topology, setTopology] = React.useState(null);
    const [auditItems, setAuditItems] = React.useState([]);
    const [draft, setDraft] = React.useState(() => createEmptyProfileDraft(resolveStudioDefaultOrg({ app })));
    const [mcpText, setMcpText] = React.useState(() => JSON.stringify(createEmptyProfileDraft().mcpServers, null, 2));
    const [promptsText, setPromptsText] = React.useState(() => JSON.stringify(createEmptyProfileDraft().quickPrompts, null, 2));
    const [quotaOrg, setQuotaOrg] = React.useState(() => resolveStudioDefaultOrg({ app }) || '');
    const [quotaOrgDraft, setQuotaOrgDraft] = React.useState(() => resolveStudioDefaultOrg({ app }) || '');
    const [quotaSummary, setQuotaSummary] = React.useState(null);
    const [quotaLoading, setQuotaLoading] = React.useState(false);
    const [customModelMode, setCustomModelMode] = React.useState(false);
    const [customModelText, setCustomModelText] = React.useState(
      () => `${createEmptyProfileDraft().llmService}:${createEmptyProfileDraft().modelName}`,
    );
    const [approvals, setApprovals] = React.useState([]);
    const [approvalsLoading, setApprovalsLoading] = React.useState(false);
    const [approvalStatusFilter, setApprovalStatusFilter] = React.useState('pending');
    const [approvalNotes, setApprovalNotes] = React.useState({});
    const [approvalBusyId, setApprovalBusyId] = React.useState(null);
    const [triageScanning, setTriageScanning] = React.useState(false);
    const quotaReqSeqRef = typeof React.useRef === 'function'
      ? React.useRef(0)
      : (typeof React.useMemo === 'function' ? React.useMemo(() => ({ current: 0 }), []) : { current: 0 });
    const hitlReqSeqRef = typeof React.useRef === 'function'
      ? React.useRef(0)
      : (typeof React.useMemo === 'function' ? React.useMemo(() => ({ current: 0 }), []) : { current: 0 });
    const quotaOrgCommittedRef = typeof React.useRef === 'function'
      ? React.useRef(false)
      : (typeof React.useMemo === 'function' ? React.useMemo(() => ({ current: false }), []) : { current: false });

    const selectDraft = (next) => {
      const fallbackOrg = resolveStudioDefaultOrg({ topology, catalog, profiles, app });
      const normalized = {
        ...createEmptyProfileDraft(fallbackOrg),
        ...next,
        organizationId: String(next?.organizationId || fallbackOrg || '').trim(),
        toolPermissions: parseToolModeMap(next?.toolPermissions),
        allowedRoles: Array.isArray(next?.allowedRoles) ? next.allowedRoles : ['ldx_employee'],
        portalBindings: Array.isArray(next?.portalBindings) ? next.portalBindings : [],
      };
      const combo = `${normalized.llmService || 'local-9router'}:${normalized.modelName || 'ag/gemini-3.8-flash'}`;
      setCustomModelMode(!MODEL_PRESETS.includes(combo));
      setCustomModelText(combo);
      setDraft(normalized);
      setMcpText(JSON.stringify(Array.isArray(next?.mcpServers) ? next.mcpServers : [], null, 2));
      setPromptsText(JSON.stringify(Array.isArray(next?.quickPrompts) ? next.quickPrompts : [], null, 2));
    };

    const loadAll = React.useCallback(async () => {
      if (clientDenied || !api?.request) {
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        // Probe single admin endpoint first so non-admins do not fire multiple parallel 403 errors
        const pRes = await api.request({ url: 'dxosAi:listProfiles', method: 'get', skipNotify: true });
        setForbidden(false);
        const pData = pRes?.data?.data || pRes?.data || {};
        const loadedProfiles = Array.isArray(pData.profiles) ? pData.profiles : [];
        if (Array.isArray(pData.profiles)) setProfiles(loadedProfiles);
        if (pData.catalog) setCatalog(pData.catalog);

        const [tRes, aRes] = await Promise.allSettled([
          api.request({ url: 'dxosAi:enterpriseTopology', method: 'get' }),
          api.request({ url: 'dxosAi:auditLogs', method: 'get', params: { pageSize: 40 } }),
        ]);
        let loadedTopology = null;
        if (tRes.status === 'fulfilled') {
          loadedTopology = tRes.value?.data?.data || tRes.value?.data || null;
          setTopology(loadedTopology);
        }
        const discoveredOrg = resolveStudioDefaultOrg({
          topology: loadedTopology,
          catalog: {
            ...(pData.catalog || {}),
            ...(Array.isArray(pData.organizations) ? { organizations: pData.organizations } : {}),
            ...(pData.defaultOrganizationId ? { defaultOrganizationId: pData.defaultOrganizationId } : {}),
          },
          profiles: loadedProfiles,
          app,
        });
        if (discoveredOrg) {
          if (!quotaOrgCommittedRef.current) {
            setQuotaOrg(discoveredOrg);
            setQuotaOrgDraft(discoveredOrg);
          }
          setDraft((prev) => (prev && !prev.organizationId ? { ...prev, organizationId: discoveredOrg } : prev));
        }
        if (aRes.status === 'fulfilled') {
          const data = aRes.value?.data?.data || aRes.value?.data || {};
          setAuditItems(Array.isArray(data.items) ? data.items : []);
        }
      } catch (err) {
        const status = Number(err?.response?.status ?? err?.status);
        if (status === 403 || status === 401) {
          setForbidden(true);
        } else {
          setNotice({ type: 'error', text: err?.message || 'Không tải được dữ liệu DX-OS AI Studio.' });
        }
      } finally {
        setLoading(false);
      }
    }, [api, clientDenied]);

    const loadQuota = React.useCallback(async (orgId = quotaOrg) => {
      if (clientDenied || !api?.request) return;
      const reqSeq = ++quotaReqSeqRef.current;
      setQuotaLoading(true);
      try {
        const fallbackOrg = resolveStudioDefaultOrg({ topology, catalog, profiles, app }) || quotaOrg || '';
        const targetOrg = String(orgId || fallbackOrg).trim();
        if (!targetOrg) {
          setQuotaSummary(null);
          return;
        }
        const qRes = await api.request({ url: 'dxosAi:quotaSummary', method: 'get', params: { organizationId: targetOrg } });
        if (reqSeq !== quotaReqSeqRef.current) return;
        setQuotaSummary(qRes?.data?.data || qRes?.data || null);
      } catch (err) {
        if (reqSeq !== quotaReqSeqRef.current) return;
        const status = Number(err?.response?.status ?? err?.status);
        if (status === 403 || status === 401) {
          setForbidden(true);
        } else {
          setNotice({ type: 'error', text: err?.message || 'Không tải được dữ liệu hạn mức & chi phí AI.' });
        }
      } finally {
        if (reqSeq === quotaReqSeqRef.current) {
          setQuotaLoading(false);
        }
      }
    }, [api, clientDenied, quotaOrg]);

    const commitQuotaOrg = (rawOrg) => {
      quotaOrgCommittedRef.current = true;
      const fallbackOrg = resolveStudioDefaultOrg({ topology, catalog, profiles, app }) || quotaOrg || '';
      const nextOrg = String(rawOrg || '').trim() || fallbackOrg;
      if (!nextOrg) return;
      setQuotaOrgDraft(nextOrg);
      if (nextOrg === quotaOrg) {
        loadQuota(nextOrg);
      } else {
        setQuotaOrg(nextOrg);
      }
    };

    const loadApprovals = React.useCallback(async (statusFilter = approvalStatusFilter) => {
      if (clientDenied || !api?.request) return;
      const reqSeq = ++hitlReqSeqRef.current;
      setApprovalsLoading(true);
      try {
        const res = await api.request({
          url: 'dxosAi:listApprovals',
          method: 'get',
          params: { status: statusFilter || 'pending', limit: 50 },
        });
        if (reqSeq !== hitlReqSeqRef.current) return;
        const data = res?.data?.data || res?.data || {};
        setApprovals(Array.isArray(data.items) ? data.items : []);
      } catch (err) {
        if (reqSeq !== hitlReqSeqRef.current) return;
        setNotice({ type: 'error', text: err?.response?.data?.errors?.[0]?.message || err?.message || 'Không tải được hàng chờ phê duyệt AI.' });
      } finally {
        if (reqSeq === hitlReqSeqRef.current) {
          setApprovalsLoading(false);
        }
      }
    }, [api, clientDenied, approvalStatusFilter]);

    React.useEffect(() => {
      loadAll();
    }, [loadAll]);

    React.useEffect(() => {
      if (tab === 'quota' && !clientDenied && !forbidden) {
        loadQuota(quotaOrg);
      }
      if (tab === 'hitl' && !clientDenied && !forbidden) {
        loadApprovals(approvalStatusFilter);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tab, quotaOrg, approvalStatusFilter, clientDenied, forbidden]);

    const handleDecideApproval = async (item, decision) => {
      if (!api?.request || !item?.id) return;
      const approvalId = item.id;
      const note = String(approvalNotes[approvalId] || '').trim();
      if (decision === 'reject' && note.length < 3) {
        setNotice({ type: 'error', text: 'Vui lòng nhập lý do từ chối tối thiểu 3 ký tự.' });
        return;
      }
      setApprovalBusyId(approvalId);
      setNotice(null);
      try {
        await api.request({
          url: decision === 'approve' ? 'dxosAi:approveAction' : 'dxosAi:rejectAction',
          method: 'post',
          data: { approvalId, note },
        });
        setApprovalNotes((prev) => {
          const next = { ...prev };
          delete next[approvalId];
          return next;
        });
        setNotice({
          type: 'ok',
          text: decision === 'approve'
            ? `Đã phê duyệt & thực thi yêu cầu AI #${approvalId}.`
            : `Đã từ chối yêu cầu AI #${approvalId}.`,
        });
        await loadApprovals(approvalStatusFilter);
      } catch (err) {
        setNotice({ type: 'error', text: err?.response?.data?.errors?.[0]?.message || err?.message || 'Xử lý phê duyệt AI thất bại.' });
      } finally {
        setApprovalBusyId(null);
      }
    };

    const handleTriageScan = async () => {
      if (!api?.request || triageScanning) return;
      setTriageScanning(true);
      setNotice(null);
      try {
        const res = await api.request({
          url: 'dxosAi:triageScan',
          method: 'post',
          data: {},
        });
        const d = res?.data?.data || res?.data || {};
        const scannedCount = Number(d.scannedCount || 0);
        const proposalsCreated = Number(d.proposalsCreated || 0);
        const deduplicatedSkipped = Number(d.deduplicatedSkipped || 0);
        setNotice({
          type: 'ok',
          text: `Quét cảnh báo chủ động (${scannedCount} sự cố): tạo mới ${proposalsCreated} đề xuất HITL, bỏ qua ${deduplicatedSkipped} trùng lặp.`,
        });
        const nextFilter = proposalsCreated > 0 ? 'pending' : approvalStatusFilter;
        if (nextFilter !== approvalStatusFilter) {
          setApprovalStatusFilter(nextFilter);
        }
        await loadApprovals(nextFilter);
      } catch (err) {
        setNotice({
          type: 'error',
          text: err?.response?.data?.errors?.[0]?.message || err?.message || 'Quét cảnh báo chủ động thất bại.',
        });
      } finally {
        setTriageScanning(false);
      }
    };

    const handleBootstrap = async () => {
      if (!api?.request) return;
      setBusy(true);
      setNotice(null);
      try {
        const origin = typeof window !== 'undefined' && window.location ? window.location.origin : undefined;
        const res = await api.request({ url: 'dxosAi:bootstrapDefaults', method: 'post', data: { defaultOrigin: origin } });
        const d = res?.data?.data || res?.data || {};
        setNotice({
          type: 'ok',
          text: `Đã đồng bộ ${d.bootstrappedCount || 5} Starter AI Blueprints + dxos-it-ot-mcp${d.llm?.skipped ? ' (bỏ qua local-9router do chưa có AGENT_API_KEY)' : ' + local-9router'}.`,
        });
        await loadAll();
      } catch (err) {
        setNotice({ type: 'error', text: err?.response?.data?.errors?.[0]?.message || err?.message || 'Bootstrap thất bại.' });
      } finally {
        setBusy(false);
      }
    };

    const handleSaveProfile = async (e) => {
      if (e?.preventDefault) e.preventDefault();
      if (!api?.request) return;
      let mcpServers = [];
      let quickPrompts = [];
      try {
        mcpServers = JSON.parse(mcpText || '[]');
        quickPrompts = JSON.parse(promptsText || '[]');
      } catch {
        setNotice({ type: 'error', text: 'JSON của MCP Connectors hoặc Quick Prompts không hợp lệ.' });
        return;
      }
      setBusy(true);
      setNotice(null);
      try {
        const origin = typeof window !== 'undefined' && window.location ? window.location.origin : undefined;
        const modelParts = customModelText.trim()
          ? parseModelSelection(customModelText)
          : { llmService: draft.llmService, modelName: draft.modelName };
        const payloadDraft = customModelText.includes(':') && customModelText.split(':')[1]?.trim()
          ? { ...draft, ...modelParts }
          : draft;
        const res = await api.request({
          url: 'dxosAi:saveProfile',
          method: 'post',
          data: { ...payloadDraft, mcpServers, quickPrompts, defaultOrigin: origin },
        });
        const saved = res?.data?.data?.profile || res?.data?.profile;
        setNotice({ type: 'ok', text: `Đã lưu & đồng bộ 2 chiều "${saved?.username || draft.username}" xuống NocoBase aiEmployees.` });
        await loadAll();
      } catch (err) {
        setNotice({ type: 'error', text: err?.response?.data?.errors?.[0]?.message || err?.message || 'Lưu hồ sơ AI thất bại.' });
      } finally {
        setBusy(false);
      }
    };

    const handleDeleteProfile = async (username) => {
      if (!api?.request || !username) return;
      setBusy(true);
      try {
        await api.request({ url: 'dxosAi:deleteProfile', method: 'post', data: { username } });
        setNotice({ type: 'ok', text: `Đã xóa nhân sự AI "${username}".` });
        await loadAll();
      } catch (err) {
        setNotice({ type: 'error', text: err?.response?.data?.errors?.[0]?.message || err?.message || 'Xóa thất bại.' });
      } finally {
        setBusy(false);
      }
    };

    const tabItems = [
      ['topology', '1. Hệ điều hành 6 Phân hệ'],
      ['workforce', '2. Quản trị Nhân sự AI Động'],
      ['mcp', '3. Cổng Enterprise MCP 2 Chiều'],
      ['audit', '4. Nhật ký Kiểm toán'],
      ['quota', '5. Hạn mức & Chi phí AI'],
      ['hitl', '6. Duyệt AI (HITL)'],
    ];

    const availableTools = Array.isArray(catalog?.availableTools) ? catalog.availableTools : DEFAULT_TOOL_NAMES;
    const roleOptions = Array.isArray(catalog?.roleOptions) ? catalog.roleOptions : DEFAULT_ROLE_OPTIONS;
    const runtimeVersion = resolveTopologyRuntimeVersion(topology, app);
    const isPresetModel = MODEL_PRESETS.includes(customModelText);
    const discoveredOrgOptions = [
      topology?.defaultOrganizationId,
      ...(Array.isArray(topology?.organizations) ? topology.organizations : []),
      catalog?.defaultOrganizationId,
      ...(Array.isArray(catalog?.organizations) ? catalog.organizations : []),
      ...(profiles || []).map((p) => p?.organizationId),
    ].map((o) => String(o || '').trim()).filter((o) => o && o.toLowerCase() !== 'all');
    const orgOptions = [...new Set([...discoveredOrgOptions, ...(discoveredOrgOptions.length ? [] : [quotaOrg])].filter(Boolean))];
    const dayUsage = quotaSummary?.dayUsage || quotaSummary?.usage || {};
    const limits = quotaSummary?.limits || {};
    const allTimeTotals = quotaSummary?.allTimeTotals || quotaSummary?.auditTotals || {};

    if (forbidden) {
      return h('div', {
        'data-testid': 'dxos-ai-studio-forbidden',
        style: { padding: 24, maxWidth: 720, margin: '24px auto', borderRadius: 12, border: '1px solid #fecaca', background: '#fef2f2', color: '#991b1b' },
      },
        h('h2', { style: { margin: '0 0 8px', fontSize: 18 } }, '403 — Chỉ Quản trị viên mới truy cập được DX-OS AI Studio'),
        h('p', { style: { margin: 0, fontSize: 13 } }, 'Tài khoản hiện tại không có quyền quản trị nhân sự AI và cổng Enterprise MCP.'),
      );
    }

    return h('div', {
      'data-testid': 'dxos-ai-studio-page',
      style: { maxWidth: 1180, margin: '0 auto', padding: 24, display: 'grid', gap: 16 },
    },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, alignItems: 'center' } },
        h('div', null,
          h('h1', { style: { margin: '0 0 6px', fontSize: 22, fontWeight: 700, color: '#0f172a' } },
            'DX-OS AI Workforce & 2-Way Enterprise MCP Studio'),
          h('p', { style: { margin: 0, color: '#475569', fontSize: 13 } },
            `Điều phối hệ điều hành doanh nghiệp 6 phân hệ LatticeDX — NocoBase ${runtimeVersion} đóng vai trò Plane #6 (appDataSubstrate), Powered by NocoBase (https://www.nocobase.com).`),
        ),
        h('div', { style: { display: 'flex', gap: 8 } },
          h('button', { type: 'button', onClick: handleBootstrap, disabled: busy, style: btnStyle(true) },
            busy ? 'Đang đồng bộ…' : 'Cài 5 Starter Blueprints & IT/OT MCP'),
          h('button', {
            type: 'button',
            onClick: async () => {
              await loadAll();
              if (!clientDenied && !forbidden) {
                await loadQuota(quotaOrg);
                if (tab === 'hitl') await loadApprovals(approvalStatusFilter);
              }
            },
            disabled: loading || busy || quotaLoading || approvalsLoading,
            style: btnStyle(false),
          }, 'Làm mới'),
        ),
      ),

      notice ? h('div', {
        style: {
          padding: '10px 14px', borderRadius: 8, fontSize: 13,
          border: `1px solid ${notice.type === 'error' ? '#fca5a5' : '#86efac'}`,
          background: notice.type === 'error' ? '#fef2f2' : '#f0fdf4',
          color: notice.type === 'error' ? '#991b1b' : '#166534',
        },
      }, notice.text) : null,

      h('div', { role: 'tablist', style: { display: 'flex', gap: 8, borderBottom: '1px solid #e2e8f0', paddingBottom: 10, overflowX: 'auto' } },
        tabItems.map(([key, label]) => h('button', {
          key,
          type: 'button',
          role: 'tab',
          'aria-selected': tab === key,
          onClick: () => setTab(key),
          style: { ...btnStyle(tab === key), whiteSpace: 'nowrap', flexShrink: 0 },
        }, label)),
      ),

      tab === 'topology' ? h('div', { style: { display: 'grid', gap: 12 } },
        h('div', { style: { padding: 14, borderRadius: 10, background: '#f8fafc', border: '1px solid #e2e8f0', fontSize: 13, color: '#334155' } },
          topology?.positioningStatement || `LatticeDX điều phối đồng bộ 6 phân hệ Enterprise Digital OS; NocoBase ${runtimeVersion} là phân hệ lưu trữ & metadata (Plane #6).`),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12 } },
          (topology?.planes || []).map((p) => h('div', {
            key: p.key,
            style: { padding: 16, borderRadius: 12, border: p.key === 'aiWorkforceAndMcp' ? '2px solid #0284c7' : '1px solid #e2e8f0', background: '#fff', display: 'grid', gap: 8 },
          },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 } },
              h('strong', { style: { fontSize: 14, color: '#0f172a' } }, `Plane #${p.order}: ${p.name}`),
              h('span', { style: badgeStyle(p.healthy ? '#dcfce7' : '#fef3c7', p.healthy ? '#166534' : '#92400e') }, p.healthy ? 'Sẵn sàng' : 'Chờ kết nối'),
            ),
            h('div', { style: { fontSize: 12, color: '#475569' } }, (p.technologies || []).join(' · ')),
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
              formatMetricEntries(p.metrics).map((m) => h('span', {
                key: m.key,
                style: {
                  padding: '2px 8px',
                  borderRadius: 6,
                  background: '#f1f5f9',
                  border: '1px solid #e2e8f0',
                  fontSize: 11,
                  color: '#334155',
                },
              }, `${m.key}: ${m.value}`)),
            ),
          )),
        ),
      ) : null,

      tab === 'workforce' ? h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(280px, 1fr) minmax(380px, 1.4fr)', gap: 16, alignItems: 'start' } },
        h('div', { style: { display: 'grid', gap: 10 } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
            h('strong', { style: { fontSize: 15 } }, `Nhân sự AI (${profiles.length})`),
            h('button', { type: 'button', onClick: () => selectDraft(createEmptyProfileDraft(resolveStudioDefaultOrg({ topology, catalog, profiles, app }))), style: btnStyle(false) }, '+ Tạo mới'),
          ),
          profiles.map((p) => h('div', {
            key: p.username,
            style: { padding: 12, borderRadius: 10, border: '1px solid #e2e8f0', background: '#fff', display: 'grid', gap: 6 },
          },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 } },
              h('div', null,
                h('strong', { style: { fontSize: 14 } }, p.nickname),
                h('div', { style: { fontSize: 11, color: '#64748b' } }, `@${p.username} · ${p.position || p.departmentScope}`),
              ),
              p.isAdminBuilder ? h('span', { style: badgeStyle('#fef3c7', '#92400e') }, 'Admin Builder') : h('span', { style: badgeStyle('#e0f2fe', '#075985') }, 'Nhân sự AI'),
            ),
            h('div', { style: { fontSize: 11, color: '#475569' } }, `Roles: ${(p.allowedRoles || []).join(', ') || '—'} · Portals: ${(p.portalBindings || []).join(', ') || '—'}`),
            h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
              h('button', { type: 'button', onClick: () => selectDraft(p), style: btnStyle(false) }, 'Chỉnh sửa'),
              h('button', { type: 'button', onClick: () => selectDraft(buildProfileDraftFromStarter(p)), style: btnStyle(false) }, 'Nhân bản'),
              h('button', { type: 'button', onClick: () => handleDeleteProfile(p.username), style: btnStyle(false, true) }, 'Xóa'),
            ),
          )),
        ),

        h('form', {
          onSubmit: handleSaveProfile,
          style: { padding: 16, borderRadius: 12, border: '1px solid #e2e8f0', background: '#fff', display: 'grid', gap: 10 },
        },
          h('strong', { style: { fontSize: 15 } }, `Biên tập Nhân sự AI: ${draft.username || '(tạo mới)'}`),
          h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 } },
            h('label', { style: { fontSize: 12, display: 'grid', gap: 4 } }, 'Slug định danh (username)',
              h('input', { value: draft.username, onChange: (e) => setDraft({ ...draft, username: e.target.value }), placeholder: 'vd: hr-ops-ai', style: { padding: 6, borderRadius: 6, border: '1px solid #cbd5e1' } })),
            h('label', { style: { fontSize: 12, display: 'grid', gap: 4 } }, 'Tên hiển thị (nickname)',
              h('input', { value: draft.nickname, onChange: (e) => setDraft({ ...draft, nickname: e.target.value }), placeholder: 'Trợ lý Nhân sự AI', style: { padding: 6, borderRadius: 6, border: '1px solid #cbd5e1' } })),
            h('label', { style: { fontSize: 12, display: 'grid', gap: 4 } }, 'Chức danh / Phân hệ',
              h('input', { value: draft.position, onChange: (e) => setDraft({ ...draft, position: e.target.value }), style: { padding: 6, borderRadius: 6, border: '1px solid #cbd5e1' } })),
            h('label', { style: { fontSize: 12, display: 'grid', gap: 4 } }, 'LLM Service / Model',
              h('select', {
                'data-testid': 'dxos-model-preset-select',
                value: !customModelMode && isPresetModel ? customModelText : '__custom__',
                onChange: (e) => {
                  const v = e.target.value;
                  if (v === '__custom__') {
                    setCustomModelMode(true);
                    return;
                  }
                  setCustomModelMode(false);
                  setCustomModelText(v);
                  const { llmService, modelName } = parseModelSelection(v);
                  setDraft({ ...draft, llmService, modelName });
                },
                style: { padding: 6, borderRadius: 6, border: '1px solid #cbd5e1', background: '#fff' },
              },
                MODEL_PRESETS.map((preset) => h('option', { key: preset, value: preset }, preset)),
                h('option', { value: '__custom__' }, 'Tùy chỉnh (nhập service:model)...'),
              ),
              h('input', {
                'data-testid': 'dxos-model-custom-input',
                value: customModelText,
                onChange: (e) => {
                  const raw = e.target.value;
                  setCustomModelText(raw);
                  setCustomModelMode(!MODEL_PRESETS.includes(raw));
                  const colonIdx = raw.indexOf(':');
                  if (colonIdx >= 0) {
                    const nextService = raw.slice(0, colonIdx).trim();
                    const nextModel = raw.slice(colonIdx + 1).trim();
                    setDraft({
                      ...draft,
                      ...(nextService ? { llmService: nextService } : {}),
                      ...(nextModel ? { modelName: nextModel } : {}),
                    });
                  } else if (raw.trim()) {
                    setDraft({ ...draft, modelName: raw.trim() });
                  }
                },
                placeholder: 'vd: local-9router:ag/gemini-3.8-flash',
                style: { padding: 6, borderRadius: 6, border: '1px solid #cbd5e1' },
              }),
            ),
          ),
          h('label', { style: { fontSize: 12, display: 'grid', gap: 4 } }, 'SOP & System Prompt',
            h('textarea', { rows: 3, value: draft.systemPrompt, onChange: (e) => setDraft({ ...draft, systemPrompt: e.target.value }), style: { padding: 6, borderRadius: 6, border: '1px solid #cbd5e1' } })),
          h('div', { style: { display: 'grid', gap: 4 } },
            h('span', { style: { fontSize: 12, fontWeight: 600 } }, 'Vai trò được phép dùng (Role ACL)'),
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
              roleOptions.map((role) => h('button', {
                key: role,
                type: 'button',
                onClick: () => setDraft({ ...draft, allowedRoles: toggleArrayItem(draft.allowedRoles, role) }),
                style: { ...btnStyle((draft.allowedRoles || []).includes(role)), padding: '3px 8px', fontSize: 11 },
              }, role)),
            ),
          ),
          h('div', { style: { display: 'grid', gap: 4 } },
            h('span', { style: { fontSize: 12, fontWeight: 600 } }, 'Cổng Portal gắn AI Agent Strip'),
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
              DEFAULT_PORTALS.map((slug) => h('button', {
                key: slug,
                type: 'button',
                onClick: () => setDraft({ ...draft, portalBindings: toggleArrayItem(draft.portalBindings, slug) }),
                style: { ...btnStyle((draft.portalBindings || []).includes(slug)), padding: '3px 8px', fontSize: 11 },
              }, `/p/${slug}`)),
            ),
          ),
          h('div', { style: { display: 'grid', gap: 6 } },
            h('span', { style: { fontSize: 12, fontWeight: 600 } }, 'Ma trận quyền Công cụ Unified (ALLOW / ASK / OFF)'),
            availableTools.map((toolName) => h('div', {
              key: toolName,
              style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, padding: '4px 8px', background: '#f8fafc', borderRadius: 6 },
            },
              h('span', null, toolName),
              h('select', {
                value: draft.toolPermissions?.[toolName] || 'OFF',
                onChange: (e) => setDraft({
                  ...draft,
                  toolPermissions: { ...(draft.toolPermissions || {}), [toolName]: e.target.value },
                }),
                style: { padding: '2px 6px', borderRadius: 4, border: '1px solid #cbd5e1', fontSize: 12 },
              },
                h('option', { value: 'OFF' }, 'OFF (Ẩn)'),
                h('option', { value: 'ASK' }, 'ASK (Hỏi xác nhận)'),
                h('option', { value: 'ALLOW' }, 'ALLOW (Tự chạy)'),
              ),
            )),
          ),
          h('label', { style: { fontSize: 12, display: 'grid', gap: 4 } }, 'Kết nối MCP Outbound (JSON)',
            h('textarea', { rows: 3, value: mcpText, onChange: (e) => setMcpText(e.target.value), style: { padding: 6, borderRadius: 6, border: '1px solid #cbd5e1', fontFamily: 'monospace', fontSize: 11 } })),
          h('label', { style: { fontSize: 12, display: 'grid', gap: 4 } }, 'Quick Prompts gắn Block Strip (JSON)',
            h('textarea', { rows: 3, value: promptsText, onChange: (e) => setPromptsText(e.target.value), style: { padding: 6, borderRadius: 6, border: '1px solid #cbd5e1', fontFamily: 'monospace', fontSize: 11 } })),
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, paddingBottom: 76 } },
            h('button', { type: 'submit', disabled: busy, style: btnStyle(true) }, busy ? 'Đang đồng bộ…' : 'Lưu & Đồng bộ 2 Chiều xuống NocoBase'),
          ),
        ),
      ) : null,

      tab === 'mcp' ? h('div', { style: { padding: 18, borderRadius: 12, border: '1px solid #e2e8f0', background: '#fff', display: 'grid', gap: 12 } },
        h('h3', { style: { margin: 0, fontSize: 16 } }, 'Cổng Streamable HTTP MCP 2 Chiều (JSON-RPC 2.0 + User-Context Bearer)'),
        h('div', { style: { fontSize: 13, color: '#334155', display: 'grid', gap: 6 } },
          h('div', null, h('strong', null, 'Inbound Enterprise MCP Gateway: '), h('code', null, '/api/dxos-mcp'), ' — phơi toàn bộ công cụ lọc theo vai trò JWT (Admin Builder ẩn hoàn toàn với non-admin).'),
          h('div', null, h('strong', null, 'IT/OT MCP Endpoint (Outbound loop for AI Employees): '), h('code', null, '/api/dxos-mcp/it-ot'), ' — cung cấp telemetry Orion-LD, timeline sự cố, healthcheck stack & đồng bộ outbox/n8n (timeout 5000ms, degrade an toàn).'),
          h('div', null, h('strong', null, 'MCP Resources: '), h('code', null, 'dxos://topology/planes'), ' và ', h('code', null, 'dxos://itot/health')),
        ),
      ) : null,

      tab === 'audit' ? h('div', { style: { padding: 18, borderRadius: 12, border: '1px solid #e2e8f0', background: '#fff', display: 'grid', gap: 10 } },
        h('h3', { style: { margin: 0, fontSize: 16 } }, `Nhật ký Kiểm toán Thực thi AI & MCP (${auditItems.length} bản ghi gần nhất)`),
        !auditItems.length
          ? h('div', { style: { fontSize: 13, color: '#64748b' } }, 'Chưa có bản ghi kiểm toán nào.')
          : h('div', { style: { display: 'grid', gap: 6 } },
            auditItems.map((item) => h('div', {
              key: item.id,
              style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', padding: '8px 10px', borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 12, gap: 8 },
            },
              h('div', { style: { flex: '1 1 240px', minWidth: 0, overflowWrap: 'anywhere', wordBreak: 'break-word' } },
                h('strong', null, item.toolName),
                ` · ${item.channel} · actor=${item.actorUsername || item.actorUserId || 'anon'} · ${item.resultSummary || ''}`,
              ),
              h('span', { style: { ...badgeStyle(item.status === 'allowed' ? '#dcfce7' : '#fee2e2', item.status === 'allowed' ? '#166534' : '#991b1b'), whiteSpace: 'nowrap', flexShrink: 0 } },
                `${item.status}${item.errorCode ? ` (${item.errorCode})` : ''}`),
            )),
          ),
      ) : null,

      tab === 'quota' ? h('div', {
        'data-testid': 'dxos-ai-quota-tab',
        style: { padding: 18, borderRadius: 12, border: '1px solid #e2e8f0', background: '#fff', display: 'grid', gap: 14 },
      },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 } },
          h('div', null,
            h('h3', { style: { margin: '0 0 4px', fontSize: 16 } }, '5. Hạn mức & Chi phí AI theo Tổ chức (Bền vững DB)'),
            h('div', { style: { fontSize: 12, color: '#64748b' } },
              `Ngày UTC: ${quotaSummary?.day || new Date().toISOString().slice(0, 10)} · Tổ chức: ${quotaSummary?.organizationId || quotaOrg}${quotaLoading ? ' · Đang tải…' : ''}`),
          ),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            h('select', {
              'data-testid': 'dxos-quota-org-select',
              value: quotaOrg,
              onChange: (e) => commitQuotaOrg(e.target.value),
              style: { padding: '6px 8px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 12, background: '#fff' },
            }, orgOptions.map((org) => h('option', { key: org, value: org }, org))),
            h('input', {
              'data-testid': 'dxos-quota-org-input',
              value: quotaOrgDraft,
              onChange: (e) => setQuotaOrgDraft(e.target.value),
              onKeyDown: (e) => {
                if (e && e.key === 'Enter') {
                  e.preventDefault?.();
                  commitQuotaOrg(quotaOrgDraft);
                }
              },
              placeholder: 'Mã tổ chức',
              style: { padding: '6px 8px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 12, width: 140 },
            }),
            h('button', {
              type: 'button',
              onClick: () => commitQuotaOrg(quotaOrgDraft),
              style: btnStyle(false),
            }, 'Xem hạn mức'),
          ),
        ),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 } },
          renderProgressBar(
            'Lượt gọi AI hôm nay (Calls)',
            dayUsage.calls || 0,
            limits.orgDailyCalls || 5000,
            String(dayUsage.calls || 0),
            String(limits.orgDailyCalls || 5000),
          ),
          renderProgressBar(
            'Token tiêu thụ hôm nay (Tokens)',
            dayUsage.tokens || 0,
            limits.orgDailyTokens || 5_000_000,
            String(dayUsage.tokens || 0),
            String(limits.orgDailyTokens || 5_000_000),
          ),
          renderProgressBar(
            'Chi phí ước tính hôm nay (Cost USD)',
            dayUsage.costUsd || 0,
            limits.orgDailyUsd || 50,
            `$${Number(dayUsage.costUsd || 0).toFixed(6)}`,
            `$${Number(limits.orgDailyUsd || 50)}`,
          ),
        ),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 } },
          h('div', { style: { padding: 12, borderRadius: 10, border: '1px solid #e2e8f0', background: '#f8fafc' } },
            h('div', { style: { fontSize: 11, color: '#64748b' } }, 'PII đã ẩn danh hôm nay'),
            h('strong', { style: { fontSize: 18, color: '#0f172a' } }, String(dayUsage.piiRedacted || 0)),
          ),
          h('div', { style: { padding: 12, borderRadius: 10, border: '1px solid #e2e8f0', background: '#f8fafc' } },
            h('div', { style: { fontSize: 11, color: '#64748b' } }, 'Người dùng AI hoạt động hôm nay'),
            h('strong', { style: { fontSize: 18, color: '#0f172a' } }, String(dayUsage.activeUsers || 0)),
          ),
          h('div', { style: { padding: 12, borderRadius: 10, border: '1px solid #e2e8f0', background: '#f8fafc' } },
            h('div', { style: { fontSize: 11, color: '#64748b' } }, 'Giới hạn lượt / User / ngày'),
            h('strong', { style: { fontSize: 18, color: '#0f172a' } }, String(limits.userDailyCalls || 500)),
          ),
        ),
        h('div', { style: { padding: 14, borderRadius: 10, border: '1px solid #e2e8f0', background: '#f8fafc', display: 'grid', gap: 8 } },
          h('strong', { style: { fontSize: 13, color: '#0f172a' } }, 'Tổng tích lũy kiểm toán toàn thời gian (Lifetime Audit Totals)'),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 12, color: '#334155' } },
            h('span', { style: { padding: '3px 8px', borderRadius: 6, background: '#fff', border: '1px solid #e2e8f0' } },
              `Bản ghi kiểm toán: ${allTimeTotals.records || 0}`),
            h('span', { style: { padding: '3px 8px', borderRadius: 6, background: '#fff', border: '1px solid #e2e8f0' } },
              `Prompt Tokens: ${allTimeTotals.promptTokens || 0}`),
            h('span', { style: { padding: '3px 8px', borderRadius: 6, background: '#fff', border: '1px solid #e2e8f0' } },
              `Completion Tokens: ${allTimeTotals.completionTokens || 0}`),
            h('span', { style: { padding: '3px 8px', borderRadius: 6, background: '#fff', border: '1px solid #e2e8f0' } },
              `Tổng Chi phí USD: $${Number(allTimeTotals.estimatedCostUsd || 0).toFixed(6)}`),
            h('span', { style: { padding: '3px 8px', borderRadius: 6, background: '#fff', border: '1px solid #e2e8f0' } },
              `Tổng PII đã che: ${allTimeTotals.piiRedactedCount || 0}`),
          ),
        ),
      ) : null,

      tab === 'hitl' ? h('div', {
        'data-testid': 'dxos-ai-hitl-tab',
        style: { padding: 18, borderRadius: 12, border: '1px solid #e2e8f0', background: '#fff', display: 'grid', gap: 14 },
      },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 } },
          h('div', null,
            h('h3', { style: { margin: '0 0 4px', fontSize: 16 } }, '6. Hàng chờ Phê duyệt Tác vụ AI (Human-in-the-Loop)'),
            h('div', { style: { fontSize: 12, color: '#64748b' } },
              `Hiển thị ${approvals.length} yêu cầu (${approvalStatusFilter})${approvalsLoading ? ' · Đang tải…' : ''}`),
          ),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            h('button', {
              type: 'button',
              'data-testid': 'dxos-ai-triage-scan-btn',
              onClick: handleTriageScan,
              disabled: triageScanning || approvalsLoading,
              style: btnStyle(true, false),
            }, triageScanning ? 'Đang quét cảnh báo…' : 'Quét Cảnh báo Chủ động (Proactive Triage)'),
            h('select', {
              'data-testid': 'dxos-hitl-status-filter',
              value: approvalStatusFilter,
              onChange: (e) => setApprovalStatusFilter(e.target.value),
              style: { padding: '6px 8px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 12, background: '#fff' },
            },
              h('option', { value: 'pending' }, 'Chờ duyệt (pending)'),
              h('option', { value: 'executed' }, 'Đã thực thi (executed)'),
              h('option', { value: 'rejected' }, 'Đã từ chối (rejected)'),
              h('option', { value: 'expired' }, 'Hết hạn (expired)'),
              h('option', { value: 'all' }, 'Tất cả trạng thái'),
            ),
            h('button', {
              type: 'button',
              onClick: () => loadApprovals(approvalStatusFilter),
              disabled: approvalsLoading || triageScanning,
              style: btnStyle(false),
            }, 'Tải lại hàng chờ'),
          ),
        ),
        !approvals.length
          ? h('div', { style: { padding: 20, textAlign: 'center', borderRadius: 10, border: '1px dashed #cbd5e1', color: '#64748b', fontSize: 13 } },
            'Không có yêu cầu AI nào trong hàng chờ phê duyệt.')
          : h('div', { style: { display: 'grid', gap: 12 } },
            approvals.map((item) => {
              const risk = String(item.riskLevel || 'medium').toLowerCase();
              const riskBg = risk === 'critical' || risk === 'high' ? '#fee2e2' : risk === 'low' ? '#dcfce7' : '#fef3c7';
              const riskFg = risk === 'critical' || risk === 'high' ? '#991b1b' : risk === 'low' ? '#166534' : '#92400e';
              const statusBg = item.status === 'executed' ? '#dcfce7' : item.status === 'pending' ? '#e0f2fe' : '#fee2e2';
              const statusFg = item.status === 'executed' ? '#166534' : item.status === 'pending' ? '#075985' : '#991b1b';
              const changes = Array.isArray(item.diffPreview?.changes) ? item.diffPreview.changes : [];
              const diffSummary = typeof item.diffPreview?.summary === 'string' ? item.diffPreview.summary.trim() : '';
              const affectedLots = Array.isArray(item.diffPreview?.affectedLots) ? item.diffPreview.affectedLots : [];
              const downstreamOrders = Array.isArray(item.diffPreview?.downstreamOrders) ? item.diffPreview.downstreamOrders : [];
              const rowBusy = approvalBusyId === item.id;
              return h('div', {
                key: item.id,
                'data-testid': `dxos-hitl-card-${item.id}`,
                style: { padding: 14, borderRadius: 10, border: '1px solid #e2e8f0', background: '#f8fafc', display: 'grid', gap: 10 },
              },
                h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 } },
                  h('div', { style: { fontSize: 14, color: '#0f172a' } },
                    h('strong', null, `#${item.id} · ${item.targetCollection}`),
                    ` (${item.operation}${item.targetRecordId != null ? ` #${item.targetRecordId}` : ''}) · `,
                    h('code', null, item.toolName),
                  ),
                  h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                    h('span', { style: badgeStyle(riskBg, riskFg) }, `Rủi ro: ${risk}`),
                    h('span', { style: badgeStyle(statusBg, statusFg) }, item.status),
                  ),
                ),
                h('div', { style: { fontSize: 12, color: '#475569' } },
                  `Người yêu cầu: ${item.requesterUsername || `#${item.requesterUserId}`} · AI: ${item.aiEmployee || '—'} · Tổ chức: ${item.organizationId}`),
                h('div', {
                  'data-testid': `dxos-hitl-diff-${item.id}`,
                  style: { padding: 10, borderRadius: 8, border: '1px solid #e2e8f0', background: '#fff', fontSize: 12, display: 'grid', gap: 6 },
                },
                  h('strong', { style: { fontSize: 11, color: '#334155', textTransform: 'uppercase' } }, 'Xem trước thay đổi (diffPreview)'),
                  diffSummary ? h('div', {
                    'data-testid': `dxos-hitl-summary-${item.id}`,
                    style: { padding: '6px 8px', borderRadius: 6, background: '#f8fafc', border: '1px solid #e2e8f0', color: '#0f172a', fontSize: 12 },
                  }, diffSummary) : null,
                  (affectedLots.length || downstreamOrders.length) ? h('div', {
                    'data-testid': `dxos-hitl-affected-lots-${item.id}`,
                    style: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' },
                  },
                    affectedLots.map((lot, idx) => {
                      const label = typeof lot === 'string'
                        ? lot
                        : `${lot?.lotCode || lot?.code || `#${lot?.id || idx + 1}`}${lot?.sku ? ` (${lot.sku})` : ''}`;
                      return h('span', {
                        key: `lot-${lot?.id ?? lot?.lotCode ?? idx}`,
                        style: badgeStyle('#fef3c7', '#92400e'),
                      }, `Lô: ${label}`);
                    }),
                    downstreamOrders.map((ord, idx) => {
                      const label = typeof ord === 'string'
                        ? ord
                        : (ord?.orderCode || ord?.code || `#${ord?.orderId || idx + 1}`);
                      return h('span', {
                        key: `ord-${ord?.orderId ?? ord?.orderCode ?? idx}`,
                        style: badgeStyle('#e0f2fe', '#075985'),
                      }, `Đơn: ${label}`);
                    }),
                  ) : null,
                  changes.length
                    ? changes.map((ch, idx) => h('div', {
                      key: ch?.field || idx,
                      style: { display: 'flex', flexWrap: 'wrap', gap: 6, fontFamily: 'monospace', fontSize: 11, color: '#0f172a' },
                    },
                      h('strong', null, `${ch.field}:`),
                      h('span', { style: { color: '#b91c1c' } }, JSON.stringify(ch.before)),
                      h('span', null, '→'),
                      h('span', { style: { color: '#15803d' } }, JSON.stringify(ch.after)),
                    ))
                    : h('pre', { style: { margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 11 } },
                      JSON.stringify(item.diffPreview || item.proposedArgs || {}, null, 2)),
                ),
                item.status === 'pending'
                  ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' } },
                    h('input', {
                      'data-testid': `dxos-hitl-note-${item.id}`,
                      value: approvalNotes[item.id] || '',
                      onChange: (e) => setApprovalNotes((prev) => ({ ...prev, [item.id]: e.target.value })),
                      placeholder: 'Ghi chú phê duyệt hoặc lý do từ chối (>= 3 ký tự)...',
                      style: { flex: '1 1 260px', padding: '6px 10px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 12, background: '#fff' },
                    }),
                    h('button', {
                      type: 'button',
                      'data-testid': `dxos-hitl-approve-${item.id}`,
                      onClick: () => handleDecideApproval(item, 'approve'),
                      disabled: rowBusy,
                      style: btnStyle(true, false),
                    }, rowBusy ? 'Đang xử lý…' : 'Phê duyệt & Thực thi'),
                    h('button', {
                      type: 'button',
                      'data-testid': `dxos-hitl-reject-${item.id}`,
                      onClick: () => handleDecideApproval(item, 'reject'),
                      disabled: rowBusy,
                      style: btnStyle(false, true),
                    }, 'Từ chối'),
                  )
                  : h('div', { style: { fontSize: 12, color: '#475569' } },
                    `Người xử lý: ${item.decidedByUsername || '—'}${item.decisionNote ? ` · Ghi chú: ${item.decisionNote}` : ''}`),
              );
            }),
          ),
      ) : null,
    );
  };
}

module.exports = {
  DEFAULT_TOOL_NAMES,
  DEFAULT_ROLE_OPTIONS,
  MODEL_PRESETS,
  createDxosAiStudioPage,
  buildProfileDraftFromStarter,
  createEmptyProfileDraft,
  resolveStudioDefaultOrg,
  parseToolModeMap,
  parseModelSelection,
  resolveTopologyRuntimeVersion,
  formatMetricEntries,
};
