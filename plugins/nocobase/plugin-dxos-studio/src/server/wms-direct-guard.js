/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { resolveServiceActor } = require('./service-scope');
const {
  SENSITIVE_FILTER_KEY_RE,
  defaultFoundation,
  fail,
  runWithOptionalRls,
  clampPageLimit,
  sanitizeDirectFilter,
  assertSafeDirectSort,
} = require('./wms-dmn-shared');

function attachRlsTxNonEnumerable(ctx, transaction, foundation) {
  if (!ctx || !transaction) return;
  if (typeof foundation?.pgRls?.setContextRlsTransaction === 'function') {
    foundation.pgRls.setContextRlsTransaction(ctx, transaction);
    return;
  }
  ctx.state = ctx.state || {};
  Object.defineProperty(ctx.state, 'latticeRlsTransaction', {
    value: transaction,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

const WMS_DMN_COLLECTIONS = new Set([
  'latticeOrderLines',
  'latticeStockLots',
  'latticeEpodRecords',
  'latticeDecisionTables',
  'latticeDelegations',
]);

const DIRECT_WRITE_LOCKED_COLLECTIONS = new Set([
  'latticeEpodRecords',
  'latticeDecisionTables',
  'latticeDelegations',
]);

const LOT_PROTECTED_DIRECT_FIELDS = new Set([
  'qtyOnHand',
  'qtyReserved',
  'status',
  'mktCelsius',
  'holdReason',
  'heldAt',
  'heldBy',
]);

const ORDER_LINE_PROTECTED_DIRECT_FIELDS = new Set([
  'status',
  'allocatedQty',
  'lotId',
  'lotCode',
]);

const EPOD_SENSITIVE_CHART_FIELDS = Object.freeze([
  'trackingTokenHash',
  'signatureDataUrl',
  'recipientPhoneMasked',
  'gpsLat',
  'gpsLng',
]);

const EPOD_SENSITIVE_CHART_FIELDS_LOWER = new Set(
  EPOD_SENSITIVE_CHART_FIELDS.map((field) => field.toLowerCase()),
);

function scrubEpodRow(row) {
  if (!row || typeof row !== 'object') return row;
  if (row.dataValues && typeof row.dataValues === 'object') {
    delete row.dataValues.trackingTokenHash;
  }
  delete row.trackingTokenHash;
  if (typeof row.toJSON === 'function') {
    const plain = row.toJSON();
    if (plain && typeof plain === 'object') {
      delete plain.trackingTokenHash;
      return plain;
    }
  }
  return row;
}

function stripEpodSecretsFromBody(ctx) {
  if (!ctx) return;
  const scrubNode = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 4) return node;
    if (Array.isArray(node)) return node.map((item) => scrubNode(item, depth + 1));
    const scrubbed = scrubEpodRow(node);
    if (Array.isArray(scrubbed.rows)) scrubbed.rows = scrubbed.rows.map((item) => scrubNode(item, depth + 1));
    if (Array.isArray(scrubbed.items)) scrubbed.items = scrubbed.items.map((item) => scrubNode(item, depth + 1));
    if (Array.isArray(scrubbed.data)) scrubbed.data = scrubbed.data.map((item) => scrubNode(item, depth + 1));
    else if (scrubbed.data && typeof scrubbed.data === 'object') scrubbed.data = scrubNode(scrubbed.data, depth + 1);
    return scrubbed;
  };
  if (ctx.body && typeof ctx.body === 'object') {
    ctx.body = scrubNode(ctx.body);
  }
}

function extractChartFieldCandidates(item, depth = 0) {
  if (depth > 8 || item === null || item === undefined) return [];
  if (typeof item === 'string') return [item];
  if (Array.isArray(item)) return item.flatMap((el) => extractChartFieldCandidates(el, depth + 1));
  if (typeof item !== 'object') return [];
  const candidates = [];
  for (const key of ['field', 'fieldName', 'name', 'column', 'key', 'dataIndex']) {
    if (item[key] !== undefined) {
      candidates.push(...extractChartFieldCandidates(item[key], depth + 1));
    }
  }
  return candidates;
}

function assertSafeEpodChartQuery(values) {
  for (const listKey of ['measures', 'dimensions', 'orders']) {
    let raw = values?.[listKey];
    if (raw === undefined || raw === null) continue;
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        try {
          raw = JSON.parse(trimmed);
        } catch {
          throw fail('NATIVE_PROTECTED_FIELD', 403);
        }
      }
    }
    const entries = Array.isArray(raw) ? raw : [raw];
    for (const entry of entries) {
      for (const candidate of extractChartFieldCandidates(entry)) {
        const clean = String(candidate || '').trim();
        if (!clean) continue;
        const segments = clean.split('.');
        if (
          segments.some((seg) => EPOD_SENSITIVE_CHART_FIELDS_LOWER.has(seg.toLowerCase()))
          || SENSITIVE_FILTER_KEY_RE.test(clean)
        ) {
          throw fail('NATIVE_PROTECTED_FIELD', 403, `Không được truy vấn trường nhạy cảm (${clean}) trên latticeEpodRecords.`);
        }
      }
    }
  }
}

function createWmsDmnDirectGuardMiddleware(db, foundation = defaultFoundation) {
  if (typeof foundation?.pgRls?.installRlsTransactionBridge === 'function') {
    foundation.pgRls.installRlsTransactionBridge(db);
  }
  const readActions = new Set(['list', 'get', 'count']);
  const writeActions = new Set(['create', 'update', 'destroy']);

  return async function wmsDmnDirectGuardMiddleware(ctx, next) {
    const { resourceName, actionName } = ctx.action || {};
    const params = ctx.action?.params || (ctx.action ? (ctx.action.params = {}) : {});
    if (ctx.state?.currentRole === 'root') return next();

    if (resourceName === 'charts' && actionName === 'queryData' && WMS_DMN_COLLECTIONS.has(String(params?.values?.collection || ''))) {
      if (params.values.mode !== 'builder') throw fail('NATIVE_CHART_MODE_UNSUPPORTED', 403);
      const actor = await resolveServiceActor(db, ctx.state?.currentUser);
      const chartCollection = String(params.values.collection || '');
      const isEpodChart = chartCollection === 'latticeEpodRecords';
      if (isEpodChart) assertSafeEpodChartQuery(params.values);
      const blockedFields = isEpodChart ? EPOD_SENSITIVE_CHART_FIELDS_LOWER : null;
      const sanitizedFilter = params.values.filter !== undefined
        ? sanitizeDirectFilter(params.values.filter, { blockedFields })
        : params.values.filter;
      assertSafeDirectSort(params.values.sort, blockedFields);
      params.values = { ...params.values, filter: { $and: [{ organizationId: actor.organizationId }, sanitizedFilter ?? {}] } };
      if (params.values.pageSize != null) params.values.pageSize = clampPageLimit(params.values.pageSize);
      if (params.values.limit != null) params.values.limit = clampPageLimit(params.values.limit);
      ctx.state = ctx.state || {};
      ctx.state.latticeNativeActor = actor;
      ctx.state.latticeRlsOrg = actor.organizationId;
      return runWithOptionalRls(db, actor.organizationId, async (transaction) => {
        attachRlsTxNonEnumerable(ctx, transaction, foundation);
        await next();
        if (isEpodChart) stripEpodSecretsFromBody(ctx);
      }, foundation);
    }

    const collectionName = String(resourceName || '').split('.')[0];
    if (!WMS_DMN_COLLECTIONS.has(collectionName)) return next();

    const actor = await resolveServiceActor(db, ctx.state?.currentUser);
    if (resourceName !== collectionName) throw fail('NATIVE_ASSOCIATION_ACTION_UNSUPPORTED', 403);
    if (!readActions.has(actionName) && !writeActions.has(actionName)) throw fail('NATIVE_ACTION_UNSUPPORTED', 403);

    if (writeActions.has(actionName)) {
      if (DIRECT_WRITE_LOCKED_COLLECTIONS.has(collectionName)) {
        throw fail('DXOS_DIRECT_WRITE_FORBIDDEN', 403, `Không được ghi trực tiếp vào ${collectionName}; hãy dùng API nghiệp vụ chuyên biệt.`);
      }
      if (actionName === 'destroy') {
        throw fail('NATIVE_DOCUMENT_DELETE_UNSUPPORTED', 403);
      }
    }

    const fields = params?.fields == null ? [] : Array.isArray(params.fields) ? params.fields : String(params.fields).split(',');
    if (params?.targetCollection || (params?.appends && (!Array.isArray(params.appends) || params.appends.length)) || fields.some((f) => typeof f !== 'string' || f.includes('.'))) {
      throw fail('NATIVE_RELATION_EXPANSION_UNSUPPORTED', 403);
    }
    const sanitizedFilter = params?.filter !== undefined ? sanitizeDirectFilter(params.filter) : params?.filter;
    assertSafeDirectSort(params?.sort);
    params.filter = { $and: [{ organizationId: actor.organizationId }, sanitizedFilter ?? {}] };
    if (params?.pageSize != null) params.pageSize = clampPageLimit(params.pageSize);
    if (params?.limit != null) params.limit = clampPageLimit(params.limit);

    if (actionName === 'create' || actionName === 'update') {
      const values = params?.values;
      if (!values || typeof values !== 'object' || Array.isArray(values)) throw fail('NATIVE_VALUES_INVALID', 400);
      const protectedSet = collectionName === 'latticeStockLots' ? LOT_PROTECTED_DIRECT_FIELDS : ORDER_LINE_PROTECTED_DIRECT_FIELDS;
      for (const [k, v] of Object.entries(values)) {
        if (['id', 'userId', 'identitySubject'].includes(k) || (v !== null && typeof v === 'object')) {
          throw fail('NATIVE_PROTECTED_FIELD', 403);
        }
        if (protectedSet.has(k)) throw fail('NATIVE_DOCUMENT_PROTECTED_FIELD', 403);
      }
      if (values.organizationId !== undefined && values.organizationId !== actor.organizationId) {
        throw fail('NATIVE_ORGANIZATION_MISMATCH', 403);
      }
      params.values = { ...values, organizationId: actor.organizationId };
    }

    ctx.state = ctx.state || {};
    ctx.state.latticeNativeActor = actor;
    ctx.state.latticeRlsOrg = actor.organizationId;

    return runWithOptionalRls(db, actor.organizationId, async (transaction) => {
      attachRlsTxNonEnumerable(ctx, transaction, foundation);
      await next();
      if (collectionName === 'latticeEpodRecords') stripEpodSecretsFromBody(ctx);
    }, foundation);
  };
}

function validateTenantCollectionRecord(model, options = {}) {
  const actor = options.context?.state?.latticeNativeActor;
  if (!actor || !actor.organizationId) return;
  if (typeof model?.set === 'function') model.set('organizationId', actor.organizationId);
  else if (model && typeof model === 'object') model.organizationId = actor.organizationId;
  if (Array.isArray(options?.fields) && !options.fields.includes('organizationId')) {
    options.fields.push('organizationId');
  }
}

module.exports = {
  WMS_DMN_COLLECTIONS,
  DIRECT_WRITE_LOCKED_COLLECTIONS,
  LOT_PROTECTED_DIRECT_FIELDS,
  ORDER_LINE_PROTECTED_DIRECT_FIELDS,
  EPOD_SENSITIVE_CHART_FIELDS,
  stripEpodSecretsFromBody,
  assertSafeEpodChartQuery,
  createWmsDmnDirectGuardMiddleware,
  validateTenantCollectionRecord,
};
