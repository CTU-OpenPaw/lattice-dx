/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

let cachedZod;
function loadZod() {
  if (cachedZod !== undefined) return cachedZod;
  try {
    cachedZod = require('zod');
  } catch {
    cachedZod = null;
  }
  return cachedZod;
}

function buildJsonSchema(spec = {}) {
  const properties = {};
  const required = [];
  for (const [key, prop] of Object.entries(spec.properties || {})) {
    const entry = { type: prop.type || 'string' };
    if (prop.description) entry.description = prop.description;
    if (Array.isArray(prop.enum)) entry.enum = [...prop.enum];
    if (prop.maxLength != null) entry.maxLength = prop.maxLength;
    if (entry.type === 'array') entry.items = prop.items || { type: 'string' };
    else if (prop.items) entry.items = prop.items;
    properties[key] = entry;
    if (prop.required) required.push(key);
  }
  return {
    type: 'object',
    ...(spec.description ? { description: spec.description } : {}),
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: spec.additionalProperties === true,
  };
}

function makeZodPassthroughObject(z) {
  if (typeof z.looseObject === 'function') return z.looseObject({});
  const base = z.object({});
  return typeof base?.passthrough === 'function' ? base.passthrough() : base;
}

function buildZodSchema(spec = {}, injectedZod = null) {
  const z = injectedZod || loadZod();
  if (!z) return null;
  const shape = {};
  for (const [key, prop] of Object.entries(spec.properties || {})) {
    let field;
    if (Array.isArray(prop.enum) && prop.enum.length > 0 && prop.type === 'string') {
      field = z.enum(prop.enum);
    } else if (prop.type === 'boolean') {
      field = z.boolean();
    } else if (prop.type === 'number' || prop.type === 'integer') {
      field = z.number();
    } else if (prop.type === 'array') {
      const itemType = prop.items?.type;
      const itemSchema = itemType === 'number' || itemType === 'integer'
        ? z.number()
        : itemType === 'object'
          ? makeZodPassthroughObject(z)
          : itemType === 'boolean'
            ? z.boolean()
            : z.string();
      field = z.array(itemSchema);
    } else if (prop.type === 'object') {
      field = makeZodPassthroughObject(z);
    } else {
      field = z.string();
    }
    if (prop.description) field = field.describe(prop.description);
    if (!prop.required) field = field.optional();
    shape[key] = field;
  }
  const obj = z.object(shape);
  return spec.description ? obj.describe(spec.description) : obj;
}

function coerceStructuredValue(val, expectedType) {
  if ((expectedType === 'object' || expectedType === 'array') && typeof val === 'string') {
    const trimmed = val.trim();
    if ((expectedType === 'object' && trimmed.startsWith('{')) || (expectedType === 'array' && trimmed.startsWith('['))) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return val;
      }
    }
  }
  return val;
}

function checkType(val, expected) {
  if (expected === 'string') return typeof val === 'string';
  if (expected === 'boolean') return typeof val === 'boolean';
  if (expected === 'number') return typeof val === 'number' && Number.isFinite(val);
  if (expected === 'integer') return typeof val === 'number' && Number.isInteger(val);
  if (expected === 'array') return Array.isArray(val);
  if (expected === 'object') return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
  return true;
}

function defineToolSchema(spec = {}) {
  const jsonSchema = buildJsonSchema(spec);
  const zodSchema = buildZodSchema(spec);
  const props = spec.properties || {};

  function validate(rawArgs) {
    let input = rawArgs === undefined ? {} : rawArgs;
    if (typeof input === 'string' && input.trim().startsWith('{')) {
      try { input = JSON.parse(input); } catch {}
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return { ok: false, error: 'Arguments must be a JSON object' };
    }
    const clean = {};
    for (const [key, def] of Object.entries(props)) {
      const expectedType = def.type || 'string';
      const rawVal = input[key];
      if (rawVal === undefined) {
        if (def.required) return { ok: false, error: `Missing required argument "${key}"` };
        if (def.default !== undefined) clean[key] = def.default;
        continue;
      }
      const val = coerceStructuredValue(rawVal, expectedType);
      if (!checkType(val, expectedType)) {
        return { ok: false, error: `Argument "${key}" must be of type ${expectedType}` };
      }
      if (expectedType === 'string' && def.maxLength != null && val.length > def.maxLength) {
        return { ok: false, error: `Argument "${key}" exceeds maxLength ${def.maxLength}` };
      }
      if (Array.isArray(def.enum) && !def.enum.includes(val)) {
        return { ok: false, error: `Argument "${key}" must be one of: ${def.enum.join(', ')}` };
      }
      clean[key] = val;
    }
    if (!spec.additionalProperties) {
      for (const extraKey of Object.keys(input)) {
        if (!(extraKey in props)) {
          return { ok: false, error: `Unexpected argument "${extraKey}"` };
        }
      }
    } else {
      for (const [k, v] of Object.entries(input)) {
        if (!(k in clean)) clean[k] = v;
      }
    }
    return { ok: true, value: clean };
  }

  return { jsonSchema, zodSchema, validate };
}

module.exports = { defineToolSchema, loadZod, buildJsonSchema, buildZodSchema };
