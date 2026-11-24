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
  ALLOWLISTED_BUSINESS_COLLECTIONS,
  BLOCKED_PROTO_KEYS,
  CUSTOM_COLLECTION_RE,
  MAX_HARD_DEPTH,
  RULE_KEY_RE,
  buildTriggerIndex,
  cloneSafe,
  graphV2SummaryToV1Compat,
  normalizeGraph,
  v1RuleToGraphV2,
} = require('./flow/schema');
const {
  assertSafeFlowTemplate,
  hasUnsafeTemplateSyntax,
  validateFilterStructure,
  validateFlowGraph,
} = require('./flow/validator');
const {
  applyGraphOperations,
  buildFlowStudioCatalog,
  runFlowArchitect,
} = require('./flow/architect');
const flowRegistry = require('./flow/registry');
const {
  getOrmTriggerDepth,
  resolveTrustedOrgId,
  runAutomationWithRls,
  runWithOrmDepth,
  sanitizeOutgoingHeaders,
} = require('./flow/security-helpers');
const getFlowExecutor = () => require('./flow/executor');
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
const VALID_ACTION_TYPES = new Set([
  'create_record',
  'update_record',
  'notify_role',
  'call_connector',
  'twin_set_desired',
  'trigger_ai_triage',
]);
const MUTATING_ROLES = new Set(['ldx_admin', 'ldx_manager', 'root', 'admin']);
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
const BLOCKED_PATH_SEGMENTS = BLOCKED_PROTO_KEYS;
const FORBIDDEN_TRIAGE_COLLECTIONS_LOWER = new Set(
  [...(SYSTEM_PROTECTED_COLLECTIONS || []), ...SENSITIVE_TARGET_COLLECTIONS, ...AUTOMATION_COLLECTIONS].map((c) =>
    String(c).toLowerCase(),
  ),
);
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
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
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
    if (current === null || current === undefined || typeof current !== 'object') {
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
    const singleMatch = value.match(/^\{\{([^{}]+)\}\}$/);
    if (singleMatch) {
      const resolved = resolveTemplateExpr(singleMatch[1], context);
      return resolved === undefined ? '' : resolved;
    }
    return value.replace(/\{\{([^{}]*)\}\}/g, (_full, expr) => {
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
    pathStr.startsWith('envelope.') ||
    pathStr.startsWith('steps.')
  ) {
    return getSafePath(eventContext, pathStr);
  }
  const fromData = getSafePath(eventContext?.data, pathStr);
  if (fromData !== undefined) return fromData;
  return getSafePath(eventContext, pathStr);
}

function matchOperatorObject(actual, ops) {
  if (!isPlainObject(ops)) return false;
  if (Object.getOwnPropertyNames(ops).some((k) => BLOCKED_PATH_SEGMENTS.has(k))) return false;
  const entries = Object.entries(ops);
  if (entries.length === 0) return false;
  for (const [op, expected] of entries) {
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
  if (Object.getOwnPropertyNames(obj).some((k) => BLOCKED_PATH_SEGMENTS.has(k))) return false;
  const keys = Object.keys(obj);
  return keys.length > 0 && keys.every((k) => k.startsWith('$'));
}

function matchesFilter(filterJson, eventContext) {
  if (filterJson === null || filterJson === undefined) return true;
  if (Array.isArray(filterJson)) {
    return filterJson.every((clause) => matchesFilter(clause, eventContext));
  }
  if (!isPlainObject(filterJson)) return false;
  if (Object.getOwnPropertyNames(filterJson).some((k) => BLOCKED_PATH_SEGMENTS.has(k))) {
    return false;
  }
  const entries = Object.entries(filterJson).filter(([k]) => !BLOCKED_PATH_SEGMENTS.has(k));
  if (Object.keys(filterJson).length > 0 && entries.length === 0) return false;
  if (entries.length === 0) return true;

  if (typeof filterJson.field === 'string') {
    const opsKeys = Object.keys(filterJson).filter((k) => k !== 'field');
    const isExplicitClause = opsKeys.some((k) =>
      ['op', 'value', '$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$exists', '$contains'].includes(k),
    );
    if (isExplicitClause) {
      if ('op' in filterJson && !String(filterJson.op || '').trim()) {
        return false;
      }
      const actual = lookupFilterValue(eventContext, filterJson.field);
      if (filterJson.op) {
        const opKey = String(filterJson.op).trim();
        if (!opKey || BLOCKED_PATH_SEGMENTS.has(opKey)) return false;
        return matchOperatorObject(actual, { [opKey]: filterJson.value });
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
  const isV2 = Number(payload.schemaVersion) === 2 || isPlainObject(payload.graphJson);
  let normalizedGraph = null;
  let normalizedDraft = null;
  if (payload.graphJson !== undefined && payload.graphJson !== null) {
    if (!isPlainObject(payload.graphJson)) {
      throw fail('FLOW_INVALID_GRAPH', 400, 'graphJson must be a plain object or null');
    }
    const gRes = validateFlowGraph(payload.graphJson, { nodeRegistry: flowRegistry, requireTrigger: true });
    if (!gRes.ok) {
      throw fail(gRes.errors[0]?.code || 'FLOW_INVALID_GRAPH', 400, gRes.errors[0]?.message || 'Invalid flow graph');
    }
    normalizedGraph = gRes.graph;
  }
  if (payload.draftGraphJson !== undefined && payload.draftGraphJson !== null) {
    if (!isPlainObject(payload.draftGraphJson)) {
      throw fail('FLOW_INVALID_GRAPH', 400, 'draftGraphJson must be a plain object or null');
    }
    const dRes = validateFlowGraph(payload.draftGraphJson, { nodeRegistry: flowRegistry, requireTrigger: false });
    if (!dRes.ok) {
      throw fail(dRes.errors[0]?.code || 'FLOW_INVALID_GRAPH', 400, dRes.errors[0]?.message || 'Invalid draft flow graph');
    }
    normalizedDraft = dRes.graph;
  }
  const compat = normalizedGraph
    ? graphV2SummaryToV1Compat({ ...payload, graphJson: normalizedGraph })
    : null;
  const triggerEventType = payload.triggerEventType !== undefined
    ? String(payload.triggerEventType || '*').trim() || '*'
    : (compat?.triggerEventType || '*');
  const rawActions = Array.isArray(payload.actionsJson) ? payload.actionsJson : [];
  const actionsJson = [];
  for (let i = 0; i < rawActions.length; i += 1) {
    const act = rawActions[i];
    if (!isPlainObject(act) || !VALID_ACTION_TYPES.has(String(act.type || '').trim())) {
      throw fail('INVALID_ACTION_TYPE', 400, `actionsJson[${i}].type must be a valid automation action`);
    }
    assertSafeFlowTemplate(act, `actionsJson[${i}]`);
    if (act.when !== undefined && act.when !== null) {
      if (!isPlainObject(act.when)) {
        throw fail('INVALID_ACTION_CONDITION', 400, `actionsJson[${i}].when must be a plain object or null`);
      }
      const whenRes = validateFilterStructure(act.when, `actionsJson[${i}].when`);
      if (!whenRes.ok) {
        throw fail(whenRes.code, 400, whenRes.message);
      }
    }
    if (act.label !== undefined && act.label !== null && typeof act.label !== 'string') {
      throw fail('INVALID_ACTION_LABEL', 400, `actionsJson[${i}].label must be a string`);
    }
    if (act.branchLabel !== undefined && act.branchLabel !== null && typeof act.branchLabel !== 'string') {
      throw fail('INVALID_ACTION_BRANCH_LABEL', 400, `actionsJson[${i}].branchLabel must be a string`);
    }
    if (act.stopOnError !== undefined && act.stopOnError !== null && typeof act.stopOnError !== 'boolean') {
      throw fail('INVALID_ACTION_STOP_ON_ERROR', 400, `actionsJson[${i}].stopOnError must be a boolean`);
    }
    const cleanAct = sanitizePlainObject(act);
    if (act.when === null || act.when === undefined) {
      if (act.when === null) cleanAct.when = null;
    } else {
      cleanAct.when = sanitizePlainObject(act.when);
    }
    if (typeof act.label === 'string') {
      cleanAct.label = act.label.trim().slice(0, 120);
    }
    if (typeof act.branchLabel === 'string') {
      cleanAct.branchLabel = act.branchLabel.trim().slice(0, 80);
    }
    if (typeof act.stopOnError === 'boolean') {
      cleanAct.stopOnError = act.stopOnError;
    }
    actionsJson.push(cleanAct);
  }
  const effectiveFilter = payload.filterJson !== undefined ? payload.filterJson : (compat?.filterJson ?? null);
  if (effectiveFilter !== undefined && effectiveFilter !== null) {
    const filterRes = validateFilterStructure(effectiveFilter, 'filterJson');
    if (!filterRes.ok) {
      throw fail(filterRes.code, 400, filterRes.message);
    }
  }
  const effectiveMaxDepthInput = payload.maxDepth !== undefined && payload.maxDepth !== null ? payload.maxDepth : (compat?.maxDepth ?? 8);
  const rawMaxDepth = Number(effectiveMaxDepthInput);
  if (!Number.isInteger(rawMaxDepth) || rawMaxDepth < 1 || rawMaxDepth > MAX_HARD_DEPTH) {
    throw fail('INVALID_MAX_DEPTH', 400, `maxDepth must be an integer between 1 and ${MAX_HARD_DEPTH}`);
  }
  const effectiveCooldownInput = payload.cooldownSec !== undefined && payload.cooldownSec !== null ? payload.cooldownSec : (compat?.cooldownSec ?? 0);
  const rawCooldown = Number(effectiveCooldownInput);
  if (!Number.isInteger(rawCooldown) || rawCooldown < 0) {
    throw fail('INVALID_COOLDOWN', 400, 'cooldownSec must be a non-negative integer');
  }
  const finalActions = actionsJson.length > 0 ? actionsJson : (compat?.actionsJson || []);
  return {
    ruleKey,
    name,
    description: payload.description ? String(payload.description) : null,
    triggerEventType,
    filterJson: effectiveFilter ? sanitizePlainObject(effectiveFilter) : null,
    dmnTableKey: payload.dmnTableKey !== undefined
      ? (payload.dmnTableKey ? String(payload.dmnTableKey).trim() : null)
      : (compat?.dmnTableKey || null),
    actionsJson: sanitizePlainObject(finalActions),
    maxDepth: rawMaxDepth,
    cooldownSec: rawCooldown,
    active: payload.active === undefined ? true : Boolean(payload.active),
    schemaVersion: isV2 ? 2 : 1,
    triggerIndexJson: normalizedGraph ? buildTriggerIndex(normalizedGraph, { triggerEventType }) : buildTriggerIndex(null, { triggerEventType }),
    ...(normalizedGraph ? { graphJson: normalizedGraph } : payload.graphJson === null ? { graphJson: null } : {}),
    ...(normalizedDraft ? { draftGraphJson: normalizedDraft } : payload.draftGraphJson === null ? { draftGraphJson: null } : {}),
    ...(payload.publishedVersion !== undefined ? { publishedVersion: Math.max(1, Number(payload.publishedVersion) || 1) } : {}),
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
  const secret = String(
    secrets?.secret || secrets?.signingSecret || secrets?.hmacSecret || secrets?.webhookSecret || secrets?.apiKey || '',
  );
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
      const baseDepth = eventContext?.depth !== undefined && eventContext?.depth !== null ? Number(eventContext.depth) : getOrmTriggerDepth();
      const nextDepth = (Number.isFinite(baseDepth) && baseDepth >= 0 ? baseDepth : 0) + 1;
      const created = await runWithOrmDepth(nextDepth, () => repo.create({ values }));
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
        const baseDepth = eventContext?.depth !== undefined && eventContext?.depth !== null ? Number(eventContext.depth) : getOrmTriggerDepth();
        const nextDepth = (Number.isFinite(baseDepth) && baseDepth >= 0 ? baseDepth : 0) + 1;
        await runWithOrmDepth(nextDepth, () => repo.update({ filter: scopedFilter, values }));
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
      const cleanCustom = sanitizeOutgoingHeaders(customHeaders, authHeaders, hmacHeaders);
      const headers = {
        Accept: 'application/json',
        ...(bodyPayload !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...cleanCustom,
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
      if (
        !targetCollection ||
        SYSTEM_PROTECTED_COLLECTIONS?.has(targetCollection) ||
        SENSITIVE_TARGET_COLLECTIONS.has(targetCollection) ||
        AUTOMATION_COLLECTIONS.includes(targetCollection) ||
        FORBIDDEN_TRIAGE_COLLECTIONS_LOWER.has(targetCollection.toLowerCase())
      ) {
        throw new Error(`TARGET_COLLECTION_FORBIDDEN: ${targetCollection || '(empty)'}`);
      }
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
  const authOrgId = resolveTrustedOrgId(options.organizationId, rule.organizationId, 'Rule belongs to another organization');
  const scopedOpts = authOrgId ? { ...options, organizationId: authOrgId } : options;
  if (
    Number(rule.schemaVersion) === 2
    || (rule.graphJson && Array.isArray(rule.graphJson.nodes) && rule.graphJson.nodes.length > 0)
    || (scopedOpts.useDraft && rule.draftGraphJson && Array.isArray(rule.draftGraphJson.nodes) && rule.draftGraphJson.nodes.length > 0)
  ) {
    return getFlowExecutor().executeFlowGraph(db, ruleRow, rawEvent, scopedOpts);
  }
  const organizationId = authOrgId;
  const event = normalizeIncomingEvent(rawEvent, organizationId);
  if (organizationId) {
    event.organizationId = organizationId;
    event.organizationid = organizationId;
  }
  const runUid = `run_${crypto.randomUUID()}`;
  const startedAt = new Date();
  const startMs = startedAt.getTime();
  const app = options.app || db?.app;

  const effectiveMaxDepth = Math.min(MAX_HARD_DEPTH, Math.max(1, Number(rule.maxDepth || MAX_HARD_DEPTH)));
  const depth = Number(event.depth || 0);
  const runsRepo = db.getRepository('latticeAutomationRuns');
  const rulesRepo = db.getRepository('latticeAutomationRules');

  return runAutomationWithRls(db, organizationId, async () => {
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
    steps: {},
    event: {
      id: event.id,
      type: event.type,
      source: event.source,
      subject: event.subject,
      time: event.time,
      organizationid: event.organizationid,
      organizationId: event.organizationId,
      correlationid: event.correlationid,
      causationid: event.causationid,
      depth: event.depth,
      data: event.data,
    },
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
    const simulatedSteps = [];
    for (let idx = 0; idx < actions.length; idx += 1) {
      const act = actions[idx] || {};
      const type = String(act.type || '');
      const label = typeof act.label === 'string' && act.label.trim() ? act.label.trim() : null;
      const branchLabel = typeof act.branchLabel === 'string' && act.branchLabel.trim() ? act.branchLabel.trim() : null;
      if (isPlainObject(act.when) && Object.getOwnPropertyNames(act.when).length > 0 && !matchesFilter(act.when, eventContext)) {
        eventContext.steps[idx] = { status: 'skipped', type, output: null };
        simulatedSteps.push({
          stepIndex: idx,
          type,
          ...(label ? { label } : {}),
          ...(branchLabel ? { branchLabel } : {}),
          status: 'skipped',
          skipReason: 'BRANCH_CONDITION_NOT_MATCHED',
          output: null,
          error: null,
          durationMs: 0,
        });
        continue;
      }
      const output = interpolateTemplate(act, eventContext);
      eventContext.steps[idx] = {
        ...(isPlainObject(output) ? output : {}),
        id: `sim_${idx + 1}`,
        status: 'simulated',
        type,
        output,
      };
      simulatedSteps.push({
        stepIndex: idx,
        type,
        ...(label ? { label } : {}),
        ...(branchLabel ? { branchLabel } : {}),
        status: 'simulated',
        output,
        error: null,
        durationMs: 0,
      });
    }
    return finalizeRun({
      status: 'completed',
      matched: true,
      dmnResultJson,
      stepTracesJson: simulatedSteps,
      errorMessage: null,
    });
  }

  const stepTraces = [];
  await runWithOrmDepth(depth + 1, async () => {
    for (let i = 0; i < actions.length; i += 1) {
      const act = actions[i] || {};
      const type = String(act.type || '').trim();
      const label = typeof act.label === 'string' && act.label.trim() ? act.label.trim() : null;
      const branchLabel = typeof act.branchLabel === 'string' && act.branchLabel.trim() ? act.branchLabel.trim() : null;

      if (isPlainObject(act.when) && Object.keys(act.when).length > 0 && !matchesFilter(act.when, eventContext)) {
        eventContext.steps[i] = { status: 'skipped', type, output: null };
        stepTraces.push({
          stepIndex: i,
          type,
          ...(label ? { label } : {}),
          ...(branchLabel ? { branchLabel } : {}),
          status: 'skipped',
          skipReason: 'BRANCH_CONDITION_NOT_MATCHED',
          output: null,
          error: null,
          durationMs: 0,
        });
        continue;
      }

      const trace = await executeActionStep({
        action: act,
        stepIndex: i,
        organizationId,
        eventContext,
        rule,
        db,
        app,
        options,
      });
      if (label) trace.label = label;
      if (branchLabel) trace.branchLabel = branchLabel;
      stepTraces.push(trace);
      eventContext.steps[i] = {
        ...(isPlainObject(trace.output) ? trace.output : {}),
        status: trace.status,
        type: trace.type,
        output: trace.output,
      };
      if (trace.status === 'failed' && act.stopOnError === true) {
        break;
      }
    }
  });

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
  });
}

async function handleDomainEvent(db, cloudEvent, options = {}) {
  const evt = normalizeIncomingEvent(cloudEvent);
  if (!evt.organizationId) return [];
  const rulesRepo = db.getRepository('latticeAutomationRules');
  if (!rulesRepo) return [];
  return runAutomationWithRls(db, evt.organizationId, async () => {
    const rows = await rulesRepo.find({
      filter: { organizationId: evt.organizationId, active: true },
      limit: 500,
    });
    const candidates = (Array.isArray(rows) ? rows : []).filter((row) => {
      const p = toPlain(row) || {};
      const trigIdx = Array.isArray(p.triggerIndexJson) && p.triggerIndexJson.length
        ? p.triggerIndexJson
        : (p.graphJson?.nodes?.length ? buildTriggerIndex(p.graphJson, p) : []);
      if (trigIdx.length > 0 && trigIdx.every((t) => t?.triggerType === 'webhook')) return false;
      return matchesEventPatternLocal(val(row, 'triggerEventType') || '*', evt.type);
    });
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
  });
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
    const targetDb = meta.db || db;
    const orgId = String(cloudEvent?.organizationId || cloudEvent?.organizationid || cloudEvent?.data?.organizationId || '').trim();
    await runAutomationWithRls(targetDb, orgId, () => handleDomainEvent(targetDb, cloudEvent, {
      ...options,
      app: meta.app || app,
    }));
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

function registerRecordTriggerHooks(app, db, options = {}) {
  if (!db || typeof db.on !== 'function') return { stop() {} };
  let active = true;
  const attached = [];
  const hookedCollections = new Set();

  const attachForCollection = (colName) => {
    const col = String(colName || '').trim();
    if (!col || hookedCollections.has(col) || !isAllowlistedTargetCollection(col)) return;
    hookedCollections.add(col);
    for (const [hookName, op] of [['afterCreate', 'create'], ['afterUpdate', 'update'], ['afterDestroy', 'delete']]) {
      const evName = `${col}.${hookName}`;
      const fn = async (model, hookOpts = {}) => {
        if (!active || hookOpts?.skipFlowTrigger) return;
        const record = toPlain(model) || {};
        const orgId = String(record.organizationId || hookOpts?.organizationId || '').trim();
        if (!orgId) return;
        const targetDb = hookOpts?.db || db;
        const depth = getOrmTriggerDepth(hookOpts);
        try {
          await runAutomationWithRls(targetDb, orgId, () => getFlowExecutor().dispatchRecordTriggerEvent(
            targetDb,
            { collection: col, operation: op, organizationId: orgId, recordId: val(model, 'id') ?? record.id ?? null, record, data: record, depth },
            { ...options, app: hookOpts?.app || app },
          ));
        } catch (err) {
          app?.logger?.error?.('[dxosFlow] Record hook dispatch failed', { collection: col, operation: op, error: err?.message || String(err) });
        }
      };
      db.on(evName, fn);
      attached.push({ event: evName, fn });
    }
  };

  for (const col of ALLOWLISTED_BUSINESS_COLLECTIONS) attachForCollection(col);
  if (db.collections && typeof db.collections.keys === 'function') {
    for (const col of db.collections.keys()) attachForCollection(col);
  }
  const onColLoaded = (evt) => attachForCollection(evt?.collection?.name || evt?.name);
  db.on('collection:loaded', onColLoaded);
  attached.push({ event: 'collection:loaded', fn: onColLoaded });

  return {
    stop() {
      if (!active) return;
      active = false;
      for (const { event, fn } of attached) {
        if (typeof db.off === 'function') db.off(event, fn);
        else if (typeof db.removeListener === 'function') db.removeListener(event, fn);
      }
    },
  };
}

function appendStepViaFlowGraph({ targetRule, targetGraph, prompt, sampleEvent }) {
  const rawG = isPlainObject(targetGraph) && Array.isArray(targetGraph.nodes)
    ? targetGraph
    : isPlainObject(targetRule?.graphJson) && Array.isArray(targetRule.graphJson.nodes)
      ? targetRule.graphJson
      : isPlainObject(targetRule?.draftGraphJson) && Array.isArray(targetRule.draftGraphJson.nodes)
        ? targetRule.draftGraphJson
        : null;
  const baseGraph = rawG ? normalizeGraph(cloneSafe(rawG)) : isPlainObject(targetRule) ? v1RuleToGraphV2(targetRule) : null;
  if (!baseGraph?.nodes?.length) return null;

  const sourcesWithOut = new Set(baseGraph.edges.map((e) => e.source));
  const tailNode = [...baseGraph.nodes].reverse().find((n) => !String(n.type || '').startsWith('trigger.') && !sourcesWithOut.has(n.id))
    || baseGraph.nodes[baseGraph.nodes.length - 1];
  const tailPort = tailNode.type === 'control.if'
    ? 'true'
    : tailNode.type === 'control.approval'
      ? 'approved'
      : tailNode.type === 'control.loop'
        ? 'done'
        : 'main';

  let stepIdx = baseGraph.nodes.filter((n) => /^step_\d+$/.test(n.id) || Number.isInteger(n.config?.stepIndex)).length;
  while (baseGraph.nodes.some((n) => n.id === `step_${stepIdx}`)) stepIdx += 1;
  const newId = `step_${stepIdx}`;
  const cleanPrompt = String(prompt || '').trim();
  const normPrompt = cleanPrompt.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();
  const roleMatch = cleanPrompt.match(/\bldx_[a-z0-9_]{2,40}\b/i);
  const pickedRole = roleMatch ? roleMatch[0].toLowerCase() : 'ldx_operator';

  let newNode;
  if (/\btriage\b|\bai\b|\bproposal\b/.test(normPrompt)) {
    newNode = {
      id: newId,
      type: 'ai.agent',
      label: 'AI Triage',
      config: {
        stepIndex: stepIdx,
        targetCollection: 'latticeAssets',
        severity: 'high',
        recommendation: cleanPrompt.slice(0, 160) || 'AI triage proposal',
      },
    };
  } else if (/\bupdate\b|cap nhat/.test(normPrompt)) {
    newNode = {
      id: newId,
      type: 'data.update',
      label: 'Update Record',
      config: {
        stepIndex: stepIdx,
        collection: 'latticeServiceTickets',
        recordId: '{{data.id}}',
        filter: { id: '{{data.id}}' },
        values: { status: 'processed' },
      },
    };
  } else if (/\bcreate\b|\btao\b/.test(normPrompt)) {
    newNode = {
      id: newId,
      type: 'data.create',
      label: 'Create Record',
      config: {
        stepIndex: stepIdx,
        collection: 'latticeServiceTickets',
        values: { code: 'FLOW-{{id}}', name: cleanPrompt.slice(0, 80) || 'Flow Record' },
      },
    };
  } else {
    newNode = {
      id: newId,
      type: 'notify.send',
      label: `Notify ${pickedRole}`,
      config: {
        stepIndex: stepIdx,
        roleNames: [pickedRole],
        severity: 'info',
        title: cleanPrompt.slice(0, 120) || 'Flow Notification',
      },
    };
  }

  const applied = applyGraphOperations(baseGraph, [
    { op: 'add_node', node: newNode },
    { op: 'connect_edge', edge: { source: tailNode.id, sourceHandle: tailPort, target: newId, targetHandle: 'in' } },
  ]);
  const check = validateFlowGraph(applied.graph, { nodeRegistry: flowRegistry, requireTrigger: true });
  if (!check.ok) return null;

  const trigIdx = buildTriggerIndex(applied.graph, targetRule);
  const compat = graphV2SummaryToV1Compat({ ...(isPlainObject(targetRule) ? targetRule : {}), graphJson: applied.graph });
  const draftRule = {
    schemaVersion: 2,
    ruleKey: String(targetRule?.ruleKey || 'flow_rule').trim(),
    name: String(targetRule?.name || 'Automated Flow').trim().slice(0, 120),
    description: targetRule?.description ? String(targetRule.description) : 'DX-OS Flow Architect draft',
    triggerEventType: compat.triggerEventType || trigIdx[0]?.eventType || '*',
    triggerIndexJson: trigIdx,
    graphJson: applied.graph,
    ...compat,
    active: targetRule?.active !== undefined ? Boolean(targetRule.active) : true,
  };
  return {
    ok: true,
    refused: false,
    mode: 'node',
    modeUsed: 'offline-fallback',
    repairAttempts: 0,
    targetNode: 'step:append',
    summary: `Appended node "${newId}" (${newNode.type}) to flow.`,
    graphDiff: applied.graphDiff,
    draftGraph: applied.graph,
    draftRule,
    sampleEvent: isPlainObject(sampleEvent) ? cloneSafe(sampleEvent) : null,
    suggestions: [],
  };
}

function sanitizeRunRecord(row) {
  const plain = toPlain(row);
  if (!plain) return plain;
  delete plain.resumeTokenHash;
  delete plain.resumeToken;
  return plain;
}

function createDxosAutomationsActions(db, options = {}) {
  const foundation = options.foundation || loadFoundationSet();

  async function requireOrgRoles(ctx, params, { mutating = false, requireManagerOrAdmin = mutating, allowedPatScopes = null } = {}) {
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
    if (requireManagerOrAdmin && !hasAnyRole(roles, MUTATING_ROLES) && !orgAdmin) {
      throw fail('FORBIDDEN', 403, 'Manager or admin role required for automation changes');
    }
    return { organizationId, actor, roles };
  }

  async function upsertAutomationRule(organizationId, validated, actor) {
    const repo = db.getRepository('latticeAutomationRules');
    if (!repo) throw fail('REPOSITORY_UNAVAILABLE', 500, 'latticeAutomationRules repository is not registered');
    const existing = await repo.findOne({ filter: { organizationId, ruleKey: validated.ruleKey } });
    if (existing) {
      const nextValues = { ...validated };
      if (validated.schemaVersion === 2 && isPlainObject(validated.graphJson) && validated.publishedVersion === undefined) {
        nextValues.publishedVersion = Math.max(1, Number(val(existing, 'publishedVersion') || 1) + 1);
      }
      if (!isPlainObject(validated.graphJson) && validated.graphJson !== null && isPlainObject(val(existing, 'graphJson'))) {
        delete nextValues.triggerIndexJson;
      }
      await repo.update({
        filter: { organizationId, ruleKey: validated.ruleKey },
        values: nextValues,
      });
      return repo.findOne({ filter: { organizationId, ruleKey: validated.ruleKey } });
    }
    return repo.create({
      values: {
        ...validated,
        organizationId,
        createdBy: actor?.username ? String(actor.username) : null,
      },
    });
  }

  return {
    async listRules(ctx, next) {
      const params = readParams(ctx);
      assertAutomationPatScope(ctx, ['read', 'write', 'ai', 'iot'], foundation);
      const { organizationId } = await requireOrgRoles(ctx, params, { mutating: false });
      const rows = await runAutomationWithRls(db, organizationId, () => {
        const repo = db.getRepository('latticeAutomationRules');
        const filter = { organizationId };
        if (params.active !== undefined) filter.active = params.active === true || params.active === 'true';
        if (params.triggerEventType) filter.triggerEventType = String(params.triggerEventType);
        const limit = clampPageLimit(params.limit ?? params.pageSize);
        const rawOffset = Number(params.offset);
        const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0;
        return repo ? repo.find({ filter, sort: ['-updatedAt', '-id'], limit, offset }) : [];
      });
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
      const saved = await runAutomationWithRls(db, organizationId, () => upsertAutomationRule(organizationId, validated, actor));
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
      const updated = await runAutomationWithRls(db, organizationId, async () => {
        const repo = db.getRepository('latticeAutomationRules');
        const existing = repo ? await repo.findOne({ filter: { organizationId, ruleKey } }) : null;
        if (!existing) throw fail('RULE_NOT_FOUND', 404, `Automation rule ${ruleKey} not found`);
        const nextActive = params.active !== undefined ? Boolean(params.active) : !Boolean(val(existing, 'active'));
        await repo.update({ filter: { organizationId, ruleKey }, values: { active: nextActive } });
        return repo.findOne({ filter: { organizationId, ruleKey } });
      });
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
      await runAutomationWithRls(db, organizationId, async () => {
        const repo = db.getRepository('latticeAutomationRules');
        const existing = repo ? await repo.findOne({ filter: { organizationId, ruleKey } }) : null;
        if (!existing) throw fail('RULE_NOT_FOUND', 404, `Automation rule ${ruleKey} not found`);
        await repo.destroy({ filter: { organizationId, ruleKey } });
      });
      ctx.body = { deleted: true, ruleKey };
      return next();
    },

    async testRule(ctx, next) {
      const params = readParams(ctx);
      assertAutomationPatScope(ctx, ['read', 'write', 'ai', 'iot'], foundation);
      const { organizationId, actor } = await requireOrgRoles(ctx, params, { mutating: false });
      const simulation = await runAutomationWithRls(db, organizationId, async () => {
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
        const rawEvent = params.event || params.sampleEvent || params.context || params.data || params.payload || {};
        const scopedEvent = isPlainObject(rawEvent)
          ? { ...sanitizePlainObject(rawEvent), organizationId, organizationid: organizationId }
          : rawEvent;
        return executeRuleAgainstEvent(db, ruleObj, scopedEvent, {
          ...options,
          organizationId,
          app: ctx?.app || db?.app,
          actor,
          dryRun: true,
          ignoreCooldown: true,
          useDraft: Boolean(params.useDraft),
        });
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
      const run = await runAutomationWithRls(db, organizationId, async () => {
        const repo = db.getRepository('latticeAutomationRules');
        const ruleRow = repo ? await repo.findOne({ filter: { organizationId, ruleKey } }) : null;
        if (!ruleRow) throw fail('RULE_NOT_FOUND', 404, `Automation rule ${ruleKey} not found`);
        const defaultEventType = String(val(ruleRow, 'triggerEventType') || 'manual.trigger').split(',')[0].trim() || 'manual.trigger';
        const baseEventPayload = isPlainObject(params.event)
          ? sanitizePlainObject(params.event)
          : isPlainObject(params.sampleEvent)
            ? sanitizePlainObject(params.sampleEvent)
            : {
                id: params.eventId,
                type: params.eventType || defaultEventType,
                source: params.source || 'dxos-studio:manual',
                subject: params.subject,
                depth: params.depth ?? 0,
                data: params.data || params.context || params.payload || {},
              };
        const eventPayload = { ...baseEventPayload, organizationId, organizationid: organizationId };
        return executeRuleAgainstEvent(db, ruleRow, eventPayload, {
          ...options,
          organizationId,
          app: ctx?.app || db?.app,
          actor,
          ignoreCooldown: params.ignoreCooldown !== false,
        });
      });
      ctx.body = { run };
      return next();
    },

    async listRuns(ctx, next) {
      const params = readParams(ctx);
      assertAutomationPatScope(ctx, ['read', 'write', 'ai', 'iot'], foundation);
      const { organizationId } = await requireOrgRoles(ctx, params, { mutating: false });
      const rows = await runAutomationWithRls(db, organizationId, () => {
        const repo = db.getRepository('latticeAutomationRuns');
        const filter = { organizationId };
        if (params.ruleKey) filter.ruleKey = String(params.ruleKey).trim();
        if (params.status) filter.status = String(params.status).trim();
        const limit = clampPageLimit(params.limit ?? params.pageSize);
        const rawOffset = Number(params.offset);
        const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0;
        return repo ? repo.find({ filter, sort: ['-startedAt', '-id'], limit, offset }) : [];
      });
      ctx.body = { items: (Array.isArray(rows) ? rows : []).map(sanitizeRunRecord) };
      return next();
    },

    async getRunTrace(ctx, next) {
      const params = readParams(ctx);
      assertAutomationPatScope(ctx, ['read', 'write', 'ai', 'iot'], foundation);
      const { organizationId } = await requireOrgRoles(ctx, params, { mutating: false });
      const runUid = params.runUid ? String(params.runUid).trim() : null;
      const filter = runUid ? { organizationId, runUid } : { organizationId, id: params.id };
      if (!runUid && params.id === undefined) {
        throw fail('MISSING_RUN_ID', 400, 'runUid or id is required');
      }
      const row = await runAutomationWithRls(db, organizationId, () => {
        const repo = db.getRepository('latticeAutomationRuns');
        return repo ? repo.findOne({ filter }) : null;
      });
      if (!row) throw fail('RUN_NOT_FOUND', 404, 'Automation run not found');
      ctx.body = { run: sanitizeRunRecord(row) };
      return next();
    },

    async replayRun(ctx, next) {
      const params = readParams(ctx);
      const { organizationId, actor } = await requireOrgRoles(ctx, params, {
        mutating: true,
        allowedPatScopes: ['write', 'ai', 'iot'],
      });
      const runUid = params.runUid ? String(params.runUid).trim() : null;
      const runFilter = runUid ? { organizationId, runUid } : { organizationId, id: params.id };
      if (!runUid && params.id === undefined) {
        throw fail('MISSING_RUN_ID', 400, 'runUid or id is required');
      }
      const { replay, orig } = await runAutomationWithRls(db, organizationId, async () => {
        const runsRepo = db.getRepository('latticeAutomationRuns');
        const rulesRepo = db.getRepository('latticeAutomationRules');
        const origRow = runsRepo ? await runsRepo.findOne({ filter: runFilter }) : null;
        if (!origRow) throw fail('RUN_NOT_FOUND', 404, 'Automation run not found');
        const origRun = toPlain(origRow);
        const ruleRow = rulesRepo ? await rulesRepo.findOne({ filter: { organizationId, ruleKey: origRun.ruleKey } }) : null;
        if (!ruleRow) throw fail('RULE_NOT_FOUND', 404, `Automation rule ${origRun.ruleKey} not found`);
        let eventEnvelope = params.event ? normalizeIncomingEvent(params.event, organizationId) : null;
        if (!eventEnvelope && origRun.triggerEventId) {
          const busRepo = db.getRepository('latticeEventBus');
          const busRow = busRepo ? await busRepo.findOne({ filter: { organizationId, eventId: origRun.triggerEventId } }) : null;
          if (busRow) eventEnvelope = normalizeIncomingEvent(toPlain(busRow).payloadJson || {}, organizationId);
        }
        if (!eventEnvelope && origRun.runUid && recentRunEventSnapshots.has(origRun.runUid)) {
          eventEnvelope = { ...recentRunEventSnapshots.get(origRun.runUid) };
        }
        if (!eventEnvelope) {
          eventEnvelope = normalizeIncomingEvent({ id: origRun.triggerEventId, type: origRun.triggerEventType, organizationId, data: params.data || {} }, organizationId);
        }
        eventEnvelope.organizationId = organizationId;
        eventEnvelope.organizationid = organizationId;
        eventEnvelope.depth = Number(origRun.depth || 0) + 1;
        const rep = await executeRuleAgainstEvent(db, ruleRow, eventEnvelope, {
          ...options, organizationId, app: ctx?.app || db?.app, actor, ignoreCooldown: true,
        });
        return { replay: rep, orig: origRun };
      });
      ctx.body = { run: replay, replayedFromRunUid: orig.runUid };
      return next();
    },

    async builderCatalog(ctx, next) {
      const params = readParams(ctx);
      assertAutomationPatScope(ctx, ['read', 'write', 'ai', 'iot'], foundation);
      const { organizationId } = await requireOrgRoles(ctx, params, { mutating: false, requireManagerOrAdmin: true });
      ctx.body = await runAutomationWithRls(db, organizationId, () => buildFlowStudioCatalog(db, organizationId, { env: options.env || process.env }));
      return next();
    },

    async aiAssist(ctx, next) {
      const params = readParams(ctx);
      const { organizationId, actor } = await requireOrgRoles(ctx, params, {
        mutating: true,
        allowedPatScopes: ['write', 'ai', 'iot'],
      });
      const body = await runAutomationWithRls(db, organizationId, async () => {
        const rulesRepo = db.getRepository('latticeAutomationRules');
        const runsRepo = db.getRepository('latticeAutomationRuns');
        const requestedMode = String(params.mode || '').trim().toLowerCase();
        let targetRule = params.rule !== undefined ? params.rule : null;
        const targetGraph = params.graph !== undefined ? params.graph : params.graphJson;
        const requestedRuleKey = String(params.ruleKey || params.automationCode || '').trim();
        if (targetRule === null && requestedRuleKey && rulesRepo) {
          const found = await rulesRepo.findOne({ filter: { organizationId, ruleKey: requestedRuleKey } });
          if (found) targetRule = toPlain(found);
          else if (requestedMode === 'node') throw fail('RULE_NOT_FOUND', 404, `Automation rule ${requestedRuleKey} not found`);
        }

        let runTrace = params.runTrace !== undefined ? params.runTrace : null;
        const requestedRunUid = String(params.runUid || (isPlainObject(runTrace) ? runTrace.runUid : '') || '').trim();
        if ((runTrace === null || (isPlainObject(runTrace) && !runTrace.nodeStatesJson && !runTrace.stepTracesJson)) && requestedRunUid) {
          const foundRun = runsRepo ? await runsRepo.findOne({ filter: { organizationId, runUid: requestedRunUid } }) : null;
          if (!foundRun) throw fail('RUN_NOT_FOUND', 404, `Automation run ${requestedRunUid} not found`);
          const plainRun = toPlain(foundRun);
          runTrace = isPlainObject(runTrace) ? { ...plainRun, ...runTrace } : plainRun;
        }
        if (targetRule === null && !isPlainObject(targetGraph) && runTrace?.ruleKey && rulesRepo) {
          const traceRule = await rulesRepo.findOne({ filter: { organizationId, ruleKey: String(runTrace.ruleKey).trim() } });
          if (traceRule) targetRule = toPlain(traceRule);
        }

        const rawTarget = String(params.targetNodeId || params.targetNode || '').trim();
        let result = await runFlowArchitect({
          db,
          env: options.env || process.env,
          mode: params.mode,
          prompt: params.prompt,
          rule: targetRule,
          ...(requestedRuleKey ? { ruleKey: requestedRuleKey } : {}),
          graph: targetGraph,
          targetNodeId: params.targetNodeId,
          targetNode: params.targetNode,
          runTrace,
          organizationId,
          fetchImpl: options.fetchImpl,
          lookupImpl: options.lookupImpl,
          ...(params.sampleEvent !== undefined ? { sampleEvent: params.sampleEvent } : {}),
        });
        if (
          result?.refused
          && requestedMode === 'node'
          && ['step:append', 'actions', 'step:new'].includes(rawTarget.toLowerCase())
          && /Target node "(?:step:append|actions|step:new)" not found/i.test(String(result.error || ''))
        ) {
          const appended = appendStepViaFlowGraph({ targetRule, targetGraph, prompt: params.prompt, sampleEvent: params.sampleEvent });
          if (appended) result = appended;
        }
        if (result?.refused) throw fail('AI_ASSIST_REFUSED', 400, result.error || 'Flow Architect request refused');

        if (params.apply === true && result.draftRule) {
          const validated = validateRulePayload(result.draftRule);
          const saved = await upsertAutomationRule(organizationId, validated, actor);
          return { ...result, applied: true, savedRule: toPlain(saved) };
        }
        return { ...result, applied: false };
      });
      ctx.body = body;
      return next();
    },

    async nodeRegistry(ctx, next) {
      const params = readParams(ctx);
      assertAutomationPatScope(ctx, ['read', 'write', 'ai', 'iot'], foundation);
      await requireOrgRoles(ctx, params, { mutating: false });
      ctx.body = { nodeTypes: flowRegistry.listNodeSchemas() };
      return next();
    },

    async testNode(ctx, next) {
      const params = readParams(ctx);
      const isLive = params.live === true || params.dryRun === false;
      const { organizationId, actor } = await requireOrgRoles(ctx, params, {
        mutating: isLive,
        allowedPatScopes: isLive ? ['write', 'ai', 'iot'] : ['read', 'write', 'ai', 'iot'],
      });
      const result = await runAutomationWithRls(db, organizationId, async () => {
        let ruleObj = isPlainObject(params.rule) ? { ...sanitizePlainObject(params.rule), organizationId } : null;
        const inlineGraph = isPlainObject(params.graph)
          ? { ...sanitizePlainObject(params.graph), organizationId }
          : (isPlainObject(params.graphJson) ? { ...sanitizePlainObject(params.graphJson), organizationId } : null);
        if (!inlineGraph && !ruleObj && (params.ruleKey || params.automationCode)) {
          const key = String(params.ruleKey || params.automationCode).trim();
          const found = await db.getRepository('latticeAutomationRules')?.findOne({ filter: { organizationId, ruleKey: key } });
          if (!found) throw fail('RULE_NOT_FOUND', 404, `Automation rule ${key} not found`);
          ruleObj = toPlain(found);
        }
        return getFlowExecutor().testSingleFlowNode(db, {
          graph: inlineGraph,
          rule: ruleObj,
          nodeId: params.nodeId,
          pinnedInputs: params.pinnedInputs || params.input || {},
          organizationId,
          actor,
          options: { ...options, organizationId, app: ctx?.app || db?.app, dryRun: !isLive, live: isLive, useDraft: Boolean(params.useDraft) },
        });
      });
      ctx.body = { result };
      return next();
    },

    async resumeRun(ctx, next) {
      const params = readParams(ctx);
      const { organizationId, actor } = await requireOrgRoles(ctx, params, {
        mutating: true,
        allowedPatScopes: ['write', 'ai', 'iot'],
      });
      const run = await getFlowExecutor().resumeFlowRun(db, {
        organizationId,
        runUid: params.runUid,
        decision: params.decision || 'approved',
        payload: isPlainObject(params.payload) ? params.payload : {},
        resumeToken: params.resumeToken,
        actor,
        dryRun: Boolean(params.dryRun),
        options: { ...options, app: ctx?.app || db?.app },
      });
      ctx.body = { run };
      return next();
    },

    async webhookIngress(ctx, next) {
      const params = readParams(ctx);
      const headers = ctx?.request?.headers || ctx?.headers || {};
      const organizationId = String(params.organizationId || params.orgId || headers['x-organization-id'] || '').trim();
      const ruleKey = String(params.ruleKey || params.automationCode || '').trim();
      const rawBody = ctx?.request?.rawBody ?? (typeof ctx?.request?.body === 'string' || Buffer.isBuffer(ctx?.request?.body) ? ctx.request.body : undefined);
      const parsedBody = isPlainObject(ctx?.request?.body) ? ctx.request.body : undefined;
      const res = await runAutomationWithRls(db, organizationId, () => getFlowExecutor().dispatchWebhookIngress(db, {
        organizationId,
        ruleKey,
        headers,
        rawBody,
        parsedBody,
        options: { ...options, app: ctx?.app || db?.app },
      }));
      ctx.body = { ok: true, run: { runUid: res.runUid, status: res.status } };
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
  buildFallbackAuthHeaders,
  buildHmacHeaders,
  createAutomationDirectGuardMiddleware,
  createDxosAutomationsActions,
  executeRuleAgainstEvent,
  getSafePath,
  handleDomainEvent,
  hasUnsafeTemplateSyntax,
  interpolateTemplate,
  isAllowlistedTargetCollection,
  loadCrossPluginModules,
  matchesFilter,
  normalizeIncomingEvent,
  registerAutomationEventListener,
  registerRecordTriggerHooks,
  sanitizeAutomationWriteValues,
  sanitizePlainObject,
  scrubSecrets,
  validateRulePayload,
};
