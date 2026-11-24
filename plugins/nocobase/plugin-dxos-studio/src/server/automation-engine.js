/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const crypto = require('crypto');
const path = require('path');
const { evaluateDecisionTable } = require('./dmn-engine');
const { SYSTEM_PROTECTED_COLLECTIONS } = require('./solution-bundle');
const {
  assertPatScope,
  clampPageLimit,
  fail,
  isOrgAdmin,
  loadFoundationModule,
  loadFoundationSet,
  readParams,
  resolveTenantActor,
  resolveVerifiedRoles,
  sanitizeDirectFilter,
  toPlain,
  val,
} = require('./wms-dmn-shared');

const AUTOMATION_COLLECTIONS = Object.freeze(['latticeAutomationRules', 'latticeAutomationRuns']);
const RULE_KEY_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/;
const CUSTOM_COLLECTION_RE = /^latticeCustom[A-Z][A-Za-z0-9]{1,40}$/;
const MUTATING_ROLES = new Set(['ldx_admin', 'ldx_manager', 'root', 'admin']);
const VALID_ACTION_TYPES = new Set([
  'create_record',
  'update_record',
  'notify_role',
  'call_connector',
  'twin_set_desired',
  'trigger_ai_triage',
]);
const CORE_VOUCHER_COLLECTIONS = new Set([
  'latticeRequests',
  'latticeOrders',
  'latticeServiceTickets',
]);
const PROTECTED_VOUCHER_FIELDS = new Set([
  'id',
  'status',
  'version',
  'amendedFromId',
  'amendmentNo',
  'submittedAt',
  'submittedBy',
  'cancelledAt',
  'cancelledBy',
  'cancelReason',
]);
const ALLOWLISTED_BUSINESS_COLLECTIONS = new Set([
  'latticeRequests',
  'latticeOrders',
  'latticeOrderLines',
  'latticeServiceTickets',
  'latticeParaDocuments',
  'latticeIncidentCases',
  'latticeLocations',
  'latticeAssets',
  'latticeAgentProposals',
]);
const SENSITIVE_TARGET_COLLECTIONS = new Set([
  'latticePkiKeys',
  'latticeCryptoLedger',
  'latticeConnectors',
  'latticeWebhookSubscriptions',
  'latticeWebhookDeliveries',
  'latticeEventBus',
  'latticeApiKeys',
  'latticeDelegations',
  'latticeDecisionTables',
  'latticeEpodRecords',
  'latticeOrganizations',
]);
const BLOCKED_PATH_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_HARD_DEPTH = 8;
const CONNECTOR_TIMEOUT_MS = 5000;

const recentRunEventSnapshots = new Map();
const MAX_SNAPSHOT_CACHE = 200;

function rememberRunSnapshot(runUid, eventEnvelope) {
  if (!runUid || !eventEnvelope) return;
  if (recentRunEventSnapshots.size >= MAX_SNAPSHOT_CACHE) {
    const oldestKey = recentRunEventSnapshots.keys().next().value;
    if (oldestKey) recentRunEventSnapshots.delete(oldestKey);
  }
  recentRunEventSnapshots.set(String(runUid), eventEnvelope);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sanitizePlainObject(value, seen = new WeakSet()) {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePlainObject(item, seen));
  }
  if (value instanceof Date) return new Date(value.getTime());
  const out = {};
  for (const key of Object.keys(value)) {
    if (BLOCKED_PATH_SEGMENTS.has(key)) continue;
    out[key] = sanitizePlainObject(value[key], seen);
  }
  return out;
}

function getSafePath(root, rawPath) {
  if (root === null || root === undefined) return undefined;
  const pathStr = String(rawPath || '').trim();
  if (!pathStr || !/^[a-zA-Z0-9_.\-$]+$/.test(pathStr)) return undefined;
  const segments = pathStr.split('.').filter(Boolean);
  if (!segments.length) return undefined;
  let current = root;
  for (const seg of segments) {
    if (BLOCKED_PATH_SEGMENTS.has(seg)) return undefined;
    if (current === null || current === undefined || (typeof current !== 'object' && typeof current !== 'function')) {
      return undefined;
    }
    if (Array.isArray(current)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) return undefined;
      current = current[idx];
    } else {
      if (!Object.prototype.hasOwnProperty.call(current, seg)) return undefined;
      current = current[seg];
    }
  }
  return current;
}

function hasUnsafeTemplateSyntax(value) {
  if (typeof value === 'string') {
    const matches = value.matchAll(/\{\{([\s\S]*?)\}\}/g);
    for (const match of matches) {
      const expr = String(match[1] || '').trim();
      if (!expr || !/^[a-zA-Z0-9_.\-$]+$/.test(expr)) return true;
      const parts = expr.split('.').filter(Boolean);
      if (!parts.length || parts.some((p) => BLOCKED_PATH_SEGMENTS.has(p))) return true;
    }
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => hasUnsafeTemplateSyntax(item));
  }
  if (isPlainObject(value)) {
    return Object.entries(value).some(([k, v]) => BLOCKED_PATH_SEGMENTS.has(k) || hasUnsafeTemplateSyntax(v));
  }
  return false;
}

function resolveTemplateExpr(expr, context) {
  const trimmed = String(expr || '').trim();
  if (!trimmed || !/^[a-zA-Z0-9_.\-$]+$/.test(trimmed)) return undefined;
  const segments = trimmed.split('.').filter(Boolean);
  if (!segments.length || segments.some((p) => BLOCKED_PATH_SEGMENTS.has(p))) return undefined;

  let resolved = getSafePath(context, trimmed);
  if (resolved === undefined && isPlainObject(context?.data)) {
    resolved = getSafePath(context.data, trimmed);
  }
  return resolved;
}

function interpolateTemplate(value, context) {
  if (typeof value === 'string') {
    const singleMatch = value.match(/^\{\{\s*([^{}]+?)\s*\}\}$/);
    if (singleMatch) {
      const resolved = resolveTemplateExpr(singleMatch[1], context);
      return resolved === undefined ? '' : resolved;
    }
    return value.replace(/\{\{([\s\S]*?)\}\}/g, (_full, expr) => {
      const resolved = resolveTemplateExpr(expr, context);
      if (resolved === undefined || resolved === null) return '';
      if (typeof resolved === 'object') return JSON.stringify(resolved);
      return String(resolved);
    });
  }
  if (Array.isArray(value)) {
    return value.map((item) => interpolateTemplate(item, context));
  }
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, entryVal] of Object.entries(value)) {
      if (BLOCKED_PATH_SEGMENTS.has(key)) continue;
      out[key] = interpolateTemplate(entryVal, context);
    }
    return out;
  }
  return value;
}

function lookupFilterValue(eventContext, key) {
  const pathStr = String(key || '').trim();
  if (!pathStr) return undefined;
  if (
    pathStr.startsWith('data.') ||
    pathStr.startsWith('dmn.') ||
    pathStr.startsWith('event.') ||
    pathStr.startsWith('envelope.')
  ) {
    return getSafePath(eventContext, pathStr);
  }
  const fromData = getSafePath(eventContext?.data, pathStr);
  if (fromData !== undefined) return fromData;
  return getSafePath(eventContext, pathStr);
}

function matchOperatorObject(actual, ops) {
  for (const [op, expected] of Object.entries(ops)) {
    if (BLOCKED_PATH_SEGMENTS.has(op)) return false;
    switch (op) {
      case '$eq':
      case 'eq':
        if (actual !== expected) return false;
        break;
      case '$ne':
      case 'ne':
        if (actual === expected) return false;
        break;
      case '$gt':
      case 'gt': {
        if (actual === null || actual === undefined || actual === '') return false;
        const a = Number(actual);
        const b = Number(expected);
        if (!Number.isFinite(a) || !Number.isFinite(b) || !(a > b)) return false;
        break;
      }
      case '$gte':
      case 'gte': {
        if (actual === null || actual === undefined || actual === '') return false;
        const a = Number(actual);
        const b = Number(expected);
        if (!Number.isFinite(a) || !Number.isFinite(b) || !(a >= b)) return false;
        break;
      }
      case '$lt':
      case 'lt': {
        if (actual === null || actual === undefined || actual === '') return false;
        const a = Number(actual);
        const b = Number(expected);
        if (!Number.isFinite(a) || !Number.isFinite(b) || !(a < b)) return false;
        break;
      }
      case '$lte':
      case 'lte': {
        if (actual === null || actual === undefined || actual === '') return false;
        const a = Number(actual);
        const b = Number(expected);
        if (!Number.isFinite(a) || !Number.isFinite(b) || !(a <= b)) return false;
        break;
      }
      case '$in':
      case 'in':
        if (!Array.isArray(expected) || !expected.includes(actual)) return false;
        break;
      case '$nin':
      case 'nin':
        if (!Array.isArray(expected) || expected.includes(actual)) return false;
        break;
      case '$exists':
      case 'exists': {
        const present = actual !== undefined && actual !== null;
        if (Boolean(expected) !== present) return false;
        break;
      }
      case '$contains':
      case 'contains':
        if (typeof actual === 'string') {
          if (!actual.includes(String(expected))) return false;
        } else if (Array.isArray(actual)) {
          if (!actual.includes(expected)) return false;
        } else {
          return false;
        }
        break;
      default:
        return false;
    }
  }
  return true;
}

function isOperatorObject(obj) {
  if (!isPlainObject(obj)) return false;
  const keys = Object.keys(obj);
  return keys.length > 0 && keys.every((k) => k.startsWith('$'));
}

function matchesFilter(filterJson, eventContext) {
  if (filterJson === null || filterJson === undefined) return true;
  if (Array.isArray(filterJson)) {
    return filterJson.every((clause) => matchesFilter(clause, eventContext));
  }
  if (!isPlainObject(filterJson)) return false;
  const entries = Object.entries(filterJson).filter(([k]) => !BLOCKED_PATH_SEGMENTS.has(k));
  if (entries.length === 0) return true;

  if (typeof filterJson.field === 'string') {
    const opsKeys = Object.keys(filterJson).filter((k) => k !== 'field');
    const isExplicitClause = opsKeys.some((k) =>
      ['op', 'value', '$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$exists', '$contains'].includes(k),
    );
    if (isExplicitClause) {
      const actual = lookupFilterValue(eventContext, filterJson.field);
      if (filterJson.op) {
        return matchOperatorObject(actual, { [String(filterJson.op)]: filterJson.value });
      }
      const opsObj = {};
      for (const k of opsKeys) {
        if (k === 'value' && !opsKeys.includes('op') && opsKeys.length === 1) {
          opsObj.$eq = filterJson.value;
        } else if (k !== 'op' && k !== 'value') {
          opsObj[k] = filterJson[k];
        }
      }
      return matchOperatorObject(actual, opsObj);
    }
  }

  for (const [key, expected] of entries) {
    if (key === '$and' || key === 'and' || key === 'all') {
      if (!Array.isArray(expected) || !expected.every((item) => matchesFilter(item, eventContext))) return false;
      continue;
    }
    if (key === '$or' || key === 'or' || key === 'any') {
      if (!Array.isArray(expected) || !expected.some((item) => matchesFilter(item, eventContext))) return false;
      continue;
    }
    if (key === '$not') {
      if (matchesFilter(expected, eventContext)) return false;
      continue;
    }
    if (key === 'rules' && Array.isArray(expected)) {
      if (!expected.every((item) => matchesFilter(item, eventContext))) return false;
      continue;
    }
    const actual = lookupFilterValue(eventContext, key);
    if (isOperatorObject(expected)) {
      if (!matchOperatorObject(actual, expected)) return false;
    } else if (Array.isArray(expected)) {
      if (!expected.includes(actual)) return false;
    } else if (actual !== expected) {
      return false;
    }
  }
  return true;
}

function matchesEventPatternLocal(pattern, eventType) {
  const pat = String(pattern || '*').trim();
  const actual = String(eventType || '').trim();
  if (!pat || pat === '*') return true;
  if (!actual) return false;
  const parts = pat
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.some((p) => {
    if (p === '*' || p === actual) return true;
    if (p.endsWith('.*')) {
      const prefix = p.slice(0, -1);
      return actual.startsWith(prefix);
    }
    if (p.endsWith('*')) {
      const prefix = p.slice(0, -1);
      return actual.startsWith(prefix);
    }
    return false;
  });
}

function isAllowlistedTargetCollection(collectionName) {
  const name = String(collectionName || '').trim();
  if (!name) return false;
  if (SYSTEM_PROTECTED_COLLECTIONS?.has(name)) return false;
  if (SENSITIVE_TARGET_COLLECTIONS.has(name)) return false;
  if (AUTOMATION_COLLECTIONS.includes(name)) return false;
  if (ALLOWLISTED_BUSINESS_COLLECTIONS.has(name)) return true;
  return CUSTOM_COLLECTION_RE.test(name);
}

function loadSiblingBlocksModule(relName) {
  const inDist = __dirname.includes(`${path.sep}dist${path.sep}`);
  const candidates = inDist
    ? [
        path.resolve(__dirname, `../../../plugin-dxos-blocks/dist/server/${relName}`),
        `@latticedx/plugin-dxos-blocks/dist/server/${relName}`,
        path.resolve(__dirname, `../../../plugin-dxos-blocks/src/server/${relName}`),
        `@latticedx/plugin-dxos-blocks/src/server/${relName}`,
      ]
    : [
        path.resolve(__dirname, `../../../plugin-dxos-blocks/src/server/${relName}`),
        `@latticedx/plugin-dxos-blocks/src/server/${relName}`,
        path.resolve(__dirname, `../../../plugin-dxos-blocks/dist/server/${relName}`),
        `@latticedx/plugin-dxos-blocks/dist/server/${relName}`,
      ];
  for (const modPath of candidates) {
    try {
      return require(modPath);
    } catch (err) {
      const isDirectMissing = err?.code === 'MODULE_NOT_FOUND'
        && (!Array.isArray(err.requireStack) || err.requireStack.length === 0 || err.requireStack[0] === __filename);
      if (!isDirectMissing) throw err;
    }
  }
  return null;
}

function loadCrossPluginModules(app, options = {}) {
  const eventBusMod = options.eventBus || app?.latticeEvents || loadFoundationModule('event-bus');
  const vaultMod = options.connectorVault || app?.latticeVault || loadFoundationModule('connector-vault');
  const notificationMod =
    options.notificationCenter || app?.latticeNotifications || loadFoundationModule('notification-center');
  const digitalTwinMod = options.digitalTwin || app?.latticeDigitalTwin || loadSiblingBlocksModule('digital-twin');
  return { eventBusMod, vaultMod, notificationMod, digitalTwinMod };
}

function extractPatScopes(ctx) {
  const raw = ctx?.state?.patScopes || ctx?.state?.currentUser?.patScopes || ctx?.state?.apiKey?.scopes;
  if (Array.isArray(raw)) return raw.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }
  return null;
}

function assertAutomationPatScope(ctx, allowedScopes, foundation) {
  if (ctx?.state?.latticeApiKey) {
    return assertPatScope(ctx, allowedScopes, foundation || undefined);
  }
  const isPat = ctx?.state?.authType === 'pat' || Boolean(ctx?.state?.apiKey) || extractPatScopes(ctx) !== null;
  if (!isPat) return true;
  const scopes = extractPatScopes(ctx) || [];
  if (scopes.includes('*')) return true;
  const ok = allowedScopes.some((s) => scopes.includes(s));
  if (!ok) {
    throw fail('PAT_SCOPE_DENIED', 403, `PAT requires one of scopes [${allowedScopes.join(', ')}]`);
  }
  return true;
}

function hasAnyRole(roles, allowedSet) {
  return Array.isArray(roles) && roles.some((r) => allowedSet.has(String(r)));
}

function validateRulePayload(payload) {
  const ruleKey = String(payload.ruleKey || payload.automationCode || '').trim();
  if (!RULE_KEY_RE.test(ruleKey)) {
    throw fail('INVALID_RULE_KEY', 400, 'ruleKey must match ^[a-z0-9][a-z0-9_-]{1,62}$');
  }
  const name = String(payload.name || '').trim();
  if (!name) {
    throw fail('MISSING_RULE_NAME', 400, 'name is required');
  }
  const triggerEventType = String(payload.triggerEventType || '*').trim() || '*';
  const actionsJson = Array.isArray(payload.actionsJson) ? payload.actionsJson : [];
  for (let i = 0; i < actionsJson.length; i += 1) {
    const act = actionsJson[i];
    if (!isPlainObject(act) || !VALID_ACTION_TYPES.has(String(act.type || '').trim())) {
      throw fail('INVALID_ACTION_TYPE', 400, `actionsJson[${i}].type must be a valid automation action`);
    }
    if (hasUnsafeTemplateSyntax(act)) {
      throw fail('UNSAFE_TEMPLATE_EXPRESSION', 400, `actionsJson[${i}] contains unsafe template or prototype key`);
    }
  }
  if (payload.filterJson !== undefined && payload.filterJson !== null && hasUnsafeTemplateSyntax(payload.filterJson)) {
    throw fail('UNSAFE_TEMPLATE_EXPRESSION', 400, 'filterJson contains unsafe template or prototype key');
  }
  const rawMaxDepth = payload.maxDepth === undefined || payload.maxDepth === null ? 8 : Number(payload.maxDepth);
  if (!Number.isInteger(rawMaxDepth) || rawMaxDepth < 1 || rawMaxDepth > MAX_HARD_DEPTH) {
    throw fail('INVALID_MAX_DEPTH', 400, `maxDepth must be an integer between 1 and ${MAX_HARD_DEPTH}`);
  }
  const rawCooldown = payload.cooldownSec === undefined || payload.cooldownSec === null ? 0 : Number(payload.cooldownSec);
  if (!Number.isInteger(rawCooldown) || rawCooldown < 0) {
    throw fail('INVALID_COOLDOWN', 400, 'cooldownSec must be a non-negative integer');
  }
  return {
    ruleKey,
    name,
    description: payload.description ? String(payload.description) : null,
    triggerEventType,
    filterJson: payload.filterJson ? sanitizePlainObject(payload.filterJson) : null,
    dmnTableKey: payload.dmnTableKey ? String(payload.dmnTableKey).trim() : null,
    actionsJson: sanitizePlainObject(actionsJson),
    maxDepth: rawMaxDepth,
    cooldownSec: rawCooldown,
    active: payload.active === undefined ? true : Boolean(payload.active),
  };
}

function normalizeIncomingEvent(rawEvent, fallbackOrgId) {
  const src = isPlainObject(rawEvent) ? sanitizePlainObject(rawEvent) : {};
  const data = isPlainObject(src.data)
    ? src.data
    : isPlainObject(src.context)
      ? src.context
      : isPlainObject(src.payload)
        ? src.payload
        : isPlainObject(src) && !src.type && !src.eventType && !src.id
          ? src
          : {};
  const organizationId = String(
    src.organizationid || src.organizationId || data.organizationId || fallbackOrgId || '',
  ).trim();
  const type = String(src.type || src.eventType || 'manual.trigger').trim() || 'manual.trigger';
  const id = src.id ? String(src.id) : src.eventId ? String(src.eventId) : `evt_${crypto.randomUUID()}`;
  const depth = Math.max(0, Number(src.depth ?? 0) || 0);
  return {
    id,
    type,
    source: src.source ? String(src.source) : 'dxos-studio',
    subject: src.subject ? String(src.subject) : '',
    time: src.time ? String(src.time) : new Date().toISOString(),
    organizationid: organizationId,
    organizationId,
    correlationid: src.correlationid ? String(src.correlationid) : id,
    causationid: src.causationid ? String(src.causationid) : '',
    depth,
    data,
    event: src,
  };
}

function buildConnectorUrl(baseUrl, pathOrUrl) {
  const baseRaw = String(baseUrl || '').trim();
  let baseParsed;
  try {
    baseParsed = new URL(baseRaw);
  } catch {
    throw fail('CONNECTOR_URL_OVERRIDE_FORBIDDEN', 400, 'CONNECTOR_URL_OVERRIDE_FORBIDDEN: Invalid connector baseUrl');
  }

  const p = String(pathOrUrl || '').trim();
  if (!p) return baseRaw;

  if (/^\/\//.test(p) || /\\/.test(p) || /[\u0000-\u001f\u007f]/.test(p)) {
    throw fail('CONNECTOR_URL_OVERRIDE_FORBIDDEN', 400, `CONNECTOR_URL_OVERRIDE_FORBIDDEN: Unsafe connector path "${p}"`);
  }

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(p)) {
    let targetParsed;
    try {
      targetParsed = new URL(p);
    } catch {
      throw fail('CONNECTOR_URL_OVERRIDE_FORBIDDEN', 400, `CONNECTOR_URL_OVERRIDE_FORBIDDEN: Invalid connector URL "${p}"`);
    }
    if (
      targetParsed.origin !== baseParsed.origin ||
      targetParsed.protocol !== baseParsed.protocol ||
      targetParsed.host !== baseParsed.host ||
      targetParsed.username !== baseParsed.username ||
      targetParsed.password !== baseParsed.password
    ) {
      throw fail(
        'CONNECTOR_URL_OVERRIDE_FORBIDDEN',
        400,
        `CONNECTOR_URL_OVERRIDE_FORBIDDEN: Action URL "${p}" cannot switch origin from "${baseParsed.origin}"`,
      );
    }
    return targetParsed.toString();
  }

  const base = baseRaw.replace(/\/+$/, '');
  const rel = p.startsWith('/') ? p : `/${p}`;
  const candidate = `${base}${rel}`;
  let candidateParsed;
  try {
    candidateParsed = new URL(candidate);
  } catch {
    throw fail('CONNECTOR_URL_OVERRIDE_FORBIDDEN', 400, 'CONNECTOR_URL_OVERRIDE_FORBIDDEN: Invalid resolved connector URL');
  }
  if (
    candidateParsed.origin !== baseParsed.origin ||
    candidateParsed.protocol !== baseParsed.protocol ||
    candidateParsed.host !== baseParsed.host ||
    candidateParsed.username !== baseParsed.username ||
    candidateParsed.password !== baseParsed.password
  ) {
    throw fail(
      'CONNECTOR_URL_OVERRIDE_FORBIDDEN',
      400,
      `CONNECTOR_URL_OVERRIDE_FORBIDDEN: Resolved connector URL switched origin from "${baseParsed.origin}"`,
    );
  }
  return candidate;
}

function scrubSecrets(text, secrets) {
  let out = String(text || '');
  if (!secrets || typeof secrets !== 'object') return out;
  for (const sVal of Object.values(secrets)) {
    if (typeof sVal === 'string' && sVal.length >= 4) {
      out = out.split(sVal).join('[REDACTED]');
    }
  }
  return out;
}

function decodeHmacKey(secret) {
  const s = String(secret || '').trim();
  if (!s) return null;
  if (s.startsWith('whsec_')) {
    return Buffer.from(s.slice(6), 'base64');
  }
  return s;
}

function buildHmacHeaders(bodyString, secrets) {
  const secret = String(secrets?.secret || secrets?.signingSecret || secrets?.hmacSecret || secrets?.apiKey || '');
  const hmacKey = decodeHmacKey(secret);
  if (!hmacKey) return {};
  const webhookId = `msg_${crypto.randomUUID()}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const hexSig = crypto.createHmac('sha256', hmacKey).update(bodyString || '').digest('hex');
  const b64Sig = crypto
    .createHmac('sha256', hmacKey)
    .update(`${webhookId}.${ts}.${bodyString || ''}`)
    .digest('base64');
  return {
    'X-Lattice-Signature-256': `sha256=${hexSig}`,
    'webhook-id': webhookId,
    'webhook-timestamp': ts,
    'webhook-signature': `v1,${b64Sig}`,
  };
}

function buildFallbackAuthHeaders(authType, secrets) {
  const kind = String(authType || 'none').toLowerCase();
  if (!secrets || typeof secrets !== 'object' || kind === 'none') return {};
  if (kind === 'bearer' && (secrets.token || secrets.bearerToken || secrets.accessToken || secrets.apiKey)) {
    return { Authorization: `Bearer ${secrets.token || secrets.bearerToken || secrets.accessToken || secrets.apiKey}` };
  }
  if (kind === 'api_key' && secrets.apiKey) {
    return { [String(secrets.headerName || 'X-API-Key')]: String(secrets.apiKey) };
  }
  if (kind === 'basic' && secrets.username) {
    const encoded = Buffer.from(`${secrets.username}:${secrets.password || ''}`).toString('base64');
    return { Authorization: `Basic ${encoded}` };
  }
  return {};
}

async function emitStepDomainEvent(db, eventBusMod, orgId, eventPayload, depth, app) {
  if (!eventPayload || !eventPayload.type) return;
  const body = {
    organizationId: orgId,
    type: String(eventPayload.type),
    source: 'dxos-studio:automation-engine',
    subject: eventPayload.subject ? String(eventPayload.subject) : '',
    data: isPlainObject(eventPayload.data) ? eventPayload.data : {},
    depth,
    app,
  };
  if (typeof app?.latticeEvents?.publishDomainEvent === 'function') {
    if (db && typeof db.getRepository === 'function') {
      await app.latticeEvents.publishDomainEvent(db, body);
    } else {
      await app.latticeEvents.publishDomainEvent(body);
    }
    return;
  }
  if (eventBusMod && typeof eventBusMod.publishDomainEvent === 'function') {
    await eventBusMod.publishDomainEvent(db, body);
  }
}

function sanitizeAutomationWriteValues(targetCollection, rawValues) {
  const values = isPlainObject(rawValues) ? sanitizePlainObject(rawValues) : {};
  delete values.id;
  delete values.organizationId;
  if (CORE_VOUCHER_COLLECTIONS.has(targetCollection)) {
    for (const field of PROTECTED_VOUCHER_FIELDS) {
      delete values[field];
    }
  }
  return values;
}

async function executeActionStep({
  action,
  stepIndex,
  organizationId,
  eventContext,
  rule,
  db,
  app,
  options,
}) {
  const startMs = Date.now();
  const type = String(action?.type || '').trim();
  const { eventBusMod, vaultMod, notificationMod, digitalTwinMod } = loadCrossPluginModules(app, options);

  try {
    if (!VALID_ACTION_TYPES.has(type)) {
      throw new Error(`Unsupported automation action type: ${type || 'empty'}`);
    }

    let output = null;

    if (type === 'create_record') {
      const targetCollection = String(interpolateTemplate(action.collection || action.targetCollection || '', eventContext)).trim();
      if (!isAllowlistedTargetCollection(targetCollection)) {
        throw new Error(`TARGET_COLLECTION_FORBIDDEN: ${targetCollection || '(empty)'}`);
      }
      const repo = db.getRepository(targetCollection);
      if (!repo) {
        throw new Error(`Repository not found for collection ${targetCollection}`);
      }
      const rawValues = interpolateTemplate(action.values || action.data || action.payload || {}, eventContext);
      const values = sanitizeAutomationWriteValues(targetCollection, rawValues);
      values.organizationId = organizationId;
      const created = await repo.create({ values });
      const plain = toPlain(created) || {};
      output = {
        collection: targetCollection,
        id: val(created, 'id') ?? plain.id ?? null,
        record: plain,
      };
    } else if (type === 'update_record') {
      const targetCollection = String(interpolateTemplate(action.collection || action.targetCollection || '', eventContext)).trim();
      if (!isAllowlistedTargetCollection(targetCollection)) {
        throw new Error(`TARGET_COLLECTION_FORBIDDEN: ${targetCollection || '(empty)'}`);
      }
      const repo = db.getRepository(targetCollection);
      if (!repo) {
        throw new Error(`Repository not found for collection ${targetCollection}`);
      }
      const rawFilter = action.filter
        ? interpolateTemplate(action.filter, eventContext)
        : action.recordId !== undefined
          ? { id: interpolateTemplate(action.recordId, eventContext) }
          : null;
      if (!isPlainObject(rawFilter) || Object.keys(rawFilter).length === 0) {
        throw new Error('update_record requires non-empty filter or recordId');
      }
      const sanitizedFilter = sanitizeDirectFilter(rawFilter);
      const scopedFilter = { ...sanitizePlainObject(sanitizedFilter), organizationId };
      const rawValues = interpolateTemplate(action.values || action.patch || action.data || {}, eventContext);
      const values = sanitizeAutomationWriteValues(targetCollection, rawValues);

      const existing = await repo.find({ filter: scopedFilter, limit: Number(action.limit || 20) });
      const list = Array.isArray(existing) ? existing : [];
      if (list.length > 0 && typeof repo.update === 'function') {
        await repo.update({ filter: scopedFilter, values });
      }
      output = {
        collection: targetCollection,
        matchedCount: list.length,
        updatedCount: list.length,
      };
    } else if (type === 'notify_role') {
      const rawRoles = interpolateTemplate(action.roleNames || action.roles || action.role || 'ldx_operator', eventContext);
      const roleNames = (Array.isArray(rawRoles) ? rawRoles : [rawRoles])
        .map((r) => String(r || '').trim())
        .filter(Boolean);
      const title = String(interpolateTemplate(action.title || `Automation: ${rule.name}`, eventContext));
      const body = String(interpolateTemplate(action.body || action.message || '', eventContext));
      const severity = String(interpolateTemplate(action.severity || 'warning', eventContext));
      const category = String(interpolateTemplate(action.category || 'automation', eventContext));
      const targetCollection = action.targetCollection
        ? String(interpolateTemplate(action.targetCollection, eventContext))
        : undefined;
      const targetRecordId = action.targetRecordId
        ? interpolateTemplate(action.targetRecordId, eventContext)
        : undefined;
      const targetPath = action.targetPath ? String(interpolateTemplate(action.targetPath, eventContext)) : undefined;

      if (notificationMod && typeof notificationMod.dispatchRoleNotifications === 'function') {
        const res = await notificationMod.dispatchRoleNotifications(
          db,
          {
            organizationId,
            roleNames,
            category,
            severity,
            title,
            body,
            targetCollection,
            targetRecordId,
            targetPath,
            notifyChannels: Array.isArray(action.notifyChannels) ? action.notifyChannels : ['in_app'],
          },
          { env: options.env, fetchImpl: options.fetchImpl },
        );
        output = { roleNames, dispatched: res?.createdCount ?? res?.count ?? roleNames.length, title };
      } else {
        const notifRepo = db.getRepository('latticeNotifications');
        if (notifRepo && typeof notifRepo.create === 'function') {
          await notifRepo.create({
            values: {
              organizationId,
              targetRole: roleNames[0] || 'ldx_operator',
              category,
              severity,
              title,
              body,
              targetCollection: targetCollection || null,
              targetRecordId: targetRecordId || null,
              targetPath: targetPath || null,
              read: false,
            },
          });
          output = { roleNames, dispatched: roleNames.length, title };
        } else {
          throw new Error('Notification Center module unavailable');
        }
      }
    } else if (type === 'call_connector') {
      const connectorKey = String(interpolateTemplate(action.connectorKey || action.connector || '', eventContext)).trim();
      if (!connectorKey) {
        throw new Error('call_connector requires connectorKey');
      }
      if (!vaultMod || typeof vaultMod.resolveConnectorSecrets !== 'function') {
        throw new Error('Connector Vault module unavailable');
      }
      const { connector, secrets } = await vaultMod.resolveConnectorSecrets(db, organizationId, connectorKey, {
        env: options.env,
      });
      const resolvedUrl = buildConnectorUrl(connector.baseUrl, interpolateTemplate(action.url || action.path || '', eventContext));
      const ssrfOpts = {
        connectorType: connector.connectorType || 'http_api',
        env: options.env,
        ...(typeof options.lookupImpl === 'function' ? { lookupImpl: options.lookupImpl } : {}),
      };
      if (typeof vaultMod.assertSafeConnectorUrl === 'function') {
        vaultMod.assertSafeConnectorUrl(resolvedUrl, ssrfOpts);
      }
      if (typeof vaultMod.assertSafeConnectorUrlAsync === 'function') {
        await vaultMod.assertSafeConnectorUrlAsync(resolvedUrl, ssrfOpts);
      } else if (typeof vaultMod.resolveAndAssertSafeAddress === 'function') {
        await vaultMod.resolveAndAssertSafeAddress(resolvedUrl, ssrfOpts);
      } else if (typeof vaultMod.assertSafeConnectorDns === 'function') {
        await vaultMod.assertSafeConnectorDns(resolvedUrl, ssrfOpts);
      }
      const method = String(action.method || 'POST').toUpperCase();
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
        throw new Error(`Unsupported HTTP method: ${method}`);
      }
      const customHeaders = isPlainObject(action.headers) ? interpolateTemplate(action.headers, eventContext) : {};
      const authHeaders =
        typeof vaultMod.buildConnectorAuthHeaders === 'function'
          ? vaultMod.buildConnectorAuthHeaders(connector.authType, secrets)
          : buildFallbackAuthHeaders(connector.authType, secrets);
      const bodyPayload =
        method === 'GET' || method === 'DELETE'
          ? undefined
          : JSON.stringify(interpolateTemplate(action.body ?? action.payload ?? eventContext.data ?? {}, eventContext));
      const hmacHeaders = connector.authType === 'hmac' ? buildHmacHeaders(bodyPayload || '', secrets) : {};
      const headers = {
        Accept: 'application/json',
        ...(bodyPayload !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...customHeaders,
        ...authHeaders,
        ...hmacHeaders,
      };

      const fetchImpl = options.fetchImpl || globalThis.fetch;
      if (typeof fetchImpl !== 'function') {
        throw new Error('fetch implementation unavailable');
      }
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), Number(action.timeoutMs || CONNECTOR_TIMEOUT_MS));
      let response;
      try {
        response = await fetchImpl(resolvedUrl, {
          method,
          headers,
          body: bodyPayload,
          redirect: 'error',
          signal: controller.signal,
        });
      } catch (err) {
        throw new Error(scrubSecrets(err?.message || 'Connector HTTP request failed', secrets));
      } finally {
        clearTimeout(timeoutId);
      }
      if (!response.ok) {
        throw new Error(`Connector ${connectorKey} responded with HTTP ${response.status}`);
      }
      const parsedUrl = (() => {
        try {
          const u = new URL(resolvedUrl);
          return `${u.origin}${u.pathname}`;
        } catch {
          return resolvedUrl;
        }
      })();
      output = {
        connectorKey,
        authType: connector.authType,
        method,
        url: parsedUrl,
        status: response.status,
        ok: true,
      };
    } else if (type === 'twin_set_desired') {
      if (!digitalTwinMod || typeof digitalTwinMod.requestDesiredSetpoint !== 'function') {
        throw new Error('Digital Twin module unavailable');
      }
      const rawDesired = interpolateTemplate(action.desiredPatch || action.desired || {}, eventContext);
      const desiredPatch = isPlainObject(rawDesired) ? sanitizePlainObject(rawDesired) : {};
      if (desiredPatch.targetTempC !== undefined && desiredPatch.targetTempC !== '') {
        const numericTemp = Number(desiredPatch.targetTempC);
        if (Number.isFinite(numericTemp)) desiredPatch.targetTempC = numericTemp;
      }
      const assetEntityId = String(
        interpolateTemplate(action.assetEntityId || action.deviceKey || action.subject || '', eventContext),
      ).trim();
      const assetId = action.assetId ? interpolateTemplate(action.assetId, eventContext) : undefined;
      const twinRes = await digitalTwinMod.requestDesiredSetpoint(db, {
        organizationId,
        assetId,
        assetEntityId,
        desiredPatch,
        actor: eventContext.actor || { username: `automation:${rule.ruleKey}`, role: 'automation' },
        downlinkUrl: action.downlinkUrl ? String(interpolateTemplate(action.downlinkUrl, eventContext)) : undefined,
        env: options.env,
        fetchImpl: options.fetchImpl,
      });
      output = twinRes;
    } else if (type === 'trigger_ai_triage') {
      const targetCollection = String(
        interpolateTemplate(action.targetCollection || 'latticeAssets', eventContext),
      ).trim();
      const targetRecordIdRaw = interpolateTemplate(action.targetRecordId ?? eventContext?.data?.assetId ?? 0, eventContext);
      const targetRecordId = Number.isFinite(Number(targetRecordIdRaw)) ? Number(targetRecordIdRaw) : 0;
      const recommendation = String(
        interpolateTemplate(action.recommendation || action.summary || `AI triage for rule ${rule.ruleKey}`, eventContext),
      );
      const evidence = sanitizePlainObject(
        interpolateTemplate(
          action.evidence || {
            ruleKey: rule.ruleKey,
            eventType: eventContext.type,
            eventId: eventContext.id,
            data: eventContext.data,
            dmn: eventContext.dmn,
          },
          eventContext,
        ),
      );
      const proposalRepo = db.getRepository('latticeAgentProposals');
      const queueRepo = db.getRepository('latticeAiApprovalQueue');
      if (proposalRepo && typeof proposalRepo.create === 'function') {
        const receiptKey = `triage-${organizationId}-${rule.ruleKey}-${eventContext.id}-${stepIndex}`.slice(0, 120);
        const fingerprint = crypto
          .createHash('sha256')
          .update(JSON.stringify({ organizationId, targetCollection, targetRecordId, eventId: eventContext.id }))
          .digest('hex');
        const created = await proposalRepo.create({
          values: {
            receiptKey,
            contentHash: fingerprint,
            eventId: String(eventContext.id),
            organizationId,
            sourceUserId: Number(eventContext.actor?.id || 0),
            sourceEmployeeId: Number(eventContext.actor?.employeeId || 0),
            targetCollection,
            targetRecordId,
            recordFingerprint: fingerprint.slice(0, 32),
            recommendation,
            evidence,
            state: 'proposed',
          },
        });
        output = {
          target: 'latticeAgentProposals',
          id: val(created, 'id') ?? null,
          receiptKey,
          state: 'proposed',
        };
      } else if (queueRepo && typeof queueRepo.create === 'function') {
        const created = await queueRepo.create({
          values: {
            organizationId,
            requesterUserId: Number(eventContext.actor?.id || 0),
            requesterUsername: String(eventContext.actor?.username || `automation:${rule.ruleKey}`),
            aiEmployee: String(action.aiEmployee || 'ops_triage'),
            toolName: String(action.toolName || 'triage_automation_event'),
            targetCollection,
            targetRecordId: String(targetRecordId),
            operation: 'triage',
            proposedArgs: evidence,
            diffPreview: recommendation,
            riskLevel: String(action.severity || 'medium'),
            status: 'pending',
          },
        });
        output = {
          target: 'latticeAiApprovalQueue',
          id: val(created, 'id') ?? null,
          status: 'pending',
        };
      } else {
        throw new Error('No triage repository (latticeAgentProposals or latticeAiApprovalQueue) available');
      }
    }

    if (action.emitEvent) {
      await emitStepDomainEvent(
        db,
        eventBusMod,
        organizationId,
        interpolateTemplate(action.emitEvent, eventContext),
        Number(eventContext.depth || 0) + 1,
        app,
      );
    }

    return {
      stepIndex,
      type,
      status: 'completed',
      output,
      error: null,
      durationMs: Math.max(0, Date.now() - startMs),
    };
  } catch (err) {
    return {
      stepIndex,
      type,
      status: 'failed',
      output: null,
      error: err?.message || String(err),
      durationMs: Math.max(0, Date.now() - startMs),
    };
  }
}

async function executeRuleAgainstEvent(db, ruleRow, rawEvent, options = {}) {
  const rule = toPlain(ruleRow) || {};
  const organizationId = String(rule.organizationId || '').trim();
  const event = normalizeIncomingEvent(rawEvent, organizationId);
  const runUid = `run_${crypto.randomUUID()}`;
  const startedAt = new Date();
  const startMs = startedAt.getTime();
  const app = options.app || db?.app;

  const effectiveMaxDepth = Math.min(MAX_HARD_DEPTH, Math.max(1, Number(rule.maxDepth || MAX_HARD_DEPTH)));
  const depth = Number(event.depth || 0);
  const runsRepo = db.getRepository('latticeAutomationRuns');
  const rulesRepo = db.getRepository('latticeAutomationRules');

  const finalizeRun = async (fields) => {
    const finishedAt = new Date();
    const record = {
      organizationId,
      ruleId: val(ruleRow, 'id') ?? rule.id ?? null,
      ruleKey: String(rule.ruleKey),
      runUid,
      triggerEventId: event.id,
      triggerEventType: event.type,
      depth,
      startedAt,
      finishedAt,
      durationMs: Math.max(0, finishedAt.getTime() - startMs),
      ...fields,
    };
    rememberRunSnapshot(runUid, event);
    if (!options.dryRun && runsRepo && typeof runsRepo.create === 'function') {
      const created = await runsRepo.create({ values: record });
      return toPlain(created) || record;
    }
    return record;
  };

  if (depth >= effectiveMaxDepth) {
    return finalizeRun({
      status: 'skipped',
      matched: false,
      dmnResultJson: null,
      stepTracesJson: [
        {
          stepIndex: 0,
          type: 'recursion_guard',
          status: 'skipped',
          output: { depth, maxDepth: effectiveMaxDepth },
          error: 'RECURSION_DEPTH_LIMIT_EXCEEDED',
          durationMs: 0,
        },
      ],
      errorMessage: `RECURSION_DEPTH_LIMIT_EXCEEDED (depth=${depth} >= maxDepth=${effectiveMaxDepth})`,
    });
  }

  const cooldownSec = Math.max(0, Number(rule.cooldownSec || 0));
  if (!options.dryRun && !options.ignoreCooldown && cooldownSec > 0 && rule.lastTriggeredAt) {
    const lastMs = new Date(rule.lastTriggeredAt).getTime();
    if (Number.isFinite(lastMs) && startMs - lastMs < cooldownSec * 1000) {
      return finalizeRun({
        status: 'skipped',
        matched: false,
        dmnResultJson: null,
        stepTracesJson: [
          {
            stepIndex: 0,
            type: 'cooldown_guard',
            status: 'skipped',
            output: { cooldownSec },
            error: 'COOLDOWN_ACTIVE',
            durationMs: 0,
          },
        ],
        errorMessage: 'COOLDOWN_ACTIVE',
      });
    }
  }

  const eventContext = {
    ...event,
    actor: options.actor || null,
    dmn: {},
    dmnResult: null,
  };

  const matched = matchesFilter(rule.filterJson, eventContext);
  if (!matched) {
    return finalizeRun({
      status: 'skipped',
      matched: false,
      dmnResultJson: null,
      stepTracesJson: [],
      errorMessage: 'FILTER_NOT_MATCHED',
    });
  }

  let dmnResultJson = null;
  if (rule.dmnTableKey) {
    const dmnRepo = db.getRepository('latticeDecisionTables');
    const tableRow = dmnRepo
      ? await dmnRepo.findOne({ filter: { organizationId, tableKey: String(rule.dmnTableKey) } })
      : null;
    if (!tableRow || val(tableRow, 'active') === false) {
      return finalizeRun({
        status: 'failed',
        matched: true,
        dmnResultJson: null,
        stepTracesJson: [],
        errorMessage: `DMN_TABLE_NOT_FOUND: ${rule.dmnTableKey}`,
      });
    }
    const facts = {
      ...(isPlainObject(event.data) ? event.data : {}),
      eventType: event.type,
      source: event.source,
      subject: event.subject,
      organizationId,
    };
    const dmnEval = evaluateDecisionTable(toPlain(tableRow), facts);
    dmnResultJson = {
      tableKey: rule.dmnTableKey,
      matched: Boolean(dmnEval.matched),
      hitPolicy: dmnEval.hitPolicy,
      ruleId: dmnEval.ruleId || null,
      matchedRules: dmnEval.matchedRules || undefined,
      outputs: isPlainObject(dmnEval.outputs) ? dmnEval.outputs : {},
    };
    eventContext.dmn = dmnResultJson.outputs;
    eventContext.dmnResult = dmnResultJson;
  }

  const actions = Array.isArray(rule.actionsJson) ? rule.actionsJson : [];
  if (options.dryRun) {
    const simulatedSteps = actions.map((act, idx) => ({
      stepIndex: idx,
      type: String(act.type || ''),
      status: 'simulated',
      output: interpolateTemplate(act, eventContext),
      error: null,
      durationMs: 0,
    }));
    return finalizeRun({
      status: 'completed',
      matched: true,
      dmnResultJson,
      stepTracesJson: simulatedSteps,
      errorMessage: null,
    });
  }

  const stepTraces = [];
  for (let i = 0; i < actions.length; i += 1) {
    const trace = await executeActionStep({
      action: actions[i],
      stepIndex: i,
      organizationId,
      eventContext,
      rule,
      db,
      app,
      options,
    });
    stepTraces.push(trace);
    if (trace.status === 'failed' && actions[i]?.stopOnError === true) {
      break;
    }
  }

  const failedSteps = stepTraces.filter((s) => s.status === 'failed');
  const completedSteps = stepTraces.filter((s) => s.status === 'completed');
  let status = 'completed';
  if (failedSteps.length > 0) {
    status = completedSteps.length > 0 ? 'partial' : 'failed';
  }

  if (rulesRepo && typeof rulesRepo.update === 'function') {
    await rulesRepo
      .update({
        filter: { organizationId, ruleKey: rule.ruleKey },
        values: { lastTriggeredAt: new Date() },
      })
      .catch(() => {});
  }

  return finalizeRun({
    status,
    matched: true,
    dmnResultJson,
    stepTracesJson: stepTraces,
    errorMessage: failedSteps.length > 0 ? failedSteps.map((s) => s.error).join('; ') : null,
  });
}

async function handleDomainEvent(db, cloudEvent, options = {}) {
  const evt = normalizeIncomingEvent(cloudEvent);
  if (!evt.organizationId) return [];
  const rulesRepo = db.getRepository('latticeAutomationRules');
  if (!rulesRepo) return [];
  const rows = await rulesRepo.find({
    filter: { organizationId: evt.organizationId, active: true },
    limit: 500,
  });
  const candidates = (Array.isArray(rows) ? rows : []).filter((row) =>
    matchesEventPatternLocal(val(row, 'triggerEventType') || '*', evt.type),
  );
  const runs = [];
  for (const row of candidates) {
    try {
      const run = await executeRuleAgainstEvent(db, row, evt, options);
      runs.push(run);
    } catch (err) {
      runs.push({
        ruleKey: val(row, 'ruleKey'),
        status: 'failed',
        errorMessage: err?.message || String(err),
      });
    }
  }
  return runs;
}

function createAutomationDirectGuardMiddleware(db, foundationOverride) {
  const foundation = foundationOverride || loadFoundationSet();
  return async function dxosAutomationDirectGuard(ctx, next) {
    const resourceName = ctx?.action?.resourceName;
    const baseResource = String(resourceName || '').split('.')[0];
    const actionName = ctx?.action?.actionName;
    const params = readParams(ctx);
    const collection = String(params?.collection || params?.table || params?.collectionName || '').split('.')[0].trim();

    const isDirectAutomation = AUTOMATION_COLLECTIONS.includes(baseResource);
    const isChartOnAutomation =
      baseResource === 'charts' &&
      actionName === 'queryData' &&
      AUTOMATION_COLLECTIONS.includes(collection);

    if (!isDirectAutomation && !isChartOnAutomation) {
      return next();
    }

    const roles = await resolveVerifiedRoles(db, ctx);
    const hasRuRepo = typeof db?.getRepository?.('rolesUsers')?.find === 'function';
    const isRoot = roles.includes('root') || (!hasRuRepo && ctx?.state?.currentUser?.isRoot === true);
    if (isRoot) {
      return next();
    }

    throw fail(
      'AUTOMATION_DIRECT_CRUD_FORBIDDEN',
      403,
      `Direct access to ${isChartOnAutomation ? collection : baseResource} is restricted; use /api/dxosAutomations:*`,
    );
  };
}

function registerAutomationEventListener(app, db, options = {}) {
  const { eventBusMod } = loadCrossPluginModules(app, options);
  const registerFn =
    typeof app?.latticeEvents?.registerEventBusListener === 'function'
      ? app.latticeEvents.registerEventBusListener
      : typeof eventBusMod?.registerEventBusListener === 'function'
        ? eventBusMod.registerEventBusListener
        : null;

  if (!registerFn) {
    return { stop() {} };
  }

  let active = true;
  const unsubscribe = registerFn(async (cloudEvent, meta = {}) => {
    if (!active) return;
    await handleDomainEvent(meta.db || db, cloudEvent, {
      ...options,
      app: meta.app || app,
    });
  });

  return {
    stop() {
      if (!active) return;
      active = false;
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    },
  };
}

function createDxosAutomationsActions(db, options = {}) {
  const foundation = options.foundation || loadFoundationSet();

  async function requireOrgRoles(ctx, params, { mutating = false, allowedPatScopes = null } = {}) {
    if (allowedPatScopes) {
      assertAutomationPatScope(ctx, allowedPatScopes, foundation);
    }
    const requestedOrgId = params.organizationId != null ? String(params.organizationId).trim() : null;
    const { organizationId, actor } = await resolveTenantActor(
      db,
      ctx,
      {
        requireOrg: true,
        requestedOrgId: requestedOrgId || null,
        aclCollections: [],
      },
      foundation,
    );
    const roles = await resolveVerifiedRoles(db, ctx);
    const orgAdmin = await isOrgAdmin(db, ctx);
    if (mutating && !hasAnyRole(roles, MUTATING_ROLES) && !orgAdmin) {
      throw fail('FORBIDDEN', 403, 'Manager or admin role required for automation changes');
    }
    return { organizationId, actor, roles };
  }

  return {
    async listRules(ctx, next) {
      const params = readParams(ctx);
      assertAutomationPatScope(ctx, ['read', 'write', 'ai', 'iot'], foundation);
      const { organizationId } = await requireOrgRoles(ctx, params, { mutating: false });
      const repo = db.getRepository('latticeAutomationRules');
      const filter = { organizationId };
      if (params.active !== undefined) filter.active = params.active === true || params.active === 'true';
      if (params.triggerEventType) filter.triggerEventType = String(params.triggerEventType);
      const { limit, offset } = clampPageLimit(params);
      const rows = repo
        ? await repo.find({ filter, sort: ['-updatedAt', '-id'], limit, offset })
        : [];
      ctx.body = { items: (Array.isArray(rows) ? rows : []).map(toPlain) };
      return next();
    },

    async saveRule(ctx, next) {
      const params = readParams(ctx);
      const { organizationId, actor } = await requireOrgRoles(ctx, params, {
        mutating: true,
        allowedPatScopes: ['write', 'ai', 'iot'],
      });
      const validated = validateRulePayload(isPlainObject(params.rule) ? params.rule : params);
      const repo = db.getRepository('latticeAutomationRules');
      if (!repo) throw fail('REPOSITORY_UNAVAILABLE', 500, 'latticeAutomationRules repository is not registered');

      const existing = await repo.findOne({ filter: { organizationId, ruleKey: validated.ruleKey } });
      let saved;
      if (existing) {
        await repo.update({
          filter: { organizationId, ruleKey: validated.ruleKey },
          values: validated,
        });
        saved = await repo.findOne({ filter: { organizationId, ruleKey: validated.ruleKey } });
      } else {
        saved = await repo.create({
          values: {
            ...validated,
            organizationId,
            createdBy: actor?.username ? String(actor.username) : null,
          },
        });
      }
      ctx.body = { rule: toPlain(saved) };
      return next();
    },

    async toggleRule(ctx, next) {
      const params = readParams(ctx);
      const { organizationId } = await requireOrgRoles(ctx, params, {
        mutating: true,
        allowedPatScopes: ['write', 'ai', 'iot'],
      });
      const ruleKey = String(params.ruleKey || params.automationCode || '').trim();
      if (!ruleKey) throw fail('MISSING_RULE_KEY', 400, 'ruleKey is required');
      const repo = db.getRepository('latticeAutomationRules');
      const existing = repo ? await repo.findOne({ filter: { organizationId, ruleKey } }) : null;
      if (!existing) throw fail('RULE_NOT_FOUND', 404, `Automation rule ${ruleKey} not found`);

      const nextActive = params.active !== undefined ? Boolean(params.active) : !Boolean(val(existing, 'active'));
      await repo.update({
        filter: { organizationId, ruleKey },
        values: { active: nextActive },
      });
      const updated = await repo.findOne({ filter: { organizationId, ruleKey } });
      ctx.body = { rule: toPlain(updated) };
      return next();
    },

    async deleteRule(ctx, next) {
      const params = readParams(ctx);
      const { organizationId } = await requireOrgRoles(ctx, params, {
        mutating: true,
        allowedPatScopes: ['write', 'ai', 'iot'],
      });
      const ruleKey = String(params.ruleKey || params.automationCode || '').trim();
      if (!ruleKey) throw fail('MISSING_RULE_KEY', 400, 'ruleKey is required');
      const repo = db.getRepository('latticeAutomationRules');
      const existing = repo ? await repo.findOne({ filter: { organizationId, ruleKey } }) : null;
      if (!existing) throw fail('RULE_NOT_FOUND', 404, `Automation rule ${ruleKey} not found`);
      await repo.destroy({ filter: { organizationId, ruleKey } });
      ctx.body = { deleted: true, ruleKey };
      return next();
    },

    async testRule(ctx, next) {
      const params = readParams(ctx);
      assertAutomationPatScope(ctx, ['read', 'write', 'ai', 'iot'], foundation);
      const { organizationId, actor } = await requireOrgRoles(ctx, params, { mutating: false });
      const repo = db.getRepository('latticeAutomationRules');

      let ruleObj = null;
      if (isPlainObject(params.rule)) {
        ruleObj = { ...validateRulePayload(params.rule), organizationId };
      } else if (params.ruleKey || params.automationCode) {
        const key = String(params.ruleKey || params.automationCode).trim();
        const found = repo ? await repo.findOne({ filter: { organizationId, ruleKey: key } }) : null;
        if (!found) throw fail('RULE_NOT_FOUND', 404, `Automation rule ${key} not found`);
        ruleObj = toPlain(found);
      } else {
        ruleObj = { ...validateRulePayload(params), organizationId };
      }

      const rawEvent = params.event || params.context || params.data || params.payload || {};
      const simulation = await executeRuleAgainstEvent(db, ruleObj, rawEvent, {
        ...options,
        app: ctx?.app || db?.app,
        actor,
        dryRun: true,
        ignoreCooldown: true,
      });
      ctx.body = { simulation };
      return next();
    },

    async runNow(ctx, next) {
      const params = readParams(ctx);
      const { organizationId, actor } = await requireOrgRoles(ctx, params, {
        mutating: true,
        allowedPatScopes: ['write', 'ai', 'iot'],
      });
      const ruleKey = String(params.ruleKey || params.automationCode || '').trim();
      if (!ruleKey) throw fail('MISSING_RULE_KEY', 400, 'ruleKey or automationCode is required');
      const repo = db.getRepository('latticeAutomationRules');
      const ruleRow = repo ? await repo.findOne({ filter: { organizationId, ruleKey } }) : null;
      if (!ruleRow) throw fail('RULE_NOT_FOUND', 404, `Automation rule ${ruleKey} not found`);

      const eventPayload = isPlainObject(params.event)
        ? params.event
        : {
            id: params.eventId,
            type: params.eventType || val(ruleRow, 'triggerEventType') || 'manual.trigger',
            source: params.source || 'dxos-studio:manual',
            subject: params.subject,
            depth: params.depth ?? 0,
            organizationId,
            data: params.data || params.context || params.payload || {},
          };

      const run = await executeRuleAgainstEvent(db, ruleRow, eventPayload, {
        ...options,
        app: ctx?.app || db?.app,
        actor,
        ignoreCooldown: params.ignoreCooldown !== false,
      });
      ctx.body = { run };
      return next();
    },

    async listRuns(ctx, next) {
      const params = readParams(ctx);
      assertAutomationPatScope(ctx, ['read', 'write', 'ai', 'iot'], foundation);
      const { organizationId } = await requireOrgRoles(ctx, params, { mutating: false });
      const repo = db.getRepository('latticeAutomationRuns');
      const filter = { organizationId };
      if (params.ruleKey) filter.ruleKey = String(params.ruleKey).trim();
      if (params.status) filter.status = String(params.status).trim();
      const { limit, offset } = clampPageLimit(params);
      const rows = repo
        ? await repo.find({ filter, sort: ['-startedAt', '-id'], limit, offset })
        : [];
      ctx.body = { items: (Array.isArray(rows) ? rows : []).map(toPlain) };
      return next();
    },

    async getRunTrace(ctx, next) {
      const params = readParams(ctx);
      assertAutomationPatScope(ctx, ['read', 'write', 'ai', 'iot'], foundation);
      const { organizationId } = await requireOrgRoles(ctx, params, { mutating: false });
      const repo = db.getRepository('latticeAutomationRuns');
      const runUid = params.runUid ? String(params.runUid).trim() : null;
      const filter = runUid ? { organizationId, runUid } : { organizationId, id: params.id };
      if (!runUid && params.id === undefined) {
        throw fail('MISSING_RUN_ID', 400, 'runUid or id is required');
      }
      const row = repo ? await repo.findOne({ filter }) : null;
      if (!row) throw fail('RUN_NOT_FOUND', 404, 'Automation run not found');
      ctx.body = { run: toPlain(row) };
      return next();
    },

    async replayRun(ctx, next) {
      const params = readParams(ctx);
      const { organizationId, actor } = await requireOrgRoles(ctx, params, {
        mutating: true,
        allowedPatScopes: ['write', 'ai', 'iot'],
      });
      const runsRepo = db.getRepository('latticeAutomationRuns');
      const rulesRepo = db.getRepository('latticeAutomationRules');
      const runUid = params.runUid ? String(params.runUid).trim() : null;
      const runFilter = runUid ? { organizationId, runUid } : { organizationId, id: params.id };
      if (!runUid && params.id === undefined) {
        throw fail('MISSING_RUN_ID', 400, 'runUid or id is required');
      }
      const origRow = runsRepo ? await runsRepo.findOne({ filter: runFilter }) : null;
      if (!origRow) throw fail('RUN_NOT_FOUND', 404, 'Automation run not found');
      const orig = toPlain(origRow);

      const ruleRow = rulesRepo
        ? await rulesRepo.findOne({ filter: { organizationId, ruleKey: orig.ruleKey } })
        : null;
      if (!ruleRow) throw fail('RULE_NOT_FOUND', 404, `Automation rule ${orig.ruleKey} not found`);

      let eventEnvelope = params.event ? normalizeIncomingEvent(params.event, organizationId) : null;
      if (!eventEnvelope && orig.triggerEventId) {
        const busRepo = db.getRepository('latticeEventBus');
        const busRow = busRepo
          ? await busRepo.findOne({ filter: { organizationId, eventId: orig.triggerEventId } })
          : null;
        if (busRow) {
          const payloadJson = toPlain(busRow).payloadJson || {};
          eventEnvelope = normalizeIncomingEvent(payloadJson, organizationId);
        }
      }
      if (!eventEnvelope && orig.runUid && recentRunEventSnapshots.has(orig.runUid)) {
        eventEnvelope = { ...recentRunEventSnapshots.get(orig.runUid) };
      }
      if (!eventEnvelope) {
        eventEnvelope = normalizeIncomingEvent(
          {
            id: orig.triggerEventId,
            type: orig.triggerEventType,
            organizationId,
            data: params.data || {},
          },
          organizationId,
        );
      }
      eventEnvelope.depth = Number(orig.depth || 0) + 1;

      const replay = await executeRuleAgainstEvent(db, ruleRow, eventEnvelope, {
        ...options,
        app: ctx?.app || db?.app,
        actor,
        ignoreCooldown: true,
      });
      ctx.body = { run: replay, replayedFromRunUid: orig.runUid };
      return next();
    },
  };
}

module.exports = {
  AUTOMATION_COLLECTIONS,
  ALLOWLISTED_BUSINESS_COLLECTIONS,
  CUSTOM_COLLECTION_RE,
  MAX_HARD_DEPTH,
  RULE_KEY_RE,
  VALID_ACTION_TYPES,
  buildConnectorUrl,
  buildHmacHeaders,
  createAutomationDirectGuardMiddleware,
  createDxosAutomationsActions,
  executeRuleAgainstEvent,
  getSafePath,
  handleDomainEvent,
  hasUnsafeTemplateSyntax,
  interpolateTemplate,
  isAllowlistedTargetCollection,
  matchesFilter,
  registerAutomationEventListener,
};
