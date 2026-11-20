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
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const React = {
  Fragment: 'Fragment',
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
};

test('dxos-blocks helpers reject unsafe URLs, enforce ACL button filtering, and parse KPI metrics safely', () => {
  const { isSafeAppPath, filterHeroActions, parseKpiMetrics } = require(path.join(PLUGIN_ROOT, 'src/client/blocks-helpers.js'));

  assert.equal(isSafeAppPath('/p/procurement'), true);
  assert.equal(isSafeAppPath('/admin/lattice-workspace?view=apps'), true);
  assert.equal(isSafeAppPath('javascript:alert(1)'), false);
  assert.equal(isSafeAppPath('https://evil.invalid/phish'), false);
  assert.equal(isSafeAppPath('//evil.invalid/proto'), false);
  assert.equal(isSafeAppPath('/p/../admin/secret'), false);

  const filtered = filterHeroActions(
    [
      { label: 'Tạo yêu cầu', path: '/p/procurement/create', requiredAction: 'latticeRequests:create' },
      { label: 'Xóa', path: '/p/procurement/delete', requiredAction: 'latticeRequests:destroy' },
      { label: 'Bad', path: 'javascript:alert(1)' },
    ],
    { allowAll: false, actions: { 'latticeRequests:create': {} } },
  );
  assert.deepEqual(filtered.map((x) => x.label), ['Tạo yêu cầu']);

  const metrics = parseKpiMetrics([
    { label: 'Yêu cầu', collection: 'latticeRequests', color: '#1677ff', targetPath: '/p/procurement' },
    { label: 'Bad Coll', collection: 'bad collection!', color: '#000' },
    { label: 'Safe Filter', collection: 'latticeOrders', filter: '{"status":"submitted"}', targetPath: 'javascript:x' },
  ]);
  assert.equal(metrics.length, 2);
  assert.deepEqual(metrics[1].filter, { status: 'submitted' });
  assert.equal(metrics[1].targetPath, null);
});

test('registerDxosBlockModels registers all 6 configurable BlockModel subclasses with flowEngine settings flows', () => {
  const { registerDxosBlockModels } = require(path.join(PLUGIN_ROOT, 'src/client/block-models.js'));

  class MockBlockModel {
    constructor(opts = {}) { this.props = opts.props || {}; }
    setProps(next) { this.props = { ...this.props, ...next }; }
    static define(meta) { this.meta = meta; }
    static registerFlow(flow) { this.flows = [...(this.flows || []), flow]; }
  }

  const registered = {};
  const mockFlowEngine = {
    registerModels(models) { Object.assign(registered, models); },
  };
  const mockClient = {
    useAPIClient: () => null,
    useUIConfigurationPermissions: () => ({ allowConfigUI: false }),
  };

  const models = registerDxosBlockModels(mockClient, React, {}, { BlockModel: MockBlockModel }, mockFlowEngine, {});
  const expectedNames = [
    'DxosPortalHeroBlockModel',
    'DxosKpiMetricBlockModel',
    'DxosContextTelemetryBlockModel',
    'DxosAiProposalBlockModel',
    'DxosWorkflowTasksBlockModel',
    'DxosParaVaultBlockModel',
  ];
  assert.deepEqual(Object.keys(models).sort(), expectedNames.slice().sort());
  assert.deepEqual(Object.keys(registered).sort(), expectedNames.slice().sort());

  for (const name of expectedNames) {
    const Cls = models[name];
    assert.ok(Cls.meta?.label, `${name} missing label`);
    const flow = Cls.flows?.find((f) => f.key === 'dxosBlockSettings');
    assert.ok(flow, `${name} missing dxosBlockSettings flow`);
    assert.ok(flow.steps?.config?.uiSchema, `${name} missing config uiSchema`);
    const inst = new Cls();
    flow.steps.config.handler({ model: inst }, { title: 'Custom Title' });
    assert.equal(inst.props.title, 'Custom Title');
  }
});

test('DX-OS workflow tasks & P.A.R.A. helpers use listMine and degrade cleanly on 404', async () => {
  const { fetchWorkflowTasks, fetchParaVault, fetchParaSummary } = require(path.join(PLUGIN_ROOT, 'src/client/blocks-helpers.js'));

  const calledUrls = [];
  const api = {
    async request(req) {
      calledUrls.push(req.url);
      if (req.url === 'workflowManualTasks:listMine') {
        return { data: { data: [{ id: 1, status: 0, node: { title: 'Duyệt đơn' } }] } };
      }
      if (req.url === 'latticeParaDocuments:list') {
        const err = new Error('Not found');
        err.response = { status: 404 };
        throw err;
      }
      if (req.url === 'latticePara:summary') {
        return { data: { data: { organizationId: null, organizations: ['native-ui-lab', 'demo-organization-01'] } } };
      }
      throw new Error('Unexpected URL: ' + req.url);
    },
  };

  const tasksRes = await fetchWorkflowTasks(api, { statusFilter: 'pending', pageSize: 5 });
  assert.ok(calledUrls.includes('workflowManualTasks:listMine'));
  assert.ok(!calledUrls.some((u) => u === 'workflowManualTasks:list'));
  assert.equal(tasksRes.items.length, 1);

  const paraRes = await fetchParaVault(api, { paraSpace: 'projects', pageSize: 6 });
  assert.equal(paraRes.pluginDisabled, true);
  assert.deepEqual(paraRes.items, []);

  assert.equal(typeof fetchParaSummary, 'function');
  const sumRes = await fetchParaSummary(api);
  assert.deepEqual(sumRes.organizations, ['native-ui-lab', 'demo-organization-01']);
});

test('dxosBlockSettings stepParams take precedence over stale props and renderComponent passes fresh liveConfig', () => {
  const { registerDxosBlockModels } = require(path.join(PLUGIN_ROOT, 'src/client/block-models.js'));

  class MockBlockModel {
    constructor(opts = {}) {
      this.props = opts.props || {};
      this.stepParams = opts.stepParams || {};
    }
    setProps(next) { this.props = { ...this.props, ...next }; }
    getStepParams(flowKey, stepKey) { return this.stepParams?.[flowKey]?.[stepKey]; }
    static define(meta) { this.meta = meta; }
    static registerFlow(flow) { this.flows = [...(this.flows || []), flow]; }
  }

  const registered = {};
  const models = registerDxosBlockModels(
    { useAPIClient: () => null, useUIConfigurationPermissions: () => ({ allowAll: false }) },
    React,
    {},
    { BlockModel: MockBlockModel },
    { registerModels(m) { Object.assign(registered, m); } },
    {},
  );

  const Hero = models.DxosPortalHeroBlockModel;
  const hero = new Hero({
    props: { title: 'Stale Prop Title' },
    stepParams: { dxosBlockSettings: { config: { title: 'Live Step Title', badge: 'LIVE' } } },
  });
  const el = hero.renderComponent();
  assert.equal(el.props.liveConfig?.title, 'Live Step Title');
  assert.equal(el.props.liveConfig?.badge, 'LIVE');

  const { readModelConfig } = require(path.join(PLUGIN_ROOT, 'src/client/block-models.js'));
  assert.equal(typeof readModelConfig, 'function');
  const merged = readModelConfig(hero, { title: 'Default' }, el.props.liveConfig);
  assert.equal(merged.title, 'Live Step Title');
});
