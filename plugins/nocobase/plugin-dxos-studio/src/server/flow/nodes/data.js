/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { SYSTEM_PROTECTED_COLLECTIONS } = require('../../solution-bundle');
const { assertSafeDirectSort, clampPageLimit, fail, sanitizeDirectFilter, toPlain, val } = require('../../wms-dmn-shared');
const { flowHelpers } = require('./triggers');

const { isPlainObject, sanitizePlainObject, interpolateTemplate, buildEvalContext, resolveOrgId, pickHelper } = flowHelpers;

const CUSTOM_COLLECTION_RE = /^latticeCustom[A-Z][A-Za-z0-9]{1,40}$/;
const ALLOWLISTED_BUSINESS_COLLECTIONS = new Set([
  'latticeRequests', 'latticeOrders', 'latticeOrderLines', 'latticeServiceTickets',
  'latticeParaDocuments', 'latticeIncidentCases', 'latticeLocations', 'latticeAssets', 'latticeAgentProposals',
]);
const SENSITIVE_COLLECTIONS = new Set([
  'latticePkiKeys', 'latticeCryptoLedger', 'latticeConnectors', 'latticeWebhookSubscriptions',
  'latticeWebhookDeliveries', 'latticeEventBus', 'latticeApiKeys', 'latticeDelegations',
  'latticeDecisionTables', 'latticeEpodRecords', 'latticeOrganizations', 'latticeAutomationRules', 'latticeAutomationRuns',
]);
const FORBIDDEN_COLLECTIONS_LOWER = new Set(
  [...(SYSTEM_PROTECTED_COLLECTIONS || []), ...SENSITIVE_COLLECTIONS].map((c) => String(c).toLowerCase()),
);
const CORE_VOUCHER_COLLECTIONS = new Set(['latticeRequests', 'latticeOrders', 'latticeServiceTickets']);
const PROTECTED_VOUCHER_FIELDS = new Set([
  'id', 'organizationId', 'status', 'version', 'amendedFromId', 'amendmentNo',
  'submittedAt', 'submittedBy', 'cancelledAt', 'cancelledBy', 'cancelReason',
]);

function isForbiddenCollection(name) {
  const clean = String(name || '').trim();
  return !clean || FORBIDDEN_COLLECTIONS_LOWER.has(clean.toLowerCase());
}

function isAllowlistedTargetCollection(collectionName) {
  const name = String(collectionName || '').trim();
  if (isForbiddenCollection(name)) return false;
  return ALLOWLISTED_BUSINESS_COLLECTIONS.has(name) || CUSTOM_COLLECTION_RE.test(name);
}

function sanitizeWriteValues(collectionName, rawValues) {
  const values = isPlainObject(rawValues) ? sanitizePlainObject(rawValues) : {};
  delete values.id;
  delete values.organizationId;
  if (CORE_VOUCHER_COLLECTIONS.has(collectionName)) {
    for (const f of PROTECTED_VOUCHER_FIELDS) delete values[f];
  }
  return values;
}

function assertAllowedCollectionAndOrg(collectionName, orgId, helpers) {
  const allowedByHelper = typeof helpers?.isAllowlistedTargetCollection === 'function'
    ? helpers.isAllowlistedTargetCollection(collectionName)
    : isAllowlistedTargetCollection(collectionName);
  if (isForbiddenCollection(collectionName) || !allowedByHelper) {
    throw fail('TARGET_COLLECTION_FORBIDDEN', 403, `TARGET_COLLECTION_FORBIDDEN: ${collectionName || '(empty)'}`);
  }
  if (!orgId) throw fail('DATA_ORG_REQUIRED', 400, 'Valid organizationId is required for data node');
}

const dataNodes = [
  {
    type: 'data.query',
    category: 'data',
    label: 'Query Collection Records',
    description: 'Queries tenant-scoped records from an allowlisted business collection.',
    icon: 'SearchOutlined',
    color: '#13c2c2',
    inputs: ['in'],
    outputs: ['main', 'error'],
    defaultConfig: { collection: 'latticeRequests', filter: {}, limit: 20, sort: [] },
    inputSchema: {
      fields: [
        { name: 'collection', label: 'Collection', type: 'collection', required: true },
        { name: 'filter', label: 'Filter (JSON)', type: 'json' },
        { name: 'limit', label: 'Limit (1..200)', type: 'number' },
        { name: 'sort', label: 'Sort Fields', type: 'json' },
      ],
    },
    async execute({ node, config, input, context, db, options, helpers }) {
      const cfg = config || node?.config || {};
      const evalCtx = buildEvalContext(context, input);
      const interp = pickHelper(helpers, 'interpolateTemplate', interpolateTemplate);
      const collection = String(interp(cfg.collection || cfg.targetCollection || '', evalCtx)).trim();
      const orgId = resolveOrgId(context, input, options, cfg);
      assertAllowedCollectionAndOrg(collection, orgId, helpers);

      const rawFilter = cfg.filter ? interp(cfg.filter, evalCtx) : {};
      const cleanFilter = sanitizePlainObject(sanitizeDirectFilter(isPlainObject(rawFilter) ? rawFilter : {}));
      const scopedFilter = { ...cleanFilter, organizationId: orgId };
      const limit = clampPageLimit(cfg.limit);
      assertSafeDirectSort(cfg.sort);
      const repo = db?.getRepository?.(collection);
      if (!repo || typeof repo.find !== 'function') {
        if (options?.dryRun) return { output: { collection, count: 0, items: [], simulated: true }, nextPort: 'main' };
        throw fail('REPOSITORY_UNAVAILABLE', 503, `Repository not found for collection ${collection}`);
      }
      const rows = (await repo.find({ filter: scopedFilter, limit, ...(cfg.sort ? { sort: cfg.sort } : {}) })) || [];
      const items = rows.map(toPlain);
      return { output: { collection, count: items.length, items }, nextPort: 'main' };
    },
  },
  {
    type: 'data.create',
    category: 'data',
    label: 'Create Record',
    description: 'Creates a tenant-scoped record in an allowlisted business collection.',
    icon: 'PlusSquareOutlined',
    color: '#13c2c2',
    inputs: ['in'],
    outputs: ['main', 'error'],
    defaultConfig: { collection: '', values: {} },
    inputSchema: {
      fields: [
        { name: 'collection', label: 'Collection', type: 'collection', required: true },
        { name: 'values', label: 'Record Values (JSON)', type: 'json', required: true },
      ],
    },
    async execute({ node, config, input, context, db, options, helpers }) {
      const cfg = config || node?.config || {};
      const evalCtx = buildEvalContext(context, input);
      const interp = pickHelper(helpers, 'interpolateTemplate', interpolateTemplate);
      const sanWrite = pickHelper(helpers, 'sanitizeAutomationWriteValues', sanitizeWriteValues);
      const collection = String(interp(cfg.collection || cfg.targetCollection || '', evalCtx)).trim();
      const orgId = resolveOrgId(context, input, options, cfg);
      assertAllowedCollectionAndOrg(collection, orgId, helpers);

      const rawValues = interp(cfg.values ?? cfg.data ?? cfg.payload ?? {}, evalCtx);
      const values = { ...sanWrite(collection, rawValues), organizationId: orgId };
      if (options?.dryRun) return { output: { collection, id: null, record: values, simulated: true }, nextPort: 'main' };
      const repo = db?.getRepository?.(collection);
      if (!repo || typeof repo.create !== 'function') throw fail('REPOSITORY_UNAVAILABLE', 503, `Repository not found for collection ${collection}`);
      const created = await repo.create({ values });
      const plain = toPlain(created) || values;
      return { output: { collection, id: val(created, 'id') ?? plain.id ?? null, record: plain }, nextPort: 'main' };
    },
  },
  {
    type: 'data.update',
    category: 'data',
    label: 'Update Records',
    description: 'Updates matching tenant-scoped records in an allowlisted business collection.',
    icon: 'EditOutlined',
    color: '#13c2c2',
    inputs: ['in'],
    outputs: ['main', 'error'],
    defaultConfig: { collection: '', filter: {}, recordId: '', values: {}, limit: 20 },
    inputSchema: {
      fields: [
        { name: 'collection', label: 'Collection', type: 'collection', required: true },
        { name: 'recordId', label: 'Record ID (optional)', type: 'string' },
        { name: 'filter', label: 'Filter (JSON)', type: 'json' },
        { name: 'values', label: 'Update Values (JSON)', type: 'json', required: true },
      ],
    },
    async execute({ node, config, input, context, db, options, helpers }) {
      const cfg = config || node?.config || {};
      const evalCtx = buildEvalContext(context, input);
      const interp = pickHelper(helpers, 'interpolateTemplate', interpolateTemplate);
      const sanWrite = pickHelper(helpers, 'sanitizeAutomationWriteValues', sanitizeWriteValues);
      const collection = String(interp(cfg.collection || cfg.targetCollection || '', evalCtx)).trim();
      const orgId = resolveOrgId(context, input, options, cfg);
      assertAllowedCollectionAndOrg(collection, orgId, helpers);

      const rawFilter = cfg.filter ? interp(cfg.filter, evalCtx)
        : (cfg.recordId !== undefined && String(cfg.recordId).trim() !== '' ? { id: interp(cfg.recordId, evalCtx) } : null);
      if (!isPlainObject(rawFilter) || !Object.keys(rawFilter).length) {
        throw fail('DATA_UPDATE_FILTER_REQUIRED', 400, 'data.update requires a non-empty filter or recordId');
      }
      const scopedFilter = { ...sanitizePlainObject(sanitizeDirectFilter(rawFilter)), organizationId: orgId };
      const values = sanWrite(collection, interp(cfg.values ?? cfg.patch ?? cfg.data ?? {}, evalCtx));
      if (options?.dryRun) {
        return { output: { collection, filter: scopedFilter, values, matchedCount: 0, updatedCount: 0, simulated: true }, nextPort: 'main' };
      }
      const repo = db?.getRepository?.(collection);
      if (!repo || typeof repo.find !== 'function') throw fail('REPOSITORY_UNAVAILABLE', 503, `Repository not found for collection ${collection}`);
      const list = (await repo.find({ filter: scopedFilter, limit: clampPageLimit(cfg.limit) })) || [];
      if (list.length > 0 && typeof repo.update === 'function') await repo.update({ filter: scopedFilter, values });
      return { output: { collection, matchedCount: list.length, updatedCount: list.length }, nextPort: 'main' };
    },
  },
];

module.exports = { dataNodes, isAllowlistedTargetCollection, isForbiddenCollection, sanitizeWriteValues };
