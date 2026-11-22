/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COLLECTION_FIELD_GROUPS, PORTALS } from './lib/multi-portal-demo-catalog.mjs';

export { COLLECTION_FIELD_GROUPS, PORTALS };

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
      const fieldGroups = COLLECTION_FIELD_GROUPS[page.block.collection];
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
          ...(fieldGroups ? { defaults: { collections: { [page.block.collection]: { fieldGroups } } } } : {}),
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

  let composedOverview = null;
  try {
    composedOverview = await api('dxosStudio:composePortals', { method: 'POST', values: {} });
  } catch (err) {
    if (!/\bHTTP (?:404|501)\b/.test(String(err?.message || ''))) throw err;
  }

  return {
    result: 'PASS',
    origin: safeOrigin,
    settingsUrl: `${safeOrigin}/admin/settings/multi-portal`,
    createdPages,
    composedOverview,
    portals,
  };
}

export async function createRootApiClient(origin, fetchImpl = fetch) {
  const safeOrigin = assertSafeLabOrigin(origin);
  let token = '';
  async function api(path, { method = 'GET', values } = {}) {
    const response = await fetchImpl(new URL('/api/' + path, safeOrigin), {
      method,
      redirect: 'error',
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
      const firstErr = payload?.errors?.[0];
      const reason = [firstErr?.code, firstErr?.message].filter(Boolean).join(': ') || `HTTP ${response.status}`;
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

export async function ensureLogisticsDemoCrew(api) {
  const depts = await api('latticeDepartments:list?filter=' + encodeURIComponent(JSON.stringify({ code: 'NATIVE-UI-LAB', organizationId: 'native-ui-lab' })));
  const dept = Array.isArray(depts) ? depts[0] : depts?.rows?.[0];
  if (!dept?.id) return { skipped: true, createdUsers: 0, createdEmployees: 0 };

  let createdUsers = 0;
  let createdEmployees = 0;
  const specs = [
    ['native.lab.dispatcher', 'ldx_dispatcher', 'NATIVE-UI-DISPATCHER', 'Điều phối thử native'],
    ['native.lab.driver', 'ldx_driver', 'NATIVE-UI-DRIVER', 'Tài xế thử native'],
  ];
  for (const [username, role, code, name] of specs) {
    const email = `${username}@example.invalid`;
    const foundUsers = await api('users:list?filter=' + encodeURIComponent(JSON.stringify({ username })));
    let user = Array.isArray(foundUsers) ? foundUsers[0] : foundUsers?.rows?.[0];
    if (!user) {
      user = await api('users:create', {
        method: 'POST',
        values: { username, email, nickname: name, password: process.env.NATIVE_DEMO_PASSWORD ?? 'NativeLab-2026!', roles: [role] },
      });
      createdUsers += 1;
    }
    const foundEmps = await api('latticeEmployees:list?filter=' + encodeURIComponent(JSON.stringify({ code, organizationId: 'native-ui-lab' })));
    const emp = Array.isArray(foundEmps) ? foundEmps[0] : foundEmps?.rows?.[0];
    if (!emp && user?.id) {
      await api('latticeEmployees:create', {
        method: 'POST',
        values: { code, name, organizationId: 'native-ui-lab', departmentId: dept.id, userId: user.id, active: true },
      });
      createdEmployees += 1;
    }
  }
  return { skipped: false, createdUsers, createdEmployees };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  resolveCliTarget(process.argv.slice(2))
    .then(async ({ origin, fixturesOnly }) => {
      const api = await createRootApiClient(origin);
      const summary = await provisionMultiPortalDemo(api, origin, { fixturesOnly });
      const crew = await ensureLogisticsDemoCrew(api);
      console.log(JSON.stringify({ ...summary, crew }));
    })
    .catch((error) => {
      console.error(JSON.stringify({ result: 'FAIL', error: error.message }));
      process.exitCode = 1;
    });
}
