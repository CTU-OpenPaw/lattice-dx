/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const DMN_EDITOR_PATH = path.join(PLUGIN_ROOT, 'src/client/dmn-visual-editor.js');

function collectNodes(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) collectNodes(item, pred, out);
    return out;
  }
  if (pred(node)) out.push(node);
  if (Array.isArray(node.children)) collectNodes(node.children, pred, out);
  return out;
}

function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && typeof node === 'object' && Array.isArray(node.children)) return textOf(node.children);
  return '';
}

function createReactHarness() {
  const statesByComponent = new WeakMap();
  const effectsByComponent = new WeakMap();
  const memosByComponent = new WeakMap();
  let currentComponent = null;
  let stateIdx = 0;
  let effectIdx = 0;
  let memoIdx = 0;
  const pendingEffects = [];

  function getBucket(map, comp) {
    let arr = map.get(comp);
    if (!arr) {
      arr = [];
      map.set(comp, arr);
    }
    return arr;
  }

  const React = {
    Fragment: 'Fragment',
    createElement(type, props, ...children) {
      const flat = [];
      for (const c of children) {
        if (Array.isArray(c)) flat.push(...c);
        else flat.push(c);
      }
      return { type, props: props || {}, children: flat };
    },
    useState(init) {
      const comp = currentComponent;
      const bucket = getBucket(statesByComponent, comp);
      const idx = stateIdx++;
      if (bucket.length <= idx) {
        bucket[idx] = typeof init === 'function' ? init() : init;
      }
      const setState = (next) => {
        bucket[idx] = typeof next === 'function' ? next(bucket[idx]) : next;
      };
      return [bucket[idx], setState];
    },
    useEffect(fn, deps) {
      const comp = currentComponent;
      const bucket = getBucket(effectsByComponent, comp);
      const idx = effectIdx++;
      const prev = bucket[idx];
      const changed = !prev || !Array.isArray(deps) || deps.length !== prev.deps?.length || deps.some((d, i) => !Object.is(d, prev.deps[i]));
      if (changed) {
        bucket[idx] = { deps: Array.isArray(deps) ? deps.slice() : null };
        pendingEffects.push(fn);
      }
    },
    useCallback(fn) {
      return fn;
    },
    useMemo(fn, deps) {
      const comp = currentComponent;
      const bucket = getBucket(memosByComponent, comp);
      const idx = memoIdx++;
      const prev = bucket[idx];
      const changed = !prev || !Array.isArray(deps) || deps.length !== prev.deps?.length || deps.some((d, i) => !Object.is(d, prev.deps[i]));
      if (changed) {
        bucket[idx] = { deps: Array.isArray(deps) ? deps.slice() : null, value: fn() };
      }
      return bucket[idx].value;
    },
  };

  function renderNode(node) {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(renderNode);
    if (typeof node.type === 'function') {
      const prevComp = currentComponent;
      const prevS = stateIdx;
      const prevE = effectIdx;
      const prevM = memoIdx;
      currentComponent = node.type;
      stateIdx = 0;
      effectIdx = 0;
      memoIdx = 0;
      let out;
      try {
        out = node.type(node.props || {});
      } finally {
        currentComponent = prevComp;
        stateIdx = prevS;
        effectIdx = prevE;
        memoIdx = prevM;
      }
      return renderNode(out);
    }
    if (Array.isArray(node.children)) {
      return { ...node, children: node.children.map(renderNode) };
    }
    return node;
  }

  async function mountAndFlush(ComponentFn, props = {}) {
    let tree = renderNode(React.createElement(ComponentFn, props));
    for (let pass = 0; pass < 6 && pendingEffects.length > 0; pass += 1) {
      const batch = pendingEffects.splice(0, pendingEffects.length);
      for (const eff of batch) await eff();
      await new Promise((resolve) => setImmediate(resolve));
      tree = renderNode(React.createElement(ComponentFn, props));
    }
    return tree;
  }

  return {
    React,
    render: (ComponentFn, props = {}) => renderNode(React.createElement(ComponentFn, props)),
    mountAndFlush,
  };
}

test('dmn-visual-editor.js obeys SPDX Apache-2.0, bundler external rules, and browser safety constraints', () => {
  const src = readFileSync(DMN_EDITOR_PATH, 'utf8');
  assert.ok(src.includes('@copyright (C) 2026 CTU-OpenPaw'));
  assert.ok(src.includes('SPDX-License-Identifier: Apache-2.0'));
  assert.equal(new RegExp('\\bco' + 'pilot\\b', 'i').test(src), false);
  assert.doesNotMatch(src, /require\(['"](?:react|antd|@nocobase\/client)['"]\)/);
  assert.doesNotMatch(src, /\blocalStorage\b|\bsessionStorage\b/);
  assert.doesNotMatch(src, /dangerouslySetInnerHTML/);
  assert.doesNotMatch(src, /\beval\s*\(|new\s+Function\b/);
});

test('FEEL cell parser/formatter and table mutation helpers round-trip expressions and manage columns/rules cleanly', () => {
  const {
    HIT_POLICIES,
    parseFeelCell,
    formatFeelCell,
    addInputColumn,
    removeInputColumn,
    addOutputColumn,
    removeOutputColumn,
    addRuleRow,
    updateRuleCell,
    deleteRuleRow,
    simulateDmnTable,
  } = require(DMN_EDITOR_PATH);

  assert.deepEqual(HIT_POLICIES, ['FIRST', 'UNIQUE', 'COLLECT', 'PRIORITY']);

  // FEEL parsing
  assert.deepEqual(parseFeelCell('-'), { op: 'any', value: null });
  assert.deepEqual(parseFeelCell('*'), { op: 'any', value: null });
  assert.deepEqual(parseFeelCell(''), { op: 'any', value: null });
  assert.deepEqual(parseFeelCell('< 10'), { op: 'lt', value: 10 });
  assert.deepEqual(parseFeelCell('<= 8.5'), { op: 'lte', value: 8.5 });
  assert.deepEqual(parseFeelCell('> 12'), { op: 'gt', value: 12 });
  assert.deepEqual(parseFeelCell('>= 100'), { op: 'gte', value: 100 });
  assert.deepEqual(parseFeelCell('[0..8]'), { op: 'between', value: [0, 8] });
  assert.deepEqual(parseFeelCell('[-20..-10]'), { op: 'between', value: [-20, -10] });
  assert.deepEqual(parseFeelCell('"GOLD"'), { op: 'eq', value: 'GOLD' });
  assert.deepEqual(parseFeelCell('!= "TEST"'), { op: 'neq', value: 'TEST' });
  assert.deepEqual(parseFeelCell('in ["cold_a", "cold_b"]'), { op: 'in', value: ['cold_a', 'cold_b'] });
  assert.deepEqual(parseFeelCell('contains "alarm"'), { op: 'contains', value: 'alarm' });
  assert.deepEqual(parseFeelCell('42'), { op: 'eq', value: 42 });

  // FEEL formatting round-trip
  assert.equal(formatFeelCell({ op: 'any', value: null }), '-');
  assert.equal(formatFeelCell({ op: 'lt', value: 10 }), '< 10');
  assert.equal(formatFeelCell({ op: 'gte', value: 100 }), '>= 100');
  assert.equal(formatFeelCell({ op: 'between', value: [0, 8] }), '[0..8]');
  assert.equal(formatFeelCell({ op: 'eq', value: 'GOLD' }), '"GOLD"');

  // Table column & rule manipulation
  let tbl = {
    tableKey: 'cold-chain-rule',
    name: 'Cold Chain Policy',
    hitPolicy: 'FIRST',
    inputsJson: [{ name: 'temperature', type: 'number' }],
    outputsJson: [{ name: 'action', type: 'string' }],
    rulesJson: [{ when: { temperature: { op: 'gt', value: 8 } }, then: { action: 'hold_mkt' } }],
  };

  tbl = addInputColumn(tbl, { name: 'tier', type: 'string' });
  assert.equal(tbl.inputsJson.length, 2);
  assert.deepEqual(tbl.rulesJson[0].when.tier, { op: 'any', value: null });

  tbl = addOutputColumn(tbl, { name: 'priority', type: 'number' });
  assert.equal(tbl.outputsJson.length, 2);

  tbl = addRuleRow(tbl);
  assert.equal(tbl.rulesJson.length, 2);

  tbl = updateRuleCell(tbl, 1, 'when', 'temperature', '[0..8]');
  tbl = updateRuleCell(tbl, 1, 'when', 'tier', '"GOLD"');
  tbl = updateRuleCell(tbl, 1, 'then', 'action', '"release"');
  tbl = updateRuleCell(tbl, 1, 'then', 'priority', '10');
  assert.deepEqual(tbl.rulesJson[1].when.temperature, { op: 'between', value: [0, 8] });
  assert.deepEqual(tbl.rulesJson[1].when.tier, { op: 'eq', value: 'GOLD' });
  assert.equal(tbl.rulesJson[1].then.action, 'release');
  assert.equal(tbl.rulesJson[1].then.priority, 10);

  // Local simulation across FIRST, COLLECT, UNIQUE, PRIORITY
  const simFirst = simulateDmnTable(tbl, { temperature: 4, tier: 'GOLD' });
  assert.equal(simFirst.matched, true);
  assert.equal(simFirst.matchedRuleIndex, 1);
  assert.deepEqual(simFirst.matchedRuleIndices, [1]);
  assert.equal(simFirst.outputs.action, 'release');

  const collectTbl = {
    ...tbl,
    hitPolicy: 'COLLECT',
    rulesJson: [
      { when: { temperature: { op: 'gte', value: 0 } }, then: { action: 'log' } },
      { when: { temperature: { op: 'between', value: [0, 8] } }, then: { action: 'release' } },
    ],
  };
  const simCollect = simulateDmnTable(collectTbl, { temperature: 5 });
  assert.equal(simCollect.matched, true);
  assert.deepEqual(simCollect.matchedRuleIndices, [0, 1]);
  assert.deepEqual(simCollect.results, [{ action: 'log' }, { action: 'release' }]);

  const uniqueConflict = simulateDmnTable({ ...collectTbl, hitPolicy: 'UNIQUE' }, { temperature: 5 });
  assert.equal(uniqueConflict.conflict, true);

  const prioritySim = simulateDmnTable({
    ...collectTbl,
    hitPolicy: 'PRIORITY',
    rulesJson: [
      { when: { temperature: { op: 'gte', value: 0 } }, then: { action: 'low' }, priority: 1 },
      { when: { temperature: { op: 'between', value: [0, 8] } }, then: { action: 'high' }, priority: 10 },
    ],
  }, { temperature: 5 });
  assert.equal(prioritySim.matchedRuleIndex, 1);
  assert.equal(prioritySim.outputs.action, 'high');

  // Remove column / delete rule
  tbl = removeInputColumn(tbl, 1);
  assert.equal(tbl.inputsJson.length, 1);
  assert.equal(Object.hasOwn(tbl.rulesJson[1].when, 'tier'), false);
  tbl = removeOutputColumn(tbl, 1);
  assert.equal(tbl.outputsJson.length, 1);
  tbl = deleteRuleRow(tbl, 0);
  assert.equal(tbl.rulesJson.length, 1);
});

test('DmnVisualEditor renders interactive grid, supports inline FEEL editing, column/rule CRUD, Live Test Simulator highlighting, and Save', async () => {
  const { DmnVisualEditor, createDmnVisualEditor } = require(DMN_EDITOR_PATH);
  assert.equal(typeof DmnVisualEditor, 'function');
  assert.equal(typeof createDmnVisualEditor, 'function');

  const harness = createReactHarness();
  const savedPayloads = [];
  const evalCalls = [];

  const initialTable = {
    tableKey: 'cold_triage',
    name: 'Cold Triage Rules',
    hitPolicy: 'FIRST',
    inputsJson: [
      { name: 'tempC', type: 'number' },
      { name: 'tier', type: 'string' },
    ],
    outputsJson: [
      { name: 'action', type: 'string' },
    ],
    rulesJson: [
      { when: { tempC: { op: 'lt', value: 10 }, tier: { op: 'eq', value: 'GOLD' } }, then: { action: 'priority_release' }, description: 'VIP cold' },
      { when: { tempC: { op: 'gte', value: 100 }, tier: { op: 'any', value: null } }, then: { action: 'quarantine' }, description: 'Overheat' },
    ],
  };

  const Editor = createDmnVisualEditor(harness.React, {});
  const props = {
    initialTable,
    onSave: async (payload) => {
      savedPayloads.push(payload);
      return { table: { ...payload, version: 2 } };
    },
    onEvaluate: async ({ tableKey, context, table }) => {
      evalCalls.push({ tableKey, context });
      // Return matched rule index 1 on tempC >= 100, else index 0 when tempC < 10 & tier === GOLD
      if (Number(context.tempC) >= 100) {
        return {
          tableKey,
          hitPolicy: table.hitPolicy,
          matched: true,
          matchedRuleIndex: 1,
          outputs: { action: 'quarantine' },
          matchedRules: [{ ruleIndex: 1, outputs: { action: 'quarantine' } }],
        };
      }
      return {
        tableKey,
        hitPolicy: table.hitPolicy,
        matched: true,
        matchedRuleIndex: 0,
        outputs: { action: 'priority_release' },
        matchedRules: [{ ruleIndex: 0, outputs: { action: 'priority_release' } }],
      };
    },
  };

  let tree = await harness.mountAndFlush(Editor, props);

  // Hit policy selector has FIRST, UNIQUE, COLLECT, PRIORITY
  const hpSelect = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dmn-hit-policy-select')[0];
  assert.ok(hpSelect);
  const hpOptions = collectNodes(hpSelect, (n) => n.type === 'option').map((o) => o.props.value);
  assert.deepEqual(hpOptions, ['FIRST', 'UNIQUE', 'COLLECT', 'PRIORITY']);

  // Verify initial FEEL cell formatting in DOM inputs
  const cell0Temp = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dmn-cell-when-0-tempC')[0];
  const cell0Tier = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dmn-cell-when-0-tier')[0];
  const cell1Tier = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dmn-cell-when-1-tier')[0];
  assert.equal(cell0Temp.props.value, '< 10');
  assert.equal(cell0Tier.props.value, '"GOLD"');
  assert.equal(cell1Tier.props.value, '-');

  // Change hitPolicy to COLLECT, add an input column, add a rule, and edit inline FEEL cell
  hpSelect.props.onChange({ target: { value: 'COLLECT' } });
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dmn-add-rule-btn')[0].props.onClick();
  tree = harness.render(Editor, props);
  assert.equal(collectNodes(tree, (n) => String(n.props?.['data-testid'] || '').startsWith('dmn-rule-row-')).length, 3);

  const newTempCell = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dmn-cell-when-2-tempC')[0];
  newTempCell.props.onChange({ target: { value: '[0..8]' } });
  newTempCell.props.onBlur?.({ target: { value: '[0..8]' } });
  const newActionCell = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dmn-cell-then-2-action')[0];
  newActionCell.props.onChange({ target: { value: 'monitor' } });
  newActionCell.props.onBlur?.({ target: { value: 'monitor' } });
  tree = harness.render(Editor, props);

  // Add and remove input column
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dmn-add-input-btn')[0].props.onClick();
  tree = harness.render(Editor, props);
  assert.ok(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dmn-remove-input-2').length === 1);
  collectNodes(tree, (n) => n.props?.['data-testid'] === 'dmn-remove-input-2')[0].props.onClick();
  tree = harness.render(Editor, props);
  assert.equal(collectNodes(tree, (n) => n.props?.['data-testid'] === 'dmn-remove-input-2').length, 0);

  // Live Test Simulator: set tempC=105 and run simulation -> highlights rule row 1
  const simTempInput = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dmn-sim-input-tempC')[0];
  assert.ok(simTempInput);
  simTempInput.props.onChange({ target: { value: '105' } });
  tree = harness.render(Editor, props);
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dmn-sim-run-btn')[0].props.onClick();
  tree = harness.render(Editor, props);

  assert.equal(evalCalls.length, 1);
  assert.equal(evalCalls[0].tableKey, 'cold_triage');
  assert.equal(evalCalls[0].context.tempC, 105);

  const row0 = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dmn-rule-row-0')[0];
  const row1 = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dmn-rule-row-1')[0];
  assert.equal(row0.props['data-matched'], 'false');
  assert.equal(row1.props['data-matched'], 'true');

  const simResultBox = collectNodes(tree, (n) => n.props?.['data-testid'] === 'dmn-sim-result')[0];
  assert.ok(simResultBox);
  assert.ok(textOf(simResultBox).includes('quarantine'));

  // Save table via onSave
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dmn-save-btn')[0].props.onClick();
  assert.equal(savedPayloads.length, 1);
  assert.equal(savedPayloads[0].hitPolicy, 'COLLECT');
  assert.equal(savedPayloads[0].rulesJson.length, 3);
  assert.deepEqual(savedPayloads[0].rulesJson[2].when.tempC, { op: 'between', value: [0, 8] });
  assert.equal(savedPayloads[0].rulesJson[2].then.action, 'monitor');
});

test('DmnVisualEditor integrates with NocoBase api.request (dxosDmn:evaluate & dxosDmn:saveTable) when callbacks are omitted', async () => {
  const { DmnVisualEditor } = require(DMN_EDITOR_PATH);
  const harness = createReactHarness();
  const requests = [];
  const api = {
    async request(req) {
      requests.push(req);
      if (req.url === 'dxosDmn:evaluate') {
        return {
          data: {
            data: {
              tableKey: req.data.tableKey,
              hitPolicy: 'FIRST',
              matched: true,
              matchedRuleIndex: 0,
              outputs: { action: 'hold_mkt' },
              matchedRules: [{ ruleIndex: 0, outputs: { action: 'hold_mkt' } }],
            },
          },
        };
      }
      if (req.url === 'dxosDmn:saveTable') {
        return { data: { data: { table: { ...req.data, version: 3 } } } };
      }
      return { data: { data: {} } };
    },
  };

  let tree = await harness.mountAndFlush(DmnVisualEditor, {
    React: harness.React,
    api,
    organizationId: 'org-a',
    initialTable: {
      tableKey: 'cold_rule',
      name: 'Cold Rule',
      hitPolicy: 'FIRST',
      inputsJson: [{ name: 'temp', type: 'number' }],
      outputsJson: [{ name: 'action', type: 'string' }],
      rulesJson: [{ when: { temp: { op: 'gt', value: 8 } }, then: { action: 'hold_mkt' } }],
    },
  });

  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dmn-sim-run-btn')[0].props.onClick();
  tree = harness.render(DmnVisualEditor, { React: harness.React, api, organizationId: 'org-a' });
  await collectNodes(tree, (n) => n.props?.['data-testid'] === 'dmn-save-btn')[0].props.onClick();

  assert.ok(requests.some((r) => r.url === 'dxosDmn:evaluate' && r.data.organizationId === 'org-a' && r.data.tableKey === 'cold_rule'));
  assert.ok(requests.some((r) => r.url === 'dxosDmn:saveTable' && r.data.organizationId === 'org-a' && r.data.tableKey === 'cold_rule'));
});
