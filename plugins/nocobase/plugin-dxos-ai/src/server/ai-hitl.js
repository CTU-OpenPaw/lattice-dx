/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { recordAiAuditLog, sanitizeAuditSummary } = require('./ai-schemas');

const VALID_TOOL_MODES = new Set(['ALLOW', 'ASK', 'OFF']);
const VALID_RISK_LEVELS = new Set(['low', 'medium', 'high', 'critical']);
const HITL_APPROVER_ROLES = new Set(['root', 'admin', 'ldx_admin', 'ldx_director', 'ldx_manager']);
const HIGH_RISK_FIELDS = new Set(['auditVerdict', 'totalAmount', 'amount', 'price', 'unitPrice', 'quantity', 'verdict', 'severity']);
const DEFAULT_HITL_TTL_MS = 24 * 60 * 60 * 1000;

const inFlightClaims = new Set();

const val = (row, key) => (typeof row?.get === 'function' ? row.get(key) : row?.[key]);

function failHitl(code, status = 400, message = code) {
  return Object.assign(new Error(message || code), { code, status });
}

function isRootActor(actor) {
  if (!actor) return false;
  if (actor.isRoot === true) return true;
  if (actor.isRoot === false) return false;
  return Array.isArray(actor.roleNames) && actor.roleNames.includes('root');
}

function isHitlApprover(actor) {
  if (!actor) return false;
  if (actor.isAdmin === true || isRootActor(actor)) return true;
  return Array.isArray(actor.roleNames) && actor.roleNames.some((r) => HITL_APPROVER_ROLES.has(r));
}

function normalizeToolMode(raw, fallback = 'ASK') {
  const safeFallback = VALID_TOOL_MODES.has(String(fallback || '').toUpperCase())
    ? String(fallback).toUpperCase()
    : 'ASK';
  const candidate = String(raw || '').trim().toUpperCase();
  return VALID_TOOL_MODES.has(candidate) ? candidate : safeFallback;
}

async function resolveEffectiveToolMode(db, { aiEmployee = null, toolName = '', defaultPermission = 'ASK' } = {}) {
  const fallback = normalizeToolMode(defaultPermission, 'ASK');
  const empName = String(aiEmployee || '').trim().toLowerCase();
  const targetTool = String(toolName || '').trim();
  if (!empName || !targetTool) return fallback;

  const repo = db?.getRepository?.('latticeAiProfiles');
  if (!repo || typeof repo.findOne !== 'function') return fallback;

  const profile = await repo.findOne({ filter: { username: empName } });
  if (!profile) return fallback;
  if (val(profile, 'enabled') === false) return 'OFF';

  const perms = val(profile, 'toolPermissions');
  if (perms && typeof perms === 'object' && !Array.isArray(perms)) {
    if (Object.prototype.hasOwnProperty.call(perms, targetTool)) {
      return normalizeToolMode(perms[targetTool], 'OFF');
    }
    return 'OFF';
  }
  return fallback;
}

function buildDiffPreview({ collection, operation, recordId = null, existing = null, values = {} } = {}) {
  const safeAfter = sanitizeAuditSummary(values || {});
  const before = operation === 'update' && existing ? {} : null;
  const changes = [];
  for (const [field, nextVal] of Object.entries(safeAfter || {})) {
    const prevVal = operation === 'update' && existing ? (val(existing, field) ?? null) : null;
    if (before) before[field] = prevVal;
    changes.push({ field, before: prevVal, after: nextVal });
  }
  return {
    collection: String(collection || ''),
    operation: String(operation || 'update'),
    recordId: recordId != null ? Number(recordId) : null,
    recordCode: existing ? (val(existing, 'code') || null) : (safeAfter?.code || null),
    before,
    after: safeAfter,
    changes,
  };
}

function computeRiskLevel({ operation = 'update', values = {}, requireApproval = false, existing = null } = {}) {
  if (requireApproval === true) return 'high';
  const keys = Object.keys(values || {});
  if (keys.some((k) => HIGH_RISK_FIELDS.has(k))) return 'high';
  if (operation === 'update' && existing) {
    const status = String(val(existing, 'status') || 'draft').toLowerCase();
    if (status !== 'draft') return 'high';
  }
  return 'medium';
}

function serializeApprovalRow(row) {
  if (!row) return null;
  const rawId = val(row, 'id');
  const rawReqUser = val(row, 'requesterUserId');
  const rawDecUser = val(row, 'decidedByUserId');
  const rawRecId = val(row, 'targetRecordId');
  return {
    id: rawId != null ? Number(rawId) : null,
    organizationId: val(row, 'organizationId') || null,
    requesterUserId: rawReqUser != null ? Number(rawReqUser) : null,
    requesterUsername: val(row, 'requesterUsername') || null,
    aiEmployee: val(row, 'aiEmployee') || null,
    toolName: val(row, 'toolName') || '',
    targetCollection: val(row, 'targetCollection') || '',
    targetRecordId: rawRecId != null ? Number(rawRecId) : null,
    operation: val(row, 'operation') || 'update',
    proposedArgs: val(row, 'proposedArgs') || {},
    diffPreview: val(row, 'diffPreview') || {},
    riskLevel: val(row, 'riskLevel') || 'medium',
    status: val(row, 'status') || 'pending',
    decidedByUserId: rawDecUser != null ? Number(rawDecUser) : null,
    decidedByUsername: val(row, 'decidedByUsername') || null,
    decisionNote: val(row, 'decisionNote') || null,
    decidedAt: val(row, 'decidedAt') || null,
    executionResult: val(row, 'executionResult') || null,
    expiresAt: val(row, 'expiresAt') || null,
    createdAt: val(row, 'createdAt') || null,
    updatedAt: val(row, 'updatedAt') || null,
  };
}

async function resolveOrgApproverTargets(db, organizationId, requesterUserId) {
  const empRepo = db?.getRepository?.('latticeEmployees');
  if (!empRepo || typeof empRepo.find !== 'function') return [];
  const employees = (await empRepo.find({ filter: { organizationId, active: true }, limit: 1000 })) || [];
  const candidates = [];
  for (const emp of employees) {
    if (val(emp, 'active') !== true || val(emp, 'organizationId') !== organizationId) continue;
    const uid = val(emp, 'userId');
    if (uid == null || !/^[1-9]\d*$/.test(String(uid))) continue;
    if (requesterUserId != null && Number(uid) === Number(requesterUserId)) continue;
    candidates.push({ employeeId: Number(val(emp, 'id')), userId: Number(uid) });
  }
  if (!candidates.length) return [];

  const userIds = [...new Set(candidates.map((c) => c.userId))];
  const allowedUserIds = new Set();
  const ruRepo = db?.getRepository?.('rolesUsers');
  if (ruRepo && typeof ruRepo.find === 'function') {
    const bindings = (await ruRepo.find({
      filter: { userId: { $in: userIds }, roleName: { $in: [...HITL_APPROVER_ROLES] } },
      limit: 2000,
    })) || [];
    for (const row of bindings) {
      const uid = Number(val(row, 'userId'));
      const rName = String(val(row, 'roleName') || '').trim();
      if (userIds.includes(uid) && HITL_APPROVER_ROLES.has(rName)) {
        allowedUserIds.add(uid);
      }
    }
  } else {
    const usersRepo = db?.getRepository?.('users');
    if (usersRepo && typeof usersRepo.find === 'function') {
      const users = (await usersRepo.find({ filter: { id: { $in: userIds } }, appends: ['roles'], limit: 1000 })) || [];
      for (const u of users) {
        const uid = Number(val(u, 'id'));
        const uRoles = Array.isArray(val(u, 'roles')) ? val(u, 'roles') : [];
        if (uRoles.some((r) => HITL_APPROVER_ROLES.has(typeof r === 'string' ? r : val(r, 'name')))) {
          allowedUserIds.add(uid);
        }
      }
    }
  }

  const seen = new Set();
  return candidates.filter((c) => {
    if (!allowedUserIds.has(c.userId) || seen.has(c.userId)) return false;
    seen.add(c.userId);
    return true;
  });
}

async function notifyApproversOfPendingApproval(db, row) {
  try {
    const notifRepo = db?.getRepository?.('latticeNotifications');
    if (!notifRepo || typeof notifRepo.create !== 'function') return [];
    const organizationId = val(row, 'organizationId');
    const approvalId = val(row, 'id');
    const requesterUserId = val(row, 'requesterUserId');
    const requesterUsername = val(row, 'requesterUsername') || `user-${requesterUserId}`;
    const aiEmployee = val(row, 'aiEmployee') || 'AI Copilot';
    const targetCollection = val(row, 'targetCollection');
    const targetRecordId = val(row, 'targetRecordId');
    const operation = val(row, 'operation') || 'update';
    const riskLevel = String(val(row, 'riskLevel') || 'medium').toLowerCase();

    const targets = await resolveOrgApproverTargets(db, organizationId, requesterUserId);
    if (!targets.length) return [];

    const severity = riskLevel === 'critical' || riskLevel === 'high' ? 'warning' : 'info';
    const recordTag = targetRecordId != null ? ` #${targetRecordId}` : '';
    const title = `Yêu cầu AI chờ duyệt (${operation} ${targetCollection})`.slice(0, 255);
    const body = `${requesterUsername} qua ${aiEmployee} đề xuất ${operation} trên ${targetCollection}${recordTag}.`.slice(0, 4000);
    const created = [];
    for (const target of targets) {
      const item = await notifRepo.create({
        values: {
          organizationId,
          recipientUserId: target.userId,
          recipientEmployeeId: target.employeeId,
          category: 'approval',
          severity,
          title,
          body,
          targetCollection: 'latticeAiApprovalQueue',
          targetRecordId: approvalId != null && /^[1-9]\d*$/.test(String(approvalId)) ? Number(approvalId) : null,
          targetPath: '/admin/settings/dxos-ai',
          dedupKey: `hitl-approval:${organizationId}:${approvalId}`,
          channelsDispatched: ['in_app'],
          active: true,
        },
      });
      created.push(item);
    }
    return created;
  } catch {
    return [];
  }
}

async function enqueueAiApproval(db, {
  actor,
  aiEmployee = null,
  toolName,
  targetCollection,
  targetRecordId = null,
  operation = 'update',
  proposedArgs = {},
  diffPreview = {},
  riskLevel = 'medium',
  ttlMs = DEFAULT_HITL_TTL_MS,
} = {}) {
  if (!actor?.userId) throw failHitl('NATIVE_LOGIN_REQUIRED', 401, 'Yêu cầu đăng nhập.');
  if (!actor?.organizationId) throw failHitl('ORG_MEMBERSHIP_REQUIRED', 403, 'Cần phạm vi tổ chức hợp lệ.');
  if (!toolName || !targetCollection) throw failHitl('HITL_PAYLOAD_INVALID', 400, 'Thiếu toolName hoặc targetCollection.');

  const repo = db?.getRepository?.('latticeAiApprovalQueue');
  if (!repo || typeof repo.create !== 'function') {
    throw failHitl('HITL_QUEUE_UNAVAILABLE', 503, 'Hàng chờ phê duyệt AI (latticeAiApprovalQueue) chưa sẵn sàng.');
  }

  const normalizedRisk = VALID_RISK_LEVELS.has(String(riskLevel || '').toLowerCase())
    ? String(riskLevel).toLowerCase()
    : 'medium';
  const safeTtl = Math.max(60_000, Number(ttlMs) || DEFAULT_HITL_TTL_MS);
  const expiresAt = new Date(Date.now() + safeTtl);

  const created = await repo.create({
    values: {
      organizationId: String(actor.organizationId),
      requesterUserId: Number(actor.userId),
      requesterUsername: String(actor.username || `user-${actor.userId}`).slice(0, 120),
      aiEmployee: aiEmployee ? String(aiEmployee).slice(0, 80) : null,
      toolName: String(toolName).slice(0, 120),
      targetCollection: String(targetCollection).slice(0, 120),
      targetRecordId: targetRecordId != null && /^[1-9]\d*$/.test(String(targetRecordId)) ? Number(targetRecordId) : null,
      operation: String(operation || 'update').slice(0, 32),
      proposedArgs,
      diffPreview: sanitizeAuditSummary(diffPreview || {}),
      riskLevel: normalizedRisk,
      status: 'pending',
      expiresAt,
    },
  });

  const serialized = serializeApprovalRow(created);
  await notifyApproversOfPendingApproval(db, created);
  await recordAiAuditLog(db, {
    actorUserId: actor.userId,
    actorUsername: actor.username,
    organizationId: actor.organizationId,
    channel: 'hitl-approval',
    aiEmployee,
    toolName: String(toolName),
    argsSummary: { approvalId: serialized.id, targetCollection, targetRecordId, operation },
    status: 'pending',
    resultSummary: `Enqueued HITL approval #${serialized.id} (${operation} ${targetCollection})`,
  });
  return serialized;
}

async function listApprovals(db, { actor, status = 'pending', limit = 50, organizationId = null } = {}) {
  if (!actor?.userId) throw failHitl('NATIVE_LOGIN_REQUIRED', 401, 'Yêu cầu đăng nhập.');
  const repo = db?.getRepository?.('latticeAiApprovalQueue');
  if (!repo || typeof repo.find !== 'function') return [];

  const root = isRootActor(actor);
  const approver = isHitlApprover(actor);
  const scopedOrg = root
    ? (organizationId ? String(organizationId).trim() : null)
    : String(actor.organizationId || '');
  if (!root && !scopedOrg) throw failHitl('ORG_MEMBERSHIP_REQUIRED', 403, 'Thiếu phạm vi tổ chức.');

  const cleanStatus = status && String(status).trim().toLowerCase() !== 'all'
    ? String(status).trim().toLowerCase()
    : null;
  const cap = Math.max(1, Math.min(200, Number(limit) || 50));

  const filter = {
    ...(scopedOrg ? { organizationId: scopedOrg } : {}),
    ...(!approver ? { requesterUserId: Number(actor.userId) } : {}),
    ...(cleanStatus ? { status: cleanStatus } : {}),
  };

  const rows = (await repo.find({ filter, sort: ['-id'], limit: cap })) || [];
  return rows
    .filter((row) => {
      if (scopedOrg && val(row, 'organizationId') !== scopedOrg) return false;
      if (!approver && Number(val(row, 'requesterUserId')) !== Number(actor.userId)) return false;
      if (cleanStatus && String(val(row, 'status') || '').toLowerCase() !== cleanStatus) return false;
      return true;
    })
    .slice(0, cap)
    .map(serializeApprovalRow);
}

async function updateQueueRow(db, repo, row, numericId, patch, { onlyIfPending = false } = {}) {
  const model = db?.getModel?.('latticeAiApprovalQueue');
  if (model && typeof model.update === 'function') {
    await model.update(patch, { where: { id: numericId, ...(onlyIfPending ? { status: 'pending' } : {}) } });
    return;
  }
  if (repo && typeof repo.update === 'function') {
    await repo.update({
      filterByTk: numericId,
      ...(onlyIfPending ? { filter: { id: numericId, status: 'pending' } } : {}),
      values: patch,
    });
    return;
  }
  if (typeof row?.update === 'function') {
    if (onlyIfPending && val(row, 'status') !== 'pending') return;
    await row.update(patch);
  }
}

async function claimPendingApprovalAtomically(db, repo, row, numericId, root, actor, claimPatch) {
  const model = db?.getModel?.('latticeAiApprovalQueue');
  if (model && typeof model.update === 'function') {
    const where = { id: numericId, status: 'pending', ...(root ? {} : { organizationId: actor.organizationId }) };
    const res = await model.update(claimPatch, { where });
    const affected = Array.isArray(res) ? Number(res[0] ?? 0) : Number(res || 0);
    if (affected !== 1) {
      throw failHitl('HITL_ALREADY_DECIDED', 409, 'Yêu cầu phê duyệt đã được xử lý trước đó.');
    }
    return;
  }

  if (typeof db?.sequelize?.query === 'function' && typeof db?.sequelize?.getDialect === 'function') {
    const orgClause = root ? '' : ' AND "organizationId" = :organizationId';
    const [rows] = await db.sequelize.query(
      `UPDATE "latticeAiApprovalQueue"
       SET status = :status,
           "decidedByUserId" = :decidedByUserId,
           "decidedByUsername" = :decidedByUsername,
           "decisionNote" = :decisionNote,
           "decidedAt" = :decidedAt,
           "updatedAt" = NOW()
       WHERE id = :id
         AND status = 'pending'${orgClause}
       RETURNING id;`,
      {
        replacements: {
          id: numericId,
          status: claimPatch.status,
          decidedByUserId: claimPatch.decidedByUserId,
          decidedByUsername: claimPatch.decidedByUsername,
          decisionNote: claimPatch.decisionNote,
          decidedAt: claimPatch.decidedAt,
          ...(root ? {} : { organizationId: actor.organizationId }),
        },
      },
    );
    if (!Array.isArray(rows) || rows.length !== 1) {
      throw failHitl('HITL_ALREADY_DECIDED', 409, 'Yêu cầu phê duyệt đã được xử lý trước đó.');
    }
    return;
  }

  const fresh = await repo.findOne({
    filter: root ? { id: numericId } : { id: numericId, organizationId: actor.organizationId },
  });
  if (!fresh || (!root && val(fresh, 'organizationId') !== actor.organizationId) || val(fresh, 'status') !== 'pending') {
    throw failHitl('HITL_ALREADY_DECIDED', 409, 'Yêu cầu phê duyệt đã được xử lý trước đó.');
  }

  if (repo && typeof repo.update === 'function') {
    const upd = await repo.update({
      filter: { id: numericId, status: 'pending', ...(root ? {} : { organizationId: actor.organizationId }) },
      values: claimPatch,
    });
    if (Array.isArray(upd) && upd.length === 0) {
      throw failHitl('HITL_ALREADY_DECIDED', 409, 'Yêu cầu phê duyệt đã được xử lý trước đó.');
    }
    return;
  }

  if (typeof row?.update === 'function') {
    await row.update(claimPatch);
  }
}

async function decideApproval(db, { actor, approvalId, decision, note = '', executeApprovedWrite } = {}) {
  if (!actor?.userId) throw failHitl('NATIVE_LOGIN_REQUIRED', 401, 'Yêu cầu đăng nhập.');
  if (!isHitlApprover(actor)) {
    throw failHitl('HITL_APPROVER_ROLE_REQUIRED', 403, 'Chỉ Quản lý hoặc Quản trị viên mới có quyền phê duyệt AI.');
  }

  const normalizedDecision = String(decision || '').trim().toLowerCase();
  if (normalizedDecision !== 'approve' && normalizedDecision !== 'reject') {
    throw failHitl('HITL_INVALID_DECISION', 400, 'Quyết định phải là approve hoặc reject.');
  }

  const numericId = Number(approvalId);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    throw failHitl('HITL_APPROVAL_ID_REQUIRED', 400, 'Cần mã approvalId hợp lệ.');
  }

  const cleanNote = String(note || '').trim().slice(0, 255);
  if (normalizedDecision === 'reject' && cleanNote.length < 3) {
    throw failHitl('HITL_REJECTION_NOTE_REQUIRED', 400, 'Vui lòng nhập lý do từ chối tối thiểu 3 ký tự.');
  }

  const repo = db?.getRepository?.('latticeAiApprovalQueue');
  if (!repo || typeof repo.findOne !== 'function') {
    throw failHitl('HITL_QUEUE_UNAVAILABLE', 503, 'Hàng chờ phê duyệt AI chưa sẵn sàng.');
  }

  const claimKey = String(numericId);
  if (inFlightClaims.has(claimKey)) {
    throw failHitl('HITL_ALREADY_DECIDED', 409, 'Yêu cầu phê duyệt đang được xử lý đồng thời.');
  }
  inFlightClaims.add(claimKey);

  try {
    const root = isRootActor(actor);
    const row = await repo.findOne({
      filter: root ? { id: numericId } : { id: numericId, organizationId: actor.organizationId },
    });
    if (!row || (!root && val(row, 'organizationId') !== actor.organizationId)) {
      throw failHitl('HITL_APPROVAL_NOT_FOUND', 404, 'Không tìm thấy yêu cầu phê duyệt trong phạm vi tổ chức.');
    }

    const rowOrg = val(row, 'organizationId');
    const currentStatus = String(val(row, 'status') || '');
    if (currentStatus !== 'pending') {
      throw failHitl('HITL_ALREADY_DECIDED', 409, `Yêu cầu phê duyệt đã ở trạng thái "${currentStatus}".`);
    }

    const expRaw = val(row, 'expiresAt');
    const expMs = expRaw ? new Date(expRaw).getTime() : NaN;
    if (Number.isFinite(expMs) && expMs <= Date.now()) {
      await updateQueueRow(db, repo, row, numericId, { status: 'expired' }, { onlyIfPending: true }).catch(() => {});
      throw failHitl('HITL_APPROVAL_EXPIRED', 409, 'Yêu cầu phê duyệt đã hết hạn.');
    }

    if (!root && Number(val(row, 'requesterUserId')) === Number(actor.userId)) {
      await recordAiAuditLog(db, {
        actorUserId: actor.userId,
        actorUsername: actor.username,
        organizationId: rowOrg,
        channel: 'hitl-approval',
        aiEmployee: val(row, 'aiEmployee') || null,
        toolName: val(row, 'toolName'),
        argsSummary: { approvalId: numericId, decision: normalizedDecision },
        status: 'denied',
        errorCode: 'SELF_APPROVAL_FORBIDDEN',
        resultSummary: 'Blocked self-approval on AI HITL queue request',
      });
      throw failHitl('SELF_APPROVAL_FORBIDDEN', 403, 'Không được phép tự phê duyệt yêu cầu AI do chính mình khởi tạo.');
    }

    const now = new Date();
    const baseDecisionMeta = {
      decidedByUserId: Number(actor.userId),
      decidedByUsername: String(actor.username || `user-${actor.userId}`).slice(0, 120),
      decisionNote: cleanNote || null,
      decidedAt: now,
    };

    const nextClaimStatus = normalizedDecision === 'reject' ? 'rejected' : 'executing';
    await claimPendingApprovalAtomically(db, repo, row, numericId, root, actor, {
      status: nextClaimStatus,
      ...baseDecisionMeta,
    });

    const plainRow = serializeApprovalRow(row);

    if (normalizedDecision === 'reject') {
      await recordAiAuditLog(db, {
        actorUserId: actor.userId,
        actorUsername: actor.username,
        organizationId: rowOrg,
        channel: 'hitl-approval',
        aiEmployee: plainRow.aiEmployee,
        toolName: plainRow.toolName,
        argsSummary: {
          approvalId: numericId,
          decision: 'reject',
          targetCollection: plainRow.targetCollection,
          targetRecordId: plainRow.targetRecordId,
          note: cleanNote,
        },
        status: 'rejected',
        errorCode: 'HITL_REJECTED',
        resultSummary: `Rejected HITL #${numericId}: ${cleanNote}`,
      });
      return {
        ...plainRow,
        ...baseDecisionMeta,
        decidedAt: now.toISOString(),
        status: 'rejected',
      };
    }

    let execResult;
    try {
      execResult = typeof executeApprovedWrite === 'function'
        ? await executeApprovedWrite(plainRow)
        : { approvedOnly: true };
    } catch (err) {
      if (err?.status === 403) {
        await updateQueueRow(db, repo, row, numericId, {
          status: 'pending',
          decidedByUserId: null,
          decidedByUsername: null,
          decisionNote: null,
          decidedAt: null,
        }).catch(() => {});
      } else {
        await updateQueueRow(db, repo, row, numericId, {
          status: 'failed',
          executionResult: {
            errorCode: err?.code || 'HITL_EXECUTION_ERROR',
            message: String(err?.message || 'Execution failed').slice(0, 400),
          },
        }).catch(() => {});
      }
      await recordAiAuditLog(db, {
        actorUserId: actor.userId,
        actorUsername: actor.username,
        organizationId: rowOrg,
        channel: 'hitl-approval',
        aiEmployee: plainRow.aiEmployee,
        toolName: plainRow.toolName,
        argsSummary: {
          approvalId: numericId,
          decision: 'approve',
          targetCollection: plainRow.targetCollection,
          targetRecordId: plainRow.targetRecordId,
        },
        status: err?.status === 403 || err?.status === 401 ? 'denied' : 'error',
        errorCode: err?.code || 'HITL_EXECUTION_ERROR',
        resultSummary: String(err?.message || 'HITL execution failed').slice(0, 400),
      });
      throw err;
    }

    const safeResult = sanitizeAuditSummary(execResult ?? { ok: true });
    await updateQueueRow(db, repo, row, numericId, {
      status: 'executed',
      executionResult: safeResult,
    });

    await recordAiAuditLog(db, {
      actorUserId: actor.userId,
      actorUsername: actor.username,
      organizationId: rowOrg,
      channel: 'hitl-approval',
      aiEmployee: plainRow.aiEmployee,
      toolName: plainRow.toolName,
      argsSummary: {
        approvalId: numericId,
        decision: 'approve',
        targetCollection: plainRow.targetCollection,
        targetRecordId: plainRow.targetRecordId,
        operation: plainRow.operation,
      },
      status: 'allowed',
      resultSummary: `Approved and executed HITL #${numericId} (${plainRow.operation} ${plainRow.targetCollection})`,
    });

    return {
      ...plainRow,
      ...baseDecisionMeta,
      decidedAt: now.toISOString(),
      status: 'executed',
      executionResult: safeResult,
    };
  } finally {
    inFlightClaims.delete(claimKey);
  }
}

module.exports = {
  VALID_TOOL_MODES,
  HITL_APPROVER_ROLES,
  DEFAULT_HITL_TTL_MS,
  isRootActor,
  isHitlApprover,
  resolveEffectiveToolMode,
  buildDiffPreview,
  computeRiskLevel,
  serializeApprovalRow,
  enqueueAiApproval,
  listApprovals,
  decideApproval,
};
