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
const { triggerNodes } = require('./nodes/triggers');
const { controlNodes } = require('./nodes/control');
const { dataNodes } = require('./nodes/data');
const { logicNodes } = require('./nodes/logic');
const { aiNodes } = require('./nodes/ai');
const { integrationNodes } = require('./nodes/integrations');

const VALID_NODE_CATEGORIES = Object.freeze(new Set(['trigger', 'control', 'data', 'logic', 'ai', 'integration']));
const NODE_TYPE_RE = /^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*$/;
const BLOCKED_PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function cloneMetadata(value, seen = new WeakSet()) {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => cloneMetadata(item, seen));
  const out = {};
  for (const key of Object.keys(value)) {
    if (!BLOCKED_PROTO_KEYS.has(key)) out[key] = cloneMetadata(value[key], seen);
  }
  return out;
}

function validateNodeDefinition(def) {
  if (!def || typeof def !== 'object' || Array.isArray(def)) {
    throw fail('INVALID_NODE_DEFINITION', 400, 'INVALID_NODE_DEFINITION: definition must be an object');
  }
  const type = typeof def.type === 'string' ? def.type.trim() : '';
  if (!NODE_TYPE_RE.test(type)) {
    throw fail('INVALID_NODE_DEFINITION', 400, `INVALID_NODE_DEFINITION: invalid node type "${type}"`);
  }
  const category = typeof def.category === 'string' ? def.category.trim() : '';
  if (!VALID_NODE_CATEGORIES.has(category)) {
    throw fail('INVALID_NODE_DEFINITION', 400, `INVALID_NODE_DEFINITION: invalid category "${category}" for ${type}`);
  }
  if (!Array.isArray(def.outputs) || def.outputs.length === 0 || def.outputs.some((p) => typeof p !== 'string' || !p.trim() || BLOCKED_PROTO_KEYS.has(p))) {
    throw fail('INVALID_NODE_DEFINITION', 400, `INVALID_NODE_DEFINITION: ${type} requires non-empty outputs array`);
  }
  if (def.inputs !== undefined && (!Array.isArray(def.inputs) || def.inputs.some((p) => typeof p !== 'string' || !p.trim() || BLOCKED_PROTO_KEYS.has(p)))) {
    throw fail('INVALID_NODE_DEFINITION', 400, `INVALID_NODE_DEFINITION: ${type} inputs must be an array of strings`);
  }
  if (typeof def.execute !== 'function') {
    throw fail('INVALID_NODE_DEFINITION', 400, `INVALID_NODE_DEFINITION: ${type} requires execute() function`);
  }
  const inputs = Array.isArray(def.inputs) ? [...def.inputs] : (category === 'trigger' ? [] : ['in']);
  const outputs = def.outputs.map((p) => p.trim());
  return {
    type,
    category,
    label: String(def.label || type),
    description: String(def.description || ''),
    icon: String(def.icon || 'NodeIndexOutlined'),
    color: String(def.color || '#1677ff'),
    inputs,
    outputs,
    defaultConfig: cloneMetadata(def.defaultConfig && typeof def.defaultConfig === 'object' ? def.defaultConfig : {}),
    inputSchema: cloneMetadata(def.inputSchema && typeof def.inputSchema === 'object' ? def.inputSchema : { fields: [] }),
    execute: def.execute,
  };
}

function toNodeSchema(def) {
  return {
    type: def.type,
    category: def.category,
    label: def.label,
    description: def.description,
    icon: def.icon,
    color: def.color,
    inputs: [...def.inputs],
    outputs: [...def.outputs],
    defaultConfig: cloneMetadata(def.defaultConfig),
    inputSchema: cloneMetadata(def.inputSchema),
  };
}

function createDefaultRegistry() {
  const store = new Map();

  const registry = {
    registerNodeType(def) {
      const normalized = validateNodeDefinition(def);
      store.set(normalized.type, normalized);
      return normalized;
    },
    getNodeType(type) {
      return store.get(String(type || '').trim()) || null;
    },
    hasNodeType(type) {
      return store.has(String(type || '').trim());
    },
    listNodeSchemas() {
      return [...store.values()].map(toNodeSchema);
    },
    listNodeTypes() {
      return [...store.keys()];
    },
    get size() {
      return store.size;
    },
  };
  registry.register = registry.registerNodeType;
  registry.get = registry.getNodeType;
  registry.has = registry.hasNodeType;

  for (const def of [...triggerNodes, ...controlNodes, ...dataNodes, ...logicNodes, ...aiNodes, ...integrationNodes]) {
    registry.registerNodeType(def);
  }
  return registry;
}

const defaultRegistry = createDefaultRegistry();

function registerNodeType(def) {
  return defaultRegistry.registerNodeType(def);
}

function getNodeType(type) {
  return defaultRegistry.getNodeType(type);
}

function hasNodeType(type) {
  return defaultRegistry.hasNodeType(type);
}

function listNodeSchemas(registryOverride = defaultRegistry) {
  return (registryOverride || defaultRegistry).listNodeSchemas();
}

module.exports = {
  VALID_NODE_CATEGORIES,
  createDefaultRegistry,
  registerNodeType,
  getNodeType,
  hasNodeType,
  listNodeSchemas,
  validateNodeDefinition,
};
