/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

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

function assertSafeFilter(node, depth = 0) {
  if (node == null) return;
  if (depth > 20) throw failure('NATIVE_RELATION_EXPANSION_UNSUPPORTED');
  let target = node;
  if (typeof target === 'string') {
    const trimmed = target.trim();
    if (!trimmed) return;
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { target = JSON.parse(trimmed); } catch { throw failure('NATIVE_RELATION_EXPANSION_UNSUPPORTED'); }
    } else {
      return;
    }
  }
  if (Array.isArray(target)) {
    for (const item of target) assertSafeFilter(item, depth + 1);
    return;
  }
  if (typeof target !== 'object') return;
  for (const [key, entry] of Object.entries(target)) {
    if (key === '$where' || key === '$raw' || key === '$sql') {
      throw failure('NATIVE_RELATION_EXPANSION_UNSUPPORTED');
    }
    if (!key.startsWith('$') && (key.includes('.') || SENSITIVE_FILTER_KEY_RE.test(key))) {
      throw failure('NATIVE_RELATION_EXPANSION_UNSUPPORTED');
    }
    assertSafeFilter(entry, depth + 1);
  }
}

async function resolveServiceActor(db, user) {
  const id = val(user, 'id');
  if (id == null || !/^[1-9]\d*$/.test(String(id))) throw failure('NATIVE_LOGIN_REQUIRED', 401);
  const rows = await db.getRepository('latticeEmployees').find({ filter: { userId: id }, limit: 2 });
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
  const readActions = new Set(['list', 'get', 'count']);
  const writeActions = new Set(['create', 'update', 'destroy']);

  return async function serviceScopeMiddleware(ctx, next) {
    const { resourceName, actionName, params } = ctx.action || {};
    if (resourceName === 'charts' && actionName === 'queryData' && params?.values?.collection === 'latticeServiceTickets' && ctx.state?.currentRole !== 'root') {
      if (params.values.mode !== 'builder') throw failure('NATIVE_CHART_MODE_UNSUPPORTED');
      assertSafeFilter(params.values.filter);
      assertSafeSort(params.values.sort);
      const actor = await resolveServiceActor(db, ctx.state?.currentUser);
      params.values = { ...params.values, filter: { $and: [{ organizationId: actor.organizationId }, params.values.filter ?? {}] } };
      if (params.values.pageSize != null) params.values.pageSize = clampPageLimit(params.values.pageSize);
      if (params.values.limit != null) params.values.limit = clampPageLimit(params.values.limit);
      return next();
    }

    const collectionName = resourceName?.split('.')[0];
    if (collectionName !== 'latticeServiceTickets') return next();
    if (ctx.state?.currentRole === 'root') return next();

    const actor = await resolveServiceActor(db, ctx.state?.currentUser);
    if (resourceName !== 'latticeServiceTickets') throw failure('NATIVE_ASSOCIATION_ACTION_UNSUPPORTED');
    if (!readActions.has(actionName) && !writeActions.has(actionName)) throw failure('NATIVE_ACTION_UNSUPPORTED');
    if (actionName === 'destroy') throw failure('NATIVE_DOCUMENT_DELETE_UNSUPPORTED');

    const fields = params?.fields == null ? [] : Array.isArray(params.fields) ? params.fields : String(params.fields).split(',');
    if (params?.targetCollection || (params?.appends && (!Array.isArray(params.appends) || params.appends.length)) || fields.some((f) => typeof f !== 'string' || f.includes('.'))) {
      throw failure('NATIVE_RELATION_EXPANSION_UNSUPPORTED');
    }
    assertSafeFilter(params?.filter);
    assertSafeSort(params?.sort);

    params.filter = { $and: [{ organizationId: actor.organizationId }, params?.filter ?? {}] };
    if (params?.pageSize != null) params.pageSize = clampPageLimit(params.pageSize);
    if (params?.limit != null) params.limit = clampPageLimit(params.limit);
    if (actionName === 'create' || actionName === 'update') {
      const expectedVersion = actionName === 'update' ? extractExpectedVersion(ctx, params) : null;
      let bumpedVersion = null;
      if (actionName === 'update' && params?.filterByTk != null) {
        const ticketRepo = db.getRepository?.('latticeServiceTickets');
        if (ticketRepo?.findOne) {
          const existing = await ticketRepo.findOne({ filter: { id: params.filterByTk, organizationId: actor.organizationId } });
          if (!existing) throw failure('SERVICE_TICKET_NOT_FOUND', 404);
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
        if (['status', 'version', 'requesterId', 'assigneeId', 'resolutionNote', 'decisionReason'].includes(k)) {
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
        });
        if (!dept) throw failure('NATIVE_REFERENCE_UNAVAILABLE');
      }
      params.values = nextValues;
    }

    ctx.state.latticeNativeActor = actor;
    return next();
  };
}

module.exports = { resolveServiceActor, createServiceScopeMiddleware };
