/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createBridge } = require('../../action-bridge/bridge.cjs');
const { createRuleEditorComponent } = require('../src/applications/incident/rule-editor');

const sampleRules = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    schemaId: 'incident-rule',
    schemaVersion: 1,
    title: 'Cảnh báo nhiệt độ máy phát P-01',
    version: 4,
    attributes: {
      assetEntityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      attribute: 'temperature',
      operator: 'gt',
      threshold: '65',
      unit: 'celsius',
      severity: 'high',
      cooldownSeconds: '300',
      maxObservationAgeSeconds: '300',
      workflowDefinitionId: 'incident-response',
      workflowDefinitionVersion: '1',
      handlerId: 'alice',
      enabled: true
    }
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    schemaId: 'incident-rule',
    schemaVersion: 1,
    title: 'Độ ẩm phòng server vượt ngưỡng',
    version: 2,
    attributes: {
      assetEntityId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      attribute: 'humidity',
      operator: 'gt',
      threshold: '80',
      unit: 'percent',
      severity: 'critical',
      cooldownSeconds: '900',
      maxObservationAgeSeconds: '120',
      workflowDefinitionId: 'incident-response',
      workflowDefinitionVersion: '1',
      handlerId: 'warehouse',
      enabled: false
    }
  }
];

const sampleAssets = [
  { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', schemaId: 'incident-asset', schemaVersion: 1, version: 1, title: 'Máy phát điện Cummins', attributes: { status: 'ready', serial: 'GEN-01' } },
  { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', schemaId: 'incident-asset', schemaVersion: 1, version: 1, title: 'Tủ Server Trung tâm', attributes: { status: 'ready', serial: 'SRV-02' } }
];

function hooks() {
  const slots = [];
  let index = 0, queue = [];
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    Fragment: ({ children }) => children,
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
    useState(value) {
      const i = index++;
      if (!slots[i]) slots[i] = { value };
      return [slots[i].value, next => (slots[i].value = typeof next === 'function' ? next(slots[i].value) : next)];
    },
    useRef(value) {
      const i = index++;
      if (!slots[i]) slots[i] = { current: value };
      return slots[i];
    },
    useCallback(fn, deps) {
      const i = index++;
      if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { deps, fn };
      return slots[i].fn;
    },
    useMemo(fn, deps) {
      const i = index++;
      if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { deps, value: fn() };
      return slots[i].value;
    },
    useEffect(fn, deps) {
      const i = index++;
      if (!slots[i] || !same(slots[i].deps, deps))
        queue.push(() => {
          slots[i]?.cleanup?.();
          slots[i] = { deps, cleanup: fn() };
        });
    }
  };
  return {
    react,
    render(fn) {
      index = 0;
      const tree = fn();
      const effects = queue;
      queue = [];
      effects.forEach(f => f());
      return tree;
    }
  };
}

function find(tree, predicate) {
  if (!tree || typeof tree !== 'object') return null;
  if (predicate(tree)) return tree;
  for (const child of tree.children || []) {
    const result = find(child, predicate);
    if (result) return result;
  }
  return null;
}

function findAll(tree, predicate) {
  const results = [];
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (predicate(node)) results.push(node);
    for (const child of node.children || []) walk(child);
  }
  walk(tree);
  return results;
}

const tick = () => new Promise(setImmediate);

async function bridgeFixture({ entityRows = {}, writeStatuses = [], entityListStatuses = [] } = {}) {
  const calls = [];
  const statuses = [...writeStatuses];
  const listStatuses = [...entityListStatuses];
  const bridge = createBridge({
    gatewayUrl: 'http://gateway',
    tokenUrl: 'http://identity/token',
    userinfoUrl: 'http://identity/user',
    authorizationUrl: 'http://identity/auth',
    clientId: 'fixture',
    callbackUrl: 'http://localhost/callback'
  }, {
    schedule: () => ({ unref() {} }),
    cancelTimer: () => {},
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith('/token')) return Response.json({ access_token: 'fixture-token', expires_in: 300 });
      if (url.endsWith('/user')) return Response.json({ sub: 'alice' });
      if (url.endsWith('/actions')) return Response.json({ items: [] });
      if (url.includes('/v1/entities?')) {
        const status = listStatuses.shift() || 200;
        const schemaId = new URL(url).searchParams.get('schemaId');
        return Response.json(status >= 400 ? { error: 'Fixture entity list failed' } : { items: entityRows[schemaId] || [] }, { status });
      }
      const status = statuses.shift() || 200;
      return Response.json(status >= 400 ? { error: 'Fixture write failed' } : { id: sampleRules[0].id }, { status });
    }
  });
  const start = bridge.connect('noco');
  await bridge.callback({ state: new URL(start.authorizationUrl).searchParams.get('state'), code: 'fixture' }, start.browserId);
  const api = {
    entity: (operation, params = {}) => bridge.entity('noco', start.browserId, { operation, ...params })
  };
  return {
    api,
    calls,
    connection: { connected: true, identity: { subject: 'alice', username: 'Alice' } },
    close: () => bridge.disconnect('noco', start.browserId)
  };
}

function entityWrites(fixture, method) {
  return fixture.calls.filter(call => call.options.method === method && call.url.includes('/v1/entities'));
}

test('RuleEditor renders rule list with status, conditions and severity tags', async () => {
  const fixture = await bridgeFixture({ entityRows: { 'incident-rule': sampleRules, 'incident-asset': sampleAssets } });
  const { api } = fixture;

  const env = hooks();
  const RuleEditor = createRuleEditorComponent(env.react);
  const render = (override = {}) => env.render(() => RuleEditor({ api, connection: fixture.connection, ...override }));

  let tree = render();
  await tick();
  tree = render();

  const root = find(tree, n => n.props?.['data-testid'] === 'rule-editor-view');
  assert.ok(root, 'Root container must render');

  const rows = findAll(tree, n => typeof n.props?.['data-testid'] === 'string' && n.props['data-testid'].startsWith('rule-row-'));
  assert.equal(rows.length, 2, 'Should display 2 sample rule rows');

  const content = JSON.stringify(tree);
  assert.ok(content.includes('Cảnh báo nhiệt độ máy phát P-01'));
  assert.ok(content.includes('Độ ẩm phòng server vượt ngưỡng'));
  assert.ok(content.includes('temperature > 65 celsius'));
  assert.ok(content.includes('humidity > 80 percent'));
  assert.ok(content.includes('Đang bật'));
  assert.ok(content.includes('Đã tắt'));
  assert.ok(fixture.calls.some(call => call.url === 'http://gateway/v1/entities?schemaId=incident-rule&limit=100&offset=0'));
  assert.ok(fixture.calls.some(call => call.url === 'http://gateway/v1/entities?schemaId=incident-asset&limit=100&offset=0'));

  const connection = { ...fixture.connection };
  const renderWithScope = () => env.render(() => RuleEditor({ api, connection }));
  find(tree, node => node.props?.['data-testid'] === 'open-create-rule-btn').props.onClick();
  tree = renderWithScope();
  const threshold = find(tree, node => node.props?.['data-testid'] === 'rule-threshold-input');
  assert.deepEqual(threshold.children.map(option => option.props.value), ['0', '5', '10', '15', '20', '25', '30', '35', '40', '50', '60', '70', '80', '90', '100']);

  // During the render before the new account's effect runs, old records are hidden.
  connection.identity = { subject: 'bob', organizationId: 'org-2' };
  tree = renderWithScope();
  assert.equal(JSON.stringify(tree).includes(sampleRules[0].title), false);
  await tick();
  renderWithScope();
  fixture.close();
});

test('RuleEditor reports a failed entity list instead of presenting it as an empty successful read', async () => {
  const fixture = await bridgeFixture({ entityListStatuses: [503] });
  const env = hooks();
  const RuleEditor = createRuleEditorComponent(env.react);
  const render = () => env.render(() => RuleEditor({ api: fixture.api, connection: fixture.connection }));

  render(); await tick();
  const tree = render();

  assert.ok(find(tree, node => node.props?.['data-testid'] === 'rule-editor-error'));
  assert.equal(findAll(tree, node => typeof node.props?.['data-testid'] === 'string' && node.props['data-testid'].startsWith('rule-row-')).length, 0);
  fixture.close();
});

test('RuleEditor validates required fields before creating a rule', async () => {
  const fixture = await bridgeFixture({ entityRows: { 'incident-rule': [], 'incident-asset': [] } });
  const { api } = fixture;

  const env = hooks();
  const RuleEditor = createRuleEditorComponent(env.react);
  const render = () => env.render(() => RuleEditor({ api, connection: fixture.connection }));

  let tree = render();
  await tick();
  tree = render();

  // Open creation form
  const openBtn = find(tree, n => n.props?.['data-testid'] === 'open-create-rule-btn');
  assert.ok(openBtn);
  openBtn.props.onClick();
  tree = render();

  // Submit with empty fields
  const form = find(tree, n => n.props?.['data-testid'] === 'create-rule-form');
  assert.ok(form, 'Form should be displayed');
  await form.props.onSubmit();
  tree = render();

  assert.ok(JSON.stringify(tree).includes('Vui lòng nhập tên luật cảnh báo.'));
  assert.equal(entityWrites(fixture, 'POST').length, 0, 'Must not call API when fields are empty');

  // The entity schema stores the rule name in the entity title, not code/name attributes.
  const nameInput = find(tree, n => n.props?.['data-testid'] === 'rule-name-input');
  nameInput.props.onChange({ target: { value: 'Cảnh báo pin yếu xe nâng' } });
  tree = render();

  await find(tree, n => n.props?.['data-testid'] === 'create-rule-form').props.onSubmit();
  tree = render();
  assert.ok(JSON.stringify(tree).includes('Vui lòng chọn hoặc nhập mã tài sản'));

  // Fill asset and change attribute to batteryLevel
  const assetInput = find(tree, n => n.props?.['data-testid'] === 'rule-asset-input');
  assetInput.props.onChange({ target: { value: sampleAssets[0].id } });

  const attrSelect = find(tree, n => n.props?.['data-testid'] === 'rule-attribute-select');
  attrSelect.props.onChange({ target: { value: 'batteryLevel' } });

  const opSelect = find(tree, n => n.props?.['data-testid'] === 'rule-operator-select');
  opSelect.props.onChange({ target: { value: 'lt' } });

  const thresholdInput = find(tree, n => n.props?.['data-testid'] === 'rule-threshold-input');
  thresholdInput.props.onChange({ target: { value: '15' } });

  tree = render();
  await find(tree, n => n.props?.['data-testid'] === 'create-rule-form').props.onSubmit();
  await tick();
  tree = render();



  const [createCall] = entityWrites(fixture, 'POST');
  assert.ok(createCall, 'Rule should be submitted through the entity bridge');
  const createdPayload = JSON.parse(createCall.options.body);
  assert.deepEqual(createdPayload, {
    schemaId: 'incident-rule',
    title: 'Cảnh báo pin yếu xe nâng',
    attributes: {
      assetEntityId: sampleAssets[0].id,
      attribute: 'batteryLevel',
      operator: 'lt',
      threshold: '15',
      unit: 'percent',
      severity: 'high',
      cooldownSeconds: '300',
      maxObservationAgeSeconds: '300',
      workflowDefinitionId: 'incident-response',
      workflowDefinitionVersion: '1',
      handlerId: 'alice',
      enabled: true
    }
  });
  assert.ok(createCall.options.headers['idempotency-key']);
  assert.equal(Object.hasOwn(createdPayload.attributes, 'code'), false);
  assert.equal(Object.hasOwn(createdPayload.attributes, 'name'), false);

  const successNode = find(tree, n => n.props?.['data-testid'] === 'rule-editor-success');
  assert.ok(successNode, 'Success alert should be displayed');
  assert.ok(successNode.children[0].includes('Cảnh báo pin yếu xe nâng'));
  fixture.close();
});

test('RuleEditor does not report a successful create when the actor identity is missing', async () => {
  const fixture = await bridgeFixture({ entityRows: { 'incident-rule': [], 'incident-asset': [] } });
  const env = hooks();
  const RuleEditor = createRuleEditorComponent(env.react);
  const render = () => env.render(() => RuleEditor({ api: fixture.api, connection: { connected: true, identity: {} } }));

  render(); await tick();
  let tree = render();
  find(tree, node => node.props?.['data-testid'] === 'open-create-rule-btn').props.onClick();
  tree = render();
  find(tree, node => node.props?.['data-testid'] === 'rule-name-input').props.onChange({ target: { value: 'Identity required' } });
  find(tree, node => node.props?.['data-testid'] === 'rule-asset-input').props.onChange({ target: { value: sampleAssets[0].id } });
  tree = render();

  await find(tree, node => node.props?.['data-testid'] === 'create-rule-form').props.onSubmit();
  tree = render();

  assert.equal(entityWrites(fixture, 'POST').length, 0);
  assert.equal(find(tree, node => node.props?.['data-testid'] === 'rule-editor-success'), null);
  assert.ok(JSON.stringify(tree).includes('Chưa kết nối'));
  fixture.close();
});

test('RuleEditor toggles rule enable/disable and handles 403 permission error', async () => {
  const fixture = await bridgeFixture({ entityRows: { 'incident-rule': [sampleRules[0]], 'incident-asset': sampleAssets } });
  const { api } = fixture;

  const env = hooks();
  const RuleEditor = createRuleEditorComponent(env.react);
  const render = () => env.render(() => RuleEditor({ api, connection: fixture.connection }));

  let tree = render();
  await tick();
  tree = render();

  const toggleBtn = find(tree, n => n.props?.['data-testid'] === `toggle-rule-btn-${sampleRules[0].id}`);
  assert.ok(toggleBtn);
  assert.equal(toggleBtn.children[0], 'Đang bật');

  await toggleBtn.props.onClick();
  tree = render();

  const [updateCall] = entityWrites(fixture, 'PATCH');
  assert.ok(updateCall, 'Update must pass through the entity bridge');
  assert.equal(updateCall.url, `http://gateway/v1/entities/${sampleRules[0].id}`);
  assert.deepEqual(JSON.parse(updateCall.options.body), {
    expectedVersion: sampleRules[0].version,
    title: sampleRules[0].title,
    attributes: { ...sampleRules[0].attributes, enabled: false }
  });
  assert.ok(updateCall.options.headers['idempotency-key']);
  fixture.close();

  // Test 403 authority denied on create
  const deniedFixture = await bridgeFixture({
    entityRows: { 'incident-rule': [], 'incident-asset': [] },
    writeStatuses: [403]
  });
  const deniedApi = deniedFixture.api;

  const env2 = hooks();
  const RuleEditor2 = createRuleEditorComponent(env2.react);
  const render2 = () => env2.render(() => RuleEditor2({ api: deniedApi, connection: deniedFixture.connection }));

  let tree2 = render2();
  await tick();
  tree2 = render2();

  find(tree2, n => n.props?.['data-testid'] === 'open-create-rule-btn').props.onClick();
  tree2 = render2();

  find(tree2, n => n.props?.['data-testid'] === 'rule-name-input').props.onChange({ target: { value: 'Test' } });
  find(tree2, n => n.props?.['data-testid'] === 'rule-asset-input').props.onChange({ target: { value: 'asset-1' } });
  tree2 = render2();

  const form2 = find(tree2, n => n.props?.['data-testid'] === 'create-rule-form');
  await form2.props.onSubmit();
  tree2 = render2();

  assert.ok(JSON.stringify(tree2).includes('Bạn không có quyền cấu hình luật cảnh báo sự cố.'));
  deniedFixture.close();
});

test('RuleEditor archives a rule with its current version', async () => {
  const fixture = await bridgeFixture({ entityRows: { 'incident-rule': [sampleRules[0]], 'incident-asset': sampleAssets } });
  const env = hooks();
  const RuleEditor = createRuleEditorComponent(env.react);
  const render = () => env.render(() => RuleEditor({ api: fixture.api, connection: fixture.connection }));

  render(); await tick();
  let tree = render();
  const archive = find(tree, n => n.props?.['data-testid'] === `archive-rule-btn-${sampleRules[0].id}`);
  assert.ok(archive, 'Rule action should be archive');
  await archive.props.onClick();

  const [archiveCall] = entityWrites(fixture, 'POST');
  assert.ok(archiveCall, 'Archive must pass through the real entity validator');
  assert.equal(archiveCall.url, `http://gateway/v1/entities/${sampleRules[0].id}/archive`);
  assert.deepEqual(JSON.parse(archiveCall.options.body), { expectedVersion: sampleRules[0].version });
  assert.ok(archiveCall.options.headers['idempotency-key']);
  fixture.close();
});

test('RuleEditor retries an uncertain create with the same key and frozen body', async () => {
  const fixture = await bridgeFixture({
    entityRows: { 'incident-rule': [], 'incident-asset': [] },
    writeStatuses: [503, 201]
  });
  const env = hooks();
  const RuleEditor = createRuleEditorComponent(env.react);
  const render = () => env.render(() => RuleEditor({ api: fixture.api, connection: fixture.connection }));

  render(); await tick();
  let tree = render();
  find(tree, n => n.props?.['data-testid'] === 'open-create-rule-btn').props.onClick();
  tree = render();
  find(tree, n => n.props?.['data-testid'] === 'rule-name-input').props.onChange({ target: { value: 'Retry rule' } });
  find(tree, n => n.props?.['data-testid'] === 'rule-asset-input').props.onChange({ target: { value: sampleAssets[0].id } });
  tree = render();
  await find(tree, n => n.props?.['data-testid'] === 'create-rule-form').props.onSubmit();
  tree = render();

  const retry = find(tree, n => n.props?.['data-testid'] === 'retry-rule-command-btn');
  assert.ok(retry, 'Uncertain write should offer a retry');
  await retry.props.onClick();
  await tick();

  const creates = entityWrites(fixture, 'POST').filter(call => call.url === 'http://gateway/v1/entities');
  assert.equal(creates.length, 2);
  assert.equal(creates[0].options.headers['idempotency-key'], creates[1].options.headers['idempotency-key']);
  assert.equal(creates[0].options.body, creates[1].options.body);
  fixture.close();
});
