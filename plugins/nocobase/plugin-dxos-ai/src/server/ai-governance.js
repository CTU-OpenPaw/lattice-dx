/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const path = require('node:path');

const SENSITIVE_KEY_RE = /token|secret|password|apikey|api_key|authorization|cookie|credential|jwt|bearer|privatekey|private_key|sessionid|session_id|passphrase|access_key|client_secret/i;
const ORG_ID_RE = /^[a-zA-Z0-9_-]{1,80}$/;

function loadFoundationPgRls() {
  const inDist = __dirname.includes(`${path.sep}dist${path.sep}`);
  const candidates = inDist
    ? [
        '@latticedx/plugin-lattice-foundation/dist/server/pg-rls',
        '@latticedx/plugin-lattice-foundation/src/server/pg-rls',
        '../../../plugin-lattice-foundation/dist/server/pg-rls',
        '../../../plugin-lattice-foundation/src/server/pg-rls',
      ]
    : [
        '@latticedx/plugin-lattice-foundation/src/server/pg-rls',
        '../../../plugin-lattice-foundation/src/server/pg-rls',
        '@latticedx/plugin-lattice-foundation/dist/server/pg-rls',
        '../../../plugin-lattice-foundation/dist/server/pg-rls',
      ];
  for (const modPath of candidates) {
    try {
      const mod = require(modPath);
      if (mod && typeof mod.withTenantRlsContext === 'function') return mod;
    } catch (err) {
      const isDirectMissing = err?.code === 'MODULE_NOT_FOUND'
        && (!Array.isArray(err.requireStack) || err.requireStack.length === 0 || err.requireStack[0] === __filename);
      if (!isDirectMissing) throw err;
    }
  }
  return null;
}

async function runInOptionalTenantRls(db, orgId, fn) {
  const pgRls = loadFoundationPgRls();
  if (
    pgRls
    && typeof pgRls.canUsePgRlsSession === 'function'
    && pgRls.canUsePgRlsSession(db)
    && !pgRls.getActiveRlsContext?.()?.transaction
    && ORG_ID_RE.test(String(orgId || ''))
    && typeof pgRls.withTenantRlsContext === 'function'
  ) {
    return pgRls.withTenantRlsContext(db, String(orgId), fn);
  }
  return fn(null);
}
const SECRET_KV_RE = /((?:\\?["'])?(?:[a-zA-Z0-9_]*(?:secret|password|apikey|api_key|jwt|private_?key|client_secret|access_key|passphrase|credential|authorization|cookie)[a-zA-Z0-9_]*|[a-zA-Z0-9_]*(?:token|session_?id))(?:\\?["'])?\s*[:=]\s*)(?!\\?["']?\[REDACTED(?:_[A-Z]+)?\])(\\"(?:[^"\\]|\\[^"])+\\"|"(?:[^"\\]|\\.)+"|'(?:[^'\\]|\\.)+'|[^\s,;}"'&]+)/gi;

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
const quotaPolicyOverrides = new Map();
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

function replaceSecretKvPairs(rawText) {
  let hits = 0;
  const text = String(rawText ?? '').replace(SECRET_KV_RE, (_full, prefix, valPart) => {
    hits += 1;
    if (valPart.startsWith('\\"')) return `${prefix}\\"[REDACTED]\\"`;
    if (valPart.startsWith('"')) return `${prefix}"[REDACTED]"`;
    if (valPart.startsWith("'")) return `${prefix}'[REDACTED]'`;
    return `${prefix}[REDACTED]`;
  });
  return { text, hits };
}

function redactPiiText(rawText) {
  let text = String(rawText ?? '');
  if (!text) return { text, count: 0 };
  let count = 0;
  const rules = [
    [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\b/g, '[REDACTED_JWT]'],
    [/(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, '$1[REDACTED]'],
    [/\bsk-[A-Za-z0-9_-]{6,}\b/g, '[REDACTED_KEY]'],
    [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED_EMAIL]'],
    [/(\b(?:stk|số tài khoản|tài khoản ngân hàng|iban)\s*[:#=-]?\s*)(?:[A-Z]{2}\d{2}(?:[A-Z0-9]{6,30}|(?:[ -][A-Z0-9]{2,4}){0,7}[ -](?=[A-Z0-9]*\d)[A-Z0-9]{1,4})|\d[\d -]{6,22}\d)(?![0-9A-Za-z-])/gi, '$1[REDACTED_BANK]'],
    [/(\b(?:cccd|cmnd|căn cước(?:\s+công dân)?)\s*[:#=-]?\s*)\d{9,12}\b/gi, '$1[REDACTED_CCCD]'],
    [/(?<![0-9A-Za-z-])0\d{11}(?![0-9A-Za-z-])/g, '[REDACTED_CCCD]'],
    [/(?<![0-9A-Za-z-])(?:\+?84[\s.-]?|0)(?:3|5|7|8|9)(?:[\s.-]?\d){8}(?![0-9A-Za-z-])/g, '[REDACTED_PHONE]'],
    [/(\b(?:mst|mã số thuế)\s*[:#=-]?\s*)\d{10}(?:-\d{3})?\b/gi, '$1[REDACTED_MST]'],
  ];
  for (let i = 0; i < rules.length; i += 1) {
    if (i === 3) {
      const kv = replaceSecretKvPairs(text);
      text = kv.text;
      count += kv.hits;
    }
    const [regex, replacement] = rules[i];
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

function redactPiiForLlm(input) {
  let redactedCount = 0;
  function walk(node, depth = 0) {
    if (depth > 16) return '[TRUNCATED]';
    if (node == null || typeof node === 'number' || typeof node === 'boolean') return node;
    if (typeof node === 'string') {
      const res = redactPiiText(node);
      redactedCount += Number(res?.count) || 0;
      return res?.text ?? node;
    }
    if (Array.isArray(node)) return node.map((item) => walk(item, depth + 1));
    if (typeof node === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
        if (SENSITIVE_KEY_RE.test(k)) {
          out[k] = '[REDACTED]';
          redactedCount += 1;
        } else {
          out[k] = walk(v, depth + 1);
        }
      }
      return out;
    }
    return String(node);
  }
  return { redacted: walk(input, 0), redactedCount };
}

function estimateTokens(input) {
  const str = typeof input === 'string' ? input : JSON.stringify(input ?? '');
  if (!str) return 1;
  return Math.max(1, Math.ceil(str.length / 3.2));
}

function normalizeTokenUsage(metrics = {}, fallbackPrompt = 0, fallbackCompletion = 0) {
  const rawUsage = metrics?.usage && typeof metrics.usage === 'object' ? metrics.usage : null;
  const rawPrompt = rawUsage?.promptTokens ?? rawUsage?.prompt_tokens ?? rawUsage?.input_tokens;
  const rawCompletion = rawUsage?.completionTokens ?? rawUsage?.completion_tokens ?? rawUsage?.output_tokens;
  const rawTotal = rawUsage?.totalTokens ?? rawUsage?.total_tokens;
  const hasProviderFields = Boolean(
    rawUsage
    && (
      Number.isFinite(Number(rawPrompt))
      || Number.isFinite(Number(rawCompletion))
      || Number.isFinite(Number(rawTotal))
    ),
  );
  const explicitSource = String(metrics?.tokenSource || rawUsage?.tokenSource || '').trim().toLowerCase();
  const tokenSource = explicitSource === 'provider' || explicitSource === 'estimated'
    ? explicitSource
    : (hasProviderFields ? 'provider' : 'estimated');

  const pSrc = hasProviderFields ? (rawPrompt ?? 0) : (metrics?.promptTokens ?? fallbackPrompt);
  const cSrc = hasProviderFields ? (rawCompletion ?? 0) : (metrics?.completionTokens ?? fallbackCompletion);
  const promptTokens = nonNegInt(pSrc);
  const completionTokens = nonNegInt(cSrc);
  const tSrc = hasProviderFields ? rawTotal : metrics?.totalTokens;
  const totalTokens = tSrc != null && Number.isFinite(Number(tSrc))
    ? Math.max(promptTokens + completionTokens, nonNegInt(tSrc))
    : (promptTokens + completionTokens);
  return { promptTokens, completionTokens, totalTokens, tokenSource };
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

function getQuotaLimits(env = process.env, overrideLimits = null) {
  const num = (key, def) => {
    const parsed = Number(env?.[key]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : def;
  };
  const base = {
    orgDailyCalls: num('DXOS_AI_DAILY_ORG_CALL_LIMIT', 5000),
    userDailyCalls: num('DXOS_AI_DAILY_USER_CALL_LIMIT', 500),
    orgDailyTokens: num('DXOS_AI_DAILY_ORG_TOKEN_LIMIT', 5_000_000),
    orgDailyUsd: num('DXOS_AI_DAILY_ORG_USD_LIMIT', 50),
  };
  if (overrideLimits && typeof overrideLimits === 'object') {
    for (const k of ['orgDailyCalls', 'userDailyCalls', 'orgDailyTokens', 'orgDailyUsd']) {
      const v = Number(overrideLimits[k]);
      if (Number.isFinite(v) && v > 0) {
        base[k] = k === 'orgDailyUsd' ? Number(v.toFixed(4)) : Math.trunc(v);
      }
    }
  }
  return base;
}

function validateQuotaLimitsInput(input = {}) {
  const fields = [
    ['orgDailyCalls', true, 'Hạn mức lượt gọi tổ chức/ngày'],
    ['userDailyCalls', true, 'Hạn mức lượt gọi user/ngày'],
    ['orgDailyTokens', true, 'Hạn mức token tổ chức/ngày'],
    ['orgDailyUsd', false, 'Trần chi phí USD/ngày'],
  ];
  const out = {};
  for (const [key, isInt, label] of fields) {
    const raw = input?.[key];
    if (raw === undefined || raw === null || raw === '') continue;
    const valNum = Number(raw);
    if (!Number.isFinite(valNum) || valNum <= 0) {
      throw Object.assign(new Error(`${label} (${key}) phải là số dương hợp lệ.`), { status: 400, code: 'AI_QUOTA_LIMIT_INVALID' });
    }
    out[key] = isInt ? Math.max(1, Math.trunc(valNum)) : Number(valNum.toFixed(4));
  }
  if (!Object.keys(out).length) {
    throw Object.assign(new Error('Cần cung cấp ít nhất một thông số hạn mức hợp lệ.'), { status: 400, code: 'AI_QUOTA_LIMIT_INVALID' });
  }
  return out;
}

async function getQuotaLimitsForOrg(db, organizationId, env = process.env) {
  const org = String(organizationId || 'default').trim() || 'default';
  const memOverride = quotaPolicyOverrides.get(org) || null;
  if (!db) return getQuotaLimits(env, memOverride);
  try {
    let row = null;
    await runInOptionalTenantRls(db, org, async (transaction) => {
      const txOpt = transaction ? { transaction } : {};
      const repo = db?.getRepository?.('latticeAiQuotaPolicies');
      if (repo && typeof repo.findOne === 'function') {
        row = await repo.findOne({ filter: { organizationId: org }, ...txOpt }).catch(() => null);
      }
      if (!row && typeof db?.sequelize?.query === 'function') {
        const [rows] = await db.sequelize.query(
          'SELECT "orgDailyCalls", "userDailyCalls", "orgDailyTokens", "orgDailyUsd" FROM "latticeAiQuotaPolicies" WHERE "organizationId" = :organizationId LIMIT 1;',
          { replacements: { organizationId: org }, ...txOpt },
        ).catch(() => [[]]);
        row = Array.isArray(rows) ? rows[0] : null;
      }
    });
    if (row) {
      const dbLimits = {
        orgDailyCalls: Number(readVal(row, 'orgDailyCalls')),
        userDailyCalls: Number(readVal(row, 'userDailyCalls')),
        orgDailyTokens: Number(readVal(row, 'orgDailyTokens')),
        orgDailyUsd: Number(readVal(row, 'orgDailyUsd')),
      };
      quotaPolicyOverrides.set(org, dbLimits);
      return getQuotaLimits(env, dbLimits);
    }
  } catch {
    // Non-fatal in minimal mock harnesses
  }
  return getQuotaLimits(env, memOverride);
}

async function saveQuotaPolicy(db, organizationId, rawInput = {}, actor = {}, env = process.env) {
  const org = String(organizationId || '').trim();
  if (!org || !ORG_ID_RE.test(org) || org.toLowerCase() === 'all') {
    throw Object.assign(new Error('Mã tổ chức (organizationId) không hợp lệ.'), { status: 400, code: 'AI_ORG_INVALID' });
  }
  const patch = validateQuotaLimitsInput(rawInput);
  const current = await getQuotaLimitsForOrg(db, org, env);
  const nextLimits = getQuotaLimits(env, { ...current, ...patch });
  const updatedByUsername = String(actor?.username || '').slice(0, 120) || null;

  if (db) {
    try {
      await runInOptionalTenantRls(db, org, async (transaction) => {
        const txOpt = transaction ? { transaction } : {};
        const repo = db?.getRepository?.('latticeAiQuotaPolicies');
        if (repo && typeof repo.findOne === 'function') {
          const existing = await repo.findOne({ filter: { organizationId: org }, ...txOpt });
          if (existing && typeof existing.update === 'function') {
            await existing.update({ ...nextLimits, updatedByUsername }, txOpt);
            return;
          }
          if (typeof repo.create === 'function') {
            await repo.create({ values: { organizationId: org, ...nextLimits, updatedByUsername }, ...txOpt });
            return;
          }
        }
        if (typeof db?.sequelize?.query === 'function') {
          await db.sequelize.query(
            `INSERT INTO "latticeAiQuotaPolicies" ("createdAt", "updatedAt", "organizationId", "orgDailyCalls", "userDailyCalls", "orgDailyTokens", "orgDailyUsd", "updatedByUsername")
             VALUES (NOW(), NOW(), :organizationId, :orgDailyCalls, :userDailyCalls, :orgDailyTokens, :orgDailyUsd, :updatedByUsername)
             ON CONFLICT ("organizationId")
             DO UPDATE SET
               "updatedAt" = NOW(),
               "orgDailyCalls" = EXCLUDED."orgDailyCalls",
               "userDailyCalls" = EXCLUDED."userDailyCalls",
               "orgDailyTokens" = EXCLUDED."orgDailyTokens",
               "orgDailyUsd" = EXCLUDED."orgDailyUsd",
               "updatedByUsername" = EXCLUDED."updatedByUsername";`,
            { replacements: { organizationId: org, ...nextLimits, updatedByUsername }, ...txOpt },
          );
        }
      });
    } catch (err) {
      if (err?.code === 'DXOS_QUOTA_POLICY_PERSIST_FAILED') throw err;
      const pgCode = err?.parent?.code || err?.original?.code || err?.code;
      const isUnavailable = pgCode === 'ECONNREFUSED' || pgCode === '57P01' || pgCode === '57P03' || pgCode === '42P01';
      throw Object.assign(
        new Error(`Không thể lưu chính sách hạn mức AI vào cơ sở dữ liệu: ${err?.message || 'DB error'}`),
        { status: err?.status || (isUnavailable ? 503 : 500), code: 'DXOS_QUOTA_POLICY_PERSIST_FAILED', cause: err },
      );
    }
  }

  quotaPolicyOverrides.set(org, nextLimits);
  return { organizationId: org, limits: nextLimits, updatedByUsername };
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
      providerTokens: 0,
      estimatedTokens: 0,
      providerCalls: 0,
      estimatedCalls: 0,
      lastTokenSource: 'estimated',
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
  const bucket = getOrCreateOrgBucket(actor.organizationId, now);
  const limits = getQuotaLimits(env, quotaPolicyOverrides.get(bucket.organizationId) || null);
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

function recordQuotaUsage(actor = {}, metrics = {}, now = new Date()) {
  const bucket = getOrCreateOrgBucket(actor.organizationId, now);
  const userKey = String(actor.userId || actor.username || 'anon');
  const userEntry = bucket.byUser.get(userKey) || {
    calls: 0, tokens: 0, promptTokens: 0, completionTokens: 0,
    providerTokens: 0, estimatedTokens: 0, providerCalls: 0, estimatedCalls: 0,
    costUsd: 0, piiRedacted: 0,
  };
  const { promptTokens: pTok, completionTokens: cTok, totalTokens: totalTok, tokenSource } = normalizeTokenUsage(metrics);
  const deltaCost = Math.max(0, Number(metrics?.costUsd) || 0);
  const deltaPii = nonNegInt(metrics?.piiRedactedCount ?? metrics?.piiRedacted);
  bucket.calls += 1;
  bucket.promptTokens = (bucket.promptTokens || 0) + pTok;
  bucket.completionTokens = (bucket.completionTokens || 0) + cTok;
  bucket.tokens += totalTok;
  if (tokenSource === 'provider') {
    bucket.providerTokens = (bucket.providerTokens || 0) + totalTok;
    bucket.providerCalls = (bucket.providerCalls || 0) + 1;
  } else {
    bucket.estimatedTokens = (bucket.estimatedTokens || 0) + totalTok;
    bucket.estimatedCalls = (bucket.estimatedCalls || 0) + 1;
  }
  bucket.lastTokenSource = tokenSource;
  bucket.costUsd = Number((bucket.costUsd + deltaCost).toFixed(6));
  bucket.piiRedacted += deltaPii;
  userEntry.calls += 1;
  userEntry.promptTokens = (userEntry.promptTokens || 0) + pTok;
  userEntry.completionTokens = (userEntry.completionTokens || 0) + cTok;
  userEntry.tokens += totalTok;
  if (tokenSource === 'provider') {
    userEntry.providerTokens = (userEntry.providerTokens || 0) + totalTok;
    userEntry.providerCalls = (userEntry.providerCalls || 0) + 1;
  } else {
    userEntry.estimatedTokens = (userEntry.estimatedTokens || 0) + totalTok;
    userEntry.estimatedCalls = (userEntry.estimatedCalls || 0) + 1;
  }
  userEntry.costUsd = Number(((userEntry.costUsd || 0) + deltaCost).toFixed(6));
  userEntry.piiRedacted = (userEntry.piiRedacted || 0) + deltaPii;
  bucket.byUser.set(userKey, userEntry);
  return {
    calls: bucket.calls,
    tokens: bucket.tokens,
    totalTokens: bucket.tokens,
    promptTokens: bucket.promptTokens,
    completionTokens: bucket.completionTokens,
    tokenSource,
    providerTokens: bucket.providerTokens || 0,
    estimatedTokens: bucket.estimatedTokens || 0,
    providerCalls: bucket.providerCalls || 0,
    estimatedCalls: bucket.estimatedCalls || 0,
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

async function loadQuotaBucketRows(db, org, day, transaction = null) {
  const txOpt = transaction ? { transaction } : {};
  const quotaRepo = db?.getRepository?.('latticeAiQuotaUsage');
  if (quotaRepo && typeof quotaRepo.find === 'function') {
    const rows = await quotaRepo.find({ filter: { organizationId: org, dayKey: day }, limit: 1000, ...txOpt });
    if (Array.isArray(rows) && rows.length) return rows;
  }
  if (typeof db?.sequelize?.query === 'function') {
    try {
      const [sqlRows] = await db.sequelize.query(
        'SELECT "userId", calls, "promptTokens", "completionTokens", "costUsd", "piiRedacted" FROM "latticeAiQuotaUsage" WHERE "organizationId" = :organizationId AND "dayKey" = :dayKey;',
        { replacements: { organizationId: org, dayKey: day }, ...txOpt },
      );
      if (Array.isArray(sqlRows) && sqlRows.length) return sqlRows;
    } catch {
      // Fall back to audit log aggregation if quota table is unavailable
    }
  }
  return [];
}

async function loadSameDayAuditFallbackRows(db, org, day, transaction = null) {
  const txOpt = transaction ? { transaction } : {};
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
           AND COALESCE(channel, '') NOT IN ('studio-sync', 'hitl-approval')
           AND ("actorUserId" IS NOT NULL OR "actorUsername" IS NOT NULL)
           AND "createdAt" >= :dayStart
           AND "createdAt" < :dayEnd
         GROUP BY 1;`,
        { replacements: { organizationId: org, dayStart, dayEnd }, ...txOpt },
      );
      if (Array.isArray(sqlRows) && sqlRows.length) return sqlRows;
    } catch {
      // Fallback to repository query in mock or non-PG adapters
    }
  }
  const auditRepo = db?.getRepository?.('latticeAiAuditLogs');
  if (!auditRepo || typeof auditRepo.find !== 'function') return [];
  const logs = (await auditRepo.find({ filter: { organizationId: org }, sort: ['-id'], limit: 2000, ...txOpt })) || [];
  const perUser = new Map();
  for (const row of logs) {
    const status = String(readVal(row, 'status') || '').toLowerCase();
    if (status !== 'allowed' && status !== 'degraded') continue;
    const channel = String(readVal(row, 'channel') || '').toLowerCase();
    if (channel === 'studio-sync' || channel === 'hitl-approval') continue;
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

async function backfillMissingQuotaRows(db, org, day, quotaRows, auditRows, transaction = null) {
  if (typeof db?.sequelize?.query !== 'function' || !auditRows.length) return;
  const txOpt = transaction ? { transaction } : {};
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
          ...txOpt,
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
    await runInOptionalTenantRls(db, bucket.organizationId, async (transaction) => {
      const quotaRows = await loadQuotaBucketRows(db, bucket.organizationId, bucket.day, transaction);
      if (!bucket.hydrated) {
        const auditRows = await loadSameDayAuditFallbackRows(db, bucket.organizationId, bucket.day, transaction);
        const mergedRows = mergeQuotaAndAuditRows(quotaRows, auditRows);
        if (mergedRows.length) applyAggregatedRowsToBucket(bucket, mergedRows);
        await backfillMissingQuotaRows(db, bucket.organizationId, bucket.day, quotaRows, auditRows, transaction);
        bucket.hydrated = true;
        return;
      }
      if (quotaRows.length) {
        applyAggregatedRowsToBucket(bucket, quotaRows);
      }
    });
  } catch {
    // Non-fatal in minimal mock harnesses
  }
  await getQuotaLimitsForOrg(db, bucket.organizationId);
  return bucket;
}

async function recordQuotaUsagePersistent(db, actor = {}, metrics = {}, now = new Date()) {
  if (!db) return recordQuotaUsage(actor, metrics, now);
  const org = String(actor.organizationId || 'default').trim() || 'default';
  const day = utcDayKey(now);
  const userKey = String(actor.userId || actor.username || 'anon');
  const { promptTokens: pTok, completionTokens: cTok } = normalizeTokenUsage(metrics);
  const costUsd = Math.max(0, Number(metrics.costUsd) || 0);
  const piiRedacted = nonNegInt(metrics.piiRedactedCount ?? metrics.piiRedacted);
  const hasSequelizeQuery = typeof db?.sequelize?.query === 'function';
  const quotaTableKnownAbsent = typeof db?.hasCollection === 'function' && !db.hasCollection('latticeAiQuotaUsage');

  await runInOptionalTenantRls(db, org, async (transaction) => {
    const txOpt = transaction ? { transaction } : {};
    let missingQuotaTable = quotaTableKnownAbsent;
    if (hasSequelizeQuery && !quotaTableKnownAbsent) {
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
            ...txOpt,
          },
        );
        return;
      } catch (err) {
        const pgCode = err?.parent?.code || err?.original?.code || err?.code;
        if (pgCode === '42P01') {
          missingQuotaTable = true;
        } else {
          throw Object.assign(
            new Error(`Không thể ghi nhận mức sử dụng hạn mức AI: ${err?.message || 'DB error'}`),
            { status: err?.status || (pgCode === 'ECONNREFUSED' ? 503 : 500), code: 'DXOS_QUOTA_USAGE_PERSIST_FAILED', cause: err },
          );
        }
      }
    }

    if (!hasSequelizeQuery || missingQuotaTable) {
      const repo = db?.getRepository?.('latticeAiQuotaUsage');
      if (repo && typeof repo.findOne === 'function') {
        try {
          const existing = await repo.findOne({ filter: { organizationId: org, dayKey: day, userId: userKey }, ...txOpt });
          if (existing && typeof existing.update === 'function') {
            await existing.update({
              calls: (Number(readVal(existing, 'calls')) || 0) + 1,
              promptTokens: (Number(readVal(existing, 'promptTokens')) || 0) + pTok,
              completionTokens: (Number(readVal(existing, 'completionTokens')) || 0) + cTok,
              costUsd: Number(((Number(readVal(existing, 'costUsd')) || 0) + costUsd).toFixed(6)),
              piiRedacted: (Number(readVal(existing, 'piiRedacted')) || 0) + piiRedacted,
            }, txOpt);
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
              ...txOpt,
            });
          }
        } catch (err) {
          const pgCode = err?.parent?.code || err?.original?.code || err?.code;
          if (pgCode !== '42P01') {
            throw Object.assign(
              new Error(`Không thể ghi nhận mức sử dụng hạn mức AI: ${err?.message || 'DB error'}`),
              { status: err?.status || 500, code: 'DXOS_QUOTA_USAGE_PERSIST_FAILED', cause: err },
            );
          }
        }
      }
    }
  });
  return recordQuotaUsage(actor, metrics, now);
}

async function checkAndConsumeAiQuotaPersistent(db, actor = {}, { estimatedPromptTokens = 0, env = process.env, now = new Date(), consume = false } = {}) {
  const org = String(actor?.organizationId || 'default').trim() || 'default';
  const day = utcDayKey(now);
  const userKey = String(actor?.userId || actor?.username || 'anon');
  const hasPgSql = typeof db?.sequelize?.query === 'function' && db?.sequelize?.getDialect?.() === 'postgres';
  const quotaTableKnownAbsent = typeof db?.hasCollection === 'function' && !db.hasCollection('latticeAiQuotaUsage');

  if (db && hasPgSql && !quotaTableKnownAbsent) {
    let fallbackNeeded = false;
    let checkRes = null;
    await runInOptionalTenantRls(db, org, async (transaction) => {
      const txOpt = transaction ? { transaction } : {};
      try {
        const [usageRows] = await db.sequelize.query(
          'SELECT "userId", calls, "promptTokens", "completionTokens", "costUsd", "piiRedacted" FROM "latticeAiQuotaUsage" WHERE "organizationId" = :organizationId AND "dayKey" = :dayKey FOR UPDATE;',
          { replacements: { organizationId: org, dayKey: day }, ...txOpt },
        );
        const bucket = getOrCreateOrgBucket(org, now);
        if (Array.isArray(usageRows) && usageRows.length) {
          applyAggregatedRowsToBucket(bucket, usageRows);
          bucket.hydrated = true;
        }
        await getQuotaLimitsForOrg(db, org, env);
        checkRes = checkAndConsumeAiQuota(actor, { estimatedPromptTokens, env, now });
        if (consume) {
          await db.sequelize.query(
            `INSERT INTO "latticeAiQuotaUsage" ("createdAt", "updatedAt", "organizationId", "dayKey", "userId", calls, "promptTokens", "completionTokens", "costUsd", "piiRedacted")
             VALUES (NOW(), NOW(), :organizationId, :dayKey, :userId, 1, 0, 0, 0, 0)
             ON CONFLICT ("organizationId", "dayKey", "userId")
             DO UPDATE SET "updatedAt" = NOW(), calls = "latticeAiQuotaUsage".calls + 1;`,
            { replacements: { organizationId: org, dayKey: day, userId: userKey }, ...txOpt },
          );
          recordQuotaUsage(actor, { promptTokens: 0, completionTokens: 0 }, now);
        }
      } catch (err) {
        const pgCode = err?.parent?.code || err?.original?.code || err?.code;
        if (pgCode === '42P01') {
          fallbackNeeded = true;
        } else {
          throw err;
        }
      }
    });
    if (!fallbackNeeded) return checkRes;
  }

  await hydrateQuotaBucketFromDb(db, org, now);
  const res = checkAndConsumeAiQuota(actor, { estimatedPromptTokens, env, now });
  if (consume) {
    await recordQuotaUsagePersistent(db, actor, { promptTokens: 0, completionTokens: 0 }, now);
  }
  return res;
}

function getQuotaSummary(organizationId, env = process.env, now = new Date(), overrideLimits = null) {
  const bucket = getOrCreateOrgBucket(organizationId, now);
  const limits = getQuotaLimits(env, overrideLimits || quotaPolicyOverrides.get(bucket.organizationId) || null);
  return {
    organizationId: bucket.organizationId,
    day: bucket.day,
    limits,
    usage: {
      calls: bucket.calls,
      tokens: bucket.tokens,
      totalTokens: bucket.tokens,
      promptTokens: bucket.promptTokens || 0,
      completionTokens: bucket.completionTokens || 0,
      providerTokens: bucket.providerTokens || 0,
      estimatedTokens: bucket.estimatedTokens || 0,
      providerCalls: bucket.providerCalls || 0,
      estimatedCalls: bucket.estimatedCalls || 0,
      tokenSource: (bucket.providerCalls || 0) > 0 ? 'provider' : 'estimated',
      costUsd: bucket.costUsd,
      piiRedacted: bucket.piiRedacted,
      activeUsers: bucket.byUser.size,
    },
  };
}

async function getQuotaSummaryPersistent(db, organizationId, env = process.env, now = new Date()) {
  await hydrateQuotaBucketFromDb(db, organizationId, now);
  const limits = await getQuotaLimitsForOrg(db, organizationId, env);
  return getQuotaSummary(organizationId, env, now, limits);
}

function resetQuotaBuckets() {
  quotaBuckets.clear();
  quotaPolicyOverrides.clear();
}

module.exports = {
  MODEL_PRICING_USD_PER_1M,
  utcDayKey,
  replaceSecretKvPairs,
  redactPiiText,
  redactPiiString,
  redactPiiDeep,
  redactPiiForLlm,
  estimateTokens,
  normalizeTokenUsage,
  estimateCostUsd,
  getQuotaLimits,
  getQuotaLimitsForOrg,
  saveQuotaPolicy,
  checkAndConsumeAiQuota,
  checkAndConsumeAiQuotaPersistent,
  recordQuotaUsage,
  getQuotaSummary,
  hydrateQuotaBucketFromDb,
  recordQuotaUsagePersistent,
  getQuotaSummaryPersistent,
  resetQuotaBuckets,
};
