/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const assert=require('node:assert/strict');
const test=require('node:test');
const {incidentProcessTemplate}=require('../src/server/native-process-template');
const {createIntegrationActions}=require('../src/server/native-integrations');
const {validateIncidentNotes}=require('../src/server/native-identity-hooks');
const {createNativeScopeMiddleware}=require('../src/server/native-scope');
const definitions=require('../src/server/schema');
const {createIncidentEvidence}=require('../src/client/native-incident-evidence');

function findNode(nodes, key) { return nodes.find(n => n.key === key); }

test('native incident separates reviewer, handler and closing tasks, and terminates rejected branch cleanly',()=>{
  const template=incidentProcessTemplate({organizationId:'org-a',reviewerEmployeeId:1,assigneeEmployeeId:2});
  assert.equal(template.workflow.config.collection,'latticeIncidentCases');
  assert.deepEqual(template.nodes.filter(node=>node.type==='manual').map(node=>node.key),['review','resolution','close']);
  assert.throws(()=>incidentProcessTemplate({organizationId:'org-a',reviewerEmployeeId:1,assigneeEmployeeId:'1'}));

  const rejected = findNode(template.nodes, 'rejected');
  const markRejected = findNode(template.nodes, 'markRejected');
  const endRejected = findNode(template.nodes, 'endRejected');
  assert.equal(rejected.upstreamKey, 'approved');
  assert.equal(rejected.branchIndex, 0);
  assert.equal(markRejected.upstreamKey, 'rejected');
  assert.equal(endRejected.type, 'end');
  assert.equal(endRejected.config.endStatus, 1);
  assert.equal(endRejected.upstreamKey, 'markRejected');

  for (const key of ['resolution', 'close']) {
    const manual = findNode(template.nodes, key);
    const props = manual.config.schema.tab1.properties.grid.properties.row.properties.column.properties.formBlock.properties[key].properties;
    assert.equal(props.note['x-component-props'].maxLength, 255);
    const detailProps = manual.config.schema.tab1.properties.grid.properties.detailRow.properties.column.properties.details.properties.form.properties;
    assert.ok(detailProps.severity);
  }
  for (const condKey of ['resolutionPresent', 'closeNotePresent']) {
    const cond = findNode(template.nodes, condKey);
    assert.equal(cond.config.calculation.group.type, 'and');
    assert.equal(cond.config.calculation.group.calculations.length, 2);
  }
});

test('validateIncidentNotes trims valid notes and rejects blank or >255 char notes for resolved/closed cases', () => {
  const row = { status: 'resolved', resolutionNote: '  Replaced faulty sensor  ' };
  validateIncidentNotes(row);
  assert.equal(row.resolutionNote, 'Replaced faulty sensor');
  assert.doesNotThrow(() => validateIncidentNotes({ status: 'open', resolutionNote: null }));
  for (const bad of [null, '', '   ', 'a'.repeat(256)]) {
    assert.throws(() => validateIncidentNotes({ status: 'resolved', resolutionNote: bad }), { code: 'NATIVE_INCIDENT_NOTE_INVALID', status: 400 });
    assert.throws(() => validateIncidentNotes({ status: 'closed', closeNote: bad }), { code: 'NATIVE_INCIDENT_NOTE_INVALID', status: 400 });
  }
});

test('native alert enforces connector role, idempotency replay, 409 conflict, active handler, and workflow write guard',async t=>{
  await assert.rejects(createIntegrationActions().receiveAlert({method:'POST',state:{currentRole:'ldx_employee'}}),{status:403});

  const prevFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ data: { id: 10, organizationId: 'org-a', name: 'Pump' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  t.after(() => { global.fetch = prevFetch; });

  const cases = [];
  const employees = [
    { id: 1, userId: 101, organizationId: 'org-a', departmentId: 1, active: true },
    { id: 2, userId: 102, organizationId: 'org-a', departmentId: 1, active: true },
    { id: 3, userId: 103, organizationId: 'org-b', departmentId: 2, active: true },
  ];
  const db = {
    sequelize: { query: async () => {}, transaction: fn => fn({ id: 'tx' }) },
    getRepository(name) {
      if (name === 'latticeEmployees') {
        return {
          find: async ({ filter } = {}) => employees.filter(e => (!filter?.userId || e.userId === filter.userId)),
          findOne: async ({ filter } = {}) => employees.find(e => String(e.id) === String(filter?.id) && e.organizationId === filter?.organizationId && e.active === true && e.userId != null) || null,
        };
      }
      if (name === 'latticeAssets') return { findOne: async ({ filter }) => (String(filter?.id) === '10' && filter?.organizationId === 'org-a' ? { id: 10 } : null) };
      if (name === 'latticeIncidentCases') {
        return {
          findOne: async ({ filter }) => cases.find(c => c.code === filter?.code && c.organizationId === filter?.organizationId) || null,
          create: async ({ values }) => { const row = { id: cases.length + 1, ...values }; cases.push(row); return row; },
        };
      }
      return null;
    },
  };
  const middleware = createNativeScopeMiddleware(db, definitions);
  for (const actionName of ['create', 'update', 'destroy']) {
    await assert.rejects(
      middleware({ action: { resourceName: 'latticeIncidentCases', actionName, params: {} }, state: { currentUser: { id: 101 }, currentRole: 'ldx_manager' } }, async () => {}),
      { code: 'NATIVE_INCIDENT_WORKFLOW_REQUIRED', status: 403 },
    );
  }
  const makeCtx = values => ({
    method: 'POST', state: { currentUser: { id: 101 }, currentRole: 'ldx_connector' },
    action: { params: { values } }, get: k => (k === 'Authorization' ? 'Bearer tok' : null),
    app: { db, name: 'main' }, throw(s, m) { throw Object.assign(new Error(m || 'HTTP ' + s), { status: s }); },
  });
  const actions = createIntegrationActions();
  const c1 = makeCtx({ eventId: 'evt-1', assetId: '10', handlerId: '2', severity: 'high' });
  await actions.receiveAlert(c1);
  assert.deepEqual(c1.body, { id: 1, duplicate: false });
  const c2 = makeCtx({ eventId: 'evt-1', assetId: '10', handlerId: '2', severity: 'high' });
  await actions.receiveAlert(c2);
  assert.deepEqual(c2.body, { id: 1, duplicate: true });
  await assert.rejects(actions.receiveAlert(makeCtx({ eventId: 'evt-1', assetId: '10', handlerId: '2', severity: 'critical' })), { code: 'INTEGRATION_EVENT_CONFLICT', status: 409 });
  await assert.rejects(actions.receiveAlert(makeCtx({ eventId: 'evt-2', assetId: '10', handlerId: '3', severity: 'high' })), { code: 'INTEGRATION_HANDLER_UNAVAILABLE', status: 403 });
});

test('createIncidentEvidence handles valid proposals, stale state, malformed items, and role changes', async () => {
  let cursor = 0, effects = [], state = [], role = 'ldx_manager', reqResult;
  const React = {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: init => { const i = cursor++; if (!(i in state)) state[i] = init; return [state[i], v => { state[i] = typeof v === 'function' ? v(state[i]) : v; }]; },
    useReducer: (fn, init) => { const i = cursor++; if (!(i in state)) state[i] = init; return [state[i], a => { state[i] = fn(state[i], a); }]; },
    useEffect: fn => { effects.push(fn); },
  };
  const api = { auth: { get role() { return role; } }, request: async () => reqResult };
  const client = { useCollectionRecordData: () => ({ id: '5' }), useAPIClient: () => api };
  const antd = { Button: 'Button', Alert: 'Alert' };
  const Comp = createIncidentEvidence(client, React, antd);
  const render = async () => {
    cursor = 0;
    let tree = Comp();
    while (effects.length) effects.shift()();
    await new Promise(r => setImmediate(r));
    cursor = 0;
    return Comp();
  };
  reqResult = { data: { data: { items: [{ id: 1, stale: false, recommendation: 'Check seal', evidence: [{ kind: 'ngsi-ld', entityId: 'urn:ngsi-ld:Asset:org-a:native:1', fingerprint: 'abc' }] }] } } };
  let ui = await render();
  assert.ok(JSON.stringify(ui).includes('Check seal'));

  role = 'ldx_employee';
  reqResult = { data: { data: { items: null } } };
  ui = await render();
  assert.ok(JSON.stringify(ui).includes('Không đọc được đề xuất theo quyền hiện tại.'));
});

test('native case dispatch uses the case id and filters by organization',async()=>{
  const {uc2InboxWorkflow}=await import('../../../../scripts/lib/uc2-inbox-workflow.mjs');
  const workflow=uc2InboxWorkflow({
    organizationId:'org-a',target:'case',
    webhookUrl:'http://n8n/webhook/latticedx/uc2/observation',webhookKey:'fixture-credential-value-123',
  });
  assert.equal(workflow.config.collection,'latticeIncidentCases');
  assert.deepEqual(workflow.config.condition,{organizationId:'org-a',status:'open',code:{$startsWith:'UC2-'}});
  assert.deepEqual(JSON.parse(workflow.request.config.data),{caseId:'{{$context.data.id}}'});
});
