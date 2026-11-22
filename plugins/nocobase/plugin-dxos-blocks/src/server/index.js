/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { Plugin } = require('@nocobase/server');
const { createDxosBlocksActions } = require('./blocks-api');

class DxosBlocksServerPlugin extends Plugin {
  async load() {
    this.app.resourceManager.define({
      name: 'dxosBlocks',
      actions: createDxosBlocksActions(this.db),
    });
    this.app.acl.allow('dxosBlocks', ['proposals', 'contextTelemetry', 'telemetrySeries', 'alarmIngest', 'alarmAck', 'alarmClear', 'exportReport', 'globalSearch'], 'loggedIn');
  }
}

module.exports = DxosBlocksServerPlugin;
module.exports.default = DxosBlocksServerPlugin;
