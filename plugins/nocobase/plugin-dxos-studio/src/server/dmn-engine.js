/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const {
  defaultFoundation,
  val,
  fail,
  readParams,
  parseFinite,
  isOrgAdmin,
  hasCollectionPermission,
  resolveTenantActor,
  appendAuditLedger,
  runWithOptionalRls,
  saveRow,
} = require('./wms-dmn-shared');

const TABLE_KEY_RE = /^[a-zA-Z0-9_-]{2,80}$/;
const FIELD_NAME_RE = /^[a-zA-Z0-9_.-]{1,64}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const HIT_POLICIES = new Set(['FIRST', 'COLLECT']);
const ALLOWED_OPERATORS = new Set([
  'eq', '==', '===',
  'neq', '!=', '!==',
  'gt', '>',
  'gte', '>=',
  'lt', '<',
  'lte', '<=',
  'between',
  'in',
  'not_in',
  'contains',
  'any', '*',
]);

function parseScalarValue(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null') return null;
  const num = parseFinite(s);
  if (num !== null && /^-?\d+(?:\.\d+)?$/.test(s)) return num;
  return s;
}

function parseListValue(raw) {
  const s = String(raw ?? '').trim();
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    const parts = [];
    let cur = '';
    let quote = null;
    for (let i = 0; i < inner.length; i += 1) {
      const ch = inner[i];
      if (quote) {
        cur += ch;
        if (ch === quote && inner[i - 1] !== '\\') quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
        cur += ch;
      } else if (ch === ',') {
        parts.push(parseScalarValue(cur));
        cur = '';
      } else {
        cur += ch;
      }
    }
    if (cur.trim() !== '') parts.push(parseScalarValue(cur));
    return parts;
  }
  return s.split(',').map((item) => parseScalarValue(item)).filter((item) => item !== '');
}

function parseStringConditionSpec(rawText) {
  const text = String(rawText ?? '').trim();
  if (!text || text === '-' || text === '*' || text.toLowerCase() === 'any') {
    return { op: 'any', value: null };
  }
  const rangeMatch = /^\[\s*(-?\d+(?:\.\d+)?)\s*\.\.\s*(-?\d+(?:\.\d+)?)\s*\]$/.exec(text);
  if (rangeMatch) {
    const a = Number(rangeMatch[1]);
    const b = Number(rangeMatch[2]);
    return { op: 'between', value: [Math.min(a, b), Math.max(a, b)] };
  }
  const cmpMatch = /^(<=|>=|!==|!=|===|==|=|<|>)\s*(.+)$/.exec(text);
  if (cmpMatch) {
    const opMap = {
      '<': 'lt', '<=': 'lte', '>': 'gt', '>=': 'gte',
      '!=': 'neq', '!==': 'neq', '=': 'eq', '==': 'eq', '===': 'eq',
    };
    const op = opMap[cmpMatch[1]];
    const rhs = cmpMatch[2].trim();
    if (['lt', 'lte', 'gt', 'gte'].includes(op)) {
      const n = parseFinite(rhs);
      if (n === null) {
        throw fail('DMN_RULE_INVALID', 400, `Toán tử ${op} yêu cầu giá trị số hữu hạn.`);
      }
      return { op, value: n };
    }
    return { op, value: parseScalarValue(rhs) };
  }
  const notInMatch = /^(?:not_in|not\s+in)\s+(.+)$/i.exec(text);
  if (notInMatch) return { op: 'not_in', value: parseListValue(notInMatch[1]) };
  const inMatch = /^in\s+(.+)$/i.exec(text);
  if (inMatch) return { op: 'in', value: parseListValue(inMatch[1]) };
  const containsMatch = /^contains\s+(.+)$/i.exec(text);
  if (containsMatch) return { op: 'contains', value: String(parseScalarValue(containsMatch[1])) };
  return { op: 'eq', value: parseScalarValue(text) };
}

function normalizeConditionSpec(rawCond) {
  if (rawCond === undefined || rawCond === null || rawCond === '*') {
    return { op: 'any', value: null };
  }
  if (typeof rawCond === 'string') {
    return parseStringConditionSpec(rawCond);
  }
  if (typeof rawCond !== 'object' || Array.isArray(rawCond)) {
    return { op: 'eq', value: rawCond };
  }
  const op = String(rawCond.op ?? rawCond.operator ?? '').trim().toLowerCase();
  if (!ALLOWED_OPERATORS.has(op)) {
    throw fail('DMN_OPERATOR_INVALID', 400, `Toán tử DMN không được hỗ trợ: ${op || '<empty>'}`);
  }
  if (op === 'between') {
    const range = rawCond.value;
    if (!Array.isArray(range) || range.length !== 2) {
      throw fail('DMN_RULE_INVALID', 400, 'Toán tử between yêu cầu mảng [min, max].');
    }
    const min = parseFinite(range[0]);
    const max = parseFinite(range[1]);
    if (min === null || max === null || min > max) {
      throw fail('DMN_RULE_INVALID', 400, 'Khoảng between [min, max] không hợp lệ.');
    }
    return { op: 'between', value: [min, max] };
  }
  if (op === 'in' || op === 'not_in') {
    if (!Array.isArray(rawCond.value)) {
      throw fail('DMN_RULE_INVALID', 400, `Toán tử ${op} yêu cầu mảng giá trị.`);
    }
    return { op, value: rawCond.value };
  }
  if (['gt', '>', 'gte', '>=', 'lt', '<', 'lte', '<='].includes(op)) {
    const num = parseFinite(rawCond.value);
    if (num === null) {
      throw fail('DMN_RULE_INVALID', 400, `Toán tử ${op} yêu cầu giá trị số hữu hạn.`);
    }
    return { op, value: num };
  }
  return { op, value: rawCond.value };
}

function validateAndNormalizeSchemaList(rawList, kind) {
  if (!Array.isArray(rawList) || rawList.length === 0 || rawList.length > 50) {
    throw fail('DMN_SCHEMA_INVALID', 400, `${kind} phải là mảng từ 1 đến 50 trường.`);
  }
  return rawList.map((item) => {
    const name = typeof item === 'string' ? item.trim() : String(item?.name || '').trim();
    if (!FIELD_NAME_RE.test(name) || FORBIDDEN_KEYS.has(name)) {
      throw fail('DMN_SCHEMA_INVALID', 400, `Tên trường ${kind} không hợp lệ: ${name}`);
    }
    return typeof item === 'object' && item !== null
      ? { name, ...(item.type ? { type: String(item.type).trim() } : {}), ...(item.label ? { label: String(item.label).trim() } : {}) }
      : { name };
  });
}

function validateAndNormalizeRules(rawRules) {
  if (!Array.isArray(rawRules) || rawRules.length > 500) {
    throw fail('DMN_RULE_INVALID', 400, 'rulesJson phải là mảng tối đa 500 luật.');
  }
  return rawRules.map((rule, idx) => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      throw fail('DMN_RULE_INVALID', 400, `Luật #${idx} không hợp lệ.`);
    }
    const rawWhen = rule.when ?? rule.conditions ?? {};
    const rawThen = rule.then ?? rule.outputs ?? null;
    if (!rawWhen || typeof rawWhen !== 'object' || Array.isArray(rawWhen)) {
      throw fail('DMN_RULE_INVALID', 400, `Điều kiện when tại luật #${idx} không hợp lệ.`);
    }
    if (!rawThen || typeof rawThen !== 'object' || Array.isArray(rawThen)) {
      throw fail('DMN_RULE_INVALID', 400, `Kết quả then tại luật #${idx} phải là object.`);
    }
    const when = {};
    for (const [k, cond] of Object.entries(rawWhen)) {
      if (!FIELD_NAME_RE.test(k) || FORBIDDEN_KEYS.has(k)) {
        throw fail('DMN_RULE_INVALID', 400, `Tên đầu vào không hợp lệ tại luật #${idx}: ${k}`);
      }
      when[k] = normalizeConditionSpec(cond);
    }
    const then = {};
    for (const [k, outVal] of Object.entries(rawThen)) {
      if (!FIELD_NAME_RE.test(k) || FORBIDDEN_KEYS.has(k)) {
        throw fail('DMN_RULE_INVALID', 400, `Tên đầu ra không hợp lệ tại luật #${idx}: ${k}`);
      }
      then[k] = outVal;
    }
    return {
      when,
      then,
      ...(typeof rule.description === 'string' && rule.description.trim() ? { description: rule.description.trim().slice(0, 255) } : {}),
    };
  });
}

function valuesEqual(actual, expected) {
  const numA = parseFinite(actual);
  const numE = parseFinite(expected);
  if (numA !== null && numE !== null) return numA === numE;
  return actual === expected;
}

function matchCondition(actual, rawSpec) {
  const spec = normalizeConditionSpec(rawSpec);
  const op = spec.op;
  if (op === 'any' || op === '*') return true;
  if (op === 'eq' || op === '==' || op === '===') return valuesEqual(actual, spec.value);
  if (op === 'neq' || op === '!=' || op === '!==') return !valuesEqual(actual, spec.value);

  if (['gt', '>', 'gte', '>=', 'lt', '<', 'lte', '<='].includes(op)) {
    const aNum = parseFinite(actual);
    const eNum = parseFinite(spec.value);
    if (aNum === null || eNum === null) return false;
    switch (op) {
      case 'gt':
      case '>':
        return aNum > eNum;
      case 'gte':
      case '>=':
        return aNum >= eNum;
      case 'lt':
      case '<':
        return aNum < eNum;
      case 'lte':
      case '<=':
        return aNum <= eNum;
      default:
        return false;
    }
  }

  if (op === 'between') {
    const aNum = parseFinite(actual);
    if (aNum === null) return false;
    return aNum >= spec.value[0] && aNum <= spec.value[1];
  }

  if (op === 'in') {
    return Array.isArray(spec.value) && spec.value.some((item) => valuesEqual(actual, item));
  }
  if (op === 'not_in') {
    return Array.isArray(spec.value) && !spec.value.some((item) => valuesEqual(actual, item));
  }
  if (op === 'contains') {
    if (actual === undefined || actual === null || spec.value === undefined || spec.value === null) return false;
    return String(actual).toLowerCase().includes(String(spec.value).toLowerCase());
  }
  return false;
}

function evaluateDecisionTable(table, context = {}) {
  if (!table || typeof table !== 'object') {
    throw fail('DMN_TABLE_INVALID', 400, 'Bảng quyết định không hợp lệ.');
  }
  const hitPolicy = String(val(table, 'hitPolicy') || 'FIRST').trim().toUpperCase();
  if (!HIT_POLICIES.has(hitPolicy)) {
    throw fail('DMN_HIT_POLICY_INVALID', 400, `Unsupported DMN hitPolicy: ${hitPolicy}`);
  }
  const rules = Array.isArray(val(table, 'rulesJson')) ? val(table, 'rulesJson') : [];
  const ctxObj = context && typeof context === 'object' && !Array.isArray(context) ? context : {};

  const matchedRules = [];
  for (let i = 0; i < rules.length; i += 1) {
    const rule = rules[i];
    const when = rule?.when ?? rule?.conditions ?? {};
    const then = rule?.then ?? rule?.outputs ?? {};
    let isMatch = true;
    for (const [inputKey, cond] of Object.entries(when)) {
      if (FORBIDDEN_KEYS.has(inputKey)) {
        isMatch = false;
        break;
      }
      const actual = Object.hasOwn(ctxObj, inputKey) ? ctxObj[inputKey] : undefined;
      if (!matchCondition(actual, cond)) {
        isMatch = false;
        break;
      }
    }
    if (isMatch) {
      matchedRules.push({
        ruleIndex: i,
        outputs: then,
        ...(rule?.description ? { description: rule.description } : {}),
      });
      if (hitPolicy === 'FIRST') break;
    }
  }

  if (hitPolicy === 'FIRST') {
    const first = matchedRules[0] || null;
    return {
      hitPolicy,
      matched: Boolean(first),
      matchedRuleIndex: first ? first.ruleIndex : -1,
      result: first ? first.outputs : null,
      outputs: first ? first.outputs : null,
      matchedRules,
    };
  }

  return {
    hitPolicy,
    matched: matchedRules.length > 0,
    results: matchedRules.map((m) => m.outputs),
    matchedRules,
  };
}

function serializeDecisionTable(row) {
  if (!row) return null;
  return {
    id: val(row, 'id') ?? null,
    organizationId: val(row, 'organizationId'),
    tableKey: val(row, 'tableKey'),
    name: val(row, 'name'),
    description: val(row, 'description') || null,
    hitPolicy: val(row, 'hitPolicy') || 'FIRST',
    inputsJson: val(row, 'inputsJson') || [],
    outputsJson: val(row, 'outputsJson') || [],
    rulesJson: val(row, 'rulesJson') || [],
    version: Number(val(row, 'version')) || 1,
    published: val(row, 'published') !== false,
    updatedBy: val(row, 'updatedBy') || null,
    active: val(row, 'active') !== false,
  };
}

function createDxosDmnActions(db, foundation = defaultFoundation) {
  if (typeof foundation?.pgRls?.installRlsTransactionBridge === 'function') {
    foundation.pgRls.installRlsTransactionBridge(db);
  }

  return {
    listTables: async (ctx, next) => {
      if ((ctx.method || 'GET') !== 'GET') throw fail('METHOD_NOT_ALLOWED', 405);
      const params = readParams(ctx);
      const { organizationId } = await resolveTenantActor(db, ctx, {
        requireOrg: false,
        requestedOrgId: params.organizationId,
        aclCollections: null,
        patScopes: ['read', 'write', 'dmn'],
      }, foundation);
      const repo = db.getRepository?.('latticeDecisionTables');
      if (!repo) {
        ctx.body = { organizationId, items: [] };
        return next();
      }
      const filter = {
        ...(organizationId ? { organizationId } : {}),
        ...(typeof params.tableKey === 'string' && params.tableKey.trim() ? { tableKey: params.tableKey.trim() } : {}),
        ...(params.activeOnly === true || params.activeOnly === 'true' ? { active: true } : {}),
      };
      const limit = Math.max(1, Math.min(200, Math.floor(Number(params.limit) || 100)));
      const rows = await runWithOptionalRls(db, organizationId, (transaction) => (
        repo.find({ filter, sort: ['tableKey', 'id'], limit, ...(transaction ? { transaction } : {}) })
      ), foundation) || [];
      ctx.body = { organizationId, items: rows.map(serializeDecisionTable) };
      return next();
    },

    saveTable: async (ctx, next) => {
      if ((ctx.method || 'POST') !== 'POST') throw fail('METHOD_NOT_ALLOWED', 405);
      const params = readParams(ctx);
      const { isRoot, organizationId, actor } = await resolveTenantActor(db, ctx, {
        requireOrg: true,
        requestedOrgId: params.organizationId,
        aclCollections: null,
        patScopes: ['write', 'dmn'],
      }, foundation);
      if (!isRoot) {
        const adminOk = await isOrgAdmin(db, ctx);
        const granted = await hasCollectionPermission(db, ctx, ['latticeDecisionTables'], ['create', 'update']);
        if (!adminOk && !granted) {
          throw fail('DXOS_ACL_DENIED', 403, 'Chỉ quản trị viên hoặc vai trò được cấp quyền mới được sửa bảng quyết định DMN.');
        }
      }

      const tableKey = typeof params.tableKey === 'string' ? params.tableKey.trim() : '';
      if (!TABLE_KEY_RE.test(tableKey)) {
        throw fail('DMN_TABLE_KEY_INVALID', 400, 'tableKey phải dài 2-80 ký tự [a-zA-Z0-9_-].');
      }
      const name = typeof params.name === 'string' ? params.name.trim().slice(0, 160) : '';
      if (!name) throw fail('DMN_NAME_REQUIRED', 400, 'Cần tên bảng quyết định.');

      const hitPolicy = String(params.hitPolicy || 'FIRST').trim().toUpperCase();
      if (!HIT_POLICIES.has(hitPolicy)) {
        throw fail('DMN_HIT_POLICY_INVALID', 400, 'hitPolicy chỉ hỗ trợ FIRST hoặc COLLECT.');
      }

      const inputsJson = validateAndNormalizeSchemaList(params.inputsJson, 'inputsJson');
      const outputsJson = validateAndNormalizeSchemaList(params.outputsJson, 'outputsJson');
      const rulesJson = validateAndNormalizeRules(params.rulesJson);

      const repo = db.getRepository?.('latticeDecisionTables');
      if (!repo) throw fail('DMN_REPO_UNAVAILABLE', 503);

      const serialized = await runWithOptionalRls(db, organizationId, async (transaction) => {
        const txOpt = transaction ? { transaction } : {};
        const existing = await repo.findOne({ filter: { organizationId, tableKey }, ...txOpt });
        const patch = {
          organizationId,
          tableKey,
          name,
          description: typeof params.description === 'string' ? params.description.trim().slice(0, 500) : null,
          hitPolicy,
          inputsJson,
          outputsJson,
          rulesJson,
          published: params.published === undefined ? true : Boolean(params.published),
          active: params.active === undefined ? true : Boolean(params.active),
          updatedBy: actor.username,
          version: existing ? (Number(val(existing, 'version')) || 1) + 1 : 1,
        };

        const saved = existing
          ? await saveRow(repo, existing, patch, { organizationId }, transaction)
          : await repo.create({ values: patch, ...txOpt });

        const out = serializeDecisionTable(saved);
        await appendAuditLedger(db, {
          organizationId,
          eventType: 'dmn.table_saved',
          targetCollection: 'latticeDecisionTables',
          targetRecordId: String(out.id ?? tableKey),
          actor,
          payload: { tableKey, hitPolicy, version: out.version, ruleCount: rulesJson.length },
          transaction,
          scope: 'dxos:dmn',
          foundation,
        });
        return out;
      }, foundation);

      ctx.body = { table: serialized };
      return next();
    },

    evaluate: async (ctx, next) => {
      if (!['GET', 'POST'].includes(ctx.method || 'GET')) throw fail('METHOD_NOT_ALLOWED', 405);
      const params = readParams(ctx);
      const { organizationId } = await resolveTenantActor(db, ctx, {
        requireOrg: true,
        requestedOrgId: params.organizationId,
        aclCollections: null,
        patScopes: ['read', 'write', 'dmn'],
      }, foundation);
      const tableKey = typeof params.tableKey === 'string' ? params.tableKey.trim() : '';
      if (!tableKey) throw fail('DMN_TABLE_KEY_REQUIRED', 400, 'Cần tableKey để đánh giá DMN.');

      const repo = db.getRepository?.('latticeDecisionTables');
      if (!repo) throw fail('DMN_REPO_UNAVAILABLE', 503);

      let evalContext = params.context ?? params.input ?? {};
      if (typeof evalContext === 'string') {
        try {
          evalContext = JSON.parse(evalContext);
        } catch {
          throw fail('DMN_CONTEXT_INVALID', 400, 'context DMN không phải JSON hợp lệ.');
        }
      }

      const table = await runWithOptionalRls(db, organizationId, (transaction) => (
        repo.findOne({ filter: { organizationId, tableKey }, ...(transaction ? { transaction } : {}) })
      ), foundation);
      if (!table || val(table, 'organizationId') !== organizationId || val(table, 'active') === false) {
        throw fail('DMN_TABLE_NOT_FOUND', 404, 'Không tìm thấy bảng quyết định DMN đang hoạt động trong tổ chức.');
      }

      const evaluation = evaluateDecisionTable(table, evalContext);
      ctx.body = {
        tableKey,
        version: Number(val(table, 'version')) || 1,
        ...evaluation,
      };
      return next();
    },
  };
}

module.exports = {
  ALLOWED_OPERATORS,
  HIT_POLICIES,
  evaluateDecisionTable,
  createDxosDmnActions,
};
