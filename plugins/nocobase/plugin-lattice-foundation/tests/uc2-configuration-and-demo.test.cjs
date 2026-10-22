// SPDX-License-Identifier: Apache-2.0
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateManifest } = require('../src/shared/manifest');
const incidentManifest = require('../src/shared/manifests/incident.json');
const { createProcurementDashboardComponent } = require('../src/applications/procurement/dashboard');
const { createCaseBoardComponent } = require('../src/applications/incident/case-board');

function hooks() {
  const slots = [];
  let index = 0, queue = [];
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    Fragment: ({ children }) => children,
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
    useState(value) {
      const i = index++;
      if (!slots[i]) slots[i] = { value: typeof value === 'function' ? value() : value };
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
    const res = find(child, predicate);
    if (res) return res;
  }
  return null;
}

const tick = () => new Promise(setImmediate);

test('UC2 Manifest validates cleanly and reuses all UC1 blocks: list, approval, attachment, timeline, and context-entity', () => {
  const errors = validateManifest(incidentManifest);
  assert.deepEqual(errors, [], 'Incident manifest must pass validation with 0 errors');

  // Verify all 5 reused blocks
  const blockTypes = incidentManifest.blocks.map(b => b.type);
  assert.ok(blockTypes.includes('list'), 'Must include list block');
  assert.ok(blockTypes.includes('approval'), 'Must include approval block');
  assert.ok(blockTypes.includes('attachment'), 'Must include attachment block');
  assert.ok(blockTypes.includes('activity-timeline'), 'Must include activity-timeline block');
  assert.ok(blockTypes.includes('context-entity'), 'Must include context-entity block');

  // Verify Approval block binds all evidence blocks in scope
  const approval = incidentManifest.blocks.find(b => b.type === 'approval');
  assert.equal(approval.attachmentBlockId, 'case-files');
  assert.equal(approval.timelineBlockId, 'case-history');
  assert.equal(approval.contextBlockId, 'case-context');

  // Verify Workspace blocks binding
  const boundBlocks = incidentManifest.workspace.blocks.map(b => b.blockId);
  assert.ok(boundBlocks.includes('case-list'));
  assert.ok(boundBlocks.includes('case-approval'));
  assert.ok(boundBlocks.includes('case-files'));
  assert.ok(boundBlocks.includes('case-history'));
  assert.ok(boundBlocks.includes('case-context'));

  // Verify Workspace panels
  const panelRenderers = incidentManifest.workspace.panels.map(p => p.renderer);
  assert.ok(panelRenderers.includes('lattice.incident.case-board'));
  assert.ok(panelRenderers.includes('lattice.incident.resolution'));
  assert.ok(panelRenderers.includes('lattice.incident.agent-run'));
  assert.ok(panelRenderers.includes('lattice.incident.evidence-proposal'));
  assert.ok(panelRenderers.includes('lattice.incident.rule-editor'));
});

test('Procurement Dashboard (UC1) bridges handed-over asset to Incident Management (UC2)', async () => {
  const env = hooks();
  const ProcurementDashboard = createProcurementDashboardComponent(env.react);
  let createdIncident = null;

  const mockHandedOverRun = {
    id: 'pr-run-001',
    title: 'Mua máy bơm làm mát buồng phản ứng A1',
    state: 'handed_over',
    version: 4,
    entityContext: {
      entityId: 'urn:ngsi-ld:Asset:DEMO-ASSET-01',
      schemaId: 'asset'
    }
  };

  const mockAsset = {
    id: 'urn:ngsi-ld:Asset:DEMO-ASSET-01',
    title: 'Bơm làm mát A1',
    schemaId: 'asset',
    version: 2,
    attributes: {
      assetCode: 'PUMP-A1',
      status: 'handed_over',
      location: 'Nhà xưởng 1',
      department: 'Phòng Kỹ thuật Cơ điện'
    }
  };

  const api = {
    workflow: async (op, arg) => {
      if (op === 'list') return { items: [mockHandedOverRun] };
      if (op === 'create') {
        createdIncident = arg;
        return { id: arg.key };
      }
      return {};
    },
    entity: async (op, arg) => {
      if (op === 'detail' && arg.id === mockAsset.id) return mockAsset;
      return null;
    },
    request: async () => ({ data: {} })
  };

  const render = () => env.render(() => ProcurementDashboard({ api, connection: { connected: true } }));
  render(); await tick();
  let tree = render();

  // 1. Click link to asset to display asset detail card
  const linkBtn = find(tree, n => n.props?.['data-testid'] === 'link-to-asset-pr-run-001');
  assert.ok(linkBtn, 'Asset link must be present on handed over row');
  linkBtn.props.onClick();

  render(); await tick();
  tree = render();

  const assetCard = find(tree, n => n.props?.['data-testid'] === 'asset-detail-card');
  assert.ok(assetCard, 'Asset detail card must be visible');

  // 2. Click Bridge to Incident button
  const bridgeBtn = find(assetCard, n => n.props?.['data-testid'] === 'bridge-to-incident-btn');
  assert.ok(bridgeBtn, 'Bridge to UC2 button must exist on asset card');
  await bridgeBtn.props.onClick();

  render(); await tick();
  tree = render();

  assert.ok(createdIncident, 'Incident workflow must be triggered for handed-over asset');
  assert.equal(createdIncident.body.definitionId, 'incident-response');
  assert.equal(createdIncident.body.input.assetEntityId, 'urn:ngsi-ld:Asset:DEMO-ASSET-01');

  // Verify status message
  const statusMsg = find(tree, n => n.props?.['data-testid'] === 'bridge-status-message');
  assert.ok(statusMsg, 'Status message must appear after bridging');
  assert.ok(statusMsg.children.some(c => String(c).includes('Bơm làm mát A1')));
});

test('CaseBoard renders UC1 bridge banner, initializes with asset filter, and includes Context Entity tab', async () => {
  const env = hooks();
  const CaseBoard = createCaseBoardComponent(env.react);

  const sampleCase = {
    id: '11111111-2222-3333-4444-555555555555',
    title: 'Cảnh báo nhiệt độ vượt ngưỡng tại Bơm làm mát A1',
    status: 'investigating',
    version: 1,
    assetEntityId: 'urn:ngsi-ld:Asset:DEMO-ASSET-01',
    handlerId: 'DEMO-EMP-01',
    createdAt: '2026-10-21T08:00:00Z',
    proposal: {
      summary: 'Giảm tải công suất 30% và thay thế phớt chặn cơ khí',
      suggestedStatus: 'repair',
      evidence: ['Độ rung: 4.8 mm/s', 'Nhiệt độ: 78.5°C vượt ngưỡng 60°C']
    },
    data: {
      attachmentId: '22222222-3333-4444-5555-666666666666'
    }
  };

  const api = {
    workflow: async (op) => {
      if (op === 'list') return { items: [sampleCase] };
      if (op === 'detail') return sampleCase;
      if (op === 'history') return { items: [] };
      return {};
    },
    entity: async () => ({ items: [{ id: 'urn:ngsi-ld:Asset:DEMO-ASSET-01', title: 'Bơm làm mát A1', schemaId: 'asset' }] }),
    request: async () => ({ data: { data: [] } })
  };

  // Instantiate with initialAssetId from UC1
  const render = () => env.render(() => CaseBoard({
    api,
    connection: { connected: true },
    initialAssetId: 'urn:ngsi-ld:Asset:DEMO-ASSET-01'
  }));

  render(); await tick();
  let tree = render();

  // 1. Verify UC1 Bridge Banner
  const banner = find(tree, n => n.props?.['data-testid'] === 'lattice-uc1-bridge-banner');
  assert.ok(banner, 'UC1 Bridge banner must exist');
  assert.ok(find(banner, n => n.props?.['data-testid'] === 'filter-uc1-pump-btn'));
  assert.ok(find(banner, n => n.props?.['data-testid'] === 'filter-all-assets-btn'));

  // 2. Open Case Detail Modal
  const card = find(tree, n => n.props?.['data-testid'] === `lattice-case-card-${sampleCase.id}`);
  assert.ok(card, 'Case card for bridged asset must be rendered');
  card.props.onClick();

  render(); await tick();
  tree = render();

  const modal = find(tree, n => n.props?.['data-testid'] === 'lattice-case-detail-modal');
  assert.ok(modal, 'Modal must appear');

  // Verify all 7 tabs exist
  assert.ok(find(modal, n => n.props?.['data-testid'] === 'lattice-modal-tab-overview'));
  assert.ok(find(modal, n => n.props?.['data-testid'] === 'lattice-modal-tab-resolution'));
  assert.ok(find(modal, n => n.props?.['data-testid'] === 'lattice-modal-tab-evidence'));
  assert.ok(find(modal, n => n.props?.['data-testid'] === 'lattice-modal-tab-attachments'));
  assert.ok(find(modal, n => n.props?.['data-testid'] === 'lattice-modal-tab-timeline'));
  assert.ok(find(modal, n => n.props?.['data-testid'] === 'lattice-modal-tab-approval'));
  assert.ok(find(modal, n => n.props?.['data-testid'] === 'lattice-modal-tab-context'));

  // Switch to Tab 7 (Context Entity & Telemetry)
  const contextTabBtn = find(modal, n => n.props?.['data-testid'] === 'lattice-modal-tab-context');
  contextTabBtn.props.onClick();

  render(); await tick();
  tree = render();

  const contextPanel = find(tree, n => n.props?.['data-testid'] === 'lattice-tab-panel-context');
  assert.ok(contextPanel, 'Context tab panel must be rendered');
  const contextNode = find(contextPanel, n => typeof n.type === 'function' && (n.type.name === 'ContextEntityBlock' || n.type.name === 'EntityContextBlock'));
  assert.ok(contextNode, 'Reused ContextEntityBlock must be instantiated inside context tab');
  assert.equal(contextNode.props.block.id, 'case-context');
  assert.equal(contextNode.props.run.entityContext.entityId, 'urn:ngsi-ld:Asset:DEMO-ASSET-01');
});
