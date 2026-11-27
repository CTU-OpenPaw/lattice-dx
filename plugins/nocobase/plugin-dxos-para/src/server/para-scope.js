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
const canUsePgRlsSession = pgRls?.canUsePgRlsSession || null;
const getActiveRlsContext = pgRls?.getActiveRlsContext || null;
const setTransactionRlsBypass = pgRls?.setTransactionRlsBypass || null;
const runInRlsSavepoint = pgRls?.runInRlsSavepoint || null;
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

function shouldUseParaPgRls(db) {
  if (typeof canUsePgRlsSession === 'function') {
    return canUsePgRlsSession(db);
  }
  return process.env.DX_PG_RLS_SESSION === 'true' && typeof db?.sequelize?.transaction === 'function';
}

async function runParaRlsOp(db, organizationId, fn) {
  if (typeof fn !== 'function') {
    throw new TypeError('runParaRlsOp requires a callback function.');
  }
  if (!shouldUseParaPgRls(db)) {
    return fn(undefined);
  }
  const active = typeof getActiveRlsContext === 'function' ? getActiveRlsContext() : null;
  if (active?.transaction && active.sequelize === db?.sequelize) {
    if (active.systemRlsBypass === true || (organizationId && active.organizationId === organizationId)) {
      return fn(active.transaction);
    }
  }
  if (organizationId && typeof withTenantRlsContext === 'function') {
    return withTenantRlsContext(db, String(organizationId), (transaction) => fn(transaction));
  }
  if (typeof withSystemRlsBypass === 'function') {
    return withSystemRlsBypass(db, (transaction) => fn(transaction));
  }
  return fn(undefined);
}

async function runParaSavepoint(db, fn) {
  if (typeof runInRlsSavepoint === 'function') {
    return runInRlsSavepoint(db, fn);
  }
  const active = typeof getActiveRlsContext === 'function' ? getActiveRlsContext() : null;
  return fn(active?.transaction || null);
}

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

const PARA_RESPONSE_REDACT_ACTIONS = new Set(['get', 'list', 'create', 'update']);

function getRedactParaPiiFn() {
  // Lazy-require to avoid circular dependency with para-hybrid-search.js (which imports runParaRlsOp from para-scope.js)
  return require('./para-hybrid-search').redactParaPii;
}

function redactParaRecordSummary(record, redactFn) {
  if (!record || typeof record !== 'object') return record;
  const rawSummary = typeof record.get === 'function' ? record.get('summary') : record.summary;
  if (typeof rawSummary !== 'string') return record;
  const redacted = redactFn(rawSummary);
  if (redacted === rawSummary) return record;
  if (typeof record.setDataValue === 'function') {
    record.setDataValue('summary', redacted);
    if (typeof record.get !== 'function' || record.get('summary') === redacted) return record;
  }
  if (typeof record.set === 'function') {
    record.set('summary', redacted);
    if (typeof record.get !== 'function' || record.get('summary') === redacted) return record;
  }
  if (typeof record.toJSON === 'function') {
    const plain = record.toJSON();
    if (plain && typeof plain === 'object') {
      plain.summary = redacted;
      return plain;
    }
  }
  record.summary = redacted;
  return record;
}

function redactParaDocumentBody(ctx) {
  const body = ctx?.body;
  if (!body || typeof body !== 'object') return;
  const redactFn = getRedactParaPiiFn();
  if (typeof redactFn !== 'function') return;

  if (Array.isArray(body)) {
    for (let i = 0; i < body.length; i += 1) {
      body[i] = redactParaRecordSummary(body[i], redactFn);
    }
    return;
  }
  if (Array.isArray(body.rows)) {
    for (let i = 0; i < body.rows.length; i += 1) {
      body.rows[i] = redactParaRecordSummary(body.rows[i], redactFn);
    }
    return;
  }
  if (Array.isArray(body.items)) {
    for (let i = 0; i < body.items.length; i += 1) {
      body.items[i] = redactParaRecordSummary(body.items[i], redactFn);
    }
    return;
  }
  if (body.data !== undefined && body.data !== null && typeof body.data === 'object') {
    if (Array.isArray(body.data)) {
      for (let i = 0; i < body.data.length; i += 1) {
        body.data[i] = redactParaRecordSummary(body.data[i], redactFn);
      }
      return;
    }
    if (Array.isArray(body.data.rows)) {
      for (let i = 0; i < body.data.rows.length; i += 1) {
        body.data.rows[i] = redactParaRecordSummary(body.data.rows[i], redactFn);
      }
      return;
    }
    body.data = redactParaRecordSummary(body.data, redactFn);
    return;
  }
  ctx.body = redactParaRecordSummary(body, redactFn);
}

const SENSITIVE_FILTER_KEY_RE = /password|secret|token|apikey|api_key|identitySubject|privateKey|hash|salt/i;
const MANAGER_OR_ADMIN_ROLES = new Set(['root', 'ldx_admin', 'ldx_manager']);

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
  'owner.userId': 'ownerId',
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
  const allowOwner = Boolean(options.allowSelfOwnerUserId || options.allowSelfActorFilters);
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
        && allowOwner
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

async function resolveParaActor(db, user, options = {}) {
  const id = val(user, 'id');
  if (id == null || !/^[1-9]\d*$/.test(String(id))) throw failure('NATIVE_LOGIN_REQUIRED', 401);
  const empRepo = db?.getRepository?.('latticeEmployees');
  if (!empRepo || typeof empRepo.find !== 'function') throw failure('NATIVE_MEMBERSHIP_REQUIRED');
  const findEmployee = (findOptions) => empRepo.find({ ...findOptions, filter: { userId: id }, limit: 2 });
  const useRls = shouldUseParaPgRls(db);
  const activeCtx = typeof getActiveRlsContext === 'function' ? getActiveRlsContext() : null;
  let rows;
  if (!options.transaction && (!activeCtx?.transaction || activeCtx.systemRlsBypass !== true) && useRls && typeof withSystemRlsBypass === 'function') {
    rows = (await withSystemRlsBypass(db, (transaction) => findEmployee({ ...options, transaction }))) || [];
  } else if (options.transaction && !activeCtx?.transaction && useRls && typeof setTransactionRlsBypass === 'function') {
    const prevRaw = await db.sequelize.query("SELECT current_setting('app.rls_bypass', true) AS prev", {
      transaction: options.transaction,
    });
    const prevBypass = prevRaw?.[0]?.[0]?.prev ?? '';
    if (prevBypass !== 'on') {
      await setTransactionRlsBypass(db, options.transaction);
    }
    try {
      rows = (await findEmployee(options)) || [];
    } finally {
      if (prevBypass !== 'on') {
        await db.sequelize.query("SELECT set_config('app.rls_bypass', :prev, true)", {
          replacements: { prev: prevBypass },
          transaction: options.transaction,
        }).catch(() => {});
      }
    }
  } else if (!options.transaction && activeCtx?.transaction && activeCtx.systemRlsBypass === true) {
    rows = (await findEmployee({ ...options, transaction: activeCtx.transaction })) || [];
  } else {
    rows = (await findEmployee(options)) || [];
  }
  if (rows.length > 1) throw failure('NATIVE_MEMBERSHIP_AMBIGUOUS');
  const employee = rows[0];
  if (!employee || val(employee, 'active') !== true) throw failure('NATIVE_MEMBERSHIP_REQUIRED');
  const organizationId = val(employee, 'organizationId');
  if (typeof organizationId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(organizationId)) {
    throw failure('NATIVE_MEMBERSHIP_INVALID');
  }
  return {
    userId: String(id),
    employeeId: val(employee, 'id'),
    organizationId,
    departmentId: val(employee, 'departmentId'),
  };
}

function createParaScopeMiddleware(db) {
  if (typeof installRlsTransactionBridge === 'function') {
    installRlsTransactionBridge(db);
  }
  const readActions = new Set(['list', 'get', 'count']);
  const writeActions = new Set(['create', 'update', 'destroy']);

  return async function paraScopeMiddleware(ctx, next) {
    const { resourceName, actionName } = ctx.action || {};
    const params = ctx.action?.params || (ctx.action ? (ctx.action.params = {}) : {});
    if (resourceName === 'charts' && actionName === 'queryData' && ctx.state?.currentRole !== 'root') {
      if (params?.values?.collection === 'latticeParaChunks') {
        throw failure('PARA_CHUNKS_READ_ONLY', 403);
      }
      if (params?.values?.collection === 'latticeParaDocuments') {
        if (params.values.mode !== 'builder') throw failure('NATIVE_CHART_MODE_UNSUPPORTED');
        const actor = await resolveParaActor(db, ctx.state?.currentUser);
        const sanitizedFilter = params.values.filter !== undefined
          ? sanitizeSafeFilter(params.values.filter, { allowSelfOwnerUserId: true, actor })
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
    }
    const collectionName = resourceName?.split('.')[0];
    if (collectionName === 'latticeParaChunks') {
      if (ctx.state?.currentRole === 'root') return next();
      throw failure('PARA_CHUNKS_READ_ONLY', 403);
    }
    if (collectionName !== 'latticeParaDocuments') return next();
    if (ctx.state?.currentRole === 'root') {
      const res = await next();
      if (PARA_RESPONSE_REDACT_ACTIONS.has(actionName)) {
        redactParaDocumentBody(ctx);
      }
      return res;
    }

    const actor = await resolveParaActor(db, ctx.state?.currentUser);
    if (resourceName !== 'latticeParaDocuments') throw failure('NATIVE_ASSOCIATION_ACTION_UNSUPPORTED');
    if (!readActions.has(actionName) && !writeActions.has(actionName)) throw failure('NATIVE_ACTION_UNSUPPORTED');

    const fields = params?.fields == null ? [] : Array.isArray(params.fields) ? params.fields : String(params.fields).split(',');
    if (params?.targetCollection || (params?.appends && (!Array.isArray(params.appends) || params.appends.length)) || fields.some((f) => typeof f !== 'string' || f.includes('.'))) {
      throw failure('NATIVE_RELATION_EXPANSION_UNSUPPORTED');
    }
    const sanitizedFilter = params?.filter !== undefined
      ? sanitizeSafeFilter(params.filter, { allowSelfOwnerUserId: true, actor })
      : params?.filter;
    assertSafeSort(params?.sort);

    const activeRole = ctx.state?.currentRole || '';
    const isOwnerOnlyRole = !MANAGER_OR_ADMIN_ROLES.has(activeRole);
    const expectedVersion = actionName === 'update' ? extractExpectedVersion(ctx, params) : null;
    const scopeFilters = [{ organizationId: actor.organizationId }];
    if ((actionName === 'update' || actionName === 'destroy') && isOwnerOnlyRole) {
      scopeFilters.push({ ownerId: actor.employeeId });
    }
    params.filter = { $and: [...scopeFilters, sanitizedFilter ?? {}] };
    if (params?.pageSize != null) params.pageSize = clampPageLimit(params.pageSize);
    if (params?.limit != null) params.limit = clampPageLimit(params.limit);

    const executeScoped = async (transaction) => {
      const txOpt = transaction ? { transaction } : {};
      let bumpedVersion = null;
      if ((actionName === 'update' || actionName === 'destroy') && params?.filterByTk != null) {
        const docRepo = db.getRepository('latticeParaDocuments');
        if (docRepo?.findOne) {
          const existing = await docRepo.findOne({ filter: { id: params.filterByTk, organizationId: actor.organizationId }, ...txOpt });
          if (!existing) throw failure('PARA_DOCUMENT_NOT_FOUND', 404);
          if (isOwnerOnlyRole && Number(val(existing, 'ownerId')) !== Number(actor.employeeId)) {
            throw failure('PARA_OWNER_REQUIRED', 403);
          }
          if (actionName === 'update') {
            const currentVersion = Number(val(existing, 'version')) || 1;
            if (expectedVersion !== null && currentVersion !== expectedVersion) {
              throw failure('VERSION_CONFLICT', 409, 'Tài liệu P.A.R.A. đã được người khác cập nhật (xung đột phiên bản). Vui lòng tải lại.');
            }
            bumpedVersion = currentVersion + 1;
          }
        }
      }

      if (actionName === 'create' || actionName === 'update') {
        const values = params?.values;
        if (!values || typeof values !== 'object' || Array.isArray(values)) throw failure('NATIVE_VALUES_INVALID', 400);
        for (const [k, v] of Object.entries(values)) {
          if (['id', 'userId', 'ownerId', 'identitySubject'].includes(k) || (v !== null && typeof v === 'object')) {
            throw failure('NATIVE_PROTECTED_FIELD');
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
          nextValues.ownerId = actor.employeeId;
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
      const res = await next();
      if (PARA_RESPONSE_REDACT_ACTIONS.has(actionName)) {
        redactParaDocumentBody(ctx);
      }
      return res;
    };

    if (process.env.DX_PG_RLS_SESSION === 'true' && typeof db?.sequelize?.transaction === 'function' && typeof withTenantRlsContext === 'function') {
      return withTenantRlsContext(db, actor.organizationId, (transaction) => executeScoped(transaction));
    }
    return executeScoped(null);
  };
}

module.exports = {
  resolveParaActor,
  createParaScopeMiddleware,
  shouldUseParaPgRls,
  runParaRlsOp,
  runParaSavepoint,
};
