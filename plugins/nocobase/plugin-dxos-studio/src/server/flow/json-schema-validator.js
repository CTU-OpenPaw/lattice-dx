/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const BLOCKED_PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_SCHEMA_DEPTH = 16;

function stripUnsafeKeys(val, depth = 0, state = null) {
  if (depth > MAX_SCHEMA_DEPTH) {
    if (state) state.depthExceeded = true;
    return undefined;
  }
  if (val == null || typeof val !== 'object') return val;
  if (Array.isArray(val)) return val.map((item) => stripUnsafeKeys(item, depth + 1, state));
  const out = {};
  for (const key of Object.keys(val)) {
    if (BLOCKED_PROTO_KEYS.has(key)) continue;
    const clean = stripUnsafeKeys(val[key], depth + 1, state);
    if (clean !== undefined) out[key] = clean;
  }
  return out;
}

function getValueType(val) {
  if (val === null) return 'null';
  if (Array.isArray(val)) return 'array';
  return typeof val;
}

function matchesType(val, expectedType) {
  const actual = getValueType(val);
  if (expectedType === 'integer') return typeof val === 'number' && Number.isInteger(val);
  if (expectedType === 'number') return typeof val === 'number' && Number.isFinite(val);
  return actual === expectedType;
}

function validateNode(val, schema, path, errors, depth) {
  if (depth > MAX_SCHEMA_DEPTH) {
    errors.push({ path: path || '$', message: `Max recursion depth (${MAX_SCHEMA_DEPTH}) exceeded` });
    return;
  }
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return;
  const p = path || '$';

  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!allowed.some((t) => matchesType(val, t))) {
      errors.push({ path: p, message: `Expected type ${allowed.join(' | ')}, got ${getValueType(val)}` });
      return;
    }
  }

  if (Array.isArray(schema.enum)) {
    const hit = schema.enum.some((opt) => opt === val);
    if (!hit) {
      errors.push({ path: p, message: `Value must be one of [${schema.enum.map((x) => JSON.stringify(x)).join(', ')}]` });
      return;
    }
  }

  const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
  if (typeof val === 'string') {
    if (isNum(schema.minLength) && val.length < schema.minLength) {
      errors.push({ path: p, message: `String length ${val.length} < minLength ${schema.minLength}` });
    }
    if (isNum(schema.maxLength) && val.length > schema.maxLength) {
      errors.push({ path: p, message: `String length ${val.length} > maxLength ${schema.maxLength}` });
    }
  }

  if (typeof val === 'number' && Number.isFinite(val)) {
    if (isNum(schema.minimum) && val < schema.minimum) {
      errors.push({ path: p, message: `Value ${val} < minimum ${schema.minimum}` });
    }
    if (isNum(schema.maximum) && val > schema.maximum) {
      errors.push({ path: p, message: `Value ${val} > maximum ${schema.maximum}` });
    }
  }

  if (Array.isArray(val)) {
    if (schema.items && typeof schema.items === 'object') {
      for (let i = 0; i < val.length; i += 1) {
        validateNode(val[i], schema.items, `${p}[${i}]`, errors, depth + 1);
      }
    }
    return;
  }

  if (val && typeof val === 'object') {
    const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const reqKey of schema.required) {
        if (BLOCKED_PROTO_KEYS.has(reqKey)) continue;
        if (!Object.hasOwn(val, reqKey) || val[reqKey] === undefined) {
          errors.push({ path: `${p}.${reqKey}`, message: `Missing required property "${reqKey}"` });
        }
      }
    }
    for (const key of Object.keys(val)) {
      if (BLOCKED_PROTO_KEYS.has(key)) continue;
      if (Object.hasOwn(props, key)) {
        validateNode(val[key], props[key], `${p}.${key}`, errors, depth + 1);
      } else if (schema.additionalProperties === false) {
        errors.push({ path: `${p}.${key}`, message: `Additional property "${key}" is not allowed` });
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        validateNode(val[key], schema.additionalProperties, `${p}.${key}`, errors, depth + 1);
      }
    }
  }
}

function validateJsonAgainstSchema(data, schema) {
  const state = { depthExceeded: false };
  const clean = stripUnsafeKeys(data, 0, state);
  if (state.depthExceeded) {
    return { ok: false, errors: [{ path: '$', message: `Max recursion depth (${MAX_SCHEMA_DEPTH}) exceeded` }] };
  }
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { ok: true, value: clean };
  }
  const errors = [];
  validateNode(clean, schema, '$', errors, 0);
  if (errors.length) {
    return { ok: false, errors };
  }
  return { ok: true, value: clean };
}

module.exports = {
  MAX_SCHEMA_DEPTH,
  stripUnsafeKeys,
  validateJsonAgainstSchema,
};
