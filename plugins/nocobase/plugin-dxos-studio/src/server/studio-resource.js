/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { listWorkflowTemplates, buildWorkflowTemplate } = require('./workflow-templates');
const { composePortals } = require('./portal-composer');
const {
  exportSolutionBundle,
  diffSolutionBundle,
  importSolutionBundle,
  validateSolutionBundle,
  rollbackLastSolutionBundle,
} = require('./solution-bundle');

const DXOS_PLUGINS_CATALOG = [
  { packageName: '@latticedx/plugin-action-bridge', title: 'Action Bridge', spaces: ['[P]', '[H]'] },
  { packageName: '@latticedx/plugin-lattice-foundation', title: 'LatticeDX Foundation & Multi-Portal', spaces: ['[H]', '[P]', '[D]', '[I]'] },
  { packageName: '@latticedx/plugin-enterprise-auth', title: 'Enterprise SSO (Keycloak OIDC)', spaces: ['[H]'] },
  { packageName: '@latticedx/plugin-dxos-para', title: 'P.A.R.A. Knowledge Vault', spaces: ['[H]'] },
  { packageName: '@latticedx/plugin-dxos-blocks', title: 'DX-OS Configurable Native Blocks', spaces: ['[H]', '[P]', '[D]', '[I]'] },
  { packageName: '@latticedx/plugin-dxos-studio', title: 'DX-OS Admin Control Studio', spaces: ['[P]', '[H]', '[D]'] },
  { packageName: '@latticedx/plugin-dxos-ai', title: 'AI Workforce & 2-Way Enterprise MCP', spaces: ['[I]', '[P]', '[D]', '[H]'] },
];

const val = (row, key) => (typeof row?.get === 'function' ? row.get(key) : row?.[key]);

function fail(code, status = 403, message = code) {
  return Object.assign(new Error(message), { code, status });
}

function readParams(ctx) {
  const p = ctx.action?.params || {};
  const v = p.values && typeof p.values === 'object' && !Array.isArray(p.values) ? p.values : {};
  return { ...p, ...v };
}

async function isStudioAdmin(ctx, db) {
  if (!ctx?.state?.currentUser) return false;
  const roleNames = Array.isArray(ctx.state.currentRoles) && ctx.state.currentRoles.length
    ? ctx.state.currentRoles
    : ctx.state.currentRole ? [ctx.state.currentRole] : [];
  if (roleNames.includes('root')) return true;
  const rolesRepo = db?.getRepository?.('roles');
  if (!rolesRepo || !roleNames.length) return false;
  const matched = (await rolesRepo.find({ filter: { name: { $in: roleNames } } })) || [];
  return matched.some((r) => {
    if (val(r, 'allowConfigure') === true) return true;
    const snippets = val(r, 'snippets');
    return Array.isArray(snippets) && (snippets.includes('pm') || snippets.includes('pm.*'));
  });
}

function createDefaultApplyBlueprint(ctx) {
  return async (doc) => {
    const flowSurfaces = ctx?.app?.resourceManager?.getResource?.('flowSurfaces');
    const handler = flowSurfaces?.actions?.get?.('applyBlueprint')?.handler || flowSurfaces?.actions?.applyBlueprint;
    if (typeof handler !== 'function') {
      throw fail('FLOW_SURFACES_UNAVAILABLE', 503, 'Dịch vụ flowSurfaces:applyBlueprint chưa sẵn sàng.');
    }
    const subCtx = {
      app: ctx.app,
      db: ctx.db,
      state: {
        currentUser: ctx.state?.currentUser,
        currentRole: ctx.state?.currentRole,
        currentRoles: ctx.state?.currentRoles || [ctx.state?.currentRole || 'root'],
      },
      getCurrentLocale: ctx.getCurrentLocale?.bind(ctx),
      i18n: ctx.i18n,
      action: { actionName: 'applyBlueprint', params: { values: doc } },
      request: { headers: {} },
      body: null,
      throw: (s, m) => { throw fail('BLUEPRINT_ERROR', s, m); },
    };
    await handler(subCtx, async () => {});
    if ((subCtx.status && subCtx.status >= 400) || (Array.isArray(subCtx.body?.errors) && subCtx.body.errors.length)) {
      const msg = subCtx.body?.errors?.[0]?.message || `flowSurfaces:applyBlueprint failed (${subCtx.status || 400})`;
      throw fail('BLUEPRINT_ERROR', subCtx.status || 400, msg);
    }
    return subCtx.body?.data || subCtx.body || {};
  };
}

function buildPluginStatusList(rows) {
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const pkg = val(row, 'packageName') || val(row, 'name');
    if (pkg) map.set(pkg, row);
  }
  return DXOS_PLUGINS_CATALOG.map((item) => {
    const row = map.get(item.packageName);
    return {
      ...item,
      license: 'Apache-2.0',
      sdkProvidedByHost: true,
      installed: Boolean(row),
      enabled: val(row, 'enabled') === true,
      version: val(row, 'version') || '0.1.0',
    };
  });
}

function createDxosStudioActions(db, { applyBlueprint } = {}) {
  async function requireAdmin(ctx) {
    if (!ctx?.state?.currentUser) throw fail('NATIVE_LOGIN_REQUIRED', 401);
    if (!(await isStudioAdmin(ctx, db))) throw fail('DXOS_ADMIN_REQUIRED', 403, 'Chỉ quản trị viên mới truy cập được DX-OS Studio.');
  }

  function parseIncomingBundle(raw) {
    try {
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      throw fail('INVALID_SOLUTION_BUNDLE', 400, 'Invalid Solution Bundle JSON');
    }
  }

  return {
    listTemplates: async (ctx, next) => {
      if ((ctx.method || 'GET') !== 'GET') throw fail('METHOD_NOT_ALLOWED', 405);
      await requireAdmin(ctx);
      ctx.body = { items: listWorkflowTemplates() };
      return next();
    },

    listEmployees: async (ctx, next) => {
      if ((ctx.method || 'GET') !== 'GET') throw fail('METHOD_NOT_ALLOWED', 405);
      await requireAdmin(ctx);
      const input = readParams(ctx);
      const filter = { active: true, ...(input.organizationId ? { organizationId: String(input.organizationId).trim() } : {}) };
      const empRepo = db.getRepository('latticeEmployees');
      const rows = empRepo ? await empRepo.find({ filter, appends: ['user', 'user.roles'], limit: 200, sort: ['id'] }) : [];
      const items = (Array.isArray(rows) ? rows : []).map((row) => {
        const user = val(row, 'user');
        const roles = Array.isArray(val(user, 'roles')) ? val(user, 'roles').map((r) => val(r, 'name')).filter(Boolean) : [];
        return {
          id: val(row, 'id'),
          code: val(row, 'code'),
          name: val(row, 'name'),
          email: val(row, 'email'),
          organizationId: val(row, 'organizationId'),
          userId: val(row, 'userId'),
          roles,
        };
      });
      const counts = {};
      for (const item of items) {
        if (item.organizationId) counts[item.organizationId] = (counts[item.organizationId] || 0) + 1;
      }
      const organizations = Object.keys(counts).sort((a, b) => (counts[b] - counts[a]) || a.localeCompare(b));
      ctx.body = { items, organizations, organizationCounts: counts };
      return next();
    },

    installWorkflow: async (ctx, next) => {
      if ((ctx.method || 'POST') !== 'POST') throw fail('METHOD_NOT_ALLOWED', 405);
      await requireAdmin(ctx);
      const input = readParams(ctx);
      const templateKey = String(input.templateKey || '').trim();
      const built = buildWorkflowTemplate(templateKey, input);
      const organizationId = built.workflow.options.dxosOrganizationId;

      // Validate referenced employees belong to the same organization and are active.
      const tmplSpec = listWorkflowTemplates().find((t) => t.key === templateKey);
      const empRepo = db.getRepository('latticeEmployees');
      if (empRepo && tmplSpec) {
        const emps = await empRepo.find({ filter: { organizationId, active: true }, appends: ['user', 'user.roles'], limit: 200 });
        const byId = new Map((Array.isArray(emps) ? emps : []).map((e) => [String(val(e, 'id')), e]));
        for (const binding of tmplSpec.requiredBindings) {
          const id = String(input[binding.field] ?? '');
          const emp = byId.get(id);
          if (!emp) throw fail('DXOS_EMPLOYEE_INVALID', 400, `Nhân sự ${binding.label} (#${id}) không thuộc tổ chức ${organizationId} hoặc chưa kích hoạt.`);
          const user = val(emp, 'user');
          const roles = Array.isArray(val(user, 'roles')) ? val(user, 'roles').map((r) => val(r, 'name')) : [];
          if (roles.length && !roles.some((r) => binding.allowedRoles.includes(r))) {
            throw fail('DXOS_EMPLOYEE_ROLE_MISMATCH', 400, `Nhân sự #${id} thiếu vai trò phù hợp (${binding.allowedRoles.join(', ')}).`);
          }
        }
      }

      const wfRepo = db.getRepository('workflows');
      const nodeRepo = db.getRepository('flow_nodes');
      if (!wfRepo || !nodeRepo) throw fail('WORKFLOW_ENGINE_UNAVAILABLE', 503);

      const existing = await wfRepo.findOne({
        filter: { 'options.dxosTemplateKey': templateKey, 'options.dxosOrganizationId': organizationId, current: true },
      });
      if (existing && !input.replace) {
        const wfId = val(existing, 'id');
        ctx.body = {
          alreadyExists: true,
          workflowId: wfId,
          key: val(existing, 'key'),
          title: val(existing, 'title'),
          enabled: val(existing, 'enabled'),
          designerUrl: `/admin/settings/workflow/workflows/${wfId}`,
        };
        return next();
      }

      const enableOnCreate = input.enabled === true;
      const result = await db.sequelize.transaction(async (transaction) => {
        const workflow = await wfRepo.create({
          values: { ...built.workflow, enabled: enableOnCreate },
          transaction,
        });
        const workflowId = val(workflow, 'id');
        const createdMap = new Map();
        for (const { upstreamKey, ...nodeSpec } of built.nodes) {
          const upstreamNode = upstreamKey ? createdMap.get(upstreamKey) : null;
          const upstreamId = upstreamNode ? val(upstreamNode, 'id') : null;
          const created = await nodeRepo.create({
            values: {
              ...nodeSpec,
              workflowId,
              ...(upstreamId ? { upstreamId } : {}),
            },
            transaction,
          });
          if (upstreamNode && nodeSpec.branchIndex == null && typeof upstreamNode.update === 'function') {
            await upstreamNode.update({ downstreamId: val(created, 'id') }, { transaction });
          }
          createdMap.set(nodeSpec.key, created);
        }
        return {
          alreadyExists: false,
          workflowId,
          key: val(workflow, 'key'),
          title: val(workflow, 'title'),
          enabled: enableOnCreate,
          nodeCount: createdMap.size,
          designerUrl: `/admin/settings/workflow/workflows/${workflowId}`,
        };
      });

      ctx.body = result;
      return next();
    },

    composePortals: async (ctx, next) => {
      if ((ctx.method || 'POST') !== 'POST') throw fail('METHOD_NOT_ALLOWED', 405);
      await requireAdmin(ctx);
      const bp = applyBlueprint || createDefaultApplyBlueprint(ctx);
      ctx.body = await composePortals(db, { applyBlueprint: bp });
      return next();
    },

    pluginStatus: async (ctx, next) => {
      if ((ctx.method || 'GET') !== 'GET') throw fail('METHOD_NOT_ALLOWED', 405);
      await requireAdmin(ctx);
      const rows = (await db.getRepository('applicationPlugins')?.find({})) || [];
      ctx.body = { items: buildPluginStatusList(rows) };
      return next();
    },

    readiness: async (ctx, next) => {
      if ((ctx.method || 'GET') !== 'GET') throw fail('METHOD_NOT_ALLOWED', 405);
      await requireAdmin(ctx);
      const safeCount = async (repoName, filter = {}) => {
        if (typeof db.hasCollection === 'function' && !db.hasCollection(repoName)) return 0;
        const repo = db.getRepository(repoName);
        if (!repo || typeof repo.count !== 'function') return 0;
        try { return await repo.count({ filter }); } catch { return 0; }
      };
      const pluginRows = (await db.getRepository('applicationPlugins')?.find({})) || [];
      const portalRows = (await db.getRepository('uiLayouts')?.find({})) || [];
      const customPortals = portalRows.filter((p) => String(val(p, 'uid') || '').startsWith('ldx-portal-'));
      const hostVersion = String(process.env.NOCOBASE_VERSION || db?.app?.version || ctx?.app?.version || '2.2.50').trim().replace(/^v/i, '') || '2.2.50';
      ctx.body = {
        portalCount: customPortals.length,
        workflowCount: await safeCount('workflows', { current: true }),
        paraDocumentCount: await safeCount('latticeParaDocuments', {}),
        serviceTicketCount: await safeCount('latticeServiceTickets', {}),
        aiProfileCount: await safeCount('latticeAiProfiles', { enabled: true }),
        aiAuditCount: await safeCount('latticeAiAuditLogs', {}),
        clause52Attribution: `Powered by NocoBase (v${hostVersion} preserved)`,
        plugins: buildPluginStatusList(pluginRows),
      };
      return next();
    },

    outboxDlqList: async (ctx, next) => {
      if ((ctx.method || 'GET') !== 'GET') throw fail('METHOD_NOT_ALLOWED', 405);
      await requireAdmin(ctx);
      const params = readParams(ctx);
      const stateFilter = params.state ? String(params.state).trim() : 'failed';
      const orgFilter = params.organizationId ? String(params.organizationId).trim() : '';
      const page = Math.max(1, Number(params.page) || 1);
      const pageSize = Math.max(1, Math.min(100, Number(params.pageSize) || 50));
      const repo = db.getRepository?.('latticeContextOutbox');
      if (!repo) {
        ctx.body = { items: [], total: 0, summary: { pending: 0, retry: 0, processing: 0, failed: 0, delivered: 0 } };
        return next();
      }
      const filter = { state: stateFilter, ...(orgFilter ? { organizationId: orgFilter } : {}) };
      let rows = [];
      let total = 0;
      if (typeof repo.findAndCount === 'function') {
        const res = await repo.findAndCount({ filter, sort: ['-id'], offset: (page - 1) * pageSize, limit: pageSize });
        rows = Array.isArray(res?.[0]) ? res[0] : [];
        total = Number(res?.[1] ?? rows.length);
      } else if (typeof repo.find === 'function') {
        rows = (await repo.find({ filter, sort: ['-id'], offset: (page - 1) * pageSize, limit: pageSize })) || [];
        total = typeof repo.count === 'function' ? await repo.count({ filter }) : rows.length;
      }
      const summary = { pending: 0, retry: 0, processing: 0, failed: 0, delivered: 0 };
      if (typeof repo.count === 'function') {
        for (const s of Object.keys(summary)) {
          summary[s] = await repo.count({ filter: { state: s, ...(orgFilter ? { organizationId: orgFilter } : {}) } });
        }
      } else if (typeof repo.find === 'function') {
        const all = (await repo.find({ filter: orgFilter ? { organizationId: orgFilter } : {}, limit: 1000 })) || [];
        for (const r of all) {
          const st = val(r, 'state');
          if (Object.prototype.hasOwnProperty.call(summary, st)) summary[st] += 1;
        }
      }
      ctx.body = {
        items: rows.map((r) => ({
          id: val(r, 'id'),
          eventId: val(r, 'eventId'),
          entityId: val(r, 'entityId'),
          organizationId: val(r, 'organizationId'),
          collectionName: val(r, 'collectionName'),
          recordId: val(r, 'recordId'),
          state: val(r, 'state'),
          attempts: val(r, 'attempts'),
          errorCode: val(r, 'errorCode'),
          nextAttemptAt: val(r, 'nextAttemptAt'),
          lockedAt: val(r, 'lockedAt'),
          updatedAt: val(r, 'updatedAt'),
        })),
        total,
        page,
        pageSize,
        summary,
      };
      return next();
    },

    outboxDlqReplay: async (ctx, next) => {
      if ((ctx.method || 'POST') !== 'POST') throw fail('METHOD_NOT_ALLOWED', 405);
      await requireAdmin(ctx);
      const params = readParams(ctx);
      const orgFilter = params.organizationId ? String(params.organizationId).trim() : '';
      const rawIds = Array.isArray(params.eventIds) ? params.eventIds : params.eventId ? [params.eventId] : [];
      const eventIds = rawIds.map((x) => String(x || '').trim()).filter(Boolean);
      const limit = Math.max(1, Math.min(500, Number(params.limit) || 100));
      const model = db.getModel?.('latticeContextOutbox');
      const repo = db.getRepository?.('latticeContextOutbox');
      const where = { state: 'failed' };
      if (orgFilter) where.organizationId = orgFilter;
      if (eventIds.length) where.eventId = eventIds;
      let rows = [];
      if (model && typeof model.findAll === 'function') {
        rows = (await model.findAll({ where, limit })) || [];
      } else if (repo && typeof repo.find === 'function') {
        const filter = { state: 'failed', ...(orgFilter ? { organizationId: orgFilter } : {}), ...(eventIds.length ? { eventId: { $in: eventIds } } : {}) };
        rows = (await repo.find({ filter, limit })) || [];
      }
      const replayedIds = [];
      for (const row of rows) {
        const eid = val(row, 'eventId');
        if (typeof row.update === 'function') {
          await row.update({ state: 'pending', attempts: 0, errorCode: null, nextAttemptAt: null, lockedAt: null });
        } else if (repo && typeof repo.update === 'function' && eid) {
          await repo.update({ filter: { eventId: eid }, values: { state: 'pending', attempts: 0, errorCode: null, nextAttemptAt: null, lockedAt: null } });
        }
        if (eid) replayedIds.push(eid);
      }
      ctx.body = { replayedCount: replayedIds.length, eventIds: replayedIds };
      return next();
    },

    solutionBundleExport: async (ctx, next) => {
      if (!['GET', 'POST'].includes(ctx.method || 'GET')) throw fail('METHOD_NOT_ALLOWED', 405);
      await requireAdmin(ctx);
      const params = readParams(ctx);
      const organizationId = params.organizationId ? String(params.organizationId).trim() : null;
      ctx.body = await exportSolutionBundle(db, { organizationId, platformVersion: '0.3.0' });
      return next();
    },

    solutionBundleDiff: async (ctx, next) => {
      if ((ctx.method || 'POST') !== 'POST') throw fail('METHOD_NOT_ALLOWED', 405);
      await requireAdmin(ctx);
      const params = readParams(ctx);
      const incoming = parseIncomingBundle(params.bundle);
      const validation = validateSolutionBundle(incoming);
      if (!validation.valid) throw fail('INVALID_SOLUTION_BUNDLE', 400, validation.errors.join('; '));
      const organizationId = params.organizationId ? String(params.organizationId).trim() : (incoming.metadata?.organizationId !== 'all' ? incoming.metadata?.organizationId : null);
      const current = await exportSolutionBundle(db, { organizationId });
      ctx.body = diffSolutionBundle(current, incoming);
      return next();
    },

    solutionBundleImport: async (ctx, next) => {
      if ((ctx.method || 'POST') !== 'POST') throw fail('METHOD_NOT_ALLOWED', 405);
      await requireAdmin(ctx);
      const params = readParams(ctx);
      const incoming = parseIncomingBundle(params.bundle);
      const organizationId = params.organizationId ? String(params.organizationId).trim() : null;
      const dryRun = params.dryRun === false ? false : true;
      const enableWorkflows = typeof params.enableWorkflows === 'string'
        ? params.enableWorkflows === 'true'
        : Boolean(params.enableWorkflows);
      ctx.body = await importSolutionBundle(db, incoming, { dryRun, organizationId, enableWorkflows });
      return next();
    },

    solutionBundleRollback: async (ctx, next) => {
      if ((ctx.method || 'POST') !== 'POST') throw fail('METHOD_NOT_ALLOWED', 405);
      await requireAdmin(ctx);
      const params = readParams(ctx);
      const organizationId = params.organizationId ? String(params.organizationId).trim() : null;
      const snapshotUid = params.snapshotUid ? String(params.snapshotUid).trim() : '';
      ctx.body = await rollbackLastSolutionBundle(db, { organizationId, snapshotUid });
      return next();
    },
  };
}

module.exports = { DXOS_PLUGINS_CATALOG, isStudioAdmin, createDefaultApplyBlueprint, createDxosStudioActions };
