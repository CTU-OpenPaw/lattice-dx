/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const ALLOWED_PROPOSAL_COLLECTIONS = new Set([
  'latticeAssets',
  'latticeRequests',
  'latticeOrders',
  'latticeIncidentCases',
  'latticeServiceTickets',
]);
const PROPOSAL_STATES = new Set(['all', 'proposed', 'reviewed']);
const URN_RE = /^urn:ngsi-ld:Asset:([a-zA-Z0-9_-]{1,80}):native:([1-9]\d{0,18})$/;

function fail(code, status = 403, message = code) {
  return Object.assign(new Error(message), { code, status });
}

const val = (row, key) => (typeof row?.get === 'function' ? row.get(key) : row?.[key]);

function readParams(ctx) {
  const p = ctx.action?.params || {};
  const v = p.values && typeof p.values === 'object' && !Array.isArray(p.values) ? p.values : {};
  return { ...p, ...v };
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

async function hasViewPermission(db, ctx, collection) {
  if (typeof ctx.can === 'function') {
    if (ctx.can({ resource: collection, action: 'view' }) || ctx.can({ resource: collection, action: 'list' })) {
      return true;
    }
    return false;
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
    return actions.some((a) => ['view', 'list'].includes(a?.name || a));
  }
  const strategyActions = val(role, 'strategy')?.actions || [];
  return Array.isArray(strategyActions) && strategyActions.some((a) => a === 'view' || a === '*:*');
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
  if (!(await hasViewPermission(db, ctx, collection))) {
    throw fail('DXOS_ACL_DENIED', 403);
  }
  return { isRoot: false, actor };
}

const OWN_SCOPED_COLLECTIONS = new Set(['latticeRequests', 'latticeOrders', 'latticeServiceTickets']);
const ORG_WIDE_PROPOSAL_ROLES = new Set(['root', 'admin', 'ldx_admin', 'ldx_director', 'ldx_manager', 'ldx_dispatcher']);

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

function createDxosBlocksActions(db, { brokerUrl = process.env.DX_NATIVE_CONTEXT_BROKER_URL, fetchImpl = fetch } = {}) {
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
  };
}

module.exports = {
  ALLOWED_PROPOSAL_COLLECTIONS,
  createDxosBlocksActions,
  resolveCallerContext,
};
