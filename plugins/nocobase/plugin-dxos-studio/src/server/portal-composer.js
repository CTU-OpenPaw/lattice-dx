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

const OVERVIEW_SPECS = [
  {
    slug: 'procurement',
    title: 'Tổng quan Điều hành Mua sắm',
    groupTitle: 'Yêu cầu mua sắm',
    groupIcon: 'ShoppingCartOutlined',
    icon: 'DashboardOutlined',
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
    ],
  },
  {
    slug: 'incidents',
    title: 'Trung tâm Sự cố & AI',
    groupTitle: 'Giám sát Sự cố',
    groupIcon: 'AlertOutlined',
    icon: 'RadarChartOutlined',
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
    ],
  },
  {
    slug: 'services',
    title: 'Không gian P.A.R.A. & Dịch vụ',
    groupTitle: 'Tổ chức & Nhân sự',
    groupIcon: 'TeamOutlined',
    icon: 'AppstoreOutlined',
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

function findExistingPage(routes, layoutUid, groupTitle, pageTitle) {
  const inLayout = routes.filter((r) => {
    if (!r) return false;
    const direct = val(r, 'uiLayoutUid') === layoutUid || val(r, 'layoutUid') === layoutUid;
    if (direct) return true;
    const layouts = val(r, 'uiLayouts');
    return Array.isArray(layouts) && layouts.some((l) => val(l, 'uid') === layoutUid);
  });
  const byId = new Map(routes.map((r) => [String(val(r, 'id')), r]));
  for (const r of routes) {
    const pid = val(r, 'parentId');
    if (pid != null && inLayout.some((x) => String(val(x, 'id')) === String(pid)) && !inLayout.includes(r)) {
      inLayout.push(r);
    }
  }
  return inLayout.find((r) => {
    if (!['page', 'flowPage'].includes(val(r, 'type')) || val(r, 'title') !== pageTitle) return false;
    const parent = val(r, 'parentId') != null ? byId.get(String(val(r, 'parentId'))) : null;
    return parent && val(parent, 'type') === 'group' && val(parent, 'title') === groupTitle;
  }) || null;
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
  for (const block of blocks) {
    const uid = `dxos-ov-${slug}-${block.uidSuffix}`;
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
  return attached;
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
    await applyBlueprint({
      version: '1',
      mode: 'create',
      navigation: { layoutUid, group: { title: page.groupTitle, icon: page.groupIcon }, item: { title: page.title, icon: page.icon } },
      page: { title: page.title, displayTitle: true, enableTabs: false },
      tabs: [{ title: page.title, blocks: [{ key: `${page.slug}-${page.collection}`, type: page.type, title: page.title, collection: page.collection, fields: page.fields, settings: { pageSize: 10 }, actions: ['filter', 'refresh'] }] }],
    });
    createdPages += 1;
    routes = routesRepo ? await routesRepo.find({ appends: ['uiLayouts'] }) : routes;
  }

  for (const ov of OVERVIEW_SPECS) {
    const layoutUid = `ldx-portal-${ov.slug}`;
    let pageRoute = findExistingPage(routes, layoutUid, ov.groupTitle, ov.title);
    let tabSchemaUid = null;
    if (!pageRoute) {
      const res = await applyBlueprint({
        version: '1',
        mode: 'create',
        navigation: { layoutUid, group: { title: ov.groupTitle, icon: ov.groupIcon }, item: { title: ov.title, icon: ov.icon } },
        page: { title: ov.title, displayTitle: true, enableTabs: false },
        tabs: [{ title: ov.title, blocks: [] }],
      });
      createdPages += 1;
      tabSchemaUid = res?.target?.tabSchemaUid || null;
      routes = routesRepo ? await routesRepo.find({ appends: ['uiLayouts'] }) : routes;
      if (!tabSchemaUid) pageRoute = findExistingPage(routes, layoutUid, ov.groupTitle, ov.title);
    }
    if (!tabSchemaUid && pageRoute) {
      const pid = val(pageRoute, 'id');
      const tabRoute = routes.find((r) => val(r, 'parentId') === pid && val(r, 'type') === 'tabs');
      tabSchemaUid = tabRoute ? val(tabRoute, 'schemaUid') : null;
    }
    if (dxosBlocksEnabled && tabSchemaUid) {
      attachedBlocks += await attachDxosBlocksToTab(db, tabSchemaUid, ov.slug, ov.blocks);
    }
  }

  // Ensure newly created overview/domain pages are granted to the portal's existing roles (additive only).
  const linksRepo = db.getRepository('desktopRoutesUiLayouts');
  const grantsRepo = db.getRepository('rolesDesktopRoutes');
  if (linksRepo && grantsRepo) {
    for (const ov of OVERVIEW_SPECS) {
      const uid = `ldx-portal-${ov.slug}`;
      const configuredRoles = Array.isArray(portalMeta[uid]?.roles) ? portalMeta[uid].roles.filter((r) => typeof r === 'string' && r.startsWith('ldx_')) : [];
      if (!configuredRoles.length) continue;
      const links = (await linksRepo.find({ filter: { uiLayoutUid: uid } })) || [];
      const routeIds = [...new Set(links.map((l) => val(l, 'desktopRouteId')).filter((id) => id != null))];
      if (!routeIds.length) continue;
      const existing = (await grantsRepo.find({ filter: { desktopRouteId: { $in: routeIds }, roleName: { $in: configuredRoles } } })) || [];
      const have = new Set(existing.map((g) => `${val(g, 'desktopRouteId')}:${val(g, 'roleName')}`));
      for (const desktopRouteId of routeIds) {
        for (const roleName of configuredRoles) {
          if (!have.has(`${desktopRouteId}:${roleName}`)) {
            await grantsRepo.create({ values: { desktopRouteId, roleName } });
          }
        }
      }
    }
  }

  return { createdPages, attachedBlocks, dxosBlocksAttached: dxosBlocksEnabled };
}

module.exports = { OVERVIEW_SPECS, EXTRA_DATA_PAGES, composePortals };
