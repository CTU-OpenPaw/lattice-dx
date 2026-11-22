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

class DxosStudioPlugin extends Plugin {
  async load() {
    this.db.on('latticeServiceTickets.beforeValidate', validateServiceTicket);
    this.app.resourceManager.use(createServiceScopeMiddleware(this.db), { tag: 'dxosServiceScope', after: 'acl' });
    this.app.resourceManager.define({
      name: 'dxosStudio',
      actions: createDxosStudioActions(this.db),
    });
    this.app.acl.registerSnippet({
      name: 'pm.dxosStudio',
      actions: ['dxosStudio:*'],
    });
  }
}

module.exports = DxosStudioPlugin;
module.exports.default = DxosStudioPlugin;
