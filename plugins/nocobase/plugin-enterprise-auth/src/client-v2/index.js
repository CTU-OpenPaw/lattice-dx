/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
(function (factory) {
  if (typeof define === 'function' && define.amd) {
    define('@latticedx/plugin-enterprise-auth/client-v2', ['@nocobase/client-v2', 'react', 'antd'], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('@nocobase/client-v2'), require('react'), require('antd'));
  }
})(function (clientV2, React, antd) {
  'use strict';
  const h = React.createElement;
  const TYPE = 'lattice-keycloak';

  function LoginButton({ authenticator, returnTo = '/admin' }) {
    const failed = new URLSearchParams(window.location.search).get('enterpriseError') === 'verification_failed';
    const button = h(antd.Button, {
      block: true,
      type: 'primary',
      onClick: () => window.location.assign('/api/enterpriseAuth:start?' + new URLSearchParams({ authenticator: authenticator.name, returnTo })),
    }, authenticator.title || 'Đăng nhập doanh nghiệp');
    return failed
      ? h(antd.Space, { direction: 'vertical', style: { width: '100%' } },
          h(antd.Alert, { type: 'error', message: 'Không xác thực được tài khoản doanh nghiệp. Kiểm tra liên kết tài khoản hoặc thử lại.' }),
          button)
      : button;
  }

  function EnterpriseLoginBlock({ title = 'Đăng nhập doanh nghiệp' } = {}) {
    const api = clientV2.useAPIClient?.();
    const [providers, setProviders] = React.useState(null);
    const [selected, setSelected] = React.useState();
    const [error, setError] = React.useState(false);
    React.useEffect(() => {
      if (!api?.request) return undefined;
      let active = true;
      api.request({ url: 'authenticators:publicList', skipAuth: true }).then((r) => {
        if (!active) return;
        const list = (r?.data?.data || []).filter((x) => x.authType === TYPE);
        setProviders(list);
        setSelected(list[0]?.name);
      }).catch(() => { if (active) setError(true); });
      return () => { active = false; };
    }, [api]);
    if (error) return h(antd.Alert, { type: 'error', message: 'Không tải được phương thức đăng nhập.' });
    if (!providers) return h(antd.Spin);
    if (!providers.length) return h(antd.Alert, { type: 'info', message: 'Quản trị viên cần bật Enterprise login trong Authentication.' });
    return h(antd.Space, { direction: 'vertical', style: { width: '100%' } },
      h(antd.Typography.Title, { level: 5 }, title),
      h(antd.Typography.Text, null, 'Sử dụng tài khoản doanh nghiệp để vào hệ thống.'),
      providers.length > 1 ? h(antd.Select, { value: selected, onChange: setSelected, style: { width: '100%' }, options: providers.map((p) => ({ value: p.name, label: p.title || p.name })) }) : null,
      h(LoginButton, { authenticator: providers.find((p) => p.name === selected) || providers[0] }));
  }

  function Callback() {
    const api = clientV2.useAPIClient?.();
    const [failed, setFailed] = React.useState(false);
    const once = React.useRef(false);
    React.useEffect(() => {
      if (once.current || !api?.request) return;
      once.current = true;
      const ticket = new URLSearchParams(window.location.search).get('ticket');
      window.history.replaceState(null, '', '/enterprise-login');
      api.request({ url: 'enterpriseAuth:finish', method: 'post', data: { ticket }, skipAuth: true, skipNotify: true }).then((r) => {
        const data = r.data.data;
        api.auth?.setToken?.(data.token);
        api.auth?.setAuthenticator?.(data.authenticator);
        api.auth?.setRole?.(null);
        window.location.replace(data.returnTo);
      }).catch(() => setFailed(true));
    }, [api]);
    return h('div', { style: { maxWidth: 440, margin: '100px auto' } },
      failed
        ? h(antd.Result, { status: 'error', title: 'Không thể hoàn tất đăng nhập', subTitle: 'Phiên xác thực đã hết hạn hoặc tài khoản chưa được liên kết.', extra: h(antd.Button, { href: '/signin' }, 'Về trang đăng nhập') })
        : h(antd.Spin, { tip: 'Đang xác thực tài khoản doanh nghiệp...' }, h('div', { style: { height: 80 } })));
  }

  function MappingSettings() {
    const api = clientV2.useAPIClient?.();
    const [form] = antd.Form.useForm();
    const [configuration, setConfiguration] = React.useState();
    const [mappings, setMappings] = React.useState([]);
    const [targets, setTargets] = React.useState({ authenticators: [], users: [] });
    const [loadingMappings, setLoadingMappings] = React.useState(false);
    const [unlinkingKey, setUnlinkingKey] = React.useState(null);
    const [linking, setLinking] = React.useState(false);
    const [status, setStatus] = React.useState();
    const loadMappings = React.useCallback(async () => {
      if (!api?.request) return;
      setLoadingMappings(true);
      try {
        const r = await api.request({ url: 'enterpriseAuth:listMappings', skipNotify: true });
        setMappings(r.data.data?.items || []);
      } catch {
        setStatus({ type: 'error', message: 'Không thể tải danh sách liên kết danh tính.' });
      } finally {
        setLoadingMappings(false);
      }
    }, [api]);
    React.useEffect(() => {
      if (!api?.request) return;
      api.request({ url: 'enterpriseAuth:configuration', skipNotify: true }).then((r) => {
        setConfiguration(r.data?.data || r.data);
      }).catch((err) => {
        const code = err?.response?.status || err?.status;
        setStatus({ type: 'error', message: code === 403 ? 'Chỉ quản trị viên root được cấu hình. Kiểm tra cấu hình triển khai.' : 'Không thể tải cấu hình SSO doanh nghiệp.' });
      });
      api.request({ url: 'enterpriseAuth:listLinkTargets', skipNotify: true }).then((r) => {
        const data = r.data?.data || r.data;
        if (data && (Array.isArray(data.authenticators) || Array.isArray(data.users))) {
          setTargets({ authenticators: Array.isArray(data.authenticators) ? data.authenticators : [], users: Array.isArray(data.users) ? data.users : [] });
          const firstAuth = data.authenticators?.find((a) => a.enabled !== false) || data.authenticators?.[0];
          if (firstAuth?.name && typeof form.getFieldValue === 'function' && !form.getFieldValue('authenticator')) {
            form.setFieldsValue?.({ authenticator: firstAuth.name });
          }
        }
      }).catch(() => {});
      loadMappings();
    }, [api, loadMappings, form]);
    const handleUnlink = async (row) => {
      const rowKey = `${row.authenticator}:${row.subject}:${row.userId}`;
      setUnlinkingKey(rowKey);
      try {
        await api.request({ url: 'enterpriseAuth:unlink', method: 'post', data: { authenticator: row.authenticator, subject: row.subject, userId: row.userId }, skipNotify: true });
        setStatus({ type: 'success', message: `Đã gỡ liên kết ${row.subject} khỏi user #${row.userId} và thu hồi phiên hiện tại.` });
        await loadMappings();
      } catch {
        setStatus({ type: 'error', message: 'Không thể gỡ liên kết tài khoản.' });
      } finally {
        setUnlinkingKey(null);
      }
    };
    const info = configuration ? h(antd.Descriptions, { column: 1, items: Object.entries(configuration).filter(([k]) => k !== 'warning' && k !== 'configured').map(([key, value]) => ({ key, label: key, children: value ?? '—' })) }) : null;
    const configWarning = configuration && configuration.configured === false
      ? h(antd.Alert, { type: 'warning', showIcon: true, message: 'Cấu hình SSO doanh nghiệp chưa sẵn sàng hoặc không khớp môi trường', description: configuration.warning || 'Kiểm tra cấu hình Keycloak.' })
      : null;
    const mappingTable = h(antd.Table, {
      rowKey: (r) => `${r.authenticator}:${r.subject}:${r.userId}`,
      size: 'small',
      loading: loadingMappings,
      pagination: false,
      dataSource: mappings,
      locale: { emptyText: 'Chưa có liên kết danh tính doanh nghiệp nào.' },
      columns: [
        { title: 'Authenticator', dataIndex: 'authenticator' },
        { title: 'Subject (Keycloak)', dataIndex: 'subject' },
        { title: 'User / Nhân viên', key: 'userDisplay', render: (_v, row) => {
          const label = [row.employeeName, row.username, row.email].filter(Boolean).join(' · ');
          return label ? `${label} (#${row.userId})` : `#${row.userId}`;
        } },
        { title: 'Tổ chức', dataIndex: 'organizationId', render: (v) => v || '—' },
        { title: 'Issuer', dataIndex: 'issuer' },
        { title: 'Thao tác', key: 'action', render: (_v, row) => {
          const rowKey = `${row.authenticator}:${row.subject}:${row.userId}`;
          const isUnlinking = unlinkingKey === rowKey;
          return h(antd.Popconfirm, {
            title: 'Xác nhận gỡ liên kết?',
            description: `Gỡ liên kết ${row.subject} khỏi user #${row.userId} và thu hồi phiên hiện tại?`,
            okText: 'Gỡ liên kết',
            cancelText: 'Hủy',
            okButtonProps: { danger: true, loading: isUnlinking },
            onConfirm: () => handleUnlink(row),
          }, h(antd.Button, { danger: true, size: 'small', loading: isUnlinking, disabled: Boolean(unlinkingKey) && !isUnlinking }, 'Gỡ liên kết'));
        } },
      ],
    });
    const authOptions = targets.authenticators.map((a) => ({ value: a.name, label: `${a.title || a.name} (${a.name})` }));
    const userOptions = targets.users.map((u) => {
      const name = u.employeeName || u.nickname || u.username || `User #${u.id}`;
      const meta = [u.email || u.username, u.employeeCode, u.organizationId].filter(Boolean).join(' · ');
      return { value: String(u.id), label: meta ? `${name} (${meta}) — #${u.id}` : `${name} (#${u.id})` };
    });
    return h(antd.Space, { direction: 'vertical', style: { padding: 24, maxWidth: 980, width: '100%' } },
      h(antd.Typography.Title, { level: 4 }, 'Enterprise identity mappings'),
      h(antd.Alert, { type: 'info', showIcon: true, message: 'Kết nối Keycloak native', description: 'Liên kết subject với tài khoản có sẵn tại Enterprise identity mappings.' }),
      configWarning,
      info,
      status ? h(antd.Alert, status) : null,
      mappingTable,
      h(antd.Form, {
        form,
        layout: 'vertical',
        onFinish: async (values) => {
          setLinking(true);
          try {
            await api.request({ url: 'enterpriseAuth:link', method: 'post', data: values, skipNotify: true });
            form.resetFields();
            setStatus({ type: 'success', message: 'Đã liên kết tài khoản. Quyền và đơn vị giữ theo NocoBase.' });
            await loadMappings();
          } catch (err) {
            setStatus({ type: 'error', message: err?.response?.data?.errors?.[0]?.message || err?.message || 'Không thể liên kết.' });
          } finally {
            setLinking(false);
          }
        },
      },
      h(antd.Form.Item, { name: 'authenticator', label: 'Tên authenticator', rules: [{ required: true, message: 'Vui lòng chọn tên authenticator.' }] },
        authOptions.length > 0 ? h(antd.Select, { placeholder: 'native-keycloak', options: authOptions, showSearch: true, optionFilterProp: 'label' }) : h(antd.Input, { placeholder: 'native-keycloak' })),
      h(antd.Form.Item, { name: 'subject', label: 'Keycloak user ID (subject)', rules: [{ required: true, message: 'Vui lòng nhập Keycloak user ID (subject).' }] },
        h(antd.Input, { placeholder: 'UUID người dùng Keycloak' })),
      h(antd.Form.Item, { name: 'userId', label: 'Người dùng / Nhân viên nội bộ', rules: [{ required: true, message: 'Vui lòng chọn NocoBase user ID.' }, { pattern: /^\d+$/, message: 'User ID phải là số nguyên dương.' }] },
        userOptions.length > 0 ? h(antd.Select, { placeholder: 'Chọn tài khoản nhân viên', options: userOptions, showSearch: true, optionFilterProp: 'label' }) : h(antd.Input, { placeholder: 'ID tài khoản' })),
      h(antd.Button, { type: 'primary', htmlType: 'submit', loading: linking, disabled: linking }, 'Liên kết tài khoản')));
  }

  class EnterpriseAuthClientV2 extends clientV2.Plugin {
    async load() {
      this.app?.addComponents?.({ EnterpriseLoginBlock });
      this.app?.router?.add?.('enterprise-login', { path: '/enterprise-login', Component: Callback, skipAuthCheck: true });
      this.app?.pluginSettingsManager?.add?.('auth.enterprise-mappings', {
        title: 'Enterprise identity mappings',
        icon: 'LinkOutlined',
        Component: MappingSettings,
        aclSnippet: 'pm.auth.authenticators',
        sort: 20,
      });
    }
  }
  return { __esModule: true, default: EnterpriseAuthClientV2 };
});
