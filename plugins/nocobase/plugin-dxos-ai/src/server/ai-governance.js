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

const quotaBuckets = new Map();

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

function estimateCostUsd(promptTokens = 0, completionTokens = 0, _modelName = '', env = process.env) {
  const inPerMillion = Number(env?.DXOS_AI_USD_PER_1M_INPUT) || 0.35;
  const outPerMillion = Number(env?.DXOS_AI_USD_PER_1M_OUTPUT) || 1.05;
  const cost = ((Number(promptTokens) || 0) * inPerMillion + (Number(completionTokens) || 0) * outPerMillion) / 1_000_000;
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
    bucket = { organizationId: org, day, calls: 0, tokens: 0, costUsd: 0, piiRedacted: 0, byUser: new Map() };
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

function checkAndConsumeAiQuota(actor = {}, { estimatedPromptTokens = 0, env = process.env } = {}) {
  const limits = getQuotaLimits(env);
  const bucket = getOrCreateOrgBucket(actor.organizationId);
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

function recordQuotaUsage(actor = {}, { promptTokens = 0, completionTokens = 0, costUsd = 0, piiRedactedCount = 0 } = {}) {
  const bucket = getOrCreateOrgBucket(actor.organizationId);
  const userKey = String(actor.userId || actor.username || 'anon');
  const userEntry = bucket.byUser.get(userKey) || { calls: 0, tokens: 0 };
  const totalTok = (Number(promptTokens) || 0) + (Number(completionTokens) || 0);
  bucket.calls += 1;
  bucket.tokens += totalTok;
  bucket.costUsd = Number((bucket.costUsd + (Number(costUsd) || 0)).toFixed(6));
  bucket.piiRedacted += Number(piiRedactedCount) || 0;
  userEntry.calls += 1;
  userEntry.tokens += totalTok;
  bucket.byUser.set(userKey, userEntry);
  return { calls: bucket.calls, tokens: bucket.tokens, costUsd: bucket.costUsd, piiRedacted: bucket.piiRedacted };
}

function getQuotaSummary(organizationId, env = process.env) {
  const limits = getQuotaLimits(env);
  const bucket = getOrCreateOrgBucket(organizationId);
  return {
    organizationId: bucket.organizationId,
    day: bucket.day,
    limits,
    usage: {
      calls: bucket.calls,
      tokens: bucket.tokens,
      costUsd: bucket.costUsd,
      piiRedacted: bucket.piiRedacted,
      activeUsers: bucket.byUser.size,
    },
  };
}

function resetQuotaBuckets() {
  quotaBuckets.clear();
}

module.exports = {
  redactPiiText,
  redactPiiString,
  redactPiiDeep,
  estimateTokens,
  estimateCostUsd,
  getQuotaLimits,
  checkAndConsumeAiQuota,
  recordQuotaUsage,
  getQuotaSummary,
  resetQuotaBuckets,
};
