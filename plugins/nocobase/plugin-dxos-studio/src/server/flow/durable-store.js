/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const crypto = require('node:crypto');
const { fail, sha256Hex, timingSafeEqualHex, toPlain, val } = require('../wms-dmn-shared');
const { cloneSafe } = require('./schema');

const inFlightClaims = new Set();

function generateResumeToken() {
  const token = crypto.randomBytes(24).toString('hex');
  return { token, tokenHash: sha256Hex(token) };
}

function hashResumeToken(token) {
  return sha256Hex(token);
}

async function createRunRecord(db, payload = {}) {
  const now = new Date();
  const record = {
    organizationId: String(payload.organizationId || '').trim(),
    ruleId: payload.ruleId ?? null,
    ruleKey: String(payload.ruleKey || '').trim(),
    runUid: String(payload.runUid || `run_${crypto.randomUUID()}`).trim(),
    triggerEventId: payload.triggerEventId ? String(payload.triggerEventId) : null,
    triggerEventType: String(payload.triggerEventType || 'manual.trigger'),
    status: String(payload.status || 'running'),
    depth: Number(payload.depth || 0),
    matched: payload.matched !== undefined ? Boolean(payload.matched) : true,
    dmnResultJson: payload.dmnResultJson ? cloneSafe(payload.dmnResultJson) : null,
    stepTracesJson: Array.isArray(payload.stepTracesJson) ? cloneSafe(payload.stepTracesJson) : [],
    errorMessage: payload.errorMessage ? String(payload.errorMessage) : null,
    startedAt: payload.startedAt || now,
    finishedAt: payload.finishedAt ?? null,
    durationMs: payload.durationMs ?? null,
    graphVersion: Number(payload.graphVersion || 2),
    nodeStatesJson: payload.nodeStatesJson && typeof payload.nodeStatesJson === 'object' ? cloneSafe(payload.nodeStatesJson) : {},
    suspendedNodeId: payload.suspendedNodeId ? String(payload.suspendedNodeId) : null,
    resumeTokenHash: payload.resumeTokenHash ? String(payload.resumeTokenHash) : null,
    resumeAt: payload.resumeAt ?? null,
    approvalId: payload.approvalId ?? null,
    triggerPayloadJson: payload.triggerPayloadJson ? cloneSafe(payload.triggerPayloadJson) : null,
  };
  const runsRepo = db?.getRepository?.('latticeAutomationRuns');
  if (runsRepo && typeof runsRepo.create === 'function') {
    const created = await runsRepo.create({ values: record });
    return toPlain(created) || record;
  }
  return record;
}

async function updateNodeState(db, organizationId, runUid, nodeId, state, stepTrace) {
  const cleanOrgId = String(organizationId || '').trim();
  const cleanRunUid = String(runUid || '').trim();
  if (!cleanOrgId || !cleanRunUid) {
    throw fail('INVALID_RUN_SCOPE', 400, 'organizationId and runUid are required');
  }
  const runsRepo = db?.getRepository?.('latticeAutomationRuns');
  if (!runsRepo || typeof runsRepo.findOne !== 'function') {
    throw fail('REPOSITORY_UNAVAILABLE', 500, 'latticeAutomationRuns repository unavailable');
  }
  const existing = await runsRepo.findOne({ filter: { organizationId: cleanOrgId, runUid: cleanRunUid } });
  if (!existing) throw fail('RUN_NOT_FOUND', 404, `Automation run ${cleanRunUid} not found`);

  const plain = toPlain(existing) || {};
  const nodeStatesJson = { ...(plain.nodeStatesJson || {}), [String(nodeId)]: cloneSafe(state) };
  const stepTracesJson = Array.isArray(plain.stepTracesJson) ? cloneSafe(plain.stepTracesJson) : [];
  if (stepTrace) {
    const cleanTrace = cloneSafe(stepTrace);
    const idx = cleanTrace?.nodeId ? stepTracesJson.findIndex((t) => t?.nodeId === cleanTrace.nodeId) : -1;
    if (idx >= 0) stepTracesJson[idx] = cleanTrace;
    else stepTracesJson.push(cleanTrace);
  }
  await runsRepo.update({ filter: { organizationId: cleanOrgId, runUid: cleanRunUid }, values: { nodeStatesJson, stepTracesJson } });
  return { ...plain, nodeStatesJson, stepTracesJson };
}

async function suspendRun(db, {
  organizationId, runUid, nodeId, approvalId = null, resumeAt = null,
  resumeTokenHash = null, nodeStatesJson, stepTracesJson, triggerPayloadJson, dmnResultJson,
} = {}) {
  const cleanOrgId = String(organizationId || '').trim();
  const cleanRunUid = String(runUid || '').trim();
  if (!cleanOrgId || !cleanRunUid) {
    throw fail('INVALID_RUN_SCOPE', 400, 'organizationId and runUid are required');
  }
  const runsRepo = db?.getRepository?.('latticeAutomationRuns');
  if (!runsRepo || typeof runsRepo.update !== 'function') {
    throw fail('REPOSITORY_UNAVAILABLE', 500, 'latticeAutomationRuns repository unavailable');
  }
  const values = {
    status: 'suspended',
    suspendedNodeId: nodeId ? String(nodeId) : null,
    approvalId: approvalId ?? null,
    resumeAt: resumeAt ?? null,
    resumeTokenHash: resumeTokenHash ? String(resumeTokenHash) : null,
  };
  if (nodeStatesJson !== undefined) values.nodeStatesJson = cloneSafe(nodeStatesJson);
  if (stepTracesJson !== undefined) values.stepTracesJson = cloneSafe(stepTracesJson);
  if (triggerPayloadJson !== undefined) values.triggerPayloadJson = cloneSafe(triggerPayloadJson);
  if (dmnResultJson !== undefined) values.dmnResultJson = cloneSafe(dmnResultJson);

  await runsRepo.update({ filter: { organizationId: cleanOrgId, runUid: cleanRunUid }, values });
  const updated = typeof runsRepo.findOne === 'function' ? await runsRepo.findOne({ filter: { organizationId: cleanOrgId, runUid: cleanRunUid } }) : null;
  return updated ? toPlain(updated) : { organizationId: cleanOrgId, runUid: cleanRunUid, ...values };
}

async function claimSuspendedRun(db, {
  organizationId, runUid, expectedNodeId = null, resumeToken = null, actor = null, requireToken = false,
} = {}) {
  const cleanRunUid = String(runUid || '').trim();
  const cleanOrgId = String(organizationId || '').trim();
  if (!cleanRunUid) return { ok: false, statusCode: 400, code: 'MISSING_RUN_ID', error: 'runUid is required' };
  if (!cleanOrgId) return { ok: false, statusCode: 400, code: 'NATIVE_TENANT_REQUIRED', error: 'organizationId is required' };
  const claimKey = `${cleanOrgId}:${cleanRunUid}`;
  if (inFlightClaims.has(claimKey)) {
    return { ok: false, statusCode: 409, code: 'RUN_RESUME_CONFLICT', error: 'Concurrent resume already in progress' };
  }

  inFlightClaims.add(claimKey);
  try {
    const runsRepo = db?.getRepository?.('latticeAutomationRuns');
    if (!runsRepo || typeof runsRepo.findOne !== 'function') {
      return { ok: false, statusCode: 500, code: 'REPOSITORY_UNAVAILABLE', error: 'latticeAutomationRuns repository unavailable' };
    }
    const row = await runsRepo.findOne({ filter: { organizationId: cleanOrgId, runUid: cleanRunUid } });
    if (!row) {
      const crossTenantRow = await runsRepo.findOne({ filter: { runUid: cleanRunUid } });
      if (crossTenantRow) {
        return { ok: false, statusCode: 403, code: 'NATIVE_ORGANIZATION_MISMATCH', error: 'Run belongs to another organization' };
      }
      return { ok: false, statusCode: 404, code: 'RUN_NOT_FOUND', error: `Automation run ${cleanRunUid} not found` };
    }

    const run = toPlain(row);
    const ownerOrg = String(val(row, 'organizationId') || run.organizationId || '').trim();
    if (ownerOrg && ownerOrg !== cleanOrgId) {
      return { ok: false, statusCode: 403, code: 'NATIVE_ORGANIZATION_MISMATCH', error: 'Run belongs to another organization' };
    }
    if (run.status !== 'suspended') {
      return { ok: false, statusCode: 409, code: 'RUN_ALREADY_RESUMED', error: `Run status is "${run.status}", expected "suspended"` };
    }
    if (expectedNodeId && run.suspendedNodeId && String(expectedNodeId) !== String(run.suspendedNodeId)) {
      return { ok: false, statusCode: 409, code: 'RUN_SUSPENDED_NODE_MISMATCH', error: `Run suspended on "${run.suspendedNodeId}", expected "${expectedNodeId}"` };
    }

    const tokenProvided = resumeToken !== undefined && resumeToken !== null && String(resumeToken) !== '';
    if (requireToken || tokenProvided) {
      const providedHash = hashResumeToken(String(resumeToken ?? ''));
      if (!run.resumeTokenHash || !timingSafeEqualHex(providedHash, String(run.resumeTokenHash))) {
        return { ok: false, statusCode: 403, code: 'INVALID_RESUME_TOKEN', error: 'Invalid or missing resume token' };
      }
    }

    const dialect = typeof db?.sequelize?.getDialect === 'function' ? db.sequelize.getDialect() : 'postgres';
    let claimed = null;
    if (typeof db?.sequelize?.query === 'function' && dialect === 'postgres') {
      const [rows, meta] = await db.sequelize.query(
        'UPDATE "latticeAutomationRuns" SET status = \'resuming\', "updatedAt" = NOW() WHERE "organizationId" = :organizationId AND "runUid" = :runUid AND status = \'suspended\' RETURNING *',
        { replacements: { organizationId: cleanOrgId, runUid: cleanRunUid } },
      );
      if (Array.isArray(rows) && rows.length > 0) {
        claimed = toPlain(rows[0]);
      } else {
        const isInMemoryStub = Array.isArray(meta) && meta.length === 0 && Boolean(db?.store);
        if (!isInMemoryStub) {
          return { ok: false, statusCode: 409, code: 'RUN_ALREADY_RESUMED', error: 'Run already claimed concurrently' };
        }
      }
    }

    if (!claimed && typeof runsRepo.update === 'function') {
      const upd = await runsRepo.update({
        filter: { organizationId: cleanOrgId, runUid: cleanRunUid, status: 'suspended' },
        values: { status: 'resuming' },
      });
      const affected = Array.isArray(upd) ? (typeof upd[0] === 'number' ? upd[0] : upd.length) : Number(upd ?? 0);
      if (!affected) return { ok: false, statusCode: 409, code: 'RUN_ALREADY_RESUMED', error: 'Run already claimed' };
      const refreshed = await runsRepo.findOne({ filter: { organizationId: cleanOrgId, runUid: cleanRunUid } });
      claimed = refreshed ? toPlain(refreshed) : { ...run, status: 'resuming' };
    }

    return { ok: true, run: claimed || { ...run, status: 'resuming' }, actor: actor || null };
  } finally {
    inFlightClaims.delete(claimKey);
  }
}

module.exports = {
  generateResumeToken,
  hashResumeToken,
  createRunRecord,
  updateNodeState,
  suspendRun,
  claimSuspendedRun,
};
