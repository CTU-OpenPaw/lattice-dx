/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const path = require('node:path');
const { fail, toPlain, val } = require('../wms-dmn-shared');
const { runAutomationWithRls } = require('./security-helpers');
const { stripUnsafeKeys } = require('./json-schema-validator');

const MUTATING_TOOL_NAMES = new Set([
  'dxos_execute_record_action', 'dxos_twin_set_desired', 'dxos_wms_hold_lot', 'dxos_alarm_action',
  'dxos_mutate_record', 'dispatch_itot_webhook_or_sync', 'dxos_orchestrate_enterprise_case', 'dxos_memory_forget',
]);

const ADMIN_BLOCKED_TOOLS = new Set([
  'dxos_provision_role_workspace', 'dxos_extend_collection_schema', 'dxos_manage_rbac_permissions',
  'dxos_manage_portal_and_acl', 'dxos_deploy_workflow', 'dxos_configure_workflow', 'dxos_snapshot_or_rollback_page',
]);

const DEFAULT_SAFE_TOOLS = new Set([
  'memory_recall', 'memory_store', 'dxos_search_enterprise_context', 'dxos_my_workflow_tasks',
  'dxos_graph_impact_analysis', 'dxos_inspect_architecture', 'dxos_recommend_page_blueprint',
  'dxos_query_records', 'dxos_get_record', 'dxos_evaluate_dmn',
]);

function loadSiblingDxosAiModule(relName) {
  const inDist = __dirname.includes(`${path.sep}dist${path.sep}`);
  const sub = inDist ? `dist/server/${relName}` : `src/server/${relName}`;
  const alt = inDist ? `src/server/${relName}` : `dist/server/${relName}`;
  const candidates = [
    path.resolve(__dirname, `../../../../plugin-dxos-ai/${sub}`),
    `@latticedx/plugin-dxos-ai/${sub}`,
    path.resolve(__dirname, `../../../../plugin-dxos-ai/${alt}`),
    `@latticedx/plugin-dxos-ai/${alt}`,
  ];
  for (const modPath of candidates) {
    try {
      return require(modPath);
    } catch (err) {
      const isDirect = err?.code === 'MODULE_NOT_FOUND'
        && (!Array.isArray(err.requireStack) || !err.requireStack.length || err.requireStack[0] === __filename);
      if (!isDirect) throw err;
    }
  }
  return null;
}

function createMemoryTools({ db, orgId, agentName = 'ops_triage', userId = null, sessionId = null, defaultScope = 'org' }) {
  const cleanOrg = String(orgId || '').trim();
  const cleanAgent = String(agentName || 'ops_triage').trim();
  const cleanUser = userId != null && String(userId).trim() && String(userId).trim() !== '0' ? String(userId).trim() : null;
  const cleanSession = sessionId != null && String(sessionId).trim() ? String(sessionId).trim() : null;
  const allowedScopes = new Set(['org', 'agent', 'user']);
  const effectiveDefaultScope = allowedScopes.has(defaultScope) ? defaultScope : 'org';
  const normImp = (v) => { const n = Number(v); return !Number.isFinite(n) ? 0.5 : (n > 1 ? Math.min(1, Number((n / 10).toFixed(4))) : Math.max(0, Math.min(1, Number(n.toFixed(4))))); };

  return {
    memory_recall: {
      name: 'memory_recall',
      description: 'Recall persistent organization or agent memories matching a keyword query.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keywords to search memory' },
          scope: { type: 'string', enum: ['org', 'agent', 'user'] },
          limit: { type: 'integer', minimum: 1, maximum: 20 },
        },
        required: ['query'],
      },
      async execute(args = {}) {
        const repo = db?.getRepository?.('latticeAiMemory');
        if (!repo || typeof repo.find !== 'function') return { ok: true, available: false, count: 0, items: [] };
        const query = String(args.query || '').trim().toLowerCase();
        const rawScope = args.scope !== undefined && args.scope !== null ? String(args.scope).trim().toLowerCase() : '';
        const scopeFilter = rawScope || null;
        const limit = Math.min(20, Math.max(1, Number(args.limit) || 5));
        const nowMs = Date.now();
        const rows = await runAutomationWithRls(db, cleanOrg, () => repo.find({ filter: { organizationId: cleanOrg, ...(scopeFilter ? { scope: scopeFilter } : {}) }, limit: 150 })) || [];
        const terms = query.split(/\s+/).filter(Boolean);
        const scored = rows.map(toPlain).filter((r) => {
          if (!r || r.organizationId !== cleanOrg) return false;
          if (r.expiresAt) { const expMs = new Date(r.expiresAt).getTime(); if (Number.isFinite(expMs) && expMs <= nowMs) return false; }
          const sc = String(r.scope || 'org').toLowerCase();
          if (scopeFilter && sc !== scopeFilter) return false;
          if (sc === 'agent') { const ra = r.agentId || r.agentName || null; if (!cleanAgent || !ra || ra !== cleanAgent) return false; }
          if (sc === 'user') { const ru = r.userId != null ? String(r.userId).trim() : ''; if (!cleanUser || !ru || ru !== cleanUser) return false; }
          if (sc === 'session' && (!cleanSession || r.sessionId !== cleanSession)) return false;
          return true;
        }).map((r) => {
          const title = r.metadataJson?.title || r.title || '';
          const hay = [r.memoryKey, title, r.content, Array.isArray(r.tagsJson) ? r.tagsJson.join(' ') : ''].join(' ').toLowerCase();
          const hits = terms.length ? terms.filter((t) => hay.includes(t)).length : 1;
          return { row: r, title, hits, score: hits * 10 + Number(r.importance || 0) };
        }).filter((x) => !terms.length || x.hits > 0);
        scored.sort((a, b) => b.score - a.score);
        const items = scored.slice(0, limit).map(({ row: r, title }) => ({
          memoryKey: r.memoryKey,
          scope: r.scope || 'org',
          agentId: r.agentId || null,
          title,
          content: String(r.content || '').slice(0, 1000),
          tags: Array.isArray(r.tagsJson) ? r.tagsJson : [],
          importance: Number(r.importance || 0),
        }));
        return { ok: true, available: true, count: items.length, items };
      },
    },
    memory_store: {
      name: 'memory_store',
      description: 'Store or update a persistent organization or agent memory note.',
      parameters: {
        type: 'object',
        properties: {
          memoryKey: { type: 'string', description: 'Unique key for this memory' },
          title: { type: 'string' },
          content: { type: 'string' },
          scope: { type: 'string', enum: ['org', 'agent', 'user'] },
          tags: { type: 'array', items: { type: 'string' } },
          importance: { type: 'number', minimum: 0, maximum: 10 },
        },
        required: ['memoryKey', 'content'],
      },
      async execute(args = {}) {
        const repo = db?.getRepository?.('latticeAiMemory');
        if (!repo || typeof repo.create !== 'function') return { ok: false, available: false, reason: 'latticeAiMemory repository unavailable' };
        const safeArgs = stripUnsafeKeys(args) || {};
        const memoryKey = String(safeArgs.memoryKey || '').trim().slice(0, 120);
        const content = String(safeArgs.content || '').trim().slice(0, 4000);
        if (!memoryKey || !content) throw fail('MEMORY_INVALID_INPUT', 400, 'memoryKey and content are required');
        const scope = allowedScopes.has(safeArgs.scope) ? safeArgs.scope : effectiveDefaultScope;
        if (scope === 'agent' && !cleanAgent) throw fail('MEMORY_AGENT_REQUIRED', 400, 'agentId is required for agent-scoped memory');
        if (scope === 'user' && !cleanUser) throw fail('MEMORY_USER_REQUIRED', 400, 'userId is required for user-scoped memory');
        const tagsJson = Array.isArray(safeArgs.tags) ? safeArgs.tags.map((t) => String(t).slice(0, 40)).slice(0, 12) : [];
        const metadataJson = { ...(safeArgs.metadata && typeof safeArgs.metadata === 'object' ? safeArgs.metadata : {}), ...(safeArgs.title ? { title: String(safeArgs.title).slice(0, 200) } : {}) };
        const importance = normImp(safeArgs.importance);
        const lookupFilter = { organizationId: cleanOrg, scope, memoryKey, ...(scope === 'agent' ? { agentId: cleanAgent } : {}), ...(scope === 'user' ? { userId: cleanUser } : {}) };
        const values = {
          organizationId: cleanOrg, agentId: scope === 'agent' ? cleanAgent : (cleanAgent || null),
          scope, userId: scope === 'user' ? cleanUser : (cleanUser || null), sessionId: cleanSession,
          memoryKey, content, tagsJson, metadataJson, importance, source: 'flow:ai-agent',
          expiresAt: safeArgs.expiresAt ? new Date(safeArgs.expiresAt) : null, createdById: cleanUser, lastAccessedAt: new Date(),
        };
        return runAutomationWithRls(db, cleanOrg, async () => {
          const existing = typeof repo.findOne === 'function' ? await repo.findOne({ filter: lookupFilter }).catch(() => null) : null;
          if (existing && String(val(existing, 'scope') || 'org') === scope && typeof repo.update === 'function') {
            await repo.update({ filter: lookupFilter, values });
            return { ok: true, updated: true, memoryKey, scope };
          }
          const created = await repo.create({ values: { ...values, accessCount: 0 } });
          return { ok: true, stored: true, id: val(created, 'id') ?? null, memoryKey, scope };
        });
      },
    },
  };
}

function collectHostTools(app, db, options) {
  const pool = new Map();
  const addTool = (name, toolObj) => {
    const clean = String(name || toolObj?.definition?.name || toolObj?.name || '').trim();
    if (!clean || ADMIN_BLOCKED_TOOLS.has(clean) || toolObj?.adminOnly === true) return;
    pool.set(clean, { ...toolObj, name: clean });
  };

  const managers = [
    app?.ai?.toolsManager,
    app?.app?.aiManager?.toolsManager,
    app?.pm?.get?.('ai')?.ai?.toolsManager,
    app?.toolsManager,
  ].filter(Boolean);
  for (const tm of managers) {
    const list = typeof tm.listTools === 'function' ? tm.listTools() : (tm.tools instanceof Map ? [...tm.tools.values()] : Array.isArray(tm.tools) ? tm.tools : []);
    for (const t of list || []) addTool(t?.definition?.name || t?.name, t);
  }

  if (pool.size === 0) {
    const aiCore = loadSiblingDxosAiModule('ai-tools-core');
    if (typeof aiCore?.createDxosTools === 'function') {
      for (const t of aiCore.createDxosTools()) addTool(t?.definition?.name, t);
    }
    const mcpMod = loadSiblingDxosAiModule('it-ot-mcp');
    if (typeof mcpMod?.createItOtMcpTools === 'function') {
      for (const t of mcpMod.createItOtMcpTools(db)) addTool(t?.definition?.name || t?.name, t);
    }
  }

  if (options?.tools && typeof options.tools === 'object') {
    const entries = Array.isArray(options.tools)
      ? options.tools.map((t) => [t?.name || t?.definition?.name, t])
      : Object.entries(options.tools);
    for (const [k, t] of entries) if (t) addTool(k, t);
  }
  return pool;
}

function resolveAgentTools({ cfg, db, app, options, orgId, context }) {
  const actor = context?.actor || {};
  const memoryTools = createMemoryTools({
    db,
    orgId,
    agentName: cfg.aiEmployee || 'ops_triage',
    userId: actor.userId ?? actor.id ?? null,
    sessionId: context?.sessionId ?? context?.runUid ?? null,
    defaultScope: cfg.memoryScope && cfg.memoryScope !== 'none' ? cfg.memoryScope : 'org',
  });
  const hostPool = collectHostTools(app, db, options);
  const pool = new Map([...hostPool.entries(), ...Object.entries(memoryTools)]);

  const requested = Array.isArray(cfg.tools) ? cfg.tools.map((x) => String(x || '').trim()).filter(Boolean) : [];
  const allowedMap = new Map();
  const namesToExpose = requested.length ? requested : [...DEFAULT_SAFE_TOOLS].filter((n) => pool.has(n));

  for (const name of namesToExpose) {
    if (ADMIN_BLOCKED_TOOLS.has(name)) continue;
    const def = pool.get(name);
    if (!def || def.adminOnly === true) continue;
    allowedMap.set(name, def);
  }
  return { allowedMap, memoryTools };
}

function toOpenAiToolSpecs(allowedMap) {
  const specs = [];
  for (const [name, tool] of allowedMap.entries()) {
    const schema = tool.jsonSchema || tool.definition?.schema || tool.parameters || { type: 'object', properties: {} };
    specs.push({
      type: 'function',
      function: {
        name,
        description: String(tool.definition?.description || tool.description || name).slice(0, 800),
        parameters: stripUnsafeKeys(typeof schema === 'object' ? schema : { type: 'object', properties: {} }),
      },
    });
  }
  return specs;
}

const isMutatingTool = (name, toolDef) => MUTATING_TOOL_NAMES.has(name)
  || Boolean(toolDef?.mutating || toolDef?.requireApproval)
  || (toolDef?.defaultPermission === 'ASK' && !DEFAULT_SAFE_TOOLS.has(name));

async function resolveAutomationActor(db, orgId, context) {
  const actor = context?.actor || {};
  const directId = Number(actor.userId ?? actor.id);
  const rawRoles = (Array.isArray(actor.roles) ? actor.roles : (Array.isArray(actor.roleNames) ? actor.roleNames : []))
    .filter((r) => typeof r === 'string').map((r) => r.trim()).filter(Boolean);
  if (Number.isInteger(directId) && directId > 0) {
    return { userId: directId, username: actor.username || `user-${directId}`, roles: rawRoles.length ? rawRoles : ['ldx_operator'] };
  }
  const emps = (await db?.getRepository?.('latticeEmployees')?.find?.({ filter: { organizationId: orgId, active: true }, limit: 25 }).catch(() => [])) || [];
  const cleanEmps = emps.map(toPlain).filter((e) => e && e.organizationId === orgId && Number(e.userId) > 0);
  let chosen = cleanEmps[0];
  if (cleanEmps.length && db?.getRepository?.('rolesUsers')?.find) {
    const ruRows = (await db.getRepository('rolesUsers').find({ filter: { userId: { $in: cleanEmps.map((e) => e.userId) } }, limit: 100 }).catch(() => [])) || [];
    const roleMap = new Map();
    for (const r of ruRows.map(toPlain)) if (r?.userId && r?.roleName) roleMap.set(r.userId, [...(roleMap.get(r.userId) || []), String(r.roleName)]);
    const priv = new Set(['root', 'admin', 'ldx_admin', 'ldx_director', 'ldx_manager']);
    const allRoles = [...new Set([...roleMap.values()].flat())];
    if (allRoles.length && db?.getRepository?.('roles')?.find) {
      const roleDefs = (await db.getRepository('roles').find({ filter: { name: { $in: allRoles } }, limit: 100 }).catch(() => [])) || [];
      for (const rd of roleDefs.map(toPlain)) {
        const snips = Array.isArray(rd?.snippets) ? rd.snippets : [];
        if (rd?.name && (rd.allowConfigure === true || snips.includes('pm') || snips.includes('pm.*'))) priv.add(String(rd.name));
      }
    }
    const nonPriv = cleanEmps.find((e) => { const rs = roleMap.get(e.userId) || []; return rs.length > 0 && !rs.some((r) => priv.has(r)); });
    if (nonPriv) chosen = nonPriv;
  }
  return chosen ? { userId: chosen.userId, username: chosen.username || 'flow:ai-agent', roles: ['ldx_operator'] } : { userId: 0, username: 'flow:ai-agent', roles: ['ldx_operator'] };
}

async function invokeResolvedTool(toolDef, args, { db, app, context, cfg, orgId }) {
  const cleanArgs = stripUnsafeKeys(args && typeof args === 'object' ? args : {}) || {};
  if (typeof toolDef.execute === 'function') {
    return toolDef.execute(cleanArgs, { db, app, context, organizationId: orgId, agentName: cfg.aiEmployee || 'ops_triage' });
  }
  if (typeof toolDef.invoke === 'function') {
    const actor = await resolveAutomationActor(db, orgId, context);
    const subCtx = {
      app,
      db,
      state: {
        currentUser: { id: actor.userId, username: actor.username || 'flow:ai-agent' },
        currentRoles: actor.roles,
        dxosAuditChannel: 'flow:ai-agent',
        dxosAiUsername: cfg.aiEmployee || 'ops_triage',
        dxosTargetOrganizationId: orgId,
      },
    };
    return toolDef.invoke(subCtx, cleanArgs);
  }
  throw fail('AGENT_TOOL_UNEXECUTABLE', 500, `Tool "${toolDef.name}" has no execute or invoke handler`);
}

async function enqueueAgentHitlApproval({ db, orgId, cfg, context, toolName, args, targetCollection }) {
  const queueRepo = db?.getRepository?.('latticeAiApprovalQueue');
  if (!queueRepo || typeof queueRepo.create !== 'function') {
    throw fail('AGENT_HITL_QUEUE_UNAVAILABLE', 503, 'latticeAiApprovalQueue repository unavailable for HITL guard');
  }
  const cleanArgs = stripUnsafeKeys(args || {}) || {};
  const rawRec = cleanArgs.recordId ?? cleanArgs.targetRecordId ?? cfg.targetRecordId ?? context?.data?.recordId;
  const parsedRec = Number(rawRec);
  const safeTargetRecordId = Number.isInteger(parsedRec) && parsedRec > 0 ? parsedRec : null;
  const col = String(cleanArgs.collection || cleanArgs.targetCollection || targetCollection || 'latticeServiceTickets').trim();
  const op = String(cleanArgs.operation || 'execute').trim();
  const ttlHours = Math.min(168, Math.max(1, Number(cfg.ttlHours) || 24));
  const resumeAt = new Date(Date.now() + ttlHours * 3_600_000).toISOString();
  const approverRole = String(cfg.approverRole || 'ldx_manager').trim() || 'ldx_manager';

  const created = await queueRepo.create({
    values: {
      organizationId: orgId,
      requesterUserId: Number(context?.actor?.userId || context?.actor?.id || 0),
      requesterUsername: String(context?.actor?.username || 'flow:ai-agent'),
      aiEmployee: String(cfg.aiEmployee || 'ops_triage'),
      toolName,
      targetCollection: col,
      targetRecordId: safeTargetRecordId,
      operation: op,
      proposedArgs: cleanArgs,
      diffPreview: { summary: `ReAct HITL approval for ${toolName} on ${col}`, args: cleanArgs },
      riskLevel: String(cfg.severity || 'high'),
      status: 'pending',
      expiresAt: new Date(resumeAt),
    },
  });
  return { approvalId: val(created, 'id') ?? null, approverRole, resumeAt };
}

module.exports = {
  MUTATING_TOOL_NAMES, ADMIN_BLOCKED_TOOLS, DEFAULT_SAFE_TOOLS, resolveAgentTools,
  toOpenAiToolSpecs, isMutatingTool, invokeResolvedTool, enqueueAgentHitlApproval,
};
