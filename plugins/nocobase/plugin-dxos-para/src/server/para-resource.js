/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const path = require('node:path');
const { PARA_SPACES } = require('./schema');
const {
  resolveParaActor,
  shouldUseParaPgRls,
  runParaRlsOp,
  runParaSavepoint,
} = require('./para-scope');
const {
  executeHybridSearch,
  computeNeuralEmbeddingsBatch,
  resolveEmbeddingDim,
  resolveEmbeddingEndpoint,
  redactParaPii,
} = require('./para-hybrid-search');
const {
  MAX_UPLOAD_BYTES,
  ALLOWED_FORM_COLLECTIONS,
  extractTextFromBuffer,
  extractStructuredFormFields,
  extractWithMultimodalOcr,
  chunkDocumentText,
} = require('./document-extractor');

const val = (row, key) => (typeof row?.get === 'function' ? row.get(key) : row?.[key]);
const REINDEX_ROLES = new Set(['root', 'admin', 'ldx_admin', 'ldx_director', 'ldx_manager']);
const EDIT_MANAGER_ROLES = new Set(['root', 'admin', 'ldx_admin', 'ldx_manager']);
const RECOGNIZED_PARA_ROLES = new Set([
  'root',
  'admin',
  'ldx_admin',
  'ldx_director',
  'ldx_manager',
  'ldx_employee',
  'ldx_warehouse',
  'ldx_dispatcher',
  'ldx_driver',
]);

function failAction(code, status, message) {
  return Object.assign(new Error(message || code), { code, status });
}

function safeBasename(rawName, fallback = '') {
  const normalized = String(rawName || fallback || '').trim().replace(/\\/g, '/');
  if (!normalized) return '';
  return path.posix.basename(normalized).slice(0, 255);
}

/**
 * Decode and validate a base64 upload payload (supporting optional `data:...;base64,` URI prefix)
 * within the configured binary byte limit.
 *
 * @param {string} rawBase64Input - Raw base64 or data-URI string.
 * @param {object} [options]
 * @param {number} [options.maxBytes=2097152] - Maximum decoded binary size in bytes.
 * @returns {Buffer} Decoded non-empty binary buffer.
 */
function decodeBase64Payload(rawBase64Input, { maxBytes = MAX_UPLOAD_BYTES } = {}) {
  if (typeof rawBase64Input !== 'string' || !rawBase64Input.trim()) {
    throw failAction('ATTACHMENT_CONTENT_REQUIRED', 400, 'Cần cung cấp nội dung contentBase64.');
  }
  const maxBase64Chars = Math.ceil(maxBytes / 3) * 4;
  if (rawBase64Input.length > maxBase64Chars + 131072) {
    throw failAction('ATTACHMENT_TOO_LARGE', 400, 'Kích thước tệp đính kèm base64 vượt quá giới hạn 2MB.');
  }

  let strippedPrefix = rawBase64Input.trim();
  if (strippedPrefix.slice(0, 5).toLowerCase() === 'data:') {
    const markerIdx = strippedPrefix.indexOf(';base64,');
    if (markerIdx > 0 && markerIdx < 256) {
      const header = strippedPrefix.slice(5, markerIdx);
      if (/^[a-z0-9/+.-]+(?:;[a-z0-9=_-]+)*$/i.test(header)) {
        strippedPrefix = strippedPrefix.slice(markerIdx + 8);
      }
    }
  }

  const cleanBase64 = strippedPrefix.replace(/\s+/g, '');
  if (cleanBase64.length > maxBase64Chars) {
    throw failAction('ATTACHMENT_TOO_LARGE', 400, 'Kích thước tệp đính kèm base64 vượt quá giới hạn 2MB.');
  }
  if (!cleanBase64 || !/^[A-Za-z0-9+/=]+$/.test(cleanBase64)) {
    throw failAction('ATTACHMENT_BASE64_INVALID', 400, 'Dữ liệu contentBase64 không hợp lệ.');
  }
  const buffer = Buffer.from(cleanBase64, 'base64');
  if (buffer.length === 0) {
    throw failAction('ATTACHMENT_BASE64_INVALID', 400, 'Dữ liệu contentBase64 không hợp lệ.');
  }
  if (buffer.length > maxBytes) {
    throw failAction('ATTACHMENT_TOO_LARGE', 400, 'Kích thước tệp đính kèm vượt quá giới hạn 2MB.');
  }
  return buffer;
}

async function findScopedParaDocument(db, documentId, organizationId = null, options = {}) {
  const docRepo = db?.getRepository?.('latticeParaDocuments');
  if (!docRepo) return null;
  const docFilter = { id: Number(documentId), ...(organizationId ? { organizationId } : {}) };
  const queryDoc = (transaction) => {
    const txOpt = transaction ? { transaction } : {};
    return typeof docRepo.findOne === 'function'
      ? docRepo.findOne({ filter: docFilter, ...txOpt })
      : docRepo.find({ filter: docFilter, limit: 1, ...txOpt }).then((rows) => (rows || [])[0] || null);
  };
  const doc = options.transaction
    ? await queryDoc(options.transaction)
    : await runParaRlsOp(db, organizationId, queryDoc);
  if (!doc) return null;
  if (organizationId && val(doc, 'organizationId') !== organizationId) return null;
  return doc;
}

/**
 * Build a bounded, control-char-stripped, secret-redacted text preview in linear time.
 *
 * @param {string} text - Raw extracted text.
 * @param {number} [maxLen=500] - Maximum output character length.
 * @returns {string} Redacted preview string.
 */
function buildSafeTextPreview(text, maxLen = 500) {
  const safeMaxLen = Math.max(1, Number(maxLen) || 500);
  const bounded = String(text || '').slice(0, Math.max(safeMaxLen * 4, 2000));
  const stripped = bounded.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  return redactParaPii(stripped).trim().slice(0, safeMaxLen);
}

/**
 * Verify caller read/view ACL permissions for form-field extraction.
 * When `hasDocumentId` is true, `view`/`list` privilege specifically on `latticeParaDocuments` is required.
 *
 * @param {object} db - Database handle providing `getRepository`.
 * @param {object} ctx - NocoBase request context.
 * @param {string[]} roles - Verified caller role names.
 * @param {string} targetCollection - Allowlisted form target collection.
 * @param {object} [options]
 * @param {boolean} [options.hasDocumentId=false] - Whether an existing `documentId` is accessed.
 * @returns {Promise<boolean>}
 */
async function hasFormExtractionAcl(db, ctx, roles, targetCollection, { hasDocumentId = false } = {}) {
  if (roles.includes('root')) return true;
  if (!roles.length) return false;

  const collectionsToCheck = hasDocumentId ? ['latticeParaDocuments'] : ['latticeParaDocuments', targetCollection];
  const viewActions = ['view', 'list'];
  const stateRole = String(ctx?.state?.currentRole || '').trim();
  const stateRoles = Array.isArray(ctx?.state?.currentRoles)
    ? ctx.state.currentRoles.map((r) => String(r || '').trim()).filter(Boolean)
    : [];
  const canTrustCtxCan = typeof ctx?.can === 'function'
    && (!stateRole || roles.includes(stateRole))
    && (!stateRoles.length || stateRoles.every((r) => roles.includes(r)));
  if (canTrustCtxCan) {
    return collectionsToCheck.some((col) => (
      viewActions.some((act) => Boolean(ctx.can({ resource: col, action: act })))
    ));
  }

  const rolesRepo = db?.getRepository?.('roles');
  const resRepo = db?.getRepository?.('dataSourcesRolesResources');
  if (!rolesRepo && !resRepo) {
    return roles.some((r) => RECOGNIZED_PARA_ROLES.has(r));
  }

  for (const roleName of roles) {
    const role = rolesRepo?.findOne ? await rolesRepo.findOne({ filter: { name: roleName } }) : null;
    if (val(role, 'allowAll') === true) return true;
    if (resRepo?.findOne) {
      for (const col of collectionsToCheck) {
        const res = await resRepo.findOne({ filter: { roleName, name: col, dataSourceKey: 'main' } });
        if (res) {
          if (val(res, 'usingActionsConfig') === false) return true;
          const actions = val(res, 'actions') || [];
          if (actions.some((a) => viewActions.includes(a?.name || a))) return true;
        }
      }
    }
    const strategyActions = val(role, 'strategy')?.actions || [];
    if (Array.isArray(strategyActions) && strategyActions.some((a) => viewActions.includes(a?.name || a) || a === '*:*' || a === '*')) {
      return true;
    }
  }
  return false;
}

/**
 * Resolve verified caller roles from `rolesUsers` when the repository is present,
 * never trusting unverified `X-Role` / `state.currentRole` claims when DB roles are empty or mismatched.
 *
 * @param {object} ctx - NocoBase request context.
 * @param {object} db - Database handle providing `getRepository`.
 * @returns {Promise<string[]>}
 */
async function resolveCallerRoles(ctx, db) {
  const stateRole = String(ctx?.state?.currentRole || '').trim();
  const stateRoles = Array.isArray(ctx?.state?.currentRoles)
    ? [...new Set(ctx.state.currentRoles.map((r) => String(r || '').trim()).filter(Boolean))]
    : [];
  const userId = val(ctx?.state?.currentUser, 'id');
  const rolesUsersRepo = typeof db?.getRepository === 'function' ? db.getRepository('rolesUsers') : null;
  const hasRolesUsersRepo = Boolean(rolesUsersRepo && typeof rolesUsersRepo.find === 'function');

  if (hasRolesUsersRepo) {
    if (userId == null) return [];
    const rows = (await rolesUsersRepo.find({ filter: { userId } })) || [];
    const dbRoles = [...new Set(
      rows
        .filter((r) => val(r, 'userId') == null || Number(val(r, 'userId')) === Number(userId))
        .map((r) => String(val(r, 'roleName') || '').trim())
        .filter(Boolean),
    )];
    if (!dbRoles.length) return [];
    const knownRoles = stateRoles.length ? stateRoles.filter((r) => dbRoles.includes(r)) : dbRoles;
    if (!knownRoles.length) return [];
    if (stateRole) {
      return knownRoles.includes(stateRole) ? [stateRole] : [];
    }
    return knownRoles;
  }

  if (stateRole) {
    if (!stateRoles.length || stateRoles.includes(stateRole)) return [stateRole];
    return stateRoles;
  }
  return stateRoles;
}

function readParams(ctx) {
  const body = ctx?.request?.body && typeof ctx.request.body === 'object' && !Array.isArray(ctx.request.body)
    ? ctx.request.body
    : {};
  const bodyVals = body.values && typeof body.values === 'object' && !Array.isArray(body.values) ? body.values : {};
  const p = ctx?.action?.params && typeof ctx.action.params === 'object' ? ctx.action.params : {};
  const v = p.values && typeof p.values === 'object' && !Array.isArray(p.values) ? p.values : {};
  return { ...body, ...bodyVals, ...p, ...v };
}

async function withOptionalTransaction(db, fn) {
  if (typeof db?.sequelize?.transaction === 'function') {
    return db.sequelize.transaction((transaction) => fn(transaction));
  }
  return fn(undefined);
}

async function runParaDbWithOptionalTx(db, organizationId, fn) {
  if (shouldUseParaPgRls(db)) {
    return runParaRlsOp(db, organizationId, fn);
  }
  return withOptionalTransaction(db, fn);
}

/**
 * Synchronize chunked text and embeddings into `latticeParaChunks` for a P.A.R.A. document.
 *
 * @param {object} db - Database handle providing `getRepository` and optional `sequelize`.
 * @param {object} docRow - Source `latticeParaDocuments` record or plain object.
 * @param {object} [options]
 * @param {Record<string, string|undefined>} [options.env=process.env] - Environment config for embedding endpoint.
 * @param {Function} [options.fetchImpl=globalThis.fetch] - Fetch implementation for neural embeddings.
 * @param {string} [options.attachmentText=''] - Extracted attachment text to index alongside document text.
 * @param {string} [options.attachmentFilename=''] - Attachment filename label.
 * @param {number} [options.chunkSize=800] - Maximum characters per chunk.
 * @param {number} [options.overlap=120] - Target character overlap between chunks.
 * @returns {Promise<{documentId: number|string|undefined, organizationId: string|undefined, chunksCreated: number, neuralChunks: number, fallbackChunks: number, embeddingEngine: string, skipped?: boolean, deactivated?: boolean}>}
 */
async function syncDocumentChunks(db, docRow, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  attachmentText = '',
  attachmentFilename = '',
  chunkSize = 800,
  overlap = 120,
} = {}) {
  const chunkRepo = db?.getRepository?.('latticeParaChunks');
  const documentId = val(docRow, 'id');
  const organizationId = val(docRow, 'organizationId');
  if (!chunkRepo || documentId == null || !organizationId) {
    return { documentId, organizationId, chunksCreated: 0, neuralChunks: 0, fallbackChunks: 0, embeddingEngine: 'deterministic-fallback', skipped: true };
  }

  const rawStatus = val(docRow, 'status');
  const status = rawStatus == null || String(rawStatus).trim() === ''
    ? 'active'
    : String(rawStatus).trim().toLowerCase();
  const active = val(docRow, 'active') !== false && status === 'active';
  if (!active) {
    await runParaDbWithOptionalTx(db, organizationId, async (transaction) => {
      if (typeof chunkRepo.destroy === 'function') {
        await chunkRepo.destroy({ filter: { documentId, organizationId }, ...(transaction ? { transaction } : {}) });
      }
    });
    return { documentId, organizationId, chunksCreated: 0, neuralChunks: 0, fallbackChunks: 0, embeddingEngine: 'deterministic-fallback', deactivated: true };
  }

  const code = String(val(docRow, 'code') || documentId).trim();
  const title = String(val(docRow, 'title') || code).trim();
  const summary = String(val(docRow, 'summary') || '').trim();
  const contentMarkdown = String(val(docRow, 'contentMarkdown') || '').trim();
  const tags = String(val(docRow, 'tags') || '').trim();
  const paraSpace = String(val(docRow, 'paraSpace') || 'resources').trim();
  const explicitAttachment = String(attachmentText || val(docRow, 'attachmentText') || '').trim();

  const docText = [summary, contentMarkdown].filter(Boolean).join('\n\n') || title || code;
  const docChunks = chunkDocumentText(docText, { chunkSize, overlap, title })
    .map((c) => ({ ...c, sourceType: 'document' }));

  let attachmentChunks = [];
  if (explicitAttachment) {
    const attTitle = attachmentFilename ? `Đính kèm: ${attachmentFilename}` : `${title} (Đính kèm)`;
    attachmentChunks = chunkDocumentText(explicitAttachment, { chunkSize, overlap, title: attTitle })
      .map((c) => ({ ...c, sourceType: 'attachment' }));
  } else if (typeof chunkRepo.find === 'function') {
    const existingRows = (await runParaRlsOp(db, organizationId, (transaction) => chunkRepo.find({
      filter: { documentId, organizationId, sourceType: 'attachment', active: true },
      limit: 500,
      sort: ['chunkIndex'],
      ...(transaction ? { transaction } : {}),
    }))) || [];
    attachmentChunks = existingRows
      .filter((r) => (
        Number(val(r, 'documentId')) === Number(documentId)
        && val(r, 'organizationId') === organizationId
        && val(r, 'sourceType') === 'attachment'
        && val(r, 'active') !== false
        && String(val(r, 'content') || '').trim()
      ))
      .sort((a, b) => (Number(val(a, 'chunkIndex')) || 0) - (Number(val(b, 'chunkIndex')) || 0))
      .map((r) => ({
        sectionTitle: String(val(r, 'sectionTitle') || title).trim(),
        pageNumber: Math.max(1, Number(val(r, 'pageNumber')) || 1),
        content: String(val(r, 'content') || '').trim(),
        tokenCount: Math.max(1, Number(val(r, 'tokenCount')) || String(val(r, 'content') || '').trim().split(/\s+/).filter(Boolean).length),
        sourceType: 'attachment',
      }));
  }

  const chunks = [...docChunks, ...attachmentChunks].map((c, idx) => ({ ...c, chunkIndex: idx }));

  const embInputs = chunks.map((chunk) => [code, title, chunk.sectionTitle, tags, chunk.content].filter(Boolean).join('\n'));
  // Outbound batched embedding fetch runs strictly outside any DB transaction.
  const embeddings = chunks.length
    ? await computeNeuralEmbeddingsBatch(embInputs, { env, fetchImpl })
    : [];
  const prepared = chunks.map((chunk, idx) => ({ chunk, emb: embeddings[idx] }));

  const createdRows = [];
  await runParaDbWithOptionalTx(db, organizationId, async (transaction) => {
    if (typeof chunkRepo.destroy === 'function') {
      await chunkRepo.destroy({ filter: { documentId, organizationId }, ...(transaction ? { transaction } : {}) });
    }
    if (typeof chunkRepo.create === 'function') {
      for (const { chunk, emb } of prepared) {
        const created = await chunkRepo.create({
          values: {
            documentId,
            organizationId,
            code,
            title,
            paraSpace,
            sourceType: chunk.sourceType || 'document',
            chunkIndex: chunk.chunkIndex,
            sectionTitle: chunk.sectionTitle,
            pageNumber: chunk.pageNumber,
            content: chunk.content,
            tokenCount: chunk.tokenCount,
            embeddingModel: emb.model,
            embeddingEngine: emb.engine,
            embeddingDim: emb.dim,
            embeddingJson: emb.vector,
            active: true,
          },
          ...(transaction ? { transaction } : {}),
        });
        createdRows.push({ row: created, emb });
      }
    }
  });

  // Update pgvector column outside the main transaction so plain Postgres never aborts chunk creation.
  // Wrap in tenant RLS context so FORCE ROW LEVEL SECURITY permits the UPDATE on latticeParaChunks.
  const neuralRowsToUpdate = createdRows.filter(({ row, emb }) => (
    val(row, 'id') != null
    && emb.engine === 'neural'
    && Number.isInteger(emb.dim)
    && emb.dim >= 8
    && emb.dim <= 8192
    && Array.isArray(emb.vector)
    && emb.vector.length === emb.dim
    && emb.vector.every(Number.isFinite)
  ));
  if (typeof db?.sequelize?.query === 'function' && neuralRowsToUpdate.length > 0) {
    try {
      await runParaRlsOp(db, organizationId, async (transaction) => {
        for (const { row, emb } of neuralRowsToUpdate) {
          const cid = val(row, 'id');
          const vecLiteral = `[${emb.vector.map((n) => Number(n)).join(',')}]`;
          await db.sequelize.query(
            'UPDATE "latticeParaChunks" SET embedding = CAST(:vec AS vector) WHERE id = :id AND "organizationId" = :org;',
            {
              replacements: { vec: vecLiteral, id: cid, org: organizationId },
              ...(transaction ? { transaction } : {}),
            },
          );
        }
      });
    } catch {
      // Plain Postgres without pgvector column or pre-migration fixed vector(1536): keep JSONB vector only
    }
  }

  const neuralChunks = prepared.filter((p) => p.emb.engine === 'neural').length;
  const fallbackChunks = prepared.length - neuralChunks;
  return {
    documentId,
    organizationId,
    chunksCreated: prepared.length,
    neuralChunks,
    fallbackChunks,
    embeddingEngine: neuralChunks > 0 && fallbackChunks === 0 ? 'neural' : 'deterministic-fallback',
  };
}

/**
 * Create NocoBase resource action handlers for `latticePara` (`summary`, `hybridSearch`, `reindex`, `extractAttachment`, `extractFormFields`).
 *
 * @param {object} db - NocoBase database instance.
 * @param {object} [options]
 * @param {Record<string, string|undefined>} [options.env=process.env] - Environment config for OCR/embedding services.
 * @param {Function} [options.fetchImpl=globalThis.fetch] - Fetch implementation for remote OCR/embeddings.
 * @returns {Record<string, Function>} Resource action map.
 */
function createParaActions(db, { env = process.env, fetchImpl = globalThis.fetch, getIndexingFailures = null } = {}) {
  return {
    summary: async (ctx, next) => {
      if (ctx.method !== 'GET') ctx.throw(405);
      const isRoot = ctx.state?.currentRole === 'root';
      let organizationId = null;
      let organizations = [];
      if (isRoot) {
        const requested = ctx.action?.params?.organizationId;
        if (typeof requested === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(requested.trim())) {
          organizationId = requested.trim();
        }
        const counts = new Map();
        const empRepo = db.getRepository('latticeEmployees');
        const deptRepo = db.getRepository('latticeDepartments');
        const { empRows, deptRows } = await runParaRlsOp(db, null, async (transaction) => {
          const txOpt = transaction ? { transaction } : {};
          const emps = empRepo ? await empRepo.find({ filter: { active: true }, fields: ['organizationId'], limit: 500, ...txOpt }) : [];
          const depts = deptRepo ? await deptRepo.find({ filter: { active: true }, fields: ['organizationId'], limit: 200, ...txOpt }) : [];
          return { empRows: emps, deptRows: depts };
        });
        for (const r of Array.isArray(empRows) ? empRows : []) {
          const oid = val(r, 'organizationId');
          if (oid) counts.set(oid, (counts.get(oid) || 0) + 1);
        }
        for (const r of Array.isArray(deptRows) ? deptRows : []) {
          const oid = val(r, 'organizationId');
          if (oid && !counts.has(oid)) counts.set(oid, 0);
        }
        organizations = [...counts.keys()].sort((a, b) => (counts.get(b) - counts.get(a)) || a.localeCompare(b));
      } else {
        const actor = await resolveParaActor(db, ctx.state?.currentUser);
        organizationId = actor.organizationId;
        organizations = [actor.organizationId];
      }

      const repo = db.getRepository('latticeParaDocuments');
      const filter = { active: true, ...(organizationId ? { organizationId } : {}) };
      const spaces = Object.fromEntries(PARA_SPACES.map((space) => [space, 0]));
      if (repo && typeof repo.count === 'function') {
        const counts = await runParaRlsOp(db, organizationId, (transaction) => Promise.all(
          PARA_SPACES.map((space) => repo.count({
            filter: { ...filter, paraSpace: space },
            ...(transaction ? { transaction } : {}),
          })),
        ));
        PARA_SPACES.forEach((space, idx) => {
          spaces[space] = Number(counts[idx]) || 0;
        });
      } else {
        const rows = repo
          ? await runParaRlsOp(db, organizationId, (transaction) => repo.find({
              filter,
              fields: ['id', 'paraSpace', 'active', 'organizationId'],
              ...(transaction ? { transaction } : {}),
            }))
          : [];
        for (const row of Array.isArray(rows) ? rows : []) {
          if (val(row, 'active') === false) continue;
          const space = val(row, 'paraSpace') || 'projects';
          if (Object.hasOwn(spaces, space)) spaces[space] += 1;
        }
      }
      const total = Object.values(spaces).reduce((acc, n) => acc + n, 0);
      ctx.body = { organizationId, organizations, spaces, total };
      await next();
    },

    hybridSearch: async (ctx, next) => {
      if (!['GET', 'POST'].includes(ctx.method || 'GET')) ctx.throw(405);
      const isRoot = ctx.state?.currentRole === 'root';
      const params = readParams(ctx);

      let organizationId = null;
      if (isRoot) {
        if (!val(ctx.state?.currentUser, 'id')) ctx.throw(401, 'Yêu cầu đăng nhập.');
        const reqOrg = params.organizationId;
        if (typeof reqOrg === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(reqOrg.trim())) {
          organizationId = reqOrg.trim();
        }
      } else {
        const actor = await resolveParaActor(db, ctx.state?.currentUser);
        organizationId = actor.organizationId;
      }

      const rawSpace = params.paraSpace ? String(params.paraSpace).trim() : null;
      if (rawSpace && !PARA_SPACES.includes(rawSpace)) {
        ctx.throw(400, 'Phân vùng P.A.R.A. không hợp lệ.');
      }
      const query = String(params.query || '').trim().slice(0, 200);
      const limit = Math.max(1, Math.min(30, Number(params.limit) || 10));

      const items = await executeHybridSearch(db, {
        organizationId,
        query,
        paraSpace: rawSpace,
        limit,
        env,
        fetchImpl,
      });
      const embeddingEngine = items.some((it) => it.embeddingEngine === 'neural') ? 'neural' : 'deterministic-fallback';
      ctx.body = {
        organizationId,
        engine: 'hybrid-rrf',
        embeddingEngine,
        query,
        paraSpace: rawSpace,
        count: items.length,
        items,
      };
      if (typeof next === 'function') await next();
    },

    reindex: async (ctx, next) => {
      if (ctx.method !== 'POST') ctx.throw(405);
      const userId = val(ctx.state?.currentUser, 'id');
      if (userId == null || !/^[1-9]\d*$/.test(String(userId))) {
        throw failAction('NATIVE_LOGIN_REQUIRED', 401, 'Yêu cầu đăng nhập.');
      }

      const roles = await resolveCallerRoles(ctx, db);
      if (!roles.some((r) => REINDEX_ROLES.has(r))) {
        throw failAction('PARA_REINDEX_FORBIDDEN', 403, 'Chỉ quản trị viên, giám đốc hoặc quản lý mới được lập chỉ mục lại kho tri thức.');
      }

      const params = readParams(ctx);
      const isRoot = roles.includes('root');
      let organizationId = null;
      if (isRoot) {
        if (typeof params.organizationId === 'string' && params.organizationId.trim()) {
          if (!/^[a-zA-Z0-9_-]{1,80}$/.test(params.organizationId.trim())) {
            throw failAction('INVALID_ORGANIZATION_ID', 400, 'Mã tổ chức không hợp lệ.');
          }
          organizationId = params.organizationId.trim();
        }
      } else {
        const actor = await resolveParaActor(db, ctx.state?.currentUser);
        if (params.organizationId != null && String(params.organizationId).trim() !== actor.organizationId) {
          throw failAction('NATIVE_ORGANIZATION_MISMATCH', 403, 'Không được phép lập chỉ mục dữ liệu của tổ chức khác.');
        }
        organizationId = actor.organizationId;
      }

      const docRepo = db?.getRepository?.('latticeParaDocuments');
      if (!docRepo) {
        ctx.body = { organizationId, documentsProcessed: 0, chunksIndexed: 0, neuralChunks: 0, fallbackChunks: 0 };
        if (typeof next === 'function') await next();
        return;
      }

      let docs = [];
      if (params.documentId != null) {
        const docIdStr = String(params.documentId).trim();
        if (!/^[1-9]\d*$/.test(docIdStr)) {
          throw failAction('PARA_DOCUMENT_ID_INVALID', 400, 'Mã documentId không hợp lệ.');
        }
        const found = await findScopedParaDocument(db, docIdStr, organizationId);
        if (!found) throw failAction('PARA_DOCUMENT_NOT_FOUND', 404, 'Không tìm thấy tài liệu P.A.R.A.');
        docs = [found];
      } else {
        docs = (await runParaRlsOp(db, organizationId, (transaction) => docRepo.find({
          filter: { active: true, ...(organizationId ? { organizationId } : {}) },
          limit: 500,
          sort: ['id'],
          ...(transaction ? { transaction } : {}),
        }))) || [];
      }

      let chunksIndexed = 0;
      let neuralChunks = 0;
      let fallbackChunks = 0;
      for (const doc of docs) {
        const res = await syncDocumentChunks(db, doc, { env, fetchImpl });
        chunksIndexed += res.chunksCreated;
        neuralChunks += res.neuralChunks;
        fallbackChunks += res.fallbackChunks;
      }

      ctx.body = {
        organizationId,
        documentsProcessed: docs.length,
        chunksIndexed,
        neuralChunks,
        fallbackChunks,
      };
      if (typeof next === 'function') await next();
    },

    extractAttachment: async (ctx, next) => {
      if (ctx.method !== 'POST') ctx.throw(405);
      const userId = val(ctx.state?.currentUser, 'id');
      if (userId == null || !/^[1-9]\d*$/.test(String(userId))) {
        throw failAction('NATIVE_LOGIN_REQUIRED', 401, 'Yêu cầu đăng nhập.');
      }

      const roles = await resolveCallerRoles(ctx, db);
      const isRoot = roles.includes('root');
      let actor = null;
      if (!isRoot) {
        actor = await resolveParaActor(db, ctx.state?.currentUser);
      }

      const params = readParams(ctx);
      const rawDocId = params.documentId;
      if (rawDocId == null || !/^[1-9]\d*$/.test(String(rawDocId).trim())) {
        throw failAction('PARA_DOCUMENT_ID_REQUIRED', 400, 'Cần cung cấp documentId hợp lệ.');
      }
      const documentId = Number(String(rawDocId).trim());

      const buffer = decodeBase64Payload(params.contentBase64, { maxBytes: MAX_UPLOAD_BYTES });
      const doc = await findScopedParaDocument(db, documentId, actor ? actor.organizationId : null);
      if (!doc) {
        throw failAction('PARA_DOCUMENT_NOT_FOUND', 404, 'Không tìm thấy tài liệu P.A.R.A. trong phạm vi tổ chức của bạn.');
      }

      const isManager = roles.some((r) => EDIT_MANAGER_ROLES.has(r));
      if (!isManager) {
        if (roles.includes('ldx_director')) {
          throw failAction('PARA_EDIT_FORBIDDEN', 403, 'Vai trò Giám đốc chỉ có quyền xem tài liệu P.A.R.A.');
        }
        const ownerId = val(doc, 'ownerId');
        if (!actor || ownerId == null || Number(ownerId) !== Number(actor.employeeId)) {
          throw failAction('PARA_OWNER_REQUIRED', 403, 'Chỉ chủ sở hữu tài liệu hoặc quản lý mới được trích xuất tệp đính kèm.');
        }
      }

      const filename = safeBasename(params.filename);
      const mimeType = String(params.mimeType || '').trim().slice(0, 120);
      const extracted = extractTextFromBuffer(buffer, { filename, mimeType });
      if (!extracted.text || !extracted.text.trim()) {
        if (extracted.hasImageStreams) {
          throw failAction(
            'PDF_SCANNED_OCR_REQUIRED',
            400,
            'Tệp PDF chỉ chứa hình ảnh scan và chưa có lớp văn bản. Vui lòng bật Remote OCR (DX_OCR_ENDPOINT) hoặc dùng tính năng OCR biểu mẫu.',
          );
        }
        if (extracted.hasObjStm) {
          throw failAction(
            'PDF_OBJSTM_NO_TEXT',
            400,
            'Tệp PDF sử dụng nén Object Stream (/ObjStm) và chưa trích xuất được văn bản.',
          );
        }
        throw failAction('ATTACHMENT_NO_TEXT', 400, 'Không trích xuất được nội dung văn bản từ tệp đính kèm.');
      }

      const safePreview = buildSafeTextPreview(extracted.text, 300);
      const syncResult = await syncDocumentChunks(db, doc, {
        attachmentText: extracted.text,
        attachmentFilename: filename,
        env,
        fetchImpl,
      });
      if (!val(doc, 'summary') && typeof doc?.update === 'function') {
        try {
          await runParaRlsOp(db, val(doc, 'organizationId'), (transaction) => doc.update(
            { summary: safePreview },
            { context: { skipParaChunkSync: true }, ...(transaction ? { transaction } : {}) },
          ));
        } catch {
          // Best-effort summary update
        }
      }

      ctx.body = {
        organizationId: val(doc, 'organizationId'),
        documentId: val(doc, 'id'),
        filename,
        format: extracted.format,
        pageCount: extracted.pageCount,
        extractedChars: extracted.text.length,
        preview: safePreview,
        chunksIndexed: syncResult.chunksCreated,
        embeddingEngine: syncResult.embeddingEngine,
      };
      if (typeof next === 'function') await next();
    },

    extractFormFields: async (ctx, next) => {
      if (ctx.method !== 'POST') ctx.throw(405);
      const userId = val(ctx.state?.currentUser, 'id');
      if (userId == null || !/^[1-9]\d*$/.test(String(userId))) {
        throw failAction('NATIVE_LOGIN_REQUIRED', 401, 'Yêu cầu đăng nhập.');
      }

      const roles = await resolveCallerRoles(ctx, db);
      const isRoot = roles.includes('root');
      let actor = null;
      if (!isRoot) {
        actor = await resolveParaActor(db, ctx.state?.currentUser);
      }

      const params = readParams(ctx);
      if (
        !isRoot
        && params.organizationId != null
        && String(params.organizationId).trim()
        && String(params.organizationId).trim() !== actor.organizationId
      ) {
        throw failAction('NATIVE_ORGANIZATION_MISMATCH', 403, 'Không được phép trích xuất biểu mẫu cho tổ chức khác.');
      }

      const targetCollection = String(params.targetCollection || 'latticeOrders').trim();
      if (!ALLOWED_FORM_COLLECTIONS.has(targetCollection)) {
        throw failAction('INVALID_TARGET_COLLECTION', 400, 'Bảng đích auto-fill không hợp lệ.');
      }

      const hasDocumentId = params.documentId != null && String(params.documentId).trim() !== '';
      const permitted = await hasFormExtractionAcl(db, ctx, roles, targetCollection, { hasDocumentId });
      if (!permitted) {
        throw failAction('PARA_ACL_FORBIDDEN', 403, 'Không có quyền xem tài liệu P.A.R.A. hoặc bảng đích để trích xuất biểu mẫu.');
      }

      let doc = null;
      if (hasDocumentId) {
        const docIdStr = String(params.documentId).trim();
        if (!/^[1-9]\d*$/.test(docIdStr)) {
          throw failAction('PARA_DOCUMENT_ID_INVALID', 400, 'Mã documentId không hợp lệ.');
        }
        doc = await findScopedParaDocument(db, docIdStr, actor ? actor.organizationId : null);
        if (!doc) {
          throw failAction('PARA_DOCUMENT_NOT_FOUND', 404, 'Không tìm thấy tài liệu P.A.R.A. trong phạm vi tổ chức của bạn.');
        }
      }

      const hasBase64 = typeof params.contentBase64 === 'string' && params.contentBase64.trim().length > 0;
      if (!hasBase64 && !doc) {
        throw failAction('FORM_EXTRACT_INPUT_REQUIRED', 400, 'Cần cung cấp contentBase64 hoặc documentId hợp lệ.');
      }

      const filename = safeBasename(params.filename || val(doc, 'code') || '');
      const mimeType = String(params.mimeType || '').trim().slice(0, 120);

      let extractionResult;
      if (hasBase64) {
        const buffer = decodeBase64Payload(params.contentBase64, { maxBytes: MAX_UPLOAD_BYTES });
        extractionResult = await extractWithMultimodalOcr({
          buffer,
          filename,
          mimeType,
          targetCollection,
          env,
          fetchImpl,
        });
      } else {
        const docOrg = val(doc, 'organizationId');
        const docId = val(doc, 'id');
        const textParts = [
          val(doc, 'title'),
          val(doc, 'summary'),
          val(doc, 'contentMarkdown'),
          val(doc, 'attachmentText'),
        ].filter(Boolean);

        const chunkRepo = db?.getRepository?.('latticeParaChunks');
        if (chunkRepo && typeof chunkRepo.find === 'function') {
          const attRows = (await runParaRlsOp(db, docOrg, (transaction) => chunkRepo.find({
            filter: { documentId: docId, organizationId: docOrg, sourceType: 'attachment', active: true },
            limit: 500,
            sort: ['chunkIndex'],
            ...(transaction ? { transaction } : {}),
          }))) || [];
          for (const row of attRows) {
            if (val(row, 'organizationId') === docOrg && Number(val(row, 'documentId')) === Number(docId)) {
              const content = String(val(row, 'content') || '').trim();
              if (content) textParts.push(content);
            }
          }
        }

        const docText = textParts.join('\n\n').trim();
        const structured = extractStructuredFormFields(docText, { targetCollection });
        extractionResult = {
          text: docText,
          format: 'para-document',
          pageCount: 1,
          ocrEngine: 'offline-deterministic-fallback',
          targetCollection: structured.targetCollection,
          fields: structured.fields,
          lineItems: structured.lineItems,
          confidence: structured.confidence,
          warnings: structured.warnings,
        };
      }

      ctx.body = {
        organizationId: val(doc, 'organizationId') || actor?.organizationId || null,
        documentId: doc ? val(doc, 'id') : null,
        filename,
        format: extractionResult.format,
        pageCount: extractionResult.pageCount,
        ocrEngine: extractionResult.ocrEngine,
        targetCollection,
        extractedTextPreview: buildSafeTextPreview(extractionResult.text, 500),
        suggestedValues: extractionResult.fields,
        lineItems: extractionResult.lineItems,
        confidence: extractionResult.confidence,
        warnings: extractionResult.warnings,
      };
      if (typeof next === 'function') await next();
    },

    indexHealth: async (ctx, next) => {
      if (ctx.method !== 'GET') ctx.throw(405);
      const userId = val(ctx.state?.currentUser, 'id');
      if (userId == null || !/^[1-9]\d*$/.test(String(userId))) {
        throw failAction('NATIVE_LOGIN_REQUIRED', 401, 'Yêu cầu đăng nhập.');
      }

      const roles = await resolveCallerRoles(ctx, db);
      const isRoot = roles.includes('root');
      let organizationId = null;
      if (isRoot) {
        const requested = ctx.action?.params?.organizationId;
        if (typeof requested === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(requested.trim())) {
          organizationId = requested.trim();
        }
      } else {
        const actor = await resolveParaActor(db, ctx.state?.currentUser);
        organizationId = actor.organizationId;
      }

      const docRepo = db?.getRepository?.('latticeParaDocuments');
      const chunkRepo = db?.getRepository?.('latticeParaChunks');
      const docFilter = { active: true, ...(organizationId ? { organizationId } : {}) };
      const chunkFilter = { active: true, ...(organizationId ? { organizationId } : {}) };

      const { documentsCount, rawChunks, pgvectorAvailable } = await runParaRlsOp(db, organizationId, async (transaction) => {
        const txOpt = transaction ? { transaction } : {};
        let docsCnt = 0;
        if (docRepo && typeof docRepo.count === 'function') {
          docsCnt = Number(await docRepo.count({ filter: docFilter, ...txOpt })) || 0;
        } else if (docRepo && typeof docRepo.find === 'function') {
          const rows = (await docRepo.find({ filter: docFilter, fields: ['id', 'organizationId', 'active'], limit: 1000, ...txOpt })) || [];
          docsCnt = rows.filter((r) => val(r, 'active') !== false && (!organizationId || val(r, 'organizationId') === organizationId)).length;
        }

        const chunks = chunkRepo && typeof chunkRepo.find === 'function'
          ? ((await chunkRepo.find({
              filter: chunkFilter,
              fields: ['id', 'organizationId', 'embeddingEngine', 'embeddingDim', 'active'],
              limit: 5000,
              ...txOpt,
            })) || [])
          : [];

        let hasPgvector = false;
        if (typeof db?.sequelize?.query === 'function') {
          try {
            const [extRows] = await runParaSavepoint(db, (spTx) => db.sequelize.query(
              "SELECT 1 AS present FROM pg_extension WHERE extname = 'vector' LIMIT 1;",
              (spTx || transaction) ? { transaction: spTx || transaction } : undefined,
            ));
            hasPgvector = Array.isArray(extRows) && extRows.length > 0;
          } catch {
            hasPgvector = false;
          }
        }

        return { documentsCount: docsCnt, rawChunks: chunks, pgvectorAvailable: hasPgvector };
      });
      const activeChunks = rawChunks.filter(
        (c) => val(c, 'active') !== false && (!organizationId || val(c, 'organizationId') === organizationId),
      );
      let neuralChunks = 0;
      const dimSet = new Set();
      for (const chunk of activeChunks) {
        if (val(chunk, 'embeddingEngine') === 'neural') neuralChunks += 1;
        const dim = Number(val(chunk, 'embeddingDim'));
        if (Number.isInteger(dim) && dim > 0) dimSet.add(dim);
      }

      const allFailures = typeof getIndexingFailures === 'function' ? (getIndexingFailures() || []) : [];
      const recentFailures = allFailures
        .filter((f) => !organizationId || f.organizationId === organizationId)
        .slice(-20)
        .reverse();

      ctx.body = {
        organizationId,
        documentsCount,
        chunksCount: activeChunks.length,
        neuralChunks,
        fallbackChunks: activeChunks.length - neuralChunks,
        targetEmbeddingDim: resolveEmbeddingDim(env),
        embeddingDims: [...dimSet].sort((a, b) => a - b),
        pgvectorAvailable,
        embeddingConfigured: Boolean(resolveEmbeddingEndpoint(env)),
        ocrConfigured: Boolean(String(env?.DX_OCR_ENDPOINT || '').trim()),
        pendingRetries: recentFailures.filter((f) => f.retryable && !f.resolved).length,
        recentFailures,
      };
      if (typeof next === 'function') await next();
    },
  };
}

module.exports = {
  createParaActions,
  syncDocumentChunks,
  buildSafeTextPreview,
  decodeBase64Payload,
  resolveCallerRoles,
  hasFormExtractionAcl,
};
