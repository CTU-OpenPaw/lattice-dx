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
const {
  STARTER_AI_BLUEPRINTS,
  validateAiProfilePayload,
  recordAiAuditLog,
} = require('./ai-schemas');
const {
  ALL_LDX_ROLES,
  DEFAULT_ADMIN_ROLES,
  val,
  enforceProfileRoleLock,
  syncProfileToNocobaseAi,
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

const TRIAGE_SCAN_ROLES = new Set(['root', 'admin', 'ldx_admin', 'ldx_director', 'ldx_manager', 'ldx_dispatcher']);
const SUPPORTED_HITL_TOOLS = new Set([
  'dxos_execute_record_action',
  'dxos_twin_set_desired',
  'dxos_wms_hold_lot',
  'dxos_alarm_action',
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

async function executeTwinSetpointApproval(targetDb, actor, row, rawArgs) {
  if (row.targetCollection && String(row.targetCollection).trim() !== 'latticeTwinShadows') {
    throw failTool('HITL_ARGS_MISMATCH', 409, 'targetCollection không khớp công cụ dxos_twin_set_desired.');
  }
  const desiredPatch = rawArgs.desiredPatch ?? rawArgs.desired;
  if (!desiredPatch || typeof desiredPatch !== 'object' || Array.isArray(desiredPatch) || !Object.keys(desiredPatch).length) {
    throw failTool('HITL_ARGS_MISMATCH', 409, 'desiredPatch của yêu cầu Digital Twin không hợp lệ.');
  }

  let assetId = rawArgs.assetId != null && String(rawArgs.assetId).trim() !== '' ? Number(rawArgs.assetId) : null;
  let assetEntityId = typeof rawArgs.assetEntityId === 'string' ? rawArgs.assetEntityId.trim() : '';

  const shadowRepo = targetDb?.getRepository?.('latticeTwinShadows');
  let existingShadow = null;
  if (row.targetRecordId != null && shadowRepo && typeof shadowRepo.findOne === 'function') {
    existingShadow = await shadowRepo.findOne({ filterByTk: Number(row.targetRecordId) });
    if (existingShadow) {
      if (val(existingShadow, 'organizationId') !== row.organizationId) {
        throw failTool('DXOS_ORG_MISMATCH', 403, 'Shadow không thuộc phạm vi tổ chức.');
      }
      const shadowEntity = String(val(existingShadow, 'assetEntityId') || '').trim();
      if (assetEntityId && shadowEntity && shadowEntity !== assetEntityId) {
        throw failTool('HITL_ARGS_MISMATCH', 409, 'assetEntityId không khớp bản ghi latticeTwinShadows.');
      }
      if (!assetEntityId && shadowEntity) assetEntityId = shadowEntity;
      if (assetId == null && val(existingShadow, 'assetId') != null) assetId = Number(val(existingShadow, 'assetId'));
    }
  }

  if (!assetEntityId && assetId == null) {
    throw failTool('HITL_ARGS_MISMATCH', 409, 'Thiếu assetId hoặc assetEntityId trong proposedArgs.');
  }
  const urnMatch = assetEntityId ? TWIN_URN_RE.exec(assetEntityId) : null;
  if (urnMatch && urnMatch[1] !== row.organizationId) {
    throw failTool('DXOS_ORG_MISMATCH', 403, 'assetEntityId không thuộc phạm vi tổ chức của hàng chờ HITL.');
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
  if (!existingShadow && typeof shadowRepo.findOne === 'function') {
    existingShadow = await shadowRepo.findOne({ filter: { organizationId: row.organizationId, assetEntityId: resolvedEntityId } });
  }
  const commandId = `cmd-${randomBytes(8).toString('hex')}`;
  const now = new Date();
  if (existingShadow) {
    const prevDesired = val(existingShadow, 'desiredJson') && typeof val(existingShadow, 'desiredJson') === 'object' ? val(existingShadow, 'desiredJson') : {};
    const nextDesired = { ...prevDesired, ...cleanPatch };
    const nextVersion = (Number(val(existingShadow, 'version')) || 1) + 1;
    const patch = {
      desiredJson: nextDesired,
      pendingCommandId: commandId,
      commandStatus: 'dispatched',
      lastDispatchedAt: now,
      version: nextVersion,
      updatedBy: actor.username,
    };
    if (typeof existingShadow.update === 'function') {
      await existingShadow.update(patch);
    } else if (typeof shadowRepo.update === 'function') {
      await shadowRepo.update({ filterByTk: val(existingShadow, 'id'), filter: { organizationId: row.organizationId }, values: patch });
    }
    return { gatedByHitl: false, fallback: true, commandId, desiredJson: nextDesired };
  }

  if (typeof shadowRepo.create !== 'function') {
    throw failTool('TWIN_REPO_UNAVAILABLE', 503, 'Kho Digital Twin shadow chưa hỗ trợ tạo mới.');
  }
  const created = await shadowRepo.create({
    values: {
      organizationId: row.organizationId,
      ...(assetId != null ? { assetId } : {}),
      assetEntityId: resolvedEntityId,
      desiredJson: cleanPatch,
      reportedJson: {},
      lastDeltaJson: {},
      pendingCommandId: commandId,
      commandStatus: 'dispatched',
      lastDispatchedAt: now,
      version: 1,
      updatedBy: actor.username,
    },
  });
  return { gatedByHitl: false, fallback: true, commandId, shadowId: val(created, 'id') ?? null, desiredJson: cleanPatch };
}

async function hasExplicitWmsPolicies(targetDb, roleNames) {
  const resRepo = targetDb?.getRepository?.('dataSourcesRolesResources');
  if (!resRepo || typeof resRepo.find !== 'function' || !Array.isArray(roleNames) || !roleNames.length) {
    return false;
  }
  const rows = (await resRepo.find({
    filter: { name: { $in: ['latticeStockLots', 'latticeOrders', 'latticeAssets'] }, dataSourceKey: 'main' },
    limit: 50,
  })) || [];
  return rows.some((r) => roleNames.includes(val(r, 'roleName')));
}

async function executeWmsHoldLotApproval(targetDb, ctx, actor, row, rawArgs) {
  if (row.targetCollection && String(row.targetCollection).trim() !== 'latticeStockLots') {
    throw failTool('HITL_ARGS_MISMATCH', 409, 'targetCollection không khớp công cụ dxos_wms_hold_lot.');
  }
  const argsLotId = rawArgs.lotId != null && String(rawArgs.lotId).trim() !== '' ? Number(rawArgs.lotId) : null;
  const rowRecId = row.targetRecordId != null ? Number(row.targetRecordId) : null;
  if (rowRecId != null && argsLotId != null && argsLotId !== rowRecId) {
    throw failTool('HITL_ARGS_MISMATCH', 409, 'lotId trong proposedArgs không khớp targetRecordId.');
  }
  const lotId = argsLotId ?? rowRecId;
  const lotCode = typeof rawArgs.lotCode === 'string' ? rawArgs.lotCode.trim() : '';
  if (lotId == null && !lotCode) {
    throw failTool('HITL_ARGS_MISMATCH', 409, 'Thiếu lotId hoặc lotCode trong proposedArgs.');
  }

  const wmsMod = loadCrossPluginModule(resolveCrossPluginCandidates('plugin-dxos-studio', 'wms-engine'));
  if (wmsMod && typeof wmsMod.holdLotByMkt === 'function') {
    return wmsMod.holdLotByMkt(targetDb, {
      organizationId: row.organizationId,
      actor: { ...actor, organizationId: row.organizationId },
      lotId,
      lotCode: lotCode || undefined,
      maxAllowedC: rawArgs.maxAllowedC,
      samplesC: rawArgs.samplesC,
      forceHold: rawArgs.forceHold !== undefined
        ? Boolean(rawArgs.forceHold)
        : (!Array.isArray(rawArgs.samplesC) || !rawArgs.samplesC.length),
      reason: rawArgs.reason || `HITL approved hold (#${row.id})`,
      hitlApproved: true,
    });
  }
  if (wmsMod && typeof wmsMod.createDxosWmsActions === 'function') {
    const wmsActions = wmsMod.createDxosWmsActions(targetDb);
    if (typeof wmsActions?.holdLotByMkt === 'function') {
      const explicitPolicies = await hasExplicitWmsPolicies(targetDb, actor.roleNames);
      const subCtx = {
        app: ctx.app,
        db: targetDb,
        method: 'POST',
        can: typeof ctx?.can === 'function' ? ctx.can : (!explicitPolicies ? () => isHitlApprover(actor) : undefined),
        state: {
          ...(ctx.state || {}),
          currentUser: { id: actor.userId, username: actor.username },
          currentRoles: actor.roleNames || [],
          currentRole: actor.isRoot ? 'root' : (actor.roleNames?.[0] || ''),
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

  const lotRepo = targetDb?.getRepository?.('latticeStockLots');
  if (!lotRepo) throw failTool('WMS_REPO_UNAVAILABLE', 503, 'Kho lô hàng (latticeStockLots) chưa sẵn sàng.');
  const filter = lotId != null ? { organizationId: row.organizationId, id: lotId } : { organizationId: row.organizationId, lotCode };
  const lot = typeof lotRepo.findOne === 'function' ? await lotRepo.findOne({ filter }) : null;
  if (!lot || val(lot, 'organizationId') !== row.organizationId) {
    throw failTool('WMS_LOT_NOT_FOUND', 404, 'Không tìm thấy lô hàng trong phạm vi tổ chức.');
  }
  if (lotCode && val(lot, 'lotCode') && val(lot, 'lotCode') !== lotCode) {
    throw failTool('HITL_ARGS_MISMATCH', 409, 'lotCode không khớp bản ghi lô hàng.');
  }
  const patch = {
    status: 'hold_mkt',
    holdReason: String(rawArgs.reason || `HITL approved hold (#${row.id})`).slice(0, 255),
    heldAt: new Date(),
    heldBy: actor.username,
  };
  if (typeof lot.update === 'function') {
    await lot.update(patch);
  } else if (typeof lotRepo.update === 'function') {
    await lotRepo.update({ filterByTk: val(lot, 'id'), filter: { organizationId: row.organizationId }, values: patch });
  }
  return {
    held: true,
    fallback: true,
    lotId: val(lot, 'id') ?? lotId,
    lotCode: val(lot, 'lotCode') || lotCode,
    lotStatus: 'hold_mkt',
  };
}

async function executeAlarmActionApproval(targetDb, actor, row, rawArgs) {
  if (row.targetCollection && String(row.targetCollection).trim() !== 'latticeIncidentCases') {
    throw failTool('HITL_ARGS_MISMATCH', 409, 'targetCollection không khớp công cụ dxos_alarm_action.');
  }
  const actionOp = String(rawArgs.action || '').trim().toLowerCase();
  if (actionOp !== 'ack' && actionOp !== 'clear') {
    throw failTool('HITL_ARGS_MISMATCH', 409, 'action của dxos_alarm_action phải là ack hoặc clear.');
  }
  const argsAlarmId = rawArgs.alarmId != null && String(rawArgs.alarmId).trim() !== '' ? Number(rawArgs.alarmId) : null;
  const rowRecId = row.targetRecordId != null ? Number(row.targetRecordId) : null;
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
  if (alarmCode && val(alarmRow, 'code') && val(alarmRow, 'code') !== alarmCode) {
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

  const curStatus = String(val(alarmRow, 'status') || 'open').toLowerCase();
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
        acknowledgedAt: val(alarmRow, 'acknowledgedAt') || now,
        acknowledgedBy: String(actor.username || 'operator').slice(0, 120),
        ...(note ? { resolutionNote: note.slice(0, 255) } : {}),
      };
  if (typeof alarmRow.update === 'function') {
    await alarmRow.update(patch);
  } else if (typeof incRepo.update === 'function') {
    await incRepo.update({ filterByTk: val(alarmRow, 'id'), filter: { organizationId: row.organizationId }, values: patch });
  }
  return {
    id: val(alarmRow, 'id'),
    code: val(alarmRow, 'code'),
    status: patch.status,
    fallback: true,
  };
}

function serializeProfile(row) {
  if (!row) return null;
  return {
    id: val(row, 'id') ?? null,
    username: val(row, 'username'),
    nickname: val(row, 'nickname'),
    position: val(row, 'position') || '',
    departmentScope: val(row, 'departmentScope') || 'general',
    organizationId: val(row, 'organizationId') || 'native-ui-lab',
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
    toolPermissions: val(row, 'toolPermissions') && typeof val(row, 'toolPermissions') === 'object' ? val(row, 'toolPermissions') : {},
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

async function upsertAndSyncProfile(db, input, { actorUser, defaultOrigin, auditToolName = 'dxosAi:saveProfile' } = {}) {
  const validated = validateAiProfilePayload(input, { adminToolNames: ADMIN_BUILDER_TOOL_NAMES });
  const locked = enforceProfileRoleLock(validated, ADMIN_BUILDER_TOOL_NAMES);
  const profileRepo = db?.getRepository?.('latticeAiProfiles');
  let savedRow = locked;

  if (profileRepo) {
    const existing = await profileRepo.findOne({ filter: { username: locked.username } });
    const nextVersion = existing ? (Number(val(existing, 'version')) || 1) + 1 : locked.version;
    const recordValues = { ...locked, version: nextVersion };
    if (existing && typeof existing.update === 'function') {
      savedRow = await existing.update(recordValues);
    } else {
      savedRow = await profileRepo.create({ values: recordValues });
    }
  }

  const normalized = serializeProfile(savedRow) || locked;
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
  if (typeof targetDb?.sequelize?.query === 'function') {
    try {
      const [rows] = await targetDb.sequelize.query(
        `SELECT COUNT(*)::int AS records,
                COALESCE(SUM("promptTokens"), 0)::bigint AS "promptTokens",
                COALESCE(SUM("completionTokens"), 0)::bigint AS "completionTokens",
                COALESCE(SUM("estimatedCostUsd"), 0)::double precision AS "estimatedCostUsd",
                COALESCE(SUM("piiRedactedCount"), 0)::int AS "piiRedactedCount"
         FROM "latticeAiAuditLogs"
         WHERE "organizationId" = :organizationId;`,
        { replacements: { organizationId } },
      );
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

  async function runHitlDecision(ctx, decision, buildExecutor) {
    if (ctx.method && String(ctx.method).toUpperCase() !== 'POST') {
      throw failTool('METHOD_NOT_ALLOWED', 405, 'Cần phương thức POST.');
    }
    const targetDb = resolveDb(ctx);
    const actor = await resolveActorScope(ctx, targetDb);
    const payload = readActionPayload(ctx);
    const approvalId = payload.approvalId ?? payload.id ?? ctx?.action?.params?.approvalId ?? ctx?.action?.params?.filterByTk;
    const note = payload.note ?? payload.decisionNote ?? payload.reason ?? '';
    return decideApproval(targetDb, {
      actor,
      approvalId,
      decision,
      note,
      ...(typeof buildExecutor === 'function' ? { executeApprovedWrite: buildExecutor(targetDb, actor) } : {}),
    });
  }

  return {
    async listProfiles(ctx, next) {
      const targetDb = await requireAdmin(ctx);
      const repo = targetDb?.getRepository?.('latticeAiProfiles');
      const rows = repo ? (await repo.find({ sort: ['username'] })) || [] : [];
      ctx.body = {
        profiles: rows.map(serializeProfile),
        catalog: buildCatalogMeta(),
      };
      if (typeof next === 'function') await next();
    },

    async saveProfile(ctx, next) {
      const targetDb = await requireAdmin(ctx);
      const actorUser = ctx?.state?.currentUser || ctx?.auth?.user;
      const payload = readActionPayload(ctx);
      const defaultOrigin = env?.NOCOBASE_INTERNAL_URL;
      ctx.body = await upsertAndSyncProfile(targetDb, payload, { actorUser, defaultOrigin });
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
      const defaultOrigin = env?.NOCOBASE_INTERNAL_URL;

      const profiles = [];
      for (const bp of STARTER_AI_BLUEPRINTS) {
        const res = await upsertAndSyncProfile(targetDb, bp, {
          actorUser,
          defaultOrigin,
          auditToolName: null,
        });
        profiles.push(res.profile.username);
      }

      const llm = await ensureLocalLlmServiceRecord(targetDb, env);
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

    async portalCopilot(ctx, next) {
      const targetDb = resolveDb(ctx);
      const user = ctx?.state?.currentUser || ctx?.auth?.user;
      const userId = val(user, 'id');
      if (!userId) {
        throw failTool('NATIVE_LOGIN_REQUIRED', 401, 'Yêu cầu đăng nhập để xem danh sách AI hỗ trợ.');
      }

      const roleNames = await resolveCallerRoleNames(ctx, targetDb, userId);
      const callerIsAdmin = await isStudioAdmin(ctx, targetDb);
      const payload = readActionPayload(ctx);
      const portalSlug = String(ctx?.action?.params?.portalSlug || payload.portalSlug || '').trim().toLowerCase();

      const repo = targetDb?.getRepository?.('latticeAiProfiles');
      const rows = repo ? (await repo.find({ filter: { enabled: true }, sort: ['username'] })) || [] : [];
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
      const params = ctx?.action?.params || {};
      const filter = {};
      if (params.channel) filter.channel = String(params.channel).trim();
      if (params.status) filter.status = String(params.status).trim();
      if (params.toolName) filter.toolName = String(params.toolName).trim();
      const limit = Math.max(1, Math.min(200, Number(params.pageSize || params.limit) || 50));

      const repo = targetDb?.getRepository?.('latticeAiAuditLogs');
      const rows = repo ? (await repo.find({ filter, sort: ['-id'], limit })) || [] : [];
      ctx.body = { items: rows.map(serializeAuditLog) };
      if (typeof next === 'function') await next();
    },

    async quotaSummary(ctx, next) {
      const targetDb = await requireAdmin(ctx);
      const params = readActionPayload(ctx);
      const requestedOrg = String(ctx?.action?.params?.organizationId || params.organizationId || 'native-ui-lab').trim();
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
      ctx.body = await buildEnterpriseTopology(targetDb, env, fetchImpl, ctx?.app);
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
          return executeTwinSetpointApproval(targetDb, actor, row, rawArgs);
        }
        if (row.toolName === 'dxos_wms_hold_lot') {
          return executeWmsHoldLotApproval(targetDb, ctx, actor, row, rawArgs);
        }
        if (row.toolName === 'dxos_alarm_action') {
          return executeAlarmActionApproval(targetDb, actor, row, rawArgs);
        }

        const argsCol = String(rawArgs.collection || '').trim();
        const argsOp = String(rawArgs.operation || '').trim();
        const argsRecId = rawArgs.recordId != null && String(rawArgs.recordId).trim() !== '' ? Number(rawArgs.recordId) : null;
        const rowRecId = row.targetRecordId != null ? Number(row.targetRecordId) : null;
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
  };
}

module.exports = {
  serializeProfile,
  ensureLocalLlmServiceRecord,
  upsertAndSyncProfile,
  createDxosAiActions,
};
