/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { createHash, randomBytes } = require('node:crypto');
const { resolveNativeActor } = require('./native-scope');
const { val, toPlain, getRepo, callerRoles } = require('./native-portal-helpers');
const { assertApiKeyScope, readParams } = require('./paas-api-keys');
const { canUsePgRlsSession, getActiveRlsContext, withTenantRlsContext } = require('./pg-rls');
const {
  canonicalJson,
  signCanonicalPayload,
  verifyPayloadSignature,
  appendLedgerEntrySafely,
} = require('./pki-ledger');

const GAS_CONSTANT_KJ_MOL_K = 0.008314472;
const DEFAULT_DELTA_H_KJ_MOL = 83.14472;
const ABSOLUTE_ZERO_C = -273.15;
const ORG_ID_RE = /^[a-zA-Z0-9_-]{1,80}$/;
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const URN_RE = /^urn:ngsi-ld:Asset:([a-zA-Z0-9_-]{1,80}):native:([1-9]\d{0,18})$/;
const SENSITIVE_KEY_RE = /password|secret|token|keyHash|privateKey|encryptedPrivateKey|salt|hash/i;
const PROTO_POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const DATA_GOV_HOOKS_MARKER = Symbol.for('latticedx.dataGovHooksInstalled');

const FREEZABLE_COLLECTIONS = Object.freeze(new Set([
  'latticeRequests',
  'latticeOrders',
  'latticeAssets',
  'latticeIncidentCases',
  'latticeTelemetryPoints',
  'latticeServiceTickets',
  'latticeParaDocuments',
]));

const DATA_GOV_PROTECTED_RESOURCES = Object.freeze(new Set([
  'latticeFrozenSnapshots',
  'latticeDataLineage',
  'latticeDataQuarantine',
]));

const WARM_STATUSES = Object.freeze(new Set([
  'completed',
  'cancelled',
  'closed',
  'archived',
  'resolved',
]));

const QUARANTINE_RESOLUTIONS = Object.freeze(new Set([
  'approved_release',
  'rejected',
]));

const BATCH_SIZE = 500;
const MAX_SCAN = 5000;
const MAX_LINEAGE_EDGES_PER_FREEZE = 100;
const MAX_LINEAGE_NODES = 100;

function failGov(code, status = 400, message = code) {
  return Object.assign(new Error(message), { code, status });
}

function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

function round3(n) {
  const rounded = Number(n.toFixed(3));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function parseFiniteNumberStrict(raw) {
  if (raw === null || raw === undefined || typeof raw === 'boolean' || typeof raw === 'object') {
    return null;
  }
  if (typeof raw === 'string' && raw.trim() === '') {
    return null;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function runDataGovDb(db, organizationId, fn) {
  const activeTx = getActiveRlsContext()?.transaction || null;
  if (canUsePgRlsSession(db) && !activeTx && organizationId && ORG_ID_RE.test(String(organizationId))) {
    return withTenantRlsContext(db, String(organizationId), fn);
  }
  return fn(activeTx || undefined);
}

async function withOptionalTransaction(db, fn, organizationId = null) {
  const activeTx = getActiveRlsContext()?.transaction || null;
  if (activeTx) {
    return fn(activeTx);
  }
  if (canUsePgRlsSession(db) && organizationId && ORG_ID_RE.test(String(organizationId))) {
    return withTenantRlsContext(db, String(organizationId), fn);
  }
  if (typeof db?.sequelize?.transaction === 'function') {
    return db.sequelize.transaction(fn);
  }
  return fn(null);
}

function sanitizePlainValue(value, { stripSensitive = false } = {}, depth = 0) {
  if (depth > 20) return null;
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (Array.isArray(value)) {
    return value.map((item) => {
      const cleaned = sanitizePlainValue(item, { stripSensitive }, depth + 1);
      return cleaned === undefined ? null : cleaned;
    });
  }
  if (typeof value === 'object') {
    const plain = typeof value.toJSON === 'function' ? value.toJSON() : value;
    if (plain !== value) {
      return sanitizePlainValue(plain, { stripSensitive }, depth + 1);
    }
    const out = {};
    for (const key of Object.keys(value)) {
      if (PROTO_POLLUTION_KEYS.has(key)) continue;
      if (stripSensitive && SENSITIVE_KEY_RE.test(key)) continue;
      const cleaned = sanitizePlainValue(value[key], { stripSensitive }, depth + 1);
      if (cleaned === undefined) continue;
      Object.defineProperty(out, key, {
        value: cleaned,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return null;
}

function sanitizeSnapshotFilter(node, depth = 0) {
  if (node === null || node === undefined) return null;
  if (depth > 10) {
    throw failGov('DATA_GOV_FILTER_INVALID', 400, 'Snapshot filter exceeds maximum nesting depth.');
  }
  let target = node;
  if (typeof target === 'string') {
    const trimmed = target.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        target = JSON.parse(trimmed);
      } catch {
        throw failGov('DATA_GOV_FILTER_INVALID', 400, 'Malformed snapshot filter JSON.');
      }
    } else {
      if (depth === 0) {
        throw failGov('DATA_GOV_FILTER_INVALID', 400, 'Snapshot filter must be a JSON object.');
      }
      return node;
    }
  }
  if (target === null || target === undefined) {
    if (depth === 0) {
      throw failGov('DATA_GOV_FILTER_INVALID', 400, 'Snapshot filter must be a plain object.');
    }
    return null;
  }
  if (Array.isArray(target)) {
    if (depth === 0) {
      throw failGov('DATA_GOV_FILTER_INVALID', 400, 'Snapshot filter must be a plain object.');
    }
    return target.map((item) => sanitizeSnapshotFilter(item, depth + 1));
  }
  if (typeof target !== 'object' || target instanceof Date || target instanceof RegExp) {
    if (depth === 0) {
      throw failGov('DATA_GOV_FILTER_INVALID', 400, 'Snapshot filter must be a plain object.');
    }
    return target;
  }

  const out = {};
  for (const key of Object.keys(target)) {
    if (PROTO_POLLUTION_KEYS.has(key)) {
      throw failGov('DATA_GOV_FILTER_INVALID', 400, `Forbidden filter key: ${key}`);
    }
    if (key === '$where' || key === '$raw' || key === '$sql') {
      throw failGov('DATA_GOV_FILTER_INVALID', 400, `Forbidden filter operator: ${key}`);
    }
    if (!key.startsWith('$') && (key.includes('.') || SENSITIVE_KEY_RE.test(key))) {
      throw failGov('DATA_GOV_FILTER_INVALID', 400, `Unsafe filter field: ${key}`);
    }
    const cleaned = sanitizeSnapshotFilter(target[key], depth + 1);
    Object.defineProperty(out, key, {
      value: cleaned,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

function computeMeanKineticTemperature(samplesC, { deltaH_kJ_mol = DEFAULT_DELTA_H_KJ_MOL, maxAllowedC = null } = {}) {
  if (!Array.isArray(samplesC) || samplesC.length === 0) {
    throw failGov('MKT_INVALID_SAMPLE', 400, 'samplesC must be a non-empty array of Celsius temperatures.');
  }
  const deltaH = parseFiniteNumberStrict(deltaH_kJ_mol);
  if (deltaH === null || deltaH <= 0) {
    throw failGov('MKT_INVALID_PARAMS', 400, 'deltaH_kJ_mol must be a positive finite number.');
  }

  let thresholdCelsius = null;
  if (maxAllowedC !== null && maxAllowedC !== undefined && !(typeof maxAllowedC === 'string' && maxAllowedC.trim() === '')) {
    const parsedMax = parseFiniteNumberStrict(maxAllowedC);
    if (parsedMax === null || parsedMax <= ABSOLUTE_ZERO_C) {
      throw failGov('MKT_INVALID_THRESHOLD', 400, 'maxAllowedC must be a finite temperature above -273.15 °C.');
    }
    thresholdCelsius = round3(parsedMax);
  }

  const samples = [];
  for (const raw of samplesC) {
    const t = parseFiniteNumberStrict(raw);
    if (t === null || t <= ABSOLUTE_ZERO_C) {
      throw failGov('MKT_INVALID_SAMPLE', 400, 'All temperature samples must be finite numbers strictly above -273.15 °C.');
    }
    samples.push(t);
  }

  const a = deltaH / GAS_CONSTANT_KJ_MOL_K;
  const exponents = new Array(samples.length);
  let maxExponent = -Infinity;
  let sumTemp = 0;
  let minTemp = Infinity;
  let maxTemp = -Infinity;
  let excursionCount = 0;

  for (let i = 0; i < samples.length; i += 1) {
    const t = samples[i];
    sumTemp += t;
    if (t < minTemp) minTemp = t;
    if (t > maxTemp) maxTemp = t;
    if (thresholdCelsius !== null && t > thresholdCelsius) {
      excursionCount += 1;
    }
    const tk = t - ABSOLUTE_ZERO_C;
    const expVal = -a / tk;
    exponents[i] = expVal;
    if (expVal > maxExponent) maxExponent = expVal;
  }

  let shiftedExpSum = 0;
  for (let i = 0; i < exponents.length; i += 1) {
    shiftedExpSum += Math.exp(exponents[i] - maxExponent);
  }
  const logMeanExp = maxExponent + Math.log(shiftedExpSum / samples.length);
  const mktKelvin = a / (-logMeanExp);
  const mktCelsius = round3(mktKelvin + ABSOLUTE_ZERO_C);

  return {
    mktCelsius,
    minTempCelsius: round3(minTemp),
    maxTempCelsius: round3(maxTemp),
    avgTempCelsius: round3(sumTemp / samples.length),
    sampleCount: samples.length,
    excursionCount,
    thresholdCelsius,
    breached: thresholdCelsius !== null ? mktCelsius > thresholdCelsius : false,
  };
}

function serializeLineageEdge(row) {
  if (!row) return null;
  const obs = val(row, 'observedAt');
  return {
    id: val(row, 'id') ?? null,
    organizationId: val(row, 'organizationId'),
    edgeUid: val(row, 'edgeUid'),
    sourceCollection: val(row, 'sourceCollection'),
    sourceRecordId: String(val(row, 'sourceRecordId') ?? ''),
    targetCollection: val(row, 'targetCollection'),
    targetRecordId: String(val(row, 'targetRecordId') ?? ''),
    relationType: val(row, 'relationType'),
    actorName: val(row, 'actorName') || null,
    metadataJson: val(row, 'metadataJson') || null,
    observedAt: obs instanceof Date ? obs.toISOString() : String(obs || ''),
  };
}

function serializeQuarantineRow(row) {
  if (!row) return null;
  const resAt = val(row, 'resolvedAt');
  return {
    id: val(row, 'id') ?? null,
    organizationId: val(row, 'organizationId'),
    quarantineUid: val(row, 'quarantineUid'),
    sourceSystem: val(row, 'sourceSystem') || 'iiot',
    assetEntityId: val(row, 'assetEntityId') || null,
    metricName: val(row, 'metricName') || null,
    numericValue: val(row, 'numericValue') != null ? Number(val(row, 'numericValue')) : null,
    unit: val(row, 'unit') || null,
    reasonCode: val(row, 'reasonCode'),
    severity: val(row, 'severity') || 'medium',
    rawPayload: val(row, 'rawPayload') || {},
    status: val(row, 'status') || 'quarantined',
    resolvedBy: val(row, 'resolvedBy') || null,
    resolvedAt: resAt ? (resAt instanceof Date ? resAt.toISOString() : String(resAt)) : null,
    resolutionNote: val(row, 'resolutionNote') || null,
    active: val(row, 'active') !== false,
    createdAt: val(row, 'createdAt') || null,
  };
}

function serializeSnapshotSummary(row, { includePayload = false } = {}) {
  if (!row) return null;
  const frozenAt = val(row, 'frozenAt');
  const expiresAt = val(row, 'expiresAt');
  const out = {
    id: val(row, 'id') ?? null,
    organizationId: val(row, 'organizationId'),
    snapshotUid: val(row, 'snapshotUid'),
    tier: val(row, 'tier') || 'cold',
    sourceCollection: val(row, 'sourceCollection'),
    filterSummary: val(row, 'filterSummary') || null,
    recordCount: Number(val(row, 'recordCount')) || 0,
    payloadHash: val(row, 'payloadHash'),
    ledgerEntrySeq: val(row, 'ledgerEntrySeq') != null ? Number(val(row, 'ledgerEntrySeq')) : null,
    signatureBase64: val(row, 'signatureBase64') || null,
    keyId: val(row, 'keyId') || null,
    frozenAt: frozenAt instanceof Date ? frozenAt.toISOString() : String(frozenAt || ''),
    frozenBy: val(row, 'frozenBy') || null,
    retentionDays: Number(val(row, 'retentionDays')) || 1825,
    expiresAt: expiresAt ? (expiresAt instanceof Date ? expiresAt.toISOString() : String(expiresAt)) : null,
    coldStorageUri: val(row, 'coldStorageUri') || null,
    status: val(row, 'status') || 'sealed',
    active: val(row, 'active') !== false,
  };
  if (includePayload) {
    out.payloadJson = val(row, 'payloadJson') || [];
  }
  return out;
}

async function recordLineageEdge(db, {
  organizationId,
  sourceCollection,
  sourceRecordId,
  targetCollection,
  targetRecordId,
  relationType,
  actorName = null,
  metadataJson = null,
  observedAt = null,
  transaction = null,
} = {}) {
  const orgId = typeof organizationId === 'string' ? organizationId.trim() : '';
  if (!ORG_ID_RE.test(orgId)) {
    throw failGov('LINEAGE_ORG_REQUIRED', 400, 'Valid organizationId is required for lineage edge.');
  }
  const srcCol = String(sourceCollection || '').trim().slice(0, 255);
  const srcId = String(sourceRecordId ?? '').trim().slice(0, 255);
  const tgtCol = String(targetCollection || '').trim().slice(0, 255);
  const tgtId = String(targetRecordId ?? '').trim().slice(0, 255);
  const rel = String(relationType || '').trim().slice(0, 128);
  if (!srcCol || !srcId || !tgtCol || !tgtId || !rel) {
    throw failGov('LINEAGE_EDGE_INVALID', 400, 'sourceCollection, sourceRecordId, targetCollection, targetRecordId, and relationType are required.');
  }

  const repo = getRepo(db, 'latticeDataLineage');
  if (!repo || typeof repo.create !== 'function') {
    return null;
  }

  const execute = async (tx) => {
    const txOpt = tx ? { transaction: tx } : {};
    const edgeUid = `lin-${sha256Hex(`${orgId}|${srcCol}|${srcId}|${tgtCol}|${tgtId}|${rel}`).slice(0, 32)}`;

    const findExisting = async () => {
      if (typeof repo.findOne === 'function') {
        return repo.findOne({ filter: { organizationId: orgId, edgeUid }, ...txOpt });
      }
      if (typeof repo.find === 'function') {
        const rows = (await repo.find({ filter: { organizationId: orgId, edgeUid }, limit: 1, ...txOpt })) || [];
        return rows[0] || null;
      }
      return null;
    };

    const existing = await findExisting();
    if (existing && val(existing, 'organizationId') === orgId) {
      return serializeLineageEdge(existing);
    }

    const obsDate = observedAt ? new Date(observedAt) : new Date();
    if (!Number.isFinite(obsDate.getTime())) {
      throw failGov('LINEAGE_TIMESTAMP_INVALID', 400, 'Invalid observedAt timestamp.');
    }
    const cleanMeta = metadataJson && typeof metadataJson === 'object'
      ? sanitizePlainValue(metadataJson)
      : null;

    try {
      const created = await repo.create({
        values: {
          organizationId: orgId,
          edgeUid,
          sourceCollection: srcCol,
          sourceRecordId: srcId,
          targetCollection: tgtCol,
          targetRecordId: tgtId,
          relationType: rel,
          actorName: actorName ? String(actorName).trim().slice(0, 255) : null,
          metadataJson: cleanMeta,
          observedAt: obsDate,
        },
        ...txOpt,
      });
      return serializeLineageEdge(created);
    } catch (err) {
      if (err?.name === 'SequelizeUniqueConstraintError' || /unique/i.test(String(err?.message || ''))) {
        const winner = await findExisting();
        if (winner) return serializeLineageEdge(winner);
      }
      throw err;
    }
  };

  if (transaction) {
    return execute(transaction);
  }
  return runDataGovDb(db, orgId, execute);
}

async function captureQuarantineRecord(db, {
  organizationId,
  sourceSystem = 'iiot',
  assetEntityId = null,
  metricName = null,
  numericValue = null,
  unit = null,
  reasonCode,
  severity = 'medium',
  rawPayload = {},
  actor = null,
  transaction = null,
} = {}) {
  const orgId = typeof organizationId === 'string' ? organizationId.trim() : '';
  if (!ORG_ID_RE.test(orgId)) {
    throw failGov('QUARANTINE_ORG_REQUIRED', 400, 'Valid organizationId is required.');
  }
  const cleanReason = String(reasonCode || '').trim().slice(0, 128);
  if (!cleanReason) {
    throw failGov('QUARANTINE_REASON_REQUIRED', 400, 'reasonCode is required.');
  }

  const repo = getRepo(db, 'latticeDataQuarantine');
  if (!repo || typeof repo.create !== 'function') {
    return null;
  }

  const cleanSystem = String(sourceSystem || 'iiot').trim().slice(0, 64) || 'iiot';
  const cleanSev = ['low', 'medium', 'high', 'critical'].includes(String(severity || '').trim().toLowerCase())
    ? String(severity).trim().toLowerCase()
    : 'medium';
  const parsedVal = numericValue !== null && numericValue !== undefined ? parseFiniteNumberStrict(numericValue) : null;
  const cleanPayload = rawPayload && typeof rawPayload === 'object'
    ? sanitizePlainValue(rawPayload)
    : { value: rawPayload ?? null };
  const quarantineUid = `QRN-${Date.now().toString(36).toUpperCase()}-${randomBytes(4).toString('hex').toUpperCase()}`;

  const execute = async (tx) => {
    const txOpt = tx ? { transaction: tx } : {};
    const created = await repo.create({
      values: {
        organizationId: orgId,
        quarantineUid,
        sourceSystem: cleanSystem,
        assetEntityId: assetEntityId ? String(assetEntityId).trim().slice(0, 255) : null,
        metricName: metricName ? String(metricName).trim().slice(0, 128) : null,
        numericValue: parsedVal,
        unit: unit ? String(unit).trim().slice(0, 64) : null,
        reasonCode: cleanReason,
        severity: cleanSev,
        rawPayload: cleanPayload,
        status: 'quarantined',
        active: true,
      },
      ...txOpt,
    });

    await appendLedgerEntrySafely(db, {
      organizationId: orgId,
      eventType: 'data.quarantined',
      targetCollection: 'latticeDataQuarantine',
      targetRecordId: quarantineUid,
      actor: actor || { username: cleanSystem },
      payload: {
        quarantineUid,
        sourceSystem: cleanSystem,
        assetEntityId: assetEntityId || null,
        metricName: metricName || null,
        numericValue: parsedVal,
        unit: unit || null,
        reasonCode: cleanReason,
        severity: cleanSev,
      },
    }, {
      scope: 'dxosDataGov:quarantine',
      ...txOpt,
    });

    return serializeQuarantineRow(created);
  };

  if (transaction) {
    return execute(transaction);
  }
  return runDataGovDb(db, orgId, execute);
}

async function resolveVerifiedRoles(db, ctx) {
  const claimed = callerRoles(ctx);
  const userId = val(ctx?.state?.currentUser, 'id');
  const ruRepo = getRepo(db, 'rolesUsers');
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

async function isVerifiedAdmin(db, verifiedRoles) {
  if (!Array.isArray(verifiedRoles) || verifiedRoles.length === 0) return false;
  if (verifiedRoles.includes('root')) return true;
  const rolesRepo = getRepo(db, 'roles');
  if (!rolesRepo || typeof rolesRepo.find !== 'function') {
    if (typeof rolesRepo?.findOne === 'function') {
      for (const roleName of verifiedRoles) {
        const role = await rolesRepo.findOne({ filter: { name: roleName } });
        if (role && (val(role, 'allowAll') === true || val(role, 'allowConfigure') === true)) return true;
        const snippets = val(role, 'snippets');
        if (Array.isArray(snippets) && (snippets.includes('pm') || snippets.includes('pm.*'))) return true;
      }
    }
    return false;
  }
  const matched = (await rolesRepo.find({ filter: { name: { $in: verifiedRoles } } })) || [];
  return matched.some((role) => {
    const name = val(role, 'name');
    if (name && !verifiedRoles.includes(name)) return false;
    if (val(role, 'allowAll') === true || val(role, 'allowConfigure') === true) return true;
    const snippets = val(role, 'snippets');
    return Array.isArray(snippets) && (snippets.includes('pm') || snippets.includes('pm.*'));
  });
}

async function hasCollectionPrivilege(db, ctx, verifiedRoles, collection, action = 'view') {
  const candidates = action === 'view' ? ['view', 'list'] : [action];
  const claimed = callerRoles(ctx);
  const canTrustCtxCan = typeof ctx?.can === 'function'
    && (claimed.length === 0 || claimed.every((r) => verifiedRoles.includes(r)));
  if (canTrustCtxCan) {
    return candidates.some((act) => ctx.can({ resource: collection, action: act }));
  }

  if (!verifiedRoles.length) return false;
  const dsrRepo = getRepo(db, 'dataSourcesRolesResources');
  if (dsrRepo && typeof dsrRepo.findOne === 'function') {
    for (const roleName of verifiedRoles) {
      const res = await dsrRepo.findOne({
        filter: { roleName, name: collection, dataSourceKey: 'main' },
      });
      if (res) {
        if (val(res, 'usingActionsConfig') === false) return true;
        const actions = val(res, 'actions') || [];
        if (actions.some((a) => candidates.includes(a?.name || a))) return true;
      }
    }
  }

  const rolesRepo = getRepo(db, 'roles');
  if (rolesRepo) {
    const rows = typeof rolesRepo.find === 'function'
      ? (await rolesRepo.find({ filter: { name: { $in: verifiedRoles } } })) || []
      : [];
    for (const role of rows) {
      const name = val(role, 'name');
      if (name && !verifiedRoles.includes(name)) continue;
      if (val(role, 'allowAll') === true) return true;
      const strategyActions = val(role, 'strategy')?.actions || [];
      if (Array.isArray(strategyActions) && strategyActions.some((a) => candidates.includes(a) || a === '*:*')) {
        return true;
      }
    }
  }
  return false;
}

async function resolveDataGovScope(db, ctx, requestedOrgId = null) {
  if (!ctx?.state?.currentUser) {
    throw failGov('NATIVE_LOGIN_REQUIRED', 401, 'Authentication required.');
  }
  const verifiedRoles = await resolveVerifiedRoles(db, ctx);
  const isRoot = verifiedRoles.includes('root');
  const isAdmin = isRoot || (await isVerifiedAdmin(db, verifiedRoles));

  if (isRoot) {
    const cleanReq = requestedOrgId != null ? String(requestedOrgId).trim() : '';
    if (!ORG_ID_RE.test(cleanReq)) {
      throw failGov('DATA_GOV_ORG_REQUIRED', 400, 'Valid organizationId is required for root data governance queries.');
    }
    return {
      isRoot: true,
      isAdmin: true,
      verifiedRoles,
      organizationId: cleanReq,
      actor: {
        userId: String(val(ctx.state.currentUser, 'id') || ''),
        employeeId: null,
        username: val(ctx.state.currentUser, 'username') || 'root',
      },
    };
  }

  const actor = await resolveNativeActor(db, ctx.state.currentUser);
  if (
    requestedOrgId !== undefined
    && requestedOrgId !== null
    && String(requestedOrgId).trim() !== ''
    && String(requestedOrgId).trim() !== actor.organizationId
  ) {
    throw failGov('NATIVE_ORGANIZATION_MISMATCH', 403, 'Cross-organization data governance access is forbidden.');
  }

  return {
    isRoot: false,
    isAdmin,
    verifiedRoles,
    organizationId: actor.organizationId,
    actor: {
      ...actor,
      username: val(ctx.state.currentUser, 'username') || `employee-${actor.employeeId}`,
    },
  };
}

async function assertReadPrivilege(db, ctx, scope, collections = []) {
  if (scope.isRoot || scope.isAdmin) return true;
  if (typeof ctx?.can === 'function') {
    for (const col of collections) {
      if (await hasCollectionPrivilege(db, ctx, scope.verifiedRoles, col, 'view')) return true;
    }
    throw failGov('DATA_GOV_FORBIDDEN', 403, 'Insufficient permissions to read data governance resources.');
  }
  const dsrRepo = getRepo(db, 'dataSourcesRolesResources');
  if (dsrRepo && typeof dsrRepo.findOne === 'function') {
    for (const col of collections) {
      if (await hasCollectionPrivilege(db, ctx, scope.verifiedRoles, col, 'view')) return true;
    }
    // Check if any collection row exists at all for caller's roles; if none exist for Wave 2 tables, allow logged-in org member read unless explicitly denied
    let hasExplicitResourcePolicy = false;
    for (const roleName of scope.verifiedRoles) {
      for (const col of collections) {
        const explicit = await dsrRepo.findOne({ filter: { roleName, name: col, dataSourceKey: 'main' } });
        if (explicit) {
          hasExplicitResourcePolicy = true;
          break;
        }
      }
      if (hasExplicitResourcePolicy) break;
    }
    if (hasExplicitResourcePolicy) {
      throw failGov('DATA_GOV_FORBIDDEN', 403, 'Insufficient collection view permission.');
    }
  }
  return true;
}

async function scanOrgRows(repo, organizationId, filter = {}, maxScan = MAX_SCAN, transaction = null) {
  if (!repo || typeof repo.find !== 'function') return [];
  const txOpt = transaction ? { transaction } : {};
  const results = [];
  const seenKeys = new Set();
  for (let offset = 0; offset < maxScan;) {
    const batch = (await repo.find({
      filter: Object.keys(filter).length ? { $and: [{ organizationId }, filter] } : { organizationId },
      limit: Math.min(BATCH_SIZE, maxScan - offset),
      offset,
      sort: ['id'],
      ...txOpt,
    })) || [];
    if (!Array.isArray(batch) || batch.length === 0) break;
    let unseenCount = 0;
    for (const row of batch) {
      const id = val(row, 'id');
      const key = id != null ? `id:${id}` : `idx:${results.length}`;
      if (id != null) {
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
      }
      unseenCount += 1;
      if (val(row, 'organizationId') !== organizationId) continue;
      results.push(row);
    }
    if (unseenCount === 0 || batch.length < BATCH_SIZE) break;
    offset += batch.length;
  }
  return results;
}

function registerDataGovernanceHooks(db) {
  if (typeof db?.on !== 'function' || db[DATA_GOV_HOOKS_MARKER]) return;
  try {
    Object.defineProperty(db, DATA_GOV_HOOKS_MARKER, { value: true, configurable: true });
  } catch {
    // Ignore frozen db stubs
  }
  const guardImmutable = (instance, options) => {
    const resolvedOpts = options && typeof options === 'object' ? options : instance;
    if (resolvedOpts?.allowSystemMigration === true || resolvedOpts?.context?.state?.currentRole === 'root') {
      return;
    }
    throw failGov('COLD_SNAPSHOT_IMMUTABLE', 403, 'Cold-tier frozen snapshots are sealed and immutable.');
  };
  for (const event of ['beforeUpdate', 'beforeDestroy', 'beforeBulkUpdate', 'beforeBulkDestroy']) {
    db.on(`latticeFrozenSnapshots.${event}`, guardImmutable);
  }
}

function registerDataGovernanceDirectGuard(app) {
  app.resourceManager?.use?.(async (ctx, next) => {
    if (ctx.state?.currentRole === 'root') return next();
    const fullResource = String(ctx.action?.resourceName || '');
    const baseResource = fullResource.split('.')[0];
    const actionName = String(ctx.action?.actionName || '');

    if (baseResource === 'latticeFrozenSnapshots') {
      if (actionName === 'update' || actionName === 'destroy') {
        throw failGov('COLD_SNAPSHOT_IMMUTABLE', 403, 'Cold-tier frozen snapshots are sealed and immutable.');
      }
      throw failGov('DATA_GOV_DIRECT_CRUD_FORBIDDEN', 403, 'Direct access to latticeFrozenSnapshots is forbidden; use dxosDataGov.');
    }
    if (DATA_GOV_PROTECTED_RESOURCES.has(baseResource)) {
      throw failGov('DATA_GOV_DIRECT_CRUD_FORBIDDEN', 403, 'Direct access to data governance collections is forbidden; use dxosDataGov.');
    }
    if (
      fullResource === 'charts'
      && actionName === 'queryData'
      && DATA_GOV_PROTECTED_RESOURCES.has(String(ctx.action?.params?.values?.collection || ''))
    ) {
      throw failGov('DATA_GOV_DIRECT_CRUD_FORBIDDEN', 403, 'Direct chart access to data governance collections is forbidden.');
    }
    return next();
  }, { tag: 'latticeDataGovDirectGuard', after: 'acl' });
}

function registerDataGovernance(app) {
  const db = app.db;
  registerDataGovernanceHooks(db);
  registerDataGovernanceDirectGuard(app);

  const handleLineageTrace = async (ctx, next) => {
    if ((ctx.method || 'GET') !== 'GET') ctx.throw(405);
    const params = readParams(ctx);
    const scope = await resolveDataGovScope(db, ctx, params.organizationId);
    const collection = String(params.collection ?? params.sourceCollection ?? params.targetCollection ?? '').trim();
    const recordId = String(params.recordId ?? params.sourceRecordId ?? params.targetRecordId ?? '').trim();
    if (!collection || !IDENTIFIER_RE.test(collection) || !recordId || recordId.length > 255) {
      throw failGov('LINEAGE_TARGET_REQUIRED', 400, 'Valid collection and recordId are required for lineage traversal.');
    }
    await assertReadPrivilege(db, ctx, scope, ['latticeDataLineage', collection]);

    const rawDepth = Number(params.maxDepth ?? params.depth ?? 3);
    const maxDepth = Math.max(1, Math.min(5, Math.floor(Number.isFinite(rawDepth) ? rawDepth : 3)));
    const direction = ['both', 'outbound', 'inbound'].includes(String(params.direction || 'both').toLowerCase())
      ? String(params.direction || 'both').toLowerCase()
      : 'both';

    const lineageRepo = getRepo(db, 'latticeDataLineage');
    const rootKey = `${collection}:${recordId}`;
    const visitedNodes = new Map([[rootKey, { key: rootKey, collection, recordId, depth: 0 }]]);
    const edgesMap = new Map();
    const queue = [{ collection, recordId, depth: 0 }];
    let truncated = false;

    if (lineageRepo && typeof lineageRepo.find === 'function') {
      await runDataGovDb(db, scope.organizationId, async (transaction) => {
        const txOpt = transaction ? { transaction } : {};
        while (queue.length > 0 && visitedNodes.size < MAX_LINEAGE_NODES) {
          const cur = queue.shift();
          if (cur.depth >= maxDepth) continue;

          const candidateEdges = [];
          if (direction !== 'inbound') {
            const outRows = (await lineageRepo.find({
              filter: {
                organizationId: scope.organizationId,
                sourceCollection: cur.collection,
                sourceRecordId: cur.recordId,
              },
              limit: 100,
              ...txOpt,
            })) || [];
            for (const row of outRows) {
              if (
                val(row, 'organizationId') === scope.organizationId
                && val(row, 'sourceCollection') === cur.collection
                && String(val(row, 'sourceRecordId')) === cur.recordId
              ) {
                candidateEdges.push({ row, dir: 'outbound' });
              }
            }
          }
          if (direction !== 'outbound') {
            const inRows = (await lineageRepo.find({
              filter: {
                organizationId: scope.organizationId,
                targetCollection: cur.collection,
                targetRecordId: cur.recordId,
              },
              limit: 100,
              ...txOpt,
            })) || [];
            for (const row of inRows) {
              if (
                val(row, 'organizationId') === scope.organizationId
                && val(row, 'targetCollection') === cur.collection
                && String(val(row, 'targetRecordId')) === cur.recordId
              ) {
                candidateEdges.push({ row, dir: 'inbound' });
              }
            }
          }

          for (const { row, dir } of candidateEdges) {
            const serialized = serializeLineageEdge(row);
            const nextCol = dir === 'outbound' ? serialized.targetCollection : serialized.sourceCollection;
            const nextId = dir === 'outbound' ? serialized.targetRecordId : serialized.sourceRecordId;
            const nextKey = `${nextCol}:${nextId}`;
            if (!visitedNodes.has(nextKey)) {
              if (visitedNodes.size >= MAX_LINEAGE_NODES) {
                truncated = true;
                break;
              }
              visitedNodes.set(nextKey, {
                key: nextKey,
                collection: nextCol,
                recordId: nextId,
                depth: cur.depth + 1,
              });
              queue.push({ collection: nextCol, recordId: nextId, depth: cur.depth + 1 });
            }
            if (!edgesMap.has(serialized.edgeUid)) {
              edgesMap.set(serialized.edgeUid, serialized);
            }
          }
        }
      });
    }

    ctx.body = {
      organizationId: scope.organizationId,
      root: { collection, recordId },
      maxDepth,
      direction,
      nodeCount: visitedNodes.size,
      edgeCount: edgesMap.size,
      truncated,
      nodes: [...visitedNodes.values()],
      edges: [...edgesMap.values()],
    };
    if (next) return next();
  };

  const handleQuarantineList = async (ctx, next) => {
    if ((ctx.method || 'GET') !== 'GET') ctx.throw(405);
    const params = readParams(ctx);
    const scope = await resolveDataGovScope(db, ctx, params.organizationId);
    await assertReadPrivilege(db, ctx, scope, ['latticeDataQuarantine', 'latticeIncidentCases']);

    const page = Math.max(1, Math.min(10000, Math.floor(Number(params.page) || 1)));
    const pageSize = Math.max(1, Math.min(200, Math.floor(Number(params.pageSize ?? params.limit) || 20)));

    const qRepo = getRepo(db, 'latticeDataQuarantine');
    if (!qRepo || typeof qRepo.find !== 'function') {
      ctx.body = { organizationId: scope.organizationId, total: 0, page, pageSize, items: [] };
      if (next) return next();
      return;
    }

    const filter = { organizationId: scope.organizationId };
    const cleanStatus = typeof params.status === 'string' && params.status.trim() ? params.status.trim() : null;
    const cleanReason = typeof params.reasonCode === 'string' && params.reasonCode.trim() ? params.reasonCode.trim() : null;
    const cleanSev = typeof params.severity === 'string' && params.severity.trim() ? params.severity.trim() : null;
    const cleanEntity = typeof params.assetEntityId === 'string' && params.assetEntityId.trim() ? params.assetEntityId.trim() : null;
    if (cleanStatus) filter.status = cleanStatus;
    if (cleanReason) filter.reasonCode = cleanReason;
    if (cleanSev) filter.severity = cleanSev;
    if (cleanEntity) filter.assetEntityId = cleanEntity;

    const { rawRows, total } = await runDataGovDb(db, scope.organizationId, async (transaction) => {
      const txOpt = transaction ? { transaction } : {};
      const foundRows = (await qRepo.find({
        filter,
        sort: ['-id'],
        offset: (page - 1) * pageSize,
        limit: pageSize,
        ...txOpt,
      })) || [];
      const foundTotal = typeof qRepo.count === 'function' ? await qRepo.count({ filter, ...txOpt }) : null;
      return { rawRows: foundRows, total: foundTotal };
    });
    const filtered = rawRows.filter((r) => (
      val(r, 'organizationId') === scope.organizationId
      && (!cleanStatus || val(r, 'status') === cleanStatus)
      && (!cleanReason || val(r, 'reasonCode') === cleanReason)
      && (!cleanSev || val(r, 'severity') === cleanSev)
      && (!cleanEntity || val(r, 'assetEntityId') === cleanEntity)
    ));
    const finalTotal = total !== null ? total : filtered.length;

    ctx.body = {
      organizationId: scope.organizationId,
      total: finalTotal,
      page,
      pageSize,
      items: filtered.map(serializeQuarantineRow),
    };
    if (next) return next();
  };

  const handleQuarantineResolve = async (ctx, next) => {
    if ((ctx.method || 'POST') !== 'POST') ctx.throw(405);
    assertApiKeyScope(ctx, ['write']);
    const params = readParams(ctx);
    const scope = await resolveDataGovScope(db, ctx, params.organizationId);

    const canResolve = scope.isRoot
      || scope.isAdmin
      || (await hasCollectionPrivilege(db, ctx, scope.verifiedRoles, 'latticeDataQuarantine', 'update'))
      || (await hasCollectionPrivilege(db, ctx, scope.verifiedRoles, 'latticeIncidentCases', 'update'));
    if (!canResolve) {
      throw failGov('DATA_GOV_FORBIDDEN', 403, 'Insufficient permissions to resolve quarantined telemetry records.');
    }

    const nextStatus = String(params.status ?? params.decision ?? params.resolution ?? '').trim();
    if (!QUARANTINE_RESOLUTIONS.has(nextStatus)) {
      throw failGov('QUARANTINE_STATUS_INVALID', 400, "status must be 'approved_release' or 'rejected'.");
    }

    const qUid = params.quarantineUid != null ? String(params.quarantineUid).trim() : '';
    const rawId = params.id ?? params.filterByTk;
    const numericId = rawId != null && /^[1-9]\d*$/.test(String(rawId)) ? Number(rawId) : null;
    if (!qUid && numericId === null) {
      throw failGov('QUARANTINE_ID_REQUIRED', 400, 'quarantineUid or valid numeric id is required.');
    }

    const qRepo = getRepo(db, 'latticeDataQuarantine');
    if (!qRepo || typeof qRepo.findOne !== 'function') {
      throw failGov('QUARANTINE_REPO_UNAVAILABLE', 503, 'latticeDataQuarantine repository is unavailable.');
    }

    const lookupFilter = qUid
      ? { organizationId: scope.organizationId, quarantineUid: qUid }
      : { organizationId: scope.organizationId, id: numericId };

    const resolutionNote = params.resolutionNote != null
      ? String(params.resolutionNote).trim().slice(0, 500)
      : null;
    const wantsRelease = params.releaseToTelemetry === true || params.releaseToTelemetry === 'true';
    if (nextStatus === 'rejected' && wantsRelease) {
      throw failGov('QUARANTINE_RELEASE_CONFLICT', 400, 'Cannot release telemetry when rejecting a quarantined record.');
    }
    const releaseToTelemetry = nextStatus === 'approved_release' && wantsRelease;

    const { updated, releasedPoint } = await withOptionalTransaction(db, async (transaction) => {
      const txOpt = transaction ? { transaction } : {};
      const qModel = transaction ? db.getModel?.('latticeDataQuarantine') : null;
      const row = qModel && typeof qModel.findOne === 'function'
        ? await qModel.findOne({
          where: lookupFilter,
          transaction,
          ...(transaction.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {}),
        })
        : await qRepo.findOne({ filter: lookupFilter, ...txOpt });

      if (!row || val(row, 'organizationId') !== scope.organizationId) {
        throw failGov('QUARANTINE_NOT_FOUND', 404, 'Quarantine record not found in organization scope.');
      }
      if (String(val(row, 'status') || 'quarantined') !== 'quarantined') {
        throw failGov('QUARANTINE_ALREADY_RESOLVED', 409, 'Quarantine record has already been resolved.');
      }

      let releasePayload = null;
      if (releaseToTelemetry) {
        const candidateVal = params.correctedNumericValue !== undefined
          ? params.correctedNumericValue
          : val(row, 'numericValue');
        const parsedReleaseVal = parseFiniteNumberStrict(candidateVal);
        const metricName = String(val(row, 'metricName') || '').trim();
        const unit = String(val(row, 'unit') || 'CEL').trim();
        const assetEntityId = String(val(row, 'assetEntityId') || '').trim();
        const isTemp = metricName.toLowerCase() === 'temperature' || unit.toUpperCase() === 'CEL';
        if (
          parsedReleaseVal === null
          || !assetEntityId
          || !metricName
          || (isTemp && (parsedReleaseVal < -100 || parsedReleaseVal > 150))
        ) {
          throw failGov(
            'QUARANTINE_RELEASE_VALUE_INVALID',
            400,
            'Released telemetry value must be a finite physical measurement within valid sensor bounds.',
          );
        }
        const raw = val(row, 'rawPayload') || {};
        const obsRaw = raw.observedAt;
        const obsDate = obsRaw && Number.isFinite(new Date(obsRaw).getTime()) ? new Date(obsRaw) : new Date();
        const validAssetId = raw.assetId != null && /^[1-9]\d{0,18}$/.test(String(raw.assetId))
          ? Number(raw.assetId)
          : null;
        releasePayload = {
          organizationId: scope.organizationId,
          ...(validAssetId != null ? { assetId: validAssetId } : {}),
          assetEntityId,
          metricName,
          numericValue: parsedReleaseVal,
          unit,
          quality: 'good',
          sourceProtocol: String(raw.sourceProtocol || 'quarantine_release').slice(0, 64),
          observedAt: obsDate,
        };
      }

      let txReleasedPoint = null;
      if (releasePayload) {
        const tsRepo = getRepo(db, 'latticeTelemetryPoints');
        if (!tsRepo || typeof tsRepo.create !== 'function') {
          throw failGov('TELEMETRY_REPO_UNAVAILABLE', 503, 'latticeTelemetryPoints repository is unavailable.');
        }
        const createdPt = await tsRepo.create({ values: releasePayload, ...txOpt });
        txReleasedPoint = toPlain(createdPt);
        if (txReleasedPoint?.id != null) {
          await recordLineageEdge(db, {
            organizationId: scope.organizationId,
            sourceCollection: 'latticeDataQuarantine',
            sourceRecordId: String(val(row, 'quarantineUid') || val(row, 'id')),
            targetCollection: 'latticeTelemetryPoints',
            targetRecordId: String(txReleasedPoint.id),
            relationType: 'released_from_quarantine',
            actorName: scope.actor.username,
            metadataJson: { numericValue: releasePayload.numericValue, resolutionNote },
            ...txOpt,
          });
        }
      }

      const resolvedAt = new Date();
      const patch = {
        status: nextStatus,
        resolvedBy: scope.actor.username,
        resolvedAt,
        ...(resolutionNote !== null ? { resolutionNote } : {}),
      };
      let updatedRow = row;
      if (typeof row.update === 'function') {
        updatedRow = await row.update(patch, txOpt);
      } else if (typeof qRepo.update === 'function') {
        const res = await qRepo.update({
          filterByTk: val(row, 'id'),
          filter: { organizationId: scope.organizationId, status: 'quarantined' },
          values: patch,
          ...txOpt,
        });
        if (Array.isArray(res)) {
          if (!res[0]) {
            throw failGov('QUARANTINE_ALREADY_RESOLVED', 409, 'Quarantine record has already been resolved.');
          }
          updatedRow = res[0];
        }
      }

      await appendLedgerEntrySafely(db, {
        organizationId: scope.organizationId,
        eventType: 'data.quarantine_resolved',
        targetCollection: 'latticeDataQuarantine',
        targetRecordId: String(val(row, 'quarantineUid') || val(row, 'id')),
        actor: scope.actor,
        payload: {
          quarantineUid: val(row, 'quarantineUid'),
          status: nextStatus,
          releasedTelemetryId: txReleasedPoint?.id ?? null,
          resolutionNote,
        },
      }, { scope: 'dxosDataGov:quarantineResolve', ...txOpt });

      return { updated: updatedRow, releasedPoint: txReleasedPoint };
    }, scope.organizationId);

    ctx.body = {
      quarantine: serializeQuarantineRow(updated),
      releasedPoint,
    };
    if (next) return next();
  };

  app.resourceManager.define({
    name: 'dxosDataGov',
    actions: {
      tierSummary: async (ctx, next) => {
        if ((ctx.method || 'GET') !== 'GET') ctx.throw(405);
        const params = readParams(ctx);
        const scope = await resolveDataGovScope(db, ctx, params.organizationId);
        await assertReadPrivilege(db, ctx, scope, ['latticeOrders', 'latticeServiceTickets', 'latticeFrozenSnapshots']);

        const orgId = scope.organizationId;
        const { orders, tickets, snapshots, lineage, quarantine } = await runDataGovDb(db, orgId, async (transaction) => ({
          orders: await scanOrgRows(getRepo(db, 'latticeOrders'), orgId, {}, MAX_SCAN, transaction),
          tickets: await scanOrgRows(getRepo(db, 'latticeServiceTickets'), orgId, {}, MAX_SCAN, transaction),
          snapshots: await scanOrgRows(getRepo(db, 'latticeFrozenSnapshots'), orgId, {}, MAX_SCAN, transaction),
          lineage: await scanOrgRows(getRepo(db, 'latticeDataLineage'), orgId, {}, MAX_SCAN, transaction),
          quarantine: await scanOrgRows(getRepo(db, 'latticeDataQuarantine'), orgId, {}, MAX_SCAN, transaction),
        }));

        let hotOrders = 0;
        let warmOrders = 0;
        for (const ord of orders) {
          const st = String(val(ord, 'status') || 'draft').trim().toLowerCase();
          if (WARM_STATUSES.has(st)) warmOrders += 1;
          else hotOrders += 1;
        }

        let hotTickets = 0;
        for (const tkt of tickets) {
          const st = String(val(tkt, 'status') || 'open').trim().toLowerCase();
          if (!WARM_STATUSES.has(st)) hotTickets += 1;
        }

        let coldSnapshots = 0;
        let coldTotalRecords = 0;
        for (const snap of snapshots) {
          if (val(snap, 'active') === false) continue;
          coldSnapshots += 1;
          coldTotalRecords += Math.max(0, Number(val(snap, 'recordCount')) || 0);
        }

        let quarantineOpen = 0;
        let quarantineResolved = 0;
        for (const q of quarantine) {
          const st = String(val(q, 'status') || 'quarantined').trim().toLowerCase();
          if (st === 'quarantined') quarantineOpen += 1;
          else quarantineResolved += 1;
        }

        ctx.body = {
          organizationId: orgId,
          hotOrders,
          warmOrders,
          hotTickets,
          coldSnapshots,
          coldTotalRecords,
          lineageEdges: lineage.length,
          quarantineOpen,
          quarantineResolved,
        };
        if (next) return next();
      },

      freezeSnapshot: async (ctx, next) => {
        if ((ctx.method || 'POST') !== 'POST') ctx.throw(405);
        assertApiKeyScope(ctx, ['write']);
        const params = readParams(ctx);
        const scope = await resolveDataGovScope(db, ctx, params.organizationId);

        const sourceCollection = String(params.sourceCollection || params.collection || '').trim();
        if (!sourceCollection) {
          throw failGov('DATA_GOV_COLLECTION_REQUIRED', 400, 'sourceCollection is required.');
        }
        if (!FREEZABLE_COLLECTIONS.has(sourceCollection)) {
          throw failGov('DATA_GOV_COLLECTION_FORBIDDEN', 403, `Collection ${sourceCollection} is not allowed for cold snapshot freezing.`);
        }

        const canFreeze = scope.isRoot
          || scope.isAdmin
          || (await hasCollectionPrivilege(db, ctx, scope.verifiedRoles, sourceCollection, 'create'))
          || (await hasCollectionPrivilege(db, ctx, scope.verifiedRoles, 'latticeFrozenSnapshots', 'create'));
        if (!canFreeze) {
          throw failGov('DATA_GOV_FORBIDDEN', 403, 'Administrator or target collection create privilege is required to freeze snapshots.');
        }

        const tier = params.tier !== undefined ? String(params.tier).trim().toLowerCase() : 'cold';
        if (!['cold', 'warm'].includes(tier)) {
          throw failGov('DATA_GOV_TIER_INVALID', 400, "tier must be 'cold' or 'warm'.");
        }
        const retentionDays = params.retentionDays !== undefined
          ? parseFiniteNumberStrict(params.retentionDays)
          : 1825;
        if (retentionDays === null || !Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 36500) {
          throw failGov('DATA_GOV_RETENTION_INVALID', 400, 'retentionDays must be an integer between 1 and 36500.');
        }

        let coldStorageUri = null;
        if (params.coldStorageUri != null && String(params.coldStorageUri).trim() !== '') {
          const rawUri = String(params.coldStorageUri).trim().slice(0, 512);
          if (/^(?:javascript|data|vbscript|file):/i.test(rawUri)) {
            throw failGov('DATA_GOV_URI_INVALID', 400, 'Unsafe coldStorageUri scheme.');
          }
          coldStorageUri = rawUri;
        }

        const sanitizedFilter = params.filter !== undefined ? sanitizeSnapshotFilter(params.filter) : null;
        const limit = Math.max(1, Math.min(2000, Math.floor(Number(params.limit) || 500)));

        const targetRepo = getRepo(db, sourceCollection);
        if (!targetRepo || typeof targetRepo.find !== 'function') {
          throw failGov('DATA_GOV_COLLECTION_UNAVAILABLE', 503, `Repository ${sourceCollection} is unavailable.`);
        }
        const snapshotRepo = getRepo(db, 'latticeFrozenSnapshots');
        if (!snapshotRepo || typeof snapshotRepo.create !== 'function') {
          throw failGov('DATA_GOV_SNAPSHOT_REPO_UNAVAILABLE', 503, 'latticeFrozenSnapshots repository is unavailable.');
        }

        const queryFilter = sanitizedFilter && Object.keys(sanitizedFilter).length > 0
          ? { $and: [{ organizationId: scope.organizationId }, sanitizedFilter] }
          : { organizationId: scope.organizationId };
        const { created, lineageEdgesRecorded } = await withOptionalTransaction(db, async (transaction) => {
          const txOpt = transaction ? { transaction } : {};
          const rawRows = (await targetRepo.find({ filter: queryFilter, sort: ['id'], limit, ...txOpt })) || [];
          const scopedRows = rawRows.filter((r) => val(r, 'organizationId') === scope.organizationId);
          const sanitizedRecords = scopedRows.map((row) => sanitizePlainValue(toPlain(row), { stripSensitive: true }));

          const canonicalPayload = canonicalJson(sanitizedRecords);
          const payloadHash = sha256Hex(canonicalPayload);
          const snapshotUid = `SNP-${Date.now().toString(36).toUpperCase()}-${randomBytes(4).toString('hex').toUpperCase()}`;
          const frozenAt = new Date();
          const expiresAt = new Date(frozenAt.getTime() + retentionDays * 86_400_000);

          let signatureBase64 = null;
          let keyId = null;
          const pkiRepo = getRepo(db, 'latticePkiKeys');
          if (pkiRepo && typeof pkiRepo.create === 'function' && (typeof pkiRepo.findOne === 'function' || typeof pkiRepo.find === 'function')) {
            const signed = await signCanonicalPayload(db, scope.organizationId, sanitizedRecords, txOpt);
            signatureBase64 = signed.signatureBase64;
            keyId = signed.keyId;
          }

          const ledgerEntry = await appendLedgerEntrySafely(db, {
            organizationId: scope.organizationId,
            eventType: 'data.snapshot_frozen',
            targetCollection: 'latticeFrozenSnapshots',
            targetRecordId: snapshotUid,
            actor: scope.actor,
            payload: {
              snapshotUid,
              sourceCollection,
              tier,
              recordCount: sanitizedRecords.length,
              payloadHash,
            },
            metadata: { retentionDays, ...(coldStorageUri ? { coldStorageUri } : {}) },
          }, { scope: 'dxosDataGov:freezeSnapshot', ...txOpt });

          const createdRow = await snapshotRepo.create({
            values: {
              organizationId: scope.organizationId,
              snapshotUid,
              tier,
              sourceCollection,
              filterSummary: sanitizedFilter || {},
              recordCount: sanitizedRecords.length,
              payloadJson: sanitizedRecords,
              payloadHash,
              ledgerEntrySeq: ledgerEntry?.seq ?? null,
              signatureBase64,
              keyId,
              frozenAt,
              frozenBy: scope.actor.username,
              retentionDays,
              expiresAt,
              coldStorageUri,
              status: 'sealed',
              active: true,
            },
            ...txOpt,
          });

          let edgesRecorded = 0;
          for (const rec of sanitizedRecords.slice(0, MAX_LINEAGE_EDGES_PER_FREEZE)) {
            if (rec?.id == null) continue;
            const edge = await recordLineageEdge(db, {
              organizationId: scope.organizationId,
              sourceCollection,
              sourceRecordId: String(rec.id),
              targetCollection: 'latticeFrozenSnapshots',
              targetRecordId: snapshotUid,
              relationType: 'frozen_into',
              actorName: scope.actor.username,
              metadataJson: { tier, payloadHash },
              observedAt: frozenAt,
              ...txOpt,
            });
            if (edge) edgesRecorded += 1;
          }

          return { created: createdRow, lineageEdgesRecorded: edgesRecorded };
        }, scope.organizationId);

        ctx.body = {
          ...serializeSnapshotSummary(created, { includePayload: false }),
          lineageEdgesRecorded,
        };
        if (next) return next();
      },

      listSnapshots: async (ctx, next) => {
        if ((ctx.method || 'GET') !== 'GET') ctx.throw(405);
        const params = readParams(ctx);
        const scope = await resolveDataGovScope(db, ctx, params.organizationId);
        await assertReadPrivilege(db, ctx, scope, ['latticeFrozenSnapshots']);

        const page = Math.max(1, Math.min(10000, Math.floor(Number(params.page) || 1)));
        const pageSize = Math.max(1, Math.min(100, Math.floor(Number(params.pageSize ?? params.limit) || 20)));
        const repo = getRepo(db, 'latticeFrozenSnapshots');
        if (!repo || typeof repo.find !== 'function') {
          ctx.body = { organizationId: scope.organizationId, total: 0, page, pageSize, items: [] };
          if (next) return next();
          return;
        }

        const filter = { organizationId: scope.organizationId };
        const srcCol = typeof params.sourceCollection === 'string' && params.sourceCollection.trim() ? params.sourceCollection.trim() : null;
        const tier = typeof params.tier === 'string' && params.tier.trim() ? params.tier.trim() : null;
        if (srcCol) filter.sourceCollection = srcCol;
        if (tier) filter.tier = tier;

        const { rows, total } = await runDataGovDb(db, scope.organizationId, async (transaction) => {
          const txOpt = transaction ? { transaction } : {};
          const foundRows = (await repo.find({
            filter,
            sort: ['-frozenAt', '-id'],
            offset: (page - 1) * pageSize,
            limit: pageSize,
            ...txOpt,
          })) || [];
          const foundTotal = typeof repo.count === 'function' ? await repo.count({ filter, ...txOpt }) : null;
          return { rows: foundRows, total: foundTotal };
        });
        const scoped = rows.filter((r) => (
          val(r, 'organizationId') === scope.organizationId
          && (!srcCol || val(r, 'sourceCollection') === srcCol)
          && (!tier || val(r, 'tier') === tier)
        ));
        const finalTotal = total !== null ? total : scoped.length;

        ctx.body = {
          organizationId: scope.organizationId,
          total: finalTotal,
          page,
          pageSize,
          items: scoped.map((r) => serializeSnapshotSummary(r, { includePayload: false })),
        };
        if (next) return next();
      },

      getSnapshot: async (ctx, next) => {
        if ((ctx.method || 'GET') !== 'GET') ctx.throw(405);
        const params = readParams(ctx);
        const scope = await resolveDataGovScope(db, ctx, params.organizationId);
        await assertReadPrivilege(db, ctx, scope, ['latticeFrozenSnapshots']);

        const snapshotUid = params.snapshotUid != null ? String(params.snapshotUid).trim() : '';
        const rawId = params.id ?? params.filterByTk;
        const numericId = rawId != null && /^[1-9]\d*$/.test(String(rawId)) ? Number(rawId) : null;
        if (!snapshotUid && numericId === null) {
          throw failGov('SNAPSHOT_ID_REQUIRED', 400, 'snapshotUid or valid numeric id is required.');
        }

        const repo = getRepo(db, 'latticeFrozenSnapshots');
        if (!repo || typeof repo.findOne !== 'function') {
          throw failGov('DATA_GOV_SNAPSHOT_REPO_UNAVAILABLE', 503, 'latticeFrozenSnapshots repository is unavailable.');
        }

        const { row, signatureVerified } = await runDataGovDb(db, scope.organizationId, async (transaction) => {
          const txOpt = transaction ? { transaction } : {};
          const found = await repo.findOne({
            filter: snapshotUid
              ? { organizationId: scope.organizationId, snapshotUid }
              : { organizationId: scope.organizationId, id: numericId },
            ...txOpt,
          });
          if (!found || val(found, 'organizationId') !== scope.organizationId) {
            throw failGov('SNAPSHOT_NOT_FOUND', 404, 'Frozen snapshot not found in organization scope.');
          }
          const payload = val(found, 'payloadJson') ?? [];
          let sigVerified = null;
          const sigVal = val(found, 'signatureBase64');
          const keyIdVal = val(found, 'keyId');
          if (sigVal && getRepo(db, 'latticePkiKeys')) {
            const sigCheck = await verifyPayloadSignature(db, scope.organizationId, payload, sigVal, keyIdVal, txOpt);
            sigVerified = sigCheck.valid;
          }
          return { row: found, signatureVerified: sigVerified };
        });

        const payloadJson = val(row, 'payloadJson') ?? [];
        const storedHash = String(val(row, 'payloadHash') || '');
        const recomputedHash = sha256Hex(canonicalJson(payloadJson));
        const hashVerified = Boolean(storedHash && recomputedHash === storedHash);

        ctx.body = {
          ...serializeSnapshotSummary(row, { includePayload: true }),
          recomputedHash,
          hashVerified,
          signatureVerified,
        };
        if (next) return next();
      },

      lineageTrace: handleLineageTrace,
      lineage: handleLineageTrace,

      quarantineList: handleQuarantineList,
      listQuarantine: handleQuarantineList,

      quarantineResolve: handleQuarantineResolve,
      resolveQuarantine: handleQuarantineResolve,

      computeMkt: async (ctx, next) => {
        if (ctx.method && !['GET', 'POST'].includes(ctx.method)) ctx.throw(405);
        const params = readParams(ctx);
        const scope = await resolveDataGovScope(db, ctx, params.organizationId);
        await assertReadPrivilege(db, ctx, scope, ['latticeTelemetryPoints', 'latticeAssets']);

        const rawDeltaH = params.deltaH_kJ_mol;
        const deltaH_kJ_mol = rawDeltaH === undefined || rawDeltaH === null || (typeof rawDeltaH === 'string' && rawDeltaH.trim() === '')
          ? DEFAULT_DELTA_H_KJ_MOL
          : rawDeltaH;
        const rawMaxAllowed = params.maxAllowedC;
        const maxAllowedC = rawMaxAllowed === undefined || rawMaxAllowed === null || (typeof rawMaxAllowed === 'string' && rawMaxAllowed.trim() === '')
          ? null
          : rawMaxAllowed;

        let samplesC = params.samplesC;
        const hasSamplesParam = samplesC !== undefined && !(typeof samplesC === 'string' && samplesC.trim() === '');
        if (typeof samplesC === 'string') {
          const trimmed = samplesC.trim();
          if (trimmed.startsWith('[')) {
            try {
              samplesC = JSON.parse(trimmed);
            } catch {
              throw failGov('MKT_INVALID_SAMPLE', 400, 'Malformed samplesC JSON array.');
            }
          } else if (trimmed) {
            samplesC = trimmed.split(',').map((s) => s.trim());
          }
        }

        if (hasSamplesParam) {
          const result = computeMeanKineticTemperature(samplesC, { deltaH_kJ_mol, maxAllowedC });
          ctx.body = {
            organizationId: scope.organizationId,
            source: 'inline',
            ...result,
          };
          if (next) return next();
          return;
        }

        let assetEntityId = typeof params.assetEntityId === 'string' ? params.assetEntityId.trim() : '';
        let pendingAssetId = null;
        if (assetEntityId) {
          const urnMatch = URN_RE.exec(assetEntityId);
          if (urnMatch && urnMatch[1] !== scope.organizationId) {
            throw failGov('DXOS_CROSS_ORG_FORBIDDEN', 403, 'assetEntityId belongs to another organization.');
          }
        } else if (params.assetId != null && String(params.assetId).trim() !== '') {
          if (!/^[1-9]\d{0,18}$/.test(String(params.assetId))) {
            throw failGov('MKT_ASSET_ID_INVALID', 400, 'Invalid assetId.');
          }
          pendingAssetId = Number(params.assetId);
        }

        const metricName = String(params.metricName || 'temperature').trim();
        let startMs = null;
        if (params.startAt !== undefined && params.startAt !== null && String(params.startAt).trim() !== '') {
          startMs = Date.parse(String(params.startAt));
          if (!Number.isFinite(startMs)) throw failGov('MKT_TIME_RANGE_INVALID', 400, 'Invalid startAt timestamp.');
        }
        let endMs = null;
        if (params.endAt !== undefined && params.endAt !== null && String(params.endAt).trim() !== '') {
          endMs = Date.parse(String(params.endAt));
          if (!Number.isFinite(endMs)) throw failGov('MKT_TIME_RANGE_INVALID', 400, 'Invalid endAt timestamp.');
        }
        if (startMs !== null && endMs !== null && startMs > endMs) {
          throw failGov('MKT_TIME_RANGE_INVALID', 400, 'startAt must not be after endAt.');
        }

        const tsRepo = getRepo(db, 'latticeTelemetryPoints');
        if (!tsRepo || typeof tsRepo.find !== 'function') {
          throw failGov('TELEMETRY_REPO_UNAVAILABLE', 503, 'latticeTelemetryPoints repository is unavailable.');
        }

        const observedCond = {};
        if (startMs !== null) observedCond.$gte = new Date(startMs);
        if (endMs !== null) observedCond.$lte = new Date(endMs);
        const rows = await runDataGovDb(db, scope.organizationId, async (transaction) => {
          const txOpt = transaction ? { transaction } : {};
          if (pendingAssetId !== null) {
            const assetRepo = getRepo(db, 'latticeAssets');
            if (assetRepo && typeof assetRepo.findOne === 'function') {
              const asset = await assetRepo.findOne({ filter: { id: pendingAssetId, organizationId: scope.organizationId }, ...txOpt });
              if (!asset || val(asset, 'organizationId') !== scope.organizationId) {
                throw failGov('MKT_ASSET_NOT_FOUND', 404, 'Asset not found in organization scope.');
              }
            }
            assetEntityId = `urn:ngsi-ld:Asset:${scope.organizationId}:native:${pendingAssetId}`;
          }
          const filter = {
            ...(assetEntityId ? { assetEntityId } : {}),
            metricName,
            ...(Object.keys(observedCond).length ? { observedAt: observedCond } : {}),
          };
          return scanOrgRows(tsRepo, scope.organizationId, filter, MAX_SCAN, transaction);
        });
        const extracted = [];
        for (const r of rows) {
          if (assetEntityId && val(r, 'assetEntityId') !== assetEntityId) continue;
          if (val(r, 'metricName') && val(r, 'metricName') !== metricName) continue;
          const obsRaw = val(r, 'observedAt') || val(r, 'createdAt');
          const obsMs = obsRaw instanceof Date ? obsRaw.getTime() : Date.parse(String(obsRaw || ''));
          if (startMs !== null && (!Number.isFinite(obsMs) || obsMs < startMs)) continue;
          if (endMs !== null && (!Number.isFinite(obsMs) || obsMs > endMs)) continue;
          const num = parseFiniteNumberStrict(val(r, 'numericValue'));
          if (num === null || num <= ABSOLUTE_ZERO_C) continue;
          extracted.push(num);
        }

        if (extracted.length === 0) {
          throw failGov('MKT_NO_TELEMETRY_SAMPLES', 404, 'No valid telemetry temperature samples found for MKT calculation.');
        }

        const result = computeMeanKineticTemperature(extracted, { deltaH_kJ_mol, maxAllowedC });
        ctx.body = {
          organizationId: scope.organizationId,
          source: 'telemetry',
          assetEntityId: assetEntityId || null,
          metricName,
          ...result,
        };
        if (next) return next();
      },
    },
  });

  app.acl?.allow?.(
    'dxosDataGov',
    [
      'tierSummary',
      'freezeSnapshot',
      'listSnapshots',
      'getSnapshot',
      'lineageTrace',
      'lineage',
      'quarantineList',
      'listQuarantine',
      'quarantineResolve',
      'resolveQuarantine',
      'computeMkt',
    ],
    'loggedIn',
  );
}

module.exports = {
  FREEZABLE_COLLECTIONS,
  DATA_GOV_PROTECTED_RESOURCES,
  computeMeanKineticTemperature,
  recordLineageEdge,
  captureQuarantineRecord,
  registerDataGovernanceHooks,
  registerDataGovernance,
};
