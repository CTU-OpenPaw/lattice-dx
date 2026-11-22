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
  'dxos_my_tasks_copilot',
  'dxos_orchestrate_enterprise_case',
];

const DEFAULT_ROLE_OPTIONS = [
  'root', 'admin', 'ldx_admin', 'ldx_director', 'ldx_manager',
  'ldx_employee', 'ldx_warehouse', 'ldx_dispatcher', 'ldx_driver',
];

const DEFAULT_PORTALS = ['procurement', 'logistics', 'incidents', 'services', 'admin-studio'];

function parseToolModeMap(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [k, v] of Object.entries(input)) {
    const mode = String(v || 'OFF').toUpperCase();
    out[k] = mode === 'ALLOW' || mode === 'ASK' ? mode : 'OFF';
  }
  return out;
}

function createEmptyProfileDraft() {
  return {
    username: '',
    nickname: '',
    position: 'Trợ lý AI Phòng ban',
    departmentScope: 'general',
    organizationId: 'native-ui-lab',
    llmService: 'local-9router',
    modelName: 'ag/gemini-3.8-flash',
    enabled: true,
    isAdminBuilder: false,
    allowSubAgentDispatch: false,
    allowedRoles: ['ldx_employee', 'ldx_manager'],
    toolPermissions: {
      dxos_search_enterprise_context: 'ALLOW',
      dxos_execute_record_action: 'ASK',
      dxos_my_tasks_copilot: 'ALLOW',
    },
    mcpServers: [{ name: 'dxos-it-ot-mcp', url: 'http://127.0.0.1:13000/api/dxos-mcp/it-ot', useUserContext: true, enabled: true }],
    portalBindings: ['services'],
    quickPrompts: [{ label: 'Tóm tắt công việc & SOP', prompt: 'Kiểm tra công việc chờ xử lý và tra cứu SOP liên quan.' }],
    greeting: 'Xin chào! Tôi là nhân sự AI được cấu hình từ DX-OS AI Studio.',
    systemPrompt: 'Trả lời ngắn gọn bằng tiếng Việt, luôn trích dẫn mã tham chiếu bản ghi [collection:code#id].',
  };
}

function buildProfileDraftFromStarter(profile = {}) {
  const baseSlug = String(profile.username || 'custom-ai').replace(/[^a-z0-9_-]/gi, '').slice(0, 40) || 'custom-ai';
  const suffix = Math.floor(100 + Math.random() * 899);
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
  });

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
    const [draft, setDraft] = React.useState(() => createEmptyProfileDraft());
    const [mcpText, setMcpText] = React.useState(() => JSON.stringify(createEmptyProfileDraft().mcpServers, null, 2));
    const [promptsText, setPromptsText] = React.useState(() => JSON.stringify(createEmptyProfileDraft().quickPrompts, null, 2));

    const selectDraft = (next) => {
      const normalized = {
        ...createEmptyProfileDraft(),
        ...next,
        toolPermissions: parseToolModeMap(next?.toolPermissions),
        allowedRoles: Array.isArray(next?.allowedRoles) ? next.allowedRoles : ['ldx_employee'],
        portalBindings: Array.isArray(next?.portalBindings) ? next.portalBindings : [],
      };
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
        if (Array.isArray(pData.profiles)) setProfiles(pData.profiles);
        if (pData.catalog) setCatalog(pData.catalog);

        const [tRes, aRes] = await Promise.allSettled([
          api.request({ url: 'dxosAi:enterpriseTopology', method: 'get' }),
          api.request({ url: 'dxosAi:auditLogs', method: 'get', params: { pageSize: 40 } }),
        ]);
        if (tRes.status === 'fulfilled') {
          setTopology(tRes.value?.data?.data || tRes.value?.data || null);
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

    React.useEffect(() => {
      loadAll();
    }, [loadAll]);

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
        const res = await api.request({
          url: 'dxosAi:saveProfile',
          method: 'post',
          data: { ...draft, mcpServers, quickPrompts, defaultOrigin: origin },
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
    ];

    const availableTools = Array.isArray(catalog?.availableTools) ? catalog.availableTools : DEFAULT_TOOL_NAMES;
    const roleOptions = Array.isArray(catalog?.roleOptions) ? catalog.roleOptions : DEFAULT_ROLE_OPTIONS;

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
            'Điều phối hệ điều hành doanh nghiệp 6 phân hệ LatticeDX — NocoBase 2.2.38 đóng vai trò Plane #6 (appDataSubstrate), Powered by NocoBase (https://www.nocobase.com).'),
        ),
        h('div', { style: { display: 'flex', gap: 8 } },
          h('button', { type: 'button', onClick: handleBootstrap, disabled: busy, style: btnStyle(true) },
            busy ? 'Đang đồng bộ…' : 'Cài 5 Starter Blueprints & IT/OT MCP'),
          h('button', { type: 'button', onClick: loadAll, disabled: loading || busy, style: btnStyle(false) }, 'Làm mới'),
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

      h('div', { style: { display: 'flex', gap: 8, borderBottom: '1px solid #e2e8f0', paddingBottom: 10, flexWrap: 'wrap' } },
        tabItems.map(([key, label]) => h('button', {
          key,
          type: 'button',
          onClick: () => setTab(key),
          style: btnStyle(tab === key),
        }, label)),
      ),

      tab === 'topology' ? h('div', { style: { display: 'grid', gap: 12 } },
        h('div', { style: { padding: 14, borderRadius: 10, background: '#f8fafc', border: '1px solid #e2e8f0', fontSize: 13, color: '#334155' } },
          topology?.positioningStatement || 'LatticeDX điều phối đồng bộ 6 phân hệ Enterprise Digital OS; NocoBase 2.2.38 là phân hệ lưu trữ & metadata (Plane #6).'),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12 } },
          (topology?.planes || []).map((p) => h('div', {
            key: p.key,
            style: { padding: 16, borderRadius: 12, border: p.key === 'aiWorkforceAndMcp' ? '2px solid #0284c7' : '1px solid #e2e8f0', background: '#fff', display: 'grid', gap: 8 },
          },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
              h('strong', { style: { fontSize: 14, color: '#0f172a' } }, `Plane #${p.order}: ${p.name}`),
              h('span', { style: badgeStyle(p.healthy ? '#dcfce7' : '#fef3c7', p.healthy ? '#166534' : '#92400e') }, p.healthy ? 'Sẵn sàng' : 'Chờ kết nối'),
            ),
            h('div', { style: { fontSize: 12, color: '#475569' } }, (p.technologies || []).join(' · ')),
            h('div', { style: { fontSize: 11, color: '#64748b' } }, JSON.stringify(p.metrics || {})),
          )),
        ),
      ) : null,

      tab === 'workforce' ? h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(280px, 1fr) minmax(380px, 1.4fr)', gap: 16, alignItems: 'start' } },
        h('div', { style: { display: 'grid', gap: 10 } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
            h('strong', { style: { fontSize: 15 } }, `Nhân sự AI (${profiles.length})`),
            h('button', { type: 'button', onClick: () => selectDraft(createEmptyProfileDraft()), style: btnStyle(false) }, '+ Tạo mới'),
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
              h('input', { value: `${draft.llmService}:${draft.modelName}`, onChange: (e) => {
                const { llmService, modelName } = parseModelSelection(e.target.value);
                setDraft({ ...draft, llmService, modelName });
              }, style: { padding: 6, borderRadius: 6, border: '1px solid #cbd5e1' } })),
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
            h('span', { style: { fontSize: 12, fontWeight: 600 } }, 'Cổng Portal gắn Copilot Strip'),
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
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
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
              style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 10px', borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 12, gap: 8 },
            },
              h('div', null,
                h('strong', null, item.toolName),
                ` · ${item.channel} · actor=${item.actorUsername || item.actorUserId || 'anon'} · ${item.resultSummary || ''}`,
              ),
              h('span', { style: badgeStyle(item.status === 'allowed' ? '#dcfce7' : '#fee2e2', item.status === 'allowed' ? '#166534' : '#991b1b') },
                `${item.status}${item.errorCode ? ` (${item.errorCode})` : ''}`),
            )),
          ),
      ) : null,
    );
  };
}

module.exports = {
  createDxosAiStudioPage,
  buildProfileDraftFromStarter,
  createEmptyProfileDraft,
  parseToolModeMap,
  parseModelSelection,
};
