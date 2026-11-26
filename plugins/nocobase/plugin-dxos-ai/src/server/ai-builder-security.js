/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const path = require('node:path');
const { publishSurfaceUpdate } = require('./surface-events');

const FORBIDDEN_AUTOMATION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const AUTOMATION_RULE_KEY_RE = /^[a-zA-Z0-9_.:-]{1,64}$/;
const SAFE_SAVE_RULE_KEY_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/;
const VALID_AUTOMATION_ACTION_TYPES = new Set([
  'create_record',
  'update_record',
  'notify_role',
  'call_connector',
  'twin_set_desired',
  'trigger_ai_triage',
]);
const ALLOWLISTED_AUTOMATION_COLLECTIONS = new Set([
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
const SENSITIVE_AUTOMATION_COLLECTIONS = new Set([
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
  'latticeAutomationRules',
  'latticeAutomationRuns',
  'latticeAiQuotaPolicies',
]);
const AUTOMATION_CUSTOM_COLLECTION_RE = /^latticeCustom[A-Z][A-Za-z0-9]{1,40}$/;
const AUTOMATION_CORE_VOUCHERS = new Set(['latticeRequests', 'latticeOrders', 'latticeServiceTickets']);
const AUTOMATION_PROTECTED_VOUCHER_FIELDS = new Set([
  'id', 'status', 'version', 'amendedFromId', 'amendmentNo',
  'submittedAt', 'submittedBy', 'cancelledAt', 'cancelledBy', 'cancelReason',
]);
const AUTOMATION_INJECTION_RE = /(?:__proto__|constructor\s*\.\s*prototype|\bprototype\b|process\.env|\.env\b|encryptedsecretsjson|ignore\s+(?:all\s+)?previous|bo\s+qua\s+(?:tat\s+ca|moi)?\s*(?:huong\s+dan|kiem\s+tra|quyen|rbac|acl|bao\s+mat)|system\s+prompt|jailbreak|bypass\s+(?:rbac|acl|auth|hitl|quyen|bao\s+mat)|drop\s+table|truncate\s+table|delete\s+from|union\s+select|api_?key|secret_?key|private_?key|mat\s+khau|in\s+ra\s+[^\n]{0,30}?(?:token|secret|password|key)|tiet\s+lo\s+[^\n]{0,30}?(?:token|secret|password|key))/i;
const AUTOMATION_SYSTEM_TABLE_RE = /(?:\b(?:users|rolesUsers|apiKeys|authenticators|migrations|applicationPlugins|aiSettings|aiEmployees|aiMcpClients|rolesAiEmployees|dataSourcesRoles|dataSourcesRolesResources|dataSourcesRolesResourcesActions|dataSourcesRolesResourcesScopes|latticeAiAuditLogs|latticeAiProfiles|latticeAiQuotaUsage|latticeAiQuotaPolicies|latticeAiApprovalQueue|latticeUiSnapshots|latticePkiKeys|latticeCryptoLedger|latticeConnectors|latticeWebhookSubscriptions|latticeWebhookDeliveries|latticeEventBus|latticeApiKeys|latticeDelegations|latticeEpodRecords|latticeOrganizations|latticeAutomationRules|latticeAutomationRuns)\b|(?:bang|table|collection|ghi\s+vao|sua|xoa|cap\s+nhat|drop|truncate)\s+roles\b)/i;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stripDiacriticsSimple(input) {
  return String(input || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

function sanitizeAutomationValue(value, seen = new WeakSet()) {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeAutomationValue(item, seen));
  if (value instanceof Date) return new Date(value.getTime());
  const out = {};
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_AUTOMATION_KEYS.has(key)) continue;
    out[key] = sanitizeAutomationValue(value[key], seen);
  }
  return out;
}

let lastFlowSyncRevision = 0;

function nextFlowSyncRevision() {
  const n = Math.max(lastFlowSyncRevision + 1, Date.now());
  lastFlowSyncRevision = n;
  return n;
}

const FLOW_SYNC_SENSITIVE_KEYS = new Set([
  'resumetoken',
  'resumetokenhash',
  'apikey',
  'api_key',
  'secret',
  'secrets',
  'secretkey',
  'secret_key',
  'encryptedsecrets',
  'encryptedsecretsjson',
  'password',
  'passphrase',
  'token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'clientsecret',
  'client_secret',
  'privatekey',
  'private_key',
  'authorization',
  'bearer',
  'cookie',
  'credential',
  'credentials',
  'jwt',
  'webhooksecret',
  'webhook_secret',
]);
const FLOW_SYNC_SENSITIVE_KEY_RE = /(?:secret(?:[_-]?(?:key|value))?|token(?:hash)?|password|api[_-]?key|private[_-]?key|passphrase|authorization|credential)$/i;

function isFlowSyncSensitiveKey(key) {
  const lower = String(key || '').toLowerCase();
  if (!lower) return false;
  if (FLOW_SYNC_SENSITIVE_KEYS.has(lower)) return true;
  if (lower === 'secretheader' || lower === 'prompttokens' || lower === 'completiontokens' || lower === 'totaltokens') {
    return false;
  }
  return FLOW_SYNC_SENSITIVE_KEY_RE.test(lower);
}

function scrubFlowSyncPayload(value, seen = new WeakSet()) {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map((item) => scrubFlowSyncPayload(item, seen));
  const plain = typeof value.toJSON === 'function' ? value.toJSON() : value;
  if (!plain || typeof plain !== 'object') return plain;
  if (plain !== value) {
    if (seen.has(plain)) return undefined;
    seen.add(plain);
  }
  const out = {};
  for (const key of Object.keys(plain)) {
    if (FORBIDDEN_AUTOMATION_KEYS.has(key) || isFlowSyncSensitiveKey(key)) continue;
    out[key] = scrubFlowSyncPayload(plain[key], seen);
  }
  return out;
}

function publishFlowStudioUpdate(actor, detail = {}) {
  if (!actor?.organizationId) return;
  publishSurfaceUpdate('flow-studio', {
    revision: nextFlowSyncRevision(),
    type: 'flow-updated',
    organizationId: String(actor.organizationId),
    operation: detail.operation || '',
    ruleKey: detail.ruleKey || null,
    applied: Boolean(detail.applied),
    ...(detail.draftRule ? { draftRule: scrubFlowSyncPayload(detail.draftRule) } : {}),
    ...(detail.draftGraph ? { draftGraph: scrubFlowSyncPayload(detail.draftGraph) } : {}),
    ...(detail.simulation ? { simulation: scrubFlowSyncPayload(detail.simulation) } : {}),
    ...(detail.run ? { run: scrubFlowSyncPayload(detail.run) } : {}),
    message: String(detail.message || '').slice(0, 240),
  });
}

function publishPatchAutomationUpdate(actor, result) {
  const effectiveRule = result.rule || result.draftRule || null;
  publishFlowStudioUpdate(actor, {
    operation: 'patchAutomation',
    ruleKey: result.ruleKey || effectiveRule?.ruleKey || null,
    applied: result.applied,
    draftRule: effectiveRule,
    draftGraph: effectiveRule?.graphJson || result.draftGraph || null,
    message: result.diffSummary || 'Đã cập nhật node qua AI Architect.',
  });
  return result;
}

function hasForbiddenProtoKeys(value, seen = new WeakSet()) {
  if (value === null || value === undefined || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => hasForbiddenProtoKeys(item, seen));
  for (const key of Object.getOwnPropertyNames(value)) {
    if (FORBIDDEN_AUTOMATION_KEYS.has(key)) return true;
    if (hasForbiddenProtoKeys(value[key], seen)) return true;
  }
  return false;
}

const UNSAFE_TEMPLATE_PATH_SEGMENTS = new Set([
  '__proto__', 'constructor', 'prototype', 'process', 'env', 'global', 'globalThis',
]);
const UNSAFE_TEMPLATE_EXPRESSION_RE = /(?:__proto__|constructor\s*\.\s*prototype|\bprocess\s*\.\s*env\b|require\s*\(|eval\s*\(|Function\s*\(|child_process)/i;

function hasUnsafeAutomationTemplateString(str) {
  if (!str) return false;
  if (str.includes('`') || str.includes('${')) return true;
  if (UNSAFE_TEMPLATE_EXPRESSION_RE.test(str)) return true;
  let pos = 0;
  while (pos < str.length) {
    const openIdx = str.indexOf('{{', pos);
    const strayCloseIdx = str.indexOf('}}', pos);
    if (openIdx === -1) return strayCloseIdx !== -1;
    if (strayCloseIdx !== -1 && strayCloseIdx < openIdx) return true;
    const closeIdx = str.indexOf('}}', openIdx + 2);
    if (closeIdx === -1) return true;
    const inner = str.slice(openIdx + 2, closeIdx);
    if (inner.includes('{{')) return true;
    const expr = inner.trim();
    if (!expr || !/^[a-zA-Z0-9_.\-$]+$/.test(expr)) return true;
    const parts = expr.split('.').filter(Boolean);
    if (!parts.length || parts.some((p) => FORBIDDEN_AUTOMATION_KEYS.has(p) || UNSAFE_TEMPLATE_PATH_SEGMENTS.has(p))) {
      return true;
    }
    pos = closeIdx + 2;
  }
  return false;
}

function hasUnsafeAutomationTemplate(value, seen = new WeakSet()) {
  if (typeof value === 'string') return hasUnsafeAutomationTemplateString(value);
  if (value === null || value === undefined || typeof value !== 'object' || value instanceof Date) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => hasUnsafeAutomationTemplate(item, seen));
  for (const key of Object.getOwnPropertyNames(value)) {
    if (FORBIDDEN_AUTOMATION_KEYS.has(key) || hasUnsafeAutomationTemplateString(key) || hasUnsafeAutomationTemplate(value[key], seen)) {
      return true;
    }
  }
  return false;
}

function isAllowlistedAutomationCollection(collectionName) {
  const name = String(collectionName || '').trim();
  if (!name) return false;
  if (SENSITIVE_AUTOMATION_COLLECTIONS.has(name)) return false;
  if (ALLOWLISTED_AUTOMATION_COLLECTIONS.has(name)) return true;
  return AUTOMATION_CUSTOM_COLLECTION_RE.test(name);
}

function ipv4OctetsFromInt(num) {
  if (!Number.isInteger(num) || num < 0 || num > 0xffffffff) return null;
  return [(num >>> 24) & 255, (num >>> 16) & 255, (num >>> 8) & 255, num & 255];
}

function parseIpv4Part(part) {
  if (!part) return null;
  if (/^0x[0-9a-f]+$/i.test(part)) return Number.parseInt(part.slice(2), 16);
  if (/^0[0-7]+$/.test(part) && part.length > 1) return Number.parseInt(part.slice(1), 8);
  if (/^\d+$/.test(part)) return Number.parseInt(part, 10);
  return null;
}

function parseIpv4Octets(host) {
  const clean = String(host || '').trim().toLowerCase();
  if (!clean) return null;
  if (/^(?:0x[0-9a-f]+|0[0-7]+|\d+)$/i.test(clean)) {
    return ipv4OctetsFromInt(parseIpv4Part(clean));
  }
  const parts = clean.split('.');
  if (parts.length < 2 || parts.length > 4) return null;
  const nums = parts.map(parseIpv4Part);
  if (nums.some((n) => n === null || n < 0)) return null;
  if (parts.length === 4) {
    return nums.every((n) => n <= 255) ? nums : null;
  }
  for (let i = 0; i < nums.length - 1; i += 1) {
    if (nums[i] > 255) return null;
  }
  const tail = nums[nums.length - 1];
  const tailMax = parts.length === 2 ? 0xffffff : 0xffff;
  if (tail > tailMax) return null;
  if (parts.length === 2) return [nums[0], (tail >>> 16) & 255, (tail >>> 8) & 255, tail & 255];
  return [nums[0], nums[1], (tail >>> 8) & 255, tail & 255];
}

function isPrivateOrMetadataIpv4Octets(octets) {
  if (!Array.isArray(octets) || octets.length !== 4) return false;
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isUnsafeIpv6Host(host) {
  const bare = String(host || '').split('%')[0].toLowerCase().replace(/^\[|\]$/g, '');
  if (!bare.includes(':')) return false;
  if (bare === '::' || bare === '::1' || bare === '0:0:0:0:0:0:0:1') return true;
  if (/^f[cd][0-9a-f]{0,2}:/.test(bare)) return true;
  if (/^fe[89ab][0-9a-f]?:/.test(bare)) return true;
  const v4DotMatch = bare.match(/^(?:::ffff:|(?:0+:){5}ffff:|::)(\d+\.\d+\.\d+\.\d+)$/);
  if (v4DotMatch) return isPrivateOrMetadataIpv4Octets(parseIpv4Octets(v4DotMatch[1]));
  const v4HexMatch = bare.match(/^(?:::ffff:|(?:0+:){5}ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (v4HexMatch) {
    const hi = Number.parseInt(v4HexMatch[1], 16);
    const lo = Number.parseInt(v4HexMatch[2], 16);
    return isPrivateOrMetadataIpv4Octets([(hi >>> 8) & 255, hi & 255, (lo >>> 8) & 255, lo & 255]);
  }
  return false;
}

function isUnsafeMetadataHost(host) {
  const clean = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!clean) return false;
  if (
    clean === 'localhost'
    || clean.endsWith('.localhost')
    || clean === 'internal'
    || clean.endsWith('.internal')
    || clean === 'instance-data'
    || clean.startsWith('instance-data.')
    || clean === 'metadata.azure.com'
    || clean.endsWith('.metadata.azure.com')
    || clean === 'metadata.google.internal'
    || clean === 'metadata.aws.internal'
    || clean === 'metadata'
  ) {
    return true;
  }
  if (isUnsafeIpv6Host(clean)) return true;
  const octets = parseIpv4Octets(clean);
  if (octets && isPrivateOrMetadataIpv4Octets(octets)) return true;
  return false;
}

function isUnsafeMetadataUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return false;
  const trimmed = rawUrl.trim();
  const lower = trimmed.toLowerCase();
  if ((lower.startsWith('/') && !lower.startsWith('//')) || (lower.startsWith('{{') && lower.endsWith('}}') && !lower.slice(2, -2).includes('{{'))) {
    return false;
  }
  if ([
    '169.254.',
    'metadata.google.internal',
    'metadata.azure.com',
    'metadata.aws.internal',
    'instance-data',
    'fd00:ec2::254',
    '0xa9fea9fe',
    '2852039166',
    'a9fe:a9fe',
  ].some((p) => lower.includes(p))) {
    return true;
  }
  const hasExplicitSchemeOrProtoRel = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/.test(lower);
  if (!hasExplicitSchemeOrProtoRel && /^\d+$/.test(lower) && Number(lower) < 16777216) {
    return false;
  }
  const candidate = lower.startsWith('//')
    ? `http:${lower}`
    : (hasExplicitSchemeOrProtoRel ? lower : (lower.includes(':') && !lower.includes('.') && !lower.startsWith('[') ? `http://[${lower}]` : `http://${lower}`));
  try {
    const parsed = new URL(candidate);
    if (isUnsafeMetadataHost(parsed.hostname)) return true;
  } catch {
    const bareHost = lower.replace(/^(?:[a-z][a-z0-9+.-]*:)?\/\//, '').split(/[/?#]/)[0].split('@').pop();
    if (isUnsafeMetadataHost(bareHost)) return true;
  }
  return false;
}

function loadStudioFlowModule(moduleName) {
  const inDist = __dirname.includes(`${path.sep}dist${path.sep}`);
  const candidates = inDist
    ? [
        `@latticedx/plugin-dxos-studio/dist/server/${moduleName}`,
        `@latticedx/plugin-dxos-studio/src/server/${moduleName}`,
        `../../../plugin-dxos-studio/dist/server/${moduleName}`,
        `../../../plugin-dxos-studio/src/server/${moduleName}`,
      ]
    : [
        `@latticedx/plugin-dxos-studio/src/server/${moduleName}`,
        `../../../plugin-dxos-studio/src/server/${moduleName}`,
        `../../../plugin-dxos-studio/dist/server/${moduleName}`,
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

function scrubGraphNodePayloads(rawGraph, protectedCollections) {
  const clean = sanitizeAutomationValue(rawGraph);
  if (!isPlainObject(clean)) return clean;
  if (Array.isArray(clean.nodes)) {
    for (const node of clean.nodes) {
      if (!isPlainObject(node) || !isPlainObject(node.config)) continue;
      if (node.type === 'data.create' || node.type === 'data.update') {
        const targetCol = String(node.config.collection || node.config.targetCollection || '').trim();
        const isSafeTpl = targetCol.startsWith('{{') && targetCol.endsWith('}}') && !hasUnsafeAutomationTemplate(targetCol);
        if (targetCol && !isSafeTpl && (protectedCollections?.has(targetCol) || !isAllowlistedAutomationCollection(targetCol))) {
          continue;
        }
        for (const payloadKey of ['values', 'data', 'patch', 'payload']) {
          if (!isPlainObject(node.config[payloadKey])) continue;
          delete node.config[payloadKey].id;
          delete node.config[payloadKey].organizationId;
          if (AUTOMATION_CORE_VOUCHERS.has(targetCol)) {
            for (const f of AUTOMATION_PROTECTED_VOUCHER_FIELDS) {
              delete node.config[payloadKey][f];
            }
          }
        }
      }
    }
  }
  return clean;
}

function validateFlowGraphInput(rawGraph, failTool, protectedCollections, { requireTrigger = true } = {}) {
  if (!isPlainObject(rawGraph) || !Array.isArray(rawGraph.nodes)) {
    throw failTool('AUTOMATION_RULE_INVALID', 400, 'graphJson phải là đối tượng Graph v2 hợp lệ có mảng nodes.');
  }
  if (hasForbiddenProtoKeys(rawGraph) || hasUnsafeAutomationTemplate(rawGraph)) {
    throw failTool('AUTOMATION_AI_REFUSED', 400, 'graphJson chứa khóa đối tượng bị cấm hoặc biểu thức template không an toàn.');
  }
  const cleanGraph = scrubGraphNodePayloads(rawGraph, protectedCollections);

  for (const node of cleanGraph.nodes) {
    if (!isPlainObject(node)) {
      throw failTool('AUTOMATION_RULE_INVALID', 400, 'Phần tử node trong graphJson không hợp lệ.');
    }
    const cfg = isPlainObject(node.config) ? node.config : {};
    if (['data.create', 'data.update', 'data.query', 'ai.agent'].includes(node.type)) {
      const rawCol = node.type === 'ai.agent' ? (cfg.targetCollection || cfg.collection || '') : (cfg.collection || cfg.targetCollection || '');
      const col = String(rawCol || '').trim();
      if (col) {
        const isSafeTpl = (col.includes('{') || col.includes('}')) ? (col.startsWith('{{') && col.endsWith('}}') && !hasUnsafeAutomationTemplate(col)) : false;
        if (!isSafeTpl && (protectedCollections?.has(col) || !isAllowlistedAutomationCollection(col))) {
          throw failTool('AUTOMATION_AI_REFUSED', 400, `Bảng đích "${col}" không được phép thao tác trong Flow Graph.`);
        }
      }
    }
    if (['integration.http', 'ai.llm', 'iot.twin_command'].includes(node.type)) {
      for (const k of ['url', 'path', 'baseUrl', 'baseURL', 'endpoint', 'downlinkUrl', 'webhookUrl', 'callbackUrl']) {
        if (isUnsafeMetadataUrl(cfg[k])) {
          throw failTool('AUTOMATION_AI_REFUSED', 400, `URL không an toàn trong ${node.type}.${k}.`);
        }
      }
    }
  }

  const validatorMod = loadStudioFlowModule('flow/validator');
  const registryMod = loadStudioFlowModule('flow/registry');
  if (validatorMod && typeof validatorMod.validateFlowGraph === 'function') {
    const nodeRegistry = typeof registryMod?.createDefaultRegistry === 'function' ? registryMod.createDefaultRegistry() : null;
    const check = validatorMod.validateFlowGraph(cleanGraph, {
      nodeRegistry,
      systemProtectedCollections: protectedCollections,
      requireTrigger,
    });
    if (!check.ok) {
      const firstErr = check.errors[0] || {};
      const isSecurityErr = ['TARGET_COLLECTION_FORBIDDEN', 'UNSAFE_TEMPLATE_EXPRESSION', 'CONNECTOR_URL_UNSAFE'].includes(firstErr.code);
      throw failTool(isSecurityErr ? 'AUTOMATION_AI_REFUSED' : 'AUTOMATION_RULE_INVALID', 400, firstErr.message || 'Flow Graph v2 không hợp lệ.');
    }
    return check.graph;
  }

  // Isolated fallback graph validation when flow/validator is unavailable
  const ids = new Set();
  let triggerCount = 0;
  for (const node of cleanGraph.nodes) {
    const nid = String(node.id || '').trim();
    if (!nid || ids.has(nid)) {
      throw failTool('AUTOMATION_RULE_INVALID', 400, `Node id không hợp lệ hoặc bị trùng: "${nid || '(empty)'}".`);
    }
    ids.add(nid);
    if (String(node.type || '').startsWith('trigger.')) triggerCount += 1;
  }
  if (requireTrigger ? triggerCount !== 1 : triggerCount > 1) {
    throw failTool('AUTOMATION_RULE_INVALID', 400, requireTrigger ? 'Flow Graph v2 cần đúng 1 node trigger.*.' : 'Flow Graph v2 chỉ cho phép tối đa 1 node trigger.*.');
  }
  const edges = Array.isArray(cleanGraph.edges) ? cleanGraph.edges : [];
  const inDeg = new Map([...ids].map((id) => [id, 0]));
  const adj = new Map([...ids].map((id) => [id, []]));
  for (const edge of edges) {
    if (!isPlainObject(edge) || !ids.has(edge.source) || !ids.has(edge.target) || edge.source === edge.target) {
      throw failTool('AUTOMATION_RULE_INVALID', 400, 'Cạnh (edge) trong Flow Graph v2 không hợp lệ hoặc tự lặp.');
    }
    adj.get(edge.source).push(edge.target);
    inDeg.set(edge.target, inDeg.get(edge.target) + 1);
  }
  const q = [...inDeg.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  let visited = 0;
  for (let i = 0; i < q.length; i += 1) {
    visited += 1;
    for (const nxt of adj.get(q[i]) || []) {
      const nd = inDeg.get(nxt) - 1;
      inDeg.set(nxt, nd);
      if (nd === 0) q.push(nxt);
    }
  }
  if (visited < ids.size) {
    throw failTool('AUTOMATION_RULE_INVALID', 400, 'Flow Graph v2 chứa vòng lặp (cycle).');
  }
  const schemaMod = loadStudioFlowModule('flow/schema');
  return typeof schemaMod?.normalizeGraph === 'function'
    ? schemaMod.normalizeGraph(cleanGraph)
    : { version: 2, nodes: cleanGraph.nodes, edges, viewport: cleanGraph.viewport || { x: 0, y: 0, zoom: 1 }, settings: cleanGraph.settings || { errorPolicy: 'stop', cooldownSec: 0, maxDepth: 8, timeoutMs: 30000 } };
}

function assertSafeAutomationInput(goalText, ruleObj, args, failTool, protectedCollections) {
  const normGoal = stripDiacriticsSimple(goalText).toLowerCase().replace(/\s+/g, ' ').trim();
  if (normGoal) {
    if (AUTOMATION_INJECTION_RE.test(normGoal)) {
      throw failTool('AUTOMATION_AI_REFUSED', 400, 'Yêu cầu vi phạm chính sách bảo mật (injection, lộ bí mật hoặc prototype key).');
    }
    if (AUTOMATION_SYSTEM_TABLE_RE.test(normGoal)) {
      throw failTool('AUTOMATION_AI_REFUSED', 400, 'Không được phép tạo hoặc sửa automation nhắm vào bảng hệ thống hoặc bảng nhạy cảm.');
    }
  }
  if (args?.collectionName) {
    const col = String(args.collectionName).trim();
    if (protectedCollections?.has(col) || !isAllowlistedAutomationCollection(col)) {
      throw failTool('AUTOMATION_AI_REFUSED', 400, `Collection "${col}" không nằm trong danh sách cho phép của Automation.`);
    }
  }
  if (
    hasForbiddenProtoKeys(ruleObj)
    || hasForbiddenProtoKeys(args?.sampleEvent)
    || hasForbiddenProtoKeys(args?.config)
    || hasForbiddenProtoKeys(args?.configPatch)
    || hasForbiddenProtoKeys(args?.graphJson)
    || hasForbiddenProtoKeys(args?.graph)
    || hasForbiddenProtoKeys(args?.pinnedInputs)
    || hasForbiddenProtoKeys(args?.payload)
    || hasForbiddenProtoKeys(args?.runTrace)
  ) {
    throw failTool('AUTOMATION_AI_REFUSED', 400, 'Phát hiện khóa đối tượng bị cấm (__proto__, constructor, prototype).');
  }
  if (
    hasUnsafeAutomationTemplate(args?.graphJson)
    || hasUnsafeAutomationTemplate(args?.graph)
    || hasUnsafeAutomationTemplate(args?.pinnedInputs)
    || hasUnsafeAutomationTemplate(args?.payload)
    || hasUnsafeAutomationTemplate(args?.runTrace)
    || hasUnsafeAutomationTemplate(args?.configPatch)
    || hasUnsafeAutomationTemplate(args?.config)
    || hasUnsafeAutomationTemplate(args?.sampleEvent)
    || hasUnsafeAutomationTemplate(args?.actionsJson)
    || hasUnsafeAutomationTemplate(args?.filterJson)
  ) {
    throw failTool('AUTOMATION_AI_REFUSED', 400, 'Dữ liệu Graph v2 hoặc tham số chứa biểu thức template không an toàn.');
  }
  const rawArgGraph = isPlainObject(args?.graphJson) ? args.graphJson : (isPlainObject(args?.graph) ? args.graph : null);
  if (rawArgGraph) {
    validateFlowGraphInput(rawArgGraph, failTool, protectedCollections, { requireTrigger: false });
  }
  if (isPlainObject(ruleObj)) {
    if (ruleObj.filterJson !== undefined && ruleObj.filterJson !== null && hasUnsafeAutomationTemplate(ruleObj.filterJson)) {
      throw failTool('AUTOMATION_AI_REFUSED', 400, 'filterJson chứa biểu thức template không an toàn.');
    }
    if (isPlainObject(ruleObj.graphJson)) {
      validateFlowGraphInput(ruleObj.graphJson, failTool, protectedCollections, { requireTrigger: false });
    }
    if (isPlainObject(ruleObj.draftGraphJson)) {
      validateFlowGraphInput(ruleObj.draftGraphJson, failTool, protectedCollections, { requireTrigger: false });
    }
    const actions = Array.isArray(ruleObj.actionsJson) ? ruleObj.actionsJson : [];
    for (let i = 0; i < actions.length; i += 1) {
      const act = actions[i];
      if (!isPlainObject(act)) {
        throw failTool('AUTOMATION_AI_REFUSED', 400, `actionsJson[${i}] không hợp lệ.`);
      }
      if (hasUnsafeAutomationTemplate(act)) {
        throw failTool('AUTOMATION_AI_REFUSED', 400, `actionsJson[${i}] chứa biểu thức template không an toàn.`);
      }
      const actType = String(act.type || '').trim();
      if (actType && !VALID_AUTOMATION_ACTION_TYPES.has(actType)) {
        throw failTool('AUTOMATION_AI_REFUSED', 400, `Loại hành động "${actType}" không được hỗ trợ.`);
      }
      if (actType === 'create_record' || actType === 'update_record') {
        const targetCol = String(act.collection || act.targetCollection || '').trim();
        if (!targetCol || protectedCollections?.has(targetCol) || !isAllowlistedAutomationCollection(targetCol)) {
          throw failTool('AUTOMATION_AI_REFUSED', 400, `Bảng đích "${targetCol || '(empty)'}" không được phép thao tác trong Automation.`);
        }
      }
    }
  }
}

function getSafePathLocal(root, rawPath) {
  if (root === null || root === undefined) return undefined;
  const pathStr = String(rawPath || '').trim();
  if (!pathStr || !/^[a-zA-Z0-9_.\-$]+$/.test(pathStr)) return undefined;
  const segments = pathStr.split('.').filter(Boolean);
  let cur = root;
  for (const seg of segments) {
    if (FORBIDDEN_AUTOMATION_KEYS.has(seg) || UNSAFE_TEMPLATE_PATH_SEGMENTS.has(seg)) return undefined;
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return undefined;
      cur = cur[idx];
    } else {
      if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
      cur = cur[seg];
    }
  }
  return cur;
}

function lookupLocalFilterValue(eventContext, key) {
  const pathStr = String(key || '').trim();
  if (!pathStr) return undefined;
  if (/^(?:data|dmn|event|envelope|steps)\./.test(pathStr)) {
    return getSafePathLocal(eventContext, pathStr);
  }
  const fromData = getSafePathLocal(eventContext?.data, pathStr);
  if (fromData !== undefined) return fromData;
  return getSafePathLocal(eventContext, pathStr);
}

function matchLocalOperator(actual, ops) {
  for (const [op, expected] of Object.entries(ops)) {
    if (FORBIDDEN_AUTOMATION_KEYS.has(op)) return false;
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
        const a = Number(actual);
        const b = Number(expected);
        if (actual === null || actual === undefined || actual === '' || !Number.isFinite(a) || !Number.isFinite(b) || !(a > b)) return false;
        break;
      }
      case '$gte':
      case 'gte': {
        const a = Number(actual);
        const b = Number(expected);
        if (actual === null || actual === undefined || actual === '' || !Number.isFinite(a) || !Number.isFinite(b) || !(a >= b)) return false;
        break;
      }
      case '$lt':
      case 'lt': {
        const a = Number(actual);
        const b = Number(expected);
        if (actual === null || actual === undefined || actual === '' || !Number.isFinite(a) || !Number.isFinite(b) || !(a < b)) return false;
        break;
      }
      case '$lte':
      case 'lte': {
        const a = Number(actual);
        const b = Number(expected);
        if (actual === null || actual === undefined || actual === '' || !Number.isFinite(a) || !Number.isFinite(b) || !(a <= b)) return false;
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
      case 'exists':
        if (Boolean(expected) !== (actual !== undefined && actual !== null)) return false;
        break;
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

function matchesFilterLocal(filterJson, eventContext) {
  if (filterJson === null || filterJson === undefined) return true;
  if (Array.isArray(filterJson)) return filterJson.every((c) => matchesFilterLocal(c, eventContext));
  if (!isPlainObject(filterJson)) return false;
  const entries = Object.entries(filterJson).filter(([k]) => !FORBIDDEN_AUTOMATION_KEYS.has(k));
  if (!entries.length) return true;
  if (typeof filterJson.field === 'string') {
    const actual = lookupLocalFilterValue(eventContext, filterJson.field);
    if (filterJson.op) return matchLocalOperator(actual, { [String(filterJson.op)]: filterJson.value });
    const opsObj = {};
    for (const [k, v] of entries) {
      if (k === 'field') continue;
      if (k === 'value') opsObj.$eq = v;
      else if (k !== 'op') opsObj[k] = v;
    }
    return matchLocalOperator(actual, opsObj);
  }
  for (const [key, expected] of entries) {
    if (key === '$and' || key === 'and' || key === 'all') {
      if (!Array.isArray(expected) || !expected.every((c) => matchesFilterLocal(c, eventContext))) return false;
      continue;
    }
    if (key === '$or' || key === 'or' || key === 'any') {
      if (!Array.isArray(expected) || !expected.some((c) => matchesFilterLocal(c, eventContext))) return false;
      continue;
    }
    if (key === '$not') {
      if (matchesFilterLocal(expected, eventContext)) return false;
      continue;
    }
    const actual = lookupLocalFilterValue(eventContext, key);
    if (isPlainObject(expected) && Object.keys(expected).some((k) => k.startsWith('$'))) {
      if (!matchLocalOperator(actual, expected)) return false;
    } else if (Array.isArray(expected)) {
      if (!expected.includes(actual)) return false;
    } else if (actual !== expected) {
      return false;
    }
  }
  return true;
}

function interpolateLocal(value, context) {
  if (typeof value === 'string') {
    if (value.startsWith('{{') && value.endsWith('}}') && value.indexOf('{{', 2) === -1 && value.indexOf('}}', 2) === value.length - 2) {
      const expr = value.slice(2, -2).trim();
      if (!expr || !/^[a-zA-Z0-9_.\-$]+$/.test(expr)) return '';
      let resolved = getSafePathLocal(context, expr);
      if (resolved === undefined && isPlainObject(context?.data)) resolved = getSafePathLocal(context.data, expr);
      return resolved === undefined ? '' : resolved;
    }
    let out = '';
    let pos = 0;
    while (pos < value.length) {
      const openIdx = value.indexOf('{{', pos);
      if (openIdx === -1) {
        out += value.slice(pos);
        break;
      }
      const closeIdx = value.indexOf('}}', openIdx + 2);
      if (closeIdx === -1) {
        out += value.slice(pos);
        break;
      }
      out += value.slice(pos, openIdx);
      const inner = value.slice(openIdx + 2, closeIdx);
      if (inner.includes('{{')) {
        out += '{{';
        pos = openIdx + 2;
        continue;
      }
      const expr = inner.trim();
      if (expr && /^[a-zA-Z0-9_.\-$]+$/.test(expr)) {
        let resolved = getSafePathLocal(context, expr);
        if (resolved === undefined && isPlainObject(context?.data)) resolved = getSafePathLocal(context.data, expr);
        if (resolved !== undefined && resolved !== null) {
          out += typeof resolved === 'object' ? JSON.stringify(resolved) : String(resolved);
        }
      }
      pos = closeIdx + 2;
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((item) => interpolateLocal(item, context));
  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (!FORBIDDEN_AUTOMATION_KEYS.has(k)) out[k] = interpolateLocal(v, context);
    }
    return out;
  }
  return value;
}

module.exports = {
  FORBIDDEN_AUTOMATION_KEYS,
  AUTOMATION_RULE_KEY_RE,
  SAFE_SAVE_RULE_KEY_RE,
  VALID_AUTOMATION_ACTION_TYPES,
  ALLOWLISTED_AUTOMATION_COLLECTIONS,
  SENSITIVE_AUTOMATION_COLLECTIONS,
  AUTOMATION_CUSTOM_COLLECTION_RE,
  AUTOMATION_CORE_VOUCHERS,
  AUTOMATION_PROTECTED_VOUCHER_FIELDS,
  AUTOMATION_INJECTION_RE,
  AUTOMATION_SYSTEM_TABLE_RE,
  FLOW_SYNC_SENSITIVE_KEYS,
  FLOW_SYNC_SENSITIVE_KEY_RE,
  UNSAFE_TEMPLATE_PATH_SEGMENTS,
  UNSAFE_TEMPLATE_EXPRESSION_RE,
  isPlainObject,
  stripDiacriticsSimple,
  sanitizeAutomationValue,
  nextFlowSyncRevision,
  isFlowSyncSensitiveKey,
  scrubFlowSyncPayload,
  publishFlowStudioUpdate,
  publishPatchAutomationUpdate,
  hasForbiddenProtoKeys,
  hasUnsafeAutomationTemplateString,
  hasUnsafeAutomationTemplate,
  isAllowlistedAutomationCollection,
  ipv4OctetsFromInt,
  parseIpv4Part,
  parseIpv4Octets,
  isPrivateOrMetadataIpv4Octets,
  isUnsafeIpv6Host,
  isUnsafeMetadataHost,
  isUnsafeMetadataUrl,
  scrubGraphNodePayloads,
  validateFlowGraphInput,
  assertSafeAutomationInput,
  getSafePathLocal,
  lookupLocalFilterValue,
  matchLocalOperator,
  matchesFilterLocal,
  interpolateLocal,
};
