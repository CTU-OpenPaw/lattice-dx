/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { createDxosGovernanceConsoles, GOVERNANCE_SECTIONS } = require('./governance-consoles');
const { createBuilderBrokerPanels, parseJsonSafe } = require('./builder-broker-panels');
const { createFlowPinStorage } = require('./flow-pin-storage');
const { createPublicFormBuilderPanel } = require('./public-form-builder');
const { createApprovalInboxPanel } = require('./approval-inbox-panel');
const { createNotifyPanel } = require('./notify-panel');

const VALID_STUDIO_TABS = new Set([
  'workflows',
  'portals',
  'plugins',
  'pof',
  'outbox',
  'gitops',
  'broker',
  'automation',
  'builder',
  'forms',
  'approvals',
  'notify',
  'governance',
  ...GOVERNANCE_SECTIONS.map((s) => s.id),
]);

const STUDIO_NAV_GROUPS = Object.freeze([
  {
    id: 'apps-data',
    label: 'Ứng dụng & Dữ liệu',
    items: [
      ['portals', 'Portal Composer (Đa-Block)'],
      ['builder', 'Visual Domain Builder & Tenant'],
      ['forms', 'Biểu mẫu Công khai'],
      ['gitops', 'Gói cấu hình GitOps v3'],
    ],
  },
  {
    id: 'workflows-approvals',
    label: 'Quy trình & Phê duyệt',
    items: [
      ['workflows', 'Mẫu Quy trình & SLA'],
      ['approvals', 'Hộp thư Phê duyệt Thống nhất'],
    ],
  },
  {
    id: 'integrations-ops',
    label: 'Tích hợp & Vận hành',
    items: [
      ['automation', 'Vault & Automation Rules'],
      ['broker', 'Broker & Sự kiện'],
      ['notify', 'Kênh Thông báo & Nhật ký'],
      ['outbox', 'Hàng đợi Outbox & DLQ'],
      ['plugins', 'Hệ sinh thái 7 Plugin'],
      ['pof', 'Sẵn sàng PoF & Hệ thống'],
    ],
  },
]);

const SPACE_LABELS = Object.freeze({
  '[H]': 'Con người',
  '[P]': 'Quy trình',
  '[D]': 'Dữ liệu',
  '[I]': 'AI',
  '[W]': 'Chứng từ',
});

function formatPluginSpaces(spaces) {
  return (Array.isArray(spaces) ? spaces : [])
    .map((sp) => SPACE_LABELS[sp] || String(sp || '').replace(/^\[|\]$/g, ''))
    .filter(Boolean)
    .join(' · ');
}

function readInitialStudioTab() {
  try {
    const search = typeof window !== 'undefined' && window.location ? window.location.search : '';
    const raw = new URLSearchParams(search || '').get('tab') || '';
    return VALID_STUDIO_TABS.has(raw) ? raw : 'workflows';
  } catch {
    return 'workflows';
  }
}

function readInitialGovSection() {
  try {
    const search = typeof window !== 'undefined' && window.location ? window.location.search : '';
    const sec = new URLSearchParams(search || '').get('section') || '';
    return GOVERNANCE_SECTIONS.some((s) => s.id === sec) ? sec : 'api-keys';
  } catch {
    return 'api-keys';
  }
}

function createDxosStudioSettingsPage(client, React, antd, app) {
  const h = React.createElement;
  const useApi = typeof client?.useAPIClient === 'function' ? client.useAPIClient : () => app?.apiClient || null;
  const GovernanceConsoles = createDxosGovernanceConsoles(client, React, antd, app);
  const {
    BrokerAndEventsPanel,
    VaultAndAutomationPanel,
    DomainBuilderAndTenantsPanel,
  } = createBuilderBrokerPanels(client, React, antd, app);
  const PublicFormBuilderPanel = createPublicFormBuilderPanel(client, React, antd, app);
  const ApprovalInboxPanel = createApprovalInboxPanel(client, React, antd, app);
  const NotifyPanel = createNotifyPanel(client, React, antd, app);

  function openRoute(path) {
    const url = app?.getRouteUrl?.(path) || path;
    if (app?.router?.navigate) app.router.navigate(path);
    else if (typeof window !== 'undefined' && window.location) window.location.assign(url);
  }

  return function DxosStudioSettingsPage() {
    const api = useApi();
    const perm = typeof client?.useUIConfigurationPermissions === 'function'
      ? client.useUIConfigurationPermissions()
      : null;
    const uiDenied = Boolean(perm && perm.allowConfigUI === false);
    const [tab, setTab] = React.useState(readInitialStudioTab);
    const [loading, setLoading] = React.useState(true);
    const [templates, setTemplates] = React.useState([]);
    const [employees, setEmployees] = React.useState([]);
    const [organizations, setOrganizations] = React.useState([]);
    const [organizationCounts, setOrganizationCounts] = React.useState({});
    const [readiness, setReadiness] = React.useState(null);
    const [selectedTemplate, setSelectedTemplate] = React.useState('logistics-5step');
    const [selectedOrg, setSelectedOrg] = React.useState('');
    const [bindings, setBindings] = React.useState({});
    const [enableOnCreate, setEnableOnCreate] = React.useState(true);
    const [busyAction, setBusyAction] = React.useState(false);
    const [forbidden, setForbidden] = React.useState(uiDenied);
    const [feedback, setFeedback] = React.useState(null);
    const [outboxData, setOutboxData] = React.useState({ items: [], total: 0, summary: { pending: 0, retry: 0, processing: 0, failed: 0, delivered: 0 } });
    const [bundleText, setBundleText] = React.useState('');
    const [bundleInfo, setBundleInfo] = React.useState(null);
    const [enableBundleWorkflows, setEnableBundleWorkflows] = React.useState(false);
    const [govSection, setGovSection] = React.useState(readInitialGovSection);
    const [uploadedFileName, setUploadedFileName] = React.useState('');
    const [outboxState, setOutboxState] = React.useState('failed');
    const [outboxPage, setOutboxPage] = React.useState(1);
    const [expandedOutboxId, setExpandedOutboxId] = React.useState(null);
    const [confirmPurgeOutbox, setConfirmPurgeOutbox] = React.useState(false);

    const loadAll = React.useCallback(async () => {
      if (uiDenied) { setForbidden(true); setLoading(false); return; }
      if (!api?.request) { setLoading(false); return; }
      setLoading(true);
      try {
        const tmplRes = await api.request({ url: 'dxosStudio:listTemplates', method: 'get', skipNotify: true });
        const [empRes, readyRes] = await Promise.all([
          api.request({ url: 'dxosStudio:listEmployees', method: 'get', skipNotify: true }),
          api.request({ url: 'dxosStudio:readiness', method: 'get', skipNotify: true }),
        ]);
        const tList = tmplRes?.data?.data?.items || [];
        const eData = empRes?.data?.data || {};
        const rData = readyRes?.data?.data || null;
        setForbidden(false);
        setTemplates(tList);
        setEmployees(Array.isArray(eData.items) ? eData.items : []);
        const orgs = Array.isArray(eData.organizations) ? eData.organizations : [];
        setOrganizations(orgs);
        setOrganizationCounts(eData.organizationCounts || {});
        if (!selectedOrg && orgs.length) setSelectedOrg(orgs[0]);
        setReadiness(rData);
      } catch (err) {
        const status = Number(err?.response?.status ?? err?.status);
        if (status === 403 || status === 401) {
          setForbidden(true);
        } else {
          setFeedback({ type: 'error', text: 'Không tải được dữ liệu DX-OS Studio. Kiểm tra quyền quản trị.' });
        }
      } finally {
        setLoading(false);
      }
    }, [api, selectedOrg, uiDenied]);

    React.useEffect(() => { loadAll(); }, [loadAll]);

    const loadOutbox = React.useCallback(async (nextState = outboxState, nextPage = outboxPage) => {
      if (uiDenied || !api?.request) return;
      try {
        const res = await api.request({
          url: 'dxosStudio:outboxDlqList',
          method: 'get',
          params: {
            state: nextState || 'failed',
            page: nextPage || 1,
            pageSize: 20,
            ...(selectedOrg ? { organizationId: selectedOrg } : {}),
          },
          skipNotify: true,
        });
        const d = res?.data?.data || res?.data || {};
        setOutboxData({
          items: Array.isArray(d.items) ? d.items : [],
          total: Number(d.total || 0),
          page: Number(d.page || nextPage || 1),
          pageSize: Number(d.pageSize || 20),
          summary: d.summary || { pending: 0, retry: 0, processing: 0, failed: 0, delivered: 0 },
        });
      } catch (err) {
        const msg = err?.response?.data?.errors?.[0]?.message || err?.message || 'Không tải được hàng đợi Outbox / DLQ.';
        setFeedback({ type: 'error', text: msg });
      }
    }, [api, uiDenied, outboxState, outboxPage, selectedOrg]);

    React.useEffect(() => {
      if (!uiDenied && tab === 'outbox') loadOutbox(outboxState, outboxPage);
    }, [tab, loadOutbox, uiDenied, outboxState, outboxPage]);

    async function handleReplayDlq(eventIds) {
      if (!api?.request || busyAction) return;
      setBusyAction(true);
      setFeedback(null);
      try {
        const payload = Array.isArray(eventIds) && eventIds.length ? { eventIds } : {};
        const res = await api.request({ url: 'dxosStudio:outboxDlqReplay', method: 'post', data: payload });
        const d = res?.data?.data || res?.data || {};
        setFeedback({ type: 'success', text: `Đã đưa ${d.replayedCount || 0} bản ghi Outbox DLQ trở lại hàng đợi xử lý.` });
        await loadOutbox(outboxState, outboxPage);
      } catch (err) {
        setFeedback({ type: 'error', text: err?.response?.data?.errors?.[0]?.message || 'Không phát lại được hàng đợi DLQ.' });
      } finally {
        setBusyAction(false);
      }
    }

    async function handlePurgeOutbox() {
      if (!api?.request || busyAction) return;
      if (outboxState === 'pending' || outboxState === 'processing') {
        setConfirmPurgeOutbox(false);
        return;
      }
      setBusyAction(true);
      setFeedback(null);
      try {
        const targetState = outboxState === 'all' ? 'failed' : outboxState;
        const res = await api.request({
          url: 'dxosStudio:outboxDlqPurge',
          method: 'post',
          data: {
            state: targetState,
            ...(selectedOrg ? { organizationId: selectedOrg } : {}),
          },
        });
        const d = res?.data?.data || res?.data || {};
        setConfirmPurgeOutbox(false);
        setFeedback({ type: 'success', text: `Đã dọn ${d.purgedCount || 0} bản ghi Outbox (${d.state || targetState}).` });
        setOutboxPage(1);
        await loadOutbox(outboxState, 1);
      } catch (err) {
        setFeedback({ type: 'error', text: err?.response?.data?.errors?.[0]?.message || 'Không dọn được hàng đợi Outbox.' });
      } finally {
        setBusyAction(false);
      }
    }

    const activeTemplate = templates.find((t) => t.key === selectedTemplate) || templates[0];
    const orgEmployees = employees.filter((e) => !selectedOrg || e.organizationId === selectedOrg);

    React.useEffect(() => {
      if (!activeTemplate) return;
      if (!orgEmployees.length) { setBindings({}); return; }
      const next = {};
      const used = new Set();
      for (const req of activeTemplate.requiredBindings || []) {
        const match = orgEmployees.find((e) => !used.has(String(e.id)) && (!e.roles?.length || e.roles.some((r) => req.allowedRoles.includes(r))))
          || orgEmployees.find((e) => !used.has(String(e.id)));
        if (match) {
          next[req.field] = String(match.id);
          used.add(String(match.id));
        }
      }
      setBindings(next);
    }, [activeTemplate?.key, selectedOrg, orgEmployees.length]);

    async function handleInstallWorkflow(e) {
      e?.preventDefault?.();
      if (!api?.request || busyAction || !activeTemplate || !selectedOrg) return;
      setBusyAction(true);
      setFeedback(null);
      try {
        const res = await api.request({
          url: 'dxosStudio:installWorkflow',
          method: 'post',
          data: { templateKey: activeTemplate.key, organizationId: selectedOrg, enabled: enableOnCreate, ...bindings },
        });
        const data = res?.data?.data || res?.data || {};
        setFeedback({
          type: 'success',
          text: data.alreadyExists
            ? `Quy trình "${data.title}" đã tồn tại (#${data.workflowId}). Mở Workflow Designer để xem hoặc chỉnh.`
            : `Đã cài đặt quy trình "${data.title}" (#${data.workflowId}, ${data.nodeCount} nút).`,
          designerUrl: data.designerUrl,
        });
        await loadAll();
      } catch (err) {
        setFeedback({ type: 'error', text: err?.response?.data?.errors?.[0]?.message || 'Không cài đặt được quy trình.' });
      } finally {
        setBusyAction(false);
      }
    }

    async function handleComposePortals() {
      if (!api?.request || busyAction) return;
      setBusyAction(true);
      setFeedback(null);
      try {
        const res = await api.request({ url: 'dxosStudio:composePortals', method: 'post', data: {} });
        const data = res?.data?.data || res?.data || {};
        setFeedback({
          type: 'success',
          text: `Đã dựng/cập nhật cổng đa-block: thêm ${data.createdPages || 0} trang, gắn ${data.attachedBlocks || 0} DX-OS blocks${data.dxosBlocksAttached ? '' : ' (plugin-dxos-blocks đang tắt)'}.`,
        });
        await loadAll();
      } catch (err) {
        setFeedback({ type: 'error', text: err?.response?.data?.errors?.[0]?.message || 'Không dựng được cổng đa-block.' });
      } finally {
        setBusyAction(false);
      }
    }

    async function handleExportBundle() {
      if (!api?.request || busyAction) return;
      setBusyAction(true);
      setFeedback(null);
      try {
        const res = await api.request({ url: 'dxosStudio:solutionBundleExport', method: 'get', params: selectedOrg ? { organizationId: selectedOrg } : {} });
        const b = res?.data?.data || res?.data || {};
        const exportCounts = {
          roles: Array.isArray(b.roles) ? b.roles.length : 0,
          roleResources: Array.isArray(b.roles)
            ? b.roles.reduce((sum, r) => sum + (Array.isArray(r?.resources) ? r.resources.length : 0), 0)
            : 0,
          portals: Array.isArray(b.portals) ? b.portals.length : 0,
          workflows: Array.isArray(b.workflows) ? b.workflows.length : 0,
          customCollections: Array.isArray(b.customCollections) ? b.customCollections.length : 0,
          connectors: Array.isArray(b.connectors) ? b.connectors.length : 0,
          aiProfiles: Array.isArray(b.aiProfiles) ? b.aiProfiles.length : 0,
          governance: (Array.isArray(b?.governance?.decisionTables) ? b.governance.decisionTables.length : 0)
            + (Array.isArray(b?.governance?.slaPolicies) ? b.governance.slaPolicies.length : 0)
            + (Array.isArray(b?.governance?.incidentRules) ? b.governance.incidentRules.length : 0),
        };
        setBundleText(JSON.stringify(b, null, 2));
        setBundleInfo({
          sha256: b?.metadata?.contentSha256 || '',
          schemaVersion: b?.metadata?.schemaVersion || '',
          exportedAt: b?.metadata?.exportedAt || '',
          warnings: Array.isArray(b?.metadata?.warnings) ? b.metadata.warnings : [],
          counts: exportCounts,
        });
        setFeedback({ type: 'success', text: `Đã xuất ${b?.metadata?.schemaVersion || 'Solution Bundle'} (${(b?.metadata?.contentSha256 || '').slice(0, 12)}…).` });
      } catch (err) {
        setFeedback({ type: 'error', text: err?.response?.data?.errors?.[0]?.message || 'Không xuất được Solution Bundle.' });
      } finally {
        setBusyAction(false);
      }
    }

    async function handleBundleFileUpload(e) {
      const file = e?.target?.files?.[0];
      if (!file) return;
      try {
        let text = '';
        if (typeof file.text === 'function') {
          text = await file.text();
        } else if (typeof FileReader !== 'undefined') {
          text = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(new Error('Không đọc được tệp JSON.'));
            reader.readAsText(file);
          });
        }
        setBundleText(text);
        setUploadedFileName(String(file.name || 'bundle.json'));
        setBundleInfo(null);
        setFeedback({ type: 'success', text: `Đã nạp tệp "${file.name || 'bundle.json'}" (${text.length} ký tự). Bấm Kiểm tra Diff (Dry-Run) để xem thay đổi.` });
      } catch (err) {
        setFeedback({ type: 'error', text: err?.message || 'Không đọc được tệp JSON đã chọn.' });
      }
    }

    function handleDownloadBundle() {
      if (!bundleText.trim()) return;
      if (typeof Blob === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function' || typeof document === 'undefined') {
        return;
      }
      const blob = new Blob([bundleText], { type: 'application/json;charset=utf-8' });
      const href = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement('a');
        anchor.href = href;
        anchor.download = 'latticedx-solution-bundle.json';
        if (document.body && typeof document.body.appendChild === 'function') {
          document.body.appendChild(anchor);
          anchor.click();
          document.body.removeChild(anchor);
        } else if (typeof anchor.click === 'function') {
          anchor.click();
        }
      } finally {
        if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(href);
      }
    }

    async function handleImportBundle(dryRun) {
      if (!api?.request || busyAction) return;
      setBusyAction(true);
      setFeedback(null);
      try {
        const parsed = parseJsonSafe(bundleText || '{}');
        const res = await api.request({
          url: 'dxosStudio:solutionBundleImport',
          method: 'post',
          data: {
            bundle: parsed,
            dryRun,
            enableWorkflows: enableBundleWorkflows === true,
            organizationId: selectedOrg || undefined,
          },
        });
        const d = res?.data?.data || res?.data || {};
        setBundleInfo((prev) => ({
          ...(prev || {}),
          diff: d.diff || null,
          applied: d.applied || null,
          warnings: Array.isArray(d.warnings) ? d.warnings : [],
          lastSnapshotUid: d.snapshotUid || prev?.lastSnapshotUid || '',
        }));
        setFeedback({
          type: 'success',
          text: d.dryRun
            ? `Kiểm tra hợp lệ (Dry-Run) (+${d.diff?.summary?.added || 0} thêm, ~${d.diff?.summary?.changed || 0} đổi).`
            : `Đã áp dụng Gói (${d.snapshotUid || 'snapshot'}): ${d.applied?.rolesUpserted || 0} vai trò, ${d.applied?.roleResourcesUpserted || 0} quyền bảng, ${d.applied?.portalsUpserted || 0} cổng, ${d.applied?.workflowsUpserted || 0} quy trình, ${d.applied?.customCollectionsUpserted || 0} bảng tùy biến, ${d.applied?.aiProfilesUpserted || 0} nhân sự AI.`,
        });
        if (!d.dryRun) await loadAll();
      } catch (err) {
        setFeedback({ type: 'error', text: err?.response?.data?.errors?.[0]?.message || err?.message || 'Lỗi Solution Bundle JSON.' });
      } finally {
        setBusyAction(false);
      }
    }

    async function handleRollbackBundle() {
      if (!api?.request || busyAction) return;
      setBusyAction(true);
      setFeedback(null);
      try {
        const res = await api.request({
          url: 'dxosStudio:solutionBundleRollback',
          method: 'post',
          data: {
            organizationId: selectedOrg || undefined,
            enableWorkflows: enableBundleWorkflows === true,
          },
        });
        const d = res?.data?.data || res?.data || {};
        if (d.rolledBack === false) {
          setFeedback({ type: 'error', text: d.reason || 'Không tìm thấy snapshot GitOps để hoàn tác.' });
          return;
        }
        const restored = d.restored || {};
        setBundleInfo((prev) => ({
          ...(prev || {}),
          diff: null,
          lastSnapshotUid: d.snapshotUid || prev?.lastSnapshotUid || '',
          applied: restored,
          restored,
        }));
        setFeedback({
          type: 'success',
          text: `Đã hoàn tác về snapshot ${d.snapshotUid || 'gần nhất'}: ${restored.rolesUpserted || 0} roles, ${restored.roleResourcesUpserted || 0} roleResources, ${restored.portalsUpserted || 0} portals, ${restored.workflowsUpserted || 0} workflows, ${restored.customCollectionsUpserted || 0} customCollections, ${restored.aiProfilesUpserted || 0} aiProfiles.`,
        });
        await loadAll();
      } catch (err) {
        setFeedback({ type: 'error', text: err?.response?.data?.errors?.[0]?.message || err?.message || 'Không hoàn tác được Solution Bundle.' });
      } finally {
        setBusyAction(false);
      }
    }

    const btnStyle = (primary = false, danger = false, disabled = false) => ({
      padding: '8px 14px',
      borderRadius: 8,
      cursor: disabled ? 'not-allowed' : 'pointer',
      fontSize: 13,
      fontWeight: 600,
      border: disabled
        ? '1px solid #cbd5e1'
        : danger
          ? '1px solid #dc2626'
          : primary
            ? '1px solid #1677ff'
            : '1px solid #cbd5e1',
      background: disabled
        ? '#e2e8f0'
        : danger
          ? '#dc2626'
          : primary
            ? '#1677ff'
            : '#ffffff',
      color: disabled
        ? '#94a3b8'
        : (primary || danger)
          ? '#ffffff'
          : '#1e293b',
    });

    const railBtnStyle = (active = false) => ({
      width: '100%',
      textAlign: 'left',
      padding: '7px 10px',
      borderRadius: 8,
      cursor: 'pointer',
      fontSize: 12,
      fontWeight: active ? 700 : 500,
      border: active ? '1px solid #93c5fd' : '1px solid transparent',
      background: active ? '#eff6ff' : 'transparent',
      color: active ? '#1d4ed8' : '#334155',
      lineHeight: 1.35,
      boxSizing: 'border-box',
    });

    if (forbidden || uiDenied) {
      return h('div', { 'data-testid': 'dxos-studio-forbidden', style: { padding: 24, maxWidth: 720, margin: '24px auto', borderRadius: 12, border: '1px solid #fecaca', background: '#fef2f2', color: '#991b1b' } },
        h('h2', { style: { margin: '0 0 8px', fontSize: 18 } }, '403 — Chỉ Quản trị viên mới truy cập được DX-OS Control Studio'),
        h('p', { style: { margin: '0 0 12px', fontSize: 13 } }, 'Tài khoản hiện tại không có quyền quản trị cấu hình plugin/workflow. Vui lòng quay lại cổng làm việc của bạn.'),
        h('button', { type: 'button', onClick: () => openRoute('/admin/lattice-workspace'), style: btnStyle(true) }, 'Về Không gian việc của tôi'),
      );
    }

    const requiredCount = activeTemplate?.requiredBindings?.length || 0;
    const missingCrew = Boolean(activeTemplate && selectedOrg && orgEmployees.length < requiredCount);
    const isGovernanceTab = tab === 'governance' || GOVERNANCE_SECTIONS.some((s) => s.id === tab);
    const activeGovSection = tab === 'governance' ? govSection : (isGovernanceTab ? tab : govSection);

    return h('div', { className: 'dxos-studio-settings-page', 'data-testid': 'dxos-studio-settings-page', style: { padding: '20px 24px 64px', maxWidth: 1320, width: '100%', boxSizing: 'border-box', margin: '0 auto', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 16, minWidth: 0 } },
      h('style', null, [
        '@media (max-width: 1023px) {',
        '  .dxos-studio-shell { flex-direction: column !important; }',
        '  .dxos-studio-sidebar { width: 100% !important; flex: none !important; }',
        '  .dxos-studio-nav-group-items { flex-direction: row !important; flex-wrap: wrap !important; }',
        '  .dxos-studio-nav-group-items > button { width: auto !important; }',
        '}',
        '@media (max-width: 767px) {',
        '  .dxos-studio-settings-page { padding: 12px 10px 64px !important; }',
        '  .dxos-studio-content { width: 100% !important; min-width: 0 !important; max-width: 100% !important; }',
        '  .dxos-dmn-header { grid-template-columns: minmax(0, 1fr) !important; min-width: 0 !important; max-width: 100% !important; }',
        '}',
      ].join('\n')),
      h('div', { style: { display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, alignItems: 'center' } },
        h('div', null,
          h('h1', { style: { margin: '0 0 6px', fontSize: 22, fontWeight: 700, color: '#0f172a' } }, 'DX-OS Control Studio — Quản trị & Xây dựng Hệ thống'),
          h('p', { style: { margin: 0, color: '#475569', fontSize: 13 } }, 'Thiết kế phân hệ dữ liệu, dựng cổng đa-block, cài mẫu quy trình, cấu hình bảng quyết định DMN và kiểm tra sẵn sàng hệ thống.'),
        ),
        h('button', { type: 'button', onClick: () => openRoute('/admin/settings/dxos-ai'), style: btnStyle(true) }, 'Mở Trung tâm AI Workforce & 6 Không gian'),
      ),
      h('div', {
        className: 'dxos-studio-shell',
        'data-testid': 'dxos-studio-shell',
        style: { display: 'flex', alignItems: 'flex-start', gap: 18, minWidth: 0, maxWidth: '100%' },
      },
        h('aside', {
          className: 'dxos-studio-sidebar',
          'data-testid': 'dxos-studio-sidebar',
          style: {
            width: 224,
            flex: '0 0 224px',
            borderRadius: 12,
            border: '1px solid #e2e8f0',
            background: '#f8fafc',
            padding: 12,
            display: 'grid',
            gap: 14,
            boxSizing: 'border-box',
          },
        },
          h('div', {
            role: 'tablist',
            'aria-orientation': 'vertical',
            'aria-label': 'Danh mục DX-OS Studio',
            style: { display: 'flex', flexDirection: 'column', gap: 12 },
          },
            STUDIO_NAV_GROUPS.map((grp) => h('div', { key: grp.id, 'data-testid': `dxos-studio-nav-group-${grp.id}`, style: { display: 'grid', gap: 4 } },
              h('div', { style: { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#64748b', padding: '0 6px' } }, grp.label),
              h('div', { className: 'dxos-studio-nav-group-items', style: { display: 'flex', flexDirection: 'column', gap: 2 } },
                grp.items.map(([k, label]) => h('button', {
                  key: k,
                  type: 'button',
                  role: 'tab',
                  'data-testid': `dxos-studio-tab-${k}`,
                  'aria-selected': tab === k,
                  onClick: () => { setTab(k); setFeedback(null); },
                  style: railBtnStyle(tab === k),
                }, label)),
              ),
            )),
          ),
          h('div', {
            role: 'navigation',
            'aria-label': 'Quản trị & Quyết định DX-OS',
            'data-testid': 'dxos-studio-governance-nav',
            style: { display: 'grid', gap: 4, paddingTop: 10, borderTop: '1px solid #e2e8f0' },
          },
            h('div', { style: { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#64748b', padding: '0 6px' } }, 'Quản trị & Quyết định'),
            h('div', { className: 'dxos-studio-nav-group-items', style: { display: 'flex', flexDirection: 'column', gap: 2 } },
              GOVERNANCE_SECTIONS.map((sec) => {
                const active = isGovernanceTab && activeGovSection === sec.id;
                return h('button', {
                  key: sec.id,
                  type: 'button',
                  'data-testid': `dxos-studio-tab-${sec.id}`,
                  'aria-pressed': active,
                  onClick: () => { setTab('governance'); setGovSection(sec.id); setFeedback(null); },
                  style: railBtnStyle(active),
                }, sec.label);
              }),
            ),
          ),
          h('div', { style: { paddingTop: 10, borderTop: '1px solid #e2e8f0' } },
            h('button', {
              type: 'button',
              'data-testid': 'dxos-studio-link-connectors',
              onClick: () => openRoute('/admin/settings/workflow/connectors'),
              style: { ...railBtnStyle(false), color: '#0369a1', background: '#f0f9ff', border: '1px solid #bae6fd' },
            }, 'Ứng dụng Kết nối (Stock n8n) ↗'),
          ),
        ),
        h('main', {
          className: 'dxos-studio-content',
          'data-testid': 'dxos-studio-content',
          style: { flex: 1, minWidth: 0, maxWidth: '100%', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 14 },
        },
      feedback ? h('div', {
        role: 'status',
        style: {
          padding: 12, borderRadius: 8, fontSize: 13, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
          background: feedback.type === 'error' ? '#fef2f2' : '#f0fdf4',
          border: `1px solid ${feedback.type === 'error' ? '#fecaca' : '#bbf7d0'}`,
          color: feedback.type === 'error' ? '#991b1b' : '#166534',
        },
      },
        h('span', null, feedback.text),
        feedback.designerUrl ? h('button', { type: 'button', onClick: () => openRoute(feedback.designerUrl), style: { padding: '4px 10px', borderRadius: 6, border: '1px solid #166534', background: '#fff', color: '#166534', cursor: 'pointer', fontSize: 12 } }, 'Mở Workflow Designer') : null,
      ) : null,

      tab === 'workflows' ? h('form', { onSubmit: handleInstallWorkflow, style: { padding: 18, borderRadius: 12, border: '1px solid #e2e8f0', background: '#fff', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', minWidth: 0, gap: 14 } },
        h('div', null,
          h('label', { style: { display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 } }, 'Chọn mẫu quy trình DX-OS Poka-yoke'),
          h('select', {
            value: selectedTemplate,
            onChange: (e) => { setSelectedTemplate(e.target.value); setBindings({}); },
            style: { width: '100%', padding: 8, borderRadius: 6, border: '1px solid #cbd5e1' },
          }, templates.map((t) => h('option', { key: t.key, value: t.key }, `${t.title} (${t.collection})`))),
          activeTemplate ? h('p', { style: { margin: '6px 0 0', fontSize: 12, color: '#64748b' } }, activeTemplate.description) : null,
        ),
        h('div', null,
          h('label', { style: { display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 } }, 'Tổ chức áp dụng'),
          h('select', {
            value: selectedOrg,
            onChange: (e) => { setSelectedOrg(e.target.value); setBindings({}); },
            style: { width: '100%', padding: 8, borderRadius: 6, border: '1px solid #cbd5e1' },
          }, organizations.map((o) => h('option', { key: o, value: o }, `${o} (${organizationCounts[o] ?? employees.filter((e) => e.organizationId === o).length} nhân sự)`))),
        ),
        missingCrew ? h('div', {
          role: 'alert',
          style: { padding: 10, borderRadius: 8, background: '#fff7ed', border: '1px solid #fed7aa', color: '#9a3412', fontSize: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 },
        },
          h('span', null, `Tổ chức "${selectedOrg}" mới có ${orgEmployees.length} nhân sự; mẫu Poka-yoke này yêu cầu tối thiểu ${requiredCount} nhân sự khác nhau cho các vai trò phân tách.`),
          h('button', { type: 'button', onClick: () => openRoute('/p/services'), style: { padding: '4px 10px', borderRadius: 6, border: '1px solid #9a3412', background: '#fff', color: '#9a3412', cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap' } }, 'Mở Danh bạ Nhân viên'),
        ) : null,
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 } },
          (activeTemplate?.requiredBindings || []).map((req) => h('div', { key: req.field },
            h('label', { style: { display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 } }, req.label),
            h('select', {
              value: bindings[req.field] || '',
              onChange: (e) => setBindings((prev) => ({ ...prev, [req.field]: e.target.value })),
              style: { width: '100%', padding: 7, borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 12 },
            },
              h('option', { value: '' }, '-- Chọn nhân sự --'),
              orgEmployees.map((emp) => h('option', { key: emp.id, value: String(emp.id) }, `${emp.name} (${emp.code})${emp.roles?.length ? ` · ${emp.roles.join(',')}` : ''}`)),
            ),
          )),
        ),
        h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13 } },
          h('input', { type: 'checkbox', checked: enableOnCreate, onChange: (e) => setEnableOnCreate(e.target.checked) }),
          'Tự động kích hoạt quy trình ngay sau khi cài',
        ),
        h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } },
          h('button', { type: 'submit', disabled: busyAction || loading || !selectedOrg, style: btnStyle(true, false, busyAction || loading || !selectedOrg) }, busyAction ? 'Đang cài đặt…' : 'Cài đặt quy trình vào NocoBase'),
          h('button', { type: 'button', onClick: () => openRoute('/admin/settings/workflow'), style: btnStyle(false) }, 'Mở danh sách Workflow native'),
        ),
      ) : null,

      tab === 'portals' ? h('div', { style: { padding: 18, borderRadius: 12, border: '1px solid #e2e8f0', background: '#fff', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', minWidth: 0, gap: 12 } },
        h('h3', { style: { margin: 0, fontSize: 16 } }, 'Dựng & Nâng cấp 4 Cổng Đa-Block'),
        h('p', { style: { margin: 0, fontSize: 13, color: '#475569' } }, 'Tự động tạo trang Dịch vụ Nội bộ & Tài liệu P.A.R.A., kèm 4 trang Tổng quan kết hợp Hero + KPI + Việc của tôi + NGSI-LD + Đề xuất AI + Kho P.A.R.A. mà không ghi đè trang bạn đã tự thiết kế.'),
        h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } },
          h('button', { type: 'button', onClick: handleComposePortals, disabled: busyAction, style: btnStyle(true, false, busyAction) }, busyAction ? 'Đang xử lý…' : 'Dựng Cổng Đa-Block ngay'),
          h('button', { type: 'button', onClick: () => openRoute('/admin/settings/multi-portal'), style: btnStyle(false) }, 'Quản lý Multi-Portal'),
          h('button', { type: 'button', onClick: () => openRoute('/p/procurement'), style: btnStyle(false) }, 'Mở Cổng Mua sắm'),
          h('button', { type: 'button', onClick: () => openRoute('/p/logistics'), style: btnStyle(false) }, 'Mở Cổng Logistics'),
          h('button', { type: 'button', onClick: () => openRoute('/p/services'), style: btnStyle(false) }, 'Mở Cổng P.A.R.A. & Dịch vụ'),
        ),
      ) : null,

      tab === 'plugins' ? h('div', { style: { padding: 18, borderRadius: 12, border: '1px solid #e2e8f0', background: '#fff', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', minWidth: 0, gap: 12 } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('h3', { style: { margin: 0, fontSize: 16 } }, 'Hệ sinh thái 7 Plugin Apache-2.0 Open-Core'),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            h('button', { type: 'button', onClick: () => openRoute('/admin/settings/dxos-ai'), style: btnStyle(true) }, 'Mở AI Workforce & 6-Plane Center'),
            h('button', { type: 'button', onClick: () => openRoute('/admin/pm/list'), style: btnStyle(false) }, 'Mở Trình quản lý Plugin (bật/tắt trực tiếp)'),
          ),
        ),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 10 } },
          (readiness?.plugins || []).map((p) => h('div', { key: p.packageName, style: { padding: 12, borderRadius: 8, border: '1px solid #e2e8f0', background: '#f8fafc' } },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 13, fontWeight: 700 } },
              h('span', null, p.title),
              h('span', { style: { color: p.enabled ? '#166534' : '#9a3412', fontSize: 11 } }, p.enabled ? 'Đang bật' : 'Đang tắt'),
            ),
            h('div', { style: { fontSize: 12, color: '#64748b' } }, `${p.packageName} v${p.version} · ${p.license}`),
            h('div', { style: { fontSize: 11, color: '#4f46e5', marginTop: 4 } }, `Phạm vi: ${formatPluginSpaces(p.spaces)}`),
          )),
        ),
      ) : null,

      tab === 'pof' ? h('div', { style: { padding: 18, borderRadius: 12, border: '1px solid #e2e8f0', background: '#fff', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', minWidth: 0, gap: 10 } },
        h('h3', { style: { margin: 0, fontSize: 16 } }, 'Chỉ số Hệ thống & Tuân thủ Nguồn mở (PoF)'),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 } },
          [
            ['Portals đang quản lý', readiness?.portalCount ?? 0],
            ['Workflow native', readiness?.workflowCount ?? 0],
            ['Tài liệu P.A.R.A.', readiness?.paraDocumentCount ?? 0],
            ['Phiếu dịch vụ nội bộ', readiness?.serviceTicketCount ?? 0],
          ].map(([label, valNum]) => h('div', { key: label, style: { padding: 12, borderRadius: 8, border: '1px solid #e2e8f0' } },
            h('div', { style: { fontSize: 12, color: '#64748b' } }, label),
            h('div', { style: { fontSize: 22, fontWeight: 700 } }, valNum),
          )),
        ),
        h('div', { style: { fontSize: 13, color: '#334155' } }, `Nhận diện Điều 5.2 NocoBase: ${readiness?.clause52Attribution || 'Powered by NocoBase'}`),
      ) : null,

      tab === 'outbox' ? (() => {
        const purgeUnsupportedState = outboxState === 'pending' || outboxState === 'processing';
        const purgeDisabled = busyAction || purgeUnsupportedState;
        const purgeTitle = purgeUnsupportedState
          ? 'Chỉ hỗ trợ dọn các trạng thái Thất bại (failed), Đang thử lại (retry), Đã đồng bộ (delivered) hoặc Tất cả.'
          : 'Dọn bản ghi Outbox theo trạng thái đang lọc';
        return h('div', { 'data-testid': 'dxos-studio-outbox-dlq-panel', style: { padding: 18, borderRadius: 12, border: '1px solid #e2e8f0', background: '#fff', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', minWidth: 0, gap: 12 } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('h3', { style: { margin: 0, fontSize: 16 } }, 'Hàng đợi Outbox & Sự kiện lỗi (DLQ)'),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
            h('select', {
              'data-testid': 'dxos-outbox-status-filter',
              value: outboxState,
              onChange: (e) => {
                const nextState = e?.target?.value || 'failed';
                setOutboxState(nextState);
                setOutboxPage(1);
                setConfirmPurgeOutbox(false);
                loadOutbox(nextState, 1);
              },
              style: { padding: '6px 10px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 12, background: '#fff' },
            },
              h('option', { value: 'failed' }, 'Trạng thái: Thất bại (DLQ)'),
              h('option', { value: 'all' }, 'Trạng thái: Tất cả'),
              h('option', { value: 'retry' }, 'Trạng thái: Đang thử lại'),
              h('option', { value: 'pending' }, 'Trạng thái: Chờ gửi'),
              h('option', { value: 'processing' }, 'Trạng thái: Đang xử lý'),
              h('option', { value: 'delivered' }, 'Trạng thái: Đã đồng bộ'),
            ),
            h('button', { type: 'button', onClick: () => loadOutbox(outboxState, outboxPage), style: btnStyle(false) }, 'Làm mới DLQ'),
            h('button', { type: 'button', disabled: busyAction || !(outboxData.items || []).length, onClick: () => handleReplayDlq(), style: btnStyle(true, false, busyAction || !(outboxData.items || []).length) }, 'Phát lại toàn bộ DLQ'),
            !confirmPurgeOutbox || purgeUnsupportedState
              ? h('button', {
                type: 'button',
                'data-testid': 'dxos-outbox-purge-btn',
                title: purgeTitle,
                disabled: purgeDisabled,
                onClick: () => { if (!purgeDisabled) setConfirmPurgeOutbox(true); },
                style: btnStyle(false, true, purgeDisabled),
              }, purgeUnsupportedState ? 'Không thể dọn (chỉ failed/retry/delivered)' : 'Dọn bản ghi (Purge)')
              : h('div', { style: { display: 'inline-flex', gap: 6, alignItems: 'center' } },
                h('button', {
                  type: 'button',
                  'data-testid': 'dxos-outbox-purge-confirm-btn',
                  disabled: purgeDisabled,
                  onClick: () => handlePurgeOutbox(outboxState === 'failed' ? 'failed' : outboxState),
                  style: btnStyle(false, true, purgeDisabled),
                }, 'Xác nhận dọn Outbox'),
                h('button', {
                  type: 'button',
                  onClick: () => setConfirmPurgeOutbox(false),
                  style: btnStyle(false),
                }, 'Hủy'),
              ),
          ),
        ),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8 } },
          [
            ['Thất bại (DLQ)', outboxData?.summary?.failed ?? 0, '#dc2626'],
            ['Đang thử lại', outboxData?.summary?.retry ?? 0, '#d97706'],
            ['Chờ gửi', outboxData?.summary?.pending ?? 0, '#2563eb'],
            ['Đang khóa gửi', outboxData?.summary?.processing ?? 0, '#7c3aed'],
            ['Đã đồng bộ', outboxData?.summary?.delivered ?? 0, '#16a34a'],
          ].map(([label, valNum, color]) => h('div', { key: label, style: { padding: 10, borderRadius: 8, border: '1px solid #e2e8f0' } },
            h('div', { style: { fontSize: 11, color: '#64748b' } }, label),
            h('div', { style: { fontSize: 20, fontWeight: 700, color } }, valNum),
          )),
        ),
        !(outboxData.items || []).length
          ? h('div', { style: { padding: 12, borderRadius: 8, background: '#f8fafc', fontSize: 13, color: '#475569' } }, 'Không có sự kiện lỗi (DLQ) tồn đọng. Hệ thống Outbox non-blocking hoạt động bình thường.')
          : h('div', { style: { display: 'grid', gap: 8 } },
            outboxData.items.map((item) => {
              const rowKey = item.eventId || String(item.id || '');
              const expanded = expandedOutboxId === rowKey;
              return h('div', {
                key: rowKey,
                style: {
                  padding: 10, borderRadius: 8,
                  border: `1px solid ${item.status === 'delivered' ? '#bbf7d0' : '#fecaca'}`,
                  background: item.status === 'delivered' ? '#f0fdf4' : '#fef2f2',
                  display: 'grid', gap: 8, minWidth: 0,
                },
              },
                h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                  h('div', { style: { fontSize: 12, minWidth: 0 } },
                    h('div', { style: { fontWeight: 700, color: '#0f172a', wordBreak: 'break-word' } }, `${item.collectionName || 'entity'}#${item.recordId || ''} · ${item.eventId}`),
                    h('div', { style: { color: item.status === 'delivered' ? '#166534' : '#991b1b' } }, `Trạng thái: ${item.status || outboxState} · Tổ chức: ${item.organizationId} · Số lần thử: ${item.attempts} · Mã lỗi: ${item.errorCode || 'NONE'}`),
                  ),
                  h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                    h('button', {
                      type: 'button',
                      'data-testid': `dxos-outbox-payload-toggle-${rowKey}`,
                      onClick: () => setExpandedOutboxId(expanded ? null : rowKey),
                      style: btnStyle(false),
                    }, expanded ? 'Ẩn Payload' : 'Xem Payload'),
                    h('button', { type: 'button', disabled: busyAction, onClick: () => handleReplayDlq([item.eventId]), style: btnStyle(false, false, busyAction) }, 'Phát lại'),
                  ),
                ),
                expanded ? h('div', {
                  'data-testid': `dxos-outbox-payload-view-${rowKey}`,
                  style: { padding: 10, borderRadius: 6, background: '#0f172a', color: '#e2e8f0', fontFamily: 'monospace', fontSize: 11, overflowX: 'auto', display: 'grid', gap: 6 },
                },
                  item.lastError ? h('div', { style: { color: '#fca5a5', wordBreak: 'break-word' } }, `lastError: ${item.lastError}`) : null,
                  h('pre', { style: { margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, JSON.stringify(item.payloadJson ?? item.payload ?? null, null, 2)),
                ) : null,
              );
            }),
          ),
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12, color: '#475569' } },
          h('span', null, `Trang ${outboxData.page || outboxPage} / ${Math.max(1, Math.ceil((outboxData.total || (outboxData.items || []).length || 0) / (outboxData.pageSize || 25)))} (Tổng ${outboxData.total ?? (outboxData.items || []).length} sự kiện)`),
          h('div', { style: { display: 'flex', gap: 6 } },
            h('button', {
              type: 'button',
              'data-testid': 'dxos-outbox-prev',
              disabled: busyAction || (outboxData.page || outboxPage) <= 1,
              onClick: () => {
                const prev = Math.max(1, (outboxData.page || outboxPage) - 1);
                setOutboxPage(prev);
                loadOutbox(outboxState, prev);
              },
              style: btnStyle(false, false, busyAction || (outboxData.page || outboxPage) <= 1),
            }, '← Trang trước'),
            h('button', {
              type: 'button',
              'data-testid': 'dxos-outbox-next',
              disabled: busyAction || ((outboxData.page || outboxPage) * (outboxData.pageSize || 25) >= (outboxData.total || 0)),
              onClick: () => {
                const next = (outboxData.page || outboxPage) + 1;
                setOutboxPage(next);
                loadOutbox(outboxState, next);
              },
              style: btnStyle(false, false, busyAction || ((outboxData.page || outboxPage) * (outboxData.pageSize || 25) >= (outboxData.total || 0))),
            }, 'Trang sau →'),
          ),
        ),
      );
      })() : null,

      tab === 'gitops' ? h('div', { 'data-testid': 'dxos-studio-gitops-bundle-panel', style: { padding: 18, borderRadius: 12, border: '1px solid #e2e8f0', background: '#fff', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', minWidth: 0, gap: 12 } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('h3', { style: { margin: 0, fontSize: 16 } }, 'GitOps Solution Bundle v3 (Schema · RBAC · Portals · Workflows · AI · Governance)'),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
            h('button', { type: 'button', disabled: busyAction, onClick: handleExportBundle, style: btnStyle(true, false, busyAction) }, 'Xuất Bundle JSON'),
            h('button', { type: 'button', disabled: busyAction || !bundleText.trim(), onClick: handleDownloadBundle, style: btnStyle(false, false, busyAction || !bundleText.trim()) }, 'Tải tệp .json'),
            h('label', { style: { ...btnStyle(false, false, busyAction), display: 'inline-flex', alignItems: 'center', gap: 6 } },
              'Tải lên tệp .json',
              h('input', {
                type: 'file',
                accept: '.json,application/json',
                'data-testid': 'dxos-studio-gitops-file-input',
                disabled: busyAction,
                onChange: handleBundleFileUpload,
                style: { display: 'none' },
              }),
            ),
            h('button', { type: 'button', disabled: busyAction || !bundleText.trim(), onClick: () => handleImportBundle(true), style: btnStyle(false, false, busyAction || !bundleText.trim()) }, 'Kiểm tra Diff (Dry-Run)'),
            h('button', { type: 'button', disabled: busyAction || !bundleText.trim(), onClick: () => handleImportBundle(false), style: btnStyle(false, false, busyAction || !bundleText.trim()) }, 'Áp dụng Bundle'),
            h('button', { type: 'button', disabled: busyAction, onClick: handleRollbackBundle, style: btnStyle(false, true, busyAction) }, 'Hoàn tác Import gần nhất'),
          ),
        ),
        uploadedFileName ? h('div', { style: { fontSize: 12, color: '#0369a1' } }, `Tệp đã nạp: ${uploadedFileName}`) : null,
        h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#334155' } },
          h('input', { type: 'checkbox', checked: enableBundleWorkflows, onChange: (e) => setEnableBundleWorkflows(Boolean(e?.target?.checked)) }),
          'Tự động kích hoạt Workflow khi Áp dụng / Hoàn tác Bundle (mặc định tắt để tránh kích hoạt ngoài ý muốn)',
        ),
        Array.isArray(bundleInfo?.warnings) && bundleInfo.warnings.length ? h('div', {
          'data-testid': 'dxos-studio-gitops-warnings',
          role: 'alert',
          style: { padding: 10, borderRadius: 8, border: '1px solid #fde68a', background: '#fffbeb', color: '#92400e', fontSize: 12, display: 'grid', gap: 4 },
        },
          h('strong', null, 'Cảnh báo chuẩn hóa / bảo mật khi Export/Import:'),
          bundleInfo.warnings.map((w, wIdx) => h('div', { key: `warn-${wIdx}` }, `• ${w}`)),
        ) : null,
        bundleInfo?.sha256 || bundleInfo?.lastSnapshotUid ? h('div', { style: { fontSize: 12, color: '#475569', display: 'flex', gap: 12, flexWrap: 'wrap' } },
          bundleInfo?.sha256 ? h('span', null, `SHA-256: ${bundleInfo.sha256}`) : null,
          bundleInfo?.lastSnapshotUid ? h('span', null, `Snapshot hoàn tác: ${bundleInfo.lastSnapshotUid}`) : null,
        ) : null,
        (bundleInfo?.applied || bundleInfo?.diff || bundleInfo?.counts) ? h('div', {
          'data-testid': 'dxos-studio-gitops-counts',
          style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 },
        },
          [
            ['roles', 'Vai trò', bundleInfo?.applied?.rolesUpserted, bundleInfo?.diff?.sections?.roles, bundleInfo?.counts?.roles],
            ['roleResources', 'Quyền bảng', bundleInfo?.applied?.roleResourcesUpserted, bundleInfo?.diff?.roleResources, bundleInfo?.counts?.roleResources],
            ['portals', 'Cổng Portal', bundleInfo?.applied?.portalsUpserted, bundleInfo?.diff?.sections?.portals, bundleInfo?.counts?.portals],
            ['workflows', 'Quy trình', bundleInfo?.applied?.workflowsUpserted, bundleInfo?.diff?.sections?.workflows, bundleInfo?.counts?.workflows],
            ['customCollections', 'Bảng tùy biến', bundleInfo?.applied?.customCollectionsUpserted, bundleInfo?.diff?.sections?.customCollections, bundleInfo?.counts?.customCollections],
            ['connectors', 'Connectors', bundleInfo?.applied?.connectorsUpserted, bundleInfo?.diff?.sections?.connectors, bundleInfo?.counts?.connectors],
            ['aiProfiles', 'Nhân sự AI', bundleInfo?.applied?.aiProfilesUpserted, bundleInfo?.diff?.sections?.aiProfiles, bundleInfo?.counts?.aiProfiles],
            ['governance', 'Quản trị Governance', (() => {
              const ap = bundleInfo?.applied;
              if (!ap || (ap.decisionTablesUpserted === undefined && ap.slaPoliciesUpserted === undefined && ap.incidentRulesUpserted === undefined)) return undefined;
              return Number(ap.decisionTablesUpserted || 0) + Number(ap.slaPoliciesUpserted || 0) + Number(ap.incidentRulesUpserted || 0);
            })(), (() => {
              const parts = [
                bundleInfo?.diff?.sections?.decisionTables || bundleInfo?.diff?.governance?.decisionTables,
                bundleInfo?.diff?.sections?.slaPolicies || bundleInfo?.diff?.governance?.slaPolicies,
                bundleInfo?.diff?.sections?.incidentRules || bundleInfo?.diff?.governance?.incidentRules,
              ].filter(Boolean);
              if (!parts.length) return undefined;
              return {
                added: parts.flatMap((s) => s.added || []),
                changed: parts.flatMap((s) => s.changed || []),
                unchanged: parts.flatMap((s) => s.unchanged || []),
                removed: parts.flatMap((s) => s.removed || []),
              };
            })(), bundleInfo?.counts?.governance],
          ].map(([key, label, appliedCount, diffObj, expCount]) => {
            const removedCount = diffObj?.removed?.length || 0;
            const diffSummary = diffObj
              ? `+${diffObj.added?.length || 0} / ~${diffObj.changed?.length || 0} / =${diffObj.unchanged?.length || 0}${removedCount ? ` / -${removedCount}` : ''}`
              : null;
            const mainStat = appliedCount !== undefined
              ? `${appliedCount} đã áp dụng`
              : diffSummary || `${expCount ?? 0} mục`;
            return h('div', { key, style: { padding: 10, borderRadius: 8, border: '1px solid #e2e8f0', background: '#f8fafc' } },
              h('div', { style: { fontSize: 11, color: '#64748b' } }, `${label} (${key})`),
              h('div', { style: { fontSize: 14, fontWeight: 700, color: '#0f172a', marginTop: 2 } }, mainStat),
              appliedCount !== undefined && diffSummary
                ? h('div', { style: { fontSize: 11, color: '#475569', marginTop: 2 } }, `Diff: ${diffSummary}`)
                : null,
            );
          }),
        ) : null,
        bundleInfo?.diff?.sections ? h('div', {
          'data-testid': 'dxos-studio-gitops-diff-tree',
          style: { padding: 12, borderRadius: 8, border: '1px solid #e2e8f0', background: '#f8fafc', display: 'grid', gap: 8 },
        },
          h('div', { style: { fontSize: 12, fontWeight: 700, color: '#0f172a' } }, 'Chi tiết Diff theo từng mục (Item-level Diff Tree)'),
          Object.entries(bundleInfo.diff.sections).map(([secKey, secVal]) => {
            const added = Array.isArray(secVal?.added) ? secVal.added : [];
            const changed = Array.isArray(secVal?.changed) ? secVal.changed : [];
            const removed = Array.isArray(secVal?.removed) ? secVal.removed : [];
            const detailEntry = bundleInfo?.diff?.details?.[secKey] || {};
            const detailEntries = Object.entries(detailEntry)
              .filter(([, d]) => d && typeof d === 'object' && Array.isArray(d.fields) && d.fields.length);
            const fmtDiffVal = (v) => (v === undefined ? '∅' : JSON.stringify(v));
            const addEntries = detailEntries.filter(([, d]) => d.action === 'add');
            const changeEntries = detailEntries.filter(([, d]) => d.action === 'change');
            const removeEntries = detailEntries.filter(([, d]) => d.action === 'remove');
            if (!added.length && !changed.length && !removed.length && !detailEntries.length) return null;
            return h('div', { key: secKey, style: { padding: 8, borderRadius: 6, border: '1px solid #e2e8f0', background: '#fff', fontSize: 12, display: 'grid', gap: 4 } },
              h('div', { style: { fontWeight: 700, color: '#1e293b' } }, secKey),
              (added.length || addEntries.length) ? h('div', { style: { color: '#166534', display: 'grid', gap: 2 } },
                h('span', null, `+ Thêm mới (${added.length || addEntries.length}): ${(added.length ? added : addEntries.map(([k]) => k)).join(', ')}`),
                addEntries.map(([itemKey, d]) => h('div', {
                  key: `${secKey}-add-${itemKey}`,
                  style: { paddingLeft: 12, fontSize: 11, color: '#15803d', wordBreak: 'break-word' },
                }, `${itemKey}: ${d.fields.map((f) => `${f.field} (${fmtDiffVal(f.before)} -> ${fmtDiffVal(f.after)})`).join('; ')}`)),
              ) : null,
              (changed.length || changeEntries.length) ? h('div', { style: { color: '#92400e', display: 'grid', gap: 2 } },
                h('span', null, `~ Thay đổi (${changed.length || changeEntries.length}): ${(changed.length ? changed : changeEntries.map(([k]) => k)).join(', ')}`),
                changeEntries.map(([itemKey, d]) => h('div', {
                  key: `${secKey}-change-${itemKey}`,
                  style: { paddingLeft: 12, fontSize: 11, color: '#475569', wordBreak: 'break-word' },
                }, `${itemKey}: ${d.fields.map((f) => `${f.field} (${fmtDiffVal(f.before)} -> ${fmtDiffVal(f.after)})`).join('; ')}`)),
              ) : null,
              (removed.length || removeEntries.length) ? h('div', { style: { color: '#991b1b', display: 'grid', gap: 2 } },
                h('span', null, `- Bị xóa khỏi Bundle (${removed.length || removeEntries.length}): ${(removed.length ? removed : removeEntries.map(([k]) => k)).join(', ')}`),
                removeEntries.map(([itemKey, d]) => h('div', {
                  key: `${secKey}-remove-${itemKey}`,
                  style: { paddingLeft: 12, fontSize: 11, color: '#b91c1c', wordBreak: 'break-word' },
                }, `${itemKey}: ${d.fields.map((f) => `${f.field} (${fmtDiffVal(f.before)} -> ${fmtDiffVal(f.after)})`).join('; ')}`)),
              ) : null,
            );
          }),
        ) : null,
        h('textarea', {
          value: bundleText,
          onChange: (e) => setBundleText(e.target.value),
          placeholder: 'Dán hoặc xuất JSON latticedx.solution-bundle/v3 (hỗ trợ cả v1/v2) tại đây…',
          rows: 10,
          style: { width: '100%', boxSizing: 'border-box', padding: 10, borderRadius: 8, border: '1px solid #cbd5e1', fontFamily: 'monospace', fontSize: 12 },
        }),
      ) : null,

      tab === 'notify' ? h(NotifyPanel, {
        api,
        selectedOrg,
        organizations,
        openRoute,
        setFeedback,
      }) : null,

      tab === 'broker' ? h(BrokerAndEventsPanel, {
        api,
        selectedOrg,
        organizations,
        openRoute,
        setFeedback,
      }) : null,

      tab === 'automation' ? h(VaultAndAutomationPanel, {
        api,
        selectedOrg,
        organizations,
        openRoute,
        setFeedback,
      }) : null,

      tab === 'builder' ? h(DomainBuilderAndTenantsPanel, {
        api,
        selectedOrg,
        organizations,
        openRoute,
        setFeedback,
      }) : null,

      tab === 'forms' ? h(PublicFormBuilderPanel, {
        api,
        selectedOrg,
        organizations,
        openRoute,
        setFeedback,
      }) : null,

      tab === 'approvals' ? h(ApprovalInboxPanel, {
        api,
        selectedOrg,
        organizations,
        openRoute,
      }) : null,

      isGovernanceTab ? h(GovernanceConsoles, {
        api,
        activeSection: activeGovSection,
        onSelectSection: (nextSec) => { setTab('governance'); setGovSection(nextSec); },
        selectedOrg,
        organizations,
        employees,
        openRoute,
      }) : null,
        ),
      ),
    );
  };
}

module.exports = { createDxosStudioSettingsPage, createFlowPinStorage, STUDIO_NAV_GROUPS };
