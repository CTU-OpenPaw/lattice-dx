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

const ACTIVE_ALARM_STATUSES = new Set(['open', 'acknowledged']);
const SEVERITY_RANK = { low: 1, medium: 2, high: 3, critical: 4 };
const ALARM_NOTIF_SEVERITIES = new Set(['high', 'critical']);
const ALARM_NOTIF_DEDUP_WINDOW_MS = 30 * 60 * 1000;
const ORG_ID_RE = /^[a-zA-Z0-9_-]{1,80}$/;
const METRIC_NAME_RE = /^[a-zA-Z0-9_.-]{1,128}$/;
const TELEMETRY_URN_RE = /^urn:ngsi-ld:Asset:([a-zA-Z0-9_-]{1,80}):native:([1-9]\d{0,18})$/;
const BAD_TELEMETRY_QUALITIES = new Set(['bad', 'fault', 'corrupt', 'quarantined']);

const val = (row, key) => (typeof row?.get === 'function' ? row.get(key) : row?.[key]);

function failAlarm(code, status, message) {
  return Object.assign(new Error(message || code), { code, status });
}

function computeAlarmFingerprint({ organizationId = '', assetEntityId = '', ruleCode = '', attribute = '' } = {}) {
  const key = [
    String(organizationId || '').trim(),
    String(assetEntityId || '').trim(),
    String(ruleCode || 'default').trim().toUpperCase(),
    String(attribute || 'value').trim().toLowerCase(),
  ].join('|');
  return createHash('sha256').update(key).digest('hex');
}

async function updateIncidentRow(repo, row, patch) {
  if (typeof row?.update === 'function') {
    await row.update(patch);
    return row;
  }
  const id = val(row, 'id');
  if (repo && typeof repo.update === 'function' && id != null) {
    await repo.update({ filterByTk: id, values: patch });
  }
  return Object.assign(row || {}, patch);
}

function serializeAlarm(row, extras = {}) {
  return {
    id: val(row, 'id'),
    code: val(row, 'code'),
    name: val(row, 'name'),
    organizationId: val(row, 'organizationId'),
    assetEntityId: val(row, 'assetEntityId'),
    assetId: val(row, 'assetId') ?? null,
    severity: val(row, 'severity') || 'medium',
    status: val(row, 'status') || 'open',
    fingerprint: val(row, 'fingerprint') || null,
    occurrenceCount: Number(val(row, 'occurrenceCount')) || 1,
    firstSeenAt: val(row, 'firstSeenAt') || val(row, 'createdAt') || null,
    lastSeenAt: val(row, 'lastSeenAt') || val(row, 'updatedAt') || null,
    acknowledgedAt: val(row, 'acknowledgedAt') || null,
    acknowledgedBy: val(row, 'acknowledgedBy') || null,
    clearedAt: val(row, 'clearedAt') || null,
    clearedBy: val(row, 'clearedBy') || null,
    resolutionNote: val(row, 'resolutionNote') || null,
    closeNote: val(row, 'closeNote') || null,
    ...extras,
  };
}

async function notifyOrgOperatorsOnAlarm(db, alarmRow) {
  try {
    if (!db || typeof db.getRepository !== 'function' || !alarmRow) {
      return { created: 0, skipped: 0 };
    }
    const notifRepo = db.getRepository('latticeNotifications');
    const empRepo = db.getRepository('latticeEmployees');
    if (!notifRepo || !empRepo) return { created: 0, skipped: 0 };

    const organizationId = val(alarmRow, 'organizationId');
    const severity = String(val(alarmRow, 'severity') || 'medium').trim().toLowerCase();
    if (!organizationId || !ALARM_NOTIF_SEVERITIES.has(severity)) {
      return { created: 0, skipped: 0 };
    }

    const fingerprint = String(val(alarmRow, 'fingerprint') || val(alarmRow, 'code') || val(alarmRow, 'id') || '').trim();
    const dedupKey = `alarm:${fingerprint}`;
    const alarmId = val(alarmRow, 'id') ?? null;
    const alarmCode = String(val(alarmRow, 'code') || (alarmId != null ? `#${alarmId}` : 'ALARM')).trim();
    const alarmName = String(val(alarmRow, 'name') || `Cảnh báo ${alarmCode}`).trim();
    const proposal = String(val(alarmRow, 'proposal') || '').trim();
    const assetEntityId = String(val(alarmRow, 'assetEntityId') || '').trim();
    const sevLabel = severity === 'critical' ? 'NGHIÊM TRỌNG' : 'CAO';
    const title = `[Cảnh báo ${sevLabel}] ${alarmName}`.slice(0, 255);
    const body = [alarmCode, assetEntityId, proposal].filter(Boolean).join(' · ').slice(0, 1000) || title;

    const employees = (await empRepo.find({
      filter: { organizationId, active: true },
      limit: 500,
    })) || [];
    if (!Array.isArray(employees) || !employees.length) {
      return { created: 0, skipped: 0 };
    }

    const cutoff = new Date(Date.now() - ALARM_NOTIF_DEDUP_WINDOW_MS);
    const cutoffMs = cutoff.getTime();
    const seenUsers = new Set();
    let created = 0;
    let skipped = 0;

    for (const emp of employees) {
      if (val(emp, 'active') !== true || val(emp, 'organizationId') !== organizationId) continue;
      const recipientUserId = val(emp, 'userId');
      const recipientEmployeeId = val(emp, 'id') ?? null;
      if (recipientUserId == null || recipientUserId === '') continue;
      const userKey = String(recipientUserId);
      if (seenUsers.has(userKey)) continue;
      seenUsers.add(userKey);

      const existing = typeof notifRepo.find === 'function'
        ? ((await notifRepo.find({
            filter: {
              organizationId,
              recipientUserId,
              dedupKey,
              createdAt: { $gt: cutoff },
            },
            limit: 10,
            sort: ['-id'],
          })) || [])
        : [];
      const hasRecentDup = Array.isArray(existing) && existing.some((row) => {
        if (val(row, 'organizationId') !== organizationId) return false;
        if (String(val(row, 'recipientUserId')) !== userKey) return false;
        if (String(val(row, 'dedupKey') || '') !== dedupKey) return false;
        const createdRaw = val(row, 'createdAt');
        if (!createdRaw) return true;
        const ts = Date.parse(String(createdRaw));
        return Number.isFinite(ts) ? ts > cutoffMs : true;
      });

      if (hasRecentDup) {
        skipped += 1;
        continue;
      }

      if (typeof notifRepo.create === 'function') {
        await notifRepo.create({
          values: {
            organizationId,
            recipientUserId,
            recipientEmployeeId,
            category: 'alarm',
            severity,
            title,
            body,
            targetCollection: 'latticeIncidentCases',
            targetRecordId: alarmId,
            targetPath: '/p/incidents',
            dedupKey,
            channelsDispatched: ['in_app'],
            active: true,
          },
        });
        created += 1;
      }
    }

    return { created, skipped };
  } catch {
    return { created: 0, skipped: 0 };
  }
}

async function ingestOrDeduplicateAlarm(db, {
  organizationId,
  assetId = null,
  assetEntityId,
  ruleCode = 'IOT-RULE',
  attribute = 'temperature',
  severity = 'medium',
  summary = '',
  handlerId = 'unassigned',
} = {}) {
  if (!organizationId || !assetEntityId) {
    throw failAlarm('ALARM_IDENTITY_REQUIRED', 400, 'Cần organizationId và assetEntityId để ghi nhận cảnh báo.');
  }
  const repo = db?.getRepository?.('latticeIncidentCases');
  if (!repo) throw failAlarm('INCIDENT_REPO_UNAVAILABLE', 503, 'Kho sự cố chưa sẵn sàng.');

  const fingerprint = computeAlarmFingerprint({ organizationId, assetEntityId, ruleCode, attribute });
  const now = new Date();
  const candidates = (await repo.find({
    filter: {
      organizationId,
      assetEntityId,
      fingerprint,
      status: { $in: ['open', 'acknowledged'] },
    },
    limit: 1,
  })) || [];
  const active = Array.isArray(candidates) ? candidates.find((c) => ACTIVE_ALARM_STATUSES.has(val(c, 'status'))) : null;

  if (active) {
    const prevCount = Math.max(1, Number(val(active, 'occurrenceCount')) || 1);
    const prevSev = String(val(active, 'severity') || 'medium');
    const nextSev = (SEVERITY_RANK[severity] || 2) > (SEVERITY_RANK[prevSev] || 2) ? severity : prevSev;
    const patch = {
      occurrenceCount: prevCount + 1,
      lastSeenAt: now,
      severity: nextSev,
      ...(summary ? { proposal: String(summary).slice(0, 500) } : {}),
    };
    await updateIncidentRow(repo, active, patch);
    if ((SEVERITY_RANK[nextSev] || 0) > (SEVERITY_RANK[prevSev] || 0) && ALARM_NOTIF_SEVERITIES.has(nextSev)) {
      await notifyOrgOperatorsOnAlarm(db, active);
    }
    return serializeAlarm(active, { deduplicated: true });
  }

  const tsSlug = Date.now().toString(36).toUpperCase();
  const rand = randomBytes(3).toString('hex').toUpperCase();
  const code = `ALM-${tsSlug}-${rand}`;
  const normalizedSeverity = SEVERITY_RANK[severity] ? severity : 'medium';
  const created = await repo.create({
    values: {
      code,
      name: summary ? String(summary).slice(0, 120) : `Cảnh báo ${ruleCode} (${attribute})`,
      organizationId,
      runId: `dedup-${fingerprint.slice(0, 12)}`,
      assetEntityId,
      ...(assetId != null ? { assetId } : {}),
      notificationId: `ntf-${tsSlug}-${rand}`,
      handlerId: String(handlerId || 'unassigned'),
      severity: normalizedSeverity,
      status: 'open',
      proposal: summary ? String(summary).slice(0, 500) : null,
      fingerprint,
      occurrenceCount: 1,
      firstSeenAt: now,
      lastSeenAt: now,
    },
  });
  if (ALARM_NOTIF_SEVERITIES.has(normalizedSeverity)) {
    await notifyOrgOperatorsOnAlarm(db, created);
  }
  return serializeAlarm(created, { deduplicated: false });
}

async function acknowledgeAlarm(db, { id, organizationId = null, actorName = 'operator', note = '' } = {}) {
  const repo = db?.getRepository?.('latticeIncidentCases');
  if (!repo) throw failAlarm('INCIDENT_REPO_UNAVAILABLE', 503);
  const row = await repo.findOne({ filterByTk: id });
  if (!row || (organizationId && val(row, 'organizationId') !== organizationId)) {
    throw failAlarm('ALARM_NOT_FOUND', 404, 'Không tìm thấy cảnh báo trong phạm vi tổ chức.');
  }
  const curStatus = String(val(row, 'status') || 'open');
  if (curStatus === 'closed' || curStatus === 'cleared') {
    throw failAlarm('ALARM_ALREADY_CLEARED', 409, 'Cảnh báo này đã được đóng.');
  }
  const now = new Date();
  const patch = {
    status: 'acknowledged',
    acknowledgedAt: val(row, 'acknowledgedAt') || now,
    acknowledgedBy: String(actorName || 'operator').slice(0, 120),
    ...(note ? { resolutionNote: String(note).slice(0, 255) } : {}),
  };
  await updateIncidentRow(repo, row, patch);
  return serializeAlarm(row);
}

async function clearAlarm(db, { id, organizationId = null, actorName = 'operator', closeNote = '' } = {}) {
  const repo = db?.getRepository?.('latticeIncidentCases');
  if (!repo) throw failAlarm('INCIDENT_REPO_UNAVAILABLE', 503);
  const row = await repo.findOne({ filterByTk: id });
  if (!row || (organizationId && val(row, 'organizationId') !== organizationId)) {
    throw failAlarm('ALARM_NOT_FOUND', 404, 'Không tìm thấy cảnh báo trong phạm vi tổ chức.');
  }
  const curStatus = String(val(row, 'status') || 'open');
  if (curStatus === 'closed' || curStatus === 'cleared') {
    throw failAlarm('ALARM_ALREADY_CLEARED', 409, 'Cảnh báo đã được đóng trước đó.');
  }
  const now = new Date();
  const safeActor = String(actorName || 'operator').trim() || 'operator';
  const trimmedNote = String(closeNote || '').trim();
  const resolvedCloseNote = (trimmedNote || `Đã đóng cảnh báo bởi ${safeActor}`).slice(0, 255);
  const patch = {
    status: 'closed',
    clearedAt: now,
    clearedBy: safeActor.slice(0, 120),
    closeNote: resolvedCloseNote,
  };
  await updateIncidentRow(repo, row, patch);
  return serializeAlarm(row);
}

function parseFiniteNumber(raw) {
  if (raw === null || raw === undefined || typeof raw === 'boolean' || typeof raw === 'object') {
    return null;
  }
  if (typeof raw === 'string' && raw.trim() === '') {
    return null;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function evaluateRuleCondition(operator, numericValue, threshold) {
  const valNum = parseFiniteNumber(numericValue);
  const threshNum = parseFiniteNumber(threshold);
  if (valNum === null || threshNum === null) return false;
  switch (String(operator || '').trim().toLowerCase()) {
    case 'gt':
    case '>':
      return valNum > threshNum;
    case 'gte':
    case '>=':
      return valNum >= threshNum;
    case 'lt':
    case '<':
      return valNum < threshNum;
    case 'lte':
    case '<=':
      return valNum <= threshNum;
    case 'eq':
    case '==':
    case '===':
      return valNum === threshNum;
    default:
      return false;
  }
}

function serializeTelemetryPoint(row, fallback = {}) {
  const obs = val(row, 'observedAt') ?? fallback.observedAt;
  const obsIso = obs instanceof Date ? obs.toISOString() : String(obs || new Date().toISOString());
  return {
    id: val(row, 'id') ?? null,
    organizationId: val(row, 'organizationId') || fallback.organizationId,
    assetId: val(row, 'assetId') ?? fallback.assetId ?? null,
    assetEntityId: val(row, 'assetEntityId') || fallback.assetEntityId,
    metricName: val(row, 'metricName') || fallback.metricName,
    numericValue: Number(val(row, 'numericValue') ?? fallback.numericValue),
    unit: String(val(row, 'unit') ?? fallback.unit ?? 'CEL'),
    quality: String(val(row, 'quality') ?? fallback.quality ?? 'good'),
    sourceProtocol: String(val(row, 'sourceProtocol') ?? fallback.sourceProtocol ?? 'http'),
    observedAt: obsIso,
  };
}

async function ingestTelemetryPoint(db, {
  organizationId,
  assetId = null,
  assetEntityId = '',
  metricName = 'temperature',
  numericValue,
  unit,
  quality = 'good',
  sourceProtocol = 'http',
  observedAt = null,
  bypassQuarantine = false,
} = {}) {
  const orgId = typeof organizationId === 'string' ? organizationId.trim() : '';
  if (!ORG_ID_RE.test(orgId)) {
    throw failAlarm('TELEMETRY_ORG_REQUIRED', 400, 'Cần organizationId hợp lệ để ghi nhận telemetry.');
  }

  let resolvedAssetId = null;
  if (assetId !== null && assetId !== undefined && assetId !== '') {
    if (!/^[1-9]\d{0,18}$/.test(String(assetId))) {
      throw failAlarm('TELEMETRY_ASSET_ID_INVALID', 400, 'assetId không hợp lệ.');
    }
    resolvedAssetId = Number(assetId);
  }

  let entityId = typeof assetEntityId === 'string' ? assetEntityId.trim().slice(0, 255) : '';
  if (!entityId && resolvedAssetId != null) {
    entityId = `urn:ngsi-ld:Asset:${orgId}:native:${resolvedAssetId}`;
  }
  if (!entityId) {
    throw failAlarm('TELEMETRY_ENTITY_REQUIRED', 400, 'Cần assetEntityId hoặc assetId để ghi nhận telemetry.');
  }
  const urnMatch = TELEMETRY_URN_RE.exec(entityId);
  if (urnMatch) {
    if (urnMatch[1] !== orgId) {
      throw failAlarm('DXOS_CROSS_ORG_FORBIDDEN', 403, 'assetEntityId không thuộc phạm vi tổ chức hiện tại.');
    }
    const urnAssetId = Number(urnMatch[2]);
    if (resolvedAssetId != null && urnAssetId !== resolvedAssetId) {
      throw failAlarm('TELEMETRY_ASSET_MISMATCH', 400, 'assetId và assetEntityId không khớp nhau.');
    }
    if (resolvedAssetId == null) resolvedAssetId = urnAssetId;
  }

  const metric = String(metricName == null || metricName === '' ? 'temperature' : metricName).trim();
  if (!METRIC_NAME_RE.test(metric)) {
    throw failAlarm('TELEMETRY_METRIC_INVALID', 400, 'metricName không hợp lệ.');
  }

  const parsedValue = parseFiniteNumber(numericValue);
  if (parsedValue === null) {
    throw failAlarm('TELEMETRY_VALUE_INVALID', 400, 'numericValue phải là số hữu hạn hợp lệ.');
  }

  let observedDate;
  if (observedAt !== null && observedAt !== undefined && observedAt !== '') {
    observedDate = observedAt instanceof Date ? new Date(observedAt.getTime()) : new Date(String(observedAt));
    if (!Number.isFinite(observedDate.getTime())) {
      throw failAlarm('TELEMETRY_TIMESTAMP_INVALID', 400, 'observedAt không hợp lệ.');
    }
  } else {
    observedDate = new Date();
  }

  const cleanUnit = String(unit == null || unit === '' ? 'CEL' : unit).trim().slice(0, 64) || 'CEL';
  const cleanQuality = String(quality == null || quality === '' ? 'good' : quality).trim().slice(0, 64) || 'good';
  const cleanProtocol = String(sourceProtocol == null || sourceProtocol === '' ? 'http' : sourceProtocol).trim().slice(0, 64) || 'http';

  const assetRepo = db?.getRepository?.('latticeAssets');
  if (resolvedAssetId != null && assetRepo && typeof assetRepo.findOne === 'function') {
    const assetRow = await assetRepo.findOne({
      filter: { id: resolvedAssetId, organizationId: orgId },
    });
    if (!assetRow || (val(assetRow, 'organizationId') && val(assetRow, 'organizationId') !== orgId)) {
      throw failAlarm('TELEMETRY_ASSET_NOT_FOUND', 404, 'Không tìm thấy tài sản trong phạm vi tổ chức.');
    }
  }

  const hasExplicitUnit = unit !== null && unit !== undefined && String(unit).trim() !== '';
  const isTemperatureMetric = metric.toLowerCase() === 'temperature' || (hasExplicitUnit && cleanUnit.toUpperCase() === 'CEL');
  const isOutOfPhysicalRange = isTemperatureMetric && (parsedValue < -100 || parsedValue > 150);
  const isBadQuality = BAD_TELEMETRY_QUALITIES.has(cleanQuality.toLowerCase());
  const quarantineReason = bypassQuarantine !== true
    ? (isOutOfPhysicalRange
      ? 'SENSOR_OUT_OF_PHYSICAL_RANGE'
      : (isBadQuality ? 'BAD_TELEMETRY_QUALITY' : null))
    : null;

  if (quarantineReason) {
    const quarantineRepo = db?.getRepository?.('latticeDataQuarantine');
    if (quarantineRepo && typeof quarantineRepo.create === 'function') {
      const quarantineUid = `QRN-${Date.now().toString(36).toUpperCase()}-${randomBytes(4).toString('hex').toUpperCase()}`;
      const createdQuarantine = await quarantineRepo.create({
        values: {
          organizationId: orgId,
          quarantineUid,
          sourceSystem: 'iiot',
          assetEntityId: entityId,
          metricName: metric,
          numericValue: parsedValue,
          unit: cleanUnit,
          reasonCode: quarantineReason,
          severity: quarantineReason === 'SENSOR_OUT_OF_PHYSICAL_RANGE' ? 'high' : 'medium',
          rawPayload: {
            organizationId: orgId,
            ...(resolvedAssetId != null ? { assetId: resolvedAssetId } : {}),
            assetEntityId: entityId,
            metricName: metric,
            numericValue: parsedValue,
            unit: cleanUnit,
            quality: cleanQuality,
            sourceProtocol: cleanProtocol,
            observedAt: observedDate.toISOString(),
          },
          status: 'quarantined',
          active: true,
        },
      });
      return {
        quarantined: true,
        quarantineUid: val(createdQuarantine, 'quarantineUid') || quarantineUid,
        quarantineId: val(createdQuarantine, 'id') ?? null,
        reasonCode: quarantineReason,
        point: null,
        triggeredAlarms: [],
      };
    }
  }

  const tsRepo = db?.getRepository?.('latticeTelemetryPoints');
  if (!tsRepo || typeof tsRepo.create !== 'function') {
    throw failAlarm('TELEMETRY_REPO_UNAVAILABLE', 503, 'Kho dữ liệu chuỗi thời gian chưa sẵn sàng.');
  }

  const values = {
    organizationId: orgId,
    ...(resolvedAssetId != null ? { assetId: resolvedAssetId } : {}),
    assetEntityId: entityId,
    metricName: metric,
    numericValue: parsedValue,
    unit: cleanUnit,
    quality: cleanQuality,
    sourceProtocol: cleanProtocol,
    observedAt: observedDate,
  };
  const created = await tsRepo.create({ values });
  const point = serializeTelemetryPoint(created, values);

  const triggeredAlarms = [];
  const rulesRepo = db?.getRepository?.('latticeIncidentRules');
  if (rulesRepo && typeof rulesRepo.find === 'function') {
    const RULE_BATCH_SIZE = 200;
    const RULE_MAX_SCAN = 2000;
    const seenRuleIds = new Set();
    for (let offset = 0; offset < RULE_MAX_SCAN;) {
      const rules = (await rulesRepo.find({
        filter: {
          organizationId: orgId,
          active: true,
          attribute: metric,
          assetEntityId: entityId,
        },
        sort: ['id'],
        limit: RULE_BATCH_SIZE,
        offset,
      })) || [];
      if (!Array.isArray(rules) || !rules.length) break;

      let unseenCount = 0;
      for (const rule of rules) {
        const rid = val(rule, 'id');
        const rKey = rid != null ? String(rid) : null;
        if (rKey !== null) {
          if (seenRuleIds.has(rKey)) continue;
          seenRuleIds.add(rKey);
        }
        unseenCount += 1;

        if (val(rule, 'organizationId') && val(rule, 'organizationId') !== orgId) continue;
        if (val(rule, 'assetEntityId') && val(rule, 'assetEntityId') !== entityId) continue;
        if (val(rule, 'attribute') && val(rule, 'attribute') !== metric) continue;
        if (val(rule, 'active') === false || val(rule, 'active') === 0) continue;

        const op = val(rule, 'operator');
        const threshold = val(rule, 'threshold');
        if (!evaluateRuleCondition(op, parsedValue, threshold)) continue;

        const ruleCode = String(val(rule, 'code') || `RULE-${rid || 'IOT'}`).trim();
        const ruleName = String(val(rule, 'name') || ruleCode).trim();
        const ruleSev = String(val(rule, 'severity') || 'medium').trim().toLowerCase();
        const handlerId = String(val(rule, 'handlerId') || 'unassigned').trim();
        const ruleAssetId = resolvedAssetId ?? val(rule, 'assetId') ?? null;
        const summary = `[${ruleName}] ${metric}=${parsedValue} ${cleanUnit} (${op} ${threshold})`.slice(0, 500);

        const alarm = await ingestOrDeduplicateAlarm(db, {
          organizationId: orgId,
          assetId: ruleAssetId,
          assetEntityId: entityId,
          ruleCode,
          attribute: metric,
          severity: ruleSev,
          summary,
          handlerId,
        });
        triggeredAlarms.push(alarm);
      }
      if (unseenCount === 0) break;
      offset += rules.length;
    }
  }

  return { point, triggeredAlarms };
}

function extractNumericSeriesValue(data, targetAttribute) {
  if (!data || typeof data !== 'object') return null;
  if (targetAttribute && data.attribute && data.attribute !== targetAttribute) return null;
  const direct = data.value ?? (targetAttribute ? data[targetAttribute]?.value ?? data[targetAttribute] : undefined);
  if (direct != null && direct !== '' && Number.isFinite(Number(direct))) {
    return { value: Number(direct), unit: String(data.unit || data[targetAttribute]?.unitCode || '') };
  }
  for (const [k, raw] of Object.entries(data)) {
    if (['entityId', 'type', 'id', '@context', 'attribute', 'unit', 'observedAt'].includes(k)) continue;
    const candidate = raw && typeof raw === 'object' ? raw.value : raw;
    if (candidate != null && candidate !== '' && Number.isFinite(Number(candidate))) {
      return { value: Number(candidate), unit: String(raw?.unitCode || data.unit || '') };
    }
  }
  return null;
}

function bucketTimeSeriesPoints(points, bucketMinutes) {
  const bucketMs = bucketMinutes * 60 * 1000;
  const buckets = new Map();
  for (const p of points) {
    const tsMs = Date.parse(p.timestamp);
    if (!Number.isFinite(tsMs) || !Number.isFinite(p.value)) continue;
    const startMs = Math.floor(tsMs / bucketMs) * bucketMs;
    let bucket = buckets.get(startMs);
    if (!bucket) {
      bucket = { startMs, sum: 0, min: p.value, max: p.value, count: 0, unit: p.unit || '' };
      buckets.set(startMs, bucket);
    }
    bucket.sum += p.value;
    if (p.value < bucket.min) bucket.min = p.value;
    if (p.value > bucket.max) bucket.max = p.value;
    bucket.count += 1;
    if (!bucket.unit && p.unit) bucket.unit = p.unit;
  }
  return [...buckets.values()]
    .sort((a, b) => a.startMs - b.startMs)
    .map((b) => ({
      timestamp: new Date(b.startMs).toISOString(),
      value: Number((b.sum / b.count).toFixed(2)),
      min: b.min,
      max: b.max,
      count: b.count,
      unit: b.unit,
    }));
}

async function queryTelemetryTimeSeries(db, {
  organizationId = null,
  assetEntityId = '',
  attribute = '',
  windowHours = 24,
  bucketMinutes = 0,
  limit = 100,
  now = Date.now(),
} = {}) {
  const hasExplicitWindow = arguments[1] && arguments[1].windowHours !== undefined;
  const cap = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 100)));
  const safeWindowHours = windowHours === null || windowHours === 0
    ? 0
    : Math.max(0, Math.min(24 * 365, Number.isFinite(Number(windowHours)) ? Number(windowHours) : 24));
  const safeBucketMinutes = Number.isFinite(Number(bucketMinutes)) && Number(bucketMinutes) > 0
    ? Math.max(1, Math.min(1440 * 7, Math.floor(Number(bucketMinutes))))
    : 0;
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const cutoffMs = safeWindowHours > 0 ? nowMs - safeWindowHours * 3600_000 : null;
  const cutoffDate = cutoffMs !== null ? new Date(cutoffMs) : null;

  const points = [];
  const tsRepo = db?.getRepository?.('latticeTelemetryPoints');
  if (tsRepo && typeof tsRepo.find === 'function') {
    const TS_BATCH_SIZE = 1000;
    const TS_MAX_BUCKET_SCAN = 10000;
    const targetMaxRows = safeBucketMinutes > 0 ? TS_MAX_BUCKET_SCAN : cap;
    const seenPointKeys = new Set();

    for (let offset = 0; offset < targetMaxRows;) {
      const batchLimit = Math.min(TS_BATCH_SIZE, targetMaxRows - offset);
      const rows = (await tsRepo.find({
        filter: {
          ...(organizationId ? { organizationId } : {}),
          ...(assetEntityId ? { assetEntityId } : {}),
          ...(attribute ? { metricName: attribute } : {}),
          ...(cutoffDate ? { observedAt: { $gte: cutoffDate } } : {}),
        },
        sort: ['-observedAt', '-id'],
        limit: batchLimit,
        offset,
      })) || [];
      if (!Array.isArray(rows) || !rows.length) break;

      let unseenCount = 0;
      for (const r of rows) {
        const rawId = val(r, 'id');
        const rawTs = val(r, 'observedAt') || val(r, 'createdAt');
        const tsMs = rawTs instanceof Date ? rawTs.getTime() : Date.parse(String(rawTs || ''));
        const dedupKey = rawId != null
          ? `id:${rawId}`
          : `ts:${tsMs}:${val(r, 'assetEntityId')}:${val(r, 'metricName')}:${val(r, 'numericValue')}`;
        if (seenPointKeys.has(dedupKey)) continue;
        seenPointKeys.add(dedupKey);
        unseenCount += 1;

        if (organizationId && val(r, 'organizationId') !== organizationId) continue;
        if (assetEntityId && val(r, 'assetEntityId') !== assetEntityId) continue;
        if (attribute && val(r, 'metricName') !== attribute) continue;
        if (!Number.isFinite(tsMs)) continue;
        if (cutoffMs !== null && tsMs < cutoffMs) continue;
        const numVal = parseFiniteNumber(val(r, 'numericValue'));
        if (numVal === null) continue;
        points.push({
          timestamp: new Date(tsMs).toISOString(),
          value: numVal,
          unit: String(val(r, 'unit') || ''),
        });
      }
      if (unseenCount === 0) break;
      if (safeBucketMinutes === 0 && points.length >= cap) break;
      offset += rows.length;
    }
  }

  if (points.length === 0) {
    const inboxRepo = db?.getRepository?.('latticeIntegrationInbox');
    if (inboxRepo) {
      const rows = (await inboxRepo.find({
        filter: {
          ...(organizationId ? { organizationId } : {}),
        },
        sort: ['-observedAt', '-id'],
        limit: 200,
      })) || [];
      for (const r of rows) {
        const data = val(r, 'data') || {};
        const rowEntity = String(data.entityId || data.assetEntityId || '');
        if (assetEntityId && rowEntity && rowEntity !== assetEntityId) continue;
        if (assetEntityId && !rowEntity) continue;
        const num = extractNumericSeriesValue(data, attribute);
        if (!num) continue;
        const rawTs = val(r, 'observedAt') || val(r, 'createdAt') || new Date(nowMs).toISOString();
        const tsMs = rawTs instanceof Date ? rawTs.getTime() : Date.parse(String(rawTs));
        if (hasExplicitWindow && cutoffMs !== null && Number.isFinite(tsMs) && tsMs < cutoffMs) continue;
        const ts = Number.isFinite(tsMs) ? new Date(tsMs).toISOString() : String(rawTs);
        points.push({ timestamp: ts, value: num.value, unit: num.unit });
      }
    }
  }

  points.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const seriesPoints = safeBucketMinutes > 0 ? bucketTimeSeriesPoints(points, safeBucketMinutes) : points;
  const sliced = seriesPoints.slice(-cap);
  const nums = sliced.map((p) => p.value);
  const stats = nums.length
    ? {
        count: nums.length,
        min: Math.min(...nums),
        max: Math.max(...nums),
        avg: Number((nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(2)),
        latest: nums[nums.length - 1],
      }
    : { count: 0, min: null, max: null, avg: null, latest: null };

  const incidentRepo = db?.getRepository?.('latticeIncidentCases');
  let activeAlarms = [];
  if (incidentRepo) {
    const rows = (await incidentRepo.find({
      filter: {
        ...(organizationId ? { organizationId } : {}),
        ...(assetEntityId ? { assetEntityId } : {}),
        status: { $in: ['open', 'acknowledged'] },
      },
      limit: 20,
      sort: ['-id'],
    })) || [];
    activeAlarms = rows
      .filter((r) => ACTIVE_ALARM_STATUSES.has(val(r, 'status')))
      .map((r) => serializeAlarm(r));
  }

  return { assetEntityId: assetEntityId || null, attribute: attribute || null, points: sliced, stats, activeAlarms };
}

module.exports = {
  ACTIVE_ALARM_STATUSES,
  computeAlarmFingerprint,
  notifyOrgOperatorsOnAlarm,
  evaluateRuleCondition,
  ingestTelemetryPoint,
  ingestOrDeduplicateAlarm,
  acknowledgeAlarm,
  clearAlarm,
  queryTelemetryTimeSeries,
};
