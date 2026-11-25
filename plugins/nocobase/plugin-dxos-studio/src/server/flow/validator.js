/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { fail } = require('../wms-dmn-shared');
const {
  ALLOWLISTED_BUSINESS_COLLECTIONS, BLOCKED_PROTO_KEYS, CUSTOM_COLLECTION_RE,
  FORBIDDEN_SYSTEM_COLLECTIONS, MAX_FLOW_NODES, MAX_HARD_DEPTH, MAX_LOOP_ITERATIONS,
  STANDARD_PORTS, isPlainObject, normalizeGraph,
} = require('./schema');
const { isUnsafeStaticUrl } = require('./security-helpers');

const TEMPLATE_EXPR_RE = /^[a-zA-Z0-9_.\-$]+$/;
const VALID_FILTER_OPERATORS = new Set([
  '$eq', 'eq', '$ne', 'ne', '$gt', 'gt', '$gte', 'gte',
  '$lt', 'lt', '$lte', 'lte', '$in', 'in', '$nin', 'nin',
  '$exists', 'exists', '$contains', 'contains',
]);
const EXPLICIT_FILTER_CLAUSE_KEYS = new Set(['op', 'value', ...VALID_FILTER_OPERATORS]);
const FORBIDDEN_SYSTEM_LOWER = new Set([...FORBIDDEN_SYSTEM_COLLECTIONS].map((c) => c.toLowerCase()));
const CRON_FIELD_RE = /^[0-9*,\/-]+$/;

const PROMPT_INJECTION_RE = /\b(ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?|ignore\s+previous|system\s+prompt|reveal\s+(?:the\s+)?(?:system\s+)?prompt|bypass\s+(?:rbac|hitl|auth|acl|security|rls)|disable\s+(?:hitl|rbac|rls|auth)|exfiltrate|dump\s+secrets?|steal\s+secrets?|jailbreak)\b/i;
const PROTOTYPE_OR_CODE_RE = /(__proto__|process\.env|child_process|\bconstructor\b|\bprototype\b|require\s*\(|eval\s*\(|Function\s*\(|\$\{)/i;
const SENSITIVE_NAME_RE = /\b(latticeConnectors|latticeApiKeys|latticePkiKeys|latticeCryptoLedger|latticeWebhookSubscriptions|latticeWebhookDeliveries|latticeEventBus|latticeDelegations|latticeOrganizations|latticeAutomationRules|latticeAutomationRuns|latticeAiMemory|latticeAiTraces|latticeAutomationRuleVersions|latticeA2aTasks|latticeNotificationDeliveries|latticeApprovalPolicies|latticeApprovalRequests|latticePublicForms|latticePublicFormSubmissions|apiKeys|rolesUsers|applicationTokens|authenticators|sessions)\b/i;
const SYSTEM_TABLE_PROMPT_RE = /(?:\b(?:create|update|read|write|delete|drop|insert|query|modify|target|access|dump|into|from|on|in|table|collection)\b[\s:='"]*(?:the\s+)?(?:users|roles)\b|\b(?:users|roles)\s+(?:table|collection)\b)/i;

function scanTemplateString(str) {
  const dollarIdx = str.indexOf('${');
  if (dollarIdx !== -1 && str.indexOf('}', dollarIdx + 2) !== -1) return true;
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
    if (!expr || !TEMPLATE_EXPR_RE.test(expr)) return true;
    const segments = expr.split('.').filter(Boolean);
    if (!segments.length || segments.some((seg) => BLOCKED_PROTO_KEYS.has(seg))) return true;
    pos = closeIdx + 2;
  }
  return false;
}

function hasUnsafeTemplateSyntax(value, seen = new WeakSet()) {
  if (typeof value === 'string') return scanTemplateString(value);
  if (!value || typeof value !== 'object' || value instanceof Date) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => hasUnsafeTemplateSyntax(item, seen));
  for (const key of Object.getOwnPropertyNames(value)) {
    if (BLOCKED_PROTO_KEYS.has(key) || hasUnsafeTemplateSyntax(value[key], seen)) return true;
  }
  return false;
}

function assertSafeFlowTemplate(value, label = 'template') {
  if (hasUnsafeTemplateSyntax(value)) {
    throw fail('UNSAFE_TEMPLATE_EXPRESSION', 400, `${label} contains unsafe template or prototype key`);
  }
  return true;
}

function validateFilterStructure(node, fieldLabel = 'filterJson') {
  if (node === null || node === undefined) return { ok: true };
  if (Array.isArray(node)) {
    for (const item of node) {
      const res = validateFilterStructure(item, fieldLabel);
      if (!res.ok) return res;
    }
    return { ok: true };
  }
  if (!isPlainObject(node)) return { ok: false, code: 'INVALID_FILTER_CLAUSE', message: `${fieldLabel} must be a plain object, array, or null` };
  if (hasUnsafeTemplateSyntax(node)) return { ok: false, code: 'UNSAFE_TEMPLATE_EXPRESSION', message: `${fieldLabel} contains unsafe template or prototype key` };
  if (typeof node.field === 'string') {
    const opsKeys = Object.keys(node).filter((k) => k !== 'field');
    if (opsKeys.some((k) => EXPLICIT_FILTER_CLAUSE_KEYS.has(k))) {
      if ('op' in node) {
        const opStr = String(node.op || '').trim();
        if (!opStr || BLOCKED_PROTO_KEYS.has(opStr) || !VALID_FILTER_OPERATORS.has(opStr)) {
          return { ok: false, code: 'INVALID_FILTER_OPERATOR', message: `${fieldLabel} explicit clause has invalid operator` };
        }
      } else {
        const nonValue = opsKeys.filter((k) => k !== 'value');
        if (!nonValue.length && !opsKeys.includes('value')) return { ok: false, code: 'INVALID_FILTER_OPERATOR', message: `${fieldLabel} explicit clause has no operators` };
        for (const k of nonValue) {
          if (!VALID_FILTER_OPERATORS.has(k)) return { ok: false, code: 'INVALID_FILTER_OPERATOR', message: `${fieldLabel} unsupported operator "${k}"` };
        }
      }
    }
  }
  for (const [key, expected] of Object.entries(node)) {
    if (key === '$and' || key === 'and' || key === 'all' || key === '$or' || key === 'or' || key === 'any' || (key === 'rules' && Array.isArray(expected))) {
      if (!Array.isArray(expected)) return { ok: false, code: 'INVALID_FILTER_CLAUSE', message: `${fieldLabel}.${key} must be an array` };
      for (const item of expected) {
        const res = validateFilterStructure(item, `${fieldLabel}.${key}`);
        if (!res.ok) return res;
      }
    } else if (key === '$not') {
      const res = validateFilterStructure(expected, `${fieldLabel}.$not`);
      if (!res.ok) return res;
    } else if (isPlainObject(expected) && Object.keys(expected).length === 0) {
      return { ok: false, code: 'INVALID_FILTER_OPERATOR', message: `${fieldLabel}.${key} operator object cannot be empty` };
    }
  }
  return { ok: true };
}

function isAllowlistedTargetCollection(collectionName, allowlisted = ALLOWLISTED_BUSINESS_COLLECTIONS, systemProtected = FORBIDDEN_SYSTEM_COLLECTIONS) {
  const name = String(collectionName || '').trim();
  if (!name) return false;
  const sysSet = systemProtected instanceof Set ? systemProtected : new Set(systemProtected || []);
  const sysLower = new Set([...FORBIDDEN_SYSTEM_LOWER, ...[...sysSet].map((c) => String(c).toLowerCase())]);
  if (sysSet.has(name) || sysLower.has(name.toLowerCase())) return false;
  const allowSet = allowlisted instanceof Set ? allowlisted : new Set(allowlisted || []);
  return allowSet.has(name) || CUSTOM_COLLECTION_RE.test(name);
}

const isSafeTemplateString = (val) => {
  const s = String(val || '').trim();
  return s.startsWith('{{') && s.endsWith('}}') && !hasUnsafeTemplateSyntax(s);
};

function lookupRegistrySchema(nodeRegistry, type) {
  if (!nodeRegistry || !type) return null;
  if (typeof nodeRegistry.getNodeType === 'function') return nodeRegistry.getNodeType(type) || null;
  if (nodeRegistry instanceof Map) return nodeRegistry.get(type) || null;
  if (nodeRegistry instanceof Set || typeof nodeRegistry.has === 'function') return nodeRegistry.has(type) ? { type } : null;
  if (typeof nodeRegistry === 'object' && Object.prototype.hasOwnProperty.call(nodeRegistry, type)) return nodeRegistry[type] || { type };
  return null;
}

function validateNodeSecurity(node, graphRuleKey, opts, errors) {
  const cfg = node.config || {};
  const { allowlistedCollections, systemProtectedCollections, maxLoops } = opts;
  if (node.type === 'control.loop') {
    const maxIter = cfg.maxIterations === undefined ? maxLoops : cfg.maxIterations;
    if (!Number.isInteger(maxIter) || maxIter < 1 || maxIter > maxLoops) {
      errors.push({ code: 'FLOW_LOOP_LIMIT_EXCEEDED', nodeId: node.id, message: `control.loop maxIterations must be in 1..${maxLoops}` });
    }
  }
  if (node.type === 'control.subflow') {
    if (cfg.maxDepth !== undefined && cfg.maxDepth !== null) {
      const md = Number(cfg.maxDepth);
      if (!Number.isInteger(md) || md < 1 || md > MAX_HARD_DEPTH) errors.push({ code: 'INVALID_MAX_DEPTH', nodeId: node.id, message: `maxDepth must be 1..${MAX_HARD_DEPTH}` });
    }
    if (graphRuleKey && cfg.ruleKey && String(cfg.ruleKey).trim() === String(graphRuleKey).trim()) {
      errors.push({ code: 'FLOW_SELF_RECURSIVE_SUBFLOW', nodeId: node.id, message: 'control.subflow cannot invoke itself' });
    }
  }
  if (['data.create', 'data.update', 'data.query', 'ai.agent'].includes(node.type)) {
    const rawCol = node.type === 'ai.agent' ? (cfg.targetCollection || cfg.collection || '') : (cfg.collection || cfg.targetCollection || '');
    const col = String(rawCol || '').trim();
    if (col) {
      const hasBrace = col.includes('{') || col.includes('}');
      if (hasBrace ? !isSafeTemplateString(col) : !isAllowlistedTargetCollection(col, allowlistedCollections, systemProtectedCollections)) {
        errors.push({ code: 'TARGET_COLLECTION_FORBIDDEN', nodeId: node.id, message: `Collection "${col}" is forbidden for ${node.type}` });
      }
    }
  }
  if (node.type === 'integration.http' || node.type === 'ai.llm' || node.type === 'iot.twin_command') {
    for (const key of ['url', 'path', 'baseUrl', 'baseURL', 'endpoint', 'downlinkUrl']) {
      if (isUnsafeStaticUrl(cfg[key])) errors.push({ code: 'CONNECTOR_URL_UNSAFE', nodeId: node.id, message: `Unsafe SSRF/metadata URL in ${node.type}.${key}` });
    }
  }
  if (node.type === 'trigger.schedule' && cfg.cron !== undefined && cfg.cron !== null && String(cfg.cron).trim() !== '') {
    const fields = typeof cfg.cron === 'string' ? cfg.cron.trim().split(/\s+/) : [];
    if (fields.length !== 5 || !fields.every((f) => CRON_FIELD_RE.test(f))) {
      errors.push({ code: 'FLOW_INVALID_CRON', nodeId: node.id, message: 'trigger.schedule cron must have 5 valid fields' });
    }
  }
  if (node.type === 'control.if' && cfg.condition !== undefined) {
    const res = validateFilterStructure(cfg.condition, `nodes.${node.id}.config.condition`);
    if (!res.ok) errors.push({ code: res.code, nodeId: node.id, message: res.message });
  }
  if (node.type.startsWith('trigger.') && cfg.filterJson !== undefined) {
    const res = validateFilterStructure(cfg.filterJson, `nodes.${node.id}.config.filterJson`);
    if (!res.ok) errors.push({ code: res.code, nodeId: node.id, message: res.message });
  }
}

function validateFlowGraph(rawGraph, {
  nodeRegistry = null, allowlistedCollections = ALLOWLISTED_BUSINESS_COLLECTIONS,
  systemProtectedCollections = FORBIDDEN_SYSTEM_COLLECTIONS, maxNodes = MAX_FLOW_NODES,
  maxLoops = MAX_LOOP_ITERATIONS, requireTrigger = true,
} = {}) {
  const errors = [];
  if (!isPlainObject(rawGraph)) {
    return { ok: false, graph: normalizeGraph({}), topoOrder: [], triggerNode: null, triggerNodes: [], errors: [{ code: 'FLOW_INVALID_GRAPH', message: 'Flow graph must be a plain object' }] };
  }
  if (hasUnsafeTemplateSyntax(rawGraph)) {
    errors.push({ code: 'UNSAFE_TEMPLATE_EXPRESSION', message: 'Flow graph contains unsafe template or prototype key' });
  }
  const graph = normalizeGraph(rawGraph);
  if (graph.nodes.length > maxNodes) errors.push({ code: 'FLOW_MAX_NODES_EXCEEDED', message: `Flow exceeds max nodes (${maxNodes})` });

  const nodeMap = new Map();
  const triggerNodes = [];
  for (const node of graph.nodes) {
    if (!node.id) { errors.push({ code: 'FLOW_INVALID_NODE_ID', message: 'Node id is required' }); continue; }
    if (nodeMap.has(node.id)) { errors.push({ code: 'FLOW_DUPLICATE_NODE_ID', nodeId: node.id, message: `Duplicate node id "${node.id}"` }); continue; }
    nodeMap.set(node.id, node);
    if (node.type.startsWith('trigger.')) triggerNodes.push(node);
    if (nodeRegistry && !lookupRegistrySchema(nodeRegistry, node.type)) errors.push({ code: 'FLOW_UNKNOWN_NODE_TYPE', nodeId: node.id, message: `Unknown node type "${node.type}"` });
    validateNodeSecurity(node, rawGraph.ruleKey, { allowlistedCollections, systemProtectedCollections, maxLoops }, errors);
  }
  if (requireTrigger ? triggerNodes.length !== 1 : triggerNodes.length > 1) {
    errors.push({ code: 'FLOW_TRIGGER_COUNT_INVALID', message: requireTrigger ? 'Exactly 1 trigger node required' : 'At most 1 trigger node allowed' });
  }

  const basePorts = new Set(STANDARD_PORTS);
  const inDegree = new Map([...nodeMap.keys()].map((id) => [id, 0]));
  const adj = new Map([...nodeMap.keys()].map((id) => [id, []]));
  for (const edge of graph.edges) {
    const srcNode = nodeMap.get(edge.source);
    const tgtNode = nodeMap.get(edge.target);
    const srcSchema = srcNode && nodeRegistry ? lookupRegistrySchema(nodeRegistry, srcNode.type) : null;
    const tgtSchema = tgtNode && nodeRegistry ? lookupRegistrySchema(nodeRegistry, tgtNode.type) : null;
    const allowedSrc = Array.isArray(srcSchema?.outputs)
      ? (srcNode?.type === 'control.switch' && Array.isArray(srcNode.config?.cases)
        ? new Set([...srcNode.config.cases.map((c, idx) => String(c?.port || `case_${idx}`).trim()).filter(Boolean), 'default', 'error'])
        : new Set(srcSchema.outputs))
      : basePorts;
    const allowedTgt = Array.isArray(tgtSchema?.inputs)
      ? new Set(tgtSchema.inputs)
      : (tgtNode?.type?.startsWith('trigger.') ? new Set() : basePorts);
    if (!allowedSrc.has(edge.sourceHandle) || !allowedTgt.has(edge.targetHandle)) {
      errors.push({ code: 'FLOW_INVALID_PORT', edgeId: edge.id, message: `Invalid port "${edge.sourceHandle}" -> "${edge.targetHandle}"` });
    }
    if (!srcNode || !tgtNode) { errors.push({ code: 'FLOW_EDGE_NODE_NOT_FOUND', edgeId: edge.id, message: `Edge "${edge.id}" references missing node` }); continue; }
    if (edge.source === edge.target) { errors.push({ code: 'FLOW_CYCLE_DETECTED', edgeId: edge.id, nodeId: edge.source, message: `Self-loop on "${edge.source}"` }); continue; }
    adj.get(edge.source).push(edge.target);
    inDegree.set(edge.target, inDegree.get(edge.target) + 1);
  }

  const queue = [];
  for (const [id, deg] of inDegree.entries()) { if (deg === 0) queue.push(id); }
  const topoOrder = [];
  for (let head = 0; head < queue.length; head += 1) {
    const curr = queue[head];
    topoOrder.push(curr);
    for (const nextId of adj.get(curr) || []) {
      const nextDeg = inDegree.get(nextId) - 1;
      inDegree.set(nextId, nextDeg);
      if (nextDeg === 0) queue.push(nextId);
    }
  }
  if (topoOrder.length < nodeMap.size) errors.push({ code: 'FLOW_CYCLE_DETECTED', message: 'Flow graph contains a cycle' });
  return { ok: errors.length === 0, graph, topoOrder, triggerNode: triggerNodes[0] || null, triggerNodes, errors };
}

function validatePromptSecurity({ prompt, targetNode, rule, graph } = {}) {
  for (const text of [String(prompt || ''), String(targetNode || '')]) {
    if (PROMPT_INJECTION_RE.test(text)) return { refused: true, error: 'Prompt injection or security bypass attempt refused.' };
    if (PROTOTYPE_OR_CODE_RE.test(text)) return { refused: true, error: 'Prototype pollution or code execution expression refused.' };
    if (SENSITIVE_NAME_RE.test(text) || SYSTEM_TABLE_PROMPT_RE.test(text)) return { refused: true, error: 'Targeting system or sensitive collections is forbidden.' };
  }
  if (rule !== undefined && rule !== null) {
    if (!isPlainObject(rule) || hasUnsafeTemplateSyntax(rule)) return { refused: true, error: 'Rule payload contains unsafe template or prototype key.' };
    const fRes = validateFilterStructure(rule.filterJson, 'filterJson');
    if (!fRes.ok) return { refused: true, error: fRes.message };
    for (const act of Array.isArray(rule.actionsJson) ? rule.actionsJson : []) {
      const col = String(act?.collection || act?.targetCollection || '').trim();
      if (col && !isSafeTemplateString(col) && !isAllowlistedTargetCollection(col)) return { refused: true, error: `Target collection "${col}" is forbidden.` };
    }
  }
  if (graph !== undefined && graph !== null) {
    const gRes = validateFlowGraph(graph, { requireTrigger: false });
    if (!gRes.ok) return { refused: true, error: gRes.errors[0]?.message || 'Flow graph failed security validation.' };
  }
  return { refused: false };
}

module.exports = {
  hasUnsafeTemplateSyntax, validateFilterStructure, isAllowlistedTargetCollection,
  assertSafeFlowTemplate, validatePromptSecurity, validateFlowGraph,
};
