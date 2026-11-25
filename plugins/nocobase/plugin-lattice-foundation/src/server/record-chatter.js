/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { resolveNativeActor } = require('./native-scope');
const { dispatchNotification, resolveNotificationTargetPath } = require('./notification-center');
const {
  canUsePgRlsSession,
  getActiveRlsContext,
  withSystemRlsBypass,
  withTenantRlsContext,
} = require('./pg-rls');

const ALLOWED_CHATTER_COLLECTIONS = new Set([
  'latticeRequests',
  'latticeOrders',
  'latticeAssets',
  'latticeIncidentCases',
  'latticeServiceTickets',
  'latticeParaDocuments',
]);
const CUSTOM_COLLECTION_RE = /^latticeCustom[A-Z][A-Za-z0-9]{1,40}$/;

function isChatterCollectionAllowed(name) {
  const clean = String(name || '').trim();
  return ALLOWED_CHATTER_COLLECTIONS.has(clean) || CUSTOM_COLLECTION_RE.test(clean);
}

const DIFF_IGNORED_FIELDS = new Set([
  'id',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'version',
  'embeddingJson',
  'searchVector',
  'searchText',
  'expectedVersion',
]);

const SENSITIVE_FIELD_RE = /password|secret|token|apikey|api_key|privateKey|hash|salt/i;
const MENTION_TOKEN_RE = /(?:^|[\s(])@([a-zA-Z0-9._-]{2,64})/g;

const val = (row, key) => (typeof row?.get === 'function' ? row.get(key) : row?.[key]);

function failChatter(code, status = 400, message = code) {
  return Object.assign(new Error(message), { code, status });
}

function readParams(ctx) {
  const p = ctx.action?.params || {};
  const v = p.values && typeof p.values === 'object' && !Array.isArray(p.values) ? p.values : {};
  return { ...p, ...v };
}

function extractMentionTokens(text) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const seen = new Set();
  const out = [];
  for (const match of text.matchAll(MENTION_TOKEN_RE)) {
    const token = String(match[1] || '').trim().toLowerCase();
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= 20) break;
  }
  return out;
}

async function resolveOrganizationMentions(db, organizationId, tokens, { transaction = null } = {}) {
  if (!organizationId || !Array.isArray(tokens) || !tokens.length) return [];
  const empRepo = db?.getRepository?.('latticeEmployees');
  if (!empRepo) return [];
  const tokenSet = new Set(tokens.map((t) => String(t).trim().toLowerCase()).filter(Boolean));
  const employees = (await empRepo.find({
    filter: { organizationId, active: true },
    limit: 500,
    ...(transaction ? { transaction } : {}),
  })) || [];
  const matched = [];
  const seenIds = new Set();
  for (const emp of employees) {
    if (val(emp, 'active') !== true || val(emp, 'organizationId') !== organizationId) continue;
    const employeeId = val(emp, 'id');
    const code = String(val(emp, 'code') || '').trim();
    const name = String(val(emp, 'name') || '').trim();
    const email = String(val(emp, 'email') || '').trim().toLowerCase();
    const localPart = email.includes('@') ? email.split('@')[0] : '';
    const candidates = [code.toLowerCase(), name.toLowerCase(), localPart, email, String(employeeId || '')].filter(Boolean);
    const hit = candidates.find((c) => tokenSet.has(c));
    if (hit && employeeId != null && !seenIds.has(String(employeeId))) {
      seenIds.add(String(employeeId));
      const rawUserId = val(emp, 'userId');
      const userId = rawUserId != null && /^[1-9]\d*$/.test(String(rawUserId)) ? Number(rawUserId) : null;
      matched.push({
        employeeId: Number(employeeId),
        userId,
        code,
        name,
        handle: hit,
      });
    }
  }
  return matched;
}

function normalizeDiffScalar(v) {
  if (v === undefined || v === null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 200);
  return typeof v === 'string' ? v.slice(0, 200) : v;
}

function computeRecordFieldDiff(beforeObj, afterObj) {
  if (!beforeObj || !afterObj || typeof beforeObj !== 'object' || typeof afterObj !== 'object') return [];
  const keys = new Set([...Object.keys(beforeObj), ...Object.keys(afterObj)]);
  const diffs = [];
  for (const key of keys) {
    if (DIFF_IGNORED_FIELDS.has(key) || SENSITIVE_FIELD_RE.test(key)) continue;
    const b = normalizeDiffScalar(beforeObj[key]);
    const a = normalizeDiffScalar(afterObj[key]);
    if (b !== a) {
      diffs.push({ field: key, before: b, after: a });
    }
  }
  return diffs.slice(0, 30);
}

async function recordChatterEntry(
  db,
  {
    organizationId,
    targetCollection,
    targetRecordId,
    entryType = 'comment',
    body,
    mentionsJson = [],
    diffJson = null,
    authorUserId = null,
    authorEmployeeId = null,
    authorName = 'system',
  },
  { transaction } = {},
) {
  const repo = db?.getRepository?.('latticeRecordChatter');
  if (!repo || typeof repo.create !== 'function') return null;
  const writeEntry = async (tx) => {
    const created = await repo.create({
      values: {
        organizationId: String(organizationId),
        targetCollection: String(targetCollection),
        targetRecordId: Number(targetRecordId),
        entryType: String(entryType || 'comment'),
        body: String(body || '').slice(0, 2000),
        mentionsJson: Array.isArray(mentionsJson) ? mentionsJson : [],
        diffJson: diffJson || null,
        ...(authorUserId != null ? { authorUserId: Number(authorUserId) } : {}),
        ...(authorEmployeeId != null ? { authorEmployeeId: Number(authorEmployeeId) } : {}),
        authorName: String(authorName || 'system').slice(0, 120),
      },
      ...(tx ? { transaction: tx } : {}),
    });
    const { appendLedgerEntrySafely } = require('./pki-ledger');
    await appendLedgerEntrySafely(
      db,
      {
        organizationId: String(organizationId),
        eventType: `chatter.${String(entryType || 'comment')}`,
        targetCollection: String(targetCollection),
        targetRecordId: String(targetRecordId),
        actor: {
          userId: authorUserId != null ? String(authorUserId) : null,
          username: String(authorName || 'system').slice(0, 120),
        },
        payload: {
          chatterId: val(created, 'id') ?? null,
          entryType: String(entryType || 'comment'),
          body: String(body || '').slice(0, 2000),
          mentionsJson: Array.isArray(mentionsJson) ? mentionsJson : [],
          diffJson: diffJson || null,
        },
      },
      { transaction: tx, scope: 'lattice:record-chatter' },
    );
    return created;
  };
  const activeTx = transaction || getActiveRlsContext()?.transaction || null;
  if (!activeTx && canUsePgRlsSession(db) && organizationId) {
    return withTenantRlsContext(db, String(organizationId), writeEntry);
  }
  return writeEntry(activeTx);
}

async function hasCollectionReadPermission(db, ctx, collection) {
  if (typeof ctx?.can === 'function') {
    return ['view', 'list'].some((act) => ctx.can({ resource: collection, action: act }));
  }
  const roleName = ctx?.state?.currentRole;
  const rolesRepo = db?.getRepository?.('roles');
  const dsrRepo = db?.getRepository?.('dataSourcesRolesResources');
  if (!roleName || !dsrRepo) {
    return true;
  }
  if (rolesRepo && typeof rolesRepo.findOne === 'function') {
    const role = await rolesRepo.findOne({ filter: { name: roleName } });
    if (val(role, 'allowAll') === true) return true;
    const res = await dsrRepo.findOne({
      filter: { roleName, name: collection, dataSourceKey: 'main' },
    });
    if (res) {
      if (val(res, 'usingActionsConfig') === false) return true;
      const actions = val(res, 'actions') || [];
      return actions.some((a) => ['view', 'list'].includes(a?.name || a));
    }
    const strategyActions = val(role, 'strategy')?.actions || [];
    return Array.isArray(strategyActions) && strategyActions.some((a) => ['view', 'list'].includes(a) || a === '*:*');
  }
  const res = await dsrRepo.findOne({
    filter: { roleName, name: collection, dataSourceKey: 'main' },
  });
  if (!res) return false;
  if (val(res, 'usingActionsConfig') === false) return true;
  const actions = val(res, 'actions') || [];
  return actions.some((a) => ['view', 'list'].includes(a?.name || a));
}

async function recordFieldDiffChatter(db, { organizationId, targetCollection, targetRecordId, before, after, actor }, opts = {}) {
  if (!isChatterCollectionAllowed(targetCollection)) return null;
  if (!organizationId || !targetRecordId) return null;
  const diffs = computeRecordFieldDiff(before, after);
  if (!diffs.length) return null;
  const summary = `Cập nhật ${diffs.map((d) => d.field).join(', ')}`;
  return recordChatterEntry(
    db,
    {
      organizationId,
      targetCollection,
      targetRecordId,
      entryType: 'field_diff',
      body: summary,
      mentionsJson: [],
      diffJson: diffs,
      authorUserId: actor?.userId ? Number(actor.userId) : null,
      authorEmployeeId: actor?.employeeId ? Number(actor.employeeId) : null,
      authorName: actor?.username || (actor?.employeeId ? `employee-${actor.employeeId}` : 'operator'),
    },
    opts,
  );
}

async function resolveVerifiedTarget(db, ctx, targetCollection, targetRecordId) {
  if (!isChatterCollectionAllowed(targetCollection)) {
    throw failChatter('CHATTER_COLLECTION_INVALID', 400, 'Collection không hỗ trợ Record Chatter.');
  }
  const id = Number(targetRecordId);
  if (!Number.isInteger(id) || id <= 0) {
    throw failChatter('CHATTER_RECORD_ID_REQUIRED', 400, 'Cần mã bản ghi targetRecordId hợp lệ.');
  }
  const repo = db?.getRepository?.(targetCollection);
  if (!repo) throw failChatter('CHATTER_COLLECTION_UNAVAILABLE', 503);

  const isRoot = ctx.state?.currentRole === 'root';
  if (isRoot) {
    if (!ctx.state?.currentUser) throw failChatter('NATIVE_LOGIN_REQUIRED', 401);
    const findRootRow = (transaction) => repo.findOne({ filter: { id }, ...(transaction ? { transaction } : {}) });
    const row = canUsePgRlsSession(db) && !getActiveRlsContext()?.transaction
      ? await withSystemRlsBypass(db, findRootRow)
      : await findRootRow(getActiveRlsContext()?.transaction);
    if (!row) throw failChatter('CHATTER_TARGET_NOT_FOUND', 404, 'Không tìm thấy bản ghi mục tiêu.');
    return {
      isRoot: true,
      actor: {
        userId: String(val(ctx.state.currentUser, 'id') || ''),
        employeeId: null,
        organizationId: val(row, 'organizationId'),
        username: val(ctx.state.currentUser, 'username') || 'root',
      },
      recordId: id,
    };
  }

  const actor = await resolveNativeActor(db, ctx.state?.currentUser);
  if (!(await hasCollectionReadPermission(db, ctx, targetCollection))) {
    throw failChatter('CHATTER_ACCESS_DENIED', 403, 'Không có quyền truy cập bản ghi này.');
  }
  const findOrgRow = (transaction) => repo.findOne({
    filter: { id, organizationId: actor.organizationId },
    ...(transaction ? { transaction } : {}),
  });
  const row = canUsePgRlsSession(db) && !getActiveRlsContext()?.transaction
    ? await withTenantRlsContext(db, actor.organizationId, findOrgRow)
    : await findOrgRow(getActiveRlsContext()?.transaction);
  const rowOrg = val(row, 'organizationId');
  if (!row || (rowOrg != null ? String(rowOrg) !== actor.organizationId : CUSTOM_COLLECTION_RE.test(targetCollection))) {
    throw failChatter('CHATTER_TARGET_NOT_FOUND', 404, 'Không tìm thấy bản ghi trong phạm vi tổ chức.');
  }
  return {
    isRoot: false,
    actor: {
      ...actor,
      username: val(ctx.state?.currentUser, 'username') || `employee-${actor.employeeId}`,
    },
    recordId: id,
  };
}

function serializeChatter(row) {
  return {
    id: val(row, 'id'),
    organizationId: val(row, 'organizationId'),
    targetCollection: val(row, 'targetCollection'),
    targetRecordId: val(row, 'targetRecordId'),
    entryType: val(row, 'entryType') || 'comment',
    body: val(row, 'body') || '',
    mentionsJson: val(row, 'mentionsJson') || [],
    diffJson: val(row, 'diffJson') || null,
    authorUserId: val(row, 'authorUserId') ?? null,
    authorEmployeeId: val(row, 'authorEmployeeId') ?? null,
    authorName: val(row, 'authorName') || 'system',
    createdAt: val(row, 'createdAt') || null,
  };
}

function registerChatterResource(app) {
  const db = app.db;
  app.resourceManager.define({
    name: 'latticeChatter',
    actions: {
      list: async (ctx, next) => {
        if ((ctx.method || 'GET') !== 'GET') ctx.throw(405);
        const params = readParams(ctx);
        const targetCollection = String(params.targetCollection || '').trim();
        const { actor, recordId } = await resolveVerifiedTarget(db, ctx, targetCollection, params.targetRecordId);
        const limit = Math.max(1, Math.min(200, Number(params.limit) || 50));
        const repo = db.getRepository('latticeRecordChatter');
        const filter = {
          organizationId: actor.organizationId,
          targetCollection,
          targetRecordId: recordId,
        };
        const readList = async (transaction) => {
          const txOpt = transaction ? { transaction } : {};
          const foundRows = repo ? (await repo.find({ filter, sort: ['-id'], limit, ...txOpt })) || [] : [];
          const foundTotal = repo && typeof repo.count === 'function' ? await repo.count({ filter, ...txOpt }) : foundRows.length;
          return { rows: foundRows, total: foundTotal };
        };
        const { rows, total } = canUsePgRlsSession(db) && !getActiveRlsContext()?.transaction
          ? await withTenantRlsContext(db, actor.organizationId, readList)
          : await readList(getActiveRlsContext()?.transaction);
        ctx.body = {
          organizationId: actor.organizationId,
          targetCollection,
          targetRecordId: recordId,
          total,
          items: rows.map(serializeChatter),
        };
        return next();
      },

      post: async (ctx, next) => {
        if ((ctx.method || 'POST') !== 'POST') ctx.throw(405);
        const params = readParams(ctx);
        const targetCollection = String(params.targetCollection || '').trim();
        const { actor, recordId } = await resolveVerifiedTarget(db, ctx, targetCollection, params.targetRecordId);
        const body = typeof params.body === 'string' ? params.body.trim() : '';
        if (!body || body.length > 2000) {
          throw failChatter('CHATTER_BODY_REQUIRED', 400, 'Nội dung trao đổi phải từ 1 đến 2000 ký tự.');
        }
        const tokens = extractMentionTokens(body);
        const writePost = async (transaction) => {
          const mentions = await resolveOrganizationMentions(db, actor.organizationId, tokens, { transaction });
          const created = await recordChatterEntry(db, {
            organizationId: actor.organizationId,
            targetCollection,
            targetRecordId: recordId,
            entryType: 'comment',
            body,
            mentionsJson: mentions,
            diffJson: null,
            authorUserId: actor.userId ? Number(actor.userId) : null,
            authorEmployeeId: actor.employeeId ? Number(actor.employeeId) : null,
            authorName: actor.username || 'operator',
          }, { transaction });
          return { mentions, created };
        };
        const { mentions, created } = canUsePgRlsSession(db) && !getActiveRlsContext()?.transaction
          ? await withTenantRlsContext(db, actor.organizationId, writePost)
          : await writePost(getActiveRlsContext()?.transaction);
        const chatterId = val(created, 'id');
        const targetPath = resolveNotificationTargetPath(targetCollection);
        for (const mention of mentions) {
          if (mention.userId == null) continue;
          if (actor.userId && Number(mention.userId) === Number(actor.userId)) continue;
          try {
            await dispatchNotification(db, {
              organizationId: actor.organizationId,
              recipientUserId: mention.userId,
              recipientEmployeeId: mention.employeeId,
              category: 'mention',
              severity: 'info',
              title: `${actor.username || 'Đồng nghiệp'} đã nhắc đến bạn`,
              body: body.slice(0, 300),
              targetCollection,
              targetRecordId: recordId,
              targetPath,
              ...(chatterId != null ? { dedupKey: `mention:${targetCollection}:${recordId}:${chatterId}` } : {}),
            }, { app });
          } catch {}
        }
        try {
          await app.pubSubManager?.publish?.('lattice:surface', {
            kind: 'chatter',
            organizationId: actor.organizationId,
            targetCollection,
            targetRecordId: recordId,
          });
        } catch {}
        ctx.body = serializeChatter(created || {
          organizationId: actor.organizationId,
          targetCollection,
          targetRecordId: recordId,
          entryType: 'comment',
          body,
          mentionsJson: mentions,
          authorName: actor.username || 'operator',
        });
        return next();
      },
    },
  });
  app.acl.allow('latticeChatter', ['list', 'post'], 'loggedIn');
}

module.exports = {
  ALLOWED_CHATTER_COLLECTIONS,
  CUSTOM_COLLECTION_RE,
  isChatterCollectionAllowed,
  extractMentionTokens,
  resolveOrganizationMentions,
  computeRecordFieldDiff,
  recordChatterEntry,
  recordFieldDiffChatter,
  registerChatterResource,
};
