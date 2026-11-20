/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const PORTAL_ICONS = [
  'AppstoreOutlined', 'TeamOutlined', 'ShoppingCartOutlined', 'ShoppingOutlined',
  'SafetyCertificateOutlined', 'DatabaseOutlined', 'ToolOutlined', 'AlertOutlined',
  'CarOutlined', 'DashboardOutlined', 'MobileOutlined',
];
const PORTAL_COLORS = ['#1677ff', '#0f766e', '#7c3aed', '#d97706', '#dc2626', '#2563eb', '#059669', '#fa8c16', '#10b981', '#6366f1'];

function createPortalModals(React, antd, { toPortalSlug }) {
  const h = React.createElement;

  function PortalFormModal({ open, editing, roles, saving, error, onCancel, onSubmit }) {
    const [title, setTitle] = React.useState('');
    const [slug, setSlug] = React.useState('');
    const [slugTouched, setSlugTouched] = React.useState(false);
    const [icon, setIcon] = React.useState('AppstoreOutlined');
    const [color, setColor] = React.useState('#1677ff');
    const [description, setDescription] = React.useState('');
    const [assignedRoles, setAssignedRoles] = React.useState([]);
    const [isDefault, setIsDefault] = React.useState(false);
    const [enabled, setEnabled] = React.useState(true);

    React.useEffect(() => {
      if (!open) return;
      setTitle(editing?.title || '');
      setSlug(editing?.slug || '');
      setSlugTouched(Boolean(editing));
      setIcon(editing?.icon || 'AppstoreOutlined');
      setColor(editing?.color || '#1677ff');
      setDescription(editing?.description || '');
      setAssignedRoles(Array.isArray(editing?.roles) ? editing.roles : []);
      setIsDefault(Boolean(editing?.isDefault));
      setEnabled(editing ? editing.enabled !== false : true);
    }, [open, editing]);

    const isBuiltin = Boolean(editing?.builtin);
    const isAdminLayout = editing?.uid === 'admin-layout-model';
    const roleOptions = roles.map(r => ({ label: r.title ? `${r.title} (${r.name})` : r.name, value: r.name }));
    const field = (label, node) => h('label', { style: { display: 'grid', gap: 4, marginBottom: 12, fontSize: 13, fontWeight: 500 } }, label, node);

    return h(antd.Modal, {
      open,
      title: editing ? `Cấu hình Portal: ${editing.title}` : 'Tạo Portal mới',
      okText: editing ? 'Lưu thay đổi' : 'Tạo Portal',
      cancelText: 'Hủy',
      confirmLoading: saving,
      onCancel,
      onOk: () => onSubmit({
        ...(editing?.uid ? { uid: editing.uid } : {}),
        slug: slug.trim().toLowerCase(),
        title: title.trim(),
        icon,
        color,
        description: description.trim(),
        roles: assignedRoles,
        isDefault,
        ...(isAdminLayout ? {} : { enabled }),
      }),
    },
    error ? h(antd.Alert, { type: 'error', message: error, showIcon: true, style: { marginBottom: 12 } }) : null,
    field('Tên Portal', h(antd.Input, {
      value: title, maxLength: 80, placeholder: 'Ví dụ: Cổng Nhân sự',
      onChange: e => {
        const next = e.target.value;
        setTitle(next);
        if (!editing && !slugTouched) setSlug(toPortalSlug(next));
      },
    })),
    field('Đường dẫn (Slug)', h(antd.Input, {
      value: slug, maxLength: 37, disabled: Boolean(editing) || isBuiltin,
      addonBefore: isBuiltin ? '/' : '/p/',
      placeholder: 'nhan-su',
      onChange: e => { setSlugTouched(true); setSlug(e.target.value.toLowerCase()); },
    })),
    h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 } },
      field('Biểu tượng', h(antd.Select, {
        value: icon, onChange: setIcon,
        options: PORTAL_ICONS.map(name => ({ label: name, value: name })),
      })),
      field('Màu nhấn', h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', minHeight: 32 } },
        PORTAL_COLORS.map(hex => h('button', {
          key: hex, type: 'button', 'aria-label': hex, onClick: () => setColor(hex),
          style: {
            width: 22, height: 22, borderRadius: 6, background: hex, cursor: 'pointer',
            border: String(color || '').toLowerCase() === hex.toLowerCase() ? '2px solid #0f172a' : '2px solid transparent',
          },
        }))))),
    field('Mô tả', h(antd.Input, {
      value: description, maxLength: 300, placeholder: 'Mô tả phạm vi nghiệp vụ của Portal',
      onChange: e => setDescription(e.target.value),
    })),
    field('Vai trò được truy cập (ldx_*)', h(antd.Select, {
      mode: 'multiple', allowClear: true, placeholder: 'Chọn vai trò được truy cập portal',
      value: assignedRoles, options: roleOptions, onChange: setAssignedRoles, style: { width: '100%' },
    })),
    h('div', { style: { display: 'flex', gap: 24, marginTop: 8 } },
      h('label', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        h(antd.Switch, { checked: isDefault, onChange: setIsDefault }), 'Đặt làm mặc định'),
      h('label', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        h(antd.Switch, { checked: enabled, disabled: isAdminLayout, onChange: setEnabled }), 'Kích hoạt')));
  }

  function BlueprintModal({ blueprint, onClose }) {
    const [copied, setCopied] = React.useState(false);
    const timerRef = React.useRef ? React.useRef(null) : { current: null };
    React.useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);
    const json = blueprint ? JSON.stringify(blueprint, null, 2) : '';
    async function copyJson() {
      try {
        await navigator?.clipboard?.writeText(json);
        setCopied(true);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopied(false), 2000);
      } catch {}
    }
    return h(antd.Modal, {
      open: Boolean(blueprint),
      title: 'Portal Blueprint JSON (Apache-2.0)',
      width: 680,
      onCancel: onClose,
      footer: [
        h(antd.Button, { key: 'copy', onClick: copyJson }, copied ? 'Đã sao chép' : 'Sao chép JSON'),
        h(antd.Button, { key: 'close', type: 'primary', onClick: onClose }, 'Đóng'),
      ],
    }, h('pre', {
      style: {
        maxHeight: 420, overflow: 'auto', background: '#0f172a', color: '#e2e8f0',
        padding: 14, borderRadius: 8, fontSize: 12, margin: 0,
      },
    }, json));
  }

  return { PortalFormModal, BlueprintModal };
}

module.exports = { createPortalModals, PORTAL_ICONS, PORTAL_COLORS };
