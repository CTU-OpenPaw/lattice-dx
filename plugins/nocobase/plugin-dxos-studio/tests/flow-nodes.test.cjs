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
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const STUDIO_SERVER_DIR = path.resolve(__dirname, '../src/server');
const FLOW_DIR = path.join(STUDIO_SERVER_DIR, 'flow');
const {
  createDefaultRegistry,
  registerNodeType,
  getNodeType,
  hasNodeType,
  listNodeSchemas,
} = require('../src/server/flow/registry');
const {
  resolveActiveLlmService,
  assertSafeLlmUrl,
  isMetadataTarget,
  redactPiiForLlm,
  callConfiguredLlm,
} = require('../src/server/flow/llm-client');

const EXPECTED_BUILTIN_TYPES = [
  'trigger.event',
  'trigger.record',
  'trigger.schedule',
  'trigger.webhook',
  'trigger.manual',
  'control.if',
  'control.switch',
  'control.parallel',
  'control.merge',
  'control.loop',
  'control.delay',
  'control.approval',
  'control.subflow',
  'data.query',
  'data.create',
  'data.update',
  'logic.dmn',
  'logic.transform',
  'ai.llm',
  'ai.agent',
  'integration.http',
  'iot.twin_command',
  'notify.send',
  'event.emit',
];

function makeMockDb(seed = {}) {
  const store = {};
  const seq = {};
  for (const [col, rows] of Object.entries(seed)) {
    store[col] = rows.map((r, i) => ({ id: r.id ?? i + 1, ...structuredClone(r) }));
    seq[col] = store[col].length + 1;
  }

  function matchRow(row, filter) {
    if (!filter || typeof filter !== 'object') return true;
    for (const [k, v] of Object.entries(filter)) {
      if (k === '$and' && Array.isArray(v)) {
        if (!v.every((sub) => matchRow(row, sub))) return false;
        continue;
      }
      if (k === '$or' && Array.isArray(v)) {
        if (!v.some((sub) => matchRow(row, sub))) return false;
        continue;
      }
      const actual = row?.[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
        if ('$in' in v && (!Array.isArray(v.$in) || !v.$in.includes(actual))) return false;
        if ('$ne' in v && actual === v.$ne) return false;
        if ('$gt' in v && !(Number(actual) > Number(v.$gt))) return false;
        if ('$gte' in v && !(Number(actual) >= Number(v.$gte))) return false;
        if ('$lt' in v && !(Number(actual) < Number(v.$lt))) return false;
        if ('$lte' in v && !(Number(actual) <= Number(v.$lte))) return false;
      } else if (actual !== v) {
        return false;
      }
    }
    return true;
  }

  return {
    store,
    _omitRepos: new Set(),
    getRepository(name) {
      if (this._omitRepos.has(name)) return null;
      if (!store[name]) {
        store[name] = [];
        seq[name] = 1;
      }
      return {
        async find({ filter = {}, limit = 200, offset = 0 } = {}) {
          return store[name]
            .filter((r) => matchRow(r, filter))
            .slice(offset, offset + limit)
            .map((r) => ({ ...r }));
        },
        async findOne({ filter = {}, filterByTk } = {}) {
          const eff = filterByTk !== undefined ? { id: filterByTk, ...filter } : filter;
          const found = store[name].find((r) => matchRow(r, eff));
          return found ? { ...found } : null;
        },
        async create({ values }) {
          const id = values.id ?? seq[name]++;
          const row = { id, createdAt: new Date(), updatedAt: new Date(), ...structuredClone(values) };
          store[name].push(row);
          return { ...row };
        },
        async update({ filter = {}, filterByTk, values }) {
          const eff = filterByTk !== undefined ? { id: filterByTk, ...filter } : filter;
          let count = 0;
          for (const row of store[name]) {
            if (matchRow(row, eff)) {
              Object.assign(row, structuredClone(values), { updatedAt: new Date() });
              count += 1;
            }
          }
          return [count];
        },
      };
    },
  };
}

function listJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

test('registry exposes all built-in nodes cleanly with schema metadata and zero domain leakage', async () => {
  const registry = createDefaultRegistry();
  const schemas = listNodeSchemas(registry);
  assert.ok(schemas.length >= 21, 'Expected at least 21 built-in node schemas');
  for (const expectedType of EXPECTED_BUILTIN_TYPES) {
    assert.equal(registry.hasNodeType(expectedType), true, `Missing node type ${expectedType}`);
    assert.equal(hasNodeType(expectedType), true, `Singleton missing node type ${expectedType}`);
    const def = registry.getNodeType(expectedType);
    assert.equal(typeof def.execute, 'function', `${expectedType} must have execute()`);
  }
  assert.equal(schemas.length, EXPECTED_BUILTIN_TYPES.length);

  for (const schema of schemas) {
    assert.equal(typeof schema.type, 'string');
    assert.ok(['trigger', 'control', 'data', 'logic', 'ai', 'integration'].includes(schema.category));
    assert.equal(typeof schema.label, 'string');
    assert.equal(typeof schema.description, 'string');
    assert.equal(typeof schema.icon, 'string');
    assert.equal(typeof schema.color, 'string');
    assert.ok(Array.isArray(schema.inputs));
    assert.ok(Array.isArray(schema.outputs) && schema.outputs.length > 0);
    assert.equal(typeof schema.defaultConfig, 'object');
    assert.ok(Array.isArray(schema.inputSchema?.fields));
    assert.equal(schema.execute, undefined, 'listNodeSchemas() must not expose execute function');
    if (schema.category === 'trigger') {
      assert.deepEqual(schema.inputs, []);
      assert.deepEqual(schema.outputs, ['main']);
    } else {
      assert.ok(schema.inputs.includes('in'));
      assert.ok(schema.outputs.includes('error'), `${schema.type} must support error handle`);
    }
  }

  // Custom plugin registration validation & isolation
  const isolated = createDefaultRegistry();
  assert.throws(() => isolated.registerNodeType({}), /INVALID_NODE_DEFINITION/);
  assert.throws(
    () => isolated.registerNodeType({ type: 'custom.bad', category: 'invalid', outputs: ['main'], execute: async () => ({}) }),
    /INVALID_NODE_DEFINITION/,
  );
  isolated.registerNodeType({
    type: 'integration.custom_echo',
    category: 'integration',
    label: 'Custom Echo',
    description: 'Echoes input payload',
    icon: 'ApiOutlined',
    color: '#722ed1',
    inputs: ['in'],
    outputs: ['main', 'error'],
    defaultConfig: {},
    inputSchema: { fields: [] },
    execute: async ({ input }) => ({ output: input, nextPort: 'main' }),
  });
  assert.equal(isolated.hasNodeType('integration.custom_echo'), true);
  assert.equal(hasNodeType('integration.custom_echo'), false, 'Custom plugin must stay isolated');
  assert.equal(typeof getNodeType('control.if').execute, 'function');

  // Verify global singleton registerNodeType works
  registerNodeType({
    type: 'logic.custom_noop',
    category: 'logic',
    label: 'Noop',
    description: 'Noop plugin',
    icon: 'NodeIndexOutlined',
    color: '#13c2c2',
    inputs: ['in'],
    outputs: ['main', 'error'],
    defaultConfig: {},
    inputSchema: { fields: [] },
    execute: async ({ input }) => ({ output: input, nextPort: 'main' }),
  });
  assert.equal(hasNodeType('logic.custom_noop'), true);

  // Hygiene, line count <= 350, header check, Tier 1 generality, zero banned branding/eval
  const headerHelperPath = path.resolve(__dirname, '../../../../scripts/source-headers.mjs');
  const { addSourceHeader } = await import(pathToFileURL(headerHelperPath).href);
  const ownedFlowFiles = [
    'security-helpers.js',
    'llm-client.js',
    'registry.js',
    'nodes/triggers.js',
    'nodes/control.js',
    'nodes/data.js',
    'nodes/logic.js',
    'nodes/ai.js',
    'nodes/integrations.js',
  ].map((rel) => path.join(FLOW_DIR, rel));
  const bannedTerm = ['co', 'pilot'].join('');
  const forbiddenRe = new RegExp(`\\b(?:${bannedTerm}|cold-?chain|vaccine|vắc-xin|cmms|freezer|tủ đông|mkt)\\b|\\beval\\s*\\(|\\bnew\\s+Function\\s*\\(`, 'i');
  for (const filePath of ownedFlowFiles) {
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split(/\r?\n/).length;
    const cap = path.basename(filePath) === 'security-helpers.js' ? 220 : 350;
    assert.ok(lines <= cap, `${path.relative(FLOW_DIR, filePath)} has ${lines} lines (> ${cap})`);
    assert.equal(forbiddenRe.test(raw), false, `Forbidden string found in ${path.relative(FLOW_DIR, filePath)}`);
    const hdr = addSourceHeader(raw, filePath);
    assert.equal(hdr.status, 'present', `Missing/invalid header in ${path.relative(FLOW_DIR, filePath)}`);
  }
});

test('trigger nodes normalize incoming payloads and emit main port', async () => {
  const reg = createDefaultRegistry();
  const triggerTypes = ['trigger.event', 'trigger.record', 'trigger.schedule', 'trigger.webhook', 'trigger.manual'];
  for (const t of triggerTypes) {
    const def = reg.getNodeType(t);
    const res = await def.execute({
      node: { id: 't1', type: t },
      config: def.defaultConfig,
      input: { type: t, data: { code: 'REQ-01', amount: 42 }, record: { id: 9, code: 'REQ-01' } },
      context: { organizationId: 'org-alpha' },
    });
    assert.equal(res.nextPort, 'main');
    assert.equal(res.output.type, t);
    assert.equal(res.output.data.code, 'REQ-01');
    assert.equal(res.output.record.id, 9);
    assert.ok(typeof res.output.timestamp === 'string' && res.output.timestamp.length > 0);
  }
});

test('control nodes handle branching, parallel/merge, loop cap, delay, approval HITL, and subflow recursion', async () => {
  const reg = createDefaultRegistry();

  // control.if
  const ifNode = reg.getNodeType('control.if');
  const ifTrue = await ifNode.execute({
    config: { condition: { field: 'priority', op: 'eq', value: 'high' } },
    context: { data: { priority: 'high' } },
  });
  assert.equal(ifTrue.nextPort, 'true');
  const ifFalse = await ifNode.execute({
    config: { condition: { field: 'priority', op: 'eq', value: 'high' } },
    context: { data: { priority: 'low' } },
  });
  assert.equal(ifFalse.nextPort, 'false');

  // control.switch
  const switchNode = reg.getNodeType('control.switch');
  const swMatch = await switchNode.execute({
    config: {
      expression: 'data.tier',
      cases: [
        { port: 'case_0', equals: 'gold' },
        { port: 'case_1', equals: 'silver' },
      ],
    },
    context: { data: { tier: 'gold' } },
  });
  assert.equal(swMatch.nextPort, 'case_0');
  const swDefault = await switchNode.execute({
    config: {
      expression: 'data.tier',
      cases: [{ port: 'case_0', equals: 'gold' }],
    },
    context: { data: { tier: 'bronze' } },
  });
  assert.equal(swDefault.nextPort, 'default');

  // control.parallel & control.merge
  const parallelRes = await reg.getNodeType('control.parallel').execute({ input: { x: 1 } });
  assert.equal(parallelRes.nextPort, 'main');
  const mergeRes = await reg.getNodeType('control.merge').execute({
    config: { mode: 'wait_all' },
    input: { branchA: { ok: true }, branchB: { score: 10 } },
  });
  assert.equal(mergeRes.nextPort, 'main');
  assert.deepEqual(mergeRes.output.merged, { ok: true, score: 10 });

  // control.loop cap 100
  const loopNode = reg.getNodeType('control.loop');
  await assert.rejects(
    () => loopNode.execute({ config: { itemsPath: 'data.items', maxIterations: 150 }, context: { data: { items: [1, 2] } } }),
    (err) => err.code === 'FLOW_LOOP_LIMIT_EXCEEDED',
  );
  const bigItems = Array.from({ length: 120 }, (_, i) => i + 1);
  await assert.rejects(
    () => loopNode.execute({ config: { itemsPath: 'data.items', maxIterations: 100, strictLimit: true }, context: { data: { items: bigItems } } }),
    (err) => err.code === 'FLOW_LOOP_LIMIT_EXCEEDED',
  );
  const loopRes = await loopNode.execute({
    config: { itemsPath: 'data.items', maxIterations: 5 },
    context: { data: { items: [10, 20, 30, 40, 50, 60] } },
  });
  assert.equal(loopRes.output.count, 5);
  assert.equal(loopRes.output.truncated, true);
  assert.deepEqual(loopRes.output.items, [10, 20, 30, 40, 50]);

  // control.loop checks evalCtx, evalCtx.input, and evalCtx.data for itemsPath
  const loopFromInput = await loopNode.execute({
    config: { itemsPath: 'items', maxIterations: 10 },
    input: { items: ['u1', 'u2'] },
    context: { organizationId: 'org-alpha', data: { batchId: 'b1' } },
  });
  assert.deepEqual(loopFromInput.output.items, ['u1', 'u2']);
  assert.equal(loopFromInput.nextPort, 'item');

  const loopFromData = await loopNode.execute({
    config: { itemsPath: 'items', maxIterations: 10 },
    input: { ok: true },
    context: { organizationId: 'org-alpha', data: { items: ['d1'] } },
  });
  assert.deepEqual(loopFromData.output.items, ['d1']);
  assert.equal(loopFromData.nextPort, 'item');

  // control.delay
  const delayNode = reg.getNodeType('control.delay');
  const delayLive = await delayNode.execute({ config: { durationSec: 30 }, options: {} });
  assert.equal(delayLive.suspend?.kind, 'delay');
  assert.ok(delayLive.suspend?.resumeAt);
  const delayDry = await delayNode.execute({ config: { durationSec: 30 }, options: { dryRun: true } });
  assert.equal(delayDry.output.delayed, true);
  assert.equal(delayDry.suspend, undefined);
  assert.equal(delayDry.nextPort, 'main');

  // control.approval
  const approvalNode = reg.getNodeType('control.approval');
  const db = makeMockDb();
  const approvalLive = await approvalNode.execute({
    node: { id: 'node_approval_1' },
    config: { approverRole: 'ldx_manager', title: 'Approve request', summary: 'Amount 500', riskLevel: 'high', ttlHours: 12 },
    context: { organizationId: 'org-alpha', runUid: 'run_123', actor: { userId: 7, username: 'alice' } },
    db,
    options: {},
  });
  assert.equal(approvalLive.suspend?.kind, 'approval');
  assert.equal(approvalLive.output.status, 'pending');
  assert.equal(db.store.latticeAiApprovalQueue.length, 1);
  assert.equal(db.store.latticeAiApprovalQueue[0].toolName, 'latticeflow.approval');
  assert.equal(db.store.latticeAiApprovalQueue[0].status, 'pending');
  assert.equal(db.store.latticeAiApprovalQueue[0].organizationId, 'org-alpha');

  const approvalDry = await approvalNode.execute({
    config: { approverRole: 'ldx_manager', title: 'Approve request' },
    context: { organizationId: 'org-alpha' },
    db,
    options: { dryRun: true },
  });
  assert.equal(approvalDry.nextPort, 'approved');
  assert.equal(approvalDry.output.status, 'simulated_approval');
  assert.equal(approvalDry.suspend, undefined);

  await assert.rejects(
    () => approvalNode.execute({
      config: { approverRole: 'ldx_manager', title: 'Missing org' },
      context: {},
      db,
      options: {},
    }),
    (err) => err.code === 'APPROVAL_ORG_REQUIRED' && err.status === 400,
  );
  await assert.rejects(
    () => approvalNode.execute({
      config: { approverRole: 'ldx_manager', title: 'Missing org dryRun' },
      context: {},
      db,
      options: { dryRun: true },
    }),
    (err) => err.code === 'APPROVAL_ORG_REQUIRED' && err.status === 400,
  );

  // control.subflow recursion guard
  const subflowNode = reg.getNodeType('control.subflow');
  await assert.rejects(
    () => subflowNode.execute({
      config: { ruleKey: 'child-flow' },
      context: { organizationId: 'org-alpha', depth: 8 },
      helpers: { executeSubflow: async () => ({ ok: true }) },
    }),
    (err) => err.code === 'RECURSION_DEPTH_LIMIT_EXCEEDED',
  );
  const subRes = await subflowNode.execute({
    config: { ruleKey: 'child-flow', payloadMapping: { ref: '{{data.code}}' } },
    context: { organizationId: 'org-alpha', depth: 2, data: { code: 'REQ-99' } },
    helpers: {
      executeSubflow: async (ruleKey, payload, meta) => ({ ruleKey, payload, depth: meta.depth }),
    },
  });
  assert.equal(subRes.nextPort, 'main');
  assert.equal(subRes.output.depth, 3);
  assert.deepEqual(subRes.output.result.payload, { ref: 'REQ-99' });
});

test('data nodes enforce organization isolation, voucher field protection, and block system tables', async () => {
  const reg = createDefaultRegistry();
  const queryNode = reg.getNodeType('data.query');
  const createNode = reg.getNodeType('data.create');
  const updateNode = reg.getNodeType('data.update');

  const db = makeMockDb({
    latticeRequests: [
      { id: 1, organizationId: 'org-a', code: 'R1', status: 'draft' },
      { id: 2, organizationId: 'org-b', code: 'R2', status: 'draft' },
    ],
    users: [{ id: 1, username: 'root' }],
    latticeConnectors: [{ id: 1, organizationId: 'org-a', connectorKey: 'hook' }],
  });

  // Forbidden collections blocked on all data nodes
  for (const blockedCol of ['users', 'latticeConnectors', 'llmServices', 'latticePkiKeys']) {
    await assert.rejects(
      () => queryNode.execute({ config: { collection: blockedCol }, context: { organizationId: 'org-a' }, db }),
      (err) => err.code === 'TARGET_COLLECTION_FORBIDDEN',
    );
    await assert.rejects(
      () => createNode.execute({ config: { collection: blockedCol, values: { a: 1 } }, context: { organizationId: 'org-a' }, db }),
      (err) => err.code === 'TARGET_COLLECTION_FORBIDDEN',
    );
    await assert.rejects(
      () => updateNode.execute({ config: { collection: blockedCol, filter: { id: 1 }, values: { a: 2 } }, context: { organizationId: 'org-a' }, db }),
      (err) => err.code === 'TARGET_COLLECTION_FORBIDDEN',
    );
  }

  // data.query enforces org isolation and limit clamping
  const qRes = await queryNode.execute({
    config: { collection: 'latticeRequests', filter: { organizationId: 'org-b' }, limit: 999 },
    context: { organizationId: 'org-a' },
    db,
  });
  assert.equal(qRes.nextPort, 'main');
  assert.equal(qRes.output.count, 1);
  assert.equal(qRes.output.items[0].organizationId, 'org-a');

  // data.create strips id, organizationId, and protected voucher status/version fields
  const cRes = await createNode.execute({
    config: {
      collection: 'latticeRequests',
      values: { id: 999, organizationId: 'org-evil', status: 'approved', version: 99, code: 'R3', name: 'New Req' },
    },
    context: { organizationId: 'org-a' },
    db,
  });
  assert.equal(cRes.nextPort, 'main');
  assert.equal(cRes.output.record.organizationId, 'org-a');
  assert.equal(cRes.output.record.status, undefined);
  assert.equal(cRes.output.record.version, undefined);
  assert.equal(cRes.output.record.code, 'R3');

  // data.update enforces org isolation, requires non-empty filter, and rejects empty target id before SQL
  await assert.rejects(
    () => updateNode.execute({ config: { collection: 'latticeRequests', filter: {}, values: { name: 'X' } }, context: { organizationId: 'org-a' }, db }),
    /non-empty filter/i,
  );
  let findCalledOnEmptyId = false;
  const guardDb = {
    getRepository: () => ({
      async find() { findCalledOnEmptyId = true; return []; },
      async update() { return []; },
    }),
  };
  for (const badId of ['', '   ', null, undefined]) {
    await assert.rejects(
      () => updateNode.execute({
        config: { collection: 'latticeRequests', filter: { id: badId }, values: { name: 'X' } },
        context: { organizationId: 'org-a' },
        db: guardDb,
      }),
      (err) => err.code === 'DATA_UPDATE_TARGET_ID_EMPTY' && err.status === 400,
    );
  }
  assert.equal(findCalledOnEmptyId, false, 'Empty/null id must fail before hitting SQL repository');
  const uRes = await updateNode.execute({
    config: { collection: 'latticeRequests', filter: { code: 'R2' }, values: { name: 'Hijacked', organizationId: 'org-evil' } },
    context: { organizationId: 'org-a' },
    db,
  });
  assert.equal(uRes.output.updatedCount, 0, 'Cross-org row must never be updated');
});

test('logic.dmn and logic.transform evaluate DMN tables and prototype-safe transforms without eval', async () => {
  const reg = createDefaultRegistry();
  const dmnNode = reg.getNodeType('logic.dmn');
  const transformNode = reg.getNodeType('logic.transform');

  const db = makeMockDb({
    latticeDecisionTables: [
      {
        id: 1,
        organizationId: 'org-a',
        tableKey: 'sla_tier',
        hitPolicy: 'FIRST',
        active: true,
        rulesJson: [
          { when: { score: { op: 'gte', value: 80 } }, then: { tier: 'priority', slaHours: 4 } },
          { when: { score: '*' }, then: { tier: 'standard', slaHours: 24 } },
        ],
      },
    ],
  });

  const ctxObj = { organizationId: 'org-a', data: { score: 92 }, dmn: {} };
  const dmnRes = await dmnNode.execute({
    config: { tableKey: 'sla_tier' },
    context: ctxObj,
    db,
  });
  assert.equal(dmnRes.nextPort, 'main');
  assert.equal(dmnRes.output.matched, true);
  assert.deepEqual(dmnRes.output.outputs, { tier: 'priority', slaHours: 4 });
  assert.deepEqual(ctxObj.dmn, { tier: 'priority', slaHours: 4 });

  // Multi-op transform + math
  const trRes = await transformNode.execute({
    config: {
      baseFromInput: true,
      operations: [
        { op: 'set', target: 'code', value: 'ITEM-7' },
        { op: 'coerceNumber', source: 'rawQty', target: 'qty' },
        { op: 'coerceBoolean', source: 'rawFlag', target: 'urgent' },
        { op: 'math', operator: 'mul', left: 'qty', right: 2.5, target: 'total', precision: 2 },
        { op: 'math', operator: 'div', left: 'total', right: 2, target: 'halfTotal', precision: 2 },
        { op: 'concat', parts: ['code', 'tier'], separator: ':', target: 'compositeKey' },
        { op: 'template', expr: 'Key={{result.compositeKey}}', target: 'summary' },
        { op: 'rename', from: 'rawQty', to: 'originalQtyText' },
        { op: 'omit', keys: ['rawFlag'] },
      ],
    },
    input: { rawQty: '4', rawFlag: 'true', tier: 'A' },
    context: { organizationId: 'org-a' },
  });
  assert.equal(trRes.nextPort, 'main');
  assert.equal(trRes.output.qty, 4);
  assert.equal(trRes.output.urgent, true);
  assert.equal(trRes.output.total, 10);
  assert.equal(trRes.output.halfTotal, 5);
  assert.equal(trRes.output.compositeKey, 'ITEM-7:A');
  assert.equal(trRes.output.summary, 'Key=ITEM-7:A');
  assert.equal(trRes.output.originalQtyText, '4');
  assert.equal(trRes.output.rawFlag, undefined);

  // Divide by zero blocked
  await assert.rejects(
    () => transformNode.execute({
      config: { operations: [{ op: 'math', operator: 'div', left: 10, right: 0, target: 'bad' }] },
      input: {},
    }),
    (err) => err.code === 'TRANSFORM_DIVIDE_BY_ZERO',
  );

  // __proto__ / constructor blocked
  await assert.rejects(
    () => transformNode.execute({
      config: { operations: [{ op: 'set', target: '__proto__.polluted', value: true }] },
      input: {},
    }),
    /UNSAFE_TRANSFORM_KEY/,
  );
  await assert.rejects(
    () => transformNode.execute({
      config: { operations: [{ op: 'pick', keys: ['constructor'] }] },
      input: { a: 1 },
    }),
    /UNSAFE_TRANSFORM_KEY/,
  );
  assert.equal(({}).polluted, undefined);
});

test('ai.llm and llm-client redact PII, block SSRF, parse fenced JSON, and degrade cleanly when unconfigured', async () => {
  const reg = createDefaultRegistry();
  const llmNode = reg.getNodeType('ai.llm');

  // 1. Unconfigured fallback
  const emptyDb = makeMockDb({ llmServices: [] });
  const unconfDirect = await callConfiguredLlm({
    db: emptyDb,
    env: {},
    messages: [{ role: 'user', content: 'Hello' }],
  });
  assert.equal(unconfDirect.ok, false);
  assert.equal(unconfDirect.mode, 'unconfigured');

  const unconfFallback = await llmNode.execute({
    config: { userPrompt: 'Summarize', fallbackOutput: { status: 'queued_manual' } },
    context: { organizationId: 'org-a' },
    db: emptyDb,
    options: { env: {} },
  });
  assert.equal(unconfFallback.nextPort, 'main');
  assert.equal(unconfFallback.output.mode, 'offline-fallback');
  assert.deepEqual(unconfFallback.output.parsedJson, { status: 'queued_manual' });

  const unconfError = await llmNode.execute({
    config: { userPrompt: 'Summarize' },
    context: { organizationId: 'org-a' },
    db: emptyDb,
    options: { env: {} },
  });
  assert.equal(unconfError.nextPort, 'error');
  assert.ok(unconfError.error);

  // 2. SSRF blocking inside llmServices BEFORE fetchImpl is ever called
  let fetchCalled = false;
  const ssrfDb = makeMockDb({
    llmServices: [
      {
        id: 1,
        name: 'evil-meta',
        enabled: true,
        options: { baseURL: 'http://169.254.169.254/latest/meta-data/', apiKey: 'sk-secret-123456' },
      },
    ],
  });
  await assert.rejects(
    () => llmNode.execute({
      config: { userPrompt: 'Test', fallbackOutput: { ok: true } },
      context: { organizationId: 'org-a' },
      db: ssrfDb,
      options: {
        env: {},
        fetchImpl: async () => {
          fetchCalled = true;
          return { ok: true, json: async () => ({}) };
        },
      },
    }),
    /SSRF|metadata|blocked|UNSAFE/i,
  );
  assert.equal(fetchCalled, false, 'fetchImpl must NEVER be called for SSRF URLs');

  // Even allowExplicitHost must NEVER allow 169.254.169.254
  await assert.rejects(
    () => assertSafeLlmUrl('http://169.254.169.254/latest/meta-data/chat/completions', {
      allowExplicitHost: '169.254.169.254',
    }),
    /blocked|metadata|UNSAFE/i,
  );

  // DNS rebinding via lookupImpl is also blocked
  await assert.rejects(
    () => assertSafeLlmUrl('https://rebind.example.com/v1/chat/completions', {
      lookupImpl: async () => [{ address: '169.254.169.254', family: 4 }],
    }),
    /blocked|SSRF|UNSAFE/i,
  );

  // Explicit admin-configured host.docker.internal is allowed when matching allowExplicitHost
  const safeLocalUrl = await assertSafeLlmUrl('http://host.docker.internal:20128/v1/chat/completions', {
    allowExplicitHost: 'host.docker.internal',
  });
  assert.equal(safeLocalUrl, 'http://host.docker.internal:20128/v1/chat/completions');

  // Non-canonical numeric, IPv6-mapped metadata (compressed & uncompressed), private IPs, and non-allowlisted localhost blocked
  assert.equal(isMetadataTarget('0:0:0:0:0:ffff:a9fe:a9fe'), true);
  assert.equal(isMetadataTarget('::ffff:a9fe:a9fe'), true);
  assert.equal(isMetadataTarget('0000:0000:0000:0000:0000:ffff:a9fe:0001'), true);
  assert.equal(isMetadataTarget('::a9fe:a9fe'), true);
  for (const unsafeUrl of [
    'http://2852039166/latest/meta-data/',
    'http://[::ffff:169.254.169.254]/latest/meta-data/',
    'http://[0:0:0:0:0:ffff:a9fe:a9fe]/latest/meta-data/',
    'http://[::ffff:a9fe:a9fe]/latest/meta-data/',
    'http://[::a9fe:a9fe]/latest/meta-data/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://10.0.0.5:8080/v1/chat/completions',
    'http://192.168.1.10/v1/chat/completions',
    'http://localhost:11434/v1/chat/completions',
  ]) {
    await assert.rejects(() => assertSafeLlmUrl(unsafeUrl), /blocked|UNSAFE/i, `Expected SSRF block for ${unsafeUrl}`);
  }

  // dryRun on ai.llm still rejects SSRF inside llmServices
  await assert.rejects(
    () => llmNode.execute({
      config: { userPrompt: 'Test' },
      context: { organizationId: 'org-a' },
      db: ssrfDb,
      options: { dryRun: true, env: {} },
    }),
    /blocked|metadata|UNSAFE/i,
  );

  // env fallback with NINE_ROUTER_API_KEY
  const svcFromEnv = await resolveActiveLlmService(emptyDb, {
    NINE_ROUTER_API_KEY: 'sk-nine-router-env',
  });
  assert.equal(svcFromEnv.configured, true);
  assert.equal(svcFromEnv.baseURL, 'http://host.docker.internal:20128/v1');
  assert.equal(svcFromEnv.modelName, 'ag/gemini-3.8-flash');

  // 3. Long string PII redaction does NOT truncate > 600 chars
  const longPad = 'A'.repeat(700);
  const redRes = redactPiiForLlm(`${longPad} email alice@example.com phone +84912345678 CCCD 079095001234 sk-abc123456789`);
  assert.ok(redRes.redacted.length > 700, 'PII redaction must not truncate prompts at 600 chars');
  assert.ok(redRes.redactedCount >= 4);
  assert.equal(redRes.redacted.includes('alice@example.com'), false);
  assert.equal(redRes.redacted.includes('0912345678'), false);
  assert.equal(redRes.redacted.includes('079095001234'), false);
  assert.equal(redRes.redacted.includes('sk-abc123456789'), false);

  // 4. Mocked OpenAI /chat/completions call with PII redaction + fenced JSON parsing
  const validDb = makeMockDb({
    llmServices: [
      {
        id: 1,
        name: 'local-9router',
        provider: 'openai-completions',
        enabled: true,
        options: { baseURL: 'https://llm.example.com/v1', apiKey: 'sk-live-secret-999999' },
        enabledModels: { models: [{ value: 'ag/gemini-3.8-flash' }] },
      },
    ],
  });
  let sentBody = null;
  let sentUrl = null;
  const okRes = await llmNode.execute({
    config: {
      systemPrompt: 'Classify ticket concisely as JSON.',
      userPrompt: 'Contact {{data.email}}, phone {{data.phone}}, id {{data.cccd}}, key {{data.key}}',
      responseFormat: 'json',
    },
    context: {
      organizationId: 'org-a',
      data: {
        email: 'user@example.org',
        phone: '0987654321',
        cccd: '079095009876',
        key: 'sk-leak987654321',
      },
    },
    db: validDb,
    options: {
      env: {},
      fetchImpl: async (url, init) => {
        sentUrl = url;
        sentBody = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            model: 'ag/gemini-3.8-flash',
            usage: { prompt_tokens: 20, completion_tokens: 10 },
            choices: [{ message: { content: '```json\n{"category":"support","priority":"high"}\n```' } }],
          }),
        };
      },
    },
  });
  assert.equal(sentUrl, 'https://llm.example.com/v1/chat/completions');
  const sentUserText = sentBody.messages.find((m) => m.role === 'user').content;
  assert.equal(sentUserText.includes('user@example.org'), false);
  assert.equal(sentUserText.includes('0987654321'), false);
  assert.equal(sentUserText.includes('079095009876'), false);
  assert.equal(sentUserText.includes('sk-leak987654321'), false);
  assert.equal(okRes.nextPort, 'main');
  assert.deepEqual(okRes.output.parsedJson, { category: 'support', priority: 'high' });
  assert.ok(okRes.output.piiRedactedCount >= 4);

  // 5. Error message scrubs apiKey
  const errCall = await callConfiguredLlm({
    db: validDb,
    env: {},
    messages: [{ role: 'user', content: 'Hi' }],
    fetchImpl: async () => {
      throw new Error('Upstream rejected sk-live-secret-999999');
    },
  });
  assert.equal(errCall.ok, false);
  assert.equal(errCall.mode, 'error');
  assert.equal(errCall.reason.includes('sk-live-secret-999999'), false);

  // 6. Object message content runs redactPiiForLlm BEFORE JSON.stringify so SENSITIVE_KEY_RE catches apiKey/password
  let sentObjMsg = null;
  const objMsgRes = await callConfiguredLlm({
    db: validDb,
    env: {},
    messages: [
      {
        role: 'user',
        content: {
          apiKey: 'raw-unprefixed-api-key-999',
          password: 'super-secret-password',
          email: 'secret.person@example.org',
          safeField: 'visible',
        },
      },
    ],
    fetchImpl: async (_url, init) => {
      sentObjMsg = JSON.parse(init.body).messages[0].content;
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '{"ok":true}' } }] }),
      };
    },
  });
  assert.equal(objMsgRes.ok, true);
  assert.equal(sentObjMsg.includes('raw-unprefixed-api-key-999'), false);
  assert.equal(sentObjMsg.includes('super-secret-password'), false);
  assert.equal(sentObjMsg.includes('secret.person@example.org'), false);
  assert.equal(sentObjMsg.includes('visible'), true);
  assert.ok(objMsgRes.piiRedactedCount >= 3);
});

test('ai.agent and integration nodes enforce tenant/collection/vault safety and support dryRun', async () => {
  const reg = createDefaultRegistry();
  const db = makeMockDb();

  // ai.agent blocks system collections and creates proposal in live mode
  const agentNode = reg.getNodeType('ai.agent');
  await assert.rejects(
    () => agentNode.execute({ config: { targetCollection: 'users', recommendation: 'bad' }, context: { organizationId: 'org-a' }, db }),
    (err) => err.code === 'TARGET_COLLECTION_FORBIDDEN',
  );
  const agentRes = await agentNode.execute({
    config: { targetCollection: 'latticeAssets', targetRecordId: 5, recommendation: 'Inspect asset' },
    context: { organizationId: 'org-a', event: { id: 'evt_1', type: 'asset.alert' } },
    db,
  });
  assert.equal(agentRes.nextPort, 'main');
  assert.equal(agentRes.output.target, 'latticeAgentProposals');
  assert.equal(db.store.latticeAgentProposals.length, 1);

  // integration.http validates vault connector, blocks origin override, scrubs secret errors
  const httpNode = reg.getNodeType('integration.http');
  const mockVault = {
    async resolveConnectorSecrets() {
      return {
        connector: { connectorKey: 'erp', baseUrl: 'https://api.partner.example.com/v1', authType: 'hmac' },
        secrets: { secret: 'super-secret-value-1234' },
      };
    },
    assertSafeConnectorUrl(u) { return u; },
    async assertSafeConnectorUrlAsync(u) { return u; },
  };
  await assert.rejects(
    () => httpNode.execute({
      config: { connectorKey: 'erp', path: 'https://evil.example.com/steal' },
      context: { organizationId: 'org-a' },
      db,
      options: { connectorVault: mockVault },
    }),
    /CONNECTOR_URL_OVERRIDE_FORBIDDEN/,
  );
  const httpOk = await httpNode.execute({
    config: { connectorKey: 'erp', method: 'POST', path: '/items', body: { ok: true } },
    context: { organizationId: 'org-a' },
    db,
    options: {
      connectorVault: mockVault,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ accepted: true }),
      }),
    },
  });
  assert.equal(httpOk.nextPort, 'main');
  assert.equal(httpOk.output.status, 200);
  assert.equal(httpOk.output.response.accepted, true);

  let bodyCancelled = false;
  await assert.rejects(
    () => httpNode.execute({
      config: { connectorKey: 'erp', method: 'POST', path: '/items', body: { ok: true } },
      context: { organizationId: 'org-a' },
      db,
      options: {
        connectorVault: mockVault,
        fetchImpl: async () => ({
          ok: false,
          status: 503,
          body: {
            async cancel() {
              bodyCancelled = true;
            },
          },
        }),
      },
    }),
    (err) => err.code === 'CONNECTOR_HTTP_ERROR' && err.status === 502,
  );
  assert.equal(bodyCancelled, true, 'Non-OK HTTP response must cancel response.body before throwing');

  // iot.twin_command, notify.send, event.emit
  let twinCalled = null;
  const twinRes = await reg.getNodeType('iot.twin_command').execute({
    config: { assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:1', desiredPatch: { mode: 'eco' } },
    context: { organizationId: 'org-a' },
    db,
    options: {
      digitalTwin: {
        async requestDesiredSetpoint(_db, opts) {
          twinCalled = opts;
          return { synced: true, commandStatus: 'synced' };
        },
      },
    },
  });
  assert.equal(twinRes.nextPort, 'main');
  assert.equal(twinCalled.assetEntityId, 'urn:ngsi-ld:Asset:org-a:native:1');

  let notifCalled = null;
  const notifyRes = await reg.getNodeType('notify.send').execute({
    config: { roleNames: ['ldx_operator'], title: 'Hello', body: 'World' },
    context: { organizationId: 'org-a' },
    db,
    options: {
      notificationCenter: {
        async dispatchRoleNotifications(_db, payload) {
          notifCalled = payload;
          return { dispatchedCount: 1 };
        },
      },
    },
  });
  assert.equal(notifyRes.nextPort, 'main');
  assert.equal(notifCalled.title, 'Hello');

  let emitted = null;
  const emitRes = await reg.getNodeType('event.emit').execute({
    config: { eventType: 'flow.completed', subject: 'req-1', data: { ok: true } },
    context: { organizationId: 'org-a', depth: 2 },
    db,
    options: {
      eventBus: {
        async publishDomainEvent(_db, payload) {
          emitted = payload;
          return { eventId: 'e1' };
        },
      },
    },
  });
  assert.equal(emitRes.nextPort, 'main');
  assert.equal(emitted.depth, 3);
});

test('security regressions: JSON-stringified secrets, IPv6 AAAA DNS, header scrub, capped responseBody, getSafePath & resolveOrgId precedence', async () => {
  const { flowHelpers } = require('../src/server/flow/nodes/triggers');
  const { getOrmTriggerDepth } = require('../src/server/flow/security-helpers');
  const reg = createDefaultRegistry();

  // P2-1: getSafePath rejects functions strictly
  const fn = () => 'secret';
  fn.nested = 'leaked';
  assert.equal(flowHelpers.getSafePath(fn, 'nested'), undefined);
  assert.equal(flowHelpers.getSafePath({ a: { b: 42 } }, 'a.b'), 42);

  // P2-8: options.organizationId takes precedence over untrusted input/config
  assert.equal(
    flowHelpers.resolveOrgId({ organizationId: 'org-ctx' }, { organizationId: 'org-input' }, { organizationId: 'org-opt' }, { organizationId: 'org-cfg' }),
    'org-opt',
  );
  assert.equal(
    flowHelpers.resolveOrgId({}, { organizationId: 'org-input' }, {}, { organizationId: 'org-cfg' }),
    '',
  );

  // P1-3: redactPiiForLlm catches JSON-quoted secrets even after JSON.stringify, and ai.llm scrubs structured objects
  const jsonRed = redactPiiForLlm(JSON.stringify({ apiKey: 'my-secret-999', password: 'pw123', token: 'tok-xyz', safe: 'ok' }));
  assert.ok(jsonRed.redactedCount >= 3);
  assert.equal(jsonRed.redacted.includes('my-secret-999'), false);
  assert.equal(jsonRed.redacted.includes('pw123'), false);
  assert.equal(jsonRed.redacted.includes('tok-xyz'), false);
  assert.equal(jsonRed.redacted.includes('ok'), true);

  const aiDb = makeMockDb({
    llmServices: [{ id: 1, name: 'local-9router', enabled: true, options: { baseURL: 'https://llm.example.com/v1', apiKey: 'sk-123456' } }],
  });
  let aiSentContent = null;
  const aiRes = await reg.getNodeType('ai.llm').execute({
    config: { userPrompt: '{{data}}', responseFormat: 'json' },
    context: { organizationId: 'org-a', data: { apiKey: 'raw-unprefixed-secret-99', note: 'hello' } },
    db: aiDb,
    options: {
      env: {},
      fetchImpl: async (_url, init) => {
        aiSentContent = JSON.parse(init.body).messages[0].content;
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"ok":true}' } }] }) };
      },
    },
  });
  assert.equal(aiRes.nextPort, 'main');
  assert.equal(aiSentContent.includes('raw-unprefixed-secret-99'), false);
  assert.ok(aiRes.output.piiRedactedCount >= 1);

  // P2-9: assertSafeLlmUrl allows public IPv6 AAAA DNS while blocking fc00::/7, fe80::/10, ::1, ::ffff:127.0.0.1
  const pub6 = await assertSafeLlmUrl('https://dualstack.example.com/v1/chat/completions', {
    lookupImpl: async () => [{ address: '2606:4700:4700::1111', family: 6 }],
  });
  assert.equal(pub6, 'https://dualstack.example.com/v1/chat/completions');
  for (const bad6 of ['fc00::1', 'fe80::1', '::1', '::ffff:127.0.0.1']) {
    await assert.rejects(
      () => assertSafeLlmUrl('https://rebind6.example.com/v1/chat/completions', { lookupImpl: async () => [{ address: bad6, family: 6 }] }),
      /blocked|UNSAFE/i,
    );
  }

  // P2-10c: integration.http scrubs lowercase authorization & redacts/caps responseBody
  let capturedHeaders = null;
  const hugePayload = { ok: true, apiKey: 'leak-key-777', blob: 'X'.repeat(80000) };
  const httpRes = await reg.getNodeType('integration.http').execute({
    config: {
      connectorKey: 'erp',
      method: 'POST',
      path: '/items',
      headers: { authorization: 'Bearer evil-override', 'X-Trace': 'ok' },
      body: { ping: true },
    },
    context: { organizationId: 'org-a' },
    db: aiDb,
    options: {
      connectorVault: {
        async resolveConnectorSecrets() {
          return {
            connector: { connectorKey: 'erp', connectorType: 'http_api', baseUrl: 'https://api.example.com/v1', authType: 'bearer' },
            secrets: { token: 'vault-secret-bearer-token' },
          };
        },
        assertSafeConnectorUrl: (u) => u,
        assertSafeConnectorUrlAsync: async (u) => u,
      },
      fetchImpl: async (_url, init) => {
        capturedHeaders = init.headers;
        return { ok: true, status: 200, json: async () => hugePayload };
      },
    },
  });
  assert.equal(Object.keys(capturedHeaders).some((k) => k.toLowerCase() === 'authorization' && capturedHeaders[k].includes('evil-override')), false);
  assert.equal(capturedHeaders.Authorization, 'Bearer vault-secret-bearer-token');
  assert.equal(capturedHeaders['X-Trace'], 'ok');
  assert.equal(JSON.stringify(httpRes.output.response).includes('leak-key-777'), false);
  assert.ok(JSON.stringify(httpRes.output.response).length <= 16384);

  // P1-1: data.create propagates depth + 1 via AsyncLocalStorage
  let observedDepth = null;
  const hookDb = makeMockDb();
  const origGetRepo = hookDb.getRepository.bind(hookDb);
  hookDb.getRepository = (name) => {
    const r = origGetRepo(name);
    const origCreate = r.create.bind(r);
    return {
      ...r,
      async create(args) {
        observedDepth = getOrmTriggerDepth();
        return origCreate(args);
      },
    };
  };
  await reg.getNodeType('data.create').execute({
    config: { collection: 'latticeServiceTickets', values: { code: 'D1', name: 'Depth' } },
    context: { organizationId: 'org-a', depth: 3 },
    db: hookDb,
  });
  assert.equal(observedDepth, 4);
});
