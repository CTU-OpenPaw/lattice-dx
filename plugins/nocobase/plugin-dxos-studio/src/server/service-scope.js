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

function loadPgRls() {
  const inDist = __dirname.includes(`${path.sep}dist${path.sep}`);
  const candidates = inDist
    ? [
        '@latticedx/plugin-lattice-foundation/dist/server/pg-rls',
        '@latticedx/plugin-lattice-foundation/src/server/pg-rls',
        '../../../plugin-lattice-foundation/dist/server/pg-rls',
        '../../../plugin-lattice-foundation/src/server/pg-rls',
      ]
    : [
        '@latticedx/plugin-lattice-foundation/src/server/pg-rls',
        '../../../plugin-lattice-foundation/src/server/pg-rls',
        '@latticedx/plugin-lattice-foundation/dist/server/pg-rls',
        '../../../plugin-lattice-foundation/dist/server/pg-rls',
      ];
  for (const modPath of candidates) {
    try {
      const mod = require(modPath);
      if (mod && typeof mod.withTenantRlsContext === 'function') return mod;
    } catch (err) {
      const isDirectMissing = err?.code === 'MODULE_NOT_FOUND'
        && (!Array.isArray(err.requireStack) || err.requireStack.length === 0 || err.requireStack[0] === __filename);
      if (!isDirectMissing) throw err;
    }
  }
  return null;
}

const pgRls = loadPgRls();
const withTenantRlsContext = pgRls?.withTenantRlsContext || null;
const withSystemRlsBypass = pgRls?.withSystemRlsBypass || null;
const installRlsTransactionBridge = pgRls?.installRlsTransactionBridge || null;
const setContextRlsTransaction = pgRls?.setContextRlsTransaction || ((ctx, transaction) => {
  if (!ctx || !transaction) return;
  ctx.state = ctx.state || {};
  Object.defineProperty(ctx.state, 'latticeRlsTransaction', {
    value: transaction,
    writable: true,
    configurable: true,
    enumerable: false,
  });
});

function failure(code, status = 403, message = code) {
  return Object.assign(new Error(message), { code, status });
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

const val = (row, key) => (typeof row?.get === 'function' ? row.get(key) : row?.[key]);

const IMMUTABLE_VOUCHER_STATUSES = new Set(['submitted', 'approved', 'completed', 'cancelled']);
const PROTECTED_DOCUMENT_FIELDS = new Set([
  'status',
  'version',
  'requesterId',
  'assigneeId',
  'resolutionNote',
  'decisionReason',
  'submittedAt',
  'submittedBy',
  'cancelledAt',
  'cancelledBy',
  'cancelReason',
  'amendedFromId',
  'amendmentNo',
]);
const SENSITIVE_FILTER_KEY_RE = /password|secret|token|apikey|api_key|identitySubject|privateKey|hash|salt/i;

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
  const value = entry.$eq;
  return (typeof value === 'string' || typeof value === 'number') && String(value) === expected;
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
      if (
        mappedField
        && options.allowSelfActorFilters
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

async function resolveServiceActor(db, user, options = {}) {
  const id = val(user, 'id');
  if (id == null || !/^[1-9]\d*$/.test(String(id))) throw failure('NATIVE_LOGIN_REQUIRED', 401);
  const empRepo = db?.getRepository?.('latticeEmployees');
  if (!empRepo || typeof empRepo.find !== 'function') throw failure('NATIVE_MEMBERSHIP_REQUIRED');
  const rows = (await empRepo.find({ filter: { userId: id }, limit: 2, ...(options.transaction ? { transaction: options.transaction } : {}) })) || [];
  if (rows.length > 1) throw failure('NATIVE_MEMBERSHIP_AMBIGUOUS');
  const emp = rows[0];
  if (!emp || val(emp, 'active') !== true) throw failure('NATIVE_MEMBERSHIP_REQUIRED');
  const organizationId = val(emp, 'organizationId');
  if (typeof organizationId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(organizationId)) {
    throw failure('NATIVE_MEMBERSHIP_INVALID');
  }
  return { userId: String(id), employeeId: val(emp, 'id'), organizationId, departmentId: val(emp, 'departmentId') };
}

function createServiceScopeMiddleware(db) {
  if (typeof installRlsTransactionBridge === 'function') {
    installRlsTransactionBridge(db);
  }
  const readActions = new Set(['list', 'get', 'count']);
  const writeActions = new Set(['create', 'update', 'destroy']);

  return async function serviceScopeMiddleware(ctx, next) {
    const { resourceName, actionName } = ctx.action || {};
    const params = ctx.action?.params || (ctx.action ? (ctx.action.params = {}) : {});
    if (resourceName === 'charts' && actionName === 'queryData' && params?.values?.collection === 'latticeServiceTickets') {
      if (ctx.state?.currentRole === 'root') {
        if (process.env.DX_PG_RLS_SESSION === 'true' && typeof db?.sequelize?.transaction === 'function' && typeof withSystemRlsBypass === 'function') {
          return withSystemRlsBypass(db, (transaction) => {
            setContextRlsTransaction(ctx, transaction);
            return next();
          });
        }
        return next();
      }
      if (params.values.mode !== 'builder') throw failure('NATIVE_CHART_MODE_UNSUPPORTED');
      const actor = await resolveServiceActor(db, ctx.state?.currentUser);
      const sanitizedFilter = params.values.filter !== undefined
        ? sanitizeSafeFilter(params.values.filter, { allowSelfActorFilters: true, actor })
        : params.values.filter;
      assertSafeSort(params.values.sort);
      params.values = { ...params.values, filter: { $and: [{ organizationId: actor.organizationId }, sanitizedFilter ?? {}] } };
      if (params.values.pageSize != null) params.values.pageSize = clampPageLimit(params.values.pageSize);
      if (params.values.limit != null) params.values.limit = clampPageLimit(params.values.limit);
      ctx.state = ctx.state || {};
      ctx.state.latticeNativeActor = actor;
      ctx.state.latticeRlsOrg = actor.organizationId;
      if (process.env.DX_PG_RLS_SESSION === 'true' && typeof db?.sequelize?.transaction === 'function' && typeof withTenantRlsContext === 'function') {
        return withTenantRlsContext(db, actor.organizationId, (transaction) => {
          setContextRlsTransaction(ctx, transaction);
          return next();
        });
      }
      return next();
    }

    const collectionName = resourceName?.split('.')[0];
    if (collectionName !== 'latticeServiceTickets') return next();
    if (ctx.state?.currentRole === 'root') {
      if (process.env.DX_PG_RLS_SESSION === 'true' && typeof db?.sequelize?.transaction === 'function' && typeof withSystemRlsBypass === 'function') {
        return withSystemRlsBypass(db, (transaction) => {
          setContextRlsTransaction(ctx, transaction);
          return next();
        });
      }
      return next();
    }

    const actor = await resolveServiceActor(db, ctx.state?.currentUser);
    if (resourceName !== 'latticeServiceTickets') throw failure('NATIVE_ASSOCIATION_ACTION_UNSUPPORTED');
    if (!readActions.has(actionName) && !writeActions.has(actionName)) throw failure('NATIVE_ACTION_UNSUPPORTED');
    if (actionName === 'destroy') throw failure('NATIVE_DOCUMENT_DELETE_UNSUPPORTED');

    const fields = params?.fields == null ? [] : Array.isArray(params.fields) ? params.fields : String(params.fields).split(',');
    if (params?.targetCollection || (params?.appends && (!Array.isArray(params.appends) || params.appends.length)) || fields.some((f) => typeof f !== 'string' || f.includes('.'))) {
      throw failure('NATIVE_RELATION_EXPANSION_UNSUPPORTED');
    }
    const sanitizedFilter = params?.filter !== undefined
      ? sanitizeSafeFilter(params.filter, { allowSelfActorFilters: true, actor })
      : params?.filter;
    assertSafeSort(params?.sort);

    params.filter = { $and: [{ organizationId: actor.organizationId }, sanitizedFilter ?? {}] };
    if (params?.pageSize != null) params.pageSize = clampPageLimit(params.pageSize);
    if (params?.limit != null) params.limit = clampPageLimit(params.limit);

    const expectedVersion = actionName === 'update' ? extractExpectedVersion(ctx, params) : null;

    const executeScoped = async (transaction) => {
      const txOpt = transaction ? { transaction } : {};
      if (actionName === 'create' || actionName === 'update') {
        let bumpedVersion = null;
        if (actionName === 'update') {
          if (params?.filterByTk == null || !/^[1-9]\d*$/.test(String(params.filterByTk))) {
            throw failure('SERVICE_TICKET_ID_REQUIRED', 400, 'Cần mã id phiếu dịch vụ hợp lệ.');
          }
          const ticketRepo = db.getRepository?.('latticeServiceTickets');
          if (ticketRepo?.findOne) {
            const existing = await ticketRepo.findOne({ filter: { id: params.filterByTk, organizationId: actor.organizationId }, ...txOpt });
            if (!existing) throw failure('SERVICE_TICKET_NOT_FOUND', 404);
            const currentStatus = String(val(existing, 'status') || '').trim().toLowerCase();
            if (IMMUTABLE_VOUCHER_STATUSES.has(currentStatus)) {
              throw failure(
                'VOUCHER_IMMUTABLE',
                409,
                'Chứng từ đã trình duyệt, hoàn tất hoặc đã hủy là bất biến. Vui lòng Hủy (Cancel) và Lập bản điều chỉnh (Amend).',
              );
            }
            const currentVersion = Number(val(existing, 'version')) || 1;
            if (expectedVersion !== null && currentVersion !== expectedVersion) {
              throw failure('VERSION_CONFLICT', 409, 'Phiếu dịch vụ đã được người khác cập nhật (xung đột phiên bản). Vui lòng tải lại.');
            }
            bumpedVersion = currentVersion + 1;
          }
        }
        const values = params?.values;
        if (!values || typeof values !== 'object' || Array.isArray(values)) throw failure('NATIVE_VALUES_INVALID', 400);
        for (const [k, v] of Object.entries(values)) {
          if (['id', 'userId', 'identitySubject'].includes(k) || (v !== null && typeof v === 'object')) {
            throw failure('NATIVE_PROTECTED_FIELD');
          }
          if (PROTECTED_DOCUMENT_FIELDS.has(k)) {
            throw failure('NATIVE_DOCUMENT_PROTECTED_FIELD');
          }
        }
        if (values.organizationId !== undefined && values.organizationId !== actor.organizationId) {
          throw failure('NATIVE_ORGANIZATION_MISMATCH');
        }
        const nextValues = { ...values, organizationId: actor.organizationId };
        if (actionName === 'update' && bumpedVersion !== null) {
          nextValues.version = bumpedVersion;
          if (Array.isArray(params.whitelist) && !params.whitelist.includes('version')) {
            params.whitelist = [...params.whitelist, 'version'];
          }
        }
        if (actionName === 'create') {
          if (typeof values.name !== 'string' || !values.name.trim() || values.name.length > 200) {
            throw failure('NATIVE_DOCUMENT_NAME_REQUIRED', 400);
          }
          nextValues.name = values.name.trim();
          nextValues.status = 'draft';
          nextValues.version = 1;
          nextValues.requesterId = actor.employeeId;
          if (nextValues.departmentId == null && actor.departmentId != null) {
            nextValues.departmentId = actor.departmentId;
          }
        }
        if (nextValues.departmentId != null) {
          if (!/^[1-9]\d*$/.test(String(nextValues.departmentId))) throw failure('NATIVE_REFERENCE_INVALID', 400);
          const dept = await db.getRepository('latticeDepartments')?.findOne({
            filter: { id: nextValues.departmentId, organizationId: actor.organizationId, active: true },
            ...txOpt,
          });
          if (!dept) throw failure('NATIVE_REFERENCE_UNAVAILABLE');
        }
        params.values = nextValues;
      }

      ctx.state = ctx.state || {};
      ctx.state.latticeNativeActor = actor;
      ctx.state.latticeRlsOrg = actor.organizationId;
      if (transaction) setContextRlsTransaction(ctx, transaction);
      return next();
    };

    if (process.env.DX_PG_RLS_SESSION === 'true' && typeof db?.sequelize?.transaction === 'function' && typeof withTenantRlsContext === 'function') {
      return withTenantRlsContext(db, actor.organizationId, (transaction) => executeScoped(transaction));
    }
    return executeScoped(null);
  };
}

module.exports = { resolveServiceActor, createServiceScopeMiddleware };
