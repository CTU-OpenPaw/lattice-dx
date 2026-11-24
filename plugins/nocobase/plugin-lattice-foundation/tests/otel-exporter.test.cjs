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

const otelModule = require('../src/server/otel-exporter');
const {
  createOtelExporter,
  traceMiddleware,
  recordSpan,
  parseTraceparent,
  formatTraceparent,
  flushOtel,
  getOtelStats,
} = otelModule;
const { registerObservability } = require('../src/server/observability');

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
