/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ORG_ID_RE = /^[a-zA-Z0-9_-]{1,80}$/;
const CUSTOM_RLS_TABLE_RE = /^latticeCustom[A-Za-z0-9_]*$/;
const RLS_POLICY_NAME = 'lattice_tenant_isolation';
const RLS_BRIDGE_MARKER = Symbol.for('latticedx.pgRlsBridgeInstalled');
const REPO_SINGLE_ARG_METHODS = Object.freeze([
  'find',
  'findOne',
  'findAndCount',
  'count',
  'create',
  'update',
  'destroy',
]);

const rlsStore = new AsyncLocalStorage();

const TENANT_RLS_TABLES = Object.freeze([
  'latticeRequests',
  'latticeOrders',
  'latticeAssets',
  'latticeEmployees',
  'latticeDepartments',
  'latticeLocations',
  'latticeIncidentCases',
  'latticeIncidentRules',
  'latticeAgentProposals',
  'latticeContextOutbox',
  'latticeIntegrationInbox',
  'latticeRecordChatter',
  'latticeNotifications',
  'latticeSlaPolicies',
  'latticeParaDocuments',
  'latticeParaChunks',
  'latticeServiceTickets',
  'latticeAiProfiles',
  'latticeAiAuditLogs',
  'latticeAiQuotaUsage',
  'latticeAiApprovalQueue',
  'latticeTelemetryPoints',
]);

const TENANT_RLS_TABLE_SET = new Set(TENANT_RLS_TABLES);

function rlsError(code, status, message) {
  return Object.assign(new Error(message || code), { code, status });
}

function assertSafeSqlIdentifier(identifier) {
  if (typeof identifier !== 'string' || !IDENTIFIER_RE.test(identifier)) {
    throw rlsError('INVALID_SQL_IDENTIFIER', 400, `Invalid SQL identifier: ${String(identifier)}`);
  }
  return identifier;
}

function assertValidOrganizationId(organizationId) {
  if (typeof organizationId !== 'string' || !ORG_ID_RE.test(organizationId)) {
    throw rlsError('INVALID_RLS_ORGANIZATION', 400, 'Invalid RLS organization identifier.');
  }
  return organizationId;
}

function quoteIdentifier(identifier) {
  return `"${assertSafeSqlIdentifier(identifier)}"`;
}

function isPostgresSequelize(sequelize) {
  if (!sequelize) return false;
  if (typeof sequelize.getDialect === 'function') {
    return sequelize.getDialect() === 'postgres';
  }
  return true;
}

function getActiveRlsContext() {
  return rlsStore.getStore() || null;
}

function injectTransactionArg(args, index, transaction) {
  const existing = args[index];
  if (existing !== undefined && existing !== null) {
    if (typeof existing !== 'object' || Array.isArray(existing) || existing.transaction != null) {
      return args;
    }
    const next = args.slice();
    next[index] = { ...existing, transaction };
    return next;
  }
  const next = args.slice();
  while (next.length < index) next.push(undefined);
  next[index] = { transaction };
  return next;
}

function resolveRepositorySequelize(repoInstance, fallbackSequelize) {
  return repoInstance?.database?.sequelize || repoInstance?.db?.sequelize || fallbackSequelize || null;
}

function wrapRepositoryMethods(target, fallbackSequelize) {
  if (!target || Object.hasOwn(target, RLS_BRIDGE_MARKER)) return;
  try {
    Object.defineProperty(target, RLS_BRIDGE_MARKER, { value: true, configurable: true });
  } catch {
    return;
  }

  for (const method of REPO_SINGLE_ARG_METHODS) {
    const orig = target[method];
    if (typeof orig !== 'function' || orig[RLS_BRIDGE_MARKER]) continue;
    const wrapped = function rlsBridgedRepoMethod(...args) {
      const store = rlsStore.getStore();
      if (store?.transaction) {
        const repoSeq = resolveRepositorySequelize(this, fallbackSequelize);
        if (!repoSeq || store.sequelize === repoSeq) {
          return orig.apply(this, injectTransactionArg(args, 0, store.transaction));
        }
      }
      return orig.apply(this, args);
    };
    try {
      Object.defineProperty(wrapped, RLS_BRIDGE_MARKER, { value: true });
      target[method] = wrapped;
    } catch {
      // Ignore read-only method properties on frozen stubs
    }
  }

  const origQuery = target.query;
  if (typeof origQuery === 'function' && !origQuery[RLS_BRIDGE_MARKER]) {
    const wrappedQuery = function rlsBridgedRepoQuery(...args) {
      const store = rlsStore.getStore();
      if (store?.transaction) {
        const repoSeq = resolveRepositorySequelize(this, fallbackSequelize);
        if (!repoSeq || store.sequelize === repoSeq) {
          const optIndex = typeof args[0] === 'string' ? 1 : 0;
          return origQuery.apply(this, injectTransactionArg(args, optIndex, store.transaction));
        }
      }
      return origQuery.apply(this, args);
    };
    try {
      Object.defineProperty(wrappedQuery, RLS_BRIDGE_MARKER, { value: true });
      target.query = wrappedQuery;
    } catch {
      // Ignore read-only method properties on frozen stubs
    }
  }
}

function resolveDefaultRepositoryClass(db) {
  if (typeof db?.Repository === 'function') return db.Repository;
  try {
    const pkg = require('@nocobase/database');
    if (typeof pkg?.Repository === 'function') return pkg.Repository;
  } catch {
    // @nocobase/database is provided by the host runtime and may be absent in unit tests
  }
  return null;
}

function installRlsTransactionBridge(db, RepositoryClass) {
  if (!db) return false;
  const sequelize = db.sequelize || null;

  const targetRepoClass = RepositoryClass || resolveDefaultRepositoryClass(db);
  if (targetRepoClass?.prototype) {
    wrapRepositoryMethods(targetRepoClass.prototype, sequelize);
  }

  if (typeof sequelize?.query === 'function' && !sequelize.query[RLS_BRIDGE_MARKER]) {
    const origSeqQuery = sequelize.query;
    const wrappedSeqQuery = function rlsBridgedSequelizeQuery(...args) {
      const store = rlsStore.getStore();
      if (store?.transaction && store.sequelize === sequelize) {
        return origSeqQuery.apply(this, injectTransactionArg(args, 1, store.transaction));
      }
      return origSeqQuery.apply(this, args);
    };
    try {
      Object.defineProperty(wrappedSeqQuery, RLS_BRIDGE_MARKER, { value: true });
      sequelize.query = wrappedSeqQuery;
    } catch {
      // Ignore frozen sequelize objects
    }
  }

  if (typeof db.getRepository === 'function' && !db.getRepository[RLS_BRIDGE_MARKER]) {
    const origGetRepo = db.getRepository;
    const wrappedGetRepo = function rlsBridgedGetRepository(...args) {
      const repo = origGetRepo.apply(this, args);
      if (repo && (typeof repo === 'object' || typeof repo === 'function')) {
        const proto = Object.getPrototypeOf(repo);
        if (proto && proto !== Object.prototype) {
          wrapRepositoryMethods(proto, sequelize);
        } else {
          wrapRepositoryMethods(repo, sequelize);
        }
      }
      return repo;
    };
    try {
      Object.defineProperty(wrappedGetRepo, RLS_BRIDGE_MARKER, { value: true });
      db.getRepository = wrappedGetRepo;
    } catch {
      // Ignore frozen db mocks
    }
  }

  return true;
}

function buildRlsPolicySql(tableName, { schema = 'public', policyName = RLS_POLICY_NAME } = {}) {
  const safeSchema = assertSafeSqlIdentifier(schema);
  const safeTable = quoteIdentifier(tableName);
  const safePolicy = assertSafeSqlIdentifier(policyName);
  const qualifiedTable = `${safeSchema}.${safeTable}`;
  const predicate = [
    "current_setting('app.current_org', true) IS NULL",
    "current_setting('app.current_org', true) = ''",
    "current_setting('app.current_org', true) = '*'",
    '"organizationId" = current_setting(\'app.current_org\', true)',
  ].join(' OR ');

  return {
    enableSql: `ALTER TABLE ${qualifiedTable} ENABLE ROW LEVEL SECURITY;`,
    dropSql: `DROP POLICY IF EXISTS ${safePolicy} ON ${qualifiedTable};`,
    createSql: `CREATE POLICY ${safePolicy} ON ${qualifiedTable} AS PERMISSIVE FOR ALL TO PUBLIC USING (${predicate}) WITH CHECK (${predicate});`,
    disableSql: `ALTER TABLE IF EXISTS ${qualifiedTable} DISABLE ROW LEVEL SECURITY;`,
  };
}

async function attachRlsPolicyToTable(db, tableName, options = {}) {
  assertSafeSqlIdentifier(tableName);
  const safeOptions = options && typeof options === 'object' ? options : {};
  const sequelize = db?.sequelize;
  if (!sequelize || typeof sequelize.query !== 'function') {
    throw rlsError('RLS_QUERY_UNAVAILABLE', 500, 'sequelize.query is required to attach RLS policy.');
  }
  if (!isPostgresSequelize(sequelize)) {
    return { applied: false, skipped: true, tableName };
  }
  const { enableSql, dropSql, createSql } = buildRlsPolicySql(tableName, safeOptions);
  const queryOpts = safeOptions.transaction ? { transaction: safeOptions.transaction } : undefined;
  await sequelize.query(enableSql, queryOpts);
  await sequelize.query(dropSql, queryOpts);
  await sequelize.query(createSql, queryOpts);
  return { applied: true, tableName, policyName: safeOptions.policyName || RLS_POLICY_NAME };
}

async function detachRlsPolicyFromTable(db, tableName, options = {}) {
  assertSafeSqlIdentifier(tableName);
  const safeOptions = options && typeof options === 'object' ? options : {};
  const sequelize = db?.sequelize;
  if (!sequelize || typeof sequelize.query !== 'function') {
    throw rlsError('RLS_QUERY_UNAVAILABLE', 500, 'sequelize.query is required to detach RLS policy.');
  }
  if (!isPostgresSequelize(sequelize)) {
    return { removed: false, skipped: true, tableName };
  }
  const { dropSql, disableSql } = buildRlsPolicySql(tableName, safeOptions);
  const queryOpts = safeOptions.transaction ? { transaction: safeOptions.transaction } : undefined;
  await sequelize.query(dropSql, queryOpts);
  await sequelize.query(disableSql, queryOpts);
  return { removed: true, tableName, policyName: safeOptions.policyName || RLS_POLICY_NAME };
}

async function discoverTenantRlsTables(db, options = {}) {
  const sequelize = db?.sequelize;
  if (!sequelize || typeof sequelize.query !== 'function' || !isPostgresSequelize(sequelize)) {
    return [];
  }
  const sql = [
    'SELECT table_name',
    'FROM information_schema.columns',
    "WHERE table_schema = 'public'",
    "  AND column_name = 'organizationId'",
    "  AND table_name LIKE 'lattice%'",
    'ORDER BY table_name;',
  ].join('\n');
  const raw = await sequelize.query(sql, options.transaction ? { transaction: options.transaction } : undefined);
  const rows = Array.isArray(raw?.[0]) ? raw[0] : (Array.isArray(raw) ? raw : []);
  const discovered = [];
  const seen = new Set();
  for (const row of rows) {
    const name = row?.table_name ?? row?.TABLE_NAME;
    if (typeof name !== 'string' || seen.has(name)) continue;
    if (!TENANT_RLS_TABLE_SET.has(name) && !CUSTOM_RLS_TABLE_RE.test(name)) continue;
    assertSafeSqlIdentifier(name);
    seen.add(name);
    discovered.push(name);
  }
  return discovered;
}

async function setTransactionRlsOrg(db, organizationId, transaction) {
  assertValidOrganizationId(organizationId);
  if (!transaction) {
    throw rlsError('RLS_TRANSACTION_UNAVAILABLE', 500, 'Active transaction is required for PostgreSQL RLS context.');
  }
  const sequelize = db?.sequelize;
  if (!sequelize) {
    throw rlsError('RLS_DB_UNAVAILABLE', 500, 'Database sequelize instance is required for RLS context.');
  }
  if (!isPostgresSequelize(sequelize)) {
    return { applied: false, skipped: true };
  }
  if (typeof sequelize.query !== 'function') {
    throw rlsError('RLS_QUERY_UNAVAILABLE', 500, 'sequelize.query is required to apply PostgreSQL RLS context.');
  }
  await sequelize.query("SELECT set_config('app.current_org', :orgId, true)", {
    replacements: { orgId: organizationId },
    transaction,
  });
  return { applied: true, organizationId };
}

async function withTenantRlsContext(db, organizationId, fn) {
  if (typeof fn !== 'function') {
    throw new TypeError('withTenantRlsContext requires a callback function.');
  }
  assertValidOrganizationId(organizationId);
  const sequelize = db?.sequelize;
  if (!sequelize || typeof sequelize.transaction !== 'function') {
    throw rlsError('RLS_TRANSACTION_UNAVAILABLE', 500, 'sequelize.transaction is required for transaction-local RLS context.');
  }
  return sequelize.transaction(async (transaction) => {
    await setTransactionRlsOrg(db, organizationId, transaction);
    return rlsStore.run({ sequelize, transaction, organizationId }, () => fn(transaction));
  });
}

module.exports = {
  IDENTIFIER_RE,
  ORG_ID_RE,
  RLS_POLICY_NAME,
  RLS_BRIDGE_MARKER,
  TENANT_RLS_TABLES,
  assertSafeSqlIdentifier,
  assertValidOrganizationId,
  quoteIdentifier,
  getActiveRlsContext,
  installRlsTransactionBridge,
  buildRlsPolicySql,
  attachRlsPolicyToTable,
  detachRlsPolicyFromTable,
  discoverTenantRlsTables,
  setTransactionRlsOrg,
  withTenantRlsContext,
};
