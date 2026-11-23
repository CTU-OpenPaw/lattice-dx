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
const path = require('node:path');

const ORG_ID_RE = /^[a-zA-Z0-9_-]{1,80}$/;
const URN_RE = /^urn:ngsi-ld:Asset:([a-zA-Z0-9_-]{1,80}):native:([1-9]\d{0,18})$/;
const ENTITY_ID_RE = /^[a-zA-Z0-9:._-]{1,255}$/;
const REPORTED_KEY_RE = /^[a-zA-Z0-9_.-]{1,64}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const TWIN_COMMAND_STATUSES = new Set(['synced', 'pending_hitl', 'dispatched', 'acked', 'failed']);
const HITL_TEMP_THRESHOLD_C = 2.0;

const ALLOWED_DEFROST_MODES = new Set(['auto', 'manual', 'off']);
const ALLOWED_FAN_MODES = new Set(['auto', 'high', 'low', 'eco']);
const ALLOWED_DOOR_LOCKS = new Set(['locked', 'unlocked']);
const ALLOWED_DESIRED_KEYS = new Set([
  'targetTempC',
  'maxTempC',
  'minTempC',
  'defrostMode',
  'fanMode',
  'doorLock',
  'reportingIntervalSec',
]);

const DEFAULT_DOWNLINK_ALLOWLIST = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  'nodered',
  'latticedx-nodered',
  'nodered.local',
]);

const LEDGER_SECURITY_INVARIANTS = new Set([
  'PKI_MASTER_KEY_MISSING',
  'PKI_KEY_INACTIVE',
  'PKI_CIPHERTEXT_INVALID',
  'LEDGER_IMMUTABLE',
  'NATIVE_ORGANIZATION_MISMATCH',
  'NATIVE_TENANT_REQUIRED',
]);

const val = (row, key) => (typeof row?.get === 'function' ? row.get(key) : row?.[key]);

function failTwin(code, status = 400, message = code) {
  return Object.assign(new Error(message), { code, status });
}

function parseFinite(raw) {
  if (raw === null || raw === undefined || typeof raw === 'boolean' || typeof raw === 'object') {
    return null;
  }
  if (typeof raw === 'string' && raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function toIsoOrNull(raw) {
  if (!raw) return null;
  if (raw instanceof Date) return Number.isFinite(raw.getTime()) ? raw.toISOString() : null;
  const ts = Date.parse(String(raw));
  return Number.isFinite(ts) ? new Date(ts).toISOString() : String(raw);
}

function isPlainObject(raw) {
  return Boolean(raw) && typeof raw === 'object' && !Array.isArray(raw) && !(raw instanceof Date);
}

function loadFoundationModule(subpath) {
  const inDist = __dirname.includes(`${path.sep}dist${path.sep}`);
  const candidates = inDist
    ? [
        `../../../plugin-lattice-foundation/dist/server/${subpath}`,
        `../../../plugin-lattice-foundation/src/server/${subpath}`,
      ]
    : [
        `../../../plugin-lattice-foundation/src/server/${subpath}`,
        `../../../plugin-lattice-foundation/dist/server/${subpath}`,
      ];
  for (const modPath of candidates) {
    try {
      return require(modPath);
    } catch (err) {
      if (err?.code !== 'MODULE_NOT_FOUND') throw err;
    }
  }
  return null;
}

function isSecurityInvariant(err, pkiLedger) {
  if (typeof pkiLedger?.isLedgerSecurityInvariant === 'function') {
    return pkiLedger.isLedgerSecurityInvariant(err);
  }
  return Boolean(err && typeof err.code === 'string' && LEDGER_SECURITY_INVARIANTS.has(err.code));
}

async function recordTwinLedgerSafely(db, entryArgs, { transaction = null } = {}) {
  const pki = loadFoundationModule('pki-ledger');
  if (!pki || typeof pki.appendLedgerEntrySafely !== 'function') return null;
  return pki.appendLedgerEntrySafely(db, entryArgs, {
    scope: 'dxos:digital-twin',
    ...(transaction ? { transaction } : {}),
  });
}

async function recordTwinLineageSafely(db, {
  organizationId,
  assetId,
  shadowId,
  assetEntityId,
  commandId,
  desiredPatch,
  actorName,
  observedAt,
  transaction = null,
}) {
  const sourceCollection = assetId != null ? 'latticeAssets' : 'latticeTwinShadows';
  const sourceRecordId = String(assetId != null ? assetId : (shadowId ?? assetEntityId));
  const targetCollection = 'latticeTwinShadows';
  const targetRecordId = String(shadowId ?? assetEntityId);
  const metadataJson = { commandId, assetEntityId, desiredPatch };

  const dataGov = loadFoundationModule('data-governance');
  if (dataGov && typeof dataGov.recordLineageEdge === 'function') {
    try {
      return await dataGov.recordLineageEdge(db, {
        organizationId,
        sourceCollection,
        sourceRecordId,
        targetCollection,
        targetRecordId,
        relationType: 'twin_command',
        actorName,
        metadataJson,
        observedAt,
        transaction,
      });
    } catch (err) {
      if (isSecurityInvariant(err)) throw err;
      return null;
    }
  }

  const lineageRepo = db?.getRepository?.('latticeDataLineage');
  if (!lineageRepo || typeof lineageRepo.create !== 'function') return null;
  const txOpt = transaction ? { transaction } : {};
  const edgeUid = `lin-${createHash('sha256')
    .update(`${organizationId}|${sourceCollection}|${sourceRecordId}|${targetCollection}|${targetRecordId}|twin_command`)
    .digest('hex')
    .slice(0, 32)}`;
  try {
    if (typeof lineageRepo.findOne === 'function') {
      const existing = await lineageRepo.findOne({ filter: { organizationId, edgeUid }, ...txOpt });
      if (existing) return existing;
    }
    return await lineageRepo.create({
      values: {
        organizationId,
        edgeUid,
        sourceCollection,
        sourceRecordId,
        targetCollection,
        targetRecordId,
        relationType: 'twin_command',
        actorName,
        metadataJson,
        observedAt,
      },
      ...txOpt,
    });
  } catch (err) {
    if (isSecurityInvariant(err)) throw err;
    return null;
  }
}

/**
 * Compares desired setpoint keys against reported device state.
 * Returns { inSync, fields: { [key]: { desired, reported, numericDelta } } }.
 */
function computeShadowDelta(desired = {}, reported = {}) {
  const desObj = isPlainObject(desired) ? desired : {};
  const repObj = isPlainObject(reported) ? reported : {};
  const fields = {};
  let inSync = true;

  for (const key of Object.keys(desObj).sort()) {
    const desVal = desObj[key];
    const hasRep = Object.hasOwn(repObj, key) && repObj[key] !== undefined;
    const repVal = hasRep ? repObj[key] : null;
    const matched = hasRep && (desVal === repVal || (Object.is(desVal, -0) && Object.is(repVal, 0)));
    if (matched) continue;

    inSync = false;
    const numericDelta = typeof desVal === 'number' && Number.isFinite(desVal) && typeof repVal === 'number' && Number.isFinite(repVal)
      ? Number((desVal - repVal).toFixed(4))
      : null;
    fields[key] = {
      desired: desVal,
      reported: repVal,
      numericDelta: Object.is(numericDelta, -0) ? 0 : numericDelta,
    };
  }

  return { inSync, fields };
}

/**
 * Validates and normalizes a desired twin setpoint patch against the safety allowlist.
 */
function validateDesiredPatch(rawPatch) {
  if (!isPlainObject(rawPatch)) {
    throw failTwin('TWIN_DESIRED_INVALID', 400, 'desiredPatch phải là một đối tượng JSON hợp lệ.');
  }
  const entries = Object.entries(rawPatch);
  if (!entries.length) {
    throw failTwin('TWIN_DESIRED_INVALID', 400, 'desiredPatch không được để trống.');
  }

  const clean = {};
  for (const [key, rawVal] of entries) {
    if (FORBIDDEN_KEYS.has(key) || !ALLOWED_DESIRED_KEYS.has(key)) {
      throw failTwin('TWIN_FIELD_FORBIDDEN', 400, `Trường điều khiển twin "${key}" không được phép.`);
    }

    if (key === 'targetTempC' || key === 'maxTempC' || key === 'minTempC') {
      const num = parseFinite(rawVal);
      if (num === null || num < -80 || num > 120) {
        throw failTwin('TWIN_DESIRED_INVALID', 400, `${key} phải là số hữu hạn trong khoảng [-80, 120] °C.`);
      }
      clean[key] = Number(num.toFixed(3));
    } else if (key === 'defrostMode') {
      const mode = typeof rawVal === 'string' ? rawVal.trim().toLowerCase() : '';
      if (!ALLOWED_DEFROST_MODES.has(mode)) {
        throw failTwin('TWIN_DESIRED_INVALID', 400, 'defrostMode phải là auto, manual hoặc off.');
      }
      clean[key] = mode;
    } else if (key === 'fanMode') {
      const mode = typeof rawVal === 'string' ? rawVal.trim().toLowerCase() : '';
      if (!ALLOWED_FAN_MODES.has(mode)) {
        throw failTwin('TWIN_DESIRED_INVALID', 400, 'fanMode phải là auto, high, low hoặc eco.');
      }
      clean[key] = mode;
    } else if (key === 'doorLock') {
      const mode = typeof rawVal === 'string' ? rawVal.trim().toLowerCase() : '';
      if (!ALLOWED_DOOR_LOCKS.has(mode)) {
        throw failTwin('TWIN_DESIRED_INVALID', 400, 'doorLock phải là locked hoặc unlocked.');
      }
      clean[key] = mode;
    } else if (key === 'reportingIntervalSec') {
      const sec = parseFinite(rawVal);
      if (sec === null || !Number.isInteger(sec) || sec < 5 || sec > 3600) {
        throw failTwin('TWIN_DESIRED_INVALID', 400, 'reportingIntervalSec phải là số nguyên trong [5, 3600].');
      }
      clean[key] = sec;
    }
  }

  if (clean.minTempC !== undefined && clean.maxTempC !== undefined && clean.minTempC > clean.maxTempC) {
    throw failTwin('TWIN_DESIRED_INVALID', 400, 'minTempC không được lớn hơn maxTempC.');
  }

  return clean;
}

/**
 * Resolves and tenant-verifies target asset identity from assetId / assetEntityId.
 */
async function resolveAssetEntity(db, { organizationId, assetId = null, assetEntityId = '' } = {}) {
  const org = typeof organizationId === 'string' ? organizationId.trim() : '';
  if (!ORG_ID_RE.test(org)) {
    throw failTwin('TWIN_ORG_REQUIRED', 400, 'Cần organizationId hợp lệ cho digital twin.');
  }

  let resolvedAssetId = null;
  if (assetId !== undefined && assetId !== null && assetId !== '') {
    if (!/^[1-9]\d{0,18}$/.test(String(assetId))) {
      throw failTwin('DXOS_INVALID_ASSET_ID', 400, 'assetId không hợp lệ.');
    }
    resolvedAssetId = Number(assetId);
  }

  let entityId = typeof assetEntityId === 'string' ? assetEntityId.trim() : '';
  if (entityId) {
    const urnMatch = URN_RE.exec(entityId);
    if (urnMatch) {
      if (urnMatch[1] !== org) {
        throw failTwin('DXOS_CROSS_ORG_FORBIDDEN', 403, 'assetEntityId không thuộc phạm vi tổ chức.');
      }
      const urnAssetId = Number(urnMatch[2]);
      if (resolvedAssetId != null && urnAssetId !== resolvedAssetId) {
        throw failTwin('TWIN_ASSET_MISMATCH', 400, 'assetId và assetEntityId không khớp.');
      }
      if (resolvedAssetId == null) resolvedAssetId = urnAssetId;
    } else if (!ENTITY_ID_RE.test(entityId)) {
      throw failTwin('TWIN_ENTITY_INVALID', 400, 'assetEntityId không hợp lệ.');
    }
  } else if (resolvedAssetId != null) {
    entityId = `urn:ngsi-ld:Asset:${org}:native:${resolvedAssetId}`;
  } else {
    throw failTwin('TWIN_ENTITY_REQUIRED', 400, 'Cần assetId hoặc assetEntityId.');
  }

  let assetRow = null;
  const assetRepo = db?.getRepository?.('latticeAssets');
  if (resolvedAssetId != null && assetRepo && typeof assetRepo.findOne === 'function') {
    assetRow = await assetRepo.findOne({ filter: { id: resolvedAssetId, organizationId: org } });
    if (!assetRow || (val(assetRow, 'organizationId') && val(assetRow, 'organizationId') !== org)) {
      throw failTwin('DXOS_ASSET_NOT_FOUND', 404, 'Không tìm thấy tài sản trong phạm vi tổ chức.');
    }
  }

  return {
    organizationId: org,
    assetId: resolvedAssetId,
    assetEntityId: entityId,
    asset: assetRow,
  };
}

function validateDownlinkUrl(rawUrl, env = process.env) {
  if (!rawUrl || typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw failTwin('TWIN_DOWNLINK_URL_FORBIDDEN', 400, 'URL downlink Node-RED không hợp lệ.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw failTwin('TWIN_DOWNLINK_URL_FORBIDDEN', 400, 'URL downlink không hợp lệ hoặc chứa thông tin xác thực.');
  }

  const host = parsed.hostname.toLowerCase();
  const bareHost = host.replace(/^\[|\]$/g, '');
  const extraHosts = String(env?.DX_NODERED_HOST_ALLOWLIST || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const allowed = DEFAULT_DOWNLINK_ALLOWLIST.has(bareHost) || extraHosts.includes(bareHost);
  if (!allowed) {
    throw failTwin('TWIN_DOWNLINK_URL_FORBIDDEN', 400, 'Host downlink Node-RED không nằm trong danh sách cho phép.');
  }

  return parsed.toString();
}

function serializeShadow(row, defaults = {}) {
  const desired = isPlainObject(val(row, 'desiredJson')) ? val(row, 'desiredJson') : (defaults.desiredJson || {});
  const reported = isPlainObject(val(row, 'reportedJson')) ? val(row, 'reportedJson') : (defaults.reportedJson || {});
  const delta = isPlainObject(val(row, 'lastDeltaJson')) ? val(row, 'lastDeltaJson') : computeShadowDelta(desired, reported);
  const status = String(val(row, 'commandStatus') || defaults.commandStatus || 'synced');

  return {
    id: val(row, 'id') ?? defaults.id ?? null,
    organizationId: val(row, 'organizationId') || defaults.organizationId,
    assetId: val(row, 'assetId') ?? defaults.assetId ?? null,
    assetEntityId: val(row, 'assetEntityId') || defaults.assetEntityId,
    desiredJson: desired,
    reportedJson: reported,
    lastDeltaJson: delta,
    pendingCommandId: val(row, 'pendingCommandId') ?? null,
    commandStatus: TWIN_COMMAND_STATUSES.has(status) ? status : 'synced',
    lastDispatchedAt: toIsoOrNull(val(row, 'lastDispatchedAt')),
    lastAckedAt: toIsoOrNull(val(row, 'lastAckedAt')),
    lastReportedAt: toIsoOrNull(val(row, 'lastReportedAt')),
    version: Number(val(row, 'version') ?? defaults.version ?? 1),
    updatedBy: val(row, 'updatedBy') ?? null,
  };
}

async function runInTwinTx(db, organizationId, fn) {
  const execute = async (transaction) => {
    const isPostgres = typeof db?.sequelize?.getDialect === 'function' && db.sequelize.getDialect() === 'postgres';
    if (isPostgres && transaction) {
      const pgRls = loadFoundationModule('pg-rls');
      if (pgRls && typeof pgRls.setTransactionRlsOrg === 'function') {
        await pgRls.setTransactionRlsOrg(db, organizationId, transaction);
      }
    }
    return fn(transaction || null);
  };
  if (typeof db?.sequelize?.transaction === 'function') {
    return db.sequelize.transaction(execute);
  }
  return execute(null);
}

async function findShadowRow(shadowRepo, organizationId, assetEntityId, transaction = null) {
  if (!shadowRepo) return null;
  const txOpt = transaction ? { transaction } : {};
  if (typeof shadowRepo.findOne === 'function') {
    const row = await shadowRepo.findOne({ filter: { organizationId, assetEntityId }, ...txOpt });
    if (row && val(row, 'organizationId') && val(row, 'organizationId') !== organizationId) return null;
    return row || null;
  }
  if (typeof shadowRepo.find === 'function') {
    const rows = (await shadowRepo.find({ filter: { organizationId, assetEntityId }, limit: 1, ...txOpt })) || [];
    const row = rows[0] || null;
    if (row && val(row, 'organizationId') && val(row, 'organizationId') !== organizationId) return null;
    return row;
  }
  return null;
}

async function updateShadowRow(repo, row, patch, { organizationId = null, transaction = null } = {}) {
  const txOpt = transaction ? { transaction } : {};
  if (typeof row?.update === 'function') {
    await row.update(patch, txOpt);
    return row;
  }
  const id = val(row, 'id');
  if (repo && typeof repo.update === 'function' && id != null) {
    const res = await repo.update({
      filterByTk: id,
      ...(organizationId ? { filter: { organizationId } } : {}),
      values: patch,
      ...txOpt,
    });
    if (Array.isArray(res) && res[0]) return res[0];
  }
  return Object.assign(row || {}, patch);
}

/**
 * Fetches current Digital Twin shadow state for an asset within organization scope.
 */
async function getTwinShadow(db, opts = {}) {
  const { organizationId, assetId, assetEntityId, asset } = await resolveAssetEntity(db, opts);
  const shadowRepo = db?.getRepository?.('latticeTwinShadows');
  const existing = await findShadowRow(shadowRepo, organizationId, assetEntityId);
  const shadow = existing
    ? serializeShadow(existing)
    : serializeShadow(null, {
        id: null,
        organizationId,
        assetId,
        assetEntityId,
        desiredJson: {},
        reportedJson: {},
        lastDeltaJson: { inSync: true, fields: {} },
        commandStatus: 'synced',
        version: 0,
      });

  return {
    shadow,
    asset: asset
      ? {
          id: val(asset, 'id'),
          code: val(asset, 'code'),
          name: val(asset, 'name'),
          status: val(asset, 'status'),
          organizationId: val(asset, 'organizationId'),
        }
      : null,
  };
}

/**
 * Applies or HITL-gates a desired twin setpoint change and optionally dispatches MQTT downlink via Node-RED.
 */
async function requestDesiredSetpoint(db, opts = {}) {
  const desiredPatch = validateDesiredPatch(opts.desiredPatch ?? opts.desired);
  const { organizationId, assetId, assetEntityId } = await resolveAssetEntity(db, opts);
  const shadowRepo = db?.getRepository?.('latticeTwinShadows');
  if (!shadowRepo || typeof shadowRepo.create !== 'function') {
    throw failTwin('TWIN_REPO_UNAVAILABLE', 503, 'Kho Digital Twin shadow chưa sẵn sàng.');
  }

  const actor = opts.actor || null;
  const currentUser = opts.currentUser || null;
  const requesterUserId = Number(actor?.userId || val(currentUser, 'id') || 1);
  const requesterUsername = String(
    actor?.username || val(currentUser, 'username') || `user-${requesterUserId}`,
  ).slice(0, 120);

  const txResult = await runInTwinTx(db, organizationId, async (transaction) => {
    const txOpt = transaction ? { transaction } : {};
    const shadowRow = await findShadowRow(shadowRepo, organizationId, assetEntityId, transaction);
    const currentDesired = shadowRow && isPlainObject(val(shadowRow, 'desiredJson')) ? { ...val(shadowRow, 'desiredJson') } : {};
    const currentReported = shadowRow && isPlainObject(val(shadowRow, 'reportedJson')) ? { ...val(shadowRow, 'reportedJson') } : {};
    const curVersion = shadowRow ? (Number(val(shadowRow, 'version')) || 1) : 0;

    const nextDesired = { ...currentDesired, ...desiredPatch };
    if (
      nextDesired.minTempC !== undefined
      && nextDesired.maxTempC !== undefined
      && nextDesired.minTempC > nextDesired.maxTempC
    ) {
      throw failTwin('TWIN_DESIRED_INVALID', 400, 'minTempC không được lớn hơn maxTempC.');
    }

    const baselineTemp = parseFinite(currentDesired.targetTempC ?? currentReported.targetTempC);
    const deltaTempC = desiredPatch.targetTempC !== undefined && baselineTemp !== null
      ? Number((desiredPatch.targetTempC - baselineTemp).toFixed(2))
      : null;

    if (
      desiredPatch.targetTempC !== undefined
      && baselineTemp !== null
      && Math.abs(desiredPatch.targetTempC - baselineTemp) > HITL_TEMP_THRESHOLD_C
      && opts.hitlApproved !== true
    ) {
      const rawShadowId = val(shadowRow, 'id');
      const shadowId = rawShadowId != null && /^[1-9]\d*$/.test(String(rawShadowId)) ? Number(rawShadowId) : null;
      let approvalId = null;
      const queueRepo = db?.getRepository?.('latticeAiApprovalQueue');
      if (queueRepo && typeof queueRepo.create === 'function') {
        const approvalRow = await queueRepo.create({
          values: {
            organizationId,
            requesterUserId,
            requesterUsername,
            aiEmployee: 'dxos-ops',
            toolName: 'dxos_twin_set_desired',
            targetCollection: 'latticeTwinShadows',
            targetRecordId: shadowId,
            operation: 'update',
            proposedArgs: { assetEntityId, desiredPatch, baselineTemp },
            diffPreview: {
              targetTempC: {
                before: baselineTemp,
                after: desiredPatch.targetTempC,
                delta: deltaTempC,
              },
            },
            riskLevel: 'high',
            status: 'pending',
            expiresAt: new Date(Date.now() + 24 * 3600_000),
          },
          ...txOpt,
        });
        approvalId = val(approvalRow, 'id') ?? null;
      }

      const updated = await updateShadowRow(
        shadowRepo,
        shadowRow,
        {
          commandStatus: 'pending_hitl',
          version: curVersion + 1,
          updatedBy: requesterUsername,
        },
        { organizationId, transaction },
      );

      await recordTwinLedgerSafely(
        db,
        {
          organizationId,
          eventType: 'iot.twin_hitl_required',
          targetCollection: 'latticeTwinShadows',
          targetRecordId: String(shadowId ?? assetEntityId),
          actor: { userId: String(requesterUserId), username: requesterUsername },
          payload: { assetEntityId, desiredPatch, baselineTemp, deltaTempC, approvalId },
        },
        { transaction },
      );

      return {
        gatedByHitl: true,
        deltaTempC,
        approvalId,
        shadow: serializeShadow(updated),
      };
    }

    // Validate downlink URL upfront before mutating shadow or invoking fetchImpl
    const rawDownlinkUrl = opts.downlinkUrl !== undefined ? opts.downlinkUrl : process.env.DX_NODERED_COMMAND_URL;
    const validatedDownlinkUrl = validateDownlinkUrl(rawDownlinkUrl, opts.env || process.env);

    const delta = computeShadowDelta(nextDesired, currentReported);
    const commandId = `cmd-${randomBytes(8).toString('hex')}`;
    const now = new Date();

    const updated = shadowRow
      ? await updateShadowRow(
          shadowRepo,
          shadowRow,
          {
            ...(assetId != null ? { assetId } : {}),
            desiredJson: nextDesired,
            lastDeltaJson: delta,
            pendingCommandId: commandId,
            commandStatus: 'dispatched',
            lastDispatchedAt: now,
            version: curVersion + 1,
            updatedBy: requesterUsername,
          },
          { organizationId, transaction },
        )
      : await shadowRepo.create({
          values: {
            organizationId,
            ...(assetId != null ? { assetId } : {}),
            assetEntityId,
            desiredJson: nextDesired,
            reportedJson: {},
            lastDeltaJson: delta,
            pendingCommandId: commandId,
            commandStatus: 'dispatched',
            lastDispatchedAt: now,
            version: 1,
            updatedBy: requesterUsername,
          },
          ...txOpt,
        });

    const rawSavedId = val(updated, 'id');
    const shadowId = rawSavedId != null && /^[1-9]\d*$/.test(String(rawSavedId)) ? Number(rawSavedId) : null;

    await recordTwinLedgerSafely(
      db,
      {
        organizationId,
        eventType: 'iot.twin_desired_dispatched',
        targetCollection: 'latticeTwinShadows',
        targetRecordId: String(shadowId ?? assetEntityId),
        actor: { userId: String(requesterUserId), username: requesterUsername },
        payload: {
          assetEntityId,
          commandId,
          desiredPatch,
          downlinkConfigured: Boolean(validatedDownlinkUrl),
        },
      },
      { transaction },
    );

    await recordTwinLineageSafely(db, {
      organizationId,
      assetId,
      shadowId,
      assetEntityId,
      commandId,
      desiredPatch,
      actorName: requesterUsername,
      observedAt: now,
      transaction,
    });

    return {
      gatedByHitl: false,
      commandId,
      now,
      nextDesired,
      validatedDownlinkUrl,
      shadow: serializeShadow(updated),
    };
  });

  if (txResult.gatedByHitl) {
    return txResult;
  }

  let downlinkDispatched = false;
  if (txResult.validatedDownlinkUrl) {
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    const edgeToken = String(opts.ingestToken !== undefined ? opts.ingestToken : (process.env.DX_IIOT_INGEST_TOKEN || '')).trim();
    if (typeof fetchImpl === 'function') {
      try {
        const res = await fetchImpl(txResult.validatedDownlinkUrl, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(3000),
          headers: {
            'Content-Type': 'application/json',
            ...(edgeToken ? { 'X-Lattice-Edge-Token': edgeToken } : {}),
          },
          body: JSON.stringify({
            organizationId,
            ...(assetId != null ? { assetId } : {}),
            assetEntityId,
            commandId: txResult.commandId,
            desired: txResult.nextDesired,
            desiredPatch,
            issuedAt: txResult.now.toISOString(),
          }),
        });
        if (res?.ok) {
          downlinkDispatched = true;
        } else {
          await res?.body?.cancel?.();
        }
      } catch {
        downlinkDispatched = false;
      }
    }
  }

  return {
    gatedByHitl: false,
    commandId: txResult.commandId,
    downlinkDispatched,
    shadow: txResult.shadow,
  };
}

function validateReportedPatch(rawPatch) {
  if (rawPatch === undefined || rawPatch === null) return {};
  if (!isPlainObject(rawPatch)) {
    throw failTwin('TWIN_REPORTED_INVALID', 400, 'reportedPatch phải là một đối tượng JSON hợp lệ.');
  }
  const clean = {};
  for (const [key, rawVal] of Object.entries(rawPatch)) {
    if (FORBIDDEN_KEYS.has(key) || !REPORTED_KEY_RE.test(key)) {
      throw failTwin('TWIN_REPORTED_INVALID', 400, `Trường reportedPatch "${key}" không hợp lệ.`);
    }
    if (typeof rawVal === 'number') {
      if (!Number.isFinite(rawVal)) {
        throw failTwin('TWIN_REPORTED_INVALID', 400, `Giá trị số "${key}" phải hữu hạn.`);
      }
      clean[key] = rawVal;
    } else if (typeof rawVal === 'string') {
      const trimmed = rawVal.trim();
      if (!trimmed || trimmed.length > 128) {
        throw failTwin('TWIN_REPORTED_INVALID', 400, `Giá trị chuỗi "${key}" không hợp lệ.`);
      }
      clean[key] = trimmed;
    } else if (typeof rawVal === 'boolean') {
      clean[key] = rawVal;
    } else {
      throw failTwin('TWIN_REPORTED_INVALID', 400, `Kiểu dữ liệu của "${key}" không được hỗ trợ.`);
    }
  }
  return clean;
}

/**
 * Processes an edge device acknowledgment and reported state update for a Digital Twin shadow.
 */
async function ackCommandFromEdge(db, opts = {}) {
  const { organizationId, assetId, assetEntityId } = await resolveAssetEntity(db, opts);
  const ackStatus = opts.ackStatus === undefined || opts.ackStatus === null || opts.ackStatus === ''
    ? 'acked'
    : String(opts.ackStatus).trim().toLowerCase();
  if (ackStatus !== 'acked' && ackStatus !== 'failed') {
    throw failTwin('TWIN_ACK_STATUS_INVALID', 400, 'ackStatus phải là acked hoặc failed.');
  }

  const reportedPatch = validateReportedPatch(opts.reportedPatch ?? opts.reported);
  const cleanCommandId = typeof opts.commandId === 'string' && opts.commandId.trim()
    ? opts.commandId.trim().slice(0, 128)
    : null;

  const shadowRepo = db?.getRepository?.('latticeTwinShadows');
  if (!shadowRepo || typeof shadowRepo.create !== 'function') {
    throw failTwin('TWIN_REPO_UNAVAILABLE', 503, 'Kho Digital Twin shadow chưa sẵn sàng.');
  }

  const now = new Date();
  const actorName = String(opts.actorName || 'edge-gateway').slice(0, 120);

  return runInTwinTx(db, organizationId, async (transaction) => {
    const txOpt = transaction ? { transaction } : {};
    const shadowRow = await findShadowRow(shadowRepo, organizationId, assetEntityId, transaction);

    if (!shadowRow) {
      const delta = computeShadowDelta({}, reportedPatch);
      const nextStatus = ackStatus === 'failed' ? 'failed' : 'synced';
      const created = await shadowRepo.create({
        values: {
          organizationId,
          ...(assetId != null ? { assetId } : {}),
          assetEntityId,
          desiredJson: {},
          reportedJson: reportedPatch,
          lastDeltaJson: delta,
          pendingCommandId: null,
          commandStatus: nextStatus,
          lastAckedAt: now,
          lastReportedAt: now,
          version: 1,
          updatedBy: actorName,
        },
        ...txOpt,
      });
      await recordTwinLedgerSafely(
        db,
        {
          organizationId,
          eventType: 'iot.twin_command_acked',
          targetCollection: 'latticeTwinShadows',
          targetRecordId: String(val(created, 'id') ?? assetEntityId),
          actor: { userId: null, username: actorName },
          payload: { assetEntityId, commandId: cleanCommandId, ackStatus, commandStatus: nextStatus, reportedPatch },
        },
        { transaction },
      );
      return serializeShadow(created);
    }

    const currentDesired = isPlainObject(val(shadowRow, 'desiredJson')) ? { ...val(shadowRow, 'desiredJson') } : {};
    const currentReported = isPlainObject(val(shadowRow, 'reportedJson')) ? { ...val(shadowRow, 'reportedJson') } : {};
    const nextReported = { ...currentReported, ...reportedPatch };
    const delta = computeShadowDelta(currentDesired, nextReported);
    const nextStatus = ackStatus === 'failed'
      ? 'failed'
      : (delta.inSync ? 'synced' : 'acked');

    const curPending = val(shadowRow, 'pendingCommandId') ?? null;
    const nextPending = cleanCommandId && curPending === cleanCommandId ? null : curPending;
    const curVersion = Number(val(shadowRow, 'version')) || 1;

    const updated = await updateShadowRow(
      shadowRepo,
      shadowRow,
      {
        ...(assetId != null ? { assetId } : {}),
        reportedJson: nextReported,
        lastDeltaJson: delta,
        pendingCommandId: nextPending,
        commandStatus: nextStatus,
        lastAckedAt: now,
        lastReportedAt: now,
        version: curVersion + 1,
        updatedBy: actorName,
      },
      { organizationId, transaction },
    );

    await recordTwinLedgerSafely(
      db,
      {
        organizationId,
        eventType: 'iot.twin_command_acked',
        targetCollection: 'latticeTwinShadows',
        targetRecordId: String(val(updated, 'id') ?? assetEntityId),
        actor: { userId: null, username: actorName },
        payload: { assetEntityId, commandId: cleanCommandId, ackStatus, commandStatus: nextStatus, reportedPatch },
      },
      { transaction },
    );

    return serializeShadow(updated);
  });
}

module.exports = {
  TWIN_COMMAND_STATUSES,
  HITL_TEMP_THRESHOLD_C,
  computeShadowDelta,
  validateDesiredPatch,
  validateDownlinkUrl,
  resolveAssetEntity,
  getTwinShadow,
  requestDesiredSetpoint,
  ackCommandFromEdge,
};
