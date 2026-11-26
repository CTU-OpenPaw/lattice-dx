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
const { stripUnsafeKeys } = require('./json-schema-validator');
const { SENSITIVE_KEY_RE, extractRawAuthorityHost, isBlockedIpv6, isMetadataTarget, isNonCanonicalHost, isPrivateOrMetaIpv4, redactJsonQuotedSecrets } = require('./security-helpers');

const EXPLICIT_LOCAL_LLM_HOSTS = new Set(['host.docker.internal', 'localhost', '127.0.0.1', '::1']);

function loadSiblingAiGovernance() {
  const inDist = __dirname.includes(`${path.sep}dist${path.sep}`);
  const sub = inDist ? 'dist/server/ai-governance' : 'src/server/ai-governance';
  const alt = inDist ? 'src/server/ai-governance' : 'dist/server/ai-governance';
  for (const modPath of [path.resolve(__dirname, `../../../../plugin-dxos-ai/${sub}`), `@latticedx/plugin-dxos-ai/${sub}`, path.resolve(__dirname, `../../../../plugin-dxos-ai/${alt}`), `@latticedx/plugin-dxos-ai/${alt}`]) {
    try { return require(modPath); } catch (err) {
      const isDirect = err?.code === 'MODULE_NOT_FOUND' && (!Array.isArray(err.requireStack) || !err.requireStack.length || err.requireStack[0] === __filename);
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
    [/((?:["'])?[a-zA-Z0-9_.-]*(?:token|secret|password|apikey|api_key|jwt|privatekey|private_key|client_secret|access_key|credential|passphrase|sessionid|session_id|authorization|cookie)(?:["'])?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}"']+)/gi, '$1[REDACTED]'],
    [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED_EMAIL]'],
    [/(\b(?:cccd|cmnd|căn cước(?:\s+công dân)?)\s*[:#=-]?\s*)\d{9,12}\b/gi, '$1[REDACTED_CCCD]'],
    [/(?<![0-9A-Za-z-])0\d{11}(?![0-9A-Za-z-])/g, '[REDACTED_CCCD]'],
    [/(?<![0-9A-Za-z-])(?:\+?84[\s.-]?|0)(?:3|5|7|8|9)(?:[\s.-]?\d){8}(?![0-9A-Za-z-])/g, '[REDACTED_PHONE]'],
    [/(\b(?:stk|số tài khoản|tài khoản ngân hàng|iban)\s*[:#=-]?\s*)[A-Z0-9 -]{8,24}(?=\s*[,;.\n]|$)/gi, '$1[REDACTED_BANK]'],
    [/(\b(?:mst|mã số thuế)\s*[:#=-]?\s*)\d{10}(?:-\d{3})?\b/gi, '$1[REDACTED_MST]'],
  ];
  for (const [regex, rep] of rules) {
    text = text.replace(regex, (...args) => { count += 1; return rep.includes('$1') && args.length >= 2 ? rep.replace('$1', String(args[1] ?? '')) : rep; });
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
      const res = redactText(node); const jsonFixed = redactJsonQuotedSecrets(res?.text ?? node);
      redactedCount += (Number(res?.count) || 0) + jsonFixed.count; return jsonFixed.text;
    }
    if (Array.isArray(node)) return node.map((item) => walk(item, depth + 1));
    if (typeof node === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
        if (SENSITIVE_KEY_RE.test(k)) { out[k] = '[REDACTED]'; redactedCount += 1; } else out[k] = walk(v, depth + 1);
      }
      return out;
    }
    return String(node);
  }
  return { redacted: walk(input, 0), redactedCount };
}

function parseJsonField(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) { try { const p = JSON.parse(raw); return p && typeof p === 'object' ? p : {}; } catch { return {}; } }
  return {};
}
function safeJsonObject(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return stripUnsafeKeys(raw);
  if (typeof raw === 'string' && raw.trim()) { try { const p = JSON.parse(raw); return p && typeof p === 'object' && !Array.isArray(p) ? stripUnsafeKeys(p) : {}; } catch { return {}; } }
  return {};
}
function extractExplicitLocalHost(rawUrl) {
  try { const bare = new URL(String(rawUrl || '').trim()).hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, ''); return EXPLICIT_LOCAL_LLM_HOSTS.has(bare) ? bare : null; } catch { return null; }
}
function normalizeProviderFamily(provider) {
  const lower = String(provider || '').trim().toLowerCase();
  if (lower.includes('gemini') || lower.includes('google')) return 'google-genai';
  if (lower.includes('anthropic') || lower.includes('claude')) return 'anthropic';
  if (lower.includes('ollama')) return 'ollama';
  return 'openai-compat';
}
const PROVIDER_DEFAULTS = {
  'google-genai': ['https://generativelanguage.googleapis.com', 'gemini-2.5-flash'],
  anthropic: ['https://api.anthropic.com/v1', 'claude-3-5-sonnet-latest'],
  ollama: ['http://127.0.0.1:11434', 'llama3.1'],
  deepseek: ['https://api.deepseek.com/v1', 'deepseek-chat'],
  openai: ['https://api.openai.com/v1', 'gpt-4o-mini'],
};
function resolveDefaultBaseUrlForProvider(provider, envBaseUrl = '') {
  const lower = String(provider || '').trim().toLowerCase();
  const fam = normalizeProviderFamily(lower);
  return PROVIDER_DEFAULTS[fam]?.[0] || PROVIDER_DEFAULTS[lower]?.[0] || envBaseUrl || 'http://host.docker.internal:20128/v1';
}
function resolveDefaultModelForProvider(provider, envModel = '') {
  const lower = String(provider || '').trim().toLowerCase();
  const fam = normalizeProviderFamily(lower);
  return PROVIDER_DEFAULTS[fam]?.[1] || PROVIDER_DEFAULTS[lower]?.[1] || envModel || 'ag/gemini-3.8-flash';
}

async function resolveActiveLlmService(db, env = process.env, options = {}) {
  const llmRepo = db?.getRepository?.('llmServices');
  let rows = [];
  if (typeof llmRepo?.find === 'function') rows = (await llmRepo.find({ limit: 50 }).catch(() => [])) || [];
  else if (typeof llmRepo?.findOne === 'function') {
    const one = await llmRepo.findOne({ filter: { name: 'local-9router' } }).catch(() => null) || await llmRepo.findOne({}).catch(() => null);
    if (one) rows = [one];
  }
  const envApiKey = String(env?.AGENT_API_KEY || env?.NINE_ROUTER_API_KEY || '').trim();
  const envBaseUrl = String(env?.AGENT_BASE_URL || '').trim();
  const envModel = String(env?.AGENT_MODEL || '').trim();
  const parsedRows = (Array.isArray(rows) ? rows : []).map((r) => toPlain(r) || r).filter((r) => r && val(r, 'enabled') !== false).map((row) => {
    const opts = parseJsonField(val(row, 'options')); const em = parseJsonField(val(row, 'enabledModels'));
    const list = Array.isArray(em.models) ? em.models : (Array.isArray(em) ? em : []);
    const firstModel = list.length ? (typeof list[0] === 'string' ? list[0] : list[0]?.value || '') : '';
    const provider = String(val(row, 'provider') || 'openai-completions').trim();
    return {
      serviceName: String(val(row, 'name') || 'llm-service').trim(), provider, family: normalizeProviderFamily(provider),
      baseURL: String(opts.baseURL || opts.baseUrl || opts.endpoint || val(row, 'baseURL') || val(row, 'baseUrl') || '').trim(),
      apiKey: String(opts.apiKey || val(row, 'apiKey') || '').trim(),
      modelName: String(opts.model || opts.modelName || firstModel || resolveDefaultModelForProvider(provider, envModel)).trim(),
    };
  });
  const reqSvc = String(options?.serviceName || '').trim();
  const preferred = (reqSvc ? parsedRows.find((r) => r.serviceName === reqSvc && (r.apiKey || r.baseURL || r.family === 'ollama')) : null)
    || parsedRows.find((r) => r.serviceName === 'local-9router' && (r.apiKey || r.baseURL))
    || parsedRows.find((r) => r.apiKey && r.baseURL) || parsedRows.find((r) => r.apiKey || r.baseURL) || parsedRows.find((r) => r.family === 'ollama');
  if (preferred) {
    const baseURL = preferred.baseURL || resolveDefaultBaseUrlForProvider(preferred.provider, envBaseUrl);
    return { configured: true, source: 'llmServices', serviceName: preferred.serviceName, provider: preferred.provider, baseURL, apiKey: preferred.apiKey || (preferred.family === 'openai-compat' ? envApiKey : ''), modelName: preferred.modelName, allowExplicitHost: extractExplicitLocalHost(baseURL) };
  }
  if (!envApiKey && !envBaseUrl) return { configured: false, reason: 'No enabled llmServices entry or AGENT_API_KEY configured' };
  const baseURL = envBaseUrl || 'http://host.docker.internal:20128/v1';
  return { configured: true, source: 'env', serviceName: 'env', provider: 'openai-completions', baseURL, apiKey: envApiKey, modelName: envModel || 'ag/gemini-3.8-flash', allowExplicitHost: extractExplicitLocalHost(baseURL) };
}

async function assertSafeLlmUrl(rawUrl, { env = process.env, connectorVault, lookupImpl, allowExplicitHost = null, skipDnsCheck = false } = {}) {
  const trimmed = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!trimmed || trimmed.length > 2048 || /[\u0000-\u001f\u007f\s]/.test(trimmed)) throw fail('LLM_URL_UNSAFE', 400, 'LLM URL is required and must be <= 2048 characters.');
  let parsed; try { parsed = new URL(trimmed); } catch { throw fail('LLM_URL_UNSAFE', 400, 'Malformed LLM URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw fail('LLM_URL_UNSAFE', 400, `Protocol ${parsed.protocol} is blocked.`);
  if (parsed.username || parsed.password) throw fail('LLM_URL_UNSAFE', 400, 'Embedded URL credentials are forbidden.');
  const rawAuth = extractRawAuthorityHost(trimmed);
  const bare = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!rawAuth || !bare || isNonCanonicalHost(rawAuth) || isNonCanonicalHost(bare)) throw fail('LLM_URL_UNSAFE', 400, `Non-canonical LLM hostname blocked: ${bare || rawAuth}`);
  if (isMetadataTarget(bare) || isMetadataTarget(rawAuth)) throw fail('LLM_URL_UNSAFE', 400, `Cloud metadata target ${bare} is blocked by SSRF policy.`);
  const explicitList = Array.isArray(allowExplicitHost) ? allowExplicitHost : [allowExplicitHost];
  const allowedLocalSet = new Set(explicitList.map((h) => String(h || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '')).filter((h) => EXPLICIT_LOCAL_LLM_HOSTS.has(h)));
  const isExplicitLocal = EXPLICIT_LOCAL_LLM_HOSTS.has(bare) && allowedLocalSet.has(bare);
  if (!isExplicitLocal) {
    if (bare === 'localhost' || bare.endsWith('.localhost') || bare.endsWith('.local') || bare.endsWith('.internal')) throw fail('LLM_URL_UNSAFE', 400, `Internal hostname ${bare} is blocked by SSRF policy.`);
    if (bare.includes(':') ? isBlockedIpv6(bare) : ((net.isIPv4(bare) && isPrivateOrMetaIpv4(bare)) || !bare.includes('.'))) throw fail('LLM_URL_UNSAFE', 400, `Private, IPv6, or non-FQDN host ${bare} is blocked by SSRF policy.`);
    const vault = connectorVault || loadFoundationModule('connector-vault');
    if (typeof vault?.assertSafeConnectorUrlAsync === 'function') await vault.assertSafeConnectorUrlAsync(trimmed, { connectorType: 'http_api', env, allowInternal: false, lookupImpl, skipDnsCheck });
    else if (typeof vault?.assertSafeConnectorUrl === 'function') vault.assertSafeConnectorUrl(trimmed, { connectorType: 'http_api', env, allowInternal: false });
  }
  if (typeof lookupImpl === 'function' || (!isExplicitLocal && !skipDnsCheck && net.isIP(bare) === 0)) {
    const lookup = typeof lookupImpl === 'function' ? lookupImpl : dns.promises.lookup;
    const records = await lookup(bare, { all: true }).catch((err) => { throw fail('LLM_URL_UNSAFE', 400, `DNS failed for ${bare}: ${err?.code || err?.message}`); });
    const addrs = (Array.isArray(records) ? records : (records ? [records] : [])).map((r) => (typeof r === 'string' ? r : r?.address)).filter(Boolean);
    if (!addrs.length) throw fail('LLM_URL_UNSAFE', 400, `DNS returned no addresses for ${bare}.`);
    for (const addr of addrs) {
      if (isMetadataTarget(addr) || (!isExplicitLocal && ((net.isIPv4(addr) && isPrivateOrMetaIpv4(addr)) || (addr.includes(':') && isBlockedIpv6(addr))))) {
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
const stripJsonFence = (c) => { const t = String(c ?? '').trim(), m = t.match(/^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n?```$/i); return m ? m[1].trim() : t; };

function normalizeToolDefs(rawTools) {
  if (!Array.isArray(rawTools) || !rawTools.length) return undefined;
  const out = rawTools.map((t) => {
    const fn = t?.function && typeof t.function === 'object' ? t.function : t;
    const name = String(fn?.name || '').trim();
    if (!name) return null;
    return { type: 'function', function: { name, ...(fn.description ? { description: String(fn.description).slice(0, 1000) } : {}), parameters: stripUnsafeKeys(fn.parameters && typeof fn.parameters === 'object' ? fn.parameters : { type: 'object', properties: {} }) } };
  }).filter(Boolean);
  return out.length ? out : undefined;
}
function parseToolCalls(rawToolCalls) {
  if (!Array.isArray(rawToolCalls)) return [];
  return rawToolCalls.map((tc, idx) => {
    const fn = tc?.function && typeof tc.function === 'object' ? tc.function : tc;
    const rawArgs = typeof fn?.arguments === 'string' ? fn.arguments : JSON.stringify(fn?.arguments ?? {});
    return { id: String(tc?.id || `call_${idx + 1}`), type: 'function', name: String(fn?.name || tc?.name || '').trim(), argumentsRaw: rawArgs, arguments: safeJsonObject(rawArgs) };
  }).filter((tc) => tc.name);
}
function normalizeLlmMessage(m) {
  let count = 0; const role = String(m?.role || 'user'); let content = null;
  if (m?.content !== null && m?.content !== undefined) {
    const red = redactPiiForLlm(m.content); count += red.redactedCount;
    content = typeof red.redacted === 'string' ? red.redacted : JSON.stringify(red.redacted ?? '');
  } else if (role !== 'assistant' || !Array.isArray(m?.tool_calls)) content = '';
  const msg = { role, content, ...(m?.name ? { name: String(m.name) } : {}), ...(m?.tool_call_id ? { tool_call_id: String(m.tool_call_id) } : {}) };
  if (Array.isArray(m?.tool_calls) && m.tool_calls.length) {
    msg.tool_calls = m.tool_calls.map((tc) => {
      const fn = tc?.function || {}; const argRed = redactPiiForLlm(typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}));
      count += argRed.redactedCount;
      return { id: String(tc?.id || ''), type: 'function', function: { name: String(fn.name || ''), arguments: typeof argRed.redacted === 'string' ? argRed.redacted : JSON.stringify(argRed.redacted ?? {}) } };
    });
  }
  return { msg, count };
}

function buildProviderRequest({ provider, baseURL, apiKey, model, messages = [], temperature = 0.2, maxTokens = 1600, responseFormat = 'json', tools, toolChoice } = {}) {
  const rawFam = normalizeProviderFamily(provider);
  const base = String(baseURL || '').replace(/\/+$/, '');
  const family = rawFam === 'ollama' && (/\/v1$/i.test(base) || /\/chat\/completions$/i.test(base)) ? 'openai-compat' : rawFam;
  const temp = Number.isFinite(Number(temperature)) ? Number(temperature) : 0.2;
  const maxTok = Math.max(1, Math.floor(Number(maxTokens) || 1600));
  const jsonHdrs = { 'Content-Type': 'application/json', Accept: 'application/json' };
  const hasTools = Array.isArray(tools) && tools.length > 0;
  if (family === 'google-genai') {
    const prefix = base.endsWith('/v1beta') ? base : (base.endsWith('/v1beta/models') ? base.replace(/\/models$/, '') : `${base}/v1beta`);
    const systemParts = []; const contents = [];
    for (const m of messages) {
      if (m.role === 'system') { if (m.content) systemParts.push({ text: String(m.content) }); }
      else if (m.role === 'assistant') {
        const parts = [...(m.content ? [{ text: String(m.content) }] : []), ...(m.tool_calls || []).map((tc) => ({ functionCall: { name: tc.function?.name || '', args: safeJsonObject(tc.function?.arguments) } }))];
        if (parts.length) contents.push({ role: 'model', parts });
      } else if (m.role === 'tool') contents.push({ role: 'user', parts: [{ functionResponse: { name: m.name || 'tool', response: { result: String(m.content ?? '') } } }] });
      else contents.push({ role: 'user', parts: [{ text: String(m.content ?? '') }] });
    }
    return {
      family, endpointUrl: `${prefix}/models/${encodeURIComponent(model)}:generateContent`,
      headers: { ...jsonHdrs, ...(apiKey ? { 'x-goog-api-key': apiKey } : {}) },
      body: {
        ...(systemParts.length ? { systemInstruction: { parts: systemParts } } : {}),
        contents: contents.length ? contents : [{ role: 'user', parts: [{ text: '' }] }],
        generationConfig: { temperature: temp, maxOutputTokens: maxTok, ...(responseFormat === 'json' ? { responseMimeType: 'application/json' } : {}) },
        ...(hasTools ? { tools: [{ functionDeclarations: tools.map((t) => ({ name: t.function.name, ...(t.function.description ? { description: t.function.description } : {}), parameters: t.function.parameters })) }] } : {}),
      },
    };
  }
  if (family === 'anthropic') {
    const systemTexts = []; const antMessages = [];
    for (const m of messages) {
      if (m.role === 'system') { if (m.content) systemTexts.push(String(m.content)); }
      else if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
        antMessages.push({ role: 'assistant', content: [...(m.content ? [{ type: 'text', text: String(m.content) }] : []), ...m.tool_calls.map((tc) => ({ type: 'tool_use', id: tc.id || 'toolu_1', name: tc.function?.name || '', input: safeJsonObject(tc.function?.arguments) }))] });
      } else if (m.role === 'tool') antMessages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id || 'toolu_1', content: String(m.content ?? '') }] });
      else antMessages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content ?? '') });
    }
    const antChoice = !hasTools || toolChoice === undefined ? undefined : (toolChoice === 'auto' ? { type: 'auto' } : (toolChoice === 'required' ? { type: 'any' } : (typeof toolChoice === 'object' ? toolChoice : undefined)));
    return {
      family, endpointUrl: base.endsWith('/messages') ? base : (base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`),
      headers: { ...jsonHdrs, ...(apiKey ? { 'x-api-key': apiKey } : {}), 'anthropic-version': '2023-06-01' },
      body: { model, max_tokens: maxTok, temperature: temp, ...(systemTexts.length ? { system: systemTexts.join('\n\n') } : {}), messages: antMessages, ...(hasTools ? { tools: tools.map((t) => ({ name: t.function.name, ...(t.function.description ? { description: t.function.description } : {}), input_schema: t.function.parameters })), ...(antChoice ? { tool_choice: antChoice } : {}) } : {}) },
    };
  }
  if (family === 'ollama') return { family, endpointUrl: base.endsWith('/api/chat') ? base : `${base.replace(/\/api\/?$/, '')}/api/chat`, headers: { ...jsonHdrs, ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) }, body: { model, messages, stream: false, ...(responseFormat === 'json' ? { format: 'json' } : {}), ...(hasTools ? { tools } : {}), options: { temperature: temp, num_predict: maxTok } } };
  return { family: 'openai-compat', endpointUrl: base.endsWith('/chat/completions') ? base : `${base}/chat/completions`, headers: { ...jsonHdrs, ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) }, body: { model, messages, temperature: temp, max_tokens: maxTok, ...(responseFormat === 'json' ? { response_format: { type: 'json_object' } } : {}), ...(hasTools ? { tools, ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}) } : {}) } };
}

function parseProviderResponse(family, payload, targetModel) {
  const mapToolCalls = (tcs) => tcs.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.argumentsRaw } }));
  if (family === 'google-genai') {
    const parts = Array.isArray(payload?.candidates?.[0]?.content?.parts) ? payload.candidates[0].content.parts : [];
    const textParts = []; const toolCalls = [];
    parts.forEach((p, idx) => {
      if (typeof p?.text === 'string') textParts.push(p.text);
      if (p?.functionCall?.name) { const a = safeJsonObject(p.functionCall.args); toolCalls.push({ id: `call_${idx + 1}`, type: 'function', name: String(p.functionCall.name).trim(), argumentsRaw: JSON.stringify(a), arguments: a }); }
    });
    const rawContent = textParts.join(''); const um = payload?.usageMetadata;
    const usage = um ? { prompt_tokens: Number(um.promptTokenCount) || 0, completion_tokens: Number(um.candidatesTokenCount) || 0, total_tokens: Number(um.totalTokenCount) || ((Number(um.promptTokenCount) || 0) + (Number(um.candidatesTokenCount) || 0)) } : null;
    return { rawMsg: parts.length ? { role: 'assistant', content: rawContent || null, ...(toolCalls.length ? { tool_calls: mapToolCalls(toolCalls) } : {}) } : null, rawContent, toolCalls, usage, model: payload?.modelVersion || targetModel };
  }
  if (family === 'anthropic') {
    const blocks = Array.isArray(payload?.content) ? payload.content : [];
    const textParts = []; const toolCalls = [];
    blocks.forEach((b, idx) => {
      if (b?.type === 'text' && typeof b.text === 'string') textParts.push(b.text);
      if (b?.type === 'tool_use' && b.name) { const a = safeJsonObject(b.input); toolCalls.push({ id: String(b.id || `call_${idx + 1}`), type: 'function', name: String(b.name).trim(), argumentsRaw: JSON.stringify(a), arguments: a }); }
    });
    const rawContent = textParts.join(''); const u = payload?.usage;
    const usage = u ? { prompt_tokens: Number(u.input_tokens) || 0, completion_tokens: Number(u.output_tokens) || 0, total_tokens: (Number(u.input_tokens) || 0) + (Number(u.output_tokens) || 0) } : null;
    return { rawMsg: blocks.length ? { role: 'assistant', content: rawContent || null, ...(toolCalls.length ? { tool_calls: mapToolCalls(toolCalls) } : {}) } : null, rawContent, toolCalls, usage, model: payload?.model || targetModel };
  }
  if (family === 'ollama') {
    const rawMsg = payload?.message || null;
    const rawContent = rawMsg?.content != null ? String(rawMsg.content) : (payload?.response != null ? String(payload.response) : '');
    const usage = (payload?.prompt_eval_count != null || payload?.eval_count != null) ? { prompt_tokens: Number(payload?.prompt_eval_count) || 0, completion_tokens: Number(payload?.eval_count) || 0, total_tokens: (Number(payload?.prompt_eval_count) || 0) + (Number(payload?.eval_count) || 0) } : null;
    return { rawMsg, rawContent, toolCalls: parseToolCalls(rawMsg?.tool_calls), usage, model: payload?.model || targetModel };
  }
  const rawMsg = payload?.choices?.[0]?.message || null;
  return { rawMsg, rawContent: rawMsg?.content != null ? String(rawMsg.content) : '', toolCalls: parseToolCalls(rawMsg?.tool_calls), usage: payload?.usage || null, model: payload?.model || targetModel };
}

async function callConfiguredLlm({ db, env = process.env, serviceName, messages = [], model, temperature = 0.2, maxTokens = 1600, responseFormat = 'json', tools, toolChoice, tool_choice, timeoutMs = 15000, fetchImpl, lookupImpl, connectorVault } = {}) {
  const service = await resolveActiveLlmService(db, env, { serviceName });
  if (!service.configured) return { ok: false, mode: 'unconfigured', reason: service.reason };
  const fetchFn = fetchImpl || globalThis.fetch;
  const isMockTransport = typeof fetchImpl === 'function' && fetchImpl !== globalThis.fetch;
  let piiRedactedCount = 0;
  const redactedMessages = (Array.isArray(messages) ? messages : []).map((m) => { const r = normalizeLlmMessage(m); piiRedactedCount += r.count; return r.msg; });
  const targetModel = String(model || service.modelName || 'ag/gemini-3.8-flash').trim();
  const reqSpec = buildProviderRequest({ provider: service.provider, baseURL: service.baseURL, apiKey: service.apiKey, model: targetModel, messages: redactedMessages, temperature, maxTokens, responseFormat, tools: normalizeToolDefs(tools), toolChoice: toolChoice !== undefined ? toolChoice : tool_choice });
  await assertSafeLlmUrl(reqSpec.endpointUrl, { env, connectorVault, lookupImpl, allowExplicitHost: service.allowExplicitHost || null, skipDnsCheck: isMockTransport && typeof lookupImpl !== 'function' });
  if (typeof fetchFn !== 'function') return { ok: false, mode: 'error', code: 'LLM_FETCH_UNAVAILABLE', reason: 'HTTP fetch unavailable' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, Math.min(120000, Number(timeoutMs) || 15000)));
  try {
    const response = await fetchFn(reqSpec.endpointUrl, { method: 'POST', redirect: 'error', signal: controller.signal, headers: reqSpec.headers, body: JSON.stringify(reqSpec.body) });
    if (!response?.ok) {
      const errBody = typeof response?.text === 'function' ? await response.text().catch(() => '') : '';
      return { ok: false, mode: 'error', code: `LLM_HTTP_${response?.status || 'ERR'}`, reason: scrubSecretText(errBody || `LLM HTTP ${response?.status || 'error'}`, service.apiKey) };
    }
    const payload = await response.json();
    const parsed = parseProviderResponse(reqSpec.family, payload, targetModel);
    let parsedJson = null;
    if (responseFormat === 'json' && parsed.rawContent.trim()) { try { parsedJson = stripUnsafeKeys(JSON.parse(stripJsonFence(parsed.rawContent))); } catch { parsedJson = null; } }
    return { ok: true, mode: 'llm', content: parsed.rawContent, parsedJson, toolCalls: parsed.toolCalls, message: parsed.rawMsg ? stripUnsafeKeys(parsed.rawMsg) : null, usage: parsed.usage, model: parsed.model, piiRedactedCount, raw: payload };
  } catch (err) {
    return { ok: false, mode: 'error', code: err?.name === 'AbortError' ? 'LLM_TIMEOUT' : (err?.code || 'LLM_REQUEST_FAILED'), reason: scrubSecretText(err?.message || 'LLM request failed', service.apiKey) };
  } finally { clearTimeout(timer); }
}

module.exports = { EXPLICIT_LOCAL_LLM_HOSTS, normalizeProviderFamily, resolveDefaultBaseUrlForProvider, buildProviderRequest, parseProviderResponse, resolveActiveLlmService, assertSafeLlmUrl, isMetadataTarget, redactPiiForLlm, callConfiguredLlm };
