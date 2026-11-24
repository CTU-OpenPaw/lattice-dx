/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { createHash } = require('node:crypto');
const path = require('node:path');
const { enqueueAiApproval } = require('./ai-hitl');
const { redactPiiText, redactPiiDeep } = require('./ai-governance');

const val = (row, key) => (typeof row?.get === 'function' ? row.get(key) : row?.[key]);

const orgSweepLocks = new Map();

const TRIAGE_DEDUP_WINDOW_MS = 30 * 60 * 1000;
const ACTIVE_ALARM_STATUSES = new Set(['open', 'acknowledged']);
const INACTIVE_LOT_STATUSES = new Set(['hold_mkt', 'expired', 'quarantined', 'depleted']);
const SEVERITY_RANK = Object.freeze({ critical: 4, high: 3, medium: 2, low: 1 });
const ORG_ID_RE = /^[a-zA-Z0-9_-]{1,80}$/;
const URN_RE = /^urn:ngsi-ld:Asset:([a-zA-Z0-9_-]{1,80}):native:([1-9]\d{0,18})$/;
const LEDGER_SECURITY_INVARIANTS = new Set([
  'PKI_MASTER_KEY_MISSING',
  'PKI_KEY_INACTIVE',
  'PKI_CIPHERTEXT_INVALID',
  'LEDGER_IMMUTABLE',
  'NATIVE_ORGANIZATION_MISMATCH',
  'NATIVE_TENANT_REQUIRED',
]);

function failTriage(code, status = 400, message = code) {
  return Object.assign(new Error(message || code), { code, status });
}

function parseFinite(raw) {
  if (raw === null || raw === undefined || typeof raw === 'boolean' || typeof raw === 'object') return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function isSecurityInvariant(err) {
  return Boolean(err && typeof err.code === 'string' && LEDGER_SECURITY_INVARIANTS.has(err.code));
}

function loadSiblingModule(candidates) {
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

function loadFoundationDataGovernance() {
  const inDist = __dirname.includes(`${path.sep}dist${path.sep}`);
  const candidates = inDist
    ? [
        '@latticedx/plugin-lattice-foundation/dist/server/data-governance',
        '@latticedx/plugin-lattice-foundation/src/server/data-governance',
        '../../../plugin-lattice-foundation/dist/server/data-governance',
        '../../../plugin-lattice-foundation/src/server/data-governance',
      ]
    : [
        '@latticedx/plugin-lattice-foundation/src/server/data-governance',
        '../../../plugin-lattice-foundation/src/server/data-governance',
        '../../../plugin-lattice-foundation/dist/server/data-governance',
      ];
  return loadSiblingModule(candidates);
}

async function recordTriageLineageSafely(db, {
  organizationId,
  alarmId,
  alarmCode,
  approvalId,
  metadataJson,
} = {}) {
  if (!organizationId || approvalId == null) return null;
  const sourceRecordId = String(alarmId ?? alarmCode ?? '');
  const targetRecordId = String(approvalId);
  if (!sourceRecordId || !targetRecordId) return null;

  const dataGov = loadFoundationDataGovernance();
  if (dataGov && typeof dataGov.recordLineageEdge === 'function') {
    try {
      return await dataGov.recordLineageEdge(db, {
        organizationId,
        sourceCollection: 'latticeIncidentCases',
        sourceRecordId,
        targetCollection: 'latticeAiApprovalQueue',
        targetRecordId,
        relationType: 'triaged_into',
        actorName: 'dxos-coordinator',
        metadataJson,
      });
    } catch (err) {
      if (isSecurityInvariant(err)) throw err;
      return null;
    }
  }

  const lineageRepo = db?.getRepository?.('latticeDataLineage');
  if (!lineageRepo || typeof lineageRepo.create !== 'function') return null;

  const edgeUid = `lin-${createHash('sha256')
    .update(`${organizationId}|latticeIncidentCases|${sourceRecordId}|latticeAiApprovalQueue|${targetRecordId}|triaged_into`)
    .digest('hex')
    .slice(0, 32)}`;
  try {
    if (typeof lineageRepo.findOne === 'function') {
      const existing = await lineageRepo.findOne({ filter: { organizationId, edgeUid } });
      if (existing) return existing;
    }
    return await lineageRepo.create({
      values: {
        organizationId,
        edgeUid,
        sourceCollection: 'latticeIncidentCases',
        sourceRecordId,
        targetCollection: 'latticeAiApprovalQueue',
        targetRecordId,
        relationType: 'triaged_into',
        actorName: 'dxos-coordinator',
        metadataJson: metadataJson || null,
        observedAt: new Date(),
      },
    });
  } catch (err) {
    if (isSecurityInvariant(err)) throw err;
    return null;
  }
}

async function updateIncidentProposalSafely(incRepo, alarmRow, proposalText) {
  const safeProposal = redactPiiText(String(proposalText || '')).text.slice(0, 500);
  const patch = { proposal: safeProposal };
  if (typeof alarmRow?.update === 'function') {
    await alarmRow.update(patch);
    return;
  }
  const id = val(alarmRow, 'id');
  const organizationId = val(alarmRow, 'organizationId');
  if (incRepo && typeof incRepo.update === 'function' && id != null) {
    await incRepo.update({ filterByTk: id, filter: { organizationId }, values: patch });
  }
}

async function correlateAlarmContext(db, organizationId, alarm) {
  const rawAssetId = val(alarm, 'assetId');
  let assetId = rawAssetId != null && /^[1-9]\d*$/.test(String(rawAssetId)) ? Number(rawAssetId) : null;
  let assetEntityId = String(val(alarm, 'assetEntityId') || '').trim();
  const urnMatch = URN_RE.exec(assetEntityId);
  if (assetId == null && urnMatch && urnMatch[1] === organizationId) {
    assetId = Number(urnMatch[2]);
  }

  let asset = null;
  const assetRepo = db?.getRepository?.('latticeAssets');
  if (assetRepo && typeof assetRepo.findOne === 'function') {
    const assetCol = db?.getCollection?.('latticeAssets');
    const hasEntityIdCol = assetCol
      ? Boolean(assetCol.hasField?.('entityId') || assetCol.getField?.('entityId'))
      : true;
    if (assetId != null) {
      asset = await assetRepo.findOne({ filter: { id: assetId, organizationId } });
    }
    if (!asset && assetEntityId) {
      if (hasEntityIdCol) {
        asset = await assetRepo.findOne({ filter: { organizationId, entityId: assetEntityId } });
      }
      if (!asset && !assetEntityId.includes(':')) {
        asset = await assetRepo.findOne({ filter: { organizationId, code: assetEntityId } });
      }
    }
    if (asset && val(asset, 'organizationId') !== organizationId) asset = null;
    if (asset && assetId == null && val(asset, 'id') != null) {
      assetId = Number(val(asset, 'id'));
    }
    if (asset && !assetEntityId) {
      assetEntityId = String(val(asset, 'entityId') || '').trim();
    }
  }

  let shadow = null;
  const shadowRepo = db?.getRepository?.('latticeTwinShadows');
  if (shadowRepo) {
    if (typeof shadowRepo.findOne === 'function' && assetEntityId) {
      shadow = await shadowRepo.findOne({ filter: { organizationId, assetEntityId } });
    }
    if (!shadow && typeof shadowRepo.findOne === 'function' && assetId != null) {
      shadow = await shadowRepo.findOne({ filter: { organizationId, assetId } });
    }
    if (shadow && val(shadow, 'organizationId') !== organizationId) shadow = null;
  }

  const stockLots = [];
  const lotRepo = db?.getRepository?.('latticeStockLots');
  if (lotRepo && typeof lotRepo.find === 'function') {
    const lotRows = (await lotRepo.find({ filter: { organizationId }, limit: 200, sort: ['expiryDate', 'id'] })) || [];
    for (const lot of lotRows) {
      if (val(lot, 'organizationId') !== organizationId) continue;
      const lotEntity = String(val(lot, 'assetEntityId') || '').trim();
      const lotCode = String(val(lot, 'lotCode') || '').trim();
      const lotAssetMatches = (assetEntityId && (lotEntity === assetEntityId || (lotCode && assetEntityId === `lot:${lotCode}`)))
        || (assetId != null && lotEntity === `urn:ngsi-ld:Asset:${organizationId}:native:${assetId}`);
      if (lotAssetMatches) stockLots.push(lot);
    }
  }

  let latestTelemetry = null;
  const tsRepo = db?.getRepository?.('latticeTelemetryPoints');
  if (tsRepo && typeof tsRepo.find === 'function' && assetEntityId) {
    const pts = (await tsRepo.find({
      filter: { organizationId, assetEntityId, metricName: 'temperature' },
      sort: ['-observedAt', '-id'],
      limit: 5,
    })) || [];
    latestTelemetry = pts.find((p) => val(p, 'organizationId') === organizationId && val(p, 'assetEntityId') === assetEntityId) || null;
  }

  const lineageEdges = [];
  const downstreamOrderMap = new Map();
  const lotIdSet = new Set(stockLots.map((l) => String(val(l, 'id'))).filter(Boolean));
  const lotCodeSet = new Set(stockLots.map((l) => String(val(l, 'lotCode') || '')).filter(Boolean));

  const lineRepo = db?.getRepository?.('latticeOrderLines');
  if (lineRepo && typeof lineRepo.find === 'function' && (lotIdSet.size || lotCodeSet.size)) {
    const lineRows = (await lineRepo.find({ filter: { organizationId }, limit: 200, sort: ['-id'] })) || [];
    for (const ln of lineRows) {
      if (val(ln, 'organizationId') !== organizationId) continue;
      const lnLotId = val(ln, 'lotId') != null ? String(val(ln, 'lotId')) : '';
      const lnLotCode = String(val(ln, 'lotCode') || '');
      if (!lotIdSet.has(lnLotId) && !lotCodeSet.has(lnLotCode)) continue;
      const orderId = val(ln, 'orderId') ?? null;
      const orderCode = val(ln, 'orderCode') || (orderId != null ? `ORD-${orderId}` : null);
      if (orderId != null || orderCode) {
        const key = String(orderId ?? orderCode);
        if (!downstreamOrderMap.has(key)) {
          downstreamOrderMap.set(key, { orderId, orderCode });
        }
      }
    }
  }

  const lineageRepo = db?.getRepository?.('latticeDataLineage');
  if (lineageRepo && typeof lineageRepo.find === 'function') {
    const allEdges = (await lineageRepo.find({ filter: { organizationId }, limit: 200, sort: ['-id'] })) || [];
    const alarmIdStr = val(alarm, 'id') != null ? String(val(alarm, 'id')) : '';
    for (const edge of allEdges) {
      if (val(edge, 'organizationId') !== organizationId) continue;
      const srcCol = val(edge, 'sourceCollection');
      const srcId = String(val(edge, 'sourceRecordId') ?? '');
      const tgtCol = val(edge, 'targetCollection');
      const tgtId = String(val(edge, 'targetRecordId') ?? '');
      const matchesLot = srcCol === 'latticeStockLots' && (lotIdSet.has(srcId) || lotCodeSet.has(srcId));
      const matchesAsset = srcCol === 'latticeAssets' && assetId != null && srcId === String(assetId);
      const matchesAlarm = srcCol === 'latticeIncidentCases' && alarmIdStr && srcId === alarmIdStr;
      if (!matchesLot && !matchesAsset && !matchesAlarm) continue;
      lineageEdges.push(edge);
      if (tgtCol === 'latticeOrders' && tgtId) {
        if (!downstreamOrderMap.has(tgtId)) {
          downstreamOrderMap.set(tgtId, { orderId: /^\d+$/.test(tgtId) ? Number(tgtId) : null, orderCode: `ORD-${tgtId}` });
        }
      }
    }
  }

  const ordersRepo = db?.getRepository?.('latticeOrders');
  if (ordersRepo && typeof ordersRepo.findOne === 'function' && downstreamOrderMap.size) {
    for (const [key, entry] of downstreamOrderMap.entries()) {
      if (entry.orderId != null) {
        const ord = await ordersRepo.findOne({ filter: { id: entry.orderId, organizationId } });
        if (ord && val(ord, 'organizationId') === organizationId) {
          entry.orderCode = val(ord, 'code') || entry.orderCode;
          entry.status = val(ord, 'status') || null;
        }
      }
      downstreamOrderMap.set(key, entry);
    }
  }

  return {
    asset,
    shadow,
    stockLots,
    lineageEdges,
    downstreamOrders: [...downstreamOrderMap.values()],
    latestTelemetry,
  };
}

function summarizeLot(lot) {
  return {
    id: val(lot, 'id') ?? null,
    lotCode: val(lot, 'lotCode') || null,
    sku: val(lot, 'sku') || null,
    status: val(lot, 'status') || 'available',
    mktCelsius: parseFinite(val(lot, 'mktCelsius')),
    targetTempMaxC: parseFinite(val(lot, 'targetTempMaxC')),
  };
}

function buildTriageRecommendation({
  alarm,
  asset = null,
  shadow = null,
  stockLots = [],
  lineageEdges = [],
  downstreamOrders = [],
  latestTelemetry = null,
} = {}) {
  const organizationId = String(val(alarm, 'organizationId') || val(shadow, 'organizationId') || '').trim();
  const rawAlarmId = val(alarm, 'id');
  const alarmId = rawAlarmId != null && /^[1-9]\d*$/.test(String(rawAlarmId)) ? Number(rawAlarmId) : null;
  const alarmCode = String(val(alarm, 'code') || (alarmId != null ? `ALM-${alarmId}` : 'ALARM')).trim();
  const alarmName = redactPiiText(String(val(alarm, 'name') || alarmCode).trim()).text;
  const alarmStatus = String(val(alarm, 'status') || 'open').toLowerCase();
  const severityRaw = String(val(alarm, 'severity') || 'medium').toLowerCase();
  const severity = SEVERITY_RANK[severityRaw] ? severityRaw : 'medium';
  const riskLevel = severity === 'critical' ? 'critical' : 'high';
  const assetEntityId = String(val(alarm, 'assetEntityId') || val(asset, 'entityId') || val(shadow, 'assetEntityId') || '').trim();
  const rawAssetId = val(alarm, 'assetId') ?? val(asset, 'id') ?? val(shadow, 'assetId');
  const urnMatch = URN_RE.exec(assetEntityId);
  const assetId = rawAssetId != null && /^[1-9]\d*$/.test(String(rawAssetId))
    ? Number(rawAssetId)
    : (urnMatch ? Number(urnMatch[2]) : null);
  const assetLabel = redactPiiText(
    String(val(asset, 'code') || val(asset, 'name') || assetEntityId || (assetId != null ? `Asset #${assetId}` : 'thiết bị')),
  ).text;

  const sameOrgLots = (Array.isArray(stockLots) ? stockLots : []).filter(
    (l) => !organizationId || !val(l, 'organizationId') || val(l, 'organizationId') === organizationId,
  );
  const activeLots = sameOrgLots.filter(
    (l) => val(l, 'active') !== false && !INACTIVE_LOT_STATUSES.has(String(val(l, 'status') || 'available').toLowerCase()),
  );
  const affectedLots = (activeLots.length ? activeLots : sameOrgLots).map(summarizeLot);

  const desiredJson = val(shadow, 'desiredJson') && typeof val(shadow, 'desiredJson') === 'object' ? val(shadow, 'desiredJson') : {};
  const reportedJson = val(shadow, 'reportedJson') && typeof val(shadow, 'reportedJson') === 'object' ? val(shadow, 'reportedJson') : {};
  const observedTemp = parseFinite(reportedJson.temperature ?? reportedJson.tempC ?? val(latestTelemetry, 'numericValue') ?? reportedJson.targetTempC);
  const desiredTargetTemp = parseFinite(desiredJson.targetTempC ?? reportedJson.targetTempC);
  const alarmText = `${alarmName} ${redactPiiText(String(val(alarm, 'proposal') || '')).text}`.toLowerCase();

  const lotOverMax = activeLots.some((l) => {
    const maxC = parseFinite(val(l, 'targetTempMaxC'));
    const mkt = parseFinite(val(l, 'mktCelsius'));
    return maxC !== null && ((observedTemp !== null && observedTemp > maxC) || (mkt !== null && mkt > maxC));
  });
  const twinDrift = observedTemp !== null && desiredTargetTemp !== null && (observedTemp - desiredTargetTemp) > 2;
  const mentionsThermal = /temp|nhiet|nhiệt|excursion|thaw|warm|nong|nóng|overtemp|chiller|setpoint|lạnh|lanh/.test(alarmText);
  const isTempExcursion = lotOverMax || twinDrift || mentionsThermal;

  const orderTags = (Array.isArray(downstreamOrders) ? downstreamOrders : [])
    .map((o) => o?.orderCode || (o?.orderId != null ? `ORD-${o.orderId}` : null))
    .filter(Boolean);
  const lotTags = affectedLots.map((l) => l.lotCode).filter(Boolean);

  const contextParts = [
    `[${alarmCode} · ${severity.toUpperCase()}] Thiết bị ${assetLabel}`,
    observedTemp !== null ? `nhiệt độ ghi nhận ${observedTemp}°C` : null,
    desiredTargetTemp !== null ? `setpoint ${desiredTargetTemp}°C` : null,
    lotTags.length ? `lô liên quan: ${lotTags.join(', ')}` : null,
    orderTags.length ? `đơn hàng ảnh hưởng: ${orderTags.join(', ')}` : null,
    Array.isArray(lineageEdges) && lineageEdges.length ? `${lineageEdges.length} liên kết phả hệ` : null,
    alarmName && alarmName !== alarmCode ? alarmName : null,
  ].filter(Boolean);
  const causalSummary = redactPiiText(contextParts.join(' · ')).text.slice(0, 300);

  if (activeLots.length > 0 && (isTempExcursion || severity === 'critical' || severity === 'high')) {
    const sortedLots = [...activeLots].sort((a, b) => {
      const mktA = parseFinite(val(a, 'mktCelsius'));
      const mktB = parseFinite(val(b, 'mktCelsius'));
      if (mktA !== null && mktB !== null && mktB !== mktA) return mktB - mktA;
      return Number(val(a, 'id') || 0) - Number(val(b, 'id') || 0);
    });
    const primaryLot = sortedLots[0];
    const lotId = val(primaryLot, 'id') != null ? Number(val(primaryLot, 'id')) : null;
    const lotCode = String(val(primaryLot, 'lotCode') || (lotId != null ? `LOT-${lotId}` : '')).trim();
    const maxAllowedC = parseFinite(val(primaryLot, 'targetTempMaxC'));
    const reason = redactPiiText(
      `Proactive Triage ${alarmCode}: Tạm giữ MKT lô ${lotCode || `#${lotId}`} do cảnh báo ${severity} trên ${assetLabel}`,
    ).text.slice(0, 255);
    const proposalText = redactPiiText(
      `AI đề xuất tạm giữ MKT lô ${lotCode || `#${lotId}`} (${activeLots.length} lô liên quan) qua phê duyệt HITL. ${causalSummary}`,
    ).text.slice(0, 500);
    const diffPreview = redactPiiDeep({
      summary: causalSummary,
      affectedLots,
      downstreamOrders,
      changes: [
        { field: 'status', before: String(val(primaryLot, 'status') || 'available'), after: 'hold_mkt' },
        { field: 'holdReason', before: val(primaryLot, 'holdReason') || null, after: reason },
      ],
    }).value;

    return {
      alarmId,
      alarmCode,
      severity,
      riskLevel,
      toolName: 'dxos_wms_hold_lot',
      targetCollection: 'latticeStockLots',
      targetRecordId: lotId,
      operation: 'update',
      causalSummary,
      proposalText,
      proposedArgs: {
        ...(lotId != null ? { lotId } : {}),
        ...(lotCode ? { lotCode } : {}),
        organizationId,
        ...(assetEntityId ? { assetEntityId } : {}),
        forceHold: true,
        ...(maxAllowedC !== null ? { maxAllowedC } : {}),
        reason,
        alarmId,
        alarmCode,
      },
      diffPreview,
    };
  }

  const shadowId = val(shadow, 'id') != null ? Number(val(shadow, 'id')) : null;
  const shadowStatus = String(val(shadow, 'commandStatus') || '').toLowerCase();
  if (
    (shadow || assetEntityId)
    && shadowStatus !== 'pending_hitl'
    && shadowStatus !== 'dispatched'
    && (isTempExcursion || twinDrift || desiredTargetTemp !== null)
  ) {
    const baseTemp = desiredTargetTemp ?? -18;
    const nextTargetTempC = Number(Math.max(-80, Math.min(120, baseTemp - 2.5)).toFixed(1));
    const desiredPatch = { targetTempC: nextTargetTempC, fanMode: 'high' };
    const proposalText = redactPiiText(
      `AI đề xuất điều chỉnh Digital Twin setpoint ${baseTemp}°C -> ${nextTargetTempC}°C (fanMode=high) qua phê duyệt HITL. ${causalSummary}`,
    ).text.slice(0, 500);
    const diffPreview = redactPiiDeep({
      summary: causalSummary,
      affectedLots,
      downstreamOrders,
      changes: [
        { field: 'desiredJson.targetTempC', before: desiredTargetTemp, after: nextTargetTempC },
        { field: 'desiredJson.fanMode', before: desiredJson.fanMode || null, after: 'high' },
      ],
    }).value;

    return {
      alarmId,
      alarmCode,
      severity,
      riskLevel,
      toolName: 'dxos_twin_set_desired',
      targetCollection: 'latticeTwinShadows',
      targetRecordId: shadowId,
      operation: 'update',
      causalSummary,
      proposalText,
      proposedArgs: {
        ...(assetId != null ? { assetId } : {}),
        ...(assetEntityId ? { assetEntityId } : {}),
        desiredPatch,
        baselineTemp: desiredTargetTemp,
        alarmId,
        alarmCode,
      },
      diffPreview,
    };
  }

  if (!ACTIVE_ALARM_STATUSES.has(alarmStatus) || alarmStatus === 'acknowledged') {
    return null;
  }

  const ackNote = redactPiiText(
    `Proactive Triage ${alarmCode}: Xác nhận tiếp nhận & cử kỹ thuật viên kiểm tra ${assetLabel}.`,
  ).text.slice(0, 255);
  const proposalText = redactPiiText(
    `AI đề xuất xác nhận (ack) cảnh báo ${alarmCode} và kiểm tra hiện trường. ${causalSummary}`,
  ).text.slice(0, 500);
  const diffPreview = redactPiiDeep({
    summary: causalSummary,
    affectedLots,
    downstreamOrders,
    changes: [
      { field: 'status', before: alarmStatus, after: 'acknowledged' },
      { field: 'resolutionNote', before: val(alarm, 'resolutionNote') || null, after: ackNote },
    ],
  }).value;
  return {
    alarmId,
    alarmCode,
    severity,
    riskLevel,
    toolName: 'dxos_alarm_action',
    targetCollection: 'latticeIncidentCases',
    targetRecordId: alarmId,
    operation: 'update',
    causalSummary,
    proposalText,
    proposedArgs: {
      action: 'ack',
      alarmId,
      alarmCode,
      ...(assetEntityId ? { assetEntityId } : {}),
      note: ackNote,
    },
    diffPreview,
  };
}

function buildApprovalDedupKey({ toolName, targetCollection, targetRecordId, proposedArgs, alarmId } = {}) {
  const recId = targetRecordId != null && Number.isFinite(Number(targetRecordId))
    ? `id:${Number(targetRecordId)}`
    : null;
  if (recId) {
    return `${toolName || ''}|${targetCollection || ''}|${recId}`;
  }
  const args = proposedArgs && typeof proposedArgs === 'object' ? proposedArgs : {};
  const targetKey = args.lotCode
    ? `lot:${String(args.lotCode).trim()}`
    : (args.assetEntityId
      ? `ent:${String(args.assetEntityId).trim()}`
      : (args.assetId != null
        ? `asset:${Number(args.assetId)}`
        : (args.alarmCode
          ? `almCode:${String(args.alarmCode).trim()}`
          : `alm:${args.alarmId ?? alarmId ?? ''}`)));
  return `${toolName || ''}|${targetCollection || ''}|${targetKey}`;
}

function isDuplicatePendingApproval(existingRows, rec, dedupWindowMs, nowMs) {
  const recKey = buildApprovalDedupKey({
    toolName: rec.toolName,
    targetCollection: rec.targetCollection,
    targetRecordId: rec.targetRecordId,
    proposedArgs: rec.proposedArgs,
    alarmId: rec.alarmId,
  });
  for (const row of existingRows) {
    if (String(val(row, 'status') || '').toLowerCase() !== 'pending') continue;
    const qArgs = val(row, 'proposedArgs') || {};
    const rowKey = buildApprovalDedupKey({
      toolName: val(row, 'toolName'),
      targetCollection: val(row, 'targetCollection'),
      targetRecordId: val(row, 'targetRecordId'),
      proposedArgs: qArgs,
      alarmId: qArgs?.alarmId,
    });
    if (rowKey !== recKey) continue;

    const expRaw = val(row, 'expiresAt');
    const expMs = expRaw ? new Date(expRaw).getTime() : NaN;
    const createdRaw = val(row, 'createdAt');
    const createdMs = createdRaw ? new Date(createdRaw).getTime() : NaN;
    const withinWindow = Number.isFinite(createdMs) && (nowMs - createdMs) <= dedupWindowMs;
    const stillUnexpired = !Number.isFinite(expMs) || expMs > nowMs;
    if (stillUnexpired || withinWindow) {
      return true;
    }
  }
  return false;
}

async function runWithOrgSweepLock(orgId, fn) {
  const prev = orgSweepLocks.get(orgId) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => fn());
  const clear = () => {
    if (orgSweepLocks.get(orgId) === next) {
      orgSweepLocks.delete(orgId);
    }
  };
  next.then(clear, clear);
  orgSweepLocks.set(orgId, next);
  try {
    return await next;
  } finally {
    clear();
  }
}

async function runProactiveIncidentTriage(db, {
  organizationId,
  actor = null,
  maxAlarms = 10,
  alarmIds = null,
  dryRun = false,
  overwriteProposal = false,
  dedupWindowMs = TRIAGE_DEDUP_WINDOW_MS,
} = {}) {
  const orgId = typeof organizationId === 'string' ? organizationId.trim() : '';
  if (!ORG_ID_RE.test(orgId)) {
    throw failTriage('TRIAGE_ORG_REQUIRED', 400, 'Cần organizationId hợp lệ để quét sự cố chủ động.');
  }

  return runWithOrgSweepLock(orgId, async () => {
    const incRepo = db?.getRepository?.('latticeIncidentCases');
    if (!incRepo || typeof incRepo.find !== 'function') {
      return {
        organizationId: orgId,
        scannedCount: 0,
        matchedAlarms: 0,
        proposalsCreated: 0,
        deduplicatedSkipped: 0,
        proposals: [],
      };
    }

    const hasExplicitAlarmIds = Array.isArray(alarmIds);
    const validAlarmIds = hasExplicitAlarmIds
      ? [...new Set(alarmIds.slice(0, 50).map((id) => Number(id)).filter((n) => Number.isInteger(n) && n > 0))]
      : [];
    if (hasExplicitAlarmIds && !validAlarmIds.length) {
      return {
        organizationId: orgId,
        scannedCount: 0,
        matchedAlarms: 0,
        proposalsCreated: 0,
        deduplicatedSkipped: 0,
        proposals: [],
      };
    }
    const alarmIdFilter = hasExplicitAlarmIds ? new Set(validAlarmIds) : null;
    const cap = Math.max(1, Math.min(50, Number(maxAlarms) || 10));

    const rawRows = (await incRepo.find({
      filter: {
        organizationId: orgId,
        status: { $in: ['open', 'acknowledged'] },
        ...(alarmIdFilter ? { id: { $in: [...alarmIdFilter] } } : {}),
      },
      sort: ['-id'],
      limit: 200,
    })) || [];

    const activeAlarms = rawRows
      .filter((row) => {
        if (val(row, 'organizationId') !== orgId) return false;
        if (!ACTIVE_ALARM_STATUSES.has(String(val(row, 'status') || '').toLowerCase())) return false;
        if (alarmIdFilter && !alarmIdFilter.has(Number(val(row, 'id')))) return false;
        return true;
      })
      .sort((a, b) => {
        const sevDiff = (SEVERITY_RANK[String(val(b, 'severity') || 'medium').toLowerCase()] || 2)
          - (SEVERITY_RANK[String(val(a, 'severity') || 'medium').toLowerCase()] || 2);
        if (sevDiff !== 0) return sevDiff;
        return Number(val(b, 'id') || 0) - Number(val(a, 'id') || 0);
      })
      .slice(0, cap);

    const queueRepo = db?.getRepository?.('latticeAiApprovalQueue');
    const existingPending = !dryRun && queueRepo && typeof queueRepo.find === 'function'
      ? ((await queueRepo.find({ filter: { organizationId: orgId, status: 'pending' }, sort: ['-id'], limit: 500 })) || [])
        .filter((r) => val(r, 'organizationId') === orgId && String(val(r, 'status') || '').toLowerCase() === 'pending')
      : [];

    const triageActor = {
      userId: Number(actor?.userId || 1),
      username: String(actor?.username || 'dxos-proactive-triage').slice(0, 120),
      organizationId: orgId,
    };

    let proposalsCreated = 0;
    let deduplicatedSkipped = 0;
    const proposals = [];
    const nowMs = Date.now();
    const sweepDedupKeys = new Set();

    for (const alarm of activeAlarms) {
      const context = await correlateAlarmContext(db, orgId, alarm);
      const rec = buildTriageRecommendation({ alarm, ...context });
      if (!rec) {
        continue;
      }

      if (!dryRun) {
        const existingProposal = String(val(alarm, 'proposal') || '').trim();
        if (!existingProposal || overwriteProposal === true) {
          await updateIncidentProposalSafely(incRepo, alarm, rec.proposalText);
        }

        const sweepKey = buildApprovalDedupKey({
          toolName: rec.toolName,
          targetCollection: rec.targetCollection,
          targetRecordId: rec.targetRecordId,
          proposedArgs: rec.proposedArgs,
          alarmId: rec.alarmId,
        });

        const enqueueTx = async (transaction = null) => {
          const txOpt = transaction ? { transaction } : {};
          if (
            transaction
            && db?.sequelize?.getDialect?.() === 'postgres'
            && typeof db?.sequelize?.query === 'function'
          ) {
            await db.sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:lockKey))', {
              replacements: { lockKey: `latticedx:triage:${orgId}` },
              transaction,
            });
          }
          const freshPending = queueRepo && typeof queueRepo.find === 'function'
            ? ((await queueRepo.find({ filter: { organizationId: orgId, status: 'pending' }, sort: ['-id'], limit: 500, ...txOpt })) || [])
              .filter((r) => val(r, 'organizationId') === orgId && String(val(r, 'status') || '').toLowerCase() === 'pending')
            : existingPending;
          const isDup = sweepDedupKeys.has(sweepKey)
            || isDuplicatePendingApproval(freshPending, rec, dedupWindowMs, nowMs);
          if (isDup) {
            return { duplicated: true, created: null };
          }
          const created = await enqueueAiApproval(db, {
            actor: triageActor,
            aiEmployee: 'dxos-coordinator',
            toolName: rec.toolName,
            targetCollection: rec.targetCollection,
            targetRecordId: rec.targetRecordId,
            operation: rec.operation,
            proposedArgs: rec.proposedArgs,
            diffPreview: rec.diffPreview,
            riskLevel: rec.riskLevel,
          });
          return { duplicated: false, created };
        };

        const outcome = typeof db?.sequelize?.transaction === 'function'
          ? await db.sequelize.transaction(enqueueTx)
          : await enqueueTx(null);

        if (outcome.duplicated) {
          deduplicatedSkipped += 1;
          proposals.push({ ...rec, status: 'deduplicated_skipped', approvalId: null });
          continue;
        }

        const created = outcome.created;
        sweepDedupKeys.add(sweepKey);
        existingPending.push(created);
        proposalsCreated += 1;

        await recordTriageLineageSafely(db, {
          organizationId: orgId,
          alarmId: rec.alarmId,
          alarmCode: rec.alarmCode,
          approvalId: created.id,
          metadataJson: {
            toolName: rec.toolName,
            targetCollection: rec.targetCollection,
            targetRecordId: rec.targetRecordId,
            severity: rec.severity,
          },
        });

        proposals.push({ ...rec, status: 'pending', approvalId: created.id });
      } else {
        proposals.push({ ...rec, status: 'dry_run', approvalId: null });
      }
    }

    return {
      organizationId: orgId,
      scannedCount: activeAlarms.length,
      matchedAlarms: activeAlarms.length,
      proposalsCreated,
      deduplicatedSkipped,
      proposals,
    };
  });
}

function startProactiveTriageScheduler(db, { env = process.env, intervalMs } = {}) {
  const raw = intervalMs !== undefined ? intervalMs : env?.DX_PROACTIVE_TRIAGE_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { enabled: false, intervalMs: 0, timer: null, stop: () => {} };
  }

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const incRepo = db?.getRepository?.('latticeIncidentCases');
      if (!incRepo || typeof incRepo.find !== 'function') return;
      const rows = (await incRepo.find({ filter: { status: { $in: ['open', 'acknowledged'] } }, limit: 200 })) || [];
      const orgIds = [...new Set(rows.map((r) => val(r, 'organizationId')).filter((o) => ORG_ID_RE.test(String(o || ''))))];
      for (const orgId of orgIds) {
        await runProactiveIncidentTriage(db, {
          organizationId: orgId,
          actor: { userId: 1, username: 'dxos-triage-scheduler' },
        });
      }
    } catch (err) {
      const logger = db?.logger || db?.log;
      if (typeof logger?.error === 'function') {
        logger.error('[dxos-proactive-triage] Scheduled sweep failed', err);
      } else {
        console.error('[dxos-proactive-triage] Scheduled sweep failed:', err?.code || 'ERR', err?.message || err);
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, parsed);
  if (typeof timer?.unref === 'function') {
    timer.unref();
  }

  return {
    enabled: true,
    intervalMs: parsed,
    timer,
    stop: () => clearInterval(timer),
  };
}

module.exports = {
  TRIAGE_DEDUP_WINDOW_MS,
  buildTriageRecommendation,
  runProactiveIncidentTriage,
  startProactiveTriageScheduler,
};
