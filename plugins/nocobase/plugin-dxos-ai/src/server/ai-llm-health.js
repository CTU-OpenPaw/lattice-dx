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
const fs = require('node:fs');
const net = require('node:net');
const { recordAiAuditLog, resolveDefaultOrganizationId } = require('./ai-schemas');
const { val, rebindStarterAgentsToService } = require('./ai-sync');
const { ADMIN_BUILDER_TOOL_NAMES, failTool, resolveActorScope } = require('./ai-tools-core');
const { runWithSystemRlsBypass } = require('./ai-rls');

async function ensureLocalLlmServiceRecord(db, env = process.env) {
  const llmRepo = db?.getRepository?.('llmServices');
  if (!llmRepo) {
    return { configured: false, skipped: true, reason: 'llmServices repository unavailable' };
  }
  const apiKey = String(env?.AGENT_API_KEY || env?.NINE_ROUTER_API_KEY || '').trim();
  const baseURL = String(env?.AGENT_BASE_URL || 'http://host.docker.internal:20128/v1').trim();
  const existing = await llmRepo.findOne({ filter: { name: 'local-9router' } });
  if (!apiKey && !existing) {
    return {
      configured: false,
      skipped: true,
      reason: 'AGENT_API_KEY env var not set; configure API key via LLM Services or AGENT_API_KEY.',
    };
  }
  const values = {
    name: 'local-9router',
    title: 'Local 9router (OpenAI-compatible)',
    provider: 'openai-completions',
    enabledModels: {
      mode: 'custom',
      models: [
        { label: 'ag/gemini-3.8-flash (9router)', value: 'ag/gemini-3.8-flash' },
        { label: 'combo (9router auto-route)', value: 'combo' },
      ],
    },
    enabled: true,
    ...(apiKey ? { options: { baseURL, apiKey } } : {}),
  };
  if (existing && typeof existing.update === 'function') {
    await existing.update(values);
  } else {
    await llmRepo.create({ values });
  }
  return { configured: true, skipped: false, serviceName: 'local-9router', baseURL };
}

const QUICK_CONNECT_PROVIDER_PRESETS = Object.freeze({
  openai: {
    storedProvider: 'openai',
    defaultServiceName: 'quick-openai',
    defaultTitle: 'OpenAI (Quick-Connect)',
    defaultBaseURL: 'https://api.openai.com/v1',
    defaultModelName: 'gpt-4o-mini',
    requireKey: true,
  },
  'openai-completions': {
    storedProvider: 'openai-completions',
    defaultServiceName: 'quick-openai-completions',
    defaultTitle: 'OpenAI-compatible (Quick-Connect)',
    defaultBaseURL: 'http://127.0.0.1:20128/v1',
    defaultModelName: 'ag/gemini-3.8-flash',
    requireKey: true,
  },
  '9router': {
    storedProvider: 'openai-completions',
    defaultServiceName: 'local-9router',
    defaultTitle: 'Local 9router (OpenAI-compatible)',
    defaultBaseURL: 'http://127.0.0.1:20128/v1',
    defaultModelName: 'ag/gemini-3.8-flash',
    requireKey: true,
  },
  'google-genai': {
    storedProvider: 'google-genai',
    defaultServiceName: 'quick-google-genai',
    defaultTitle: 'Google Gemini (Quick-Connect)',
    defaultBaseURL: 'https://generativelanguage.googleapis.com',
    defaultModelName: 'gemini-2.5-flash',
    requireKey: true,
  },
  anthropic: {
    storedProvider: 'anthropic',
    defaultServiceName: 'quick-anthropic',
    defaultTitle: 'Anthropic Claude (Quick-Connect)',
    defaultBaseURL: 'https://api.anthropic.com/v1',
    defaultModelName: 'claude-3-5-sonnet-latest',
    requireKey: true,
  },
  deepseek: {
    storedProvider: 'deepseek',
    defaultServiceName: 'quick-deepseek',
    defaultTitle: 'DeepSeek (Quick-Connect)',
    defaultBaseURL: 'https://api.deepseek.com/v1',
    defaultModelName: 'deepseek-chat',
    requireKey: true,
  },
  ollama: {
    storedProvider: 'ollama',
    defaultServiceName: 'quick-ollama',
    defaultTitle: 'Ollama Local (Quick-Connect)',
    defaultBaseURL: 'http://127.0.0.1:11434',
    defaultModelName: 'llama3.1',
    requireKey: false,
  },
});

const QUICK_CONNECT_LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', 'host.docker.internal']);
const QUICK_CONNECT_LOCAL_CAPABLE_PROVIDERS = new Set(['ollama', '9router', 'openai-completions']);
const DEFAULT_LOCAL_LLM_PORTS = new Set([11434, 20128, 1234, 8000]);
const QUICK_CONNECT_SERVICE_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/;
const QUICK_CONNECT_PRIVATE_IPV4_RE = /^(?:0\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+|127\.\d+\.\d+\.\d+|169\.254\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+)$/;
const QUICK_CONNECT_META_HOSTS = new Set(['metadata.google.internal', 'metadata.azure.com', '169.254.169.254', '100.100.100.200']);

function resolveAllowedLocalLlmPorts(env = process.env) {
  const ports = new Set(DEFAULT_LOCAL_LLM_PORTS);
  const raw = String(env?.DXOS_LOCAL_LLM_PORTS || '').trim();
  if (raw) {
    for (const token of raw.split(',')) {
      const n = Number.parseInt(token.trim(), 10);
      if (Number.isInteger(n) && n >= 1 && n <= 65535) {
        ports.add(n);
      }
    }
  }
  return ports;
}

function isPrivateOrReservedIpv4(ip) {
  if (!net.isIPv4(ip)) return false;
  if (QUICK_CONNECT_PRIVATE_IPV4_RE.test(ip)) return true;
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function parseIpv6Hextets(rawIp) {
  const ip = String(rawIp || '').trim().toLowerCase().split('%')[0].replace(/^\[|\]$/g, '');
  if (!ip || !net.isIPv6(ip)) return null;
  const dblIdx = ip.indexOf('::');
  if (dblIdx !== -1 && ip.indexOf('::', dblIdx + 2) !== -1) return null;

  const parseSide = (side, allowIpv4Tail) => {
    if (!side) return [];
    const parts = side.split(':');
    const out = [];
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      if (!part) return null;
      if (part.includes('.')) {
        if (!allowIpv4Tail || i !== parts.length - 1 || !net.isIPv4(part)) return null;
        const octets = part.split('.').map(Number);
        if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
        out.push(((octets[0] << 8) | octets[1]) & 0xffff);
        out.push(((octets[2] << 8) | octets[3]) & 0xffff);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
        out.push(parseInt(part, 16) & 0xffff);
      }
    }
    return out;
  };

  if (dblIdx === -1) {
    const hextets = parseSide(ip, true);
    return hextets && hextets.length === 8 ? hextets : null;
  }

  const leftStr = ip.slice(0, dblIdx);
  const rightStr = ip.slice(dblIdx + 2);
  const left = parseSide(leftStr, !rightStr);
  const right = parseSide(rightStr, true);
  if (!left || !right) return null;
  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;
  return [...left, ...new Array(missing).fill(0), ...right];
}

function hextetsToIpv4(hi, lo) {
  return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
}

function isPrivateOrReservedIp(rawIp) {
  const ip = String(rawIp || '').trim().toLowerCase().split('%')[0].replace(/^\[|\]$/g, '');
  if (!ip) return true;
  if (net.isIPv4(ip)) return isPrivateOrReservedIpv4(ip);
  if (net.isIPv6(ip)) {
    const h = parseIpv6Hextets(ip);
    if (!h) return true;
    // ::/128 (unspecified / all zeros)
    if (h.every((x) => x === 0)) return true;
    // ::1/128 (loopback)
    if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0 && h[6] === 0 && h[7] === 1) return true;
    // ::ffff:0:0/96 (IPv4-mapped IPv6)
    if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0xffff) {
      return isPrivateOrReservedIpv4(hextetsToIpv4(h[6], h[7]));
    }
    // ::/96 (legacy IPv4-compatible IPv6)
    if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0) {
      return isPrivateOrReservedIpv4(hextetsToIpv4(h[6], h[7]));
    }
    // 64:ff9b::/96 (NAT64 well-known prefix)
    if (h[0] === 0x0064 && h[1] === 0xff9b && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0) {
      return isPrivateOrReservedIpv4(hextetsToIpv4(h[6], h[7]));
    }
    // 100::/64 (discard-only)
    if (h[0] === 0x0100 && h[1] === 0 && h[2] === 0 && h[3] === 0) return true;
    // 2001:db8::/32 (documentation)
    if (h[0] === 0x2001 && h[1] === 0x0db8) return true;
    // 2002::/16 (6to4 if embedded IPv4 is private/reserved)
    if (h[0] === 0x2002) {
      return isPrivateOrReservedIpv4(hextetsToIpv4(h[1], h[2]));
    }
    // fc00::/7 (ULA)
    if ((h[0] & 0xfe00) === 0xfc00) return true;
    // fe80::/10 (link-local, fe80..febf)
    if ((h[0] & 0xffc0) === 0xfe80) return true;
    // fec0::/10 (deprecated site-local)
    if ((h[0] & 0xffc0) === 0xfec0) return true;
    // ff00::/8 (multicast)
    if ((h[0] & 0xff00) === 0xff00) return true;
    return false;
  }
  return true;
}

async function assertSafeLlmProbeUrl(rawUrl, { provider = '', env = process.env, lookupImpl, allowDnsLookup = true } = {}) {
  const cleanUrl = validateQuickConnectBaseUrl(rawUrl, { provider, env });
  const parsed = new URL(cleanUrl);
  const bare = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (QUICK_CONNECT_LOCAL_HOSTS.has(bare)) {
    return cleanUrl;
  }
  if (net.isIP(bare)) {
    if (isPrivateOrReservedIp(bare)) {
      throw failTool('LLM_URL_UNSAFE', 400, `Địa chỉ IP nội bộ/không công khai "${bare}" bị chặn bởi chính sách SSRF.`);
    }
    return cleanUrl;
  }
  if (!allowDnsLookup) {
    return cleanUrl;
  }
  const doLookup = typeof lookupImpl === 'function'
    ? lookupImpl
    : (dns?.promises?.lookup ? dns.promises.lookup.bind(dns.promises) : null);
  if (typeof doLookup === 'function') {
    let resolved;
    try {
      resolved = await doLookup(bare, { all: true });
    } catch (err) {
      throw failTool('LLM_URL_UNSAFE', 400, `Không phân giải được DNS an toàn cho "${bare}": ${err?.code || err?.message || 'DNS error'}`);
    }
    const records = Array.isArray(resolved) ? resolved : (resolved ? [resolved] : []);
    if (!records.length) {
      throw failTool('LLM_URL_UNSAFE', 400, `Không có bản ghi DNS hợp lệ cho "${bare}".`);
    }
    for (const rec of records) {
      const addr = typeof rec === 'string' ? rec : rec?.address;
      if (!addr || isPrivateOrReservedIp(addr)) {
        throw failTool('LLM_URL_UNSAFE', 400, `Tên miền "${bare}" phân giải về địa chỉ IP nội bộ/metadata bị chặn (SSRF).`);
      }
    }
  }
  return cleanUrl;
}

function validateQuickConnectBaseUrl(rawUrl, { provider = '', env = process.env } = {}) {
  const str = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!str || str.length > 2048 || /[\u0000-\u001f\u007f\s]/.test(str)) {
    throw failTool('LLM_URL_UNSAFE', 400, 'baseURL không hợp lệ.');
  }
  let parsed;
  try {
    parsed = new URL(str);
  } catch {
    throw failTool('LLM_URL_UNSAFE', 400, 'Định dạng baseURL không hợp lệ.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw failTool('LLM_URL_UNSAFE', 400, 'Chỉ hỗ trợ giao thức http:// hoặc https:// cho LLM baseURL.');
  }
  if (parsed.username || parsed.password) {
    throw failTool('LLM_URL_UNSAFE', 400, 'Không được nhúng username/password trong LLM baseURL.');
  }
  const authMatch = str.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]+)/);
  const rawAuthority = authMatch ? authMatch[1] : '';
  const rawHost = rawAuthority.startsWith('[')
    ? rawAuthority.slice(0, rawAuthority.indexOf(']') + 1)
    : rawAuthority.split(':')[0];
  const bare = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  const rawBare = String(rawHost || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!bare || !rawBare) {
    throw failTool('LLM_URL_UNSAFE', 400, 'baseURL thiếu hostname hợp lệ.');
  }
  if (/^(?:\d+|0x[0-9a-f]+)$/i.test(rawBare) || /(?:^|\.)0\d+/.test(rawBare)) {
    throw failTool('LLM_URL_UNSAFE', 400, 'Hostname dạng số/hex/octal không được phép.');
  }
  if (QUICK_CONNECT_META_HOSTS.has(bare) || QUICK_CONNECT_META_HOSTS.has(rawBare) || /^169\.254\./.test(bare)) {
    throw failTool('LLM_URL_UNSAFE', 400, 'Chặn truy cập địa chỉ metadata nội bộ.');
  }
  const isLocalHost = QUICK_CONNECT_LOCAL_HOSTS.has(bare);
  let isLocalAllowed = false;
  if (isLocalHost) {
    const normalizedProvider = String(provider || '').trim().toLowerCase();
    if (!QUICK_CONNECT_LOCAL_CAPABLE_PROVIDERS.has(normalizedProvider)) {
      throw failTool(
        'SSRF_TARGET_FORBIDDEN',
        400,
        `Nhà cung cấp "${normalizedProvider || '(không xác định)'}" không được phép kết nối tới địa chỉ nội bộ/loopback (SSRF).`,
      );
    }
    const portNum = parsed.port
      ? Number.parseInt(parsed.port, 10)
      : (parsed.protocol === 'https:' ? 443 : 80);
    const allowedPorts = resolveAllowedLocalLlmPorts(env);
    if (!Number.isInteger(portNum) || !allowedPorts.has(portNum)) {
      throw failTool(
        'SSRF_TARGET_FORBIDDEN',
        400,
        `Cổng "${portNum}" trên địa chỉ nội bộ "${bare}" không nằm trong danh sách cổng suy luận LLM được phép (SSRF).`,
      );
    }
    isLocalAllowed = true;
  }
  if (!isLocalAllowed) {
    if (bare.endsWith('.localhost') || bare.endsWith('.local') || bare.endsWith('.internal')) {
      throw failTool('LLM_URL_UNSAFE', 400, `Tên miền nội bộ "${bare}" bị chặn bởi chính sách SSRF.`);
    }
    if (bare.includes(':')) {
      throw failTool('LLM_URL_UNSAFE', 400, 'Địa chỉ IPv6 nội bộ/không công khai bị chặn.');
    }
    if (net.isIPv4(bare) && isPrivateOrReservedIpv4(bare)) {
      throw failTool('LLM_URL_UNSAFE', 400, `Địa chỉ IP nội bộ/không công khai "${bare}" bị chặn bởi chính sách SSRF.`);
    }
    if (!bare.includes('.')) {
      throw failTool('LLM_URL_UNSAFE', 400, 'Hostname không đầy đủ (non-FQDN) bị chặn.');
    }
    if (parsed.protocol !== 'https:') {
      throw failTool('LLM_URL_UNSAFE', 400, 'Nhà cung cấp LLM bên ngoài phải dùng https://.');
    }
  }
  return parsed.toString().replace(/\/+$/, '');
}

function buildLlmProbeTarget(provider, rawBase, apiKey) {
  const lower = String(provider || '').trim().toLowerCase();
  let base = String(rawBase || '').trim().replace(/\/+$/, '');
  if (!base) {
    if (lower.includes('ollama')) base = 'http://127.0.0.1:11434';
    else if (lower.includes('gemini') || lower.includes('google')) base = 'https://generativelanguage.googleapis.com';
    else if (lower.includes('anthropic')) base = 'https://api.anthropic.com/v1';
    else if (lower.includes('deepseek') && apiKey) base = 'https://api.deepseek.com/v1';
    else if (lower.includes('openai') && apiKey) base = 'https://api.openai.com/v1';
  }
  if (!base) return null;
  if (lower.includes('ollama')) {
    return { baseURL: base, probeUrl: `${base.replace(/\/v1$/i, '')}/api/tags`, headers: {} };
  }
  if (lower.includes('gemini') || lower.includes('google')) {
    const probeUrl = base.endsWith('/v1beta/models')
      ? base
      : (base.endsWith('/v1beta') ? `${base}/models` : `${base}/v1beta/models`);
    return { baseURL: base, probeUrl, headers: apiKey ? { 'x-goog-api-key': apiKey } : {} };
  }
  if (lower.includes('anthropic')) {
    const probeUrl = base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`;
    return {
      baseURL: base,
      probeUrl,
      headers: {
        ...(apiKey ? { 'x-api-key': apiKey } : {}),
        'anthropic-version': '2023-06-01',
      },
    };
  }
  return {
    baseURL: base,
    probeUrl: `${base}/models`,
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  };
}

async function probeLlmHealth(db, { env = process.env, fetchImpl, lookupImpl, isAdmin = false, llmServiceName = '', modelName = '', verifyCompletion = false } = {}) {
  const resultBase = (fields) => ({
    ok: Boolean(fields.ok),
    status: Number(fields.status) || 503,
    code: String(fields.code || 'LLM_UNAVAILABLE'),
    llmService: String(fields.llmService || ''),
    modelName: String(fields.modelName || ''),
    provider: String(fields.provider || ''),
    message: String(fields.message || ''),
    ...(fields.completionChecked ? { completionChecked: true } : {}),
    ...(isAdmin && fields.baseURL !== undefined ? { baseURL: String(fields.baseURL || '') } : {}),
  });

  const classifyHttpFailure = (status, { serviceName, boundModel, provider, baseURL, completionChecked = false }) => {
    if (status === 401 || status === 403) {
      return resultBase({
        ok: false,
        status,
        code: 'LLM_AUTH_ERROR',
        llmService: serviceName,
        modelName: boundModel,
        provider,
        baseURL,
        completionChecked,
        message: `Dịch vụ LLM "${serviceName}" từ chối xác thực (HTTP ${status}). Kiểm tra lại API key.`,
      });
    }
    if (status === 502) {
      return resultBase({
        ok: false,
        status: 502,
        code: 'LLM_BAD_GATEWAY',
        llmService: serviceName,
        modelName: boundModel,
        provider,
        baseURL,
        completionChecked,
        message: `Upstream LLM gateway "${serviceName}" lỗi 502 Bad Gateway.`,
      });
    }
    if (status === 504) {
      return resultBase({
        ok: false,
        status: 504,
        code: 'LLM_TIMEOUT',
        llmService: serviceName,
        modelName: boundModel,
        provider,
        baseURL,
        completionChecked,
        message: `Upstream LLM "${serviceName}" quá thời gian phản hồi (HTTP 504).`,
      });
    }
    return resultBase({
      ok: false,
      status,
      code: 'LLM_UNAVAILABLE',
      llmService: serviceName,
      modelName: boundModel,
      provider,
      baseURL,
      completionChecked,
      message: `Dịch vụ LLM "${serviceName}" không khả dụng (HTTP ${status}).`,
    });
  };

  let boundService = String(llmServiceName || '').trim();
  let boundModel = String(modelName || '').trim();
  if (!boundService || !boundModel) {
    await runWithSystemRlsBypass(db, async () => {
      const profRepo = db?.getRepository?.('latticeAiProfiles');
      const profRow = profRepo && typeof profRepo.findOne === 'function'
        ? await profRepo.findOne({ filter: { username: 'dxos-architect' } }).catch(() => null)
        : null;
      const empRepo = db?.getRepository?.('aiEmployees');
      const empRow = (!profRow && empRepo && typeof empRepo.findOne === 'function')
        ? await empRepo.findOne({ filter: { username: 'dxos-architect' } }).catch(() => null)
        : null;
      const empModels = val(empRow, 'modelSettings')?.models;
      const firstEmpModel = Array.isArray(empModels) ? empModels[0] : null;
      if (!boundService) {
        boundService = String(val(profRow, 'llmService') || firstEmpModel?.llmService || 'local-9router').trim();
      }
      if (!boundModel) {
        boundModel = String(val(profRow, 'modelName') || firstEmpModel?.model || 'ag/gemini-3.8-flash').trim();
      }
    });
  }

  const llmRepo = db?.getRepository?.('llmServices');
  if (!llmRepo) {
    return resultBase({
      ok: false,
      status: 503,
      code: 'NO_LLM_SERVICE',
      llmService: boundService,
      modelName: boundModel,
      provider: '',
      message: 'Chưa cấu hình dịch vụ LLM (llmServices repository unavailable).',
    });
  }

  const llmRow = await runWithSystemRlsBypass(db, async () => {
    if (boundService && typeof llmRepo.findOne === 'function') {
      const exact = await llmRepo.findOne({ filter: { name: boundService } }).catch(() => null);
      if (exact) return exact;
    }
    if (!llmServiceName && typeof llmRepo.find === 'function') {
      const rows = (await llmRepo.find({ filter: { enabled: true }, limit: 1 }).catch(() => [])) || [];
      return rows[0] || null;
    }
    return null;
  });

  if (!llmRow) {
    return resultBase({
      ok: false,
      status: 503,
      code: 'NO_LLM_SERVICE',
      llmService: boundService,
      modelName: boundModel,
      provider: '',
      message: 'Chưa kết nối dịch vụ LLM cho AI Architect. Vui lòng nhập API key trong DX-OS AI Studio.',
      baseURL: '',
    });
  }

  const serviceName = String(val(llmRow, 'name') || boundService || '').trim();
  const provider = String(val(llmRow, 'provider') || val(llmRow, 'type') || 'openai-completions').trim();
  if (val(llmRow, 'enabled') === false) {
    return resultBase({
      ok: false,
      status: 503,
      code: 'LLM_UNAVAILABLE',
      llmService: serviceName,
      modelName: boundModel,
      provider,
      message: `Dịch vụ LLM "${serviceName}" đang bị tắt (disabled).`,
    });
  }

  const options = val(llmRow, 'options') && typeof val(llmRow, 'options') === 'object' ? val(llmRow, 'options') : {};
  const rawBase = String(options.baseURL || val(llmRow, 'baseURL') || '').trim();
  const apiKey = String(options.apiKey || val(llmRow, 'apiKey') || '').trim();
  const target = buildLlmProbeTarget(provider, rawBase, apiKey);
  if (!target) {
    return resultBase({
      ok: false,
      status: 503,
      code: 'NO_LLM_SERVICE',
      llmService: serviceName,
      modelName: boundModel,
      provider,
      message: `Dịch vụ LLM "${serviceName}" thiếu baseURL hoặc API key hợp lệ.`,
      baseURL: '',
    });
  }
  try {
    await assertSafeLlmProbeUrl(target.baseURL, {
      provider,
      env,
      lookupImpl,
      allowDnsLookup: !fetchImpl || typeof lookupImpl === 'function',
    });
  } catch (err) {
    return resultBase({
      ok: false,
      status: Number(err?.status) || 400,
      code: String(err?.code || 'LLM_URL_UNSAFE'),
      llmService: serviceName,
      modelName: boundModel,
      provider,
      baseURL: target.baseURL,
      message: err?.message || `baseURL của dịch vụ LLM "${serviceName}" không hợp lệ.`,
    });
  }

  const doFetch = fetchImpl || (typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function' ? globalThis.fetch : null);
  if (typeof doFetch !== 'function') {
    return resultBase({
      ok: false,
      status: 503,
      code: 'LLM_UNAVAILABLE',
      llmService: serviceName,
      modelName: boundModel,
      provider,
      baseURL: target.baseURL,
      message: 'Môi trường không hỗ trợ HTTP fetch để kiểm tra LLM.',
    });
  }

  const createTimeoutSignal = (ms) => {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      return { signal: AbortSignal.timeout(ms), clear: () => {} };
    }
    if (typeof AbortController === 'function') {
      const c = new AbortController();
      const tid = setTimeout(() => c.abort(), ms);
      if (typeof tid?.unref === 'function') tid.unref();
      return { signal: c.signal, clear: () => clearTimeout(tid) };
    }
    return { signal: null, clear: () => {} };
  };

  let clearModelsTimer = () => {};
  let clearCompTimer = () => {};
  let completionProbeStarted = false;
  try {
    const modelsTimeout = createTimeoutSignal(5000);
    clearModelsTimer = modelsTimeout.clear;
    const res = await doFetch(target.probeUrl, {
      method: 'GET',
      headers: target.headers,
      redirect: 'error',
      ...(modelsTimeout.signal ? { signal: modelsTimeout.signal } : {}),
    });
    if (res?.redirected || (Number(res?.status) >= 300 && Number(res?.status) < 400)) {
      return resultBase({
        ok: false,
        status: 400,
        code: 'LLM_URL_UNSAFE',
        llmService: serviceName,
        modelName: boundModel,
        provider,
        baseURL: target.baseURL,
        message: `Dịch vụ LLM "${serviceName}" chuyển hướng HTTP không được phép (SSRF redirect blocked).`,
      });
    }
    const status = Number(res?.status) || (res?.ok ? 200 : 503);
    if (!res?.ok) {
      return classifyHttpFailure(status, { serviceName, boundModel, provider, baseURL: target.baseURL });
    }

    const lowerProv = provider.toLowerCase();
    const isGemini = lowerProv.includes('gemini') || lowerProv.includes('google');
    const isAnthropic = lowerProv.includes('anthropic') || lowerProv.includes('claude');
    const isOllama = lowerProv.includes('ollama');
    const isOpenAiCompat = lowerProv.includes('openai') || lowerProv.includes('deepseek') || lowerProv.includes('9router');

    if (verifyCompletion && boundModel && (isOpenAiCompat || isGemini || isAnthropic || isOllama)) {
      completionProbeStarted = true;
      const compTimeout = createTimeoutSignal(8000);
      clearCompTimer = compTimeout.clear;
      let compUrl = `${target.baseURL}/chat/completions`;
      let compBody = {
        model: boundModel,
        messages: [{ role: 'user', content: 'ok' }],
        max_tokens: 4,
        temperature: 0,
      };
      if (isGemini) {
        const prefix = target.baseURL.endsWith('/v1beta')
          ? target.baseURL
          : (target.baseURL.endsWith('/v1beta/models') ? target.baseURL.replace(/\/models$/, '') : `${target.baseURL}/v1beta`);
        compUrl = `${prefix}/models/${encodeURIComponent(boundModel)}:generateContent`;
        compBody = {
          contents: [{ role: 'user', parts: [{ text: 'ok' }] }],
          generationConfig: { maxOutputTokens: 4, temperature: 0 },
        };
      } else if (isAnthropic) {
        compUrl = target.baseURL.endsWith('/messages')
          ? target.baseURL
          : (target.baseURL.endsWith('/v1') ? `${target.baseURL}/messages` : `${target.baseURL}/v1/messages`);
        compBody = {
          model: boundModel,
          max_tokens: 4,
          temperature: 0,
          messages: [{ role: 'user', content: 'ok' }],
        };
      } else if (isOllama && !/\/v1$/i.test(target.baseURL) && !/\/chat\/completions$/i.test(target.baseURL)) {
        compUrl = `${target.baseURL.replace(/\/api\/?$/, '')}/api/chat`;
        compBody = {
          model: boundModel,
          messages: [{ role: 'user', content: 'ok' }],
          stream: false,
          options: { num_predict: 4, temperature: 0 },
        };
      }
      const compRes = await doFetch(compUrl, {
        method: 'POST',
        headers: { ...target.headers, 'content-type': 'application/json' },
        body: JSON.stringify(compBody),
        redirect: 'error',
        ...(compTimeout.signal ? { signal: compTimeout.signal } : {}),
      });
      if (compRes?.redirected || (Number(compRes?.status) >= 300 && Number(compRes?.status) < 400)) {
        return resultBase({
          ok: false,
          status: 400,
          code: 'LLM_URL_UNSAFE',
          llmService: serviceName,
          modelName: boundModel,
          provider,
          baseURL: target.baseURL,
          completionChecked: true,
          message: `Dịch vụ LLM "${serviceName}" chuyển hướng HTTP không được phép (SSRF redirect blocked).`,
        });
      }
      const compStatus = Number(compRes?.status) || (compRes?.ok ? 200 : 503);
      if (!compRes?.ok) {
        return classifyHttpFailure(compStatus, {
          serviceName,
          boundModel,
          provider,
          baseURL: target.baseURL,
          completionChecked: true,
        });
      }
      return resultBase({
        ok: true,
        status: compStatus,
        code: 'OK',
        llmService: serviceName,
        modelName: boundModel,
        provider,
        baseURL: target.baseURL,
        completionChecked: true,
        message: `Dịch vụ LLM "${serviceName}" (${boundModel}) sẵn sàng.`,
      });
    }

    return resultBase({
      ok: true,
      status,
      code: 'OK',
      llmService: serviceName,
      modelName: boundModel,
      provider,
      baseURL: target.baseURL,
      message: `Dịch vụ LLM "${serviceName}" sẵn sàng.`,
    });
  } catch (err) {
    const msgChain = `${err?.message || ''} ${err?.cause?.message || ''}`;
    const isRedirectErr = /redirect/i.test(msgChain) || err?.code === 'LLM_URL_UNSAFE';
    if (isRedirectErr) {
      return resultBase({
        ok: false,
        status: 400,
        code: 'LLM_URL_UNSAFE',
        llmService: serviceName,
        modelName: boundModel,
        provider,
        baseURL: target.baseURL,
        ...(completionProbeStarted ? { completionChecked: true } : {}),
        message: `Chuyển hướng HTTP hoặc đích mạng không an toàn khi kiểm tra LLM "${serviceName}".`,
      });
    }
    const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError' || /timeout|aborted/i.test(String(err?.message || ''));
    return resultBase({
      ok: false,
      status: isTimeout ? 504 : 503,
      code: isTimeout ? 'LLM_TIMEOUT' : 'LLM_UNAVAILABLE',
      llmService: serviceName,
      modelName: boundModel,
      provider,
      baseURL: target.baseURL,
      ...(completionProbeStarted ? { completionChecked: true } : {}),
      message: isTimeout
        ? `Kết nối tới dịch vụ LLM "${serviceName}" quá thời gian chờ.`
        : `Không thể kết nối tới dịch vụ LLM "${serviceName}": ${String(err?.code || err?.message || 'network error').slice(0, 140)}`,
    });
  } finally {
    clearModelsTimer();
    clearCompTimer();
  }
}

async function runQuickConnectLlm(targetDb, ctx, { env = process.env, fetchImpl, readActionPayload }) {
  const actorUser = ctx?.state?.currentUser || ctx?.auth?.user;
  const actorScope = await resolveActorScope(ctx, targetDb).catch(() => null);
  const organizationId = await resolveDefaultOrganizationId(targetDb, { actor: actorScope, ctx, env, fallback: '' });
  const payload = readActionPayload(ctx);

  const rawProvider = String(payload.provider || '').trim().toLowerCase();
  const preset = QUICK_CONNECT_PROVIDER_PRESETS[rawProvider];
  if (!preset) {
    throw failTool(
      'LLM_PROVIDER_UNSUPPORTED',
      400,
      `Provider "${rawProvider || '(trống)'}" không được hỗ trợ. Hỗ trợ: openai, openai-completions, google-genai, anthropic, deepseek, ollama, 9router.`,
    );
  }

  const apiKey = String(payload.apiKey || '').trim();
  if (preset.requireKey && !apiKey) {
    throw failTool('LLM_API_KEY_REQUIRED', 400, `Cần nhập API Key cho nhà cung cấp "${rawProvider}".`);
  }

  const isInsideDocker = (() => {
    try { return fs.existsSync('/.dockerenv'); } catch { return false; }
  })();
  const dockerAwareDefault = rawProvider === '9router' && isInsideDocker
    ? 'http://host.docker.internal:20128/v1'
    : preset.defaultBaseURL;
  const fallbackBase = rawProvider === '9router' || rawProvider === 'openai-completions'
    ? (String(env?.AGENT_BASE_URL || '').trim() || dockerAwareDefault)
    : preset.defaultBaseURL;
  const rawBase = String(payload.baseURL || payload.baseUrl || fallbackBase).trim();
  const baseURL = validateQuickConnectBaseUrl(rawBase, { provider: rawProvider, env });

  const serviceName = String(payload.serviceName || preset.defaultServiceName).trim().toLowerCase();
  if (!QUICK_CONNECT_SERVICE_RE.test(serviceName)) {
    throw failTool('LLM_SERVICE_NAME_INVALID', 400, 'serviceName chỉ được gồm 2-63 ký tự [a-z0-9_-].');
  }

  const modelName = String(payload.modelName || preset.defaultModelName).trim();
  if (!modelName) {
    throw failTool('LLM_MODEL_REQUIRED', 400, 'Cần nhập modelName hợp lệ.');
  }
  const serviceTitle = String(payload.title || preset.defaultTitle).trim().slice(0, 120) || serviceName;

  const llmRepo = targetDb?.getRepository?.('llmServices');
  if (!llmRepo) {
    throw failTool('NO_LLM_SERVICE', 503, 'Repository llmServices chưa sẵn sàng.');
  }

  await runWithSystemRlsBypass(targetDb, async (transaction) => {
    const txOpt = transaction ? { transaction } : {};
    const existing = typeof llmRepo.findOne === 'function'
      ? await llmRepo.findOne({ filter: { name: serviceName }, ...txOpt }).catch(() => null)
      : null;
    const existingOpts = existing && typeof val(existing, 'options') === 'object' ? val(existing, 'options') : {};
    const existingEnabledModels = existing && typeof val(existing, 'enabledModels') === 'object' ? val(existing, 'enabledModels') : {};
    const prevModels = Array.isArray(existingEnabledModels?.models) ? existingEnabledModels.models : [];
    const modelEntries = [];
    const seenModels = new Set();
    for (const m of [{ label: `${modelName} (${serviceTitle})`, value: modelName }, ...prevModels]) {
      const mv = typeof m === 'string' ? m.trim() : String(m?.value || m?.model || '').trim();
      if (!mv || seenModels.has(mv)) continue;
      seenModels.add(mv);
      modelEntries.push(typeof m === 'string' ? { label: mv, value: mv } : { label: String(m?.label || mv), value: mv });
    }

    const values = {
      name: serviceName,
      title: serviceTitle,
      provider: preset.storedProvider,
      options: {
        ...(existingOpts || {}),
        baseURL,
        ...(apiKey ? { apiKey } : {}),
      },
      enabledModels: {
        mode: 'custom',
        models: modelEntries,
      },
      enabled: true,
    };
    if (existing && typeof existing.update === 'function') {
      await existing.update(values, txOpt);
    } else {
      await llmRepo.create({ values, ...txOpt });
    }
  });

  const rebindRes = await rebindStarterAgentsToService(targetDb, {
    llmService: serviceName,
    modelName,
    actorUser,
    defaultOrigin: env?.NOCOBASE_INTERNAL_URL || '',
    preserveActiveArchitect: false,
    adminToolNames: ADMIN_BUILDER_TOOL_NAMES,
  });

  const shouldTest = Boolean(payload.testConnection);
  const health = shouldTest
    ? await probeLlmHealth(targetDb, {
      env,
      fetchImpl,
      isAdmin: true,
      llmServiceName: serviceName,
      modelName,
      verifyCompletion: Boolean(payload.verifyCompletion),
    })
    : null;

  await recordAiAuditLog(targetDb, {
    actorUserId: val(actorUser, 'id') ?? null,
    actorUsername: val(actorUser, 'username') || null,
    organizationId: organizationId || null,
    channel: 'studio-sync',
    aiEmployee: 'dxos-architect',
    toolName: 'dxosAi:quickConnectLlm',
    argsSummary: {
      serviceName,
      provider: preset.storedProvider,
      modelName,
      baseURL,
      testConnection: shouldTest,
      hasApiKey: Boolean(apiKey),
    },
    status: 'allowed',
    resultSummary: `Quick-connected LLM ${serviceName} (${preset.storedProvider}/${modelName}); rebound ${rebindRes.reboundAgents.length} starter agents`,
  });

  return {
    service: {
      name: serviceName,
      title: serviceTitle,
      provider: preset.storedProvider,
      modelName,
      baseURL,
      enabled: true,
    },
    reboundAgents: rebindRes.reboundAgents,
    health,
  };
}

function maskApiKey(rawKey) {
  const s = String(rawKey || '').trim();
  if (!s) return '';
  if (s.length <= 4) return '****';
  return `****${s.slice(-4)}`;
}

async function listLlmServices(targetDb) {
  const llmRepo = targetDb?.getRepository?.('llmServices');
  if (!llmRepo || typeof llmRepo.find !== 'function') {
    return { services: [], activeService: null, activeModel: null };
  }
  let rows = [];
  let activeService = '';
  let activeModel = '';
  await runWithSystemRlsBypass(targetDb, async () => {
    rows = (await llmRepo.find({ sort: ['id'], limit: 200 }).catch(() => [])) || [];
    const profRepo = targetDb?.getRepository?.('latticeAiProfiles');
    const archProf = profRepo && typeof profRepo.findOne === 'function'
      ? await profRepo.findOne({ filter: { username: 'dxos-architect' } }).catch(() => null)
      : null;
    if (archProf) {
      activeService = String(val(archProf, 'llmService') || '').trim();
      activeModel = String(val(archProf, 'modelName') || '').trim();
    }
    if (!activeService || !activeModel) {
      const empRepo = targetDb?.getRepository?.('aiEmployees');
      const archEmp = empRepo && typeof empRepo.findOne === 'function'
        ? await empRepo.findOne({ filter: { username: 'dxos-architect' } }).catch(() => null)
        : null;
      const empModel = Array.isArray(val(archEmp, 'modelSettings')?.models) ? val(archEmp, 'modelSettings').models[0] : null;
      if (!activeService) activeService = String(empModel?.llmService || '').trim();
      if (!activeModel) activeModel = String(empModel?.model || '').trim();
    }
  });

  const services = rows.map((row) => {
    const name = String(val(row, 'name') || '').trim();
    const title = String(val(row, 'title') || name).trim();
    const provider = String(val(row, 'provider') || val(row, 'type') || 'openai-completions').trim();
    const options = val(row, 'options') && typeof val(row, 'options') === 'object' ? val(row, 'options') : {};
    const baseURL = String(options.baseURL || val(row, 'baseURL') || '').trim();
    const rawKey = String(options.apiKey || val(row, 'apiKey') || '').trim();
    const enabledModelsObj = val(row, 'enabledModels') && typeof val(row, 'enabledModels') === 'object' ? val(row, 'enabledModels') : {};
    const rawModels = Array.isArray(enabledModelsObj.models) ? enabledModelsObj.models : [];
    const models = rawModels
      .map((m) => (typeof m === 'string'
        ? { label: m, value: m }
        : { label: String(m?.label || m?.value || m?.model || '').trim(), value: String(m?.value || m?.model || '').trim() }))
      .filter((m) => m.value);
    const isArchitectDefault = Boolean(activeService && name && activeService === name);
    return {
      id: val(row, 'id') ?? null,
      name,
      title,
      provider,
      baseURL,
      enabled: val(row, 'enabled') !== false,
      hasApiKey: Boolean(rawKey),
      maskedApiKey: maskApiKey(rawKey),
      models,
      defaultModel: (isArchitectDefault && activeModel) ? activeModel : (models[0]?.value || ''),
      isArchitectDefault,
    };
  });

  return {
    services,
    activeService: activeService || null,
    activeModel: activeModel || null,
  };
}

async function deleteLlmService(targetDb, ctx, { name, env = process.env } = {}) {
  const serviceName = String(name || '').trim().toLowerCase();
  if (!QUICK_CONNECT_SERVICE_RE.test(serviceName)) {
    throw failTool('LLM_SERVICE_NAME_INVALID', 400, 'serviceName không hợp lệ.');
  }
  const llmRepo = targetDb?.getRepository?.('llmServices');
  if (!llmRepo) {
    throw failTool('NO_LLM_SERVICE', 503, 'Repository llmServices chưa sẵn sàng.');
  }
  const actorUser = ctx?.state?.currentUser || ctx?.auth?.user;
  const actorScope = await resolveActorScope(ctx, targetDb).catch(() => null);
  const organizationId = await resolveDefaultOrganizationId(targetDb, { actor: actorScope, ctx, env, fallback: '' });

  let existing = null;
  await runWithSystemRlsBypass(targetDb, async (transaction) => {
    const txOpt = transaction ? { transaction } : {};
    existing = typeof llmRepo.findOne === 'function'
      ? await llmRepo.findOne({ filter: { name: serviceName }, ...txOpt }).catch(() => null)
      : null;
    if (!existing) {
      throw failTool('LLM_SERVICE_NOT_FOUND', 404, `Không tìm thấy dịch vụ LLM "${serviceName}".`);
    }
    if (typeof existing.destroy === 'function') {
      await existing.destroy(txOpt);
    } else if (typeof llmRepo.destroy === 'function') {
      await llmRepo.destroy({ filter: { name: serviceName }, ...txOpt });
    }
  });

  await runWithSystemRlsBypass(targetDb, async (transaction) => {
    const txOpt = transaction ? { transaction } : {};
    const profRepo = targetDb?.getRepository?.('latticeAiProfiles');
    if (profRepo && typeof profRepo.find === 'function') {
      const boundProfs = (await profRepo.find({ filter: { llmService: serviceName }, limit: 200, ...txOpt }).catch(() => [])) || [];
      for (const p of boundProfs) {
        if (typeof p?.update === 'function') {
          await p.update({ llmService: null, modelName: null }, txOpt);
        }
      }
    }
    const empRepo = targetDb?.getRepository?.('aiEmployees');
    if (empRepo && typeof empRepo.find === 'function') {
      const allEmps = (await empRepo.find({ limit: 200, ...txOpt }).catch(() => [])) || [];
      for (const emp of allEmps) {
        const ms = val(emp, 'modelSettings');
        const models = Array.isArray(ms?.models) ? ms.models : [];
        if (models.some((m) => m?.llmService === serviceName)) {
          const remaining = models.filter((m) => m?.llmService !== serviceName);
          if (typeof emp?.update === 'function') {
            await emp.update({ modelSettings: { ...(ms || {}), models: remaining } }, txOpt);
          }
        }
      }
    }
  });

  await recordAiAuditLog(targetDb, {
    actorUserId: val(actorUser, 'id') ?? null,
    actorUsername: val(actorUser, 'username') || null,
    organizationId: organizationId || null,
    channel: 'studio-sync',
    aiEmployee: 'dxos-architect',
    toolName: 'dxosAi:deleteLlmService',
    argsSummary: { serviceName },
    status: 'allowed',
    resultSummary: `Deleted LLM service ${serviceName}`,
  });

  return { deleted: true, name: serviceName };
}

async function switchLlmServiceModel(targetDb, ctx, { name, modelName, env = process.env } = {}) {
  const serviceName = String(name || '').trim().toLowerCase();
  const nextModel = String(modelName || '').trim();
  if (!QUICK_CONNECT_SERVICE_RE.test(serviceName)) {
    throw failTool('LLM_SERVICE_NAME_INVALID', 400, 'serviceName không hợp lệ.');
  }
  if (!nextModel || nextModel.length > 120) {
    throw failTool('LLM_MODEL_REQUIRED', 400, 'Cần modelName hợp lệ (<= 120 ký tự).');
  }
  const llmRepo = targetDb?.getRepository?.('llmServices');
  if (!llmRepo) {
    throw failTool('NO_LLM_SERVICE', 503, 'Repository llmServices chưa sẵn sàng.');
  }
  const actorUser = ctx?.state?.currentUser || ctx?.auth?.user;
  const actorScope = await resolveActorScope(ctx, targetDb).catch(() => null);
  const organizationId = await resolveDefaultOrganizationId(targetDb, { actor: actorScope, ctx, env, fallback: '' });

  await runWithSystemRlsBypass(targetDb, async (transaction) => {
    const txOpt = transaction ? { transaction } : {};
    const existing = typeof llmRepo.findOne === 'function'
      ? await llmRepo.findOne({ filter: { name: serviceName }, ...txOpt }).catch(() => null)
      : null;
    if (!existing) {
      throw failTool('LLM_SERVICE_NOT_FOUND', 404, `Không tìm thấy dịch vụ LLM "${serviceName}".`);
    }
    const serviceTitle = String(val(existing, 'title') || serviceName).trim();
    const prevEnabled = val(existing, 'enabledModels') && typeof val(existing, 'enabledModels') === 'object'
      ? val(existing, 'enabledModels')
      : {};
    const prevModels = Array.isArray(prevEnabled.models) ? prevEnabled.models : [];
    const seen = new Set();
    const mergedModels = [];
    for (const m of [{ label: `${nextModel} (${serviceTitle})`, value: nextModel }, ...prevModels]) {
      const mv = typeof m === 'string' ? m.trim() : String(m?.value || m?.model || '').trim();
      if (!mv || seen.has(mv)) continue;
      seen.add(mv);
      mergedModels.push(typeof m === 'string' ? { label: mv, value: mv } : { label: String(m?.label || mv), value: mv });
    }
    const patch = {
      enabled: true,
      enabledModels: {
        ...prevEnabled,
        mode: prevEnabled.mode || 'custom',
        models: mergedModels,
      },
    };
    if (typeof existing.update === 'function') {
      await existing.update(patch, txOpt);
    } else if (typeof llmRepo.update === 'function') {
      await llmRepo.update({ filter: { name: serviceName }, values: patch, ...txOpt });
    }
  });

  const rebindRes = await rebindStarterAgentsToService(targetDb, {
    llmService: serviceName,
    modelName: nextModel,
    actorUser,
    defaultOrigin: env?.NOCOBASE_INTERNAL_URL || '',
    preserveActiveArchitect: false,
    adminToolNames: ADMIN_BUILDER_TOOL_NAMES,
  });

  await recordAiAuditLog(targetDb, {
    actorUserId: val(actorUser, 'id') ?? null,
    actorUsername: val(actorUser, 'username') || null,
    organizationId: organizationId || null,
    channel: 'studio-sync',
    aiEmployee: 'dxos-architect',
    toolName: 'dxosAi:switchLlmServiceModel',
    argsSummary: { serviceName, modelName: nextModel },
    status: 'allowed',
    resultSummary: `Switched active LLM to ${serviceName}/${nextModel}; rebound ${rebindRes.reboundAgents.length} starter agents`,
  });

  return {
    switched: true,
    serviceName,
    modelName: nextModel,
    reboundAgents: rebindRes.reboundAgents,
  };
}

module.exports = {
  QUICK_CONNECT_PROVIDER_PRESETS,
  ensureLocalLlmServiceRecord,
  isPrivateOrReservedIp,
  assertSafeLlmProbeUrl,
  validateQuickConnectBaseUrl,
  buildLlmProbeTarget,
  probeLlmHealth,
  runQuickConnectLlm,
  maskApiKey,
  listLlmServices,
  deleteLlmService,
  switchLlmServiceModel,
};
