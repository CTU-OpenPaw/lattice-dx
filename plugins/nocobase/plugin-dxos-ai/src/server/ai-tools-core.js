/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { defineToolSchema } = require('./schema-helper');
const { recordAiAuditLog } = require('./ai-schemas');

const ADMIN_BUILDER_TOOL_NAMES = [
  'dxos_inspect_architecture',
  'dxos_compose_page_blocks',
  'dxos_manage_portal_and_acl',
  'dxos_extend_collection_schema',
  'dxos_deploy_workflow',
];

const OPERATIONAL_TOOL_NAMES = [
  'dxos_search_enterprise_context',
  'dxos_execute_record_action',
  'dxos_my_tasks_copilot',
];

const WRITABLE_BUSINESS_COLLECTIONS = new Set([
  'latticeServiceTickets',
  'latticeOrders',
  'latticeRequests',
  'latticeParaDocuments',
]);

const PROTECTED_SERVER_FIELDS = new Set([
  'id', 'createdAt', 'updatedAt', 'organizationId', 'status', 'version',
  'requesterId', 'assigneeId', 'ownerId', 'decisionReason', 'resolutionNote', 'handlerId',
]);

const SYSTEM_PROTECTED_COLLECTIONS = new Set([
  'users', 'roles', 'rolesUsers', 'apiKeys', 'authenticators', 'migrations',
  'applicationPlugins', 'aiSettings', 'aiEmployees', 'aiMcpClients',
  'rolesAiEmployees', 'latticeAiAuditLogs', 'latticeAiProfiles', 'dataSourcesRolesResources',
]);

const CUSTOM_COLLECTION_RE = /^latticeCustom[A-Z][A-Za-z0-9]{1,40}$/;
const FIELD_NAME_RE = /^[a-z][a-zA-Z0-9_]{1,48}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const ALLOWED_BLOCK_MODELS = [
  'DxosPortalHeroBlockModel', 'DxosKpiMetricBlockModel', 'DxosContextTelemetryBlockModel',
  'DxosAiProposalBlockModel', 'DxosWorkflowTasksBlockModel', 'DxosParaVaultBlockModel',
  'NativeTableBlock', 'NativeFormBlock', 'NativeDetailsBlock',
];
const SEARCHABLE_COLLECTIONS = [
  'latticeOrders', 'latticeRequests', 'latticeServiceTickets',
  'latticeIncidentCases', 'latticeAssets', 'latticeParaDocuments',
];

const val = (row, key) => (typeof row?.get === 'function' ? row.get(key) : row?.[key]);

function failTool(code, status, message) {
  return Object.assign(new Error(message || code), { code, status });
}

async function isStudioAdmin(ctx, db) {
  if (!ctx?.state?.currentUser && !ctx?.auth?.user) return false;
  const roleNames = Array.isArray(ctx.state?.currentRoles) && ctx.state.currentRoles.length
    ? ctx.state.currentRoles
    : ctx.state?.currentRole ? [ctx.state.currentRole] : [];
  if (roleNames.includes('root') || roleNames.includes('admin')) return true;
  const rolesRepo = db?.getRepository?.('roles');
  if (!rolesRepo || !roleNames.length) return false;
  const matched = (await rolesRepo.find({ filter: { name: { $in: roleNames } } })) || [];
  return matched.some((r) => {
    if (val(r, 'allowConfigure') === true) return true;
    const snippets = val(r, 'snippets');
    return Array.isArray(snippets) && (snippets.includes('pm') || snippets.includes('pm.*'));
  });
}

async function resolveActorScope(ctx, db) {
  const user = ctx?.state?.currentUser || ctx?.auth?.user;
  const userId = val(user, 'id');
  if (!userId) throw failTool('NATIVE_LOGIN_REQUIRED', 401, 'Yêu cầu đăng nhập để thực thi công cụ.');
  const targetDb = db || ctx.db;
  const roleNames = Array.isArray(ctx.state?.currentRoles) && ctx.state.currentRoles.length
    ? ctx.state.currentRoles
    : ctx.state?.currentRole ? [ctx.state.currentRole] : [];
  const isAdmin = await isStudioAdmin(ctx, targetDb);
  const empRepo = targetDb?.getRepository?.('latticeEmployees');
  let employee = null;
  if (empRepo) {
    const rows = (await empRepo.find({ filter: { userId, active: true }, limit: 1 })) || [];
    employee = rows[0] || null;
  }
  if (!isAdmin && (!employee || !val(employee, 'organizationId'))) {
    throw failTool('ORG_MEMBERSHIP_REQUIRED', 403, 'Tài khoản chưa gắn nhân sự đang hoạt động trong tổ chức.');
  }
  return {
    userId,
    username: val(user, 'username') || val(user, 'nickname') || `user-${userId}`,
    roleNames,
    isAdmin,
    employeeId: val(employee, 'id') || null,
    organizationId: val(employee, 'organizationId') || String(ctx?.state?.defaultOrgId || 'native-ui-lab'),
  };
}

async function invokeResourceAction(ctx, resourceName, actionName, { filterByTk, values } = {}) {
  const resource = ctx?.app?.resourceManager?.getResource?.(resourceName);
  const handler = resource?.actions?.get?.(actionName)?.handler || resource?.actions?.[actionName];
  if (typeof handler !== 'function') {
    throw failTool('HOST_ACTION_UNAVAILABLE', 503, `Dịch vụ ${resourceName}:${actionName} chưa sẵn sàng.`);
  }
  const subCtx = {
    app: ctx.app,
    db: ctx.db,
    state: { ...ctx.state },
    auth: ctx.auth,
    getCurrentLocale: ctx.getCurrentLocale?.bind(ctx),
    i18n: ctx.i18n,
    action: { actionName, resourceName, params: { ...(filterByTk != null ? { filterByTk } : {}), ...(values ? { values } : {}) } },
    request: { headers: {} },
    body: null,
    throw: (s, m) => { throw failTool('HOST_ACTION_ERROR', s, m); },
  };
  await handler(subCtx, async () => {});
  if (subCtx.status && subCtx.status >= 400) {
    throw failTool('HOST_ACTION_ERROR', subCtx.status, subCtx.body?.errors?.[0]?.message || `${resourceName}:${actionName} failed`);
  }
  return subCtx.body?.data || subCtx.body || {};
}

function createAuditedTool(spec) {
  const schemaHelper = defineToolSchema(spec.schema);
  return {
    scope: 'CUSTOM',
    from: 'loader',
    execution: 'backend',
    defaultPermission: spec.defaultPermission || 'ASK',
    silence: false,
    introduction: spec.introduction,
    definition: {
      name: spec.name,
      description: spec.description,
      schema: schemaHelper.zodSchema || schemaHelper.jsonSchema,
    },
    jsonSchema: schemaHelper.jsonSchema,
    adminOnly: Boolean(spec.adminOnly),
    validateArgs: schemaHelper.validate,
    async invoke(ctx, rawArgs = {}) {
      const started = Date.now();
      const db = ctx?.db || ctx?.app?.db;
      const channel = ctx?.state?.dxosAuditChannel || 'ai-tool';
      const aiEmployee = ctx?.state?.dxosAiUsername || null;
      let actor = null;
      try {
        actor = await resolveActorScope(ctx, db);
        if (spec.adminOnly && !actor.isAdmin) {
          throw failTool('DXOS_ADMIN_REQUIRED', 403, `Công cụ "${spec.name}" chỉ dành cho Quản trị viên.`);
        }
        const checked = schemaHelper.validate(rawArgs);
        if (!checked.ok) throw failTool('TOOL_ARGS_INVALID', 400, checked.error);
        const result = await spec.run(ctx, db, actor, checked.value);
        await recordAiAuditLog(db, {
          actorUserId: actor.userId,
          actorUsername: actor.username,
          organizationId: actor.organizationId,
          channel,
          aiEmployee,
          toolName: spec.name,
          argsSummary: checked.value,
          status: result?.degraded ? 'degraded' : 'allowed',
          durationMs: Date.now() - started,
          resultSummary: JSON.stringify(result).slice(0, 600),
        });
        return result;
      } catch (err) {
        await recordAiAuditLog(db, {
          actorUserId: actor?.userId ?? ctx?.state?.currentUser?.id ?? null,
          actorUsername: actor?.username ?? ctx?.state?.currentUser?.username ?? null,
          organizationId: actor?.organizationId ?? null,
          channel,
          aiEmployee,
          toolName: spec.name,
          argsSummary: rawArgs,
          status: err?.status === 403 || err?.status === 401 ? 'denied' : 'error',
          durationMs: Date.now() - started,
          errorCode: err?.code || 'TOOL_ERROR',
          resultSummary: err?.message || 'Tool execution failed',
        });
        throw err;
      }
    },
  };
}

function findPortalOverviewRoute(routes, portalSlug) {
  const layoutUid = `ldx-portal-${portalSlug}`;
  const inLayout = routes.filter((r) => val(r, 'uiLayoutUid') === layoutUid || val(r, 'layoutUid') === layoutUid);
  const byId = new Map(routes.map((r) => [String(val(r, 'id')), r]));
  const pages = routes.filter((r) => {
    if (!['flowPage', 'page'].includes(val(r, 'type'))) return false;
    if (inLayout.includes(r)) return true;
    const pid = val(r, 'parentId');
    return pid != null && inLayout.some((p) => String(val(p, 'id')) === String(pid));
  });
  return pages.find((p) => val(p, 'title')?.toLowerCase().includes('tổng quan')) || pages[0] || byId.get(String(val(inLayout[0], 'id'))) || null;
}

function createDxosTools() {
  return [
    createAuditedTool({
      name: 'dxos_inspect_architecture',
      adminOnly: true,
      defaultPermission: 'ALLOW',
      introduction: { title: 'Inspect Kiến trúc LatticeDX', about: 'Đọc portals, pages, collections, workflows, roles và AI profiles đang chạy.' },
      description: 'Inspect live LatticeDX portals, desktop pages, collections, active workflows, roles, and customizable AI employee profiles (Admin only).',
      schema: {
        description: 'Optional portal filter for detailed layout inspection.',
        properties: { portalSlug: { type: 'string', description: 'Optional portal slug such as services or logistics.', maxLength: 40 } },
      },
      async run(ctx, db, actor, args) {
        const safeFind = async (repoName, filter = {}, limit = 100) => {
          const repo = db?.getRepository?.(repoName);
          return repo ? (await repo.find({ filter, limit })) || [] : [];
        };
        const [layouts, routes, cols, wfs, roles, profiles] = await Promise.all([
          safeFind('uiLayouts', {}, 50),
          safeFind('desktopRoutes', {}, 200),
          safeFind('collections', {}, 100),
          safeFind('workflows', { current: true }, 50),
          safeFind('roles', {}, 50),
          safeFind('latticeAiProfiles', {}, 50),
        ]);
        const portals = layouts.filter((l) => String(val(l, 'uid') || '').startsWith('ldx-portal-')).map((l) => ({ uid: val(l, 'uid'), name: val(l, 'name') }));
        const targetRoute = args.portalSlug ? findPortalOverviewRoute(routes, args.portalSlug) : null;
        return {
          inspectedBy: actor.username,
          portalCount: portals.length,
          portals,
          pageCount: routes.filter((r) => ['page', 'flowPage'].includes(val(r, 'type'))).length,
          businessCollections: cols.map((c) => val(c, 'name')).filter((n) => String(n || '').startsWith('lattice')),
          activeWorkflows: wfs.map((w) => ({ id: val(w, 'id'), title: val(w, 'title'), enabled: val(w, 'enabled') })),
          roleNames: roles.map((r) => val(r, 'name')),
          aiProfileCount: profiles.length,
          ...(args.portalSlug ? { focusedPortal: args.portalSlug, targetPageUid: val(targetRoute, 'pageUid') || val(targetRoute, 'schemaUid') || null } : {}),
        };
      },
    }),

    createAuditedTool({
      name: 'dxos_compose_page_blocks',
      adminOnly: true,
      defaultPermission: 'ASK',
      introduction: { title: 'Dựng & Chỉnh Block DX-OS', about: 'Thêm DX-OS Block hoặc block native lên trang Portal qua metadata.' },
      description: 'Attach or update a DX-OS or native block on a portal page (Admin only; supports dryRun preview).',
      schema: {
        description: 'Compose or attach a block onto a LatticeDX portal page.',
        properties: {
          portalSlug: { type: 'string', required: true, maxLength: 40, description: 'Target portal slug (e.g., services, logistics, incidents).' },
          blockUse: { type: 'string', required: true, enum: ALLOWED_BLOCK_MODELS, description: 'Block model class or native block type.' },
          title: { type: 'string', required: true, maxLength: 100, description: 'Display title for the block or new page.' },
          collection: { type: 'string', maxLength: 60, description: 'Collection name when blockUse is NativeTableBlock/NativeFormBlock/NativeDetailsBlock.' },
          configJson: { type: 'string', maxLength: 2000, description: 'Optional JSON string overriding block config props.' },
          dryRun: { type: 'boolean', default: false, description: 'When true, return blueprint preview without mutating metadata.' },
        },
      },
      async run(ctx, db, actor, args) {
        if (!SLUG_RE.test(args.portalSlug)) throw failTool('PORTAL_SLUG_INVALID', 400, 'Slug portal không hợp lệ.');
        let parsedConfig = {};
        if (args.configJson) {
          try { parsedConfig = JSON.parse(args.configJson); }
          catch { throw failTool('CONFIG_JSON_INVALID', 400, 'configJson không phải JSON hợp lệ.'); }
        }
        const collection = args.collection || 'latticeServiceTickets';
        const blueprint = {
          version: '1',
          mode: 'create',
          navigation: { layoutUid: `ldx-portal-${args.portalSlug}`, group: { title: 'AI Mở rộng', icon: 'AppstoreAddOutlined' }, item: { title: args.title, icon: 'RobotOutlined' } },
          page: { title: args.title, displayTitle: true, enableTabs: false },
          tabs: [{
            title: args.title,
            blocks: [{
              key: `ai-${args.portalSlug}-${Date.now().toString(36)}`,
              type: args.blockUse === 'NativeFormBlock' ? 'createForm' : args.blockUse === 'NativeDetailsBlock' ? 'details' : 'table',
              title: args.title,
              collection,
              fields: ['code', 'name', 'status'],
            }],
          }],
        };
        if (args.dryRun) {
          return { dryRun: true, portalSlug: args.portalSlug, blockUse: args.blockUse, title: args.title, previewBlueprint: blueprint };
        }
        const flowModelsRepo = db?.getRepository?.('flowModels');
        const routesRepo = db?.getRepository?.('desktopRoutes');
        if (args.blockUse.startsWith('Dxos') && flowModelsRepo?.upsertModel && routesRepo) {
          const routes = (await routesRepo.find({})) || [];
          const overview = findPortalOverviewRoute(routes, args.portalSlug);
          const tabRoute = overview ? routes.find((r) => String(val(r, 'parentId')) === String(val(overview, 'id')) && val(r, 'type') === 'tabs') : null;
          const grid = tabRoute && flowModelsRepo.findModelByParentId ? await flowModelsRepo.findModelByParentId(val(tabRoute, 'schemaUid'), { subKey: 'grid' }) : null;
          if (grid?.uid) {
            const blockUid = `dxos-ai-${args.portalSlug}-${Date.now().toString(36)}`;
            const cfg = { title: args.title, ...parsedConfig };
            await flowModelsRepo.upsertModel({ uid: blockUid, use: args.blockUse, parentId: grid.uid, subKey: 'items', subType: 'array', props: cfg, stepParams: { dxosBlockSettings: { config: cfg } } });
            if (typeof flowModelsRepo.updateSingleNode === 'function') {
              const rowKey = `dxos_ai_${Date.now().toString(36)}`;
              const base = grid.stepParams?.gridSettings?.grid || grid.props || {};
              const nextLayout = { rows: { ...(base.rows || {}), [rowKey]: [[blockUid]] }, sizes: { ...(base.sizes || {}), [rowKey]: [24] }, rowOrder: [rowKey, ...(Array.isArray(base.rowOrder) ? base.rowOrder : Object.keys(base.rows || {}))] };
              await flowModelsRepo.updateSingleNode({ uid: grid.uid, props: { ...(grid.props || {}), ...nextLayout }, stepParams: { ...(grid.stepParams || {}), gridSettings: { ...(grid.stepParams?.gridSettings || {}), grid: nextLayout } } });
            }
            return { dryRun: false, applied: true, mode: 'flowModel', portalSlug: args.portalSlug, blockUid, blockUse: args.blockUse };
          }
        }
        const bpResult = await invokeResourceAction(ctx, 'flowSurfaces', 'applyBlueprint', { values: blueprint });
        return { dryRun: false, applied: true, mode: 'applyBlueprint', portalSlug: args.portalSlug, blockUse: args.blockUse, result: bpResult };
      },
    }),

    createAuditedTool({
      name: 'dxos_manage_portal_and_acl',
      adminOnly: true,
      defaultPermission: 'ASK',
      introduction: { title: 'Quản trị Portal & Phân quyền Role', about: 'Tạo/cập nhật Portal /p/* và gán quyền xem cho vai trò ldx_*.' },
      description: 'Create or update a LatticeDX multi-portal layout and assign menu visibility to ldx_* roles (Admin only).',
      schema: {
        description: 'Portal metadata & role binding input.',
        properties: {
          slug: { type: 'string', required: true, maxLength: 40 },
          title: { type: 'string', required: true, maxLength: 100 },
          roleNames: { type: 'array', items: { type: 'string' }, description: 'Target ldx_* role names.' },
          dryRun: { type: 'boolean', default: false },
        },
      },
      async run(ctx, db, actor, args) {
        if (!SLUG_RE.test(args.slug)) throw failTool('PORTAL_SLUG_INVALID', 400, 'Slug portal không hợp lệ.');
        const layoutUid = `ldx-portal-${args.slug}`;
        const safeRoles = (args.roleNames || ['ldx_employee', 'ldx_manager']).filter((r) => /^ldx_[a-z_]+$/.test(r));
        if (args.dryRun) {
          return { dryRun: true, layoutUid, path: `/p/${args.slug}`, title: args.title, roleNames: safeRoles };
        }
        const layoutsRepo = db.getRepository('uiLayouts');
        if (layoutsRepo) {
          const existed = await layoutsRepo.findOne({ filter: { uid: layoutUid } });
          if (existed && typeof existed.update === 'function') await existed.update({ name: args.title });
          else await layoutsRepo.create({ values: { uid: layoutUid, name: args.title, type: 'admin', options: { path: `/p/${args.slug}` } } });
        }
        const routesRepo = db.getRepository('desktopRoutes');
        const rolesRoutesRepo = db.getRepository('rolesDesktopRoutes');
        let groupRoute = routesRepo ? await routesRepo.findOne({ filter: { uiLayoutUid: layoutUid } }) : null;
        if (routesRepo && !groupRoute) {
          groupRoute = await routesRepo.create({ values: { title: args.title, type: 'group', uiLayoutUid: layoutUid, hideInMenu: false } });
        }
        if (rolesRoutesRepo && groupRoute) {
          for (const roleName of safeRoles) {
            const desktopRouteId = val(groupRoute, 'id');
            if (!(await rolesRoutesRepo.findOne({ filter: { roleName, desktopRouteId } }))) {
              await rolesRoutesRepo.create({ values: { roleName, desktopRouteId } });
            }
          }
        }
        return { applied: true, layoutUid, path: `/p/${args.slug}`, assignedRoles: safeRoles };
      },
    }),

    createAuditedTool({
      name: 'dxos_extend_collection_schema',
      adminOnly: true,
      defaultPermission: 'ASK',
      introduction: { title: 'Mở rộng Bảng & Trường Dữ liệu', about: 'Tạo collection nghiệp vụ latticeCustom* hoặc thêm trường dữ liệu chuẩn.' },
      description: 'Create a custom uiManageable collection (latticeCustom*) or add typed fields to business collections (Admin only; blocks system tables).',
      schema: {
        description: 'Schema extension definition.',
        properties: {
          operation: { type: 'string', enum: ['createCollection', 'addFields'], required: true },
          collectionName: { type: 'string', required: true, maxLength: 60 },
          title: { type: 'string', maxLength: 100 },
          fields: { type: 'array', items: { type: 'object' }, required: true },
          dryRun: { type: 'boolean', default: false },
        },
      },
      async run(ctx, db, actor, args) {
        if (SYSTEM_PROTECTED_COLLECTIONS.has(args.collectionName)) {
          throw failTool('SYSTEM_COLLECTION_FORBIDDEN', 403, `Không được phép sửa bảng hệ thống "${args.collectionName}".`);
        }
        if (args.operation === 'createCollection' && !CUSTOM_COLLECTION_RE.test(args.collectionName)) {
          throw failTool('COLLECTION_NAME_INVALID', 400, 'Collection mới phải theo mẫu latticeCustom<TenVietHoa>.');
        }
        const normalizedFields = [];
        for (const f of args.fields) {
          const fname = String(f?.name || '').trim();
          const ftype = ['string', 'text', 'integer', 'float', 'boolean', 'date'].includes(f?.type) ? f.type : 'string';
          if (!FIELD_NAME_RE.test(fname)) throw failTool('FIELD_NAME_INVALID', 400, `Tên trường "${fname}" không hợp lệ.`);
          normalizedFields.push({ name: fname, type: ftype, interface: ftype === 'text' ? 'textarea' : ftype === 'integer' ? 'integer' : ftype === 'boolean' ? 'checkbox' : 'input', uiSchema: { type: ftype === 'integer' || ftype === 'float' ? 'number' : ftype === 'boolean' ? 'boolean' : 'string', title: String(f?.title || fname) } });
        }
        if (args.operation === 'createCollection' && !normalizedFields.some((f) => f.name === 'organizationId')) {
          normalizedFields.unshift({ name: 'organizationId', type: 'string', interface: 'input', allowNull: false, defaultValue: actor.organizationId, uiSchema: { type: 'string', title: 'Mã tổ chức' } });
        }
        if (args.dryRun) return { dryRun: true, operation: args.operation, collectionName: args.collectionName, fields: normalizedFields };
        const colsRepo = db.getRepository('collections');
        if (!colsRepo) throw failTool('SCHEMA_REPO_UNAVAILABLE', 503, 'Repository collections chưa sẵn sàng.');
        if (args.operation === 'createCollection') {
          await colsRepo.create({ values: { name: args.collectionName, title: args.title || args.collectionName, fields: normalizedFields } });
          if (typeof db.sync === 'function') await db.sync();
          return { created: true, collectionName: args.collectionName, fieldCount: normalizedFields.length };
        }
        const fieldsRepo = db.getRepository('fields');
        if (!fieldsRepo) throw failTool('FIELDS_REPO_UNAVAILABLE', 503, 'Repository fields chưa sẵn sàng.');
        for (const f of normalizedFields) {
          await fieldsRepo.create({ values: { ...f, collectionName: args.collectionName } });
        }
        if (typeof db.sync === 'function') await db.sync();
        return { updated: true, collectionName: args.collectionName, addedFields: normalizedFields.map((f) => f.name) };
      },
    }),

    createAuditedTool({
      name: 'dxos_deploy_workflow',
      adminOnly: true,
      defaultPermission: 'ASK',
      introduction: { title: 'Triển khai Quy trình Poka-yoke', about: 'Cài nhanh mẫu quy trình doanh nghiệp hoặc AI triage chạy nền.' },
      description: 'Deploy a validated DX-OS workflow template onto the target organization (Admin only).',
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
        if (args.dryRun) return { dryRun: true, templateKey: args.templateKey, organizationId, enabled: Boolean(args.enabled) };
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
        const studioRes = ctx?.app?.resourceManager?.getResource?.('dxosStudio');
        if (studioRes) {
          return invokeResourceAction(ctx, 'dxosStudio', 'installWorkflow', { values: { templateKey: args.templateKey, organizationId, enabled: args.enabled !== false } });
        }
        return { deployed: false, message: 'Cần bật @latticedx/plugin-dxos-studio để cài 4 mẫu quy trình Poka-yoke.' };
      },
    }),

    createAuditedTool({
      name: 'dxos_search_enterprise_context',
      adminOnly: false,
      defaultPermission: 'ALLOW',
      introduction: { title: 'Tra cứu Ngữ cảnh Doanh nghiệp', about: 'Tìm kiếm đơn hàng, yêu cầu, sự cố, tài sản & tài liệu P.A.R.A. theo tổ chức.' },
      description: 'Search across organization-scoped business collections (orders, requests, tickets, incidents, assets, P.A.R.A. SOPs) with record citations.',
      schema: {
        description: 'Organization-scoped cross-collection search.',
        properties: {
          query: { type: 'string', maxLength: 120, description: 'Optional keyword matched against title, name, or code.' },
          collections: { type: 'array', items: { type: 'string' }, description: 'Subset of SEARCHABLE_COLLECTIONS.' },
          limit: { type: 'integer', default: 5 },
        },
      },
      async run(ctx, db, actor, args) {
        const targets = (Array.isArray(args.collections) && args.collections.length ? args.collections : SEARCHABLE_COLLECTIONS).filter((c) => SEARCHABLE_COLLECTIONS.includes(c));
        const limit = Math.max(1, Math.min(20, Number(args.limit) || 5));
        const items = [];
        for (const colName of targets) {
          const repo = db?.getRepository?.(colName);
          if (!repo) continue;
          const rows = (await repo.find({ filter: { organizationId: actor.organizationId }, limit: 25, sort: ['-id'] })) || [];
          const q = String(args.query || '').trim().toLowerCase();
          for (const row of rows) {
            const label = String(val(row, 'name') || val(row, 'title') || val(row, 'code') || '');
            const code = String(val(row, 'code') || val(row, 'id') || '');
            if (q && !label.toLowerCase().includes(q) && !code.toLowerCase().includes(q)) continue;
            items.push({ collection: colName, id: val(row, 'id'), code, title: label, status: val(row, 'status') || val(row, 'paraSpace') || null, citation: `[${colName}:${code}#${val(row, 'id')}]` });
            if (items.length >= limit) break;
          }
          if (items.length >= limit) break;
        }
        return { organizationId: actor.organizationId, count: items.length, items };
      },
    }),

    createAuditedTool({
      name: 'dxos_execute_record_action',
      adminOnly: false,
      defaultPermission: 'ASK',
      introduction: { title: 'Thực thi Hồ sơ Hệ thống', about: 'Tạo mới hoặc cập nhật bản ghi nghiệp vụ đúng tổ chức và quyền gọi.' },
      description: 'Create or update an allowed business record (tickets, orders, requests, P.A.R.A. docs) enforcing server organizationId and protected field stripping.',
      schema: {
        description: 'Validated business write action.',
        properties: {
          collection: { type: 'string', required: true, enum: [...WRITABLE_BUSINESS_COLLECTIONS] },
          operation: { type: 'string', required: true, enum: ['create', 'update'] },
          recordId: { type: 'integer' },
          values: { type: 'object', required: true },
        },
      },
      async run(ctx, db, actor, args) {
        const repo = db?.getRepository?.(args.collection);
        if (!repo) throw failTool('COLLECTION_NOT_FOUND', 404, `Collection "${args.collection}" chưa sẵn sàng.`);
        const safeValues = {};
        for (const [k, v] of Object.entries(args.values || {})) {
          if (!PROTECTED_SERVER_FIELDS.has(k)) safeValues[k] = v;
        }
        if (args.operation === 'create') {
          if (!actor.employeeId) throw failTool('EMPLOYEE_BINDING_REQUIRED', 403, 'Cần hồ sơ latticeEmployees để tạo bản ghi nghiệp vụ.');
          const created = await repo.create({
            values: {
              ...safeValues,
              organizationId: actor.organizationId,
              ...(args.collection === 'latticeParaDocuments' ? { ownerId: actor.employeeId, status: safeValues.status || 'published' } : { requesterId: actor.employeeId, status: 'draft', version: 1 }),
            },
          });
          const plain = typeof created?.toJSON === 'function' ? created.toJSON() : created;
          return { operation: 'create', collection: args.collection, record: plain };
        }
        if (args.recordId == null) throw failTool('RECORD_ID_REQUIRED', 400, 'Cần recordId để cập nhật.');
        const existing = await repo.findOne({ filterByTk: args.recordId });
        if (!existing || val(existing, 'organizationId') !== actor.organizationId) {
          throw failTool('RECORD_NOT_FOUND_OR_FORBIDDEN', 403, 'Không tìm thấy bản ghi trong phạm vi tổ chức của bạn.');
        }
        await existing.update(safeValues);
        return { operation: 'update', collection: args.collection, recordId: args.recordId, updatedFields: Object.keys(safeValues) };
      },
    }),

    createAuditedTool({
      name: 'dxos_my_tasks_copilot',
      adminOnly: false,
      defaultPermission: 'ASK',
      introduction: { title: 'Copilot Quy trình Dài', about: 'Đọc các manual task được giao cho chính bạn và hỗ trợ xử lý đúng thẩm quyền.' },
      description: 'List/analyze pending manual workflow tasks assigned to the current caller, or submit their own assigned task (never approves own requests or another user task).',
      schema: {
        description: 'Personal workflow task copilot operation.',
        properties: {
          action: { type: 'string', required: true, enum: ['list', 'analyze', 'submit'] },
          taskId: { type: 'integer' },
          formKey: { type: 'string', maxLength: 60 },
          decision: { type: 'string', maxLength: 40 },
          note: { type: 'string', maxLength: 500 },
        },
      },
      async run(ctx, db, actor, args) {
        const taskRepo = db?.getRepository?.('workflowManualTasks');
        if (!taskRepo) throw failTool('WORKFLOW_TASKS_UNAVAILABLE', 503, 'Dịch vụ workflowManualTasks chưa sẵn sàng.');
        if (args.action === 'list' || args.action === 'analyze') {
          const rows = (await taskRepo.find({ filter: { userId: actor.userId, status: 0 }, appends: ['node', 'execution'], limit: 20, sort: ['-id'] })) || [];
          return {
            userId: actor.userId,
            pendingCount: rows.length,
            tasks: rows.map((t) => ({
              taskId: val(t, 'id'),
              nodeTitle: val(val(t, 'node'), 'title') || null,
              recordCode: val(t, 'execution')?.context?.data?.code || null,
              status: val(t, 'status'),
            })),
          };
        }
        if (!args.taskId) throw failTool('TASK_ID_REQUIRED', 400, 'Cần taskId để nộp bước công việc.');
        const task = await taskRepo.findOne({ filterByTk: args.taskId, appends: ['node', 'execution'] });
        if (!task || Number(val(task, 'userId')) !== Number(actor.userId)) {
          throw failTool('TASK_NOT_ASSIGNED_TO_CALLER', 403, 'Chỉ người được giao task mới có quyền xử lý bước này.');
        }
        if (Number(val(task, 'status')) !== 0) {
          throw failTool('TASK_ALREADY_RESOLVED', 409, 'Công việc này đã được xử lý trước đó.');
        }
        const ctxData = val(task, 'execution')?.context?.data || {};
        const nodeTitle = String(val(val(task, 'node'), 'title') || '').toLowerCase();
        if (actor.employeeId && Number(ctxData.requesterId) === Number(actor.employeeId) && /duyệt|approve|review/i.test(nodeTitle)) {
          throw failTool('SELF_APPROVAL_FORBIDDEN', 403, 'Không được phép tự phê duyệt hồ sơ do chính mình khởi tạo.');
        }
        const formKey = args.formKey || 'review';
        const submitValues = { result: { [formKey]: args.note ? { note: args.note, deliveryNote: args.note, vehicleNote: args.note } : {}, _: args.decision || 'approve' } };
        await invokeResourceAction(ctx, 'workflowManualTasks', 'submit', { filterByTk: args.taskId, values: submitValues });
        return { submitted: true, taskId: args.taskId, formKey, decision: args.decision || 'approve' };
      },
    }),
  ];
}

function registerDxosToolsWithHost(appOrPlugin) {
  const toolsManager = appOrPlugin?.ai?.toolsManager || appOrPlugin?.app?.aiManager?.toolsManager || appOrPlugin?.toolsManager;
  if (!toolsManager || typeof toolsManager.registerTools !== 'function') return [];
  const tools = createDxosTools();
  toolsManager.registerTools(tools);
  return tools.map((t) => t.definition.name);
}

module.exports = {
  ADMIN_BUILDER_TOOL_NAMES,
  OPERATIONAL_TOOL_NAMES,
  WRITABLE_BUSINESS_COLLECTIONS,
  SYSTEM_PROTECTED_COLLECTIONS,
  val,
  failTool,
  isStudioAdmin,
  resolveActorScope,
  createAuditedTool,
  createDxosTools,
  registerDxosToolsWithHost,
};
