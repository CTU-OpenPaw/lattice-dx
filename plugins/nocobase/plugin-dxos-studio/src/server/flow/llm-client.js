/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const dns = require('node:dns');
const net = require('node:net');
const path = require('node:path');
const { val, toPlain, fail, loadFoundationModule } = require('../wms-dmn-shared');

const EXPLICIT_LOCAL_LLM_HOSTS = new Set(['host.docker.internal', 'localhost', '127.0.0.1']);
const SENSITIVE_KEY_RE = /token|secret|password|apikey|api_key|authorization|cookie|credential|jwt|bearer|privatekey|private_key|sessionid|session_id|passphrase|access_key|client_secret/i;

function loadSiblingAiGovernance() {
  const inDist = __dirname.includes(`${path.sep}dist${path.sep}`);
  const sub = inDist ? 'dist/server/ai-governance' : 'src/server/ai-governance';
  const alt = inDist ? 'src/server/ai-governance' : 'dist/server/ai-governance';
  const candidates = [
    path.resolve(__dirname, `../../../../plugin-dxos-ai/${sub}`),
    `@latticedx/plugin-dxos-ai/${sub}`,
    path.resolve(__dirname, `../../../../plugin-dxos-ai/${alt}`),
    `@latticedx/plugin-dxos-ai/${alt}`,
  ];
  for (const modPath of candidates) {
    try {
      return require(modPath);
    } catch (err) {
      const isDirect = err?.code === 'MODULE_NOT_FOUND'
        && (!Array.isArray(err.requireStack) || !err.requireStack.length || err.requireStack[0] === __filename);
      if (!isDirect) throw err;
    }
  }
  return null;
}

function fallbackRedactPiiText(rawText) {
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
  for (const [regex, rep] of rules) {
    text = text.replace(regex, (...args) => {
      count += 1;
      return rep.includes('$1') && args.length >= 2 ? rep.replace('$1', String(args[1] ?? '')) : rep;
    });
  }
  return { text, count };
}

function redactPiiForLlm(input) {
  const aiGov = loadSiblingAiGovernance();
  const redactText = typeof aiGov?.redactPiiText === 'function' ? aiGov.redactPiiText : fallbackRedactPiiText;
  let redactedCount = 0;
  function walk(node, depth = 0) {
    if (depth > 16) return '[TRUNCATED]';
    if (node == null || typeof node === 'number' || typeof node === 'boolean') return node;
    if (typeof node === 'string') {
      const res = redactText(node);
      redactedCount += Number(res?.count) || 0;
      return res?.text ?? node;
    }
    if (Array.isArray(node)) return node.map((item) => walk(item, depth + 1));
    if (typeof node === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
        if (SENSITIVE_KEY_RE.test(k)) { out[k] = '[REDACTED]'; redactedCount += 1; }
        else out[k] = walk(v, depth + 1);
      }
      return out;
    }
    return String(node);
  }
  return { redacted: walk(input, 0), redactedCount };
}

function parseJsonField(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    try { const p = JSON.parse(raw); return p && typeof p === 'object' ? p : {}; } catch { return {}; }
  }
  return {};
}

function extractExplicitLocalHost(rawUrl) {
  try {
    const bare = new URL(String(rawUrl || '').trim()).hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
    return EXPLICIT_LOCAL_LLM_HOSTS.has(bare) ? bare : null;
  } catch { return null; }
}

async function resolveActiveLlmService(db, env = process.env) {
  const llmRepo = db?.getRepository?.('llmServices');
  let rows = [];
  if (typeof llmRepo?.find === 'function') rows = (await llmRepo.find({ limit: 50 }).catch(() => [])) || [];
  else if (typeof llmRepo?.findOne === 'function') {
    const one = await llmRepo.findOne({ filter: { name: 'local-9router' } }).catch(() => null) || await llmRepo.findOne({}).catch(() => null);
    if (one) rows = [one];
  }
  const parsedRows = (Array.isArray(rows) ? rows : []).map((r) => toPlain(r) || r).filter((r) => r && val(r, 'enabled') !== false).map((row) => {
    const opts = parseJsonField(val(row, 'options'));
    const em = parseJsonField(val(row, 'enabledModels'));
    const list = Array.isArray(em.models) ? em.models : (Array.isArray(em) ? em : []);
    const firstModel = list.length ? (typeof list[0] === 'string' ? list[0] : list[0]?.value || '') : '';
    return {
      serviceName: String(val(row, 'name') || 'llm-service').trim(),
      provider: String(val(row, 'provider') || 'openai-completions').trim(),
      baseURL: String(opts.baseURL || opts.baseUrl || opts.endpoint || val(row, 'baseURL') || val(row, 'baseUrl') || '').trim(),
      apiKey: String(opts.apiKey || val(row, 'apiKey') || '').trim(),
      modelName: String(opts.model || opts.modelName || firstModel || env?.AGENT_MODEL || 'ag/gemini-3.8-flash').trim(),
    };
  });
  const preferred = parsedRows.find((r) => r.serviceName === 'local-9router' && (r.apiKey || r.baseURL))
    || parsedRows.find((r) => r.apiKey && r.baseURL)
    || parsedRows.find((r) => r.apiKey || r.baseURL);
  const envApiKey = String(env?.AGENT_API_KEY || env?.NINE_ROUTER_API_KEY || '').trim();
  const envBaseUrl = String(env?.AGENT_BASE_URL || '').trim();
  if (preferred) {
    const baseURL = preferred.baseURL || envBaseUrl || 'http://host.docker.internal:20128/v1';
    return {
      configured: true, source: 'llmServices', serviceName: preferred.serviceName, provider: preferred.provider,
      baseURL, apiKey: preferred.apiKey || envApiKey, modelName: preferred.modelName, allowExplicitHost: extractExplicitLocalHost(baseURL),
    };
  }
  if (!envApiKey && !envBaseUrl) return { configured: false, reason: 'No enabled llmServices entry or AGENT_API_KEY configured' };
  const baseURL = envBaseUrl || 'http://host.docker.internal:20128/v1';
  return {
    configured: true, source: 'env', serviceName: 'env', provider: 'openai-completions',
    baseURL, apiKey: envApiKey, modelName: String(env?.AGENT_MODEL || 'ag/gemini-3.8-flash').trim(), allowExplicitHost: extractExplicitLocalHost(baseURL),
  };
}

function isNonCanonicalHost(host) {
  const clean = String(host || '').toLowerCase().replace(/\.+$/, '');
  if (!clean) return false;
  if (/^\d+$/.test(clean) || /^0x[0-9a-f]+$/i.test(clean)) return true;
  const parts = clean.split('.');
  if (parts.length >= 1 && parts.length <= 4 && parts.every((p) => /^(?:0x[0-9a-f]+|0[0-7]*|[1-9]\d*)$/i.test(p))) {
    return parts.length !== 4 || parts.some((p) => /^0x/i.test(p) || (p.length > 1 && p.startsWith('0')));
  }
  return false;
}

function isPrivateOrMetaIpv4(ip) {
  const parts = String(ip || '').split('.');
  if (parts.length !== 4 || !parts.every((p) => /^(?:0|[1-9]\d{0,2})$/.test(p))) return false;
  const octets = parts.map(Number);
  if (octets.some((n) => n < 0 || n > 255)) return true;
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

function isMetadataTarget(host) {
  const clean = String(host || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!clean) return false;
  if (clean === 'metadata.google.internal' || clean.endsWith('.metadata.google.internal') || clean === 'metadata.azure.com'
    || clean.endsWith('.metadata.azure.com') || clean === 'metadata.aws.internal' || clean === 'instance-data'
    || clean === 'fd00:ec2::254') return true;
  if (net.isIPv4(clean) && clean.startsWith('169.254.')) return true;
  if (!clean.includes(':')) return false;
  let norm = clean.split('%')[0];
  try { norm = new URL(`http://[${norm}]/`).hostname.replace(/^\[|\]$/g, ''); } catch {}
  return norm.includes('169.254.') || clean.includes('169.254.')
    || norm.startsWith('::ffff:') || /^(?:0+:){5}ffff:/i.test(clean)
    || /(?:^|:)a9fe:[0-9a-f]{1,4}$/i.test(norm) || /(?:^|:)a9fe:[0-9a-f]{1,4}$/i.test(clean)
    || norm.startsWith('fe80:') || norm.startsWith('fc') || norm.startsWith('fd');
}

function extractRawAuthorityHost(rawUrl) {
  const m = String(rawUrl || '').match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i);
  if (!m || !m[1] || m[1].includes('@') || m[1].includes('\\')) return '';
  const auth = m[1];
  if (auth.startsWith('[')) {
    const end = auth.indexOf(']');
    return end < 0 ? '' : auth.slice(1, end).toLowerCase().replace(/\.+$/, '');
  }
  const colon = auth.indexOf(':');
  return (colon >= 0 ? auth.slice(0, colon) : auth).toLowerCase().replace(/\.+$/, '');
}

async function assertSafeLlmUrl(rawUrl, { env = process.env, connectorVault, lookupImpl, allowExplicitHost = null, skipDnsCheck = false } = {}) {
  const trimmed = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!trimmed || trimmed.length > 2048 || /[\u0000-\u001f\u007f\s]/.test(trimmed)) {
    throw fail('LLM_URL_UNSAFE', 400, 'LLM URL is required and must be <= 2048 characters.');
  }
  let parsed;
  try { parsed = new URL(trimmed); } catch { throw fail('LLM_URL_UNSAFE', 400, 'Malformed LLM URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw fail('LLM_URL_UNSAFE', 400, `Protocol ${parsed.protocol} is blocked.`);
  if (parsed.username || parsed.password) throw fail('LLM_URL_UNSAFE', 400, 'Embedded URL credentials are forbidden.');

  const rawAuth = extractRawAuthorityHost(trimmed);
  const bare = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!rawAuth || !bare || isNonCanonicalHost(rawAuth) || isNonCanonicalHost(bare)) {
    throw fail('LLM_URL_UNSAFE', 400, `Non-canonical LLM hostname blocked: ${bare || rawAuth}`);
  }
  if (isMetadataTarget(bare) || isMetadataTarget(rawAuth)) {
    throw fail('LLM_URL_UNSAFE', 400, `Cloud metadata target ${bare} is blocked by SSRF policy.`);
  }

  const explicitList = Array.isArray(allowExplicitHost) ? allowExplicitHost : [allowExplicitHost];
  const allowedLocalSet = new Set(
    explicitList.map((h) => String(h || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, ''))
      .filter((h) => EXPLICIT_LOCAL_LLM_HOSTS.has(h)),
  );
  const isExplicitLocal = EXPLICIT_LOCAL_LLM_HOSTS.has(bare) && allowedLocalSet.has(bare);

  if (!isExplicitLocal) {
    if (bare === 'localhost' || bare.endsWith('.localhost') || bare.endsWith('.local') || bare.endsWith('.internal')) {
      throw fail('LLM_URL_UNSAFE', 400, `Internal hostname ${bare} is blocked by SSRF policy.`);
    }
    if ((net.isIPv4(bare) && isPrivateOrMetaIpv4(bare)) || bare.includes(':') || !bare.includes('.')) {
      throw fail('LLM_URL_UNSAFE', 400, `Private, IPv6, or non-FQDN host ${bare} is blocked by SSRF policy.`);
    }
  }

  const vault = connectorVault || loadFoundationModule('connector-vault');
  const vaultEnv = isExplicitLocal ? { ...env, DX_CONNECTOR_INTERNAL_ALLOWLIST: [env?.DX_CONNECTOR_INTERNAL_ALLOWLIST, bare].filter(Boolean).join(',') } : env;
  if (typeof vault?.assertSafeConnectorUrlAsync === 'function') {
    await vault.assertSafeConnectorUrlAsync(trimmed, { connectorType: 'http_api', env: vaultEnv, allowInternal: isExplicitLocal, lookupImpl, skipDnsCheck: isExplicitLocal || skipDnsCheck });
  } else if (typeof vault?.assertSafeConnectorUrl === 'function') {
    vault.assertSafeConnectorUrl(trimmed, { connectorType: 'http_api', env: vaultEnv, allowInternal: isExplicitLocal });
  }

  if (typeof lookupImpl === 'function' || (!isExplicitLocal && !skipDnsCheck && net.isIP(bare) === 0)) {
    const lookup = typeof lookupImpl === 'function' ? lookupImpl : dns.promises.lookup;
    const records = await lookup(bare, { all: true }).catch((err) => { throw fail('LLM_URL_UNSAFE', 400, `DNS failed for ${bare}: ${err?.code || err?.message}`); });
    const addrs = (Array.isArray(records) ? records : (records ? [records] : [])).map((r) => (typeof r === 'string' ? r : r?.address)).filter(Boolean);
    if (!addrs.length) throw fail('LLM_URL_UNSAFE', 400, `DNS returned no addresses for ${bare}.`);
    for (const addr of addrs) {
      if (isMetadataTarget(addr) || (!isExplicitLocal && ((net.isIPv4(addr) && isPrivateOrMetaIpv4(addr)) || addr.includes(':')))) {
        throw fail('LLM_URL_UNSAFE', 400, `Resolved IP ${addr} for ${bare} is blocked by SSRF policy.`);
      }
    }
  }
  return parsed.toString();
}

const scrubSecretText = (text, apiKey) => {
  let out = String(text || '');
  if (apiKey && apiKey.length >= 4) out = out.split(apiKey).join('[REDACTED]');
  return out.replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, '[REDACTED_KEY]').replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, '$1[REDACTED]');
};

const stripJsonFence = (content) => {
  const trimmed = String(content ?? '').trim();
  const m = trimmed.match(/^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n?```$/i);
  return m ? m[1].trim() : trimmed;
};

async function callConfiguredLlm({
  db, env = process.env, messages = [], model, temperature = 0.2, maxTokens = 1600,
  responseFormat = 'json', timeoutMs = 15000, fetchImpl, lookupImpl, connectorVault,
} = {}) {
  const service = await resolveActiveLlmService(db, env);
  if (!service.configured) return { ok: false, mode: 'unconfigured', reason: service.reason };
  const base = String(service.baseURL || '').replace(/\/+$/, '');
  const endpointUrl = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
  const fetchFn = fetchImpl || globalThis.fetch;
  const isMockTransport = typeof fetchImpl === 'function' && fetchImpl !== globalThis.fetch;

  await assertSafeLlmUrl(endpointUrl, {
    env, connectorVault, lookupImpl, allowExplicitHost: service.allowExplicitHost || null,
    skipDnsCheck: isMockTransport && typeof lookupImpl !== 'function',
  });
  if (typeof fetchFn !== 'function') return { ok: false, mode: 'error', code: 'LLM_FETCH_UNAVAILABLE', reason: 'HTTP fetch unavailable' };

  let piiRedactedCount = 0;
  const redactedMessages = (Array.isArray(messages) ? messages : []).map((m) => {
    const red = redactPiiForLlm(m?.content ?? '');
    piiRedactedCount += red.redactedCount;
    const content = typeof red.redacted === 'string' ? red.redacted : JSON.stringify(red.redacted ?? '');
    return { role: String(m?.role || 'user'), content };
  });

  const targetModel = String(model || service.modelName || 'ag/gemini-3.8-flash').trim();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, Math.min(120000, Number(timeoutMs) || 15000)));
  try {
    const response = await fetchFn(endpointUrl, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(service.apiKey ? { Authorization: `Bearer ${service.apiKey}` } : {}) },
      body: JSON.stringify({
        model: targetModel, messages: redactedMessages,
        temperature: Number.isFinite(Number(temperature)) ? Number(temperature) : 0.2,
        max_tokens: Math.max(1, Math.floor(Number(maxTokens) || 1600)),
        ...(responseFormat === 'json' ? { response_format: { type: 'json_object' } } : {}),
      }),
    });
    if (!response?.ok) {
      const errBody = typeof response?.text === 'function' ? await response.text().catch(() => '') : '';
      return { ok: false, mode: 'error', code: `LLM_HTTP_${response?.status || 'ERR'}`, reason: scrubSecretText(errBody || `LLM HTTP ${response?.status || 'error'}`, service.apiKey) };
    }
    const payload = await response.json();
    const rawContent = String(payload?.choices?.[0]?.message?.content ?? '');
    let parsedJson = null;
    if (responseFormat === 'json' && rawContent.trim()) {
      try { parsedJson = JSON.parse(stripJsonFence(rawContent)); } catch { parsedJson = null; }
    }
    return { ok: true, mode: 'llm', content: rawContent, parsedJson, usage: payload?.usage || null, model: payload?.model || targetModel, piiRedactedCount };
  } catch (err) {
    return {
      ok: false, mode: 'error',
      code: err?.name === 'AbortError' ? 'LLM_TIMEOUT' : (err?.code || 'LLM_REQUEST_FAILED'),
      reason: scrubSecretText(err?.message || 'LLM request failed', service.apiKey),
    };
  } finally { clearTimeout(timer); }
}

module.exports = { EXPLICIT_LOCAL_LLM_HOSTS, resolveActiveLlmService, assertSafeLlmUrl, isMetadataTarget, redactPiiForLlm, callConfiguredLlm };
