// SPDX-License-Identifier: Apache-2.0
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRuleEditorComponent } = require('../src/applications/incident/rule-editor');

const sampleRules = [
  {
    id: 'rule-temp-01',
    attributes: {
      code: 'RULE-TMP-01',
      name: 'Cảnh báo nhiệt độ máy phát P-01',
      assetEntityId: 'asset-generator-01',
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
    id: 'rule-humidity-02',
    attributes: {
      code: 'RULE-HUM-02',
      name: 'Độ ẩm phòng server vượt ngưỡng',
      assetEntityId: 'asset-server-rack',
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
  { id: 'asset-generator-01', attributes: { assetCode: 'ASSET-GEN-01', name: 'Máy phát điện Cummins' } },
  { id: 'asset-server-rack', attributes: { assetCode: 'ASSET-SRV-02', name: 'Tủ Server Trung tâm' } }
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

test('RuleEditor renders rule list with status, conditions and severity tags', async () => {
  const api = {
    entity: async (op, params) => {
      if (op === 'list' && params?.schemaId === 'incident-rule') return { items: sampleRules };
      if (op === 'list' && params?.schemaId === 'asset') return { items: sampleAssets };
      return { items: [] };
    }
  };

  const env = hooks();
  const RuleEditor = createRuleEditorComponent(env.react);
  const render = (override = {}) => env.render(() => RuleEditor({ api, connection: { connected: true }, ...override }));

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
});

test('RuleEditor validates required fields before creating a rule', async () => {
  let createdPayload = null;
  const api = {
    entity: async (op, params) => {
      if (op === 'list') return { items: [] };
      if (op === 'create') {
        createdPayload = params.body;
        return { id: 'new-rule-id', attributes: params.body };
      }
      return { items: [] };
    }
  };

  const env = hooks();
  const RuleEditor = createRuleEditorComponent(env.react);
  const render = () => env.render(() => RuleEditor({ api, connection: { connected: true } }));

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

  assert.ok(JSON.stringify(tree).includes('Vui lòng nhập mã luật cảnh báo.'));
  assert.equal(createdPayload, null, 'Must not call API when fields are empty');

  // Fill code and name
  const codeInput = find(tree, n => n.props?.['data-testid'] === 'rule-code-input');
  codeInput.props.onChange({ target: { value: 'RULE-BAT-03' } });
  const nameInput = find(tree, n => n.props?.['data-testid'] === 'rule-name-input');
  nameInput.props.onChange({ target: { value: 'Cảnh báo pin yếu xe nâng' } });
  tree = render();

  await find(tree, n => n.props?.['data-testid'] === 'create-rule-form').props.onSubmit();
  tree = render();
  assert.ok(JSON.stringify(tree).includes('Vui lòng chọn hoặc nhập mã tài sản'));

  // Fill asset and change attribute to batteryLevel
  const assetInput = find(tree, n => n.props?.['data-testid'] === 'rule-asset-input');
  assetInput.props.onChange({ target: { value: 'asset-forklift-01' } });

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



  assert.ok(createdPayload !== null, 'Rule should be submitted');
  assert.equal(createdPayload.code, 'RULE-BAT-03');
  assert.equal(createdPayload.name, 'Cảnh báo pin yếu xe nâng');
  assert.equal(createdPayload.assetEntityId, 'asset-forklift-01');
  assert.equal(createdPayload.attribute, 'batteryLevel');
  assert.equal(createdPayload.operator, 'lt');
  assert.equal(createdPayload.threshold, '15');
  assert.equal(createdPayload.unit, 'percent');
  assert.equal(createdPayload.workflowDefinitionId, 'incident-response');
  assert.equal(createdPayload.enabled, true);

  const successNode = find(tree, n => n.props?.['data-testid'] === 'rule-editor-success');
  assert.ok(successNode, 'Success alert should be displayed');
  assert.ok(successNode.children[0].includes('Cảnh báo pin yếu xe nâng'));


});

test('RuleEditor toggles rule enable/disable and handles 403 permission error', async () => {
  let updatedRule = null;
  const api = {
    entity: async (op, params) => {
      if (op === 'list') return { items: [sampleRules[0]] };
      if (op === 'update') {
        updatedRule = params.body;
        return { id: params.id, attributes: params.body };
      }
      return { items: [] };
    }
  };

  const env = hooks();
  const RuleEditor = createRuleEditorComponent(env.react);
  const render = () => env.render(() => RuleEditor({ api, connection: { connected: true } }));

  let tree = render();
  await tick();
  tree = render();

  const toggleBtn = find(tree, n => n.props?.['data-testid'] === 'toggle-rule-btn-rule-temp-01');
  assert.ok(toggleBtn);
  assert.equal(toggleBtn.children[0], 'Đang bật');

  await toggleBtn.props.onClick();
  tree = render();

  assert.ok(updatedRule !== null);
  assert.equal(updatedRule.enabled, false);

  // Test 403 authority denied on create
  const deniedApi = {
    entity: async (op) => {
      if (op === 'list') return { items: [] };
      if (op === 'create') throw { status: 403, code: 'authority_denied' };
      return { items: [] };
    }
  };

  const env2 = hooks();
  const RuleEditor2 = createRuleEditorComponent(env2.react);
  const render2 = () => env2.render(() => RuleEditor2({ api: deniedApi, connection: { connected: true } }));

  let tree2 = render2();
  await tick();
  tree2 = render2();

  find(tree2, n => n.props?.['data-testid'] === 'open-create-rule-btn').props.onClick();
  tree2 = render2();

  find(tree2, n => n.props?.['data-testid'] === 'rule-code-input').props.onChange({ target: { value: 'TEST' } });
  find(tree2, n => n.props?.['data-testid'] === 'rule-name-input').props.onChange({ target: { value: 'Test' } });
  find(tree2, n => n.props?.['data-testid'] === 'rule-asset-input').props.onChange({ target: { value: 'asset-1' } });
  tree2 = render2();

  const form2 = find(tree2, n => n.props?.['data-testid'] === 'create-rule-form');
  await form2.props.onSubmit();
  tree2 = render2();

  assert.ok(JSON.stringify(tree2).includes('Bạn không có quyền cấu hình luật cảnh báo sự cố.'));
});
