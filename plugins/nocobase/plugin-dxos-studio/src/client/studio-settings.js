/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

function createDxosStudioSettingsPage(client, React, antd, app) {
  const h = React.createElement;
  const useApi = typeof client?.useAPIClient === 'function' ? client.useAPIClient : () => app?.apiClient || null;

  function openRoute(path) {
    const url = app?.getRouteUrl?.(path) || path;
    if (app?.router?.navigate) app.router.navigate(path);
    else if (typeof window !== 'undefined' && window.location) window.location.assign(url);
  }

  return function DxosStudioSettingsPage() {
    const api = useApi();
    const [tab, setTab] = React.useState('workflows');
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
    const [forbidden, setForbidden] = React.useState(false);
    const [feedback, setFeedback] = React.useState(null);
    const [outboxData, setOutboxData] = React.useState({ items: [], total: 0, summary: { pending: 0, retry: 0, processing: 0, failed: 0, delivered: 0 } });
    const [bundleText, setBundleText] = React.useState('');
    const [bundleInfo, setBundleInfo] = React.useState(null);

    const loadAll = React.useCallback(async () => {
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
    }, [api, selectedOrg]);

    React.useEffect(() => { loadAll(); }, [loadAll]);

    const loadOutbox = React.useCallback(async () => {
      if (!api?.request) return;
      try {
        const res = await api.request({ url: 'dxosStudio:outboxDlqList', method: 'get', skipNotify: true });
        const d = res?.data?.data || res?.data || {};
        setOutboxData({
          items: Array.isArray(d.items) ? d.items : [],
          total: Number(d.total || 0),
          summary: d.summary || { pending: 0, retry: 0, processing: 0, failed: 0, delivered: 0 },
        });
      } catch {
        // Keep last state cleanly
      }
    }, [api]);

    React.useEffect(() => {
      if (tab === 'outbox') loadOutbox();
    }, [tab, loadOutbox]);

    async function handleReplayDlq(eventIds) {
      if (!api?.request || busyAction) return;
      setBusyAction(true);
      setFeedback(null);
      try {
        const payload = Array.isArray(eventIds) && eventIds.length ? { eventIds } : {};
        const res = await api.request({ url: 'dxosStudio:outboxDlqReplay', method: 'post', data: payload });
        const d = res?.data?.data || res?.data || {};
        setFeedback({ type: 'success', text: `Đã đưa ${d.replayedCount || 0} bản ghi Outbox DLQ trở lại hàng đợi xử lý.` });
        await loadOutbox();
      } catch (err) {
        setFeedback({ type: 'error', text: err?.response?.data?.errors?.[0]?.message || 'Không phát lại được hàng đợi DLQ.' });
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
        setBundleText(JSON.stringify(b, null, 2));
        setBundleInfo({ sha256: b?.metadata?.contentSha256 || '', exportedAt: b?.metadata?.exportedAt || '' });
        setFeedback({ type: 'success', text: `Đã xuất Solution Bundle v1 (${(b?.metadata?.contentSha256 || '').slice(0, 12)}…).` });
      } catch (err) {
        setFeedback({ type: 'error', text: err?.response?.data?.errors?.[0]?.message || 'Không xuất được Solution Bundle.' });
      } finally {
        setBusyAction(false);
      }
    }

    async function handleImportBundle(dryRun) {
      if (!api?.request || busyAction) return;
      setBusyAction(true);
      setFeedback(null);
      try {
        const parsed = JSON.parse(bundleText || '{}');
        const res = await api.request({ url: 'dxosStudio:solutionBundleImport', method: 'post', data: { bundle: parsed, dryRun, organizationId: selectedOrg || undefined } });
        const d = res?.data?.data || res?.data || {};
        setBundleInfo((prev) => ({ ...(prev || {}), diff: d.diff || null }));
        setFeedback({
          type: 'success',
          text: d.dryRun
            ? `Dry-Run hợp lệ (+${d.diff?.summary?.added || 0} thêm, ~${d.diff?.summary?.changed || 0} đổi).`
            : `Đã áp dụng Bundle: ${d.applied?.rolesUpserted || 0} roles, ${d.applied?.aiProfilesUpserted || 0} AI profiles.`,
        });
      } catch (err) {
        setFeedback({ type: 'error', text: err?.response?.data?.errors?.[0]?.message || err?.message || 'Lỗi Solution Bundle JSON.' });
      } finally {
        setBusyAction(false);
      }
    }

    const tabItems = [
      ['workflows', '1. Quy trình Poka-yoke'],
      ['portals', '2. Dựng cổng đa-block'],
      ['plugins', '3. Hệ sinh thái 7 Plugin'],
      ['pof', '4. Sẵn sàng PoF & Hệ thống'],
      ['outbox', '5. Hàng đợi Outbox & DLQ'],
      ['gitops', '6. GitOps Bundle'],
    ];

    const btnStyle = (active) => ({
      padding: '8px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600,
      border: active ? '1px solid #1677ff' : '1px solid #cbd5e1',
      background: active ? '#1677ff' : '#ffffff',
      color: active ? '#ffffff' : '#1e293b',
    });

    if (forbidden) {
      return h('div', { 'data-testid': 'dxos-studio-forbidden', style: { padding: 24, maxWidth: 720, margin: '24px auto', borderRadius: 12, border: '1px solid #fecaca', background: '#fef2f2', color: '#991b1b' } },
        h('h2', { style: { margin: '0 0 8px', fontSize: 18 } }, '403 — Chỉ Quản trị viên mới truy cập được DX-OS Control Studio'),
        h('p', { style: { margin: '0 0 12px', fontSize: 13 } }, 'Tài khoản hiện tại không có quyền quản trị cấu hình plugin/workflow. Vui lòng quay lại cổng làm việc của bạn.'),
        h('button', { type: 'button', onClick: () => openRoute('/admin/lattice-workspace'), style: btnStyle(true) }, 'Về Không gian việc của tôi'),
      );
    }

    const requiredCount = activeTemplate?.requiredBindings?.length || 0;
    const missingCrew = Boolean(activeTemplate && selectedOrg && orgEmployees.length < requiredCount);

    return h('div', { 'data-testid': 'dxos-studio-settings-page', style: { padding: '24px 24px 64px', maxWidth: 1120, margin: '0 auto', display: 'grid', gap: 16 } },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, alignItems: 'center' } },
        h('div', null,
          h('h1', { style: { margin: '0 0 6px', fontSize: 22, fontWeight: 700, color: '#0f172a' } }, 'DX-OS Control Studio — Xây dựng Hệ thống từ NocoBase'),
          h('p', { style: { margin: 0, color: '#475569', fontSize: 13 } }, 'Cài mẫu quy trình Poka-yoke, dựng cổng đa-block kết hợp Block tùy biến, quản lý hệ sinh thái 7 plugin Open-Core và kiểm tra PoF.'),
        ),
        h('button', { type: 'button', onClick: () => openRoute('/admin/settings/dxos-ai'), style: btnStyle(true) }, 'Mở AI Workforce & 6-Plane Center'),
      ),
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
        tabItems.map(([k, label]) => h('button', { key: k, type: 'button', onClick: () => setTab(k), style: btnStyle(tab === k) }, label)),
      ),
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

      tab === 'workflows' ? h('form', { onSubmit: handleInstallWorkflow, style: { padding: 18, borderRadius: 12, border: '1px solid #e2e8f0', background: '#fff', display: 'grid', gap: 14 } },
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
          h('button', { type: 'submit', disabled: busyAction || loading || !selectedOrg, style: btnStyle(true) }, busyAction ? 'Đang cài đặt…' : 'Cài đặt quy trình vào NocoBase'),
          h('button', { type: 'button', onClick: () => openRoute('/admin/settings/workflow'), style: btnStyle(false) }, 'Mở danh sách Workflow native'),
        ),
      ) : null,

      tab === 'portals' ? h('div', { style: { padding: 18, borderRadius: 12, border: '1px solid #e2e8f0', background: '#fff', display: 'grid', gap: 12 } },
        h('h3', { style: { margin: 0, fontSize: 16 } }, 'Dựng & Nâng cấp 4 Cổng Đa-Block'),
        h('p', { style: { margin: 0, fontSize: 13, color: '#475569' } }, 'Tự động tạo trang Dịch vụ Nội bộ & Tài liệu P.A.R.A., kèm 4 trang Tổng quan kết hợp Hero + KPI + Việc của tôi + NGSI-LD + Đề xuất AI + Kho P.A.R.A. mà không ghi đè trang bạn đã tự thiết kế.'),
        h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } },
          h('button', { type: 'button', onClick: handleComposePortals, disabled: busyAction, style: btnStyle(true) }, busyAction ? 'Đang xử lý…' : 'Dựng Cổng Đa-Block ngay'),
          h('button', { type: 'button', onClick: () => openRoute('/admin/settings/multi-portal'), style: btnStyle(false) }, 'Quản lý Multi-Portal'),
          h('button', { type: 'button', onClick: () => openRoute('/p/procurement'), style: btnStyle(false) }, 'Mở Cổng Mua sắm'),
          h('button', { type: 'button', onClick: () => openRoute('/p/logistics'), style: btnStyle(false) }, 'Mở Cổng Logistics'),
          h('button', { type: 'button', onClick: () => openRoute('/p/services'), style: btnStyle(false) }, 'Mở Cổng P.A.R.A. & Dịch vụ'),
        ),
      ) : null,

      tab === 'plugins' ? h('div', { style: { padding: 18, borderRadius: 12, border: '1px solid #e2e8f0', background: '#fff', display: 'grid', gap: 12 } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('h3', { style: { margin: 0, fontSize: 16 } }, 'Hệ sinh thái 7 Plugin Apache-2.0 Open-Core'),
          h('div', { style: { display: 'flex', gap: 8 } },
            h('button', { type: 'button', onClick: () => openRoute('/admin/settings/dxos-ai'), style: btnStyle(true) }, 'Mở AI Workforce & 6-Plane Center'),
            h('button', { type: 'button', onClick: () => openRoute('/admin/pm/list'), style: btnStyle(false) }, 'Mở Plugin Manager (bật/tắt live)'),
          ),
        ),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 10 } },
          (readiness?.plugins || []).map((p) => h('div', { key: p.packageName, style: { padding: 12, borderRadius: 8, border: '1px solid #e2e8f0', background: '#f8fafc' } },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 13, fontWeight: 700 } },
              h('span', null, p.title),
              h('span', { style: { color: p.enabled ? '#166534' : '#9a3412', fontSize: 11 } }, p.enabled ? 'Đang bật' : 'Đang tắt'),
            ),
            h('div', { style: { fontSize: 12, color: '#64748b' } }, `${p.packageName} v${p.version} · ${p.license}`),
            h('div', { style: { fontSize: 11, color: '#4f46e5', marginTop: 4 } }, `Không gian: ${(p.spaces || []).join(' ')}`),
          )),
        ),
      ) : null,

      tab === 'pof' ? h('div', { style: { padding: 18, borderRadius: 12, border: '1px solid #e2e8f0', background: '#fff', display: 'grid', gap: 10 } },
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

      tab === 'outbox' ? h('div', { 'data-testid': 'dxos-studio-outbox-dlq-panel', style: { padding: 18, borderRadius: 12, border: '1px solid #e2e8f0', background: '#fff', display: 'grid', gap: 12 } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('h3', { style: { margin: 0, fontSize: 16 } }, 'Hàng đợi Outbox & Dead-Letter Queue (DLQ)'),
          h('div', { style: { display: 'flex', gap: 8 } },
            h('button', { type: 'button', onClick: () => loadOutbox(), style: btnStyle(false) }, 'Làm mới DLQ'),
            h('button', { type: 'button', disabled: busyAction || !(outboxData.items || []).length, onClick: () => handleReplayDlq(), style: btnStyle(true) }, 'Phát lại toàn bộ DLQ'),
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
            outboxData.items.map((item) => h('div', { key: item.eventId || item.id, style: { padding: 10, borderRadius: 8, border: '1px solid #fecaca', background: '#fef2f2', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
              h('div', { style: { fontSize: 12 } },
                h('div', { style: { fontWeight: 700, color: '#0f172a' } }, `${item.collectionName || 'entity'}#${item.recordId || ''} · ${item.eventId}`),
                h('div', { style: { color: '#991b1b' } }, `Tổ chức: ${item.organizationId} · Số lần thử: ${item.attempts} · Mã lỗi: ${item.errorCode || 'UNKNOWN'}`),
              ),
              h('button', { type: 'button', disabled: busyAction, onClick: () => handleReplayDlq([item.eventId]), style: btnStyle(false) }, 'Phát lại'),
            )),
          ),
      ) : null,

      tab === 'gitops' ? h('div', { 'data-testid': 'dxos-studio-gitops-bundle-panel', style: { padding: 18, borderRadius: 12, border: '1px solid #e2e8f0', background: '#fff', display: 'grid', gap: 12 } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('h3', { style: { margin: 0, fontSize: 16 } }, 'GitOps Solution Bundle (Schema · RBAC · Portals · Workflows · AI)'),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            h('button', { type: 'button', disabled: busyAction, onClick: handleExportBundle, style: btnStyle(true) }, 'Xuất Bundle JSON'),
            h('button', { type: 'button', disabled: busyAction || !bundleText.trim(), onClick: () => handleImportBundle(true), style: btnStyle(false) }, 'Kiểm tra Diff (Dry-Run)'),
            h('button', { type: 'button', disabled: busyAction || !bundleText.trim(), onClick: () => handleImportBundle(false), style: btnStyle(false) }, 'Áp dụng Bundle'),
          ),
        ),
        bundleInfo?.sha256 ? h('div', { style: { fontSize: 12, color: '#475569' } }, `SHA-256: ${bundleInfo.sha256}`) : null,
        h('textarea', {
          value: bundleText,
          onChange: (e) => setBundleText(e.target.value),
          placeholder: 'Dán hoặc xuất JSON latticedx.solution-bundle/v1 tại đây…',
          rows: 10,
          style: { width: '100%', padding: 10, borderRadius: 8, border: '1px solid #cbd5e1', fontFamily: 'monospace', fontSize: 12 },
        }),
      ) : null,
    );
  };
}

module.exports = { createDxosStudioSettingsPage };
