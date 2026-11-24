/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { aiProfiles, validateMcpServerUrl, normalizeToolPermissionsMap } = require('./ai-schemas');

const ALL_LDX_ROLES = ['ldx_employee', 'ldx_manager', 'ldx_warehouse', 'ldx_dispatcher', 'ldx_driver', 'ldx_director', 'ldx_admin'];
const DEFAULT_ADMIN_ROLES = ['root', 'admin'];
const DEFAULT_SKILLS = ['data-metadata', 'data-query'];
const SUB_AGENT_TOOLS = ['dispatch-sub-agent-task', 'list-ai-employees', 'get-ai-employee'];
const val = (row, key) => (typeof row?.get === 'function' ? row.get(key) : row?.[key]);

function enforceProfileRoleLock(profile = {}, adminToolNames = []) {
  const adminSet = new Set(adminToolNames);
  const rawPerms = profile.toolPermissions !== undefined ? profile.toolPermissions : profile.toolPermissionsJson;
  const perms = normalizeToolPermissionsMap(rawPerms);
  const grantsBuilderTool = Object.entries(perms).some(([name, mode]) => adminSet.has(name) && (mode === 'ALLOW' || mode === 'ASK'));
  const isAdminBuilder = Boolean(profile.isAdminBuilder) || grantsBuilderTool;
  const rawRoles = Array.isArray(profile.allowedRoles) ? profile.allowedRoles.filter(Boolean) : [];
  const next = {
    ...profile,
    ...(rawPerms !== undefined ? { toolPermissions: perms } : {}),
    isAdminBuilder,
    // Fail-closed: host plugin-ai isBuilderAI only locks nathan/orin/dara, so we force admin-only roles whenever Builder tools are enabled.
    allowedRoles: isAdminBuilder ? [...DEFAULT_ADMIN_ROLES] : rawRoles.length ? [...new Set(rawRoles)] : ['ldx_employee', 'ldx_manager'],
  };
  delete next.toolPermissionsJson;
  return next;
}

function resolveLoopbackOrigin(rawOrigin) {
  try {
    const parsed = new URL(rawOrigin || process.env.NOCOBASE_INTERNAL_URL || 'http://127.0.0.1:13000');
    const host = parsed.hostname.toLowerCase();
    if (['127.0.0.1', 'localhost', '::1', '[::1]', 'host.docker.internal', 'nocobase'].includes(host)) {
      return parsed.origin;
    }
    return 'http://127.0.0.1:13000';
  } catch {
    return 'http://127.0.0.1:13000';
  }
}

async function replaceEmployeeRoleBindings(db, username, allowedRoles, transaction) {
  const joinRepo = db.getRepository('rolesAiEmployees');
  if (joinRepo && typeof joinRepo.destroy === 'function' && typeof joinRepo.create === 'function') {
    await joinRepo.destroy({ filter: { aiEmployee: username }, transaction });
    for (const roleName of allowedRoles) {
      await joinRepo.create({ values: { aiEmployee: username, roleName }, transaction });
    }
    return;
  }
  const rolesAssoc = db.getRepository?.('aiEmployees.roles', username);
  if (rolesAssoc && typeof rolesAssoc.set === 'function') {
    await rolesAssoc.set(allowedRoles, { transaction });
  }
}

async function syncMcpClients(db, servers, { defaultOrigin, transaction } = {}) {
  const mcpRepo = db.getRepository?.('aiMcpClients');
  if (!mcpRepo || !Array.isArray(servers) || !servers.length) return [];
  const origin = resolveLoopbackOrigin(defaultOrigin);
  const synced = [];
  for (const srv of servers) {
    if (!srv?.name) continue;
    let url = String(srv.url || '').trim();
    if (url.startsWith('http://127.0.0.1:13000') && origin !== 'http://127.0.0.1:13000') {
      url = `${origin}${url.slice('http://127.0.0.1:13000'.length)}`;
    }
    validateMcpServerUrl(url);
    const useUserContext = srv.useUserContext !== false;
    const payload = {
      name: srv.name,
      title: srv.title || srv.name,
      description: srv.description || `LatticeDX MCP connector (${srv.name})`,
      enabled: srv.enabled !== false,
      transport: 'http',
      useUserContext,
      url,
      headers: useUserContext ? { Authorization: 'Bearer {{request.token}}' } : {},
      args: [],
      env: {},
      restart: {},
    };
    const existing = await mcpRepo.findOne({ filter: { name: srv.name }, transaction });
    if (existing && typeof existing.update === 'function') await existing.update(payload, { transaction });
    else await mcpRepo.create({ values: payload, transaction });
    synced.push(srv.name);
  }
  return synced;
}

async function syncProfileToNocobaseAi(db, profileInput, { adminToolNames = [], defaultOrigin } = {}) {
  if (!db?.getRepository) return { synced: false };
  const profile = enforceProfileRoleLock(profileInput, adminToolNames);
  const tools = [];
  const perms = normalizeToolPermissionsMap(profile.toolPermissions !== undefined ? profile.toolPermissions : profile.toolPermissionsJson);
  for (const [name, mode] of Object.entries(perms)) {
    if (mode === 'ALLOW' || mode === 'ASK') {
      tools.push({ name, autoCall: mode === 'ALLOW' });
    }
  }
  if (profile.allowSubAgentDispatch || profile.username === 'dxos-coordinator') {
    for (const subTool of SUB_AGENT_TOOLS) {
      if (!tools.some((t) => t.name === subTool)) tools.push({ name: subTool, autoCall: true });
    }
  }

  const empValues = {
    username: profile.username,
    nickname: profile.nickname,
    position: profile.position,
    avatar: profile.avatar || 'nocobase-015-male',
    bio: profile.bio || '',
    greeting: profile.greeting || '',
    about: profile.systemPrompt || '',
    enabled: profile.enabled !== false,
    builtIn: false,
    category: 'business',
    deprecated: false,
    modelSettings: {
      enabled: true,
      models: [{ llmService: profile.llmService || 'local-9router', model: profile.modelName || 'ag/gemini-3.8-flash' }],
    },
    skillSettings: {
      skillsVersion: 2,
      toolsVersion: 2,
      skills: [...DEFAULT_SKILLS],
      tools,
    },
  };

  const runSync = async (transaction) => {
    const empRepo = db.getRepository('aiEmployees');
    if (empRepo) {
      const existingEmp = await empRepo.findOne({ filter: { username: profile.username }, transaction });
      if (existingEmp && typeof existingEmp.update === 'function') {
        await existingEmp.update(empValues, { transaction });
      } else {
        await empRepo.create({ values: empValues, transaction });
      }
      await replaceEmployeeRoleBindings(db, profile.username, profile.allowedRoles, transaction);
    }
    const mcpSynced = await syncMcpClients(db, profile.mcpServers, { defaultOrigin, transaction });
    return { synced: Boolean(empRepo), username: profile.username, allowedRoles: profile.allowedRoles, mcpSynced };
  };

  if (db.sequelize?.transaction) {
    return db.sequelize.transaction(runSync);
  }
  return runSync(undefined);
}

async function installAiRoleGrants(db) {
  const roles = db?.getRepository?.('roles');
  const resources = db?.getRepository?.('dataSourcesRolesResources');
  if (!roles || !resources) return { granted: [] };
  const fields = ['id', 'createdAt', 'updatedAt', ...aiProfiles.fields.map((f) => f.name)];
  const adminRole = 'ldx_admin';
  const granted = [];
  const run = async (transaction) => {
    if (await roles.findOne({ filter: { name: adminRole }, transaction })) {
      const filter = { name: aiProfiles.name, roleName: adminRole, dataSourceKey: 'main' };
      if (!(await resources.findOne({ filter, transaction }))) {
        await resources.create({
          values: {
            ...filter,
            usingActionsConfig: true,
            actions: [
              { name: 'view', fields },
              { name: 'create', fields: fields.filter((f) => !['id', 'createdAt', 'updatedAt', 'isAdminBuilder', 'allowedRoles'].includes(f)) },
              { name: 'update', fields: fields.filter((f) => !['id', 'createdAt', 'updatedAt', 'isAdminBuilder', 'allowedRoles'].includes(f)) },
              { name: 'destroy' },
            ],
          },
          transaction,
        });
        granted.push(adminRole);
      }
    }
  };
  if (db.sequelize?.transaction) await db.sequelize.transaction(run);
  else await run(undefined);
  return { granted };
}

module.exports = {
  ALL_LDX_ROLES,
  DEFAULT_ADMIN_ROLES,
  val,
  enforceProfileRoleLock,
  syncMcpClients,
  syncProfileToNocobaseAi,
  installAiRoleGrants,
};
