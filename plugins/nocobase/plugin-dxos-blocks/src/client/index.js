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
    define('@latticedx/plugin-dxos-blocks', ['@nocobase/client', 'react', 'antd', '@nocobase/client-v2'], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('@nocobase/client'),
      require('react'),
      require('antd'),
      require('@nocobase/client-v2'),
    );
  }
})(function (client, React, antd, clientV2) {
  'use strict';
  const { registerDxosBlockModels } = require('./block-models');
  const { createCommandPaletteProvider } = require('./command-palette');
  const { createRecordChatterView } = require('./chatter-panel');
  const { createBiChartBlockView } = require('./bi-chart-block');

  class DxosBlocksClientPlugin extends client.Plugin {
    async load() {
      registerDxosBlockModels(client, React, antd, clientV2, this.flowEngine || this.app?.flowEngine, this.app);
      const CommandPaletteProvider = createCommandPaletteProvider(client, React, antd, this.app);
      if (this.app?.use && CommandPaletteProvider) {
        this.app.use(CommandPaletteProvider);
      }
    }
  }

  return {
    __esModule: true,
    default: DxosBlocksClientPlugin,
    registerDxosBlockModels,
    createCommandPaletteProvider,
    createRecordChatterView,
    createBiChartBlockView,
  };
});
