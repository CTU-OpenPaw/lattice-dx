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
const { readFileSync } = require('node:fs');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');

function makeTraceEvalMockDb({ includeTracesCollection = true } = {}) {
  const stores = {
    ...(includeTracesCollection ? { latticeAiTraces: [] } : {}),
    latticeAiAuditLogs: [],
  };
  let seq = 1;

  function matchesFilter(row, filter = {}) {
    return Object.entries(filter).every(([k, cond]) => {
      if (cond && typeof cond === 'object' && '$in' in cond) {
        return cond.$in.includes(row[k]);
      }
      return String(row[k]) === String(cond);
    });
  }

  function makeRepo(name) {
    const arr = stores[name];
    if (!arr) return null;
    const wrap = (row) => ({
      ...row,
      get: (k) => row[k],
      set: (k, v) => { row[k] = v; },
    });
    return {
      async find({ filter = {}, sort, limit } = {}) {
        let rows = arr.filter((r) => matchesFilter(r, filter));
        if (Array.isArray(sort) && sort.includes('-id')) {
          rows = [...rows].sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
        }
        if (limit) rows = rows.slice(0, limit);
        return rows.map(wrap);
      },
      async create({ values = {} } = {}) {
        const row = { id: ++seq, createdAt: new Date().toISOString(), ...values };
        arr.push(row);
        return wrap(row);
      },
    };
  }

  return {
    stores,
    hasCollection: (name) => Boolean(stores[name]),
    getRepository: (name) => makeRepo(name),
  };
}

test('ai-eval-lab enforces strict fail-closed organizationId isolation across traces, OTel spans, and eval runs', async () => {
  const {
    listAgentTraces,
    getAgentTraceDetail,
    runEvalBenchmark,
  } = require(path.join(PLUGIN_ROOT, 'src/server/ai-eval-lab.js'));

  const db = makeTraceEvalMockDb({ includeTracesCollection: true });
  db.stores.latticeAiTraces.push(
    {
      id: 1,
      organizationId: 'org-b',
      traceId: 'trace-org-b-secret',
      spanId: 'span-b1',
      name: 'invoke_agent dxos-ops',
      agentName: 'dxos-ops',
      status: 'ok',
      startTimeMs: 1700000000000,
      durationMs: 120,
      attributesJson: { secretInfo: 'org-b-only' },
    },
  );
  db.stores.latticeAiAuditLogs.push({
    id: 10,
    organizationId: 'org-b',
    aiEmployee: 'dxos-ops',
    toolName: 'dxos_alarm_action',
    status: 'allowed',
    durationMs: 45,
    promptTokens: 50,
    completionTokens: 20,
    createdAt: '2026-11-25T10:00:00.000Z',
  });

  const otelExporter = {
    getBufferedSpans: () => [
      {
        traceId: 'trace-otel-no-org',
        spanId: 'span-no-org',
        name: 'unscoped-span',
        startTimeUnixNano: '1700000001000000000',
        endTimeUnixNano: '1700000001050000000',
        attributes: [{ key: 'gen_ai.operation.name', value: { stringValue: 'chat' } }],
      },
      {
        traceId: 'trace-otel-org-b',
        spanId: 'span-otel-b',
        name: 'org-b-otel-span',
        startTimeUnixNano: '1700000001000000000',
        endTimeUnixNano: '1700000001050000000',
        attributes: [{ key: 'dxos.organization_id', value: { stringValue: 'org-b' } }],
      },
    ],
  };

  for (const badOrg of [undefined, '', '   ', 'all', 'ALL', 'bad org/../../etc']) {
    await assert.rejects(
      () => listAgentTraces(db, { organizationId: badOrg, otelExporter }),
      (err) => err.status === 400 && (err.code === 'ORGANIZATION_ID_REQUIRED' || err.code === 'INVALID_ORG_ID'),
    );
    await assert.rejects(
      () => getAgentTraceDetail(db, { organizationId: badOrg, traceId: 'trace-org-b-secret', otelExporter }),
      (err) => err.status === 400,
    );
    await assert.rejects(
      () => runEvalBenchmark(db, { organizationId: badOrg, suiteId: 'security-red-team' }),
      (err) => err.status === 400,
    );
  }

  // org-a sees zero traces from org-b or unscoped OTel spans
  const orgAList = await listAgentTraces(db, { organizationId: 'org-a', otelExporter });
  assert.equal(orgAList.organizationId, 'org-a');
  assert.equal(orgAList.total, 0);
  assert.deepEqual(orgAList.items, []);

  // Direct traceId lookup across tenant boundary returns null
  const crossTenantDetail = await getAgentTraceDetail(db, {
    organizationId: 'org-a',
    traceId: 'trace-org-b-secret',
    otelExporter,
  });
  assert.equal(crossTenantDetail, null);
});

test('ai-eval-lab builds accurate waterfall hierarchy, merges OTel & audit fallback, handles missing latticeAiTraces, and redacts secrets/PII', async () => {
  const {
    listAgentTraces,
    getAgentTraceDetail,
    buildWaterfallSpans,
  } = require(path.join(PLUGIN_ROOT, 'src/server/ai-eval-lab.js'));

  const db = makeTraceEvalMockDb({ includeTracesCollection: true });
  const baseMs = 1700000000000;
  db.stores.latticeAiTraces.push(
    {
      id: 1,
      organizationId: 'org-a',
      traceId: 'trace-react-001',
      spanId: 'sp-root',
      parentSpanId: null,
      name: 'invoke_agent dxos-architect',
      agentName: 'dxos-architect',
      genAiOperationName: 'invoke_agent',
      genAiSystem: 'openai-completions',
      modelName: 'ag/gemini-3.8-flash',
      inputTokens: 120,
      outputTokens: 45,
      piiRedactedCount: 1,
      status: 'ok',
      startTimeMs: baseMs,
      endTimeMs: baseMs + 420,
      attributesJson: {
        authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.abcdef1234.sig123',
        promptPreview: 'Liên hệ admin@example.com và sk-live-secret998877',
      },
    },
    {
      id: 2,
      organizationId: 'org-a',
      traceId: 'trace-react-001',
      spanId: 'sp-tool-1',
      parentSpanId: 'sp-root',
      name: 'execute_tool dxos_search_enterprise_context',
      agentName: 'dxos-architect',
      genAiOperationName: 'execute_tool',
      genAiSystem: 'latticedx',
      inputTokens: 0,
      outputTokens: 0,
      status: 'ok',
      startTimeMs: baseMs + 150,
      endTimeMs: baseMs + 280,
      attributesJson: {
        api_key: 'sk-should-be-redacted',
        note: 'Found 3 lots',
      },
    },
    {
      id: 3,
      organizationId: 'org-a',
      traceId: 'trace-react-001',
      spanId: 'sp-llm-1',
      parentSpanId: 'sp-root',
      name: 'chat ag/gemini-3.8-flash',
      agentName: 'dxos-architect',
      genAiOperationName: 'chat',
      genAiSystem: 'openai-completions',
      modelName: 'ag/gemini-3.8-flash',
      inputTokens: 300,
      outputTokens: 90,
      status: 'ok',
      startTimeMs: baseMs + 30,
      endTimeMs: baseMs + 140,
      attributesJson: {
        '__proto__': { polluted: true },
        temperature: 0.2,
      },
    },
  );

  // Also add an OTel span in org-a for the same trace (nested under sp-tool-1) and an audit fallback trace
  const otelExporter = {
    getBufferedSpans: () => [
      {
        traceId: 'trace-react-001',
        spanId: 'sp-sub-db',
        parentSpanId: 'sp-tool-1',
        name: 'pg.query latticeStockLots',
        startTimeUnixNano: String(BigInt(baseMs + 170) * 1_000_000n),
        endTimeUnixNano: String(BigInt(baseMs + 230) * 1_000_000n),
        attributes: [
          { key: 'dxos.organization_id', value: { stringValue: 'org-a' } },
          { key: 'gen_ai.operation.name', value: { stringValue: 'execute_tool' } },
          { key: 'token', value: { stringValue: 'secret-token-val' } },
        ],
        status: { code: 1 },
      },
    ],
  };

  db.stores.latticeAiAuditLogs.push({
    id: 21,
    organizationId: 'org-a',
    aiEmployee: 'dxos-ops',
    toolName: 'dxos_alarm_action',
    status: 'denied',
    errorCode: 'HITL_REQUIRED',
    durationMs: 25,
    promptTokens: 40,
    completionTokens: 15,
    piiRedactedCount: 2,
    createdAt: '2026-11-25T11:00:00.000Z',
    argsSummary: { apiKey: 'sk-1234567890' },
  });

  const listRes = await listAgentTraces(db, { organizationId: 'org-a', otelExporter });
  assert.equal(listRes.total, 2);
  assert.equal(listRes.sources.latticeAiTraces, 3);
  assert.equal(listRes.sources.otelExporter, 1);

  const filteredByAgent = await listAgentTraces(db, { organizationId: 'org-a', agent: 'dxos-architect', otelExporter });
  assert.equal(filteredByAgent.total, 1);
  assert.equal(filteredByAgent.items[0].traceId, 'trace-react-001');
  assert.equal(filteredByAgent.items[0].spanCount, 4);

  const filteredByStatus = await listAgentTraces(db, { organizationId: 'org-a', status: 'error', otelExporter });
  assert.equal(filteredByStatus.total, 1);
  assert.equal(filteredByStatus.items[0].traceId, 'audit-21');

  const detail = await getAgentTraceDetail(db, {
    organizationId: 'org-a',
    traceId: 'trace-react-001',
    otelExporter,
  });
  assert.ok(detail);
  assert.equal(detail.totalDurationMs, 420);
  assert.equal(detail.totalInputTokens, 420);
  assert.equal(detail.totalOutputTokens, 135);
  assert.equal(detail.totalTokens, 555);
  assert.equal(detail.piiRedactedCount, 1);

  // Pre-order DFS sorted by startOffsetMs: sp-root (0ms, depth 0) -> sp-llm-1 (30ms, depth 1) -> sp-tool-1 (150ms, depth 1) -> sp-sub-db (170ms, depth 2)
  assert.deepEqual(
    detail.spans.map((s) => [s.spanId, s.depth, s.startOffsetMs, s.durationMs]),
    [
      ['sp-root', 0, 0, 420],
      ['sp-llm-1', 1, 30, 110],
      ['sp-tool-1', 1, 150, 130],
      ['sp-sub-db', 2, 170, 60],
    ],
  );
  assert.equal(detail.spans[0]['gen_ai.operation.name'], 'invoke_agent');
  assert.equal(detail.spans[0]['gen_ai.system'], 'openai-completions');
  assert.equal(detail.spans[0]['gen_ai.request.model'], 'ag/gemini-3.8-flash');

  // Verify secret & PII redaction
  const dumped = JSON.stringify(detail);
  assert.equal(dumped.includes('eyJhbGciOiJIUzI1NiJ9'), false);
  assert.equal(dumped.includes('sk-live-secret998877'), false);
  assert.equal(dumped.includes('sk-should-be-redacted'), false);
  assert.equal(dumped.includes('secret-token-val'), false);
  assert.equal(dumped.includes('admin@example.com'), false);
  assert.ok(dumped.includes('[REDACTED'));
  assert.equal(({}).polluted, undefined);

  // Cycle protection test
  const cyclic = buildWaterfallSpans([
    { traceId: 't-cyc', spanId: 'a', parentSpanId: 'b', startMs: 100, endMs: 150, durationMs: 50, 'gen_ai.usage.input_tokens': 1, 'gen_ai.usage.output_tokens': 1 },
    { traceId: 't-cyc', spanId: 'b', parentSpanId: 'a', startMs: 110, endMs: 140, durationMs: 30, 'gen_ai.usage.input_tokens': 1, 'gen_ai.usage.output_tokens': 1 },
  ]);
  assert.equal(cyclic.spans.length, 2);

  // Graceful behavior when latticeAiTraces is NOT migrated/present in DB
  const noTracesDb = makeTraceEvalMockDb({ includeTracesCollection: false });
  noTracesDb.stores.latticeAiAuditLogs.push({
    id: 5,
    organizationId: 'org-a',
    aiEmployee: 'dxos-workspace',
    toolName: 'dxos_search_enterprise_context',
    status: 'allowed',
    durationMs: 18,
    promptTokens: 30,
    completionTokens: 10,
    createdAt: '2026-11-25T12:00:00.000Z',
  });
  const fallbackList = await listAgentTraces(noTracesDb, { organizationId: 'org-a' });
  assert.equal(fallbackList.total, 1);
  assert.equal(fallbackList.items[0].source, 'latticeAiAuditLogs');
});

test('ai-eval-lab runs deterministic & custom/LLM benchmarks genuinely without hardcoded results', async () => {
  const {
    listEvalSuites,
    runEvalBenchmark,
  } = require(path.join(PLUGIN_ROOT, 'src/server/ai-eval-lab.js'));

  const suites = listEvalSuites();
  assert.ok(suites.some((s) => s.id === 'vietnamese-nl-agent'));
  assert.ok(suites.some((s) => s.id === 'wave1-3-capabilities'));
  assert.ok(suites.some((s) => s.id === 'security-red-team'));
  assert.ok(suites.some((s) => s.id === 'custom'));

  const db = makeTraceEvalMockDb();
  const fullRun = await runEvalBenchmark(db, {
    organizationId: 'org-a',
    suiteId: 'vietnamese-nl-agent',
  });
  assert.ok(fullRun.total >= 163);
  assert.equal(fullRun.passRate, 100);
  assert.equal(fullRun.failed, 0);
  assert.ok(fullRun.avgLatencyMs >= 0);
  assert.ok(db.stores.latticeAiAuditLogs.some((l) => l.toolName === 'dxosAi:runEvalBenchmark'));

  // Genuine pass/fail calculation with mixed custom cases (1 pass, 1 fail -> 50%)
  const customRun = await runEvalBenchmark(db, {
    organizationId: 'org-a',
    suiteId: 'custom',
    customCases: [
      {
        id: 'c-pass',
        prompt: 'Lập kế hoạch dry-run cho ứng dụng vendor-po-suite',
        isAdmin: true,
        expectedTool: 'dxos_provision_role_workspace',
        refused: false,
      },
      {
        id: 'c-fail',
        prompt: 'Tìm tài liệu SOP kho lạnh',
        isAdmin: false,
        expectedTool: 'dxos_nonexistent_tool',
        refused: false,
      },
    ],
  });
  assert.equal(customRun.total, 2);
  assert.equal(customRun.passed, 1);
  assert.equal(customRun.failed, 1);
  assert.equal(customRun.passRate, 50);
  assert.equal(customRun.failures[0].id, 'c-fail');
  assert.match(customRun.failures[0].diagnostic, /dxos_nonexistent_tool/);

  // LLM mode fails closed without llmInvoker and aggregates real metrics when provided
  await assert.rejects(
    () => runEvalBenchmark(db, { organizationId: 'org-a', suiteId: 'security-red-team', mode: 'llm' }),
    (err) => err.code === 'LLM_INVOKER_REQUIRED',
  );
  const llmRun = await runEvalBenchmark(db, {
    organizationId: 'org-a',
    suiteId: 'security-red-team',
    limit: 2,
    mode: 'llm',
    modelName: 'oc/big-pickle',
    llmInvoker: async () => ({
      refused: true,
      toolName: null,
      inputTokens: 45,
      outputTokens: 12,
      model: 'oc/big-pickle',
    }),
  });
  assert.equal(llmRun.total, 2);
  assert.equal(llmRun.passRate, 100);
  assert.equal(llmRun.totalInputTokens, 90);
  assert.equal(llmRun.totalOutputTokens, 24);
});

test('ai-trace-eval-panel.js has ZERO external npm require() imports and renders Trace Waterfall & Eval Lab via React.createElement', () => {
  const clientFilePath = path.join(PLUGIN_ROOT, 'src/client/ai-trace-eval-panel.js');
  const source = readFileSync(clientFilePath, 'utf8');

  // Verify build.mjs bundler invariant: zero non-relative require() calls
  const matches = [...source.matchAll(/require\(['"]([^'"]+)['"]\)/g)];
  for (const m of matches) {
    assert.ok(m[1].startsWith('.'), `Unexpected external require() in client module: ${m[1]}`);
  }
  assert.equal(matches.length, 0);

  const {
    computeWaterfallBars,
    summarizeEvalResults,
    AiTraceWaterfallPanel,
    AiEvalLabPanel,
    createAiTraceWaterfallPanel,
    createAiEvalLabPanel,
  } = require(clientFilePath);

  const React = {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
  };

  const sampleDetail = {
    traceId: 'trace-ui-001',
    summary: { agentName: 'dxos-architect', model: 'ag/gemini-3.8-flash', status: 'ok' },
    totalDurationMs: 400,
    totalInputTokens: 250,
    totalOutputTokens: 80,
    piiRedactedCount: 1,
    spans: [
      {
        spanId: 'sp-1',
        name: 'invoke_agent dxos-architect',
        depth: 0,
        startOffsetMs: 0,
        durationMs: 400,
        status: 'ok',
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.system': 'openai-completions',
        'gen_ai.request.model': 'ag/gemini-3.8-flash',
        'gen_ai.usage.input_tokens': 250,
        'gen_ai.usage.output_tokens': 80,
        piiRedactedCount: 1,
        attributes: { organizationId: 'org-a' },
      },
      {
        spanId: 'sp-2',
        parentSpanId: 'sp-1',
        name: 'execute_tool dxos_provision_role_workspace',
        depth: 1,
        startOffsetMs: 100,
        durationMs: 200,
        status: 'ok',
        'gen_ai.operation.name': 'execute_tool',
        'gen_ai.usage.input_tokens': 0,
        'gen_ai.usage.output_tokens': 0,
        attributes: { operation: 'plan_enterprise_app' },
      },
    ],
  };

  const wfBars = computeWaterfallBars(sampleDetail);
  assert.equal(wfBars.totalDurationMs, 400);
  assert.equal(wfBars.bars[0].leftPct, 0);
  assert.equal(wfBars.bars[0].widthPct, 100);
  assert.equal(wfBars.bars[1].leftPct, 25);
  assert.equal(wfBars.bars[1].widthPct, 50);

  const traceTree = AiTraceWaterfallPanel({
    React,
    organizationId: 'org-a',
    initialTraces: [{ traceId: 'trace-ui-001', agentName: 'dxos-architect', status: 'ok', durationMs: 400, totalTokens: 330, spanCount: 2 }],
    initialTraceDetail: sampleDetail,
  });
  const traceDump = JSON.stringify(traceTree);
  assert.ok(traceDump.includes('dxos-trace-waterfall-panel'));
  assert.ok(traceDump.includes('dxos-trace-waterfall-svg'));
  assert.ok(traceDump.includes('dxos-trace-span-sp-2'));
  assert.ok(traceDump.includes('dxos-trace-span-detail'));

  const sampleEval = {
    runId: 'eval-ui-01',
    suiteId: 'wave1-3-capabilities',
    mode: 'deterministic',
    modelName: 'deterministic-nl-router',
    total: 2,
    passed: 2,
    failed: 0,
    passRate: 100,
    avgLatencyMs: 0.42,
    p95LatencyMs: 0.65,
    byCategory: { 'app-builder-2.0': { total: 2, passed: 2, passRate: 100 } },
    results: [
      { id: 'w1-plan-01', category: 'app-builder-2.0', prompt: 'Lập kế hoạch dry-run...', expectedTool: 'dxos_provision_role_workspace', actualTool: 'dxos_provision_role_workspace', expectedRefused: false, actualRefused: false, latencyMs: 0.42, passed: true },
    ],
  };
  const evalSummary = summarizeEvalResults(sampleEval);
  assert.equal(evalSummary.passRate, 100);
  assert.equal(evalSummary.categories.length, 1);

  const evalTree = AiEvalLabPanel({
    React,
    organizationId: 'org-a',
    initialResult: sampleEval,
  });
  const evalDump = JSON.stringify(evalTree);
  assert.ok(evalDump.includes('dxos-eval-lab-panel'));
  assert.ok(evalDump.includes('dxos-eval-suite-select'));
  assert.ok(evalDump.includes('dxos-eval-run-btn'));
  assert.ok(evalDump.includes('dxos-eval-results-table'));
  assert.ok(evalDump.includes('100%'));

  assert.equal(typeof createAiTraceWaterfallPanel(React, null), 'function');
  assert.equal(typeof createAiEvalLabPanel(React, null), 'function');
});
