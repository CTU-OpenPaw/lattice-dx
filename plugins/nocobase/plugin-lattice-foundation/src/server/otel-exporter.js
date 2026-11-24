/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { randomBytes } = require('node:crypto');

const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;
const TRACE_ID_RE = /^[0-9a-f]{32}$/i;
const SPAN_ID_RE = /^[0-9a-f]{16}$/i;
const ZERO_TRACE_ID = '0'.repeat(32);
const ZERO_SPAN_ID = '0'.repeat(16);
const DEFAULT_MAX_QUEUE_SIZE = 256;
const DEFAULT_BATCH_SIZE = 64;
const DEFAULT_EXPORT_TIMEOUT_MS = 2000;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const SENSITIVE_KEY_RE = /(authorization|api[-_]?key|secret|token|password|passwd|credential|cookie|signature|private[-_]?key|session)/i;

function randomHex(byteCount) {
  return randomBytes(byteCount).toString('hex');
}

function normalizeEndpoint(endpoint) {
  if (typeof endpoint !== 'string') return '';
  const trimmed = endpoint.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  } catch {
    return '';
  }
  return trimmed.endsWith('/v1/traces') ? trimmed : `${trimmed}/v1/traces`;
}

function parseTraceparent(header) {
  if (typeof header !== 'string') return null;
  const trimmed = header.trim();
  if (!trimmed) return null;
  const match = trimmed.match(TRACEPARENT_RE);
  if (!match) return null;
  const version = match[1].toLowerCase();
  const traceId = match[2].toLowerCase();
  const spanId = match[3].toLowerCase();
  const traceFlags = match[4].toLowerCase();
  if (version === 'ff' || traceId === ZERO_TRACE_ID || spanId === ZERO_SPAN_ID) {
    return null;
  }
  return {
    version,
    traceId,
    spanId,
    parentSpanId: spanId,
    traceFlags,
    sampled: (Number.parseInt(traceFlags, 16) & 1) === 1,
  };
}

function formatTraceparent(traceId, spanId, traceFlags = '01') {
  const validTraceId =
    typeof traceId === 'string' && TRACE_ID_RE.test(traceId) && traceId.toLowerCase() !== ZERO_TRACE_ID
      ? traceId.toLowerCase()
      : randomHex(16);
  const validSpanId =
    typeof spanId === 'string' && SPAN_ID_RE.test(spanId) && spanId.toLowerCase() !== ZERO_SPAN_ID
      ? spanId.toLowerCase()
      : randomHex(8);
  const validFlags =
    typeof traceFlags === 'string' && /^[0-9a-f]{2}$/i.test(traceFlags)
      ? traceFlags.toLowerCase()
      : '01';
  return `00-${validTraceId}-${validSpanId}-${validFlags}`;
}

function redactAttributes(attributes) {
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) {
    return {};
  }
  const safe = {};
  for (const [key, rawValue] of Object.entries(attributes)) {
    if (!key || rawValue === undefined || rawValue === null) continue;
    if (SENSITIVE_KEY_RE.test(key)) {
      safe[key] = '[REDACTED]';
      continue;
    }
    if (typeof rawValue === 'string') {
      safe[key] = rawValue.length > 2048 ? rawValue.slice(0, 2048) : rawValue;
    } else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
      safe[key] = rawValue;
    } else if (typeof rawValue === 'boolean') {
      safe[key] = rawValue;
    } else {
      safe[key] = String(rawValue).slice(0, 512);
    }
  }
  return safe;
}

function toOtlpAttributes(attributes) {
  const safe = redactAttributes(attributes);
  const list = [];
  for (const [key, value] of Object.entries(safe)) {
    if (typeof value === 'boolean') {
      list.push({ key, value: { boolValue: value } });
    } else if (typeof value === 'number') {
      if (Number.isInteger(value)) {
        list.push({ key, value: { intValue: String(value) } });
      } else {
        list.push({ key, value: { doubleValue: value } });
      }
    } else {
      list.push({ key, value: { stringValue: String(value) } });
    }
  }
  return list;
}

function getHeader(ctx, name) {
  if (typeof ctx?.get === 'function') {
    const val = ctx.get(name);
    if (val) return String(val).trim();
  }
  const lower = String(name || '').toLowerCase();
  const h = ctx?.headers?.[lower] ?? ctx?.request?.headers?.[lower];
  return h ? String(h).trim() : '';
}

function setHeader(ctx, name, value) {
  if (typeof ctx?.set === 'function') {
    ctx.set(name, value);
    return;
  }
  if (typeof ctx?.response?.set === 'function') {
    ctx.response.set(name, value);
    return;
  }
  if (ctx) {
    ctx.response = ctx.response || {};
    ctx.response.headers = ctx.response.headers || {};
    ctx.response.headers[name] = value;
  }
}

function sanitizePath(rawPath) {
  const str = String(rawPath || '/').split('?')[0].split('#')[0];
  return str.startsWith('/') ? str.slice(0, 512) : `/${str.slice(0, 511)}`;
}

function createOtelExporter(options = {}) {
  const serviceName =
    typeof options.serviceName === 'string' && options.serviceName.trim()
      ? options.serviceName.trim()
      : String(process.env.OTEL_SERVICE_NAME || 'latticedx-nocobase').trim();
  const serviceVersion =
    typeof options.serviceVersion === 'string' && options.serviceVersion.trim()
      ? options.serviceVersion.trim()
      : '1.0.0';
  const rawEndpoint =
    options.endpoint !== undefined ? options.endpoint : process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const tracesUrl = normalizeEndpoint(rawEndpoint);
  const maxQueueSize =
    Number.isInteger(options.maxQueueSize) && options.maxQueueSize >= 1
      ? options.maxQueueSize
      : DEFAULT_MAX_QUEUE_SIZE;
  const batchSize =
    Number.isInteger(options.batchSize) && options.batchSize >= 1
      ? Math.min(options.batchSize, maxQueueSize)
      : Math.min(DEFAULT_BATCH_SIZE, maxQueueSize);
  const exportTimeoutMs =
    Number.isInteger(options.exportTimeoutMs) && options.exportTimeoutMs >= 50
      ? options.exportTimeoutMs
      : DEFAULT_EXPORT_TIMEOUT_MS;
  const flushIntervalMs =
    Number.isInteger(options.flushIntervalMs) && options.flushIntervalMs >= 0
      ? options.flushIntervalMs
      : DEFAULT_FLUSH_INTERVAL_MS;
  const fetchFn = typeof options.fetchFn === 'function' ? options.fetchFn : globalThis.fetch;

  const queue = [];
  let recordedSpans = 0;
  let exportedSpans = 0;
  let droppedSpans = 0;
  let exportBatches = 0;
  let exportFailures = 0;
  let lastExportAt = null;
  let lastError = null;
  let flushInFlight = null;
  let timer = null;

  function recordSpan(spanInput = {}) {
    if (queue.length >= maxQueueSize) {
      droppedSpans += 1;
      return false;
    }

    const nowMs = BigInt(Date.now());
    const defaultNowNano = nowMs * 1_000_000n;
    const startNano =
      spanInput.startTimeUnixNano !== undefined
        ? String(spanInput.startTimeUnixNano)
        : String(defaultNowNano);
    const endNano =
      spanInput.endTimeUnixNano !== undefined
        ? String(spanInput.endTimeUnixNano)
        : startNano;

    const traceId =
      typeof spanInput.traceId === 'string' && TRACE_ID_RE.test(spanInput.traceId) && spanInput.traceId.toLowerCase() !== ZERO_TRACE_ID
        ? spanInput.traceId.toLowerCase()
        : randomHex(16);
    const spanId =
      typeof spanInput.spanId === 'string' && SPAN_ID_RE.test(spanInput.spanId) && spanInput.spanId.toLowerCase() !== ZERO_SPAN_ID
        ? spanInput.spanId.toLowerCase()
        : randomHex(8);
    const parentSpanId =
      typeof spanInput.parentSpanId === 'string' && SPAN_ID_RE.test(spanInput.parentSpanId) && spanInput.parentSpanId.toLowerCase() !== ZERO_SPAN_ID
        ? spanInput.parentSpanId.toLowerCase()
        : undefined;

    const statusCode =
      spanInput.status && typeof spanInput.status.code === 'number'
        ? spanInput.status.code
        : 1;
    const status = { code: statusCode };
    if (spanInput.status?.message) {
      status.message = String(spanInput.status.message).slice(0, 512);
    }

    const otlpSpan = {
      traceId,
      spanId,
      ...(parentSpanId ? { parentSpanId } : {}),
      name: String(spanInput.name || 'dxos.operation').slice(0, 256),
      kind: Number.isInteger(spanInput.kind) ? spanInput.kind : 1,
      startTimeUnixNano: startNano,
      endTimeUnixNano: endNano,
      attributes: toOtlpAttributes(spanInput.attributes),
      status,
    };

    queue.push(otlpSpan);
    recordedSpans += 1;
    return true;
  }

  async function flushOtel() {
    if (flushInFlight) {
      return flushInFlight;
    }
    if (queue.length === 0) {
      return { exported: 0, remaining: 0 };
    }
    if (!tracesUrl || typeof fetchFn !== 'function') {
      return { exported: 0, remaining: queue.length, skipped: true };
    }

    flushInFlight = (async () => {
      let totalExported = 0;
      while (queue.length > 0) {
        const batch = queue.slice(0, batchSize);
        const payload = {
          resourceSpans: [
            {
              resource: {
                attributes: toOtlpAttributes({
                  'service.name': serviceName,
                  'service.version': serviceVersion,
                }),
              },
              scopeSpans: [
                {
                  scope: {
                    name: '@latticedx/otel-exporter',
                    version: '1.0.0',
                  },
                  spans: batch,
                },
              ],
            },
          ],
        };

        try {
          const response = await fetchFn(tracesUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(exportTimeoutMs),
          });
          if (!response || !response.ok) {
            exportFailures += 1;
            lastError = `HTTP_${response?.status ?? 'UNKNOWN'}`;
            break;
          }
          queue.splice(0, batch.length);
          totalExported += batch.length;
          exportedSpans += batch.length;
          exportBatches += 1;
          lastExportAt = new Date().toISOString();
          lastError = null;
        } catch (error) {
          exportFailures += 1;
          lastError = String(error?.name || 'ExportError');
          break;
        }
      }
      return {
        exported: totalExported,
        remaining: queue.length,
        ...(lastError ? { error: lastError } : {}),
      };
    })();

    try {
      return await flushInFlight;
    } finally {
      flushInFlight = null;
    }
  }

  if (tracesUrl && flushIntervalMs > 0) {
    timer = setInterval(() => {
      if (queue.length > 0) {
        void flushOtel();
      }
    }, flushIntervalMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  }

  function traceMiddleware() {
    return async function dxosOtelTraceMiddleware(ctx, next) {
      const incoming = parseTraceparent(getHeader(ctx, 'traceparent'));
      const traceId = incoming ? incoming.traceId : randomHex(16);
      const parentSpanId = incoming ? incoming.parentSpanId : undefined;
      const spanId = randomHex(8);
      const traceFlags = incoming ? incoming.traceFlags : '01';
      const traceparent = formatTraceparent(traceId, spanId, traceFlags);

      if (ctx) {
        ctx.state = ctx.state || {};
        ctx.state.traceId = traceId;
        ctx.state.spanId = spanId;
        ctx.state.parentSpanId = parentSpanId;
        ctx.state.traceparent = traceparent;
        setHeader(ctx, 'traceparent', traceparent);
      }

      const startUnixNano = BigInt(Date.now()) * 1_000_000n;
      const startHr = process.hrtime.bigint();
      let caughtError = null;
      try {
        if (typeof next === 'function') {
          await next();
        }
      } catch (error) {
        caughtError = error;
        throw error;
      } finally {
        const elapsedNs = process.hrtime.bigint() - startHr;
        const endUnixNano = startUnixNano + (elapsedNs >= 0n ? elapsedNs : 0n);
        const method = String(ctx?.method || 'GET').toUpperCase();
        const safePath = sanitizePath(ctx?.path || ctx?.url || '/');
        const statusCode = caughtError
          ? Number(caughtError.status || caughtError.statusCode || (ctx?.status && ctx.status !== 404 ? ctx.status : 500))
          : Number(ctx?.status || (ctx?.body !== undefined ? 200 : 404));
        const requestId = getHeader(ctx, 'x-request-id');

        recordSpan({
          name: `HTTP ${method} ${safePath}`,
          kind: 2,
          traceId,
          spanId,
          parentSpanId,
          startTimeUnixNano: startUnixNano.toString(),
          endTimeUnixNano: endUnixNano.toString(),
          attributes: {
            'http.request.method': method,
            'url.path': safePath,
            'http.response.status_code': statusCode,
            ...(requestId ? { 'dxos.request_id': requestId } : {}),
          },
          status: {
            code: caughtError || statusCode >= 500 ? 2 : 1,
          },
        });

        if (tracesUrl && queue.length >= batchSize) {
          void flushOtel();
        }
      }
    };
  }

  function getOtelStats() {
    return {
      enabled: Boolean(tracesUrl),
      serviceName,
      endpoint: tracesUrl || null,
      queuedSpans: queue.length,
      recordedSpans,
      exportedSpans,
      droppedSpans,
      exportBatches,
      exportFailures,
      lastExportAt,
      lastError,
    };
  }

  async function shutdown() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    return flushOtel();
  }

  return {
    traceMiddleware,
    recordSpan,
    parseTraceparent,
    formatTraceparent,
    flushOtel,
    getOtelStats,
    shutdown,
  };
}

let defaultExporter = null;

function getDefaultOtelExporter() {
  if (!defaultExporter) {
    defaultExporter = createOtelExporter();
  }
  return defaultExporter;
}

function traceMiddleware() {
  return getDefaultOtelExporter().traceMiddleware();
}

function recordSpan(span) {
  return getDefaultOtelExporter().recordSpan(span);
}

function flushOtel() {
  return getDefaultOtelExporter().flushOtel();
}

function getOtelStats() {
  return getDefaultOtelExporter().getOtelStats();
}

module.exports = {
  DEFAULT_MAX_QUEUE_SIZE,
  createOtelExporter,
  traceMiddleware,
  recordSpan,
  parseTraceparent,
  formatTraceparent,
  flushOtel,
  getOtelStats,
  redactAttributes,
  getDefaultOtelExporter,
};
