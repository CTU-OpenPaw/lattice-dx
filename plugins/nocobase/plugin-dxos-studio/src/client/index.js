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
    define('@latticedx/plugin-dxos-studio', ['@nocobase/client', 'react', 'antd'], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('@nocobase/client'), require('react'), require('antd'));
  }
})(function (client, React, antd) {
  'use strict';
  const { createDxosStudioSettingsPage, createFlowPinStorage } = require('./studio-settings');
  const { createFlowStudioApp } = require('./flow/flow-studio-app');
  const { createConnectedAppsPanel } = require('./flow/connected-apps-panel');
  const { createPublicFormBuilderPanel, PublicFormBuilderPanel } = require('./public-form-builder');
  const { createApprovalInboxPanel, ApprovalInboxPanel } = require('./approval-inbox-panel');
  const { renderFlowForbiddenCard, resolveFlowUiAccess } = require('./flow-inspector-extras');

  function createWorkflowConnectorsPage(app) {
    const h = React.createElement;
    const ConnectedAppsPanel = createConnectedAppsPanel(client, React, antd, app);
    const useApi = typeof client?.useAPIClient === 'function' ? client.useAPIClient : () => app?.apiClient || null;
    return function WorkflowConnectorsPage() {
      const api = useApi();
      const uiPerms = typeof client?.useUIConfigurationPermissions === 'function' ? client.useUIConfigurationPermissions() : null;
      const userCtx = typeof client?.useCurrentUserContext === 'function' ? client.useCurrentUserContext() : null;
      const { uiDenied, isAdminRole } = resolveFlowUiAccess({ uiPerms, userCtx, api, app });
      const [forbidden, setForbidden] = React.useState(false);
      const [selectedOrg, setSelectedOrg] = React.useState('');
      const [organizations, setOrganizations] = React.useState([]);
      const [orgReady, setOrgReady] = React.useState(false);
      React.useEffect(() => {
        if (uiDenied) { setOrgReady(true); return; }
        if (!api?.request || !isAdminRole) { setOrgReady(true); return; }
        api.request({ url: 'dxosStudio:listEmployees', method: 'get', skipNotify: true })
          .then((res) => {
            const orgs = res?.data?.data?.organizations || res?.data?.organizations || [];
            if (Array.isArray(orgs) && orgs.length) {
              setOrganizations(orgs);
              setSelectedOrg((cur) => cur || orgs[0]);
            }
          })
          .catch(() => {
            // Non-admin managers lack dxosStudio:listEmployees; ConnectedAppsPanel handles actual dxosVault/dxosN8n ACLs
          })
          .finally(() => setOrgReady(true));
      }, [Boolean(api?.request), uiDenied, isAdminRole]);
      const openRoute = (p) => { if (app?.router?.navigate) app.router.navigate(p); else if (typeof window !== 'undefined' && window.location) window.location.assign(app?.getRouteUrl?.(p) || p); };
      if (forbidden || uiDenied) {
        return renderFlowForbiddenCard(h, {
          testId: 'dxos-workflow-connectors-forbidden',
          title: '403 — Chỉ Quản trị viên mới truy cập được Connectors & n8n',
          description: 'Tài khoản hiện tại không có quyền quản trị kết nối tích hợp.',
          onBack: () => openRoute('/admin/lattice-workspace'),
        });
      }
      return h('div', { 'data-testid': 'dxos-workflow-connectors-tab', style: { padding: 14, background: '#f8fafc', minHeight: 520 } },
        orgReady
          ? h(ConnectedAppsPanel, { api, selectedOrg, organizations, openRoute, onForbidden: () => setForbidden(true) })
          : h('div', { style: { padding: 20, fontSize: 13, color: '#64748b' } }, 'Đang tải danh sách tổ chức & Connected Apps…'),
      );
    };
  }

  function registerStudioSettings(app, Page, FlowPage, ConnectorsPage) {
    const psm = app?.pluginSettingsManager;
    if (!psm || typeof psm.add !== 'function') return;

    const existingWf = typeof psm.getSetting === 'function' ? psm.getSetting('workflow') : psm.settings?.workflow;
    const existingWfComp = existingWf?.Component;
    const existingWfLoader = existingWf?.componentLoader;
    const isOutletComp = Boolean(existingWfComp && (existingWfComp.name === 'Outlet' || existingWfComp.displayName === 'Outlet'));
    const hasWorkflowsChild = Boolean(
      typeof psm.getSetting === 'function' ? psm.getSetting('workflow.workflows') : psm.settings?.['workflow.workflows'],
    );

    if (existingWf && !hasWorkflowsChild && (existingWfLoader || (existingWfComp && !isOutletComp))) {
      // Omit Component so NocoBase pluginSettingsManager.add promotes 'workflow' back to Outlet.
      psm.add('workflow', {
        title: existingWf.title || 'Workflow',
        icon: existingWf.icon || 'PartitionOutlined',
        isPinned: existingWf.isPinned ?? true,
        sort: existingWf.sort ?? 300,
        aclSnippet: existingWf.aclSnippet || 'pm.workflow.workflows',
        componentLoader: undefined,
      });
      psm.add('workflow.workflows', {
        title: existingWf.title || 'Workflow',
        icon: existingWf.icon || 'PartitionOutlined',
        ...(existingWfComp ? { Component: existingWfComp } : {}),
        ...(existingWfLoader ? { componentLoader: existingWfLoader } : {}),
        aclSnippet: existingWf.aclSnippet || 'pm.workflow.workflows',
        sort: 10,
      });
    }

    psm.add('workflow.automation', {
      title: 'Workflow Automation',
      icon: 'ApartmentOutlined',
      Component: FlowPage,
      aclSnippet: 'pm',
      sort: 20,
    });
    if (ConnectorsPage) {
      psm.add('workflow.connectors', {
        title: 'Connectors & n8n',
        icon: 'ApiOutlined',
        Component: ConnectorsPage,
        aclSnippet: 'pm',
        sort: 30,
      });
    }
    psm.add('dxos-flow-studio', {
      title: 'Workflow Automation',
      icon: 'ApartmentOutlined',
      Component: FlowPage,
      aclSnippet: 'pm',
      hidden: true,
      link: '/admin/settings/workflow/automation',
    });
    psm.add('dxos-studio', {
      title: 'DX-OS Studio',
      icon: 'ControlOutlined',
      Component: Page,
      aclSnippet: 'pm',
    });
  }

  class DxosStudioClientPlugin extends client.Plugin {
    async load() {
      const Page = createDxosStudioSettingsPage(client, React, antd, this.app);
      const pinStorage = typeof createFlowPinStorage === 'function' ? createFlowPinStorage() : null;
      const FlowPage = createFlowStudioApp(client, React, antd, this.app, { pinStorage });
      const ConnectorsPage = createWorkflowConnectorsPage(this.app);
      registerStudioSettings(this.app, Page, FlowPage, ConnectorsPage);
    }
  }

  return {
    __esModule: true,
    default: DxosStudioClientPlugin,
    createDxosStudioSettingsPage,
    createFlowStudioApp,
    registerStudioSettings,
    createPublicFormBuilderPanel,
    PublicFormBuilderPanel,
    createApprovalInboxPanel,
    ApprovalInboxPanel,
  };
});
