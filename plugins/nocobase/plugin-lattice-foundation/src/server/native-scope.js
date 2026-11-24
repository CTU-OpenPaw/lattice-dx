/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { installRlsTransactionBridge, setContextRlsTransaction, setTransactionRlsOrg, withTenantRlsContext } = require('./pg-rls');

function failure(code, status = 403, message = code) {
  return Object.assign(new Error(message), {code, status});
}
function extractExpectedVersion(ctx, params) {
  let raw;
  if (params?.values && typeof params.values === 'object' && !Array.isArray(params.values) && Object.hasOwn(params.values, 'expectedVersion')) {
    raw = params.values.expectedVersion;
    delete params.values.expectedVersion;
  } else {
    const ifMatch = typeof ctx?.get === 'function' ? (ctx.get('If-Match') || ctx.get('X-Expected-Version')) : '';
    if (ifMatch) raw = String(ifMatch).replace(/^W\//i, '').replace(/^"+|"+$/g, '').trim();
    else if (ctx?.query?.expectedVersion !== undefined) raw = ctx.query.expectedVersion;
  }
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const trimmed = String(raw).trim();
  if (!/^[1-9]\d{0,9}$/.test(trimmed)) {
    throw failure('INVALID_EXPECTED_VERSION', 400, 'Phiên bản expectedVersion không hợp lệ.');
  }
  return Number(trimmed);
}
const value = (row, key) => typeof row?.get === 'function' ? row.get(key) : row?.[key];
async function resolveNativeActor(db, user, options = {}) {
  const id = value(user, 'id');
  if (id == null || !/^[1-9]\d*$/.test(String(id))) throw failure('NATIVE_LOGIN_REQUIRED', 401);
  const rows = await db.getRepository('latticeEmployees').find({...options,filter:{userId:id},limit:2});
  if (rows.length > 1) throw failure('NATIVE_MEMBERSHIP_AMBIGUOUS');
  const employee = rows[0];
  if (!employee || value(employee,'active') !== true) throw failure('NATIVE_MEMBERSHIP_REQUIRED');
  const organizationId = value(employee,'organizationId');
  if (typeof organizationId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(organizationId)) throw failure('NATIVE_MEMBERSHIP_INVALID');
  return {userId:String(id),employeeId:value(employee,'id'),organizationId,departmentId:value(employee,'departmentId')};
}
const CUSTOM_COLLECTION_RE = /^latticeCustom[A-Z][A-Za-z0-9]{1,40}$/;
const IMMUTABLE_VOUCHER_STATUSES = new Set(['submitted', 'approved', 'completed', 'cancelled']);
const SENSITIVE_FILTER_KEY_RE = /password|secret|token|apikey|api_key|identitySubject|privateKey|hash|salt/i;
const SENSITIVE_CHART_COLLECTIONS = new Set([
  'users', 'roles', 'dataSourcesRoles', 'dataSourcesRolesResources',
  'authenticators', 'applicationTokens', 'apiKeys', 'sessions',
  'latticeAiAuditLogs', 'latticeAiProfiles', 'latticeAiApprovalQueue',
]);
function clampPageLimit(limit) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n < 1) return 20;
  return Math.min(200, Math.floor(n));
}
function assertSafeSort(sort) {
  if (sort == null) return;
  const items = Array.isArray(sort) ? sort : String(sort).split(',');
  for (const item of items) {
    const clean = String(item || '').trim().replace(/^-/, '');
    if (!clean) continue;
    if (clean.includes('.') || SENSITIVE_FILTER_KEY_RE.test(clean)) {
      throw failure('NATIVE_RELATION_EXPANSION_UNSUPPORTED');
    }
  }
}
const SELF_ACTOR_FILTER_FIELDS = Object.freeze({
  'requester.userId': 'requesterId',
  'assignee.userId': 'assigneeId',
});
function appendConflictSafeFilter(out, fieldName, filterValue) {
  if (!Object.hasOwn(out, fieldName)) {
    out[fieldName] = filterValue;
    return;
  }
  if (out.$and !== undefined && !Array.isArray(out.$and)) {
    throw failure('NATIVE_RELATION_EXPANSION_UNSUPPORTED');
  }
  out.$and = Array.isArray(out.$and)
    ? [...out.$and, { [fieldName]: filterValue }]
    : [{ [fieldName]: filterValue }];
}
function isSelfUserIdEquality(entry, actorUserId) {
  if (actorUserId == null) return false;
  const expected = String(actorUserId);
  if (typeof entry === 'string' || typeof entry === 'number') {
    return String(entry) === expected;
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const keys = Object.keys(entry);
  if (keys.length !== 1 || !Object.hasOwn(entry, '$eq')) return false;
  const val = entry.$eq;
  return (typeof val === 'string' || typeof val === 'number') && String(val) === expected;
}
function sanitizeSafeFilter(node, options = {}, depth = 0) {
  if (node == null) return node;
  if (depth > 20) throw failure('NATIVE_RELATION_EXPANSION_UNSUPPORTED');
  let target = node;
  if (typeof target === 'string') {
    const trimmed = target.trim();
    if (!trimmed) return node;
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { target = JSON.parse(trimmed); } catch { throw failure('NATIVE_RELATION_EXPANSION_UNSUPPORTED'); }
    } else {
      return node;
    }
  }
  if (Array.isArray(target)) {
    return target.map((item) => sanitizeSafeFilter(item, options, depth + 1));
  }
  if (typeof target !== 'object') return target;
  const out = {};
  const allowRequester = Boolean(options.allowSelfActorFilters || options.allowSelfRequesterUserId);
  const allowAssignee = Boolean(options.allowSelfActorFilters);
  const rewrittenFields = [];
  for (const [key, entry] of Object.entries(target)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw failure('NATIVE_RELATION_EXPANSION_UNSUPPORTED');
    }
    if (key === '$where' || key === '$raw' || key === '$sql') {
      throw failure('NATIVE_RELATION_EXPANSION_UNSUPPORTED');
    }
    if (!key.startsWith('$')) {
      const mappedField = SELF_ACTOR_FILTER_FIELDS[key];
      const selfFieldAllowed = (mappedField === 'requesterId' && allowRequester)
        || (mappedField === 'assigneeId' && allowAssignee);
      if (
        selfFieldAllowed
        && options.actor?.userId != null
        && options.actor?.employeeId != null
        && isSelfUserIdEquality(entry, options.actor.userId)
      ) {
        rewrittenFields.push(mappedField);
        continue;
      }
      if (key.includes('.') || SENSITIVE_FILTER_KEY_RE.test(key)) {
        throw failure('NATIVE_RELATION_EXPANSION_UNSUPPORTED');
      }
    }
    out[key] = sanitizeSafeFilter(entry, options, depth + 1);
  }
  for (const fieldName of rewrittenFields) {
    appendConflictSafeFilter(out, fieldName, { $eq: options.actor.employeeId });
  }
  return out;
}
function scopeNativeRead(params, actor) {
  if (!actor?.organizationId) throw failure('NATIVE_MEMBERSHIP_REQUIRED');
  const next = {...params, filter: {$and:[{organizationId:actor.organizationId},params?.filter ?? {}]}};
  if (next.pageSize != null) next.pageSize = clampPageLimit(next.pageSize);
  if (next.limit != null) next.limit = clampPageLimit(next.limit);
  return next;
}
function scopeNativeValues(values, actor) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw failure('NATIVE_VALUES_INVALID',400);
  if (!actor?.organizationId) throw failure('NATIVE_MEMBERSHIP_REQUIRED');
  for (const [key, entry] of Object.entries(values)) {
    if (['id','userId','identitySubject'].includes(key) || (entry !== null && typeof entry === 'object')) throw failure('NATIVE_PROTECTED_FIELD');
  }
  if (values.organizationId !== undefined && values.organizationId !== actor.organizationId) throw failure('NATIVE_ORGANIZATION_MISMATCH');
  return {...values,organizationId:actor.organizationId};
}
async function recordChatterSafe(db, ctx, actor, id, beforeSnapshot, updatedSnapshot) {
  if (!beforeSnapshot || !updatedSnapshot) return;
  try {
    const { recordFieldDiffChatter } = require('./record-chatter');
    await recordFieldDiffChatter(db, {
      organizationId: actor.organizationId,
      targetCollection: ctx.action.resourceName,
      targetRecordId: Number(id),
      before: beforeSnapshot,
      after: updatedSnapshot,
      actor: {
        ...actor,
        username: value(ctx.state?.currentUser, 'username') || (actor.employeeId ? `employee-${actor.employeeId}` : 'operator'),
      },
    });
  } catch {}
}

async function updateScopedDocument(db, ctx, actor, options = {}) {
  const params = ctx.action.params, id = params.filterByTk;
  if (!/^[1-9]\d*$/.test(String(id))) throw failure('NATIVE_DOCUMENT_ID_REQUIRED', 400);
  const expectedVersion = ctx.state?.latticeExpectedVersion ?? extractExpectedVersion(ctx, params);
  let beforeSnapshot = null;
  let updatedSnapshot = null;

  const applyInTx = async (transaction) => {
    const row = await db.getModel(ctx.action.resourceName).findOne({
      where: { id, organizationId: actor.organizationId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!row) throw failure('NATIVE_DOCUMENT_NOT_FOUND', 404);
    const currentStatus = String(value(row, 'status') || 'draft').toLowerCase();
    if (IMMUTABLE_VOUCHER_STATUSES.has(currentStatus)) {
      throw failure('VOUCHER_IMMUTABLE', 409, 'Chứng từ đã trình duyệt, hoàn tất hoặc đã hủy là bất biến. Vui lòng Hủy (Cancel) và Lập bản điều chỉnh (Amend).');
    }
    beforeSnapshot = typeof row.toJSON === 'function' ? row.toJSON() : { ...row };
    const currentVersion = Number(value(row, 'version')) || 1;
    if (expectedVersion !== null && currentVersion !== expectedVersion) {
      throw failure('VERSION_CONFLICT', 409, 'Bản ghi đã được người khác cập nhật (xung đột phiên bản). Vui lòng tải lại.');
    }
    const nextValues = { ...(params.values || {}), version: currentVersion + 1 };
    const nextWhitelist = Array.isArray(params.whitelist) && !params.whitelist.includes('version')
      ? [...params.whitelist, 'version']
      : params.whitelist;
    // Keep the post-ACL filter and field guards; repository hooks still run.
    ctx.body = await db.getRepository(ctx.action.resourceName).update({
      filterByTk: id,
      filter: params.filter,
      values: nextValues,
      whitelist: nextWhitelist,
      blacklist: params.blacklist,
      transaction,
      context: ctx,
    });
    if (Array.isArray(ctx.body) && !ctx.body.length) throw failure('NATIVE_DOCUMENT_UPDATE_DENIED', 403);
    const updatedRow = Array.isArray(ctx.body) ? ctx.body[0] : ctx.body;
    updatedSnapshot = typeof updatedRow?.toJSON === 'function' ? updatedRow.toJSON() : { ...beforeSnapshot, ...nextValues };
    ctx.status = 200;
  };

  if (options.transaction) {
    await applyInTx(options.transaction);
  } else {
    await db.sequelize.transaction(async (transaction) => {
      if (process.env.DX_PG_RLS_SESSION === 'true') {
        await setTransactionRlsOrg(db, actor.organizationId, transaction);
      }
      await applyInTx(transaction);
    });
  }

  if (options.deferChatter) {
    return () => recordChatterSafe(db, ctx, actor, id, beforeSnapshot, updatedSnapshot);
  }
  await recordChatterSafe(db, ctx, actor, id, beforeSnapshot, updatedSnapshot);
  return undefined;
}
const directoryReferenceErrors = new Map([
  ['lattice_assets_department_org', 'Phòng ban phải thuộc cùng tổ chức với tài sản.'],
  ['lattice_assets_custodian_org', 'Người phụ trách phải thuộc cùng tổ chức với tài sản.'],
  ['lattice_employees_department_org', 'Phòng ban phải thuộc cùng tổ chức với nhân viên.'],
]);

async function writeDirectoryRecord(ctx, next) {
  try {
    return await next();
  } catch (error) {
    const message = directoryReferenceErrors.get(error.original?.constraint);
    if (message) ctx.throw(409, message);
    throw error;
  }
}
function createNativeScopeMiddleware(db, definitions) {
  installRlsTransactionBridge(db);
  const schemas = new Map(Object.values(definitions).map(schema=>[schema.name,schema]));
  const read = new Set(['list','get','count']);
  const write = new Set(['create','update','destroy']);
  const isScopedCollection = (name) => schemas.has(name) || CUSTOM_COLLECTION_RE.test(String(name || ''));
  return async function nativeScope(ctx,next) {
    const {resourceName,actionName,params} = ctx.action;
    // The host chart action reads the repository directly. Keep its ACL and
    // add the same organization restriction as the collection actions.
    if (resourceName === 'charts' && actionName === 'queryData' && ctx.state.currentRole !== 'root') {
      const values = params.values || {};
      if (values.mode !== 'builder') throw failure('NATIVE_CHART_MODE_UNSUPPORTED');
      const col = String(values.collection || '');
      if (!col || SENSITIVE_CHART_COLLECTIONS.has(col) || (!isScopedCollection(col) && !col.startsWith('lattice') && col !== 'workflowManualTasks')) {
        throw failure('NATIVE_CHART_COLLECTION_FORBIDDEN');
      }
      if (isScopedCollection(col)) {
        const actor = await resolveNativeActor(db, ctx.state.currentUser);
        const allowSelfActorFilters = ['latticeRequests', 'latticeOrders'].includes(col);
        const nextValues = values.filter !== undefined
          ? { ...values, filter: sanitizeSafeFilter(values.filter, { allowSelfActorFilters, actor }) }
          : values;
        assertSafeSort(values.sort);
        ctx.state = ctx.state || {};
        ctx.state.latticeRlsOrg = actor.organizationId;
        params.values = scopeNativeRead(nextValues, actor);
        if (process.env.DX_PG_RLS_SESSION === 'true' && typeof db?.sequelize?.transaction === 'function') {
          return withTenantRlsContext(db, actor.organizationId, (transaction) => {
            setContextRlsTransaction(ctx, transaction);
            return next();
          });
        }
      } else {
        if (values.filter !== undefined) values.filter = sanitizeSafeFilter(values.filter);
        assertSafeSort(values.sort);
        if (values.pageSize != null) values.pageSize = clampPageLimit(values.pageSize);
        if (values.limit != null) values.limit = clampPageLimit(values.limit);
      }
      return next();
    }
    const collectionName = resourceName?.split('.')[0];
    if (!isScopedCollection(collectionName)) return next();
    const proceed = ['latticeAssets', 'latticeEmployees', 'latticeDepartments'].includes(resourceName) && write.has(actionName)
      ? () => writeDirectoryRecord(ctx, next)
      : next;
    // Root is the verified host configuration role, not a body/header flag.
    if (ctx.state.currentRole === 'root') return proceed();
    const actor = await resolveNativeActor(db,ctx.state.currentUser);
    if (resourceName !== collectionName) throw failure('NATIVE_ASSOCIATION_ACTION_UNSUPPORTED');
    if (!read.has(actionName) && !write.has(actionName)) throw failure('NATIVE_ACTION_UNSUPPORTED');
    const expanded = params.appends;
    const fields = params.fields == null ? [] : Array.isArray(params.fields) ? params.fields : String(params.fields).split(',');
    if (params.targetCollection || (expanded && (!Array.isArray(expanded) || expanded.length)) || fields.some(field=>typeof field !== 'string' || field.includes('.'))) {
      throw failure('NATIVE_RELATION_EXPANSION_UNSUPPORTED');
    }
    const document=['latticeRequests','latticeOrders'].includes(collectionName);
    if (params.filter !== undefined) {
      params.filter = sanitizeSafeFilter(params.filter, { allowSelfActorFilters: document, actor });
    }
    assertSafeSort(params.sort);
    if (write.has(actionName) && collectionName === 'latticeEmployees') throw failure('NATIVE_IDENTITY_ADMIN_REQUIRED');
    if (write.has(actionName) && collectionName === 'latticeIncidentCases') throw failure('NATIVE_INCIDENT_WORKFLOW_REQUIRED');
    const scopedRead = scopeNativeRead(params,actor);
    params.filter = scopedRead.filter;
    if (scopedRead.pageSize != null) params.pageSize = scopedRead.pageSize;
    if (scopedRead.limit != null) params.limit = scopedRead.limit;
    if(document) {
      if(actionName==='destroy')throw failure('NATIVE_DOCUMENT_DELETE_UNSUPPORTED');
    }
    let expectedVersion = null;
    if (actionName === 'create' || actionName === 'update') {
      expectedVersion = actionName === 'update' ? extractExpectedVersion(ctx, params) : null;
      ctx.state = ctx.state || {};
      ctx.state.latticeExpectedVersion = expectedVersion;
      params.values = scopeNativeValues(params.values, actor);
      if (document) {
        if (['status','version','requesterId','assigneeId','decisionReason','submittedAt','submittedBy','cancelledAt','cancelledBy','cancelReason','amendedFromId','amendmentNo'].some(field => Object.hasOwn(params.values, field))) {
          throw failure('NATIVE_DOCUMENT_PROTECTED_FIELD');
        }
        if (actionName === 'create') {
          if (typeof params.values.name !== 'string' || !params.values.name.trim() || params.values.name.length > 200) throw failure('NATIVE_DOCUMENT_NAME_REQUIRED', 400);
          params.values = { ...params.values, name: params.values.name.trim(), status: 'draft', version: 1, requesterId: actor.employeeId };
          if (params.values.departmentId == null && actor.departmentId != null) params.values.departmentId = actor.departmentId;
        }
      }
    }

    const executeScoped = async (transaction) => {
      if (actionName === 'create' || actionName === 'update') {
        const txOpt = transaction ? { transaction } : {};
        if (actionName === 'update' && collectionName === 'latticeAssets' && params.filterByTk != null) {
          const assetRepo = db.getRepository?.('latticeAssets');
          if (assetRepo?.findOne) {
            const current = await assetRepo.findOne({ filter: { id: params.filterByTk, organizationId: actor.organizationId }, ...txOpt });
            if (!current) throw failure('NATIVE_DOCUMENT_NOT_FOUND', 404);
            const currentVersion = Number(value(current, 'version')) || 1;
            if (expectedVersion !== null && currentVersion !== expectedVersion) {
              throw failure('VERSION_CONFLICT', 409, 'Bản ghi đã được người khác cập nhật (xung đột phiên bản). Vui lòng tải lại.');
            }
            params.values = { ...params.values, version: currentVersion + 1 };
          }
        }
        for (const field of schemas.get(collectionName)?.fields || []) {
          if (field.type !== 'belongsTo' || !schemas.has(field.target)) continue;
          const id = params.values[field.foreignKey];
          if (id == null) continue;
          if (!/^[1-9]\d*$/.test(String(id))) throw failure('NATIVE_REFERENCE_INVALID', 400);
          const reference = await db.getRepository(field.target).findOne({ filter: { id, organizationId: actor.organizationId, active: true }, ...txOpt });
          if (!reference) throw failure('NATIVE_REFERENCE_UNAVAILABLE');
        }
      }
      ctx.state = ctx.state || {};
      ctx.state.latticeNativeActor = actor;
      ctx.state.latticeRlsOrg = actor.organizationId;
      if (transaction) setContextRlsTransaction(ctx, transaction);
      if (document && actionName === 'update') {
        return updateScopedDocument(db, ctx, actor, transaction ? { transaction, deferChatter: true } : {});
      }
      return proceed();
    };

    if (process.env.DX_PG_RLS_SESSION === 'true' && typeof db?.sequelize?.transaction === 'function') {
      const result = await withTenantRlsContext(db, actor.organizationId, (transaction) => executeScoped(transaction));
      if (typeof result === 'function') {
        try {
          await withTenantRlsContext(db, actor.organizationId, () => result());
        } catch {}
      }
      return result;
    }
    return executeScoped(null);
  };
}
module.exports = {resolveNativeActor, scopeNativeRead, scopeNativeValues,createNativeScopeMiddleware,updateScopedDocument,extractExpectedVersion};
