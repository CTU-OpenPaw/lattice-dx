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
const net = require('node:net');
const path = require('node:path');
const {
  STARTER_AI_BLUEPRINTS,
  LEGACY_WORKFLOW_TASKS_TOOL,
  normalizeToolPermissionsMap,
  validateAiProfilePayload,
  recordAiAuditLog,
  resolveDefaultOrganizationId,
} = require('./ai-schemas');
const {
  ALL_LDX_ROLES,
  DEFAULT_ADMIN_ROLES,
  val,
  enforceProfileRoleLock,
  syncProfileToNocobaseAi,
  rebindStarterAgentsToService,
} = require('./ai-sync');
const {
  ADMIN_BUILDER_TOOL_NAMES,
  OPERATIONAL_TOOL_NAMES,
  failTool,
  resolveCallerRoleNames,
  isStudioAdmin,
  resolveActorScope,
  createDxosTools,
} = require('./ai-tools-core');
const {
  HITL_APPROVER_ROLES,
  isRootActor,
  isHitlApprover,
  listApprovals,
  decideApproval,
} = require('./ai-hitl');
const { buildEnterpriseTopology } = require('./mcp-itot-tools');
const {
  resolvePageGrid,
  extractGridBlockUids,
  hydrateFlowModel,
  readFlowModelMeta,
  restorePageSnapshot,
  getSurfaceRevisionState,
} = require('./ai-surface-creative-tools');
const { createSurfaceEventsHandler, publishSurfaceUpdate } = require('./surface-events');
const { getQuotaSummaryPersistent } = require('./ai-governance');
const { runProactiveIncidentTriage } = require('./proactive-triage');
const { runWithTenantRls, runWithSystemRlsBypass, runInRlsSavepoint } = require('./ai-rls');
const {
  listBuiltApps: listBuiltAppsRegistry,
  rebuildEnterpriseApp,
  exportAppBundle,
  teardownBuiltApp: teardownBuiltAppEngine,
} = require('./app-builder-orchestrator');

const TRIAGE_SCAN_ROLES = new Set(['root', 'admin', 'ldx_admin', 'ldx_director', 'ldx_manager', 'ldx_dispatcher']);
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

async function runInOptionalTx(targetDb, fn) {
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

  return runInOptionalTx(targetDb, async (transaction) => {
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
  return runInOptionalTx(targetDb, async (transaction) => {
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

  return runInOptionalTx(targetDb, async (transaction) => {
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

function serializeProfile(row, defaultOrgId = '') {
  if (!row) return null;
  return {
    id: val(row, 'id') ?? null,
    username: val(row, 'username'),
    nickname: val(row, 'nickname'),
    position: val(row, 'position') || '',
    departmentScope: val(row, 'departmentScope') || 'general',
    organizationId: val(row, 'organizationId') || defaultOrgId || null,
    avatar: val(row, 'avatar') || 'nocobase-015-male',
    bio: val(row, 'bio') || '',
    greeting: val(row, 'greeting') || '',
    systemPrompt: val(row, 'systemPrompt') || '',
    llmService: val(row, 'llmService') || 'local-9router',
    modelName: val(row, 'modelName') || 'ag/gemini-3.8-flash',
    enabled: val(row, 'enabled') !== false,
    isAdminBuilder: Boolean(val(row, 'isAdminBuilder')),
    allowSubAgentDispatch: Boolean(val(row, 'allowSubAgentDispatch')),
    allowedRoles: Array.isArray(val(row, 'allowedRoles')) ? val(row, 'allowedRoles') : [],
    toolPermissions: normalizeToolPermissionsMap(val(row, 'toolPermissions') ?? val(row, 'toolPermissionsJson')),
    mcpServers: Array.isArray(val(row, 'mcpServers')) ? val(row, 'mcpServers') : [],
    portalBindings: Array.isArray(val(row, 'portalBindings')) ? val(row, 'portalBindings') : [],
    quickPrompts: Array.isArray(val(row, 'quickPrompts')) ? val(row, 'quickPrompts') : [],
    version: Number(val(row, 'version')) || 1,
    createdAt: val(row, 'createdAt') || null,
    updatedAt: val(row, 'updatedAt') || null,
  };
}

function serializeAuditLog(row) {
  return {
    id: val(row, 'id'),
    actorUserId: val(row, 'actorUserId'),
    actorUsername: val(row, 'actorUsername'),
    organizationId: val(row, 'organizationId'),
    channel: val(row, 'channel'),
    aiEmployee: val(row, 'aiEmployee'),
    toolName: val(row, 'toolName'),
    argsSummary: val(row, 'argsSummary') || {},
    status: val(row, 'status'),
    durationMs: Number(val(row, 'durationMs')) || 0,
    promptTokens: Number(val(row, 'promptTokens')) || 0,
    completionTokens: Number(val(row, 'completionTokens')) || 0,
    estimatedCostUsd: Number(val(row, 'estimatedCostUsd')) || 0,
    piiRedactedCount: Number(val(row, 'piiRedactedCount')) || 0,
    errorCode: val(row, 'errorCode') || null,
    resultSummary: val(row, 'resultSummary') || null,
    createdAt: val(row, 'createdAt') || null,
  };
}

function buildCatalogMeta() {
  return {
    starterCount: STARTER_AI_BLUEPRINTS.length,
    availableTools: [...ADMIN_BUILDER_TOOL_NAMES, ...OPERATIONAL_TOOL_NAMES],
    adminBuilderTools: [...ADMIN_BUILDER_TOOL_NAMES],
    operationalTools: [...OPERATIONAL_TOOL_NAMES],
    roleOptions: [...DEFAULT_ADMIN_ROLES, ...ALL_LDX_ROLES],
    defaultLlmService: 'local-9router',
    defaultModelName: 'ag/gemini-3.8-flash',
  };
}

function readActionPayload(ctx) {
  return ctx?.action?.params?.values || ctx?.request?.body?.values || ctx?.request?.body || ctx?.action?.params || {};
}

async function ensureLocalLlmServiceRecord(db, env = process.env) {
  const llmRepo = db?.getRepository?.('llmServices');
  if (!llmRepo) {
    return { configured: false, skipped: true, reason: 'llmServices repository unavailable' };
  }
  const apiKey = String(env?.AGENT_API_KEY || env?.NINE_ROUTER_API_KEY || '').trim();
  const baseURL = String(env?.AGENT_BASE_URL || 'http://host.docker.internal:20128/v1').trim();
  const existing = await llmRepo.findOne({ filter: { name: 'local-9router' } });
  if (!apiKey && !existing) {
    return {
      configured: false,
      skipped: true,
      reason: 'AGENT_API_KEY env var not set; configure API key via LLM Services or AGENT_API_KEY.',
    };
  }
  const values = {
    name: 'local-9router',
    title: 'Local 9router (OpenAI-compatible)',
    provider: 'openai-completions',
    enabledModels: {
      mode: 'custom',
      models: [
        { label: 'ag/gemini-3.8-flash (9router)', value: 'ag/gemini-3.8-flash' },
        { label: 'combo (9router auto-route)', value: 'combo' },
      ],
    },
    enabled: true,
    ...(apiKey ? { options: { baseURL, apiKey } } : {}),
  };
  if (existing && typeof existing.update === 'function') {
    await existing.update(values);
  } else {
    await llmRepo.create({ values });
  }
  return { configured: true, skipped: false, serviceName: 'local-9router', baseURL };
}

const QUICK_CONNECT_PROVIDER_PRESETS = Object.freeze({
  openai: {
    storedProvider: 'openai',
    defaultServiceName: 'quick-openai',
    defaultTitle: 'OpenAI (Quick-Connect)',
    defaultBaseURL: 'https://api.openai.com/v1',
    defaultModelName: 'gpt-4o-mini',
    requireKey: true,
  },
  'openai-completions': {
    storedProvider: 'openai-completions',
    defaultServiceName: 'quick-openai-completions',
    defaultTitle: 'OpenAI-compatible (Quick-Connect)',
    defaultBaseURL: 'http://127.0.0.1:20128/v1',
    defaultModelName: 'ag/gemini-3.8-flash',
    requireKey: true,
  },
  '9router': {
    storedProvider: 'openai-completions',
    defaultServiceName: 'local-9router',
    defaultTitle: 'Local 9router (OpenAI-compatible)',
    defaultBaseURL: 'http://127.0.0.1:20128/v1',
    defaultModelName: 'ag/gemini-3.8-flash',
    requireKey: true,
  },
  'google-genai': {
    storedProvider: 'google-genai',
    defaultServiceName: 'quick-google-genai',
    defaultTitle: 'Google Gemini (Quick-Connect)',
    defaultBaseURL: 'https://generativelanguage.googleapis.com',
    defaultModelName: 'gemini-2.5-flash',
    requireKey: true,
  },
  anthropic: {
    storedProvider: 'anthropic',
    defaultServiceName: 'quick-anthropic',
    defaultTitle: 'Anthropic Claude (Quick-Connect)',
    defaultBaseURL: 'https://api.anthropic.com/v1',
    defaultModelName: 'claude-3-5-sonnet-latest',
    requireKey: true,
  },
  deepseek: {
    storedProvider: 'deepseek',
    defaultServiceName: 'quick-deepseek',
    defaultTitle: 'DeepSeek (Quick-Connect)',
    defaultBaseURL: 'https://api.deepseek.com/v1',
    defaultModelName: 'deepseek-chat',
    requireKey: true,
  },
  ollama: {
    storedProvider: 'ollama',
    defaultServiceName: 'quick-ollama',
    defaultTitle: 'Ollama Local (Quick-Connect)',
    defaultBaseURL: 'http://127.0.0.1:11434',
    defaultModelName: 'llama3.1',
    requireKey: false,
  },
});

const QUICK_CONNECT_LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', 'host.docker.internal']);
const QUICK_CONNECT_SERVICE_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/;
const QUICK_CONNECT_PRIVATE_IPV4_RE = /^(?:0\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+|127\.\d+\.\d+\.\d+|169\.254\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+)$/;
const QUICK_CONNECT_META_HOSTS = new Set(['metadata.google.internal', 'metadata.azure.com', '169.254.169.254', '100.100.100.200']);

function validateQuickConnectBaseUrl(rawUrl) {
  const str = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!str || str.length > 2048 || /[\u0000-\u001f\u007f\s]/.test(str)) {
    throw failTool('LLM_URL_UNSAFE', 400, 'baseURL không hợp lệ.');
  }
  let parsed;
  try {
    parsed = new URL(str);
  } catch {
    throw failTool('LLM_URL_UNSAFE', 400, 'Định dạng baseURL không hợp lệ.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw failTool('LLM_URL_UNSAFE', 400, 'Chỉ hỗ trợ giao thức http:// hoặc https:// cho LLM baseURL.');
  }
  if (parsed.username || parsed.password) {
    throw failTool('LLM_URL_UNSAFE', 400, 'Không được nhúng username/password trong LLM baseURL.');
  }
  const authMatch = str.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]+)/);
  const rawAuthority = authMatch ? authMatch[1] : '';
  const rawHost = rawAuthority.startsWith('[')
    ? rawAuthority.slice(0, rawAuthority.indexOf(']') + 1)
    : rawAuthority.split(':')[0];
  const bare = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  const rawBare = String(rawHost || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!bare || !rawBare) {
    throw failTool('LLM_URL_UNSAFE', 400, 'baseURL thiếu hostname hợp lệ.');
  }
  if (/^(?:\d+|0x[0-9a-f]+)$/i.test(rawBare) || /(?:^|\.)0\d+/.test(rawBare)) {
    throw failTool('LLM_URL_UNSAFE', 400, 'Hostname dạng số/hex/octal không được phép.');
  }
  if (QUICK_CONNECT_META_HOSTS.has(bare) || QUICK_CONNECT_META_HOSTS.has(rawBare) || /^169\.254\./.test(bare)) {
    throw failTool('LLM_URL_UNSAFE', 400, 'Chặn truy cập địa chỉ metadata nội bộ.');
  }
  const isLocalAllowed = QUICK_CONNECT_LOCAL_HOSTS.has(bare);
  if (!isLocalAllowed) {
    if (bare.endsWith('.localhost') || bare.endsWith('.local') || bare.endsWith('.internal')) {
      throw failTool('LLM_URL_UNSAFE', 400, `Tên miền nội bộ "${bare}" bị chặn bởi chính sách SSRF.`);
    }
    if (bare.includes(':')) {
      throw failTool('LLM_URL_UNSAFE', 400, 'Địa chỉ IPv6 nội bộ/không công khai bị chặn.');
    }
    if (net.isIPv4(bare) && QUICK_CONNECT_PRIVATE_IPV4_RE.test(bare)) {
      throw failTool('LLM_URL_UNSAFE', 400, `Địa chỉ IP nội bộ "${bare}" bị chặn bởi chính sách SSRF.`);
    }
    if (!bare.includes('.')) {
      throw failTool('LLM_URL_UNSAFE', 400, 'Hostname không đầy đủ (non-FQDN) bị chặn.');
    }
    if (parsed.protocol !== 'https:') {
      throw failTool('LLM_URL_UNSAFE', 400, 'Nhà cung cấp LLM bên ngoài phải dùng https://.');
    }
  }
  return parsed.toString().replace(/\/+$/, '');
}

function buildLlmProbeTarget(provider, rawBase, apiKey) {
  const lower = String(provider || '').trim().toLowerCase();
  let base = String(rawBase || '').trim().replace(/\/+$/, '');
  if (!base) {
    if (lower.includes('ollama')) base = 'http://127.0.0.1:11434';
    else if (lower.includes('gemini') || lower.includes('google')) base = 'https://generativelanguage.googleapis.com';
    else if (lower.includes('anthropic')) base = 'https://api.anthropic.com/v1';
    else if (lower.includes('deepseek') && apiKey) base = 'https://api.deepseek.com/v1';
    else if (lower.includes('openai') && apiKey) base = 'https://api.openai.com/v1';
  }
  if (!base) return null;
  if (lower.includes('ollama')) {
    return { baseURL: base, probeUrl: `${base.replace(/\/v1$/i, '')}/api/tags`, headers: {} };
  }
  if (lower.includes('gemini') || lower.includes('google')) {
    const probeUrl = base.endsWith('/v1beta/models')
      ? base
      : (base.endsWith('/v1beta') ? `${base}/models` : `${base}/v1beta/models`);
    return { baseURL: base, probeUrl, headers: apiKey ? { 'x-goog-api-key': apiKey } : {} };
  }
  if (lower.includes('anthropic')) {
    const probeUrl = base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`;
    return {
      baseURL: base,
      probeUrl,
      headers: {
        ...(apiKey ? { 'x-api-key': apiKey } : {}),
        'anthropic-version': '2023-06-01',
      },
    };
  }
  return {
    baseURL: base,
    probeUrl: `${base}/models`,
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  };
}

async function probeLlmHealth(db, { env = process.env, fetchImpl, isAdmin = false, llmServiceName = '', modelName = '' } = {}) {
  const resultBase = (fields) => ({
    ok: Boolean(fields.ok),
    status: Number(fields.status) || 503,
    code: String(fields.code || 'LLM_UNAVAILABLE'),
    llmService: String(fields.llmService || ''),
    modelName: String(fields.modelName || ''),
    provider: String(fields.provider || ''),
    message: String(fields.message || ''),
    ...(isAdmin && fields.baseURL !== undefined ? { baseURL: String(fields.baseURL || '') } : {}),
  });

  let boundService = String(llmServiceName || '').trim();
  let boundModel = String(modelName || '').trim();
  if (!boundService || !boundModel) {
    await runWithSystemRlsBypass(db, async () => {
      const profRepo = db?.getRepository?.('latticeAiProfiles');
      const profRow = profRepo && typeof profRepo.findOne === 'function'
        ? await profRepo.findOne({ filter: { username: 'dxos-architect' } }).catch(() => null)
        : null;
      const empRepo = db?.getRepository?.('aiEmployees');
      const empRow = (!profRow && empRepo && typeof empRepo.findOne === 'function')
        ? await empRepo.findOne({ filter: { username: 'dxos-architect' } }).catch(() => null)
        : null;
      const empModels = val(empRow, 'modelSettings')?.models;
      const firstEmpModel = Array.isArray(empModels) ? empModels[0] : null;
      if (!boundService) {
        boundService = String(val(profRow, 'llmService') || firstEmpModel?.llmService || 'local-9router').trim();
      }
      if (!boundModel) {
        boundModel = String(val(profRow, 'modelName') || firstEmpModel?.model || 'ag/gemini-3.8-flash').trim();
      }
    });
  }

  const llmRepo = db?.getRepository?.('llmServices');
  if (!llmRepo) {
    return resultBase({
      ok: false,
      status: 503,
      code: 'NO_LLM_SERVICE',
      llmService: boundService,
      modelName: boundModel,
      provider: '',
      message: 'Chưa cấu hình dịch vụ LLM (llmServices repository unavailable).',
    });
  }

  const llmRow = await runWithSystemRlsBypass(db, async () => {
    if (boundService && typeof llmRepo.findOne === 'function') {
      const exact = await llmRepo.findOne({ filter: { name: boundService } }).catch(() => null);
      if (exact) return exact;
    }
    if (!llmServiceName && typeof llmRepo.find === 'function') {
      const rows = (await llmRepo.find({ filter: { enabled: true }, limit: 1 }).catch(() => [])) || [];
      return rows[0] || null;
    }
    return null;
  });

  if (!llmRow) {
    return resultBase({
      ok: false,
      status: 503,
      code: 'NO_LLM_SERVICE',
      llmService: boundService,
      modelName: boundModel,
      provider: '',
      message: 'Chưa kết nối dịch vụ LLM cho AI Architect. Vui lòng nhập API key trong DX-OS AI Studio.',
      baseURL: '',
    });
  }

  const serviceName = String(val(llmRow, 'name') || boundService || '').trim();
  const provider = String(val(llmRow, 'provider') || val(llmRow, 'type') || 'openai-completions').trim();
  if (val(llmRow, 'enabled') === false) {
    return resultBase({
      ok: false,
      status: 503,
      code: 'LLM_UNAVAILABLE',
      llmService: serviceName,
      modelName: boundModel,
      provider,
      message: `Dịch vụ LLM "${serviceName}" đang bị tắt (disabled).`,
    });
  }

  const options = val(llmRow, 'options') && typeof val(llmRow, 'options') === 'object' ? val(llmRow, 'options') : {};
  const rawBase = String(options.baseURL || val(llmRow, 'baseURL') || '').trim();
  const apiKey = String(options.apiKey || val(llmRow, 'apiKey') || '').trim();
  const target = buildLlmProbeTarget(provider, rawBase, apiKey);
  if (!target) {
    return resultBase({
      ok: false,
      status: 503,
      code: 'NO_LLM_SERVICE',
      llmService: serviceName,
      modelName: boundModel,
      provider,
      message: `Dịch vụ LLM "${serviceName}" thiếu baseURL hoặc API key hợp lệ.`,
      baseURL: '',
    });
  }

  const doFetch = fetchImpl || (typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function' ? globalThis.fetch : null);
  if (typeof doFetch !== 'function') {
    return resultBase({
      ok: false,
      status: 503,
      code: 'LLM_UNAVAILABLE',
      llmService: serviceName,
      modelName: boundModel,
      provider,
      baseURL: target.baseURL,
      message: 'Môi trường không hỗ trợ HTTP fetch để kiểm tra LLM.',
    });
  }

  let timeoutId = null;
  let controller = null;
  let signal = null;
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    signal = AbortSignal.timeout(5000);
  } else if (typeof AbortController === 'function') {
    controller = new AbortController();
    signal = controller.signal;
    timeoutId = setTimeout(() => controller.abort(), 5000);
    if (typeof timeoutId?.unref === 'function') timeoutId.unref();
  }

  try {
    const res = await doFetch(target.probeUrl, {
      method: 'GET',
      headers: target.headers,
      ...(signal ? { signal } : {}),
    });
    const status = Number(res?.status) || (res?.ok ? 200 : 503);
    if (res?.ok) {
      return resultBase({
        ok: true,
        status,
        code: 'OK',
        llmService: serviceName,
        modelName: boundModel,
        provider,
        baseURL: target.baseURL,
        message: `Dịch vụ LLM "${serviceName}" sẵn sàng.`,
      });
    }
    if (status === 401 || status === 403) {
      return resultBase({
        ok: false,
        status,
        code: 'LLM_AUTH_ERROR',
        llmService: serviceName,
        modelName: boundModel,
        provider,
        baseURL: target.baseURL,
        message: `Dịch vụ LLM "${serviceName}" từ chối xác thực (HTTP ${status}). Kiểm tra lại API key.`,
      });
    }
    if (status === 502) {
      return resultBase({
        ok: false,
        status: 502,
        code: 'LLM_BAD_GATEWAY',
        llmService: serviceName,
        modelName: boundModel,
        provider,
        baseURL: target.baseURL,
        message: `Upstream LLM gateway "${serviceName}" lỗi 502 Bad Gateway.`,
      });
    }
    if (status === 504) {
      return resultBase({
        ok: false,
        status: 504,
        code: 'LLM_TIMEOUT',
        llmService: serviceName,
        modelName: boundModel,
        provider,
        baseURL: target.baseURL,
        message: `Upstream LLM "${serviceName}" quá thời gian phản hồi (HTTP 504).`,
      });
    }
    return resultBase({
      ok: false,
      status,
      code: 'LLM_UNAVAILABLE',
      llmService: serviceName,
      modelName: boundModel,
      provider,
      baseURL: target.baseURL,
      message: `Dịch vụ LLM "${serviceName}" không khả dụng (HTTP ${status}).`,
    });
  } catch (err) {
    const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError' || /timeout|aborted/i.test(String(err?.message || ''));
    return resultBase({
      ok: false,
      status: isTimeout ? 504 : 503,
      code: isTimeout ? 'LLM_TIMEOUT' : 'LLM_UNAVAILABLE',
      llmService: serviceName,
      modelName: boundModel,
      provider,
      baseURL: target.baseURL,
      message: isTimeout
        ? `Kết nối tới dịch vụ LLM "${serviceName}" quá thời gian chờ (5s).`
        : `Không thể kết nối tới dịch vụ LLM "${serviceName}": ${String(err?.code || err?.message || 'network error').slice(0, 140)}`,
    });
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function upsertAndSyncProfile(db, input, { actorUser, defaultOrigin, defaultOrganizationId = '', auditToolName = 'dxosAi:saveProfile' } = {}) {
  const resolvedDefaultOrg = defaultOrganizationId || (await resolveDefaultOrganizationId(db, { actor: actorUser, fallback: 'default' }));
  const validated = validateAiProfilePayload(input, {
    adminToolNames: ADMIN_BUILDER_TOOL_NAMES,
    defaultOrganizationId: resolvedDefaultOrg,
  });
  const locked = enforceProfileRoleLock(validated, ADMIN_BUILDER_TOOL_NAMES);
  const profileRepo = db?.getRepository?.('latticeAiProfiles');
  let savedRow = locked;

  if (profileRepo) {
    savedRow = await runWithTenantRls(db, locked.organizationId, async () => {
      const existing = await profileRepo.findOne({ filter: { username: locked.username } });
      const nextVersion = existing ? (Number(val(existing, 'version')) || 1) + 1 : locked.version;
      const recordValues = { ...locked, version: nextVersion };
      if (existing && typeof existing.update === 'function') {
        return existing.update(recordValues);
      }
      return profileRepo.create({ values: recordValues });
    });
  }

  const normalized = serializeProfile(savedRow, resolvedDefaultOrg) || locked;
  const sync = await syncProfileToNocobaseAi(db, normalized, {
    adminToolNames: ADMIN_BUILDER_TOOL_NAMES,
    defaultOrigin,
  });

  if (auditToolName) {
    await recordAiAuditLog(db, {
      actorUserId: val(actorUser, 'id') ?? null,
      actorUsername: val(actorUser, 'username') || null,
      organizationId: normalized.organizationId,
      channel: 'studio-sync',
      aiEmployee: normalized.username,
      toolName: auditToolName,
      argsSummary: {
        username: normalized.username,
        isAdminBuilder: normalized.isAdminBuilder,
        allowedRoles: normalized.allowedRoles,
        portalBindings: normalized.portalBindings,
      },
      status: 'allowed',
      resultSummary: `Synced AI profile ${normalized.username} (v${normalized.version})`,
    });
  }

  return { profile: normalized, sync };
}

async function computeAllTimeAuditTotals(targetDb, organizationId) {
  const empty = { records: 0, promptTokens: 0, completionTokens: 0, estimatedCostUsd: 0, piiRedactedCount: 0 };
  return runWithTenantRls(targetDb, organizationId, async () => {
    if (typeof targetDb?.sequelize?.query === 'function') {
      try {
        const [rows] = await runInRlsSavepoint(targetDb, () => targetDb.sequelize.query(
          `SELECT COUNT(*)::int AS records,
                  COALESCE(SUM("promptTokens"), 0)::bigint AS "promptTokens",
                  COALESCE(SUM("completionTokens"), 0)::bigint AS "completionTokens",
                  COALESCE(SUM("estimatedCostUsd"), 0)::double precision AS "estimatedCostUsd",
                  COALESCE(SUM("piiRedactedCount"), 0)::int AS "piiRedactedCount"
           FROM "latticeAiAuditLogs"
           WHERE "organizationId" = :organizationId;`,
          { replacements: { organizationId } },
        ));
        if (Array.isArray(rows) && rows[0]) {
          const r = rows[0];
          return {
            records: Number(r.records) || 0,
            promptTokens: Number(r.promptTokens) || 0,
            completionTokens: Number(r.completionTokens) || 0,
            estimatedCostUsd: Number((Number(r.estimatedCostUsd) || 0).toFixed(6)),
            piiRedactedCount: Number(r.piiRedactedCount) || 0,
          };
        }
      } catch {
        // Fallback to repository scan in mock harnesses
      }
    }
    const repo = targetDb?.getRepository?.('latticeAiAuditLogs');
    if (!repo || typeof repo.find !== 'function') return empty;
    const rows = (await repo.find({ filter: { organizationId }, sort: ['-id'], limit: 5000 })) || [];
    const totals = { ...empty };
    for (const r of rows) {
      totals.records += 1;
      totals.promptTokens += Number(val(r, 'promptTokens')) || 0;
      totals.completionTokens += Number(val(r, 'completionTokens')) || 0;
      totals.estimatedCostUsd += Number(val(r, 'estimatedCostUsd')) || 0;
      totals.piiRedactedCount += Number(val(r, 'piiRedactedCount')) || 0;
    }
    totals.estimatedCostUsd = Number(totals.estimatedCostUsd.toFixed(6));
    return totals;
  });
}

async function ensureDefaultAiWorkforce(
  db,
  { env = process.env, actorUser = null, defaultOrigin = '', defaultOrganizationId = '', forceUpdate = false } = {},
) {
  const profRepo = db?.getRepository?.('latticeAiProfiles');
  if (!profRepo || typeof profRepo.create !== 'function') {
    return { seeded: [], skipped: true, reason: 'REPOS_NOT_READY' };
  }

  const resolvedOrigin = defaultOrigin || env?.NOCOBASE_INTERNAL_URL || '';
  let outcome;
  try {
    outcome = await runWithSystemRlsBypass(db, async () => {
      const resolvedDefaultOrg = defaultOrganizationId
        || (await resolveDefaultOrganizationId(db, { actor: actorUser, env, fallback: 'default' }));
      const seeded = [];
      const existing = [];
      const starterSet = new Set(STARTER_AI_BLUEPRINTS.map((b) => b.username));

      const existingMap = new Map();
      if (!forceUpdate && typeof profRepo.find === 'function') {
        const existingStarterRows = (await profRepo.find({
          filter: { username: { $in: [...starterSet] } },
          limit: 100,
        })) || [];
        for (const row of existingStarterRows) {
          const uname = String(val(row, 'username') || '').trim().toLowerCase();
          if (uname) existingMap.set(uname, row);
        }
      }

      for (const bp of STARTER_AI_BLUEPRINTS) {
        if (!forceUpdate) {
          let already = existingMap.get(bp.username);
          if (!already && typeof profRepo.findOne === 'function') {
            already = await profRepo.findOne({ filter: { username: bp.username } });
          }
          if (already) {
            existing.push(bp.username);
            continue;
          }
        }
        const res = await upsertAndSyncProfile(db, { ...bp, organizationId: bp.organizationId || resolvedDefaultOrg }, {
          actorUser,
          defaultOrigin: resolvedOrigin,
          defaultOrganizationId: resolvedDefaultOrg,
          auditToolName: null,
        });
        seeded.push(res.profile.username);
      }

      if (forceUpdate && typeof profRepo.find === 'function') {
        const existingRows = (await profRepo.find({ limit: 500 })) || [];
        for (const row of existingRows) {
          const uname = String(val(row, 'username') || '').trim().toLowerCase();
          if (!uname || starterSet.has(uname)) continue;
          const rawPerms = val(row, 'toolPermissions') ?? val(row, 'toolPermissionsJson');
          const hasLegacyKey = rawPerms && typeof rawPerms === 'object' && Object.prototype.hasOwnProperty.call(rawPerms, LEGACY_WORKFLOW_TASKS_TOOL);
          const hasLegacyCol = val(row, 'toolPermissionsJson') !== undefined;
          if (hasLegacyKey || hasLegacyCol) {
            await upsertAndSyncProfile(db, serializeProfile(row, resolvedDefaultOrg), {
              actorUser,
              defaultOrigin: resolvedOrigin,
              defaultOrganizationId: resolvedDefaultOrg,
              auditToolName: null,
            });
          }
        }
      }

      return { seeded, existing };
    });
  } catch (err) {
    const msg = String(err?.message || '');
    const code = err?.original?.code || err?.parent?.code || err?.code || '';
    if (!forceUpdate && (code === '42P01' || /does not exist|no such table/i.test(msg))) {
      return { seeded: [], skipped: true, reason: 'REPOS_NOT_READY' };
    }
    throw err;
  }

  let llm;
  try {
    llm = await runWithSystemRlsBypass(db, () => ensureLocalLlmServiceRecord(db, env));
  } catch (err) {
    if (forceUpdate) throw err;
    llm = { configured: false, skipped: true, reason: err?.message || 'LLM_SERVICE_NOT_READY' };
  }

  return {
    seeded: outcome.seeded,
    existing: outcome.existing,
    profiles: outcome.seeded,
    skipped: false,
    llm,
  };
}

function createDxosAiActions(db, { env = process.env, fetchImpl } = {}) {
  const resolveDb = (ctx) => ctx?.db || db;

  async function requireAdmin(ctx) {
    const targetDb = resolveDb(ctx);
    const ok = await isStudioAdmin(ctx, targetDb);
    if (!ok) {
      throw failTool('DXOS_ADMIN_REQUIRED', 403, 'Chỉ Quản trị viên mới có quyền truy cập DX-OS AI Studio.');
    }
    return targetDb;
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

  return {
    async listProfiles(ctx, next) {
      const targetDb = await requireAdmin(ctx);
      const actorScope = await resolveActorScope(ctx, targetDb).catch(() => null);
      const defaultOrg = await resolveDefaultOrganizationId(targetDb, { actor: actorScope, ctx, env });
      const repo = targetDb?.getRepository?.('latticeAiProfiles');
      const runList = () => (repo ? repo.find({ sort: ['username'] }) : []);
      const rows = (actorScope?.isRoot || !actorScope?.organizationId
        ? await runWithSystemRlsBypass(targetDb, runList)
        : await runWithTenantRls(targetDb, actorScope.organizationId, runList)) || [];
      const orgRepo = targetDb?.getRepository?.('latticeOrganizations');
      let organizations = [];
      if (orgRepo && typeof orgRepo.find === 'function') {
        try {
          const orgRows = (await orgRepo.find({ limit: 100 })) || [];
          organizations = [...new Set(
            orgRows
              .filter((r) => val(r, 'active') !== false && !['inactive', 'disabled'].includes(String(val(r, 'status') || 'active').toLowerCase()))
              .map((r) => String(val(r, 'organizationId') || '').trim())
              .filter((id) => id && id.toLowerCase() !== 'all'),
          )];
        } catch {}
      }
      if (defaultOrg && !organizations.includes(defaultOrg)) organizations.unshift(defaultOrg);
      ctx.body = {
        profiles: rows.map((r) => serializeProfile(r, defaultOrg)),
        organizations,
        defaultOrganizationId: defaultOrg || null,
        catalog: {
          ...buildCatalogMeta(),
          organizations,
          defaultOrganizationId: defaultOrg || null,
        },
      };
      if (typeof next === 'function') await next();
    },

    async saveProfile(ctx, next) {
      const targetDb = await requireAdmin(ctx);
      const actorUser = ctx?.state?.currentUser || ctx?.auth?.user;
      const actorScope = await resolveActorScope(ctx, targetDb).catch(() => null);
      const defaultOrg = await resolveDefaultOrganizationId(targetDb, { actor: actorScope, ctx, env, fallback: 'default' });
      const payload = readActionPayload(ctx);
      const defaultOrigin = env?.NOCOBASE_INTERNAL_URL;
      ctx.body = await upsertAndSyncProfile(targetDb, payload, { actorUser, defaultOrigin, defaultOrganizationId: defaultOrg });
      if (typeof next === 'function') await next();
    },

    async deleteProfile(ctx, next) {
      const targetDb = await requireAdmin(ctx);
      const actorUser = ctx?.state?.currentUser || ctx?.auth?.user;
      const payload = readActionPayload(ctx);
      const rawUsername = payload.username || ctx?.action?.params?.username || ctx?.action?.params?.filterByTk || '';
      const username = String(rawUsername).trim().toLowerCase();
      if (!username) {
        throw failTool('AI_USERNAME_REQUIRED', 400, 'Cần username của AI Employee để xóa.');
      }

      await runWithSystemRlsBypass(targetDb, async () => {
        for (const [repoName, filter] of [
          ['latticeAiProfiles', { username }],
          ['aiEmployees', { username }],
          ['rolesAiEmployees', { aiEmployee: username }],
        ]) {
          const repo = targetDb?.getRepository?.(repoName);
          if (repo && typeof repo.destroy === 'function') {
            await repo.destroy({ filter });
          }
        }
      });

      await recordAiAuditLog(targetDb, {
        actorUserId: val(actorUser, 'id') ?? null,
        actorUsername: val(actorUser, 'username') || null,
        channel: 'studio-sync',
        aiEmployee: username,
        toolName: 'dxosAi:deleteProfile',
        argsSummary: { username },
        status: 'allowed',
        resultSummary: `Deleted AI profile ${username}`,
      });

      ctx.body = { deleted: true, username };
      if (typeof next === 'function') await next();
    },

    async bootstrapDefaults(ctx, next) {
      const targetDb = await requireAdmin(ctx);
      const actorUser = ctx?.state?.currentUser || ctx?.auth?.user;
      const actorScope = await resolveActorScope(ctx, targetDb).catch(() => null);
      const defaultOrg = await resolveDefaultOrganizationId(targetDb, { actor: actorScope, ctx, env, fallback: 'default' });
      const defaultOrigin = env?.NOCOBASE_INTERNAL_URL;

      const workforce = await ensureDefaultAiWorkforce(targetDb, {
        env,
        actorUser,
        defaultOrigin,
        defaultOrganizationId: defaultOrg,
        forceUpdate: true,
      });
      const profiles = workforce.seeded || [];
      const llm = workforce.llm || { configured: false, skipped: true };

      await recordAiAuditLog(targetDb, {
        actorUserId: val(actorUser, 'id') ?? null,
        actorUsername: val(actorUser, 'username') || null,
        channel: 'studio-sync',
        toolName: 'dxosAi:bootstrapDefaults',
        argsSummary: { count: profiles.length, llmConfigured: llm.configured },
        status: 'allowed',
        resultSummary: `Bootstrapped ${profiles.length} starter AI employees`,
      });

      ctx.body = {
        bootstrappedCount: profiles.length,
        profiles,
        llm,
      };
      if (typeof next === 'function') await next();
    },

    async portalAgents(ctx, next) {
      const targetDb = resolveDb(ctx);
      const user = ctx?.state?.currentUser || ctx?.auth?.user;
      const userId = val(user, 'id');
      if (!userId) {
        throw failTool('NATIVE_LOGIN_REQUIRED', 401, 'Yêu cầu đăng nhập để xem danh sách AI hỗ trợ.');
      }

      const roleNames = await resolveCallerRoleNames(ctx, targetDb, userId);
      const callerIsAdmin = await isStudioAdmin(ctx, targetDb);
      const actorScope = await resolveActorScope(ctx, targetDb).catch(() => null);
      const payload = readActionPayload(ctx);
      const portalSlug = String(ctx?.action?.params?.portalSlug || payload.portalSlug || '').trim().toLowerCase();

      const repo = targetDb?.getRepository?.('latticeAiProfiles');
      const runFind = () => (repo ? repo.find({ filter: { enabled: true }, sort: ['username'] }) : []);
      const rows = (actorScope && !actorScope.isRoot && actorScope.organizationId
        ? await runWithTenantRls(targetDb, actorScope.organizationId, runFind)
        : await runWithSystemRlsBypass(targetDb, runFind)) || [];
      const adminToolSet = new Set(ADMIN_BUILDER_TOOL_NAMES);

      const employees = rows
        .map(serializeProfile)
        .filter((p) => {
          if (!p || p.enabled === false) return false;
          const perms = p.toolPermissions || {};
          const grantsBuilder = p.isAdminBuilder || Object.entries(perms).some(([name, mode]) => adminToolSet.has(name) && mode !== 'OFF');
          if (grantsBuilder && !callerIsAdmin) return false;

          const allowed = Array.isArray(p.allowedRoles) ? p.allowedRoles : [];
          const hasRole = callerIsAdmin
            ? (grantsBuilder || allowed.some((r) => roleNames.includes(r)) || roleNames.includes('root') || roleNames.includes('admin'))
            : roleNames.some((r) => allowed.includes(r));
          if (!hasRole) return false;

          if (!portalSlug) return true;
          const bindings = Array.isArray(p.portalBindings) ? p.portalBindings.map((s) => String(s).toLowerCase()) : [];
          return bindings.includes(portalSlug) || bindings.includes('*');
        })
        .map((p) => ({
          username: p.username,
          nickname: p.nickname,
          position: p.position,
          departmentScope: p.departmentScope,
          avatar: p.avatar,
          greeting: p.greeting,
          isAdminBuilder: p.isAdminBuilder,
          portalBindings: p.portalBindings,
          quickPrompts: p.quickPrompts,
        }));

      ctx.body = {
        portalSlug,
        callerRoles: roleNames,
        isAdmin: callerIsAdmin,
        employees,
      };
      if (typeof next === 'function') await next();
    },

    async auditLogs(ctx, next) {
      const targetDb = await requireAdmin(ctx);
      const actorScope = await resolveActorScope(ctx, targetDb).catch(() => null);
      const params = ctx?.action?.params || {};
      const filter = {};
      if (params.channel) filter.channel = String(params.channel).trim();
      if (params.status) filter.status = String(params.status).trim();
      if (params.toolName) filter.toolName = String(params.toolName).trim();
      const limit = Math.max(1, Math.min(200, Number(params.pageSize || params.limit) || 50));

      const repo = targetDb?.getRepository?.('latticeAiAuditLogs');
      const runFind = () => (repo ? repo.find({ filter, sort: ['-id'], limit }) : []);
      const rows = (actorScope && !actorScope.isRoot && actorScope.organizationId
        ? await runWithTenantRls(targetDb, actorScope.organizationId, runFind)
        : await runWithSystemRlsBypass(targetDb, runFind)) || [];
      ctx.body = { items: rows.map(serializeAuditLog) };
      if (typeof next === 'function') await next();
    },

    async quotaSummary(ctx, next) {
      const targetDb = await requireAdmin(ctx);
      const params = readActionPayload(ctx);
      const explicitOrg = String(ctx?.action?.params?.organizationId || params.organizationId || '').trim();
      const actorScope = explicitOrg ? null : await resolveActorScope(ctx, targetDb, { defaultFallback: '' }).catch(() => null);
      const requestedOrg = explicitOrg || (await resolveDefaultOrganizationId(targetDb, { actor: actorScope, ctx, env }));
      if (!requestedOrg) {
        throw failTool('AI_ORG_REQUIRED', 400, 'Cần organizationId hoặc một tổ chức đang hoạt động trong latticeOrganizations.');
      }
      const summary = await getQuotaSummaryPersistent(targetDb, requestedOrg, env);
      const auditTotals = await computeAllTimeAuditTotals(targetDb, summary.organizationId);
      ctx.body = {
        ...summary,
        dayUsage: summary.usage,
        allTimeTotals: auditTotals,
        auditTotals,
      };
      if (typeof next === 'function') await next();
    },

    async enterpriseTopology(ctx, next) {
      const targetDb = await requireAdmin(ctx);
      ctx.body = await runWithSystemRlsBypass(targetDb, () => buildEnterpriseTopology(targetDb, env, fetchImpl, ctx?.app));
      if (typeof next === 'function') await next();
    },

    async pageSurfaceState(ctx, next) {
      const targetDb = resolveDb(ctx);
      const user = ctx?.state?.currentUser || ctx?.auth?.user;
      if (!val(user, 'id')) throw failTool('NATIVE_LOGIN_REQUIRED', 401, 'Yêu cầu đăng nhập.');
      const payload = readActionPayload(ctx);
      const portalSlug = String(ctx?.action?.params?.portalSlug || payload.portalSlug || '').trim().toLowerCase();
      const pageTitle = String(ctx?.action?.params?.pageTitle || payload.pageTitle || '').trim();
      ctx.body = portalSlug
        ? await getSurfaceRevisionState(targetDb, portalSlug, pageTitle, val)
        : { revision: 1, blockCount: 0, layoutSignature: '' };
      if (typeof next === 'function') await next();
    },

    surfaceEvents: createSurfaceEventsHandler({
      getInitialState: (ctx, portalSlug, pageTitle) => getSurfaceRevisionState(resolveDb(ctx), portalSlug, pageTitle, val),
    }),

    async inspectPageBlocks(ctx, next) {
      const targetDb = await requireAdmin(ctx);
      const payload = readActionPayload(ctx);
      const portalSlug = String(ctx?.action?.params?.portalSlug || payload.portalSlug || '').trim().toLowerCase();
      const pageTitle = String(ctx?.action?.params?.pageTitle || payload.pageTitle || '').trim();
      const resolved = portalSlug ? await resolvePageGrid(targetDb, portalSlug, pageTitle, val) : {};
      if (!resolved.grid) {
        ctx.body = { portalSlug, pageTitle: val(resolved.pageRoute, 'title') || null, blocks: [] };
        if (typeof next === 'function') await next();
        return;
      }
      const { ordered, layout } = extractGridBlockUids(resolved.grid);
      const subMap = new Map((Array.isArray(resolved.grid?.subModels?.items) ? resolved.grid.subModels.items : []).map((m) => [m.uid, m]));
      const blocks = [];
      for (const uid of ordered) {
        const model = await hydrateFlowModel(resolved.flowModelsRepo, uid, subMap);
        blocks.push(readFlowModelMeta(model, uid));
      }
      ctx.body = {
        portalSlug,
        pageTitle: val(resolved.pageRoute, 'title') || null,
        gridUid: resolved.grid.uid,
        gridRows: layout.rows || {},
        sizes: layout.sizes || {},
        blocks,
      };
      if (typeof next === 'function') await next();
    },

    async rollbackPageSnapshot(ctx, next) {
      const targetDb = await requireAdmin(ctx);
      const actorUser = ctx?.state?.currentUser || ctx?.auth?.user;
      const payload = readActionPayload(ctx);
      const portalSlug = String(payload.portalSlug || ctx?.action?.params?.portalSlug || '').trim().toLowerCase();
      const pageTitle = String(payload.pageTitle || ctx?.action?.params?.pageTitle || '').trim();
      const snapshotUid = String(payload.snapshotUid || '').trim();
      const res = await restorePageSnapshot(targetDb, { portalSlug, pageTitle, snapshotUid }, val);
      await recordAiAuditLog(targetDb, {
        actorUserId: val(actorUser, 'id') ?? null,
        actorUsername: val(actorUser, 'username') || null,
        channel: 'studio-sync',
        toolName: 'dxosAi:rollbackPageSnapshot',
        argsSummary: { portalSlug, pageTitle, snapshotUid: snapshotUid || 'latest' },
        status: res?.rolledBack ? 'allowed' : 'error',
        resultSummary: JSON.stringify(res).slice(0, 600),
      });
      ctx.body = res;
      if (typeof next === 'function') await next();
    },

    async listApprovals(ctx, next) {
      if (ctx.method && String(ctx.method).toUpperCase() !== 'GET') {
        throw failTool('METHOD_NOT_ALLOWED', 405, 'Cần phương thức GET.');
      }
      const targetDb = resolveDb(ctx);
      const actor = await resolveActorScope(ctx, targetDb);
      const payload = readActionPayload(ctx);
      const status = ctx?.action?.params?.status ?? payload.status ?? 'pending';
      const limit = ctx?.action?.params?.limit ?? payload.limit ?? 50;
      const organizationId = ctx?.action?.params?.organizationId ?? payload.organizationId ?? null;
      const items = await listApprovals(targetDb, { actor, status, limit, organizationId });
      ctx.body = {
        items,
        total: items.length,
        isApprover: isHitlApprover(actor),
        organizationId: actor.organizationId,
      };
      if (typeof next === 'function') await next();
    },

    async triageScan(ctx, next) {
      if (ctx.method && String(ctx.method).toUpperCase() !== 'POST') {
        throw failTool('METHOD_NOT_ALLOWED', 405, 'Cần phương thức POST.');
      }
      const targetDb = resolveDb(ctx);
      const actor = await resolveActorScope(ctx, targetDb);
      const allowed = actor.isAdmin || (actor.roleNames || []).some((r) => TRIAGE_SCAN_ROLES.has(r));
      if (!allowed) {
        throw failTool('DXOS_TRIAGE_FORBIDDEN', 403, 'Chỉ Quản trị viên, Giám đốc, Quản lý hoặc Điều phối viên mới được quét sự cố chủ động.');
      }
      const payload = readActionPayload(ctx);
      const rawOrg = payload.organizationId ?? ctx?.action?.params?.organizationId ?? null;
      const requestedOrg = rawOrg != null ? String(rawOrg).trim() : '';
      if (!isRootActor(actor) && requestedOrg && requestedOrg !== actor.organizationId) {
        throw failTool('DXOS_ORG_MISMATCH', 403, 'Không được phép quét sự cố của tổ chức khác.');
      }
      const targetOrg = isRootActor(actor) && requestedOrg ? requestedOrg : actor.organizationId;
      const maxAlarms = payload.maxAlarms ?? ctx?.action?.params?.maxAlarms ?? 10;
      const alarmIds = payload.alarmIds ?? ctx?.action?.params?.alarmIds ?? null;
      const dryRun = Boolean(payload.dryRun);
      const overwriteProposal = Boolean(payload.overwriteProposal);

      const res = await runProactiveIncidentTriage(targetDb, {
        organizationId: targetOrg,
        actor,
        maxAlarms,
        alarmIds,
        dryRun,
        overwriteProposal,
      });

      await recordAiAuditLog(targetDb, {
        actorUserId: actor.userId,
        actorUsername: actor.username,
        organizationId: targetOrg,
        channel: 'proactive-triage',
        aiEmployee: 'dxos-coordinator',
        toolName: 'dxosAi:triageScan',
        argsSummary: { organizationId: targetOrg, maxAlarms, dryRun },
        status: 'allowed',
        resultSummary: `Scanned ${res.scannedCount} alarms, created ${res.proposalsCreated} HITL proposals, skipped ${res.deduplicatedSkipped} duplicates`,
      });

      if (!dryRun) {
        const eventPayload = {
          type: 'hitl_triage_scan',
          organizationId: targetOrg,
          scannedCount: res.scannedCount,
          proposalsCreated: res.proposalsCreated,
          deduplicatedSkipped: res.deduplicatedSkipped,
          message: `Phân tích ${res.scannedCount} sự cố: tạo ${res.proposalsCreated} đề xuất HITL mới`,
        };
        publishSurfaceUpdate('incidents', eventPayload);
        publishSurfaceUpdate('admin-studio', eventPayload);
      }

      ctx.body = res;
      if (typeof next === 'function') await next();
    },

    async approveAction(ctx, next) {
      ctx.body = await runHitlDecision(ctx, 'approve', (targetDb, actor) => async (row) => {
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
            const empRows = (await empRepo.find({
              filter: { userId: Number(row.requesterUserId), organizationId: row.organizationId, active: true },
              limit: 5,
            })) || [];
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
      });
      if (typeof next === 'function') await next();
    },

    async rejectAction(ctx, next) {
      ctx.body = await runHitlDecision(ctx, 'reject');
      if (typeof next === 'function') await next();
    },

    async checkLlmHealth(ctx, next) {
      if (ctx.method && String(ctx.method).toUpperCase() !== 'GET') {
        throw failTool('METHOD_NOT_ALLOWED', 405, 'Cần phương thức GET.');
      }
      const targetDb = resolveDb(ctx);
      const user = ctx?.state?.currentUser || ctx?.auth?.user;
      if (!val(user, 'id')) {
        throw failTool('NATIVE_LOGIN_REQUIRED', 401, 'Yêu cầu đăng nhập để kiểm tra sức khỏe LLM.');
      }
      const adminOk = await isStudioAdmin(ctx, targetDb);
      const payload = readActionPayload(ctx);
      const llmServiceName = String(ctx?.action?.params?.llmService || payload.llmService || '').trim();
      ctx.body = await probeLlmHealth(targetDb, {
        env,
        fetchImpl,
        isAdmin: adminOk,
        llmServiceName,
      });
      if (typeof next === 'function') await next();
    },

    async quickConnectLlm(ctx, next) {
      if (ctx.method && String(ctx.method).toUpperCase() !== 'POST') {
        throw failTool('METHOD_NOT_ALLOWED', 405, 'Cần phương thức POST.');
      }
      const targetDb = await requireAdmin(ctx);
      const actorUser = ctx?.state?.currentUser || ctx?.auth?.user;
      const actorScope = await resolveActorScope(ctx, targetDb).catch(() => null);
      const organizationId = await resolveDefaultOrganizationId(targetDb, { actor: actorScope, ctx, env, fallback: '' });
      const payload = readActionPayload(ctx);

      const rawProvider = String(payload.provider || '').trim().toLowerCase();
      const preset = QUICK_CONNECT_PROVIDER_PRESETS[rawProvider];
      if (!preset) {
        throw failTool(
          'LLM_PROVIDER_UNSUPPORTED',
          400,
          `Provider "${rawProvider || '(trống)'}" không được hỗ trợ. Hỗ trợ: openai, openai-completions, google-genai, anthropic, deepseek, ollama, 9router.`,
        );
      }

      const apiKey = String(payload.apiKey || '').trim();
      if (preset.requireKey && !apiKey) {
        throw failTool('LLM_API_KEY_REQUIRED', 400, `Cần nhập API Key cho nhà cung cấp "${rawProvider}".`);
      }

      const fallbackBase = rawProvider === '9router' || rawProvider === 'openai-completions'
        ? (String(env?.AGENT_BASE_URL || '').trim() || preset.defaultBaseURL)
        : preset.defaultBaseURL;
      const rawBase = String(payload.baseURL || payload.baseUrl || fallbackBase).trim();
      const baseURL = validateQuickConnectBaseUrl(rawBase);

      const serviceName = String(payload.serviceName || preset.defaultServiceName).trim().toLowerCase();
      if (!QUICK_CONNECT_SERVICE_RE.test(serviceName)) {
        throw failTool('LLM_SERVICE_NAME_INVALID', 400, 'serviceName chỉ được gồm 2-63 ký tự [a-z0-9_-].');
      }

      const modelName = String(payload.modelName || preset.defaultModelName).trim();
      if (!modelName) {
        throw failTool('LLM_MODEL_REQUIRED', 400, 'Cần nhập modelName hợp lệ.');
      }
      const serviceTitle = String(payload.title || preset.defaultTitle).trim().slice(0, 120) || serviceName;

      const llmRepo = targetDb?.getRepository?.('llmServices');
      if (!llmRepo) {
        throw failTool('NO_LLM_SERVICE', 503, 'Repository llmServices chưa sẵn sàng.');
      }

      await runWithSystemRlsBypass(targetDb, async (transaction) => {
        const txOpt = transaction ? { transaction } : {};
        const existing = typeof llmRepo.findOne === 'function'
          ? await llmRepo.findOne({ filter: { name: serviceName }, ...txOpt }).catch(() => null)
          : null;
        const existingOpts = existing && typeof val(existing, 'options') === 'object' ? val(existing, 'options') : {};
        const existingEnabledModels = existing && typeof val(existing, 'enabledModels') === 'object' ? val(existing, 'enabledModels') : {};
        const prevModels = Array.isArray(existingEnabledModels?.models) ? existingEnabledModels.models : [];
        const modelEntries = [];
        const seenModels = new Set();
        for (const m of [{ label: `${modelName} (${serviceTitle})`, value: modelName }, ...prevModels]) {
          const mv = typeof m === 'string' ? m.trim() : String(m?.value || m?.model || '').trim();
          if (!mv || seenModels.has(mv)) continue;
          seenModels.add(mv);
          modelEntries.push(typeof m === 'string' ? { label: mv, value: mv } : { label: String(m?.label || mv), value: mv });
        }

        const values = {
          name: serviceName,
          title: serviceTitle,
          provider: preset.storedProvider,
          options: {
            ...(existingOpts || {}),
            baseURL,
            ...(apiKey ? { apiKey } : {}),
          },
          enabledModels: {
            mode: 'custom',
            models: modelEntries,
          },
          enabled: true,
        };
        if (existing && typeof existing.update === 'function') {
          await existing.update(values, txOpt);
        } else {
          await llmRepo.create({ values, ...txOpt });
        }
      });

      const rebindRes = await rebindStarterAgentsToService(targetDb, {
        llmService: serviceName,
        modelName,
        actorUser,
        defaultOrigin: env?.NOCOBASE_INTERNAL_URL || '',
        preserveActiveArchitect: false,
        adminToolNames: ADMIN_BUILDER_TOOL_NAMES,
      });

      const shouldTest = Boolean(payload.testConnection);
      const health = shouldTest
        ? await probeLlmHealth(targetDb, {
          env,
          fetchImpl,
          isAdmin: true,
          llmServiceName: serviceName,
          modelName,
        })
        : null;

      await recordAiAuditLog(targetDb, {
        actorUserId: val(actorUser, 'id') ?? null,
        actorUsername: val(actorUser, 'username') || null,
        organizationId: organizationId || null,
        channel: 'studio-sync',
        aiEmployee: 'dxos-architect',
        toolName: 'dxosAi:quickConnectLlm',
        argsSummary: {
          serviceName,
          provider: preset.storedProvider,
          modelName,
          baseURL,
          testConnection: shouldTest,
          hasApiKey: Boolean(apiKey),
        },
        status: 'allowed',
        resultSummary: `Quick-connected LLM ${serviceName} (${preset.storedProvider}/${modelName}); rebound ${rebindRes.reboundAgents.length} starter agents`,
      });

      ctx.body = {
        service: {
          name: serviceName,
          title: serviceTitle,
          provider: preset.storedProvider,
          modelName,
          baseURL,
          enabled: true,
        },
        reboundAgents: rebindRes.reboundAgents,
        health,
      };
      if (typeof next === 'function') await next();
    },

    async listBuiltApps(ctx, next) {
      if (ctx.method && String(ctx.method).toUpperCase() !== 'GET') {
        throw failTool('METHOD_NOT_ALLOWED', 405, 'Cần phương thức GET.');
      }
      const targetDb = await requireAdmin(ctx);
      const actor = await resolveActorScope(ctx, targetDb);
      const payload = readActionPayload(ctx);
      const requestedOrg = String(ctx?.action?.params?.organizationId || payload.organizationId || '').trim();
      if (!isRootActor(actor) && requestedOrg && requestedOrg !== actor.organizationId) {
        throw failTool('DXOS_ORG_MISMATCH', 403, 'Không được phép xem ứng dụng của tổ chức khác.');
      }
      const effectiveActor = isRootActor(actor) && requestedOrg ? { ...actor, organizationId: requestedOrg } : actor;
      const status = String(ctx?.action?.params?.status || payload.status || '').trim() || undefined;
      ctx.body = await listBuiltAppsRegistry(targetDb, effectiveActor, { status });
      if (typeof next === 'function') await next();
    },

    async rebuildBuiltApp(ctx, next) {
      if (ctx.method && String(ctx.method).toUpperCase() !== 'POST') {
        throw failTool('METHOD_NOT_ALLOWED', 405, 'Cần phương thức POST.');
      }
      const targetDb = await requireAdmin(ctx);
      const actor = await resolveActorScope(ctx, targetDb);
      const payload = readActionPayload(ctx);
      const requestedOrg = String(payload.organizationId || ctx?.action?.params?.organizationId || '').trim();
      if (!isRootActor(actor) && requestedOrg && requestedOrg !== actor.organizationId) {
        throw failTool('DXOS_ORG_MISMATCH', 403, 'Không được phép dựng lại ứng dụng của tổ chức khác.');
      }
      const effectiveActor = isRootActor(actor) && requestedOrg ? { ...actor, organizationId: requestedOrg } : actor;
      const appKey = String(payload.appKey || ctx?.action?.params?.appKey || ctx?.action?.params?.filterByTk || '').trim();
      if (!appKey) {
        throw failTool('APP_KEY_REQUIRED', 400, 'Cần appKey để dựng lại ứng dụng.');
      }
      ctx.body = await rebuildEnterpriseApp(ctx, targetDb, effectiveActor, {
        appKey,
        specPatch: payload.specPatch || null,
        maxHealRounds: payload.maxHealRounds,
      }, { env, fetchImpl });
      if (typeof next === 'function') await next();
    },

    async exportBuiltAppBundle(ctx, next) {
      if (ctx.method && !['GET', 'POST'].includes(String(ctx.method).toUpperCase())) {
        throw failTool('METHOD_NOT_ALLOWED', 405, 'Cần phương thức GET hoặc POST.');
      }
      const targetDb = await requireAdmin(ctx);
      const actor = await resolveActorScope(ctx, targetDb);
      const payload = readActionPayload(ctx);
      const requestedOrg = String(ctx?.action?.params?.organizationId || payload.organizationId || '').trim();
      if (!isRootActor(actor) && requestedOrg && requestedOrg !== actor.organizationId) {
        throw failTool('DXOS_ORG_MISMATCH', 403, 'Không được phép xuất gói giải pháp của tổ chức khác.');
      }
      const appKey = String(ctx?.action?.params?.appKey || payload.appKey || ctx?.action?.params?.filterByTk || '').trim() || null;
      ctx.body = await exportAppBundle(targetDb, actor, {
        appKey,
        organizationId: requestedOrg || actor.organizationId,
      });
      if (typeof next === 'function') await next();
    },

    async teardownBuiltApp(ctx, next) {
      if (ctx.method && String(ctx.method).toUpperCase() !== 'POST') {
        throw failTool('METHOD_NOT_ALLOWED', 405, 'Cần phương thức POST.');
      }
      const targetDb = await requireAdmin(ctx);
      const actor = await resolveActorScope(ctx, targetDb);
      const payload = readActionPayload(ctx);
      const requestedOrg = String(payload.organizationId || ctx?.action?.params?.organizationId || '').trim();
      if (!isRootActor(actor) && requestedOrg && requestedOrg !== actor.organizationId) {
        throw failTool('DXOS_ORG_MISMATCH', 403, 'Không được phép gỡ ứng dụng của tổ chức khác.');
      }
      const effectiveActor = isRootActor(actor) && requestedOrg ? { ...actor, organizationId: requestedOrg } : actor;
      const appKey = String(payload.appKey || ctx?.action?.params?.appKey || ctx?.action?.params?.filterByTk || '').trim();
      if (!appKey) {
        throw failTool('APP_KEY_REQUIRED', 400, 'Cần appKey để gỡ ứng dụng.');
      }
      const keepData = payload.keepData === false ? false : true;
      ctx.body = await teardownBuiltAppEngine(ctx, targetDb, effectiveActor, { appKey, keepData }, { env, fetchImpl });
      if (typeof next === 'function') await next();
    },
  };
}

module.exports = {
  SUPPORTED_HITL_TOOLS,
  QUICK_CONNECT_PROVIDER_PRESETS,
  validateQuickConnectBaseUrl,
  serializeProfile,
  ensureLocalLlmServiceRecord,
  ensureDefaultAiWorkforce,
  probeLlmHealth,
  upsertAndSyncProfile,
  createDxosAiActions,
};
