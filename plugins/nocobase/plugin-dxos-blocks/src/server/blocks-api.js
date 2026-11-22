/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { timingSafeEqual } = require('node:crypto');
const {
  ingestTelemetryPoint,
  ingestOrDeduplicateAlarm,
  acknowledgeAlarm,
  clearAlarm,
  queryTelemetryTimeSeries,
} = require('./alarm-engine');
const { executeGovernedExport } = require('./governed-export');

const ALLOWED_PROPOSAL_COLLECTIONS = new Set([
  'latticeAssets',
  'latticeRequests',
  'latticeOrders',
  'latticeIncidentCases',
  'latticeServiceTickets',
]);
const PROPOSAL_STATES = new Set(['all', 'proposed', 'reviewed']);
const ORG_ID_RE = /^[a-zA-Z0-9_-]{1,80}$/;
const URN_RE = /^urn:ngsi-ld:Asset:([a-zA-Z0-9_-]{1,80}):native:([1-9]\d{0,18})$/;
const MIN_EDGE_TOKEN_LENGTH = 16;

function fail(code, status = 403, message = code) {
  return Object.assign(new Error(message), { code, status });
}

const val = (row, key) => (typeof row?.get === 'function' ? row.get(key) : row?.[key]);

function readParams(ctx) {
  const p = ctx.action?.params || {};
  const v = p.values && typeof p.values === 'object' && !Array.isArray(p.values) ? p.values : {};
  return { ...p, ...v };
}

function parseOptionalNumber(raw, code, { min = 0 } = {}) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw === 'boolean' || typeof raw === 'object') throw fail(code, 400);
  if (typeof raw === 'string' && raw.trim() === '') throw fail(code, 400);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min) throw fail(code, 400);
  return parsed;
}

function readHeader(ctx, name) {
  if (typeof ctx?.get === 'function') {
    const v = ctx.get(name);
    if (typeof v === 'string' && v) return v;
  }
  const lower = String(name || '').toLowerCase();
  for (const hdrs of [ctx?.headers, ctx?.request?.headers]) {
    if (!hdrs || typeof hdrs !== 'object') continue;
    for (const [k, v] of Object.entries(hdrs)) {
      if (k.toLowerCase() === lower && typeof v === 'string' && v) return v;
    }
  }
  return '';
}

async function resolveTelemetryIngestAuth(db, ctx, input = {}, { ingestToken } = {}) {
  const providedToken = readHeader(ctx, 'X-Lattice-Edge-Token').trim();
  const rawEnvToken = ingestToken !== undefined ? ingestToken : process.env.DX_IIOT_INGEST_TOKEN;
  const expectedToken = typeof rawEnvToken === 'string' ? rawEnvToken.trim() : '';

  let auth;
  if (providedToken) {
    if (expectedToken.length < MIN_EDGE_TOKEN_LENGTH) {
      throw fail('TELEMETRY_EDGE_AUTH_INVALID', 401, 'Token IIoT edge chưa được cấu hình hợp lệ.');
    }
    const expectedBuf = Buffer.from(expectedToken, 'utf8');
    const providedBuf = Buffer.from(providedToken, 'utf8');
    if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
      throw fail('TELEMETRY_EDGE_AUTH_INVALID', 401, 'Token IIoT edge không khớp.');
    }
    const orgId = typeof input.organizationId === 'string' ? input.organizationId.trim() : '';
    if (!ORG_ID_RE.test(orgId)) {
      throw fail('TELEMETRY_ORG_REQUIRED', 400, 'Cần organizationId hợp lệ cho điểm đo IIoT.');
    }
    auth = { mode: 'edge-token', organizationId: orgId, isRoot: false, actor: null };
  } else if (!ctx.state?.currentUser?.id && ctx.state?.currentRole !== 'root') {
    throw fail('NATIVE_LOGIN_REQUIRED', 401);
  } else if (ctx.state?.currentRole === 'root') {
    if (!ctx.state?.currentUser) throw fail('NATIVE_LOGIN_REQUIRED', 401);
    const orgId = typeof input.organizationId === 'string' ? input.organizationId.trim() : '';
    if (!ORG_ID_RE.test(orgId)) {
      throw fail('TELEMETRY_ORG_REQUIRED', 400, 'Cần organizationId hợp lệ cho điểm đo IIoT.');
    }
    auth = { mode: 'root', organizationId: orgId, isRoot: true, actor: null };
  } else {
    const actor = await resolveNativeEmployee(db, ctx.state.currentUser);
    const [canCreateIncident, canUpdateAsset] = await Promise.all([
      hasViewPermission(db, ctx, 'latticeIncidentCases', 'create'),
      hasViewPermission(db, ctx, 'latticeAssets', 'update'),
    ]);
    if (!canCreateIncident && !canUpdateAsset) {
      throw fail('DXOS_ACL_DENIED', 403);
    }
    if (input.organizationId !== undefined && input.organizationId !== null && String(input.organizationId).trim() !== '' && String(input.organizationId).trim() !== actor.organizationId) {
      throw fail('DXOS_CROSS_ORG_FORBIDDEN', 403);
    }
    auth = { mode: 'user', organizationId: actor.organizationId, isRoot: false, actor };
  }

  const entityUrn = typeof input.assetEntityId === 'string' ? URN_RE.exec(input.assetEntityId.trim()) : null;
  if (entityUrn && entityUrn[1] !== auth.organizationId) {
    throw fail('DXOS_CROSS_ORG_FORBIDDEN', 403);
  }
  return auth;
}

function normalizeBrokerOrigin(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

async function resolveNativeEmployee(db, user) {
  const id = val(user, 'id');
  if (id == null || !/^[1-9]\d*$/.test(String(id))) throw fail('NATIVE_LOGIN_REQUIRED', 401);
  const repo = db.getRepository('latticeEmployees');
  if (!repo) throw fail('NATIVE_MEMBERSHIP_REQUIRED', 403);
  const rows = await repo.find({ filter: { userId: id }, limit: 2 });
  if (rows.length > 1) throw fail('NATIVE_MEMBERSHIP_AMBIGUOUS', 403);
  const emp = rows[0];
  if (!emp || val(emp, 'active') !== true) throw fail('NATIVE_MEMBERSHIP_REQUIRED', 403);
  const organizationId = val(emp, 'organizationId');
  if (typeof organizationId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(organizationId)) {
    throw fail('NATIVE_MEMBERSHIP_INVALID', 403);
  }
  return { userId: String(id), employeeId: val(emp, 'id'), organizationId };
}

async function hasViewPermission(db, ctx, collection, action = 'view') {
  const candidates = action === 'view' ? ['view', 'list'] : [action];
  if (typeof ctx.can === 'function') {
    return candidates.some((act) => ctx.can({ resource: collection, action: act }));
  }
  const roleName = ctx.state?.currentRole;
  if (!roleName) return false;
  const role = await db.getRepository('roles')?.findOne({ filter: { name: roleName } });
  if (val(role, 'allowAll') === true) return true;
  const res = await db.getRepository('dataSourcesRolesResources')?.findOne({
    filter: { roleName, name: collection, dataSourceKey: 'main' },
  });
  if (res) {
    if (val(res, 'usingActionsConfig') === false) return true;
    const actions = val(res, 'actions') || [];
    return actions.some((a) => candidates.includes(a?.name || a));
  }
  const strategyActions = val(role, 'strategy')?.actions || [];
  return Array.isArray(strategyActions) && strategyActions.some((a) => candidates.includes(a) || a === '*:*');
}

async function resolveCallerContext(db, ctx, { collection, action = 'view' }) {
  if (!ctx.state?.currentUser?.id && ctx.state?.currentRole !== 'root') {
    throw fail('NATIVE_LOGIN_REQUIRED', 401);
  }
  if (ctx.state?.currentRole === 'root') {
    if (!ctx.state?.currentUser) throw fail('NATIVE_LOGIN_REQUIRED', 401);
    return { isRoot: true, actor: null };
  }
  const actor = await resolveNativeEmployee(db, ctx.state.currentUser);
  if (!(await hasViewPermission(db, ctx, collection, action))) {
    throw fail('DXOS_ACL_DENIED', 403);
  }
  return { isRoot: false, actor };
}

const OWN_SCOPED_COLLECTIONS = new Set(['latticeRequests', 'latticeOrders', 'latticeServiceTickets']);
const ORG_WIDE_PROPOSAL_ROLES = new Set(['root', 'admin', 'ldx_admin', 'ldx_director', 'ldx_manager', 'ldx_dispatcher']);

const GLOBAL_SEARCH_SPECS = [
  { collection: 'latticeRequests', category: 'Yêu cầu mua sắm', path: '/p/procurement' },
  { collection: 'latticeOrders', category: 'Đơn Logistics', path: '/p/logistics' },
  { collection: 'latticeAssets', category: 'Tài sản', path: '/p/procurement' },
  { collection: 'latticeIncidentCases', category: 'Sự cố IoT', path: '/p/incidents' },
  { collection: 'latticeServiceTickets', category: 'Dịch vụ nội bộ', path: '/p/services' },
  { collection: 'latticeParaDocuments', category: 'Tài liệu P.A.R.A.', path: '/p/services' },
];

function foldSearchVi(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .trim();
}

function isRecordOwnedByActor(row, actor) {
  const empId = actor?.employeeId;
  const userId = actor?.userId;
  return [
    [val(row, 'requesterId'), empId],
    [val(row, 'assigneeId'), empId],
    [val(row, 'driverId'), empId],
    [val(row, 'ownerId'), empId],
    [val(row, 'createdById'), userId],
  ].some(([a, b]) => a != null && b != null && Number(a) === Number(b));
}

function buildOwnerFilterClauses(db, collection, actor) {
  const empId = actor?.employeeId;
  const userId = actor?.userId;
  const candidates = [
    ['requesterId', empId],
    ['assigneeId', empId],
    ['driverId', empId],
    ['ownerId', empId],
    ['createdById', userId],
  ];
  const col = db?.getCollection?.(collection);
  const rawAttrs = db?.getModel?.(collection)?.rawAttributes;
  const hasField = (name) => {
    if (col?.fields && typeof col.fields.has === 'function') return col.fields.has(name);
    if (col && typeof col.getField === 'function') return Boolean(col.getField(name));
    if (rawAttrs && typeof rawAttrs === 'object') return Object.hasOwn(rawAttrs, name);
    return ['requesterId', 'assigneeId'].includes(name);
  };
  const clauses = [];
  for (const [field, valId] of candidates) {
    if (valId != null && String(valId).trim() !== '' && hasField(field)) {
      const numVal = Number(valId);
      clauses.push({ [field]: Number.isFinite(numVal) ? numVal : valId });
    }
  }
  return clauses;
}

function createDxosBlocksActions(db, { brokerUrl = process.env.DX_NATIVE_CONTEXT_BROKER_URL, fetchImpl = fetch, ingestToken } = {}) {
  const brokerOrigin = normalizeBrokerOrigin(brokerUrl);

  return {
    proposals: async (ctx, next) => {
      if (!['GET', 'POST'].includes(ctx.method || 'GET')) ctx.throw?.(405) ?? (() => { throw fail('METHOD_NOT_ALLOWED', 405); })();
      const input = readParams(ctx);
      const targetCollection = String(input.targetCollection || 'latticeIncidentCases').trim();
      if (!ALLOWED_PROPOSAL_COLLECTIONS.has(targetCollection)) {
        throw fail('DXOS_COLLECTION_FORBIDDEN', 403);
      }

      const { isRoot, actor } = await resolveCallerContext(db, ctx, { collection: targetCollection, action: 'view' });
      const activeRole = String(ctx.state?.currentRole || '').trim();
      const enforceOwnScope = !isRoot && OWN_SCOPED_COLLECTIONS.has(targetCollection) && !ORG_WIDE_PROPOSAL_ROLES.has(activeRole);

      const state = String(input.state || 'all').trim();
      if (!PROPOSAL_STATES.has(state)) throw fail('DXOS_INVALID_PROPOSAL_STATE', 400);

      let targetRecordId;
      if (input.targetRecordId !== undefined && input.targetRecordId !== null && input.targetRecordId !== '') {
        if (!/^[1-9]\d{0,18}$/.test(String(input.targetRecordId))) throw fail('DXOS_INVALID_RECORD_ID', 400);
        targetRecordId = Number(input.targetRecordId);
        if (!isRoot) {
          const targetRow = await db.getRepository(targetCollection)?.findOne({
            filter: { id: targetRecordId, organizationId: actor.organizationId },
          });
          if (!targetRow) throw fail('DXOS_RECORD_NOT_FOUND', 404);
          if (enforceOwnScope && !isRecordOwnedByActor(targetRow, actor)) {
            throw fail('DXOS_ACL_DENIED', 403);
          }
        }
      }

      const rawPageSize = Number(input.pageSize);
      const pageSize = Number.isFinite(rawPageSize) ? Math.max(1, Math.min(50, Math.floor(rawPageSize))) : 10;

      let organizationId = isRoot ? null : actor.organizationId;
      if (isRoot && typeof input.organizationId === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(input.organizationId.trim())) {
        organizationId = input.organizationId.trim();
      }

      const repo = db.getRepository('latticeAgentProposals');
      if (!repo) {
        ctx.body = { items: [], total: 0, collection: targetCollection, preview: isRoot };
        return next();
      }

      const filter = {
        targetCollection,
        ...(organizationId ? { organizationId } : {}),
        ...(targetRecordId !== undefined ? { targetRecordId } : {}),
        ...(state !== 'all' ? { state } : {}),
      };
      let rows = await repo.find({ filter, limit: enforceOwnScope ? 100 : pageSize, sort: ['-id'] });
      rows = Array.isArray(rows) ? rows : [];
      let total = typeof repo.count === 'function' && !enforceOwnScope ? await repo.count({ filter }) : rows.length;
      if (enforceOwnScope && rows.length) {
        const recordIds = [...new Set(rows.map((r) => val(r, 'targetRecordId')).filter((id) => id != null))];
        const targetRepo = db.getRepository(targetCollection);
        if (!targetRepo || !recordIds.length) {
          rows = [];
        } else {
          const ownedRows = (await targetRepo.find({
            filter: { id: { $in: recordIds }, organizationId: actor.organizationId },
            limit: recordIds.length,
          })) || [];
          const ownedIds = new Set(ownedRows.filter((r) => isRecordOwnedByActor(r, actor)).map((r) => String(val(r, 'id'))));
          rows = rows.filter((r) => ownedIds.has(String(val(r, 'targetRecordId'))));
        }
        total = rows.length;
        rows = rows.slice(0, pageSize);
      }
      ctx.body = {
        items: (Array.isArray(rows) ? rows : []).map((row) => ({
          id: val(row, 'id'),
          targetCollection: val(row, 'targetCollection'),
          targetRecordId: val(row, 'targetRecordId'),
          organizationId: val(row, 'organizationId'),
          state: val(row, 'state'),
          recommendation: val(row, 'recommendation'),
          evidence: Array.isArray(val(row, 'evidence')) ? val(row, 'evidence') : [],
          createdAt: val(row, 'createdAt'),
        })),
        total,
        collection: targetCollection,
        preview: isRoot,
      };
      return next();
    },

    contextTelemetry: async (ctx, next) => {
      if (!['GET', 'POST'].includes(ctx.method || 'GET')) ctx.throw?.(405) ?? (() => { throw fail('METHOD_NOT_ALLOWED', 405); })();
      const input = readParams(ctx);
      const { isRoot, actor } = await resolveCallerContext(db, ctx, { collection: 'latticeAssets', action: 'view' });

      let lookupId;
      let lookupCode;
      let requestedOrg = isRoot ? null : actor.organizationId;

      if (typeof input.assetEntityId === 'string' && input.assetEntityId.trim()) {
        const rawEntity = input.assetEntityId.trim();
        const urnMatch = URN_RE.exec(rawEntity);
        if (urnMatch) {
          const [, urnOrg, urnId] = urnMatch;
          if (!isRoot && urnOrg !== actor.organizationId) {
            throw fail('DXOS_CROSS_ORG_FORBIDDEN', 403);
          }
          requestedOrg = urnOrg;
          lookupId = Number(urnId);
        } else {
          lookupCode = rawEntity;
        }
      } else if (input.assetId !== undefined && input.assetId !== null && input.assetId !== '') {
        if (!/^[1-9]\d{0,18}$/.test(String(input.assetId))) throw fail('DXOS_INVALID_ASSET_ID', 400);
        lookupId = Number(input.assetId);
      }

      if (isRoot && !requestedOrg && typeof input.organizationId === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(input.organizationId.trim())) {
        requestedOrg = input.organizationId.trim();
      }

      const assetRepo = db.getRepository('latticeAssets');
      let assetRow = null;
      if (assetRepo) {
        if (lookupId !== undefined) {
          assetRow = await assetRepo.findOne({ filter: { id: lookupId, ...(requestedOrg ? { organizationId: requestedOrg } : {}) } });
          if (!assetRow) throw fail('DXOS_ASSET_NOT_FOUND', 404);
        } else if (lookupCode) {
          assetRow = await assetRepo.findOne({ filter: { code: lookupCode, ...(requestedOrg ? { organizationId: requestedOrg } : {}) } });
          if (!assetRow) throw fail('DXOS_ASSET_NOT_FOUND', 404);
        } else {
          const list = await assetRepo.find({ filter: requestedOrg ? { organizationId: requestedOrg } : {}, limit: 1, sort: ['-id'] });
          assetRow = Array.isArray(list) ? list[0] || null : null;
        }
      }

      const asset = assetRow
        ? {
            id: val(assetRow, 'id'),
            code: val(assetRow, 'code'),
            name: val(assetRow, 'name'),
            status: val(assetRow, 'status'),
            organizationId: val(assetRow, 'organizationId'),
            entityId: `urn:ngsi-ld:Asset:${val(assetRow, 'organizationId')}:native:${val(assetRow, 'id')}`,
          }
        : null;

      const outboxRepo = db.getRepository('latticeContextOutbox');
      const syncSummary = { pending: 0, retry: 0, delivered: 0, failed: 0, lastDeliveredAt: null };
      let lastDeliveredTs = -Infinity;
      const targetOrg = asset?.organizationId || requestedOrg;
      if (outboxRepo && (targetOrg || isRoot)) {
        const outboxFilter = {
          ...(targetOrg ? { organizationId: targetOrg } : {}),
          ...(asset ? { collectionName: 'latticeAssets', recordId: asset.id } : {}),
        };
        const outboxRows = await outboxRepo.find({ filter: outboxFilter, limit: 100 });
        for (const row of Array.isArray(outboxRows) ? outboxRows : []) {
          const st = val(row, 'state');
          if (Object.hasOwn(syncSummary, st)) syncSummary[st] += 1;
          const del = val(row, 'deliveredAt');
          const ts = del ? Date.parse(String(del)) : NaN;
          if (del && ((Number.isFinite(ts) && ts > lastDeliveredTs) || (!Number.isFinite(lastDeliveredTs) && !syncSummary.lastDeliveredAt))) {
            if (Number.isFinite(ts)) lastDeliveredTs = ts;
            syncSummary.lastDeliveredAt = del;
          }
        }
      }

      let brokerStatus = brokerOrigin ? 'unconfigured' : 'unconfigured';
      let telemetry = null;
      if (brokerOrigin && asset) {
        try {
          const res = await fetchImpl(`${brokerOrigin}/ngsi-ld/v1/entities/${encodeURIComponent(asset.entityId)}`, {
            method: 'GET',
            redirect: 'error',
            headers: { Accept: 'application/ld+json', 'NGSILD-Tenant': asset.organizationId },
            signal: AbortSignal.timeout(3000),
          });
          if (res.ok) {
            const raw = await res.json();
            brokerStatus = 'online';
            telemetry = {};
            for (const [k, v] of Object.entries(raw || {})) {
              if (!['id', 'type', '@context'].includes(k)) telemetry[k] = v;
            }
          } else {
            await res.body?.cancel?.();
            brokerStatus = res.status === 404 ? 'not_synced' : 'offline';
          }
        } catch {
          brokerStatus = 'offline';
        }
      } else if (brokerOrigin) {
        brokerStatus = 'ready';
      }

      ctx.body = { asset, brokerStatus, telemetry, syncSummary, preview: isRoot };
      return next();
    },

    telemetrySeries: async (ctx, next) => {
      if (!['GET', 'POST'].includes(ctx.method || 'GET')) throw fail('METHOD_NOT_ALLOWED', 405);
      const input = readParams(ctx);
      const { isRoot, actor } = await resolveCallerContext(db, ctx, { collection: 'latticeAssets', action: 'view' });

      let lookupId;
      let requestedOrg = isRoot ? null : actor.organizationId;
      let assetEntityId = typeof input.assetEntityId === 'string' ? input.assetEntityId.trim() : '';
      if (assetEntityId) {
        const m = URN_RE.exec(assetEntityId);
        if (m) {
          if (!isRoot && m[1] !== actor.organizationId) throw fail('DXOS_CROSS_ORG_FORBIDDEN', 403);
          requestedOrg = m[1];
          lookupId = Number(m[2]);
        }
      } else if (input.assetId != null && input.assetId !== '') {
        if (!/^[1-9]\d{0,18}$/.test(String(input.assetId))) throw fail('DXOS_INVALID_ASSET_ID', 400);
        lookupId = Number(input.assetId);
      }

      if (!assetEntityId && lookupId != null) {
        const asset = await db.getRepository('latticeAssets')?.findOne({
          filter: { id: lookupId, ...(requestedOrg ? { organizationId: requestedOrg } : {}) },
        });
        if (!asset) throw fail('DXOS_ASSET_NOT_FOUND', 404);
        requestedOrg = val(asset, 'organizationId');
        assetEntityId = `urn:ngsi-ld:Asset:${requestedOrg}:native:${val(asset, 'id')}`;
      }
      if (isRoot && !requestedOrg && typeof input.organizationId === 'string' && ORG_ID_RE.test(input.organizationId.trim())) {
        requestedOrg = input.organizationId.trim();
      }

      const windowHours = parseOptionalNumber(input.windowHours, 'DXOS_INVALID_WINDOW_HOURS', { min: 0 });
      const bucketMinutes = parseOptionalNumber(input.bucketMinutes, 'DXOS_INVALID_BUCKET_MINUTES', { min: 0 });
      const limit = parseOptionalNumber(input.limit, 'DXOS_INVALID_LIMIT', { min: 1 });

      const series = await queryTelemetryTimeSeries(db, {
        organizationId: requestedOrg,
        assetEntityId,
        attribute: typeof input.attribute === 'string' ? input.attribute.trim() : '',
        ...(windowHours !== undefined ? { windowHours } : {}),
        ...(bucketMinutes !== undefined ? { bucketMinutes } : {}),
        limit: limit ?? 100,
      });
      ctx.body = { ...series, preview: isRoot };
      return next();
    },

    telemetryIngest: async (ctx, next) => {
      if ((ctx.method || 'POST') !== 'POST') throw fail('METHOD_NOT_ALLOWED', 405);
      const input = readParams(ctx);
      const auth = await resolveTelemetryIngestAuth(db, ctx, input, { ingestToken });

      let assetId = null;
      if (input.assetId !== undefined && input.assetId !== null && input.assetId !== '') {
        if (!/^[1-9]\d{0,18}$/.test(String(input.assetId))) throw fail('DXOS_INVALID_ASSET_ID', 400);
        assetId = Number(input.assetId);
      }
      let assetEntityId = typeof input.assetEntityId === 'string' ? input.assetEntityId.trim() : '';
      if (!assetEntityId && assetId != null) {
        assetEntityId = `urn:ngsi-ld:Asset:${auth.organizationId}:native:${assetId}`;
      }

      ctx.body = await ingestTelemetryPoint(db, {
        organizationId: auth.organizationId,
        assetId,
        assetEntityId,
        metricName: input.metricName !== undefined ? input.metricName : input.attribute,
        numericValue: input.numericValue !== undefined ? input.numericValue : input.value,
        unit: input.unit,
        quality: input.quality,
        sourceProtocol: input.sourceProtocol,
        observedAt: input.observedAt,
      });
      return next();
    },

    alarmIngest: async (ctx, next) => {
      if ((ctx.method || 'POST') !== 'POST') throw fail('METHOD_NOT_ALLOWED', 405);
      const input = readParams(ctx);
      const { isRoot, actor } = await resolveCallerContext(db, ctx, { collection: 'latticeIncidentCases', action: 'create' });
      const orgId = isRoot
        ? (typeof input.organizationId === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(input.organizationId.trim()) ? input.organizationId.trim() : 'native-ui-lab')
        : actor.organizationId;

      let assetEntityId = typeof input.assetEntityId === 'string' ? input.assetEntityId.trim() : '';
      const assetId = input.assetId != null && /^[1-9]\d{0,18}$/.test(String(input.assetId)) ? Number(input.assetId) : null;
      if (!assetEntityId && assetId != null) {
        assetEntityId = `urn:ngsi-ld:Asset:${orgId}:native:${assetId}`;
      }
      ctx.body = await ingestOrDeduplicateAlarm(db, {
        organizationId: orgId,
        assetId,
        assetEntityId,
        ruleCode: String(input.ruleCode || 'IOT-RULE').trim(),
        attribute: String(input.attribute || 'temperature').trim(),
        severity: String(input.severity || 'medium').trim(),
        summary: String(input.summary || '').trim(),
        handlerId: actor?.employeeId ? String(actor.employeeId) : String(input.handlerId || 'root'),
      });
      return next();
    },

    alarmAck: async (ctx, next) => {
      if ((ctx.method || 'POST') !== 'POST') throw fail('METHOD_NOT_ALLOWED', 405);
      const input = readParams(ctx);
      const { isRoot, actor } = await resolveCallerContext(db, ctx, { collection: 'latticeIncidentCases', action: 'update' });
      const id = Number(input.id);
      if (!Number.isInteger(id) || id <= 0) throw fail('ALARM_ID_REQUIRED', 400, 'Cần mã id cảnh báo hợp lệ.');
      const actorName = val(ctx.state?.currentUser, 'username') || (actor ? `user-${actor.userId}` : 'root');
      ctx.body = await acknowledgeAlarm(db, {
        id,
        organizationId: isRoot ? null : actor.organizationId,
        actorName,
        note: String(input.note || '').trim(),
      });
      return next();
    },

    alarmClear: async (ctx, next) => {
      if ((ctx.method || 'POST') !== 'POST') throw fail('METHOD_NOT_ALLOWED', 405);
      const input = readParams(ctx);
      const { isRoot, actor } = await resolveCallerContext(db, ctx, { collection: 'latticeIncidentCases', action: 'update' });
      const id = Number(input.id);
      if (!Number.isInteger(id) || id <= 0) throw fail('ALARM_ID_REQUIRED', 400, 'Cần mã id cảnh báo hợp lệ.');
      const actorName = val(ctx.state?.currentUser, 'username') || (actor ? `user-${actor.userId}` : 'root');
      ctx.body = await clearAlarm(db, {
        id,
        organizationId: isRoot ? null : actor.organizationId,
        actorName,
        closeNote: String(input.closeNote || input.note || '').trim(),
      });
      return next();
    },

    exportReport: async (ctx, next) => {
      if (!['GET', 'POST'].includes(ctx.method || 'GET')) throw fail('METHOD_NOT_ALLOWED', 405);
      const input = readParams(ctx);
      const collection = String(input.collection || '').trim();
      const { isRoot, actor } = await resolveCallerContext(db, ctx, { collection, action: 'view' });
      const result = await executeGovernedExport(db, ctx, input, { isRoot, actor, fetchImpl });
      const isDownload = input.download === true || input.download === '1' || input.download === 'true';
      if (typeof ctx.set === 'function') {
        ctx.set('X-Lattice-Export-Columns', result.columns.join(','));
        ctx.set('X-Lattice-Export-Omitted', result.omittedColumns.join(','));
        ctx.set('X-Lattice-Export-Sha256', result.sha256);
      }
      if (isDownload) {
        if (typeof ctx.set === 'function') {
          ctx.set('Content-Type', result.mimeType);
          ctx.set('Content-Disposition', `attachment; filename="${result.filename}"`);
        }
        ctx.body = result.buffer;
        return next();
      }
      const { buffer, ...meta } = result;
      ctx.body = { ...meta, contentBase64: buffer.toString('base64') };
      return next();
    },

    globalSearch: async (ctx, next) => {
      if (!['GET', 'POST'].includes(ctx.method || 'GET')) throw fail('METHOD_NOT_ALLOWED', 405);
      if (!ctx.state?.currentUser?.id && ctx.state?.currentRole !== 'root') {
        throw fail('NATIVE_LOGIN_REQUIRED', 401);
      }
      const isRoot = ctx.state?.currentRole === 'root';
      if (isRoot && !ctx.state?.currentUser) throw fail('NATIVE_LOGIN_REQUIRED', 401);
      const actor = isRoot ? null : await resolveNativeEmployee(db, ctx.state.currentUser);

      const input = readParams(ctx);
      const rawQuery = typeof input.query === 'string' ? input.query.trim() : '';
      if (rawQuery.length < 1 || rawQuery.length > 120) {
        throw fail('DXOS_SEARCH_QUERY_INVALID', 400, 'Từ khóa tìm kiếm phải từ 1 đến 120 ký tự.');
      }
      const needle = foldSearchVi(rawQuery);
      const tokens = needle.split(/\s+/).filter(Boolean);
      if (!tokens.length) {
        throw fail('DXOS_SEARCH_QUERY_INVALID', 400, 'Từ khóa tìm kiếm không hợp lệ.');
      }
      const limit = Math.max(1, Math.min(20, Math.floor(Number(input.limit) || 10)));

      let organizationId = isRoot ? null : actor.organizationId;
      if (isRoot && typeof input.organizationId === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(input.organizationId.trim())) {
        organizationId = input.organizationId.trim();
      }
      const activeRole = String(ctx.state?.currentRole || '').trim();

      const BATCH_SIZE = 200;
      const MAX_SCAN = 2000;
      const buckets = [];
      for (const spec of GLOBAL_SEARCH_SPECS) {
        if (!isRoot && !(await hasViewPermission(db, ctx, spec.collection, 'view'))) continue;
        const repo = db?.getRepository?.(spec.collection);
        if (!repo) continue;
        const enforceOwnScope = !isRoot && OWN_SCOPED_COLLECTIONS.has(spec.collection) && !ORG_WIDE_PROPOSAL_ROLES.has(activeRole);
        const ownerClauses = enforceOwnScope ? buildOwnerFilterClauses(db, spec.collection, actor) : [];
        let filter = organizationId ? { organizationId } : {};
        if (ownerClauses.length) {
          filter = organizationId
            ? { $and: [{ organizationId }, { $or: ownerClauses }] }
            : { $or: ownerClauses };
        }

        const matched = [];
        const seenIds = new Set();
        for (let offset = 0; offset < MAX_SCAN && matched.length < limit; offset += BATCH_SIZE) {
          const rows = (await repo.find({
            filter,
            limit: BATCH_SIZE,
            offset,
            sort: ['-id'],
          })) || [];
          if (!Array.isArray(rows) || !rows.length) break;

          let unseenCount = 0;
          for (const row of rows) {
            const id = val(row, 'id');
            const idKey = id != null ? String(id) : null;
            if (idKey !== null) {
              if (seenIds.has(idKey)) continue;
              seenIds.add(idKey);
            }
            unseenCount += 1;

            if (organizationId && val(row, 'organizationId') !== organizationId) continue;
            if (enforceOwnScope && !isRecordOwnedByActor(row, actor)) continue;
            const code = String(val(row, 'code') || '').trim();
            const title = String(val(row, 'title') || val(row, 'name') || code || '').trim();
            const desc = String(val(row, 'description') || val(row, 'summary') || '').trim();
            const hay = foldSearchVi(`${code} ${title} ${desc}`);
            if (!tokens.every((t) => hay.includes(t))) continue;
            matched.push({
              collection: spec.collection,
              id,
              code,
              title: title || `#${id}`,
              status: String(val(row, 'status') || ''),
              category: spec.category,
              path: spec.collection === 'latticeParaDocuments' && id != null
                ? `/p/services?paraDocId=${encodeURIComponent(String(id))}`
                : spec.path,
            });
            if (matched.length >= limit) break;
          }
          if (rows.length < BATCH_SIZE || unseenCount === 0) break;
        }
        if (matched.length) buckets.push(matched);
      }

      const items = [];
      let round = 0;
      while (items.length < limit) {
        let added = false;
        for (const bucket of buckets) {
          if (round < bucket.length) {
            items.push(bucket[round]);
            added = true;
            if (items.length >= limit) break;
          }
        }
        if (!added) break;
        round += 1;
      }

      ctx.body = { query: rawQuery, count: items.length, items };
      return next();
    },
  };
}

module.exports = {
  ALLOWED_PROPOSAL_COLLECTIONS,
  createDxosBlocksActions,
  resolveCallerContext,
  resolveTelemetryIngestAuth,
};
