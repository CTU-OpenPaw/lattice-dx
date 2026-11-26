/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { randomBytes } = require('node:crypto');
const { validateAiProfilePayload, recordAiAuditLog, resolveDefaultOrganizationId } = require('./ai-schemas');
const { enforceProfileRoleLock, syncProfileToNocobaseAi } = require('./ai-sync');
const { publishSurfaceUpdate } = require('./surface-events');

const LDX_ROLE_RE = /^ldx_[a-z][a-z0-9_]{1,40}$/;
const BUSINESS_ROLE_RE = /^[a-z][a-z0-9_]{1,40}$/;
const RESERVED_SYSTEM_ROLES = new Set(['root', 'admin', 'anonymous', 'member', 'ldx_sysadmin', 'ldx_connector']);
function isBusinessRoleName(roleName) {
  if (typeof roleName !== 'string') return false;
  const clean = roleName.trim();
  if (!BUSINESS_ROLE_RE.test(clean) && !LDX_ROLE_RE.test(clean)) return false;
  if (clean.startsWith('r_')) return false;
  return !RESERVED_SYSTEM_ROLES.has(clean);
}
const IMMUTABLE_WRITE_FIELDS = new Set(['id', 'createdAt', 'updatedAt', 'organizationId', 'identitySubject', 'userId']);
const VALID_CREATIVE_THEMES = new Set(['industrial-cockpit', 'emerald-ops', 'amber-alert', 'royal-indigo', 'clean-light']);
const VALID_QUERY_KINDS = new Set(['collection', 'telemetry', 'tasks', 'timeseries']);
const VALID_WIDGET_TYPES = new Set([
  'gauge', 'thermometer', 'timeseries-line', 'stage-pipeline', 'distribution-bars',
  'rule-callout', 'status-matrix', 'quick-actions', 'chatter', 'export-bar', 'voucher-actions',
]);
const SAFE_COL_RE = /^[a-zA-Z0-9_]{1,64}$/;
const NATIVE_SURFACE_ACTIONS = [
  'addField', 'addAction', 'addRecordAction',
  'updateSettings', 'setFieldLinkageRules', 'setFieldValueRules',
];

const MAX_SURFACE_CACHE_ENTRIES = 500;
const SURFACE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const surfaceRevisionStore = new Map();
const syncedSnapshotDbs = new WeakSet();

function setSurfaceRevisionEntry(key, value) {
  const now = Date.now();
  const tagged = { ...value, _cachedAtMs: now };
  if (surfaceRevisionStore.has(key)) surfaceRevisionStore.delete(key);
  surfaceRevisionStore.set(key, tagged);
  for (const [k, entry] of surfaceRevisionStore.entries()) {
    if (now - Number(entry?._cachedAtMs || 0) > SURFACE_CACHE_TTL_MS) {
      surfaceRevisionStore.delete(k);
    }
  }
  while (surfaceRevisionStore.size > MAX_SURFACE_CACHE_ENTRIES) {
    const oldestKey = surfaceRevisionStore.keys().next().value;
    if (oldestKey === undefined) break;
    surfaceRevisionStore.delete(oldestKey);
  }
}

function isSafeLocalPath(rawPath) {
  if (typeof rawPath !== 'string') return false;
  const trimmed = rawPath.trim();
  if (!trimmed || !trimmed.startsWith('/') || trimmed.startsWith('//')) return false;
  return !/[\r\n\0\\]/.test(trimmed) && !trimmed.includes('..');
}

function surfaceKey(portalSlug, pageTitle, organizationId = '') {
  const s = String(portalSlug || '').trim().toLowerCase();
  const p = String(pageTitle || '').trim().toLowerCase();
  const o = String(organizationId || '').trim();
  const base = p ? `${s}::${p}` : s;
  return o ? `${o}::${base}` : base;
}

function bumpSurfaceRevision(portalSlug, { organizationId = '', pageTitle = '', blockCount, layoutSignature, lastMutatedUid = null, message = 'AI Architect vừa cập nhật giao diện trực tiếp' } = {}) {
  const org = String(organizationId || '').trim();
  const keys = [surfaceKey(portalSlug, '', org), ...(pageTitle ? [surfaceKey(portalSlug, pageTitle, org)] : [])];
  let nextState = null;
  for (const key of keys) {
    const prev = surfaceRevisionStore.get(key) || { revision: 1 };
    nextState = {
      ...(org ? { organizationId: org } : {}),
      portalSlug,
      pageTitle: pageTitle || prev.pageTitle || null,
      revision: Number(prev.revision || 1) + 1,
      blockCount: blockCount ?? prev.blockCount ?? 0,
      layoutSignature: layoutSignature ?? prev.layoutSignature ?? '',
      lastMutatedUid: lastMutatedUid || prev.lastMutatedUid || null,
      message,
      updatedAt: new Date().toISOString(),
    };
    setSurfaceRevisionEntry(key, nextState);
  }
  if (nextState) publishSurfaceUpdate(portalSlug, nextState);
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

  let targetRoles = Array.isArray(explicitRoles) ? explicitRoles.filter((r) => isBusinessRoleName(r)) : [];
  if (!targetRoles.length && linksRepo) {
    const existingLinks = (await linksRepo.find({ filter: { uiLayoutUid: layoutUid }, limit: 400 })) || [];
    const existingRouteIds = existingLinks.map((l) => val(l, 'desktopRouteId')).filter((id) => id != null);
    if (existingRouteIds.length) {
      const existingGrants = (await rolesRoutesRepo.find({ filter: { desktopRouteId: { $in: existingRouteIds } }, limit: 400 })) || [];
      targetRoles = [...new Set(existingGrants.map((g) => val(g, 'roleName')).filter((r) => isBusinessRoleName(r)))];
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
    queries.push({
      id,
      kind,
      collection,
      filter,
      limit: Math.max(1, Math.min(kind === 'timeseries' ? 200 : 50, Number(q.limit) || 20)),
      ...(q.assetEntityId ? { assetEntityId: String(q.assetEntityId).trim().slice(0, 120) } : {}),
      ...(q.assetId != null ? { assetId: q.assetId } : {}),
      ...(q.attribute ? { attribute: String(q.attribute).trim().slice(0, 60) } : {}),
    });
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
    } else if (w.type === 'chatter' || w.type === 'export-bar' || w.type === 'voucher-actions') {
      if (w.collection && SAFE_COL_RE.test(String(w.collection).trim())) {
        item.collection = String(w.collection).trim();
      } else {
        delete item.collection;
      }
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

async function capturePageSnapshot(db, { portalSlug, pageTitle = '', note = '', createdByUsername = 'admin', organizationId = null }, val) {
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
  const snapshotUid = `snap-${portalSlug}-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`;
  const cleanOrg = organizationId ? String(organizationId).trim() : null;
  const values = {
    ...(cleanOrg ? { organizationId: cleanOrg } : {}),
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

async function restorePageSnapshot(db, { portalSlug, pageTitle = '', snapshotUid = '', organizationId = null, allowCrossOrg = true, scopedBlockUids = null }, val) {
  await ensureUiSnapshotsReady(db);
  const snapRepo = db?.getRepository?.('latticeUiSnapshots');
  if (!snapRepo) return { rolledBack: false, reason: 'latticeUiSnapshots repository unavailable' };
  const cleanOrg = organizationId ? String(organizationId).trim() : '';
  if (!allowCrossOrg && !cleanOrg) {
    return { rolledBack: false, code: 'DXOS_ORG_MISMATCH', reason: 'Yêu cầu organizationId hợp lệ để hoàn tác snapshot.' };
  }
  let targetSnap = null;
  if (snapshotUid) {
    targetSnap = await snapRepo.findOne({ filter: { snapshotUid } });
    if (targetSnap && !allowCrossOrg) {
      const snapOrg = String(val(targetSnap, 'organizationId') || '').trim();
      if (!snapOrg || snapOrg !== cleanOrg) {
        return { rolledBack: false, code: 'DXOS_ORG_MISMATCH', reason: 'Không được phép hoàn tác snapshot của tổ chức khác.' };
      }
    }
  } else {
    const orgFilter = !allowCrossOrg ? { organizationId: cleanOrg } : {};
    if (pageTitle) {
      targetSnap = (await snapRepo.find({ filter: { portalSlug, pageTitle, ...orgFilter }, sort: ['-id'], limit: 1 }))?.[0] || null;
    }
    if (!targetSnap) {
      targetSnap = (await snapRepo.find({ filter: { portalSlug, ...orgFilter }, sort: ['-id'], limit: 1 }))?.[0] || null;
    }
  }
  if (!targetSnap) return { rolledBack: false, reason: `Không tìm thấy snapshot cho portal "${portalSlug}".` };

  const snapPageTitle = pageTitle || val(targetSnap, 'pageTitle') || '';
  const { flowModelsRepo, grid } = await resolvePageGrid(db, portalSlug, snapPageTitle, val);
  if (!grid || !flowModelsRepo) return { rolledBack: false, reason: `Không tìm thấy grid của portal "${portalSlug}".` };

  const hasScopedFilter = Array.isArray(scopedBlockUids) || scopedBlockUids instanceof Set;
  const scopedSet = hasScopedFilter ? new Set([...scopedBlockUids].filter(Boolean)) : null;
  const rawBlocks = Array.isArray(val(targetSnap, 'blocks')) ? val(targetSnap, 'blocks') : [];
  const blocks = scopedSet ? rawBlocks.filter((b) => scopedSet.has(b?.uid)) : rawBlocks;
  const keepUids = new Set(blocks.map((b) => b.uid));
  const currentUids = extractGridBlockUids(grid).ordered;

  for (const uid of currentUids) {
    if (scopedSet && !scopedSet.has(uid)) continue;
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
  let layoutState;
  if (scopedSet) {
    const foreignUids = currentUids.filter((u) => !scopedSet.has(u));
    const restoredUids = blocks.map((b) => b.uid).filter(Boolean);
    layoutState = normalizeGridState(grid, [...new Set([...foreignUids, ...restoredUids])]);
  } else {
    layoutState = val(targetSnap, 'layoutState') || normalizeGridState(grid, [...keepUids]);
  }
  await updateGridLayout(flowModelsRepo, grid, layoutState);
  const effectiveOrg = cleanOrg || String(val(targetSnap, 'organizationId') || '').trim();
  bumpSurfaceRevision(portalSlug, {
    organizationId: effectiveOrg,
    pageTitle: snapPageTitle,
    blockCount: scopedSet ? extractGridBlockUids({ props: layoutState }).ordered.length : blocks.length,
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

async function getSurfaceRevisionState(db, portalSlug, pageTitle, val, organizationId = '') {
  const org = String(organizationId || '').trim();
  const key = surfaceKey(portalSlug, pageTitle, org);
  const baseKey = surfaceKey(portalSlug, '', org);
  const stored = surfaceRevisionStore.get(key) || surfaceRevisionStore.get(baseKey);
  const { grid } = await resolvePageGrid(db, portalSlug, pageTitle, val);
  const liveSig = grid ? computeLayoutSignature(grid) : (stored?.layoutSignature || '');
  const liveCount = grid ? extractGridBlockUids(grid).ordered.length : (stored?.blockCount ?? 0);
  if (!stored) {
    const initial = { ...(org ? { organizationId: org } : {}), portalSlug, pageTitle: pageTitle || null, revision: 1, blockCount: liveCount, layoutSignature: liveSig, lastMutatedUid: null, message: '' };
    setSurfaceRevisionEntry(key, initial);
    return initial;
  }
  return { ...stored, ...(org ? { organizationId: org } : {}), blockCount: liveCount, layoutSignature: liveSig || stored.layoutSignature };
}

function stripVietnameseDiacritics(input) {
  return String(input || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

function slugifyVietnameseToLdxRole(title) {
  const clean = stripVietnameseDiacritics(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!clean) return 'ldx_custom_role';
  let slug = clean.startsWith('ldx_') ? clean : `ldx_${clean}`;
  if (!/^ldx_[a-z]/.test(slug)) slug = `ldx_role_${clean.replace(/^_+/, '') || 'custom'}`;
  return slug.slice(0, 42).replace(/_+$/, '');
}

function normalizeAiUsername(rawUsername, effectiveRoleName) {
  const fallback = `dxos-${String(effectiveRoleName || 'assistant').replace(/^ldx_/, '').replace(/_/g, '-')}`;
  const raw = String(rawUsername || '').trim();
  if (!raw) return fallback;
  const cleaned = stripVietnameseDiacritics(raw)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56);
  return /^[a-z0-9]/.test(cleaned) && cleaned.length >= 2 ? cleaned : fallback;
}

async function loadCollectionFieldsMeta(db, collectionName, val) {
  const colRepo = db?.getRepository?.('collections');
  const col = colRepo && collectionName ? await colRepo.findOne({ filter: { name: collectionName } }) : null;
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
  return { col, fieldList };
}

async function inferPortalPrimaryCollection(db, portalSlug, pageTitle, val) {
  const { flowModelsRepo, grid } = await resolvePageGrid(db, portalSlug, pageTitle, val);
  if (grid && flowModelsRepo) {
    const ordered = extractGridBlockUids(grid).ordered;
    const subMap = new Map((Array.isArray(grid?.subModels?.items) ? grid.subModels.items : []).map((m) => [m.uid, m]));
    for (const uid of ordered) {
      const m = await hydrateFlowModel(flowModelsRepo, uid, subMap);
      const colName = m?.stepParams?.resourceSettings?.init?.collectionName
        || m?.options?.stepParams?.resourceSettings?.init?.collectionName;
      if (colName && SAFE_COL_RE.test(colName)) return colName;
    }
    for (const uid of ordered) {
      const m = await hydrateFlowModel(flowModelsRepo, uid, subMap);
      const meta = readFlowModelMeta(m, uid);
      const metricsRaw = meta.props?.metricsJson || meta.stepParams?.dxosBlockSettings?.config?.metricsJson;
      if (typeof metricsRaw === 'string') {
        try {
          const parsed = JSON.parse(metricsRaw);
          if (Array.isArray(parsed) && parsed[0]?.collection && SAFE_COL_RE.test(parsed[0].collection)) {
            return parsed[0].collection;
          }
        } catch {}
      }
    }
  }
  const colsRepo = db?.getRepository?.('collections');
  if (colsRepo) {
    const cols = (await colsRepo.find({ limit: 80 })) || [];
    const custom = cols.map((c) => val(c, 'name')).find((n) => /^latticeCustom/.test(String(n || '')));
    if (custom) return custom;
  }
  return 'latticeServiceTickets';
}

async function resolveBlockUidByHint(flowModelsRepo, grid, hint) {
  const cleanHint = String(hint || '').trim();
  if (!grid || !flowModelsRepo || !cleanHint) return cleanHint || null;
  const ordered = extractGridBlockUids(grid).ordered;
  if (ordered.includes(cleanHint)) return cleanHint;
  const subMap = new Map((Array.isArray(grid?.subModels?.items) ? grid.subModels.items : []).map((m) => [m.uid, m]));
  const q = stripVietnameseDiacritics(cleanHint).toLowerCase();
  for (const uid of ordered) {
    const model = await hydrateFlowModel(flowModelsRepo, uid, subMap);
    const meta = readFlowModelMeta(model, uid);
    const normTitle = stripVietnameseDiacritics(meta.title || '').toLowerCase();
    const useLower = String(meta.use || '').toLowerCase();
    if (
      (normTitle && normTitle.includes(q))
      || ((q.includes('kpi') || q.includes('chi so')) && useLower.includes('kpi'))
      || (q.includes('hero') && useLower.includes('hero'))
      || ((q.includes('bang') || q.includes('table') || q.includes('danh sach')) && useLower.includes('table'))
      || ((q.includes('bieu mau') || q.includes('form') || q.includes('tao moi')) && useLower.includes('createform'))
    ) {
      return uid;
    }
  }
  return null;
}

function resolveFieldNamesByNaturalLabels(fieldList, rawLabels) {
  const items = Array.isArray(rawLabels) ? rawLabels : [];
  const exactSet = new Set(fieldList.map((f) => f.name).filter(Boolean));
  const out = [];
  for (const raw of items) {
    const text = String(raw || '').trim();
    if (!text) continue;
    if (exactSet.has(text)) {
      out.push(text);
      continue;
    }
    const q = stripVietnameseDiacritics(text).toLowerCase();
    const matched = fieldList.find((f) => {
      const nName = stripVietnameseDiacritics(f.name || '').toLowerCase();
      const nTitle = stripVietnameseDiacritics(f.title || '').toLowerCase();
      return nTitle === q || nName === q || (nTitle && (nTitle.includes(q) || q.includes(nTitle)));
    });
    out.push(matched ? matched.name : text);
  }
  return [...new Set(out)];
}

function synthesizeNaturalCreativeBlueprint({ collectionName, fieldList, title, subtitle, theme, goal }) {
  const normGoal = stripVietnameseDiacritics(goal || title || '').toLowerCase();
  const numField = fieldList.find((f) => ['float', 'integer', 'double', 'decimal', 'number'].includes(f.type) && /temp|nhiet/i.test(`${f.name} ${f.title}`))
    || fieldList.find((f) => ['float', 'integer', 'double', 'decimal', 'number'].includes(f.type));
  const isTemp = Boolean(normGoal.includes('nhiet') || /temp|nhiet/i.test(`${numField?.name || ''} ${numField?.title || ''}`));
  const metricField = numField?.name || (isTemp ? 'temperatureC' : 'id');
  const unit = isTemp ? '°C' : '';

  let threshold = isTemp ? -15 : 80;
  const negMatch = normGoal.match(/(?:am\s+|-)(\d+(?:\.\d+)?)/);
  if (negMatch) {
    threshold = -Number(negMatch[1]);
  } else {
    const cmpMatch = normGoal.match(/(?:>|vuot|cao hon|lon hon|<|thap hon|duoi)\s*(\d+(?:\.\d+)?)/);
    if (cmpMatch) threshold = Number(cmpMatch[1]);
  }
  const operator = /(?:<|nho hon|thap hon|duoi)/.test(normGoal) ? 'lt' : 'gt';

  const widgets = [];
  widgets.push({
    type: isTemp ? 'thermometer' : 'gauge',
    title: isTemp ? 'Nhiệt độ đo gần nhất' : (numField?.title || 'Chỉ số chính'),
    queryId: 'primary',
    metric: numField ? 'latest' : 'count',
    field: metricField,
    min: isTemp ? -30 : 0,
    max: isTemp ? 10 : 100,
    warningThreshold: threshold,
    criticalThreshold: isTemp ? threshold + 3 : threshold + 10,
    unit,
  });

  if (normGoal.includes('canh bao') || normGoal.includes('nguong') || normGoal.includes('bao do') || normGoal.includes('alert') || negMatch) {
    widgets.push({
      type: 'rule-callout',
      title: isTemp ? 'Cảnh báo Ngưỡng Lạnh' : 'Cảnh báo Ngưỡng Vận hành',
      queryId: 'primary',
      metric: 'latest',
      field: metricField,
      operator,
      threshold,
      messageWhenTrue: `CẢNH BÁO ĐỎ: Vượt ngưỡng ${threshold}${unit}!`,
      messageWhenFalse: 'Đạt chuẩn vận hành',
    });
  } else {
    const selectField = fieldList.find((f) => f.interface === 'select' || (f.uiSchema?.enum?.length > 0)) || fieldList.find((f) => f.name === 'status');
    widgets.push({
      type: 'distribution-bars',
      title: `Phân bổ theo ${selectField?.title || selectField?.name || 'trạng thái'}`,
      queryId: 'primary',
      field: selectField?.name || 'status',
    });
  }

  widgets.push({
    type: 'stage-pipeline',
    title: 'Quy trình Thẩm định QA',
    stages: ['Tiếp nhận', 'Kiểm định', 'Phê duyệt', 'Hoàn tất'],
    activeIndex: 2,
  });

  const targetPath = normGoal.includes('su co') ? '/p/incidents'
    : normGoal.includes('van tai') || normGoal.includes('logistics') ? '/p/logistics'
      : '/p/services';
  const btnLabel = targetPath === '/p/incidents' ? 'Xem Sự cố' : targetPath === '/p/logistics' ? 'Mở Logistics' : 'Mở Kho Tài liệu';
  widgets.push({
    type: 'quick-actions',
    title: 'Thao tác nhanh',
    buttons: [{ label: btnLabel, kind: 'navigate', targetPath, primary: true }],
  });

  return sanitizeCreativeBlueprintPayload({
    title: title || `Buồng Điều hành ${collectionName}`,
    subtitle: subtitle || '',
    theme: theme || 'industrial-cockpit',
    columns: 2,
    queries: [{ id: 'primary', collection: collectionName, limit: 15 }],
    widgets,
  });
}

function buildRecommendedBlueprintFromFields(collectionName, fields, targetRole = 'ldx_employee', goal = '') {
  const numField = fields.find((f) => ['float', 'integer', 'double', 'decimal', 'number'].includes(f.type) && /temp|nhiet/i.test(`${f.name} ${f.title}`))
    || fields.find((f) => ['float', 'integer', 'double', 'decimal', 'number'].includes(f.type));
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
      { label: 'Kho tri thức P.A.R.A.', kind: 'navigate', targetPath: '/p/services', primary: true },
      { label: 'Danh sách Sự cố', kind: 'navigate', targetPath: '/p/incidents' },
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
      introduction: { title: 'Gợi ý Kiến trúc Trang & Block AI', about: 'Đọc schema của collection (hoặc tự dò trên trang hiện tại) và đề xuất Creative Block + Native Blocks + bố cục nhiều cột.' },
      description: 'Inspect target collection (or infer collection from portalSlug) and recommend a multi-column Creative + Native page blueprint tailored to role & goal (Admin only).',
      schema: {
        description: 'Blueprint recommendation request.',
        properties: {
          collectionName: { type: 'string', maxLength: 64, description: 'Optional collection name; auto-inferred from portalSlug page when omitted.' },
          portalSlug: { type: 'string', maxLength: 40 },
          pageTitle: { type: 'string', maxLength: 100 },
          targetRole: { type: 'string', default: 'ldx_employee', maxLength: 48 },
          goal: { type: 'string', maxLength: 240 },
        },
      },
      async run(_ctx, db, _actor, args) {
        const effectiveColName = args.collectionName || (args.portalSlug ? await inferPortalPrimaryCollection(db, args.portalSlug, args.pageTitle, val) : 'latticeServiceTickets');
        const { col, fieldList } = await loadCollectionFieldsMeta(db, effectiveColName, val);
        return {
          portalSlug: args.portalSlug || null,
          collectionFound: Boolean(col),
          inspectedFieldsCount: fieldList.length,
          ...buildRecommendedBlueprintFromFields(effectiveColName, fieldList, args.targetRole || 'ldx_employee', args.goal || ''),
        };
      },
    }),

    createAuditedTool({
      name: 'dxos_design_creative_block',
      adminOnly: true,
      defaultPermission: 'ASK',
      introduction: { title: 'Sáng tạo Block Mới (Creative DSL)', about: 'Thiết kế & gắn block tùy biến mới (Gauge, Nhiệt kế, Pipeline, Rule Callout, Quick Actions) an toàn lên Portal từ mô tả tiếng Việt hoặc blueprint.' },
      description: 'Create or update a guardrailed creative DxosCreativeStudioBlockModel on an existing portal page, optionally side-by-side (12:12) next to an existing block or natural block title (Admin only; supports dryRun).',
      schema: {
        description: 'Creative block authoring input (accepts explicit blueprint or natural title/theme/goal).',
        properties: {
          portalSlug: { type: 'string', required: true, maxLength: 40 },
          pageTitle: { type: 'string', maxLength: 100 },
          blockUid: { type: 'string', maxLength: 80, description: 'Existing Creative block UID when editing.' },
          placeBesideBlockUid: { type: 'string', maxLength: 80, description: 'Optional existing block UID (or Vietnamese title) to share a [12, 12] 2-column row.' },
          placeBesideTitle: { type: 'string', maxLength: 100, description: 'Natural Vietnamese block title or hint to place side-by-side (e.g., "Chỉ số" or "KPI").' },
          collectionName: { type: 'string', maxLength: 64 },
          title: { type: 'string', maxLength: 120 },
          subtitle: { type: 'string', maxLength: 240 },
          theme: { type: 'string', enum: ['industrial-cockpit', 'emerald-ops', 'amber-alert', 'royal-indigo', 'clean-light'] },
          goal: { type: 'string', maxLength: 600, description: 'Natural language description of metrics, thresholds, alerts, pipeline, and navigation buttons.' },
          blueprint: { type: 'object', description: 'Optional Creative DSL { title, subtitle, badge, theme, columns, queries, widgets }.' },
          blueprintJson: { type: 'string', maxLength: 8000, description: 'Optional JSON string version of blueprint.' },
          dryRun: { type: 'boolean', default: false },
        },
      },
      async run(_ctx, db, actor, args) {
        if (!SLUG_RE.test(args.portalSlug)) throw failTool('PORTAL_SLUG_INVALID', 400, 'Slug portal không hợp lệ.');
        const { flowModelsRepo, pageRoute, grid } = await resolvePageGrid(db, args.portalSlug, args.pageTitle, val);
        const explicitCandidate = args.blueprintJson || args.blueprint;
        const parsedExplicit = explicitCandidate ? sanitizeCreativeBlueprintPayload(explicitCandidate) : null;
        let cleanBp = parsedExplicit && parsedExplicit.widgets.length ? parsedExplicit : null;
        if (!cleanBp) {
          const inferredCol = args.collectionName || await inferPortalPrimaryCollection(db, args.portalSlug, args.pageTitle, val);
          const { fieldList } = await loadCollectionFieldsMeta(db, inferredCol, val);
          cleanBp = synthesizeNaturalCreativeBlueprint({
            collectionName: inferredCol,
            fieldList,
            title: args.title || parsedExplicit?.title,
            subtitle: args.subtitle || parsedExplicit?.subtitle,
            theme: args.theme || parsedExplicit?.theme || 'industrial-cockpit',
            goal: args.goal || args.title || '',
          });
        }
        const resolvedBesideUid = await resolveBlockUidByHint(flowModelsRepo, grid, args.placeBesideBlockUid || args.placeBesideTitle);
        if (args.dryRun) {
          return { dryRun: true, portalSlug: args.portalSlug, blockUse: 'DxosCreativeStudioBlockModel', placeBesideBlockUid: resolvedBesideUid, blueprint: cleanBp };
        }
        if (!grid || !flowModelsRepo) throw failTool('PAGE_GRID_NOT_FOUND', 404, `Không tìm thấy trang/grid trên portal "${args.portalSlug}".`);

        await capturePageSnapshot(db, { portalSlug: args.portalSlug, pageTitle: val(pageRoute, 'title') || args.pageTitle, note: `Before creative block: ${cleanBp.title}`, createdByUsername: actor.username, organizationId: actor.organizationId }, val);

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
          const placed = await placeBesideOrInsertBlock(flowModelsRepo, grid, uid, resolvedBesideUid, failTool);
          nextLayout = placed.nextLayout;
          sideBySideWith = placed.sideBySideWith;
        }
        const blockCount = nextLayout ? Object.values(nextLayout.rows || {}).flat(2).length : extractGridBlockUids(grid).ordered.length;
        bumpSurfaceRevision(args.portalSlug, {
          organizationId: actor.organizationId,
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
          const snap = await capturePageSnapshot(db, { portalSlug: args.portalSlug, pageTitle: args.pageTitle, note: args.note || 'Manual snapshot', createdByUsername: actor.username, organizationId: actor.organizationId }, val);
          return { saved: Boolean(snap), snapshot: snap };
        }
        if (args.action === 'listSnapshots') {
          const snapRepo = db?.getRepository?.('latticeUiSnapshots');
          const snapFilter = {
            portalSlug: args.portalSlug,
            ...(!actor.isRoot && actor.organizationId ? { organizationId: actor.organizationId } : {}),
          };
          const rows = snapRepo ? (await snapRepo.find({ filter: snapFilter, sort: ['-id'], limit: 15 })) || [] : [];
          return {
            portalSlug: args.portalSlug,
            snapshots: rows.map((r) => ({
              snapshotUid: val(r, 'snapshotUid'),
              organizationId: val(r, 'organizationId') || null,
              pageTitle: val(r, 'pageTitle'),
              note: val(r, 'note'),
              blockCount: Array.isArray(val(r, 'blocks')) ? val(r, 'blocks').length : 0,
              createdByUsername: val(r, 'createdByUsername'),
            })),
          };
        }
        return restorePageSnapshot(db, { portalSlug: args.portalSlug, pageTitle: args.pageTitle, snapshotUid: args.snapshotUid, organizationId: actor.organizationId, allowCrossOrg: Boolean(actor.isRoot) }, val);
      },
    }),

    createAuditedTool({
      name: 'dxos_provision_role_workspace',
      adminOnly: true,
      defaultPermission: 'ASK',
      introduction: { title: 'Dựng Trọn Gói Phân hệ theo Vai trò Mới', about: 'Tạo Role ldx_* mới → RBAC cấp trường → Trang mới + Creative Block → Trợ lý AI riêng.' },
      description: 'End-to-end workspace architect: create custom ldx_* role (auto-slugified from roleTitle if omitted), set field-level RBAC (supports Vietnamese field titles), create dedicated portal page with Creative + Table blocks, and provision a dedicated non-admin AI assistant.',
      schema: {
        description: 'Role-to-Workspace & AI provision request.',
        properties: {
          roleName: { type: 'string', maxLength: 42, description: 'Optional ldx_* role slug; auto-generated from roleTitle when omitted.' },
          roleTitle: { type: 'string', maxLength: 100 },
          portalSlug: { type: 'string', required: true, maxLength: 40 },
          pageTitle: { type: 'string', required: true, maxLength: 100 },
          collectionName: { type: 'string', maxLength: 64, description: 'Optional collection name; auto-inferred from portal when omitted.' },
          lockedFields: { type: 'array', items: { type: 'string' }, description: 'Field names or Vietnamese field titles to lock from edits.' },
          creativeTheme: { type: 'string', enum: ['industrial-cockpit', 'emerald-ops', 'amber-alert', 'royal-indigo', 'clean-light'], default: 'amber-alert' },
          aiUsername: { type: 'string', maxLength: 60 },
          aiNickname: { type: 'string', maxLength: 120 },
          dryRun: { type: 'boolean', default: false },
        },
      },
      async run(ctx, db, actor, args) {
        let effectiveRoleName = args.roleName
          ? String(args.roleName).trim()
          : (args.roleTitle ? slugifyVietnameseToLdxRole(args.roleTitle) : '');
        if (!isBusinessRoleName(effectiveRoleName)) {
          throw failTool('ROLE_FORBIDDEN', 403, 'Tên vai trò phải theo mẫu [a-z][a-z0-9_]+ và không thuộc nhóm vai trò hệ thống bị cấm.');
        }
        if (!SLUG_RE.test(args.portalSlug || '')) throw failTool('PORTAL_SLUG_INVALID', 400, 'Slug portal không hợp lệ.');
        const effectiveColName = args.collectionName || await inferPortalPrimaryCollection(db, args.portalSlug, null, val);
        const { fieldList } = await loadCollectionFieldsMeta(db, effectiveColName, val);
        const effectiveLocked = resolveFieldNamesByNaturalLabels(fieldList, args.lockedFields || []);
        if (args.dryRun) {
          return {
            dryRun: true,
            planned: {
              roleName: effectiveRoleName,
              portalSlug: args.portalSlug,
              pageTitle: args.pageTitle,
              collectionName: effectiveColName,
              lockedFields: effectiveLocked,
              creativeTheme: args.creativeTheme || 'amber-alert',
              aiUsername: normalizeAiUsername(args.aiUsername, effectiveRoleName),
            },
          };
        }

        // 1. Ensure custom role (handling roles_title_key uniqueness) + dataSource RBAC + locked fields
        const rolesRepo = db?.getRepository?.('roles');
        let desiredTitle = String(args.roleTitle || `Lattice — ${effectiveRoleName}`).trim();
        if (rolesRepo) {
          let role = await rolesRepo.findOne({ filter: { name: effectiveRoleName } });
          const byTitle = desiredTitle ? await rolesRepo.findOne({ filter: { title: desiredTitle } }) : null;
          const byTitleName = val(byTitle, 'name');
          if (!role && byTitle && byTitleName) {
            if (LDX_ROLE_RE.test(byTitleName)) {
              effectiveRoleName = byTitleName;
              role = byTitle;
            } else {
              desiredTitle = `${desiredTitle} (${effectiveRoleName})`;
            }
          } else if (role && byTitle && byTitleName && byTitleName !== effectiveRoleName) {
            desiredTitle = `${desiredTitle} (${effectiveRoleName})`;
          }
          const rVals = { name: effectiveRoleName, title: desiredTitle, allowConfigure: false, allowNewMenu: false, allowNewAiEmployee: false, strategy: { actions: [] }, snippets: [] };
          if (role && typeof role.update === 'function') await role.update({ title: rVals.title });
          else if (!role) await rolesRepo.create({ values: rVals });
        }
        const effectiveAiUsername = normalizeAiUsername(args.aiUsername, effectiveRoleName);
        const dsRolesRepo = db?.getRepository?.('dataSourcesRoles');
        if (dsRolesRepo && !(await dsRolesRepo.findOne({ filter: { roleName: effectiveRoleName, dataSourceKey: 'main' } }))) {
          await dsRolesRepo.create({ values: { roleName: effectiveRoleName, dataSourceKey: 'main' } });
        }
        const fieldNames = fieldList.map((f) => f.name).filter(Boolean);
        const actionsSpec = buildRbacActionsSpec({
          actions: ['view', 'create'],
          readableFields: fieldNames.length ? fieldNames : ['id', 'code', 'name', 'status'],
          writableFields: fieldNames.length ? fieldNames : ['code', 'name'],
          lockedFields: effectiveLocked,
          collectionName: effectiveColName,
          db,
        });
        const resRepo = db?.getRepository?.('dataSourcesRolesResources');
        if (resRepo) {
          const exRes = await resRepo.findOne({ filter: { roleName: effectiveRoleName, dataSourceKey: 'main', name: effectiveColName } });
          if (exRes && typeof resRepo.update === 'function') {
            await resRepo.update({ filter: { roleName: effectiveRoleName, dataSourceKey: 'main', name: effectiveColName }, values: { usingActionsConfig: true, actions: actionsSpec }, updateAssociationValues: ['actions'] });
          } else {
            await resRepo.create({ values: { roleName: effectiveRoleName, dataSourceKey: 'main', name: effectiveColName, usingActionsConfig: true, actions: actionsSpec } });
          }
          ctx?.app?.dataSourceManager?.dataSources?.get?.('main')?.acl?.getRole?.(effectiveRoleName)?.writeToACL?.({ resourceName: effectiveColName, usingActionsConfig: true, actions: actionsSpec });
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
            existingRoles = grants.map((g) => val(g, 'roleName')).filter((r) => isBusinessRoleName(r));
          }
          const mergedRoles = [...new Set([...existingRoles, effectiveRoleName])];
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
        await propagatePortalRolesToRoutes(db, layoutUid, existingRouteIds, [effectiveRoleName], val);

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
          tabs: [{ title: args.pageTitle, blocks: [{ key: `role-tbl-${Date.now().toString(36)}`, type: 'table', title: `Dữ liệu · ${args.pageTitle}`, collection: effectiveColName, fields: tableFields, actions: ['filter', 'refresh'] }] }],
        };
        if (hasRes(ctx, 'flowSurfaces') && !existingExactPage) {
          await invokeResourceAction(ctx, 'flowSurfaces', 'applyBlueprint', { values: bp });
        }

        const resolved = await resolvePageGrid(db, args.portalSlug, args.pageTitle, val);
        const createdRouteIds = resolved.pageRoute
          ? [val(resolved.pageRoute, 'parentId'), val(resolved.pageRoute, 'id'), ...resolved.portalRoutes.filter((r) => String(val(r, 'parentId')) === String(val(resolved.pageRoute, 'id'))).map((r) => val(r, 'id'))].filter((id) => id != null)
          : [];
        await propagatePortalRolesToRoutes(db, resolved.layoutUid, createdRouteIds, [effectiveRoleName], val);

        let creativeUid = null;
        if (resolved.grid?.uid && resolved.flowModelsRepo?.upsertModel) {
          const recBp = buildRecommendedBlueprintFromFields(effectiveColName, fieldList, effectiveRoleName, args.pageTitle).recommendedCreativeBlock.blueprint;
          const cleanBp = sanitizeCreativeBlueprintPayload({ ...recBp, title: `Trạm ${args.roleTitle || effectiveRoleName} [AI Creative]`, theme: args.creativeTheme || 'amber-alert' });
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
        const aiUsername = effectiveAiUsername;
        const aiNickname = String(args.aiNickname || `Trợ lý ${args.roleTitle || effectiveRoleName} AI`).trim();
        const adminToolList = Array.isArray(deps.ADMIN_BUILDER_TOOL_NAMES) ? deps.ADMIN_BUILDER_TOOL_NAMES : [];
        const resolvedOrgId = await resolveDefaultOrganizationId(db, { actor, ctx, fallback: 'default' });
        const rawProfile = {
          username: aiUsername,
          nickname: aiNickname,
          position: `Trợ lý Chuyên trách ${args.roleTitle || effectiveRoleName}`,
          departmentScope: effectiveRoleName,
          organizationId: resolvedOrgId,
          isAdminBuilder: false,
          allowedRoles: [effectiveRoleName],
          portalBindings: [args.portalSlug],
          toolPermissions: {
            dxos_search_enterprise_context: 'ALLOW',
            dxos_my_workflow_tasks: 'ALLOW',
            dxos_execute_record_action: 'ASK',
            dxos_orchestrate_enterprise_case: 'ASK',
          },
          quickPrompts: [{ label: `Tóm tắt ${args.pageTitle}`, prompt: `Kiểm tra dữ liệu mới nhất trên trang ${args.pageTitle}.` }],
          systemPrompt: `Bạn là ${aiNickname} hỗ trợ vai trò ${args.roleTitle || effectiveRoleName} tại không gian /p/${args.portalSlug} (${args.pageTitle}). Tuyệt đối tuân thủ các trường bị khóa phân quyền: ${effectiveLocked.join(', ') || 'không có'}. Giao tiếp tự nhiên bằng tiếng Việt.`,
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
          argsSummary: { roleName: effectiveRoleName, portalSlug: args.portalSlug, pageTitle: args.pageTitle },
          status: 'allowed',
          resultSummary: `Provisioned role ${effectiveRoleName}, page ${args.pageTitle}, AI ${validatedProfile.username}`,
        });
        bumpSurfaceRevision(args.portalSlug, { organizationId: actor.organizationId, pageTitle: args.pageTitle, lastMutatedUid: creativeUid, message: `Đã dựng trọn gói cho vai trò ${effectiveRoleName}` });

        return {
          provisioned: true,
          roleName: effectiveRoleName,
          portalSlug: args.portalSlug,
          pageTitle: args.pageTitle,
          collectionName: effectiveColName,
          creativeBlockUid: creativeUid,
          aiEmployee: validatedProfile.username,
          lockedFields: effectiveLocked,
        };
      },
    }),
  ];
}

module.exports = {
  LDX_ROLE_RE,
  BUSINESS_ROLE_RE,
  RESERVED_SYSTEM_ROLES,
  isBusinessRoleName,
  IMMUTABLE_WRITE_FIELDS,
  NATIVE_SURFACE_ACTIONS,
  VALID_WIDGET_TYPES,
  stripVietnameseDiacritics,
  slugifyVietnameseToLdxRole,
  normalizeAiUsername,
  inferPortalPrimaryCollection,
  resolveBlockUidByHint,
  resolveFieldNamesByNaturalLabels,
  synthesizeNaturalCreativeBlueprint,
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
  surfaceRevisionStore,
  bumpSurfaceRevision,
  getSurfaceRevisionState,
  buildRecommendedBlueprintFromFields,
  createSurfaceAndCreativeTools,
};
