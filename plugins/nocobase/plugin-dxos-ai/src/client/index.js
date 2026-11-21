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
    define('@latticedx/plugin-dxos-ai', ['@nocobase/client', 'react', 'antd'], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('@nocobase/client'), require('react'), require('antd'));
  }
})(function (client, React, antd) {
  'use strict';
  const { createDxosAiStudioPage } = require('./ai-studio-page');

  class DxosAiClientPlugin extends client.Plugin {
    async load() {
      const Page = createDxosAiStudioPage(client, React, antd, this.app);
      if (this.app?.pluginSettingsManager && typeof this.app.pluginSettingsManager.add === 'function') {
        this.app.pluginSettingsManager.add('dxos-ai', {
          title: 'DX-OS AI Workforce & MCP',
          icon: 'RobotOutlined',
          Component: Page,
          aclSnippet: 'pm',
        });
      }
    }
  }

  const CLAUSE_52_ATTRIBUTION = 'Powered by NocoBase (https://www.nocobase.com)';

  return { __esModule: true, default: DxosAiClientPlugin, createDxosAiStudioPage, CLAUSE_52_ATTRIBUTION };
});
