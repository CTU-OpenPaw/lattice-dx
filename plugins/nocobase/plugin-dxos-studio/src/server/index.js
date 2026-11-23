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
const { validateServiceTicket } = require('./service-schema');
const { createServiceScopeMiddleware } = require('./service-scope');
const { createDxosStudioActions } = require('./studio-resource');
const {
  WMS_DMN_COLLECTIONS,
  createDxosWmsActions,
  createWmsDmnDirectGuardMiddleware,
  validateTenantCollectionRecord,
} = require('./wms-engine');
const { createDxosDmnActions } = require('./dmn-engine');
const { createDxosDelegationsActions } = require('./delegation-engine');
const {
  createAutomationDirectGuardMiddleware,
  createDxosAutomationsActions,
  registerAutomationEventListener,
} = require('./automation-engine');
const { createDxosBuilderActions } = require('./domain-builder');

class DxosStudioPlugin extends Plugin {
  stopAutomationListener() {
    if (this._automationListenerHandle && typeof this._automationListenerHandle.stop === 'function') {
      this._automationListenerHandle.stop();
    }
    this._automationListenerHandle = null;
  }

  async load() {
    this.db.on('latticeServiceTickets.beforeValidate', validateServiceTicket);
    for (const colName of WMS_DMN_COLLECTIONS) {
      this.db.on(`${colName}.beforeValidate`, validateTenantCollectionRecord);
    }

    this.app.resourceManager.use(createServiceScopeMiddleware(this.db), { tag: 'dxosServiceScope', after: 'acl', before: 'latticeNativeScope' });
    this.app.resourceManager.use(createWmsDmnDirectGuardMiddleware(this.db), { tag: 'dxosWmsDmnScope', after: 'acl', before: 'latticeNativeScope' });
    this.app.resourceManager.use(createAutomationDirectGuardMiddleware(this.db), { tag: 'dxosAutomationScope', after: 'acl', before: 'latticeNativeScope' });

    this.app.resourceManager.define({
      name: 'dxosStudio',
      actions: createDxosStudioActions(this.db),
    });
    this.app.resourceManager.define({
      name: 'dxosWms',
      actions: createDxosWmsActions(this.db),
    });
    this.app.resourceManager.define({
      name: 'dxosDmn',
      actions: createDxosDmnActions(this.db),
    });
    this.app.resourceManager.define({
      name: 'dxosDelegations',
      actions: createDxosDelegationsActions(this.db),
    });
    this.app.resourceManager.define({
      name: 'dxosAutomations',
      actions: createDxosAutomationsActions(this.db),
    });
    this.app.resourceManager.define({
      name: 'dxosBuilder',
      actions: createDxosBuilderActions(this.db),
    });

    this.app.acl.registerSnippet({
      name: 'pm.dxosStudio',
      actions: ['dxosStudio:*'],
    });
    this.app.acl.allow(
      'dxosWms',
      ['orderLines', 'saveOrderLine', 'receiveStock', 'lots', 'allocateFefo', 'issueStock', 'holdLotByMkt', 'epodCapture', 'printVoucher'],
      'loggedIn',
    );
    this.app.acl.allow('dxosWms', ['publicTrack'], 'public');
    this.app.acl.allow('dxosDmn', ['listTables', 'saveTable', 'evaluate'], 'loggedIn');
    this.app.acl.allow('dxosDelegations', ['list', 'create', 'revoke', 'activeForUser'], 'loggedIn');
    this.app.acl.allow(
      'dxosAutomations',
      ['listRules', 'saveRule', 'toggleRule', 'deleteRule', 'testRule', 'runNow', 'listRuns', 'getRunTrace', 'replayRun'],
      'loggedIn',
    );
    this.app.acl.allow(
      'dxosBuilder',
      ['listDomains', 'createDomain', 'listBusinessPacks', 'installBusinessPack', 'listTenants', 'provisionTenant'],
      'loggedIn',
    );

    this.stopAutomationListener();
    this._automationListenerHandle = registerAutomationEventListener(this.app, this.db);
  }

  async unload() {
    this.stopAutomationListener();
  }

  async remove() {
    this.stopAutomationListener();
  }

  async destroy() {
    this.stopAutomationListener();
  }
}

module.exports = DxosStudioPlugin;
module.exports.default = DxosStudioPlugin;
