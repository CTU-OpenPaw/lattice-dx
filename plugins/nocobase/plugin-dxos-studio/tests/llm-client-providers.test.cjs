/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  EXPLICIT_LOCAL_LLM_HOSTS,
  resolveActiveLlmService,
  callConfiguredLlm,
} = require('../src/server/flow/llm-client');

function makeLlmServicesDb(rows = []) {
  return {
    getRepository(name) {
      if (name !== 'llmServices') return null;
      return {
        async find() {
          return rows;
        },
        async findOne({ filter = {} } = {}) {
          if (filter.name) return rows.find((r) => r.name === filter.name) || null;
          return rows[0] || null;
        },
      };
    },
  };
}

test('resolveActiveLlmService derives provider-appropriate default baseURLs when baseURL is omitted', async () => {
  const cases = [
    { name: 'quick-google-genai', provider: 'google-genai', apiKey: 'AIzaTestKey123456', expectedBase: 'https://generativelanguage.googleapis.com' },
    { name: 'quick-anthropic', provider: 'anthropic', apiKey: 'sk-ant-test-123456', expectedBase: 'https://api.anthropic.com/v1' },
    { name: 'quick-ollama', provider: 'ollama', apiKey: '', expectedBase: 'http://127.0.0.1:11434' },
    { name: 'quick-deepseek', provider: 'deepseek', apiKey: 'sk-ds-test-123456', expectedBase: 'https://api.deepseek.com/v1' },
    { name: 'quick-openai', provider: 'openai', apiKey: 'sk-openai-test-1234', expectedBase: 'https://api.openai.com/v1' },
    { name: 'local-9router', provider: 'openai-completions', apiKey: 'sk-9router-test-123', expectedBase: 'http://host.docker.internal:20128/v1' },
  ];

  for (const c of cases) {
    const db = makeLlmServicesDb([
      {
        id: 1,
        name: c.name,
        provider: c.provider,
        enabled: true,
        options: c.apiKey ? { apiKey: c.apiKey } : {},
      },
    ]);
    const svc = await resolveActiveLlmService(db, { AGENT_BASE_URL: '' });
    assert.equal(svc.configured, true, `${c.name} should resolve as configured`);
    assert.equal(svc.baseURL, c.expectedBase, `${c.name} baseURL mismatch`);
  }

  // serviceName option selects a specific enabled provider even when local-9router exists
  const multiDb = makeLlmServicesDb([
    { id: 1, name: 'local-9router', provider: 'openai-completions', enabled: true, options: { baseURL: 'http://127.0.0.1:20128/v1', apiKey: 'sk-9r' } },
    { id: 2, name: 'quick-anthropic', provider: 'anthropic', enabled: true, options: { apiKey: 'sk-ant-999' } },
  ]);
  const picked = await resolveActiveLlmService(multiDb, {}, { serviceName: 'quick-anthropic' });
  assert.equal(picked.serviceName, 'quick-anthropic');
  assert.equal(picked.baseURL, 'https://api.anthropic.com/v1');
});

test('callConfiguredLlm supports google-genai :generateContent with x-goog-api-key, JSON mode, tool calls, and PII redaction', async () => {
  const db = makeLlmServicesDb([
    {
      id: 1,
      name: 'quick-google-genai',
      provider: 'google-genai',
      enabled: true,
      options: { apiKey: 'AIzaSyFakeGoogleKey99999' },
      enabledModels: { models: [{ value: 'gemini-2.5-flash' }] },
    },
  ]);

  let sentUrl = '';
  let sentHeaders = {};
  let sentBody = null;

  const jsonRes = await callConfiguredLlm({
    db,
    env: {},
    responseFormat: 'json',
    messages: [
      { role: 'system', content: 'Trả lời JSON thuần.' },
      { role: 'user', content: 'Kiểm tra email alice@example.com' },
    ],
    fetchImpl: async (url, init) => {
      sentUrl = url;
      sentHeaders = init.headers;
      sentBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          modelVersion: 'gemini-2.5-flash',
          candidates: [{ content: { role: 'model', parts: [{ text: '{"ok":true,"status":"ready"}' }] } }],
          usageMetadata: { promptTokenCount: 25, candidatesTokenCount: 11, totalTokenCount: 36 },
        }),
      };
    },
  });

  assert.equal(jsonRes.ok, true);
  assert.equal(sentUrl, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
  assert.equal(sentHeaders['x-goog-api-key'], 'AIzaSyFakeGoogleKey99999');
  assert.equal(sentHeaders.Authorization, undefined);
  assert.equal(sentBody.systemInstruction.parts[0].text, 'Trả lời JSON thuần.');
  assert.equal(sentBody.generationConfig.responseMimeType, 'application/json');
  assert.equal(sentBody.contents[0].parts[0].text.includes('alice@example.com'), false);
  assert.deepEqual(jsonRes.parsedJson, { ok: true, status: 'ready' });
  assert.deepEqual(jsonRes.usage, { prompt_tokens: 25, completion_tokens: 11, total_tokens: 36 });
  assert.ok(jsonRes.piiRedactedCount >= 1);

  // Tool calling with functionDeclarations & functionCall response
  let toolBody = null;
  const toolRes = await callConfiguredLlm({
    db,
    env: {},
    responseFormat: 'auto',
    tools: [{ type: 'function', function: { name: 'lookup_lot', description: 'Find stock lot', parameters: { type: 'object', properties: { code: { type: 'string' } } } } }],
    messages: [{ role: 'user', content: 'Tra lô LOT-1' }],
    fetchImpl: async (_url, init) => {
      toolBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{
            content: {
              role: 'model',
              parts: [{ functionCall: { name: 'lookup_lot', args: { code: 'LOT-1', __proto__: { bad: 1 } } } }],
            },
          }],
          usageMetadata: { promptTokenCount: 18, candidatesTokenCount: 9, totalTokenCount: 27 },
        }),
      };
    },
  });

  assert.equal(toolRes.ok, true);
  assert.equal(toolBody.tools[0].functionDeclarations[0].name, 'lookup_lot');
  assert.equal(toolRes.toolCalls.length, 1);
  assert.equal(toolRes.toolCalls[0].name, 'lookup_lot');
  assert.deepEqual(toolRes.toolCalls[0].arguments, { code: 'LOT-1' });
  assert.equal(({}).bad, undefined);
});

test('callConfiguredLlm supports anthropic /v1/messages with x-api-key, anthropic-version, system prompt, and tool_use', async () => {
  const db = makeLlmServicesDb([
    {
      id: 2,
      name: 'quick-anthropic',
      provider: 'anthropic',
      enabled: true,
      options: { apiKey: 'sk-ant-secret-key-8888' },
      enabledModels: { models: [{ value: 'claude-3-5-sonnet-latest' }] },
    },
  ]);

  let sentUrl = '';
  let sentHeaders = {};
  let sentBody = null;
  const res = await callConfiguredLlm({
    db,
    env: {},
    responseFormat: 'auto',
    tools: [{ type: 'function', function: { name: 'ack_alarm', description: 'Acknowledge alarm', parameters: { type: 'object', properties: { code: { type: 'string' } } } } }],
    toolChoice: 'auto',
    messages: [
      { role: 'system', content: 'Bạn là trợ lý vận hành.' },
      { role: 'user', content: 'Xác nhận ALM-1 giúp tôi' },
    ],
    fetchImpl: async (url, init) => {
      sentUrl = url;
      sentHeaders = init.headers;
      sentBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'claude-3-5-sonnet-latest',
          content: [
            { type: 'text', text: 'Đang gọi công cụ xác nhận.' },
            { type: 'tool_use', id: 'toolu_01', name: 'ack_alarm', input: { code: 'ALM-1' } },
          ],
          usage: { input_tokens: 33, output_tokens: 17 },
        }),
      };
    },
  });

  assert.equal(res.ok, true);
  assert.equal(sentUrl, 'https://api.anthropic.com/v1/messages');
  assert.equal(sentHeaders['x-api-key'], 'sk-ant-secret-key-8888');
  assert.equal(sentHeaders['anthropic-version'], '2023-06-01');
  assert.equal(sentBody.system, 'Bạn là trợ lý vận hành.');
  assert.equal(sentBody.messages.some((m) => m.role === 'system'), false);
  assert.equal(sentBody.tools[0].input_schema.type, 'object');
  assert.deepEqual(sentBody.tool_choice, { type: 'auto' });
  assert.equal(res.content, 'Đang gọi công cụ xác nhận.');
  assert.equal(res.toolCalls.length, 1);
  assert.equal(res.toolCalls[0].id, 'toolu_01');
  assert.equal(res.toolCalls[0].name, 'ack_alarm');
  assert.deepEqual(res.toolCalls[0].arguments, { code: 'ALM-1' });
  assert.deepEqual(res.usage, { prompt_tokens: 33, completion_tokens: 17, total_tokens: 50 });
});

test('callConfiguredLlm supports ollama /api/chat and /v1 compat, plus deepseek and error key scrubbing & SSRF guard', async () => {
  // 1. Ollama native /api/chat
  const ollamaDb = makeLlmServicesDb([
    {
      id: 3,
      name: 'quick-ollama',
      provider: 'ollama',
      enabled: true,
      options: { baseURL: 'http://127.0.0.1:11434' },
      enabledModels: { models: [{ value: 'llama3.1' }] },
    },
  ]);
  let ollamaUrl = '';
  let ollamaBody = null;
  const ollamaRes = await callConfiguredLlm({
    db: ollamaDb,
    env: {},
    responseFormat: 'json',
    messages: [{ role: 'user', content: 'Trả JSON {"hello":"ollama"}' }],
    fetchImpl: async (url, init) => {
      ollamaUrl = url;
      ollamaBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'llama3.1',
          message: { role: 'assistant', content: '{"hello":"ollama"}' },
          prompt_eval_count: 14,
          eval_count: 6,
        }),
      };
    },
  });
  assert.equal(ollamaRes.ok, true);
  assert.equal(ollamaUrl, 'http://127.0.0.1:11434/api/chat');
  assert.equal(ollamaBody.stream, false);
  assert.equal(ollamaBody.format, 'json');
  assert.deepEqual(ollamaRes.parsedJson, { hello: 'ollama' });
  assert.deepEqual(ollamaRes.usage, { prompt_tokens: 14, completion_tokens: 6, total_tokens: 20 });

  // 2. DeepSeek error scrubs apiKey
  const dsDb = makeLlmServicesDb([
    {
      id: 4,
      name: 'quick-deepseek',
      provider: 'deepseek',
      enabled: true,
      options: { apiKey: 'custom-deepseek-secret-token-777' },
      enabledModels: { models: [{ value: 'deepseek-chat' }] },
    },
  ]);
  const dsErr = await callConfiguredLlm({
    db: dsDb,
    env: {},
    messages: [{ role: 'user', content: 'hi' }],
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      text: async () => 'Invalid key custom-deepseek-secret-token-777 rejected',
    }),
  });
  assert.equal(dsErr.ok, false);
  assert.equal(dsErr.code, 'LLM_HTTP_401');
  assert.equal(dsErr.reason.includes('custom-deepseek-secret-token-777'), false);

  // 3. SSRF blocks metadata URLs across non-OpenAI providers BEFORE fetchImpl
  for (const prov of ['google-genai', 'anthropic', 'ollama']) {
    let fetched = false;
    const ssrfDb = makeLlmServicesDb([
      {
        id: 9,
        name: `evil-${prov}`,
        provider: prov,
        enabled: true,
        options: { baseURL: 'http://169.254.169.254', apiKey: 'sk-ssrf' },
        enabledModels: { models: [{ value: 'test-model' }] },
      },
    ]);
    await assert.rejects(
      () => callConfiguredLlm({
        db: ssrfDb,
        env: {},
        messages: [{ role: 'user', content: 'hi' }],
        fetchImpl: async () => { fetched = true; return { ok: true, json: async () => ({}) }; },
      }),
      /SSRF|metadata|blocked|UNSAFE/i,
    );
    assert.equal(fetched, false, `${prov} must block SSRF before fetchImpl`);
  }
});

test('callConfiguredLlm allows ::1 IPv6 loopback host consistently with quickConnectLlm', async () => {
  assert.equal(EXPLICIT_LOCAL_LLM_HOSTS.has('::1'), true, 'EXPLICIT_LOCAL_LLM_HOSTS must include ::1');
  const db = makeLlmServicesDb([
    {
      id: 10,
      name: 'quick-ollama-v6',
      provider: 'ollama',
      enabled: true,
      options: { baseURL: 'http://[::1]:11434' },
      enabledModels: { models: [{ value: 'llama3.1' }] },
    },
  ]);
  let sentUrl = '';
  const res = await callConfiguredLlm({
    db,
    env: {},
    responseFormat: 'json',
    messages: [{ role: 'user', content: 'ping' }],
    lookupImpl: async () => [{ address: '::1', family: 6 }],
    fetchImpl: async (url) => {
      sentUrl = url;
      return {
        ok: true,
        status: 200,
        json: async () => ({ model: 'llama3.1', message: { role: 'assistant', content: '{"ok":true}' } }),
      };
    },
  });
  assert.equal(res.ok, true);
  assert.equal(sentUrl, 'http://[::1]:11434/api/chat');
});
