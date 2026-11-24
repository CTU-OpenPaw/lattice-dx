/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { randomBytes } = require('node:crypto');
const {
  defaultFoundation,
  val,
  fail,
  readParams,
  parseOptionalDate,
  isOrgAdmin,
  resolveTenantActor,
  appendAuditLedger,
  runWithOptionalRls,
  saveRow,
} = require('./wms-dmn-shared');

const FORBIDDEN_DELEGATION_ROLES = new Set(['root', 'admin', 'ldx_admin']);
const ROLE_NAME_RE = /^[a-zA-Z0-9_-]{2,64}$/;
const COLLECTION_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{1,64}$/;
const MAX_DELEGATION_MS = 90 * 86_400_000;

function isElevatedSnippet(snippet) {
  if (typeof snippet !== 'string') return false;
  const s = snippet.trim().toLowerCase();
  if (!s || s.startsWith('!')) return false;
  if (s.includes('*')) return true;
  return (
    s === 'pm'
    || s.startsWith('pm.')
    || s.startsWith('pm:')
    || s === 'acl'
    || s.startsWith('acl.')
    || s.startsWith('acl:')
    || s === 'app'
    || s.startsWith('app.')
    || s.startsWith('app:')
    || s === 'ui'
    || s.startsWith('ui.')
    || s.startsWith('ui:')
  );
}

function isElevatedRoleRow(roleRow) {
  if (!roleRow) return false;
  if (val(roleRow, 'allowAll') === true || val(roleRow, 'allowConfigure') === true) return true;
  const snippets = val(roleRow, 'snippets');
  if (Array.isArray(snippets) && snippets.some(isElevatedSnippet)) {
    return true;
  }
  const strategyActions = val(roleRow, 'strategy')?.actions;
  if (Array.isArray(strategyActions) && strategyActions.some((a) => ['*', '*:*'].includes(String(a || '').trim()))) {
    return true;
  }
  return false;
}

function serializeDelegation(row) {
  if (!row) return null;
  const startsAt = val(row, 'startsAt');
  const endsAt = val(row, 'endsAt');
  const revokedAt = val(row, 'revokedAt');
  return {
    id: val(row, 'id') ?? null,
    organizationId: val(row, 'organizationId'),
    delegationUid: val(row, 'delegationUid'),
    delegatorUserId: val(row, 'delegatorUserId') != null ? Number(val(row, 'delegatorUserId')) : null,
    delegatorEmployeeId: val(row, 'delegatorEmployeeId') != null ? Number(val(row, 'delegatorEmployeeId')) : null,
    delegateUserId: val(row, 'delegateUserId') != null ? Number(val(row, 'delegateUserId')) : null,
    delegateEmployeeId: val(row, 'delegateEmployeeId') != null ? Number(val(row, 'delegateEmployeeId')) : null,
    roleName: val(row, 'roleName'),
    scopeCollection: val(row, 'scopeCollection') || null,
    reason: val(row, 'reason') || null,
    startsAt: startsAt instanceof Date ? startsAt.toISOString() : String(startsAt || ''),
    endsAt: endsAt instanceof Date ? endsAt.toISOString() : String(endsAt || ''),
    status: val(row, 'status') || 'active',
    revokedBy: val(row, 'revokedBy') || null,
    revokedAt: revokedAt ? (revokedAt instanceof Date ? revokedAt.toISOString() : String(revokedAt)) : null,
    active: val(row, 'active') !== false,
  };
}

function createDxosDelegationsActions(db, foundation = defaultFoundation) {
  if (typeof foundation?.pgRls?.installRlsTransactionBridge === 'function') {
    foundation.pgRls.installRlsTransactionBridge(db);
  }

  return {
    list: async (ctx, next) => {
      if ((ctx.method || 'GET') !== 'GET') throw fail('METHOD_NOT_ALLOWED', 405);
      const params = readParams(ctx);
      const { isRoot, organizationId, actor } = await resolveTenantActor(db, ctx, {
        requireOrg: false,
        requestedOrgId: params.organizationId,
        aclCollections: null,
        patScopes: ['read', 'write'],
      }, foundation);
      const repo = db.getRepository?.('latticeDelegations');
      if (!repo) {
        ctx.body = { organizationId, items: [] };
        return next();
      }
      const filter = {
        ...(organizationId ? { organizationId } : {}),
        ...(typeof params.status === 'string' && params.status.trim() ? { status: params.status.trim() } : {}),
      };
      const limit = Math.max(1, Math.min(200, Math.floor(Number(params.limit) || 100)));
      const { adminOk, rows } = await runWithOptionalRls(db, organizationId, async (transaction) => {
        const isAdm = isRoot || (await isOrgAdmin(db, ctx));
        const list = (await repo.find({ filter, sort: ['-id'], limit, ...(transaction ? { transaction } : {}) })) || [];
        return { adminOk: isAdm, rows: list };
      }, foundation);
      const callerUid = Number(actor.userId);
      const visible = adminOk
        ? rows
        : rows.filter((r) => Number(val(r, 'delegatorUserId')) === callerUid || Number(val(r, 'delegateUserId')) === callerUid);
      ctx.body = { organizationId, items: visible.map(serializeDelegation) };
      return next();
    },

    create: async (ctx, next) => {
      if ((ctx.method || 'POST') !== 'POST') throw fail('METHOD_NOT_ALLOWED', 405);
      const params = readParams(ctx);
      const { isRoot, organizationId, actor } = await resolveTenantActor(db, ctx, {
        requireOrg: true,
        requestedOrgId: params.organizationId,
        aclCollections: null,
        patScopes: ['write'],
      }, foundation);

      const roleName = typeof params.roleName === 'string' ? params.roleName.trim() : '';
      if (!ROLE_NAME_RE.test(roleName)) {
        throw fail('DELEGATION_ROLE_INVALID', 400, 'roleName không hợp lệ.');
      }

      const callerUserId = Number(actor.userId);
      const delegatorUserId = isRoot && params.delegatorUserId != null
        ? Number(params.delegatorUserId)
        : callerUserId;
      const delegateUserId = Number(params.delegateUserId);
      if (!Number.isInteger(delegatorUserId) || delegatorUserId <= 0) {
        throw fail('DELEGATION_USER_INVALID', 400, 'delegatorUserId không hợp lệ.');
      }
      if (!Number.isInteger(delegateUserId) || delegateUserId <= 0) {
        throw fail('DELEGATION_USER_INVALID', 400, 'delegateUserId không hợp lệ.');
      }
      if (delegateUserId === delegatorUserId) {
        throw fail('DELEGATION_SELF_FORBIDDEN', 400, 'Không thể tự ủy quyền cho chính mình.');
      }

      const startsAt = parseOptionalDate(params.startsAt, 'DELEGATION_WINDOW_INVALID') || new Date();
      const endsAt = parseOptionalDate(params.endsAt, 'DELEGATION_WINDOW_INVALID');
      if (!endsAt || endsAt.getTime() <= startsAt.getTime()) {
        throw fail('DELEGATION_WINDOW_INVALID', 400, 'endsAt phải lớn hơn startsAt.');
      }
      if (endsAt.getTime() - startsAt.getTime() > MAX_DELEGATION_MS) {
        throw fail('DELEGATION_WINDOW_EXCEEDED', 400, 'Thời hạn ủy quyền không được vượt quá 90 ngày.');
      }

      let scopeCollection = null;
      if (params.scopeCollection != null && String(params.scopeCollection).trim() !== '') {
        scopeCollection = String(params.scopeCollection).trim();
        if (!COLLECTION_NAME_RE.test(scopeCollection)) {
          throw fail('DELEGATION_SCOPE_INVALID', 400, 'scopeCollection không hợp lệ.');
        }
      }

      const empRepo = db.getRepository?.('latticeEmployees');
      if (!empRepo || typeof empRepo.find !== 'function') {
        throw fail('NATIVE_MEMBERSHIP_REQUIRED', 403);
      }
      const repo = db.getRepository?.('latticeDelegations');
      if (!repo) throw fail('DELEGATION_REPO_UNAVAILABLE', 503);

      const serialized = await runWithOptionalRls(db, organizationId, async (transaction) => {
        const txOpt = transaction ? { transaction } : {};
        const rolesRepo = db.getRepository?.('roles');
        const roleRow = rolesRepo?.findOne ? await rolesRepo.findOne({ filter: { name: roleName }, ...txOpt }) : null;
        if (!isRoot && (FORBIDDEN_DELEGATION_ROLES.has(roleName.toLowerCase()) || isElevatedRoleRow(roleRow))) {
          throw fail('DELEGATION_ESCALATION_FORBIDDEN', 403, `Không được ủy quyền vai trò quản trị hoặc đặc quyền (${roleName}).`);
        }

        if (!isRoot) {
          const ruRepo = db.getRepository?.('rolesUsers');
          if (!ruRepo || typeof ruRepo.find !== 'function') {
            throw fail('DELEGATION_ROLE_NOT_HELD', 403, 'Không thể xác minh phân quyền rolesUsers của người ủy quyền.');
          }
          const bindings = (await ruRepo.find({ filter: { userId: delegatorUserId }, ...txOpt })) || [];
          const held = bindings.some((b) => String(val(b, 'roleName') || '').trim() === roleName);
          if (!held) {
            throw fail('DELEGATION_ROLE_NOT_HELD', 403, `Bạn chỉ có thể ủy quyền vai trò bạn đang nắm giữ (${roleName}).`);
          }
        }

        let delegatorEmployeeId = actor.employeeId != null ? Number(actor.employeeId) : null;
        if (!isRoot || delegatorUserId !== callerUserId) {
          const delEmps = (await empRepo.find({ filter: { userId: delegatorUserId }, limit: 2, ...txOpt })) || [];
          const delEmp = delEmps[0];
          if (!delEmp || val(delEmp, 'active') !== true || val(delEmp, 'organizationId') !== organizationId) {
            throw fail('DELEGATION_CROSS_ORG_FORBIDDEN', 403, 'Người ủy quyền không hoạt động trong cùng tổ chức.');
          }
          delegatorEmployeeId = Number(val(delEmp, 'id'));
        }

        const targetEmps = (await empRepo.find({ filter: { userId: delegateUserId }, limit: 2, ...txOpt })) || [];
        if (targetEmps.length > 1) throw fail('NATIVE_MEMBERSHIP_AMBIGUOUS', 403);
        const targetEmp = targetEmps[0];
        if (!targetEmp || val(targetEmp, 'active') !== true) {
          throw fail('DELEGATION_TARGET_INACTIVE', 403, 'Người được ủy quyền không có hồ sơ nhân sự đang hoạt động.');
        }
        if (val(targetEmp, 'organizationId') !== organizationId) {
          throw fail('DELEGATION_CROSS_ORG_FORBIDDEN', 403, 'Không được ủy quyền cho nhân sự thuộc tổ chức khác.');
        }
        const delegateEmployeeId = Number(val(targetEmp, 'id'));

        const usersRepo = db.getRepository?.('users');
        if (usersRepo?.findOne) {
          const targetUser = await usersRepo.findOne({ filter: { id: delegateUserId }, ...txOpt });
          if (targetUser && val(targetUser, 'active') === false) {
            throw fail('DELEGATION_TARGET_INACTIVE', 403, 'Tài khoản người được ủy quyền đã bị khóa.');
          }
        }

        const delegationUid = `DLG-${randomBytes(6).toString('hex').toUpperCase()}`;
        const created = await repo.create({
          values: {
            organizationId,
            delegationUid,
            delegatorUserId,
            delegatorEmployeeId,
            delegateUserId,
            delegateEmployeeId,
            roleName,
            scopeCollection,
            reason: typeof params.reason === 'string' ? params.reason.trim().slice(0, 500) : null,
            startsAt,
            endsAt,
            status: 'active',
            active: true,
          },
          ...txOpt,
        });

        const out = serializeDelegation(created);
        await appendAuditLedger(db, {
          organizationId,
          eventType: 'auth.delegation_created',
          targetCollection: 'latticeDelegations',
          targetRecordId: String(out.id ?? delegationUid),
          actor,
          payload: out,
          transaction,
          scope: 'dxos:delegations',
          foundation,
        });
        return out;
      }, foundation);

      ctx.body = { delegation: serialized };
      return next();
    },

    revoke: async (ctx, next) => {
      if ((ctx.method || 'POST') !== 'POST') throw fail('METHOD_NOT_ALLOWED', 405);
      const params = readParams(ctx);
      const { isRoot, organizationId, actor } = await resolveTenantActor(db, ctx, {
        requireOrg: true,
        requestedOrgId: params.organizationId,
        aclCollections: null,
        patScopes: ['write'],
      }, foundation);

      const id = params.id != null && /^[1-9]\d*$/.test(String(params.id)) ? Number(params.id) : null;
      const delegationUid = typeof params.delegationUid === 'string' ? params.delegationUid.trim() : '';
      if (id == null && !delegationUid) {
        throw fail('DELEGATION_ID_REQUIRED', 400, 'Cần id hoặc delegationUid để thu hồi ủy quyền.');
      }

      const repo = db.getRepository?.('latticeDelegations');
      if (!repo) throw fail('DELEGATION_REPO_UNAVAILABLE', 503);

      const result = await runWithOptionalRls(db, organizationId, async (transaction) => {
        const txOpt = transaction ? { transaction } : {};
        const filter = id != null ? { organizationId, id } : { organizationId, delegationUid };
        const existing = await repo.findOne({ filter, ...txOpt });
        if (!existing || val(existing, 'organizationId') !== organizationId) {
          throw fail('DELEGATION_NOT_FOUND', 404, 'Không tìm thấy bản ghi ủy quyền trong tổ chức.');
        }

        const adminOk = isRoot || (await isOrgAdmin(db, ctx));
        if (!adminOk && Number(val(existing, 'delegatorUserId')) !== Number(actor.userId)) {
          throw fail('DELEGATION_REVOKE_FORBIDDEN', 403, 'Chỉ người ủy quyền hoặc quản trị viên mới được thu hồi.');
        }

        if (val(existing, 'status') === 'revoked') {
          return { delegation: serializeDelegation(existing), alreadyRevoked: true };
        }

        const patch = {
          status: 'revoked',
          active: false,
          revokedBy: actor.username,
          revokedAt: new Date(),
        };
        const updated = await saveRow(repo, existing, patch, { organizationId }, transaction);
        const serialized = serializeDelegation(updated);
        await appendAuditLedger(db, {
          organizationId,
          eventType: 'auth.delegation_revoked',
          targetCollection: 'latticeDelegations',
          targetRecordId: String(serialized.id ?? serialized.delegationUid),
          actor,
          payload: { delegationUid: serialized.delegationUid, revokedBy: patch.revokedBy },
          transaction,
          scope: 'dxos:delegations',
          foundation,
        });
        return { delegation: serialized };
      }, foundation);

      ctx.body = result;
      return next();
    },

    activeForUser: async (ctx, next) => {
      if ((ctx.method || 'GET') !== 'GET') throw fail('METHOD_NOT_ALLOWED', 405);
      const params = readParams(ctx);
      const { isRoot, organizationId, actor } = await resolveTenantActor(db, ctx, {
        requireOrg: true,
        requestedOrgId: params.organizationId,
        aclCollections: null,
        patScopes: ['read', 'write'],
      }, foundation);

      const targetUserId = params.userId != null ? Number(params.userId) : Number(actor.userId);
      if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
        throw fail('DELEGATION_USER_INVALID', 400, 'userId không hợp lệ.');
      }

      const nowDate = parseOptionalDate(params.now, 'DELEGATION_WINDOW_INVALID') || new Date();
      const nowMs = nowDate.getTime();
      const repo = db.getRepository?.('latticeDelegations');
      if (!repo) {
        ctx.body = { organizationId, userId: targetUserId, items: [], roles: [] };
        return next();
      }

      const rows = await runWithOptionalRls(db, organizationId, async (transaction) => {
        const adminOk = isRoot || (await isOrgAdmin(db, ctx));
        if (!adminOk && targetUserId !== Number(actor.userId)) {
          throw fail('DELEGATION_FORBIDDEN', 403, 'Không thể xem ủy quyền của người dùng khác.');
        }
        return (await repo.find({
          filter: { organizationId, delegateUserId: targetUserId, status: 'active', active: true },
          sort: ['-id'],
          limit: 200,
          ...(transaction ? { transaction } : {}),
        })) || [];
      }, foundation);

      const activeItems = rows
        .filter((r) => {
          if (val(r, 'organizationId') !== organizationId) return false;
          if (Number(val(r, 'delegateUserId')) !== targetUserId) return false;
          if (val(r, 'status') !== 'active' || val(r, 'active') === false) return false;
          const startMs = new Date(val(r, 'startsAt')).getTime();
          const endMs = new Date(val(r, 'endsAt')).getTime();
          return Number.isFinite(startMs) && Number.isFinite(endMs) && startMs <= nowMs && endMs > nowMs;
        })
        .map(serializeDelegation);

      const roles = [...new Set(activeItems.map((d) => d.roleName))];
      ctx.body = { organizationId, userId: targetUserId, items: activeItems, roles };
      return next();
    },
  };
}

async function resolveEffectiveDelegatedRoles(
  db,
  { organizationId, userId, scope = null, now = new Date() } = {},
  foundation = defaultFoundation,
) {
  const empty = {
    roles: [],
    delegations: [],
    delegatedRoles: [],
    matchedDelegations: [],
    primaryDelegation: null,
    delegatedFromUserId: null,
    delegationUid: null,
  };
  const cleanOrgId = typeof organizationId === 'string' ? organizationId.trim() : '';
  const uid = Number(userId);
  if (!cleanOrgId || !Number.isInteger(uid) || uid <= 0) return empty;

  const repo = db?.getRepository?.('latticeDelegations');
  if (!repo || typeof repo.find !== 'function') return empty;

  const nowDate = now instanceof Date ? now : new Date(now);
  const nowMs = nowDate.getTime();
  if (!Number.isFinite(nowMs)) return empty;

  const scopeList = Array.isArray(scope)
    ? scope.map((s) => String(s || '').trim()).filter(Boolean)
    : (typeof scope === 'string' && scope.trim() ? [scope.trim()] : []);
  const scopeSet = new Set(scopeList);

  const runQuery = async (transaction) => {
    const txOpt = transaction ? { transaction } : {};
    const rows = (await repo.find({
      filter: { organizationId: cleanOrgId, delegateUserId: uid, status: 'active', active: true },
      sort: ['-id'],
      limit: 200,
      ...txOpt,
    })) || [];
    if (!rows.length) return [];

    const rolesRepo = db?.getRepository?.('roles');
    const candidateRoles = [...new Set(rows.map((r) => String(val(r, 'roleName') || '').trim()).filter(Boolean))];
    const elevatedSet = new Set();
    if (rolesRepo && candidateRoles.length) {
      if (typeof rolesRepo.find === 'function') {
        const rRows = (await rolesRepo.find({ filter: { name: { $in: candidateRoles } }, ...txOpt })) || [];
        for (const rr of rRows) {
          if (isElevatedRoleRow(rr)) elevatedSet.add(String(val(rr, 'name') || '').trim());
        }
      } else if (typeof rolesRepo.findOne === 'function') {
        for (const rn of candidateRoles) {
          const rr = await rolesRepo.findOne({ filter: { name: rn }, ...txOpt });
          if (isElevatedRoleRow(rr)) elevatedSet.add(rn);
        }
      }
    }

    return rows
      .filter((r) => {
        if (val(r, 'organizationId') !== cleanOrgId) return false;
        if (Number(val(r, 'delegateUserId')) !== uid) return false;
        if (val(r, 'status') !== 'active' || val(r, 'active') === false) return false;
        const roleName = String(val(r, 'roleName') || '').trim();
        if (!roleName || FORBIDDEN_DELEGATION_ROLES.has(roleName.toLowerCase()) || elevatedSet.has(roleName)) {
          return false;
        }
        const startMs = new Date(val(r, 'startsAt')).getTime();
        const endMs = new Date(val(r, 'endsAt')).getTime();
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > nowMs || endMs <= nowMs) {
          return false;
        }
        const rowScope = val(r, 'scopeCollection') ? String(val(r, 'scopeCollection')).trim() : '';
        if (scopeSet.size > 0) {
          return !rowScope || scopeSet.has(rowScope);
        }
        return !rowScope;
      })
      .map(serializeDelegation)
      .sort((a, b) => Number(Boolean(b.scopeCollection)) - Number(Boolean(a.scopeCollection)));
  };

  const pgRls = foundation?.pgRls;
  const activeRls = typeof pgRls?.getActiveRlsContext === 'function' ? pgRls.getActiveRlsContext() : null;
  let matched;
  if (activeRls?.transaction && activeRls.sequelize === db?.sequelize) {
    matched = await runQuery(activeRls.transaction);
  } else if (typeof pgRls?.canUsePgRlsSession === 'function' && pgRls.canUsePgRlsSession(db)) {
    matched = typeof pgRls.withTenantRlsContext === 'function'
      ? await pgRls.withTenantRlsContext(db, cleanOrgId, runQuery)
      : await pgRls.withSystemRlsBypass(db, runQuery);
  } else {
    matched = await runQuery(null);
  }

  const roles = [...new Set(matched.map((d) => d.roleName))];
  const primaryDelegation = matched[0] || null;
  return {
    roles,
    delegations: matched,
    delegatedRoles: roles,
    matchedDelegations: matched,
    primaryDelegation,
    delegatedFromUserId: primaryDelegation?.delegatorUserId ?? null,
    delegationUid: primaryDelegation?.delegationUid ?? null,
  };
}

module.exports = {
  FORBIDDEN_DELEGATION_ROLES,
  MAX_DELEGATION_MS,
  isElevatedRoleRow,
  createDxosDelegationsActions,
  resolveEffectiveDelegatedRoles,
};
