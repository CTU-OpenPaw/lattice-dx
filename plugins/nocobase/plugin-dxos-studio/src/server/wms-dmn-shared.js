/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { createHash, timingSafeEqual } = require('node:crypto');
const path = require('node:path');
const { resolveServiceActor } = require('./service-scope');

const ORG_ID_RE = /^[a-zA-Z0-9_-]{1,80}$/;
const SENSITIVE_FILTER_KEY_RE = /password|secret|token|apikey|api_key|identitySubject|privateKey|hash|salt|trackingTokenHash|signatureDataUrl/i;
const LEDGER_SECURITY_INVARIANTS = new Set([
  'PKI_MASTER_KEY_MISSING',
  'PKI_KEY_INACTIVE',
  'PKI_CIPHERTEXT_INVALID',
  'LEDGER_IMMUTABLE',
  'NATIVE_ORGANIZATION_MISMATCH',
  'NATIVE_TENANT_REQUIRED',
]);

const val = (row, key) => (typeof row?.get === 'function' ? row.get(key) : row?.[key]);
const toPlain = (row) => (row ? (typeof row.toJSON === 'function' ? row.toJSON() : { ...row }) : null);

function fail(code, status = 400, message = code) {
  return Object.assign(new Error(message), { code, status });
}

function loadFoundationModule(moduleName) {
  const inDist = __dirname.includes(`${path.sep}dist${path.sep}`);
  const candidates = inDist
    ? [
        `../../../plugin-lattice-foundation/dist/server/${moduleName}`,
        `../../../plugin-lattice-foundation/src/server/${moduleName}`,
      ]
    : [
        `../../../plugin-lattice-foundation/src/server/${moduleName}`,
        `../../../plugin-lattice-foundation/dist/server/${moduleName}`,
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

function loadFoundationSet() {
  return {
    pkiLedger: loadFoundationModule('pki-ledger'),
    dataGovernance: loadFoundationModule('data-governance'),
    paasApiKeys: loadFoundationModule('paas-api-keys'),
    pgRls: loadFoundationModule('pg-rls'),
  };
}

const defaultFoundation = loadFoundationSet();

function isSecurityInvariant(err, pkiLedger = defaultFoundation.pkiLedger) {
  return Boolean(
    pkiLedger?.isLedgerSecurityInvariant?.(err)
    || (err && typeof err.code === 'string' && LEDGER_SECURITY_INVARIANTS.has(err.code)),
  );
}

function sha256Hex(input) {
  return createHash('sha256').update(String(input ?? ''), 'utf8').digest('hex');
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || a.length === 0 || a.length % 2 !== 0) {
    return false;
  }
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b)) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

function readParams(ctx) {
  const p = ctx?.action?.params || {};
  const b = ctx?.request?.body && typeof ctx.request.body === 'object' && !Array.isArray(ctx.request.body)
    ? ctx.request.body
    : {};
  const q = ctx?.query && typeof ctx.query === 'object' && !Array.isArray(ctx.query)
    ? ctx.query
    : {};
  const v = p.values && typeof p.values === 'object' && !Array.isArray(p.values)
    ? p.values
    : {};
  return { ...q, ...b, ...p, ...v };
}

function parseFinite(raw) {
  if (raw === null || raw === undefined || typeof raw === 'boolean' || typeof raw === 'object') return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

function parseStrictPositiveInt(raw, fallback, code = 'WMS_INT_INVALID', message = 'Giá trị phải là số nguyên dương.') {
  if (raw === undefined || raw === null) {
    if (fallback !== undefined) return fallback;
    throw fail(code, 400, message);
  }
  if (typeof raw === 'boolean' || typeof raw === 'object') {
    throw fail(code, 400, message);
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!/^[1-9]\d*$/.test(trimmed)) {
      throw fail(code, 400, message);
    }
    const n = Number(trimmed);
    if (!Number.isSafeInteger(n) || n < 1) {
      throw fail(code, 400, message);
    }
    return n;
  }
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 1) {
    return raw;
  }
  throw fail(code, 400, message);
}

function parseOptionalDate(raw, code = 'WMS_DATE_INVALID') {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const dt = raw instanceof Date ? new Date(raw.getTime()) : new Date(String(raw));
  if (!Number.isFinite(dt.getTime())) throw fail(code, 400, 'Định dạng ngày giờ không hợp lệ.');
  return dt;
}

function parseTempBand(minRaw, maxRaw) {
  const minTempC = minRaw != null ? parseFinite(minRaw) : null;
  const maxTempC = maxRaw != null ? parseFinite(maxRaw) : null;
  if ((minRaw != null && minTempC === null) || (maxRaw != null && maxTempC === null)) {
    throw fail('WMS_TEMP_BAND_INVALID', 400, 'Khoảng nhiệt độ mục tiêu không hợp lệ.');
  }
  if (minTempC !== null && maxTempC !== null && minTempC > maxTempC) {
    throw fail('WMS_TEMP_BAND_INVALID', 400, 'targetTempMinC không được lớn hơn targetTempMaxC.');
  }
  return { minTempC, maxTempC };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/`/g, '&#96;');
}

function maskPhone(raw) {
  if (raw === undefined || raw === null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length >= 3) return `***${digits.slice(-3)}`;
  if (trimmed.length >= 3) return `***${trimmed.slice(-3)}`;
  return '***';
}

function assertPatScope(ctx, requiredScopes, foundation = defaultFoundation) {
  const paasApiKeys = foundation?.paasApiKeys;
  if (typeof paasApiKeys?.assertApiKeyScope === 'function') {
    return paasApiKeys.assertApiKeyScope(ctx, requiredScopes);
  }
  const pat = ctx?.state?.latticeApiKey;
  if (!pat) return true;
  const held = new Set(Array.isArray(pat.scopes) ? pat.scopes : []);
  const needed = Array.isArray(requiredScopes) ? requiredScopes : [requiredScopes];
  if (needed.some((s) => held.has(s))) return true;
  throw fail('API_KEY_SCOPE_INSUFFICIENT', 403, `API key thiếu quyền (${needed.join(' hoặc ')}).`);
}

function extractClaimedRoles(ctx) {
  if (Array.isArray(ctx?.state?.currentRoles) && ctx.state.currentRoles.length) {
    return ctx.state.currentRoles.map((r) => String(r || '').trim()).filter(Boolean);
  }
  if (ctx?.state?.currentRole) {
    const clean = String(ctx.state.currentRole).trim();
    return clean ? [clean] : [];
  }
  return [];
}

async function resolveVerifiedRoles(db, ctx) {
  const claimed = extractClaimedRoles(ctx);
  const userId = val(ctx?.state?.currentUser, 'id');
  const ruRepo = db?.getRepository?.('rolesUsers');
  if (ruRepo && typeof ruRepo.find === 'function' && userId != null && /^[1-9]\d*$/.test(String(userId))) {
    const bindings = (await ruRepo.find({ filter: { userId: Number(userId) } })) || [];
    const assigned = new Set(
      bindings
        .filter((r) => val(r, 'userId') == null || Number(val(r, 'userId')) === Number(userId))
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

function isAdminRoleRow(role) {
  if (!role) return false;
  if (val(role, 'allowAll') === true || val(role, 'allowConfigure') === true) return true;
  const snippets = val(role, 'snippets');
  return Array.isArray(snippets) && (snippets.includes('pm') || snippets.includes('pm.*') || snippets.includes('*'));
}

async function hasCollectionPermission(db, ctx, collections, action = 'view') {
  const candidates = action === 'view' ? ['view', 'list'] : (Array.isArray(action) ? action : [action]);
  const cols = Array.isArray(collections) ? collections : [collections];
  if (typeof ctx?.can === 'function') {
    return cols.some((col) => candidates.some((act) => Boolean(ctx.can({ resource: col, action: act }))));
  }
  const roleNames = await resolveVerifiedRoles(db, ctx);
  if (!roleNames.length) return false;
  const rolesRepo = db?.getRepository?.('roles');
  const resRepo = db?.getRepository?.('dataSourcesRolesResources');
  for (const roleName of roleNames) {
    const role = rolesRepo?.findOne ? await rolesRepo.findOne({ filter: { name: roleName } }) : null;
    if (isAdminRoleRow(role)) return true;
    if (resRepo?.findOne) {
      for (const col of cols) {
        const res = await resRepo.findOne({ filter: { roleName, name: col, dataSourceKey: 'main' } });
        if (res) {
          if (val(res, 'usingActionsConfig') === false) return true;
          const actions = val(res, 'actions') || [];
          if (actions.some((a) => candidates.includes(a?.name || a))) return true;
        }
      }
    }
    const strategyActions = val(role, 'strategy')?.actions || [];
    if (Array.isArray(strategyActions) && strategyActions.some((a) => candidates.includes(a) || a === '*:*' || a === '*')) {
      return true;
    }
  }
  return false;
}

async function isOrgAdmin(db, ctx) {
  if (!ctx?.state?.currentUser) return false;
  const roleNames = await resolveVerifiedRoles(db, ctx);
  if (roleNames.includes('root')) return true;
  if (!roleNames.length) return false;
  const rolesRepo = db?.getRepository?.('roles');
  if (!rolesRepo) return false;
  if (typeof rolesRepo.find === 'function') {
    const matched = (await rolesRepo.find({ filter: { name: { $in: roleNames } } })) || [];
    return matched.some((r) => {
      const rName = val(r, 'name');
      if (rName && !roleNames.includes(rName)) return false;
      return isAdminRoleRow(r);
    });
  }
  if (typeof rolesRepo.findOne === 'function') {
    for (const roleName of roleNames) {
      const role = await rolesRepo.findOne({ filter: { name: roleName } });
      if (isAdminRoleRow(role)) return true;
    }
  }
  return false;
}

async function resolveTenantActor(db, ctx, {
  requireOrg = true,
  requestedOrgId = null,
  aclCollections = ['latticeOrders', 'latticeAssets'],
  aclAction = 'view',
  patScopes = null,
} = {}, foundation = defaultFoundation) {
  const userId = val(ctx?.state?.currentUser, 'id');
  if (userId == null || !/^[1-9]\d*$/.test(String(userId))) {
    throw fail('NATIVE_LOGIN_REQUIRED', 401, 'Yêu cầu đăng nhập.');
  }
  if (patScopes) assertPatScope(ctx, patScopes, foundation);

  const username = String(val(ctx.state.currentUser, 'username') || `user-${userId}`);
  const isRoot = ctx.state?.currentRole === 'root';
  if (isRoot) {
    let organizationId = null;
    const rawOrg = requestedOrgId != null ? String(requestedOrgId).trim() : '';
    if (rawOrg) {
      if (!ORG_ID_RE.test(rawOrg)) throw fail('WMS_ORG_INVALID', 400, 'organizationId không hợp lệ.');
      organizationId = rawOrg;
    } else {
      const empRepo = db?.getRepository?.('latticeEmployees');
      const rows = empRepo?.find
        ? (await runWithSystemRlsBypass(db, (transaction) => (
          empRepo.find({ filter: { userId: String(userId) }, limit: 2, ...(transaction ? { transaction } : {}) })
        ), foundation)) || []
        : [];
      if (rows.length === 1 && val(rows[0], 'active') === true) {
        organizationId = val(rows[0], 'organizationId');
      }
    }
    if (requireOrg && (!organizationId || !ORG_ID_RE.test(organizationId))) {
      throw fail('WMS_ORG_REQUIRED', 400, 'Tài khoản root cần truyền organizationId hợp lệ.');
    }
    return {
      isRoot: true,
      organizationId,
      actor: { userId: String(userId), employeeId: null, organizationId, username },
    };
  }

  const actor = await runWithSystemRlsBypass(db, (transaction) => resolveServiceActor(db, ctx.state.currentUser, { transaction }), foundation);
  if (requestedOrgId != null && String(requestedOrgId).trim() !== '' && String(requestedOrgId).trim() !== actor.organizationId) {
    throw fail('NATIVE_ORGANIZATION_MISMATCH', 403, 'Không được truy cập dữ liệu của tổ chức khác.');
  }
  if (aclCollections && aclCollections.length) {
    const allowed = await hasCollectionPermission(db, ctx, aclCollections, aclAction);
    if (!allowed) {
      throw fail('DXOS_ACL_DENIED', 403, 'Vai trò hiện tại không có quyền thực hiện thao tác này.');
    }
  }
  return {
    isRoot: false,
    organizationId: actor.organizationId,
    actor: { ...actor, username },
  };
}

async function appendAuditLedger(db, {
  organizationId,
  eventType,
  targetCollection,
  targetRecordId,
  actor,
  payload,
  metadata = null,
  transaction = null,
  scope = 'dxos:studio',
  foundation = defaultFoundation,
}) {
  const pkiLedger = foundation?.pkiLedger;
  if (typeof pkiLedger?.appendLedgerEntrySafely !== 'function') return null;
  try {
    return await pkiLedger.appendLedgerEntrySafely(
      db,
      {
        organizationId,
        eventType,
        targetCollection,
        targetRecordId: String(targetRecordId),
        actor: {
          userId: actor?.userId ? String(actor.userId) : null,
          employeeId: actor?.employeeId ?? null,
          username: actor?.username || (actor?.employeeId ? `employee-${actor.employeeId}` : 'operator'),
        },
        payload,
        metadata,
      },
      { scope, ...(transaction ? { transaction } : {}) },
    );
  } catch (err) {
    if (isSecurityInvariant(err, pkiLedger)) throw err;
    console.error(`[${scope}] Ledger append error:`, err?.message || err);
    return null;
  }
}

async function runWithOptionalRls(db, organizationId, fn, foundation = defaultFoundation) {
  const pgRls = foundation?.pgRls;
  if (
    process.env.DX_PG_RLS_SESSION === 'true'
    && organizationId
    && typeof db?.sequelize?.transaction === 'function'
    && typeof pgRls?.withTenantRlsContext === 'function'
  ) {
    const active = typeof pgRls.getActiveRlsContext === 'function' ? pgRls.getActiveRlsContext() : null;
    if (active?.transaction && active.organizationId === organizationId && active.sequelize === db.sequelize) {
      return fn(active.transaction);
    }
    return pgRls.withTenantRlsContext(db, organizationId, (transaction) => fn(transaction));
  }
  return fn(null);
}

async function runWithSystemRlsBypass(db, fn, foundation = defaultFoundation) {
  const pgRls = foundation?.pgRls;
  if (
    typeof pgRls?.canUsePgRlsSession === 'function'
    && pgRls.canUsePgRlsSession(db)
    && typeof pgRls.withSystemRlsBypass === 'function'
  ) {
    return pgRls.withSystemRlsBypass(db, (transaction) => fn(transaction));
  }
  return fn(null);
}

async function runInTx(db, fn, { organizationId = null, foundation = defaultFoundation } = {}) {
  const pgRls = foundation?.pgRls;
  const active = typeof pgRls?.getActiveRlsContext === 'function' ? pgRls.getActiveRlsContext() : null;
  if (active?.transaction && active.sequelize === db?.sequelize && (!organizationId || active.organizationId === organizationId)) {
    return fn(active.transaction);
  }
  if (typeof db?.sequelize?.transaction === 'function') {
    return db.sequelize.transaction(async (transaction) => {
      if (
        process.env.DX_PG_RLS_SESSION === 'true'
        && organizationId
        && typeof pgRls?.setTransactionRlsOrg === 'function'
      ) {
        await pgRls.setTransactionRlsOrg(db, organizationId, transaction);
      }
      return fn(transaction);
    });
  }
  return fn(null);
}

async function saveRow(repo, row, patch, filter, transaction) {
  const txOpt = transaction ? { transaction } : {};
  if (repo && typeof repo.update === 'function' && val(row, 'id') != null) {
    const res = await repo.update({ filterByTk: val(row, 'id'), filter, values: patch, ...txOpt });
    if (Array.isArray(res) && res[0]) return res[0];
  }
  if (typeof row?.update === 'function') {
    await row.update(patch, txOpt);
    return row;
  }
  return Object.assign(row, patch);
}

function clampPageLimit(limit) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n < 1) return 20;
  return Math.min(200, Math.floor(n));
}

function sanitizeDirectFilter(node, options = {}, depth = 0) {
  if (node == null) return node;
  if (depth > 20) throw fail('NATIVE_RELATION_EXPANSION_UNSUPPORTED', 403);
  const blockedFields = options?.blockedFields || null;
  let target = node;
  if (typeof target === 'string') {
    const trimmed = target.trim();
    if (!trimmed) return node;
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { target = JSON.parse(trimmed); } catch { throw fail('NATIVE_RELATION_EXPANSION_UNSUPPORTED', 403); }
    } else {
      return node;
    }
  }
  if (Array.isArray(target)) return target.map((item) => sanitizeDirectFilter(item, options, depth + 1));
  if (typeof target !== 'object') return target;
  const out = {};
  for (const [key, entry] of Object.entries(target)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype' || key === '$where' || key === '$raw' || key === '$sql') {
      throw fail('NATIVE_RELATION_EXPANSION_UNSUPPORTED', 403);
    }
    if (!key.startsWith('$')) {
      if (key.includes('.') || SENSITIVE_FILTER_KEY_RE.test(key) || blockedFields?.has(key.toLowerCase())) {
        throw fail('NATIVE_RELATION_EXPANSION_UNSUPPORTED', 403);
      }
    }
    out[key] = sanitizeDirectFilter(entry, options, depth + 1);
  }
  return out;
}

function assertSafeDirectSort(sort, blockedFields = null) {
  if (sort == null) return;
  const items = Array.isArray(sort) ? sort : String(sort).split(',');
  for (const item of items) {
    const clean = String(item || '').trim().replace(/^-/, '');
    if (!clean) continue;
    if (clean.includes('.') || SENSITIVE_FILTER_KEY_RE.test(clean) || blockedFields?.has(clean.toLowerCase())) {
      throw fail('NATIVE_RELATION_EXPANSION_UNSUPPORTED', 403);
    }
  }
}

module.exports = {
  ORG_ID_RE,
  SENSITIVE_FILTER_KEY_RE,
  LEDGER_SECURITY_INVARIANTS,
  defaultFoundation,
  val,
  toPlain,
  fail,
  loadFoundationModule,
  loadFoundationSet,
  isSecurityInvariant,
  sha256Hex,
  timingSafeEqualHex,
  readParams,
  parseFinite,
  parseStrictPositiveInt,
  parseOptionalDate,
  parseTempBand,
  escapeHtml,
  maskPhone,
  assertPatScope,
  resolveVerifiedRoles,
  hasCollectionPermission,
  isOrgAdmin,
  resolveTenantActor,
  appendAuditLedger,
  runWithOptionalRls,
  runWithSystemRlsBypass,
  runInTx,
  saveRow,
  clampPageLimit,
  sanitizeDirectFilter,
  assertSafeDirectSort,
};
