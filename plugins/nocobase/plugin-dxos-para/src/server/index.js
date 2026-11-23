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
const { createParaActions, syncDocumentChunks } = require('./para-resource');

const readVal = (row, key) => (typeof row?.get === 'function' ? row.get(key) : row?.[key]);

function runAfterCommit(options, fn) {
  const exec = () => Promise.resolve().then(fn).catch(() => {});
  if (typeof options?.transaction?.afterCommit === 'function') {
    options.transaction.afterCommit(exec);
    return;
  }
  exec();
}

class DxosParaPlugin extends Plugin {
  async load() {
    this.db.on('latticeParaDocuments.beforeValidate', validateParaDocument);

    const scheduleChunkSync = (model, options = {}) => {
      if (!model || options?.context?.skipParaChunkSync) return;
      if (typeof this.db?.getRepository !== 'function') return;
      runAfterCommit(options, () => syncDocumentChunks(this.db, model));
    };

    const scheduleChunkDelete = (model, options = {}) => {
      if (!model || typeof this.db?.getRepository !== 'function') return;
      const chunkRepo = this.db.getRepository('latticeParaChunks');
      const documentId = readVal(model, 'id');
      const organizationId = readVal(model, 'organizationId');
      if (!chunkRepo || typeof chunkRepo.destroy !== 'function' || documentId == null || !organizationId) return;
      runAfterCommit(options, () => chunkRepo.destroy({ filter: { documentId, organizationId } }));
    };

    this.db.on('latticeParaDocuments.afterCreate', scheduleChunkSync);
    this.db.on('latticeParaDocuments.afterUpdate', scheduleChunkSync);
    this.db.on('latticeParaDocuments.afterDestroy', scheduleChunkDelete);

    this.app.resourceManager.use(createParaScopeMiddleware(this.db), { tag: 'dxosParaScope', after: 'acl', before: 'latticeNativeScope' });
    this.app.resourceManager.define({
      name: 'latticePara',
      actions: createParaActions(this.db),
    });
    this.app.acl.allow('latticePara', ['summary', 'hybridSearch', 'extractAttachment', 'reindex'], 'loggedIn');
  }
}

module.exports = DxosParaPlugin;
module.exports.default = DxosParaPlugin;
