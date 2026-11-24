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

  class DxosStudioClientPlugin extends client.Plugin {
    async load() {
      const Page = createDxosStudioSettingsPage(client, React, antd, this.app);
      const FlowPage = createFlowStudioApp(client, React, antd, this.app);
      if (this.app?.pluginSettingsManager && typeof this.app.pluginSettingsManager.add === 'function') {
        this.app.pluginSettingsManager.add('workflow.automation', {
          title: 'Workflow Automation',
          icon: 'ApartmentOutlined',
          Component: FlowPage,
          aclSnippet: 'pm',
          sort: 20,
        });
        this.app.pluginSettingsManager.add('dxos-studio', {
          title: 'DX-OS Studio',
          icon: 'ControlOutlined',
          Component: Page,
          aclSnippet: 'pm',
        });
      }
      if (this.app?.router && typeof this.app.router.add === 'function') {
        this.app.router.add('admin.settings.dxos-flow-studio', {
          path: '/admin/settings/dxos-flow-studio',
          Component: FlowPage,
        });
      }
    }
  }

  return {
    __esModule: true,
    default: DxosStudioClientPlugin,
    createDxosStudioSettingsPage,
    createFlowStudioApp,
  };
});
