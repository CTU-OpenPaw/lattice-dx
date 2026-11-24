/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { defaultFoundation, fail, toPlain, val } = require('../wms-dmn-shared');
const { runAutomationWithRls } = require('./security-helpers');

const SCHEDULER_LOCK_KEY = 'dxos_flow_scheduler_tick';
const WEEKDAY_MAP = Object.freeze({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 });

function invalidCron(msg) {
  return fail('FLOW_INVALID_CRON', 400, `FLOW_INVALID_CRON: ${msg}`);
}

function parseCronField(rawField, min, max, { mapSevenToZero = false } = {}) {
  const token = String(rawField || '').trim();
  if (!token) throw invalidCron('Empty cron field');
  const values = new Set();
  const wildcard = token === '*';

  for (const part of token.split(',')) {
    const clean = part.trim();
    if (!clean) throw invalidCron(`Invalid cron token "${token}"`);
    const slashParts = clean.split('/');
    if (slashParts.length > 2) throw invalidCron(`Invalid cron step "${clean}"`);

    const [rangePart, stepRaw] = slashParts;
    let step = 1;
    if (stepRaw !== undefined) {
      if (!/^\d+$/.test(stepRaw)) throw invalidCron(`Invalid cron step "${stepRaw}"`);
      step = Number(stepRaw);
      if (!Number.isInteger(step) || step < 1) throw invalidCron(`Cron step must be >= 1: "${stepRaw}"`);
    }

    let start;
    let end;
    if (rangePart === '*') {
      start = min;
      end = max;
    } else if (rangePart.includes('-')) {
      const bounds = rangePart.split('-');
      if (bounds.length !== 2 || !/^\d+$/.test(bounds[0]) || !/^\d+$/.test(bounds[1])) {
        throw invalidCron(`Invalid cron range "${rangePart}"`);
      }
      start = Number(bounds[0]);
      end = Number(bounds[1]);
      if (start < min || end > max || start > end) {
        throw invalidCron(`Cron range out of bounds "${rangePart}" (${min}..${max})`);
      }
    } else {
      if (!/^\d+$/.test(rangePart)) throw invalidCron(`Invalid cron number "${rangePart}"`);
      start = Number(rangePart);
      if (start < min || start > max) {
        throw invalidCron(`Cron value out of bounds "${rangePart}" (${min}..${max})`);
      }
      end = slashParts.length === 2 ? max : start;
    }

    for (let v = start; v <= end; v += step) {
      values.add(mapSevenToZero && v === 7 ? 0 : v);
    }
  }

  if (!values.size) throw invalidCron(`Cron field produced no values: "${token}"`);
  return { values, wildcard };
}

function parseCronExpression(expr) {
  if (typeof expr !== 'string' || !expr.trim()) {
    throw invalidCron('Cron expression must be a non-empty 5-field string');
  }
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw invalidCron(`Cron expression must have 5 fields, got ${fields.length}`);
  }
  const minute = parseCronField(fields[0], 0, 59);
  const hour = parseCronField(fields[1], 0, 23);
  const dom = parseCronField(fields[2], 1, 31);
  const month = parseCronField(fields[3], 1, 12);
  const dow = parseCronField(fields[4], 0, 7, { mapSevenToZero: true });
  return {
    expression: fields.join(' '),
    minute: minute.values,
    hour: hour.values,
    dom: dom.values,
    month: month.values,
    dow: dow.values,
    domWildcard: dom.wildcard,
    dowWildcard: dow.wildcard,
  };
}

const formatterCache = new Map();
function getDatePartsInZone(date, timezone = 'UTC') {
  const tz = typeof timezone === 'string' && timezone.trim() ? timezone.trim() : 'UTC';
  if (tz.toUpperCase() === 'UTC') {
    return {
      minute: date.getUTCMinutes(),
      hour: date.getUTCHours(),
      dom: date.getUTCDate(),
      month: date.getUTCMonth() + 1,
      dow: date.getUTCDay(),
      isUtc: true,
    };
  }
  try {
    let fmt = formatterCache.get(tz);
    if (!fmt) {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hour12: false,
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        weekday: 'short',
        hour: 'numeric',
        minute: 'numeric',
      });
      if (formatterCache.size > 64) formatterCache.clear();
      formatterCache.set(tz, fmt);
    }
    const parts = fmt.formatToParts(date);
    const bag = {};
    for (const p of parts) {
      if (p.type !== 'literal') bag[p.type] = p.value;
    }
    const rawHour = Number(bag.hour);
    return {
      minute: Number(bag.minute),
      hour: rawHour === 24 ? 0 : rawHour,
      dom: Number(bag.day),
      month: Number(bag.month),
      dow: WEEKDAY_MAP[bag.weekday] ?? date.getUTCDay(),
      isUtc: false,
    };
  } catch {
    return {
      minute: date.getUTCMinutes(),
      hour: date.getUTCHours(),
      dom: date.getUTCDate(),
      month: date.getUTCMonth() + 1,
      dow: date.getUTCDay(),
      isUtc: true,
    };
  }
}

function matchesParsedCron(parsed, parts) {
  if (!parsed.minute.has(parts.minute)) return false;
  if (!parsed.hour.has(parts.hour)) return false;
  if (!parsed.month.has(parts.month)) return false;
  if (!parsed.domWildcard && !parsed.dowWildcard) {
    return parsed.dom.has(parts.dom) || parsed.dow.has(parts.dow);
  }
  return parsed.dom.has(parts.dom) && parsed.dow.has(parts.dow);
}

function matchesCron(expr, date = new Date(), timezone = 'UTC') {
  const dt = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(dt.getTime())) {
    throw fail('FLOW_INVALID_CRON', 400, 'Invalid date passed to matchesCron');
  }
  const parsed = parseCronExpression(expr);
  return matchesParsedCron(parsed, getDatePartsInZone(dt, timezone));
}

function computeNextCronRun(expr, fromDate = new Date(), options = {}) {
  const dt = fromDate instanceof Date ? fromDate : new Date(fromDate);
  const baseMs = dt.getTime();
  if (!Number.isFinite(baseMs)) {
    throw fail('FLOW_INVALID_CRON', 400, 'Invalid reference date for computeNextCronRun');
  }
  const parsed = parseCronExpression(expr);
  const timezone = typeof options === 'string' ? options : (options?.timezone || 'UTC');
  const isUtc = !timezone || String(timezone).trim().toUpperCase() === 'UTC';

  let cursorMs = Math.floor(baseMs / 60_000) * 60_000 + 60_000;
  const maxMs = cursorMs + 366 * 86_400_000;
  while (cursorMs <= maxMs) {
    const curDate = new Date(cursorMs);
    const parts = getDatePartsInZone(curDate, timezone);
    const dayMatches = (!parsed.domWildcard && !parsed.dowWildcard)
      ? (parsed.dom.has(parts.dom) || parsed.dow.has(parts.dow))
      : (parsed.dom.has(parts.dom) && parsed.dow.has(parts.dow));

    if (!parsed.month.has(parts.month) || !dayMatches) {
      if (isUtc && parts.hour === 0 && parts.minute === 0) {
        cursorMs += 86_400_000;
      } else if (isUtc && parts.minute === 0) {
        cursorMs += (24 - parts.hour) * 3_600_000;
      } else if (cursorMs % 900_000 === 0 && !parsed.hour.has(parts.hour)) {
        cursorMs += 900_000;
      } else {
        cursorMs += 60_000;
      }
      continue;
    }

    if (!parsed.hour.has(parts.hour)) {
      if (isUtc && parts.minute === 0) {
        cursorMs += 3_600_000;
      } else if (cursorMs % 900_000 === 0) {
        cursorMs += 900_000;
      } else {
        cursorMs += 60_000;
      }
      continue;
    }

    if (parsed.minute.has(parts.minute)) {
      return curDate;
    }
    cursorMs += 60_000;
  }

  throw fail('FLOW_INVALID_CRON', 400, `Unable to find next cron execution within 366 days for "${expr}"`);
}

function extractScheduleConfigFromRule(rulePlain) {
  if (!rulePlain || typeof rulePlain !== 'object') return null;
  const nodes = Array.isArray(rulePlain.graphJson?.nodes) ? rulePlain.graphJson.nodes : [];
  const schedNode = nodes.find((n) => n?.type === 'trigger.schedule');
  const idxEntry = Array.isArray(rulePlain.triggerIndexJson)
    ? rulePlain.triggerIndexJson.find((t) => t?.triggerType === 'schedule')
    : null;
  const cron = String(rulePlain.cronExpression || schedNode?.config?.cron || idxEntry?.cron || '').trim();
  if (!cron) return null;
  const timezone = String(schedNode?.config?.timezone || idxEntry?.timezone || 'UTC').trim() || 'UTC';
  return { cron, cronExpression: cron, timezone };
}

async function runWithSchedulerLock(db, options, fn) {
  const pgRls = defaultFoundation?.pgRls;
  const sequelize = db?.sequelize;
  const isPg = typeof sequelize?.getDialect === 'function' && sequelize.getDialect() === 'postgres';
  const useBypass = !options?.organizationId && typeof pgRls?.canUsePgRlsSession === 'function' && pgRls.canUsePgRlsSession(db);

  const runInsideTx = async (transaction) => {
    if (isPg && typeof sequelize?.query === 'function') {
      const [rows] = await sequelize.query(
        'SELECT pg_try_advisory_xact_lock(hashtext(:lockKey)) AS acquired',
        { replacements: { lockKey: SCHEDULER_LOCK_KEY }, ...(transaction ? { transaction } : {}) },
      );
      if (Array.isArray(rows) && rows[0] && rows[0].acquired === false) {
        return { skippedLock: true, value: null };
      }
    }
    return { skippedLock: false, value: await fn(transaction) };
  };

  if (useBypass && typeof pgRls?.withSystemRlsBypass === 'function') {
    if (typeof pgRls?.installRlsTransactionBridge === 'function') pgRls.installRlsTransactionBridge(db);
    return pgRls.withSystemRlsBypass(db, runInsideTx);
  }
  if (isPg && typeof sequelize?.transaction === 'function') {
    return sequelize.transaction(runInsideTx);
  }
  return runInsideTx(null);
}

async function tickScheduledRules(db, options = {}) {
  const rulesRepo = db?.getRepository?.('latticeAutomationRules');
  const nowDate = options.now ? new Date(options.now) : new Date();
  if (!rulesRepo?.find || !Number.isFinite(nowDate.getTime())) {
    return { processedCount: 0, results: [] };
  }

  const scanRes = await runWithSchedulerLock(db, options, async (transaction) => {
    const txOpt = transaction ? { transaction } : {};
    const rows = (await rulesRepo.find({
      filter: { active: true, ...(options.organizationId ? { organizationId: options.organizationId } : {}) },
      limit: Math.min(200, Math.max(1, Number(options.batchSize) || 100)),
      ...txOpt,
    })) || [];

    const due = [];
    for (const row of rows) {
      const rule = toPlain(row);
      if (!rule || rule.active === false || !rule.organizationId) continue;
      const sched = extractScheduleConfigFromRule(rule);
      if (!sched) continue;

      let nextRunAt = rule.nextRunAt ? new Date(rule.nextRunAt) : null;
      const nowMs = nowDate.getTime();
      let isDue = false;
      try {
        if (nextRunAt && Number.isFinite(nextRunAt.getTime())) {
          isDue = nextRunAt.getTime() <= nowMs;
        } else {
          const lastMs = rule.lastTriggeredAt ? new Date(rule.lastTriggeredAt).getTime() : NaN;
          const sameMinute = Number.isFinite(lastMs) && Math.floor(lastMs / 60_000) === Math.floor(nowMs / 60_000);
          isDue = !sameMinute && matchesCron(sched.cron, nowDate, sched.timezone);
          if (!isDue && typeof rulesRepo.update === 'function') {
            const initializedNext = computeNextCronRun(sched.cron, nowDate, { timezone: sched.timezone });
            await rulesRepo.update({
              filter: { organizationId: rule.organizationId, ruleKey: rule.ruleKey },
              values: { cronExpression: sched.cron, nextRunAt: initializedNext },
              ...txOpt,
            }).catch(() => {});
          }
        }
        if (isDue) {
          const computedNext = computeNextCronRun(sched.cron, nowDate, { timezone: sched.timezone });
          if (typeof rulesRepo.update === 'function') {
            await rulesRepo.update({
              filter: { organizationId: rule.organizationId, ruleKey: rule.ruleKey },
              values: { cronExpression: sched.cron, nextRunAt: computedNext, lastTriggeredAt: nowDate },
              ...txOpt,
            });
          }
          due.push({ rule, cron: sched.cron, timezone: sched.timezone });
        }
      } catch {
        // Skip invalid cron rule without crashing the ticker
      }
    }
    return due;
  });

  if (scanRes.skippedLock || !Array.isArray(scanRes.value)) {
    return { processedCount: 0, results: [], skippedLock: Boolean(scanRes.skippedLock) };
  }

  const executor = require('./executor');
  const results = [];
  for (const item of scanRes.value) {
    const orgId = item.rule.organizationId;
    await runAutomationWithRls(db, orgId, async () => {
      try {
        const run = await executor.executeFlowGraph(
          db,
          item.rule,
          {
            type: 'schedule.cron',
            source: 'dxos-studio:scheduler',
            subject: item.rule.ruleKey,
            organizationId: orgId,
            data: { cron: item.cron, timezone: item.timezone, scheduledAt: nowDate.toISOString() },
            schedule: { cron: item.cron, timezone: item.timezone, scheduledAt: nowDate.toISOString() },
          },
          { ...options, organizationId: orgId, ignoreCooldown: options.ignoreCooldown ?? true },
        );
        results.push({ ruleKey: item.rule.ruleKey, runUid: run.runUid, status: run.status });
      } catch (err) {
        results.push({ ruleKey: item.rule.ruleKey, status: 'failed', error: err?.message || String(err) });
      }
    });
  }
  return { processedCount: results.length, results };
}

async function tickExpiredApprovals(db, options = {}) {
  const runsRepo = db?.getRepository?.('latticeAutomationRuns');
  const queueRepo = db?.getRepository?.('latticeAiApprovalQueue');
  const nowDate = options.now ? new Date(options.now) : new Date();
  const nowMs = nowDate.getTime();
  if (!runsRepo?.find || !Number.isFinite(nowMs)) {
    return { processedCount: 0, results: [] };
  }

  const scanRes = await runWithSchedulerLock(db, options, async (transaction) => {
    const txOpt = transaction ? { transaction } : {};
    const limit = Math.min(100, Math.max(1, Number(options.batchSize) || 50));
    const suspended = (await runsRepo.find({
      filter: { status: 'suspended', ...(options.organizationId ? { organizationId: options.organizationId } : {}) },
      limit,
      ...txOpt,
    })) || [];

    const expired = [];
    for (const r of suspended.map(toPlain)) {
      if (!r || r.status !== 'suspended') continue;
      const resumeMs = r.resumeAt ? new Date(r.resumeAt).getTime() : NaN;
      const isApproval = r.approvalId != null || r.nodeStatesJson?.[r.suspendedNodeId]?.suspend?.kind === 'approval';
      if (!isApproval || !Number.isFinite(resumeMs) || resumeMs > nowMs) continue;

      if (r.approvalId != null && queueRepo && typeof queueRepo.update === 'function') {
        await queueRepo.update({
          filter: { organizationId: r.organizationId, id: r.approvalId, status: 'pending' },
          values: { status: 'expired' },
          ...txOpt,
        }).catch(() => {});
      }
      if (typeof runsRepo.update === 'function') {
        await runsRepo.update({
          filter: { organizationId: r.organizationId, runUid: r.runUid, status: 'suspended' },
          values: {
            status: 'expired',
            errorMessage: 'APPROVAL_EXPIRED',
            finishedAt: nowDate,
            suspendedNodeId: null,
            resumeTokenHash: null,
          },
          ...txOpt,
        });
      }
      expired.push({ runUid: r.runUid, approvalId: r.approvalId ?? null, status: 'expired' });
    }

    if (queueRepo && typeof queueRepo.find === 'function' && typeof queueRepo.update === 'function') {
      const pendingItems = (await queueRepo.find({
        filter: { status: 'pending', ...(options.organizationId ? { organizationId: options.organizationId } : {}) },
        limit,
        ...txOpt,
      })) || [];
      for (const q of pendingItems) {
        const expRaw = val(q, 'expiresAt');
        const expMs = expRaw ? new Date(expRaw).getTime() : NaN;
        if (Number.isFinite(expMs) && expMs <= nowMs) {
          await queueRepo.update({
            filter: { organizationId: val(q, 'organizationId'), id: val(q, 'id'), status: 'pending' },
            values: { status: 'expired' },
            ...txOpt,
          }).catch(() => {});
        }
      }
    }

    return expired;
  });

  if (scanRes.skippedLock || !Array.isArray(scanRes.value)) {
    return { processedCount: 0, results: [], skippedLock: Boolean(scanRes.skippedLock) };
  }
  return { processedCount: scanRes.value.length, results: scanRes.value };
}

async function tickFlowScheduler(db, options = {}) {
  const executor = require('./executor');
  const scheduled = await tickScheduledRules(db, options);
  const delayed = await executor.tickDueDelayedRuns(db, options);
  const expired = await tickExpiredApprovals(db, options);
  return { scheduled, delayed, expired };
}

module.exports = {
  parseCronExpression,
  matchesCron,
  computeNextCronRun,
  extractScheduleConfigFromRule,
  runWithSchedulerLock,
  tickScheduledRules,
  tickExpiredApprovals,
  tickFlowScheduler,
};
