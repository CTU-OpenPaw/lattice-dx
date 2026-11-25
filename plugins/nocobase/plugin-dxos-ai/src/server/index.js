/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { Plugin } = require('@nocobase/server');
const { ADMIN_BUILDER_TOOL_NAMES, createDxosTools, registerDxosToolsWithHost, isStudioAdmin, resolveActorScope, failTool, val } = require('./ai-tools-core');
const { validateMcpServerUrl } = require('./ai-schemas');
const { enforceProfileRoleLock, rebindStarterAgentsToService } = require('./ai-sync');
const { createItOtMcpTools } = require('./mcp-itot-tools');
const { createMcpGatewayMiddleware } = require('./mcp-gateway');
const { createAgentCardMiddleware, createA2aMiddleware } = require('./a2a-gateway');
const { createDxosAiActions, ensureDefaultAiWorkforce } = require('./ai-resource');
const { attachAppPubSub } = require('./surface-events');
const { startProactiveTriageScheduler } = require('./proactive-triage');
const { runWithSystemRlsBypass } = require('./ai-rls');

class DxosAiPlugin extends Plugin {
  async load() {
    if (typeof this.db?.collection === 'function') {
      for (const colPath of ['./collections/ai-memory', './collections/a2a-tasks']) {
        try {
          const colDef = require(colPath);
          if (colDef?.name && (!this.db.hasCollection || !this.db.hasCollection(colDef.name))) {
            this.db.collection(colDef);
          }
        } catch (err) {
          const missingSdk = err?.code === 'MODULE_NOT_FOUND'
            && String(err?.message || '').includes('@nocobase/database');
          if (!missingSdk) throw err;
        }
      }
    }

    registerDxosToolsWithHost(this);

    const mcpMiddleware = createMcpGatewayMiddleware({
      app: this.app,
      db: this.db,
      tools: createDxosTools(),
      itOtTools: createItOtMcpTools(this.db),
    });
    const agentCardMiddleware = createAgentCardMiddleware({ env: process.env });
    const a2aMiddleware = createA2aMiddleware({
      app: this.app,
      db: this.db,
      env: process.env,
    });
    if (typeof this.app?.use === 'function') {
      this.app.use(mcpMiddleware, { tag: 'dxosMcpGateway', before: 'dataSource', after: 'dataWrapping' });
      this.app.use(agentCardMiddleware, { tag: 'dxosA2aAgentCard', before: 'dataSource', after: 'dataWrapping' });
      this.app.use(a2aMiddleware, { tag: 'dxosA2aGateway', before: 'dataSource', after: 'dataWrapping' });
    } else if (typeof this.app?.resourceManager?.use === 'function') {
      this.app.resourceManager.use(mcpMiddleware, { tag: 'dxosMcpGateway' });
      this.app.resourceManager.use(agentCardMiddleware, { tag: 'dxosA2aAgentCard' });
      this.app.resourceManager.use(a2aMiddleware, { tag: 'dxosA2aGateway' });
    }

    if (typeof this.db?.on === 'function') {
      // Lock direct DB/REST mutations on latticeAiProfiles so Admin Builder tools cannot be assigned to non-admin roles and SSRF URLs are blocked.
      this.db.on('latticeAiProfiles.beforeValidate', async (profileInstance) => {
        if (!profileInstance || typeof profileInstance.get !== 'function' || typeof profileInstance.set !== 'function') return;
        const locked = enforceProfileRoleLock({
          isAdminBuilder: val(profileInstance, 'isAdminBuilder'),
          allowedRoles: val(profileInstance, 'allowedRoles'),
          toolPermissions: val(profileInstance, 'toolPermissions'),
        }, ADMIN_BUILDER_TOOL_NAMES);
        profileInstance.set('isAdminBuilder', locked.isAdminBuilder);
        profileInstance.set('allowedRoles', locked.allowedRoles);
        const servers = val(profileInstance, 'mcpServers');
        if (Array.isArray(servers)) {
          for (const srv of servers) {
            if (srv?.url) validateMcpServerUrl(srv.url);
          }
        }
      });

      // Fail-closed guard against host PluginAIServer roles.afterCreate auto-granting new roles to Builder AIs
      this.db.on('roles.afterCreate', async (roleInstance, { transaction } = {}) => {
        const roleName = String(val(roleInstance, 'name') || '').trim();
        if (!roleName || roleName === 'root' || roleName === 'admin') return;
        const profRepo = this.db?.getRepository?.('latticeAiProfiles');
        const joinRepo = this.db?.getRepository?.('rolesAiEmployees');
        if (!profRepo || !joinRepo || typeof joinRepo.destroy !== 'function') return;
        const builderRows = (await runWithSystemRlsBypass(this.db, () => profRepo.find({ filter: { isAdminBuilder: true } }))) || [];
        const builderNames = builderRows.map((p) => val(p, 'username')).filter(Boolean);
        if (builderNames.length) {
          await joinRepo.destroy({ filter: { aiEmployee: { $in: builderNames }, roleName }, transaction });
        }
      });

      this.db.on('llmServices.afterSave', async (serviceInstance) => {
        if (this._rebindingLlmServices || !serviceInstance) return;
        if (val(serviceInstance, 'enabled') === false) return;
        const serviceName = String(val(serviceInstance, 'name') || '').trim();
        if (!serviceName) return;
        if (!this.db?.getRepository) return;
        if (!this.db.getRepository('latticeAiProfiles') && !this.db.getRepository('aiEmployees')) return;

        let enabledModels = val(serviceInstance, 'enabledModels');
        if (typeof enabledModels === 'string' && enabledModels.trim().startsWith('{')) {
          try { enabledModels = JSON.parse(enabledModels); } catch { enabledModels = null; }
        }
        const modelList = Array.isArray(enabledModels?.models)
          ? enabledModels.models
          : (Array.isArray(enabledModels) ? enabledModels : []);
        const firstModel = modelList[0];
        const opts = val(serviceInstance, 'options');
        const modelName = String(
          (typeof firstModel === 'string' ? firstModel : (firstModel?.value || firstModel?.model || firstModel?.name))
          || (opts && typeof opts === 'object' ? (opts.model || opts.modelName) : '')
          || '',
        ).trim();

        this._rebindingLlmServices = true;
        try {
          await rebindStarterAgentsToService(this.db, {
            llmService: serviceName,
            modelName,
            defaultOrigin: process.env.NOCOBASE_INTERNAL_URL || '',
            preserveActiveArchitect: true,
            adminToolNames: ADMIN_BUILDER_TOOL_NAMES,
          });
        } catch (err) {
          const msg = String(err?.message || '');
          const code = err?.original?.code || err?.parent?.code || err?.code || '';
          if (code !== '42P01' && !/does not exist|no such table/i.test(msg)) {
            throw err;
          }
        } finally {
          this._rebindingLlmServices = false;
        }
      });
    }

    if (typeof this.app?.resourceManager?.use === 'function') {
      const extractChartQueryCollections = (ctx) => {
        const fullResource = String(ctx.action?.resourceName || '');
        const resourceParts = fullResource.split('.').map((s) => s.trim().toLowerCase()).filter(Boolean);
        const actionName = String(ctx.action?.actionName || '').trim().toLowerCase();
        if (!resourceParts.includes('charts') || actionName !== 'querydata') {
          return new Set();
        }
        const containers = [
          ctx.action?.params?.values,
          ctx.action?.params,
          ctx.request?.body?.values,
          ctx.request?.body,
          ctx.query,
        ];
        const candidates = new Set();
        const addValue = (rawVal) => {
          if (rawVal === undefined || rawVal === null) return;
          if (Array.isArray(rawVal)) {
            for (const item of rawVal) addValue(item);
            return;
          }
          if (typeof rawVal === 'object') return;
          const trimmed = String(rawVal).trim();
          if (!trimmed) return;
          const parts = trimmed.split('.').map((p) => p.trim().toLowerCase()).filter(Boolean);
          candidates.add(trimmed.toLowerCase());
          for (const part of parts) candidates.add(part);
        };
        for (const obj of containers) {
          if (!obj || typeof obj !== 'object') continue;
          for (const key of ['collection', 'collectionName', 'table']) {
            if (obj[key] !== undefined && obj[key] !== null) {
              addValue(obj[key]);
            }
          }
        }
        return candidates;
      };

      this.app.resourceManager.use(async (ctx, next) => {
        if (ctx.state?.currentRole === 'root') return next();
        const fullResource = String(ctx.action?.resourceName || '');
        const resourceParts = fullResource.split('.').map((s) => s.trim().toLowerCase()).filter(Boolean);
        const chartCollections = extractChartQueryCollections(ctx);
        const isDirectProfileResource = resourceParts.includes('latticeaiprofiles');
        const isChartProfileQuery = chartCollections.has('latticeaiprofiles');
        if (!isDirectProfileResource && !isChartProfileQuery) return next();
        const adminOk = await isStudioAdmin(ctx, this.db);
        if (!adminOk) throw failTool('DXOS_ADMIN_REQUIRED', 403, 'Chỉ Quản trị viên mới được truy cập cấu hình nhân sự AI.');
        const actor = await resolveActorScope(ctx, this.db);
        if (isDirectProfileResource && ctx.action?.params) {
          ctx.action.params.filter = { $and: [{ organizationId: actor.organizationId }, ctx.action.params.filter ?? {}] };
          if (ctx.action.params.values && typeof ctx.action.params.values === 'object') {
            if (ctx.action.params.values.organizationId && ctx.action.params.values.organizationId !== actor.organizationId) {
              throw failTool('DXOS_ORG_MISMATCH', 403, 'Không được phép chỉnh sửa nhân sự AI của tổ chức khác.');
            }
            ctx.action.params.values = { ...ctx.action.params.values, organizationId: actor.organizationId };
          }
        }
        return next();
      }, { tag: 'dxosAiProfileScope', after: 'acl', before: 'latticeNativeScope' });

      this.app.resourceManager.use(async (ctx, next) => {
        if (ctx.state?.currentRole === 'root') return next();
        const fullResource = String(ctx.action?.resourceName || '');
        const resourceParts = fullResource.split('.').map((s) => s.trim().toLowerCase()).filter(Boolean);
        const chartCollections = extractChartQueryCollections(ctx);
        if (
          resourceParts.includes('latticeaiapprovalqueue')
          || chartCollections.has('latticeaiapprovalqueue')
        ) {
          throw failTool('DXOS_HITL_DIRECT_CRUD_FORBIDDEN', 403, 'Vui lòng sử dụng API phê duyệt HITL chuyên dụng (dxosAi:listApprovals / approveAction / rejectAction).');
        }
        return next();
      }, { tag: 'dxosAiHitlScope', after: 'acl', before: 'latticeNativeScope' });

      this.app.resourceManager.use(async (ctx, next) => {
        if (ctx.state?.currentRole === 'root') return next();
        const fullResource = String(ctx.action?.resourceName || '');
        const resourceParts = fullResource.split('.').map((s) => s.trim().toLowerCase()).filter(Boolean);
        const chartCollections = extractChartQueryCollections(ctx);
        if (resourceParts.includes('latticeaimemory') || chartCollections.has('latticeaimemory')) {
          throw failTool('DXOS_MEMORY_DIRECT_CRUD_FORBIDDEN', 403, 'Vui lòng sử dụng API bộ nhớ AI chuyên dụng (dxosAi:listMemories / recallMemories / rememberFact / forgetMemory).');
        }
        if (resourceParts.includes('latticea2atasks') || chartCollections.has('latticea2atasks')) {
          throw failTool('DXOS_A2A_DIRECT_CRUD_FORBIDDEN', 403, 'Vui lòng sử dụng giao thức A2A chuyên dụng (/api/dxos-a2a).');
        }
        if (resourceParts.includes('latticeaitraces') || chartCollections.has('latticeaitraces')) {
          throw failTool('DXOS_TRACES_DIRECT_CRUD_FORBIDDEN', 403, 'Vui lòng sử dụng API truy vết AI chuyên dụng (dxosAi:listAgentTraces / getAgentTraceDetail).');
        }
        return next();
      }, { tag: 'dxosAiMemoryAndA2aScope', after: 'acl', before: 'latticeNativeScope' });
    }

    attachAppPubSub(this.app);
    this.app.resourceManager.define({
      name: 'dxosAi',
      actions: createDxosAiActions(this.db),
    });
    this.app.acl.registerSnippet({
      name: 'pm.dxosAi',
      actions: ['dxosAi:*'],
    });
    this.app.acl.allow('dxosAi', 'portalAgents', 'loggedIn');
    this.app.acl.allow('dxosAi', 'checkLlmHealth', 'loggedIn');
    this.app.acl.allow('dxosAi', 'pageSurfaceState', 'loggedIn');
    this.app.acl.allow('dxosAi', 'surfaceEvents', 'loggedIn');
    this.app.acl.allow('dxosAi', 'listApprovals', 'loggedIn');
    this.app.acl.allow('dxosAi', 'approveAction', 'loggedIn');
    this.app.acl.allow('dxosAi', 'rejectAction', 'loggedIn');
    this.app.acl.allow('dxosAi', 'triageScan', 'loggedIn');
    this.app.acl.allow('dxosAi', 'listMemories', 'loggedIn');
    this.app.acl.allow('dxosAi', 'recallMemories', 'loggedIn');

    this._triageScheduler = startProactiveTriageScheduler(this.db, { env: process.env });
  }

  async install() {
    await ensureDefaultAiWorkforce(this.db, { env: process.env, forceUpdate: false });
  }

  async afterEnable() {
    await ensureDefaultAiWorkforce(this.db, { env: process.env, forceUpdate: false });
  }

  async unload() {
    this._triageScheduler?.stop?.();
    this._triageScheduler = null;
  }
}

module.exports = DxosAiPlugin;
module.exports.default = DxosAiPlugin;
