/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const {
  SAFE_COLLECTION_RE,
  isSafeAppPath,
  filterHeroActions,
  parseKpiMetrics,
  fetchWorkflowTasks,
  fetchParaVault,
  fetchParaSummary,
  inferPortalSlugFromLocation,
  requestAndDownloadExport,
} = require('./blocks-helpers');
const { createCreativeStudioView, DEFAULT_CREATIVE_BLUEPRINT } = require('./creative-studio-block');
const { createRecordChatterView, createVoucherLifecycleBar } = require('./chatter-panel');
const {
  fetchPageSurfaceState,
  fetchInspectPageBlocks,
} = require('./canvas-architect-bridge');

const modelListeners = new WeakMap();
const activeModels = new Set();

function subscribeModelConfig(model, listener) {
  if (!model || typeof model !== 'object') return () => {};
  let set = modelListeners.get(model);
  if (!set) {
    set = new Set();
    modelListeners.set(model, set);
  }
  set.add(listener);
  activeModels.add(model);
  return () => {
    set.delete(listener);
    if (!set.size) activeModels.delete(model);
  };
}

function notifyModelListeners(model) {
  const set = model && modelListeners.get(model);
  if (!set) return;
  for (const fn of [...set]) {
    try { fn(); } catch {}
  }
}

function extractLiveConfig(model) {
  const stepCfg = model?.getStepParams?.('dxosBlockSettings', 'config')
    || model?.stepParams?.dxosBlockSettings?.config
    || {};
  const rawProps = model?.props || {};
  return { ...rawProps, ...stepCfg };
}

function readModelConfig(model, defaults, liveConfig) {
  const stepCfg = model?.getStepParams?.('dxosBlockSettings', 'config')
    || model?.stepParams?.dxosBlockSettings?.config
    || {};
  return { ...defaults, ...(model?.props || {}), ...stepCfg, ...(liveConfig || {}) };
}

function useBlockConfig(React, model, defaults, liveConfig) {
  const [, setTick] = React.useState(0);
  React.useEffect(() => subscribeModelConfig(model, () => setTick((t) => t + 1)), [model]);
  return readModelConfig(model, defaults, liveConfig);
}

function go(app, path) {
  if (!isSafeAppPath(path)) return;
  const full = app?.getRouteUrl?.(path) || path;
  if (app?.router?.navigate) {
    app.router.navigate(path);
  } else if (typeof window !== 'undefined' && window.location) {
    window.location.assign(full);
  }
}

const WORKBENCH_COLLECTION_ENUM = [
  { label: 'Yêu cầu mua sắm (latticeRequests)', value: 'latticeRequests' },
  { label: 'Đơn Logistics (latticeOrders)', value: 'latticeOrders' },
  { label: 'Phiếu dịch vụ nội bộ (latticeServiceTickets)', value: 'latticeServiceTickets' },
  { label: 'Tài sản (latticeAssets)', value: 'latticeAssets' },
  { label: 'Sự cố IoT (latticeIncidentCases)', value: 'latticeIncidentCases' },
  { label: 'Tài liệu P.A.R.A. (latticeParaDocuments)', value: 'latticeParaDocuments' },
];

const DEFAULT_HERO_ACTIONS = JSON.stringify([
  { label: 'Mở Không gian việc', path: '/admin/lattice-workspace' },
  { label: 'Kho tri thức P.A.R.A.', path: '/p/services' },
]);

const DEFAULT_KPI_METRICS = JSON.stringify([
  { label: 'Yêu cầu mua sắm', collection: 'latticeRequests', color: '#1677ff', targetPath: '/p/procurement' },
  { label: 'Đơn Logistics', collection: 'latticeOrders', color: '#10b981', targetPath: '/p/logistics' },
  { label: 'Sự cố IoT đang mở', collection: 'latticeIncidentCases', filter: { status: { $ne: 'closed' } }, color: '#fa8c16', targetPath: '/p/incidents' },
  { label: 'Phiếu dịch vụ nội bộ', collection: 'latticeServiceTickets', color: '#6366f1', targetPath: '/p/services' },
]);

function createBlockRenderers(client, React, antd, app) {
  const h = React.createElement;
  const useApi = typeof client?.useAPIClient === 'function' ? client.useAPIClient : () => app?.apiClient || null;
  const usePerms = typeof client?.useUIConfigurationPermissions === 'function'
    ? client.useUIConfigurationPermissions
    : () => ({ allowAll: false, actions: {} });
  const RecordChatterView = createRecordChatterView(client, React, app);
  const VoucherLifecycleBar = createVoucherLifecycleBar(client, React, app);

  function DxosPortalHeroView({ model, liveConfig }) {
    const api = useApi();
    const perms = usePerms();
    const cfg = useBlockConfig(React, model, {
      title: 'Không gian Điều hành Doanh nghiệp DX-OS',
      subtitle: 'Hợp nhất con người, quy trình Poka-yoke, dữ liệu thời gian thực và trí tuệ nhân tạo trên nền mở NocoBase.',
      badge: 'DX-OS H-P-D-I',
      accentColor: '#1677ff',
      actionsJson: DEFAULT_HERO_ACTIONS,
    }, liveConfig);
    const actions = filterHeroActions(cfg.actionsJson, perms);
    const accent = /^#[0-9a-fA-F]{3,8}$/.test(String(cfg.accentColor || '')) ? cfg.accentColor : '#1677ff';
    return h('section', {
      'data-testid': 'dxos-portal-hero-block',
      style: {
        borderRadius: 12,
        padding: '20px 24px',
        background: `linear-gradient(135deg, ${accent}14 0%, #ffffff 70%)`,
        border: `1px solid ${accent}40`,
      },
    },
      cfg.badge ? h('div', {
        style: {
          display: 'inline-block', padding: '2px 10px', borderRadius: 999,
          fontSize: 11, fontWeight: 700, color: accent, background: `${accent}1a`, marginBottom: 8,
        },
      }, String(cfg.badge)) : null,
      h('h2', { style: { margin: '0 0 6px', fontSize: 20, fontWeight: 700, color: '#0f172a' } }, String(cfg.title || '')),
      cfg.subtitle ? h('p', { style: { margin: '0 0 14px', fontSize: 13, color: '#475569' } }, String(cfg.subtitle)) : null,
      actions.length ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
        actions.map((btn, idx) => h('button', {
          key: idx,
          type: 'button',
          onClick: () => go(app, btn.path),
          style: {
            padding: '6px 14px', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600,
            border: `1px solid ${accent}`,
            background: btn.primary ? accent : '#ffffff',
            color: btn.primary ? '#ffffff' : accent,
          },
        }, btn.label)),
      ) : null,
    );
  }

  function DxosKpiMetricView({ model, liveConfig }) {
    const api = useApi();
    const cfg = useBlockConfig(React, model, {
      title: 'Chỉ số vận hành thời gian thực [D]',
      columns: 4,
      metricsJson: DEFAULT_KPI_METRICS,
    }, liveConfig);
    const metrics = React.useMemo(() => parseKpiMetrics(cfg.metricsJson), [cfg.metricsJson]);
    const [counts, setCounts] = React.useState({});
    const [loading, setLoading] = React.useState(true);

    const loadCounts = React.useCallback(async () => {
      if (!api?.request || !metrics.length) { setLoading(false); return; }
      setLoading(true);
      const next = {};
      await Promise.all(metrics.map(async (m, idx) => {
        try {
          const res = await api.request({
            url: `${m.collection}:list`,
            method: 'get',
            params: { pageSize: 1, filter: m.filter },
          });
          next[idx] = { count: Number(res?.data?.meta?.count ?? (Array.isArray(res?.data?.data) ? res.data.data.length : 0)) };
        } catch (err) {
          const status = Number(err?.response?.status ?? err?.status);
          next[idx] = { count: '—', note: status === 403 ? 'Không đủ quyền' : status === 404 ? 'Chưa bật module' : 'Tạm ẩn' };
        }
      }));
      setCounts(next);
      setLoading(false);
    }, [api, metrics]);

    React.useEffect(() => { loadCounts(); }, [loadCounts]);

    const cols = Math.max(1, Math.min(4, Number(cfg.columns) || 4));
    return h('div', { 'data-testid': 'dxos-kpi-metric-block' },
      h('div', { style: { display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 12 } },
        h('strong', { style: { fontSize: 15, color: '#0f172a', minWidth: 0 } }, String(cfg.title || 'KPI DX-OS')),
        h('button', { type: 'button', onClick: loadCounts, disabled: loading, style: { border: '1px solid #cbd5e1', background: '#fff', borderRadius: 6, padding: '2px 10px', cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap' } }, loading ? 'Đang tải…' : 'Làm mới'),
      ),
      h('div', { style: { display: 'grid', gridTemplateColumns: cols <= 1 ? 'minmax(0, 1fr)' : 'repeat(auto-fit, minmax(135px, 1fr))', gap: 12 } },
        metrics.map((m, idx) => {
          const entry = counts[idx] || {};
          return h('div', {
            key: `${m.collection}:${idx}`,
            onClick: m.targetPath ? () => go(app, m.targetPath) : undefined,
            style: {
              padding: 14, borderRadius: 10, border: '1px solid #e2e8f0', borderLeft: `4px solid ${m.color}`,
              background: '#fff', cursor: m.targetPath ? 'pointer' : 'default',
            },
          },
            h('div', { style: { fontSize: 12, color: '#64748b', marginBottom: 4 } }, m.label),
            h('div', { style: { fontSize: 24, fontWeight: 700, color: '#0f172a' } }, entry.count ?? '…'),
            entry.note ? h('div', { style: { fontSize: 11, color: '#94a3b8' } }, entry.note) : null,
          );
        }),
      ),
    );
  }

  function DxosContextTelemetryView({ model, liveConfig }) {
    const api = useApi();
    const cfg = useBlockConfig(React, model, {
      title: 'Ngữ cảnh NGSI-LD & Cảm biến [D]',
      assetEntityId: '',
      warningThreshold: '80',
      showSyncStatus: true,
    }, liveConfig);
    const [state, setState] = React.useState({ loading: true, data: null, error: '' });

    const load = React.useCallback(async () => {
      if (!api?.request) { setState({ loading: false, data: null, error: '' }); return; }
      setState((prev) => ({ ...prev, loading: true, error: '' }));
      try {
        const res = await api.request({
          url: 'dxosBlocks:contextTelemetry',
          method: 'post',
          data: { assetEntityId: String(cfg.assetEntityId || '').trim() || undefined },
        });
        setState({ loading: false, data: res?.data?.data || res?.data || null, error: '' });
      } catch (err) {
        setState({ loading: false, data: null, error: err?.response?.data?.errors?.[0]?.message || 'Không tải được dữ liệu ngữ cảnh NGSI-LD.' });
      }
    }, [api, cfg.assetEntityId]);

    React.useEffect(() => { load(); }, [load]);

    const data = state.data;
    return h('div', { 'data-testid': 'dxos-context-telemetry-block' },
      h('div', { style: { display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 10 } },
        h('strong', { style: { fontSize: 15 } }, String(cfg.title || 'NGSI-LD Context')),
        data?.brokerStatus ? h('span', {
          style: {
            fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999,
            background: data.brokerStatus === 'online' ? '#dcfce7' : '#fef3c7',
            color: data.brokerStatus === 'online' ? '#166534' : '#92400e',
          },
        }, `Orion-LD: ${data.brokerStatus}`) : null,
      ),
      state.error ? h('div', { style: { fontSize: 13, color: '#b45309' } }, state.error) : null,
      data?.asset ? h('div', { style: { fontSize: 13, color: '#334155', display: 'grid', gap: 6 } },
        h('div', null, `Tài sản: `, h('strong', null, `${data.asset.name} (${data.asset.code})`)),
        h('div', { style: { fontSize: 12, color: '#64748b' } }, `URN: ${data.asset.entityId}`),
        data.telemetry && Object.keys(data.telemetry).length ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 4 } },
          Object.entries(data.telemetry).slice(0, 6).map(([k, v]) => {
            const val = v && typeof v === 'object' && 'value' in v ? v.value : v;
            const warn = Number.isFinite(Number(val)) && Number.isFinite(Number(cfg.warningThreshold)) && Number(val) > Number(cfg.warningThreshold);
            return h('span', {
              key: k,
              style: {
                padding: '4px 10px', borderRadius: 6, fontSize: 12,
                background: warn ? '#fee2e2' : '#f1f5f9', color: warn ? '#991b1b' : '#0f172a',
              },
            }, `${k}: ${String(val)}`);
          }),
        ) : h('div', { style: { fontSize: 12, color: '#64748b' } }, 'Chưa có thuộc tính telemetry live hoặc broker đang tắt.'),
        cfg.showSyncStatus !== false && data.syncSummary ? h('div', { style: { fontSize: 12, color: '#475569' } },
          `Outbox đồng bộ — Đã gửi: ${data.syncSummary.delivered}, Đang chờ: ${data.syncSummary.pending}, Lỗi: ${data.syncSummary.failed}`,
        ) : null,
      ) : (!state.loading && !state.error ? h('div', { style: { fontSize: 13, color: '#64748b' } }, 'Chưa có tài sản trong tổ chức để giám sát.') : null),
    );
  }

  function DxosAiProposalView({ model, liveConfig }) {
    const api = useApi();
    const cfg = useBlockConfig(React, model, {
      title: 'Đề xuất AI & Bằng chứng nguồn [I]',
      targetCollection: 'latticeIncidentCases',
      state: 'all',
      pageSize: 5,
      showEvidence: true,
    }, liveConfig);
    const [state, setState] = React.useState({ loading: true, items: [], error: '' });

    React.useEffect(() => {
      if (!api?.request) { setState({ loading: false, items: [], error: '' }); return; }
      let active = true;
      api.request({
        url: 'dxosBlocks:proposals',
        method: 'post',
        data: {
          targetCollection: cfg.targetCollection || 'latticeIncidentCases',
          state: cfg.state || 'all',
          pageSize: Number(cfg.pageSize) || 5,
        },
      }).then((res) => {
        if (!active) return;
        const body = res?.data?.data || res?.data || {};
        setState({ loading: false, items: Array.isArray(body.items) ? body.items : [], error: '' });
      }).catch(() => {
        if (active) setState({ loading: false, items: [], error: 'Không tải được danh sách đề xuất AI.' });
      });
      return () => { active = false; };
    }, [api, cfg.targetCollection, cfg.state, cfg.pageSize]);

    return h('div', { 'data-testid': 'dxos-ai-proposal-block' },
      h('div', { style: { display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 10 } },
        h('strong', { style: { fontSize: 15 } }, String(cfg.title || 'Đề xuất AI')),
        h('span', { style: { fontSize: 11, color: '#64748b' } }, `${cfg.targetCollection} · ${state.items.length} mục`),
      ),
      state.error ? h('div', { style: { fontSize: 13, color: '#b45309' } }, state.error) : null,
      !state.loading && !state.items.length && !state.error
        ? h('div', { style: { fontSize: 13, color: '#64748b' } }, 'Chưa có đề xuất AI nào cho phân hệ này.')
        : h('div', { style: { display: 'grid', gap: 8 } },
          state.items.map((item) => h('div', {
            key: item.id,
            style: { padding: 10, borderRadius: 8, border: '1px solid #e2e8f0', background: '#f8fafc' },
          },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 12 } },
              h('strong', null, `#${item.targetRecordId}`),
              h('span', { style: { color: item.state === 'reviewed' ? '#166534' : '#92400e', fontWeight: 600 } }, item.state),
            ),
            h('div', { style: { fontSize: 13, color: '#1e293b' } }, String(item.recommendation || '')),
            cfg.showEvidence !== false && Array.isArray(item.evidence) && item.evidence.length
              ? h('div', { style: { marginTop: 4, fontSize: 11, color: '#64748b' } }, `Nguồn bằng chứng: ${item.evidence.map((e) => e.kind).join(', ')}`)
              : null,
          )),
        ),
    );
  }

  function DxosWorkflowTasksView({ model, liveConfig }) {
    const api = useApi();
    const cfg = useBlockConfig(React, model, {
      title: 'Hộp việc Quy trình Poka-yoke [P]',
      statusFilter: 'pending',
      pageSize: 6,
    }, liveConfig);
    const [state, setState] = React.useState({ loading: true, items: [], error: '' });

    React.useEffect(() => {
      let active = true;
      fetchWorkflowTasks(api, { statusFilter: cfg.statusFilter, pageSize: cfg.pageSize })
        .then((res) => { if (active) setState({ loading: false, items: res.items, error: '' }); })
        .catch(() => { if (active) setState({ loading: false, items: [], error: 'Không tải được công việc được giao.' }); });
      return () => { active = false; };
    }, [api, cfg.statusFilter, cfg.pageSize]);

    return h('div', { 'data-testid': 'dxos-workflow-tasks-block' },
      h('div', { style: { display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 10 } },
        h('strong', { style: { fontSize: 15 } }, String(cfg.title || 'Công việc của tôi')),
        h('button', {
          type: 'button',
          onClick: () => go(app, '/admin/lattice-workspace'),
          style: { border: '1px solid #cbd5e1', borderRadius: 6, background: '#fff', padding: '2px 10px', cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap' },
        }, 'Mở tất cả'),
      ),
      state.error ? h('div', { style: { fontSize: 13, color: '#b45309' } }, state.error) : null,
      !state.loading && !state.items.length && !state.error
        ? h('div', { style: { fontSize: 13, color: '#64748b' } }, 'Hiện không có tác vụ cần xử lý.')
        : h('div', { style: { display: 'grid', gap: 6 } },
          state.items.map((task) => h('div', {
            key: task.id,
            style: { display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 6, padding: '8px 10px', borderRadius: 8, border: '1px solid #e2e8f0', background: '#fff' },
          },
            h('div', null,
              h('div', { style: { fontSize: 13, fontWeight: 600, color: '#0f172a' } }, task.node?.title || `Tác vụ #${task.id}`),
              h('div', { style: { fontSize: 11, color: '#64748b' } }, task.workflow?.title || 'Workflow native'),
            ),
            h('span', { style: { fontSize: 11, fontWeight: 600, color: task.status === 0 ? '#b45309' : '#166534' } }, task.status === 0 ? 'Cần xử lý' : 'Đã xử lý'),
          )),
        ),
    );
  }

  function DxosParaVaultView({ model, liveConfig }) {
    const api = useApi();
    const cfg = useBlockConfig(React, model, {
      title: 'Kho tri thức P.A.R.A. [H]',
      paraSpace: 'all',
      pageSize: 6,
      enableQuickCreate: true,
      defaultOrganizationId: '',
    }, liveConfig);
    const [space, setSpace] = React.useState(cfg.paraSpace || 'all');
    const [search, setSearch] = React.useState('');
    const [state, setState] = React.useState({ loading: true, items: [], pluginDisabled: false, error: '' });
    const [orgInfo, setOrgInfo] = React.useState({ loaded: false, organizationId: null, organizations: [] });
    const [selectedOrg, setSelectedOrg] = React.useState(cfg.defaultOrganizationId || '');
    const [creating, setCreating] = React.useState(false);
    const [draftTitle, setDraftTitle] = React.useState('');
    const [draftCode, setDraftCode] = React.useState('');

    const load = React.useCallback(async () => {
      setState((prev) => ({ ...prev, loading: true, error: '' }));
      try {
        const [res, summary] = await Promise.all([
          fetchParaVault(api, { paraSpace: space, search, pageSize: cfg.pageSize }),
          fetchParaSummary(api),
        ]);
        setState({ loading: false, items: res.items, pluginDisabled: res.pluginDisabled, error: '' });
        setOrgInfo({ loaded: true, organizationId: summary.organizationId, organizations: summary.organizations || [] });
        if (summary.organizationId == null) {
          const fallback = cfg.defaultOrganizationId || summary.organizations?.[0] || 'native-ui-lab';
          setSelectedOrg((prev) => (prev && (summary.organizations || []).includes(prev) ? prev : fallback));
        }
      } catch {
        setState({ loading: false, items: [], pluginDisabled: false, error: 'Không tải được tài liệu P.A.R.A.' });
      }
    }, [api, space, search, cfg.pageSize, cfg.defaultOrganizationId]);

    React.useEffect(() => { setSpace(cfg.paraSpace || 'all'); }, [cfg.paraSpace]);
    React.useEffect(() => { load(); }, [load]);

    const isRootAdmin = orgInfo.loaded && orgInfo.organizationId === null;
    const orgChoices = orgInfo.organizations.length ? orgInfo.organizations : ['native-ui-lab'];

    async function handleQuickCreate(e) {
      e.preventDefault();
      if (!api?.request || !draftTitle.trim() || creating) return;
      setCreating(true);
      try {
        const code = (draftCode.trim() || `PARA-${Date.now().toString(36).toUpperCase()}`);
        const data = { code, title: draftTitle.trim(), paraSpace: space === 'all' ? 'projects' : space, status: 'active' };
        if (isRootAdmin) {
          data.organizationId = String(selectedOrg || cfg.defaultOrganizationId || orgChoices[0] || 'native-ui-lab').trim();
        }
        await api.request({ url: 'latticeParaDocuments:create', method: 'post', data });
        setDraftTitle('');
        setDraftCode('');
        await load();
      } catch (err) {
        const msg = err?.response?.data?.errors?.[0]?.message;
        setState((prev) => ({ ...prev, error: msg ? `Không tạo được tài liệu: ${msg}` : 'Không tạo được tài liệu (kiểm tra quyền / mã trùng).' }));
      } finally {
        setCreating(false);
      }
    }

    if (state.pluginDisabled) {
      return h('div', { 'data-testid': 'dxos-para-vault-disabled', style: { padding: 12, borderRadius: 8, background: '#fff7ed', border: '1px solid #fed7aa', color: '#9a3412', fontSize: 13 } },
        'Plugin @latticedx/plugin-dxos-para hiện đang tắt hoặc chưa sẵn sàng. Bật plugin trong Plugin Manager để dùng Kho tri thức P.A.R.A.');
    }

    const tabs = [['all', 'Tất cả'], ['projects', 'Projects'], ['areas', 'Areas'], ['resources', 'Resources'], ['archives', 'Archives']];
    return h('div', { 'data-testid': 'dxos-para-vault-block' },
      h('div', { style: { display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 10 } },
        h('strong', { style: { fontSize: 15 } }, String(cfg.title || 'Kho P.A.R.A.')),
        h('input', {
          type: 'search', value: search, placeholder: 'Tìm tài liệu...',
          onChange: (e) => setSearch(e.target.value),
          style: { padding: '4px 10px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 12, maxWidth: '100%', minWidth: 0 },
        }),
      ),
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 } },
        tabs.map(([key, label]) => h('button', {
          key, type: 'button', onClick: () => setSpace(key),
          style: {
            padding: '3px 10px', borderRadius: 999, fontSize: 12, cursor: 'pointer',
            border: '1px solid #cbd5e1',
            background: space === key ? '#1677ff' : '#fff',
            color: space === key ? '#fff' : '#334155',
          },
        }, label)),
      ),
      cfg.enableQuickCreate !== false ? h('form', { onSubmit: handleQuickCreate, style: { display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' } },
        isRootAdmin ? h('select', {
          value: selectedOrg || orgChoices[0],
          onChange: (e) => setSelectedOrg(e.target.value),
          'aria-label': 'Tổ chức',
          style: { padding: '4px 8px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 12, background: '#fff' },
        }, orgChoices.map((oid) => h('option', { key: oid, value: oid }, oid))) : null,
        h('input', { value: draftCode, placeholder: 'Mã (tùy chọn)', onChange: (e) => setDraftCode(e.target.value), style: { flex: '0 1 120px', minWidth: 0, maxWidth: '100%', padding: '4px 8px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 12 } }),
        h('input', { value: draftTitle, placeholder: 'Tiêu đề tài liệu P.A.R.A. mới…', onChange: (e) => setDraftTitle(e.target.value), style: { flex: '1 1 150px', minWidth: 0, maxWidth: '100%', padding: '4px 8px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 12 } }),
        h('button', { type: 'submit', disabled: creating || !draftTitle.trim(), style: { padding: '4px 12px', borderRadius: 6, border: 'none', background: '#0f766e', color: '#fff', fontSize: 12, cursor: 'pointer' } }, creating ? 'Đang lưu…' : '+ Thêm tài liệu'),
      ) : null,
      state.error ? h('div', { style: { fontSize: 12, color: '#b45309', marginBottom: 6 } }, state.error) : null,
      !state.loading && !state.items.length
        ? h('div', { style: { fontSize: 13, color: '#64748b' } }, 'Chưa có tài liệu nào trong phân vùng này.')
        : h('div', { style: { display: 'grid', gap: 6 } },
          state.items.map((doc) => h('div', {
            key: doc.id,
            style: { padding: '8px 10px', borderRadius: 8, border: '1px solid #e2e8f0', background: '#fff' },
          },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 13, fontWeight: 600 } },
              h('span', null, `${doc.code} — ${doc.title}`),
              h('span', { style: { fontSize: 11, color: '#4f46e5', textTransform: 'uppercase' } }, doc.paraSpace),
            ),
            doc.summary ? h('div', { style: { fontSize: 12, color: '#64748b', marginTop: 2 } }, doc.summary) : null,
          )),
        ),
    );
  }

  function DxosRecordWorkbenchView({ model, liveConfig }) {
    const api = useApi();
    const cfg = useBlockConfig(React, model, {
      title: 'Trao đổi Chatter, Chứng từ & Xuất báo cáo',
      collection: 'latticeRequests',
      recordId: '',
      showExport: true,
      showVoucherActions: true,
      showChatter: true,
    }, liveConfig);

    const safeCfgCollection = SAFE_COLLECTION_RE.test(String(cfg.collection || ''))
      ? String(cfg.collection)
      : 'latticeRequests';
    const [selectedCollection, setSelectedCollection] = React.useState(safeCfgCollection);
    const [recordIdInput, setRecordIdInput] = React.useState(String(cfg.recordId ?? '').trim());
    const [recentRecords, setRecentRecords] = React.useState([]);
    const [exportStatus, setExportStatus] = React.useState('');
    const [exportBusy, setExportBusy] = React.useState(false);

    React.useEffect(() => {
      setSelectedCollection(safeCfgCollection);
    }, [safeCfgCollection]);

    React.useEffect(() => {
      setRecordIdInput(String(cfg.recordId ?? '').trim());
    }, [cfg.recordId]);

    const activeCollection = SAFE_COLLECTION_RE.test(String(selectedCollection || ''))
      ? String(selectedCollection)
      : 'latticeRequests';
    const activeRecordId = Number(recordIdInput) > 0 ? Math.floor(Number(recordIdInput)) : 0;

    const loadRecentRecords = React.useCallback(async (isCancelled = () => false) => {
      if (!api?.request || !SAFE_COLLECTION_RE.test(activeCollection)) {
        if (!isCancelled()) setRecentRecords([]);
        return;
      }
      try {
        const res = await api.request({
          url: `${activeCollection}:list`,
          method: 'get',
          params: { pageSize: 20, sort: ['-id'] },
          skipNotify: true,
        });
        if (isCancelled()) return;
        const rows = Array.isArray(res?.data?.data) ? res.data.data : [];
        setRecentRecords(rows);
      } catch {
        if (!isCancelled()) setRecentRecords([]);
      }
    }, [api, activeCollection]);

    React.useEffect(() => {
      let cancelled = false;
      loadRecentRecords(() => cancelled);
      return () => { cancelled = true; };
    }, [loadRecentRecords]);

    const handleWorkbenchExport = async (format) => {
      if (!api?.request || exportBusy || !SAFE_COLLECTION_RE.test(activeCollection)) return;
      setExportBusy(true);
      try {
        setExportStatus(`Đang xuất ${format.toUpperCase()}…`);
        const { meta, download } = await requestAndDownloadExport(api, {
          collection: activeCollection,
          format,
          filter: activeRecordId > 0 ? { id: activeRecordId } : null,
        });
        const dlNote = download?.downloaded ? ' · Đã tải xuống' : '';
        setExportStatus(`Đã xuất ${meta.filename || format.toUpperCase()} (${meta.rowCount ?? 0} dòng)${dlNote}.`);
      } catch (err) {
        setExportStatus(err?.response?.data?.errors?.[0]?.message || 'Không xuất được báo cáo.');
      } finally {
        setExportBusy(false);
      }
    };

    const showControls = cfg.showVoucherActions !== false || cfg.showChatter !== false;

    return h('section', {
      'data-testid': 'dxos-record-workbench-block',
      style: {
        padding: 16,
        borderRadius: 12,
        border: '1px solid #cbd5e1',
        background: '#ffffff',
        display: 'grid',
        gap: 12,
        color: '#0f172a',
        minWidth: 0,
        maxWidth: '100%',
      },
    },
      h('div', { style: { display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 8 } },
        h('strong', { style: { fontSize: 15, color: '#0f172a', minWidth: 0, wordBreak: 'break-word' } }, String(cfg.title || 'Trao đổi Chatter, Chứng từ & Xuất báo cáo')),
        cfg.showExport !== false ? h('div', {
          'data-testid': 'dxos-workbench-export-bar',
          style: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' },
        },
          ['csv', 'xlsx', 'pdf'].map((fmt) => h('button', {
            key: fmt,
            type: 'button',
            disabled: exportBusy,
            onClick: () => handleWorkbenchExport(fmt),
            style: {
              padding: '5px 10px',
              borderRadius: 6,
              border: '1px solid #94a3b8',
              background: '#f8fafc',
              color: '#0f172a',
              fontSize: 11,
              fontWeight: 700,
              cursor: exportBusy ? 'wait' : 'pointer',
              whiteSpace: 'nowrap',
            },
          }, `Xuất ${fmt.toUpperCase()}`)),
        ) : null,
      ),
      exportStatus ? h('div', { style: { fontSize: 11, color: '#2563eb' } }, exportStatus) : null,
      showControls ? h('div', {
        style: {
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(135px, 1fr))',
          gap: 8,
          alignItems: 'center',
        },
      },
        h('select', {
          'aria-label': 'Lọc phân hệ nghiệp vụ',
          value: activeCollection,
          onChange: (e) => { setSelectedCollection(e.target.value); setRecordIdInput(''); },
          style: { minWidth: 0, width: '100%', padding: '5px 8px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 12, background: '#fff' },
        }, WORKBENCH_COLLECTION_ENUM.map((opt) => h('option', { key: opt.value, value: opt.value }, opt.label))),
        recentRecords.length ? h('select', {
          'aria-label': 'Chọn bản ghi',
          value: recordIdInput,
          onChange: (e) => setRecordIdInput(e.target.value),
          style: { minWidth: 0, width: '100%', padding: '5px 8px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 12, background: '#fff' },
        },
          h('option', { value: '' }, '-- Chọn bản ghi gần đây --'),
          recentRecords.map((rec) => h('option', { key: rec.id, value: String(rec.id) }, `${rec.code || `#${rec.id}`} — ${rec.name || rec.title || ''}`)),
        ) : null,
        h('input', {
          type: 'text',
          'aria-label': 'ID bản ghi',
          value: recordIdInput,
          onChange: (e) => setRecordIdInput(e.target.value),
          placeholder: 'Nhập ID bản ghi…',
          style: { minWidth: 0, width: '100%', boxSizing: 'border-box', padding: '5px 8px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 12 },
        }),
        h('button', {
          type: 'button',
          onClick: () => loadRecentRecords(),
          style: {
            padding: '5px 10px',
            borderRadius: 6,
            border: '1px solid #cbd5e1',
            background: '#f8fafc',
            color: '#0f172a',
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          },
        }, 'Làm mới'),
      ) : null,
      cfg.showVoucherActions !== false ? h(VoucherLifecycleBar, {
        targetCollection: activeCollection,
        targetRecordId: activeRecordId,
        onUpdated: (updated) => {
          if (updated?.id && Number(updated.id) !== activeRecordId) {
            setRecordIdInput(String(updated.id));
          }
          loadRecentRecords();
        },
      }) : null,
      cfg.showChatter !== false ? h(RecordChatterView, {
        targetCollection: activeCollection,
        targetRecordId: activeRecordId,
        showExport: false,
      }) : null,
    );
  }

  return {
    DxosPortalHeroView,
    DxosKpiMetricView,
    DxosContextTelemetryView,
    DxosAiProposalView,
    DxosWorkflowTasksView,
    DxosParaVaultView,
    DxosCreativeStudioView: createCreativeStudioView(client, React, antd, app, { subscribeModelConfig }),
    DxosRecordWorkbenchView,
  };
}

function registerDxosBlockModels(client, React, antd, clientV2, flowEngine, app) {
  const BaseBlockModel = clientV2?.BlockModel || flowEngine?.getModelClass?.('BlockModel');
  if (!BaseBlockModel || typeof flowEngine?.registerModels !== 'function') return {};

  const h = React.createElement;
  const views = createBlockRenderers(client, React, antd, app);

  class DxosPortalHeroBlockModel extends BaseBlockModel {
    renderComponent() { return h(views.DxosPortalHeroView, { model: this, liveConfig: extractLiveConfig(this) }); }
  }
  class DxosKpiMetricBlockModel extends BaseBlockModel {
    renderComponent() { return h(views.DxosKpiMetricView, { model: this, liveConfig: extractLiveConfig(this) }); }
  }
  class DxosContextTelemetryBlockModel extends BaseBlockModel {
    renderComponent() { return h(views.DxosContextTelemetryView, { model: this, liveConfig: extractLiveConfig(this) }); }
  }
  class DxosAiProposalBlockModel extends BaseBlockModel {
    renderComponent() { return h(views.DxosAiProposalView, { model: this, liveConfig: extractLiveConfig(this) }); }
  }
  class DxosWorkflowTasksBlockModel extends BaseBlockModel {
    renderComponent() { return h(views.DxosWorkflowTasksView, { model: this, liveConfig: extractLiveConfig(this) }); }
  }
  class DxosParaVaultBlockModel extends BaseBlockModel {
    renderComponent() { return h(views.DxosParaVaultView, { model: this, liveConfig: extractLiveConfig(this) }); }
  }
  class DxosCreativeStudioBlockModel extends BaseBlockModel {
    renderComponent() { return h(views.DxosCreativeStudioView, { model: this, liveConfig: extractLiveConfig(this) }); }
  }
  class DxosRecordWorkbenchBlockModel extends BaseBlockModel {
    renderComponent() { return h(views.DxosRecordWorkbenchView, { model: this, liveConfig: extractLiveConfig(this) }); }
  }

  const specs = [
    [
      DxosPortalHeroBlockModel,
      'DX-OS Portal Hero & Quick Actions',
      {
        title: 'Không gian Điều hành Doanh nghiệp DX-OS',
        subtitle: 'Nền mở NocoBase 2.2.38 cho H–P–D–I',
        badge: 'DX-OS',
        accentColor: '#1677ff',
        actionsJson: DEFAULT_HERO_ACTIONS,
      },
      {
        title: { type: 'string', title: 'Tiêu đề Hero', 'x-decorator': 'FormItem', 'x-component': 'Input' },
        subtitle: { type: 'string', title: 'Mô tả ngắn', 'x-decorator': 'FormItem', 'x-component': 'Input.TextArea' },
        badge: { type: 'string', title: 'Nhãn Badge', 'x-decorator': 'FormItem', 'x-component': 'Input' },
        accentColor: { type: 'string', title: 'Mã màu nhấn (Hex)', 'x-decorator': 'FormItem', 'x-component': 'Input' },
        actionsJson: { type: 'string', title: 'Nút thao tác nhanh (JSON)', 'x-decorator': 'FormItem', 'x-component': 'Input.TextArea' },
      },
    ],
    [
      DxosKpiMetricBlockModel,
      'DX-OS KPI Metric Grid',
      { title: 'Chỉ số vận hành [D]', columns: 4, metricsJson: DEFAULT_KPI_METRICS },
      {
        title: { type: 'string', title: 'Tiêu đề', 'x-decorator': 'FormItem', 'x-component': 'Input' },
        columns: { type: 'number', title: 'Số cột (1-4)', 'x-decorator': 'FormItem', 'x-component': 'InputNumber' },
        metricsJson: { type: 'string', title: 'Danh sách thẻ KPI (JSON)', 'x-decorator': 'FormItem', 'x-component': 'Input.TextArea' },
      },
    ],
    [
      DxosContextTelemetryBlockModel,
      'DX-OS NGSI-LD Context & Telemetry',
      { title: 'Ngữ cảnh NGSI-LD & Cảm biến [D]', assetEntityId: '', warningThreshold: '80', showSyncStatus: true },
      {
        title: { type: 'string', title: 'Tiêu đề', 'x-decorator': 'FormItem', 'x-component': 'Input' },
        assetEntityId: { type: 'string', title: 'Asset Code hoặc URN (để trống = tự chọn)', 'x-decorator': 'FormItem', 'x-component': 'Input' },
        warningThreshold: { type: 'string', title: 'Ngưỡng cảnh báo số', 'x-decorator': 'FormItem', 'x-component': 'Input' },
        showSyncStatus: { type: 'boolean', title: 'Hiển thị trạng thái đồng bộ Outbox', 'x-decorator': 'FormItem', 'x-component': 'Switch' },
      },
    ],
    [
      DxosAiProposalBlockModel,
      'DX-OS AI Proposal & Evidence',
      { title: 'Đề xuất AI & Bằng chứng [I]', targetCollection: 'latticeIncidentCases', state: 'all', pageSize: 5, showEvidence: true },
      {
        title: { type: 'string', title: 'Tiêu đề', 'x-decorator': 'FormItem', 'x-component': 'Input' },
        targetCollection: {
          type: 'string', title: 'Collection nghiệp vụ', 'x-decorator': 'FormItem', 'x-component': 'Select',
          enum: [
            { label: 'Sự cố IoT (latticeIncidentCases)', value: 'latticeIncidentCases' },
            { label: 'Tài sản (latticeAssets)', value: 'latticeAssets' },
            { label: 'Yêu cầu mua sắm (latticeRequests)', value: 'latticeRequests' },
            { label: 'Đơn Logistics (latticeOrders)', value: 'latticeOrders' },
            { label: 'Dịch vụ nội bộ (latticeServiceTickets)', value: 'latticeServiceTickets' },
          ],
        },
        state: {
          type: 'string', title: 'Trạng thái đề xuất', 'x-decorator': 'FormItem', 'x-component': 'Select',
          enum: [{ label: 'Tất cả', value: 'all' }, { label: 'Chờ duyệt', value: 'proposed' }, { label: 'Đã xem xét', value: 'reviewed' }],
        },
        pageSize: { type: 'number', title: 'Số dòng tối đa', 'x-decorator': 'FormItem', 'x-component': 'InputNumber' },
        showEvidence: { type: 'boolean', title: 'Hiển thị nguồn bằng chứng', 'x-decorator': 'FormItem', 'x-component': 'Switch' },
      },
    ],
    [
      DxosWorkflowTasksBlockModel,
      'DX-OS Workflow & My Tasks',
      { title: 'Hộp việc Quy trình Poka-yoke [P]', statusFilter: 'pending', pageSize: 6 },
      {
        title: { type: 'string', title: 'Tiêu đề', 'x-decorator': 'FormItem', 'x-component': 'Input' },
        statusFilter: {
          type: 'string', title: 'Lọc trạng thái', 'x-decorator': 'FormItem', 'x-component': 'Select',
          enum: [{ label: 'Cần xử lý', value: 'pending' }, { label: 'Đã xử lý', value: 'resolved' }, { label: 'Tất cả', value: 'all' }],
        },
        pageSize: { type: 'number', title: 'Số lượng tối đa', 'x-decorator': 'FormItem', 'x-component': 'InputNumber' },
      },
    ],
    [
      DxosParaVaultBlockModel,
      'DX-OS P.A.R.A. Knowledge Vault',
      { title: 'Kho tri thức P.A.R.A. [H]', paraSpace: 'all', pageSize: 6, enableQuickCreate: true, defaultOrganizationId: '' },
      {
        title: { type: 'string', title: 'Tiêu đề', 'x-decorator': 'FormItem', 'x-component': 'Input' },
        paraSpace: {
          type: 'string', title: 'Phân vùng mặc định', 'x-decorator': 'FormItem', 'x-component': 'Select',
          enum: [
            { label: 'Tất cả', value: 'all' },
            { label: 'Projects (Dự án)', value: 'projects' },
            { label: 'Areas (Lĩnh vực)', value: 'areas' },
            { label: 'Resources (Tài nguyên)', value: 'resources' },
            { label: 'Archives (Lưu trữ)', value: 'archives' },
          ],
        },
        pageSize: { type: 'number', title: 'Số tài liệu hiển thị', 'x-decorator': 'FormItem', 'x-component': 'InputNumber' },
        enableQuickCreate: { type: 'boolean', title: 'Cho phép tạo nhanh trên block', 'x-decorator': 'FormItem', 'x-component': 'Switch' },
        defaultOrganizationId: { type: 'string', title: 'Mã tổ chức mặc định (Admin)', 'x-decorator': 'FormItem', 'x-component': 'Input' },
      },
    ],
    [
      DxosCreativeStudioBlockModel,
      'DX-OS Creative Studio Micro-App [AI]',
      { title: 'Buồng Điều hành Thông minh [AI Studio]', blueprintJson: DEFAULT_CREATIVE_BLUEPRINT },
      {
        title: { type: 'string', title: 'Tiêu đề Block', 'x-decorator': 'FormItem', 'x-component': 'Input' },
        blueprintJson: { type: 'string', title: 'Cấu hình DSL Sáng tạo (JSON)', 'x-decorator': 'FormItem', 'x-component': 'Input.TextArea' },
      },
    ],
    [
      DxosRecordWorkbenchBlockModel,
      'DX-OS Chatter, Chứng từ & Xuất báo cáo',
      {
        title: 'Trao đổi Chatter, Chứng từ & Xuất báo cáo',
        collection: 'latticeRequests',
        recordId: '',
        showExport: true,
        showVoucherActions: true,
        showChatter: true,
      },
      {
        title: { type: 'string', title: 'Tiêu đề Block', 'x-decorator': 'FormItem', 'x-component': 'Input' },
        collection: {
          type: 'string',
          title: 'Collection nghiệp vụ',
          'x-decorator': 'FormItem',
          'x-component': 'Select',
          enum: WORKBENCH_COLLECTION_ENUM,
        },
        recordId: { type: 'string', title: 'ID bản ghi (tùy chọn)', 'x-decorator': 'FormItem', 'x-component': 'Input' },
        showExport: { type: 'boolean', title: 'Hiển thị thanh Xuất báo cáo', 'x-decorator': 'FormItem', 'x-component': 'Switch' },
        showVoucherActions: { type: 'boolean', title: 'Hiển thị nút Vòng đời chứng từ', 'x-decorator': 'FormItem', 'x-component': 'Switch' },
        showChatter: { type: 'boolean', title: 'Hiển thị Nhật ký Chatter', 'x-decorator': 'FormItem', 'x-component': 'Switch' },
      },
    ],
  ];

  const models = {};
  for (const [ModelClass, label, defaultParams, uiSchema] of specs) {
    ModelClass.define({ label });
    ModelClass.registerFlow({
      key: 'dxosBlockSettings',
      title: 'Tùy biến Block DX-OS',
      on: 'beforeRender',
      steps: {
        config: {
          title: 'Cấu hình nội dung',
          defaultParams,
          uiSchema,
          handler(ctx, params) {
            ctx.model.setProps(params || {});
            notifyModelListeners(ctx.model);
          },
        },
      },
    });
    models[ModelClass.name] = ModelClass;
  }

  flowEngine.registerModels(models);
  return models;
}

module.exports = { registerDxosBlockModels, readModelConfig };
