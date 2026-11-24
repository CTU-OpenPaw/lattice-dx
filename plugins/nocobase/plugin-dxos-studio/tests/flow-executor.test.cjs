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
const crypto = require('node:crypto');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const originalLoad = Module._load;
Module._load = function mockedNocobaseLoad(request, parent, isMain) {
  if (request === '@nocobase/server') return { Plugin: class {}, Migration: class {} };
  if (request === '@nocobase/database') return { defineCollection: (def) => def };
  return originalLoad.call(this, request, parent, isMain);
};

let executorMod;
let automationMod;
let DxosStudioPlugin;
try {
  executorMod = require('../src/server/flow/executor');
  automationMod = require('../src/server/automation-engine');
  DxosStudioPlugin = require('../src/server/index');
} finally {
  Module._load = originalLoad;
}

const { getFlowBlueprint } = require('../src/server/flow/blueprints');
const connectorVault = require(path.resolve(__dirname, '../../plugin-lattice-foundation/src/server/connector-vault'));

const {
  executeFlowGraph,
  dryRunFlowGraph,
  testSingleFlowNode,
  resumeFlowRun,
  dispatchRecordTriggerEvent,
  dispatchWebhookIngress,
  tickDueDelayedRuns,
} = executorMod;
const {
  createDxosAutomationsActions,
  executeRuleAgainstEvent,
  validateRulePayload,
} = automationMod;

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

function makeFlowDb(seed = {}) {
  const emitter = new EventEmitter();
  const baseSeed = {
    latticeEmployees: [
      { id: 1, userId: 20, organizationId: 'org-a', active: true },
      { id: 2, userId: 21, organizationId: 'org-a', active: true },
      { id: 3, userId: 22, organizationId: 'org-a', active: true },
    ],
    rolesUsers: [
      { userId: 20, roleName: 'ldx_admin' },
      { userId: 21, roleName: 'ldx_manager' },
      { userId: 22, roleName: 'ldx_operator' },
    ],
    ...seed,
  };
  const store = {};
  const seq = {};
  for (const [col, rows] of Object.entries(baseSeed)) {
    store[col] = rows.map((r, i) => ({ id: r.id ?? i + 1, ...structuredClone(r) }));
    seq[col] = store[col].length + 1;
  }

  function makeRepo(name) {
    if (!store[name]) {
      store[name] = [];
      seq[name] = 1;
    }
    return {
      async find({ filter = {}, sort = [], limit = 200, offset = 0 } = {}) {
        let rows = store[name].filter((r) => matchRow(r, filter));
        if (Array.isArray(sort) && sort.length > 0) {
          const primary = String(sort[0]);
          const desc = primary.startsWith('-');
          const key = desc ? primary.slice(1) : primary;
          rows = rows.slice().sort((a, b) => {
            const av = a[key] instanceof Date ? a[key].getTime() : a[key];
            const bv = b[key] instanceof Date ? b[key].getTime() : b[key];
            if (av === bv) return 0;
            if (av === undefined || av === null) return 1;
            if (bv === undefined || bv === null) return -1;
            return (av < bv ? -1 : 1) * (desc ? -1 : 1);
          });
        }
        return rows.slice(offset, offset + limit).map((r) => ({ ...r }));
      },
      async findOne({ filter = {}, filterByTk } = {}) {
        const eff = filterByTk !== undefined ? { id: filterByTk, ...filter } : filter;
        const rows = await this.find({ filter: eff, limit: 1 });
        return rows[0] || null;
      },
      async count({ filter = {} } = {}) {
        return store[name].filter((r) => matchRow(r, filter)).length;
      },
      async create({ values }) {
        const id = values.id ?? seq[name]++;
        const now = new Date();
        const row = { id, createdAt: now, updatedAt: now, ...structuredClone(values) };
        store[name].push(row);
        return { ...row };
      },
      async update({ filter = {}, filterByTk, values }) {
        const eff = filterByTk !== undefined ? { id: filterByTk, ...filter } : filter;
        let updated = 0;
        for (const row of store[name]) {
          if (matchRow(row, eff)) {
            Object.assign(row, structuredClone(values), { updatedAt: new Date() });
            updated += 1;
          }
        }
        return [updated];
      },
      async destroy({ filter = {}, filterByTk } = {}) {
        const eff = filterByTk !== undefined ? { id: filterByTk, ...filter } : filter;
        const before = store[name].length;
        store[name] = store[name].filter((r) => !matchRow(r, eff));
        return before - store[name].length;
      },
    };
  }

  return {
    store,
    emitter,
    getRepository(name) {
      return makeRepo(name);
    },
    on(event, fn) {
      emitter.on(event, fn);
    },
    off(event, fn) {
      emitter.off(event, fn);
    },
    removeListener(event, fn) {
      emitter.removeListener(event, fn);
    },
    async emitHook(event, model, opts = {}) {
      const listeners = emitter.listeners(event);
      for (const fn of listeners) {
        await fn(model, opts);
      }
    },
    sequelize: {
      getDialect: () => 'sqlite',
    },
  };
}

function makeCtx({ userId = 20, role = 'ldx_admin', organizationId = 'org-a', params = {}, headers = {}, body = null } = {}) {
  return {
    method: 'POST',
    state: {
      currentUser: { id: userId, username: `user_${userId}`, organizationId },
      currentRole: role,
      currentRoles: [role],
    },
    action: { params },
    request: { headers, body },
    body: null,
  };
}

test('DAG branching (control.if + control.switch) and control.parallel -> control.merge (wait_all & first_completed)', async () => {
  const db = makeFlowDb({
    latticeRequests: [{ id: 1, organizationId: 'org-a', code: 'REQ-1', name: 'Initial' }],
  });

  const graphRule = {
    organizationId: 'org-a',
    ruleKey: 'dag_branch_merge_rule',
    schemaVersion: 2,
    graphJson: {
      version: 2,
      nodes: [
        { id: 't1', type: 'trigger.event', config: { eventType: 'order.created' } },
        { id: 'if_1', type: 'control.if', config: { condition: { field: 'data.amount', op: 'gt', value: 100 } } },
        {
          id: 'sw_1',
          type: 'control.switch',
          config: {
            expression: 'data.tier',
            cases: [
              { port: 'case_0', equals: 'gold' },
              { port: 'case_1', equals: 'silver' },
            ],
          },
        },
        { id: 'par_1', type: 'control.parallel', config: {} },
        {
          id: 'tr_a',
          type: 'logic.transform',
          config: { baseFromInput: false, operations: [{ op: 'set', target: 'branchA', value: 'alpha' }] },
        },
        {
          id: 'tr_b',
          type: 'logic.transform',
          config: { baseFromInput: false, operations: [{ op: 'set', target: 'branchB', value: 'beta' }] },
        },
        { id: 'merge_all', type: 'control.merge', config: { mode: 'wait_all' } },
        {
          id: 'create_ticket',
          type: 'data.create',
          config: {
            collection: 'latticeServiceTickets',
            values: {
              code: 'DAG-{{event.id}}',
              name: 'Merged {{nodes.merge_all.output.merged.branchA}}-{{nodes.merge_all.output.merged.branchB}}',
              priority: 'high',
            },
          },
        },
        { id: 'notify_low', type: 'notify.send', config: { roleNames: ['ldx_operator'], title: 'Low amount' } },
        { id: 'notify_silver', type: 'notify.send', config: { roleNames: ['ldx_operator'], title: 'Silver tier' } },
      ],
      edges: [
        { id: 'e1', source: 't1', sourceHandle: 'main', target: 'if_1', targetHandle: 'in' },
        { id: 'e2', source: 'if_1', sourceHandle: 'true', target: 'sw_1', targetHandle: 'in' },
        { id: 'e3', source: 'if_1', sourceHandle: 'false', target: 'notify_low', targetHandle: 'in' },
        { id: 'e4', source: 'sw_1', sourceHandle: 'case_0', target: 'par_1', targetHandle: 'in' },
        { id: 'e5', source: 'sw_1', sourceHandle: 'case_1', target: 'notify_silver', targetHandle: 'in' },
        { id: 'e6', source: 'par_1', sourceHandle: 'main', target: 'tr_a', targetHandle: 'in' },
        { id: 'e7', source: 'par_1', sourceHandle: 'main', target: 'tr_b', targetHandle: 'in' },
        { id: 'e8', source: 'tr_a', sourceHandle: 'main', target: 'merge_all', targetHandle: 'in' },
        { id: 'e9', source: 'tr_b', sourceHandle: 'main', target: 'merge_all', targetHandle: 'in' },
        { id: 'e10', source: 'merge_all', sourceHandle: 'main', target: 'create_ticket', targetHandle: 'in' },
      ],
    },
  };

  const run = await executeFlowGraph(db, graphRule, {
    id: 'evt-dag-1',
    type: 'order.created',
    organizationId: 'org-a',
    data: { amount: 500, tier: 'gold' },
  });

  assert.equal(run.status, 'completed');
  assert.equal(run.graphVersion, 2);
  assert.equal(run.nodeStatesJson.merge_all.status, 'completed');
  assert.deepEqual(run.nodeStatesJson.merge_all.output.merged, { branchA: 'alpha', branchB: 'beta' });
  assert.equal(run.nodeStatesJson.notify_low.status, 'skipped');
  assert.equal(run.nodeStatesJson.notify_low.reason, 'BRANCH_NOT_TAKEN');
  assert.equal(run.nodeStatesJson.notify_silver.status, 'skipped');
  assert.equal(db.store.latticeServiceTickets.length, 1);
  assert.equal(db.store.latticeServiceTickets[0].name, 'Merged alpha-beta');

  // first_completed merge succeeds even when one parallel branch errors out
  const firstMergeRule = {
    organizationId: 'org-a',
    ruleKey: 'first_merge_rule',
    schemaVersion: 2,
    graphJson: {
      version: 2,
      nodes: [
        { id: 't1', type: 'trigger.manual', config: {} },
        { id: 'par_1', type: 'control.parallel', config: {} },
        { id: 'ok_branch', type: 'logic.transform', config: { baseFromInput: false, operations: [{ op: 'set', target: 'winner', value: 'ok' }] } },
        { id: 'fail_branch', type: 'logic.dmn', config: { tableKey: 'missing_dmn_table' } },
        { id: 'merge_first', type: 'control.merge', config: { mode: 'first_completed' } },
      ],
      edges: [
        { id: 'e1', source: 't1', sourceHandle: 'main', target: 'par_1' },
        { id: 'e2', source: 'par_1', sourceHandle: 'main', target: 'ok_branch' },
        { id: 'e3', source: 'par_1', sourceHandle: 'main', target: 'fail_branch' },
        { id: 'e4', source: 'ok_branch', sourceHandle: 'main', target: 'merge_first' },
        { id: 'e5', source: 'fail_branch', sourceHandle: 'main', target: 'merge_first' },
      ],
      settings: { errorPolicy: 'continue' },
    },
  };
  const firstRun = await executeFlowGraph(db, firstMergeRule, { organizationId: 'org-a', data: {} });
  assert.equal(firstRun.status, 'partial');
  assert.equal(firstRun.nodeStatesJson.merge_first.status, 'completed');
  assert.deepEqual(firstRun.nodeStatesJson.merge_first.output.merged, { winner: 'ok' });
});

test('error port routing catches node failure while unhandled failure stops execution', async () => {
  const db = makeFlowDb();

  // With error edge -> routes to error handler and continues
  const errorHandledRule = {
    organizationId: 'org-a',
    ruleKey: 'err_port_rule',
    schemaVersion: 2,
    graphJson: {
      version: 2,
      nodes: [
        { id: 't1', type: 'trigger.manual', config: {} },
        { id: 'bad_step', type: 'logic.dmn', config: { tableKey: 'missing_dmn_table' } },
        { id: 'ok_downstream', type: 'notify.send', config: { roleNames: ['ldx_operator'], title: 'Should not run' } },
        {
          id: 'err_handler',
          type: 'notify.send',
          config: { roleNames: ['ldx_admin'], title: 'Caught: {{steps.bad_step.error}}' },
        },
      ],
      edges: [
        { id: 'e1', source: 't1', sourceHandle: 'main', target: 'bad_step' },
        { id: 'e2', source: 'bad_step', sourceHandle: 'main', target: 'ok_downstream' },
        { id: 'e3', source: 'bad_step', sourceHandle: 'error', target: 'err_handler' },
      ],
    },
  };
  const handledRun = await executeFlowGraph(db, errorHandledRule, { organizationId: 'org-a', data: {} });
  assert.equal(handledRun.nodeStatesJson.bad_step.status, 'failed');
  assert.match(handledRun.nodeStatesJson.bad_step.error, /DMN_TABLE_NOT_FOUND/);
  assert.equal(handledRun.nodeStatesJson.ok_downstream.status, 'skipped');
  assert.equal(handledRun.nodeStatesJson.err_handler.status, 'completed');
  assert.equal(db.store.latticeNotifications.length, 1);
  assert.match(db.store.latticeNotifications[0].title, /Caught: DMN_TABLE_NOT_FOUND/);

  // Without error edge & errorPolicy=stop -> fails & halts
  const fatalRule = {
    organizationId: 'org-a',
    ruleKey: 'fatal_stop_rule',
    schemaVersion: 2,
    graphJson: {
      version: 2,
      nodes: [
        { id: 't1', type: 'trigger.manual', config: {} },
        { id: 'bad_step', type: 'logic.dmn', config: { tableKey: 'missing_dmn_table' } },
        { id: 'never_runs', type: 'notify.send', config: { roleNames: ['ldx_admin'], title: 'Never' } },
      ],
      edges: [
        { id: 'e1', source: 't1', sourceHandle: 'main', target: 'bad_step' },
        { id: 'e2', source: 'bad_step', sourceHandle: 'main', target: 'never_runs' },
      ],
      settings: { errorPolicy: 'stop' },
    },
  };
  const fatalRun = await executeFlowGraph(db, fatalRule, { organizationId: 'org-a', data: {} });
  assert.equal(fatalRun.status, 'failed');
  assert.equal(fatalRun.nodeStatesJson.bad_step.status, 'failed');
  assert.notEqual(fatalRun.nodeStatesJson.never_runs?.status, 'completed');
  assert.equal(db.store.latticeNotifications.length, 1);
});

test('control.loop executes acyclic item subgraph in topological order, runs done branch, and enforces 100 cap', async () => {
  const db = makeFlowDb();
  const loopRule = {
    organizationId: 'org-a',
    ruleKey: 'loop_rule',
    schemaVersion: 2,
    graphJson: {
      version: 2,
      nodes: [
        { id: 't1', type: 'trigger.manual', config: {} },
        { id: 'loop_1', type: 'control.loop', config: { itemsPath: 'data.items', maxIterations: 50 } },
        {
          id: 'item_create',
          type: 'data.create',
          config: {
            collection: 'latticeServiceTickets',
            values: { code: 'L-{{loop.index}}-{{loop.item.sku}}', name: 'Item {{loop.item.sku}}' },
          },
        },
        {
          id: 'done_notify',
          type: 'notify.send',
          config: { roleNames: ['ldx_operator'], title: 'Done {{nodes.loop_1.output.count}}' },
        },
      ],
      edges: [
        { id: 'e1', source: 't1', sourceHandle: 'main', target: 'loop_1' },
        { id: 'e2', source: 'loop_1', sourceHandle: 'item', target: 'item_create' },
        { id: 'e3', source: 'loop_1', sourceHandle: 'done', target: 'done_notify' },
      ],
    },
  };

  const run = await executeFlowGraph(db, loopRule, {
    organizationId: 'org-a',
    data: { items: [{ sku: 'A1' }, { sku: 'B2' }, { sku: 'C3' }] },
  });
  assert.equal(run.status, 'completed');
  assert.equal(db.store.latticeServiceTickets.length, 3);
  assert.deepEqual(
    db.store.latticeServiceTickets.map((t) => t.code),
    ['L-0-A1', 'L-1-B2', 'L-2-C3'],
  );
  assert.equal(run.nodeStatesJson.loop_1.output.results.length, 3);
  assert.equal(db.store.latticeNotifications.length, 1);
  assert.equal(db.store.latticeNotifications[0].title, 'Done 3');

  // >100 maxIterations is rejected by validator
  const overCapRule = {
    organizationId: 'org-a',
    ruleKey: 'loop_over_cap',
    schemaVersion: 2,
    graphJson: {
      version: 2,
      nodes: [
        { id: 't1', type: 'trigger.manual', config: {} },
        { id: 'loop_1', type: 'control.loop', config: { itemsPath: 'data.items', maxIterations: 150 } },
      ],
      edges: [{ id: 'e1', source: 't1', sourceHandle: 'main', target: 'loop_1' }],
    },
  };
  const capFail = await executeFlowGraph(db, overCapRule, { organizationId: 'org-a', data: { items: [1, 2] } });
  assert.equal(capFail.status, 'failed');
  assert.match(capFail.errorMessage, /100/);

  // >100 items array with maxIterations: 100 caps cleanly at 100
  const manyItems = Array.from({ length: 120 }, (_, i) => ({ sku: `S-${i}` }));
  const cappedRule = {
    organizationId: 'org-a',
    ruleKey: 'loop_capped_100',
    schemaVersion: 2,
    graphJson: {
      version: 2,
      nodes: [
        { id: 't1', type: 'trigger.manual', config: {} },
        { id: 'loop_1', type: 'control.loop', config: { itemsPath: 'data.items', maxIterations: 100 } },
        { id: 'item_tr', type: 'logic.transform', config: { operations: [{ op: 'set', target: 'seen', value: '{{loop.index}}' }] } },
      ],
      edges: [
        { id: 'e1', source: 't1', sourceHandle: 'main', target: 'loop_1' },
        { id: 'e2', source: 'loop_1', sourceHandle: 'item', target: 'item_tr' },
      ],
    },
  };
  const cappedRun = await executeFlowGraph(db, cappedRule, { organizationId: 'org-a', data: { items: manyItems } });
  assert.equal(cappedRun.status, 'completed');
  assert.equal(cappedRun.nodeStatesJson.loop_1.output.count, 100);
  assert.equal(cappedRun.nodeStatesJson.loop_1.output.truncated, true);
  assert.equal(cappedRun.nodeStatesJson.loop_1.output.results.length, 100);
});

test('control.approval HITL pause/resume lifecycle enforces org isolation, token check, and 409 double-resume; control.delay ticks due runs only', async () => {
  const procBp = getFlowBlueprint('auto_procurement_hitl_approval');
  assert.ok(procBp);

  const db = makeFlowDb({
    latticeRequests: [
      { id: 42, organizationId: 'org-a', code: 'REQ-PROC-001', name: 'Compressor', amount: 75000000, status: 'draft' },
    ],
    latticeAutomationRules: [
      {
        organizationId: 'org-a',
        ruleKey: procBp.ruleKey,
        name: procBp.name,
        schemaVersion: 2,
        graphJson: procBp.graphJson,
        active: true,
      },
    ],
  });

  // 1. Live execution suspends at approval_director
  const suspendedRun = await executeFlowGraph(db, db.store.latticeAutomationRules[0], {
    ...procBp.sampleEvent,
    organizationId: 'org-a',
  }, { actor: { userId: 10, username: 'requester_10' } });

  assert.equal(suspendedRun.status, 'suspended');
  assert.equal(suspendedRun.suspendedNodeId, 'approval_director');
  assert.ok(suspendedRun.approvalId);
  assert.ok(suspendedRun.resumeToken);
  assert.equal(db.store.latticeAiApprovalQueue.length, 1);
  assert.equal(db.store.latticeAiApprovalQueue[0].status, 'pending');
  assert.equal(db.store.latticeAutomationRuns[0].resumeToken, undefined, 'Raw resumeToken must NEVER be stored in DB');
  assert.ok(db.store.latticeAutomationRuns[0].resumeTokenHash);

  // 2. Wrong org -> 403
  await assert.rejects(
    () => resumeFlowRun(db, {
      organizationId: 'org-b',
      runUid: suspendedRun.runUid,
      decision: 'approved',
      resumeToken: suspendedRun.resumeToken,
      actor: { userId: 99, username: 'evil_b' },
    }),
    (err) => err.status === 403 && err.code === 'NATIVE_ORGANIZATION_MISMATCH',
  );

  // 3. Invalid resumeToken -> 403
  await assert.rejects(
    () => resumeFlowRun(db, {
      organizationId: 'org-a',
      runUid: suspendedRun.runUid,
      decision: 'approved',
      resumeToken: 'forged-resume-token-0000',
      actor: { userId: 21, username: 'mgr_21' },
    }),
    (err) => err.status === 403 && err.code === 'INVALID_RESUME_TOKEN',
  );

  // 4. Valid resume -> continues approved branch (updates latticeRequests & notifies ldx_operator)
  const resumed = await resumeFlowRun(db, {
    organizationId: 'org-a',
    runUid: suspendedRun.runUid,
    decision: 'approved',
    payload: { note: 'Approved by Director' },
    resumeToken: suspendedRun.resumeToken,
    actor: { userId: 21, username: 'mgr_21' },
  });
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.suspendedNodeId, null);
  assert.equal(resumed.nodeStatesJson.update_approved_budget.status, 'completed');
  assert.equal(resumed.nodeStatesJson.notify_operator_approved.status, 'completed');
  assert.equal(resumed.nodeStatesJson.notify_employee_rejected.status, 'skipped');
  assert.equal(db.store.latticeRequests[0].priority, 'approved_budget');
  assert.equal(db.store.latticeAiApprovalQueue[0].status, 'approved');
  assert.equal(db.store.latticeNotifications.length, 1);

  // 5. Double resume -> 409
  await assert.rejects(
    () => resumeFlowRun(db, {
      organizationId: 'org-a',
      runUid: suspendedRun.runUid,
      decision: 'approved',
      resumeToken: suspendedRun.resumeToken,
      actor: { userId: 21, username: 'mgr_21' },
    }),
    (err) => err.status === 409 && err.code === 'RUN_ALREADY_RESUMED',
  );

  // 6. Control.delay pause + tickDueDelayedRuns (and expired approval is NEVER auto-approved)
  const delayRule = {
    organizationId: 'org-a',
    ruleKey: 'delay_test_rule',
    name: 'Delay Test',
    schemaVersion: 2,
    active: true,
    graphJson: {
      version: 2,
      nodes: [
        { id: 't1', type: 'trigger.manual', config: {} },
        { id: 'd1', type: 'control.delay', config: { untilIso: new Date(Date.now() - 5000).toISOString() } },
        { id: 'n1', type: 'notify.send', config: { roleNames: ['ldx_operator'], title: 'Delay Resumed' } },
      ],
      edges: [
        { id: 'e1', source: 't1', sourceHandle: 'main', target: 'd1' },
        { id: 'e2', source: 'd1', sourceHandle: 'main', target: 'n1' },
      ],
    },
  };
  await db.getRepository('latticeAutomationRules').create({ values: delayRule });
  const delayed = await executeFlowGraph(db, delayRule, { organizationId: 'org-a', data: {} });
  assert.equal(delayed.status, 'suspended');
  assert.equal(delayed.suspendedNodeId, 'd1');

  const tickRes = await tickDueDelayedRuns(db);
  assert.equal(tickRes.processedCount, 1);
  const afterTickRun = await db.getRepository('latticeAutomationRuns').findOne({ filter: { runUid: delayed.runUid } });
  assert.equal(afterTickRun.status, 'completed');
  assert.ok(db.store.latticeNotifications.some((n) => n.title === 'Delay Resumed'));
});

test('testSingleFlowNode executes isolated node with pinned inputs and blocks SSRF / system collections', async () => {
  const db = makeFlowDb({
    latticeServiceTickets: [{ id: 7, organizationId: 'org-a', code: 'T-7', name: 'Old' }],
  });

  // Dry-run isolated node with pinned {{steps.*}} & {{nodes.*}}
  const resDry = await testSingleFlowNode(db, {
    organizationId: 'org-a',
    nodeId: 'n_create',
    graph: {
      version: 2,
      nodes: [
        {
          id: 'n_create',
          type: 'data.create',
          config: {
            collection: 'latticeServiceTickets',
            values: { code: 'PIN-{{steps.prev_1.code}}', name: 'From {{nodes.prev_1.output.source}}' },
          },
        },
      ],
      edges: [],
    },
    pinnedInputs: {
      steps: { prev_1: { code: '999', source: 'sensor-x' } },
    },
  });
  assert.equal(resDry.ok, true);
  assert.equal(resDry.status, 'completed');
  assert.equal(resDry.output.simulated, true);
  assert.equal(resDry.output.record.code, 'PIN-999');
  assert.equal(resDry.output.record.name, 'From sensor-x');
  assert.equal(db.store.latticeServiceTickets.length, 1, 'dryRun must not write DB');

  // System table rejected
  await assert.rejects(
    () => testSingleFlowNode(db, {
      organizationId: 'org-a',
      nodeId: 'bad_col',
      graph: {
        version: 2,
        nodes: [{ id: 'bad_col', type: 'data.create', config: { collection: 'users', values: { username: 'pwn' } } }],
        edges: [],
      },
    }),
    (err) => err.code === 'TARGET_COLLECTION_FORBIDDEN',
  );

  // SSRF metadata URL rejected
  await assert.rejects(
    () => testSingleFlowNode(db, {
      organizationId: 'org-a',
      nodeId: 'bad_ssrf',
      graph: {
        version: 2,
        nodes: [
          {
            id: 'bad_ssrf',
            type: 'integration.http',
            config: { connectorKey: 'ext', url: 'http://169.254.169.254/latest/meta-data' },
          },
        ],
        edges: [],
      },
    }),
    (err) => err.code === 'CONNECTOR_URL_UNSAFE',
  );
});

test('dispatchWebhookIngress enforces HMAC-SHA256 fail-closed and runs partner-webhook-sync blueprint', async () => {
  const prevMaster = process.env.DX_VAULT_MASTER_KEY;
  process.env.DX_VAULT_MASTER_KEY = 'unit-test-vault-master-key-32bytes!!';

  try {
    const partnerBp = getFlowBlueprint('auto_partner_webhook_sync');
    assert.ok(partnerBp);
    const webhookSecret = 'wh-inbound-secret-abc-1234';
    const erpSecret = 'erp-outbound-token-xyz';
    const db = makeFlowDb({
      latticeAutomationRules: [
        {
          organizationId: 'org-a',
          ruleKey: partnerBp.ruleKey,
          name: partnerBp.name,
          schemaVersion: 2,
          graphJson: partnerBp.graphJson,
          active: true,
        },
      ],
      latticeConnectors: [
        {
          organizationId: 'org-a',
          connectorKey: `webhook:${partnerBp.ruleKey}`,
          name: 'Inbound Partner Webhook Secret',
          connectorType: 'webhook',
          baseUrl: 'https://partner.example.com',
          authType: 'hmac',
          encryptedSecretsJson: connectorVault.encryptVaultSecrets({ webhookSecret }, process.env),
          active: true,
        },
        {
          organizationId: 'org-a',
          connectorKey: 'erp-webhook-sync',
          name: 'ERP Sync Connector',
          connectorType: 'http_api',
          baseUrl: 'https://erp.example.com/api',
          authType: 'bearer',
          encryptedSecretsJson: connectorVault.encryptVaultSecrets({ token: erpSecret }, process.env),
          active: true,
        },
      ],
    });

    const payloadObj = partnerBp.sampleEvent.data;
    const rawBody = JSON.stringify(payloadObj);

    // Missing signature -> 401/403
    await assert.rejects(
      () => dispatchWebhookIngress(db, {
        organizationId: 'org-a',
        ruleKey: partnerBp.ruleKey,
        headers: {},
        rawBody,
        parsedBody: payloadObj,
      }),
      (err) => (err.status === 401 || err.status === 403) && err.code === 'WEBHOOK_SIGNATURE_INVALID',
    );

    // Invalid signature -> 401/403
    await assert.rejects(
      () => dispatchWebhookIngress(db, {
        organizationId: 'org-a',
        ruleKey: partnerBp.ruleKey,
        headers: { 'x-lattice-signature-256': 'sha256=' + '0'.repeat(64) },
        rawBody,
        parsedBody: payloadObj,
      }),
      (err) => (err.status === 401 || err.status === 403) && err.code === 'WEBHOOK_SIGNATURE_INVALID',
    );

    // Valid HMAC signature executes partner-webhook-sync (fail 1st item -> error branch, succeed 2nd -> done branch)
    const validSig = 'sha256=' + crypto.createHmac('sha256', webhookSecret).update(rawBody, 'utf8').digest('hex');
    let callIdx = 0;
    const syncedBodies = [];
    const res = await dispatchWebhookIngress(db, {
      organizationId: 'org-a',
      ruleKey: partnerBp.ruleKey,
      headers: { 'X-Lattice-Signature-256': validSig },
      rawBody,
      parsedBody: payloadObj,
      options: {
        env: { ...process.env, NODE_ENV: 'production' },
        lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
        fetchImpl: async (_url, init) => {
          callIdx += 1;
          syncedBodies.push(JSON.parse(init.body));
          if (callIdx === 1) return { ok: false, status: 500 };
          return { ok: true, status: 200, json: async () => ({ synced: true }) };
        },
      },
    });

    assert.ok(res.runUid);
    assert.equal(syncedBodies.length, 2);
    assert.equal(syncedBodies[0].item.sku, 'SKU-001');
    assert.equal(syncedBodies[1].item.sku, 'SKU-002');
    assert.equal(db.store.latticeNotifications.length, 2);
    assert.match(db.store.latticeNotifications[0].title, /Lỗi đồng bộ/);
    assert.match(db.store.latticeNotifications[1].title, /Hoàn tất đồng bộ/);
  } finally {
    if (prevMaster === undefined) delete process.env.DX_VAULT_MASTER_KEY;
    else process.env.DX_VAULT_MASTER_KEY = prevMaster;
  }
});

test('coldchain-emergency.json Graph v2 blueprint and v1 actionsJson compatibility execute cleanly', async () => {
  const prevMaster = process.env.DX_VAULT_MASTER_KEY;
  process.env.DX_VAULT_MASTER_KEY = 'unit-test-vault-master-key-32bytes!!';

  try {
    const coldBp = getFlowBlueprint('auto_cmms_on_coldchain_fault');
    assert.ok(coldBp);

    const db = makeFlowDb({
      latticeAssets: [{ id: 1, organizationId: 'org-a', code: 'FREEZER-01', status: 'active' }],
      latticeTwinShadows: [
        {
          id: 1,
          organizationId: 'org-a',
          assetId: 1,
          assetEntityId: 'urn:ngsi-ld:Asset:org-a:native:1',
          desiredJson: { targetTempC: 8.0 },
          reportedJson: { targetTempC: 8.0 },
          version: 1,
        },
      ],
      latticeDecisionTables: [
        {
          organizationId: 'org-a',
          tableKey: 'cmms_priority_routing_v1',
          hitPolicy: 'FIRST',
          active: true,
          rulesJson: [
            { when: { severity: 'critical' }, then: { workOrderPriority: 'critical', assignedRole: 'ldx_manager', slaHours: 2 } },
            { when: {}, then: { workOrderPriority: 'medium', assignedRole: 'ldx_operator', slaHours: 24 } },
          ],
        },
      ],
      latticeConnectors: [
        {
          organizationId: 'org-a',
          connectorKey: 'n8n-coldchain-orchestrator',
          connectorType: 'n8n',
          baseUrl: 'https://n8n.example.com/webhook/coldchain',
          authType: 'hmac',
          encryptedSecretsJson: connectorVault.encryptVaultSecrets({ secret: 'n8n-secret-1234' }, process.env),
          active: true,
        },
      ],
    });

    const n8nPayloads = [];
    const v2Run = await executeRuleAgainstEvent(
      db,
      {
        organizationId: 'org-a',
        ruleKey: coldBp.ruleKey,
        name: coldBp.name,
        schemaVersion: 2,
        graphJson: coldBp.graphJson,
      },
      { ...coldBp.sampleEvent, organizationId: 'org-a' },
      {
        env: { ...process.env, NODE_ENV: 'production' },
        lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
        fetchImpl: async (_url, init) => {
          n8nPayloads.push(JSON.parse(init.body));
          return { ok: true, status: 200, json: async () => ({ ok: true }) };
        },
      },
    );

    assert.equal(v2Run.status, 'completed');
    assert.equal(v2Run.graphVersion, 2);
    assert.equal(db.store.latticeCustomWorkOrders.length, 1);
    const woId = db.store.latticeCustomWorkOrders[0].id;
    assert.equal(db.store.latticeAgentProposals[0].targetRecordId, woId);
    assert.equal(n8nPayloads.length, 1);
    assert.equal(n8nPayloads[0].workOrderId, woId);

    // Dry-run via dryRunFlowGraph causes zero DB mutations
    const dryRes = await dryRunFlowGraph(
      db,
      coldBp.graphJson,
      { ...coldBp.sampleEvent, organizationId: 'org-a' },
      { env: { ...process.env, NODE_ENV: 'production' }, lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }] },
    );
    assert.equal(dryRes.status, 'completed');
    assert.equal(db.store.latticeCustomWorkOrders.length, 1);

    // Legacy v1 actionsJson rule also continues to execute backward-compatibly
    const v1Run = await executeRuleAgainstEvent(
      db,
      {
        organizationId: 'org-a',
        ruleKey: 'v1_compat_rule',
        triggerEventType: 'alarm.triggered',
        actionsJson: [
          { type: 'create_record', collection: 'latticeServiceTickets', values: { code: 'V1-{{id}}', name: 'V1 Ticket' } },
          { type: 'notify_role', role: 'ldx_operator', title: 'Ticket #{{steps.0.id}}' },
        ],
      },
      { id: 'evt-v1', type: 'alarm.triggered', organizationId: 'org-a', data: {} },
    );
    assert.equal(v1Run.status, 'completed');
    assert.equal(db.store.latticeServiceTickets.length, 1);
    assert.equal(db.store.latticeNotifications.at(-1).title, `Ticket #${db.store.latticeServiceTickets[0].id}`);
  } finally {
    if (prevMaster === undefined) delete process.env.DX_VAULT_MASTER_KEY;
    else process.env.DX_VAULT_MASTER_KEY = prevMaster;
  }
});

test('automation-engine v2 actions, validateRulePayload v2, and DxosStudioPlugin ORM hooks + ACL wiring work cleanly', async () => {
  const procBp = getFlowBlueprint('auto_procurement_hitl_approval');
  const partnerBp = getFlowBlueprint('auto_partner_webhook_sync');
  const webhookSecret = 'wh-action-secret-9999';
  const prevMaster = process.env.DX_VAULT_MASTER_KEY;
  process.env.DX_VAULT_MASTER_KEY = 'unit-test-vault-master-key-32bytes!!';

  try {
    const db = makeFlowDb({
      latticeEmployees: [
        { userId: 20, organizationId: 'org-a', active: true },
        { userId: 21, organizationId: 'org-a', active: true },
      ],
      rolesUsers: [
        { userId: 20, roleName: 'ldx_admin' },
        { userId: 21, roleName: 'ldx_manager' },
      ],
      latticeRequests: [
        { id: 42, organizationId: 'org-a', code: 'REQ-PROC-001', name: 'Compressor', amount: 75000000, status: 'draft' },
      ],
      latticeConnectors: [
        {
          organizationId: 'org-a',
          connectorKey: `webhook:${partnerBp.ruleKey}`,
          connectorType: 'webhook',
          baseUrl: 'https://partner.example.com',
          authType: 'hmac',
          encryptedSecretsJson: connectorVault.encryptVaultSecrets({ webhookSecret }, process.env),
          active: true,
        },
      ],
    });

    // validateRulePayload v2 auto-computes triggerIndexJson and v1 compat summary
    const validatedV2 = validateRulePayload({
      ruleKey: procBp.ruleKey,
      name: procBp.name,
      schemaVersion: 2,
      graphJson: procBp.graphJson,
    });
    assert.equal(validatedV2.schemaVersion, 2);
    assert.equal(validatedV2.triggerIndexJson[0].triggerType, 'record');
    assert.equal(validatedV2.triggerIndexJson[0].collection, 'latticeRequests');
    assert.equal(validatedV2.triggerIndexJson[0].operation, 'create');
    assert.equal(validatedV2.triggerEventType, 'record.latticeRequests.create');

    const actions = createDxosAutomationsActions(db);

    // nodeRegistry
    const regCtx = makeCtx({ userId: 20, role: 'ldx_admin', params: {} });
    await actions.nodeRegistry(regCtx, async () => {});
    assert.equal(regCtx.body.nodeTypes.length, 24);

    // testNode
    const tnCtx = makeCtx({
      userId: 20,
      role: 'ldx_admin',
      params: {
        graph: procBp.graphJson,
        nodeId: 'if_over_50m',
        pinnedInputs: { data: { amount: 75000000 } },
      },
    });
    await actions.testNode(tnCtx, async () => {});
    assert.equal(tnCtx.body.result.ok, true);
    assert.equal(tnCtx.body.result.nextPort, 'true');

    // Save v2 procurement rule & v2 webhook rule
    await actions.saveRule(makeCtx({
      userId: 20,
      role: 'ldx_admin',
      params: { rule: { ruleKey: procBp.ruleKey, name: procBp.name, schemaVersion: 2, graphJson: procBp.graphJson } },
    }), async () => {});
    await actions.saveRule(makeCtx({
      userId: 20,
      role: 'ldx_admin',
      params: { rule: { ruleKey: partnerBp.ruleKey, name: partnerBp.name, schemaVersion: 2, graphJson: partnerBp.graphJson } },
    }), async () => {});

    // Mount DxosStudioPlugin -> verify ACL + ORM record hook triggers procurement flow & unload stops it
    const aclAllowed = {};
    const mockApp = {
      resourceManager: { use() {}, define() {} },
      acl: { registerSnippet() {}, allow(res, list) { aclAllowed[res] = list; } },
    };
    const plugin = Object.create(DxosStudioPlugin.prototype);
    plugin.app = mockApp;
    plugin.db = db;
    await plugin.load();

    try {
      for (const actionName of ['builderCatalog', 'aiAssist', 'nodeRegistry', 'testNode', 'resumeRun']) {
        assert.ok(aclAllowed.dxosAutomations.includes(actionName), `Missing ACL action ${actionName}`);
      }

      // ORM afterCreate fires record trigger -> pauses at approval_director
      await db.emitHook('latticeRequests.afterCreate', {
        id: 42,
        organizationId: 'org-a',
        code: 'REQ-PROC-001',
        name: 'Compressor',
        amount: 75000000,
      });
      assert.equal(db.store.latticeAutomationRuns.length, 1);
      const runUid = db.store.latticeAutomationRuns[0].runUid;
      assert.equal(db.store.latticeAutomationRuns[0].status, 'suspended');

      // resumeRun action resumes suspended run
      const resCtx = makeCtx({
        userId: 21,
        role: 'ldx_manager',
        params: { runUid, decision: 'approved' },
      });
      await actions.resumeRun(resCtx, async () => {});
      assert.equal(resCtx.body.run.status, 'completed');

      // webhookIngress action rejects bad HMAC & accepts valid HMAC
      const whPayload = { batchId: 'B1', partnerCode: 'P1', items: [] };
      const whRaw = JSON.stringify(whPayload);
      await assert.rejects(
        () => actions.webhookIngress(makeCtx({
          params: { organizationId: 'org-a', ruleKey: partnerBp.ruleKey },
          headers: { 'x-lattice-signature-256': 'sha256=' + 'f'.repeat(64) },
          body: whPayload,
        }), async () => {}),
        (err) => err.code === 'WEBHOOK_SIGNATURE_INVALID',
      );
      const sig = 'sha256=' + crypto.createHmac('sha256', webhookSecret).update(whRaw, 'utf8').digest('hex');
      const whCtx = makeCtx({
        params: { organizationId: 'org-a', ruleKey: partnerBp.ruleKey },
        headers: { 'x-lattice-signature-256': sig },
        body: whPayload,
      });
      whCtx.request.rawBody = whRaw;
      await actions.webhookIngress(whCtx, async () => {});
      assert.equal(whCtx.body.ok, true);
      assert.equal(whCtx.body.run.status, 'completed');

      // Unload disables ORM hooks
      await plugin.unload();
      const runsBefore = db.store.latticeAutomationRuns.length;
      await db.emitHook('latticeRequests.afterCreate', {
        id: 43,
        organizationId: 'org-a',
        amount: 90000000,
      });
      assert.equal(db.store.latticeAutomationRuns.length, runsBefore);
    } finally {
      await plugin.destroy();
    }
  } finally {
    if (prevMaster === undefined) delete process.env.DX_VAULT_MASTER_KEY;
    else process.env.DX_VAULT_MASTER_KEY = prevMaster;
  }
});

test('security fix: cross-tenant organizationId override blocked across executeFlowGraph, testSingleFlowNode, and actions', async () => {
  const tenantDb = makeFlowDb({
    latticeEmployees: [{ id: 1, userId: 20, organizationId: 'org-a', active: true }],
    rolesUsers: [{ userId: 20, roleName: 'ldx_admin' }],
    latticeServiceTickets: [
      { id: 1, organizationId: 'org-a', code: 'A-1', name: 'Org A Ticket' },
      { id: 2, organizationId: 'org-b', code: 'B-1', name: 'Org B Secret Ticket' },
    ],
  });
  const queryGraph = {
    version: 2,
    nodes: [
      { id: 't1', type: 'trigger.manual', config: {} },
      { id: 'q1', type: 'data.query', config: { collection: 'latticeServiceTickets', filter: {} } },
    ],
    edges: [{ id: 'e1', source: 't1', sourceHandle: 'main', target: 'q1' }],
  };
  const orgARule = { organizationId: 'org-a', ruleKey: 'tenant_query_rule', name: 'Tenant Query', schemaVersion: 2, active: true, graphJson: queryGraph };
  await tenantDb.getRepository('latticeAutomationRules').create({ values: orgARule });

  const execSpoof = await executeFlowGraph(tenantDb, orgARule, {
    organizationId: 'org-b',
    organizationid: 'org-b',
    data: { organizationId: 'org-b' },
  });
  assert.equal(execSpoof.organizationId, 'org-a');
  assert.equal(execSpoof.nodeStatesJson.q1.output.items.length, 1);
  assert.equal(execSpoof.nodeStatesJson.q1.output.items[0].organizationId, 'org-a');

  const inlineSpoof = await executeFlowGraph(tenantDb, { ...queryGraph }, {
    organizationId: 'org-b',
    data: { organizationId: 'org-b' },
  }, { organizationId: 'org-a' });
  assert.equal(inlineSpoof.organizationId, 'org-a');
  assert.equal(inlineSpoof.nodeStatesJson.q1.output.items.length, 1);
  assert.equal(inlineSpoof.nodeStatesJson.q1.output.items[0].code, 'A-1');

  const pinSpoof = await testSingleFlowNode(tenantDb, {
    organizationId: 'org-a',
    nodeId: 'q1',
    graph: queryGraph,
    pinnedInputs: { organizationId: 'org-b', event: { organizationId: 'org-b' }, data: { organizationId: 'org-b' } },
    options: { live: true },
  });
  assert.equal(pinSpoof.ok, true);
  assert.equal(pinSpoof.output.items.length, 1);
  assert.equal(pinSpoof.output.items[0].organizationId, 'org-a');

  const tenantActions = createDxosAutomationsActions(tenantDb);
  const tnSpoofCtx = makeCtx({
    userId: 20,
    role: 'ldx_admin',
    params: {
      live: true,
      rule: { organizationId: 'org-b', graphJson: queryGraph },
      nodeId: 'q1',
      pinnedInputs: { organizationId: 'org-b', event: { organizationId: 'org-b' }, data: { organizationId: 'org-b' } },
    },
  });
  await tenantActions.testNode(tnSpoofCtx, async () => {});
  assert.equal(tnSpoofCtx.body.result.output.items.length, 1);
  assert.equal(tnSpoofCtx.body.result.output.items[0].organizationId, 'org-a');

  const trSpoofCtx = makeCtx({
    userId: 20,
    role: 'ldx_admin',
    params: { ruleKey: 'tenant_query_rule', event: { organizationId: 'org-b', data: { organizationId: 'org-b' } } },
  });
  await tenantActions.testRule(trSpoofCtx, async () => {});
  assert.equal(trSpoofCtx.body.simulation.organizationId, 'org-a');
  assert.equal(trSpoofCtx.body.simulation.nodeStatesJson.q1.output.items[0].organizationId, 'org-a');

  const rnSpoofCtx = makeCtx({
    userId: 20,
    role: 'ldx_admin',
    params: { ruleKey: 'tenant_query_rule', event: { organizationId: 'org-b', data: { organizationId: 'org-b' } } },
  });
  await tenantActions.runNow(rnSpoofCtx, async () => {});
  assert.equal(rnSpoofCtx.body.run.organizationId, 'org-a');
  assert.equal(rnSpoofCtx.body.run.nodeStatesJson.q1.output.items.length, 1);
  assert.equal(rnSpoofCtx.body.run.nodeStatesJson.q1.output.items[0].organizationId, 'org-a');

  const rpSpoofCtx = makeCtx({
    userId: 20,
    role: 'ldx_admin',
    params: { runUid: rnSpoofCtx.body.run.runUid, event: { organizationId: 'org-b', data: { organizationId: 'org-b' } } },
  });
  await tenantActions.replayRun(rpSpoofCtx, async () => {});
  assert.equal(rpSpoofCtx.body.run.organizationId, 'org-a');
  assert.equal(rpSpoofCtx.body.run.nodeStatesJson.q1.output.items.length, 1);
  assert.equal(rpSpoofCtx.body.run.nodeStatesJson.q1.output.items[0].organizationId, 'org-a');
});

test('draftGraphJson save without graphJson preserves schemaVersion 1, triggerIndexJson, and publishedVersion', async () => {
  const db = makeFlowDb({
    latticeEmployees: [{ id: 1, userId: 20, organizationId: 'org-a', active: true }],
    rolesUsers: [{ userId: 20, roleName: 'ldx_admin' }],
    latticeAutomationRules: [
      {
        organizationId: 'org-a',
        ruleKey: 'published_v2_rule',
        name: 'Published V2',
        schemaVersion: 2,
        publishedVersion: 2,
        triggerEventType: 'manual.trigger',
        triggerIndexJson: [{ triggerType: 'event', eventType: 'manual.trigger' }],
        graphJson: { version: 2, nodes: [{ id: 't1', type: 'trigger.manual', config: {} }], edges: [] },
        active: true,
      },
    ],
  });

  const draftOnlyValidated = validateRulePayload({
    ruleKey: 'v1_with_draft',
    name: 'V1 With Draft',
    triggerEventType: 'alarm.triggered',
    actionsJson: [{ type: 'create_record', collection: 'latticeServiceTickets', values: { code: 'T1' } }],
    draftGraphJson: {
      version: 2,
      nodes: [{ id: 'tr_draft', type: 'trigger.record', config: { collection: 'latticeRequests', operation: 'create' } }],
      edges: [],
    },
  });
  assert.equal(draftOnlyValidated.schemaVersion, 1);
  assert.equal(draftOnlyValidated.triggerEventType, 'alarm.triggered');
  assert.equal(draftOnlyValidated.triggerIndexJson.length, 1);
  assert.equal(draftOnlyValidated.triggerIndexJson[0].triggerType, 'event');
  assert.equal(draftOnlyValidated.triggerIndexJson[0].eventType, 'alarm.triggered');
  assert.equal(draftOnlyValidated.triggerIndexJson[0].collection, null);
  assert.equal(draftOnlyValidated.actionsJson.length, 1);
  assert.equal(draftOnlyValidated.draftGraphJson.nodes[0].id, 'tr_draft');

  const actions = createDxosAutomationsActions(db);
  const saveDraftCtx = makeCtx({
    userId: 20,
    role: 'ldx_admin',
    params: {
      rule: {
        ruleKey: 'published_v2_rule',
        name: 'Published V2 With Draft',
        schemaVersion: 2,
        draftGraphJson: {
          version: 2,
          nodes: [{ id: 'tr_sched', type: 'trigger.schedule', config: { cron: '*/5 * * * *' } }],
          edges: [],
        },
      },
    },
  });
  await actions.saveRule(saveDraftCtx, async () => {});
  assert.equal(saveDraftCtx.body.rule.publishedVersion, 2);
  assert.notEqual(saveDraftCtx.body.rule.triggerIndexJson?.[0]?.triggerType, 'schedule');
});

test('resumeFlowRun dryRun preserves suspended DB status and explicit empty resumeToken is rejected', async () => {
  const db = makeFlowDb();
  const hitlRule = {
    organizationId: 'org-a',
    ruleKey: 'dry_resume_hitl',
    name: 'Dry Resume HITL',
    schemaVersion: 2,
    active: true,
    graphJson: {
      version: 2,
      nodes: [
        { id: 't1', type: 'trigger.manual', config: {} },
        { id: 'ap1', type: 'control.approval', config: { title: 'Approve?' } },
        { id: 'ok1', type: 'notify.send', config: { roleNames: ['ldx_admin'], title: 'Approved Notify' } },
        { id: 'no1', type: 'notify.send', config: { roleNames: ['ldx_admin'], title: 'Rejected Notify' } },
      ],
      edges: [
        { id: 'e1', source: 't1', sourceHandle: 'main', target: 'ap1' },
        { id: 'e2', source: 'ap1', sourceHandle: 'approved', target: 'ok1' },
        { id: 'e3', source: 'ap1', sourceHandle: 'rejected', target: 'no1' },
      ],
    },
  };
  await db.getRepository('latticeAutomationRules').create({ values: hitlRule });
  const suspRun = await executeFlowGraph(db, hitlRule, { organizationId: 'org-a', data: {} });
  assert.equal(suspRun.status, 'suspended');

  await assert.rejects(
    () => resumeFlowRun(db, {
      organizationId: 'org-a',
      runUid: suspRun.runUid,
      decision: 'approved',
      resumeToken: '',
      actor: { userId: 20, username: 'admin' },
    }),
    (err) => err.status === 403 && err.code === 'INVALID_RESUME_TOKEN',
  );

  const dryResume = await resumeFlowRun(db, {
    organizationId: 'org-a',
    runUid: suspRun.runUid,
    decision: 'approved',
    resumeToken: suspRun.resumeToken,
    actor: { userId: 20, username: 'admin' },
    dryRun: true,
  });
  assert.equal(dryResume.status, 'completed');
  const persistedRun = await db.getRepository('latticeAutomationRuns').findOne({ filter: { runUid: suspRun.runUid } });
  assert.equal(persistedRun.status, 'suspended');
  assert.equal((db.store.latticeNotifications || []).length, 0);

  const liveAfterDry = await resumeFlowRun(db, {
    organizationId: 'org-a',
    runUid: suspRun.runUid,
    decision: 'approved',
    resumeToken: suspRun.resumeToken,
    actor: { userId: 20, username: 'admin' },
  });
  assert.equal(liveAfterDry.status, 'completed');
  assert.equal((db.store.latticeNotifications || []).length, 1);
});

test('webhookIngress and dispatchWebhookIngress strip resumeToken, resumeTokenHash, and internal traces', async () => {
  const prevMaster = process.env.DX_VAULT_MASTER_KEY;
  process.env.DX_VAULT_MASTER_KEY = 'unit-test-vault-master-key-32bytes!!';

  try {
    const whApprovalRuleKey = 'wh_hitl_secret_strip';
    const whSecret = 'wh-strip-secret-xyz';
    const db = makeFlowDb({
      latticeConnectors: [
        {
          organizationId: 'org-a',
          connectorKey: `webhook:${whApprovalRuleKey}`,
          connectorType: 'webhook',
          baseUrl: 'https://partner.example.com',
          authType: 'hmac',
          encryptedSecretsJson: connectorVault.encryptVaultSecrets({ webhookSecret: whSecret }, process.env),
          active: true,
        },
      ],
      latticeAutomationRules: [
        {
          organizationId: 'org-a',
          ruleKey: whApprovalRuleKey,
          name: 'Webhook Approval',
          schemaVersion: 2,
          active: true,
          graphJson: {
            version: 2,
            nodes: [
              { id: 'wh1', type: 'trigger.webhook', config: { webhookPath: '/hitl', authMode: 'hmac' } },
              { id: 'ap1', type: 'control.approval', config: { title: 'Approve Webhook' } },
            ],
            edges: [{ id: 'e1', source: 'wh1', sourceHandle: 'main', target: 'ap1' }],
          },
        },
      ],
    });
    const actions = createDxosAutomationsActions(db);
    const whBody = JSON.stringify({ event: 'go' });
    const whSig = 'sha256=' + crypto.createHmac('sha256', whSecret).update(whBody, 'utf8').digest('hex');

    const directWh = await dispatchWebhookIngress(db, {
      organizationId: 'org-a',
      ruleKey: whApprovalRuleKey,
      headers: { 'x-lattice-signature-256': whSig },
      rawBody: whBody,
    });
    assert.equal(directWh.status, 'suspended');
    assert.equal(directWh.resumeToken, undefined);
    assert.equal(directWh.resumeTokenHash, undefined);
    assert.equal(directWh.nodeStatesJson, undefined);
    assert.equal(directWh.stepTracesJson, undefined);
    assert.equal(directWh.triggerPayloadJson, undefined);
    assert.equal(directWh.run, undefined);

    const actionWhCtx = makeCtx({
      params: { organizationId: 'org-a', ruleKey: whApprovalRuleKey },
      headers: { 'x-lattice-signature-256': whSig },
      body: { event: 'go' },
    });
    actionWhCtx.request.rawBody = whBody;
    await actions.webhookIngress(actionWhCtx, async () => {});
    assert.deepEqual(Object.keys(actionWhCtx.body).sort(), ['ok', 'run']);
    assert.deepEqual(Object.keys(actionWhCtx.body.run).sort(), ['runUid', 'status']);
    assert.equal(actionWhCtx.body.run.status, 'suspended');
  } finally {
    if (prevMaster === undefined) delete process.env.DX_VAULT_MASTER_KEY;
    else process.env.DX_VAULT_MASTER_KEY = prevMaster;
  }
});

test('control.loop isolates per-iteration traces and propagates inner suspension cleanly', async () => {
  const db = makeFlowDb({
    latticeServiceTickets: [{ id: 1, organizationId: 'org-a', code: 'A-1', name: 'Org A Ticket' }],
  });
  const loopErrRule = {
    organizationId: 'org-a',
    ruleKey: 'loop_isolated_err',
    schemaVersion: 2,
    graphJson: {
      version: 2,
      nodes: [
        { id: 't1', type: 'trigger.manual', config: {} },
        { id: 'lp1', type: 'control.loop', config: { itemsPath: 'data.items', maxIterations: 10 } },
        {
          id: 'step_body',
          type: 'data.query',
          continueOnFail: true,
          config: { collection: '{{loop.item.col}}', filter: {} },
        },
      ],
      edges: [
        { id: 'e1', source: 't1', sourceHandle: 'main', target: 'lp1' },
        { id: 'e2', source: 'lp1', sourceHandle: 'item', target: 'step_body' },
      ],
    },
  };
  const loopErrRun = await executeFlowGraph(db, loopErrRule, {
    organizationId: 'org-a',
    data: { items: [{ col: 'latticeServiceTickets' }, { col: 'users' }] },
  });
  assert.equal(loopErrRun.nodeStatesJson.lp1.output.results.length, 2);
  assert.equal(loopErrRun.nodeStatesJson.lp1.output.results[0].count, 1);
  assert.equal(loopErrRun.nodeStatesJson.lp1.output.results[1], null);

  const loopSuspRule = {
    organizationId: 'org-a',
    ruleKey: 'loop_suspend_rule',
    schemaVersion: 2,
    graphJson: {
      version: 2,
      nodes: [
        { id: 't1', type: 'trigger.manual', config: {} },
        { id: 'lp1', type: 'control.loop', config: { itemsPath: 'data.items', maxIterations: 10 } },
        { id: 'ap_item', type: 'control.approval', config: { title: 'Approve {{loop.item.sku}}' } },
        { id: 'done_notify', type: 'notify.send', config: { roleNames: ['ldx_admin'], title: 'Should Not Fire' } },
      ],
      edges: [
        { id: 'e1', source: 't1', sourceHandle: 'main', target: 'lp1' },
        { id: 'e2', source: 'lp1', sourceHandle: 'item', target: 'ap_item' },
        { id: 'e3', source: 'lp1', sourceHandle: 'done', target: 'done_notify' },
      ],
    },
  };
  const loopSuspRun = await executeFlowGraph(db, loopSuspRule, {
    organizationId: 'org-a',
    data: { items: [{ sku: 'S1' }, { sku: 'S2' }] },
  });
  assert.equal(loopSuspRun.status, 'suspended');
  assert.equal(loopSuspRun.suspendedNodeId, 'ap_item');
  assert.equal((db.store.latticeNotifications || []).length, 0);
});

test('flow/executor.js stays <= 350 lines, zero domain leakage, zero banned branding/eval, valid SPDX header', async () => {
  const { addSourceHeader } = await import(pathToFileURL(path.resolve(__dirname, '../../../../scripts/source-headers.mjs')).href);
  const rootDir = path.resolve(__dirname, '../../../..');
  const execRel = 'plugins/nocobase/plugin-dxos-studio/src/server/flow/executor.js';
  const testRel = 'plugins/nocobase/plugin-dxos-studio/tests/flow-executor.test.cjs';

  const execSrc = fs.readFileSync(path.join(rootDir, execRel), 'utf8');
  const lines = execSrc.split(/\r?\n/).length;
  assert.ok(lines <= 350, `executor.js has ${lines} lines (> 350)`);
  const bannedBrand = ['co', 'pilot'].join('');
  const forbiddenRe = new RegExp(`\\b(?:cold-?chain|vaccine|vac-?xin|mkt|cmms|freezer|lotCode|${bannedBrand})\\b|\\beval\\s*\\(|new\\s+Function`, 'i');
  assert.equal(forbiddenRe.test(execSrc), false, 'executor.js must have zero domain terms, banned branding, or eval');

  for (const rel of [execRel, testRel]) {
    const src = fs.readFileSync(path.join(rootDir, rel), 'utf8');
    const hdr = addSourceHeader(src, rel);
    assert.equal(hdr.status, 'present', `Missing/malformed SPDX header in ${rel}`);
  }
});

test('Whole-Delta P1 & P2 regressions: ALS depth, webhook rawBody/connectorType, loop+merge, multi-suspend DMN, ticker guards, resuming recovery, org mismatch, RLS', async () => {
  const prevMaster = process.env.DX_VAULT_MASTER_KEY;
  process.env.DX_VAULT_MASTER_KEY = 'unit-test-vault-master-key-32bytes!!';

  try {
    // 1. P1-1: AsyncLocalStorage depth stops recursive ORM trigger at MAX_HARD_DEPTH = 8 without hookOpts.depth
    const recDb = makeFlowDb();
    const recPlugin = Object.create(DxosStudioPlugin.prototype);
    recPlugin.app = { resourceManager: { use() {}, define() {} }, acl: { registerSnippet() {}, allow() {} } };
    recPlugin.db = recDb;
    const recOrigGetRepo = recDb.getRepository.bind(recDb);
    recDb.getRepository = (name) => {
      const repo = recOrigGetRepo(name);
      if (name !== 'latticeRequests') return repo;
      return {
        ...repo,
        async create(args) {
          if (recDb.store.latticeRequests.length >= 20) throw new Error('INFINITE_RECURSION_UNHALTED');
          const created = await repo.create(args);
          await recDb.emitHook('latticeRequests.afterCreate', created, {}); // No depth in hookOpts!
          return created;
        },
      };
    };
    await recDb.getRepository('latticeAutomationRules').create({
      values: {
        organizationId: 'org-a',
        ruleKey: 'self_loop_orm',
        name: 'Self Loop ORM',
        schemaVersion: 2,
        active: true,
        graphJson: {
          version: 2,
          nodes: [
            { id: 't1', type: 'trigger.record', config: { collection: 'latticeRequests', operation: 'create' } },
            { id: 'c1', type: 'data.create', config: { collection: 'latticeRequests', values: { code: 'REC-{{event.depth}}' } } },
          ],
          edges: [{ id: 'e1', source: 't1', sourceHandle: 'main', target: 'c1', targetHandle: 'in' }],
        },
      },
    });
    await recPlugin.load();
    try {
      await recDb.getRepository('latticeRequests').create({ values: { organizationId: 'org-a', code: 'SEED' } });
      assert.equal(recDb.store.latticeRequests.length, 9); // seed + depths 0..7
      assert.equal(recDb.store.latticeAutomationRuns.length, 9); // depths 0..8 (depth 8 skipped)
      assert.equal(recDb.store.latticeAutomationRuns.at(-1).status, 'skipped');
      assert.match(recDb.store.latticeAutomationRuns.at(-1).errorMessage, /RECURSION_DEPTH_LIMIT_EXCEEDED/);
    } finally {
      await recPlugin.destroy();
    }

    // 2. P1-4 & P2-2: Webhook rawBody vs tampered parsedBody, and http_api connector cannot provide inbound webhook secret
    const whSecret = 'wh-raw-vs-parsed-secret';
    const whDb = makeFlowDb({
      latticeConnectors: [
        {
          organizationId: 'org-a',
          connectorKey: 'webhook:wh_raw_check',
          connectorType: 'webhook',
          baseUrl: 'https://partner.example.com',
          authType: 'hmac',
          encryptedSecretsJson: connectorVault.encryptVaultSecrets({ webhookSecret: whSecret }, process.env),
          active: true,
        },
        {
          organizationId: 'org-a',
          connectorKey: 'wh_non_webhook_only',
          connectorType: 'http_api',
          baseUrl: 'https://partner.example.com',
          authType: 'hmac',
          encryptedSecretsJson: connectorVault.encryptVaultSecrets({ webhookSecret: 'should-not-resolve' }, process.env),
          active: true,
        },
      ],
      latticeAutomationRules: [
        {
          organizationId: 'org-a',
          ruleKey: 'wh_raw_check',
          name: 'WH Raw Check',
          schemaVersion: 2,
          active: true,
          graphJson: {
            version: 2,
            nodes: [
              { id: 't1', type: 'trigger.webhook', config: { webhookPath: '/raw', authMode: 'hmac' } },
              { id: 'c1', type: 'data.create', config: { collection: 'latticeServiceTickets', values: { code: '{{data.code}}' } } },
            ],
            edges: [{ id: 'e1', source: 't1', target: 'c1' }],
          },
        },
        {
          organizationId: 'org-a',
          ruleKey: 'wh_non_webhook_only',
          name: 'WH Non Webhook',
          schemaVersion: 2,
          active: true,
          graphJson: {
            version: 2,
            nodes: [{ id: 't1', type: 'trigger.webhook', config: { webhookPath: '/bad', authMode: 'hmac' } }],
            edges: [],
          },
        },
      ],
    });
    const signedRaw = JSON.stringify({ code: 'TRUSTED-RAW' });
    const signedSig = 'sha256=' + crypto.createHmac('sha256', whSecret).update(signedRaw, 'utf8').digest('hex');
    await dispatchWebhookIngress(whDb, {
      organizationId: 'org-a',
      ruleKey: 'wh_raw_check',
      headers: { 'x-lattice-signature-256': signedSig },
      rawBody: signedRaw,
      parsedBody: { code: 'EVIL-PARSED-OVERRIDE' },
    });
    assert.equal(whDb.store.latticeServiceTickets[0].code, 'TRUSTED-RAW');

    const badConnRaw = JSON.stringify({ ok: true });
    const badConnSig = 'sha256=' + crypto.createHmac('sha256', 'should-not-resolve').update(badConnRaw, 'utf8').digest('hex');
    await assert.rejects(
      () => dispatchWebhookIngress(whDb, {
        organizationId: 'org-a',
        ruleKey: 'wh_non_webhook_only',
        headers: { 'x-lattice-signature-256': badConnSig },
        rawBody: badConnRaw,
      }),
      (err) => err.code === 'WEBHOOK_SIGNATURE_INVALID',
    );

    // 3. P1-5: control.merge (wait_all) works deterministically inside control.loop when branches alternate
    const loopMergeDb = makeFlowDb();
    const loopMergeRun = await executeFlowGraph(loopMergeDb, {
      organizationId: 'org-a',
      ruleKey: 'loop_merge_wait_all',
      schemaVersion: 2,
      graphJson: {
        version: 2,
        nodes: [
          { id: 't1', type: 'trigger.manual', config: {} },
          { id: 'lp1', type: 'control.loop', config: { itemsPath: 'data.items', maxIterations: 10 } },
          { id: 'if1', type: 'control.if', config: { condition: { field: 'loop.item.flag', op: 'eq', value: true } } },
          { id: 'tr_a', type: 'logic.transform', config: { baseFromInput: false, operations: [{ op: 'set', target: 'res', value: 'A' }] } },
          { id: 'tr_b', type: 'logic.transform', config: { baseFromInput: false, operations: [{ op: 'set', target: 'res', value: 'B' }] } },
          { id: 'm1', type: 'control.merge', config: { mode: 'wait_all' } },
          { id: 'c1', type: 'data.create', config: { collection: 'latticeServiceTickets', values: { code: '{{nodes.m1.output.merged.res}}-{{loop.index}}' } } },
        ],
        edges: [
          { id: 'e1', source: 't1', target: 'lp1' },
          { id: 'e2', source: 'lp1', sourceHandle: 'item', target: 'if1' },
          { id: 'e3', source: 'if1', sourceHandle: 'true', target: 'tr_a' },
          { id: 'e4', source: 'if1', sourceHandle: 'false', target: 'tr_b' },
          { id: 'e5', source: 'tr_a', target: 'm1' },
          { id: 'e6', source: 'tr_b', target: 'm1' },
          { id: 'e7', source: 'm1', target: 'c1' },
        ],
      },
    }, { organizationId: 'org-a', data: { items: [{ flag: true }, { flag: false }] } });
    assert.equal(loopMergeRun.status, 'completed');
    assert.deepEqual(loopMergeDb.store.latticeServiceTickets.map((t) => t.code), ['A-0', 'B-1']);

    // 4. P1-6: Multi-suspend DMN restore & re-suspend preserves DMN outputs across 2 suspends
    const dmnSuspDb = makeFlowDb({
      latticeDecisionTables: [
        {
          organizationId: 'org-a',
          tableKey: 'tier_tbl',
          hitPolicy: 'FIRST',
          active: true,
          rulesJson: [{ when: {}, then: { tier: 'gold' } }],
        },
      ],
      latticeAutomationRules: [
        {
          organizationId: 'org-a',
          ruleKey: 'multi_suspend_dmn',
          name: 'Multi Suspend DMN',
          schemaVersion: 2,
          active: true,
          graphJson: {
            version: 2,
            nodes: [
              { id: 't1', type: 'trigger.manual', config: {} },
              { id: 'ap1', type: 'control.approval', config: { title: 'Gate 1' } },
              { id: 'dmn1', type: 'logic.dmn', config: { tableKey: 'tier_tbl' } },
              { id: 'ap2', type: 'control.approval', config: { title: 'Gate 2' } },
              { id: 'n1', type: 'notify.send', config: { roleNames: ['ldx_admin'], title: 'Tier={{dmn.tier}}' } },
            ],
            edges: [
              { id: 'e1', source: 't1', target: 'ap1' },
              { id: 'e2', source: 'ap1', sourceHandle: 'approved', target: 'dmn1' },
              { id: 'e3', source: 'dmn1', target: 'ap2' },
              { id: 'e4', source: 'ap2', sourceHandle: 'approved', target: 'n1' },
            ],
          },
        },
      ],
    });
    const susp1 = await executeFlowGraph(dmnSuspDb, dmnSuspDb.store.latticeAutomationRules[0], { organizationId: 'org-a', data: {} });
    assert.equal(susp1.status, 'suspended');
    const susp2 = await resumeFlowRun(dmnSuspDb, { organizationId: 'org-a', runUid: susp1.runUid, decision: 'approved', resumeToken: susp1.resumeToken });
    assert.equal(susp2.status, 'suspended');
    assert.equal(susp2.suspendedNodeId, 'ap2');
    const done2 = await resumeFlowRun(dmnSuspDb, { organizationId: 'org-a', runUid: susp2.runUid, decision: 'approved', resumeToken: susp2.resumeToken });
    assert.equal(done2.status, 'completed');
    assert.equal(dmnSuspDb.store.latticeNotifications[0].title, 'Tier=gold');

    // 5. P1-7 & P1-8: tickDueDelayedRuns ignores NaN/approvalId!=null; resumeFlowRun marks pre-DAG failures as failed (not resuming)
    const tickDb = makeFlowDb({
      latticeAutomationRuns: [
        { organizationId: 'org-a', ruleKey: 'missing_rule', runUid: 'bad_date_run', status: 'suspended', suspendedNodeId: 'd1', resumeAt: 'not-a-date', approvalId: null },
        { organizationId: 'org-a', ruleKey: 'missing_rule', runUid: 'approval_id_run', status: 'suspended', suspendedNodeId: 'ap1', resumeAt: new Date(Date.now() - 5000), approvalId: 99, nodeStatesJson: {} },
        { organizationId: 'org-a', ruleKey: 'missing_rule', runUid: 'orphan_check_run', status: 'suspended', suspendedNodeId: 'd1', resumeAt: new Date(Date.now() - 5000), approvalId: null },
      ],
    });
    const badNowTick = await tickDueDelayedRuns(tickDb, { now: 'not-a-date' });
    assert.equal(badNowTick.processedCount, 0);
    const tickRes = await tickDueDelayedRuns(tickDb);
    assert.equal(tickRes.processedCount, 1);
    assert.equal(tickRes.results[0].runUid, 'orphan_check_run');
    assert.equal(tickDb.store.latticeAutomationRuns[0].status, 'suspended');
    assert.equal(tickDb.store.latticeAutomationRuns[1].status, 'suspended');
    assert.equal(tickDb.store.latticeAutomationRuns[2].status, 'failed');
    assert.match(tickDb.store.latticeAutomationRuns[2].errorMessage, /not found/i);

    // 6. P2-8: executeFlowGraph rejects options.organizationId vs rule.organizationId mismatch
    await assert.rejects(
      () => executeFlowGraph(loopMergeDb, { organizationId: 'org-b', ruleKey: 'r', schemaVersion: 2, graphJson: { version: 2, nodes: [{ id: 't1', type: 'trigger.manual', config: {} }], edges: [] } }, {}, { organizationId: 'org-a' }),
      (err) => err.status === 403 && err.code === 'NATIVE_ORGANIZATION_MISMATCH',
    );

    // 7. P1-9: DX_PG_RLS_SESSION=true wraps tickDueDelayedRuns & dispatchWebhookIngress with app.current_org
    const prevRls = process.env.DX_PG_RLS_SESSION;
    process.env.DX_PG_RLS_SESSION = 'true';
    const rlsQueries = [];
    try {
      const rlsDb = makeFlowDb({
        latticeConnectors: [
          {
            organizationId: 'org-rls',
            connectorKey: 'webhook:rls_hook',
            connectorType: 'webhook',
            baseUrl: 'https://partner.example.com',
            authType: 'hmac',
            encryptedSecretsJson: connectorVault.encryptVaultSecrets({ webhookSecret: whSecret }, process.env),
            active: true,
          },
        ],
        latticeAutomationRules: [
          {
            organizationId: 'org-rls',
            ruleKey: 'rls_hook',
            name: 'RLS Hook',
            schemaVersion: 2,
            active: true,
            graphJson: {
              version: 2,
              nodes: [
                { id: 't1', type: 'trigger.webhook', config: { webhookPath: '/rls', authMode: 'hmac' } },
                { id: 'd1', type: 'control.delay', config: { untilIso: new Date(Date.now() - 1000).toISOString() } },
              ],
              edges: [{ id: 'e1', source: 't1', target: 'd1' }],
            },
          },
        ],
      });
      rlsDb.sequelize = {
        getDialect: () => 'postgres',
        async transaction(fn) { return fn({ id: 'tx-rls' }); },
        async query(sql, opts) {
          rlsQueries.push({ sql: String(sql), org: opts?.replacements?.orgId || null, tx: opts?.transaction?.id || null });
          return [[], { rowCount: 1 }];
        },
      };
      const whRlsBody = JSON.stringify({ hello: 'rls' });
      const whRlsSig = 'sha256=' + crypto.createHmac('sha256', whSecret).update(whRlsBody, 'utf8').digest('hex');
      await dispatchWebhookIngress(rlsDb, { organizationId: 'org-rls', ruleKey: 'rls_hook', headers: { 'x-lattice-signature-256': whRlsSig }, rawBody: whRlsBody });
      assert.ok(rlsQueries.some((q) => q.sql.includes("set_config('app.current_org'") && q.org === 'org-rls'));
      rlsQueries.length = 0;
      await tickDueDelayedRuns(rlsDb);
      assert.ok(rlsQueries.some((q) => q.sql.includes("set_config('app.current_org'") && q.org === 'org-rls'));

      // 8. SAVEPOINT isolation + sequential batching under active PG RLS transaction:
      //    If a node fails SQL (e.g. data.update or raw SQL error), ROLLBACK TO SAVEPOINT recovers outer tx so finalizeDagRun still commits,
      //    and parallel ready branches run sequentially on the shared PG RLS connection.
      const prevErrorNode = executorMod;
      assert.ok(prevErrorNode);
      let pgTxAborted = false;
      const spLog = [];
      const orderLog = [];
      const spDb = makeFlowDb({
        latticeAutomationRules: [
          {
            organizationId: 'org-sp',
            ruleKey: 'sp_recovery_flow',
            name: 'Savepoint Recovery Flow',
            schemaVersion: 2,
            active: true,
            graphJson: {
              version: 2,
              nodes: [
                { id: 't1', type: 'trigger.manual', config: {} },
                { id: 'b1', type: 'data.query', config: { collection: 'latticeRequests', filter: { code: 'SQL_FAIL' } } },
                { id: 'b2', type: 'data.create', config: { collection: 'latticeServiceTickets', values: { code: 'SP-02', name: 'Parallel branch 2' } } },
              ],
              edges: [
                { id: 'e1', source: 't1', target: 'b1' },
                { id: 'e2', source: 't1', target: 'b2' },
              ],
            },
          },
        ],
      });
      const baseGetRepo = spDb.getRepository.bind(spDb);
      spDb.getRepository = (col) => {
        const repo = baseGetRepo(col);
        return {
          ...repo,
          async find(args) {
            if (col === 'latticeRequests' && args?.filter?.code === 'SQL_FAIL') {
              orderLog.push('b1:start');
              await new Promise((r) => setTimeout(r, 12));
              orderLog.push('b1:end');
              pgTxAborted = true;
              throw new Error('invalid input syntax for type bigint: ""');
            }
            if (pgTxAborted) throw new Error('current transaction is aborted, commands ignored until end of transaction block');
            return repo.find(args);
          },
          async create(args) {
            if (col === 'latticeServiceTickets') {
              orderLog.push('b2:start');
              await new Promise((r) => setTimeout(r, 8));
              orderLog.push('b2:end');
            }
            if (pgTxAborted) throw new Error('current transaction is aborted, commands ignored until end of transaction block');
            return repo.create(args);
          },
          async update(args) {
            if (pgTxAborted) throw new Error('current transaction is aborted, commands ignored until end of transaction block');
            return repo.update(args);
          },
        };
      };
      spDb.sequelize = {
        getDialect: () => 'postgres',
        async transaction(fn) { pgTxAborted = false; return fn({ id: 'tx-sp-exec' }); },
        async query(sql) {
          const text = String(sql);
          spLog.push(text);
          if (text.startsWith('ROLLBACK TO SAVEPOINT ')) pgTxAborted = false;
          return [[], { rowCount: 1 }];
        },
      };
      const spRun = await executeFlowGraph(
        spDb,
        spDb.store.latticeAutomationRules[0],
        { organizationId: 'org-sp', data: { hello: 1 } },
        { organizationId: 'org-sp' },
      );
      assert.equal(spRun.status, 'partial');
      assert.equal(pgTxAborted, false, 'Outer RLS transaction must recover cleanly after node SAVEPOINT rollback');
      assert.ok(spLog.some((s) => /^SAVEPOINT "ldx_sp_\d+"$/.test(s)));
      assert.ok(spLog.some((s) => /^ROLLBACK TO SAVEPOINT "ldx_sp_\d+"$/.test(s)));
      assert.equal(spDb.store.latticeAutomationRuns.find((r) => r.runUid === spRun.runUid)?.status, 'partial');
      assert.deepEqual(orderLog, ['b1:start', 'b1:end', 'b2:start', 'b2:end']);
    } finally {
      if (prevRls === undefined) delete process.env.DX_PG_RLS_SESSION;
      else process.env.DX_PG_RLS_SESSION = prevRls;
    }
  } finally {
    if (prevMaster === undefined) delete process.env.DX_VAULT_MASTER_KEY;
    else process.env.DX_VAULT_MASTER_KEY = prevMaster;
  }
});

test('Task 4: migration 20261127000300, pinned graphSnapshotJson, triggerPayloadJson replay, node.timeoutMs, 5-field cron, and scheduler ticker', async () => {
  // 1. Migration 20261127000300 has reversible up() & down() + Apache-2.0 header
  const migOrigLoad = Module._load;
  Module._load = function mockedNocobase(request, parent, isMain) {
    if (request === '@nocobase/server') return { Migration: class { constructor(ctx) { this.context = ctx; } }, Plugin: class {} };
    return migOrigLoad.call(this, request, parent, isMain);
  };
  let MigClass;
  try {
    MigClass = require('../src/server/migrations/20261127000300-flow-snapshot-and-schedule.js');
  } finally {
    Module._load = migOrigLoad;
  }
  const sqlStmts = [];
  const fakeTx = { id: 'tx-mig-0300' };
  const mig = new MigClass({
    db: {
      sequelize: {
        getDialect: () => 'postgres',
        transaction: async (fn) => fn(fakeTx),
        query: async (sql) => { sqlStmts.push(sql); return [[]]; },
      },
    },
  });
  await mig.up();
  const upSql = sqlStmts.join('\n');
  assert.match(upSql, /"latticeAutomationRuns".*ADD COLUMN IF NOT EXISTS "graphSnapshotJson"/i);
  assert.match(upSql, /"latticeAutomationRuns".*ADD COLUMN IF NOT EXISTS "triggerPayloadJson"/i);
  assert.match(upSql, /"latticeAutomationRules".*ADD COLUMN IF NOT EXISTS "cronExpression"/i);
  assert.match(upSql, /"latticeAutomationRules".*ADD COLUMN IF NOT EXISTS "nextRunAt"/i);
  sqlStmts.length = 0;
  await mig.down();
  const downSql = sqlStmts.join('\n');
  assert.match(downSql, /"latticeAutomationRuns".*DROP COLUMN IF EXISTS "graphSnapshotJson"/i);
  assert.match(downSql, /"latticeAutomationRules".*DROP COLUMN IF EXISTS "nextRunAt"/i);
  assert.match(downSql, /"latticeAutomationRules".*DROP COLUMN IF EXISTS "cronExpression"/i);

  // 2. 5-field cron evaluator (matchesCron & computeNextCronRun)
  const { matchesCron, computeNextCronRun, tickFlowScheduler, tickExpiredApprovals } = require('../src/server/flow/cron');
  assert.equal(matchesCron('*/15 * * * *', new Date('2026-11-24T08:30:00Z')), true);
  assert.equal(matchesCron('*/15 * * * *', new Date('2026-11-24T08:31:00Z')), false);
  // 2026-11-24 is Tuesday (dayOfWeek = 2); 08:00 Asia/Ho_Chi_Minh = 01:00 UTC
  assert.equal(matchesCron('0 8 * * 1-5', new Date('2026-11-24T01:00:00Z'), 'Asia/Ho_Chi_Minh'), true);
  assert.equal(matchesCron('0 8 * * 1-5', new Date('2026-11-22T01:00:00Z'), 'Asia/Ho_Chi_Minh'), false); // Sunday
  const nextUtc = computeNextCronRun('30 9 * * *', new Date('2026-11-24T09:30:00Z'));
  assert.equal(nextUtc.toISOString(), '2026-11-25T09:30:00.000Z');
  const nextStep = computeNextCronRun('*/15 * * * *', new Date('2026-11-24T08:16:20Z'));
  assert.equal(nextStep.toISOString(), '2026-11-24T08:30:00.000Z');
  assert.throws(() => matchesCron('invalid cron', new Date()), /FLOW_INVALID_CRON/);

  // 3. Pinned graphSnapshotJson on suspend & used on resume even after rule graph is modified/deleted
  const snapDb = makeFlowDb({
    latticeAutomationRules: [
      {
        organizationId: 'org-a',
        ruleKey: 'pinned_snapshot_rule',
        name: 'Pinned Snapshot Rule',
        schemaVersion: 2,
        active: true,
        graphJson: {
          version: 2,
          nodes: [
            { id: 't1', type: 'trigger.manual', config: {} },
            { id: 'ap1', type: 'control.approval', config: { approverRole: 'ldx_manager', title: 'Approve' } },
            { id: 'c_old', type: 'data.create', config: { collection: 'latticeServiceTickets', values: { code: 'PINNED-OLD', name: 'Old Graph' } } },
          ],
          edges: [
            { id: 'e1', source: 't1', sourceHandle: 'main', target: 'ap1' },
            { id: 'e2', source: 'ap1', sourceHandle: 'approved', target: 'c_old' },
          ],
        },
      },
    ],
  });
  const suspSnap = await executeFlowGraph(snapDb, snapDb.store.latticeAutomationRules[0], { organizationId: 'org-a', data: { ticketId: 99 } });
  assert.equal(suspSnap.status, 'suspended');
  assert.ok(snapDb.store.latticeAutomationRuns[0].graphSnapshotJson?.nodes?.some((n) => n.id === 'c_old'));
  assert.equal(snapDb.store.latticeAutomationRuns[0].triggerPayloadJson?.data?.ticketId, 99);

  // Edit rule AFTER run suspended to point to c_new -> resume MUST still run c_old from pinned snapshot
  snapDb.store.latticeAutomationRules[0].graphJson = {
    version: 2,
    nodes: [
      { id: 't1', type: 'trigger.manual', config: {} },
      { id: 'ap1', type: 'control.approval', config: { approverRole: 'ldx_manager', title: 'Approve' } },
      { id: 'c_new', type: 'data.create', config: { collection: 'latticeServiceTickets', values: { code: 'MUTATED-NEW', name: 'New Graph' } } },
    ],
    edges: [
      { id: 'e1', source: 't1', sourceHandle: 'main', target: 'ap1' },
      { id: 'e2', source: 'ap1', sourceHandle: 'approved', target: 'c_new' },
    ],
  };
  const resumedSnap = await resumeFlowRun(snapDb, {
    organizationId: 'org-a',
    runUid: suspSnap.runUid,
    decision: 'approved',
    resumeToken: suspSnap.resumeToken,
    actor: { userId: 21, username: 'mgr_21' },
  });
  assert.equal(resumedSnap.status, 'completed');
  assert.equal(snapDb.store.latticeServiceTickets.some((t) => t.code === 'PINNED-OLD'), true);
  assert.equal(snapDb.store.latticeServiceTickets.some((t) => t.code === 'MUTATED-NEW'), false);

  // 4. triggerPayloadJson persisted on run creation & reused on replayRun without in-memory cache or eventBus
  const replayDb = makeFlowDb({
    latticeAutomationRules: [
      {
        organizationId: 'org-a',
        ruleKey: 'replay_payload_rule',
        name: 'Replay Payload Rule',
        schemaVersion: 2,
        active: true,
        graphJson: {
          version: 2,
          nodes: [
            { id: 't1', type: 'trigger.manual', config: {} },
            { id: 'c1', type: 'data.create', config: { collection: 'latticeServiceTickets', values: { code: 'RPL-{{data.orderRef}}', name: 'Replayed {{data.note}}' } } },
          ],
          edges: [{ id: 'e1', source: 't1', sourceHandle: 'main', target: 'c1' }],
        },
      },
    ],
    latticeAutomationRuns: [
      {
        id: 500,
        organizationId: 'org-a',
        ruleKey: 'replay_payload_rule',
        runUid: 'run_persisted_payload_1',
        triggerEventId: 'evt_persisted_1',
        triggerEventType: 'manual.trigger',
        status: 'completed',
        depth: 0,
        triggerPayloadJson: {
          event: { id: 'evt_persisted_1', type: 'manual.trigger', organizationId: 'org-a', data: { orderRef: 'ORD-777', note: 'Cold-A' } },
          data: { orderRef: 'ORD-777', note: 'Cold-A' },
        },
      },
    ],
  });
  const replayActions = createDxosAutomationsActions(replayDb);
  const replayCtx = makeCtx({ userId: 20, role: 'ldx_admin', params: { runUid: 'run_persisted_payload_1' } });
  await replayActions.replayRun(replayCtx, async () => {});
  assert.equal(replayCtx.body.run.status, 'completed');
  assert.equal(replayDb.store.latticeServiceTickets[0].code, 'RPL-ORD-777');
  assert.equal(replayDb.store.latticeServiceTickets[0].name, 'Replayed Cold-A');

  // 5. node.timeoutMs enforced cleanly with error-port routing
  const regMod = require('../src/server/flow/registry');
  const timeoutRegistry = regMod.createDefaultRegistry();
  timeoutRegistry.registerNodeType({
    type: 'logic.slow_test',
    category: 'logic',
    label: 'Slow Test Node',
    outputs: ['main', 'error'],
    async execute() {
      await new Promise((r) => setTimeout(r, 250));
      return { output: { done: true }, nextPort: 'main' };
    },
  });
  const timeoutDb = makeFlowDb();
  const timeoutRun = await executeFlowGraph(
    timeoutDb,
    {
      organizationId: 'org-a',
      ruleKey: 'timeout_rule',
      schemaVersion: 2,
      graphJson: {
        version: 2,
        nodes: [
          { id: 't1', type: 'trigger.manual', config: {} },
          { id: 'slow1', type: 'logic.slow_test', timeoutMs: 25, config: {} },
          { id: 'err_n', type: 'notify.send', config: { roleNames: ['ldx_admin'], title: 'TimedOut: {{steps.slow1.error}}' } },
        ],
        edges: [
          { id: 'e1', source: 't1', sourceHandle: 'main', target: 'slow1' },
          { id: 'e2', source: 'slow1', sourceHandle: 'error', target: 'err_n' },
        ],
      },
    },
    { organizationId: 'org-a', data: {} },
    { nodeRegistry: timeoutRegistry },
  );
  assert.equal(timeoutRun.nodeStatesJson.slow1.status, 'failed');
  assert.match(timeoutRun.nodeStatesJson.slow1.error, /timed out/i);
  assert.equal(timeoutRun.nodeStatesJson.err_n.status, 'completed');

  // 6. DX_FLOW_DELAY_TICK_MS='0' disables ticker; default is 15000; tickFlowScheduler ticks schedule, delay, & expires overdue approvals under PG advisory lock + RLS bypass
  const prevTickEnv = process.env.DX_FLOW_DELAY_TICK_MS;
  const prevRlsEnv = process.env.DX_PG_RLS_SESSION;
  try {
    process.env.DX_FLOW_DELAY_TICK_MS = '0';
    const disabledPlugin = Object.create(DxosStudioPlugin.prototype);
    disabledPlugin.app = { resourceManager: { use() {}, define() {} }, acl: { registerSnippet() {}, allow() {} } };
    disabledPlugin.db = makeFlowDb();
    await disabledPlugin.load();
    assert.equal(disabledPlugin._delayTicker ?? null, null, "DX_FLOW_DELAY_TICK_MS='0' must disable setInterval");
    await disabledPlugin.destroy();

    delete process.env.DX_FLOW_DELAY_TICK_MS;
    const defaultPlugin = Object.create(DxosStudioPlugin.prototype);
    defaultPlugin.app = { resourceManager: { use() {}, define() {} }, acl: { registerSnippet() {}, allow() {} } };
    defaultPlugin.db = makeFlowDb();
    await defaultPlugin.load();
    assert.ok(defaultPlugin._delayTicker, 'Default DX_FLOW_DELAY_TICK_MS (15000) must start ticker');
    await defaultPlugin.destroy();

    // Verify tickFlowScheduler with trigger.schedule + control.delay + overdue control.approval expiry under PG RLS & advisory lock
    process.env.DX_PG_RLS_SESSION = 'true';
    const schedQueries = [];
    const schedDb = makeFlowDb({
      latticeAutomationRules: [
        {
          id: 1,
          organizationId: 'org-s',
          ruleKey: 'cron_digest_rule',
          name: 'Cron Digest',
          schemaVersion: 2,
          active: true,
          cronExpression: '*/15 * * * *',
          nextRunAt: new Date('2026-11-24T08:15:00Z'),
          graphJson: {
            version: 2,
            nodes: [
              { id: 't1', type: 'trigger.schedule', config: { cron: '*/15 * * * *', timezone: 'UTC' } },
              { id: 'c1', type: 'data.create', config: { collection: 'latticeServiceTickets', values: { code: 'CRON-TICK', name: 'Cron Fired' } } },
            ],
            edges: [{ id: 'e1', source: 't1', sourceHandle: 'main', target: 'c1' }],
          },
        },
        {
          id: 2,
          organizationId: 'org-s',
          ruleKey: 'delay_tick_rule',
          name: 'Delay Rule',
          schemaVersion: 2,
          active: true,
          graphJson: {
            version: 2,
            nodes: [
              { id: 't1', type: 'trigger.manual', config: {} },
              { id: 'd1', type: 'control.delay', config: { durationSec: 10 } },
              { id: 'c1', type: 'data.create', config: { collection: 'latticeServiceTickets', values: { code: 'DELAY-DONE', name: 'Delay Fired' } } },
            ],
            edges: [
              { id: 'e1', source: 't1', sourceHandle: 'main', target: 'd1' },
              { id: 'e2', source: 'd1', sourceHandle: 'main', target: 'c1' },
            ],
          },
        },
      ],
      latticeAutomationRuns: [
        {
          id: 10,
          organizationId: 'org-s',
          ruleKey: 'delay_tick_rule',
          runUid: 'run_delay_due',
          triggerEventType: 'manual.trigger',
          status: 'suspended',
          suspendedNodeId: 'd1',
          resumeAt: new Date('2026-11-24T08:10:00Z'),
          approvalId: null,
          nodeStatesJson: { t1: { status: 'completed', output: {} }, d1: { status: 'suspended', suspend: { kind: 'delay' } } },
          stepTracesJson: [],
        },
        {
          id: 11,
          organizationId: 'org-s',
          ruleKey: 'delay_tick_rule',
          runUid: 'run_approval_overdue',
          triggerEventType: 'manual.trigger',
          status: 'suspended',
          suspendedNodeId: 'ap1',
          resumeAt: new Date('2026-11-24T08:05:00Z'),
          approvalId: 88,
          nodeStatesJson: { ap1: { status: 'suspended', suspend: { kind: 'approval', approvalId: 88 } } },
          stepTracesJson: [],
        },
      ],
      latticeAiApprovalQueue: [
        { id: 88, organizationId: 'org-s', status: 'pending', expiresAt: new Date('2026-11-24T08:05:00Z') },
      ],
    });
    schedDb.sequelize = {
      getDialect: () => 'postgres',
      transaction: async (fn) => fn({ id: 'tx-sched' }),
      query: async (sql, opts) => {
        schedQueries.push({ sql: String(sql), org: opts?.replacements?.orgId || null });
        if (String(sql).includes('pg_try_advisory_xact_lock')) {
          return [[{ acquired: true }]];
        }
        return [[], { rowCount: 1 }];
      },
    };

    const tickOut = await tickFlowScheduler(schedDb, { now: new Date('2026-11-24T08:16:00Z') });
    assert.equal(tickOut.scheduled.processedCount, 1);
    assert.equal(tickOut.delayed.processedCount, 1);
    assert.equal(tickOut.expired.processedCount, 1);
    assert.equal(schedDb.store.latticeServiceTickets.some((t) => t.code === 'CRON-TICK'), true);
    assert.equal(schedDb.store.latticeServiceTickets.some((t) => t.code === 'DELAY-DONE'), true);
    assert.equal(new Date(schedDb.store.latticeAutomationRules[0].nextRunAt).toISOString(), '2026-11-24T08:30:00.000Z');
    assert.equal(schedDb.store.latticeAutomationRuns.find((r) => r.runUid === 'run_approval_overdue').status, 'expired');
    assert.equal(schedDb.store.latticeAiApprovalQueue[0].status, 'expired');
    assert.ok(schedQueries.some((q) => q.sql.includes("set_config('app.rls_bypass', 'on', true)")));
    assert.ok(schedQueries.some((q) => q.sql.includes('pg_try_advisory_xact_lock')));
    assert.ok(schedQueries.some((q) => q.sql.includes("set_config('app.current_org'") && q.org === 'org-s'));

    // Also test direct tickExpiredApprovals skips non-expired approvals
    const expDirect = await tickExpiredApprovals(schedDb, { now: new Date('2026-11-24T08:16:00Z') });
    assert.equal(expDirect.processedCount, 0);
  } finally {
    if (prevTickEnv === undefined) delete process.env.DX_FLOW_DELAY_TICK_MS;
    else process.env.DX_FLOW_DELAY_TICK_MS = prevTickEnv;
    if (prevRlsEnv === undefined) delete process.env.DX_PG_RLS_SESSION;
    else process.env.DX_PG_RLS_SESSION = prevRlsEnv;
  }
});
