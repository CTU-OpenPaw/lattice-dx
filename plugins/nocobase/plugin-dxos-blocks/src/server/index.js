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
    if (typeof this.app?.resourceManager?.use === 'function') {
      this.app.resourceManager.use(async (ctx, next) => {
        if (ctx.state?.currentRole === 'root') return next();
        const resName = String(ctx.action?.resourceName || '').split('.')[0];
        const actionName = String(ctx.action?.actionName || '');
        if (resName === 'charts' && actionName === 'queryData' && ctx.action?.params?.values?.collection === 'latticeTelemetryPoints') {
          throw Object.assign(new Error('Vui lòng sử dụng dxosBlocks:telemetrySeries để truy vấn telemetry.'), { code: 'TELEMETRY_DIRECT_CRUD_FORBIDDEN', status: 403 });
        }
        if (resName === 'latticeTelemetryPoints') {
          throw Object.assign(new Error('Vui lòng sử dụng dxosBlocks:telemetrySeries và dxosBlocks:telemetryIngest.'), { code: 'TELEMETRY_DIRECT_CRUD_FORBIDDEN', status: 403 });
        }
        if (resName === 'charts' && actionName === 'queryData' && ctx.action?.params?.values?.collection === 'latticeTwinShadows') {
          throw Object.assign(new Error('Vui lòng sử dụng dxosBlocks:twinShadow để truy vấn digital twin shadow.'), { code: 'TWIN_DIRECT_CRUD_FORBIDDEN', status: 403 });
        }
        if (resName === 'latticeTwinShadows') {
          throw Object.assign(new Error('Vui lòng sử dụng dxosBlocks:twinShadow, dxosBlocks:twinSetDesired và dxosBlocks:twinAckCommand.'), { code: 'TWIN_DIRECT_CRUD_FORBIDDEN', status: 403 });
        }
        return next();
      }, { tag: 'dxosTelemetryDirectGuard', after: 'acl' });
    }
    this.app.resourceManager.define({
      name: 'dxosBlocks',
      actions: createDxosBlocksActions(this.db),
    });
    this.app.acl.allow('dxosBlocks', [
      'proposals',
      'contextTelemetry',
      'telemetrySeries',
      'alarmIngest',
      'alarmAck',
      'alarmClear',
      'exportReport',
      'globalSearch',
      'twinShadow',
      'twinSetDesired',
      'bulkImportDryRun',
      'bulkImportCommit',
    ], 'loggedIn');
    // Handler-level fail-closed auth verifies either valid X-Lattice-Edge-Token (timingSafeEqual) or logged-in ACL user.
    this.app.acl.allow('dxosBlocks', ['telemetryIngest', 'twinAckCommand'], 'public');
  }
}

module.exports = DxosBlocksServerPlugin;
module.exports.default = DxosBlocksServerPlugin;
