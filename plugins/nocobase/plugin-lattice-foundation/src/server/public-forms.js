/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');
const { resolveNativeActor } = require('./native-scope');
const { val, callerRoles, getRepo } = require('./native-portal-helpers');
const { canUsePgRlsSession, isValidOrganizationId, withSystemRlsBypass, withTenantRlsContext } = require('./pg-rls');
const { assertApiKeyScope, readParams } = require('./paas-api-keys');

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;
const FIELD_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
const HONEYPOT_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]{1,63}$/;
const SUBMISSION_CODE_RE = /^[A-Za-z0-9._-]{4,64}$/;
const WORKFLOW_KEY_RE = /^[a-zA-Z0-9._-]{1,128}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CUSTOM_COLLECTION_RE = /^latticeCustom[A-Z][A-Za-z0-9]{1,40}$/;

const RESERVED_FORM_SLUGS = Object.freeze(new Set([
  'admin', 'api', 'signin', 'signup', 'mobile', 'track', 'form', 'v', 'p',
  'static', 'storage', 'files', 'lattice', 'health', 'settings',
]));

const PUBLIC_FORM_ALLOWLIST_COLLECTIONS = Object.freeze(new Set([
  'latticeRequests',
  'latticeOrders',
  'latticeServiceTickets',
  'latticeParaDocuments',
  'latticeIncidentCases',
  'latticeLocations',
  'latticeAssets',
  'latticeAgentProposals',
]));

const PUBLIC_FORM_PROTECTED_RESOURCES = Object.freeze(new Set([
  'latticePublicForms',
  'latticePublicFormSubmissions',
]));

const BLOCKED_PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const BLOCKED_TARGET_FIELDS = Object.freeze(new Set([
  'id',
  'organizationId',
  'createdAt',
  'updatedAt',
  'createdById',
  'updatedById',
  'status',
  'version',
  'amendedFromId',
  'amendmentNo',
  'requesterId',
  'assigneeId',
  'submittedBy',
  'cancelledBy',
  'cancelReason',
  'cancelledAt',
  'submittedAt',
  'userId',
  'identitySubject',
  'password',
  'secret',
  'token',
  'apiKey',
  'privateKey',
  'accessTokenHash',
  'statusTokenHash',
  '__proto__',
  'constructor',
  'prototype',
]));

const SENSITIVE_FIELD_NAME_RE = /password|secret|token|apikey|api_key|privatekey|private_key|hash|salt/i;
const ALLOWED_FIELD_TYPES = new Set(['string', 'text', 'number', 'integer', 'boolean', 'date', 'email', 'select', 'file']);
const ALLOWED_FILE_MIME_TYPES = Object.freeze(new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'text/plain',
]));
const MAX_FILE_UPLOAD_BYTES = 2 * 1024 * 1024;
const ensuredSubmissionDbs = new WeakSet();
const VOUCHER_COLLECTIONS = new Set(['latticeRequests', 'latticeOrders', 'latticeServiceTickets']);
const PUBLIC_STATUS_COLLECTIONS = new Set([
  'latticeRequests',
  'latticeOrders',
  'latticeServiceTickets',
  'latticeIncidentCases',
  'latticeParaDocuments',
  'latticeAgentProposals',
]);
const DEFAULT_RATE_LIMIT_PER_MIN = 20;
const STATUS_RATE_LIMIT_PER_MIN = 60;
const PRE_LOOKUP_IP_FLOOD_LIMIT = 300;
const DEFAULT_MAX_FIELD_LENGTH = 2000;
const MAX_FIELD_LENGTH_CAP = 10000;
const DUMMY_HASH_HEX = createHash('sha256').update('latticedx-public-form-dummy-token', 'utf8').digest('hex');

function failForm(code, status = 400, message = code) {
  return Object.assign(new Error(message), { code, status });
}

function sha256Hex(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || a.length === 0) {
    return false;
  }
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertNoPrototypePollution(node, depth = 0) {
  if (node == null || typeof node !== 'object') return;
  if (depth > 20) {
    throw failForm('FORM_PAYLOAD_TOO_DEEP', 400, 'Payload nesting depth exceeds limit.');
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      assertNoPrototypePollution(item, depth + 1);
    }
    return;
  }
  const propNames = Object.getOwnPropertyNames(node);
  for (const key of propNames) {
    if (BLOCKED_PROTO_KEYS.has(key)) {
      throw failForm('FORM_PROTOTYPE_POLLUTION_BLOCKED', 400, `Forbidden prototype key: ${key}`);
    }
    assertNoPrototypePollution(node[key], depth + 1);
  }
}

function isAllowlistedPublicFormCollection(name) {
  if (typeof name !== 'string' || !name.trim()) return false;
  const clean = name.trim();
  if (PUBLIC_FORM_PROTECTED_RESOURCES.has(clean)) return false;
  return PUBLIC_FORM_ALLOWLIST_COLLECTIONS.has(clean) || CUSTOM_COLLECTION_RE.test(clean);
}

function compileBoundedPattern(rawPattern) {
  if (rawPattern === undefined || rawPattern === null || rawPattern === '') return null;
  if (typeof rawPattern !== 'string' || rawPattern.length > 120) {
    throw failForm('FORM_FIELD_PATTERN_INVALID', 400, 'Field regex pattern must be <= 120 chars.');
  }
  if (/(\+|\*|\{[^}]*\})\s*\)[\s\S]*(\+|\*|\{)/.test(rawPattern)) {
    throw failForm('FORM_FIELD_PATTERN_UNSAFE', 400, 'Nested quantifiers are forbidden in field regex pattern.');
  }
  try {
    return new RegExp(rawPattern);
  } catch {
    throw failForm('FORM_FIELD_PATTERN_INVALID', 400, 'Invalid field regex pattern.');
  }
}

function normalizeAllowedFields(rawFields) {
  if (!Array.isArray(rawFields) || rawFields.length === 0 || rawFields.length > 50) {
    throw failForm('FORM_FIELDS_INVALID', 400, 'allowedFieldsJson must be a non-empty array (1..50 fields).');
  }
  const seen = new Set();
  const normalized = [];
  for (const raw of rawFields) {
    if (!isPlainObject(raw)) {
      throw failForm('FORM_FIELDS_INVALID', 400, 'Each allowed field definition must be an object.');
    }
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!FIELD_NAME_RE.test(name)) {
      throw failForm('FORM_FIELD_INVALID', 400, `Invalid field name: ${name || '<empty>'}`);
    }
    if (BLOCKED_TARGET_FIELDS.has(name) || SENSITIVE_FIELD_NAME_RE.test(name)) {
      throw failForm('FORM_FIELD_FORBIDDEN', 400, `Field "${name}" cannot be exposed on public forms.`);
    }
    if (seen.has(name)) {
      throw failForm('FORM_FIELD_DUPLICATE', 400, `Duplicate field "${name}" in allowedFieldsJson.`);
    }
    seen.add(name);

    const type = raw.type ? String(raw.type).trim().toLowerCase() : 'string';
    if (!ALLOWED_FIELD_TYPES.has(type)) {
      throw failForm('FORM_FIELD_TYPE_INVALID', 400, `Unsupported field type "${type}" for "${name}".`);
    }

    const label = typeof raw.label === 'string' && raw.label.trim()
      ? raw.label.trim().slice(0, 120)
      : name;
    const required = Boolean(raw.required);
    const maxLengthRaw = raw.maxLength != null ? Number(raw.maxLength) : DEFAULT_MAX_FIELD_LENGTH;
    if (!Number.isFinite(maxLengthRaw) || maxLengthRaw < 1 || maxLengthRaw > MAX_FIELD_LENGTH_CAP) {
      throw failForm('FORM_FIELD_MAXLENGTH_INVALID', 400, `Invalid maxLength for field "${name}".`);
    }

    let options = undefined;
    const rawOpts = raw.options ?? raw.enum;
    if (rawOpts !== undefined) {
      if (!Array.isArray(rawOpts) || rawOpts.length === 0 || rawOpts.length > 100) {
        throw failForm('FORM_FIELD_OPTIONS_INVALID', 400, `Options for "${name}" must be a non-empty array (<= 100).`);
      }
      options = rawOpts.map((opt) => {
        if (typeof opt !== 'string' && typeof opt !== 'number') {
          throw failForm('FORM_FIELD_OPTIONS_INVALID', 400, `Option values for "${name}" must be strings or numbers.`);
        }
        return String(opt).slice(0, 200);
      });
    } else if (type === 'select') {
      throw failForm('FORM_FIELD_OPTIONS_INVALID', 400, `Select field "${name}" requires options.`);
    }

    const min = raw.min !== undefined && raw.min !== null ? Number(raw.min) : undefined;
    const max = raw.max !== undefined && raw.max !== null ? Number(raw.max) : undefined;
    if ((min !== undefined && !Number.isFinite(min)) || (max !== undefined && !Number.isFinite(max))) {
      throw failForm('FORM_FIELD_BOUNDS_INVALID', 400, `Invalid min/max bounds for "${name}".`);
    }
    if (min !== undefined && max !== undefined && min > max) {
      throw failForm('FORM_FIELD_BOUNDS_INVALID', 400, `min cannot exceed max for "${name}".`);
    }

    const pattern = raw.pattern ? String(raw.pattern) : undefined;
    if (pattern) compileBoundedPattern(pattern);

    normalized.push({
      name,
      label,
      type,
      required,
      maxLength: Math.floor(maxLengthRaw),
      ...(options ? { options } : {}),
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
      ...(pattern ? { pattern } : {}),
      ...(typeof raw.placeholder === 'string' && raw.placeholder.trim()
        ? { placeholder: raw.placeholder.trim().slice(0, 160) }
        : {}),
    });
  }
  return normalized;
}

function normalizeDefaultValues(rawDefaults) {
  if (rawDefaults === undefined || rawDefaults === null) return null;
  if (!isPlainObject(rawDefaults)) {
    throw failForm('FORM_DEFAULTS_INVALID', 400, 'defaultValuesJson must be a plain object.');
  }
  const clean = {};
  for (const [key, entry] of Object.entries(rawDefaults)) {
    if (!FIELD_NAME_RE.test(key) || BLOCKED_TARGET_FIELDS.has(key) || SENSITIVE_FIELD_NAME_RE.test(key)) {
      throw failForm('FORM_FIELD_FORBIDDEN', 400, `Default field "${key}" is forbidden.`);
    }
    if (entry !== null && typeof entry !== 'string' && typeof entry !== 'number' && typeof entry !== 'boolean') {
      throw failForm('FORM_DEFAULTS_INVALID', 400, `Default value for "${key}" must be primitive.`);
    }
    clean[key] = typeof entry === 'string' ? entry.slice(0, DEFAULT_MAX_FIELD_LENGTH) : entry;
  }
  return clean;
}

function validatePublicFormDefinition(raw) {
  assertNoPrototypePollution(raw);
  if (!isPlainObject(raw)) {
    throw failForm('FORM_INVALID_PAYLOAD', 400, 'Public form payload must be an object.');
  }

  const slug = typeof raw.slug === 'string' ? raw.slug.trim().toLowerCase() : '';
  if (!SLUG_RE.test(slug)) {
    throw failForm('FORM_SLUG_INVALID', 400, 'Form slug must match /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.');
  }
  if (RESERVED_FORM_SLUGS.has(slug)) {
    throw failForm('FORM_SLUG_RESERVED', 400, `Form slug "${slug}" is reserved.`);
  }

  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!title || title.length > 180) {
    throw failForm('FORM_TITLE_REQUIRED', 400, 'Form title is required (1..180 chars).');
  }

  const targetCollection = typeof raw.targetCollection === 'string' ? raw.targetCollection.trim() : '';
  if (!isAllowlistedPublicFormCollection(targetCollection)) {
    throw failForm('FORM_TARGET_COLLECTION_FORBIDDEN', 400, `Collection "${targetCollection}" is not allowlisted for public forms.`);
  }

  const allowedFieldsJson = normalizeAllowedFields(raw.allowedFieldsJson);
  const defaultValuesJson = normalizeDefaultValues(raw.defaultValuesJson);

  const honeypotField = typeof raw.honeypotField === 'string' && raw.honeypotField.trim()
    ? raw.honeypotField.trim()
    : '_hp_website';
  if (!HONEYPOT_NAME_RE.test(honeypotField)) {
    throw failForm('FORM_HONEYPOT_INVALID', 400, 'Invalid honeypotField name.');
  }

  const rlRaw = raw.rateLimitPerMinute != null ? Number(raw.rateLimitPerMinute) : DEFAULT_RATE_LIMIT_PER_MIN;
  if (!Number.isFinite(rlRaw) || rlRaw < 1 || rlRaw > 300) {
    throw failForm('FORM_RATE_LIMIT_INVALID', 400, 'rateLimitPerMinute must be between 1 and 300.');
  }

  let workflowRuleKey = null;
  if (raw.workflowRuleKey != null && String(raw.workflowRuleKey).trim() !== '') {
    workflowRuleKey = String(raw.workflowRuleKey).trim();
    if (!WORKFLOW_KEY_RE.test(workflowRuleKey)) {
      throw failForm('FORM_WORKFLOW_KEY_INVALID', 400, 'Invalid workflowRuleKey.');
    }
  }

  return {
    slug,
    title,
    description: typeof raw.description === 'string' ? raw.description.trim().slice(0, 2000) : '',
    targetCollection,
    allowedFieldsJson,
    defaultValuesJson,
    requireAccessToken: Boolean(raw.requireAccessToken),
    honeypotField,
    rateLimitPerMinute: Math.floor(rlRaw),
    workflowRuleKey,
    active: raw.active === undefined ? true : Boolean(raw.active),
  };
}

function sanitizeFileFieldValue(field, raw) {
  let filename = 'attachment';
  let mimeType = '';
  let base64Body = '';

  if (typeof raw === 'string') {
    const m = raw.trim().match(/^data:([^;,\s]+);base64,([A-Za-z0-9+/=\s]+)$/);
    if (!m) {
      throw failForm('FORM_FILE_CONTENT_INVALID', 400, `Field "${field.name}" must be a valid file upload.`);
    }
    mimeType = m[1].toLowerCase();
    base64Body = m[2].replace(/\s+/g, '');
  } else if (isPlainObject(raw)) {
    const rawName = typeof raw.filename === 'string' ? raw.filename.trim() : (typeof raw.name === 'string' ? raw.name.trim() : '');
    if (rawName) {
      if (rawName.includes('..') || rawName.includes('/') || rawName.includes('\\') || /[\x00-\x1f\x7f]/.test(rawName)) {
        throw failForm('FORM_FILE_NAME_INVALID', 400, `Invalid filename for "${field.name}".`);
      }
      filename = rawName.slice(0, 180);
    }
    if (typeof raw.dataUrl === 'string' && raw.dataUrl.trim()) {
      const m = raw.dataUrl.trim().match(/^data:([^;,\s]+);base64,([A-Za-z0-9+/=\s]+)$/);
      if (!m) {
        throw failForm('FORM_FILE_CONTENT_INVALID', 400, `Invalid file dataUrl for "${field.name}".`);
      }
      mimeType = m[1].toLowerCase();
      base64Body = m[2].replace(/\s+/g, '');
    } else {
      mimeType = typeof raw.mimeType === 'string' ? raw.mimeType.trim().toLowerCase() : '';
      base64Body = typeof raw.contentBase64 === 'string' ? raw.contentBase64.replace(/\s+/g, '') : '';
    }
  } else {
    throw failForm('FORM_FILE_TYPE_MISMATCH', 400, `Field "${field.name}" must be a file object.`);
  }

  if (!ALLOWED_FILE_MIME_TYPES.has(mimeType)) {
    throw failForm('FORM_FILE_TYPE_INVALID', 400, `File type "${mimeType || 'unknown'}" is not allowed for "${field.name}".`);
  }
  if (!base64Body || base64Body.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64Body)) {
    throw failForm('FORM_FILE_CONTENT_INVALID', 400, `Invalid base64 content for "${field.name}".`);
  }
  const maxBytes = Math.min(MAX_FILE_UPLOAD_BYTES, Math.max(1024, Number(field.maxSizeBytes) || MAX_FILE_UPLOAD_BYTES));
  const decoded = Buffer.from(base64Body, 'base64');
  if (!decoded.length) {
    throw failForm('FORM_FILE_CONTENT_INVALID', 400, `Empty file content for "${field.name}".`);
  }
  if (decoded.length > maxBytes) {
    throw failForm('FORM_FILE_TOO_LARGE', 400, `File "${filename}" exceeds maximum size (${maxBytes} bytes).`);
  }

  let magicOk = false;
  if (mimeType === 'application/pdf') {
    magicOk = decoded.length >= 5 && decoded.subarray(0, 5).toString('ascii') === '%PDF-';
  } else if (mimeType === 'image/png') {
    magicOk = decoded.length >= 8
      && decoded[0] === 0x89 && decoded[1] === 0x50 && decoded[2] === 0x4e && decoded[3] === 0x47
      && decoded[4] === 0x0d && decoded[5] === 0x0a && decoded[6] === 0x1a && decoded[7] === 0x0a;
  } else if (mimeType === 'image/jpeg') {
    magicOk = decoded.length >= 3 && decoded[0] === 0xff && decoded[1] === 0xd8 && decoded[2] === 0xff;
  } else if (mimeType === 'image/webp') {
    magicOk = decoded.length >= 12
      && decoded.subarray(0, 4).toString('ascii') === 'RIFF'
      && decoded.subarray(8, 12).toString('ascii') === 'WEBP';
  } else if (mimeType === 'text/plain') {
    const hasNull = decoded.includes(0x00);
    const headLower = decoded.subarray(0, 256).toString('utf8').trimStart();
    magicOk = !hasNull && !/^<(?:!--|(?:!doctype|\?xml|html|script|svg|iframe|object|embed)\b)/i.test(headLower);
  }
  if (!magicOk) {
    throw failForm('FORM_FILE_CONTENT_INVALID', 400, `File content for "${filename}" does not match declared MIME type "${mimeType}".`);
  }

  const sha256 = createHash('sha256').update(decoded).digest('hex');
  const meta = { filename, mimeType, sizeBytes: decoded.length, sha256 };
  return {
    meta,
    attachment: {
      fieldName: field.name,
      filename,
      mimeType,
      sizeBytes: decoded.length,
      sha256,
      contentBase64: decoded.toString('base64'),
    },
  };
}

function sanitizeSubmissionPayload(formDef, rawValues, outAttachments = null) {
  assertNoPrototypePollution(rawValues);
  if (!isPlainObject(rawValues)) {
    throw failForm('FORM_VALUES_INVALID', 400, 'Submission values must be a plain object.');
  }

  const fields = Array.isArray(formDef?.allowedFieldsJson) ? formDef.allowedFieldsJson : [];
  const allowedMap = new Map(fields.map((f) => [f.name, f]));

  for (const key of Object.getOwnPropertyNames(rawValues)) {
    if (BLOCKED_TARGET_FIELDS.has(key) || !allowedMap.has(key)) {
      throw failForm('FORM_FIELD_NOT_ALLOWED', 400, `Field "${key}" is not allowed for this public form.`);
    }
  }

  const clean = {};
  for (const field of fields) {
    const raw = Object.hasOwn(rawValues, field.name) ? rawValues[field.name] : undefined;
    const isEmpty = raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '');
    if (isEmpty) {
      if (field.required) {
        throw failForm('FORM_FIELD_REQUIRED', 400, `Field "${field.name}" is required.`);
      }
      continue;
    }

    if (field.type === 'file') {
      const { meta, attachment } = sanitizeFileFieldValue(field, raw);
      clean[field.name] = meta;
      if (Array.isArray(outAttachments)) {
        outAttachments.push(attachment);
      }
      continue;
    }

    const maxLen = Math.min(MAX_FIELD_LENGTH_CAP, Math.max(1, Number(field.maxLength) || DEFAULT_MAX_FIELD_LENGTH));

    if (field.type === 'number' || field.type === 'integer') {
      if (typeof raw === 'object' || typeof raw === 'boolean') {
        throw failForm('FORM_FIELD_TYPE_MISMATCH', 400, `Field "${field.name}" must be numeric.`);
      }
      const num = Number(raw);
      if (!Number.isFinite(num) || (field.type === 'integer' && !Number.isInteger(num))) {
        throw failForm('FORM_FIELD_TYPE_MISMATCH', 400, `Field "${field.name}" must be a valid ${field.type}.`);
      }
      if (field.min !== undefined && num < field.min) {
        throw failForm('FORM_FIELD_OUT_OF_RANGE', 400, `Field "${field.name}" must be >= ${field.min}.`);
      }
      if (field.max !== undefined && num > field.max) {
        throw failForm('FORM_FIELD_OUT_OF_RANGE', 400, `Field "${field.name}" must be <= ${field.max}.`);
      }
      clean[field.name] = num;
      continue;
    }

    if (field.type === 'boolean') {
      if (typeof raw === 'boolean') {
        clean[field.name] = raw;
      } else if (raw === 'true' || raw === '1' || raw === 1) {
        clean[field.name] = true;
      } else if (raw === 'false' || raw === '0' || raw === 0) {
        clean[field.name] = false;
      } else {
        throw failForm('FORM_FIELD_TYPE_MISMATCH', 400, `Field "${field.name}" must be boolean.`);
      }
      continue;
    }

    if (typeof raw !== 'string' && typeof raw !== 'number') {
      throw failForm('FORM_FIELD_TYPE_MISMATCH', 400, `Field "${field.name}" must be a text value.`);
    }
    const str = field.type === 'text' ? String(raw) : String(raw).trim();
    if (str.length > maxLen) {
      throw failForm('FORM_FIELD_TOO_LONG', 400, `Field "${field.name}" exceeds max length (${maxLen}).`);
    }

    if (field.type === 'email' && !EMAIL_RE.test(str)) {
      throw failForm('FORM_FIELD_EMAIL_INVALID', 400, `Field "${field.name}" must be a valid email address.`);
    }

    if (field.type === 'date') {
      const ts = Date.parse(str);
      if (!Number.isFinite(ts)) {
        throw failForm('FORM_FIELD_DATE_INVALID', 400, `Field "${field.name}" must be a valid ISO date.`);
      }
    }

    const opts = Array.isArray(field.options) ? field.options : (Array.isArray(field.enum) ? field.enum : null);
    if (opts && !opts.map(String).includes(str)) {
      throw failForm('FORM_FIELD_OPTION_INVALID', 400, `Field "${field.name}" value is not in allowed options.`);
    }

    if (field.pattern) {
      const re = compileBoundedPattern(field.pattern);
      if (re && !re.test(str)) {
        throw failForm('FORM_FIELD_PATTERN_MISMATCH', 400, `Field "${field.name}" does not match expected format.`);
      }
    }

    clean[field.name] = str;
  }

  return clean;
}

function createSlidingWindowRateLimiter({ maxEntries = 10000, windowMs = 60_000 } = {}) {
  const entries = new Map();

  function sweep(now) {
    const cutoff = now - windowMs;
    for (const [key, list] of entries.entries()) {
      const fresh = list.filter((ts) => ts > cutoff);
      if (fresh.length === 0) {
        entries.delete(key);
      } else if (fresh.length !== list.length) {
        entries.set(key, fresh);
      }
    }
  }

  return {
    peekCount(key, now = Date.now()) {
      const list = entries.get(key);
      if (!list || !list.length) return 0;
      const cutoff = now - windowMs;
      return list.filter((ts) => ts > cutoff).length;
    },
    consume(key, limit = DEFAULT_RATE_LIMIT_PER_MIN, now = Date.now()) {
      const cap = Math.max(1, Math.min(1000, Math.floor(Number(limit) || DEFAULT_RATE_LIMIT_PER_MIN)));
      const cutoff = now - windowMs;
      const prev = entries.get(key) || [];
      const active = prev.filter((ts) => ts > cutoff);
      if (active.length >= cap) {
        entries.delete(key);
        entries.set(key, active);
        const oldest = active[0];
        const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
        return { allowed: false, remaining: 0, retryAfterSec };
      }
      active.push(now);
      entries.delete(key);
      entries.set(key, active);

      if (entries.size > maxEntries) {
        sweep(now);
        while (entries.size > maxEntries) {
          const oldestKey = entries.keys().next().value;
          if (oldestKey === undefined) break;
          entries.delete(oldestKey);
        }
      }

      return { allowed: true, remaining: Math.max(0, cap - active.length), retryAfterSec: 0 };
    },
    clear() {
      entries.clear();
    },
    size() {
      return entries.size;
    },
  };
}

function readHeader(ctx, name) {
  if (typeof ctx?.get === 'function') {
    const direct = ctx.get(name);
    if (typeof direct === 'string' && direct.trim()) return direct.trim();
  }
  const lower = String(name || '').toLowerCase();
  for (const bag of [ctx?.headers, ctx?.request?.headers]) {
    if (!bag || typeof bag !== 'object') continue;
    for (const [k, v] of Object.entries(bag)) {
      if (k.toLowerCase() === lower && typeof v === 'string' && v.trim()) {
        return v.trim();
      }
    }
  }
  return '';
}

function resolveClientIp(ctx, options = {}) {
  const trustProxy = options?.trustProxy === true || process.env.DX_TRUST_PROXY === 'true';
  const directIp = String(ctx?.ip || ctx?.request?.ip || '').trim();
  if (trustProxy || !directIp) {
    const fwd = readHeader(ctx, 'x-forwarded-for');
    if (fwd) {
      const first = fwd.split(',')[0].trim();
      if (first) return first.slice(0, 64);
    }
  }
  return directIp ? directIp.slice(0, 64) : 'unknown';
}

function serializePublicMeta(form) {
  const fields = Array.isArray(val(form, 'allowedFieldsJson')) ? val(form, 'allowedFieldsJson') : [];
  return {
    slug: String(val(form, 'slug') || ''),
    title: String(val(form, 'title') || ''),
    description: String(val(form, 'description') || ''),
    fields: fields.map((f) => ({
      name: f.name,
      label: f.label || f.name,
      type: f.type || 'string',
      required: Boolean(f.required),
      maxLength: f.maxLength ?? DEFAULT_MAX_FIELD_LENGTH,
      ...(Array.isArray(f.options) ? { options: f.options } : {}),
      ...(f.min !== undefined ? { min: f.min } : {}),
      ...(f.max !== undefined ? { max: f.max } : {}),
      ...(f.pattern ? { pattern: f.pattern } : {}),
      ...(f.placeholder ? { placeholder: f.placeholder } : {}),
    })),
    honeypotField: String(val(form, 'honeypotField') || '_hp_website'),
    requireAccessToken: Boolean(val(form, 'requireAccessToken') || val(form, 'accessTokenHash')),
    active: val(form, 'active') !== false,
  };
}

function serializeAdminForm(form) {
  if (!form) return null;
  return {
    id: val(form, 'id') ?? null,
    organizationId: val(form, 'organizationId') || null,
    slug: val(form, 'slug') || '',
    title: val(form, 'title') || '',
    description: val(form, 'description') || '',
    targetCollection: val(form, 'targetCollection') || '',
    allowedFieldsJson: Array.isArray(val(form, 'allowedFieldsJson')) ? val(form, 'allowedFieldsJson') : [],
    defaultValuesJson: val(form, 'defaultValuesJson') ?? null,
    requireAccessToken: Boolean(val(form, 'requireAccessToken')),
    hasAccessToken: Boolean(val(form, 'accessTokenHash')),
    honeypotField: val(form, 'honeypotField') || '_hp_website',
    rateLimitPerMinute: Number(val(form, 'rateLimitPerMinute') || DEFAULT_RATE_LIMIT_PER_MIN),
    workflowRuleKey: val(form, 'workflowRuleKey') || null,
    active: val(form, 'active') !== false,
    createdByUserId: val(form, 'createdByUserId') != null ? Number(val(form, 'createdByUserId')) : null,
    createdAt: val(form, 'createdAt') || null,
    updatedAt: val(form, 'updatedAt') || null,
  };
}

async function resolveVerifiedCallerRoles(ctx, db, userId) {
  const claimed = callerRoles(ctx);
  const ruRepo = getRepo(db, 'rolesUsers');
  if (ruRepo && typeof ruRepo.find === 'function' && userId != null) {
    const bindings = (await ruRepo.find({ filter: { userId: Number(userId) } })) || [];
    const assigned = new Set(
      bindings.map((r) => String(val(r, 'roleName') || '').trim()).filter(Boolean),
    );
    if (claimed.length > 0) {
      return claimed.filter((r) => assigned.has(r));
    }
    return [...assigned];
  }
  return claimed;
}

async function isAdminByRoles(db, roleNames) {
  if (!Array.isArray(roleNames) || !roleNames.length) return false;
  if (roleNames.includes('root')) return true;
  const rolesRepo = getRepo(db, 'roles');
  if (!rolesRepo || typeof rolesRepo.find !== 'function') return false;
  const matched = (await rolesRepo.find({ filter: { name: { $in: roleNames } } })) || [];
  return matched.some((role) => {
    const name = val(role, 'name');
    if (name && !roleNames.includes(name)) return false;
    if (val(role, 'allowConfigure') === true) return true;
    const snippets = val(role, 'snippets');
    return Array.isArray(snippets) && (snippets.includes('pm') || snippets.includes('pm.*'));
  });
}

async function ensurePublicFormSubmissionColumns(db) {
  if (!db || ensuredSubmissionDbs.has(db)) return;
  try {
    const subCol = typeof db.getCollection === 'function' ? db.getCollection('latticePublicFormSubmissions') : null;
    if (subCol) {
      for (const fieldName of ['payloadJson', 'attachmentsJson']) {
        const has = typeof subCol.hasField === 'function' ? subCol.hasField(fieldName) : Boolean(subCol.getField?.(fieldName));
        if (!has && typeof subCol.setField === 'function') {
          subCol.setField(fieldName, { type: 'json', name: fieldName });
        } else if (!has && typeof subCol.addField === 'function') {
          subCol.addField(fieldName, { type: 'json' });
        }
      }
    }
  } catch {
    // Non-fatal in minimal mock DBs
  }
  let isPg = false;
  let pgSucceeded = false;
  try {
    const seq = db?.sequelize;
    isPg = Boolean(seq && typeof seq.query === 'function' && (typeof seq.getDialect !== 'function' || seq.getDialect() === 'postgres'));
    if (isPg) {
      const ddl = 'ALTER TABLE "latticePublicFormSubmissions" ADD COLUMN IF NOT EXISTS "payloadJson" JSONB, ADD COLUMN IF NOT EXISTS "attachmentsJson" JSONB;';
      if (canUsePgRlsSession(db)) {
        await withSystemRlsBypass(db, (transaction) => seq.query(ddl, transaction ? { transaction } : undefined));
      } else {
        await seq.query(ddl);
      }
      pgSucceeded = true;
    }
  } catch {
    // Non-fatal if table does not exist yet
  }
  if (!isPg || pgSucceeded) {
    ensuredSubmissionDbs.add(db);
  }
}

async function resolveAdminContext(ctx, db, { requireWriteScope = false, allowManager = false } = {}) {
  if (requireWriteScope) {
    assertApiKeyScope(ctx, ['write']);
  }
  const callerUserId = val(ctx.state?.currentUser, 'id');
  if (callerUserId == null || !/^[1-9]\d*$/.test(String(callerUserId))) {
    throw failForm('NATIVE_LOGIN_REQUIRED', 401, 'Authentication required.');
  }
  const callerRolesVerified = await resolveVerifiedCallerRoles(ctx, db, callerUserId);
  const isRoot = callerRolesVerified.includes('root');
  const isManagerRole = allowManager && callerRolesVerified.some((r) => ['ldx_manager', 'ldx_admin', 'admin'].includes(r));
  const isAdmin = isRoot || isManagerRole || (await isAdminByRoles(db, callerRolesVerified));
  if (!isAdmin) {
    throw failForm('FORM_ADMIN_REQUIRED', 403, 'Administrator role is required to manage public forms.');
  }

  const params = readParams(ctx);
  let organizationId = null;
  if (isRoot) {
    if (params.organizationId != null && String(params.organizationId).trim() !== '') {
      const cleanOrg = String(params.organizationId).trim();
      if (!isValidOrganizationId(cleanOrg)) {
        throw failForm('FORM_ORG_INVALID', 400, 'Invalid organizationId.');
      }
      organizationId = cleanOrg;
    }
  } else {
    const actor = await resolveNativeActor(db, ctx.state.currentUser);
    organizationId = actor.organizationId;
    if (params.organizationId !== undefined && String(params.organizationId).trim() !== organizationId) {
      throw failForm('NATIVE_ORGANIZATION_MISMATCH', 403, 'Cross-organization form management is forbidden.');
    }
  }

  return {
    callerUserId: Number(callerUserId),
    isRoot,
    organizationId,
    params,
  };
}

function runWithRls(db, isRoot, organizationId, fn) {
  if (!canUsePgRlsSession(db)) {
    return fn(undefined);
  }
  if (isRoot && !organizationId) {
    return withSystemRlsBypass(db, fn);
  }
  return withTenantRlsContext(db, organizationId, fn);
}

async function lookupFormBySlug(db, slug) {
  const formRepo = getRepo(db, 'latticePublicForms');
  if (!formRepo || typeof formRepo.findOne !== 'function') {
    throw failForm('FORM_REPO_UNAVAILABLE', 503, 'Public forms repository unavailable.');
  }
  const runFind = (transaction) => formRepo.findOne({
    filter: { slug },
    ...(transaction ? { transaction } : {}),
  });
  return canUsePgRlsSession(db) ? withSystemRlsBypass(db, runFind) : runFind(undefined);
}

function createDxosFormsActions(db, options = {}) {
  const rateLimiter = options.rateLimiter || createSlidingWindowRateLimiter();
  const nowFn = typeof options.now === 'function' ? options.now : () => Date.now();

  const findFormBySlug = (slug) => lookupFormBySlug(db, slug);

  return {
    meta: async (ctx, next) => {
      if ((ctx.method || 'GET').toUpperCase() !== 'GET') ctx.throw(405);
      const params = readParams(ctx);
      assertNoPrototypePollution(params);
      const slug = typeof params.slug === 'string' ? params.slug.trim().toLowerCase() : '';
      if (!SLUG_RE.test(slug) || RESERVED_FORM_SLUGS.has(slug)) {
        throw failForm('FORM_SLUG_INVALID', 400, 'Invalid form slug.');
      }
      const form = await findFormBySlug(slug);
      if (!form || val(form, 'active') !== true) {
        throw failForm('FORM_NOT_FOUND', 404, 'Public form not found or inactive.');
      }
      ctx.body = serializePublicMeta(form);
      if (next) return next();
    },

    submit: async (ctx, next) => {
      if ((ctx.method || 'POST').toUpperCase() !== 'POST') ctx.throw(405);
      const rawBody = isPlainObject(ctx.request?.body) ? ctx.request.body : {};
      const rawParams = isPlainObject(ctx.action?.params) ? ctx.action.params : {};
      assertNoPrototypePollution(rawBody);
      assertNoPrototypePollution(rawParams);

      const rawValues = isPlainObject(rawBody.values)
        ? rawBody.values
        : (isPlainObject(rawBody.data) ? rawBody.data : (isPlainObject(rawParams.values) ? rawParams.values : null));

      if (Object.hasOwn(rawBody, 'organizationId') || (rawValues && Object.hasOwn(rawValues, 'organizationId'))) {
        throw failForm('FORM_ORG_OVERRIDE_FORBIDDEN', 400, 'Client cannot specify organizationId on public form submission.');
      }

      const params = readParams(ctx);
      const slug = typeof params.slug === 'string' ? params.slug.trim().toLowerCase() : '';
      if (!SLUG_RE.test(slug) || RESERVED_FORM_SLUGS.has(slug)) {
        throw failForm('FORM_SLUG_INVALID', 400, 'Invalid form slug.');
      }

      const clientIp = resolveClientIp(ctx, options);
      const now = nowFn();
      if (rateLimiter.peekCount(`${clientIp}:__flood__`, now) >= PRE_LOOKUP_IP_FLOOD_LIMIT) {
        ctx.set?.('Retry-After', '60');
        throw failForm('RATE_LIMIT_EXCEEDED', 429, 'Too many requests; please retry later.');
      }

      const form = await findFormBySlug(slug);
      const formLimit = form
        ? Math.max(1, Math.min(300, Number(val(form, 'rateLimitPerMinute')) || DEFAULT_RATE_LIMIT_PER_MIN))
        : DEFAULT_RATE_LIMIT_PER_MIN;

      rateLimiter.consume(`${clientIp}:__flood__`, PRE_LOOKUP_IP_FLOOD_LIMIT, now);
      const rl = rateLimiter.consume(`${clientIp}:${slug}`, formLimit, now);
      if (!rl.allowed) {
        ctx.set?.('Retry-After', String(rl.retryAfterSec));
        throw failForm('RATE_LIMIT_EXCEEDED', 429, 'Form submission rate limit exceeded.');
      }

      const providedToken = String(
        rawBody.token ?? rawBody.accessToken ?? params.token ?? readHeader(ctx, 'x-form-token') ?? '',
      ).trim();
      const providedTokenHash = sha256Hex(providedToken || 'missing');
      const storedTokenHash = form && val(form, 'accessTokenHash') ? String(val(form, 'accessTokenHash')) : DUMMY_HASH_HEX;
      const tokenMatched = timingSafeEqualHex(providedTokenHash, storedTokenHash);

      if (!form || val(form, 'active') !== true) {
        throw failForm('FORM_NOT_FOUND', 404, 'Public form not found or inactive.');
      }

      const honeypotField = String(val(form, 'honeypotField') || '_hp_website');
      for (const candidateKey of new Set([honeypotField, '_hp_website'])) {
        for (const bag of [rawBody, rawParams, rawValues]) {
          if (bag && Object.hasOwn(bag, candidateKey) && String(bag[candidateKey] ?? '').trim() !== '') {
            throw failForm('FORM_BOT_DETECTED', 400, 'Submission rejected by bot protection.');
          }
        }
      }

      const requiresToken = Boolean(val(form, 'requireAccessToken') || val(form, 'accessTokenHash'));
      if (requiresToken && (!providedToken || !tokenMatched)) {
        throw failForm('FORM_ACCESS_TOKEN_INVALID', 401, 'Valid form access token is required.');
      }

      const targetCollection = String(val(form, 'targetCollection') || '').trim();
      if (!isAllowlistedPublicFormCollection(targetCollection)) {
        throw failForm('FORM_TARGET_COLLECTION_FORBIDDEN', 403, 'Target collection is not allowlisted.');
      }

      const formOrgId = String(val(form, 'organizationId') || '').trim();
      if (!isValidOrganizationId(formOrgId)) {
        throw failForm('FORM_ORG_INVALID', 500, 'Persisted form organizationId is invalid.');
      }

      const formPlain = {
        allowedFieldsJson: Array.isArray(val(form, 'allowedFieldsJson')) ? val(form, 'allowedFieldsJson') : [],
      };
      const attachments = [];
      const cleanValues = sanitizeSubmissionPayload(formPlain, rawValues || {}, attachments);
      const defaults = isPlainObject(val(form, 'defaultValuesJson')) ? val(form, 'defaultValuesJson') : {};
      const safeDefaults = {};
      for (const [k, v] of Object.entries(defaults)) {
        if (!BLOCKED_TARGET_FIELDS.has(k) && !SENSITIVE_FIELD_NAME_RE.test(k)) {
          safeDefaults[k] = v;
        }
      }

      const recordCode = cleanValues.code || `FRM-${randomBytes(4).toString('hex').toUpperCase()}`;
      const recordName = cleanValues.name
        || `${String(cleanValues.title || cleanValues.subject || val(form, 'title') || 'Public Form').slice(0, 120)} #${recordCode}`;

      const submittedAt = new Date();
      const isVoucherTarget = VOUCHER_COLLECTIONS.has(targetCollection);
      const targetColMeta = typeof db?.getCollection === 'function' ? db.getCollection(targetCollection) : null;
      const colHasStatusField = Boolean(
        targetColMeta && (
          typeof targetColMeta.hasField === 'function' ? targetColMeta.hasField('status') : targetColMeta.getField?.('status')
        ),
      );
      const shouldInitializeSubmitted = isVoucherTarget
        || PUBLIC_STATUS_COLLECTIONS.has(targetCollection)
        || colHasStatusField
        || Object.hasOwn(safeDefaults, 'status')
        || Object.hasOwn(cleanValues, 'status');

      const fileFieldNames = new Set(
        formPlain.allowedFieldsJson.filter((f) => f && f.type === 'file').map((f) => f.name),
      );
      const cleanTargetValues = {};
      const receiptExtraPayload = {};
      for (const [k, v] of Object.entries(cleanValues)) {
        if (fileFieldNames.has(k)) {
          receiptExtraPayload[k] = v;
          const hasTargetColField = Boolean(
            targetColMeta && (
              typeof targetColMeta.hasField === 'function' ? targetColMeta.hasField(k) : targetColMeta.getField?.(k)
            ),
          );
          if (hasTargetColField && v && typeof v === 'object') {
            cleanTargetValues[k] = v.filename || '';
          }
          continue;
        }
        cleanTargetValues[k] = v;
        if (targetColMeta) {
          const hasTargetColField = Boolean(
            typeof targetColMeta.hasField === 'function' ? targetColMeta.hasField(k) : targetColMeta.getField?.(k),
          );
          if (!hasTargetColField) {
            receiptExtraPayload[k] = v;
          }
        }
      }

      const targetPayload = {
        ...safeDefaults,
        ...cleanTargetValues,
        code: recordCode,
        name: recordName,
        active: true,
        organizationId: formOrgId,
        ...(shouldInitializeSubmitted ? { status: 'submitted' } : {}),
        ...(isVoucherTarget
          ? { status: 'submitted', version: 1, amendmentNo: 0, submittedAt }
          : {}),
      };

      const submissionCode = `LDX-FRM-${randomBytes(4).toString('hex').toUpperCase()}`;
      const statusToken = `ldx_frm_${randomBytes(24).toString('hex')}`;
      const statusTokenHash = sha256Hex(statusToken);

      await ensurePublicFormSubmissionColumns(db);

      const executeSubmit = async (transaction) => {
        const txOpt = transaction ? { transaction } : {};
        const targetRepo = getRepo(db, targetCollection);
        if (!targetRepo || typeof targetRepo.create !== 'function') {
          throw failForm('FORM_TARGET_REPO_UNAVAILABLE', 503, `Target collection ${targetCollection} unavailable.`);
        }
        const createdTarget = await targetRepo.create({ values: targetPayload, ...txOpt });
        const targetRecordId = String(val(createdTarget, 'id') ?? recordCode);

        const subRepo = getRepo(db, 'latticePublicFormSubmissions');
        if (!subRepo || typeof subRepo.create !== 'function') {
          throw failForm('FORM_SUBMISSION_REPO_UNAVAILABLE', 503, 'Submission receipt repository unavailable.');
        }
        await subRepo.create({
          values: {
            organizationId: formOrgId,
            formId: Number(val(form, 'id')),
            slug,
            submissionCode,
            statusTokenHash,
            targetCollection,
            targetRecordId,
            status: 'submitted',
            ...(Object.keys(receiptExtraPayload).length > 0 ? { payloadJson: receiptExtraPayload } : {}),
            ...(attachments.length > 0 ? { attachmentsJson: attachments } : {}),
            submittedAt,
          },
          ...txOpt,
        });

        try {
          const { publishDomainEvent } = require('./event-bus');
          if (typeof publishDomainEvent === 'function') {
            await publishDomainEvent(db, {
              organizationId: formOrgId,
              eventType: 'public_form.submitted',
              source: 'dxosForms',
              subject: submissionCode,
              data: {
                slug,
                submissionCode,
                targetCollection,
                targetRecordId,
                workflowRuleKey: val(form, 'workflowRuleKey') || null,
              },
              transaction,
            }).catch(() => {});
          }
        } catch {
          // Non-fatal if event bus is not mounted in unit test environment
        }
      };

      if (canUsePgRlsSession(db)) {
        await withTenantRlsContext(db, formOrgId, executeSubmit);
      } else {
        await executeSubmit(undefined);
      }

      ctx.body = {
        ok: true,
        slug,
        submissionCode,
        statusToken,
        status: 'submitted',
        submittedAt: submittedAt.toISOString(),
      };
      if (next) return next();
    },

    status: async (ctx, next) => {
      if ((ctx.method || 'GET').toUpperCase() !== 'GET') ctx.throw(405);
      const params = readParams(ctx);
      assertNoPrototypePollution(params);

      const slug = typeof params.slug === 'string' ? params.slug.trim().toLowerCase() : '';
      const submissionCode = String(params.submissionCode ?? params.code ?? '').trim();
      const providedToken = String(params.token ?? readHeader(ctx, 'x-form-token') ?? '').trim();

      const clientIp = resolveClientIp(ctx, options);
      const rl = rateLimiter.consume(`${clientIp}:status:${slug || 'unknown'}`, STATUS_RATE_LIMIT_PER_MIN, nowFn());
      if (!rl.allowed) {
        ctx.set?.('Retry-After', String(rl.retryAfterSec));
        throw failForm('RATE_LIMIT_EXCEEDED', 429, 'Status lookup rate limit exceeded.');
      }

      const providedHash = sha256Hex(providedToken || 'missing');

      if (!SLUG_RE.test(slug) || !SUBMISSION_CODE_RE.test(submissionCode) || !providedToken) {
        timingSafeEqualHex(providedHash, DUMMY_HASH_HEX);
        throw failForm('FORM_STATUS_UNAUTHORIZED', 401, 'Invalid status lookup credentials.');
      }

      const subRepo = getRepo(db, 'latticePublicFormSubmissions');
      if (!subRepo || typeof subRepo.findOne !== 'function') {
        throw failForm('FORM_SUBMISSION_REPO_UNAVAILABLE', 503, 'Submission repository unavailable.');
      }

      const findSub = (transaction) => subRepo.findOne({
        filter: { slug, submissionCode },
        ...(transaction ? { transaction } : {}),
      });
      const submission = canUsePgRlsSession(db) ? await withSystemRlsBypass(db, findSub) : await findSub(undefined);
      const expectedHash = submission ? String(val(submission, 'statusTokenHash') || '') : DUMMY_HASH_HEX;
      const tokenMatched = timingSafeEqualHex(providedHash, expectedHash);

      if (!submission || !tokenMatched) {
        throw failForm('FORM_STATUS_UNAUTHORIZED', 401, 'Invalid status lookup credentials.');
      }

      const subOrgId = String(val(submission, 'organizationId') || '').trim();
      const targetCollection = String(val(submission, 'targetCollection') || '').trim();
      const targetRecordId = String(val(submission, 'targetRecordId') || '').trim();
      let liveStatus = String(val(submission, 'status') || 'submitted');
      let updatedAt = val(submission, 'updatedAt') || val(submission, 'submittedAt') || null;

      if (isValidOrganizationId(subOrgId) && isAllowlistedPublicFormCollection(targetCollection) && /^[1-9]\d*$/.test(targetRecordId)) {
        const readLiveStatus = async (transaction) => {
          const targetRepo = getRepo(db, targetCollection);
          if (!targetRepo || typeof targetRepo.findOne !== 'function') return null;
          const colMeta = typeof db?.getCollection === 'function' ? db.getCollection(targetCollection) : null;
          const hasStatus = colMeta
            ? Boolean(typeof colMeta.hasField === 'function' ? colMeta.hasField('status') : colMeta.getField?.('status'))
            : true;
          return targetRepo.findOne({
            filter: { id: Number(targetRecordId), organizationId: subOrgId },
            fields: hasStatus ? ['id', 'status', 'updatedAt'] : ['id', 'updatedAt'],
            ...(transaction ? { transaction } : {}),
          });
        };
        const targetRow = canUsePgRlsSession(db)
          ? await withTenantRlsContext(db, subOrgId, readLiveStatus)
          : await readLiveStatus(undefined);
        if (targetRow) {
          if (val(targetRow, 'status')) liveStatus = String(val(targetRow, 'status'));
          if (val(targetRow, 'updatedAt')) updatedAt = val(targetRow, 'updatedAt');
        }
      }

      const submittedAtRaw = val(submission, 'submittedAt');
      ctx.body = {
        slug: String(val(submission, 'slug') || slug),
        submissionCode: String(val(submission, 'submissionCode') || submissionCode),
        status: liveStatus,
        submittedAt: submittedAtRaw instanceof Date ? submittedAtRaw.toISOString() : (submittedAtRaw ? String(submittedAtRaw) : null),
        updatedAt: updatedAt instanceof Date ? updatedAt.toISOString() : (updatedAt ? String(updatedAt) : null),
      };
      if (next) return next();
    },

    list: async (ctx, next) => {
      if ((ctx.method || 'GET').toUpperCase() !== 'GET') ctx.throw(405);
      const { isRoot, organizationId, params } = await resolveAdminContext(ctx, db, { requireWriteScope: false });
      const formRepo = getRepo(db, 'latticePublicForms');
      if (!formRepo || typeof formRepo.find !== 'function') {
        ctx.body = { organizationId, items: [] };
        if (next) return next();
        return;
      }
      const limit = Math.max(1, Math.min(200, Math.floor(Number(params.limit) || 50)));
      const filter = organizationId ? { organizationId } : {};
      const rows = (await runWithRls(db, isRoot, organizationId, (transaction) => formRepo.find({
        filter,
        sort: ['-id'],
        limit,
        ...(transaction ? { transaction } : {}),
      }))) || [];
      ctx.body = { organizationId, items: rows.map(serializeAdminForm) };
      if (next) return next();
    },

    get: async (ctx, next) => {
      if ((ctx.method || 'GET').toUpperCase() !== 'GET') ctx.throw(405);
      const { isRoot, organizationId, params } = await resolveAdminContext(ctx, db, { requireWriteScope: false });
      const formRepo = getRepo(db, 'latticePublicForms');
      if (!formRepo || typeof formRepo.findOne !== 'function') {
        throw failForm('FORM_NOT_FOUND', 404, 'Public form not found.');
      }
      const id = params.id != null ? Number(params.id) : null;
      const slug = typeof params.slug === 'string' ? params.slug.trim().toLowerCase() : '';
      const filter = { ...(organizationId ? { organizationId } : {}) };
      if (Number.isInteger(id) && id > 0) filter.id = id;
      else if (SLUG_RE.test(slug)) filter.slug = slug;
      else throw failForm('FORM_IDENTIFIER_REQUIRED', 400, 'Valid id or slug is required.');

      const row = await runWithRls(db, isRoot, organizationId, (transaction) => formRepo.findOne({
        filter,
        ...(transaction ? { transaction } : {}),
      }));
      if (!row || (organizationId && val(row, 'organizationId') !== organizationId)) {
        throw failForm('FORM_NOT_FOUND', 404, 'Public form not found.');
      }
      ctx.body = serializeAdminForm(row);
      if (next) return next();
    },

    save: async (ctx, next) => {
      if ((ctx.method || 'POST').toUpperCase() !== 'POST') ctx.throw(405);
      const { callerUserId, isRoot, organizationId, params } = await resolveAdminContext(ctx, db, { requireWriteScope: true });
      const targetOrgId = organizationId || (typeof params.organizationId === 'string' ? params.organizationId.trim() : '');
      if (!isValidOrganizationId(targetOrgId)) {
        throw failForm('FORM_ORG_REQUIRED', 400, 'organizationId is required.');
      }

      const rawBody = isPlainObject(ctx.request?.body) ? ctx.request.body : {};
      assertNoPrototypePollution(rawBody);
      assertNoPrototypePollution(params);

      const validated = validatePublicFormDefinition(params);
      const rawToken = typeof params.accessToken === 'string' ? params.accessToken.trim() : '';
      if (rawToken && rawToken.length < 8) {
        throw failForm('FORM_ACCESS_TOKEN_WEAK', 400, 'accessToken must be at least 8 characters.');
      }

      const formRepo = getRepo(db, 'latticePublicForms');
      if (!formRepo) {
        throw failForm('FORM_REPO_UNAVAILABLE', 503, 'Public forms repository unavailable.');
      }

      const editId = params.id != null ? Number(params.id) : null;
      const isEdit = Boolean(editId && Number.isInteger(editId) && editId > 0);
      const existingBySlug = await findFormBySlug(validated.slug);
      if (!isEdit && existingBySlug) {
        throw failForm('FORM_SLUG_CONFLICT', 409, `Slug "${validated.slug}" is already in use.`);
      }

      const mapUniqueViolation = (err) => {
        const pgCode = err?.code || err?.original?.code || err?.parent?.code;
        if (pgCode === '23505') {
          return failForm('FORM_SLUG_CONFLICT', 409, `Slug "${validated.slug}" is already in use.`);
        }
        return err;
      };

      const saved = await runWithRls(db, isRoot && !organizationId, targetOrgId, async (transaction) => {
        const txOpt = transaction ? { transaction } : {};

        if (isEdit) {
          const existing = await formRepo.findOne({ filter: { id: editId, organizationId: targetOrgId }, ...txOpt });
          if (!existing || val(existing, 'organizationId') !== targetOrgId) {
            throw failForm('FORM_NOT_FOUND', 404, 'Public form not found.');
          }
          if (existingBySlug && Number(val(existingBySlug, 'id')) !== editId) {
            throw failForm('FORM_SLUG_CONFLICT', 409, `Slug "${validated.slug}" is already in use.`);
          }
          const patch = {
            ...validated,
            ...(rawToken ? { accessTokenHash: sha256Hex(rawToken), requireAccessToken: true } : {}),
          };
          try {
            if (typeof existing.update === 'function') {
              return await existing.update(patch, txOpt);
            }
            const res = await formRepo.update({ filterByTk: editId, filter: { organizationId: targetOrgId }, values: patch, ...txOpt });
            return Array.isArray(res) ? res[0] : res;
          } catch (err) {
            throw mapUniqueViolation(err);
          }
        }

        try {
          return await formRepo.create({
            values: {
              ...validated,
              organizationId: targetOrgId,
              accessTokenHash: rawToken ? sha256Hex(rawToken) : null,
              createdByUserId: callerUserId,
            },
            ...txOpt,
          });
        } catch (err) {
          throw mapUniqueViolation(err);
        }
      });

      ctx.body = serializeAdminForm(saved);
      if (next) return next();
    },

    delete: async (ctx, next) => {
      const method = (ctx.method || 'POST').toUpperCase();
      if (method !== 'POST' && method !== 'DELETE') ctx.throw(405);
      const { isRoot, organizationId, params } = await resolveAdminContext(ctx, db, { requireWriteScope: true });
      const id = Number(params.id ?? params.filterByTk);
      if (!Number.isInteger(id) || id <= 0) {
        throw failForm('FORM_ID_REQUIRED', 400, 'Valid form id is required.');
      }

      const formRepo = getRepo(db, 'latticePublicForms');
      if (!formRepo) {
        throw failForm('FORM_NOT_FOUND', 404, 'Public form not found.');
      }

      const filter = organizationId ? { id, organizationId } : { id };
      await runWithRls(db, isRoot, organizationId, async (transaction) => {
        const txOpt = transaction ? { transaction } : {};
        const row = await formRepo.findOne({ filter, ...txOpt });
        if (!row || (organizationId && val(row, 'organizationId') !== organizationId)) {
          throw failForm('FORM_NOT_FOUND', 404, 'Public form not found.');
        }
        if (typeof row.destroy === 'function') {
          await row.destroy(txOpt);
        } else {
          await formRepo.destroy({ filterByTk: id, filter, ...txOpt });
        }
      });

      ctx.body = { ok: true, id };
      if (next) return next();
    },

    rotateToken: async (ctx, next) => {
      if ((ctx.method || 'POST').toUpperCase() !== 'POST') ctx.throw(405);
      const { isRoot, organizationId, params } = await resolveAdminContext(ctx, db, { requireWriteScope: true });
      const id = Number(params.id ?? params.filterByTk);
      if (!Number.isInteger(id) || id <= 0) {
        throw failForm('FORM_ID_REQUIRED', 400, 'Valid form id is required.');
      }

      const formRepo = getRepo(db, 'latticePublicForms');
      if (!formRepo) {
        throw failForm('FORM_NOT_FOUND', 404, 'Public form not found.');
      }

      const accessToken = `ldx_ftok_${randomBytes(24).toString('hex')}`;
      const accessTokenHash = sha256Hex(accessToken);
      const filter = organizationId ? { id, organizationId } : { id };

      const updated = await runWithRls(db, isRoot, organizationId, async (transaction) => {
        const txOpt = transaction ? { transaction } : {};
        const row = await formRepo.findOne({ filter, ...txOpt });
        if (!row || (organizationId && val(row, 'organizationId') !== organizationId)) {
          throw failForm('FORM_NOT_FOUND', 404, 'Public form not found.');
        }
        const patch = { accessTokenHash, requireAccessToken: true };
        if (typeof row.update === 'function') {
          return row.update(patch, txOpt);
        }
        const res = await formRepo.update({ filterByTk: id, filter, values: patch, ...txOpt });
        return Array.isArray(res) ? res[0] : res;
      });

      ctx.body = {
        ...serializeAdminForm(updated),
        accessToken,
      };
      if (next) return next();
    },

    listSubmissions: async (ctx, next) => {
      const method = (ctx.method || 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'POST') ctx.throw(405);
      const { isRoot, organizationId, params } = await resolveAdminContext(ctx, db, { requireWriteScope: false, allowManager: true });
      assertNoPrototypePollution(params);

      let formId = null;
      if (params.formId !== undefined && params.formId !== null && String(params.formId).trim() !== '') {
        const n = Number(params.formId);
        if (!Number.isInteger(n) || n <= 0) {
          throw failForm('FORM_ID_INVALID', 400, 'Invalid formId.');
        }
        formId = n;
      }

      let slug = null;
      if (params.slug !== undefined && params.slug !== null && String(params.slug).trim() !== '') {
        const s = String(params.slug).trim().toLowerCase();
        if (!SLUG_RE.test(s)) {
          throw failForm('FORM_SLUG_INVALID', 400, 'Invalid slug filter.');
        }
        slug = s;
      }

      let status = null;
      if (params.status !== undefined && params.status !== null && String(params.status).trim() !== '') {
        const st = String(params.status).trim();
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(st)) {
          throw failForm('FORM_STATUS_INVALID', 400, 'Invalid status filter.');
        }
        status = st;
      }

      const search = typeof params.search === 'string' ? params.search.trim().slice(0, 120).toLowerCase() : '';
      const page = Math.max(1, Math.floor(Number(params.page) || 1));
      const pageSize = Math.max(1, Math.min(100, Math.floor(Number(params.pageSize ?? params.limit) || 20)));

      await ensurePublicFormSubmissionColumns(db);
      const subRepo = getRepo(db, 'latticePublicFormSubmissions');
      if (!subRepo || typeof subRepo.find !== 'function') {
        ctx.body = { organizationId, items: [], total: 0, page, pageSize };
        if (next) return next();
        return;
      }

      const filter = {
        ...(organizationId ? { organizationId } : {}),
        ...(formId ? { formId } : {}),
        ...(slug ? { slug } : {}),
        ...(status ? { status } : {}),
      };

      const sanitizeStoredPayload = (obj) => {
        if (!isPlainObject(obj)) return {};
        const out = {};
        for (const [k, v] of Object.entries(obj)) {
          if (BLOCKED_PROTO_KEYS.has(k) || SENSITIVE_FIELD_NAME_RE.test(k)) continue;
          out[k] = v;
        }
        return out;
      };

      const sanitizeAttachmentsMeta = (rawAtt) => {
        if (!Array.isArray(rawAtt)) return [];
        return rawAtt
          .filter((a) => a && typeof a === 'object')
          .map((a) => ({
            fieldName: String(a.fieldName || ''),
            filename: String(a.filename || 'attachment'),
            mimeType: String(a.mimeType || 'application/octet-stream'),
            sizeBytes: Number(a.sizeBytes || 0),
            sha256: String(a.sha256 || ''),
          }));
      };

      const result = await runWithRls(db, isRoot, organizationId, async (transaction) => {
        const txOpt = transaction ? { transaction } : {};
        const canSqlPaginate = !search && typeof subRepo.count === 'function';
        let rows;
        let totalCount = null;
        if (canSqlPaginate) {
          totalCount = await subRepo.count({ filter, ...txOpt });
          rows = (await subRepo.find({
            filter,
            sort: ['-id'],
            limit: pageSize,
            offset: (page - 1) * pageSize,
            ...txOpt,
          })) || [];
        } else {
          rows = (await subRepo.find({
            filter,
            sort: ['-id'],
            limit: 1000,
            ...txOpt,
          })) || [];
        }

        const formCache = new Map();
        const formRepo = getRepo(db, 'latticePublicForms');
        const hydrated = [];
        for (const row of rows) {
          const rId = val(row, 'id') ?? null;
          const rFormId = val(row, 'formId') ?? null;
          const rSlug = String(val(row, 'slug') || '');
          const rSubCode = String(val(row, 'submissionCode') || '');
          const rOrgId = String(val(row, 'organizationId') || organizationId || '');
          let rStatus = String(val(row, 'status') || 'submitted');
          const rTargetCol = String(val(row, 'targetCollection') || '');
          const rTargetId = String(val(row, 'targetRecordId') || '');
          const rawPayloadJson = val(row, 'payloadJson');
          const extraPayload = rawPayloadJson && typeof rawPayloadJson === 'object' ? sanitizeStoredPayload(rawPayloadJson) : {};
          let targetPayloadFields = {};

          if (isValidOrganizationId(rOrgId) && isAllowlistedPublicFormCollection(rTargetCol) && /^[1-9]\d*$/.test(rTargetId)) {
            let formDef = formCache.get(rFormId);
            if (!formDef && formRepo && rFormId) {
              formDef = await formRepo.findOne({ filter: { id: Number(rFormId) }, ...txOpt }).catch(() => null);
              if (formDef) formCache.set(rFormId, formDef);
            }
            const allowedFields = Array.isArray(val(formDef, 'allowedFieldsJson'))
              ? val(formDef, 'allowedFieldsJson').map((f) => f?.name).filter(Boolean)
              : [];
            const targetRepo = getRepo(db, rTargetCol);
            const targetRec = targetRepo && typeof targetRepo.findOne === 'function'
              ? await targetRepo.findOne({ filter: { id: Number(rTargetId), organizationId: rOrgId }, ...txOpt }).catch(() => null)
              : null;
            if (targetRec) {
              if (val(targetRec, 'status')) rStatus = String(val(targetRec, 'status'));
              for (const fname of [...new Set([...allowedFields, 'code', 'name', 'status'])]) {
                if (BLOCKED_PROTO_KEYS.has(fname) || SENSITIVE_FIELD_NAME_RE.test(fname)) continue;
                const fv = val(targetRec, fname);
                if (fv !== undefined && fv !== null) targetPayloadFields[fname] = fv;
              }
            }
          }
          const payload = { ...targetPayloadFields, ...extraPayload };

          const attachments = sanitizeAttachmentsMeta(val(row, 'attachmentsJson'));
          const submittedAtRaw = val(row, 'submittedAt');
          const createdAtRaw = val(row, 'createdAt');
          const item = {
            id: rId,
            formId: rFormId,
            slug: rSlug,
            submissionCode: rSubCode,
            status: rStatus,
            payload,
            attachments,
            submittedAt: submittedAtRaw instanceof Date ? submittedAtRaw.toISOString() : (submittedAtRaw ? String(submittedAtRaw) : null),
            createdAt: createdAtRaw instanceof Date ? createdAtRaw.toISOString() : (createdAtRaw ? String(createdAtRaw) : null),
          };
          if (search) {
            const haystack = `${rSubCode} ${rSlug} ${rTargetId} ${JSON.stringify(payload)}`.toLowerCase();
            if (!haystack.includes(search)) continue;
          }
          hydrated.push(item);
        }

        if (canSqlPaginate) {
          return { items: hydrated, total: Number(totalCount ?? hydrated.length) };
        }
        const total = hydrated.length;
        const start = (page - 1) * pageSize;
        return { items: hydrated.slice(start, start + pageSize), total };
      });

      ctx.body = {
        organizationId,
        items: result.items,
        total: result.total,
        page,
        pageSize,
      };
      if (next) return next();
    },

    downloadAttachment: async (ctx, next) => {
      if ((ctx.method || 'GET').toUpperCase() !== 'GET') ctx.throw(405);
      const { isRoot, organizationId, params } = await resolveAdminContext(ctx, db, { requireWriteScope: false, allowManager: true });
      const submissionCode = String(params.submissionCode || '').trim();
      const fieldName = String(params.fieldName || '').trim();
      if (!SUBMISSION_CODE_RE.test(submissionCode) || !FIELD_NAME_RE.test(fieldName)) {
        throw failForm('FORM_ATTACHMENT_PARAMS_INVALID', 400, 'Invalid submissionCode or fieldName.');
      }
      await ensurePublicFormSubmissionColumns(db);
      const subRepo = getRepo(db, 'latticePublicFormSubmissions');
      if (!subRepo || typeof subRepo.findOne !== 'function') {
        throw failForm('FORM_SUBMISSION_NOT_FOUND', 404, 'Submission not found.');
      }
      const row = await runWithRls(db, isRoot, organizationId, (transaction) => subRepo.findOne({
        filter: { submissionCode, ...(organizationId ? { organizationId } : {}) },
        ...(transaction ? { transaction } : {}),
      }));
      if (!row) throw failForm('FORM_SUBMISSION_NOT_FOUND', 404, 'Submission not found.');
      const attachments = Array.isArray(val(row, 'attachmentsJson')) ? val(row, 'attachmentsJson') : [];
      const hit = attachments.find((a) => a && a.fieldName === fieldName);
      if (!hit || !hit.contentBase64) {
        throw failForm('FORM_ATTACHMENT_NOT_FOUND', 404, 'Attachment not found.');
      }
      const safeFilename = String(hit.filename || 'attachment').replace(/[^a-zA-Z0-9._-]/g, '_');
      ctx.withoutDataWrapping = true;
      ctx.set?.('Content-Type', ALLOWED_FILE_MIME_TYPES.has(hit.mimeType) ? hit.mimeType : 'application/octet-stream');
      ctx.set?.('Content-Disposition', `attachment; filename="${safeFilename}"`);
      ctx.set?.('X-Content-Type-Options', 'nosniff');
      ctx.body = Buffer.from(hit.contentBase64, 'base64');
      if (next) return next();
    },
  };
}

function registerPublicFormsGuard(app) {
  app.resourceManager?.use?.(async (ctx, next) => {
    if (ctx?.state?.currentRole === 'root') {
      const activeDb = app?.db || ctx?.db || ctx?.app?.db;
      const uid = val(ctx?.state?.currentUser, 'id');
      const ruRepo = getRepo(activeDb, 'rolesUsers');
      if (ruRepo && typeof ruRepo.find === 'function') {
        if (uid != null && /^[1-9]\d*$/.test(String(uid))) {
          const verified = await resolveVerifiedCallerRoles(ctx, activeDb, uid);
          if (verified.includes('root')) return next();
        }
      } else {
        return next();
      }
    }
    const fullResource = String(ctx.action?.resourceName || '');
    const baseResource = fullResource.split('.')[0];
    const actionName = String(ctx.action?.actionName || '');
    if (PUBLIC_FORM_PROTECTED_RESOURCES.has(baseResource)) {
      throw failForm(
        'PUBLIC_FORM_DIRECT_ACCESS_FORBIDDEN',
        403,
        'Direct access to public form collections is forbidden; use dxosForms.',
      );
    }
    if (
      fullResource === 'charts'
      && actionName === 'queryData'
      && PUBLIC_FORM_PROTECTED_RESOURCES.has(String(ctx.action?.params?.values?.collection || ''))
    ) {
      throw failForm(
        'PUBLIC_FORM_DIRECT_ACCESS_FORBIDDEN',
        403,
        'Direct chart access to public form collections is forbidden.',
      );
    }
    return next();
  }, { tag: 'latticePublicFormsGuard', after: 'acl' });
}

function registerPublicForms(app, options = {}) {
  registerPublicFormsGuard(app);
  if (app?.db) {
    Promise.resolve(ensurePublicFormSubmissionColumns(app.db)).catch(() => {});
  }
  const actions = createDxosFormsActions(app.db, options);
  app.resourceManager.define({
    name: 'dxosForms',
    actions,
  });
  app.acl?.allow?.('dxosForms', ['meta', 'submit', 'status'], 'public');
  app.acl?.allow?.('dxosForms', ['list', 'get', 'save', 'delete', 'rotateToken', 'listSubmissions', 'downloadAttachment'], 'loggedIn');
  return actions;
}

module.exports = {
  SLUG_RE,
  RESERVED_FORM_SLUGS,
  CUSTOM_COLLECTION_RE,
  PUBLIC_FORM_ALLOWLIST_COLLECTIONS,
  PUBLIC_FORM_PROTECTED_RESOURCES,
  BLOCKED_TARGET_FIELDS,
  sha256Hex,
  timingSafeEqualHex,
  assertNoPrototypePollution,
  isAllowlistedPublicFormCollection,
  validatePublicFormDefinition,
  sanitizeSubmissionPayload,
  createSlidingWindowRateLimiter,
  lookupFormBySlug,
  serializePublicMeta,
  createDxosFormsActions,
  registerPublicFormsGuard,
  registerPublicForms,
};
