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

test('registerDxosBlockModels registers all 12 configurable BlockModel subclasses with flowEngine settings flows', () => {
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
    'DxosCreativeStudioBlockModel',
    'DxosRecordWorkbenchBlockModel',
    'DxosWebGisBlockModel',
    'DxosKanbanScheduleBlockModel',
    'DxosWmsOpsBlockModel',
    'DxosBiChartBlockModel',
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

test('Dynamic Block Agent Strip resolves portal slug, degrades silently when plugin-dxos-ai disabled, and triggers flowEngine AI task', async () => {
  const {
    inferPortalSlugFromLocation,
    fetchPortalAgents,
    triggerDxosAgent,
    createAgentStripElement,
  } = require(path.join(PLUGIN_ROOT, 'src/client/blocks-helpers.js'));

  assert.equal(inferPortalSlugFromLocation('/p/logistics'), 'logistics');
  assert.equal(inferPortalSlugFromLocation('/p/procurement/overview'), 'procurement');
  assert.equal(inferPortalSlugFromLocation('/admin/dxos-studio'), 'admin-studio');
  assert.equal(inferPortalSlugFromLocation(''), '');

  // Graceful silent degradation when plugin-dxos-ai is disabled (404/403)
  const disabledApi = {
    request: async () => { throw Object.assign(new Error('Not found'), { response: { status: 404 } }); },
  };
  const offRes = await fetchPortalAgents(disabledApi, { portalSlug: 'logistics' });
  assert.equal(offRes.pluginDisabled, true);
  assert.deepEqual(offRes.employees, []);
  assert.equal(createAgentStripElement(React, { employees: [], loading: false }), null);

  // Enabled response returns scoped AI employees + quickPrompts
  const activeApi = {
    request: async ({ url, params }) => {
      assert.equal(url, 'dxosAi:portalAgents');
      assert.equal(params.portalSlug, 'logistics');
      return {
        data: {
          data: {
            employees: [
              {
                username: 'dxos-logistics',
                nickname: 'Điều phối viên Chuỗi lạnh AI',
                quickPrompts: [{ label: 'Việc giao nhận chờ tôi', prompt: 'Kiểm tra công việc logistics chờ xử lý.' }],
              },
            ],
          },
        },
      };
    },
  };
  const onRes = await fetchPortalAgents(activeApi, { portalSlug: 'logistics' });
  assert.equal(onRes.pluginDisabled, false);
  assert.equal(onRes.employees.length, 1);

  const triggeredCalls = [];
  const mockApp = {
    flowEngine: {
      context: {
        ai: {
          async triggerTask(payload) { triggeredCalls.push(payload); },
        },
      },
    },
  };
  const triggerOut = await triggerDxosAgent(mockApp, {
    aiEmployee: 'dxos-logistics',
    prompt: 'Kiểm tra công việc logistics chờ xử lý.',
    blockTitle: 'Hộp việc Logistics',
    portalSlug: 'logistics',
  });
  assert.equal(triggerOut.triggered, true);
  assert.equal(triggeredCalls.length, 1);
  assert.equal(triggeredCalls[0].aiEmployee, 'dxos-logistics');
  assert.equal(triggeredCalls[0].open, true);
  assert.ok(triggeredCalls[0].tasks[0].text.includes('Hộp việc Logistics'));

  const noAiOut = await triggerDxosAgent({}, { aiEmployee: 'dxos-logistics', prompt: 'Test' });
  assert.equal(noAiOut.triggered, false);

  const stripEl = createAgentStripElement(React, {
    employees: onRes.employees,
    onRunPrompt: () => {},
  });
  assert.ok(stripEl && stripEl.props['data-testid'] === 'dxos-block-agent-strip');
});

test('DxosPortalHeroView renders clean page header with zero inline AI strips or bars even for admins', () => {
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

  const models = registerDxosBlockModels(
    { useAPIClient: () => null, useUIConfigurationPermissions: () => ({ allowAll: true, allowConfigUI: true }) },
    React,
    {},
    { BlockModel: MockBlockModel },
    { registerModels() {} },
    {},
  );
  const hero = new models.DxosPortalHeroBlockModel({
    props: { title: 'Kho lạnh QA', badge: 'DX-OS' },
  });
  const wrapperEl = hero.renderComponent();
  const tree = wrapperEl.type(wrapperEl.props);

  const testIds = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.props?.['data-testid']) testIds.push(n.props['data-testid']);
    if (Array.isArray(n.children)) n.children.flat(Infinity).forEach(walk);
  };
  walk(tree);

  assert.ok(testIds.includes('dxos-portal-hero-block'));
  assert.equal(testIds.includes('dxos-block-agent-strip'), false);
  assert.equal(testIds.includes('dxos-admin-architect-bar'), false);
  assert.equal(testIds.includes('dxos-picker-toggle-btn'), false);
  assert.equal(testIds.includes('dxos-rollback-page-btn'), false);
});

test('DxosPortalHeroBlockModel does not register a redundant 2600ms pageSurfaceState polling loop', () => {
  const { registerDxosBlockModels } = require(path.join(PLUGIN_ROOT, 'src/client/block-models.js'));
  const intervals = [];
  const effects = [];
  const origSetInterval = global.setInterval;
  const origWindow = global.window;
  global.setInterval = (fn, ms) => { intervals.push(ms); return 999; };
  global.window = { location: { pathname: '/p/services', reload: () => {} } };
  const ReactWithEffects = {
    ...React,
    useEffect: (fn) => { effects.push(fn); },
  };
  class MockBlockModel {
    constructor(opts = {}) { this.props = opts.props || {}; this.stepParams = opts.stepParams || {}; }
    getStepParams() { return {}; }
    static define() {}
    static registerFlow() {}
  }
  try {
    const models = registerDxosBlockModels(
      { useAPIClient: () => ({ request: async () => ({ data: { data: { revision: 1 } } }) }), useUIConfigurationPermissions: () => ({ allowAll: false }) },
      ReactWithEffects,
      {},
      { BlockModel: MockBlockModel },
      { registerModels() {} },
      {},
    );
    const hero = new models.DxosPortalHeroBlockModel({ props: { title: 'Test' } });
    const el = hero.renderComponent();
    el.type(el.props);
    for (const fx of effects) fx();
    assert.equal(intervals.includes(2600), false, 'Duplicate 2600ms polling loop must be removed from block-models.js');
  } finally {
    global.setInterval = origSetInterval;
    global.window = origWindow;
  }
});

test('DxosRecordWorkbenchBlockModel exposes uiSchema and renders Export Bar, VoucherLifecycleBar, and RecordChatterView', () => {
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

  const models = registerDxosBlockModels(
    { useAPIClient: () => null, useUIConfigurationPermissions: () => ({ allowAll: false }) },
    React,
    {},
    { BlockModel: MockBlockModel },
    { registerModels() {} },
    {},
  );

  const Workbench = models.DxosRecordWorkbenchBlockModel;
  assert.ok(Workbench, 'DxosRecordWorkbenchBlockModel must be registered');
  assert.equal(Workbench.meta.label, 'DX-OS Chatter, Chứng từ & Xuất báo cáo');
  const flow = Workbench.flows.find((f) => f.key === 'dxosBlockSettings');
  const cfgStep = flow.steps.config;
  assert.deepEqual(cfgStep.defaultParams, {
    title: 'Trao đổi Chatter, Chứng từ & Xuất báo cáo',
    collection: 'latticeRequests',
    recordId: '',
    showExport: true,
    showVoucherActions: true,
    showChatter: true,
  });
  for (const field of ['collection', 'recordId', 'showExport', 'showVoucherActions', 'showChatter']) {
    assert.ok(cfgStep.uiSchema[field], `uiSchema missing ${field}`);
  }

  const inst = new Workbench({
    props: { collection: 'latticeOrders', recordId: '12', showExport: true, showVoucherActions: true, showChatter: true },
  });
  const el = inst.renderComponent();
  const tree = el.type(el.props);
  const resolveTree = (node) => {
    if (!node || typeof node !== 'object') return node;
    if (typeof node.type === 'function') return resolveTree(node.type(node.props));
    return {
      ...node,
      children: Array.isArray(node.children) ? node.children.flat(Infinity).map(resolveTree) : node.children,
    };
  };
  const dump = JSON.stringify(resolveTree(tree));
  assert.ok(dump.includes('dxos-record-workbench-block'));
  assert.ok(dump.includes('CSV') && dump.includes('XLSX') && dump.includes('PDF'));
  assert.ok(dump.includes('dxos-voucher-lifecycle-bar'));
  assert.ok(dump.includes('dxos-record-chatter'));
});

test('Task 5: fetchCollectionsMeta & inferCollectionFieldsMeta infer statusField, stages, dateFields, titleField, and geo fields', async () => {
  const { fetchCollectionsMeta, inferCollectionFieldsMeta } = require(path.join(PLUGIN_ROOT, 'src/client/blocks-helpers.js'));

  assert.equal(typeof fetchCollectionsMeta, 'function');
  assert.equal(typeof inferCollectionFieldsMeta, 'function');

  const seenUrls = [];
  const api = {
    async request(req) {
      seenUrls.push(`${req.method}:${req.url}`);
      return {
        data: {
          data: {
            collections: [
              {
                name: 'latticeCustomFleetTrips',
                title: 'Chuyến xe lạnh',
                isCustom: true,
                fields: [
                  { name: 'tripName', type: 'string', interface: 'input', title: 'Tên chuyến' },
                  {
                    name: 'tripStage',
                    type: 'string',
                    interface: 'select',
                    title: 'Giai đoạn',
                    enumValues: [
                      { value: 'planned', label: 'Đã lên lịch' },
                      { value: 'en_route', label: 'Đang chạy' },
                      { value: 'arrived', label: 'Đã đến' },
                    ],
                  },
                  { name: 'departureAt', type: 'datetime', interface: 'datetime', title: 'Giờ xuất phát' },
                  { name: 'geoLat', type: 'float', interface: 'number', title: 'Vĩ độ' },
                  { name: 'geoLng', type: 'float', interface: 'number', title: 'Kinh độ' },
                ],
              },
            ],
          },
        },
      };
    },
  };

  const cols = await fetchCollectionsMeta(api);
  assert.deepEqual(seenUrls, ['get:dxosBlocks:collectionsMeta']);
  assert.equal(cols.length, 1);
  assert.equal(cols[0].name, 'latticeCustomFleetTrips');

  const inferred = inferCollectionFieldsMeta(cols[0]);
  assert.equal(inferred.statusField, 'tripStage');
  assert.deepEqual(inferred.stages, [
    { value: 'planned', label: 'Đã lên lịch' },
    { value: 'en_route', label: 'Đang chạy' },
    { value: 'arrived', label: 'Đã đến' },
  ]);
  assert.equal(inferred.dateFields[0], 'departureAt');
  assert.equal(inferred.titleField, 'tripName');
  assert.equal(inferred.latField, 'geoLat');
  assert.equal(inferred.lngField, 'geoLng');

  const failingApi = {
    async request() {
      throw Object.assign(new Error('Unauthorized'), { response: { status: 401 } });
    },
  };
  assert.deepEqual(await fetchCollectionsMeta(failingApi), []);
});

test('Task 5: DxosKanbanScheduleBlockModel uiSchema keeps existing fields and adds optional statusField, dateField, titleField', () => {
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

  const models = registerDxosBlockModels(
    { useAPIClient: () => null, useUIConfigurationPermissions: () => ({ allowAll: true }) },
    React,
    {},
    { BlockModel: MockBlockModel },
    { registerModels() {} },
    {},
  );

  const KanbanModel = models.DxosKanbanScheduleBlockModel;
  const cfgStep = KanbanModel.flows.find((f) => f.key === 'dxosBlockSettings').steps.config;
  for (const field of ['title', 'collection', 'viewMode', 'pageSize', 'statusField', 'dateField', 'titleField']) {
    assert.ok(cfgStep.uiSchema[field], `DxosKanbanScheduleBlockModel uiSchema missing ${field}`);
  }
  const inst = new KanbanModel({ props: { collection: 'latticeCustomMaintenanceOrders', statusField: 'status', dateField: 'scheduledAt', titleField: 'equipmentName' } });
  const el = inst.renderComponent();
  assert.equal(el.props.liveConfig.collection, 'latticeCustomMaintenanceOrders');
  assert.equal(el.props.liveConfig.statusField, 'status');
  assert.equal(el.props.liveConfig.dateField, 'scheduledAt');
  assert.equal(el.props.liveConfig.titleField, 'equipmentName');
});

test('Task 7: DxosRecordWorkbenchBlockModel preserves strict defaultParams while populating dynamic latticeCustom* collections in block config dropdowns', async () => {
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

  const bootstrapApi = {
    auth: { getToken: () => 'tok-valid' },
    async request(req) {
      if (req.url === 'dxosBlocks:collectionsMeta') {
        return {
          data: {
            data: {
              collections: [
                { name: 'latticeCustomMaintenanceOrders', title: 'Lệnh Bảo trì', isCustom: true, fields: [] },
              ],
            },
          },
        };
      }
      return { data: { data: [] } };
    },
  };

  const models = registerDxosBlockModels(
    { useAPIClient: () => bootstrapApi, useUIConfigurationPermissions: () => ({ allowAll: true }) },
    React,
    {},
    { BlockModel: MockBlockModel },
    { registerModels() {} },
    { apiClient: bootstrapApi },
  );

  await new Promise((r) => setTimeout(r, 15));
  const cfgStep = models.DxosRecordWorkbenchBlockModel.flows.find((f) => f.key === 'dxosBlockSettings').steps.config;
  assert.deepEqual(cfgStep.defaultParams, {
    title: 'Trao đổi Chatter, Chứng từ & Xuất báo cáo',
    collection: 'latticeRequests',
    recordId: '',
    showExport: true,
    showVoucherActions: true,
    showChatter: true,
  });
  assert.ok(
    cfgStep.uiSchema.collection.enum.some((opt) => opt.value === 'latticeCustomMaintenanceOrders'),
    'DxosRecordWorkbenchBlockModel config collection dropdown must include dynamic latticeCustom* collections',
  );
});

test('Task 7 Fix Round 1: registerDxosBlockModels skips collectionsMeta when unauthenticated (0 requests on /signin) and lazily populates enums after post-login fetchCollectionsMeta', async () => {
  const { registerDxosBlockModels } = require(path.join(PLUGIN_ROOT, 'src/client/block-models.js'));
  const { fetchCollectionsMeta } = require(path.join(PLUGIN_ROOT, 'src/client/blocks-helpers.js'));

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

  const unauthCalls = [];
  const unauthApiWithAuth = {
    auth: { getToken: () => '' },
    async request(req) {
      unauthCalls.push(req);
      return { data: { data: { collections: [] } } };
    },
  };
  const models = registerDxosBlockModels(
    { useAPIClient: () => unauthApiWithAuth, useUIConfigurationPermissions: () => ({ allowAll: false }) },
    React,
    {},
    { BlockModel: MockBlockModel },
    { registerModels() {} },
    { apiClient: unauthApiWithAuth },
  );

  const tokenlessCalls = [];
  const tokenlessApi = {
    async request(req) {
      tokenlessCalls.push(req);
      return { data: { data: { collections: [] } } };
    },
  };
  registerDxosBlockModels(
    { useAPIClient: () => tokenlessApi, useUIConfigurationPermissions: () => ({ allowAll: false }) },
    React,
    {},
    { BlockModel: MockBlockModel },
    { registerModels() {} },
    { apiClient: tokenlessApi },
  );

  await new Promise((r) => setTimeout(r, 15));
  assert.equal(unauthCalls.length, 0, 'Unauthenticated bootstrap with empty getToken() must make 0 requests');
  assert.equal(tokenlessCalls.length, 0, 'Tokenless bootstrap without NOCOBASE_TOKEN must make 0 requests');

  // Simulate post-login SPA navigation where a block view triggers fetchCollectionsMeta(api)
  const postLoginApi = {
    auth: { getToken: () => 'tok-post-login' },
    async request(req) {
      if (req.url === 'dxosBlocks:collectionsMeta') {
        return {
          data: {
            data: {
              collections: [
                { name: 'latticeCustomColdAlerts', title: 'Cảnh báo Chuỗi lạnh', isCustom: true, fields: [] },
              ],
            },
          },
        };
      }
      return { data: { data: [] } };
    },
  };
  await fetchCollectionsMeta(postLoginApi);

  const wbEnum = models.DxosRecordWorkbenchBlockModel.flows.find((f) => f.key === 'dxosBlockSettings').steps.config.uiSchema.collection.enum;
  const kbEnum = models.DxosKanbanScheduleBlockModel.flows.find((f) => f.key === 'dxosBlockSettings').steps.config.uiSchema.collection.enum;
  assert.ok(
    wbEnum.some((opt) => opt.value === 'latticeCustomColdAlerts'),
    'Post-login fetchCollectionsMeta must lazily populate DxosRecordWorkbenchBlockModel config dropdown',
  );
  assert.ok(
    kbEnum.some((opt) => opt.value === 'latticeCustomColdAlerts'),
    'Post-login fetchCollectionsMeta must lazily populate DxosKanbanScheduleBlockModel config dropdown',
  );

  // Tightened lat/lng inference avoids substring false positives like escalation / prolong
  const { inferCollectionFieldsMeta } = require(path.join(PLUGIN_ROOT, 'src/client/blocks-helpers.js'));
  const nonGeoMeta = inferCollectionFieldsMeta({
    name: 'latticeCustomTickets',
    fields: [
      { name: 'escalation', type: 'integer' },
      { name: 'prolongDays', type: 'integer' },
      { name: 'geoLat', type: 'double' },
      { name: 'geoLng', type: 'double' },
    ],
  });
  assert.equal(nonGeoMeta.latField, 'geoLat');
  assert.equal(nonGeoMeta.lngField, 'geoLng');
  const falsePositiveOnly = inferCollectionFieldsMeta({
    name: 'latticeCustomEscalations',
    fields: [{ name: 'escalation', type: 'integer' }, { name: 'prolongDays', type: 'integer' }],
  });
  assert.equal(falsePositiveOnly.latField, null);
  assert.equal(falsePositiveOnly.lngField, null);
});

test('DxosBiChartBlockModel registers uiSchema with dynamic collection & numeric-filtered metricField options via collectionsMeta', async () => {
  const { registerDxosBlockModels } = require(path.join(PLUGIN_ROOT, 'src/client/block-models.js'));
  const { isNumericCollectionField, extractBiFieldOptions, fetchCollectionsMeta } = require(path.join(PLUGIN_ROOT, 'src/client/blocks-helpers.js'));

  assert.equal(typeof isNumericCollectionField, 'function');
  assert.equal(typeof extractBiFieldOptions, 'function');

  assert.equal(isNumericCollectionField({ name: 'totalAmount', type: 'decimal' }), true);
  assert.equal(isNumericCollectionField({ name: 'qty', type: 'integer' }), true);
  assert.equal(isNumericCollectionField({ name: 'status', type: 'string' }), false);

  const invoiceMeta = {
    name: 'latticeCustomInvoices',
    title: 'Hóa đơn',
    fields: [
      { name: 'status', type: 'string', title: 'Trạng thái' },
      { name: 'region', type: 'string', title: 'Khu vực' },
      { name: 'totalAmount', type: 'decimal', title: 'Tổng tiền' },
      { name: 'secretToken', type: 'string', title: 'Token' },
      { name: '__proto__', type: 'string', title: 'Proto' },
    ],
  };
  assert.deepEqual(
    extractBiFieldOptions(invoiceMeta).map((o) => o.value),
    ['status', 'region', 'totalAmount'],
  );
  assert.deepEqual(
    extractBiFieldOptions(invoiceMeta, { numericOnly: true }).map((o) => o.value),
    ['totalAmount'],
  );

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

  const bootstrapApi = {
    auth: { getToken: () => 'tok-bi' },
    async request(req) {
      if (req.url === 'dxosBlocks:collectionsMeta') {
        return { data: { data: { collections: [invoiceMeta] } } };
      }
      return { data: { data: [] } };
    },
  };

  const models = registerDxosBlockModels(
    { useAPIClient: () => bootstrapApi, useUIConfigurationPermissions: () => ({ allowAll: true }) },
    React,
    {},
    { BlockModel: MockBlockModel },
    { registerModels() {} },
    { apiClient: bootstrapApi },
  );
  await fetchCollectionsMeta(bootstrapApi);

  const biModel = models.DxosBiChartBlockModel;
  assert.ok(biModel, 'DxosBiChartBlockModel must be registered');
  const cfgStep = biModel.flows.find((f) => f.key === 'dxosBlockSettings').steps.config;
  for (const key of ['title', 'collection', 'chartType', 'groupBy', 'secondaryGroupBy', 'metricOp', 'metricField', 'limit', 'filterJson']) {
    assert.ok(key in cfgStep.defaultParams, `defaultParams missing ${key}`);
    assert.ok(cfgStep.uiSchema[key], `uiSchema missing ${key}`);
  }
  assert.ok(cfgStep.uiSchema.collection.enum.some((o) => o.value === 'latticeCustomInvoices'));

  const runReaction = (schemaField, queryValues) => {
    const field = {
      dataSource: [],
      componentProps: {},
      query: (name) => ({ value: () => queryValues[name] }),
    };
    const fn = schemaField['x-reactions'];
    assert.equal(typeof fn, 'function');
    fn(field);
    return field;
  };

  const gbField = runReaction(cfgStep.uiSchema.groupBy, { collection: 'latticeCustomInvoices', metricOp: 'sum' });
  assert.deepEqual(gbField.dataSource.map((o) => o.value), ['status', 'region', 'totalAmount']);

  const secField = runReaction(cfgStep.uiSchema.secondaryGroupBy, { collection: 'latticeCustomInvoices', metricOp: 'sum' });
  assert.deepEqual(secField.dataSource.map((o) => o.value), ['status', 'region', 'totalAmount']);

  const metricSumField = runReaction(cfgStep.uiSchema.metricField, { collection: 'latticeCustomInvoices', metricOp: 'sum' });
  assert.deepEqual(metricSumField.dataSource.map((o) => o.value), ['totalAmount']);

  const metricCountField = runReaction(cfgStep.uiSchema.metricField, { collection: 'latticeCustomInvoices', metricOp: 'count' });
  assert.deepEqual(metricCountField.dataSource.map((o) => o.value), ['status', 'region', 'totalAmount']);
});

test('M1.1 Iteration 2: isNumericCollectionField aligns formula eligibility with server (numeric dataType/interface only)', () => {
  const { isNumericCollectionField, extractBiFieldOptions } = require(path.join(PLUGIN_ROOT, 'src/client/blocks-helpers.js'));

  assert.equal(isNumericCollectionField({ name: 'calcNum', type: 'formula', interface: 'number' }), true);
  assert.equal(isNumericCollectionField({ name: 'calcInt', type: 'formula', interface: 'integer' }), true);
  assert.equal(isNumericCollectionField({ name: 'calcFloat', type: 'formula', interface: 'float' }), true);
  assert.equal(isNumericCollectionField({ name: 'calcPct', type: 'formula', interface: 'percent' }), true);
  assert.equal(isNumericCollectionField({ name: 'calcData', type: 'formula', dataType: 'decimal' }), true);
  assert.equal(isNumericCollectionField({ name: 'calcStr', type: 'formula', interface: 'input' }), false);
  assert.equal(isNumericCollectionField({ name: 'calcStrData', type: 'formula', dataType: 'string' }), false);
  assert.equal(isNumericCollectionField({ name: 'calcBare', type: 'formula' }), false);
  assert.equal(isNumericCollectionField({ name: 'badStr', type: 'string', interface: 'number' }), false);

  const meta = {
    name: 'latticeCustomFormulas',
    fields: [
      { name: 'calcNum', type: 'formula', interface: 'number' },
      { name: 'calcData', type: 'formula', dataType: 'float' },
      { name: 'calcStr', type: 'formula', interface: 'input', dataType: 'string' },
      { name: 'badStr', type: 'string', interface: 'number' },
    ],
  };
  assert.deepEqual(
    extractBiFieldOptions(meta, { numericOnly: true }).map((o) => o.value),
    ['calcNum', 'calcData'],
  );
});
