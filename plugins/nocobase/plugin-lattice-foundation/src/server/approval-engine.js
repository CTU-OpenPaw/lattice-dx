/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { resolveNativeActor } = require('./native-scope');
const { isPortalAdmin } = require('./native-portals');
const { val, toPlain, getRepo, callerRoles } = require('./native-portal-helpers');
const { assertApiKeyScope } = require('./paas-api-keys');
const { appendLedgerEntrySafely } = require('./pki-ledger');
const { publishDomainEvent } = require('./event-bus');
const {
  dispatchNotification,
  dispatchRoleNotifications,
  resolveNotificationTargetPath,
} = require('./notification-center');
const {
  canUsePgRlsSession,
  getActiveRlsContext,
  isValidOrganizationId,
  runInRlsSavepoint,
  withSystemRlsBypass,
  withTenantRlsContext,
} = require('./pg-rls');

const POLICY_KEY_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/;
const COLLECTION_NAME_RE = /^lattice[A-Z][A-Za-z0-9]{1,64}$/;
const ROLE_NAME_RE = /^[a-zA-Z0-9_-]{2,64}$/;
const VALID_MODES = new Set(['sequential', 'parallel']);
const VALID_OPERATIONS = new Set(['submit', 'create', 'update', 'custom']);
const VALID_RISK_LEVELS = new Set(['low', 'medium', 'high', 'critical']);
const VALID_DECISIONS = new Set(['approve', 'reject']);
const VALID_PROPOSAL_DECISIONS = new Set(['approve', 'reject', 'review']);
const VALID_INBOX_SOURCES = new Set(['all', 'business', 'ai_hitl', 'flow', 'proposals']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const FORBIDDEN_DELEGATION_ROLES = new Set(['root', 'admin', 'ldx_admin']);
const ADMIN_ROLES = new Set(['root', 'admin', 'ldx_admin']);
const DEFAULT_FLOW_APPROVER_ROLES = new Set(['root', 'admin', 'ldx_admin', 'ldx_director', 'ldx_manager']);
const DEFAULT_HITL_APPROVER_ROLES = new Set(['root', 'admin', 'ldx_admin', 'ldx_director', 'ldx_manager']);
const PROTECTED_TARGET_COLLECTIONS = new Set([
  'users',
  'roles',
  'rolesUsers',
  'latticeApiKeys',
  'latticePkiKeys',
  'latticeCryptoLedger',
  'latticeDelegations',
  'latticeConnectors',
  'latticeWebhookSubscriptions',
  'latticeWebhookDeliveries',
  'latticeEventBus',
  'latticeAiAuditLogs',
  'latticeAiApprovalQueue',
  'latticeAiProfiles',
  'latticeAiQuotaUsage',
  'latticeAiTraces',
  'latticeAiMemory',
  'latticeApprovalPolicies',
  'latticeApprovalRequests',
  'latticeEmployees',
  'latticeOrganizations',
  'latticeNotifications',
  'latticeNotificationDeliveries',
  'latticeSlaPolicies',
  'latticePublicForms',
]);
const APPROVAL_PROTECTED_RESOURCES = new Set([
  'latticeApprovalPolicies',
  'latticeApprovalRequests',
]);

const inFlightClaims = new Set();
const canonicalDecisionLocks = new Map();

async function withCanonicalDecisionLock(key, fn) {
  const prev = canonicalDecisionLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  canonicalDecisionLocks.set(key, current);
  try {
    await prev.catch(() => {});
    return await fn();
  } finally {
    release();
    if (canonicalDecisionLocks.get(key) === current) {
      canonicalDecisionLocks.delete(key);
    }
  }
}

function failApproval(code, status = 400, message = code) {
  return Object.assign(new Error(message), { code, status });
}

function sanitizePlainJson(value, depth = 0) {
  if (depth > 20) {
    throw failApproval('APPROVAL_PAYLOAD_TOO_DEEP', 400, 'Payload exceeds maximum nesting depth.');
  }
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePlainJson(item, depth + 1));
  }
  if (typeof value === 'object') {
    const src = typeof value.toJSON === 'function' ? value.toJSON() : value;
    const out = {};
    for (const key of Object.keys(src)) {
      if (FORBIDDEN_KEYS.has(key)) continue;
      const entry = src[key];
      if (entry === undefined || typeof entry === 'function' || typeof entry === 'symbol') continue;
      Object.defineProperty(out, key, {
        value: sanitizePlainJson(entry, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return undefined;
}

function readParams(ctx) {
  const rawP = ctx?.action?.params && typeof ctx.action.params === 'object' ? ctx.action.params : {};
  const rawV = rawP.values && typeof rawP.values === 'object' && !Array.isArray(rawP.values) ? rawP.values : {};
  const rawB = ctx?.request?.body && typeof ctx.request.body === 'object' && !Array.isArray(ctx.request.body) ? ctx.request.body : {};
  return sanitizePlainJson({ ...rawB, ...rawP, ...rawV }) || {};
}

function assertValidOrgId(rawOrgId) {
  const clean = typeof rawOrgId === 'string' ? rawOrgId.trim() : '';
  if (!isValidOrganizationId(clean)) {
    throw failApproval('APPROVAL_ORG_REQUIRED', 400, 'Valid organizationId is required.');
  }
  return clean;
}

function assertAllowedTargetCollection(rawCollection) {
  const col = typeof rawCollection === 'string' ? rawCollection.trim() : '';
  if (!col || PROTECTED_TARGET_COLLECTIONS.has(col) || !COLLECTION_NAME_RE.test(col)) {
    throw failApproval(
      'APPROVAL_COLLECTION_FORBIDDEN',
      400,
      `Target collection "${col || '<empty>'}" is not allowlisted for approval attachment.`,
    );
  }
  return col;
}

function loadCrossPluginModule(pluginDir, serverSubpath) {
  const inDist = __dirname.includes(`${path.sep}dist${path.sep}`);
  const pkgName = `@latticedx/${pluginDir}`;
  const candidates = inDist
    ? [
        `${pkgName}/dist/server/${serverSubpath}`,
        `${pkgName}/src/server/${serverSubpath}`,
        `../../../${pluginDir}/dist/server/${serverSubpath}`,
        `../../../${pluginDir}/src/server/${serverSubpath}`,
      ]
    : [
        `${pkgName}/src/server/${serverSubpath}`,
        `../../../${pluginDir}/src/server/${serverSubpath}`,
        `../../../${pluginDir}/dist/server/${serverSubpath}`,
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

function loadOptionalOmnichannelNotify() {
  try {
    return require('./omnichannel-notify');
  } catch (err) {
    if (err?.code === 'MODULE_NOT_FOUND') return null;
    throw err;
  }
}

function isElevatedRoleRow(roleRow) {
  if (!roleRow) return false;
  if (val(roleRow, 'allowAll') === true || val(roleRow, 'allowConfigure') === true) return true;
  const snippets = val(roleRow, 'snippets');
  if (Array.isArray(snippets) && snippets.some((s) => ['pm', 'pm.*', 'acl', 'acl.*', 'app', 'app.*', 'ui', 'ui.*', '*'].includes(s))) {
    return true;
  }
  const actions = val(roleRow, 'strategy')?.actions || [];
  return Array.isArray(actions) && actions.some((a) => {
    const name = typeof a === 'string' ? a : (val(a, 'name') || a?.name);
    return name === '*' || name === '*:*';
  });
}

async function resolveVerifiedCallerRoles(db, ctx, userId, transaction = null) {
  const claimed = callerRoles(ctx).map((r) => String(r || '').trim()).filter(Boolean);
  const ruRepo = getRepo(db, 'rolesUsers');
  const uid = Number(userId);
  if (ruRepo && typeof ruRepo.find === 'function' && Number.isInteger(uid) && uid > 0) {
    const rows = (await ruRepo.find({
      filter: { userId: uid },
      limit: 100,
      ...(transaction ? { transaction } : {}),
    })) || [];
    const assigned = new Set(
      rows
        .filter((r) => Number(val(r, 'userId')) === uid)
        .map((r) => String(val(r, 'roleName') || '').trim())
        .filter(Boolean),
    );
    if (claimed.length > 0) {
      return claimed.filter((r) => assigned.has(r));
    }
    return [...assigned];
  }
  return claimed;
}

async function resolveDelegationsForActor(db, { organizationId, userId, scope = null, includeScoped = false, now = new Date() } = {}) {
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

  const includeAllScopes = Boolean(includeScoped) || scope === '*';
  const engine = !includeAllScopes ? loadCrossPluginModule('plugin-dxos-studio', 'delegation-engine') : null;
  if (typeof engine?.resolveEffectiveDelegatedRoles === 'function') {
    return engine.resolveEffectiveDelegatedRoles(
      db,
      { organizationId: cleanOrgId, userId: uid, scope, now },
      { pgRls: require('./pg-rls') },
    );
  }

  const repo = getRepo(db, 'latticeDelegations');
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

    const rolesRepo = getRepo(db, 'roles');
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
        if (includeAllScopes) return true;
        if (scopeSet.size > 0) return !rowScope || scopeSet.has(rowScope);
        return !rowScope;
      })
      .map((r) => ({
        id: val(r, 'id') ?? null,
        organizationId: val(r, 'organizationId'),
        delegationUid: val(r, 'delegationUid'),
        delegatorUserId: Number(val(r, 'delegatorUserId')),
        delegateUserId: Number(val(r, 'delegateUserId')),
        roleName: String(val(r, 'roleName') || '').trim(),
        scopeCollection: val(r, 'scopeCollection') || null,
        startsAt: val(r, 'startsAt'),
        endsAt: val(r, 'endsAt'),
        status: val(r, 'status'),
      }))
      .sort((a, b) => Number(Boolean(b.scopeCollection)) - Number(Boolean(a.scopeCollection)));
  };

  const activeRls = getActiveRlsContext();
  let matched;
  if (activeRls?.transaction && activeRls.sequelize === db?.sequelize) {
    matched = await runQuery(activeRls.transaction);
  } else if (canUsePgRlsSession(db)) {
    matched = await withTenantRlsContext(db, cleanOrgId, runQuery);
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

async function resolveActorContext(db, ctx, { requestedOrgId = null, allowRootCrossOrg = false } = {}) {
  const user = ctx?.state?.currentUser || ctx?.auth?.user;
  const rawUid = val(user, 'id');
  if (rawUid == null || !/^[1-9]\d*$/.test(String(rawUid))) {
    throw failApproval('NATIVE_LOGIN_REQUIRED', 401, 'Authentication required.');
  }
  const userId = Number(rawUid);
  const username = String(val(user, 'username') || `user-${userId}`).slice(0, 120);
  const verifiedRoles = await resolveVerifiedCallerRoles(db, ctx, userId);
  const isRoot = verifiedRoles.includes('root');

  let isAdmin = isRoot;
  if (!isAdmin && verifiedRoles.length > 0) {
    if (verifiedRoles.some((r) => ADMIN_ROLES.has(r))) {
      isAdmin = true;
    } else {
      const rolesRepo = getRepo(db, 'roles');
      if (rolesRepo && typeof rolesRepo.find === 'function') {
        const matched = (await rolesRepo.find({ filter: { name: { $in: verifiedRoles } } })) || [];
        isAdmin = matched.some((rr) => isElevatedRoleRow(rr));
      } else {
        isAdmin = await isPortalAdmin({ ...ctx, state: { ...ctx.state, currentRoles: verifiedRoles, currentRole: verifiedRoles[0] || null } }, db);
      }
    }
  }

  const reqOrgClean = requestedOrgId != null && String(requestedOrgId).trim() !== ''
    ? String(requestedOrgId).trim()
    : null;
  if (reqOrgClean && !isValidOrganizationId(reqOrgClean)) {
    throw failApproval('APPROVAL_ORG_INVALID', 400, 'Invalid organizationId.');
  }

  if (isRoot) {
    if (reqOrgClean) {
      return { userId, employeeId: null, username, organizationId: reqOrgClean, verifiedRoles, isRoot: true, isAdmin: true };
    }
    try {
      const empActor = await resolveNativeActor(db, user);
      return {
        userId,
        employeeId: empActor.employeeId != null ? Number(empActor.employeeId) : null,
        username,
        organizationId: empActor.organizationId,
        verifiedRoles,
        isRoot: true,
        isAdmin: true,
      };
    } catch (err) {
      if (allowRootCrossOrg) {
        return { userId, employeeId: null, username, organizationId: null, verifiedRoles, isRoot: true, isAdmin: true };
      }
      throw failApproval('APPROVAL_ORG_REQUIRED', 400, 'organizationId is required for root caller.');
    }
  }

  const nativeActor = await resolveNativeActor(db, user);
  if (reqOrgClean && reqOrgClean !== nativeActor.organizationId) {
    throw failApproval('NATIVE_ORGANIZATION_MISMATCH', 403, 'Cross-organization approval access is forbidden.');
  }
  return {
    userId,
    employeeId: nativeActor.employeeId != null ? Number(nativeActor.employeeId) : null,
    username,
    organizationId: nativeActor.organizationId,
    verifiedRoles,
    isRoot: false,
    isAdmin,
  };
}

function runScopedDb(db, organizationId, fn, explicitTx = null) {
  const activeTx = explicitTx || getActiveRlsContext()?.transaction || null;
  if (activeTx) return fn(activeTx);
  if (canUsePgRlsSession(db)) {
    return organizationId
      ? withTenantRlsContext(db, organizationId, fn)
      : withSystemRlsBypass(db, fn);
  }
  return fn(null);
}

function normalizeStagesJson(rawStages, defaults = {}) {
  if (!Array.isArray(rawStages) || rawStages.length === 0 || rawStages.length > 12) {
    throw failApproval('APPROVAL_STAGES_INVALID', 400, 'stagesJson must be a non-empty array of 1..12 stage objects.');
  }
  const defaultSla = Math.max(1, Math.min(43200, Number(defaults.slaMinutes) || 1440));
  const defaultEscalateRole = typeof defaults.escalateToRole === 'string' && ROLE_NAME_RE.test(defaults.escalateToRole.trim())
    ? defaults.escalateToRole.trim()
    : 'ldx_director';

  return rawStages.map((raw, idx) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw failApproval('APPROVAL_STAGES_INVALID', 400, `Stage #${idx} must be an object.`);
    }
    const clean = sanitizePlainJson(raw);
    const name = typeof clean.name === 'string' && clean.name.trim()
      ? clean.name.trim().slice(0, 120)
      : `Stage ${idx + 1}`;
    const mode = String(clean.mode || 'sequential').trim().toLowerCase();
    if (!VALID_MODES.has(mode)) {
      throw failApproval('APPROVAL_STAGES_INVALID', 400, `Stage "${name}" mode must be sequential or parallel.`);
    }

    const approverRoles = [];
    if (Array.isArray(clean.approverRoles)) {
      for (const r of clean.approverRoles) {
        const rn = String(r || '').trim();
        if (!ROLE_NAME_RE.test(rn) || rn === 'anonymous' || rn === 'public') {
          throw failApproval('APPROVAL_STAGES_INVALID', 400, `Invalid approver role "${rn}" in stage "${name}".`);
        }
        if (!approverRoles.includes(rn)) approverRoles.push(rn);
      }
    }

    const approverUserIds = [];
    if (Array.isArray(clean.approverUserIds)) {
      for (const idRaw of clean.approverUserIds) {
        const uid = Number(idRaw);
        if (!Number.isInteger(uid) || uid <= 0) {
          throw failApproval('APPROVAL_STAGES_INVALID', 400, `Invalid approverUserId in stage "${name}".`);
        }
        if (!approverUserIds.includes(uid)) approverUserIds.push(uid);
      }
    }

    if (approverRoles.length === 0 && approverUserIds.length === 0) {
      throw failApproval(
        'APPROVAL_STAGES_INVALID',
        400,
        `Stage "${name}" must specify at least one approverRole or approverUserId.`,
      );
    }

    const rawReq = clean.requiredApprovals !== undefined ? Number(clean.requiredApprovals) : 1;
    const requiredApprovals = mode === 'sequential' ? 1 : rawReq;
    if (!Number.isInteger(requiredApprovals) || requiredApprovals < 1 || requiredApprovals > 50) {
      throw failApproval('APPROVAL_STAGES_INVALID', 400, `Invalid requiredApprovals in stage "${name}".`);
    }
    if (mode === 'parallel' && approverRoles.length === 0 && requiredApprovals > approverUserIds.length) {
      throw failApproval(
        'APPROVAL_STAGES_INVALID',
        400,
        `Stage "${name}" requiredApprovals (${requiredApprovals}) exceeds explicit approverUserIds (${approverUserIds.length}).`,
      );
    }

    const slaMinutes = clean.slaMinutes !== undefined && clean.slaMinutes !== null
      ? Number(clean.slaMinutes)
      : defaultSla;
    if (!Number.isInteger(slaMinutes) || slaMinutes < 1 || slaMinutes > 43200) {
      throw failApproval('APPROVAL_STAGES_INVALID', 400, `Invalid slaMinutes in stage "${name}".`);
    }

    const escalateToRole = typeof clean.escalateToRole === 'string' && clean.escalateToRole.trim()
      ? clean.escalateToRole.trim()
      : defaultEscalateRole;
    if (!ROLE_NAME_RE.test(escalateToRole)) {
      throw failApproval('APPROVAL_STAGES_INVALID', 400, `Invalid escalateToRole in stage "${name}".`);
    }

    return {
      stageIndex: idx,
      name,
      mode,
      requiredApprovals,
      approverRoles,
      approverUserIds,
      slaMinutes,
      escalateToRole,
      allowDelegation: clean.allowDelegation !== false,
    };
  });
}

function matchesConditionJson(condition, payload = {}, depth = 0) {
  if (!condition || typeof condition !== 'object') return true;
  if (depth > 10) return false;
  if (Array.isArray(condition.$and)) {
    return condition.$and.every((sub) => matchesConditionJson(sub, payload, depth + 1));
  }
  if (Array.isArray(condition.$or)) {
    return condition.$or.some((sub) => matchesConditionJson(sub, payload, depth + 1));
  }
  for (const [key, expected] of Object.entries(condition)) {
    if (FORBIDDEN_KEYS.has(key) || key.startsWith('$')) continue;
    const actual = Object.hasOwn(payload || {}, key) ? payload[key] : undefined;
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      if (Object.hasOwn(expected, '$eq') && actual !== expected.$eq) return false;
      if (Object.hasOwn(expected, '$ne') && actual === expected.$ne) return false;
      if (Object.hasOwn(expected, '$gt') && !(Number(actual) > Number(expected.$gt))) return false;
      if (Object.hasOwn(expected, '$gte') && !(Number(actual) >= Number(expected.$gte))) return false;
      if (Object.hasOwn(expected, '$lt') && !(Number(actual) < Number(expected.$lt))) return false;
      if (Object.hasOwn(expected, '$lte') && !(Number(actual) <= Number(expected.$lte))) return false;
      if (Array.isArray(expected.$in) && !expected.$in.includes(actual)) return false;
    } else if (actual !== expected) {
      return false;
    }
  }
  return true;
}

function serializePolicy(row) {
  if (!row) return null;
  return {
    id: val(row, 'id') ?? null,
    organizationId: val(row, 'organizationId') || null,
    policyKey: val(row, 'policyKey') || '',
    name: val(row, 'name') || '',
    description: val(row, 'description') || '',
    targetCollection: val(row, 'targetCollection') || '',
    triggerOperation: val(row, 'triggerOperation') || 'submit',
    conditionJson: val(row, 'conditionJson') || null,
    stagesJson: Array.isArray(val(row, 'stagesJson')) ? val(row, 'stagesJson') : [],
    allowSelfApproval: Boolean(val(row, 'allowSelfApproval')),
    slaMinutes: Number(val(row, 'slaMinutes')) || 1440,
    escalateToRole: val(row, 'escalateToRole') || 'ldx_director',
    notifyChannels: Array.isArray(val(row, 'notifyChannels')) ? val(row, 'notifyChannels') : null,
    priority: Number(val(row, 'priority')) || 100,
    active: val(row, 'active') !== false,
    createdAt: val(row, 'createdAt') || null,
    updatedAt: val(row, 'updatedAt') || null,
  };
}

function serializeApprovalRequest(row) {
  if (!row) return null;
  const dueAt = val(row, 'dueAt');
  const escalatedAt = val(row, 'escalatedAt');
  const decidedAt = val(row, 'decidedAt');
  return {
    id: val(row, 'id') ?? null,
    organizationId: val(row, 'organizationId') || null,
    requestUid: val(row, 'requestUid') || '',
    policyId: val(row, 'policyId') != null ? Number(val(row, 'policyId')) : null,
    policyKey: val(row, 'policyKey') || null,
    targetCollection: val(row, 'targetCollection') || '',
    targetRecordId: val(row, 'targetRecordId') != null ? Number(val(row, 'targetRecordId')) : null,
    targetCode: val(row, 'targetCode') || null,
    title: val(row, 'title') || '',
    summary: val(row, 'summary') || '',
    riskLevel: val(row, 'riskLevel') || 'medium',
    status: val(row, 'status') || 'pending',
    currentStageIndex: Number(val(row, 'currentStageIndex')) || 0,
    totalStages: Number(val(row, 'totalStages')) || 1,
    stagesStateJson: Array.isArray(val(row, 'stagesStateJson')) ? val(row, 'stagesStateJson') : [],
    requesterUserId: val(row, 'requesterUserId') != null ? Number(val(row, 'requesterUserId')) : null,
    requesterEmployeeId: val(row, 'requesterEmployeeId') != null ? Number(val(row, 'requesterEmployeeId')) : null,
    requesterUsername: val(row, 'requesterUsername') || null,
    payloadJson: val(row, 'payloadJson') || {},
    dueAt: dueAt ? (dueAt instanceof Date ? dueAt.toISOString() : String(dueAt)) : null,
    escalatedAt: escalatedAt ? (escalatedAt instanceof Date ? escalatedAt.toISOString() : String(escalatedAt)) : null,
    decidedAt: decidedAt ? (decidedAt instanceof Date ? decidedAt.toISOString() : String(decidedAt)) : null,
    finalDecisionByUserId: val(row, 'finalDecisionByUserId') != null ? Number(val(row, 'finalDecisionByUserId')) : null,
    finalDecisionByUsername: val(row, 'finalDecisionByUsername') || null,
    finalDecisionNote: val(row, 'finalDecisionNote') || null,
    active: val(row, 'active') !== false,
    createdAt: val(row, 'createdAt') || null,
    updatedAt: val(row, 'updatedAt') || null,
  };
}

async function safeNotifyStageApprovers(db, {
  organizationId,
  request,
  stage,
  notifyChannels = null,
  dedupKey,
  title,
  body,
  severity = 'info',
  transaction = null,
  app = null,
}) {
  const roles = Array.isArray(stage?.approverRoles) ? stage.approverRoles : [];
  const userIds = Array.isArray(stage?.approverUserIds) ? stage.approverUserIds : [];
  const targetPath = resolveNotificationTargetPath(request.targetCollection);

  const hasExplicitOmniChannels = Array.isArray(notifyChannels) && notifyChannels.length > 0;
  const runNotif = async () => {
    if (roles.length > 0) {
      await dispatchRoleNotifications(db, {
        organizationId,
        roleNames: roles,
        category: 'approval',
        severity,
        title,
        body,
        targetCollection: request.targetCollection,
        targetRecordId: request.targetRecordId,
        targetPath,
        dedupKey,
        notifyChannels,
        ...(hasExplicitOmniChannels ? { skipOmnichannel: true } : {}),
      }, { app, ...(hasExplicitOmniChannels ? { skipOmnichannel: true } : {}) }).catch(() => {});
    }
    for (const uid of userIds) {
      await dispatchNotification(db, {
        organizationId,
        recipientUserId: uid,
        category: 'approval',
        severity,
        title,
        body,
        targetCollection: request.targetCollection,
        targetRecordId: request.targetRecordId,
        targetPath,
        dedupKey: `${dedupKey}:u-${uid}`,
        notifyChannels,
        ...(hasExplicitOmniChannels ? { skipOmnichannel: true } : {}),
      }, { app, ...(hasExplicitOmniChannels ? { skipOmnichannel: true } : {}) }).catch(() => {});
    }
    if (Array.isArray(notifyChannels) && notifyChannels.length > 0) {
      const dispatchPayload = {
        organizationId,
        channels: notifyChannels,
        category: 'approval',
        severity,
        title,
        body,
        targetCollection: request.targetCollection,
        targetRecordId: request.targetRecordId,
        targetPath,
        eventType: 'approval.stage_assigned',
      };
      const appOmni = app?.latticeOmnichannelNotify;
      if (appOmni && typeof appOmni.dispatchOmnichannel === 'function') {
        await appOmni.dispatchOmnichannel(dispatchPayload, { app }).catch(() => {});
      } else {
        const omni = loadOptionalOmnichannelNotify();
        if (omni && typeof omni.dispatchOmnichannel === 'function') {
          await omni.dispatchOmnichannel(db, dispatchPayload, { app }).catch(() => {});
        }
      }
    }
  };

  if (transaction && getActiveRlsContext()?.transaction === transaction) {
    await runInRlsSavepoint(db, runNotif).catch(() => {});
  } else {
    await runNotif();
  }
}

async function safeAppendApprovalLedger(db, { organizationId, eventType, requestUid, actor, payload, metadata = null, transaction = null }) {
  return appendLedgerEntrySafely(db, {
    organizationId,
    eventType,
    targetCollection: 'latticeApprovalRequests',
    targetRecordId: requestUid,
    actor,
    payload,
    metadata,
  }, { transaction, scope: 'dxos:approvals' });
}

async function safePublishApprovalEvent(db, { organizationId, eventType, requestUid, data, transaction = null, app = null }) {
  try {
    await publishDomainEvent(db, {
      organizationId,
      type: eventType,
      source: 'latticedx/approval-engine',
      subject: requestUid,
      data,
      transaction,
      app,
    });
  } catch {
    // Non-fatal event publish
  }
}

async function saveApprovalPolicy(db, { organizationId, actor, input = {} } = {}) {
  if (!actor?.isRoot && !actor?.isAdmin) {
    throw failApproval('APPROVAL_ADMIN_REQUIRED', 403, 'Only administrators can manage approval policies.');
  }
  const cleanOrg = assertValidOrgId(organizationId);
  const clean = sanitizePlainJson(input) || {};
  const policyKey = typeof clean.policyKey === 'string' ? clean.policyKey.trim().toLowerCase() : '';
  if (!POLICY_KEY_RE.test(policyKey)) {
    throw failApproval('APPROVAL_POLICY_KEY_INVALID', 400, 'policyKey must match /^[a-z0-9][a-z0-9_-]{1,62}$/.');
  }
  const name = typeof clean.name === 'string' ? clean.name.trim().slice(0, 200) : '';
  if (!name) {
    throw failApproval('APPROVAL_POLICY_NAME_REQUIRED', 400, 'Policy name is required.');
  }
  const targetCollection = assertAllowedTargetCollection(clean.targetCollection);
  const triggerOperation = String(clean.triggerOperation || 'submit').trim().toLowerCase();
  if (!VALID_OPERATIONS.has(triggerOperation)) {
    throw failApproval('APPROVAL_OPERATION_INVALID', 400, 'triggerOperation must be submit, create, update, or custom.');
  }
  const slaMinutes = clean.slaMinutes !== undefined && clean.slaMinutes !== null ? Number(clean.slaMinutes) : 1440;
  if (!Number.isInteger(slaMinutes) || slaMinutes < 1 || slaMinutes > 43200) {
    throw failApproval('APPROVAL_SLA_INVALID', 400, 'slaMinutes must be an integer between 1 and 43200.');
  }
  const escalateToRole = typeof clean.escalateToRole === 'string' && clean.escalateToRole.trim()
    ? clean.escalateToRole.trim()
    : 'ldx_director';
  if (!ROLE_NAME_RE.test(escalateToRole)) {
    throw failApproval('APPROVAL_ROLE_INVALID', 400, 'Invalid escalateToRole.');
  }
  const stagesJson = normalizeStagesJson(clean.stagesJson ?? clean.stages, { slaMinutes, escalateToRole });
  const allowSelfApproval = Boolean(clean.allowSelfApproval);
  const priority = Number.isInteger(Number(clean.priority)) ? Number(clean.priority) : 100;
  const active = clean.active === undefined ? true : Boolean(clean.active);
  const conditionJson = clean.conditionJson && typeof clean.conditionJson === 'object' && !Array.isArray(clean.conditionJson)
    ? clean.conditionJson
    : null;
  const notifyChannels = Array.isArray(clean.notifyChannels)
    ? clean.notifyChannels.map((c) => String(c || '').trim()).filter(Boolean).slice(0, 10)
    : null;

  const repo = getRepo(db, 'latticeApprovalPolicies');
  if (!repo || typeof repo.create !== 'function') {
    throw failApproval('APPROVAL_REPO_UNAVAILABLE', 503, 'latticeApprovalPolicies repository is unavailable.');
  }

  const values = {
    organizationId: cleanOrg,
    policyKey,
    name,
    description: typeof clean.description === 'string' ? clean.description.slice(0, 2000) : null,
    targetCollection,
    triggerOperation,
    conditionJson,
    stagesJson,
    allowSelfApproval,
    slaMinutes,
    escalateToRole,
    notifyChannels,
    priority,
    active,
  };

  const saved = await runScopedDb(db, cleanOrg, async (transaction) => {
    const txOpt = transaction ? { transaction } : {};
    const existing = await repo.findOne({ filter: { organizationId: cleanOrg, policyKey }, ...txOpt });
    if (existing) {
      if (typeof existing.update === 'function') {
        return existing.update(values, transaction ? { transaction } : undefined);
      }
      const res = await repo.update({ filterByTk: val(existing, 'id'), filter: { organizationId: cleanOrg }, values, ...txOpt });
      return Array.isArray(res) && res[0] ? res[0] : { ...values, id: val(existing, 'id') };
    }
    return repo.create({ values, ...txOpt });
  });

  return serializePolicy(saved);
}

async function listApprovalPolicies(db, { organizationId, targetCollection = null, activeOnly = false } = {}) {
  const repo = getRepo(db, 'latticeApprovalPolicies');
  if (!repo || typeof repo.find !== 'function') return [];
  const filter = {
    ...(organizationId ? { organizationId } : {}),
    ...(targetCollection ? { targetCollection } : {}),
    ...(activeOnly ? { active: true } : {}),
  };
  const rows = (await runScopedDb(db, organizationId, (transaction) => repo.find({
    filter,
    sort: ['priority', 'id'],
    limit: 200,
    ...(transaction ? { transaction } : {}),
  }))) || [];
  return rows.map(serializePolicy);
}

async function deleteApprovalPolicy(db, { organizationId, actor, policyIdOrKey } = {}) {
  if (!actor?.isRoot && !actor?.isAdmin) {
    throw failApproval('APPROVAL_ADMIN_REQUIRED', 403, 'Only administrators can delete approval policies.');
  }
  const cleanOrg = assertValidOrgId(organizationId);
  const keyOrId = String(policyIdOrKey ?? '').trim();
  if (!keyOrId) {
    throw failApproval('APPROVAL_POLICY_ID_REQUIRED', 400, 'policyId or policyKey is required.');
  }
  const repo = getRepo(db, 'latticeApprovalPolicies');
  if (!repo) throw failApproval('APPROVAL_REPO_UNAVAILABLE', 503, 'latticeApprovalPolicies repository is unavailable.');

  const isNumeric = /^[1-9]\d*$/.test(keyOrId);
  const filter = isNumeric
    ? { id: Number(keyOrId), organizationId: cleanOrg }
    : { policyKey: keyOrId, organizationId: cleanOrg };

  return runScopedDb(db, cleanOrg, async (transaction) => {
    const txOpt = transaction ? { transaction } : {};
    const existing = await repo.findOne({ filter, ...txOpt });
    if (!existing || val(existing, 'organizationId') !== cleanOrg) {
      throw failApproval('APPROVAL_POLICY_NOT_FOUND', 404, 'Approval policy not found.');
    }
    if (typeof repo.destroy === 'function') {
      await repo.destroy({ filter, ...txOpt });
    } else if (typeof existing.update === 'function') {
      await existing.update({ active: false }, transaction ? { transaction } : undefined);
    }
    return { deleted: true, id: val(existing, 'id'), policyKey: val(existing, 'policyKey') };
  });
}

async function requestApproval(db, {
  organizationId,
  actor,
  policyId = null,
  policyKey = null,
  targetCollection,
  targetRecordId = null,
  targetCode = null,
  title,
  summary = '',
  riskLevel = 'medium',
  payload = {},
  stages = null,
  allowSelfApproval = false,
  slaMinutes = 1440,
  escalateToRole = 'ldx_director',
  notifyChannels = null,
  now = new Date(),
  app = null,
} = {}) {
  if (!actor?.userId) {
    throw failApproval('NATIVE_LOGIN_REQUIRED', 401, 'Authentication required.');
  }
  const cleanOrg = assertValidOrgId(organizationId);
  const cleanCol = assertAllowedTargetCollection(targetCollection);
  const cleanTitle = typeof title === 'string' ? title.trim().slice(0, 255) : '';
  if (!cleanTitle) {
    throw failApproval('APPROVAL_TITLE_REQUIRED', 400, 'Approval request title is required.');
  }
  const cleanRisk = String(riskLevel || 'medium').trim().toLowerCase();
  if (!VALID_RISK_LEVELS.has(cleanRisk)) {
    throw failApproval('APPROVAL_RISK_INVALID', 400, 'riskLevel must be low, medium, high, or critical.');
  }
  const cleanPayload = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? sanitizePlainJson(payload)
    : {};
  const cleanRecId = targetRecordId != null && /^[1-9]\d*$/.test(String(targetRecordId))
    ? Number(targetRecordId)
    : null;
  const cleanCode = targetCode != null ? String(targetCode).trim().slice(0, 120) : null;
  const nowDate = now instanceof Date ? now : new Date(now);
  const nowMs = Number.isFinite(nowDate.getTime()) ? nowDate.getTime() : Date.now();

  const reqRepo = getRepo(db, 'latticeApprovalRequests');
  const polRepo = getRepo(db, 'latticeApprovalPolicies');
  if (!reqRepo || typeof reqRepo.create !== 'function') {
    throw failApproval('APPROVAL_REPO_UNAVAILABLE', 503, 'latticeApprovalRequests repository is unavailable.');
  }

  const isPrivilegedRequester = Boolean(actor?.isRoot || actor?.isAdmin);
  const { created, effectivePolicy } = await runScopedDb(db, cleanOrg, async (transaction) => {
    const txOpt = transaction ? { transaction } : {};
    let resolvedPolicy = null;

    if (policyKey || policyId) {
      if (!polRepo || typeof polRepo.findOne !== 'function') {
        throw failApproval('APPROVAL_POLICY_NOT_FOUND', 404, 'Approval policy repository is unavailable.');
      }
      const polFilter = policyId
        ? { id: Number(policyId), organizationId: cleanOrg }
        : { policyKey: String(policyKey).trim().toLowerCase(), organizationId: cleanOrg };
      const polRow = await polRepo.findOne({ filter: polFilter, ...txOpt });
      if (!polRow || val(polRow, 'organizationId') !== cleanOrg || val(polRow, 'active') === false) {
        throw failApproval('APPROVAL_POLICY_NOT_FOUND', 404, 'Active approval policy not found.');
      }
      if (val(polRow, 'targetCollection') !== cleanCol) {
        throw failApproval('APPROVAL_COLLECTION_MISMATCH', 400, 'Policy targetCollection does not match request targetCollection.');
      }
      resolvedPolicy = serializePolicy(polRow);
    } else if (polRepo && typeof polRepo.find === 'function' && (!Array.isArray(stages) || !isPrivilegedRequester)) {
      const candidates = (await polRepo.find({
        filter: { organizationId: cleanOrg, targetCollection: cleanCol, active: true },
        sort: ['priority', 'id'],
        limit: 50,
        ...txOpt,
      })) || [];
      for (const row of candidates) {
        if (val(row, 'organizationId') !== cleanOrg || val(row, 'active') === false) continue;
        const pol = serializePolicy(row);
        if (matchesConditionJson(pol.conditionJson, cleanPayload)) {
          resolvedPolicy = pol;
          break;
        }
      }
    }

    const rawStages = resolvedPolicy ? resolvedPolicy.stagesJson : stages;
    if (!Array.isArray(rawStages) || rawStages.length === 0) {
      throw failApproval('APPROVAL_POLICY_NOT_FOUND', 404, 'No active approval policy or stages configured for this request.');
    }

    const effectiveSla = resolvedPolicy ? resolvedPolicy.slaMinutes : slaMinutes;
    const effectiveEscalate = resolvedPolicy ? resolvedPolicy.escalateToRole : escalateToRole;
    const effectiveSelfApproval = resolvedPolicy
      ? Boolean(resolvedPolicy.allowSelfApproval)
      : (isPrivilegedRequester && Boolean(allowSelfApproval));
    const effectiveChannels = resolvedPolicy ? resolvedPolicy.notifyChannels : (Array.isArray(notifyChannels) ? notifyChannels : null);
    const normalizedStages = normalizeStagesJson(rawStages, {
      slaMinutes: effectiveSla,
      escalateToRole: effectiveEscalate,
    });

    const stagesStateJson = normalizedStages.map((st, idx) => ({
      ...st,
      status: 'pending',
      decisions: [],
      dueAt: idx === 0 ? new Date(nowMs + st.slaMinutes * 60_000).toISOString() : null,
      escalatedAt: null,
    }));

    const requestUid = `APR-${randomBytes(6).toString('hex')}`;
    const storedPayload = {
      ...cleanPayload,
      _approvalMeta: {
        allowSelfApproval: effectiveSelfApproval,
        notifyChannels: effectiveChannels,
      },
    };

    const row = await reqRepo.create({
      values: {
        organizationId: cleanOrg,
        requestUid,
        policyId: resolvedPolicy?.id ?? null,
        policyKey: resolvedPolicy?.policyKey ?? null,
        targetCollection: cleanCol,
        targetRecordId: cleanRecId,
        targetCode: cleanCode,
        title: cleanTitle,
        summary: typeof summary === 'string' ? summary.slice(0, 4000) : '',
        riskLevel: cleanRisk,
        status: 'pending',
        currentStageIndex: 0,
        totalStages: stagesStateJson.length,
        stagesStateJson,
        requesterUserId: Number(actor.userId),
        requesterEmployeeId: actor.employeeId != null ? Number(actor.employeeId) : null,
        requesterUsername: String(actor.username || `user-${actor.userId}`).slice(0, 120),
        payloadJson: storedPayload,
        dueAt: stagesStateJson[0].dueAt ? new Date(stagesStateJson[0].dueAt) : null,
        escalatedAt: null,
        decidedAt: null,
        finalDecisionByUserId: null,
        finalDecisionByUsername: null,
        finalDecisionNote: null,
        active: true,
      },
      ...txOpt,
    });

    const serialized = serializeApprovalRequest(row);
    await safeAppendApprovalLedger(db, {
      organizationId: cleanOrg,
      eventType: 'approval.requested',
      requestUid: serialized.requestUid,
      actor,
      payload: {
        requestUid: serialized.requestUid,
        targetCollection: cleanCol,
        targetRecordId: cleanRecId,
        totalStages: serialized.totalStages,
      },
      transaction,
    });

    return {
      created: serialized,
      effectivePolicy: {
        allowSelfApproval: effectiveSelfApproval,
        notifyChannels: effectiveChannels,
      },
    };
  });

  await safePublishApprovalEvent(db, {
    organizationId: cleanOrg,
    eventType: 'approval.requested',
    requestUid: created.requestUid,
    data: {
      requestUid: created.requestUid,
      targetCollection: created.targetCollection,
      targetRecordId: created.targetRecordId,
      title: created.title,
      riskLevel: created.riskLevel,
      currentStageIndex: 0,
      totalStages: created.totalStages,
    },
    app,
  });

  const stage0 = created.stagesStateJson[0];
  await safeNotifyStageApprovers(db, {
    organizationId: cleanOrg,
    request: created,
    stage: stage0,
    notifyChannels: effectivePolicy.notifyChannels,
    dedupKey: `approval:${cleanOrg}:${created.requestUid}:stage-0`,
    title: `Yêu cầu phê duyệt mới: ${created.title}`,
    body: `${created.targetCollection}${created.targetCode ? ` (${created.targetCode})` : ''} cần phê duyệt bước "${stage0.name}".`,
    severity: created.riskLevel === 'critical' ? 'critical' : (created.riskLevel === 'high' ? 'high' : 'info'),
    app,
  });

  return created;
}

function canActorVoteOnStage(stage, actor, { allowSelfApproval = false, requesterUserId = null, delegatedRoles = [] } = {}) {
  if (!actor?.userId) return { allowed: false, viaDelegation: null };
  if (!allowSelfApproval && !actor.isRoot && requesterUserId != null && Number(requesterUserId) === Number(actor.userId)) {
    return { allowed: false, selfViolation: true, viaDelegation: null };
  }
  const verifiedSet = new Set(Array.isArray(actor.verifiedRoles) ? actor.verifiedRoles : []);
  if (actor.isRoot || [...verifiedSet].some((r) => ADMIN_ROLES.has(r))) {
    return { allowed: true, matchedRole: actor.isRoot ? 'root' : [...verifiedSet].find((r) => ADMIN_ROLES.has(r)), viaDelegation: null };
  }
  const explicitUsers = Array.isArray(stage?.approverUserIds) ? stage.approverUserIds.map(Number) : [];
  if (explicitUsers.includes(Number(actor.userId))) {
    return { allowed: true, matchedRole: null, viaDelegation: null };
  }
  const requiredRoles = Array.isArray(stage?.approverRoles) ? stage.approverRoles : [];
  const directMatch = requiredRoles.find((r) => verifiedSet.has(r));
  if (directMatch) {
    return { allowed: true, matchedRole: directMatch, viaDelegation: null };
  }
  if (stage?.allowDelegation !== false && Array.isArray(delegatedRoles) && delegatedRoles.length > 0) {
    const dlgMatch = delegatedRoles.find((d) => requiredRoles.includes(d.roleName));
    if (dlgMatch) {
      return { allowed: true, matchedRole: dlgMatch.roleName, viaDelegation: dlgMatch };
    }
  }
  return { allowed: false, viaDelegation: null };
}

async function decideApprovalRequest(db, {
  organizationId = null,
  actor,
  requestIdOrUid,
  decision,
  note = '',
  now = new Date(),
  app = null,
} = {}) {
  if (!actor?.userId) {
    throw failApproval('NATIVE_LOGIN_REQUIRED', 401, 'Authentication required.');
  }
  const normalizedDecision = String(decision || '').trim().toLowerCase();
  if (!VALID_DECISIONS.has(normalizedDecision)) {
    throw failApproval('APPROVAL_INVALID_DECISION', 400, 'decision must be approve or reject.');
  }
  const cleanNote = String(note || '').trim().slice(0, 2000);
  if (normalizedDecision === 'reject' && cleanNote.length < 3) {
    throw failApproval('APPROVAL_REJECTION_NOTE_REQUIRED', 400, 'Rejection reason must be at least 3 characters.');
  }
  const keyRaw = String(requestIdOrUid ?? '').trim();
  if (!keyRaw) {
    throw failApproval('APPROVAL_REQUEST_ID_REQUIRED', 400, 'requestUid or id is required.');
  }

  const isNumeric = /^[1-9]\d*$/.test(keyRaw);
  const scopedOrg = actor.isRoot ? (organizationId || null) : assertValidOrgId(actor.organizationId);
  const claimKey = `${scopedOrg || '*'}:${keyRaw}`;
  if (inFlightClaims.has(claimKey)) {
    throw failApproval('APPROVAL_CONFLICT', 409, 'Approval decision already in progress.');
  }
  inFlightClaims.add(claimKey);

  try {
    const reqRepo = getRepo(db, 'latticeApprovalRequests');
    if (!reqRepo || typeof reqRepo.findOne !== 'function') {
      throw failApproval('APPROVAL_REPO_UNAVAILABLE', 503, 'latticeApprovalRequests repository is unavailable.');
    }

    const nowDate = now instanceof Date ? now : new Date(now);
    const nowMs = Number.isFinite(nowDate.getTime()) ? nowDate.getTime() : Date.now();
    const nowIso = nowDate.toISOString();
    const lookupWhere = {
      ...(isNumeric ? { id: Number(keyRaw) } : { requestUid: keyRaw }),
      ...(scopedOrg ? { organizationId: scopedOrg } : {}),
    };

    const resolvedTarget = await runScopedDb(db, scopedOrg, async (transaction) => {
      const txOpt = transaction ? { transaction } : {};
      const found = await reqRepo.findOne({ filter: lookupWhere, ...txOpt });
      if (!found || (scopedOrg && val(found, 'organizationId') !== scopedOrg)) {
        throw failApproval('APPROVAL_REQUEST_NOT_FOUND', 404, 'Approval request not found in organization scope.');
      }
      return { id: val(found, 'id'), organizationId: val(found, 'organizationId') };
    });
    const canonicalKey = `${resolvedTarget.organizationId}:${resolvedTarget.id}`;
    const outcome = await withCanonicalDecisionLock(canonicalKey, () => runScopedDb(db, scopedOrg, async (transaction) => {
      const txOpt = transaction ? { transaction } : {};
      const canonicalWhere = {
        id: resolvedTarget.id,
        organizationId: resolvedTarget.organizationId,
      };

      const model = db?.getModel?.('latticeApprovalRequests') || reqRepo?.model;
      let row;
      if (model && typeof model.findOne === 'function') {
        row = await model.findOne({
          where: canonicalWhere,
          ...(transaction ? { transaction, lock: transaction.LOCK?.UPDATE } : {}),
        });
      } else {
        row = await reqRepo.findOne({ filter: canonicalWhere, ...txOpt });
      }

      if (!row || (scopedOrg && val(row, 'organizationId') !== scopedOrg)) {
        throw failApproval('APPROVAL_REQUEST_NOT_FOUND', 404, 'Approval request not found in organization scope.');
      }

      const rowOrg = val(row, 'organizationId');
      const currentStatus = String(val(row, 'status') || '');
      if (currentStatus !== 'pending') {
        throw failApproval('APPROVAL_ALREADY_DECIDED', 409, `Approval request is already "${currentStatus}".`);
      }

      const stages = sanitizePlainJson(val(row, 'stagesStateJson')) || [];
      const stageIdx = Number(val(row, 'currentStageIndex')) || 0;
      const stage = stages[stageIdx];
      if (!stage) {
        throw failApproval('APPROVAL_STAGE_INVALID', 500, 'Active approval stage is missing.');
      }

      const payloadMeta = val(row, 'payloadJson')?._approvalMeta || {};
      const allowSelfApproval = Boolean(payloadMeta.allowSelfApproval);
      if (!allowSelfApproval && !actor.isRoot && Number(val(row, 'requesterUserId')) === Number(actor.userId)) {
        throw failApproval('SELF_APPROVAL_FORBIDDEN', 403, 'Requester cannot self-approve this request.');
      }

      let dlgResult = { delegations: [] };
      if (stage.allowDelegation !== false) {
        dlgResult = await resolveDelegationsForActor(db, {
          organizationId: rowOrg,
          userId: actor.userId,
          scope: [val(row, 'targetCollection'), 'latticeApprovalRequests'].filter(Boolean),
          now: nowDate,
        });
      }

      const auth = canActorVoteOnStage(stage, actor, {
        allowSelfApproval,
        requesterUserId: val(row, 'requesterUserId'),
        delegatedRoles: dlgResult.delegations || [],
      });
      if (!auth.allowed) {
        throw failApproval('APPROVAL_FORBIDDEN', 403, 'Caller lacks required role or active delegation for this approval stage.');
      }

      const existingDecisions = Array.isArray(stage.decisions) ? stage.decisions : [];
      if (existingDecisions.some((d) => Number(d.userId) === Number(actor.userId))) {
        throw failApproval('APPROVAL_ALREADY_VOTED', 409, 'User has already voted in this approval stage.');
      }

      const voteEntry = {
        userId: Number(actor.userId),
        username: actor.username,
        decision: normalizedDecision,
        note: cleanNote || null,
        decidedAt: nowIso,
        matchedRole: auth.matchedRole || null,
        delegatedFromUserId: auth.viaDelegation?.delegatorUserId ?? null,
        delegationUid: auth.viaDelegation?.delegationUid ?? null,
      };

      const nextStages = stages.map((st, i) => {
        if (i !== stageIdx) return st;
        return { ...st, decisions: [...existingDecisions, voteEntry] };
      });
      const updatedStage = nextStages[stageIdx];

      let nextStatus = 'pending';
      let nextStageIndex = stageIdx;
      let nextDueAt = val(row, 'dueAt') || null;
      let nextEscalatedAt = val(row, 'escalatedAt') || null;
      let finalDecidedAt = null;
      let finalById = null;
      let finalByName = null;
      let finalNote = null;
      let stageAdvanced = false;

      if (normalizedDecision === 'reject') {
        updatedStage.status = 'rejected';
        nextStatus = 'rejected';
        finalDecidedAt = nowDate;
        finalById = Number(actor.userId);
        finalByName = actor.username;
        finalNote = cleanNote;
      } else {
        const approveCount = updatedStage.decisions.filter((d) => d.decision === 'approve').length;
        const required = Math.max(1, Number(updatedStage.requiredApprovals) || 1);
        if (approveCount >= required) {
          updatedStage.status = 'approved';
          if (stageIdx + 1 < nextStages.length) {
            nextStageIndex = stageIdx + 1;
            const upcoming = nextStages[nextStageIndex];
            const upcomingSlaMin = Math.max(1, Number(upcoming.slaMinutes) || 1440);
            const upcomingDueIso = new Date(nowMs + upcomingSlaMin * 60_000).toISOString();
            upcoming.dueAt = upcomingDueIso;
            upcoming.escalatedAt = null;
            nextDueAt = new Date(upcomingDueIso);
            nextEscalatedAt = null;
            stageAdvanced = true;
          } else {
            nextStatus = 'approved';
            finalDecidedAt = nowDate;
            finalById = Number(actor.userId);
            finalByName = actor.username;
            finalNote = cleanNote || null;
          }
        }
      }

      const patch = {
        status: nextStatus,
        currentStageIndex: nextStageIndex,
        stagesStateJson: nextStages,
        dueAt: nextDueAt,
        escalatedAt: nextEscalatedAt,
        decidedAt: finalDecidedAt,
        finalDecisionByUserId: finalById,
        finalDecisionByUsername: finalByName,
        finalDecisionNote: finalNote,
      };

      let savedRow = row;
      if (typeof repoUpdateCompat === 'function') {
        savedRow = await repoUpdateCompat(
          reqRepo,
          row,
          { id: val(row, 'id'), organizationId: rowOrg, status: 'pending', currentStageIndex: stageIdx },
          patch,
          transaction,
          { expectedStageIndex: stageIdx, expectedDecisionCount: existingDecisions.length },
        );
      }

      const serialized = serializeApprovalRequest(savedRow);
      if (nextStatus === 'approved' || nextStatus === 'rejected') {
        await safeAppendApprovalLedger(db, {
          organizationId: rowOrg,
          eventType: nextStatus === 'approved' ? 'approval.approved' : 'approval.rejected',
          requestUid: serialized.requestUid,
          actor,
          payload: {
            requestUid: serialized.requestUid,
            decision: nextStatus,
            note: finalNote,
            stageIndex: stageIdx,
            delegationUid: voteEntry.delegationUid,
            delegatedFromUserId: voteEntry.delegatedFromUserId,
          },
          metadata: voteEntry.delegationUid ? {
            delegationUid: voteEntry.delegationUid,
            delegatedFromUserId: voteEntry.delegatedFromUserId,
          } : null,
          transaction,
        });
      }

      return {
        request: serialized,
        rowOrg,
        nextStatus,
        stageAdvanced,
        nextStageIndex,
        notifyChannels: payloadMeta.notifyChannels || null,
      };
    }));

    if (outcome.nextStatus === 'approved' || outcome.nextStatus === 'rejected') {
      await safePublishApprovalEvent(db, {
        organizationId: outcome.rowOrg,
        eventType: outcome.nextStatus === 'approved' ? 'approval.approved' : 'approval.rejected',
        requestUid: outcome.request.requestUid,
        data: {
          requestUid: outcome.request.requestUid,
          targetCollection: outcome.request.targetCollection,
          targetRecordId: outcome.request.targetRecordId,
          status: outcome.nextStatus,
          finalDecisionByUserId: outcome.request.finalDecisionByUserId,
          finalDecisionNote: outcome.request.finalDecisionNote,
        },
        app,
      });

      await dispatchNotification(db, {
        organizationId: outcome.rowOrg,
        recipientUserId: outcome.request.requesterUserId,
        recipientEmployeeId: outcome.request.requesterEmployeeId,
        category: 'approval',
        severity: outcome.nextStatus === 'rejected' ? 'high' : 'info',
        title: outcome.nextStatus === 'approved'
          ? `Đã phê duyệt: ${outcome.request.title}`
          : `Bị từ chối: ${outcome.request.title}`,
        body: outcome.request.finalDecisionNote || `Yêu cầu ${outcome.request.requestUid} đã chuyển sang ${outcome.nextStatus}.`,
        targetCollection: outcome.request.targetCollection,
        targetRecordId: outcome.request.targetRecordId,
        targetPath: resolveNotificationTargetPath(outcome.request.targetCollection),
        dedupKey: `approval-final:${outcome.rowOrg}:${outcome.request.requestUid}:${outcome.nextStatus}`,
        notifyChannels: outcome.notifyChannels,
      }, { app }).catch(() => {});
    } else if (outcome.stageAdvanced) {
      const nextStage = outcome.request.stagesStateJson[outcome.nextStageIndex];
      await safeNotifyStageApprovers(db, {
        organizationId: outcome.rowOrg,
        request: outcome.request,
        stage: nextStage,
        notifyChannels: outcome.notifyChannels,
        dedupKey: `approval:${outcome.rowOrg}:${outcome.request.requestUid}:stage-${outcome.nextStageIndex}`,
        title: `Chuyển bước phê duyệt: ${outcome.request.title}`,
        body: `Bước "${nextStage.name}" cần phê duyệt cho ${outcome.request.requestUid}.`,
        severity: outcome.request.riskLevel === 'critical' ? 'critical' : 'info',
        app,
      });
    }

    return outcome.request;
  } finally {
    inFlightClaims.delete(claimKey);
  }
}

async function repoUpdateCompat(repo, row, filter, values, transaction, optimisticGuard = null) {
  if (optimisticGuard && repo && typeof repo.findOne === 'function') {
    const latest = await repo.findOne({
      filter: { id: filter.id, ...(filter.organizationId ? { organizationId: filter.organizationId } : {}) },
      ...(transaction ? { transaction } : {}),
    });
    if (!latest || (filter.status && val(latest, 'status') !== filter.status)) {
      throw failApproval('APPROVAL_ALREADY_DECIDED', 409, 'Approval request was already updated concurrently.');
    }
    const latestStageIdx = Number(val(latest, 'currentStageIndex')) || 0;
    if (optimisticGuard.expectedStageIndex !== undefined && latestStageIdx !== optimisticGuard.expectedStageIndex) {
      throw failApproval('APPROVAL_CONFLICT', 409, 'Approval request stage advanced concurrently.');
    }
    if (optimisticGuard.expectedDecisionCount !== undefined) {
      const latestStages = val(latest, 'stagesStateJson') || [];
      const latestCount = Array.isArray(latestStages[latestStageIdx]?.decisions)
        ? latestStages[latestStageIdx].decisions.length
        : 0;
      if (latestCount !== optimisticGuard.expectedDecisionCount) {
        throw failApproval('APPROVAL_CONFLICT', 409, 'Approval request decisions changed concurrently.');
      }
    }
  }
  if (repo && typeof repo.update === 'function') {
    const res = await repo.update({
      ...(filter.id != null ? { filterByTk: filter.id } : {}),
      filter,
      values,
      ...(transaction ? { transaction } : {}),
    });
    if (Array.isArray(res) && res.length === 0) {
      throw failApproval('APPROVAL_ALREADY_DECIDED', 409, 'Approval request was already updated concurrently.');
    }
    if (Array.isArray(res) && res[0]) return res[0];
  }
  if (typeof row?.update === 'function') {
    return row.update(values, transaction ? { transaction } : undefined);
  }
  return { ...(toPlain(row) || {}), ...values };
}

async function cancelApprovalRequest(db, { organizationId = null, actor, requestIdOrUid, note = '' } = {}) {
  if (!actor?.userId) {
    throw failApproval('NATIVE_LOGIN_REQUIRED', 401, 'Authentication required.');
  }
  const keyRaw = String(requestIdOrUid ?? '').trim();
  if (!keyRaw) {
    throw failApproval('APPROVAL_REQUEST_ID_REQUIRED', 400, 'requestUid or id is required.');
  }
  const reqRepo = getRepo(db, 'latticeApprovalRequests');
  if (!reqRepo) throw failApproval('APPROVAL_REPO_UNAVAILABLE', 503, 'latticeApprovalRequests repository is unavailable.');
  const isNumeric = /^[1-9]\d*$/.test(keyRaw);
  const scopedOrg = actor.isRoot ? (organizationId || null) : assertValidOrgId(actor.organizationId);

  return runScopedDb(db, scopedOrg, async (transaction) => {
    const txOpt = transaction ? { transaction } : {};
    const filter = {
      ...(isNumeric ? { id: Number(keyRaw) } : { requestUid: keyRaw }),
      ...(scopedOrg ? { organizationId: scopedOrg } : {}),
    };
    const row = await reqRepo.findOne({ filter, ...txOpt });
    if (!row || (scopedOrg && val(row, 'organizationId') !== scopedOrg)) {
      throw failApproval('APPROVAL_REQUEST_NOT_FOUND', 404, 'Approval request not found.');
    }
    if (!actor.isRoot && !actor.isAdmin && Number(val(row, 'requesterUserId')) !== Number(actor.userId)) {
      throw failApproval('APPROVAL_FORBIDDEN', 403, 'Only requester or administrator can cancel this approval request.');
    }
    if (val(row, 'status') !== 'pending') {
      throw failApproval('APPROVAL_ALREADY_DECIDED', 409, `Approval request is already "${val(row, 'status')}".`);
    }
    const now = new Date();
    const updated = await repoUpdateCompat(
      reqRepo,
      row,
      { id: val(row, 'id'), organizationId: val(row, 'organizationId'), status: 'pending' },
      {
        status: 'cancelled',
        decidedAt: now,
        finalDecisionByUserId: Number(actor.userId),
        finalDecisionByUsername: actor.username,
        finalDecisionNote: String(note || 'Cancelled').trim().slice(0, 500),
      },
      transaction,
    );
    return serializeApprovalRequest(updated);
  });
}

async function evaluateApprovalSlas(db, {
  organizationId = null,
  now = new Date(),
  dryRun = false,
  env = process.env,
  fetchImpl,
  app = null,
} = {}) {
  const reqRepo = getRepo(db, 'latticeApprovalRequests');
  if (!reqRepo || typeof reqRepo.find !== 'function') {
    return { scanned: 0, breachedCount: 0, escalatedCount: 0, items: [] };
  }

  const nowDate = now instanceof Date ? now : new Date(now);
  const nowMs = Number.isFinite(nowDate.getTime()) ? nowDate.getTime() : Date.now();
  const nowIso = nowDate.toISOString();

  const rows = (await runScopedDb(db, organizationId, (transaction) => reqRepo.find({
    filter: {
      status: 'pending',
      active: { $ne: false },
      ...(organizationId ? { organizationId } : {}),
    },
    sort: ['dueAt', 'id'],
    limit: 500,
    ...(transaction ? { transaction } : {}),
  }))) || [];

  const items = [];
  let breachedCount = 0;
  let escalatedCount = 0;

  for (const row of rows) {
    if (val(row, 'status') !== 'pending' || val(row, 'active') === false) continue;
    const rowOrg = val(row, 'organizationId');
    if (organizationId && rowOrg !== organizationId) continue;

    const stages = sanitizePlainJson(val(row, 'stagesStateJson')) || [];
    const stageIdx = Number(val(row, 'currentStageIndex')) || 0;
    const activeStage = stages[stageIdx];
    const dueRaw = activeStage?.dueAt || val(row, 'dueAt');
    const dueMs = dueRaw ? new Date(dueRaw).getTime() : NaN;
    if (!Number.isFinite(dueMs) || dueMs > nowMs) continue;

    breachedCount += 1;
    const requestUid = val(row, 'requestUid');
    const escalateRole = String(activeStage?.escalateToRole || 'ldx_director').trim() || 'ldx_director';
    const alreadyEscalated = Boolean(activeStage?.escalatedAt);
    let escalatedNow = false;

    if (!dryRun && !alreadyEscalated) {
      const payloadMeta = val(row, 'payloadJson')?._approvalMeta || {};
      const dedupKey = `approval-sla:${rowOrg}:${requestUid}:stage-${stageIdx}`;
      try {
        const res = await dispatchRoleNotifications(db, {
          organizationId: rowOrg,
          roleNames: [escalateRole],
          category: 'sla',
          severity: 'high',
          title: `Quá hạn phê duyệt: ${val(row, 'title')}`,
          body: `Yêu cầu ${requestUid} (${val(row, 'targetCollection')}) đã quá hạn SLA tại bước "${activeStage?.name || stageIdx}".`,
          targetCollection: val(row, 'targetCollection'),
          targetRecordId: val(row, 'targetRecordId'),
          targetPath: resolveNotificationTargetPath(val(row, 'targetCollection')),
          dedupKey,
          notifyChannels: payloadMeta.notifyChannels || null,
        }, { env, fetchImpl, app });
        if ((res?.dispatchedCount || 0) > 0) escalatedNow = true;
      } catch {}

      const nextStages = stages.map((st, idx) => (idx === stageIdx ? { ...st, escalatedAt: nowIso } : st));
      await runScopedDb(db, rowOrg, (transaction) => repoUpdateCompat(
        reqRepo,
        row,
        { id: val(row, 'id'), organizationId: rowOrg },
        { stagesStateJson: nextStages, escalatedAt: nowDate },
        transaction,
      )).catch(() => {});
      if (escalatedNow) escalatedCount += 1;
    }

    items.push({
      organizationId: rowOrg,
      requestUid,
      stageIndex: stageIdx,
      escalateToRole: escalateRole,
      dueAt: new Date(dueMs).toISOString(),
      escalated: escalatedNow || alreadyEscalated,
    });
  }

  return {
    scanned: rows.length,
    breachedCount,
    escalatedCount,
    items,
  };
}

function safeGetResource(ctx, resourceName) {
  const rms = [ctx?.app?.resourceManager, ctx?.app?.mainDataSource?.resourceManager, ctx?.app?.resourcer];
  for (const rm of rms) {
    if (!rm) continue;
    try {
      if (typeof rm.isDefined === 'function' && !rm.isDefined(resourceName)) continue;
      const res = rm.getResource?.(resourceName);
      if (res) return res;
    } catch {}
  }
  return null;
}

async function invokeResourceAction(ctx, resourceName, actionName, options = {}) {
  const { filterByTk, values, method, ...extraParams } = options && typeof options === 'object' ? options : {};
  const resource = safeGetResource(ctx, resourceName);
  const handler = resource?.actions?.get?.(actionName)?.handler || resource?.actions?.[actionName];
  if (typeof handler !== 'function') {
    return { available: false };
  }
  const params = {
    resourceName,
    actionName,
    ...extraParams,
    ...(filterByTk != null ? { filterByTk } : {}),
    ...(values ? { values } : {}),
  };
  const subCtx = {
    ...(method ? { method } : {}),
    ...(method === 'GET' ? { query: { ...extraParams } } : {}),
    app: ctx.app,
    db: ctx.db,
    dataSource: ctx.dataSource || ctx.app?.mainDataSource,
    state: { ...ctx.state },
    auth: ctx.auth,
    headers: ctx.headers || {},
    request: { headers: ctx.request?.headers || ctx.headers || {}, body: values || extraParams },
    action: {
      actionName,
      resourceName,
      params,
      mergeParams: (patch) => {
        if (patch && typeof patch === 'object') Object.assign(params, patch);
      },
    },
    body: null,
    throw: (s, m) => {
      throw Object.assign(new Error(m || `${resourceName}:${actionName} failed`), { status: s });
    },
  };
  await handler(subCtx, async () => {});
  return { available: true, body: subCtx.body?.data || subCtx.body || {} };
}

function matchesInboxSearch(item, cleanSearch) {
  if (!cleanSearch) return true;
  const hay = [
    item.title,
    item.summary,
    item.targetCode,
    item.targetCollection,
    item.targetRecordId != null ? String(item.targetRecordId) : '',
    item.requesterUsername,
    item.requestUid,
    item.ruleKey,
    item.itemKey,
    item.aiEmployee,
  ]
    .filter((v) => v != null && String(v).trim() !== '')
    .map((v) => String(v).toLowerCase());
  return hay.some((field) => field.includes(cleanSearch));
}

async function listUnifiedInbox(db, {
  actor,
  organizationId = null,
  source = 'all',
  status = 'pending',
  assignedToMe = false,
  search = '',
  limit = 50,
  now = new Date(),
} = {}) {
  const cleanSource = String(source || 'all').trim().toLowerCase();
  if (!VALID_INBOX_SOURCES.has(cleanSource)) {
    throw failApproval('APPROVAL_SOURCE_INVALID', 400, 'source must be all, business, ai_hitl, flow, or proposals.');
  }
  const cleanStatus = String(status || 'pending').trim().toLowerCase();
  const cleanSearch = String(search || '').trim().toLowerCase();
  const cap = Math.max(1, Math.min(200, Number(limit) || 50));
  const scopedOrg = actor.isRoot ? (organizationId || null) : assertValidOrgId(actor.organizationId);
  const verifiedSet = new Set(Array.isArray(actor.verifiedRoles) ? actor.verifiedRoles : []);

  const dlgRes = scopedOrg
    ? await resolveDelegationsForActor(db, {
      organizationId: scopedOrg,
      userId: actor.userId,
      scope: '*',
      includeScoped: true,
      now,
    }).catch(() => ({ delegations: [] }))
    : { delegations: [] };
  const allDelegations = Array.isArray(dlgRes.delegations) ? dlgRes.delegations : [];

  const items = [];
  const counts = { business: 0, proposals: 0, ai_hitl: 0, flow: 0 };

  {
    const reqRepo = getRepo(db, 'latticeApprovalRequests');
    if (reqRepo && typeof reqRepo.find === 'function') {
      const bizFilter = {
        ...(scopedOrg ? { organizationId: scopedOrg } : {}),
        ...(cleanStatus !== 'all' ? { status: cleanStatus } : {}),
        active: { $ne: false },
      };
      const rows = (await runScopedDb(db, scopedOrg, (tx) => reqRepo.find({
        filter: bizFilter,
        sort: ['-createdAt', '-id'],
        limit: cap,
        ...(tx ? { transaction: tx } : {}),
      }))) || [];

      for (const row of rows) {
        const ser = serializeApprovalRequest(row);
        if (scopedOrg && ser.organizationId !== scopedOrg) continue;
        if (cleanStatus !== 'all' && ser.status !== cleanStatus) continue;
        const activeStage = ser.stagesStateJson[ser.currentStageIndex] || null;
        const allowSelf = Boolean(ser.payloadJson?._approvalMeta?.allowSelfApproval);
        const scopedDlgs = allDelegations.filter(
          (d) => !d.scopeCollection || d.scopeCollection === ser.targetCollection || d.scopeCollection === 'latticeApprovalRequests',
        );
        const canVote = ser.status === 'pending' && activeStage
          ? canActorVoteOnStage(activeStage, actor, {
            allowSelfApproval: allowSelf,
            requesterUserId: ser.requesterUserId,
            delegatedRoles: scopedDlgs,
          }).allowed
          : false;
        const item = {
          source: 'business',
          itemKey: `biz:${ser.requestUid}`,
          id: ser.id,
          requestUid: ser.requestUid,
          organizationId: ser.organizationId,
          title: ser.title,
          summary: ser.summary,
          diffPreview: ser.payloadJson?.diffPreview ?? null,
          targetCollection: ser.targetCollection,
          targetRecordId: ser.targetRecordId,
          targetCode: ser.targetCode,
          riskLevel: ser.riskLevel,
          status: ser.status,
          currentStageIndex: ser.currentStageIndex,
          totalStages: ser.totalStages,
          stagesStateJson: ser.stagesStateJson,
          requesterUserId: ser.requesterUserId,
          requesterUsername: ser.requesterUsername,
          dueAt: ser.dueAt,
          createdAt: ser.createdAt,
          canAct: Boolean(canVote),
        };
        if ((!assignedToMe || item.canAct) && matchesInboxSearch(item, cleanSearch)) {
          counts.business += 1;
          if (cleanSource === 'all' || cleanSource === 'business') {
            items.push(item);
          }
        }
      }
    }
  }

  {
    const aiRepo = getRepo(db, 'latticeAiApprovalQueue');
    if (aiRepo && typeof aiRepo.find === 'function') {
      const aiFilter = {
        ...(scopedOrg ? { organizationId: scopedOrg } : {}),
        ...(cleanStatus !== 'all' ? { status: cleanStatus } : {}),
      };
      const rows = (await runScopedDb(db, scopedOrg, (tx) => aiRepo.find({
        filter: aiFilter,
        sort: ['-createdAt', '-id'],
        limit: cap,
        ...(tx ? { transaction: tx } : {}),
      }))) || [];

      const isHitlRole = actor.isRoot || actor.isAdmin || [...verifiedSet].some((r) => DEFAULT_HITL_APPROVER_ROLES.has(r));
      for (const row of rows) {
        const toolName = String(val(row, 'toolName') || '');
        if (toolName === 'latticeflow.approval') continue; // Canonical flow items come from latticeAutomationRuns
        const rowOrg = val(row, 'organizationId');
        if (scopedOrg && rowOrg !== scopedOrg) continue;
        const rowStatus = String(val(row, 'status') || '');
        if (cleanStatus !== 'all' && rowStatus !== cleanStatus) continue;
        const reqUid = Number(val(row, 'requesterUserId'));
        const rowCol = val(row, 'targetCollection');
        const dlgHitl = allDelegations.some(
          (d) => (!d.scopeCollection || d.scopeCollection === rowCol || d.scopeCollection === 'latticeAiApprovalQueue')
            && DEFAULT_HITL_APPROVER_ROLES.has(d.roleName),
        );
        const canAct = rowStatus === 'pending'
          && (isHitlRole || dlgHitl)
          && (actor.isRoot || reqUid !== Number(actor.userId));
        if (!isHitlRole && !dlgHitl && reqUid !== Number(actor.userId)) continue;

        const diff = val(row, 'diffPreview') || {};
        const item = {
          source: 'ai_hitl',
          itemKey: `ai:${val(row, 'id')}`,
          id: val(row, 'id'),
          organizationId: rowOrg,
          title: diff.title || `${val(row, 'aiEmployee') || 'AI'}: ${toolName}`,
          summary: diff.summary || '',
          diffPreview: val(row, 'diffPreview') ?? null,
          proposedArgs: val(row, 'proposedArgs') ?? null,
          toolName,
          aiEmployee: val(row, 'aiEmployee') || null,
          targetCollection: rowCol || null,
          targetRecordId: val(row, 'targetRecordId') ?? null,
          operation: val(row, 'operation') || 'update',
          riskLevel: val(row, 'riskLevel') || diff.riskLevel || 'medium',
          status: rowStatus,
          requesterUserId: reqUid,
          requesterUsername: val(row, 'requesterUsername') || null,
          dueAt: val(row, 'expiresAt') || null,
          createdAt: val(row, 'createdAt') || null,
          canAct: Boolean(canAct),
        };
        if ((!assignedToMe || item.canAct) && matchesInboxSearch(item, cleanSearch)) {
          counts.ai_hitl += 1;
          if (cleanSource === 'all' || cleanSource === 'ai_hitl') {
            items.push(item);
          }
        }
      }
    }
  }

  {
    const runsRepo = getRepo(db, 'latticeAutomationRuns');
    if (runsRepo && typeof runsRepo.find === 'function') {
      const flowStatusFilter = cleanStatus === 'pending' ? { status: 'suspended' } : {};
      const rows = (await runScopedDb(db, scopedOrg, (tx) => runsRepo.find({
        filter: {
          ...(scopedOrg ? { organizationId: scopedOrg } : {}),
          ...flowStatusFilter,
        },
        sort: ['-createdAt', '-id'],
        limit: cap,
        ...(tx ? { transaction: tx } : {}),
      }))) || [];

      for (const row of rows) {
        const rowOrg = val(row, 'organizationId');
        if (scopedOrg && rowOrg !== scopedOrg) continue;
        const suspendedNodeId = val(row, 'suspendedNodeId');
        const nodeStates = val(row, 'nodeStatesJson') || {};
        const suspendMeta = suspendedNodeId ? nodeStates[suspendedNodeId]?.suspend : null;
        const approvalId = val(row, 'approvalId') ?? suspendMeta?.approvalId ?? null;
        const isApprovalRun = approvalId != null || suspendMeta?.kind === 'approval';
        if (!isApprovalRun) continue;

        const rowStatus = String(val(row, 'status') || '');
        const nodeOut = suspendedNodeId ? (nodeStates[suspendedNodeId]?.output || {}) : {};
        const normalizedFlowStatus = rowStatus === 'suspended'
          ? 'pending'
          : (nodeOut.decision === 'rejected'
            ? 'rejected'
            : (nodeOut.decision === 'approved' ? 'approved' : rowStatus));
        if (cleanStatus !== 'all' && normalizedFlowStatus !== cleanStatus) continue;

        const approverRole = String(suspendMeta?.approverRole || nodeOut.approverRole || '').trim();
        const tp = val(row, 'triggerPayloadJson') || {};
        const reqUid = tp.actor?.userId != null ? Number(tp.actor.userId) : null;

        const hasDirectRole = actor.isRoot
          || actor.isAdmin
          || (approverRole ? verifiedSet.has(approverRole) : [...verifiedSet].some((r) => DEFAULT_FLOW_APPROVER_ROLES.has(r)));
        const hasDelegatedRole = allDelegations.some(
          (d) => (!d.scopeCollection || d.scopeCollection === 'latticeAutomationRuns')
            && (approverRole ? d.roleName === approverRole : DEFAULT_FLOW_APPROVER_ROLES.has(d.roleName)),
        );
        const canAct = rowStatus === 'suspended'
          && (hasDirectRole || hasDelegatedRole)
          && (actor.isRoot || reqUid == null || reqUid !== Number(actor.userId));

        const runUid = val(row, 'runUid');
        const item = {
          source: 'flow',
          itemKey: `flow:${runUid}`,
          id: val(row, 'id') ?? null,
          runUid,
          ruleKey: val(row, 'ruleKey') || null,
          approvalId,
          suspendedNodeId: suspendedNodeId || null,
          approverRole: approverRole || null,
          organizationId: rowOrg,
          title: nodeOut.title || `Flow Approval (${val(row, 'ruleKey') || runUid})`,
          summary: nodeOut.summary || '',
          riskLevel: nodeOut.riskLevel || 'medium',
          status: normalizedFlowStatus,
          runStatus: rowStatus,
          requesterUserId: reqUid,
          requesterUsername: tp.actor?.username || null,
          dueAt: val(row, 'resumeAt') || suspendMeta?.resumeAt || null,
          createdAt: val(row, 'createdAt') || null,
          canAct: Boolean(canAct),
        };
        if ((!assignedToMe || item.canAct) && matchesInboxSearch(item, cleanSearch)) {
          counts.flow += 1;
          if (cleanSource === 'all' || cleanSource === 'flow') {
            items.push(item);
          }
        }
      }
    }
  }

  if (cleanStatus !== 'executed') {
    const propStateFilter = cleanStatus === 'all'
      ? null
      : (cleanStatus === 'pending'
        ? 'proposed'
        : (['approved', 'rejected', 'reviewed'].includes(cleanStatus) ? cleanStatus : '__none__'));
    if (propStateFilter !== '__none__') {
      const propRepo = getRepo(db, 'latticeAgentProposals');
      if (propRepo && typeof propRepo.find === 'function') {
        const propFilter = {
          ...(scopedOrg ? { organizationId: scopedOrg } : {}),
          ...(propStateFilter ? { state: propStateFilter } : {}),
        };
        const rows = (await runScopedDb(db, scopedOrg, (tx) => propRepo.find({
          filter: propFilter,
          sort: ['-createdAt', '-id'],
          limit: cap,
          ...(tx ? { transaction: tx } : {}),
        }))) || [];

        const isProposalRole = actor.isRoot
          || actor.isAdmin
          || [...verifiedSet].some((r) => DEFAULT_HITL_APPROVER_ROLES.has(r));

        for (const row of rows) {
          const rowOrg = val(row, 'organizationId');
          if (scopedOrg && rowOrg !== scopedOrg) continue;
          const rowState = String(val(row, 'state') || 'proposed');
          if (propStateFilter && rowState !== propStateFilter) continue;

          const srcUid = val(row, 'sourceUserId') != null ? Number(val(row, 'sourceUserId')) : 0;
          const rowCol = val(row, 'targetCollection') || null;
          const dlgProp = allDelegations.some(
            (d) => (!d.scopeCollection || d.scopeCollection === rowCol || d.scopeCollection === 'latticeAgentProposals')
              && DEFAULT_HITL_APPROVER_ROLES.has(d.roleName),
          );
          const isProposalApprover = isProposalRole || dlgProp;
          if (!isProposalApprover && srcUid !== Number(actor.userId)) continue;

          const canAct = rowState === 'proposed'
            && isProposalApprover
            && (actor.isRoot || srcUid === 0 || srcUid !== Number(actor.userId));

          const propId = val(row, 'id');
          const targetRecordId = val(row, 'targetRecordId') ?? null;
          const recommendation = String(val(row, 'recommendation') || '');
          const evidence = Array.isArray(val(row, 'evidence')) ? val(row, 'evidence') : [];

          const item = {
            source: 'proposals',
            itemKey: `prop:${propId}`,
            id: propId,
            organizationId: rowOrg,
            title: `Đề xuất AI: ${rowCol || 'Hồ sơ'}${targetRecordId != null ? ` #${targetRecordId}` : ''}`,
            summary: recommendation,
            diffPreview: { summary: recommendation, changes: [] },
            evidence,
            targetCollection: rowCol,
            targetRecordId,
            eventId: val(row, 'eventId') || null,
            riskLevel: 'medium',
            status: rowState === 'proposed' ? 'pending' : rowState,
            proposalState: rowState,
            requesterUserId: srcUid || null,
            sourceEmployeeId: val(row, 'sourceEmployeeId') ?? null,
            createdAt: val(row, 'createdAt') || null,
            canAct: Boolean(canAct),
          };
          if ((!assignedToMe || item.canAct) && matchesInboxSearch(item, cleanSearch)) {
            counts.proposals += 1;
            if (cleanSource === 'all' || cleanSource === 'proposals') {
              items.push(item);
            }
          }
        }
      }
    }
  }

  items.sort((a, b) => {
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return tb - ta;
  });

  const totalCount = counts.business + counts.proposals + counts.ai_hitl + counts.flow;

  return {
    organizationId: scopedOrg,
    total: items.length,
    counts: {
      business: counts.business,
      proposals: counts.proposals,
      ai_hitl: counts.ai_hitl,
      aiHitl: counts.ai_hitl,
      flow: counts.flow,
      all: totalCount,
      total: totalCount,
    },
    items: items.slice(0, cap),
  };
}

function parseSourceAndTarget(params) {
  let source = params.source ? String(params.source).trim().toLowerCase() : '';
  const itemKey = params.itemKey ? String(params.itemKey).trim() : '';
  if (!source && itemKey) {
    if (itemKey.startsWith('biz:')) source = 'business';
    else if (itemKey.startsWith('ai:')) source = 'ai_hitl';
    else if (itemKey.startsWith('flow:')) source = 'flow';
    else if (itemKey.startsWith('prop:')) source = 'proposals';
  }
  if (source === 'proposal') source = 'proposals';
  if (!source) source = 'business';
  const strippedKey = itemKey.includes(':') ? itemKey.split(':').slice(1).join(':') : itemKey;
  return { source, strippedKey };
}

async function decideUnifiedInboxItem(db, ctx, params) {
  const { source, strippedKey } = parseSourceAndTarget(params);
  const decision = String(params.decision || '').trim().toLowerCase();
  const allowedDecisions = source === 'proposals' ? VALID_PROPOSAL_DECISIONS : VALID_DECISIONS;
  if (!allowedDecisions.has(decision)) {
    throw failApproval(
      'APPROVAL_INVALID_DECISION',
      400,
      source === 'proposals' ? 'decision must be approve, reject, or review.' : 'decision must be approve or reject.',
    );
  }
  const note = String(params.note ?? params.decisionNote ?? params.reason ?? '').trim();

  if (source === 'business') {
    assertApiKeyScope(ctx, ['write']);
    const actor = await resolveActorContext(db, ctx, { requestedOrgId: params.organizationId, allowRootCrossOrg: true });
    const requestIdOrUid = params.requestUid || params.id || params.filterByTk || strippedKey;
    return decideApprovalRequest(db, {
      organizationId: actor.organizationId,
      actor,
      requestIdOrUid,
      decision,
      note,
      app: ctx?.app || db?.app,
    });
  }

  if (source === 'ai_hitl') {
    assertApiKeyScope(ctx, ['write', 'ai']);
    const actor = await resolveActorContext(db, ctx, { requestedOrgId: params.organizationId, allowRootCrossOrg: true });
    const approvalId = Number(params.approvalId ?? params.id ?? strippedKey);
    if (!Number.isInteger(approvalId) || approvalId <= 0) {
      throw failApproval('APPROVAL_ID_REQUIRED', 400, 'Valid numeric approvalId is required for ai_hitl.');
    }
    const actionName = decision === 'approve' ? 'approveAction' : 'rejectAction';
    const res = await invokeResourceAction(ctx, 'dxosAi', actionName, {
      method: 'POST',
      approvalId,
      id: approvalId,
      note,
      organizationId: actor.organizationId,
    });
    if (res.available) return res.body;

    const executeApprovedWrite = typeof params?.executeApprovedWrite === 'function'
      ? params.executeApprovedWrite
      : (typeof ctx?.executeApprovedWrite === 'function' ? ctx.executeApprovedWrite : null);

    if (decision === 'approve' && typeof executeApprovedWrite !== 'function') {
      throw failApproval('HOST_ACTION_UNAVAILABLE', 503, 'dxosAi HITL resource is unavailable to execute approved AI tool.');
    }

    const aiHitl = loadCrossPluginModule('plugin-dxos-ai', 'ai-hitl');
    if (typeof aiHitl?.decideApproval === 'function') {
      return aiHitl.decideApproval(db, {
        actor: {
          userId: String(actor.userId),
          username: actor.username,
          organizationId: actor.organizationId,
          roleNames: actor.verifiedRoles,
          isAdmin: actor.isAdmin,
        },
        approvalId,
        decision,
        note,
        ...(executeApprovedWrite ? { executeApprovedWrite } : {}),
      });
    }
    throw failApproval('HOST_ACTION_UNAVAILABLE', 503, 'dxosAi HITL resource is unavailable.');
  }

  if (source === 'flow') {
    assertApiKeyScope(ctx, ['write', 'ai']);
    if (decision === 'reject' && note.length < 3) {
      throw failApproval('APPROVAL_REJECTION_NOTE_REQUIRED', 400, 'Rejection reason must be at least 3 characters.');
    }
    const actor = await resolveActorContext(db, ctx, { requestedOrgId: params.organizationId, allowRootCrossOrg: true });
    let runUid = String(params.runUid || strippedKey || '').trim();
    const numericApprovalId = params.approvalId != null && /^[1-9]\d*$/.test(String(params.approvalId))
      ? Number(params.approvalId)
      : null;

    const runsRepo = getRepo(db, 'latticeAutomationRuns');
    if (runsRepo && typeof runsRepo.findOne === 'function') {
      const found = await runScopedDb(db, actor.organizationId, (tx) => runsRepo.findOne({
        filter: {
          ...(runUid ? { runUid } : { approvalId: numericApprovalId }),
          ...(actor.organizationId ? { organizationId: actor.organizationId } : {}),
        },
        ...(tx ? { transaction: tx } : {}),
      }));
      if (!found || (actor.organizationId && val(found, 'organizationId') !== actor.organizationId)) {
        throw failApproval('APPROVAL_REQUEST_NOT_FOUND', 404, 'Suspended flow approval run not found.');
      }
      if (!runUid) runUid = String(val(found, 'runUid') || '').trim();
      const tp = val(found, 'triggerPayloadJson') || {};
      const reqUid = tp.actor?.userId != null ? Number(tp.actor.userId) : null;
      if (!actor.isRoot && reqUid != null && reqUid === Number(actor.userId)) {
        throw failApproval('SELF_APPROVAL_FORBIDDEN', 403, 'Requester cannot self-approve a suspended flow approval.');
      }
    }
    if (!runUid) {
      throw failApproval('APPROVAL_RUN_ID_REQUIRED', 400, 'runUid is required for flow approval.');
    }

    const flowDecision = decision === 'approve' ? 'approved' : 'rejected';
    const res = await invokeResourceAction(ctx, 'dxosAutomations', 'resumeRun', {
      method: 'POST',
      runUid,
      organizationId: actor.organizationId,
      decision: flowDecision,
      payload: { note },
      ...(params.resumeToken ? { resumeToken: params.resumeToken } : {}),
    });
    if (res.available) return res.body;

    const flowExec = loadCrossPluginModule('plugin-dxos-studio', 'flow/executor');
    if (typeof flowExec?.resumeFlowRun === 'function') {
      return flowExec.resumeFlowRun(db, {
        organizationId: actor.organizationId,
        runUid,
        decision: flowDecision,
        payload: { note },
        resumeToken: params.resumeToken,
        actor: {
          id: actor.userId,
          userId: actor.userId,
          username: actor.username,
          roleNames: actor.verifiedRoles,
          roles: actor.verifiedRoles,
          isAdmin: actor.isAdmin,
        },
        options: { app: ctx?.app || db?.app },
      });
    }
    throw failApproval('HOST_ACTION_UNAVAILABLE', 503, 'dxosAutomations:resumeRun is unavailable.');
  }

  if (source === 'proposals') {
    assertApiKeyScope(ctx, ['write', 'ai']);
    const cleanNote = note.slice(0, 2000);
    if (decision === 'reject' && cleanNote.length < 3) {
      throw failApproval('APPROVAL_REJECTION_NOTE_REQUIRED', 400, 'Rejection reason must be at least 3 characters.');
    }
    const actor = await resolveActorContext(db, ctx, { requestedOrgId: params.organizationId, allowRootCrossOrg: true });
    const proposalId = Number(params.proposalId ?? params.id ?? strippedKey);
    if (!Number.isInteger(proposalId) || proposalId <= 0) {
      throw failApproval('PROPOSAL_ID_REQUIRED', 400, 'Valid numeric proposalId is required for proposals.');
    }
    const propRepo = getRepo(db, 'latticeAgentProposals');
    if (!propRepo || typeof propRepo.findOne !== 'function') {
      throw failApproval('PROPOSAL_REPO_UNAVAILABLE', 503, 'latticeAgentProposals repository is unavailable.');
    }

    const nextState = decision === 'approve' ? 'approved' : (decision === 'reject' ? 'rejected' : 'reviewed');
    const lockKey = `prop:${actor.organizationId || '*'}:${proposalId}`;
    const outcome = await withCanonicalDecisionLock(lockKey, () => runScopedDb(db, actor.organizationId, async (transaction) => {
      const txOpt = transaction ? { transaction } : {};
      const where = {
        id: proposalId,
        ...(actor.organizationId ? { organizationId: actor.organizationId } : {}),
      };
      const model = db?.getModel?.('latticeAgentProposals') || propRepo?.model;
      let row;
      if (model && typeof model.findOne === 'function') {
        row = await model.findOne({
          where,
          ...(transaction ? { transaction, lock: transaction.LOCK?.UPDATE } : {}),
        });
      } else {
        row = await propRepo.findOne({ filter: where, ...txOpt });
      }
      if (!row || (actor.organizationId && val(row, 'organizationId') !== actor.organizationId)) {
        throw failApproval('PROPOSAL_NOT_FOUND', 404, 'Proposal not found in organization scope.');
      }

      const rowOrg = val(row, 'organizationId');
      const targetCollection = val(row, 'targetCollection') || null;
      const targetRecordId = val(row, 'targetRecordId') ?? null;
      const verifiedSet = new Set(Array.isArray(actor.verifiedRoles) ? actor.verifiedRoles : []);
      const isDirectApprover = actor.isRoot
        || actor.isAdmin
        || [...verifiedSet].some((r) => DEFAULT_HITL_APPROVER_ROLES.has(r));
      let hasDelegatedApprover = false;
      if (!isDirectApprover && rowOrg) {
        const dlgRes = await resolveDelegationsForActor(db, {
          organizationId: rowOrg,
          userId: actor.userId,
          scope: [targetCollection, 'latticeAgentProposals'].filter(Boolean),
        }).catch(() => ({ delegations: [] }));
        hasDelegatedApprover = (dlgRes.delegations || []).some((d) => DEFAULT_HITL_APPROVER_ROLES.has(d.roleName));
      }
      if (!isDirectApprover && !hasDelegatedApprover) {
        throw failApproval('APPROVAL_FORBIDDEN', 403, 'Caller lacks required role or active delegation to decide proposal.');
      }

      const srcUid = val(row, 'sourceUserId') != null ? Number(val(row, 'sourceUserId')) : 0;
      if (!actor.isRoot && srcUid > 0 && srcUid === Number(actor.userId)) {
        throw failApproval('SELF_APPROVAL_FORBIDDEN', 403, 'Requester cannot self-approve their own proposal.');
      }

      const rowState = String(val(row, 'state') || '');
      if (rowState !== 'proposed') {
        throw failApproval('PROPOSAL_ALREADY_DECIDED', 409, `Proposal is already "${rowState}".`);
      }

      const preservedEvidence = Array.isArray(val(row, 'evidence')) ? sanitizePlainJson(val(row, 'evidence')) : [];
      if (typeof propRepo.update === 'function') {
        const updated = await propRepo.update({
          filterByTk: proposalId,
          filter: { id: proposalId, organizationId: rowOrg, state: 'proposed' },
          values: { state: nextState, evidence: preservedEvidence },
          ...txOpt,
        });
        if (Array.isArray(updated) && updated.length === 0) {
          throw failApproval('PROPOSAL_ALREADY_DECIDED', 409, 'Proposal was already updated concurrently.');
        }
      } else if (typeof row.update === 'function') {
        await row.update({ state: nextState, evidence: preservedEvidence }, transaction ? { transaction } : undefined);
      }

      await appendLedgerEntrySafely(db, {
        organizationId: rowOrg,
        eventType: `proposal.${nextState}`,
        targetCollection: 'latticeAgentProposals',
        targetRecordId: proposalId,
        actor,
        payload: {
          proposalId,
          targetCollection,
          targetRecordId,
          decision,
          state: nextState,
          note: cleanNote || null,
        },
      }, { transaction, scope: 'dxos:approvals' });

      return {
        rowOrg,
        targetCollection,
        targetRecordId,
        srcUid,
        sourceEmployeeId: val(row, 'sourceEmployeeId') ?? null,
        evidence: preservedEvidence,
      };
    }));

    const app = ctx?.app || db?.app;
    await safePublishApprovalEvent(db, {
      organizationId: outcome.rowOrg,
      eventType: `proposal.${nextState}`,
      requestUid: `prop:${proposalId}`,
      data: {
        proposalId,
        targetCollection: outcome.targetCollection,
        targetRecordId: outcome.targetRecordId,
        state: nextState,
        decision,
        decidedByUserId: Number(actor.userId),
        note: cleanNote || null,
      },
      app,
    });

    if (outcome.srcUid > 0) {
      await dispatchNotification(db, {
        organizationId: outcome.rowOrg,
        recipientUserId: outcome.srcUid,
        recipientEmployeeId: outcome.sourceEmployeeId,
        category: 'approval',
        severity: nextState === 'rejected' ? 'high' : 'info',
        title: nextState === 'approved'
          ? `Đã phê duyệt đề xuất AI #${proposalId}`
          : (nextState === 'rejected'
            ? `Từ chối đề xuất AI #${proposalId}`
            : `Đã xem xét đề xuất AI #${proposalId}`),
        body: cleanNote || `Đề xuất AI cho ${outcome.targetCollection || 'hồ sơ'} đã chuyển sang ${nextState}.`,
        targetCollection: outcome.targetCollection,
        targetRecordId: outcome.targetRecordId,
        targetPath: resolveNotificationTargetPath(outcome.targetCollection),
        dedupKey: `proposal-decision:${outcome.rowOrg}:${proposalId}:${nextState}`,
      }, { app }).catch(() => {});
    }

    return {
      ok: true,
      id: proposalId,
      itemKey: `prop:${proposalId}`,
      organizationId: outcome.rowOrg,
      targetCollection: outcome.targetCollection,
      targetRecordId: outcome.targetRecordId,
      state: nextState,
      status: nextState,
      decision,
      note: cleanNote || null,
      evidence: outcome.evidence,
    };
  }

  throw failApproval('APPROVAL_SOURCE_INVALID', 400, `Unsupported approval source "${source}".`);
}

function createApprovalsDirectGuardMiddleware(db = null) {
  return async function dxosApprovalsDirectGuard(ctx, next) {
    if (ctx?.state?.currentRole === 'root') {
      const activeDb = db || ctx?.db || ctx?.app?.db;
      const uid = val(ctx?.state?.currentUser, 'id');
      const ruRepo = getRepo(activeDb, 'rolesUsers');
      if (ruRepo && typeof ruRepo.find === 'function') {
        if (uid != null && /^[1-9]\d*$/.test(String(uid))) {
          const verified = await resolveVerifiedCallerRoles(activeDb, ctx, uid);
          if (verified.includes('root')) return next();
        }
      } else {
        return next();
      }
    }
    const fullResource = String(ctx?.action?.resourceName || '');
    const baseResource = fullResource.split('.')[0];
    const actionName = String(ctx?.action?.actionName || '');
    if (APPROVAL_PROTECTED_RESOURCES.has(baseResource)) {
      throw failApproval(
        'APPROVAL_DIRECT_CRUD_FORBIDDEN',
        403,
        'Direct CRUD on approval policies or requests is forbidden; use dxosApprovals API.',
      );
    }
    if (
      fullResource === 'charts'
      && actionName === 'queryData'
      && APPROVAL_PROTECTED_RESOURCES.has(String(ctx?.action?.params?.values?.collection || ''))
    ) {
      throw failApproval(
        'APPROVAL_DIRECT_CRUD_FORBIDDEN',
        403,
        'Direct chart queries on approval collections are forbidden; use dxosApprovals API.',
      );
    }
    return next();
  };
}

function createDxosApprovalsActions(db) {
  return {
    listInbox: async (ctx, next) => {
      if (ctx.method && String(ctx.method).toUpperCase() !== 'GET') ctx.throw(405);
      assertApiKeyScope(ctx, ['read', 'write', 'ai']);
      const params = readParams(ctx);
      const actor = await resolveActorContext(db, ctx, { requestedOrgId: params.organizationId, allowRootCrossOrg: true });
      const assignedToMe = params.assignedToMe === true || params.assignedToMe === 'true';
      ctx.body = await listUnifiedInbox(db, {
        actor,
        organizationId: actor.organizationId,
        source: params.source || 'all',
        status: params.status || 'pending',
        assignedToMe,
        search: params.search ?? params.q ?? '',
        limit: params.limit || 50,
      });
      if (next) return next();
    },

    decide: async (ctx, next) => {
      if (ctx.method && String(ctx.method).toUpperCase() !== 'POST') ctx.throw(405);
      const params = readParams(ctx);
      ctx.body = await decideUnifiedInboxItem(db, ctx, params);
      if (next) return next();
    },

    request: async (ctx, next) => {
      if (ctx.method && String(ctx.method).toUpperCase() !== 'POST') ctx.throw(405);
      assertApiKeyScope(ctx, ['write']);
      const params = readParams(ctx);
      const actor = await resolveActorContext(db, ctx, { requestedOrgId: params.organizationId, allowRootCrossOrg: false });
      ctx.body = await requestApproval(db, {
        organizationId: actor.organizationId,
        actor,
        policyId: params.policyId,
        policyKey: params.policyKey,
        targetCollection: params.targetCollection,
        targetRecordId: params.targetRecordId,
        targetCode: params.targetCode,
        title: params.title,
        summary: params.summary,
        riskLevel: params.riskLevel,
        payload: params.payload ?? params.payloadJson,
        stages: params.stages ?? params.stagesJson,
        allowSelfApproval: (actor.isRoot || actor.isAdmin) ? Boolean(params.allowSelfApproval) : false,
        slaMinutes: params.slaMinutes,
        escalateToRole: params.escalateToRole,
        notifyChannels: params.notifyChannels,
        app: ctx?.app || db?.app,
      });
      if (next) return next();
    },

    cancel: async (ctx, next) => {
      if (ctx.method && String(ctx.method).toUpperCase() !== 'POST') ctx.throw(405);
      assertApiKeyScope(ctx, ['write']);
      const params = readParams(ctx);
      const actor = await resolveActorContext(db, ctx, { requestedOrgId: params.organizationId, allowRootCrossOrg: true });
      ctx.body = await cancelApprovalRequest(db, {
        organizationId: actor.organizationId,
        actor,
        requestIdOrUid: params.requestUid || params.id || params.filterByTk,
        note: params.note || params.reason,
      });
      if (next) return next();
    },

    listPolicies: async (ctx, next) => {
      if (ctx.method && String(ctx.method).toUpperCase() !== 'GET') ctx.throw(405);
      assertApiKeyScope(ctx, ['read', 'write']);
      const params = readParams(ctx);
      const actor = await resolveActorContext(db, ctx, { requestedOrgId: params.organizationId, allowRootCrossOrg: true });
      const items = await listApprovalPolicies(db, {
        organizationId: actor.organizationId,
        targetCollection: params.targetCollection || null,
        activeOnly: params.activeOnly === true || params.activeOnly === 'true',
      });
      ctx.body = { organizationId: actor.organizationId, items };
      if (next) return next();
    },

    savePolicy: async (ctx, next) => {
      if (ctx.method && String(ctx.method).toUpperCase() !== 'POST') ctx.throw(405);
      assertApiKeyScope(ctx, ['write']);
      const params = readParams(ctx);
      const actor = await resolveActorContext(db, ctx, { requestedOrgId: params.organizationId, allowRootCrossOrg: false });
      ctx.body = await saveApprovalPolicy(db, {
        organizationId: actor.organizationId,
        actor,
        input: params,
      });
      if (next) return next();
    },

    deletePolicy: async (ctx, next) => {
      if (ctx.method && String(ctx.method).toUpperCase() !== 'POST') ctx.throw(405);
      assertApiKeyScope(ctx, ['write']);
      const params = readParams(ctx);
      const actor = await resolveActorContext(db, ctx, { requestedOrgId: params.organizationId, allowRootCrossOrg: false });
      ctx.body = await deleteApprovalPolicy(db, {
        organizationId: actor.organizationId,
        actor,
        policyIdOrKey: params.policyId || params.id || params.policyKey || params.filterByTk,
      });
      if (next) return next();
    },

    evaluateSlaNow: async (ctx, next) => {
      if (ctx.method && String(ctx.method).toUpperCase() !== 'POST') ctx.throw(405);
      assertApiKeyScope(ctx, ['write']);
      const params = readParams(ctx);
      const actor = await resolveActorContext(db, ctx, { requestedOrgId: params.organizationId, allowRootCrossOrg: true });
      if (!actor.isRoot && !actor.isAdmin) {
        throw failApproval('APPROVAL_ADMIN_REQUIRED', 403, 'Only administrators can trigger approval SLA evaluation.');
      }
      ctx.body = await evaluateApprovalSlas(db, {
        organizationId: actor.organizationId,
        dryRun: Boolean(params.dryRun),
        app: ctx?.app || db?.app,
      });
      if (next) return next();
    },
  };
}

function registerApprovalEngine(app) {
  const db = app.db;
  app.resourceManager?.use?.(createApprovalsDirectGuardMiddleware(db), {
    tag: 'dxosApprovalsDirectGuard',
    after: 'acl',
    before: 'latticeNativeScope',
  });

  const actions = createDxosApprovalsActions(db);
  app.resourceManager?.define?.({
    name: 'dxosApprovals',
    actions,
  });

  app.acl?.allow?.(
    'dxosApprovals',
    ['listInbox', 'decide', 'request', 'cancel', 'listPolicies', 'savePolicy', 'deletePolicy', 'evaluateSlaNow'],
    'loggedIn',
  );
}

module.exports = {
  PROTECTED_TARGET_COLLECTIONS,
  APPROVAL_PROTECTED_RESOURCES,
  FORBIDDEN_DELEGATION_ROLES,
  sanitizePlainJson,
  assertAllowedTargetCollection,
  normalizeStagesJson,
  matchesConditionJson,
  resolveVerifiedCallerRoles,
  resolveDelegationsForActor,
  saveApprovalPolicy,
  listApprovalPolicies,
  deleteApprovalPolicy,
  requestApproval,
  decideApprovalRequest,
  cancelApprovalRequest,
  evaluateApprovalSlas,
  listUnifiedInbox,
  decideUnifiedInboxItem,
  createApprovalsDirectGuardMiddleware,
  createDxosApprovalsActions,
  registerApprovalEngine,
};
