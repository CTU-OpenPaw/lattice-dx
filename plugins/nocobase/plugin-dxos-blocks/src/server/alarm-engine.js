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

async function queryTelemetryTimeSeries(db, { organizationId = null, assetEntityId = '', attribute = '', limit = 50 } = {}) {
  const cap = Math.max(1, Math.min(200, Number(limit) || 50));
  const inboxRepo = db?.getRepository?.('latticeIntegrationInbox');
  const points = [];
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
      const ts = String(val(r, 'observedAt') || val(r, 'createdAt') || new Date().toISOString());
      points.push({ timestamp: ts, value: num.value, unit: num.unit });
    }
  }

  points.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const sliced = points.slice(-cap);
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
  ingestOrDeduplicateAlarm,
  acknowledgeAlarm,
  clearAlarm,
  queryTelemetryTimeSeries,
};
