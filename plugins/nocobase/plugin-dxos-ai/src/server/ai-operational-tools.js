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
const {
  computeEmbedding,
  executePgVectorParaQuery,
  rankHybridRecords,
  buildParaChunkPoolEntries,
} = require('./ai-hybrid-search');
const {
  resolveEffectiveToolMode,
  buildDiffPreview,
  computeRiskLevel,
  enqueueAiApproval,
} = require('./ai-hitl');
const { redactPiiText: defaultRedactPiiText } = require('./ai-governance');
const { runInRlsSavepoint } = require('./ai-rls');
const { recallMemories, buildMemoryContextPrompt } = require('./ai-memory');

const DEFAULT_SYSTEM_PROTECTED = new Set([
  'users', 'roles', 'rolesUsers', 'apiKeys', 'authenticators', 'migrations',
  'applicationPlugins', 'aiSettings', 'aiEmployees', 'aiMcpClients',
  'rolesAiEmployees', 'latticeAiAuditLogs', 'latticeAiProfiles', 'latticeAiQuotaUsage', 'latticeAiQuotaPolicies', 'latticeAiApprovalQueue', 'latticeUiSnapshots',
  'latticeBuiltApps', 'latticeAiMemory', 'latticeAiTraces', 'latticeAutomationRuleVersions',
  'latticeA2aTasks', 'latticeApprovalPolicies', 'latticeApprovalRequests', 'latticeNotificationDeliveries', 'latticePublicForms',
]);

const MAX_GRAPH_DEPTH = 4;
const MAX_GRAPH_NODES = 60;
const GRAPH_COLLECTIONS = [
  'latticeAssets',
  'latticeIncidentCases',
  'latticeTwinShadows',
  'latticeStockLots',
  'latticeOrderLines',
  'latticeOrders',
  'latticeEpodRecords',
  'latticeParaDocuments',
  'latticeServiceTickets',
  'latticeRequests',
];
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]{0,80}$/;
const FORBIDDEN_COLLECTION_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
const POSITIVE_INT_RE = /^[1-9]\d*$/;
const ASSET_URN_RE = /^urn:ngsi-ld:Asset:([a-zA-Z0-9_-]{1,80}):native:([1-9]\d*)$/;
const SENSITIVE_KEY_RE = /token|secret|password|apikey|api_key|authorization|cookie|credential|jwt|bearer|privatekey|private_key|sessionid|session_id|passphrase|access_key|client_secret/i;
const COLLECTION_CODE_FIELDS = {
  latticeAssets: ['code'],
  latticeIncidentCases: ['code', 'assetEntityId'],
  latticeTwinShadows: ['assetEntityId'],
  latticeStockLots: ['lotCode', 'assetEntityId'],
  latticeOrderLines: ['orderCode', 'lotCode'],
  latticeOrders: ['code'],
  latticeEpodRecords: ['epodUid', 'trackingCode', 'orderCode'],
  latticeParaDocuments: ['code'],
  latticeServiceTickets: ['code'],
  latticeRequests: ['code'],
};

function loadSiblingModule(candidates) {
  for (const modPath of candidates) {
    try {
      return require(modPath);
    } catch (err) {
      const isDirectMissing = err?.code === 'MODULE_NOT_FOUND'
        && (!Array.isArray(err.requireStack) || err.requireStack.length === 0 || err.requireStack[0] === __filename);
      if (!isDirectMissing) throw err;
    }
  }
  return null;
}

function loadParaHybridSearch() {
  const inDist = __dirname.includes(`${path.sep}dist${path.sep}`);
  const candidates = inDist
    ? [
        '@latticedx/plugin-dxos-para/dist/server/para-hybrid-search',
        '@latticedx/plugin-dxos-para/src/server/para-hybrid-search',
        '../../../plugin-dxos-para/dist/server/para-hybrid-search',
        '../../../plugin-dxos-para/src/server/para-hybrid-search',
      ]
    : [
        '@latticedx/plugin-dxos-para/src/server/para-hybrid-search',
        '../../../plugin-dxos-para/src/server/para-hybrid-search',
        '../../../plugin-dxos-para/dist/server/para-hybrid-search',
      ];
  return loadSiblingModule(candidates);
}

async function resolveSearchableTargets(db, requestedCollections, SEARCHABLE_COLLECTIONS, CUSTOM_COLLECTION_RE, val) {
  const dynamicCustom = [];
  const colsRepo = db?.getRepository?.('collections');
  if (colsRepo) {
    const rows = (await colsRepo.find({ limit: 200 })) || [];
    for (const r of rows) {
      const name = val(r, 'name');
      if (CUSTOM_COLLECTION_RE.test(name) && !dynamicCustom.includes(name)) dynamicCustom.push(name);
    }
  }
  const allAllowed = [...new Set([...SEARCHABLE_COLLECTIONS, ...dynamicCustom])];
  if (Array.isArray(requestedCollections) && requestedCollections.length) {
    return requestedCollections.filter((c) => allAllowed.includes(c));
  }
  return allAllowed;
}

async function enforceCallerRbacOnWrite(db, actor, collection, operation, safeValues, { failTool, val, WRITABLE_BUSINESS_COLLECTIONS, CUSTOM_COLLECTION_RE }) {
  const isCustom = CUSTOM_COLLECTION_RE.test(collection);
  if (!WRITABLE_BUSINESS_COLLECTIONS.has(collection) && !isCustom) {
    throw failTool('COLLECTION_WRITE_FORBIDDEN', 403, `Không được phép ghi vào collection "${collection}".`);
  }
  if (actor.isAdmin) return { matchedActions: [] };

  const resourcesRepo = db?.getRepository?.('dataSourcesRolesResources');
  if (!resourcesRepo) {
    throw failTool('RBAC_POLICY_MISSING', 403, `Chưa có kho cấu hình phân quyền RBAC để kiểm tra ghi vào "${collection}".`);
  }

  const colPolicies = (await resourcesRepo.find({ filter: { name: collection, dataSourceKey: 'main' }, appends: ['actions'], limit: 50 })) || [];
  const roleSet = new Set(actor.roleNames || []);
  const callerPolicies = colPolicies.filter((p) => roleSet.has(val(p, 'roleName')));
  if (!callerPolicies.length) {
    throw failTool('RBAC_ACTION_DENIED', 403, `Vai trò hiện tại không có quyền thao tác trên "${collection}".`);
  }

  let hasActionGrant = false;
  const matchedActions = [];
  const allowedFields = new Set();
  let unrestrictedFields = false;
  for (const policy of callerPolicies) {
    const actions = val(policy, 'actions') || [];
    const matched = actions.find((a) => val(a, 'name') === operation);
    if (!matched) continue;
    hasActionGrant = true;
    matchedActions.push(matched);
    const fields = val(matched, 'fields');
    if (Array.isArray(fields) && fields.length) {
      for (const f of fields) allowedFields.add(f);
    } else {
      unrestrictedFields = true;
    }
  }
  if (!hasActionGrant) {
    throw failTool('RBAC_ACTION_DENIED', 403, `Vai trò hiện tại không có quyền "${operation}" trên "${collection}".`);
  }
  if (!unrestrictedFields) {
    const locked = Object.keys(safeValues).filter((k) => !allowedFields.has(k));
    if (locked.length) {
      throw failTool('RBAC_FIELD_LOCKED', 403, `Trường bị khóa theo phân quyền RBAC trên "${collection}": ${locked.join(', ')}.`);
    }
  }
  return { matchedActions };
}

async function preflightScopedRecordWrite(db, actor, collection, operation, { recordId, values }, deps) {
  const { failTool, val, PROTECTED_SERVER_FIELDS, CUSTOM_COLLECTION_RE } = deps;
  const repo = db?.getRepository?.(collection);
  if (!repo) throw failTool('COLLECTION_NOT_FOUND', 404, `Collection "${collection}" chưa sẵn sàng.`);

  const safeValues = {};
  for (const [k, v] of Object.entries(values || {})) {
    if (!PROTECTED_SERVER_FIELDS.has(k)) safeValues[k] = v;
  }
  await enforceCallerRbacOnWrite(db, actor, collection, operation, safeValues, deps);

  if (operation === 'create') {
    if (!actor.isAdmin && !actor.employeeId) {
      throw failTool('EMPLOYEE_BINDING_REQUIRED', 403, 'Cần hồ sơ latticeEmployees để tạo bản ghi nghiệp vụ.');
    }
    return { repo, safeValues, existing: null };
  }

  if (recordId == null) throw failTool('RECORD_ID_REQUIRED', 400, 'Cần recordId để cập nhật.');
  const existing = await repo.findOne({ filterByTk: recordId });
  if (!existing || val(existing, 'organizationId') !== actor.organizationId) {
    throw failTool('RECORD_NOT_FOUND_OR_FORBIDDEN', 403, 'Không tìm thấy bản ghi trong phạm vi tổ chức của bạn.');
  }
  if (!actor.isAdmin) {
    const isManagerOrAdmin = (actor.roleNames || []).some((r) => r === 'ldx_admin' || r === 'ldx_director' || r === 'ldx_manager');
    if (!isManagerOrAdmin) {
      if (collection === 'latticeParaDocuments') {
        const ownerId = val(existing, 'ownerId');
        if (!actor.employeeId || (ownerId != null && Number(ownerId) !== Number(actor.employeeId))) {
          throw failTool('RECORD_UPDATE_FORBIDDEN', 403, 'Chỉ người sở hữu hoặc quản lý mới được sửa tài liệu P.A.R.A. này.');
        }
      } else if (['latticeRequests', 'latticeOrders', 'latticeServiceTickets'].includes(collection) || CUSTOM_COLLECTION_RE.test(collection)) {
        const ownerField = val(existing, 'requesterId') ?? val(existing, 'ownerId');
        const createdBy = val(existing, 'createdById');
        const ownsRow = (ownerField != null && actor.employeeId != null && Number(ownerField) === Number(actor.employeeId))
          || (createdBy != null && actor.userId != null && Number(createdBy) === Number(actor.userId));
        const currentStatus = String(val(existing, 'status') || 'draft').toLowerCase();
        if (!ownsRow || currentStatus !== 'draft') {
          throw failTool('RECORD_UPDATE_FORBIDDEN', 403, 'Chỉ được cập nhật bản ghi nháp (draft) do chính bạn khởi tạo.');
        }
      }
    }
  }
  return { repo, safeValues, existing };
}

async function commitScopedRecordWrite({ repo, safeValues, existing }, actor, collection, operation, recordId, ctx) {
  if (operation === 'create') {
    const effectiveEmployeeId = (ctx?.state?.dxosApprovedQueueId && ctx?.state?.dxosRequesterEmployeeId != null)
      ? ctx.state.dxosRequesterEmployeeId
      : actor.employeeId;
    const created = await repo.create({
      values: {
        ...safeValues,
        organizationId: actor.organizationId,
        ...(collection === 'latticeParaDocuments'
          ? { ...(effectiveEmployeeId ? { ownerId: effectiveEmployeeId } : {}), status: safeValues.status || 'active' }
          : { ...(effectiveEmployeeId ? { requesterId: effectiveEmployeeId } : {}), status: 'draft', version: 1 }),
      },
      context: ctx,
    });
    const plain = typeof created?.toJSON === 'function' ? created.toJSON() : created;
    return { operation: 'create', collection, record: plain };
  }
  await existing.update(safeValues, { context: ctx });
  return { operation: 'update', collection, recordId, updatedFields: Object.keys(safeValues) };
}

async function performScopedRecordWrite(db, actor, collection, operation, { recordId, values }, deps, ctx) {
  const preflight = await preflightScopedRecordWrite(db, actor, collection, operation, { recordId, values }, deps);
  return commitScopedRecordWrite(preflight, actor, collection, operation, recordId, ctx);
}

function summarizeModuleRows(rows, val) {
  const byStatus = {};
  for (const r of rows) {
    const st = String(val(r, 'status') || 'unknown');
    byStatus[st] = (byStatus[st] || 0) + 1;
  }
  return { total: rows.length, byStatus };
}

function buildSearchPoolEntry(colName, row, val, pgVectorSim = null) {
  const id = val(row, 'id');
  const label = String(val(row, 'name') || val(row, 'title') || val(row, 'code') || '');
  const code = String(val(row, 'code') || id || '');
  const summary = String(val(row, 'summary') || val(row, 'description') || val(row, 'contentMarkdown') || '');
  const paraSpace = val(row, 'paraSpace') || null;
  const item = {
    collection: colName,
    id,
    code,
    title: label,
    status: val(row, 'status') || paraSpace || null,
    ...(paraSpace ? { paraSpace, paraCitation: `[${colName}:${code}#${id} · ${paraSpace}]` } : {}),
    citation: `[${colName}:${code}#${id}]`,
  };
  const rawSummary = [label, summary, val(row, 'tags') || '', val(row, 'batchCode') || ''].filter(Boolean).join(' · ');
  return {
    item,
    titleText: `${code} ${label}`,
    hayText: `${label} ${code} ${summary} ${val(row, 'tags') || ''} ${val(row, 'batchCode') || ''} ${val(row, 'searchText') || ''}`,
    rawSummary,
    embedding: val(row, 'embeddingJson'),
    ...(pgVectorSim != null && Number.isFinite(Number(pgVectorSim)) ? { pgVectorSim: Number(pgVectorSim) } : {}),
  };
}

function createOperationalTools(deps) {
  const {
    val, failTool, invokeResourceAction, createAuditedTool,
    resolveReadablePolicies, isRowVisibleToActor,
    WRITABLE_BUSINESS_COLLECTIONS, SEARCHABLE_COLLECTIONS, CUSTOM_COLLECTION_RE,
  } = deps;

  return [
    createAuditedTool({
      name: 'dxos_search_enterprise_context',
      adminOnly: false,
      defaultPermission: 'ALLOW',
      introduction: { title: 'Tra cứu Ngữ cảnh Doanh nghiệp', about: 'Tìm kiếm đơn hàng, yêu cầu, sự cố, tài sản, SOP P.A.R.A. và cả phân hệ latticeCustom*.' },
      description: 'Search across organization-scoped business collections and dynamic latticeCustom* modules with record citations.',
      schema: {
        description: 'Organization-scoped cross-collection search.',
        properties: {
          query: { type: 'string', maxLength: 120, description: 'Optional keyword matched against title, name, or code.' },
          collections: { type: 'array', items: { type: 'string' }, description: 'Subset of business or latticeCustom* collections.' },
          scope: { type: 'string', maxLength: 40, description: 'Optional search scope (e.g. "ai_memory" to search persistent latticeAiMemory).' },
          scopes: { type: 'array', items: { type: 'string' }, description: 'Optional memory scopes when searching persistent latticeAiMemory.' },
          memoryScope: { type: 'string', description: 'Optional single memory scope filter (org, agent, user, session).' },
          agentId: { type: 'string', maxLength: 128, description: 'Optional agent identifier for admin memory inspection.' },
          includeMemories: { type: 'boolean', description: 'Optional flag to attach advisory recalled memory context.' },
          limit: { type: 'integer', default: 8 },
        },
      },
      async run(ctx, db, actor, args) {
        const limit = Math.max(1, Math.min(30, Number(args.limit) || 8));
        const q = String(args.query || '').trim();
        let rawMemScopes = args?.scopes;
        if (typeof rawMemScopes === 'string' && rawMemScopes.trim().startsWith('[')) {
          try { rawMemScopes = JSON.parse(rawMemScopes); } catch {}
        }
        const rawMemScopeSingle = args?.memoryScope != null && String(args.memoryScope).trim() !== ''
          ? String(args.memoryScope).trim().toLowerCase()
          : '';
        const memScopesArr = Array.isArray(rawMemScopes)
          ? rawMemScopes.map((s) => String(s || '').trim().toLowerCase()).filter(Boolean)
          : [];
        const requestedMemScopes = [...new Set([
          ...(rawMemScopeSingle ? [rawMemScopeSingle] : []),
          ...memScopesArr,
        ])];
        const rawScopeLower = String(args?.scope || '').trim().toLowerCase();
        if (!actor.isAdmin && (rawScopeLower === 'agent' || requestedMemScopes.includes('agent'))) {
          throw failTool('MEMORY_AGENT_FORBIDDEN', 403, 'Chỉ Quản trị viên mới được truy cập bộ nhớ nội bộ phạm vi agent.');
        }
        const trustedAgentId = ctx?.state?.dxosAiUsername || actor?.aiEmployee || actor?.username || null;
        const argAgentId = args?.agentId != null ? String(args.agentId).trim() : '';
        if (!actor.isAdmin && argAgentId && argAgentId !== String(trustedAgentId || '')) {
          throw failTool('MEMORY_AGENT_FORBIDDEN', 403, 'Không được phép giả mạo agentId khi truy cập bộ nhớ.');
        }
        const allowedMemScopes = requestedMemScopes.length > 0
          ? requestedMemScopes.filter((s) => ['org', 'agent', 'user', 'session'].includes(s) && (actor.isAdmin || s !== 'agent'))
          : (actor.isAdmin ? ['org', 'agent', 'user'] : ['org', 'user']);
        const effectiveMemAgentId = actor.isAdmin ? (argAgentId || trustedAgentId || undefined) : (trustedAgentId || undefined);

        if (args.scope === 'ai_memory') {
          let memories = [];
          let memoryContext = '';
          if (db?.getRepository?.('latticeAiMemory')) {
            try {
              const recalled = await recallMemories(db, {
                organizationId: actor.organizationId,
                scopes: allowedMemScopes.length ? allowedMemScopes : (actor.isAdmin ? ['org', 'agent', 'user'] : ['org', 'user']),
                agentId: effectiveMemAgentId,
                userId: actor?.userId != null ? String(actor.userId) : undefined,
                sessionId: ctx?.state?.dxosSessionId || ctx?.state?.sessionId || undefined,
                enforceSessionOwner: !actor.isAdmin,
                query: q,
                limit,
              });
              memories = recalled.memories || [];
              memoryContext = buildMemoryContextPrompt(memories, { maxChars: 2400, maxItems: limit });
            } catch {
              memories = [];
            }
          }
          const memoryItems = memories.map((m) => ({
            collection: 'latticeAiMemory',
            id: m.id,
            code: m.memoryKey,
            title: m.content,
            scope: m.scope,
            score: m.score,
            citation: `[latticeAiMemory:${m.memoryKey}#${m.id ?? 0}]`,
          }));
          return {
            organizationId: actor.organizationId,
            searchedCollections: ['latticeAiMemory'],
            scope: 'ai_memory',
            count: memoryItems.length,
            items: memoryItems,
            memoryContext,
          };
        }
        const candidates = await resolveSearchableTargets(db, args.collections, SEARCHABLE_COLLECTIONS, CUSTOM_COLLECTION_RE, val);
        const requestedParaChunks = Array.isArray(args.collections) && args.collections.includes('latticeParaChunks');
        const policyProbeCols = requestedParaChunks && !candidates.includes('latticeParaDocuments')
          ? [...candidates, 'latticeParaDocuments']
          : candidates;
        const { allowedCollections: rawTargets, ownOnlySet } = await resolveReadablePolicies(db, actor, policyProbeCols);
        const canSearchParaChunks = rawTargets.includes('latticeParaDocuments');
        const targets = requestedParaChunks && !candidates.includes('latticeParaDocuments')
          ? rawTargets.filter((c) => c !== 'latticeParaDocuments')
          : rawTargets;
        const pool = [];
        const visibleParaDocMap = new Map();
        const hiddenParaDocIds = new Set();
        const docPoolEntryById = new Map();
        const isParaStatusActive = (row) => {
          const activeFlag = val(row, 'active');
          if (activeFlag === false || activeFlag === 0) return false;
          const st = val(row, 'status');
          if (st == null) return true;
          const clean = String(st).trim().toLowerCase();
          return !clean || clean === 'active';
        };
        const docScanCols = canSearchParaChunks && !targets.includes('latticeParaDocuments')
          ? [...targets, 'latticeParaDocuments']
          : targets;
        for (const colName of docScanCols) {
          const repo = db?.getRepository?.(colName);
          if (!repo) continue;
          const scanLimit = colName === 'latticeParaDocuments' ? 200 : (q ? 60 : 25);
          const rows = (await repo.find({ filter: { organizationId: actor.organizationId }, limit: scanLimit, sort: ['-id'] })) || [];
          const isOwnOnly = ownOnlySet.has(colName);
          const emitDocItems = targets.includes(colName);
          for (const row of rows) {
            const id = val(row, 'id');
            if (colName === 'latticeParaDocuments' && (val(row, 'active') === false || !isParaStatusActive(row))) {
              if (id != null) hiddenParaDocIds.add(String(id));
              continue;
            }
            if (!isRowVisibleToActor(row, actor, isOwnOnly)) continue;
            if (colName === 'latticeParaDocuments' && id != null) {
              visibleParaDocMap.set(String(id), row);
            }
            if (!emitDocItems) continue;
            const entry = buildSearchPoolEntry(colName, row, val);
            if (colName === 'latticeParaDocuments' && id != null) {
              docPoolEntryById.set(String(id), entry);
            }
            pool.push(entry);
          }
        }
        let chunkSearched = false;
        let neuralEmbeddingVector = null;
        if (canSearchParaChunks) {
          const chunkRepo = db?.getRepository?.('latticeParaChunks');
          const chunkByKey = new Map();
          const addChunkRow = (row) => {
            if (!row || val(row, 'organizationId') !== actor.organizationId || val(row, 'active') === false) return;
            if (!isParaStatusActive(row)) return;
            const docId = val(row, 'documentId');
            if (docId != null && hiddenParaDocIds.has(String(docId))) return;
            const cid = val(row, 'id');
            const key = cid != null ? `id:${cid}` : `doc:${docId}:${val(row, 'chunkIndex') ?? 0}`;
            const prev = chunkByKey.get(key);
            if (!prev) {
              chunkByKey.set(key, typeof row?.toJSON === 'function' ? row.toJSON() : { ...row });
              return;
            }
            const nextSim = val(row, 'pgVectorSim') ?? val(row, '_pgVectorSim');
            if (nextSim != null && Number.isFinite(Number(nextSim))) {
              prev.pgVectorSim = Number(nextSim);
            }
          };
          if (q) {
            const paraHybrid = loadParaHybridSearch();
            const neuralEmbFn = typeof deps?.computeNeuralEmbedding === 'function'
              ? deps.computeNeuralEmbedding
              : paraHybrid?.computeNeuralEmbedding;
            let usedNeuralChunks = false;
            if (typeof neuralEmbFn === 'function') {
              try {
                const embEnv = ctx?.state?.dxosEmbeddingEnv || process.env;
                const embFetch = ctx?.state?.dxosFetchImpl || globalThis.fetch;
                const emb = await neuralEmbFn(q, { env: embEnv, fetchImpl: embFetch });
                if (emb?.engine === 'neural' && Array.isArray(emb.vector) && emb.vector.length >= 8 && emb.vector.length <= 8192) {
                  neuralEmbeddingVector = emb.vector;
                  const pgVecRows = await executePgVectorParaQuery(db, {
                    table: 'latticeParaChunks',
                    organizationId: actor.organizationId,
                    queryEmbedding: emb.vector,
                    embeddingDim: emb.vector.length,
                    limit: 40,
                  });
                  for (const r of pgVecRows) addChunkRow(r);
                  if (pgVecRows.length) chunkSearched = true;
                  usedNeuralChunks = true;
                }
              } catch {
                // Fall back to 256-dim deterministic path when neural provider is unavailable
              }
            }
            if (!usedNeuralChunks) {
              const pgDocRows = await executePgVectorParaQuery(db, {
                table: 'latticeParaDocuments',
                organizationId: actor.organizationId,
                queryEmbedding: computeEmbedding(q),
                limit: 40,
              });
              const docOwnOnly = ownOnlySet.has('latticeParaDocuments');
              for (const docRow of pgDocRows) {
                if (!docRow || val(docRow, 'organizationId') !== actor.organizationId || val(docRow, 'active') === false) continue;
                if (!isParaStatusActive(docRow)) continue;
                if (!isRowVisibleToActor(docRow, actor, docOwnOnly)) continue;
                const docId = val(docRow, 'id');
                if (docId != null && !visibleParaDocMap.has(String(docId))) {
                  visibleParaDocMap.set(String(docId), docRow);
                }
                if (!targets.includes('latticeParaDocuments')) continue;
                const simRaw = val(docRow, 'pgVectorSim') ?? val(docRow, '_pgVectorSim');
                const simVal = simRaw != null && Number.isFinite(Number(simRaw)) ? Number(simRaw) : null;
                const existingEntry = docId != null ? docPoolEntryById.get(String(docId)) : null;
                if (existingEntry) {
                  if (simVal != null) existingEntry.pgVectorSim = simVal;
                } else {
                  const newEntry = buildSearchPoolEntry('latticeParaDocuments', docRow, val, simVal);
                  if (docId != null) docPoolEntryById.set(String(docId), newEntry);
                  pool.push(newEntry);
                }
              }
            }
          }
          if (chunkRepo && typeof chunkRepo.find === 'function') {
            const chunkRows = (await chunkRepo.find({
              filter: { organizationId: actor.organizationId },
              limit: q ? 120 : 40,
              sort: ['-id'],
            })) || [];
            for (const r of chunkRows) addChunkRow(r);
            chunkSearched = true;
          }
          const docRepo = db?.getRepository?.('latticeParaDocuments');
          if (chunkByKey.size && docRepo && typeof docRepo.find === 'function') {
            const unresolvedDocIds = [];
            for (const ch of chunkByKey.values()) {
              const docId = val(ch, 'documentId');
              if (docId != null && !visibleParaDocMap.has(String(docId)) && !hiddenParaDocIds.has(String(docId))) {
                unresolvedDocIds.push(docId);
              }
            }
            if (unresolvedDocIds.length) {
              const uniqueIds = [...new Set(unresolvedDocIds)];
              const extraDocs = (await docRepo.find({
                filter: { organizationId: actor.organizationId, id: { $in: uniqueIds } },
                limit: uniqueIds.length + 10,
              }).catch(() => [])) || [];
              const foundById = new Map();
              for (const d of extraDocs) {
                const did = val(d, 'id');
                if (did != null) foundById.set(String(did), d);
              }
              const docOwnOnly = ownOnlySet.has('latticeParaDocuments');
              for (const uid of uniqueIds) {
                const docRow = foundById.get(String(uid));
                if (!docRow || val(docRow, 'active') === false || !isParaStatusActive(docRow) || !isRowVisibleToActor(docRow, actor, docOwnOnly)) {
                  hiddenParaDocIds.add(String(uid));
                } else {
                  visibleParaDocMap.set(String(uid), docRow);
                }
              }
            }
          }
          if (chunkByKey.size) {
            const chunkPool = buildParaChunkPoolEntries([...chunkByKey.values()], {
              organizationId: actor.organizationId,
              visibleDocMap: visibleParaDocMap,
              hiddenDocIds: hiddenParaDocIds,
              ownOnly: ownOnlySet.has('latticeParaDocuments'),
              val,
            });
            pool.push(...chunkPool);
          }
        }
        const searchedCollections = chunkSearched && !targets.includes('latticeParaChunks')
          ? [...targets, 'latticeParaChunks']
          : targets;
        const items = rankHybridRecords(q, pool, { limit, neuralEmbedding: neuralEmbeddingVector });
        let memoryContext = '';
        if (args.includeMemories && db?.getRepository?.('latticeAiMemory')) {
          try {
            const recalled = await recallMemories(db, {
              organizationId: actor.organizationId,
              scopes: allowedMemScopes.length ? allowedMemScopes : (actor.isAdmin ? ['org', 'agent', 'user'] : ['org', 'user']),
              agentId: effectiveMemAgentId,
              userId: actor?.userId != null ? String(actor.userId) : undefined,
              sessionId: ctx?.state?.dxosSessionId || ctx?.state?.sessionId || undefined,
              enforceSessionOwner: !actor.isAdmin,
              query: q,
              limit: 5,
            });
            memoryContext = buildMemoryContextPrompt(recalled.memories || [], { maxChars: 1600, maxItems: 5 });
          } catch {
            memoryContext = '';
          }
        }
        return {
          organizationId: actor.organizationId,
          searchedCollections,
          ...(q ? { engine: 'hybrid-rrf' } : {}),
          count: items.length,
          items,
          ...(memoryContext ? { memoryContext } : {}),
        };
      },
    }),

    createAuditedTool({
      name: 'dxos_execute_record_action',
      adminOnly: false,
      defaultPermission: 'ASK',
      introduction: { title: 'Thực thi Hồ sơ Hệ thống', about: 'Tạo/cập nhật bản ghi nghiệp vụ & latticeCustom* đúng tổ chức và kiểm soát trường bị khóa RBAC.' },
      description: 'Create or update an allowed business or dynamic latticeCustom* record enforcing server organizationId, protected field stripping, and field-level RBAC.',
      schema: {
        description: 'Validated business write action.',
        properties: {
          collection: { type: 'string', required: true, maxLength: 60 },
          operation: { type: 'string', required: true, enum: ['create', 'update'] },
          recordId: { type: 'integer' },
          values: { type: 'object', required: true },
          requireApproval: { type: 'boolean', default: false },
        },
      },
      async run(ctx, db, actor, args) {
        const preflight = await preflightScopedRecordWrite(
          db,
          actor,
          args.collection,
          args.operation,
          { recordId: args.recordId, values: args.values },
          deps,
        );
        const { safeValues, existing } = preflight;
        const aiEmployee = ctx?.state?.dxosAiUsername || null;
        const approvedQueueId = ctx?.state?.dxosApprovedQueueId || null;
        if (!approvedQueueId) {
          const effectiveMode = await resolveEffectiveToolMode(db, {
            aiEmployee,
            toolName: 'dxos_execute_record_action',
            defaultPermission: 'ASK',
          });
          if (effectiveMode === 'OFF') {
            throw failTool('TOOL_PERMISSION_OFF', 403, 'Công cụ dxos_execute_record_action đang tắt trên hồ sơ AI này.');
          }
          if (args.requireApproval === true || effectiveMode === 'ASK') {
            const diffPreview = buildDiffPreview({
              collection: args.collection,
              operation: args.operation,
              recordId: args.recordId ?? null,
              existing,
              values: safeValues,
            });
            const riskLevel = computeRiskLevel({
              operation: args.operation,
              values: safeValues,
              requireApproval: args.requireApproval === true,
              existing,
            });
            const queued = await enqueueAiApproval(db, {
              actor,
              aiEmployee,
              toolName: 'dxos_execute_record_action',
              targetCollection: args.collection,
              targetRecordId: args.recordId ?? null,
              operation: args.operation,
              proposedArgs: {
                collection: args.collection,
                operation: args.operation,
                ...(args.recordId != null ? { recordId: args.recordId } : {}),
                values: safeValues,
              },
              diffPreview,
              riskLevel,
            });
            return {
              status: 'pending_approval',
              approvalId: queued.id,
              message: 'Yêu cầu đã vào hàng chờ phê duyệt con người (HITL).',
              diffPreview: queued.diffPreview,
            };
          }
        }

        return commitScopedRecordWrite(preflight, actor, args.collection, args.operation, args.recordId, ctx);
      },
    }),

    createAuditedTool({
      name: 'dxos_my_workflow_tasks',
      adminOnly: false,
      defaultPermission: 'ASK',
      introduction: { title: 'Tác vụ Quy trình Của Tôi', about: 'Đọc các manual task được giao cho chính bạn và hỗ trợ xử lý đúng thẩm quyền.' },
      description: 'List/analyze pending manual workflow tasks assigned to the current caller, or submit their own assigned task (never approves own requests or another user task).',
      schema: {
        description: 'Personal workflow task agent operation.',
        properties: {
          action: { type: 'string', required: true, enum: ['list', 'analyze', 'submit'] },
          taskId: { type: 'integer' },
          formKey: { type: 'string', maxLength: 60 },
          decision: { type: 'string', maxLength: 40 },
          note: { type: 'string', maxLength: 500 },
        },
      },
      async run(ctx, db, actor, args) {
        const taskRepo = db?.getRepository?.('workflowManualTasks');
        if (!taskRepo) throw failTool('WORKFLOW_TASKS_UNAVAILABLE', 503, 'Dịch vụ workflowManualTasks chưa sẵn sàng.');
        if (args.action === 'list' || args.action === 'analyze') {
          const rows = (await taskRepo.find({ filter: { userId: actor.userId, status: 0 }, appends: ['node', 'execution'], limit: 20, sort: ['-id'] })) || [];
          return {
            userId: actor.userId,
            pendingCount: rows.length,
            tasks: rows.map((t) => ({
              taskId: val(t, 'id'),
              nodeTitle: val(val(t, 'node'), 'title') || null,
              recordCode: val(t, 'execution')?.context?.data?.code || null,
              status: val(t, 'status'),
            })),
          };
        }
        if (!args.taskId) throw failTool('TASK_ID_REQUIRED', 400, 'Cần taskId để nộp bước công việc.');
        const task = await taskRepo.findOne({ filterByTk: args.taskId, appends: ['node', 'execution'] });
        if (!task || Number(val(task, 'userId')) !== Number(actor.userId)) {
          throw failTool('TASK_NOT_ASSIGNED_TO_CALLER', 403, 'Chỉ người được giao task mới có quyền xử lý bước này.');
        }
        if (Number(val(task, 'status')) !== 0) {
          throw failTool('TASK_ALREADY_RESOLVED', 409, 'Công việc này đã được xử lý trước đó.');
        }
        const ctxData = val(task, 'execution')?.context?.data || {};
        const isRequesterOwner = (actor.employeeId != null && ctxData.requesterId != null && Number(ctxData.requesterId) === Number(actor.employeeId))
          || (actor.userId != null && (
            (ctxData.createdById != null && Number(ctxData.createdById) === Number(actor.userId))
            || (ctxData.requesterUserId != null && Number(ctxData.requesterUserId) === Number(actor.userId))
          ));
        if (isRequesterOwner) {
          throw failTool('SELF_APPROVAL_FORBIDDEN', 403, 'Không được phép tự phê duyệt hồ sơ do chính mình khởi tạo.');
        }
        const formKey = args.formKey || 'review';
        const submitValues = { result: { [formKey]: args.note ? { note: args.note, deliveryNote: args.note, vehicleNote: args.note } : {}, _: args.decision || 'approve' } };
        await invokeResourceAction(ctx, 'workflowManualTasks', 'submit', { filterByTk: args.taskId, values: submitValues });
        return { submitted: true, taskId: args.taskId, formKey, decision: args.decision || 'approve' };
      },
    }),

    createAuditedTool({
      name: 'dxos_orchestrate_enterprise_case',
      adminOnly: false,
      defaultPermission: 'ASK',
      introduction: { title: 'Điều phối Liên phòng ban 360°', about: 'Radar điểm nghẽn, gom ngữ cảnh đa phân hệ + P.A.R.A. và phối hợp tạo chuỗi hồ sơ liên thông.' },
      description: 'Cross-department enterprise agent: run org-wide operational bottleneck radar, correlate incidents/SOPs/assets/tasks, or execute a coordinated multi-record response enforcing field-level RBAC.',
      schema: {
        description: 'Cross-department case orchestration input.',
        properties: {
          mode: { type: 'string', required: true, enum: ['radar', 'correlateCase', 'executeCoordinatedResponse'] },
          query: { type: 'string', maxLength: 120 },
          primaryRecord: { type: 'object', description: 'Optional { collection, values } primary operational or custom record.' },
          followUpTicket: { type: 'object', description: 'Optional latticeServiceTickets payload linked to the case.' },
          paraHandoverNote: { type: 'object', description: 'Optional latticeParaDocuments handover note linked to primaryRecord.' },
          dryRun: { type: 'boolean', default: false },
        },
      },
      async run(ctx, db, actor, args) {
        const candidates = await resolveSearchableTargets(db, null, SEARCHABLE_COLLECTIONS, CUSTOM_COLLECTION_RE, val);
        const { allowedCollections: targets, ownOnlySet } = await resolveReadablePolicies(db, actor, candidates);
        const allowedSet = new Set(targets);

        if (args.mode === 'radar') {
          const modules = {};
          for (const colName of targets) {
            const repo = db?.getRepository?.(colName);
            if (!repo) continue;
            const rows = (await repo.find({ filter: { organizationId: actor.organizationId }, limit: 100 })) || [];
            const isOwnOnly = ownOnlySet.has(colName);
            const visibleRows = isOwnOnly ? rows.filter((r) => isRowVisibleToActor(r, actor, true)) : rows;
            modules[colName] = summarizeModuleRows(visibleRows, val);
          }
          const taskRepo = db?.getRepository?.('workflowManualTasks');
          const pendingTasks = taskRepo ? ((await taskRepo.find({ filter: { userId: actor.userId, status: 0 }, limit: 50 })) || []) : [];
          return {
            mode: 'radar',
            organizationId: actor.organizationId,
            moduleCount: Object.keys(modules).length,
            modules,
            pendingManualTasks: pendingTasks.length,
          };
        }

        if (args.mode === 'correlateCase') {
          const q = String(args.query || '').trim().toLowerCase();
          const matchRow = (r, extraTokens = []) => {
            if (!q) return true;
            const hay = [
              val(r, 'code'), val(r, 'name'), val(r, 'title'), val(r, 'summary'),
              val(r, 'description'), val(r, 'assetEntityId'), val(r, 'warehouseZone'),
            ].filter(Boolean).join(' ').toLowerCase();
            if (hay.includes(q)) return true;
            return extraTokens.some((tok) => tok && hay.includes(tok));
          };
          const pick = async (col, extraTokens = []) => {
            if (!allowedSet.has(col)) return [];
            const repo = db?.getRepository?.(col);
            if (!repo) return [];
            const rows = (await repo.find({ filter: { organizationId: actor.organizationId }, limit: 25, sort: ['-id'] })) || [];
            const isOwnOnly = ownOnlySet.has(col);
            return rows.filter((r) => {
              if (col === 'latticeParaDocuments') {
                if (val(r, 'active') === false) return false;
                const st = val(r, 'status');
                if (st != null && String(st).trim() !== '' && String(st).trim().toLowerCase() !== 'active') return false;
              }
              return isRowVisibleToActor(r, actor, isOwnOnly) && matchRow(r, extraTokens);
            }).slice(0, 5).map((r) => ({
              id: val(r, 'id'),
              code: val(r, 'code') || String(val(r, 'id')),
              title: val(r, 'name') || val(r, 'title') || val(r, 'code'),
              status: val(r, 'status') || val(r, 'severity') || null,
              assetEntityId: val(r, 'assetEntityId') || null,
              citation: `[${col}:${val(r, 'code') || val(r, 'id')}#${val(r, 'id')}]`,
            }));
          };
          const [assets, sops] = await Promise.all([pick('latticeAssets'), pick('latticeParaDocuments')]);
          const assetTokens = assets.flatMap((a) => {
            const parts = String(a.code || '').toLowerCase().split(/[-_\s]+/).filter((p) => p.length >= 2);
            return [String(a.code || '').toLowerCase(), ...parts];
          });
          const [incidents, tickets] = await Promise.all([
            pick('latticeIncidentCases', assetTokens),
            pick('latticeServiceTickets', assetTokens),
          ]);
          return { mode: 'correlateCase', organizationId: actor.organizationId, query: args.query || '', incidents, sops, assets, tickets };
        }

        // executeCoordinatedResponse
        if (args.dryRun) {
          return {
            dryRun: true,
            mode: 'executeCoordinatedResponse',
            organizationId: actor.organizationId,
            planned: {
              primaryCollection: args.primaryRecord?.collection || null,
              createFollowUpTicket: Boolean(args.followUpTicket),
              createParaHandoverNote: Boolean(args.paraHandoverNote),
            },
          };
        }

        const created = {};
        if (args.primaryRecord?.collection) {
          created.primary = await performScopedRecordWrite(
            db,
            actor,
            args.primaryRecord.collection,
            'create',
            { values: args.primaryRecord.values || {} },
            deps,
            ctx,
          );
        }
        if (args.followUpTicket) {
          const primaryCitation = created.primary?.record ? `[${created.primary.collection}:${created.primary.record.code || created.primary.record.id}#${created.primary.record.id}]` : '';
          const ticketValues = {
            serviceType: 'facilities',
            priority: 'high',
            ...args.followUpTicket,
            ...(primaryCitation ? { description: `${args.followUpTicket.description || ''} | Liên kết: ${primaryCitation}`.trim() } : {}),
          };
          created.followUpTicket = (await performScopedRecordWrite(db, actor, 'latticeServiceTickets', 'create', { values: ticketValues }, deps, ctx)).record;
        }
        if (args.paraHandoverNote) {
          const noteValues = {
            paraSpace: 'projects',
            ...args.paraHandoverNote,
            ...(created.primary?.record ? { relatedCollection: created.primary.collection, relatedRecordId: String(created.primary.record.id) } : {}),
          };
          created.paraHandoverNote = (await performScopedRecordWrite(db, actor, 'latticeParaDocuments', 'create', { values: noteValues }, deps, ctx)).record;
        }
        return { executed: true, mode: 'executeCoordinatedResponse', organizationId: actor.organizationId, created };
      },
    }),

    createAuditedTool({
      name: 'dxos_graph_impact_analysis',
      adminOnly: false,
      defaultPermission: 'ALLOW',
      introduction: { title: 'Phân tích Ảnh hưởng GraphRAG', about: 'Truy vết phả hệ latticeDataLineage và quan hệ kho lạnh - lô - đơn hàng - sự cố - ePOD có kiểm soát RBAC.' },
      description: 'Traverse organization-scoped latticeDataLineage edges and structural cold-chain relationships (assets, incidents, twin shadows, stock lots, order lines, orders, ePOD, P.A.R.A.) respecting RBAC and PII redaction.',
      prepareArgs(rawArgs) {
        if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) && typeof rawArgs.recordId === 'number' && Number.isInteger(rawArgs.recordId)) {
          return { ...rawArgs, recordId: String(rawArgs.recordId) };
        }
        return rawArgs;
      },
      schema: {
        description: 'GraphRAG impact analysis parameters.',
        properties: {
          collection: { type: 'string', required: true, maxLength: 80, description: 'Starting collection name.' },
          recordId: { type: 'string', maxLength: 120, description: 'Record ID (string or integer).' },
          recordCode: { type: 'string', maxLength: 120, description: 'Optional business code or URN.' },
          maxDepth: { type: 'integer', default: 2, description: 'Traversal depth bounded 1..4.' },
          includeTelemetry: { type: 'boolean', default: false, description: 'Include recent telemetry points if readable.' },
        },
      },
      async run(_ctx, db, actor, args) {
        return analyzeGraphImpact(db, actor, args, deps);
      },
    }),

    createAuditedTool({
      name: 'dxos_alarm_action',
      adminOnly: false,
      defaultPermission: 'ASK',
      introduction: { title: 'Xử lý Cảnh báo IoT/Chuỗi lạnh', about: 'Xác nhận tiếp nhận (ack) hoặc đóng cảnh báo (clear) trong latticeIncidentCases với RBAC và HITL.' },
      description: 'Acknowledge (ack) or clear/close (clear) an active alarm in latticeIncidentCases strictly inside caller organizationId with update RBAC and HITL approval support.',
      schema: {
        description: 'Alarm acknowledgement or clearance action.',
        properties: {
          action: { type: 'string', required: true, enum: ['ack', 'clear'] },
          alarmId: { type: 'integer', description: 'Numeric ID of the alarm in latticeIncidentCases.' },
          alarmCode: { type: 'string', maxLength: 80, description: 'Optional alarm code (INC-... or ALM-...).' },
          assetEntityId: { type: 'string', maxLength: 140, description: 'Optional asset entity URN/ID.' },
          note: { type: 'string', maxLength: 500, description: 'Ack resolution note or closure note (clamped to 255 chars).' },
          requireApproval: { type: 'boolean', default: false },
        },
      },
      async run(ctx, db, actor, args) {
        return executeAlarmActionTool(ctx, db, actor, args, deps);
      },
    }),
  ];
}

async function canReadLineageCollection(db, actor, val) {
  if (actor?.isAdmin) return true;
  const resourcesRepo = db?.getRepository?.('dataSourcesRolesResources');
  if (!resourcesRepo) return false;
  const rows = (await resourcesRepo.find({ filter: { name: 'latticeDataLineage', dataSourceKey: 'main' }, appends: ['actions'], limit: 50 })) || [];
  const roleSet = new Set(actor?.roleNames || []);
  const callerRows = rows.filter((r) => val(r, 'name') === 'latticeDataLineage' && roleSet.has(val(r, 'roleName')));
  if (!callerRows.length) return false;
  return callerRows.some((r) => val(r, 'usingActionsConfig') === false || (val(r, 'actions') || []).some((a) => ['view', 'list', 'get'].includes(val(a, 'name'))));
}

function redactGraphValue(value, redactTextFn, depth = 0, seen = new WeakSet()) {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    const trimmed = value.length > 2000 ? `${value.slice(0, 2000)}...` : value;
    return redactTextFn(trimmed).text;
  }
  if (depth > 8) return '[TRUNCATED]';
  if (Array.isArray(value)) {
    return value.map((item) => redactGraphValue(item, redactTextFn, depth + 1, seen));
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_COLLECTION_NAMES.has(k)) continue;
      if (SENSITIVE_KEY_RE.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactGraphValue(v, redactTextFn, depth + 1, seen);
      }
    }
    seen.delete(value);
    return out;
  }
  return redactTextFn(String(value)).text;
}

function resolveRowCode(row, fallbackId, val) {
  return String(
    val(row, 'code')
    || val(row, 'lotCode')
    || val(row, 'epodUid')
    || val(row, 'orderCode')
    || fallbackId
    || '',
  );
}

function buildSafeGraphNode(colName, row, depth, fallbackId, val, redactTextFn) {
  const rawId = val(row, 'id') ?? fallbackId ?? resolveRowCode(row, '', val);
  const recordId = String(rawId ?? '');
  const code = redactTextFn(resolveRowCode(row, recordId, val)).text;
  const rawTitle = String(val(row, 'name') || val(row, 'title') || val(row, 'productName') || code);
  const cleanTitle = redactTextFn(rawTitle).text;
  const rawStatus = val(row, 'status') || val(row, 'commandStatus') || null;
  const status = rawStatus != null ? redactTextFn(String(rawStatus)).text : null;
  const rawSeverity = val(row, 'severity') || null;
  const severity = rawSeverity != null ? redactTextFn(String(rawSeverity)).text : null;
  const rawAssetEntityId = val(row, 'assetEntityId') || val(row, 'entityId') || null;
  const assetEntityId = rawAssetEntityId != null ? redactTextFn(String(rawAssetEntityId)).text : null;
  const safeCitationId = redactTextFn(recordId).text;
  const node = {
    key: `${colName}:${recordId}`,
    collection: colName,
    id: rawId != null && /^\d+$/.test(String(rawId)) ? Number(rawId) : rawId,
    recordId,
    code,
    title: cleanTitle,
    status,
    ...(severity ? { severity } : {}),
    ...(assetEntityId ? { assetEntityId } : {}),
    depth,
    citation: `[${colName}:${code}#${safeCitationId}]`,
  };
  if (colName === 'latticeStockLots') {
    const rawSku = val(row, 'sku');
    node.sku = rawSku ? redactTextFn(String(rawSku)).text : null;
    node.qtyOnHand = val(row, 'qtyOnHand') ?? null;
    node.mktCelsius = val(row, 'mktCelsius') ?? null;
    node.targetTempMaxC = val(row, 'targetTempMaxC') ?? null;
  } else if (colName === 'latticeTwinShadows') {
    const rawCmdStatus = val(row, 'commandStatus');
    node.commandStatus = rawCmdStatus ? redactTextFn(String(rawCmdStatus)).text : null;
    node.lastDeltaJson = redactGraphValue(val(row, 'lastDeltaJson') || {}, redactTextFn);
  }
  return node;
}

function computeAssetMatchKeys(colName, row, orgId, val) {
  const keys = new Set();
  const id = val(row, 'id');
  const code = val(row, 'code');
  const entityId = val(row, 'entityId');
  const assetEntityId = val(row, 'assetEntityId');
  const assetId = val(row, 'assetId');
  if (entityId) keys.add(String(entityId));
  if (assetEntityId) keys.add(String(assetEntityId));
  if (colName === 'latticeAssets') {
    if (id != null) {
      keys.add(`urn:ngsi-ld:Asset:${orgId}:native:${id}`);
    }
    if (code) keys.add(String(code));
  }
  return {
    entityKeys: keys,
    assetId: colName === 'latticeAssets' ? id : assetId,
    warehouseCode: colName === 'latticeAssets' ? code : val(row, 'warehouseCode'),
    locationId: colName === 'latticeAssets' ? val(row, 'locationId') : val(row, 'warehouseLocationId'),
  };
}

function rowMatchesAsset(row, assetInfo, orgId, val) {
  const rowEntity = val(row, 'assetEntityId') || val(row, 'entityId');
  const rowAssetId = val(row, 'assetId');
  const rowWarehouseCode = val(row, 'warehouseCode');
  const rowLocId = val(row, 'warehouseLocationId') ?? val(row, 'locationId');
  if (rowEntity && assetInfo.entityKeys.has(String(rowEntity))) return true;
  if (assetInfo.assetId != null && rowAssetId != null && Number(rowAssetId) === Number(assetInfo.assetId)) return true;
  if (rowEntity && assetInfo.assetId != null && String(rowEntity) === `urn:ngsi-ld:Asset:${orgId}:native:${assetInfo.assetId}`) return true;
  if (assetInfo.warehouseCode && rowWarehouseCode && String(rowWarehouseCode) === String(assetInfo.warehouseCode)) return true;
  if (assetInfo.locationId != null && rowLocId != null && Number(rowLocId) === Number(assetInfo.locationId)) return true;
  return false;
}

async function analyzeGraphImpact(db, actor, args, deps) {
  const { val, failTool, resolveReadablePolicies, isRowVisibleToActor, SYSTEM_PROTECTED_COLLECTIONS, redactPiiText } = deps;
  const redactTextFn = typeof redactPiiText === 'function' ? redactPiiText : defaultRedactPiiText;
  const protectedSet = SYSTEM_PROTECTED_COLLECTIONS || DEFAULT_SYSTEM_PROTECTED;
  const collection = String(args.collection || '').trim();
  if (!IDENTIFIER_RE.test(collection) || FORBIDDEN_COLLECTION_NAMES.has(collection)) {
    throw failTool('GRAPH_COLLECTION_INVALID', 400, 'Tên collection không hợp lệ.');
  }
  if (protectedSet.has(collection)) {
    throw failTool('COLLECTION_FORBIDDEN', 403, `Không được phép truy vấn phân tích trên bảng hệ thống "${collection}".`);
  }
  const rawRecordId = args.recordId != null ? String(args.recordId).trim() : '';
  const rawRecordCode = args.recordCode != null ? String(args.recordCode).trim() : '';
  if (!rawRecordId && !rawRecordCode) {
    throw failTool('GRAPH_TARGET_REQUIRED', 400, 'Cần cung cấp recordId hoặc recordCode để phân tích ảnh hưởng.');
  }

  const maxDepth = Math.max(1, Math.min(MAX_GRAPH_DEPTH, Math.floor(Number(args.maxDepth) || 2)));
  const probeCols = [...new Set([collection, ...GRAPH_COLLECTIONS, ...(args.includeTelemetry ? ['latticeTelemetryPoints'] : [])])];
  const { allowedCollections, ownOnlySet } = await resolveReadablePolicies(db, actor, probeCols);
  const allowedSet = new Set(allowedCollections);
  if (!allowedSet.has(collection)) {
    throw failTool('RBAC_READ_DENIED', 403, `Vai trò hiện tại không có quyền xem "${collection}".`);
  }
  const canReadLineage = await canReadLineageCollection(db, actor, val);

  const rowCache = new Map();
  const orderVisibilityCache = new Map();
  const fetchedCache = new Map();

  async function findOneByFilter(repo, filter) {
    if (!repo) return null;
    if (typeof repo.findOne === 'function') {
      return (await repo.findOne({ filter })) || null;
    }
    if (typeof repo.find === 'function') {
      const rows = (await repo.find({ filter, limit: 1 })) || [];
      return rows[0] || null;
    }
    return null;
  }

  async function fetchRawRecord(colName, idStr, codeStr) {
    const repo = db?.getRepository?.(colName);
    if (!repo) return null;

    if (idStr && POSITIVE_INT_RE.test(idStr) && Number.isSafeInteger(Number(idStr))) {
      const numId = Number(idStr);
      const hit = typeof repo.findOne === 'function'
        ? await repo.findOne({ filterByTk: numId })
        : await findOneByFilter(repo, { id: numId, organizationId: actor.organizationId });
      if (hit) return hit;
    }

    if (codeStr) {
      if (colName === 'latticeAssets') {
        const urnMatch = ASSET_URN_RE.exec(codeStr);
        if (urnMatch) {
          if (urnMatch[1] !== actor.organizationId) {
            return { organizationId: urnMatch[1], _crossOrgUrn: true };
          }
          const urnId = Number(urnMatch[2]);
          if (Number.isSafeInteger(urnId) && urnId > 0) {
            const urnHit = typeof repo.findOne === 'function'
              ? await repo.findOne({ filterByTk: urnId })
              : await findOneByFilter(repo, { id: urnId, organizationId: actor.organizationId });
            if (urnHit) return urnHit;
          }
        }
      }
      const codeFields = COLLECTION_CODE_FIELDS[colName] || ['code'];
      for (const field of codeFields) {
        try {
          const hit = await runInRlsSavepoint(db, () => findOneByFilter(repo, { organizationId: actor.organizationId, [field]: codeStr }));
          if (hit) return hit;
        } catch {
          // Skip field if not present in a custom or mock schema
        }
      }
    }
    return null;
  }

  async function isParentOrderVisibleForLine(lineRow) {
    if (!ownOnlySet.has('latticeOrders')) return true;
    const orderId = val(lineRow, 'orderId');
    const orderCode = val(lineRow, 'orderCode');
    const idKey = orderId != null ? `id:${orderId}` : null;
    const codeKey = orderCode ? `code:${orderCode}` : null;
    if (idKey && orderVisibilityCache.has(idKey)) return orderVisibilityCache.get(idKey);
    if (codeKey && orderVisibilityCache.has(codeKey)) return orderVisibilityCache.get(codeKey);
    if (orderId == null && !orderCode) return false;

    const visibleOrders = await loadOrgRows('latticeOrders');
    const inLoaded = visibleOrders.find((o) => (
      (orderId != null && Number(val(o, 'id')) === Number(orderId))
      || (orderCode && String(val(o, 'code')) === String(orderCode))
    ));
    if (inLoaded) {
      if (idKey) orderVisibilityCache.set(idKey, true);
      if (codeKey) orderVisibilityCache.set(codeKey, true);
      return true;
    }

    const probe = await fetchRawRecord('latticeOrders', orderId != null ? String(orderId) : '', orderCode ? String(orderCode) : '');
    const visible = Boolean(
      probe
      && !probe._crossOrgUrn
      && val(probe, 'organizationId') === actor.organizationId
      && isRowVisibleToActor(probe, actor, true),
    );
    if (idKey) orderVisibilityCache.set(idKey, visible);
    if (codeKey) orderVisibilityCache.set(codeKey, visible);
    return visible;
  }

  async function isRecordVisibleToActor(colName, row) {
    if (!row || row._crossOrgUrn || val(row, 'organizationId') !== actor.organizationId) return false;
    if (!isRowVisibleToActor(row, actor, ownOnlySet.has(colName))) return false;
    if (colName === 'latticeOrderLines' && ownOnlySet.has('latticeOrders')) {
      return isParentOrderVisibleForLine(row);
    }
    return true;
  }

  async function loadOrgRows(colName) {
    if (!allowedSet.has(colName)) return [];
    if (rowCache.has(colName)) return rowCache.get(colName);
    const repo = db?.getRepository?.(colName);
    if (!repo || typeof repo.find !== 'function') {
      rowCache.set(colName, []);
      return [];
    }
    const raw = (await repo.find({ filter: { organizationId: actor.organizationId }, limit: 300, sort: ['-id'] })) || [];
    const isOwn = ownOnlySet.has(colName);
    const prelim = raw.filter((r) => val(r, 'organizationId') === actor.organizationId && isRowVisibleToActor(r, actor, isOwn));
    let visible = prelim;
    if (colName === 'latticeOrderLines' && ownOnlySet.has('latticeOrders')) {
      visible = [];
      for (const line of prelim) {
        if (await isParentOrderVisibleForLine(line)) visible.push(line);
      }
    }
    rowCache.set(colName, visible);
    return visible;
  }

  async function findRowAcrossOrg(colName, recordIdStr, codeStr = '') {
    const rows = await loadOrgRows(colName);
    return rows.find((r) => {
      if (recordIdStr && String(val(r, 'id')) === recordIdStr) return true;
      if (codeStr) {
        if (colName === 'latticeAssets' && val(r, 'id') != null && codeStr === `urn:ngsi-ld:Asset:${actor.organizationId}:native:${val(r, 'id')}`) {
          return true;
        }
        for (const key of ['code', 'lotCode', 'epodUid', 'orderCode', 'entityId', 'assetEntityId']) {
          if (val(r, key) != null && String(val(r, key)) === codeStr) return true;
        }
      }
      return false;
    }) || null;
  }

  async function fetchOrgScopedRecord(colName, rawIdInput, rawCodeInput = '', { throwOnForbidden = false } = {}) {
    if (!allowedSet.has(colName)) return null;
    const idStr = rawIdInput != null ? String(rawIdInput).trim() : '';
    const codeStr = rawCodeInput != null ? String(rawCodeInput).trim() : '';
    const numericId = POSITIVE_INT_RE.test(idStr) && Number.isSafeInteger(Number(idStr)) ? idStr : '';
    const lookupCode = codeStr || (!numericId ? idStr : '');
    if (!numericId && !lookupCode) return null;

    const cacheKey = `${colName}|${numericId}|${lookupCode}`;
    if (!throwOnForbidden && fetchedCache.has(cacheKey)) {
      return fetchedCache.get(cacheKey);
    }

    const probe = await fetchRawRecord(colName, numericId, lookupCode);
    if (!probe) {
      if (!throwOnForbidden) fetchedCache.set(cacheKey, null);
      return null;
    }
    if (probe._crossOrgUrn || val(probe, 'organizationId') !== actor.organizationId) {
      if (throwOnForbidden) {
        throw failTool('RECORD_NOT_FOUND_OR_FORBIDDEN', 403, 'Không được phép phân tích bản ghi thuộc tổ chức khác.');
      }
      fetchedCache.set(cacheKey, null);
      return null;
    }
    if (!(await isRecordVisibleToActor(colName, probe))) {
      if (throwOnForbidden) {
        throw failTool('RECORD_NOT_FOUND_OR_FORBIDDEN', 403, 'Bạn không có quyền truy cập bản ghi này.');
      }
      fetchedCache.set(cacheKey, null);
      return null;
    }
    fetchedCache.set(cacheKey, probe);
    return probe;
  }

  async function findOrFetchOrgRecord(colName, idVal, codeVal = '') {
    const idStr = idVal != null ? String(idVal).trim() : '';
    const codeStr = codeVal != null ? String(codeVal).trim() : '';
    if (!idStr && !codeStr) return null;
    const local = await findRowAcrossOrg(colName, idStr, codeStr);
    if (local) return local;
    return fetchOrgScopedRecord(colName, idStr, codeStr);
  }

  // Verify root target strictly inside actor.organizationId (and resolve beyond 300-row window)
  const effectiveNumericId = POSITIVE_INT_RE.test(rawRecordId) && Number.isSafeInteger(Number(rawRecordId)) ? rawRecordId : '';
  const effectiveCode = rawRecordCode || (!effectiveNumericId ? rawRecordId : '');
  let rootRow = await findRowAcrossOrg(collection, rawRecordId, effectiveCode);
  if (!rootRow) {
    rootRow = await fetchOrgScopedRecord(collection, effectiveNumericId, effectiveCode, { throwOnForbidden: true });
  }
  if (!rootRow) {
    throw failTool('GRAPH_ROOT_NOT_FOUND', 404, `Không tìm thấy bản ghi mục tiêu trong "${collection}" thuộc tổ chức.`);
  }

  const lineageRepo = canReadLineage ? db?.getRepository?.('latticeDataLineage') : null;
  const orgLineageRows = lineageRepo && typeof lineageRepo.find === 'function'
    ? ((await lineageRepo.find({ filter: { organizationId: actor.organizationId }, limit: 500 })) || []).filter((r) => val(r, 'organizationId') === actor.organizationId)
    : [];

  const rootNode = buildSafeGraphNode(collection, rootRow, 0, rawRecordId || rawRecordCode, val, redactTextFn);
  const visitedNodes = new Map([[rootNode.key, rootNode]]);
  const edgesMap = new Map();
  const queue = [{ collection, recordId: rootNode.recordId, row: rootRow, depth: 0 }];
  let truncated = false;

  const enqueueNeighbor = async (fromKey, targetCol, targetRow, relationType, nextDepth, fallbackId = null) => {
    if (!allowedSet.has(targetCol) || !targetRow) return null;
    if (!(await isRecordVisibleToActor(targetCol, targetRow))) return null;

    const node = buildSafeGraphNode(targetCol, targetRow, nextDepth, fallbackId, val, redactTextFn);
    const edgeKey = `${fromKey}|${node.key}|${relationType}`;
    if (!edgesMap.has(edgeKey)) {
      edgesMap.set(edgeKey, {
        source: fromKey,
        target: node.key,
        relationType,
      });
    }
    if (!visitedNodes.has(node.key)) {
      if (visitedNodes.size >= MAX_GRAPH_NODES) {
        truncated = true;
        return null;
      }
      visitedNodes.set(node.key, node);
      queue.push({ collection: targetCol, recordId: node.recordId, row: targetRow, depth: nextDepth });
    }
    return node;
  };

  while (queue.length > 0 && visitedNodes.size < MAX_GRAPH_NODES) {
    const cur = queue.shift();
    if (cur.depth >= maxDepth) continue;
    const nextDepth = cur.depth + 1;
    const curKey = `${cur.collection}:${cur.recordId}`;
    const curRow = cur.row;
    const curId = val(curRow, 'id') ?? cur.recordId;
    const curCode = resolveRowCode(curRow, cur.recordId, val);
    const curEdgeTokens = new Set([cur.recordId, String(curId), curCode].filter(Boolean));

    // 1. Traverse latticeDataLineage edges strictly inside actor.organizationId & allowedSet (never fabricating stubs)
    for (const edge of orgLineageRows) {
      const srcCol = val(edge, 'sourceCollection');
      const srcId = String(val(edge, 'sourceRecordId') ?? '');
      const tgtCol = val(edge, 'targetCollection');
      const tgtId = String(val(edge, 'targetRecordId') ?? '');
      const relType = String(val(edge, 'relationType') || 'lineage');

      let neighborCol = null;
      let neighborId = null;
      if (srcCol === cur.collection && curEdgeTokens.has(srcId)) {
        neighborCol = tgtCol;
        neighborId = tgtId;
      } else if (tgtCol === cur.collection && curEdgeTokens.has(tgtId)) {
        neighborCol = srcCol;
        neighborId = srcId;
      }
      if (!neighborCol || !neighborId || !allowedSet.has(neighborCol)) continue;

      let neighborRow = await findRowAcrossOrg(neighborCol, neighborId, neighborId);
      if (!neighborRow) {
        neighborRow = await fetchOrgScopedRecord(neighborCol, neighborId, neighborId);
      }
      if (neighborRow) {
        await enqueueNeighbor(curKey, neighborCol, neighborRow, relType, nextDepth, neighborId);
      }
    }

    // 2. Structural cold-chain relationships inside caller's organizationId
    if (cur.collection === 'latticeAssets' || cur.collection === 'latticeIncidentCases' || cur.collection === 'latticeTwinShadows') {
      const assetInfo = computeAssetMatchKeys(cur.collection, curRow, actor.organizationId, val);
      const [assets, incidents, shadows, lots, paraDocs] = await Promise.all([
        cur.collection === 'latticeAssets' ? Promise.resolve([]) : loadOrgRows('latticeAssets'),
        cur.collection === 'latticeIncidentCases' ? Promise.resolve([]) : loadOrgRows('latticeIncidentCases'),
        cur.collection === 'latticeTwinShadows' ? Promise.resolve([]) : loadOrgRows('latticeTwinShadows'),
        loadOrgRows('latticeStockLots'),
        loadOrgRows('latticeParaDocuments'),
      ]);
      let matchedAsset = false;
      for (const a of assets) {
        const aKeys = computeAssetMatchKeys('latticeAssets', a, actor.organizationId, val);
        const matchesId = assetInfo.assetId != null && Number(val(a, 'id')) === Number(assetInfo.assetId);
        const matchesUrn = [...assetInfo.entityKeys].some((k) => aKeys.entityKeys.has(k));
        if (matchesId || matchesUrn) {
          matchedAsset = true;
          await enqueueNeighbor(curKey, 'latticeAssets', a, 'belongs_to_asset', nextDepth);
        }
      }
      if (!matchedAsset && cur.collection !== 'latticeAssets' && allowedSet.has('latticeAssets')) {
        const fallbackAsset = await findOrFetchOrgRecord('latticeAssets', assetInfo.assetId, assetInfo.warehouseCode || [...assetInfo.entityKeys][0] || '');
        if (fallbackAsset) await enqueueNeighbor(curKey, 'latticeAssets', fallbackAsset, 'belongs_to_asset', nextDepth);
      }
      for (const inc of incidents) {
        if (rowMatchesAsset(inc, assetInfo, actor.organizationId, val)) {
          await enqueueNeighbor(curKey, 'latticeIncidentCases', inc, 'has_incident', nextDepth);
        }
      }
      for (const sh of shadows) {
        if (rowMatchesAsset(sh, assetInfo, actor.organizationId, val)) {
          await enqueueNeighbor(curKey, 'latticeTwinShadows', sh, 'has_twin_shadow', nextDepth);
        }
      }
      for (const lot of lots) {
        if (rowMatchesAsset(lot, assetInfo, actor.organizationId, val)) {
          await enqueueNeighbor(curKey, 'latticeStockLots', lot, 'stores_lot', nextDepth);
        }
      }
      for (const doc of paraDocs) {
        if (val(doc, 'relatedCollection') === cur.collection && [String(curId), curCode].includes(String(val(doc, 'relatedRecordId') || ''))) {
          await enqueueNeighbor(curKey, 'latticeParaDocuments', doc, 'documented_by', nextDepth);
        }
      }
    }

    if (cur.collection === 'latticeStockLots') {
      const assetInfo = computeAssetMatchKeys('latticeStockLots', curRow, actor.organizationId, val);
      const [assets, incidents, shadows, lines, orders, paraDocs] = await Promise.all([
        loadOrgRows('latticeAssets'),
        loadOrgRows('latticeIncidentCases'),
        loadOrgRows('latticeTwinShadows'),
        loadOrgRows('latticeOrderLines'),
        loadOrgRows('latticeOrders'),
        loadOrgRows('latticeParaDocuments'),
      ]);
      let matchedAsset = false;
      for (const a of assets) {
        const aKeys = computeAssetMatchKeys('latticeAssets', a, actor.organizationId, val);
        if ([...assetInfo.entityKeys].some((k) => aKeys.entityKeys.has(k))) {
          matchedAsset = true;
          await enqueueNeighbor(curKey, 'latticeAssets', a, 'stored_at_asset', nextDepth);
        }
      }
      if (!matchedAsset && allowedSet.has('latticeAssets')) {
        const fallbackAsset = await findOrFetchOrgRecord('latticeAssets', assetInfo.assetId, assetInfo.warehouseCode || [...assetInfo.entityKeys][0] || '');
        if (fallbackAsset) await enqueueNeighbor(curKey, 'latticeAssets', fallbackAsset, 'stored_at_asset', nextDepth);
      }
      for (const inc of incidents) {
        if (rowMatchesAsset(inc, assetInfo, actor.organizationId, val)) {
          await enqueueNeighbor(curKey, 'latticeIncidentCases', inc, 'exposed_to_incident', nextDepth);
        }
      }
      for (const sh of shadows) {
        if (rowMatchesAsset(sh, assetInfo, actor.organizationId, val)) {
          await enqueueNeighbor(curKey, 'latticeTwinShadows', sh, 'monitored_by_twin', nextDepth);
        }
      }
      for (const line of lines) {
        const matchId = curId != null && val(line, 'lotId') != null && Number(val(line, 'lotId')) === Number(curId);
        const matchCode = curCode && val(line, 'lotCode') && String(val(line, 'lotCode')) === String(curCode);
        if (!matchId && !matchCode) continue;
        const lineNode = await enqueueNeighbor(curKey, 'latticeOrderLines', line, 'allocated_to_line', nextDepth);
        if (lineNode && allowedSet.has('latticeOrders')) {
          const parentOrd = orders.find((o) => (
            (val(line, 'orderId') != null && Number(val(o, 'id')) === Number(val(line, 'orderId')))
            || (val(line, 'orderCode') && String(val(o, 'code')) === String(val(line, 'orderCode')))
          )) || await findOrFetchOrgRecord('latticeOrders', val(line, 'orderId'), val(line, 'orderCode'));
          if (parentOrd) await enqueueNeighbor(lineNode.key, 'latticeOrders', parentOrd, 'belongs_to_order', nextDepth);
        }
      }
      for (const doc of paraDocs) {
        if (val(doc, 'relatedCollection') === 'latticeStockLots' && [String(curId), curCode].includes(String(val(doc, 'relatedRecordId') || ''))) {
          await enqueueNeighbor(curKey, 'latticeParaDocuments', doc, 'documented_by', nextDepth);
        }
      }
    }

    if (cur.collection === 'latticeOrderLines') {
      const [orders, lots] = await Promise.all([loadOrgRows('latticeOrders'), loadOrgRows('latticeStockLots')]);
      let matchedOrder = false;
      for (const ord of orders) {
        if ((val(curRow, 'orderId') != null && Number(val(ord, 'id')) === Number(val(curRow, 'orderId')))
          || (val(curRow, 'orderCode') && String(val(ord, 'code')) === String(val(curRow, 'orderCode')))) {
          matchedOrder = true;
          await enqueueNeighbor(curKey, 'latticeOrders', ord, 'belongs_to_order', nextDepth);
        }
      }
      if (!matchedOrder && allowedSet.has('latticeOrders')) {
        const fallbackOrd = await findOrFetchOrgRecord('latticeOrders', val(curRow, 'orderId'), val(curRow, 'orderCode'));
        if (fallbackOrd) await enqueueNeighbor(curKey, 'latticeOrders', fallbackOrd, 'belongs_to_order', nextDepth);
      }
      let matchedLot = false;
      for (const lot of lots) {
        if ((val(curRow, 'lotId') != null && Number(val(lot, 'id')) === Number(val(curRow, 'lotId')))
          || (val(curRow, 'lotCode') && String(val(lot, 'lotCode') || val(lot, 'code')) === String(val(curRow, 'lotCode')))) {
          matchedLot = true;
          await enqueueNeighbor(curKey, 'latticeStockLots', lot, 'consumes_lot', nextDepth);
        }
      }
      if (!matchedLot && allowedSet.has('latticeStockLots')) {
        const fallbackLot = await findOrFetchOrgRecord('latticeStockLots', val(curRow, 'lotId'), val(curRow, 'lotCode'));
        if (fallbackLot) await enqueueNeighbor(curKey, 'latticeStockLots', fallbackLot, 'consumes_lot', nextDepth);
      }
    }

    if (cur.collection === 'latticeOrders') {
      const [lines, lots, epods, paraDocs] = await Promise.all([
        loadOrgRows('latticeOrderLines'),
        loadOrgRows('latticeStockLots'),
        loadOrgRows('latticeEpodRecords'),
        loadOrgRows('latticeParaDocuments'),
      ]);
      for (const line of lines) {
        const matchOrdId = curId != null && val(line, 'orderId') != null && Number(val(line, 'orderId')) === Number(curId);
        const matchOrdCode = curCode && val(line, 'orderCode') && String(val(line, 'orderCode')) === String(curCode);
        if (!matchOrdId && !matchOrdCode) continue;
        const lineNode = await enqueueNeighbor(curKey, 'latticeOrderLines', line, 'has_order_line', nextDepth);
        if (lineNode && allowedSet.has('latticeStockLots')) {
          const lot = lots.find((l) => (
            (val(line, 'lotId') != null && Number(val(l, 'id')) === Number(val(line, 'lotId')))
            || (val(line, 'lotCode') && String(val(l, 'lotCode') || val(l, 'code')) === String(val(line, 'lotCode')))
          )) || await findOrFetchOrgRecord('latticeStockLots', val(line, 'lotId'), val(line, 'lotCode'));
          if (lot) await enqueueNeighbor(lineNode.key, 'latticeStockLots', lot, 'consumes_lot', nextDepth);
        }
      }
      for (const epod of epods) {
        const matchOrdId = curId != null && val(epod, 'orderId') != null && Number(val(epod, 'orderId')) === Number(curId);
        const matchOrdCode = curCode && val(epod, 'orderCode') && String(val(epod, 'orderCode')) === String(curCode);
        if (matchOrdId || matchOrdCode) await enqueueNeighbor(curKey, 'latticeEpodRecords', epod, 'delivered_by_epod', nextDepth);
      }
      for (const doc of paraDocs) {
        if (val(doc, 'relatedCollection') === 'latticeOrders' && [String(curId), curCode].includes(String(val(doc, 'relatedRecordId') || ''))) {
          await enqueueNeighbor(curKey, 'latticeParaDocuments', doc, 'documented_by', nextDepth);
        }
      }
    }

    if (cur.collection === 'latticeEpodRecords') {
      const orders = await loadOrgRows('latticeOrders');
      let matchedOrder = false;
      for (const ord of orders) {
        const matchId = val(curRow, 'orderId') != null && Number(val(ord, 'id')) === Number(val(curRow, 'orderId'));
        const matchCode = val(curRow, 'orderCode') && String(val(ord, 'code')) === String(val(curRow, 'orderCode'));
        if (matchId || matchCode) {
          matchedOrder = true;
          await enqueueNeighbor(curKey, 'latticeOrders', ord, 'epod_for_order', nextDepth);
        }
      }
      if (!matchedOrder && allowedSet.has('latticeOrders')) {
        const fallbackOrd = await findOrFetchOrgRecord('latticeOrders', val(curRow, 'orderId'), val(curRow, 'orderCode'));
        if (fallbackOrd) await enqueueNeighbor(curKey, 'latticeOrders', fallbackOrd, 'epod_for_order', nextDepth);
      }
    }
  }

  const nodes = [...visitedNodes.values()];
  const edges = [...edgesMap.values()];
  const byCollection = {};
  let rawScore = 0;
  let incidentsCount = 0;
  let activeIncidentsCount = 0;
  let lotsCount = 0;
  let ordersCount = 0;
  let epodCount = 0;
  let twinShadowsCount = 0;
  let paraSopsCount = 0;

  for (const n of nodes) {
    byCollection[n.collection] = (byCollection[n.collection] || 0) + 1;
    if (n.collection === 'latticeIncidentCases') {
      incidentsCount += 1;
      const st = String(n.status || 'open').toLowerCase();
      if (!['closed', 'cleared', 'resolved'].includes(st)) {
        activeIncidentsCount += 1;
        const sev = String(n.severity || 'medium').toLowerCase();
        rawScore += sev === 'critical' ? 35 : sev === 'high' ? 25 : sev === 'medium' ? 15 : 8;
      }
    } else if (n.collection === 'latticeStockLots') {
      lotsCount += 1;
      rawScore += 10;
      const st = String(n.status || '').toLowerCase();
      if (['hold_mkt', 'quarantined', 'expired'].includes(st) || (n.mktCelsius != null && n.targetTempMaxC != null && n.mktCelsius > n.targetTempMaxC)) {
        rawScore += 10;
      }
    } else if (n.collection === 'latticeOrders') {
      ordersCount += 1;
      const st = String(n.status || '').toLowerCase();
      if (!['cancelled', 'completed'].includes(st)) rawScore += 12;
    } else if (n.collection === 'latticeTwinShadows') {
      twinShadowsCount += 1;
      if (['pending', 'failed', 'drift'].includes(String(n.commandStatus || '').toLowerCase())) rawScore += 10;
    } else if (n.collection === 'latticeEpodRecords') {
      epodCount += 1;
      rawScore += 5;
    } else if (n.collection === 'latticeParaDocuments') {
      paraSopsCount += 1;
    }
  }

  const impactScore = Math.min(100, rawScore);
  const impactLevel = impactScore >= 75 ? 'critical' : impactScore >= 45 ? 'high' : impactScore >= 20 ? 'medium' : 'low';

  let telemetry = [];
  if (args.includeTelemetry && allowedSet.has('latticeTelemetryPoints')) {
    const assetEntities = new Set(nodes.map((n) => n.assetEntityId).filter(Boolean));
    for (const n of nodes) {
      if (n.collection === 'latticeAssets' && n.id != null) {
        assetEntities.add(`urn:ngsi-ld:Asset:${actor.organizationId}:native:${n.id}`);
      }
    }
    const assetIds = new Set(nodes.filter((n) => n.collection === 'latticeAssets' && n.id != null).map((n) => Number(n.id)));
    const tpRows = (assetEntities.size || assetIds.size) ? await loadOrgRows('latticeTelemetryPoints') : [];
    telemetry = tpRows
      .filter((t) => (
        (val(t, 'assetEntityId') && assetEntities.has(String(val(t, 'assetEntityId'))))
        || (val(t, 'assetId') != null && assetIds.has(Number(val(t, 'assetId'))))
      ))
      .slice(0, 20)
      .map((t) => redactGraphValue({
        id: val(t, 'id'),
        assetId: val(t, 'assetId') ?? null,
        assetEntityId: val(t, 'assetEntityId') || null,
        metricName: val(t, 'metricName') || 'temperature',
        numericValue: val(t, 'numericValue') ?? null,
        unit: val(t, 'unit') || null,
        quality: val(t, 'quality') || 'good',
        observedAt: val(t, 'observedAt') || null,
      }, redactTextFn));
  }

  const summary = redactGraphValue({
    totalAffected: Math.max(0, nodes.length - 1),
    incidentsCount,
    activeIncidentsCount,
    lotsCount,
    ordersCount,
    epodCount,
    twinShadowsCount,
    paraSopsCount,
    byCollection,
  }, redactTextFn);

  return {
    organizationId: actor.organizationId,
    root: rootNode,
    maxDepth,
    maxNodes: MAX_GRAPH_NODES,
    truncated,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    impactScore,
    impactLevel,
    summary,
    citations: [...new Set(nodes.map((n) => n.citation))],
    nodes,
    edges,
    ...(args.includeTelemetry ? { telemetry } : {}),
  };
}

async function assertIncidentUpdateRbac(db, actor, { val, failTool }) {
  if (actor.isAdmin) return;
  const resourcesRepo = db?.getRepository?.('dataSourcesRolesResources');
  if (!resourcesRepo) {
    throw failTool('RBAC_POLICY_MISSING', 403, 'Chưa có kho cấu hình phân quyền RBAC cho latticeIncidentCases.');
  }
  const policies = (await resourcesRepo.find({ filter: { name: 'latticeIncidentCases', dataSourceKey: 'main' }, appends: ['actions'], limit: 50 })) || [];
  const roleSet = new Set(actor.roleNames || []);
  const callerPolicies = policies.filter((p) => val(p, 'name') === 'latticeIncidentCases' && roleSet.has(val(p, 'roleName')));
  const canUpdate = callerPolicies.some((p) => (
    val(p, 'usingActionsConfig') === false
    || (val(p, 'actions') || []).some((a) => val(a, 'name') === 'update')
  ));
  if (!canUpdate) {
    throw failTool('RBAC_ACTION_DENIED', 403, 'Vai trò hiện tại không có quyền cập nhật (update) cảnh báo trên latticeIncidentCases.');
  }
}

async function executeAlarmActionTool(ctx, db, actor, args, deps) {
  const { val, failTool } = deps;
  await assertIncidentUpdateRbac(db, actor, deps);

  const repo = db?.getRepository?.('latticeIncidentCases');
  if (!repo) throw failTool('INCIDENT_REPO_UNAVAILABLE', 503, 'Kho sự cố chưa sẵn sàng.');

  const cleanCode = typeof args.alarmCode === 'string' ? args.alarmCode.trim() : '';
  const cleanEntityId = typeof args.assetEntityId === 'string' ? args.assetEntityId.trim() : '';
  if (args.alarmId == null && !cleanCode && !cleanEntityId) {
    throw failTool('ALARM_TARGET_REQUIRED', 400, 'Cần alarmId, alarmCode hoặc assetEntityId để xác định cảnh báo.');
  }

  let row = null;
  if (args.alarmId != null) {
    if (!Number.isInteger(args.alarmId) || args.alarmId <= 0) {
      throw failTool('ALARM_ID_INVALID', 400, 'alarmId phải là số nguyên dương.');
    }
    row = await repo.findOne({ filterByTk: args.alarmId });
    if (!row || val(row, 'organizationId') !== actor.organizationId) {
      throw failTool('ALARM_NOT_FOUND', 404, 'Không tìm thấy cảnh báo trong phạm vi tổ chức.');
    }
  } else if (cleanCode) {
    const rows = (await repo.find({ filter: { organizationId: actor.organizationId, code: cleanCode }, limit: 5 })) || [];
    row = rows.find((r) => val(r, 'organizationId') === actor.organizationId && val(r, 'code') === cleanCode) || null;
    if (!row) throw failTool('ALARM_NOT_FOUND', 404, 'Không tìm thấy cảnh báo theo mã trong phạm vi tổ chức.');
  } else {
    const rows = (await repo.find({ filter: { organizationId: actor.organizationId, assetEntityId: cleanEntityId }, sort: ['-id'], limit: 20 })) || [];
    const orgRows = rows.filter((r) => val(r, 'organizationId') === actor.organizationId && val(r, 'assetEntityId') === cleanEntityId);
    row = orgRows.find((r) => !['closed', 'cleared'].includes(String(val(r, 'status') || 'open').toLowerCase())) || orgRows[0] || null;
    if (!row) throw failTool('ALARM_NOT_FOUND', 404, 'Không tìm thấy cảnh báo cho thiết bị này trong phạm vi tổ chức.');
  }

  const curStatus = String(val(row, 'status') || 'open').toLowerCase();
  if (curStatus === 'closed' || curStatus === 'cleared') {
    throw failTool('ALARM_ALREADY_CLEARED', 409, 'Cảnh báo này đã được đóng trước đó.');
  }

  const alarmId = val(row, 'id');
  const actorName = String(actor.username || `user-${actor.userId}`).slice(0, 120);
  const rawNote = typeof args.note === 'string' ? args.note.trim() : '';
  const now = new Date();
  const patch = args.action === 'ack'
    ? {
        status: 'acknowledged',
        acknowledgedAt: val(row, 'acknowledgedAt') || now,
        acknowledgedBy: actorName,
        ...(rawNote ? { resolutionNote: rawNote.slice(0, 255) } : {}),
      }
    : {
        status: 'closed',
        clearedAt: now,
        clearedBy: actorName,
        closeNote: (rawNote || `Đã đóng cảnh báo bởi ${actorName}`).slice(0, 255),
      };

  const aiEmployee = ctx?.state?.dxosAiUsername || null;
  const approvedQueueId = ctx?.state?.dxosApprovedQueueId || null;
  if (!approvedQueueId) {
    const effectiveMode = await resolveEffectiveToolMode(db, {
      aiEmployee,
      toolName: 'dxos_alarm_action',
      defaultPermission: 'ASK',
    });
    if (effectiveMode === 'OFF') {
      throw failTool('TOOL_PERMISSION_OFF', 403, 'Công cụ dxos_alarm_action đang tắt trên hồ sơ AI này.');
    }
    if (args.requireApproval === true || effectiveMode === 'ASK') {
      const diffPreview = buildDiffPreview({
        collection: 'latticeIncidentCases',
        operation: 'update',
        recordId: alarmId,
        existing: row,
        values: patch,
      });
      const queued = await enqueueAiApproval(db, {
        actor,
        aiEmployee,
        toolName: 'dxos_alarm_action',
        targetCollection: 'latticeIncidentCases',
        targetRecordId: alarmId,
        operation: 'update',
        proposedArgs: {
          action: args.action,
          alarmId,
          ...(rawNote ? { note: rawNote.slice(0, 255) } : {}),
        },
        diffPreview,
        riskLevel: args.action === 'clear' ? 'high' : computeRiskLevel({ operation: 'update', values: patch, requireApproval: args.requireApproval === true, existing: row }),
      });
      return {
        status: 'pending_approval',
        approvalId: queued.id,
        message: 'Yêu cầu xử lý cảnh báo đã vào hàng chờ phê duyệt con người (HITL).',
        diffPreview: queued.diffPreview,
      };
    }
  }

  if (typeof row.update === 'function') {
    await row.update(patch, { context: ctx });
  } else if (typeof repo.update === 'function') {
    await repo.update({ filterByTk: alarmId, filter: { organizationId: actor.organizationId }, values: patch });
  }

  return {
    updated: true,
    action: args.action,
    alarmId,
    alarmCode: val(row, 'code') || null,
    organizationId: actor.organizationId,
    status: patch.status,
    acknowledgedBy: patch.acknowledgedBy || val(row, 'acknowledgedBy') || null,
    clearedBy: patch.clearedBy || val(row, 'clearedBy') || null,
    resolutionNote: patch.resolutionNote || val(row, 'resolutionNote') || null,
    closeNote: patch.closeNote || val(row, 'closeNote') || null,
  };
}

module.exports = { createOperationalTools, analyzeGraphImpact };
