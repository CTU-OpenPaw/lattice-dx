/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const LDX_ROLE_RE = /^ldx_[a-z][a-z0-9_]{1,40}$/;
const IMMUTABLE_WRITE_FIELDS = new Set(['id', 'createdAt', 'updatedAt', 'organizationId', 'identitySubject', 'userId']);
const ALLOWED_WORKFLOW_NODE_TYPES = ['condition', 'manual', 'update', 'create', 'query', 'calculation', 'output', 'parallel', 'delay'];
const FIELD_INTERFACE_MAP = {
  text: { interface: 'textarea', uiType: 'string' },
  integer: { interface: 'integer', uiType: 'number' },
  float: { interface: 'number', uiType: 'number' },
  boolean: { interface: 'checkbox', uiType: 'boolean' },
  date: { interface: 'datetime', uiType: 'string' },
  select: { interface: 'select', uiType: 'string' },
  string: { interface: 'input', uiType: 'string' },
};

async function collectPortalRouteSet(db, portalSlug) {
  const layoutUid = `ldx-portal-${portalSlug}`;
  const routesRepo = db?.getRepository?.('desktopRoutes');
  const linksRepo = db?.getRepository?.('desktopRoutesUiLayouts');
  let routes = [];
  if (routesRepo) {
    try {
      routes = (await routesRepo.find({ appends: ['uiLayouts'], limit: 400 })) || [];
    } catch {
      routes = (await routesRepo.find({ limit: 400 })) || [];
    }
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
  // Support compact nested children tree used by light mocks
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

function normalizeGridState(grid, blockUids) {
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

async function resolvePageGrid(db, portalSlug, pageTitle, val) {
  const flowModelsRepo = db?.getRepository?.('flowModels');
  const { layoutUid, routes, links } = await collectPortalRouteSet(db, portalSlug);
  const portalRoutes = resolvePortalRoutes(routes, links, layoutUid, val);
  const pageRoute = findPortalTargetPage(portalRoutes, routes, pageTitle, val);
  if (!flowModelsRepo || !pageRoute) return { layoutUid, portalRoutes, pageRoute, tabRoute: null, tabSchemaUid: null, grid: null };
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
  return subItemsMap.get(uid) || null;
}

function readFlowModelMeta(model, uid) {
  const opts = model?.options && typeof model.options === 'object' ? model.options : {};
  const props = model?.props || opts.props || {};
  const stepParams = model?.stepParams || opts.stepParams || {};
  return {
    uid: model?.uid || uid,
    use: model?.use || opts.use || 'UnknownModel',
    title: props?.title || stepParams?.dxosBlockSettings?.config?.title || null,
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

function buildFieldDefinition(rawField, failTool, FIELD_NAME_RE) {
  const fname = String(rawField?.name || '').trim();
  if (!FIELD_NAME_RE.test(fname)) {
    throw failTool('FIELD_NAME_INVALID', 400, `Tên trường "${fname}" không hợp lệ.`);
  }
  const ftype = Object.prototype.hasOwnProperty.call(FIELD_INTERFACE_MAP, rawField?.type) ? rawField.type : 'string';
  const meta = FIELD_INTERFACE_MAP[ftype];
  const enumValues = Array.isArray(rawField?.enumValues) ? rawField.enumValues.map((v) => String(v).trim()).filter(Boolean) : [];
  return {
    name: fname,
    type: ftype === 'select' ? 'string' : ftype,
    interface: meta.interface,
    ...(rawField?.defaultValue !== undefined ? { defaultValue: rawField.defaultValue } : {}),
    uiSchema: {
      type: meta.uiType,
      title: String(rawField?.title || fname),
      ...(ftype === 'select' && enumValues.length ? { enum: enumValues.map((v) => ({ value: v, label: v })) } : {}),
    },
  };
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

async function resolveOrgCrewBindings(db, organizationId, val) {
  const empRepo = db?.getRepository?.('latticeEmployees');
  if (!empRepo) return {};
  const rows = (await empRepo.find({ filter: { organizationId, active: true }, appends: ['user', 'user.roles'], limit: 100 })) || [];
  const byRole = {};
  for (const row of rows) {
    const id = val(row, 'id');
    const roles = Array.isArray(val(val(row, 'user'), 'roles')) ? val(val(row, 'user'), 'roles').map((r) => val(r, 'name')) : [];
    for (const r of roles) {
      if (!byRole[r]) byRole[r] = id;
    }
  }
  const fallback = val(rows[0], 'id');
  const mgr = byRole.ldx_manager || byRole.ldx_admin || fallback;
  const worker = byRole.ldx_warehouse || byRole.ldx_employee || fallback;
  return {
    ...(mgr ? { managerEmployeeId: mgr, reviewerEmployeeId: mgr } : {}),
    ...(worker ? { warehouseEmployeeId: worker, assigneeEmployeeId: worker, handlerEmployeeId: worker } : {}),
    ...(byRole.ldx_dispatcher || mgr ? { dispatcherEmployeeId: byRole.ldx_dispatcher || mgr } : {}),
    ...(byRole.ldx_driver || worker ? { driverEmployeeId: byRole.ldx_driver || worker } : {}),
  };
}

function createBuilderTools(deps) {
  const {
    val, failTool, safeGetResource, invokeResourceAction, createAuditedTool,
    SYSTEM_PROTECTED_COLLECTIONS, CUSTOM_COLLECTION_RE, FIELD_NAME_RE, SLUG_RE, ALLOWED_BLOCK_MODELS,
  } = deps;
  const hasRes = (ctx, name) => (typeof safeGetResource === 'function' ? safeGetResource(ctx, name) : null);

  return [
    createAuditedTool({
      name: 'dxos_inspect_architecture',
      adminOnly: true,
      defaultPermission: 'ALLOW',
      introduction: { title: 'Inspect Kiến trúc LatticeDX', about: 'Đọc portals, pages, blocks, collections, workflows, roles và AI profiles đang chạy.' },
      description: 'Inspect live LatticeDX portals, desktop pages, collections, active workflows, roles, and customizable AI employee profiles (Admin only).',
      schema: {
        description: 'Optional portal filter for detailed layout inspection.',
        properties: { portalSlug: { type: 'string', description: 'Optional portal slug such as services or logistics.', maxLength: 40 } },
      },
      async run(_ctx, db, actor, args) {
        const safeFind = async (repoName, filter = {}, limit = 100) => {
          const repo = db?.getRepository?.(repoName);
          return repo ? (await repo.find({ filter, limit })) || [] : [];
        };
        const [layouts, routes, cols, wfs, roles, profiles] = await Promise.all([
          safeFind('uiLayouts', {}, 50),
          safeFind('desktopRoutes', {}, 250),
          safeFind('collections', {}, 150),
          safeFind('workflows', { current: true }, 80),
          safeFind('roles', {}, 50),
          safeFind('latticeAiProfiles', {}, 50),
        ]);
        const portals = layouts.filter((l) => String(val(l, 'uid') || '').startsWith('ldx-portal-')).map((l) => ({
          uid: val(l, 'uid'), title: val(l, 'title') || val(l, 'name'), routePath: val(l, 'routePath') || null,
        }));
        let focused = {};
        if (args.portalSlug && SLUG_RE.test(args.portalSlug)) {
          const resolved = await resolvePageGrid(db, args.portalSlug, null, val);
          const gridUids = resolved.grid ? extractGridBlockUids(resolved.grid).ordered : [];
          focused = {
            focusedPortal: args.portalSlug,
            targetPageTitle: val(resolved.pageRoute, 'title') || null,
            tabSchemaUid: resolved.tabSchemaUid,
            gridUid: resolved.grid?.uid || null,
            blockUids: gridUids,
          };
        }
        return {
          inspectedBy: actor.username,
          portalCount: portals.length,
          portals,
          pageCount: routes.filter((r) => ['page', 'flowPage'].includes(val(r, 'type'))).length,
          businessCollections: cols.map((c) => val(c, 'name')).filter((n) => String(n || '').startsWith('lattice')),
          activeWorkflows: wfs.map((w) => ({ id: val(w, 'id'), title: val(w, 'title'), type: val(w, 'type'), enabled: val(w, 'enabled') })),
          roleNames: roles.map((r) => val(r, 'name')),
          aiProfileCount: profiles.length,
          ...focused,
        };
      },
    }),

    createAuditedTool({
      name: 'dxos_compose_page_blocks',
      adminOnly: true,
      defaultPermission: 'ASK',
      introduction: { title: 'Dựng & Chỉnh Block DX-OS', about: 'Inspect, dựng trang đa block, chỉnh sửa props, sắp xếp lại và gỡ block trên Portal.' },
      description: 'Inspect, build multi-block portal pages, add/update props, reorder, or remove blocks on LatticeDX portals (Admin only; supports dryRun preview).',
      schema: {
        description: 'Full lifecycle page & block builder command.',
        properties: {
          action: { type: 'string', default: 'addBlock', enum: ['addBlock', 'listBlocks', 'composePageBlueprint', 'updateBlock', 'reorderBlocks', 'removeBlock'] },
          portalSlug: { type: 'string', required: true, maxLength: 40, description: 'Target portal slug (e.g., services, cold-qa).' },
          pageTitle: { type: 'string', maxLength: 100, description: 'Optional page title filter when inspecting or editing blocks.' },
          groupTitle: { type: 'string', maxLength: 80, description: 'Menu group title for composePageBlueprint.' },
          blockUid: { type: 'string', maxLength: 80, description: 'Target block UID for updateBlock or removeBlock.' },
          blockUse: { type: 'string', enum: ALLOWED_BLOCK_MODELS, description: 'Block model class for addBlock.' },
          title: { type: 'string', maxLength: 100, description: 'Block or page title.' },
          collection: { type: 'string', maxLength: 60, description: 'Collection name for native table/form blocks.' },
          tableFields: { type: 'array', items: { type: 'string' }, description: 'Field names for NativeTableBlock in composePageBlueprint.' },
          includeCreateForm: { type: 'boolean', default: false, description: 'Include Native createForm block in composePageBlueprint.' },
          dxosBlocks: { type: 'array', items: { type: 'object' }, description: 'Array of { blockUse, title, config } DX-OS blocks to attach in composePageBlueprint.' },
          orderedBlockUids: { type: 'array', items: { type: 'string' }, description: 'Ordered array of block UIDs for reorderBlocks.' },
          config: { type: 'object', description: 'Object overriding block config props.' },
          configJson: { type: 'string', maxLength: 4000, description: 'Optional JSON string overriding block config props.' },
          roleNames: { type: 'array', items: { type: 'string' }, description: 'Optional ldx_* roles to grant onto created page routes.' },
          dryRun: { type: 'boolean', default: false },
        },
      },
      async run(ctx, db, _actor, args) {
        if (!SLUG_RE.test(args.portalSlug)) throw failTool('PORTAL_SLUG_INVALID', 400, 'Slug portal không hợp lệ.');
        const action = args.action || 'addBlock';
        let parsedConfig = args.config && typeof args.config === 'object' ? { ...args.config } : {};
        if (args.configJson) {
          try { parsedConfig = { ...parsedConfig, ...JSON.parse(args.configJson) }; }
          catch { throw failTool('CONFIG_JSON_INVALID', 400, 'configJson không phải JSON hợp lệ.'); }
        }

        if (action === 'listBlocks') {
          const { flowModelsRepo, pageRoute, tabSchemaUid, grid } = await resolvePageGrid(db, args.portalSlug, args.pageTitle, val);
          if (!grid) return { portalSlug: args.portalSlug, pageTitle: val(pageRoute, 'title') || null, blocks: [] };
          const { ordered, layout } = extractGridBlockUids(grid);
          const subMap = new Map((Array.isArray(grid?.subModels?.items) ? grid.subModels.items : []).map((m) => [m.uid, m]));
          const blocks = [];
          for (const uid of ordered) {
            const model = await hydrateFlowModel(flowModelsRepo, uid, subMap);
            blocks.push(readFlowModelMeta(model, uid));
          }
          return {
            portalSlug: args.portalSlug,
            pageTitle: val(pageRoute, 'title') || null,
            tabSchemaUid,
            gridUid: grid.uid,
            rowOrder: layout.rowOrder || [],
            blocks,
          };
        }

        if (action === 'updateBlock') {
          if (!args.blockUid) throw failTool('BLOCK_UID_REQUIRED', 400, 'Cần blockUid để cập nhật block.');
          const flowModelsRepo = db?.getRepository?.('flowModels');
          const model = await hydrateFlowModel(flowModelsRepo, args.blockUid, new Map());
          if (!model) throw failTool('BLOCK_NOT_FOUND', 404, `Không tìm thấy block "${args.blockUid}".`);
          const meta = readFlowModelMeta(model, args.blockUid);
          const nextConfig = { ...meta.props, ...(args.title ? { title: args.title } : {}), ...parsedConfig };
          if (args.dryRun) {
            return { dryRun: true, action, blockUid: args.blockUid, use: meta.use, beforeProps: meta.props, afterProps: nextConfig };
          }
          if (typeof flowModelsRepo.updateSingleNode === 'function') {
            await flowModelsRepo.updateSingleNode({
              uid: args.blockUid,
              props: nextConfig,
              stepParams: { ...meta.stepParams, dxosBlockSettings: { ...(meta.stepParams?.dxosBlockSettings || {}), config: nextConfig } },
            });
          } else if (typeof flowModelsRepo.upsertModel === 'function') {
            await flowModelsRepo.upsertModel({ ...model, props: nextConfig });
          }
          return { applied: true, updated: true, blockUid: args.blockUid, afterProps: nextConfig };
        }

        if (action === 'reorderBlocks' || action === 'removeBlock') {
          const { flowModelsRepo, grid } = await resolvePageGrid(db, args.portalSlug, args.pageTitle, val);
          if (!grid || !flowModelsRepo) throw failTool('PAGE_GRID_NOT_FOUND', 404, `Không tìm thấy grid trên portal "${args.portalSlug}".`);
          const { ordered } = extractGridBlockUids(grid);
          let nextOrder;
          if (action === 'reorderBlocks') {
            const req = Array.isArray(args.orderedBlockUids) ? args.orderedBlockUids : [];
            nextOrder = [...req.filter((u) => ordered.includes(u)), ...ordered.filter((u) => !req.includes(u))];
          } else {
            if (!args.blockUid) throw failTool('BLOCK_UID_REQUIRED', 400, 'Cần blockUid để gỡ block.');
            nextOrder = ordered.filter((u) => u !== args.blockUid);
          }
          if (args.dryRun) return { dryRun: true, action, portalSlug: args.portalSlug, beforeOrder: ordered, afterOrder: nextOrder };
          const nextLayout = normalizeGridState(grid, nextOrder);
          await updateGridLayout(flowModelsRepo, grid, nextLayout);
          if (action === 'removeBlock') {
            if (typeof flowModelsRepo.remove === 'function') await flowModelsRepo.remove(args.blockUid);
            else if (typeof flowModelsRepo.destroy === 'function') await flowModelsRepo.destroy({ filter: { uid: args.blockUid } });
          }
          return { applied: true, ...(action === 'reorderBlocks' ? { reordered: true } : { removed: true, blockUid: args.blockUid }), order: nextOrder };
        }

        if (action === 'composePageBlueprint') {
          const title = args.title || 'Trang Nghiệp vụ AI';
          const collection = args.collection || 'latticeServiceTickets';
          const fields = Array.isArray(args.tableFields) && args.tableFields.length ? args.tableFields : ['code', 'name', 'status'];
          const nativeBlocks = [{
            key: `ai-tbl-${args.portalSlug}-${Date.now().toString(36)}`,
            type: 'table',
            title,
            collection,
            fields,
            settings: { pageSize: 10 },
            actions: ['filter', 'refresh'],
          }];
          if (args.includeCreateForm) {
            nativeBlocks.push({
              key: `ai-frm-${args.portalSlug}-${Date.now().toString(36)}`,
              type: 'createForm',
              title: `Tạo mới — ${title}`,
              collection,
              fields: fields.filter((f) => f !== 'id' && f !== 'status'),
            });
          }
          const blueprint = {
            version: '1',
            mode: 'create',
            navigation: {
              layoutUid: `ldx-portal-${args.portalSlug}`,
              group: { title: args.groupTitle || title, icon: 'AppstoreAddOutlined' },
              item: { title, icon: 'DashboardOutlined' },
            },
            page: { title, displayTitle: true, enableTabs: false },
            tabs: [{ title, blocks: nativeBlocks }],
          };
          const dxosSpecs = Array.isArray(args.dxosBlocks) ? args.dxosBlocks : [];
          if (args.dryRun) {
            return { dryRun: true, action, portalSlug: args.portalSlug, previewBlueprint: blueprint, dxosBlocks: dxosSpecs };
          }
          const bpRes = await invokeResourceAction(ctx, 'flowSurfaces', 'applyBlueprint', { values: blueprint });
          const { flowModelsRepo, layoutUid, portalRoutes, pageRoute, tabSchemaUid, grid } = await resolvePageGrid(db, args.portalSlug, title, val);
          const createdRouteIds = [
            val(pageRoute, 'parentId'),
            val(pageRoute, 'id'),
            ...portalRoutes.filter((r) => String(val(r, 'parentId')) === String(val(pageRoute, 'id'))).map((r) => val(r, 'id')),
          ].filter((id) => id != null);
          await propagatePortalRolesToRoutes(db, layoutUid, createdRouteIds, args.roleNames, val);

          const attachedDxosBlocks = [];
          if (grid?.uid && flowModelsRepo?.upsertModel && dxosSpecs.length) {
            const prefix = `dxos-bp-${args.portalSlug}-${Date.now().toString(36)}`;
            const existingOrder = extractGridBlockUids(grid).ordered;
            const prepended = [];
            for (let i = 0; i < dxosSpecs.length; i++) {
              const spec = dxosSpecs[i];
              const useName = ALLOWED_BLOCK_MODELS.includes(spec?.blockUse) ? spec.blockUse : 'DxosKpiMetricBlockModel';
              const uid = `${prefix}-${i}`;
              const cfg = { title: spec?.title || title, ...(spec?.config || {}) };
              await flowModelsRepo.upsertModel({
                uid,
                use: useName,
                parentId: grid.uid,
                subKey: 'items',
                subType: 'array',
                props: cfg,
                stepParams: { dxosBlockSettings: { config: cfg } },
              });
              prepended.push(uid);
              attachedDxosBlocks.push({ uid, use: useName, title: cfg.title });
            }
            await updateGridLayout(flowModelsRepo, grid, normalizeGridState(grid, [...prepended, ...existingOrder]));
          }
          return {
            applied: true,
            action,
            portalSlug: args.portalSlug,
            pageTitle: title,
            tabSchemaUid,
            attachedDxosBlocks,
            result: bpRes,
          };
        }

        // Default addBlock (v1 backward compatible)
        if (!args.blockUse) throw failTool('BLOCK_USE_REQUIRED', 400, 'Cần blockUse để gắn block mới.');
        const title = args.title || args.blockUse;
        const collection = args.collection || 'latticeServiceTickets';
        const blueprint = {
          version: '1',
          mode: 'create',
          navigation: { layoutUid: `ldx-portal-${args.portalSlug}`, group: { title: 'AI Mở rộng', icon: 'AppstoreAddOutlined' }, item: { title, icon: 'RobotOutlined' } },
          page: { title, displayTitle: true, enableTabs: false },
          tabs: [{ title, blocks: [{ key: `ai-${args.portalSlug}-${Date.now().toString(36)}`, type: args.blockUse === 'NativeFormBlock' ? 'createForm' : args.blockUse === 'NativeDetailsBlock' ? 'details' : 'table', title, collection, fields: ['code', 'name', 'status'] }] }],
        };
        if (args.dryRun) {
          return { dryRun: true, portalSlug: args.portalSlug, blockUse: args.blockUse, title, previewBlueprint: blueprint };
        }
        const resolved = await resolvePageGrid(db, args.portalSlug, args.pageTitle, val);
        if (args.blockUse.startsWith('Dxos') && resolved.grid?.uid && resolved.flowModelsRepo?.upsertModel) {
          const blockUid = `dxos-ai-${args.portalSlug}-${Date.now().toString(36)}`;
          const cfg = { title, ...parsedConfig };
          await resolved.flowModelsRepo.upsertModel({
            uid: blockUid,
            use: args.blockUse,
            parentId: resolved.grid.uid,
            subKey: 'items',
            subType: 'array',
            props: cfg,
            stepParams: { dxosBlockSettings: { config: cfg } },
          });
          const nextOrder = [blockUid, ...extractGridBlockUids(resolved.grid).ordered.filter((u) => u !== blockUid)];
          await updateGridLayout(resolved.flowModelsRepo, resolved.grid, normalizeGridState(resolved.grid, nextOrder));
          return { dryRun: false, applied: true, mode: 'flowModel', portalSlug: args.portalSlug, blockUid, blockUse: args.blockUse };
        }
        const bpResult = await invokeResourceAction(ctx, 'flowSurfaces', 'applyBlueprint', { values: blueprint });
        return { dryRun: false, applied: true, mode: 'applyBlueprint', portalSlug: args.portalSlug, blockUse: args.blockUse, result: bpResult };
      },
    }),

    createAuditedTool({
      name: 'dxos_manage_portal_and_acl',
      adminOnly: true,
      defaultPermission: 'ASK',
      introduction: { title: 'Quản trị Portal & Phân quyền Menu', about: 'Tạo/cập nhật Portal /p/* và thêm hoặc thu hồi quyền menu cho các vai trò ldx_*.' },
      description: 'Create/update a LatticeDX multi-portal layout (/p/<slug>) and grant or revoke desktop route visibility for ldx_* roles (Admin only).',
      schema: {
        description: 'Portal metadata & role binding input.',
        properties: {
          operation: { type: 'string', default: 'grant', enum: ['grant', 'revoke'] },
          slug: { type: 'string', required: true, maxLength: 40 },
          title: { type: 'string', maxLength: 100 },
          roleNames: { type: 'array', items: { type: 'string' }, description: 'Target ldx_* role names.' },
          dryRun: { type: 'boolean', default: false },
        },
      },
      async run(ctx, db, _actor, args) {
        if (!SLUG_RE.test(args.slug)) throw failTool('PORTAL_SLUG_INVALID', 400, 'Slug portal không hợp lệ.');
        const operation = args.operation || 'grant';
        const layoutUid = `ldx-portal-${args.slug}`;
        const safeRoles = (args.roleNames || (operation === 'grant' ? ['ldx_employee', 'ldx_manager'] : [])).filter((r) => LDX_ROLE_RE.test(r));
        const title = args.title || `Portal ${args.slug}`;
        if (args.dryRun) {
          return { dryRun: true, operation, layoutUid, path: `/p/${args.slug}`, title, roleNames: safeRoles };
        }

        const layoutsRepo = db.getRepository('uiLayouts');
        const existed = layoutsRepo ? await layoutsRepo.findOne({ filter: { uid: layoutUid } }) : null;
        const { routes, links } = await collectPortalRouteSet(db, args.slug);
        const portalRoutes = resolvePortalRoutes(routes, links, layoutUid, val);
        const portalRouteIds = portalRoutes.map((r) => val(r, 'id')).filter((id) => id != null);

        const rolesRoutesRepo = db.getRepository('rolesDesktopRoutes');
        if (operation === 'revoke') {
          if (rolesRoutesRepo && portalRouteIds.length && safeRoles.length) {
            await rolesRoutesRepo.destroy({ filter: { desktopRouteId: { $in: portalRouteIds }, roleName: { $in: safeRoles } } });
          }
          return { applied: true, operation: 'revoke', layoutUid, path: `/p/${args.slug}`, revokedRoles: safeRoles, routeCount: portalRouteIds.length };
        }

        const latticePortalsRes = hasRes(ctx, 'latticePortals');
        if (latticePortalsRes) {
          let existingRoles = [];
          if (rolesRoutesRepo && portalRouteIds.length) {
            const grants = (await rolesRoutesRepo.find({ filter: { desktopRouteId: { $in: portalRouteIds } }, limit: 400 })) || [];
            existingRoles = grants.map((g) => val(g, 'roleName')).filter((r) => LDX_ROLE_RE.test(r));
          }
          const mergedRoles = [...new Set([...existingRoles, ...safeRoles])];
          const saved = await invokeResourceAction(ctx, 'latticePortals', 'save', {
            values: {
              ...(existed ? { uid: layoutUid } : {}),
              slug: args.slug,
              title,
              layoutType: 'desktop',
              enabled: true,
              roles: mergedRoles,
            },
          });
          await propagatePortalRolesToRoutes(db, layoutUid, portalRouteIds, mergedRoles, val);
          return { applied: true, operation: 'grant', layoutUid, path: `/p/${args.slug}`, assignedRoles: mergedRoles, portal: saved };
        }

        if (layoutsRepo) {
          if (existed && typeof existed.update === 'function') await existed.update({ title });
          else await layoutsRepo.create({ values: { uid: layoutUid, title, layoutType: 'desktop', routeName: `p_${args.slug.replace(/-/g, '_')}`, routePath: `/p/${args.slug}`, authCheck: true, enabled: true } });
        }
        const routesRepo = db.getRepository('desktopRoutes');
        const linksRepo = db.getRepository('desktopRoutesUiLayouts');
        if (routesRepo && !portalRouteIds.length) {
          const groupRoute = await routesRepo.create({ values: { title, type: 'group', hideInMenu: false } });
          const gid = val(groupRoute, 'id');
          if (gid != null) {
            portalRouteIds.push(gid);
            if (linksRepo) await linksRepo.create({ values: { desktopRouteId: gid, uiLayoutUid: layoutUid } });
          }
        }
        await propagatePortalRolesToRoutes(db, layoutUid, portalRouteIds, safeRoles, val);
        return { applied: true, operation: 'grant', layoutUid, path: `/p/${args.slug}`, assignedRoles: safeRoles };
      },
    }),

    createAuditedTool({
      name: 'dxos_extend_collection_schema',
      adminOnly: true,
      defaultPermission: 'ASK',
      introduction: { title: 'Mở rộng Bảng & Trường Dữ liệu', about: 'Inspect, tạo mới collection nghiệp vụ latticeCustom* hoặc thêm trường (string/number/select/boolean/date).' },
      description: 'Inspect or create custom collection (latticeCustom*) or add typed/select fields to business collections (Admin only; blocks system tables).',
      schema: {
        description: 'Schema extension definition.',
        properties: {
          operation: { type: 'string', enum: ['createCollection', 'addFields', 'inspectCollection'], required: true },
          collectionName: { type: 'string', required: true, maxLength: 60 },
          title: { type: 'string', maxLength: 100 },
          fields: { type: 'array', items: { type: 'object' }, description: 'Field definitions ({ name, type, title, enumValues }).' },
          dryRun: { type: 'boolean', default: false },
        },
      },
      async run(_ctx, db, actor, args) {
        if (SYSTEM_PROTECTED_COLLECTIONS.has(args.collectionName)) {
          throw failTool('SYSTEM_COLLECTION_FORBIDDEN', 403, `Không được phép sửa bảng hệ thống "${args.collectionName}".`);
        }
        const colsRepo = db.getRepository('collections');
        if (args.operation === 'inspectCollection') {
          const existing = colsRepo ? await colsRepo.findOne({ filter: { name: args.collectionName }, appends: ['fields'] }) : null;
          const liveCol = db.getCollection?.(args.collectionName);
          const dbFields = Array.isArray(val(existing, 'fields')) ? val(existing, 'fields').map((f) => ({ name: val(f, 'name'), type: val(f, 'type') })) : [];
          return {
            collectionName: args.collectionName,
            exists: Boolean(existing || liveCol),
            title: val(existing, 'title') || liveCol?.options?.title || args.collectionName,
            fields: dbFields,
          };
        }
        if (args.operation === 'createCollection' && !CUSTOM_COLLECTION_RE.test(args.collectionName)) {
          throw failTool('COLLECTION_NAME_INVALID', 400, 'Collection mới phải theo mẫu latticeCustom<TenVietHoa>.');
        }
        const rawFields = Array.isArray(args.fields) ? args.fields : [];
        if (!rawFields.length) throw failTool('FIELDS_REQUIRED', 400, 'Cần ít nhất 1 trường dữ liệu trong fields.');
        const normalizedFields = rawFields.map((f) => buildFieldDefinition(f, failTool, FIELD_NAME_RE));
        if (args.operation === 'createCollection') {
          const has = (n) => normalizedFields.some((f) => f.name === n);
          if (!has('status')) normalizedFields.unshift({ name: 'status', type: 'string', interface: 'input', defaultValue: 'draft', uiSchema: { type: 'string', title: 'Trạng thái' } });
          if (!has('name')) normalizedFields.unshift({ name: 'name', type: 'string', interface: 'input', uiSchema: { type: 'string', title: 'Tên hồ sơ' } });
          if (!has('code')) normalizedFields.unshift({ name: 'code', type: 'string', interface: 'input', uiSchema: { type: 'string', title: 'Mã hồ sơ' } });
          if (!has('organizationId')) {
            normalizedFields.unshift({ name: 'organizationId', type: 'string', interface: 'input', allowNull: false, defaultValue: actor.organizationId, uiSchema: { type: 'string', title: 'Mã tổ chức' } });
          }
        }
        if (args.dryRun) return { dryRun: true, operation: args.operation, collectionName: args.collectionName, fields: normalizedFields };
        if (!colsRepo) throw failTool('SCHEMA_REPO_UNAVAILABLE', 503, 'Repository collections chưa sẵn sàng.');

        if (args.operation === 'createCollection') {
          const existing = await colsRepo.findOne({ filter: { name: args.collectionName }, appends: ['fields'] });
          if (existing) {
            if (typeof existing.load === 'function') await existing.load({ resetFields: true });
            return { created: false, alreadyExists: true, collectionName: args.collectionName };
          }
          const created = await colsRepo.create({
            values: {
              name: args.collectionName,
              title: args.title || args.collectionName,
              autoGenId: true,
              createdAt: true,
              updatedAt: true,
              options: { titleField: 'name', uiManageable: true },
              fields: normalizedFields,
            },
          });
          if (typeof created?.load === 'function') await created.load({ resetFields: true });
          const colInst = db.getCollection?.(args.collectionName);
          if (colInst && typeof colInst.sync === 'function') await colInst.sync({ force: false, alter: { drop: false } });
          else if (typeof db.sync === 'function') await db.sync();
          return { created: true, collectionName: args.collectionName, fieldCount: normalizedFields.length, fields: normalizedFields.map((f) => f.name) };
        }

        const fieldsRepo = db.getRepository('fields');
        if (!fieldsRepo) throw failTool('FIELDS_REPO_UNAVAILABLE', 503, 'Repository fields chưa sẵn sàng.');
        for (const f of normalizedFields) {
          const cf = await fieldsRepo.create({ values: { ...f, collectionName: args.collectionName } });
          if (typeof cf?.load === 'function') await cf.load();
        }
        const parentCol = await colsRepo.findOne({ filter: { name: args.collectionName }, appends: ['fields'] });
        if (typeof parentCol?.load === 'function') await parentCol.load({ resetFields: true });
        const colInst = db.getCollection?.(args.collectionName);
        if (colInst && typeof colInst.sync === 'function') await colInst.sync({ force: false, alter: { drop: false } });
        else if (typeof db.sync === 'function') await db.sync();
        return { updated: true, collectionName: args.collectionName, addedFields: normalizedFields.map((f) => f.name) };
      },
    }),

    createAuditedTool({
      name: 'dxos_manage_rbac_permissions',
      adminOnly: true,
      defaultPermission: 'ASK',
      introduction: { title: 'Quản trị Ma trận Phân quyền RBAC', about: 'Thêm/sửa/thu hồi quyền bảng, hành động, scope dữ liệu và khóa từng trường cho vai trò ldx_*.' },
      description: 'Inspect/create ldx_* roles and grant, field-lock, or revoke granular collection/action/scope RBAC rules via dataSourcesRolesResources (Admin only; root/admin & system tables forbidden).',
      schema: {
        description: 'Granular RBAC permission operation.',
        properties: {
          operation: { type: 'string', required: true, enum: ['inspectRole', 'ensureCustomRole', 'grantResource', 'lockFields', 'revokeResource'] },
          roleName: { type: 'string', required: true, maxLength: 50, description: 'Must match ^ldx_[a-z][a-z0-9_]{1,40}$.' },
          title: { type: 'string', maxLength: 100, description: 'Display title for ensureCustomRole.' },
          cloneFromRole: { type: 'string', maxLength: 50, description: 'Optional source ldx_* role when cloning.' },
          collectionName: { type: 'string', maxLength: 60 },
          actions: { type: 'array', items: { type: 'string' }, description: 'Actions among view, create, update, destroy, export.' },
          readableFields: { type: 'array', items: { type: 'string' }, description: 'Fields allowed for view action.' },
          writableFields: { type: 'array', items: { type: 'string' }, description: 'Fields allowed for create/update before lockedFields filtering.' },
          lockedFields: { type: 'array', items: { type: 'string' }, description: 'Fields strictly stripped from create/update actions.' },
          hideLockedFromView: { type: 'boolean', default: false },
          scopeMode: { type: 'string', default: 'all_in_org', enum: ['all_in_org', 'own', 'own_draft'] },
          dryRun: { type: 'boolean', default: false },
        },
      },
      async run(ctx, db, _actor, args) {
        if (!LDX_ROLE_RE.test(args.roleName || '')) {
          throw failTool('ROLE_TARGET_FORBIDDEN', 403, `Chỉ được phép cấu hình vai trò theo mẫu ldx_*; từ chối "${args.roleName}".`);
        }
        if (args.collectionName && SYSTEM_PROTECTED_COLLECTIONS.has(args.collectionName)) {
          throw failTool('SYSTEM_COLLECTION_FORBIDDEN', 403, `Không được thay đổi phân quyền bảng hệ thống "${args.collectionName}".`);
        }

        const rolesRepo = db.getRepository('roles');
        const dsRolesRepo = db.getRepository('dataSourcesRoles');
        const resourcesRepo = db.getRepository('dataSourcesRolesResources');
        const rolesRoutesRepo = db.getRepository('rolesDesktopRoutes');

        if (args.operation === 'inspectRole') {
          const role = rolesRepo ? await rolesRepo.findOne({ filter: { name: args.roleName } }) : null;
          const resList = resourcesRepo ? ((await resourcesRepo.find({ filter: { roleName: args.roleName, dataSourceKey: 'main' }, appends: ['actions'], limit: 100 })) || []) : [];
          const routeCount = rolesRoutesRepo && typeof rolesRoutesRepo.count === 'function' ? await rolesRoutesRepo.count({ filter: { roleName: args.roleName } }) : 0;
          return {
            roleName: args.roleName,
            exists: Boolean(role),
            title: val(role, 'title') || null,
            routeCount,
            resources: resList.map((r) => ({
              collectionName: val(r, 'name'),
              usingActionsConfig: val(r, 'usingActionsConfig'),
              actions: (val(r, 'actions') || []).map((a) => ({ name: val(a, 'name'), fields: val(a, 'fields') || [], hasScope: Boolean(val(a, 'scope') || val(a, 'scopeId')) })),
            })),
          };
        }

        if (args.dryRun) {
          return { dryRun: true, operation: args.operation, roleName: args.roleName, collectionName: args.collectionName || null, actions: args.actions || null, lockedFields: args.lockedFields || [] };
        }

        if (args.operation === 'ensureCustomRole') {
          let role = rolesRepo ? await rolesRepo.findOne({ filter: { name: args.roleName } }) : null;
          const values = {
            name: args.roleName,
            title: args.title || `Lattice — ${args.roleName}`,
            allowConfigure: false,
            allowNewMenu: false,
            allowNewAiEmployee: false,
            strategy: { actions: [] },
            snippets: [],
          };
          if (rolesRepo) {
            if (role && typeof role.update === 'function') await role.update({ title: values.title });
            else role = await rolesRepo.create({ values });
          }
          if (args.cloneFromRole && LDX_ROLE_RE.test(args.cloneFromRole)) {
            if (resourcesRepo) {
              const srcRes = (await resourcesRepo.find({ filter: { roleName: args.cloneFromRole, dataSourceKey: 'main' }, appends: ['actions'], limit: 100 })) || [];
              if (dsRolesRepo && !(await dsRolesRepo.findOne({ filter: { roleName: args.roleName, dataSourceKey: 'main' } }))) {
                await dsRolesRepo.create({ values: { roleName: args.roleName, dataSourceKey: 'main' } });
              }
              for (const sr of srcRes) {
                const cname = val(sr, 'name');
                if (cname && !(await resourcesRepo.findOne({ filter: { roleName: args.roleName, dataSourceKey: 'main', name: cname } }))) {
                  const clonedActions = (val(sr, 'actions') || []).map((a) => ({ name: val(a, 'name'), ...(val(a, 'fields') ? { fields: [...val(a, 'fields')] } : {}) }));
                  await resourcesRepo.create({ values: { roleName: args.roleName, dataSourceKey: 'main', name: cname, usingActionsConfig: true, actions: clonedActions } });
                }
              }
            }
            if (rolesRoutesRepo) {
              const srcRoutes = (await rolesRoutesRepo.find({ filter: { roleName: args.cloneFromRole }, limit: 200 })) || [];
              for (const sr of srcRoutes) {
                const rid = val(sr, 'desktopRouteId');
                if (rid != null && !(await rolesRoutesRepo.findOne({ filter: { roleName: args.roleName, desktopRouteId: rid } }))) {
                  await rolesRoutesRepo.create({ values: { roleName: args.roleName, desktopRouteId: rid } });
                }
              }
            }
          }
          return { applied: true, ensured: true, roleName: args.roleName, title: values.title, clonedFrom: args.cloneFromRole || null };
        }

        if (!args.collectionName) throw failTool('COLLECTION_NAME_REQUIRED', 400, 'Cần collectionName để cấu hình quyền bảng.');
        if (!resourcesRepo) throw failTool('RBAC_REPO_UNAVAILABLE', 503, 'Repository dataSourcesRolesResources chưa sẵn sàng.');

        if (args.operation === 'revokeResource') {
          const existing = await resourcesRepo.findOne({ filter: { roleName: args.roleName, dataSourceKey: 'main', name: args.collectionName }, appends: ['actions'] });
          if (!existing) return { applied: true, revoked: false, reason: 'Không tồn tại bản ghi quyền để thu hồi.' };
          const toRevoke = Array.isArray(args.actions) && args.actions.length ? new Set(args.actions) : null;
          if (!toRevoke) {
            await resourcesRepo.destroy({ filter: { roleName: args.roleName, dataSourceKey: 'main', name: args.collectionName } });
            ctx?.app?.dataSourceManager?.dataSources?.get?.('main')?.acl?.getRole?.(args.roleName)?.revokeResource?.(args.collectionName);
            ctx?.app?.acl?.getRole?.(args.roleName)?.revokeResource?.(args.collectionName);
            return { applied: true, revoked: true, revokedAll: true, roleName: args.roleName, collectionName: args.collectionName };
          }
          const remainingActions = (val(existing, 'actions') || []).map((a) => ({
            name: val(a, 'name'),
            ...(val(a, 'fields') ? { fields: [...val(a, 'fields')] } : {}),
            ...(val(a, 'scope') ? { scope: val(a, 'scope') } : {}),
          })).filter((a) => !toRevoke.has(a.name));
          if (typeof resourcesRepo.update === 'function') {
            await resourcesRepo.update({
              filter: { roleName: args.roleName, dataSourceKey: 'main', name: args.collectionName },
              values: { usingActionsConfig: true, actions: remainingActions },
              updateAssociationValues: ['actions'],
            });
          } else {
            await existing.update({ actions: remainingActions });
          }
          return { applied: true, revoked: true, revokedActions: [...toRevoke], remainingActions: remainingActions.map((a) => a.name) };
        }

        if (args.operation === 'lockFields') {
          const existing = await resourcesRepo.findOne({ filter: { roleName: args.roleName, dataSourceKey: 'main', name: args.collectionName }, appends: ['actions'] });
          if (!existing) throw failTool('RBAC_GRANT_NOT_FOUND', 404, `Vai trò ${args.roleName} chưa có quyền trên ${args.collectionName}.`);
          const locks = new Set(args.lockedFields || []);
          const nextActions = (val(existing, 'actions') || []).map((a) => {
            const actName = val(a, 'name');
            const origFields = Array.isArray(val(a, 'fields')) ? [...val(a, 'fields')] : null;
            const shouldFilter = ['create', 'update'].includes(actName) || (args.hideLockedFromView && actName === 'view');
            const filtered = origFields && shouldFilter ? origFields.filter((f) => !locks.has(f)) : origFields;
            return { name: actName, ...(filtered ? { fields: filtered } : {}) };
          });
          if (typeof resourcesRepo.update === 'function') {
            await resourcesRepo.update({
              filter: { roleName: args.roleName, dataSourceKey: 'main', name: args.collectionName },
              values: { usingActionsConfig: true, actions: nextActions },
              updateAssociationValues: ['actions'],
            });
          } else {
            await existing.update({ actions: nextActions });
          }
          return { applied: true, locked: true, roleName: args.roleName, collectionName: args.collectionName, lockedFields: [...locks] };
        }

        // grantResource
        const actionsList = Array.isArray(args.actions) && args.actions.length ? args.actions : ['view'];
        const actionsSpec = buildRbacActionsSpec({
          actions: actionsList,
          readableFields: args.readableFields,
          writableFields: args.writableFields,
          lockedFields: args.lockedFields,
          scopeMode: args.scopeMode || 'all_in_org',
          collectionName: args.collectionName,
          db,
        });
        if (dsRolesRepo && !(await dsRolesRepo.findOne({ filter: { roleName: args.roleName, dataSourceKey: 'main' } }))) {
          await dsRolesRepo.create({ values: { roleName: args.roleName, dataSourceKey: 'main' } });
        }
        const existingGrant = await resourcesRepo.findOne({ filter: { roleName: args.roleName, dataSourceKey: 'main', name: args.collectionName } });
        let savedModel = null;
        if (existingGrant && typeof resourcesRepo.update === 'function') {
          const updated = await resourcesRepo.update({
            filter: { roleName: args.roleName, dataSourceKey: 'main', name: args.collectionName },
            values: { usingActionsConfig: true, actions: actionsSpec },
            updateAssociationValues: ['actions'],
          });
          savedModel = Array.isArray(updated) ? updated[0] : existingGrant;
        } else if (existingGrant) {
          savedModel = await existingGrant.update({ usingActionsConfig: true, actions: actionsSpec });
        } else {
          savedModel = await resourcesRepo.create({
            values: { roleName: args.roleName, dataSourceKey: 'main', name: args.collectionName, usingActionsConfig: true, actions: actionsSpec },
          });
        }
        if (typeof savedModel?.writeToACL === 'function') {
          const dsAcl = ctx?.app?.dataSourceManager?.dataSources?.get?.('main')?.acl || ctx?.app?.acl;
          if (dsAcl) await savedModel.writeToACL({ acl: dsAcl });
        }
        return {
          applied: true,
          roleName: args.roleName,
          collectionName: args.collectionName,
          actions: actionsSpec.map((a) => ({ name: a.name, fields: a.fields || [] })),
        };
      },
    }),

    createAuditedTool({
      name: 'dxos_deploy_workflow',
      adminOnly: true,
      defaultPermission: 'ASK',
      introduction: { title: 'Triển khai Quy trình Poka-yoke', about: 'Cài mẫu quy trình doanh nghiệp (tự ánh xạ nhân sự theo role) hoặc AI triage chạy nền.' },
      description: 'Deploy a validated DX-OS workflow template onto the target organization with automatic crew resolution (Admin only).',
      schema: {
        description: 'Workflow template deployment params.',
        properties: {
          templateKey: { type: 'string', required: true, enum: ['procurement', 'logistics-5step', 'incident-uc2', 'internal-service', 'ai-incident-triage'] },
          organizationId: { type: 'string', maxLength: 80 },
          enabled: { type: 'boolean', default: true },
          dryRun: { type: 'boolean', default: false },
        },
      },
      async run(ctx, db, actor, args) {
        const organizationId = args.organizationId || actor.organizationId;
        const crewBindings = await resolveOrgCrewBindings(db, organizationId, val);
        if (args.dryRun) return { dryRun: true, templateKey: args.templateKey, organizationId, crewBindings, enabled: Boolean(args.enabled) };
        const wfRepo = db.getRepository('workflows');
        if (!wfRepo) throw failTool('WORKFLOW_ENGINE_UNAVAILABLE', 503, 'Workflow repository unavailable.');
        const existing = await wfRepo.findOne({ filter: { 'options.dxosTemplateKey': args.templateKey, 'options.dxosOrganizationId': organizationId, current: true } });
        if (existing) return { alreadyExists: true, workflowId: val(existing, 'id'), title: val(existing, 'title') };
        if (args.templateKey === 'ai-incident-triage') {
          const created = await wfRepo.create({
            values: {
              title: `AI Triage Sự cố IoT — ${organizationId}`,
              type: 'collection',
              enabled: args.enabled !== false,
              current: true,
              config: { collection: 'latticeIncidentCases', mode: 1, appends: ['asset'] },
              options: { dxosTemplateKey: 'ai-incident-triage', dxosOrganizationId: organizationId },
            },
          });
          return { deployed: true, workflowId: val(created, 'id'), title: val(created, 'title'), templateKey: 'ai-incident-triage' };
        }
        const studioRes = hasRes(ctx, 'dxosStudio');
        if (studioRes) {
          return invokeResourceAction(ctx, 'dxosStudio', 'installWorkflow', {
            values: { templateKey: args.templateKey, organizationId, ...crewBindings, enabled: args.enabled !== false },
          });
        }
        return { deployed: false, message: 'Cần bật @latticedx/plugin-dxos-studio để cài 4 mẫu quy trình Poka-yoke.' };
      },
    }),

    createAuditedTool({
      name: 'dxos_configure_workflow',
      adminOnly: true,
      defaultPermission: 'ASK',
      introduction: { title: 'Kỹ sư Cấu hình Workflow', about: 'Đọc đồ thị node, sửa config node, thêm node mới, dựng custom workflow và bật/tắt trigger.' },
      description: 'Inspect workflow flow_nodes graphs, update node configs, add nodes, build custom collection workflows, and toggle enabled state (Admin only).',
      schema: {
        description: 'Workflow graph engineering operation.',
        properties: {
          operation: { type: 'string', required: true, enum: ['inspectWorkflow', 'updateNodeConfig', 'addNode', 'buildCustomWorkflow', 'toggleWorkflow'] },
          workflowId: { type: 'integer' },
          titleQuery: { type: 'string', maxLength: 100 },
          title: { type: 'string', maxLength: 120 },
          collectionName: { type: 'string', maxLength: 60 },
          triggerMode: { type: 'integer', default: 1 },
          nodeId: { type: 'integer' },
          nodeKey: { type: 'string', maxLength: 60 },
          nodeType: { type: 'string', enum: ALLOWED_WORKFLOW_NODE_TYPES },
          upstreamNodeId: { type: 'integer' },
          assigneeEmployeeId: { type: 'integer' },
          conditionField: { type: 'string', maxLength: 50 },
          conditionGt: { type: 'number' },
          config: { type: 'object' },
          configPatch: { type: 'object' },
          enabled: { type: 'boolean' },
          dryRun: { type: 'boolean', default: false },
        },
      },
      async run(ctx, db, actor, args) {
        const wfRepo = db.getRepository('workflows');
        const nodeRepo = db.getRepository('flow_nodes');
        if (!wfRepo || !nodeRepo) throw failTool('WORKFLOW_ENGINE_UNAVAILABLE', 503, 'Workflow/flow_nodes repository unavailable.');

        if (args.operation === 'inspectWorkflow') {
          let wf = args.workflowId ? await wfRepo.findOne({ filterByTk: args.workflowId }) : null;
          if (!wf && args.titleQuery) {
            const all = (await wfRepo.find({ filter: { current: true }, limit: 100 })) || [];
            const q = args.titleQuery.toLowerCase();
            wf = all.find((w) => String(val(w, 'title') || '').toLowerCase().includes(q)) || null;
          }
          if (!wf) throw failTool('WORKFLOW_NOT_FOUND', 404, 'Không tìm thấy workflow theo yêu cầu.');
          const wid = val(wf, 'id');
          const nodes = (await nodeRepo.find({ filter: { workflowId: wid }, limit: 100 })) || [];
          return {
            workflowId: wid,
            title: val(wf, 'title'),
            type: val(wf, 'type'),
            enabled: Boolean(val(wf, 'enabled')),
            config: val(wf, 'config') || {},
            nodes: nodes.map((n) => ({
              id: val(n, 'id'),
              key: val(n, 'key'),
              title: val(n, 'title'),
              type: val(n, 'type'),
              upstreamId: val(n, 'upstreamId') ?? null,
              downstreamId: val(n, 'downstreamId') ?? null,
              config: val(n, 'config') || {},
            })),
          };
        }

        if (args.operation === 'updateNodeConfig') {
          let node = args.nodeId ? await nodeRepo.findOne({ filterByTk: args.nodeId }) : null;
          if (!node && args.workflowId && args.nodeKey) {
            node = await nodeRepo.findOne({ filter: { workflowId: args.workflowId, key: args.nodeKey } });
          }
          if (!node) throw failTool('WORKFLOW_NODE_NOT_FOUND', 404, 'Không tìm thấy node workflow cần chỉnh sửa.');
          const prevCfg = val(node, 'config') || {};
          const nextCfg = { ...prevCfg, ...(args.configPatch || args.config || {}) };
          const nextTitle = args.title || val(node, 'title');
          if (args.dryRun) return { dryRun: true, nodeId: val(node, 'id'), beforeConfig: prevCfg, afterConfig: nextCfg, afterTitle: nextTitle };
          await node.update({ title: nextTitle, config: nextCfg });
          return { applied: true, updated: true, nodeId: val(node, 'id'), title: nextTitle, config: nextCfg };
        }

        if (args.operation === 'addNode') {
          if (!args.workflowId || !args.nodeType) throw failTool('WORKFLOW_NODE_ARGS_REQUIRED', 400, 'Cần workflowId và nodeType.');
          const key = args.nodeKey || `dxos_${args.nodeType}_${Date.now().toString(36)}`;
          if (args.dryRun) return { dryRun: true, workflowId: args.workflowId, nodeType: args.nodeType, key, upstreamNodeId: args.upstreamNodeId || null };
          const created = await nodeRepo.create({
            values: {
              workflowId: args.workflowId,
              key,
              title: args.title || `Bước ${args.nodeType}`,
              type: args.nodeType,
              ...(args.upstreamNodeId ? { upstreamId: args.upstreamNodeId } : {}),
              config: args.config || {},
            },
          });
          if (args.upstreamNodeId) {
            const up = await nodeRepo.findOne({ filterByTk: args.upstreamNodeId });
            if (up && typeof up.update === 'function') await up.update({ downstreamId: val(created, 'id') });
          }
          return { applied: true, added: true, node: { id: val(created, 'id'), key, title: val(created, 'title'), type: val(created, 'type') } };
        }

        if (args.operation === 'toggleWorkflow') {
          if (!args.workflowId) throw failTool('WORKFLOW_ID_REQUIRED', 400, 'Cần workflowId để bật/tắt workflow.');
          const enabled = args.enabled !== false;
          if (args.dryRun) return { dryRun: true, workflowId: args.workflowId, enabled };
          if (hasRes(ctx, 'workflows')) {
            await invokeResourceAction(ctx, 'workflows', 'update', { filterByTk: args.workflowId, values: { enabled } });
          } else {
            const wf = await wfRepo.findOne({ filterByTk: args.workflowId });
            if (!wf) throw failTool('WORKFLOW_NOT_FOUND', 404, 'Không tìm thấy workflow.');
            await wf.update({ enabled });
          }
          return { applied: true, workflowId: args.workflowId, enabled };
        }

        // buildCustomWorkflow
        if (!args.collectionName || SYSTEM_PROTECTED_COLLECTIONS.has(args.collectionName)) {
          throw failTool('COLLECTION_FORBIDDEN_FOR_WORKFLOW', 403, `Collection "${args.collectionName}" không hợp lệ hoặc bị bảo vệ.`);
        }
        const title = args.title || `Quy trình ${args.collectionName}`;
        const existingWf = await wfRepo.findOne({ filter: { title, current: true, 'options.dxosOrganizationId': actor.organizationId } });
        if (existingWf) {
          const wfId = val(existingWf, 'id');
          if (args.enabled !== undefined && Boolean(val(existingWf, 'enabled')) !== Boolean(args.enabled)) {
            await existingWf.update({ enabled: Boolean(args.enabled) });
          }
          return { applied: true, created: false, alreadyExists: true, workflowId: wfId, title, enabled: Boolean(args.enabled ?? val(existingWf, 'enabled')), designerUrl: `/admin/settings/workflow/workflows/${wfId}` };
        }
        const triggerMode = [1, 2, 3].includes(Number(args.triggerMode)) ? Number(args.triggerMode) : 1;
        const condField = args.conditionField || 'status';
        const condGt = args.conditionGt !== undefined ? args.conditionGt : -15;
        const crew = await resolveOrgCrewBindings(db, actor.organizationId, val);
        const assigneeEmpId = args.assigneeEmployeeId || crew.managerEmployeeId;
        let assigneeUserId = actor.userId;
        if (assigneeEmpId) {
          const emp = await db.getRepository('latticeEmployees')?.findOne({ filterByTk: assigneeEmpId });
          if (val(emp, 'userId')) assigneeUserId = val(emp, 'userId');
        }
        const enabled = args.enabled !== false;
        if (args.dryRun) {
          return { dryRun: true, operation: 'buildCustomWorkflow', title, collectionName: args.collectionName, triggerMode, enabled, nodeCount: 3 };
        }

        const wfValues = {
          key: `dxos_custom_${Date.now().toString(36)}`,
          title,
          type: 'collection',
          enabled,
          current: true,
          config: { collection: args.collectionName, mode: triggerMode, condition: { $and: [] } },
          options: { dxosOrganizationId: actor.organizationId, dxosCustomCollection: args.collectionName },
        };
        const created = await db.sequelize.transaction(async (transaction) => {
          const wf = await wfRepo.create({ values: wfValues, transaction });
          const workflowId = val(wf, 'id');
          const condNode = await nodeRepo.create({
            values: {
              workflowId,
              key: 'checkThreshold',
              title: `Kiểm tra ngưỡng (${condField} > ${condGt})`,
              type: 'condition',
              config: { rejectOnFalse: false, engine: 'basic', calculation: { group: { type: 'and', calculations: [{ calculator: 'gt', operands: [{ value: `{{$context.data.${condField}}}` }, { value: condGt }] }] } } },
            },
            transaction,
          });
          const reviewNode = await nodeRepo.create({
            values: {
              workflowId,
              key: 'managerReview',
              title: 'Quản lý kiểm tra & phê duyệt',
              type: 'manual',
              upstreamId: val(condNode, 'id'),
              config: { assignees: [String(assigneeUserId)], mode: 1, forms: { review: { title: 'Kết quả thẩm định', type: 'custom' } } },
            },
            transaction,
          });
          await condNode.update({ downstreamId: val(reviewNode, 'id') }, { transaction });
          const markNode = await nodeRepo.create({
            values: {
              workflowId,
              key: 'markReviewed',
              title: 'Cập nhật trạng thái đã kiểm định',
              type: 'update',
              upstreamId: val(reviewNode, 'id'),
              config: { collection: args.collectionName, params: { filter: { id: '{{$context.data.id}}' }, values: { status: 'reviewed' } } },
            },
            transaction,
          });
          await reviewNode.update({ downstreamId: val(markNode, 'id') }, { transaction });
          return { workflowId, title: val(wf, 'title'), key: val(wf, 'key'), nodeCount: 3 };
        });

        if (hasRes(ctx, 'workflows') && enabled) {
          try {
            await invokeResourceAction(ctx, 'workflows', 'update', { filterByTk: created.workflowId, values: { enabled: true } });
          } catch {}
        }
        return {
          applied: true,
          created: true,
          ...created,
          enabled,
          designerUrl: `/admin/settings/workflow/workflows/${created.workflowId}`,
        };
      },
    }),
  ];
}

module.exports = { createBuilderTools };
