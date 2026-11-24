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
const net = require('node:net');

const BUNDLE_SCHEMA_VERSION = 'latticedx.solution-bundle/v3';
const ACCEPTED_SCHEMA_VERSIONS = new Set([
  'latticedx.solution-bundle/v1',
  'latticedx.solution-bundle/v2',
  'latticedx.solution-bundle/v3',
]);
const DEFAULT_PLATFORM_VERSION = '1.0.0';
const FORBIDDEN_ROLES = new Set(['root', 'admin', 'ldx_admin']);
const SAFE_ROLE_RE = /^ldx_[a-z0-9_]{2,48}$/;
const SAFE_PORTAL_UID_RE = /^ldx-portal-[a-z0-9-]+$/;
const SAFE_MANAGED_LAYOUT_UID_RE = /^(?:ldx-portal-[a-z0-9-]+|dxos-[a-z0-9-]+)$/;
const RESERVED_SYSTEM_LAYOUT_UIDS = new Set(['admin-layout-model', 'mobile-layout-model']);
const SAFE_MODEL_UID_RE = /^[a-zA-Z0-9_.:-]{1,120}$/;
const SAFE_ORG_ID_RE = /^[a-zA-Z0-9_-]{1,80}$/;
const SAFE_DMN_KEY_RE = /^[a-zA-Z0-9_-]{2,80}$/;
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
const FORBIDDEN_PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const UNSAFE_CODE_KEY_RE = /^(?:jsCode|script|customScript|customCode|evalCode|runJs|renderScript|dangerouslySetInnerHTML|innerHTML|outerHTML|srcdoc|jsSettings|scriptSettings)$/i;
const UNSAFE_XSS_VALUE_RE = /(?:<\s*\/?\s*(?:script|iframe|object|embed|svg)\b|\bjavascript\s*:|\bvbscript\s*:|\bdata\s*:\s*text\/html|\bon(?:error|load|click|dblclick|auxclick|mouseover|mouseenter|mouseleave|mouseout|mousedown|mouseup|pointerenter|pointerover|pointerdown|focus|focusin|blur|submit|reset|toggle|input|change|keydown|keyup|keypress|animationstart|animationend|transitionend|wheel|scroll|drag|drop|copy|paste|contextmenu)\s*=)/i;
const UNSAFE_SCHEME_NORMALIZED_RE = /(?:javascript:|vbscript:|data:text\/html)/i;
const MAX_PROTO_DEPTH = 32;
const MAX_XSS_DEPTH = 30;
const MAX_STRIP_DEPTH = 48;
const ALLOWED_ROUTE_TYPES = new Set(['group', 'flowPage', 'page', 'tabs', 'link']);
const ALLOWED_FLOW_MODEL_USES = new Set([
  'DxosPortalHeroBlockModel', 'DxosKpiMetricBlockModel', 'DxosContextTelemetryBlockModel',
  'DxosAiProposalBlockModel', 'DxosWorkflowTasksBlockModel', 'DxosParaVaultBlockModel',
  'DxosCreativeStudioBlockModel', 'DxosRecordWorkbenchBlockModel',
  'DxosWebGisBlockModel', 'DxosKanbanScheduleBlockModel',
  'LatticeFormBlockModel', 'LatticeListBlockModel', 'LatticeTaskInboxBlockModel',
  'LatticeApprovalBlockModel', 'LatticeAttachmentBlockModel', 'LatticeActivityTimelineBlockModel',
  'LatticeContextEntityBlockModel', 'LatticeWorkflowFormBlockModel',
  'RootPageModel', 'PageModel', 'PageTabModel', 'TabsModel', 'TabsTabPaneModel',
  'BlockGridModel', 'GridModel', 'RootGridModel', 'FormGridModel', 'CardBlockModel', 'ActionPanelModel',
  'TableBlockModel', 'CreateFormModel', 'EditFormModel', 'DetailsBlockModel', 'DetailsModel',
  'FilterFormModel', 'FilterFormBlockModel', 'KanbanBlockModel', 'ChartBlockModel',
  'CalendarBlockModel', 'ListBlockModel', 'GridCardBlockModel', 'MarkdownBlockModel',
  'MarkdownVoidBlockModel', 'FormModel', 'TableColumnModel', 'TableActionsColumnModel',
  'ActionModel', 'FieldModel', 'DisplayFieldModel', 'FormFieldModel', 'FilterFormFieldModel',
  'NativeTableBlock', 'NativeFormBlock', 'NativeDetailsBlock', 'BlockModel',
  'table', 'createForm', 'editForm', 'details', 'filterForm', 'kanban', 'chart', 'calendar', 'list', 'gridCard', 'markdown', 'actionPanel',
]);
const VALID_HIT_POLICIES = new Set(['FIRST', 'COLLECT']);
const VALID_SLA_PRIORITIES = new Set(['critical', 'high', 'normal', 'medium', 'low']);
const VALID_INCIDENT_SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);
const VALID_RULE_OPERATORS = new Set([
  '>', '>=', '<', '<=', '==', '===', '!=', '!==',
  'gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'between', 'in', 'not_in', 'contains',
]);
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

function hasUnsafeXssValue(raw) {
  if (typeof raw !== 'string') return false;
  if (UNSAFE_XSS_VALUE_RE.test(raw)) return true;
  const noCtrl = raw.replace(/[\u0000-\u001f\u007f]+/g, '');
  if (UNSAFE_XSS_VALUE_RE.test(noCtrl)) return true;
  const collapsed = raw.replace(/[\u0000-\u0020\u007f]+/g, '');
  return UNSAFE_SCHEME_NORMALIZED_RE.test(collapsed);
}

function parseStrictIntInRange(raw, min, max) {
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw >= min && raw <= max ? raw : null;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!/^-?\d+$/.test(trimmed)) return null;
    const n = Number(trimmed);
    return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
  }
  return null;
}

function getRouteKey(r) {
  return String(r?.key || r?.schemaUid || r?.uid || r?.title || '').trim();
}

function getScopedRouteKey(r) {
  const layoutUid = String(r?.layoutUid || '').trim();
  const key = getRouteKey(r);
  return layoutUid && key ? `${layoutUid}::${key}` : key;
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
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return value;
  if (depth > MAX_STRIP_DEPTH) {
    throw failBundle('INVALID_SOLUTION_BUNDLE', 400, `Maximum object nesting depth (${MAX_STRIP_DEPTH}) exceeded`);
  }
  if (Array.isArray(value)) return value.map((item) => stripSecretsDeep(item, depth + 1));
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (FORBIDDEN_PROTO_KEYS.has(key)) continue;
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

function buildStableRouteKey(routeObj, layoutUid, byId, keyCache = new Map(), visiting = new Set()) {
  const rid = routeObj?.id != null ? String(routeObj.id) : '';
  if (rid && keyCache.has(rid)) return keyCache.get(rid);
  const explicit = String(routeObj?.key || routeObj?.schemaUid || routeObj?.uid || '').trim();
  if (explicit) {
    if (rid) keyCache.set(rid, explicit);
    return explicit;
  }
  let parentKey = '';
  const pid = routeObj?.parentId != null ? String(routeObj.parentId) : '';
  if (pid && byId && byId.has(pid) && !visiting.has(pid)) {
    if (rid) visiting.add(rid);
    parentKey = buildStableRouteKey(byId.get(pid), layoutUid, byId, keyCache, visiting);
    if (rid) visiting.delete(rid);
  }
  const type = String(routeObj?.type || 'page').trim();
  const title = String(routeObj?.title || '').trim();
  const computed = `${layoutUid}:${type}:${parentKey ? `${parentKey}:` : ''}${title || 'untitled'}`;
  if (rid) keyCache.set(rid, computed);
  return computed;
}

function extractRouteLayoutUids(r) {
  const out = [];
  const directA = r?.uiLayoutUid != null ? String(r.uiLayoutUid).trim() : '';
  const directB = r?.layoutUid != null ? String(r.layoutUid).trim() : '';
  if (directA) out.push(directA);
  if (directB && directB !== directA) out.push(directB);
  if (Array.isArray(r?.uiLayouts)) {
    for (const l of r.uiLayouts) {
      const lUid = String(val(l, 'uid') || val(l, 'uiLayoutUid') || '').trim();
      if (lUid && !out.includes(lUid)) out.push(lUid);
    }
  }
  return out;
}

function isManagedLayoutUid(uid) {
  return Boolean(uid) && !RESERVED_SYSTEM_LAYOUT_UIDS.has(uid) && SAFE_MANAGED_LAYOUT_UID_RE.test(uid);
}

function extractGridChildUidsFromModel(modelObj) {
  const out = [];
  const rowsSources = [
    modelObj?.props?.rows,
    modelObj?.stepParams?.gridSettings?.grid?.rows,
  ];
  for (const rows of rowsSources) {
    if (!rows || typeof rows !== 'object' || Array.isArray(rows)) continue;
    for (const cols of Object.values(rows)) {
      if (!Array.isArray(cols)) continue;
      for (const col of cols) {
        for (const uid of Array.isArray(col) ? col : []) {
          if (typeof uid === 'string' && uid.trim()) out.push(uid.trim());
        }
      }
    }
  }
  return out;
}

function analyzeDbRoutesAndModels({ rawPortals = [], rawRoutes = [], rawLinks = [], rawModels = [] }) {
  const managedLayouts = new Set();
  const nonManagedLayoutUids = new Set(RESERVED_SYSTEM_LAYOUT_UIDS);
  const linksByLayout = new Map();
  const routeEffectiveManagedLayouts = new Map();
  const unmanagedRouteIds = new Set();
  const routesById = new Map();

  for (const p of rawPortals) {
    const uid = String(p?.uid || '').trim();
    if (!uid) continue;
    if (isManagedLayoutUid(uid)) managedLayouts.add(uid);
    else nonManagedLayoutUids.add(uid);
  }

  const markRouteLayout = (rid, uid) => {
    if (!uid) return;
    if (isManagedLayoutUid(uid)) {
      managedLayouts.add(uid);
      if (rid) {
        if (!routeEffectiveManagedLayouts.has(rid)) routeEffectiveManagedLayouts.set(rid, new Set());
        routeEffectiveManagedLayouts.get(rid).add(uid);
      }
    } else {
      nonManagedLayoutUids.add(uid);
      if (rid) unmanagedRouteIds.add(rid);
    }
  };

  for (const link of rawLinks) {
    const uid = String(link?.uiLayoutUid || '').trim();
    const rid = link?.desktopRouteId != null ? String(link.desktopRouteId) : '';
    if (!uid) continue;
    if (isManagedLayoutUid(uid)) {
      managedLayouts.add(uid);
      if (rid) {
        if (!linksByLayout.has(uid)) linksByLayout.set(uid, new Set());
        linksByLayout.get(uid).add(rid);
        markRouteLayout(rid, uid);
      }
    } else {
      nonManagedLayoutUids.add(uid);
      if (rid) unmanagedRouteIds.add(rid);
    }
  }

  const unlinkedIdentifiers = new Set();
  for (const r of rawRoutes) {
    if (!r) continue;
    const rid = r.id != null ? String(r.id) : '';
    if (rid) routesById.set(rid, r);
    const uids = extractRouteLayoutUids(r);
    if (!rid) {
      const hasManaged = uids.some(isManagedLayoutUid);
      const hasUnmanaged = uids.some((u) => !isManagedLayoutUid(u));
      if (!hasManaged || hasUnmanaged) {
        if (r.schemaUid) unlinkedIdentifiers.add(String(r.schemaUid).trim());
        if (r.menuSchemaUid) unlinkedIdentifiers.add(String(r.menuSchemaUid).trim());
        if (r.key) unlinkedIdentifiers.add(String(r.key).trim());
      }
      continue;
    }
    for (const uid of uids) {
      markRouteLayout(rid, uid);
    }
  }

  let grewUnmanagedRoutes = true;
  while (grewUnmanagedRoutes) {
    grewUnmanagedRoutes = false;
    for (const r of rawRoutes) {
      const rid = r?.id != null ? String(r.id) : '';
      const pid = r?.parentId != null ? String(r.parentId) : '';
      if (rid && pid && unmanagedRouteIds.has(pid) && !unmanagedRouteIds.has(rid)) {
        unmanagedRouteIds.add(rid);
        grewUnmanagedRoutes = true;
      }
    }
  }

  let grewManagedRoutes = true;
  while (grewManagedRoutes) {
    grewManagedRoutes = false;
    for (const r of rawRoutes) {
      const rid = r?.id != null ? String(r.id) : '';
      const pid = r?.parentId != null ? String(r.parentId) : '';
      if (!rid || unmanagedRouteIds.has(rid) || !pid || unmanagedRouteIds.has(pid)) continue;
      const parentLayouts = routeEffectiveManagedLayouts.get(pid);
      if (!parentLayouts || parentLayouts.size === 0) continue;
      let cur = routeEffectiveManagedLayouts.get(rid);
      if (!cur) {
        cur = new Set();
        routeEffectiveManagedLayouts.set(rid, cur);
      }
      for (const lUid of parentLayouts) {
        if (!cur.has(lUid)) {
          cur.add(lUid);
          grewManagedRoutes = true;
        }
      }
    }
  }

  for (const r of rawRoutes) {
    const rid = r?.id != null ? String(r.id) : '';
    if (!rid) continue;
    const layouts = routeEffectiveManagedLayouts.get(rid);
    if (!layouts || layouts.size === 0) {
      unmanagedRouteIds.add(rid);
    }
  }

  const unmanagedSchemaUids = new Set(unlinkedIdentifiers);
  const unmanagedModelUids = new Set(nonManagedLayoutUids);
  const managedRouteModelSeeds = new Set();

  for (const r of rawRoutes) {
    const rid = r?.id != null ? String(r.id) : '';
    const isUnmanaged = !rid || unmanagedRouteIds.has(rid);
    if (isUnmanaged) {
      if (r?.schemaUid) {
        const s = String(r.schemaUid).trim();
        unmanagedSchemaUids.add(s);
        unmanagedModelUids.add(s);
      }
      if (r?.menuSchemaUid) {
        const ms = String(r.menuSchemaUid).trim();
        unmanagedSchemaUids.add(ms);
        unmanagedModelUids.add(ms);
      }
      if (r?.key) unmanagedSchemaUids.add(String(r.key).trim());
    } else {
      if (r?.schemaUid) managedRouteModelSeeds.add(String(r.schemaUid).trim());
      if (r?.menuSchemaUid) managedRouteModelSeeds.add(String(r.menuSchemaUid).trim());
    }
  }

  const existingModelsByUid = new Map();
  for (const m of rawModels) {
    const uid = String(m?.uid || '').trim();
    if (uid) existingModelsByUid.set(uid, m);
  }

  let grewUnmanagedModels = true;
  while (grewUnmanagedModels) {
    grewUnmanagedModels = false;
    for (const m of rawModels) {
      const uid = String(m?.uid || '').trim();
      const pid = m?.parentId != null ? String(m.parentId).trim() : '';
      if (!uid) continue;
      if (pid && unmanagedModelUids.has(pid) && !unmanagedModelUids.has(uid)) {
        unmanagedModelUids.add(uid);
        grewUnmanagedModels = true;
      }
      if (unmanagedModelUids.has(uid)) {
        for (const childUid of extractGridChildUidsFromModel(m)) {
          if (!unmanagedModelUids.has(childUid)) {
            unmanagedModelUids.add(childUid);
            grewUnmanagedModels = true;
          }
        }
      }
    }
  }

  const managedModelUids = new Set();
  for (const s of managedRouteModelSeeds) {
    if (s && !unmanagedModelUids.has(s)) managedModelUids.add(s);
  }

  const propagateManagedModels = () => {
    let grew = true;
    while (grew) {
      grew = false;
      for (const m of rawModels) {
        const uid = String(m?.uid || '').trim();
        const pid = m?.parentId != null ? String(m.parentId).trim() : '';
        if (!uid || unmanagedModelUids.has(uid)) continue;
        if (pid && managedModelUids.has(pid) && !managedModelUids.has(uid)) {
          managedModelUids.add(uid);
          grew = true;
        }
        if (managedModelUids.has(uid)) {
          for (const childUid of extractGridChildUidsFromModel(m)) {
            if (!unmanagedModelUids.has(childUid) && !managedModelUids.has(childUid)) {
              managedModelUids.add(childUid);
              grew = true;
            }
          }
        }
      }
    }
  };
  propagateManagedModels();

  const childOfNonManagedModelUids = new Set();
  for (const m of rawModels) {
    const uid = String(m?.uid || '').trim();
    if (!uid || managedModelUids.has(uid)) continue;
    for (const childUid of extractGridChildUidsFromModel(m)) {
      childOfNonManagedModelUids.add(childUid);
    }
  }

  let addedDetachedDxos = false;
  for (const m of rawModels) {
    const uid = String(m?.uid || '').trim();
    const pid = m?.parentId != null ? String(m.parentId).trim() : '';
    if (!uid || unmanagedModelUids.has(uid) || managedModelUids.has(uid)) continue;
    if (!/^dxos-[a-z0-9_.:-]+$/i.test(uid)) continue;
    if (childOfNonManagedModelUids.has(uid)) continue;
    if (pid && (unmanagedModelUids.has(pid) || unmanagedSchemaUids.has(pid) || (existingModelsByUid.has(pid) && !managedModelUids.has(pid)))) {
      continue;
    }
    managedModelUids.add(uid);
    addedDetachedDxos = true;
  }
  if (addedDetachedDxos) propagateManagedModels();

  return {
    managedLayouts,
    nonManagedLayoutUids,
    linksByLayout,
    routeEffectiveManagedLayouts,
    unmanagedRouteIds,
    unmanagedSchemaUids,
    unmanagedModelUids,
    managedModelUids,
    existingModelsByUid,
    routesById,
  };
}

async function exportRoutesAndBlocksSection(db, rawPortals) {
  const rawRoutes = (await safeRepoFind(db, 'desktopRoutes', { limit: 1000, appends: ['uiLayouts'] })).map(toObj);
  const rawLinks = (await safeRepoFind(db, 'desktopRoutesUiLayouts', { limit: 2000 })).map(toObj);
  const rawGrants = (await safeRepoFind(db, 'rolesDesktopRoutes', { limit: 2000 })).map(toObj);
  const rawModels = (await safeRepoFind(db, 'flowModels', { limit: 2000 })).map(toObj);

  const analysis = analyzeDbRoutesAndModels({
    rawPortals: (rawPortals || []).map(toObj),
    rawRoutes,
    rawLinks,
    rawModels,
  });

  const grantsByRouteId = new Map();
  for (const g of rawGrants) {
    const rid = g.desktopRouteId != null ? String(g.desktopRouteId) : '';
    const roleName = String(g.roleName || '').trim();
    if (!rid || !SAFE_ROLE_RE.test(roleName) || FORBIDDEN_ROLES.has(roleName)) continue;
    if (!grantsByRouteId.has(rid)) grantsByRouteId.set(rid, new Set());
    grantsByRouteId.get(rid).add(roleName);
  }

  const normalizedRoutes = [];
  const seenRouteKeys = new Set();

  for (const layoutUid of [...analysis.managedLayouts].sort()) {
    const inLayout = rawRoutes.filter((r) => {
      const rid = r?.id != null ? String(r.id) : '';
      if (!rid || analysis.unmanagedRouteIds.has(rid)) return false;
      const layouts = analysis.routeEffectiveManagedLayouts.get(rid);
      return layouts && layouts.has(layoutUid);
    });
    const byId = new Map(inLayout.map((r) => [String(r.id), r]));
    const keyCache = new Map();
    for (const r of inLayout) {
      const type = String(r.type || 'page').trim();
      if (!ALLOWED_ROUTE_TYPES.has(type)) continue;
      const key = buildStableRouteKey(r, layoutUid, byId, keyCache);
      if (!key || seenRouteKeys.has(`${layoutUid}::${key}`)) continue;
      seenRouteKeys.add(`${layoutUid}::${key}`);

      const pid = r.parentId != null ? String(r.parentId) : '';
      const parentRoute = pid ? byId.get(pid) : null;
      const parentKey = parentRoute ? buildStableRouteKey(parentRoute, layoutUid, byId, keyCache) : null;
      const rid = r.id != null ? String(r.id) : '';
      const roleGrants = rid && grantsByRouteId.has(rid) ? [...grantsByRouteId.get(rid)].sort() : [];

      const cleanOptions = r.options && typeof r.options === 'object' && !Array.isArray(r.options)
        ? stripSecretsDeep(r.options)
        : undefined;

      normalizedRoutes.push(stripSecretsDeep({
        key,
        layoutUid,
        type,
        title: String(r.title || key),
        ...(r.icon ? { icon: String(r.icon) } : {}),
        ...(r.schemaUid ? { schemaUid: String(r.schemaUid).trim() } : {}),
        ...(r.menuSchemaUid ? { menuSchemaUid: String(r.menuSchemaUid).trim() } : {}),
        parentKey,
        ...(r.sort != null && Number.isFinite(Number(r.sort)) ? { sort: Number(r.sort) } : {}),
        ...(typeof r.hidden === 'boolean' ? { hidden: r.hidden } : {}),
        ...(typeof r.hideInMenu === 'boolean' ? { hideInMenu: r.hideInMenu } : {}),
        ...(typeof r.enableTabs === 'boolean' ? { enableTabs: r.enableTabs } : {}),
        ...(typeof r.enableHeader === 'boolean' ? { enableHeader: r.enableHeader } : {}),
        ...(typeof r.displayTitle === 'boolean' ? { displayTitle: r.displayTitle } : {}),
        ...(cleanOptions && Object.keys(cleanOptions).length > 0 ? { options: cleanOptions } : {}),
        roleGrants,
      }));
    }
  }

  normalizedRoutes.sort((a, b) => (
    String(a.layoutUid).localeCompare(String(b.layoutUid))
    || String(a.key).localeCompare(String(b.key))
  ));

  const flowModels = rawModels
    .filter((m) => {
      const uid = String(m.uid || '').trim();
      const use = String(m.use || '').trim();
      return (
        uid
        && analysis.managedModelUids.has(uid)
        && !analysis.unmanagedModelUids.has(uid)
        && !analysis.nonManagedLayoutUids.has(uid)
        && !RESERVED_SYSTEM_LAYOUT_UIDS.has(uid)
        && ALLOWED_FLOW_MODEL_USES.has(use)
      );
    })
    .map((m) => stripSecretsDeep({
      uid: String(m.uid).trim(),
      use: String(m.use).trim(),
      ...(m.parentId != null ? { parentId: String(m.parentId).trim() } : {}),
      ...(m.subKey ? { subKey: String(m.subKey) } : {}),
      ...(m.subType ? { subType: String(m.subType) } : {}),
      ...(m.sortIndex != null ? { sortIndex: Number(m.sortIndex) } : {}),
      props: m.props && typeof m.props === 'object' && !Array.isArray(m.props) ? stripSecretsDeep(m.props) : {},
      stepParams: m.stepParams && typeof m.stepParams === 'object' && !Array.isArray(m.stepParams) ? stripSecretsDeep(m.stepParams) : {},
    }))
    .sort((a, b) => String(a.uid).localeCompare(String(b.uid)));

  return { routes: normalizedRoutes, flowModels };
}

async function exportGovernanceSection(db, filterOrg) {
  const findOpts = filterOrg ? { filter: { organizationId: filterOrg }, limit: 1000 } : { limit: 1000 };
  const rawDmn = (await safeRepoFind(db, 'latticeDecisionTables', findOpts)).map(toObj);
  const rawSla = (await safeRepoFind(db, 'latticeSlaPolicies', findOpts)).map(toObj);
  const rawRules = (await safeRepoFind(db, 'latticeIncidentRules', findOpts)).map(toObj);
  const rawAutomationRules = (await safeRepoFind(db, 'latticeAutomationRules', findOpts)).map(toObj);
  const rawWebhookSubscriptions = (await safeRepoFind(db, 'latticeWebhookSubscriptions', findOpts)).map(toObj);

  const decisionTables = rawDmn
    .filter((d) => (!filterOrg || d.organizationId === filterOrg) && d.organizationId && d.tableKey)
    .map((d) => stripSecretsDeep({
      organizationId: String(d.organizationId).trim(),
      tableKey: String(d.tableKey).trim(),
      name: String(d.name || d.tableKey),
      ...(d.description ? { description: String(d.description) } : {}),
      hitPolicy: String(d.hitPolicy || 'FIRST').trim().toUpperCase(),
      inputsJson: Array.isArray(d.inputsJson) ? d.inputsJson : [],
      outputsJson: Array.isArray(d.outputsJson) ? d.outputsJson : [],
      rulesJson: Array.isArray(d.rulesJson) ? d.rulesJson : [],
      version: Number(d.version) || 1,
      published: d.published !== false,
      ...(d.updatedBy ? { updatedBy: String(d.updatedBy) } : {}),
      active: d.active !== false,
    }))
    .sort((a, b) => `${a.organizationId}::${a.tableKey}`.localeCompare(`${b.organizationId}::${b.tableKey}`));

  const slaPolicies = rawSla
    .filter((s) => (!filterOrg || s.organizationId === filterOrg) && s.organizationId && s.targetCollection)
    .map((s) => stripSecretsDeep({
      organizationId: String(s.organizationId).trim(),
      targetCollection: String(s.targetCollection).trim(),
      priority: String(s.priority || 'normal').trim().toLowerCase(),
      warnAfterMinutes: Number(s.warnAfterMinutes) || 240,
      breachAfterMinutes: Number(s.breachAfterMinutes) || 1440,
      escalateToRole: String(s.escalateToRole || 'ldx_manager').trim(),
      ...(s.notifyChannels != null ? { notifyChannels: s.notifyChannels } : {}),
      active: s.active !== false,
    }))
    .sort((a, b) => `${a.organizationId}::${a.targetCollection}::${a.priority}`.localeCompare(`${b.organizationId}::${b.targetCollection}::${b.priority}`));

  const incidentRules = rawRules
    .filter((r) => (!filterOrg || r.organizationId === filterOrg) && r.organizationId && r.code)
    .map((r) => stripSecretsDeep({
      organizationId: String(r.organizationId).trim(),
      code: String(r.code).trim(),
      name: String(r.name || r.code),
      active: r.active !== false,
      assetEntityId: String(r.assetEntityId || '').trim(),
      attribute: String(r.attribute || '').trim(),
      operator: String(r.operator || '>').trim(),
      threshold: String(r.threshold ?? ''),
      unit: String(r.unit || '').trim(),
      severity: String(r.severity || 'medium').trim().toLowerCase(),
      maxObservationAgeSeconds: String(r.maxObservationAgeSeconds ?? '300'),
      cooldownSeconds: String(r.cooldownSeconds ?? '300'),
      workflowDefinitionId: String(r.workflowDefinitionId || 'incident-response'),
      workflowDefinitionVersion: String(r.workflowDefinitionVersion || '1'),
      handlerId: String(r.handlerId || '').trim(),
    }))
    .sort((a, b) => `${a.organizationId}::${a.code}`.localeCompare(`${b.organizationId}::${b.code}`));

  const automationRules = rawAutomationRules
    .filter((r) => !filterOrg || r.organizationId === filterOrg)
    .map((r) => ({
      organizationId: String(r.organizationId || '').trim(),
      ruleKey: String(r.ruleKey || '').trim(),
      name: String(r.name || r.ruleKey || '').trim(),
      description: r.description != null ? String(r.description) : null,
      triggerEventType: String(r.triggerEventType || '*').trim(),
      filterJson: r.filterJson != null ? stripSecretsDeep(r.filterJson) : null,
      dmnTableKey: r.dmnTableKey != null ? String(r.dmnTableKey).trim() : null,
      actionsJson: stripSecretsDeep(Array.isArray(r.actionsJson) ? r.actionsJson : []),
      maxDepth: Number.isInteger(Number(r.maxDepth)) ? Number(r.maxDepth) : 8,
      cooldownSec: Number.isInteger(Number(r.cooldownSec)) ? Number(r.cooldownSec) : 0,
      active: r.active !== false,
      createdBy: r.createdBy != null ? String(r.createdBy) : null,
    }))
    .sort((a, b) => `${a.organizationId}::${a.ruleKey}`.localeCompare(`${b.organizationId}::${b.ruleKey}`));

  const webhookSubscriptions = rawWebhookSubscriptions
    .filter((w) => !filterOrg || w.organizationId === filterOrg)
    .map((w) => ({
      organizationId: String(w.organizationId || '').trim(),
      subscriptionKey: String(w.subscriptionKey || '').trim(),
      name: String(w.name || w.subscriptionKey || '').trim(),
      targetUrl: String(w.targetUrl || '').trim(),
      eventPattern: String(w.eventPattern || '*').trim(),
      active: w.active !== false,
    }))
    .sort((a, b) => `${a.organizationId}::${a.subscriptionKey}`.localeCompare(`${b.organizationId}::${b.subscriptionKey}`));

  return { decisionTables, slaPolicies, incidentRules, automationRules, webhookSubscriptions };
}

async function exportSolutionBundle(db, { organizationId = null, platformVersion = DEFAULT_PLATFORM_VERSION } = {}) {
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

  const routesAndBlocks = await exportRoutesAndBlocksSection(db, rawPortals);
  const governance = await exportGovernanceSection(db, filterOrg);

  const payload = {
    roles,
    portals,
    workflows,
    aiProfiles,
    customCollections,
    routesAndBlocks,
    governance,
  };
  const contentSha256 = createHash('sha256').update(JSON.stringify(payload)).digest('hex');

  return {
    metadata: {
      schemaVersion: BUNDLE_SCHEMA_VERSION,
      platformVersion: String(platformVersion || DEFAULT_PLATFORM_VERSION),
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

function findPrototypePollutionErrors(value, errors, pathStr = '$', depth = 0) {
  if (value === null || value === undefined || typeof value !== 'object') return;
  if (depth > MAX_PROTO_DEPTH) {
    errors.push(`Maximum object nesting depth (${MAX_PROTO_DEPTH}) exceeded at ${pathStr}`);
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      findPrototypePollutionErrors(value[i], errors, `${pathStr}[${i}]`, depth + 1);
    }
    return;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null && !(value instanceof Date)) {
    errors.push(`Forbidden custom prototype at ${pathStr}`);
    return;
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    if (FORBIDDEN_PROTO_KEYS.has(key)) {
      errors.push(`Forbidden prototype key "${key}" at ${pathStr}`);
      continue;
    }
    findPrototypePollutionErrors(value[key], errors, `${pathStr}.${key}`, depth + 1);
  }
}

function validateNoUnsafeCodeOrXss(value, pathStr, errors, depth = 0) {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (hasUnsafeXssValue(value)) {
      errors.push(`Unsafe script or XSS payload forbidden at ${pathStr}`);
    }
    return;
  }
  if (typeof value !== 'object') return;
  if (depth > MAX_XSS_DEPTH) {
    errors.push(`Maximum nesting depth (${MAX_XSS_DEPTH}) exceeded at ${pathStr}`);
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      validateNoUnsafeCodeOrXss(value[i], `${pathStr}[${i}]`, errors, depth + 1);
    }
    return;
  }
  for (const key of Object.keys(value)) {
    if (UNSAFE_CODE_KEY_RE.test(key)) {
      errors.push(`Unsafe custom code property "${key}" forbidden at ${pathStr}`);
      continue;
    }
    validateNoUnsafeCodeOrXss(value[key], `${pathStr}.${key}`, errors, depth + 1);
  }
}

function validateRoutesAndBlocks(routesAndBlocks, errors) {
  if (!routesAndBlocks || typeof routesAndBlocks !== 'object' || Array.isArray(routesAndBlocks)) {
    errors.push('routesAndBlocks must be an object');
    return;
  }
  if (routesAndBlocks.routes !== undefined) {
    if (!Array.isArray(routesAndBlocks.routes)) {
      errors.push('routesAndBlocks.routes must be an array');
    } else {
      const parentByKey = new Map();
      const seenKeys = new Set();
      for (let i = 0; i < routesAndBlocks.routes.length; i += 1) {
        const r = routesAndBlocks.routes[i];
        if (!r || typeof r !== 'object' || Array.isArray(r)) {
          errors.push(`routesAndBlocks.routes[${i}] must be an object`);
          continue;
        }
        const key = getRouteKey(r);
        if (!key) {
          errors.push(`routesAndBlocks.routes[${i}] must include key, schemaUid, uid, or title`);
        } else if (RESERVED_SYSTEM_LAYOUT_UIDS.has(key)) {
          errors.push(`Reserved system layout UID "${key}" forbidden on route at routes[${i}]`);
        }
        const layoutUid = String(r.layoutUid || '').trim();
        if (!isManagedLayoutUid(layoutUid)) {
          errors.push(`Invalid or unmanaged route layoutUid "${layoutUid || '(empty)'}" at routes[${i}]`);
        }
        const type = String(r.type || '').trim();
        if (!ALLOWED_ROUTE_TYPES.has(type)) {
          errors.push(`Unsupported route type "${type || '(empty)'}" at routes[${i}]`);
        }
        if (r.schemaUid !== undefined && r.schemaUid !== null) {
          const sUid = String(r.schemaUid).trim();
          if (!SAFE_MODEL_UID_RE.test(sUid) || RESERVED_SYSTEM_LAYOUT_UIDS.has(sUid)) {
            errors.push(`Invalid or reserved route schemaUid "${String(r.schemaUid)}" at routes[${i}]`);
          }
        }
        if (r.menuSchemaUid !== undefined && r.menuSchemaUid !== null) {
          const mUid = String(r.menuSchemaUid).trim();
          if (!SAFE_MODEL_UID_RE.test(mUid) || RESERVED_SYSTEM_LAYOUT_UIDS.has(mUid)) {
            errors.push(`Invalid or reserved route menuSchemaUid "${String(r.menuSchemaUid)}" at routes[${i}]`);
          }
        }
        if (r.roleGrants !== undefined) {
          if (!Array.isArray(r.roleGrants)) {
            errors.push(`Route roleGrants must be an array at routes[${i}]`);
          } else {
            for (const grant of r.roleGrants) {
              const gName = String(grant || '').trim();
              if (!SAFE_ROLE_RE.test(gName) || FORBIDDEN_ROLES.has(gName)) {
                errors.push(`Forbidden or invalid route roleGrant "${gName || '(empty)'}" at routes[${i}]`);
              }
            }
          }
        }
        if (key) {
          const scopedKey = `${layoutUid}::${key}`;
          if (seenKeys.has(scopedKey)) {
            errors.push(`Duplicate route key "${key}" in layout "${layoutUid}"`);
          }
          seenKeys.add(scopedKey);
          if (r.parentKey !== undefined && r.parentKey !== null) {
            const pk = String(r.parentKey).trim();
            if (pk) {
              if (pk === key) errors.push(`Self-referential route parentKey "${pk}"`);
              parentByKey.set(scopedKey, `${layoutUid}::${pk}`);
            }
          }
        }
        validateNoUnsafeCodeOrXss(r, `routesAndBlocks.routes[${i}]`, errors);
      }
      for (const start of parentByKey.keys()) {
        const seenChain = new Set([start]);
        let cur = parentByKey.get(start);
        while (cur && parentByKey.has(cur)) {
          if (seenChain.has(cur)) {
            errors.push(`Cyclic route parentKey hierarchy involving "${cur}"`);
            break;
          }
          seenChain.add(cur);
          cur = parentByKey.get(cur);
        }
      }
    }
  }
  if (routesAndBlocks.flowModels !== undefined) {
    if (!Array.isArray(routesAndBlocks.flowModels)) {
      errors.push('routesAndBlocks.flowModels must be an array');
    } else {
      const seenUids = new Set();
      for (let i = 0; i < routesAndBlocks.flowModels.length; i += 1) {
        const m = routesAndBlocks.flowModels[i];
        if (!m || typeof m !== 'object' || Array.isArray(m)) {
          errors.push(`routesAndBlocks.flowModels[${i}] must be an object`);
          continue;
        }
        const uid = String(m.uid || '').trim();
        if (!SAFE_MODEL_UID_RE.test(uid) || RESERVED_SYSTEM_LAYOUT_UIDS.has(uid)) {
          errors.push(`Invalid or reserved flowModel uid "${uid || '(empty)'}" at flowModels[${i}]`);
        } else if (seenUids.has(uid)) {
          errors.push(`Duplicate flowModel uid "${uid}"`);
        } else {
          seenUids.add(uid);
        }
        if (m.parentId !== undefined && m.parentId !== null) {
          if (typeof m.parentId !== 'string' && typeof m.parentId !== 'number') {
            errors.push(`Invalid flowModel parentId type at flowModels[${i}]`);
          } else {
            const pid = String(m.parentId).trim();
            if (pid && (!SAFE_MODEL_UID_RE.test(pid) || RESERVED_SYSTEM_LAYOUT_UIDS.has(pid))) {
              errors.push(`Invalid or reserved flowModel parentId "${pid}" at flowModels[${i}]`);
            }
          }
        }
        const use = String(m.use || '').trim();
        if (!ALLOWED_FLOW_MODEL_USES.has(use)) {
          errors.push(`Forbidden or unsupported flowModel use "${use || '(empty)'}" at flowModels[${i}]`);
        }
        validateNoUnsafeCodeOrXss(m, `routesAndBlocks.flowModels[${i}]`, errors);
      }
    }
  }
}

function validateGovernanceOrg(item, label, index, requiresExplicitOrg, errors) {
  const org = item?.organizationId != null ? String(item.organizationId).trim() : '';
  if (org.toLowerCase() === 'all') {
    errors.push(`organizationId "all" is forbidden on ${label}[${index}]`);
  } else if (!org && requiresExplicitOrg) {
    errors.push(`Explicit organizationId is required on ${label}[${index}] when bundle metadata.organizationId is "all" or omitted`);
  } else if (org && !SAFE_ORG_ID_RE.test(org)) {
    errors.push(`Invalid organizationId "${org}" on ${label}[${index}]`);
  }
}

const INTERNAL_WEBHOOK_HOST_ALLOWLIST = new Set([
  'n8n',
  'orion-ld',
  'mosquitto',
  'nodered',
  'nocobase',
  'localhost',
  '127.0.0.1',
]);

let cachedAutomationEngine = null;
function getAutomationEngine() {
  if (!cachedAutomationEngine) {
    try {
      cachedAutomationEngine = require('./automation-engine');
    } catch {
      cachedAutomationEngine = null;
    }
  }
  return cachedAutomationEngine;
}

function getConnectorVaultMod() {
  try {
    const shared = require('./wms-dmn-shared');
    return typeof shared?.loadFoundationModule === 'function'
      ? shared.loadFoundationModule('connector-vault')
      : null;
  } catch {
    return null;
  }
}

function isBlockedPrivateIpv4(host) {
  const parts = String(host || '').split('.');
  if (parts.length !== 4 || !parts.every((p) => /^(?:0|[1-9]\d{0,2})$/.test(p))) return false;
  const octets = parts.map(Number);
  if (octets.some((n) => n < 0 || n > 255)) return true;
  const [a, b] = octets;
  return (
    a === 0
    || a === 10
    || a === 127
    || a >= 224
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
  );
}

function validateSafeWebhookTargetUrl(rawUrl, contextLabel = 'webhookSubscriptions', { env = process.env } = {}) {
  const trimmed = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!trimmed || trimmed.length > 2048 || /[\u0000-\u001f\u007f\s]/.test(trimmed)) {
    return `${contextLabel} targetUrl must be a non-empty URL <= 2048 chars`;
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return `${contextLabel} targetUrl is malformed`;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return `${contextLabel} targetUrl protocol "${parsed.protocol}" is forbidden`;
  }
  if (parsed.username || parsed.password) {
    return `${contextLabel} targetUrl must not embed credentials`;
  }
  const authorityMatch = trimmed.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i);
  const authority = authorityMatch ? authorityMatch[1] : '';
  if (!authority || authority.includes('@') || authority.includes('\\')) {
    return `${contextLabel} targetUrl authority is invalid`;
  }
  const bare = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!bare) {
    return `${contextLabel} targetUrl hostname is empty`;
  }
  if (
    /^\d+$/.test(bare)
    || /^0x[0-9a-f]+$/i.test(bare)
    || (bare.split('.').length <= 4 && bare.split('.').every((p) => /^(?:0x[0-9a-f]+|0[0-7]*|[1-9]\d*)$/i.test(p))
      && (bare.split('.').length !== 4 || bare.split('.').some((p) => /^0x/i.test(p) || (p.length > 1 && p.startsWith('0')))))
  ) {
    return `${contextLabel} targetUrl non-canonical numeric host "${bare}" is blocked`;
  }
  if (
    bare === 'metadata.google.internal'
    || bare.endsWith('.metadata.google.internal')
    || bare === 'metadata.azure.com'
    || bare.endsWith('.metadata.azure.com')
    || bare === 'metadata.aws.internal'
    || bare === 'instance-data'
    || bare === 'fd00:ec2::254'
    || bare.startsWith('169.254.')
  ) {
    return `${contextLabel} targetUrl metadata host "${bare}" is blocked by SSRF policy`;
  }

  const extraAllowlist = String(env?.DX_CONNECTOR_INTERNAL_ALLOWLIST || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const inInternalAllowlist = INTERNAL_WEBHOOK_HOST_ALLOWLIST.has(bare) || extraAllowlist.includes(bare);
  const explicitInternal = String(env?.DX_ALLOW_INTERNAL_CONNECTORS || '').trim().toLowerCase();
  const isProd = String(env?.NODE_ENV || '').trim().toLowerCase() === 'production';
  const allowInternal = explicitInternal === 'true' || (explicitInternal !== 'false' && !isProd);

  if (parsed.protocol === 'http:' && !(allowInternal && inInternalAllowlist)) {
    return `${contextLabel} targetUrl must use https:// (plain http:// is blocked for "${bare}")`;
  }

  const vaultMod = getConnectorVaultMod();
  if (typeof vaultMod?.assertSafeConnectorUrl === 'function') {
    try {
      vaultMod.assertSafeConnectorUrl(trimmed, { connectorType: 'http_api', env });
    } catch (err) {
      return `${contextLabel} targetUrl rejected: ${err?.message || 'SSRF policy violation'}`;
    }
  } else if (!(allowInternal && inInternalAllowlist)) {
    if (bare === 'localhost' || bare.endsWith('.localhost') || bare.endsWith('.local') || bare.endsWith('.internal')) {
      return `${contextLabel} targetUrl internal host "${bare}" is blocked by SSRF policy`;
    }
    if (net.isIPv4(bare) && isBlockedPrivateIpv4(bare)) {
      return `${contextLabel} targetUrl private IPv4 "${bare}" is blocked by SSRF policy`;
    }
    if (bare.includes(':')) {
      const lower = bare.toLowerCase();
      if (lower === '::1' || lower === '::' || lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd') || lower.includes('ffff:')) {
        return `${contextLabel} targetUrl internal/private IPv6 "${bare}" is blocked by SSRF policy`;
      }
    }
    if (!bare.includes('.') && !bare.includes(':')) {
      return `${contextLabel} targetUrl non-allowlisted host "${bare}" is blocked by SSRF policy`;
    }
  }
  return null;
}

function validateAutomationRuleEntry(a, index, errors) {
  const ruleKey = String(a.ruleKey || '').trim();
  if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(ruleKey)) {
    errors.push(`Invalid automation ruleKey "${ruleKey || '(empty)'}" at automationRules[${index}]`);
  }
  if (!String(a.name || '').trim()) {
    errors.push(`Automation rule "${ruleKey || index}" requires a name`);
  }
  const engine = getAutomationEngine();
  if (a.filterJson !== undefined && a.filterJson !== null) {
    if (typeof a.filterJson !== 'object' || Array.isArray(a.filterJson)) {
      errors.push(`Automation filterJson must be an object at automationRules[${index}]`);
    } else if (engine?.hasUnsafeTemplateSyntax?.(a.filterJson)) {
      errors.push(`Automation filterJson contains unsafe template syntax at automationRules[${index}]`);
    }
  }
  if (a.actionsJson !== undefined) {
    if (!Array.isArray(a.actionsJson)) {
      errors.push(`Automation actionsJson must be an array at automationRules[${index}]`);
    } else {
      for (let j = 0; j < a.actionsJson.length; j += 1) {
        const act = a.actionsJson[j];
        if (!act || typeof act !== 'object' || Array.isArray(act)) {
          errors.push(`Automation actionsJson[${j}] must be an object at automationRules[${index}]`);
          continue;
        }
        const actType = String(act.type || '').trim();
        if (!engine?.VALID_ACTION_TYPES?.has(actType)) {
          errors.push(`Invalid automation action type "${actType || '(empty)'}" at automationRules[${index}].actionsJson[${j}]`);
        }
        if (engine?.hasUnsafeTemplateSyntax?.(act)) {
          errors.push(`Unsafe template syntax in automationRules[${index}].actionsJson[${j}]`);
        }
        if (actType === 'create_record' || actType === 'update_record') {
          const targetCollection = String(act.collection || act.targetCollection || '').trim();
          if (!engine?.isAllowlistedTargetCollection?.(targetCollection)) {
            errors.push(`Forbidden target collection "${targetCollection || '(empty)'}" at automationRules[${index}].actionsJson[${j}]`);
          }
        }
        if (actType === 'call_connector') {
          const connKey = String(act.connectorKey || act.connector || '').trim();
          if (!connKey) {
            errors.push(`call_connector requires connectorKey at automationRules[${index}].actionsJson[${j}]`);
          }
          const rawOverride = String(act.url || act.path || '').trim();
          if (/^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|\/\/)/.test(rawOverride)) {
            errors.push(`call_connector cannot override origin/scheme at automationRules[${index}].actionsJson[${j}]`);
          }
        }
      }
    }
  }
  if (a.maxDepth !== undefined && parseStrictIntInRange(a.maxDepth, 1, 8) === null) {
    errors.push(`Invalid maxDepth "${String(a.maxDepth)}" at automationRules[${index}]`);
  }
  if (a.cooldownSec !== undefined && parseStrictIntInRange(a.cooldownSec, 0, 31_536_000) === null) {
    errors.push(`Invalid cooldownSec "${String(a.cooldownSec)}" at automationRules[${index}]`);
  }
  validateNoUnsafeCodeOrXss(a, `governance.automationRules[${index}]`, errors);
}

function validateGovernanceSection(governance, errors, metaOrgRaw = '') {
  if (!governance || typeof governance !== 'object' || Array.isArray(governance)) {
    errors.push('governance must be an object');
    return;
  }
  const metaOrg = metaOrgRaw != null ? String(metaOrgRaw).trim() : '';
  const requiresExplicitOrg = !metaOrg || metaOrg.toLowerCase() === 'all';

  if (governance.decisionTables !== undefined) {
    if (!Array.isArray(governance.decisionTables)) {
      errors.push('governance.decisionTables must be an array');
    } else {
      for (let i = 0; i < governance.decisionTables.length; i += 1) {
        const d = governance.decisionTables[i];
        if (!d || typeof d !== 'object' || Array.isArray(d)) {
          errors.push(`governance.decisionTables[${i}] must be an object`);
          continue;
        }
        validateGovernanceOrg(d, 'decisionTables', i, requiresExplicitOrg, errors);
        const tableKey = String(d.tableKey || '').trim();
        if (!SAFE_DMN_KEY_RE.test(tableKey)) {
          errors.push(`Invalid DMN tableKey "${tableKey || '(empty)'}" at decisionTables[${i}]`);
        }
        if (!String(d.name || '').trim()) {
          errors.push(`DMN table "${tableKey || i}" requires a name`);
        }
        const hitPolicy = String(d.hitPolicy || 'FIRST').trim().toUpperCase();
        if (!VALID_HIT_POLICIES.has(hitPolicy)) {
          errors.push(`Unsupported DMN hitPolicy "${hitPolicy}" at decisionTables[${i}]`);
        }
        if (d.version !== undefined && parseStrictIntInRange(d.version, 1, 1_000_000) === null) {
          errors.push(`Invalid DMN version "${String(d.version)}" at decisionTables[${i}]`);
        }
        for (const arrKey of ['inputsJson', 'outputsJson', 'rulesJson']) {
          if (d[arrKey] !== undefined && !Array.isArray(d[arrKey])) {
            errors.push(`DMN ${arrKey} must be an array at decisionTables[${i}]`);
          }
        }
        validateNoUnsafeCodeOrXss(d, `governance.decisionTables[${i}]`, errors);
      }
    }
  }
  if (governance.slaPolicies !== undefined) {
    if (!Array.isArray(governance.slaPolicies)) {
      errors.push('governance.slaPolicies must be an array');
    } else {
      for (let i = 0; i < governance.slaPolicies.length; i += 1) {
        const s = governance.slaPolicies[i];
        if (!s || typeof s !== 'object' || Array.isArray(s)) {
          errors.push(`governance.slaPolicies[${i}] must be an object`);
          continue;
        }
        validateGovernanceOrg(s, 'slaPolicies', i, requiresExplicitOrg, errors);
        const col = String(s.targetCollection || '').trim();
        if (!SAFE_RESOURCE_COLLECTION_RE.test(col) || isProtectedCollection(col)) {
          errors.push(`Invalid SLA targetCollection "${col || '(empty)'}" at slaPolicies[${i}]`);
        }
        const prio = String(s.priority || 'normal').trim().toLowerCase();
        if (!VALID_SLA_PRIORITIES.has(prio)) {
          errors.push(`Invalid SLA priority "${prio}" at slaPolicies[${i}]`);
        }
        const warn = Number(s.warnAfterMinutes ?? 240);
        const breach = Number(s.breachAfterMinutes ?? 1440);
        if (!Number.isInteger(warn) || warn < 1 || !Number.isInteger(breach) || breach < warn) {
          errors.push(`Invalid SLA thresholds (warn=${warn}, breach=${breach}) at slaPolicies[${i}]`);
        }
        if (s.escalateToRole !== undefined) {
          const role = String(s.escalateToRole || '').trim();
          if (!SAFE_ROLE_RE.test(role) || FORBIDDEN_ROLES.has(role)) {
            errors.push(`Invalid or forbidden SLA escalateToRole "${role}" at slaPolicies[${i}]`);
          }
        }
        validateNoUnsafeCodeOrXss(s, `governance.slaPolicies[${i}]`, errors);
      }
    }
  }
  if (governance.incidentRules !== undefined) {
    if (!Array.isArray(governance.incidentRules)) {
      errors.push('governance.incidentRules must be an array');
    } else {
      for (let i = 0; i < governance.incidentRules.length; i += 1) {
        const r = governance.incidentRules[i];
        if (!r || typeof r !== 'object' || Array.isArray(r)) {
          errors.push(`governance.incidentRules[${i}] must be an object`);
          continue;
        }
        validateGovernanceOrg(r, 'incidentRules', i, requiresExplicitOrg, errors);
        if (!String(r.code || '').trim() || !String(r.name || '').trim()) {
          errors.push(`Incident rule requires non-empty code and name at incidentRules[${i}]`);
        }
        if (!String(r.assetEntityId || '').trim() || !String(r.attribute || '').trim() || !String(r.unit || '').trim() || !String(r.handlerId || '').trim()) {
          errors.push(`Incident rule requires assetEntityId, attribute, unit, and handlerId at incidentRules[${i}]`);
        }
        const op = String(r.operator || '').trim();
        if (!VALID_RULE_OPERATORS.has(op)) {
          errors.push(`Unsupported incident rule operator "${op || '(empty)'}" at incidentRules[${i}]`);
        }
        if (r.threshold === undefined || r.threshold === null || String(r.threshold).trim() === '') {
          errors.push(`Incident rule requires threshold at incidentRules[${i}]`);
        }
        if (r.severity !== undefined) {
          const sev = typeof r.severity === 'string' ? r.severity.trim().toLowerCase() : '';
          if (!VALID_INCIDENT_SEVERITIES.has(sev)) {
            errors.push(`Unsupported incident rule severity "${String(r.severity)}" at incidentRules[${i}]`);
          }
        }
        if (r.maxObservationAgeSeconds !== undefined && parseStrictIntInRange(r.maxObservationAgeSeconds, 1, 31_536_000) === null) {
          errors.push(`Invalid maxObservationAgeSeconds "${String(r.maxObservationAgeSeconds)}" at incidentRules[${i}]`);
        }
        if (r.cooldownSeconds !== undefined && parseStrictIntInRange(r.cooldownSeconds, 0, 31_536_000) === null) {
          errors.push(`Invalid cooldownSeconds "${String(r.cooldownSeconds)}" at incidentRules[${i}]`);
        }
        validateNoUnsafeCodeOrXss(r, `governance.incidentRules[${i}]`, errors);
      }
    }
  }

  if (governance.automationRules !== undefined) {
    if (!Array.isArray(governance.automationRules)) {
      errors.push('governance.automationRules must be an array');
    } else {
      for (let i = 0; i < governance.automationRules.length; i += 1) {
        const a = governance.automationRules[i];
        if (!a || typeof a !== 'object' || Array.isArray(a)) {
          errors.push(`governance.automationRules[${i}] must be an object`);
          continue;
        }
        validateGovernanceOrg(a, 'automationRules', i, requiresExplicitOrg, errors);
        validateAutomationRuleEntry(a, i, errors);
      }
    }
  }

  if (governance.webhookSubscriptions !== undefined) {
    if (!Array.isArray(governance.webhookSubscriptions)) {
      errors.push('governance.webhookSubscriptions must be an array');
    } else {
      for (let i = 0; i < governance.webhookSubscriptions.length; i += 1) {
        const w = governance.webhookSubscriptions[i];
        if (!w || typeof w !== 'object' || Array.isArray(w)) {
          errors.push(`governance.webhookSubscriptions[${i}] must be an object`);
          continue;
        }
        validateGovernanceOrg(w, 'webhookSubscriptions', i, requiresExplicitOrg, errors);
        const subKey = String(w.subscriptionKey || '').trim();
        if (!subKey) {
          errors.push(`Webhook subscription requires subscriptionKey at webhookSubscriptions[${i}]`);
        }
        const targetUrl = String(w.targetUrl || '').trim();
        const urlErr = validateSafeWebhookTargetUrl(targetUrl, `webhookSubscriptions[${i}]`);
        if (urlErr) {
          errors.push(urlErr);
        }
        if (w.encryptedSigningSecret || w.signingSecret) {
          errors.push(`Webhook subscription must not contain signing secret at webhookSubscriptions[${i}]`);
        }
        validateNoUnsafeCodeOrXss(w, `governance.webhookSubscriptions[${i}]`, errors);
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
  findPrototypePollutionErrors(bundle, errors);
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
  if (bundle.routesAndBlocks !== undefined) {
    validateRoutesAndBlocks(bundle.routesAndBlocks, errors);
  }
  if (bundle.governance !== undefined) {
    validateGovernanceSection(bundle.governance, errors, bundle.metadata?.organizationId);
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
    routes: diffSection(
      cur.routesAndBlocks?.routes,
      inc.routesAndBlocks?.routes,
      (r) => getScopedRouteKey(r),
    ),
    flowModels: diffSection(
      cur.routesAndBlocks?.flowModels,
      inc.routesAndBlocks?.flowModels,
      (m) => m?.uid,
    ),
    decisionTables: diffSection(
      cur.governance?.decisionTables,
      inc.governance?.decisionTables,
      (d) => `${d?.organizationId || ''}::${d?.tableKey || ''}`,
    ),
    slaPolicies: diffSection(
      cur.governance?.slaPolicies,
      inc.governance?.slaPolicies,
      (s) => `${s?.organizationId || ''}::${s?.targetCollection || ''}::${s?.priority || 'normal'}`,
    ),
    incidentRules: diffSection(
      cur.governance?.incidentRules,
      inc.governance?.incidentRules,
      (r) => `${r?.organizationId || ''}::${r?.code || ''}`,
    ),
    automationRules: diffSection(
      cur.governance?.automationRules,
      inc.governance?.automationRules,
      (r) => `${r?.organizationId || ''}::${r?.ruleKey || ''}`,
    ),
    webhookSubscriptions: diffSection(
      cur.governance?.webhookSubscriptions,
      inc.governance?.webhookSubscriptions,
      (w) => `${w?.organizationId || ''}::${w?.subscriptionKey || ''}`,
    ),
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
  return {
    summary,
    sections,
    roleResources,
    routesAndBlocks: {
      routes: sections.routes,
      flowModels: sections.flowModels,
    },
    governance: {
      decisionTables: sections.decisionTables,
      slaPolicies: sections.slaPolicies,
      incidentRules: sections.incidentRules,
      automationRules: sections.automationRules,
      webhookSubscriptions: sections.webhookSubscriptions,
    },
  };
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

async function resolveFirstActiveOrg(db, transaction) {
  const rows = (await safeRepoFind(db, 'latticeOrganizations', { limit: 50, transaction })) || [];
  for (const row of rows) {
    const orgId = String(val(row, 'organizationId') || '').trim();
    if (!orgId || orgId.toLowerCase() === 'all') continue;
    if (val(row, 'active') === false) continue;
    const status = String(val(row, 'status') || 'active').trim().toLowerCase();
    if (status === 'inactive' || status === 'disabled') continue;
    return orgId;
  }
  return '';
}

async function applyCustomCollectionsSection(db, collectionsList, targetOrg, transaction) {
  const colsRepo = db?.getRepository?.('collections');
  if (!colsRepo || !Array.isArray(collectionsList)) return 0;
  if (typeof colsRepo.create !== 'function' && typeof colsRepo.update !== 'function') return 0;
  const fieldsRepo = db?.getRepository?.('fields');
  let customCollectionsUpserted = 0;
  let cachedDefaultOrg;

  const txOpts = transaction ? { transaction } : {};

  for (const rawCol of collectionsList) {
    const cleanCol = stripSecretsDeep(rawCol);
    const cname = String(cleanCol?.name || '').trim();
    if (!CUSTOM_COLLECTION_RE.test(cname)) continue;

    const explicitOrgField = (Array.isArray(cleanCol.fields) ? cleanCol.fields : []).find(
      (f) => f && f.name === 'organizationId' && typeof f.defaultValue === 'string' && f.defaultValue.trim(),
    );
    let resolvedOrg = String(targetOrg || cleanCol.organizationId || explicitOrgField?.defaultValue || '').trim();
    if (!resolvedOrg) {
      if (cachedDefaultOrg === undefined) cachedDefaultOrg = await resolveFirstActiveOrg(db, transaction);
      resolvedOrg = cachedDefaultOrg;
    }
    if (!resolvedOrg) {
      throw failBundle(
        'ORGANIZATION_REQUIRED',
        400,
        `Collection "${cname}" yêu cầu organizationId mục tiêu hoặc một tổ chức đang hoạt động trong latticeOrganizations.`,
      );
    }

    const clampedOrgField = {
      name: 'organizationId',
      type: 'string',
      interface: 'input',
      allowNull: false,
      defaultValue: resolvedOrg,
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
    if (typeof db?.attachLatticeRlsPolicy === 'function' && /^latticeCustom[A-Za-z0-9_]*$/.test(cname)) {
      try {
        await db.attachLatticeRlsPolicy(cname, transaction);
      } catch {
        // Non-fatal in mock test harnesses without physical SQL tables
      }
    }
    customCollectionsUpserted += 1;
  }
  return customCollectionsUpserted;
}

async function applyAiProfilesSection(db, profilesList, targetOrg, transaction) {
  const aiRepo = db?.getRepository?.('latticeAiProfiles');
  if (!aiRepo || !Array.isArray(profilesList)) return 0;
  let aiProfilesUpserted = 0;
  let cachedDefaultOrg;

  for (const rawProf of profilesList) {
    const clean = stripSecretsDeep(rawProf);
    if (!clean?.username) continue;
    let scopedOrg = String(targetOrg || clean.organizationId || '').trim();
    if (!scopedOrg) {
      if (cachedDefaultOrg === undefined) cachedDefaultOrg = await resolveFirstActiveOrg(db, transaction);
      scopedOrg = cachedDefaultOrg;
    }
    if (!scopedOrg) {
      throw failBundle(
        'ORGANIZATION_REQUIRED',
        400,
        `AI profile "${clean.username}" yêu cầu organizationId mục tiêu hoặc một tổ chức đang hoạt động trong latticeOrganizations.`,
      );
    }
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

function sortRoutesTopologically(routes) {
  const byScopedKey = new Map();
  for (const r of routes) {
    const layoutUid = String(r?.layoutUid || '').trim();
    const k = getRouteKey(r);
    const scopedKey = layoutUid && k ? `${layoutUid}::${k}` : k;
    if (scopedKey && !byScopedKey.has(scopedKey)) byScopedKey.set(scopedKey, r);
  }
  const visited = new Set();
  const visiting = new Set();
  const ordered = [];
  function visit(r) {
    const layoutUid = String(r?.layoutUid || '').trim();
    const k = getRouteKey(r);
    const scopedKey = layoutUid && k ? `${layoutUid}::${k}` : k;
    if (!scopedKey || visited.has(scopedKey) || visiting.has(scopedKey)) return;
    visiting.add(scopedKey);
    const pk = r?.parentKey ? String(r.parentKey).trim() : '';
    const scopedParent = pk ? (layoutUid ? `${layoutUid}::${pk}` : pk) : '';
    if (scopedParent && byScopedKey.has(scopedParent)) visit(byScopedKey.get(scopedParent));
    visiting.delete(scopedKey);
    visited.add(scopedKey);
    ordered.push(r);
  }
  for (const r of routes) visit(r);
  return ordered;
}

function computeParentDepth(key, getParentKey) {
  let depth = 0;
  let cur = key;
  const seen = new Set();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const parent = getParentKey(cur);
    if (!parent) break;
    depth += 1;
    cur = parent;
  }
  return depth;
}

async function applyRoutesAndBlocksSection(db, routesAndBlocks, { reconcileDeletions = false } = {}, transaction) {
  if (!routesAndBlocks || typeof routesAndBlocks !== 'object') {
    return { routesUpserted: 0, flowModelsUpserted: 0, routesDeleted: 0, flowModelsDeleted: 0 };
  }

  let routesUpserted = 0;
  let flowModelsUpserted = 0;
  let routesDeleted = 0;
  let flowModelsDeleted = 0;

  const routesList = Array.isArray(routesAndBlocks.routes) ? routesAndBlocks.routes : [];
  const modelsList = Array.isArray(routesAndBlocks.flowModels) ? routesAndBlocks.flowModels : [];
  const rawPortals = ((await safeRepoFind(db, 'uiLayouts', { limit: 1000, transaction })) || []).map(toObj);
  const routesRepo = db?.getRepository?.('desktopRoutes');
  const existingRoutes = routesRepo
    ? ((await safeRepoFind(db, 'desktopRoutes', { limit: 1000, appends: ['uiLayouts'], transaction })) || []).map(toObj)
    : [];
  const existingLinks = routesRepo
    ? ((await safeRepoFind(db, 'desktopRoutesUiLayouts', { limit: 2000, transaction })) || []).map(toObj)
    : [];
  const flowModelsRepo = db?.getRepository?.('flowModels');
  const existingModels = flowModelsRepo
    ? ((await safeRepoFind(db, 'flowModels', { limit: 2000, transaction })) || []).map(toObj)
    : [];

  const analysis = analyzeDbRoutesAndModels({
    rawPortals,
    rawRoutes: existingRoutes,
    rawLinks: existingLinks,
    rawModels: existingModels,
  });

  const linksRepo = db?.getRepository?.('desktopRoutesUiLayouts');
  const grantsRepo = db?.getRepository?.('rolesDesktopRoutes');

  const existingByLayoutAndSchemaUid = new Map();
  const existingByLayoutAndExplicitKey = new Map();
  const existingByLayoutAndKey = new Map();
  const managedRouteRecords = [];

  for (const layoutUid of [...analysis.managedLayouts].sort()) {
    const inLayout = existingRoutes.filter((r) => {
      const rid = r?.id != null ? String(r.id) : '';
      if (!rid || analysis.unmanagedRouteIds.has(rid)) return false;
      const layouts = analysis.routeEffectiveManagedLayouts.get(rid);
      return layouts && layouts.size === 1 && layouts.has(layoutUid);
    });
    const inLayoutById = new Map(inLayout.map((r) => [String(r.id), r]));
    const keyCache = new Map();
    for (const r of inLayout) {
      const rid = String(r.id);
      const stableKey = buildStableRouteKey(r, layoutUid, inLayoutById, keyCache);
      if (r.schemaUid) {
        existingByLayoutAndSchemaUid.set(`${layoutUid}::${String(r.schemaUid).trim()}`, r);
      }
      if (r.key) {
        existingByLayoutAndExplicitKey.set(`${layoutUid}::${String(r.key).trim()}`, r);
      }
      if (stableKey) {
        existingByLayoutAndKey.set(`${layoutUid}::${stableKey}`, r);
        managedRouteRecords.push({
          route: r,
          rid,
          layoutUid,
          stableKey,
          scopedKey: `${layoutUid}::${stableKey}`,
        });
      }
    }
  }

  const keepRouteScopedKeys = new Set();
  const upsertedRouteIds = new Set();
  const upsertedIdByScopedKey = new Map();
  const stableKeyByRouteId = new Map(managedRouteRecords.map((rec) => [rec.rid, rec.stableKey]));
  const bundleNewSchemaUids = new Set();

  if (routesRepo && routesList.length > 0 && (typeof routesRepo.create === 'function' || typeof routesRepo.update === 'function')) {
    for (const rawRoute of sortRoutesTopologically(routesList)) {
      const clean = stripSecretsDeep(rawRoute);
      const layoutUid = String(clean?.layoutUid || '').trim();
      const type = String(clean?.type || '').trim();
      const routeKey = getRouteKey(clean);
      if (!routeKey || !isManagedLayoutUid(layoutUid) || !ALLOWED_ROUTE_TYPES.has(type)) {
        throw failBundle('INVALID_SOLUTION_BUNDLE', 400, `Invalid or unmanaged route entry "${routeKey || '(empty)'}"`);
      }

      const sUid = clean.schemaUid ? String(clean.schemaUid).trim() : '';
      const mUid = clean.menuSchemaUid ? String(clean.menuSchemaUid).trim() : '';
      if (
        analysis.nonManagedLayoutUids.has(routeKey)
        || (sUid && analysis.nonManagedLayoutUids.has(sUid))
        || (mUid && analysis.nonManagedLayoutUids.has(mUid))
        || (sUid && analysis.unmanagedSchemaUids.has(sUid))
        || (mUid && analysis.unmanagedSchemaUids.has(mUid))
        || analysis.unmanagedSchemaUids.has(routeKey)
      ) {
        throw failBundle('INVALID_SOLUTION_BUNDLE', 400, `Cannot overwrite unmanaged/admin route "${sUid || routeKey}"`);
      }

      let resolvedParentId = null;
      if (clean.parentKey) {
        const pk = String(clean.parentKey).trim();
        resolvedParentId = upsertedIdByScopedKey.get(`${layoutUid}::${pk}`)
          ?? val(existingByLayoutAndKey.get(`${layoutUid}::${pk}`), 'id')
          ?? val(existingByLayoutAndSchemaUid.get(`${layoutUid}::${pk}`), 'id')
          ?? val(existingByLayoutAndExplicitKey.get(`${layoutUid}::${pk}`), 'id')
          ?? null;
      }

      const hasDbUid = Boolean(sUid || String(clean?.uid || '').trim());
      const parentStableKey = resolvedParentId != null ? (stableKeyByRouteId.get(String(resolvedParentId)) || '') : '';
      const computedStableKey = !hasDbUid
        ? `${layoutUid}:${type}:${parentStableKey ? `${parentStableKey}:` : ''}${String(clean.title || '').trim() || 'untitled'}`
        : (sUid || String(clean.uid).trim());

      const existing = (sUid ? existingByLayoutAndSchemaUid.get(`${layoutUid}::${sUid}`) : null)
        || existingByLayoutAndKey.get(`${layoutUid}::${routeKey}`)
        || existingByLayoutAndExplicitKey.get(`${layoutUid}::${routeKey}`)
        || (computedStableKey ? existingByLayoutAndKey.get(`${layoutUid}::${computedStableKey}`) : null)
        || null;

      const values = {
        type,
        title: String(clean.title || routeKey),
        uiLayoutUid: layoutUid,
        parentId: resolvedParentId,
        icon: clean.icon != null && String(clean.icon).trim() ? String(clean.icon) : null,
        schemaUid: sUid || null,
        menuSchemaUid: mUid || null,
        sort: clean.sort != null && Number.isFinite(Number(clean.sort)) ? Number(clean.sort) : null,
        hidden: typeof clean.hidden === 'boolean' ? clean.hidden : false,
        hideInMenu: typeof clean.hideInMenu === 'boolean' ? clean.hideInMenu : false,
        enableTabs: typeof clean.enableTabs === 'boolean' ? clean.enableTabs : false,
        enableHeader: typeof clean.enableHeader === 'boolean' ? clean.enableHeader : false,
        displayTitle: typeof clean.displayTitle === 'boolean' ? clean.displayTitle : false,
        options: clean.options && typeof clean.options === 'object' && !Array.isArray(clean.options) ? clean.options : {},
      };

      let routeId = val(existing, 'id');
      if (existing) {
        if (routeId != null && typeof routesRepo.update === 'function') {
          await routesRepo.update({ filterByTk: routeId, filter: { id: routeId }, values, transaction });
        } else if (typeof existing.update === 'function') {
          await existing.update(values, { transaction });
        } else if (sUid && typeof routesRepo.update === 'function') {
          await routesRepo.update({ filter: { schemaUid: sUid, uiLayoutUid: layoutUid }, values, transaction });
        }
      } else if (typeof routesRepo.create === 'function') {
        const created = await routesRepo.create({ values, transaction });
        routeId = val(created, 'id');
      }

      const dbStableKey = computedStableKey || routeKey;
      keepRouteScopedKeys.add(`${layoutUid}::${routeKey}`);
      if (dbStableKey) keepRouteScopedKeys.add(`${layoutUid}::${dbStableKey}`);
      if (sUid) bundleNewSchemaUids.add(sUid);
      if (mUid) bundleNewSchemaUids.add(mUid);

      if (routeId != null) {
        upsertedRouteIds.add(String(routeId));
        upsertedIdByScopedKey.set(`${layoutUid}::${routeKey}`, routeId);
        if (sUid) upsertedIdByScopedKey.set(`${layoutUid}::${sUid}`, routeId);
        if (dbStableKey) stableKeyByRouteId.set(String(routeId), dbStableKey);

        if (linksRepo) {
          const hasLink = await findOneSafe(linksRepo, { desktopRouteId: routeId, uiLayoutUid: layoutUid }, { transaction });
          if (!hasLink && typeof linksRepo.create === 'function') {
            await linksRepo.create({ values: { desktopRouteId: routeId, uiLayoutUid: layoutUid }, transaction });
          }
        }

        if (grantsRepo && Array.isArray(clean.roleGrants)) {
          const safeGrants = [...new Set(
            clean.roleGrants
              .map((g) => String(g || '').trim())
              .filter((g) => SAFE_ROLE_RE.test(g) && !FORBIDDEN_ROLES.has(g)),
          )];
          const grantSet = new Set(safeGrants);
          if (typeof grantsRepo.find === 'function') {
            const curGrants = (await grantsRepo.find({ filter: { desktopRouteId: routeId }, transaction })) || [];
            const haveSet = new Set();
            for (const g of curGrants) {
              const rName = String(val(g, 'roleName') || '').trim();
              if (!rName) continue;
              if (SAFE_ROLE_RE.test(rName) && !FORBIDDEN_ROLES.has(rName) && !grantSet.has(rName)) {
                if (typeof grantsRepo.destroy === 'function') {
                  await grantsRepo.destroy({ filter: { desktopRouteId: routeId, roleName: rName }, transaction });
                }
              } else {
                haveSet.add(rName);
              }
            }
            for (const roleName of safeGrants) {
              if (!haveSet.has(roleName) && typeof grantsRepo.create === 'function') {
                await grantsRepo.create({ values: { desktopRouteId: routeId, roleName }, transaction });
              }
            }
          } else {
            for (const roleName of safeGrants) {
              const hasGrant = await findOneSafe(grantsRepo, { desktopRouteId: routeId, roleName }, { transaction });
              if (!hasGrant && typeof grantsRepo.create === 'function') {
                await grantsRepo.create({ values: { desktopRouteId: routeId, roleName }, transaction });
              }
            }
          }
        }
      }
      routesUpserted += 1;
    }
  }

  const keepModelUids = new Set();
  if (flowModelsRepo) {
    const validatedModels = [];
    for (const rawModel of modelsList) {
      const clean = stripSecretsDeep(rawModel);
      const uid = String(clean?.uid || '').trim();
      const use = String(clean?.use || '').trim();
      if (!SAFE_MODEL_UID_RE.test(uid) || !ALLOWED_FLOW_MODEL_USES.has(use)) {
        throw failBundle('INVALID_SOLUTION_BUNDLE', 400, `Invalid flowModel "${uid || '(empty)'}"`);
      }
      const pid = clean.parentId != null ? String(clean.parentId).trim() : '';
      if (
        RESERVED_SYSTEM_LAYOUT_UIDS.has(uid)
        || analysis.nonManagedLayoutUids.has(uid)
        || analysis.unmanagedModelUids.has(uid)
        || (pid && (RESERVED_SYSTEM_LAYOUT_UIDS.has(pid) || analysis.nonManagedLayoutUids.has(pid) || analysis.unmanagedModelUids.has(pid)))
      ) {
        throw failBundle('INVALID_SOLUTION_BUNDLE', 400, `Cannot overwrite or attach to reserved/unmanaged flowModel "${uid}"`);
      }

      const existing = analysis.existingModelsByUid.get(uid)
        || (await findOneSafe(flowModelsRepo, { uid }, { transaction }))
        || (typeof flowModelsRepo.findModelById === 'function' ? await flowModelsRepo.findModelById(uid) : null);
      if (existing && !analysis.managedModelUids.has(uid)) {
        throw failBundle('INVALID_SOLUTION_BUNDLE', 400, `Cannot overwrite unmanaged/admin flowModel "${uid}"`);
      }

      if (pid && !bundleNewSchemaUids.has(pid)) {
        const existingParent = analysis.existingModelsByUid.get(pid)
          || (await findOneSafe(flowModelsRepo, { uid: pid }, { transaction }))
          || (typeof flowModelsRepo.findModelById === 'function' ? await flowModelsRepo.findModelById(pid) : null);
        if (existingParent && !analysis.managedModelUids.has(pid)) {
          throw failBundle('INVALID_SOLUTION_BUNDLE', 400, `Cannot attach flowModel "${uid}" to unmanaged parent "${pid}"`);
        }
      }

      keepModelUids.add(uid);
      validatedModels.push({ clean, uid, use, pid, existing });
    }

    for (const { clean, uid, use, pid, existing } of validatedModels) {
      const values = {
        uid,
        use,
        parentId: pid || null,
        subKey: clean.subKey != null && String(clean.subKey) ? String(clean.subKey) : null,
        subType: clean.subType != null && String(clean.subType) ? String(clean.subType) : null,
        sortIndex: clean.sortIndex != null && Number.isFinite(Number(clean.sortIndex)) ? Number(clean.sortIndex) : null,
        props: clean.props && typeof clean.props === 'object' && !Array.isArray(clean.props) ? clean.props : {},
        stepParams: clean.stepParams && typeof clean.stepParams === 'object' && !Array.isArray(clean.stepParams) ? clean.stepParams : {},
      };

      if (existing && typeof flowModelsRepo.update === 'function') {
        await flowModelsRepo.update({ filter: { uid }, values, transaction });
      } else if (existing && typeof existing.update === 'function') {
        await existing.update(values, { transaction });
      } else if (!existing && typeof flowModelsRepo.create === 'function') {
        await flowModelsRepo.create({ values, transaction });
      } else if (typeof flowModelsRepo.upsertModel === 'function') {
        await flowModelsRepo.upsertModel(values, { transaction });
      } else if (existing && typeof flowModelsRepo.updateSingleNode === 'function') {
        await flowModelsRepo.updateSingleNode(values, { transaction });
      }
      flowModelsUpserted += 1;
    }

    if (reconcileDeletions && routesAndBlocks.flowModels !== undefined) {
      const modelsToDelete = existingModels
        .filter((m) => {
          const uid = String(m?.uid || '').trim();
          return (
            uid
            && analysis.managedModelUids.has(uid)
            && !analysis.unmanagedModelUids.has(uid)
            && !analysis.nonManagedLayoutUids.has(uid)
            && !RESERVED_SYSTEM_LAYOUT_UIDS.has(uid)
            && !keepModelUids.has(uid)
          );
        })
        .sort((a, b) => {
          const dA = computeParentDepth(String(a.uid).trim(), (u) => {
            const p = analysis.existingModelsByUid.get(u)?.parentId;
            return p != null ? String(p).trim() : '';
          });
          const dB = computeParentDepth(String(b.uid).trim(), (u) => {
            const p = analysis.existingModelsByUid.get(u)?.parentId;
            return p != null ? String(p).trim() : '';
          });
          return dB - dA;
        });

      for (const m of modelsToDelete) {
        const uid = String(m.uid).trim();
        if (typeof flowModelsRepo.destroy === 'function') {
          await flowModelsRepo.destroy({ filter: { uid }, transaction });
          flowModelsDeleted += 1;
        } else if (typeof flowModelsRepo.destroyModel === 'function') {
          await flowModelsRepo.destroyModel(uid, { transaction });
          flowModelsDeleted += 1;
        }
      }
    }
  }

  if (reconcileDeletions && routesRepo && routesAndBlocks.routes !== undefined && typeof routesRepo.destroy === 'function') {
    const routesToDelete = managedRouteRecords
      .filter((rec) => (
        !analysis.unmanagedRouteIds.has(rec.rid)
        && !upsertedRouteIds.has(rec.rid)
        && !keepRouteScopedKeys.has(rec.scopedKey)
      ))
      .sort((a, b) => {
        const dA = computeParentDepth(a.rid, (id) => {
          const p = analysis.routesById.get(id)?.parentId;
          return p != null ? String(p) : '';
        });
        const dB = computeParentDepth(b.rid, (id) => {
          const p = analysis.routesById.get(id)?.parentId;
          return p != null ? String(p) : '';
        });
        return dB - dA;
      });

    for (const rec of routesToDelete) {
      const routePk = val(rec.route, 'id');
      if (grantsRepo && typeof grantsRepo.destroy === 'function') {
        await grantsRepo.destroy({ filter: { desktopRouteId: routePk }, transaction });
      }
      if (linksRepo && typeof linksRepo.destroy === 'function') {
        await linksRepo.destroy({ filter: { desktopRouteId: routePk }, transaction });
      }
      await routesRepo.destroy({ filter: { id: routePk }, transaction });
      routesDeleted += 1;
    }
  }

  return { routesUpserted, flowModelsUpserted, routesDeleted, flowModelsDeleted };
}

async function applyGovernanceSection(db, governance, targetOrg, { reconcileDeletions = false } = {}, transaction) {
  if (!governance || typeof governance !== 'object') {
    return {
      decisionTablesUpserted: 0,
      slaPoliciesUpserted: 0,
      incidentRulesUpserted: 0,
      automationRulesUpserted: 0,
      webhookSubscriptionsUpserted: 0,
      decisionTablesDeleted: 0,
      slaPoliciesDeleted: 0,
      incidentRulesDeleted: 0,
      automationRulesDeleted: 0,
      webhookSubscriptionsDeleted: 0,
    };
  }

  let decisionTablesUpserted = 0;
  let slaPoliciesUpserted = 0;
  let incidentRulesUpserted = 0;
  let automationRulesUpserted = 0;
  let webhookSubscriptionsUpserted = 0;
  let decisionTablesDeleted = 0;
  let slaPoliciesDeleted = 0;
  let incidentRulesDeleted = 0;
  let automationRulesDeleted = 0;
  let webhookSubscriptionsDeleted = 0;

  const upsertScopedRow = async (repo, uniqueFilter, values) => {
    const existing = await findOneSafe(repo, uniqueFilter, { transaction });
    if (existing) {
      const existingId = val(existing, 'id');
      if (typeof repo.update === 'function') {
        await repo.update({
          ...(existingId != null ? { filterByTk: existingId } : {}),
          filter: uniqueFilter,
          values,
          transaction,
        });
      } else if (typeof existing.update === 'function') {
        await existing.update(values, { transaction });
      }
    } else if (typeof repo.create === 'function') {
      await repo.create({ values, transaction });
    }
  };

  const dmnRepo = db?.getRepository?.('latticeDecisionTables');
  const dmnList = Array.isArray(governance.decisionTables) ? governance.decisionTables : [];
  const keepDmnKeys = new Set();
  for (const rawTable of dmnList) {
    const clean = stripSecretsDeep(rawTable);
    const tableKey = String(clean?.tableKey || '').trim();
    const rawItemOrg = clean?.organizationId != null ? String(clean.organizationId).trim() : '';
    if (targetOrg && rawItemOrg && rawItemOrg !== targetOrg) {
      throw failBundle('DXOS_ORG_MISMATCH', 403, `DMN "${tableKey}" thuộc tổ chức "${rawItemOrg}", không khớp "${targetOrg}".`);
    }
    const scopedOrg = targetOrg || rawItemOrg;
    if (!scopedOrg || scopedOrg.toLowerCase() === 'all' || !SAFE_DMN_KEY_RE.test(tableKey)) continue;
    keepDmnKeys.add(`${scopedOrg}::${tableKey}`);
    if (dmnRepo && (typeof dmnRepo.create === 'function' || typeof dmnRepo.update === 'function')) {
      const parsedVer = parseStrictIntInRange(clean.version ?? 1, 1, 1_000_000) || 1;
      const values = {
        organizationId: scopedOrg,
        tableKey,
        name: String(clean.name || tableKey),
        description: clean.description != null && String(clean.description) ? String(clean.description) : null,
        hitPolicy: VALID_HIT_POLICIES.has(String(clean.hitPolicy || 'FIRST').toUpperCase())
          ? String(clean.hitPolicy || 'FIRST').toUpperCase()
          : 'FIRST',
        inputsJson: Array.isArray(clean.inputsJson) ? clean.inputsJson : [],
        outputsJson: Array.isArray(clean.outputsJson) ? clean.outputsJson : [],
        rulesJson: Array.isArray(clean.rulesJson) ? clean.rulesJson : [],
        version: parsedVer,
        published: clean.published !== false,
        updatedBy: clean.updatedBy != null && String(clean.updatedBy) ? String(clean.updatedBy) : null,
        active: clean.active !== false,
      };
      await upsertScopedRow(dmnRepo, { organizationId: scopedOrg, tableKey }, values);
      decisionTablesUpserted += 1;
    }
  }
  if (reconcileDeletions && dmnRepo && governance.decisionTables !== undefined && typeof dmnRepo.destroy === 'function') {
    const findFilter = targetOrg ? { organizationId: targetOrg } : {};
    const curDmn = (await safeRepoFind(db, 'latticeDecisionTables', { filter: findFilter, limit: 1000, transaction })).map(toObj);
    for (const row of curDmn) {
      const rowOrg = String(row?.organizationId || '').trim();
      const rowKey = String(row?.tableKey || '').trim();
      if (!rowOrg || !rowKey) continue;
      if (targetOrg && rowOrg !== targetOrg) continue;
      if (!keepDmnKeys.has(`${rowOrg}::${rowKey}`)) {
        await dmnRepo.destroy({ filter: { organizationId: rowOrg, tableKey: rowKey }, transaction });
        decisionTablesDeleted += 1;
      }
    }
  }

  const slaRepo = db?.getRepository?.('latticeSlaPolicies');
  const slaList = Array.isArray(governance.slaPolicies) ? governance.slaPolicies : [];
  const keepSlaKeys = new Set();
  for (const rawSla of slaList) {
    const clean = stripSecretsDeep(rawSla);
    const targetCollection = String(clean?.targetCollection || '').trim();
    const priority = String(clean?.priority || 'normal').trim().toLowerCase();
    const rawItemOrg = clean?.organizationId != null ? String(clean.organizationId).trim() : '';
    if (targetOrg && rawItemOrg && rawItemOrg !== targetOrg) {
      throw failBundle('DXOS_ORG_MISMATCH', 403, `SLA "${targetCollection}:${priority}" thuộc tổ chức "${rawItemOrg}", không khớp "${targetOrg}".`);
    }
    const scopedOrg = targetOrg || rawItemOrg;
    if (!scopedOrg || scopedOrg.toLowerCase() === 'all' || !targetCollection || !VALID_SLA_PRIORITIES.has(priority)) continue;
    keepSlaKeys.add(`${scopedOrg}::${targetCollection}::${priority}`);
    if (slaRepo && (typeof slaRepo.create === 'function' || typeof slaRepo.update === 'function')) {
      const escalateRole = String(clean.escalateToRole || 'ldx_manager').trim();
      const values = {
        organizationId: scopedOrg,
        targetCollection,
        priority,
        warnAfterMinutes: Number(clean.warnAfterMinutes) || 240,
        breachAfterMinutes: Number(clean.breachAfterMinutes) || 1440,
        escalateToRole: SAFE_ROLE_RE.test(escalateRole) && !FORBIDDEN_ROLES.has(escalateRole) ? escalateRole : 'ldx_manager',
        notifyChannels: clean.notifyChannels !== undefined ? clean.notifyChannels : null,
        active: clean.active !== false,
      };
      await upsertScopedRow(slaRepo, { organizationId: scopedOrg, targetCollection, priority }, values);
      slaPoliciesUpserted += 1;
    }
  }
  if (reconcileDeletions && slaRepo && governance.slaPolicies !== undefined && typeof slaRepo.destroy === 'function') {
    const findFilter = targetOrg ? { organizationId: targetOrg } : {};
    const curSla = (await safeRepoFind(db, 'latticeSlaPolicies', { filter: findFilter, limit: 1000, transaction })).map(toObj);
    for (const row of curSla) {
      const rowOrg = String(row?.organizationId || '').trim();
      const rowCol = String(row?.targetCollection || '').trim();
      const rowPrio = String(row?.priority || 'normal').trim().toLowerCase();
      if (!rowOrg || !rowCol) continue;
      if (targetOrg && rowOrg !== targetOrg) continue;
      if (!keepSlaKeys.has(`${rowOrg}::${rowCol}::${rowPrio}`)) {
        await slaRepo.destroy({ filter: { organizationId: rowOrg, targetCollection: rowCol, priority: rowPrio }, transaction });
        slaPoliciesDeleted += 1;
      }
    }
  }

  const ruleRepo = db?.getRepository?.('latticeIncidentRules');
  const rulesList = Array.isArray(governance.incidentRules) ? governance.incidentRules : [];
  const keepRuleKeys = new Set();
  for (const rawRule of rulesList) {
    const clean = stripSecretsDeep(rawRule);
    const code = String(clean?.code || '').trim();
    const rawItemOrg = clean?.organizationId != null ? String(clean.organizationId).trim() : '';
    if (targetOrg && rawItemOrg && rawItemOrg !== targetOrg) {
      throw failBundle('DXOS_ORG_MISMATCH', 403, `Incident rule "${code}" thuộc tổ chức "${rawItemOrg}", không khớp "${targetOrg}".`);
    }
    const scopedOrg = targetOrg || rawItemOrg;
    if (!scopedOrg || scopedOrg.toLowerCase() === 'all' || !code) continue;
    keepRuleKeys.add(`${scopedOrg}::${code}`);
    if (ruleRepo && (typeof ruleRepo.create === 'function' || typeof ruleRepo.update === 'function')) {
      const rawSev = String(clean.severity || 'medium').trim().toLowerCase();
      const severity = VALID_INCIDENT_SEVERITIES.has(rawSev) ? rawSev : 'medium';
      const maxObsAge = parseStrictIntInRange(clean.maxObservationAgeSeconds ?? '300', 1, 31_536_000) ?? 300;
      const cooldown = parseStrictIntInRange(clean.cooldownSeconds ?? '300', 0, 31_536_000) ?? 300;
      const values = {
        organizationId: scopedOrg,
        code,
        name: String(clean.name || code),
        active: clean.active !== false,
        assetEntityId: String(clean.assetEntityId || '').trim(),
        attribute: String(clean.attribute || '').trim(),
        operator: String(clean.operator || '>').trim(),
        threshold: String(clean.threshold ?? ''),
        unit: String(clean.unit || '').trim(),
        severity,
        maxObservationAgeSeconds: String(maxObsAge),
        cooldownSeconds: String(cooldown),
        workflowDefinitionId: String(clean.workflowDefinitionId || 'incident-response'),
        workflowDefinitionVersion: String(clean.workflowDefinitionVersion || '1'),
        handlerId: String(clean.handlerId || '').trim(),
      };
      await upsertScopedRow(ruleRepo, { organizationId: scopedOrg, code }, values);
      incidentRulesUpserted += 1;
    }
  }
  if (reconcileDeletions && ruleRepo && governance.incidentRules !== undefined && typeof ruleRepo.destroy === 'function') {
    const findFilter = targetOrg ? { organizationId: targetOrg } : {};
    const curRules = (await safeRepoFind(db, 'latticeIncidentRules', { filter: findFilter, limit: 1000, transaction })).map(toObj);
    for (const row of curRules) {
      const rowOrg = String(row?.organizationId || '').trim();
      const rowCode = String(row?.code || '').trim();
      if (!rowOrg || !rowCode) continue;
      if (targetOrg && rowOrg !== targetOrg) continue;
      if (!keepRuleKeys.has(`${rowOrg}::${rowCode}`)) {
        await ruleRepo.destroy({ filter: { organizationId: rowOrg, code: rowCode }, transaction });
        incidentRulesDeleted += 1;
      }
    }
  }

  const autoRepo = db?.getRepository?.('latticeAutomationRules');
  const autoList = Array.isArray(governance.automationRules) ? governance.automationRules : [];
  const keepAutoKeys = new Set();
  for (let i = 0; i < autoList.length; i += 1) {
    const rawAuto = autoList[i];
    const applyErrors = [];
    if (!rawAuto || typeof rawAuto !== 'object' || Array.isArray(rawAuto)) {
      throw failBundle('INVALID_SOLUTION_BUNDLE', 400, `governance.automationRules[${i}] must be an object`);
    }
    validateAutomationRuleEntry(rawAuto, i, applyErrors);
    if (applyErrors.length > 0) {
      throw failBundle('INVALID_SOLUTION_BUNDLE', 400, applyErrors.join('; '));
    }
    const clean = stripSecretsDeep(rawAuto);
    const ruleKey = String(clean?.ruleKey || '').trim();
    const rawItemOrg = clean?.organizationId != null ? String(clean.organizationId).trim() : '';
    if (targetOrg && rawItemOrg && rawItemOrg !== targetOrg) {
      throw failBundle('DXOS_ORG_MISMATCH', 403, `Automation rule "${ruleKey}" thuộc tổ chức "${rawItemOrg}", không khớp "${targetOrg}".`);
    }
    const scopedOrg = targetOrg || rawItemOrg;
    if (!scopedOrg || scopedOrg.toLowerCase() === 'all' || !ruleKey) continue;
    keepAutoKeys.add(`${scopedOrg}::${ruleKey}`);
    if (autoRepo && (typeof autoRepo.create === 'function' || typeof autoRepo.update === 'function')) {
      const values = {
        organizationId: scopedOrg,
        ruleKey,
        name: String(clean.name || ruleKey),
        description: clean.description != null ? String(clean.description) : null,
        triggerEventType: String(clean.triggerEventType || '*').trim(),
        filterJson: clean.filterJson ?? null,
        dmnTableKey: clean.dmnTableKey != null ? String(clean.dmnTableKey).trim() : null,
        actionsJson: Array.isArray(clean.actionsJson) ? clean.actionsJson : [],
        maxDepth: parseStrictIntInRange(clean.maxDepth ?? 8, 1, 8) ?? 8,
        cooldownSec: parseStrictIntInRange(clean.cooldownSec ?? 0, 0, 31_536_000) ?? 0,
        active: clean.active !== false,
        createdBy: clean.createdBy != null ? String(clean.createdBy) : null,
      };
      await upsertScopedRow(autoRepo, { organizationId: scopedOrg, ruleKey }, values);
      automationRulesUpserted += 1;
    }
  }
  if (reconcileDeletions && autoRepo && governance.automationRules !== undefined && typeof autoRepo.destroy === 'function') {
    const findFilter = targetOrg ? { organizationId: targetOrg } : {};
    const curAuto = (await safeRepoFind(db, 'latticeAutomationRules', { filter: findFilter, limit: 1000, transaction })).map(toObj);
    for (const row of curAuto) {
      const rowOrg = String(row?.organizationId || '').trim();
      const rowKey = String(row?.ruleKey || '').trim();
      if (!rowOrg || !rowKey) continue;
      if (targetOrg && rowOrg !== targetOrg) continue;
      if (!keepAutoKeys.has(`${rowOrg}::${rowKey}`)) {
        await autoRepo.destroy({ filter: { organizationId: rowOrg, ruleKey: rowKey }, transaction });
        automationRulesDeleted += 1;
      }
    }
  }

  const webhookRepo = db?.getRepository?.('latticeWebhookSubscriptions');
  const webhookList = Array.isArray(governance.webhookSubscriptions) ? governance.webhookSubscriptions : [];
  const keepWebhookKeys = new Set();
  for (let i = 0; i < webhookList.length; i += 1) {
    const rawHook = webhookList[i];
    if (!rawHook || typeof rawHook !== 'object' || Array.isArray(rawHook)) {
      throw failBundle('INVALID_SOLUTION_BUNDLE', 400, `governance.webhookSubscriptions[${i}] must be an object`);
    }
    const urlErr = validateSafeWebhookTargetUrl(rawHook.targetUrl, `webhookSubscriptions[${i}]`);
    if (urlErr) {
      throw failBundle('INVALID_SOLUTION_BUNDLE', 400, urlErr);
    }
    const clean = stripSecretsDeep(rawHook);
    const subscriptionKey = String(clean?.subscriptionKey || '').trim();
    const rawItemOrg = clean?.organizationId != null ? String(clean.organizationId).trim() : '';
    if (targetOrg && rawItemOrg && rawItemOrg !== targetOrg) {
      throw failBundle('DXOS_ORG_MISMATCH', 403, `Webhook subscription "${subscriptionKey}" thuộc tổ chức "${rawItemOrg}", không khớp "${targetOrg}".`);
    }
    const scopedOrg = targetOrg || rawItemOrg;
    if (!scopedOrg || scopedOrg.toLowerCase() === 'all' || !subscriptionKey) continue;
    keepWebhookKeys.add(`${scopedOrg}::${subscriptionKey}`);
    if (webhookRepo && (typeof webhookRepo.create === 'function' || typeof webhookRepo.update === 'function')) {
      const values = {
        organizationId: scopedOrg,
        subscriptionKey,
        name: String(clean.name || subscriptionKey),
        targetUrl: String(clean.targetUrl || '').trim(),
        eventPattern: String(clean.eventPattern || '*').trim(),
        active: clean.active !== false,
      };
      await upsertScopedRow(webhookRepo, { organizationId: scopedOrg, subscriptionKey }, values);
      webhookSubscriptionsUpserted += 1;
    }
  }
  if (reconcileDeletions && webhookRepo && governance.webhookSubscriptions !== undefined && typeof webhookRepo.destroy === 'function') {
    const findFilter = targetOrg ? { organizationId: targetOrg } : {};
    const curHooks = (await safeRepoFind(db, 'latticeWebhookSubscriptions', { filter: findFilter, limit: 1000, transaction })).map(toObj);
    for (const row of curHooks) {
      const rowOrg = String(row?.organizationId || '').trim();
      const rowKey = String(row?.subscriptionKey || '').trim();
      if (!rowOrg || !rowKey) continue;
      if (targetOrg && rowOrg !== targetOrg) continue;
      if (!keepWebhookKeys.has(`${rowOrg}::${rowKey}`)) {
        await webhookRepo.destroy({ filter: { organizationId: rowOrg, subscriptionKey: rowKey }, transaction });
        webhookSubscriptionsDeleted += 1;
      }
    }
  }

  return {
    decisionTablesUpserted,
    slaPoliciesUpserted,
    incidentRulesUpserted,
    automationRulesUpserted,
    webhookSubscriptionsUpserted,
    decisionTablesDeleted,
    slaPoliciesDeleted,
    incidentRulesDeleted,
    automationRulesDeleted,
    webhookSubscriptionsDeleted,
  };
}

async function applySolutionBundleSections(
  db,
  bundle,
  { targetOrg = null, enableWorkflows = false, reconcileV3Deletions = false } = {},
  transaction,
) {
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
  const routesBlocksCounts = await applyRoutesAndBlocksSection(
    db,
    bundle.routesAndBlocks,
    { reconcileDeletions: reconcileV3Deletions === true },
    transaction,
  );
  const govCounts = await applyGovernanceSection(
    db,
    bundle.governance,
    targetOrg,
    { reconcileDeletions: reconcileV3Deletions === true },
    transaction,
  );

  return {
    rolesUpserted,
    roleResourcesUpserted,
    portalsUpserted,
    workflowsUpserted: wfCounts.workflowsUpserted,
    nodesUpserted: wfCounts.nodesUpserted,
    customCollectionsUpserted,
    aiProfilesUpserted,
    routesUpserted: routesBlocksCounts.routesUpserted,
    flowModelsUpserted: routesBlocksCounts.flowModelsUpserted,
    routesDeleted: routesBlocksCounts.routesDeleted,
    flowModelsDeleted: routesBlocksCounts.flowModelsDeleted,
    decisionTablesUpserted: govCounts.decisionTablesUpserted,
    slaPoliciesUpserted: govCounts.slaPoliciesUpserted,
    incidentRulesUpserted: govCounts.incidentRulesUpserted,
    automationRulesUpserted: govCounts.automationRulesUpserted,
    webhookSubscriptionsUpserted: govCounts.webhookSubscriptionsUpserted,
    decisionTablesDeleted: govCounts.decisionTablesDeleted,
    slaPoliciesDeleted: govCounts.slaPoliciesDeleted,
    incidentRulesDeleted: govCounts.incidentRulesDeleted,
    automationRulesDeleted: govCounts.automationRulesDeleted,
    webhookSubscriptionsDeleted: govCounts.webhookSubscriptionsDeleted,
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
  if (targetOrg && incomingBundle.governance && typeof incomingBundle.governance === 'object') {
    for (const listKey of ['decisionTables', 'slaPolicies', 'incidentRules', 'automationRules', 'webhookSubscriptions']) {
      const items = Array.isArray(incomingBundle.governance[listKey]) ? incomingBundle.governance[listKey] : [];
      for (const item of items) {
        const itemOrg = item?.organizationId != null ? String(item.organizationId).trim() : '';
        if (itemOrg && itemOrg !== targetOrg) {
          throw failBundle(
            'DXOS_ORG_MISMATCH',
            403,
            `Bản ghi governance (${listKey}) thuộc tổ chức "${itemOrg}", không thể nhập vào "${targetOrg}".`,
          );
        }
      }
    }
  }
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
      { targetOrg, enableWorkflows: true, reconcileV3Deletions: true },
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
  RESERVED_SYSTEM_LAYOUT_UIDS,
  SYSTEM_PROTECTED_COLLECTIONS,
  applyGovernanceSection,
  getRouteKey,
  sortRoutesTopologically,
  stripSecretsDeep,
  validateSafeWebhookTargetUrl,
  exportSolutionBundle,
  validateSolutionBundle,
  diffSolutionBundle,
  importSolutionBundle,
  rollbackLastSolutionBundle,
};
