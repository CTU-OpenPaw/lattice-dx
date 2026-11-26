/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { createHash } = require('node:crypto');
const path = require('node:path');
const {
  isBusinessRoleName,
  NATIVE_SURFACE_ACTIONS,
  collectPortalRouteSet,
  resolvePortalRoutes,
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
  capturePageSnapshot,
  bumpSurfaceRevision,
} = require('./ai-surface-creative-tools');
const { assertNoPrototypePollution } = require('./app-builder-planner');

const FIELD_INTERFACE_MAP = {
  text: { interface: 'textarea', uiType: 'string' },
  integer: { interface: 'integer', uiType: 'number' },
  float: { interface: 'number', uiType: 'number' },
  boolean: { interface: 'checkbox', uiType: 'boolean' },
  date: { interface: 'datetime', uiType: 'string' },
  datetime: { interface: 'datetime', uiType: 'string', component: 'DatePicker', componentProps: { showTime: true } },
  select: { interface: 'select', uiType: 'string' },
  enum: { interface: 'select', uiType: 'string' },
  json: { interface: 'json', uiType: 'object' },
  jsonb: { interface: 'json', uiType: 'object' },
  string: { interface: 'input', uiType: 'string' },
};

const TOOL_CUSTOM_COLLECTION_RE = /^latticeCustom[A-Z][A-Za-z0-9]{1,40}$/;
const TOOL_FORBIDDEN_FIELD_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
const TOOL_FALLBACK_ALLOWLISTED_BUSINESS_COLLECTIONS = new Set([
  'latticeRequests',
  'latticeOrders',
  'latticeOrderLines',
  'latticeServiceTickets',
  'latticeParaDocuments',
  'latticeIncidentCases',
  'latticeLocations',
  'latticeAssets',
  'latticeAgentProposals',
]);

const NATIVE_BLOCK_ALIASES = {
  NativeTableBlock: 'table',
  NativeFormBlock: 'createForm',
  NativeDetailsBlock: 'details',
};

function loadCrossPluginForTools(pkgName, dirSlug, relPath) {
  const inDist = __dirname.includes(`${path.sep}dist${path.sep}`);
  const candidates = inDist
    ? [`${pkgName}/dist/server/${relPath}`, `${pkgName}/src/server/${relPath}`, `../../../${dirSlug}/dist/server/${relPath}`, `../../../${dirSlug}/src/server/${relPath}`]
    : [`${pkgName}/src/server/${relPath}`, `../../../${dirSlug}/src/server/${relPath}`, `${pkgName}/dist/server/${relPath}`, `../../../${dirSlug}/dist/server/${relPath}`];
  for (const modPath of candidates) {
    try {
      return require(modPath);
    } catch (err) {
      const direct = err?.code === 'MODULE_NOT_FOUND'
        && (!Array.isArray(err.requireStack) || err.requireStack.length === 0 || err.requireStack[0] === __filename);
      if (!direct) throw err;
    }
  }
  return null;
}

function loadRichSchemaForTools() {
  return loadCrossPluginForTools('@latticedx/plugin-dxos-studio', 'plugin-dxos-studio', 'rich-schema');
}

function loadPgRlsForTools() {
  return loadCrossPluginForTools('@latticedx/plugin-lattice-foundation', 'plugin-lattice-foundation', 'pg-rls');
}

async function withOptionalSystemRls(db, pgRls, fn) {
  if (
    pgRls
    && typeof pgRls.canUsePgRlsSession === 'function'
    && pgRls.canUsePgRlsSession(db)
    && !pgRls.getActiveRlsContext?.()?.transaction
    && typeof pgRls.withSystemRlsBypass === 'function'
  ) {
    return pgRls.withSystemRlsBypass(db, fn);
  }
  return fn(null);
}

async function attachSchemaCollectionRls(db, collectionName) {
  let attached = false;
  if (typeof db?.attachLatticeRlsPolicy === 'function') {
    try {
      const res = await db.attachLatticeRlsPolicy(collectionName);
      if (res?.applied !== false) attached = true;
    } catch {
      // Fallback to pg-rls below
    }
  }
  if (!attached) {
    const pgRls = loadPgRlsForTools();
    if (typeof pgRls?.attachRlsPolicyToTable === 'function' && db?.sequelize) {
      try {
        const rlsRes = await withOptionalSystemRls(db, pgRls, (transaction) => (
          pgRls.attachRlsPolicyToTable(db, collectionName, { ...(transaction ? { transaction } : {}) })
        ));
        if (rlsRes?.applied) attached = true;
      } catch {
        // Non-fatal in mock test harnesses without physical SQL tables
      }
    }
  }
  return attached;
}

function buildSafePgIndexName(colLower, suffix) {
  const raw = `idx_${colLower}_${suffix}`;
  if (raw.length <= 63) return raw;
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 8);
  const maxBase = Math.max(8, 63 - 4 - suffix.length - 1 - 8 - 1);
  return `idx_${colLower.slice(0, maxBase)}_${hash}_${suffix}`;
}

function hasProtectedCollectionMatch(protectedCollections, name) {
  if (!protectedCollections) return false;
  if (typeof protectedCollections === 'function') return Boolean(protectedCollections(name));
  const raw = String(name || '').trim();
  if (!raw) return false;
  if (protectedCollections.has?.(raw)) return true;
  const low = raw.toLowerCase();
  for (const item of protectedCollections) {
    if (String(item).toLowerCase() === low) return true;
  }
  return false;
}

function buildFieldDefinition(rawField, failTool, FIELD_NAME_RE, protectedCollections = null, sourceCollection = null) {
  assertNoPrototypePollution(rawField, 'field');
  const fname = String(rawField?.name || '').trim();
  if (!FIELD_NAME_RE.test(fname) || TOOL_FORBIDDEN_FIELD_NAMES.has(fname)) {
    throw failTool('FIELD_NAME_INVALID', 400, `Tên trường "${fname}" không hợp lệ.`);
  }
  const richSchema = loadRichSchemaForTools();
  const allowlisted = richSchema?.DEFAULT_ALLOWLISTED_BUSINESS_COLLECTIONS instanceof Set
    ? new Set([...TOOL_FALLBACK_ALLOWLISTED_BUSINESS_COLLECTIONS, ...richSchema.DEFAULT_ALLOWLISTED_BUSINESS_COLLECTIONS])
    : TOOL_FALLBACK_ALLOWLISTED_BUSINESS_COLLECTIONS;
  const rawType = String(rawField?.type || 'string').trim();
  const titleStr = String(rawField?.title || rawField?.label || fname).trim();

  if (rawType === 'belongsTo') {
    const target = String(rawField?.target || rawField?.targetCollection || '').trim();
    if (hasProtectedCollectionMatch(protectedCollections, target)) {
      throw failTool('SYSTEM_COLLECTION_FORBIDDEN', 403, `Không được phép trỏ quan hệ belongsTo vào bảng hệ thống "${target}".`);
    }
    if (!target || !/^[a-zA-Z][a-zA-Z0-9_]{1,60}$/.test(target)) {
      throw failTool('RELATION_TARGET_FORBIDDEN', 403, `Bảng đích quan hệ belongsTo "${target || '(empty)'}" không hợp lệ hoặc bị bảo vệ.`);
    }
    const foreignKey = String(rawField?.foreignKey || `${fname}Id`).trim();
    const targetKey = String(rawField?.targetKey || 'id').trim();
    if (!FIELD_NAME_RE.test(foreignKey) || !FIELD_NAME_RE.test(targetKey)) {
      throw failTool('FIELD_NAME_INVALID', 400, `foreignKey/targetKey không hợp lệ cho trường "${fname}".`);
    }
    return {
      name: fname,
      type: 'belongsTo',
      interface: 'obo',
      target,
      foreignKey,
      targetKey,
      uiSchema: {
        type: 'object',
        title: titleStr,
        'x-component': 'AssociationField',
      },
    };
  }

  if (rawType === 'hasMany' || rawType === 'hasOne') {
    const target = String(rawField?.target || rawField?.targetCollection || '').trim();
    if (hasProtectedCollectionMatch(protectedCollections, target)) {
      throw failTool('SYSTEM_COLLECTION_FORBIDDEN', 403, `Không được phép trỏ quan hệ ${rawType} vào bảng hệ thống "${target}".`);
    }
    if (rawType === 'hasOne') {
      if (!target || (!TOOL_CUSTOM_COLLECTION_RE.test(target) && !allowlisted.has(target))) {
        throw failTool('RELATION_TARGET_FORBIDDEN', 403, `Bảng đích quan hệ hasOne "${target || '(empty)'}" không hợp lệ hoặc bị bảo vệ.`);
      }
    } else if (!target || !/^[a-zA-Z][a-zA-Z0-9_]{1,60}$/.test(target)) {
      throw failTool('RELATION_TARGET_FORBIDDEN', 403, `Bảng đích quan hệ hasMany "${target || '(empty)'}" không hợp lệ hoặc bị bảo vệ.`);
    }
    const foreignKey = String(rawField?.foreignKey || `${fname}Id`).trim();
    const sourceKey = String(rawField?.sourceKey || 'id').trim();
    if (!FIELD_NAME_RE.test(foreignKey) || !FIELD_NAME_RE.test(sourceKey)) {
      throw failTool('FIELD_NAME_INVALID', 400, `foreignKey/sourceKey không hợp lệ cho trường "${fname}".`);
    }
    return {
      name: fname,
      type: rawType,
      interface: rawType === 'hasOne' ? 'oho' : 'o2m',
      target,
      foreignKey,
      sourceKey,
      uiSchema: {
        type: rawType === 'hasOne' ? 'object' : 'array',
        title: titleStr,
        'x-component': 'AssociationField',
      },
    };
  }

  if (rawType === 'belongsToMany') {
    const target = String(rawField?.target || rawField?.targetCollection || '').trim();
    if (hasProtectedCollectionMatch(protectedCollections, target)) {
      throw failTool('SYSTEM_COLLECTION_FORBIDDEN', 403, `Không được phép trỏ quan hệ belongsToMany vào bảng hệ thống "${target}".`);
    }
    if (!target || (!TOOL_CUSTOM_COLLECTION_RE.test(target) && !allowlisted.has(target))) {
      throw failTool('RELATION_TARGET_FORBIDDEN', 403, `Bảng đích quan hệ belongsToMany "${target || '(empty)'}" không hợp lệ hoặc bị bảo vệ.`);
    }
    if (typeof richSchema?.resolveThroughCollectionName !== 'function') {
      throw failTool('RICH_SCHEMA_UNAVAILABLE', 503, 'Module rich-schema chưa sẵn sàng.');
    }
    const { through, foreignKey, otherKey } = richSchema.resolveThroughCollectionName(
      sourceCollection || 'latticeCustomEntity',
      { ...rawField, name: fname, target },
      { isProtectedCollection: (n) => hasProtectedCollectionMatch(protectedCollections, n) },
    );
    const sourceKey = String(rawField?.sourceKey || 'id').trim();
    const targetKey = String(rawField?.targetKey || 'id').trim();
    if (!FIELD_NAME_RE.test(sourceKey) || !FIELD_NAME_RE.test(targetKey)) {
      throw failTool('FIELD_NAME_INVALID', 400, `sourceKey/targetKey không hợp lệ cho trường "${fname}".`);
    }
    return {
      name: fname,
      type: 'belongsToMany',
      interface: 'm2m',
      target,
      through,
      foreignKey,
      otherKey,
      sourceKey,
      targetKey,
      uiSchema: {
        type: 'array',
        title: titleStr,
        'x-component': 'AssociationField',
      },
    };
  }

  if (rawType === 'formula') {
    if (typeof richSchema?.validateFormulaExpression !== 'function' || typeof richSchema?.sanitizeFieldValidation !== 'function') {
      throw failTool('FORMULA_ENGINE_UNAVAILABLE', 503, 'Bộ phân tích công thức Rich Schema chưa sẵn sàng (fail-closed).');
    }
    const rawExpr = rawField?.formulaExpression ?? rawField?.formula ?? rawField?.options?.formulaExpression ?? rawField?.options?.formula;
    const expr = typeof rawExpr === 'string' ? rawExpr.trim() : '';
    const check = richSchema.validateFormulaExpression(expr, { selfFieldName: fname, throwOnError: true });
    const allowedReturns = richSchema.ALLOWED_FORMULA_RETURN_TYPES || new Set(['float', 'integer', 'string', 'boolean']);
    const requestedReturn = rawField?.formulaReturnType ? String(rawField.formulaReturnType).trim() : '';
    if (requestedReturn && !allowedReturns.has(requestedReturn)) {
      throw failTool('INVALID_FORMULA_RETURN_TYPE', 400, `formulaReturnType "${requestedReturn}" không hợp lệ.`);
    }
    const formulaReturnType = requestedReturn || (allowedReturns.has(check?.inferredReturnType) ? check.inferredReturnType : 'float');
    const validation = richSchema.sanitizeFieldValidation({ ...rawField, name: fname, type: 'formula', formulaReturnType });
    const uiType = formulaReturnType === 'boolean' ? 'boolean' : (formulaReturnType === 'string' ? 'string' : 'number');
    const comp = formulaReturnType === 'boolean' ? 'Checkbox' : (formulaReturnType === 'string' ? 'Input' : 'InputNumber');
    return {
      name: fname,
      type: formulaReturnType,
      interface: 'formula',
      readOnly: true,
      formula: expr,
      formulaExpression: expr,
      formulaReturnType,
      ...(validation ? { validation } : {}),
      options: {
        formula: expr,
        formulaExpression: expr,
        formulaReturnType,
        readOnly: true,
        ...(validation ? { validation } : {}),
      },
      uiSchema: {
        type: uiType,
        title: titleStr,
        'x-component': comp,
        'x-read-pretty': true,
        readOnly: true,
        'x-formula': expr,
        ...(validation ? { 'x-validation': validation } : {}),
      },
    };
  }

  const ftype = Object.prototype.hasOwnProperty.call(FIELD_INTERFACE_MAP, rawType) ? rawType : 'string';
  const meta = FIELD_INTERFACE_MAP[ftype];
  const rawEnumList = Array.isArray(rawField?.enumValues)
    ? rawField.enumValues
    : (Array.isArray(rawField?.enum) ? rawField.enum : []);
  const enumValues = rawEnumList
    .map((v) => (v && typeof v === 'object' ? String(v.value ?? v.label ?? '').trim() : String(v ?? '').trim()))
    .filter(Boolean);
  const resolvedType = (ftype === 'select' || ftype === 'enum') ? 'string' : (ftype === 'jsonb' ? 'json' : ftype);

  let validation;
  const hasValidationInput = (rawField?.validation !== undefined && rawField.validation !== null)
    || rawField?.required === true
    || rawField?.unique === true;
  if (hasValidationInput) {
    if (rawField?.validation?.pattern != null && typeof richSchema?.validateSafeRegexPattern !== 'function') {
      throw failTool('REGEX_ENGINE_UNAVAILABLE', 503, 'Bộ kiểm tra regex Thompson NFA chưa sẵn sàng (fail-closed).');
    }
    if (typeof richSchema?.sanitizeFieldValidation !== 'function') {
      throw failTool('RICH_SCHEMA_UNAVAILABLE', 503, 'Module rich-schema chưa sẵn sàng.');
    }
    validation = richSchema.sanitizeFieldValidation({
      ...rawField,
      name: fname,
      type: resolvedType,
      ...(enumValues.length ? { enumValues } : {}),
    });
  }
  const finalEnums = enumValues.length ? enumValues : (Array.isArray(validation?.enum) ? validation.enum.map(String) : []);
  const opts = {
    ...(validation ? { validation } : {}),
    ...(rawField?.indexed ? { index: true } : {}),
  };

  return {
    name: fname,
    type: resolvedType,
    interface: (ftype === 'select' || ftype === 'enum' || (!enumValues.length && validation?.enum?.length)) ? 'select' : meta.interface,
    ...(rawField?.defaultValue !== undefined ? { defaultValue: rawField.defaultValue } : {}),
    ...(validation?.required ? { allowNull: false, required: true } : {}),
    ...(rawField?.indexed ? { index: true } : {}),
    ...(finalEnums.length ? { enum: finalEnums } : {}),
    ...(validation ? { validation } : {}),
    ...(Object.keys(opts).length ? { options: opts } : {}),
    uiSchema: {
      type: meta.uiType,
      title: titleStr,
      ...(meta.component ? { 'x-component': meta.component } : {}),
      ...(meta.componentProps ? { 'x-component-props': meta.componentProps } : {}),
      ...(validation ? { 'x-validation': validation } : {}),
      ...((ftype === 'select' || ftype === 'enum' || (!enumValues.length && validation?.enum?.length)) && finalEnums.length
        ? { enum: finalEnums.map((v) => ({ value: v, label: v })) }
        : {}),
    },
  };
}

function createSchemaBuilderTools(deps) {
  const {
    val, failTool, safeGetResource, invokeResourceAction, createAuditedTool,
    SYSTEM_PROTECTED_COLLECTIONS, isProtectedCollection, CUSTOM_COLLECTION_RE, FIELD_NAME_RE, SLUG_RE, ALLOWED_BLOCK_MODELS,
  } = deps;
  const isProtected = (name) => (typeof isProtectedCollection === 'function'
    ? isProtectedCollection(name)
    : hasProtectedCollectionMatch(SYSTEM_PROTECTED_COLLECTIONS, name));
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
      introduction: { title: 'Dựng & Chỉnh Sâu Block DX-OS + Native', about: 'Inspect, dựng trang đa block, chèn block chuẩn/DX-OS vào trang đang mở, chia lưới nhiều cột, cấu hình cột/nút/luật liên kết và gỡ block.' },
      description: 'Inspect, build multi-block portal pages, add inline DX-OS or native flowSurfaces blocks onto existing page grids, set multi-column grid layouts, configure deep block fields/actions/rules, reorder, or remove blocks (Admin only; supports dryRun).',
      schema: {
        description: 'Full lifecycle page & block builder command (v3 with deep flowSurfaces + multi-column grid).',
        properties: {
          action: { type: 'string', default: 'addBlock', enum: ['addBlock', 'listBlocks', 'composePageBlueprint', 'updateBlock', 'reorderBlocks', 'setGridLayout', 'configureNativeBlock', 'removeBlock'] },
          portalSlug: { type: 'string', required: true, maxLength: 40, description: 'Target portal slug (e.g., services, cold-qa).' },
          pageTitle: { type: 'string', maxLength: 100, description: 'Optional page title filter when inspecting or editing blocks.' },
          groupTitle: { type: 'string', maxLength: 80, description: 'Menu group title for composePageBlueprint.' },
          blockUid: { type: 'string', maxLength: 80, description: 'Target block UID for updateBlock, configureNativeBlock, or removeBlock.' },
          blockUse: { type: 'string', enum: ALLOWED_BLOCK_MODELS, description: 'Block model class or formal flowSurfaces block key (table, kanban, chart, filterForm, etc.) for addBlock.' },
          title: { type: 'string', maxLength: 100, description: 'Block or page title.' },
          collection: { type: 'string', maxLength: 60, description: 'Collection name for native table/form/kanban/chart blocks.' },
          fields: { type: 'array', items: { type: 'string' }, description: 'Field names for inline addBlock.' },
          tableFields: { type: 'array', items: { type: 'string' }, description: 'Field names for NativeTableBlock in composePageBlueprint.' },
          includeCreateForm: { type: 'boolean', default: false, description: 'Include Native createForm block in composePageBlueprint.' },
          dxosBlocks: { type: 'array', items: { type: 'object' }, description: 'Array of { blockUse, title, config } DX-OS blocks to attach in composePageBlueprint.' },
          orderedBlockUids: { type: 'array', items: { type: 'string' }, description: 'Ordered array of block UIDs for reorderBlocks.' },
          placeBesideBlockUid: { type: 'string', maxLength: 80, description: 'Optional existing block UID to share a [12, 12] 2-column row on addBlock.' },
          rowsLayout: { type: 'array', items: { type: 'object' }, description: 'Multi-column row layout array for setGridLayout.' },
          surfaceAction: { type: 'string', enum: NATIVE_SURFACE_ACTIONS, description: 'Deep flowSurfaces action for configureNativeBlock.' },
          surfacePayload: { type: 'object', description: 'Payload for flowSurfaces action on configureNativeBlock.' },
          config: { type: 'object', description: 'Object overriding block config props.' },
          configJson: { type: 'string', maxLength: 4000, description: 'Optional JSON string overriding block config props.' },
          roleNames: { type: 'array', items: { type: 'string' }, description: 'Optional ldx_* roles to grant onto created page routes.' },
          dryRun: { type: 'boolean', default: false },
        },
      },
      async run(ctx, db, actor, args) {
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
            rows: layout.rows || {},
            sizes: layout.sizes || {},
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
          await capturePageSnapshot(db, { portalSlug: args.portalSlug, pageTitle: args.pageTitle, note: `Before updateBlock ${args.blockUid}`, createdByUsername: actor.username, organizationId: actor.organizationId }, val);
          if (typeof flowModelsRepo.updateSingleNode === 'function') {
            await flowModelsRepo.updateSingleNode({
              uid: args.blockUid,
              props: nextConfig,
              stepParams: { ...meta.stepParams, dxosBlockSettings: { ...(meta.stepParams?.dxosBlockSettings || {}), config: nextConfig } },
            });
          } else if (typeof flowModelsRepo.upsertModel === 'function') {
            await flowModelsRepo.upsertModel({ ...model, props: nextConfig });
          }
          bumpSurfaceRevision(args.portalSlug, { organizationId: actor.organizationId, pageTitle: args.pageTitle, lastMutatedUid: args.blockUid, message: `AI đã cập nhật block ${meta.title || args.blockUid}` });
          return { applied: true, updated: true, blockUid: args.blockUid, afterProps: nextConfig };
        }

        if (action === 'setGridLayout') {
          const { flowModelsRepo, pageRoute, grid } = await resolvePageGrid(db, args.portalSlug, args.pageTitle, val);
          if (!grid || !flowModelsRepo) throw failTool('PAGE_GRID_NOT_FOUND', 404, `Không tìm thấy grid trên portal "${args.portalSlug}".`);
          const nextLayout = computeMultiColumnGrid(args.rowsLayout, failTool);
          if (args.dryRun) return { dryRun: true, action, portalSlug: args.portalSlug, nextLayout };
          await capturePageSnapshot(db, { portalSlug: args.portalSlug, pageTitle: val(pageRoute, 'title') || args.pageTitle, note: 'Before setGridLayout', createdByUsername: actor.username, organizationId: actor.organizationId }, val);
          if (hasRes(ctx, 'flowSurfaces')) {
            try {
              await invokeResourceAction(ctx, 'flowSurfaces', 'setLayout', { values: { target: { uid: grid.uid }, ...nextLayout } });
            } catch {
              await updateGridLayout(flowModelsRepo, grid, nextLayout);
            }
          } else {
            await updateGridLayout(flowModelsRepo, grid, nextLayout);
          }
          bumpSurfaceRevision(args.portalSlug, {
            organizationId: actor.organizationId,
            pageTitle: val(pageRoute, 'title') || args.pageTitle,
            layoutSignature: computeLayoutSignature({ props: nextLayout }),
            message: 'AI đã sắp xếp lại bố cục đa cột trên trang',
          });
          return { applied: true, action, portalSlug: args.portalSlug, layout: nextLayout };
        }

        if (action === 'configureNativeBlock') {
          if (!args.blockUid) throw failTool('BLOCK_UID_REQUIRED', 400, 'Cần blockUid để cấu hình block.');
          if (!args.surfaceAction || !NATIVE_SURFACE_ACTIONS.includes(args.surfaceAction)) {
            throw failTool('SURFACE_ACTION_INVALID', 400, `Cần surfaceAction hợp lệ trong: ${NATIVE_SURFACE_ACTIONS.join(', ')}.`);
          }
          const payload = args.surfacePayload && typeof args.surfacePayload === 'object' ? args.surfacePayload : {};
          if (args.dryRun) return { dryRun: true, action, blockUid: args.blockUid, surfaceAction: args.surfaceAction, surfacePayload: payload };
          await capturePageSnapshot(db, { portalSlug: args.portalSlug, pageTitle: args.pageTitle, note: `Before ${args.surfaceAction} on ${args.blockUid}`, createdByUsername: actor.username, organizationId: actor.organizationId }, val);
          const result = await invokeResourceAction(ctx, 'flowSurfaces', args.surfaceAction, {
            values: { target: { uid: args.blockUid }, ...payload },
          });
          bumpSurfaceRevision(args.portalSlug, { organizationId: actor.organizationId, pageTitle: args.pageTitle, lastMutatedUid: args.blockUid, message: `AI đã cấu hình sâu block (${args.surfaceAction})` });
          return { applied: true, action, blockUid: args.blockUid, surfaceAction: args.surfaceAction, result };
        }

        if (action === 'reorderBlocks' || action === 'removeBlock') {
          const { flowModelsRepo, pageRoute, grid } = await resolvePageGrid(db, args.portalSlug, args.pageTitle, val);
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
          await capturePageSnapshot(db, { portalSlug: args.portalSlug, pageTitle: val(pageRoute, 'title') || args.pageTitle, note: `Before ${action}`, createdByUsername: actor.username, organizationId: actor.organizationId }, val);
          const nextLayout = normalizeGridState(grid, nextOrder);
          await updateGridLayout(flowModelsRepo, grid, nextLayout);
          if (action === 'removeBlock') {
            if (hasRes(ctx, 'flowSurfaces')) {
              try { await invokeResourceAction(ctx, 'flowSurfaces', 'removeNode', { values: { target: { uid: args.blockUid } } }); }
              catch {
                if (typeof flowModelsRepo.remove === 'function') await flowModelsRepo.remove(args.blockUid);
              }
            } else if (typeof flowModelsRepo.remove === 'function') {
              await flowModelsRepo.remove(args.blockUid);
            } else if (typeof flowModelsRepo.destroy === 'function') {
              await flowModelsRepo.destroy({ filter: { uid: args.blockUid } });
            }
          }
          bumpSurfaceRevision(args.portalSlug, { organizationId: actor.organizationId, pageTitle: val(pageRoute, 'title') || args.pageTitle, blockCount: nextOrder.length, message: action === 'removeBlock' ? `AI đã gỡ block ${args.blockUid}` : 'AI đã sắp xếp lại thứ tự block' });
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
          bumpSurfaceRevision(args.portalSlug, { organizationId: actor.organizationId, pageTitle: title, message: `AI đã dựng trang đa block "${title}"` });
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

        // Default addBlock: inline onto EXISTING page grid for both DX-OS and NocoBase formal blocks
        if (!args.blockUse) throw failTool('BLOCK_USE_REQUIRED', 400, 'Cần blockUse để gắn block mới.');
        const title = args.title || args.blockUse;
        const collection = args.collection || 'latticeServiceTickets';
        const nativeType = NATIVE_BLOCK_ALIASES[args.blockUse] || args.blockUse;
        const resolved = await resolvePageGrid(db, args.portalSlug, args.pageTitle, val);
        const inlineFields = Array.isArray(args.fields) && args.fields.length ? args.fields : (Array.isArray(args.tableFields) && args.tableFields.length ? args.tableFields : ['code', 'name', 'status']);
        const blueprint = {
          version: '1',
          mode: 'create',
          navigation: { layoutUid: `ldx-portal-${args.portalSlug}`, group: { title: 'AI Mở rộng', icon: 'AppstoreAddOutlined' }, item: { title, icon: 'RobotOutlined' } },
          page: { title, displayTitle: true, enableTabs: false },
          tabs: [{ title, blocks: [{ key: `ai-${args.portalSlug}-${Date.now().toString(36)}`, type: nativeType.startsWith('Dxos') ? 'table' : nativeType, title, collection, fields: inlineFields }] }],
        };
        if (args.dryRun) {
          return { dryRun: true, portalSlug: args.portalSlug, blockUse: args.blockUse, nativeType, title, targetGridUid: resolved.grid?.uid || null, previewBlueprint: blueprint };
        }
        if (resolved.grid?.uid) {
          await capturePageSnapshot(db, { portalSlug: args.portalSlug, pageTitle: val(resolved.pageRoute, 'title') || args.pageTitle, note: `Before addBlock ${args.blockUse}`, createdByUsername: actor.username, organizationId: actor.organizationId }, val);
          if (args.blockUse.startsWith('Dxos') && resolved.flowModelsRepo?.upsertModel) {
            const blockUid = `dxos-ai-${args.portalSlug}-${Date.now().toString(36)}`;
            const cfg = {
              title,
              ...(args.collection && !parsedConfig.collection ? { collection: args.collection } : {}),
              ...parsedConfig,
            };
            if (cfg.collection && isProtected(cfg.collection)) {
              throw failTool('SYSTEM_COLLECTION_FORBIDDEN', 403, `Không được phép gắn block vào bảng hệ thống "${cfg.collection}".`);
            }
            await resolved.flowModelsRepo.upsertModel({
              uid: blockUid,
              use: args.blockUse,
              parentId: resolved.grid.uid,
              subKey: 'items',
              subType: 'array',
              props: cfg,
              stepParams: { dxosBlockSettings: { config: cfg } },
            });
            const placed = await placeBesideOrInsertBlock(resolved.flowModelsRepo, resolved.grid, blockUid, args.placeBesideBlockUid, failTool);
            bumpSurfaceRevision(args.portalSlug, { organizationId: actor.organizationId, pageTitle: val(resolved.pageRoute, 'title') || args.pageTitle, lastMutatedUid: blockUid, message: `AI đã gắn block "${title}"` });
            return { dryRun: false, applied: true, mode: 'flowModel', portalSlug: args.portalSlug, blockUid, blockUse: args.blockUse, sideBySideWith: placed.sideBySideWith };
          }
          if (hasRes(ctx, 'flowSurfaces')) {
            const needsResource = ['table', 'createForm', 'editForm', 'details', 'filterForm', 'kanban', 'chart', 'calendar', 'list', 'gridCard'].includes(nativeType);
            const fsPayload = {
              target: { uid: resolved.grid.uid },
              type: nativeType,
              title,
              ...(needsResource ? { resource: { binding: 'currentCollection', dataSourceKey: 'main', collectionName: collection }, fields: inlineFields } : {}),
              ...(Object.keys(parsedConfig).length ? { settings: parsedConfig } : {}),
            };
            const fsRes = await invokeResourceAction(ctx, 'flowSurfaces', 'addBlock', { values: fsPayload });
            const newUid = fsRes?.uid || fsRes?.data?.uid || null;
            if (newUid && args.placeBesideBlockUid) {
              const refreshed = await resolvePageGrid(db, args.portalSlug, args.pageTitle, val);
              if (refreshed.grid) await placeBesideOrInsertBlock(resolved.flowModelsRepo, refreshed.grid, newUid, args.placeBesideBlockUid, failTool);
            }
            bumpSurfaceRevision(args.portalSlug, { organizationId: actor.organizationId, pageTitle: val(resolved.pageRoute, 'title') || args.pageTitle, lastMutatedUid: newUid, message: `AI đã gắn block chuẩn "${title}" (${nativeType})` });
            return { dryRun: false, applied: true, mode: 'flowSurfaces:addBlock', portalSlug: args.portalSlug, blockUid: newUid, blockUse: nativeType, result: fsRes };
          }
        }
        const bpResult = await invokeResourceAction(ctx, 'flowSurfaces', 'applyBlueprint', { values: blueprint });
        bumpSurfaceRevision(args.portalSlug, { organizationId: actor.organizationId, pageTitle: title, message: `AI đã tạo trang block "${title}"` });
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
        const safeRoles = (args.roleNames || (operation === 'grant' ? ['ldx_employee', 'ldx_manager'] : [])).filter((r) => isBusinessRoleName(r));
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
            existingRoles = grants.map((g) => val(g, 'roleName')).filter((r) => isBusinessRoleName(r));
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
      introduction: { title: 'Mở rộng Bảng & Trường Dữ liệu', about: 'Inspect, tạo mới collection nghiệp vụ latticeCustom*, thêm trường, cập nhật metadata hoặc ngừng sử dụng trường an toàn.' },
      description: 'Inspect or create custom collection (latticeCustom*), add typed/select fields, update field metadata (updateFieldMeta), or safely deprecate a field without dropping columns (deprecateField).',
      schema: {
        description: 'Schema extension definition.',
        properties: {
          operation: { type: 'string', enum: ['createCollection', 'addFields', 'inspectCollection', 'updateFieldMeta', 'deprecateField'], required: true },
          collectionName: { type: 'string', required: true, maxLength: 60 },
          title: { type: 'string', maxLength: 100 },
          fieldName: { type: 'string', maxLength: 60 },
          uiSchema: { type: 'object' },
          enumValues: { type: 'array', items: { type: 'string' } },
          reason: { type: 'string', maxLength: 200 },
          fields: { type: 'array', items: { type: 'object' }, description: 'Field definitions ({ name, type, title, enumValues, target, through, foreignKey, otherKey, formulaExpression, formulaReturnType, validation, required, unique }).' },
          dryRun: { type: 'boolean', default: false },
        },
      },
      async run(_ctx, db, actor, args) {
        assertNoPrototypePollution(args, 'dxos_extend_collection_schema');
        if (isProtected(args.collectionName)) {
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
        if (args.operation === 'updateFieldMeta' || args.operation === 'deprecateField') {
          const targetFieldName = String(args.fieldName || args.fields?.[0]?.name || '').trim();
          if (!FIELD_NAME_RE.test(targetFieldName)) {
            throw failTool('FIELD_NAME_INVALID', 400, `Tên trường "${targetFieldName}" không hợp lệ.`);
          }
          if (args.operation === 'deprecateField' && ['id', 'organizationId', 'createdAt', 'updatedAt'].includes(targetFieldName)) {
            throw failTool('PROTECTED_FIELD_FORBIDDEN', 403, `Không được phép ngừng sử dụng trường lõi "${targetFieldName}".`);
          }
          if (args.dryRun) {
            return { dryRun: true, operation: args.operation, collectionName: args.collectionName, fieldName: targetFieldName };
          }
          const fieldsRepo = db.getRepository?.('fields');
          let existingField = fieldsRepo
            ? await fieldsRepo.findOne({ filter: { collectionName: args.collectionName, name: targetFieldName } })
            : null;
          if (!existingField && colsRepo) {
            const colRow = await colsRepo.findOne({ filter: { name: args.collectionName }, appends: ['fields'] });
            const colFields = Array.isArray(val(colRow, 'fields')) ? val(colRow, 'fields') : [];
            existingField = colFields.find((f) => val(f, 'name') === targetFieldName) || null;
          }
          if (!existingField) {
            throw failTool('FIELD_NOT_FOUND', 404, `Không tìm thấy trường "${targetFieldName}" trong "${args.collectionName}".`);
          }
          const prevUiSchema = val(existingField, 'uiSchema') && typeof val(existingField, 'uiSchema') === 'object'
            ? { ...val(existingField, 'uiSchema') }
            : {};
          if (args.operation === 'updateFieldMeta') {
            if (args.uiSchema !== undefined && args.uiSchema !== null) {
              assertNoPrototypePollution(args.uiSchema, 'uiSchema');
            }
            const nextUiSchema = {
              ...prevUiSchema,
              ...(args.uiSchema && typeof args.uiSchema === 'object' ? args.uiSchema : {}),
              ...(args.title ? { title: String(args.title).trim() } : {}),
            };
            let nextEnums = null;
            if (Array.isArray(args.enumValues)) {
              nextEnums = args.enumValues.map((v) => String(v || '').trim()).filter(Boolean);
              nextUiSchema.enum = nextEnums.map((v) => ({ value: v, label: v }));
            }
            const patch = {
              uiSchema: nextUiSchema,
              ...(nextEnums ? { enum: nextEnums } : {}),
            };
            if (typeof existingField.update === 'function') {
              await existingField.update(patch);
            } else if (fieldsRepo && typeof fieldsRepo.update === 'function') {
              await fieldsRepo.update({ filter: { collectionName: args.collectionName, name: targetFieldName }, values: patch });
            } else {
              Object.assign(existingField, patch);
            }
            const parentCol = colsRepo ? await colsRepo.findOne({ filter: { name: args.collectionName }, appends: ['fields'] }) : null;
            if (typeof parentCol?.load === 'function') await parentCol.load({ resetFields: true });
            return {
              updated: true,
              operation: 'updateFieldMeta',
              collectionName: args.collectionName,
              fieldName: targetFieldName,
              uiSchema: nextUiSchema,
            };
          }

          // deprecateField: non-destructive metadata deprecation (never drops DB column)
          const deprecatedAt = new Date().toISOString();
          const nextUiSchema = {
            ...prevUiSchema,
            deprecated: true,
            deprecatedAt,
            ...(args.reason ? { deprecatedReason: String(args.reason).trim() } : {}),
            'x-hidden': true,
            readOnly: true,
          };
          const prevOptions = val(existingField, 'options') && typeof val(existingField, 'options') === 'object'
            ? { ...val(existingField, 'options') }
            : {};
          const patch = {
            uiSchema: nextUiSchema,
            options: { ...prevOptions, deprecated: true, deprecatedAt },
          };
          if (typeof existingField.update === 'function') {
            await existingField.update(patch);
          } else if (fieldsRepo && typeof fieldsRepo.update === 'function') {
            await fieldsRepo.update({ filter: { collectionName: args.collectionName, name: targetFieldName }, values: patch });
          } else {
            Object.assign(existingField, patch);
          }
          const parentCol = colsRepo ? await colsRepo.findOne({ filter: { name: args.collectionName }, appends: ['fields'] }) : null;
          if (typeof parentCol?.load === 'function') await parentCol.load({ resetFields: true });
          return {
            deprecated: true,
            nonDestructive: true,
            operation: 'deprecateField',
            collectionName: args.collectionName,
            fieldName: targetFieldName,
            uiSchema: nextUiSchema,
          };
        }
        if (args.operation === 'createCollection' && !CUSTOM_COLLECTION_RE.test(args.collectionName)) {
          throw failTool('COLLECTION_NAME_INVALID', 400, 'Collection mới phải theo mẫu latticeCustom<TenVietHoa>.');
        }
        const rawFields = Array.isArray(args.fields) ? args.fields : [];
        if (!rawFields.length) throw failTool('FIELDS_REQUIRED', 400, 'Cần ít nhất 1 trường dữ liệu trong fields.');
        const normalizedFields = rawFields.map((f) => buildFieldDefinition(f, failTool, FIELD_NAME_RE, SYSTEM_PROTECTED_COLLECTIONS, args.collectionName));
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

        const provisionJoinTablesForFields = async (targetFields) => {
          const joinCols = [];
          const fieldsRepoLocal = db.getRepository('fields');
          for (const jf of targetFields) {
            if (jf.type !== 'belongsToMany' || !jf.through) continue;
            const joinName = jf.through;
            const fk = jf.foreignKey;
            const ok = jf.otherKey;
            const joinFieldsSpec = [
              { name: 'organizationId', type: 'string', interface: 'input', allowNull: false, defaultValue: actor.organizationId, index: true },
              { name: fk, type: 'bigInt', interface: 'integer', allowNull: false, index: true },
              { name: ok, type: 'bigInt', interface: 'integer', allowNull: false, index: true },
            ];
            const exJoin = await colsRepo.findOne({ filter: { name: joinName }, appends: ['fields'] });
            if (!exJoin) {
              const cj = await colsRepo.create({
                values: { name: joinName, title: `${args.collectionName} -> ${jf.target} Join`, autoGenId: true, createdAt: true, updatedAt: true, options: { uiManageable: true }, fields: joinFieldsSpec },
              });
              if (typeof cj?.load === 'function') await cj.load({ resetFields: true });
            } else if (fieldsRepoLocal) {
              const exNames = new Set((val(exJoin, 'fields') || []).map((x) => val(x, 'name')).filter(Boolean));
              for (const jfs of joinFieldsSpec) {
                if (!exNames.has(jfs.name)) {
                  const cf = await fieldsRepoLocal.create({ values: { ...jfs, collectionName: joinName } });
                  if (typeof cf?.load === 'function') await cf.load();
                }
              }
            }
            const jInst = db.getCollection?.(joinName);
            if (jInst && typeof jInst.sync === 'function') await jInst.sync({ force: false, alter: { drop: false } });
            else if (typeof db.sync === 'function') await db.sync();
            if (typeof db?.sequelize?.query === 'function') {
              const jl = joinName.toLowerCase();
              for (const [suf, colsSql, uq] of [['org', '"organizationId"', false], ['fk', `"${fk}"`, false], ['ok', `"${ok}"`, false], ['uq', `"organizationId", "${fk}", "${ok}"`, true]]) {
                const idxN = buildSafePgIndexName(jl, suf);
                try { await db.sequelize.query(`CREATE ${uq ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS "${idxN}" ON "${joinName}" (${colsSql});`); } catch {}
              }
            }
            await attachSchemaCollectionRls(db, joinName);
            joinCols.push(joinName);
          }
          return joinCols;
        };

        const richSchema = loadRichSchemaForTools();

        if (args.operation === 'createCollection') {
          const existing = await colsRepo.findOne({ filter: { name: args.collectionName }, appends: ['fields'] });
          if (existing) {
            if (typeof existing.load === 'function') await existing.load({ resetFields: true });
            return { created: false, alreadyExists: true, collectionName: args.collectionName };
          }
          await provisionJoinTablesForFields(normalizedFields);
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
          const createdIndexes = [];
          if (typeof db?.sequelize?.query === 'function' && CUSTOM_COLLECTION_RE.test(args.collectionName)) {
            const colLower = args.collectionName.toLowerCase();
            const idxOrg = buildSafePgIndexName(colLower, 'org');
            const idxOrgStatus = buildSafePgIndexName(colLower, 'org_status');
            try {
              await db.sequelize.query(`CREATE INDEX IF NOT EXISTS "${idxOrg}" ON "${args.collectionName}" ("organizationId");`);
              createdIndexes.push(idxOrg);
              await db.sequelize.query(`CREATE INDEX IF NOT EXISTS "${idxOrgStatus}" ON "${args.collectionName}" ("organizationId", "status");`);
              createdIndexes.push(idxOrgStatus);
            } catch {
              // Non-fatal in mock test harnesses without physical SQL tables
            }
          }
          if (CUSTOM_COLLECTION_RE.test(args.collectionName)) {
            await attachSchemaCollectionRls(db, args.collectionName);
          }
          if (typeof richSchema?.attachRichSchemaHooksForCollection === 'function') {
            richSchema.attachRichSchemaHooksForCollection(db, args.collectionName, normalizedFields);
          }
          return { created: true, collectionName: args.collectionName, fieldCount: normalizedFields.length, fields: normalizedFields.map((f) => f.name), indexes: createdIndexes };
        }

        const fieldsRepo = db.getRepository('fields');
        if (!fieldsRepo) throw failTool('FIELDS_REPO_UNAVAILABLE', 503, 'Repository fields chưa sẵn sàng.');
        await provisionJoinTablesForFields(normalizedFields);
        for (const f of normalizedFields) {
          const cf = await fieldsRepo.create({ values: { ...f, collectionName: args.collectionName } });
          if (typeof cf?.load === 'function') await cf.load();
        }
        const parentCol = await colsRepo.findOne({ filter: { name: args.collectionName }, appends: ['fields'] });
        if (typeof parentCol?.load === 'function') await parentCol.load({ resetFields: true });
        const colInst = db.getCollection?.(args.collectionName);
        if (colInst && typeof colInst.sync === 'function') await colInst.sync({ force: false, alter: { drop: false } });
        else if (typeof db.sync === 'function') await db.sync();
        if (
          CUSTOM_COLLECTION_RE.test(args.collectionName) &&
          normalizedFields.some((f) => f.name === 'organizationId')
        ) {
          await attachSchemaCollectionRls(db, args.collectionName);
        }
        if (typeof richSchema?.attachRichSchemaHooksForCollection === 'function') {
          const allColFields = Array.isArray(val(parentCol, 'fields')) && val(parentCol, 'fields').length
            ? val(parentCol, 'fields').map((r) => (typeof r?.toJSON === 'function' ? r.toJSON() : { ...r }))
            : normalizedFields;
          richSchema.attachRichSchemaHooksForCollection(db, args.collectionName, allColFields);
        }
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
        if (!isBusinessRoleName(args.roleName || '')) {
          throw failTool('ROLE_TARGET_FORBIDDEN', 403, `Không được phép cấu hình vai trò hệ thống hoặc tên vai trò không hợp lệ "${args.roleName}".`);
        }
        if (args.collectionName && isProtected(args.collectionName)) {
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
          if (args.cloneFromRole && isBusinessRoleName(args.cloneFromRole)) {
            if (resourcesRepo) {
              const srcRes = (await resourcesRepo.find({ filter: { roleName: args.cloneFromRole, dataSourceKey: 'main' }, appends: ['actions'], limit: 100 })) || [];
              if (dsRolesRepo && !(await dsRolesRepo.findOne({ filter: { roleName: args.roleName, dataSourceKey: 'main' } }))) {
                await dsRolesRepo.create({ values: { roleName: args.roleName, dataSourceKey: 'main' } });
              }
              for (const sr of srcRes) {
                const cname = val(sr, 'name');
                if (cname && !(await resourcesRepo.findOne({ filter: { roleName: args.roleName, dataSourceKey: 'main', name: cname } }))) {
                  const clonedActions = (val(sr, 'actions') || []).map((a) => ({
                    name: val(a, 'name'),
                    ...(val(a, 'fields') ? { fields: [...val(a, 'fields')] } : {}),
                    ...(val(a, 'scope') ? { scope: val(a, 'scope') } : {}),
                    ...(val(a, 'scopeId') != null ? { scopeId: val(a, 'scopeId') } : {}),
                  }));
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
            ...(val(a, 'scopeId') != null ? { scopeId: val(a, 'scopeId') } : {}),
          })).filter((a) => !toRevoke.has(a.name));
          let savedModel = existing;
          if (typeof resourcesRepo.update === 'function') {
            const updated = await resourcesRepo.update({
              filter: { roleName: args.roleName, dataSourceKey: 'main', name: args.collectionName },
              values: { usingActionsConfig: true, actions: remainingActions },
              updateAssociationValues: ['actions'],
            });
            savedModel = (Array.isArray(updated) ? updated[0] : updated) || existing;
          } else {
            await existing.update({ actions: remainingActions });
          }
          if (typeof savedModel?.writeToACL === 'function') {
            const dsAcl = ctx?.app?.dataSourceManager?.dataSources?.get?.('main')?.acl || ctx?.app?.acl;
            if (dsAcl) await savedModel.writeToACL({ acl: dsAcl });
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
            const scope = val(a, 'scope');
            const scopeId = val(a, 'scopeId');
            return {
              name: actName,
              ...(filtered ? { fields: filtered } : {}),
              ...(scope ? { scope } : {}),
              ...(scopeId != null ? { scopeId } : {}),
            };
          });
          let savedModel = existing;
          if (typeof resourcesRepo.update === 'function') {
            const updated = await resourcesRepo.update({
              filter: { roleName: args.roleName, dataSourceKey: 'main', name: args.collectionName },
              values: { usingActionsConfig: true, actions: nextActions },
              updateAssociationValues: ['actions'],
            });
            savedModel = (Array.isArray(updated) ? updated[0] : updated) || existing;
          } else {
            await existing.update({ actions: nextActions });
          }
          if (typeof savedModel?.writeToACL === 'function') {
            const dsAcl = ctx?.app?.dataSourceManager?.dataSources?.get?.('main')?.acl || ctx?.app?.acl;
            if (dsAcl) await savedModel.writeToACL({ acl: dsAcl });
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
  ];
}

module.exports = {
  createSchemaBuilderTools,
  buildFieldDefinition,
  buildSafePgIndexName,
  hasProtectedCollectionMatch,
  attachSchemaCollectionRls,
};
