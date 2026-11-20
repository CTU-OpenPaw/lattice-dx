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
const { validateParaDocument } = require('./schema');
const { createParaScopeMiddleware } = require('./para-scope');
const { createParaActions } = require('./para-resource');

class DxosParaPlugin extends Plugin {
  async load() {
    this.db.on('latticeParaDocuments.beforeValidate', validateParaDocument);
    this.app.resourceManager.use(createParaScopeMiddleware(this.db), { tag: 'dxosParaScope', after: 'acl' });
    this.app.resourceManager.define({
      name: 'latticePara',
      actions: createParaActions(this.db),
    });
    this.app.acl.allow('latticePara', 'summary', 'loggedIn');
  }
}

module.exports = DxosParaPlugin;
module.exports.default = DxosParaPlugin;
