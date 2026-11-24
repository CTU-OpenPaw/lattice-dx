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
const { createParaScopeMiddleware, runParaRlsOp } = require('./para-scope');
const { createParaActions, syncDocumentChunks } = require('./para-resource');

const readVal = (row, key) => (typeof row?.get === 'function' ? row.get(key) : row?.[key]);

const MAX_RETRY_LOG_ENTRIES = 50;
const DEFAULT_AFTER_COMMIT_MAX_ATTEMPTS = 3;
const DEFAULT_AFTER_COMMIT_BASE_DELAY_MS = 1000;

function recordRetryMetadata(retryLog, entry) {
  if (!Array.isArray(retryLog)) return;
  const idx = retryLog.findIndex(
    (item) => item.operation === entry.operation
      && item.documentId === entry.documentId
      && item.organizationId === entry.organizationId
      && !item.resolved,
  );
  if (idx >= 0) {
    retryLog[idx] = entry;
  } else {
    retryLog.push(entry);
    while (retryLog.length > MAX_RETRY_LOG_ENTRIES) retryLog.shift();
  }
}

function markRetryResolved(retryLog, meta) {
  if (!Array.isArray(retryLog)) return;
  for (const item of retryLog) {
    if (
      item.operation === meta.operation
      && item.documentId === meta.documentId
      && item.organizationId === meta.organizationId
      && !item.resolved
    ) {
      item.resolved = true;
      item.retryable = false;
      item.resolvedAt = new Date().toISOString();
    }
  }
}

function runAfterCommit(options, fn, meta = {}) {
  const maxAttempts = Math.max(1, Number(meta.maxAttempts) || DEFAULT_AFTER_COMMIT_MAX_ATTEMPTS);
  const baseDelayMs = Math.max(10, Number(meta.baseDelayMs) || DEFAULT_AFTER_COMMIT_BASE_DELAY_MS);
  const logger = meta.logger || console;
  const retryLog = Array.isArray(meta.retryLog) ? meta.retryLog : null;

  const attemptExec = (attempt) => Promise.resolve()
    .then(() => fn(attempt))
    .then((res) => {
      if (attempt > 1 && retryLog) markRetryResolved(retryLog, meta);
      return res;
    })
    .catch((err) => {
      const retryable = attempt < maxAttempts;
      const backoffMs = retryable ? baseDelayMs * (2 ** (attempt - 1)) : 0;
      const nextRetryAt = retryable ? new Date(Date.now() + backoffMs).toISOString() : null;
      const failureMeta = {
        event: 'dxos_para.after_commit_failed',
        operation: meta.operation || 'syncDocumentChunks',
        documentId: meta.documentId ?? null,
        organizationId: meta.organizationId ?? null,
        attempt,
        maxAttempts,
        retryable,
        backoffMs,
        nextRetryAt,
        failedAt: new Date().toISOString(),
        errorCode: err?.code || null,
        errorMessage: String(err?.message || err || 'Unknown afterCommit error').slice(0, 500),
      };
      if (retryLog) recordRetryMetadata(retryLog, failureMeta);
      const logFn = typeof logger?.error === 'function'
        ? logger.error
        : (typeof logger?.warn === 'function' ? logger.warn : console.error);
      try {
        logFn.call(logger, '[dxos-para] afterCommit indexing failed', failureMeta);
      } catch {
        // Never allow logger failure to crash background afterCommit execution
      }
      if (retryable && meta.scheduleRetry !== false) {
        const timer = setTimeout(() => {
          void attemptExec(attempt + 1);
        }, backoffMs);
        if (typeof timer?.unref === 'function') timer.unref();
      }
      return null;
    });

  const exec = () => attemptExec(1);
  if (typeof options?.transaction?.afterCommit === 'function') {
    options.transaction.afterCommit(exec);
    return;
  }
  return exec();
}

class DxosParaPlugin extends Plugin {
  async load() {
    this.indexingRetryLog = [];
    this.db.on('latticeParaDocuments.beforeValidate', validateParaDocument);

    const scheduleChunkSync = (model, options = {}) => {
      if (!model || options?.context?.skipParaChunkSync) return;
      if (typeof this.db?.getRepository !== 'function') return;
      runAfterCommit(
        options,
        () => syncDocumentChunks(this.db, model),
        {
          operation: 'syncDocumentChunks',
          documentId: readVal(model, 'id') ?? null,
          organizationId: readVal(model, 'organizationId') ?? null,
          logger: this.app?.logger || console,
          retryLog: this.indexingRetryLog,
        },
      );
    };

    const scheduleChunkDelete = (model, options = {}) => {
      if (!model || typeof this.db?.getRepository !== 'function') return;
      const chunkRepo = this.db.getRepository('latticeParaChunks');
      const documentId = readVal(model, 'id');
      const organizationId = readVal(model, 'organizationId');
      if (!chunkRepo || typeof chunkRepo.destroy !== 'function' || documentId == null || !organizationId) return;
      runAfterCommit(
        options,
        () => runParaRlsOp(this.db, organizationId, (transaction) => chunkRepo.destroy({
          filter: { documentId, organizationId },
          ...(transaction ? { transaction } : {}),
        })),
        {
          operation: 'destroyDocumentChunks',
          documentId,
          organizationId,
          logger: this.app?.logger || console,
          retryLog: this.indexingRetryLog,
        },
      );
    };

    this.db.on('latticeParaDocuments.afterCreate', scheduleChunkSync);
    this.db.on('latticeParaDocuments.afterUpdate', scheduleChunkSync);
    this.db.on('latticeParaDocuments.afterDestroy', scheduleChunkDelete);

    this.app.resourceManager.use(createParaScopeMiddleware(this.db), { tag: 'dxosParaScope', after: 'acl', before: 'latticeNativeScope' });
    this.app.resourceManager.define({
      name: 'latticePara',
      actions: createParaActions(this.db, {
        getIndexingFailures: () => this.indexingRetryLog,
      }),
    });
    this.app.acl.allow('latticePara', ['summary', 'hybridSearch', 'extractAttachment', 'extractFormFields', 'reindex', 'indexHealth'], 'loggedIn');
  }
}

module.exports = DxosParaPlugin;
module.exports.default = DxosParaPlugin;
