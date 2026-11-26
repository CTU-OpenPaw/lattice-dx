/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const HIT_POLICIES = Object.freeze(['FIRST', 'UNIQUE', 'COLLECT', 'PRIORITY']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ALLOWED_COL_TYPES = Object.freeze(['string', 'number', 'boolean', 'json']);

function unwrapData(res) {
  return res?.data?.data ?? res?.data ?? {};
}

function extractError(err, fallback) {
  return err?.response?.data?.errors?.[0]?.message
    || err?.response?.data?.message
    || err?.message
    || fallback;
}

function parseScalar(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null') return null;
  const num = Number(s);
  if (Number.isFinite(num) && /^-?\d+(?:\.\d+)?$/.test(s)) return num;
  return s;
}

function formatScalar(val) {
  if (val === null || val === undefined) return '-';
  if (typeof val === 'string') return JSON.stringify(val);
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  return JSON.stringify(val);
}

function parseListLiteral(raw) {
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
        parts.push(parseScalar(cur));
        cur = '';
      } else {
        cur += ch;
      }
    }
    if (cur.trim() !== '') parts.push(parseScalar(cur));
    return parts;
  }
  return s.split(',').map((item) => parseScalar(item)).filter((item) => item !== '');
}

function parseFeelCell(rawInput) {
  if (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) {
    const op = String(rawInput.op || rawInput.operator || 'any').trim().toLowerCase();
    return { op, value: rawInput.value ?? null };
  }
  const text = String(rawInput ?? '').trim();
  if (!text || text === '-' || text === '*' || text.toLowerCase() === 'any') {
    return { op: 'any', value: null };
  }

  // Range expression: [min..max]
  const rangeMatch = /^\[\s*(-?\d+(?:\.\d+)?)\s*\.\.\s*(-?\d+(?:\.\d+)?)\s*\]$/.exec(text);
  if (rangeMatch) {
    const a = Number(rangeMatch[1]);
    const b = Number(rangeMatch[2]);
    const min = Math.min(a, b);
    const max = Math.max(a, b);
    return { op: 'between', value: [min, max] };
  }

  // Relational comparisons
  const cmpMatch = /^(<=|>=|!==|!=|===|==|=|<|>)\s*(.+)$/.exec(text);
  if (cmpMatch) {
    const sym = cmpMatch[1];
    const rhs = cmpMatch[2].trim();
    const opMap = {
      '<': 'lt',
      '<=': 'lte',
      '>': 'gt',
      '>=': 'gte',
      '!=': 'neq',
      '!==': 'neq',
      '=': 'eq',
      '==': 'eq',
      '===': 'eq',
    };
    const op = opMap[sym];
    if (['lt', 'lte', 'gt', 'gte'].includes(op)) {
      const n = Number(rhs);
      return { op, value: Number.isFinite(n) ? n : parseScalar(rhs) };
    }
    return { op, value: parseScalar(rhs) };
  }

  // List membership: in [...] / not_in [...] / not in [...]
  const notInMatch = /^(?:not_in|not\s+in)\s+(.+)$/i.exec(text);
  if (notInMatch) {
    return { op: 'not_in', value: parseListLiteral(notInMatch[1]) };
  }
  const inMatch = /^in\s+(.+)$/i.exec(text);
  if (inMatch) {
    return { op: 'in', value: parseListLiteral(inMatch[1]) };
  }

  // Substring match: contains ...
  const containsMatch = /^contains\s+(.+)$/i.exec(text);
  if (containsMatch) {
    return { op: 'contains', value: String(parseScalar(containsMatch[1])) };
  }

  return { op: 'eq', value: parseScalar(text) };
}

function formatFeelCell(condSpec) {
  if (condSpec === null || condSpec === undefined || condSpec === '*' || condSpec === '-') return '-';
  if (typeof condSpec !== 'object' || Array.isArray(condSpec)) {
    return formatScalar(condSpec);
  }
  const op = String(condSpec.op ?? condSpec.operator ?? 'any').trim().toLowerCase();
  if (op === 'any' || op === '*') return '-';
  if (op === 'between' && Array.isArray(condSpec.value) && condSpec.value.length === 2) {
    return `[${condSpec.value[0]}..${condSpec.value[1]}]`;
  }
  if (op === 'lt' || op === '<') return `< ${condSpec.value}`;
  if (op === 'lte' || op === '<=') return `<= ${condSpec.value}`;
  if (op === 'gt' || op === '>') return `> ${condSpec.value}`;
  if (op === 'gte' || op === '>=') return `>= ${condSpec.value}`;
  if (op === 'neq' || op === '!=' || op === '!==') return `!= ${formatScalar(condSpec.value)}`;
  if (op === 'eq' || op === '==' || op === '===') return formatScalar(condSpec.value);
  if (op === 'in') return `in ${JSON.stringify(Array.isArray(condSpec.value) ? condSpec.value : [])}`;
  if (op === 'not_in') return `not_in ${JSON.stringify(Array.isArray(condSpec.value) ? condSpec.value : [])}`;
  if (op === 'contains') return `contains ${formatScalar(condSpec.value)}`;
  return '-';
}

function parseOutputCell(rawInput) {
  if (typeof rawInput !== 'string') return rawInput ?? '';
  const text = rawInput.trim();
  if (!text) return '';
  if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return parseScalar(text);
}

function formatOutputCell(val) {
  if (val === undefined || val === null) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  return JSON.stringify(val);
}

function normalizeColumnList(rawCols, defaultPrefix) {
  if (!Array.isArray(rawCols) || rawCols.length === 0) {
    return [{ name: `${defaultPrefix}1`, type: 'string' }];
  }
  return rawCols.map((c, idx) => {
    const name = typeof c === 'string' ? c.trim() : String(c?.name || `${defaultPrefix}${idx + 1}`).trim();
    const safeName = FORBIDDEN_KEYS.has(name) || !name ? `${defaultPrefix}${idx + 1}` : name;
    const type = ALLOWED_COL_TYPES.includes(c?.type) ? c.type : 'string';
    return {
      name: safeName,
      type,
      ...(c?.label ? { label: String(c.label) } : {}),
    };
  });
}

function normalizeDmnTable(rawTable = {}) {
  const hitRaw = String(rawTable.hitPolicy || 'FIRST').trim().toUpperCase();
  const hitPolicy = HIT_POLICIES.includes(hitRaw) ? hitRaw : 'FIRST';
  const inputsJson = normalizeColumnList(rawTable.inputsJson, 'input');
  const outputsJson = normalizeColumnList(rawTable.outputsJson, 'output');
  const rawRules = Array.isArray(rawTable.rulesJson) ? rawTable.rulesJson : [];
  const rulesJson = rawRules.map((rule) => {
    const when = {};
    for (const col of inputsJson) {
      const rawCond = rule?.when?.[col.name] ?? rule?.conditions?.[col.name];
      when[col.name] = parseFeelCell(rawCond);
    }
    const then = {};
    for (const col of outputsJson) {
      const rawOut = rule?.then?.[col.name] ?? rule?.outputs?.[col.name];
      if (rawOut !== undefined) then[col.name] = rawOut;
    }
    return {
      when,
      then,
      ...(typeof rule?.description === 'string' && rule.description.trim() ? { description: rule.description.trim() } : {}),
      ...(Number.isFinite(Number(rule?.priority)) ? { priority: Number(rule.priority) } : {}),
    };
  });

  return {
    tableKey: String(rawTable.tableKey || 'decision_table_1'),
    name: String(rawTable.name || 'Bảng Quyết Định'),
    description: typeof rawTable.description === 'string' ? rawTable.description : '',
    hitPolicy,
    inputsJson,
    outputsJson,
    rulesJson,
  };
}

function uniqueColumnName(existingCols, baseName) {
  const taken = new Set(existingCols.map((c) => c.name));
  if (!taken.has(baseName)) return baseName;
  let n = existingCols.length + 1;
  while (taken.has(`${baseName}_${n}`)) n += 1;
  return `${baseName}_${n}`;
}

function addInputColumn(table, col = {}) {
  const norm = normalizeDmnTable(table);
  const rawName = String(col.name || '').trim();
  const name = rawName && !FORBIDDEN_KEYS.has(rawName)
    ? uniqueColumnName(norm.inputsJson, rawName)
    : uniqueColumnName(norm.inputsJson, 'input');
  const type = ALLOWED_COL_TYPES.includes(col.type) ? col.type : 'string';
  return {
    ...norm,
    inputsJson: [...norm.inputsJson, { name, type, ...(col.label ? { label: String(col.label) } : {}) }],
    rulesJson: norm.rulesJson.map((r) => ({
      ...r,
      when: { ...r.when, [name]: { op: 'any', value: null } },
    })),
  };
}

function updateInputColumn(table, index, patch = {}) {
  const norm = normalizeDmnTable(table);
  const target = norm.inputsJson[index];
  if (!target) return norm;
  const oldName = target.name;
  const nextNameRaw = typeof patch.name === 'string' ? patch.name.trim() : oldName;
  const nextName = nextNameRaw && !FORBIDDEN_KEYS.has(nextNameRaw) ? nextNameRaw : oldName;
  const nextType = patch.type && ALLOWED_COL_TYPES.includes(patch.type) ? patch.type : target.type;
  const nextInputs = norm.inputsJson.map((c, i) => (i === index ? { ...c, name: nextName, type: nextType } : c));
  const nextRules = norm.rulesJson.map((r) => {
    const nextWhen = {};
    for (const [k, v] of Object.entries(r.when || {})) {
      if (k === oldName) nextWhen[nextName] = v;
      else nextWhen[k] = v;
    }
    return { ...r, when: nextWhen };
  });
  return { ...norm, inputsJson: nextInputs, rulesJson: nextRules };
}

function removeInputColumn(table, index) {
  const norm = normalizeDmnTable(table);
  if (norm.inputsJson.length <= 1 || index < 0 || index >= norm.inputsJson.length) return norm;
  const removedName = norm.inputsJson[index].name;
  return {
    ...norm,
    inputsJson: norm.inputsJson.filter((_, i) => i !== index),
    rulesJson: norm.rulesJson.map((r) => {
      const nextWhen = {};
      for (const [k, v] of Object.entries(r.when || {})) {
        if (k !== removedName) nextWhen[k] = v;
      }
      return { ...r, when: nextWhen };
    }),
  };
}

function addOutputColumn(table, col = {}) {
  const norm = normalizeDmnTable(table);
  const rawName = String(col.name || '').trim();
  const name = rawName && !FORBIDDEN_KEYS.has(rawName)
    ? uniqueColumnName(norm.outputsJson, rawName)
    : uniqueColumnName(norm.outputsJson, 'output');
  const type = ALLOWED_COL_TYPES.includes(col.type) ? col.type : 'string';
  return {
    ...norm,
    outputsJson: [...norm.outputsJson, { name, type, ...(col.label ? { label: String(col.label) } : {}) }],
    rulesJson: norm.rulesJson.map((r) => ({
      ...r,
      then: { ...r.then, [name]: '' },
    })),
  };
}

function updateOutputColumn(table, index, patch = {}) {
  const norm = normalizeDmnTable(table);
  const target = norm.outputsJson[index];
  if (!target) return norm;
  const oldName = target.name;
  const nextNameRaw = typeof patch.name === 'string' ? patch.name.trim() : oldName;
  const nextName = nextNameRaw && !FORBIDDEN_KEYS.has(nextNameRaw) ? nextNameRaw : oldName;
  const nextType = patch.type && ALLOWED_COL_TYPES.includes(patch.type) ? patch.type : target.type;
  const nextOutputs = norm.outputsJson.map((c, i) => (i === index ? { ...c, name: nextName, type: nextType } : c));
  const nextRules = norm.rulesJson.map((r) => {
    const nextThen = {};
    for (const [k, v] of Object.entries(r.then || {})) {
      if (k === oldName) nextThen[nextName] = v;
      else nextThen[k] = v;
    }
    return { ...r, then: nextThen };
  });
  return { ...norm, outputsJson: nextOutputs, rulesJson: nextRules };
}

function removeOutputColumn(table, index) {
  const norm = normalizeDmnTable(table);
  if (norm.outputsJson.length <= 1 || index < 0 || index >= norm.outputsJson.length) return norm;
  const removedName = norm.outputsJson[index].name;
  return {
    ...norm,
    outputsJson: norm.outputsJson.filter((_, i) => i !== index),
    rulesJson: norm.rulesJson.map((r) => {
      const nextThen = {};
      for (const [k, v] of Object.entries(r.then || {})) {
        if (k !== removedName) nextThen[k] = v;
      }
      return { ...r, then: nextThen };
    }),
  };
}

function addRuleRow(table, seedRule = {}) {
  const norm = normalizeDmnTable(table);
  const when = {};
  for (const col of norm.inputsJson) {
    when[col.name] = seedRule.when?.[col.name] ? parseFeelCell(seedRule.when[col.name]) : { op: 'any', value: null };
  }
  const then = {};
  for (const col of norm.outputsJson) {
    then[col.name] = seedRule.then?.[col.name] ?? '';
  }
  return {
    ...norm,
    rulesJson: [
      ...norm.rulesJson,
      {
        when,
        then,
        ...(seedRule.description ? { description: String(seedRule.description) } : {}),
      },
    ],
  };
}

function updateRuleCell(table, ruleIndex, kind, colName, rawValue) {
  const norm = normalizeDmnTable(table);
  if (ruleIndex < 0 || ruleIndex >= norm.rulesJson.length || FORBIDDEN_KEYS.has(colName)) return norm;
  const nextRules = norm.rulesJson.map((rule, idx) => {
    if (idx !== ruleIndex) return rule;
    if (kind === 'when') {
      return {
        ...rule,
        when: { ...rule.when, [colName]: parseFeelCell(rawValue) },
      };
    }
    return {
      ...rule,
      then: { ...rule.then, [colName]: parseOutputCell(rawValue) },
    };
  });
  return { ...norm, rulesJson: nextRules };
}

function updateRuleMeta(table, ruleIndex, patch = {}) {
  const norm = normalizeDmnTable(table);
  if (ruleIndex < 0 || ruleIndex >= norm.rulesJson.length) return norm;
  const nextRules = norm.rulesJson.map((rule, idx) => {
    if (idx !== ruleIndex) return rule;
    const next = { ...rule };
    if (typeof patch.description === 'string') {
      if (patch.description.trim()) next.description = patch.description.trim();
      else delete next.description;
    }
    if (patch.priority !== undefined) {
      const p = Number(patch.priority);
      if (Number.isFinite(p)) next.priority = p;
      else delete next.priority;
    }
    return next;
  });
  return { ...norm, rulesJson: nextRules };
}

function deleteRuleRow(table, ruleIndex) {
  const norm = normalizeDmnTable(table);
  if (ruleIndex < 0 || ruleIndex >= norm.rulesJson.length) return norm;
  return {
    ...norm,
    rulesJson: norm.rulesJson.filter((_, idx) => idx !== ruleIndex),
  };
}

function valuesEqual(a, b) {
  const na = a === '' || a === null || a === undefined ? NaN : Number(a);
  const nb = b === '' || b === null || b === undefined ? NaN : Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
  return a === b;
}

function matchDmnCondition(actual, rawSpec) {
  const spec = parseFeelCell(rawSpec);
  const op = spec.op;
  if (op === 'any' || op === '*') return true;
  if (op === 'eq' || op === '==' || op === '===') return valuesEqual(actual, spec.value);
  if (op === 'neq' || op === '!=' || op === '!==') return !valuesEqual(actual, spec.value);
  if (['gt', '>', 'gte', '>=', 'lt', '<', 'lte', '<='].includes(op)) {
    const aNum = actual === '' || actual === null || actual === undefined ? NaN : Number(actual);
    const eNum = Number(spec.value);
    if (!Number.isFinite(aNum) || !Number.isFinite(eNum)) return false;
    if (op === 'gt' || op === '>') return aNum > eNum;
    if (op === 'gte' || op === '>=') return aNum >= eNum;
    if (op === 'lt' || op === '<') return aNum < eNum;
    return aNum <= eNum;
  }
  if (op === 'between' && Array.isArray(spec.value) && spec.value.length === 2) {
    const aNum = actual === '' || actual === null || actual === undefined ? NaN : Number(actual);
    if (!Number.isFinite(aNum)) return false;
    return aNum >= Number(spec.value[0]) && aNum <= Number(spec.value[1]);
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

function simulateDmnTable(table, context = {}) {
  const norm = normalizeDmnTable(table);
  const ctxObj = context && typeof context === 'object' && !Array.isArray(context) ? context : {};
  const allMatches = [];

  for (let i = 0; i < norm.rulesJson.length; i += 1) {
    const rule = norm.rulesJson[i];
    const when = rule.when || {};
    let isMatch = true;
    for (const [key, cond] of Object.entries(when)) {
      if (FORBIDDEN_KEYS.has(key)) {
        isMatch = false;
        break;
      }
      const actual = Object.prototype.hasOwnProperty.call(ctxObj, key) ? ctxObj[key] : undefined;
      if (!matchDmnCondition(actual, cond)) {
        isMatch = false;
        break;
      }
    }
    if (isMatch) {
      allMatches.push({
        ruleIndex: i,
        outputs: rule.then || {},
        priority: Number.isFinite(Number(rule.priority)) ? Number(rule.priority) : 0,
        ...(rule.description ? { description: rule.description } : {}),
      });
    }
  }

  const hp = norm.hitPolicy;
  if (hp === 'COLLECT') {
    return {
      hitPolicy: hp,
      matched: allMatches.length > 0,
      matchedRuleIndex: allMatches[0]?.ruleIndex ?? -1,
      matchedRuleIndices: allMatches.map((m) => m.ruleIndex),
      results: allMatches.map((m) => m.outputs),
      matchedRules: allMatches,
      conflict: false,
    };
  }

  if (hp === 'PRIORITY' && allMatches.length > 0) {
    const sorted = allMatches.slice().sort((a, b) => b.priority - a.priority || a.ruleIndex - b.ruleIndex);
    const winner = sorted[0];
    return {
      hitPolicy: hp,
      matched: true,
      matchedRuleIndex: winner.ruleIndex,
      matchedRuleIndices: [winner.ruleIndex],
      result: winner.outputs,
      outputs: winner.outputs,
      matchedRules: [winner],
      conflict: false,
    };
  }

  if (hp === 'UNIQUE') {
    const conflict = allMatches.length > 1;
    const first = allMatches[0] || null;
    return {
      hitPolicy: hp,
      matched: allMatches.length === 1,
      matchedRuleIndex: first && !conflict ? first.ruleIndex : -1,
      matchedRuleIndices: conflict ? allMatches.map((m) => m.ruleIndex) : (first ? [first.ruleIndex] : []),
      result: first && !conflict ? first.outputs : null,
      outputs: first && !conflict ? first.outputs : null,
      matchedRules: allMatches,
      conflict,
    };
  }

  // FIRST
  const first = allMatches[0] || null;
  return {
    hitPolicy: hp,
    matched: Boolean(first),
    matchedRuleIndex: first ? first.ruleIndex : -1,
    matchedRuleIndices: first ? [first.ruleIndex] : [],
    result: first ? first.outputs : null,
    outputs: first ? first.outputs : null,
    matchedRules: first ? [first] : [],
    conflict: false,
  };
}

function extractMatchedIndices(evalResult) {
  if (!evalResult) return [];
  if (Array.isArray(evalResult.matchedRuleIndices)) return evalResult.matchedRuleIndices;
  if (Array.isArray(evalResult.matchedRules) && evalResult.matchedRules.length) {
    return evalResult.matchedRules
      .map((m) => m?.ruleIndex)
      .filter((idx) => Number.isInteger(idx) && idx >= 0);
  }
  if (Number.isInteger(evalResult.matchedRuleIndex) && evalResult.matchedRuleIndex >= 0) {
    return [evalResult.matchedRuleIndex];
  }
  return [];
}

function buildInitialSimContext(table) {
  const ctx = {};
  for (const col of table?.inputsJson || []) {
    if (col?.name) {
      ctx[col.name] = col.type === 'number' ? 0 : col.type === 'boolean' ? false : '';
    }
  }
  return ctx;
}

function editorStyles() {
  return {
    root: { display: 'grid', gap: 12, padding: 14, borderRadius: 10, border: '1px solid #cbd5e1', background: '#ffffff' },
    header: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 10, alignItems: 'end' },
    toolbar: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'space-between' },
    label: { display: 'block', fontSize: 11, fontWeight: 600, color: '#475569', marginBottom: 4 },
    input: { width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 12, boxSizing: 'border-box' },
    cellInput: { width: '100%', minWidth: 130, padding: '5px 7px', borderRadius: 4, border: '1px solid #cbd5e1', fontSize: 12, fontFamily: 'monospace', boxSizing: 'border-box', background: '#ffffff' },
    tableWrap: { width: '100%', maxWidth: '100%', overflowX: 'auto', border: '1px solid #e2e8f0', borderRadius: 8 },
    table: { width: 'max-content', minWidth: '100%', borderCollapse: 'collapse', fontSize: 12 },
    thInput: { textAlign: 'left', padding: '7px 8px', background: '#eff6ff', borderBottom: '2px solid #bfdbfe', color: '#1e3a8a', minWidth: 210 },
    thOutput: { textAlign: 'left', padding: '7px 8px', background: '#f0fdf4', borderBottom: '2px solid #bbf7d0', color: '#14532d', minWidth: 170 },
    thMeta: { textAlign: 'left', padding: '7px 8px', background: '#f8fafc', borderBottom: '2px solid #e2e8f0', color: '#475569', whiteSpace: 'nowrap' },
    td: { padding: '6px 8px', borderBottom: '1px solid #f1f5f9', verticalAlign: 'middle', minWidth: 155 },
    btn: (primary = false, danger = false, disabled = false) => ({
      padding: '6px 11px',
      borderRadius: 6,
      cursor: disabled ? 'not-allowed' : 'pointer',
      fontSize: 12,
      fontWeight: 600,
      border: disabled ? '1px solid #cbd5e1' : danger ? '1px solid #dc2626' : primary ? '1px solid #1677ff' : '1px solid #cbd5e1',
      background: disabled ? '#e2e8f0' : danger ? '#dc2626' : primary ? '#1677ff' : '#ffffff',
      color: disabled ? '#94a3b8' : (primary || danger) ? '#ffffff' : '#1e293b',
      whiteSpace: 'nowrap',
    }),
    simPanel: { padding: 12, borderRadius: 8, border: '1px solid #e2e8f0', background: '#f8fafc', display: 'grid', gap: 10 },
  };
}

function createDmnVisualEditor(ReactLib, antdLib) {
  const React = ReactLib;
  const h = React.createElement;
  const S = editorStyles();
  const AntButton = antdLib?.Button || null;

  return function DmnVisualEditorInstance(props = {}) {
    const initialNorm = React.useMemo(
      () => normalizeDmnTable(props.table || props.initialTable || {}),
      [props.table, props.initialTable?.tableKey, props.initialTable?.version],
    );
    const [table, setTable] = React.useState(() => initialNorm);
    const [draftCells, setDraftCells] = React.useState({});
    const [simContext, setSimContext] = React.useState(() => buildInitialSimContext(initialNorm));
    const [simJsonText, setSimJsonText] = React.useState(() => JSON.stringify(buildInitialSimContext(initialNorm), null, 2));
    const [simResult, setSimResult] = React.useState(null);
    const [simValidation, setSimValidation] = React.useState(null);
    const [statusMsg, setStatusMsg] = React.useState(null);
    const [busy, setBusy] = React.useState(false);

    React.useEffect(() => {
      if (props.table) {
        const next = normalizeDmnTable(props.table);
        const nextCtx = buildInitialSimContext(next);
        setTable(next);
        setSimContext(nextCtx);
        setSimJsonText(JSON.stringify(nextCtx, null, 2));
        setSimResult(null);
        setSimValidation(null);
      }
    }, [props.table]);

    const commitTable = (updater) => {
      setTable((prev) => {
        const next = typeof updater === 'function' ? updater(prev) : updater;
        if (typeof props.onChange === 'function') props.onChange(next);
        return next;
      });
    };

    const matchedIndices = extractMatchedIndices(simResult);
    const matchedSet = new Set(matchedIndices);
    const isBusy = Boolean(props.busy || busy);

    const renderBtn = (btnProps, label) => {
      if (AntButton) {
        return h(AntButton, {
          ...btnProps,
          type: btnProps['data-variant'] === 'primary' ? 'primary' : 'default',
          danger: Boolean(btnProps['data-danger']),
          size: 'small',
        }, label);
      }
      return h('button', { type: 'button', ...btnProps }, label);
    };

    const handleCellChange = (rIdx, kind, colName, rawVal) => {
      const key = `${kind}:${rIdx}:${colName}`;
      setDraftCells((prev) => ({ ...prev, [key]: rawVal }));
      commitTable((prev) => updateRuleCell(prev, rIdx, kind, colName, rawVal));
    };

    const handleCellBlur = (rIdx, kind, colName) => {
      const key = `${kind}:${rIdx}:${colName}`;
      setDraftCells((prev) => {
        if (!Object.prototype.hasOwnProperty.call(prev, key)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
    };

    const handleSimFieldChange = (colName, rawVal, colType) => {
      let parsed = rawVal;
      if (colType === 'number') {
        parsed = rawVal === '' ? '' : (Number.isFinite(Number(rawVal)) ? Number(rawVal) : rawVal);
      } else if (colType === 'boolean') {
        parsed = rawVal === 'true' || rawVal === true;
      }
      setSimContext((prev) => {
        const next = { ...prev, [colName]: parsed };
        setSimJsonText(JSON.stringify(next, null, 2));
        return next;
      });
    };

    const handleSimJsonChange = (rawText) => {
      setSimJsonText(rawText);
      try {
        const parsed = JSON.parse(rawText);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          setSimContext(parsed);
        }
      } catch {
        // Keep text editable while user types JSON
      }
    };

    const runSimulation = async () => {
      let evalCtx = simContext;
      try {
        const parsed = JSON.parse(simJsonText);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          evalCtx = parsed;
        }
      } catch {
        setSimValidation('Context JSON mô phỏng không hợp lệ.');
        setStatusMsg({ type: 'error', text: 'Context JSON mô phỏng không hợp lệ.' });
        return;
      }

      const inputs = Array.isArray(table.inputsJson) ? table.inputsJson : [];
      const strCols = inputs.filter((col) => (col?.type || 'string') === 'string' && col?.name);
      const missingStringCols = strCols
        .filter((col) => evalCtx[col.name] === undefined || evalCtx[col.name] === null || String(evalCtx[col.name]).trim() === '')
        .map((col) => col.name);
      const hasActiveOtherInput = inputs.some((col) => {
        if (!col?.name || (col?.type || 'string') === 'string') return false;
        const val = evalCtx[col.name];
        if (col.type === 'number') return val !== '' && val !== null && val !== undefined && Number.isFinite(Number(val));
        if (col.type === 'boolean') return Boolean(val) === true;
        return val !== undefined && val !== null && String(val).trim() !== '';
      });
      if (strCols.length && missingStringCols.length === strCols.length && !hasActiveOtherInput) {
        const msg = `Vui lòng nhập giá trị cho trường đầu vào: ${missingStringCols.join(', ')}.`;
        setSimValidation(msg);
        setStatusMsg({ type: 'error', text: msg });
        return;
      }

      setBusy(true);
      setSimValidation(null);
      setStatusMsg(null);
      try {
        let res;
        if (typeof props.onEvaluate === 'function') {
          res = await props.onEvaluate({ tableKey: table.tableKey, context: evalCtx, table });
        } else if (props.api?.request) {
          const apiRes = await props.api.request({
            url: 'dxosDmn:evaluate',
            method: 'post',
            data: {
              ...(props.organizationId ? { organizationId: props.organizationId } : {}),
              tableKey: table.tableKey,
              context: evalCtx,
            },
          });
          res = unwrapData(apiRes);
        } else {
          res = simulateDmnTable(table, evalCtx);
        }
        setSimResult(res || simulateDmnTable(table, evalCtx));
      } catch (err) {
        const msg = extractError(err, 'Không mô phỏng được bảng quyết định DMN.');
        setSimValidation(msg);
        setStatusMsg({ type: 'error', text: msg });
      } finally {
        setBusy(false);
      }
    };

    const handleSave = async () => {
      const payload = {
        ...(props.organizationId ? { organizationId: props.organizationId } : {}),
        tableKey: table.tableKey,
        name: table.name,
        description: table.description,
        hitPolicy: table.hitPolicy,
        inputsJson: table.inputsJson,
        outputsJson: table.outputsJson,
        rulesJson: table.rulesJson,
      };
      setBusy(true);
      setStatusMsg(null);
      try {
        if (typeof props.onSave === 'function') {
          await props.onSave(payload);
        } else if (props.api?.request) {
          await props.api.request({
            url: 'dxosDmn:saveTable',
            method: 'post',
            data: payload,
          });
        }
        setStatusMsg({ type: 'success', text: `Đã lưu bảng DMN "${table.tableKey}".` });
      } catch (err) {
        setStatusMsg({ type: 'error', text: extractError(err, 'Không lưu được bảng quyết định DMN.') });
      } finally {
        setBusy(false);
      }
    };

    return h('div', { 'data-testid': 'dmn-visual-editor', style: S.root },
      h('div', { style: S.header },
        h('div', null,
          h('label', { style: S.label }, 'Mã Bảng'),
          h('input', {
            'data-testid': 'dmn-table-key-input',
            type: 'text',
            value: table.tableKey,
            title: table.tableKey,
            onChange: (e) => commitTable((p) => ({ ...p, tableKey: e.target.value })),
            style: S.input,
          }),
        ),
        h('div', { style: { gridColumn: 'span 2', minWidth: 230 } },
          h('label', { style: S.label }, 'Tên Bảng Quyết Định'),
          h('input', {
            'data-testid': 'dmn-table-name-input',
            type: 'text',
            value: table.name,
            title: table.name,
            onChange: (e) => commitTable((p) => ({ ...p, name: e.target.value })),
            style: { ...S.input, minWidth: 230 },
          }),
        ),
        h('div', null,
          h('label', { style: S.label }, 'Chính sách khớp'),
          h('select', {
            'data-testid': 'dmn-hit-policy-select',
            value: table.hitPolicy,
            onChange: (e) => commitTable((p) => ({ ...p, hitPolicy: e.target.value })),
            style: S.input,
          }, HIT_POLICIES.map((hp) => h('option', { key: hp, value: hp }, hp))),
        ),
        h('div', { style: { display: 'flex', justifyContent: 'flex-end' } },
          renderBtn({
            'data-testid': 'dmn-save-btn',
            'data-variant': 'primary',
            disabled: isBusy,
            onClick: handleSave,
            style: S.btn(true, false, isBusy),
          }, isBusy ? 'Đang lưu…' : 'Lưu Bảng DMN'),
        ),
      ),

      statusMsg ? h('div', {
        'data-testid': 'dmn-status-banner',
        role: 'status',
        style: {
          padding: '8px 10px',
          borderRadius: 6,
          fontSize: 12,
          background: statusMsg.type === 'error' ? '#fef2f2' : '#f0fdf4',
          border: `1px solid ${statusMsg.type === 'error' ? '#fecaca' : '#bbf7d0'}`,
          color: statusMsg.type === 'error' ? '#991b1b' : '#166534',
        },
      }, statusMsg.text) : null,

      h('div', { style: S.toolbar },
        h('div', { style: { fontSize: 12, color: '#475569' } },
          'Cú pháp FEEL: ',
          h('code', null, '< 10'), ', ',
          h('code', null, '[0..8]'), ', ',
          h('code', null, '>= 100'), ', ',
          h('code', null, 'critical'), ' (hoặc ',
          h('code', null, '"GOLD"'), '), ',
          h('code', null, '*'), ' / ',
          h('code', null, '-'),
        ),
        h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
          renderBtn({
            'data-testid': 'dmn-add-input-btn',
            onClick: () => commitTable((p) => addInputColumn(p)),
            style: S.btn(false),
          }, '+ Cột Input'),
          renderBtn({
            'data-testid': 'dmn-add-output-btn',
            onClick: () => commitTable((p) => addOutputColumn(p)),
            style: S.btn(false),
          }, '+ Cột Output'),
          renderBtn({
            'data-testid': 'dmn-add-rule-btn',
            onClick: () => commitTable((p) => addRuleRow(p)),
            style: S.btn(false),
          }, '+ Thêm Luật'),
        ),
      ),

      h('div', { style: S.tableWrap },
        h('table', { 'data-testid': 'dmn-decision-table-grid', style: S.table },
          h('thead', null,
            h('tr', null,
              h('th', { style: { ...S.thMeta, minWidth: 44 } }, '#'),
              table.inputsJson.map((col, idx) => h('th', { key: `in-${idx}`, style: S.thInput },
                h('div', { style: { display: 'flex', gap: 4, alignItems: 'center' } },
                  h('input', {
                    'data-testid': `dmn-input-col-name-${idx}`,
                    type: 'text',
                    value: col.name,
                    title: col.name,
                    onChange: (e) => commitTable((p) => updateInputColumn(p, idx, { name: e.target.value })),
                    style: { ...S.cellInput, minWidth: 120, flex: '1 1 120px', fontWeight: 700, color: '#1e3a8a' },
                  }),
                  h('select', {
                    'data-testid': `dmn-input-col-type-${idx}`,
                    value: col.type || 'string',
                    onChange: (e) => commitTable((p) => updateInputColumn(p, idx, { type: e.target.value })),
                    style: { padding: '4px', fontSize: 11, borderRadius: 4, border: '1px solid #bfdbfe', flexShrink: 0 },
                  }, ALLOWED_COL_TYPES.map((t) => h('option', { key: t, value: t }, t))),
                  table.inputsJson.length > 1 ? h('button', {
                    type: 'button',
                    'data-testid': `dmn-remove-input-${idx}`,
                    onClick: () => commitTable((p) => removeInputColumn(p, idx)),
                    style: { ...S.btn(false, true), flexShrink: 0 },
                  }, '×') : null,
                ),
              )),
              table.outputsJson.map((col, idx) => h('th', { key: `out-${idx}`, style: S.thOutput },
                h('div', { style: { display: 'flex', gap: 4, alignItems: 'center' } },
                  h('input', {
                    'data-testid': `dmn-output-col-name-${idx}`,
                    type: 'text',
                    value: col.name,
                    title: col.name,
                    onChange: (e) => commitTable((p) => updateOutputColumn(p, idx, { name: e.target.value })),
                    style: { ...S.cellInput, minWidth: 125, flex: '1 1 125px', fontWeight: 700, color: '#14532d' },
                  }),
                  table.outputsJson.length > 1 ? h('button', {
                    type: 'button',
                    'data-testid': `dmn-remove-output-${idx}`,
                    onClick: () => commitTable((p) => removeOutputColumn(p, idx)),
                    style: { ...S.btn(false, true), flexShrink: 0 },
                  }, '×') : null,
                ),
              )),
              h('th', { style: { ...S.thMeta, minWidth: 160 } }, 'Mô tả'),
              h('th', { style: { ...S.thMeta, minWidth: 64 } }, 'Xóa'),
            ),
          ),
          h('tbody', null,
            table.rulesJson.length === 0
              ? h('tr', null, h('td', { colSpan: table.inputsJson.length + table.outputsJson.length + 3, style: { ...S.td, color: '#64748b' } }, 'Chưa có luật nào. Nhấn "+ Thêm Luật" để tạo.'))
              : table.rulesJson.map((rule, rIdx) => {
                const isMatched = matchedSet.has(rIdx);
                const rowStyle = isMatched ? { background: '#dcfce7', outline: '2px solid #16a34a' } : undefined;
                return h('tr', {
                  key: `rule-${rIdx}`,
                  'data-testid': `dmn-rule-row-${rIdx}`,
                  'data-matched': isMatched ? 'true' : 'false',
                  style: rowStyle,
                },
                  h('td', { style: { ...S.td, fontWeight: 700, color: isMatched ? '#166534' : '#475569' } },
                    `${rIdx + 1}`,
                    isMatched ? h('span', { style: { marginLeft: 4, padding: '1px 5px', borderRadius: 999, background: '#16a34a', color: '#fff', fontSize: 10 } }, 'KHỚP') : null,
                  ),
                  table.inputsJson.map((col) => {
                    const key = `when:${rIdx}:${col.name}`;
                    const displayVal = Object.prototype.hasOwnProperty.call(draftCells, key)
                      ? draftCells[key]
                      : formatFeelCell(rule.when?.[col.name]);
                    return h('td', { key: `w-${col.name}`, style: S.td },
                      h('input', {
                        'data-testid': `dmn-cell-when-${rIdx}-${col.name}`,
                        type: 'text',
                        value: displayVal,
                        placeholder: '-',
                        onChange: (e) => handleCellChange(rIdx, 'when', col.name, e.target.value),
                        onBlur: () => handleCellBlur(rIdx, 'when', col.name),
                        style: S.cellInput,
                      }),
                    );
                  }),
                  table.outputsJson.map((col) => {
                    const key = `then:${rIdx}:${col.name}`;
                    const displayVal = Object.prototype.hasOwnProperty.call(draftCells, key)
                      ? draftCells[key]
                      : formatOutputCell(rule.then?.[col.name]);
                    return h('td', { key: `t-${col.name}`, style: S.td },
                      h('input', {
                        'data-testid': `dmn-cell-then-${rIdx}-${col.name}`,
                        type: 'text',
                        value: displayVal,
                        onChange: (e) => handleCellChange(rIdx, 'then', col.name, e.target.value),
                        onBlur: () => handleCellBlur(rIdx, 'then', col.name),
                        style: S.cellInput,
                      }),
                    );
                  }),
                  h('td', { style: { ...S.td, minWidth: 160 } },
                    h('input', {
                      'data-testid': `dmn-rule-desc-${rIdx}`,
                      type: 'text',
                      value: rule.description || '',
                      placeholder: 'Ghi chú luật',
                      onChange: (e) => commitTable((p) => updateRuleMeta(p, rIdx, { description: e.target.value })),
                      style: { ...S.input, minWidth: 160 },
                    }),
                  ),
                  h('td', { style: S.td },
                    h('button', {
                      type: 'button',
                      'data-testid': `dmn-delete-rule-${rIdx}`,
                      onClick: () => commitTable((p) => deleteRuleRow(p, rIdx)),
                      style: S.btn(false, true),
                    }, 'Xóa'),
                  ),
                );
              }),
          ),
        ),
      ),

      h('div', { 'data-testid': 'dmn-simulator-panel', style: S.simPanel },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('strong', { style: { fontSize: 13, color: '#0f172a' } }, 'Trình Mô Phỏng Luật DMN'),
          renderBtn({
            'data-testid': 'dmn-sim-run-btn',
            'data-variant': 'primary',
            disabled: isBusy,
            onClick: runSimulation,
            style: S.btn(true, false, isBusy),
          }, 'Chạy Mô Phỏng'),
        ),
        simValidation ? h('div', {
          'data-testid': 'dmn-sim-validation',
          role: 'alert',
          style: { padding: '8px 10px', borderRadius: 6, background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', fontSize: 12 },
        }, simValidation) : null,
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 } },
          table.inputsJson.map((col) => h('div', { key: `sim-${col.name}` },
            h('label', { style: S.label }, `${col.name} (${col.type || 'string'})`),
            col.type === 'boolean'
              ? h('select', {
                'data-testid': `dmn-sim-input-${col.name}`,
                value: String(Boolean(simContext[col.name])),
                onChange: (e) => handleSimFieldChange(col.name, e.target.value, 'boolean'),
                style: S.input,
              },
                h('option', { value: 'false' }, 'false'),
                h('option', { value: 'true' }, 'true'),
              )
              : h('input', {
                'data-testid': `dmn-sim-input-${col.name}`,
                type: col.type === 'number' ? 'number' : 'text',
                value: simContext[col.name] ?? '',
                onChange: (e) => handleSimFieldChange(col.name, e.target.value, col.type),
                style: S.input,
              }),
          )),
        ),
        h('div', null,
          h('label', { style: S.label }, 'Dữ liệu Ngữ cảnh (JSON)'),
          h('textarea', {
            'data-testid': 'dmn-sim-json-input',
            rows: 3,
            value: simJsonText,
            onChange: (e) => handleSimJsonChange(e.target.value),
            style: { ...S.input, fontFamily: 'monospace' },
          }),
        ),
        simResult ? h('div', {
          'data-testid': 'dmn-sim-result',
          style: {
            padding: 10,
            borderRadius: 6,
            background: '#ffffff',
            border: `1px solid ${simResult.matched ? '#86efac' : '#cbd5e1'}`,
            fontSize: 12,
            display: 'grid',
            gap: 4,
          },
        },
          h('div', null,
            h('strong', null, `Khớp: ${simResult.matched ? 'CÓ' : 'KHÔNG'}`),
            ` · Chính sách: ${simResult.hitPolicy || table.hitPolicy}`,
            ` · Luật khớp: ${matchedIndices.length ? matchedIndices.map((i) => `#${i + 1}`).join(', ') : 'Không có'}`,
            simResult.conflict ? ' (XUNG ĐỘT: Vi phạm UNIQUE)' : '',
          ),
          h('pre', { style: { margin: 0, fontSize: 11, overflowX: 'auto' } },
            JSON.stringify(
              (simResult.hitPolicy || table.hitPolicy) === 'COLLECT'
                ? (simResult.results ?? simResult.matchedRules?.map((m) => m.outputs) ?? [])
                : (simResult.outputs ?? simResult.result ?? null),
              null,
              2,
            ),
          ),
        ) : null,
      ),
    );
  };
}

const _cachedEditorByReact = new WeakMap();

function DmnVisualEditor(props = {}) {
  const ReactLib = props.React || (typeof globalThis !== 'undefined' ? globalThis.React : null);
  if (!ReactLib || typeof ReactLib.createElement !== 'function') {
    throw new Error('DmnVisualEditor requires React via createDmnVisualEditor(React, antd) or props.React / globalThis.React');
  }
  const antdLib = props.antd || (typeof globalThis !== 'undefined' ? globalThis.antd : null);
  let Component = _cachedEditorByReact.get(ReactLib);
  if (!Component) {
    Component = createDmnVisualEditor(ReactLib, antdLib);
    _cachedEditorByReact.set(ReactLib, Component);
  }
  return Component(props);
}

module.exports = {
  HIT_POLICIES,
  ALLOWED_COL_TYPES,
  parseFeelCell,
  formatFeelCell,
  parseOutputCell,
  formatOutputCell,
  normalizeDmnTable,
  addInputColumn,
  updateInputColumn,
  removeInputColumn,
  addOutputColumn,
  updateOutputColumn,
  removeOutputColumn,
  addRuleRow,
  updateRuleCell,
  updateRuleMeta,
  deleteRuleRow,
  matchDmnCondition,
  simulateDmnTable,
  buildInitialSimContext,
  createDmnVisualEditor,
  DmnVisualEditor,
};
