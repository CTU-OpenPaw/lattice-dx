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
const { createDxosTools, registerDxosToolsWithHost, val } = require('./ai-tools-core');
const { createItOtMcpTools } = require('./mcp-itot-tools');
const { createMcpGatewayMiddleware } = require('./mcp-gateway');
const { createDxosAiActions } = require('./ai-resource');

class DxosAiPlugin extends Plugin {
  async load() {
    registerDxosToolsWithHost(this);

    const mcpMiddleware = createMcpGatewayMiddleware({
      app: this.app,
      db: this.db,
      tools: createDxosTools(),
      itOtTools: createItOtMcpTools({ db: this.db }),
    });
    if (typeof this.app?.use === 'function') {
      this.app.use(mcpMiddleware, { tag: 'dxosMcpGateway', before: 'dataSource', after: 'dataWrapping' });
    } else if (typeof this.app?.resourceManager?.use === 'function') {
      this.app.resourceManager.use(mcpMiddleware, { tag: 'dxosMcpGateway' });
    }

    // Fail-closed guard against host PluginAIServer roles.afterCreate auto-granting new roles to Builder AIs
    if (typeof this.db?.on === 'function') {
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

    this.app.resourceManager.define({
      name: 'dxosAi',
      actions: createDxosAiActions(this.db),
    });
    this.app.acl.registerSnippet({
      name: 'pm.dxosAi',
      actions: ['dxosAi:*'],
    });
    this.app.acl.allow('dxosAi', 'portalCopilot', 'loggedIn');
  }
}

module.exports = DxosAiPlugin;
module.exports.default = DxosAiPlugin;
