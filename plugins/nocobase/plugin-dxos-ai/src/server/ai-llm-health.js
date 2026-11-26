/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

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
const QUICK_CONNECT_SERVICE_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/;
const QUICK_CONNECT_PRIVATE_IPV4_RE = /^(?:0\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+|127\.\d+\.\d+\.\d+|169\.254\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+)$/;
const QUICK_CONNECT_META_HOSTS = new Set(['metadata.google.internal', 'metadata.azure.com', '169.254.169.254', '100.100.100.200']);

function validateQuickConnectBaseUrl(rawUrl) {
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
  const isLocalAllowed = QUICK_CONNECT_LOCAL_HOSTS.has(bare);
  if (!isLocalAllowed) {
    if (bare.endsWith('.localhost') || bare.endsWith('.local') || bare.endsWith('.internal')) {
      throw failTool('LLM_URL_UNSAFE', 400, `Tên miền nội bộ "${bare}" bị chặn bởi chính sách SSRF.`);
    }
    if (bare.includes(':')) {
      throw failTool('LLM_URL_UNSAFE', 400, 'Địa chỉ IPv6 nội bộ/không công khai bị chặn.');
    }
    if (net.isIPv4(bare) && QUICK_CONNECT_PRIVATE_IPV4_RE.test(bare)) {
      throw failTool('LLM_URL_UNSAFE', 400, `Địa chỉ IP nội bộ "${bare}" bị chặn bởi chính sách SSRF.`);
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

async function probeLlmHealth(db, { env = process.env, fetchImpl, isAdmin = false, llmServiceName = '', modelName = '', verifyCompletion = false } = {}) {
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
  try {
    const modelsTimeout = createTimeoutSignal(5000);
    clearModelsTimer = modelsTimeout.clear;
    const res = await doFetch(target.probeUrl, {
      method: 'GET',
      headers: target.headers,
      ...(modelsTimeout.signal ? { signal: modelsTimeout.signal } : {}),
    });
    const status = Number(res?.status) || (res?.ok ? 200 : 503);
    if (!res?.ok) {
      return classifyHttpFailure(status, { serviceName, boundModel, provider, baseURL: target.baseURL });
    }

    const lowerProv = provider.toLowerCase();
    const isOpenAiCompat = lowerProv.includes('openai') || lowerProv.includes('deepseek') || lowerProv.includes('9router');
    if (verifyCompletion && boundModel && isOpenAiCompat) {
      const compTimeout = createTimeoutSignal(8000);
      clearCompTimer = compTimeout.clear;
      const compRes = await doFetch(`${target.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { ...target.headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: boundModel,
          messages: [{ role: 'user', content: 'ok' }],
          max_tokens: 4,
          temperature: 0,
        }),
        ...(compTimeout.signal ? { signal: compTimeout.signal } : {}),
      });
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
    const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError' || /timeout|aborted/i.test(String(err?.message || ''));
    return resultBase({
      ok: false,
      status: isTimeout ? 504 : 503,
      code: isTimeout ? 'LLM_TIMEOUT' : 'LLM_UNAVAILABLE',
      llmService: serviceName,
      modelName: boundModel,
      provider,
      baseURL: target.baseURL,
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
  const baseURL = validateQuickConnectBaseUrl(rawBase);

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

module.exports = {
  QUICK_CONNECT_PROVIDER_PRESETS,
  ensureLocalLlmServiceRecord,
  validateQuickConnectBaseUrl,
  buildLlmProbeTarget,
  probeLlmHealth,
  runQuickConnectLlm,
};
