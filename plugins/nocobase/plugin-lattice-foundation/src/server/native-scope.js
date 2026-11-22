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
  return Object.assign(new Error(code), {code, status});
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
const SENSITIVE_FILTER_KEY_RE = /password|secret|token|apikey|api_key|identitySubject|privateKey|hash|salt/i;
const SENSITIVE_CHART_COLLECTIONS = new Set([
  'users', 'roles', 'dataSourcesRoles', 'dataSourcesRolesResources',
  'authenticators', 'applicationTokens', 'apiKeys', 'sessions',
  'latticeAiAuditLogs', 'latticeAiProfiles',
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
    if (!key.startsWith('$')) {
      if (key.includes('.') || SENSITIVE_FILTER_KEY_RE.test(key)) {
        throw failure('NATIVE_RELATION_EXPANSION_UNSUPPORTED');
      }
    }
    assertSafeFilter(entry, depth + 1);
  }
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
async function updateScopedDocument(db,ctx,actor) {
  const params=ctx.action.params,id=params.filterByTk;
  if(!/^[1-9]\d*$/.test(String(id)))throw failure('NATIVE_DOCUMENT_ID_REQUIRED',400);
  await db.sequelize.transaction(async transaction=>{
    const row=await db.getModel(ctx.action.resourceName).findOne({where:{id,organizationId:actor.organizationId},transaction,lock:transaction.LOCK.UPDATE});
    if(!row)throw failure('NATIVE_DOCUMENT_NOT_FOUND',404);
    // Keep the post-ACL filter and field guards; repository hooks still run.
    ctx.body=await db.getRepository(ctx.action.resourceName).update({filterByTk:id,filter:params.filter,values:params.values,whitelist:params.whitelist,blacklist:params.blacklist,transaction,context:ctx});
    if(Array.isArray(ctx.body)&&!ctx.body.length)throw failure('NATIVE_DOCUMENT_UPDATE_DENIED',403);
    ctx.status=200;
  });
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
      assertSafeFilter(values.filter);
      assertSafeSort(values.sort);
      if (isScopedCollection(col)) {
        const actor = await resolveNativeActor(db, ctx.state.currentUser);
        params.values = scopeNativeRead(values, actor);
      } else {
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
    assertSafeFilter(params.filter);
    assertSafeSort(params.sort);
    if (write.has(actionName) && collectionName === 'latticeEmployees') throw failure('NATIVE_IDENTITY_ADMIN_REQUIRED');
    if (write.has(actionName) && collectionName === 'latticeIncidentCases') throw failure('NATIVE_INCIDENT_WORKFLOW_REQUIRED');
    const scopedRead = scopeNativeRead(params,actor);
    params.filter = scopedRead.filter;
    if (scopedRead.pageSize != null) params.pageSize = scopedRead.pageSize;
    if (scopedRead.limit != null) params.limit = scopedRead.limit;
    const document=['latticeRequests','latticeOrders'].includes(collectionName);
    if(document) {
      if(actionName==='destroy')throw failure('NATIVE_DOCUMENT_DELETE_UNSUPPORTED');
    }
    if (actionName === 'create' || actionName === 'update') {
      params.values = scopeNativeValues(params.values,actor);
      if(document) {
        if(['status','version','requesterId','assigneeId','decisionReason'].some(field=>Object.hasOwn(params.values,field)))throw failure('NATIVE_DOCUMENT_PROTECTED_FIELD');
        if(actionName==='create') {
          if(typeof params.values.name!=='string'||!params.values.name.trim()||params.values.name.length>200)throw failure('NATIVE_DOCUMENT_NAME_REQUIRED',400);
          params.values={...params.values,name:params.values.name.trim(),status:'draft',version:1,requesterId:actor.employeeId};
          if(params.values.departmentId==null&&actor.departmentId!=null)params.values.departmentId=actor.departmentId;
        }
      }
      for (const field of schemas.get(collectionName)?.fields || []) {
        if (field.type !== 'belongsTo' || !schemas.has(field.target)) continue;
        const id=params.values[field.foreignKey];
        if (id == null) continue;
        if (!/^[1-9]\d*$/.test(String(id))) throw failure('NATIVE_REFERENCE_INVALID',400);
        const reference=await db.getRepository(field.target).findOne({filter:{id,organizationId:actor.organizationId,active:true}});
        if (!reference) throw failure('NATIVE_REFERENCE_UNAVAILABLE');
      }
    }
    ctx.state.latticeNativeActor=actor;
    if(document&&actionName==='update')return updateScopedDocument(db,ctx,actor);
    return proceed();
  };
}
module.exports = {resolveNativeActor, scopeNativeRead, scopeNativeValues,createNativeScopeMiddleware,updateScopedDocument};
