/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { evaluateDecisionTable } = require('../../dmn-engine');
const { fail, toPlain, val } = require('../../wms-dmn-shared');
const { flowHelpers } = require('./triggers');

const { BLOCKED_PROTO_KEYS, isPlainObject, sanitizePlainObject, getSafePath, interpolateTemplate, buildEvalContext, resolveOrgId, pickHelper } = flowHelpers;

function assertSafeTargetPath(rawTarget, label = 'target') {
  const clean = String(rawTarget || '').trim();
  if (!clean || !/^[a-zA-Z0-9_.-]+$/.test(clean)) {
    throw fail('UNSAFE_TRANSFORM_KEY', 400, `UNSAFE_TRANSFORM_KEY: invalid ${label} "${clean}"`);
  }
  const segs = clean.split('.').filter(Boolean);
  if (!segs.length || segs.some((s) => BLOCKED_PROTO_KEYS.has(s))) {
    throw fail('UNSAFE_TRANSFORM_KEY', 400, `UNSAFE_TRANSFORM_KEY: blocked prototype segment in "${clean}"`);
  }
  return segs;
}

function setSafeNested(root, targetPath, value) {
  const segs = assertSafeTargetPath(targetPath, 'target');
  let curr = root;
  for (let i = 0; i < segs.length - 1; i += 1) {
    const seg = segs[i];
    if (!Object.prototype.hasOwnProperty.call(curr, seg) || !isPlainObject(curr[seg])) {
      Object.defineProperty(curr, seg, { value: {}, writable: true, enumerable: true, configurable: true });
    }
    curr = curr[seg];
  }
  const leaf = segs[segs.length - 1];
  Object.defineProperty(curr, leaf, { value, writable: true, enumerable: true, configurable: true });
}

function deleteSafeNested(root, targetPath) {
  const segs = assertSafeTargetPath(targetPath, 'key');
  let curr = root;
  for (let i = 0; i < segs.length - 1; i += 1) {
    if (!curr || typeof curr !== 'object' || !Object.prototype.hasOwnProperty.call(curr, segs[i])) return;
    curr = curr[segs[i]];
  }
  if (curr && typeof curr === 'object') delete curr[segs[segs.length - 1]];
}

function resolveTransformOperand(raw, lookupRoot, getPath, interp) {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) throw fail('TRANSFORM_MATH_INVALID_OPERAND', 400, 'Non-finite number operand');
    return raw;
  }
  const valOrExpr = typeof raw === 'string' && raw.includes('{{') ? interp(raw, lookupRoot)
    : (typeof raw === 'string' ? (getPath(lookupRoot.result, raw) ?? getPath(lookupRoot, raw) ?? raw) : raw);
  if (valOrExpr === null || valOrExpr === undefined || valOrExpr === '' || typeof valOrExpr === 'boolean') {
    throw fail('TRANSFORM_MATH_INVALID_OPERAND', 400, `Math operand "${raw}" is not numeric`);
  }
  const num = Number(valOrExpr);
  if (!Number.isFinite(num)) throw fail('TRANSFORM_MATH_INVALID_OPERAND', 400, `Math operand "${raw}" is not finite`);
  return num;
}

function runMathOperation(op, lookupRoot, getPath, interp) {
  let operator = String(op.operator || op.mathOp || op.action || op.fn || 'add').trim().toLowerCase();
  let rawLeft = op.left;
  let rawRight = op.right;
  if (Array.isArray(op.operands) && op.operands.length >= 2) { [rawLeft, rawRight] = op.operands; }
  else if (typeof op.expr === 'string' && (rawLeft === undefined || rawRight === undefined)) {
    const m = op.expr.trim().match(/^([a-zA-Z0-9_.\-$]+)\s*([+\-*/])\s*([a-zA-Z0-9_.\-$]+)$/);
    if (!m) throw fail('TRANSFORM_MATH_INVALID_EXPR', 400, `Unsupported math expr "${op.expr}"`);
    [, rawLeft, operator, rawRight] = m;
  }
  const norm = { '+': 'add', add: 'add', '-': 'sub', sub: 'sub', '*': 'mul', mul: 'mul', '/': 'div', div: 'div' }[operator];
  if (!norm) throw fail('TRANSFORM_MATH_UNSUPPORTED_OP', 400, `Unsupported math operator "${operator}"`);
  const a = resolveTransformOperand(rawLeft, lookupRoot, getPath, interp);
  const b = resolveTransformOperand(rawRight, lookupRoot, getPath, interp);
  let computed;
  if (norm === 'add') computed = a + b;
  else if (norm === 'sub') computed = a - b;
  else if (norm === 'mul') computed = a * b;
  else {
    if (b === 0) throw fail('TRANSFORM_DIVIDE_BY_ZERO', 400, 'TRANSFORM_DIVIDE_BY_ZERO: cannot divide by zero');
    computed = a / b;
  }
  if (Number.isInteger(op.precision) && op.precision >= 0 && op.precision <= 12) {
    computed = Number(computed.toFixed(op.precision));
  }
  return computed;
}

const logicNodes = [
  {
    type: 'logic.dmn',
    category: 'logic',
    label: 'Evaluate DMN Decision Table',
    description: 'Evaluates an organization-scoped DMN decision table and exposes outputs.',
    icon: 'TableOutlined',
    color: '#52c41a',
    inputs: ['in'],
    outputs: ['main', 'error'],
    defaultConfig: { tableKey: '', facts: {} },
    inputSchema: {
      fields: [
        { name: 'tableKey', label: 'DMN Table Key', type: 'string', required: true },
        { name: 'facts', label: 'Facts Override (JSON)', type: 'json' },
      ],
    },
    async execute({ node, config, input, context, db, options, helpers }) {
      const cfg = config || node?.config || {};
      const evalCtx = buildEvalContext(context, input);
      const interp = pickHelper(helpers, 'interpolateTemplate', interpolateTemplate);
      const tableKey = String(interp(cfg.tableKey || '', evalCtx)).trim();
      const orgId = resolveOrgId(context, input, options, cfg);
      if (!tableKey) throw fail('DMN_TABLE_KEY_REQUIRED', 400, 'logic.dmn requires tableKey');
      if (!orgId) throw fail('DMN_ORG_REQUIRED', 400, 'Valid organizationId is required for logic.dmn');

      const repo = db?.getRepository?.('latticeDecisionTables');
      const row = repo ? await repo.findOne({ filter: { organizationId: orgId, tableKey } }) : null;
      if (!row || val(row, 'organizationId') !== orgId || val(row, 'active') === false) {
        throw fail('DMN_TABLE_NOT_FOUND', 404, `DMN_TABLE_NOT_FOUND: ${tableKey}`);
      }
      const extraFacts = isPlainObject(cfg.facts) ? interp(cfg.facts, evalCtx) : {};
      const facts = { ...evalCtx.data, ...(isPlainObject(input) ? input : {}), ...(isPlainObject(extraFacts) ? extraFacts : {}), organizationId: orgId };
      const dmnEval = evaluateDecisionTable(toPlain(row), facts);
      const outputs = dmnEval.hitPolicy === 'COLLECT'
        ? { results: Array.isArray(dmnEval.results) ? dmnEval.results : [] }
        : (isPlainObject(dmnEval.outputs) ? dmnEval.outputs : {});
      if (isPlainObject(context)) {
        context.dmn = outputs;
        context.dmnResult = { tableKey, matched: Boolean(dmnEval.matched), hitPolicy: dmnEval.hitPolicy, outputs };
      }
      return { output: { tableKey, matched: Boolean(dmnEval.matched), hitPolicy: dmnEval.hitPolicy, outputs, matchedRules: dmnEval.matchedRules }, nextPort: 'main' };
    },
  },
  {
    type: 'logic.transform',
    category: 'logic',
    label: 'Declarative Data Transform',
    description: 'Transforms, maps, coerces, and computes fields safely without dynamic code execution.',
    icon: 'FunctionOutlined',
    color: '#52c41a',
    inputs: ['in'],
    outputs: ['main', 'error'],
    defaultConfig: { operations: [], baseFromInput: true },
    inputSchema: {
      fields: [
        { name: 'operations', label: 'Transform Operations (JSON)', type: 'json', required: true },
        { name: 'baseFromInput', label: 'Start From Input Object', type: 'boolean' },
      ],
    },
    async execute({ node, config, input, context, helpers }) {
      const cfg = config || node?.config || {};
      const evalCtx = buildEvalContext(context, input);
      const getPath = pickHelper(helpers, 'getSafePath', getSafePath);
      const interp = pickHelper(helpers, 'interpolateTemplate', interpolateTemplate);
      const san = pickHelper(helpers, 'sanitizePlainObject', sanitizePlainObject);
      let result = cfg.baseFromInput === false ? {} : san(isPlainObject(input) ? input : (isPlainObject(evalCtx.data) ? evalCtx.data : {}));
      const ops = Array.isArray(cfg.operations) ? cfg.operations : [];

      for (const op of ops) {
        if (!isPlainObject(op)) continue;
        if (Object.getOwnPropertyNames(op).some((k) => BLOCKED_PROTO_KEYS.has(k))) throw fail('UNSAFE_TRANSFORM_KEY', 400, 'Blocked prototype key');
        const kind = String(op.op || '').trim();
        const root = { ...evalCtx, result };
        const readSrc = () => (op.source ? (getPath(result, op.source) ?? getPath(root, op.source)) : interp(op.value, root));

        if (kind === 'set') setSafeNested(result, op.target, op.source && op.value === undefined ? readSrc() : interp(op.value, root));
        else if (kind === 'template') setSafeNested(result, op.target, interp(op.expr ?? op.template ?? op.value ?? '', root));
        else if (kind === 'coerceNumber') {
          const raw = op.source ? readSrc() : (op.value ?? getPath(result, op.target));
          const num = raw === '' || raw === null || raw === undefined || typeof raw === 'boolean' ? NaN : Number(raw);
          const out = Number.isFinite(num) ? (Number.isInteger(op.precision) ? Number(num.toFixed(Math.max(0, Math.min(12, op.precision)))) : num) : (op.fallback ?? null);
          setSafeNested(result, op.target, out);
        } else if (kind === 'coerceBoolean') {
          const raw = op.source ? readSrc() : (op.value ?? getPath(result, op.target));
          const s = typeof raw === 'string' ? raw.trim().toLowerCase() : raw;
          const boolVal = s === 'false' || s === '0' || s === 'no' || s === 'off' || s === '' ? false : Boolean(raw);
          setSafeNested(result, op.target, boolVal);
        } else if (kind === 'math') setSafeNested(result, op.target, runMathOperation(op, root, getPath, interp));
        else if (kind === 'concat') {
          const parts = Array.isArray(op.parts || op.sources || op.values) ? (op.parts || op.sources || op.values) : [];
          const sep = String(op.separator ?? '');
          const joined = parts.map((p) => {
            if (typeof p === 'string' && p.includes('{{')) return String(interp(p, root) ?? '');
            const r = typeof p === 'string' ? (getPath(result, p) ?? getPath(root, p)) : p;
            return r === undefined || r === null ? '' : String(r);
          }).join(sep);
          setSafeNested(result, op.target, joined);
        } else if (kind === 'rename') {
          const fromPath = op.from ?? op.source;
          const toPath = op.to ?? op.target;
          assertSafeTargetPath(fromPath, 'from');
          assertSafeTargetPath(toPath, 'to');
          const valMoved = getPath(result, fromPath) ?? getPath(root, fromPath);
          deleteSafeNested(result, fromPath);
          setSafeNested(result, toPath, valMoved);
        } else if (kind === 'pick') {
          const keys = Array.isArray(op.keys || op.fields || op.value) ? (op.keys || op.fields || op.value) : [op.source || op.target];
          const picked = {};
          for (const k of keys) {
            const segs = assertSafeTargetPath(k, 'pick key');
            const v = getPath(result, k);
            if (v !== undefined) setSafeNested(picked, segs.join('.'), v);
          }
          if (op.target) setSafeNested(result, op.target, picked);
          else result = picked;
        } else if (kind === 'omit') {
          const keys = Array.isArray(op.keys || op.fields || op.value) ? (op.keys || op.fields || op.value) : [op.target || op.source];
          for (const k of keys) deleteSafeNested(result, k);
        } else {
          throw fail('UNSUPPORTED_TRANSFORM_OP', 400, `Unsupported transform op: ${kind || '(empty)'}`);
        }
      }
      return { output: san(result), nextPort: 'main' };
    },
  },
];

module.exports = { logicNodes };
