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
const { callConfiguredLlm } = require('../src/server/flow/llm-client');

function makeLlmDb(baseURL = 'https://llm.example.com/v1') {
  return {
    getRepository(name) {
      if (name !== 'llmServices') return null;
      return {
        async find() {
          return [{
            id: 1, name: 'local-9router', provider: 'openai-completions', enabled: true,
            options: { baseURL, apiKey: 'sk-test-key-999999' },
            enabledModels: { models: [{ value: 'oc/big-pickle' }] },
          }];
        },
      };
    },
  };
}

test('callConfiguredLlm forwards OpenAI tools/toolChoice, redacts PII inside tool_calls, and parses toolCalls', async () => {
  const db = makeLlmDb();
  let sentBody = null;
  const res = await callConfiguredLlm({
    db,
    env: {},
    responseFormat: 'auto',
    tools: [
      {
        type: 'function',
        function: {
          name: 'memory_recall',
          description: 'Recall org memory',
          parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        },
      },
    ],
    toolChoice: 'auto',
    messages: [
      { role: 'system', content: 'You are a helpful agent.' },
      { role: 'user', content: 'Check email alice@example.com' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_prev_1',
          type: 'function',
          function: { name: 'memory_recall', arguments: '{"query":"sk-secret12345678","__proto__":{"bad":1}}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call_prev_1', name: 'memory_recall', content: '{"items":[]}' },
    ],
    fetchImpl: async (_url, init) => {
      sentBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'oc/big-pickle',
          usage: { prompt_tokens: 40, completion_tokens: 18, total_tokens: 58 },
          choices: [{
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'memory_recall',
                  arguments: '{"query":"incident history","__proto__":{"polluted":true}}',
                },
              }],
            },
          }],
        }),
      };
    },
  });

  assert.equal(res.ok, true);
  assert.equal(res.mode, 'llm');
  assert.equal(sentBody.response_format, undefined, 'response_format must be omitted when responseFormat !== json');
  assert.equal(sentBody.tool_choice, 'auto');
  assert.equal(sentBody.tools.length, 1);
  assert.equal(sentBody.tools[0].function.name, 'memory_recall');

  const assistantMsg = sentBody.messages.find((m) => m.role === 'assistant');
  assert.equal(assistantMsg.content, null);
  assert.equal(assistantMsg.tool_calls[0].id, 'call_prev_1');
  assert.equal(assistantMsg.tool_calls[0].function.arguments.includes('sk-secret12345678'), false);
  const toolMsg = sentBody.messages.find((m) => m.role === 'tool');
  assert.equal(toolMsg.tool_call_id, 'call_prev_1');
  assert.equal(toolMsg.name, 'memory_recall');

  assert.equal(Array.isArray(res.toolCalls), true);
  assert.equal(res.toolCalls.length, 1);
  assert.equal(res.toolCalls[0].id, 'call_1');
  assert.equal(res.toolCalls[0].name, 'memory_recall');
  assert.deepEqual(res.toolCalls[0].arguments, { query: 'incident history' });
  assert.equal(({}).polluted, undefined);
  assert.ok(res.message && Array.isArray(res.message.tool_calls));
  assert.ok(res.raw);
  assert.ok(res.piiRedactedCount >= 2);
});

test('callConfiguredLlm still enforces SSRF protection when tools are passed', async () => {
  const ssrfDb = makeLlmDb('http://169.254.169.254/v1');
  let fetched = false;
  await assert.rejects(
    () => callConfiguredLlm({
      db: ssrfDb,
      env: {},
      tools: [{ type: 'function', function: { name: 'memory_recall', parameters: { type: 'object' } } }],
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl: async () => { fetched = true; return { ok: true, json: async () => ({}) }; },
    }),
    /SSRF|metadata|blocked|UNSAFE/i,
  );
  assert.equal(fetched, false);
});

test('json-schema-validator validates pure JS schemas safely without eval or prototype pollution', () => {
  const { validateJsonAgainstSchema } = require('../src/server/flow/json-schema-validator');
  const schema = {
    type: 'object',
    required: ['severity', 'actions', 'score'],
    additionalProperties: false,
    properties: {
      severity: { type: 'string', enum: ['low', 'medium', 'high'] },
      summary: { type: 'string', minLength: 3, maxLength: 100 },
      score: { type: 'integer', minimum: 1, maximum: 10 },
      actions: {
        type: 'array',
        items: { type: 'string', minLength: 2 },
      },
    },
  };

  const validPayload = JSON.parse('{"severity":"high","score":8,"actions":["notify"],"__proto__":{"pwn":true}}');
  const okRes = validateJsonAgainstSchema(validPayload, schema);
  assert.equal(okRes.ok, true);
  assert.equal(okRes.value.severity, 'high');
  assert.equal(({}).pwn, undefined);
  assert.equal(Object.hasOwn(okRes.value, '__proto__'), false);

  const badRes = validateJsonAgainstSchema({ severity: 'extreme', score: 99, actions: ['x'], extra: true }, schema);
  assert.equal(badRes.ok, false);
  assert.ok(badRes.errors.length >= 3);

  // Depth limit check
  let deep = { val: 1 };
  for (let i = 0; i < 20; i += 1) deep = { nested: deep };
  const deepRes = validateJsonAgainstSchema(deep, { type: 'object' });
  assert.equal(deepRes.ok, false);
  assert.ok(deepRes.errors.some((e) => /depth/i.test(e.message)));
});

function makeAgentDb(seed = {}) {
  const store = {};
  const seq = {};
  for (const [k, rows] of Object.entries(seed)) {
    store[k] = rows.map((r, i) => ({ id: r.id ?? i + 1, ...structuredClone(r) }));
    seq[k] = store[k].length + 1;
  }
  const match = (row, filter) => {
    if (!filter || typeof filter !== 'object') return true;
    return Object.entries(filter).every(([k, v]) => {
      if (v && typeof v === 'object' && '$in' in v) return v.$in.includes(row[k]);
      return row[k] === v;
    });
  };
  return {
    store,
    _omit: new Set(),
    getRepository(name) {
      if (this._omit.has(name)) return null;
      if (!store[name]) { store[name] = []; seq[name] = 1; }
      return {
        async find({ filter = {}, limit = 200 } = {}) { return store[name].filter((r) => match(r, filter)).slice(0, limit).map((r) => ({ ...r })); },
        async findOne({ filter = {}, filterByTk } = {}) {
          const eff = filterByTk !== undefined ? { id: filterByTk, ...filter } : filter;
          const hit = store[name].find((r) => match(r, eff));
          return hit ? { ...hit } : null;
        },
        async create({ values }) {
          const row = { id: values.id ?? seq[name]++, createdAt: new Date(), updatedAt: new Date(), ...structuredClone(values) };
          store[name].push(row);
          return { ...row };
        },
        async update({ filter = {}, values }) {
          let count = 0;
          for (const row of store[name]) {
            if (match(row, filter)) { Object.assign(row, structuredClone(values), { updatedAt: new Date() }); count += 1; }
          }
          return [count];
        },
      };
    },
  };
}

function makeOaiResponse({ content = null, toolCalls = null, promptTokens = 25, completionTokens = 15 } = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      model: 'oc/big-pickle',
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
      choices: [{ message: { role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls } : {}) } }],
    }),
  };
}

test('ai.agent exposes ReAct config schema and preserves backward-compatible single-shot triage', async () => {
  const { createDefaultRegistry } = require('../src/server/flow/registry');
  const reg = createDefaultRegistry();
  const agentDef = reg.getNodeType('ai.agent');
  const fieldNames = agentDef.inputSchema.fields.map((f) => f.name);
  for (const reqField of ['mode', 'maxTurns', 'tools', 'outputSchema', 'memoryScope', 'systemPrompt']) {
    assert.ok(fieldNames.includes(reqField), `ai.agent missing field ${reqField}`);
  }
  const recField = agentDef.inputSchema.fields.find((f) => f.name === 'recommendation');
  assert.equal(Boolean(recField?.required), false, 'recommendation must not be required for ReAct configs');

  const db = makeAgentDb();
  const singleRes = await agentDef.execute({
    node: { id: 'ai_1', type: 'ai.agent' },
    config: { targetCollection: 'latticeAssets', targetRecordId: 42, severity: 'high', recommendation: 'Inspect motor' },
    context: { organizationId: 'org-a', runUid: 'run_single_1' },
    db,
    options: {
      callLlmJson: async () => ({ ok: true, data: { severity: 'critical', recommendation: 'Shutdown immediately' }, usage: { promptTokens: 10, completionTokens: 5 }, model: 'oc/big-pickle' }),
    },
  });
  assert.equal(singleRes.nextPort, 'main');
  assert.equal(singleRes.output.target, 'latticeAgentProposals');
  assert.equal(singleRes.output.severity, 'critical');
  assert.equal(db.store.latticeAgentProposals.length, 1);
});

test('ai.agent ReAct executes multi-turn loop with memory_recall/memory_store, custom safe tools, outputSchema repair, and OTel GenAI spans', async () => {
  const { createDefaultRegistry } = require('../src/server/flow/registry');
  const agentDef = createDefaultRegistry().getNodeType('ai.agent');
  const db = makeAgentDb({
    llmServices: [{ id: 1, name: 'local-9router', enabled: true, options: { baseURL: 'https://llm.example.com/v1', apiKey: 'sk-test-1234' } }],
    latticeAiMemory: [
      { id: 1, organizationId: 'org-a', agentName: 'ops_triage', scope: 'org', memoryKey: 'sop_pump', title: 'Pump SOP', content: 'Always verify pressure gauge before dispatch', tagsJson: ['pump'], importance: 9 },
      { id: 2, organizationId: 'org-b', agentName: 'ops_triage', scope: 'org', memoryKey: 'secret_b', title: 'Other Org', content: 'ORG_B_SECRET_DO_NOT_LEAK', tagsJson: ['pump'], importance: 10 },
    ],
  });

  const spans = [];
  const persistedTraces = [];
  const otelExporter = {
    startGenAiSpan(input) {
      return { ...input, spanId: `sp_${spans.length + 1}`, traceId: input.traceId || 'a'.repeat(32), startedAt: new Date() };
    },
    recordGenAiSpan(span) { spans.push(span); return true; },
    async persistGenAiTrace(_db, rec) { persistedTraces.push(rec); return rec; },
  };

  let turn = 0;
  const res = await agentDef.execute({
    node: { id: 'react_1', type: 'ai.agent' },
    config: {
      mode: 'react',
      maxTurns: 6,
      aiEmployee: 'ops_triage',
      memoryScope: 'org',
      tools: ['memory_recall', 'memory_store', 'dxos_get_weather_stub'],
      prompt: 'Analyze pump anomaly for {{data.assetCode}}',
      outputSchema: {
        type: 'object',
        required: ['diagnosis', 'priority'],
        properties: {
          diagnosis: { type: 'string', minLength: 3 },
          priority: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
        additionalProperties: false,
      },
    },
    context: { organizationId: 'org-a', runUid: 'run_react_1', data: { assetCode: 'PUMP-01' } },
    db,
    options: {
      otelExporter,
      tools: {
        dxos_get_weather_stub: {
          description: 'Safe read-only telemetry lookup',
          parameters: { type: 'object', properties: { asset: { type: 'string' } } },
          async execute(args) { return { asset: args.asset, tempC: 72 }; },
        },
      },
      fetchImpl: async () => {
        turn += 1;
        if (turn === 1) {
          return makeOaiResponse({
            toolCalls: [
              { id: 'c1', type: 'function', function: { name: 'memory_recall', arguments: '{"query":"pump","organizationId":"org-b"}' } },
              { id: 'c2', type: 'function', function: { name: 'dxos_get_weather_stub', arguments: '{"asset":"PUMP-01"}' } },
            ],
          });
        }
        if (turn === 2) {
          return makeOaiResponse({
            toolCalls: [
              { id: 'c3', type: 'function', function: { name: 'memory_store', arguments: '{"memoryKey":"pump_note","title":"Pump Note","content":"PUMP-01 ran hot at 72C","organizationId":"org-b","__proto__":{"x":1}}' } },
            ],
          });
        }
        if (turn === 3) {
          // Invalid against outputSchema (missing priority, extra field) -> triggers repair turn
          return makeOaiResponse({ content: '{"diagnosis":"Overheating","extra":1}' });
        }
        return makeOaiResponse({ content: '{"diagnosis":"Pump overheating above SOP threshold","priority":"high"}' });
      },
    },
  });

  assert.equal(res.nextPort, 'main');
  assert.equal(res.output.mode, 'react_llm');
  assert.equal(res.output.turnsUsed, 4);
  assert.deepEqual(res.output.data, { diagnosis: 'Pump overheating above SOP threshold', priority: 'high' });
  assert.equal(res.output.toolCalls.length, 3);
  assert.equal(res.output.usage.promptTokens, 100);
  assert.equal(res.output.usage.completionTokens, 60);

  // Tenant isolation on memory_store & memory_recall
  const stored = db.store.latticeAiMemory.find((m) => m.memoryKey === 'pump_note');
  assert.ok(stored);
  assert.equal(stored.organizationId, 'org-a', 'LLM-supplied organizationId must be ignored');
  const recallTrace = res.output.toolCalls.find((tc) => tc.name === 'memory_recall');
  assert.equal(JSON.stringify(recallTrace.result).includes('ORG_B_SECRET_DO_NOT_LEAK'), false);

  // OTel GenAI spans emitted
  const opNames = spans.map((s) => s.operationName || s.attributes?.['gen_ai.operation.name']);
  assert.ok(opNames.includes('invoke_agent'));
  assert.ok(opNames.includes('chat'));
  assert.ok(opNames.includes('execute_tool'));
  assert.ok(persistedTraces.length >= 3);
});

test('ai.agent ReAct rejects unallowlisted tools, handles maxTurns exhaustion, and guards mutating tools with HITL suspension + resume', async () => {
  const { createDefaultRegistry } = require('../src/server/flow/registry');
  const { executeFlowGraph, resumeFlowRun } = require('../src/server/flow/executor');
  const agentDef = createDefaultRegistry().getNodeType('ai.agent');
  const db = makeAgentDb({
    llmServices: [{ id: 1, name: 'local-9router', enabled: true, options: { baseURL: 'https://llm.example.com/v1', apiKey: 'sk-test-1234' } }],
    rolesUsers: [{ userId: 7, roleName: 'ldx_manager' }],
    latticeEmployees: [{ id: 1, userId: 7, organizationId: 'org-a', active: true }],
  });

  // 1. maxTurns exhaustion
  const maxTurnRes = await agentDef.execute({
    node: { id: 'react_max', type: 'ai.agent' },
    config: { mode: 'react', maxTurns: 1, tools: ['memory_recall'], prompt: 'Loop forever' },
    context: { organizationId: 'org-a', runUid: 'run_max_1' },
    db,
    options: {
      fetchImpl: async () => makeOaiResponse({
        toolCalls: [{ id: 'c1', type: 'function', function: { name: 'memory_recall', arguments: '{"query":"x"}' } }],
      }),
    },
  });
  assert.equal(maxTurnRes.nextPort, 'error');
  assert.match(String(maxTurnRes.error), /MAX_TURNS/i);

  // 2. Unallowlisted/admin tool blocked inside loop (does not execute)
  let evilExecuted = false;
  const blockedToolRes = await agentDef.execute({
    node: { id: 'react_blk', type: 'ai.agent' },
    config: { mode: 'react', maxTurns: 2, tools: ['memory_recall'], prompt: 'Try evil tool' },
    context: { organizationId: 'org-a', runUid: 'run_blk_1' },
    db,
    options: {
      tools: {
        dxos_provision_role_workspace: {
          adminOnly: true,
          async execute() { evilExecuted = true; return { hacked: true }; },
        },
      },
      fetchImpl: async () => makeOaiResponse({
        toolCalls: [{ id: 'c1', type: 'function', function: { name: 'dxos_provision_role_workspace', arguments: '{}' } }],
      }),
    },
  });
  assert.equal(evilExecuted, false);
  assert.equal(blockedToolRes.nextPort, 'error');

  // 3. Mutating tool triggers HITL queue & suspends flow; resumeFlowRun routes approved->main, rejected->error
  let mutatedDirect = false;
  const hitlRule = {
    organizationId: 'org-a',
    ruleKey: 'react_hitl_flow',
    schemaVersion: 2,
    graphJson: {
      version: 2,
      nodes: [
        { id: 't1', type: 'trigger.manual', config: {} },
        {
          id: 'ai1',
          type: 'ai.agent',
          config: {
            mode: 'react',
            maxTurns: 4,
            targetCollection: 'latticeServiceTickets',
            approverRole: 'ldx_manager',
            tools: ['dxos_execute_record_action'],
            prompt: 'Close ticket 99',
          },
        },
        { id: 'ok1', type: 'logic.transform', config: { operations: [{ op: 'set', target: 'done', value: true }] } },
        { id: 'err1', type: 'logic.transform', config: { operations: [{ op: 'set', target: 'rejected', value: true }] } },
      ],
      edges: [
        { id: 'e1', source: 't1', sourceHandle: 'main', target: 'ai1' },
        { id: 'e2', source: 'ai1', sourceHandle: 'main', target: 'ok1' },
        { id: 'e3', source: 'ai1', sourceHandle: 'error', target: 'err1' },
      ],
    },
  };
  await db.getRepository('latticeAutomationRules').create({ values: hitlRule });

  const flowOpts = {
    organizationId: 'org-a',
    tools: {
      dxos_execute_record_action: {
        mutating: true,
        async execute() { mutatedDirect = true; return { ok: true }; },
      },
    },
    fetchImpl: async () => makeOaiResponse({
      toolCalls: [{
        id: 'c_mut',
        type: 'function',
        function: {
          name: 'dxos_execute_record_action',
          arguments: '{"collection":"latticeServiceTickets","operation":"update","recordId":"99","values":{"status":"closed"}}',
        },
      }],
    }),
  };

  // Dry-run does NOT enqueue or suspend
  const dryRun = await executeFlowGraph(db, hitlRule, { organizationId: 'org-a', data: {} }, { ...flowOpts, dryRun: true });
  assert.equal(mutatedDirect, false);
  assert.equal(db.store.latticeAiApprovalQueue?.length || 0, 0);
  assert.equal(dryRun.status, 'completed');

  // Live run enqueues HITL with integer targetRecordId and suspends
  const liveRun = await executeFlowGraph(db, hitlRule, { organizationId: 'org-a', data: {} }, flowOpts);
  assert.equal(mutatedDirect, false);
  assert.equal(liveRun.status, 'suspended');
  assert.equal(liveRun.suspendedNodeId, 'ai1');
  assert.equal(db.store.latticeAiApprovalQueue.length, 1);
  assert.equal(db.store.latticeAiApprovalQueue[0].targetRecordId, 99);
  assert.equal(db.store.latticeAiApprovalQueue[0].toolName, 'dxos_execute_record_action');

  // Approve -> routes to 'main' (ok1)
  const approvedRun = await resumeFlowRun(db, {
    organizationId: 'org-a',
    runUid: liveRun.runUid,
    decision: 'approved',
    resumeToken: liveRun.resumeToken,
    actor: { userId: 7, username: 'mgr' },
  });
  assert.equal(approvedRun.status, 'completed');
  assert.equal(approvedRun.nodeStatesJson.ok1.output.done, true);
  assert.equal(db.store.latticeAiApprovalQueue[0].status, 'approved');

  // Second run rejected -> routes to 'error' (err1)
  const liveRun2 = await executeFlowGraph(db, hitlRule, { organizationId: 'org-a', data: {} }, flowOpts);
  const rejectedRun = await resumeFlowRun(db, {
    organizationId: 'org-a',
    runUid: liveRun2.runUid,
    decision: 'rejected',
    resumeToken: liveRun2.resumeToken,
    actor: { userId: 7, username: 'mgr' },
  });
  assert.equal(rejectedRun.status, 'completed');
  assert.equal(rejectedRun.nodeStatesJson.err1.output.rejected, true);
  assert.equal(db.store.latticeAiApprovalQueue[1].status, 'rejected');
});

test('agent-tools-bridge lazy-loads plugin-dxos-ai tools without circular require and excludes adminOnly builder tools', () => {
  const { resolveAgentTools, isMutatingTool } = require('../src/server/flow/agent-tools-bridge');
  const db = makeAgentDb();
  const { allowedMap } = resolveAgentTools({
    cfg: {
      aiEmployee: 'ops_triage',
      tools: ['memory_recall', 'dxos_search_enterprise_context', 'dxos_execute_record_action', 'dxos_provision_role_workspace'],
    },
    db,
    app: null,
    options: {},
    orgId: 'org-a',
  });
  assert.equal(allowedMap.has('memory_recall'), true);
  assert.equal(allowedMap.has('dxos_search_enterprise_context'), true);
  assert.equal(allowedMap.has('dxos_execute_record_action'), true);
  assert.equal(isMutatingTool('dxos_execute_record_action', allowedMap.get('dxos_execute_record_action')), true);
  assert.equal(allowedMap.has('dxos_provision_role_workspace'), false, 'adminOnly builder tools must never be exposed');
});

test('memory_recall and memory_store align with real latticeAiMemory schema and enforce scope/user/expiry isolation', async () => {
  const path = require('node:path');
  const Module = require('node:module');
  const origLoad = Module._load;
  let aiMemCol;
  Module._load = function mocked(req, parent, isMain) {
    if (req === '@nocobase/database') return { defineCollection: (def) => def };
    return origLoad.call(this, req, parent, isMain);
  };
  try {
    aiMemCol = require(path.resolve(__dirname, '../../plugin-dxos-ai/src/server/collections/ai-memory.js'));
  } finally {
    Module._load = origLoad;
  }
  const realCols = new Set(aiMemCol.fields.map((f) => f.name));
  const { resolveAgentTools } = require('../src/server/flow/agent-tools-bridge');

  const pastIso = new Date(Date.now() - 60_000).toISOString();
  const futureIso = new Date(Date.now() + 3_600_000).toISOString();
  const db = makeAgentDb({
    latticeAiMemory: [
      { id: 1, organizationId: 'org-a', scope: 'org', memoryKey: 'shared_key', content: 'ORG shared SOP', tagsJson: ['sop'], importance: 0.9 },
      { id: 2, organizationId: 'org-a', scope: 'agent', agentId: 'agent-a', memoryKey: 'agent_secret', content: 'Agent A only note', tagsJson: ['secret'], importance: 0.8 },
      { id: 3, organizationId: 'org-a', scope: 'agent', agentId: 'agent-b', memoryKey: 'agent_b_secret', content: 'AGENT_B_PRIVATE_NOTE', tagsJson: ['secret'], importance: 0.8 },
      { id: 4, organizationId: 'org-a', scope: 'user', userId: '7', memoryKey: 'u7_pref', content: 'User 7 dark theme', tagsJson: ['pref'], importance: 0.7 },
      { id: 5, organizationId: 'org-a', scope: 'user', userId: '8', memoryKey: 'u8_pref', content: 'USER_8_PRIVATE_PREF', tagsJson: ['pref'], importance: 0.7 },
      { id: 6, organizationId: 'org-a', scope: 'org', memoryKey: 'expired_fact', content: 'EXPIRED_OLD_FACT', tagsJson: ['sop'], expiresAt: pastIso, importance: 0.9 },
      { id: 7, organizationId: 'org-a', scope: 'org', memoryKey: 'valid_fact', content: 'Valid non-expired SOP fact', tagsJson: ['sop'], expiresAt: futureIso, importance: 0.8 },
    ],
  });

  // Agent-A with userId=7
  const { memoryTools: toolsA } = resolveAgentTools({
    cfg: { aiEmployee: 'agent-a', memoryScope: 'agent', tools: ['memory_recall', 'memory_store'] },
    db,
    app: null,
    options: {},
    orgId: 'org-a',
    context: { actor: { userId: 7, username: 'u7' } },
  });

  // Expiry filtering
  const expRecall = await toolsA.memory_recall.execute({ query: 'SOP', scope: 'org', limit: 10 });
  assert.equal(expRecall.items.some((i) => i.content.includes('EXPIRED_OLD_FACT')), false, 'Expired memory must not be recalled');
  assert.equal(expRecall.items.some((i) => i.content.includes('Valid non-expired SOP fact')), true);

  // Agent scope isolation via agentId
  const agentRecall = await toolsA.memory_recall.execute({ query: 'note', scope: 'agent', limit: 10 });
  assert.equal(agentRecall.items.some((i) => i.content.includes('Agent A only note')), true);
  assert.equal(agentRecall.items.some((i) => i.content.includes('AGENT_B_PRIVATE_NOTE')), false, 'Must isolate by agentId');

  // User scope isolation via userId
  const userRecall = await toolsA.memory_recall.execute({ query: 'theme pref', scope: 'user', limit: 10 });
  assert.equal(userRecall.items.some((i) => i.content.includes('User 7 dark theme')), true);
  assert.equal(userRecall.items.some((i) => i.content.includes('USER_8_PRIVATE_PREF')), false, 'Must isolate by userId');

  // Null actor cannot read user-scoped memories
  const { memoryTools: toolsAnon } = resolveAgentTools({
    cfg: { aiEmployee: 'agent-a', memoryScope: 'org', tools: ['memory_recall'] },
    db,
    app: null,
    options: {},
    orgId: 'org-a',
    context: { actor: null },
  });
  const anonUserRecall = await toolsAnon.memory_recall.execute({ query: 'theme pref', scope: 'user', limit: 10 });
  assert.equal(anonUserRecall.count, 0, 'Null actor must not recall user-scoped memories');

  // memory_store writes only real latticeAiMemory columns and never overwrites org memory on key collision from agent scope
  const storeRes = await toolsA.memory_store.execute({
    memoryKey: 'shared_key',
    title: 'Agent Override',
    content: 'Agent A specific override',
    scope: 'agent',
    tags: ['agent-tag'],
    importance: 7,
  });
  assert.equal(storeRes.ok, true);
  const orgRow = db.store.latticeAiMemory.find((r) => r.scope === 'org' && r.memoryKey === 'shared_key');
  const agentRow = db.store.latticeAiMemory.find((r) => r.scope === 'agent' && r.memoryKey === 'shared_key');
  assert.equal(orgRow.content, 'ORG shared SOP', 'agent scope store must not overwrite org scope row on memoryKey collision');
  assert.ok(agentRow, 'agent scope store must create distinct agent row');
  assert.equal(agentRow.agentId, 'agent-a');
  assert.equal(agentRow.metadataJson?.title, 'Agent Override');
  for (const colKey of Object.keys(agentRow)) {
    if (['id', 'createdAt', 'updatedAt'].includes(colKey)) continue;
    assert.ok(realCols.has(colKey), `Unexpected column "${colKey}" not in real latticeAiMemory schema`);
  }
});

test('ai.agent ReAct persists real OTel GenAI attributesJson and root invoke_agent spanId/parentSpanId hierarchy', async () => {
  const path = require('node:path');
  const otelExporter = require(path.resolve(__dirname, '../../plugin-lattice-foundation/src/server/otel-exporter.js'));
  const { createDefaultRegistry } = require('../src/server/flow/registry');
  const agentDef = createDefaultRegistry().getNodeType('ai.agent');
  const db = makeAgentDb({
    llmServices: [{ id: 1, name: 'local-9router', enabled: true, options: { baseURL: 'https://llm.example.com/v1', apiKey: 'sk-test-1234' } }],
  });

  let turn = 0;
  const res = await agentDef.execute({
    node: { id: 'react_otel', type: 'ai.agent' },
    config: { mode: 'react', maxTurns: 4, aiEmployee: 'ops_triage', tools: ['dxos_ping'], prompt: 'Ping system' },
    context: { organizationId: 'org-a', runUid: 'run_otel_1' },
    db,
    options: {
      otelExporter,
      tools: {
        dxos_ping: {
          description: 'Ping',
          parameters: { type: 'object', properties: {} },
          async execute() { return { pong: true }; },
        },
      },
      fetchImpl: async () => {
        turn += 1;
        if (turn === 1) {
          return makeOaiResponse({
            toolCalls: [{ id: 'c1', type: 'function', function: { name: 'dxos_ping', arguments: '{}' } }],
          });
        }
        return makeOaiResponse({ content: 'All clear' });
      },
    },
  });
  assert.equal(res.nextPort, 'main');
  const listed = await otelExporter.listGenAiTraces(db, { organizationId: 'org-a', runUid: 'run_otel_1' });
  assert.ok(listed.items.length >= 3, 'Expected invoke_agent, chat, and execute_tool traces persisted');
  const rootSpan = listed.items.find((t) => t.operationName === 'invoke_agent');
  assert.ok(rootSpan, 'invoke_agent trace must be persisted');
  assert.equal(rootSpan.parentSpanId, null, 'invoke_agent root span must have parentSpanId === null');
  assert.equal(rootSpan.attributesJson?.['gen_ai.operation.name'], 'invoke_agent', 'attributesJson must be populated in latticeAiTraces');
  assert.equal(rootSpan.attributesJson?.['gen_ai.agent.name'], 'ops_triage');
  const childSpans = listed.items.filter((t) => t.operationName !== 'invoke_agent');
  assert.ok(childSpans.length >= 2);
  for (const child of childSpans) {
    assert.equal(child.parentSpanId, rootSpan.spanId, `Child span ${child.operationName} must reference invoke_agent spanId as parentSpanId`);
    assert.equal(child.attributesJson?.['gen_ai.operation.name'], child.operationName);
  }
});

test('ai.agent ReAct invokes real plugin-dxos-ai dxos_search_enterprise_context with context.actor = null without privilege escalation', async () => {
  const { createDefaultRegistry } = require('../src/server/flow/registry');
  const agentDef = createDefaultRegistry().getNodeType('ai.agent');
  const db = makeAgentDb({
    llmServices: [{ id: 1, name: 'local-9router', enabled: true, options: { baseURL: 'https://llm.example.com/v1', apiKey: 'sk-test-1234' } }],
    latticeEmployees: [
      { id: 1, userId: 22, organizationId: 'org-a', active: true, username: 'op_22' },
    ],
    rolesUsers: [
      { userId: 22, roleName: 'ldx_operator' },
    ],
    dataSourcesRolesResources: [
      {
        id: 1,
        name: 'latticeAssets',
        dataSourceKey: 'main',
        roleName: 'ldx_operator',
        actions: [{ name: 'view' }],
      },
    ],
    latticeAssets: [
      { id: 10, organizationId: 'org-a', code: 'CHILLER-09', name: 'Cold Chiller 09', status: 'active' },
    ],
  });

  let turn = 0;
  const res = await agentDef.execute({
    node: { id: 'react_real_tool', type: 'ai.agent' },
    config: {
      mode: 'react',
      maxTurns: 4,
      aiEmployee: 'ops_triage',
      tools: ['dxos_search_enterprise_context'],
      prompt: 'Find CHILLER-09 status',
    },
    context: { organizationId: 'org-a', runUid: 'run_auto_trigger_1', actor: null },
    db,
    options: {
      fetchImpl: async () => {
        turn += 1;
        if (turn === 1) {
          return makeOaiResponse({
            toolCalls: [{
              id: 'c_real_1',
              type: 'function',
              function: { name: 'dxos_search_enterprise_context', arguments: '{"query":"CHILLER-09","collections":["latticeAssets"]}' },
            }],
          });
        }
        return makeOaiResponse({ content: 'Found CHILLER-09 active' });
      },
    },
  });
  assert.equal(res.nextPort, 'main');
  const toolTrace = res.output.toolCalls.find((tc) => tc.name === 'dxos_search_enterprise_context');
  assert.ok(toolTrace);
  assert.equal(toolTrace.status, 'completed', `Expected tool completion, got error: ${toolTrace.result?.error}`);
  assert.ok(JSON.stringify(toolTrace.result).includes('CHILLER-09'));
});

test('MUTATING_TOOL_NAMES includes dxos_orchestrate_enterprise_case and dxos_memory_forget, and json-schema-validator ignores null/empty numeric limits', () => {
  const { resolveAgentTools, isMutatingTool } = require('../src/server/flow/agent-tools-bridge');
  const { validateJsonAgainstSchema } = require('../src/server/flow/json-schema-validator');
  const db = makeAgentDb();
  const { allowedMap } = resolveAgentTools({
    cfg: { tools: ['dxos_orchestrate_enterprise_case', 'dxos_memory_forget'] },
    db,
    app: null,
    options: {},
    orgId: 'org-a',
  });
  assert.equal(isMutatingTool('dxos_orchestrate_enterprise_case', allowedMap.get('dxos_orchestrate_enterprise_case')), true);
  assert.equal(isMutatingTool('dxos_memory_forget', allowedMap.get('dxos_memory_forget')), true);
  assert.equal(isMutatingTool('custom_ask_tool', { defaultPermission: 'ASK' }), true);

  const schemaRes = validateJsonAgainstSchema(
    { name: 'hello', score: -5 },
    {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: null, maxLength: '' },
        score: { type: 'number', minimum: null, maximum: '' },
      },
    },
  );
  assert.equal(schemaRes.ok, true, `null/empty limits should not coerce to 0: ${JSON.stringify(schemaRes.errors)}`);
});

test('resolveAutomationActor strictly clamps unattended and roleless actors to ldx_operator against allowConfigure/pm custom roles', async () => {
  const path = require('node:path');
  const aiToolsCore = require(path.resolve(__dirname, '../../plugin-dxos-ai/src/server/ai-tools-core.js'));
  const { invokeResolvedTool } = require('../src/server/flow/agent-tools-bridge');
  const provisionTool = aiToolsCore.createDxosTools().find((t) => t.definition?.name === 'dxos_provision_role_workspace');
  assert.ok(provisionTool, 'dxos_provision_role_workspace tool must exist in plugin-dxos-ai');

  const db = makeAgentDb({
    latticeEmployees: [
      { id: 1, userId: 88, organizationId: 'org-a', active: true, username: 'arch_88' },
      { id: 2, userId: 1, organizationId: 'org-a', active: true, username: 'root_1' },
    ],
    rolesUsers: [
      { userId: 88, roleName: 'custom_architect' },
      { userId: 1, roleName: 'root' },
    ],
    roles: [
      { name: 'custom_architect', allowConfigure: true, snippets: ['pm'] },
      { name: 'ldx_operator', allowConfigure: false, snippets: [] },
    ],
  });

  // 1. Unattended flow (actor: null) must NOT escalate via custom_architect (allowConfigure: true / pm)
  await assert.rejects(
    () => invokeResolvedTool(provisionTool, { operation: 'list_built_apps' }, { db, app: null, context: { actor: null }, cfg: {}, orgId: 'org-a' }),
    (err) => err.status === 403 && err.code === 'DXOS_ADMIN_REQUIRED',
  );

  // 2. Roleless partial actor ({ userId: 1 }) must clamp to ['ldx_operator'] and NOT fall back to DB root
  await assert.rejects(
    () => invokeResolvedTool(provisionTool, { operation: 'list_built_apps' }, { db, app: null, context: { actor: { userId: 1 } }, cfg: {}, orgId: 'org-a' }),
    (err) => err.status === 403 && err.code === 'DXOS_ADMIN_REQUIRED',
  );

  // 3. Spy invoke verifies non-privileged employee preference + strict ['ldx_operator'] clamping + non-string role stripping
  const dbWithOp = makeAgentDb({
    latticeEmployees: [
      { id: 1, userId: 88, organizationId: 'org-a', active: true, username: 'arch_88' },
      { id: 2, userId: 42, organizationId: 'org-a', active: true, username: 'op_42' },
    ],
    rolesUsers: [
      { userId: 88, roleName: 'custom_architect' },
      { userId: 42, roleName: 'ldx_operator' },
    ],
    roles: [
      { name: 'custom_architect', allowConfigure: true, snippets: ['pm.*'] },
      { name: 'ldx_operator', allowConfigure: false, snippets: [] },
    ],
  });
  const seenStates = [];
  const spyTool = { name: 'spy_tool', async invoke(subCtx) { seenStates.push(subCtx.state); return { ok: true }; } };
  await invokeResolvedTool(spyTool, {}, { db: dbWithOp, app: null, context: { actor: null }, cfg: {}, orgId: 'org-a' });
  assert.equal(seenStates[0].currentUser.id, 42);
  assert.deepEqual(seenStates[0].currentRoles, ['ldx_operator']);

  await invokeResolvedTool(spyTool, {}, { db: dbWithOp, app: null, context: { actor: { userId: 1, roles: ['', null, 123] } }, cfg: {}, orgId: 'org-a' });
  assert.equal(seenStates[1].currentUser.id, 1);
  assert.deepEqual(seenStates[1].currentRoles, ['ldx_operator']);
});

test('memory_store updates Sequelize .get()-only model rows in place and memory_recall isolates unsupported scopes such as session', async () => {
  const { resolveAgentTools } = require('../src/server/flow/agent-tools-bridge');
  const rows = [];
  let seq = 1;
  const wrapSequelize = (row) => ({
    get(k) { return row[k]; },
    toJSON() { return { ...row }; },
  });
  const seqDb = {
    getRepository(name) {
      if (name !== 'latticeAiMemory') return null;
      return {
        async find({ filter = {} } = {}) {
          return rows
            .filter((r) => Object.entries(filter).every(([k, v]) => r[k] === v))
            .map(wrapSequelize);
        },
        async findOne({ filter = {} } = {}) {
          const hit = rows.find((r) => Object.entries(filter).every(([k, v]) => r[k] === v));
          return hit ? wrapSequelize(hit) : null;
        },
        async create({ values }) {
          const rec = { id: seq++, ...structuredClone(values) };
          rows.push(rec);
          return wrapSequelize(rec);
        },
        async update({ filter = {}, values }) {
          let n = 0;
          for (const r of rows) {
            if (Object.entries(filter).every(([k, v]) => r[k] === v)) {
              Object.assign(r, structuredClone(values));
              n += 1;
            }
          }
          return [n];
        },
      };
    },
  };

  const { memoryTools } = resolveAgentTools({
    cfg: { aiEmployee: 'agent-seq', memoryScope: 'agent', tools: ['memory_recall', 'memory_store'] },
    db: seqDb,
    app: null,
    options: {},
    orgId: 'org-a',
    context: { sessionId: 'sess-1' },
  });

  const first = await memoryTools.memory_store.execute({ memoryKey: 'k1', scope: 'agent', content: 'version-1' });
  assert.equal(first.stored, true);
  const second = await memoryTools.memory_store.execute({ memoryKey: 'k1', scope: 'agent', content: 'version-2' });
  assert.equal(second.updated, true, 'Sequelize .get()-only model must update in place');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content, 'version-2');

  const sessEmpty = await memoryTools.memory_recall.execute({ query: 'version', scope: 'session', limit: 10 });
  assert.equal(sessEmpty.count, 0, 'scope=session must not fall back to org/agent/user rows');
  assert.deepEqual(sessEmpty.items, []);

  rows.push(
    { id: seq++, organizationId: 'org-a', scope: 'session', sessionId: 'sess-1', memoryKey: 's1', content: 'session one note', importance: 0.5 },
    { id: seq++, organizationId: 'org-a', scope: 'session', sessionId: 'sess-2', memoryKey: 's2', content: 'session two secret', importance: 0.5 },
  );
  const sessMatched = await memoryTools.memory_recall.execute({ query: 'session', scope: 'session', limit: 10 });
  assert.equal(sessMatched.count, 1);
  assert.equal(sessMatched.items[0].memoryKey, 's1');
});

test('ai.agent ReAct emits root invoke_agent span on HITL suspension and unallowlisted tool early exits', async () => {
  const path = require('node:path');
  const otelExporter = require(path.resolve(__dirname, '../../plugin-lattice-foundation/src/server/otel-exporter.js'));
  const { createDefaultRegistry } = require('../src/server/flow/registry');
  const agentDef = createDefaultRegistry().getNodeType('ai.agent');

  const dbHitl = makeAgentDb({
    llmServices: [{ id: 1, name: 'local-9router', enabled: true, options: { baseURL: 'https://llm.example.com/v1', apiKey: 'sk-test-1234' } }],
  });
  const hitlRes = await agentDef.execute({
    node: { id: 'react_hitl_otel', type: 'ai.agent' },
    config: { mode: 'react', maxTurns: 3, aiEmployee: 'ops_triage', tools: ['dxos_memory_forget'], prompt: 'Forget memory' },
    context: { organizationId: 'org-a', runUid: 'run_hitl_otel_1' },
    db: dbHitl,
    options: {
      otelExporter,
      tools: { dxos_memory_forget: { description: 'Forget', parameters: { type: 'object' }, async execute() { return { ok: true }; } } },
      fetchImpl: async () => makeOaiResponse({
        toolCalls: [{ id: 'c_forget', type: 'function', function: { name: 'dxos_memory_forget', arguments: '{"memoryKey":"k1"}' } }],
      }),
    },
  });
  assert.equal(hitlRes.suspend?.kind, 'approval');

  const hitlTraces = await otelExporter.listGenAiTraces(dbHitl, { organizationId: 'org-a', runUid: 'run_hitl_otel_1' });
  const hitlRoot = hitlTraces.items.find((t) => t.operationName === 'invoke_agent');
  assert.ok(hitlRoot, 'HITL suspension must emit root invoke_agent span');
  assert.equal(hitlRoot.parentSpanId, null);
  assert.equal(hitlRoot.status, 'suspended');
  for (const child of hitlTraces.items.filter((t) => t.operationName !== 'invoke_agent')) {
    assert.equal(child.parentSpanId, hitlRoot.spanId);
  }

  const dbBlocked = makeAgentDb({
    llmServices: [{ id: 1, name: 'local-9router', enabled: true, options: { baseURL: 'https://llm.example.com/v1', apiKey: 'sk-test-1234' } }],
  });
  const blkRes = await agentDef.execute({
    node: { id: 'react_blk_otel', type: 'ai.agent' },
    config: { mode: 'react', maxTurns: 3, aiEmployee: 'ops_triage', tools: ['memory_recall'], prompt: 'Run disallowed tool' },
    context: { organizationId: 'org-a', runUid: 'run_blk_otel_1' },
    db: dbBlocked,
    options: {
      otelExporter,
      fetchImpl: async () => makeOaiResponse({
        toolCalls: [{ id: 'c_evil', type: 'function', function: { name: 'dxos_provision_role_workspace', arguments: '{}' } }],
      }),
    },
  });
  assert.equal(blkRes.nextPort, 'error');

  const blkTraces = await otelExporter.listGenAiTraces(dbBlocked, { organizationId: 'org-a', runUid: 'run_blk_otel_1' });
  const blkRoot = blkTraces.items.find((t) => t.operationName === 'invoke_agent');
  assert.ok(blkRoot, 'Unallowlisted tool exit must emit root invoke_agent span');
  assert.equal(blkRoot.parentSpanId, null);
  assert.equal(blkRoot.status, 'error');
  for (const child of blkTraces.items.filter((t) => t.operationName !== 'invoke_agent')) {
    assert.equal(child.parentSpanId, blkRoot.spanId);
  }
});

test('ai.agent ReAct emits root invoke_agent error span when enqueueAgentHitlApproval throws', async () => {
  const path = require('node:path');
  const otelExporter = require(path.resolve(__dirname, '../../plugin-lattice-foundation/src/server/otel-exporter.js'));
  const { createDefaultRegistry } = require('../src/server/flow/registry');
  const agentDef = createDefaultRegistry().getNodeType('ai.agent');

  const baseDb = makeAgentDb({
    llmServices: [{ id: 1, name: 'local-9router', enabled: true, options: { baseURL: 'https://llm.example.com/v1', apiKey: 'sk-test-1234' } }],
  });
  const dbNoQueue = {
    ...baseDb,
    getRepository(name) {
      if (name === 'latticeAiApprovalQueue') return null;
      return baseDb.getRepository(name);
    },
  };

  await assert.rejects(
    () => agentDef.execute({
      node: { id: 'react_hitl_no_q', type: 'ai.agent' },
      config: { mode: 'react', maxTurns: 3, aiEmployee: 'ops_triage', tools: ['dxos_memory_forget'], prompt: 'Forget memory' },
      context: { organizationId: 'org-a', runUid: 'run_hitl_no_queue_1' },
      db: dbNoQueue,
      options: {
        otelExporter,
        tools: { dxos_memory_forget: { description: 'Forget', parameters: { type: 'object' }, async execute() { return { ok: true }; } } },
        fetchImpl: async () => makeOaiResponse({
          toolCalls: [{ id: 'c_forget', type: 'function', function: { name: 'dxos_memory_forget', arguments: '{"memoryKey":"k1"}' } }],
        }),
      },
    }),
    (err) => err?.code === 'AGENT_HITL_QUEUE_UNAVAILABLE' && err?.status === 503,
  );

  const traces = await otelExporter.listGenAiTraces(dbNoQueue, { organizationId: 'org-a', runUid: 'run_hitl_no_queue_1' });
  const root = traces.items.find((t) => t.operationName === 'invoke_agent');
  assert.ok(root, 'Missing latticeAiApprovalQueue must still emit root invoke_agent error span');
  assert.equal(root.parentSpanId, null);
  assert.equal(root.status, 'error');
  assert.match(String(root.errorMessage || ''), /latticeAiApprovalQueue/);
  for (const child of traces.items.filter((t) => t.operationName !== 'invoke_agent')) {
    assert.equal(child.parentSpanId, root.spanId, 'Child span must not be orphaned');
  }
});

