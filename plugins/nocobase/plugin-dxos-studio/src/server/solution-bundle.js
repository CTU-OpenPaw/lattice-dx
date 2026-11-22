/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { createHash, randomBytes } = require('node:crypto');

const BUNDLE_SCHEMA_VERSION = 'latticedx.solution-bundle/v2';
const ACCEPTED_SCHEMA_VERSIONS = new Set([
  'latticedx.solution-bundle/v1',
  'latticedx.solution-bundle/v2',
]);
const FORBIDDEN_ROLES = new Set(['root', 'admin', 'ldx_admin']);
const SAFE_ROLE_RE = /^ldx_[a-z0-9_]{2,48}$/;
const SAFE_PORTAL_UID_RE = /^ldx-portal-[a-z0-9-]+$/;
const SAFE_ROUTE_PATH_RE = /^\/p\/[a-z0-9-]+$/;
const SAFE_ROUTE_NAME_RE = /^p_[a-z0-9_]+$/;
const SAFE_USERNAME_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/i;
const SAFE_ACTION_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/;
const SAFE_STRATEGY_ACTION_RE = /^[a-zA-Z][a-zA-Z0-9_:-]{0,39}$/;
const SAFE_RESOURCE_COLLECTION_RE = /^[a-zA-Z][a-zA-Z0-9_]{1,62}$/;
const SAFE_FIELD_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,60}$/;
const CUSTOM_COLLECTION_RE = /^latticeCustom[A-Z][A-Za-z0-9]{1,40}$/;
const SECRET_KEY_RE = /password|secret|token|apikey|api_key|privatekey|authorization|cookie/i;
const SENSITIVE_FIELD_RE = /password|secret|token|apikey|api_key|identitySubject|privateKey|hash|salt/i;
const SNAPSHOT_PORTAL_SLUG = '__gitops_bundle__';
const VALID_TOOL_PERMISSION_MODES = new Set(['ALLOW', 'ASK', 'OFF']);

const SYSTEM_PROTECTED_COLLECTIONS = new Set([
  'users', 'roles', 'rolesUsers', 'apiKeys', 'authenticators', 'migrations',
  'applicationPlugins', 'applicationTokens', 'sessions',
  'aiSettings', 'aiEmployees', 'aiMcpClients', 'rolesAiEmployees',
  'latticeAiAuditLogs', 'latticeAiProfiles', 'latticeAiQuotaUsage', 'latticeUiSnapshots',
  'dataSourcesRoles', 'dataSourcesRolesResources', 'dataSourcesRolesResourcesActions',
  'dataSourcesRolesResourcesScopes',
  'llmServices', 'rolesDesktopRoutes', 'desktopRoutes', 'uiLayouts',
  'workflows', 'flow_nodes', 'collections', 'fields',
  'latticeNotifications', 'latticeSlaPolicies', 'latticeAiApprovalQueue', 'latticeParaChunks',
]);
const SYSTEM_PROTECTED_COLLECTIONS_LOWER = new Set(
  [...SYSTEM_PROTECTED_COLLECTIONS].map((c) => c.toLowerCase()),
);

function isProtectedCollection(name) {
  const s = String(name || '').trim();
  return SYSTEM_PROTECTED_COLLECTIONS.has(s) || SYSTEM_PROTECTED_COLLECTIONS_LOWER.has(s.toLowerCase());
}

const ADMIN_BUILDER_TOOL_NAMES = new Set([
  'dxos_inspect_architecture',
  'dxos_recommend_page_blueprint',
  'dxos_design_creative_block',
  'dxos_compose_page_blocks',
  'dxos_snapshot_or_rollback_page',
  'dxos_provision_role_workspace',
  'dxos_manage_portal_and_acl',
  'dxos_extend_collection_schema',
  'dxos_manage_rbac_permissions',
  'dxos_deploy_workflow',
  'dxos_configure_workflow',
  'get_stack_connector_health',
]);

const val = (row, key) => (typeof row?.get === 'function' ? row.get(key) : row?.[key]);
const toObj = (row) => (typeof row?.toJSON === 'function' ? row.toJSON() : { ...(row || {}) });

function failBundle(code, status = 400, message = code) {
  return Object.assign(new Error(message), { code, status });
}

function isForbiddenSnippet(snippet) {
  if (typeof snippet !== 'string') return true;
  const s = snippet.trim().toLowerCase();
  if (!s) return true;
  if (s.includes('*') || s.startsWith('!')) return true;
  return (
    s === 'pm'
    || s.startsWith('pm.')
    || s.startsWith('pm:')
    || s === 'acl'
    || s.startsWith('acl.')
    || s.startsWith('acl:')
    || s === 'app'
    || s.startsWith('app.')
    || s.startsWith('app:')
    || s === 'ui'
    || s.startsWith('ui.')
    || s.startsWith('ui:')
  );
}

function isAdminBuilderTool(toolName) {
  const name = String(toolName || '').trim();
  return ADMIN_BUILDER_TOOL_NAMES.has(name);
}

function stripSecretsDeep(value, depth = 0) {
  if (depth > 25 || value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => stripSecretsDeep(item, depth + 1));
  if (typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (SECRET_KEY_RE.test(key)) continue;
    const stripped = stripSecretsDeep(value[key], depth + 1);
    if (stripped !== undefined) out[key] = stripped;
  }
  return out;
}

async function safeRepoFind(db, name, opts = {}) {
  if (typeof db?.hasCollection === 'function' && !db.hasCollection(name)) return [];
  const repo = db?.getRepository?.(name);
  if (!repo || typeof repo.find !== 'function') return [];
  try {
    return (await repo.find(opts)) || [];
  } catch {
    if (opts.appends) {
      try {
        const { appends: _ignored, ...rest } = opts;
        return (await repo.find(rest)) || [];
      } catch {
        return [];
      }
    }
    return [];
  }
}

async function findOneSafe(repo, filter, extraOpts = {}) {
  if (!repo) return null;
  if (typeof repo.findOne === 'function') {
    return repo.findOne({ filter, ...extraOpts });
  }
  if (typeof repo.find === 'function') {
    const rows = (await repo.find({ filter, ...extraOpts })) || [];
    return rows.find((r) => Object.entries(filter || {}).every(([k, v]) => val(r, k) === v)) || null;
  }
  return null;
}

function sanitizeRoleAction(rawAction) {
  if (typeof rawAction === 'string') {
    const name = rawAction.trim();
    if (!SAFE_ACTION_NAME_RE.test(name) || name.includes('*') || isForbiddenSnippet(name)) return null;
    return { name };
  }
  if (!rawAction || typeof rawAction !== 'object') return null;
  const obj = toObj(rawAction);
  const name = String(obj.name || '').trim();
  if (!SAFE_ACTION_NAME_RE.test(name) || name.includes('*') || isForbiddenSnippet(name)) return null;
  const out = { name };
  if (Array.isArray(obj.fields)) {
    out.fields = obj.fields.map((f) => String(f || '').trim()).filter((f) => f && !SENSITIVE_FIELD_RE.test(f));
  }
  if (obj.scope && typeof obj.scope === 'object' && !Array.isArray(obj.scope)) {
    const cleanScope = stripSecretsDeep(obj.scope);
    if (cleanScope && typeof cleanScope === 'object' && !Array.isArray(cleanScope)) {
      const { id: _id, createdAt: _ca, updatedAt: _ua, createdById: _cb, updatedById: _ub, ...scopeRest } = cleanScope;
      if (Object.keys(scopeRest).length > 0) {
        out.scope = scopeRest;
      }
    }
  }
  return out;
}

function sanitizeRoleActionsList(rawActions) {
  const list = Array.isArray(rawActions) ? rawActions : [];
  return list.map(sanitizeRoleAction).filter(Boolean);
}

function sanitizeToolPermissions(rawPerms, isAdminBuilder) {
  if (!rawPerms || typeof rawPerms !== 'object' || Array.isArray(rawPerms)) return {};
  const out = {};
  for (const key of Object.keys(rawPerms).sort()) {
    const tool = String(key || '').trim();
    if (!tool) continue;
    if (!isAdminBuilder && isAdminBuilderTool(tool)) continue;
    const mode = typeof rawPerms[key] === 'string' ? rawPerms[key].trim().toUpperCase() : '';
    if (!VALID_TOOL_PERMISSION_MODES.has(mode)) continue;
    out[tool] = mode;
  }
  return out;
}

function sanitizeCustomField(rawField) {
  if (!rawField || typeof rawField !== 'object') return null;
  const obj = toObj(rawField);
  const name = String(obj.name || '').trim();
  if (!SAFE_FIELD_NAME_RE.test(name)) return null;
  const { id: _id, collectionName: _col, createdAt: _ca, updatedAt: _ua, key: _k, ...rest } = obj;
  return {
    ...rest,
    name,
    type: obj.type || 'string',
  };
}

async function runInTransaction(db, fn) {
  if (db?.sequelize?.transaction) {
    return db.sequelize.transaction(fn);
  }
  return fn(undefined);
}

function inferFieldInterface(type) {
  if (type === 'integer') return 'integer';
  if (type === 'float' || type === 'number' || type === 'double' || type === 'decimal') return 'number';
  if (type === 'boolean') return 'checkbox';
  if (type === 'date' || type === 'datetime') return 'datetime';
  if (type === 'text') return 'textarea';
  return 'input';
}

function normalizePortalEntry(rawPortal) {
  const obj = toObj(rawPortal);
  const uid = String(obj.uid || '').trim();
  const slug = uid.startsWith('ldx-portal-') ? uid.slice('ldx-portal-'.length) : uid;
  const routeName = typeof obj.routeName === 'string' && SAFE_ROUTE_NAME_RE.test(obj.routeName.trim())
    ? obj.routeName.trim()
    : `p_${slug.replace(/-/g, '_')}`;
  const routePath = typeof obj.routePath === 'string' && SAFE_ROUTE_PATH_RE.test(obj.routePath.trim())
    ? obj.routePath.trim()
    : `/p/${slug}`;
  return {
    uid,
    name: obj.name || obj.title || uid,
    title: obj.title || obj.name || uid,
    layoutType: obj.layoutType === 'mobile' ? 'mobile' : 'desktop',
    routeName,
    routePath,
    enabled: obj.enabled !== false,
    authCheck: true,
    options: obj.options && typeof obj.options === 'object' && !Array.isArray(obj.options) ? obj.options : {},
  };
}

async function exportSolutionBundle(db, { organizationId = null, platformVersion = '0.3.0' } = {}) {
  const rawOrg = organizationId != null ? String(organizationId).trim() : '';
  const filterOrg = rawOrg && rawOrg !== 'all' ? rawOrg : '';

  const rawRoles = await safeRepoFind(db, 'roles', { limit: 500 });
  const rawRes = await safeRepoFind(db, 'dataSourcesRolesResources', { limit: 2000, appends: ['actions'] });
  const rawPortals = await safeRepoFind(db, 'uiLayouts', { limit: 500 });
  const rawWorkflows = await safeRepoFind(db, 'workflows', { filter: { current: true }, limit: 500 });
  const rawNodes = await safeRepoFind(db, 'flow_nodes', { limit: 2000 });
  const rawAiProfiles = await safeRepoFind(
    db,
    'latticeAiProfiles',
    filterOrg ? { filter: { organizationId: filterOrg }, limit: 500 } : { limit: 500 },
  );
  const rawCollections = await safeRepoFind(db, 'collections', { limit: 500, appends: ['fields'] });

  const resByRole = new Map();
  for (const r of rawRes) {
    const obj = toObj(r);
    const resName = String(obj.name || '').trim();
    if (!obj.roleName || !SAFE_RESOURCE_COLLECTION_RE.test(resName) || isProtectedCollection(resName)) continue;
    const list = resByRole.get(obj.roleName) || [];
    list.push(stripSecretsDeep({
      name: resName,
      dataSourceKey: obj.dataSourceKey || 'main',
      usingActionsConfig: true,
      actions: sanitizeRoleActionsList(obj.actions),
    }));
    resByRole.set(obj.roleName, list);
  }

  const roles = rawRoles
    .map(toObj)
    .filter((r) => typeof r.name === 'string' && SAFE_ROLE_RE.test(r.name) && !FORBIDDEN_ROLES.has(r.name))
    .map((r) => stripSecretsDeep({
      name: r.name,
      title: r.title || r.name,
      description: r.description || '',
      snippets: Array.isArray(r.snippets) ? [...r.snippets].filter((s) => !isForbiddenSnippet(s)).sort() : [],
      allowAll: false,
      allowConfigure: false,
      resources: (resByRole.get(r.name) || []).sort((a, b) => String(a.name).localeCompare(String(b.name))),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const portals = rawPortals
    .map(toObj)
    .filter((p) => SAFE_PORTAL_UID_RE.test(String(p.uid || '')))
    .map((p) => stripSecretsDeep(normalizePortalEntry(p)))
    .sort((a, b) => String(a.uid).localeCompare(String(b.uid)));

  const nodeKeyByWfAndId = new Map();
  for (const n of rawNodes) {
    const obj = toObj(n);
    if (obj.workflowId == null || obj.id == null) continue;
    const wfId = String(obj.workflowId);
    if (!nodeKeyByWfAndId.has(wfId)) nodeKeyByWfAndId.set(wfId, new Map());
    nodeKeyByWfAndId.get(wfId).set(String(obj.id), String(obj.key || obj.id));
  }

  const nodesByWf = new Map();
  for (const n of rawNodes) {
    const obj = toObj(n);
    const wfId = String(obj.workflowId);
    const list = nodesByWf.get(wfId) || [];
    const keyMap = nodeKeyByWfAndId.get(wfId);
    const upstreamKey = obj.upstreamKey
      || (obj.upstreamId != null && keyMap ? keyMap.get(String(obj.upstreamId)) : undefined);
    list.push(stripSecretsDeep({
      key: String(obj.key || obj.id),
      type: obj.type,
      title: obj.title,
      ...(upstreamKey ? { upstreamKey } : {}),
      ...(obj.branchIndex != null ? { branchIndex: obj.branchIndex } : {}),
      config: obj.config || {},
    }));
    nodesByWf.set(wfId, list);
  }

  const workflows = rawWorkflows
    .map(toObj)
    .filter((w) => w.current !== false && (!filterOrg || w.options?.dxosOrganizationId === filterOrg))
    .map((w) => stripSecretsDeep({
      key: String(w.key || w.title || w.id),
      title: w.title || w.key || '',
      type: w.type || 'collection',
      enabled: w.enabled === true,
      config: w.config || {},
      options: w.options || {},
      nodes: (nodesByWf.get(String(w.id)) || []).sort((a, b) => String(a.key).localeCompare(String(b.key))),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

  const aiProfiles = rawAiProfiles
    .map(toObj)
    .filter((p) => !filterOrg || p.organizationId === filterOrg)
    .map((p) => {
      const isAdminBuilder = p.isAdminBuilder === true;
      const rawTools = Array.isArray(p.tools) ? [...p.tools].sort() : [];
      const cleanTools = isAdminBuilder ? rawTools : rawTools.filter((t) => !isAdminBuilderTool(t));
      const out = {
        username: p.username,
        nickname: p.nickname || p.username,
        position: p.position || '',
        organizationId: p.organizationId || filterOrg || '',
        enabled: p.enabled !== false,
        isAdminBuilder,
        systemPrompt: p.systemPrompt || '',
        tools: cleanTools,
      };
      if (p.toolPermissions && typeof p.toolPermissions === 'object' && !Array.isArray(p.toolPermissions)) {
        out.toolPermissions = sanitizeToolPermissions(p.toolPermissions, isAdminBuilder);
      }
      if (Array.isArray(p.allowedRoles)) {
        out.allowedRoles = isAdminBuilder ? ['root', 'admin'] : [...new Set(p.allowedRoles.filter(Boolean))];
      }
      if (p.departmentScope) out.departmentScope = p.departmentScope;
      if (p.llmService) out.llmService = p.llmService;
      if (p.modelName) out.modelName = p.modelName;
      if (p.allowSubAgentDispatch !== undefined) out.allowSubAgentDispatch = Boolean(p.allowSubAgentDispatch);
      if (Array.isArray(p.portalBindings)) out.portalBindings = [...p.portalBindings];
      if (Array.isArray(p.quickPrompts)) out.quickPrompts = p.quickPrompts;
      if (p.greeting) out.greeting = p.greeting;
      if (p.bio) out.bio = p.bio;
      if (p.avatar) out.avatar = p.avatar;
      return stripSecretsDeep(out);
    })
    .sort((a, b) => String(a.username).localeCompare(String(b.username)));

  const customCollections = rawCollections
    .map(toObj)
    .filter((c) => typeof c.name === 'string' && CUSTOM_COLLECTION_RE.test(c.name))
    .map((c) => stripSecretsDeep({
      name: c.name,
      title: c.title || c.name,
      ...(c.options && typeof c.options === 'object' && !Array.isArray(c.options) ? { options: c.options } : {}),
      fields: Array.isArray(c.fields) ? c.fields.map(sanitizeCustomField).filter(Boolean) : [],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const payload = { roles, portals, workflows, aiProfiles, customCollections };
  const contentSha256 = createHash('sha256').update(JSON.stringify(payload)).digest('hex');

  return {
    metadata: {
      schemaVersion: BUNDLE_SCHEMA_VERSION,
      platformVersion: String(platformVersion || '0.3.0'),
      organizationId: filterOrg || 'all',
      exportedAt: new Date().toISOString(),
      contentSha256,
    },
    ...payload,
  };
}

function validateWorkflowNodesDag(nodes, wfLabel = 'workflow') {
  const errors = [];
  if (!Array.isArray(nodes)) {
    return [`Workflow "${wfLabel}" nodes must be an array`];
  }
  const seenKeys = new Set();
  const parsedNodes = [];
  for (let i = 0; i < nodes.length; i += 1) {
    const n = nodes[i];
    if (!n || typeof n !== 'object' || Array.isArray(n)) {
      errors.push(`Workflow "${wfLabel}" node at index ${i} must be an object`);
      continue;
    }
    const nodeKey = typeof n.key === 'string' ? n.key.trim() : '';
    if (!nodeKey) {
      errors.push(`Workflow "${wfLabel}" node at index ${i} must include a non-empty key`);
      continue;
    }
    if (seenKeys.has(nodeKey)) {
      errors.push(`Duplicate flow_node key "${nodeKey}" in workflow "${wfLabel}"`);
      continue;
    }
    seenKeys.add(nodeKey);
    let upstreamKey = null;
    if (n.upstreamKey !== undefined && n.upstreamKey !== null) {
      if (typeof n.upstreamKey !== 'string') {
        errors.push(`Invalid upstreamKey on node "${nodeKey}" in workflow "${wfLabel}"`);
      } else {
        const trimmedUp = n.upstreamKey.trim();
        if (trimmedUp) upstreamKey = trimmedUp;
      }
    }
    parsedNodes.push({ key: nodeKey, upstreamKey });
  }

  const adj = new Map();
  const inDegree = new Map();
  for (const { key } of parsedNodes) {
    adj.set(key, []);
    inDegree.set(key, 0);
  }
  for (const { key, upstreamKey } of parsedNodes) {
    if (!upstreamKey) continue;
    if (upstreamKey === key) {
      errors.push(`Self-referential upstreamKey "${upstreamKey}" on node "${key}" in workflow "${wfLabel}"`);
      continue;
    }
    if (!seenKeys.has(upstreamKey)) {
      errors.push(`Dangling upstreamKey "${upstreamKey}" on node "${key}" in workflow "${wfLabel}"`);
      continue;
    }
    adj.get(upstreamKey).push(key);
    inDegree.set(key, (inDegree.get(key) || 0) + 1);
  }

  if (errors.length > 0) return errors;

  const queue = [];
  for (const [k, deg] of inDegree.entries()) {
    if (deg === 0) queue.push(k);
  }
  let visited = 0;
  while (queue.length > 0) {
    const cur = queue.shift();
    visited += 1;
    for (const next of adj.get(cur) || []) {
      const nextDeg = (inDegree.get(next) || 0) - 1;
      inDegree.set(next, nextDeg);
      if (nextDeg === 0) queue.push(next);
    }
  }
  if (visited !== seenKeys.size) {
    errors.push(`Workflow "${wfLabel}" contains cyclic flow_nodes DAG`);
  }
  return errors;
}

function validateRoleEntry(r, errors) {
  const name = String(r?.name || '');
  if (FORBIDDEN_ROLES.has(name) || !SAFE_ROLE_RE.test(name)) {
    errors.push(`Forbidden or invalid role name: ${name || '(empty)'}`);
  }
  if (r?.allowAll === true || r?.allowConfigure === true) {
    errors.push(`Privilege escalation flags allowAll/allowConfigure forbidden on role: ${name}`);
  }
  if (r?.snippets !== undefined && !Array.isArray(r.snippets)) {
    errors.push(`Role ${name} snippets must be an array`);
  } else if (Array.isArray(r?.snippets) && r.snippets.some(isForbiddenSnippet)) {
    errors.push(`Privilege escalation or wildcard snippet forbidden on role: ${name}`);
  }
  if (r?.strategy !== undefined) {
    if (!r.strategy || typeof r.strategy !== 'object' || Array.isArray(r.strategy)) {
      errors.push(`Role ${name} strategy must be an object`);
    } else if (r.strategy.actions !== undefined) {
      if (!Array.isArray(r.strategy.actions)) {
        errors.push(`Role ${name} strategy.actions must be an array`);
      } else {
        for (const act of r.strategy.actions) {
          const actName = typeof act === 'string' ? act.trim() : String(act?.name || '').trim();
          if (!actName || actName.includes('*') || !SAFE_STRATEGY_ACTION_RE.test(actName) || isForbiddenSnippet(actName)) {
            errors.push(`Privilege escalation strategy action "${actName || '(empty)'}" forbidden on role: ${name}`);
          }
        }
      }
    }
  }
  if (r?.resources !== undefined && !Array.isArray(r.resources)) {
    errors.push(`Role ${name} resources must be an array`);
  } else if (Array.isArray(r?.resources)) {
    for (const res of r.resources) {
      if (!res || typeof res !== 'object' || Array.isArray(res)) {
        errors.push(`Invalid resource entry on role ${name}`);
        continue;
      }
      const resName = String(res.name || '').trim();
      if (!SAFE_RESOURCE_COLLECTION_RE.test(resName) || isProtectedCollection(resName)) {
        errors.push(`Forbidden or invalid role resource collection on ${name}: ${resName || '(empty)'}`);
      }
      if (res.usingActionsConfig === false) {
        errors.push(`Unrestricted usingActionsConfig=false forbidden on role ${name} resource ${resName}`);
      }
      if (!Array.isArray(res.actions)) {
        errors.push(`Resource ${resName || '(empty)'} on role ${name} must specify an actions array`);
      } else {
        for (const act of res.actions) {
          const actName = typeof act === 'string' ? act.trim() : String(act?.name || '').trim();
          if (!SAFE_ACTION_NAME_RE.test(actName) || actName.includes('*') || isForbiddenSnippet(actName)) {
            errors.push(`Forbidden action "${actName || '(empty)'}" on role ${name} resource ${resName}`);
          }
        }
      }
    }
  }
}

function validateSolutionBundle(bundle) {
  const errors = [];
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
    return { valid: false, errors: ['Bundle must be a JSON object'] };
  }
  let serializedLen = 0;
  try {
    const serialized = JSON.stringify(bundle);
    if (typeof serialized !== 'string') {
      return { valid: false, errors: ['Bundle must be JSON-serializable'] };
    }
    serializedLen = serialized.length;
  } catch (err) {
    return { valid: false, errors: [`Bundle is not JSON-serializable: ${err?.message || 'circular or invalid value'}`] };
  }
  if (serializedLen > 5_000_000) {
    errors.push('Bundle exceeds maximum 5MB payload size');
  }
  if (!ACCEPTED_SCHEMA_VERSIONS.has(bundle.metadata?.schemaVersion)) {
    errors.push(`Unsupported schemaVersion; expected ${[...ACCEPTED_SCHEMA_VERSIONS].join(' or ')}`);
  }
  if (Array.isArray(bundle.roles)) {
    for (const r of bundle.roles) validateRoleEntry(r, errors);
  }
  if (Array.isArray(bundle.portals)) {
    for (const p of bundle.portals) {
      const uid = String(p?.uid || '');
      if (!SAFE_PORTAL_UID_RE.test(uid)) {
        errors.push(`Portal UID must match ${SAFE_PORTAL_UID_RE}: ${uid || '(empty)'}`);
      }
      if (p?.authCheck === false) {
        errors.push(`Disabling authCheck is forbidden on portal: ${uid}`);
      }
      if (p?.routePath !== undefined && !SAFE_ROUTE_PATH_RE.test(String(p.routePath || ''))) {
        errors.push(`Portal routePath must match ${SAFE_ROUTE_PATH_RE}: ${p.routePath}`);
      }
      if (p?.routeName !== undefined && !SAFE_ROUTE_NAME_RE.test(String(p.routeName || ''))) {
        errors.push(`Portal routeName must match ${SAFE_ROUTE_NAME_RE}: ${p.routeName}`);
      }
    }
  }
  if (Array.isArray(bundle.workflows)) {
    for (const w of bundle.workflows) {
      const wfKey = String(w?.key || w?.title || '').trim();
      if (!w || typeof w !== 'object' || !wfKey) {
        errors.push('Workflow entry must include key or title');
        continue;
      }
      if (w.nodes !== undefined) {
        errors.push(...validateWorkflowNodesDag(w.nodes, wfKey));
      }
    }
  }
  if (Array.isArray(bundle.customCollections)) {
    for (const c of bundle.customCollections) {
      const cname = String(c?.name || '');
      if (!CUSTOM_COLLECTION_RE.test(cname)) {
        errors.push(`Custom collection must match latticeCustom*: ${cname || '(empty)'}`);
      }
      if (Array.isArray(c?.fields)) {
        for (const f of c.fields) {
          const fname = String(f?.name || '').trim();
          if (!SAFE_FIELD_NAME_RE.test(fname)) {
            errors.push(`Invalid field name on ${cname}: ${fname || '(empty)'}`);
          }
        }
      }
    }
  }
  if (Array.isArray(bundle.aiProfiles)) {
    for (const p of bundle.aiProfiles) {
      const uname = String(p?.username || '').trim();
      if (!SAFE_USERNAME_RE.test(uname)) {
        errors.push(`Invalid AI profile username: ${uname || '(empty)'}`);
      }
      if (p?.toolPermissions !== undefined) {
        if (!p.toolPermissions || typeof p.toolPermissions !== 'object' || Array.isArray(p.toolPermissions)) {
          errors.push(`Invalid toolPermissions object on AI profile: ${uname || '(empty)'}`);
        } else {
          for (const [toolKey, rawMode] of Object.entries(p.toolPermissions)) {
            const toolName = String(toolKey || '').trim();
            if (!toolName) {
              errors.push(`Empty tool name in toolPermissions on AI profile: ${uname}`);
              continue;
            }
            const mode = typeof rawMode === 'string' ? rawMode.trim().toUpperCase() : '';
            if (!VALID_TOOL_PERMISSION_MODES.has(mode)) {
              errors.push(`Invalid toolPermissions mode "${String(rawMode)}" for "${toolName}" on AI profile ${uname}`);
            }
          }
        }
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

function diffSection(curItems = [], incItems = [], keyFn) {
  const curMap = new Map(curItems.map((item) => [String(keyFn(item)), JSON.stringify(stripSecretsDeep(item))]));
  const incMap = new Map(incItems.map((item) => [String(keyFn(item)), JSON.stringify(stripSecretsDeep(item))]));
  const added = [];
  const changed = [];
  const unchanged = [];
  const removed = [];
  for (const [k, v] of incMap.entries()) {
    if (!curMap.has(k)) added.push(k);
    else if (curMap.get(k) !== v) changed.push(k);
    else unchanged.push(k);
  }
  for (const k of curMap.keys()) {
    if (!incMap.has(k)) removed.push(k);
  }
  return { added, changed, unchanged, removed };
}

function flattenRoleResources(roles = []) {
  const out = [];
  for (const r of Array.isArray(roles) ? roles : []) {
    const roleName = r?.name;
    if (!roleName || !Array.isArray(r.resources)) continue;
    for (const res of r.resources) {
      if (!res?.name) continue;
      out.push({ roleName, ...res });
    }
  }
  return out;
}

function diffSolutionBundle(currentBundle, incomingBundle) {
  const cur = currentBundle || {};
  const inc = incomingBundle || {};
  const sections = {
    roles: diffSection(cur.roles, inc.roles, (r) => r?.name),
    portals: diffSection(cur.portals, inc.portals, (p) => p?.uid),
    workflows: diffSection(cur.workflows, inc.workflows, (w) => w?.key || w?.title),
    aiProfiles: diffSection(cur.aiProfiles, inc.aiProfiles, (p) => p?.username),
    customCollections: diffSection(cur.customCollections, inc.customCollections, (c) => c?.name),
  };
  const roleResources = diffSection(
    flattenRoleResources(cur.roles),
    flattenRoleResources(inc.roles),
    (rr) => `${rr.roleName}::${rr.dataSourceKey || 'main'}::${rr.name}`,
  );
  const summary = { added: 0, changed: 0, unchanged: 0, removed: 0 };
  for (const s of Object.values(sections)) {
    summary.added += s.added.length;
    summary.changed += s.changed.length;
    summary.unchanged += s.unchanged.length;
    summary.removed += s.removed.length;
  }
  return { summary, sections, roleResources };
}

async function upsertRoleAndResources(db, rawRole, transaction) {
  const cleanRole = stripSecretsDeep(rawRole);
  const roleName = String(cleanRole?.name || '').trim();
  if (!SAFE_ROLE_RE.test(roleName) || FORBIDDEN_ROLES.has(roleName)) return { roles: 0, resources: 0 };

  const roleRepo = db?.getRepository?.('roles');
  let rolesCount = 0;
  if (roleRepo) {
    const safeSnippets = Array.isArray(cleanRole.snippets)
      ? cleanRole.snippets
        .filter((s) => typeof s === 'string' && !isForbiddenSnippet(s))
        .map((s) => s.trim())
      : [];
    const values = {
      name: roleName,
      title: cleanRole.title || roleName,
      description: cleanRole.description || '',
      snippets: safeSnippets,
      allowAll: false,
      allowConfigure: false,
      allowNewMenu: false,
      allowNewAiEmployee: false,
      strategy: { actions: [] },
    };
    const existing = await findOneSafe(roleRepo, { name: roleName }, { transaction });
    if (existing) {
      if (typeof roleRepo.update === 'function') {
        await roleRepo.update({ filter: { name: roleName }, values, transaction });
      } else if (typeof existing.update === 'function') {
        await existing.update(values, { transaction });
      }
    } else if (typeof roleRepo.create === 'function') {
      await roleRepo.create({ values, transaction });
    }
    rolesCount = 1;
  }

  let resourcesCount = 0;
  const resRepo = db?.getRepository?.('dataSourcesRolesResources');
  if (resRepo && Array.isArray(cleanRole.resources)) {
    const dsRolesRepo = db?.getRepository?.('dataSourcesRoles');
    if (dsRolesRepo && typeof dsRolesRepo.create === 'function') {
      const hasDsRole = await findOneSafe(dsRolesRepo, { roleName, dataSourceKey: 'main' }, { transaction });
      if (!hasDsRole) {
        await dsRolesRepo.create({ values: { roleName, dataSourceKey: 'main' }, transaction });
      }
    }

    const incomingNames = new Set();
    const sanitizedResources = [];
    for (const rawRes of cleanRole.resources) {
      const resName = String(rawRes?.name || '').trim();
      if (!SAFE_RESOURCE_COLLECTION_RE.test(resName) || isProtectedCollection(resName)) continue;
      incomingNames.add(resName);
      sanitizedResources.push({
        roleName,
        name: resName,
        dataSourceKey: 'main',
        usingActionsConfig: true,
        actions: sanitizeRoleActionsList(rawRes.actions),
      });
    }

    if (typeof resRepo.find === 'function' && typeof resRepo.destroy === 'function') {
      const currentRes = (await resRepo.find({ filter: { roleName, dataSourceKey: 'main' }, transaction })) || [];
      for (const cur of currentRes) {
        const curName = val(cur, 'name');
        if (curName && SAFE_RESOURCE_COLLECTION_RE.test(String(curName).trim()) && !isProtectedCollection(curName) && !incomingNames.has(curName)) {
          await resRepo.destroy({ filter: { roleName, name: curName, dataSourceKey: 'main' }, transaction });
        }
      }
    }

    for (const resValues of sanitizedResources) {
      const filter = { roleName, name: resValues.name, dataSourceKey: 'main' };
      const existingRes = await findOneSafe(resRepo, filter, { transaction });
      if (existingRes) {
        if (typeof resRepo.update === 'function') {
          await resRepo.update({
            filter,
            values: { usingActionsConfig: true, actions: resValues.actions },
            updateAssociationValues: ['actions'],
            transaction,
          });
        } else if (typeof existingRes.update === 'function') {
          await existingRes.update({ usingActionsConfig: true, actions: resValues.actions }, { transaction });
        } else if (typeof resRepo.destroy === 'function' && typeof resRepo.create === 'function') {
          await resRepo.destroy({ filter, transaction });
          await resRepo.create({ values: resValues, transaction });
        }
      } else if (typeof resRepo.create === 'function') {
        await resRepo.create({ values: resValues, transaction });
      }
      resourcesCount += 1;
    }
  }

  return { roles: rolesCount, resources: resourcesCount };
}

async function applyPortalsSection(db, portalsList, transaction) {
  const layoutRepo = db?.getRepository?.('uiLayouts');
  if (!layoutRepo || !Array.isArray(portalsList)) return 0;
  if (typeof layoutRepo.create !== 'function' && typeof layoutRepo.update !== 'function') return 0;
  let portalsUpserted = 0;
  for (const rawPortal of portalsList) {
    const clean = stripSecretsDeep(rawPortal);
    if (!SAFE_PORTAL_UID_RE.test(String(clean?.uid || ''))) continue;
    const normalized = normalizePortalEntry(clean);
    const existing = await findOneSafe(layoutRepo, { uid: normalized.uid }, { transaction });
    if (existing) {
      if (typeof layoutRepo.update === 'function') {
        await layoutRepo.update({ filter: { uid: normalized.uid }, values: normalized, transaction });
      } else if (typeof existing.update === 'function') {
        await existing.update(normalized, { transaction });
      }
    } else if (typeof layoutRepo.create === 'function') {
      await layoutRepo.create({ values: normalized, transaction });
    }
    portalsUpserted += 1;
  }
  return portalsUpserted;
}

async function replaceWorkflowNodes(nodeRepo, workflowId, nodesList, transaction) {
  if (!nodeRepo || workflowId == null || !Array.isArray(nodesList)) return 0;
  if (typeof nodeRepo.create !== 'function') return 0;
  const dagErrors = validateWorkflowNodesDag(nodesList, String(workflowId));
  if (dagErrors.length > 0) {
    throw failBundle('INVALID_SOLUTION_BUNDLE', 400, dagErrors.join('; '));
  }
  if (typeof nodeRepo.destroy === 'function') {
    await nodeRepo.destroy({ filter: { workflowId }, transaction });
  }

  const createdByKey = new Map();
  const normalizedNodes = [];
  for (const rawNode of nodesList) {
    const cleanNode = stripSecretsDeep(rawNode);
    const key = String(cleanNode?.key || '').trim();
    if (!key) continue;
    normalizedNodes.push({
      key,
      type: cleanNode.type || 'condition',
      title: cleanNode.title || key,
      upstreamKey: cleanNode.upstreamKey ? String(cleanNode.upstreamKey).trim() : null,
      branchIndex: cleanNode.branchIndex ?? null,
      config: cleanNode.config && typeof cleanNode.config === 'object' ? cleanNode.config : {},
    });
  }

  for (const spec of normalizedNodes) {
    const baseValues = {
      workflowId,
      key: spec.key,
      type: spec.type,
      title: spec.title,
      config: spec.config,
      ...(spec.branchIndex != null ? { branchIndex: spec.branchIndex } : {}),
    };
    const existingNode = typeof nodeRepo.destroy === 'function'
      ? null
      : await findOneSafe(nodeRepo, { workflowId, key: spec.key }, { transaction });
    let savedNode = existingNode;
    if (existingNode) {
      if (typeof nodeRepo.update === 'function') {
        const updated = await nodeRepo.update({ filter: { workflowId, key: spec.key }, values: baseValues, transaction });
        savedNode = (Array.isArray(updated) ? updated[0] : updated) || existingNode;
      } else if (typeof existingNode.update === 'function') {
        await existingNode.update(baseValues, { transaction });
      }
    } else {
      savedNode = await nodeRepo.create({ values: baseValues, transaction });
    }
    createdByKey.set(spec.key, savedNode);
  }

  const patchNode = async (node, patch) => {
    const nodeId = val(node, 'id');
    if (typeof node?.update === 'function') {
      await node.update(patch, { transaction });
    } else if (typeof nodeRepo.update === 'function' && nodeId != null) {
      await nodeRepo.update({ filterByTk: nodeId, filter: { id: nodeId }, values: patch, transaction });
    }
  };

  for (const spec of normalizedNodes) {
    if (!spec.upstreamKey) continue;
    const curNode = createdByKey.get(spec.key);
    const upNode = createdByKey.get(spec.upstreamKey);
    const curId = val(curNode, 'id');
    const upId = val(upNode, 'id');
    if (!curNode || !upNode || upId == null) continue;
    await patchNode(curNode, { upstreamId: upId });
    if (spec.branchIndex == null && curId != null) {
      await patchNode(upNode, { downstreamId: curId });
    }
  }

  return normalizedNodes.length;
}

async function applyWorkflowsSection(db, workflowsList, { targetOrg, enableWorkflows }, transaction) {
  const wfRepo = db?.getRepository?.('workflows');
  const nodeRepo = db?.getRepository?.('flow_nodes');
  if (!wfRepo || !Array.isArray(workflowsList)) return { workflowsUpserted: 0, nodesUpserted: 0 };
  if (typeof wfRepo.create !== 'function' && typeof wfRepo.update !== 'function') {
    return { workflowsUpserted: 0, nodesUpserted: 0 };
  }

  let workflowsUpserted = 0;
  let nodesUpserted = 0;
  for (const rawWf of workflowsList) {
    const cleanWf = stripSecretsDeep(rawWf);
    const wfKey = String(cleanWf?.key || cleanWf?.title || '').trim();
    if (!wfKey) continue;
    const wfOptions = {
      ...(cleanWf.options && typeof cleanWf.options === 'object' && !Array.isArray(cleanWf.options) ? cleanWf.options : {}),
      ...(targetOrg ? { dxosOrganizationId: targetOrg } : {}),
    };
    const values = {
      key: wfKey,
      title: cleanWf.title || wfKey,
      type: cleanWf.type || 'collection',
      enabled: enableWorkflows === true ? Boolean(cleanWf.enabled) : false,
      current: true,
      sync: false,
      config: cleanWf.config && typeof cleanWf.config === 'object' && !Array.isArray(cleanWf.config) ? cleanWf.config : {},
      options: wfOptions,
    };

    let existing = null;
    if (typeof wfRepo.find === 'function') {
      const currentMatches = (await wfRepo.find({ filter: { key: wfKey, current: true }, transaction })) || [];
      const activeMatches = currentMatches.filter((w) => val(w, 'key') === wfKey && val(w, 'current') !== false);
      for (const candidate of activeMatches) {
        const opts = val(candidate, 'options');
        const cOrg = opts && typeof opts === 'object' ? String(opts.dxosOrganizationId || '').trim() : '';
        if (cOrg && targetOrg && cOrg !== targetOrg) {
          throw failBundle(
            'WORKFLOW_TENANT_CONFLICT',
            409,
            `Workflow "${wfKey}" đã thuộc tổ chức "${cOrg}", không thể ghi đè sang "${targetOrg}".`,
          );
        }
      }
      existing = activeMatches.find((w) => {
        const opts = val(w, 'options');
        const cOrg = opts && typeof opts === 'object' ? String(opts.dxosOrganizationId || '').trim() : '';
        return !targetOrg || !cOrg || cOrg === targetOrg;
      }) || null;
    }
    if (!existing) {
      let fallback = await findOneSafe(wfRepo, { key: wfKey, current: true }, { transaction });
      if (!fallback) fallback = await findOneSafe(wfRepo, { key: wfKey }, { transaction });
      if (fallback) {
        const opts = val(fallback, 'options');
        const existingOrg = opts && typeof opts === 'object' ? String(opts.dxosOrganizationId || '').trim() : '';
        if (existingOrg && targetOrg && existingOrg !== targetOrg) {
          throw failBundle(
            'WORKFLOW_TENANT_CONFLICT',
            409,
            `Workflow "${wfKey}" đã thuộc tổ chức "${existingOrg}", không thể ghi đè sang "${targetOrg}".`,
          );
        }
        if (val(fallback, 'current') !== false) {
          existing = fallback;
        }
      }
    }

    let wfId = val(existing, 'id');
    if (existing) {
      if (wfId != null && typeof wfRepo.update === 'function') {
        await wfRepo.update({ filterByTk: wfId, values, transaction });
      } else if (typeof existing.update === 'function') {
        await existing.update(values, { transaction });
      }
    } else if (typeof wfRepo.create === 'function') {
      const created = await wfRepo.create({ values, transaction });
      wfId = val(created, 'id');
    }
    workflowsUpserted += 1;

    if (Array.isArray(cleanWf.nodes) && wfId != null) {
      nodesUpserted += await replaceWorkflowNodes(nodeRepo, wfId, cleanWf.nodes, transaction);
    }
  }
  return { workflowsUpserted, nodesUpserted };
}

async function applyCustomCollectionsSection(db, collectionsList, targetOrg, transaction) {
  const colsRepo = db?.getRepository?.('collections');
  if (!colsRepo || !Array.isArray(collectionsList)) return 0;
  if (typeof colsRepo.create !== 'function' && typeof colsRepo.update !== 'function') return 0;
  const fieldsRepo = db?.getRepository?.('fields');
  let customCollectionsUpserted = 0;

  const txOpts = transaction ? { transaction } : {};

  for (const rawCol of collectionsList) {
    const cleanCol = stripSecretsDeep(rawCol);
    const cname = String(cleanCol?.name || '').trim();
    if (!CUSTOM_COLLECTION_RE.test(cname)) continue;

    const clampedOrgField = {
      name: 'organizationId',
      type: 'string',
      interface: 'input',
      allowNull: false,
      defaultValue: targetOrg || 'native-ui-lab',
      uiSchema: { type: 'string', title: 'Mã tổ chức' },
    };
    const rawNormalizedFields = (Array.isArray(cleanCol.fields) ? cleanCol.fields : [])
      .map(sanitizeCustomField)
      .filter(Boolean)
      .map((f) => {
        if (f.name === 'organizationId') {
          return {
            ...f,
            ...clampedOrgField,
            uiSchema: {
              ...(f.uiSchema && typeof f.uiSchema === 'object' ? f.uiSchema : {}),
              ...clampedOrgField.uiSchema,
            },
          };
        }
        return {
          ...f,
          interface: f.interface || inferFieldInterface(f.type),
        };
      });
    const normalizedFields = rawNormalizedFields.some((f) => f.name === 'organizationId')
      ? rawNormalizedFields
      : [clampedOrgField, ...rawNormalizedFields];

    const existing = await findOneSafe(colsRepo, { name: cname }, { appends: ['fields'], transaction });
    const options = { titleField: 'name', uiManageable: true, ...(cleanCol.options || {}) };
    if (existing) {
      const existingFields = Array.isArray(val(existing, 'fields')) ? val(existing, 'fields').map(toObj) : [];
      const existingNames = new Set(existingFields.map((f) => f.name));
      const missingFields = normalizedFields.filter((f) => !existingNames.has(f.name));

      if (fieldsRepo && typeof fieldsRepo.create === 'function') {
        for (const mf of missingFields) {
          const cf = await fieldsRepo.create({ values: { ...mf, collectionName: cname }, transaction });
          if (typeof cf?.load === 'function') await cf.load(txOpts);
        }
      }
      const nextValues = {
        title: cleanCol.title || cname,
        options,
        ...(!fieldsRepo && missingFields.length ? { fields: [...existingFields, ...missingFields] } : {}),
      };
      if (typeof colsRepo.update === 'function') {
        await colsRepo.update({ filter: { name: cname }, values: nextValues, transaction });
      } else if (typeof existing.update === 'function') {
        await existing.update(nextValues, { transaction });
      }
      if (typeof existing.load === 'function') await existing.load({ resetFields: true, ...txOpts });
    } else if (typeof colsRepo.create === 'function') {
      const created = await colsRepo.create({
        values: {
          name: cname,
          title: cleanCol.title || cname,
          autoGenId: true,
          createdAt: true,
          updatedAt: true,
          options,
          fields: normalizedFields,
        },
        transaction,
      });
      if (typeof created?.load === 'function') await created.load({ resetFields: true, ...txOpts });
    }

    const colInst = db?.getCollection?.(cname);
    if (colInst && typeof colInst.sync === 'function') {
      await colInst.sync({ force: false, alter: { drop: false }, ...txOpts });
    }
    customCollectionsUpserted += 1;
  }
  return customCollectionsUpserted;
}

async function applyAiProfilesSection(db, profilesList, targetOrg, transaction) {
  const aiRepo = db?.getRepository?.('latticeAiProfiles');
  if (!aiRepo || !Array.isArray(profilesList)) return 0;
  let aiProfilesUpserted = 0;

  for (const rawProf of profilesList) {
    const clean = stripSecretsDeep(rawProf);
    if (!clean?.username) continue;
    const scopedOrg = targetOrg || clean.organizationId || 'native-ui-lab';
    const isAdminBuilder = clean.isAdminBuilder === true;
    const rawTools = Array.isArray(clean.tools) ? clean.tools.map((t) => String(t || '').trim()).filter(Boolean) : [];
    const safeTools = isAdminBuilder ? rawTools : rawTools.filter((t) => !isAdminBuilderTool(t));
    const sanitizedToolPermissions = sanitizeToolPermissions(clean.toolPermissions, isAdminBuilder);

    const values = {
      username: clean.username,
      nickname: clean.nickname || clean.username,
      position: clean.position || '',
      organizationId: scopedOrg,
      enabled: clean.enabled !== false,
      isAdminBuilder,
      systemPrompt: clean.systemPrompt || '',
      tools: safeTools,
      ...(!isAdminBuilder || (clean.toolPermissions && typeof clean.toolPermissions === 'object' && !Array.isArray(clean.toolPermissions))
        ? { toolPermissions: sanitizedToolPermissions }
        : {}),
      ...(Array.isArray(clean.allowedRoles)
        ? { allowedRoles: isAdminBuilder ? ['root', 'admin'] : [...new Set(clean.allowedRoles.filter(Boolean))] }
        : isAdminBuilder
          ? { allowedRoles: ['root', 'admin'] }
          : {}),
      ...(clean.departmentScope ? { departmentScope: clean.departmentScope } : {}),
      ...(clean.llmService ? { llmService: clean.llmService } : {}),
      ...(clean.modelName ? { modelName: clean.modelName } : {}),
      ...(clean.allowSubAgentDispatch !== undefined ? { allowSubAgentDispatch: Boolean(clean.allowSubAgentDispatch) } : {}),
      ...(Array.isArray(clean.portalBindings) ? { portalBindings: [...clean.portalBindings] } : {}),
      ...(Array.isArray(clean.quickPrompts) ? { quickPrompts: clean.quickPrompts } : {}),
      ...(clean.greeting ? { greeting: clean.greeting } : {}),
      ...(clean.bio ? { bio: clean.bio } : {}),
      ...(clean.avatar ? { avatar: clean.avatar } : {}),
    };

    const existing = await findOneSafe(aiRepo, { username: clean.username, organizationId: scopedOrg }, { transaction });
    if (existing) {
      const id = val(existing, 'id');
      if (typeof aiRepo.update === 'function') {
        await aiRepo.update({ filterByTk: id, filter: { id }, values, transaction });
      } else if (typeof existing.update === 'function') {
        await existing.update(values, { transaction });
      }
    } else if (typeof aiRepo.create === 'function') {
      await aiRepo.create({ values, transaction });
    }
    aiProfilesUpserted += 1;
  }
  return aiProfilesUpserted;
}

async function applySolutionBundleSections(db, bundle, { targetOrg = null, enableWorkflows = false } = {}, transaction) {
  let rolesUpserted = 0;
  let roleResourcesUpserted = 0;
  if (Array.isArray(bundle.roles)) {
    for (const rawRole of bundle.roles) {
      const counts = await upsertRoleAndResources(db, rawRole, transaction);
      rolesUpserted += counts.roles;
      roleResourcesUpserted += counts.resources;
    }
  }

  const portalsUpserted = await applyPortalsSection(db, bundle.portals, transaction);
  const wfCounts = await applyWorkflowsSection(db, bundle.workflows, { targetOrg, enableWorkflows }, transaction);
  const customCollectionsUpserted = await applyCustomCollectionsSection(db, bundle.customCollections, targetOrg, transaction);
  const aiProfilesUpserted = await applyAiProfilesSection(db, bundle.aiProfiles, targetOrg, transaction);

  return {
    rolesUpserted,
    roleResourcesUpserted,
    portalsUpserted,
    workflowsUpserted: wfCounts.workflowsUpserted,
    nodesUpserted: wfCounts.nodesUpserted,
    customCollectionsUpserted,
    aiProfilesUpserted,
  };
}

function pickLatestSnapshotRow(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  return rows.reduce((best, cur) => {
    if (!best) return cur;
    const bestId = Number(val(best, 'id'));
    const curId = Number(val(cur, 'id'));
    if (Number.isFinite(bestId) && Number.isFinite(curId)) {
      return curId > bestId ? cur : best;
    }
    const bestAt = String(val(best, 'createdAt') || '');
    const curAt = String(val(cur, 'createdAt') || '');
    return curAt >= bestAt ? cur : best;
  }, null);
}

async function importSolutionBundle(db, incomingBundle, { dryRun = true, organizationId = null, enableWorkflows = false } = {}) {
  const validation = validateSolutionBundle(incomingBundle);
  if (!validation.valid) {
    throw failBundle('INVALID_SOLUTION_BUNDLE', 400, validation.errors.join('; '));
  }
  const rawOrg = organizationId != null ? String(organizationId).trim() : '';
  const metaOrg = incomingBundle.metadata?.organizationId != null
    ? String(incomingBundle.metadata.organizationId).trim()
    : '';
  const targetOrg = (rawOrg && rawOrg !== 'all' ? rawOrg : null)
    || (metaOrg && metaOrg !== 'all' ? metaOrg : null);
  const current = await exportSolutionBundle(db, { organizationId: targetOrg });
  const diff = diffSolutionBundle(current, incomingBundle);
  if (dryRun !== false) {
    return { dryRun: true, valid: true, diff, applied: null };
  }

  const generatedSnapshotUid = `gitops-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`;
  let savedSnapshotUid = null;
  let applied = null;

  const runApply = async (transaction) => {
    const snapRepo = db?.getRepository?.('latticeUiSnapshots');
    if (snapRepo && typeof snapRepo.create === 'function') {
      await snapRepo.create({
        values: {
          snapshotUid: generatedSnapshotUid,
          portalSlug: SNAPSHOT_PORTAL_SLUG,
          pageTitle: targetOrg || 'all',
          note: 'Pre-import GitOps Solution Bundle snapshot',
          layoutState: current,
          blocks: [],
        },
        transaction,
      });
      savedSnapshotUid = generatedSnapshotUid;
    }

    applied = await applySolutionBundleSections(
      db,
      incomingBundle,
      { targetOrg, enableWorkflows: enableWorkflows === true },
      transaction,
    );
  };

  await runInTransaction(db, runApply);

  return {
    dryRun: false,
    valid: true,
    snapshotUid: savedSnapshotUid,
    diff,
    applied,
  };
}

async function rollbackLastSolutionBundle(db, { organizationId = null, snapshotUid = '' } = {}) {
  const snapRepo = db?.getRepository?.('latticeUiSnapshots');
  if (!snapRepo) {
    throw failBundle('GITOPS_SNAPSHOT_NOT_FOUND', 404, 'Không tìm thấy kho snapshot latticeUiSnapshots để hoàn tác.');
  }

  const reqOrg = organizationId != null ? String(organizationId).trim() : '';
  const wantedUid = String(snapshotUid || '').trim();
  let targetSnap = null;
  if (wantedUid) {
    const candidate = await findOneSafe(snapRepo, { snapshotUid: wantedUid });
    if (candidate && val(candidate, 'portalSlug') === SNAPSHOT_PORTAL_SLUG) {
      if (reqOrg) {
        const candidateOrg = String(val(candidate, 'pageTitle') || '').trim();
        if (!candidateOrg || candidateOrg !== reqOrg) {
          throw failBundle('GITOPS_SNAPSHOT_NOT_FOUND', 404, 'Không tìm thấy snapshot GitOps thuộc tổ chức được yêu cầu để hoàn tác.');
        }
      }
      targetSnap = candidate;
    }
  } else if (typeof snapRepo.find === 'function') {
    if (reqOrg) {
      const orgRows = (await snapRepo.find({
        filter: { portalSlug: SNAPSHOT_PORTAL_SLUG, pageTitle: reqOrg },
        sort: ['-id'],
        limit: 50,
      })) || [];
      const matchingRows = orgRows.filter(
        (r) => val(r, 'portalSlug') === SNAPSHOT_PORTAL_SLUG && String(val(r, 'pageTitle') || '').trim() === reqOrg,
      );
      targetSnap = pickLatestSnapshotRow(matchingRows);
    } else {
      const anyRows = (await snapRepo.find({
        filter: { portalSlug: SNAPSHOT_PORTAL_SLUG },
        sort: ['-id'],
        limit: 50,
      })) || [];
      const matchingRows = anyRows.filter((r) => val(r, 'portalSlug') === SNAPSHOT_PORTAL_SLUG);
      targetSnap = pickLatestSnapshotRow(matchingRows);
    }
  }

  if (!targetSnap) {
    throw failBundle('GITOPS_SNAPSHOT_NOT_FOUND', 404, 'Không tìm thấy snapshot GitOps nào để hoàn tác.');
  }

  const snapshotBundle = val(targetSnap, 'layoutState');
  const validation = validateSolutionBundle(snapshotBundle);
  if (!validation.valid) {
    throw failBundle('INVALID_SOLUTION_BUNDLE', 400, `Snapshot không hợp lệ: ${validation.errors.join('; ')}`);
  }

  const snapPageTitle = String(val(targetSnap, 'pageTitle') || '').trim();
  const snapMetaOrg = String(snapshotBundle.metadata?.organizationId || '').trim();
  if (reqOrg && reqOrg !== 'all' && snapMetaOrg && snapMetaOrg !== 'all' && snapMetaOrg !== reqOrg) {
    throw failBundle('GITOPS_SNAPSHOT_NOT_FOUND', 404, 'Snapshot không khớp phạm vi tổ chức yêu cầu.');
  }

  const targetOrg = (reqOrg && reqOrg !== 'all' ? reqOrg : null)
    || (snapPageTitle && snapPageTitle !== 'all' ? snapPageTitle : null)
    || (snapMetaOrg && snapMetaOrg !== 'all' ? snapMetaOrg : null);

  let restored = null;
  await runInTransaction(db, async (transaction) => {
    restored = await applySolutionBundleSections(
      db,
      snapshotBundle,
      { targetOrg, enableWorkflows: true },
      transaction,
    );
  });

  return {
    rolledBack: true,
    snapshotUid: val(targetSnap, 'snapshotUid'),
    restored,
  };
}

module.exports = {
  BUNDLE_SCHEMA_VERSION,
  ACCEPTED_SCHEMA_VERSIONS,
  stripSecretsDeep,
  exportSolutionBundle,
  validateSolutionBundle,
  diffSolutionBundle,
  importSolutionBundle,
  rollbackLastSolutionBundle,
};
