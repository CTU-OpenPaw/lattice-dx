/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');
const { resolveNativeActor } = require('./native-scope');
const { val, callerRoles, getRepo } = require('./native-portal-helpers');

const PAT_TOKEN_RE = /^ldx_pat_([0-9a-f]{8})_([0-9a-f]{32})$/;
const ORG_ID_RE = /^[a-zA-Z0-9_-]{1,80}$/;
const ROLE_NAME_RE = /^[a-zA-Z0-9_-]{2,64}$/;
const ALLOWED_PAT_SCOPES = new Set(['read', 'write', 'wms', 'dmn', 'iot', 'ai', 'ledger']);
const ELEVATED_ROLES = new Set(['root', 'admin', 'ldx_admin']);
const PRIVATE_PKI_LEDGER_RESOURCES = new Set([
  'latticeApiKeys',
  'latticePkiKeys',
  'latticeCryptoLedger',
  'latticeConnectors',
  'latticeWebhookSubscriptions',
]);
const SAFE_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const READ_ONLY_SAFE_POST_ACTIONS = new Set(['list', 'get', 'count']);
const READ_ONLY_SAFE_POST_RESOURCE_ACTIONS = new Set([
  'dxosLedger:verify',
  'dxosLedger:verifySignature',
  'latticePara:hybridSearch',
  'dxosDmn:evaluate',
  'dxosStudio:solutionBundleDiff',
  'charts:queryData',
  'dxosDataGov:computeMkt',
  'latticeIntegrations:record',
  'latticeIntegrations:context',
  'latticeIntegrations:proposals',
  'latticeIntegrations:proposalReceipt',
]);
const READ_ONLY_MUTATING_ACTIONS = new Set([
  'create', 'update', 'destroy', 'add', 'remove', 'set', 'toggle', 'move',
  'updateOrCreate', 'firstOrCreate', 'submit', 'cancel', 'amend',
  'post', 'issue', 'revoke', 'signDocument', 'savePolicy',
  'evaluateNow', 'markRead', 'markAllRead', 'save', 'delete',
  'saveProfile', 'deleteProfile', 'installWorkflow', 'composePortals',
  'receiveStock', 'issueStock', 'epodCapture', 'propose', 'receive', 'receiveAlert',
  'saveTable', 'saveDelegation', 'freezeSnapshot', 'quarantineResolve', 'resolveQuarantine',
  'telemetryIngest', 'alarmIngest', 'alarmAck', 'alarmClear',
  'outboxDlqReplay', 'solutionBundleImport', 'solutionBundleRollback',
  'reindex', 'extractAttachment', 'bootstrapDefaults', 'portalAgents',
  'rollbackPageSnapshot', 'approveAction', 'rejectAction', 'dispatch', 'retry', 'upload',
  'publish', 'rotateSecret', 'testConnection', 'toggleSubscription', 'deleteSubscription',
  'replayDlq', 'resetCircuit', 'dispatchNow', 'provisionDevice', 'revokeDevice',
  'deviceStatusIngest', 'orionCreateSubscription', 'orionToggleSubscription',
  'orionDeleteSubscription', 'orionNotify', 'saveRule', 'toggleRule', 'deleteRule',
  'runNow', 'replayRun', 'createDomain', 'installBusinessPack', 'provisionTenant',
  'twinSetDesired', 'twinAckCommand', 'bulkImportDryRun', 'bulkImportCommit',
]);
const LAST_USED_THROTTLE_MS = 60_000;

function failApiKey(code, status = 400, message = code) {
  return Object.assign(new Error(message), { code, status });
}

function readHeader(ctx, name) {
  if (typeof ctx?.get === 'function') {
    const direct = ctx.get(name);
    if (typeof direct === 'string' && direct.trim()) return direct.trim();
  }
  const lower = String(name || '').toLowerCase();
  for (const bag of [ctx?.headers, ctx?.request?.headers]) {
    if (!bag || typeof bag !== 'object') continue;
    for (const [k, v] of Object.entries(bag)) {
      if (k.toLowerCase() === lower && typeof v === 'string' && v.trim()) {
        return v.trim();
      }
    }
  }
  return '';
}

function readParams(ctx) {
  const p = ctx.action?.params || {};
  const b = ctx.request?.body && typeof ctx.request.body === 'object' && !Array.isArray(ctx.request.body)
    ? ctx.request.body
    : {};
  const v = p.values && typeof p.values === 'object' && !Array.isArray(p.values)
    ? p.values
    : {};
  return { ...b, ...p, ...v };
}

function hashToken(token) {
  return createHash('sha256').update(String(token), 'utf8').digest('hex');
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || a.length === 0) {
    return false;
  }
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

function generatePatToken() {
  const prefixHex = randomBytes(4).toString('hex');
  const secretHex = randomBytes(16).toString('hex');
  return {
    token: `ldx_pat_${prefixHex}_${secretHex}`,
    keyPrefix: `ldx_pat_${prefixHex}`,
  };
}

function normalizeScopes(rawScopes) {
  if (!Array.isArray(rawScopes) || rawScopes.length === 0 || rawScopes.length > 20) {
    throw failApiKey('API_KEY_SCOPES_INVALID', 400, 'Scopes must be a non-empty array of allowed scope names.');
  }
  const out = [];
  const seen = new Set();
  for (const item of rawScopes) {
    if (typeof item !== 'string') {
      throw failApiKey('API_KEY_SCOPES_INVALID', 400, 'Each API key scope must be a string.');
    }
    const clean = item.trim().toLowerCase();
    if (!ALLOWED_PAT_SCOPES.has(clean)) {
      throw failApiKey('API_KEY_SCOPES_INVALID', 400, `Unsupported API key scope: ${clean || '<empty>'}`);
    }
    if (!seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  return out;
}

function parseExpiresInDays(rawDays) {
  if (rawDays === undefined || rawDays === null || String(rawDays).trim() === '') {
    return null;
  }
  const num = Number(rawDays);
  if (!Number.isInteger(num) || num < 1 || num > 365) {
    throw failApiKey('API_KEY_EXPIRY_INVALID', 400, 'expiresInDays must be an integer between 1 and 365.');
  }
  return new Date(Date.now() + num * 86_400_000);
}

function serializeApiKey(row) {
  if (!row) return null;
  return {
    id: val(row, 'id') ?? null,
    organizationId: val(row, 'organizationId') || null,
    name: val(row, 'name') || '',
    keyPrefix: val(row, 'keyPrefix') || '',
    userId: val(row, 'userId') != null ? Number(val(row, 'userId')) : null,
    employeeId: val(row, 'employeeId') != null ? Number(val(row, 'employeeId')) : null,
    roleName: val(row, 'roleName') || '',
    scopes: Array.isArray(val(row, 'scopesJson')) ? val(row, 'scopesJson') : [],
    expiresAt: val(row, 'expiresAt') || null,
    lastUsedAt: val(row, 'lastUsedAt') || null,
    revokedAt: val(row, 'revokedAt') || null,
    revokedBy: val(row, 'revokedBy') || null,
    createdByUserId: val(row, 'createdByUserId') != null ? Number(val(row, 'createdByUserId')) : null,
    active: val(row, 'active') !== false,
    createdAt: val(row, 'createdAt') || null,
  };
}

async function resolveVerifiedCallerRoles(ctx, db, userId) {
  const claimed = callerRoles(ctx);
  const ruRepo = getRepo(db, 'rolesUsers');
  if (ruRepo && typeof ruRepo.find === 'function' && userId != null) {
    const bindings = (await ruRepo.find({ filter: { userId: Number(userId) } })) || [];
    const assigned = new Set(
      bindings.map((r) => String(val(r, 'roleName') || '').trim()).filter(Boolean),
    );
    if (claimed.length > 0) {
      return claimed.filter((r) => assigned.has(r));
    }
    return [...assigned];
  }
  return claimed;
}

function hasAdminRolePrivilege(roleRow) {
  if (!roleRow) return false;
  if (val(roleRow, 'allowConfigure') === true) return true;
  const snippets = val(roleRow, 'snippets');
  return Array.isArray(snippets) && (snippets.includes('pm') || snippets.includes('pm.*'));
}

async function isAdminByRoles(db, roleNames) {
  if (!Array.isArray(roleNames) || !roleNames.length) return false;
  if (roleNames.includes('root')) return true;
  const rolesRepo = getRepo(db, 'roles');
  if (!rolesRepo || typeof rolesRepo.find !== 'function') return false;
  const matched = (await rolesRepo.find({ filter: { name: { $in: roleNames } } })) || [];
  return matched.some((role) => {
    const name = val(role, 'name');
    if (name && !roleNames.includes(name)) return false;
    return hasAdminRolePrivilege(role);
  });
}

async function isElevatedRoleName(db, roleName) {
  const clean = String(roleName || '').trim();
  if (!clean) return false;
  if (ELEVATED_ROLES.has(clean.toLowerCase())) return true;
  const rolesRepo = getRepo(db, 'roles');
  if (!rolesRepo || typeof rolesRepo.findOne !== 'function') return false;
  const row = await rolesRepo.findOne({ filter: { name: clean } });
  return hasAdminRolePrivilege(row);
}

function assertApiKeyScope(ctx, requiredScopes) {
  const pat = ctx?.state?.latticeApiKey;
  if (!pat) return true;
  const held = new Set(Array.isArray(pat.scopes) ? pat.scopes : []);
  const needed = Array.isArray(requiredScopes) ? requiredScopes : [requiredScopes];
  if (needed.some((s) => held.has(s))) return true;
  throw failApiKey('API_KEY_SCOPE_INSUFFICIENT', 403, `API key lacks required scope (${needed.join(' or ')}).`);
}

function clampHeaderRole(ctx, roleName) {
  for (const bag of [ctx?.headers, ctx?.request?.headers]) {
    if (!bag || typeof bag !== 'object') continue;
    for (const key of Object.keys(bag)) {
      if (key.toLowerCase() === 'x-role' && key !== 'x-role') {
        delete bag[key];
      }
    }
    bag['x-role'] = roleName;
  }
}

function isAllowedReadOnlyRequest(ctx, method) {
  const fullResource = String(ctx?.action?.resourceName || '').trim();
  const baseResource = fullResource.split('.')[0];
  const actionName = String(ctx?.action?.actionName || '').trim();
  const reqPath = String(ctx?.path || ctx?.request?.path || ctx?.url || '')
    .split('?')[0]
    .trim()
    .replace(/\/+$/, '')
    .toLowerCase();
  const isMcpPath = reqPath === '/api/dxos-mcp'
    || reqPath.endsWith('/api/dxos-mcp')
    || reqPath === '/api/dxos-mcp/it-ot'
    || reqPath.endsWith('/api/dxos-mcp/it-ot')
    || baseResource === 'dxosMcp';

  if (SAFE_HTTP_METHODS.has(method)) {
    return !isMcpPath && !READ_ONLY_MUTATING_ACTIONS.has(actionName);
  }
  if (method !== 'POST' || isMcpPath) {
    return false;
  }
  if (READ_ONLY_SAFE_POST_RESOURCE_ACTIONS.has(`${fullResource}:${actionName}`)) {
    return true;
  }
  return Boolean(baseResource) && READ_ONLY_SAFE_POST_ACTIONS.has(actionName);
}

function createPaasApiKeyAuthMiddleware(db) {
  return async function paasApiKeyAuthMiddleware(ctx, next) {
    const xApiKey = readHeader(ctx, 'x-lattice-api-key');
    const authHeader = readHeader(ctx, 'authorization');
    let bearerPat = '';
    if (authHeader) {
      const m = authHeader.match(/^Bearer\s+(.+)$/i);
      if (m && m[1] && m[1].trim().startsWith('ldx_pat_')) {
        bearerPat = m[1].trim();
      }
    }

    let rawToken = '';
    if (xApiKey) {
      rawToken = xApiKey;
    } else if (!val(ctx?.state?.currentUser, 'id') && bearerPat) {
      rawToken = bearerPat;
    } else {
      return next();
    }

    if (!PAT_TOKEN_RE.test(rawToken)) {
      throw failApiKey('API_KEY_INVALID', 401, 'Invalid PaaS API key format.');
    }

    const activeDb = db || ctx?.db || ctx?.app?.db;
    const keyRepo = getRepo(activeDb, 'latticeApiKeys');
    if (!keyRepo || typeof keyRepo.findOne !== 'function') {
      throw failApiKey('API_KEY_UNAVAILABLE', 401, 'API key authentication is unavailable.');
    }

    const expectedHash = hashToken(rawToken);
    const keyRow = await keyRepo.findOne({ filter: { keyHash: expectedHash } });
    if (!keyRow || !timingSafeEqualHex(String(val(keyRow, 'keyHash') || ''), expectedHash)) {
      throw failApiKey('API_KEY_INVALID', 401, 'Invalid PaaS API key.');
    }

    if (val(keyRow, 'active') !== true || val(keyRow, 'revokedAt') != null) {
      throw failApiKey('API_KEY_REVOKED', 401, 'PaaS API key has been revoked or deactivated.');
    }

    const expiresAt = val(keyRow, 'expiresAt');
    if (expiresAt != null) {
      const expMs = new Date(expiresAt).getTime();
      if (!Number.isFinite(expMs) || expMs <= Date.now()) {
        throw failApiKey('API_KEY_EXPIRED', 401, 'PaaS API key has expired.');
      }
    }

    const userId = Number(val(keyRow, 'userId'));
    const roleName = String(val(keyRow, 'roleName') || '').trim();
    const orgId = String(val(keyRow, 'organizationId') || '').trim();
    if (!Number.isInteger(userId) || userId <= 0 || !roleName || !ORG_ID_RE.test(orgId)) {
      throw failApiKey('API_KEY_INVALID', 401, 'PaaS API key binding is invalid.');
    }

    const usersRepo = getRepo(activeDb, 'users');
    if (!usersRepo || typeof usersRepo.findOne !== 'function') {
      throw failApiKey('API_KEY_USER_INACTIVE', 401, 'User repository unavailable for API key verification.');
    }
    const userRow = await usersRepo.findOne({ filter: { id: userId } });
    if (!userRow || val(userRow, 'active') === false) {
      throw failApiKey('API_KEY_USER_INACTIVE', 401, 'API key owner account is inactive or missing.');
    }

    const ruRepo = getRepo(activeDb, 'rolesUsers');
    if (ruRepo && typeof ruRepo.find === 'function') {
      const bindings = (await ruRepo.find({ filter: { userId } })) || [];
      const hasRole = bindings.some((b) => String(val(b, 'roleName') || '').trim() === roleName);
      if (!hasRole) {
        throw failApiKey('API_KEY_ROLE_REVOKED', 401, 'API key role assignment is no longer active.');
      }
    }

    if (roleName !== 'root' || val(keyRow, 'employeeId') != null) {
      const empRepo = getRepo(activeDb, 'latticeEmployees');
      if (!empRepo || typeof empRepo.findOne !== 'function') {
        throw failApiKey('API_KEY_MEMBERSHIP_INACTIVE', 401, 'Employee membership repository unavailable.');
      }
      const emp = await empRepo.findOne({ filter: { userId, organizationId: orgId, active: true } });
      if (!emp || val(emp, 'active') !== true || val(emp, 'organizationId') !== orgId) {
        throw failApiKey('API_KEY_MEMBERSHIP_INACTIVE', 401, 'API key organization membership is inactive.');
      }
      if (val(keyRow, 'employeeId') != null && Number(val(emp, 'id')) !== Number(val(keyRow, 'employeeId'))) {
        throw failApiKey('API_KEY_MEMBERSHIP_INACTIVE', 401, 'API key employee binding mismatch.');
      }
    }

    const userPlain = typeof userRow.toJSON === 'function' ? userRow.toJSON() : { ...userRow };
    ctx.state = ctx.state || {};
    ctx.state.currentUser = userPlain;
    ctx.state.currentRole = roleName;
    ctx.state.currentRoles = [roleName];
    clampHeaderRole(ctx, roleName);
    ctx.auth = ctx.auth || {};
    ctx.auth.user = userPlain;
    ctx.skipAuthCheck = true;

    const scopes = Array.isArray(val(keyRow, 'scopesJson')) ? val(keyRow, 'scopesJson') : [];
    ctx.state.latticeApiKey = {
      id: val(keyRow, 'id'),
      keyPrefix: val(keyRow, 'keyPrefix'),
      scopes,
      roleName,
      organizationId: orgId,
    };

    const lastUsedRaw = val(keyRow, 'lastUsedAt');
    const lastUsedMs = lastUsedRaw ? new Date(lastUsedRaw).getTime() : 0;
    if (!lastUsedMs || Date.now() - lastUsedMs >= LAST_USED_THROTTLE_MS) {
      const now = new Date();
      try {
        if (typeof keyRow.update === 'function') {
          await keyRow.update({ lastUsedAt: now });
        } else if (typeof keyRepo.update === 'function') {
          await keyRepo.update({
            filterByTk: val(keyRow, 'id'),
            filter: { organizationId: orgId },
            values: { lastUsedAt: now },
          });
        }
      } catch {
        // Non-fatal telemetry timestamp update
      }
    }

    const method = String(ctx.method || 'GET').trim().toUpperCase();
    const isReadOnlyPat = scopes.length === 0 || scopes.every((s) => s === 'read');
    if (isReadOnlyPat && !isAllowedReadOnlyRequest(ctx, method)) {
      throw failApiKey('API_KEY_SCOPE_INSUFFICIENT', 403, 'Read-only API key cannot invoke mutating operations.');
    }

    return await next();
  };
}

function registerPaasPrivateCollectionGuard(app) {
  app.resourceManager?.use?.(async (ctx, next) => {
    if (ctx.state?.currentRole === 'root') return next();
    const fullResource = String(ctx.action?.resourceName || '');
    const baseResource = fullResource.split('.')[0];
    const actionName = String(ctx.action?.actionName || '');
    if (PRIVATE_PKI_LEDGER_RESOURCES.has(baseResource)) {
      throw failApiKey('PAAS_PRIVATE_COLLECTION_FORBIDDEN', 403, 'Direct access to private key or ledger collections is forbidden; use dxosApiKeys or dxosLedger.');
    }
    if (
      fullResource === 'charts'
      && actionName === 'queryData'
      && PRIVATE_PKI_LEDGER_RESOURCES.has(String(ctx.action?.params?.values?.collection || ''))
    ) {
      throw failApiKey('PAAS_PRIVATE_COLLECTION_FORBIDDEN', 403, 'Direct chart access to private key or ledger collections is forbidden.');
    }
    return next();
  }, { tag: 'latticePaasPrivateCollectionGuard', after: 'acl' });
}

async function resolveIssueTarget({ db, callerUserId, callerRolesVerified, isRoot, isAdmin, params }) {
  let organizationId = null;
  let callerEmployeeId = null;
  if (!isRoot) {
    const actor = await resolveNativeActor(db, { id: callerUserId });
    organizationId = actor.organizationId;
    callerEmployeeId = actor.employeeId;
    if (params.organizationId !== undefined && String(params.organizationId).trim() !== organizationId) {
      throw failApiKey('NATIVE_ORGANIZATION_MISMATCH', 403, 'Cannot issue API key for another organization.');
    }
  } else if (params.organizationId != null && String(params.organizationId).trim() !== '') {
    const reqOrg = String(params.organizationId).trim();
    if (!ORG_ID_RE.test(reqOrg)) {
      throw failApiKey('API_KEY_ORG_INVALID', 400, 'Invalid organizationId.');
    }
    organizationId = reqOrg;
  }

  const targetUserId = params.userId != null && String(params.userId).trim() !== ''
    ? Number(params.userId)
    : Number(callerUserId);
  if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
    throw failApiKey('API_KEY_USER_INVALID', 400, 'Invalid target userId.');
  }
  if (!isAdmin && targetUserId !== Number(callerUserId)) {
    throw failApiKey('API_KEY_FORBIDDEN', 403, 'Only administrators can issue API keys for other users.');
  }

  const requestedRole = String(params.roleName || callerRolesVerified[0] || '').trim();
  if (!ROLE_NAME_RE.test(requestedRole)) {
    throw failApiKey('API_KEY_ROLE_INVALID', 400, 'Valid roleName is required.');
  }

  const targetIsElevated = await isElevatedRoleName(db, requestedRole);
  if (!isAdmin) {
    if (targetIsElevated || !callerRolesVerified.includes(requestedRole)) {
      throw failApiKey('API_KEY_ROLE_ESCALATION', 403, 'Cannot issue elevated or unassigned role API key.');
    }
  } else if (!isRoot && requestedRole.toLowerCase() === 'root') {
    throw failApiKey('API_KEY_ROLE_ESCALATION', 403, 'Only root can issue a root API key.');
  }

  const usersRepo = getRepo(db, 'users');
  if (usersRepo && typeof usersRepo.findOne === 'function') {
    const targetUser = await usersRepo.findOne({ filter: { id: targetUserId } });
    if (!targetUser || val(targetUser, 'active') === false) {
      throw failApiKey('API_KEY_USER_INACTIVE', 404, 'Target user is missing or inactive.');
    }
  }

  let employeeId = targetUserId === Number(callerUserId) ? callerEmployeeId : null;
  if (requestedRole !== 'root' || !isRoot) {
    const empRepo = getRepo(db, 'latticeEmployees');
    if (empRepo && typeof empRepo.find === 'function') {
      const empRows = (await empRepo.find({ filter: { userId: targetUserId, active: true }, limit: 2 })) || [];
      if (empRows.length > 1) {
        throw failApiKey('NATIVE_MEMBERSHIP_AMBIGUOUS', 403, 'Ambiguous active employee membership.');
      }
      const emp = empRows[0];
      if (!emp || val(emp, 'active') !== true) {
        if (!isRoot) {
          throw failApiKey('NATIVE_MEMBERSHIP_REQUIRED', 403, 'Target user lacks an active organization membership.');
        }
      } else {
        const empOrg = String(val(emp, 'organizationId') || '').trim();
        if (organizationId && empOrg !== organizationId) {
          throw failApiKey('NATIVE_ORGANIZATION_MISMATCH', 403, 'Target user belongs to a different organization.');
        }
        if (!organizationId) organizationId = empOrg;
        employeeId = Number(val(emp, 'id'));
      }
    }
  }

  if (!organizationId || !ORG_ID_RE.test(organizationId)) {
    throw failApiKey('API_KEY_ORG_REQUIRED', 400, 'organizationId is required.');
  }

  const ruRepo = getRepo(db, 'rolesUsers');
  if (ruRepo && typeof ruRepo.find === 'function' && (!isRoot || targetUserId !== Number(callerUserId))) {
    const bindings = (await ruRepo.find({ filter: { userId: targetUserId } })) || [];
    const hasRole = bindings.some((b) => String(val(b, 'roleName') || '').trim() === requestedRole);
    if (!hasRole) {
      throw failApiKey('API_KEY_ROLE_UNASSIGNED', 403, 'Target user does not hold the requested role.');
    }
  }

  return {
    organizationId,
    userId: targetUserId,
    employeeId: employeeId != null ? Number(employeeId) : null,
    roleName: requestedRole,
  };
}

function registerPaasApiKeys(app) {
  const db = app.db;
  registerPaasPrivateCollectionGuard(app);

  app.resourceManager.define({
    name: 'dxosApiKeys',
    actions: {
      issue: async (ctx, next) => {
        if ((ctx.method || 'POST') !== 'POST') ctx.throw(405);
        assertApiKeyScope(ctx, ['write']);
        const callerUserId = val(ctx.state?.currentUser, 'id');
        if (callerUserId == null || !/^[1-9]\d*$/.test(String(callerUserId))) {
          throw failApiKey('NATIVE_LOGIN_REQUIRED', 401, 'Authentication required.');
        }

        const params = readParams(ctx);
        const name = typeof params.name === 'string' ? params.name.trim() : '';
        if (!name || name.length > 120) {
          throw failApiKey('API_KEY_NAME_REQUIRED', 400, 'API key name is required (1..120 chars).');
        }
        const scopes = normalizeScopes(params.scopes);
        const expiresAt = parseExpiresInDays(params.expiresInDays);

        const callerRolesVerified = await resolveVerifiedCallerRoles(ctx, db, callerUserId);
        const isRoot = callerRolesVerified.includes('root');
        const isAdmin = isRoot || (await isAdminByRoles(db, callerRolesVerified));

        const resolved = await resolveIssueTarget({
          db,
          callerUserId,
          callerRolesVerified,
          isRoot,
          isAdmin,
          params,
        });

        const keyRepo = getRepo(db, 'latticeApiKeys');
        if (!keyRepo || typeof keyRepo.create !== 'function') {
          throw failApiKey('API_KEY_REPO_UNAVAILABLE', 503, 'latticeApiKeys repository is unavailable.');
        }

        const { token, keyPrefix } = generatePatToken();
        const keyHash = hashToken(token);
        const created = await keyRepo.create({
          values: {
            organizationId: resolved.organizationId,
            name,
            keyPrefix,
            keyHash,
            userId: resolved.userId,
            employeeId: resolved.employeeId,
            roleName: resolved.roleName,
            scopesJson: scopes,
            expiresAt,
            createdByUserId: Number(callerUserId),
            active: true,
          },
        });

        ctx.body = {
          ...serializeApiKey(created),
          token,
        };
        if (next) return next();
      },

      list: async (ctx, next) => {
        if ((ctx.method || 'GET') !== 'GET') ctx.throw(405);
        const callerUserId = val(ctx.state?.currentUser, 'id');
        if (callerUserId == null || !/^[1-9]\d*$/.test(String(callerUserId))) {
          throw failApiKey('NATIVE_LOGIN_REQUIRED', 401, 'Authentication required.');
        }

        const params = readParams(ctx);
        const callerRolesVerified = await resolveVerifiedCallerRoles(ctx, db, callerUserId);
        const isRoot = callerRolesVerified.includes('root');
        const isAdmin = isRoot || (await isAdminByRoles(db, callerRolesVerified));

        let filter = {};
        let organizationId = null;
        if (isRoot) {
          if (params.organizationId && ORG_ID_RE.test(String(params.organizationId).trim())) {
            organizationId = String(params.organizationId).trim();
            filter = { organizationId };
          }
        } else {
          const actor = await resolveNativeActor(db, ctx.state.currentUser);
          organizationId = actor.organizationId;
          filter = isAdmin
            ? { organizationId }
            : { organizationId, userId: Number(actor.userId) };
        }

        const keyRepo = getRepo(db, 'latticeApiKeys');
        if (!keyRepo || typeof keyRepo.find !== 'function') {
          ctx.body = { organizationId, items: [] };
          if (next) return next();
          return;
        }
        const limit = Math.max(1, Math.min(200, Math.floor(Number(params.limit) || 50)));
        const rows = (await keyRepo.find({ filter, sort: ['-id'], limit })) || [];
        ctx.body = {
          organizationId,
          items: rows.map(serializeApiKey),
        };
        if (next) return next();
      },

      revoke: async (ctx, next) => {
        if ((ctx.method || 'POST') !== 'POST') ctx.throw(405);
        assertApiKeyScope(ctx, ['write']);
        const callerUserId = val(ctx.state?.currentUser, 'id');
        if (callerUserId == null || !/^[1-9]\d*$/.test(String(callerUserId))) {
          throw failApiKey('NATIVE_LOGIN_REQUIRED', 401, 'Authentication required.');
        }

        const params = readParams(ctx);
        const id = Number(params.id ?? params.filterByTk ?? params.keyId);
        if (!Number.isInteger(id) || id <= 0) {
          throw failApiKey('API_KEY_ID_REQUIRED', 400, 'Valid API key id is required.');
        }

        const callerRolesVerified = await resolveVerifiedCallerRoles(ctx, db, callerUserId);
        const isRoot = callerRolesVerified.includes('root');
        const isAdmin = isRoot || (await isAdminByRoles(db, callerRolesVerified));

        const keyRepo = getRepo(db, 'latticeApiKeys');
        if (!keyRepo) {
          throw failApiKey('API_KEY_NOT_FOUND', 404, 'API key not found.');
        }

        let organizationId = null;
        if (!isRoot) {
          const actor = await resolveNativeActor(db, ctx.state.currentUser);
          organizationId = actor.organizationId;
        }

        const filter = organizationId ? { id, organizationId } : { id };
        const row = await keyRepo.findOne({ filter });
        if (!row || (organizationId && val(row, 'organizationId') !== organizationId)) {
          throw failApiKey('API_KEY_NOT_FOUND', 404, 'API key not found.');
        }
        if (!isAdmin && Number(val(row, 'userId')) !== Number(callerUserId)) {
          throw failApiKey('API_KEY_FORBIDDEN', 403, 'Cannot revoke another user API key.');
        }

        const revokedAt = val(row, 'revokedAt') || new Date();
        const revokedBy = String(val(ctx.state.currentUser, 'username') || callerUserId).slice(0, 120);
        const patch = { active: false, revokedAt, revokedBy };
        let updated = row;
        if (typeof row.update === 'function') {
          updated = await row.update(patch);
        } else if (typeof keyRepo.update === 'function') {
          const res = await keyRepo.update({ filterByTk: id, filter, values: patch });
          if (Array.isArray(res) && res[0]) updated = res[0];
        }

        ctx.body = {
          ...serializeApiKey(updated),
          active: false,
          revokedAt: revokedAt instanceof Date ? revokedAt.toISOString() : revokedAt,
          revokedBy,
        };
        if (next) return next();
      },
    },
  });

  app.acl?.allow?.('dxosApiKeys', ['issue', 'list', 'revoke'], 'loggedIn');
}

module.exports = {
  PAT_TOKEN_RE,
  ALLOWED_PAT_SCOPES,
  ELEVATED_ROLES,
  PRIVATE_PKI_LEDGER_RESOURCES,
  READ_ONLY_SAFE_POST_ACTIONS,
  READ_ONLY_SAFE_POST_RESOURCE_ACTIONS,
  readParams,
  assertApiKeyScope,
  createPaasApiKeyAuthMiddleware,
  registerPaasApiKeys,
};
