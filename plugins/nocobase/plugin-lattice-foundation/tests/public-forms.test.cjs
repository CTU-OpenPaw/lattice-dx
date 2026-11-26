/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const PLUGIN_ROOT = join(__dirname, '..');

function withMockedNocobase(fn) {
  const origLoad = Module._load;
  class MockMigration {
    constructor(context = {}) { this.context = context; }
  }
  class MockPlugin {
    constructor(app, options = {}) {
      this.app = app;
      this.db = app?.db;
      this.options = options;
    }
  }
  Module._load = function mockedLoad(request, parent, isMain) {
    if (request === '@nocobase/server') {
      return { Migration: MockMigration, Plugin: MockPlugin };
    }
    if (request === '@nocobase/database') {
      return { defineCollection: (def) => def };
    }
    return origLoad.call(this, request, parent, isMain);
  };
  return Promise.resolve()
    .then(() => fn())
    .finally(() => {
      Module._load = origLoad;
    });
}

function createFakeReact() {
  let si = 0;
  let ei = 0;
  let mi = 0;
  let ci = 0;
  const states = [];
  const effects = [];
  const memos = [];
  const callbacks = [];
  const pendingEffects = [];
  const depsChanged = (a, b) => !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]));

  return {
    Fragment: 'Fragment',
    createElement(type, props, ...children) {
      return {
        type,
        props: props || {},
        children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
      };
    },
    useState(init) {
      const idx = si++;
      if (!(idx in states)) states[idx] = typeof init === 'function' ? init() : init;
      return [states[idx], (u) => { states[idx] = typeof u === 'function' ? u(states[idx]) : u; }];
    },
    useEffect(fn, deps) {
      const idx = ei++;
      const prev = effects[idx];
      if (!prev || depsChanged(prev.deps, deps)) {
        pendingEffects.push({ idx, fn, deps });
      }
    },
    useMemo(fn, deps) {
      const idx = mi++;
      const prev = memos[idx];
      if (!prev || depsChanged(prev.deps, deps)) {
        memos[idx] = { value: fn(), deps };
      }
      return memos[idx].value;
    },
    useCallback(fn, deps) {
      const idx = ci++;
      const prev = callbacks[idx];
      if (!prev || depsChanged(prev.deps, deps)) {
        callbacks[idx] = { fn, deps };
      }
      return callbacks[idx].fn;
    },
    _render(Comp, props = {}) {
      si = 0; ei = 0; mi = 0; ci = 0;
      return Comp(props);
    },
    async _flushEffects() {
      for (const ef of pendingEffects.splice(0)) {
        if (effects[ef.idx]?.cleanup) effects[ef.idx].cleanup();
        const cleanup = await ef.fn();
        effects[ef.idx] = { deps: ef.deps, cleanup: typeof cleanup === 'function' ? cleanup : null };
      }
      await new Promise((r) => setImmediate(r));
    },
  };
}

function findNode(node, pred) {
  if (!node || typeof node !== 'object') return null;
  if (pred(node)) return node;
  if (Array.isArray(node.children)) {
    for (const c of node.children) {
      const hit = findNode(c, pred);
      if (hit) return hit;
    }
  }
  return null;
}

function findAllNodes(node, pred, acc = []) {
  if (!node || typeof node !== 'object') return acc;
  if (pred(node)) acc.push(node);
  if (Array.isArray(node.children)) {
    for (const c of node.children) findAllNodes(c, pred, acc);
  }
  return acc;
}

function collectText(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node.children)) return node.children.map(collectText).join(' ');
  return '';
}

function sha256(str) {
  return createHash('sha256').update(String(str), 'utf8').digest('hex');
}

function createFakeEnv({ forms = [], submissions = [], targetRecords = {}, employees = [], roles = [], rolesUsers = [] } = {}) {
  const store = {
    latticePublicForms: forms.map((f, i) => ({ id: f.id ?? i + 1, ...f })),
    latticePublicFormSubmissions: submissions.map((s, i) => ({ id: s.id ?? i + 1, ...s })),
    latticeEmployees: employees.map((e, i) => ({ id: e.id ?? i + 1, ...e })),
    roles: roles.map((r, i) => ({ id: r.id ?? i + 1, ...r })),
    rolesUsers: rolesUsers.map((ru, i) => ({ id: ru.id ?? i + 1, ...ru })),
    ...Object.fromEntries(Object.entries(targetRecords).map(([k, v]) => [k, v.map((r, i) => ({ id: r.id ?? i + 1, ...r }))])),
  };
  let nextId = 100;
  const rlsEvents = [];

  function matchesFilter(row, filter) {
    if (!filter || typeof filter !== 'object') return true;
    for (const [k, v] of Object.entries(filter)) {
      if (k === '$and' && Array.isArray(v)) {
        if (!v.every((sub) => matchesFilter(row, sub))) return false;
        continue;
      }
      if (v && typeof v === 'object' && !Array.isArray(v) && Object.hasOwn(v, '$in')) {
        if (!v.$in.includes(row[k])) return false;
        continue;
      }
      if (v && typeof v === 'object' && !Array.isArray(v) && Object.hasOwn(v, '$eq')) {
        if (row[k] !== v.$eq) return false;
        continue;
      }
      if (row[k] !== v) return false;
    }
    return true;
  }

  function makeRepo(name) {
    if (!store[name]) store[name] = [];
    const wrapRow = (row) => ({
      ...row,
      get: (k) => row[k],
      toJSON: () => ({ ...row }),
      update: async (patch) => {
        Object.assign(row, patch, { updatedAt: new Date().toISOString() });
        return wrapRow(row);
      },
      destroy: async () => {
        const idx = store[name].indexOf(row);
        if (idx >= 0) store[name].splice(idx, 1);
      },
    });
    return {
      async find(opts = {}) {
        let rows = store[name].filter((r) => matchesFilter(r, opts.filter));
        if (Array.isArray(opts.sort) && opts.sort.includes('-id')) {
          rows = [...rows].sort((a, b) => Number(b.id) - Number(a.id));
        }
        if (opts.limit) rows = rows.slice(0, opts.limit);
        return rows.map(wrapRow);
      },
      async findOne(opts = {}) {
        const hit = store[name].find((r) => matchesFilter(r, opts.filter));
        return hit ? wrapRow(hit) : null;
      },
      async create(opts = {}) {
        const now = new Date().toISOString();
        const rec = { id: ++nextId, createdAt: now, updatedAt: now, ...(opts.values || {}) };
        store[name].push(rec);
        return wrapRow(rec);
      },
      async update(opts = {}) {
        const hits = store[name].filter((r) => matchesFilter(r, opts.filter || (opts.filterByTk ? { id: opts.filterByTk } : {})));
        for (const r of hits) Object.assign(r, opts.values || {}, { updatedAt: new Date().toISOString() });
        return hits.map(wrapRow);
      },
      async destroy(opts = {}) {
        const before = store[name].length;
        store[name] = store[name].filter((r) => !matchesFilter(r, opts.filter || (opts.filterByTk ? { id: opts.filterByTk } : {})));
        return before - store[name].length;
      },
    };
  }

  const fakeTx = { id: 'tx-forms-1' };
  const db = {
    sequelize: {
      getDialect: () => 'postgres',
      transaction: async (cb) => cb(fakeTx),
      query: async (sql, opts) => {
        rlsEvents.push({ sql, replacements: opts?.replacements || null });
        return [[]];
      },
    },
    getRepository(name) {
      return makeRepo(name);
    },
  };

  const definedResources = {};
  const aclAllows = [];
  const middlewares = [];
  const app = {
    db,
    resourceManager: {
      define(def) { definedResources[def.name] = def; },
      use(mw, opts) { middlewares.push({ mw, opts }); },
    },
    acl: {
      allow(resource, actions, scope) { aclAllows.push({ resource, actions, scope }); },
    },
  };

  return { store, db, app, definedResources, aclAllows, middlewares, rlsEvents };
}

function makeCtx({ method = 'GET', params = {}, body = {}, headers = {}, ip = '203.0.113.10', user = null, role = null, roles = [] } = {}) {
  const resHeaders = {};
  return {
    method,
    ip,
    headers,
    request: { body, headers, ip },
    action: { params },
    state: {
      currentUser: user,
      currentRole: role,
      currentRoles: roles,
    },
    set(k, v) { resHeaders[k.toLowerCase()] = v; },
    get(k) { return headers[k] ?? headers[k.toLowerCase()] ?? ''; },
    throw(status, msg) {
      throw Object.assign(new Error(msg || `HTTP ${status}`), { status });
    },
    _resHeaders: resHeaders,
  };
}

test('collections public-forms & public-form-submissions define schema-only tables with compliant index names', async () => {
  await withMockedNocobase(async () => {
    const publicForms = require('../src/server/collections/public-forms');
    const publicFormSubmissions = require('../src/server/collections/public-form-submissions');

    assert.equal(publicForms.name, 'latticePublicForms');
    assert.deepEqual(publicForms.migrationRules, ['schema-only']);
    assert.equal(publicForms.fields.find((f) => f.name === 'organizationId')?.allowNull, false);
    assert.equal(publicForms.fields.find((f) => f.name === 'slug')?.allowNull, false);

    assert.equal(publicFormSubmissions.name, 'latticePublicFormSubmissions');
    assert.deepEqual(publicFormSubmissions.migrationRules, ['schema-only']);
    assert.equal(publicFormSubmissions.fields.find((f) => f.name === 'organizationId')?.allowNull, false);

    for (const col of [publicForms, publicFormSubmissions]) {
      for (const idx of col.indexes) {
        assert.match(idx.name, /^u?idx_lattice_[a-z0-9_]+$/);
        assert.ok(idx.name.length <= 55, `Index name too long: ${idx.name}`);
      }
    }
  });
});

test('migration 20261202000300-public-forms-rls creates both tables without inline UNIQUE, attaches FORCE RLS, and supports reversible down()', async () => {
  await withMockedNocobase(async () => {
    const MigrationCls = require('../src/server/migrations/20261202000300-public-forms-rls');
    const queries = [];
    const pgDb = {
      sequelize: {
        getDialect: () => 'postgres',
        transaction: async (cb) => cb({ id: 'tx-mig' }),
        query: async (sql) => {
          queries.push(sql);
          return [[]];
        },
      },
    };
    const mig = new MigrationCls({ db: pgDb });
    assert.equal(mig.on, 'afterSync');

    await mig.up();
    const upSql = queries.join('\n');
    assert.match(upSql, /CREATE TABLE IF NOT EXISTS "latticePublicForms"/);
    assert.match(upSql, /CREATE TABLE IF NOT EXISTS "latticePublicFormSubmissions"/);
    assert.match(upSql, /CREATE UNIQUE INDEX IF NOT EXISTS uidx_lattice_public_forms_slug/);
    assert.match(upSql, /CREATE UNIQUE INDEX IF NOT EXISTS uidx_lattice_pfs_org_code/);

    const createTableMatches = upSql.match(/CREATE TABLE IF NOT EXISTS[\s\S]*?\);/g) || [];
    assert.equal(createTableMatches.length, 2);
    for (const stmt of createTableMatches) {
      assert.equal(/\bUNIQUE\b/i.test(stmt), false, `Inline UNIQUE forbidden in CREATE TABLE: ${stmt}`);
    }

    assert.match(upSql, /ALTER TABLE public\."latticePublicForms" ENABLE ROW LEVEL SECURITY;[\s\S]*FORCE ROW LEVEL SECURITY/);
    assert.match(upSql, /ALTER TABLE public\."latticePublicFormSubmissions" ENABLE ROW LEVEL SECURITY;[\s\S]*FORCE ROW LEVEL SECURITY/);
    assert.match(upSql, /FOR ALL TO PUBLIC USING/);

    queries.length = 0;
    await mig.down();
    const downSql = queries.join('\n');
    assert.match(downSql, /DROP POLICY IF EXISTS lattice_tenant_isolation ON public\."latticePublicFormSubmissions"/);
    assert.match(downSql, /DROP POLICY IF EXISTS lattice_tenant_isolation ON public\."latticePublicForms"/);
    assert.match(downSql, /DROP TABLE IF EXISTS "latticePublicFormSubmissions"/);
    assert.match(downSql, /DROP TABLE IF EXISTS "latticePublicForms"/);
  });
});

test('public-forms blocks prototype pollution, unallowlisted target collections, and reserved slugs', async () => {
  await withMockedNocobase(async () => {
    const pf = require('../src/server/public-forms');

    assert.equal(pf.isAllowlistedPublicFormCollection('latticeRequests'), true);
    assert.equal(pf.isAllowlistedPublicFormCollection('latticeCustomSupportTicket'), true);
    assert.equal(pf.isAllowlistedPublicFormCollection('users'), false);
    assert.equal(pf.isAllowlistedPublicFormCollection('latticeApiKeys'), false);
    assert.equal(pf.isAllowlistedPublicFormCollection('latticePublicForms'), false);

    assert.throws(
      () => pf.validatePublicFormDefinition({
        slug: 'admin',
        title: 'Bad Slug',
        targetCollection: 'latticeRequests',
        allowedFieldsJson: [{ name: 'name', type: 'string', required: true }],
      }),
      { code: 'FORM_SLUG_RESERVED' },
    );

    assert.throws(
      () => pf.validatePublicFormDefinition({
        slug: 'support-intake',
        title: 'Users Escape',
        targetCollection: 'users',
        allowedFieldsJson: [{ name: 'username', type: 'string' }],
      }),
      { code: 'FORM_TARGET_COLLECTION_FORBIDDEN' },
    );

    const polluted = JSON.parse('{"slug":"support-intake","title":"Test","targetCollection":"latticeRequests","allowedFieldsJson":[{"name":"name","type":"string"}],"__proto__":{"polluted":true}}');
    assert.throws(
      () => pf.validatePublicFormDefinition(polluted),
      { code: 'FORM_PROTOTYPE_POLLUTION_BLOCKED' },
    );

    assert.throws(
      () => pf.validatePublicFormDefinition({
        slug: 'support-intake',
        title: 'Blocked Field',
        targetCollection: 'latticeRequests',
        allowedFieldsJson: [{ name: 'organizationId', type: 'string' }],
      }),
      { code: 'FORM_FIELD_FORBIDDEN' },
    );
  });
});

test('dxosForms public meta, submit, and status enforce zero-PII, honeypot, access token, rate limiting, and tenant RLS', async () => {
  await withMockedNocobase(async () => {
    const { registerPublicForms } = require('../src/server/public-forms');
    const prevRls = process.env.DX_PG_RLS_SESSION;
    process.env.DX_PG_RLS_SESSION = 'true';

    try {
      const secretFormToken = 'ftok_secret_alpha_99';
      const env = createFakeEnv({
        forms: [
          {
            id: 11,
            organizationId: 'org-alpha',
            slug: 'cold-intake',
            title: 'Cold Chain Intake',
            description: 'Submit temperature incident intake',
            targetCollection: 'latticeRequests',
            allowedFieldsJson: [
              { name: 'name', label: 'Subject', type: 'string', required: true, maxLength: 120 },
              { name: 'description', label: 'Details', type: 'text', required: false, maxLength: 500 },
              { name: 'category', label: 'Category', type: 'select', options: ['incident', 'support'], required: true },
            ],
            defaultValuesJson: { category: 'support' },
            requireAccessToken: true,
            accessTokenHash: sha256(secretFormToken),
            honeypotField: '_hp_website',
            rateLimitPerMinute: 2,
            workflowRuleKey: 'internal-secret-wf-key',
            active: true,
          },
        ],
      });

      registerPublicForms(env.app);
      const res = env.definedResources.dxosForms;
      assert.ok(res);
      assert.ok(env.aclAllows.some((a) => a.resource === 'dxosForms' && a.scope === 'public' && a.actions.includes('meta') && a.actions.includes('submit') && a.actions.includes('status')));

      // 1. Public meta returns sanitized schema ONLY (no organizationId, no accessTokenHash, no workflowRuleKey)
      const metaCtx = makeCtx({ method: 'GET', params: { slug: 'cold-intake' } });
      await res.actions.meta(metaCtx);
      assert.equal(metaCtx.body.slug, 'cold-intake');
      assert.equal(metaCtx.body.organizationId, undefined);
      assert.equal(metaCtx.body.accessTokenHash, undefined);
      assert.equal(metaCtx.body.workflowRuleKey, undefined);
      assert.equal(metaCtx.body.requireAccessToken, true);
      assert.equal(metaCtx.body.fields.length, 3);

      // 2. Honeypot triggers fail-closed 400
      const botCtx = makeCtx({
        method: 'POST',
        ip: '198.51.100.1',
        body: {
          slug: 'cold-intake',
          token: secretFormToken,
          _hp_website: 'https://spam.example',
          values: { name: 'Bot', category: 'incident' },
        },
      });
      await assert.rejects(() => res.actions.submit(botCtx), { code: 'FORM_BOT_DETECTED', status: 400 });

      // 3. Invalid access token triggers 401
      const badTokCtx = makeCtx({
        method: 'POST',
        ip: '198.51.100.2',
        body: {
          slug: 'cold-intake',
          token: 'wrong-token',
          values: { name: 'Alice', category: 'incident' },
        },
      });
      await assert.rejects(() => res.actions.submit(badTokCtx), { code: 'FORM_ACCESS_TOKEN_INVALID', status: 401 });

      // 4. Client trying to spoof organizationId or unallowlisted field is blocked fail-closed
      const spoofCtx = makeCtx({
        method: 'POST',
        ip: '198.51.100.3',
        body: {
          slug: 'cold-intake',
          token: secretFormToken,
          values: { name: 'Alice', category: 'incident', organizationId: 'org-evil' },
        },
      });
      await assert.rejects(() => res.actions.submit(spoofCtx), { status: 400 });

      // 5. Valid submission succeeds with zero-PII receipt & creates target record under org-alpha RLS
      const okCtx = makeCtx({
        method: 'POST',
        ip: '198.51.100.4',
        body: {
          slug: 'cold-intake',
          token: secretFormToken,
          values: { name: 'Alice Sensitive PII Name', description: 'alice@example.com private note', category: 'incident' },
        },
      });
      await res.actions.submit(okCtx);
      assert.equal(okCtx.body.ok, true);
      assert.equal(okCtx.body.slug, 'cold-intake');
      assert.match(okCtx.body.submissionCode, /^LDX-FRM-[A-F0-9]{8}$/);
      assert.match(okCtx.body.statusToken, /^ldx_frm_[a-f0-9]{48}$/);
      assert.equal(okCtx.body.status, 'submitted');
      const receiptJson = JSON.stringify(okCtx.body);
      assert.equal(receiptJson.includes('Alice Sensitive PII Name'), false);
      assert.equal(receiptJson.includes('alice@example.com'), false);
      assert.equal(receiptJson.includes('org-alpha'), false);

      assert.equal(env.store.latticeRequests.length, 1);
      assert.equal(env.store.latticeRequests[0].organizationId, 'org-alpha');
      assert.equal(env.store.latticeRequests[0].status, 'submitted');
      assert.equal(env.store.latticeRequests[0].version, 1);
      assert.equal(env.store.latticeRequests[0].amendmentNo, 0);
      assert.equal(env.store.latticePublicFormSubmissions.length, 1);
      assert.equal(env.store.latticePublicFormSubmissions[0].organizationId, 'org-alpha');
      assert.equal(JSON.stringify(env.store.latticePublicFormSubmissions[0]).includes('alice@example.com'), false);
      assert.ok(env.rlsEvents.some((e) => e.sql.includes("set_config('app.current_org'") && e.replacements?.orgId === 'org-alpha'));

      // 5b. Immediate status lookup right after submit ALSO reports 'submitted' (no draft/submitted contradiction)
      const immediateStatusCtx = makeCtx({
        method: 'GET',
        ip: '198.51.100.5',
        params: {
          slug: 'cold-intake',
          submissionCode: okCtx.body.submissionCode,
          token: okCtx.body.statusToken,
        },
      });
      await res.actions.status(immediateStatusCtx);
      assert.equal(immediateStatusCtx.body.status, 'submitted');

      // 6. Zero-PII status check reflects live status updates from target record without leaking PII
      env.store.latticeRequests[0].status = 'approved';
      const statusCtx = makeCtx({
        method: 'GET',
        ip: '198.51.100.5',
        params: {
          slug: 'cold-intake',
          submissionCode: okCtx.body.submissionCode,
          token: okCtx.body.statusToken,
        },
      });
      await res.actions.status(statusCtx);
      assert.equal(statusCtx.body.slug, 'cold-intake');
      assert.equal(statusCtx.body.submissionCode, okCtx.body.submissionCode);
      assert.equal(statusCtx.body.status, 'approved');
      assert.equal(JSON.stringify(statusCtx.body).includes('alice@example.com'), false);
      assert.equal(JSON.stringify(statusCtx.body).includes('Alice Sensitive PII Name'), false);
      assert.equal(JSON.stringify(statusCtx.body).includes('org-alpha'), false);

      // Bad status token rejected
      const badStatusCtx = makeCtx({
        method: 'GET',
        ip: '198.51.100.5',
        params: {
          slug: 'cold-intake',
          submissionCode: okCtx.body.submissionCode,
          token: 'ldx_frm_000000000000000000000000000000000000000000000000',
        },
      });
      await assert.rejects(() => res.actions.status(badStatusCtx), { code: 'FORM_STATUS_UNAUTHORIZED', status: 401 });

      // 7. Rate limiter blocks 3rd submission from same IP + slug with 429 + Retry-After
      const secondOkCtx = makeCtx({
        method: 'POST',
        ip: '198.51.100.4',
        body: {
          slug: 'cold-intake',
          token: secretFormToken,
          values: { name: 'Second Valid', category: 'support' },
        },
      });
      await res.actions.submit(secondOkCtx);

      const thirdBlockedCtx = makeCtx({
        method: 'POST',
        ip: '198.51.100.4',
        body: {
          slug: 'cold-intake',
          token: secretFormToken,
          values: { name: 'Third Blocked', category: 'support' },
        },
      });
      await assert.rejects(() => res.actions.submit(thirdBlockedCtx), { code: 'RATE_LIMIT_EXCEEDED', status: 429 });
      assert.ok(Number(thirdBlockedCtx._resHeaders['retry-after']) >= 1);
    } finally {
      if (prevRls === undefined) delete process.env.DX_PG_RLS_SESSION;
      else process.env.DX_PG_RLS_SESSION = prevRls;
    }
  });
});

test('dxosForms admin actions enforce org isolation, admin RBAC, PAT write scope, and block direct CRUD via guard middleware', async () => {
  await withMockedNocobase(async () => {
    const { registerPublicForms } = require('../src/server/public-forms');
    const env = createFakeEnv({
      employees: [
        { id: 1, userId: 10, organizationId: 'org-a', active: true },
        { id: 2, userId: 20, organizationId: 'org-b', active: true },
      ],
      roles: [
        { name: 'ldx_admin', allowConfigure: true },
        { name: 'member', allowConfigure: false },
      ],
      rolesUsers: [
        { userId: 10, roleName: 'ldx_admin' },
        { userId: 20, roleName: 'member' },
        { userId: 999, roleName: 'root' },
      ],
    });

    registerPublicForms(env.app);
    const res = env.definedResources.dxosForms;
    const guardMw = env.middlewares.find((m) => m.opts?.tag === 'latticePublicFormsGuard')?.mw;
    assert.ok(guardMw);

    // Non-root direct CRUD on latticePublicForms or latticePublicFormSubmissions is blocked
    await assert.rejects(
      () => guardMw({ action: { resourceName: 'latticePublicForms', actionName: 'list' }, state: { currentRole: 'admin' } }, async () => 'ok'),
      { code: 'PUBLIC_FORM_DIRECT_ACCESS_FORBIDDEN', status: 403 },
    );
    await assert.rejects(
      () => guardMw({ action: { resourceName: 'latticePublicFormSubmissions', actionName: 'list' }, state: { currentRole: 'ldx_admin' } }, async () => 'ok'),
      { code: 'PUBLIC_FORM_DIRECT_ACCESS_FORBIDDEN', status: 403 },
    );
    await assert.rejects(
      () => guardMw({ action: { resourceName: 'latticePublicForms', actionName: 'list' }, state: { currentRole: 'root' } }, async () => 'ok'),
      { code: 'PUBLIC_FORM_DIRECT_ACCESS_FORBIDDEN', status: 403 },
    );
    assert.equal(
      await guardMw({ action: { resourceName: 'latticePublicForms', actionName: 'list' }, state: { currentUser: { id: 999 }, currentRole: 'root' } }, async () => 'ok'),
      'ok',
    );

    // Non-admin member cannot save form
    const memberCtx = makeCtx({
      method: 'POST',
      user: { id: 20 },
      role: 'member',
      roles: ['member'],
      body: { slug: 'member-form', title: 'Member Form', targetCollection: 'latticeRequests', allowedFieldsJson: [{ name: 'name', type: 'string' }] },
    });
    await assert.rejects(() => res.actions.save(memberCtx), { code: 'FORM_ADMIN_REQUIRED', status: 403 });

    // Read-only PAT cannot save form
    const roPatCtx = makeCtx({
      method: 'POST',
      user: { id: 10 },
      role: 'ldx_admin',
      roles: ['ldx_admin'],
      body: { slug: 'admin-form', title: 'Admin Form', targetCollection: 'latticeRequests', allowedFieldsJson: [{ name: 'name', type: 'string' }] },
    });
    roPatCtx.state.latticeApiKey = { id: 1, scopes: ['read'] };
    await assert.rejects(() => res.actions.save(roPatCtx), { code: 'API_KEY_SCOPE_INSUFFICIENT', status: 403 });

    // Admin in org-a cannot spoof org-b
    const crossOrgCtx = makeCtx({
      method: 'POST',
      user: { id: 10 },
      role: 'ldx_admin',
      roles: ['ldx_admin'],
      body: {
        organizationId: 'org-b',
        slug: 'admin-form',
        title: 'Admin Form',
        targetCollection: 'latticeRequests',
        allowedFieldsJson: [{ name: 'name', type: 'string' }],
      },
    });
    await assert.rejects(() => res.actions.save(crossOrgCtx), { code: 'NATIVE_ORGANIZATION_MISMATCH', status: 403 });

    // Valid admin save + rotateToken
    const saveCtx = makeCtx({
      method: 'POST',
      user: { id: 10 },
      role: 'ldx_admin',
      roles: ['ldx_admin'],
      body: {
        slug: 'partner-intake',
        title: 'Partner Intake',
        targetCollection: 'latticeRequests',
        allowedFieldsJson: [{ name: 'name', type: 'string', required: true }],
      },
    });
    await res.actions.save(saveCtx);
    assert.equal(saveCtx.body.slug, 'partner-intake');
    assert.equal(saveCtx.body.organizationId, 'org-a');
    assert.equal(saveCtx.body.accessTokenHash, undefined);

    const rotateCtx = makeCtx({
      method: 'POST',
      user: { id: 10 },
      role: 'ldx_admin',
      roles: ['ldx_admin'],
      body: { id: saveCtx.body.id },
    });
    await res.actions.rotateToken(rotateCtx);
    assert.match(rotateCtx.body.accessToken, /^ldx_ftok_[a-f0-9]{48}$/);
    assert.equal(rotateCtx.body.requireAccessToken, true);
  });
});

test('public-form-page uses zero external imports, renders dynamic fields, honeypot, and submits with zero-PII receipt & status check', async () => {
  const pageSrc = readFileSync(join(PLUGIN_ROOT, 'src/client-v2/public-form-page.js'), 'utf8');
  const requires = [...pageSrc.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  for (const req of requires) {
    assert.ok(req.startsWith('./') || req.startsWith('../'), `Non-relative require forbidden in client-v2 module: ${req}`);
  }

  const {
    parseFormParams,
    resolveLegacyFormRedirect,
    sanitizeFormMeta,
    projectZeroPiiSubmissionStatus,
    createPublicFormPage,
  } = require('../src/client-v2/public-form-page');

  assert.deepEqual(parseFormParams({ pathname: '/v/form/cold-intake', search: '?token=ftok_123&code=LDX-FRM-AAA11111' }), {
    slug: 'cold-intake',
    token: 'ftok_123',
    submissionCode: 'LDX-FRM-AAA11111',
  });
  assert.deepEqual(parseFormParams({ pathname: '/v/form/..%2Fetc%2Fpasswd', search: '?token=<script>' }), {
    slug: '',
    token: '',
    submissionCode: '',
  });

  assert.equal(
    resolveLegacyFormRedirect({
      __nocobase_app_client_entry_mode__: 'legacy-default',
      location: { pathname: '/form/cold-intake', search: '?token=abc', hash: '' },
    }),
    '/v/form/cold-intake?token=abc',
  );
  assert.equal(
    resolveLegacyFormRedirect({
      __nocobase_app_client_entry_mode__: 'legacy-default',
      location: { pathname: '/mobile/home', search: '', hash: '' },
    }),
    null,
  );

  const sanitizedMeta = sanitizeFormMeta({
    slug: 'cold-intake',
    title: 'Intake',
    organizationId: 'org-secret',
    accessTokenHash: 'deadbeef',
    workflowRuleKey: 'wf-secret',
    fields: [{ name: 'name', label: 'Name', type: 'string', required: true }],
  });
  assert.equal(sanitizedMeta.organizationId, undefined);
  assert.equal(sanitizedMeta.accessTokenHash, undefined);
  assert.equal(sanitizedMeta.workflowRuleKey, undefined);

  const projStatus = projectZeroPiiSubmissionStatus({
    slug: 'cold-intake',
    submissionCode: 'LDX-FRM-11223344',
    status: 'approved',
    submittedAt: '2026-11-25T10:00:00.000Z',
    updatedAt: '2026-11-25T11:00:00.000Z',
    email: 'leak@example.com',
    organizationId: 'org-a',
  });
  assert.deepEqual(projStatus, {
    slug: 'cold-intake',
    submissionCode: 'LDX-FRM-11223344',
    status: 'approved',
    submittedAt: '2026-11-25T10:00:00.000Z',
    updatedAt: '2026-11-25T11:00:00.000Z',
  });

  assert.doesNotThrow(() => createPublicFormPage({ Plugin: class {} }, {}, {}));
  const fakeReact = createFakeReact();
  const requests = [];
  const mockApi = {
    async request(req) {
      requests.push(req);
      if (req.url === 'dxosForms:meta') {
        return {
          data: {
            data: {
              slug: 'cold-intake',
              title: 'Cold Intake',
              description: 'Report incident',
              honeypotField: '_hp_website',
              requireAccessToken: false,
              active: true,
              fields: [
                { name: 'name', label: 'Subject', type: 'string', required: true },
                { name: 'category', label: 'Category', type: 'select', options: ['incident', 'support'], required: true },
              ],
            },
          },
        };
      }
      if (req.url === 'dxosForms:submit') {
        return {
          data: {
            data: {
              ok: true,
              slug: 'cold-intake',
              submissionCode: 'LDX-FRM-ABCDEF12',
              statusToken: 'ldx_frm_tok123',
              status: 'submitted',
              submittedAt: '2026-11-25T12:00:00.000Z',
            },
          },
        };
      }
      if (req.url === 'dxosForms:status') {
        return {
          data: {
            data: {
              slug: 'cold-intake',
              submissionCode: 'LDX-FRM-ABCDEF12',
              status: 'approved',
              submittedAt: '2026-11-25T12:00:00.000Z',
              updatedAt: '2026-11-25T12:05:00.000Z',
            },
          },
        };
      }
      return { data: {} };
    },
  };

  const PublicFormPage = createPublicFormPage({ Plugin: class {} }, fakeReact, { apiClient: mockApi });
  let tree = fakeReact._render(PublicFormPage, { apiClient: mockApi, slug: 'cold-intake' });
  await fakeReact._flushEffects();
  tree = fakeReact._render(PublicFormPage, { apiClient: mockApi, slug: 'cold-intake' });

  assert.ok(findNode(tree, (n) => n.props?.['data-testid'] === 'public-form-page'));
  assert.ok(findNode(tree, (n) => n.props?.['data-testid'] === 'public-form-honeypot'));
  const nameInput = findNode(tree, (n) => n.props?.name === 'name');
  assert.ok(nameInput);
  nameInput.props.onChange({ target: { value: 'Secret Customer PII' } });
  const catSelect = findNode(tree, (n) => n.props?.name === 'category');
  assert.ok(catSelect);
  catSelect.props.onChange({ target: { value: 'incident' } });

  tree = fakeReact._render(PublicFormPage, { apiClient: mockApi, slug: 'cold-intake' });
  const formEl = findNode(tree, (n) => n.type === 'form');
  assert.ok(formEl);
  await formEl.props.onSubmit({ preventDefault() {} });

  tree = fakeReact._render(PublicFormPage, { apiClient: mockApi, slug: 'cold-intake' });
  const receipt = findNode(tree, (n) => n.props?.['data-testid'] === 'public-form-receipt');
  assert.ok(receipt);
  const receiptText = collectText(receipt);
  assert.ok(receiptText.includes('LDX-FRM-ABCDEF12'));
  assert.equal(receiptText.includes('Secret Customer PII'), false);

  const checkStatusBtn = findNode(tree, (n) => n.props?.['data-testid'] === 'public-form-check-status-btn');
  assert.ok(checkStatusBtn);
  await checkStatusBtn.props.onClick();
  tree = fakeReact._render(PublicFormPage, { apiClient: mockApi, slug: 'cold-intake' });
  const statusCard = findNode(tree, (n) => n.props?.['data-testid'] === 'public-form-status-card');
  assert.ok(statusCard);
  assert.ok(collectText(statusCard).includes('approved'));
});

test('public-forms covers rate limiter bounding/window expiry, field validation types, ReDoS rejection, cross-org admin isolation, and sqlite migration', async () => {
  await withMockedNocobase(async () => {
    const pf = require('../src/server/public-forms');
    const MigrationCls = require('../src/server/migrations/20261202000300-public-forms-rls');

    // Rate limiter bounding & window expiry
    const rl = pf.createSlidingWindowRateLimiter({ maxEntries: 2, windowMs: 1000 });
    assert.equal(rl.consume('ip1:f1', 2, 100).allowed, true);
    assert.equal(rl.consume('ip1:f1', 2, 200).allowed, true);
    const blocked = rl.consume('ip1:f1', 2, 300);
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfterSec >= 1);
    assert.equal(rl.consume('ip1:f1', 2, 1200).allowed, true);
    rl.consume('ip2:f1', 2, 1200);
    rl.consume('ip3:f1', 2, 1200);
    assert.ok(rl.size() <= 2);

    // ReDoS nested quantifier rejected
    assert.throws(
      () => pf.validatePublicFormDefinition({
        slug: 'redos-test',
        title: 'ReDoS Test',
        targetCollection: 'latticeRequests',
        allowedFieldsJson: [{ name: 'name', type: 'string', pattern: '(a+)+$' }],
      }),
      { code: 'FORM_FIELD_PATTERN_UNSAFE' },
    );

    // Rich field validation types
    const formDef = pf.validatePublicFormDefinition({
      slug: 'rich-intake',
      title: 'Rich Intake',
      targetCollection: 'latticeRequests',
      allowedFieldsJson: [
        { name: 'contactEmail', type: 'email', required: true },
        { name: 'qty', type: 'integer', min: 1, max: 10, required: true },
        { name: 'urgent', type: 'boolean' },
        { name: 'neededBy', type: 'date' },
      ],
    });
    assert.throws(
      () => pf.sanitizeSubmissionPayload(formDef, { contactEmail: 'not-an-email', qty: 5 }),
      { code: 'FORM_FIELD_EMAIL_INVALID' },
    );
    assert.throws(
      () => pf.sanitizeSubmissionPayload(formDef, { contactEmail: 'ok@example.com', qty: 20 }),
      { code: 'FORM_FIELD_OUT_OF_RANGE' },
    );
    assert.throws(
      () => pf.sanitizeSubmissionPayload(formDef, { contactEmail: 'ok@example.com', qty: 2, neededBy: 'not-a-date' }),
      { code: 'FORM_FIELD_DATE_INVALID' },
    );
    const nestedProto = JSON.parse('{"contactEmail":"ok@example.com","qty":2,"extra":{"constructor":{"prototype":{"x":1}}}}');
    assert.throws(
      () => pf.sanitizeSubmissionPayload(formDef, nestedProto),
      { code: 'FORM_PROTOTYPE_POLLUTION_BLOCKED' },
    );
    const cleaned = pf.sanitizeSubmissionPayload(formDef, {
      contactEmail: 'ops@example.com',
      qty: '3',
      urgent: 'true',
      neededBy: '2026-12-01',
    });
    assert.deepEqual(cleaned, {
      contactEmail: 'ops@example.com',
      qty: 3,
      urgent: true,
      neededBy: '2026-12-01',
    });

    // Cross-org admin isolation & auto-generated code/name on latticeRequests
    const env = createFakeEnv({
      forms: [
        {
          id: 50,
          organizationId: 'org-a',
          slug: 'desc-only',
          title: 'Desc Only Intake',
          targetCollection: 'latticeRequests',
          allowedFieldsJson: [{ name: 'description', type: 'text', required: true }],
          active: true,
        },
      ],
      employees: [
        { id: 1, userId: 10, organizationId: 'org-a', active: true },
        { id: 2, userId: 20, organizationId: 'org-b', active: true },
      ],
      roles: [{ name: 'ldx_admin', allowConfigure: true }],
      rolesUsers: [
        { userId: 10, roleName: 'ldx_admin' },
        { userId: 20, roleName: 'ldx_admin' },
      ],
    });
    pf.registerPublicForms(env.app);
    const res = env.definedResources.dxosForms;

    // Submit with only description auto-generates code, name, status='submitted', version=1
    const subCtx = makeCtx({
      method: 'POST',
      ip: '198.51.100.99',
      body: { slug: 'desc-only', values: { description: 'Need cold-storage repair' } },
    });
    await res.actions.submit(subCtx);
    assert.match(env.store.latticeRequests[0].code, /^FRM-[A-F0-9]{8}$/);
    assert.ok(env.store.latticeRequests[0].name.includes('Desc Only Intake'));
    assert.equal(env.store.latticeRequests[0].status, 'submitted');
    assert.equal(env.store.latticeRequests[0].version, 1);

    // Org-b admin cannot list, get, update, rotateToken, or delete org-a form
    const orgBList = makeCtx({ method: 'GET', user: { id: 20 }, role: 'ldx_admin', roles: ['ldx_admin'] });
    await res.actions.list(orgBList);
    assert.equal(orgBList.body.items.length, 0);

    const orgBGet = makeCtx({ method: 'GET', user: { id: 20 }, role: 'ldx_admin', roles: ['ldx_admin'], params: { id: 50 } });
    await assert.rejects(() => res.actions.get(orgBGet), { code: 'FORM_NOT_FOUND', status: 404 });

    const orgBDel = makeCtx({ method: 'POST', user: { id: 20 }, role: 'ldx_admin', roles: ['ldx_admin'], body: { id: 50 } });
    await assert.rejects(() => res.actions.delete(orgBDel), { code: 'FORM_NOT_FOUND', status: 404 });

    // Non-postgres migration skips RLS cleanly
    const sqliteQueries = [];
    const sqliteMig = new MigrationCls({
      db: {
        sequelize: {
          getDialect: () => 'sqlite',
          transaction: async (cb) => cb({ id: 'tx-sqlite' }),
          query: async (sql) => { sqliteQueries.push(sql); return [[]]; },
        },
      },
    });
    await sqliteMig.up();
    assert.equal(sqliteQueries.some((q) => /ROW LEVEL SECURITY/i.test(q)), false);
  });
});

test('dxosForms:submit publishes public_form.submitted domain event with data payload and submissionCode subject', async () => {
  await withMockedNocobase(async () => {
    const { registerPublicForms } = require('../src/server/public-forms');
    const prevRls = process.env.DX_PG_RLS_SESSION;
    process.env.DX_PG_RLS_SESSION = 'true';

    try {
      const env = createFakeEnv({
        forms: [
          {
            id: 21,
            organizationId: 'org-alpha',
            slug: 'event-intake',
            title: 'Event Intake',
            targetCollection: 'latticeRequests',
            allowedFieldsJson: [{ name: 'name', type: 'string', required: true }],
            workflowRuleKey: 'wf-rule-alpha',
            active: true,
          },
        ],
      });
      registerPublicForms(env.app);
      const res = env.definedResources.dxosForms;

      const ctx = makeCtx({
        method: 'POST',
        ip: '198.51.100.11',
        body: {
          slug: 'event-intake',
          values: { name: 'Check domain event payload' },
        },
      });
      await res.actions.submit(ctx);

      assert.equal(env.store.latticeEventBus.length, 1);
      const evt = env.store.latticeEventBus[0];
      assert.equal(evt.organizationId, 'org-alpha');
      assert.equal(evt.eventType, 'public_form.submitted');
      assert.equal(evt.source, 'dxosForms');
      assert.equal(evt.subject, ctx.body.submissionCode);
      assert.deepEqual(evt.payloadJson.data, {
        slug: 'event-intake',
        submissionCode: ctx.body.submissionCode,
        targetCollection: 'latticeRequests',
        targetRecordId: String(env.store.latticeRequests[0].id),
        workflowRuleKey: 'wf-rule-alpha',
      });
    } finally {
      if (prevRls === undefined) delete process.env.DX_PG_RLS_SESSION;
      else process.env.DX_PG_RLS_SESSION = prevRls;
    }
  });
});

test('dxosForms:save checks global slug conflicts across tenant RLS without leaking owning organizationId', async () => {
  await withMockedNocobase(async () => {
    const { registerPublicForms } = require('../src/server/public-forms');
    const prevRls = process.env.DX_PG_RLS_SESSION;
    process.env.DX_PG_RLS_SESSION = 'true';

    try {
      const formsTable = [
        {
          id: 11,
          organizationId: 'org-a',
          slug: 'taken-global-slug',
          title: 'Org A Form',
          targetCollection: 'latticeRequests',
          allowedFieldsJson: [{ name: 'name', type: 'string', required: true }],
          active: true,
        },
        {
          id: 12,
          organizationId: 'org-b',
          slug: 'org-b-existing',
          title: 'Org B Form',
          targetCollection: 'latticeRequests',
          allowedFieldsJson: [{ name: 'name', type: 'string', required: true }],
          active: true,
        },
      ];
      const employees = [
        { id: 1, userId: 10, organizationId: 'org-a', active: true },
        { id: 2, userId: 20, organizationId: 'org-b', active: true },
      ];
      const roles = [{ name: 'ldx_admin', allowConfigure: true }];
      const rolesUsers = [
        { userId: 10, roleName: 'ldx_admin' },
        { userId: 20, roleName: 'ldx_admin' },
      ];

      const txContext = new Map();
      let txCounter = 0;

      const wrapRow = (row) => ({
        ...row,
        get: (k) => row[k],
        toJSON: () => ({ ...row }),
        update: async (patch) => {
          if (patch.slug && formsTable.some((r) => r.id !== row.id && r.slug === patch.slug)) {
            throw Object.assign(new Error('duplicate key value violates unique constraint "uidx_lattice_public_forms_slug"'), { code: '23505' });
          }
          Object.assign(row, patch, { updatedAt: new Date().toISOString() });
          return wrapRow(row);
        },
      });

      const canSeeFormRow = (row, opts) => {
        const ctxState = opts?.transaction ? txContext.get(opts.transaction.id) : null;
        if (!ctxState || ctxState.bypass) return true;
        return row.organizationId === ctxState.orgId;
      };

      const rlsDb = {
        sequelize: {
          getDialect: () => 'postgres',
          transaction: async (cb) => {
            const tx = { id: `tx-rls-${++txCounter}` };
            txContext.set(tx.id, { orgId: null, bypass: false });
            try {
              return await cb(tx);
            } finally {
              txContext.delete(tx.id);
            }
          },
          query: async (sql, opts) => {
            const state = opts?.transaction ? txContext.get(opts.transaction.id) : null;
            if (state && sql.includes("set_config('app.rls_bypass', 'on'")) {
              state.bypass = true;
            }
            if (state && sql.includes("set_config('app.current_org'") && opts?.replacements?.orgId) {
              state.orgId = opts.replacements.orgId;
            }
            return [[]];
          },
        },
        getRepository(name) {
          if (name === 'latticePublicForms') {
            return {
              async findOne(opts = {}) {
                const f = opts.filter || {};
                const hit = formsTable.find((r) => {
                  if (!canSeeFormRow(r, opts)) return false;
                  if (f.id !== undefined && r.id !== f.id) return false;
                  if (f.organizationId !== undefined && r.organizationId !== f.organizationId) return false;
                  if (f.slug !== undefined && r.slug !== f.slug) return false;
                  return true;
                });
                return hit ? wrapRow(hit) : null;
              },
              async create(opts = {}) {
                const vals = opts.values || {};
                if (formsTable.some((r) => r.slug === vals.slug)) {
                  throw Object.assign(new Error('duplicate key value violates unique constraint "uidx_lattice_public_forms_slug"'), { code: '23505' });
                }
                const rec = { id: formsTable.length + 100, ...vals };
                formsTable.push(rec);
                return wrapRow(rec);
              },
            };
          }
          if (name === 'latticeEmployees') {
            return {
              async find(opts = {}) {
                const uid = opts.filter?.userId;
                return employees.filter((e) => e.userId === uid).map((e) => ({ ...e, get: (k) => e[k] }));
              },
              async findOne(opts = {}) {
                const uid = opts.filter?.userId;
                const hit = employees.find((e) => e.userId === uid);
                return hit ? { ...hit, get: (k) => hit[k] } : null;
              },
            };
          }
          if (name === 'roles') {
            return {
              async find(opts = {}) {
                const inList = opts.filter?.name?.$in || [];
                return roles.filter((r) => inList.includes(r.name)).map((r) => ({ ...r, get: (k) => r[k] }));
              },
            };
          }
          if (name === 'rolesUsers') {
            return {
              async find(opts = {}) {
                const uid = opts.filter?.userId;
                return rolesUsers.filter((ru) => ru.userId === uid).map((ru) => ({ ...ru, get: (k) => ru[k] }));
              },
            };
          }
          return null;
        },
      };

      const app = {
        db: rlsDb,
        resourceManager: {
          defined: {},
          define(def) { this.defined[def.name] = def; },
          use() {},
        },
        acl: { allow() {} },
      };

      registerPublicForms(app);
      const actions = app.resourceManager.defined.dxosForms.actions;

      // Org-b creating a form with org-a's slug returns 409 FORM_SLUG_CONFLICT without leaking org-a
      const createConflictCtx = makeCtx({
        method: 'POST',
        user: { id: 20 },
        role: 'ldx_admin',
        roles: ['ldx_admin'],
        body: {
          slug: 'taken-global-slug',
          title: 'Org B Steal Slug',
          targetCollection: 'latticeRequests',
          allowedFieldsJson: [{ name: 'name', type: 'string', required: true }],
        },
      });
      await assert.rejects(
        () => actions.save(createConflictCtx),
        (err) => {
          assert.equal(err.code, 'FORM_SLUG_CONFLICT');
          assert.equal(err.status, 409);
          assert.equal(String(err.message).includes('org-a'), false);
          return true;
        },
      );

      // Org-b updating its own form (id: 12) to org-a's slug returns 409 FORM_SLUG_CONFLICT without leaking org-a
      const updateConflictCtx = makeCtx({
        method: 'POST',
        user: { id: 20 },
        role: 'ldx_admin',
        roles: ['ldx_admin'],
        body: {
          id: 12,
          slug: 'taken-global-slug',
          title: 'Org B Rename Conflict',
          targetCollection: 'latticeRequests',
          allowedFieldsJson: [{ name: 'name', type: 'string', required: true }],
        },
      });
      await assert.rejects(
        () => actions.save(updateConflictCtx),
        (err) => {
          assert.equal(err.code, 'FORM_SLUG_CONFLICT');
          assert.equal(err.status, 409);
          assert.equal(String(err.message).includes('org-a'), false);
          return true;
        },
      );

      // Org-b attempting to edit org-a's form id (11) returns 404 FORM_NOT_FOUND
      const crossEditCtx = makeCtx({
        method: 'POST',
        user: { id: 20 },
        role: 'ldx_admin',
        roles: ['ldx_admin'],
        body: {
          id: 11,
          slug: 'taken-global-slug',
          title: 'Cross Tenant Edit',
          targetCollection: 'latticeRequests',
          allowedFieldsJson: [{ name: 'name', type: 'string', required: true }],
        },
      });
      await assert.rejects(() => actions.save(crossEditCtx), { code: 'FORM_NOT_FOUND', status: 404 });

      // Org-a updating its own form (id: 11) with same slug succeeds
      const ownUpdateCtx = makeCtx({
        method: 'POST',
        user: { id: 10 },
        role: 'ldx_admin',
        roles: ['ldx_admin'],
        body: {
          id: 11,
          slug: 'taken-global-slug',
          title: 'Org A Updated Title',
          targetCollection: 'latticeRequests',
          allowedFieldsJson: [{ name: 'name', type: 'string', required: true }],
        },
      });
      await actions.save(ownUpdateCtx);
      assert.equal(ownUpdateCtx.body.title, 'Org A Updated Title');
    } finally {
      if (prevRls === undefined) delete process.env.DX_PG_RLS_SESSION;
      else process.env.DX_PG_RLS_SESSION = prevRls;
    }
  });
});

test('dxosForms rate limiter ignores spoofed X-Forwarded-For when ctx.ip is present unless trustProxy is enabled', async () => {
  await withMockedNocobase(async () => {
    const { registerPublicForms } = require('../src/server/public-forms');
    const prevTrust = process.env.DX_TRUST_PROXY;
    delete process.env.DX_TRUST_PROXY;

    try {
      const env = createFakeEnv({
        forms: [
          {
            id: 31,
            organizationId: 'org-alpha',
            slug: 'rl-xff-test',
            title: 'Rate Limit XFF Test',
            targetCollection: 'latticeRequests',
            allowedFieldsJson: [{ name: 'name', type: 'string', required: true }],
            rateLimitPerMinute: 2,
            active: true,
          },
        ],
      });
      registerPublicForms(env.app);
      const res = env.definedResources.dxosForms;

      for (const xff of ['198.51.100.1', '198.51.100.2']) {
        const ctx = makeCtx({
          method: 'POST',
          ip: '203.0.113.99',
          headers: { 'x-forwarded-for': xff },
          body: { slug: 'rl-xff-test', values: { name: `Valid ${xff}` } },
        });
        await res.actions.submit(ctx);
      }

      // Rotating X-Forwarded-For from same ctx.ip MUST still hit 429 on submit
      const spoofedXffCtx = makeCtx({
        method: 'POST',
        ip: '203.0.113.99',
        headers: { 'x-forwarded-for': '198.51.100.250' },
        body: { slug: 'rl-xff-test', values: { name: 'Bypass Attempt' } },
      });
      await assert.rejects(() => res.actions.submit(spoofedXffCtx), { code: 'RATE_LIMIT_EXCEEDED', status: 429 });

      // Rotating X-Forwarded-For from same ctx.ip MUST still hit 429 on status
      for (let i = 0; i < 60; i++) {
        await assert.rejects(
          () => res.actions.status(makeCtx({
            method: 'GET',
            ip: '203.0.113.88',
            headers: { 'x-forwarded-for': `198.51.100.${(i % 200) + 1}` },
            params: { slug: 'rl-xff-test', submissionCode: 'LDX-FRM-00000001', token: 'wrong-token' },
          })),
          { code: 'FORM_STATUS_UNAUTHORIZED', status: 401 },
        );
      }
      await assert.rejects(
        () => res.actions.status(makeCtx({
          method: 'GET',
          ip: '203.0.113.88',
          headers: { 'x-forwarded-for': '198.51.100.249' },
          params: { slug: 'rl-xff-test', submissionCode: 'LDX-FRM-00000001', token: 'wrong-token' },
        })),
        { code: 'RATE_LIMIT_EXCEEDED', status: 429 },
      );

      // When trustProxy is explicitly enabled, distinct X-Forwarded-For headers behind proxy get separate buckets
      const trustedEnv = createFakeEnv({
        forms: [
          {
            id: 32,
            organizationId: 'org-alpha',
            slug: 'rl-trusted-proxy',
            title: 'Trusted Proxy Test',
            targetCollection: 'latticeRequests',
            allowedFieldsJson: [{ name: 'name', type: 'string', required: true }],
            rateLimitPerMinute: 1,
            active: true,
          },
        ],
      });
      registerPublicForms(trustedEnv.app, { trustProxy: true });
      const trustedRes = trustedEnv.definedResources.dxosForms;

      await trustedRes.actions.submit(makeCtx({
        method: 'POST',
        ip: '10.0.0.5',
        headers: { 'x-forwarded-for': '198.51.100.10' },
        body: { slug: 'rl-trusted-proxy', values: { name: 'Client A' } },
      }));
      await trustedRes.actions.submit(makeCtx({
        method: 'POST',
        ip: '10.0.0.5',
        headers: { 'x-forwarded-for': '198.51.100.11' },
        body: { slug: 'rl-trusted-proxy', values: { name: 'Client B' } },
      }));
      await assert.rejects(
        () => trustedRes.actions.submit(makeCtx({
          method: 'POST',
          ip: '10.0.0.5',
          headers: { 'x-forwarded-for': '198.51.100.10' },
          body: { slug: 'rl-trusted-proxy', values: { name: 'Client A Repeat' } },
        })),
        { code: 'RATE_LIMIT_EXCEEDED', status: 429 },
      );
    } finally {
      if (prevTrust === undefined) delete process.env.DX_TRUST_PROXY;
      else process.env.DX_TRUST_PROXY = prevTrust;
    }
  });
});

test('latticePublicFormsGuard verifies ctx.state.currentRole = root against rolesUsers and blocks forged root', async () => {
  await withMockedNocobase(async () => {
    const { registerPublicForms } = require('../src/server/public-forms');
    const env = createFakeEnv({
      rolesUsers: [
        { userId: 101, roleName: 'ldx_employee' },
        { userId: 999, roleName: 'root' },
      ],
    });
    registerPublicForms(env.app);
    const guardMw = env.middlewares.find((m) => m.opts?.tag === 'latticePublicFormsGuard')?.mw;
    assert.ok(guardMw);

    await assert.rejects(
      () => guardMw({
        action: { resourceName: 'latticePublicForms', actionName: 'list' },
        state: { currentUser: { id: 101 }, currentRole: 'root', currentRoles: ['root'] },
      }, async () => 'ok'),
      { code: 'PUBLIC_FORM_DIRECT_ACCESS_FORBIDDEN', status: 403 },
    );

    await assert.rejects(
      () => guardMw({
        action: { resourceName: 'latticePublicFormSubmissions', actionName: 'create' },
        state: { currentUser: { id: 101 }, currentRole: 'root', currentRoles: ['root'] },
      }, async () => 'ok'),
      { code: 'PUBLIC_FORM_DIRECT_ACCESS_FORBIDDEN', status: 403 },
    );

    await assert.rejects(
      () => guardMw({
        action: {
          resourceName: 'charts',
          actionName: 'queryData',
          params: { values: { collection: 'latticePublicForms' } },
        },
        state: { currentUser: { id: 101 }, currentRole: 'root', currentRoles: ['root'] },
      }, async () => 'ok'),
      { code: 'PUBLIC_FORM_DIRECT_ACCESS_FORBIDDEN', status: 403 },
    );

    assert.equal(
      await guardMw({
        action: { resourceName: 'latticePublicForms', actionName: 'list' },
        state: { currentUser: { id: 999 }, currentRole: 'root', currentRoles: ['root'] },
      }, async () => 'ok'),
      'ok',
    );
  });
});

test('public-form-page disambiguates statusToken from accessToken on ?code=...&token=... status URLs', async () => {
  const { createPublicFormPage } = require('../src/client-v2/public-form-page');
  const fakeReact = createFakeReact();
  const calls = [];
  const mockApi = {
    async request(req) {
      calls.push(req);
      if (req.url === 'dxosForms:meta') {
        return {
          data: {
            data: {
              slug: 'cold-intake',
              title: 'Cold Intake',
              honeypotField: '_hp_website',
              requireAccessToken: true,
              active: true,
              fields: [{ name: 'name', label: 'Subject', type: 'string', required: true }],
            },
          },
        };
      }
      if (req.url === 'dxosForms:status') {
        return {
          data: {
            data: {
              slug: 'cold-intake',
              submissionCode: 'LDX-FRM-ABCDEF12',
              status: 'approved',
              submittedAt: '2026-11-25T12:00:00.000Z',
              updatedAt: '2026-11-25T12:05:00.000Z',
            },
          },
        };
      }
      return { data: {} };
    },
  };

  const statusLoc = {
    pathname: '/v/form/cold-intake',
    search: '?code=LDX-FRM-ABCDEF12&token=ldx_frm_status_secret',
  };
  const PublicFormPage = createPublicFormPage({ Plugin: class {} }, fakeReact, { apiClient: mockApi });
  fakeReact._render(PublicFormPage, { apiClient: mockApi, location: statusLoc });
  await fakeReact._flushEffects();
  const tree = fakeReact._render(PublicFormPage, { apiClient: mockApi, location: statusLoc });

  const statusCall = calls.find((c) => c.url === 'dxosForms:status');
  assert.ok(statusCall);
  assert.deepEqual(statusCall.params, {
    slug: 'cold-intake',
    submissionCode: 'LDX-FRM-ABCDEF12',
    token: 'ldx_frm_status_secret',
  });
  const tokenInput = findNode(tree, (n) => n.props?.['data-testid'] === 'public-form-token-input');
  assert.ok(tokenInput);
  assert.equal(tokenInput.props.value, '');

  // Explicit accessToken + statusToken keeps accessToken field filled while querying with statusToken
  const dualReact = createFakeReact();
  const dualCalls = [];
  const dualApi = {
    async request(req) {
      dualCalls.push(req);
      return mockApi.request(req);
    },
  };
  const dualLoc = {
    pathname: '/v/form/cold-intake',
    search: '?accessToken=ftok_access_99&code=LDX-FRM-ABCDEF12&statusToken=ldx_frm_status_secret',
  };
  const DualPage = createPublicFormPage({ Plugin: class {} }, dualReact, { apiClient: dualApi });
  dualReact._render(DualPage, { apiClient: dualApi, location: dualLoc });
  await dualReact._flushEffects();
  const dualTree = dualReact._render(DualPage, { apiClient: dualApi, location: dualLoc });

  const dualStatusCall = dualCalls.find((c) => c.url === 'dxosForms:status');
  assert.ok(dualStatusCall);
  assert.equal(dualStatusCall.params.token, 'ldx_frm_status_secret');
  const dualTokenInput = findNode(dualTree, (n) => n.props?.['data-testid'] === 'public-form-token-input');
  assert.ok(dualTokenInput);
  assert.equal(dualTokenInput.props.value, 'ftok_access_99');

  // ?token=... without code still pre-fills accessToken
  const accessOnlyReact = createFakeReact();
  const accessOnlyLoc = {
    pathname: '/v/form/cold-intake',
    search: '?token=ftok_invite_only',
  };
  const AccessOnlyPage = createPublicFormPage({ Plugin: class {} }, accessOnlyReact, { apiClient: mockApi });
  accessOnlyReact._render(AccessOnlyPage, { apiClient: mockApi, location: accessOnlyLoc });
  await accessOnlyReact._flushEffects();
  const accessOnlyTree = accessOnlyReact._render(AccessOnlyPage, { apiClient: mockApi, location: accessOnlyLoc });
  const accessOnlyInput = findNode(accessOnlyTree, (n) => n.props?.['data-testid'] === 'public-form-token-input');
  assert.ok(accessOnlyInput);
  assert.equal(accessOnlyInput.props.value, 'ftok_invite_only');
});

test('dist/client-v2/index.js & dist/client/index.js mount /form/:slug, /form, and legacy /form redirect without extra externals or non-legacy route pollution', async () => {
  const vm = require('node:vm');
  const distV2Path = join(PLUGIN_ROOT, 'dist/client-v2/index.js');
  const distV2Src = readFileSync(distV2Path, 'utf8');
  assert.doesNotMatch(distV2Src, /['"]@nocobase\/client['"]/);

  let modV2;
  const defineV2 = (name, deps, factory) => {
    assert.equal(name, '@latticedx/plugin-lattice-foundation/client-v2');
    assert.deepEqual(Array.from(deps), ['@nocobase/client-v2', 'react']);
    modV2 = factory({ Plugin: class {} }, {});
  };
  defineV2.amd = {};
  vm.runInNewContext(distV2Src, {
    define: defineV2,
    sessionStorage: { getItem: () => null },
    window: { location: { pathname: '/v/form/cold-intake' } },
  });

  assert.equal(typeof modV2.createPublicFormPage, 'function');
  assert.equal(typeof modV2.resolveLegacyFormRedirect, 'function');
  const pluginV2 = new modV2.default();
  const routesV2 = [];
  pluginV2.app = { router: { add: (name, route) => routesV2.push({ name, ...route }) } };
  await pluginV2.load();

  assert.ok(routesV2.some((r) => r.name === 'dxos-public-form' && r.path === '/form/:slug' && r.skipAuthCheck === true && typeof r.Component === 'function'));
  assert.ok(routesV2.some((r) => r.name === 'dxos-public-form-root' && r.path === '/form' && r.skipAuthCheck === true && typeof r.Component === 'function'));

  const distLegacyPath = join(PLUGIN_ROOT, 'dist/client/index.js');
  const distLegacySrc = readFileSync(distLegacyPath, 'utf8');
  let modLegacy;
  const defineLegacy = (name, deps, factory) => {
    assert.equal(name, '@latticedx/plugin-lattice-foundation');
    modLegacy = factory(
      { Plugin: class {} },
      {},
      {},
      { BlockModel: class { static define() {} static registerFlow() {} } },
    );
  };
  defineLegacy.amd = {};

  const replaced = [];
  vm.runInNewContext(distLegacySrc, {
    define: defineLegacy,
    sessionStorage: { getItem: () => null },
    window: {
      __nocobase_app_client_entry_mode__: 'legacy-default',
      location: {
        pathname: '/form/cold-intake',
        search: '?token=ftok_1',
        hash: '#sec',
        replace: (url) => replaced.push(url),
      },
    },
  });
  const legacyPluginRedirect = new modLegacy.default();
  legacyPluginRedirect.app = { router: { add: () => {} } };
  await legacyPluginRedirect.load();
  assert.deepEqual(replaced, ['/v/form/cold-intake?token=ftok_1#sec']);

  // In legacy-default mode on /lattice, lattice-form-v2 routes are mounted
  vm.runInNewContext(distLegacySrc, {
    define: defineLegacy,
    sessionStorage: { getItem: () => null },
    window: {
      __nocobase_app_client_entry_mode__: 'legacy-default',
      location: { pathname: '/lattice', hostname: 'localhost' },
    },
  });
  const legacyPluginRoutes = new modLegacy.default();
  legacyPluginRoutes.flowEngine = { registerModels: () => {} };
  const legacyRoutes = [];
  legacyPluginRoutes.app = {
    addScopes: () => {},
    router: { add: (name, route) => legacyRoutes.push({ name, ...route }) },
    addComponents: () => {},
    use: () => {},
    schemaInitializerManager: { get: () => ({ add: () => {} }) },
  };
  await legacyPluginRoutes.load();
  assert.ok(legacyRoutes.some((r) => r.name === 'lattice-form-v2' && r.path === '/form/:slug'));
  assert.ok(legacyRoutes.some((r) => r.name === 'lattice-form-v2-root' && r.path === '/form'));
});

test('dxosForms rejects __proto__, constructor, prototype, all, and ALL as organizationId with HTTP 400', async () => {
  await withMockedNocobase(async () => {
    const { registerPublicForms } = require('../src/server/public-forms');
    const env = createFakeEnv({
      roles: [{ name: 'root', allowAll: true }],
      rolesUsers: [{ userId: 999, roleName: 'root' }],
    });
    registerPublicForms(env.app);
    const res = env.definedResources.dxosForms;

    for (const badOrg of ['__proto__', 'constructor', 'prototype', 'all', 'ALL']) {
      const saveCtx = makeCtx({
        method: 'POST',
        user: { id: 999 },
        role: 'root',
        roles: ['root'],
        body: {
          organizationId: badOrg,
          slug: 'valid-slug',
          title: 'Test Form',
          targetCollection: 'latticeRequests',
          allowedFieldsJson: [{ name: 'name', type: 'string' }],
        },
      });
      await assert.rejects(
        () => res.actions.save(saveCtx),
        (err) => err && err.status === 400,
        `Expected HTTP 400 for organizationId=${badOrg}`,
      );
    }
  });
});

test('public-form-html serves standalone nonce-CSP HTML shell for /v/form/:slug without 401/404 or XSS', async () => {
  await withMockedNocobase(async () => {
    const {
      matchPublicFormPath,
      renderPublicFormHtml,
      createPublicFormGatewayHandler,
    } = require('../src/server/public-form-html');

    // 1. matchPublicFormPath
    assert.deepEqual(matchPublicFormPath('/v/form'), { matched: true, rawSlug: '' });
    assert.deepEqual(matchPublicFormPath('/v/form/'), { matched: true, rawSlug: '' });
    assert.deepEqual(matchPublicFormPath('/v/form/cold-intake'), { matched: true, rawSlug: 'cold-intake' });
    assert.deepEqual(matchPublicFormPath('/v/form/cold-intake/'), { matched: true, rawSlug: 'cold-intake' });
    assert.deepEqual(matchPublicFormPath('/v/form/%E0%A4%A'), { matched: true, rawSlug: '' });
    assert.deepEqual(matchPublicFormPath('/v/signin'), { matched: false, rawSlug: '' });
    assert.deepEqual(matchPublicFormPath('/v/assets/index.js'), { matched: false, rawSlug: '' });
    assert.deepEqual(matchPublicFormPath('/api/dxosForms:meta'), { matched: false, rawSlug: '' });
    assert.deepEqual(matchPublicFormPath('/v/form/a/b'), { matched: false, rawSlug: '' });

    // 2. renderPublicFormHtml security invariants (nonce, inline SVG favicon, zero on*, zero innerHTML, XSS escaping)
    const xssTitle = 'Cold </script><script>alert(1)</script> & Intake';
    const htmlOk = renderPublicFormHtml({
      slug: 'cold-intake',
      formMeta: {
        slug: 'cold-intake',
        title: xssTitle,
        description: 'Desc </script>',
        fields: [{ name: 'name', label: 'Subject', type: 'string', required: true }],
        honeypotField: '_hp_website',
        requireAccessToken: true,
        active: true,
      },
      nonce: 'test-nonce-123',
      apiBasePath: '/api',
    });
    assert.match(htmlOk, /<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml,/);
    assert.equal(htmlOk.includes('favicon_no_exist.ico'), false);
    assert.match(htmlOk, /<style nonce="test-nonce-123">/);
    assert.match(htmlOk, /<script type="application\/json" id="dxos-form-bootstrap" nonce="test-nonce-123">/);
    assert.match(htmlOk, /<script nonce="test-nonce-123">/);
    assert.equal(/\son[a-z]+\s*=/i.test(htmlOk), false, 'Must have zero inline on* event attributes');
    assert.equal(htmlOk.includes('innerHTML'), false, 'Must never use innerHTML');
    assert.equal(htmlOk.includes('<script>alert(1)</script>'), false, 'Raw </script> must be escaped');
    assert.match(htmlOk, /\\u003c\/script\\u003e/);
    assert.match(htmlOk, /public-form-receipt/);
    assert.match(htmlOk, /public-form-status-card/);
    assert.match(htmlOk, /public-form-check-status-btn/);

    const htmlErr = renderPublicFormHtml({
      slug: 'nonexistent-test',
      formMeta: null,
      errorMessage: 'Public form not found or inactive.',
      nonce: 'err-nonce-456',
    });
    assert.match(htmlErr, /"ok":false/);
    assert.match(htmlErr, /Public form not found or inactive\./);
    // Client script must skip dxosForms:meta fetch when bootstrap.ok is false
    assert.match(htmlErr, /if\s*\(\s*!bootstrap\.ok\b/);
    assert.equal(htmlErr.includes('dxosForms:meta'), false);

    // 3. createPublicFormGatewayHandler intercepts GET/HEAD /v/form/:slug cleanly
    const env = createFakeEnv({
      forms: [{
        id: 7,
        organizationId: 'org-secret-tenant',
        slug: 'partner-intake',
        title: 'Partner Intake',
        description: 'Zero-PII intake',
        targetCollection: 'latticeRequests',
        allowedFieldsJson: [{ name: 'name', label: 'Subject', type: 'string', required: true }],
        requireAccessToken: true,
        accessTokenHash: sha256('secret-token-value'),
        workflowRuleKey: 'secret-workflow-rule',
        active: true,
      }],
    });

    const prevRls = process.env.DX_PG_RLS_SESSION;
    process.env.DX_PG_RLS_SESSION = 'true';
    try {
      const handler = createPublicFormGatewayHandler({ getDb: () => env.db });

      const makeRes = () => {
        const headers = {};
        let statusCode = null;
        let body = '';
        return {
          writeHead(code, hdrs) {
            statusCode = code;
            for (const [k, v] of Object.entries(hdrs || {})) headers[k.toLowerCase()] = v;
          },
          setHeader(k, v) { headers[k.toLowerCase()] = v; },
          end(chunk = '') { body += String(chunk || ''); },
          _out: () => ({ statusCode, headers, body }),
        };
      };

      // Non-matching paths/methods return false
      assert.equal(await handler({ method: 'POST', url: '/v/form/partner-intake' }, makeRes()), false);
      assert.equal(await handler({ method: 'GET', url: '/v/signin' }, makeRes()), false);
      assert.equal(await handler({ method: 'GET', url: '/v/assets/index.js' }, makeRes()), false);
      assert.equal(await handler({ method: 'GET', url: '/api/dxosForms:meta?slug=partner-intake' }, makeRes()), false);

      // Valid active slug returns 200 HTML with strict CSP + zero leaked secrets
      const resValid = makeRes();
      const handledValid = await handler({ method: 'GET', url: '/v/form/partner-intake?code=LDX-FRM-1' }, resValid);
      assert.equal(handledValid, true);
      const outValid = resValid._out();
      assert.equal(outValid.statusCode, 200);
      assert.equal(outValid.headers['content-type'], 'text/html; charset=utf-8');
      assert.equal(outValid.headers['cache-control'], 'no-store');
      assert.equal(outValid.headers['x-content-type-options'], 'nosniff');
      assert.equal(outValid.headers['x-frame-options'], 'SAMEORIGIN');
      assert.equal(outValid.headers['referrer-policy'], 'no-referrer');
      assert.match(outValid.headers['content-security-policy'], /^default-src 'none'; script-src 'nonce-[A-Za-z0-9_-]+'; style-src 'nonce-[A-Za-z0-9_-]+'; img-src data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'self'$/);
      assert.equal(outValid.body.includes('org-secret-tenant'), false);
      assert.equal(outValid.body.includes('secret-workflow-rule'), false);
      assert.equal(outValid.body.includes(sha256('secret-token-value')), false);
      assert.match(outValid.body, /"ok":true/);
      assert.ok(env.rlsEvents.some((e) => e.sql.includes("set_config('app.rls_bypass', 'on'")));

      // HEAD returns empty body
      const resHead = makeRes();
      assert.equal(await handler({ method: 'HEAD', url: '/v/form/partner-intake' }, resHead), true);
      assert.equal(resHead._out().statusCode, 200);
      assert.equal(resHead._out().body, '');

      // Unknown / invalid / malformed slug returns 200 HTML with ok: false without DB error
      for (const testUrl of ['/v/form/nonexistent-test', '/v/form/admin', '/v/form/%E0%A4%A', '/v/form']) {
        const resMissing = makeRes();
        assert.equal(await handler({ method: 'GET', url: testUrl }, resMissing), true);
        const outMissing = resMissing._out();
        assert.equal(outMissing.statusCode, 200);
        assert.match(outMissing.body, /"ok":false/);
        assert.match(outMissing.body, /Biểu mẫu công khai không tồn tại hoặc đã ngừng tiếp nhận\./);
      }
    } finally {
      if (prevRls === undefined) delete process.env.DX_PG_RLS_SESSION;
      else process.env.DX_PG_RLS_SESSION = prevRls;
    }
  });
});

test('dxosForms:submit & immediate dxosForms:status both report submitted for latticeServiceTickets, latticeOrders, and latticeIncidentCases', async () => {
  await withMockedNocobase(async () => {
    const { registerPublicForms } = require('../src/server/public-forms');
    const env = createFakeEnv({
      forms: [
        {
          id: 71,
          organizationId: 'org-alpha',
          slug: 'it-ticket-intake',
          title: 'IT Support Intake',
          targetCollection: 'latticeServiceTickets',
          allowedFieldsJson: [
            { name: 'name', type: 'string', required: true },
            { name: 'priority', type: 'select', options: ['low', 'normal', 'high', 'urgent'], required: true },
          ],
          defaultValuesJson: { serviceType: 'it_support' },
          active: true,
        },
        {
          id: 72,
          organizationId: 'org-alpha',
          slug: 'order-intake',
          title: 'Order Intake',
          targetCollection: 'latticeOrders',
          allowedFieldsJson: [{ name: 'name', type: 'string', required: true }],
          active: true,
        },
        {
          id: 73,
          organizationId: 'org-alpha',
          slug: 'incident-intake',
          title: 'Incident Intake',
          targetCollection: 'latticeIncidentCases',
          allowedFieldsJson: [{ name: 'name', type: 'string', required: true }],
          defaultValuesJson: { runId: 'pub-1', assetEntityId: 'urn:ngsi-ld:Asset:org-alpha:native:1', handlerId: 'emp-1' },
          active: true,
        },
      ],
    });
    registerPublicForms(env.app);
    const res = env.definedResources.dxosForms;

    for (const [slug, col] of [
      ['it-ticket-intake', 'latticeServiceTickets'],
      ['order-intake', 'latticeOrders'],
      ['incident-intake', 'latticeIncidentCases'],
    ]) {
      const subCtx = makeCtx({
        method: 'POST',
        ip: '198.51.100.77',
        body: { slug, values: { name: `Test ${slug}`, ...(slug === 'it-ticket-intake' ? { priority: 'high' } : {}) } },
      });
      await res.actions.submit(subCtx);
      assert.equal(subCtx.body.status, 'submitted');
      assert.equal(env.store[col][0].status, 'submitted');
      if (col === 'latticeServiceTickets' || col === 'latticeOrders') {
        assert.equal(env.store[col][0].version, 1);
        assert.equal(env.store[col][0].amendmentNo, 0);
      }

      const stCtx = makeCtx({
        method: 'GET',
        ip: '198.51.100.77',
        params: { slug, submissionCode: subCtx.body.submissionCode, token: subCtx.body.statusToken },
      });
      await res.actions.status(stCtx);
      assert.equal(stCtx.body.status, 'submitted');
    }
  });
});

test('public-form-html includes Vietnamese priority labels, 1-click copy token button, vi-VN timestamps, and localized receipt/error text', async () => {
  await withMockedNocobase(async () => {
    const { renderPublicFormHtml } = require('../src/server/public-form-html');
    const html = renderPublicFormHtml({
      slug: 'service-intake',
      formMeta: {
        slug: 'service-intake',
        title: 'Phiếu tiếp nhận',
        fields: [{ name: 'priority', label: 'Mức ưu tiên', type: 'select', options: ['low', 'normal', 'high', 'urgent'], required: true }],
        honeypotField: '_hp_website',
        requireAccessToken: false,
        active: true,
      },
      nonce: 'nonce-polish-1',
    });

    assert.match(html, /Thấp/);
    assert.match(html, /Bình thường/);
    assert.match(html, /Khẩn cấp/);
    assert.match(html, /public-form-copy-token-btn/);
    assert.match(html, /Sao chép mã tra cứu/);
    assert.match(html, /Đã sao chép/);
    assert.match(html, /toLocaleString\('vi-VN'\)/);
    assert.match(html, /Biên nhận bảo mật \(Không lộ PII\)/);
    assert.equal(html.includes('Zero-PII Receipt'), false);

    const errHtml = renderPublicFormHtml({ slug: 'missing', formMeta: null, nonce: 'nonce-err-1' });
    assert.match(errHtml, /Biểu mẫu công khai không tồn tại hoặc đã ngừng tiếp nhận\./);
  });
});
