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
const {
  ORG_ID_RE,
  assertValidOrganizationId,
  canUsePgRlsSession,
  getActiveRlsContext,
  withTenantRlsContext,
  runInRlsSavepoint,
} = require('./pg-rls');

const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;
const TRACE_ID_RE = /^[0-9a-f]{32}$/i;
const SPAN_ID_RE = /^[0-9a-f]{16}$/i;
const ZERO_TRACE_ID = '0'.repeat(32);
const ZERO_SPAN_ID = '0'.repeat(16);
const DEFAULT_MAX_QUEUE_SIZE = 256;
const DEFAULT_BATCH_SIZE = 64;
const DEFAULT_EXPORT_TIMEOUT_MS = 2000;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const SENSITIVE_KEY_RE = /(authorization|api[-_]?key|apikey|secret|token|password|passwd|credential|cookie|signature|private[-_]?key|privatekey|session|jwt|bearer|passphrase|access_key|client_secret)/i;
const SAFE_TOKEN_COUNT_KEY_RE = /^(?:gen_ai\.usage\.(?:input|output|total)_tokens|input[_-]?tokens?|output[_-]?tokens?|prompt[_-]?tokens?|completion[_-]?tokens?|total[_-]?tokens?|max[_-]?tokens?|token[_-]?(?:count|source))$/i;
const SECRET_KV_RE = /((?:\\?["'])?([a-zA-Z0-9_]*(?:secret|password|apikey|api_key|jwt|private_?key|client_secret|access_key|passphrase|credential|authorization|cookie)[a-zA-Z0-9_]*|[a-zA-Z0-9_]*(?:token|session_?id))(?:\\?["'])?\s*[:=]\s*)(?!\\?["']?(?:Bearer\s+)?\[REDACTED(?:_[A-Z]+)?\])(\\"(?:[^"\\]|\\[^"])+\\"|"(?:[^"\\]|\\.)+"|'(?:[^'\\]|\\.)+'|[^\s,;}"'&]+)/gi;
const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const VALID_TRACE_STATUSES = new Set(['ok', 'error', 'suspended']);

function randomHex(byteCount) {
  return randomBytes(byteCount).toString('hex');
}

function nonNegInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

function isSensitiveKey(key) {
  if (typeof key !== 'string' || !key) return false;
  if (SAFE_TOKEN_COUNT_KEY_RE.test(key)) return false;
  return SENSITIVE_KEY_RE.test(key);
}

function replaceCounted(text, regex, replacement) {
  let hits = 0;
  const next = text.replace(regex, (...args) => {
    hits += 1;
    if (typeof replacement === 'function') return replacement(...args);
    const full = args[0];
    if (typeof replacement === 'string' && replacement.includes('$1') && args.length >= 2) {
      return replacement.replace('$1', String(args[1] ?? ''));
    }
    return replacement || full;
  });
  return { text: next, hits };
}

function replaceSecretKvPairs(rawText) {
  let hits = 0;
  const text = String(rawText ?? '').replace(SECRET_KV_RE, (full, prefix, keyName, valPart) => {
    if (SAFE_TOKEN_COUNT_KEY_RE.test(String(keyName || ''))) {
      return full;
    }
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
    [/\bldx_pat_[A-Za-z0-9_-]{6,}\b/g, '[REDACTED_KEY]'],
    [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED_EMAIL]'],
    [/(\b(?:cccd|cmnd|căn cước(?:\s+công dân)?)\s*[:#=-]?\s*)\d{9,12}\b/gi, '$1[REDACTED_CCCD]'],
    [/(?<![0-9A-Za-z_-])0\d{11}(?![0-9A-Za-z_-])/g, '[REDACTED_CCCD]'],
    [/(?<![0-9A-Za-z_-])(?:\+?84[\s.-]?|0)(?:3|5|7|8|9)(?:[\s.-]?\d){8}(?![0-9A-Za-z_-])/g, '[REDACTED_PHONE]'],
    [/(\b(?:stk|số tài khoản|tài khoản ngân hàng|iban)\s*[:#=-]?\s*)[A-Z0-9 -]{8,24}(?=\s*[,;.\n]|$)/gi, '$1[REDACTED_BANK]'],
    [/(\b(?:mst|mã số thuế)\s*[:#=-]?\s*)\d{10}(?:-\d{3})?\b/gi, '$1[REDACTED_MST]'],
  ];
  for (let i = 0; i < rules.length; i += 1) {
    if (i === 4) {
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

function redactPiiDeep(value, depthOrOptions = 0, internalSeen = null) {
  const opts = typeof depthOrOptions === 'object' && depthOrOptions !== null
    ? {
        depth: Number(depthOrOptions.depth || 0),
        maxDepth: Number.isInteger(depthOrOptions.maxDepth) ? depthOrOptions.maxDepth : 8,
        maxArray: Number.isInteger(depthOrOptions.maxArray) ? depthOrOptions.maxArray : 50,
        maxStringLen: Number.isInteger(depthOrOptions.maxStringLen) ? depthOrOptions.maxStringLen : 4096,
      }
    : {
        depth: Number(depthOrOptions || 0),
        maxDepth: 8,
        maxArray: 50,
        maxStringLen: 4096,
      };
  const seen = internalSeen || new WeakSet();

  if (opts.depth > opts.maxDepth) return { value: '[TRUNCATED]', count: 0 };
  if (value == null || typeof value === 'boolean') return { value, count: 0 };
  if (typeof value === 'number') return { value: Number.isFinite(value) ? value : String(value), count: 0 };
  if (typeof value === 'string') {
    const scrubbed = redactPiiText(value);
    const truncated = scrubbed.text.length > opts.maxStringLen
      ? `${scrubbed.text.slice(0, opts.maxStringLen)}...`
      : scrubbed.text;
    return { value: truncated, count: scrubbed.count };
  }
  if (value instanceof Date) {
    return { value: Number.isNaN(value.getTime()) ? null : value.toISOString(), count: 0 };
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return { value: '[CIRCULAR]', count: 0 };
    seen.add(value);
    if (Array.isArray(value)) {
      let count = 0;
      const out = value.slice(0, opts.maxArray).map((item) => {
        const res = redactPiiDeep(item, { ...opts, depth: opts.depth + 1 }, seen);
        count += res.count;
        return res.value;
      });
      return { value: out, count };
    }
    let count = 0;
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (!key || BLOCKED_KEYS.has(key) || val === undefined) continue;
      if (isSensitiveKey(key)) {
        out[key] = '[REDACTED]';
        if (val !== '[REDACTED]') count += 1;
      } else {
        const res = redactPiiDeep(val, { ...opts, depth: opts.depth + 1 }, seen);
        out[key] = res.value;
        count += res.count;
      }
    }
    return { value: out, count };
  }
  const scrubbed = redactPiiText(String(value));
  return { value: scrubbed.text.slice(0, 512), count: scrubbed.count };
}

function normalizeEndpoint(endpoint) {
  if (typeof endpoint !== 'string') return '';
  const trimmed = endpoint.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  } catch {
    return '';
  }
  return trimmed.endsWith('/v1/traces') ? trimmed : `${trimmed}/v1/traces`;
}

function parseTraceparent(header) {
  if (typeof header !== 'string') return null;
  const trimmed = header.trim();
  if (!trimmed) return null;
  const match = trimmed.match(TRACEPARENT_RE);
  if (!match) return null;
  const version = match[1].toLowerCase();
  const traceId = match[2].toLowerCase();
  const spanId = match[3].toLowerCase();
  const traceFlags = match[4].toLowerCase();
  if (version === 'ff' || traceId === ZERO_TRACE_ID || spanId === ZERO_SPAN_ID) {
    return null;
  }
  return {
    version,
    traceId,
    spanId,
    parentSpanId: spanId,
    traceFlags,
    sampled: (Number.parseInt(traceFlags, 16) & 1) === 1,
  };
}

function formatTraceparent(traceId, spanId, traceFlags = '01') {
  const validTraceId =
    typeof traceId === 'string' && TRACE_ID_RE.test(traceId) && traceId.toLowerCase() !== ZERO_TRACE_ID
      ? traceId.toLowerCase()
      : randomHex(16);
  const validSpanId =
    typeof spanId === 'string' && SPAN_ID_RE.test(spanId) && spanId.toLowerCase() !== ZERO_SPAN_ID
      ? spanId.toLowerCase()
      : randomHex(8);
  const validFlags =
    typeof traceFlags === 'string' && /^[0-9a-f]{2}$/i.test(traceFlags)
      ? traceFlags.toLowerCase()
      : '01';
  return `00-${validTraceId}-${validSpanId}-${validFlags}`;
}

function redactAttributesWithCount(attributes) {
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) {
    return { attributes: {}, redactedCount: 0 };
  }
  const safe = {};
  let redactedCount = 0;
  for (const [key, rawValue] of Object.entries(attributes)) {
    if (!key || BLOCKED_KEYS.has(key) || rawValue === undefined || rawValue === null) continue;
    if (isSensitiveKey(key)) {
      safe[key] = '[REDACTED]';
      if (rawValue !== '[REDACTED]') {
        redactedCount += 1;
      }
      continue;
    }
    if (typeof rawValue === 'string') {
      const scrubbed = redactPiiText(rawValue);
      safe[key] = scrubbed.text.length > 2048 ? scrubbed.text.slice(0, 2048) : scrubbed.text;
      redactedCount += scrubbed.count;
    } else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
      safe[key] = rawValue;
    } else if (typeof rawValue === 'boolean') {
      safe[key] = rawValue;
    } else if (typeof rawValue === 'object') {
      const deep = redactPiiDeep(rawValue, { maxDepth: 8, maxArray: 50, maxStringLen: 2048 });
      redactedCount += deep.count;
      let serialized = '[UNSERIALIZABLE]';
      try {
        const json = JSON.stringify(deep.value);
        if (typeof json === 'string') {
          serialized = json.length > 2048 ? `${json.slice(0, 2045)}...` : json;
        }
      } catch {
        serialized = '[UNSERIALIZABLE]';
      }
      safe[key] = serialized;
    } else {
      const scrubbed = redactPiiText(String(rawValue));
      safe[key] = scrubbed.text.slice(0, 512);
      redactedCount += scrubbed.count;
    }
  }
  return { attributes: safe, redactedCount };
}

function redactAttributes(attributes) {
  return redactAttributesWithCount(attributes).attributes;
}

function toOtlpAttributes(attributes) {
  const safe = redactAttributes(attributes);
  const list = [];
  for (const [key, value] of Object.entries(safe)) {
    if (typeof value === 'boolean') {
      list.push({ key, value: { boolValue: value } });
    } else if (typeof value === 'number') {
      if (Number.isInteger(value)) {
        list.push({ key, value: { intValue: String(value) } });
      } else {
        list.push({ key, value: { doubleValue: value } });
      }
    } else {
      list.push({ key, value: { stringValue: String(value) } });
    }
  }
  return list;
}

function getHeader(ctx, name) {
  if (typeof ctx?.get === 'function') {
    const val = ctx.get(name);
    if (val) return String(val).trim();
  }
  const lower = String(name || '').toLowerCase();
  const h = ctx?.headers?.[lower] ?? ctx?.request?.headers?.[lower];
  return h ? String(h).trim() : '';
}

function setHeader(ctx, name, value) {
  if (typeof ctx?.set === 'function') {
    ctx.set(name, value);
    return;
  }
  if (typeof ctx?.response?.set === 'function') {
    ctx.response.set(name, value);
    return;
  }
  if (ctx) {
    ctx.response = ctx.response || {};
    ctx.response.headers = ctx.response.headers || {};
    ctx.response.headers[name] = value;
  }
}

function sanitizePath(rawPath) {
  const str = String(rawPath || '/').split('?')[0].split('#')[0];
  return str.startsWith('/') ? str.slice(0, 512) : `/${str.slice(0, 511)}`;
}

function serializePreview(value, maxLen = 512) {
  const str = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return str.length > maxLen ? `${str.slice(0, maxLen)}...` : str;
}

function normalizeTimestamp(rawDate, fallbackMs = Date.now()) {
  if (rawDate instanceof Date && !Number.isNaN(rawDate.getTime())) return rawDate;
  if (typeof rawDate === 'number' && Number.isFinite(rawDate)) return new Date(rawDate);
  if (typeof rawDate === 'string' && rawDate.trim()) {
    const parsed = new Date(rawDate);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date(fallbackMs);
}

function validHexOrNull(val, regex, zeroVal) {
  if (typeof val !== 'string') return null;
  const trimmed = val.trim().toLowerCase();
  if (!regex.test(trimmed) || trimmed === zeroVal) return null;
  return trimmed;
}

function readRowField(row, key) {
  return typeof row?.get === 'function' ? row.get(key) : row?.[key];
}

function serializeAiTrace(row) {
  if (!row) return null;
  const plain = typeof row.toJSON === 'function' ? row.toJSON() : { ...row };
  return {
    id: readRowField(plain, 'id') ?? null,
    uid: readRowField(plain, 'uid') || null,
    organizationId: readRowField(plain, 'organizationId') || null,
    traceId: readRowField(plain, 'traceId') || null,
    spanId: readRowField(plain, 'spanId') || null,
    parentSpanId: readRowField(plain, 'parentSpanId') || null,
    runUid: readRowField(plain, 'runUid') || null,
    operationName: readRowField(plain, 'operationName') || 'chat',
    genAiSystem: readRowField(plain, 'genAiSystem') || 'latticedx',
    model: readRowField(plain, 'model') || null,
    agentName: readRowField(plain, 'agentName') || null,
    toolName: readRowField(plain, 'toolName') || null,
    status: readRowField(plain, 'status') || 'ok',
    durationMs: nonNegInt(readRowField(plain, 'durationMs')),
    inputTokens: nonNegInt(readRowField(plain, 'inputTokens')),
    outputTokens: nonNegInt(readRowField(plain, 'outputTokens')),
    totalTokens: nonNegInt(readRowField(plain, 'totalTokens')),
    piiRedactedCount: nonNegInt(readRowField(plain, 'piiRedactedCount')),
    attributesJson: readRowField(plain, 'attributesJson') || {},
    startedAt: readRowField(plain, 'startedAt') || null,
    endedAt: readRowField(plain, 'endedAt') || null,
    errorMessage: readRowField(plain, 'errorMessage') || null,
    createdAt: readRowField(plain, 'createdAt') || null,
    updatedAt: readRowField(plain, 'updatedAt') || null,
  };
}

async function runTraceScopedDb(db, organizationId, options, fn) {
  if (options?.transaction) {
    const active = getActiveRlsContext();
    if (active?.transaction === options.transaction && canUsePgRlsSession(db) && options.useSavepoint !== false) {
      return runInRlsSavepoint(db, fn);
    }
    return fn(options.transaction);
  }
  if (canUsePgRlsSession(db)) {
    const active = getActiveRlsContext();
    if (
      active?.transaction
      && active.sequelize === db?.sequelize
      && (active.systemRlsBypass === true || active.organizationId === organizationId)
    ) {
      if (options?.useSavepoint !== false) {
        return runInRlsSavepoint(db, fn);
      }
      return fn(active.transaction);
    }
    return withTenantRlsContext(db, organizationId, fn);
  }
  return fn(null);
}

async function persistGenAiTrace(db, traceRecord = {}, options = {}) {
  const repo = db?.getRepository?.('latticeAiTraces');
  if (!repo || typeof repo.create !== 'function') {
    throw Object.assign(new Error('latticeAiTraces repository is unavailable.'), {
      code: 'TRACE_REPO_UNAVAILABLE',
      status: 503,
    });
  }
  const organizationId = String(traceRecord?.organizationId || options?.organizationId || '').trim();
  assertValidOrganizationId(organizationId);

  const traceId = validHexOrNull(traceRecord.traceId, TRACE_ID_RE, ZERO_TRACE_ID) || randomHex(16);
  const spanId = validHexOrNull(traceRecord.spanId, SPAN_ID_RE, ZERO_SPAN_ID) || randomHex(8);
  const parentSpanId = validHexOrNull(traceRecord.parentSpanId, SPAN_ID_RE, ZERO_SPAN_ID);

  const operationName = String(traceRecord.operationName || 'chat').trim().slice(0, 64) || 'chat';
  const genAiSystem = String(traceRecord.genAiSystem || 'latticedx').trim().slice(0, 64) || 'latticedx';
  const statusRaw = String(traceRecord.status || 'ok').trim().toLowerCase();
  const status = VALID_TRACE_STATUSES.has(statusRaw) ? statusRaw : 'ok';

  const inputTokens = nonNegInt(traceRecord.inputTokens);
  const outputTokens = nonNegInt(traceRecord.outputTokens);
  const totalTokens = Math.max(inputTokens + outputTokens, nonNegInt(traceRecord.totalTokens));
  const durationMs = nonNegInt(traceRecord.durationMs);

  const startedAt = normalizeTimestamp(traceRecord.startedAt);
  const endedAt = traceRecord.endedAt
    ? normalizeTimestamp(traceRecord.endedAt, startedAt.getTime() + durationMs)
    : new Date(startedAt.getTime() + durationMs);

  const rawAttrs = traceRecord.attributesJson && typeof traceRecord.attributesJson === 'object' && !Array.isArray(traceRecord.attributesJson)
    ? traceRecord.attributesJson
    : {};
  const scrubbedAttrs = redactPiiDeep(rawAttrs, { maxDepth: 8, maxArray: 50, maxStringLen: 2048 });
  const rawErr = traceRecord.errorMessage ? String(traceRecord.errorMessage) : '';
  const scrubbedErr = rawErr ? redactPiiText(rawErr) : { text: '', count: 0 };
  const scrubbedModel = traceRecord.model ? redactPiiText(String(traceRecord.model).trim()) : { text: '', count: 0 };
  const scrubbedAgent = traceRecord.agentName ? redactPiiText(String(traceRecord.agentName).trim()) : { text: '', count: 0 };
  const scrubbedTool = traceRecord.toolName ? redactPiiText(String(traceRecord.toolName).trim()) : { text: '', count: 0 };
  const scrubbedRun = traceRecord.runUid ? redactPiiText(String(traceRecord.runUid).trim()) : { text: '', count: 0 };

  const basePiiCount = nonNegInt(traceRecord.piiRedactedCount);
  const piiRedactedCount = basePiiCount
    + scrubbedAttrs.count
    + scrubbedErr.count
    + scrubbedModel.count
    + scrubbedAgent.count
    + scrubbedTool.count
    + scrubbedRun.count;

  const uid = String(traceRecord.uid || `trc_${randomHex(12)}`).trim().slice(0, 128);
  const values = {
    uid,
    organizationId,
    traceId,
    spanId,
    parentSpanId: parentSpanId || null,
    runUid: scrubbedRun.text ? scrubbedRun.text.slice(0, 128) : null,
    operationName,
    genAiSystem,
    model: scrubbedModel.text ? scrubbedModel.text.slice(0, 160) : null,
    agentName: scrubbedAgent.text ? scrubbedAgent.text.slice(0, 160) : null,
    toolName: scrubbedTool.text ? scrubbedTool.text.slice(0, 160) : null,
    status,
    durationMs,
    inputTokens,
    outputTokens,
    totalTokens,
    piiRedactedCount,
    attributesJson: {
      ...(scrubbedAttrs.value && typeof scrubbedAttrs.value === 'object' ? scrubbedAttrs.value : {}),
      'dxos.pii.redacted_count': piiRedactedCount,
    },
    startedAt,
    endedAt,
    errorMessage: scrubbedErr.text ? scrubbedErr.text.slice(0, 2000) : null,
  };

  const created = await runTraceScopedDb(db, organizationId, options, (transaction) => repo.create({
    values,
    ...(transaction ? { transaction } : {}),
  }));
  return serializeAiTrace(created);
}

async function listGenAiTraces(db, query = {}, options = {}) {
  const repo = db?.getRepository?.('latticeAiTraces');
  if (!repo) {
    throw Object.assign(new Error('latticeAiTraces repository is unavailable.'), {
      code: 'TRACE_REPO_UNAVAILABLE',
      status: 503,
    });
  }
  const organizationId = String(query?.organizationId || options?.organizationId || '').trim();
  assertValidOrganizationId(organizationId);

  const filter = { organizationId };
  for (const key of ['runUid', 'traceId', 'operationName', 'agentName', 'toolName', 'model']) {
    if (typeof query?.[key] === 'string' && query[key].trim()) {
      filter[key] = query[key].trim();
    }
  }
  if (typeof query?.status === 'string' && VALID_TRACE_STATUSES.has(query.status.trim().toLowerCase())) {
    filter.status = query.status.trim().toLowerCase();
  }

  const rawLimit = Number(query?.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.min(200, Math.trunc(rawLimit)) : 50;
  const rawOffset = Number(query?.offset);
  const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? Math.trunc(rawOffset) : 0;

  let sort;
  if (query?.order === 'asc') {
    sort = ['startedAt', 'id'];
  } else if (query?.order === 'desc') {
    sort = ['-startedAt', '-id'];
  } else {
    sort = (filter.traceId || filter.runUid) ? ['startedAt', 'id'] : ['-startedAt', '-id'];
  }

  const { rows, count } = await runTraceScopedDb(db, organizationId, options, async (transaction) => {
    const queryOpts = {
      filter,
      limit,
      offset,
      sort,
      ...(transaction ? { transaction } : {}),
    };
    if (typeof repo.findAndCount === 'function') {
      const res = await repo.findAndCount(queryOpts);
      if (Array.isArray(res)) return { rows: res[0] || [], count: Number(res[1] || 0) };
      return { rows: res?.rows || [], count: Number(res?.count || 0) };
    }
    const foundRows = (await repo.find(queryOpts)) || [];
    const totalCount = typeof repo.count === 'function'
      ? Number(await repo.count({ filter, ...(transaction ? { transaction } : {}) }))
      : foundRows.length;
    return { rows: foundRows, count: totalCount };
  });

  return {
    items: rows.map(serializeAiTrace),
    total: count,
    limit,
    offset,
  };
}

function buildNormalizedGenAiSpan(input = {}, options = {}) {
  const incomingTp = typeof input.traceparent === 'string' ? parseTraceparent(input.traceparent) : null;
  const traceId = validHexOrNull(input.traceId, TRACE_ID_RE, ZERO_TRACE_ID)
    || incomingTp?.traceId
    || randomHex(16);
  const spanId = validHexOrNull(input.spanId, SPAN_ID_RE, ZERO_SPAN_ID)
    || randomHex(8);
  const parentSpanId = validHexOrNull(input.parentSpanId, SPAN_ID_RE, ZERO_SPAN_ID)
    || incomingTp?.parentSpanId
    || undefined;
  const traceparent = formatTraceparent(traceId, spanId, input.traceFlags || incomingTp?.traceFlags || '01');

  const rawModel = String(input.model || input.requestModel || input['gen_ai.request.model'] || '').trim();
  const rawAgentName = String(input.agentName || input['gen_ai.agent.name'] || '').trim();
  const rawToolName = String(input.toolName || input['gen_ai.tool.name'] || '').trim();
  const rawRunUid = String(input.runUid || input['dxos.run_uid'] || '').trim();

  const modelRes = rawModel ? redactPiiText(rawModel) : { text: '', count: 0 };
  const agentRes = rawAgentName ? redactPiiText(rawAgentName) : { text: '', count: 0 };
  const toolRes = rawToolName ? redactPiiText(rawToolName) : { text: '', count: 0 };
  const runUidRes = rawRunUid ? redactPiiText(rawRunUid) : { text: '', count: 0 };

  const model = modelRes.text ? modelRes.text.slice(0, 160) : null;
  const agentName = agentRes.text ? agentRes.text.slice(0, 160) : null;
  const toolName = toolRes.text ? toolRes.text.slice(0, 160) : null;
  const runUid = runUidRes.text ? runUidRes.text.slice(0, 128) : null;
  const organizationId = String(input.organizationId || options?.organizationId || input['dxos.org'] || '').trim();
  const operationName = String(
    input.operationName
    || input.operation
    || input['gen_ai.operation.name']
    || (toolName ? 'execute_tool' : agentName ? 'invoke_agent' : 'chat'),
  ).trim() || 'chat';
  const genAiSystem = String(input.genAiSystem || input.system || input['gen_ai.system'] || 'latticedx').trim() || 'latticedx';

  const status = (input.status === 'error' || input.status?.code === 2 || input.error || input.errorMessage)
    ? 'error'
    : (input.status === 'suspended' ? 'suspended' : 'ok');

  const inputTokens = nonNegInt(
    input.inputTokens ?? input.promptTokens ?? input.usage?.input_tokens ?? input.usage?.promptTokens ?? input.usage?.prompt_tokens ?? input['gen_ai.usage.input_tokens'],
  );
  const outputTokens = nonNegInt(
    input.outputTokens ?? input.completionTokens ?? input.usage?.output_tokens ?? input.usage?.completionTokens ?? input.usage?.completion_tokens ?? input['gen_ai.usage.output_tokens'],
  );
  const rawTotal = input.totalTokens ?? input.usage?.total_tokens ?? input.usage?.totalTokens;
  const totalTokens = rawTotal != null && Number.isFinite(Number(rawTotal))
    ? Math.max(inputTokens + outputTokens, nonNegInt(rawTotal))
    : (inputTokens + outputTokens);

  const startedAt = normalizeTimestamp(input.startedAt ?? input.startTimeMs);
  const computedDuration = input.endedAt
    ? Math.max(0, Math.round(normalizeTimestamp(input.endedAt).getTime() - startedAt.getTime()))
    : 0;
  const durationMs = input.durationMs !== undefined ? nonNegInt(input.durationMs) : computedDuration;
  const endedAt = input.endedAt
    ? normalizeTimestamp(input.endedAt, startedAt.getTime() + durationMs)
    : new Date(startedAt.getTime() + durationMs);

  const startTimeUnixNano = input.startTimeUnixNano !== undefined
    ? String(input.startTimeUnixNano)
    : (BigInt(startedAt.getTime()) * 1_000_000n).toString();
  const endTimeUnixNano = input.endTimeUnixNano !== undefined
    ? String(input.endTimeUnixNano)
    : (BigInt(startedAt.getTime()) * 1_000_000n + BigInt(durationMs) * 1_000_000n).toString();

  const rawError = input.errorMessage || input.error?.message || (typeof input.error === 'string' ? input.error : '');
  const errRes = rawError ? redactPiiText(String(rawError)) : { text: '', count: 0 };
  const errorMessage = errRes.text ? errRes.text.slice(0, 1000) : null;

  const hasInputPreview = input.inputPreview !== undefined && input.inputPreview !== null;
  const hasOutputPreview = input.outputPreview !== undefined && input.outputPreview !== null;
  const inputPrevRes = hasInputPreview ? redactPiiDeep(input.inputPreview) : { value: undefined, count: 0 };
  const outputPrevRes = hasOutputPreview ? redactPiiDeep(input.outputPreview) : { value: undefined, count: 0 };

  const incomingAttrs = input.attributes && typeof input.attributes === 'object' && !Array.isArray(input.attributes)
    ? { ...input.attributes }
    : {};
  const callerAttrPiiCount = nonNegInt(incomingAttrs['dxos.pii.redacted_count']);
  delete incomingAttrs['dxos.pii.redacted_count'];
  const attrRes = redactAttributesWithCount(incomingAttrs);

  const basePiiCount = Math.max(nonNegInt(input.piiRedactedCount), callerAttrPiiCount);
  const piiRedactedCount = basePiiCount
    + attrRes.redactedCount
    + errRes.count
    + inputPrevRes.count
    + outputPrevRes.count
    + modelRes.count
    + agentRes.count
    + toolRes.count
    + runUidRes.count;

  const spanAttributes = {
    ...attrRes.attributes,
    'gen_ai.operation.name': operationName,
    'gen_ai.system': genAiSystem,
    ...(model ? { 'gen_ai.request.model': model } : {}),
    'gen_ai.usage.input_tokens': inputTokens,
    'gen_ai.usage.output_tokens': outputTokens,
    ...(agentName ? { 'gen_ai.agent.name': agentName } : {}),
    ...(toolName ? { 'gen_ai.tool.name': toolName } : {}),
    ...(runUid ? { 'dxos.run_uid': runUid } : {}),
    ...(organizationId ? { 'dxos.org': organizationId } : {}),
    'dxos.status': status,
    'dxos.pii.redacted_count': piiRedactedCount,
    ...(hasInputPreview ? { 'dxos.input_preview': serializePreview(inputPrevRes.value, 512) } : {}),
    ...(hasOutputPreview ? { 'dxos.output_preview': serializePreview(outputPrevRes.value, 512) } : {}),
  };

  const spanName = String(
    input.name || `${operationName}${toolName ? ` ${toolName}` : agentName ? ` ${agentName}` : model ? ` ${model}` : ''}`,
  ).trim().slice(0, 256);

  const traceRecord = {
    uid: String(input.uid || `trc_${randomHex(12)}`).trim().slice(0, 128),
    organizationId: organizationId || null,
    traceId,
    spanId,
    parentSpanId: parentSpanId || null,
    runUid,
    operationName,
    genAiSystem,
    model,
    agentName,
    toolName,
    status,
    durationMs,
    inputTokens,
    outputTokens,
    totalTokens,
    piiRedactedCount,
    attributesJson: spanAttributes,
    startedAt,
    endedAt,
    errorMessage,
  };

  const otlpInput = {
    name: spanName,
    kind: Number.isInteger(input.kind) ? input.kind : 3,
    traceId,
    spanId,
    parentSpanId,
    startTimeUnixNano,
    endTimeUnixNano,
    attributes: spanAttributes,
    status: {
      code: status === 'error' ? 2 : 1,
      ...(errorMessage ? { message: errorMessage.slice(0, 512) } : {}),
    },
  };

  return {
    traceId,
    spanId,
    parentSpanId: parentSpanId || null,
    traceparent,
    spanAttributes,
    piiRedactedCount,
    traceRecord,
    otlpInput,
  };
}

function createOtelExporter(options = {}) {
  const serviceName =
    typeof options.serviceName === 'string' && options.serviceName.trim()
      ? options.serviceName.trim()
      : String(process.env.OTEL_SERVICE_NAME || 'latticedx-nocobase').trim();
  const serviceVersion =
    typeof options.serviceVersion === 'string' && options.serviceVersion.trim()
      ? options.serviceVersion.trim()
      : '0.4.1';
  const rawEndpoint =
    options.endpoint !== undefined ? options.endpoint : process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const tracesUrl = normalizeEndpoint(rawEndpoint);
  const maxQueueSize =
    Number.isInteger(options.maxQueueSize) && options.maxQueueSize >= 1
      ? options.maxQueueSize
      : DEFAULT_MAX_QUEUE_SIZE;
  const batchSize =
    Number.isInteger(options.batchSize) && options.batchSize >= 1
      ? Math.min(options.batchSize, maxQueueSize)
      : Math.min(DEFAULT_BATCH_SIZE, maxQueueSize);
  const exportTimeoutMs =
    Number.isInteger(options.exportTimeoutMs) && options.exportTimeoutMs >= 50
      ? options.exportTimeoutMs
      : DEFAULT_EXPORT_TIMEOUT_MS;
  const flushIntervalMs =
    Number.isInteger(options.flushIntervalMs) && options.flushIntervalMs >= 0
      ? options.flushIntervalMs
      : DEFAULT_FLUSH_INTERVAL_MS;
  const fetchFn = typeof options.fetchFn === 'function' ? options.fetchFn : globalThis.fetch;

  const queue = [];
  let recordedSpans = 0;
  let exportedSpans = 0;
  let droppedSpans = 0;
  let exportBatches = 0;
  let exportFailures = 0;
  let lastExportAt = null;
  let lastError = null;
  let flushInFlight = null;
  let timer = null;

  function recordSpan(spanInput = {}) {
    if (queue.length >= maxQueueSize) {
      droppedSpans += 1;
      return false;
    }

    const nowMs = BigInt(Date.now());
    const defaultNowNano = nowMs * 1_000_000n;
    const startNano =
      spanInput.startTimeUnixNano !== undefined
        ? String(spanInput.startTimeUnixNano)
        : String(defaultNowNano);
    const endNano =
      spanInput.endTimeUnixNano !== undefined
        ? String(spanInput.endTimeUnixNano)
        : startNano;

    const traceId =
      typeof spanInput.traceId === 'string' && TRACE_ID_RE.test(spanInput.traceId) && spanInput.traceId.toLowerCase() !== ZERO_TRACE_ID
        ? spanInput.traceId.toLowerCase()
        : randomHex(16);
    const spanId =
      typeof spanInput.spanId === 'string' && SPAN_ID_RE.test(spanInput.spanId) && spanInput.spanId.toLowerCase() !== ZERO_SPAN_ID
        ? spanInput.spanId.toLowerCase()
        : randomHex(8);
    const parentSpanId =
      typeof spanInput.parentSpanId === 'string' && SPAN_ID_RE.test(spanInput.parentSpanId) && spanInput.parentSpanId.toLowerCase() !== ZERO_SPAN_ID
        ? spanInput.parentSpanId.toLowerCase()
        : undefined;

    const statusCode =
      spanInput.status && typeof spanInput.status.code === 'number'
        ? spanInput.status.code
        : 1;
    const status = { code: statusCode };
    if (spanInput.status?.message) {
      status.message = redactPiiText(String(spanInput.status.message)).text.slice(0, 512);
    }

    const otlpSpan = {
      traceId,
      spanId,
      ...(parentSpanId ? { parentSpanId } : {}),
      name: String(spanInput.name || 'dxos.operation').slice(0, 256),
      kind: Number.isInteger(spanInput.kind) ? spanInput.kind : 1,
      startTimeUnixNano: startNano,
      endTimeUnixNano: endNano,
      attributes: toOtlpAttributes(spanInput.attributes),
      status,
    };

    queue.push(otlpSpan);
    recordedSpans += 1;
    return true;
  }

  async function flushOtel() {
    if (flushInFlight) {
      return flushInFlight;
    }
    if (queue.length === 0) {
      return { exported: 0, remaining: 0 };
    }
    if (!tracesUrl || typeof fetchFn !== 'function') {
      return { exported: 0, remaining: queue.length, skipped: true };
    }

    flushInFlight = (async () => {
      let totalExported = 0;
      while (queue.length > 0) {
        const batch = queue.slice(0, batchSize);
        const payload = {
          resourceSpans: [
            {
              resource: {
                attributes: toOtlpAttributes({
                  'service.name': serviceName,
                  'service.version': serviceVersion,
                }),
              },
              scopeSpans: [
                {
                  scope: {
                    name: '@latticedx/otel-exporter',
                    version: '0.4.1',
                  },
                  spans: batch,
                },
              ],
            },
          ],
        };

        try {
          const response = await fetchFn(tracesUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(exportTimeoutMs),
          });
          if (!response || !response.ok) {
            exportFailures += 1;
            lastError = `HTTP_${response?.status ?? 'UNKNOWN'}`;
            break;
          }
          queue.splice(0, batch.length);
          totalExported += batch.length;
          exportedSpans += batch.length;
          exportBatches += 1;
          lastExportAt = new Date().toISOString();
          lastError = null;
        } catch (error) {
          exportFailures += 1;
          lastError = String(error?.name || 'ExportError');
          break;
        }
      }
      return {
        exported: totalExported,
        remaining: queue.length,
        ...(lastError ? { error: lastError } : {}),
      };
    })();

    try {
      return await flushInFlight;
    } finally {
      flushInFlight = null;
    }
  }

  if (tracesUrl && flushIntervalMs > 0) {
    timer = setInterval(() => {
      if (queue.length > 0) {
        void flushOtel();
      }
    }, flushIntervalMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  }

  function traceMiddleware() {
    return async function dxosOtelTraceMiddleware(ctx, next) {
      const incoming = parseTraceparent(getHeader(ctx, 'traceparent'));
      const traceId = incoming ? incoming.traceId : randomHex(16);
      const parentSpanId = incoming ? incoming.parentSpanId : undefined;
      const spanId = randomHex(8);
      const traceFlags = incoming ? incoming.traceFlags : '01';
      const traceparent = formatTraceparent(traceId, spanId, traceFlags);

      if (ctx) {
        ctx.state = ctx.state || {};
        ctx.state.traceId = traceId;
        ctx.state.spanId = spanId;
        ctx.state.parentSpanId = parentSpanId;
        ctx.state.traceparent = traceparent;
        setHeader(ctx, 'traceparent', traceparent);
      }

      const startUnixNano = BigInt(Date.now()) * 1_000_000n;
      const startHr = process.hrtime.bigint();
      let caughtError = null;
      try {
        if (typeof next === 'function') {
          await next();
        }
      } catch (error) {
        caughtError = error;
        throw error;
      } finally {
        const elapsedNs = process.hrtime.bigint() - startHr;
        const endUnixNano = startUnixNano + (elapsedNs >= 0n ? elapsedNs : 0n);
        const method = String(ctx?.method || 'GET').toUpperCase();
        const safePath = sanitizePath(ctx?.path || ctx?.url || '/');
        const statusCode = caughtError
          ? Number(caughtError.status || caughtError.statusCode || (ctx?.status && ctx.status !== 404 ? ctx.status : 500))
          : Number(ctx?.status || (ctx?.body !== undefined ? 200 : 404));
        const requestId = getHeader(ctx, 'x-request-id');

        recordSpan({
          name: `HTTP ${method} ${safePath}`,
          kind: 2,
          traceId,
          spanId,
          parentSpanId,
          startTimeUnixNano: startUnixNano.toString(),
          endTimeUnixNano: endUnixNano.toString(),
          attributes: {
            'http.request.method': method,
            'url.path': safePath,
            'http.response.status_code': statusCode,
            ...(requestId ? { 'dxos.request_id': requestId } : {}),
          },
          status: {
            code: caughtError || statusCode >= 500 ? 2 : 1,
          },
        });

        if (tracesUrl && queue.length >= batchSize) {
          void flushOtel();
        }
      }
    };
  }

  function recordGenAiSpan(input = {}, spanOptions = {}) {
    const normalized = buildNormalizedGenAiSpan(input, spanOptions);
    const targetExporter = spanOptions?.exporter && typeof spanOptions.exporter.recordSpan === 'function'
      ? spanOptions.exporter
      : { recordSpan };
    const queued = targetExporter.recordSpan(normalized.otlpInput);

    const baseResult = {
      ok: true,
      queued,
      traceId: normalized.traceId,
      spanId: normalized.spanId,
      parentSpanId: normalized.parentSpanId,
      traceparent: normalized.traceparent,
      attributes: normalized.spanAttributes,
      piiRedactedCount: normalized.piiRedactedCount,
      traceRecord: normalized.traceRecord,
      persisted: null,
    };

    const orgId = normalized.traceRecord.organizationId || '';
    const shouldPersist = Boolean(
      spanOptions?.db
      && spanOptions.persist !== false
      && (ORG_ID_RE.test(orgId) || spanOptions.strictPersist === true),
    );
    if (!shouldPersist) {
      return baseResult;
    }

    return persistGenAiTrace(spanOptions.db, normalized.traceRecord, spanOptions)
      .then((persisted) => ({ ...baseResult, persisted }))
      .catch((error) => {
        if (spanOptions.strictPersist === true) throw error;
        return { ...baseResult, persisted: null, persistError: String(error?.code || error?.message || 'PERSIST_FAILED') };
      });
  }

  function startGenAiSpan(input = {}, startOptions = {}) {
    const incomingTp = typeof input.traceparent === 'string' ? parseTraceparent(input.traceparent) : null;
    const traceId = validHexOrNull(input.traceId, TRACE_ID_RE, ZERO_TRACE_ID)
      || incomingTp?.traceId
      || randomHex(16);
    const parentSpanId = validHexOrNull(input.parentSpanId, SPAN_ID_RE, ZERO_SPAN_ID)
      || incomingTp?.parentSpanId
      || undefined;
    const spanId = validHexOrNull(input.spanId, SPAN_ID_RE, ZERO_SPAN_ID) || randomHex(8);
    const traceparent = formatTraceparent(traceId, spanId, input.traceFlags || incomingTp?.traceFlags || '01');
    const startedAt = normalizeTimestamp(input.startedAt);
    const startUnixNano = BigInt(startedAt.getTime()) * 1_000_000n;
    const startHr = process.hrtime.bigint();

    let ended = false;
    let cachedResult = null;

    const span = {
      traceId,
      spanId,
      parentSpanId: parentSpanId || null,
      traceparent,
      operationName: String(input.operationName || input.operation || 'chat').trim() || 'chat',
      genAiSystem: String(input.genAiSystem || input.system || 'latticedx').trim() || 'latticedx',
      model: input.model ? String(input.model).trim() : null,
      agentName: input.agentName ? String(input.agentName).trim() : null,
      toolName: input.toolName ? String(input.toolName).trim() : null,
      runUid: input.runUid ? String(input.runUid).trim() : null,
      organizationId: input.organizationId ? String(input.organizationId).trim() : null,
      startedAt,
    };

    function end(result = {}, endOptions = {}) {
      if (ended) return cachedResult;
      ended = true;
      const elapsedNs = process.hrtime.bigint() - startHr;
      const computedDurationMs = Math.max(0, Math.round(Number(elapsedNs) / 1e6));
      const durationMs = result?.durationMs !== undefined ? nonNegInt(result.durationMs) : computedDurationMs;
      const endUnixNano = result?.endTimeUnixNano !== undefined
        ? String(result.endTimeUnixNano)
        : (startUnixNano + (elapsedNs >= 0n ? elapsedNs : 0n)).toString();
      const mergedInput = {
        ...input,
        ...result,
        traceId,
        spanId,
        parentSpanId,
        traceparent,
        startedAt,
        endedAt: result?.endedAt || new Date(startedAt.getTime() + durationMs),
        durationMs,
        startTimeUnixNano: startUnixNano.toString(),
        endTimeUnixNano: endUnixNano,
        attributes: {
          ...(input.attributes && typeof input.attributes === 'object' ? input.attributes : {}),
          ...(result?.attributes && typeof result.attributes === 'object' ? result.attributes : {}),
        },
      };
      cachedResult = recordGenAiSpan(mergedInput, { ...startOptions, ...endOptions });
      return cachedResult;
    }

    return {
      span,
      traceId,
      spanId,
      parentSpanId: parentSpanId || null,
      traceparent,
      startedAt,
      end,
    };
  }

  function getOtelStats() {
    return {
      enabled: Boolean(tracesUrl),
      serviceName,
      endpoint: tracesUrl || null,
      queuedSpans: queue.length,
      recordedSpans,
      exportedSpans,
      droppedSpans,
      exportBatches,
      exportFailures,
      lastExportAt,
      lastError,
    };
  }

  async function shutdown() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    return flushOtel();
  }

  return {
    traceMiddleware,
    recordSpan,
    parseTraceparent,
    formatTraceparent,
    flushOtel,
    getOtelStats,
    shutdown,
    recordGenAiSpan,
    startGenAiSpan,
  };
}

let defaultExporter = null;

function getDefaultOtelExporter() {
  if (!defaultExporter) {
    defaultExporter = createOtelExporter();
  }
  return defaultExporter;
}

function traceMiddleware() {
  return getDefaultOtelExporter().traceMiddleware();
}

function recordSpan(span) {
  return getDefaultOtelExporter().recordSpan(span);
}

function flushOtel() {
  return getDefaultOtelExporter().flushOtel();
}

function getOtelStats() {
  return getDefaultOtelExporter().getOtelStats();
}

function recordGenAiSpan(input, options = {}) {
  const exporter = options?.exporter || getDefaultOtelExporter();
  return exporter.recordGenAiSpan(input, options);
}

function startGenAiSpan(input, options = {}) {
  const exporter = options?.exporter || getDefaultOtelExporter();
  return exporter.startGenAiSpan(input, options);
}

module.exports = {
  DEFAULT_MAX_QUEUE_SIZE,
  createOtelExporter,
  traceMiddleware,
  recordSpan,
  parseTraceparent,
  formatTraceparent,
  flushOtel,
  getOtelStats,
  redactAttributes,
  redactAttributesWithCount,
  redactPiiText,
  redactPiiDeep,
  getDefaultOtelExporter,
  recordGenAiSpan,
  startGenAiSpan,
  persistGenAiTrace,
  listGenAiTraces,
};
