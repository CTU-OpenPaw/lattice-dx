/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pageSpec = (groupTitle, groupIcon, title, icon, key, type, collection, fields) => ({
  groupTitle,
  groupIcon,
  title,
  icon,
  block: {
    key,
    type,
    title,
    collection,
    fields,
    ...(type === 'table'
      ? { settings: { pageSize: 10 }, actions: ['filter', 'refresh'] }
      : { actions: ['submit'] }),
  },
});

export const PORTALS = Object.freeze([
  {
    slug: 'procurement',
    title: 'Mua sắm & Tài sản',
    icon: 'ShoppingOutlined',
    color: '#1677FF',
    description: 'Cổng yêu cầu mua sắm và quản lý sổ cái tài sản doanh nghiệp',
    isDefault: true,
    sort: 10,
    roles: ['ldx_employee', 'ldx_manager', 'ldx_director', 'ldx_admin'],
    pages: [
      pageSpec('Yêu cầu mua sắm', 'ShoppingCartOutlined', 'Tạo yêu cầu mới', 'FormOutlined', 'procurement-request-create', 'createForm', 'latticeRequests', ['code', 'name', 'category', 'description']),
      pageSpec('Yêu cầu mua sắm', 'ShoppingCartOutlined', 'Danh sách Yêu cầu', 'UnorderedListOutlined', 'procurement-request-list', 'table', 'latticeRequests', ['code', 'name', 'category', 'status', 'description']),
      pageSpec('Quản lý Tài sản', 'DatabaseOutlined', 'Sổ cái Tài sản', 'AppstoreOutlined', 'procurement-asset-ledger', 'table', 'latticeAssets', ['code', 'name', 'kind', 'status']),
    ],
  },
  {
    slug: 'incidents',
    title: 'Vận hành & Sự cố IoT',
    icon: 'AlertOutlined',
    color: '#FA8C16',
    description: 'Giám sát hàng đợi sự cố thiết bị và luật cảnh báo cảm biến NGSI-LD',
    isDefault: false,
    sort: 20,
    roles: ['ldx_manager', 'ldx_dispatcher', 'ldx_warehouse', 'ldx_director', 'ldx_admin'],
    pages: [
      pageSpec('Giám sát Sự cố', 'AlertOutlined', 'Hàng đợi Sự cố IoT', 'ExceptionOutlined', 'incidents-queue', 'table', 'latticeIncidentCases', ['code', 'name', 'assetEntityId', 'severity', 'status']),
      pageSpec('Giám sát Sự cố', 'AlertOutlined', 'Luật Cảm biến NGSI-LD', 'ControlOutlined', 'incidents-rules', 'table', 'latticeIncidentRules', ['code', 'name', 'assetEntityId', 'attribute', 'operator', 'threshold', 'unit', 'severity']),
    ],
  },
  {
    slug: 'logistics',
    title: 'Logistics Chuỗi lạnh',
    icon: 'CarOutlined',
    color: '#10B981',
    description: 'Điều phối đơn vận chuyển và quản lý hệ thống kho lạnh, điểm giao',
    isDefault: false,
    sort: 30,
    roles: ['ldx_warehouse', 'ldx_dispatcher', 'ldx_driver', 'ldx_manager', 'ldx_admin'],
    pages: [
      pageSpec('Điều phối Vận chuyển', 'CarOutlined', 'Danh sách Đơn hàng', 'OrderedListOutlined', 'logistics-orders-list', 'table', 'latticeOrders', ['code', 'name', 'customer', 'origin', 'destination', 'quantity', 'status']),
      pageSpec('Điều phối Vận chuyển', 'CarOutlined', 'Tạo đơn vận chuyển', 'PlusCircleOutlined', 'logistics-order-create', 'createForm', 'latticeOrders', ['code', 'name', 'customer', 'origin', 'destination', 'quantity', 'description']),
      pageSpec('Kho lạnh & Điểm giao', 'EnvironmentOutlined', 'Địa điểm & Kho bãi', 'BankOutlined', 'logistics-locations', 'table', 'latticeLocations', ['code', 'name', 'kind', 'address']),
    ],
  },
  {
    slug: 'services',
    title: 'Dịch vụ Nội bộ & Danh bạ',
    icon: 'TeamOutlined',
    color: '#6366F1',
    description: 'Tra cứu danh bạ nhân viên và cơ cấu phòng ban nội bộ',
    isDefault: false,
    sort: 40,
    roles: ['ldx_employee', 'ldx_manager', 'ldx_warehouse', 'ldx_dispatcher', 'ldx_driver', 'ldx_director', 'ldx_admin'],
    pages: [
      pageSpec('Tổ chức & Nhân sự', 'TeamOutlined', 'Danh bạ Nhân viên', 'UserOutlined', 'services-employees', 'table', 'latticeEmployees', ['code', 'name', 'email']),
      pageSpec('Tổ chức & Nhân sự', 'TeamOutlined', 'Cơ cấu Phòng ban', 'ApartmentOutlined', 'services-departments', 'table', 'latticeDepartments', ['code', 'name']),
    ],
  },
]);

export function assertSafeLabOrigin(origin) {
  if (typeof origin !== 'string' || !/^http:\/\/(?:localhost|127\.0\.0\.1):13\d{3}\/?$/.test(origin)) {
    throw new Error(`Unsafe origin "${origin}": must match http://localhost:13004..13999 or http://127.0.0.1:13004..13999`);
  }
  const url = new URL(origin);
  const port = Number(url.port);
  if (port < 13004 || port > 13999) {
    throw new Error(`Unsafe lab port ${port}: must be between 13004 and 13999 (never 13000)`);
  }
  return url.origin;
}

export function parseCliArgs(argv) {
  let reportPath = null;
  let origin = null;
  let fixturesOnly = false;
  for (const arg of argv) {
    if (arg === '--fixtures-only') fixturesOnly = true;
    else if (arg.startsWith('--origin=')) {
      if (origin !== null) throw new Error('Duplicate --origin argument');
      origin = arg.slice('--origin='.length);
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      if (reportPath !== null) throw new Error('Multiple report paths provided');
      reportPath = arg;
    }
  }
  if (!reportPath && !origin) {
    throw new Error('Usage: node scripts/setup-native-multi-portal-demo.mjs <clean-install report.json> | --origin=http://localhost:13013 [--fixtures-only]');
  }
  return { reportPath, origin, fixturesOnly };
}

export async function resolveCliTarget(argv) {
  const { reportPath, origin, fixturesOnly } = parseCliArgs(argv);
  let targetOrigin = origin;
  if (reportPath) {
    const report = JSON.parse(await readFile(resolve(reportPath), 'utf8'));
    if (report?.format !== 'latticedx.native-clean-install' || report?.complete !== true) {
      throw new Error('Invalid clean-install report: expected format "latticedx.native-clean-install" with complete === true');
    }
    const reportOrigin = assertSafeLabOrigin(report.origin);
    if (targetOrigin && assertSafeLabOrigin(targetOrigin) !== reportOrigin) {
      throw new Error('Supplied --origin does not match clean-install report origin');
    }
    targetOrigin = reportOrigin;
  }
  return { origin: assertSafeLabOrigin(targetOrigin), fixturesOnly };
}

function normalizeRoutes(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.items)) return result.items;
  return Array.isArray(result?.data) ? result.data : [];
}

function collectLayoutRoutes(allRoutes, layoutUid) {
  const byId = new Map();
  for (const route of allRoutes) if (route?.id != null) byId.set(String(route.id), route);
  const direct = (route) => route?.uiLayoutUid === layoutUid || route?.layoutUid === layoutUid
    || (Array.isArray(route?.uiLayouts) && route.uiLayouts.some((layout) => layout?.uid === layoutUid));
  const inLayout = new Set();
  for (const route of allRoutes) if (route?.id != null && direct(route)) inLayout.add(String(route.id));
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const route of allRoutes) {
      if (route?.id == null || inLayout.has(String(route.id))) continue;
      if (route.parentId != null && inLayout.has(String(route.parentId))) {
        inLayout.add(String(route.id));
        expanded = true;
      }
    }
  }
  return { byId, routes: allRoutes.filter((route) => route?.id != null && inLayout.has(String(route.id))) };
}

function hasPortalPage(layoutRoutes, byId, page) {
  return layoutRoutes.some((route) => {
    if (!['page', 'flowPage'].includes(route.type) || route.title !== page.title) return false;
    if (!page.groupTitle) return route.parentId == null;
    const parent = route.parentId != null ? byId.get(String(route.parentId)) : null;
    return parent?.type === 'group' && parent.title === page.groupTitle;
  });
}

async function ensureSystemBranding(api) {
  const current = await api('systemSettings:get?filterByTk=1');
  if (current?.title === 'LatticeDX') return false;
  // Update only title so options.brand preserves NocoBase Clause 5.2 attribution.
  await api('systemSettings:update?filterByTk=1', { method: 'POST', values: { title: 'LatticeDX' } });
  return true;
}

export async function provisionMultiPortalDemo(api, origin, { fixturesOnly = false } = {}) {
  const safeOrigin = assertSafeLabOrigin(origin);
  if (typeof api !== 'function') throw new Error('API client function is required');
  if (!fixturesOnly) await ensureSystemBranding(api);

  const portals = [];
  let createdPages = 0;

  for (const portal of PORTALS) {
    const layoutUid = `ldx-portal-${portal.slug}`;
    const { pages, ...meta } = portal;
    const portalValues = { ...meta, uid: layoutUid, enabled: true };
    await api('latticePortals:save', { method: 'POST', values: portalValues });

    const allRoutes = normalizeRoutes(await api('desktopRoutes:list?paginate=false&appends[]=uiLayouts'));
    const { byId, routes: layoutRoutes } = collectLayoutRoutes(allRoutes, layoutUid);

    let portalCreated = 0;
    for (const page of pages) {
      if (hasPortalPage(layoutRoutes, byId, page)) continue;
      await api('flowSurfaces:applyBlueprint', {
        method: 'POST',
        values: {
          version: '1',
          mode: 'create',
          navigation: {
            layoutUid,
            group: { title: page.groupTitle, icon: page.groupIcon },
            item: { title: page.title, icon: page.icon },
          },
          page: { title: page.title, displayTitle: true, enableTabs: false },
          tabs: [{ title: page.title, blocks: [page.block] }],
        },
      });
      portalCreated += 1;
      createdPages += 1;
    }

    await api('latticePortals:save', { method: 'POST', values: portalValues });
    portals.push({
      slug: portal.slug,
      layoutUid,
      title: portal.title,
      createdPages: portalCreated,
      existingPages: pages.length - portalCreated,
      totalPages: pages.length,
      roles: [...portal.roles],
    });
  }

  return {
    result: 'PASS',
    origin: safeOrigin,
    settingsUrl: `${safeOrigin}/admin/settings/multi-portal`,
    createdPages,
    portals,
  };
}

export async function createRootApiClient(origin, fetchImpl = fetch) {
  const safeOrigin = assertSafeLabOrigin(origin);
  let token = '';
  async function api(path, { method = 'GET', values } = {}) {
    const response = await fetchImpl(new URL('/api/' + path, safeOrigin), {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}`, 'X-Role': 'root' } : {}),
      },
      ...(values !== undefined ? { body: JSON.stringify(values) } : {}),
      signal: AbortSignal.timeout(15000),
    });
    const text = await response.text();
    let payload;
    try { payload = text ? JSON.parse(text) : {}; }
    catch { payload = { errors: [{ message: 'Non-JSON response' }] }; }
    if (!response.ok) {
      const reason = payload?.errors?.[0]?.code ?? payload?.errors?.[0]?.message ?? `HTTP ${response.status}`;
      throw new Error(`${path.split('?')[0]} HTTP ${response.status}: ${reason}`);
    }
    return payload.data !== undefined ? payload.data : payload;
  }
  const auth = await api('auth:signIn', {
    method: 'POST',
    values: {
      email: process.env.NOCOBASE_ADMIN_EMAIL ?? 'admin@nocobase.com',
      password: process.env.NOCOBASE_ADMIN_PASSWORD ?? 'admin123',
    },
  });
  if (!auth?.token) throw new Error('auth:signIn did not return a token');
  token = auth.token;
  return api;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  resolveCliTarget(process.argv.slice(2))
    .then(async ({ origin, fixturesOnly }) => {
      const api = await createRootApiClient(origin);
      const summary = await provisionMultiPortalDemo(api, origin, { fixturesOnly });
      console.log(JSON.stringify(summary));
    })
    .catch((error) => {
      console.error(JSON.stringify({ result: 'FAIL', error: error.message }));
      process.exitCode = 1;
    });
}
