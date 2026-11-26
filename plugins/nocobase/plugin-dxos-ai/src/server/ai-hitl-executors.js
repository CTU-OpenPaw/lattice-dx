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
const path = require('node:path');
const { recordAiAuditLog } = require('./ai-schemas');
const { DEFAULT_ADMIN_ROLES, val } = require('./ai-sync');
const { failTool, resolveActorScope, createDxosTools } = require('./ai-tools-core');
const { HITL_APPROVER_ROLES, isRootActor, decideApproval } = require('./ai-hitl');
const { runWithTenantRls, runWithSystemRlsBypass } = require('./ai-rls');

const SUPPORTED_HITL_TOOLS = new Set([
  'dxos_execute_record_action',
  'dxos_twin_set_desired',
  'dxos_wms_hold_lot',
  'dxos_alarm_action',
  'latticeflow.approval',
]);
const TWIN_URN_RE = /^urn:ngsi-ld:Asset:([a-zA-Z0-9_-]{1,80}):native:([1-9]\d{0,18})$/;
const ALLOWED_TWIN_DESIRED_KEYS = new Set([
  'targetTempC', 'maxTempC', 'minTempC', 'defrostMode', 'fanMode', 'doorLock', 'reportingIntervalSec',
]);
const ALLOWED_DEFROST_MODES = new Set(['auto', 'manual', 'off']);
const ALLOWED_FAN_MODES = new Set(['auto', 'high', 'low', 'eco']);
const ALLOWED_DOOR_LOCKS = new Set(['locked', 'unlocked']);
const FORBIDDEN_PATCH_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function loadCrossPluginModule(candidates) {
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

function resolveCrossPluginCandidates(pluginDir, serverSubpath) {
  const inDist = __dirname.includes(`${path.sep}dist${path.sep}`);
  const pkgName = `@latticedx/${pluginDir}`;
  return inDist
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
}

function validateFallbackDesiredPatch(rawPatch) {
  if (!rawPatch || typeof rawPatch !== 'object' || Array.isArray(rawPatch)) {
    throw failTool('TWIN_DESIRED_INVALID', 400, 'desiredPatch phải là đối tượng JSON hợp lệ.');
  }
  const entries = Object.entries(rawPatch);
  if (!entries.length) {
    throw failTool('TWIN_DESIRED_INVALID', 400, 'desiredPatch không được để trống.');
  }
  const clean = {};
  for (const [key, rawVal] of entries) {
    if (FORBIDDEN_PATCH_KEYS.has(key) || !ALLOWED_TWIN_DESIRED_KEYS.has(key)) {
      throw failTool('TWIN_FIELD_FORBIDDEN', 400, `Trường điều khiển twin "${key}" không được phép.`);
    }
    if (key === 'targetTempC' || key === 'maxTempC' || key === 'minTempC') {
      const num = Number(rawVal);
      if (rawVal === null || rawVal === '' || typeof rawVal === 'boolean' || !Number.isFinite(num) || num < -80 || num > 120) {
        throw failTool('TWIN_DESIRED_INVALID', 400, `${key} phải là số hữu hạn trong [-80, 120] °C.`);
      }
      clean[key] = Number(num.toFixed(3));
    } else if (key === 'defrostMode') {
      const m = String(rawVal || '').trim().toLowerCase();
      if (!ALLOWED_DEFROST_MODES.has(m)) throw failTool('TWIN_DESIRED_INVALID', 400, 'defrostMode không hợp lệ.');
      clean[key] = m;
    } else if (key === 'fanMode') {
      const m = String(rawVal || '').trim().toLowerCase();
      if (!ALLOWED_FAN_MODES.has(m)) throw failTool('TWIN_DESIRED_INVALID', 400, 'fanMode không hợp lệ.');
      clean[key] = m;
    } else if (key === 'doorLock') {
      const m = String(rawVal || '').trim().toLowerCase();
      if (!ALLOWED_DOOR_LOCKS.has(m)) throw failTool('TWIN_DESIRED_INVALID', 400, 'doorLock không hợp lệ.');
      clean[key] = m;
    } else if (key === 'reportingIntervalSec') {
      const sec = Number(rawVal);
      if (!Number.isInteger(sec) || sec < 5 || sec > 3600) {
        throw failTool('TWIN_DESIRED_INVALID', 400, 'reportingIntervalSec phải là số nguyên trong [5, 3600].');
      }
      clean[key] = sec;
    }
  }
  if (clean.minTempC !== undefined && clean.maxTempC !== undefined && clean.minTempC > clean.maxTempC) {
    throw failTool('TWIN_DESIRED_INVALID', 400, 'minTempC không được lớn hơn maxTempC.');
  }
  return clean;
}

function parseOptionalPositiveInt(raw, fieldName = 'id') {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  if (typeof raw === 'boolean' || typeof raw === 'object') {
    throw failTool('HITL_ARGS_MISMATCH', 409, `${fieldName} trong proposedArgs không hợp lệ.`);
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!/^[1-9]\d{0,18}$/.test(trimmed)) {
      throw failTool('HITL_ARGS_MISMATCH', 409, `${fieldName} trong proposedArgs phải là số nguyên dương.`);
    }
    const n = Number(trimmed);
    if (!Number.isSafeInteger(n) || n <= 0) {
      throw failTool('HITL_ARGS_MISMATCH', 409, `${fieldName} trong proposedArgs vượt quá giới hạn số nguyên hợp lệ.`);
    }
    return n;
  }
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw) || raw <= 0) {
      throw failTool('HITL_ARGS_MISMATCH', 409, `${fieldName} trong proposedArgs phải là số nguyên dương.`);
    }
    return raw;
  }
  throw failTool('HITL_ARGS_MISMATCH', 409, `${fieldName} trong proposedArgs không hợp lệ.`);
}

function isAdminRoleRecord(role) {
  if (!role) return false;
  if (val(role, 'allowAll') === true || val(role, 'allowConfigure') === true) return true;
  const snippets = val(role, 'snippets');
  if (Array.isArray(snippets) && (snippets.includes('pm') || snippets.includes('pm.*') || snippets.includes('*'))) {
    return true;
  }
  const strategyActions = val(role, 'strategy')?.actions || [];
  return Array.isArray(strategyActions) && strategyActions.some((a) => {
    const actName = typeof a === 'string' ? a : (val(a, 'name') || a?.name);
    return actName === 'update' || actName === '*' || actName === '*:*';
  });
}

async function assertApproverCollectionUpdateAcl(targetDb, ctx, actor, collections) {
  const cols = (Array.isArray(collections) ? collections : [collections])
    .map((c) => String(c || '').trim())
    .filter(Boolean);
  if (!cols.length) {
    throw failTool('DXOS_ACL_DENIED', 403, 'Không xác định được collection đích để kiểm tra phân quyền.');
  }

  if (typeof ctx?.can === 'function') {
    const allowed = cols.some((c) => Boolean(ctx.can({ resource: c, action: 'update' })));
    if (!allowed) {
      throw failTool('DXOS_ACL_DENIED', 403, `Vai trò hiện tại không có quyền cập nhật (update) trên ${cols.join(', ')}.`);
    }
    return true;
  }

  if (actor?.isAdmin || isRootActor(actor)) {
    return true;
  }

  const roleNames = Array.isArray(actor?.roleNames)
    ? actor.roleNames.map((r) => String(r || '').trim()).filter(Boolean)
    : [];
  if (!roleNames.length) {
    throw failTool('DXOS_ACL_DENIED', 403, `Tài khoản thiếu vai trò hợp lệ để cập nhật ${cols.join(', ')}.`);
  }

  const rolesRepo = targetDb?.getRepository?.('roles');
  if (rolesRepo) {
    let roleRows = [];
    if (typeof rolesRepo.find === 'function') {
      roleRows = (await rolesRepo.find({ filter: { name: { $in: roleNames } }, limit: 100 })) || [];
    } else if (typeof rolesRepo.findOne === 'function') {
      for (const rName of roleNames) {
        const r = await rolesRepo.findOne({ filter: { name: rName } });
        if (r) roleRows.push(r);
      }
    }
    const matchedAdminOrStrategy = roleRows.some((r) => {
      const rName = val(r, 'name');
      if (rName && !roleNames.includes(rName)) return false;
      return isAdminRoleRecord(r);
    });
    if (matchedAdminOrStrategy) return true;
  }

  const resRepo = targetDb?.getRepository?.('dataSourcesRolesResources');
  if (resRepo) {
    let resRows = [];
    if (typeof resRepo.find === 'function') {
      resRows = (await resRepo.find({
        filter: { roleName: { $in: roleNames }, name: { $in: cols }, dataSourceKey: 'main' },
        appends: ['actions'],
        limit: 250,
      })) || [];
    } else if (typeof resRepo.findOne === 'function') {
      for (const rName of roleNames) {
        for (const col of cols) {
          const row = await resRepo.findOne({
            filter: { roleName: rName, name: col, dataSourceKey: 'main' },
            appends: ['actions'],
          });
          if (row) resRows.push(row);
        }
      }
    }
    const roleSet = new Set(roleNames);
    const colSet = new Set(cols);
    const hasUpdateGrant = resRows.some((r) => {
      if (!roleSet.has(val(r, 'roleName'))) return false;
      if (!colSet.has(val(r, 'name'))) return false;
      const dsKey = val(r, 'dataSourceKey');
      if (dsKey != null && dsKey !== 'main') return false;
      if (val(r, 'usingActionsConfig') === false) return true;
      const actions = val(r, 'actions') || [];
      return Array.isArray(actions) && actions.some((a) => {
        const actName = typeof a === 'string' ? a : (val(a, 'name') || a?.name);
        return actName === 'update' || actName === '*' || actName === '*:*';
      });
    });
    if (hasUpdateGrant) return true;
  }

  throw failTool('DXOS_ACL_DENIED', 403, `Vai trò hiện tại không có quyền cập nhật (update) trên ${cols.join(', ')}.`);
}

async function runInOptionalTx(targetDb, organizationId, fn) {
  if (typeof fn !== 'function') throw new TypeError('runInOptionalTx requires a callback function.');
  if (organizationId) {
    const pgRls = (() => {
      try { return require('./ai-rls').loadFoundationPgRls?.(); } catch { return null; }
    })();
    if (pgRls && typeof pgRls.canUsePgRlsSession === 'function' && pgRls.canUsePgRlsSession(targetDb)) {
      return runWithTenantRls(targetDb, organizationId, fn);
    }
  }
  if (typeof targetDb?.sequelize?.transaction === 'function') {
    return targetDb.sequelize.transaction(async (transaction) => fn(transaction || null));
  }
  return fn(null);
}

function computeFallbackShadowDelta(desired = {}, reported = {}) {
  const desObj = desired && typeof desired === 'object' && !Array.isArray(desired) ? desired : {};
  const repObj = reported && typeof reported === 'object' && !Array.isArray(reported) ? reported : {};
  const fields = {};
  let inSync = true;
  for (const key of Object.keys(desObj).sort()) {
    const desVal = desObj[key];
    const hasDirectRep = Object.hasOwn(repObj, key) && repObj[key] !== undefined;
    const hasTempFallback = !hasDirectRep && key === 'targetTempC'
      && (repObj.temperature !== undefined || repObj.tempC !== undefined);
    const repVal = hasDirectRep
      ? repObj[key]
      : (hasTempFallback ? (repObj.temperature ?? repObj.tempC) : null);
    const matched = (hasDirectRep || hasTempFallback)
      && (desVal === repVal || (Object.is(desVal, -0) && Object.is(repVal, 0)));
    if (matched) continue;
    inSync = false;
    const numericDelta = typeof desVal === 'number' && Number.isFinite(desVal)
      && typeof repVal === 'number' && Number.isFinite(repVal)
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

async function executeTwinSetpointApproval(targetDb, ctx, actor, row, rawArgs) {
  await assertApproverCollectionUpdateAcl(targetDb, ctx, actor, ['latticeAssets', 'latticeTwinShadows']);
  if (row.targetCollection && String(row.targetCollection).trim() !== 'latticeTwinShadows') {
    throw failTool('HITL_ARGS_MISMATCH', 409, 'targetCollection không khớp công cụ dxos_twin_set_desired.');
  }
  const desiredPatch = rawArgs.desiredPatch ?? rawArgs.desired;
  if (!desiredPatch || typeof desiredPatch !== 'object' || Array.isArray(desiredPatch) || !Object.keys(desiredPatch).length) {
    throw failTool('HITL_ARGS_MISMATCH', 409, 'desiredPatch của yêu cầu Digital Twin không hợp lệ.');
  }

  let assetId = parseOptionalPositiveInt(rawArgs.assetId, 'assetId');
  let assetEntityId = typeof rawArgs.assetEntityId === 'string' ? rawArgs.assetEntityId.trim() : '';
  const targetShadowId = parseOptionalPositiveInt(row.targetRecordId, 'targetRecordId');

  const shadowRepo = targetDb?.getRepository?.('latticeTwinShadows');
  let existingShadow = null;
  if (targetShadowId != null) {
    if (!shadowRepo || typeof shadowRepo.findOne !== 'function') {
      throw failTool('TWIN_REPO_UNAVAILABLE', 503, 'Kho Digital Twin shadow chưa sẵn sàng.');
    }
    existingShadow = await shadowRepo.findOne({ filterByTk: targetShadowId });
    if (!existingShadow) {
      throw failTool('SHADOW_NOT_FOUND', 404, 'Không tìm thấy bản ghi Digital Twin shadow.');
    }
    if (val(existingShadow, 'organizationId') !== row.organizationId) {
      throw failTool('DXOS_ORG_MISMATCH', 403, 'Shadow không thuộc phạm vi tổ chức.');
    }
    const shadowEntity = String(val(existingShadow, 'assetEntityId') || '').trim();
    if (assetEntityId && shadowEntity && shadowEntity !== assetEntityId) {
      throw failTool('HITL_ARGS_MISMATCH', 409, 'assetEntityId không khớp bản ghi latticeTwinShadows.');
    }
    const shadowAssetId = parseOptionalPositiveInt(val(existingShadow, 'assetId'), 'shadow.assetId');
    if (assetId != null && shadowAssetId != null && assetId !== shadowAssetId) {
      throw failTool('HITL_ARGS_MISMATCH', 409, 'assetId không khớp bản ghi latticeTwinShadows.');
    }
    if (!assetEntityId && shadowEntity) assetEntityId = shadowEntity;
    if (assetId == null && shadowAssetId != null) assetId = shadowAssetId;
  }

  if (!assetEntityId && assetId == null) {
    throw failTool('HITL_ARGS_MISMATCH', 409, 'Thiếu assetId hoặc assetEntityId trong proposedArgs.');
  }
  const urnMatch = assetEntityId ? TWIN_URN_RE.exec(assetEntityId) : null;
  if (urnMatch && urnMatch[1] !== row.organizationId) {
    throw failTool('DXOS_ORG_MISMATCH', 403, 'assetEntityId không thuộc phạm vi tổ chức của hàng chờ HITL.');
  }
  if (urnMatch && assetId != null && Number(urnMatch[2]) !== assetId) {
    throw failTool('HITL_ARGS_MISMATCH', 409, 'assetId không khớp URN assetEntityId.');
  }

  const twinMod = loadCrossPluginModule(resolveCrossPluginCandidates('plugin-dxos-blocks', 'digital-twin'));
  if (twinMod && typeof twinMod.requestDesiredSetpoint === 'function') {
    return twinMod.requestDesiredSetpoint(targetDb, {
      organizationId: row.organizationId,
      actor: { ...actor, organizationId: row.organizationId },
      assetId,
      assetEntityId,
      desiredPatch,
      requesterUserId: row.requesterUserId,
      hitlApproved: true,
    });
  }

  if (!shadowRepo) {
    throw failTool('TWIN_REPO_UNAVAILABLE', 503, 'Kho Digital Twin shadow chưa sẵn sàng.');
  }
  const cleanPatch = validateFallbackDesiredPatch(desiredPatch);
  const resolvedEntityId = assetEntityId || `urn:ngsi-ld:Asset:${row.organizationId}:native:${assetId}`;

  return runInOptionalTx(targetDb, row.organizationId, async (transaction) => {
    const txOpt = transaction ? { transaction } : {};
    let targetShadow = existingShadow;
    if (!targetShadow && typeof shadowRepo.findOne === 'function') {
      targetShadow = await shadowRepo.findOne({
        filter: { organizationId: row.organizationId, assetEntityId: resolvedEntityId },
        ...txOpt,
      });
      if (targetShadow && val(targetShadow, 'organizationId') !== row.organizationId) {
        throw failTool('DXOS_ORG_MISMATCH', 403, 'Shadow không thuộc phạm vi tổ chức.');
      }
    }
    const commandId = `cmd-${randomBytes(8).toString('hex')}`;
    const now = new Date();
    if (targetShadow) {
      const prevDesired = val(targetShadow, 'desiredJson') && typeof val(targetShadow, 'desiredJson') === 'object'
        ? val(targetShadow, 'desiredJson')
        : {};
      const nextDesired = { ...prevDesired, ...cleanPatch };
      if (
        nextDesired.minTempC !== undefined
        && nextDesired.maxTempC !== undefined
        && Number(nextDesired.minTempC) > Number(nextDesired.maxTempC)
      ) {
        throw failTool('TWIN_DESIRED_INVALID', 400, 'minTempC không được lớn hơn maxTempC.');
      }
      const reportedJson = val(targetShadow, 'reportedJson') && typeof val(targetShadow, 'reportedJson') === 'object'
        ? val(targetShadow, 'reportedJson')
        : {};
      const lastDeltaJson = computeFallbackShadowDelta(nextDesired, reportedJson);
      const nextVersion = (Number(val(targetShadow, 'version')) || 1) + 1;
      const patch = {
        desiredJson: nextDesired,
        lastDeltaJson,
        pendingCommandId: commandId,
        commandStatus: 'dispatched',
        lastDispatchedAt: now,
        version: nextVersion,
        updatedBy: actor.username,
      };
      if (typeof targetShadow.update === 'function') {
        await targetShadow.update(patch, txOpt);
      } else if (typeof shadowRepo.update === 'function') {
        await shadowRepo.update({
          filterByTk: val(targetShadow, 'id'),
          filter: { organizationId: row.organizationId },
          values: patch,
          ...txOpt,
        });
      }
      return { gatedByHitl: false, fallback: true, commandId, desiredJson: nextDesired, lastDeltaJson };
    }

    if (typeof shadowRepo.create !== 'function') {
      throw failTool('TWIN_REPO_UNAVAILABLE', 503, 'Kho Digital Twin shadow chưa hỗ trợ tạo mới.');
    }
    const lastDeltaJson = computeFallbackShadowDelta(cleanPatch, {});
    const created = await shadowRepo.create({
      values: {
        organizationId: row.organizationId,
        ...(assetId != null ? { assetId } : {}),
        assetEntityId: resolvedEntityId,
        desiredJson: cleanPatch,
        reportedJson: {},
        lastDeltaJson,
        pendingCommandId: commandId,
        commandStatus: 'dispatched',
        lastDispatchedAt: now,
        version: 1,
        updatedBy: actor.username,
      },
      ...txOpt,
    });
    return {
      gatedByHitl: false,
      fallback: true,
      commandId,
      shadowId: val(created, 'id') ?? null,
      desiredJson: cleanPatch,
      lastDeltaJson,
    };
  });
}

async function executeWmsHoldLotApproval(targetDb, ctx, actor, row, rawArgs) {
  await assertApproverCollectionUpdateAcl(targetDb, ctx, actor, ['latticeStockLots', 'latticeOrders', 'latticeAssets']);
  if (row.targetCollection && String(row.targetCollection).trim() !== 'latticeStockLots') {
    throw failTool('HITL_ARGS_MISMATCH', 409, 'targetCollection không khớp công cụ dxos_wms_hold_lot.');
  }
  const argsLotId = parseOptionalPositiveInt(rawArgs.lotId, 'lotId');
  const rowRecId = parseOptionalPositiveInt(row.targetRecordId, 'targetRecordId');
  if (rowRecId != null && argsLotId != null && argsLotId !== rowRecId) {
    throw failTool('HITL_ARGS_MISMATCH', 409, 'lotId trong proposedArgs không khớp targetRecordId.');
  }
  const lotId = argsLotId ?? rowRecId;
  const lotCode = typeof rawArgs.lotCode === 'string' ? rawArgs.lotCode.trim() : '';
  if (lotId == null && !lotCode) {
    throw failTool('HITL_ARGS_MISMATCH', 409, 'Thiếu lotId hoặc lotCode trong proposedArgs.');
  }

  const lotRepo = targetDb?.getRepository?.('latticeStockLots');
  if (lotId != null && lotCode && lotRepo && typeof lotRepo.findOne === 'function') {
    const existingLot = await lotRepo.findOne({ filter: { organizationId: row.organizationId, id: lotId } });
    if (!existingLot || val(existingLot, 'organizationId') !== row.organizationId) {
      throw failTool('WMS_LOT_NOT_FOUND', 404, 'Không tìm thấy lô hàng trong phạm vi tổ chức.');
    }
    if (val(existingLot, 'lotCode') !== lotCode) {
      throw failTool('HITL_ARGS_MISMATCH', 409, 'lotCode không khớp bản ghi lô hàng.');
    }
  }

  const wmsMod = loadCrossPluginModule(resolveCrossPluginCandidates('plugin-dxos-studio', 'wms-engine'));
  if (wmsMod && typeof wmsMod.createDxosWmsActions === 'function') {
    const wmsActions = wmsMod.createDxosWmsActions(targetDb);
    if (typeof wmsActions?.holdLotByMkt === 'function') {
      const stateRole = String(ctx?.state?.currentRole || '').trim();
      const roleNames = Array.isArray(actor.roleNames) ? actor.roleNames : [];
      const resolvedCurrentRole = actor.isRoot
        ? 'root'
        : (stateRole && roleNames.includes(stateRole)
          ? stateRole
          : (roleNames.find((r) => HITL_APPROVER_ROLES.has(r)) || roleNames[0] || ''));
      const subCtx = {
        app: ctx.app,
        db: targetDb,
        method: 'POST',
        can: typeof ctx?.can === 'function' ? ctx.can : undefined,
        state: {
          ...(ctx.state || {}),
          currentUser: { id: actor.userId, username: actor.username },
          currentRoles: roleNames,
          currentRole: resolvedCurrentRole,
          dxosApprovedQueueId: row.id,
        },
        action: {
          params: {
            values: {
              organizationId: row.organizationId,
              ...(lotId != null ? { lotId } : {}),
              ...(lotCode ? { lotCode } : {}),
              ...(rawArgs.maxAllowedC != null ? { maxAllowedC: rawArgs.maxAllowedC } : {}),
              ...(Array.isArray(rawArgs.samplesC) ? { samplesC: rawArgs.samplesC } : {}),
              forceHold: rawArgs.forceHold !== undefined
                ? Boolean(rawArgs.forceHold)
                : (!Array.isArray(rawArgs.samplesC) || !rawArgs.samplesC.length),
              reason: rawArgs.reason || `HITL approved hold (#${row.id})`,
            },
          },
        },
        body: null,
      };
      await wmsActions.holdLotByMkt(subCtx, async () => {});
      return subCtx.body;
    }
  }

  if (!lotRepo) throw failTool('WMS_REPO_UNAVAILABLE', 503, 'Kho lô hàng (latticeStockLots) chưa sẵn sàng.');
  return runInOptionalTx(targetDb, row.organizationId, async (transaction) => {
    const txOpt = transaction ? { transaction } : {};
    const filter = lotId != null ? { organizationId: row.organizationId, id: lotId } : { organizationId: row.organizationId, lotCode };
    const lot = typeof lotRepo.findOne === 'function' ? await lotRepo.findOne({ filter, ...txOpt }) : null;
    if (!lot || val(lot, 'organizationId') !== row.organizationId) {
      throw failTool('WMS_LOT_NOT_FOUND', 404, 'Không tìm thấy lô hàng trong phạm vi tổ chức.');
    }
    if (lotCode && val(lot, 'lotCode') !== lotCode) {
      throw failTool('HITL_ARGS_MISMATCH', 409, 'lotCode không khớp bản ghi lô hàng.');
    }
    const patch = {
      status: 'hold_mkt',
      holdReason: String(rawArgs.reason || `HITL approved hold (#${row.id})`).slice(0, 255),
      heldAt: new Date(),
      heldBy: actor.username,
    };
    if (typeof lot.update === 'function') {
      await lot.update(patch, txOpt);
    } else if (typeof lotRepo.update === 'function') {
      await lotRepo.update({ filterByTk: val(lot, 'id'), filter: { organizationId: row.organizationId }, values: patch, ...txOpt });
    }
    return {
      held: true,
      fallback: true,
      lotId: val(lot, 'id') ?? lotId,
      lotCode: val(lot, 'lotCode') || lotCode,
      lotStatus: 'hold_mkt',
    };
  });
}

async function executeAlarmActionApproval(targetDb, ctx, actor, row, rawArgs) {
  await assertApproverCollectionUpdateAcl(targetDb, ctx, actor, ['latticeIncidentCases']);
  if (row.targetCollection && String(row.targetCollection).trim() !== 'latticeIncidentCases') {
    throw failTool('HITL_ARGS_MISMATCH', 409, 'targetCollection không khớp công cụ dxos_alarm_action.');
  }
  const actionOp = String(rawArgs.action || '').trim().toLowerCase();
  if (actionOp !== 'ack' && actionOp !== 'clear') {
    throw failTool('HITL_ARGS_MISMATCH', 409, 'action của dxos_alarm_action phải là ack hoặc clear.');
  }
  const argsAlarmId = parseOptionalPositiveInt(rawArgs.alarmId, 'alarmId');
  const rowRecId = parseOptionalPositiveInt(row.targetRecordId, 'targetRecordId');
  if (rowRecId != null && argsAlarmId != null && argsAlarmId !== rowRecId) {
    throw failTool('HITL_ARGS_MISMATCH', 409, 'alarmId trong proposedArgs không khớp targetRecordId.');
  }
  const alarmId = argsAlarmId ?? rowRecId;
  const alarmCode = typeof rawArgs.alarmCode === 'string' ? rawArgs.alarmCode.trim() : '';
  if (alarmId == null && !alarmCode) {
    throw failTool('HITL_ARGS_MISMATCH', 409, 'Thiếu alarmId hoặc alarmCode trong proposedArgs.');
  }

  const incRepo = targetDb?.getRepository?.('latticeIncidentCases');
  if (!incRepo) throw failTool('INCIDENT_REPO_UNAVAILABLE', 503, 'Kho sự cố (latticeIncidentCases) chưa sẵn sàng.');
  const alarmRow = alarmId != null
    ? await incRepo.findOne({ filter: { organizationId: row.organizationId, id: alarmId } })
    : await incRepo.findOne({ filter: { organizationId: row.organizationId, code: alarmCode } });
  if (!alarmRow || val(alarmRow, 'organizationId') !== row.organizationId) {
    throw failTool('ALARM_NOT_FOUND', 404, 'Không tìm thấy cảnh báo trong phạm vi tổ chức.');
  }
  if (alarmCode && val(alarmRow, 'code') !== alarmCode) {
    throw failTool('HITL_ARGS_MISMATCH', 409, 'alarmCode không khớp bản ghi cảnh báo.');
  }

  const note = String(rawArgs.note || rawArgs.closeNote || '').trim();
  const alarmMod = loadCrossPluginModule(resolveCrossPluginCandidates('plugin-dxos-blocks', 'alarm-engine'));
  if (alarmMod) {
    if (actionOp === 'ack' && typeof alarmMod.acknowledgeAlarm === 'function') {
      return alarmMod.acknowledgeAlarm(targetDb, {
        id: val(alarmRow, 'id'),
        organizationId: row.organizationId,
        actorName: actor.username,
        note,
      });
    }
    if (actionOp === 'clear' && typeof alarmMod.clearAlarm === 'function') {
      return alarmMod.clearAlarm(targetDb, {
        id: val(alarmRow, 'id'),
        organizationId: row.organizationId,
        actorName: actor.username,
        closeNote: note,
      });
    }
  }

  return runInOptionalTx(targetDb, row.organizationId, async (transaction) => {
    const txOpt = transaction ? { transaction } : {};
    const targetId = val(alarmRow, 'id');
    const freshAlarm = typeof incRepo.findOne === 'function' && targetId != null
      ? await incRepo.findOne({ filter: { organizationId: row.organizationId, id: targetId }, ...txOpt })
      : alarmRow;
    if (!freshAlarm || val(freshAlarm, 'organizationId') !== row.organizationId) {
      throw failTool('ALARM_NOT_FOUND', 404, 'Không tìm thấy cảnh báo trong phạm vi tổ chức.');
    }
    const curStatus = String(val(freshAlarm, 'status') || 'open').toLowerCase();
    if (curStatus === 'closed' || curStatus === 'cleared') {
      throw failTool('ALARM_ALREADY_CLEARED', 409, 'Cảnh báo đã được đóng trước đó.');
    }
    const now = new Date();
    const patch = actionOp === 'clear'
      ? {
          status: 'closed',
          clearedAt: now,
          clearedBy: String(actor.username || 'operator').slice(0, 120),
          closeNote: (note || `Đã đóng cảnh báo bởi ${actor.username}`).slice(0, 255),
        }
      : {
          status: 'acknowledged',
          acknowledgedAt: val(freshAlarm, 'acknowledgedAt') || now,
          acknowledgedBy: String(actor.username || 'operator').slice(0, 120),
          ...(note ? { resolutionNote: note.slice(0, 255) } : {}),
        };
    if (typeof freshAlarm.update === 'function') {
      await freshAlarm.update(patch, txOpt);
    } else if (typeof incRepo.update === 'function') {
      await incRepo.update({ filterByTk: val(freshAlarm, 'id'), filter: { organizationId: row.organizationId }, values: patch, ...txOpt });
    }
    return {
      id: val(freshAlarm, 'id'),
      code: val(freshAlarm, 'code'),
      status: patch.status,
      fallback: true,
    };
  });
}

async function applyDelegatedRolesToActor(targetDb, actor, { organizationId, scope } = {}) {
  if (!actor || actor.userId == null || !organizationId) return actor;
  const delegationEngine = loadCrossPluginModule(
    resolveCrossPluginCandidates('plugin-dxos-studio', 'delegation-engine'),
  );
  if (typeof delegationEngine?.resolveEffectiveDelegatedRoles !== 'function') return actor;
  const delRes = await delegationEngine.resolveEffectiveDelegatedRoles(targetDb, {
    organizationId,
    userId: actor.userId,
    scope,
  });
  const delegatedRoles = Array.isArray(delRes?.delegatedRoles) ? delRes.delegatedRoles : [];
  if (!delegatedRoles.length) return actor;
  const firstDel = delRes.matchedDelegations?.[0] || null;
  const mergedRoleNames = Array.from(new Set([...(actor.roleNames || []), ...delegatedRoles]));
  const adminSet = DEFAULT_ADMIN_ROLES instanceof Set ? DEFAULT_ADMIN_ROLES : new Set(DEFAULT_ADMIN_ROLES);
  return {
    ...actor,
    roleNames: mergedRoleNames,
    isAdmin: Boolean(actor.isAdmin || mergedRoleNames.some((r) => adminSet.has(r))),
    ...(firstDel
      ? {
          delegatedFromUserId: firstDel.delegatorUserId,
          delegationUid: firstDel.delegationUid,
          matchedDelegations: delRes.matchedDelegations,
        }
      : {}),
  };
}

function assertFlowApprovalAuthority(actor, row, rawArgs) {
  const targetCol = String(row?.targetCollection || '').trim();
  if (targetCol && targetCol !== 'latticeAutomationRuns') {
    throw failTool('HITL_ARGS_MISMATCH', 409, 'latticeflow.approval yêu cầu targetCollection là latticeAutomationRuns.');
  }
  const runUid = String(rawArgs?.runUid || '').trim();
  if (!runUid) {
    throw failTool('HITL_ARGS_MISMATCH', 409, 'latticeflow.approval thiếu runUid trong proposedArgs.');
  }
  const approverRole = String(rawArgs?.approverRole || '').trim();
  if (
    approverRole
    && !isRootActor(actor)
    && !actor?.isAdmin
    && !(actor?.roleNames || []).includes(approverRole)
  ) {
    throw failTool(
      'HITL_FORBIDDEN',
      403,
      `Vai trò "${approverRole}" được yêu cầu để xử lý bước phê duyệt flow.`,
    );
  }
  return { runUid, approverRole };
}

async function executeFlowApprovalDecision(targetDb, ctx, actor, row, rawArgs, flowDecision) {
  const { runUid } = assertFlowApprovalAuthority(actor, row, rawArgs);
  const flowExecutor = loadCrossPluginModule(
    resolveCrossPluginCandidates('plugin-dxos-studio', 'flow/executor'),
  );
  if (typeof flowExecutor?.resumeFlowRun !== 'function') {
    throw failTool('HITL_TOOL_UNAVAILABLE', 503, 'Bộ thực thi flow/executor chưa sẵn sàng.');
  }
  return flowExecutor.resumeFlowRun(targetDb, {
    organizationId: row.organizationId,
    runUid,
    decision: flowDecision,
    payload: {
      approvalId: row.id ?? null,
      note: row.decisionNote || '',
      nodeId: rawArgs?.nodeId || null,
      ...(actor?.delegationUid
        ? { delegatedFromUserId: actor.delegatedFromUserId, delegationUid: actor.delegationUid }
        : {}),
    },
    actor: {
      id: actor.userId,
      userId: actor.userId,
      username: actor.username,
      roleNames: actor.roleNames || [],
      roles: actor.roleNames || [],
      isAdmin: Boolean(actor.isAdmin),
      ...(actor?.delegationUid
        ? { delegatedFromUserId: actor.delegatedFromUserId, delegationUid: actor.delegationUid }
        : {}),
    },
    options: { app: ctx?.app || targetDb?.app },
  });
}

function createHitlDecisionHelpers({ resolveDb, readActionPayload }) {
  async function runHitlDecision(ctx, decision, buildExecutor) {
    if (ctx.method && String(ctx.method).toUpperCase() !== 'POST') {
      throw failTool('METHOD_NOT_ALLOWED', 405, 'Cần phương thức POST.');
    }
    const targetDb = resolveDb(ctx);
    const baseActor = await resolveActorScope(ctx, targetDb);
    const payload = readActionPayload(ctx);
    const approvalId = payload.approvalId ?? payload.id ?? ctx?.action?.params?.approvalId ?? ctx?.action?.params?.filterByTk;
    const note = payload.note ?? payload.decisionNote ?? payload.reason ?? '';

    let peekRow = null;
    const queueRepo = targetDb?.getRepository?.('latticeAiApprovalQueue');
    const numericId = Number(approvalId);
    if (queueRepo && typeof queueRepo.findOne === 'function' && Number.isInteger(numericId) && numericId > 0) {
      const findPeek = () => queueRepo.findOne({
        filter: {
          id: numericId,
          ...(!isRootActor(baseActor) && baseActor.organizationId ? { organizationId: baseActor.organizationId } : {}),
        },
      });
      const found = isRootActor(baseActor) || !baseActor.organizationId
        ? await runWithSystemRlsBypass(targetDb, findPeek)
        : await runWithTenantRls(targetDb, baseActor.organizationId, findPeek);
      if (found) {
        peekRow = {
          id: val(found, 'id'),
          organizationId: val(found, 'organizationId'),
          toolName: val(found, 'toolName'),
          targetCollection: val(found, 'targetCollection'),
          proposedArgs: val(found, 'proposedArgs'),
        };
      }
    }

    const effectiveActor = await applyDelegatedRolesToActor(targetDb, baseActor, {
      organizationId: peekRow?.organizationId || baseActor.organizationId,
      scope: [peekRow?.targetCollection, 'latticeAiApprovalQueue'].filter(Boolean),
    });

    if (decision === 'reject' && peekRow?.toolName === 'latticeflow.approval') {
      if (!isRootActor(effectiveActor) && peekRow.organizationId && peekRow.organizationId !== effectiveActor.organizationId) {
        throw failTool('DXOS_ORG_MISMATCH', 403, 'Không được phép từ chối yêu cầu HITL của tổ chức khác.');
      }
      assertFlowApprovalAuthority(effectiveActor, peekRow, peekRow.proposedArgs || {});
    }

    const result = await decideApproval(targetDb, {
      actor: effectiveActor,
      approvalId,
      decision,
      note,
      ...(typeof buildExecutor === 'function' ? { executeApprovedWrite: buildExecutor(targetDb, effectiveActor) } : {}),
    });

    if (effectiveActor?.delegationUid) {
      await recordAiAuditLog(targetDb, {
        organizationId: result?.organizationId || peekRow?.organizationId || effectiveActor.organizationId,
        userId: effectiveActor.userId,
        username: effectiveActor.username,
        aiEmployee: result?.aiEmployee || 'flow-orchestrator',
        toolName: result?.toolName || peekRow?.toolName || 'latticeflow.approval',
        targetCollection: result?.targetCollection || peekRow?.targetCollection || 'latticeAiApprovalQueue',
        targetRecordId: result?.targetRecordId ?? null,
        argsSummary: {
          approvalId: result?.id ?? approvalId,
          decision,
          delegatedFromUserId: effectiveActor.delegatedFromUserId,
          delegationUid: effectiveActor.delegationUid,
        },
        status: decision === 'approve' ? 'approved' : 'rejected',
        durationMs: 0,
      }).catch(() => {});
    }

    if (decision === 'reject' && result?.toolName === 'latticeflow.approval' && result?.proposedArgs?.runUid) {
      const flowRun = await executeFlowApprovalDecision(
        targetDb,
        ctx,
        effectiveActor,
        result,
        result.proposedArgs,
        'rejected',
      );
      return { ...result, flowRun };
    }
    return result;
  }

  function buildApproveExecutor(ctx) {
    return (targetDb, actor) => async (row) => {
      if (!SUPPORTED_HITL_TOOLS.has(row.toolName)) {
        throw failTool('HITL_UNSUPPORTED_TOOL', 400, `Công cụ "${row.toolName}" chưa hỗ trợ thực thi qua hàng chờ HITL.`);
      }
      if (!isRootActor(actor) && row.organizationId !== actor.organizationId) {
        throw failTool('DXOS_ORG_MISMATCH', 403, 'Không được phép thực thi yêu cầu HITL của tổ chức khác.');
      }
      const rawArgs = row.proposedArgs && typeof row.proposedArgs === 'object' && !Array.isArray(row.proposedArgs)
        ? row.proposedArgs
        : null;
      if (!rawArgs) {
        throw failTool('HITL_ARGS_MISMATCH', 409, 'Dữ liệu proposedArgs của yêu cầu phê duyệt không hợp lệ.');
      }
      if (
        rawArgs.organizationId != null
        && String(rawArgs.organizationId).trim() !== ''
        && String(rawArgs.organizationId).trim() !== row.organizationId
      ) {
        throw failTool('HITL_ARGS_MISMATCH', 409, 'organizationId trong proposedArgs không khớp hàng chờ phê duyệt.');
      }

      if (row.toolName === 'dxos_twin_set_desired') {
        return executeTwinSetpointApproval(targetDb, ctx, actor, row, rawArgs);
      }
      if (row.toolName === 'dxos_wms_hold_lot') {
        return executeWmsHoldLotApproval(targetDb, ctx, actor, row, rawArgs);
      }
      if (row.toolName === 'dxos_alarm_action') {
        return executeAlarmActionApproval(targetDb, ctx, actor, row, rawArgs);
      }
      if (row.toolName === 'latticeflow.approval') {
        return executeFlowApprovalDecision(targetDb, ctx, actor, row, rawArgs, 'approved');
      }

      const argsCol = String(rawArgs.collection || '').trim();
      const argsOp = String(rawArgs.operation || '').trim();
      const argsRecId = parseOptionalPositiveInt(rawArgs.recordId, 'recordId');
      const rowRecId = parseOptionalPositiveInt(row.targetRecordId, 'targetRecordId');
      if (
        argsCol !== String(row.targetCollection || '').trim()
        || argsOp !== String(row.operation || '').trim()
        || argsRecId !== rowRecId
      ) {
        throw failTool('HITL_ARGS_MISMATCH', 409, 'Dữ liệu proposedArgs không khớp với thông tin hàng chờ phê duyệt.');
      }
      const execTool = createDxosTools().find((t) => t.definition.name === 'dxos_execute_record_action');
      if (!execTool) {
        throw failTool('HITL_TOOL_UNAVAILABLE', 503, 'Công cụ dxos_execute_record_action chưa sẵn sàng.');
      }
      let requesterEmployeeId = null;
      if (row.requesterUserId != null && row.organizationId) {
        const empRepo = targetDb?.getRepository?.('latticeEmployees');
        if (empRepo && typeof empRepo.find === 'function') {
          const empRows = (await runWithTenantRls(targetDb, row.organizationId, (transaction) => empRepo.find({
            filter: { userId: Number(row.requesterUserId), organizationId: row.organizationId, active: true },
            limit: 5,
            ...(transaction ? { transaction } : {}),
          }))) || [];
          const matchedEmp = empRows.find(
            (e) => Number(val(e, 'userId')) === Number(row.requesterUserId)
              && val(e, 'organizationId') === row.organizationId
              && val(e, 'active') !== false,
          );
          if (matchedEmp && val(matchedEmp, 'id') != null) {
            requesterEmployeeId = Number(val(matchedEmp, 'id'));
          }
        }
      }
      const execCtx = {
        app: ctx.app,
        db: targetDb,
        dataSource: ctx.dataSource || ctx.app?.mainDataSource,
        auth: ctx.auth,
        headers: ctx.headers,
        request: ctx.request,
        state: {
          ...(ctx.state || {}),
          dxosApprovedQueueId: row.id,
          dxosAuditChannel: 'hitl-approval',
          dxosAiUsername: row.aiEmployee || null,
          dxosRequesterEmployeeId: requesterEmployeeId,
          ...(isRootActor(actor) && row.organizationId ? { dxosTargetOrganizationId: row.organizationId, defaultOrgId: row.organizationId } : {}),
        },
      };
      return execTool.invoke(execCtx, { ...rawArgs, requireApproval: false });
    };
  }

  return { runHitlDecision, buildApproveExecutor };
}

module.exports = {
  SUPPORTED_HITL_TOOLS,
  parseOptionalPositiveInt,
  validateFallbackDesiredPatch,
  assertApproverCollectionUpdateAcl,
  computeFallbackShadowDelta,
  executeTwinSetpointApproval,
  executeWmsHoldLotApproval,
  executeAlarmActionApproval,
  applyDelegatedRolesToActor,
  assertFlowApprovalAuthority,
  executeFlowApprovalDecision,
  createHitlDecisionHelpers,
};
