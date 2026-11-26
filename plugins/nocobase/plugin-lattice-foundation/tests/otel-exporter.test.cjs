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
const http = require('node:http');
const Module = require('node:module');

const otelModule = require('../src/server/otel-exporter');
const {
  createOtelExporter,
  traceMiddleware,
  recordSpan,
  parseTraceparent,
  formatTraceparent,
  flushOtel,
  getOtelStats,
  redactAttributes,
} = otelModule;
const { registerObservability } = require('../src/server/observability');

function withMockedNocobase(fn) {
  const origLoad = Module._load;
  class MockMigration {
    constructor(context = {}) { this.context = context; }
  }
  class MockPlugin {
    constructor(app, options = {}) {
      this.app = app;
      this.db = app?.db;
      this.options = options;
    }
  }
  Module._load = function mockedLoad(request, parent, isMain) {
    if (request === '@nocobase/server') {
      return { Migration: MockMigration, Plugin: MockPlugin };
    }
    if (request === '@nocobase/database') {
      return { defineCollection: (def) => def };
    }
    return origLoad.call(this, request, parent, isMain);
  };
  return Promise.resolve()
    .then(() => fn())
    .finally(() => {
      Module._load = origLoad;
    });
}

function startMockCollector(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString('utf8');
      let json = null;
      try {
        json = JSON.parse(raw);
      } catch {
        json = null;
      }
      await handler(req, res, { raw, json });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

test('otel-exporter exposes expected top-level API and validates W3C traceparent headers', () => {
  assert.equal(typeof createOtelExporter, 'function');
  assert.equal(typeof traceMiddleware, 'function');
  assert.equal(typeof recordSpan, 'function');
  assert.equal(typeof parseTraceparent, 'function');
  assert.equal(typeof formatTraceparent, 'function');
  assert.equal(typeof flushOtel, 'function');
  assert.equal(typeof getOtelStats, 'function');

  const validHeader = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
  const parsed = parseTraceparent(validHeader);
  assert.deepEqual(parsed, {
    version: '00',
    traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    spanId: '00f067aa0ba902b7',
    parentSpanId: '00f067aa0ba902b7',
    traceFlags: '01',
    sampled: true,
  });

  const unsampled = parseTraceparent('  00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-00  ');
  assert.equal(unsampled.traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
  assert.equal(unsampled.sampled, false);

  for (const invalid of [
    '',
    null,
    undefined,
    'not-a-traceparent',
    'ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    '00-00000000000000000000000000000000-00f067aa0ba902b7-01',
    '00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01',
    '00-1234-5678-01',
  ]) {
    assert.equal(parseTraceparent(invalid), null);
  }

  const formatted = formatTraceparent('4bf92f3577b34da6a3ce929d0e0e4736', '00f067aa0ba902b7');
  assert.equal(formatted, validHeader);

  const generated = formatTraceparent();
  assert.match(generated, /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);
  assert.notEqual(parseTraceparent(generated), null);
});

test('createOtelExporter queues spans, redacts secrets, and flushes OTLP/HTTP JSON to /v1/traces', async (t) => {
  const received = [];
  const collector = await startMockCollector((req, res, { raw, json }) => {
    received.push({ method: req.method, url: req.url, headers: req.headers, raw, json });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  t.after(() => collector.close());

  const exporter = createOtelExporter({
    serviceName: 'latticedx-test-service',
    endpoint: collector.url,
    flushIntervalMs: 0,
  });

  exporter.recordSpan({
    name: 'dxos.workflow.execute',
    traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    parentSpanId: '00f067aa0ba902b7',
    attributes: {
      'dxos.org': 'org-alpha',
      authorization: 'Bearer ultra-secret-jwt-value',
      'x-api-key': 'ldx_pat_secret_api_key_value',
      'http.request.header.x-api-key': 'another-secret',
      'http.request.header.cookie': 'session=secret-cookie',
      'custom.safe': 42,
    },
  });

  assert.equal(exporter.getOtelStats().queuedSpans, 1);

  const flushRes = await exporter.flushOtel();
  assert.equal(flushRes.exported, 1);
  assert.equal(received.length, 1);
  assert.equal(received[0].method, 'POST');
  assert.equal(received[0].url, '/v1/traces');
  assert.match(String(received[0].headers['content-type']), /application\/json/);

  // Secrets must NEVER appear in serialized OTLP payload
  assert.equal(received[0].raw.includes('ultra-secret-jwt-value'), false);
  assert.equal(received[0].raw.includes('ldx_pat_secret_api_key_value'), false);
  assert.equal(received[0].raw.includes('another-secret'), false);
  assert.equal(received[0].raw.includes('secret-cookie'), false);

  const resourceSpan = received[0].json.resourceSpans[0];
  const serviceAttr = resourceSpan.resource.attributes.find((a) => a.key === 'service.name');
  assert.equal(serviceAttr.value.stringValue, 'latticedx-test-service');
  const serviceVersionAttr = resourceSpan.resource.attributes.find((a) => a.key === 'service.version');
  assert.ok(serviceVersionAttr, 'Missing service.version resource attribute');
  assert.equal(serviceVersionAttr.value.stringValue, '0.4.1');
  assert.notEqual(serviceVersionAttr.value.stringValue, '1.0.0');
  assert.notEqual(serviceVersionAttr.value.stringValue, '1.1.0');
  assert.equal(resourceSpan.scopeSpans[0].scope.name, '@latticedx/otel-exporter');
  assert.equal(resourceSpan.scopeSpans[0].scope.version, '0.4.1');
  assert.notEqual(resourceSpan.scopeSpans[0].scope.version, '1.0.0');
  assert.notEqual(resourceSpan.scopeSpans[0].scope.version, '1.1.0');

  const span = resourceSpan.scopeSpans[0].spans[0];
  assert.equal(span.traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
  assert.equal(span.parentSpanId, '00f067aa0ba902b7');
  assert.match(span.spanId, /^[a-f0-9]{16}$/);
  assert.equal(span.name, 'dxos.workflow.execute');
  assert.equal(span.status.code, 1);

  const attrMap = new Map(span.attributes.map((a) => [a.key, a.value]));
  assert.equal(attrMap.get('dxos.org').stringValue, 'org-alpha');
  assert.equal(attrMap.get('custom.safe').intValue, '42');
  assert.equal(attrMap.get('authorization').stringValue, '[REDACTED]');
  assert.equal(attrMap.get('x-api-key').stringValue, '[REDACTED]');

  const stats = exporter.getOtelStats();
  assert.equal(stats.queuedSpans, 0);
  assert.equal(stats.recordedSpans, 1);
  assert.equal(stats.exportedSpans, 1);
  assert.equal(stats.droppedSpans, 0);
  assert.equal(stats.exportFailures, 0);
});

test('traceMiddleware propagates W3C traceparent, strips auth headers, and never blocks requests when collector is offline', async (t) => {
  // Hang/blackhole collector that delays 5s — middleware must return immediately without blocking
  let slowServerClosed = false;
  const slowCollector = await startMockCollector((_req, res) => {
    const timer = setTimeout(() => {
      if (!slowServerClosed) {
        res.writeHead(200);
        res.end('{}');
      }
    }, 5000);
    timer.unref();
  });
  t.after(async () => {
    slowServerClosed = true;
    await slowCollector.close();
  });

  const exporter = createOtelExporter({
    serviceName: 'latticedx-nocobase',
    endpoint: slowCollector.url,
    exportTimeoutMs: 150,
    flushIntervalMs: 0,
  });
  const mw = exporter.traceMiddleware();

  const incomingTraceparent = '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01';
  const ctx = {
    method: 'POST',
    path: '/api/dxos:health',
    headers: {
      traceparent: incomingTraceparent,
      authorization: 'Bearer do-not-leak-me',
      'x-api-key': 'secret-key-do-not-leak',
      'x-request-id': 'req-123',
    },
    response: { headers: {} },
    state: {},
    get(k) { return this.headers[String(k).toLowerCase()] || ''; },
    set(k, v) { this.response.headers[k] = v; },
  };

  const startedAt = Date.now();
  await mw(ctx, async () => {
    ctx.status = 200;
  });
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs < 100, `traceMiddleware blocked request for ${elapsedMs}ms`);

  const outTp = ctx.response.headers.traceparent;
  const parsedOut = parseTraceparent(outTp);
  assert.ok(parsedOut);
  assert.equal(parsedOut.traceId, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.notEqual(parsedOut.spanId, 'bbbbbbbbbbbbbbbb');
  assert.equal(ctx.state.traceId, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(ctx.state.spanId, parsedOut.spanId);

  // Downstream thrown error is rethrown and recorded as error span
  const errCtx = {
    method: 'GET',
    path: '/api/fail',
    headers: {},
    response: { headers: {} },
    state: {},
    get() { return ''; },
    set(k, v) { this.response.headers[k] = v; },
  };
  await assert.rejects(
    () => mw(errCtx, async () => { throw Object.assign(new Error('Boom'), { status: 500 }); }),
    { status: 500 },
  );

  // Offline collector failure fails silently
  const offlineExporter = createOtelExporter({
    serviceName: 'latticedx-offline',
    endpoint: 'http://127.0.0.1:1',
    exportTimeoutMs: 150,
    flushIntervalMs: 0,
  });
  offlineExporter.recordSpan({ name: 'offline-test' });
  const res = await offlineExporter.flushOtel();
  assert.equal(res.exported, 0);
  assert.equal(offlineExporter.getOtelStats().exportFailures, 1);
});

test('createOtelExporter drops spans cleanly under queue overflow (>256)', () => {
  const exporter = createOtelExporter({
    serviceName: 'latticedx-overflow',
    endpoint: '',
    flushIntervalMs: 0,
  });

  for (let i = 0; i < 300; i += 1) {
    exporter.recordSpan({ name: `span-${i}` });
  }

  const stats = exporter.getOtelStats();
  assert.equal(stats.queuedSpans, 256);
  assert.equal(stats.droppedSpans, 44);
  assert.equal(stats.recordedSpans, 256);
});

test('observability integration exposes OTel stats in dxos:health and OTel gauges in dxos:metrics', async () => {
  const resources = new Map();
  const app = {
    db: { sequelize: { query: async () => [[1]] } },
    use() {},
    resourceManager: { define(def) { resources.set(def.name, def.actions); } },
    acl: { allow() {} },
  };
  const exporter = createOtelExporter({ serviceName: 'latticedx-obs', endpoint: '', flushIntervalMs: 0 });
  exporter.recordSpan({ name: 'boot.check' });

  registerObservability(app, {
    env: { DX_METRICS_TOKEN: 'obs-token-123' },
    otelExporter: exporter,
  });

  const dxos = resources.get('dxos');
  const healthCtx = {
    method: 'GET',
    headers: {},
    request: { headers: {} },
    response: { headers: {} },
    state: {},
    get() { return ''; },
    set(k, v) { this.response.headers[k] = v; },
    throw(s, m) { throw Object.assign(new Error(m), { status: s }); },
  };
  await dxos.health(healthCtx, async () => {});
  assert.equal(healthCtx.body.status, 'ok');
  assert.equal(healthCtx.body.otel.serviceName, 'latticedx-obs');
  assert.equal(healthCtx.body.otel.queuedSpans, 1);

  const metricsCtx = {
    method: 'GET',
    headers: { authorization: 'Bearer obs-token-123' },
    request: { headers: { authorization: 'Bearer obs-token-123' } },
    response: { headers: {} },
    state: {},
    get(k) { return this.headers[String(k).toLowerCase()] || ''; },
    set(k, v) { this.response.headers[k] = v; },
    throw(s, m) { throw Object.assign(new Error(m), { status: s }); },
  };
  await dxos.metrics(metricsCtx, async () => {});
  assert.match(metricsCtx.body, /latticedx_otel_spans_recorded_total 1/);
  assert.match(metricsCtx.body, /latticedx_otel_queue_size 1/);
  assert.match(metricsCtx.body, /latticedx_otel_spans_dropped_total 0/);
});

test('otel-exporter preserves legacy exports and adds GenAI Semantic Conventions & PII scrubbing APIs', () => {
  for (const key of [
    'DEFAULT_MAX_QUEUE_SIZE',
    'createOtelExporter',
    'traceMiddleware',
    'recordSpan',
    'parseTraceparent',
    'formatTraceparent',
    'flushOtel',
    'getOtelStats',
    'redactAttributes',
    'getDefaultOtelExporter',
    'redactPiiText',
    'redactPiiDeep',
    'redactAttributesWithCount',
    'recordGenAiSpan',
    'startGenAiSpan',
    'persistGenAiTrace',
    'listGenAiTraces',
  ]) {
    assert.ok(key in otelModule, `Missing export ${key} on otel-exporter`);
  }

  const exporter = createOtelExporter({ endpoint: '', flushIntervalMs: 0 });
  for (const method of [
    'traceMiddleware',
    'recordSpan',
    'parseTraceparent',
    'formatTraceparent',
    'flushOtel',
    'getOtelStats',
    'shutdown',
    'recordGenAiSpan',
    'startGenAiSpan',
  ]) {
    assert.equal(typeof exporter[method], 'function', `Missing method ${method} on createOtelExporter() instance`);
  }
});

test('redactPiiText, redactPiiDeep, and redactAttributesWithCount scrub PII/secrets before truncation without mangling IDs or double-counting', () => {
  const { redactPiiText, redactPiiDeep, redactAttributesWithCount } = otelModule;

  const fakeJwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ1c2VyMSJ9', 'sig_12345678'].join('.');
  const fakeSk = ['sk', 'live', 'abcdef1234567890'].join('-');
  const fakePat = ['ldx_pat', '1234abcd', '00112233445566778899aabbccddeeff'].join('_');
  const longPadding = 'x'.repeat(2150);
  const rawString = [
    `prefix ${longPadding}`,
    `jwt=${fakeJwt}`,
    `auth=Bearer my-bearer-secret-token-99`,
    `key=${fakeSk}`,
    `pat=${fakePat}`,
    `email=ops@example.com`,
    `cccd: 079095001234`,
    `phone: +84 912 345 678`,
    `stk: 190012345678,`,
    `mst: 0312345678`,
    `apiKey="inline-secret-value"`,
  ].join(' | ');

  const scrubbed = redactPiiText(rawString);
  assert.equal(scrubbed.text.includes(fakeJwt), false);
  assert.equal(scrubbed.text.includes('my-bearer-secret-token-99'), false);
  assert.equal(scrubbed.text.includes(fakeSk), false);
  assert.equal(scrubbed.text.includes(fakePat), false);
  assert.equal(scrubbed.text.includes('ops@example.com'), false);
  assert.equal(scrubbed.text.includes('079095001234'), false);
  assert.equal(scrubbed.text.includes('912 345 678'), false);
  assert.equal(scrubbed.text.includes('190012345678'), false);
  assert.equal(scrubbed.text.includes('0312345678'), false);
  assert.equal(scrubbed.text.includes('inline-secret-value'), false);
  assert.ok(scrubbed.count >= 9, `Expected >= 9 PII redactions, got ${scrubbed.count}`);

  // Idempotent: re-running over already-redacted text must add 0
  const secondPass = redactPiiText(scrubbed.text);
  assert.equal(secondPass.count, 0);
  assert.equal(secondPass.text, scrubbed.text);

  // Must NOT mangle 32-hex traceId, 16-hex spanId, runUid, or ISO timestamps
  const idsText = 'trace=4bf92f3577b34da6a3ce929d0e0e4736 span=00f067aa0ba902b7 run=run_0123456789ab ts=2026-11-25T16:14:59.123Z';
  const idsPass = redactPiiText(idsText);
  assert.equal(idsPass.count, 0);
  assert.equal(idsPass.text, idsText);

  // redactAttributesWithCount scrubs strings > 2048 chars BEFORE truncating & blocks prototype pollution
  const polluted = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"bad":1},"authorization":"Bearer tok","longPrompt":"' + longPadding + ' user@example.org"}');
  const attrRes = redactAttributesWithCount(polluted);
  assert.equal(Object.hasOwn(attrRes.attributes, '__proto__'), false);
  assert.equal(Object.hasOwn(attrRes.attributes, 'constructor'), false);
  assert.equal(attrRes.attributes.authorization, '[REDACTED]');
  assert.equal(attrRes.attributes.longPrompt.includes('user@example.org'), false);
  assert.ok(attrRes.redactedCount >= 2);
  assert.equal(redactAttributes(polluted).authorization, '[REDACTED]');

  // redactPiiDeep scrubs nested objects safely and avoids double counting [REDACTED]
  const deepFirst = redactPiiDeep({ nested: { secretToken: 'abc', note: 'Call 0987654321' } });
  assert.equal(deepFirst.value.nested.secretToken, '[REDACTED]');
  assert.equal(deepFirst.value.nested.note.includes('0987654321'), false);
  assert.equal(deepFirst.count, 2);
  const deepSecond = redactPiiDeep(deepFirst.value);
  assert.equal(deepSecond.count, 0);
});

test('recordGenAiSpan and startGenAiSpan emit OTel GenAI Semantic Conventions spans and flush valid OTLP JSON', async (t) => {
  const received = [];
  const collector = await startMockCollector((req, res, { raw, json }) => {
    received.push({ raw, json });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  t.after(() => collector.close());

  const exporter = createOtelExporter({
    serviceName: 'latticedx-genai-test',
    endpoint: collector.url,
    flushIntervalMs: 0,
  });

  // 1. chat / invoke_agent / execute_tool / embeddings via recordGenAiSpan
  const chatSpan = exporter.recordGenAiSpan({
    operationName: 'chat',
    genAiSystem: 'openai',
    model: 'oc/big-pickle',
    agentName: 'dxos-architect',
    runUid: 'run-abc-123',
    organizationId: 'org-alpha',
    inputTokens: 120,
    outputTokens: 45,
    durationMs: 310,
    piiRedactedCount: 2,
    attributes: {
      'dxos.prompt_preview': 'Email me at founder@company.vn',
    },
  });

  assert.equal(chatSpan.ok, true);
  assert.equal(chatSpan.queued, true);
  assert.match(chatSpan.traceId, /^[0-9a-f]{32}$/);
  assert.match(chatSpan.spanId, /^[0-9a-f]{16}$/);
  assert.equal(chatSpan.traceRecord.operationName, 'chat');
  assert.equal(chatSpan.traceRecord.totalTokens, 165);
  assert.equal(chatSpan.traceRecord.piiRedactedCount, 3); // 2 caller + 1 email detected
  assert.equal(chatSpan.attributes['gen_ai.operation.name'], 'chat');
  assert.equal(chatSpan.attributes['gen_ai.system'], 'openai');
  assert.equal(chatSpan.attributes['gen_ai.request.model'], 'oc/big-pickle');
  assert.equal(chatSpan.attributes['gen_ai.usage.input_tokens'], 120);
  assert.equal(chatSpan.attributes['gen_ai.usage.output_tokens'], 45);
  assert.equal(chatSpan.attributes['gen_ai.agent.name'], 'dxos-architect');
  assert.equal(chatSpan.attributes['dxos.pii.redacted_count'], 3);

  // 2. startGenAiSpan -> execute_tool child span with error + idempotent end()
  const toolHandle = exporter.startGenAiSpan({
    operationName: 'execute_tool',
    toolName: 'dxos_provision_role_workspace',
    agentName: 'dxos-architect',
    runUid: 'run-abc-123',
    organizationId: 'org-alpha',
    traceId: chatSpan.traceId,
    parentSpanId: chatSpan.spanId,
  });
  assert.equal(toolHandle.traceId, chatSpan.traceId);
  assert.equal(toolHandle.parentSpanId, chatSpan.spanId);
  assert.match(toolHandle.traceparent, new RegExp(`^00-${chatSpan.traceId}-${toolHandle.spanId}-01$`));

  const endFirst = toolHandle.end({
    status: 'error',
    errorMessage: 'Failed auth for alice@corp.vn',
    durationMs: 42,
  });
  const endSecond = toolHandle.end({ status: 'ok', durationMs: 999 });
  assert.equal(endFirst, endSecond);
  assert.equal(endFirst.traceRecord.status, 'error');
  assert.equal(endFirst.traceRecord.errorMessage.includes('alice@corp.vn'), false);
  assert.equal(endFirst.traceRecord.piiRedactedCount, 1);

  const flushRes = await exporter.flushOtel();
  assert.equal(flushRes.exported, 2);
  assert.equal(received[0].raw.includes('founder@company.vn'), false);
  assert.equal(received[0].raw.includes('alice@corp.vn'), false);

  const spans = received[0].json.resourceSpans[0].scopeSpans[0].spans;
  assert.equal(spans.length, 2);
  const otlpToolAttr = new Map(spans[1].attributes.map((a) => [a.key, a.value]));
  assert.equal(otlpToolAttr.get('gen_ai.operation.name').stringValue, 'execute_tool');
  assert.equal(otlpToolAttr.get('gen_ai.tool.name').stringValue, 'dxos_provision_role_workspace');
  assert.equal(spans[1].status.code, 2);
  assert.equal(spans[1].parentSpanId, chatSpan.spanId);
});

test('persistGenAiTrace and listGenAiTraces enforce ORG_ID_RE fail-closed, scrub PII, wrap PG RLS/savepoint, and filter cleanly', async () => {
  const { persistGenAiTrace, listGenAiTraces, recordGenAiSpan } = otelModule;
  const pgRls = require('../src/server/pg-rls');
  const prevFlag = process.env.DX_PG_RLS_SESSION;

  const storedRows = [];
  const sqlCalls = [];
  const fakeTx = { id: 'tx-ai-traces' };
  const db = {
    sequelize: {
      getDialect: () => 'postgres',
      transaction: async (cb) => cb(fakeTx),
      query: async (sql, opts) => {
        sqlCalls.push({ sql, opts });
        return [[]];
      },
    },
    getRepository(name) {
      if (name !== 'latticeAiTraces') return null;
      return {
        async create({ values, transaction }) {
          assert.equal(transaction, fakeTx);
          const row = { id: storedRows.length + 1, createdAt: new Date(), updatedAt: new Date(), ...values };
          storedRows.push(row);
          return row;
        },
        async findAndCount({ filter = {}, limit = 50, offset = 0, sort = [], transaction }) {
          assert.equal(transaction, fakeTx);
          const matched = storedRows.filter((r) => {
            for (const [k, v] of Object.entries(filter)) {
              if (r[k] !== v) return false;
            }
            return true;
          });
          const sorted = [...matched].sort((a, b) => (sort[0]?.startsWith('-') ? b.id - a.id : a.id - b.id));
          return [sorted.slice(offset, offset + limit), matched.length];
        },
      };
    },
  };

  try {
    process.env.DX_PG_RLS_SESSION = 'true';

    // 1. Fail-closed on invalid/missing/wildcard organizationId
    for (const badOrg of ['', '*', 'org a', 'org;DROP', null, undefined]) {
      await assert.rejects(
        () => persistGenAiTrace(db, { organizationId: badOrg, operationName: 'chat' }),
        (err) => err.code === 'INVALID_RLS_ORGANIZATION' && err.status === 400,
      );
      await assert.rejects(
        () => listGenAiTraces(db, { organizationId: badOrg }),
        (err) => err.code === 'INVALID_RLS_ORGANIZATION' && err.status === 400,
      );
    }

    // 2. persistGenAiTrace scrubs PII and executes inside withTenantRlsContext
    const saved = await persistGenAiTrace(db, {
      organizationId: 'org-alpha',
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
      runUid: 'run-rls-1',
      operationName: 'invoke_agent',
      genAiSystem: 'openai',
      model: 'oc/big-pickle',
      agentName: 'dxos-operator',
      inputTokens: 50,
      outputTokens: 25,
      errorMessage: 'Token Bearer secret-xyz leaked by bob@org-a.vn',
      attributesJson: { note: 'CCCD 079095001234' },
    });
    assert.equal(saved.organizationId, 'org-alpha');
    assert.equal(saved.totalTokens, 75);
    assert.equal(saved.errorMessage.includes('secret-xyz'), false);
    assert.equal(saved.errorMessage.includes('bob@org-a.vn'), false);
    assert.equal(saved.attributesJson.note.includes('079095001234'), false);
    assert.ok(saved.piiRedactedCount >= 3);
    assert.equal(sqlCalls[0].sql, "SELECT set_config('app.current_org', :orgId, true)");
    assert.deepEqual(sqlCalls[0].opts.replacements, { orgId: 'org-alpha' });

    // 3. Inside an active RLS transaction, uses savepoint instead of nested transaction
    sqlCalls.length = 0;
    await pgRls.withTenantRlsContext(db, 'org-alpha', async () => {
      await persistGenAiTrace(db, {
        organizationId: 'org-alpha',
        traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
        spanId: '11f067aa0ba902b8',
        runUid: 'run-rls-1',
        operationName: 'execute_tool',
        toolName: 'dxos_search_enterprise_context',
        status: 'ok',
      });
    });
    assert.ok(sqlCalls.some((q) => /^SAVEPOINT "ldx_sp_\d+"$/.test(q.sql)));
    assert.ok(sqlCalls.some((q) => /^RELEASE SAVEPOINT "ldx_sp_\d+"$/.test(q.sql)));

    // 4. recordGenAiSpan with options.db persists asynchronously
    const spanRes = await recordGenAiSpan(
      {
        organizationId: 'org-beta',
        runUid: 'run-beta-1',
        operationName: 'embeddings',
        model: 'text-embedding-3-small',
        inputTokens: 10,
      },
      { db },
    );
    assert.equal(spanRes.queued, true);
    assert.equal(spanRes.persisted.organizationId, 'org-beta');

    // 5. listGenAiTraces filters & isolates orgs + clamps limit
    const listAlpha = await listGenAiTraces(db, {
      organizationId: 'org-alpha',
      runUid: 'run-rls-1',
      operationName: 'execute_tool',
      limit: 9999,
    });
    assert.equal(listAlpha.total, 1);
    assert.equal(listAlpha.limit, 200);
    assert.equal(listAlpha.items[0].toolName, 'dxos_search_enterprise_context');
    assert.equal(listAlpha.items.some((i) => i.organizationId === 'org-beta'), false);
  } finally {
    if (prevFlag === undefined) delete process.env.DX_PG_RLS_SESSION;
    else process.env.DX_PG_RLS_SESSION = prevFlag;
  }
});

test('latticeAiTraces collection, migration 20261201000010, and LatticeFoundationPlugin wiring meet contracts', async () => {
  await withMockedNocobase(async () => {
    const aiTracesPath = require.resolve('../src/server/collections/ai-traces');
    delete require.cache[aiTracesPath];
    const aiTracesCol = require('../src/server/collections/ai-traces');

    assert.equal(aiTracesCol.name, 'latticeAiTraces');
    assert.deepEqual(aiTracesCol.migrationRules, ['schema-only']);
    assert.equal(aiTracesCol.createdAt, true);
    assert.equal(aiTracesCol.updatedAt, true);

    const fieldMap = new Map(aiTracesCol.fields.map((f) => [f.name, f]));
    for (const reqField of [
      'uid', 'organizationId', 'traceId', 'spanId', 'parentSpanId', 'runUid',
      'operationName', 'genAiSystem', 'model', 'agentName', 'toolName', 'status',
      'durationMs', 'inputTokens', 'outputTokens', 'totalTokens', 'piiRedactedCount',
      'attributesJson', 'startedAt', 'endedAt', 'errorMessage',
    ]) {
      assert.ok(fieldMap.has(reqField), `Missing field ${reqField} in latticeAiTraces`);
    }
    assert.equal(fieldMap.get('organizationId').allowNull, false);
    assert.equal(fieldMap.get('attributesJson').type, 'jsonb');

    for (const idx of aiTracesCol.indexes) {
      assert.match(idx.name, /^u?idx_lattice_[a-z0-9_]+$/);
      assert.ok(idx.name.length <= 55);
      assert.equal(idx.fields[0], 'organizationId');
    }

    // Migration: up() with db.attachLatticeRlsPolicy, up() with attachRlsPolicyToTable fallback, down(), sqlite skip, no-sequelize safety
    const migPath = require.resolve('../src/server/migrations/20261201000010-ai-traces');
    delete require.cache[migPath];
    const AiTracesMigration = require('../src/server/migrations/20261201000010-ai-traces');

    const sqlCalls = [];
    const attached = [];
    const fakeTx = { id: 'tx-mig-traces' };
    const pgDbWithAttach = {
      sequelize: {
        getDialect: () => 'postgres',
        transaction: async (cb) => cb(fakeTx),
        query: async (sql, opts) => { sqlCalls.push({ sql, opts }); return [[]]; },
      },
      attachLatticeRlsPolicy: async (tbl, opts) => { attached.push({ tbl, opts }); },
    };
    const m1 = new AiTracesMigration({ db: pgDbWithAttach });
    assert.equal(m1.on, 'afterSync');
    await m1.up();
    const upSql = sqlCalls.map((s) => s.sql).join('\n');
    assert.match(upSql, /CREATE TABLE IF NOT EXISTS "latticeAiTraces"/);
    assert.match(upSql, /CREATE UNIQUE INDEX IF NOT EXISTS uidx_lattice_ai_traces_org_uid/);
    assert.deepEqual(attached, [{ tbl: 'latticeAiTraces', opts: { transaction: fakeTx } }]);

    sqlCalls.length = 0;
    const pgDbFallback = {
      sequelize: {
        getDialect: () => 'postgres',
        transaction: async (cb) => cb(fakeTx),
        query: async (sql, opts) => { sqlCalls.push({ sql, opts }); return [[]]; },
      },
    };
    await new AiTracesMigration({ db: pgDbFallback }).up();
    const fallbackSql = sqlCalls.map((s) => s.sql).join('\n');
    assert.match(fallbackSql, /ENABLE ROW LEVEL SECURITY/);
    assert.match(fallbackSql, /FORCE ROW LEVEL SECURITY/);
    assert.match(fallbackSql, /AS PERMISSIVE FOR ALL TO PUBLIC/);

    sqlCalls.length = 0;
    await m1.down();
    const downSql = sqlCalls.map((s) => s.sql).join('\n');
    assert.match(downSql, /DROP POLICY IF EXISTS lattice_tenant_isolation ON public\."latticeAiTraces"/);
    assert.match(downSql, /DROP TABLE IF EXISTS "latticeAiTraces"/);

    // SQLite skips RLS cleanly & missing sequelize is safe
    const sqliteSql = [];
    await new AiTracesMigration({
      db: {
        sequelize: {
          getDialect: () => 'sqlite',
          transaction: async (cb) => cb(fakeTx),
          query: async (sql) => { sqliteSql.push(sql); return [[]]; },
        },
      },
    }).up();
    assert.equal(sqliteSql.some((s) => /ROW LEVEL SECURITY/.test(s)), false);
    await new AiTracesMigration({ db: {} }).up();
    await new AiTracesMigration({ db: {} }).down();

    // LatticeFoundationPlugin static helpers
    const idxPath = require.resolve('../src/server/index');
    delete require.cache[idxPath];
    const LatticeFoundationPlugin = require('../src/server/index');
    assert.equal(typeof LatticeFoundationPlugin.recordGenAiSpan, 'function');
    assert.equal(typeof LatticeFoundationPlugin.startGenAiSpan, 'function');
    assert.equal(typeof LatticeFoundationPlugin.persistGenAiTrace, 'function');
    assert.equal(typeof LatticeFoundationPlugin.listGenAiTraces, 'function');
  });
});

test('redactPiiText and redactAttributesWithCount preserve underscore-delimited IDs while scrubbing standalone VN phones and CCCDs', () => {
  const { redactPiiText, redactAttributesWithCount } = otelModule;

  assert.deepEqual(redactPiiText('run_0912345678'), { text: 'run_0912345678', count: 0 });
  assert.deepEqual(redactPiiText('job_012345678901'), { text: 'job_012345678901', count: 0 });
  assert.deepEqual(redactPiiText('0912345678_suffix'), { text: '0912345678_suffix', count: 0 });

  const attrRes = redactAttributesWithCount({
    run_uid: 'run_0912345678',
    job_id: 'job_012345678901',
  });
  assert.equal(attrRes.redactedCount, 0);
  assert.equal(attrRes.attributes.run_uid, 'run_0912345678');
  assert.equal(attrRes.attributes.job_id, 'job_012345678901');

  const standalone = redactPiiText('call 0912345678 or +84 912 345 678 and cccd 079095001234');
  assert.equal(standalone.count, 3);
  assert.equal(standalone.text.includes('0912345678'), false);
  assert.equal(standalone.text.includes('912 345 678'), false);
  assert.equal(standalone.text.includes('079095001234'), false);
});

test('recordGenAiSpan scrubs model, agentName, toolName, and runUid consistently with persistGenAiTrace without double-counting', async () => {
  const { recordGenAiSpan, persistGenAiTrace } = otelModule;
  const storedRows = [];
  const mockDb = {
    getRepository(name) {
      if (name !== 'latticeAiTraces') return null;
      return {
        async create({ values }) {
          const row = { id: storedRows.length + 1, createdAt: new Date(), updatedAt: new Date(), ...values };
          storedRows.push(row);
          return row;
        },
      };
    },
  };

  const prePersist = recordGenAiSpan({
    organizationId: 'org-alpha',
    model: 'custom-alice@example.com',
    agentName: 'agent-sk-12345678',
    toolName: 'tool:0987654321',
    runUid: 'run_0912345678',
  });

  assert.equal(prePersist.traceRecord.model, '[REDACTED_EMAIL]');
  assert.equal(prePersist.attributes['gen_ai.request.model'], '[REDACTED_EMAIL]');
  assert.equal(prePersist.traceRecord.agentName, 'agent-[REDACTED_KEY]');
  assert.equal(prePersist.attributes['gen_ai.agent.name'], 'agent-[REDACTED_KEY]');
  assert.equal(prePersist.traceRecord.toolName, 'tool:[REDACTED_PHONE]');
  assert.equal(prePersist.attributes['gen_ai.tool.name'], 'tool:[REDACTED_PHONE]');
  assert.equal(prePersist.traceRecord.runUid, 'run_0912345678');
  assert.equal(prePersist.attributes['dxos.run_uid'], 'run_0912345678');
  assert.equal(prePersist.piiRedactedCount, 3);
  assert.equal(prePersist.attributes['dxos.pii.redacted_count'], 3);

  const persisted = await persistGenAiTrace(mockDb, prePersist.traceRecord);
  assert.equal(persisted.piiRedactedCount, 3);
  assert.equal(persisted.attributesJson['dxos.pii.redacted_count'], 3);
  assert.equal(persisted.model, prePersist.traceRecord.model);
  assert.equal(persisted.agentName, prePersist.traceRecord.agentName);
  assert.equal(persisted.toolName, prePersist.traceRecord.toolName);
  assert.equal(persisted.runUid, prePersist.traceRecord.runUid);

  const directPersist = await persistGenAiTrace(mockDb, {
    organizationId: 'org-alpha',
    model: 'raw-bob@example.com',
    agentName: 'agent-sk-99999999',
    toolName: 'tool:0912345678',
    runUid: 'run: bob@example.com',
  });
  assert.equal(directPersist.model, '[REDACTED_EMAIL]');
  assert.equal(directPersist.agentName, 'agent-[REDACTED_KEY]');
  assert.equal(directPersist.toolName, 'tool:[REDACTED_PHONE]');
  assert.equal(directPersist.runUid, 'run: [REDACTED_EMAIL]');
  assert.equal(directPersist.piiRedactedCount, 4);
});

test('redactPiiText treats Bearer [REDACTED] in KV pairs as idempotent and avoids double-counting Bearer secrets', () => {
  const { redactPiiText } = otelModule;

  assert.deepEqual(redactPiiText('authorization: Bearer [REDACTED]'), {
    text: 'authorization: Bearer [REDACTED]',
    count: 0,
  });
  assert.deepEqual(redactPiiText('{"apiKey":"Bearer [REDACTED]"}'), {
    text: '{"apiKey":"Bearer [REDACTED]"}',
    count: 0,
  });
  assert.deepEqual(redactPiiText('authorization: Bearer my_secret_12345'), {
    text: 'authorization: Bearer [REDACTED]',
    count: 1,
  });
  assert.deepEqual(redactPiiText('{"authorization":"Bearer my_secret_12345"}'), {
    text: '{"authorization":"Bearer [REDACTED]"}',
    count: 1,
  });
});

test('redactAttributesWithCount recursively scrubs nested objects/arrays into bounded JSON with circular and prototype guards', () => {
  const { redactAttributesWithCount } = otelModule;

  const nestedInput = JSON.parse('{"payload":{"email":"leak@example.com","token":"sk-12345678","__proto__":{"polluted":true}},"tags":["0912345678","safe"]}');
  const circular = {};
  circular.self = circular;
  nestedInput.circ = circular;
  nestedInput.huge = { padding: 'a'.repeat(2500), email: 'tail@example.com' };

  const res = redactAttributesWithCount(nestedInput);
  assert.equal(({}).polluted, undefined);
  assert.equal(res.attributes.payload.includes('[object Object]'), false);
  assert.equal(res.attributes.payload.includes('leak@example.com'), false);
  assert.equal(res.attributes.payload.includes('sk-12345678'), false);
  const parsedPayload = JSON.parse(res.attributes.payload);
  assert.equal(parsedPayload.email, '[REDACTED_EMAIL]');
  assert.equal(parsedPayload.token, '[REDACTED]');
  assert.equal(Object.hasOwn(parsedPayload, '__proto__'), false);
  assert.equal(res.attributes.tags, '["[REDACTED_PHONE]","safe"]');
  assert.equal(res.attributes.circ, '{"self":"[CIRCULAR]"}');
  assert.ok(res.attributes.huge.length <= 2048);
  assert.equal(res.attributes.huge.includes('tail@example.com'), false);
  assert.equal(res.redactedCount, 4);
});

test('SAFE_TOKEN_COUNT_KEY_RE allowlists caller-supplied gen_ai.usage.total_tokens attribute', () => {
  const { redactAttributesWithCount } = otelModule;

  const res = redactAttributesWithCount({
    'gen_ai.usage.input_tokens': 120,
    'gen_ai.usage.output_tokens': 45,
    'gen_ai.usage.total_tokens': 165,
  });
  assert.equal(res.redactedCount, 0);
  assert.equal(res.attributes['gen_ai.usage.input_tokens'], 120);
  assert.equal(res.attributes['gen_ai.usage.output_tokens'], 45);
  assert.equal(res.attributes['gen_ai.usage.total_tokens'], 165);
});
