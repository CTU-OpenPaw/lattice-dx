/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const {
  createHmac,
  randomUUID,
  timingSafeEqual,
} = require('node:crypto');
const { resolveNativeActor } = require('./native-scope');
const { canUsePgRlsSession, getActiveRlsContext, runInRlsSavepoint, withSystemRlsBypass, withTenantRlsContext } = require('./pg-rls');
const { val, getRepo, callerRoles } = require('./native-portal-helpers');
const { assertApiKeyScope, readParams } = require('./paas-api-keys');
const {
  assertSafeConnectorUrl,
  assertSafeConnectorUrlAsync,
  buildConnectorAuthHeaders,
  decryptSecretText,
  encryptSecretText,
  resolveAllowInternalConnectorHosts,
  resolveConnectorSecrets,
} = require('./connector-vault');

const ORG_ID_RE = /^[a-zA-Z0-9_-]{1,80}$/;
const SUB_KEY_RE = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const ELEVATED_ROLES = new Set(['root', 'admin', 'ldx_admin']);
const EVENT_BUS_PROTECTED_RESOURCES = Object.freeze(new Set([
  'latticeEventBus',
  'latticeWebhookSubscriptions',
  'latticeWebhookDeliveries',
]));
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_COOLDOWN_MS = 120_000;
const WEBHOOK_TIMEOUT_MS = 5000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BACKOFF_BASE_MS = 5000;
const MAX_BACKOFF_MS = 3600_000;
const DRAINER_INTERVAL_MS = 10_000;

const eventBusListeners = new Set();

function failEvent(code, status = 400, message = code) {
  return Object.assign(new Error(message), { code, status });
}

function hasMatchingActiveRlsTx(db) {
  const activeRls = getActiveRlsContext();
  return Boolean(
    activeRls?.transaction
    && (!activeRls.sequelize || !db?.sequelize || activeRls.sequelize === db.sequelize),
  );
}

function normalizeRawBody(body) {
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  if (typeof body === 'string') return body;
  return JSON.stringify(body ?? {});
}

function decodeSigningSecret(secret) {
  if (Buffer.isBuffer(secret)) return secret;
  const raw = String(secret ?? '');
  if (raw.startsWith('whsec_')) {
    return Buffer.from(raw.slice(6), 'base64');
  }
  return Buffer.from(raw, 'utf8');
}

function signStandardWebhookPayload({ webhookId, timestamp, body, secret }) {
  const cleanId = String(webhookId || '').trim();
  const tsStr = String(timestamp ?? Math.floor(Date.now() / 1000)).trim();
  const rawBody = normalizeRawBody(body);
  const keyBuf = decodeSigningSecret(secret);
  const mac = createHmac('sha256', keyBuf)
    .update(`${cleanId}.${tsStr}.${rawBody}`, 'utf8')
    .digest('base64');
  return `v1,${mac}`;
}

function verifyStandardWebhookSignature({
  webhookId,
  timestamp,
  body,
  signature,
  secret,
  toleranceSec = 300,
  nowMs = Date.now(),
} = {}) {
  if (
    typeof webhookId !== 'string'
    || !webhookId.trim()
    || (typeof secret !== 'string' && !Buffer.isBuffer(secret))
    || !secret
    || typeof signature !== 'string'
    || !signature.trim()
    || body === undefined
    || body === null
  ) {
    return false;
  }

  const keyBuf = decodeSigningSecret(secret);
  if (!keyBuf.length) {
    return false;
  }

  const tsStr = String(timestamp ?? '').trim();
  if (!/^\d+$/.test(tsStr)) return false;
  const tsNum = Number(tsStr);
  const tol = Number(toleranceSec);
  if (!Number.isFinite(tsNum) || tsNum <= 0 || !Number.isFinite(tol) || tol < 0) {
    return false;
  }

  const nowSec = Math.floor(Number(nowMs) / 1000);
  if (Math.abs(nowSec - tsNum) > tol) {
    return false;
  }

  const rawBody = normalizeRawBody(body);
  const expectedBuf = createHmac('sha256', keyBuf)
    .update(`${webhookId.trim()}.${tsStr}.${rawBody}`, 'utf8')
    .digest();

  const tokens = signature.trim().split(/\s+/);
  for (const token of tokens) {
    if (!token.startsWith('v1,')) continue;
    const b64 = token.slice(3);
    if (!b64) continue;
    try {
      const providedBuf = Buffer.from(b64, 'base64');
      if (providedBuf.length === expectedBuf.length && timingSafeEqual(expectedBuf, providedBuf)) {
        return true;
      }
    } catch {
      // Continue checking any remaining signatures
    }
  }
  return false;
}

function registerEventBusListener(fn) {
  if (typeof fn !== 'function') {
    throw new TypeError('registerEventBusListener requires a callback function.');
  }
  eventBusListeners.add(fn);
  return () => {
    eventBusListeners.delete(fn);
  };
}

function matchesEventPattern(pattern, eventType) {
  const target = String(eventType || '').trim();
  if (!target) return false;
  const raw = String(pattern || '*').trim();
  if (!raw) return false;
  for (const part of raw.split(',')) {
    const token = part.trim();
    if (!token) continue;
    if (token === '*') return true;
    if (token.length > 128) continue;
    const escaped = token.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    try {
      if (new RegExp(`^${escaped}$`).test(target)) return true;
    } catch {
      // Ignore malformed token
    }
  }
  return false;
}

function computeWebhookBackoffMs(
  attempt,
  {
    baseMs = DEFAULT_BACKOFF_BASE_MS,
    maxMs = MAX_BACKOFF_MS,
    jitterRatio = 0.25,
    randomFn = Math.random,
  } = {},
) {
  const exp = Math.min(20, Math.max(0, Number(attempt) || 0));
  const raw = Math.min(maxMs, Math.max(100, Number(baseMs) || DEFAULT_BACKOFF_BASE_MS) * (2 ** exp));
  const maxJitter = Math.min(5000, Math.floor(raw * Math.max(0, Number(jitterRatio) || 0)));
  const rand = typeof randomFn === 'function' ? Number(randomFn()) : Math.random();
  const clampedRand = Number.isFinite(rand) ? Math.max(0, Math.min(1, rand)) : 0;
  const jitter = maxJitter > 0 ? Math.floor(clampedRand * maxJitter) : 0;
  return Math.min(maxMs, raw + jitter);
}

function serializeEventRow(row) {
  if (!row) return null;
  const occ = val(row, 'occurredAt');
  return {
    id: val(row, 'id') ?? null,
    organizationId: val(row, 'organizationId') || null,
    eventId: val(row, 'eventId') || '',
    eventType: val(row, 'eventType') || '',
    source: val(row, 'source') || '',
    subject: val(row, 'subject') || null,
    specVersion: val(row, 'specVersion') || '1.0',
    correlationId: val(row, 'correlationId') || null,
    causationId: val(row, 'causationId') || null,
    depth: Number(val(row, 'depth')) || 0,
    payloadJson: val(row, 'payloadJson') || null,
    occurredAt: occ instanceof Date ? occ.toISOString() : String(occ || ''),
    status: val(row, 'status') || 'queued',
    createdAt: val(row, 'createdAt') || null,
  };
}

function serializeSubscription(row) {
  if (!row) return null;
  const openUntil = val(row, 'circuitOpenUntil');
  return {
    id: val(row, 'id') ?? null,
    organizationId: val(row, 'organizationId') || null,
    subscriptionKey: val(row, 'subscriptionKey') || '',
    name: val(row, 'name') || '',
    targetUrl: val(row, 'targetUrl') || '',
    eventPattern: val(row, 'eventPattern') || '*',
    hasSigningSecret: Boolean(val(row, 'encryptedSigningSecret') && String(val(row, 'encryptedSigningSecret')).trim()),
    connectorId: val(row, 'connectorId') != null ? Number(val(row, 'connectorId')) : null,
    active: val(row, 'active') !== false,
    failureCount: Number(val(row, 'failureCount')) || 0,
    circuitState: val(row, 'circuitState') || 'closed',
    circuitOpenUntil: openUntil ? (openUntil instanceof Date ? openUntil.toISOString() : String(openUntil)) : null,
    lastError: val(row, 'lastError') || null,
    createdAt: val(row, 'createdAt') || null,
    updatedAt: val(row, 'updatedAt') || null,
  };
}

function serializeDelivery(row) {
  if (!row) return null;
  const nextAt = val(row, 'nextAttemptAt');
  const lockedAt = val(row, 'lockedAt');
  const deliveredAt = val(row, 'deliveredAt');
  return {
    id: val(row, 'id') ?? null,
    organizationId: val(row, 'organizationId') || null,
    eventId: val(row, 'eventId') || '',
    subscriptionId: Number(val(row, 'subscriptionId')) || null,
    eventType: val(row, 'eventType') || '',
    attempt: Number(val(row, 'attempt')) || 0,
    maxAttempts: Number(val(row, 'maxAttempts')) || DEFAULT_MAX_ATTEMPTS,
    status: val(row, 'status') || 'pending',
    nextAttemptAt: nextAt ? (nextAt instanceof Date ? nextAt.toISOString() : String(nextAt)) : null,
    lockedAt: lockedAt ? (lockedAt instanceof Date ? lockedAt.toISOString() : String(lockedAt)) : null,
    lockedBy: val(row, 'lockedBy') || null,
    httpStatus: val(row, 'httpStatus') != null ? Number(val(row, 'httpStatus')) : null,
    lastError: val(row, 'lastError') || null,
    payloadSnapshotJson: val(row, 'payloadSnapshotJson') || null,
    deliveredAt: deliveredAt ? (deliveredAt instanceof Date ? deliveredAt.toISOString() : String(deliveredAt)) : null,
    createdAt: val(row, 'createdAt') || null,
  };
}

function runEventsScopedDb(db, organizationId, fn) {
  const activeTx = hasMatchingActiveRlsTx(db) ? getActiveRlsContext()?.transaction || null : null;
  if (!canUsePgRlsSession(db) || activeTx) {
    return fn(activeTx || undefined);
  }
  return organizationId
    ? withTenantRlsContext(db, organizationId, (tx) => fn(tx))
    : withSystemRlsBypass(db, (tx) => fn(tx));
}

async function publishDomainEvent(
  db,
  {
    organizationId,
    type,
    eventType,
    source = 'latticedx/foundation',
    subject = null,
    data = {},
    correlationId = null,
    causationId = null,
    depth = 0,
    transaction = null,
    app = null,
  } = {},
  options = {},
) {
  const effectiveTx = transaction ?? options?.transaction ?? null;
  const effectiveApp = app ?? options?.app ?? null;
  const orgId = typeof organizationId === 'string' ? organizationId.trim() : '';
  if (!ORG_ID_RE.test(orgId)) {
    throw failEvent('EVENT_ORG_REQUIRED', 400, 'Valid organizationId is required for domain event.');
  }
  const rawType = type ?? eventType;
  const cleanType = typeof rawType === 'string' ? rawType.trim().slice(0, 200) : '';
  if (!cleanType) {
    throw failEvent('EVENT_TYPE_REQUIRED', 400, 'Event type is required.');
  }
  const cleanSource = String(source || 'latticedx/foundation').trim().slice(0, 255) || 'latticedx/foundation';
  const cleanSubject = subject != null && String(subject).trim() ? String(subject).trim().slice(0, 255) : null;
  const cleanCorrelationId = correlationId != null && String(correlationId).trim()
    ? String(correlationId).trim().slice(0, 128)
    : null;
  const cleanCausationId = causationId != null && String(causationId).trim()
    ? String(causationId).trim().slice(0, 128)
    : null;
  const rawDepth = Number(depth);
  const cleanDepth = Number.isInteger(rawDepth) && rawDepth >= 0 ? rawDepth : 0;

  const eventId = randomUUID();
  const occurredAt = new Date();
  const cloudEvent = {
    specversion: '1.0',
    id: eventId,
    source: cleanSource,
    type: cleanType,
    subject: cleanSubject,
    time: occurredAt.toISOString(),
    datacontenttype: 'application/json',
    organizationid: orgId,
    correlationid: cleanCorrelationId,
    causationid: cleanCausationId,
    depth: cleanDepth,
    data: data === undefined ? null : data,
  };

  const persistEvent = async (tx) => {
    const txOpt = tx ? { transaction: tx } : {};
    const eventRepo = getRepo(db, 'latticeEventBus');
    let createdEvent = null;
    if (eventRepo && typeof eventRepo.create === 'function') {
      createdEvent = await eventRepo.create({
        values: {
          organizationId: orgId,
          eventId,
          eventType: cleanType,
          source: cleanSource,
          subject: cleanSubject,
          specVersion: '1.0',
          correlationId: cleanCorrelationId,
          causationId: cleanCausationId,
          depth: cleanDepth,
          payloadJson: cloudEvent,
          occurredAt,
          status: 'queued',
        },
        ...txOpt,
      });
    }

    let deliveriesQueued = 0;
    const subRepo = getRepo(db, 'latticeWebhookSubscriptions');
    const delRepo = getRepo(db, 'latticeWebhookDeliveries');
    if (subRepo && typeof subRepo.find === 'function' && delRepo && typeof delRepo.create === 'function') {
      const subs = (await subRepo.find({
        filter: { organizationId: orgId, active: true },
        limit: 500,
        ...txOpt,
      })) || [];
      for (const sub of subs) {
        if (val(sub, 'organizationId') !== orgId || val(sub, 'active') === false) continue;
        if (!matchesEventPattern(val(sub, 'eventPattern'), cleanType)) continue;
        const subId = Number(val(sub, 'id'));
        if (!Number.isInteger(subId) || subId <= 0) continue;
        await delRepo.create({
          values: {
            organizationId: orgId,
            eventId,
            subscriptionId: subId,
            eventType: cleanType,
            attempt: 0,
            maxAttempts: DEFAULT_MAX_ATTEMPTS,
            status: 'pending',
            nextAttemptAt: occurredAt,
            lockedAt: null,
            lockedBy: null,
            httpStatus: null,
            lastError: null,
            payloadSnapshotJson: cloudEvent,
            deliveredAt: null,
          },
          ...txOpt,
        });
        deliveriesQueued += 1;
      }
    }

    if (createdEvent && deliveriesQueued === 0) {
      const markDispatched = async (spTx) => {
        const markOpt = spTx ? { transaction: spTx } : txOpt;
        if (typeof createdEvent.update === 'function') {
          await createdEvent.update({ status: 'dispatched' }, markOpt);
        } else if (typeof eventRepo?.update === 'function') {
          await eventRepo.update({
            filterByTk: val(createdEvent, 'id'),
            filter: { organizationId: orgId },
            values: { status: 'dispatched' },
            ...markOpt,
          });
        }
      };
      try {
        if (tx && hasMatchingActiveRlsTx(db) && getActiveRlsContext()?.transaction === tx) {
          await runInRlsSavepoint(db, markDispatched);
        } else {
          await markDispatched(tx);
        }
      } catch {
        // Non-fatal status refinement
      }
    }

    return { createdEvent, deliveriesQueued };
  };

  const { createdEvent, deliveriesQueued } = effectiveTx
    ? await persistEvent(effectiveTx)
    : await runEventsScopedDb(db, orgId, persistEvent);

  for (const listener of [...eventBusListeners]) {
    try {
      await listener(cloudEvent, { db, app: effectiveApp, transaction: effectiveTx });
    } catch (err) {
      const logger = effectiveApp?.logger || db?.logger;
      if (typeof logger?.error === 'function') {
        logger.error('[dxosEvents] Listener failed', { eventId, type: cleanType, error: err?.message || String(err) });
      }
    }
  }

  try {
    await effectiveApp?.pubSubManager?.publish?.('latticedx:surface-updates', {
      kind: 'domain_event',
      portalSlug: '*',
      organizationId: orgId,
      eventId,
      eventType: cleanType,
      subject: cleanSubject,
      occurredAt: occurredAt.toISOString(),
    });
  } catch {
    // Non-fatal pub/sub forward
  }

  return {
    event: cloudEvent,
    deliveriesQueued,
    persisted: Boolean(createdEvent),
  };
}

async function updateRowCompat(repo, row, filter, values, transaction = null) {
  const txOpt = transaction ? { transaction } : {};
  if (typeof row?.update === 'function') {
    return row.update(values, transaction ? { transaction } : undefined);
  }
  if (typeof repo?.update === 'function') {
    const res = await repo.update({
      ...(val(row, 'id') != null ? { filterByTk: val(row, 'id') } : {}),
      filter,
      values,
      ...txOpt,
    });
    return Array.isArray(res) && res[0] ? res[0] : row;
  }
  return row;
}

async function syncParentEventStatus(db, organizationId, eventId, { transaction = null } = {}) {
  const eventRepo = getRepo(db, 'latticeEventBus');
  const delRepo = getRepo(db, 'latticeWebhookDeliveries');
  if (!eventRepo || !delRepo || typeof delRepo.find !== 'function') return;
  const runSync = async (tx) => {
    const txOpt = tx ? { transaction: tx } : {};
    const rows = (await delRepo.find({
      filter: { organizationId, eventId },
      limit: 500,
      ...txOpt,
    })) || [];
    if (!rows.length) return;
    const statuses = rows.map((r) => val(r, 'status'));
    let nextStatus = 'queued';
    if (statuses.some((s) => s === 'dlq')) {
      nextStatus = 'partial_failed';
    } else if (statuses.every((s) => s === 'delivered')) {
      nextStatus = 'dispatched';
    }
    const evRow = typeof eventRepo.findOne === 'function'
      ? await eventRepo.findOne({ filter: { organizationId, eventId }, ...txOpt })
      : null;
    if (evRow && val(evRow, 'status') !== nextStatus) {
      await updateRowCompat(eventRepo, evRow, { organizationId, eventId }, { status: nextStatus }, tx);
    }
  };
  try {
    const matchingActiveTx = hasMatchingActiveRlsTx(db) ? getActiveRlsContext()?.transaction || null : null;
    const activeTx = transaction || matchingActiveTx;
    if (activeTx) {
      if (matchingActiveTx && matchingActiveTx === activeTx) {
        await runInRlsSavepoint(db, runSync);
      } else {
        await runSync(activeTx);
      }
      return;
    }
    if (canUsePgRlsSession(db) && organizationId) {
      await withTenantRlsContext(db, organizationId, runSync);
      return;
    }
    await runSync(null);
  } catch {
    // Non-fatal event bus status sync
  }
}

async function claimDueDeliveries(db, {
  organizationId = null,
  batchSize = 20,
  nowDate = new Date(),
  workerId = 'dxos-event-bus',
  staleLockMs = 120_000,
} = {}) {
  const size = Math.max(1, Math.min(100, Number(batchSize) || 20));
  const delRepo = getRepo(db, 'latticeWebhookDeliveries');
  if (!delRepo) return [];

  const isPg = db?.sequelize?.getDialect?.() === 'postgres' && typeof db?.sequelize?.query === 'function';
  const delModel = db?.getModel?.('latticeWebhookDeliveries');

  if (isPg && typeof db?.sequelize?.transaction === 'function') {
    const withClaimRlsScope = (fn) => {
      if (hasMatchingActiveRlsTx(db)) {
        return runInRlsSavepoint(db, fn);
      }
      if (canUsePgRlsSession(db)) {
        return organizationId
          ? withTenantRlsContext(db, organizationId, fn)
          : withSystemRlsBypass(db, fn);
      }
      return db.sequelize.transaction(fn);
    };

    if (staleLockMs > 0) {
      try {
        const cutoff = new Date(nowDate.getTime() - staleLockMs);
        const reclaimSql = 'UPDATE "latticeWebhookDeliveries" SET status = \'retry_wait\', "lockedAt" = NULL, "lockedBy" = NULL, "nextAttemptAt" = NOW() WHERE status = \'processing\' AND "lockedAt" IS NOT NULL AND "lockedAt" < :cutoff';
        if (hasMatchingActiveRlsTx(db)) {
          await runInRlsSavepoint(db, (transaction) => db.sequelize.query(reclaimSql, { transaction, replacements: { cutoff } }));
        } else if (canUsePgRlsSession(db)) {
          await (organizationId
            ? withTenantRlsContext(db, organizationId, (transaction) => db.sequelize.query(reclaimSql, { transaction, replacements: { cutoff } }))
            : withSystemRlsBypass(db, (transaction) => db.sequelize.query(reclaimSql, { transaction, replacements: { cutoff } })));
        } else {
          await db.sequelize.query(reclaimSql, { replacements: { cutoff } });
        }
      } catch {
        // Non-fatal stale lock reclaim
      }
    }

    const sqlRows = await withClaimRlsScope(async (transaction) => {
      const orgClause = organizationId ? 'AND d."organizationId" = :organizationId' : '';
      const raw = await db.sequelize.query(
        `SELECT d.id
         FROM "latticeWebhookDeliveries" d
         INNER JOIN "latticeWebhookSubscriptions" s ON s.id = d."subscriptionId"
         WHERE d.status IN ('pending', 'retry_wait')
           AND (d."nextAttemptAt" IS NULL OR d."nextAttemptAt" <= :now)
           AND s.active = TRUE
           AND (
             s."circuitState" IS NULL
             OR s."circuitState" <> 'open'
             OR (s."circuitOpenUntil" IS NOT NULL AND s."circuitOpenUntil" <= :now)
           )
           ${orgClause}
         ORDER BY d."nextAttemptAt" ASC NULLS FIRST, d.id ASC
         LIMIT :batchSize
         FOR UPDATE OF d SKIP LOCKED`,
        {
          transaction,
          replacements: {
            now: nowDate,
            batchSize: size,
            ...(organizationId ? { organizationId } : {}),
          },
        },
      );
      const idRows = Array.isArray(raw?.[0]) ? raw[0] : (Array.isArray(raw) ? raw : []);
      if (!idRows.length) return [];

      const claimed = [];
      for (const ref of idRows) {
        const id = Number(ref?.id);
        if (!Number.isInteger(id) || id <= 0) continue;
        const row = delModel && typeof delModel.findByPk === 'function'
          ? await delModel.findByPk(id, { transaction })
          : await delRepo.findOne({ filter: { id }, transaction });
        if (!row) continue;
        await updateRowCompat(
          delRepo,
          row,
          { id },
          { status: 'processing', lockedAt: nowDate, lockedBy: workerId },
          transaction,
        );
        claimed.push(row);
      }
      return claimed;
    });

    if (sqlRows.length > 0 || delModel) {
      return sqlRows;
    }
  }

  if (typeof delRepo.find !== 'function') return [];
  const candidates = (await delRepo.find({
    filter: {
      status: { $in: ['pending', 'retry_wait'] },
      ...(organizationId ? { organizationId } : {}),
    },
    sort: ['nextAttemptAt', 'id'],
    limit: Math.max(size * 4, 50),
  })) || [];

  const due = [];
  for (const row of candidates) {
    if (due.length >= size) break;
    const status = val(row, 'status');
    if (status !== 'pending' && status !== 'retry_wait') continue;
    if (organizationId && val(row, 'organizationId') !== organizationId) continue;
    const nextAtRaw = val(row, 'nextAttemptAt');
    if (nextAtRaw) {
      const nextAtMs = new Date(nextAtRaw).getTime();
      if (Number.isFinite(nextAtMs) && nextAtMs > nowDate.getTime()) continue;
    }
    due.push(row);
  }
  return due;
}

async function dispatchOneDelivery(
  db,
  delivery,
  {
    subRepo,
    delRepo,
    safeNowMs = Date.now(),
    nowDate = new Date(safeNowMs),
    fetchImpl = globalThis.fetch,
    env = process.env,
    allowInternal,
    lookupImpl,
    enforceDnsInMock = false,
    randomFn = Math.random,
  } = {},
) {
  const effectiveSubRepo = subRepo || getRepo(db, 'latticeWebhookSubscriptions');
  const effectiveDelRepo = delRepo || getRepo(db, 'latticeWebhookDeliveries');
  const delId = val(delivery, 'id');
  const delOrg = val(delivery, 'organizationId');
  const eventId = val(delivery, 'eventId');
  const subId = Number(val(delivery, 'subscriptionId'));
  const externalActiveTx = hasMatchingActiveRlsTx(db) ? getActiveRlsContext()?.transaction || null : null;
  const runScopedDb = (fn) => (!externalActiveTx && canUsePgRlsSession(db) && delOrg
    ? withTenantRlsContext(db, delOrg, fn)
    : fn(externalActiveTx || undefined));

  const prep = await runScopedDb(async (transaction) => {
    const txOpt = transaction ? { transaction } : {};
    const sub = effectiveSubRepo && typeof effectiveSubRepo.findOne === 'function'
      ? await effectiveSubRepo.findOne({ filter: { id: subId, organizationId: delOrg }, ...txOpt })
      : null;

    if (!sub || val(sub, 'organizationId') !== delOrg || val(sub, 'active') === false) {
      await updateRowCompat(effectiveDelRepo, delivery, { id: delId, organizationId: delOrg }, {
        status: 'dlq',
        lastError: 'Webhook subscription missing or inactive',
        lockedAt: null,
        lockedBy: null,
        nextAttemptAt: null,
      }, transaction);
      return {
        syncAfterTx: true,
        earlyResult: { outcome: 'dlq', processed: true, result: { id: delId, eventId, status: 'dlq', reason: 'SUBSCRIPTION_INACTIVE' } },
      };
    }

    const circuitState = val(sub, 'circuitState') || 'closed';
    const openUntilRaw = val(sub, 'circuitOpenUntil');
    const openUntilMs = openUntilRaw ? new Date(openUntilRaw).getTime() : 0;

    if (circuitState === 'open') {
      if (Number.isFinite(openUntilMs) && openUntilMs > safeNowMs) {
        await updateRowCompat(effectiveDelRepo, delivery, { id: delId, organizationId: delOrg }, {
          status: Number(val(delivery, 'attempt')) > 0 ? 'retry_wait' : 'pending',
          nextAttemptAt: new Date(openUntilMs),
          lockedAt: null,
          lockedBy: null,
        }, transaction);
        return {
          earlyResult: {
            outcome: 'skipped_circuit',
            processed: false,
            result: { id: delId, eventId, status: 'skipped_circuit', circuitOpenUntil: new Date(openUntilMs).toISOString() },
          },
        };
      }
      await updateRowCompat(effectiveSubRepo, sub, { id: subId, organizationId: delOrg }, {
        circuitState: 'half_open',
      }, transaction);
    }

    let extraHeaders = {};
    const connectorId = val(sub, 'connectorId');
    if (connectorId != null) {
      try {
        const resolveSecrets = (spTx) => resolveConnectorSecrets(db, delOrg, connectorId, {
          env,
          ...(spTx ? { transaction: spTx } : (transaction ? { transaction } : {})),
        });
        const resolved = transaction && hasMatchingActiveRlsTx(db) && getActiveRlsContext()?.transaction === transaction
          ? await runInRlsSavepoint(db, resolveSecrets)
          : await resolveSecrets(transaction);
        extraHeaders = buildConnectorAuthHeaders(resolved.connector.authType, resolved.secrets);
      } catch {
        // Proceed without connector override if connector was removed/inactive
      }
    }

    return { sub, circuitState, openUntilMs, extraHeaders };
  });

  if (prep.earlyResult) {
    if (prep.syncAfterTx) {
      await syncParentEventStatus(db, delOrg, eventId, externalActiveTx ? { transaction: externalActiveTx } : undefined);
    }
    return prep.earlyResult;
  }

  const { sub, circuitState, openUntilMs, extraHeaders } = prep;
  const wasHalfOpen = circuitState === 'half_open' || (circuitState === 'open' && (!Number.isFinite(openUntilMs) || safeNowMs >= openUntilMs));
  const currentAttempt = Number(val(delivery, 'attempt')) || 0;
  const maxAttempts = Math.max(1, Number(val(delivery, 'maxAttempts')) || DEFAULT_MAX_ATTEMPTS);
  const nextAttempt = currentAttempt + 1;

  let httpStatus = null;
  let errorMessage = null;
  let ok = false;

  try {
    const isMockTransport = fetchImpl !== globalThis.fetch;
    const skipDnsCheck = isMockTransport && typeof lookupImpl !== 'function' && !enforceDnsInMock;
    const targetUrl = await assertSafeConnectorUrlAsync(val(sub, 'targetUrl'), {
      connectorType: 'webhook',
      env,
      allowInternal,
      lookupImpl,
      skipDnsCheck,
    });
    if (typeof fetchImpl !== 'function') {
      throw new Error('HTTP fetch implementation unavailable');
    }
    const rawBody = JSON.stringify(val(delivery, 'payloadSnapshotJson') || {});
    const webhookId = `msg_${eventId}_${delId ?? nextAttempt}`;
    const timestampSec = String(Math.floor(safeNowMs / 1000));

    const headers = {
      ...extraHeaders,
      'Content-Type': 'application/json',
      'webhook-id': webhookId,
      'webhook-timestamp': timestampSec,
      'ce-id': String(eventId),
      'ce-type': String(val(delivery, 'eventType') || ''),
      'ce-specversion': '1.0',
    };

    const encSecret = val(sub, 'encryptedSigningSecret');
    if (encSecret && String(encSecret).trim()) {
      const signingSecret = decryptSecretText(encSecret, env);
      headers['webhook-signature'] = signStandardWebhookPayload({
        webhookId,
        timestamp: timestampSec,
        body: rawBody,
        secret: signingSecret,
      });
    }

    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(WEBHOOK_TIMEOUT_MS)
      : undefined;
    const response = await fetchImpl(targetUrl, {
      method: 'POST',
      redirect: 'error',
      headers,
      body: rawBody,
      ...(signal ? { signal } : {}),
    });
    try { await response?.body?.cancel?.(); } catch {}

    httpStatus = Number(response?.status) || null;
    if (httpStatus != null && httpStatus >= 200 && httpStatus < 300) {
      ok = true;
    } else {
      errorMessage = `Webhook endpoint returned HTTP ${httpStatus || 'unknown'}`;
    }
  } catch (err) {
    errorMessage = String(err?.message || 'Webhook delivery failed').slice(0, 1000);
  }

  const stepOutcome = await runScopedDb(async (transaction) => {
    if (ok) {
      await updateRowCompat(effectiveDelRepo, delivery, { id: delId, organizationId: delOrg }, {
        attempt: nextAttempt,
        status: 'delivered',
        httpStatus,
        lastError: null,
        lockedAt: null,
        lockedBy: null,
        nextAttemptAt: null,
        deliveredAt: nowDate,
      }, transaction);
      await updateRowCompat(effectiveSubRepo, sub, { id: subId, organizationId: delOrg }, {
        failureCount: 0,
        circuitState: 'closed',
        circuitOpenUntil: null,
        lastError: null,
      }, transaction);
      return {
        outcome: 'delivered',
        processed: true,
        result: { id: delId, eventId, status: 'delivered', httpStatus, attempt: nextAttempt },
      };
    }

    const isDlq = nextAttempt >= maxAttempts;
    const nextStatus = isDlq ? 'dlq' : 'retry_wait';
    const backoffMs = isDlq ? 0 : computeWebhookBackoffMs(nextAttempt, { randomFn });
    const nextAttemptAt = isDlq ? null : new Date(safeNowMs + backoffMs);

    await updateRowCompat(effectiveDelRepo, delivery, { id: delId, organizationId: delOrg }, {
      attempt: nextAttempt,
      status: nextStatus,
      httpStatus,
      lastError: errorMessage,
      lockedAt: null,
      lockedBy: null,
      nextAttemptAt,
    }, transaction);

    const nextFailures = (Number(val(sub, 'failureCount')) || 0) + 1;
    const shouldOpen = wasHalfOpen || nextFailures >= CIRCUIT_FAILURE_THRESHOLD;
    const nextCircuitState = shouldOpen ? 'open' : 'closed';
    const nextOpenUntil = shouldOpen ? new Date(safeNowMs + CIRCUIT_COOLDOWN_MS) : null;
    await updateRowCompat(effectiveSubRepo, sub, { id: subId, organizationId: delOrg }, {
      failureCount: nextFailures,
      circuitState: nextCircuitState,
      circuitOpenUntil: nextOpenUntil,
      lastError: errorMessage,
    }, transaction);

    return {
      outcome: nextStatus,
      processed: true,
      result: {
        id: delId,
        eventId,
        status: nextStatus,
        httpStatus,
        attempt: nextAttempt,
        circuitState: nextCircuitState,
        nextAttemptAt: nextAttemptAt ? nextAttemptAt.toISOString() : null,
      },
    };
  });

  await syncParentEventStatus(db, delOrg, eventId, externalActiveTx ? { transaction: externalActiveTx } : undefined);
  return stepOutcome;
}

async function dispatchDueWebhookDeliveries(
  db,
  {
    organizationId = null,
    batchSize = 20,
    now = new Date(),
    fetchImpl = globalThis.fetch,
    env = process.env,
    allowInternal,
    lookupImpl,
    enforceDnsInMock = false,
    workerId = 'dxos-event-bus',
    staleLockMs = 120_000,
    randomFn = Math.random,
  } = {},
) {
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const safeNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const nowDate = new Date(safeNowMs);

  const delRepo = getRepo(db, 'latticeWebhookDeliveries');
  const subRepo = getRepo(db, 'latticeWebhookSubscriptions');
  if (!delRepo || !subRepo) {
    return {
      processedCount: 0,
      deliveredCount: 0,
      retryWaitCount: 0,
      dlqCount: 0,
      skippedCircuitCount: 0,
      results: [],
    };
  }

  const claimed = await claimDueDeliveries(db, {
    organizationId,
    batchSize,
    nowDate,
    workerId,
    staleLockMs,
  });

  let processedCount = 0;
  let deliveredCount = 0;
  let retryWaitCount = 0;
  let dlqCount = 0;
  let skippedCircuitCount = 0;
  const results = [];

  for (const delivery of claimed) {
    const step = await dispatchOneDelivery(db, delivery, {
      subRepo,
      delRepo,
      safeNowMs,
      nowDate,
      fetchImpl,
      env,
      allowInternal,
      lookupImpl,
      enforceDnsInMock,
      randomFn,
    });
    if (step.processed) processedCount += 1;
    if (step.outcome === 'delivered') deliveredCount += 1;
    else if (step.outcome === 'retry_wait') retryWaitCount += 1;
    else if (step.outcome === 'dlq') dlqCount += 1;
    else if (step.outcome === 'skipped_circuit') skippedCircuitCount += 1;
    results.push(step.result);
  }

  return {
    processedCount,
    deliveredCount,
    retryWaitCount,
    dlqCount,
    skippedCircuitCount,
    results,
  };
}

async function resolveVerifiedRoles(db, ctx) {
  const claimed = callerRoles(ctx);
  const userId = val(ctx?.state?.currentUser, 'id');
  const ruRepo = getRepo(db, 'rolesUsers');
  if (ruRepo && typeof ruRepo.find === 'function' && userId != null && /^[1-9]\d*$/.test(String(userId))) {
    const bindings = (await ruRepo.find({ filter: { userId: Number(userId) } })) || [];
    const assigned = new Set(
      bindings
        .filter((r) => val(r, 'userId') == null || Number(val(r, 'userId')) === Number(userId))
        .map((r) => String(val(r, 'roleName') || '').trim())
        .filter(Boolean),
    );
    if (claimed.length > 0) {
      return claimed.filter((r) => assigned.has(r));
    }
    return [...assigned];
  }
  return claimed;
}

async function isVerifiedEventAdmin(db, verifiedRoles) {
  if (!Array.isArray(verifiedRoles) || verifiedRoles.length === 0) return false;
  if (verifiedRoles.some((r) => ELEVATED_ROLES.has(String(r).toLowerCase()))) return true;
  const rolesRepo = getRepo(db, 'roles');
  if (!rolesRepo || typeof rolesRepo.find !== 'function') return false;
  const matched = (await rolesRepo.find({ filter: { name: { $in: verifiedRoles } } })) || [];
  return matched.some((role) => {
    const name = val(role, 'name');
    if (name && !verifiedRoles.includes(name)) return false;
    if (val(role, 'allowAll') === true || val(role, 'allowConfigure') === true) return true;
    const snippets = val(role, 'snippets');
    return Array.isArray(snippets) && (snippets.includes('pm') || snippets.includes('pm.*'));
  });
}

async function resolveEventsCaller(db, ctx, requestedOrgId = null, { requireOrg = true } = {}) {
  if (!ctx?.state?.currentUser) {
    throw failEvent('NATIVE_LOGIN_REQUIRED', 401, 'Authentication required.');
  }
  const verifiedRoles = await resolveVerifiedRoles(db, ctx);
  const isRoot = verifiedRoles.includes('root');
  const isAdmin = isRoot || (await isVerifiedEventAdmin(db, verifiedRoles));

  if (isRoot) {
    const cleanReq = requestedOrgId != null ? String(requestedOrgId).trim() : '';
    if (cleanReq) {
      if (!ORG_ID_RE.test(cleanReq)) {
        throw failEvent('EVENT_ORG_INVALID', 400, 'Invalid organizationId.');
      }
      return { isRoot: true, isAdmin: true, verifiedRoles, organizationId: cleanReq };
    }
    try {
      const actor = await resolveNativeActor(db, ctx.state.currentUser);
      return { isRoot: true, isAdmin: true, verifiedRoles, organizationId: actor.organizationId };
    } catch {
      if (requireOrg) {
        throw failEvent('EVENT_ORG_REQUIRED', 400, 'organizationId is required for root event bus operations.');
      }
      return { isRoot: true, isAdmin: true, verifiedRoles, organizationId: null };
    }
  }

  const actor = await resolveNativeActor(db, ctx.state.currentUser);
  if (
    requestedOrgId !== undefined
    && requestedOrgId !== null
    && String(requestedOrgId).trim() !== ''
    && String(requestedOrgId).trim() !== actor.organizationId
  ) {
    throw failEvent('NATIVE_ORGANIZATION_MISMATCH', 403, 'Cross-organization event bus access is forbidden.');
  }

  return {
    isRoot: false,
    isAdmin,
    verifiedRoles,
    organizationId: actor.organizationId,
  };
}

async function findSubscriptionInOrg(repo, organizationId, params, { transaction = null } = {}) {
  const txOpt = transaction ? { transaction } : {};
  const id = Number(params.id ?? params.subscriptionId ?? params.filterByTk);
  const subKey = typeof params.subscriptionKey === 'string' ? params.subscriptionKey.trim().toLowerCase() : '';
  if (Number.isInteger(id) && id > 0) {
    const row = await repo.findOne({ filter: { id, organizationId }, ...txOpt });
    return row && val(row, 'organizationId') === organizationId ? row : null;
  }
  if (subKey) {
    const row = await repo.findOne({ filter: { organizationId, subscriptionKey: subKey }, ...txOpt });
    return row && val(row, 'organizationId') === organizationId ? row : null;
  }
  return null;
}

function registerEventBusDirectGuard(app) {
  app.resourceManager?.use?.(async (ctx, next) => {
    if (ctx.state?.currentRole === 'root') return next();
    const fullResource = String(ctx.action?.resourceName || '');
    const baseResource = fullResource.split('.')[0];
    const actionName = String(ctx.action?.actionName || '');
    if (EVENT_BUS_PROTECTED_RESOURCES.has(baseResource)) {
      throw failEvent('EVENTS_DIRECT_CRUD_FORBIDDEN', 403, 'Direct access to event bus or webhook tables is forbidden; use dxosEvents.');
    }
    if (
      fullResource === 'charts'
      && actionName === 'queryData'
      && EVENT_BUS_PROTECTED_RESOURCES.has(String(ctx.action?.params?.values?.collection || ''))
    ) {
      throw failEvent('EVENTS_DIRECT_CRUD_FORBIDDEN', 403, 'Direct chart access to event bus or webhook tables is forbidden.');
    }
    return next();
  }, { tag: 'latticeEventBusDirectGuard', after: 'acl' });
}

function registerEventBus(app, { env = process.env, fetchImpl = globalThis.fetch, lookupImpl, enforceDnsInMock = false, startDrainer = true } = {}) {
  const db = app.db;
  registerEventBusDirectGuard(app);

  app.resourceManager.define({
    name: 'dxosEvents',
    actions: {
      listEvents: async (ctx, next) => {
        if ((ctx.method || 'GET') !== 'GET') ctx.throw(405);
        assertApiKeyScope(ctx, ['read', 'write']);
        const params = readParams(ctx);
        const scope = await resolveEventsCaller(db, ctx, params.organizationId, { requireOrg: false });
        if (!scope.isAdmin) {
          throw failEvent('EVENTS_ADMIN_REQUIRED', 403, 'Administrator role is required to list domain events.');
        }
        const repo = getRepo(db, 'latticeEventBus');
        const page = Math.max(1, Math.min(10000, Math.floor(Number(params.page) || 1)));
        const pageSize = Math.max(1, Math.min(200, Math.floor(Number(params.pageSize ?? params.limit) || 20)));
        if (!repo || typeof repo.find !== 'function') {
          ctx.body = { organizationId: scope.organizationId, total: 0, page, pageSize, items: [] };
          if (next) return next();
          return;
        }
        const filter = {};
        if (scope.organizationId) filter.organizationId = scope.organizationId;
        if (typeof params.eventType === 'string' && params.eventType.trim()) {
          filter.eventType = params.eventType.trim();
        }
        if (typeof params.status === 'string' && params.status.trim()) {
          filter.status = params.status.trim();
        }
        if (typeof params.correlationId === 'string' && params.correlationId.trim()) {
          filter.correlationId = params.correlationId.trim();
        }
        const { rows, total } = await runEventsScopedDb(db, scope.organizationId, async (transaction) => {
          const txOpt = transaction ? { transaction } : {};
          const foundRows = (await repo.find({
            filter,
            sort: ['-occurredAt', '-id'],
            offset: (page - 1) * pageSize,
            limit: pageSize,
            ...txOpt,
          })) || [];
          const foundTotal = typeof repo.count === 'function' ? await repo.count({ filter, ...txOpt }) : foundRows.length;
          return { rows: foundRows, total: foundTotal };
        });
        ctx.body = {
          organizationId: scope.organizationId,
          total,
          page,
          pageSize,
          items: rows
            .filter((r) => !scope.organizationId || val(r, 'organizationId') === scope.organizationId)
            .map(serializeEventRow),
        };
        if (next) return next();
      },

      publish: async (ctx, next) => {
        if ((ctx.method || 'POST') !== 'POST') ctx.throw(405);
        assertApiKeyScope(ctx, ['write']);
        const params = readParams(ctx);
        const scope = await resolveEventsCaller(db, ctx, params.organizationId, { requireOrg: true });
        if (!scope.isAdmin) {
          throw failEvent('EVENTS_ADMIN_REQUIRED', 403, 'Administrator role is required to publish domain events.');
        }
        const rawDepth = Number(params.depth ?? 0);
        if (!Number.isInteger(rawDepth) || rawDepth < 0 || rawDepth > 8) {
          throw failEvent('EVENT_DEPTH_INVALID', 400, 'depth must be an integer between 0 and 8.');
        }
        const res = await publishDomainEvent(db, {
          organizationId: scope.organizationId,
          type: params.type ?? params.eventType,
          source: params.source || 'latticedx/api',
          subject: params.subject ?? null,
          data: params.data ?? params.payload ?? {},
          correlationId: params.correlationId ?? null,
          causationId: params.causationId ?? null,
          depth: rawDepth,
          app,
        });
        ctx.body = res;
        if (next) return next();
      },

      listSubscriptions: async (ctx, next) => {
        if ((ctx.method || 'GET') !== 'GET') ctx.throw(405);
        assertApiKeyScope(ctx, ['read', 'write']);
        const params = readParams(ctx);
        const scope = await resolveEventsCaller(db, ctx, params.organizationId, { requireOrg: false });
        if (!scope.isAdmin) {
          throw failEvent('EVENTS_ADMIN_REQUIRED', 403, 'Administrator role is required to list webhook subscriptions.');
        }
        const repo = getRepo(db, 'latticeWebhookSubscriptions');
        if (!repo || typeof repo.find !== 'function') {
          ctx.body = { organizationId: scope.organizationId, items: [] };
          if (next) return next();
          return;
        }
        const filter = {};
        if (scope.organizationId) filter.organizationId = scope.organizationId;
        if (params.active !== undefined) {
          filter.active = params.active === true || params.active === 'true';
        }
        const limit = Math.max(1, Math.min(200, Math.floor(Number(params.limit) || 100)));
        const rows = (await runEventsScopedDb(db, scope.organizationId, (transaction) => repo.find({
          filter,
          sort: ['id'],
          limit,
          ...(transaction ? { transaction } : {}),
        }))) || [];
        ctx.body = {
          organizationId: scope.organizationId,
          items: rows
            .filter((r) => !scope.organizationId || val(r, 'organizationId') === scope.organizationId)
            .map(serializeSubscription),
        };
        if (next) return next();
      },

      saveSubscription: async (ctx, next) => {
        if ((ctx.method || 'POST') !== 'POST') ctx.throw(405);
        assertApiKeyScope(ctx, ['write']);
        const params = readParams(ctx);
        const scope = await resolveEventsCaller(db, ctx, params.organizationId, { requireOrg: true });
        if (!scope.isAdmin) {
          throw failEvent('EVENTS_ADMIN_REQUIRED', 403, 'Administrator role is required to manage webhook subscriptions.');
        }
        const repo = getRepo(db, 'latticeWebhookSubscriptions');
        if (!repo || typeof repo.create !== 'function') {
          throw failEvent('EVENTS_REPO_UNAVAILABLE', 503, 'latticeWebhookSubscriptions repository is unavailable.');
        }

        const subscriptionKey = typeof params.subscriptionKey === 'string'
          ? params.subscriptionKey.trim().toLowerCase()
          : '';
        if (!SUB_KEY_RE.test(subscriptionKey)) {
          throw failEvent('SUBSCRIPTION_KEY_INVALID', 400, 'subscriptionKey must be a valid lowercase slug (2..64 chars).');
        }
        const name = typeof params.name === 'string' ? params.name.trim() : '';
        if (!name || name.length > 120) {
          throw failEvent('SUBSCRIPTION_NAME_REQUIRED', 400, 'Subscription name is required (1..120 chars).');
        }
        const allowInternal = resolveAllowInternalConnectorHosts({ isRoot: scope.isRoot, env });
        const targetUrl = assertSafeConnectorUrl(params.targetUrl, { connectorType: 'webhook', env, allowInternal });
        const eventPattern = typeof params.eventPattern === 'string' && params.eventPattern.trim()
          ? params.eventPattern.trim().slice(0, 255)
          : '*';

        let connectorId = null;
        if (params.connectorId !== undefined && params.connectorId !== null && String(params.connectorId).trim() !== '') {
          const parsedConnId = Number(params.connectorId);
          if (!Number.isInteger(parsedConnId) || parsedConnId <= 0) {
            throw failEvent('CONNECTOR_ID_INVALID', 400, 'connectorId must be a positive integer.');
          }
          connectorId = parsedConnId;
        }

        const saved = await runEventsScopedDb(db, scope.organizationId, async (transaction) => {
          const txOpt = transaction ? { transaction } : {};
          if (connectorId != null) {
            const connRepo = getRepo(db, 'latticeConnectors');
            if (connRepo && typeof connRepo.findOne === 'function') {
              const connRow = await connRepo.findOne({ filter: { id: connectorId, organizationId: scope.organizationId }, ...txOpt });
              if (!connRow || val(connRow, 'organizationId') !== scope.organizationId) {
                throw failEvent('CONNECTOR_NOT_FOUND', 404, 'Referenced connector not found in organization scope.');
              }
            }
          }

          const existing = await findSubscriptionInOrg(repo, scope.organizationId, {
            id: params.id ?? params.filterByTk,
            subscriptionKey,
          }, { transaction });

          let encryptedSigningSecret = existing ? val(existing, 'encryptedSigningSecret') || null : null;
          if (params.signingSecret !== undefined) {
            const rawSecret = typeof params.signingSecret === 'string' ? params.signingSecret.trim() : '';
            encryptedSigningSecret = rawSecret ? encryptSecretText(rawSecret, env) : null;
          }

          const values = {
            organizationId: scope.organizationId,
            subscriptionKey,
            name,
            targetUrl,
            eventPattern,
            encryptedSigningSecret,
            connectorId,
            active: params.active === undefined ? (existing ? val(existing, 'active') !== false : true) : Boolean(params.active),
            ...(existing ? {} : { failureCount: 0, circuitState: 'closed', circuitOpenUntil: null, lastError: null }),
          };

          if (existing) {
            return updateRowCompat(repo, existing, { id: val(existing, 'id'), organizationId: scope.organizationId }, values, transaction);
          }
          return repo.create({ values, ...txOpt });
        });

        ctx.body = serializeSubscription(saved);
        if (next) return next();
      },

      toggleSubscription: async (ctx, next) => {
        if ((ctx.method || 'POST') !== 'POST') ctx.throw(405);
        assertApiKeyScope(ctx, ['write']);
        const params = readParams(ctx);
        const scope = await resolveEventsCaller(db, ctx, params.organizationId, { requireOrg: true });
        if (!scope.isAdmin) {
          throw failEvent('EVENTS_ADMIN_REQUIRED', 403, 'Administrator role is required to toggle webhook subscriptions.');
        }
        const repo = getRepo(db, 'latticeWebhookSubscriptions');
        if (!repo) throw failEvent('EVENTS_REPO_UNAVAILABLE', 503, 'latticeWebhookSubscriptions repository is unavailable.');
        const updated = await runEventsScopedDb(db, scope.organizationId, async (transaction) => {
          const row = await findSubscriptionInOrg(repo, scope.organizationId, params, { transaction });
          if (!row) throw failEvent('SUBSCRIPTION_NOT_FOUND', 404, 'Webhook subscription not found.');

          const nextActive = params.active === undefined ? !(val(row, 'active') !== false) : Boolean(params.active);
          return updateRowCompat(
            repo,
            row,
            { id: val(row, 'id'), organizationId: scope.organizationId },
            { active: nextActive },
            transaction,
          );
        });
        ctx.body = serializeSubscription(updated);
        if (next) return next();
      },

      deleteSubscription: async (ctx, next) => {
        if (ctx.method && !['POST', 'DELETE'].includes(ctx.method)) ctx.throw(405);
        assertApiKeyScope(ctx, ['write']);
        const params = readParams(ctx);
        const scope = await resolveEventsCaller(db, ctx, params.organizationId, { requireOrg: true });
        if (!scope.isAdmin) {
          throw failEvent('EVENTS_ADMIN_REQUIRED', 403, 'Administrator role is required to delete webhook subscriptions.');
        }
        const repo = getRepo(db, 'latticeWebhookSubscriptions');
        if (!repo) throw failEvent('EVENTS_REPO_UNAVAILABLE', 503, 'latticeWebhookSubscriptions repository is unavailable.');
        const deletedRes = await runEventsScopedDb(db, scope.organizationId, async (transaction) => {
          const txOpt = transaction ? { transaction } : {};
          const row = await findSubscriptionInOrg(repo, scope.organizationId, params, { transaction });
          if (!row) throw failEvent('SUBSCRIPTION_NOT_FOUND', 404, 'Webhook subscription not found.');

          const id = val(row, 'id');
          const subscriptionKey = val(row, 'subscriptionKey');
          if (typeof repo.destroy === 'function') {
            await repo.destroy({ filter: { id, organizationId: scope.organizationId }, ...txOpt });
          } else if (typeof row.destroy === 'function') {
            await row.destroy(transaction ? { transaction } : undefined);
          }
          return { deleted: true, id, subscriptionKey };
        });
        ctx.body = deletedRes;
        if (next) return next();
      },

      listDeliveries: async (ctx, next) => {
        if ((ctx.method || 'GET') !== 'GET') ctx.throw(405);
        assertApiKeyScope(ctx, ['read', 'write']);
        const params = readParams(ctx);
        const scope = await resolveEventsCaller(db, ctx, params.organizationId, { requireOrg: false });
        if (!scope.isAdmin) {
          throw failEvent('EVENTS_ADMIN_REQUIRED', 403, 'Administrator role is required to list webhook deliveries.');
        }
        const repo = getRepo(db, 'latticeWebhookDeliveries');
        const page = Math.max(1, Math.min(10000, Math.floor(Number(params.page) || 1)));
        const pageSize = Math.max(1, Math.min(200, Math.floor(Number(params.pageSize ?? params.limit) || 20)));
        if (!repo || typeof repo.find !== 'function') {
          ctx.body = { organizationId: scope.organizationId, total: 0, page, pageSize, items: [] };
          if (next) return next();
          return;
        }
        const filter = {};
        if (scope.organizationId) filter.organizationId = scope.organizationId;
        if (typeof params.status === 'string' && params.status.trim()) filter.status = params.status.trim();
        if (typeof params.eventId === 'string' && params.eventId.trim()) filter.eventId = params.eventId.trim();
        if (params.subscriptionId != null && /^[1-9]\d*$/.test(String(params.subscriptionId))) {
          filter.subscriptionId = Number(params.subscriptionId);
        }
        const { rows, total } = await runEventsScopedDb(db, scope.organizationId, async (transaction) => {
          const txOpt = transaction ? { transaction } : {};
          const foundRows = (await repo.find({
            filter,
            sort: ['-id'],
            offset: (page - 1) * pageSize,
            limit: pageSize,
            ...txOpt,
          })) || [];
          const foundTotal = typeof repo.count === 'function' ? await repo.count({ filter, ...txOpt }) : foundRows.length;
          return { rows: foundRows, total: foundTotal };
        });
        ctx.body = {
          organizationId: scope.organizationId,
          total,
          page,
          pageSize,
          items: rows
            .filter((r) => !scope.organizationId || val(r, 'organizationId') === scope.organizationId)
            .map(serializeDelivery),
        };
        if (next) return next();
      },

      dispatchNow: async (ctx, next) => {
        if ((ctx.method || 'POST') !== 'POST') ctx.throw(405);
        assertApiKeyScope(ctx, ['write']);
        const params = readParams(ctx);
        const scope = await resolveEventsCaller(db, ctx, params.organizationId, { requireOrg: true });
        if (!scope.isAdmin) {
          throw failEvent('EVENTS_ADMIN_REQUIRED', 403, 'Administrator role is required to dispatch webhook deliveries.');
        }
        const allowInternal = resolveAllowInternalConnectorHosts({ isRoot: scope.isRoot, env });
        ctx.body = await dispatchDueWebhookDeliveries(db, {
          organizationId: scope.organizationId,
          batchSize: Math.max(1, Math.min(100, Number(params.batchSize) || 20)),
          fetchImpl,
          env,
          allowInternal,
          lookupImpl,
          enforceDnsInMock,
        });
        if (next) return next();
      },

      replayDlq: async (ctx, next) => {
        if ((ctx.method || 'POST') !== 'POST') ctx.throw(405);
        assertApiKeyScope(ctx, ['write']);
        const params = readParams(ctx);
        const scope = await resolveEventsCaller(db, ctx, params.organizationId, { requireOrg: true });
        if (!scope.isAdmin) {
          throw failEvent('EVENTS_ADMIN_REQUIRED', 403, 'Administrator role is required to replay DLQ deliveries.');
        }
        const delRepo = getRepo(db, 'latticeWebhookDeliveries');
        if (!delRepo || typeof delRepo.find !== 'function') {
          ctx.body = { organizationId: scope.organizationId, replayedCount: 0, deliveryIds: [] };
          if (next) return next();
          return;
        }
        const filter = { organizationId: scope.organizationId, status: 'dlq' };
        if (params.subscriptionId != null && /^[1-9]\d*$/.test(String(params.subscriptionId))) {
          filter.subscriptionId = Number(params.subscriptionId);
        }
        if (typeof params.eventId === 'string' && params.eventId.trim()) {
          filter.eventId = params.eventId.trim();
        }
        const limit = Math.max(1, Math.min(200, Math.floor(Number(params.limit) || 50)));
        const { replayedIds, eventIds } = await runEventsScopedDb(db, scope.organizationId, async (transaction) => {
          const txOpt = transaction ? { transaction } : {};
          let rows = (await delRepo.find({ filter, sort: ['id'], limit, ...txOpt })) || [];
          if (Array.isArray(params.deliveryIds) && params.deliveryIds.length > 0) {
            const wanted = new Set(params.deliveryIds.map((id) => Number(id)));
            rows = rows.filter((r) => wanted.has(Number(val(r, 'id'))));
          }

          const nowDate = new Date();
          const ids = [];
          const touchedEvents = new Set();
          for (const row of rows) {
            if (val(row, 'organizationId') !== scope.organizationId || val(row, 'status') !== 'dlq') continue;
            const id = val(row, 'id');
            await updateRowCompat(delRepo, row, { id, organizationId: scope.organizationId }, {
              status: 'pending',
              attempt: 0,
              nextAttemptAt: nowDate,
              lockedAt: null,
              lockedBy: null,
              lastError: null,
            }, transaction);
            const evId = val(row, 'eventId');
            if (evId) touchedEvents.add(evId);
            if (id != null) ids.push(Number(id));
          }
          return { replayedIds: ids, eventIds: [...touchedEvents] };
        });
        for (const evId of eventIds) {
          await syncParentEventStatus(db, scope.organizationId, evId);
        }
        ctx.body = {
          organizationId: scope.organizationId,
          replayedCount: replayedIds.length,
          deliveryIds: replayedIds,
        };
        if (next) return next();
      },

      resetCircuit: async (ctx, next) => {
        if ((ctx.method || 'POST') !== 'POST') ctx.throw(405);
        assertApiKeyScope(ctx, ['write']);
        const params = readParams(ctx);
        const scope = await resolveEventsCaller(db, ctx, params.organizationId, { requireOrg: true });
        if (!scope.isAdmin) {
          throw failEvent('EVENTS_ADMIN_REQUIRED', 403, 'Administrator role is required to reset circuit breaker.');
        }
        const subRepo = getRepo(db, 'latticeWebhookSubscriptions');
        if (!subRepo) throw failEvent('EVENTS_REPO_UNAVAILABLE', 503, 'latticeWebhookSubscriptions repository is unavailable.');
        const updated = await runEventsScopedDb(db, scope.organizationId, async (transaction) => {
          const row = await findSubscriptionInOrg(subRepo, scope.organizationId, params, { transaction });
          if (!row) throw failEvent('SUBSCRIPTION_NOT_FOUND', 404, 'Webhook subscription not found.');

          return updateRowCompat(
            subRepo,
            row,
            { id: val(row, 'id'), organizationId: scope.organizationId },
            {
              circuitState: 'closed',
              failureCount: 0,
              circuitOpenUntil: null,
              lastError: null,
            },
            transaction,
          );
        });
        ctx.body = serializeSubscription(updated);
        if (next) return next();
      },
    },
  });

  app.acl?.allow?.(
    'dxosEvents',
    [
      'listEvents',
      'publish',
      'listSubscriptions',
      'saveSubscription',
      'toggleSubscription',
      'deleteSubscription',
      'listDeliveries',
      'dispatchNow',
      'replayDlq',
      'resetCircuit',
    ],
    'loggedIn',
  );

  let inFlight = false;
  let timer = null;

  const stopDrainer = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (app._latticeEventBusTimer) {
      clearInterval(app._latticeEventBusTimer);
      app._latticeEventBusTimer = null;
    }
  };

  if (startDrainer && String(env?.DX_EVENT_BUS_DRAINER ?? 'true').trim().toLowerCase() !== 'false') {
    stopDrainer();
    timer = setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      dispatchDueWebhookDeliveries(db, { fetchImpl, env, lookupImpl, enforceDnsInMock })
        .catch(() => {
          // Non-fatal if migrations are still running during startup
        })
        .finally(() => {
          inFlight = false;
        });
    }, DRAINER_INTERVAL_MS);
    if (typeof timer.unref === 'function') timer.unref();
    app._latticeEventBusTimer = timer;
  }

  return {
    publishDomainEvent: function publishEventBound(event, maybeOpts, maybeThird) {
      if (event && typeof event.getRepository === 'function' && maybeOpts && typeof maybeOpts === 'object') {
        return publishDomainEvent(event, { app, ...(maybeThird || {}), ...maybeOpts });
      }
      return publishDomainEvent(db, { app, ...(maybeOpts || {}), ...(event || {}) });
    },
    registerEventBusListener,
    decodeSigningSecret,
    verifyStandardWebhookSignature,
    signStandardWebhookPayload,
    dispatchOneDelivery: (delivery, opts = {}) =>
      dispatchOneDelivery(db, delivery, { fetchImpl, env, lookupImpl, enforceDnsInMock, ...opts }),
    dispatchDueWebhookDeliveries: (opts = {}) =>
      dispatchDueWebhookDeliveries(db, { fetchImpl, env, lookupImpl, enforceDnsInMock, ...opts }),
    stopDrainer,
  };
}

module.exports = {
  CIRCUIT_FAILURE_THRESHOLD,
  CIRCUIT_COOLDOWN_MS,
  WEBHOOK_TIMEOUT_MS,
  DRAINER_INTERVAL_MS,
  decodeSigningSecret,
  signStandardWebhookPayload,
  verifyStandardWebhookSignature,
  registerEventBusListener,
  matchesEventPattern,
  computeWebhookBackoffMs,
  publishDomainEvent,
  syncParentEventStatus,
  claimDueDeliveries,
  dispatchOneDelivery,
  dispatchDueWebhookDeliveries,
  registerEventBus,
};
