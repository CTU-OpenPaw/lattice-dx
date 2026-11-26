/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const crypto = require('node:crypto');

const CUSTOM_COLLECTION_RE = /^latticeCustom[A-Z][A-Za-z0-9]{1,40}$/;
const CUSTOM_RLS_TABLE_RE = /^latticeCustom[A-Za-z0-9_]*$/;
const FIELD_NAME_RE = /^[a-z][a-zA-Z0-9_]{0,62}$/;
const SAFE_BUNDLE_FIELD_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,60}$/;

const BLOCKED_FIELD_NAMES = new Set(['__proto__', 'constructor', 'prototype', 'id', 'createdAt', 'updatedAt']);
const BLOCKED_FORMULA_IDENTIFIERS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'global',
  'globalThis',
  'process',
  'require',
  'module',
  'exports',
  'Function',
  'eval',
  'Proxy',
  'Reflect',
  'window',
  'self',
]);

const ALLOWED_FIELD_TYPES = new Set([
  'string',
  'text',
  'integer',
  'float',
  'boolean',
  'date',
  'datetime',
  'json',
  'belongsTo',
  'hasOne',
  'belongsToMany',
  'formula',
]);

const LEGACY_STORAGE_FIELD_TYPES = new Set([
  'jsonb',
  'number',
  'double',
  'decimal',
  'bigInt',
]);

const ALLOWED_FORMULA_RETURN_TYPES = new Set(['float', 'integer', 'string', 'boolean']);

const DEFAULT_ALLOWLISTED_BUSINESS_COLLECTIONS = new Set([
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

const MAX_FORMULA_LENGTH = 1000;
const MAX_FORMULA_TOKENS = 256;
const MAX_FORMULA_DEPTH = 24;
const MAX_REGEX_PATTERN_LENGTH = 256;
const MAX_REGEX_QUANTIFIER_BOUND = 100;
const MAX_REGEX_INPUT_LENGTH = 4096;
const MAX_REGEX_AST_DEPTH = 64;
const MAX_ADJACENT_BOUNDED_SPAN_PRODUCT = 100;
const MAX_CODEPOINT = 0x10FFFF;

function makeError(code, status = 400, message = code) {
  return Object.assign(new Error(message), { code, status });
}

function getAttr(row, key) {
  if (!row || typeof row !== 'object') return undefined;
  if (typeof row.get === 'function') {
    const v = row.get(key);
    if (v !== undefined) return v;
  }
  if (row.dataValues && typeof row.dataValues === 'object' && Object.hasOwn(row.dataValues, key)) {
    return row.dataValues[key];
  }
  return Object.hasOwn(row, key) ? row[key] : undefined;
}

function setAttr(row, key, value, options) {
  if (!row || typeof row !== 'object') return;
  if (typeof row.set === 'function') {
    row.set(key, value);
  } else {
    row[key] = value;
  }
  if (Array.isArray(options?.fields) && !options.fields.includes(key)) {
    options.fields.push(key);
  }
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
}

// ---------------------------------------------------------------------------
// Safe Pure-JS Formula Tokenizer, Recursive-Descent AST Parser & Evaluator
// Strictly AST-interpreted without dynamic code evaluation
// ---------------------------------------------------------------------------

function toFiniteNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return fallback;
    const num = Number(trimmed);
    return Number.isFinite(num) ? num : fallback;
  }
  return fallback;
}

function isNumericLiteralString(value) {
  return typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim());
}

function toDateValue(value, opts = {}) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (value == null && opts.defaultNow) {
    return opts.now instanceof Date ? opts.now : new Date();
  }
  return null;
}

const FORMULA_FUNCTIONS = new Map([
  ['ROUND', (n, digits = 0) => {
    const num = toFiniteNumber(n, null);
    if (num === null) return null;
    const d = Math.max(0, Math.min(10, Math.trunc(toFiniteNumber(digits, 0) ?? 0)));
    const factor = 10 ** d;
    return Math.round((num + Number.EPSILON) * factor) / factor;
  }],
  ['ABS', (n) => {
    const num = toFiniteNumber(n, null);
    return num === null ? null : Math.abs(num);
  }],
  ['CEIL', (n) => {
    const num = toFiniteNumber(n, null);
    return num === null ? null : Math.ceil(num);
  }],
  ['FLOOR', (n) => {
    const num = toFiniteNumber(n, null);
    return num === null ? null : Math.floor(num);
  }],
  ['MIN', (...args) => {
    const nums = args.map((a) => toFiniteNumber(a, null)).filter((n) => n !== null);
    return nums.length ? Math.min(...nums) : null;
  }],
  ['MAX', (...args) => {
    const nums = args.map((a) => toFiniteNumber(a, null)).filter((n) => n !== null);
    return nums.length ? Math.max(...nums) : null;
  }],
  ['POW', (base, exp) => {
    const b = toFiniteNumber(base, null);
    const e = toFiniteNumber(exp, null);
    if (b === null || e === null) return null;
    const out = b ** e;
    return Number.isFinite(out) ? out : null;
  }],
  ['SQRT', (n) => {
    const num = toFiniteNumber(n, null);
    if (num === null || num < 0) return null;
    return Math.sqrt(num);
  }],
  ['COALESCE', (...args) => {
    for (const arg of args) {
      if (arg !== null && arg !== undefined) return arg;
    }
    return null;
  }],
  ['IF', (cond, thenVal, elseVal) => (cond ? thenVal : elseVal)],
  ['ISNULL', (v) => v === null || v === undefined],
  ['CONCAT', (...args) => args.map((a) => (a === null || a === undefined ? '' : String(a))).join('')],
  ['UPPER', (s) => (s === null || s === undefined ? '' : String(s).toUpperCase())],
  ['LOWER', (s) => (s === null || s === undefined ? '' : String(s).toLowerCase())],
  ['TRIM', (s) => (s === null || s === undefined ? '' : String(s).trim())],
  ['LEN', (s) => {
    if (s === null || s === undefined) return 0;
    if (Array.isArray(s) || typeof s === 'string') return s.length;
    return String(s).length;
  }],
  ['SUBSTR', (s, start = 0, len) => {
    if (s === null || s === undefined) return '';
    const str = String(s);
    const st = Math.max(0, Math.trunc(toFiniteNumber(start, 0) ?? 0));
    if (len === undefined || len === null) return str.slice(st);
    const ln = Math.max(0, Math.trunc(toFiniteNumber(len, 0) ?? 0));
    return str.slice(st, st + ln);
  }],
  ['NOW', () => new Date().toISOString()],
  ['YEAR', (d) => {
    const dt = toDateValue(d);
    return dt ? dt.getUTCFullYear() : null;
  }],
  ['MONTH', (d) => {
    const dt = toDateValue(d);
    return dt ? dt.getUTCMonth() + 1 : null;
  }],
  ['DAY', (d) => {
    const dt = toDateValue(d);
    return dt ? dt.getUTCDate() : null;
  }],
  ['DATEDIFF_DAYS', (d1, d2) => {
    const dt1 = toDateValue(d1);
    const dt2 = toDateValue(d2);
    if (!dt1 || !dt2) return null;
    return Math.trunc((dt1.getTime() - dt2.getTime()) / 86_400_000);
  }],
]);

const FORMULA_FUNCTION_NAMES = Object.freeze([...FORMULA_FUNCTIONS.keys()]);

function tokenizeFormula(expr) {
  if (typeof expr !== 'string') {
    throw makeError('INVALID_FORMULA_EXPRESSION', 400, 'Formula expression must be a string');
  }
  if (!expr.trim()) {
    throw makeError('INVALID_FORMULA_EXPRESSION', 400, 'Formula expression cannot be empty');
  }
  if (expr.length > MAX_FORMULA_LENGTH) {
    throw makeError('INVALID_FORMULA_EXPRESSION', 400, `Formula expression exceeds max length (${MAX_FORMULA_LENGTH})`);
  }

  const tokens = [];
  let i = 0;
  const len = expr.length;

  while (i < len) {
    const ch = expr[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    // Multi-char operators
    const three = expr.slice(i, i + 3);
    if (three === '===' || three === '!==') {
      tokens.push({ type: 'op', value: three });
      i += 3;
      continue;
    }
    const two = expr.slice(i, i + 2);
    if (two === '||' || two === '&&' || two === '==' || two === '!=' || two === '<=' || two === '>=') {
      tokens.push({ type: 'op', value: two });
      i += 2;
      continue;
    }

    // Single-char punctuation / operators
    if (ch === '(' || ch === ')' || ch === ',' || ch === '?' || ch === ':') {
      tokens.push({ type: ch, value: ch });
      i += 1;
      continue;
    }
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '%' || ch === '!' || ch === '<' || ch === '>') {
      tokens.push({ type: 'op', value: ch });
      i += 1;
      continue;
    }

    // String literal
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      let strVal = '';
      let closed = false;
      while (i < len) {
        const c = expr[i];
        if (c === '\\') {
          if (i + 1 >= len) {
            throw makeError('INVALID_FORMULA_EXPRESSION', 400, 'Unterminated escape sequence in formula string');
          }
          const next = expr[i + 1];
          if (next === 'n') strVal += '\n';
          else if (next === 't') strVal += '\t';
          else if (next === 'r') strVal += '\r';
          else strVal += next;
          i += 2;
          continue;
        }
        if (c === quote) {
          closed = true;
          i += 1;
          break;
        }
        strVal += c;
        i += 1;
      }
      if (!closed) {
        throw makeError('INVALID_FORMULA_EXPRESSION', 400, 'Unterminated string literal in formula expression');
      }
      tokens.push({ type: 'string', value: strVal });
      continue;
    }

    // Number literal
    if (/[0-9]/.test(ch)) {
      let end = i;
      let sawDot = false;
      while (end < len) {
        const c = expr[end];
        if (/[0-9]/.test(c)) {
          end += 1;
        } else if (c === '.' && !sawDot && end + 1 < len && /[0-9]/.test(expr[end + 1])) {
          sawDot = true;
          end += 1;
        } else {
          break;
        }
      }
      const rawNum = expr.slice(i, end);
      const parsedNum = Number(rawNum);
      if (!Number.isFinite(parsedNum)) {
        throw makeError('INVALID_FORMULA_EXPRESSION', 400, `Invalid number "${rawNum}" in formula`);
      }
      tokens.push({ type: 'number', value: parsedNum });
      i = end;
      continue;
    }

    // Identifier or dotted member path or boolean/null literal
    if (/[a-zA-Z_]/.test(ch)) {
      let end = i + 1;
      while (end < len && /[a-zA-Z0-9_.]/.test(expr[end])) {
        end += 1;
      }
      const ident = expr.slice(i, end);
      if (ident.endsWith('.') || ident.includes('..')) {
        throw makeError('INVALID_FORMULA_EXPRESSION', 400, `Malformed identifier "${ident}" in formula`);
      }
      if (ident === 'true') tokens.push({ type: 'boolean', value: true });
      else if (ident === 'false') tokens.push({ type: 'boolean', value: false });
      else if (ident === 'null') tokens.push({ type: 'null', value: null });
      else tokens.push({ type: 'ident', value: ident });
      i = end;
      continue;
    }

    throw makeError('INVALID_FORMULA_EXPRESSION', 400, `Unexpected character "${ch}" in formula expression`);
  }

  if (tokens.length > MAX_FORMULA_TOKENS) {
    throw makeError('INVALID_FORMULA_EXPRESSION', 400, `Formula exceeds max token count (${MAX_FORMULA_TOKENS})`);
  }
  return tokens;
}

function assertSafeIdentifierPath(ident) {
  const segments = String(ident || '').split('.');
  for (const seg of segments) {
    if (!seg || BLOCKED_FORMULA_IDENTIFIERS.has(seg)) {
      throw makeError('INVALID_FORMULA_IDENTIFIER', 400, `Blocked identifier "${ident}" in formula expression`);
    }
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(seg)) {
      throw makeError('INVALID_FORMULA_IDENTIFIER', 400, `Invalid identifier segment "${seg}" in formula`);
    }
  }
  return segments;
}

function parseFormulaAst(expression) {
  const tokens = tokenizeFormula(expression);
  let pos = 0;
  const referencedSet = new Set();

  const peek = () => tokens[pos] || null;
  const consume = () => tokens[pos++] || null;

  function parseTernary(depth) {
    if (depth > MAX_FORMULA_DEPTH) {
      throw makeError('INVALID_FORMULA_EXPRESSION', 400, `Formula nesting depth exceeds ${MAX_FORMULA_DEPTH}`);
    }
    const test = parseOr(depth);
    if (peek()?.type === '?') {
      consume();
      const consequent = parseTernary(depth + 1);
      if (peek()?.type !== ':') {
        throw makeError('INVALID_FORMULA_EXPRESSION', 400, 'Expected ":" in ternary expression');
      }
      consume();
      const alternate = parseTernary(depth + 1);
      return { type: 'ConditionalExpr', test, consequent, alternate };
    }
    return test;
  }

  function parseOr(depth) {
    let left = parseAnd(depth);
    while (peek()?.type === 'op' && peek().value === '||') {
      const op = consume().value;
      const right = parseAnd(depth + 1);
      left = { type: 'BinaryOp', op, left, right };
    }
    return left;
  }

  function parseAnd(depth) {
    let left = parseEquality(depth);
    while (peek()?.type === 'op' && peek().value === '&&') {
      const op = consume().value;
      const right = parseEquality(depth + 1);
      left = { type: 'BinaryOp', op, left, right };
    }
    return left;
  }

  function parseEquality(depth) {
    let left = parseRelational(depth);
    while (peek()?.type === 'op' && ['==', '===', '!=', '!=='].includes(peek().value)) {
      const op = consume().value;
      const right = parseRelational(depth + 1);
      left = { type: 'BinaryOp', op, left, right };
    }
    return left;
  }

  function parseRelational(depth) {
    let left = parseAdditive(depth);
    while (peek()?.type === 'op' && ['<', '<=', '>', '>='].includes(peek().value)) {
      const op = consume().value;
      const right = parseAdditive(depth + 1);
      left = { type: 'BinaryOp', op, left, right };
    }
    return left;
  }

  function parseAdditive(depth) {
    let left = parseMultiplicative(depth);
    while (peek()?.type === 'op' && (peek().value === '+' || peek().value === '-')) {
      const op = consume().value;
      const right = parseMultiplicative(depth + 1);
      left = { type: 'BinaryOp', op, left, right };
    }
    return left;
  }

  function parseMultiplicative(depth) {
    let left = parseUnary(depth);
    while (peek()?.type === 'op' && (peek().value === '*' || peek().value === '/' || peek().value === '%')) {
      const op = consume().value;
      const right = parseUnary(depth + 1);
      left = { type: 'BinaryOp', op, left, right };
    }
    return left;
  }

  function parseUnary(depth) {
    if (depth > MAX_FORMULA_DEPTH) {
      throw makeError('INVALID_FORMULA_EXPRESSION', 400, `Formula nesting depth exceeds ${MAX_FORMULA_DEPTH}`);
    }
    if (peek()?.type === 'op' && (peek().value === '-' || peek().value === '+' || peek().value === '!')) {
      const op = consume().value;
      const argument = parseUnary(depth + 1);
      return { type: 'UnaryOp', op, argument };
    }
    return parsePrimary(depth);
  }

  function parsePrimary(depth) {
    if (depth > MAX_FORMULA_DEPTH) {
      throw makeError('INVALID_FORMULA_EXPRESSION', 400, `Formula nesting depth exceeds ${MAX_FORMULA_DEPTH}`);
    }
    const tok = peek();
    if (!tok) {
      throw makeError('INVALID_FORMULA_EXPRESSION', 400, 'Unexpected end of formula expression');
    }
    if (tok.type === 'number' || tok.type === 'string' || tok.type === 'boolean' || tok.type === 'null') {
      consume();
      return { type: 'Literal', value: tok.value };
    }
    if (tok.type === '(') {
      consume();
      const expr = parseTernary(depth + 1);
      if (peek()?.type !== ')') {
        throw makeError('INVALID_FORMULA_EXPRESSION', 400, 'Expected closing ")" in formula expression');
      }
      consume();
      return expr;
    }
    if (tok.type === 'ident') {
      consume();
      const ident = tok.value;
      if (peek()?.type === '(') {
        consume();
        const fnName = ident.toUpperCase();
        if (!FORMULA_FUNCTIONS.has(fnName)) {
          throw makeError('INVALID_FORMULA_FUNCTION', 400, `Disallowed or unknown formula function "${ident}"`);
        }
        const args = [];
        if (peek()?.type !== ')') {
          while (true) {
            args.push(parseTernary(depth + 1));
            if (peek()?.type === ',') {
              consume();
              continue;
            }
            break;
          }
        }
        if (peek()?.type !== ')') {
          throw makeError('INVALID_FORMULA_EXPRESSION', 400, `Expected closing ")" for function ${ident}`);
        }
        consume();
        return { type: 'CallExpr', callee: fnName, args };
      }
      const segments = assertSafeIdentifierPath(ident);
      referencedSet.add(segments[0]);
      return { type: 'Identifier', name: ident, segments };
    }

    throw makeError('INVALID_FORMULA_EXPRESSION', 400, `Unexpected token "${tok.value}" in formula expression`);
  }

  const body = parseTernary(1);
  if (pos < tokens.length) {
    throw makeError('INVALID_FORMULA_EXPRESSION', 400, `Unexpected trailing token "${tokens[pos].value}" in formula`);
  }

  return {
    type: 'Program',
    body,
    referencedFields: [...referencedSet],
    inferredReturnType: inferAstReturnType(body),
  };
}

function inferAstReturnType(node) {
  if (!node || typeof node !== 'object') return 'float';
  if (node.type === 'Literal') {
    if (typeof node.value === 'boolean') return 'boolean';
    if (typeof node.value === 'string') return 'string';
    if (typeof node.value === 'number') return Number.isInteger(node.value) ? 'integer' : 'float';
    return 'float';
  }
  if (node.type === 'UnaryOp') {
    return node.op === '!' ? 'boolean' : 'float';
  }
  if (node.type === 'BinaryOp') {
    if (['==', '===', '!=', '!==', '<', '<=', '>', '>=', '&&', '||'].includes(node.op)) return 'boolean';
    return 'float';
  }
  if (node.type === 'CallExpr') {
    if (['ISNULL'].includes(node.callee)) return 'boolean';
    if (['CONCAT', 'UPPER', 'LOWER', 'TRIM', 'SUBSTR', 'NOW'].includes(node.callee)) return 'string';
    if (['LEN', 'YEAR', 'MONTH', 'DAY', 'DATEDIFF_DAYS', 'CEIL', 'FLOOR'].includes(node.callee)) return 'integer';
    return 'float';
  }
  return 'float';
}

function validateFormulaExpression(expression, opts = {}) {
  try {
    const ast = parseFormulaAst(expression);
    if (opts.selfFieldName && ast.referencedFields.includes(opts.selfFieldName)) {
      const err = makeError(
        'INVALID_FORMULA_EXPRESSION',
        400,
        `Formula on field "${opts.selfFieldName}" cannot reference itself`,
      );
      if (opts.throwOnError) throw err;
      return { valid: false, error: err.message, code: err.code };
    }
    if (Array.isArray(opts.knownFields) || opts.knownFields instanceof Set) {
      const known = opts.knownFields instanceof Set ? opts.knownFields : new Set(opts.knownFields);
      const unknown = ast.referencedFields.filter((f) => !known.has(f));
      if (unknown.length > 0) {
        const err = makeError(
          'INVALID_FORMULA_FIELD_REF',
          400,
          `Formula references unknown field(s): ${unknown.join(', ')}`,
        );
        if (opts.throwOnError) throw err;
        return { valid: false, error: err.message, code: err.code };
      }
    }
    return {
      valid: true,
      ast,
      referencedFields: ast.referencedFields,
      inferredReturnType: ast.inferredReturnType,
    };
  } catch (err) {
    if (opts.throwOnError) throw err;
    return {
      valid: false,
      error: err?.message || 'Invalid formula expression',
      code: err?.code || 'INVALID_FORMULA_EXPRESSION',
    };
  }
}

function readSafeRecordValue(recordData, segments) {
  if (!recordData || typeof recordData !== 'object' || !Array.isArray(segments) || !segments.length) {
    return undefined;
  }
  let cur = recordData;
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    if (!seg || BLOCKED_FORMULA_IDENTIFIERS.has(seg) || cur == null || typeof cur !== 'object') {
      return undefined;
    }
    if (i === 0) {
      if (typeof cur.get === 'function') {
        const got = cur.get(seg);
        if (got !== undefined) {
          cur = got;
          continue;
        }
      }
      if (cur.dataValues && typeof cur.dataValues === 'object' && Object.hasOwn(cur.dataValues, seg)) {
        cur = cur.dataValues[seg];
        continue;
      }
    }
    if (!Object.hasOwn(cur, seg)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

function evalAstNode(node, recordData, opts = {}) {
  if (!node || typeof node !== 'object') return null;
  switch (node.type) {
    case 'Literal':
      return node.value;
    case 'Identifier':
      return readSafeRecordValue(recordData, node.segments);
    case 'UnaryOp': {
      const val = evalAstNode(node.argument, recordData, opts);
      if (node.op === '!') return !val;
      if (node.op === '-') {
        const n = toFiniteNumber(val, null);
        return n === null ? null : -n;
      }
      if (node.op === '+') {
        return toFiniteNumber(val, null);
      }
      return null;
    }
    case 'ConditionalExpr': {
      const cond = evalAstNode(node.test, recordData, opts);
      return cond
        ? evalAstNode(node.consequent, recordData, opts)
        : evalAstNode(node.alternate, recordData, opts);
    }
    case 'BinaryOp': {
      if (node.op === '&&') {
        const l = evalAstNode(node.left, recordData, opts);
        return l ? evalAstNode(node.right, recordData, opts) : l;
      }
      if (node.op === '||') {
        const l = evalAstNode(node.left, recordData, opts);
        return l ? l : evalAstNode(node.right, recordData, opts);
      }
      const l = evalAstNode(node.left, recordData, opts);
      const r = evalAstNode(node.right, recordData, opts);
      switch (node.op) {
        case '===': return l === r;
        case '!==': return l !== r;
        case '==': return l == r; // eslint-disable-line eqeqeq
        case '!=': return l != r; // eslint-disable-line eqeqeq
        case '<': return l < r;
        case '<=': return l <= r;
        case '>': return l > r;
        case '>=': return l >= r;
        case '+': {
          if (typeof l === 'string' || typeof r === 'string') {
            if ((typeof l === 'number' || isNumericLiteralString(l)) && (typeof r === 'number' || isNumericLiteralString(r))) {
              return Number(l) + Number(r);
            }
            return `${l ?? ''}${r ?? ''}`;
          }
          const ln = toFiniteNumber(l, 0);
          const rn = toFiniteNumber(r, 0);
          return ln + rn;
        }
        case '-': {
          const ln = toFiniteNumber(l, null);
          const rn = toFiniteNumber(r, null);
          if (ln === null && rn === null) return null;
          return (ln ?? 0) - (rn ?? 0);
        }
        case '*': {
          const ln = toFiniteNumber(l, null);
          const rn = toFiniteNumber(r, null);
          if (ln === null || rn === null) return null;
          const res = ln * rn;
          return Number.isFinite(res) ? res : null;
        }
        case '/': {
          const ln = toFiniteNumber(l, null);
          const rn = toFiniteNumber(r, null);
          if (ln === null || rn === null) return null;
          if (rn === 0) {
            if (opts.strictDivideByZero) {
              throw makeError('FORMULA_DIVIDE_BY_ZERO', 400, 'Division by zero in formula expression');
            }
            return null;
          }
          const res = ln / rn;
          return Number.isFinite(res) ? res : null;
        }
        case '%': {
          const ln = toFiniteNumber(l, null);
          const rn = toFiniteNumber(r, null);
          if (ln === null || rn === null) return null;
          if (rn === 0) {
            if (opts.strictDivideByZero) {
              throw makeError('FORMULA_DIVIDE_BY_ZERO', 400, 'Modulo by zero in formula expression');
            }
            return null;
          }
          const res = ln % rn;
          return Number.isFinite(res) ? res : null;
        }
        default:
          return null;
      }
    }
    case 'CallExpr': {
      if (node.callee === 'IF') {
        const cond = evalAstNode(node.args[0], recordData, opts);
        if (cond) {
          return node.args.length > 1 ? evalAstNode(node.args[1], recordData, opts) : null;
        }
        return node.args.length > 2 ? evalAstNode(node.args[2], recordData, opts) : null;
      }
      if (node.callee === 'NOW' && opts.now instanceof Date) {
        return opts.now.toISOString();
      }
      const fn = FORMULA_FUNCTIONS.get(node.callee);
      if (!fn) {
        throw makeError('INVALID_FORMULA_FUNCTION', 400, `Disallowed formula function "${node.callee}"`);
      }
      const evaluatedArgs = node.args.map((arg) => evalAstNode(arg, recordData, opts));
      return fn(...evaluatedArgs);
    }
    default:
      return null;
  }
}

function evaluateFormulaExpression(expressionOrAst, recordData = {}, opts = {}) {
  const program = typeof expressionOrAst === 'string'
    ? parseFormulaAst(expressionOrAst)
    : expressionOrAst?.type === 'Program'
      ? expressionOrAst
      : { type: 'Program', body: expressionOrAst };
  if (!program?.body) {
    throw makeError('INVALID_FORMULA_EXPRESSION', 400, 'Formula AST is empty');
  }
  return evalAstNode(program.body, recordData, opts);
}

// ---------------------------------------------------------------------------
// ReDoS-Safe Regex Validation (CharSet Interval Algebra + Recursive AST)
// ---------------------------------------------------------------------------

function normalizeIntervals(intervals) {
  if (!Array.isArray(intervals) || intervals.length === 0) return [];
  const valid = [];
  for (const pair of intervals) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const lo = Math.max(0, pair[0]);
    const hi = Math.min(MAX_CODEPOINT, pair[1]);
    if (lo <= hi) valid.push([lo, hi]);
  }
  if (valid.length === 0) return [];
  valid.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [valid[0]];
  for (let i = 1; i < valid.length; i += 1) {
    const cur = valid[i];
    const last = merged[merged.length - 1];
    if (cur[0] <= last[1] + 1) {
      if (cur[1] > last[1]) last[1] = cur[1];
    } else {
      merged.push([cur[0], cur[1]]);
    }
  }
  return merged;
}

function charSetUnion(a, b) {
  if (!a || a.length === 0) return b ? normalizeIntervals(b) : [];
  if (!b || b.length === 0) return normalizeIntervals(a);
  return normalizeIntervals([...a, ...b]);
}

function charSetIntersects(a, b) {
  if (!a?.length || !b?.length) return false;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i][1] < b[j][0]) {
      i += 1;
    } else if (b[j][1] < a[i][0]) {
      j += 1;
    } else {
      return true;
    }
  }
  return false;
}

function charSetComplement(a) {
  const norm = normalizeIntervals(a);
  const out = [];
  let pos = 0;
  for (const [lo, hi] of norm) {
    if (pos < lo) {
      out.push([pos, lo - 1]);
    }
    pos = hi + 1;
  }
  if (pos <= MAX_CODEPOINT) {
    out.push([pos, MAX_CODEPOINT]);
  }
  return out;
}

let cachedNonAsciiCaseFoldPairs = null;

function getNonAsciiBmpCaseFoldPairs() {
  if (cachedNonAsciiCaseFoldPairs) return cachedNonAsciiCaseFoldPairs;
  const groupsByUpper = new Map();
  for (let cp = 0x80; cp <= 0xFFFF; cp += 1) {
    const ch = String.fromCharCode(cp);
    const up = ch.toUpperCase();
    if (up === ch || up.length !== 1) continue;
    const ucp = up.charCodeAt(0);
    if (ucp < 0x80) continue;
    let grp = groupsByUpper.get(ucp);
    if (!grp) {
      grp = new Set([ucp]);
      groupsByUpper.set(ucp, grp);
    }
    grp.add(cp);
  }
  const pairs = [];
  for (const grp of groupsByUpper.values()) {
    if (grp.size <= 1) continue;
    const members = [...grp];
    for (const cp of members) {
      for (const partner of members) {
        if (partner !== cp) {
          pairs.push([cp, partner]);
        }
      }
    }
  }
  pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  cachedNonAsciiCaseFoldPairs = pairs;
  return pairs;
}

function lowerBoundPairIndex(pairs, targetCp) {
  let lo = 0;
  let hi = pairs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (pairs[mid][0] < targetCp) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

function charSetCaseFold(a) {
  if (!a || a.length === 0) return [];
  const out = [];
  for (const [lo, hi] of a) {
    out.push([lo, hi]);
    if (lo <= 90 && hi >= 65) {
      out.push([Math.max(lo, 65) + 32, Math.min(hi, 90) + 32]);
    }
    if (lo <= 122 && hi >= 97) {
      out.push([Math.max(lo, 97) - 32, Math.min(hi, 122) - 32]);
    }
    if (hi >= 0x80 && lo <= 0xFFFF && !(lo <= 0x80 && hi >= 0xFFFF)) {
      const start = Math.max(lo, 0x80);
      const end = Math.min(hi, 0xFFFF);
      const pairs = getNonAsciiBmpCaseFoldPairs();
      for (let i = lowerBoundPairIndex(pairs, start); i < pairs.length && pairs[i][0] <= end; i += 1) {
        const partner = pairs[i][1];
        if (partner < lo || partner > hi) {
          out.push([partner, partner]);
        }
      }
    }
  }
  return normalizeIntervals(out);
}

const CS_DIGIT = [[48, 57]];
const CS_NON_DIGIT = charSetComplement(CS_DIGIT);
const CS_WORD = [[48, 57], [65, 90], [95, 95], [97, 122]];
const CS_NON_WORD = charSetComplement(CS_WORD);
const CS_SPACE = normalizeIntervals([
  [9, 13],
  [32, 32],
  [160, 160],
  [5760, 5760],
  [8192, 8202],
  [8232, 8233],
  [8239, 8239],
  [8287, 8287],
  [12288, 12288],
  [65279, 65279],
]);
const CS_NON_SPACE = charSetComplement(CS_SPACE);
const CS_ANY = [[0, MAX_CODEPOINT]];
const CS_DOT_DEFAULT = charSetComplement([[10, 10], [13, 13], [0x2028, 0x2028], [0x2029, 0x2029]]);

const SIMPLE_CHAR_ESCAPES = new Map([
  ['n', 0x0A],
  ['r', 0x0D],
  ['t', 0x09],
  ['v', 0x0B],
  ['f', 0x0C],
]);

function parseEscapeToken(pattern, slashIdx, { inClass }) {
  if (slashIdx + 1 >= pattern.length) {
    throw makeError('INVALID_VALIDATION_PATTERN', 400, 'Trailing backslash in regex pattern');
  }
  const next = pattern[slashIdx + 1];

  if (!inClass) {
    if (/^[1-9]$/.test(next) || (next === 'k' && pattern[slashIdx + 2] === '<')) {
      throw makeError('INVALID_VALIDATION_PATTERN', 400, 'Backreferences are not allowed in validation regex');
    }
    if (next === 'b' || next === 'B') {
      return { end: slashIdx + 2, node: { type: 'Anchor', kind: next === 'b' ? '\\b' : '\\B' } };
    }
  } else if (next === 'b') {
    return { end: slashIdx + 2, codePoint: 0x08 };
  }

  if (next === 'd') return { end: slashIdx + 2, intervals: CS_DIGIT, hasNegatedOrBroad: false };
  if (next === 'D') return { end: slashIdx + 2, intervals: CS_NON_DIGIT, hasNegatedOrBroad: true };
  if (next === 'w') return { end: slashIdx + 2, intervals: CS_WORD, hasNegatedOrBroad: false };
  if (next === 'W') return { end: slashIdx + 2, intervals: CS_NON_WORD, hasNegatedOrBroad: true };
  if (next === 's') return { end: slashIdx + 2, intervals: CS_SPACE, hasNegatedOrBroad: false };
  if (next === 'S') return { end: slashIdx + 2, intervals: CS_NON_SPACE, hasNegatedOrBroad: true };

  if ((next === 'p' || next === 'P') && pattern[slashIdx + 2] === '{') {
    throw makeError('INVALID_VALIDATION_PATTERN', 400, 'Unicode property escapes are not supported without /u flag');
  }

  if (SIMPLE_CHAR_ESCAPES.has(next)) {
    return { end: slashIdx + 2, codePoint: SIMPLE_CHAR_ESCAPES.get(next) };
  }

  const controlEscapeRe = inClass ? /^[0-9A-Za-z_]$/ : /^[A-Za-z]$/;
  if (next === 'c') {
    if (slashIdx + 2 < pattern.length && controlEscapeRe.test(pattern[slashIdx + 2])) {
      return { end: slashIdx + 3, codePoint: pattern.charCodeAt(slashIdx + 2) & 31 };
    }
    return { end: slashIdx + 1, codePoint: 0x5C };
  }

  if (next === 'x' && /^[0-9a-fA-F]{2}$/.test(pattern.slice(slashIdx + 2, slashIdx + 4))) {
    return { end: slashIdx + 4, codePoint: parseInt(pattern.slice(slashIdx + 2, slashIdx + 4), 16) };
  }

  if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(pattern.slice(slashIdx + 2, slashIdx + 6))) {
    return { end: slashIdx + 6, codePoint: parseInt(pattern.slice(slashIdx + 2, slashIdx + 6), 16) };
  }

  if (inClass) {
    const octalMatch = /^([0-3][0-7]{0,2}|[4-7][0-7]?)/.exec(pattern.slice(slashIdx + 1));
    if (octalMatch) {
      return { end: slashIdx + 1 + octalMatch[1].length, codePoint: parseInt(octalMatch[1], 8) };
    }
  } else if (next === '0') {
    const octalMatch = /^(0[0-7]{0,2})/.exec(pattern.slice(slashIdx + 1));
    if (octalMatch) {
      return { end: slashIdx + 1 + octalMatch[1].length, codePoint: parseInt(octalMatch[1], 8) };
    }
  }

  const cu = pattern.charCodeAt(slashIdx + 1);
  return { end: slashIdx + 2, codePoint: cu };
}

function parseGroupHeader(pattern, openParenIdx) {
  if (pattern[openParenIdx + 1] !== '?') {
    return { kind: 'capture', name: null, addFlags: '', removeFlags: '', bodyStart: openParenIdx + 1 };
  }
  if (pattern.startsWith('?:', openParenIdx + 1)) {
    return { kind: 'nonCapture', name: null, addFlags: '', removeFlags: '', bodyStart: openParenIdx + 3 };
  }
  if (pattern.startsWith('?=', openParenIdx + 1)) {
    return { kind: 'lookahead', name: null, addFlags: '', removeFlags: '', bodyStart: openParenIdx + 3 };
  }
  if (pattern.startsWith('?!', openParenIdx + 1)) {
    return { kind: 'negLookahead', name: null, addFlags: '', removeFlags: '', bodyStart: openParenIdx + 3 };
  }
  if (pattern.startsWith('?<=', openParenIdx + 1) || pattern.startsWith('?<!', openParenIdx + 1)) {
    throw makeError('INVALID_VALIDATION_PATTERN', 400, 'Lookbehinds are not allowed in validation regex');
  }
  if (pattern.startsWith('?<', openParenIdx + 1)) {
    const gt = pattern.indexOf('>', openParenIdx + 3);
    if (gt < 0) {
      throw makeError('INVALID_VALIDATION_PATTERN', 400, 'Unclosed named capture group in regex pattern');
    }
    const name = pattern.slice(openParenIdx + 3, gt);
    if (!name || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
      throw makeError('INVALID_VALIDATION_PATTERN', 400, 'Invalid named capture group in regex pattern');
    }
    return { kind: 'namedCapture', name, addFlags: '', removeFlags: '', bodyStart: gt + 1 };
  }

  let pos = openParenIdx + 2;
  let addFlags = '';
  let removeFlags = '';
  while (pos < pattern.length && /[A-Za-z]/.test(pattern[pos])) {
    addFlags += pattern[pos];
    pos += 1;
  }
  if (pattern[pos] === '-') {
    pos += 1;
    while (pos < pattern.length && /[A-Za-z]/.test(pattern[pos])) {
      removeFlags += pattern[pos];
      pos += 1;
    }
  }
  if (pattern[pos] === ':' && addFlags.length + removeFlags.length > 0) {
    const seenAdd = new Set();
    const seenRem = new Set();
    for (const fl of addFlags) {
      if (fl !== 'i' && fl !== 'm' && fl !== 's') {
        throw makeError('INVALID_VALIDATION_PATTERN', 400, `Unsupported group modifier flag "${fl}" in regex pattern`);
      }
      if (seenAdd.has(fl)) {
        throw makeError('INVALID_VALIDATION_PATTERN', 400, 'Duplicate group modifier flag in regex pattern');
      }
      seenAdd.add(fl);
    }
    for (const fl of removeFlags) {
      if (fl !== 'i' && fl !== 'm' && fl !== 's') {
        throw makeError('INVALID_VALIDATION_PATTERN', 400, `Unsupported group modifier flag "${fl}" in regex pattern`);
      }
      if (seenRem.has(fl) || seenAdd.has(fl)) {
        throw makeError('INVALID_VALIDATION_PATTERN', 400, 'Conflicting group modifier flags in regex pattern');
      }
      seenRem.add(fl);
    }
    return { kind: 'modifier', name: null, addFlags, removeFlags, bodyStart: pos + 1 };
  }

  throw makeError('INVALID_VALIDATION_PATTERN', 400, 'Unsupported or invalid group syntax in regex pattern');
}

function parseCharClass(pattern, openBracketIdx) {
  let pos = openBracketIdx + 1;
  if (pos >= pattern.length) {
    throw makeError('INVALID_VALIDATION_PATTERN', 400, 'Unclosed "[" in regex pattern');
  }
  let negated = false;
  if (pattern[pos] === '^') {
    negated = true;
    pos += 1;
  }

  const readItem = (idx) => {
    if (pattern[idx] === '\\') {
      const esc = parseEscapeToken(pattern, idx, { inClass: true });
      if (esc.intervals) {
        return { end: esc.end, isSet: true, intervals: esc.intervals, hasNegatedOrBroad: Boolean(esc.hasNegatedOrBroad) };
      }
      return { end: esc.end, isSet: false, codePoint: esc.codePoint };
    }
    const cu = pattern.charCodeAt(idx);
    return { end: idx + 1, isSet: false, codePoint: cu };
  };

  const rawIntervals = [];
  let hasNegatedOrBroad = negated;

  while (pos < pattern.length && pattern[pos] !== ']') {
    const first = readItem(pos);
    pos = first.end;
    if (pattern[pos] === '-' && pos + 1 < pattern.length && pattern[pos + 1] !== ']') {
      const second = readItem(pos + 1);
      if (first.isSet || second.isSet) {
        if (first.isSet) {
          rawIntervals.push(...first.intervals);
          if (first.hasNegatedOrBroad) hasNegatedOrBroad = true;
        } else {
          rawIntervals.push([first.codePoint, first.codePoint]);
        }
        rawIntervals.push([0x2D, 0x2D]);
        if (second.isSet) {
          rawIntervals.push(...second.intervals);
          if (second.hasNegatedOrBroad) hasNegatedOrBroad = true;
        } else {
          rawIntervals.push([second.codePoint, second.codePoint]);
        }
      } else {
        if (first.codePoint > second.codePoint) {
          throw makeError('INVALID_VALIDATION_PATTERN', 400, 'Range out of order in character class');
        }
        rawIntervals.push([first.codePoint, second.codePoint]);
      }
      pos = second.end;
    } else if (first.isSet) {
      rawIntervals.push(...first.intervals);
      if (first.hasNegatedOrBroad) hasNegatedOrBroad = true;
    } else {
      rawIntervals.push([first.codePoint, first.codePoint]);
    }
  }

  if (pos >= pattern.length || pattern[pos] !== ']') {
    throw makeError('INVALID_VALIDATION_PATTERN', 400, 'Unclosed "[" in regex pattern');
  }

  const intervals = normalizeIntervals(rawIntervals);
  return {
    end: pos + 1,
    node: {
      type: 'CharClass',
      intervals,
      rawIntervals: negated ? charSetComplement(intervals) : intervals,
      negated,
      isDot: false,
      hasNegatedOrBroad,
    },
  };
}

function matchQuantifierSyntaxAt(pattern, idx) {
  const ch = pattern[idx];
  if (ch === '*' || ch === '+' || ch === '?') {
    const greedy = pattern[idx + 1] !== '?';
    return {
      min: ch === '+' ? 1 : 0,
      max: ch === '?' ? 1 : Infinity,
      greedy,
      end: idx + 1 + (greedy ? 0 : 1),
    };
  }
  if (ch === '{') {
    const m = /^\{(\d+)(?:,(\d*))?\}(\??)/.exec(pattern.slice(idx));
    if (m) {
      const min = Number(m[1]);
      const max = m[2] === undefined ? min : (m[2] === '' ? Infinity : Number(m[2]));
      const greedy = m[3] !== '?';
      return { min, max, greedy, end: idx + m[0].length };
    }
  }
  return null;
}

function parseRegexAst(pattern) {
  if (typeof pattern !== 'string' || !pattern.length) {
    throw makeError('INVALID_VALIDATION_PATTERN', 400, 'Validation regex pattern must be a non-empty string');
  }
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) {
    throw makeError('INVALID_VALIDATION_PATTERN', 400, `Regex pattern exceeds max length (${MAX_REGEX_PATTERN_LENGTH})`);
  }

  const state = { pattern, pos: 0, quantifierCount: 0 };

  function parseAlt(stopOnParen, depth) {
    if (depth > MAX_REGEX_AST_DEPTH) {
      throw makeError('INVALID_VALIDATION_PATTERN', 400, `Regex nesting exceeds max depth (${MAX_REGEX_AST_DEPTH})`);
    }
    const branches = [];
    while (true) {
      branches.push(parseSeq(stopOnParen, depth));
      if (state.pos < pattern.length && pattern[state.pos] === '|') {
        state.pos += 1;
        continue;
      }
      break;
    }
    if (stopOnParen) {
      if (state.pos >= pattern.length || pattern[state.pos] !== ')') {
        throw makeError('INVALID_VALIDATION_PATTERN', 400, 'Unclosed "(" in regex pattern');
      }
      state.pos += 1;
    } else if (state.pos < pattern.length && pattern[state.pos] === ')') {
      throw makeError('INVALID_VALIDATION_PATTERN', 400, 'Unmatched ")" in regex pattern');
    }
    return { type: 'Alt', branches };
  }

  function parseSeq(stopOnParen, depth) {
    const items = [];
    while (state.pos < pattern.length) {
      const ch = pattern[state.pos];
      if (ch === '|') break;
      if (ch === ')') {
        if (stopOnParen) break;
        throw makeError('INVALID_VALIDATION_PATTERN', 400, 'Unmatched ")" in regex pattern');
      }

      const strayQ = matchQuantifierSyntaxAt(pattern, state.pos);
      if (strayQ) {
        throw makeError('INVALID_VALIDATION_PATTERN', 400, 'Invalid quantifier with no repeatable atom in regex pattern');
      }

      let atom;
      if (ch === '^' || ch === '$') {
        atom = { type: 'Anchor', kind: ch };
        state.pos += 1;
      } else if (ch === '.') {
        atom = {
          type: 'CharClass',
          intervals: CS_DOT_DEFAULT,
          rawIntervals: CS_DOT_DEFAULT,
          negated: false,
          isDot: true,
          hasNegatedOrBroad: true,
        };
        state.pos += 1;
      } else if (ch === '[') {
        const cc = parseCharClass(pattern, state.pos);
        atom = cc.node;
        state.pos = cc.end;
      } else if (ch === '(') {
        const hdr = parseGroupHeader(pattern, state.pos);
        state.pos = hdr.bodyStart;
        const body = parseAlt(true, depth + 1);
        atom = {
          type: 'Group',
          kind: hdr.kind,
          name: hdr.name,
          addFlags: hdr.addFlags,
          removeFlags: hdr.removeFlags,
          body,
        };
      } else if (ch === '\\') {
        const esc = parseEscapeToken(pattern, state.pos, { inClass: false });
        state.pos = esc.end;
        if (esc.node) {
          atom = esc.node;
        } else if (esc.intervals) {
          atom = {
            type: 'CharClass',
            intervals: esc.intervals,
            rawIntervals: esc.intervals,
            negated: false,
            isDot: false,
            hasNegatedOrBroad: Boolean(esc.hasNegatedOrBroad),
          };
        } else {
          atom = {
            type: 'Literal',
            codePoint: esc.codePoint,
          };
        }
      } else {
        const cu = pattern.charCodeAt(state.pos);
        atom = { type: 'Literal', codePoint: cu };
        state.pos += 1;
      }

      const q = state.pos < pattern.length ? matchQuantifierSyntaxAt(pattern, state.pos) : null;
      if (q) {
        if (atom.type === 'Anchor') {
          throw makeError('INVALID_VALIDATION_PATTERN', 400, 'Quantifier cannot follow an anchor in regex pattern');
        }
        if (q.min > MAX_REGEX_QUANTIFIER_BOUND || (Number.isFinite(q.max) && q.max > MAX_REGEX_QUANTIFIER_BOUND)) {
          throw makeError('INVALID_VALIDATION_PATTERN', 400, `Regex quantifier exceeds max bound (${MAX_REGEX_QUANTIFIER_BOUND})`);
        }
        if (q.min > q.max) {
          throw makeError('INVALID_VALIDATION_PATTERN', 400, 'Regex quantifier min exceeds max');
        }
        state.quantifierCount += 1;
        if (state.quantifierCount > MAX_REGEX_QUANTIFIER_BOUND) {
          throw makeError('INVALID_VALIDATION_PATTERN', 400, 'Too many quantifiers in regex pattern');
        }
        state.pos = q.end;
        if (state.pos < pattern.length && matchQuantifierSyntaxAt(pattern, state.pos)) {
          throw makeError('INVALID_VALIDATION_PATTERN', 400, 'Adjacent quantifiers are rejected for ReDoS safety');
        }
        atom = { type: 'Repeat', node: atom, min: q.min, max: q.max, greedy: q.greedy };
      }

      items.push(atom);
    }

    if (items.length === 0) return { type: 'Empty' };
    if (items.length === 1) return items[0];
    return { type: 'Seq', items };
  }

  return parseAlt(false, 0);
}

function childGroupFlags(groupNode, flags) {
  if (!groupNode || groupNode.kind !== 'modifier') return flags;
  let { ignoreCase, dotAll, multiline } = flags;
  if (groupNode.addFlags.includes('i')) ignoreCase = true;
  if (groupNode.removeFlags.includes('i')) ignoreCase = false;
  if (groupNode.addFlags.includes('s')) dotAll = true;
  if (groupNode.removeFlags.includes('s')) dotAll = false;
  if (groupNode.addFlags.includes('m')) multiline = true;
  if (groupNode.removeFlags.includes('m')) multiline = false;
  return { ignoreCase, dotAll, multiline: Boolean(multiline) };
}

function containsQuantifierGT1(node) {
  if (!node) return false;
  switch (node.type) {
    case 'Repeat':
      return node.max > 1 || containsQuantifierGT1(node.node);
    case 'Group':
      return containsQuantifierGT1(node.body);
    case 'Alt':
      return node.branches.some(containsQuantifierGT1);
    case 'Seq':
      return node.items.some(containsQuantifierGT1);
    default:
      return false;
  }
}

function canMatchEmpty(node) {
  if (!node) return true;
  switch (node.type) {
    case 'Empty':
    case 'Anchor':
      return true;
    case 'Literal':
    case 'CharClass':
      return false;
    case 'Group':
      if (node.kind === 'lookahead' || node.kind === 'negLookahead') return true;
      return canMatchEmpty(node.body);
    case 'Repeat':
      return node.min === 0 || canMatchEmpty(node.node);
    case 'Alt':
      return node.branches.some(canMatchEmpty);
    case 'Seq':
      return node.items.every(canMatchEmpty);
    default:
      return false;
  }
}

function atomCharSet(node, flags) {
  if (node.type === 'CharClass') {
    if (node.isDot) {
      return flags.dotAll ? CS_ANY : CS_DOT_DEFAULT;
    }
    let cs = node.intervals;
    if (flags.ignoreCase) {
      cs = charSetCaseFold(cs);
    }
    return node.negated ? charSetComplement(cs) : cs;
  }
  if (node.type === 'Literal') {
    const cs = [[node.codePoint, node.codePoint]];
    return flags.ignoreCase ? charSetCaseFold(cs) : cs;
  }
  return [];
}

function firstChars(node, flags) {
  if (!node) return [];
  switch (node.type) {
    case 'Empty':
    case 'Anchor':
      return [];
    case 'Literal':
    case 'CharClass':
      return atomCharSet(node, flags);
    case 'Repeat':
      return node.max === 0 ? [] : firstChars(node.node, flags);
    case 'Group':
      if (node.kind === 'lookahead' || node.kind === 'negLookahead') return [];
      return firstChars(node.body, childGroupFlags(node, flags));
    case 'Alt': {
      let acc = [];
      for (const b of node.branches) {
        acc = charSetUnion(acc, firstChars(b, flags));
      }
      return acc;
    }
    case 'Seq': {
      let acc = [];
      for (const item of node.items) {
        acc = charSetUnion(acc, firstChars(item, flags));
        if (!canMatchEmpty(item)) break;
      }
      return acc;
    }
    default:
      return [];
  }
}

function lastChars(node, flags) {
  if (!node) return [];
  switch (node.type) {
    case 'Empty':
    case 'Anchor':
      return [];
    case 'Literal':
    case 'CharClass':
      return atomCharSet(node, flags);
    case 'Repeat':
      return node.max === 0 ? [] : lastChars(node.node, flags);
    case 'Group':
      if (node.kind === 'lookahead' || node.kind === 'negLookahead') return [];
      return lastChars(node.body, childGroupFlags(node, flags));
    case 'Alt': {
      let acc = [];
      for (const b of node.branches) {
        acc = charSetUnion(acc, lastChars(b, flags));
      }
      return acc;
    }
    case 'Seq': {
      let acc = [];
      for (let i = node.items.length - 1; i >= 0; i -= 1) {
        const item = node.items[i];
        acc = charSetUnion(acc, lastChars(item, flags));
        if (!canMatchEmpty(item)) break;
      }
      return acc;
    }
    default:
      return [];
  }
}

function hasNegatedOrBroadLead(node, flags) {
  if (!node) return false;
  switch (node.type) {
    case 'Empty':
    case 'Anchor':
    case 'Literal':
      return false;
    case 'CharClass':
      return Boolean(node.isDot || node.negated || node.hasNegatedOrBroad);
    case 'Repeat':
      return node.max > 0 && hasNegatedOrBroadLead(node.node, flags);
    case 'Group':
      if (node.kind === 'lookahead' || node.kind === 'negLookahead') return false;
      return hasNegatedOrBroadLead(node.body, childGroupFlags(node, flags));
    case 'Alt':
      return node.branches.some((b) => hasNegatedOrBroadLead(b, flags));
    case 'Seq':
      for (const item of node.items) {
        if (hasNegatedOrBroadLead(item, flags)) return true;
        if (!canMatchEmpty(item)) break;
      }
      return false;
    default:
      return false;
  }
}

function analyzeInsideRepeat(node, flags, followAfterNode) {
  if (!node) return;
  switch (node.type) {
    case 'Group': {
      const nextFlags = childGroupFlags(node, flags);
      if (node.kind === 'lookahead' || node.kind === 'negLookahead') {
        analyzeAst(node.body, nextFlags);
        return;
      }
      analyzeInsideRepeat(node.body, nextFlags, followAfterNode);
      return;
    }
    case 'Repeat':
      analyzeInsideRepeat(node.node, flags, followAfterNode);
      return;
    case 'Alt': {
      if (node.branches.length > 1) {
        let seenChars = [];
        for (const branch of node.branches) {
          if (canMatchEmpty(branch) || hasNegatedOrBroadLead(branch, flags)) {
            throw makeError('INVALID_VALIDATION_PATTERN', 400, 'Ambiguous quantified alternation rejected for ReDoS safety');
          }
          const lead = firstChars(branch, flags);
          if (charSetIntersects(seenChars, lead)) {
            throw makeError('INVALID_VALIDATION_PATTERN', 400, 'Overlapping quantified alternation rejected for ReDoS safety');
          }
          seenChars = charSetUnion(seenChars, lead);
        }
      }
      for (const branch of node.branches) {
        analyzeInsideRepeat(branch, flags, followAfterNode);
      }
      return;
    }
    case 'Seq': {
      let afterFirst = followAfterNode || [];
      for (let i = node.items.length - 1; i >= 0; i -= 1) {
        const item = node.items[i];
        const itemFirst = firstChars(item, flags);
        const itemNullable = canMatchEmpty(item);
        if (itemNullable && charSetIntersects(itemFirst, afterFirst)) {
          throw makeError('INVALID_VALIDATION_PATTERN', 400, 'Ambiguous quantified optional sequence rejected for ReDoS safety');
        }
        analyzeInsideRepeat(item, flags, afterFirst);
        afterFirst = itemNullable ? charSetUnion(itemFirst, afterFirst) : itemFirst;
      }
      return;
    }
    default:
      return;
  }
}

const MAX_CHAIN_FRONTIER_STATES = 12;
const MAX_BRIDGE_ATOMS = 8;
const MAX_REPEAT_SEQ_PATHS = 12;
const MAX_REPEAT_SEQ_LEN = MAX_REGEX_PATTERN_LENGTH;
const MAX_ACTIVE_SEQS = 12;
const MAX_ACTIVE_OVERFLOWS = 8;
const MAX_SEQ_BRIDGE_LEN = MAX_REGEX_PATTERN_LENGTH;
const MAX_SEQ_LCM_CHECK = 64;
const MAX_UNBOUNDED_PREFIX_BOUNDED_SPAN = 4;
const MAX_CONFIRMED_OVERLAP_BOUNDED_PRODUCT = 1000;
const MAX_NFA_STATES = 512;
const MAX_UNANCHORED_ROOT_NFA_STATES = 320;
const MAX_TOTAL_LOOKAHEAD_STATES = 120;
const MAX_SAFE_REGEX_CACHE = 256;

function spanOne() {
  return { bounded: 1, unbounded: 0 };
}

function spanBounded(n) {
  return { bounded: n, unbounded: 0 };
}

function spanUnbounded() {
  return { bounded: 1, unbounded: 1 };
}

function mulSpan(a, b) {
  return {
    bounded: a.bounded * b.bounded,
    unbounded: a.unbounded + b.unbounded,
  };
}

function maxSpan(a, b) {
  if (a.unbounded !== b.unbounded) {
    return a.unbounded > b.unbounded ? a : b;
  }
  return a.bounded >= b.bounded ? a : b;
}

function spansEqual(a, b) {
  return a.bounded === b.bounded && a.unbounded === b.unbounded;
}

function freshChainState() {
  return {
    tailSpan: spanOne(),
    tailChars: [],
    bridgeAtoms: [],
    takenSeqs: [],
    overflowTaken: [],
    skipSpan: spanOne(),
    skipChars: [],
    skipSeqs: [],
    overflowSkip: [],
    confirmedOverlapBounded: 1,
    inActiveOverlap: false,
  };
}

function charSetsEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1]) return false;
  }
  return true;
}

function bridgeAtomsEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!charSetsEqual(a[i], b[i])) return false;
  }
  return true;
}

function gcd(a, b) {
  let x = a;
  let y = b;
  while (y !== 0) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

function lcm(a, b) {
  if (a === 0 || b === 0) return 0;
  return (a / gcd(a, b)) * b;
}

function seqEntrySignatureEqual(a, b) {
  return a.pos === b.pos && bridgeAtomsEqual(a.seq, b.seq) && bridgeAtomsEqual(a.bridge, b.bridge);
}

function seqEntriesSameSignature(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].span.unbounded !== b[i].span.unbounded || !seqEntrySignatureEqual(a[i], b[i])) {
      return false;
    }
  }
  return true;
}

function seqEntriesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!spansEqual(a[i].span, b[i].span) || !seqEntrySignatureEqual(a[i], b[i])) {
      return false;
    }
  }
  return true;
}

function mergeSeqEntries(listA, listB) {
  const out = [];
  const addEntry = (entry) => {
    for (let i = 0; i < out.length; i += 1) {
      if (seqEntrySignatureEqual(out[i], entry)) {
        out[i] = {
          seq: out[i].seq,
          pos: out[i].pos,
          span: maxSpan(out[i].span, entry.span),
          bridge: out[i].bridge,
        };
        return;
      }
    }
    if (out.length < MAX_ACTIVE_SEQS) {
      out.push(entry);
    }
  };
  for (const e of listA || []) addEntry(e);
  for (const e of listB || []) addEntry(e);
  return out;
}

function coalesceSeqEntries(listA, listB) {
  if (!listA || listA.length === 0) return [];
  return listA.map((e, i) => ({
    seq: e.seq,
    pos: e.pos,
    span: maxSpan(e.span, listB[i].span),
    bridge: e.bridge,
  }));
}

function appendSeqBridge(bridge, charSet, seqLen) {
  if (bridge.length < MAX_SEQ_BRIDGE_LEN) {
    return [...bridge, charSet];
  }
  const next = [...bridge];
  const idx = bridge.length % Math.min(seqLen, MAX_SEQ_BRIDGE_LEN);
  next[idx] = charSetUnion(next[idx], charSet);
  return next;
}

function stepSeqEntries(entries, charSet) {
  if (!entries || entries.length === 0) return [];
  const out = [];
  for (const e of entries) {
    if (!charSetIntersects(e.seq[e.pos], charSet)) continue;
    const nextPos = (e.pos + 1) % e.seq.length;
    const nextBridge = appendSeqBridge(e.bridge, charSet, e.seq.length);
    out.push({
      seq: e.seq,
      pos: nextPos,
      span: e.span,
      bridge: nextBridge,
    });
  }
  return mergeSeqEntries(out, []);
}

function maxSeqCursorSpan(entries, targetChars) {
  if (!entries || entries.length === 0 || !targetChars || targetChars.length === 0) {
    return null;
  }
  let best = null;
  for (const e of entries) {
    if (charSetIntersects(e.seq[e.pos], targetChars)) {
      best = best ? maxSpan(best, e.span) : e.span;
    }
  }
  return best;
}

function seqEntryOverlapsTargetSeq(entry, targetSeq) {
  if (entry.pos === 0) {
    for (let k = 0; k < entry.bridge.length; k += 1) {
      if (!charSetIntersects(entry.bridge[k], targetSeq[k % targetSeq.length])) {
        return false;
      }
    }
  }
  const period = Math.min(lcm(entry.seq.length, targetSeq.length), MAX_SEQ_LCM_CHECK);
  for (let i = 0; i < period; i += 1) {
    const sc = entry.seq[(entry.pos + i) % entry.seq.length];
    const tc = targetSeq[i % targetSeq.length];
    if (!charSetIntersects(sc, tc)) return false;
  }
  return true;
}

function maxSeqOverlapSpan(entries, targetPaths) {
  if (!entries || entries.length === 0 || !targetPaths || targetPaths.length === 0) {
    return null;
  }
  let best = null;
  for (const e of entries) {
    for (const tp of targetPaths) {
      if (tp.length === 0) continue;
      if (seqEntryOverlapsTargetSeq(e, tp)) {
        best = best ? maxSpan(best, e.span) : e.span;
        break;
      }
    }
  }
  return best;
}

function upgradeMatchingSeqSpans(entries, targetPaths, newSpan) {
  if (!entries || entries.length === 0 || !targetPaths || targetPaths.length === 0) {
    return entries || [];
  }
  return entries.map((e) => {
    for (const tp of targetPaths) {
      if (tp.length > 0 && seqEntryOverlapsTargetSeq(e, tp)) {
        return { ...e, span: maxSpan(e.span, newSpan) };
      }
    }
    return e;
  });
}

function overflowEntrySignatureEqual(a, b) {
  return (
    charSetsEqual(a.firstChars, b.firstChars) &&
    charSetsEqual(a.lastChars, b.lastChars) &&
    charSetsEqual(a.bodyChars, b.bodyChars)
  );
}

function overflowEntriesSameSignature(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].span.unbounded !== b[i].span.unbounded || !overflowEntrySignatureEqual(a[i], b[i])) {
      return false;
    }
  }
  return true;
}

function overflowEntriesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!spansEqual(a[i].span, b[i].span) || !overflowEntrySignatureEqual(a[i], b[i])) {
      return false;
    }
  }
  return true;
}

function mergeOverflowEntries(listA, listB) {
  const out = [];
  const addEntry = (entry) => {
    for (let i = 0; i < out.length; i += 1) {
      if (overflowEntrySignatureEqual(out[i], entry)) {
        out[i] = {
          firstChars: out[i].firstChars,
          lastChars: out[i].lastChars,
          bodyChars: out[i].bodyChars,
          span: maxSpan(out[i].span, entry.span),
        };
        return;
      }
    }
    if (out.length < MAX_ACTIVE_OVERFLOWS) {
      out.push(entry);
    }
  };
  for (const e of listA || []) addEntry(e);
  for (const e of listB || []) addEntry(e);
  return out;
}

function coalesceOverflowEntries(listA, listB) {
  if (!listA || listA.length === 0) return [];
  return listA.map((e, i) => ({
    firstChars: e.firstChars,
    lastChars: e.lastChars,
    bodyChars: e.bodyChars,
    span: maxSpan(e.span, listB[i].span),
  }));
}

function stepOverflowEntries(entries, charSet) {
  if (!entries || entries.length === 0) return [];
  const out = [];
  for (const e of entries) {
    if (charSetIntersects(e.bodyChars, charSet)) {
      out.push(e);
    }
  }
  return out;
}

function overflowEntryOverlaps(entry, bFirst, bLast, bBody) {
  return (
    charSetIntersects(entry.firstChars, bFirst) &&
    charSetIntersects(entry.lastChars, bLast) &&
    charSetIntersects(entry.bodyChars, bBody)
  );
}

function maxOverflowOverlapSpan(entries, bFirst, bLast, bBody) {
  if (!entries || entries.length === 0 || !bFirst?.length || !bLast?.length || !bBody?.length) {
    return null;
  }
  let best = null;
  for (const e of entries) {
    if (overflowEntryOverlaps(e, bFirst, bLast, bBody)) {
      best = best ? maxSpan(best, e.span) : e.span;
    }
  }
  return best;
}

function upgradeMatchingOverflowSpans(entries, bFirst, bLast, bBody, newSpan) {
  if (!entries || entries.length === 0) return entries || [];
  return entries.map((e) => (
    overflowEntryOverlaps(e, bFirst, bLast, bBody)
      ? { ...e, span: maxSpan(e.span, newSpan) }
      : e
  ));
}

function advancePartialSeqEntries(entries, targetPaths, minRepeat, maxRepeat) {
  if (!entries || entries.length === 0 || !targetPaths || targetPaths.length === 0) {
    return [];
  }
  const effectiveMin = Math.max(1, minRepeat);
  const out = [];
  for (const e of entries) {
    if (e.pos <= 0) continue;
    const remaining = e.seq.length - e.pos;
    for (const tp of targetPaths) {
      if (tp.length === 0 || tp.length > remaining) continue;
      const maxReps = Math.min(maxRepeat, Math.floor(remaining / tp.length));
      if (maxReps < effectiveMin) continue;
      let curPos = e.pos;
      let curBridge = e.bridge;
      let matchedAll = true;
      for (let m = 1; m <= maxReps; m += 1) {
        for (let k = 0; k < tp.length; k += 1) {
          if (!charSetIntersects(e.seq[curPos], tp[k])) {
            matchedAll = false;
            break;
          }
          curBridge = appendSeqBridge(curBridge, tp[k], e.seq.length);
          curPos += 1;
        }
        if (!matchedAll) break;
        if (m >= effectiveMin) {
          out.push({
            seq: e.seq,
            pos: curPos % e.seq.length,
            span: e.span,
            bridge: curBridge,
          });
        }
      }
    }
  }
  return mergeSeqEntries(out, []);
}

function allBodyChars(node, flags) {
  if (!node) return [];
  switch (node.type) {
    case 'Empty':
    case 'Anchor':
      return [];
    case 'Literal':
    case 'CharClass':
      return atomCharSet(node, flags);
    case 'Group':
      if (node.kind === 'lookahead' || node.kind === 'negLookahead') return [];
      return allBodyChars(node.body, childGroupFlags(node, flags));
    case 'Repeat':
      return node.max === 0 ? [] : allBodyChars(node.node, flags);
    case 'Alt': {
      let acc = [];
      for (const b of node.branches) {
        acc = charSetUnion(acc, allBodyChars(b, flags));
      }
      return acc;
    }
    case 'Seq': {
      let acc = [];
      for (const item of node.items) {
        acc = charSetUnion(acc, allBodyChars(item, flags));
      }
      return acc;
    }
    default:
      return [];
  }
}

function collapseUniformPaths(paths) {
  if (!paths || paths.length === 0) return null;
  const len = paths[0].length;
  if (len === 0) return null;
  for (let i = 1; i < paths.length; i += 1) {
    if (paths[i].length !== len) return null;
  }
  const collapsed = Array.from({ length: len }, () => []);
  for (const p of paths) {
    for (let k = 0; k < len; k += 1) {
      collapsed[k] = charSetUnion(collapsed[k], p[k]);
    }
  }
  return [collapsed];
}

function combinePathProduct(acc, ip) {
  if (!acc || !ip) return null;
  if (acc.length * ip.length > MAX_REPEAT_SEQ_PATHS) {
    const accU = collapseUniformPaths(acc);
    const ipU = collapseUniformPaths(ip);
    if (!accU || !ipU) return null;
    if (accU[0].length + ipU[0].length > MAX_REPEAT_SEQ_LEN) return null;
    return [[...accU[0], ...ipU[0]]];
  }
  const next = [];
  for (const prefix of acc) {
    for (const suffix of ip) {
      if (prefix.length + suffix.length > MAX_REPEAT_SEQ_LEN) return null;
      next.push([...prefix, ...suffix]);
      if (next.length > MAX_REPEAT_SEQ_PATHS) return null;
    }
  }
  return next;
}

function extractNodePaths(node, flags) {
  if (!node) return [[]];
  switch (node.type) {
    case 'Empty':
    case 'Anchor':
      return [[]];
    case 'Literal':
    case 'CharClass':
      return [[atomCharSet(node, flags)]];
    case 'Group': {
      if (node.kind === 'lookahead' || node.kind === 'negLookahead') return [[]];
      return extractNodePaths(node.body, childGroupFlags(node, flags));
    }
    case 'Alt': {
      const out = [];
      let allLenOne = true;
      let uniformLen = undefined;
      for (const b of node.branches) {
        const bp = extractNodePaths(b, flags);
        if (!bp) return null;
        for (const p of bp) {
          if (p.length !== 1) allLenOne = false;
          if (uniformLen === undefined) {
            uniformLen = p.length;
          } else if (uniformLen !== p.length) {
            uniformLen = null;
          }
          out.push(p);
          if (out.length > MAX_REPEAT_SEQ_PATHS && uniformLen === null) {
            return null;
          }
        }
      }
      if (out.length > 0 && allLenOne) {
        let unionCs = [];
        for (const p of out) {
          unionCs = charSetUnion(unionCs, p[0]);
        }
        return [[unionCs]];
      }
      if (out.length > MAX_REPEAT_SEQ_PATHS) {
        return collapseUniformPaths(out);
      }
      return out;
    }
    case 'Seq': {
      let acc = [[]];
      for (const item of node.items) {
        const ip = extractNodePaths(item, flags);
        acc = combinePathProduct(acc, ip);
        if (!acc) return null;
      }
      return acc;
    }
    case 'Repeat': {
      if (node.max === 0) return [[]];
      if (node.max > 1 && node.min !== node.max) return null;
      const inner = extractNodePaths(node.node, flags);
      if (!inner) return null;
      if (node.min === 0 && node.max === 1) {
        const out = [[]];
        for (const p of inner) {
          out.push(p);
          if (out.length > MAX_REPEAT_SEQ_PATHS) return null;
        }
        return out;
      }
      let acc = [[]];
      for (let r = 0; r < node.min; r += 1) {
        acc = combinePathProduct(acc, inner);
        if (!acc) return null;
      }
      return acc;
    }
    default:
      return null;
  }
}

function appendBridgeAtom(bridgeAtoms, charSet) {
  for (const existing of bridgeAtoms) {
    if (charSetsEqual(existing, charSet)) return bridgeAtoms;
  }
  if (bridgeAtoms.length >= MAX_BRIDGE_ATOMS) {
    const merged = [...bridgeAtoms];
    merged[merged.length - 1] = charSetUnion(merged[merged.length - 1], charSet);
    return merged;
  }
  return [...bridgeAtoms, charSet];
}

function bridgeMatchesTarget(bridgeAtoms, targetChars) {
  if (!targetChars || targetChars.length === 0) return false;
  for (const atom of bridgeAtoms) {
    if (!charSetIntersects(atom, targetChars)) return false;
  }
  return true;
}

function mergeChainStates(a, b) {
  return {
    tailSpan: maxSpan(a.tailSpan, b.tailSpan),
    tailChars: charSetUnion(a.tailChars, b.tailChars),
    bridgeAtoms: (a.bridgeAtoms.length === 0 || b.bridgeAtoms.length === 0)
      ? []
      : a.bridgeAtoms.filter((at) => b.bridgeAtoms.some((bt) => charSetsEqual(at, bt))),
    takenSeqs: mergeSeqEntries(a.takenSeqs, b.takenSeqs),
    overflowTaken: mergeOverflowEntries(a.overflowTaken, b.overflowTaken),
    skipSpan: maxSpan(a.skipSpan, b.skipSpan),
    skipChars: charSetUnion(a.skipChars, b.skipChars),
    skipSeqs: mergeSeqEntries(a.skipSeqs, b.skipSeqs),
    overflowSkip: mergeOverflowEntries(a.overflowSkip, b.overflowSkip),
    confirmedOverlapBounded: Math.max(a.confirmedOverlapBounded, b.confirmedOverlapBounded),
    inActiveOverlap: Boolean(a.inActiveOverlap && b.inActiveOverlap),
  };
}

function coalesceFrontier(states) {
  const out = [];
  for (const st of states) {
    let merged = false;
    for (let i = 0; i < out.length; i += 1) {
      const cur = out[i];
      if (
        cur.tailSpan.unbounded === st.tailSpan.unbounded &&
        cur.skipSpan.unbounded === st.skipSpan.unbounded &&
        charSetsEqual(cur.tailChars, st.tailChars) &&
        bridgeAtomsEqual(cur.bridgeAtoms, st.bridgeAtoms) &&
        charSetsEqual(cur.skipChars, st.skipChars) &&
        seqEntriesSameSignature(cur.takenSeqs, st.takenSeqs) &&
        overflowEntriesSameSignature(cur.overflowTaken, st.overflowTaken) &&
        seqEntriesSameSignature(cur.skipSeqs, st.skipSeqs) &&
        overflowEntriesSameSignature(cur.overflowSkip, st.overflowSkip)
      ) {
        out[i] = {
          tailSpan: maxSpan(cur.tailSpan, st.tailSpan),
          tailChars: cur.tailChars,
          bridgeAtoms: cur.bridgeAtoms,
          takenSeqs: coalesceSeqEntries(cur.takenSeqs, st.takenSeqs),
          overflowTaken: coalesceOverflowEntries(cur.overflowTaken, st.overflowTaken),
          skipSpan: maxSpan(cur.skipSpan, st.skipSpan),
          skipChars: cur.skipChars,
          skipSeqs: coalesceSeqEntries(cur.skipSeqs, st.skipSeqs),
          overflowSkip: coalesceOverflowEntries(cur.overflowSkip, st.overflowSkip),
          confirmedOverlapBounded: Math.max(cur.confirmedOverlapBounded, st.confirmedOverlapBounded),
          inActiveOverlap: Boolean(cur.inActiveOverlap && st.inActiveOverlap),
        };
        merged = true;
        break;
      }
    }
    if (!merged) out.push(st);
  }
  while (out.length > MAX_CHAIN_FRONTIER_STATES) {
    const b = out.pop();
    const a = out.pop();
    out.push(mergeChainStates(a, b));
  }
  return out;
}

function frontierEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (
      !spansEqual(a[i].tailSpan, b[i].tailSpan) ||
      !spansEqual(a[i].skipSpan, b[i].skipSpan) ||
      a[i].confirmedOverlapBounded !== b[i].confirmedOverlapBounded ||
      a[i].inActiveOverlap !== b[i].inActiveOverlap ||
      !charSetsEqual(a[i].tailChars, b[i].tailChars) ||
      !bridgeAtomsEqual(a[i].bridgeAtoms, b[i].bridgeAtoms) ||
      !charSetsEqual(a[i].skipChars, b[i].skipChars) ||
      !seqEntriesEqual(a[i].takenSeqs, b[i].takenSeqs) ||
      !overflowEntriesEqual(a[i].overflowTaken, b[i].overflowTaken) ||
      !seqEntriesEqual(a[i].skipSeqs, b[i].skipSeqs) ||
      !overflowEntriesEqual(a[i].overflowSkip, b[i].overflowSkip)
    ) {
      return false;
    }
  }
  return true;
}

function assertSpanSafe(span, msg = 'Adjacent overlapping quantifiers are rejected for ReDoS safety') {
  if (
    !span ||
    span.unbounded >= 2 ||
    span.bounded > MAX_ADJACENT_BOUNDED_SPAN_PRODUCT ||
    (span.unbounded === 1 && span.bounded > MAX_UNBOUNDED_PREFIX_BOUNDED_SPAN)
  ) {
    throw makeError('INVALID_VALIDATION_PATTERN', 400, msg);
  }
}

function assertConfirmedOverlapSafe(confirmedOverlapBounded, msg = 'Adjacent overlapping quantifiers are rejected for ReDoS safety') {
  if (confirmedOverlapBounded > MAX_CONFIRMED_OVERLAP_BOUNDED_PRODUCT) {
    throw makeError('INVALID_VALIDATION_PATTERN', 400, msg);
  }
}

function stepMandatoryAtom(states, charSet) {
  if (!charSet || charSet.length === 0) return states;
  const next = [];
  for (const s of states) {
    const tailKeep = s.tailChars.length > 0 && charSetIntersects(s.tailChars, charSet);
    const skipKeep = s.skipChars.length > 0 && charSetIntersects(s.skipChars, charSet);
    const nextTakenSeqs = stepSeqEntries(s.takenSeqs, charSet);
    const nextSkipSeqs = stepSeqEntries(s.skipSeqs, charSet);
    const nextTakenOverflows = stepOverflowEntries(s.overflowTaken, charSet);
    const nextSkipOverflows = stepOverflowEntries(s.overflowSkip, charSet);
    const anyAlive = (
      tailKeep ||
      skipKeep ||
      nextTakenSeqs.length > 0 ||
      nextSkipSeqs.length > 0 ||
      nextTakenOverflows.length > 0 ||
      nextSkipOverflows.length > 0
    );
    next.push({
      tailSpan: tailKeep ? s.tailSpan : spanOne(),
      tailChars: tailKeep ? s.tailChars : [],
      bridgeAtoms: tailKeep ? appendBridgeAtom(s.bridgeAtoms, charSet) : [],
      takenSeqs: nextTakenSeqs,
      overflowTaken: nextTakenOverflows,
      skipSpan: skipKeep ? s.skipSpan : spanOne(),
      skipChars: skipKeep ? s.skipChars : [],
      skipSeqs: nextSkipSeqs,
      overflowSkip: nextSkipOverflows,
      confirmedOverlapBounded: s.confirmedOverlapBounded,
      inActiveOverlap: anyAlive ? s.inActiveOverlap : false,
    });
  }
  return coalesceFrontier(next);
}

function stateTailIntersects(s, targetChars) {
  if (s.tailChars.length === 0 || targetChars.length === 0) return false;
  if (!charSetIntersects(s.tailChars, targetChars)) return false;
  return bridgeMatchesTarget(s.bridgeAtoms, targetChars);
}

function stateTailEffectiveSpan(s, targetChars) {
  const charHit = stateTailIntersects(s, targetChars);
  const seqSpan = maxSeqCursorSpan(s.takenSeqs, targetChars);
  if (!charHit && !seqSpan) return null;
  if (charHit && seqSpan) return maxSpan(s.tailSpan, seqSpan);
  return charHit ? s.tailSpan : seqSpan;
}

function stateSkipEffectiveSpan(s, targetChars) {
  const charHit = s.skipChars.length > 0 && targetChars.length > 0 && charSetIntersects(s.skipChars, targetChars);
  const seqSpan = maxSeqCursorSpan(s.skipSeqs, targetChars);
  if (!charHit && !seqSpan) return null;
  if (charHit && seqSpan) return maxSpan(s.skipSpan, seqSpan);
  return charHit ? s.skipSpan : seqSpan;
}

function analyzeChain(node, flags = { ignoreCase: false, dotAll: false }, inStates = [freshChainState()]) {
  if (!node) return inStates;
  switch (node.type) {
    case 'Empty':
    case 'Anchor':
      return inStates;
    case 'Literal':
    case 'CharClass':
      return stepMandatoryAtom(inStates, atomCharSet(node, flags));
    case 'Group': {
      const nextFlags = childGroupFlags(node, flags);
      if (node.kind === 'lookahead' || node.kind === 'negLookahead') {
        analyzeChain(node.body, nextFlags, [freshChainState()]);
        return inStates;
      }
      return analyzeChain(node.body, nextFlags, inStates);
    }
    case 'Alt': {
      if (node.branches.length === 0) return inStates;
      if (node.branches.length === 1) {
        return analyzeChain(node.branches[0], flags, inStates);
      }
      const branchEmpty = node.branches.map(canMatchEmpty);
      const branchFirsts = node.branches.map((b, idx) => (branchEmpty[idx] ? [] : firstChars(b, flags)));
      const emptyBranchCount = branchEmpty.filter(Boolean).length;
      const altNullable = emptyBranchCount > 0;
      const altFirst = altNullable ? firstChars(node, flags) : [];

      let seenFirst = [];
      let overlapFirst = [];
      let overlapBranchCount = 0;
      for (let i = 0; i < node.branches.length; i += 1) {
        if (branchEmpty[i]) continue;
        const bf = branchFirsts[i];
        if (bf.length > 0 && charSetIntersects(seenFirst, bf)) {
          overlapBranchCount = overlapBranchCount === 0 ? 2 : overlapBranchCount + 1;
          overlapFirst = charSetUnion(overlapFirst, bf);
        }
        seenFirst = charSetUnion(seenFirst, bf);
      }

      const branchHasDisjointOrNullableOther = node.branches.map((_, bi) => {
        if (branchEmpty[bi]) return false;
        const bf = branchFirsts[bi];
        if (bf.length === 0) return false;
        return node.branches.some((__, oi) => oi !== bi && (branchEmpty[oi] || !charSetIntersects(branchFirsts[oi], bf)));
      });

      const disjointFactorForState = (s) => {
        let overlappingCount = 0;
        let hasNonOverlappingForS = false;
        for (let oi = 0; oi < node.branches.length; oi += 1) {
          if (branchEmpty[oi]) {
            hasNonOverlappingForS = true;
            continue;
          }
          const obf = branchFirsts[oi];
          const oIntersects = branchHasDisjointOrNullableOther[oi]
            && Boolean(stateTailEffectiveSpan(s, obf) || stateSkipEffectiveSpan(s, obf));
          if (oIntersects) {
            overlappingCount += 1;
          } else {
            hasNonOverlappingForS = true;
          }
        }
        return Math.max(2, overlappingCount + (hasNonOverlappingForS ? 1 : 0));
      };

      const out = [];
      for (let bi = 0; bi < node.branches.length; bi += 1) {
        const branch = node.branches[bi];
        const bEmpty = branchEmpty[bi];
        if (altNullable && bEmpty && (altFirst.length > 0 || emptyBranchCount >= 2)) {
          const emptyFactor = emptyBranchCount >= 2 ? emptyBranchCount : 1;
          for (const s of inStates) {
            const effSkipSpan = stateSkipEffectiveSpan(s, altFirst);
            const effTailSpan = stateTailEffectiveSpan(s, altFirst);
            const skipOverlap = Boolean(effSkipSpan);
            const tailOverlap = Boolean(effTailSpan);
            let nextSkipSpan = maxSpan(s.skipSpan, spanBounded(2));
            if (skipOverlap) {
              nextSkipSpan = mulSpan(effSkipSpan, spanBounded(2));
              assertSpanSafe(nextSkipSpan);
            }
            let nextTailSpan = s.tailSpan;
            if (tailOverlap) {
              nextTailSpan = mulSpan(effTailSpan, spanBounded(2));
              assertSpanSafe(nextTailSpan);
            }
            let nextConfirmed = s.confirmedOverlapBounded;
            let nextInActive = s.inActiveOverlap;
            if (tailOverlap || skipOverlap || emptyBranchCount >= 2) {
              const priorBounded = Math.max(
                tailOverlap ? effTailSpan.bounded : 1,
                skipOverlap ? effSkipSpan.bounded : 1,
              );
              const overlapStep = (tailOverlap || skipOverlap) ? 2 : 1;
              nextConfirmed = s.confirmedOverlapBounded * (
                s.inActiveOverlap ? (overlapStep * emptyFactor) : (priorBounded * overlapStep * emptyFactor)
              );
              assertConfirmedOverlapSafe(nextConfirmed);
              nextInActive = (tailOverlap || skipOverlap) ? true : s.inActiveOverlap;
            }
            out.push(...analyzeChain(branch, flags, [{
              tailSpan: nextTailSpan,
              tailChars: s.tailChars,
              bridgeAtoms: s.bridgeAtoms,
              takenSeqs: s.takenSeqs,
              overflowTaken: s.overflowTaken,
              skipSpan: nextSkipSpan,
              skipChars: charSetUnion(s.skipChars, altFirst),
              skipSeqs: s.skipSeqs,
              overflowSkip: s.overflowSkip,
              confirmedOverlapBounded: nextConfirmed,
              inActiveOverlap: nextInActive,
            }]));
          }
        } else if (overlapBranchCount > 1 && !bEmpty) {
          const bf = branchFirsts[bi];
          const bl = lastChars(branch, flags);
          const branchOverlapsAlt = bf.length > 0 && charSetIntersects(overlapFirst, bf);
          const overlapSpan = spanBounded(overlapBranchCount);
          const branchIn = [];
          for (const s of inStates) {
            const effTailSpan = stateTailEffectiveSpan(s, bf);
            const effSkipSpan = stateSkipEffectiveSpan(s, bf);
            if (effTailSpan) {
              const nextSpan = mulSpan(effTailSpan, overlapSpan);
              assertSpanSafe(nextSpan);
              const nextConfirmed = s.confirmedOverlapBounded * (
                s.inActiveOverlap ? overlapBranchCount : (effTailSpan.bounded * overlapBranchCount)
              );
              assertConfirmedOverlapSafe(nextConfirmed);
              branchIn.push({
                tailSpan: nextSpan,
                tailChars: s.tailChars,
                bridgeAtoms: s.bridgeAtoms,
                takenSeqs: s.takenSeqs,
                overflowTaken: s.overflowTaken,
                skipSpan: s.skipSpan,
                skipChars: s.skipChars,
                skipSeqs: s.skipSeqs,
                overflowSkip: s.overflowSkip,
                confirmedOverlapBounded: nextConfirmed,
                inActiveOverlap: true,
              });
            } else if (branchOverlapsAlt) {
              const nextConfirmed = s.confirmedOverlapBounded * overlapBranchCount;
              assertConfirmedOverlapSafe(nextConfirmed);
              branchIn.push({
                tailSpan: s.tailSpan,
                tailChars: s.tailChars,
                bridgeAtoms: s.bridgeAtoms,
                takenSeqs: s.takenSeqs,
                overflowTaken: s.overflowTaken,
                skipSpan: s.skipSpan,
                skipChars: s.skipChars,
                skipSeqs: s.skipSeqs,
                overflowSkip: s.overflowSkip,
                confirmedOverlapBounded: nextConfirmed,
                inActiveOverlap: s.inActiveOverlap,
              });
            } else if (branchHasDisjointOrNullableOther[bi] && effSkipSpan) {
              const altBranchFactor = disjointFactorForState(s);
              const stepFactor = s.inActiveOverlap ? altBranchFactor : Math.max(altBranchFactor, effSkipSpan.bounded);
              const nextConfirmed = s.confirmedOverlapBounded * stepFactor;
              assertConfirmedOverlapSafe(nextConfirmed);
              branchIn.push({
                tailSpan: s.tailSpan,
                tailChars: s.tailChars,
                bridgeAtoms: s.bridgeAtoms,
                takenSeqs: s.takenSeqs,
                overflowTaken: s.overflowTaken,
                skipSpan: s.skipSpan,
                skipChars: s.skipChars,
                skipSeqs: s.skipSeqs,
                overflowSkip: s.overflowSkip,
                confirmedOverlapBounded: nextConfirmed,
                inActiveOverlap: true,
              });
            } else {
              branchIn.push(s);
            }
          }
          const branchOut = analyzeChain(branch, flags, branchIn);
          for (const bo of branchOut) {
            if (bo.tailChars.length === 0 && bl.length > 0 && branchOverlapsAlt) {
              out.push({
                tailSpan: maxSpan(bo.tailSpan, overlapSpan),
                tailChars: bl,
                bridgeAtoms: [],
                takenSeqs: bo.takenSeqs,
                overflowTaken: bo.overflowTaken,
                skipSpan: bo.skipSpan,
                skipChars: bo.skipChars,
                skipSeqs: bo.skipSeqs,
                overflowSkip: bo.overflowSkip,
                confirmedOverlapBounded: bo.confirmedOverlapBounded,
                inActiveOverlap: true,
              });
            } else {
              out.push(bo);
            }
          }
        } else if (!bEmpty && branchHasDisjointOrNullableOther[bi]) {
          const bf = branchFirsts[bi];
          const branchIn = [];
          for (const s of inStates) {
            const effTailSpan = stateTailEffectiveSpan(s, bf);
            const effSkipSpan = stateSkipEffectiveSpan(s, bf);
            if (effTailSpan || effSkipSpan) {
              const altBranchFactor = disjointFactorForState(s);
              const priorBounded = Math.max(
                effTailSpan ? effTailSpan.bounded : 1,
                effSkipSpan ? effSkipSpan.bounded : 1,
              );
              const stepFactor = s.inActiveOverlap ? altBranchFactor : Math.max(altBranchFactor, priorBounded);
              const nextConfirmed = s.confirmedOverlapBounded * stepFactor;
              assertConfirmedOverlapSafe(nextConfirmed);
              branchIn.push({
                tailSpan: s.tailSpan,
                tailChars: s.tailChars,
                bridgeAtoms: s.bridgeAtoms,
                takenSeqs: s.takenSeqs,
                overflowTaken: s.overflowTaken,
                skipSpan: s.skipSpan,
                skipChars: s.skipChars,
                skipSeqs: s.skipSeqs,
                overflowSkip: s.overflowSkip,
                confirmedOverlapBounded: nextConfirmed,
                inActiveOverlap: true,
              });
            } else {
              branchIn.push(s);
            }
          }
          out.push(...analyzeChain(branch, flags, branchIn));
        } else {
          out.push(...analyzeChain(branch, flags, inStates));
        }
      }
      return coalesceFrontier(out);
    }
    case 'Seq': {
      let cur = inStates;
      for (let i = 0; i < node.items.length; i += 1) {
        cur = analyzeChain(node.items[i], flags, cur);
      }
      return cur;
    }
    case 'Repeat': {
      if (node.max === 0) return inStates;
      if (node.max > 1) {
        if (containsQuantifierGT1(node.node)) {
          throw makeError('INVALID_VALIDATION_PATTERN', 400, 'Nested quantifiers are rejected for ReDoS safety');
        }
        if (canMatchEmpty(node.node)) {
          throw makeError('INVALID_VALIDATION_PATTERN', 400, 'Ambiguous quantified empty-matchable group rejected for ReDoS safety');
        }
        analyzeInsideRepeat(node.node, flags, firstChars(node.node, flags));
      }

      if (node.min === node.max) {
        if (node.min === 1) {
          return analyzeChain(node.node, flags, inStates);
        }
        if (node.node.type === 'Literal' || node.node.type === 'CharClass') {
          const cs = atomCharSet(node.node, flags);
          let cur = inStates;
          for (let r = 0; r < node.min; r += 1) {
            const next = stepMandatoryAtom(cur, cs);
            if (frontierEqual(cur, next)) break;
            cur = next;
          }
          return cur;
        }
        let cur = inStates;
        for (let r = 0; r < node.min; r += 1) {
          const next = analyzeChain(node.node, flags, cur);
          if (frontierEqual(cur, next)) break;
          cur = next;
        }
        return cur;
      }

      const repeatSpan = Number.isFinite(node.max) ? spanBounded(node.max - node.min + 1) : spanUnbounded();
      const bFirst = firstChars(node.node, flags);
      const bLast = lastChars(node.node, flags);
      const bBody = allBodyChars(node.node, flags);
      const curPaths = extractNodePaths(node.node, flags);
      const allTargetPaths = curPaths ? curPaths.filter((p) => p.length > 0) : null;
      const multiPaths = curPaths ? curPaths.filter((p) => p.length >= 2) : [];
      const singleFirstChars = curPaths
        ? curPaths.filter((p) => p.length === 1).reduce((acc, p) => charSetUnion(acc, p[0]), [])
        : bFirst;
      const makeSeqEntries = (span) => multiPaths.map((seq) => ({ seq, pos: 0, span, bridge: [] }));
      const makeOverflowEntries = (span) => (
        curPaths === null && bFirst.length > 0 && bLast.length > 0 && bBody.length > 0
          ? [{ firstChars: bFirst, lastChars: bLast, bodyChars: bBody, span }]
          : []
      );

      if (node.max === 1) {
        const twoSpan = spanBounded(2);
        const out = [];
        for (const s of inStates) {
          const charSkipHit = s.skipChars.length > 0 && bFirst.length > 0 && charSetIntersects(s.skipChars, bFirst);
          const charTailHit = stateTailIntersects(s, bFirst);
          const seqSkipSpan = allTargetPaths ? maxSeqOverlapSpan(s.skipSeqs, allTargetPaths) : null;
          const seqTailSpan = allTargetPaths ? maxSeqOverlapSpan(s.takenSeqs, allTargetPaths) : null;
          const ovSkipSpan = maxOverflowOverlapSpan(s.overflowSkip, bFirst, bLast, bBody);
          const ovTailSpan = maxOverflowOverlapSpan(s.overflowTaken, bFirst, bLast, bBody);
          const skipOverlap = charSkipHit || Boolean(seqSkipSpan) || Boolean(ovSkipSpan);
          const tailOverlap = charTailHit || Boolean(seqTailSpan) || Boolean(ovTailSpan);

          let effSkipSpan = charSkipHit ? s.skipSpan : null;
          if (seqSkipSpan) effSkipSpan = effSkipSpan ? maxSpan(effSkipSpan, seqSkipSpan) : seqSkipSpan;
          if (ovSkipSpan) effSkipSpan = effSkipSpan ? maxSpan(effSkipSpan, ovSkipSpan) : ovSkipSpan;
          if (!effSkipSpan) effSkipSpan = spanOne();

          let effTailSpan = charTailHit ? s.tailSpan : null;
          if (seqTailSpan) effTailSpan = effTailSpan ? maxSpan(effTailSpan, seqTailSpan) : seqTailSpan;
          if (ovTailSpan) effTailSpan = effTailSpan ? maxSpan(effTailSpan, ovTailSpan) : ovTailSpan;
          if (!effTailSpan) effTailSpan = spanOne();

          let nextSkipSpan = maxSpan(s.skipSpan, twoSpan);
          if (skipOverlap) {
            nextSkipSpan = mulSpan(effSkipSpan, twoSpan);
            assertSpanSafe(nextSkipSpan);
          }
          let nextTailSpan = s.tailSpan;
          if (tailOverlap) {
            nextTailSpan = mulSpan(effTailSpan, twoSpan);
            assertSpanSafe(nextTailSpan);
          }
          let nextConfirmed = s.confirmedOverlapBounded;
          let nextInActive = s.inActiveOverlap;
          if (tailOverlap || skipOverlap) {
            const priorBounded = Math.max(
              tailOverlap ? effTailSpan.bounded : 1,
              skipOverlap ? effSkipSpan.bounded : 1,
            );
            nextConfirmed = s.confirmedOverlapBounded * (s.inActiveOverlap ? 2 : (priorBounded * 2));
            assertConfirmedOverlapSafe(nextConfirmed);
            nextInActive = true;
          }
          const nextSkipSeqs = mergeSeqEntries(
            skipOverlap && allTargetPaths ? upgradeMatchingSeqSpans(s.skipSeqs, allTargetPaths, nextSkipSpan) : s.skipSeqs,
            makeSeqEntries(skipOverlap ? nextSkipSpan : twoSpan),
          );
          const nextTakenSeqs = tailOverlap && allTargetPaths
            ? upgradeMatchingSeqSpans(s.takenSeqs, allTargetPaths, nextTailSpan)
            : s.takenSeqs;
          const nextSkipOverflows = mergeOverflowEntries(
            ovSkipSpan ? upgradeMatchingOverflowSpans(s.overflowSkip, bFirst, bLast, bBody, nextSkipSpan) : s.overflowSkip,
            makeOverflowEntries(skipOverlap ? nextSkipSpan : twoSpan),
          );
          const nextTakenOverflows = ovTailSpan
            ? upgradeMatchingOverflowSpans(s.overflowTaken, bFirst, bLast, bBody, nextTailSpan)
            : s.overflowTaken;
          out.push({
            tailSpan: nextTailSpan,
            tailChars: s.tailChars,
            bridgeAtoms: s.bridgeAtoms,
            takenSeqs: nextTakenSeqs,
            overflowTaken: nextTakenOverflows,
            skipSpan: nextSkipSpan,
            skipChars: charSetUnion(s.skipChars, singleFirstChars),
            skipSeqs: nextSkipSeqs,
            overflowSkip: nextSkipOverflows,
            confirmedOverlapBounded: nextConfirmed,
            inActiveOverlap: nextInActive,
          });
        }
        const taken = analyzeChain(node.node, flags, inStates);
        const curTakenEntries = makeSeqEntries(twoSpan);
        const curTakenOverflows = makeOverflowEntries(twoSpan);
        for (const ts of taken) {
          const needsTrailingSpan = bLast.length > 0 && !charSetIntersects(ts.tailChars, bLast);
          const mergedTakenSeqs = curTakenEntries.length > 0
            ? mergeSeqEntries(ts.takenSeqs, curTakenEntries)
            : ts.takenSeqs;
          const mergedTakenOverflows = curTakenOverflows.length > 0
            ? mergeOverflowEntries(ts.overflowTaken, curTakenOverflows)
            : ts.overflowTaken;
          if (needsTrailingSpan) {
            out.push({
              tailSpan: maxSpan(ts.tailSpan, twoSpan),
              tailChars: charSetUnion(ts.tailChars, bLast),
              bridgeAtoms: [],
              takenSeqs: mergedTakenSeqs,
              overflowTaken: mergedTakenOverflows,
              skipSpan: ts.skipSpan,
              skipChars: ts.skipChars,
              skipSeqs: ts.skipSeqs,
              overflowSkip: ts.overflowSkip,
              confirmedOverlapBounded: ts.confirmedOverlapBounded,
              inActiveOverlap: ts.inActiveOverlap,
            });
          } else {
            out.push({
              ...ts,
              takenSeqs: mergedTakenSeqs,
              overflowTaken: mergedTakenOverflows,
            });
          }
        }
        return coalesceFrontier(out);
      }

      const out = [];
      for (const s of inStates) {
        const charTailHit = stateTailIntersects(s, bFirst);
        const charSkipHit = s.skipChars.length > 0 && charSetIntersects(s.skipChars, bFirst);
        const seqTailSpan = allTargetPaths ? maxSeqOverlapSpan(s.takenSeqs, allTargetPaths) : null;
        const seqSkipSpan = allTargetPaths ? maxSeqOverlapSpan(s.skipSeqs, allTargetPaths) : null;
        const ovTailSpan = maxOverflowOverlapSpan(s.overflowTaken, bFirst, bLast, bBody);
        const ovSkipSpan = maxOverflowOverlapSpan(s.overflowSkip, bFirst, bLast, bBody);
        const tailOverlap = charTailHit || Boolean(seqTailSpan) || Boolean(ovTailSpan);
        const skipOverlap = charSkipHit || Boolean(seqSkipSpan) || Boolean(ovSkipSpan);
        const repeatFactor = Number.isFinite(node.max) ? repeatSpan.bounded : 1;

        let effTailSpan = charTailHit ? s.tailSpan : null;
        if (seqTailSpan) effTailSpan = effTailSpan ? maxSpan(effTailSpan, seqTailSpan) : seqTailSpan;
        if (ovTailSpan) effTailSpan = effTailSpan ? maxSpan(effTailSpan, ovTailSpan) : ovTailSpan;
        if (!effTailSpan) effTailSpan = spanOne();

        let effSkipSpan = charSkipHit ? s.skipSpan : null;
        if (seqSkipSpan) effSkipSpan = effSkipSpan ? maxSpan(effSkipSpan, seqSkipSpan) : seqSkipSpan;
        if (ovSkipSpan) effSkipSpan = effSkipSpan ? maxSpan(effSkipSpan, ovSkipSpan) : ovSkipSpan;
        if (!effSkipSpan) effSkipSpan = spanOne();

        let nextSkipSpanOnOverlap = s.skipSpan;
        if (skipOverlap) {
          nextSkipSpanOnOverlap = mulSpan(effSkipSpan, repeatSpan);
          assertSpanSafe(nextSkipSpanOnOverlap);
        }

        let nextConfirmed = s.confirmedOverlapBounded;
        if (tailOverlap || skipOverlap) {
          const priorBounded = Math.max(
            tailOverlap ? effTailSpan.bounded : 1,
            skipOverlap ? effSkipSpan.bounded : 1,
          );
          nextConfirmed = s.confirmedOverlapBounded * (s.inActiveOverlap ? repeatFactor : (priorBounded * repeatFactor));
          assertConfirmedOverlapSafe(nextConfirmed);
        }

        const advancedTakenSeqs = allTargetPaths
          ? advancePartialSeqEntries(s.takenSeqs, allTargetPaths, node.min, node.max)
          : [];
        const advancedSkipSeqs = allTargetPaths
          ? advancePartialSeqEntries(s.skipSeqs, allTargetPaths, node.min, node.max)
          : [];

        if (tailOverlap) {
          const nextSpan = mulSpan(effTailSpan, repeatSpan);
          assertSpanSafe(nextSpan);
          const baseTakenSeqs = node.min === 0
            ? mergeSeqEntries(
              allTargetPaths ? upgradeMatchingSeqSpans(s.takenSeqs, allTargetPaths, nextSpan) : s.takenSeqs,
              makeSeqEntries(nextSpan),
            )
            : makeSeqEntries(nextSpan);
          const nextTakenSeqs = mergeSeqEntries(baseTakenSeqs, advancedTakenSeqs);
          const baseSkipSeqs = skipOverlap
            ? (allTargetPaths ? upgradeMatchingSeqSpans(s.skipSeqs, allTargetPaths, nextSkipSpanOnOverlap) : s.skipSeqs)
            : [];
          const nextSkipSeqs = mergeSeqEntries(baseSkipSeqs, advancedSkipSeqs);
          const nextTakenOverflows = node.min === 0
            ? mergeOverflowEntries(
              ovTailSpan ? upgradeMatchingOverflowSpans(s.overflowTaken, bFirst, bLast, bBody, nextSpan) : s.overflowTaken,
              makeOverflowEntries(nextSpan),
            )
            : makeOverflowEntries(nextSpan);
          const nextSkipOverflows = skipOverlap
            ? (ovSkipSpan ? upgradeMatchingOverflowSpans(s.overflowSkip, bFirst, bLast, bBody, nextSkipSpanOnOverlap) : s.overflowSkip)
            : [];
          out.push({
            tailSpan: nextSpan,
            tailChars: node.min === 0 ? charSetUnion(s.tailChars, bLast) : bLast,
            bridgeAtoms: [],
            takenSeqs: nextTakenSeqs,
            overflowTaken: nextTakenOverflows,
            skipSpan: skipOverlap ? nextSkipSpanOnOverlap : spanOne(),
            skipChars: skipOverlap ? s.skipChars : [],
            skipSeqs: nextSkipSeqs,
            overflowSkip: nextSkipOverflows,
            confirmedOverlapBounded: nextConfirmed,
            inActiveOverlap: true,
          });
        } else if (node.min === 0) {
          const nextSkipSpan = skipOverlap ? nextSkipSpanOnOverlap : maxSpan(s.skipSpan, repeatSpan);
          const nextSkipSeqs = mergeSeqEntries(
            skipOverlap && allTargetPaths ? upgradeMatchingSeqSpans(s.skipSeqs, allTargetPaths, nextSkipSpanOnOverlap) : s.skipSeqs,
            makeSeqEntries(skipOverlap ? nextSkipSpanOnOverlap : repeatSpan),
          );
          const nextSkipOverflows = mergeOverflowEntries(
            ovSkipSpan ? upgradeMatchingOverflowSpans(s.overflowSkip, bFirst, bLast, bBody, nextSkipSpanOnOverlap) : s.overflowSkip,
            makeOverflowEntries(skipOverlap ? nextSkipSpanOnOverlap : repeatSpan),
          );
          out.push({
            tailSpan: s.tailSpan,
            tailChars: s.tailChars,
            bridgeAtoms: s.bridgeAtoms,
            takenSeqs: s.takenSeqs,
            overflowTaken: s.overflowTaken,
            skipSpan: nextSkipSpan,
            skipChars: charSetUnion(s.skipChars, singleFirstChars),
            skipSeqs: nextSkipSeqs,
            overflowSkip: nextSkipOverflows,
            confirmedOverlapBounded: nextConfirmed,
            inActiveOverlap: skipOverlap ? true : s.inActiveOverlap,
          });
          out.push({
            tailSpan: repeatSpan,
            tailChars: bLast,
            bridgeAtoms: [],
            takenSeqs: mergeSeqEntries(makeSeqEntries(repeatSpan), advancedTakenSeqs),
            overflowTaken: makeOverflowEntries(repeatSpan),
            skipSpan: spanOne(),
            skipChars: [],
            skipSeqs: advancedSkipSeqs,
            overflowSkip: [],
            confirmedOverlapBounded: nextConfirmed,
            inActiveOverlap: skipOverlap,
          });
        } else {
          const baseSkipSeqs = skipOverlap
            ? (allTargetPaths ? upgradeMatchingSeqSpans(s.skipSeqs, allTargetPaths, nextSkipSpanOnOverlap) : s.skipSeqs)
            : [];
          const nextSkipSeqs = mergeSeqEntries(baseSkipSeqs, advancedSkipSeqs);
          const nextSkipOverflows = skipOverlap
            ? (ovSkipSpan ? upgradeMatchingOverflowSpans(s.overflowSkip, bFirst, bLast, bBody, nextSkipSpanOnOverlap) : s.overflowSkip)
            : [];
          out.push({
            tailSpan: repeatSpan,
            tailChars: bLast,
            bridgeAtoms: [],
            takenSeqs: mergeSeqEntries(makeSeqEntries(repeatSpan), advancedTakenSeqs),
            overflowTaken: makeOverflowEntries(repeatSpan),
            skipSpan: skipOverlap ? nextSkipSpanOnOverlap : spanOne(),
            skipChars: skipOverlap ? s.skipChars : [],
            skipSeqs: nextSkipSeqs,
            overflowSkip: nextSkipOverflows,
            confirmedOverlapBounded: nextConfirmed,
            inActiveOverlap: skipOverlap,
          });
        }
      }
      return coalesceFrontier(out);
    }
    default:
      return inStates;
  }
}

function analyzeAst(node, flags = { ignoreCase: false, dotAll: false, multiline: false }) {
  analyzeChain(node, flags, [freshChainState()]);
}

// ---------------------------------------------------------------------------
// Linear-Time Thompson NFA Compiler & Lock-Step Simulator (O(n * m))
// ---------------------------------------------------------------------------

function matchCodeUnitInIntervals(intervals, cu) {
  const len = intervals.length;
  if (len === 1) {
    const pair = intervals[0];
    return cu >= pair[0] && cu <= pair[1];
  }
  if (len <= 6) {
    for (let i = 0; i < len; i += 1) {
      const pair = intervals[i];
      if (cu <= pair[1]) return cu >= pair[0];
    }
    return false;
  }
  let lo = 0;
  let hi = len - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const pair = intervals[mid];
    if (cu < pair[0]) {
      hi = mid - 1;
    } else if (cu > pair[1]) {
      lo = mid + 1;
    } else {
      return true;
    }
  }
  return false;
}

function isLineTerminatorCu(cu) {
  return cu === 10 || cu === 13 || cu === 0x2028 || cu === 0x2029;
}

function isWordCharAt(str, idx) {
  if (idx < 0 || idx >= str.length) return false;
  const cu = str.charCodeAt(idx);
  return (cu >= 48 && cu <= 57) || (cu >= 65 && cu <= 90) || cu === 95 || (cu >= 97 && cu <= 122);
}

function evalNfaAnchor(kind, multiline, str, pos) {
  switch (kind) {
    case '^':
      return pos === 0 || (multiline && isLineTerminatorCu(str.charCodeAt(pos - 1)));
    case '$':
      return pos === str.length || (multiline && isLineTerminatorCu(str.charCodeAt(pos)));
    case '\\b':
      return isWordCharAt(str, pos - 1) !== isWordCharAt(str, pos);
    case '\\B':
      return isWordCharAt(str, pos - 1) === isWordCharAt(str, pos);
    default:
      return false;
  }
}

function buildReverseNfaGraph(nfa) {
  const nStates = nfa.states.length;
  const revCharFroms = Array.from({ length: nStates }, () => []);
  const revZeroEdges = Array.from({ length: nStates }, () => []);
  for (let u = 0; u < nStates; u += 1) {
    const st = nfa.states[u];
    switch (st.type) {
      case 'char':
        if (st.out >= 0) {
          revCharFroms[st.out].push(u);
        }
        break;
      case 'split':
        if (st.out1 >= 0) revZeroEdges[st.out1].push({ from: u, kind: 'eps' });
        if (st.out2 >= 0) revZeroEdges[st.out2].push({ from: u, kind: 'eps' });
        break;
      case 'anchor':
        if (st.out >= 0) {
          revZeroEdges[st.out].push({ from: u, kind: 'anchor', anchorKind: st.kind, multiline: st.multiline });
        }
        break;
      case 'lookahead':
        if (st.out >= 0) {
          revZeroEdges[st.out].push({ from: u, kind: 'lookahead', laId: st.id, positive: st.positive });
        }
        break;
      default:
        break;
    }
  }
  const revSingleFrom = new Int32Array(nStates);
  const hasRevChar = new Uint8Array(nStates);
  const hasRevZero = new Uint8Array(nStates);
  for (let v = 0; v < nStates; v += 1) {
    const cf = revCharFroms[v];
    if (cf.length === 0) {
      revSingleFrom[v] = -1;
    } else {
      hasRevChar[v] = 1;
      revSingleFrom[v] = cf.length === 1 ? cf[0] : -2;
    }
    if (revZeroEdges[v].length > 0) {
      hasRevZero[v] = 1;
    }
  }
  return { revCharFroms, revZeroEdges, revSingleFrom, hasRevChar, hasRevZero };
}

function serializeRegexAst(node) {
  if (!node) return 'E';
  switch (node.type) {
    case 'Empty':
      return 'E';
    case 'Anchor':
      return `A:${node.kind}`;
    case 'Literal':
      return `L:${node.codePoint}`;
    case 'CharClass':
      if (node.isDot) return 'C:dot';
      return `C:${node.negated ? '!' : ''}${node.intervals.map((r) => `${r[0]}-${r[1]}`).join(',')}`;
    case 'Group': {
      const prefix = node.kind === 'modifier'
        ? `M:${node.addFlags}:${node.removeFlags}`
        : (node.kind === 'lookahead' || node.kind === 'negLookahead' ? `G:${node.kind}` : 'G');
      return `${prefix}(${serializeRegexAst(node.body)})`;
    }
    case 'Seq':
      return `S[${node.items.map(serializeRegexAst).join(',')}]`;
    case 'Alt':
      return `B[${node.branches.map(serializeRegexAst).join('|')}]`;
    case 'Repeat':
      return `R{${node.min},${node.max}}(${serializeRegexAst(node.node)})`;
    default:
      return `U:${node.type}`;
  }
}

function compileAstToThompsonNfa(
  rootAst,
  initialFlags = { ignoreCase: false, dotAll: false, multiline: false },
  lookaheadCtx = null,
  isSubNfa = false,
  maxRootStates = MAX_NFA_STATES,
) {
  const ctx = lookaheadCtx || {
    nextId: 0,
    list: [],
    cache: new Map(),
    sigCache: new Map(),
    totalStates: 0,
    totalLookaheadStates: 0,
  };
  const states = [];

  function addState(st) {
    if (ctx.totalStates >= MAX_NFA_STATES) {
      throw makeError('INVALID_VALIDATION_PATTERN', 400, `Regex NFA exceeds max state count (${MAX_NFA_STATES})`);
    }
    if (!isSubNfa && maxRootStates < MAX_NFA_STATES && states.length >= maxRootStates) {
      throw makeError('INVALID_VALIDATION_PATTERN', 400, `Unanchored regex NFA exceeds max root state count (${maxRootStates})`);
    }
    if (isSubNfa && ctx.totalLookaheadStates >= MAX_TOTAL_LOOKAHEAD_STATES) {
      throw makeError('INVALID_VALIDATION_PATTERN', 400, `Regex lookahead NFA exceeds max state count (${MAX_TOTAL_LOOKAHEAD_STATES})`);
    }
    const id = states.length;
    states.push(st);
    ctx.totalStates += 1;
    if (isSubNfa) {
      ctx.totalLookaheadStates += 1;
    }
    return id;
  }

  function patch(outs, targetId) {
    for (const o of outs) {
      states[o.stateId][o.field] = targetId;
    }
  }

  function compileEmpty() {
    const s = addState({ type: 'split', out1: -1, out2: -1 });
    return { start: s, outs: [{ stateId: s, field: 'out1' }] };
  }

  function compileCharIntervals(intervals) {
    const len = intervals.length;
    const st = len === 1
      ? { type: 'char', intervals, single: true, lo: intervals[0][0], hi: intervals[0][1], out: -1 }
      : { type: 'char', intervals, single: false, lo: 0, hi: -1, out: -1 };
    const s = addState(st);
    return { start: s, outs: [{ stateId: s, field: 'out' }] };
  }

  function compileNode(node, flags) {
    if (!node) return compileEmpty();
    switch (node.type) {
      case 'Empty':
        return compileEmpty();
      case 'Anchor': {
        const s = addState({
          type: 'anchor',
          kind: node.kind,
          multiline: Boolean(flags.multiline),
          out: -1,
        });
        return { start: s, outs: [{ stateId: s, field: 'out' }] };
      }
      case 'CharClass':
      case 'Literal':
        return compileCharIntervals(atomCharSet(node, flags));
      case 'Group': {
        const nextFlags = childGroupFlags(node, flags);
        if (node.kind === 'lookahead' || node.kind === 'negLookahead') {
          const flagsKey = `${nextFlags.ignoreCase ? 'i' : ''}${nextFlags.dotAll ? 's' : ''}${nextFlags.multiline ? 'm' : ''}`;
          let sig = ctx.sigCache.get(node.body);
          if (sig === undefined) {
            sig = serializeRegexAst(node.body);
            ctx.sigCache.set(node.body, sig);
          }
          const cacheKey = `${flagsKey}|${sig}`;
          let cached = ctx.cache.get(cacheKey);
          if (!cached) {
            const subNfa = compileAstToThompsonNfa(node.body, nextFlags, ctx, true);
            const laId = ctx.nextId;
            ctx.nextId += 1;
            cached = {
              id: laId,
              subNfa,
              rev: buildReverseNfaGraph(subNfa),
            };
            ctx.list.push(cached);
            ctx.cache.set(cacheKey, cached);
          }
          const s = addState({
            type: 'lookahead',
            id: cached.id,
            positive: node.kind === 'lookahead',
            subNfa: cached.subNfa,
            out: -1,
          });
          return { start: s, outs: [{ stateId: s, field: 'out' }] };
        }
        return compileNode(node.body, nextFlags);
      }
      case 'Seq': {
        if (!node.items || node.items.length === 0) return compileEmpty();
        let acc = compileNode(node.items[0], flags);
        for (let i = 1; i < node.items.length; i += 1) {
          const nextFrag = compileNode(node.items[i], flags);
          patch(acc.outs, nextFrag.start);
          acc = { start: acc.start, outs: nextFrag.outs };
        }
        return acc;
      }
      case 'Alt': {
        if (!node.branches || node.branches.length === 0) return compileEmpty();
        if (node.branches.length === 1) return compileNode(node.branches[0], flags);
        const frags = node.branches.map((b) => compileNode(b, flags));
        let rootSplit = -1;
        let prevSplit = -1;
        for (let i = 0; i < frags.length - 1; i += 1) {
          const sp = addState({ type: 'split', out1: frags[i].start, out2: -1 });
          if (rootSplit < 0) rootSplit = sp;
          if (prevSplit >= 0) states[prevSplit].out2 = sp;
          prevSplit = sp;
        }
        states[prevSplit].out2 = frags[frags.length - 1].start;
        const outs = [];
        for (const f of frags) outs.push(...f.outs);
        return { start: rootSplit, outs };
      }
      case 'Repeat': {
        const min = node.min;
        const max = node.max;
        if (max === 0) return compileEmpty();
        if (min === 1 && max === 1) return compileNode(node.node, flags);
        if (min === 0 && max === 1) {
          const body = compileNode(node.node, flags);
          const sp = addState({ type: 'split', out1: body.start, out2: -1 });
          return { start: sp, outs: [...body.outs, { stateId: sp, field: 'out2' }] };
        }
        if (min === 0 && max === Infinity) {
          const body = compileNode(node.node, flags);
          const sp = addState({ type: 'split', out1: body.start, out2: -1 });
          patch(body.outs, sp);
          return { start: sp, outs: [{ stateId: sp, field: 'out2' }] };
        }
        if (min >= 1 && max === Infinity) {
          let prefix = null;
          for (let r = 0; r < min - 1; r += 1) {
            const c = compileNode(node.node, flags);
            if (!prefix) {
              prefix = c;
            } else {
              patch(prefix.outs, c.start);
              prefix = { start: prefix.start, outs: c.outs };
            }
          }
          const lastCopy = compileNode(node.node, flags);
          const sp = addState({ type: 'split', out1: lastCopy.start, out2: -1 });
          patch(lastCopy.outs, sp);
          if (!prefix) {
            return { start: lastCopy.start, outs: [{ stateId: sp, field: 'out2' }] };
          }
          patch(prefix.outs, lastCopy.start);
          return { start: prefix.start, outs: [{ stateId: sp, field: 'out2' }] };
        }
        // Finite bounded {min, max}
        let acc = null;
        for (let r = 0; r < min; r += 1) {
          const c = compileNode(node.node, flags);
          if (!acc) {
            acc = c;
          } else {
            patch(acc.outs, c.start);
            acc = { start: acc.start, outs: c.outs };
          }
        }
        const optCount = max - min;
        if (optCount === 0) return acc || compileEmpty();
        let optHead = -1;
        let prevBodyOuts = null;
        const skipOuts = [];
        for (let r = 0; r < optCount; r += 1) {
          const body = compileNode(node.node, flags);
          const sp = addState({ type: 'split', out1: body.start, out2: -1 });
          if (optHead < 0) optHead = sp;
          if (prevBodyOuts) patch(prevBodyOuts, sp);
          skipOuts.push({ stateId: sp, field: 'out2' });
          prevBodyOuts = body.outs;
        }
        const optOuts = [...(prevBodyOuts || []), ...skipOuts];
        if (!acc) {
          return { start: optHead, outs: optOuts };
        }
        patch(acc.outs, optHead);
        return { start: acc.start, outs: optOuts };
      }
      default:
        return compileEmpty();
    }
  }

  const root = compileNode(rootAst, initialFlags);
  const acceptState = addState({ type: 'accept' });
  patch(root.outs, acceptState);

  const nStates = states.length;
  const stateType = new Uint8Array(nStates); // 0=char, 1=split, 2=anchor, 3=lookahead, 4=accept
  const stateOut1 = new Int32Array(nStates);
  const stateOut2 = new Int32Array(nStates);
  const stateSingle = new Uint8Array(nStates);
  const stateLo = new Int32Array(nStates);
  const stateHi = new Int32Array(nStates);
  const stateAsciiMask = new Uint32Array(nStates * 4);
  const stateIntervals = new Array(nStates);
  const charStaticTargets = new Array(nStates).fill(null);
  const charStaticAccept = new Uint8Array(nStates);

  for (let i = 0; i < nStates; i += 1) {
    const st = states[i];
    stateOut1[i] = -1;
    stateOut2[i] = -1;
    stateHi[i] = -1;
    if (st.type === 'char') {
      stateType[i] = 0;
      stateOut1[i] = st.out;
      stateIntervals[i] = st.intervals;
      if (st.single) {
        stateSingle[i] = 1;
        stateLo[i] = st.lo;
        stateHi[i] = st.hi;
      }
      const base = i << 2;
      const ivs = st.intervals;
      for (let k = 0; k < ivs.length; k += 1) {
        const lo = ivs[k][0];
        if (lo >= 128) break;
        const hi = ivs[k][1] < 127 ? ivs[k][1] : 127;
        for (let cp = lo; cp <= hi; cp += 1) {
          stateAsciiMask[base + (cp >>> 5)] = (stateAsciiMask[base + (cp >>> 5)] | (1 << (cp & 31))) >>> 0;
        }
      }
    } else if (st.type === 'split') {
      stateType[i] = 1;
      stateOut1[i] = st.out1;
      stateOut2[i] = st.out2;
    } else if (st.type === 'anchor') {
      stateType[i] = 2;
      stateOut1[i] = st.out;
    } else if (st.type === 'lookahead') {
      stateType[i] = 3;
      stateOut1[i] = st.out;
    } else {
      stateType[i] = 4;
    }
  }

  const staticSeen = new Int32Array(nStates);
  let staticStamp = 1;
  const staticStack = [];

  function computeStaticEpsilonClosure(entryId) {
    if (entryId < 0) return { reachesAccept: false, targets: new Int32Array(0) };
    const stStamp = staticStamp;
    staticStamp += 1;
    staticStack.length = 0;
    staticStack.push(entryId);
    const targets = [];
    let reachesAccept = false;
    while (staticStack.length > 0) {
      const id = staticStack.pop();
      if (id < 0 || staticSeen[id] === stStamp) continue;
      staticSeen[id] = stStamp;
      const ty = stateType[id];
      if (ty === 0) {
        targets.push(id);
      } else if (ty === 4) {
        reachesAccept = true;
      } else if (ty === 1) {
        const o2 = stateOut2[id];
        const o1 = stateOut1[id];
        if (o2 >= 0) staticStack.push(o2);
        if (o1 >= 0) staticStack.push(o1);
      } else {
        return null;
      }
    }
    return { reachesAccept, targets: new Int32Array(targets) };
  }

  if (!isSubNfa) {
    const splitClosureCache = new Map();
    for (let i = 0; i < nStates; i += 1) {
      if (stateType[i] === 0 && stateOut1[i] >= 0) {
        const targetId = stateOut1[i];
        if (stateType[targetId] === 1) {
          let sc = splitClosureCache.get(targetId);
          if (sc === undefined) {
            sc = computeStaticEpsilonClosure(targetId);
            splitClosureCache.set(targetId, sc);
          }
          if (sc !== null) {
            charStaticTargets[i] = sc.targets;
            charStaticAccept[i] = sc.reachesAccept ? 1 : 0;
          }
        }
      }
    }
  }
  const startStaticClosure = !isSubNfa && stateType[root.start] === 1
    ? computeStaticEpsilonClosure(root.start)
    : null;

  return {
    start: root.start,
    acceptState,
    states,
    stateType,
    stateOut1,
    stateOut2,
    stateSingle,
    stateLo,
    stateHi,
    stateAsciiMask,
    stateIntervals,
    charStaticTargets,
    charStaticAccept,
    startStaticTargets: startStaticClosure ? startStaticClosure.targets : null,
    lookaheads: ctx.list,
    totalStates: ctx.totalStates,
    totalLookaheadStates: ctx.totalLookaheadStates,
  };
}

function precomputeLookaheadTables(lookaheads, str) {
  if (!lookaheads || lookaheads.length === 0) return null;
  const tables = new Array(lookaheads.length);
  const n = str.length;
  let maxStates = 0;
  for (let i = 0; i < lookaheads.length; i += 1) {
    if (lookaheads[i].subNfa.states.length > maxStates) {
      maxStates = lookaheads[i].subNfa.states.length;
    }
  }
  const visitedStamp = new Int32Array(maxStates);
  const queue = new Int32Array(maxStates);
  let nextReach = new Int32Array(maxStates);
  let currReach = new Int32Array(maxStates);

  for (let i = 0; i < lookaheads.length; i += 1) {
    const { id, subNfa, rev } = lookaheads[i];
    const { revCharFroms, revZeroEdges, revSingleFrom, hasRevChar, hasRevZero } = rev;
    const { stateSingle, stateLo, stateHi, stateAsciiMask, stateIntervals } = subNfa;
    const nSub = subNfa.states.length;
    const acceptId = subNfa.acceptState;
    const startId = subNfa.start;
    const table = new Uint8Array(n + 1);
    visitedStamp.fill(0, 0, nSub);
    let stamp = 1;
    let nextLen = 0;

    for (let pos = n; pos >= 0; pos -= 1) {
      const curStamp = stamp;
      stamp += 1;
      let qLen = 0;
      let currLen = 0;

      visitedStamp[acceptId] = curStamp;
      if (hasRevZero[acceptId]) {
        queue[qLen] = acceptId;
        qLen += 1;
      }
      if (hasRevChar[acceptId]) {
        currReach[currLen] = acceptId;
        currLen += 1;
      }

      if (pos < n) {
        const cu = str.charCodeAt(pos);
        if (cu < 128) {
          const wordOff = cu >>> 5;
          const bit = cu & 31;
          for (let r = 0; r < nextLen; r += 1) {
            const v = nextReach[r];
            const singleU = revSingleFrom[v];
            if (singleU >= 0) {
              if (visitedStamp[singleU] !== curStamp && ((stateAsciiMask[(singleU << 2) + wordOff] >>> bit) & 1) !== 0) {
                visitedStamp[singleU] = curStamp;
                if (hasRevZero[singleU]) {
                  queue[qLen] = singleU;
                  qLen += 1;
                }
                if (hasRevChar[singleU]) {
                  currReach[currLen] = singleU;
                  currLen += 1;
                }
              }
            } else {
              const froms = revCharFroms[v];
              for (let eIdx = 0; eIdx < froms.length; eIdx += 1) {
                const u = froms[eIdx];
                if (visitedStamp[u] !== curStamp && ((stateAsciiMask[(u << 2) + wordOff] >>> bit) & 1) !== 0) {
                  visitedStamp[u] = curStamp;
                  if (hasRevZero[u]) {
                    queue[qLen] = u;
                    qLen += 1;
                  }
                  if (hasRevChar[u]) {
                    currReach[currLen] = u;
                    currLen += 1;
                  }
                }
              }
            }
          }
        } else {
          for (let r = 0; r < nextLen; r += 1) {
            const froms = revCharFroms[nextReach[r]];
            for (let eIdx = 0; eIdx < froms.length; eIdx += 1) {
              const u = froms[eIdx];
              if (visitedStamp[u] !== curStamp) {
                const matched = stateSingle[u]
                  ? (cu >= stateLo[u] && cu <= stateHi[u])
                  : matchCodeUnitInIntervals(stateIntervals[u], cu);
                if (matched) {
                  visitedStamp[u] = curStamp;
                  if (hasRevZero[u]) {
                    queue[qLen] = u;
                    qLen += 1;
                  }
                  if (hasRevChar[u]) {
                    currReach[currLen] = u;
                    currLen += 1;
                  }
                }
              }
            }
          }
        }
      }

      let qHead = 0;
      while (qHead < qLen) {
        const v = queue[qHead];
        qHead += 1;
        const zeroEdges = revZeroEdges[v];
        for (let eIdx = 0; eIdx < zeroEdges.length; eIdx += 1) {
          const edge = zeroEdges[eIdx];
          if (visitedStamp[edge.from] === curStamp) continue;
          let ok = false;
          if (edge.kind === 'eps') {
            ok = true;
          } else if (edge.kind === 'anchor') {
            ok = evalNfaAnchor(edge.anchorKind, edge.multiline, str, pos);
          } else if (edge.kind === 'lookahead') {
            ok = (tables[edge.laId][pos] === 1) === edge.positive;
          }
          if (ok) {
            const u = edge.from;
            visitedStamp[u] = curStamp;
            if (hasRevZero[u]) {
              queue[qLen] = u;
              qLen += 1;
            }
            if (hasRevChar[u]) {
              currReach[currLen] = u;
              currLen += 1;
            }
          }
        }
      }

      table[pos] = visitedStamp[startId] === curStamp ? 1 : 0;
      const tmp = nextReach;
      nextReach = currReach;
      currReach = tmp;
      nextLen = currLen;
    }

    tables[id] = table;
  }

  return tables;
}

function isGuaranteedStartAnchored(node, flags = { multiline: false }) {
  if (!node) return false;
  switch (node.type) {
    case 'Anchor':
      return node.kind === '^' && !flags.multiline;
    case 'Seq': {
      if (!node.items || node.items.length === 0) return false;
      for (let i = 0; i < node.items.length; i += 1) {
        const item = node.items[i];
        if (isGuaranteedStartAnchored(item, flags)) return true;
        if (
          item.type === 'Empty'
          || item.type === 'Anchor'
          || (item.type === 'Group' && (item.kind === 'lookahead' || item.kind === 'negLookahead'))
        ) {
          continue;
        }
        return false;
      }
      return false;
    }
    case 'Alt':
      return Boolean(node.branches && node.branches.length > 0)
        && node.branches.every((b) => isGuaranteedStartAnchored(b, flags));
    case 'Group': {
      if (node.kind === 'lookahead' || node.kind === 'negLookahead') return false;
      const nextFlags = childGroupFlags(node, flags);
      return isGuaranteedStartAnchored(node.body, nextFlags);
    }
    case 'Repeat':
      return node.min >= 1 && isGuaranteedStartAnchored(node.node, flags);
    default:
      return false;
  }
}

function runThompsonNfa(nfa, str, { anchoredAtStart = false, startPos = 0 } = {}) {
  const {
    states,
    stateType,
    stateOut1,
    stateOut2,
    stateSingle,
    stateLo,
    stateHi,
    stateAsciiMask,
    stateIntervals,
    charStaticTargets,
    charStaticAccept,
    startStaticTargets,
    start,
    acceptState,
  } = nfa;
  const nStates = states.length;
  const visitedStamp = new Int32Array(nStates);
  const stack = [];
  let stamp = 1;
  const lookaheadTables = precomputeLookaheadTables(nfa.lookaheads, str);

  let current = new Int32Array(nStates);
  let next = new Int32Array(nStates);

  function addClosure(startStateId, pos, activeArr, activeLen, curStamp) {
    stack.length = 0;
    stack.push(startStateId);
    let len = activeLen;
    while (stack.length > 0) {
      const id = stack.pop();
      if (id < 0 || visitedStamp[id] === curStamp) continue;
      visitedStamp[id] = curStamp;
      const ty = stateType[id];
      if (ty === 0 || ty === 4) {
        activeArr[len] = id;
        len += 1;
      } else if (ty === 1) {
        const o2 = stateOut2[id];
        const o1 = stateOut1[id];
        if (o2 >= 0) stack.push(o2);
        if (o1 >= 0) stack.push(o1);
      } else if (ty === 2) {
        const st = states[id];
        if (evalNfaAnchor(st.kind, st.multiline, str, pos) && stateOut1[id] >= 0) {
          stack.push(stateOut1[id]);
        }
      } else if (ty === 3) {
        const st = states[id];
        const matched = lookaheadTables[st.id][pos] === 1;
        if (matched === st.positive && stateOut1[id] >= 0) {
          stack.push(stateOut1[id]);
        }
      }
    }
    return len;
  }

  let curStamp = stamp;
  stamp += 1;
  let currLen = addClosure(start, startPos, current, 0, curStamp);
  if (visitedStamp[acceptState] === curStamp) return true;
  if (currLen === 0 && anchoredAtStart) return false;

  const startIsDirectChar = stateType[start] === 0;
  const startLaSt = stateType[start] === 3 ? states[start] : null;
  const startLaTable = startLaSt ? lookaheadTables[startLaSt.id] : null;
  const startLaPositive = startLaSt ? startLaSt.positive : false;
  const startLaOut = startLaSt ? stateOut1[start] : -1;
  const startLaOutIsChar = startLaOut >= 0 && stateType[startLaOut] === 0;
  const n = str.length;

  for (let pos = startPos; pos < n; pos += 1) {
    const cu = str.charCodeAt(pos);
    const nextPos = pos + 1;
    let nextLen = 0;
    curStamp = stamp;
    stamp += 1;

    if (cu < 128) {
      const wordOff = cu >>> 5;
      const bit = cu & 31;
      for (let i = 0; i < currLen; i += 1) {
        const id = current[i];
        if (stateType[id] === 0) {
          const targetId = stateOut1[id];
          if (targetId >= 0 && ((stateAsciiMask[(id << 2) + wordOff] >>> bit) & 1) !== 0) {
            const tty = stateType[targetId];
            if (tty === 0) {
              if (visitedStamp[targetId] !== curStamp) {
                visitedStamp[targetId] = curStamp;
                next[nextLen] = targetId;
                nextLen += 1;
              }
            } else if (tty === 4) {
              return true;
            } else if (charStaticTargets[id] !== null) {
              if (charStaticAccept[id] === 1) return true;
              const targets = charStaticTargets[id];
              for (let t = 0; t < targets.length; t += 1) {
                const tid = targets[t];
                if (visitedStamp[tid] !== curStamp) {
                  visitedStamp[tid] = curStamp;
                  next[nextLen] = tid;
                  nextLen += 1;
                }
              }
            } else {
              nextLen = addClosure(targetId, nextPos, next, nextLen, curStamp);
            }
          }
        }
      }
    } else {
      for (let i = 0; i < currLen; i += 1) {
        const id = current[i];
        if (stateType[id] === 0) {
          const targetId = stateOut1[id];
          if (targetId >= 0) {
            const matched = stateSingle[id]
              ? (cu >= stateLo[id] && cu <= stateHi[id])
              : matchCodeUnitInIntervals(stateIntervals[id], cu);
            if (matched) {
              const tty = stateType[targetId];
              if (tty === 0) {
                if (visitedStamp[targetId] !== curStamp) {
                  visitedStamp[targetId] = curStamp;
                  next[nextLen] = targetId;
                  nextLen += 1;
                }
              } else if (tty === 4) {
                return true;
              } else if (charStaticTargets[id] !== null) {
                if (charStaticAccept[id] === 1) return true;
                const targets = charStaticTargets[id];
                for (let t = 0; t < targets.length; t += 1) {
                  const tid = targets[t];
                  if (visitedStamp[tid] !== curStamp) {
                    visitedStamp[tid] = curStamp;
                    next[nextLen] = tid;
                    nextLen += 1;
                  }
                }
              } else {
                nextLen = addClosure(targetId, nextPos, next, nextLen, curStamp);
              }
            }
          }
        }
      }
    }

    if (!anchoredAtStart) {
      if (startIsDirectChar) {
        if (visitedStamp[start] !== curStamp) {
          visitedStamp[start] = curStamp;
          next[nextLen] = start;
          nextLen += 1;
        }
      } else if (startLaOutIsChar) {
        if ((startLaTable[nextPos] === 1) === startLaPositive) {
          if (visitedStamp[startLaOut] !== curStamp) {
            visitedStamp[startLaOut] = curStamp;
            next[nextLen] = startLaOut;
            nextLen += 1;
          }
        }
      } else if (startStaticTargets !== null) {
        for (let t = 0; t < startStaticTargets.length; t += 1) {
          const tid = startStaticTargets[t];
          if (visitedStamp[tid] !== curStamp) {
            visitedStamp[tid] = curStamp;
            next[nextLen] = tid;
            nextLen += 1;
          }
        }
      } else {
        nextLen = addClosure(start, nextPos, next, nextLen, curStamp);
      }
    }

    if (visitedStamp[acceptState] === curStamp) return true;
    const tmp = current;
    current = next;
    next = tmp;
    currLen = nextLen;
    if (currLen === 0 && anchoredAtStart) return false;
  }

  return false;
}

function compileThompsonNfaMatcher(ast) {
  const initialFlags = { ignoreCase: false, dotAll: false, multiline: false };
  const anchoredAtStart = isGuaranteedStartAnchored(ast, initialFlags);
  const maxRootStates = anchoredAtStart ? MAX_NFA_STATES : MAX_UNANCHORED_ROOT_NFA_STATES;
  const nfa = compileAstToThompsonNfa(ast, initialFlags, null, false, maxRootStates);
  const test = (value) => {
    const str = String(value);
    if (str.length > MAX_REGEX_INPUT_LENGTH) {
      throw makeError('VALIDATION_PATTERN', 400, `Input exceeds max pattern length (${MAX_REGEX_INPUT_LENGTH})`);
    }
    return runThompsonNfa(nfa, str, { anchoredAtStart, startPos: 0 });
  };
  return {
    stateCount: nfa.totalStates,
    lookaheadCount: nfa.lookaheads.length,
    lookaheadStateCount: nfa.totalLookaheadStates,
    anchoredAtStart,
    test,
  };
}

const safeRegexPatternCache = new Map();

function cloneCachedRegexResult(entry) {
  if (!entry.valid) {
    return {
      valid: false,
      code: entry.code,
      error: entry.error,
    };
  }
  return {
    valid: true,
    pattern: entry.pattern,
    nfaStateCount: entry.nfaStateCount,
    lookaheadCount: entry.lookaheadCount,
    lookaheadStateCount: entry.lookaheadStateCount,
    test: entry.test,
    regex: {
      source: entry.pattern,
      flags: '',
      test: entry.test,
    },
  };
}

function validateSafeRegexPattern(pattern) {
  const cacheable = typeof pattern === 'string' && pattern.length > 0 && pattern.length <= MAX_REGEX_PATTERN_LENGTH;
  if (cacheable && safeRegexPatternCache.has(pattern)) {
    const cached = safeRegexPatternCache.get(pattern);
    safeRegexPatternCache.delete(pattern);
    safeRegexPatternCache.set(pattern, cached);
    return cloneCachedRegexResult(cached);
  }
  let entry;
  try {
    const ast = parseRegexAst(pattern);
    analyzeAst(ast, { ignoreCase: false, dotAll: false, multiline: false });
    // Validate JS RegExp syntax parity without ever executing V8 backtracking RegExp.test
    new RegExp(pattern);
    const matcher = compileThompsonNfaMatcher(ast);
    entry = {
      valid: true,
      pattern,
      nfaStateCount: matcher.stateCount,
      lookaheadCount: matcher.lookaheadCount,
      lookaheadStateCount: matcher.lookaheadStateCount,
      test: matcher.test,
    };
  } catch (err) {
    entry = {
      valid: false,
      code: err?.code || 'INVALID_VALIDATION_PATTERN',
      error: err?.message || 'Invalid regex syntax',
    };
  }
  if (cacheable) {
    if (safeRegexPatternCache.size >= MAX_SAFE_REGEX_CACHE) {
      const oldestKey = safeRegexPatternCache.keys().next().value;
      if (oldestKey !== undefined) safeRegexPatternCache.delete(oldestKey);
    }
    safeRegexPatternCache.set(pattern, entry);
  }
  return cloneCachedRegexResult(entry);
}

function validateFieldValidationSpec(rawValidation, fieldType = 'string', fieldName = 'field', opts = {}) {
  if (rawValidation === undefined || rawValidation === null) {
    return { valid: true, validation: undefined };
  }
  if (!isPlainObject(rawValidation)) {
    return { valid: false, code: 'INVALID_VALIDATION_SPEC', error: `validation on "${fieldName}" must be an object` };
  }
  const effectiveType = fieldType === 'formula'
    ? String(opts?.formulaReturnType || 'float').trim()
    : fieldType;

  const out = {};
  if (rawValidation.required !== undefined) {
    if (typeof rawValidation.required !== 'boolean') {
      return { valid: false, code: 'INVALID_VALIDATION_SPEC', error: `validation.required on "${fieldName}" must be boolean` };
    }
    if (rawValidation.required) out.required = true;
  }

  if (rawValidation.unique !== undefined) {
    if (typeof rawValidation.unique !== 'boolean') {
      return { valid: false, code: 'INVALID_VALIDATION_SPEC', error: `validation.unique on "${fieldName}" must be boolean` };
    }
    if (rawValidation.unique) {
      if (['hasOne', 'belongsToMany', 'json', 'jsonb', 'formula'].includes(fieldType)) {
        return { valid: false, code: 'INVALID_VALIDATION_SPEC', error: `validation.unique is not supported on "${fieldType}" field "${fieldName}"` };
      }
      out.unique = true;
    }
  }

  if (rawValidation.min !== undefined && rawValidation.min !== null) {
    if (typeof rawValidation.min !== 'number' || !Number.isFinite(rawValidation.min)) {
      return { valid: false, code: 'INVALID_VALIDATION_SPEC', error: `validation.min on "${fieldName}" must be a finite number` };
    }
    if (['boolean', 'json', 'jsonb', 'belongsTo', 'hasOne', 'belongsToMany'].includes(effectiveType)) {
      return { valid: false, code: 'INVALID_VALIDATION_SPEC', error: `validation.min is not supported on "${effectiveType}" field "${fieldName}"` };
    }
    out.min = rawValidation.min;
  }

  if (rawValidation.max !== undefined && rawValidation.max !== null) {
    if (typeof rawValidation.max !== 'number' || !Number.isFinite(rawValidation.max)) {
      return { valid: false, code: 'INVALID_VALIDATION_SPEC', error: `validation.max on "${fieldName}" must be a finite number` };
    }
    if (['boolean', 'json', 'jsonb', 'belongsTo', 'hasOne', 'belongsToMany'].includes(effectiveType)) {
      return { valid: false, code: 'INVALID_VALIDATION_SPEC', error: `validation.max is not supported on "${effectiveType}" field "${fieldName}"` };
    }
    out.max = rawValidation.max;
  }

  if (out.min !== undefined && out.max !== undefined && out.min > out.max) {
    return { valid: false, code: 'INVALID_VALIDATION_SPEC', error: `validation.min cannot exceed validation.max on "${fieldName}"` };
  }

  if (rawValidation.pattern !== undefined && rawValidation.pattern !== null) {
    if (!['string', 'text'].includes(effectiveType)) {
      return { valid: false, code: 'INVALID_VALIDATION_SPEC', error: `validation.pattern is only supported on string/text field "${fieldName}"` };
    }
    const regexCheck = validateSafeRegexPattern(rawValidation.pattern);
    if (!regexCheck.valid) {
      return { valid: false, code: 'INVALID_VALIDATION_PATTERN', error: `${regexCheck.error} on "${fieldName}"` };
    }
    out.pattern = rawValidation.pattern;
  }

  if (rawValidation.enum !== undefined && rawValidation.enum !== null) {
    if (!Array.isArray(rawValidation.enum) || rawValidation.enum.length === 0 || rawValidation.enum.length > 100) {
      return { valid: false, code: 'INVALID_VALIDATION_SPEC', error: `validation.enum on "${fieldName}" must be a non-empty array (max 100 items)` };
    }
    const cleanEnum = [];
    for (const item of rawValidation.enum) {
      if (typeof item !== 'string' && (typeof item !== 'number' || !Number.isFinite(item))) {
        return { valid: false, code: 'INVALID_VALIDATION_SPEC', error: `validation.enum entries on "${fieldName}" must be string or finite number` };
      }
      cleanEnum.push(typeof item === 'string' ? item.trim() : item);
    }
    out.enum = cleanEnum;
  }

  return {
    valid: true,
    validation: Object.keys(out).length > 0 ? out : undefined,
  };
}

function sanitizeFieldValidation(rawField) {
  const type = String(rawField?.type || 'string').trim();
  const name = String(rawField?.name || 'field').trim();
  const rawVal = isPlainObject(rawField?.validation) ? { ...rawField.validation } : {};
  if (rawField?.required === true && rawVal.required === undefined) rawVal.required = true;
  if (rawField?.unique === true && rawVal.unique === undefined) rawVal.unique = true;
  if (Array.isArray(rawField?.enumValues) && rawField.enumValues.length > 0 && rawVal.enum === undefined) {
    rawVal.enum = rawField.enumValues;
  }
  if (Object.keys(rawVal).length === 0) return undefined;
  const formulaReturnType = rawField?.formulaReturnType || rawField?.options?.formulaReturnType;
  const res = validateFieldValidationSpec(rawVal, type, name, { formulaReturnType });
  if (!res.valid) {
    throw makeError(res.code || 'INVALID_VALIDATION_SPEC', 400, res.error);
  }
  return res.validation;
}

// ---------------------------------------------------------------------------
// Join Collection Naming & Rich Field Normalization
// ---------------------------------------------------------------------------

function toPascalAlnum(raw, fallback = 'Item') {
  const clean = String(raw || '')
    .replace(/^latticeCustom/i, '')
    .replace(/^lattice/i, '');
  const parts = clean
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const pascal = parts.map((p) => p[0].toUpperCase() + p.slice(1)).join('');
  return pascal || fallback;
}

function toCamelPrefix(raw, fallback = 'source') {
  const pascal = toPascalAlnum(raw, 'Source');
  const singular = pascal.length > 3 && pascal.endsWith('s') && !pascal.endsWith('ss')
    ? pascal.slice(0, -1)
    : pascal;
  const camel = singular[0].toLowerCase() + singular.slice(1);
  return FIELD_NAME_RE.test(camel) ? camel : fallback;
}

function buildSafeJoinCollectionName(sourceCollection, fieldName, targetCollection) {
  const srcPascal = toPascalAlnum(sourceCollection, 'Source');
  const tgtPascal = toPascalAlnum(targetCollection || fieldName, 'Target');
  const base = `latticeCustom${srcPascal}${tgtPascal}Join`;
  if (base.length <= 54 && CUSTOM_COLLECTION_RE.test(base) && CUSTOM_RLS_TABLE_RE.test(base)) {
    return base;
  }
  const digest = crypto
    .createHash('sha256')
    .update(`${String(sourceCollection || '')}:${String(fieldName || '')}:${String(targetCollection || '')}`)
    .digest('hex')
    .slice(0, 6)
    .toUpperCase();
  const maxBody = 54 - 'latticeCustom'.length - digest.length; // 54 - 13 - 6 = 35
  const body = `${srcPascal}${tgtPascal}`.slice(0, Math.max(2, maxBody));
  return `latticeCustom${body}${digest}`;
}

function resolveThroughCollectionName(sourceCollection, field, opts = {}) {
  const name = String(field?.name || '').trim();
  const target = String(field?.target || '').trim();
  const isProtected = typeof opts.isProtectedCollection === 'function'
    ? opts.isProtectedCollection
    : () => false;

  let through;
  if (field?.through !== undefined && field?.through !== null && String(field.through).trim() !== '') {
    through = String(field.through).trim();
    if (!CUSTOM_COLLECTION_RE.test(through) || !CUSTOM_RLS_TABLE_RE.test(through) || isProtected(through)) {
      throw makeError(
        'INVALID_THROUGH_COLLECTION',
        400,
        `Invalid belongsToMany through collection "${through}" on field "${name}"`,
      );
    }
  } else {
    through = buildSafeJoinCollectionName(sourceCollection, name, target);
  }

  const foreignKey = field?.foreignKey !== undefined && field?.foreignKey !== null
    ? String(field.foreignKey).trim()
    : `${toCamelPrefix(sourceCollection, 'source')}Id`;
  const otherKey = field?.otherKey !== undefined && field?.otherKey !== null
    ? String(field.otherKey).trim()
    : `${toCamelPrefix(name, 'target')}Id`;

  if (!FIELD_NAME_RE.test(foreignKey) || BLOCKED_FIELD_NAMES.has(foreignKey) || foreignKey === 'organizationId') {
    throw makeError('INVALID_FOREIGN_KEY', 400, `Invalid foreignKey "${foreignKey || '(empty)'}" on field "${name}"`);
  }
  if (!FIELD_NAME_RE.test(otherKey) || BLOCKED_FIELD_NAMES.has(otherKey) || otherKey === 'organizationId') {
    throw makeError('INVALID_OTHER_KEY', 400, `Invalid otherKey "${otherKey || '(empty)'}" on field "${name}"`);
  }
  if (foreignKey === otherKey) {
    throw makeError('INVALID_JOIN_KEYS', 400, `foreignKey and otherKey must differ on field "${name}"`);
  }

  return { through, foreignKey, otherKey };
}

function extractFieldValidation(fieldMeta) {
  if (!fieldMeta || typeof fieldMeta !== 'object') return null;
  const opts = isPlainObject(fieldMeta.options) ? fieldMeta.options : {};
  const ui = isPlainObject(fieldMeta.uiSchema) ? fieldMeta.uiSchema : {};
  const raw = isPlainObject(fieldMeta.validation)
    ? { ...fieldMeta.validation }
    : isPlainObject(opts.validation)
      ? { ...opts.validation }
      : isPlainObject(ui['x-validation'])
        ? { ...ui['x-validation'] }
        : {};
  if ((fieldMeta.required === true || fieldMeta.allowNull === false || opts.allowNull === false) && raw.required === undefined) {
    raw.required = true;
  }
  if ((fieldMeta.unique === true || opts.unique === true) && raw.unique === undefined) {
    raw.unique = true;
  }
  const enumArr = Array.isArray(fieldMeta.enumValues)
    ? fieldMeta.enumValues
    : Array.isArray(opts.enumValues)
      ? opts.enumValues
      : null;
  if (enumArr && enumArr.length > 0 && raw.enum === undefined) {
    raw.enum = enumArr;
  }
  return Object.keys(raw).length > 0 ? raw : null;
}

function extractFormulaExpression(fieldMeta) {
  if (!fieldMeta || typeof fieldMeta !== 'object') return null;
  const opts = isPlainObject(fieldMeta.options) ? fieldMeta.options : {};
  const ui = isPlainObject(fieldMeta.uiSchema) ? fieldMeta.uiSchema : {};
  const expr = fieldMeta.formulaExpression
    ?? fieldMeta.formula
    ?? opts.formulaExpression
    ?? opts.formula
    ?? ui['x-formula'];
  return typeof expr === 'string' && expr.trim() ? expr.trim() : null;
}

// ---------------------------------------------------------------------------
// Runtime Validation & Formula Hook Engine
// ---------------------------------------------------------------------------

async function validateRecordFields(db, collectionName, fields, model, options = {}) {
  if (!Array.isArray(fields) || fields.length === 0 || !model || typeof model !== 'object') return;
  const currentId = getAttr(model, 'id');
  const isNew = model.isNewRecord !== false && (currentId === undefined || currentId === null);
  const partialFields = Array.isArray(options?.fields) && options.fields.length > 0
    ? new Set(options.fields)
    : null;
  const orgId = getAttr(model, 'organizationId') ?? options?.organizationId ?? null;

  for (const field of fields) {
    if (!field || !field.name || field.name === 'organizationId') continue;
    const fName = field.name;
    const fType = String(field.type || 'string').trim();
    const effectiveType = fType === 'formula'
      ? String(field.formulaReturnType || field.options?.formulaReturnType || 'float').trim()
      : fType;
    const validation = extractFieldValidation(field);
    if (!validation) continue;

    const value = getAttr(model, fName);
    const isPresentInPartial = !partialFields || partialFields.has(fName);

    if (validation.required) {
      if (value === null || value === '' || (value === undefined && (isNew || isPresentInPartial))) {
        throw makeError('VALIDATION_REQUIRED', 400, `Field "${fName}" is required`);
      }
    }

    if (value === undefined || value === null || value === '') continue;

    if (Array.isArray(validation.enum) && validation.enum.length > 0) {
      const matched = validation.enum.some((allowed) => (
        allowed === value || String(allowed) === String(value)
      ));
      if (!matched) {
        throw makeError('VALIDATION_ENUM', 400, `Field "${fName}" must be one of: ${validation.enum.join(', ')}`);
      }
    }

    if (validation.min !== undefined) {
      if (effectiveType === 'integer' || effectiveType === 'float' || effectiveType === 'number' || effectiveType === 'double' || effectiveType === 'decimal') {
        const num = toFiniteNumber(value, null);
        if (num === null || num < validation.min) {
          throw makeError('VALIDATION_MIN', 400, `Field "${fName}" must be >= ${validation.min}`);
        }
      } else if (effectiveType === 'string' || effectiveType === 'text') {
        if (String(value).length < validation.min) {
          throw makeError('VALIDATION_MIN', 400, `Field "${fName}" length must be >= ${validation.min}`);
        }
      }
    }

    if (validation.max !== undefined) {
      if (effectiveType === 'integer' || effectiveType === 'float' || effectiveType === 'number' || effectiveType === 'double' || effectiveType === 'decimal') {
        const num = toFiniteNumber(value, null);
        if (num === null || num > validation.max) {
          throw makeError('VALIDATION_MAX', 400, `Field "${fName}" must be <= ${validation.max}`);
        }
      } else if (effectiveType === 'string' || effectiveType === 'text') {
        if (String(value).length > validation.max) {
          throw makeError('VALIDATION_MAX', 400, `Field "${fName}" length must be <= ${validation.max}`);
        }
      }
    }

    if (validation.pattern) {
      const strVal = String(value);
      if (strVal.length > MAX_REGEX_INPUT_LENGTH) {
        throw makeError('VALIDATION_PATTERN', 400, `Field "${fName}" exceeds max pattern input length (${MAX_REGEX_INPUT_LENGTH})`);
      }
      const check = validateSafeRegexPattern(validation.pattern);
      if (!check.valid) {
        throw makeError('INVALID_VALIDATION_PATTERN', 400, check.error);
      }
      if (!check.regex.test(strVal)) {
        throw makeError('VALIDATION_PATTERN', 400, `Field "${fName}" does not match pattern`);
      }
    }

    if (validation.unique && db && typeof db.getRepository === 'function') {
      const repo = db.getRepository(collectionName);
      if (repo && typeof repo.find === 'function') {
        const filter = {
          ...(orgId != null && String(orgId).trim() !== '' ? { organizationId: String(orgId).trim() } : {}),
          [fName]: value,
        };
        const existing = await repo.find({
          filter,
          limit: 2,
          ...(options?.transaction ? { transaction: options.transaction } : {}),
        });
        const conflict = (Array.isArray(existing) ? existing : []).find((row) => {
          const rowId = getAttr(row, 'id');
          if (currentId !== undefined && currentId !== null && rowId !== undefined && rowId !== null) {
            return String(rowId) !== String(currentId);
          }
          return true;
        });
        if (conflict) {
          throw makeError('VALIDATION_UNIQUE_CONFLICT', 409, `Duplicate value for unique field "${fName}"`);
        }
      }
    }
  }
}

function applyFormulaFields(fields, model, options = {}) {
  if (!Array.isArray(fields) || fields.length === 0 || !model || typeof model !== 'object') return {};
  const formulaFields = fields.filter((f) => {
    if (!f || !f.name) return false;
    return f.type === 'formula' || Boolean(extractFormulaExpression(f));
  });
  if (formulaFields.length === 0) return {};

  const snapshot = {};
  if (model.dataValues && typeof model.dataValues === 'object') {
    for (const key of Object.keys(model.dataValues)) {
      if (!BLOCKED_FORMULA_IDENTIFIERS.has(key)) snapshot[key] = model.dataValues[key];
    }
  } else {
    for (const key of Object.keys(model)) {
      if (!BLOCKED_FORMULA_IDENTIFIERS.has(key)) snapshot[key] = model[key];
    }
  }
  for (const f of fields) {
    if (f?.name && !BLOCKED_FORMULA_IDENTIFIERS.has(f.name)) {
      const v = getAttr(model, f.name);
      if (v !== undefined) snapshot[f.name] = v;
    }
  }

  const computed = {};
  for (const f of formulaFields) {
    const expr = extractFormulaExpression(f);
    if (!expr) continue;
    const result = evaluateFormulaExpression(expr, snapshot, options);
    snapshot[f.name] = result;
    computed[f.name] = result;
    setAttr(model, f.name, result, options);
  }
  return computed;
}

const dbHookRegistry = new WeakMap();

function getOrCreateDbHookState(db) {
  let state = dbHookRegistry.get(db);
  if (!state) {
    state = {
      active: true,
      collections: new Map(),
      events: [],
      validatedOpts: new WeakSet(),
    };
    dbHookRegistry.set(db, state);
  }
  return state;
}

async function resolveCollectionFieldSpecs(db, collectionName, state) {
  const entry = state.collections.get(collectionName);
  if (entry && Array.isArray(entry.fields) && entry.fields.length > 0) {
    return entry.fields;
  }
  const fieldsRepo = db?.getRepository?.('fields');
  if (fieldsRepo && typeof fieldsRepo.find === 'function') {
    const rows = (await fieldsRepo.find({ filter: { collectionName }, limit: 500 }).catch(() => [])) || [];
    if (rows.length > 0) {
      return rows.map((r) => (typeof r?.toJSON === 'function' ? r.toJSON() : { ...r }));
    }
  }
  const colInst = db?.getCollection?.(collectionName)
    || (db?.collections && typeof db.collections.get === 'function' ? db.collections.get(collectionName) : null);
  if (colInst?.fields) {
    const rawList = colInst.fields instanceof Map
      ? [...colInst.fields.values()]
      : Array.isArray(colInst.fields)
        ? colInst.fields
        : [];
    return rawList.map((f) => (f?.options ? { ...f.options, name: f.name || f.options.name } : f));
  }
  return [];
}

function attachRichSchemaHooksForCollection(db, collectionName, fields = null) {
  const col = String(collectionName || '').trim();
  if (!db || !col || !CUSTOM_COLLECTION_RE.test(col)) return false;

  const state = getOrCreateDbHookState(db);
  state.active = true;
  let entry = state.collections.get(col);
  if (!entry) {
    entry = { fields: null, attached: false };
    state.collections.set(col, entry);
  }
  if (Array.isArray(fields)) {
    entry.fields = fields.map((f) => ({ ...f }));
  }

  if (entry.attached || typeof db.on !== 'function') {
    return entry.attached;
  }

  const beforeValidateFn = async (model, hookOpts = {}) => {
    if (!state.active) return;
    const resolvedFields = await resolveCollectionFieldSpecs(db, col, state);
    if (!resolvedFields.length) return;
    const nonFormulaFields = resolvedFields.filter((f) => f && f.type !== 'formula' && !extractFormulaExpression(f));
    await validateRecordFields(db, col, nonFormulaFields, model, hookOpts);
    if (hookOpts && typeof hookOpts === 'object') {
      state.validatedOpts.add(hookOpts);
    }
  };

  const beforeSaveFn = async (model, hookOpts = {}) => {
    if (!state.active) return;
    const resolvedFields = await resolveCollectionFieldSpecs(db, col, state);
    if (!resolvedFields.length) return;
    const nonFormulaFields = resolvedFields.filter((f) => f && f.type !== 'formula' && !extractFormulaExpression(f));
    const formulaFields = resolvedFields.filter((f) => f && (f.type === 'formula' || Boolean(extractFormulaExpression(f))));
    const alreadyValidated = Boolean(hookOpts && typeof hookOpts === 'object' && state.validatedOpts.has(hookOpts));
    if (!alreadyValidated && nonFormulaFields.length > 0) {
      await validateRecordFields(db, col, nonFormulaFields, model, hookOpts);
    }
    if (formulaFields.length > 0) {
      applyFormulaFields(resolvedFields, model, hookOpts);
      const formulaValidated = formulaFields.filter((f) => extractFieldValidation(f));
      if (formulaValidated.length > 0) {
        await validateRecordFields(db, col, formulaValidated, model, hookOpts);
      }
    }
  };

  db.on(`${col}.beforeValidate`, beforeValidateFn);
  db.on(`${col}.beforeSave`, beforeSaveFn);
  state.events.push({ event: `${col}.beforeValidate`, fn: beforeValidateFn });
  state.events.push({ event: `${col}.beforeSave`, fn: beforeSaveFn });
  entry.attached = true;
  return true;
}

function registerRichSchemaHooks(db) {
  if (!db || typeof db.on !== 'function') return { stop() {} };
  const state = getOrCreateDbHookState(db);
  state.active = true;

  if (db.collections) {
    if (typeof db.collections.keys === 'function') {
      for (const col of db.collections.keys()) {
        if (CUSTOM_COLLECTION_RE.test(col)) attachRichSchemaHooksForCollection(db, col);
      }
    } else if (typeof db.collections === 'object') {
      for (const col of Object.keys(db.collections)) {
        if (CUSTOM_COLLECTION_RE.test(col)) attachRichSchemaHooksForCollection(db, col);
      }
    }
  }

  const onColLoaded = (evt) => {
    const col = evt?.collection?.name || evt?.name;
    if (col && CUSTOM_COLLECTION_RE.test(col)) {
      attachRichSchemaHooksForCollection(db, col);
    }
  };
  db.on('collection:loaded', onColLoaded);
  state.events.push({ event: 'collection:loaded', fn: onColLoaded });

  return {
    stop() {
      if (!state.active) return;
      state.active = false;
      for (const { event, fn } of state.events) {
        if (typeof db.off === 'function') db.off(event, fn);
        else if (typeof db.removeListener === 'function') db.removeListener(event, fn);
      }
      state.events.length = 0;
      state.collections.clear();
    },
  };
}

module.exports = {
  ALLOWED_FIELD_TYPES,
  ALLOWED_FORMULA_RETURN_TYPES,
  BLOCKED_FIELD_NAMES,
  BLOCKED_FORMULA_IDENTIFIERS,
  CUSTOM_COLLECTION_RE,
  CUSTOM_RLS_TABLE_RE,
  DEFAULT_ALLOWLISTED_BUSINESS_COLLECTIONS,
  FIELD_NAME_RE,
  FORMULA_FUNCTION_NAMES,
  LEGACY_STORAGE_FIELD_TYPES,
  MAX_FORMULA_DEPTH,
  MAX_FORMULA_LENGTH,
  MAX_FORMULA_TOKENS,
  MAX_NFA_STATES,
  MAX_UNANCHORED_ROOT_NFA_STATES,
  MAX_REGEX_AST_DEPTH,
  MAX_REGEX_INPUT_LENGTH,
  MAX_REGEX_PATTERN_LENGTH,
  MAX_SAFE_REGEX_CACHE,
  MAX_TOTAL_LOOKAHEAD_STATES,
  SAFE_BUNDLE_FIELD_NAME_RE,
  applyFormulaFields,
  attachRichSchemaHooksForCollection,
  buildSafeJoinCollectionName,
  evaluateFormulaExpression,
  extractFieldValidation,
  extractFormulaExpression,
  parseFormulaAst,
  parseRegexAst,
  registerRichSchemaHooks,
  resolveThroughCollectionName,
  sanitizeFieldValidation,
  tokenizeFormula,
  validateFieldValidationSpec,
  validateFormulaExpression,
  validateRecordFields,
  validateSafeRegexPattern,
};
