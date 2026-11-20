/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

function failure(code, status = 403) {
  return Object.assign(new Error(code), { code, status });
}

const val = (row, key) => (typeof row?.get === 'function' ? row.get(key) : row?.[key]);

async function resolveParaActor(db, user, options = {}) {
  const id = val(user, 'id');
  if (id == null || !/^[1-9]\d*$/.test(String(id))) throw failure('NATIVE_LOGIN_REQUIRED', 401);
  const rows = await db.getRepository('latticeEmployees').find({ ...options, filter: { userId: id }, limit: 2 });
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
  const readActions = new Set(['list', 'get', 'count']);
  const writeActions = new Set(['create', 'update', 'destroy']);

  return async function paraScopeMiddleware(ctx, next) {
    const { resourceName, actionName, params } = ctx.action || {};
    if (resourceName === 'charts' && actionName === 'queryData' && params?.values?.collection === 'latticeParaDocuments' && ctx.state?.currentRole !== 'root') {
      if (params.values.mode !== 'builder') throw failure('NATIVE_CHART_MODE_UNSUPPORTED');
      const actor = await resolveParaActor(db, ctx.state?.currentUser);
      params.values = { ...params.values, filter: { $and: [{ organizationId: actor.organizationId }, params.values.filter ?? {}] } };
      return next();
    }
    const collectionName = resourceName?.split('.')[0];
    if (collectionName !== 'latticeParaDocuments') return next();
    if (ctx.state?.currentRole === 'root') return next();

    const actor = await resolveParaActor(db, ctx.state?.currentUser);
    if (resourceName !== 'latticeParaDocuments') throw failure('NATIVE_ASSOCIATION_ACTION_UNSUPPORTED');
    if (!readActions.has(actionName) && !writeActions.has(actionName)) throw failure('NATIVE_ACTION_UNSUPPORTED');

    const fields = params?.fields == null ? [] : Array.isArray(params.fields) ? params.fields : String(params.fields).split(',');
    if (params?.targetCollection || (params?.appends && (!Array.isArray(params.appends) || params.appends.length)) || fields.some((f) => typeof f !== 'string' || f.includes('.'))) {
      throw failure('NATIVE_RELATION_EXPANSION_UNSUPPORTED');
    }

    params.filter = { $and: [{ organizationId: actor.organizationId }, params?.filter ?? {}] };

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
        });
        if (!dept) throw failure('NATIVE_REFERENCE_UNAVAILABLE');
      }
      params.values = nextValues;
    }

    ctx.state.latticeNativeActor = actor;
    return next();
  };
}

module.exports = { resolveParaActor, createParaScopeMiddleware };
