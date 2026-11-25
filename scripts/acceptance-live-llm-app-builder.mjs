#!/usr/bin/env node
/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSafeLabOrigin } from './setup-native-multi-portal-demo.mjs';
import { createBlankSlateAcceptanceCallers } from './acceptance-blank-slate-app-builder.mjs';

const require = createRequire(import.meta.url);
const DEFAULT_LLM_BASE_URL = 'http://127.0.0.1:20128/v1';

export function parseLiveLlmArgs(argv = []) {
  let origin = 'http://127.0.0.1:13015';
  let llmBaseUrl = DEFAULT_LLM_BASE_URL;
  let model = '';
  let organizationId = 'native-ui-lab';

  for (const arg of argv) {
    if (arg.startsWith('--origin=')) origin = arg.slice('--origin='.length).trim();
    else if (arg.startsWith('--llm-base-url=')) llmBaseUrl = arg.slice('--llm-base-url='.length).trim();
    else if (arg.startsWith('--model=')) model = arg.slice('--model='.length).trim();
    else if (arg.startsWith('--org=')) organizationId = arg.slice('--org='.length).trim() || organizationId;
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
  }

  return {
    origin: assertSafeLabOrigin(origin),
    llmBaseUrl: llmBaseUrl.replace(/\/+$/, ''),
    model,
    organizationId,
  };
}

export function resolveLocal9RouterApiKey(env = process.env) {
  const fromEnv = String(env?.AGENT_API_KEY || env?.NINE_ROUTER_API_KEY || '').trim();
  if (fromEnv) return fromEnv;
  try {
    const { DatabaseSync } = require('node:sqlite');
    const sqlitePath = resolve(
      env?.APPDATA || resolve(env?.USERPROFILE || '', 'AppData', 'Roaming'),
      '9router',
      'db',
      'data.sqlite',
    );
    if (existsSync(sqlitePath)) {
      const db = new DatabaseSync(sqlitePath, { readOnly: true });
      const row = db.prepare('SELECT key FROM apiKeys LIMIT 1').get();
      if (row?.key) return String(row.key).trim();
    }
  } catch {
    // Non-fatal fallback
  }
  return '';
}

export async function selectWorkingLlmModel({
  llmBaseUrl = DEFAULT_LLM_BASE_URL,
  apiKey = '',
  requestedModel = '',
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
} = {}) {
  const base = String(llmBaseUrl || DEFAULT_LLM_BASE_URL).replace(/\/+$/, '');
  const headers = {
    'content-type': 'application/json',
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  };

  let candidates = [];
  if (requestedModel) {
    candidates = [requestedModel];
  } else {
    const modelsRes = await fetchImpl(`${base}/models`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!modelsRes?.ok) {
      return {
        selectedModel: null,
        probes: [{ model: '*', status: Number(modelsRes?.status) || 503, ok: false, detail: `GET /models failed (${modelsRes?.status})` }],
      };
    }
    const modelsJson = await modelsRes.json();
    const listed = (Array.isArray(modelsJson?.data) ? modelsJson.data : []).map((m) => String(m?.id || '').trim()).filter(Boolean);
    const preferredOrder = [
      'ag/gemini-3.8-flash',
      'ag/gemini-4-argon-low',
      'ag/claude-sonnet-5-5',
      'deepseek-web/deepseek-chat',
      'combo',
    ];
    candidates = [...new Set([...preferredOrder.filter((p) => listed.includes(p)), ...listed])];
  }

  const probes = [];
  for (const model of candidates) {
    try {
      const res = await fetchImpl(`${base}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'Call ping tool with ok="yes"' }],
          tools: [{
            type: 'function',
            function: {
              name: 'ping',
              description: 'Connectivity check',
              parameters: { type: 'object', properties: { ok: { type: 'string' } }, required: ['ok'] },
            },
          }],
          max_tokens: 32,
          temperature: 0,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch {}
      if (res.ok && parsed?.choices?.[0]) {
        probes.push({
          model,
          status: res.status,
          ok: true,
          detail: `toolCalls=${parsed.choices[0]?.message?.tool_calls?.length || 0}`,
        });
        return { selectedModel: model, probes };
      }
      const errMsg = parsed?.error?.message || parsed?.error?.code || text || `HTTP ${res.status}`;
      probes.push({
        model,
        status: Number(res.status) || 503,
        ok: false,
        detail: String(errMsg).slice(0, 140),
      });
    } catch (err) {
      probes.push({
        model,
        status: 504,
        ok: false,
        detail: String(err?.message || 'probe timeout/error').slice(0, 140),
      });
    }
  }
  return { selectedModel: null, probes };
}

export async function runLiveLlmToolLoop({
  llmBaseUrl = DEFAULT_LLM_BASE_URL,
  apiKey = '',
  model,
  systemPrompt,
  toolDefinition,
  userPrompt,
  executeTool,
  maxTurns = 3,
  fetchImpl = globalThis.fetch,
  timeoutMs = 45000,
} = {}) {
  const base = String(llmBaseUrl || DEFAULT_LLM_BASE_URL).replace(/\/+$/, '');
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
  const toolExecutions = [];
  let finalReply = '';

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    const res = await fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages,
        tools: [{
          type: 'function',
          function: {
            name: toolDefinition.name,
            description: toolDefinition.description,
            parameters: toolDefinition.parameters,
          },
        }],
        tool_choice: turn === 1 ? { type: 'function', function: { name: toolDefinition.name } } : 'auto',
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw Object.assign(new Error(`LLM HTTP ${res.status}: ${errText.slice(0, 180)}`), { status: res.status });
    }
    const json = await res.json();
    const choice = json?.choices?.[0];
    const msg = choice?.message || {};
    messages.push(msg);

    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (!toolCalls.length) {
      finalReply = String(msg.content || '').trim();
      break;
    }

    for (const tc of toolCalls) {
      const toolName = tc?.function?.name || '';
      let parsedArgs = {};
      try {
        parsedArgs = typeof tc?.function?.arguments === 'string'
          ? JSON.parse(tc.function.arguments || '{}')
          : (tc?.function?.arguments || {});
      } catch (err) {
        const parseErr = { isError: true, error: `Invalid JSON arguments: ${err.message}` };
        toolExecutions.push({ turn, toolName, ok: false, result: parseErr });
        messages.push({ role: 'tool', tool_call_id: tc.id || `call_${turn}`, content: JSON.stringify(parseErr) });
        continue;
      }

      const execOut = await executeTool(toolName, parsedArgs);
      toolExecutions.push({ turn, toolName, args: parsedArgs, ok: !execOut?.isError, result: execOut });
      messages.push({
        role: 'tool',
        tool_call_id: tc.id || `call_${turn}`,
        content: JSON.stringify(execOut),
      });
    }
  }

  return { toolExecutions, finalReply, turnCount: toolExecutions.length };
}

export async function runLiveLlmAppBuilderAcceptance({
  origin,
  llmBaseUrl = DEFAULT_LLM_BASE_URL,
  apiKey = '',
  requestedModel = '',
  organizationId = 'native-ui-lab',
  fetchImpl = globalThis.fetch,
} = {}) {
  const { selectedModel, probes } = await selectWorkingLlmModel({
    llmBaseUrl,
    apiKey,
    requestedModel,
    fetchImpl,
  });
  if (!selectedModel) {
    return {
      status: 'BLOCKED_UPSTREAM_LLM',
      result: 'BLOCKED_UPSTREAM_LLM',
      llmBaseUrl,
      probes,
    };
  }

  const { callActor, rpcRequest } = await createBlankSlateAcceptanceCallers(origin);
  const { STARTER_AI_BLUEPRINTS } = require('../plugins/nocobase/plugin-dxos-ai/src/server/ai-schemas.js');
  const { createDxosTools } = require('../plugins/nocobase/plugin-dxos-ai/src/server/ai-tools-core.js');
  const architect = STARTER_AI_BLUEPRINTS.find((b) => b.username === 'dxos-architect');
  const provisionTool = createDxosTools().find((t) => t.definition.name === 'dxos_provision_role_workspace');

  const suffix = Date.now().toString(36).slice(-4).toUpperCase().replace(/[^A-Z0-9]/g, 'X');
  const lower = suffix.toLowerCase();
  const appKey = `clinic-llm-${lower}`;
  const doctorsCol = `latticeCustomClinicDoctors${suffix}`;
  const visitsCol = `latticeCustomClinicVisits${suffix}`;
  const roleName = `ldx_clinic_${lower}`;
  let builtResult = null;

  try {
    // 1. Bind working model via quickConnectLlm with completion probe
    const qcBaseUrl = llmBaseUrl.includes('127.0.0.1') ? llmBaseUrl.replace('127.0.0.1', 'host.docker.internal') : llmBaseUrl;
    const qcRes = await callActor('root', 'dxosAi:quickConnectLlm', {
      method: 'POST',
      values: {
        provider: '9router',
        apiKey: apiKey || 'sk-local',
        baseURL: qcBaseUrl,
        modelName: selectedModel,
        testConnection: true,
        verifyCompletion: true,
      },
    });
    assert.ok(qcRes.ok && qcRes.data?.health?.ok === true, `quickConnectLlm failed: ${JSON.stringify(qcRes.data)}`);

    // 2. Ask real LLM in natural Vietnamese to construct a multi-entity Clinic app
    const userPrompt = [
      `Hãy dựng giúp tôi một phân hệ Quản lý Phòng khám đa thực thể bằng operation="build_enterprise_app":`,
      `- appKey: "${appKey}", portalSlug: "services", pageTitle: "Phòng khám AI ${suffix}"`,
      `- roleName: "${roleName}", roleTitle: "Điều phối Phòng khám ${suffix}"`,
      `- Bảng 1 (cha): collectionName "${doctorsCol}", collectionTitle "Bác sĩ", gồm trường "fullName" (string), "specialty" (string).`,
      `- Bảng 2 (con): collectionName "${visitsCol}", collectionTitle "Lịch khám", gồm trường "patientName" (string), "status" (select với enum ["waiting", "examining", "done"]), "visitDate" (date), và "doctor" (type "belongsTo", target "${doctorsCol}").`,
      `- Thêm Kanban block ("DxosKanbanScheduleBlockModel") gắn với "${visitsCol}" và statusField "status".`,
      `- Trả dryRun=false để thực thi ngay.`,
    ].join('\n');

    const loopRes = await runLiveLlmToolLoop({
      llmBaseUrl,
      apiKey,
      model: selectedModel,
      systemPrompt: architect.systemPrompt,
      toolDefinition: {
        name: provisionTool.definition.name,
        description: provisionTool.definition.description,
        parameters: provisionTool.jsonSchema,
      },
      userPrompt,
      maxTurns: 3,
      fetchImpl,
      executeTool: async (toolName, parsedArgs) => {
        const rpc = await rpcRequest('root', '/api/dxos-mcp', {
          jsonrpc: '2.0',
          id: Date.now(),
          method: 'tools/call',
          params: { name: toolName, arguments: parsedArgs },
        });
        if (rpc.json?.error) {
          return { isError: true, error: rpc.json.error };
        }
        const txt = rpc.json?.result?.content?.[0]?.text || '{}';
        let parsed = {};
        try { parsed = JSON.parse(txt); } catch { parsed = { raw: txt }; }
        if (rpc.json?.result?.isError) {
          return { isError: true, ...parsed };
        }
        if (parsed?.built === true || parsed?.ok === true) {
          builtResult = parsed;
        }
        return parsed;
      },
    });

    assert.ok(builtResult && builtResult.built === true, `Real LLM failed to build app: ${JSON.stringify(loopRes)}`);

    // 3. Verify built app registry, collectionsMeta, Kanban list, Rebuild v2, and Export v3
    const listRes = await callActor('root', `dxosAi:listBuiltApps?organizationId=${encodeURIComponent(organizationId)}`);
    assert.ok(listRes.ok);
    const appRow = (listRes.data?.apps || []).find((a) => a.appKey === builtResult.appKey);
    assert.ok(appRow, 'LLM-built app missing from latticeBuiltApps');

    const metaRes = await callActor('root', 'dxosBlocks:collectionsMeta');
    assert.ok(metaRes.ok);
    const metaNames = new Set((metaRes.data?.collections || []).map((c) => c.name));
    for (const c of builtResult.collections || []) {
      assert.ok(metaNames.has(c), `collectionsMeta missing LLM-built collection ${c}`);
    }

    const rebuildRes = await callActor('root', 'dxosAi:rebuildBuiltApp', {
      method: 'POST',
      values: { organizationId, appKey: builtResult.appKey },
    });
    assert.ok(rebuildRes.ok && rebuildRes.data?.appVersion >= 2);

    const exportRes = await callActor(
      'root',
      `dxosAi:exportBuiltAppBundle?organizationId=${encodeURIComponent(organizationId)}&appKey=${encodeURIComponent(builtResult.appKey)}`,
    );
    assert.ok(exportRes.ok && exportRes.data?.metadata?.schemaVersion === 'latticedx.solution-bundle/v3');

    return {
      status: 'PASS',
      result: 'PASS',
      selectedModel,
      appKey: builtResult.appKey,
      collections: builtResult.collections,
      toolTurns: loopRes.turnCount,
      rebuildVersion: rebuildRes.data.appVersion,
      bundleSchemaVersion: exportRes.data.metadata.schemaVersion,
    };
  } finally {
    const cleanKey = builtResult?.appKey || appKey;
    await callActor('root', 'dxosAi:teardownBuiltApp', {
      method: 'POST',
      values: { organizationId, appKey: cleanKey, keepData: false },
    }).catch(() => {});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opts = parseLiveLlmArgs(process.argv.slice(2));
  const apiKey = resolveLocal9RouterApiKey(process.env);
  runLiveLlmAppBuilderAcceptance({
    origin: opts.origin,
    llmBaseUrl: opts.llmBaseUrl,
    apiKey,
    requestedModel: opts.model,
    organizationId: opts.organizationId,
  })
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
      if (summary.result !== 'PASS') process.exitCode = 1;
    })
    .catch((err) => {
      console.error(JSON.stringify({ status: 'FAIL', result: 'FAIL', error: err.message }));
      process.exitCode = 1;
    });
}
