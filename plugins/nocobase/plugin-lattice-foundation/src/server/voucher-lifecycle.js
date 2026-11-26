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
const { recordChatterEntry } = require('./record-chatter');
const { dispatchNotification, dispatchRoleNotifications, resolveNotificationTargetPath } = require('./notification-center');
const {
  canUsePgRlsSession,
  getActiveRlsContext,
  withSystemRlsBypass,
  withTenantRlsContext,
} = require('./pg-rls');

const VOUCHER_COLLECTIONS = new Set(['latticeRequests', 'latticeOrders', 'latticeServiceTickets']);
const VOUCHER_PRIVILEGED_ROLES = new Set(['root', 'admin', 'ldx_admin', 'ldx_manager', 'ldx_director']);
const IMMUTABLE_VOUCHER_STATUSES = new Set(['submitted', 'approved', 'completed', 'cancelled']);
const CANCELLABLE_VOUCHER_STATUSES = new Set(['submitted', 'approved', 'in_progress']);
const PROTECTED_VOUCHER_FIELDS = new Set([
  'id',
  'code',
  'organizationId',
  'status',
  'version',
  'requesterId',
  'assigneeId',
  'decisionReason',
  'submittedAt',
  'submittedBy',
  'cancelledAt',
  'cancelledBy',
  'cancelReason',
  'amendedFromId',
  'amendmentNo',
  'createdAt',
  'updatedAt',
  'deletedAt',
]);

const val = (row, key) => (typeof row?.get === 'function' ? row.get(key) : row?.[key]);
const toObj = (row) => (typeof row?.toJSON === 'function' ? row.toJSON() : { ...(row || {}) });

function failVoucher(code, status = 400, message = code) {
  return Object.assign(new Error(message), { code, status });
}

function readParams(ctx) {
  const p = ctx.action?.params || {};
  const v = p.values && typeof p.values === 'object' && !Array.isArray(p.values) ? p.values : {};
  return { ...p, ...v };
}

function buildAmendedCode(originalCode, amendmentNo) {
  const clean = String(originalCode || 'DOC').trim().replace(/-AMD\d+$/i, '');
  const suffix = `-AMD${Math.max(1, Number(amendmentNo) || 1)}`;
  const maxBase = Math.max(1, 100 - suffix.length);
  return `${clean.slice(0, maxBase)}${suffix}`;
}

function assertValidVoucherTarget(collection, id) {
  if (!VOUCHER_COLLECTIONS.has(collection)) {
    throw failVoucher('VOUCHER_COLLECTION_INVALID', 400, 'Chỉ hỗ trợ chứng từ latticeRequests, latticeOrders và latticeServiceTickets.');
  }
  const numId = Number(id);
  if (!Number.isInteger(numId) || numId <= 0) {
    throw failVoucher('VOUCHER_ID_REQUIRED', 400, 'Cần mã id chứng từ hợp lệ.');
  }
  return numId;
}

function parseOptionalVersion(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const trimmed = String(raw).trim();
  if (!/^[1-9]\d{0,9}$/.test(trimmed)) {
    throw failVoucher('INVALID_EXPECTED_VERSION', 400, 'Phiên bản expectedVersion không hợp lệ.');
  }
  return Number(trimmed);
}

async function resolveVoucherCaller(db, ctx, collection, id) {
  const recordId = assertValidVoucherTarget(collection, id);
  const isRoot = ctx.state?.currentRole === 'root';
  if (isRoot) {
    if (!ctx.state?.currentUser) throw failVoucher('NATIVE_LOGIN_REQUIRED', 401);
    const repo = db.getRepository(collection);
    const findRootVoucher = (transaction) => (repo ? repo.findOne({ filter: { id: recordId }, ...(transaction ? { transaction } : {}) }) : null);
    const row = canUsePgRlsSession(db) && !getActiveRlsContext()?.transaction
      ? await withSystemRlsBypass(db, findRootVoucher)
      : await findRootVoucher(getActiveRlsContext()?.transaction);
    if (!row) throw failVoucher('VOUCHER_NOT_FOUND', 404, 'Không tìm thấy chứng từ.');
    return {
      organizationId: val(row, 'organizationId'),
      recordId,
      actor: {
        userId: String(val(ctx.state.currentUser, 'id') || ''),
        employeeId: null,
        username: val(ctx.state.currentUser, 'username') || 'root',
        isRoot: true,
        roleNames: ['root'],
      },
    };
  }
  const actor = await resolveNativeActor(db, ctx.state?.currentUser);
  const inlineRoles = [];
  if (typeof ctx.state?.currentRole === 'string' && ctx.state.currentRole.trim()) {
    inlineRoles.push(ctx.state.currentRole.trim());
  }
  return {
    organizationId: actor.organizationId,
    recordId,
    actor: {
      ...actor,
      ...(inlineRoles.length ? { roleNames: Array.from(new Set([...(actor.roleNames || []), ...inlineRoles])) } : {}),
      username: val(ctx.state?.currentUser, 'username') || `employee-${actor.employeeId}`,
    },
  };
}

function loadCrossPluginDelegationEngine() {
  const path = require('node:path');
  const inDist = __dirname.includes(`${path.sep}dist${path.sep}`);
  const candidates = inDist
    ? [
        '@latticedx/plugin-dxos-studio/dist/server/delegation-engine',
        '@latticedx/plugin-dxos-studio/src/server/delegation-engine',
        '../../../plugin-dxos-studio/dist/server/delegation-engine',
        '../../../plugin-dxos-studio/src/server/delegation-engine',
      ]
    : [
        '@latticedx/plugin-dxos-studio/src/server/delegation-engine',
        '../../../plugin-dxos-studio/src/server/delegation-engine',
        '../../../plugin-dxos-studio/dist/server/delegation-engine',
      ];
  for (const modPath of candidates) {
    try {
      return require(modPath);
    } catch (err) {
      const isDirectMissing = err?.code === 'MODULE_NOT_FOUND'
        && (!Array.isArray(err.requireStack) || err.requireStack.length === 0 || err.requireStack[0] === __filename);
      if (!isDirectMissing) throw err;
    }
  }
  return null;
}

async function resolveVoucherAuthority(db, { organizationId, collection, row, actor, transaction, now = new Date() }) {
  if (!actor || typeof actor !== 'object') {
    throw failVoucher('VOUCHER_FORBIDDEN', 403, 'Cần thông tin người thao tác hợp lệ để thực hiện thao tác chứng từ.');
  }
  if (actor.isRoot || actor.isAdmin) {
    return { authorized: true, delegation: null };
  }
  const empId = actor.employeeId != null ? Number(actor.employeeId) : null;
  const reqId = val(row, 'requesterId') != null ? Number(val(row, 'requesterId')) : null;
  const asgId = val(row, 'assigneeId') != null ? Number(val(row, 'assigneeId')) : null;
  if (empId !== null && Number.isInteger(empId) && (empId === reqId || empId === asgId)) {
    return { authorized: true, delegation: null };
  }

  const directRoles = new Set(
    [
      ...(Array.isArray(actor.roleNames) ? actor.roleNames : []),
      ...(Array.isArray(actor.roles) ? actor.roles : []),
      ...(typeof actor.currentRole === 'string' ? [actor.currentRole] : []),
    ]
      .map((r) => String(r || '').trim())
      .filter(Boolean),
  );
  if ([...directRoles].some((r) => VOUCHER_PRIVILEGED_ROLES.has(r))) {
    return { authorized: true, delegation: null };
  }

  const rolesUsersRepo = db?.getRepository?.('rolesUsers');
  if (rolesUsersRepo && typeof rolesUsersRepo.find === 'function' && actor.userId != null) {
    const uidNum = Number(actor.userId);
    const uidFilterVal = Number.isInteger(uidNum) && uidNum > 0 ? uidNum : String(actor.userId);
    const roleRows = (await rolesUsersRepo.find({
      filter: { userId: uidFilterVal },
      ...(transaction ? { transaction } : {}),
      limit: 50,
    })) || [];
    for (const rr of roleRows) {
      const rn = String(val(rr, 'roleName') || '').trim();
      if (rn) directRoles.add(rn);
    }
    if ([...directRoles].some((r) => VOUCHER_PRIVILEGED_ROLES.has(r))) {
      return { authorized: true, delegation: null };
    }
  }

  if (actor.userId != null) {
    const delegationEngine = loadCrossPluginDelegationEngine();
    if (typeof delegationEngine?.resolveEffectiveDelegatedRoles === 'function') {
      const delRes = await delegationEngine.resolveEffectiveDelegatedRoles(
        db,
        { organizationId, userId: actor.userId, scope: collection, now },
        { pgRls: require('./pg-rls') },
      );
      const matchedPrivileged = (delRes?.matchedDelegations || []).find((d) =>
        VOUCHER_PRIVILEGED_ROLES.has(String(d?.roleName || '').trim()),
      );
      if (matchedPrivileged) {
        return { authorized: true, delegation: matchedPrivileged };
      }
    }
  }

  throw failVoucher(
    'VOUCHER_FORBIDDEN',
    403,
    'Không có quyền thực hiện thao tác trên chứng từ này (cần chủ chứng từ, vai trò quản lý hoặc ủy quyền hợp lệ).',
  );
}

async function findLockedVoucher(db, collection, id, organizationId, transaction) {
  const model = db.getModel?.(collection);
  if (model && typeof model.findOne === 'function') {
    const row = await model.findOne({
      where: { id, organizationId },
      ...(transaction ? { transaction, lock: transaction.LOCK?.UPDATE } : {}),
    });
    return row;
  }
  const repo = db.getRepository?.(collection);
  return repo ? repo.findOne({ filter: { id, organizationId }, transaction }) : null;
}

async function saveVoucherPatch(db, collection, id, organizationId, row, patch, transaction) {
  const repo = db.getRepository?.(collection);
  if (repo && typeof repo.update === 'function') {
    const res = await repo.update({ filterByTk: id, filter: { organizationId }, values: patch, transaction });
    if (Array.isArray(res) && res[0]) return toObj(res[0]);
  }
  if (typeof row?.update === 'function') {
    await row.update(patch, transaction ? { transaction } : undefined);
  }
  return { ...toObj(row), ...patch };
}

async function safeAppendVoucherLedger(db, { organizationId, eventType, collection, recordId, actor, payload, metadata = null }) {
  const { appendLedgerEntrySafely } = require('./pki-ledger');
  return appendLedgerEntrySafely(
    db,
    {
      organizationId,
      eventType,
      targetCollection: collection,
      targetRecordId: String(recordId),
      actor: {
        userId: actor?.userId ? String(actor.userId) : null,
        username: actor?.username || (actor?.employeeId ? `employee-${actor.employeeId}` : 'operator'),
      },
      payload,
      metadata,
    },
    { scope: 'lattice:voucher-lifecycle' },
  );
}

async function safeEmitVoucherEvent(db, { organizationId, eventType, collection, recordId, actor, payload }) {
  try {
    const { publishDomainEvent } = require('./event-bus');
    await publishDomainEvent(db, {
      organizationId,
      type: eventType,
      source: `latticedx/vouchers/${collection}`,
      subject: `${collection}:${recordId}`,
      data: {
        collection,
        recordId: Number(recordId) || recordId,
        code: payload?.code || null,
        status: payload?.status || null,
        version: payload?.version || null,
        actor: actor
          ? {
              userId: actor.userId || null,
              employeeId: actor.employeeId || null,
              username: actor.username || null,
            }
          : null,
        record: payload,
      },
    });
  } catch {
    // Non-fatal: voucher transitions must not fail when event bus repository is absent in isolated tests
  }
}

async function safeLogLifecycle(db, { organizationId, collection, recordId, body, actor, diffJson = null }) {
  try {
    await recordChatterEntry(db, {
      organizationId,
      targetCollection: collection,
      targetRecordId: recordId,
      entryType: 'lifecycle',
      body,
      mentionsJson: [],
      diffJson,
      authorUserId: actor?.userId ? Number(actor.userId) : null,
      authorEmployeeId: actor?.employeeId ? Number(actor.employeeId) : null,
      authorName: actor?.username || 'operator',
    });
  } catch (err) {
    const { isLedgerSecurityInvariant } = require('./pki-ledger');
    if (isLedgerSecurityInvariant(err)) throw err;
    console.error('[lattice:voucher-lifecycle] Lifecycle chatter failed:', err?.message || err);
  }
}

async function safeNotifyRequester(db, { organizationId, collection, recordId, requesterId, title, body, severity = 'info', dedupKey }) {
  if (requesterId == null) return;
  try {
    const empRepo = db?.getRepository?.('latticeEmployees');
    if (!empRepo) return;
    const findRequester = async (transaction) => {
      const txOpt = transaction ? { transaction } : {};
      if (typeof empRepo.findOne === 'function') {
        return empRepo.findOne({ filter: { id: Number(requesterId), organizationId, active: true }, ...txOpt });
      }
      if (typeof empRepo.find === 'function') {
        const list = (await empRepo.find({ filter: { id: Number(requesterId), organizationId, active: true }, limit: 1, ...txOpt })) || [];
        return list[0] || null;
      }
      return null;
    };
    const emp = canUsePgRlsSession(db) && !getActiveRlsContext()?.transaction && organizationId
      ? await withTenantRlsContext(db, organizationId, findRequester)
      : await findRequester(getActiveRlsContext()?.transaction);
    const uid = val(emp, 'userId');
    if (uid == null || !/^[1-9]\d*$/.test(String(uid))) return;
    await dispatchNotification(db, {
      organizationId,
      recipientUserId: Number(uid),
      recipientEmployeeId: Number(requesterId),
      category: 'voucher',
      severity,
      title,
      body,
      targetCollection: collection,
      targetRecordId: recordId,
      targetPath: resolveNotificationTargetPath(collection),
      dedupKey,
    });
  } catch {}
}

function runVoucherTenantTx(db, organizationId, fn) {
  if (canUsePgRlsSession(db) && !getActiveRlsContext()?.transaction && organizationId) {
    return withTenantRlsContext(db, organizationId, fn);
  }
  return db.sequelize.transaction(fn);
}

async function submitVoucher(db, { collection, id, organizationId, actor, expectedVersion = null, now = new Date() }) {
  const recordId = assertValidVoucherTarget(collection, id);
  const expVer = parseOptionalVersion(expectedVersion);
  const { updated, delegation } = await runVoucherTenantTx(db, organizationId, async (transaction) => {
    const row = await findLockedVoucher(db, collection, recordId, organizationId, transaction);
    if (!row) throw failVoucher('VOUCHER_NOT_FOUND', 404, 'Không tìm thấy chứng từ trong phạm vi tổ chức.');
    const authRes = await resolveVoucherAuthority(db, { organizationId, collection, row, actor, transaction, now });
    const curStatus = String(val(row, 'status') || 'draft').toLowerCase();
    if (curStatus !== 'draft') {
      throw failVoucher('VOUCHER_SUBMIT_INVALID_STATE', 409, 'Chỉ chứng từ ở trạng thái nháp (draft) mới được trình duyệt.');
    }
    const curVer = Number(val(row, 'version')) || 1;
    if (expVer !== null && curVer !== expVer) {
      throw failVoucher('VERSION_CONFLICT', 409, 'Bản ghi đã bị thay đổi bởi người khác.');
    }
    const patch = {
      status: 'submitted',
      submittedAt: new Date(),
      submittedBy: String(actor?.username || actor?.employeeId || 'operator').slice(0, 120),
      version: curVer + 1,
    };
    const saved = await saveVoucherPatch(db, collection, recordId, organizationId, row, patch, transaction);
    return { updated: saved, delegation: authRes.delegation };
  });
  const delMeta = delegation
    ? { delegatedFromUserId: delegation.delegatorUserId, delegationUid: delegation.delegationUid }
    : null;
  await safeLogLifecycle(db, {
    organizationId,
    collection,
    recordId,
    body: `Trình duyệt chứng từ ${updated.code || recordId} (draft -> submitted)`,
    actor,
    diffJson: delMeta,
  });
  await safeAppendVoucherLedger(db, {
    organizationId,
    eventType: 'voucher.submitted',
    collection,
    recordId,
    actor,
    payload: updated,
    metadata: delMeta,
  });
  await safeEmitVoucherEvent(db, {
    organizationId,
    eventType: 'voucher.submitted',
    collection,
    recordId,
    actor,
    payload: updated,
  });
  try {
    await dispatchRoleNotifications(db, {
      organizationId,
      roleNames: ['ldx_manager', 'ldx_admin'],
      category: 'voucher',
      severity: 'info',
      title: `Chứng từ ${updated.code || recordId} chờ duyệt`,
      body: `${actor?.username || 'Nhân viên'} đã trình duyệt ${collection} ${updated.code || `#${recordId}`}.`,
      targetCollection: collection,
      targetRecordId: recordId,
      targetPath: resolveNotificationTargetPath(collection),
      dedupKey: `voucher:${collection}:${recordId}:submit:v${updated.version || 1}`,
    });
  } catch {}
  return updated;
}

async function cancelVoucher(db, { collection, id, organizationId, actor, cancelReason = '', expectedVersion = null, now = new Date() }) {
  const recordId = assertValidVoucherTarget(collection, id);
  const expVer = parseOptionalVersion(expectedVersion);
  const reason = typeof cancelReason === 'string' ? cancelReason.trim() : '';
  if (reason.length < 3 || reason.length > 255) {
    throw failVoucher('VOUCHER_CANCEL_REASON_REQUIRED', 400, 'Cần lý do hủy chứng từ từ 3 đến 255 ký tự.');
  }
  const { updated, delegation } = await runVoucherTenantTx(db, organizationId, async (transaction) => {
    const row = await findLockedVoucher(db, collection, recordId, organizationId, transaction);
    if (!row) throw failVoucher('VOUCHER_NOT_FOUND', 404, 'Không tìm thấy chứng từ trong phạm vi tổ chức.');
    const authRes = await resolveVoucherAuthority(db, { organizationId, collection, row, actor, transaction, now });
    const curStatus = String(val(row, 'status') || 'draft').toLowerCase();
    if (!CANCELLABLE_VOUCHER_STATUSES.has(curStatus)) {
      throw failVoucher('VOUCHER_CANCEL_INVALID_STATE', 409, 'Chỉ được hủy chứng từ đang trình duyệt/đã duyệt/đang xử lý.');
    }
    const curVer = Number(val(row, 'version')) || 1;
    if (expVer !== null && curVer !== expVer) {
      throw failVoucher('VERSION_CONFLICT', 409, 'Bản ghi đã bị thay đổi bởi người khác.');
    }
    const patch = {
      status: 'cancelled',
      cancelledAt: new Date(),
      cancelledBy: String(actor?.username || actor?.employeeId || 'operator').slice(0, 120),
      cancelReason: reason,
      version: curVer + 1,
    };
    const saved = await saveVoucherPatch(db, collection, recordId, organizationId, row, patch, transaction);
    return { updated: saved, delegation: authRes.delegation };
  });
  const delMeta = delegation
    ? { delegatedFromUserId: delegation.delegatorUserId, delegationUid: delegation.delegationUid }
    : null;
  await safeLogLifecycle(db, {
    organizationId,
    collection,
    recordId,
    body: `Hủy chứng từ ${updated.code || recordId}: ${reason}`,
    actor,
    diffJson: delMeta,
  });
  await safeAppendVoucherLedger(db, {
    organizationId,
    eventType: 'voucher.cancelled',
    collection,
    recordId,
    actor,
    payload: updated,
    metadata: { cancelReason: reason, ...(delMeta || {}) },
  });
  await safeEmitVoucherEvent(db, {
    organizationId,
    eventType: 'voucher.cancelled',
    collection,
    recordId,
    actor,
    payload: updated,
  });
  await safeNotifyRequester(db, {
    organizationId,
    collection,
    recordId,
    requesterId: updated.requesterId,
    severity: 'warning',
    title: `Chứng từ ${updated.code || recordId} đã hủy`,
    body: `Lý do hủy: ${reason}`,
    dedupKey: `voucher:${collection}:${recordId}:cancel:v${updated.version || 1}`,
  });
  return updated;
}

async function amendVoucher(db, { collection, id, organizationId, actor, patch = {}, now = new Date() }) {
  const recordId = assertValidVoucherTarget(collection, id);
  const created = await runVoucherTenantTx(db, organizationId, async (transaction) => {
    const row = await findLockedVoucher(db, collection, recordId, organizationId, transaction);
    if (!row) throw failVoucher('VOUCHER_NOT_FOUND', 404, 'Không tìm thấy chứng từ trong phạm vi tổ chức.');
    const authRes = await resolveVoucherAuthority(db, { organizationId, collection, row, actor, transaction, now });
    const source = toObj(row);
    if (String(source.status || '').toLowerCase() !== 'cancelled') {
      throw failVoucher('VOUCHER_AMEND_REQUIRES_CANCELLED', 409, 'Chỉ được lập bản điều chỉnh (Amend) từ chứng từ đã Hủy (cancelled).');
    }
    const repo = db.getRepository(collection);
    const existingChild = await repo.findOne({ filter: { organizationId, amendedFromId: recordId }, transaction });
    if (existingChild) {
      throw failVoucher('VOUCHER_ALREADY_AMENDED', 409, 'Chứng từ đã có bản điều chỉnh kế tiếp.');
    }

    const nextAmendmentNo = (Number(source.amendmentNo) || 0) + 1;
    const nextCode = buildAmendedCode(source.code, nextAmendmentNo);
    const values = {};
    for (const [k, v] of Object.entries(source)) {
      if (PROTECTED_VOUCHER_FIELDS.has(k)) continue;
      if (v === undefined || (v !== null && typeof v === 'object')) continue;
      values[k] = v;
    }
    if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
      for (const [k, v] of Object.entries(patch)) {
        if (PROTECTED_VOUCHER_FIELDS.has(k)) continue;
        if (v !== null && typeof v === 'object') continue;
        values[k] = v;
      }
    }
    values.code = nextCode;
    values.organizationId = organizationId;
    values.status = 'draft';
    values.version = 1;
    values.amendedFromId = Number(recordId);
    values.amendmentNo = nextAmendmentNo;
    if (actor?.employeeId != null) values.requesterId = Number(actor.employeeId);
    else if (source.requesterId != null) values.requesterId = Number(source.requesterId);

    const inserted = await repo.create({ values, transaction });
    return { source, amended: toObj(inserted), delegation: authRes.delegation };
  });

  const delMeta = created.delegation
    ? { delegatedFromUserId: created.delegation.delegatorUserId, delegationUid: created.delegation.delegationUid }
    : null;
  await safeLogLifecycle(db, {
    organizationId,
    collection,
    recordId,
    body: `Lập bản điều chỉnh ${created.amended.code} từ chứng từ đã hủy ${created.source.code}`,
    actor,
    diffJson: delMeta,
  });
  await safeLogLifecycle(db, {
    organizationId,
    collection,
    recordId: created.amended.id,
    body: `Khởi tạo bản điều chỉnh #${created.amended.amendmentNo} từ ${created.source.code} (ID ${recordId})`,
    actor,
    diffJson: delMeta,
  });
  await safeAppendVoucherLedger(db, {
    organizationId,
    eventType: 'voucher.amended',
    collection,
    recordId: created.amended.id,
    actor,
    payload: created.amended,
    metadata: { amendedFromId: recordId, amendmentNo: created.amended.amendmentNo, ...(delMeta || {}) },
  });
  await safeEmitVoucherEvent(db, {
    organizationId,
    eventType: 'voucher.amended',
    collection,
    recordId: created.amended.id,
    actor,
    payload: created.amended,
  });
  await safeNotifyRequester(db, {
    organizationId,
    collection,
    recordId: created.amended.id,
    requesterId: created.source.requesterId ?? created.amended.requesterId,
    severity: 'info',
    title: `Đã lập bản điều chỉnh ${created.amended.code}`,
    body: `Khởi tạo lần #${created.amended.amendmentNo} từ chứng từ ${created.source.code || `#${recordId}`}.`,
    dedupKey: `voucher:${collection}:${created.amended.id}:amend`,
  });
  return created.amended;
}

async function getVoucherLineage(db, { collection, id, organizationId }) {
  const recordId = assertValidVoucherTarget(collection, id);
  const repo = db.getRepository(collection);
  const readLineage = async (transaction) => {
    const txOpt = transaction ? { transaction } : {};
    const anchor = await repo.findOne({ filter: { id: recordId, organizationId }, ...txOpt });
    if (!anchor) throw failVoucher('VOUCHER_NOT_FOUND', 404, 'Không tìm thấy chứng từ trong phạm vi tổ chức.');

    let root = toObj(anchor);
    const visitedUp = new Set([Number(root.id)]);
    for (let i = 0; i < 50 && root.amendedFromId != null; i += 1) {
      const parentId = Number(root.amendedFromId);
      if (!Number.isInteger(parentId) || visitedUp.has(parentId)) break;
      visitedUp.add(parentId);
      const parent = await repo.findOne({ filter: { id: parentId, organizationId }, ...txOpt });
      if (!parent) break;
      root = toObj(parent);
    }

    const items = [root];
    const seen = new Set([Number(root.id)]);
    let curId = Number(root.id);
    for (let i = 0; i < 50; i += 1) {
      const nextRow = await repo.findOne({ filter: { organizationId, amendedFromId: curId }, ...txOpt });
      if (!nextRow) break;
      const obj = toObj(nextRow);
      const nid = Number(obj.id);
      if (seen.has(nid)) break;
      seen.add(nid);
      items.push(obj);
      curId = nid;
    }

    return { collection, rootId: Number(root.id), items };
  };
  if (canUsePgRlsSession(db) && !getActiveRlsContext()?.transaction && organizationId) {
    return withTenantRlsContext(db, organizationId, readLineage);
  }
  return readLineage(getActiveRlsContext()?.transaction);
}

function registerVoucherLifecycleResource(app) {
  const db = app.db;
  app.resourceManager.define({
    name: 'latticeVoucher',
    actions: {
      submit: async (ctx, next) => {
        if ((ctx.method || 'POST') !== 'POST') ctx.throw(405);
        const params = readParams(ctx);
        const collection = String(params.collection || '').trim();
        const { organizationId, recordId, actor } = await resolveVoucherCaller(db, ctx, collection, params.id);
        ctx.body = await submitVoucher(db, {
          collection,
          id: recordId,
          organizationId,
          actor,
          expectedVersion: params.expectedVersion,
        });
        return next();
      },
      cancel: async (ctx, next) => {
        if ((ctx.method || 'POST') !== 'POST') ctx.throw(405);
        const params = readParams(ctx);
        const collection = String(params.collection || '').trim();
        const { organizationId, recordId, actor } = await resolveVoucherCaller(db, ctx, collection, params.id);
        ctx.body = await cancelVoucher(db, {
          collection,
          id: recordId,
          organizationId,
          actor,
          cancelReason: params.cancelReason ?? params.reason,
          expectedVersion: params.expectedVersion,
        });
        return next();
      },
      amend: async (ctx, next) => {
        if ((ctx.method || 'POST') !== 'POST') ctx.throw(405);
        const params = readParams(ctx);
        const collection = String(params.collection || '').trim();
        const { organizationId, recordId, actor } = await resolveVoucherCaller(db, ctx, collection, params.id);
        ctx.body = await amendVoucher(db, {
          collection,
          id: recordId,
          organizationId,
          actor,
          patch: params.patch,
        });
        return next();
      },
      lineage: async (ctx, next) => {
        if ((ctx.method || 'GET') !== 'GET') ctx.throw(405);
        const params = readParams(ctx);
        const collection = String(params.collection || '').trim();
        const { organizationId, recordId } = await resolveVoucherCaller(db, ctx, collection, params.id);
        ctx.body = await getVoucherLineage(db, { collection, id: recordId, organizationId });
        return next();
      },
    },
  });
  app.acl.allow('latticeVoucher', ['submit', 'cancel', 'amend', 'lineage'], 'loggedIn');
}

module.exports = {
  VOUCHER_COLLECTIONS,
  IMMUTABLE_VOUCHER_STATUSES,
  CANCELLABLE_VOUCHER_STATUSES,
  buildAmendedCode,
  submitVoucher,
  cancelVoucher,
  amendVoucher,
  getVoucherLineage,
  registerVoucherLifecycleResource,
};
