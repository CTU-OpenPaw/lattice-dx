/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const val = (row, key) => (typeof row?.get === 'function' ? row.get(key) : row?.[key]);

const COLLECTION_FIELD_GROUPS = {
  latticeIncidentCases: [
    { title: 'Định danh & Tài sản', fields: ['code', 'name', 'organizationId', 'assetEntityId', 'runId', 'notificationId'] },
    { title: 'Phân công & Trạng thái', fields: ['handlerId', 'severity', 'status'] },
    { title: 'Giám sát & Xác nhận cảnh báo', fields: ['fingerprint', 'acknowledgedBy', 'clearedBy'] },
    { title: 'Đề xuất AI & Khắc phục', fields: ['proposal', 'resolutionNote', 'closeNote'] },
  ],
  latticeRequests: [
    { title: 'Thông tin Yêu cầu', fields: ['code', 'name', 'organizationId', 'category', 'description'] },
    { title: 'Trạng thái & Vòng đời chứng từ', fields: ['status', 'version', 'decisionReason', 'submittedBy', 'cancelledBy', 'cancelReason'] },
  ],
  latticeOrders: [
    { title: 'Thông tin Đơn vận chuyển', fields: ['code', 'name', 'organizationId', 'category', 'customer', 'quantity'] },
    { title: 'Tuyến vận chuyển & Mô tả', fields: ['origin', 'destination', 'description'] },
    { title: 'Trạng thái & Vòng đời chứng từ', fields: ['status', 'version', 'decisionReason', 'submittedBy', 'cancelledBy', 'cancelReason'] },
  ],
  latticeServiceTickets: [
    { title: 'Thông tin Phiếu dịch vụ', fields: ['code', 'name', 'organizationId', 'serviceType', 'priority', 'description'] },
    { title: 'Trạng thái & Vòng đời chứng từ', fields: ['status', 'version', 'resolutionNote', 'decisionReason', 'submittedBy', 'cancelledBy', 'cancelReason'] },
  ],
  latticeParaDocuments: [
    { title: 'Định danh & Phân vùng P.A.R.A.', fields: ['code', 'title', 'organizationId', 'paraSpace', 'tags', 'status'] },
    { title: 'Nội dung & Liên kết', fields: ['summary', 'contentMarkdown', 'attachmentUrl', 'relatedCollection', 'relatedRecordId'] },
  ],
};

const OVERVIEW_SPECS = [
  {
    slug: 'procurement',
    title: 'Tổng quan Điều hành Mua sắm',
    groupTitle: 'Yêu cầu mua sắm',
    groupIcon: 'ShoppingCartOutlined',
    icon: 'DashboardOutlined',
    seedBlock: {
      key: 'procurement-overview-requests',
      type: 'table',
      title: 'Yêu cầu mua sắm gần đây',
      collection: 'latticeRequests',
      fields: ['code', 'name', 'category', 'status'],
      settings: { pageSize: 5 },
      actions: ['filter', 'refresh'],
    },
    blocks: [
      {
        uidSuffix: 'hero',
        use: 'DxosPortalHeroBlockModel',
        config: {
          title: 'Cổng Mua sắm & Tài sản Doanh nghiệp',
          subtitle: 'Khởi tạo yêu cầu, duyệt Poka-yoke và theo dõi vòng đời tài sản theo thời gian thực.',
          badge: 'DX-OS · MUA SẮM',
          accentColor: '#1677ff',
          actionsJson: JSON.stringify([
            { label: 'Việc cần duyệt của tôi', path: '/admin/lattice-workspace', primary: true },
            { label: 'Kho tri thức P.A.R.A.', path: '/p/services' },
          ]),
        },
      },
      {
        uidSuffix: 'kpi',
        use: 'DxosKpiMetricBlockModel',
        config: {
          title: 'Chỉ số Mua sắm & Tài sản [D]',
          columns: 3,
          metricsJson: JSON.stringify([
            { label: 'Yêu cầu mua sắm', collection: 'latticeRequests', color: '#1677ff', targetPath: '/p/procurement' },
            { label: 'Đang chờ duyệt', collection: 'latticeRequests', filter: { status: 'submitted' }, color: '#fa8c16', targetPath: '/admin/lattice-workspace' },
            { label: 'Tài sản quản lý', collection: 'latticeAssets', color: '#10b981', targetPath: '/p/procurement' },
          ]),
        },
      },
      {
        uidSuffix: 'tasks',
        use: 'DxosWorkflowTasksBlockModel',
        config: { title: 'Hộp việc Quy trình của tôi [P]', statusFilter: 'pending', pageSize: 5 },
      },
      {
        uidSuffix: 'workbench',
        use: 'DxosRecordWorkbenchBlockModel',
        config: { title: 'Chứng từ, Chatter & Xuất báo cáo Mua sắm [W]', collection: 'latticeRequests', showExport: true, showVoucherActions: true, showChatter: true },
      },
    ],
  },
  {
    slug: 'incidents',
    title: 'Trung tâm Sự cố & AI',
    groupTitle: 'Giám sát Sự cố',
    groupIcon: 'AlertOutlined',
    icon: 'RadarChartOutlined',
    seedBlock: {
      key: 'incidents-overview-cases',
      type: 'table',
      title: 'Hàng đợi Sự cố IoT',
      collection: 'latticeIncidentCases',
      fields: ['code', 'name', 'assetEntityId', 'severity', 'status'],
      settings: { pageSize: 5 },
      actions: ['filter', 'refresh'],
    },
    blocks: [
      {
        uidSuffix: 'hero',
        use: 'DxosPortalHeroBlockModel',
        config: {
          title: 'Trung tâm Vận hành IoT & Bằng chứng AI',
          subtitle: 'Giám sát ngữ cảnh FIWARE Orion-LD, luật cảnh báo và đề xuất AI có kiểm duyệt con người.',
          badge: 'DX-OS · IT/OT + AI',
          accentColor: '#fa8c16',
          actionsJson: JSON.stringify([{ label: 'Mở Hộp việc duyệt sự cố', path: '/admin/lattice-workspace', primary: true }]),
        },
      },
      {
        uidSuffix: 'context',
        use: 'DxosContextTelemetryBlockModel',
        config: { title: 'Ngữ cảnh Tài sản NGSI-LD trực tiếp [D]', warningThreshold: '80', showSyncStatus: true },
      },
      {
        uidSuffix: 'proposals',
        use: 'DxosAiProposalBlockModel',
        config: { title: 'Đề xuất AI có Bằng chứng [I]', targetCollection: 'latticeIncidentCases', state: 'all', pageSize: 5, showEvidence: true },
      },
    ],
  },
  {
    slug: 'logistics',
    title: 'Điều hành Logistics 5 bước',
    groupTitle: 'Điều phối Vận chuyển',
    groupIcon: 'CarOutlined',
    icon: 'FundProjectionScreenOutlined',
    seedBlock: {
      key: 'logistics-overview-orders',
      type: 'table',
      title: 'Đơn vận chuyển chuỗi lạnh',
      collection: 'latticeOrders',
      fields: ['code', 'name', 'customer', 'origin', 'destination', 'status'],
      settings: { pageSize: 5 },
      actions: ['filter', 'refresh'],
    },
    blocks: [
      {
        uidSuffix: 'hero',
        use: 'DxosPortalHeroBlockModel',
        config: {
          title: 'Cổng Logistics Chuỗi lạnh Liên phòng ban',
          subtitle: 'Phối hợp Kinh doanh → Quản lý → Thủ kho → Điều phối → Tài xế trên cùng nguồn dữ liệu thật.',
          badge: 'DX-OS · LOGISTICS',
          accentColor: '#10b981',
          actionsJson: JSON.stringify([{ label: 'Việc kho / điều phối / tài xế', path: '/admin/lattice-workspace', primary: true }]),
        },
      },
      {
        uidSuffix: 'kpi',
        use: 'DxosKpiMetricBlockModel',
        config: {
          title: 'Trạng thái Đơn vận chuyển [D]',
          columns: 4,
          metricsJson: JSON.stringify([
            { label: 'Tổng đơn hàng', collection: 'latticeOrders', color: '#10b981', targetPath: '/p/logistics' },
            { label: 'Chờ kho chuẩn bị', collection: 'latticeOrders', filter: { status: 'preparing' }, color: '#fa8c16', targetPath: '/admin/lattice-workspace' },
            { label: 'Đang giao hàng', collection: 'latticeOrders', filter: { status: 'in_transit' }, color: '#1677ff', targetPath: '/admin/lattice-workspace' },
            { label: 'Kho lạnh & Điểm giao', collection: 'latticeLocations', color: '#6366f1', targetPath: '/p/logistics' },
          ]),
        },
      },
      {
        uidSuffix: 'tasks',
        use: 'DxosWorkflowTasksBlockModel',
        config: { title: 'Công việc Logistics cần xử lý [P]', statusFilter: 'pending', pageSize: 6 },
      },
      {
        uidSuffix: 'workbench',
        use: 'DxosRecordWorkbenchBlockModel',
        config: { title: 'Chứng từ, Chatter & Xuất báo cáo Logistics [W]', collection: 'latticeOrders', showExport: true, showVoucherActions: true, showChatter: true },
      },
    ],
  },
  {
    slug: 'services',
    title: 'Không gian P.A.R.A. & Dịch vụ',
    groupTitle: 'Tổ chức & Nhân sự',
    groupIcon: 'TeamOutlined',
    icon: 'AppstoreOutlined',
    seedBlock: {
      key: 'services-overview-tickets',
      type: 'table',
      title: 'Phiếu Dịch vụ Nội bộ',
      collection: 'latticeServiceTickets',
      fields: ['code', 'name', 'serviceType', 'priority', 'status'],
      settings: { pageSize: 5 },
      actions: ['filter', 'refresh'],
    },
    blocks: [
      {
        uidSuffix: 'hero',
        use: 'DxosPortalHeroBlockModel',
        config: {
          title: 'Không gian Nhân sự, Dịch vụ Nội bộ & Tri thức P.A.R.A.',
          subtitle: 'Quản lý tài liệu P.A.R.A., phiếu dịch vụ/nghỉ phép và danh bạ tổ chức cho toàn doanh nghiệp.',
          badge: 'DX-OS · HUMAN & P.A.R.A.',
          accentColor: '#6366f1',
          actionsJson: JSON.stringify([{ label: 'Công việc cần xử lý', path: '/admin/lattice-workspace', primary: true }]),
        },
      },
      {
        uidSuffix: 'para',
        use: 'DxosParaVaultBlockModel',
        config: { title: 'Kho tri thức P.A.R.A. [H]', paraSpace: 'all', pageSize: 6, enableQuickCreate: true },
      },
      {
        uidSuffix: 'tasks',
        use: 'DxosWorkflowTasksBlockModel',
        config: { title: 'Phiếu Dịch vụ & Duyệt của tôi [P]', statusFilter: 'pending', pageSize: 5 },
      },
      {
        uidSuffix: 'workbench',
        use: 'DxosRecordWorkbenchBlockModel',
        config: { title: 'Chứng từ, Chatter & Xuất báo cáo Dịch vụ [W]', collection: 'latticeServiceTickets', showExport: true, showVoucherActions: true, showChatter: true },
      },
    ],
  },
];

const EXTRA_DATA_PAGES = [
  {
    slug: 'services',
    groupTitle: 'Dịch vụ Nội bộ',
    groupIcon: 'SolutionOutlined',
    title: 'Phiếu Dịch vụ Nội bộ',
    icon: 'FileDoneOutlined',
    collection: 'latticeServiceTickets',
    type: 'table',
    fields: ['code', 'name', 'serviceType', 'priority', 'status'],
  },
  {
    slug: 'services',
    groupTitle: 'Kho tri thức P.A.R.A.',
    groupIcon: 'FolderOpenOutlined',
    title: 'Tài liệu P.A.R.A.',
    icon: 'BookOutlined',
    collection: 'latticeParaDocuments',
    type: 'table',
    fields: ['code', 'title', 'paraSpace', 'tags', 'status'],
  },
];

const MOBILE_LAYOUT_UID = 'mobile-layout-model';
const DEFAULT_MOBILE_OPERATIONAL_ROLES = [
  'ldx_employee',
  'ldx_manager',
  'ldx_warehouse',
  'ldx_dispatcher',
  'ldx_driver',
  'ldx_director',
];
const EXCLUDED_MOBILE_ROLES = new Set(['root', 'admin', 'ldx_admin', 'ldx_sysadmin', 'ldx_connector']);

const MOBILE_PORTAL_PAGES = [
  {
    key: 'mobile-approvals',
    groupTitle: 'Vận hành Di động',
    groupIcon: 'MobileOutlined',
    title: 'Việc cần duyệt',
    icon: 'CheckCircleOutlined',
    collection: 'latticeRequests',
    type: 'table',
    fields: ['code', 'name', 'category', 'status'],
  },
  {
    key: 'mobile-logistics-orders',
    groupTitle: 'Vận hành Di động',
    groupIcon: 'MobileOutlined',
    title: 'Đơn Logistics',
    icon: 'CarOutlined',
    collection: 'latticeOrders',
    type: 'table',
    fields: ['code', 'name', 'customer', 'origin', 'destination', 'status'],
  },
  {
    key: 'mobile-cold-incidents',
    groupTitle: 'Vận hành Di động',
    groupIcon: 'MobileOutlined',
    title: 'Sự cố Kho lạnh',
    icon: 'AlertOutlined',
    collection: 'latticeIncidentCases',
    type: 'table',
    fields: ['code', 'name', 'assetEntityId', 'severity', 'status'],
  },
  {
    key: 'mobile-service-tickets',
    groupTitle: 'Vận hành Di động',
    groupIcon: 'MobileOutlined',
    title: 'Phiếu Dịch vụ',
    icon: 'FileDoneOutlined',
    collection: 'latticeServiceTickets',
    type: 'table',
    fields: ['code', 'name', 'serviceType', 'priority', 'status'],
  },
];

function collectLayoutRoutes(routes, layoutUid, linkedRouteIds = new Set()) {
  const inLayout = [];
  const inLayoutIds = new Set();
  const byId = new Map();
  for (const r of Array.isArray(routes) ? routes : []) {
    if (!r) continue;
    const rid = val(r, 'id');
    if (rid != null) byId.set(String(rid), r);
    const direct = val(r, 'uiLayoutUid') === layoutUid || val(r, 'layoutUid') === layoutUid;
    const linked = rid != null && linkedRouteIds.has(String(rid));
    const layouts = val(r, 'uiLayouts');
    const inLayoutsArr = Array.isArray(layouts) && layouts.some((l) => val(l, 'uid') === layoutUid);
    if (direct || linked || inLayoutsArr) {
      inLayout.push(r);
      if (rid != null) inLayoutIds.add(String(rid));
    }
  }
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const r of Array.isArray(routes) ? routes : []) {
      if (!r) continue;
      const rid = val(r, 'id');
      const pid = val(r, 'parentId');
      if (rid != null && !inLayoutIds.has(String(rid)) && pid != null && inLayoutIds.has(String(pid))) {
        inLayout.push(r);
        inLayoutIds.add(String(rid));
        expanded = true;
      }
    }
  }
  return { inLayout, byId };
}

function findExistingPage(routes, layoutUid, groupTitle, pageTitle, linkedRouteIds) {
  const { inLayout, byId } = collectLayoutRoutes(routes, layoutUid, linkedRouteIds);
  return inLayout.find((r) => {
    if (!['page', 'flowPage'].includes(val(r, 'type')) || val(r, 'title') !== pageTitle) return false;
    if (!groupTitle) return true;
    const parent = val(r, 'parentId') != null ? byId.get(String(val(r, 'parentId'))) : null;
    return parent && val(parent, 'type') === 'group' && val(parent, 'title') === groupTitle;
  }) || null;
}

async function grantRolesToRoutes(db, routeIds, roleNames) {
  const grantsRepo = db.getRepository?.('rolesDesktopRoutes');
  const cleanRouteIds = [...new Set((routeIds || []).filter((id) => id != null))];
  const cleanRoles = [...new Set((roleNames || []).filter((r) => typeof r === 'string' && r.startsWith('ldx_')))];
  if (!grantsRepo || !cleanRouteIds.length || !cleanRoles.length) return 0;

  let have = new Set();
  if (typeof grantsRepo.find === 'function') {
    const existing = (await grantsRepo.find({ filter: { desktopRouteId: { $in: cleanRouteIds }, roleName: { $in: cleanRoles } } })) || [];
    have = new Set(existing.map((g) => `${String(val(g, 'desktopRouteId'))}:${val(g, 'roleName')}`));
  }

  let created = 0;
  for (const desktopRouteId of cleanRouteIds) {
    for (const roleName of cleanRoles) {
      const key = `${String(desktopRouteId)}:${roleName}`;
      if (have.has(key)) continue;
      if (typeof grantsRepo.find !== 'function' && typeof grantsRepo.findOne === 'function') {
        const exists = await grantsRepo.findOne({ filter: { desktopRouteId, roleName } });
        if (exists) {
          have.add(key);
          continue;
        }
      }
      await grantsRepo.create({ values: { desktopRouteId, roleName } });
      have.add(key);
      created += 1;
    }
  }
  return created;
}

async function resolveMobileOperationalRoles(db) {
  const rolesRepo = db.getRepository?.('roles');
  if (!rolesRepo || typeof rolesRepo.find !== 'function') {
    return [...DEFAULT_MOBILE_OPERATIONAL_ROLES];
  }
  let rows = (await rolesRepo.find({})) || [];
  if (!rows.length) {
    rows = (await rolesRepo.find({ filter: { name: { $in: DEFAULT_MOBILE_OPERATIONAL_ROLES } } })) || [];
  }
  return [...new Set(
    rows
      .map((r) => ({ name: val(r, 'name'), allowConfigure: val(r, 'allowConfigure'), snippets: val(r, 'snippets') }))
      .filter((r) => typeof r.name === 'string'
        && /^ldx_[a-z0-9_]+$/.test(r.name)
        && !EXCLUDED_MOBILE_ROLES.has(r.name)
        && r.allowConfigure !== true
        && !(Array.isArray(r.snippets) && (r.snippets.includes('pm') || r.snippets.includes('pm.*'))))
      .map((r) => r.name),
  )];
}

function buildTablePageBlueprint(layoutUid, page, blockKey) {
  const fieldGroups = COLLECTION_FIELD_GROUPS[page.collection];
  return {
    version: '1',
    mode: 'create',
    navigation: {
      layoutUid,
      group: { title: page.groupTitle, icon: page.groupIcon },
      item: { title: page.title, icon: page.icon },
    },
    page: { title: page.title, displayTitle: true, enableTabs: false },
    tabs: [{
      title: page.title,
      blocks: [{
        key: blockKey,
        type: page.type,
        title: page.title,
        collection: page.collection,
        fields: page.fields,
        settings: { pageSize: 10 },
        actions: ['filter', 'refresh'],
      }],
    }],
    ...(fieldGroups ? { defaults: { collections: { [page.collection]: { fieldGroups } } } } : {}),
  };
}

async function composeMobilePortal(db, { applyBlueprint }) {
  if (typeof applyBlueprint !== 'function') {
    throw Object.assign(new Error('flowSurfaces:applyBlueprint is unavailable'), { status: 503 });
  }
  const routesRepo = db.getRepository?.('desktopRoutes');
  const linksRepo = db.getRepository?.('desktopRoutesUiLayouts');

  const loadMobileState = async () => {
    const routes = routesRepo ? ((await routesRepo.find({ appends: ['uiLayouts'] })) || []) : [];
    const links = linksRepo ? ((await linksRepo.find({ filter: { uiLayoutUid: MOBILE_LAYOUT_UID } })) || []) : [];
    const rawLinkedIds = links.map((l) => val(l, 'desktopRouteId')).filter((id) => id != null);
    const linkedIds = new Set(rawLinkedIds.map(String));
    const { inLayout } = collectLayoutRoutes(routes, MOBILE_LAYOUT_UID, linkedIds);
    return { routes, rawLinkedIds, linkedIds, inLayout };
  };

  let state = await loadMobileState();
  let mobilePagesCreated = 0;

  for (const page of MOBILE_PORTAL_PAGES) {
    if (typeof db.hasCollection === 'function' && !db.hasCollection(page.collection)) continue;
    const alreadyExists = Boolean(findExistingPage(state.routes, MOBILE_LAYOUT_UID, page.groupTitle, page.title, state.linkedIds))
      || state.inLayout.some((r) => ['page', 'flowPage'].includes(val(r, 'type')) && val(r, 'title') === page.title);
    if (alreadyExists) continue;

    await applyBlueprint(buildTablePageBlueprint(MOBILE_LAYOUT_UID, page, page.key));
    mobilePagesCreated += 1;
    state = await loadMobileState();
  }

  const seenIds = new Set();
  const routeIds = [];
  for (const id of [...state.inLayout.map((r) => val(r, 'id')), ...state.rawLinkedIds]) {
    if (id == null) continue;
    const key = String(id);
    if (!seenIds.has(key)) {
      seenIds.add(key);
      routeIds.push(id);
    }
  }
  const operationalRoles = await resolveMobileOperationalRoles(db);
  const grantsCreated = await grantRolesToRoutes(db, routeIds, operationalRoles);

  return { mobilePagesCreated, grantsCreated };
}

function mergeGridLayout(base, uids) {
  const existingRows = { ...(base?.rows || {}) };
  const existingSizes = { ...(base?.sizes || {}) };
  const existingOrder = Array.isArray(base?.rowOrder) ? [...base.rowOrder] : Object.keys(existingRows);
  const placedUids = new Set(Object.values(existingRows).flat(2));
  const prependedOrder = [];
  uids.forEach((uid, idx) => {
    if (placedUids.has(uid)) return;
    const rowKey = `dxos_row_${idx}`;
    if (!existingRows[rowKey]) {
      existingRows[rowKey] = [[uid]];
      existingSizes[rowKey] = [24];
    }
    if (!existingOrder.includes(rowKey)) prependedOrder.push(rowKey);
  });
  return { rows: existingRows, sizes: existingSizes, rowOrder: [...prependedOrder, ...existingOrder] };
}

async function attachDxosBlocksToTab(db, tabSchemaUid, slug, blocks) {
  const flowModelsRepo = db.getRepository('flowModels');
  if (!flowModelsRepo || typeof flowModelsRepo.upsertModel !== 'function') return 0;
  const grid = typeof flowModelsRepo.findModelByParentId === 'function'
    ? await flowModelsRepo.findModelByParentId(tabSchemaUid, { subKey: 'grid' })
    : null;
  const gridUid = grid?.uid;
  if (!gridUid) return 0;
  let attached = 0;
  const allUids = [];
  for (const block of blocks) {
    const uid = `dxos-ov-${slug}-${block.uidSuffix}`;
    allUids.push(uid);
    const existing = typeof flowModelsRepo.findOne === 'function'
      ? await flowModelsRepo.findOne({ filter: { uid } })
      : null;
    if (existing) continue;
    await flowModelsRepo.upsertModel({
      uid,
      use: block.use,
      parentId: gridUid,
      subKey: 'items',
      subType: 'array',
      props: { ...block.config },
      stepParams: { dxosBlockSettings: { config: { ...block.config } } },
    });
    attached += 1;
  }
  if (attached > 0 && typeof flowModelsRepo.updateSingleNode === 'function') {
    const nextPropsLayout = mergeGridLayout(grid.props, allUids);
    const nextStepLayout = mergeGridLayout(grid.stepParams?.gridSettings?.grid || grid.props, allUids);
    await flowModelsRepo.updateSingleNode({
      uid: gridUid,
      props: { ...(grid.props || {}), ...nextPropsLayout },
      stepParams: {
        ...(grid.stepParams || {}),
        gridSettings: {
          ...(grid.stepParams?.gridSettings || {}),
          grid: nextStepLayout,
        },
      },
    });
  }
  return attached;
}

function resolveOverviewSeedBlock(db, ov) {
  if (typeof db.hasCollection !== 'function' || db.hasCollection(ov.seedBlock.collection)) {
    return ov.seedBlock;
  }
  return {
    key: `${ov.slug}-overview-requests`,
    type: 'table',
    title: 'Yêu cầu gần đây',
    collection: 'latticeRequests',
    fields: ['code', 'name', 'status'],
    settings: { pageSize: 5 },
    actions: ['filter', 'refresh'],
  };
}

async function composePortals(db, { applyBlueprint }) {
  if (typeof applyBlueprint !== 'function') {
    throw Object.assign(new Error('flowSurfaces:applyBlueprint is unavailable'), { status: 503 });
  }
  const routesRepo = db.getRepository('desktopRoutes');
  const pluginsRepo = db.getRepository('applicationPlugins');
  const pluginRows = pluginsRepo ? await pluginsRepo.find({}) : [];
  const blocksPlugin = (Array.isArray(pluginRows) ? pluginRows : []).find(
    (p) => val(p, 'packageName') === '@latticedx/plugin-dxos-blocks' || val(p, 'name') === '@latticedx/plugin-dxos-blocks',
  );
  const dxosBlocksEnabled = val(blocksPlugin, 'enabled') === true;
  const foundationPlugin = (Array.isArray(pluginRows) ? pluginRows : []).find(
    (p) => val(p, 'packageName') === '@latticedx/plugin-lattice-foundation' || val(p, 'name') === '@latticedx/plugin-lattice-foundation',
  );
  const portalMeta = val(foundationPlugin, 'options')?.portals || {};

  let routes = routesRepo ? await routesRepo.find({ appends: ['uiLayouts'] }) : [];
  let createdPages = 0;
  let attachedBlocks = 0;

  for (const page of EXTRA_DATA_PAGES) {
    if (typeof db.hasCollection === 'function' && !db.hasCollection(page.collection)) continue;
    const layoutUid = `ldx-portal-${page.slug}`;
    if (findExistingPage(routes, layoutUid, page.groupTitle, page.title)) continue;
    await applyBlueprint(buildTablePageBlueprint(layoutUid, page, `${page.slug}-${page.collection}`));
    createdPages += 1;
    routes = routesRepo ? await routesRepo.find({ appends: ['uiLayouts'] }) : routes;
  }

  for (const ov of OVERVIEW_SPECS) {
    const layoutUid = `ldx-portal-${ov.slug}`;
    let pageRoute = findExistingPage(routes, layoutUid, ov.groupTitle, ov.title);
    let tabSchemaUid = null;
    if (!pageRoute) {
      const seedBlock = resolveOverviewSeedBlock(db, ov);
      const fieldGroups = COLLECTION_FIELD_GROUPS[seedBlock.collection];
      const res = await applyBlueprint({
        version: '1',
        mode: 'create',
        navigation: { layoutUid, group: { title: ov.groupTitle, icon: ov.groupIcon }, item: { title: ov.title, icon: ov.icon } },
        page: { title: ov.title, displayTitle: true, enableTabs: false },
        tabs: [{ title: ov.title, blocks: [seedBlock] }],
        ...(fieldGroups ? { defaults: { collections: { [seedBlock.collection]: { fieldGroups } } } } : {}),
      });
      createdPages += 1;
      tabSchemaUid = res?.target?.tabSchemaUid || null;
      routes = routesRepo ? await routesRepo.find({ appends: ['uiLayouts'] }) : routes;
      if (!tabSchemaUid) pageRoute = findExistingPage(routes, layoutUid, ov.groupTitle, ov.title);
    }
    if (!tabSchemaUid && pageRoute) {
      const pid = String(val(pageRoute, 'id'));
      const tabRoute = routes.find((r) => String(val(r, 'parentId')) === pid && val(r, 'type') === 'tabs');
      tabSchemaUid = tabRoute ? val(tabRoute, 'schemaUid') : null;
    }
    if (dxosBlocksEnabled && tabSchemaUid) {
      attachedBlocks += await attachDxosBlocksToTab(db, tabSchemaUid, ov.slug, ov.blocks);
    }
  }

  // Ensure newly created overview/domain pages are granted to the portal's existing roles (additive only).
  const linksRepo = db.getRepository('desktopRoutesUiLayouts');
  if (linksRepo) {
    for (const ov of OVERVIEW_SPECS) {
      const uid = `ldx-portal-${ov.slug}`;
      const configuredRoles = Array.isArray(portalMeta[uid]?.roles) ? portalMeta[uid].roles.filter((r) => typeof r === 'string' && r.startsWith('ldx_')) : [];
      if (!configuredRoles.length) continue;
      const links = (await linksRepo.find({ filter: { uiLayoutUid: uid } })) || [];
      const routeIds = [...new Set(links.map((l) => val(l, 'desktopRouteId')).filter((id) => id != null))];
      await grantRolesToRoutes(db, routeIds, configuredRoles);
    }
  }

  const mobileRes = await composeMobilePortal(db, { applyBlueprint });

  return { createdPages, mobilePagesCreated: mobileRes.mobilePagesCreated, attachedBlocks, dxosBlocksAttached: dxosBlocksEnabled };
}

module.exports = { COLLECTION_FIELD_GROUPS, OVERVIEW_SPECS, EXTRA_DATA_PAGES, MOBILE_PORTAL_PAGES, composeMobilePortal, composePortals };
