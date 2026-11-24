/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const {
  BUILTIN_UIDS, val, getRepo, callerRoles, isBusinessPortalRole, normalizePortalInput, inspectPortalRoutes,
  sanitizeRouteTree, sortPortals, createPortalMetaStore, loadPortalData, grantedLdxRoles, buildPortalDto,
} = require('./native-portal-helpers');

async function isPortalAdmin(ctx, db) {
  if (!ctx?.state?.currentUser) return false;
  const roles = callerRoles(ctx);
  if (roles.includes('root')) return true;
  if (!roles.length) return false;
  const repo = getRepo(db || ctx.app?.db, 'roles');
  if (!repo) return false;
  const matched = await repo.find({ filter: { name: { $in: roles } } }) || [];
  return matched.some(role => {
    const name = val(role, 'name');
    if (name && !roles.includes(name)) return false;
    if (val(role, 'allowConfigure') === true) return true;
    const snippets = val(role, 'snippets');
    return Array.isArray(snippets) && (snippets.includes('pm') || snippets.includes('pm.*'));
  });
}

async function syncPortalRoles(db, uid, requestedRoles, transaction, metaMap = {}) {
  const allRoles = await (getRepo(db, 'roles')?.find({ transaction }) || []);
  const validBusinessRoles = new Set(allRoles.filter(r => isBusinessPortalRole(r)).map(r => val(r, 'name')));
  const checked = [...new Set(requestedRoles.filter(r => typeof r === 'string' && validBusinessRoles.has(r)))].sort();
  const linksRepo = getRepo(db, 'desktopRoutesUiLayouts');
  const grantsRepo = getRepo(db, 'rolesDesktopRoutes');
  if (!linksRepo || !grantsRepo) return checked;
  const links = await linksRepo.find({ filter: { uiLayoutUid: uid }, transaction }) || [];
  const routeIds = [...new Set(links.filter(l => val(l, 'uiLayoutUid') === uid).map(l => val(l, 'desktopRouteId')).filter(id => id != null))];
  if (!routeIds.length || !validBusinessRoles.size) return checked;
  const existing = await grantsRepo.find({ filter: { desktopRouteId: { $in: routeIds }, roleName: { $in: [...validBusinessRoles] } }, transaction }) || [];
  const have = new Set(existing.map(g => `${val(g, 'desktopRouteId')}:${val(g, 'roleName')}`));
  for (const desktopRouteId of routeIds) {
    for (const roleName of checked) {
      if (!have.has(`${desktopRouteId}:${roleName}`)) {
        await grantsRepo.create({ values: { desktopRouteId, roleName }, transaction });
      }
    }
  }
  const unchecked = [...validBusinessRoles].filter(name => !checked.includes(name));
  if (unchecked.length) {
    const allRouteLinks = await linksRepo.find({ filter: { desktopRouteId: { $in: routeIds } }, transaction }) || [];
    const otherLayoutsByRoute = new Map();
    for (const link of allRouteLinks) {
      const rid = val(link, 'desktopRouteId');
      const layoutUid = val(link, 'uiLayoutUid');
      if (rid == null || !layoutUid || layoutUid === uid) continue;
      if (!otherLayoutsByRoute.has(String(rid))) otherLayoutsByRoute.set(String(rid), new Set());
      otherLayoutsByRoute.get(String(rid)).add(layoutUid);
    }
    const protectedByOtherPortal = (rid, roleName) => {
      const others = otherLayoutsByRoute.get(String(rid));
      if (!others) return false;
      if (others.has('admin-layout-model')) return true;
      for (const otherUid of others) {
        if (Array.isArray(metaMap?.[otherUid]?.roles) && metaMap[otherUid].roles.includes(roleName)) return true;
      }
      return false;
    };
    for (const desktopRouteId of routeIds) {
      const revokable = unchecked.filter(roleName =>
        have.has(`${desktopRouteId}:${roleName}`) && !protectedByOtherPortal(desktopRouteId, roleName),
      );
      if (revokable.length) {
        await grantsRepo.destroy({ filter: { desktopRouteId, roleName: { $in: revokable } }, transaction });
      }
    }
  }
  return checked;
}

function registerNativePortals(app, injectedDb) {
  const db = injectedDb || app.db;
  const metaStore = createPortalMetaStore(db);
  const fail = (ctx, status, msg) => {
    if (typeof ctx?.throw === 'function') ctx.throw(status, msg);
    throw Object.assign(new Error(msg), { status });
  };
  const requireAdmin = async ctx => {
    if (!ctx?.state?.currentUser) fail(ctx, 401, 'Authentication required.');
    if (!await isPortalAdmin(ctx, db)) fail(ctx, 403, 'Portal administration permission required.');
  };
  const runTx = fn => (db?.sequelize?.transaction ? db.sequelize.transaction(fn) : fn(undefined));
  app.resourceManager.define({ name: 'latticePortals', actions: {
    list: async (ctx, next) => {
      if (ctx.method && ctx.method !== 'GET') fail(ctx, 405, 'Method not allowed.');
      await requireAdmin(ctx);
      const [data, metaMap] = await Promise.all([loadPortalData(db), metaStore.read()]);
      ctx.body = sortPortals(data.layouts.map(layout => {
        const routes = data.routesByPortal.get(layout.uid) || [];
        const meta = metaMap[layout.uid];
        const { firstPagePath } = inspectPortalRoutes(routes, layout.routePath, null);
        return {
          ...buildPortalDto(layout, meta, routes, grantedLdxRoles(data.routeIdsByPortal.get(layout.uid), data.rolesByRoute, meta?.roles, data.excludedRoles)),
          firstPagePath,
        };
      }));
      if (next) await next();
    },
    listAccessible: async (ctx, next) => {
      if (ctx.method && ctx.method !== 'GET') fail(ctx, 405, 'Method not allowed.');
      if (!ctx?.state?.currentUser) fail(ctx, 401, 'Authentication required.');
      const includeMobile = ctx.action?.params?.includeMobile === true || ctx.action?.params?.includeMobile === 'true' || ctx.query?.includeMobile === 'true';
      const [admin, data, metaMap] = await Promise.all([isPortalAdmin(ctx, db), loadPortalData(db), metaStore.read()]);
      const roles = callerRoles(ctx);
      const accessibleIds = admin ? null : new Set(
        [...data.rolesByRoute.entries()].filter(([, g]) => roles.some(r => g.has(r))).map(([rid]) => rid),
      );
      const portals = [];
      for (const layout of data.layouts) {
        if (layout.enabled === false) continue;
        if (!admin && layout.uid === 'admin-layout-model') continue;
        if (!includeMobile && (layout.uid === 'mobile-layout-model' || layout.layoutType === 'mobile')) continue;
        const routes = data.routesByPortal.get(layout.uid) || [];
        const { firstPagePath, accessiblePageCount } = inspectPortalRoutes(routes, layout.routePath, accessibleIds);
        if (!admin && accessiblePageCount < 1) continue;
        const meta = metaMap[layout.uid];
        const dto = buildPortalDto(layout, meta, routes, admin ? (meta?.roles || []) : []);
        if (!admin) dto.routeCount = accessiblePageCount;
        portals.push({ ...dto, firstPagePath });
      }
      ctx.body = sortPortals(portals);
      if (next) await next();
    },
    save: async (ctx, next) => {
      if (ctx.method && ctx.method !== 'POST') fail(ctx, 405, 'Method not allowed.');
      await requireAdmin(ctx);
      const rawVals = ctx.action?.params?.values ?? ctx.request?.body ?? {};
      const input = normalizePortalInput(rawVals, (s, m) => fail(ctx, s, m));
      const isCreate = !String(rawVals?.uid || '').trim();
      ctx.body = await runTx(async transaction => {
        const repo = getRepo(db, 'uiLayouts');
        if (!repo) fail(ctx, 503, 'uiLayouts repository unavailable.');
        const existing = await repo.findOne({ filter: { uid: input.uid }, transaction });
        if (input.isBuiltin && !existing) fail(ctx, 404, 'Built-in portal not found.');
        if (isCreate && existing) fail(ctx, 409, 'Portal with this slug already exists.');
        const routeName = val(existing, 'routeName') || (input.uid === 'admin-layout-model' ? 'admin' : 'p_' + input.slug.replace(/-/g, '_'));
        const routePath = val(existing, 'routePath') || (input.uid === 'admin-layout-model' ? '/admin' : '/p/' + input.slug);
        let layoutType = val(existing, 'layoutType') || input.layoutType;
        let enabled = val(existing, 'enabled') !== false;
        if (input.uid === 'admin-layout-model') {
          if (val(existing, 'title') !== input.title) await repo.update({ filter: { uid: input.uid }, values: { title: input.title }, transaction });
        } else if (input.isBuiltin) {
          enabled = rawVals.enabled === undefined ? enabled : input.enabled;
          await repo.update({ filter: { uid: input.uid }, values: { title: input.title, ...(rawVals.enabled !== undefined ? { enabled } : {}) }, transaction });
        } else if (existing) {
          layoutType = rawVals.layoutType === undefined ? (val(existing, 'layoutType') || input.layoutType) : input.layoutType;
          enabled = rawVals.enabled === undefined ? (val(existing, 'enabled') !== false) : input.enabled;
          await repo.update({ filter: { uid: input.uid }, values: { title: input.title, layoutType, enabled }, transaction });
        } else {
          const all = await repo.find({ transaction }) || [];
          if (all.some(r => val(r, 'routeName') === routeName || val(r, 'routePath') === routePath)) fail(ctx, 409, 'Portal route already exists.');
          layoutType = input.layoutType;
          enabled = input.enabled;
          await repo.create({ values: { uid: input.uid, title: input.title, layoutType, routeName, routePath, authCheck: true, enabled }, transaction });
        }
        const metaMap = await metaStore.read(transaction);
        const prevMeta = metaMap[input.uid] || {};
        const roles = input.roles !== null ? await syncPortalRoles(db, input.uid, input.roles, transaction, metaMap) : (prevMeta.roles || []);
        const meta = {
          icon: rawVals.icon !== undefined ? input.icon : (prevMeta.icon || 'AppstoreOutlined'),
          color: rawVals.color !== undefined ? input.color : (prevMeta.color || '#1677ff'),
          description: rawVals.description !== undefined ? input.description : (prevMeta.description || ''),
          isDefault: rawVals.isDefault !== undefined ? input.isDefault : Boolean(prevMeta.isDefault),
          sort: rawVals.sort !== undefined ? input.sort : (Number(prevMeta.sort) || 0),
          roles,
        };
        await metaStore.write(input.uid, meta, transaction);
        const links = await (getRepo(db, 'desktopRoutesUiLayouts')?.find({ filter: { uiLayoutUid: input.uid }, transaction }) || []);
        return buildPortalDto({ uid: input.uid, title: input.title, layoutType, routeName, routePath, enabled }, meta, links.filter(l => val(l, 'uiLayoutUid') === input.uid), roles);
      });
      if (next) await next();
    },
    destroy: async (ctx, next) => {
      if (ctx.method && ctx.method !== 'POST') fail(ctx, 405, 'Method not allowed.');
      await requireAdmin(ctx);
      const uid = String(ctx.action?.params?.uid || ctx.action?.params?.filterByTk || ctx.action?.params?.values?.uid || '').trim();
      if (!uid) fail(ctx, 400, 'Portal uid is required.');
      if (BUILTIN_UIDS.has(uid)) fail(ctx, 400, 'Cannot delete built-in portal.');
      ctx.body = await runTx(async transaction => {
        const repo = getRepo(db, 'uiLayouts');
        if (!repo) fail(ctx, 503, 'uiLayouts repository unavailable.');
        const existing = await repo.findOne({ filter: { uid }, transaction });
        if (!existing) fail(ctx, 404, 'Portal not found.');
        await getRepo(db, 'desktopRoutesUiLayouts')?.destroy?.({ filter: { uiLayoutUid: uid }, transaction });
        await repo.destroy({ filter: { uid }, transaction });
        await metaStore.write(uid, null, transaction);
        return { deleted: true, uid };
      });
      if (next) await next();
    },
    exportBlueprint: async (ctx, next) => {
      if (ctx.method && !['GET', 'POST'].includes(ctx.method)) fail(ctx, 405, 'Method not allowed.');
      await requireAdmin(ctx);
      const uid = String(ctx.action?.params?.uid || ctx.action?.params?.filterByTk || ctx.action?.params?.values?.uid || ctx.query?.uid || '').trim();
      if (!uid) fail(ctx, 400, 'Portal uid is required.');
      const [data, metaMap] = await Promise.all([loadPortalData(db), metaStore.read()]);
      const layout = data.layouts.find(l => l.uid === uid);
      if (!layout) fail(ctx, 404, 'Portal not found.');
      const routes = data.routesByPortal.get(uid) || [];
      const meta = metaMap[uid] || {};
      const roles = grantedLdxRoles(data.routeIdsByPortal.get(uid), data.rolesByRoute, meta.roles, data.excludedRoles);
      const portal = buildPortalDto(layout, meta, routes, roles);
      delete portal.routeCount;
      delete portal.roles;
      ctx.body = { format: 'latticedx.portal-blueprint.v1', license: 'Apache-2.0', exportedAt: new Date().toISOString(), portal, routes: sanitizeRouteTree(routes), roles };
      if (next) await next();
    },
  } });
  app.acl.allow('latticePortals', ['list', 'listAccessible', 'save', 'destroy', 'exportBlueprint'], 'loggedIn');
}

module.exports = { registerNativePortals, isPortalAdmin };
