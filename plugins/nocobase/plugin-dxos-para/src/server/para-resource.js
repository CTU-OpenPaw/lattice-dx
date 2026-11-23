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
const { resolveParaActor } = require('./para-scope');
const { executeHybridSearch, computeNeuralEmbedding } = require('./para-hybrid-search');
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

function buildSafeTextPreview(text, maxLen = 500) {
  return String(text || '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\b/g, '[REDACTED_JWT]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, '$1[REDACTED]')
    .replace(/([a-zA-Z0-9_]*(?:token|secret|password|apikey|api_key)\s*[:=]\s*)(?:"[^"]+"|'[^']+'|[^\s,;}"']+)/gi, '$1[REDACTED]')
    .trim()
    .slice(0, maxLen);
}

async function hasFormExtractionAcl(db, ctx, roles, targetCollection) {
  if (roles.includes('root')) return true;
  if (!roles.length) return false;

  const collectionsToCheck = ['latticeParaDocuments', targetCollection];
  const viewActions = ['view', 'list', 'create'];
  if (typeof ctx?.can === 'function') {
    return collectionsToCheck.some((col) => (
      ['view', 'list'].some((act) => Boolean(ctx.can({ resource: col, action: act })))
    ));
  }

  const rolesRepo = db?.getRepository?.('roles');
  const resRepo = db?.getRepository?.('dataSourcesRolesResources');
  if (!rolesRepo && !resRepo) {
    return roles.some((r) => RECOGNIZED_PARA_ROLES.has(r));
  }

  for (const roleName of roles) {
    const role = rolesRepo?.findOne ? await rolesRepo.findOne({ filter: { name: roleName } }) : null;
    if (val(role, 'allowAll') === true || val(role, 'allowConfigure') === true) return true;
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
    if (Array.isArray(strategyActions) && strategyActions.some((a) => ['view', 'list', '*:*', '*'].includes(a))) {
      return true;
    }
  }
  return false;
}

async function resolveCallerRoles(ctx, db) {
  const stateRole = String(ctx?.state?.currentRole || '').trim();
  const stateRoles = Array.isArray(ctx?.state?.currentRoles)
    ? [...new Set(ctx.state.currentRoles.map((r) => String(r || '').trim()).filter(Boolean))]
    : [];
  const userId = val(ctx?.state?.currentUser, 'id');
  let dbRoles = [];
  if (userId != null && typeof db?.getRepository === 'function') {
    const rolesUsersRepo = db.getRepository('rolesUsers');
    if (rolesUsersRepo && typeof rolesUsersRepo.find === 'function') {
      const rows = (await rolesUsersRepo.find({ filter: { userId } })) || [];
      dbRoles = [...new Set(rows.map((r) => String(val(r, 'roleName') || '').trim()).filter(Boolean))];
    }
  }
  const knownRoles = stateRoles.length ? stateRoles : dbRoles;
  if (stateRole) {
    if (!knownRoles.length || knownRoles.includes(stateRole)) return [stateRole];
    return knownRoles;
  }
  return knownRoles;
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

  const active = val(docRow, 'active') !== false;
  if (!active) {
    await withOptionalTransaction(db, async (transaction) => {
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
    const existingRows = (await chunkRepo.find({
      filter: { documentId, organizationId, sourceType: 'attachment', active: true },
      limit: 500,
      sort: ['chunkIndex'],
    })) || [];
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

  const prepared = [];
  for (const chunk of chunks) {
    const embInput = [code, title, chunk.sectionTitle, tags, chunk.content].filter(Boolean).join('\n');
    const emb = await computeNeuralEmbedding(embInput, { env, fetchImpl });
    prepared.push({ chunk, emb });
  }

  const createdRows = [];
  await withOptionalTransaction(db, async (transaction) => {
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

  // Update pgvector column outside the main transaction so plain Postgres never aborts chunk creation
  if (typeof db?.sequelize?.query === 'function') {
    for (const { row, emb } of createdRows) {
      const cid = val(row, 'id');
      if (cid == null || emb.engine !== 'neural' || emb.dim !== 1536) continue;
      if (!Array.isArray(emb.vector) || !emb.vector.every(Number.isFinite)) continue;
      try {
        const vecLiteral = `[${emb.vector.map((n) => Number(n)).join(',')}]`;
        await db.sequelize.query(
          'UPDATE "latticeParaChunks" SET embedding = CAST(:vec AS vector) WHERE id = :id AND "organizationId" = :org;',
          { replacements: { vec: vecLiteral, id: cid, org: organizationId } },
        );
      } catch {
        // Plain Postgres without pgvector column: keep JSONB vector only
      }
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

function createParaActions(db, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
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
        const empRows = empRepo ? await empRepo.find({ filter: { active: true }, fields: ['organizationId'], limit: 500 }) : [];
        for (const r of Array.isArray(empRows) ? empRows : []) {
          const oid = val(r, 'organizationId');
          if (oid) counts.set(oid, (counts.get(oid) || 0) + 1);
        }
        const deptRepo = db.getRepository('latticeDepartments');
        const deptRows = deptRepo ? await deptRepo.find({ filter: { active: true }, fields: ['organizationId'], limit: 200 }) : [];
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
        const counts = await Promise.all(
          PARA_SPACES.map((space) => repo.count({ filter: { ...filter, paraSpace: space } })),
        );
        PARA_SPACES.forEach((space, idx) => {
          spaces[space] = Number(counts[idx]) || 0;
        });
      } else {
        const rows = repo ? await repo.find({ filter, fields: ['id', 'paraSpace', 'active', 'organizationId'] }) : [];
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
        const docFilter = { id: Number(docIdStr), ...(organizationId ? { organizationId } : {}) };
        const found = typeof docRepo.findOne === 'function'
          ? await docRepo.findOne({ filter: docFilter })
          : ((await docRepo.find({ filter: docFilter, limit: 1 })) || [])[0];
        if (!found) throw failAction('PARA_DOCUMENT_NOT_FOUND', 404, 'Không tìm thấy tài liệu P.A.R.A.');
        docs = [found];
      } else {
        docs = (await docRepo.find({
          filter: { active: true, ...(organizationId ? { organizationId } : {}) },
          limit: 500,
          sort: ['id'],
        })) || [];
      }

      let chunksIndexed = 0;
      let neuralChunks = 0;
      let fallbackChunks = 0;
      for (const doc of docs) {
        const res = await syncDocumentChunks(db, doc);
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

      const rawBase64Input = params.contentBase64;
      if (typeof rawBase64Input !== 'string' || !rawBase64Input.trim()) {
        throw failAction('ATTACHMENT_CONTENT_REQUIRED', 400, 'Cần cung cấp nội dung contentBase64.');
      }
      if (rawBase64Input.length > MAX_UPLOAD_BYTES) {
        throw failAction('ATTACHMENT_TOO_LARGE', 400, 'Kích thước tệp đính kèm base64 vượt quá giới hạn 2MB.');
      }
      const strippedPrefix = rawBase64Input.trim().replace(/^data:[a-z0-9/+.-]+;base64,/i, '');
      const cleanBase64 = strippedPrefix.replace(/\s+/g, '');
      if (!cleanBase64 || !/^[A-Za-z0-9+/=]+$/.test(cleanBase64)) {
        throw failAction('ATTACHMENT_BASE64_INVALID', 400, 'Dữ liệu contentBase64 không hợp lệ.');
      }
      const buffer = Buffer.from(cleanBase64, 'base64');
      if (buffer.length === 0 || buffer.length > MAX_UPLOAD_BYTES) {
        throw failAction('ATTACHMENT_TOO_LARGE', 400, 'Kích thước tệp đính kèm vượt quá giới hạn 2MB.');
      }

      const docRepo = db?.getRepository?.('latticeParaDocuments');
      const docFilter = { id: documentId, ...(actor ? { organizationId: actor.organizationId } : {}) };
      const doc = docRepo
        ? (typeof docRepo.findOne === 'function'
          ? await docRepo.findOne({ filter: docFilter })
          : ((await docRepo.find({ filter: docFilter, limit: 1 })) || [])[0])
        : null;
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

      const filename = path.basename(String(params.filename || '').trim()).slice(0, 255);
      const mimeType = String(params.mimeType || '').trim().slice(0, 120);
      const extracted = extractTextFromBuffer(buffer, { filename, mimeType });
      if (!extracted.text || !extracted.text.trim()) {
        throw failAction('ATTACHMENT_NO_TEXT', 400, 'Không trích xuất được nội dung văn bản từ tệp đính kèm.');
      }

      const syncResult = await syncDocumentChunks(db, doc, { attachmentText: extracted.text, attachmentFilename: filename });
      if (!val(doc, 'summary') && typeof doc?.update === 'function') {
        try {
          await doc.update({ summary: extracted.text.slice(0, 300) }, { context: { skipParaChunkSync: true } });
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
        preview: extracted.text.slice(0, 300),
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

      const permitted = await hasFormExtractionAcl(db, ctx, roles, targetCollection);
      if (!permitted) {
        throw failAction('PARA_ACL_FORBIDDEN', 403, 'Không có quyền xem tài liệu P.A.R.A. hoặc bảng đích để trích xuất biểu mẫu.');
      }

      let doc = null;
      if (params.documentId != null && String(params.documentId).trim() !== '') {
        const docIdStr = String(params.documentId).trim();
        if (!/^[1-9]\d*$/.test(docIdStr)) {
          throw failAction('PARA_DOCUMENT_ID_INVALID', 400, 'Mã documentId không hợp lệ.');
        }
        const docRepo = db?.getRepository?.('latticeParaDocuments');
        const docFilter = { id: Number(docIdStr), ...(actor ? { organizationId: actor.organizationId } : {}) };
        doc = docRepo
          ? (typeof docRepo.findOne === 'function'
            ? await docRepo.findOne({ filter: docFilter })
            : ((await docRepo.find({ filter: docFilter, limit: 1 })) || [])[0])
          : null;
        if (!doc || (actor && val(doc, 'organizationId') !== actor.organizationId)) {
          throw failAction('PARA_DOCUMENT_NOT_FOUND', 404, 'Không tìm thấy tài liệu P.A.R.A. trong phạm vi tổ chức của bạn.');
        }
      }

      const hasBase64 = typeof params.contentBase64 === 'string' && params.contentBase64.trim().length > 0;
      if (!hasBase64 && !doc) {
        throw failAction('FORM_EXTRACT_INPUT_REQUIRED', 400, 'Cần cung cấp contentBase64 hoặc documentId hợp lệ.');
      }

      const filename = path.basename(String(params.filename || val(doc, 'code') || '').trim()).slice(0, 255);
      const mimeType = String(params.mimeType || '').trim().slice(0, 120);

      let extractionResult;
      if (hasBase64) {
        const rawBase64Input = params.contentBase64;
        if (rawBase64Input.length > MAX_UPLOAD_BYTES) {
          throw failAction('ATTACHMENT_TOO_LARGE', 400, 'Kích thước tệp đính kèm base64 vượt quá giới hạn 2MB.');
        }
        const strippedPrefix = rawBase64Input
          .trim()
          .replace(/^data:[a-z0-9/+.-]+(?:;[a-z0-9=_-]+)*;base64,/i, '');
        const cleanBase64 = strippedPrefix.replace(/\s+/g, '');
        if (!cleanBase64 || !/^[A-Za-z0-9+/=]+$/.test(cleanBase64)) {
          throw failAction('ATTACHMENT_BASE64_INVALID', 400, 'Dữ liệu contentBase64 không hợp lệ.');
        }
        const buffer = Buffer.from(cleanBase64, 'base64');
        if (buffer.length === 0 || buffer.length > MAX_UPLOAD_BYTES) {
          throw failAction('ATTACHMENT_TOO_LARGE', 400, 'Kích thước tệp đính kèm vượt quá giới hạn 2MB.');
        }

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
          const attRows = (await chunkRepo.find({
            filter: { documentId: docId, organizationId: docOrg, sourceType: 'attachment', active: true },
            limit: 100,
            sort: ['chunkIndex'],
          })) || [];
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
  };
}

module.exports = { createParaActions, syncDocumentChunks };
