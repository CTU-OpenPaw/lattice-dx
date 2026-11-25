/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const {
  STARTER_AI_BLUEPRINTS,
  LEGACY_WORKFLOW_TASKS_TOOL,
  normalizeToolPermissionsMap,
  validateAiProfilePayload,
  recordAiAuditLog,
  resolveDefaultOrganizationId,
} = require('./ai-schemas');
const {
  ALL_LDX_ROLES,
  DEFAULT_ADMIN_ROLES,
  val,
  enforceProfileRoleLock,
  syncProfileToNocobaseAi,
} = require('./ai-sync');
const { ADMIN_BUILDER_TOOL_NAMES, OPERATIONAL_TOOL_NAMES, MEMORY_TOOL_NAMES } = require('./ai-tools-core');
const { runWithTenantRls, runWithSystemRlsBypass, runInRlsSavepoint } = require('./ai-rls');
const { ensureLocalLlmServiceRecord } = require('./ai-llm-health');

function serializeProfile(row, defaultOrgId = '') {
  if (!row) return null;
  return {
    id: val(row, 'id') ?? null,
    username: val(row, 'username'),
    nickname: val(row, 'nickname'),
    position: val(row, 'position') || '',
    departmentScope: val(row, 'departmentScope') || 'general',
    organizationId: val(row, 'organizationId') || defaultOrgId || null,
    avatar: val(row, 'avatar') || 'nocobase-015-male',
    bio: val(row, 'bio') || '',
    greeting: val(row, 'greeting') || '',
    systemPrompt: val(row, 'systemPrompt') || '',
    llmService: val(row, 'llmService') || 'local-9router',
    modelName: val(row, 'modelName') || 'ag/gemini-3.8-flash',
    enabled: val(row, 'enabled') !== false,
    isAdminBuilder: Boolean(val(row, 'isAdminBuilder')),
    allowSubAgentDispatch: Boolean(val(row, 'allowSubAgentDispatch')),
    allowedRoles: Array.isArray(val(row, 'allowedRoles')) ? val(row, 'allowedRoles') : [],
    toolPermissions: normalizeToolPermissionsMap(val(row, 'toolPermissions') ?? val(row, 'toolPermissionsJson')),
    mcpServers: Array.isArray(val(row, 'mcpServers')) ? val(row, 'mcpServers') : [],
    portalBindings: Array.isArray(val(row, 'portalBindings')) ? val(row, 'portalBindings') : [],
    quickPrompts: Array.isArray(val(row, 'quickPrompts')) ? val(row, 'quickPrompts') : [],
    version: Number(val(row, 'version')) || 1,
    createdAt: val(row, 'createdAt') || null,
    updatedAt: val(row, 'updatedAt') || null,
  };
}

function serializeAuditLog(row) {
  return {
    id: val(row, 'id'),
    actorUserId: val(row, 'actorUserId'),
    actorUsername: val(row, 'actorUsername'),
    organizationId: val(row, 'organizationId'),
    channel: val(row, 'channel'),
    aiEmployee: val(row, 'aiEmployee'),
    toolName: val(row, 'toolName'),
    argsSummary: val(row, 'argsSummary') || {},
    status: val(row, 'status'),
    durationMs: Number(val(row, 'durationMs')) || 0,
    promptTokens: Number(val(row, 'promptTokens')) || 0,
    completionTokens: Number(val(row, 'completionTokens')) || 0,
    estimatedCostUsd: Number(val(row, 'estimatedCostUsd')) || 0,
    piiRedactedCount: Number(val(row, 'piiRedactedCount')) || 0,
    errorCode: val(row, 'errorCode') || null,
    resultSummary: val(row, 'resultSummary') || null,
    createdAt: val(row, 'createdAt') || null,
  };
}

function buildCatalogMeta() {
  return {
    starterCount: STARTER_AI_BLUEPRINTS.length,
    availableTools: [...ADMIN_BUILDER_TOOL_NAMES, ...OPERATIONAL_TOOL_NAMES, ...MEMORY_TOOL_NAMES],
    adminBuilderTools: [...ADMIN_BUILDER_TOOL_NAMES],
    operationalTools: [...OPERATIONAL_TOOL_NAMES],
    memoryTools: [...MEMORY_TOOL_NAMES],
    roleOptions: [...DEFAULT_ADMIN_ROLES, ...ALL_LDX_ROLES],
    defaultLlmService: 'local-9router',
    defaultModelName: 'ag/gemini-3.8-flash',
  };
}

async function upsertAndSyncProfile(db, input, { actorUser, defaultOrigin, defaultOrganizationId = '', auditToolName = 'dxosAi:saveProfile' } = {}) {
  const resolvedDefaultOrg = defaultOrganizationId || (await resolveDefaultOrganizationId(db, { actor: actorUser, fallback: 'default' }));
  const validated = validateAiProfilePayload(input, {
    adminToolNames: ADMIN_BUILDER_TOOL_NAMES,
    defaultOrganizationId: resolvedDefaultOrg,
  });
  const locked = enforceProfileRoleLock(validated, ADMIN_BUILDER_TOOL_NAMES);
  const profileRepo = db?.getRepository?.('latticeAiProfiles');
  let savedRow = locked;

  if (profileRepo) {
    savedRow = await runWithTenantRls(db, locked.organizationId, async () => {
      const existing = await profileRepo.findOne({ filter: { username: locked.username } });
      const nextVersion = existing ? (Number(val(existing, 'version')) || 1) + 1 : locked.version;
      const recordValues = { ...locked, version: nextVersion };
      if (existing && typeof existing.update === 'function') {
        return existing.update(recordValues);
      }
      return profileRepo.create({ values: recordValues });
    });
  }

  const normalized = serializeProfile(savedRow, resolvedDefaultOrg) || locked;
  const sync = await syncProfileToNocobaseAi(db, normalized, {
    adminToolNames: ADMIN_BUILDER_TOOL_NAMES,
    defaultOrigin,
  });

  if (auditToolName) {
    await recordAiAuditLog(db, {
      actorUserId: val(actorUser, 'id') ?? null,
      actorUsername: val(actorUser, 'username') || null,
      organizationId: normalized.organizationId,
      channel: 'studio-sync',
      aiEmployee: normalized.username,
      toolName: auditToolName,
      argsSummary: {
        username: normalized.username,
        isAdminBuilder: normalized.isAdminBuilder,
        allowedRoles: normalized.allowedRoles,
        portalBindings: normalized.portalBindings,
      },
      status: 'allowed',
      resultSummary: `Synced AI profile ${normalized.username} (v${normalized.version})`,
    });
  }

  return { profile: normalized, sync };
}

async function computeAllTimeAuditTotals(targetDb, organizationId) {
  const empty = { records: 0, promptTokens: 0, completionTokens: 0, estimatedCostUsd: 0, piiRedactedCount: 0 };
  return runWithTenantRls(targetDb, organizationId, async () => {
    if (typeof targetDb?.sequelize?.query === 'function') {
      try {
        const [rows] = await runInRlsSavepoint(targetDb, () => targetDb.sequelize.query(
          `SELECT COUNT(*)::int AS records,
                  COALESCE(SUM("promptTokens"), 0)::bigint AS "promptTokens",
                  COALESCE(SUM("completionTokens"), 0)::bigint AS "completionTokens",
                  COALESCE(SUM("estimatedCostUsd"), 0)::double precision AS "estimatedCostUsd",
                  COALESCE(SUM("piiRedactedCount"), 0)::int AS "piiRedactedCount"
           FROM "latticeAiAuditLogs"
           WHERE "organizationId" = :organizationId;`,
          { replacements: { organizationId } },
        ));
        if (Array.isArray(rows) && rows[0]) {
          const r = rows[0];
          return {
            records: Number(r.records) || 0,
            promptTokens: Number(r.promptTokens) || 0,
            completionTokens: Number(r.completionTokens) || 0,
            estimatedCostUsd: Number((Number(r.estimatedCostUsd) || 0).toFixed(6)),
            piiRedactedCount: Number(r.piiRedactedCount) || 0,
          };
        }
      } catch {
        // Fallback to repository scan in mock harnesses
      }
    }
    const repo = targetDb?.getRepository?.('latticeAiAuditLogs');
    if (!repo || typeof repo.find !== 'function') return empty;
    const rows = (await repo.find({ filter: { organizationId }, sort: ['-id'], limit: 5000 })) || [];
    const totals = { ...empty };
    for (const r of rows) {
      totals.records += 1;
      totals.promptTokens += Number(val(r, 'promptTokens')) || 0;
      totals.completionTokens += Number(val(r, 'completionTokens')) || 0;
      totals.estimatedCostUsd += Number(val(r, 'estimatedCostUsd')) || 0;
      totals.piiRedactedCount += Number(val(r, 'piiRedactedCount')) || 0;
    }
    totals.estimatedCostUsd = Number(totals.estimatedCostUsd.toFixed(6));
    return totals;
  });
}

async function ensureDefaultAiWorkforce(
  db,
  { env = process.env, actorUser = null, defaultOrigin = '', defaultOrganizationId = '', forceUpdate = false } = {},
) {
  const profRepo = db?.getRepository?.('latticeAiProfiles');
  if (!profRepo || typeof profRepo.create !== 'function') {
    return { seeded: [], skipped: true, reason: 'REPOS_NOT_READY' };
  }

  const resolvedOrigin = defaultOrigin || env?.NOCOBASE_INTERNAL_URL || '';
  let outcome;
  try {
    outcome = await runWithSystemRlsBypass(db, async () => {
      const resolvedDefaultOrg = defaultOrganizationId
        || (await resolveDefaultOrganizationId(db, { actor: actorUser, env, fallback: 'default' }));
      const seeded = [];
      const existing = [];
      const starterSet = new Set(STARTER_AI_BLUEPRINTS.map((b) => b.username));

      const existingMap = new Map();
      if (!forceUpdate && typeof profRepo.find === 'function') {
        const existingStarterRows = (await profRepo.find({
          filter: { username: { $in: [...starterSet] } },
          limit: 100,
        })) || [];
        for (const row of existingStarterRows) {
          const uname = String(val(row, 'username') || '').trim().toLowerCase();
          if (uname) existingMap.set(uname, row);
        }
      }

      for (const bp of STARTER_AI_BLUEPRINTS) {
        if (!forceUpdate) {
          let already = existingMap.get(bp.username);
          if (!already && typeof profRepo.findOne === 'function') {
            already = await profRepo.findOne({ filter: { username: bp.username } });
          }
          if (already) {
            existing.push(bp.username);
            continue;
          }
        }
        const res = await upsertAndSyncProfile(db, { ...bp, organizationId: bp.organizationId || resolvedDefaultOrg }, {
          actorUser,
          defaultOrigin: resolvedOrigin,
          defaultOrganizationId: resolvedDefaultOrg,
          auditToolName: null,
        });
        seeded.push(res.profile.username);
      }

      if (forceUpdate && typeof profRepo.find === 'function') {
        const existingRows = (await profRepo.find({ limit: 500 })) || [];
        for (const row of existingRows) {
          const uname = String(val(row, 'username') || '').trim().toLowerCase();
          if (!uname || starterSet.has(uname)) continue;
          const rawPerms = val(row, 'toolPermissions') ?? val(row, 'toolPermissionsJson');
          const hasLegacyKey = rawPerms && typeof rawPerms === 'object' && Object.prototype.hasOwnProperty.call(rawPerms, LEGACY_WORKFLOW_TASKS_TOOL);
          const hasLegacyCol = val(row, 'toolPermissionsJson') !== undefined;
          if (hasLegacyKey || hasLegacyCol) {
            await upsertAndSyncProfile(db, serializeProfile(row, resolvedDefaultOrg), {
              actorUser,
              defaultOrigin: resolvedOrigin,
              defaultOrganizationId: resolvedDefaultOrg,
              auditToolName: null,
            });
          }
        }
      }

      return { seeded, existing };
    });
  } catch (err) {
    const msg = String(err?.message || '');
    const code = err?.original?.code || err?.parent?.code || err?.code || '';
    if (!forceUpdate && (code === '42P01' || /does not exist|no such table/i.test(msg))) {
      return { seeded: [], skipped: true, reason: 'REPOS_NOT_READY' };
    }
    throw err;
  }

  let llm;
  try {
    llm = await runWithSystemRlsBypass(db, () => ensureLocalLlmServiceRecord(db, env));
  } catch (err) {
    if (forceUpdate) throw err;
    llm = { configured: false, skipped: true, reason: err?.message || 'LLM_SERVICE_NOT_READY' };
  }

  return {
    seeded: outcome.seeded,
    existing: outcome.existing,
    profiles: outcome.seeded,
    skipped: false,
    llm,
  };
}

module.exports = {
  serializeProfile,
  serializeAuditLog,
  buildCatalogMeta,
  upsertAndSyncProfile,
  computeAllTimeAuditTotals,
  ensureDefaultAiWorkforce,
};
