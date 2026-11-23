/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { resolveNativeActor } = require('./native-scope');
const { isPortalAdmin } = require('./native-portals');
const { recordChatterEntry } = require('./record-chatter');
const { dispatchRoleNotifications, resolveNotificationTargetPath, DEDUP_WINDOW_MS } = require('./notification-center');

const SLA_COLLECTIONS = ['latticeRequests', 'latticeOrders', 'latticeServiceTickets', 'latticeIncidentCases'];
const OPEN_SLA_STATUSES = new Set(['open', 'submitted', 'in_progress', 'acknowledged']);
const HIGH_PRIORITY_SET = new Set(['critical', 'high']);
const VALID_PRIORITIES = new Set(['critical', 'high', 'normal', 'medium', 'low']);
const ROLE_RE = /^[a-zA-Z0-9_-]{2,64}$/;
const ORG_RE = /^[a-zA-Z0-9_-]{1,80}$/;
const SLA_BATCH_SIZE = 500;
const SLA_MAX_SCAN = 5000;
const DAY_MS = 86_400_000;
const VN_UTC_OFFSET_MS = 7 * 60 * 60_000;
const VN_FIXED_HOLIDAYS = new Set(['01-01', '04-30', '05-01', '09-02']);
const VN_BUSINESS_WINDOWS = Object.freeze([
  Object.freeze({ startMinute: 8 * 60, endMinute: 12 * 60 }),
  Object.freeze({ startMinute: 13 * 60 + 30, endMinute: 17 * 60 + 30 }),
]);

const val = (row, key) => (typeof row?.get === 'function' ? row.get(key) : row?.[key]);

function toTimestampMs(value) {
  if (value === null || value === undefined || value === '') return NaN;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : NaN;
}

function formatVnMonthDay(vnDayStartMs) {
  const d = new Date(vnDayStartMs);
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${month}-${day}`;
}

function computeElapsedSlaMinutes(startDate, endDate, { businessHoursOnly = false, holidays = VN_FIXED_HOLIDAYS } = {}) {
  const startMs = toTimestampMs(startDate);
  const endMs = toTimestampMs(endDate === undefined ? new Date() : endDate);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 0;
  if (businessHoursOnly !== true) {
    return (endMs - startMs) / 60_000;
  }

  const holidaySet = holidays instanceof Set
    ? holidays
    : new Set(Array.isArray(holidays) ? holidays : VN_FIXED_HOLIDAYS);
  const vnStartMs = startMs + VN_UTC_OFFSET_MS;
  const vnEndMs = endMs + VN_UTC_OFFSET_MS;
  const startDayIdx = Math.floor(vnStartMs / DAY_MS);
  const endDayIdx = Math.floor(vnEndMs / DAY_MS);

  let businessMs = 0;
  for (let dayIdx = startDayIdx; dayIdx <= endDayIdx; dayIdx += 1) {
    const dayStartVnMs = dayIdx * DAY_MS;
    const dayOfWeek = new Date(dayStartVnMs).getUTCDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) continue;
    if (holidaySet.has(formatVnMonthDay(dayStartVnMs))) continue;

    for (const win of VN_BUSINESS_WINDOWS) {
      const winStart = dayStartVnMs + win.startMinute * 60_000;
      const winEnd = dayStartVnMs + win.endMinute * 60_000;
      const overlapStart = Math.max(vnStartMs, winStart);
      const overlapEnd = Math.min(vnEndMs, winEnd);
      if (overlapEnd > overlapStart) {
        businessMs += overlapEnd - overlapStart;
      }
    }
  }
  return businessMs / 60_000;
}

function failSla(code, status = 400, message = code) {
  return Object.assign(new Error(message), { code, status });
}

function readParams(ctx) {
  const p = ctx.action?.params || {};
  const v = p.values && typeof p.values === 'object' && !Array.isArray(p.values) ? p.values : {};
  return { ...p, ...v };
}

function defaultSlaThresholds(priority) {
  const prio = String(priority || 'normal').trim().toLowerCase();
  if (HIGH_PRIORITY_SET.has(prio)) {
    return { warnAfterMinutes: 30, breachAfterMinutes: 60, escalateToRole: 'ldx_manager', notifyChannels: null, businessHoursOnly: false };
  }
  return { warnAfterMinutes: 240, breachAfterMinutes: 1440, escalateToRole: 'ldx_manager', notifyChannels: null, businessHoursOnly: false };
}

function extractPolicyChannelConfig(row) {
  const rawChannels = val(row, 'notifyChannels');
  const directBh = val(row, 'businessHoursOnly');
  if (Array.isArray(rawChannels)) {
    return {
      notifyChannels: rawChannels,
      businessHoursOnly: typeof directBh === 'boolean' ? directBh : null,
    };
  }
  if (rawChannels && typeof rawChannels === 'object') {
    const channels = Array.isArray(rawChannels.channels) ? rawChannels.channels : null;
    const bh = typeof directBh === 'boolean'
      ? directBh
      : (typeof rawChannels.businessHoursOnly === 'boolean' ? rawChannels.businessHoursOnly : null);
    return {
      notifyChannels: channels,
      businessHoursOnly: bh,
    };
  }
  return {
    notifyChannels: null,
    businessHoursOnly: typeof directBh === 'boolean' ? directBh : null,
  };
}

function resolveEffectivePolicy(policyMap, organizationId, collection, priority, defaultBusinessHoursOnly = false) {
  const fallback = { ...defaultSlaThresholds(priority), businessHoursOnly: Boolean(defaultBusinessHoursOnly) };
  const exact = policyMap.get(`${organizationId}|${collection}|${priority}`);
  const normal = policyMap.get(`${organizationId}|${collection}|normal`);
  const wildcard = policyMap.get(`${organizationId}|${collection}|*`);
  const chosen = exact || normal || wildcard;
  if (!chosen) return fallback;

  const breachAfterMinutes = Math.max(1, Number(val(chosen, 'breachAfterMinutes')) || fallback.breachAfterMinutes);
  const warnAfterMinutes = Math.max(1, Math.min(breachAfterMinutes, Number(val(chosen, 'warnAfterMinutes')) || fallback.warnAfterMinutes));
  const escalateToRole = String(val(chosen, 'escalateToRole') || fallback.escalateToRole).trim() || 'ldx_manager';
  const cfg = extractPolicyChannelConfig(chosen);
  return {
    warnAfterMinutes,
    breachAfterMinutes,
    escalateToRole,
    notifyChannels: cfg.notifyChannels,
    businessHoursOnly: cfg.businessHoursOnly === null ? Boolean(defaultBusinessHoursOnly) : cfg.businessHoursOnly,
  };
}

async function hasRecentSlaChatter(db, organizationId, targetCollection, targetRecordId, cutoffMs) {
  const chatterRepo = db?.getRepository?.('latticeRecordChatter');
  if (!chatterRepo || typeof chatterRepo.find !== 'function') return false;
  try {
    const rows = (await chatterRepo.find({
      filter: {
        organizationId,
        targetCollection,
        targetRecordId: Number(targetRecordId),
        entryType: 'sla_escalation',
      },
      sort: ['-id'],
      limit: 5,
    })) || [];
    return rows.some((r) => {
      if (val(r, 'entryType') !== 'sla_escalation') return false;
      const ts = new Date(val(r, 'createdAt') || 0).getTime();
      return Number.isFinite(ts) && ts > cutoffMs;
    });
  } catch {
    return false;
  }
}

async function evaluateSlaRecord(db, collection, row, { organizationId, policyMap, nowMs, cutoffMs, dryRun, env, fetchImpl, businessHoursOnly = false }) {
  if (val(row, 'active') === false) return { scanned: false };
  const rowOrgId = String(val(row, 'organizationId') || '').trim();
  if (!rowOrgId || (organizationId && rowOrgId !== organizationId)) return { scanned: false };

  const status = String(val(row, 'status') || '').trim().toLowerCase();
  if (!OPEN_SLA_STATUSES.has(status)) return { scanned: false };

  const startRaw = val(row, 'submittedAt') || val(row, 'firstSeenAt') || val(row, 'createdAt');
  const startMs = toTimestampMs(startRaw);
  if (!Number.isFinite(startMs)) return { scanned: true, item: null };

  const priority = String(val(row, 'priority') || val(row, 'severity') || 'normal').trim().toLowerCase();
  const policy = resolveEffectivePolicy(policyMap, rowOrgId, collection, priority, Boolean(businessHoursOnly));
  const elapsedMinutes = computeElapsedSlaMinutes(startMs, nowMs, {
    businessHoursOnly: policy.businessHoursOnly,
  });

  let slaState = 'ok';
  if (elapsedMinutes >= policy.breachAfterMinutes) slaState = 'breached';
  else if (elapsedMinutes >= policy.warnAfterMinutes) slaState = 'warning';
  if (slaState === 'ok') return { scanned: true, item: null };

  const recordId = Number(val(row, 'id'));
  const code = val(row, 'code') || `#${recordId}`;
  const name = val(row, 'name') || '';
  let escalated = false;

  if (slaState === 'breached' && !dryRun && Number.isInteger(recordId) && recordId > 0) {
    const dedupKey = `sla:${collection}:${recordId}:breached`;
    const elapsedRounded = Math.round(elapsedMinutes);
    const title = `Quá hạn SLA (${code})`;
    const body = `${collection} ${code}${name ? ` (${name})` : ''} đã mở ${elapsedRounded} phút, vượt ngưỡng ${policy.breachAfterMinutes} phút.`;

    let dispatchedCount = 0;
    try {
      const roleRes = await dispatchRoleNotifications(db, {
        organizationId: rowOrgId,
        roleNames: [policy.escalateToRole],
        category: 'sla',
        severity: priority === 'critical' ? 'critical' : 'high',
        title,
        body,
        targetCollection: collection,
        targetRecordId: recordId,
        targetPath: resolveNotificationTargetPath(collection),
        dedupKey,
        notifyChannels: policy.notifyChannels,
      }, { env, fetchImpl });
      dispatchedCount = Number(roleRes?.dispatchedCount) || 0;
    } catch {}

    let chatterAdded = false;
    const alreadyLogged = await hasRecentSlaChatter(db, rowOrgId, collection, recordId, cutoffMs);
    if (!alreadyLogged) {
      try {
        const entry = await recordChatterEntry(db, {
          organizationId: rowOrgId,
          targetCollection: collection,
          targetRecordId: recordId,
          entryType: 'sla_escalation',
          body: `Cảnh báo leo thang SLA: ${body} (Chuyển tới ${policy.escalateToRole})`,
          mentionsJson: [],
          diffJson: null,
          authorName: 'sla-engine',
        });
        chatterAdded = Boolean(entry);
      } catch {}
    }
    escalated = dispatchedCount > 0 || chatterAdded;
  }

  return {
    scanned: true,
    item: {
      organizationId: rowOrgId,
      collection,
      recordId,
      code,
      name,
      status,
      priority,
      slaState,
      elapsedMinutes: Math.round(elapsedMinutes),
      warnAfterMinutes: policy.warnAfterMinutes,
      breachAfterMinutes: policy.breachAfterMinutes,
      escalateToRole: policy.escalateToRole,
      businessHoursOnly: policy.businessHoursOnly,
      escalated,
    },
  };
}

async function evaluateCollectionSla(db, collection, options) {
  const repo = db?.getRepository?.(collection);
  if (!repo || typeof repo.find !== 'function') {
    return { scanned: 0, warningCount: 0, breachedCount: 0, escalatedCount: 0, items: [] };
  }

  const filter = {
    status: { $in: [...OPEN_SLA_STATUSES] },
    active: { $ne: false },
    ...(options.organizationId ? { organizationId: options.organizationId } : {}),
  };
  const seenIds = new Set();
  const items = [];
  let scanned = 0;
  let warningCount = 0;
  let breachedCount = 0;
  let escalatedCount = 0;
  let offset = 0;

  while (offset < SLA_MAX_SCAN) {
    const pageLimit = Math.min(SLA_BATCH_SIZE, SLA_MAX_SCAN - offset);
    const batch = (await repo.find({
      filter,
      sort: ['createdAt', 'id'],
      offset,
      limit: pageLimit,
    })) || [];
    if (!batch.length) break;

    let newRowsInBatch = 0;
    for (const row of batch) {
      const rawId = val(row, 'id');
      if (rawId != null) {
        const idKey = String(rawId);
        if (seenIds.has(idKey)) continue;
        seenIds.add(idKey);
      }
      newRowsInBatch += 1;
      const outcome = await evaluateSlaRecord(db, collection, row, options);
      if (outcome.scanned) scanned += 1;
      if (!outcome.item) continue;
      if (outcome.item.slaState === 'warning') warningCount += 1;
      else if (outcome.item.slaState === 'breached') {
        breachedCount += 1;
        if (outcome.item.escalated) escalatedCount += 1;
      }
      items.push(outcome.item);
    }

    if (batch.length < pageLimit || newRowsInBatch === 0) break;
    offset += batch.length;
  }

  return { scanned, warningCount, breachedCount, escalatedCount, items };
}

async function evaluateSlaBreaches(db, { organizationId = null, now = new Date(), env = process.env, fetchImpl, dryRun = false, businessHoursOnly = false } = {}) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const nowMs = Number.isFinite(nowDate.getTime()) ? nowDate.getTime() : Date.now();
  const cutoffMs = Date.now() - DEDUP_WINDOW_MS;

  const policyMap = new Map();
  const policyRepo = db?.getRepository?.('latticeSlaPolicies');
  if (policyRepo && typeof policyRepo.find === 'function') {
    const policies = (await policyRepo.find({
      filter: { active: true, ...(organizationId ? { organizationId } : {}) },
      limit: 1000,
    })) || [];
    for (const pol of policies) {
      if (val(pol, 'active') === false) continue;
      const pOrg = String(val(pol, 'organizationId') || '').trim();
      const pCol = String(val(pol, 'targetCollection') || '').trim();
      const pPrio = String(val(pol, 'priority') || 'normal').trim().toLowerCase();
      if (organizationId && pOrg !== organizationId) continue;
      if (pOrg && pCol) policyMap.set(`${pOrg}|${pCol}|${pPrio}`, pol);
    }
  }

  let scanned = 0;
  let warningCount = 0;
  let breachedCount = 0;
  let escalatedCount = 0;
  const items = [];

  for (const collection of SLA_COLLECTIONS) {
    const colReport = await evaluateCollectionSla(db, collection, {
      organizationId,
      policyMap,
      nowMs,
      cutoffMs,
      dryRun,
      env,
      fetchImpl,
      businessHoursOnly: Boolean(businessHoursOnly),
    });
    scanned += colReport.scanned;
    warningCount += colReport.warningCount;
    breachedCount += colReport.breachedCount;
    escalatedCount += colReport.escalatedCount;
    items.push(...colReport.items);
  }

  return {
    scanned,
    warningCount,
    breachedCount,
    escalatedCount,
    items,
  };
}

function serializePolicy(row) {
  const { notifyChannels, businessHoursOnly } = extractPolicyChannelConfig(row);
  return {
    id: val(row, 'id') ?? null,
    organizationId: val(row, 'organizationId') || null,
    targetCollection: val(row, 'targetCollection') || null,
    priority: val(row, 'priority') || 'normal',
    warnAfterMinutes: Number(val(row, 'warnAfterMinutes')) || 240,
    breachAfterMinutes: Number(val(row, 'breachAfterMinutes')) || 1440,
    escalateToRole: val(row, 'escalateToRole') || 'ldx_manager',
    notifyChannels,
    businessHoursOnly: Boolean(businessHoursOnly),
    active: val(row, 'active') !== false,
    createdAt: val(row, 'createdAt') || null,
    updatedAt: val(row, 'updatedAt') || null,
  };
}

function parseBooleanFlag(value) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return false;
}

function registerSlaEngine(app) {
  const db = app.db;

  const resolveScope = async (ctx, requestedOrgId = null) => {
    if (!ctx?.state?.currentUser) throw failSla('NATIVE_LOGIN_REQUIRED', 401);
    if (ctx.state.currentRole === 'root') {
      const cleanOrg = requestedOrgId ? String(requestedOrgId).trim() : null;
      if (cleanOrg && !ORG_RE.test(cleanOrg)) throw failSla('SLA_ORG_INVALID', 400, 'organizationId không hợp lệ.');
      return { isRoot: true, organizationId: cleanOrg };
    }
    const actor = await resolveNativeActor(db, ctx.state.currentUser);
    return { isRoot: false, organizationId: actor.organizationId };
  };

  const requireAdmin = async (ctx) => {
    if (!ctx?.state?.currentUser) throw failSla('NATIVE_LOGIN_REQUIRED', 401);
    if (!(await isPortalAdmin(ctx, db))) {
      throw failSla('SLA_ADMIN_REQUIRED', 403, 'Chỉ quản trị viên mới có quyền cấu hình hoặc kích hoạt SLA.');
    }
  };

  app.resourceManager.define({
    name: 'latticeSla',
    actions: {
      summary: async (ctx, next) => {
        if ((ctx.method || 'GET') !== 'GET') ctx.throw(405);
        const params = readParams(ctx);
        const { organizationId } = await resolveScope(ctx, params.organizationId);
        const report = await evaluateSlaBreaches(db, {
          organizationId,
          dryRun: true,
          businessHoursOnly: parseBooleanFlag(params.businessHoursOnly),
        });
        ctx.body = { organizationId, ...report };
        return next();
      },

      policies: async (ctx, next) => {
        if ((ctx.method || 'GET') !== 'GET') ctx.throw(405);
        const params = readParams(ctx);
        const { organizationId } = await resolveScope(ctx, params.organizationId);
        const repo = db.getRepository('latticeSlaPolicies');
        if (!repo) {
          ctx.body = { organizationId, items: [] };
          return next();
        }
        const filter = organizationId ? { organizationId } : {};
        const rows = (await repo.find({
          filter,
          sort: ['targetCollection', 'priority', 'id'],
          limit: 200,
        })) || [];
        ctx.body = {
          organizationId,
          items: rows.map(serializePolicy),
        };
        return next();
      },

      savePolicy: async (ctx, next) => {
        if ((ctx.method || 'POST') !== 'POST') ctx.throw(405);
        await requireAdmin(ctx);
        const params = readParams(ctx);
        const { isRoot, organizationId: scopedOrg } = await resolveScope(ctx, params.organizationId);
        const organizationId = isRoot
          ? String(params.organizationId || '').trim()
          : scopedOrg;
        if (!ORG_RE.test(organizationId)) {
          throw failSla('SLA_ORG_REQUIRED', 400, 'Cần organizationId hợp lệ cho chính sách SLA.');
        }

        const targetCollection = String(params.targetCollection || '').trim();
        if (!SLA_COLLECTIONS.includes(targetCollection)) {
          throw failSla('SLA_COLLECTION_INVALID', 400, 'targetCollection không thuộc danh mục hỗ trợ SLA.');
        }

        const priority = String(params.priority || 'normal').trim().toLowerCase();
        if (!VALID_PRIORITIES.has(priority)) {
          throw failSla('SLA_PRIORITY_INVALID', 400, 'Độ ưu tiên SLA không hợp lệ.');
        }

        const warnAfterMinutes = Number(params.warnAfterMinutes ?? 240);
        const breachAfterMinutes = Number(params.breachAfterMinutes ?? 1440);
        if (!Number.isInteger(warnAfterMinutes) || warnAfterMinutes < 1 || !Number.isInteger(breachAfterMinutes) || breachAfterMinutes < warnAfterMinutes) {
          throw failSla('SLA_THRESHOLDS_INVALID', 400, 'Ngưỡng warnAfterMinutes và breachAfterMinutes không hợp lệ.');
        }

        const escalateToRole = String(params.escalateToRole || 'ldx_manager').trim();
        if (!ROLE_RE.test(escalateToRole)) {
          throw failSla('SLA_ROLE_INVALID', 400, 'escalateToRole không hợp lệ.');
        }

        const rawChannels = Array.isArray(params.notifyChannels)
          ? params.notifyChannels
          : (params.notifyChannels && typeof params.notifyChannels === 'object' && Array.isArray(params.notifyChannels.channels)
            ? params.notifyChannels.channels
            : null);
        const cleanChannels = rawChannels
          ? rawChannels.map((c) => String(c || '').trim()).filter(Boolean).slice(0, 10)
          : null;
        const businessHoursOnly = params.businessHoursOnly !== undefined
          ? parseBooleanFlag(params.businessHoursOnly)
          : Boolean(params.notifyChannels && !Array.isArray(params.notifyChannels) && params.notifyChannels.businessHoursOnly === true);
        const notifyChannels = businessHoursOnly
          ? { channels: cleanChannels, businessHoursOnly: true }
          : cleanChannels;
        const active = params.active === undefined ? true : Boolean(params.active);

        const repo = db.getRepository('latticeSlaPolicies');
        if (!repo) throw failSla('SLA_REPO_UNAVAILABLE', 503, 'Kho cấu hình SLA chưa sẵn sàng.');

        const existing = await repo.findOne({ filter: { organizationId, targetCollection, priority } });
        const values = {
          organizationId,
          targetCollection,
          priority,
          warnAfterMinutes,
          breachAfterMinutes,
          escalateToRole,
          notifyChannels,
          active,
        };

        let saved;
        if (existing) {
          if (typeof existing.update === 'function') {
            saved = await existing.update(values);
          } else if (typeof repo.update === 'function') {
            const res = await repo.update({ filterByTk: val(existing, 'id'), filter: { organizationId }, values });
            saved = Array.isArray(res) && res[0] ? res[0] : { ...values, id: val(existing, 'id') };
          }
        } else {
          saved = await repo.create({ values });
        }

        ctx.body = serializePolicy(saved || values);
        return next();
      },

      evaluateNow: async (ctx, next) => {
        if ((ctx.method || 'POST') !== 'POST') ctx.throw(405);
        await requireAdmin(ctx);
        const params = readParams(ctx);
        const { organizationId } = await resolveScope(ctx, params.organizationId);
        ctx.body = await evaluateSlaBreaches(db, {
          organizationId,
          now: new Date(),
          dryRun: false,
          businessHoursOnly: parseBooleanFlag(params.businessHoursOnly),
        });
        return next();
      },
    },
  });

  app.acl.allow('latticeSla', ['summary', 'policies', 'savePolicy', 'evaluateNow'], 'loggedIn');

  if (process.env.DX_SLA_CRON_ENABLED === 'true' && !app._latticeSlaCronRegistered) {
    app._latticeSlaCronRegistered = true;
    const intervalMs = Math.max(60_000, Number(process.env.DX_SLA_INTERVAL_MS) || 5 * 60_000);
    if (app.cronJobManager && typeof app.cronJobManager.addJob === 'function') {
      app.cronJobManager.addJob({
        cronTime: '*/5 * * * *',
        onTick: async () => {
          try {
            await evaluateSlaBreaches(db);
          } catch (err) {
            app.logger?.error?.('SLA evaluation job failed.', { error: err?.message || String(err) });
          }
        },
      });
    } else {
      const timer = setInterval(() => {
        evaluateSlaBreaches(db).catch((err) => {
          app.logger?.error?.('SLA evaluation interval failed.', { error: err?.message || String(err) });
        });
      }, intervalMs);
      if (typeof timer.unref === 'function') timer.unref();
      app._latticeSlaTimer = timer;
    }
  }
}

module.exports = {
  SLA_COLLECTIONS,
  OPEN_SLA_STATUSES,
  VN_UTC_OFFSET_MS,
  VN_FIXED_HOLIDAYS,
  VN_BUSINESS_WINDOWS,
  computeElapsedSlaMinutes,
  defaultSlaThresholds,
  evaluateSlaBreaches,
  registerSlaEngine,
};
