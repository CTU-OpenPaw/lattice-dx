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
const PROTO_POLLUTION_KEYS = Object.freeze(new Set(['__proto__', 'constructor', 'prototype']));
const SNAKE_CASE_ORG_TABLES = Object.freeze(new Set([
  'lattice_native_request_attachments',
  'lattice_native_request_uploads',
]));
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
let savepointSeq = 0;

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
  'latticeApiKeys',
  'latticePkiKeys',
  'latticeCryptoLedger',
  'latticeFrozenSnapshots',
  'latticeDataLineage',
  'latticeDataQuarantine',
  'latticeOrderLines',
  'latticeStockLots',
  'latticeEpodRecords',
  'latticeDecisionTables',
  'latticeDelegations',
  'latticeTwinShadows',
  'latticeConnectors',
  'latticeEventBus',
  'latticeWebhookSubscriptions',
  'latticeWebhookDeliveries',
  'latticeIotDevices',
  'latticeBrokerSubscriptions',
  'latticeAutomationRules',
  'latticeAutomationRuns',
  'latticeBuiltApps',
  'latticeAiMemory',
  'latticeAiTraces',
  'latticeAutomationRuleVersions',
  'latticeA2aTasks',
  'latticeNotificationDeliveries',
  'latticeApprovalPolicies',
  'latticeApprovalRequests',
  'latticePublicForms',
  'latticePublicFormSubmissions',
  'lattice_native_request_attachments',
  'lattice_native_request_uploads',
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

function isValidOrganizationId(raw) {
  if (typeof raw !== 'string') return false;
  const clean = raw.trim();
  if (!clean) return false;
  const lower = clean.toLowerCase();
  if (lower === 'all' || PROTO_POLLUTION_KEYS.has(lower)) return false;
  return ORG_ID_RE.test(clean);
}

function assertValidOrganizationId(organizationId) {
  if (typeof organizationId !== 'string' || organizationId.trim() !== organizationId || !isValidOrganizationId(organizationId)) {
    throw rlsError('INVALID_RLS_ORGANIZATION', 400, 'Invalid RLS organization identifier.');
  }
  return organizationId;
}

function resolveTenantOrgColumn(tableName, explicitCol) {
  return assertSafeSqlIdentifier(
    explicitCol || (SNAKE_CASE_ORG_TABLES.has(tableName) ? 'organization_id' : 'organizationId'),
  );
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

function buildRlsPolicySql(tableName, { schema = 'public', policyName = RLS_POLICY_NAME, orgColumn } = {}) {
  const safeSchema = assertSafeSqlIdentifier(schema);
  const safeTable = quoteIdentifier(tableName);
  const safePolicy = assertSafeSqlIdentifier(policyName);
  const safeOrgCol = quoteIdentifier(resolveTenantOrgColumn(tableName, orgColumn));
  const qualifiedTable = `${safeSchema}.${safeTable}`;
  const predicate = [
    "current_setting('app.rls_bypass', true) = 'on'",
    "current_setting('app.current_org', true) = '*'",
    `${safeOrgCol} = nullif(current_setting('app.current_org', true), '')`,
  ].join(' OR ');

  return {
    enableSql: `ALTER TABLE ${qualifiedTable} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${qualifiedTable} FORCE ROW LEVEL SECURITY;`,
    dropSql: `DROP POLICY IF EXISTS ${safePolicy} ON ${qualifiedTable};`,
    createSql: `CREATE POLICY ${safePolicy} ON ${qualifiedTable} AS PERMISSIVE FOR ALL TO PUBLIC USING (${predicate}) WITH CHECK (${predicate});`,
    disableSql: `ALTER TABLE IF EXISTS ${qualifiedTable} NO FORCE ROW LEVEL SECURITY; ALTER TABLE IF EXISTS ${qualifiedTable} DISABLE ROW LEVEL SECURITY;`,
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
    "  AND column_name IN ('organizationId', 'organization_id')",
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

function canUsePgRlsSession(db, { requireEnabledFlag = true } = {}) {
  if (requireEnabledFlag && process.env.DX_PG_RLS_SESSION !== 'true') {
    return false;
  }
  const sequelize = db?.sequelize;
  return Boolean(
    sequelize
    && isPostgresSequelize(sequelize)
    && typeof sequelize.transaction === 'function'
    && typeof sequelize.query === 'function',
  );
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

async function setTransactionRlsBypass(db, transaction) {
  if (!transaction) {
    throw rlsError('RLS_TRANSACTION_UNAVAILABLE', 500, 'Active transaction is required for PostgreSQL RLS bypass.');
  }
  const sequelize = db?.sequelize;
  if (!sequelize) {
    throw rlsError('RLS_DB_UNAVAILABLE', 500, 'Database sequelize instance is required for RLS bypass.');
  }
  if (!isPostgresSequelize(sequelize)) {
    return { applied: false, skipped: true };
  }
  if (typeof sequelize.query !== 'function') {
    throw rlsError('RLS_QUERY_UNAVAILABLE', 500, 'sequelize.query is required to apply PostgreSQL RLS bypass.');
  }
  await sequelize.query("SELECT set_config('app.rls_bypass', 'on', true)", {
    transaction,
  });
  return { applied: true, systemRlsBypass: true };
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

async function withSystemRlsBypass(db, fn) {
  if (typeof fn !== 'function') {
    throw new TypeError('withSystemRlsBypass requires a callback function.');
  }
  const sequelize = db?.sequelize;
  if (!sequelize || typeof sequelize.transaction !== 'function') {
    throw rlsError('RLS_TRANSACTION_UNAVAILABLE', 500, 'sequelize.transaction is required for system RLS bypass.');
  }
  const existing = rlsStore.getStore();
  if (existing?.systemRlsBypass === true && existing.transaction && existing.sequelize === sequelize) {
    return fn(existing.transaction);
  }
  return sequelize.transaction(async (transaction) => {
    await setTransactionRlsBypass(db, transaction);
    return rlsStore.run({ sequelize, transaction, systemRlsBypass: true }, () => fn(transaction));
  });
}

async function runInRlsSavepoint(db, fn) {
  if (typeof fn !== 'function') {
    throw new TypeError('runInRlsSavepoint requires a callback function.');
  }
  const store = rlsStore.getStore();
  const sequelize = store?.sequelize || db?.sequelize;
  if (!store?.transaction || !sequelize || !isPostgresSequelize(sequelize) || typeof sequelize.query !== 'function') {
    return fn(store?.transaction || null);
  }
  const spName = `ldx_sp_${++savepointSeq}`;
  await sequelize.query(`SAVEPOINT "${spName}"`, { transaction: store.transaction });
  try {
    const result = await fn(store.transaction);
    await sequelize.query(`RELEASE SAVEPOINT "${spName}"`, { transaction: store.transaction });
    return result;
  } catch (err) {
    await sequelize.query(`ROLLBACK TO SAVEPOINT "${spName}"`, { transaction: store.transaction }).catch(() => {});
    await sequelize.query(`RELEASE SAVEPOINT "${spName}"`, { transaction: store.transaction }).catch(() => {});
    throw err;
  }
}

// Non-enumerable so NocoBase 2.2.50 createContextVariablesScope (JSON.stringify(ctx.state)) skips the Sequelize Transaction graph.
function setContextRlsTransaction(ctx, transaction) {
  if (!ctx || !transaction) return;
  ctx.state = ctx.state || {};
  Object.defineProperty(ctx.state, 'latticeRlsTransaction', {
    value: transaction,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

module.exports = {
  IDENTIFIER_RE,
  ORG_ID_RE,
  PROTO_POLLUTION_KEYS,
  SNAKE_CASE_ORG_TABLES,
  RLS_POLICY_NAME,
  RLS_BRIDGE_MARKER,
  TENANT_RLS_TABLES,
  assertSafeSqlIdentifier,
  isValidOrganizationId,
  assertValidOrganizationId,
  resolveTenantOrgColumn,
  quoteIdentifier,
  canUsePgRlsSession,
  getActiveRlsContext,
  installRlsTransactionBridge,
  buildRlsPolicySql,
  attachRlsPolicyToTable,
  detachRlsPolicyFromTable,
  discoverTenantRlsTables,
  setContextRlsTransaction,
  setTransactionRlsOrg,
  setTransactionRlsBypass,
  withTenantRlsContext,
  withSystemRlsBypass,
  runInRlsSavepoint,
};
