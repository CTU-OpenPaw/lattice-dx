/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { validateAiProfilePayload, recordAiAuditLog } = require('./ai-schemas');
const { enforceProfileRoleLock, syncProfileToNocobaseAi } = require('./ai-sync');

const LDX_ROLE_RE = /^ldx_[a-z][a-z0-9_]{1,40}$/;
const IMMUTABLE_WRITE_FIELDS = new Set(['id', 'createdAt', 'updatedAt', 'organizationId', 'identitySubject', 'userId']);
const VALID_CREATIVE_THEMES = new Set(['industrial-cockpit', 'emerald-ops', 'amber-alert', 'royal-indigo', 'clean-light']);
const VALID_QUERY_KINDS = new Set(['collection', 'telemetry', 'tasks']);
const VALID_WIDGET_TYPES = new Set([
  'gauge', 'thermometer', 'stage-pipeline', 'distribution-bars',
  'rule-callout', 'status-matrix', 'quick-actions',
]);
const SAFE_COL_RE = /^[a-zA-Z0-9_]{1,64}$/;
const NATIVE_SURFACE_ACTIONS = [
  'addField', 'addAction', 'addRecordAction',
  'updateSettings', 'setFieldLinkageRules', 'setFieldValueRules',
];

const surfaceRevisionStore = new Map();
const syncedSnapshotDbs = new WeakSet();

function isSafeLocalPath(rawPath) {
  if (typeof rawPath !== 'string') return false;
  const trimmed = rawPath.trim();
  if (!trimmed || !trimmed.startsWith('/') || trimmed.startsWith('//')) return false;
  return !/[\r\n\0\\]/.test(trimmed) && !trimmed.includes('..');
}

function surfaceKey(portalSlug, pageTitle) {
  const s = String(portalSlug || '').trim().toLowerCase();
  const p = String(pageTitle || '').trim().toLowerCase();
  return p ? `${s}::${p}` : s;
}

function bumpSurfaceRevision(portalSlug, { pageTitle = '', blockCount, layoutSignature, lastMutatedUid = null, message = 'AI Architect vừa cập nhật giao diện trực tiếp' } = {}) {
  const keys = [surfaceKey(portalSlug), ...(pageTitle ? [surfaceKey(portalSlug, pageTitle)] : [])];
  let nextState = null;
  for (const key of keys) {
    const prev = surfaceRevisionStore.get(key) || { revision: 1 };
    nextState = {
      portalSlug,
      pageTitle: pageTitle || prev.pageTitle || null,
      revision: Number(prev.revision || 1) + 1,
      blockCount: blockCount ?? prev.blockCount ?? 0,
      layoutSignature: layoutSignature ?? prev.layoutSignature ?? '',
      lastMutatedUid: lastMutatedUid || prev.lastMutatedUid || null,
      message,
      updatedAt: new Date().toISOString(),
    };
    surfaceRevisionStore.set(key, nextState);
  }
  return nextState;
}

async function ensureUiSnapshotsReady(db) {
  if (!db || syncedSnapshotDbs.has(db)) return;
  syncedSnapshotDbs.add(db);
  try {
    const col = db.getCollection?.('latticeUiSnapshots');
    if (col && typeof col.sync === 'function') await col.sync({ force: false });
    const colRepo = db.getRepository?.('collections');
    if (colRepo && typeof colRepo.db2cm === 'function' && !(await colRepo.findOne({ filter: { name: 'latticeUiSnapshots' } }))) {
      await colRepo.db2cm('latticeUiSnapshots');
    }
  } catch {
    // Non-fatal in mock test harnesses without Sequelize sync
  }
}

async function collectPortalRouteSet(db, portalSlug) {
  const layoutUid = `ldx-portal-${portalSlug}`;
  const routesRepo = db?.getRepository?.('desktopRoutes');
  const linksRepo = db?.getRepository?.('desktopRoutesUiLayouts');
  let routes = [];
  if (routesRepo) {
    try { routes = (await routesRepo.find({ appends: ['uiLayouts'], limit: 400 })) || []; }
    catch { routes = (await routesRepo.find({ limit: 400 })) || []; }
  }
  const links = linksRepo ? ((await linksRepo.find({ filter: { uiLayoutUid: layoutUid }, limit: 400 })) || []) : [];
  return { layoutUid, routes, links };
}

function resolvePortalRoutes(routes, links, layoutUid, val) {
  const directIds = new Set(links.filter((l) => val(l, 'uiLayoutUid') === layoutUid).map((l) => String(val(l, 'desktopRouteId'))));
  const inPortal = [];
  const inPortalIds = new Set();

  for (const r of routes) {
    const rid = String(val(r, 'id'));
    const layouts = val(r, 'uiLayouts');
    const matchesDirect = val(r, 'uiLayoutUid') === layoutUid
      || val(r, 'layoutUid') === layoutUid
      || directIds.has(rid)
      || (Array.isArray(layouts) && layouts.some((l) => val(l, 'uid') === layoutUid));
    if (matchesDirect) {
      inPortal.push(r);
      inPortalIds.add(rid);
    }
  }

  let grew = true;
  while (grew) {
    grew = false;
    for (const r of routes) {
      const rid = String(val(r, 'id'));
      const pid = val(r, 'parentId');
      if (!inPortalIds.has(rid) && pid != null && inPortalIds.has(String(pid))) {
        inPortal.push(r);
        inPortalIds.add(rid);
        grew = true;
      }
    }
  }
  return inPortal;
}

function findPortalTargetPage(portalRoutes, routes, pageTitle, val) {
  const pages = portalRoutes.filter((r) => ['flowPage', 'page'].includes(val(r, 'type')));
  if (pageTitle) {
    const q = String(pageTitle).trim().toLowerCase();
    const matched = pages.find((p) => String(val(p, 'title') || '').toLowerCase().includes(q));
    if (matched) return matched;
  }
  const overview = pages.find((p) => String(val(p, 'title') || '').toLowerCase().includes('tổng quan')) || pages[0];
  if (overview) return overview;
  for (const r of portalRoutes) {
    const children = val(r, 'children');
    if (Array.isArray(children)) {
      const childPage = children.find((c) => ['flowPage', 'page'].includes(val(c, 'type')));
      if (childPage) return childPage;
    }
  }
  return routes.find((r) => ['flowPage', 'page'].includes(val(r, 'type')) && portalRoutes.some((p) => String(val(p, 'id')) === String(val(r, 'parentId')))) || null;
}

function extractGridBlockUids(grid) {
  const layout = grid?.stepParams?.gridSettings?.grid || grid?.props || {};
  const rowOrder = Array.isArray(layout.rowOrder) ? layout.rowOrder : Object.keys(layout.rows || {});
  const ordered = [];
  const seen = new Set();
  for (const rowKey of rowOrder) {
    const cols = layout.rows?.[rowKey];
    if (!Array.isArray(cols)) continue;
    for (const col of cols) {
      for (const uid of Array.isArray(col) ? col : []) {
        if (uid && !seen.has(uid)) {
          seen.add(uid);
          ordered.push(uid);
        }
      }
    }
  }
  for (const item of Array.isArray(grid?.subModels?.items) ? grid.subModels.items : []) {
    if (item?.uid && !seen.has(item.uid)) {
      seen.add(item.uid);
      ordered.push(item.uid);
    }
  }
  return { ordered, layout };
}

function computeLayoutSignature(grid) {
  if (!grid) return '';
  const { ordered, layout } = extractGridBlockUids(grid);
  const rowOrder = Array.isArray(layout.rowOrder) ? layout.rowOrder : Object.keys(layout.rows || {});
  const rowParts = rowOrder.map((rk) => {
    const cols = Array.isArray(layout.rows?.[rk]) ? layout.rows[rk] : [];
    const spans = Array.isArray(layout.sizes?.[rk]) ? layout.sizes[rk] : [];
    return cols.map((col, idx) => `${(Array.isArray(col) ? col : []).join('+')}@${spans[idx] || 24}`).join('|');
  });
  return `${ordered.length}:${rowParts.join(';')}`;
}

function normalizeGridState(_grid, blockUids) {
  const rows = {};
  const sizes = {};
  const rowOrder = [];
  blockUids.forEach((uid, idx) => {
    const key = `dxos_row_${idx}`;
    rows[key] = [[uid]];
    sizes[key] = [24];
    rowOrder.push(key);
  });
  return { rows, sizes, rowOrder };
}

function computeMultiColumnGrid(rowsLayout, failTool) {
  if (!Array.isArray(rowsLayout) || !rowsLayout.length) {
    throw failTool('ROWS_LAYOUT_INVALID', 400, 'Cần rowsLayout là mảng các hàng không rỗng.');
  }
  const rows = {};
  const sizes = {};
  const rowOrder = [];
  rowsLayout.forEach((rowItems, idx) => {
    const rawList = Array.isArray(rowItems)
      ? rowItems
      : Array.isArray(rowItems?.columns)
        ? rowItems.columns
        : Array.isArray(rowItems?.cols)
          ? rowItems.cols
          : [rowItems];
    const colsRaw = rawList;
    if (!colsRaw.length) return;
    const key = `dxos_row_${idx}`;
    const colEntries = [];
    let assignedSum = 0;
    let unsizedCount = 0;
    for (const item of colsRaw) {
      const uid = typeof item === 'string' ? item.trim() : String(item?.uid || '').trim();
      if (!uid) throw failTool('ROW_UID_INVALID', 400, 'Mỗi cột trong rowsLayout phải có uid hợp lệ.');
      const spanVal = typeof item === 'object' && item?.span != null ? Number(item.span) : null;
      if (spanVal != null) {
        if (!Number.isFinite(spanVal) || spanVal <= 0 || spanVal > 24) {
          throw failTool('ROW_SPAN_INVALID', 400, `Span "${spanVal}" phải trong khoảng 1..24.`);
        }
        assignedSum += Math.round(spanVal);
      } else {
        unsizedCount += 1;
      }
      colEntries.push({ uid, span: spanVal != null ? Math.round(spanVal) : null });
    }
    if (assignedSum > 24) throw failTool('ROW_SPAN_OVERFLOW', 400, 'Tổng span trên 1 hàng không được vượt quá 24.');
    const remaining = Math.max(unsizedCount, 24 - assignedSum);
    const defaultSpan = unsizedCount > 0 ? Math.max(1, Math.floor(remaining / unsizedCount)) : 0;
    let used = assignedSum;
    let remIdx = 0;
    rows[key] = colEntries.map((c) => [c.uid]);
    sizes[key] = colEntries.map((c) => {
      if (c.span != null) return c.span;
      remIdx += 1;
      if (remIdx === unsizedCount) return Math.max(1, 24 - used);
      used += defaultSpan;
      return defaultSpan;
    });
    rowOrder.push(key);
  });
  return { rows, sizes, rowOrder };
}

async function resolvePageGrid(db, portalSlug, pageTitle, val) {
  const flowModelsRepo = db?.getRepository?.('flowModels');
  const { layoutUid, routes, links } = await collectPortalRouteSet(db, portalSlug);
  const portalRoutes = resolvePortalRoutes(routes, links, layoutUid, val);
  const pageRoute = findPortalTargetPage(portalRoutes, routes, pageTitle, val);
  if (!flowModelsRepo || !pageRoute) return { flowModelsRepo, layoutUid, portalRoutes, pageRoute, tabRoute: null, tabSchemaUid: null, grid: null };
  const pageId = String(val(pageRoute, 'id'));
  const tabRoute = routes.find((r) => String(val(r, 'parentId')) === pageId && val(r, 'type') === 'tabs') || null;
  const tabSchemaUid = val(tabRoute, 'schemaUid') || val(pageRoute, 'schemaUid') || val(pageRoute, 'pageUid') || null;
  const grid = tabSchemaUid && typeof flowModelsRepo.findModelByParentId === 'function'
    ? await flowModelsRepo.findModelByParentId(tabSchemaUid, { subKey: 'grid' })
    : null;
  return { flowModelsRepo, layoutUid, portalRoutes, pageRoute, tabRoute, tabSchemaUid, grid };
}

async function hydrateFlowModel(flowModelsRepo, uid, subItemsMap) {
  if (typeof flowModelsRepo?.findModelById === 'function') {
    const m = await flowModelsRepo.findModelById(uid);
    if (m) return m;
  }
  if (typeof flowModelsRepo?.findOne === 'function') {
    const row = await flowModelsRepo.findOne({ filter: { uid } });
    if (row) return row;
  }
  return subItemsMap?.get?.(uid) || null;
}

function readFlowModelMeta(model, uid) {
  const opts = model?.options && typeof model.options === 'object' ? model.options : {};
  const props = model?.props || opts.props || {};
  const stepParams = model?.stepParams || opts.stepParams || {};
  return {
    uid: model?.uid || uid,
    use: model?.use || opts.use || 'UnknownModel',
    title: props?.title || stepParams?.dxosBlockSettings?.config?.title || stepParams?.cardSettings?.title?.title || null,
    props,
    stepParams,
  };
}

async function updateGridLayout(flowModelsRepo, grid, nextLayout) {
  if (!grid?.uid || typeof flowModelsRepo?.updateSingleNode !== 'function') return;
  await flowModelsRepo.updateSingleNode({
    uid: grid.uid,
    props: { ...(grid.props || {}), ...nextLayout },
    stepParams: {
      ...(grid.stepParams || {}),
      gridSettings: { ...(grid.stepParams?.gridSettings || {}), grid: nextLayout },
    },
  });
}

async function placeBesideOrInsertBlock(flowModelsRepo, grid, newUid, placeBesideBlockUid, failTool) {
  const current = extractGridBlockUids(grid);
  const rowOrder = Array.isArray(current.layout?.rowOrder) && current.layout.rowOrder.length
    ? current.layout.rowOrder
    : Object.keys(current.layout?.rows || {});
  const curRows = current.layout?.rows || {};
  const existingUids = current.ordered;

  if (placeBesideBlockUid && existingUids.includes(placeBesideBlockUid)) {
    const rowsLayout = [];
    for (const rk of rowOrder) {
      const cols = Array.isArray(curRows[rk]) ? curRows[rk] : [];
      const rowUids = cols.flat().filter((u) => u && u !== newUid);
      if (!rowUids.length) continue;
      if (rowUids.includes(placeBesideBlockUid)) {
        rowsLayout.push([placeBesideBlockUid, newUid, ...rowUids.filter((u) => u !== placeBesideBlockUid)]);
      } else {
        rowsLayout.push(rowUids);
      }
    }
    const nextLayout = computeMultiColumnGrid(rowsLayout, failTool);
    await updateGridLayout(flowModelsRepo, grid, nextLayout);
    return { nextLayout, sideBySideWith: placeBesideBlockUid };
  }

  const filtered = existingUids.filter((u) => u !== newUid);
  // Insert right after hero block when row 0 is hero, otherwise prepend
  const heroIdx = filtered.findIndex((u) => String(u).includes('hero'));
  const nextOrder = heroIdx === 0 ? [filtered[0], newUid, ...filtered.slice(1)] : [newUid, ...filtered];
  const nextLayout = normalizeGridState(grid, nextOrder);
  await updateGridLayout(flowModelsRepo, grid, nextLayout);
  return { nextLayout, sideBySideWith: null };
}

async function propagatePortalRolesToRoutes(db, layoutUid, routeIds, explicitRoles, val) {
  const rolesRoutesRepo = db?.getRepository?.('rolesDesktopRoutes');
  const linksRepo = db?.getRepository?.('desktopRoutesUiLayouts');
  if (!rolesRoutesRepo || !routeIds.length) return [];

  let targetRoles = Array.isArray(explicitRoles) ? explicitRoles.filter((r) => LDX_ROLE_RE.test(r)) : [];
  if (!targetRoles.length && linksRepo) {
    const existingLinks = (await linksRepo.find({ filter: { uiLayoutUid: layoutUid }, limit: 400 })) || [];
    const existingRouteIds = existingLinks.map((l) => val(l, 'desktopRouteId')).filter((id) => id != null);
    if (existingRouteIds.length) {
      const existingGrants = (await rolesRoutesRepo.find({ filter: { desktopRouteId: { $in: existingRouteIds } }, limit: 400 })) || [];
      targetRoles = [...new Set(existingGrants.map((g) => val(g, 'roleName')).filter((r) => LDX_ROLE_RE.test(r)))];
    }
  }
  for (const desktopRouteId of routeIds) {
    for (const roleName of targetRoles) {
      if (!(await rolesRoutesRepo.findOne({ filter: { roleName, desktopRouteId } }))) {
        await rolesRoutesRepo.create({ values: { roleName, desktopRouteId } });
      }
    }
  }
  return targetRoles;
}

function buildRbacActionsSpec({ actions, readableFields, writableFields, lockedFields, scopeMode, collectionName, db }) {
  const lockSet = new Set(lockedFields || []);
  const viewFields = Array.isArray(readableFields) && readableFields.length ? [...new Set(readableFields)] : undefined;
  const rawWrite = Array.isArray(writableFields) && writableFields.length ? writableFields : viewFields || [];
  const safeWriteFields = rawWrite.filter((f) => !IMMUTABLE_WRITE_FIELDS.has(f) && !lockSet.has(f));

  const currentUserExpr = '{{ ctx.state.currentUser.id }}';
  const col = db?.getCollection?.(collectionName);
  const hasRequesterAssoc = ['latticeRequests', 'latticeOrders', 'latticeServiceTickets'].includes(collectionName)
    || Boolean(col?.hasField?.('requester'));

  const buildScope = (mode) => {
    if (!mode || mode === 'all_in_org') return undefined;
    if (mode === 'own_draft' && hasRequesterAssoc) {
      return { name: `Lattice — Nháp của tôi (${collectionName})`, resourceName: collectionName, dataSourceKey: 'main', scope: { 'requester.userId': currentUserExpr, status: 'draft' } };
    }
    if (hasRequesterAssoc) {
      return { name: `Lattice — Hồ sơ liên quan (${collectionName})`, resourceName: collectionName, dataSourceKey: 'main', scope: { $or: [{ 'requester.userId': currentUserExpr }, { 'assignee.userId': currentUserExpr }] } };
    }
    return { name: `Lattice — Bản ghi của tôi (${collectionName})`, resourceName: collectionName, dataSourceKey: 'main', scope: { createdById: currentUserExpr } };
  };

  const out = [];
  for (const act of actions) {
    if (act === 'view') {
      out.push({ name: 'view', ...(viewFields ? { fields: viewFields } : {}), ...(scopeMode === 'own' ? { scope: buildScope('own') } : {}) });
    } else if (act === 'create') {
      out.push({ name: 'create', ...(safeWriteFields.length ? { fields: safeWriteFields } : {}) });
    } else if (act === 'update') {
      const sc = buildScope(scopeMode);
      out.push({ name: 'update', ...(safeWriteFields.length ? { fields: safeWriteFields } : {}), ...(sc ? { scope: sc } : {}) });
    } else if (act === 'destroy' || act === 'export') {
      const sc = act === 'destroy' ? buildScope(scopeMode) : undefined;
      out.push({ name: act, ...(sc ? { scope: sc } : {}) });
    }
  }
  return out;
}

function sanitizeCreativeBlueprintPayload(raw = {}) {
  let obj = raw;
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj); } catch { obj = {}; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) obj = {};

  const theme = VALID_CREATIVE_THEMES.has(obj.theme) ? obj.theme : 'industrial-cockpit';
  const columns = Math.max(1, Math.min(4, Number(obj.columns) || 2));
  const queries = [];
  for (const q of Array.isArray(obj.queries) ? obj.queries : []) {
    if (!q || typeof q !== 'object') continue;
    const id = String(q.id || `q_${queries.length + 1}`).trim().slice(0, 40);
    const kind = VALID_QUERY_KINDS.has(q.kind) ? q.kind : 'collection';
    const collection = String(q.collection || '').trim();
    if (kind === 'collection' && !SAFE_COL_RE.test(collection)) continue;
    const filter = q.filter && typeof q.filter === 'object' && !Array.isArray(q.filter) ? q.filter : {};
    queries.push({ id, kind, collection, filter, limit: Math.max(1, Math.min(50, Number(q.limit) || 20)) });
    if (queries.length >= 6) break;
  }

  const widgets = [];
  for (const w of Array.isArray(obj.widgets) ? obj.widgets : []) {
    if (!w || typeof w !== 'object' || !VALID_WIDGET_TYPES.has(w.type)) continue;
    const item = { ...w, title: String(w.title || w.type).trim().slice(0, 80) };
    if (w.type === 'quick-actions') {
      item.buttons = (Array.isArray(w.buttons) ? w.buttons : []).filter((b) => {
        if (!b || typeof b !== 'object' || !b.label) return false;
        if ((b.kind || 'navigate') === 'navigate') return isSafeLocalPath(b.targetPath);
        if (b.kind === 'createRecord') return SAFE_COL_RE.test(String(b.collection || ''));
        return true;
      }).slice(0, 6);
    }
    widgets.push(item);
    if (widgets.length >= 12) break;
  }

  return {
    title: String(obj.title || 'Buồng Điều hành Sáng tạo [AI]').trim().slice(0, 120),
    subtitle: obj.subtitle ? String(obj.subtitle).trim().slice(0, 260) : '',
    badge: obj.badge ? String(obj.badge).trim().slice(0, 48) : 'CREATIVE STUDIO · GUARDRAILED DSL',
    theme,
    columns,
    queries,
    widgets,
  };
}

async function capturePageSnapshot(db, { portalSlug, pageTitle = '', note = '', createdByUsername = 'admin' }, val) {
  await ensureUiSnapshotsReady(db);
  const { flowModelsRepo, pageRoute, tabSchemaUid, grid } = await resolvePageGrid(db, portalSlug, pageTitle, val);
  if (!grid || !flowModelsRepo) return null;
  const { ordered, layout } = extractGridBlockUids(grid);
  const subMap = new Map((Array.isArray(grid?.subModels?.items) ? grid.subModels.items : []).map((m) => [m.uid, m]));
  const blocks = [];
  for (const uid of ordered) {
    const model = await hydrateFlowModel(flowModelsRepo, uid, subMap);
    const meta = readFlowModelMeta(model, uid);
    blocks.push({ uid: meta.uid, use: meta.use, props: meta.props, stepParams: meta.stepParams });
  }
  const snapshotUid = `snap-${portalSlug}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const values = {
    snapshotUid,
    portalSlug,
    pageTitle: val(pageRoute, 'title') || pageTitle || null,
    tabSchemaUid: tabSchemaUid || null,
    gridUid: grid.uid,
    note: String(note || 'Auto pre-mutation snapshot').slice(0, 200),
    createdByUsername,
    layoutState: { rows: layout.rows || {}, sizes: layout.sizes || {}, rowOrder: layout.rowOrder || [] },
    blocks,
  };
  const snapRepo = db?.getRepository?.('latticeUiSnapshots');
  if (snapRepo) await snapRepo.create({ values });
  return values;
}

async function restorePageSnapshot(db, { portalSlug, pageTitle = '', snapshotUid = '' }, val) {
  await ensureUiSnapshotsReady(db);
  const snapRepo = db?.getRepository?.('latticeUiSnapshots');
  if (!snapRepo) return { rolledBack: false, reason: 'latticeUiSnapshots repository unavailable' };
  let targetSnap = null;
  if (snapshotUid) {
    targetSnap = await snapRepo.findOne({ filter: { snapshotUid } });
  } else {
    if (pageTitle) {
      targetSnap = (await snapRepo.find({ filter: { portalSlug, pageTitle }, sort: ['-id'], limit: 1 }))?.[0] || null;
    }
    if (!targetSnap) {
      targetSnap = (await snapRepo.find({ filter: { portalSlug }, sort: ['-id'], limit: 1 }))?.[0] || null;
    }
  }
  if (!targetSnap) return { rolledBack: false, reason: `Không tìm thấy snapshot cho portal "${portalSlug}".` };

  const snapPageTitle = pageTitle || val(targetSnap, 'pageTitle') || '';
  const { flowModelsRepo, grid } = await resolvePageGrid(db, portalSlug, snapPageTitle, val);
  if (!grid || !flowModelsRepo) return { rolledBack: false, reason: `Không tìm thấy grid của portal "${portalSlug}".` };

  const blocks = Array.isArray(val(targetSnap, 'blocks')) ? val(targetSnap, 'blocks') : [];
  const keepUids = new Set(blocks.map((b) => b.uid));
  const currentUids = extractGridBlockUids(grid).ordered;

  for (const uid of currentUids) {
    if (!keepUids.has(uid)) {
      if (typeof flowModelsRepo.remove === 'function') await flowModelsRepo.remove(uid);
      else if (typeof flowModelsRepo.destroy === 'function') await flowModelsRepo.destroy({ filter: { uid } });
    }
  }
  for (const blk of blocks) {
    await flowModelsRepo.upsertModel({
      uid: blk.uid,
      use: blk.use,
      parentId: grid.uid,
      subKey: 'items',
      subType: 'array',
      props: blk.props || {},
      stepParams: blk.stepParams || {},
    });
  }
  const layoutState = val(targetSnap, 'layoutState') || normalizeGridState(grid, [...keepUids]);
  await updateGridLayout(flowModelsRepo, grid, layoutState);
  bumpSurfaceRevision(portalSlug, {
    pageTitle: snapPageTitle,
    blockCount: blocks.length,
    layoutSignature: computeLayoutSignature({ props: layoutState, stepParams: { gridSettings: { grid: layoutState } }, subModels: { items: blocks } }),
    message: `Đã hoàn tác bố cục về snapshot ${val(targetSnap, 'snapshotUid')}`,
  });
  return {
    rolledBack: true,
    snapshotUid: val(targetSnap, 'snapshotUid'),
    portalSlug,
    pageTitle: snapPageTitle,
    restoredCount: blocks.length,
  };
}

async function getSurfaceRevisionState(db, portalSlug, pageTitle, val) {
  const key = surfaceKey(portalSlug, pageTitle);
  const baseKey = surfaceKey(portalSlug);
  const stored = surfaceRevisionStore.get(key) || surfaceRevisionStore.get(baseKey);
  const { grid } = await resolvePageGrid(db, portalSlug, pageTitle, val);
  const liveSig = grid ? computeLayoutSignature(grid) : (stored?.layoutSignature || '');
  const liveCount = grid ? extractGridBlockUids(grid).ordered.length : (stored?.blockCount ?? 0);
  if (!stored) {
    const initial = { portalSlug, pageTitle: pageTitle || null, revision: 1, blockCount: liveCount, layoutSignature: liveSig, lastMutatedUid: null, message: '' };
    surfaceRevisionStore.set(key, initial);
    return initial;
  }
  return { ...stored, blockCount: liveCount, layoutSignature: liveSig || stored.layoutSignature };
}

function buildRecommendedBlueprintFromFields(collectionName, fields, targetRole = 'ldx_employee', goal = '') {
  const numField = fields.find((f) => ['float', 'integer', 'double', 'decimal', 'number'].includes(f.type));
  const selectField = fields.find((f) => f.interface === 'select' || (f.uiSchema?.enum?.length > 0)) || fields.find((f) => f.name === 'status');
  const textFields = fields.filter((f) => ['string', 'text'].includes(f.type)).map((f) => f.name).slice(0, 5);
  const widgets = [];
  if (numField) {
    widgets.push({
      type: numField.name.toLowerCase().includes('temp') ? 'thermometer' : 'gauge',
      title: numField.title || numField.name,
      queryId: 'primary',
      metric: 'latest',
      field: numField.name,
      min: numField.name.toLowerCase().includes('temp') ? -30 : 0,
      max: numField.name.toLowerCase().includes('temp') ? 10 : 100,
      warningThreshold: numField.name.toLowerCase().includes('temp') ? -15 : 80,
      unit: numField.name.toLowerCase().includes('temp') ? '°C' : '',
    });
  }
  widgets.push({
    type: 'distribution-bars',
    title: `Phân bổ theo ${selectField?.title || selectField?.name || 'trạng thái'}`,
    queryId: 'primary',
    field: selectField?.name || 'status',
  });
  widgets.push({
    type: 'stage-pipeline',
    title: `Luồng xử lý (${targetRole})`,
    stages: ['Tiếp nhận', 'Kiểm tra', targetRole.includes('manager') ? 'Phê duyệt' : 'Theo dõi', 'Hoàn tất'],
    activeIndex: 1,
  });
  widgets.push({
    type: 'quick-actions',
    title: 'Thao tác nhanh',
    buttons: [
      { label: 'Hỏi Trợ lý AI', kind: 'askAi', aiEmployee: 'dxos-coordinator', prompt: `Phân tích số liệu ${collectionName}`, primary: true },
      { label: 'Kho tri thức P.A.R.A.', kind: 'navigate', targetPath: '/p/services' },
    ],
  });

  const standardBlocks = [
    { type: 'table', title: `Danh sách ${collectionName}`, collection: collectionName, fields: [...new Set(['code', 'name', ...textFields, numField?.name, 'status'].filter(Boolean))] },
    { type: 'createForm', title: `Tạo mới ${collectionName}`, collection: collectionName, fields: [...new Set(['code', 'name', ...textFields, numField?.name].filter((f) => f && f !== 'status'))] },
    ...(selectField ? [{ type: 'kanban', title: `Bảng trạng thái ${collectionName}`, collection: collectionName }] : []),
  ];

  return {
    collectionName,
    targetRole,
    goal: goal || null,
    recommendedCreativeBlock: {
      blockUse: 'DxosCreativeStudioBlockModel',
      blueprint: {
        title: `Bảng Điều hành ${collectionName} [AI Gợi ý]`,
        theme: targetRole.includes('manager') ? 'royal-indigo' : 'industrial-cockpit',
        columns: 2,
        queries: [{ id: 'primary', collection: collectionName, limit: 20 }],
        widgets,
      },
    },
    recommendedStandardBlocks: standardBlocks,
    recommendedGridLayout: [['hero'], ['creative', 'kpi'], ['table', 'createForm']],
  };
}

function createSurfaceAndCreativeTools(deps) {
  const { val, failTool, safeGetResource, invokeResourceAction, createAuditedTool, SLUG_RE, CUSTOM_COLLECTION_RE } = deps;
  const hasRes = (ctx, name) => (typeof safeGetResource === 'function' ? safeGetResource(ctx, name) : null);

  return [
    createAuditedTool({
      name: 'dxos_recommend_page_blueprint',
      adminOnly: true,
      defaultPermission: 'ALLOW',
      introduction: { title: 'Gợi ý Kiến trúc Trang & Block AI', about: 'Đọc schema của collection và đề xuất Creative Block + Native Blocks + bố cục nhiều cột.' },
      description: 'Inspect target collection fields and recommend a multi-column Creative + Native page blueprint tailored to role & goal (Admin only).',
      schema: {
        description: 'Blueprint recommendation request.',
        properties: {
          collectionName: { type: 'string', required: true, maxLength: 64 },
          portalSlug: { type: 'string', maxLength: 40 },
          targetRole: { type: 'string', default: 'ldx_employee', maxLength: 48 },
          goal: { type: 'string', maxLength: 240 },
        },
      },
      async run(_ctx, db, _actor, args) {
        const colRepo = db?.getRepository?.('collections');
        const col = colRepo ? await colRepo.findOne({ filter: { name: args.collectionName } }) : null;
        let fields = [];
        if (col && typeof col.getFields === 'function') fields = await col.getFields();
        else if (Array.isArray(col?.fields)) fields = col.fields;
        const fieldList = fields.map((f) => ({
          name: val(f, 'name'),
          type: val(f, 'type'),
          interface: val(f, 'interface'),
          title: val(f, 'uiSchema')?.title || val(f, 'title') || val(f, 'name'),
          uiSchema: val(f, 'uiSchema') || {},
        }));
        return {
          portalSlug: args.portalSlug || null,
          collectionFound: Boolean(col),
          inspectedFieldsCount: fieldList.length,
          ...buildRecommendedBlueprintFromFields(args.collectionName, fieldList, args.targetRole || 'ldx_employee', args.goal || ''),
        };
      },
    }),

    createAuditedTool({
      name: 'dxos_design_creative_block',
      adminOnly: true,
      defaultPermission: 'ASK',
      introduction: { title: 'Sáng tạo Block Mới (Creative DSL)', about: 'Thiết kế & gắn block tùy biến mới (Gauge, Nhiệt kế, Pipeline, Rule Callout, Quick Actions) an toàn lên Portal.' },
      description: 'Create or update a guardrailed creative DxosCreativeStudioBlockModel on an existing portal page, optionally side-by-side (12:12) next to an existing block (Admin only; supports dryRun).',
      schema: {
        description: 'Creative block DSL authoring input.',
        properties: {
          portalSlug: { type: 'string', required: true, maxLength: 40 },
          pageTitle: { type: 'string', maxLength: 100 },
          blockUid: { type: 'string', maxLength: 80, description: 'Existing Creative block UID when editing.' },
          placeBesideBlockUid: { type: 'string', maxLength: 80, description: 'Optional existing block UID to share a [12, 12] 2-column row.' },
          blueprint: { type: 'object', description: 'Creative DSL { title, subtitle, badge, theme, columns, queries, widgets }.' },
          blueprintJson: { type: 'string', maxLength: 8000, description: 'Optional JSON string version of blueprint.' },
          dryRun: { type: 'boolean', default: false },
        },
      },
      async run(_ctx, db, actor, args) {
        if (!SLUG_RE.test(args.portalSlug)) throw failTool('PORTAL_SLUG_INVALID', 400, 'Slug portal không hợp lệ.');
        const cleanBp = sanitizeCreativeBlueprintPayload(args.blueprintJson || args.blueprint || {});
        if (args.dryRun) {
          return { dryRun: true, portalSlug: args.portalSlug, blockUse: 'DxosCreativeStudioBlockModel', placeBesideBlockUid: args.placeBesideBlockUid || null, blueprint: cleanBp };
        }
        const { flowModelsRepo, pageRoute, grid } = await resolvePageGrid(db, args.portalSlug, args.pageTitle, val);
        if (!grid || !flowModelsRepo) throw failTool('PAGE_GRID_NOT_FOUND', 404, `Không tìm thấy trang/grid trên portal "${args.portalSlug}".`);

        await capturePageSnapshot(db, { portalSlug: args.portalSlug, pageTitle: val(pageRoute, 'title') || args.pageTitle, note: `Before creative block: ${cleanBp.title}`, createdByUsername: actor.username }, val);

        const uid = args.blockUid || `dxos-cr-${args.portalSlug}-${Date.now().toString(36)}`;
        const cfg = { title: cleanBp.title, blueprintJson: JSON.stringify(cleanBp) };
        await flowModelsRepo.upsertModel({
          uid,
          use: 'DxosCreativeStudioBlockModel',
          parentId: grid.uid,
          subKey: 'items',
          subType: 'array',
          props: cfg,
          stepParams: { dxosBlockSettings: { config: cfg } },
        });

        let sideBySideWith = null;
        let nextLayout = null;
        if (!args.blockUid) {
          const placed = await placeBesideOrInsertBlock(flowModelsRepo, grid, uid, args.placeBesideBlockUid, failTool);
          nextLayout = placed.nextLayout;
          sideBySideWith = placed.sideBySideWith;
        }
        const blockCount = nextLayout ? Object.values(nextLayout.rows || {}).flat(2).length : extractGridBlockUids(grid).ordered.length;
        bumpSurfaceRevision(args.portalSlug, {
          pageTitle: val(pageRoute, 'title') || args.pageTitle,
          blockCount,
          layoutSignature: computeLayoutSignature({ props: nextLayout || grid.props }),
          lastMutatedUid: uid,
          message: `AI đã sáng tạo & gắn block "${cleanBp.title}"`,
        });

        return {
          applied: true,
          portalSlug: args.portalSlug,
          pageTitle: val(pageRoute, 'title') || args.pageTitle || null,
          blockUid: uid,
          blockUse: 'DxosCreativeStudioBlockModel',
          theme: cleanBp.theme,
          widgetCount: cleanBp.widgets.length,
          sideBySideWith,
          blueprint: cleanBp,
        };
      },
    }),

    createAuditedTool({
      name: 'dxos_snapshot_or_rollback_page',
      adminOnly: true,
      defaultPermission: 'ASK',
      introduction: { title: 'Snapshot & Rollback Bố cục (Time-Machine)', about: 'Lưu, xem lịch sử và khôi phục nguyên trạng bố cục trang chỉ với 1 bước.' },
      description: 'Capture, list, or restore page block & grid layout snapshots stored in latticeUiSnapshots (Admin only).',
      schema: {
        description: 'Page Time-Machine snapshot operation.',
        properties: {
          action: { type: 'string', required: true, enum: ['snapshot', 'listSnapshots', 'rollback'] },
          portalSlug: { type: 'string', required: true, maxLength: 40 },
          pageTitle: { type: 'string', maxLength: 100 },
          snapshotUid: { type: 'string', maxLength: 80 },
          note: { type: 'string', maxLength: 160 },
        },
      },
      async run(_ctx, db, actor, args) {
        if (!SLUG_RE.test(args.portalSlug)) throw failTool('PORTAL_SLUG_INVALID', 400, 'Slug portal không hợp lệ.');
        await ensureUiSnapshotsReady(db);
        if (args.action === 'snapshot') {
          const snap = await capturePageSnapshot(db, { portalSlug: args.portalSlug, pageTitle: args.pageTitle, note: args.note || 'Manual snapshot', createdByUsername: actor.username }, val);
          return { saved: Boolean(snap), snapshot: snap };
        }
        if (args.action === 'listSnapshots') {
          const snapRepo = db?.getRepository?.('latticeUiSnapshots');
          const rows = snapRepo ? (await snapRepo.find({ filter: { portalSlug: args.portalSlug }, sort: ['-id'], limit: 15 })) || [] : [];
          return {
            portalSlug: args.portalSlug,
            snapshots: rows.map((r) => ({
              snapshotUid: val(r, 'snapshotUid'),
              pageTitle: val(r, 'pageTitle'),
              note: val(r, 'note'),
              blockCount: Array.isArray(val(r, 'blocks')) ? val(r, 'blocks').length : 0,
              createdByUsername: val(r, 'createdByUsername'),
            })),
          };
        }
        return restorePageSnapshot(db, { portalSlug: args.portalSlug, pageTitle: args.pageTitle, snapshotUid: args.snapshotUid }, val);
      },
    }),

    createAuditedTool({
      name: 'dxos_provision_role_workspace',
      adminOnly: true,
      defaultPermission: 'ASK',
      introduction: { title: 'Dựng Trọn Gói Phân hệ theo Vai trò Mới', about: 'Tạo Role ldx_* mới → RBAC cấp trường → Trang mới + Creative Block → Trợ lý AI riêng.' },
      description: 'End-to-end workspace architect: create custom ldx_* role, set field-level RBAC, create dedicated portal page with Creative + Table blocks, and provision a dedicated non-admin AI assistant.',
      schema: {
        description: 'Role-to-Workspace & AI provision request.',
        properties: {
          roleName: { type: 'string', required: true, maxLength: 42 },
          roleTitle: { type: 'string', maxLength: 100 },
          portalSlug: { type: 'string', required: true, maxLength: 40 },
          pageTitle: { type: 'string', required: true, maxLength: 100 },
          collectionName: { type: 'string', required: true, maxLength: 64 },
          lockedFields: { type: 'array', items: { type: 'string' } },
          creativeTheme: { type: 'string', enum: ['industrial-cockpit', 'emerald-ops', 'amber-alert', 'royal-indigo', 'clean-light'], default: 'amber-alert' },
          aiUsername: { type: 'string', maxLength: 60 },
          aiNickname: { type: 'string', maxLength: 120 },
          dryRun: { type: 'boolean', default: false },
        },
      },
      async run(ctx, db, actor, args) {
        if (!LDX_ROLE_RE.test(args.roleName || '')) {
          throw failTool('ROLE_FORBIDDEN', 403, 'Chỉ cho phép tạo hoặc cấu hình vai trò tùy chỉnh bắt đầu bằng ldx_*.');
        }
        if (!SLUG_RE.test(args.portalSlug || '')) throw failTool('PORTAL_SLUG_INVALID', 400, 'Slug portal không hợp lệ.');
        if (args.dryRun) {
          return { dryRun: true, planned: { roleName: args.roleName, portalSlug: args.portalSlug, pageTitle: args.pageTitle, collectionName: args.collectionName, creativeTheme: args.creativeTheme || 'amber-alert', aiUsername: args.aiUsername || `dxos-${args.roleName.slice(4).replace(/_/g, '-')}` } };
        }

        // 1. Ensure custom role + dataSource RBAC + locked fields
        const rolesRepo = db?.getRepository?.('roles');
        if (rolesRepo) {
          const role = await rolesRepo.findOne({ filter: { name: args.roleName } });
          const rVals = { name: args.roleName, title: args.roleTitle || `Lattice — ${args.roleName}`, allowConfigure: false, allowNewMenu: false, allowNewAiEmployee: false, strategy: { actions: [] }, snippets: [] };
          if (role && typeof role.update === 'function') await role.update({ title: rVals.title });
          else await rolesRepo.create({ values: rVals });
        }
        const dsRolesRepo = db?.getRepository?.('dataSourcesRoles');
        if (dsRolesRepo && !(await dsRolesRepo.findOne({ filter: { roleName: args.roleName, dataSourceKey: 'main' } }))) {
          await dsRolesRepo.create({ values: { roleName: args.roleName, dataSourceKey: 'main' } });
        }
        const colRepo = db?.getRepository?.('collections');
        const col = colRepo ? await colRepo.findOne({ filter: { name: args.collectionName } }) : null;
        const fields = col && typeof col.getFields === 'function' ? await col.getFields() : (Array.isArray(col?.fields) ? col.fields : []);
        const fieldList = fields.map((f) => ({ name: val(f, 'name'), type: val(f, 'type'), interface: val(f, 'interface'), title: val(f, 'uiSchema')?.title || val(f, 'name'), uiSchema: val(f, 'uiSchema') || {} }));
        const fieldNames = fieldList.map((f) => f.name).filter(Boolean);
        const actionsSpec = buildRbacActionsSpec({
          actions: ['view', 'create'],
          readableFields: fieldNames.length ? fieldNames : ['id', 'code', 'name', 'status'],
          writableFields: fieldNames.length ? fieldNames : ['code', 'name'],
          lockedFields: args.lockedFields || [],
          collectionName: args.collectionName,
          db,
        });
        const resRepo = db?.getRepository?.('dataSourcesRolesResources');
        if (resRepo) {
          const exRes = await resRepo.findOne({ filter: { roleName: args.roleName, dataSourceKey: 'main', name: args.collectionName } });
          if (exRes && typeof resRepo.update === 'function') {
            await resRepo.update({ filter: { roleName: args.roleName, dataSourceKey: 'main', name: args.collectionName }, values: { usingActionsConfig: true, actions: actionsSpec }, updateAssociationValues: ['actions'] });
          } else {
            await resRepo.create({ values: { roleName: args.roleName, dataSourceKey: 'main', name: args.collectionName, usingActionsConfig: true, actions: actionsSpec } });
          }
          ctx?.app?.dataSourceManager?.dataSources?.get?.('main')?.acl?.getRole?.(args.roleName)?.writeToACL?.({ resourceName: args.collectionName, usingActionsConfig: true, actions: actionsSpec });
        }

        // 2. Grant Portal visibility + compose new Page (idempotent) + attach Creative Block + propagate role
        const layoutUid = `ldx-portal-${args.portalSlug}`;
        const portalSet = await collectPortalRouteSet(db, args.portalSlug);
        const existingPortalRoutes = resolvePortalRoutes(portalSet.routes, portalSet.links, layoutUid, val);
        const existingRouteIds = existingPortalRoutes.map((r) => val(r, 'id')).filter((id) => id != null);

        if (hasRes(ctx, 'latticePortals')) {
          const portalsRepo = db?.getRepository?.('uiLayouts');
          const curPortal = portalsRepo ? await portalsRepo.findOne({ filter: { uid: layoutUid } }) : null;
          const rolesRoutesRepo = db?.getRepository?.('rolesDesktopRoutes');
          let existingRoles = [];
          if (rolesRoutesRepo && existingRouteIds.length) {
            const grants = (await rolesRoutesRepo.find({ filter: { desktopRouteId: { $in: existingRouteIds } }, limit: 400 })) || [];
            existingRoles = grants.map((g) => val(g, 'roleName')).filter((r) => LDX_ROLE_RE.test(r));
          }
          const mergedRoles = [...new Set([...existingRoles, args.roleName])];
          await invokeResourceAction(ctx, 'latticePortals', 'save', {
            values: {
              ...(curPortal ? { uid: layoutUid } : {}),
              slug: args.portalSlug,
              title: val(curPortal, 'title') || `Portal ${args.portalSlug}`,
              layoutType: 'desktop',
              enabled: true,
              roles: mergedRoles,
            },
          });
        }
        await propagatePortalRolesToRoutes(db, layoutUid, existingRouteIds, [args.roleName], val);

        const targetPageTitleNorm = String(args.pageTitle || '').trim().toLowerCase();
        const existingExactPage = existingPortalRoutes.some(
          (r) => ['flowPage', 'page'].includes(val(r, 'type')) && String(val(r, 'title') || '').trim().toLowerCase() === targetPageTitleNorm,
        );
        const tableFields = (fieldNames.length ? fieldNames : ['code', 'name', 'status']).slice(0, 7);
        const bp = {
          version: '1',
          mode: 'create',
          navigation: { layoutUid, group: { title: args.roleTitle || args.pageTitle, icon: 'SafetyCertificateOutlined' }, item: { title: args.pageTitle, icon: 'DashboardOutlined' } },
          page: { title: args.pageTitle, displayTitle: true, enableTabs: false },
          tabs: [{ title: args.pageTitle, blocks: [{ key: `role-tbl-${Date.now().toString(36)}`, type: 'table', title: `Dữ liệu · ${args.pageTitle}`, collection: args.collectionName, fields: tableFields, actions: ['filter', 'refresh'] }] }],
        };
        if (hasRes(ctx, 'flowSurfaces') && !existingExactPage) {
          await invokeResourceAction(ctx, 'flowSurfaces', 'applyBlueprint', { values: bp });
        }

        const resolved = await resolvePageGrid(db, args.portalSlug, args.pageTitle, val);
        const createdRouteIds = resolved.pageRoute
          ? [val(resolved.pageRoute, 'parentId'), val(resolved.pageRoute, 'id'), ...resolved.portalRoutes.filter((r) => String(val(r, 'parentId')) === String(val(resolved.pageRoute, 'id'))).map((r) => val(r, 'id'))].filter((id) => id != null)
          : [];
        await propagatePortalRolesToRoutes(db, resolved.layoutUid, createdRouteIds, [args.roleName], val);

        let creativeUid = null;
        if (resolved.grid?.uid && resolved.flowModelsRepo?.upsertModel) {
          const recBp = buildRecommendedBlueprintFromFields(args.collectionName, fieldList, args.roleName, args.pageTitle).recommendedCreativeBlock.blueprint;
          const cleanBp = sanitizeCreativeBlueprintPayload({ ...recBp, title: `Trạm ${args.roleTitle || args.roleName} [AI Creative]`, theme: args.creativeTheme || 'amber-alert' });
          creativeUid = `dxos-cr-role-${args.portalSlug}-${Date.now().toString(36)}`;
          const cfg = { title: cleanBp.title, blueprintJson: JSON.stringify(cleanBp) };
          await resolved.flowModelsRepo.upsertModel({
            uid: creativeUid,
            use: 'DxosCreativeStudioBlockModel',
            parentId: resolved.grid.uid,
            subKey: 'items',
            subType: 'array',
            props: cfg,
            stepParams: { dxosBlockSettings: { config: cfg } },
          });
          await placeBesideOrInsertBlock(resolved.flowModelsRepo, resolved.grid, creativeUid, null, failTool);
        }

        // 3. Provision non-admin AI Assistant scoped to the new role & portal
        const aiUsername = String(args.aiUsername || `dxos-${args.roleName.slice(4).replace(/_/g, '-')}`).trim().toLowerCase();
        const aiNickname = String(args.aiNickname || `Trợ lý ${args.roleTitle || args.roleName} AI`).trim();
        const adminToolList = Array.isArray(deps.ADMIN_BUILDER_TOOL_NAMES) ? deps.ADMIN_BUILDER_TOOL_NAMES : [];
        const rawProfile = {
          username: aiUsername,
          nickname: aiNickname,
          position: `Trợ lý Chuyên trách ${args.roleTitle || args.roleName}`,
          departmentScope: args.roleName,
          organizationId: actor.organizationId || 'native-ui-lab',
          isAdminBuilder: false,
          allowedRoles: [args.roleName],
          portalBindings: [args.portalSlug],
          toolPermissions: {
            dxos_search_enterprise_context: 'ALLOW',
            dxos_my_tasks_copilot: 'ALLOW',
            dxos_execute_record_action: 'ASK',
            dxos_orchestrate_enterprise_case: 'ASK',
          },
          quickPrompts: [{ label: `Tóm tắt ${args.pageTitle}`, prompt: `Dùng dxos_search_enterprise_context kiểm tra dữ liệu mới nhất trên ${args.collectionName}.` }],
          systemPrompt: `Bạn là ${aiNickname} hỗ trợ vai trò ${args.roleName} tại không gian /p/${args.portalSlug} (${args.pageTitle}). Tuyệt đối tuân thủ các trường bị khóa RBAC: ${(args.lockedFields || []).join(', ') || 'không có'}.`,
        };
        const validatedProfile = enforceProfileRoleLock(validateAiProfilePayload(rawProfile, { adminToolNames: adminToolList }), adminToolList);
        const profRepo = db?.getRepository?.('latticeAiProfiles');
        if (profRepo) {
          const exProf = await profRepo.findOne({ filter: { username: validatedProfile.username } });
          if (exProf && typeof exProf.update === 'function') await exProf.update(validatedProfile);
          else await profRepo.create({ values: validatedProfile });
        }
        await syncProfileToNocobaseAi(db, validatedProfile, { adminToolNames: adminToolList });
        await recordAiAuditLog(db, {
          actorUserId: actor.userId,
          actorUsername: actor.username,
          organizationId: actor.organizationId,
          channel: 'studio-sync',
          aiEmployee: validatedProfile.username,
          toolName: 'dxos_provision_role_workspace',
          argsSummary: { roleName: args.roleName, portalSlug: args.portalSlug, pageTitle: args.pageTitle },
          status: 'allowed',
          resultSummary: `Provisioned role ${args.roleName}, page ${args.pageTitle}, AI ${validatedProfile.username}`,
        });
        bumpSurfaceRevision(args.portalSlug, { pageTitle: args.pageTitle, lastMutatedUid: creativeUid, message: `Đã dựng trọn gói cho vai trò ${args.roleName}` });

        return {
          provisioned: true,
          roleName: args.roleName,
          portalSlug: args.portalSlug,
          pageTitle: args.pageTitle,
          collectionName: args.collectionName,
          creativeBlockUid: creativeUid,
          aiEmployee: validatedProfile.username,
          lockedFields: args.lockedFields || [],
        };
      },
    }),
  ];
}

module.exports = {
  LDX_ROLE_RE,
  IMMUTABLE_WRITE_FIELDS,
  NATIVE_SURFACE_ACTIONS,
  collectPortalRouteSet,
  resolvePortalRoutes,
  findPortalTargetPage,
  extractGridBlockUids,
  computeLayoutSignature,
  normalizeGridState,
  computeMultiColumnGrid,
  resolvePageGrid,
  hydrateFlowModel,
  readFlowModelMeta,
  updateGridLayout,
  placeBesideOrInsertBlock,
  propagatePortalRolesToRoutes,
  buildRbacActionsSpec,
  sanitizeCreativeBlueprintPayload,
  ensureUiSnapshotsReady,
  capturePageSnapshot,
  restorePageSnapshot,
  bumpSurfaceRevision,
  getSurfaceRevisionState,
  buildRecommendedBlueprintFromFields,
  createSurfaceAndCreativeTools,
};
