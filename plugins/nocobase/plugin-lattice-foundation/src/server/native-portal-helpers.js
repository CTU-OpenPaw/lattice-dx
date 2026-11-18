/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const BUILTIN_UIDS = new Set(['admin-layout-model', 'mobile-layout-model']);
const RESERVED_SLUGS = new Set([
  'admin', 'settings', 'signin', 'signup', 'p', 'v', 'api', 'static', 'storage', 'files', 'lattice',
]);
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,36}$/;
const SCHEMA_UID_RE = /^[a-zA-Z0-9_-]+$/;
const PLUGIN_NAME = '@latticedx/plugin-lattice-foundation';

const val = (row, key) => (typeof row?.get === 'function' ? row.get(key) : row?.[key]);
const toPlain = row => (row ? (typeof row.toJSON === 'function' ? row.toJSON() : { ...row }) : null);
const getRepo = (db, name) => { try { return db?.getRepository ? db.getRepository(name) : null; } catch { return null; } };

function callerRoles(ctx) {
  const list = Array.isArray(ctx?.state?.currentRoles) ? ctx.state.currentRoles : [];
  return ctx?.state?.currentRole && !list.includes(ctx.state.currentRole)
    ? [...list, ctx.state.currentRole] : list;
}

function slugFromLayout(layout) {
  const uid = String(val(layout, 'uid') || '');
  if (uid === 'admin-layout-model') return 'admin';
  if (uid === 'mobile-layout-model') return 'mobile';
  if (uid.startsWith('ldx-portal-')) return uid.slice(11);
  const routePath = String(val(layout, 'routePath') || '');
  return routePath.startsWith('/p/') ? routePath.slice(3) : uid;
}

function normalizePortalInput(values, fail) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) fail(400, 'Portal payload must be an object.');
  const reqUid = typeof values.uid === 'string' ? values.uid.trim() : '';
  const isBuiltin = BUILTIN_UIDS.has(reqUid);
  let slug = isBuiltin ? (reqUid === 'admin-layout-model' ? 'admin' : 'mobile') : '';
  let uid = reqUid;
  if (!isBuiltin) {
    slug = typeof values.slug === 'string'
      ? values.slug.trim().toLowerCase()
      : (reqUid.startsWith('ldx-portal-') ? reqUid.slice(11) : '');
    if (!SLUG_RE.test(slug)) fail(400, 'Portal slug must match /^[a-z0-9][a-z0-9-]{1,36}$/.');
    if (RESERVED_SLUGS.has(slug)) fail(400, 'Portal slug is reserved.');
    uid = 'ldx-portal-' + slug;
    if (reqUid && reqUid !== uid) fail(400, 'Portal uid does not match slug.');
  }
  const title = typeof values.title === 'string' ? values.title.trim() : '';
  if (!title || title.length > 80) fail(400, 'Portal title is required (<= 80 chars).');
  if (values.layoutType !== undefined && !['desktop', 'mobile'].includes(values.layoutType)) {
    fail(400, 'layoutType must be desktop or mobile.');
  }
  return {
    uid, slug, isBuiltin, title,
    layoutType: values.layoutType === 'mobile' ? 'mobile' : 'desktop',
    icon: typeof values.icon === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(values.icon.trim()) ? values.icon.trim() : 'AppstoreOutlined',
    color: typeof values.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(values.color.trim()) ? values.color.trim() : '#1677ff',
    description: typeof values.description === 'string' ? values.description.trim().slice(0, 300) : '',
    isDefault: Boolean(values.isDefault),
    sort: Number.isFinite(Number(values.sort)) ? Math.trunc(Number(values.sort)) : 0,
    enabled: values.enabled === undefined ? true : Boolean(values.enabled),
    roles: Array.isArray(values.roles) ? values.roles : null,
  };
}

function buildRouteHierarchy(routes) {
  const items = (Array.isArray(routes) ? routes : []).map(toPlain).filter(Boolean);
  const byId = new Map(items.filter(r => r.id != null).map(r => [String(r.id), r]));
  const childrenMap = new Map();
  const roots = [];
  for (const item of items) {
    const pid = item.parentId != null ? String(item.parentId) : null;
    if (pid && byId.has(pid)) {
      if (!childrenMap.has(pid)) childrenMap.set(pid, []);
      childrenMap.get(pid).push(item);
    } else roots.push(item);
  }
  const bySort = (a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0) || (Number(a.id) || 0) - (Number(b.id) || 0);
  roots.sort(bySort);
  for (const list of childrenMap.values()) list.sort(bySort);
  return { roots, childrenMap };
}

function inspectPortalRoutes(routes, routePath, accessibleIds) {
  const { roots, childrenMap } = buildRouteHierarchy(routes);
  const base = routePath === '/admin' ? '/admin' : String(routePath || '').replace(/\/$/, '');
  let firstPagePath = null;
  let accessiblePageCount = 0;
  function visit(nodes) {
    for (const node of nodes) {
      if (!node || node.hidden || node.hideInMenu) continue;
      const children = node.id != null ? (childrenMap.get(String(node.id)) || []) : [];
      if (['page', 'flowPage'].includes(node.type) && typeof node.schemaUid === 'string' && SCHEMA_UID_RE.test(node.schemaUid)) {
        if (!accessibleIds || accessibleIds.has(String(node.id))) {
          accessiblePageCount += 1;
          if (!firstPagePath && base) firstPagePath = `${base}/${node.schemaUid}`;
        }
      }
      if (children.length) visit(children);
    }
  }
  visit(roots);
  return { firstPagePath, accessiblePageCount };
}

function sanitizeRouteTree(routes) {
  const { roots, childrenMap } = buildRouteHierarchy(routes);
  const fields = ['schemaUid', 'menuSchemaUid', 'icon', 'tooltip', 'hideInMenu', 'hidden', 'sort', 'options', 'enableTabs', 'enableHeader', 'displayTitle'];
  function mapNode(node) {
    const children = node.id != null ? (childrenMap.get(String(node.id)) || []).map(mapNode) : [];
    const entry = { title: node.title || '', type: node.type || 'page' };
    for (const k of fields) if (node[k] !== undefined && node[k] !== null) entry[k] = node[k];
    if (children.length) entry.children = children;
    return entry;
  }
  return roots.map(mapNode);
}

function sortPortals(items) {
  return items.slice().sort((a, b) => {
    if (Boolean(b.isDefault) !== Boolean(a.isDefault)) return b.isDefault ? 1 : -1;
    const diff = (Number(a.sort) || 0) - (Number(b.sort) || 0);
    return diff !== 0 ? diff : String(a.uid).localeCompare(String(b.uid));
  });
}

function createPortalMetaStore(db) {
  let memory = {};
  async function read(transaction) {
    const repo = getRepo(db, 'applicationPlugins');
    const row = repo ? await repo.findOne({ filter: { name: PLUGIN_NAME }, transaction }) : null;
    const portals = val(row, 'options')?.portals;
    return portals && typeof portals === 'object' ? { ...portals } : { ...memory };
  }
  async function write(uid, nextEntry, transaction) {
    const repo = getRepo(db, 'applicationPlugins');
    const row = repo ? await repo.findOne({ filter: { name: PLUGIN_NAME }, transaction }) : null;
    const portals = { ...(val(row, 'options')?.portals || memory) };
    if (nextEntry === null) delete portals[uid];
    else {
      if (nextEntry.isDefault) for (const k of Object.keys(portals)) portals[k] = { ...portals[k], isDefault: false };
      portals[uid] = nextEntry;
    }
    memory = portals;
    if (row && repo) {
      await repo.update({ filter: { name: PLUGIN_NAME }, values: { options: { ...(val(row, 'options') || {}), portals } }, transaction });
    }
    return portals;
  }
  return { read, write };
}

async function loadPortalData(db) {
  const [layoutsRaw, linksRaw, routesRaw, grantsRaw] = await Promise.all([
    getRepo(db, 'uiLayouts')?.find({ sort: ['uid'] }) || [],
    getRepo(db, 'desktopRoutesUiLayouts')?.find({}) || [],
    getRepo(db, 'desktopRoutes')?.find({}) || [],
    getRepo(db, 'rolesDesktopRoutes')?.find({}) || [],
  ]);
  const routeById = new Map(routesRaw.map(toPlain).filter(r => r?.id != null).map(r => [String(r.id), r]));
  const routesByPortal = new Map(), routeIdsByPortal = new Map(), rolesByRoute = new Map();
  for (const link of linksRaw) {
    const uid = val(link, 'uiLayoutUid'), rid = val(link, 'desktopRouteId');
    if (!uid || rid == null) continue;
    if (!routeIdsByPortal.has(uid)) routeIdsByPortal.set(uid, new Set());
    routeIdsByPortal.get(uid).add(String(rid));
    const route = routeById.get(String(rid));
    if (route) {
      if (!routesByPortal.has(uid)) routesByPortal.set(uid, []);
      routesByPortal.get(uid).push(route);
    }
  }
  for (const grant of grantsRaw) {
    const rid = val(grant, 'desktopRouteId'), roleName = val(grant, 'roleName');
    if (rid == null || !roleName) continue;
    if (!rolesByRoute.has(String(rid))) rolesByRoute.set(String(rid), new Set());
    rolesByRoute.get(String(rid)).add(roleName);
  }
  return { layouts: layoutsRaw.map(toPlain), routesByPortal, routeIdsByPortal, rolesByRoute };
}

function grantedLdxRoles(routeIds, rolesByRoute, fallbackRoles) {
  if (!routeIds || !routeIds.size) return Array.isArray(fallbackRoles) ? [...fallbackRoles] : [];
  const roles = new Set();
  for (const rid of routeIds) {
    for (const r of rolesByRoute.get(rid) || []) if (String(r).startsWith('ldx_')) roles.add(r);
  }
  return [...roles].sort();
}

function buildPortalDto(layout, meta, routes, roles) {
  return {
    uid: layout.uid, slug: slugFromLayout(layout), title: layout.title || layout.uid,
    layoutType: layout.layoutType || 'desktop', routeName: layout.routeName, routePath: layout.routePath,
    enabled: layout.enabled !== false, builtin: BUILTIN_UIDS.has(layout.uid),
    icon: meta?.icon || 'AppstoreOutlined', color: meta?.color || '#1677ff',
    description: meta?.description || '', isDefault: Boolean(meta?.isDefault),
    sort: Number(meta?.sort) || 0, routeCount: routes.length, roles,
  };
}

module.exports = {
  BUILTIN_UIDS, RESERVED_SLUGS, SLUG_RE, PLUGIN_NAME,
  val, toPlain, getRepo, callerRoles, normalizePortalInput, inspectPortalRoutes,
  sanitizeRouteTree, sortPortals, createPortalMetaStore, loadPortalData, grantedLdxRoles, buildPortalDto,
};
