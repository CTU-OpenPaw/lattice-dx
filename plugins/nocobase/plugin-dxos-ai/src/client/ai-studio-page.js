/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { deriveErGraphFromSpec, renderErGraphPanel } = require('./er-graph-panel');
const { AiTraceWaterfallPanel, AiEvalLabPanel } = require('./ai-trace-eval-panel');

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
  'dxos_memory_remember',
  'dxos_memory_recall',
  'dxos_memory_forget',
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

const QUICK_CONNECT_PROVIDER_DEFAULTS = {
  openai: {
    label: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    modelName: 'gpt-4o-mini',
  },
  'openai-completions': {
    label: 'OpenAI-compatible / 9router',
    baseURL: 'http://127.0.0.1:20128/v1',
    modelName: 'ag/gemini-3.8-flash',
  },
  'google-genai': {
    label: 'Google Gemini',
    baseURL: 'https://generativelanguage.googleapis.com',
    modelName: 'gemini-2.5-flash',
  },
  anthropic: {
    label: 'Anthropic Claude',
    baseURL: 'https://api.anthropic.com/v1',
    modelName: 'claude-3-5-sonnet-latest',
  },
  deepseek: {
    label: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    modelName: 'deepseek-chat',
  },
  ollama: {
    label: 'Ollama (Local)',
    baseURL: 'http://127.0.0.1:11434',
    modelName: 'llama3.1',
  },
};

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

const PLANE_METRIC_LABELS = {
  rolesCount: 'Số vai trò',
  assetsCount: 'Tài sản số',
  outboxPending: 'Hàng chờ Outbox',
  activeWorkflowsCount: 'Luồng tự động hóa hoạt động',
  layoutCount: 'Bố cục cổng',
  paraDocumentsCount: 'Tài liệu P.A.R.A.',
  activeAiProfilesCount: 'Nhân sự AI hoạt động',
  auditLogsCount: 'Bản ghi kiểm toán',
  collectionsCount: 'Bảng dữ liệu',
};

const HITL_RISK_LABELS = {
  critical: 'Nghiêm trọng',
  high: 'Cao',
  medium: 'Trung bình',
  low: 'Thấp',
};

const HITL_STATUS_LABELS = {
  pending: 'Chờ duyệt',
  executed: 'Đã thực thi',
  approved: 'Đã duyệt',
  rejected: 'Đã từ chối',
  expired: 'Hết hạn',
};

const AUDIT_STATUS_LABELS = {
  allowed: 'Cho phép',
  denied: 'Từ chối',
  degraded: 'Suy giảm',
  error: 'Lỗi',
};

const BUILT_APP_QUICKSTART_PRESETS = [
  {
    key: 'clinic',
    title: 'Phòng khám Đa khoa',
    subtitle: 'Bệnh nhân · Khám bệnh · Đơn thuốc (Công thức) · Biểu đồ BI',
    prompt: 'Tạo ứng dụng Quản lý Phòng khám Đa khoa gồm Bệnh nhân, Phiếu Khám bệnh, Đơn thuốc (có công thức thành tiền), phân quyền Nhân viên Phòng khám và biểu đồ BI lượt khám',
  },
  {
    key: 'crm',
    title: 'CRM Bán hàng B2B',
    subtitle: 'Khách hàng · Cơ hội Kanban · Doanh thu kỳ vọng · Biểu đồ BI',
    prompt: 'Tạo ứng dụng CRM Bán hàng B2B gồm Khách hàng Doanh nghiệp, Cơ hội Kinh doanh (Pipeline Kanban + công thức doanh thu kỳ vọng), phân quyền Kinh doanh B2B và biểu đồ BI doanh số',
  },
  {
    key: 'itsm',
    title: 'ITSM Hỗ trợ Nội bộ',
    subtitle: 'Tài sản IT · Phiếu Yêu cầu SLA · Hàng chờ · Biểu đồ BI',
    prompt: 'Tạo ứng dụng ITSM Hỗ trợ Nội bộ gồm Tài sản Thiết bị IT, Phiếu Yêu cầu ITSM (độ ưu tiên, SLA), phân quyền Kỹ thuật viên ITSM và biểu đồ BI phân bố ưu tiên',
  },
];

function formatMetricEntries(metrics) {
  if (!metrics || typeof metrics !== 'object') return [];
  return Object.entries(metrics).map(([key, value]) => ({
    key,
    label: PLANE_METRIC_LABELS[key] || key,
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
    const [qcProvider, setQcProvider] = React.useState('openai');
    const [qcApiKey, setQcApiKey] = React.useState('');
    const [qcBaseUrl, setQcBaseUrl] = React.useState(QUICK_CONNECT_PROVIDER_DEFAULTS.openai.baseURL);
    const [qcModelName, setQcModelName] = React.useState(QUICK_CONNECT_PROVIDER_DEFAULTS.openai.modelName);
    const [qcBusy, setQcBusy] = React.useState(false);
    const [llmHealth, setLlmHealth] = React.useState(null);
    const [llmHealthBusy, setLlmHealthBusy] = React.useState(false);
    const quotaReqSeqRef = typeof React.useRef === 'function'
      ? React.useRef(0)
      : (typeof React.useMemo === 'function' ? React.useMemo(() => ({ current: 0 }), []) : { current: 0 });
    const hitlReqSeqRef = typeof React.useRef === 'function'
      ? React.useRef(0)
      : (typeof React.useMemo === 'function' ? React.useMemo(() => ({ current: 0 }), []) : { current: 0 });
    const quotaOrgCommittedRef = typeof React.useRef === 'function'
      ? React.useRef(false)
      : (typeof React.useMemo === 'function' ? React.useMemo(() => ({ current: false }), []) : { current: false });
    const [builtApps, setBuiltApps] = React.useState([]);
    const [builtAppsLoading, setBuiltAppsLoading] = React.useState(false);
    const [builtAppBusyKey, setBuiltAppBusyKey] = React.useState(null);
    const [builtAppSelected, setBuiltAppSelected] = React.useState(null);
    const [builtAppBundlePreview, setBuiltAppBundlePreview] = React.useState(null);
    const [builtAppVerifyResults, setBuiltAppVerifyResults] = React.useState({});
    const builtAppsReqSeqRef = typeof React.useRef === 'function'
      ? React.useRef(0)
      : (typeof React.useMemo === 'function' ? React.useMemo(() => ({ current: 0 }), []) : { current: 0 });
    const [builtAppPlanOpenKey, setBuiltAppPlanOpenKey] = React.useState(null);
    const [builtAppPlanInputs, setBuiltAppPlanInputs] = React.useState({});
    const [builtAppPlanResults, setBuiltAppPlanResults] = React.useState({});
    const [builtAppVersionsMap, setBuiltAppVersionsMap] = React.useState({});
    const [builtAppVersionsOpenKey, setBuiltAppVersionsOpenKey] = React.useState(null);
    const [erSelectedNode, setErSelectedNode] = React.useState(null);
    const [erSelectedEdge, setErSelectedEdge] = React.useState(null);
    const [auditSearch, setAuditSearch] = React.useState('');
    const [auditStatusFilter, setAuditStatusFilter] = React.useState('all');
    const [auditAgentFilter, setAuditAgentFilter] = React.useState('all');
    const [quotaOrgCustomMode, setQuotaOrgCustomMode] = React.useState(false);
    const [quickStartPrompt, setQuickStartPrompt] = React.useState('');
    const [quickStartPlan, setQuickStartPlan] = React.useState(null);
    const [quickStartBusy, setQuickStartBusy] = React.useState(false);

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

        const [tRes, aRes, hRes] = await Promise.allSettled([
          api.request({ url: 'dxosAi:enterpriseTopology', method: 'get' }),
          api.request({ url: 'dxosAi:auditLogs', method: 'get', params: { pageSize: 40 } }),
          api.request({ url: 'dxosAi:checkLlmHealth', method: 'get', skipNotify: true }),
        ]);
        let loadedTopology = null;
        if (tRes.status === 'fulfilled') {
          loadedTopology = tRes.value?.data?.data || tRes.value?.data || null;
          setTopology(loadedTopology);
        }
        if (hRes.status === 'fulfilled') {
          const hData = hRes.value?.data?.data || hRes.value?.data || null;
          if (hData && typeof hData === 'object' && Object.hasOwn(hData, 'ok')) {
            setLlmHealth(hData);
          }
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

    const resolvedBuiltAppsDefaultOrg = resolveStudioDefaultOrg({ topology, catalog, profiles, app });
    const loadBuiltApps = React.useCallback(async () => {
      if (clientDenied || !api?.request) return;
      const reqSeq = ++builtAppsReqSeqRef.current;
      setBuiltAppsLoading(true);
      try {
        const targetOrg = String(quotaOrg || resolvedBuiltAppsDefaultOrg || '').trim();
        const res = await api.request({
          url: 'dxosAi:listBuiltApps',
          method: 'get',
          params: targetOrg ? { organizationId: targetOrg } : {},
        });
        if (reqSeq !== builtAppsReqSeqRef.current) return;
        const data = res?.data?.data || res?.data || {};
        const nextApps = Array.isArray(data.apps) ? data.apps : [];
        setBuiltApps((prev) => nextApps.map((na) => {
          const existing = prev.find((p) => p.appKey === na.appKey);
          return (existing && (Number(existing.version) || 0) > (Number(na.version) || 0)) ? existing : na;
        }));
        setBuiltAppSelected((prev) => {
          if (!prev) return null;
          const fresh = nextApps.find((a) => a.appKey === prev.appKey);
          if (!fresh) return prev;
          return (Number(fresh.version) || 0) >= (Number(prev.version) || 0) ? fresh : prev;
        });
      } catch (err) {
        if (reqSeq !== builtAppsReqSeqRef.current) return;
        setNotice({ type: 'error', text: err?.response?.data?.errors?.[0]?.message || err?.message || 'Không tải được danh sách ứng dụng đã dựng.' });
      } finally {
        if (reqSeq === builtAppsReqSeqRef.current) {
          setBuiltAppsLoading(false);
        }
      }
    }, [api, clientDenied, quotaOrg, resolvedBuiltAppsDefaultOrg]);

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
      if (tab === 'built-apps' && !clientDenied && !forbidden) {
        loadBuiltApps();
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
          text: `Đã đồng bộ ${d.bootstrappedCount || 7} Starter AI Blueprints + dxos-it-ot-mcp${d.llm?.skipped ? ' (bỏ qua local-9router do chưa có AGENT_API_KEY)' : ' + local-9router'}.`,
        });
        await loadAll();
      } catch (err) {
        setNotice({ type: 'error', text: err?.response?.data?.errors?.[0]?.message || err?.message || 'Bootstrap thất bại.' });
      } finally {
        setBusy(false);
      }
    };

    const handleCheckLlmHealth = async () => {
      if (!api?.request || llmHealthBusy) return;
      setLlmHealthBusy(true);
      try {
        const res = await api.request({
          url: 'dxosAi:checkLlmHealth',
          method: 'get',
          params: { verifyCompletion: '1' },
          skipNotify: true,
        });
        const d = res?.data?.data || res?.data || null;
        setLlmHealth(d);
        if (d) {
          setNotice({
            type: d.ok ? 'ok' : 'error',
            text: d.message || (d.ok ? 'Kết nối LLM sẵn sàng.' : 'Kết nối LLM chưa sẵn sàng.'),
          });
        }
      } catch (err) {
        const msg = err?.response?.data?.errors?.[0]?.message || err?.message || 'Kiểm tra kết nối LLM thất bại.';
        setLlmHealth({ ok: false, status: Number(err?.response?.status) || 503, code: 'LLM_UNAVAILABLE', message: msg });
        setNotice({ type: 'error', text: msg });
      } finally {
        setLlmHealthBusy(false);
      }
    };

    const handleQuickConnectProviderChange = (nextProvider) => {
      const key = String(nextProvider || 'openai');
      setQcProvider(key);
      const preset = QUICK_CONNECT_PROVIDER_DEFAULTS[key];
      if (preset) {
        setQcBaseUrl(preset.baseURL);
        setQcModelName(preset.modelName);
      }
    };

    const handleQuickConnectLlm = async (e) => {
      if (e?.preventDefault) e.preventDefault();
      if (!api?.request || qcBusy) return;
      if (qcProvider !== 'ollama' && !String(qcApiKey || '').trim()) {
        setNotice({ type: 'error', text: 'Vui lòng nhập API Key trước khi kết nối nhanh LLM.' });
        return;
      }
      setQcBusy(true);
      setNotice(null);
      try {
        const res = await api.request({
          url: 'dxosAi:quickConnectLlm',
          method: 'post',
          data: {
            provider: qcProvider,
            apiKey: qcApiKey,
            baseURL: qcBaseUrl,
            modelName: qcModelName,
            testConnection: true,
            verifyCompletion: true,
          },
        });
        const d = res?.data?.data || res?.data || {};
        setQcApiKey('');
        if (d.health) setLlmHealth(d.health);
        const reboundCount = Array.isArray(d.reboundAgents) ? d.reboundAgents.length : 0;
        const healthNote = d.health
          ? (d.health.ok ? ' · Kết nối LLM OK' : ` · Cảnh báo kiểm tra kết nối: ${d.health.message || d.health.code}`)
          : '';
        setNotice({
          type: d.health && !d.health.ok ? 'error' : 'ok',
          text: `Đã kết nối ${d.service?.name || qcProvider} (${d.service?.modelName || qcModelName}) và gắn ${reboundCount} nhân sự AI mặc định${healthNote}`,
        });
        await loadAll();
      } catch (err) {
        setNotice({
          type: 'error',
          text: err?.response?.data?.errors?.[0]?.message || err?.message || 'Kết nối nhanh LLM thất bại.',
        });
      } finally {
        setQcBusy(false);
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

    const handleRebuildBuiltApp = async (appItem) => {
      if (!api?.request || !appItem?.appKey || builtAppBusyKey) return;
      setBuiltAppBusyKey(appItem.appKey);
      setNotice(null);
      try {
        const res = await api.request({
          url: 'dxosAi:rebuildBuiltApp',
          method: 'post',
          data: {
            appKey: appItem.appKey,
            ...(appItem.organizationId ? { organizationId: appItem.organizationId } : {}),
          },
        });
        const d = res?.data?.data || res?.data || {};
        setNotice({
          type: d.ok === false ? 'error' : 'ok',
          text: `Đã dựng lại ứng dụng "${appItem.appKey}" lên phiên bản v${d.appVersion || ((Number(appItem.version) || 1) + 1)} (${d.ok === false ? 'NEEDS_REVIEW' : 'PASS'}).`,
        });
        await loadBuiltApps();
      } catch (err) {
        setNotice({
          type: 'error',
          text: err?.response?.data?.errors?.[0]?.message || err?.message || `Dựng lại "${appItem.appKey}" thất bại.`,
        });
      } finally {
        setBuiltAppBusyKey(null);
      }
    };

    const handleExportBuiltAppBundle = async (appItem) => {
      if (!api?.request || !appItem?.appKey || builtAppBusyKey) return;
      setBuiltAppBusyKey(appItem.appKey);
      setNotice(null);
      try {
        const res = await api.request({
          url: 'dxosAi:exportBuiltAppBundle',
          method: 'get',
          params: {
            appKey: appItem.appKey,
            ...(appItem.organizationId ? { organizationId: appItem.organizationId } : {}),
          },
        });
        const bundle = res?.data?.data || res?.data || {};
        setBuiltAppBundlePreview({ appKey: appItem.appKey, bundle });
        if (
          typeof document !== 'undefined'
          && typeof document.createElement === 'function'
          && typeof Blob !== 'undefined'
          && typeof URL?.createObjectURL === 'function'
        ) {
          try {
            const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = `${appItem.appKey}-bundle-v3.json`;
            document.body?.appendChild?.(anchor);
            anchor.click?.();
            anchor.remove?.();
            URL.revokeObjectURL?.(url);
          } catch {
            // Preview panel already captures exported bundle JSON
          }
        }
        setNotice({
          type: 'ok',
          text: `Đã xuất gói giải pháp v3 cho "${appItem.appKey}" (${bundle?.metadata?.schemaVersion || 'latticedx.solution-bundle/v3'}).`,
        });
      } catch (err) {
        setNotice({
          type: 'error',
          text: err?.response?.data?.errors?.[0]?.message || err?.message || `Xuất bundle v3 cho "${appItem.appKey}" thất bại.`,
        });
      } finally {
        setBuiltAppBusyKey(null);
      }
    };

    const handleVerifyBuiltApp = async (appItem) => {
      if (!api?.request || !appItem?.appKey || builtAppBusyKey) return;
      setBuiltAppBusyKey(appItem.appKey);
      setNotice(null);
      try {
        const [metaRes, listRes] = await Promise.all([
          api.request({ url: 'dxosBlocks:collectionsMeta', method: 'get', skipNotify: true }),
          api.request({
            url: 'dxosAi:listBuiltApps',
            method: 'get',
            params: appItem.organizationId ? { organizationId: appItem.organizationId } : {},
          }),
        ]);
        const metaData = metaRes?.data?.data || metaRes?.data || {};
        const liveCols = new Set((Array.isArray(metaData.collections) ? metaData.collections : []).map((c) => c?.name).filter(Boolean));
        const listData = listRes?.data?.data || listRes?.data || {};
        const nextApps = Array.isArray(listData.apps) ? listData.apps : [];
        if (nextApps.length) setBuiltApps(nextApps);
        const freshApp = nextApps.find((a) => a.appKey === appItem.appKey) || appItem;
        const expectedCols = Array.isArray(freshApp?.artifactRefsJson?.collections) ? freshApp.artifactRefsJson.collections : [];
        const missingCols = expectedCols.filter((c) => !liveCols.has(c));
        const ver = freshApp?.lastVerificationJson || {};
        const passedCount = Number(ver.passedCount ?? 0);
        const totalCount = Number(ver.totalCount ?? 0);
        const hasVerifiedPass = ver.ok === true;
        const ok = Boolean(hasVerifiedPass && missingCols.length === 0 && freshApp.status !== 'torndown');
        const summary = {
          ok,
          passedCount,
          totalCount,
          missingCollections: missingCols,
          status: freshApp.status || 'active',
          checkedAt: new Date().toISOString(),
        };
        setBuiltAppVerifyResults((prev) => ({ ...prev, [appItem.appKey]: summary }));
        setNotice({
          type: ok ? 'ok' : 'error',
          text: ok
            ? `Kiểm chứng "${appItem.appKey}" PASS (${passedCount}/${totalCount} checks, ${expectedCols.length} bảng sẵn sàng).`
            : `Kiểm chứng "${appItem.appKey}" phát hiện cảnh báo: ${hasVerifiedPass ? '' : 'chưa có kết quả kiểm chứng hợp lệ (ver.ok !== true), '}thiếu bảng [${missingCols.join(', ') || 'none'}], trạng thái ${freshApp.status}.`,
        });
      } catch (err) {
        setNotice({
          type: 'error',
          text: err?.response?.data?.errors?.[0]?.message || err?.message || `Kiểm chứng "${appItem.appKey}" thất bại.`,
        });
      } finally {
        setBuiltAppBusyKey(null);
      }
    };

    const handleTeardownBuiltApp = async (appItem, keepData = true) => {
      if (!api?.request || !appItem?.appKey || builtAppBusyKey) return;
      setBuiltAppBusyKey(appItem.appKey);
      setNotice(null);
      try {
        const res = await api.request({
          url: 'dxosAi:teardownBuiltApp',
          method: 'post',
          data: {
            appKey: appItem.appKey,
            keepData: keepData !== false,
            ...(appItem.organizationId ? { organizationId: appItem.organizationId } : {}),
          },
        });
        const d = res?.data?.data || res?.data || {};
        const preservedCount = Array.isArray(d.preservedCollections) ? d.preservedCollections.length : 0;
        setNotice({
          type: 'ok',
          text: `Đã gỡ ứng dụng "${appItem.appKey}" (keepData=${d.keepData !== false}, bảo toàn ${preservedCount} bảng dữ liệu).`,
        });
        await loadBuiltApps();
      } catch (err) {
        setNotice({
          type: 'error',
          text: err?.response?.data?.errors?.[0]?.message || err?.message || `Gỡ ứng dụng "${appItem.appKey}" thất bại.`,
        });
      } finally {
        setBuiltAppBusyKey(null);
      }
    };

    const parsePlanPatchJson = (rawText) => {
      const trimmed = String(rawText || '').trim();
      if (!trimmed) return null;
      return JSON.parse(trimmed);
    };

    const handlePlanBuiltApp = async (appItem) => {
      if (!api?.request || !appItem?.appKey || builtAppBusyKey) return;
      const inputState = builtAppPlanInputs[appItem.appKey] || {};
      let parsedPatch = null;
      try {
        parsedPatch = parsePlanPatchJson(inputState.patchText);
      } catch (err) {
        setNotice({ type: 'error', text: `JSON Patch không hợp lệ: ${err.message}` });
        return;
      }
      setBuiltAppBusyKey(appItem.appKey);
      setNotice(null);
      try {
        const res = await api.request({
          url: 'dxosAi:planBuiltApp',
          method: 'post',
          data: {
            appKey: appItem.appKey,
            prompt: inputState.prompt || '',
            ...(parsedPatch ? { patch: parsedPatch } : {}),
            ...(appItem.organizationId ? { organizationId: appItem.organizationId } : {}),
          },
        });
        const d = res?.data?.data || res?.data || {};
        setBuiltAppPlanResults((prev) => ({ ...prev, [appItem.appKey]: d }));
        setNotice({
          type: 'ok',
          text: `Đã lập kế hoạch dry-run cho "${appItem.appKey}": ${d.diff?.summary || 'sẵn sàng áp dụng'}.`,
        });
      } catch (err) {
        setNotice({
          type: 'error',
          text: err?.response?.data?.errors?.[0]?.message || err?.message || `Lập kế hoạch cho "${appItem.appKey}" thất bại.`,
        });
      } finally {
        setBuiltAppBusyKey(null);
      }
    };

    const handleApplyPatchBuiltApp = async (appItem) => {
      if (!api?.request || !appItem?.appKey || builtAppBusyKey) return;
      const inputState = builtAppPlanInputs[appItem.appKey] || {};
      let parsedPatch = null;
      try {
        parsedPatch = parsePlanPatchJson(inputState.patchText);
      } catch (err) {
        setNotice({ type: 'error', text: `JSON Patch không hợp lệ: ${err.message}` });
        return;
      }
      setBuiltAppBusyKey(appItem.appKey);
      setNotice(null);
      try {
        const res = await api.request({
          url: 'dxosAi:patchBuiltApp',
          method: 'post',
          data: {
            appKey: appItem.appKey,
            prompt: inputState.prompt || '',
            ...(parsedPatch ? { patch: parsedPatch } : {}),
            ...(appItem.organizationId ? { organizationId: appItem.organizationId } : {}),
          },
        });
        const d = res?.data?.data || res?.data || {};
        if (d.builtApp && d.builtApp.appKey) {
          setBuiltApps((prev) => prev.map((a) => (a.appKey === appItem.appKey ? d.builtApp : a)));
          setBuiltAppSelected((prev) => (prev?.appKey === appItem.appKey ? d.builtApp : prev));
        }
        setBuiltAppPlanOpenKey(null);
        setBuiltAppPlanResults((prev) => ({ ...prev, [appItem.appKey]: null }));
        setNotice({
          type: d.ok === false ? 'error' : 'ok',
          text: `Đã cập nhật "${appItem.appKey}" lên phiên bản v${d.appVersion || ((Number(appItem.version) || 1) + 1)}.`,
        });
        await loadBuiltApps();
      } catch (err) {
        setNotice({
          type: 'error',
          text: err?.response?.data?.errors?.[0]?.message || err?.message || `Cập nhật "${appItem.appKey}" thất bại.`,
        });
      } finally {
        setBuiltAppBusyKey(null);
      }
    };

    const handleToggleBuiltAppVersions = async (appItem) => {
      if (!api?.request || !appItem?.appKey) return;
      if (builtAppVersionsOpenKey === appItem.appKey) {
        setBuiltAppVersionsOpenKey(null);
        return;
      }
      setBuiltAppVersionsOpenKey(appItem.appKey);
      try {
        const res = await api.request({
          url: 'dxosAi:listBuiltAppVersions',
          method: 'get',
          params: {
            appKey: appItem.appKey,
            ...(appItem.organizationId ? { organizationId: appItem.organizationId } : {}),
          },
        });
        const d = res?.data?.data || res?.data || {};
        setBuiltAppVersionsMap((prev) => ({ ...prev, [appItem.appKey]: d }));
      } catch (err) {
        setNotice({
          type: 'error',
          text: err?.response?.data?.errors?.[0]?.message || err?.message || `Không tải được lịch sử phiên bản của "${appItem.appKey}".`,
        });
      }
    };

    const handleRollbackBuiltApp = async (appItem, targetVersion) => {
      if (!api?.request || !appItem?.appKey || builtAppBusyKey) return;
      setBuiltAppBusyKey(appItem.appKey);
      setNotice(null);
      try {
        const res = await api.request({
          url: 'dxosAi:rollbackBuiltApp',
          method: 'post',
          data: {
            appKey: appItem.appKey,
            targetVersion,
            ...(appItem.organizationId ? { organizationId: appItem.organizationId } : {}),
          },
        });
        const d = res?.data?.data || res?.data || {};
        setNotice({
          type: d.ok === false ? 'error' : 'ok',
          text: `Đã hoàn tác "${appItem.appKey}" về cấu hình v${d.restoredFromVersion || targetVersion} (phiên bản mới v${d.appVersion || ''}).`,
        });
        await loadBuiltApps();
        const verRes = await api.request({
          url: 'dxosAi:listBuiltAppVersions',
          method: 'get',
          params: {
            appKey: appItem.appKey,
            ...(appItem.organizationId ? { organizationId: appItem.organizationId } : {}),
          },
        });
        setBuiltAppVersionsMap((prev) => ({ ...prev, [appItem.appKey]: verRes?.data?.data || verRes?.data || {} }));
      } catch (err) {
        setNotice({
          type: 'error',
          text: err?.response?.data?.errors?.[0]?.message || err?.message || `Hoàn tác "${appItem.appKey}" thất bại.`,
        });
      } finally {
        setBuiltAppBusyKey(null);
      }
    };

    const handleQuickStartPlan = async (overridePrompt = null) => {
      const promptText = String(overridePrompt !== null ? overridePrompt : quickStartPrompt).trim();
      if (!api?.request || quickStartBusy) return;
      if (!promptText) {
        setNotice({ type: 'error', text: 'Vui lòng chọn mẫu gợi ý hoặc nhập mô tả ứng dụng trước khi xem trước kế hoạch.' });
        return;
      }
      setQuickStartBusy(true);
      setNotice(null);
      try {
        const res = await api.request({
          url: 'dxosAi:planBuiltApp',
          method: 'post',
          data: {
            prompt: promptText,
            ...(activeOrgId ? { organizationId: activeOrgId } : {}),
          },
        });
        const d = res?.data?.data || res?.data || {};
        setQuickStartPlan(d);
        setNotice({
          type: 'ok',
          text: `Đã phân tích kế hoạch & sơ đồ ER cho "${d.appKey || 'ứng dụng mới'}": ${d.diff?.summary || 'sẵn sàng dựng'}.`,
        });
      } catch (err) {
        setNotice({
          type: 'error',
          text: err?.response?.data?.errors?.[0]?.message || err?.message || 'Không thể lập kế hoạch ứng dụng từ mô tả.',
        });
      } finally {
        setQuickStartBusy(false);
      }
    };

    const handleQuickStartBuild = async () => {
      const promptText = String(quickStartPrompt || '').trim();
      if (!api?.request || quickStartBusy) return;
      if (!promptText && !quickStartPlan?.candidateSpec) {
        setNotice({ type: 'error', text: 'Vui lòng nhập mô tả ứng dụng hoặc xem trước kế hoạch trước khi dựng.' });
        return;
      }
      setQuickStartBusy(true);
      setNotice(null);
      try {
        const res = await api.request({
          url: 'dxosAi:buildBuiltApp',
          method: 'post',
          data: {
            ...(promptText ? { prompt: promptText } : {}),
            ...(quickStartPlan?.candidateSpec ? { spec: quickStartPlan.candidateSpec } : {}),
            ...(activeOrgId ? { organizationId: activeOrgId } : {}),
          },
        });
        const d = res?.data?.data || res?.data || {};
        setQuickStartPlan(null);
        setQuickStartPrompt('');
        setNotice({
          type: d.ok === false ? 'error' : 'ok',
          text: `Đã dựng ứng dụng "${d.appKey || 'mới'}" (${(d.collections || []).length} bảng, cổng /p/${d.portalSlug || 'services'}).`,
        });
        await loadBuiltApps();
      } catch (err) {
        setNotice({
          type: 'error',
          text: err?.response?.data?.errors?.[0]?.message || err?.message || 'Dựng ứng dụng nhanh thất bại.',
        });
      } finally {
        setQuickStartBusy(false);
      }
    };

    const tabCategories = [
      {
        id: 'overview',
        title: 'Tổng quan & Kết nối',
        subtitle: 'Cấu hình LLM (Quick-Connect), Nhân sự AI & MCP',
        items: [
          ['topology', '1. Hệ điều hành 6 Phân hệ'],
          ['workforce', '2. Quản trị Nhân sự AI Động'],
          ['mcp', '3. Cổng Enterprise MCP 2 Chiều'],
        ],
      },
      {
        id: 'build-eval',
        title: 'Xây dựng & Đánh giá AI',
        items: [
          ['built-apps', '7. Ứng dụng Đã dựng (Built Apps)'],
          ['audit', '4. Nhật ký Kiểm toán'],
          ['traces', '8. Agent Trace Waterfall'],
          ['eval-lab', '9. Eval Lab'],
        ],
      },
      {
        id: 'governance',
        title: 'Kiểm soát & Phê duyệt',
        items: [
          ['hitl', '6. Duyệt AI (HITL)'],
          ['quota', '5. Hạn mức & Chi phí AI'],
        ],
      },
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
    const activeOrgId = String(quotaOrg || resolveStudioDefaultOrg({ topology, catalog, profiles, app }) || orgOptions[0] || '').trim();
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
      style: { maxWidth: 1360, margin: '0 auto', padding: 20, display: 'grid', gap: 16 },
    },
      h('style', null, [
        '.dxos-studio-shell{display:flex;gap:18px;align-items:flex-start;}',
        '.dxos-studio-sidebar{flex:0 0 224px;width:224px;display:grid;gap:14px;padding:14px;border-radius:12px;border:1px solid #e2e8f0;background:#f8fafc;position:sticky;top:16px;}',
        '.dxos-studio-main{flex:1 1 0%;min-width:0;display:grid;gap:14px;}',
        '@media (max-width:1024px){.dxos-studio-shell{flex-direction:column;}.dxos-studio-sidebar{width:100%;flex:none;position:static;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));}}',
      ].join('')),
      h('div', { style: { display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, alignItems: 'center' } },
        h('div', null,
          h('h1', { style: { margin: '0 0 6px', fontSize: 22, fontWeight: 700, color: '#0f172a' } },
            'DX-OS AI Workforce & 2-Way Enterprise MCP Studio'),
          h('p', { style: { margin: 0, color: '#475569', fontSize: 13 } },
            `Điều phối hệ điều hành doanh nghiệp 6 phân hệ LatticeDX — NocoBase ${runtimeVersion} đóng vai trò Plane #6 (appDataSubstrate), Powered by NocoBase (https://www.nocobase.com).`),
        ),
        h('div', { style: { display: 'flex', gap: 8 } },
          h('button', { type: 'button', onClick: handleBootstrap, disabled: busy, style: btnStyle(true) },
            busy ? 'Đang đồng bộ…' : 'Cài 7 Starter Blueprints & IT/OT MCP'),
          h('button', {
            type: 'button',
            onClick: async () => {
              await loadAll();
              if (!clientDenied && !forbidden) {
                await loadQuota(quotaOrg);
                if (tab === 'hitl') await loadApprovals(approvalStatusFilter);
                if (tab === 'built-apps') await loadBuiltApps();
              }
            },
            disabled: loading || busy || quotaLoading || approvalsLoading || builtAppsLoading,
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

      h('div', { className: 'dxos-studio-shell' },
        h('aside', {
          role: 'tablist',
          'aria-label': 'Điều hướng DX-OS AI Studio',
          'data-testid': 'dxos-studio-sidebar',
          className: 'dxos-studio-sidebar',
        },
          tabCategories.map((cat) => h('div', {
            key: cat.id,
            role: 'group',
            'aria-label': cat.title,
            style: { display: 'grid', gap: 6 },
          },
            h('div', { style: { fontSize: 11, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.04em', padding: '0 4px' } },
              cat.title),
            cat.items.map(([key, label]) => h('button', {
              key,
              type: 'button',
              role: 'tab',
              'data-testid': `dxos-tab-${key}`,
              'aria-selected': tab === key,
              onClick: () => setTab(key),
              style: {
                ...btnStyle(tab === key),
                width: '100%',
                textAlign: 'left',
                padding: '8px 10px',
                fontSize: 12,
                lineHeight: 1.35,
              },
            }, label)),
          )),
        ),

        h('div', { className: 'dxos-studio-main' },
          (tab === 'topology' || tab === 'workforce' || tab === 'mcp') ? h('div', {
            'data-testid': 'dxos-quick-connect-llm-card',
            style: { padding: 16, borderRadius: 12, border: '1px solid #bae6fd', background: '#f0f9ff', display: 'grid', gap: 10 },
          },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 } },
              h('div', null,
                h('strong', { style: { fontSize: 14, color: '#0c4a6e' } }, 'Kết nối nhanh LLM Key (1-Click Quick-Connect cho AI Architect)'),
                h('div', { style: { fontSize: 12, color: '#0369a1' } },
                  'Nhập API key OpenAI, Gemini, Anthropic, DeepSeek, Ollama hoặc 9router để lưu vào llmServices và tự động gắn cho dxos-architect & các trợ lý chưa gán.'),
              ),
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                llmHealth ? h('span', {
                  'data-testid': 'dxos-llm-health-status',
                  style: badgeStyle(llmHealth.ok ? '#dcfce7' : '#fee2e2', llmHealth.ok ? '#166534' : '#991b1b'),
                }, llmHealth.ok
                  ? `LLM Sẵn sàng (${llmHealth.llmService || 'active'}${llmHealth.modelName ? `: ${llmHealth.modelName}` : ''})`
                  : `${llmHealth.code || 'LLM_UNAVAILABLE'}${llmHealth.status ? ` (${llmHealth.status})` : ''}`) : null,
                h('button', {
                  type: 'button',
                  'data-testid': 'dxos-llm-health-btn',
                  onClick: handleCheckLlmHealth,
                  disabled: llmHealthBusy || qcBusy,
                  style: btnStyle(false),
                }, llmHealthBusy ? 'Đang kiểm tra…' : 'Kiểm tra kết nối LLM'),
              ),
            ),
            h('form', {
              'data-testid': 'dxos-quick-connect-llm-form',
              onSubmit: handleQuickConnectLlm,
              style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8, alignItems: 'end' },
            },
              h('label', { style: { fontSize: 12, display: 'grid', gap: 4, color: '#0f172a' } }, 'Nhà cung cấp (Provider)',
                h('select', {
                  'data-testid': 'dxos-qc-provider-select',
                  value: qcProvider,
                  onChange: (e) => handleQuickConnectProviderChange(e.target.value),
                  style: { padding: 6, borderRadius: 6, border: '1px solid #cbd5e1', background: '#fff' },
                }, Object.entries(QUICK_CONNECT_PROVIDER_DEFAULTS).map(([key, meta]) => h('option', { key, value: key }, meta.label)))),
              h('label', { style: { fontSize: 12, display: 'grid', gap: 4, color: '#0f172a' } }, 'API Key (bảo mật)',
                h('input', {
                  'data-testid': 'dxos-qc-apikey-input',
                  type: 'password',
                  autoComplete: 'off',
                  value: qcApiKey,
                  onChange: (e) => setQcApiKey(e.target.value),
                  placeholder: qcProvider === 'ollama' ? '(Không bắt buộc cho Ollama)' : 'sk-... / AIza...',
                  style: { padding: 6, borderRadius: 6, border: '1px solid #cbd5e1', background: '#fff' },
                })),
              h('label', { style: { fontSize: 12, display: 'grid', gap: 4, color: '#0f172a' } }, 'Base URL',
                h('input', {
                  'data-testid': 'dxos-qc-baseurl-input',
                  value: qcBaseUrl,
                  onChange: (e) => setQcBaseUrl(e.target.value),
                  placeholder: 'https://api.openai.com/v1',
                  style: { padding: 6, borderRadius: 6, border: '1px solid #cbd5e1', background: '#fff' },
                })),
              h('label', { style: { fontSize: 12, display: 'grid', gap: 4, color: '#0f172a' } }, 'Model mặc định',
                h('input', {
                  'data-testid': 'dxos-qc-model-input',
                  value: qcModelName,
                  onChange: (e) => setQcModelName(e.target.value),
                  placeholder: 'gpt-4o-mini',
                  style: { padding: 6, borderRadius: 6, border: '1px solid #cbd5e1', background: '#fff' },
                })),
              h('button', {
                type: 'submit',
                'data-testid': 'dxos-qc-submit-btn',
                disabled: qcBusy,
                style: { ...btnStyle(true), height: 32 },
              }, qcBusy ? 'Đang kết nối…' : 'Kết nối & Gắn AI Architect'),
            ),
            llmHealth && !llmHealth.ok && llmHealth.message ? h('div', {
              style: { fontSize: 12, color: '#991b1b', padding: '6px 10px', borderRadius: 6, background: '#fef2f2', border: '1px solid #fecaca' },
            }, llmHealth.message) : null,
          ) : null,

          tab === 'topology' ? h('div', { style: { display: 'grid', gap: 12 } },
            h('div', { style: { padding: 14, borderRadius: 10, background: '#f8fafc', border: '1px solid #e2e8f0', fontSize: 13, color: '#334155' } },
              topology?.positioningStatement || `LatticeDX điều phối đồng bộ 6 phân hệ Enterprise Digital OS; NocoBase ${runtimeVersion} là phân hệ lưu trữ & metadata (Plane #6).`),
            h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12 } },
              (topology?.planes || []).map((p) => h('div', {
                key: p.key,
                style: { padding: 16, borderRadius: 12, border: p.key === 'aiWorkforceAndMcp' ? '2px solid #0284c7' : '1px solid #e2e8f0', background: '#fff', display: 'grid', gap: 8 },
              },
                h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 } },
                  h('strong', { style: { fontSize: 14, color: '#0f172a' } }, `Phân hệ #${p.order}: ${p.name}`),
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
                  }, `${m.label}: ${m.value}`)),
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

      tab === 'audit' ? (() => {
        const agentChoices = [...new Set((auditItems || []).map((i) => String(i.aiEmployee || i.actorUsername || '').trim()).filter(Boolean))];
        const q = String(auditSearch || '').trim().toLowerCase();
        const filteredAuditItems = (auditItems || []).filter((item) => {
          if (auditStatusFilter !== 'all' && String(item.status || '').toLowerCase() !== auditStatusFilter) return false;
          const agentVal = String(item.aiEmployee || item.actorUsername || '').trim();
          if (auditAgentFilter !== 'all' && agentVal !== auditAgentFilter) return false;
          if (!q) return true;
          const hay = `${item.toolName || ''} ${item.channel || ''} ${item.actorUsername || ''} ${item.aiEmployee || ''} ${item.resultSummary || ''} ${item.errorCode || ''}`.toLowerCase();
          return hay.includes(q);
        });
        return h('div', { 'data-testid': 'dxos-ai-audit-tab', style: { padding: 18, borderRadius: 12, border: '1px solid #e2e8f0', background: '#fff', display: 'grid', gap: 12 } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 } },
            h('h3', { style: { margin: 0, fontSize: 16 } }, `Nhật ký Kiểm toán Thực thi AI & MCP (${filteredAuditItems.length} / ${auditItems.length} bản ghi)`),
            h('div', { 'data-testid': 'dxos-audit-filter-bar', style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
              h('input', {
                'data-testid': 'dxos-audit-search-input',
                value: auditSearch,
                onChange: (e) => setAuditSearch(e.target.value),
                placeholder: 'Tìm công cụ, tác nhân, tóm tắt…',
                style: { padding: '6px 10px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 12, minWidth: 210 },
              }),
              h('select', {
                'data-testid': 'dxos-audit-status-filter',
                value: auditStatusFilter,
                onChange: (e) => setAuditStatusFilter(e.target.value),
                style: { padding: '6px 8px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 12, background: '#fff' },
              },
                h('option', { value: 'all' }, 'Tất cả trạng thái'),
                h('option', { value: 'allowed' }, 'Cho phép'),
                h('option', { value: 'denied' }, 'Từ chối'),
                h('option', { value: 'degraded' }, 'Suy giảm'),
                h('option', { value: 'error' }, 'Lỗi'),
              ),
              h('select', {
                'data-testid': 'dxos-audit-agent-filter',
                value: auditAgentFilter,
                onChange: (e) => setAuditAgentFilter(e.target.value),
                style: { padding: '6px 8px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 12, background: '#fff' },
              },
                h('option', { value: 'all' }, 'Tất cả tác nhân'),
                agentChoices.map((ag) => h('option', { key: ag, value: ag }, ag)),
              ),
            ),
          ),
          !filteredAuditItems.length
            ? h('div', { style: { fontSize: 13, color: '#64748b', padding: 16, textAlign: 'center', borderRadius: 8, border: '1px dashed #cbd5e1' } },
              auditItems.length ? 'Không có bản ghi kiểm toán nào khớp bộ lọc.' : 'Chưa có bản ghi kiểm toán nào.')
            : h('div', { style: { overflowX: 'auto', borderRadius: 8, border: '1px solid #e2e8f0' } },
              h('table', { 'data-testid': 'dxos-audit-table', style: { width: '100%', borderCollapse: 'collapse', fontSize: 12 } },
                h('thead', null,
                  h('tr', { style: { background: '#f8fafc', borderBottom: '1px solid #e2e8f0', textAlign: 'left' } },
                    h('th', { style: { padding: '8px 10px' } }, 'Công cụ'),
                    h('th', { style: { padding: '8px 10px' } }, 'Kênh'),
                    h('th', { style: { padding: '8px 10px' } }, 'Tác nhân'),
                    h('th', { style: { padding: '8px 10px' } }, 'Tóm tắt kết quả'),
                    h('th', { style: { padding: '8px 10px' } }, 'Trạng thái'),
                  ),
                ),
                h('tbody', null,
                  filteredAuditItems.map((item) => {
                    const st = String(item.status || 'allowed').toLowerCase();
                    const stLabel = AUDIT_STATUS_LABELS[st] || st;
                    return h('tr', { key: item.id, style: { borderBottom: '1px solid #f1f5f9' } },
                      h('td', { style: { padding: '8px 10px', fontWeight: 600, color: '#0f172a', whiteSpace: 'nowrap' } }, item.toolName || '—'),
                      h('td', { style: { padding: '8px 10px', color: '#475569', whiteSpace: 'nowrap' } }, item.channel || '—'),
                      h('td', { style: { padding: '8px 10px', color: '#334155', whiteSpace: 'nowrap' } }, item.aiEmployee || item.actorUsername || item.actorUserId || 'Hệ thống'),
                      h('td', { style: { padding: '8px 10px', color: '#334155', minWidth: 0, overflowWrap: 'anywhere', wordBreak: 'break-word' } }, item.resultSummary || '—'),
                      h('td', { style: { padding: '8px 10px', whiteSpace: 'nowrap' } },
                        h('span', { style: badgeStyle(st === 'allowed' ? '#dcfce7' : '#fee2e2', st === 'allowed' ? '#166534' : '#991b1b') },
                          `${stLabel}${item.errorCode ? ` (${item.errorCode})` : ''}`)),
                    );
                  }),
                ),
              ),
            ),
        );
      })() : null,

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
            !quotaOrgCustomMode ? h('select', {
              'data-testid': 'dxos-quota-org-select',
              value: orgOptions.includes(quotaOrg) ? quotaOrg : (orgOptions[0] || '__custom__'),
              onChange: (e) => {
                const v = e.target.value;
                if (v === '__custom__') {
                  setQuotaOrgCustomMode(true);
                  return;
                }
                commitQuotaOrg(v);
              },
              style: { padding: '6px 8px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 12, background: '#fff' },
            },
              orgOptions.map((org) => h('option', { key: org, value: org }, org)),
              h('option', { value: '__custom__' }, 'Nhập mã tổ chức khác…'),
            ) : h(React.Fragment, null,
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
                style: { padding: '6px 8px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 12, width: 150 },
              }),
              h('button', {
                type: 'button',
                onClick: () => commitQuotaOrg(quotaOrgDraft),
                style: btnStyle(false),
              }, 'Xem hạn mức'),
              h('button', {
                type: 'button',
                onClick: () => setQuotaOrgCustomMode(false),
                style: btnStyle(false),
              }, 'Chọn sẵn'),
            ),
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
                    h('span', { style: badgeStyle(riskBg, riskFg) }, `Mức rủi ro: ${HITL_RISK_LABELS[risk] || risk}`),
                    h('span', { style: badgeStyle(statusBg, statusFg) }, HITL_STATUS_LABELS[item.status] || item.status),
                  ),
                ),
                h('div', { style: { fontSize: 12, color: '#475569' } },
                  `Người yêu cầu: ${item.requesterUsername || `#${item.requesterUserId}`} · AI: ${item.aiEmployee || '—'} · Tổ chức: ${item.organizationId}`),
                h('div', {
                  'data-testid': `dxos-hitl-diff-${item.id}`,
                  style: { padding: 10, borderRadius: 8, border: '1px solid #e2e8f0', background: '#fff', fontSize: 12, display: 'grid', gap: 6 },
                },
                  h('strong', { style: { fontSize: 12, color: '#334155' } }, 'Xem trước thay đổi'),
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

      tab === 'built-apps' ? h('div', {
        'data-testid': 'dxos-built-apps-panel',
        style: { padding: 18, borderRadius: 12, border: '1px solid #e2e8f0', background: '#fff', display: 'grid', gap: 14 },
      },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 } },
          h('div', null,
            h('h3', { style: { margin: '0 0 4px', fontSize: 16 } }, '7. Ứng dụng doanh nghiệp đã dựng (App Registry)'),
            h('div', { style: { fontSize: 12, color: '#64748b' } },
              `Hiển thị ${builtApps.length} ứng dụng trong tổ chức ${quotaOrg || '(mặc định)'}${builtAppsLoading ? ' · Đang tải…' : ''}`),
          ),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            h('button', {
              type: 'button',
              'data-testid': 'dxos-built-apps-refresh-btn',
              onClick: loadBuiltApps,
              disabled: builtAppsLoading || Boolean(builtAppBusyKey),
              style: btnStyle(false),
            }, builtAppsLoading ? 'Đang tải…' : 'Tải lại danh sách'),
          ),
        ),
        !builtApps.length
          ? h('div', {
            'data-testid': 'dxos-built-apps-quickstart',
            style: { padding: 18, borderRadius: 12, border: '1px solid #bae6fd', background: '#f0f9ff', display: 'grid', gap: 12 },
          },
            h('div', null,
              h('strong', { style: { fontSize: 15, color: '#0c4a6e' } }, 'AI App Builder 2.0 Quick-Start — Khởi tạo Ứng dụng từ Ngôn ngữ Tự nhiên'),
              h('div', { style: { fontSize: 12, color: '#0369a1', marginTop: 4 } },
                'Chọn 1 mẫu khởi đầu hoặc mô tả nghiệp vụ bằng tiếng Việt để xem trước Sơ đồ ER, Plan-Diff và dựng ứng dụng đa bảng kèm phân quyền RBAC + PG RLS.'),
            ),
            h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 10 } },
              BUILT_APP_QUICKSTART_PRESETS.map((preset) => h('button', {
                key: preset.key,
                type: 'button',
                'data-testid': `dxos-quickstart-preset-${preset.key}`,
                onClick: () => {
                  setQuickStartPrompt(preset.prompt);
                  setQuickStartPlan(null);
                },
                style: {
                  textAlign: 'left',
                  padding: 12,
                  borderRadius: 10,
                  border: quickStartPrompt === preset.prompt ? '2px solid #0284c7' : '1px solid #cbd5e1',
                  background: '#ffffff',
                  cursor: 'pointer',
                  display: 'grid',
                  gap: 4,
                },
              },
                h('strong', { style: { fontSize: 13, color: '#0f172a' } }, preset.title),
                h('span', { style: { fontSize: 11, color: '#475569' } }, preset.subtitle),
              )),
            ),
            h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
              h('input', {
                type: 'text',
                'data-testid': 'dxos-quickstart-prompt-input',
                value: quickStartPrompt,
                onChange: (e) => setQuickStartPrompt(e.target.value),
                placeholder: 'Mô tả ứng dụng cần dựng (vd: Quản lý Phòng khám Đa khoa gồm Bệnh nhân, Lượt khám, Đơn thuốc...)',
                style: { flex: '1 1 320px', padding: '8px 12px', borderRadius: 8, border: '1px solid #94a3b8', fontSize: 13, background: '#ffffff' },
              }),
              h('button', {
                type: 'button',
                'data-testid': 'dxos-quickstart-plan-btn',
                onClick: () => handleQuickStartPlan(),
                disabled: quickStartBusy,
                style: btnStyle(true, false),
              }, quickStartBusy ? 'Đang phân tích…' : 'Xem trước Kế hoạch & Sơ đồ ER (Plan-Diff)'),
              quickStartPlan ? h('button', {
                type: 'button',
                'data-testid': 'dxos-quickstart-build-btn',
                onClick: handleQuickStartBuild,
                disabled: quickStartBusy,
                style: { ...btnStyle(true, false), background: '#059669', border: '1px solid #059669' },
              }, quickStartBusy ? 'Đang dựng…' : 'Dựng ứng dụng ngay') : null,
            ),
            quickStartPlan ? h('div', {
              'data-testid': 'dxos-quickstart-plan-preview',
              style: { padding: 12, borderRadius: 10, border: '1px solid #cbd5e1', background: '#ffffff', display: 'grid', gap: 10, fontSize: 12 },
            },
              h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 } },
                h('strong', { style: { color: '#0f172a' } }, `Kế hoạch ứng dụng: ${quickStartPlan.plan?.appName || quickStartPlan.appKey} (${quickStartPlan.appKey})`),
                h('button', {
                  type: 'button',
                  'data-testid': 'dxos-quickstart-build-btn-inline',
                  onClick: handleQuickStartBuild,
                  disabled: quickStartBusy,
                  style: { ...btnStyle(true, false), background: '#059669', border: '1px solid #059669' },
                }, quickStartBusy ? 'Đang dựng…' : 'Dựng ứng dụng ngay'),
              ),
              quickStartPlan.diff ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
                ['collections', 'fields', 'relations', 'roles', 'pages', 'blocks'].map((cat) => {
                  const c = quickStartPlan.diff[cat] || { added: [], modified: [], removed: [] };
                  return h('span', { key: cat, style: badgeStyle('#f1f5f9', '#334155') },
                    `${cat}: +${c.added?.length || 0} / ~${c.modified?.length || 0} / -${c.removed?.length || 0}`);
                }),
              ) : null,
              quickStartPlan.erGraph ? renderErGraphPanel(React, {
                erGraph: quickStartPlan.erGraph,
                selectedNode: erSelectedNode,
                onSelectNode: setErSelectedNode,
                selectedEdge: erSelectedEdge,
                onSelectEdge: setErSelectedEdge,
                testIdPrefix: 'dxos-quickstart-er',
              }) : null,
            ) : null,
          )
          : h('div', { style: { display: 'grid', gap: 12 } },
            builtApps.map((appItem) => {
              const refs = appItem?.artifactRefsJson || {};
              const cols = Array.isArray(refs.collections) ? refs.collections : [];
              const roles = Array.isArray(refs.roles) ? refs.roles : [];
              const portals = Array.isArray(refs.portals) ? refs.portals : [];
              const dmns = Array.isArray(refs.dmnTableKeys) ? refs.dmnTableKeys : [];
              const flows = Array.isArray(refs.flowRuleKeys) ? refs.flowRuleKeys : [];
              const n8ns = Array.isArray(refs.n8nWorkflowIds) ? refs.n8nWorkflowIds : [];
              const statusStr = String(appItem.status || 'active');
              const statusBg = statusStr === 'active' ? '#dcfce7' : statusStr === 'torndown' ? '#f1f5f9' : '#fef3c7';
              const statusFg = statusStr === 'active' ? '#166534' : statusStr === 'torndown' ? '#475569' : '#92400e';
              const rowBusy = builtAppBusyKey === appItem.appKey;
              const verifyState = builtAppVerifyResults[appItem.appKey] || null;
              const lastVer = appItem.lastVerificationJson || {};

              return h('div', {
                key: appItem.appKey,
                'data-testid': `dxos-built-app-card-${appItem.appKey}`,
                style: { padding: 14, borderRadius: 10, border: '1px solid #e2e8f0', background: '#f8fafc', display: 'grid', gap: 10 },
              },
                h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 } },
                  h('div', { style: { fontSize: 14, color: '#0f172a' } },
                    h('strong', null, appItem.name || appItem.appKey),
                    ' · ',
                    h('code', null, appItem.appKey),
                    ` · v${appItem.version || 1}`,
                  ),
                  h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
                    h('span', { style: badgeStyle('#e0f2fe', '#075985') }, `v${appItem.version || 1}`),
                    h('span', { style: badgeStyle(statusBg, statusFg) }, statusStr),
                  ),
                ),
                h('div', { style: { fontSize: 12, color: '#475569', display: 'flex', flexWrap: 'wrap', gap: 8 } },
                  h('span', null, `Tổ chức: ${appItem.organizationId || '—'}`),
                  h('span', null, `Bảng (${cols.length}): ${cols.join(', ') || '—'}`),
                  h('span', null, `Vai trò (${roles.length}): ${roles.join(', ') || '—'}`),
                  h('span', null, `Portals: ${portals.map((p) => `/p/${p.portalSlug}`).join(', ') || '—'}`),
                  dmns.length ? h('span', null, `DMN: ${dmns.join(', ')}`) : null,
                  flows.length ? h('span', null, `Flows: ${flows.join(', ')}`) : null,
                  n8ns.length ? h('span', null, `n8n: ${n8ns.join(', ')}`) : null,
                ),
                verifyState ? h('div', {
                  'data-testid': `dxos-built-app-verify-result-${appItem.appKey}`,
                  style: {
                    padding: '6px 10px',
                    borderRadius: 6,
                    fontSize: 12,
                    border: `1px solid ${verifyState.ok ? '#86efac' : '#fca5a5'}`,
                    background: verifyState.ok ? '#f0fdf4' : '#fef2f2',
                    color: verifyState.ok ? '#166534' : '#991b1b',
                  },
                }, verifyState.ok
                  ? `PASS · ${verifyState.passedCount}/${verifyState.totalCount} checks · ${cols.length} bảng đã xác minh`
                  : `FAIL · thiếu bảng [${(verifyState.missingCollections || []).join(', ')}] · trạng thái ${verifyState.status}`)
                  : (lastVer && typeof lastVer.totalCount === 'number' ? h('div', { style: { fontSize: 11, color: '#64748b' } },
                    `Lần kiểm chứng gần nhất: ${lastVer.ok ? 'PASS' : 'NEEDS_REVIEW'} (${lastVer.passedCount ?? 0}/${lastVer.totalCount})`) : null),
                h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' } },
                  h('button', {
                    type: 'button',
                    'data-testid': `dxos-built-app-view-${appItem.appKey}`,
                    onClick: () => setBuiltAppSelected((prev) => (prev?.appKey === appItem.appKey ? null : appItem)),
                    style: btnStyle(builtAppSelected?.appKey === appItem.appKey, false),
                  }, builtAppSelected?.appKey === appItem.appKey ? 'Ẩn chi tiết' : 'Xem chi tiết'),
                  h('button', {
                    type: 'button',
                    'data-testid': `dxos-built-app-verify-${appItem.appKey}`,
                    onClick: () => handleVerifyBuiltApp(appItem),
                    disabled: rowBusy || Boolean(builtAppBusyKey),
                    style: btnStyle(false, false),
                  }, rowBusy ? 'Đang xử lý…' : 'Kiểm chứng'),
                  h('button', {
                    type: 'button',
                    'data-testid': `dxos-built-app-rebuild-${appItem.appKey}`,
                    onClick: () => handleRebuildBuiltApp(appItem),
                    disabled: rowBusy || Boolean(builtAppBusyKey),
                    style: btnStyle(true, false),
                  }, rowBusy ? 'Đang xử lý…' : 'Dựng lại'),
                  h('button', {
                    type: 'button',
                    'data-testid': `dxos-built-app-export-${appItem.appKey}`,
                    onClick: () => handleExportBuiltAppBundle(appItem),
                    disabled: rowBusy || Boolean(builtAppBusyKey),
                    style: btnStyle(false, false),
                  }, 'Xuất Bundle v3'),
                  h('button', {
                    type: 'button',
                    'data-testid': `dxos-built-app-plan-toggle-${appItem.appKey}`,
                    onClick: () => setBuiltAppPlanOpenKey((prev) => (prev === appItem.appKey ? null : appItem.appKey)),
                    disabled: rowBusy || Boolean(builtAppBusyKey),
                    style: btnStyle(builtAppPlanOpenKey === appItem.appKey, false),
                  }, 'Plan-Diff & Patch'),
                  h('button', {
                    type: 'button',
                    'data-testid': `dxos-built-app-versions-btn-${appItem.appKey}`,
                    onClick: () => handleToggleBuiltAppVersions(appItem),
                    disabled: rowBusy || Boolean(builtAppBusyKey),
                    style: btnStyle(builtAppVersionsOpenKey === appItem.appKey, false),
                  }, 'Lịch sử & Rollback'),
                  h('button', {
                    type: 'button',
                    'data-testid': `dxos-built-app-teardown-${appItem.appKey}`,
                    onClick: () => handleTeardownBuiltApp(appItem, true),
                    disabled: rowBusy || Boolean(builtAppBusyKey),
                    style: btnStyle(false, true),
                  }, 'Gỡ bỏ (Giữ dữ liệu)'),
                ),
                builtAppPlanOpenKey === appItem.appKey ? (() => {
                  const planInput = builtAppPlanInputs[appItem.appKey] || { prompt: '', patchText: '' };
                  const planRes = builtAppPlanResults[appItem.appKey] || null;
                  const diffObj = planRes?.diff || null;
                  return h('div', {
                    'data-testid': `dxos-built-app-plan-panel-${appItem.appKey}`,
                    style: { padding: 12, borderRadius: 8, border: '1px solid #bae6fd', background: '#f0f9ff', display: 'grid', gap: 8, fontSize: 12 },
                  },
                    h('strong', null, `Plan-Diff-Approve & Patch cho ${appItem.appKey}`),
                    h('input', {
                      type: 'text',
                      'data-testid': `dxos-plan-prompt-${appItem.appKey}`,
                      placeholder: 'Mô tả thay đổi bằng tiếng Việt/Anh (vd: Thêm trường priority hoặc gắn khối Biểu đồ BI)',
                      value: planInput.prompt || '',
                      onChange: (e) => setBuiltAppPlanInputs((prev) => ({
                        ...prev,
                        [appItem.appKey]: { ...(prev[appItem.appKey] || {}), prompt: e.target.value },
                      })),
                      style: { padding: '6px 10px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 12 },
                    }),
                    h('textarea', {
                      'data-testid': `dxos-plan-patch-${appItem.appKey}`,
                      placeholder: 'Tùy chọn JSON Patch (vd: {"addFields":[{"name":"priority","type":"string"}]})',
                      rows: 3,
                      value: planInput.patchText || '',
                      onChange: (e) => setBuiltAppPlanInputs((prev) => ({
                        ...prev,
                        [appItem.appKey]: { ...(prev[appItem.appKey] || {}), patchText: e.target.value },
                      })),
                      style: { padding: '6px 10px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 11, fontFamily: 'monospace' },
                    }),
                    h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                      h('button', {
                        type: 'button',
                        'data-testid': `dxos-plan-preview-btn-${appItem.appKey}`,
                        onClick: () => handlePlanBuiltApp(appItem),
                        disabled: rowBusy || Boolean(builtAppBusyKey),
                        style: btnStyle(true, false),
                      }, 'Xem trước Plan & ER'),
                      planRes ? h('button', {
                        type: 'button',
                        'data-testid': `dxos-patch-apply-btn-${appItem.appKey}`,
                        onClick: () => handleApplyPatchBuiltApp(appItem),
                        disabled: rowBusy || Boolean(builtAppBusyKey),
                        style: btnStyle(true, false),
                      }, 'Xác nhận Áp dụng Patch') : null,
                    ),
                    diffObj ? h('div', {
                      'data-testid': `dxos-plan-diff-preview-${appItem.appKey}`,
                      style: { padding: 10, borderRadius: 6, border: '1px solid #cbd5e1', background: '#ffffff', display: 'grid', gap: 8 },
                    },
                      h('strong', null, `Diff Preview: ${diffObj.summary || (diffObj.hasChanges ? 'Có thay đổi' : 'Không thay đổi')}`),
                      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 11 } },
                        ['collections', 'fields', 'relations', 'roles', 'pages', 'blocks', 'flows', 'dmnTables'].map((cat) => {
                          const c = diffObj[cat] || { added: [], modified: [], removed: [] };
                          return h('span', { key: cat, style: badgeStyle('#f1f5f9', '#334155') },
                            `${cat}: +${c.added?.length || 0} / ~${c.modified?.length || 0} / -${c.removed?.length || 0}`);
                        }),
                      ),
                      planRes.erGraph ? renderErGraphPanel(React, {
                        erGraph: planRes.erGraph,
                        selectedNode: erSelectedNode,
                        onSelectNode: setErSelectedNode,
                        selectedEdge: erSelectedEdge,
                        onSelectEdge: setErSelectedEdge,
                        testIdPrefix: `dxos-plan-er-${appItem.appKey}`,
                      }) : null,
                    ) : null,
                  );
                })() : null,
                builtAppVersionsOpenKey === appItem.appKey ? (() => {
                  const verInfo = builtAppVersionsMap[appItem.appKey] || {};
                  const versions = Array.isArray(verInfo.versions) ? verInfo.versions : [];
                  return h('div', {
                    'data-testid': `dxos-built-app-versions-${appItem.appKey}`,
                    style: { padding: 12, borderRadius: 8, border: '1px solid #cbd5e1', background: '#ffffff', display: 'grid', gap: 8, fontSize: 12 },
                  },
                    h('strong', null, `Lịch sử Phiên bản: ${appItem.appKey} (Hiện tại: v${verInfo.currentVersion || appItem.version || 1})`),
                    !versions.length
                      ? h('div', { style: { color: '#64748b', fontSize: 12 } }, 'Chưa có snapshot phiên bản cũ.')
                      : versions.map((snap, sIdx) => h('div', {
                        key: `${snap.version}-${sIdx}`,
                        style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 6, border: '1px solid #e2e8f0', background: '#f8fafc' },
                      },
                        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                          h('span', { style: badgeStyle('#e0f2fe', '#075985') }, `v${snap.version}`),
                          h('span', { style: badgeStyle('#f1f5f9', '#334155') }, snap.action || 'patch'),
                          h('span', null, snap.summary || 'Snapshot'),
                          snap.patchedAt ? h('span', { style: { color: '#64748b', fontSize: 11 } }, snap.patchedAt) : null,
                        ),
                        h('button', {
                          type: 'button',
                          'data-testid': `dxos-rollback-btn-${appItem.appKey}-v${snap.version}`,
                          onClick: () => handleRollbackBuiltApp(appItem, snap.version),
                          disabled: rowBusy || Boolean(builtAppBusyKey),
                          style: btnStyle(false, true),
                        }, `Hoàn tác về v${snap.version}`),
                      )),
                  );
                })() : null,
                builtAppSelected?.appKey === appItem.appKey ? (() => {
                  const detailApp = builtAppSelected;
                  return h('div', {
                    'data-testid': `dxos-built-app-detail-${appItem.appKey}`,
                    style: { padding: 12, borderRadius: 8, border: '1px solid #cbd5e1', background: '#fff', display: 'grid', gap: 8, fontSize: 12 },
                  },
                    h('strong', null, `Chi tiết Manifest: ${detailApp.appKey} (snapshot: ${detailApp.bundleSnapshotUid || '—'})`),
                    renderErGraphPanel(React, {
                      erGraph: deriveErGraphFromSpec(detailApp.sourceSpecJson, detailApp.artifactRefsJson),
                      selectedNode: erSelectedNode,
                      onSelectNode: setErSelectedNode,
                      selectedEdge: erSelectedEdge,
                      onSelectEdge: setErSelectedEdge,
                    }),
                    h('pre', { style: { margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 11, background: '#f8fafc', padding: 8, borderRadius: 6 } },
                      JSON.stringify({
                        sourceSpecJson: detailApp.sourceSpecJson || {},
                        artifactRefsJson: detailApp.artifactRefsJson || {},
                        lastVerificationJson: detailApp.lastVerificationJson || null,
                      }, null, 2)),
                  );
                })() : null,
              );
            }),
          ),
        builtAppBundlePreview ? h('div', {
          'data-testid': 'dxos-built-app-bundle-preview',
          style: { padding: 12, borderRadius: 8, border: '1px solid #bae6fd', background: '#f0f9ff', display: 'grid', gap: 8, fontSize: 12 },
        },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 } },
            h('strong', null, `Bundle v3 Preview: ${builtAppBundlePreview.appKey} (${builtAppBundlePreview.bundle?.metadata?.schemaVersion || 'latticedx.solution-bundle/v3'})`),
            h('button', { type: 'button', onClick: () => setBuiltAppBundlePreview(null), style: btnStyle(false) }, 'Đóng'),
          ),
          h('pre', { style: { margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 11, maxHeight: 280, overflowY: 'auto', background: '#fff', padding: 8, borderRadius: 6, border: '1px solid #cbd5e1' } },
            JSON.stringify(builtAppBundlePreview.bundle, null, 2)),
        ) : null,
      ) : null,

          tab === 'traces' ? h(AiTraceWaterfallPanel, {
            React,
            api,
            organizationId: activeOrgId,
          }) : null,

          tab === 'eval-lab' ? h(AiEvalLabPanel, {
            React,
            api,
            organizationId: activeOrgId,
          }) : null,
        ),
      ),
    );
  };
}

module.exports = {
  DEFAULT_TOOL_NAMES,
  DEFAULT_ROLE_OPTIONS,
  MODEL_PRESETS,
  QUICK_CONNECT_PROVIDER_DEFAULTS,
  BUILT_APP_QUICKSTART_PRESETS,
  createDxosAiStudioPage,
  buildProfileDraftFromStarter,
  createEmptyProfileDraft,
  resolveStudioDefaultOrg,
  parseToolModeMap,
  parseModelSelection,
  resolveTopologyRuntimeVersion,
  formatMetricEntries,
};
