/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { createPortalModals } = require('./native-portal-modals');

const FALLBACK_LDX_ROLES = [
  { name: 'ldx_employee', title: 'Lattice — Nhân viên' },
  { name: 'ldx_manager', title: 'Lattice — Quản lý' },
  { name: 'ldx_warehouse', title: 'Lattice — Kho' },
  { name: 'ldx_dispatcher', title: 'Lattice — Điều phối' },
  { name: 'ldx_driver', title: 'Lattice — Tài xế' },
  { name: 'ldx_director', title: 'Lattice — Giám đốc (chỉ đọc)' },
  { name: 'ldx_admin', title: 'Lattice — Quản trị nghiệp vụ' },
];

function createMultiPortalSettingsPage(client, React, antd, app, router, helpers) {
  const h = React.createElement;
  const { renderTile, toPortalSlug, syncPortals } = helpers;
  const { PortalFormModal, BlueprintModal } = createPortalModals(React, antd, { toPortalSlug });
  const useApi = typeof client.useAPIClient === 'function' ? client.useAPIClient : () => null;
  const useNav = typeof router?.useNavigate === 'function' ? router.useNavigate : () => null;

  return function MultiPortalSettingsPage() {
    const api = useApi();
    const navigate = useNav();
    const [portals, setPortals] = React.useState([]);
    const [roles, setRoles] = React.useState(FALLBACK_LDX_ROLES);
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState('');
    const [modalState, setModalState] = React.useState({ open: false, editing: null });
    const [saving, setSaving] = React.useState(false);
    const [saveError, setSaveError] = React.useState('');
    const [blueprint, setBlueprint] = React.useState(null);

    async function loadAll() {
      if (!api?.request) { setLoading(false); return; }
      setLoading(true); setError('');
      try {
        const [portalRes, roleRes] = await Promise.allSettled([
          api.request({ url: 'latticePortals:list', method: 'get' }),
          api.request({ url: 'roles:list', method: 'get', params: { pageSize: 100 } }),
        ]);
        if (portalRes.status === 'fulfilled') {
          const items = Array.isArray(portalRes.value?.data?.data) ? portalRes.value.data.data : [];
          setPortals(items);
          syncPortals(items);
        } else {
          setError('Không tải được danh sách Portal.');
        }
        if (roleRes.status === 'fulfilled') {
          const rows = roleRes.value?.data?.data;
          const ldx = Array.isArray(rows) ? rows.filter(r => String(r?.name || '').startsWith('ldx_')) : [];
          if (ldx.length) setRoles(ldx);
        }
      } catch {
        setError('Không tải được danh sách Portal.');
      } finally {
        setLoading(false);
      }
    }

    React.useEffect(() => { loadAll(); }, []);

    function openBuilder(portal) {
      try { window?.localStorage?.setItem('NOCOBASE_V2_FLOW_SETTINGS_ENABLED', '1'); } catch {}
      if (navigate) navigate(portal.routePath);
    }

    async function savePortal(payload) {
      if (!api?.request || saving) return;
      if (!payload?.title) { setSaveError('Vui lòng nhập tên Portal.'); return; }
      setSaving(true); setSaveError('');
      try {
        const res = await api.request({ url: 'latticePortals:save', method: 'post', data: payload });
        const saved = res?.data?.data;
        if (saved) syncPortals([saved]);
        setModalState({ open: false, editing: null });
        await loadAll();
      } catch (err) {
        setSaveError(err?.response?.data?.errors?.[0]?.message || err?.message || 'Không lưu được Portal.');
      } finally {
        setSaving(false);
      }
    }

    async function toggleEnabled(portal, enabled) {
      if (!api?.request) return;
      try {
        await api.request({ url: 'latticePortals:save', method: 'post', data: { uid: portal.uid, slug: portal.slug, title: portal.title, enabled } });
        await loadAll();
      } catch { setError('Không cập nhật được trạng thái Portal.'); }
    }

    async function destroyPortal(uid) {
      if (!api?.request) return;
      try {
        await api.request({ url: 'latticePortals:destroy', method: 'post', data: { uid } });
        await loadAll();
      } catch { setError('Không xóa được Portal.'); }
    }

    async function openBlueprint(uid) {
      if (!api?.request) return;
      try {
        const res = await api.request({ url: 'latticePortals:exportBlueprint', method: 'get', params: { uid } });
        setBlueprint(res?.data?.data || null);
      } catch { setError('Không xuất được Blueprint JSON.'); }
    }

    function cardMenu(portal) {
      const items = [
        { key: 'builder', label: 'Mở Visual Builder', onClick: () => openBuilder(portal) },
        { key: 'edit', label: 'Chỉnh sửa Portal', onClick: () => { setSaveError(''); setModalState({ open: true, editing: portal }); } },
        { key: 'roles', label: 'Phân quyền Role', onClick: () => { setSaveError(''); setModalState({ open: true, editing: portal }); } },
        { key: 'default', label: 'Đặt làm mặc định', onClick: () => savePortal({ uid: portal.uid, slug: portal.slug, title: portal.title, isDefault: true }) },
        { key: 'blueprint', label: 'Xuất Blueprint JSON', onClick: () => openBlueprint(portal.uid) },
      ];
      if (!portal.builtin) {
        items.push({ type: 'divider' });
        items.push({
          key: 'delete',
          label: h(antd.Popconfirm, {
            title: `Xóa portal "${portal.title}"?`, okText: 'Xóa', cancelText: 'Hủy',
            onConfirm: () => destroyPortal(portal.uid),
          }, h('span', { style: { color: '#dc2626', display: 'block' }, onClick: e => e.stopPropagation() }, 'Xóa Portal')),
        });
      }
      return { items };
    }

    const enterPortal = portal => (navigate ? navigate(portal.firstPagePath || portal.routePath) : undefined);

    return h('div', { style: { padding: 24, maxWidth: 1320, margin: '0 auto' } },
      h('header', { style: { display: 'flex', flexWrap: 'wrap', gap: 12, justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 } },
        h('div', null,
          h('h1', { style: { margin: 0, fontSize: 22, fontWeight: 700, color: '#0f172a' } }, 'Multi-Portal Manager'),
          h('p', { style: { margin: '4px 0 0', color: '#475569', fontSize: 13 } },
            'Mỗi Portal là một không gian nghiệp vụ độc lập với cây menu, giao diện kéo-thả và phân quyền riêng')),
        h(antd.Space, null,
          h(antd.Button, { onClick: loadAll, loading }, 'Làm mới'),
          h(antd.Button, { type: 'primary', onClick: () => { setSaveError(''); setModalState({ open: true, editing: null }); } }, 'Tạo Portal mới'))),
      error ? h(antd.Alert, { type: 'error', message: error, showIcon: true, style: { marginBottom: 16 } }) : null,
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16 } },
        portals.map(portal => h('article', {
          key: portal.uid,
          style: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 },
        },
        h('div', { style: { display: 'flex', gap: 12, alignItems: 'center' } },
          renderTile(portal.color, portal.icon, 48, portal.title),
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
              h('strong', { style: { fontSize: 16, color: '#0f172a' } }, portal.title),
              portal.isDefault ? h(antd.Tag, { color: 'green' }, 'Mặc định') : null,
              portal.layoutType === 'mobile' ? h(antd.Tag, { color: 'blue' }, 'Mobile') : null),
            router?.Link
              ? h(router.Link, { to: portal.routePath, style: { fontFamily: 'monospace', fontSize: 12, color: '#1677ff' } }, portal.routePath)
              : h('code', { style: { fontSize: 12 } }, portal.routePath)),
          h(antd.Switch, {
            checked: portal.enabled !== false,
            disabled: portal.uid === 'admin-layout-model',
            'aria-label': `Kích hoạt ${portal.title}`,
            onChange: checked => toggleEnabled(portal, checked),
          })),
        portal.description ? h('p', { style: { margin: 0, fontSize: 13, color: '#475569' } }, portal.description) : null,
        h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', fontSize: 12, color: '#64748b' } },
          h(antd.Tag, null, `${portal.routeCount ?? 0} trang/nhóm`),
          ...(Array.isArray(portal.roles) && portal.roles.length
            ? portal.roles.map(r => h(antd.Tag, { key: r, color: 'geekblue' }, r))
            : [h('span', { key: 'none' }, 'Chưa gán role ldx_*')])),
        h('div', { style: { display: 'flex', gap: 8, marginTop: 'auto', paddingTop: 4 } },
          h(antd.Button, { size: 'small', onClick: () => enterPortal(portal) }, 'Vào Portal'),
          h(antd.Button, { size: 'small', type: 'primary', ghost: true, onClick: () => openBuilder(portal) }, 'Mở Builder'),
          h(antd.Dropdown, { menu: cardMenu(portal), trigger: ['click'] },
            h(antd.Button, { size: 'small', style: { marginLeft: 'auto' }, 'aria-label': `Thao tác ${portal.title}` }, '•••')))))),
      h('footer', { style: { marginTop: 28, paddingTop: 12, borderTop: '1px solid #e5e7eb', fontSize: 12, color: '#64748b', textAlign: 'center' } },
        'LatticeDX Open-Core (Apache-2.0) · Powered by ',
        h('a', { href: 'https://www.nocobase.com', target: '_blank', rel: 'noreferrer', style: { color: '#1677ff' } }, 'NocoBase')),
      h(PortalFormModal, {
        open: modalState.open, editing: modalState.editing, roles, saving, error: saveError,
        onCancel: () => setModalState({ open: false, editing: null }),
        onSubmit: savePortal,
      }),
      h(BlueprintModal, { blueprint, onClose: () => setBlueprint(null) }));
  };
}

module.exports = { createMultiPortalSettingsPage, FALLBACK_LDX_ROLES };
