/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const SENSITIVE_KEY_RE = /token|secret|password|apikey|api_key|authorization|cookie|credential|jwt|bearer|privatekey|private_key|sessionid|session_id|passphrase|access_key|client_secret/i;

const DEFAULT_PRICING_USD_PER_1M = { input: 0.35, output: 1.05 };
const MODEL_PRICING_USD_PER_1M = {
  'ag/gemini-3.8-flash': { input: 0.15, output: 0.60 },
  'gemini-3.8-flash': { input: 0.15, output: 0.60 },
  'gemini-2.5-flash': { input: 0.15, output: 0.60 },
  'gemini-2.0-flash': { input: 0.10, output: 0.40 },
  'gemini-2.5-pro': { input: 1.25, output: 10.00 },
  'gpt-4o': { input: 2.50, output: 10.00 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'claude-sonnet': { input: 3.00, output: 15.00 },
  'claude-3-5-sonnet': { input: 3.00, output: 15.00 },
  'claude-sonnet-4': { input: 3.00, output: 15.00 },
  combo: { input: 0.35, output: 1.05 },
  ollama: { input: 0, output: 0 },
};

const quotaBuckets = new Map();
const readVal = (row, key) => (typeof row?.get === 'function' ? row.get(key) : row?.[key]);
const nonNegInt = (v) => Math.max(0, Math.trunc(Number(v) || 0));

function utcDayKey(now = new Date()) {
  return new Date(now).toISOString().slice(0, 10);
}

function replaceCounted(text, regex, replacement) {
  let hits = 0;
  const next = text.replace(regex, (...args) => {
    hits += 1;
    if (typeof replacement === 'function') return replacement(...args);
    const full = args[0];
    if (replacement.includes('$1') && args.length >= 2) {
      return replacement.replace('$1', String(args[1] ?? ''));
    }
    return replacement || full;
  });
  return { text: next, hits };
}

function redactPiiText(rawText) {
  let text = String(rawText ?? '');
  if (!text) return { text, count: 0 };
  let count = 0;
  const rules = [
    [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\b/g, '[REDACTED_JWT]'],
    [/(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, '$1[REDACTED]'],
    [/\bsk-[A-Za-z0-9_-]{6,}\b/g, '[REDACTED_KEY]'],
    [/([a-zA-Z0-9_]*(?:token|secret|password|apikey|api_key|jwt|privateKey|client_secret)\s*[:=]\s*)(?:"[^"]+"|'[^']+'|[^\s,;}"']+)/gi, '$1[REDACTED]'],
    [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED_EMAIL]'],
    [/(\b(?:cccd|cmnd|căn cước(?:\s+công dân)?)\s*[:#=-]?\s*)\d{9,12}\b/gi, '$1[REDACTED_CCCD]'],
    [/(?<![0-9A-Za-z-])0\d{11}(?![0-9A-Za-z-])/g, '[REDACTED_CCCD]'],
    [/(?<![0-9A-Za-z-])(?:\+?84[\s.-]?|0)(?:3|5|7|8|9)(?:[\s.-]?\d){8}(?![0-9A-Za-z-])/g, '[REDACTED_PHONE]'],
    [/(\b(?:stk|số tài khoản|tài khoản ngân hàng|iban)\s*[:#=-]?\s*)[A-Z0-9 -]{8,24}(?=\s*[,;.\n]|$)/gi, '$1[REDACTED_BANK]'],
    [/(\b(?:mst|mã số thuế)\s*[:#=-]?\s*)\d{10}(?:-\d{3})?\b/gi, '$1[REDACTED_MST]'],
  ];
  for (const [regex, replacement] of rules) {
    const res = replaceCounted(text, regex, replacement);
    text = res.text;
    count += res.hits;
  }
  return { text, count };
}

function redactPiiString(rawText) {
  return redactPiiText(rawText).text;
}

function redactPiiDeep(value, depth = 0) {
  if (depth > 4) return { value: '[TRUNCATED]', count: 0 };
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return { value, count: 0 };
  if (typeof value === 'string') {
    const trimmed = value.length > 600 ? `${value.slice(0, 600)}...` : value;
    const { text, count } = redactPiiText(trimmed);
    return { value: text, count };
  }
  if (Array.isArray(value)) {
    let count = 0;
    const out = value.slice(0, 20).map((item) => {
      const r = redactPiiDeep(item, depth + 1);
      count += r.count;
      return r.value;
    });
    return { value: out, count };
  }
  if (typeof value === 'object') {
    let count = 0;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEY_RE.test(k)) {
        out[k] = '[REDACTED]';
        count += 1;
      } else {
        const r = redactPiiDeep(v, depth + 1);
        out[k] = r.value;
        count += r.count;
      }
    }
    return { value: out, count };
  }
  return { value: String(value), count: 0 };
}

function estimateTokens(input) {
  const str = typeof input === 'string' ? input : JSON.stringify(input ?? '');
  if (!str) return 1;
  return Math.max(1, Math.ceil(str.length / 3.2));
}

function resolveModelPricing(modelName = '', env = process.env) {
  const raw = String(modelName || '').trim().toLowerCase();
  let base = DEFAULT_PRICING_USD_PER_1M;
  if (raw) {
    if (Object.hasOwn(MODEL_PRICING_USD_PER_1M, raw)) {
      base = MODEL_PRICING_USD_PER_1M[raw];
    } else if (raw.includes('ollama') || raw.startsWith('local/') || raw.includes(':local')) {
      base = MODEL_PRICING_USD_PER_1M.ollama;
    } else {
      const orderedKeys = [
        'gpt-4o-mini', 'gpt-4o', 'gemini-2.5-pro', 'gemini-2.5-flash',
        'gemini-3.8-flash', 'gemini-2.0-flash', 'claude-3-5-sonnet',
        'claude-sonnet-4', 'claude-sonnet', 'combo',
      ];
      const matched = orderedKeys.find((k) => raw.includes(k));
      if (matched) base = MODEL_PRICING_USD_PER_1M[matched] || DEFAULT_PRICING_USD_PER_1M;
      else if (raw.includes('sonnet')) base = MODEL_PRICING_USD_PER_1M['claude-sonnet'] || DEFAULT_PRICING_USD_PER_1M;
      else if (raw.includes('flash')) base = MODEL_PRICING_USD_PER_1M['gemini-2.5-flash'] || DEFAULT_PRICING_USD_PER_1M;
    }
  }
  const safeBase = base || DEFAULT_PRICING_USD_PER_1M;
  const hasEnvIn = env?.DXOS_AI_USD_PER_1M_INPUT !== undefined && String(env.DXOS_AI_USD_PER_1M_INPUT).trim() !== '';
  const hasEnvOut = env?.DXOS_AI_USD_PER_1M_OUTPUT !== undefined && String(env.DXOS_AI_USD_PER_1M_OUTPUT).trim() !== '';
  const parsedIn = hasEnvIn ? Number(env.DXOS_AI_USD_PER_1M_INPUT) : NaN;
  const parsedOut = hasEnvOut ? Number(env.DXOS_AI_USD_PER_1M_OUTPUT) : NaN;
  return {
    input: Number.isFinite(parsedIn) && parsedIn >= 0 ? parsedIn : safeBase.input,
    output: Number.isFinite(parsedOut) && parsedOut >= 0 ? parsedOut : safeBase.output,
  };
}

function estimateCostUsd(promptTokens = 0, completionTokens = 0, modelName = '', env = process.env) {
  const { input, output } = resolveModelPricing(modelName, env);
  const cost = ((Number(promptTokens) || 0) * input + (Number(completionTokens) || 0) * output) / 1_000_000;
  return Number(cost.toFixed(6));
}

function getQuotaLimits(env = process.env) {
  const num = (key, def) => {
    const parsed = Number(env?.[key]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : def;
  };
  return {
    orgDailyCalls: num('DXOS_AI_DAILY_ORG_CALL_LIMIT', 5000),
    userDailyCalls: num('DXOS_AI_DAILY_USER_CALL_LIMIT', 500),
    orgDailyTokens: num('DXOS_AI_DAILY_ORG_TOKEN_LIMIT', 5_000_000),
    orgDailyUsd: num('DXOS_AI_DAILY_ORG_USD_LIMIT', 50),
  };
}

function getOrCreateOrgBucket(organizationId, now = new Date()) {
  const day = utcDayKey(now);
  const org = String(organizationId || 'default').trim() || 'default';
  const key = `${org}::${day}`;
  // Evict prior day buckets cleanly
  if (quotaBuckets.size > 500) {
    for (const [k] of quotaBuckets.entries()) {
      if (!k.endsWith(`::${day}`)) quotaBuckets.delete(k);
    }
  }
  let bucket = quotaBuckets.get(key);
  if (!bucket) {
    bucket = {
      organizationId: org,
      day,
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      tokens: 0,
      costUsd: 0,
      piiRedacted: 0,
      hydrated: false,
      byUser: new Map(),
    };
    quotaBuckets.set(key, bucket);
  }
  return bucket;
}

function quotaError(message, details) {
  return Object.assign(new Error(message), {
    status: 429,
    code: 'AI_QUOTA_EXCEEDED',
    details,
  });
}

function checkAndConsumeAiQuota(actor = {}, { estimatedPromptTokens = 0, env = process.env, now = new Date() } = {}) {
  const limits = getQuotaLimits(env);
  const bucket = getOrCreateOrgBucket(actor.organizationId, now);
  const userKey = String(actor.userId || actor.username || 'anon');
  const userEntry = bucket.byUser.get(userKey) || { calls: 0, tokens: 0 };

  if (bucket.calls + 1 > limits.orgDailyCalls) {
    throw quotaError(`Tổ chức "${bucket.organizationId}" đã vượt hạn mức gọi AI trong ngày (${limits.orgDailyCalls}).`, { scope: 'organization', metric: 'calls', limit: limits.orgDailyCalls });
  }
  if (userEntry.calls + 1 > limits.userDailyCalls) {
    throw quotaError(`Tài khoản đã vượt hạn mức gọi AI cá nhân trong ngày (${limits.userDailyCalls}).`, { scope: 'user', metric: 'calls', limit: limits.userDailyCalls });
  }
  if (bucket.tokens + (Number(estimatedPromptTokens) || 0) > limits.orgDailyTokens) {
    throw quotaError(`Tổ chức "${bucket.organizationId}" đã vượt hạn mức token AI trong ngày (${limits.orgDailyTokens}).`, { scope: 'organization', metric: 'tokens', limit: limits.orgDailyTokens });
  }
  if (bucket.costUsd >= limits.orgDailyUsd) {
    throw quotaError(`Tổ chức "${bucket.organizationId}" đã đạt trần chi phí AI trong ngày ($${limits.orgDailyUsd}).`, { scope: 'organization', metric: 'costUsd', limit: limits.orgDailyUsd });
  }
  return { organizationId: bucket.organizationId, day: bucket.day, limits };
}

function recordQuotaUsage(actor = {}, { promptTokens = 0, completionTokens = 0, costUsd = 0, piiRedactedCount = 0 } = {}, now = new Date()) {
  const bucket = getOrCreateOrgBucket(actor.organizationId, now);
  const userKey = String(actor.userId || actor.username || 'anon');
  const userEntry = bucket.byUser.get(userKey) || { calls: 0, tokens: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, piiRedacted: 0 };
  const pTok = nonNegInt(promptTokens);
  const cTok = nonNegInt(completionTokens);
  const totalTok = pTok + cTok;
  const deltaCost = Math.max(0, Number(costUsd) || 0);
  const deltaPii = nonNegInt(piiRedactedCount);
  bucket.calls += 1;
  bucket.promptTokens = (bucket.promptTokens || 0) + pTok;
  bucket.completionTokens = (bucket.completionTokens || 0) + cTok;
  bucket.tokens += totalTok;
  bucket.costUsd = Number((bucket.costUsd + deltaCost).toFixed(6));
  bucket.piiRedacted += deltaPii;
  userEntry.calls += 1;
  userEntry.promptTokens = (userEntry.promptTokens || 0) + pTok;
  userEntry.completionTokens = (userEntry.completionTokens || 0) + cTok;
  userEntry.tokens += totalTok;
  userEntry.costUsd = Number(((userEntry.costUsd || 0) + deltaCost).toFixed(6));
  userEntry.piiRedacted = (userEntry.piiRedacted || 0) + deltaPii;
  bucket.byUser.set(userKey, userEntry);
  return {
    calls: bucket.calls,
    tokens: bucket.tokens,
    promptTokens: bucket.promptTokens,
    completionTokens: bucket.completionTokens,
    costUsd: bucket.costUsd,
    piiRedacted: bucket.piiRedacted,
  };
}

function applyAggregatedRowsToBucket(bucket, rows) {
  if (!Array.isArray(rows) || !rows.length) return false;
  let totalCalls = 0;
  let totalPrompt = 0;
  let totalCompletion = 0;
  let totalCost = 0;
  let totalPii = 0;
  const nextByUser = new Map();

  for (const r of rows) {
    const userKey = String(readVal(r, 'userId') || 'anon');
    const calls = Math.max(0, Number(readVal(r, 'calls')) || 0);
    const pTok = Math.max(0, Number(readVal(r, 'promptTokens')) || 0);
    const cTok = Math.max(0, Number(readVal(r, 'completionTokens')) || 0);
    const costUsd = Math.max(0, Number(readVal(r, 'costUsd')) || 0);
    const piiRedacted = Math.max(0, Number(readVal(r, 'piiRedacted')) || 0);
    totalCalls += calls;
    totalPrompt += pTok;
    totalCompletion += cTok;
    totalCost += costUsd;
    totalPii += piiRedacted;
    const prev = nextByUser.get(userKey) || { calls: 0, tokens: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, piiRedacted: 0 };
    nextByUser.set(userKey, {
      calls: prev.calls + calls,
      promptTokens: prev.promptTokens + pTok,
      completionTokens: prev.completionTokens + cTok,
      tokens: prev.tokens + pTok + cTok,
      costUsd: Number((prev.costUsd + costUsd).toFixed(6)),
      piiRedacted: prev.piiRedacted + piiRedacted,
    });
  }

  if ((!bucket.hydrated && totalCalls > 0) || totalCalls > bucket.calls) {
    bucket.calls = totalCalls;
    bucket.promptTokens = totalPrompt;
    bucket.completionTokens = totalCompletion;
    bucket.tokens = totalPrompt + totalCompletion;
    bucket.costUsd = Number(totalCost.toFixed(6));
    bucket.piiRedacted = totalPii;
    bucket.byUser = nextByUser;
    bucket.hydrated = true;
    return true;
  }
  return false;
}

async function loadQuotaBucketRows(db, org, day) {
  const quotaRepo = db?.getRepository?.('latticeAiQuotaUsage');
  if (quotaRepo && typeof quotaRepo.find === 'function') {
    const rows = await quotaRepo.find({ filter: { organizationId: org, dayKey: day }, limit: 1000 });
    if (Array.isArray(rows) && rows.length) return rows;
  }
  if (typeof db?.sequelize?.query === 'function') {
    try {
      const [sqlRows] = await db.sequelize.query(
        'SELECT "userId", calls, "promptTokens", "completionTokens", "costUsd", "piiRedacted" FROM "latticeAiQuotaUsage" WHERE "organizationId" = :organizationId AND "dayKey" = :dayKey;',
        { replacements: { organizationId: org, dayKey: day } },
      );
      if (Array.isArray(sqlRows) && sqlRows.length) return sqlRows;
    } catch {
      // Fall back to audit log aggregation if quota table is unavailable
    }
  }
  return [];
}

async function loadSameDayAuditFallbackRows(db, org, day) {
  if (typeof db?.sequelize?.query === 'function') {
    try {
      const dayStart = new Date(`${day}T00:00:00.000Z`);
      const dayEnd = new Date(dayStart.getTime() + 86_400_000);
      const [sqlRows] = await db.sequelize.query(
        `SELECT COALESCE(CAST("actorUserId" AS TEXT), "actorUsername", 'anon') AS "userId",
                COUNT(*)::int AS calls,
                COALESCE(SUM("promptTokens"), 0)::bigint AS "promptTokens",
                COALESCE(SUM("completionTokens"), 0)::bigint AS "completionTokens",
                COALESCE(SUM("estimatedCostUsd"), 0)::double precision AS "costUsd",
                COALESCE(SUM("piiRedactedCount"), 0)::int AS "piiRedacted"
         FROM "latticeAiAuditLogs"
         WHERE "organizationId" = :organizationId
           AND status IN ('allowed', 'degraded')
           AND COALESCE(channel, '') <> 'studio-sync'
           AND ("actorUserId" IS NOT NULL OR "actorUsername" IS NOT NULL)
           AND "createdAt" >= :dayStart
           AND "createdAt" < :dayEnd
         GROUP BY 1;`,
        { replacements: { organizationId: org, dayStart, dayEnd } },
      );
      if (Array.isArray(sqlRows) && sqlRows.length) return sqlRows;
    } catch {
      // Fallback to repository query in mock or non-PG adapters
    }
  }
  const auditRepo = db?.getRepository?.('latticeAiAuditLogs');
  if (!auditRepo || typeof auditRepo.find !== 'function') return [];
  const logs = (await auditRepo.find({ filter: { organizationId: org }, sort: ['-id'], limit: 2000 })) || [];
  const perUser = new Map();
  for (const row of logs) {
    const status = String(readVal(row, 'status') || '').toLowerCase();
    if (status !== 'allowed' && status !== 'degraded') continue;
    const channel = String(readVal(row, 'channel') || '').toLowerCase();
    if (channel === 'studio-sync') continue;
    const actorKey = readVal(row, 'actorUserId') ?? readVal(row, 'actorUsername');
    if (actorKey == null || actorKey === '') continue;
    const created = readVal(row, 'createdAt');
    if (!created || utcDayKey(created) !== day) continue;
    const userKey = String(actorKey);
    const entry = perUser.get(userKey) || { userId: userKey, calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, piiRedacted: 0 };
    entry.calls += 1;
    entry.promptTokens += nonNegInt(readVal(row, 'promptTokens'));
    entry.completionTokens += nonNegInt(readVal(row, 'completionTokens'));
    entry.costUsd = Number((entry.costUsd + Math.max(0, Number(readVal(row, 'estimatedCostUsd')) || 0)).toFixed(6));
    entry.piiRedacted += nonNegInt(readVal(row, 'piiRedactedCount'));
    perUser.set(userKey, entry);
  }
  return [...perUser.values()];
}

function mergeQuotaAndAuditRows(quotaRows = [], auditRows = []) {
  const byUser = new Map();
  const absorb = (rows) => {
    for (const r of rows) {
      const userId = String(readVal(r, 'userId') || 'anon');
      const calls = nonNegInt(readVal(r, 'calls'));
      const promptTokens = nonNegInt(readVal(r, 'promptTokens'));
      const completionTokens = nonNegInt(readVal(r, 'completionTokens'));
      const costUsd = Math.max(0, Number(readVal(r, 'costUsd')) || 0);
      const piiRedacted = nonNegInt(readVal(r, 'piiRedacted'));
      const prev = byUser.get(userId);
      if (!prev) {
        byUser.set(userId, { userId, calls, promptTokens, completionTokens, costUsd, piiRedacted });
      } else {
        byUser.set(userId, {
          userId,
          calls: Math.max(prev.calls, calls),
          promptTokens: Math.max(prev.promptTokens, promptTokens),
          completionTokens: Math.max(prev.completionTokens, completionTokens),
          costUsd: Number(Math.max(prev.costUsd, costUsd).toFixed(6)),
          piiRedacted: Math.max(prev.piiRedacted, piiRedacted),
        });
      }
    }
  };
  absorb(quotaRows);
  absorb(auditRows);
  return [...byUser.values()];
}

async function backfillMissingQuotaRows(db, org, day, quotaRows, auditRows) {
  if (typeof db?.sequelize?.query !== 'function' || !auditRows.length) return;
  const existingUsers = new Set(quotaRows.map((r) => String(readVal(r, 'userId') || 'anon')));
  for (const row of auditRows) {
    const userId = String(readVal(row, 'userId') || 'anon');
    if (existingUsers.has(userId)) continue;
    try {
      await db.sequelize.query(
        `INSERT INTO "latticeAiQuotaUsage" ("createdAt", "updatedAt", "organizationId", "dayKey", "userId", calls, "promptTokens", "completionTokens", "costUsd", "piiRedacted")
         VALUES (NOW(), NOW(), :organizationId, :dayKey, :userId, :calls, :promptTokens, :completionTokens, :costUsd, :piiRedacted)
         ON CONFLICT ("organizationId", "dayKey", "userId") DO NOTHING;`,
        {
          replacements: {
            organizationId: org,
            dayKey: day,
            userId,
            calls: nonNegInt(readVal(row, 'calls')),
            promptTokens: nonNegInt(readVal(row, 'promptTokens')),
            completionTokens: nonNegInt(readVal(row, 'completionTokens')),
            costUsd: Math.max(0, Number(readVal(row, 'costUsd')) || 0),
            piiRedacted: nonNegInt(readVal(row, 'piiRedacted')),
          },
        },
      );
    } catch {
      // Non-fatal best-effort backfill
    }
  }
}

async function hydrateQuotaBucketFromDb(db, organizationId, now = new Date()) {
  const bucket = getOrCreateOrgBucket(organizationId, now);
  if (!db) return bucket;
  try {
    const quotaRows = await loadQuotaBucketRows(db, bucket.organizationId, bucket.day);
    if (!bucket.hydrated) {
      const auditRows = await loadSameDayAuditFallbackRows(db, bucket.organizationId, bucket.day);
      const mergedRows = mergeQuotaAndAuditRows(quotaRows, auditRows);
      if (mergedRows.length) applyAggregatedRowsToBucket(bucket, mergedRows);
      await backfillMissingQuotaRows(db, bucket.organizationId, bucket.day, quotaRows, auditRows);
      bucket.hydrated = true;
      return bucket;
    }
    if (quotaRows.length) {
      applyAggregatedRowsToBucket(bucket, quotaRows);
    }
  } catch {
    // Non-fatal in minimal mock harnesses
  }
  return bucket;
}

async function recordQuotaUsagePersistent(db, actor = {}, metrics = {}, now = new Date()) {
  const mem = recordQuotaUsage(actor, metrics, now);
  if (!db) return mem;
  const org = String(actor.organizationId || 'default').trim() || 'default';
  const day = utcDayKey(now);
  const userKey = String(actor.userId || actor.username || 'anon');
  const pTok = nonNegInt(metrics.promptTokens);
  const cTok = nonNegInt(metrics.completionTokens);
  const costUsd = Math.max(0, Number(metrics.costUsd) || 0);
  const piiRedacted = nonNegInt(metrics.piiRedactedCount ?? metrics.piiRedacted);

  if (typeof db?.sequelize?.query === 'function') {
    try {
      await db.sequelize.query(
        `INSERT INTO "latticeAiQuotaUsage" ("createdAt", "updatedAt", "organizationId", "dayKey", "userId", calls, "promptTokens", "completionTokens", "costUsd", "piiRedacted")
         VALUES (NOW(), NOW(), :organizationId, :dayKey, :userId, 1, :promptTokens, :completionTokens, :costUsd, :piiRedacted)
         ON CONFLICT ("organizationId", "dayKey", "userId")
         DO UPDATE SET
           "updatedAt" = NOW(),
           calls = "latticeAiQuotaUsage".calls + 1,
           "promptTokens" = "latticeAiQuotaUsage"."promptTokens" + EXCLUDED."promptTokens",
           "completionTokens" = "latticeAiQuotaUsage"."completionTokens" + EXCLUDED."completionTokens",
           "costUsd" = "latticeAiQuotaUsage"."costUsd" + EXCLUDED."costUsd",
           "piiRedacted" = "latticeAiQuotaUsage"."piiRedacted" + EXCLUDED."piiRedacted";`,
        {
          replacements: {
            organizationId: org,
            dayKey: day,
            userId: userKey,
            promptTokens: pTok,
            completionTokens: cTok,
            costUsd,
            piiRedacted,
          },
        },
      );
      return mem;
    } catch {
      // Fall through to repository fallback
    }
  }

  const repo = db?.getRepository?.('latticeAiQuotaUsage');
  if (repo && typeof repo.findOne === 'function') {
    try {
      const existing = await repo.findOne({ filter: { organizationId: org, dayKey: day, userId: userKey } });
      if (existing && typeof existing.update === 'function') {
        await existing.update({
          calls: (Number(readVal(existing, 'calls')) || 0) + 1,
          promptTokens: (Number(readVal(existing, 'promptTokens')) || 0) + pTok,
          completionTokens: (Number(readVal(existing, 'completionTokens')) || 0) + cTok,
          costUsd: Number(((Number(readVal(existing, 'costUsd')) || 0) + costUsd).toFixed(6)),
          piiRedacted: (Number(readVal(existing, 'piiRedacted')) || 0) + piiRedacted,
        });
      } else if (typeof repo.create === 'function') {
        await repo.create({
          values: {
            organizationId: org,
            dayKey: day,
            userId: userKey,
            calls: 1,
            promptTokens: pTok,
            completionTokens: cTok,
            costUsd: Number(costUsd.toFixed(6)),
            piiRedacted,
          },
        });
      }
    } catch {
      // Best-effort DB write; in-memory bucket already updated
    }
  }
  return mem;
}

function getQuotaSummary(organizationId, env = process.env, now = new Date()) {
  const limits = getQuotaLimits(env);
  const bucket = getOrCreateOrgBucket(organizationId, now);
  return {
    organizationId: bucket.organizationId,
    day: bucket.day,
    limits,
    usage: {
      calls: bucket.calls,
      tokens: bucket.tokens,
      promptTokens: bucket.promptTokens || 0,
      completionTokens: bucket.completionTokens || 0,
      costUsd: bucket.costUsd,
      piiRedacted: bucket.piiRedacted,
      activeUsers: bucket.byUser.size,
    },
  };
}

async function getQuotaSummaryPersistent(db, organizationId, env = process.env, now = new Date()) {
  await hydrateQuotaBucketFromDb(db, organizationId, now);
  return getQuotaSummary(organizationId, env, now);
}

function resetQuotaBuckets() {
  quotaBuckets.clear();
}

module.exports = {
  MODEL_PRICING_USD_PER_1M,
  utcDayKey,
  redactPiiText,
  redactPiiString,
  redactPiiDeep,
  estimateTokens,
  estimateCostUsd,
  getQuotaLimits,
  checkAndConsumeAiQuota,
  recordQuotaUsage,
  getQuotaSummary,
  hydrateQuotaBucketFromDb,
  recordQuotaUsagePersistent,
  getQuotaSummaryPersistent,
  resetQuotaBuckets,
};
