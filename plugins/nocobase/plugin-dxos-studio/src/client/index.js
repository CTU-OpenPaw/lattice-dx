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
  const { createDxosStudioSettingsPage } = require('./studio-settings');
  const { createFlowStudioApp } = require('./flow/flow-studio-app');

  function registerStudioSettings(app, Page, FlowPage) {
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
      const FlowPage = createFlowStudioApp(client, React, antd, this.app);
      registerStudioSettings(this.app, Page, FlowPage);
    }
  }

  return {
    __esModule: true,
    default: DxosStudioClientPlugin,
    createDxosStudioSettingsPage,
    createFlowStudioApp,
    registerStudioSettings,
  };
});
