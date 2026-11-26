/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { createHash, timingSafeEqual } = require('node:crypto');
const { buildOpenApiSpec, buildAsyncApiSpec } = require('./openapi-spec');
const { registerMobilePwaActions } = require('./mobile-pwa');
const { canUsePgRlsSession, getActiveRlsContext, runInRlsSavepoint, withSystemRlsBypass } = require('./pg-rls');
const { createOtelExporter } = require('./otel-exporter');

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const HISTOGRAM_BUCKETS = Object.freeze([
  { le: 0.025, label: '0.025' },
  { le: 0.1, label: '0.1' },
  { le: 0.5, label: '0.5' },
  { le: 2.0, label: '2.0' },
]);
const OUTBOX_STATES = Object.freeze(['pending', 'retry', 'processing', 'delivered', 'failed']);
const EVENT_BUS_STATUSES = Object.freeze(['queued', 'dispatched', 'partial_failed']);
const WEBHOOK_DELIVERY_STATUSES = Object.freeze(['pending', 'processing', 'delivered', 'retry_wait', 'dlq']);
const WEBHOOK_CIRCUIT_STATES = Object.freeze(['closed', 'open', 'half_open']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const METRICS_ALLOWED_ROLES = new Set(['root', 'ldx_admin']);

const val = (row, key) => (typeof row?.get === 'function' ? row.get(key) : row?.[key]);

function resolvePackageVersion() {
  try {
    const pkg = require('../../package.json');
    if (pkg && typeof pkg.version === 'string' && pkg.version.trim()) {
      return pkg.version.trim();
    }
  } catch {
    // Fallback below
  }
  return '0.4.0';
}

function failObs(ctx, status, message, code) {
  if (typeof ctx?.throw === 'function') {
    ctx.throw(status, message, code ? { code } : undefined);
  }
  throw Object.assign(new Error(message || `HTTP ${status}`), { status, code });
}

function getReqHeader(ctx, name) {
  if (typeof ctx?.get === 'function') {
    const v = ctx.get(name);
    if (v) return String(v).trim();
  }
  const lower = String(name || '').toLowerCase();
  const h = ctx?.headers?.[lower] ?? ctx?.request?.headers?.[lower];
  return h ? String(h).trim() : '';
}

function getResHeader(ctx, name) {
  const lower = String(name || '').toLowerCase();
  const headers = ctx?.response?.headers;
  if (!headers || typeof headers !== 'object') return '';
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower && v !== undefined && v !== null) {
      return String(v).trim();
    }
  }
  return '';
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
  ctx.response = ctx.response || {};
  ctx.response.headers = ctx.response.headers || {};
  ctx.response.headers[name] = value;
}

function removeHeader(ctx, name) {
  if (typeof ctx?.remove === 'function') {
    ctx.remove(name);
  } else if (typeof ctx?.response?.remove === 'function') {
    ctx.response.remove(name);
  }
  const lower = String(name || '').toLowerCase();
  const headers = ctx?.response?.headers;
  if (headers && typeof headers === 'object') {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === lower) {
        delete headers[key];
      }
    }
  }
}

function parseAllowedOrigins(env = process.env) {
  const allowed = new Set();
  const raw = String(env?.DX_CORS_ALLOWED_ORIGINS || '').trim();
  if (!raw) return allowed;
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    try {
      const parsed = new URL(trimmed);
      if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && !parsed.username && !parsed.password) {
        allowed.add(parsed.origin.toLowerCase());
      }
    } catch {
      // Ignore malformed configured origin entries
    }
  }
  return allowed;
}

function effectivePort(urlObj) {
  if (urlObj.port) return urlObj.port;
  return urlObj.protocol === 'https:' ? '443' : '80';
}

function isTrustedOrigin(rawOrigin, ctx, env = process.env) {
  const originStr = String(rawOrigin || '').trim();
  if (!originStr) return false;
  let parsed;
  try {
    parsed = new URL(originStr);
  } catch {
    return false;
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) {
    return false;
  }

  const normalizedOrigin = parsed.origin.toLowerCase();
  if (parseAllowedOrigins(env).has(normalizedOrigin)) {
    return true;
  }

  const rawHost = getReqHeader(ctx, 'host') || String(ctx?.host || '').trim();
  if (!rawHost || /[/?#\\@\s]/.test(rawHost)) {
    return false;
  }
  const requestHostLower = rawHost.toLowerCase();
  if (parsed.host.toLowerCase() === requestHostLower) {
    return true;
  }

  try {
    const hostUrl = new URL(`${parsed.protocol}//${requestHostLower}`);
    const originHost = parsed.hostname.toLowerCase();
    const targetHost = hostUrl.hostname.toLowerCase();
    if (LOOPBACK_HOSTS.has(originHost) && LOOPBACK_HOSTS.has(targetHost)) {
      return effectivePort(parsed) === effectivePort(hostUrl);
    }
  } catch {
    return false;
  }
  return false;
}

function normalizeMethod(method) {
  const upper = String(method || 'GET').trim().toUpperCase();
  return ALLOWED_METHODS.has(upper) ? upper : 'OTHER';
}

function toStatusClass(status) {
  const code = Number(status);
  if (code >= 200 && code < 300) return '2xx';
  if (code >= 300 && code < 400) return '3xx';
  if (code >= 400 && code < 500) return '4xx';
  if (code >= 500 && code < 600) return '5xx';
  return 'other';
}

async function hasQueryableRepo(db, collection) {
  try {
    if (typeof db?.hasCollection === 'function' && !db.hasCollection(collection)) {
      return false;
    }
    const repo = db?.getRepository?.(collection);
    return Boolean(repo && typeof repo.count === 'function');
  } catch {
    return false;
  }
}

async function safeCount(db, collection, filter, transaction) {
  try {
    if (typeof db?.hasCollection === 'function' && !db.hasCollection(collection)) {
      return 0;
    }
    const repo = db?.getRepository?.(collection);
    if (!repo || typeof repo.count !== 'function') return 0;
    const executeCount = async (tx) => {
      const opts = filter || tx
        ? { ...(filter ? { filter } : {}), ...(tx ? { transaction: tx } : {}) }
        : undefined;
      const count = await repo.count(opts);
      const num = Number(count);
      return Number.isFinite(num) && num >= 0 ? num : 0;
    };
    if (transaction && getActiveRlsContext()?.transaction === transaction) {
      return await runInRlsSavepoint(db, executeCount);
    }
    return await executeCount(transaction);
  } catch {
    return 0;
  }
}

async function collectDbGaugesWithTx(db, transaction = undefined) {
  const aiAuditLogsTotal = await safeCount(db, 'latticeAiAuditLogs', undefined, transaction);
  const activeAlarmsTotal = await safeCount(db, 'latticeIncidentCases', { status: { $in: ['open', 'acknowledged'] } }, transaction);
  const unreadNotificationsTotal = await safeCount(db, 'latticeNotifications', { readAt: null, active: true }, transaction);
  const slaPoliciesActive = await safeCount(db, 'latticeSlaPolicies', { active: true }, transaction);
  const hasEventBusRepo = await hasQueryableRepo(db, 'latticeEventBus');
  const hasDeliveriesRepo = await hasQueryableRepo(db, 'latticeWebhookDeliveries');
  const hasSubscriptionsRepo = await hasQueryableRepo(db, 'latticeWebhookSubscriptions');

  const outboxByState = {};
  for (const state of OUTBOX_STATES) {
    outboxByState[state] = await safeCount(db, 'latticeContextOutbox', { state }, transaction);
  }

  let eventBusByStatus = null;
  if (hasEventBusRepo) {
    eventBusByStatus = {};
    for (const status of EVENT_BUS_STATUSES) {
      eventBusByStatus[status] = await safeCount(db, 'latticeEventBus', { status }, transaction);
    }
  }

  let webhookDeliveriesByStatus = null;
  if (hasDeliveriesRepo) {
    webhookDeliveriesByStatus = {};
    for (const status of WEBHOOK_DELIVERY_STATUSES) {
      webhookDeliveriesByStatus[status] = await safeCount(db, 'latticeWebhookDeliveries', { status }, transaction);
    }
  }

  let webhookCircuitsByState = null;
  if (hasSubscriptionsRepo) {
    webhookCircuitsByState = {};
    for (const circuitState of WEBHOOK_CIRCUIT_STATES) {
      webhookCircuitsByState[circuitState] = await safeCount(db, 'latticeWebhookSubscriptions', { circuitState }, transaction);
    }
  }

  return {
    ai_audit_logs_total: aiAuditLogsTotal,
    outbox_by_state: outboxByState,
    active_alarms_total: activeAlarmsTotal,
    unread_notifications_total: unreadNotificationsTotal,
    sla_policies_active: slaPoliciesActive,
    event_bus_by_status: eventBusByStatus,
    webhook_deliveries_by_status: webhookDeliveriesByStatus,
    webhook_circuits_by_state: webhookCircuitsByState,
  };
}

async function collectDbGauges(db) {
  if (canUsePgRlsSession(db)) {
    return withSystemRlsBypass(db, (transaction) => collectDbGaugesWithTx(db, transaction));
  }
  return collectDbGaugesWithTx(db, undefined);
}

function createMetricsRegistry({ otelExporter = null } = {}) {
  const requestCounts = new Map();
  const bucketCounts = HISTOGRAM_BUCKETS.map(() => 0);
  let durationSum = 0;
  let durationCount = 0;
  let activeOtelExporter = otelExporter;

  function setOtelExporter(exporter) {
    activeOtelExporter = exporter || null;
  }

  function recordRequest(method, statusCode, durationSeconds) {
    const normMethod = normalizeMethod(method);
    const statusClass = toStatusClass(statusCode);
    const key = `${normMethod}|${statusClass}`;
    requestCounts.set(key, (requestCounts.get(key) || 0) + 1);

    const safeDuration = Number.isFinite(durationSeconds) && durationSeconds >= 0 ? durationSeconds : 0;
    durationSum += safeDuration;
    durationCount += 1;
    for (let i = 0; i < HISTOGRAM_BUCKETS.length; i += 1) {
      if (safeDuration <= HISTOGRAM_BUCKETS[i].le) {
        bucketCounts[i] += 1;
      }
    }
  }

  async function formatPrometheusMetrics(db) {
    const gauges = await collectDbGauges(db);
    const lines = [];

    lines.push('# HELP latticedx_http_requests_total Total HTTP requests partitioned by method and status class.');
    lines.push('# TYPE latticedx_http_requests_total counter');
    if (requestCounts.size === 0) {
      lines.push('latticedx_http_requests_total{method="GET",status_class="2xx"} 0');
    } else {
      for (const [key, count] of [...requestCounts.entries()].sort()) {
        const [method, statusClass] = key.split('|');
        lines.push(`latticedx_http_requests_total{method="${method}",status_class="${statusClass}"} ${count}`);
      }
    }

    lines.push('# HELP latticedx_http_request_duration_seconds HTTP request latency histogram in seconds.');
    lines.push('# TYPE latticedx_http_request_duration_seconds histogram');
    for (let i = 0; i < HISTOGRAM_BUCKETS.length; i += 1) {
      lines.push(`latticedx_http_request_duration_seconds_bucket{le="${HISTOGRAM_BUCKETS[i].label}"} ${bucketCounts[i]}`);
    }
    lines.push(`latticedx_http_request_duration_seconds_bucket{le="+Inf"} ${durationCount}`);
    lines.push(`latticedx_http_request_duration_seconds_sum ${durationSum.toFixed(6)}`);
    lines.push(`latticedx_http_request_duration_seconds_count ${durationCount}`);

    lines.push('# HELP latticedx_ai_audit_logs_total Total recorded AI and MCP audit log rows.');
    lines.push('# TYPE latticedx_ai_audit_logs_total gauge');
    lines.push(`latticedx_ai_audit_logs_total ${gauges.ai_audit_logs_total}`);

    lines.push('# HELP latticedx_outbox_by_state Count of context outbox events by delivery state.');
    lines.push('# TYPE latticedx_outbox_by_state gauge');
    for (const state of OUTBOX_STATES) {
      lines.push(`latticedx_outbox_by_state{state="${state}"} ${gauges.outbox_by_state[state]}`);
    }

    lines.push('# HELP latticedx_active_alarms_total Count of active open or acknowledged incident alarms.');
    lines.push('# TYPE latticedx_active_alarms_total gauge');
    lines.push(`latticedx_active_alarms_total ${gauges.active_alarms_total}`);

    lines.push('# HELP latticedx_unread_notifications_total Count of unread active notifications.');
    lines.push('# TYPE latticedx_unread_notifications_total gauge');
    lines.push(`latticedx_unread_notifications_total ${gauges.unread_notifications_total}`);

    lines.push('# HELP latticedx_sla_policies_active Count of active SLA escalation policies.');
    lines.push('# TYPE latticedx_sla_policies_active gauge');
    lines.push(`latticedx_sla_policies_active ${gauges.sla_policies_active}`);

    if (gauges.event_bus_by_status) {
      lines.push('# HELP latticedx_event_bus_by_status Count of domain events in event bus by delivery status.');
      lines.push('# TYPE latticedx_event_bus_by_status gauge');
      for (const status of EVENT_BUS_STATUSES) {
        lines.push(`latticedx_event_bus_by_status{status="${status}"} ${gauges.event_bus_by_status[status]}`);
      }
    }

    if (gauges.webhook_deliveries_by_status) {
      lines.push('# HELP latticedx_webhook_deliveries_by_status Count of outbound webhook deliveries by status.');
      lines.push('# TYPE latticedx_webhook_deliveries_by_status gauge');
      for (const status of WEBHOOK_DELIVERY_STATUSES) {
        lines.push(`latticedx_webhook_deliveries_by_status{status="${status}"} ${gauges.webhook_deliveries_by_status[status]}`);
      }
    }

    if (gauges.webhook_circuits_by_state) {
      lines.push('# HELP latticedx_webhook_circuits_by_state Count of webhook subscriptions by circuit breaker state.');
      lines.push('# TYPE latticedx_webhook_circuits_by_state gauge');
      for (const state of WEBHOOK_CIRCUIT_STATES) {
        lines.push(`latticedx_webhook_circuits_by_state{state="${state}"} ${gauges.webhook_circuits_by_state[state]}`);
      }
    }

    lines.push('# HELP latticedx_uptime_seconds Node.js process uptime in seconds.');
    lines.push('# TYPE latticedx_uptime_seconds gauge');
    lines.push(`latticedx_uptime_seconds ${Math.floor(process.uptime())}`);

    if (activeOtelExporter && typeof activeOtelExporter.getOtelStats === 'function') {
      const otelStats = activeOtelExporter.getOtelStats();
      lines.push('# HELP latticedx_otel_spans_recorded_total Total OpenTelemetry spans recorded.');
      lines.push('# TYPE latticedx_otel_spans_recorded_total counter');
      lines.push(`latticedx_otel_spans_recorded_total ${Number(otelStats.recordedSpans || 0)}`);

      lines.push('# HELP latticedx_otel_spans_exported_total Total OpenTelemetry spans exported.');
      lines.push('# TYPE latticedx_otel_spans_exported_total counter');
      lines.push(`latticedx_otel_spans_exported_total ${Number(otelStats.exportedSpans || 0)}`);

      lines.push('# HELP latticedx_otel_spans_dropped_total Total OpenTelemetry spans dropped due to queue overflow.');
      lines.push('# TYPE latticedx_otel_spans_dropped_total counter');
      lines.push(`latticedx_otel_spans_dropped_total ${Number(otelStats.droppedSpans || 0)}`);

      lines.push('# HELP latticedx_otel_export_failures_total Total OpenTelemetry OTLP/HTTP export failures.');
      lines.push('# TYPE latticedx_otel_export_failures_total counter');
      lines.push(`latticedx_otel_export_failures_total ${Number(otelStats.exportFailures || 0)}`);

      lines.push('# HELP latticedx_otel_queue_size Current OpenTelemetry span queue depth.');
      lines.push('# TYPE latticedx_otel_queue_size gauge');
      lines.push(`latticedx_otel_queue_size ${Number(otelStats.queuedSpans || 0)}`);
    }

    return `${lines.join('\n')}\n`;
  }

  return {
    recordRequest,
    setOtelExporter,
    formatPrometheusMetrics,
  };
}

function createObservabilityMiddleware(registry, { env = process.env, otelExporter = null } = {}) {
  const activeRegistry = registry || createMetricsRegistry({ otelExporter });
  const traceMw = otelExporter && typeof otelExporter.traceMiddleware === 'function'
    ? otelExporter.traceMiddleware()
    : null;
  return async function dxosObservabilityMiddleware(ctx, next) {
    const startNs = process.hrtime.bigint();
    let caughtError = null;
    try {
      if (traceMw) {
        await traceMw(ctx, next);
      } else {
        await next();
      }
    } catch (error) {
      caughtError = error;
      throw error;
    } finally {
      setHeader(ctx, 'X-Content-Type-Options', 'nosniff');
      setHeader(ctx, 'X-Frame-Options', 'SAMEORIGIN');
      setHeader(ctx, 'Referrer-Policy', 'strict-origin-when-cross-origin');

      const strictCors = String(env?.DX_CORS_STRICT ?? 'true').trim().toLowerCase() !== 'false';
      if (strictCors) {
        const reqOrigin = getReqHeader(ctx, 'origin');
        const reflectedAcao = getResHeader(ctx, 'access-control-allow-origin');
        const untrustedRequestOrigin = Boolean(reqOrigin && !isTrustedOrigin(reqOrigin, ctx, env));
        const untrustedReflectedOrigin = Boolean(
          reflectedAcao && (reflectedAcao === '*' ? Boolean(reqOrigin && !isTrustedOrigin(reqOrigin, ctx, env)) : !isTrustedOrigin(reflectedAcao, ctx, env)),
        );
        if (untrustedRequestOrigin || untrustedReflectedOrigin) {
          removeHeader(ctx, 'Access-Control-Allow-Origin');
          removeHeader(ctx, 'Access-Control-Allow-Credentials');
          removeHeader(ctx, 'Access-Control-Allow-Methods');
          removeHeader(ctx, 'Access-Control-Allow-Headers');
        }
      }

      const elapsedSec = Number(process.hrtime.bigint() - startNs) / 1e9;
      const status = caughtError
        ? Number(caughtError.status || caughtError.statusCode || (ctx?.status && ctx.status !== 404 ? ctx.status : 500))
        : Number(ctx?.status || (ctx?.body !== undefined ? 200 : 404));
      activeRegistry.recordRequest(ctx?.method, status, elapsedSec);
    }
  };
}

function extractBearerToken(ctx) {
  const rawAuth = getReqHeader(ctx, 'authorization');
  if (rawAuth) {
    const m = rawAuth.match(/^Bearer\s+(.+)$/i);
    if (m && m[1]) return m[1].trim();
  }
  if (typeof ctx?.getBearerToken === 'function') {
    const t = ctx.getBearerToken();
    if (t) return String(t).trim();
  }
  return '';
}

function timingSafeTokenMatch(expected, provided) {
  if (typeof expected !== 'string' || typeof provided !== 'string') return false;
  if (!expected.trim() || !provided.trim()) return false;
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  const providedDigest = createHash('sha256').update(provided.trim(), 'utf8').digest();
  return timingSafeEqual(expectedDigest, providedDigest);
}

async function resolveVerifiedCallerRoles(ctx, db, userId) {
  const rolesUsersRepo = db?.getRepository?.('rolesUsers');
  if (rolesUsersRepo && typeof rolesUsersRepo.find === 'function' && userId != null) {
    const rows = (await rolesUsersRepo.find({ filter: { userId } })) || [];
    return [...new Set(rows.map((r) => String(val(r, 'roleName') || '').trim()).filter(Boolean))];
  }
  if (Array.isArray(ctx?.state?.currentRoles) && ctx.state.currentRoles.length) {
    return [...new Set(ctx.state.currentRoles.map((r) => String(r || '').trim()).filter(Boolean))];
  }
  if (ctx?.state?.currentRole) {
    return [String(ctx.state.currentRole).trim()];
  }
  return [];
}

async function resolveHostJwtUser(app, ctx) {
  const existing = ctx?.state?.currentUser || ctx?.auth?.user;
  if (existing) {
    return { user: existing, authError: false };
  }
  if (typeof ctx?.auth?.check === 'function') {
    try {
      const checked = await ctx.auth.check();
      const user = checked || ctx.auth?.user || ctx.state?.currentUser || null;
      if (user) {
        ctx.auth.user = user;
        ctx.state = ctx.state || {};
        ctx.state.currentUser = user;
      }
      return { user, authError: false };
    } catch {
      return { user: null, authError: true };
    }
  }
  if (typeof app?.authManager?.get === 'function') {
    const authenticatorName = getReqHeader(ctx, 'x-authenticator')
      || String(app.authManager.defaultAuthenticator || 'basic');
    try {
      const authenticator = await app.authManager.get(authenticatorName, ctx);
      if (authenticator && typeof authenticator.check === 'function') {
        const user = await authenticator.check(ctx);
        if (user) {
          ctx.auth = ctx.auth || {};
          ctx.auth.user = user;
          ctx.state = ctx.state || {};
          ctx.state.currentUser = user;
        }
        return { user: user || null, authError: false };
      }
    } catch {
      return { user: null, authError: true };
    }
  }
  if (typeof app?.authManager?.middleware === 'function') {
    try {
      await app.authManager.middleware()(ctx, async () => {});
    } catch {
      return { user: null, authError: true };
    }
    return { user: ctx?.state?.currentUser || ctx?.auth?.user || null, authError: false };
  }
  return { user: null, authError: false };
}

async function authorizeMetricsRequest(app, db, ctx, env = process.env) {
  const configuredToken = String(env?.DX_METRICS_TOKEN || '').trim();
  const bearer = extractBearerToken(ctx);
  if (configuredToken && bearer && timingSafeTokenMatch(configuredToken, bearer)) {
    return { allowed: true, via: 'metrics_token' };
  }

  const activeDb = db || ctx?.db || app?.db;
  const { user: currentUser, authError } = await resolveHostJwtUser(app, ctx);
  const userId = val(currentUser, 'id');
  if (authError || !currentUser || userId == null) {
    return { allowed: false, status: 401, code: 'METRICS_AUTH_REQUIRED', message: 'Authentication required for metrics.' };
  }

  const roles = await resolveVerifiedCallerRoles(ctx, activeDb, userId);
  if (!roles.some((role) => METRICS_ALLOWED_ROLES.has(role))) {
    return { allowed: false, status: 403, code: 'METRICS_FORBIDDEN', message: 'Metrics access requires root or ldx_admin role.' };
  }
  return { allowed: true, via: 'user_role', roles };
}

async function checkDbHealth(db) {
  if (!db) return false;
  try {
    if (typeof db.sequelize?.authenticate === 'function') {
      await db.sequelize.authenticate();
      return true;
    }
    if (typeof db.sequelize?.query === 'function') {
      await db.sequelize.query('SELECT 1');
      return true;
    }
    if (typeof db.getRepository === 'function') {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function resolveRequestServerUrl(ctx) {
  const rawProto = getReqHeader(ctx, 'x-forwarded-proto').split(',')[0].trim().toLowerCase();
  const proto = rawProto === 'https' || rawProto === 'http' ? rawProto : (ctx?.protocol === 'https' ? 'https' : 'http');
  const rawHost = (getReqHeader(ctx, 'x-forwarded-host') || getReqHeader(ctx, 'host') || String(ctx?.host || '')).split(',')[0].trim();
  if (rawHost && /^[a-zA-Z0-9.:[\]-]{1,253}$/.test(rawHost)) {
    return `${proto}://${rawHost}`;
  }
  return 'http://localhost:13014';
}

async function serveSpecDocument(ctx, next, buildSpec, version, db) {
  if (ctx.method && ctx.method !== 'GET') {
    failObs(ctx, 405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
  }
  ctx.withoutDataWrapping = true;
  setHeader(ctx, 'Content-Type', 'application/json; charset=utf-8');
  setHeader(ctx, 'Cache-Control', 'no-store');
  ctx.status = 200;
  ctx.body = buildSpec({ serverUrl: resolveRequestServerUrl(ctx), version, db });
  if (next) await next();
}

function registerObservability(app, { env = process.env, registry = createMetricsRegistry(), otelExporter } = {}) {
  const version = resolvePackageVersion();
  const activeOtel = otelExporter || createOtelExporter({
    serviceName: String(env?.OTEL_SERVICE_NAME || 'latticedx-nocobase').trim(),
    serviceVersion: version,
    endpoint: env?.OTEL_EXPORTER_OTLP_ENDPOINT ?? '',
  });
  if (typeof registry?.setOtelExporter === 'function') {
    registry.setOtelExporter(activeOtel);
  }
  const middleware = createObservabilityMiddleware(registry, { env, otelExporter: activeOtel });

  if (app && typeof app === 'object') {
    app.latticeOtel = activeOtel;
  }

  if (typeof app?.use === 'function') {
    app.use(middleware, { tag: 'dxosObservability', before: 'cors' });
  } else if (typeof app?.resourceManager?.use === 'function') {
    app.resourceManager.use(middleware, { tag: 'dxosObservability' });
  }

  const mobilePwaActions = registerMobilePwaActions({ version });

  app.resourceManager.define({
    name: 'dxos',
    actions: {
      health: async (ctx, next) => {
        if (ctx.method && ctx.method !== 'GET') {
          failObs(ctx, 405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
        }
        const activeDb = ctx.db || app?.db;
        const dbHealthy = await checkDbHealth(activeDb);
        ctx.status = dbHealthy ? 200 : 503;
        ctx.body = {
          status: dbHealthy ? 'ok' : 'degraded',
          version,
          uptimeSec: Math.floor(process.uptime()),
          dbHealthy,
          otel: activeOtel.getOtelStats(),
        };
        if (next) await next();
      },
      metrics: async (ctx, next) => {
        const activeDb = ctx.db || app?.db;
        const auth = await authorizeMetricsRequest(app, activeDb, ctx, env);
        if (!auth.allowed) {
          failObs(ctx, auth.status, auth.message, auth.code);
        }
        if (ctx.method && ctx.method !== 'GET') {
          failObs(ctx, 405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
        }
        ctx.withoutDataWrapping = true;
        setHeader(ctx, 'Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
        setHeader(ctx, 'Cache-Control', 'no-store');
        ctx.status = 200;
        ctx.body = await registry.formatPrometheusMetrics(activeDb);
        if (next) await next();
      },
      openapi: (ctx, next) => serveSpecDocument(ctx, next, buildOpenApiSpec, version, ctx?.db || app?.db || null),
      asyncapi: (ctx, next) => serveSpecDocument(ctx, next, buildAsyncApiSpec, version, ctx?.db || app?.db || null),
      ...mobilePwaActions,
    },
  });

  if (typeof app?.acl?.allow === 'function') {
    app.acl.allow('dxos', ['health', 'metrics', 'openapi', 'asyncapi', 'manifest', 'sw.js', 'sw'], 'public');
  }

  return { registry, middleware, otelExporter: activeOtel };
}

module.exports = {
  HISTOGRAM_BUCKETS,
  OUTBOX_STATES,
  EVENT_BUS_STATUSES,
  WEBHOOK_DELIVERY_STATUSES,
  WEBHOOK_CIRCUIT_STATES,
  isTrustedOrigin,
  collectDbGauges,
  createMetricsRegistry,
  createObservabilityMiddleware,
  timingSafeTokenMatch,
  authorizeMetricsRequest,
  checkDbHealth,
  registerObservability,
};
