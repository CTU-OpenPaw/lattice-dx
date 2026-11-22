/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { createHash } = require('node:crypto');

const BUNDLE_SCHEMA_VERSION = 'latticedx.solution-bundle/v1';
const FORBIDDEN_ROLES = new Set(['root', 'admin', 'ldx_admin']);
const SAFE_ROLE_RE = /^ldx_[a-z0-9_]{2,48}$/;
const CUSTOM_COLLECTION_RE = /^latticeCustom[A-Z][A-Za-z0-9]{1,40}$/;
const SECRET_KEY_RE = /password|secret|token|apikey|api_key|privatekey|authorization|cookie/i;

const val = (row, key) => (typeof row?.get === 'function' ? row.get(key) : row?.[key]);
const toObj = (row) => (typeof row?.toJSON === 'function' ? row.toJSON() : { ...(row || {}) });

function failBundle(code, status = 400, message = code) {
  return Object.assign(new Error(message), { code, status });
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
    return [];
  }
}

async function exportSolutionBundle(db, { organizationId = null, platformVersion = '0.2.0' } = {}) {
  const rawRoles = await safeRepoFind(db, 'roles', { limit: 500 });
  const rawRes = await safeRepoFind(db, 'dataSourcesRolesResources', { limit: 2000 });
  const rawPortals = await safeRepoFind(db, 'uiLayouts', { limit: 500 });
  const rawWorkflows = await safeRepoFind(db, 'workflows', { filter: { current: true }, limit: 500 });
  const rawNodes = await safeRepoFind(db, 'flow_nodes', { limit: 2000 });
  const rawAiProfiles = await safeRepoFind(
    db,
    'latticeAiProfiles',
    organizationId ? { filter: { organizationId }, limit: 500 } : { limit: 500 },
  );
  const rawCollections = await safeRepoFind(db, 'collections', { limit: 500 });

  const resByRole = new Map();
  for (const r of rawRes) {
    const obj = toObj(r);
    if (!obj.roleName) continue;
    const list = resByRole.get(obj.roleName) || [];
    list.push(stripSecretsDeep({ name: obj.name, dataSourceKey: obj.dataSourceKey || 'main', usingActionsConfig: obj.usingActionsConfig !== false, actions: obj.actions || [] }));
    resByRole.set(obj.roleName, list);
  }

  const roles = rawRoles
    .map(toObj)
    .filter((r) => typeof r.name === 'string' && SAFE_ROLE_RE.test(r.name) && !FORBIDDEN_ROLES.has(r.name))
    .map((r) => stripSecretsDeep({
      name: r.name,
      title: r.title || r.name,
      description: r.description || '',
      snippets: Array.isArray(r.snippets) ? [...r.snippets].filter((s) => s !== 'pm' && s !== 'pm.*').sort() : [],
      allowAll: false,
      allowConfigure: false,
      resources: (resByRole.get(r.name) || []).sort((a, b) => String(a.name).localeCompare(String(b.name))),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const portals = rawPortals
    .map(toObj)
    .filter((p) => String(p.uid || '').startsWith('ldx-portal-'))
    .map((p) => stripSecretsDeep({
      uid: p.uid,
      name: p.name || p.title || p.uid,
      title: p.title || p.name || p.uid,
      options: p.options || {},
    }))
    .sort((a, b) => String(a.uid).localeCompare(String(b.uid)));

  const nodesByWf = new Map();
  for (const n of rawNodes) {
    const obj = toObj(n);
    const list = nodesByWf.get(String(obj.workflowId)) || [];
    list.push(stripSecretsDeep({ key: obj.key || obj.id, type: obj.type, title: obj.title, config: obj.config || {} }));
    nodesByWf.set(String(obj.workflowId), list);
  }

  const workflows = rawWorkflows
    .map(toObj)
    .filter((w) => w.current !== false)
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
    .filter((p) => !organizationId || p.organizationId === organizationId)
    .map((p) => stripSecretsDeep({
      username: p.username,
      nickname: p.nickname || p.username,
      position: p.position || '',
      organizationId: p.organizationId || organizationId || '',
      enabled: p.enabled !== false,
      systemPrompt: p.systemPrompt || '',
      tools: Array.isArray(p.tools) ? [...p.tools].sort() : [],
    }))
    .sort((a, b) => String(a.username).localeCompare(String(b.username)));

  const customCollections = rawCollections
    .map(toObj)
    .filter((c) => typeof c.name === 'string' && CUSTOM_COLLECTION_RE.test(c.name))
    .map((c) => stripSecretsDeep({
      name: c.name,
      title: c.title || c.name,
      fields: Array.isArray(c.fields) ? c.fields : [],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const payload = { roles, portals, workflows, aiProfiles, customCollections };
  const contentSha256 = createHash('sha256').update(JSON.stringify(payload)).digest('hex');

  return {
    metadata: {
      schemaVersion: BUNDLE_SCHEMA_VERSION,
      platformVersion: String(platformVersion || '0.2.0'),
      organizationId: organizationId || 'all',
      exportedAt: new Date().toISOString(),
      contentSha256,
    },
    ...payload,
  };
}

function validateSolutionBundle(bundle) {
  const errors = [];
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
    return { valid: false, errors: ['Bundle must be a JSON object'] };
  }
  const serializedLen = JSON.stringify(bundle).length;
  if (serializedLen > 5_000_000) {
    errors.push('Bundle exceeds maximum 5MB payload size');
  }
  if (bundle.metadata?.schemaVersion !== BUNDLE_SCHEMA_VERSION) {
    errors.push(`Unsupported schemaVersion; expected ${BUNDLE_SCHEMA_VERSION}`);
  }
  if (Array.isArray(bundle.roles)) {
    for (const r of bundle.roles) {
      const name = String(r?.name || '');
      if (FORBIDDEN_ROLES.has(name) || !SAFE_ROLE_RE.test(name)) {
        errors.push(`Forbidden or invalid role name: ${name || '(empty)'}`);
      }
      if (r?.allowAll === true || r?.allowConfigure === true) {
        errors.push(`Privilege escalation flags allowAll/allowConfigure forbidden on role: ${name}`);
      }
    }
  }
  if (Array.isArray(bundle.customCollections)) {
    for (const c of bundle.customCollections) {
      const cname = String(c?.name || '');
      if (!CUSTOM_COLLECTION_RE.test(cname)) {
        errors.push(`Custom collection must match latticeCustom*: ${cname || '(empty)'}`);
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
  const summary = { added: 0, changed: 0, unchanged: 0, removed: 0 };
  for (const s of Object.values(sections)) {
    summary.added += s.added.length;
    summary.changed += s.changed.length;
    summary.unchanged += s.unchanged.length;
    summary.removed += s.removed.length;
  }
  return { summary, sections };
}

async function importSolutionBundle(db, incomingBundle, { dryRun = true, organizationId = null } = {}) {
  const validation = validateSolutionBundle(incomingBundle);
  if (!validation.valid) {
    throw failBundle('INVALID_SOLUTION_BUNDLE', 400, validation.errors.join('; '));
  }
  const targetOrg = organizationId || (incomingBundle.metadata?.organizationId && incomingBundle.metadata.organizationId !== 'all' ? incomingBundle.metadata.organizationId : null);
  const current = await exportSolutionBundle(db, { organizationId: targetOrg });
  const diff = diffSolutionBundle(current, incomingBundle);
  if (dryRun !== false) {
    return { dryRun: true, valid: true, diff, applied: null };
  }

  let rolesUpserted = 0;
  let aiProfilesUpserted = 0;

  const runApply = async (transaction) => {
    const roleRepo = db?.getRepository?.('roles');
    if (roleRepo && Array.isArray(incomingBundle.roles)) {
      for (const rawRole of incomingBundle.roles) {
        const cleanRole = stripSecretsDeep(rawRole);
        const safeSnippets = Array.isArray(cleanRole.snippets)
          ? cleanRole.snippets.filter((s) => s !== 'pm' && s !== 'pm.*')
          : [];
        const values = {
          name: cleanRole.name,
          title: cleanRole.title || cleanRole.name,
          description: cleanRole.description || '',
          snippets: safeSnippets,
          allowAll: false,
          allowConfigure: false,
        };
        const existing = await roleRepo.findOne({ filter: { name: cleanRole.name }, transaction });
        if (existing) {
          await roleRepo.update({ filter: { name: cleanRole.name }, values, transaction });
        } else {
          await roleRepo.create({ values, transaction });
        }
        rolesUpserted += 1;
      }
    }

    const aiRepo = db?.getRepository?.('latticeAiProfiles');
    if (aiRepo && Array.isArray(incomingBundle.aiProfiles)) {
      for (const rawProf of incomingBundle.aiProfiles) {
        const clean = stripSecretsDeep(rawProf);
        if (!clean.username) continue;
        const scopedOrg = targetOrg || clean.organizationId || 'native-ui-lab';
        const values = {
          username: clean.username,
          nickname: clean.nickname || clean.username,
          position: clean.position || '',
          organizationId: scopedOrg,
          enabled: clean.enabled !== false,
          systemPrompt: clean.systemPrompt || '',
          tools: Array.isArray(clean.tools) ? clean.tools : [],
        };
        const existing = await aiRepo.findOne({ filter: { username: clean.username, organizationId: scopedOrg }, transaction });
        if (existing) {
          await aiRepo.update({ filterByTk: val(existing, 'id'), values, transaction });
        } else {
          await aiRepo.create({ values, transaction });
        }
        aiProfilesUpserted += 1;
      }
    }
  };

  if (db?.sequelize?.transaction) {
    await db.sequelize.transaction(runApply);
  } else {
    await runApply(undefined);
  }

  return {
    dryRun: false,
    valid: true,
    diff,
    applied: { rolesUpserted, aiProfilesUpserted },
  };
}

module.exports = {
  BUNDLE_SCHEMA_VERSION,
  stripSecretsDeep,
  exportSolutionBundle,
  validateSolutionBundle,
  diffSolutionBundle,
  importSolutionBundle,
};
