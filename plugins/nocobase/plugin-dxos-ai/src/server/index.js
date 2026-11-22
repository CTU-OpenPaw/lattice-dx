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
const { enforceProfileRoleLock } = require('./ai-sync');
const { createItOtMcpTools } = require('./mcp-itot-tools');
const { createMcpGatewayMiddleware } = require('./mcp-gateway');
const { createDxosAiActions } = require('./ai-resource');
const { attachAppPubSub } = require('./surface-events');

class DxosAiPlugin extends Plugin {
  async load() {
    registerDxosToolsWithHost(this);

    const mcpMiddleware = createMcpGatewayMiddleware({
      app: this.app,
      db: this.db,
      tools: createDxosTools(),
      itOtTools: createItOtMcpTools(this.db),
    });
    if (typeof this.app?.use === 'function') {
      this.app.use(mcpMiddleware, { tag: 'dxosMcpGateway', before: 'dataSource', after: 'dataWrapping' });
    } else if (typeof this.app?.resourceManager?.use === 'function') {
      this.app.resourceManager.use(mcpMiddleware, { tag: 'dxosMcpGateway' });
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
        const builderRows = (await profRepo.find({ filter: { isAdminBuilder: true }, transaction })) || [];
        const builderNames = builderRows.map((p) => val(p, 'username')).filter(Boolean);
        if (builderNames.length) {
          await joinRepo.destroy({ filter: { aiEmployee: { $in: builderNames }, roleName }, transaction });
        }
      });
    }

    if (typeof this.app?.resourceManager?.use === 'function') {
      this.app.resourceManager.use(async (ctx, next) => {
        const resName = String(ctx.action?.resourceName || '').split('.')[0];
        if (resName !== 'latticeAiProfiles' || ctx.state?.currentRole === 'root') return next();
        const adminOk = await isStudioAdmin(ctx, this.db);
        if (!adminOk) throw failTool('DXOS_ADMIN_REQUIRED', 403, 'Chỉ Quản trị viên mới được truy cập cấu hình nhân sự AI.');
        const actor = await resolveActorScope(ctx, this.db);
        if (ctx.action?.params) {
          ctx.action.params.filter = { $and: [{ organizationId: actor.organizationId }, ctx.action.params.filter ?? {}] };
          if (ctx.action.params.values && typeof ctx.action.params.values === 'object') {
            if (ctx.action.params.values.organizationId && ctx.action.params.values.organizationId !== actor.organizationId) {
              throw failTool('DXOS_ORG_MISMATCH', 403, 'Không được phép chỉnh sửa nhân sự AI của tổ chức khác.');
            }
            ctx.action.params.values = { ...ctx.action.params.values, organizationId: actor.organizationId };
          }
        }
        return next();
      }, { tag: 'dxosAiProfileScope', after: 'acl' });
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
    this.app.acl.allow('dxosAi', 'portalCopilot', 'loggedIn');
    this.app.acl.allow('dxosAi', 'pageSurfaceState', 'loggedIn');
    this.app.acl.allow('dxosAi', 'surfaceEvents', 'loggedIn');
  }
}

module.exports = DxosAiPlugin;
module.exports.default = DxosAiPlugin;
